use super::*;
use cap_project::{InstantRecordingMeta, RecordingMetaInner};
use cap_recording::upload_resume::{UploadLock, UploadLockError, collect_segment_events};
use cap_recording::upload_verification::{UploadVerification, VerifiedUploadReceipt};
use futures_util::FutureExt as _;
use std::io::Write;

static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

const STATE_FILE: &str = "instant-upload.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;
const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(45);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(30);
const MAX_AUTOMATIC_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum UploadKind {
    Segments,
    Mp4,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum UploadPhase {
    Recording,
    Pending,
    Uploading,
    Processing,
    Retrying,
    NeedsAuthentication,
    Failed,
    Cancelled,
    Verified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct UploadState {
    version: u32,
    video_id: String,
    server_url: String,
    owner_id: Option<String>,
    kind: UploadKind,
    requested_audio: Option<bool>,
    preserve_local: bool,
    pub phase: UploadPhase,
    attempt_count: u32,
    pub last_error: Option<String>,
    next_retry_at: Option<i64>,
    verification: Option<UploadVerification>,
    receipt: Option<VerifiedUploadReceipt>,
}

impl UploadState {
    pub(super) fn request_context(&self) -> Result<auth::UploadRequestContext, String> {
        auth::UploadRequestContext::for_upload(&self.server_url, self.owner_id.as_deref())
            .map_err(|error| error.to_string())
    }

    fn pending(&self, now: i64, auth_changed: bool) -> bool {
        match self.phase {
            UploadPhase::Recording | UploadPhase::Pending | UploadPhase::Uploading => true,
            UploadPhase::Processing => self.next_retry_at.is_none_or(|at| at <= now),
            UploadPhase::Verified => self.receipt.is_some(),
            UploadPhase::Retrying => self.next_retry_at.is_some_and(|at| at <= now),
            UploadPhase::NeedsAuthentication => auth_changed,
            UploadPhase::Failed | UploadPhase::Cancelled => false,
        }
    }

    pub fn label(&self) -> &'static str {
        match self.phase {
            UploadPhase::Recording => "Upload prepared",
            UploadPhase::Pending | UploadPhase::Uploading => "Uploading",
            UploadPhase::Processing => "Processing upload",
            UploadPhase::Retrying => "Upload will retry",
            UploadPhase::NeedsAuthentication => "Sign in to retry upload",
            UploadPhase::Failed => "Upload needs attention",
            UploadPhase::Cancelled => "Upload paused",
            UploadPhase::Verified => "Uploaded",
        }
    }

    pub(crate) fn can_retry(&self) -> bool {
        self.requested_audio.is_some()
            && matches!(
                self.phase,
                UploadPhase::Retrying
                    | UploadPhase::NeedsAuthentication
                    | UploadPhase::Failed
                    | UploadPhase::Cancelled
            )
    }

    pub fn is_pending(&self) -> bool {
        !matches!(
            self.phase,
            UploadPhase::Failed
                | UploadPhase::Cancelled
                | UploadPhase::Verified
                | UploadPhase::NeedsAuthentication
        )
    }

    fn fail(&mut self, error: String, now: i64) {
        self.attempt_count = self.attempt_count.saturating_add(1);
        let auth = error.to_ascii_lowercase();
        self.phase = if auth.contains("authenticat")
            || auth.contains("sign in")
            || auth.contains("session has expired")
        {
            UploadPhase::NeedsAuthentication
        } else if self.attempt_count < MAX_AUTOMATIC_ATTEMPTS {
            UploadPhase::Retrying
        } else {
            UploadPhase::Failed
        };
        self.next_retry_at = (self.phase == UploadPhase::Retrying)
            .then(|| now.saturating_add(30_i64.saturating_mul(1_i64 << self.attempt_count.min(5))));
        self.last_error = Some(error);
    }
}

fn owner_id() -> Option<String> {
    crate::store::store_section("auth")
        .get("user_id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn regular_file(path: &Path) -> Result<std::fs::Metadata, String> {
    let metadata = path.symlink_metadata().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Upload state cannot use a reparse point".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Upload state must be a regular file".into());
    }
    Ok(metadata)
}

fn local_output(project: &Path) -> Result<PathBuf, String> {
    let content = project.join("content");
    let metadata = content
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Recording content cannot use a reparse point".into());
        }
    }
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Recording content must be a local directory".into());
    }
    let output = content.join("output.mp4");
    if regular_file(&output)?.len() == 0 {
        return Err("The saved recording is empty".into());
    }
    Ok(output)
}

pub(crate) fn read_state(project: &Path) -> Result<Option<UploadState>, String> {
    let path = project.join(STATE_FILE);
    match path.symlink_metadata() {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    if regular_file(&path)?.len() > MAX_STATE_BYTES {
        return Err("Upload state is too large".into());
    }
    let state: UploadState =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Upload state could not be read: {error}"))?;
    if state.version != 1 || state.video_id.is_empty() || state.server_url.is_empty() {
        return Err("Upload state has an unsupported identity or version".into());
    }
    Ok(Some(state))
}

fn write_state(project: &Path, state: &UploadState) -> Result<(), String> {
    let destination = project.join(STATE_FILE);
    match destination.symlink_metadata() {
        Ok(_) => {
            regular_file(&destination)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_STATE_BYTES {
        return Err("Upload state is too large".into());
    }
    let temporary = project.join(format!(
        ".instant-upload-{}.tmp",
        crate::store::new_uuid_v4()
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, &destination)?;
        #[cfg(unix)]
        std::fs::File::open(project)?.sync_all()?;
        Ok::<_, std::io::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Could not save upload state: {error}"))?;
    EPOCH.fetch_add(1, Ordering::AcqRel);
    Ok(())
}

pub(crate) fn record_capture(
    project: &Path,
    video: &VideoUploadInfo,
    segmented: bool,
    requested_audio: bool,
) -> Result<(), String> {
    write_state(
        project,
        &UploadState {
            version: 1,
            video_id: video.id.clone(),
            server_url: auth::server_url(),
            owner_id: owner_id(),
            kind: if segmented {
                UploadKind::Segments
            } else {
                UploadKind::Mp4
            },
            requested_audio: Some(requested_audio),
            preserve_local: false,
            phase: UploadPhase::Recording,
            attempt_count: 0,
            last_error: None,
            next_retry_at: None,
            verification: None,
            receipt: None,
        },
    )
}

pub(super) fn record_cancelled(project: &Path) -> Result<(), String> {
    if let Some(mut state) = read_state(project)? {
        state.phase = UploadPhase::Cancelled;
        state.next_retry_at = None;
        write_state(project, &state)?;
    }
    Ok(())
}

pub(crate) fn record_failure(project: &Path, error: &str) -> Result<(), String> {
    if let Some(mut state) = read_state(project)? {
        state.fail(error.to_string(), now());
        write_state(project, &state)?;
    }
    Ok(())
}

fn pending_video(meta: &RecordingMeta) -> Option<VideoUploadInfo> {
    match &meta.upload {
        Some(UploadMeta::SegmentUpload {
            video_id,
            pre_created_video,
            ..
        })
        | Some(UploadMeta::MultipartUpload {
            video_id,
            pre_created_video,
            ..
        }) if video_id == &pre_created_video.id && video_id == &pre_created_video.config.id => {
            Some(pre_created_video.clone())
        }
        Some(UploadMeta::SinglePartUpload { video_id, .. }) => Some(VideoUploadInfo {
            id: video_id.clone(),
            link: meta
                .sharing
                .as_ref()
                .filter(|share| share.id == *video_id)
                .map(|share| share.link.clone())
                .unwrap_or_else(|| format!("{}/s/{video_id}", auth::server_url())),
            config: S3UploadMeta {
                id: video_id.clone(),
            },
        }),
        Some(UploadMeta::Failed { .. }) => meta.sharing.as_ref().map(|share| VideoUploadInfo {
            id: share.id.clone(),
            link: share.link.clone(),
            config: S3UploadMeta {
                id: share.id.clone(),
            },
        }),
        _ => None,
    }
}

fn validate_local(project: &Path, state: &UploadState) -> Result<VideoUploadInfo, String> {
    let meta = RecordingMeta::load_for_project(project).map_err(|error| error.to_string())?;
    if !matches!(
        meta.inner,
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. })
    ) {
        return Err("Recording must be saved locally before its upload can resume".into());
    }
    let video = pending_video(&meta).ok_or("The pending upload identity is missing")?;
    if video.id != state.video_id {
        return Err("The recording upload identity changed".into());
    }
    if state.requested_audio.is_none() {
        return Err(
            "This older recording has no saved audio intent; review it before retrying".into(),
        );
    }
    local_output(project)?;
    Ok(video)
}
enum Confirmation {
    Pending,
    Verified(VerifiedUploadReceipt),
    ReuploadRequired,
}

trait UploadBackend: Send + Sync + 'static {
    fn check_account(&self, state: &UploadState) -> Result<(), String>;
    fn transfer(
        &self,
        project: &Path,
        upload: &mut InstantUpload,
        state: &UploadState,
    ) -> impl Future<Output = Result<UploadVerification, String>> + Send;
    fn confirm(
        &self,
        video_id: &str,
        verification: &UploadVerification,
    ) -> impl Future<Output = Result<Confirmation, String>> + Send;
    fn verify_local(
        &self,
        project: &Path,
        state: &UploadState,
        verification: &UploadVerification,
    ) -> Result<(), String>;
    fn delete_after_upload(&self) -> bool;
}

struct LiveBackend;

impl UploadBackend for LiveBackend {
    fn check_account(&self, state: &UploadState) -> Result<(), String> {
        if state.server_url != auth::server_url()
            || state.owner_id != owner_id()
            || store_auth_missing()
        {
            return Err("Sign in to the original recording account and server to retry".into());
        }
        Ok(())
    }

    async fn transfer(
        &self,
        project: &Path,
        upload: &mut InstantUpload,
        state: &UploadState,
    ) -> Result<UploadVerification, String> {
        let required_audio = state
            .requested_audio
            .ok_or("The recording has no saved audio intent")?;
        match state.kind {
            UploadKind::Segments => {
                let events = collect_segment_events(project, required_audio)?;
                let mut manifest = SegmentUploadManifest::default();
                for event in &events {
                    manifest.record(event);
                }
                manifest.is_complete = true;
                let verification = UploadVerification::segments(
                    &serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
                    required_audio,
                );
                upload.finish_screenshot(project).await?;
                upload.authorize_manifest(manifest)?;
                upload.finish_segments().await?;
                Ok(verification)
            }
            UploadKind::Mp4 => {
                let output = local_output(project)?;
                let file_size = regular_file(&output)?.len();
                let metadata = build_video_meta(&output)?;
                let (result, object_identity) = upload_exported_video_inner(
                    project.to_path_buf(),
                    None,
                    |_| {},
                    upload.cancel.clone(),
                    true,
                )
                .await?;
                match result {
                    UploadResult::Success(_) => {}
                    UploadResult::NotAuthenticated => {
                        return Err("Sign in again to upload this recording".into());
                    }
                    UploadResult::UpgradeRequired => {
                        return Err("Instant recording requires an upgraded plan".into());
                    }
                }
                if regular_file(&output)?.len() != file_size {
                    return Err("The local recording changed during upload".into());
                }
                UploadVerification::mp4(file_size, metadata.duration_in_secs, required_audio, object_identity.ok_or("Server did not return the uploaded object identity; local recording retained for retry")?)
            }
        }
    }

    async fn confirm(
        &self,
        video_id: &str,
        verification: &UploadVerification,
    ) -> Result<Confirmation, String> {
        let response = auth::authed_request(
            reqwest::Method::POST,
            "/api/upload/recording-complete",
            Some(json!({"videoId": video_id, "verification": verification})),
        )
        .await
        .map_err(|error| error.to_string())?;
        let status = response.status();
        let response: Value = response.json().await.map_err(|error| error.to_string())?;
        if status == StatusCode::CONFLICT
            && response.get("status").and_then(Value::as_str) == Some("reupload-required")
        {
            return Ok(Confirmation::ReuploadRequired);
        }
        if !status.is_success() {
            return Err(format!("Recording verification failed: {status}"));
        }
        Ok(match verification.verified_receipt(video_id, &response)? {
            Some(receipt) => Confirmation::Verified(receipt),
            None => Confirmation::Pending,
        })
    }

    fn verify_local(
        &self,
        project: &Path,
        state: &UploadState,
        verification: &UploadVerification,
    ) -> Result<(), String> {
        let required_audio = state
            .requested_audio
            .ok_or("The recording has no saved audio intent")?;
        let current = match state.kind {
            UploadKind::Segments => {
                let events = collect_segment_events(project, required_audio)?;
                let mut manifest = SegmentUploadManifest::default();
                for event in &events {
                    manifest.record(event);
                }
                manifest.is_complete = true;
                UploadVerification::segments(
                    &serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
                    required_audio,
                )
            }
            UploadKind::Mp4 => {
                let output = local_output(project)?;
                UploadVerification::mp4(
                    regular_file(&output)?.len(),
                    build_video_meta(&output)?.duration_in_secs,
                    required_audio,
                    match &verification.artifact {
                        cap_recording::upload_verification::UploadArtifact::Mp4 {
                            object_identity,
                            ..
                        } => object_identity.clone(),
                        _ => return Err("Upload artifact type changed".into()),
                    },
                )?
            }
        };
        if &current != verification {
            return Err("The local recording changed after upload; it has been preserved".into());
        }
        Ok(())
    }

    fn delete_after_upload(&self) -> bool {
        crate::store::GeneralSettings::load().delete_instant_recordings_after_upload
    }
}

struct Job {
    video_id: String,
    cancel: tokio::sync::watch::Sender<bool>,
    cancel_upload: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

struct Manager<B> {
    backend: B,
    jobs: tokio::sync::Mutex<HashMap<PathBuf, Job>>,
    stopping: AtomicBool,
    wake: tokio::sync::Notify,
    confirmation_timeout: Duration,
}

impl<B: UploadBackend> Manager<B> {
    fn new(backend: B, confirmation_timeout: Duration) -> Self {
        Self {
            backend,
            jobs: tokio::sync::Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            confirmation_timeout,
        }
    }

    async fn admit(
        self: &Arc<Self>,
        project: PathBuf,
        mut upload: InstantUpload,
        preserve_local: bool,
    ) -> Result<(), String> {
        let result = self
            .admit_inner(project.clone(), &mut upload, preserve_local)
            .await;
        if let Err(error) = &result
            && upload.ownership.is_some()
            && let Err(save_error) = record_failure(&project, error)
        {
            tracing::warn!(%save_error, "Could not preserve upload handoff failure");
        }
        if result.is_err() || upload.ownership.is_some() {
            upload.abort_segments().await;
        }
        result
    }

    async fn admit_inner(
        self: &Arc<Self>,
        project: PathBuf,
        upload: &mut InstantUpload,
        preserve_local: bool,
    ) -> Result<(), String> {
        let ownership = upload
            .ownership
            .as_ref()
            .ok_or("Upload ownership is missing")?;
        let canonical = project.canonicalize().map_err(|error| error.to_string())?;
        if ownership.project_path() != canonical {
            return Err("The recording path changed before upload handoff".into());
        }
        let mut state =
            read_state(&canonical)?.ok_or("The recording has no saved upload intent")?;
        validate_local(&canonical, &state)?;
        if state.video_id != upload.video.id || state.phase == UploadPhase::Cancelled {
            return Err("The upload identity changed or was cancelled".into());
        }
        let mut jobs = self.jobs.lock().await;
        if jobs.values().any(|job| job.video_id == state.video_id) || jobs.contains_key(&canonical)
        {
            return Err("This recording is already queued for upload".into());
        }
        state.preserve_local |= preserve_local;
        if !matches!(state.phase, UploadPhase::Processing | UploadPhase::Verified) {
            state.phase = UploadPhase::Pending;
        }
        state.next_retry_at = None;
        write_state(&canonical, &state)?;
        if self.stopping.load(Ordering::Acquire) || jobs.len() >= 2 {
            self.wake.notify_one();
            return Ok(());
        }
        let (cancel, cancelled) = tokio::sync::watch::channel(false);
        let owned = InstantUpload {
            video: upload.video.clone(),
            segment_upload: upload.segment_upload.take(),
            cancel: upload.cancel.clone(),
            metadata_lock: upload.metadata_lock.clone(),
            completion_permit: upload.completion_permit.take(),
            completion_control: upload.completion_control.take(),
            bridge: upload.bridge.take(),
            ownership: upload.ownership.take(),
            request_context: upload.request_context.clone(),
            reads: upload.reads.clone(),
        };
        let manager = self.clone();
        let path = canonical.clone();
        let task = tokio::spawn(async move {
            manager.run_job(path, owned, state, cancelled).await;
        });
        jobs.insert(
            canonical,
            Job {
                video_id: upload.video.id.clone(),
                cancel,
                cancel_upload: upload.cancel.clone(),
                task,
            },
        );
        self.wake.notify_one();
        Ok(())
    }

    async fn run_job(
        self: Arc<Self>,
        project: PathBuf,
        mut upload: InstantUpload,
        mut state: UploadState,
        mut cancelled: tokio::sync::watch::Receiver<bool>,
    ) {
        let context = upload.request_context.clone();
        let reads = upload.reads.clone();
        let result = std::panic::AssertUnwindSafe(with_upload_context(context, reads, async {
            tokio::select! {
                result = self.attempt(&project, &mut upload, &mut state) => result,
                _ = cancellation(&mut cancelled) => Err("Upload paused; the local recording is preserved".to_string()),
            }
        })).catch_unwind().await.unwrap_or_else(|_| Err("The upload worker failed; the local recording is preserved".into()));
        upload.abort_segments().await;
        if let Err(error) = result {
            state.fail(error.clone(), now());
            if let Err(save_error) = write_state(&project, &state) {
                tracing::error!(%save_error, "Failed to persist upload retry state");
            }
            tracing::warn!(path = %project.display(), %error, "Instant upload remains local");
        }
        self.wake.notify_one();
    }

    async fn attempt(
        &self,
        project: &Path,
        upload: &mut InstantUpload,
        state: &mut UploadState,
    ) -> Result<(), String> {
        validate_local(project, state)?;
        self.backend.check_account(state)?;
        if state
            .verification
            .as_ref()
            .is_some_and(UploadVerification::requires_reupload)
        {
            state.verification = None;
        }
        state.receipt = None;
        if state.verification.is_none() {
            state.phase = UploadPhase::Uploading;
            write_state(project, state)?;
            state.verification = Some(self.backend.transfer(project, upload, state).await?);
        }
        state.phase = UploadPhase::Processing;
        state.last_error = None;
        write_state(project, state)?;
        let verification = state
            .verification
            .as_ref()
            .ok_or("Upload verification is missing")?;
        let confirmation = tokio::time::timeout(
            self.confirmation_timeout,
            self.backend.confirm(&state.video_id, verification),
        )
        .await
        .map_err(|_| {
            "Cloud verification timed out; the local recording is preserved".to_string()
        })??;
        match confirmation {
            Confirmation::Pending => {
                state.attempt_count = 0;
                state.next_retry_at =
                    Some(now().saturating_add(RECONCILE_INTERVAL.as_secs() as i64));
                write_state(project, state)?;
                return Ok(());
            }
            Confirmation::ReuploadRequired => {
                state.verification = None;
                return Err(
                    "Cloud verification failed; the saved recording will upload again".into(),
                );
            }
            Confirmation::Verified(receipt) => state.receipt = Some(receipt),
        }
        let receipt = state.receipt.as_ref().ok_or("Upload receipt is missing")?;
        state
            .verification
            .as_ref()
            .ok_or("Upload verification is missing")?
            .verified_receipt(
                &state.video_id,
                &json!({"success":true,"status":"verified","verification":receipt}),
            )?
            .ok_or("Upload has not been verified")?;
        check_segment_cancelled(&upload.cancel)?;
        self.backend.check_account(state)?;
        self.backend.verify_local(
            project,
            state,
            state
                .verification
                .as_ref()
                .ok_or("Upload verification is missing")?,
        )?;
        validate_local(project, state)?;
        let current = read_state(project)?.ok_or("Upload state disappeared before verification")?;
        if current.video_id != state.video_id
            || current.owner_id != state.owner_id
            || current.server_url != state.server_url
            || current.kind != state.kind
            || current.requested_audio != state.requested_audio
            || current.phase == UploadPhase::Cancelled
        {
            return Err("Upload identity changed before verification".into());
        }
        state.phase = UploadPhase::Verified;
        state.attempt_count = 0;
        state.last_error = None;
        state.next_retry_at = None;
        write_state(project, state)?;
        crate::recording::persist_instant_upload_complete(
            project,
            upload.metadata_lock(),
            Some(&upload.cancel),
        )
        .map_err(|error| error.to_string())?;
        if !state.preserve_local && self.backend.delete_after_upload() {
            check_segment_cancelled(&upload.cancel)?;
            if let Err(error) = std::fs::remove_dir_all(project) {
                tracing::warn!(path = %project.display(), %error, "Verified upload kept locally because cleanup failed");
            }
        }
        Ok(())
    }

    async fn reap(&self) {
        let finished = {
            let mut jobs = self.jobs.lock().await;
            let paths: Vec<_> = jobs
                .iter()
                .filter(|(_, job)| job.task.is_finished())
                .map(|(path, _)| path.clone())
                .collect();
            paths
                .into_iter()
                .filter_map(|path| jobs.remove(&path))
                .collect::<Vec<_>>()
        };
        for job in finished {
            if let Err(error) = job.task.await {
                tracing::error!(%error, "Upload supervisor failed");
            }
        }
    }

    async fn cancel(&self, project: &Path) {
        let job = self.jobs.lock().await.remove(project);
        if let Some(job) = job {
            job.cancel_upload.store(true, Ordering::Release);
            job.cancel.send_replace(true);
            if let Err(error) = job.task.await {
                tracing::error!(%error, "Upload supervisor cleanup failed");
            }
        }
    }

    async fn shutdown(&self) {
        self.stopping.store(true, Ordering::Release);
        self.wake.notify_one();
        let jobs = std::mem::take(&mut *self.jobs.lock().await);
        for job in jobs.values() {
            job.cancel_upload.store(true, Ordering::Release);
            job.cancel.send_replace(true);
        }
        for (_, job) in jobs {
            if let Err(error) = job.task.await {
                tracing::error!(%error, "Upload shutdown failed");
            }
        }
    }
}

async fn cancellation(cancelled: &mut tokio::sync::watch::Receiver<bool>) {
    while !*cancelled.borrow_and_update() {
        if cancelled.changed().await.is_err() {
            break;
        }
    }
}

static MANAGER: OnceLock<Arc<Manager<LiveBackend>>> = OnceLock::new();

fn manager() -> &'static Arc<Manager<LiveBackend>> {
    MANAGER.get_or_init(|| Arc::new(Manager::new(LiveBackend, CONFIRMATION_TIMEOUT)))
}

pub(crate) async fn enqueue(
    project: PathBuf,
    upload: InstantUpload,
    preserve_local: bool,
) -> Result<(), String> {
    manager().admit(project, upload, preserve_local).await
}

fn legacy_state(meta: &RecordingMeta) -> Option<UploadState> {
    let video = pending_video(meta)?;
    Some(UploadState {
        version: 1, video_id: video.id, server_url: auth::server_url(), owner_id: None,
        kind: if matches!(meta.upload, Some(UploadMeta::SegmentUpload { .. })) { UploadKind::Segments } else { UploadKind::Mp4 },
        requested_audio: None, preserve_local: true, phase: UploadPhase::Failed, attempt_count: 0,
        last_error: Some("This older upload has no saved account and audio intent. Its local recording is preserved.".into()),
        next_retry_at: None, verification: None, receipt: None,
    })
}

impl Manager<LiveBackend> {
    async fn reconcile(self: &Arc<Self>, auth_changed: bool) {
        self.reap().await;
        for directory in crate::library::known_recordings_dirs() {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if self.stopping.load(Ordering::Acquire) || self.jobs.lock().await.len() >= 2 {
                    return;
                }
                let project = entry.path();
                let Ok(meta) = RecordingMeta::load_for_project(&project) else {
                    continue;
                };
                if !matches!(
                    meta.inner,
                    RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. })
                ) {
                    continue;
                }
                if matches!(meta.upload, None | Some(UploadMeta::Complete)) {
                    continue;
                }
                let ownership = match UploadLock::acquire(&project) {
                    Ok(ownership) => ownership,
                    Err(UploadLockError::Busy) => continue,
                    Err(error) => {
                        tracing::warn!(%error, "Upload ownership unavailable");
                        continue;
                    }
                };
                let project = ownership.project_path().to_path_buf();
                let state = match read_state(&project) {
                    Ok(Some(state)) => state,
                    Ok(None) => continue,
                    Err(error) => {
                        tracing::warn!(%error, "Upload state needs attention");
                        continue;
                    }
                };
                if !state.pending(now(), auth_changed) {
                    continue;
                }
                let result = self.resume(project.clone(), state.clone(), ownership).await;
                if let Err(error) = result {
                    tracing::warn!(%error, "Upload resume deferred");
                }
            }
        }
    }

    async fn resume(
        self: &Arc<Self>,
        project: PathBuf,
        state: UploadState,
        ownership: UploadLock,
    ) -> Result<(), String> {
        let prepared = (|| {
            let video = validate_local(&project, &state)?;
            self.backend.check_account(&state)?;
            let segment_rx = if state.kind == UploadKind::Segments && state.verification.is_none() {
                let events = collect_segment_events(
                    &project,
                    state
                        .requested_audio
                        .ok_or("The recording has no saved audio intent")?,
                )?;
                let (sender, receiver) = std::sync::mpsc::channel();
                for event in events {
                    sender.send(event).map_err(|error| error.to_string())?;
                }
                drop(sender);
                Some(receiver)
            } else {
                None
            };
            Ok::<_, String>((video, segment_rx))
        })();
        let (video, segment_rx) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                let mut state = state;
                state.fail(error.clone(), now());
                write_state(&project, &state)?;
                return Err(error);
            }
        };
        let request_context = state.request_context()?;
        let upload = start_instant_upload_with_ownership(
            video,
            project.clone(),
            segment_rx,
            Arc::new(Mutex::new(())),
            Some(CompletionAuthorization::new()),
            ownership,
            Some(request_context),
        )?;
        self.admit(project, upload, state.preserve_local).await
    }

    async fn run(self: Arc<Self>) {
        let mut previous_auth = None;
        while !self.stopping.load(Ordering::Acquire) {
            let current_auth = crate::store::auth_snapshot().token;
            let changed = current_auth.is_some() && current_auth != previous_auth;
            previous_auth = current_auth;
            self.reconcile(changed).await;
            tokio::select! { _ = tokio::time::sleep(RECONCILE_INTERVAL) => {}, _ = self.wake.notified() => {} }
        }
    }
}

struct QueueRuntime {
    worker: Option<gpui::Task<Result<(), tokio::task::JoinError>>>,
    _refresh: gpui::Task<()>,
}
impl gpui::Global for QueueRuntime {}

pub(crate) fn init(cx: &mut gpui::App) {
    let queue = manager().clone();
    let worker = gpui_tokio::Tokio::spawn(cx, queue.run());
    let refresh = cx.spawn(async move |cx| {
        let mut previous = EPOCH.load(Ordering::Acquire);
        loop {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let current = EPOCH.load(Ordering::Acquire);
            if current == previous {
                continue;
            }
            previous = current;
            cx.update(|cx| {
                let windows = cx.global::<crate::app_windows::AppWindows>();
                let main = windows.main;
                let settings = windows.settings;
                let _ = main.update(cx, |view, window, cx| view.refresh_open_library(window, cx));
                if let Some(settings) = settings {
                    let _ =
                        settings.update(cx, |view, window, cx| view.refresh_recordings(window, cx));
                }
            });
        }
    });
    cx.set_global(QueueRuntime {
        worker: Some(worker),
        _refresh: refresh,
    });
    cx.on_app_quit(|cx| {
        let shutdown = gpui_tokio::Tokio::spawn(cx, manager().shutdown());
        let worker = cx.global_mut::<QueueRuntime>().worker.take();
        async move {
            if let Err(error) = shutdown.await {
                tracing::error!(%error, "Upload shutdown failed");
            }
            if let Some(worker) = worker {
                let _ = worker.await;
            }
        }
    })
    .detach();
}

pub(crate) fn status(project: &Path, meta: &RecordingMeta) -> Option<UploadState> {
    if !matches!(meta.inner, RecordingMetaInner::Instant(_)) {
        return None;
    }
    match read_state(project) {
        Ok(Some(state)) => Some(state),
        Ok(None) => legacy_state(meta),
        Err(error) => {
            let mut state = legacy_state(meta)?;
            state.last_error = Some(error);
            Some(state)
        }
    }
}

pub(crate) async fn retry(project: PathBuf) -> Result<(), String> {
    let canonical = project.canonicalize().map_err(|error| error.to_string())?;
    manager().cancel(&canonical).await;
    let ownership = UploadLock::acquire(&canonical).map_err(|error| error.to_string())?;
    let mut state =
        read_state(&canonical)?.ok_or("This recording has no resumable upload state")?;
    if let Err(error) =
        validate_local(&canonical, &state).and_then(|_| manager().backend.check_account(&state))
    {
        state.fail(error.clone(), now());
        write_state(&canonical, &state)?;
        return Err(error);
    }
    state.phase = UploadPhase::Pending;
    state.attempt_count = 0;
    state.last_error = None;
    state.next_retry_at = None;
    write_state(&canonical, &state)?;
    manager().resume(canonical, state, ownership).await
}

pub(crate) async fn delete_recording(project: PathBuf) -> Result<(), String> {
    if !project.exists() {
        return Ok(());
    }
    let canonical = project.canonicalize().map_err(|error| error.to_string())?;
    manager().cancel(&canonical).await;
    let _ownership = UploadLock::acquire(&canonical).map_err(|error| error.to_string())?;
    if let Some(mut state) = read_state(&canonical)? {
        state.phase = UploadPhase::Cancelled;
        write_state(&canonical, &state)?;
    }
    crate::library::delete_recording_directory(&project)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("cap-upload-queue-{}", crate::store::new_uuid_v4()));
            let project = root.join("recording.cap");
            std::fs::create_dir_all(project.join("content")).unwrap();
            std::fs::write(project.join("content/output.mp4"), b"saved-output").unwrap();
            let video = VideoUploadInfo {
                id: "same-video".into(),
                link: "https://example.invalid/s/same-video".into(),
                config: S3UploadMeta {
                    id: "same-video".into(),
                },
            };
            RecordingMeta {
                platform: None,
                project_path: project.clone(),
                pretty_name: "Saved recording".into(),
                sharing: Some(SharingMeta {
                    id: video.id.clone(),
                    link: video.link.clone(),
                    content_hash: None,
                }),
                inner: RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
                    fps: 30,
                    sample_rate: None,
                }),
                upload: Some(UploadMeta::MultipartUpload {
                    video_id: video.id.clone(),
                    file_path: project.join("content/output.mp4"),
                    pre_created_video: video,
                    recording_dir: project.clone(),
                }),
            }
            .save_for_project()
            .unwrap();
            write_state(
                &project,
                &UploadState {
                    version: 1,
                    video_id: "same-video".into(),
                    server_url: "https://example.invalid".into(),
                    owner_id: Some("original-owner".into()),
                    kind: UploadKind::Mp4,
                    requested_audio: Some(true),
                    preserve_local: false,
                    phase: UploadPhase::Pending,
                    attempt_count: 0,
                    last_error: None,
                    next_retry_at: None,
                    verification: None,
                    receipt: None,
                },
            )
            .unwrap();
            Self(root)
        }

        fn project(&self) -> PathBuf {
            self.0.join("recording.cap")
        }

        fn upload(&self) -> InstantUpload {
            let project = self.project();
            let meta = RecordingMeta::load_for_project(&project).unwrap();
            start_instant_upload_with_ownership(
                pending_video(&meta).unwrap(),
                project.clone(),
                None,
                Arc::new(Mutex::new(())),
                Some(CompletionAuthorization::new()),
                UploadLock::acquire(&project).unwrap(),
                None,
            )
            .unwrap()
        }

        fn state(&self) -> UploadState {
            read_state(&self.project()).unwrap().unwrap()
        }

        fn cache_receipt(&self) {
            let mut state = self.state();
            let verification =
                UploadVerification::mp4(12, 2.0, true, "\"fake-object\"".into()).unwrap();
            state.receipt = Some(VerifiedUploadReceipt {
                version: 1,
                video_id: state.video_id.clone(),
                artifact: verification.artifact.clone(),
                file_size: 12,
                duration: 2.0,
                has_audio: true,
                full_decode: true,
                required_audio_verified: verification.required_audio,
            });
            state.verification = Some(verification);
            state.phase = UploadPhase::Verified;
            write_state(&self.project(), &state).unwrap();
        }

        fn assert_retained(&self) {
            assert_eq!(
                std::fs::read(self.project().join("content/output.mp4")).unwrap(),
                b"saved-output"
            );
            let meta = RecordingMeta::load_for_project(&self.project()).unwrap();
            assert!(matches!(
                meta.inner,
                RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. })
            ));
            assert_eq!(pending_video(&meta).unwrap().id, "same-video");
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
        gated: AtomicBool,
        unauthenticated: AtomicBool,
        panic: AtomicBool,
        verified: AtomicBool,
        fail_confirmation: AtomicBool,
        stall_confirmation: AtomicBool,
        reupload_required: AtomicBool,
        delete: AtomicBool,
        transfers: AtomicUsize,
        confirmations: AtomicUsize,
        transfer_steps: usize,
        transfer_step_delay: Duration,
        progress: AtomicUsize,
    }

    impl UploadBackend for FakeBackend {
        fn check_account(&self, _: &UploadState) -> Result<(), String> {
            if self.unauthenticated.load(Ordering::Acquire) {
                Err("Authentication expired".into())
            } else {
                Ok(())
            }
        }
        async fn transfer(
            &self,
            _: &Path,
            _: &mut InstantUpload,
            _: &UploadState,
        ) -> Result<UploadVerification, String> {
            self.transfers.fetch_add(1, Ordering::AcqRel);
            self.started.notify_one();
            if self.gated.load(Ordering::Acquire) {
                self.release.notified().await;
            }
            for _ in 0..self.transfer_steps {
                tokio::time::sleep(self.transfer_step_delay).await;
                self.progress.fetch_add(1, Ordering::AcqRel);
            }
            assert!(
                !self.panic.load(Ordering::Acquire),
                "injected upload worker failure"
            );
            UploadVerification::mp4(12, 2.0, true, "\"fake-object\"".into())
        }
        async fn confirm(
            &self,
            video_id: &str,
            verification: &UploadVerification,
        ) -> Result<Confirmation, String> {
            self.confirmations.fetch_add(1, Ordering::AcqRel);
            if self.stall_confirmation.load(Ordering::Acquire) {
                std::future::pending::<()>().await;
            }
            if self.fail_confirmation.load(Ordering::Acquire) {
                return Err("offline".into());
            }
            if self.reupload_required.swap(false, Ordering::AcqRel) {
                return Ok(Confirmation::ReuploadRequired);
            }
            if self.verified.load(Ordering::Acquire) {
                Ok(Confirmation::Verified(VerifiedUploadReceipt {
                    version: 1,
                    video_id: video_id.into(),
                    artifact: verification.artifact.clone(),
                    file_size: 12,
                    duration: 2.0,
                    has_audio: true,
                    full_decode: true,
                    required_audio_verified: verification.required_audio,
                }))
            } else {
                Ok(Confirmation::Pending)
            }
        }
        fn verify_local(
            &self,
            project: &Path,
            _: &UploadState,
            _: &UploadVerification,
        ) -> Result<(), String> {
            if std::fs::read(project.join("content/output.mp4"))
                .map_err(|error| error.to_string())?
                != b"saved-output"
            {
                return Err("The local recording changed after upload".into());
            }
            Ok(())
        }
        fn delete_after_upload(&self) -> bool {
            self.delete.load(Ordering::Acquire)
        }
    }

    async fn joined(manager: &Manager<FakeBackend>) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                manager.reap().await;
                if manager.jobs.lock().await.is_empty() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn local_save_returns_before_network_and_shutdown_joins_owned_work() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.gated.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(30)));
        let upload = fixture.upload();
        tokio::time::timeout(
            Duration::from_secs(1),
            manager.admit(fixture.project(), upload, false),
        )
        .await
        .unwrap()
        .unwrap();
        manager.backend.started.notified().await;
        fixture.assert_retained();
        assert!(matches!(
            UploadLock::acquire(&fixture.project()),
            Err(UploadLockError::Busy)
        ));
        manager.shutdown().await;
        fixture.assert_retained();
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 0);
        drop(UploadLock::acquire(&fixture.project()).unwrap());
    }

    #[tokio::test]
    async fn timeout_auth_and_worker_failure_keep_local_media_and_original_identity() {
        for failure in ["timeout", "authentication", "panic"] {
            let fixture = Fixture::new();
            let backend = FakeBackend::default();
            backend
                .stall_confirmation
                .store(failure == "timeout", Ordering::Release);
            backend
                .unauthenticated
                .store(failure == "authentication", Ordering::Release);
            backend.panic.store(failure == "panic", Ordering::Release);
            let manager = Arc::new(Manager::new(backend, Duration::from_millis(20)));
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            joined(&manager).await;
            fixture.assert_retained();
            assert_eq!(
                fixture.state().phase,
                if failure == "authentication" {
                    UploadPhase::NeedsAuthentication
                } else {
                    UploadPhase::Retrying
                }
            );
            assert_eq!(
                manager.backend.confirmations.load(Ordering::Acquire),
                usize::from(failure == "timeout")
            );
            if failure == "timeout" {
                let state = fixture.state();
                assert!(state.verification.is_some());
                assert!(state.receipt.is_none());
                assert!(
                    state
                        .last_error
                        .unwrap()
                        .contains("Cloud verification timed out")
                );
            }
            drop(UploadLock::acquire(&fixture.project()).unwrap());
        }
    }

    #[tokio::test]
    async fn progressing_transfer_is_not_cancelled_by_the_confirmation_deadline() {
        let fixture = Fixture::new();
        let backend = FakeBackend {
            transfer_steps: 4,
            transfer_step_delay: Duration::from_millis(25),
            ..Default::default()
        };
        backend.verified.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_millis(20)));
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.progress.load(Ordering::Acquire), 4);
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 1);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 1);
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
        assert_eq!(
            std::fs::read(fixture.project().join("content/output.mp4")).unwrap(),
            b"saved-output"
        );
        drop(UploadLock::acquire(&fixture.project()).unwrap());
    }

    #[tokio::test]
    async fn cached_receipt_is_rechecked_and_pending_cloud_state_keeps_local_media() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let backend = FakeBackend::default();
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 1);
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Processing);
        assert!(state.receipt.is_none());
        assert!(state.verification.is_some());
        assert!(state.next_retry_at.is_some());
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn rejected_cached_receipt_retransfers_the_same_recording_and_id() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let backend = FakeBackend::default();
        backend.reupload_required.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 1);
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert!(state.receipt.is_none());
        assert!(state.verification.is_none());
        fixture.assert_retained();

        manager.backend.verified.store(true, Ordering::Release);
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 1);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 2);
        let state = fixture.state();
        assert_eq!(state.video_id, "same-video");
        assert_eq!(state.phase, UploadPhase::Verified);
        assert_eq!(
            std::fs::read(fixture.project().join("content/output.mp4")).unwrap(),
            b"saved-output"
        );
    }

    #[tokio::test]
    async fn restart_polls_the_existing_artifact_without_reupload_or_new_identity() {
        let fixture = Fixture::new();
        let first = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        first
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&first).await;
        assert_eq!(fixture.state().phase, UploadPhase::Processing);
        fixture.assert_retained();
        first.shutdown().await;
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        let second = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        second
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&second).await;
        assert_eq!(second.backend.transfers.load(Ordering::Acquire), 0);
        assert_eq!(second.backend.confirmations.load(Ordering::Acquire), 1);
        assert_eq!(fixture.state().video_id, "same-video");
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
        assert!(matches!(
            RecordingMeta::load_for_project(&fixture.project())
                .unwrap()
                .upload,
            Some(UploadMeta::Complete)
        ));
        assert!(fixture.project().join("content/output.mp4").is_file());
    }

    #[tokio::test]
    async fn only_verified_receipt_allows_configured_deletion() {
        for verified in [false, true] {
            let fixture = Fixture::new();
            let backend = FakeBackend::default();
            backend.verified.store(verified, Ordering::Release);
            backend.delete.store(true, Ordering::Release);
            let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            joined(&manager).await;
            assert_eq!(fixture.project().exists(), !verified);
            if !verified {
                fixture.assert_retained();
            }
        }
    }

    #[tokio::test]
    async fn cancelled_worker_cannot_complete_even_after_network_gate_opens() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.gated.store(true, Ordering::Release);
        backend.verified.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(10)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        manager.backend.started.notified().await;
        manager
            .cancel(&fixture.project().canonicalize().unwrap())
            .await;
        manager.backend.release.notify_one();
        fixture.assert_retained();
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 0);
        assert!(manager.jobs.lock().await.is_empty());
    }

    #[tokio::test]
    async fn repeated_handoff_and_changed_identity_cannot_spawn_another_upload() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.gated.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(10)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        manager.backend.started.notified().await;
        assert!(matches!(
            UploadLock::acquire(&fixture.project()),
            Err(UploadLockError::Busy)
        ));
        assert_eq!(manager.jobs.lock().await.len(), 1);
        manager.shutdown().await;
        let mut state = fixture.state();
        state.video_id = "different-video".into();
        write_state(&fixture.project(), &state).unwrap();
        let next = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        assert!(
            next.admit(fixture.project(), fixture.upload(), false)
                .await
                .is_err()
        );
        assert_eq!(next.backend.transfers.load(Ordering::Acquire), 0);
        fixture.assert_retained();
    }

    #[test]
    fn legacy_unknown_audio_is_held_and_retry_budget_is_bounded() {
        let fixture = Fixture::new();
        let meta = RecordingMeta::load_for_project(&fixture.project()).unwrap();
        let state = legacy_state(&meta).unwrap();
        assert_eq!(state.requested_audio, None);
        assert!(!state.pending(now(), true));
        assert!(!state.can_retry());
        assert!(validate_local(&fixture.project(), &state).is_err());
        let mut state = fixture.state();
        state.attempt_count = MAX_AUTOMATIC_ATTEMPTS;
        state.fail("offline".into(), now());
        assert_eq!(state.phase, UploadPhase::Failed);
        assert!(!state.pending(i64::MAX, true));
        state.fail("Authentication expired".into(), now());
        assert!(!state.pending(i64::MAX, false));
        assert!(state.pending(i64::MAX, true));
    }

    #[cfg(unix)]
    #[test]
    fn linked_sidecar_is_rejected_without_replacing_the_target() {
        let fixture = Fixture::new();
        let state = fixture.state();
        let sidecar = fixture.project().join(STATE_FILE);
        std::fs::remove_file(&sidecar).unwrap();
        let missing = fixture.0.join("not-created");
        std::os::unix::fs::symlink(&missing, &sidecar).unwrap();
        assert!(read_state(&fixture.project()).is_err());
        assert!(write_state(&fixture.project(), &state).is_err());
        assert!(!missing.exists());
        assert!(sidecar.symlink_metadata().unwrap().file_type().is_symlink());
    }
    #[tokio::test]
    async fn healthy_processing_polls_do_not_consume_the_failure_budget() {
        let fixture = Fixture::new();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        for _ in 0..7 {
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            joined(&manager).await;
            assert_eq!(fixture.state().attempt_count, 0);
        }
        manager
            .backend
            .fail_confirmation
            .store(true, Ordering::Release);
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        assert_eq!(fixture.state().attempt_count, 1);
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 1);
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn verified_remote_receipt_cannot_delete_changed_local_media() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.gated.store(true, Ordering::Release);
        backend.verified.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(10)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        manager.backend.started.notified().await;
        std::fs::write(
            fixture.project().join("content/output.mp4"),
            b"changed-data",
        )
        .unwrap();
        manager.backend.release.notify_one();
        joined(&manager).await;
        assert_eq!(
            std::fs::read(fixture.project().join("content/output.mp4")).unwrap(),
            b"changed-data"
        );
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        assert_eq!(
            pending_video(&RecordingMeta::load_for_project(&fixture.project()).unwrap())
                .unwrap()
                .id,
            "same-video"
        );
    }
    #[tokio::test]
    async fn rejected_remote_artifact_reuploads_the_same_local_recording_and_id() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.reupload_required.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        assert!(fixture.state().verification.is_none());
        assert!(fixture.state().receipt.is_none());
        fixture.assert_retained();
        manager.backend.verified.store(true, Ordering::Release);
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 2);
        assert_eq!(fixture.state().video_id, "same-video");
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
    }
    #[tokio::test]
    async fn legacy_mp4_verification_without_generation_retransfers_the_same_recording() {
        let fixture = Fixture::new();
        let mut state = fixture.state();
        state.verification = Some(serde_json::from_value(json!({"version":1,"artifact":{"kind":"mp4","fileSize":12,"duration":2.0},"requiredAudio":true})).unwrap());
        state.phase = UploadPhase::Processing;
        write_state(&fixture.project(), &state).unwrap();
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 1);
        assert_eq!(fixture.state().video_id, "same-video");
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
        assert!(!fixture.state().verification.unwrap().requires_reupload());
        assert!(fixture.project().join("content/output.mp4").exists());
    }
}
