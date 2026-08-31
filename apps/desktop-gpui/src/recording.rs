//! Recording, through the same engine the Tauri app drives.
//!
//! The construction here mirrors `apps/desktop/src-tauri/src/recording.rs`
//! (`start_recording`): spawn the feed actors, lock the selected devices,
//! acquire ScreenCaptureKit shareable content, then hand everything to the
//! studio/instant actor builder from `cap-recording`. Everything in this module
//! runs on the tokio runtime (`gpui_tokio`), never on gpui's main thread --
//! kameo actors and the capture pipeline both assume tokio.

use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, anyhow};
use cap_recording::{
    feeds::{camera, camera::CameraFeed, microphone, microphone::MicrophoneFeed},
    instant_recording,
    sources::screen_capture::ScreenCaptureTarget,
    studio_recording,
};
#[cfg(any(target_os = "linux", windows))]
use futures_util::FutureExt as _;
use kameo::{Actor, actor::ActorRef};

pub use cap_recording::feeds::camera::DeviceOrModelID;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingMode {
    Studio,
    Instant,
}

/// Everything `start` needs, captured from UI state up front so the future is
/// `'static` and owns its inputs. `Clone` because the session keeps the last
/// config around for the bar's restart button.
#[derive(Clone)]
pub struct StartConfig {
    pub mode: RecordingMode,
    pub target: ScreenCaptureTarget,
    /// Microphone by name -- the identity `MicrophoneFeed` keys on.
    pub microphone: Option<String>,
    pub camera: Option<DeviceOrModelID>,
    pub device_settings: crate::store::RecordingDeviceSettings,
    pub input_readiness: crate::feeds::InputReadiness,
    pub system_audio: bool,
    /// Our own windows (the recording controls bar; the camera bubble in studio
    /// mode), excluded from capture the way the Tauri app excludes them.
    pub excluded_windows: Vec<scap_targets::WindowId>,
    /// The app-scoped feed actors (running previews/meters). When present a
    /// recording locks these instead of spawning its own -- the Tauri model.
    pub camera_feed: Option<ActorRef<CameraFeed>>,
    pub mic_feed: Option<ActorRef<MicrophoneFeed>>,
    #[cfg(target_os = "linux")]
    pub linux_instant_camera: Option<LinuxInstantCameraRequest>,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub struct LinuxInstantCameraRequest {
    pub presentation: instant_recording::LinuxCameraPresentation,
    pub reference_size: (u32, u32),
    pub effects: instant_recording::LinuxCameraProcessing,
    pub processing: crate::feeds::CameraProcessingFactory,
}

#[cfg_attr(target_os = "linux", derive(Clone))]
enum Handle {
    // Studio's handle is `Clone`; instant's is not, so it rides in an `Arc`.
    // Both give the owned handles pause/resume need for `'static` futures.
    Studio(studio_recording::ActorHandle),
    Instant(Arc<instant_recording::ActorHandle>),
}

type SharedInstantUpload = Arc<tokio::sync::Mutex<Option<crate::upload::InstantUpload>>>;

/// A live recording. Stopping consumes it; dropping it without stopping leaves
/// the actors to wind down on their own when the refs go away.
#[cfg_attr(target_os = "linux", derive(Clone))]
pub struct ActiveRecording {
    handle: Handle,
    pub project_dir: PathBuf,
    instant_upload: Option<SharedInstantUpload>,
    instant_share_link: Option<String>,
    #[cfg(target_os = "linux")]
    instant_completion: Option<crate::upload::CompletionControl>,
    #[cfg(target_os = "linux")]
    instant_operation: Arc<tokio::sync::Mutex<()>>,
    /// Recording-scoped mic mute (payload zeroing at the consumer seam; the
    /// stream cadence is unaffected). `None` when the recording has no mic.
    pub mic_mute: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    // Held for the duration of the recording: dropping an ActorRef early would
    // stop the feed under the pipeline. Only populated by the per-recording
    // fallback path; app-scoped feeds are owned by `Feeds`.
    _mic_feed: Option<ActorRef<MicrophoneFeed>>,
    _camera_feed: Option<ActorRef<CameraFeed>>,
    // The mic error channel must outlive the stream or error sends panic the
    // sender side into logs; we keep it and drain nothing.
    _mic_errors: Option<flume::Receiver<cpal::StreamError>>,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub(crate) struct InstantAttempt(Arc<InstantAttemptInner>);

#[cfg(target_os = "linux")]
struct InstantAttemptInner {
    lifecycle: Mutex<Option<instant_recording::InstantLifecycle>>,
    cancelled: tokio::sync::watch::Sender<bool>,
    startup: tokio::sync::watch::Sender<StartupState>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StartupState {
    Unstarted,
    Running,
    Finished,
    Unconfirmed,
}

#[cfg(target_os = "linux")]
impl InstantAttempt {
    pub fn new() -> Self {
        Self(Arc::new(InstantAttemptInner {
            lifecycle: Mutex::new(None),
            cancelled: tokio::sync::watch::channel(false).0,
            startup: tokio::sync::watch::channel(StartupState::Unstarted).0,
        }))
    }

    pub fn cancel(&self) {
        self.0.cancelled.send_replace(true);
        self.0.startup.send_if_modified(|state| {
            if *state == StartupState::Unstarted {
                *state = StartupState::Finished;
                true
            } else {
                false
            }
        });
        if let Some(lifecycle) = self.0.lifecycle.lock().unwrap().as_ref() {
            lifecycle.cancel();
        }
    }

    fn attach(&self, lifecycle: instant_recording::InstantLifecycle) -> anyhow::Result<()> {
        let mut current = self.0.lifecycle.lock().unwrap();
        anyhow::ensure!(
            current.is_none(),
            "An Instant attempt cannot replace its capture lifecycle"
        );
        if *self.0.cancelled.borrow() {
            lifecycle.cancel();
        }
        *current = Some(lifecycle);
        Ok(())
    }

    pub fn quiescence(&self) -> instant_recording::InstantQuiescence {
        use instant_recording::InstantQuiescence;
        match *self.0.startup.borrow() {
            StartupState::Unconfirmed => InstantQuiescence::Unconfirmed,
            StartupState::Unstarted | StartupState::Running => InstantQuiescence::Pending,
            StartupState::Finished => self.0.lifecycle.lock().unwrap().as_ref().map_or(
                InstantQuiescence::Joined,
                instant_recording::InstantLifecycle::quiescence,
            ),
        }
    }

    pub async fn wait_for_quiescence(&self) -> instant_recording::InstantQuiescence {
        let mut startup = self.0.startup.subscribe();
        loop {
            let state = *startup.borrow_and_update();
            match state {
                StartupState::Unconfirmed => {
                    return instant_recording::InstantQuiescence::Unconfirmed;
                }
                StartupState::Finished => break,
                _ => {}
            }
            if startup.changed().await.is_err() {
                return instant_recording::InstantQuiescence::Unconfirmed;
            }
        }
        let lifecycle = self.0.lifecycle.lock().unwrap().clone();
        match lifecycle {
            Some(lifecycle) => lifecycle.wait_for_quiescence().await,
            None => instant_recording::InstantQuiescence::Joined,
        }
    }

    async fn cancelled(&self) {
        let mut cancelled = self.0.cancelled.subscribe();
        loop {
            let requested = *cancelled.borrow_and_update();
            if requested || cancelled.changed().await.is_err() {
                break;
            }
        }
    }
}

#[cfg(target_os = "linux")]
struct StartupWaiter {
    attempt: InstantAttempt,
    armed: bool,
}
#[cfg(target_os = "linux")]
impl Drop for StartupWaiter {
    fn drop(&mut self) {
        if self.armed {
            self.attempt.cancel();
        }
    }
}

#[cfg(target_os = "linux")]
struct StartupCompletion {
    attempt: InstantAttempt,
    armed: bool,
}
#[cfg(target_os = "linux")]
impl Drop for StartupCompletion {
    fn drop(&mut self) {
        if self.armed {
            self.attempt.cancel();
            self.attempt
                .0
                .startup
                .send_replace(StartupState::Unconfirmed);
        }
    }
}

#[cfg(target_os = "linux")]
fn owned_instant_start<T, F>(
    attempt: InstantAttempt,
    build: impl Future<Output = anyhow::Result<T>> + Send + 'static,
    cleanup: impl Fn(T) -> F + Send + 'static,
) -> impl Future<Output = anyhow::Result<T>> + Send
where
    T: Send + 'static,
    F: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    let waiter = StartupWaiter {
        attempt: attempt.clone(),
        armed: true,
    };
    async move {
        let mut waiter = waiter;
        if *attempt.0.cancelled.borrow() {
            anyhow::bail!("Recording startup cancelled");
        }
        let mut started = false;
        attempt.0.startup.send_if_modified(|state| {
            if *state == StartupState::Unstarted {
                *state = StartupState::Running;
                started = true;
                true
            } else {
                false
            }
        });
        if !started {
            waiter.armed = false;
            drop(waiter);
            anyhow::bail!("Instant startup attempt was already used or cancelled");
        }
        let completion = StartupCompletion {
            attempt: attempt.clone(),
            armed: true,
        };
        let (sender, receiver) = tokio::sync::oneshot::channel();
        drop(tokio::spawn(async move {
            let mut completion = completion;
            let result = tokio::select! {
                biased;
                _ = attempt.cancelled() => Err(anyhow!("Recording startup cancelled")),
                result = std::panic::AssertUnwindSafe(build).catch_unwind() => {
                    match result {
                        Ok(result) => result,
                        Err(_) => {
                            attempt.0.startup.send_replace(StartupState::Unconfirmed);
                            Err(anyhow!("Recording startup panicked; cleanup is unconfirmed"))
                        }
                    }
                }
            };
            let cancelled = *attempt.0.cancelled.borrow();
            let result = match result {
                Ok(active) if cancelled => {
                    let _ = cleanup(active).await;
                    Err(anyhow!(
                        "Recording startup cancelled; local files preserved"
                    ))
                }
                result => result,
            };
            if result.is_err() {
                attempt.cancel();
                let lifecycle = attempt.0.lifecycle.lock().unwrap().clone();
                if let Some(lifecycle) = lifecycle {
                    lifecycle.wait_for_quiescence().await;
                }
            }
            if let Err(Ok(active)) = sender.send(result) {
                let _ = cleanup(active).await;
            }
            attempt.0.startup.send_if_modified(|state| {
                if *state == StartupState::Unconfirmed {
                    false
                } else {
                    *state = StartupState::Finished;
                    true
                }
            });
            completion.armed = false;
            drop(completion);
        }));
        let result = receiver
            .await
            .context("Recording startup acknowledgement lost")?;
        waiter.armed = false;
        drop(waiter);
        result
    }
}

#[cfg(target_os = "linux")]
fn owned_instant_operation(
    operation: impl Future<Output = (bool, anyhow::Result<PathBuf>)> + Send + 'static,
    cancel: impl Fn() + Send + 'static,
) -> CaptureStopFuture {
    let waiter = InstantOperationWaiter {
        cancel: Box::new(cancel),
        armed: true,
    };
    Box::pin(async move {
        let mut waiter = waiter;
        let result = match tokio::spawn(operation).await {
            Ok(result) => result,
            Err(error) => (false, Err(anyhow!("Instant cleanup task failed: {error}"))),
        };
        if result.1.is_err() {
            (waiter.cancel)();
        }
        waiter.armed = false;
        drop(waiter);
        result
    })
}

#[cfg(target_os = "linux")]
struct InstantOperationWaiter {
    cancel: Box<dyn Fn() + Send>,
    armed: bool,
}
#[cfg(target_os = "linux")]
impl Drop for InstantOperationWaiter {
    fn drop(&mut self) {
        if self.armed {
            (self.cancel)();
        }
    }
}

#[cfg(target_os = "linux")]
async fn joined_instant_result<T>(
    lifecycle: instant_recording::InstantLifecycle,
    operation: impl Future<Output = anyhow::Result<T>>,
) -> (bool, anyhow::Result<T>) {
    run_instant_operation(
        operation,
        || lifecycle.cancel(),
        lifecycle.wait_for_quiescence(),
    )
    .await
}

#[cfg(target_os = "linux")]
async fn run_instant_operation<T>(
    operation: impl Future<Output = anyhow::Result<T>>,
    cancel: impl FnOnce(),
    quiescence: impl Future<Output = instant_recording::InstantQuiescence>,
) -> (bool, anyhow::Result<T>) {
    let result = std::panic::AssertUnwindSafe(operation)
        .catch_unwind()
        .await
        .unwrap_or_else(|_| Err(anyhow!("Instant operation panicked")));
    if result.is_err() {
        cancel();
    }
    let joined = quiescence.await == instant_recording::InstantQuiescence::Joined;
    if !joined {
        return (
            false,
            Err(anyhow!(
                "Instant capture cleanup is unconfirmed; local files preserved"
            )),
        );
    }
    (true, result)
}

async fn finalize_studio(
    completed: studio_recording::CompletedRecording,
    capture_target: ScreenCaptureTarget,
) -> anyhow::Result<PathBuf> {
    let project_path = completed.project_path.clone();
    let needs_remux = matches!(
        completed.meta.status(),
        cap_project::StudioRecordingStatus::NeedsRemux
    );
    tokio::task::spawn_blocking(move || {
        if needs_remux {
            ensure_finalization_storage(&project_path)?;
        }
        cap_recording::recovery::RecoveryManager::remux_if_needed(&project_path)
            .map_err(anyhow::Error::from)
    })
    .await
    .context("studio finalize task")?
    .context("studio finalize")?;

    // Everything `handle_recording_finish` does after the remux,
    // in its order: the first-frame JPEG the library's card is
    // drawn from, then the camera preview's blur toggle copied
    // into the project's configuration. Neither is fatal to a
    // recording that is already on disk, so both only warn.
    let project_path = completed.project_path.clone();
    tokio::task::spawn_blocking(move || {
        if let Some(display_path) = studio_display_path(&project_path) {
            write_bundle_thumbnail(&project_path, &display_path);
        }
        apply_camera_blur_to_project_config(&project_path, current_camera_blur());
        let library = serde_json::from_value(serde_json::Value::Object(
            crate::store::store_section("animated_gradients"),
        ))
        .unwrap_or_default();
        apply_animated_gradient_to_project_config(&project_path, &capture_target, &library);
    })
    .await
    .context("studio post-finalize task")?;

    Ok(completed.project_path)
}

#[cfg(target_os = "linux")]
async fn finish_studio_after_join<T, F>(
    stop: impl Future<Output = studio_recording::StudioStopReport>,
    finish: impl FnOnce(studio_recording::CompletedRecording) -> F,
) -> (bool, anyhow::Result<T>)
where
    F: Future<Output = anyhow::Result<T>>,
{
    let report = stop.await;
    if !report.accepted_intent {
        return (
            false,
            Err(anyhow!("Another Studio terminal action owns cleanup")),
        );
    }
    if report.quiescence != studio_recording::StudioQuiescence::Joined {
        return (false, Err(anyhow!("Studio capture cleanup is unconfirmed")));
    }
    let result = match report.result {
        Ok(completed) => std::panic::AssertUnwindSafe(finish(completed))
            .catch_unwind()
            .await
            .unwrap_or_else(|_| {
                Err(anyhow!(
                    "Studio finalization task panicked after capture stopped"
                ))
            }),
        Err(error) => Err(anyhow!(error)),
    };
    (true, result)
}

#[cfg(any(windows, all(target_os = "linux", test)))]
async fn finish_after_capture_stop<T, F>(
    stop: impl Future<Output = anyhow::Result<T>>,
    finalize: impl FnOnce(T) -> F,
) -> (bool, anyhow::Result<PathBuf>)
where
    F: Future<Output = anyhow::Result<PathBuf>>,
{
    match stop.await {
        Ok(completed) => {
            let result = std::panic::AssertUnwindSafe(finalize(completed))
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(anyhow!(
                        "Studio finalization task panicked after capture stopped"
                    ))
                });
            (true, result)
        }
        Err(error) => (false, Err(error)),
    }
}

pub(crate) type CaptureStopFuture =
    std::pin::Pin<Box<dyn Future<Output = (bool, anyhow::Result<PathBuf>)> + Send>>;

#[cfg(any(windows, test))]
async fn finish_windows_startup_setup<T>(
    setup: anyhow::Result<T>,
    cancel: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<T> {
    match setup {
        Ok(output) => Ok(output),
        Err(error) => match cancel.await {
            Ok(()) => Err(error),
            Err(cleanup) => Err(error.context(format!(
                "Windows startup cleanup failed: {cleanup:#}; partial recording preserved"
            ))),
        },
    }
}

#[cfg(any(target_os = "macos", windows, test))]
async fn finish_failed_capture(
    stop: impl Future<Output = anyhow::Result<()>>,
    persist_stopped: impl FnOnce() -> anyhow::Result<()>,
) -> (bool, anyhow::Result<PathBuf>) {
    if let Err(error) = stop.await {
        return (
            false,
            Err(error.context("Failed capture shutdown is unconfirmed; local files preserved")),
        );
    }
    if let Err(error) = persist_stopped() {
        return (
            true,
            Err(error.context(
                "Capture stopped, but stopped metadata could not be saved; local files preserved",
            )),
        );
    }
    (
        true,
        Err(anyhow!("Recording pipeline failed; local files preserved")),
    )
}

impl ActiveRecording {
    pub fn done_fut(&self) -> cap_recording::DoneFut {
        match &self.handle {
            Handle::Studio(handle) => handle.done_fut(),
            Handle::Instant(handle) => handle.done_fut(),
        }
    }

    pub fn instant_share_url(&self) -> Option<&str> {
        self.instant_share_link.as_deref()
    }

    /// Stop and finalize. Returns the project directory.
    ///
    /// Finalization mirrors the CLI's `finalize_completed`: studio projects get
    /// `RecoveryManager::remux_if_needed` (fragmented segments -> playable
    /// mp4s), instant projects get their DASH segments muxed into
    /// `content/output.mp4` plus a `recording-meta.json`/`project-config.json`
    /// pair so the library and share flows recognize the project.
    /// An owned future pausing the recording; `'static` so the session can
    /// spawn it on tokio without borrowing itself.
    pub fn pause_handle(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> {
        match &self.handle {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.pause().await })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.pause().await })
            }
        }
    }

    /// Owned resume future; see [`Self::pause_handle`].
    pub fn resume_handle(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send>> {
        match &self.handle {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.resume().await })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.resume().await })
            }
        }
    }

    pub fn is_paused_handle(
        &self,
    ) -> std::pin::Pin<Box<dyn Future<Output = anyhow::Result<bool>> + Send>> {
        match &self.handle {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.is_paused().await })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.is_paused().await })
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub fn clean_studio_stop_handle(&self) -> Option<CaptureStopFuture> {
        let Handle::Studio(handle) = &self.handle else {
            return None;
        };
        let handle = handle.clone();
        Some(Box::pin(async move {
            let capture_target = handle.capture_target.clone();
            finish_studio_after_join(handle.stop_with_report(), |completed| {
                finalize_studio(completed, capture_target)
            })
            .await
        }))
    }

    #[cfg(windows)]
    pub fn clean_windows_studio_stop_handle(&self) -> Option<CaptureStopFuture> {
        let Handle::Studio(handle) = &self.handle else {
            return None;
        };
        let handle = handle.clone();
        Some(Box::pin(async move {
            let capture_target = handle.capture_target.clone();
            finish_after_capture_stop(handle.stop(), |completed| {
                finalize_studio(completed, capture_target)
            })
            .await
        }))
    }

    #[cfg(windows)]
    pub fn windows_studio_delete_handle(&self) -> Option<CaptureStopFuture> {
        let Handle::Studio(handle) = &self.handle else {
            return None;
        };
        let handle = handle.clone();
        let directory = self.project_dir.clone();
        Some(Box::pin(async move {
            let report = handle
                .stop_with_intent(studio_recording::StudioStopIntent::Discard)
                .await;
            if !report.accepted_intent || !report.stop_acknowledged {
                return (
                    false,
                    Err(anyhow!(
                        "Studio discard stop is unconfirmed; local files preserved"
                    )),
                );
            }
            if let Err(error) = report.result {
                return (false, Err(anyhow!(error)));
            }
            let output = directory.clone();
            let result = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&directory))
                .await
                .context("Studio discard task failed")
                .and_then(|result| result.map_err(anyhow::Error::from));
            (true, result.map(|_| output))
        }))
    }

    #[cfg(target_os = "linux")]
    pub fn instant_lifecycle(&self) -> Option<instant_recording::InstantLifecycle> {
        match &self.handle {
            Handle::Instant(handle) => Some(handle.lifecycle()),
            _ => None,
        }
    }

    #[cfg(target_os = "linux")]
    pub fn instant_stop_handle(
        &self,
        preserve_local: bool,
        failed: bool,
    ) -> Option<CaptureStopFuture> {
        let lifecycle = self.instant_lifecycle()?;
        let active = self.clone();
        let cancel = active.instant_cancellation();
        Some(owned_instant_operation(
            async move {
                if failed {
                    joined_instant_result(lifecycle, async move {
                        active.cancel_preserving().await?;
                        Err(anyhow!("Recording pipeline failed; local files preserved"))
                    })
                    .await
                } else {
                    joined_instant_result(lifecycle, active.stop(preserve_local)).await
                }
            },
            cancel,
        ))
    }

    #[cfg(target_os = "linux")]
    fn instant_cancellation(&self) -> impl Fn() + Send + 'static {
        let lifecycle = self.instant_lifecycle();
        let completion = self.instant_completion.clone();
        move || {
            if let Some(completion) = &completion {
                completion.deny();
            }
            if let Some(lifecycle) = &lifecycle {
                lifecycle.cancel();
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub fn instant_delete_handle(&self) -> Option<CaptureStopFuture> {
        let lifecycle = self.instant_lifecycle()?;
        let active = self.clone();
        let directory = self.project_dir.clone();
        let cancel = active.instant_cancellation();
        Some(owned_instant_operation(
            async move {
                joined_instant_result(lifecycle, async move {
                    active.cancel_and_delete().await?;
                    Ok(directory)
                })
                .await
            },
            cancel,
        ))
    }

    #[cfg(any(target_os = "macos", windows))]
    pub(crate) fn failed_stop_handle(&self) -> CaptureStopFuture {
        let stop: futures_util::future::BoxFuture<'static, anyhow::Result<()>> = match &self.handle
        {
            Handle::Studio(handle) => {
                let handle = handle.clone();
                Box::pin(async move { handle.stop().await.map(|_| ()) })
            }
            Handle::Instant(handle) => {
                let handle = handle.clone();
                #[cfg(windows)]
                {
                    Box::pin(async move { handle.cancel().await })
                }
                #[cfg(target_os = "macos")]
                {
                    Box::pin(async move { handle.stop().await.map(|_| ()) })
                }
            }
        };
        let upload = self.instant_upload.clone();
        let directory = self.project_dir.clone();
        Box::pin(async move {
            let mut upload_guard = match &upload {
                Some(upload) => Some(upload.lock().await),
                None => None,
            };
            let mut upload = upload_guard.as_deref_mut().and_then(Option::as_mut);
            if let Some(upload) = upload.as_mut() {
                upload.abort_segments().await;
            }
            finish_failed_capture(stop, || {
                if let Some(upload) = upload.as_ref() {
                    mark_instant_recording_stopped(&directory, upload.metadata_lock())?;
                }
                Ok(())
            })
            .await
        })
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn cancel_preserving(self) -> anyhow::Result<()> {
        if let Some(completion) = &self.instant_completion {
            completion.deny();
        }
        let _operation = self.instant_operation.lock().await;
        if let Handle::Studio(handle) = &self.handle {
            return handle.cancel().await;
        }
        let lifecycle = self
            .instant_lifecycle()
            .context("Instant lifecycle missing")?;
        let Handle::Instant(handle) = &self.handle else {
            unreachable!()
        };
        let (joined, result) = joined_instant_result(lifecycle, handle.cancel()).await;
        if let Some(upload) = &self.instant_upload
            && let Some(upload) = upload.lock().await.as_mut()
        {
            upload.abort_segments().await;
            return persist_preserved_instant_stop(
                &self.project_dir,
                Some(upload.metadata_lock()),
                joined,
                result,
            );
        }
        persist_preserved_instant_stop(&self.project_dir, None, joined, result)
    }

    /// Cancel without finalizing and delete the project directory -- the
    /// delete and restart flows. Deleting a directory this app just created is
    /// app behavior, same as the Tauri delete button.
    pub async fn cancel_and_delete(self) -> anyhow::Result<()> {
        #[cfg(target_os = "linux")]
        if let Some(completion) = &self.instant_completion {
            completion.deny();
        }
        #[cfg(target_os = "linux")]
        let _operation = self.instant_operation.lock().await;
        let result = match &self.handle {
            Handle::Studio(handle) => {
                #[cfg(windows)]
                {
                    let report = handle
                        .stop_with_intent(studio_recording::StudioStopIntent::Discard)
                        .await;
                    if !report.accepted_intent || !report.stop_acknowledged {
                        return Err(anyhow!(
                            "Studio discard is unconfirmed; local files preserved"
                        ));
                    }
                    report.result.map(|_| ()).map_err(anyhow::Error::msg)
                }
                #[cfg(not(windows))]
                handle.cancel().await
            }
            Handle::Instant(handle) => {
                #[cfg(target_os = "linux")]
                {
                    let (_, result) =
                        joined_instant_result(handle.lifecycle(), handle.cancel()).await;
                    result
                }
                #[cfg(not(target_os = "linux"))]
                {
                    handle.cancel().await
                }
            }
        };
        if let Err(error) = result {
            if let Some(upload) = &self.instant_upload
                && let Some(upload) = upload.lock().await.as_mut()
            {
                upload.abort_segments().await;
            }
            return Err(error);
        }
        let mut upload = match self.instant_upload.as_ref() {
            Some(upload) => upload.lock().await.take(),
            None => None,
        };
        let remote_result = if let Some(upload) = upload.as_mut() {
            upload.cancel().await
        } else {
            Ok(())
        };
        remote_result.map_err(anyhow::Error::msg)?;
        tokio::task::spawn_blocking({
            let dir = self.project_dir.clone();
            move || std::fs::remove_dir_all(&dir)
        })
        .await
        .context("delete task")?
        .with_context(|| format!("deleting {}", self.project_dir.display()))?;
        Ok(())
    }

    pub async fn stop(self, preserve_local: bool) -> anyhow::Result<PathBuf> {
        #[cfg(target_os = "linux")]
        let _operation = self.instant_operation.lock().await;
        let mut upload_guard = match self.instant_upload.as_ref() {
            Some(upload) => Some(upload.lock().await),
            None => None,
        };
        let mut instant_upload = upload_guard.as_deref_mut().and_then(Option::as_mut);
        match self.handle {
            Handle::Studio(handle) => {
                let capture_target = handle.capture_target.clone();
                let completed = handle.stop().await?;
                finalize_studio(completed, capture_target).await
            }
            Handle::Instant(handle) => {
                let result = async {
                    #[cfg(target_os = "linux")]
                    let stopped = {
                        let (joined, result) = joined_instant_result(handle.lifecycle(), handle.stop()).await;
                        anyhow::ensure!(joined, "Instant capture cleanup is unconfirmed; local files preserved");
                        result
                    };
                    #[cfg(not(target_os = "linux"))]
                    let stopped = handle.stop().await;
                    let metadata_result = match instant_upload.as_ref() {
                        Some(upload) => {
                            mark_instant_recording_stopped(&self.project_dir, upload.metadata_lock())
                        }
                        None => Err(anyhow!("instant recording has no upload session")),
                    };
                    if let Err(error) = &metadata_result {
                        tracing::warn!(%error, "Could not mark the instant recording as stopped");
                    }
                    let mut completed = stopped?;
                    metadata_result?;
                    let project_path = completed.project_path.clone();
                    let upload = instant_upload
                        .as_mut()
                        .ok_or_else(|| anyhow!("instant recording has no upload session"))?;

                    let display_dir = project_path.join("content/display");
                    let audio_dir = project_path.join("content/audio");
                    let output_path = project_path.join("content/output.mp4");
                    let completion = completed.clean_completion.take();
                    if display_dir.is_dir() {
                        let muxed = output_path.clone();
                        let project_path = project_path.clone();
                        tokio::task::spawn_blocking(move || {
                            ensure_finalization_storage(&project_path)?;
                            match completion {
                                Some(completion) => cap_recording::recovery::RecoveryManager::finalize_completed_instant_output(
                                    &display_dir,
                                    &audio_dir,
                                    &muxed,
                                    completion,
                                ),
                                None => cap_recording::recovery::RecoveryManager::finalize_instant_output(
                                    &display_dir,
                                    &audio_dir,
                                    &muxed,
                                ),
                            }
                            .map_err(anyhow::Error::from)
                        })
                        .await
                        .context("instant finalize task")?
                        .context("instant finalize")?;
                    } else if !output_path.is_file() {
                        return Err(anyhow!("instant recording has no finalized output"));
                    }

                    persist_instant_meta(&completed, upload.video(), upload.metadata_lock())?;

                    // The Tauri app builds the instant thumbnail by concatenating
                    // `content/display`'s init segment with the first media
                    // segment (`create_screenshot_source_from_segments`); by this
                    // point `finalize_instant_output` has already muxed the whole
                    // thing into `content/output.mp4`, which is the same first
                    // frame without the temporary file. The blur bridge is *not*
                    // applied here: `project_config_from_recording` is the studio
                    // arm of `handle_recording_finish` only.
                    let project_path = completed.project_path.clone();
                    tokio::task::spawn_blocking(move || {
                        write_bundle_thumbnail(&project_path, &output_path);
                    })
                    .await
                    .context("instant thumbnail task")?;

                    Ok(completed.project_path)
                }
                .await;
                if result.is_err()
                    && let Some(upload) = instant_upload.as_mut()
                {
                    upload.abort_segments().await;
                }
                if let Ok(project) = &result
                    && let Some(upload) = upload_guard.as_deref_mut().and_then(Option::take)
                    && let Err(error) =
                        crate::upload::queue::enqueue(project.clone(), upload, preserve_local).await
                {
                    tracing::warn!(path = %project.display(), %error, "Local recording saved; upload needs attention");
                }
                result
            }
        }
    }
}

fn with_instant_metadata_lock<T>(
    metadata_lock: &Mutex<()>,
    update: impl FnOnce() -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let _guard = metadata_lock
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    update()
}

fn save_instant_metadata(meta: &cap_project::RecordingMeta) -> anyhow::Result<()> {
    let contents = serde_json::to_vec_pretty(meta)?;
    write_instant_metadata(&meta.project_path, |file| file.write_all(&contents))
}

fn write_instant_metadata(
    project_path: &std::path::Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> anyhow::Result<()> {
    let temporary = project_path.join(format!(
        ".recording-meta-{}.tmp",
        crate::store::new_uuid_v4()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        write(&mut file)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, project_path.join("recording-meta.json"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.context("saving instant recording metadata")
}

#[cfg(target_os = "linux")]
fn persist_preserved_instant_stop(
    project_path: &std::path::Path,
    metadata_lock: Option<&Mutex<()>>,
    joined: bool,
    capture_result: anyhow::Result<()>,
) -> anyhow::Result<()> {
    if !joined {
        return capture_result;
    }
    let metadata_result = metadata_lock
        .context("instant recording has no upload session")
        .and_then(|lock| mark_instant_recording_stopped(project_path, lock));
    if let Err(error) = &metadata_result {
        tracing::warn!(%error, "Could not mark the preserved instant recording as stopped");
    }
    capture_result.and(metadata_result)
}

fn mark_instant_recording_stopped(
    project_path: &std::path::Path,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let mut meta = cap_project::RecordingMeta::load_for_project(project_path)
            .map_err(|error| anyhow!("loading recording metadata: {error}"))?;
        meta.inner = cap_project::RecordingMetaInner::Instant(
            cap_project::InstantRecordingMeta::InProgress { recording: false },
        );
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

pub fn available_recording_storage() -> std::io::Result<cap_utils::disk_space::RecordingStorage> {
    Ok(cap_utils::disk_space::RecordingStorage {
        available_bytes: cap_utils::disk_space::free_bytes_for_path(&recordings_dir())?,
        recording_bytes: 0,
    })
}

pub(crate) fn ensure_finalization_storage(project_path: &std::path::Path) -> anyhow::Result<()> {
    let storage = cap_utils::disk_space::recording_storage(project_path)
        .context("checking storage before saving the recording")?;
    if !storage.can_finalize() {
        return Err(anyhow!(
            "Low storage. Your recording files are preserved at {}. Free up space, then recover the recording in Cap.",
            project_path.display()
        ));
    }
    Ok(())
}

pub fn recover_instant_recording(project_path: &std::path::Path) -> anyhow::Result<PathBuf> {
    use cap_project::{InstantRecordingMeta, RecordingMeta, RecordingMetaInner};

    let mut meta = RecordingMeta::load_for_project(project_path)
        .map_err(|error| anyhow!("loading recording metadata: {error}"))?;
    if !matches!(
        meta.inner,
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. })
    ) {
        return Err(anyhow!(
            "This instant recording is not waiting to be saved."
        ));
    }
    ensure_finalization_storage(project_path)?;
    let output = project_path.join("content/output.mp4");
    cap_recording::recovery::RecoveryManager::finalize_instant_output(
        &project_path.join("content/display"),
        &project_path.join("content/audio"),
        &output,
    )?;
    let input = ffmpeg::format::input(&output)?;
    let video = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| anyhow!("The recovered recording has no video track."))?;
    let fps = f64::from(video.avg_frame_rate());
    if !fps.is_finite() || fps <= 0.0 {
        return Err(anyhow!(
            "The recovered recording has an invalid frame rate."
        ));
    }
    let sample_rate = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .map(|audio| {
            ffmpeg::codec::context::Context::from_parameters(audio.parameters())
                .and_then(|context| context.decoder().audio())
                .map(|decoder| decoder.rate())
        })
        .transpose()?;
    meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Complete {
        fps: fps.round() as u32,
        sample_rate,
    });
    save_instant_metadata(&meta)?;
    write_bundle_thumbnail(project_path, &output);
    Ok(project_path.to_path_buf())
}

/// The first segment's display track, which is what
/// `handle_recording_finish` hands `create_screenshot`
/// (`apps/desktop/src-tauri/src/recording.rs:3415-3429`).
///
/// Read back off disk rather than from the handle's `CompletedRecording`,
/// because the remux is what decides where that track lives: until
/// `remux_if_needed` runs, the meta points at the fragmented
/// `.../segment-0/display` *directory*, and afterwards at the muxed
/// `display.mp4` beside it. The Tauri app has the same ordering, and uses its
/// `updated_studio_meta` for the same reason.
fn studio_display_path(project_path: &std::path::Path) -> Option<PathBuf> {
    use cap_project::{RecordingMeta, StudioRecordingMeta};

    let meta = RecordingMeta::load_for_project(project_path).ok()?;
    let path = match meta.studio_meta()? {
        StudioRecordingMeta::SingleSegment { segment } => {
            segment.display.path.to_path(project_path)
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .first()
            .map(|segment| segment.display.path.to_path(project_path))?,
    };
    path.is_file().then_some(path)
}

/// Write `<bundle>/screenshots/display.jpg` -- the file both apps' Recents
/// cards draw. `cap-recording` does not produce it, so without this a project
/// recorded here would show the icon fallback forever, including in the
/// shipping app.
fn write_bundle_thumbnail(project_dir: &std::path::Path, source_video: &std::path::Path) {
    let output = crate::library::bundle_thumbnail_path(project_dir);
    match crate::library::create_screenshot(source_video, &output, None) {
        Ok(()) => tracing::info!(path = %output.display(), "wrote recording thumbnail"),
        Err(error) => tracing::warn!(
            source = %source_video.display(),
            "could not write the recording thumbnail: {error}"
        ),
    }
}

/// The camera preview bubble's current blur mode.
///
/// `handle_recording_finish` reads the *live* preview state
/// (`camera_preview_manager.get_state()`), not a value captured at start, so a
/// toggle made mid-recording is the one that lands in the project. The bubble
/// here persists every cycle to `gpui-state.json`, so reading it back is the
/// same "whatever the toggle says now" semantics.
fn current_camera_blur() -> crate::store::BlurMode {
    crate::store::load()
        .camera_window
        .map(|state| state.background_blur)
        .unwrap_or_default()
}

/// `BackgroundBlurMode`'s JSON spelling
/// (`crates/project/src/configuration.rs:423-430`, `rename_all = "camelCase"`
/// over `Off | Light | Heavy`).
fn blur_mode_json(blur: crate::store::BlurMode) -> &'static str {
    match blur {
        crate::store::BlurMode::Off => "off",
        crate::store::BlurMode::Light => "light",
        crate::store::BlurMode::Heavy => "heavy",
    }
}

fn apply_animated_gradient_to_project_config(
    project_dir: &std::path::Path,
    capture_target: &ScreenCaptureTarget,
    library: &cap_project::AnimatedGradientLibrary,
) -> bool {
    if matches!(capture_target, ScreenCaptureTarget::CameraOnly) || !library.selected {
        return false;
    }
    let Some(gradient) = library.last_used.as_ref() else {
        return false;
    };
    let path = project_dir.join("project-config.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %path.display(), "could not read new project background: {error}");
            return false;
        }
    };
    let Ok(mut config) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        tracing::warn!(path = %path.display(), "project config did not parse; keeping its background");
        return false;
    };
    if !apply_initial_animated_gradient(&mut config, gradient) {
        return false;
    }
    let Ok(serialized) = serde_json::to_vec_pretty(&config) else {
        return false;
    };
    let temp = path.with_extension(format!(
        "animated-gradient-{}.tmp",
        crate::store::new_uuid_v4()
    ));
    if let Err(error) =
        std::fs::write(&temp, serialized).and_then(|()| std::fs::rename(&temp, &path))
    {
        tracing::warn!(path = %path.display(), "could not remember new project background: {error}");
        let _ = std::fs::remove_file(&temp);
        return false;
    }
    true
}

fn apply_initial_animated_gradient(
    project: &mut serde_json::Value,
    config: &cap_project::AnimatedGradientConfig,
) -> bool {
    let Some(background) = project
        .get_mut("background")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return false;
    };
    let padding = match background.get("padding") {
        Some(value) => match value.as_f64() {
            Some(value) if value >= 0. => value,
            _ => return false,
        },
        None => 0.,
    };
    let Some(source) = background
        .get_mut("source")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return false;
    };
    if source.get("type").and_then(serde_json::Value::as_str) != Some("color")
        || source.get("value") != Some(&serde_json::json!([255, 255, 255]))
        || source.get("alpha").and_then(serde_json::Value::as_u64) != Some(255)
    {
        return false;
    }
    let Ok(config) = serde_json::to_value(config.normalized()) else {
        return false;
    };
    let _ = source.insert(
        "type".into(),
        serde_json::Value::String("animatedGradient".into()),
    );
    let _ = source.insert("config".into(), config);
    let _ = source.remove("value");
    let _ = source.remove("alpha");
    if padding == 0. {
        let _ = background.insert(
            "padding".into(),
            serde_json::json!(crate::editor_sidebar::DEFAULT_BACKGROUND_PADDING),
        );
    }
    true
}

/// Copy the camera preview's blur toggle into the finished project's
/// configuration -- the bridge at
/// `apps/desktop/src-tauri/src/recording.rs:3889-3891`:
///
/// ```text
/// config.camera.background_blur = cap_project::BackgroundBlurConfig {
///     mode: camera_preview_state.background_blur,
/// };
/// ```
///
/// Blur is never baked into the recorded camera track by either app; the
/// editor re-runs the same segmentation pipeline over the raw file, driven by
/// this field. Copying it is what makes a project recorded with the bubble
/// blurred *open* blurred.
///
/// `cap-recording` writes `project-config.json` itself at the end of a studio
/// recording (`studio_recording.rs:1189-1207`) and its builder takes no config,
/// so the value is merged in afterwards -- a read-modify-write on the raw JSON
/// that replaces exactly `camera.backgroundBlur.mode` and leaves every other
/// key of a file this app models none of (`timeline`, `clips`, `background`,
/// the four `*Version` counters) untouched. This is `store::set_store_setting`'s
/// discipline applied to the other shared file, including its refusal: a config
/// that does not parse, or whose `camera` is not an object, is left alone
/// rather than replaced.
pub fn apply_camera_blur_to_project_config(
    project_dir: &std::path::Path,
    blur: crate::store::BlurMode,
) -> bool {
    use serde_json::{Map, Value};

    let path = project_dir.join("project-config.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(path = %path.display(), "no project config to bridge blur into: {error}");
            return false;
        }
    };
    let Ok(Value::Object(mut config)) = serde_json::from_slice::<Value>(&bytes) else {
        tracing::error!(
            path = %path.display(),
            "the project config did not parse as an object; refusing to write to it"
        );
        return false;
    };

    let camera = config
        .entry("camera")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(camera) = camera.as_object_mut() else {
        tracing::error!(path = %path.display(), "project config `camera` is not an object");
        return false;
    };
    let background_blur = camera
        .entry("backgroundBlur")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(background_blur) = background_blur.as_object_mut() else {
        tracing::error!(
            path = %path.display(),
            "project config `camera.backgroundBlur` is not an object"
        );
        return false;
    };
    background_blur.insert(
        "mode".to_string(),
        Value::String(blur_mode_json(blur).to_string()),
    );

    // Same shape `ProjectConfiguration::write` produces (serde_json pretty),
    // via a temp file so a crash mid-write cannot leave a project whose config
    // neither app can parse.
    let Ok(serialized) = serde_json::to_vec_pretty(&Value::Object(config)) else {
        return false;
    };
    let temp = path.with_extension("gpui-tmp");
    if let Err(error) = std::fs::write(&temp, serialized) {
        tracing::warn!("writing the project config: {error}");
        return false;
    }
    if let Err(error) = std::fs::rename(&temp, &path) {
        tracing::warn!("replacing the project config: {error}");
        let _ = std::fs::remove_file(&temp);
        return false;
    }
    tracing::info!(
        mode = blur_mode_json(blur),
        "bridged camera blur into the project config"
    );
    true
}

/// `persist_instant_recording_meta` from the CLI, verbatim in behavior: without
/// this pair of files the recording plays but no Cap surface lists it.
fn persist_instant_meta(
    completed: &instant_recording::CompletedRecording,
    upload: &cap_project::VideoUploadInfo,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        use cap_project::{
            InstantRecordingMeta, Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner,
        };

        let pretty_name = completed
            .project_path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Cap Recording")
            .to_string();
        let meta = match &completed.meta {
            InstantRecordingMeta::InProgress { .. } => InstantRecordingMeta::Failed {
                error: "instant recording stopped before completion".to_string(),
            },
            other => other.clone(),
        };

        let previous_upload = RecordingMeta::load_for_project(&completed.project_path)
            .ok()
            .and_then(|meta| meta.upload);

        let meta = RecordingMeta {
            platform: Some(Platform::default()),
            project_path: completed.project_path.clone(),
            pretty_name,
            sharing: Some(cap_project::SharingMeta {
                id: upload.id.clone(),
                link: upload.link.clone(),
                content_hash: None,
            }),
            inner: RecordingMetaInner::Instant(meta),
            upload: previous_upload,
        };
        save_instant_metadata(&meta)?;

        ProjectConfiguration::default()
            .write(&completed.project_path)
            .map_err(|e| anyhow!("saving instant project config: {e}"))?;
        Ok(())
    })
}

pub(crate) fn persist_instant_upload_failure(
    project_path: &std::path::Path,
    error: &str,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let mut meta =
            cap_project::RecordingMeta::load_for_project(project_path).map_err(|load_error| {
                anyhow!("loading failed instant recording metadata: {load_error}")
            })?;
        if matches!(
            meta.upload,
            Some(
                cap_project::UploadMeta::SegmentUpload { .. }
                    | cap_project::UploadMeta::MultipartUpload { .. }
                    | cap_project::UploadMeta::SinglePartUpload { .. }
            )
        ) {
            crate::upload::queue::record_failure(project_path, error)
                .map_err(anyhow::Error::msg)?;
        } else {
            meta.upload = Some(cap_project::UploadMeta::Failed {
                error: error.to_string(),
            });
            save_instant_metadata(&meta)?;
        }
        Ok(())
    })
}

fn check_instant_publication_cancelled(
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !cancel.is_some_and(|cancel| cancel.load(std::sync::atomic::Ordering::Acquire)),
        "Instant recording upload cancelled; local success withheld"
    );
    Ok(())
}

#[cfg(test)]
fn remove_uploaded_instant_recording(
    directory: &std::path::Path,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> anyhow::Result<()> {
    check_instant_publication_cancelled(cancel)?;
    std::fs::remove_dir_all(directory).context("deleting uploaded instant recording")
}

#[cfg(test)]
pub(crate) async fn finish_instant_upload_locally(
    cancel: Option<&std::sync::atomic::AtomicBool>,
    upload: impl std::future::Future<Output = Result<(), String>>,
    persist: impl FnOnce() -> anyhow::Result<()>,
    cleanup: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    upload.await.map_err(anyhow::Error::msg)?;
    check_instant_publication_cancelled(cancel)?;
    persist()?;
    check_instant_publication_cancelled(cancel)?;
    cleanup.await?;
    check_instant_publication_cancelled(cancel)
}

pub(crate) fn persist_instant_upload_complete(
    project_path: &std::path::Path,
    metadata_lock: &Mutex<()>,
    cancel: Option<&std::sync::atomic::AtomicBool>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        check_instant_publication_cancelled(cancel)?;
        let mut meta = cap_project::RecordingMeta::load_for_project(project_path)
            .map_err(|error| anyhow!("loading instant recording metadata: {error}"))?;
        meta.upload = Some(cap_project::UploadMeta::Complete);
        check_instant_publication_cancelled(cancel)?;
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

fn persist_in_progress_instant_meta(
    project_path: &std::path::Path,
    video: &cap_project::VideoUploadInfo,
    segmented: bool,
    metadata_lock: &Mutex<()>,
) -> anyhow::Result<()> {
    with_instant_metadata_lock(metadata_lock, || {
        let upload = if segmented {
            cap_project::UploadMeta::SegmentUpload {
                video_id: video.id.clone(),
                pre_created_video: video.clone(),
                recording_dir: project_path.to_path_buf(),
            }
        } else {
            cap_project::UploadMeta::MultipartUpload {
                video_id: video.id.clone(),
                file_path: project_path.join("content/output.mp4"),
                pre_created_video: video.clone(),
                recording_dir: project_path.to_path_buf(),
            }
        };
        let pretty_name = project_path
            .file_stem()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or("Cap Recording")
            .to_string();

        let meta = cap_project::RecordingMeta {
            platform: Some(cap_project::Platform::default()),
            project_path: project_path.to_path_buf(),
            pretty_name,
            sharing: None,
            inner: cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: true },
            ),
            upload: Some(upload),
        };
        save_instant_metadata(&meta)?;
        Ok(())
    })
}

#[cfg(target_os = "linux")]
fn validate_linux_camera_request(
    mode: RecordingMode,
    target: &ScreenCaptureTarget,
    camera_requested: bool,
    prepared: bool,
) -> anyhow::Result<()> {
    let required = mode == RecordingMode::Instant
        && !matches!(target, ScreenCaptureTarget::CameraOnly)
        && camera_requested;
    anyhow::ensure!(
        !required || prepared,
        "Requested Instant camera has not been prepared. Please select the camera again."
    );
    anyhow::ensure!(
        !prepared || required,
        "Processed camera requires an Instant screen capture with a selected camera"
    );
    Ok(())
}

pub async fn start(config: StartConfig) -> anyhow::Result<ActiveRecording> {
    #[cfg(target_os = "linux")]
    if config.mode == RecordingMode::Instant {
        return start_tracked(config, InstantAttempt::new()).await;
    }
    start_internal(
        config,
        #[cfg(target_os = "linux")]
        None,
    )
    .await
}

#[cfg(target_os = "linux")]
pub(crate) fn start_tracked(
    config: StartConfig,
    attempt: InstantAttempt,
) -> impl Future<Output = anyhow::Result<ActiveRecording>> + Send {
    owned_instant_start(
        attempt.clone(),
        start_internal(config, Some(attempt)),
        ActiveRecording::cancel_preserving,
    )
}

async fn start_internal(
    config: StartConfig,
    #[cfg(target_os = "linux")] attempt: Option<InstantAttempt>,
) -> anyhow::Result<ActiveRecording> {
    #[cfg(target_os = "linux")]
    validate_linux_camera_request(
        config.mode,
        &config.target,
        config.camera.is_some(),
        config.linux_instant_camera.is_some(),
    )?;
    if matches!(config.target, ScreenCaptureTarget::CameraOnly) && config.camera.is_none() {
        return Err(anyhow!("Camera-only recording requires a selected camera."));
    }
    if config.mode == RecordingMode::Instant && !crate::store::auth_snapshot().signed_in() {
        return Err(anyhow!("Please sign in to use instant recording"));
    }

    let project_dir = create_project_dir(&config.target, config.mode)?;
    let project_name = project_dir
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("Cap Recording")
        .to_string();
    let organization_id = crate::store::store_section(crate::store::RECORDING_SETTINGS)
        .get("organizationId")
        .and_then(serde_json::Value::as_str)
        .filter(|organization| !organization.is_empty())
        .map(str::to_string);

    let pre_created_video = if config.mode == RecordingMode::Instant {
        Some(
            crate::upload::prepare_instant_upload(
                matches!(config.target, ScreenCaptureTarget::CameraOnly),
                project_name,
                organization_id,
            )
            .await
            .map_err(anyhow::Error::msg)?,
        )
    } else {
        None
    };

    let result = start_attempt_with_upload(
        config,
        project_dir,
        pre_created_video.clone(),
        #[cfg(target_os = "linux")]
        attempt.clone(),
    )
    .await;
    #[cfg(target_os = "linux")]
    if result.is_err()
        && let Some(attempt) = &attempt
    {
        let lifecycle = attempt.0.lifecycle.lock().unwrap().clone();
        if let Some(lifecycle) = lifecycle {
            lifecycle.cancel();
            anyhow::ensure!(
                lifecycle.wait_for_quiescence().await
                    == instant_recording::InstantQuiescence::Joined,
                "Recording startup failed; capture cleanup is unconfirmed and files are preserved"
            );
        }
    }
    if result.is_err()
        && let Some(video) = pre_created_video
        && let Err(error) = crate::upload::delete_instant_video(&video.id).await
    {
        tracing::error!(video_id = %video.id, "Failed to clean up instant recording: {error}");
        return Err(anyhow!("Failed to clean up instant recording: {error}"));
    }
    result
}

async fn start_attempt_with_upload(
    config: StartConfig,
    project_dir: PathBuf,
    pre_created_video: Option<cap_project::VideoUploadInfo>,
    #[cfg(target_os = "linux")] attempt: Option<InstantAttempt>,
) -> anyhow::Result<ActiveRecording> {
    #[cfg(target_os = "linux")]
    validate_linux_camera_request(
        config.mode,
        &config.target,
        config.camera.is_some(),
        config.linux_instant_camera.is_some(),
    )?;

    tracing::info!(dir = %project_dir.display(), "starting recording");

    if config.camera.is_some()
        && let Some(ready) = &config.input_readiness.camera
    {
        ready.clone().await.map_err(anyhow::Error::msg)?;
    }
    if config.microphone.is_some()
        && let Some(ready) = &config.input_readiness.microphone
    {
        ready.clone().await.map_err(anyhow::Error::msg)?;
    }

    let (mic_feed, mic_lock, mic_errors) = match (&config.mic_feed, &config.microphone) {
        (Some(actor), Some(label)) => match actor.ask(microphone::Lock).await {
            Ok(lock) => {
                anyhow::ensure!(
                    lock.device_name() == label,
                    "Selected microphone '{label}' is not the connected microphone '{}'. Please select it again.",
                    lock.device_name()
                );
                (None, Some(Arc::new(lock)), None)
            }
            Err(error) => {
                tracing::warn!("app mic feed lock failed ({error}), spawning one for '{label}'");
                let (feed, lock, error_rx) =
                    setup_microphone(label, config.device_settings.microphone)
                        .await
                        .with_context(|| format!("Selected microphone '{label}' is unavailable"))?;
                (Some(feed), Some(lock), Some(error_rx))
            }
        },
        (None, Some(label)) => {
            let (feed, lock, error_rx) = setup_microphone(label, config.device_settings.microphone)
                .await
                .with_context(|| format!("Selected microphone '{label}' is unavailable"))?;
            (Some(feed), Some(lock), Some(error_rx))
        }
        _ => (None, None, None),
    };

    let (camera_feed, camera_lock) = match &config.camera {
        Some(id) => {
            if let Some(actor) = &config.camera_feed {
                match actor.ask(camera::Lock).await {
                    Ok(lock) => {
                        let info = lock.camera_info();
                        let matches_selection = match id {
                            DeviceOrModelID::DeviceID(device_id) => info.device_id() == device_id,
                            DeviceOrModelID::ModelID(model_id) => info.model_id() == Some(model_id),
                        };
                        anyhow::ensure!(
                            matches_selection,
                            "The selected camera is not the connected camera. Please select it again."
                        );
                        (None, Some(Arc::new(lock)))
                    }
                    Err(error) => {
                        tracing::warn!("app camera feed lock failed ({error}), spawning one");
                        let (feed, lock) = setup_camera(id, config.device_settings.camera).await?;
                        (Some(feed), Some(Arc::new(lock)))
                    }
                }
            } else {
                let (feed, lock) = setup_camera(id, config.device_settings.camera).await?;
                (Some(feed), Some(Arc::new(lock)))
            }
        }
        None => {
            if matches!(config.target, ScreenCaptureTarget::CameraOnly) {
                return Err(anyhow!("Camera-only recording requires a selected camera."));
            }
            (None, None)
        }
    };

    #[cfg(target_os = "linux")]
    let processed_camera = if let Some(request) = &config.linux_instant_camera {
        anyhow::ensure!(
            config.mode == RecordingMode::Instant
                && !matches!(config.target, ScreenCaptureTarget::CameraOnly),
            "Processed camera requires an Instant screen capture"
        );
        anyhow::ensure!(
            request.presentation.mirrored == request.effects.mirrored,
            "Camera presentation mirror differs from requested processing"
        );
        anyhow::ensure!(
            (request.presentation.effect == instant_recording::LinuxCameraEffect::None)
                == (request.effects.blur == instant_recording::LinuxCameraBlur::Off),
            "Camera presentation blur differs from requested processing"
        );
        let lock = camera_lock
            .clone()
            .context("Processed camera requires a selected camera")?;
        Some(
            request
                .processing
                .subscribe(lock, request.effects)
                .await
                .context("Preparing requested camera effects")?,
        )
    } else {
        None
    };

    let mic_mute = mic_lock.as_ref().map(|lock| lock.recording_muted_handle());

    // ScreenCaptureKit content, exactly as `read_recording_shareable_content`
    // does it: the current-process fallback covers the sandboxed case where the
    // full query returns no displays.
    #[cfg(target_os = "macos")]
    let shareable_content = match config.target {
        ScreenCaptureTarget::CameraOnly => None,
        _ => Some(read_shareable_content().await?),
    };

    // `desktop_recording_defaults` (`src-tauri/src/recording.rs:1102-1116`):
    // the user's persisted settings, applied through the same shared
    // `RecordingDefaults` seam so both apps build recordings identically.
    let settings = crate::store::GeneralSettings::load();
    let defaults = cap_recording::RecordingDefaults {
        custom_cursor_capture: settings.custom_cursor_capture,
        capture_keyboard_events: settings.capture_keyboard_events,
        crash_recovery_recording: settings.crash_recovery_recording,
        max_fps: settings.max_fps,
        studio_recording_quality: settings.studio_recording_quality.into(),
        out_of_process_muxer: settings.out_of_process_muxer,
        instant_mode_max_resolution: cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION,
    };
    // The instant output cap is plan-gated at start time, not at settings
    // time (`recording.rs:1634-1639`): free stays at the free cap even if a
    // stale store value says otherwise.
    let instant_max_resolution = if crate::store::auth_snapshot().is_upgraded() {
        settings.instant_mode_max_resolution
    } else {
        cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
    };

    #[cfg(target_os = "macos")]
    let excluded_windows = {
        let mut excluded = config.excluded_windows.clone();
        let mut rules = settings.excluded_windows.clone();
        if config.mode == RecordingMode::Instant {
            // `filter_for_instant_mode`: instant has no compositing step,
            // so the camera bubble stays in the picture there.
            rules.retain(|rule| rule.window_title.as_deref() != Some("Cap Camera"));
        }
        for id in resolve_excluded_window_ids(&rules) {
            if !excluded.contains(&id) {
                excluded.push(id);
            }
        }
        excluded
    };
    let mut instant_upload = None;
    let handle = match config.mode {
        RecordingMode::Studio => {
            let mut builder = defaults.apply_to_studio_builder(
                studio_recording::Actor::builder(project_dir.clone(), config.target.clone())
                    .with_system_audio(config.system_audio),
                camera_lock.is_some(),
                None,
            );
            #[cfg(target_os = "macos")]
            {
                builder = builder.with_excluded_windows(excluded_windows.clone());
            }
            if let Some(lock) = camera_lock.clone() {
                builder = builder.with_camera_feed(lock);
            }
            if let Some(lock) = mic_lock.clone() {
                builder = builder.with_mic_feed(lock);
            }
            Handle::Studio(
                builder
                    .build(
                        #[cfg(target_os = "macos")]
                        shareable_content,
                    )
                    .await
                    .context("studio recording actor")?,
            )
        }
        RecordingMode::Instant => {
            let mut builder =
                instant_recording::Actor::builder(project_dir.clone(), config.target.clone())
                    .with_system_audio(config.system_audio)
                    .with_max_output_size(instant_max_resolution);
            #[cfg(target_os = "macos")]
            {
                builder = builder.with_excluded_windows(excluded_windows.clone());
            }
            if let Some(lock) = camera_lock.clone() {
                builder = builder.with_camera_feed(lock);
            }
            if let Some(lock) = mic_lock.clone() {
                builder = builder.with_mic_feed(lock);
            }
            #[cfg(target_os = "linux")]
            if let (Some(source), Some(request)) = (processed_camera, &config.linux_instant_camera)
            {
                builder = builder.with_linux_processed_camera(
                    source,
                    request.presentation,
                    request.reference_size,
                );
            }
            #[cfg(target_os = "linux")]
            if let Some(attempt) = &attempt {
                attempt.attach(builder.lifecycle())?;
            }
            let handle = Arc::new(
                builder
                    .build(
                        #[cfg(target_os = "macos")]
                        shareable_content,
                    )
                    .await
                    .context("instant recording actor")?,
            );
            let setup = (|| {
                let video = pre_created_video
                    .ok_or_else(|| anyhow!("instant recording has no reserved upload"))?;
                let segment_rx = handle.take_segment_rx();
                let metadata_lock = Arc::new(Mutex::new(()));
                persist_in_progress_instant_meta(
                    &project_dir,
                    &video,
                    segment_rx.is_some(),
                    &metadata_lock,
                )?;
                crate::upload::queue::record_capture(
                    &project_dir,
                    &video,
                    segment_rx.is_some(),
                    config.microphone.is_some() || config.system_audio,
                )
                .map_err(anyhow::Error::msg)?;
                crate::upload::start_instant_upload(
                    video,
                    project_dir.clone(),
                    segment_rx,
                    metadata_lock,
                    Some(crate::upload::CompletionAuthorization::new()),
                )
                .map_err(anyhow::Error::msg)
            })();
            #[cfg(windows)]
            let setup = finish_windows_startup_setup(setup, handle.cancel()).await;
            instant_upload = Some(setup?);
            Handle::Instant(handle)
        }
    };

    #[cfg(target_os = "linux")]
    let instant_completion = instant_upload
        .as_ref()
        .and_then(crate::upload::InstantUpload::completion_control);
    let instant_share_link = instant_upload
        .as_ref()
        .map(|upload| upload.video().link.clone());
    let instant_upload =
        instant_upload.map(|upload| Arc::new(tokio::sync::Mutex::new(Some(upload))));
    Ok(ActiveRecording {
        handle,
        project_dir,
        instant_upload,
        instant_share_link,
        #[cfg(target_os = "linux")]
        instant_completion,
        #[cfg(target_os = "linux")]
        instant_operation: Arc::new(tokio::sync::Mutex::new(())),
        mic_mute,
        _mic_feed: mic_feed,
        _camera_feed: camera_feed,
        _mic_errors: mic_errors,
    })
}

/// `window_exclusion::resolve_window_ids`: every on-screen window matching a
/// configured exclusion rule, by id. Our own windows are excluded by window
/// number in `begin_recording` before this runs; this resolves the
/// user-configured (or default) rules -- other apps, other Cap installs.
#[cfg(target_os = "macos")]
fn resolve_excluded_window_ids(
    exclusions: &[crate::store::WindowExclusion],
) -> Vec<scap_targets::WindowId> {
    if exclusions.is_empty() {
        return Vec::new();
    }

    scap_targets::Window::list()
        .into_iter()
        .filter_map(|window| {
            let owner_name = window.owner_name();
            let window_title = window.name();
            let bundle_identifier = window.raw_handle().bundle_identifier();
            let matches = exclusions.iter().any(|entry| {
                entry.matches(
                    bundle_identifier.as_deref(),
                    owner_name.as_deref(),
                    window_title.as_deref(),
                )
            });
            if !matches {
                return None;
            }
            let window_id = window.id();
            tracing::info!(
                %window_id,
                ?owner_name,
                ?window_title,
                ?bundle_identifier,
                "excluding window from capture"
            );
            Some(window_id)
        })
        .collect()
}

async fn setup_camera(
    id: &DeviceOrModelID,
    settings: Option<camera::CameraDeviceSettings>,
) -> anyhow::Result<(
    ActorRef<CameraFeed>,
    cap_recording::feeds::camera::CameraFeedLock,
)> {
    let feed = CameraFeed::spawn(CameraFeed::default());
    let ready = feed
        .ask(camera::SetInput {
            id: id.clone(),
            settings,
        })
        .await
        .map_err(|e| anyhow!("camera setup: {e}"))?;
    ready.await.map_err(|e| anyhow!("camera init: {e}"))?;
    let lock = feed
        .ask(camera::Lock)
        .await
        .map_err(|e| anyhow!("camera lock: {e}"))?;
    Ok((feed, lock))
}

async fn setup_microphone(
    label: &str,
    settings: Option<microphone::MicrophoneDeviceSettings>,
) -> anyhow::Result<(
    ActorRef<MicrophoneFeed>,
    Arc<cap_recording::feeds::microphone::MicrophoneFeedLock>,
    flume::Receiver<cpal::StreamError>,
)> {
    let (error_tx, error_rx) = flume::unbounded();
    let feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));
    let ready = feed
        .ask(microphone::SetInput {
            label: label.to_string(),
            settings,
        })
        .await
        .map_err(|e| anyhow!("setup: {e}"))?;
    ready.await.map_err(|e| anyhow!("init: {e}"))?;
    let lock = feed
        .ask(microphone::Lock)
        .await
        .map_err(|e| anyhow!("lock: {e}"))?;
    Ok((feed, Arc::new(lock), error_rx))
}

#[cfg(target_os = "macos")]
async fn read_shareable_content() -> anyhow::Result<cap_recording::SendableShareableContent> {
    let content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("ReadShareableContent: {e}"))?;
    if !content.displays().is_empty() {
        return Ok(content.into());
    }
    let process_content = cidre::sc::ShareableContent::current_process()
        .await
        .map_err(|e| anyhow!("ReadCurrentProcessShareableContent: {e}"))?;
    if !process_content.displays().is_empty() {
        return Ok(process_content.into());
    }
    Ok(content.into())
}

/// The recordings library root, resolved the way `GeneralSettingsStore::
/// recordings_dir` resolves it so both apps share one library: the custom
/// `recordingsPath` from the Tauri store if it is absolute and creatable,
/// otherwise `<app data>/recordings`. `CAP_GPUI_RECORDINGS_DIR` overrides both
/// (used by the automated end-to-end check so test recordings stay out of the
/// user's library).
pub fn recordings_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("CAP_GPUI_RECORDINGS_DIR")
        && !dir.trim().is_empty()
    {
        return PathBuf::from(dir);
    }

    let custom = crate::store::GeneralSettings::load()
        .recordings_path
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());

    if let Some(path) = custom
        && std::fs::create_dir_all(&path).is_ok()
    {
        return path;
    }

    crate::store::app_data_dir().join("recordings")
}

/// `delete_recording_directory` (`src-tauri/src/lib.rs:4006-4051`), for the
/// clip the editor-append flow just copied out of: reject `..` components,
/// require the path to live inside the recordings library (canonically, so a
/// symlink cannot escape it), then `remove_dir_all`. The Tauri command accepts
/// every known storage folder; this app resolves exactly one
/// ([`recordings_dir`]), so that one is the whole allow-list.
pub fn delete_recording_directory(path: &std::path::Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid path".to_string());
    }

    let recordings = recordings_dir();
    if !path.starts_with(&recordings) {
        return Err("Path is not inside the recordings directory".to_string());
    }

    if path.exists() {
        let canonical = path
            .canonicalize()
            .map_err(|e| format!("Failed to resolve recording path: {e}"))?;
        let inside = recordings
            .canonicalize()
            .map(|dir| canonical.starts_with(&dir))
            .unwrap_or(false);
        if !inside {
            return Err("Path is not inside the recordings directory".to_string());
        }
        std::fs::remove_dir_all(&canonical)
            .map_err(|e| format!("Failed to delete recording: {e}"))?;
    }

    Ok(())
}

/// `format_project_name` with the default template
/// (`{target_name} ({target_kind}) {date} {time}`), then the same `:` -> `.`
/// replacement and uniquing the Tauri app applies.
fn create_project_dir(
    target: &ScreenCaptureTarget,
    recording_mode: RecordingMode,
) -> anyhow::Result<PathBuf> {
    let base = recordings_dir();
    std::fs::create_dir_all(&base)
        .with_context(|| format!("creating recordings dir {}", base.display()))?;

    match cap_utils::disk_space::free_bytes_for_path(&base) {
        Ok(bytes) if bytes <= cap_utils::disk_space::RECORDING_DISK_RESERVE_BYTES => {
            return Err(anyhow!(
                "Low storage: only {:.2} GB is available. Free up at least {} MB before recording.",
                bytes as f64 / 1_073_741_824.0,
                cap_utils::disk_space::RECORDING_DISK_RESERVE_BYTES / (1024 * 1024)
            ));
        }
        Ok(bytes) if bytes <= cap_utils::disk_space::RECORDING_DISK_WARN_BYTES => {
            tracing::warn!(
                bytes_remaining = bytes,
                "Starting recording with low disk space"
            );
        }
        Ok(_) => {}
        Err(error) => return Err(anyhow!("Could not check recording storage: {error}")),
    }

    let target_name = target.title().unwrap_or_else(|| "Unknown".into());
    let now = chrono::Local::now();
    let settings = crate::store::GeneralSettings::load();
    let name = format_recording_project_name(
        settings.default_project_name_template.as_deref(),
        &target_name,
        target.kind_str(),
        recording_mode,
        now,
    );
    // Same normalization chain as the Tauri app: colons break Finder, slashes
    // break paths.
    let filename = format!("{}.cap", name.replace([':', '/'], "."));
    let filename = cap_utils::ensure_unique_filename(&filename, &base)
        .map_err(|e| anyhow!("unique filename: {e}"))?;

    Ok(base.join(filename))
}

fn format_recording_project_name(
    template: Option<&str>,
    target_name: &str,
    target_kind: &str,
    mode: RecordingMode,
    datetime: chrono::DateTime<chrono::Local>,
) -> String {
    let target_name = if target_name.chars().count() > 180 {
        format!("{}...", target_name.chars().take(180).collect::<String>())
    } else {
        target_name.to_string()
    };
    let (recording_mode, mode) = match mode {
        RecordingMode::Studio => ("Studio", "studio"),
        RecordingMode::Instant => ("Instant", "instant"),
    };
    let formatted = template
        .unwrap_or(crate::store::DEFAULT_PROJECT_NAME_TEMPLATE)
        .replace("{recording_mode}", recording_mode)
        .replace("{mode}", mode)
        .replace("{target_kind}", target_kind)
        .replace("{target_name}", &target_name);
    let formatted = replace_datetime_template_token(&formatted, "date", "%Y-%m-%d", datetime);
    let formatted = replace_datetime_template_token(&formatted, "time", "%I:%M %p", datetime);
    replace_datetime_template_token(&formatted, "moment", "%Y-%m-%d %H:%M", datetime)
}

fn replace_datetime_template_token(
    input: &str,
    name: &str,
    default_format: &str,
    datetime: chrono::DateTime<chrono::Local>,
) -> String {
    let mut output = String::with_capacity(input.len());
    let mut remaining = input;
    let prefix = format!("{{{name}");

    while let Some(start) = remaining.find(&prefix) {
        output.push_str(&remaining[..start]);
        let candidate = &remaining[start..];
        let Some(end) = candidate.find('}') else {
            output.push_str(candidate);
            return output;
        };
        let token = &candidate[1..end];
        if token == name {
            output.push_str(&datetime.format(default_format).to_string());
        } else if let Some(custom_format) = token.strip_prefix(&format!("{name}:")) {
            let format = cap_utils::moment_format_to_chrono(custom_format);
            output.push_str(&datetime.format(&format).to_string());
        } else {
            output.push_str(&candidate[..=end]);
        }
        remaining = &candidate[end + 1..];
    }
    output.push_str(remaining);
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::BlurMode;
    use chrono::TimeZone as _;
    #[cfg(target_os = "linux")]
    use instant_recording::InstantQuiescence;
    use serde_json::Value;
    use std::sync::{Arc, Barrier};
    #[cfg(target_os = "linux")]
    use std::time::Duration;

    #[cfg(target_os = "linux")]
    #[test]
    fn instant_screen_requested_camera_cannot_bypass_processing_preparation() {
        let screen = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };
        for mode in [RecordingMode::Instant, RecordingMode::Studio] {
            for target in [&screen, &ScreenCaptureTarget::CameraOnly] {
                for camera_requested in [false, true] {
                    let required = mode == RecordingMode::Instant
                        && !matches!(target, ScreenCaptureTarget::CameraOnly)
                        && camera_requested;
                    for prepared in [false, true] {
                        assert_eq!(
                            validate_linux_camera_request(mode, target, camera_requested, prepared)
                                .is_ok(),
                            required == prepared,
                            "{mode:?}, {target:?}, camera={camera_requested}, prepared={prepared}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn recording_project_names_honor_mode_target_and_custom_datetime_formats() {
        let timestamp = chrono::Local
            .with_ymd_and_hms(2026, 8, 25, 14, 7, 9)
            .single()
            .unwrap();

        assert_eq!(
            format_recording_project_name(
                Some(
                    "{recording_mode}-{mode}-{target_kind}-{target_name}-{date:DD/MM/YYYY}-{time:HH.mm}-{moment:YYYYMMDD_HHmmss}"
                ),
                "Example Window",
                "Window",
                RecordingMode::Instant,
                timestamp,
            ),
            "Instant-instant-Window-Example Window-25/08/2026-14.07-20260825_140709"
        );
    }

    #[test]
    fn recording_project_names_preserve_unknown_tokens_and_limit_target_length() {
        let timestamp = chrono::Local
            .with_ymd_and_hms(2026, 8, 25, 9, 15, 0)
            .single()
            .unwrap();
        let target = "x".repeat(200);

        assert_eq!(
            format_recording_project_name(
                Some("{mode}-{target_name}-{unknown}"),
                &target,
                "Display",
                RecordingMode::Studio,
                timestamp,
            ),
            format!("studio-{}...-{{unknown}}", "x".repeat(180))
        );
    }

    fn temp_project(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-config-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_display_target() -> ScreenCaptureTarget {
        ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        }
    }

    #[tokio::test]
    async fn revoked_upload_response_preserves_actual_local_metadata_and_files() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = temp_project("revoked-upload");
        let metadata_lock = Mutex::new(());
        let video = cap_project::VideoUploadInfo {
            id: "revoked".into(),
            link: "https://example.invalid/s/revoked".into(),
            config: cap_project::S3UploadMeta {
                id: "revoked".into(),
            },
        };
        persist_in_progress_instant_meta(&dir, &video, true, &metadata_lock).unwrap();
        let original = std::fs::read(dir.join("recording-meta.json")).unwrap();
        let cancel = AtomicBool::new(false);
        let (response, received) = tokio::sync::oneshot::channel();
        let future = finish_instant_upload_locally(
            Some(&cancel),
            async { received.await.unwrap() },
            || persist_instant_upload_complete(&dir, &metadata_lock, Some(&cancel)),
            async { remove_uploaded_instant_recording(&dir, Some(&cancel)) },
        );
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), &mut future)
                .await
                .is_err()
        );
        cancel.store(true, Ordering::Release);
        response.send(Ok(())).unwrap();
        assert!(future.await.is_err());
        assert_eq!(
            std::fs::read(dir.join("recording-meta.json")).unwrap(),
            original
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn revoked_local_upload_persist_cannot_begin_cleanup() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = temp_project("revoked-before-cleanup");
        let cancel = AtomicBool::new(false);
        let result = finish_instant_upload_locally(
            Some(&cancel),
            async { Ok(()) },
            || {
                cancel.store(true, Ordering::Release);
                Ok(())
            },
            async { remove_uploaded_instant_recording(&dir, Some(&cancel)) },
        )
        .await;
        assert!(result.is_err());
        assert!(dir.is_dir());
        assert!(remove_uploaded_instant_recording(&dir, Some(&cancel)).is_err());
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn failed_local_upload_persist_after_remote_success_preserves_recording() {
        let dir = temp_project("failed-upload-persist");
        let result = finish_instant_upload_locally(
            None,
            async { Ok(()) },
            || anyhow::bail!("local metadata could not be saved"),
            async { remove_uploaded_instant_recording(&dir, None) },
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("local metadata"));
        assert!(dir.is_dir());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_preserves_camera_only_presentation() {
        let dir = temp_project("animated-camera-only");
        let path = dir.join("project-config.json");
        let original = serde_json::to_vec(&cap_project::ProjectConfiguration::default()).unwrap();
        std::fs::write(&path, &original).unwrap();
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(cap_project::AnimatedGradientConfig::default()),
            ..Default::default()
        };
        assert!(!apply_animated_gradient_to_project_config(
            &dir,
            &ScreenCaptureTarget::CameraOnly,
            &library,
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert!(apply_animated_gradient_to_project_config(
            &dir,
            &test_display_target(),
            &library,
        ));
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["background"]["source"]["type"], "animatedGradient");
        assert_eq!(
            written["background"]["padding"],
            crate::editor_sidebar::DEFAULT_BACKGROUND_PADDING
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_is_inactive_without_selection_and_config() {
        let dir = temp_project("animated-inactive");
        let path = dir.join("project-config.json");
        let original = serde_json::to_vec(&cap_project::ProjectConfiguration::default()).unwrap();
        std::fs::write(&path, &original).unwrap();
        for library in [
            cap_project::AnimatedGradientLibrary {
                selected: false,
                last_used: Some(cap_project::AnimatedGradientConfig::default()),
                ..Default::default()
            },
            cap_project::AnimatedGradientLibrary {
                selected: true,
                ..Default::default()
            },
        ] {
            assert!(!apply_animated_gradient_to_project_config(
                &dir,
                &test_display_target(),
                &library
            ));
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_applies_normalized_config_and_visible_padding() {
        let dir = temp_project("animated-new-project");
        let path = dir.join("project-config.json");
        cap_project::ProjectConfiguration::default()
            .write(&dir)
            .unwrap();
        let mut gradient = cap_project::AnimatedGradientConfig::from_seed(73);
        gradient.motion_speed = 800.;
        gradient.flow_scale = 0.;
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(gradient.clone()),
            ..Default::default()
        };
        assert!(apply_animated_gradient_to_project_config(
            &dir,
            &test_display_target(),
            &library
        ));
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(written["background"]["source"]["type"], "animatedGradient");
        assert_eq!(
            written["background"]["source"]["config"],
            serde_json::to_value(gradient.normalized()).unwrap()
        );
        assert_eq!(
            written["background"]["padding"],
            crate::editor_sidebar::DEFAULT_BACKGROUND_PADDING
        );
        assert!(!apply_animated_gradient_to_project_config(
            &dir,
            &test_display_target(),
            &library
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_preserves_unknown_fields_and_edits() {
        let dir = temp_project("animated-preserve");
        let path = dir.join("project-config.json");
        let original = serde_json::json!({
            "background": {
                "source": {"type": "color", "value": [255, 255, 255], "alpha": 255, "futureSourceField": 42},
                "padding": 18.0,
                "rounding": 27.0,
                "futureBackgroundField": {"preserved": true}
            },
            "timeline": {"segments": [{"recordingClip": 0, "start": 0.0, "end": 3.0}]},
            "clips": [{"aFutureClipField": [1, 2, 3]}],
            "camera": {"backgroundBlur": {"mode": "heavy"}},
            "aFieldFromANewerBuild": 42
        });
        std::fs::write(&path, serde_json::to_vec(&original).unwrap()).unwrap();
        let gradient = cap_project::AnimatedGradientConfig::default();
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(gradient.clone()),
            ..Default::default()
        };
        assert!(apply_animated_gradient_to_project_config(
            &dir,
            &test_display_target(),
            &library
        ));
        let written: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut expected = original;
        expected["background"]["source"] = serde_json::json!({
            "type": "animatedGradient",
            "config": gradient.normalized(),
            "futureSourceField": 42
        });
        assert_eq!(written, expected);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_leaves_malformed_projects_untouched() {
        let dir = temp_project("animated-malformed");
        let path = dir.join("project-config.json");
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(cap_project::AnimatedGradientConfig::default()),
            ..Default::default()
        };
        assert!(!apply_animated_gradient_to_project_config(
            &dir,
            &test_display_target(),
            &library
        ));
        assert!(!path.exists());
        for original in [
            "{ not valid JSON",
            "[]",
            "{}",
            "{\"background\":[]}",
            "{\"background\":{\"source\":null}}",
            "{\"background\":{\"source\":{\"type\":\"color\",\"value\":[255,255,255],\"alpha\":255},\"padding\":\"invalid\"}}",
        ] {
            std::fs::write(&path, original).unwrap();
            assert!(!apply_animated_gradient_to_project_config(
                &dir,
                &test_display_target(),
                &library
            ));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn animated_gradient_preference_does_not_replace_custom_sources() {
        let dir = temp_project("animated-custom");
        let path = dir.join("project-config.json");
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(cap_project::AnimatedGradientConfig::default()),
            ..Default::default()
        };
        for source in [
            serde_json::json!({"type": "wallpaper", "path": "macOS/tahoe-dark"}),
            serde_json::json!({"type": "image", "path": "custom.png"}),
            serde_json::json!({"type": "color", "value": [254, 255, 255], "alpha": 255}),
            serde_json::json!({"type": "color", "value": [255, 255, 255], "alpha": 0}),
            serde_json::json!({"type": "gradient", "from": [255, 0, 0], "to": [0, 0, 255]}),
            serde_json::json!({"type": "animatedGradient", "config": cap_project::AnimatedGradientConfig::from_seed(99)}),
        ] {
            let original = serde_json::to_vec(
                &serde_json::json!({"background": {"source": source, "padding": 0}}),
            )
            .unwrap();
            std::fs::write(&path, &original).unwrap();
            assert!(!apply_animated_gradient_to_project_config(
                &dir,
                &test_display_target(),
                &library
            ));
            assert_eq!(std::fs::read(&path).unwrap(), original);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    fn preserved_instant_project(tag: &str) -> PathBuf {
        let dir = temp_project(tag);
        std::fs::write(
            dir.join("recording-meta.json"),
            r#"{"pretty_name":"Preserved capture","sharing":null,"recording":true,"upload":{"state":"Failed","error":"offline"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("partial-media"), b"preserved media").unwrap();
        dir
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn preserved_instant_joined_results_stop_actual_metadata_without_publication() {
        for capture_failed in [false, true] {
            let dir = preserved_instant_project("preserved-joined");
            let builder =
                instant_recording::Actor::builder(PathBuf::new(), ScreenCaptureTarget::CameraOnly);
            let lifecycle = builder.lifecycle();
            drop(builder);
            let (joined, result) = joined_instant_result(lifecycle, async move {
                if capture_failed {
                    Err(anyhow!("required audio failed"))
                } else {
                    Ok(())
                }
            })
            .await;
            assert!(joined);
            let result =
                persist_preserved_instant_stop(&dir, Some(&Mutex::new(())), joined, result);
            if capture_failed {
                assert_eq!(result.unwrap_err().to_string(), "required audio failed");
            } else {
                result.unwrap();
            }
            let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
            assert!(matches!(
                meta.inner,
                cap_project::RecordingMetaInner::Instant(
                    cap_project::InstantRecordingMeta::InProgress { recording: false }
                )
            ));
            assert!(matches!(
                meta.upload,
                Some(cap_project::UploadMeta::Failed { error }) if error == "offline"
            ));
            assert!(meta.sharing.is_none());
            assert_eq!(
                std::fs::read(dir.join("partial-media")).unwrap(),
                b"preserved media"
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn preserved_instant_pending_join_does_not_write_stopped_metadata_early() {
        let dir = preserved_instant_project("preserved-pending");
        let original = std::fs::read(dir.join("recording-meta.json")).unwrap();
        let (joined_tx, joined_rx) = tokio::sync::oneshot::channel();
        let future = async {
            let (joined, result) = run_instant_operation(
                async { Err::<(), _>(anyhow!("capture failed before join")) },
                || {},
                async { joined_rx.await.unwrap() },
            )
            .await;
            persist_preserved_instant_stop(&dir, Some(&Mutex::new(())), joined, result)
        };
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        assert_eq!(
            std::fs::read(dir.join("recording-meta.json")).unwrap(),
            original
        );
        joined_tx.send(InstantQuiescence::Joined).unwrap();
        assert_eq!(
            future.await.unwrap_err().to_string(),
            "capture failed before join"
        );
        let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: false }
            )
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn preserved_instant_unconfirmed_results_leave_actual_metadata_untouched() {
        for state in [InstantQuiescence::Pending, InstantQuiescence::Unconfirmed] {
            for capture_failed in [false, true] {
                let dir = preserved_instant_project("preserved-unconfirmed");
                let original = std::fs::read(dir.join("recording-meta.json")).unwrap();
                let (joined, result) = run_instant_operation(
                    async move {
                        if capture_failed {
                            Err(anyhow!("capture failed"))
                        } else {
                            Ok(())
                        }
                    },
                    || {},
                    async move { state },
                )
                .await;
                assert!(!joined);
                assert!(
                    persist_preserved_instant_stop(&dir, Some(&Mutex::new(())), joined, result)
                        .is_err()
                );
                assert_eq!(
                    std::fs::read(dir.join("recording-meta.json")).unwrap(),
                    original
                );
                assert!(dir.join("partial-media").is_file());
                std::fs::remove_dir_all(&dir).unwrap();
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preserved_instant_metadata_io_error_retains_first_capture_failure_and_files() {
        for capture_failed in [false, true] {
            let dir = preserved_instant_project("preserved-metadata-io");
            std::fs::remove_file(dir.join("recording-meta.json")).unwrap();
            let result = persist_preserved_instant_stop(
                &dir,
                Some(&Mutex::new(())),
                true,
                if capture_failed {
                    Err(anyhow!("original capture error"))
                } else {
                    Ok(())
                },
            );
            let error = result.unwrap_err().to_string();
            if capture_failed {
                assert_eq!(error, "original capture error");
            } else {
                assert!(error.contains("loading recording metadata"));
            }
            assert_eq!(
                std::fs::read(dir.join("partial-media")).unwrap(),
                b"preserved media"
            );
            assert!(!dir.join("recording-meta.json").exists());
            std::fs::remove_dir_all(&dir).unwrap();
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn preserved_instant_missing_upload_lock_never_rewrites_metadata() {
        let dir = preserved_instant_project("preserved-missing-lock");
        let original = std::fs::read(dir.join("recording-meta.json")).unwrap();
        assert!(persist_preserved_instant_stop(&dir, None, true, Ok(())).is_err());
        assert_eq!(
            persist_preserved_instant_stop(&dir, None, true, Err(anyhow!("capture failed")))
                .unwrap_err()
                .to_string(),
            "capture failed"
        );
        assert_eq!(
            std::fs::read(dir.join("recording-meta.json")).unwrap(),
            original
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn stopped_instant_metadata_preserves_recovery_and_upload_state() {
        let dir = temp_project("instant-stopped");
        std::fs::write(
            dir.join("recording-meta.json"),
            r#"{"pretty_name":"Storage test","sharing":null,"recording":true,"upload":{"state":"Failed","error":"offline"}}"#,
        )
        .unwrap();
        mark_instant_recording_stopped(&dir, &std::sync::Mutex::new(())).unwrap();
        let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
        assert!(matches!(
            meta.inner,
            cap_project::RecordingMetaInner::Instant(
                cap_project::InstantRecordingMeta::InProgress { recording: false }
            )
        ));
        assert!(matches!(
            meta.upload,
            Some(cap_project::UploadMeta::Failed { error }) if error == "offline"
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_instant_metadata_write_preserves_the_previous_recording_state() {
        let dir = temp_project("instant-metadata-write-failure");
        let original = br#"{"pretty_name":"Storage test","sharing":null,"recording":true}"#;
        let path = dir.join("recording-meta.json");
        std::fs::write(&path, original).unwrap();

        let result = write_instant_metadata(&dir, |file| {
            std::io::Write::write_all(file, b"{partial")?;
            Err(std::io::Error::other("simulated disk full"))
        });

        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_instant_upload_preserves_resumable_identity_and_audio_intent() {
        let dir = temp_project("upload-identity");
        let video = cap_project::VideoUploadInfo {
            id: "saved-video".into(),
            link: "https://example.invalid/s/saved-video".into(),
            config: cap_project::S3UploadMeta {
                id: "saved-video".into(),
            },
        };
        let metadata_lock = Mutex::new(());
        persist_in_progress_instant_meta(&dir, &video, true, &metadata_lock).unwrap();
        crate::upload::queue::record_capture(&dir, &video, true, true).unwrap();
        persist_instant_upload_failure(&dir, "offline", &metadata_lock).unwrap();
        let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
        assert!(
            matches!(meta.upload, Some(cap_project::UploadMeta::SegmentUpload { video_id, .. }) if video_id == "saved-video")
        );
        let state: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("instant-upload.json")).unwrap())
                .unwrap();
        assert_eq!(state["requested_audio"], true);
        assert_eq!(state["last_error"], "offline");
        assert_eq!(state["phase"], "Retrying");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_instant_metadata_updates_stay_valid_and_recoverable() {
        for finalized in [false, true] {
            let dir = temp_project("instant-metadata-race");
            let initial = serde_json::json!({
                "pretty_name": "Race test",
                "sharing": null,
                "recording": true,
                "upload": { "state": "Failed", "error": "old" },
            });
            std::fs::write(
                dir.join("recording-meta.json"),
                serde_json::to_vec(&initial).unwrap(),
            )
            .unwrap();

            let metadata_lock = Arc::new(std::sync::Mutex::new(()));
            let barrier = Arc::new(Barrier::new(2));
            let stopped_dir = dir.clone();
            let stopped_lock = metadata_lock.clone();
            let stopped_barrier = barrier.clone();
            let failed_dir = dir.clone();
            let failed_lock = metadata_lock.clone();
            let failed_barrier = barrier.clone();
            std::thread::scope(|scope| {
                let stopped = scope.spawn(move || {
                    stopped_barrier.wait();
                    if finalized {
                        let completed = instant_recording::CompletedRecording {
                            project_path: stopped_dir,
                            display_source: ScreenCaptureTarget::CameraOnly,
                            meta: cap_project::InstantRecordingMeta::Complete {
                                fps: 30,
                                sample_rate: Some(48_000),
                            },
                            health: cap_recording::RecordingHealth::Healthy,
                            clean_completion: None,
                        };
                        let video = cap_project::VideoUploadInfo {
                            id: "test".into(),
                            link: "https://example.invalid/s/test".into(),
                            config: cap_project::S3UploadMeta { id: "test".into() },
                        };
                        persist_instant_meta(&completed, &video, &stopped_lock)
                    } else {
                        mark_instant_recording_stopped(&stopped_dir, &stopped_lock)
                    }
                });
                let failed = scope.spawn(move || {
                    failed_barrier.wait();
                    persist_instant_upload_failure(&failed_dir, "offline", &failed_lock)
                });
                stopped.join().unwrap().unwrap();
                failed.join().unwrap().unwrap();
            });

            let meta = cap_project::RecordingMeta::load_for_project(&dir).unwrap();
            assert!(matches!(
                (finalized, meta.inner),
                (
                    false,
                    cap_project::RecordingMetaInner::Instant(
                        cap_project::InstantRecordingMeta::InProgress { recording: false },
                    )
                ) | (
                    true,
                    cap_project::RecordingMetaInner::Instant(
                        cap_project::InstantRecordingMeta::Complete {
                            fps: 30,
                            sample_rate: Some(48_000)
                        },
                    )
                )
            ));
            assert!(matches!(
                meta.upload,
                Some(cap_project::UploadMeta::Failed { error }) if error == "offline"
            ));
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    /// The bridge writes exactly `camera.backgroundBlur.mode` and nothing else
    /// -- the whole reason it is a raw-JSON merge and not a typed round trip.
    /// `ProjectConfiguration` here models a dozen sections this app has no
    /// types for, and serializing our idea of the file back over it would drop
    /// the user's timeline.
    #[test]
    fn bridging_blur_preserves_every_other_key() {
        let dir = temp_project("preserve");
        let original = serde_json::json!({
            "aspectRatio": null,
            "background": { "source": { "type": "wallpaper", "path": "sequoia/1" } },
            "camera": {
                "hide": false,
                "size": 30.0,
                "shape": "square",
                "backgroundBlur": { "mode": "off" }
            },
            "timeline": { "segments": [{ "recordingClip": 0, "start": 0.0, "end": 3.0 }] },
            "aFieldFromANewerBuild": 42
        });
        std::fs::write(
            dir.join("project-config.json"),
            serde_json::to_vec_pretty(&original).unwrap(),
        )
        .unwrap();

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Light));

        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "light");
        assert_eq!(written["camera"]["size"], 30.0);
        assert_eq!(written["camera"]["shape"], "square");
        assert_eq!(written["background"], original["background"]);
        assert_eq!(written["timeline"], original["timeline"]);
        assert_eq!(written["aFieldFromANewerBuild"], 42);
        assert_eq!(
            written.as_object().unwrap().len(),
            original.as_object().unwrap().len(),
            "no keys added or dropped"
        );

        // Heavy overwrites Light in place, and Off is written just as
        // explicitly -- `project_config_from_recording` always assigns the
        // field, it does not skip the default.
        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Heavy));
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "heavy");

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Off));
        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "off");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A config written by a build that predates `backgroundBlur` (or one that
    /// never had a camera section at all) gets the key created rather than
    /// being skipped.
    #[test]
    fn bridging_blur_creates_the_missing_section() {
        let dir = temp_project("create");
        std::fs::write(dir.join("project-config.json"), br#"{"aspectRatio":null}"#).unwrap();

        assert!(apply_camera_blur_to_project_config(&dir, BlurMode::Heavy));

        let written: Value =
            serde_json::from_slice(&std::fs::read(dir.join("project-config.json")).unwrap())
                .unwrap();
        assert_eq!(written["camera"]["backgroundBlur"]["mode"], "heavy");
        assert!(written.get("aspectRatio").is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The store rule, on the other shared file: a config that does not parse
    /// is never replaced. Overwriting it would delete the user's edit.
    #[test]
    fn a_corrupt_project_config_is_never_overwritten() {
        let dir = temp_project("corrupt");
        let path = dir.join("project-config.json");
        std::fs::write(&path, b"{ this is not json").unwrap();

        assert!(!apply_camera_blur_to_project_config(&dir, BlurMode::Light));
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");

        // And a project with no config at all is a no-op, not a fresh file:
        // the config is cap-recording's to write.
        let empty = temp_project("empty");
        assert!(!apply_camera_blur_to_project_config(
            &empty,
            BlurMode::Light
        ));
        assert!(!empty.join("project-config.json").exists());

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&empty).ok();
    }

    /// The delete guard refuses anything that could reach outside the
    /// recordings library -- `..` components before any IO at all, and a path
    /// that is not under the library root. (The happy path is exercised by
    /// the editor-append flow; it depends on the user's configured library
    /// location, which a unit test must not touch.)
    #[test]
    fn recording_delete_guards_the_library_root() {
        assert!(delete_recording_directory(std::path::Path::new("/tmp/../etc")).is_err());
        assert!(
            delete_recording_directory(std::path::Path::new(
                "/System/definitely-not-the-cap-library.cap"
            ))
            .is_err()
        );
    }

    /// The spelling has to match `BackgroundBlurMode`'s serde exactly or the
    /// editor's `#[serde(default)]` would quietly swallow the value.
    #[test]
    fn blur_modes_use_the_project_crates_spelling() {
        for (mode, json) in [
            (BlurMode::Off, "off"),
            (BlurMode::Light, "light"),
            (BlurMode::Heavy, "heavy"),
        ] {
            assert_eq!(blur_mode_json(mode), json);
            let parsed: cap_project::BackgroundBlurMode =
                serde_json::from_value(Value::String(json.to_string()))
                    .expect("the project crate parses what we write");
            assert_eq!(
                serde_json::to_value(parsed).unwrap(),
                Value::String(json.to_string())
            );
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod capture_stop_contract_tests {
    use super::*;

    #[tokio::test]
    async fn failed_capture_stop_retains_retry_and_never_runs_finalization() {
        let (stopped, result) = finish_after_capture_stop(
            async { anyhow::bail!("cleanup unconfirmed") },
            |(): ()| async { panic!("Failed capture must not finalize") },
        )
        .await;
        assert!(!stopped);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("cleanup unconfirmed")
        );
    }

    #[tokio::test]
    async fn failed_finalization_after_confirmed_capture_stop_is_safe_to_release() {
        let (stopped, result) = finish_after_capture_stop(async { Ok(()) }, |()| async {
            anyhow::bail!("remux failed")
        })
        .await;
        assert!(stopped);
        assert!(result.unwrap_err().to_string().contains("remux failed"));
    }

    #[tokio::test]
    async fn pending_capture_stop_cannot_finalize_or_acknowledge_success() {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let future = finish_after_capture_stop(async { stop_rx.await.unwrap() }, |()| async {
            Ok(PathBuf::from("saved-project"))
        });
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        stop_tx.send(Ok(())).unwrap();
        let (stopped, result) = future.await;
        assert!(stopped);
        assert_eq!(result.unwrap(), PathBuf::from("saved-project"));
    }
    #[tokio::test]
    async fn finalization_panic_preserves_the_successful_capture_stop_acknowledgement() {
        let (stopped, result) =
            finish_after_capture_stop(async { Ok(()) }, |()| async { panic!("post-stop failure") })
                .await;
        assert!(stopped);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("after capture stopped")
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod instant_lifecycle_tests {
    use super::*;
    use instant_recording::InstantQuiescence;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn dropping_unpolled_start_or_cancelling_before_build_never_runs_setup() {
        let attempt = InstantAttempt::new();
        let future = owned_instant_start::<(), _>(
            attempt.clone(),
            async { panic!("Unpolled setup must not run") },
            |()| async { Ok(()) },
        );
        drop(future);
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
        let attempt = InstantAttempt::new();
        attempt.cancel();
        let result = owned_instant_start(attempt.clone(), async { Ok(()) }, |()| async {
            panic!("No active recording exists")
        })
        .await;
        assert!(result.is_err());
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
    }

    #[tokio::test]
    async fn dropped_start_waiter_keeps_lifecycle_until_owned_setup_is_dropped() {
        let attempt = InstantAttempt::new();
        let builder =
            instant_recording::Actor::builder(PathBuf::new(), ScreenCaptureTarget::CameraOnly);
        attempt.attach(builder.lifecycle()).unwrap();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(owned_instant_start(
            attempt.clone(),
            async move {
                let _builder = builder;
                started.send(()).unwrap();
                std::future::pending::<anyhow::Result<()>>().await
            },
            |()| async { Ok(()) },
        ));
        started_rx.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), attempt.wait_for_quiescence())
                .await
                .unwrap(),
            InstantQuiescence::Joined
        );
    }

    #[tokio::test]
    async fn cancelled_successful_setup_waits_for_owned_cleanup_before_reveal() {
        let attempt = InstantAttempt::new();
        let build_attempt = attempt.clone();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let cleanup = Arc::new(Mutex::new(Some((entered, released))));
        let task = tokio::spawn(owned_instant_start(
            attempt.clone(),
            async move {
                build_attempt.cancel();
                Ok(())
            },
            move |()| {
                let (entered, released) = cleanup.lock().unwrap().take().unwrap();
                async move {
                    entered.send(()).unwrap();
                    released.await.unwrap();
                    Ok(())
                }
            },
        ));
        entered_rx.await.unwrap();
        assert_eq!(attempt.quiescence(), InstantQuiescence::Pending);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), attempt.wait_for_quiescence())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        assert!(task.await.unwrap().is_err());
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
    }

    #[tokio::test]
    async fn startup_panic_is_unconfirmed_even_without_a_live_core_handle() {
        let attempt = InstantAttempt::new();
        let result = owned_instant_start(
            attempt.clone(),
            async { Err::<(), _>(anyhow!("setup failed")) },
            |()| async { Ok(()) },
        )
        .await;
        assert!(result.unwrap_err().to_string().contains("setup failed"));
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
        let attempt = InstantAttempt::new();
        let result = owned_instant_start::<(), _>(
            attempt.clone(),
            async { panic!("setup panic") },
            |()| async { Ok(()) },
        )
        .await;
        assert!(result.is_err());
        attempt.cancel();
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Unconfirmed
        );
    }

    #[tokio::test]
    async fn actor_error_waits_for_joined_acknowledgement_and_retains_error() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let (joined, joined_rx) = tokio::sync::oneshot::channel();
        let future = run_instant_operation(
            async { Err::<(), _>(anyhow!("required audio failed")) },
            move || {
                cancel.store(true, Ordering::Release);
            },
            async { joined_rx.await.unwrap() },
        );
        tokio::pin!(future);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut future)
                .await
                .is_err()
        );
        assert!(cancelled.load(Ordering::Acquire));
        joined.send(InstantQuiescence::Joined).unwrap();
        let (safe, result) = future.await;
        assert!(safe);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("required audio failed")
        );
    }

    #[tokio::test]
    async fn actor_transport_error_or_success_cannot_override_unconfirmed_cleanup() {
        for succeeds in [false, true] {
            let (safe, result) = run_instant_operation(
                async move {
                    if succeeds {
                        Ok(())
                    } else {
                        Err(anyhow!("actor no longer exists"))
                    }
                },
                || {},
                async { InstantQuiescence::Unconfirmed },
            )
            .await;
            assert!(!safe);
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn successful_joined_operation_retains_success_without_requesting_cancellation() {
        let builder =
            instant_recording::Actor::builder(PathBuf::new(), ScreenCaptureTarget::CameraOnly);
        let lifecycle = builder.lifecycle();
        drop(builder);
        let (safe, result) =
            joined_instant_result(lifecycle, async { Ok(PathBuf::from("completed")) }).await;
        assert!(safe);
        assert_eq!(result.unwrap(), PathBuf::from("completed"));
    }
    #[tokio::test]
    async fn reused_start_attempt_cannot_replace_or_cancel_the_original_owner() {
        let attempt = InstantAttempt::new();
        let (started, started_rx) = tokio::sync::oneshot::channel();
        let first = tokio::spawn(owned_instant_start(
            attempt.clone(),
            async move {
                started.send(()).unwrap();
                std::future::pending::<anyhow::Result<()>>().await
            },
            |()| async { Ok(()) },
        ));
        started_rx.await.unwrap();
        let second =
            owned_instant_start(attempt.clone(), async { Ok(()) }, |()| async { Ok(()) }).await;
        assert!(second.is_err());
        assert!(!*attempt.0.cancelled.borrow());
        attempt.cancel();
        assert!(first.await.unwrap().is_err());
        assert_eq!(
            attempt.wait_for_quiescence().await,
            InstantQuiescence::Joined
        );
    }
    #[tokio::test]
    async fn dropped_operation_waiter_does_not_release_serialization_before_owned_work_finishes() {
        let serialized = Arc::new(tokio::sync::Mutex::new(()));
        let first_lock = serialized.clone();
        let revoked = Arc::new(AtomicBool::new(false));
        let revoke = revoked.clone();
        let finished = Arc::new(AtomicBool::new(false));
        let first_finished = finished.clone();
        let (entered, entered_rx) = tokio::sync::oneshot::channel();
        let (release, wait) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(owned_instant_operation(
            async move {
                let _held = first_lock.lock().await;
                entered.send(()).unwrap();
                wait.await.unwrap();
                first_finished.store(true, Ordering::Release);
                (true, Ok(PathBuf::from("preserved")))
            },
            move || {
                revoke.store(true, Ordering::Release);
            },
        ));
        entered_rx.await.unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(revoked.load(Ordering::Acquire));
        let retry = serialized.lock();
        tokio::pin!(retry);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut retry)
                .await
                .is_err()
        );
        assert!(!finished.load(Ordering::Acquire));
        release.send(()).unwrap();
        let _joined = retry.await;
        assert!(finished.load(Ordering::Acquire));
    }
}

#[cfg(test)]
mod failed_capture_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn startup_metadata_error_waits_for_actual_cleanup_future() {
        let (release, wait) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(finish_windows_startup_setup(
            Err::<(), _>(anyhow!("metadata denied")),
            async { wait.await.map_err(anyhow::Error::from) },
        ));
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        release.send(()).unwrap();
        assert_eq!(
            task.await.unwrap().unwrap_err().to_string(),
            "metadata denied"
        );
    }

    #[tokio::test]
    async fn startup_cleanup_error_retains_original_failure() {
        let error =
            finish_windows_startup_setup(Err::<(), _>(anyhow!("upload setup failed")), async {
                Err(anyhow!("stop failed"))
            })
            .await
            .unwrap_err();
        let chain = format!("{error:#}");
        assert!(chain.contains("upload setup failed"));
        assert!(chain.contains("stop failed"));
    }

    #[tokio::test]
    async fn successful_startup_setup_does_not_cancel_capture() {
        let output = finish_windows_startup_setup(Ok(7), async {
            panic!("successful capture must not be cancelled")
        })
        .await
        .unwrap();
        assert_eq!(output, 7);
    }

    #[tokio::test]
    async fn cancellation_error_never_persists_stopped_or_reports_success() {
        let written = AtomicBool::new(false);
        let (stopped, result) =
            finish_failed_capture(async { Err(anyhow!("cancel failed")) }, || {
                written.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(!stopped);
        assert!(!written.load(Ordering::SeqCst));
        assert!(format!("{:#}", result.unwrap_err()).contains("cancel failed"));
    }

    #[tokio::test]
    async fn acknowledged_cancel_only_persists_stopped_and_keeps_failure() {
        let written = AtomicBool::new(false);
        let (stopped, result) = finish_failed_capture(async { Ok(()) }, || {
            written.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert!(stopped);
        assert!(written.load(Ordering::SeqCst));
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn metadata_failure_preserves_error_after_acknowledged_cancel() {
        let (stopped, result) =
            finish_failed_capture(async { Ok(()) }, || Err(anyhow!("metadata denied"))).await;
        assert!(stopped);
        assert!(format!("{:#}", result.unwrap_err()).contains("metadata denied"));
    }

    #[tokio::test]
    async fn held_cancel_cannot_persist_metadata_early() {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let written = Arc::new(AtomicBool::new(false));
        let observed = written.clone();
        let task = tokio::spawn(async move {
            finish_failed_capture(
                async { receiver.await.map_err(anyhow::Error::from) },
                || {
                    observed.store(true, Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!written.load(Ordering::SeqCst));
        sender.send(()).unwrap();
        let (stopped, result) = task.await.unwrap();
        assert!(stopped);
        assert!(result.is_err());
    }
}

#[cfg(all(test, target_os = "linux"))]
mod studio_report_completion_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn conflicting_studio_action_cannot_authorize_local_completion() {
        let effects = AtomicUsize::new(0);
        let (joined, result) = finish_studio_after_join(
            async {
                studio_recording::StudioStopReport {
                    accepted_intent: false,
                    quiescence: studio_recording::StudioQuiescence::Joined,
                    result: Err("Discard owns terminal action".into()),
                }
            },
            |_| async {
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(!joined);
        assert!(result.is_err());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn joined_required_track_failure_never_finalizes_as_success() {
        let effects = AtomicUsize::new(0);
        let (joined, result) = finish_studio_after_join(
            async {
                studio_recording::StudioStopReport {
                    accepted_intent: true,
                    quiescence: studio_recording::StudioQuiescence::Joined,
                    result: Err("DeviceNotFound".into()),
                }
            },
            |_| async {
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(joined);
        assert!(result.is_err());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }
}

#[cfg(all(test, windows))]
mod windows_studio_stop_tests {
    use super::*;

    #[tokio::test]
    async fn studio_stop_error_never_finalizes_or_acknowledges_cleanup() {
        let called = std::sync::atomic::AtomicBool::new(false);
        let (acknowledged, result) = finish_after_capture_stop(
            async { Err::<(), _>(anyhow!("encoder join timed out")) },
            |_| async {
                called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(PathBuf::new())
            },
        )
        .await;
        assert!(!acknowledged);
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("encoder join timed out")
        );
        assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn healthy_studio_stop_retains_existing_finalization() {
        let (acknowledged, result) = finish_after_capture_stop(async { Ok(()) }, |_| async {
            Ok(PathBuf::from("preserved.cap"))
        })
        .await;
        assert!(acknowledged);
        assert_eq!(result.unwrap(), PathBuf::from("preserved.cap"));
    }
}
