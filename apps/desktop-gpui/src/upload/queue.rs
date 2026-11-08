use super::*;
use crate::i18n::tr;
use cap_project::{InstantRecordingMeta, RecordingMetaInner};
use cap_recording::upload_resume::{UploadLock, UploadLockError, collect_segment_events};
use cap_recording::upload_verification::{UploadVerification, VerifiedUploadReceipt};
use futures_util::FutureExt as _;
use std::ffi::OsString;
use std::io::Write;
use std::time::SystemTime;

static STATE_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(super) const STATE_FILE: &str = "instant-upload.json";
const MAX_STATE_BYTES: u64 = 64 * 1024;
const CONFIRMATION_TIMEOUT: Duration = Duration::from_secs(45);
const RECONCILE_INTERVAL: Duration = Duration::from_secs(30);
const PENDING_RECHECK_INTERVAL: Duration = Duration::from_secs(5);
const FAST_PENDING_RECHECKS: u32 = 12;
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
    pub(crate) fn video_id(&self) -> &str {
        &self.video_id
    }

    pub(crate) fn server_url(&self) -> &str {
        &self.server_url
    }

    pub(crate) fn owner_id(&self) -> Option<&str> {
        self.owner_id.as_deref()
    }

    pub(super) fn request_context(&self) -> Result<auth::UploadRequestContext, String> {
        auth::UploadRequestContext::for_upload(&self.server_url, self.owner_id.as_deref())
            .map_err(|error| error.to_string())
    }

    pub(super) fn attempt_count(&self) -> u32 {
        self.attempt_count
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
            UploadPhase::Recording => tr::upload::status::prepared(),
            UploadPhase::Pending | UploadPhase::Uploading => tr::upload::status::uploading(),
            UploadPhase::Processing => tr::upload::status::processing(),
            UploadPhase::Retrying => tr::upload::status::retrying(),
            UploadPhase::NeedsAuthentication => tr::upload::status::sign_in(),
            UploadPhase::Failed => tr::upload::status::failed(),
            UploadPhase::Cancelled => tr::upload::status::paused(),
            UploadPhase::Verified => tr::upload::status::uploaded(),
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
    STATE_CHANGED.notify_one();
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

/// Keeps the local recording after its upload verifies, whatever the
/// delete-after-upload setting says.
pub(crate) fn record_preserve_local(project: &Path) -> Result<(), String> {
    if let Some(mut state) = read_state(project)? {
        state.preserve_local = true;
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

fn record_handoff_failure(project: &Path, error: &str, prior_attempts: u32) -> Result<(), String> {
    if let Some(mut state) = read_state(project)? {
        state.attempt_count = prior_attempts;
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
    fn forget_start_cleanup(&self, video_id: &str) -> bool;
    fn notify_failure(&self);
}

struct LiveBackend;

impl UploadBackend for LiveBackend {
    fn check_account(&self, state: &UploadState) -> Result<(), String> {
        if !auth::has_same_origin(&state.server_url, &auth::server_url())
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
                let recorded_length = recorded_length_json(&manifest).map(|bytes| {
                    publish_recorded_length(upload.video.id.clone(), bytes, upload.cancel.clone())
                });
                let finish = upload.finish_with_screenshot(project, manifest);
                match recorded_length {
                    Some(recorded_length) => alongside(finish, recorded_length).await?,
                    None => finish.await?,
                }
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

    fn forget_start_cleanup(&self, video_id: &str) -> bool {
        super::instant_cleanup::forget_verified(video_id)
    }

    fn notify_failure(&self) {
        crate::app_sounds::play_notification();
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
    pending_rechecks: Mutex<HashMap<String, u32>>,
    skipped_meta: Mutex<SkippedMeta>,
}

impl<B: UploadBackend> Manager<B> {
    fn new(backend: B, confirmation_timeout: Duration) -> Self {
        Self {
            backend,
            jobs: tokio::sync::Mutex::new(HashMap::new()),
            stopping: AtomicBool::new(false),
            wake: tokio::sync::Notify::new(),
            confirmation_timeout,
            pending_rechecks: Mutex::new(HashMap::new()),
            skipped_meta: Mutex::new(SkippedMeta::default()),
        }
    }

    fn pending_recheck_delay(&self, video_id: &str) -> Duration {
        let mut rechecks = self
            .pending_rechecks
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let count = rechecks.entry(video_id.to_string()).or_default();
        *count = count.saturating_add(1);
        if *count <= FAST_PENDING_RECHECKS {
            PENDING_RECHECK_INTERVAL
        } else {
            RECONCILE_INTERVAL
        }
    }

    fn skipped_meta(&self) -> std::sync::MutexGuard<'_, SkippedMeta> {
        self.skipped_meta
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn forget_pending_rechecks(&self, video_id: &str) {
        self.pending_rechecks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(video_id);
    }

    fn wake_after(self: &Arc<Self>, delay: Duration) {
        let manager = Arc::downgrade(self);
        tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            if let Some(manager) = manager.upgrade() {
                manager.wake.notify_one();
            }
        });
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
        if result.is_err() || upload.ownership.is_some() {
            upload.abort_segments().await;
        }
        if let Err(error) = &result
            && upload.ownership.is_some()
            && let Err(save_error) = record_handoff_failure(&project, error, upload.prior_attempts)
        {
            tracing::warn!(%save_error, "Could not preserve upload handoff failure");
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
        let deferred = self.stopping.load(Ordering::Acquire) || jobs.len() >= 2;
        if !deferred {
            state.attempt_count = upload.prior_attempts;
        }
        if !matches!(state.phase, UploadPhase::Processing | UploadPhase::Verified) {
            state.phase = UploadPhase::Pending;
        }
        state.next_retry_at = None;
        write_state(&canonical, &state)?;
        if deferred {
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
            prior_attempts: upload.prior_attempts,
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
        let paused = *cancelled.borrow() || upload.cancel.load(Ordering::Acquire);
        upload.abort_segments().await;
        match &result {
            Ok(Some(delay)) => self.wake_after(*delay),
            _ => self.forget_pending_rechecks(&state.video_id),
        }
        match result {
            Err(error) if paused => {
                tracing::info!(path = %project.display(), %error, "Instant upload paused");
            }
            Err(error) => {
                self.backend.notify_failure();
                state.fail(error.clone(), now());
                if let Err(save_error) = write_state(&project, &state) {
                    tracing::error!(%save_error, "Failed to persist upload retry state");
                }
                tracing::warn!(path = %project.display(), %error, "Instant upload remains local");
            }
            Ok(_) => {}
        }
        self.wake.notify_one();
    }

    async fn attempt(
        &self,
        project: &Path,
        upload: &mut InstantUpload,
        state: &mut UploadState,
    ) -> Result<Option<Duration>, String> {
        validate_local(project, state)?;
        self.backend.check_account(state)?;
        if state
            .verification
            .as_ref()
            .is_some_and(UploadVerification::requires_reupload)
        {
            state.verification = None;
        }
        if let Some(verification) = &state.verification
            && let Err(error) = self.backend.verify_local(project, state, verification)
        {
            state.verification = None;
            state.receipt = None;
            return Err(error);
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
                let delay = self.pending_recheck_delay(&state.video_id);
                state.attempt_count = 0;
                state.next_retry_at = Some(now().saturating_add(delay.as_secs() as i64));
                write_state(project, state)?;
                return Ok(Some(delay));
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
        let cleanup_cleared = self.backend.forget_start_cleanup(&state.video_id);
        if !state.preserve_local && self.backend.delete_after_upload() {
            check_segment_cancelled(&upload.cancel)?;
            if !cleanup_cleared {
                tracing::warn!(path = %project.display(), "Verified upload kept locally because its cleanup entry could not be cleared");
            } else if let Err(error) = std::fs::remove_dir_all(project) {
                tracing::warn!(path = %project.display(), %error, "Verified upload kept locally because cleanup failed");
            }
        }
        Ok(None)
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

fn upload_candidate(meta: &RecordingMeta) -> bool {
    matches!(
        meta.inner,
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. })
    ) && !matches!(meta.upload, None | Some(UploadMeta::Complete))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MetaStamp {
    modified: SystemTime,
    len: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed: (i64, i64),
}

impl MetaStamp {
    fn read(project: &Path) -> Option<Self> {
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(project.join("recording-meta.json")).ok()?;
        Some(Self {
            modified: metadata.modified().ok()?,
            len: metadata.len(),
            #[cfg(unix)]
            inode: metadata.ino(),
            #[cfg(unix)]
            changed: (metadata.ctime(), metadata.ctime_nsec()),
        })
    }
}

// Only "not a candidate" verdicts from a successfully loaded meta are cached:
// that verdict depends solely on recording-meta.json, while candidates still
// go through the upload lock and instant-upload.json (where auth changes
// apply) on every pass. A failed load may be transient (sharing violation,
// antivirus lock) and leaves the stamp unchanged, so it is retried every pass.
// Every writer replaces the file by rename, so a save also changes the inode
// on unix.
#[derive(Default)]
struct SkippedMeta {
    stamps: HashMap<OsString, (MetaStamp, u64)>,
    pass: u64,
}

impl SkippedMeta {
    fn begin_pass(&mut self) {
        self.pass = self.pass.wrapping_add(1);
    }

    fn is_candidate(
        &mut self,
        project: &Path,
        load: impl FnOnce(&Path) -> Option<RecordingMeta>,
    ) -> bool {
        let stamp = MetaStamp::read(project);
        if let Some(stamp) = stamp
            && let Some((cached, seen)) = self.stamps.get_mut(project.as_os_str())
            && *cached == stamp
        {
            *seen = self.pass;
            return false;
        }
        let candidate = load(project).map(|meta| upload_candidate(&meta));
        match (stamp, candidate) {
            (Some(stamp), Some(false)) => {
                self.stamps
                    .insert(project.as_os_str().to_os_string(), (stamp, self.pass));
            }
            _ => {
                self.stamps.remove(project.as_os_str());
            }
        }
        candidate.unwrap_or(false)
    }

    fn finish_pass(&mut self) {
        let pass = self.pass;
        self.stamps.retain(|_, (_, seen)| *seen == pass);
    }
}

impl Manager<LiveBackend> {
    async fn reconcile(self: &Arc<Self>, auth_changed: bool) {
        self.reap().await;
        self.skipped_meta().begin_pass();
        for directory in crate::library::known_recordings_dirs() {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                if self.stopping.load(Ordering::Acquire) || self.jobs.lock().await.len() >= 2 {
                    return;
                }
                let project = entry.path();
                if !self.skipped_meta().is_candidate(&project, |project| {
                    RecordingMeta::load_for_project(project).ok()
                }) {
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
        self.skipped_meta().finish_pass();
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
            state.attempt_count,
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
        loop {
            STATE_CHANGED.notified().await;
            cx.background_executor().timer(Duration::from_secs(2)).await;
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
    match read_state(&canonical) {
        Ok(Some(mut state)) => {
            manager().forget_pending_rechecks(&state.video_id);
            state.phase = UploadPhase::Cancelled;
            write_state(&canonical, &state)?;
        }
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(path = %canonical.display(), %error, "Deleting local recording with unreadable upload state");
        }
    }
    tokio::task::spawn_blocking(move || crate::library::delete_recording_directory(&project))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod verify_resume_tests;

#[cfg(test)]
mod stop_tail_bench;

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
                self.state().attempt_count,
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
        fail_transfer: AtomicBool,
        verified: AtomicBool,
        fail_confirmation: AtomicBool,
        stall_confirmation: AtomicBool,
        reupload_required: AtomicBool,
        delete: AtomicBool,
        keep_cleanup_entry: AtomicBool,
        transfers: AtomicUsize,
        confirmations: AtomicUsize,
        failure_notifications: AtomicUsize,
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
            if self.fail_transfer.load(Ordering::Acquire) {
                return Err("Failed to upload instant segment display/segment_0.m4s".into());
            }
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
            verification: &UploadVerification,
        ) -> Result<(), String> {
            if std::fs::read(project.join("content/output.mp4"))
                .map_err(|error| error.to_string())?
                != b"saved-output"
            {
                return Err("The local recording changed after upload".into());
            }
            if verification != &UploadVerification::mp4(12, 2.0, true, "\"fake-object\"".into())? {
                return Err("The saved upload verification no longer matches the recording".into());
            }
            Ok(())
        }
        fn delete_after_upload(&self) -> bool {
            self.delete.load(Ordering::Acquire)
        }

        fn forget_start_cleanup(&self, _video_id: &str) -> bool {
            !self.keep_cleanup_entry.load(Ordering::Acquire)
        }

        fn notify_failure(&self) {
            self.failure_notifications.fetch_add(1, Ordering::AcqRel);
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
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Uploading);
        assert_eq!(state.attempt_count, 0);
        assert!(state.pending(now(), false));
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 0);
        assert_eq!(
            manager
                .backend
                .failure_notifications
                .load(Ordering::Acquire),
            0
        );
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
                manager
                    .backend
                    .failure_notifications
                    .load(Ordering::Acquire),
                1
            );
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

    async fn confirm_pending(
        fixture: &Fixture,
        manager: &Arc<Manager<FakeBackend>>,
        delay: Duration,
    ) {
        let before = now();
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(manager).await;
        let after = now();
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Processing);
        let delay = delay.as_secs() as i64;
        assert!((before + delay..=after + delay).contains(&state.next_retry_at.unwrap()));
    }

    #[tokio::test]
    async fn pending_cloud_verification_rechecks_quickly_then_backs_off() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        for _ in 0..FAST_PENDING_RECHECKS {
            confirm_pending(&fixture, &manager, PENDING_RECHECK_INTERVAL).await;
        }
        confirm_pending(&fixture, &manager, RECONCILE_INTERVAL).await;
        confirm_pending(&fixture, &manager, RECONCILE_INTERVAL).await;
        assert_eq!(
            manager.backend.confirmations.load(Ordering::Acquire),
            FAST_PENDING_RECHECKS as usize + 2
        );
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn verification_resets_the_fast_recheck_budget() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        for _ in 0..3 {
            confirm_pending(&fixture, &manager, PENDING_RECHECK_INTERVAL).await;
        }
        manager.backend.verified.store(true, Ordering::Release);
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
        assert!(manager.pending_rechecks.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_confirmation_resets_the_fast_recheck_budget() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        confirm_pending(&fixture, &manager, PENDING_RECHECK_INTERVAL).await;
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
        assert!(manager.pending_rechecks.lock().unwrap().is_empty());
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn pending_cloud_verification_wakes_the_queue_for_its_recheck() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().phase, UploadPhase::Processing);
        manager.wake.notified().await;
        let started = tokio::time::Instant::now();
        tokio::time::timeout(RECONCILE_INTERVAL, manager.wake.notified())
            .await
            .unwrap();
        assert!(
            started.elapsed() >= PENDING_RECHECK_INTERVAL.saturating_sub(Duration::from_millis(50))
        );
    }

    #[tokio::test]
    async fn stale_cached_verification_is_replaced_only_after_a_new_transfer() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        let mut state = fixture.state();
        state.verification = Some(
            UploadVerification::mp4(
                12,
                f64::from_bits(2.0_f64.to_bits() + 1),
                true,
                "\"fake-object\"".into(),
            )
            .unwrap(),
        );
        write_state(&fixture.project(), &state).unwrap();
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 0);
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert!(state.verification.is_none());
        assert!(state.receipt.is_none());
        fixture.assert_retained();

        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 1);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 1);
        let state = fixture.state();
        assert_eq!(state.video_id, "same-video");
        assert_eq!(state.phase, UploadPhase::Verified);
        assert_eq!(
            state.verification.unwrap(),
            UploadVerification::mp4(12, 2.0, true, "\"fake-object\"".into()).unwrap()
        );
        assert_eq!(
            std::fs::read(fixture.project().join("content/output.mp4")).unwrap(),
            b"saved-output"
        );
    }

    #[tokio::test]
    async fn cached_verification_cannot_confirm_changed_local_media() {
        let fixture = Fixture::new();
        fixture.cache_receipt();
        std::fs::write(
            fixture.project().join("content/output.mp4"),
            b"changed-data",
        )
        .unwrap();
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        assert_eq!(manager.backend.confirmations.load(Ordering::Acquire), 0);
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert!(state.verification.is_none());
        assert!(state.receipt.is_none());
        assert_eq!(
            std::fs::read(fixture.project().join("content/output.mp4")).unwrap(),
            b"changed-data"
        );
        assert!(
            pending_video(&RecordingMeta::load_for_project(&fixture.project()).unwrap()).is_some()
        );
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
    async fn verified_upload_stays_local_when_its_cleanup_entry_cannot_be_cleared() {
        let fixture = Fixture::new();
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        backend.delete.store(true, Ordering::Release);
        backend.keep_cleanup_entry.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().phase, UploadPhase::Verified);
        assert!(fixture.project().join("content/output.mp4").is_file());
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
        assert_eq!(
            manager
                .backend
                .failure_notifications
                .load(Ordering::Acquire),
            0
        );
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
    fn damaged_upload_state_does_not_prevent_local_deletion() {
        for damage in ["truncated", "unsupported", "oversized"] {
            let fixture = Fixture::new();
            let path = fixture.project().join(STATE_FILE);
            match damage {
                "truncated" => std::fs::write(&path, b"{\"version\":").unwrap(),
                "unsupported" => {
                    let mut state = fixture.state();
                    state.version = 2;
                    write_state(&fixture.project(), &state).unwrap();
                }
                "oversized" => {
                    std::fs::write(&path, vec![b' '; MAX_STATE_BYTES as usize + 1]).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(read_state(&fixture.project()).is_err());
            let store = fixture.0.join("store");
            std::fs::write(
                &store,
                serde_json::to_vec(&json!({
                    "general_settings": { "recordingsPath": fixture.0.join("library") }
                }))
                .unwrap(),
            )
            .unwrap();
            let worker_store = store.clone();
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .on_thread_start(move || {
                    crate::store::set_test_tauri_store_path(Some(worker_store.clone()));
                })
                .build()
                .unwrap();
            let ownership = UploadLock::acquire(&fixture.project()).unwrap();
            assert_eq!(
                runtime
                    .block_on(delete_recording(fixture.project()))
                    .unwrap_err(),
                UploadLockError::Busy.to_string()
            );
            assert!(fixture.project().join("content/output.mp4").is_file());
            drop(ownership);
            assert_eq!(
                runtime.block_on(delete_recording(fixture.project())),
                Err("Path is not inside a recordings directory".to_string())
            );
            fixture.assert_retained();
            std::fs::write(
                &store,
                serde_json::to_vec(&json!({
                    "general_settings": { "recordingsPath": fixture.0 }
                }))
                .unwrap(),
            )
            .unwrap();
            runtime
                .block_on(delete_recording(fixture.project()))
                .unwrap();
            assert!(!fixture.project().exists(), "{damage}");
        }
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

    fn retry_delay(state: &UploadState, before: i64, after: i64) -> std::ops::RangeInclusive<i64> {
        let next = state.next_retry_at.unwrap();
        (next - after)..=(next - before)
    }

    async fn processing(fixture: &Fixture, manager: &Manager<FakeBackend>) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while manager.backend.confirmations.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(fixture.state().phase, UploadPhase::Processing);
    }

    #[tokio::test]
    async fn repeated_quits_never_spend_the_automatic_retry_budget() {
        let fixture = Fixture::new();
        let mut state = fixture.state();
        state.phase = UploadPhase::Retrying;
        state.attempt_count = MAX_AUTOMATIC_ATTEMPTS - 1;
        state.next_retry_at = Some(now() - 1);
        write_state(&fixture.project(), &state).unwrap();
        for quit in 0..(2 * MAX_AUTOMATIC_ATTEMPTS) {
            let in_confirmation = quit >= MAX_AUTOMATIC_ATTEMPTS;
            let backend = FakeBackend::default();
            backend.gated.store(!in_confirmation, Ordering::Release);
            backend
                .stall_confirmation
                .store(in_confirmation, Ordering::Release);
            let manager = Arc::new(Manager::new(backend, Duration::from_secs(30)));
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            if in_confirmation {
                processing(&fixture, &manager).await;
            } else {
                manager.backend.started.notified().await;
            }
            manager.shutdown().await;
            let state = fixture.state();
            assert_eq!(state.attempt_count, MAX_AUTOMATIC_ATTEMPTS - 1);
            assert_eq!(
                state.phase,
                if in_confirmation {
                    UploadPhase::Processing
                } else {
                    UploadPhase::Uploading
                }
            );
            assert!(state.pending(now(), false));
            assert!(state.is_pending());
            assert_eq!(
                manager
                    .backend
                    .failure_notifications
                    .load(Ordering::Acquire),
                0
            );
            fixture.assert_retained();
            drop(UploadLock::acquire(&fixture.project()).unwrap());
        }
        let backend = FakeBackend::default();
        backend.verified.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), true)
            .await
            .unwrap();
        joined(&manager).await;
        let state = fixture.state();
        assert_eq!(state.phase, UploadPhase::Verified);
        assert_eq!(state.video_id, "same-video");
    }

    #[tokio::test]
    async fn quit_after_real_failures_keeps_their_count_and_the_next_failure_is_final() {
        let fixture = Fixture::new();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        manager.backend.fail_transfer.store(true, Ordering::Release);
        for attempt in 1..MAX_AUTOMATIC_ATTEMPTS {
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            joined(&manager).await;
            assert_eq!(fixture.state().attempt_count, attempt);
            assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        }
        let quitting = FakeBackend::default();
        quitting.gated.store(true, Ordering::Release);
        let quitting = Arc::new(Manager::new(quitting, Duration::from_secs(1)));
        quitting
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        quitting.backend.started.notified().await;
        quitting.shutdown().await;
        assert_eq!(fixture.state().attempt_count, MAX_AUTOMATIC_ATTEMPTS - 1);
        assert_eq!(fixture.state().phase, UploadPhase::Uploading);
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        let state = fixture.state();
        assert_eq!(state.attempt_count, MAX_AUTOMATIC_ATTEMPTS);
        assert_eq!(state.phase, UploadPhase::Failed);
        assert!(state.next_retry_at.is_none());
        assert!(!state.pending(i64::MAX, false));
        assert!(state.can_retry());
        assert_eq!(
            manager
                .backend
                .failure_notifications
                .load(Ordering::Acquire),
            MAX_AUTOMATIC_ATTEMPTS as usize
        );
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn genuine_failures_back_off_exponentially_until_failed() {
        let fixture = Fixture::new();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        manager.backend.fail_transfer.store(true, Ordering::Release);
        for attempt in 1..=MAX_AUTOMATIC_ATTEMPTS {
            let before = now();
            manager
                .admit(fixture.project(), fixture.upload(), false)
                .await
                .unwrap();
            joined(&manager).await;
            let after = now();
            let state = fixture.state();
            assert_eq!(state.attempt_count, attempt);
            if attempt < MAX_AUTOMATIC_ATTEMPTS {
                assert_eq!(state.phase, UploadPhase::Retrying);
                assert!(retry_delay(&state, before, after).contains(&(30_i64 << attempt)));
            } else {
                assert_eq!(state.phase, UploadPhase::Failed);
                assert!(state.next_retry_at.is_none());
            }
        }
        assert_eq!(
            manager.backend.transfers.load(Ordering::Acquire),
            MAX_AUTOMATIC_ATTEMPTS as usize
        );
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn live_failure_before_handoff_is_counted_once() {
        let fixture = Fixture::new();
        let upload = fixture.upload();
        let before = now();
        crate::recording::persist_instant_upload_failure(
            &fixture.project(),
            "Failed to upload instant segment display/segment_0.m4s",
            upload.metadata_lock(),
        )
        .unwrap();
        assert_eq!(fixture.state().attempt_count, 1);
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
        let backend = FakeBackend::default();
        backend.fail_transfer.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), upload, false)
            .await
            .unwrap();
        joined(&manager).await;
        let after = now();
        let state = fixture.state();
        assert_eq!(state.attempt_count, 1);
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert!(retry_delay(&state, before, after).contains(&60));
        assert_eq!(
            manager
                .backend
                .failure_notifications
                .load(Ordering::Acquire),
            1
        );
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn live_failure_after_handoff_is_counted_once() {
        let fixture = Fixture::new();
        let upload = fixture.upload();
        let metadata_lock = upload.metadata_lock.clone();
        let backend = FakeBackend::default();
        backend.gated.store(true, Ordering::Release);
        backend.fail_transfer.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), upload, false)
            .await
            .unwrap();
        manager.backend.started.notified().await;
        crate::recording::persist_instant_upload_failure(
            &fixture.project(),
            "Failed to upload instant segment display/segment_0.m4s",
            &metadata_lock,
        )
        .unwrap();
        assert_eq!(fixture.state().attempt_count, 1);
        manager.backend.release.notify_one();
        joined(&manager).await;
        let state = fixture.state();
        assert_eq!(state.attempt_count, 1);
        assert_eq!(state.phase, UploadPhase::Retrying);
        fixture.assert_retained();
    }

    #[tokio::test]
    async fn live_failure_survives_a_crash_before_handoff() {
        let fixture = Fixture::new();
        let upload = fixture.upload();
        crate::recording::persist_instant_upload_failure(
            &fixture.project(),
            "Failed to upload instant segment display/segment_0.m4s",
            upload.metadata_lock(),
        )
        .unwrap();
        drop(upload);
        let state = fixture.state();
        assert_eq!(state.attempt_count, 1);
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert!(state.last_error.is_some());
        let backend = FakeBackend::default();
        backend.fail_transfer.store(true, Ordering::Release);
        let manager = Arc::new(Manager::new(backend, Duration::from_secs(1)));
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        assert_eq!(fixture.state().attempt_count, 2);
        assert_eq!(fixture.state().phase, UploadPhase::Retrying);
    }

    #[tokio::test]
    async fn failed_handoff_after_a_live_failure_is_counted_once() {
        let fixture = Fixture::new();
        let upload = fixture.upload();
        crate::recording::persist_instant_upload_failure(
            &fixture.project(),
            "Failed to upload instant segment display/segment_0.m4s",
            upload.metadata_lock(),
        )
        .unwrap();
        std::fs::remove_file(fixture.project().join("content/output.mp4")).unwrap();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        assert!(
            manager
                .admit(fixture.project(), upload, false)
                .await
                .is_err()
        );
        let state = fixture.state();
        assert_eq!(state.attempt_count, 1);
        assert_eq!(state.phase, UploadPhase::Retrying);
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
    }

    #[tokio::test]
    async fn deferred_handoff_after_a_live_failure_keeps_its_count() {
        let fixture = Fixture::new();
        let upload = fixture.upload();
        crate::recording::persist_instant_upload_failure(
            &fixture.project(),
            "Failed to upload instant segment display/segment_0.m4s",
            upload.metadata_lock(),
        )
        .unwrap();
        let manager = Arc::new(Manager::new(FakeBackend::default(), Duration::from_secs(1)));
        for slot in 0..2 {
            let (cancel, _) = tokio::sync::watch::channel(false);
            manager.jobs.lock().await.insert(
                PathBuf::from(format!("/busy-{slot}")),
                Job {
                    video_id: format!("busy-{slot}"),
                    cancel,
                    cancel_upload: Arc::new(AtomicBool::new(false)),
                    task: tokio::spawn(std::future::pending()),
                },
            );
        }
        manager
            .admit(fixture.project(), upload, false)
            .await
            .unwrap();
        let state = fixture.state();
        assert_eq!(state.attempt_count, 1);
        assert_eq!(state.phase, UploadPhase::Pending);
        assert_eq!(manager.backend.transfers.load(Ordering::Acquire), 0);
        for job in manager.jobs.lock().await.drain().map(|(_, job)| job) {
            job.task.abort();
        }
        manager.backend.fail_transfer.store(true, Ordering::Release);
        manager
            .admit(fixture.project(), fixture.upload(), false)
            .await
            .unwrap();
        joined(&manager).await;
        let state = fixture.state();
        assert_eq!(state.attempt_count, 2);
        assert_eq!(state.phase, UploadPhase::Retrying);
        fixture.assert_retained();
    }

    fn save_library_meta(project: &Path, upload: Option<UploadMeta>) {
        std::fs::create_dir_all(project).unwrap();
        RecordingMeta {
            platform: None,
            project_path: project.to_path_buf(),
            pretty_name: "Library recording".into(),
            sharing: None,
            inner: RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
                fps: 30,
                sample_rate: None,
            }),
            upload,
        }
        .save_for_project()
        .unwrap();
    }

    fn scan_library(
        skipped: &mut SkippedMeta,
        library: &Path,
        parses: &AtomicUsize,
    ) -> Vec<PathBuf> {
        skipped.begin_pass();
        let mut candidates = std::fs::read_dir(library)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .filter(|project| {
                skipped.is_candidate(project, |project| {
                    parses.fetch_add(1, Ordering::Relaxed);
                    RecordingMeta::load_for_project(project).ok()
                })
            })
            .collect::<Vec<_>>();
        skipped.finish_pass();
        candidates.sort();
        candidates
    }

    fn library_with_skipped_projects(skipped_projects: usize) -> Fixture {
        let fixture = Fixture::new();
        for index in 0..skipped_projects {
            let upload = (index % 2 == 0).then_some(UploadMeta::Complete);
            save_library_meta(&fixture.0.join(format!("skip-{index}.cap")), upload);
        }
        std::fs::write(fixture.0.join("notes.txt"), b"not a recording").unwrap();
        fixture
    }

    #[test]
    fn unchanged_skipped_recordings_are_not_parsed_again() {
        let fixture = library_with_skipped_projects(6);
        let mut skipped = SkippedMeta::default();
        let parses = AtomicUsize::new(0);

        assert_eq!(
            scan_library(&mut skipped, &fixture.0, &parses),
            vec![fixture.project()]
        );
        assert_eq!(parses.swap(0, Ordering::Relaxed), 8);
        assert_eq!(skipped.stamps.len(), 6);

        assert_eq!(
            scan_library(&mut skipped, &fixture.0, &parses),
            vec![fixture.project()]
        );
        assert_eq!(parses.load(Ordering::Relaxed), 2);
        assert_eq!(
            read_state(&fixture.project()).unwrap().unwrap().phase,
            UploadPhase::Pending
        );
    }

    #[test]
    fn rewritten_recording_meta_is_reclassified_on_the_next_pass() {
        let fixture = library_with_skipped_projects(2);
        let mut skipped = SkippedMeta::default();
        let parses = AtomicUsize::new(0);
        let flipped = fixture.0.join("skip-1.cap");
        scan_library(&mut skipped, &fixture.0, &parses);

        save_library_meta(
            &flipped,
            Some(UploadMeta::SinglePartUpload {
                video_id: "flipped-video".into(),
                file_path: flipped.join("content/output.mp4"),
                screenshot_path: flipped.join("screenshots/display.jpg"),
                recording_dir: flipped.clone(),
            }),
        );
        assert_eq!(
            scan_library(&mut skipped, &fixture.0, &parses),
            vec![fixture.project(), flipped.clone()]
        );
        assert!(!skipped.stamps.contains_key(flipped.as_os_str()));

        save_library_meta(&flipped, Some(UploadMeta::Complete));
        assert_eq!(
            scan_library(&mut skipped, &fixture.0, &parses),
            vec![fixture.project()]
        );
        parses.store(0, Ordering::Relaxed);
        scan_library(&mut skipped, &fixture.0, &parses);
        assert_eq!(parses.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn recordings_whose_meta_failed_to_load_are_retried() {
        let fixture = Fixture::new();
        let project = fixture.project();
        let mut skipped = SkippedMeta::default();

        skipped.begin_pass();
        assert!(!skipped.is_candidate(&project, |_| None));
        skipped.finish_pass();
        assert!(!skipped.stamps.contains_key(project.as_os_str()));

        skipped.begin_pass();
        assert!(skipped.is_candidate(&project, |project| {
            RecordingMeta::load_for_project(project).ok()
        }));
        skipped.finish_pass();
        assert!(skipped.stamps.is_empty());
    }

    #[test]
    fn unparsable_recording_meta_is_parsed_again_every_pass() {
        let fixture = library_with_skipped_projects(2);
        let mut skipped = SkippedMeta::default();
        let parses = AtomicUsize::new(0);
        let corrupt = fixture.0.join("skip-0.cap");
        std::fs::write(corrupt.join("recording-meta.json"), b"{ not json").unwrap();

        scan_library(&mut skipped, &fixture.0, &parses);
        assert!(!skipped.stamps.contains_key(corrupt.as_os_str()));
        assert_eq!(skipped.stamps.len(), 1);

        parses.store(0, Ordering::Relaxed);
        scan_library(&mut skipped, &fixture.0, &parses);
        assert_eq!(parses.load(Ordering::Relaxed), 3);
        assert!(!skipped.stamps.contains_key(corrupt.as_os_str()));
    }

    #[test]
    fn deleted_recordings_leave_the_skip_cache() {
        let fixture = library_with_skipped_projects(4);
        let mut skipped = SkippedMeta::default();
        let parses = AtomicUsize::new(0);
        let deleted = fixture.0.join("skip-2.cap");
        scan_library(&mut skipped, &fixture.0, &parses);
        assert!(skipped.stamps.contains_key(deleted.as_os_str()));

        std::fs::remove_dir_all(&deleted).unwrap();
        scan_library(&mut skipped, &fixture.0, &parses);
        assert_eq!(skipped.stamps.len(), 3);
        assert!(!skipped.stamps.contains_key(deleted.as_os_str()));

        std::fs::remove_dir_all(&fixture.0).unwrap();
        std::fs::create_dir_all(&fixture.0).unwrap();
        scan_library(&mut skipped, &fixture.0, &parses);
        assert!(skipped.stamps.is_empty());
    }
}
