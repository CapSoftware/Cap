use super::*;
use crate::{auth::AuthStore, web_api::UploadRequestContext};
use futures::FutureExt;
use std::{io::Write, sync::atomic::AtomicBool};

const FILE_NAME: &str = "tauri-upload.json";

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u32,
    video_id: String,
    server_url: String,
    owner_id: Option<String>,
    required_audio: Option<bool>,
    local_ready: bool,
    cancelled: bool,
    preserve_local: bool,
    failures: u32,
    #[serde(default)]
    needs_authentication: bool,
    retry_at: Option<i64>,
    error: Option<String>,
    verification: Option<UploadVerification>,
    receipt: Option<VerifiedUploadReceipt>,
}

fn read(directory: &Path) -> Result<Option<Intent>, AuthedApiError> {
    let path = directory.join(FILE_NAME);
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string().into()),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Upload intent is a reparse point".into());
        }
    }
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 65536 {
        return Err("Invalid recording upload intent".into());
    }
    let intent: Intent =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)?;
    if intent.version != 1 || intent.video_id.is_empty() || intent.server_url.is_empty() {
        return Err("Unsupported recording upload intent".into());
    }
    Ok(Some(intent))
}

fn write(directory: &Path, intent: &Intent) -> Result<(), AuthedApiError> {
    read(directory)?;
    let bytes = serde_json::to_vec_pretty(intent)?;
    let temporary = directory.join(format!(".tauri-upload-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, directory.join(FILE_NAME))?;
        #[cfg(unix)]
        std::fs::File::open(directory)?.sync_all()?;
        Ok::<_, io::Error>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result.map_err(|error| format!("Could not save upload intent: {error}").into())
}

pub(crate) async fn prepare(
    app: &AppHandle,
    directory: &Path,
    video_id: &str,
    required_audio: bool,
) -> Result<Arc<Session>, AuthedApiError> {
    let server_url = app.make_app_url("").await.trim_end_matches('/').to_string();
    let owner_id = AuthStore::get(app)
        .map_err(AuthedApiError::AuthStore)?
        .and_then(|auth| auth.user_id);
    let context = UploadRequestContext::new(
        server_url.clone(),
        owner_id
            .clone()
            .ok_or(AuthedApiError::InvalidAuthentication)?,
    )?;
    context.check(app).await?;
    let lock = acquire_upload_lock(directory)?;
    if read(directory)?.is_some() {
        return Err("Recording already has an upload identity".into());
    }
    write(
        directory,
        &Intent {
            version: 1,
            video_id: video_id.into(),
            server_url,
            owner_id,
            required_audio: Some(required_audio),
            local_ready: false,
            cancelled: false,
            preserve_local: false,
            failures: 0,
            needs_authentication: false,
            retry_at: None,
            error: None,
            verification: None,
            receipt: None,
        },
    )?;
    let session = Session::new(lock.project_path().to_path_buf(), video_id.to_string());
    session.adopt(lock)?;
    Ok(session)
}

#[derive(Default)]
struct ReadTracker {
    active: AtomicUsize,
    changed: tokio::sync::Notify,
}

pub(crate) struct ReadGuard(Arc<ReadTracker>);

impl Drop for ReadGuard {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
        self.0.changed.notify_one();
    }
}

#[derive(Clone)]
pub(crate) struct UploadScope {
    cancelled: tokio::sync::watch::Receiver<bool>,
    reads: Arc<ReadTracker>,
}

tokio::task_local! {
    static UPLOAD_SCOPE: UploadScope;
}

impl UploadScope {
    pub(crate) fn current() -> Option<Self> {
        UPLOAD_SCOPE.try_with(Clone::clone).ok()
    }

    pub(crate) async fn bind<F: std::future::Future>(self, future: F) -> F::Output {
        UPLOAD_SCOPE.scope(self, future).await
    }

    pub(crate) fn read_guard(&self) -> ReadGuard {
        self.reads.active.fetch_add(1, Ordering::AcqRel);
        ReadGuard(self.reads.clone())
    }

    async fn cancelled(&self) {
        let mut cancelled = self.cancelled.clone();
        while !*cancelled.borrow_and_update() {
            if cancelled.changed().await.is_err() {
                break;
            }
        }
    }

    fn check(&self) -> Result<(), AuthedApiError> {
        if *self.cancelled.borrow() {
            Err("Recording upload cancelled; local files retained".into())
        } else {
            Ok(())
        }
    }
}

pub(crate) async fn cancellable<F: std::future::Future>(
    future: F,
) -> Result<F::Output, AuthedApiError> {
    if let Some(scope) = UploadScope::current() {
        scope.check()?;
        let result = tokio::select! {
            result = future => result,
            _ = scope.cancelled() => return Err("Recording upload cancelled; local files retained".into()),
        };
        scope.check()?;
        Ok(result)
    } else {
        Ok(future.await)
    }
}

pub(crate) async fn file_io<T: Send + 'static>(
    operation: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    let scope = UploadScope::current();
    if let Some(scope) = &scope {
        scope.check().map_err(io::Error::other)?;
    }
    let guard = scope.map(|scope| scope.read_guard());
    let task = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        operation()
    });
    cancellable(task)
        .await
        .map_err(io::Error::other)?
        .map_err(io::Error::other)?
}

pub(crate) struct Session {
    pub(crate) directory: PathBuf,
    video_id: String,
    ownership: Mutex<Option<UploadLock>>,
    request_context: Mutex<Option<UploadRequestContext>>,
    cancelled: tokio::sync::watch::Sender<bool>,
    ready: tokio::sync::Notify,
    terminal: tokio::sync::watch::Sender<Option<Result<(), String>>>,
    verified: Mutex<Option<(UploadVerification, VerifiedUploadReceipt)>>,
    ledger: Mutex<()>,
    reads: Arc<ReadTracker>,
    #[cfg(target_os = "linux")]
    strict_control: Mutex<Option<super::strict_instant::Control>>,
}

impl Session {
    pub(crate) fn new(directory: PathBuf, video_id: String) -> Arc<Self> {
        Arc::new(Self {
            directory,
            video_id,
            ownership: Mutex::new(None),
            request_context: Mutex::new(None),
            cancelled: tokio::sync::watch::channel(false).0,
            ready: tokio::sync::Notify::new(),
            terminal: tokio::sync::watch::channel(None).0,
            verified: Mutex::new(None),
            ledger: Mutex::new(()),
            reads: Arc::new(ReadTracker::default()),
            #[cfg(target_os = "linux")]
            strict_control: Mutex::new(None),
        })
    }

    pub(crate) async fn run<F: std::future::Future>(&self, future: F) -> F::Output {
        let scope = UploadScope {
            cancelled: self.cancelled.subscribe(),
            reads: self.reads.clone(),
        };
        let result = std::panic::AssertUnwindSafe(scope.bind(future))
            .catch_unwind()
            .await;
        self.wait_for_reads().await;
        match result {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    pub(crate) async fn wait_for_reads(&self) {
        while self.reads.active.load(Ordering::Acquire) != 0 {
            tokio::select! { _ = self.reads.changed.notified() => {}, _ = tokio::time::sleep(Duration::from_millis(10)) => {} }
        }
    }

    pub(crate) fn adopt(&self, lock: UploadLock) -> Result<(), AuthedApiError> {
        if self
            .directory
            .canonicalize()
            .map_err(|error| error.to_string())?
            != lock.project_path()
        {
            return Err("Upload ownership path changed".into());
        }
        *self
            .ownership
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(lock);
        self.load_context()?;
        self.check()
    }

    fn load_context(&self) -> Result<(), AuthedApiError> {
        if let Some(intent) = read(&self.directory)? {
            if intent.video_id != self.video_id || intent.cancelled {
                return Err("Recording upload identity changed or was cancelled".into());
            }
            let context = UploadRequestContext::new(
                intent.server_url,
                intent
                    .owner_id
                    .ok_or(AuthedApiError::InvalidAuthentication)?,
            )?;
            *self
                .request_context
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(context);
        }
        Ok(())
    }

    pub(crate) fn cached_verification(&self) -> Result<Option<UploadVerification>, AuthedApiError> {
        let verification = read(&self.directory)?.and_then(|intent| intent.verification);
        if verification
            .as_ref()
            .is_some_and(UploadVerification::requires_reupload)
        {
            self.clear_verification()?;
            return Ok(None);
        }
        if let Some(verification) = &verification
            && let Err(error) = verify_local_artifact(&self.directory, verification)
        {
            self.clear_verification()?;
            return Err(error);
        }
        Ok(verification)
    }

    pub(crate) fn acquire(&self) -> Result<(), AuthedApiError> {
        let mut ownership = self
            .ownership
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if ownership.is_some() {
            return self.check();
        }
        let lock = acquire_upload_lock(&self.directory)?;
        let meta =
            RecordingMeta::load_for_project(&self.directory).map_err(|error| error.to_string())?;
        if let Some(id) = upload_video_id(&meta.upload)
            && id != self.video_id
        {
            return Err("Recording upload identity changed".into());
        }
        self.load_context()?;
        *ownership = Some(lock);
        self.check()
    }

    pub(crate) fn context(&self) -> Option<UploadRequestContext> {
        self.request_context
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn check(&self) -> Result<(), AuthedApiError> {
        if *self.cancelled.borrow() {
            Err("Recording upload cancelled; local files retained".into())
        } else {
            Ok(())
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn bind_control(&self, control: super::strict_instant::Control) {
        *self
            .strict_control
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(control);
    }

    pub(crate) fn cancel(&self) {
        #[cfg(target_os = "linux")]
        if let Some(control) = self
            .strict_control
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            control.deny();
        }
        self.cancelled.send_replace(true);
        self.ready.notify_one();
    }

    pub(crate) async fn cancelled(&self) {
        let mut cancelled = self.cancelled.subscribe();
        while !*cancelled.borrow_and_update() {
            if cancelled.changed().await.is_err() {
                break;
            }
        }
    }

    pub(crate) fn persist_upload(&self, upload: UploadMeta) -> Result<(), AuthedApiError> {
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        self.check()?;
        let mut meta =
            RecordingMeta::load_for_project(&self.directory).map_err(|error| error.to_string())?;
        meta.upload = Some(upload);
        meta.save_for_project().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn persist_local_complete(
        &self,
        recording: cap_project::InstantRecordingMeta,
        sharing: cap_project::SharingMeta,
    ) -> Result<(), AuthedApiError> {
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        self.check()?;
        let mut meta =
            RecordingMeta::load_for_project(&self.directory).map_err(|error| error.to_string())?;
        meta.inner = cap_project::RecordingMetaInner::Instant(recording);
        meta.sharing = Some(sharing);
        meta.save_for_project().map_err(|error| error.to_string())?;
        Ok(())
    }

    pub(crate) fn mark_ready(&self, preserve_local: bool) -> Result<(), AuthedApiError> {
        self.acquire()?;
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut intent) = read(&self.directory)? {
            intent.local_ready = true;
            intent.preserve_local |= preserve_local;
            intent.retry_at = None;
            write(&self.directory, &intent)?;
        }
        self.ready.notify_one();
        Ok(())
    }

    pub(crate) async fn wait_ready(&self) -> Result<(), AuthedApiError> {
        loop {
            self.check()?;
            match read(&self.directory)? {
                Some(intent) if intent.cancelled => {
                    return Err("Recording upload was cancelled".into());
                }
                Some(intent) if !intent.local_ready => {}
                _ => return Ok(()),
            }
            tokio::select! { _ = self.ready.notified() => {}, _ = self.cancelled() => {}, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
        }
    }

    pub(crate) fn record_failure(&self, error: &AuthedApiError) {
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        let result = (|| {
            let Some(mut intent) = read(&self.directory)? else {
                return Ok::<_, AuthedApiError>(());
            };
            intent.needs_authentication = matches!(error, AuthedApiError::InvalidAuthentication);
            if !matches!(
                error,
                AuthedApiError::InvalidAuthentication | AuthedApiError::VerificationPending
            ) {
                intent.failures = intent.failures.saturating_add(1);
            }
            intent.retry_at = (intent.failures < 5).then(|| {
                chrono::Utc::now()
                    .timestamp()
                    .saturating_add(30 * (1_i64 << intent.failures.min(5)))
            });
            intent.error = Some(error.to_string());
            write(&self.directory, &intent)
        })();
        if let Err(error) = result {
            warn!(%error, "Could not save upload retry state");
        }
    }

    pub(crate) fn mark_cancelled(&self) -> Result<(), AuthedApiError> {
        self.cancel();
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut intent) = read(&self.directory)? {
            intent.cancelled = true;
            intent.retry_at = None;
            write(&self.directory, &intent)?;
        }
        Ok(())
    }

    pub(crate) fn set_verification(
        &self,
        verification: &UploadVerification,
    ) -> Result<(), AuthedApiError> {
        self.check()?;
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(mut intent) = read(&self.directory)? {
            if intent.required_audio != Some(verification.required_audio) {
                return Err("Upload audio intent changed".into());
            }
            intent.verification = Some(verification.clone());
            intent.receipt = None;
            write(&self.directory, &intent)?;
        }
        Ok(())
    }

    pub(crate) fn clear_verification(&self) -> Result<(), AuthedApiError> {
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        *self.verified.lock().unwrap_or_else(PoisonError::into_inner) = None;
        if let Some(mut intent) = read(&self.directory)? {
            intent.verification = None;
            intent.receipt = None;
            write(&self.directory, &intent)?;
        }
        Ok(())
    }

    pub(crate) fn record_receipt(
        &self,
        verification: &UploadVerification,
        receipt: &VerifiedUploadReceipt,
    ) -> Result<(), AuthedApiError> {
        self.check()?;
        verification
            .verified_receipt(
                &self.video_id,
                &serde_json::json!({"success":true,"status":"verified","verification":receipt}),
            )?
            .ok_or("Recording verification is pending")?;
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        *self.verified.lock().unwrap_or_else(PoisonError::into_inner) =
            Some((verification.clone(), receipt.clone()));
        if let Some(mut intent) = read(&self.directory)? {
            intent.verification = Some(verification.clone());
            intent.receipt = Some(receipt.clone());
            intent.failures = 0;
            intent.needs_authentication = false;
            intent.retry_at = None;
            intent.error = None;
            write(&self.directory, &intent)?;
        }
        Ok(())
    }

    pub(crate) async fn complete_locally(&self, app: &AppHandle) -> Result<(), AuthedApiError> {
        self.check()?;
        if let Some(context) = self.context() {
            context.check(app).await?;
        }
        let _ledger = self.ledger.lock().unwrap_or_else(PoisonError::into_inner);
        let intent = read(&self.directory)?;
        let evidence = intent
            .as_ref()
            .and_then(|intent| intent.verification.clone().zip(intent.receipt.clone()))
            .or_else(|| {
                self.verified
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .clone()
            })
            .ok_or("Recording verification evidence is missing")?;
        let (verification, receipt) = (&evidence.0, &evidence.1);
        verification
            .verified_receipt(
                &self.video_id,
                &serde_json::json!({"success":true,"status":"verified","verification":receipt}),
            )?
            .ok_or("Recording verification is pending")?;
        verify_local_artifact(&self.directory, verification)?;
        let mut meta =
            RecordingMeta::load_for_project(&self.directory).map_err(|error| error.to_string())?;
        if !matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::Complete { .. }
            )
        ) || upload_video_id(&meta.upload).is_some_and(|id| id != self.video_id)
            || meta
                .sharing
                .as_ref()
                .is_some_and(|sharing| sharing.id != self.video_id)
            || intent.as_ref().is_some_and(|intent| intent.cancelled)
        {
            return Err("Recording is not locally ready for upload completion".into());
        }
        self.check()?;
        meta.upload = Some(UploadMeta::Complete);
        meta.save_for_project().map_err(|error| error.to_string())?;
        self.check()?;
        if intent.as_ref().is_some_and(|intent| !intent.preserve_local)
            && crate::general_settings::GeneralSettingsStore::get(app)
                .ok()
                .flatten()
                .unwrap_or_default()
                .delete_instant_recordings_after_upload
        {
            verify_local_artifact(&self.directory, verification)?;
            self.check()?;
            if let Err(error) = std::fs::remove_dir_all(&self.directory) {
                warn!(%error, "Verified recording retained because cleanup failed");
            }
        }
        Ok(())
    }
}

fn upload_video_id(upload: &Option<UploadMeta>) -> Option<&str> {
    match upload {
        Some(
            UploadMeta::SegmentUpload { video_id, .. }
            | UploadMeta::MultipartUpload { video_id, .. }
            | UploadMeta::SinglePartUpload { video_id, .. },
        ) => Some(video_id),
        _ => None,
    }
}

fn verify_local_artifact(
    directory: &Path,
    verification: &UploadVerification,
) -> Result<(), AuthedApiError> {
    use cap_recording::upload_verification::UploadArtifact;
    match &verification.artifact {
        UploadArtifact::Segments { manifest_sha256 } => {
            let events = resume::collect_segment_events(directory, verification.required_audio)?;
            let manifest = manifest_from_events(&events);
            let compact = UploadVerification::segments(
                &serde_json::to_vec(&manifest)?,
                verification.required_audio,
            );
            let pretty = UploadVerification::segments(
                &serde_json::to_vec_pretty(&manifest)?,
                verification.required_audio,
            );
            if ![compact, pretty].iter().any(|request| matches!(&request.artifact, UploadArtifact::Segments { manifest_sha256: current } if current == manifest_sha256)) {
                return Err("Local recording manifest changed after upload".into());
            }
        }
        UploadArtifact::Mp4 {
            file_size,
            duration,
            ..
        } => {
            let path = directory.join("content/output.mp4");
            verify_file_path(
                &path,
                &directory
                    .canonicalize()
                    .map_err(|error| error.to_string())?
                    .join("content/output.mp4"),
            )?;
            let info = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if info.file_type().is_symlink()
                || !info.is_file()
                || info.len() != *file_size
                || build_video_meta(&path)?.duration_in_secs != *duration
            {
                return Err("Local recording changed after upload".into());
            }
        }
    }
    Ok(())
}

fn manifest_from_events(
    events: &[cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent],
) -> SegmentUploadManifest {
    use cap_enc_ffmpeg::segmented_stream::SegmentMediaType;
    let mut state = SegmentUploadState::new();
    for event in events {
        match (event.is_init, event.media_type) {
            (true, SegmentMediaType::Video) => state.video_init_uploaded = true,
            (true, SegmentMediaType::Audio) => state.audio_init_uploaded = true,
            (false, SegmentMediaType::Video) => {
                state
                    .uploaded_video_segments
                    .insert(event.index, event.duration);
            }
            (false, SegmentMediaType::Audio) => {
                state
                    .uploaded_audio_segments
                    .insert(event.index, event.duration);
            }
        }
    }
    state.to_complete_manifest()
}

pub(crate) async fn resume_audio(
    app: &AppHandle,
    directory: &Path,
    fallback: bool,
) -> Result<Option<bool>, AuthedApiError> {
    Ok(match read(directory)? {
        Some(intent)
            if intent.cancelled
                || intent.failures >= 5
                || intent
                    .retry_at
                    .is_some_and(|at| at > chrono::Utc::now().timestamp()) =>
        {
            None
        }
        Some(intent) => {
            if intent.needs_authentication {
                let context = UploadRequestContext::new(
                    intent.server_url,
                    intent
                        .owner_id
                        .ok_or(AuthedApiError::InvalidAuthentication)?,
                )?;
                if context.check(app).await.is_err() {
                    return Ok(None);
                }
            }
            intent.required_audio
        }
        None => Some(fallback),
    })
}

pub(crate) async fn resume_existing(
    app: AppHandle,
    meta: RecordingMeta,
    lock: UploadLock,
    required_audio: bool,
) -> Result<Arc<Session>, AuthedApiError> {
    let directory = meta.project_path.clone();
    let video_id = upload_video_id(&meta.upload)
        .map(str::to_string)
        .ok_or("No resumable upload identity")?;
    let session = Session::new(lock.project_path().to_path_buf(), video_id.clone());
    session.adopt(lock)?;
    session.mark_ready(false)?;
    let worker = session.clone();
    supervise(app.clone(), session.clone(), async move {
        match meta.upload.clone() {
            Some(UploadMeta::SegmentUpload {
                video_id,
                pre_created_video,
                recording_dir,
            }) => {
                verify_bundle_path(&directory, &recording_dir)?;
                if video_id != pre_created_video.id || video_id != pre_created_video.config.id {
                    return Err("Upload identity changed".into());
                }
                let events = resume::collect_segment_events(&directory, required_audio)?;
                let (sender, receiver) = std::sync::mpsc::channel();
                for event in events {
                    sender.send(event).map_err(|error| error.to_string())?;
                }
                drop(sender);
                SegmentUploader::run(
                    app.clone(),
                    receiver,
                    None,
                    directory.clone(),
                    pre_created_video,
                    required_audio,
                    worker.clone(),
                )
                .await?;
            }
            Some(UploadMeta::MultipartUpload {
                video_id,
                file_path,
                pre_created_video,
                recording_dir,
            }) => {
                verify_bundle_path(&directory, &recording_dir)?;
                if video_id != pre_created_video.id || video_id != pre_created_video.config.id {
                    return Err("Upload identity changed".into());
                }
                verify_file_path(&file_path, &directory.join("content/output.mp4"))?;
                InstantMultipartUpload::run(
                    app.clone(),
                    file_path,
                    pre_created_video,
                    directory.clone(),
                    None,
                    required_audio,
                    worker.clone(),
                )
                .await?;
            }
            Some(UploadMeta::SinglePartUpload {
                video_id,
                file_path,
                screenshot_path,
                recording_dir,
            }) => {
                verify_bundle_path(&directory, &recording_dir)?;
                verify_file_path(&file_path, &meta.output_path())?;
                verify_file_path(&screenshot_path, &directory.join("screenshots/display.jpg"))?;
                let metadata = build_video_meta(&file_path)?;
                let file_size = std::fs::metadata(&file_path).map_err(|error| error.to_string())?.len();
                let duration = metadata.duration_in_secs;
                let uploaded = upload_video(
                    &app,
                    video_id.clone(),
                    file_path,
                    screenshot_path,
                    metadata,
                    None,
                )
                .await?;
                if uploaded.id != video_id {
                    return Err("Server upload identity changed".into());
                }
                if matches!(meta.inner, cap_project::RecordingMetaInner::Instant(_)) {
                    let verification = UploadVerification::mp4(file_size, duration, required_audio, uploaded.object_identity.ok_or("Server did not return the uploaded object identity; local recording retained")?)?;
                    await_upload_verification(&app, &video_id, &verification, &worker).await?;
                } else {
                    let mut current = RecordingMeta::load_for_project(&directory)
                        .map_err(|error| error.to_string())?;
                    if upload_video_id(&current.upload) != Some(video_id.as_str()) {
                        return Err("Upload identity changed during transfer".into());
                    }
                    worker.check()?;
                    current.upload = Some(UploadMeta::Complete);
                    current.sharing = Some(cap_project::SharingMeta {
                        id: uploaded.id,
                        link: uploaded.link,
                        content_hash: None,
                    });
                    current
                        .save_for_project()
                        .map_err(|error| error.to_string())?;
                    return Ok(());
                }
            }
            _ => return Err("No resumable upload remains".into()),
        }
        let screenshot = directory.join("screenshots/display.jpg");
        if screenshot.is_file() {
            let bytes = compress_image(screenshot).await?;
            worker.check()?;
            singlepart_uploader(
                app.clone(),
                PresignedS3PutRequest {
                    video_id,
                    subpath: "screenshot/screen-capture.jpg".into(),
                    method: PresignedS3PutRequestMethod::Put,
                    meta: None,
                },
                bytes.len() as u64,
                futures::stream::once(async move { Ok::<_, io::Error>(Bytes::from(bytes)) }),
            )
            .await?;
        }
        worker.complete_locally(&app).await
    })
    .await?;
    Ok(session)
}

fn verify_bundle_path(expected: &Path, stored: &Path) -> Result<(), AuthedApiError> {
    if expected.canonicalize().map_err(|error| error.to_string())?
        != stored.canonicalize().map_err(|error| error.to_string())?
    {
        return Err("Stored recording path changed".into());
    }
    Ok(())
}

fn verify_file_path(stored: &Path, expected: &Path) -> Result<(), AuthedApiError> {
    let parent = expected
        .parent()
        .ok_or("Upload input has no local parent")?;
    let parent_info = parent
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    if parent_info.file_type().is_symlink() || !parent_info.is_dir() {
        return Err("Upload input directory is not a local directory".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if parent_info.file_attributes() & 0x400 != 0 {
            return Err("Upload input directory is a reparse point".into());
        }
    }
    let metadata = stored
        .symlink_metadata()
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Upload input is a reparse point".into());
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() == 0 {
        return Err("Upload input is not a valid local file".into());
    }
    verify_bundle_path(expected, stored)
}

fn pending_reupload(meta: &RecordingMeta, intent: &Intent) -> Result<UploadMeta, AuthedApiError> {
    use cap_recording::upload_verification::UploadArtifact;
    let sharing = meta
        .sharing
        .as_ref()
        .ok_or("Recording share identity is missing")?;
    if sharing.id != intent.video_id || intent.cancelled || !intent.local_ready {
        return Err("Recording retry identity changed or was cancelled".into());
    }
    let video = VideoUploadInfo {
        id: intent.video_id.clone(),
        link: sharing.link.clone(),
        config: S3UploadMeta {
            id: intent.video_id.clone(),
        },
    };
    let segmented = match intent
        .verification
        .as_ref()
        .map(|request| &request.artifact)
    {
        Some(UploadArtifact::Segments { .. }) => true,
        Some(UploadArtifact::Mp4 { .. }) => false,
        None => match meta.project_path.join("content/display").symlink_metadata() {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string().into()),
        },
    };
    Ok(if segmented {
        UploadMeta::SegmentUpload {
            video_id: intent.video_id.clone(),
            pre_created_video: video,
            recording_dir: meta.project_path.clone(),
        }
    } else {
        UploadMeta::MultipartUpload {
            video_id: intent.video_id.clone(),
            pre_created_video: video,
            recording_dir: meta.project_path.clone(),
            file_path: meta.project_path.join("content/output.mp4"),
        }
    })
}

fn prepare_retry_state(
    directory: &Path,
    meta: &mut RecordingMeta,
    intent: &mut Intent,
    save_meta: impl FnOnce(&RecordingMeta) -> Result<(), String>,
) -> Result<(), AuthedApiError> {
    let reupload = matches!(meta.upload, Some(UploadMeta::Complete));
    if reupload {
        meta.upload = Some(pending_reupload(meta, intent)?);
        intent.verification = None;
        intent.receipt = None;
    }
    if upload_video_id(&meta.upload) != Some(intent.video_id.as_str()) {
        return Err("Recording retry identity changed".into());
    }
    intent.failures = 0;
    intent.needs_authentication = false;
    intent.retry_at = None;
    intent.error = None;
    write(directory, intent)?;
    if reupload {
        save_meta(meta)?;
    }
    Ok(())
}

pub(crate) fn reconcile_reupload(meta: &mut RecordingMeta) -> Result<(), AuthedApiError> {
    if !matches!(meta.upload, Some(UploadMeta::Complete))
        || !matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::Complete { .. }
            )
        )
    {
        return Ok(());
    }
    let Some(intent) = read(&meta.project_path)? else {
        return Ok(());
    };
    if intent.cancelled
        || !intent.local_ready
        || intent.verification.is_some()
        || intent.receipt.is_some()
    {
        return Ok(());
    }
    meta.upload = Some(pending_reupload(meta, &intent)?);
    meta.save_for_project().map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) async fn retry_existing(
    app: AppHandle,
    directory: &Path,
) -> Result<Option<String>, AuthedApiError> {
    if read(directory)?.is_none() {
        return Ok(None);
    }
    let lock = acquire_upload_lock(directory)?;
    let mut intent = read(directory)?.ok_or("Upload intent disappeared")?;
    if intent.cancelled || !intent.local_ready {
        return Err("This recording is not available for upload retry".into());
    }
    let context = UploadRequestContext::new(
        intent.server_url.clone(),
        intent
            .owner_id
            .clone()
            .ok_or(AuthedApiError::InvalidAuthentication)?,
    )?;
    context.check(&app).await?;
    let required_audio = intent
        .required_audio
        .ok_or("Recording audio intent is unknown")?;
    let mut meta = RecordingMeta::load_for_project(directory).map_err(|error| error.to_string())?;
    if !matches!(
        meta.inner,
        cap_project::RecordingMetaInner::Instant(
            cap_project::InstantRecordingMeta::Complete { .. }
        )
    ) {
        return Err("Recording must finish locally before retry".into());
    }
    let link = meta
        .sharing
        .as_ref()
        .map(|sharing| sharing.link.clone())
        .ok_or("Recording share identity is missing")?;
    prepare_retry_state(directory, &mut meta, &mut intent, |meta| {
        meta.save_for_project().map_err(|error| error.to_string())
    })?;
    let session = resume_existing(app, meta, lock, required_audio).await?;
    let mut terminal = session.terminal.subscribe();
    timeout(Duration::from_secs(30 * 60), async {
        loop {
            if let Some(result) = terminal.borrow_and_update().clone() {
                result.map_err(AuthedApiError::from)?;
                return Ok(Some(link));
            }
            terminal
                .changed()
                .await
                .map_err(|_| "Upload completion channel closed")?;
        }
    })
    .await
    .map_err(|_| AuthedApiError::VerificationPending)?
}

struct Job {
    session: Arc<Session>,
    handle: JoinHandle<()>,
}

static JOBS: std::sync::OnceLock<Mutex<HashMap<PathBuf, Job>>> = std::sync::OnceLock::new();
static PUMP: std::sync::OnceLock<Mutex<Option<JoinHandle<()>>>> = std::sync::OnceLock::new();
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
static STOPPING: AtomicBool = AtomicBool::new(false);

fn jobs() -> &'static Mutex<HashMap<PathBuf, Job>> {
    JOBS.get_or_init(Mutex::default)
}

pub(crate) fn has_capacity() -> bool {
    !STOPPING.load(Ordering::Acquire)
        && jobs().lock().unwrap_or_else(PoisonError::into_inner).len() < 2
}

pub(crate) async fn supervise<F>(
    app: AppHandle,
    session: Arc<Session>,
    work: F,
) -> Result<(), AuthedApiError>
where
    F: std::future::Future<Output = Result<(), AuthedApiError>> + Send + 'static,
{
    let mut work = Some(work);
    let registered = {
        let mut jobs = jobs().lock().unwrap_or_else(PoisonError::into_inner);
        if STOPPING.load(Ordering::Acquire) || jobs.contains_key(&session.directory) {
            false
        } else {
            let directory = session.directory.clone();
            let worker = session.clone();
            let context = session.context();
            let work = work.take().unwrap();
            let handle = spawn_actor(async move {
                let result = std::panic::AssertUnwindSafe(
                    worker.run(crate::web_api::inherit_upload_context(context, work)),
                )
                .catch_unwind()
                .await
                .unwrap_or_else(|_| Err("Upload worker failed; local recording retained".into()));
                worker
                    .terminal
                    .send_replace(Some(result.as_ref().copied().map_err(ToString::to_string)));
                if let Err(error) = result {
                    if !matches!(error, AuthedApiError::VerificationPending) {
                        crate::notifications::NotificationType::UploadFailed.send(&app);
                    }
                    worker.record_failure(&error);
                    warn!(%error, "Recording upload retained for retry");
                }
                emit_upload_complete(&app, &worker.video_id);
            });
            jobs.insert(
                directory,
                Job {
                    session: session.clone(),
                    handle,
                },
            );
            true
        }
    };
    if !registered {
        session.cancel();
        let result = session
            .run(crate::web_api::inherit_upload_context(
                session.context(),
                work.unwrap(),
            ))
            .await;
        session
            .terminal
            .send_replace(Some(result.as_ref().copied().map_err(ToString::to_string)));
        if let Err(error) = result {
            session.record_failure(&error);
        }
    }
    Ok(())
}

async fn join_job(job: Job) {
    if let Err(error) = job.handle.await {
        job.session.record_failure(&AuthedApiError::Other(format!(
            "Upload supervisor failed: {error}"
        )));
        warn!(%error, "Upload supervisor failed");
    }
}

pub(crate) async fn reap() {
    let completed = {
        let mut jobs = jobs().lock().unwrap_or_else(PoisonError::into_inner);
        let paths: Vec<_> = jobs
            .iter()
            .filter(|(_, job)| job.handle.is_finished())
            .map(|(path, _)| path.clone())
            .collect();
        paths
            .into_iter()
            .filter_map(|path| jobs.remove(&path))
            .collect::<Vec<_>>()
    };
    for job in completed {
        join_job(job).await;
    }
}

pub(crate) async fn cancel(directory: &Path) {
    let job = jobs()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(directory);
    if let Some(job) = job {
        job.session.mark_cancelled().ok();
        join_job(job).await;
    }
}

pub(crate) fn mark_cancelled(directory: &Path) -> Result<(), AuthedApiError> {
    if let Some(mut intent) = read(directory)? {
        intent.cancelled = true;
        intent.retry_at = None;
        write(directory, &intent)?;
    }
    Ok(())
}

pub(crate) fn init(app: AppHandle) {
    let mut pump = PUMP
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if pump.is_some() {
        return;
    }
    *pump = Some(spawn_actor(async move {
        let mut first = true;
        while !STOPPING.load(Ordering::Acquire) {
            if let Err(error) = crate::resume_uploads(app.clone(), first).await {
                warn!(%error, "Upload reconciliation failed; recordings retained");
            }
            first = false;
            tokio::select! {
                _ = WAKE.notified() => {},
                _ = tokio::time::sleep(Duration::from_secs(30)) => {},
            }
        }
    }));
}

pub(crate) async fn shutdown() {
    STOPPING.store(true, Ordering::Release);
    WAKE.notify_one();
    let pump = PUMP
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(pump) = pump {
        let _ = pump.await;
    }
    let owned = std::mem::take(&mut *jobs().lock().unwrap_or_else(PoisonError::into_inner));
    for job in owned.values() {
        job.session.cancel();
    }
    for (_, job) in owned {
        join_job(job).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, Arc<Session>) {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("retained-media"),
            b"original recording bytes",
        )
        .unwrap();
        write(
            directory.path(),
            &Intent {
                version: 1,
                video_id: "owned-video".into(),
                server_url: "https://example.invalid".into(),
                owner_id: Some("owner".into()),
                required_audio: Some(true),
                local_ready: false,
                cancelled: false,
                preserve_local: false,
                failures: 0,
                needs_authentication: false,
                retry_at: None,
                error: None,
                verification: None,
                receipt: None,
            },
        )
        .unwrap();
        RecordingMeta {
            platform: None,
            project_path: directory.path().to_path_buf(),
            pretty_name: "retained".into(),
            sharing: None,
            inner: cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: true },
            ),
            upload: None,
        }
        .save_for_project()
        .unwrap();
        let lock = UploadLock::acquire(directory.path()).unwrap();
        let session = Session::new(lock.project_path().to_path_buf(), "owned-video".into());
        session.adopt(lock).unwrap();
        (directory, session)
    }

    fn receipt(request: &UploadVerification) -> VerifiedUploadReceipt {
        VerifiedUploadReceipt {
            version: 1,
            video_id: "owned-video".into(),
            artifact: request.artifact.clone(),
            file_size: 4096,
            duration: 10.0,
            has_audio: true,
            full_decode: true,
            required_audio_verified: request.required_audio,
        }
    }

    #[tokio::test]
    async fn local_ready_releases_completion_gate_without_waiting_for_network() {
        let (directory, session) = project();
        let mut gate = Box::pin(session.wait_ready());
        assert!(futures::poll!(gate.as_mut()).is_pending());
        session.mark_ready(false).unwrap();
        gate.await.unwrap();
        let intent = read(directory.path()).unwrap().unwrap();
        assert!(intent.local_ready);
        assert!(intent.verification.is_none());
        assert!(intent.receipt.is_none());
        assert!(directory.path().join("retained-media").exists());
    }

    #[tokio::test]
    async fn cancellation_is_persisted_and_never_opens_completion_gate() {
        let (directory, session) = project();
        let mut gate = Box::pin(session.wait_ready());
        assert!(futures::poll!(gate.as_mut()).is_pending());
        session.mark_cancelled().unwrap();
        assert!(gate.await.is_err());
        assert!(read(directory.path()).unwrap().unwrap().cancelled);
        assert_eq!(
            std::fs::read(directory.path().join("retained-media")).unwrap(),
            b"original recording bytes"
        );
    }

    #[test]
    fn restart_preserves_identity_and_actual_audio_intent_with_exclusive_ownership() {
        let (directory, session) = project();
        session.mark_ready(false).unwrap();
        session.record_failure(&AuthedApiError::Timeout);
        assert!(matches!(
            UploadLock::acquire(directory.path()),
            Err(cap_recording::upload_resume::UploadLockError::Busy)
        ));
        drop(session);
        let lock = UploadLock::acquire(directory.path()).unwrap();
        let resumed = Session::new(lock.project_path().to_path_buf(), "owned-video".into());
        resumed.adopt(lock).unwrap();
        let intent = read(directory.path()).unwrap().unwrap();
        assert_eq!(intent.video_id, "owned-video");
        assert_eq!(intent.owner_id.as_deref(), Some("owner"));
        assert_eq!(intent.required_audio, Some(true));
        assert!(intent.local_ready);
        assert_eq!(intent.failures, 1);
        assert!(directory.path().join("retained-media").exists());
    }

    #[test]
    fn processing_and_authentication_do_not_exhaust_failed_transfer_budget() {
        let (directory, session) = project();
        for _ in 0..8 {
            session.record_failure(&AuthedApiError::VerificationPending);
        }
        assert_eq!(read(directory.path()).unwrap().unwrap().failures, 0);
        session.record_failure(&AuthedApiError::InvalidAuthentication);
        let intent = read(directory.path()).unwrap().unwrap();
        assert!(intent.needs_authentication);
        assert_eq!(intent.failures, 0);
        for _ in 0..5 {
            session.record_failure(&AuthedApiError::Timeout);
        }
        let intent = read(directory.path()).unwrap().unwrap();
        assert_eq!(intent.failures, 5);
        assert!(intent.retry_at.is_none());
        assert_eq!(intent.video_id, "owned-video");
        assert!(directory.path().join("retained-media").exists());
    }

    #[test]
    fn server_retransfer_clears_only_cached_evidence() {
        let (directory, session) = project();
        let request = UploadVerification::segments(b"manifest", true);
        session.set_verification(&request).unwrap();
        session
            .record_receipt(&request, &receipt(&request))
            .unwrap();
        session.clear_verification().unwrap();
        session.record_failure(&AuthedApiError::ReuploadRequired);
        let intent = read(directory.path()).unwrap().unwrap();
        assert!(intent.verification.is_none());
        assert!(intent.receipt.is_none());
        assert_eq!(intent.video_id, "owned-video");
        assert!(directory.path().join("retained-media").exists());
    }

    #[test]
    fn wrong_generation_or_probe_only_receipt_never_persists_completion() {
        let (directory, session) = project();
        let request = UploadVerification::segments(b"manifest", true);
        session.set_verification(&request).unwrap();
        for change in 0..5 {
            let mut invalid = receipt(&request);
            match change {
                0 => invalid.full_decode = false,
                1 => invalid.has_audio = false,
                2 => invalid.video_id = "other-video".into(),
                3 => invalid.required_audio_verified = false,
                _ => {
                    invalid.artifact =
                        UploadVerification::segments(b"other-manifest", true).artifact
                }
            }
            assert!(session.record_receipt(&request, &invalid).is_err());
            assert!(read(directory.path()).unwrap().unwrap().receipt.is_none());
        }
        assert!(directory.path().join("retained-media").exists());
    }

    #[test]
    fn unknown_legacy_upload_does_not_acquire_an_invented_sidecar() {
        let directory = tempfile::tempdir().unwrap();
        let lock = UploadLock::acquire(directory.path()).unwrap();
        let session = Session::new(lock.project_path().to_path_buf(), "legacy-video".into());
        session.adopt(lock).unwrap();
        session.record_failure(&AuthedApiError::Timeout);
        session.mark_ready(false).unwrap();
        assert!(read(directory.path()).unwrap().is_none());
    }

    #[tokio::test]
    async fn cancelled_job_retains_lock_until_its_worker_is_joined() {
        let (directory, session) = project();
        let (release, released) = tokio::sync::oneshot::channel();
        let worker = session.clone();
        let handle = tokio::spawn(async move {
            worker.cancelled().await;
            released.await.unwrap();
            assert!(worker.directory.join("retained-media").exists());
        });
        let job = Job {
            session: session.clone(),
            handle,
        };
        session.cancel();
        drop(session);
        let mut joined = Box::pin(join_job(job));
        assert!(futures::poll!(joined.as_mut()).is_pending());
        assert!(matches!(
            UploadLock::acquire(directory.path()),
            Err(cap_recording::upload_resume::UploadLockError::Busy)
        ));
        release.send(()).unwrap();
        joined.await;
        assert!(UploadLock::acquire(directory.path()).is_ok());
        assert!(directory.path().join("retained-media").exists());
    }

    #[cfg(unix)]
    #[test]
    fn upload_input_cannot_escape_through_a_parent_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("output.mp4"), b"private bytes").unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("content")).unwrap();
        let path = directory.path().join("content/output.mp4");
        assert!(verify_file_path(&path, &path).is_err());
        assert_eq!(
            std::fs::read(outside.path().join("output.mp4")).unwrap(),
            b"private bytes"
        );
    }
    #[test]
    fn legacy_mp4_proof_without_object_generation_retransfers_without_changing_identity() {
        let (directory, session) = project();
        let mut intent = read(directory.path()).unwrap().unwrap();
        intent.verification = Some(serde_json::from_value(serde_json::json!({"version":1,"artifact":{"kind":"mp4","fileSize":4096,"duration":10.0},"requiredAudio":true})).unwrap());
        write(directory.path(), &intent).unwrap();
        assert!(session.cached_verification().unwrap().is_none());
        let retained = read(directory.path()).unwrap().unwrap();
        assert!(retained.verification.is_none());
        assert!(retained.receipt.is_none());
        assert_eq!(retained.video_id, "owned-video");
        assert!(directory.path().join("retained-media").exists());
    }
    #[test]
    fn concurrent_local_save_and_upload_start_preserve_both_updates() {
        let (directory, session) = project();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker = session.clone();
        let upload_barrier = barrier.clone();
        let uploader = std::thread::spawn(move || {
            upload_barrier.wait();
            worker
                .persist_upload(UploadMeta::SinglePartUpload {
                    video_id: "owned-video".into(),
                    file_path: worker.directory.join("content/output.mp4"),
                    screenshot_path: worker.directory.join("screenshots/display.jpg"),
                    recording_dir: worker.directory.clone(),
                })
                .unwrap();
        });
        barrier.wait();
        session
            .persist_local_complete(
                cap_project::InstantRecordingMeta::Complete {
                    fps: 30,
                    sample_rate: Some(48000),
                },
                cap_project::SharingMeta {
                    id: "owned-video".into(),
                    link: "https://example.invalid/s/owned-video".into(),
                    content_hash: None,
                },
            )
            .unwrap();
        uploader.join().unwrap();
        let meta = RecordingMeta::load_for_project(directory.path()).unwrap();
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::Complete { .. }
            )
        ));
        assert_eq!(upload_video_id(&meta.upload), Some("owned-video"));
        assert_eq!(meta.sharing.unwrap().id, "owned-video");
        assert!(directory.path().join("retained-media").exists());
    }
    #[tokio::test]
    async fn cancellation_drops_inherited_request_future_without_authorizing_completion() {
        struct PendingRequest(Arc<AtomicBool>);
        impl Drop for PendingRequest {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let (_directory, session) = project();
        let dropped = Arc::new(AtomicBool::new(false));
        let completed = Arc::new(AtomicBool::new(false));
        let (entered, started) = tokio::sync::oneshot::channel();
        let worker = session.clone();
        let request_dropped = dropped.clone();
        let completion = completed.clone();
        let task = tokio::spawn(async move {
            worker
                .run(async move {
                    let task =
                        tokio::spawn(crate::web_api::inherit_upload_context(None, async move {
                            let _request = PendingRequest(request_dropped);
                            entered.send(()).unwrap();
                            cancellable(std::future::pending::<()>()).await?;
                            completion.store(true, Ordering::Release);
                            Ok::<_, AuthedApiError>(())
                        }));
                    task.await.unwrap()
                })
                .await
        });
        started.await.unwrap();
        session.cancel();
        assert!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(dropped.load(Ordering::Acquire));
        assert!(!completed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn cancelled_filesystem_future_keeps_ownership_until_real_read_finishes() {
        let (directory, session) = project();
        let (entered, started) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let closed = Arc::new(AtomicBool::new(false));
        let finished = closed.clone();
        let path = directory.path().join("retained-media");
        let worker = session.clone();
        let mut task = tokio::spawn(async move {
            worker
                .run(file_io(move || {
                    use std::io::Read;
                    let mut file = std::fs::File::open(path)?;
                    entered.send(()).unwrap();
                    released.recv_timeout(Duration::from_secs(2)).unwrap();
                    let mut bytes = Vec::new();
                    file.read_to_end(&mut bytes)?;
                    drop(file);
                    finished.store(true, Ordering::Release);
                    Ok(bytes)
                }))
                .await
        });
        started.await.unwrap();
        session.cancel();
        assert!(futures::poll!(&mut task).is_pending());
        assert!(!closed.load(Ordering::Acquire));
        assert!(matches!(
            UploadLock::acquire(directory.path()),
            Err(cap_recording::upload_resume::UploadLockError::Busy)
        ));
        release.send(()).unwrap();
        assert!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(closed.load(Ordering::Acquire));
        assert_eq!(session.reads.active.load(Ordering::Acquire), 0);
        drop(session);
        assert!(UploadLock::acquire(directory.path()).is_ok());
    }

    #[tokio::test]
    async fn cancellation_closes_progressive_reader_without_waiting_for_recording_done() {
        let (directory, session) = project();
        let path = directory.path().join("retained-media");
        let (done, receiver) = flume::bounded(1);
        let worker = session.clone();
        let task = tokio::spawn(async move {
            worker
                .run(
                    super::super::from_pending_file_to_chunks(path, Some(receiver))
                        .try_collect::<Vec<_>>(),
                )
                .await
        });
        timeout(Duration::from_secs(2), async {
            while session.reads.active.load(Ordering::Acquire) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        session.cancel();
        assert!(
            timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert_eq!(session.reads.active.load(Ordering::Acquire), 0);
        assert!(done.is_disconnected());
        assert_eq!(
            std::fs::read(directory.path().join("retained-media")).unwrap(),
            b"original recording bytes"
        );
    }
    fn completed_retry_fixture(
        directory: &Path,
        session: &Session,
        segmented: bool,
    ) -> (RecordingMeta, Intent) {
        session
            .persist_local_complete(
                cap_project::InstantRecordingMeta::Complete {
                    fps: 30,
                    sample_rate: Some(48000),
                },
                cap_project::SharingMeta {
                    id: "owned-video".into(),
                    link: "https://example.invalid/s/owned-video".into(),
                    content_hash: None,
                },
            )
            .unwrap();
        session.mark_ready(false).unwrap();
        let request = if segmented {
            std::fs::create_dir_all(directory.join("content/display")).unwrap();
            UploadVerification::segments(b"manifest", true)
        } else {
            UploadVerification::mp4(4096, 10.0, true, "\"old-object\"".into()).unwrap()
        };
        session.set_verification(&request).unwrap();
        session
            .record_receipt(&request, &receipt(&request))
            .unwrap();
        let mut meta = RecordingMeta::load_for_project(directory).unwrap();
        meta.upload = Some(UploadMeta::Complete);
        meta.save_for_project().unwrap();
        (meta, read(directory).unwrap().unwrap())
    }

    #[test]
    fn explicit_reupload_reuses_original_identity_and_clears_completed_proof() {
        for segmented in [false, true] {
            let (directory, session) = project();
            let (mut meta, mut intent) =
                completed_retry_fixture(directory.path(), &session, segmented);
            prepare_retry_state(directory.path(), &mut meta, &mut intent, |meta| {
                meta.save_for_project().map_err(|error| error.to_string())
            })
            .unwrap();
            let pending = RecordingMeta::load_for_project(directory.path()).unwrap();
            assert_eq!(upload_video_id(&pending.upload), Some("owned-video"));
            assert_eq!(
                matches!(pending.upload, Some(UploadMeta::SegmentUpload { .. })),
                segmented
            );
            let retained = read(directory.path()).unwrap().unwrap();
            assert!(retained.verification.is_none());
            assert!(retained.receipt.is_none());
            assert_eq!(retained.owner_id.as_deref(), Some("owner"));
            assert!(directory.path().join("retained-media").exists());
        }
    }

    #[test]
    fn interrupted_reupload_metadata_write_remains_recoverable_without_stale_proof() {
        for segmented in [false, true] {
            let (directory, session) = project();
            let (mut meta, mut intent) =
                completed_retry_fixture(directory.path(), &session, segmented);
            assert!(
                prepare_retry_state(directory.path(), &mut meta, &mut intent, |_| Err(
                    "injected metadata replacement failure".into()
                ))
                .is_err()
            );
            let mut original = RecordingMeta::load_for_project(directory.path()).unwrap();
            assert!(matches!(original.upload, Some(UploadMeta::Complete)));
            assert!(
                read(directory.path())
                    .unwrap()
                    .unwrap()
                    .verification
                    .is_none()
            );
            reconcile_reupload(&mut original).unwrap();
            assert_eq!(upload_video_id(&original.upload), Some("owned-video"));
            assert_eq!(
                matches!(original.upload, Some(UploadMeta::SegmentUpload { .. })),
                segmented
            );
            assert!(directory.path().join("retained-media").exists());
        }
    }
}
