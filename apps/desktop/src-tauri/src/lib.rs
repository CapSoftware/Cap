#![recursion_limit = "256"]

mod api;
mod audio;
mod audio_meter;
mod auth;
mod camera;
mod camera_legacy;
mod captions;
mod deeplink_actions;
mod editor_window;
mod exit_shutdown;
mod export;
mod fake_window;
mod flags;
mod frame_ws;
mod general_settings;
mod hotkeys;
mod http_client;
mod import;
mod logging;
mod notifications;
mod panel_manager;
mod permissions;
mod platform;
mod posthog;
mod power_observer;
mod presets;
mod recording;
mod recording_settings;
mod recording_telemetry;
mod recovery;
mod screenshot_editor;
mod target_select_overlay;
mod thumbnails;
mod tray;
mod update_project_names;
mod upload;
pub mod web_api;
mod window_exclusion;
mod window_position_persistence;
mod windows;

use audio::AppSounds;
use auth::{AuthStore, Plan};
use camera::{CameraPreviewManager, CameraPreviewState};
use cap_editor::{EditorInstance, EditorState};
use cap_project::{
    InstantRecordingMeta, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SharingMeta,
    StudioRecordingMeta, StudioRecordingStatus, UploadMeta, VideoUploadInfo, XY, ZoomSegment,
};
use cap_recording::{
    RecordingMode,
    feeds::{
        self,
        camera::{CameraFeed, DeviceOrModelID},
        microphone::{self, MicrophoneFeed},
    },
    sources::screen_capture::ScreenCaptureTarget,
};
use cap_rendering::ProjectRecordingsMeta;
use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContext};
use cpal::StreamError;
use editor_window::{EditorInstances, WindowEditorInstance};
use ffmpeg::ffi::AV_TIME_BASE;
use general_settings::GeneralSettingsStore;
use kameo::{Actor, actor::ActorRef};
use notifications::NotificationType;
use recording::{InProgressRecording, RecordingEvent, RecordingInputKind};
use scap_targets::{Display, DisplayId, WindowId, bounds::LogicalBounds};
use screenshot_editor::{
    PendingScreenshotEditorInstances, ScreenshotEditorInstances, WindowScreenshotEditorInstance,
    create_screenshot_editor_instance, render_screenshot_for_export, render_screenshot_png,
    update_screenshot_config,
};

mod gpu_context;
pub use gpu_context::{PendingScreenshot, PendingScreenshots};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{
    collections::{BTreeMap, HashSet},
    future::Future,
    marker::PhantomData,
    path::{Path, PathBuf},
    process::Command,
    str::FromStr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Listener;
use tauri::{AppHandle, Manager, State, Window, WindowEvent, ipc::Channel};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_specta::Event;
use tokio::sync::{Mutex, RwLock, oneshot, watch};
use tracing::*;
use upload::{create_or_get_video, upload_image, upload_video};
use web_api::AuthedApiError;
use web_api::ManagerExt as WebManagerExt;
use windows::{
    CapWindowId, EditorWindowIds, ScreenshotEditorWindowIds, ShowCapWindow, hide_overlay,
    set_window_transparent, show_overlay,
};

use crate::{recording::start_recording, upload::build_video_meta};
use crate::{
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    upload::InstantMultipartUpload,
};
use exit_shutdown::{AppExitAction, app_exit_action, collect_device_inventory, run_while_active};

type FinalizingRecordingsMap =
    std::collections::HashMap<PathBuf, (watch::Sender<bool>, watch::Receiver<bool>)>;

#[derive(Default)]
pub struct FinalizingRecordings {
    recordings: std::sync::Mutex<FinalizingRecordingsMap>,
}

pub struct CameraWindowCloseGate(AtomicBool);

impl Default for CameraWindowCloseGate {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

impl CameraWindowCloseGate {
    pub fn allow_close(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn set_allow_close(&self, value: bool) {
        self.0.store(value, Ordering::Release);
    }
}

pub struct AppExitState(AtomicBool);

impl Default for AppExitState {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

impl AppExitState {
    pub fn begin(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub fn is_exiting(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub struct MainWindowReadyState(AtomicBool);

impl Default for MainWindowReadyState {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

impl MainWindowReadyState {
    pub fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub fn set_ready(&self, value: bool) {
        self.0.store(value, Ordering::Release);
    }
}

const APP_EXIT_STEP_TIMEOUT: Duration = Duration::from_millis(750);
const APP_EXIT_CAMERA_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(1200);
const APP_EXIT_TOTAL_TIMEOUT: Duration = Duration::from_secs(3);
const APP_EXIT_FORCE_TIMEOUT: Duration = Duration::from_secs(8);

async fn await_exit_step<T, E, F>(name: &'static str, timeout: Duration, fut: F) -> Option<T>
where
    E: std::fmt::Display,
    F: Future<Output = Result<T, E>>,
{
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(value)) => Some(value),
        Ok(Err(err)) => {
            warn!(step = name, error = %err, "Exit cleanup step failed");
            None
        }
        Err(_) => {
            warn!(
                step = name,
                timeout_ms = timeout.as_millis(),
                "Exit cleanup step timed out"
            );
            None
        }
    }
}

fn force_exit(code: i32) -> ! {
    unsafe extern "C" {
        fn _exit(code: i32) -> !;
    }
    unsafe { _exit(code) }
}

fn spawn_exit_watchdog() {
    std::thread::spawn(move || {
        std::thread::sleep(APP_EXIT_FORCE_TIMEOUT);
        error!(
            timeout_ms = APP_EXIT_FORCE_TIMEOUT.as_millis(),
            "Forcing process exit after shutdown deadline"
        );
        force_exit(0);
    });
}

pub(crate) fn app_is_exiting(app: &AppHandle) -> bool {
    match app.try_state::<AppExitState>() {
        Some(state) => state.is_exiting(),
        None => false,
    }
}

fn should_show_onboarding(app: &AppHandle) -> bool {
    let settings = GeneralSettingsStore::get(app).ok().flatten();
    let startup_completed = settings
        .as_ref()
        .map(|s| s.has_completed_startup)
        .unwrap_or(false);
    let onboarding_completed = settings
        .as_ref()
        .map(|s| s.has_completed_onboarding)
        .unwrap_or(false);

    !startup_completed
        || !onboarding_completed
        || !permissions::do_permissions_check(false).necessary_granted()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug)]
pub struct CameraWindowPositionGuard {
    ignore_until_ms: AtomicU64,
}

impl Default for CameraWindowPositionGuard {
    fn default() -> Self {
        Self {
            ignore_until_ms: AtomicU64::new(0),
        }
    }
}

impl CameraWindowPositionGuard {
    pub fn ignore_for(&self, duration_ms: u64) {
        let now = now_millis();
        let until = now.saturating_add(duration_ms);
        self.ignore_until_ms.store(until, Ordering::Release);
    }

    pub fn should_ignore(&self) -> bool {
        let now = now_millis();
        now < self.ignore_until_ms.load(Ordering::Acquire)
    }
}

pub type CameraWindowOperationLock = Mutex<()>;

impl FinalizingRecordings {
    pub fn start_finalizing(&self, path: PathBuf) -> watch::Receiver<bool> {
        let mut recordings = self
            .recordings
            .lock()
            .expect("FinalizingRecordings mutex poisoned");
        let (tx, rx) = watch::channel(false);
        recordings.insert(path, (tx, rx.clone()));
        rx
    }

    pub fn finish_finalizing(&self, path: &Path) {
        let mut recordings = self
            .recordings
            .lock()
            .expect("FinalizingRecordings mutex poisoned");
        if let Some((tx, _)) = recordings.remove(path)
            && tx.send(true).is_err()
        {
            debug!("Finalizing receiver dropped for path: {:?}", path);
        }
    }

    pub fn is_finalizing(&self, path: &Path) -> Option<watch::Receiver<bool>> {
        let recordings = self.recordings.lock().unwrap();
        recordings.get(path).map(|(_, rx)| rx.clone())
    }
}

#[allow(clippy::large_enum_variant)]
pub enum RecordingState {
    None,
    Pending {
        mode: RecordingMode,
        target: ScreenCaptureTarget,
    },
    Active(InProgressRecording),
}

pub struct App {
    #[deprecated = "can be removed when native camera preview is ready"]
    camera_ws_port: u16,
    #[deprecated = "can be removed when native camera preview is ready"]
    camera_ws_sender: flume::Sender<cap_recording::FFmpegVideoFrame>,
    camera_preview: CameraPreviewManager,
    camera_blur_tx: tokio::sync::watch::Sender<cap_project::BackgroundBlurMode>,
    handle: AppHandle,
    recording_state: RecordingState,
    recording_logging_handle: LoggingHandle,
    mic_feed: ActorRef<feeds::microphone::MicrophoneFeed>,
    mic_meter_sender: flume::Sender<microphone::MicrophoneSamples>,
    selected_mic_label: Option<String>,
    selected_camera_id: Option<DeviceOrModelID>,
    camera_in_use: bool,
    camera_cleanup_done: bool,
    camera_feed: ActorRef<feeds::camera::CameraFeed>,
    server_url: String,
    logs_dir: PathBuf,
    disconnected_inputs: HashSet<RecordingInputKind>,
    was_camera_only_recording: bool,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Screen,
    Output,
    Camera,
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub enum UploadResult {
    Success(String),
    NotAuthenticated,
    PlanCheckFailed,
    UpgradeRequired,
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct VideoRecordingMetadata {
    pub duration: f64,
    pub size: f64,
}

impl App {
    pub fn set_pending_recording(&mut self, mode: RecordingMode, target: ScreenCaptureTarget) {
        self.recording_state = RecordingState::Pending { mode, target };
        CurrentRecordingChanged.emit(&self.handle).ok();
    }

    pub fn set_current_recording(&mut self, actor: InProgressRecording) {
        self.recording_state = RecordingState::Active(actor);
        CurrentRecordingChanged.emit(&self.handle).ok();
    }

    pub fn clear_current_recording(&mut self) -> Option<InProgressRecording> {
        match std::mem::replace(&mut self.recording_state, RecordingState::None) {
            RecordingState::Active(recording) => {
                self.close_occluder_windows();
                Some(recording)
            }
            _ => {
                self.close_occluder_windows();
                None
            }
        }
    }

    fn close_occluder_windows(&self) {
        for window in self.handle.webview_windows() {
            if window.0.starts_with("window-capture-occluder-") {
                let _ = window.1.close();
            }
        }
    }

    async fn restart_mic_feed(&mut self) -> Result<(), String> {
        info!("Restarting microphone feed after actor shutdown");

        let (error_tx, error_rx) = flume::bounded(1);
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));

        spawn_mic_error_handler(self.handle.clone(), error_rx);

        mic_feed
            .ask(microphone::AddSender(self.mic_meter_sender.clone()))
            .await
            .map_err(|e| e.to_string())?;

        if let Some(label) = self.selected_mic_label.clone() {
            match mic_feed.ask(microphone::SetInput { label }).await {
                Ok(ready) => {
                    if let Err(err) = ready.await {
                        if matches!(err, microphone::SetInputError::DeviceNotFound) {
                            warn!("Selected microphone not available while restarting feed");
                        } else {
                            return Err(err.to_string());
                        }
                    }
                }
                Err(kameo::error::SendError::HandlerError(
                    microphone::SetInputError::DeviceNotFound,
                )) => {
                    warn!("Selected microphone not available while restarting feed");
                }
                Err(err) => return Err(err.to_string()),
            }
        }

        self.mic_feed = mic_feed;

        Ok(())
    }

    async fn add_recording_logging_handle(&mut self, path: &PathBuf) -> Result<(), String> {
        let logfile =
            std::fs::File::create(path).map_err(|e| format!("Failed to create logfile: {e}"))?;

        self.recording_logging_handle
            .reload(Some(Box::new(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_target(true)
                    .with_writer(logfile),
            ) as DynLoggingLayer))
            .map_err(|e| format!("Failed to reload logging layer: {e}"))?;

        Ok(())
    }

    pub fn current_recording(&self) -> Option<&InProgressRecording> {
        match &self.recording_state {
            RecordingState::Active(recording) => Some(recording),
            _ => None,
        }
    }

    pub fn current_recording_mut(&mut self) -> Option<&mut InProgressRecording> {
        match &mut self.recording_state {
            RecordingState::Active(recording) => Some(recording),
            _ => None,
        }
    }

    pub fn is_recording_active_or_pending(&self) -> bool {
        !matches!(self.recording_state, RecordingState::None)
    }

    async fn handle_input_disconnect(&mut self, kind: RecordingInputKind) -> Result<(), String> {
        if !self.disconnected_inputs.insert(kind) {
            return Ok(());
        }

        let (title, body) = match kind {
            RecordingInputKind::Microphone => (
                "Microphone disconnected",
                "Recording continues. Silence will be used until the microphone reconnects.",
            ),
            RecordingInputKind::Camera => (
                "Camera disconnected",
                "Recording continues without camera. Camera overlay will resume when the device reconnects.",
            ),
        };

        let _ = NewNotification {
            title: title.to_string(),
            body: body.to_string(),
            is_error: false,
        }
        .emit(&self.handle);

        let _ = RecordingEvent::InputLost { input: kind }.emit(&self.handle);

        Ok(())
    }

    async fn handle_input_restored(&mut self, kind: RecordingInputKind) -> Result<(), String> {
        if !self.disconnected_inputs.remove(&kind) {
            return Ok(());
        }

        match kind {
            RecordingInputKind::Microphone => {
                self.ensure_selected_mic_ready().await.ok();
            }
            RecordingInputKind::Camera => match self.ensure_selected_camera_ready().await {
                Ok(()) => {
                    info!("Camera reconnected and reinitialized successfully");
                    let _ = NewNotification {
                        title: "Camera reconnected".to_string(),
                        body: "Camera overlay has been restored.".to_string(),
                        is_error: false,
                    }
                    .emit(&self.handle);
                }
                Err(e) => {
                    warn!(error = %e, "Failed to reinitialize camera after reconnect, will retry on next poll");
                    self.disconnected_inputs.insert(RecordingInputKind::Camera);
                    return Ok(());
                }
            },
        }

        let _ = RecordingEvent::InputRestored { input: kind }.emit(&self.handle);

        Ok(())
    }

    async fn ensure_selected_mic_ready(&mut self) -> Result<(), String> {
        if let Some(label) = self.selected_mic_label.clone() {
            let ready = self
                .mic_feed
                .ask(feeds::microphone::SetInput { label })
                .await
                .map_err(|e| e.to_string())?;

            ready.await.map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    async fn ensure_selected_camera_ready(&mut self) -> Result<(), String> {
        if let Some(id) = self.selected_camera_id.clone() {
            let ready = self
                .camera_feed
                .ask(feeds::camera::SetInput { id: id.clone() })
                .await
                .map_err(|e| e.to_string())?;

            ready.await.map_err(|e| e.to_string())?;
        }

        Ok(())
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(state))]
pub(crate) async fn set_mic_input(state: MutableState<'_, App>, label: Option<String>) -> Result<(), String> {
    let desired_label = label;

    let (mic_feed, studio_handle, previous_label) = {
        let mut app = state.write().await;
        if desired_label == app.selected_mic_label {
            return Ok(());
        }

        let handle = match app.current_recording() {
            Some(InProgressRecording::Studio { handle, .. }) => Some(handle.clone()),
            _ => None,
        };

        let previous_label = app.selected_mic_label.clone();
        app.selected_mic_label = desired_label.clone();

        (app.mic_feed.clone(), handle, previous_label)
    };

    let has_studio = studio_handle.is_some();

    let apply_result = async {
        if let Some(handle) = &studio_handle {
            handle.set_mic_feed(None).await.map_err(|e| e.to_string())?;
        }

        match desired_label.as_ref() {
            None => {
                let remove_result = mic_feed
                    .ask(microphone::RemoveInput)
                    .await
                    .map_err(|e| e.to_string());

                match remove_result {
                    Ok(()) => {}
                    Err(e) if has_studio && e.contains("FeedLocked") => {
                        info!("Microphone feed locked by recording, deselection applied at studio level");
                    }
                    Err(e) => return Err(e),
                }
            }
            Some(label) => {
                mic_feed
                    .ask(feeds::microphone::SetInput {
                        label: label.clone(),
                    })
                    .await
                    .map_err(|e| e.to_string())?
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }

        if let Some(handle) = studio_handle
            && desired_label.is_some()
        {
            let mic_lock = mic_feed
                .ask(microphone::Lock)
                .await
                .map_err(|e| e.to_string())?;
            handle
                .set_mic_feed(Some(Arc::new(mic_lock)))
                .await
                .map_err(|e| e.to_string())?;
        }

        Ok::<(), String>(())
    }
    .await;

    match apply_result {
        Ok(()) => {
            let mut app = state.write().await;
            let cleared = app
                .disconnected_inputs
                .remove(&RecordingInputKind::Microphone);

            if cleared {
                let _ = RecordingEvent::InputRestored {
                    input: RecordingInputKind::Microphone,
                }
                .emit(&app.handle);
            }

            Ok(())
        }
        Err(err) => {
            let mut app = state.write().await;
            if app.selected_mic_label == desired_label {
                app.selected_mic_label = previous_label;
            }
            Err(err)
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn upload_logs(app_handle: AppHandle) -> Result<(), String> {
    logging::upload_log_file(&app_handle).await
}

#[tauri::command]
#[specta::specta]
fn get_system_diagnostics() -> cap_recording::diagnostics::SystemDiagnostics {
    cap_recording::diagnostics::collect_diagnostics()
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app_handle, state))]
#[allow(unused_mut)]
pub(crate) async fn set_camera_input(
    app_handle: AppHandle,
    state: MutableState<'_, App>,
    id: Option<DeviceOrModelID>,
    skip_camera_window: Option<bool>,
) -> Result<(), String> {
    let operation_lock = app_handle.state::<CameraWindowOperationLock>();
    let _operation_guard = operation_lock.lock().await;

    let app = state.read().await;
    let camera_feed = app.camera_feed.clone();
    let studio_handle = match app.current_recording() {
        Some(InProgressRecording::Studio { handle, .. }) => Some(handle.clone()),
        _ => None,
    };
    let current_id = app.selected_camera_id.clone();
    let camera_in_use = app.camera_in_use;
    drop(app);

    let skip_camera_window = skip_camera_window.unwrap_or(false);

    if id == current_id && camera_in_use {
        if id.is_some() && !skip_camera_window {
            let camera_window_is_visible = CapWindowId::Camera
                .get(&app_handle)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);

            let show_result = if camera_window_is_visible {
                Ok(())
            } else {
                ShowCapWindow::Camera { centered: false }
                    .show(&app_handle)
                    .await
                    .map(|_| ())
            };

            show_result
                .map_err(|err| error!("Failed to show camera preview window: {err}"))
                .ok();
        }

        return Ok(());
    }

    if let Some(handle) = &studio_handle {
        handle
            .set_camera_feed(None)
            .await
            .map_err(|e| e.to_string())?;
    }

    match &id {
        None => {
            {
                let app = &mut *state.write().await;
                app.camera_in_use = false;
                app.selected_camera_id = None;
                app.camera_preview.pause();
            };

            camera_feed
                .ask(feeds::camera::RemoveInput)
                .await
                .map_err(|e| e.to_string())?;
        }
        Some(id) => {
            let (camera_ws_sender, native_preview_active) = {
                let app = &mut *state.write().await;
                app.selected_camera_id = Some(id.clone());
                app.camera_in_use = true;
                app.camera_cleanup_done = false;
                #[allow(deprecated)]
                (
                    app.camera_ws_sender.clone(),
                    app.camera_preview.is_initialized(),
                )
            };

            if native_preview_active {
                #[allow(deprecated)]
                let result = camera_feed
                    .ask(feeds::camera::RemoveSender(camera_ws_sender))
                    .await;
                if let Err(err) = result {
                    warn!(error = %err, "Failed to remove camera sender");
                }
            } else {
                #[allow(deprecated)]
                let result = camera_feed
                    .ask(feeds::camera::AddSender(camera_ws_sender))
                    .await;
                if let Err(err) = result {
                    warn!(error = %err, "Failed to add camera sender");
                }
            }

            let mut attempts = 0;
            let init_result: Result<(), String> = loop {
                attempts += 1;

                let request = camera_feed
                    .ask(feeds::camera::SetInput { id: id.clone() })
                    .await
                    .map_err(|e| e.to_string());

                let result = match request {
                    Ok(future) => future.await.map_err(|e| e.to_string()),
                    Err(e) => Err(e),
                };

                match result {
                    Ok(_) => {
                        break Ok(());
                    }
                    Err(e) => {
                        if attempts >= 3 {
                            break Err(format!(
                                "Failed to initialize camera after {attempts} attempts: {e}"
                            ));
                        }
                        warn!(
                            "Failed to set camera input (attempt {}): {}. Retrying...",
                            attempts, e
                        );
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            };

            if let Err(e) = init_result {
                let _ = camera_feed.ask(feeds::camera::RemoveInput).await;
                let app = &mut *state.write().await;
                app.selected_camera_id = None;
                app.camera_in_use = false;
                app.camera_preview.pause();
                return Err(e);
            }

            if !skip_camera_window {
                let show_result = ShowCapWindow::Camera { centered: false }
                    .show(&app_handle)
                    .await;
                show_result
                    .map_err(|err| error!("Failed to show camera preview window: {err}"))
                    .ok();
            }
        }
    }

    if let Some(handle) = studio_handle
        && id.is_some()
    {
        let camera_lock = camera_feed
            .ask(feeds::camera::Lock)
            .await
            .map_err(|e| e.to_string())?;
        handle
            .set_camera_feed(Some(Arc::new(camera_lock)))
            .await
            .map_err(|e| e.to_string())?;
    }

    {
        let app = &mut *state.write().await;
        app.selected_camera_id = id;
        app.camera_in_use = app.selected_camera_id.is_some();
        if app.camera_in_use {
            app.camera_cleanup_done = false;
        }
        let cleared = app.disconnected_inputs.remove(&RecordingInputKind::Camera);

        if cleared {
            let _ = RecordingEvent::InputRestored {
                input: RecordingInputKind::Camera,
            }
            .emit(&app.handle);
        }
    }

    Ok(())
}

fn display_for_position(pos_x: f64, pos_y: f64) -> Option<Display> {
    Display::list().into_iter().find_map(|display| {
        let bounds = display.raw_handle().logical_bounds()?;
        let x = bounds.position().x();
        let y = bounds.position().y();
        let width = bounds.size().width();
        let height = bounds.size().height();
        if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
            Some(display)
        } else {
            None
        }
    })
}

fn display_id_for_position(pos_x: f64, pos_y: f64) -> Option<DisplayId> {
    display_for_position(pos_x, pos_y).map(|display| display.id())
}

fn monitor_name_for_position(pos_x: f64, pos_y: f64) -> Option<String> {
    display_for_position(pos_x, pos_y)
        .and_then(|display| display.name())
        .filter(|name| !name.trim().is_empty())
}

pub(crate) fn update_camera_window_position_settings(
    settings: &mut GeneralSettingsStore,
    x: f64,
    y: f64,
) {
    let display_id = display_id_for_position(x, y);
    let monitor_name = monitor_name_for_position(x, y);
    let position = general_settings::WindowPosition { x, y, display_id };
    settings.camera_window_position = Some(position.clone());
    if let Some(monitor_name) = monitor_name {
        settings
            .camera_window_positions_by_monitor_name
            .insert(monitor_name, position);
    }
}

fn spawn_mic_error_handler(app_handle: AppHandle, error_rx: flume::Receiver<StreamError>) {
    tokio::spawn(async move {
        let state = app_handle.state::<ArcLock<App>>();
        let state = state.inner().clone();

        let error_rx = error_rx;

        while let Ok(err) = error_rx.recv_async().await {
            if app_is_exiting(&app_handle) {
                break;
            }

            error!("Mic feed actor error: {err}");

            {
                let mut app = state.write().await;

                if let Err(handle_err) = app
                    .handle_input_disconnect(RecordingInputKind::Microphone)
                    .await
                {
                    warn!("Failed to handle mic disconnect event: {handle_err}");
                }
            }

            tokio::time::sleep(Duration::from_millis(500)).await;

            if app_is_exiting(&app_handle) {
                break;
            }

            let mut app = state.write().await;
            if app_is_exiting(&app_handle) {
                break;
            }
            match app.ensure_selected_mic_ready().await {
                Ok(()) => {
                    info!("Microphone stream recovered after error");
                    if let Err(restored_err) = app
                        .handle_input_restored(RecordingInputKind::Microphone)
                        .await
                    {
                        warn!("Failed to handle mic restoration: {restored_err}");
                    }
                }
                Err(restart_err) => {
                    warn!("Failed to restart microphone input after error: {restart_err}");
                }
            }
        }
    });
}

fn spawn_device_watchers(app_handle: AppHandle) {
    spawn_microphone_watcher(app_handle.clone());
    spawn_camera_watcher(app_handle);
}

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct DevicesUpdated {
    cameras: Vec<cap_camera::CameraInfo>,
    microphones: Vec<String>,
    permissions: permissions::OSPermissionsCheck,
}

#[tauri::command]
#[specta::specta]
async fn get_devices_snapshot() -> DevicesUpdated {
    let permissions = permissions::do_permissions_check(false);
    let cameras = if permissions.camera.permitted() {
        cap_camera::list_cameras().collect()
    } else {
        Vec::new()
    };
    let microphones = if permissions.microphone.permitted() {
        MicrophoneFeed::list().keys().cloned().collect()
    } else {
        Vec::new()
    };
    DevicesUpdated {
        cameras,
        microphones,
        permissions,
    }
}

fn spawn_devices_snapshot_emitter(app_handle: AppHandle) {
    tokio::spawn(async move {
        let mut last_perm_tuple: (u8, u8, u8, u8) = (255, 255, 255, 255);
        let mut last_camera_ids: Vec<String> = Vec::new();
        let mut last_mics: Vec<String> = Vec::new();
        let mut fast_loops = 0u32;
        loop {
            if app_is_exiting(&app_handle) {
                break;
            }

            if power_observer::is_system_asleep() {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }

            let permissions = permissions::do_permissions_check(false);
            let Some((cameras, microphones)) = collect_device_inventory(
                || app_is_exiting(&app_handle),
                permissions.camera.permitted(),
                permissions.microphone.permitted(),
                || cap_camera::list_cameras().collect::<Vec<_>>(),
                || MicrophoneFeed::list().keys().cloned().collect::<Vec<_>>(),
            ) else {
                break;
            };
            let perm_tuple = (
                match permissions.screen_recording {
                    permissions::OSPermissionStatus::NotNeeded => 0,
                    permissions::OSPermissionStatus::Empty => 1,
                    permissions::OSPermissionStatus::Granted => 2,
                    permissions::OSPermissionStatus::Denied => 3,
                },
                match permissions.microphone {
                    permissions::OSPermissionStatus::NotNeeded => 0,
                    permissions::OSPermissionStatus::Empty => 1,
                    permissions::OSPermissionStatus::Granted => 2,
                    permissions::OSPermissionStatus::Denied => 3,
                },
                match permissions.camera {
                    permissions::OSPermissionStatus::NotNeeded => 0,
                    permissions::OSPermissionStatus::Empty => 1,
                    permissions::OSPermissionStatus::Granted => 2,
                    permissions::OSPermissionStatus::Denied => 3,
                },
                match permissions.accessibility {
                    permissions::OSPermissionStatus::NotNeeded => 0,
                    permissions::OSPermissionStatus::Empty => 1,
                    permissions::OSPermissionStatus::Granted => 2,
                    permissions::OSPermissionStatus::Denied => 3,
                },
            );
            let camera_ids: Vec<String> =
                cameras.iter().map(|c| c.device_id().to_string()).collect();
            let mut changed = perm_tuple != last_perm_tuple;
            if !changed {
                changed = camera_ids != last_camera_ids || microphones != last_mics;
            }
            if changed && !app_is_exiting(&app_handle) {
                DevicesUpdated {
                    cameras: cameras.clone(),
                    microphones: microphones.clone(),
                    permissions: permissions.clone(),
                }
                .emit(&app_handle)
                .ok();
                last_perm_tuple = perm_tuple;
                last_camera_ids = camera_ids;
                last_mics = microphones;
            }
            let dur = if fast_loops < 10 {
                std::time::Duration::from_millis(500)
            } else {
                std::time::Duration::from_secs(5)
            };
            fast_loops = fast_loops.saturating_add(1);
            tokio::time::sleep(dur).await;

            if app_is_exiting(&app_handle) {
                break;
            }
        }
    });
}

fn spawn_system_resume_detector(app_handle: AppHandle) {
    const TICK: Duration = Duration::from_secs(5);
    const WAKE_THRESHOLD: Duration = Duration::from_secs(20);

    tokio::spawn(async move {
        let mut last_instant = std::time::Instant::now();
        let mut last_system_time = std::time::SystemTime::now();

        loop {
            if app_is_exiting(&app_handle) {
                break;
            }

            tokio::time::sleep(TICK).await;

            if app_is_exiting(&app_handle) {
                break;
            }

            let now_instant = std::time::Instant::now();
            let now_system = std::time::SystemTime::now();

            let monotonic_delta = now_instant.saturating_duration_since(last_instant);
            let wall_delta = now_system
                .duration_since(last_system_time)
                .unwrap_or_default();

            last_instant = now_instant;
            last_system_time = now_system;

            let drift = wall_delta.saturating_sub(monotonic_delta);
            let slept = drift >= WAKE_THRESHOLD || monotonic_delta >= TICK + WAKE_THRESHOLD;

            if slept {
                tracing::warn!(
                    monotonic_ms = monotonic_delta.as_millis(),
                    wall_ms = wall_delta.as_millis(),
                    "System resume drift detected; scheduling resume recovery"
                );

                schedule_resume_recovery(app_handle.clone());
            }
        }
    });
}

pub(crate) fn schedule_resume_recovery(app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if app_is_exiting(&app_handle) {
            return;
        }

        tokio::time::sleep(Duration::from_millis(500)).await;

        if app_is_exiting(&app_handle) {
            return;
        }

        #[cfg(target_os = "macos")]
        {
            let prewarmer = app_handle.state::<crate::platform::ScreenCapturePrewarmer>();
            prewarmer.request(true).await;
        }

        if !app_is_exiting(&app_handle) {
            let _ = RequestScreenCapturePrewarm { force: true }.emit(&app_handle);
        }

        if !app_is_exiting(&app_handle) {
            let snapshot = get_devices_snapshot().await;
            let _ = snapshot.emit(&app_handle);
        }
    });
}

async fn cleanup_camera_window(app: AppHandle, session_id: u64) {
    if app_is_exiting(&app) {
        return;
    }

    let state = app.state::<ArcLock<App>>();

    let camera_feed = {
        let mut app_state = state.write().await;

        if app_is_exiting(&app) {
            return;
        }

        let current_session_id = app_state
            .camera_preview
            .session_id_handle()
            .load(Ordering::Acquire);

        if current_session_id != session_id {
            tracing::info!(
                "Camera cleanup aborted: session mismatch (cleanup session {} vs current {})",
                session_id,
                current_session_id
            );
            return;
        }

        if app_state.camera_cleanup_done {
            return;
        }

        app_state.camera_cleanup_done = true;
        app_state.camera_preview.pause();

        if app_state.is_recording_active_or_pending() {
            return;
        }

        let has_visible_target_overlay = app.webview_windows().iter().any(|(label, window)| {
            label.starts_with("target-select-overlay-") && window.is_visible().unwrap_or(false)
        });

        let main_window_visible = CapWindowId::Main
            .get(&app)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);

        let is_camera_only_mode = recording_settings::RecordingSettingsStore::get(&app)
            .ok()
            .flatten()
            .and_then(|s| s.target)
            .is_some_and(|t| matches!(t, ScreenCaptureTarget::CameraOnly));

        if is_camera_only_mode && main_window_visible {
            tracing::info!("Camera cleanup: preserving camera feed for camera-only mode");
            return;
        }

        if has_visible_target_overlay {
            return;
        }

        app_state.camera_feed.clone()
    };

    let _ = tokio::time::timeout(
        APP_EXIT_STEP_TIMEOUT,
        camera_feed.ask(feeds::camera::RemoveInput),
    )
    .await;

    let mut app_state = state.write().await;
    app_state.camera_in_use = false;
}

async fn cleanup_camera_after_overlay_close(app: AppHandle, captured_session_id: u64) {
    if app_is_exiting(&app) {
        return;
    }

    let state = app.state::<ArcLock<App>>();

    let camera_feed = {
        let mut app_state = state.write().await;

        if app_is_exiting(&app) {
            return;
        }

        let current_session_id = app_state
            .camera_preview
            .session_id_handle()
            .load(Ordering::Acquire);
        if current_session_id != captured_session_id {
            tracing::info!(
                "Camera cleanup after overlay aborted: session mismatch ({} vs {})",
                captured_session_id,
                current_session_id
            );
            return;
        }

        if app_state.camera_cleanup_done {
            return;
        }

        if app_state.is_recording_active_or_pending() {
            return;
        }

        let has_camera_window = CapWindowId::Camera.get(&app).is_some();
        if has_camera_window {
            return;
        }

        let has_visible_target_overlay = app.webview_windows().iter().any(|(label, window)| {
            label.starts_with("target-select-overlay-") && window.is_visible().unwrap_or(false)
        });
        if has_visible_target_overlay {
            return;
        }

        app_state.camera_cleanup_done = true;

        if !app_state.camera_in_use {
            return;
        }

        app_state.camera_feed.clone()
    };

    let _ = camera_feed.ask(feeds::camera::RemoveInput).await;

    let mut app_state = state.write().await;
    app_state.camera_in_use = false;
}

async fn cleanup_app_resources_for_exit(app: &AppHandle) {
    power_observer::uninstall(app);
    fake_window::cancel_all_fake_window_listeners(app);
    close_target_select_overlays(app);

    let (mic_feed, camera_feed, camera_shutdown) = {
        let Some(state) = app.try_state::<ArcLock<App>>() else {
            warn!("App state unavailable during exit cleanup");
            return;
        };
        let mut app_state = state.write().await;
        let camera_shutdown = app_state.camera_preview.begin_shutdown();
        app_state.camera_in_use = false;
        app_state.selected_camera_id = None;
        (
            app_state.mic_feed.clone(),
            app_state.camera_feed.clone(),
            camera_shutdown,
        )
    };

    let _ = await_exit_step(
        "remove_microphone_input",
        APP_EXIT_STEP_TIMEOUT,
        async move { mic_feed.ask(microphone::RemoveInput).await },
    )
    .await;
    let _ = await_exit_step("remove_camera_input", APP_EXIT_STEP_TIMEOUT, async move {
        camera_feed.ask(feeds::camera::RemoveInput).await
    })
    .await;

    if let Some(rx) = camera_shutdown {
        let _ = await_exit_step(
            "camera_preview_shutdown",
            APP_EXIT_CAMERA_SHUTDOWN_TIMEOUT,
            rx,
        )
        .await;
    }

    captions::release_ml_models().await;
}

#[cfg(target_os = "macos")]
fn finalize_app_exit(app: &AppHandle, exit_code: i32) -> ! {
    let _ = app;
    sentry::Hub::with(|hub| {
        if let Some(client) = hub.client() {
            let _ = client.flush(Some(Duration::from_millis(250)));
        }
    });
    match app_exit_action(exit_code) {
        AppExitAction::Process(code) => force_exit(code),
    }
}

#[cfg(not(target_os = "macos"))]
fn finalize_app_exit(app: &AppHandle, exit_code: i32) {
    match app_exit_action(exit_code) {
        AppExitAction::Runtime(code) => app.exit(code),
    }
}

pub async fn request_app_exit(app: AppHandle) {
    let Some(exit_state) = app.try_state::<AppExitState>() else {
        warn!("Exit state unavailable while requesting app exit");
        finalize_app_exit(&app, 0);
        #[cfg(not(target_os = "macos"))]
        return;
    };

    if !exit_state.begin() {
        return;
    }

    spawn_exit_watchdog();

    if tokio::time::timeout(APP_EXIT_TOTAL_TIMEOUT, cleanup_app_resources_for_exit(&app))
        .await
        .is_err()
    {
        error!(
            timeout_ms = APP_EXIT_TOTAL_TIMEOUT.as_millis(),
            "Timed out while cleaning up app resources for exit"
        );
    }

    finalize_app_exit(&app, 0);
}

fn find_mic_by_label_or_fuzzy(
    devices: &microphone::MicrophonesMap,
    selected_label: &str,
) -> Option<String> {
    if devices.contains_key(selected_label) {
        return Some(selected_label.to_string());
    }

    let selected_lower = selected_label.to_lowercase();

    devices
        .keys()
        .find(|name| {
            let name_lower = name.to_lowercase();
            name_lower.contains(&selected_lower) || selected_lower.contains(&name_lower)
        })
        .cloned()
}

fn spawn_microphone_watcher(app_handle: AppHandle) {
    tokio::spawn(async move {
        let state = app_handle.state::<ArcLock<App>>();
        let state = state.inner().clone();

        loop {
            if app_is_exiting(&app_handle) {
                break;
            }

            if power_observer::is_system_asleep() {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }

            let (should_check, label, is_marked) = {
                let guard = state.read().await;
                (
                    matches!(guard.recording_state, RecordingState::Active(_)),
                    guard.selected_mic_label.clone(),
                    guard
                        .disconnected_inputs
                        .contains(&RecordingInputKind::Microphone),
                )
            };

            if should_check && let Some(selected_label) = label {
                let Some(devices) = run_while_active(
                    || app_is_exiting(&app_handle),
                    microphone::MicrophoneFeed::list,
                ) else {
                    break;
                };
                let matched = find_mic_by_label_or_fuzzy(&devices, &selected_label);

                if matched.is_none() && !is_marked {
                    let mut app = state.write().await;
                    if let Err(err) = app
                        .handle_input_disconnect(RecordingInputKind::Microphone)
                        .await
                    {
                        warn!("Failed to handle mic disconnect: {err}");
                    }
                } else if let Some(matched_label) = matched
                    && is_marked
                {
                    let mut app = state.write().await;

                    if matched_label != selected_label {
                        info!(
                            original = selected_label,
                            matched = matched_label,
                            "Microphone reconnected with different name (possible Bluetooth profile switch)"
                        );
                        app.selected_mic_label = Some(matched_label);
                    }

                    if let Err(err) = app
                        .handle_input_restored(RecordingInputKind::Microphone)
                        .await
                    {
                        warn!("Failed to handle mic reconnection: {err}");
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

fn spawn_camera_watcher(app_handle: AppHandle) {
    tokio::spawn(async move {
        let state = app_handle.state::<ArcLock<App>>();
        let state = state.inner().clone();

        loop {
            if app_is_exiting(&app_handle) {
                break;
            }

            if power_observer::is_system_asleep() {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }

            let (should_check, camera_id, is_marked) = {
                let guard = state.read().await;
                (
                    matches!(guard.recording_state, RecordingState::Active(_))
                        && guard.camera_in_use,
                    guard.selected_camera_id.clone(),
                    guard
                        .disconnected_inputs
                        .contains(&RecordingInputKind::Camera),
                )
            };

            if should_check && let Some(ref selected_id) = camera_id {
                let Some(available) = run_while_active(
                    || app_is_exiting(&app_handle),
                    || is_camera_available(selected_id),
                ) else {
                    break;
                };
                debug!(
                    "Camera watcher: checking availability for {:?}, available={}, is_marked={}",
                    selected_id, available, is_marked
                );

                if !available && !is_marked {
                    warn!(
                        "Camera watcher: camera {:?} detected as unavailable, continuing recording without camera",
                        selected_id
                    );
                    let mut app = state.write().await;
                    if let Err(err) = app
                        .handle_input_disconnect(RecordingInputKind::Camera)
                        .await
                    {
                        warn!("Failed to handle camera disconnect: {err}");
                    }
                } else if available && is_marked {
                    let mut app = state.write().await;
                    if let Err(err) = app.handle_input_restored(RecordingInputKind::Camera).await {
                        warn!("Failed to handle camera reconnection: {err}");
                    }
                }
            }

            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    });
}

fn is_camera_available(id: &DeviceOrModelID) -> bool {
    let cameras: Vec<_> = cap_camera::list_cameras().collect();
    debug!(
        "is_camera_available: looking for {:?} in {} cameras",
        id,
        cameras.len()
    );
    for camera in &cameras {
        debug!(
            "  - device_id={}, model_id={:?}, name={}",
            camera.device_id(),
            camera.model_id(),
            camera.display_name()
        );
    }
    cameras.iter().any(|info| match id {
        DeviceOrModelID::DeviceID(device_id) => info.device_id() == device_id,
        DeviceOrModelID::ModelID(model_id) => {
            info.model_id().is_some_and(|existing| existing == model_id)
        }
    })
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewStudioRecordingAdded {
    path: PathBuf,
}

#[derive(specta::Type, tauri_specta::Event, Debug, Clone, Serialize)]
pub struct RecordingDeleted {
    #[allow(unused)]
    path: PathBuf,
}

#[derive(specta::Type, tauri_specta::Event, Serialize)]
pub struct SetCaptureAreaPending(bool);

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewScreenshotAdded {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStarted;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStopped;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestStartRecording {
    pub mode: RecordingMode,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestOpenRecordingPicker {
    pub target_mode: Option<RecordingTargetMode>,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestSetTargetMode {
    pub target_mode: Option<RecordingTargetMode>,
    pub display_id: Option<String>,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestOpenSettings {
    page: String,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestScrollToSettingsSection {
    pub section: String,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestScreenCapturePrewarm {
    #[serde(default)]
    pub force: bool,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewNotification {
    title: String,
    body: String,
    is_error: bool,
}

type ArcLock<T> = Arc<RwLock<T>>;
pub type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

type SingleTuple<T> = (T,);

#[derive(Serialize, Type)]
struct JsonValue<T>(
    #[serde(skip)] PhantomData<T>,
    #[specta(type = SingleTuple<T>)] serde_json::Value,
);

impl<T> Clone for JsonValue<T> {
    fn clone(&self) -> Self {
        Self(PhantomData, self.1.clone())
    }
}

impl<T: Serialize> JsonValue<T> {
    fn new(value: &T) -> Self {
        Self(PhantomData, json!(value))
    }
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    capture_target: ScreenCaptureTarget,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
enum CurrentRecordingTarget {
    Window {
        id: WindowId,
        bounds: Option<LogicalBounds>,
    },
    Screen {
        id: DisplayId,
    },
    Area {
        screen: DisplayId,
        bounds: LogicalBounds,
    },
    Camera,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordingStatus {
    Pending,
    Recording,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct CurrentRecording {
    target: CurrentRecordingTarget,
    mode: RecordingMode,
    status: RecordingStatus,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(state))]
async fn get_current_recording(
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<CurrentRecording>>, ()> {
    let state = state.read().await;

    let (mode, capture_target, status) = match &state.recording_state {
        RecordingState::None => {
            return Ok(JsonValue::new(&None));
        }
        RecordingState::Pending { mode, target } => (*mode, target, RecordingStatus::Pending),
        RecordingState::Active(inner) => (
            inner.mode(),
            inner.capture_target(),
            RecordingStatus::Recording,
        ),
    };

    let target = match capture_target {
        ScreenCaptureTarget::Display { id } => CurrentRecordingTarget::Screen { id: id.clone() },
        ScreenCaptureTarget::Window { id } => {
            let bounds =
                scap_targets::Window::from_id(id).and_then(|w| w.display_relative_logical_bounds());
            CurrentRecordingTarget::Window {
                id: id.clone(),
                bounds,
            }
        }
        ScreenCaptureTarget::Area { screen, bounds } => CurrentRecordingTarget::Area {
            screen: screen.clone(),
            bounds: *bounds,
        },
        ScreenCaptureTarget::CameraOnly => CurrentRecordingTarget::Camera,
    };

    Ok(JsonValue::new(&Some(CurrentRecording {
        target,
        mode,
        status,
    })))
}

#[derive(Serialize, Type, tauri_specta::Event, Clone)]
pub struct CurrentRecordingChanged;

pub(crate) async fn create_screenshot(
    input: PathBuf,
    output: PathBuf,
    size: Option<(u32, u32)>,
) -> Result<(), String> {
    let result: Result<(), String> = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut ictx = ffmpeg::format::input(&input).map_err(|e| e.to_string())?;
        let input_stream = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found")?;
        let video_stream_index = input_stream.index();

        let mut decoder =
            ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())
                .map_err(|e| e.to_string())?
                .decoder()
                .video()
                .map_err(|e| e.to_string())?;

        let mut scaler = ffmpeg::software::scaling::context::Context::get(
            decoder.format(),
            decoder.width(),
            decoder.height(),
            ffmpeg::format::Pixel::RGB24,
            size.map_or(decoder.width(), |s| s.0),
            size.map_or(decoder.height(), |s| s.1),
            ffmpeg::software::scaling::flag::Flags::BILINEAR,
        )
        .map_err(|e| e.to_string())?;

        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in ictx.packets() {
            if stream.index() == video_stream_index {
                decoder.send_packet(&packet).map_err(|e| e.to_string())?;
                if decoder.receive_frame(&mut frame).is_ok() {
                    let mut rgb_frame = ffmpeg::frame::Video::empty();
                    scaler
                        .run(&frame, &mut rgb_frame)
                        .map_err(|e| e.to_string())?;

                    let width = rgb_frame.width() as usize;
                    let height = rgb_frame.height() as usize;
                    let bytes_per_pixel = 3;
                    let src_stride = rgb_frame.stride(0);
                    let dst_stride = width * bytes_per_pixel;

                    let mut img_buffer = vec![0u8; height * dst_stride];

                    for y in 0..height {
                        let src_slice =
                            &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
                        let dst_slice = &mut img_buffer[y * dst_stride..(y + 1) * dst_stride];
                        dst_slice.copy_from_slice(src_slice);
                    }

                    let img = image::RgbImage::from_raw(width as u32, height as u32, img_buffer)
                        .ok_or("Failed to create image from frame data")?;

                    img.save_with_format(&output, image::ImageFormat::Jpeg)
                        .map_err(|e| e.to_string())?;

                    return Ok(());
                }
            }
        }

        Err("Failed to create screenshot".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?;

    result
}

pub(crate) async fn create_screenshot_source_from_segments(
    segments_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    let init_path = segments_dir.join("init.mp4");
    if !init_path.exists() {
        return Err(format!("init.mp4 not found in {}", segments_dir.display()));
    }

    let first_segment = find_first_segment(segments_dir)
        .ok_or_else(|| format!("No .m4s segments found in {}", segments_dir.display()))?;

    let temp_path = segments_dir.join(".screenshot_source.mp4");
    let mut out = tokio::fs::File::create(&temp_path)
        .await
        .map_err(|e| format!("Failed to create screenshot source: {e}"))?;

    let mut init_file = tokio::fs::File::open(&init_path)
        .await
        .map_err(|e| format!("Failed to open init.mp4: {e}"))?;
    tokio::io::copy(&mut init_file, &mut out)
        .await
        .map_err(|e| format!("Failed to copy init.mp4: {e}"))?;

    let mut seg_file = tokio::fs::File::open(&first_segment)
        .await
        .map_err(|e| format!("Failed to open {}: {e}", first_segment.display()))?;
    tokio::io::copy(&mut seg_file, &mut out)
        .await
        .map_err(|e| format!("Failed to copy segment: {e}"))?;

    Ok(temp_path)
}

fn find_first_segment(dir: &std::path::Path) -> Option<PathBuf> {
    let mut segments: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| {
            let path = e.ok()?.path();
            if path.extension().is_some_and(|ext| ext == "m4s") {
                Some(path)
            } else {
                None
            }
        })
        .collect();
    segments.sort();
    segments.into_iter().next()
}

// async fn create_thumbnail(input: PathBuf, output: PathBuf, size: (u32, u32)) -> Result<(), String> {
//     println!("Creating thumbnail: input={input:?}, output={output:?}, size={size:?}");

//     tokio::task::spawn_blocking(move || -> Result<(), String> {
//         let img = image::open(&input).map_err(|e| {
//             eprintln!("Failed to open image: {e}");
//             e.to_string()
//         })?;

//         let width = img.width() as usize;
//         let height = img.height() as usize;
//         let bytes_per_pixel = 3;
//         let src_stride = width * bytes_per_pixel;

//         let rgb_img = img.to_rgb8();
//         let img_buffer = rgb_img.as_raw();

//         let mut corrected_buffer = vec![0u8; height * src_stride];

//         for y in 0..height {
//             let src_slice = &img_buffer[y * src_stride..(y + 1) * src_stride];
//             let dst_slice = &mut corrected_buffer[y * src_stride..(y + 1) * src_stride];
//             dst_slice.copy_from_slice(src_slice);
//         }

//         let corrected_img =
//             image::RgbImage::from_raw(width as u32, height as u32, corrected_buffer)
//                 .ok_or("Failed to create corrected image")?;

//         let thumbnail = image::imageops::resize(
//             &corrected_img,
//             size.0,
//             size.1,
//             image::imageops::FilterType::Lanczos3,
//         );

//         thumbnail
//             .save_with_format(&output, image::ImageFormat::Png)
//             .map_err(|e| {
//                 eprintln!("Failed to save thumbnail: {e}");
//                 e.to_string()
//             })?;

//         println!("Thumbnail created successfully");
//         Ok(())
//     })
//     .await
//     .map_err(|e| format!("Task join error: {e}"))?
// }

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn copy_file_to_path(app: AppHandle, src: String, dst: String) -> Result<(), String> {
    println!("Attempting to copy file from {src} to {dst}");

    let is_screenshot = src.contains("screenshots/");
    let is_gif = src.ends_with(".gif") || dst.ends_with(".gif");

    let src_path = std::path::Path::new(&src);
    if !src_path.exists() {
        return Err(format!("Source file {src} does not exist"));
    }

    if !is_screenshot && !is_gif && !is_valid_video(src_path) {
        let mut attempts = 0;
        while attempts < 10 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if is_valid_video(src_path) {
                break;
            }
            attempts += 1;
        }
        if attempts == 10 {
            return Err("Source video file is not a valid MP4".to_string());
        }
    }

    if let Some(parent) = std::path::Path::new(&dst).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create target directory: {e}"))?;
    }

    let mut attempts = 0;
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_error = None;

    while attempts < MAX_ATTEMPTS {
        match tokio::fs::copy(&src, &dst).await {
            Ok(bytes) => {
                let src_size = match tokio::fs::metadata(&src).await {
                    Ok(metadata) => metadata.len(),
                    Err(e) => {
                        last_error = Some(format!("Failed to get source file metadata: {e}"));
                        attempts += 1;
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        continue;
                    }
                };

                if bytes != src_size {
                    last_error = Some(format!(
                        "File copy verification failed: copied {bytes} bytes but source is {src_size} bytes"
                    ));
                    let _ = tokio::fs::remove_file(&dst).await;
                    attempts += 1;
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }

                if !is_screenshot && !is_gif && !is_valid_video(std::path::Path::new(&dst)) {
                    last_error = Some("Destination file is not a valid".to_string());
                    let _ = tokio::fs::remove_file(&dst).await;
                    attempts += 1;
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }

                println!("Successfully copied {bytes} bytes from {src} to {dst}");

                notifications::send_notification(
                    &app,
                    if is_screenshot {
                        notifications::NotificationType::ScreenshotSaved
                    } else {
                        notifications::NotificationType::VideoSaved
                    },
                );
                return Ok(());
            }
            Err(e) => {
                last_error = Some(e.to_string());
                attempts += 1;
                if attempts < MAX_ATTEMPTS {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }
            }
        }
    }

    eprintln!(
        "Failed to copy file from {} to {} after {} attempts. Last error: {}",
        src,
        dst,
        MAX_ATTEMPTS,
        last_error.as_ref().unwrap()
    );

    notifications::send_notification(
        &app,
        if is_screenshot {
            notifications::NotificationType::ScreenshotSaveFailed
        } else {
            notifications::NotificationType::VideoSaveFailed
        },
    );

    Err(last_error.unwrap_or_else(|| "Maximum retry attempts exceeded".to_string()))
}

pub fn is_valid_video(path: &std::path::Path) -> bool {
    match ffmpeg::format::input(path) {
        Ok(input_context) => {
            // Check if we have at least one video stream
            input_context
                .streams()
                .any(|stream| stream.parameters().medium() == ffmpeg::media::Type::Video)
        }
        Err(_) => false,
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard))]
async fn copy_screenshot_to_clipboard(
    clipboard: MutableState<'_, ClipboardContext>,
    path: String,
) -> Result<(), String> {
    println!("Copying screenshot to clipboard: {path:?}");

    let img_data = clipboard_rs::RustImageData::from_path(&path)
        .map_err(|e| format!("Failed to copy screenshot to clipboard: {e}"))?;
    clipboard
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard, data))]
async fn copy_image_to_clipboard(
    clipboard: MutableState<'_, ClipboardContext>,
    data: Vec<u8>,
) -> Result<(), String> {
    println!("Copying image to clipboard ({} bytes)", data.len());

    let img_data = clipboard_rs::RustImageData::from_bytes(&data)
        .map_err(|e| format!("Failed to create image data from bytes: {e}"))?;
    clipboard
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy image to clipboard: {err}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard, instance))]
async fn copy_rendered_screenshot_to_clipboard(
    clipboard: MutableState<'_, ClipboardContext>,
    instance: WindowScreenshotEditorInstance,
) -> Result<(), String> {
    let data = render_screenshot_png(&instance).await?;

    let img_data = clipboard_rs::RustImageData::from_bytes(&data)
        .map_err(|e| format!("Failed to create image data from bytes: {e}"))?;
    clipboard
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy image to clipboard: {err}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
async fn open_file_path(_app: AppHandle, path: PathBuf) -> Result<(), String> {
    let path_str = path.to_str().ok_or("Invalid path")?;
    let is_dir = path.is_dir();

    #[cfg(target_os = "windows")]
    {
        if is_dir {
            Command::new("explorer")
                .arg(path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        } else {
            Command::new("explorer")
                .args(["/select,", path_str])
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if is_dir {
            Command::new("open")
                .arg(path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        } else {
            Command::new("open")
                .arg("-R")
                .arg(path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if is_dir {
            Command::new("xdg-open")
                .arg(path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        } else {
            Command::new("xdg-open")
                .arg(
                    path.parent()
                        .ok_or("Invalid path")?
                        .to_str()
                        .ok_or("Invalid path")?,
                )
                .spawn()
                .map_err(|e| format!("Failed to open folder: {e}"))?;
        }
    }

    Ok(())
}

#[derive(Deserialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct RenderFrameEvent {
    frame_number: u32,
    fps: u32,
    resolution_base: XY<u32>,
}

#[derive(Serialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct EditorStateChanged {
    playhead_position: u32,
}

impl EditorStateChanged {
    fn new(s: &EditorState) -> Self {
        Self {
            playhead_position: s.playhead_position,
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn start_playback(
    editor_instance: WindowEditorInstance,
    fps: u32,
    resolution_base: XY<u32>,
) -> Result<(), String> {
    editor_instance.start_playback(fps, resolution_base).await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn stop_playback(editor_instance: WindowEditorInstance) -> Result<(), String> {
    let mut state = editor_instance.state.lock().await;

    if let Some(handle) = state.playback_task.take() {
        handle.stop();
    }

    Ok(())
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
struct SerializedEditorInstance {
    frames_socket_url: String,
    recording_duration: f64,
    saved_project_config: ProjectConfiguration,
    recordings: Arc<ProjectRecordingsMeta>,
    path: PathBuf,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
async fn create_editor_instance(window: Window) -> Result<SerializedEditorInstance, String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|e| e.to_string())?
    else {
        return Err("Invalid window".to_string());
    };

    let path = {
        let window_ids = EditorWindowIds::get(window.app_handle());
        let window_ids = window_ids.ids.lock().unwrap();

        let Some((path, _)) = window_ids.iter().find(|(_, _id)| *_id == id) else {
            return Err("Editor instance not found".to_string());
        };
        path.clone()
    };

    let editor_instance = EditorInstances::get_or_create(&window, path).await?;

    let meta = editor_instance.meta();

    println!("Pretty name: {}", meta.pretty_name);

    Ok(SerializedEditorInstance {
        frames_socket_url: format!("ws://localhost:{}", editor_instance.ws_port),
        recording_duration: editor_instance.recordings.duration(),
        saved_project_config: {
            let project_config = editor_instance.project_config.1.borrow();
            project_config.clone()
        },
        recordings: editor_instance.recordings.clone(),
        path: editor_instance.project_path.clone(),
    })
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
async fn get_editor_project_path(window: Window) -> Result<PathBuf, String> {
    let CapWindowId::Editor { id } =
        CapWindowId::from_str(window.label()).map_err(|e| e.to_string())?
    else {
        return Err("Invalid window".to_string());
    };

    let window_ids = EditorWindowIds::get(window.app_handle());
    let window_ids = window_ids.ids.lock().unwrap();

    let Some((path, _)) = window_ids.iter().find(|(_, _id)| *_id == id) else {
        return Err("Editor instance not found".to_string());
    };

    Ok(path.clone())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor))]
async fn get_editor_meta(editor: WindowEditorInstance) -> Result<RecordingMeta, String> {
    let path = editor.project_path.clone();
    RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn get_recording_meta_by_path(project_path: PathBuf) -> Result<RecordingMeta, String> {
    RecordingMeta::load_for_project(&project_path).map_err(|e| e.to_string())
}
#[tauri::command]
#[specta::specta]
#[instrument(skip(editor))]
async fn set_pretty_name(editor: WindowEditorInstance, pretty_name: String) -> Result<(), String> {
    let mut meta = editor.meta().clone();
    meta.pretty_name = pretty_name;
    meta.save_for_project().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, clipboard))]
async fn copy_video_to_clipboard(
    app: AppHandle,
    clipboard: MutableState<'_, ClipboardContext>,
    path: String,
) -> Result<(), String> {
    println!("copying");
    let _ = clipboard.write().await.set_files(vec![path]);

    notifications::send_notification(
        &app,
        notifications::NotificationType::VideoCopiedToClipboard,
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument]
async fn get_video_metadata(path: PathBuf) -> Result<VideoRecordingMetadata, String> {
    let recording_meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    fn get_duration_for_path(path: PathBuf) -> Result<f64, String> {
        let input =
            ffmpeg::format::input(&path).map_err(|e| format!("Failed to open video file: {e}"))?;

        let raw_duration = input.duration();
        if raw_duration <= 0 {
            return Err(format!(
                "Unknown or invalid duration for video file: {path:?}"
            ));
        }

        let duration = raw_duration as f64 / AV_TIME_BASE as f64;
        Ok(duration)
    }

    let display_paths = match &recording_meta.inner {
        RecordingMetaInner::Instant(_) => {
            vec![path.join("content/output.mp4")]
        }
        RecordingMetaInner::Studio(meta) => {
            let status = meta.status();
            if let StudioRecordingStatus::Failed { .. } = status {
                return Err("Unable to get metadata on failed recording".to_string());
            } else if let StudioRecordingStatus::InProgress = status {
                return Err("Unable to get metadata on in-progress recording".to_string());
            }

            match &**meta {
                StudioRecordingMeta::SingleSegment { segment } => {
                    vec![recording_meta.path(&segment.display.path)]
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .map(|s| recording_meta.path(&s.display.path))
                    .collect(),
            }
        }
    };

    let duration = display_paths
        .into_iter()
        .map(get_duration_for_path)
        .try_fold(0f64, |acc, item| -> Result<f64, String> {
            let d = item?;
            Ok(acc + d)
        })?;

    let (width, height) = (1920, 1080);
    let fps = 30;

    let base_bitrate = if width <= 1280 && height <= 720 {
        4_000_000.0
    } else if width <= 1920 && height <= 1080 {
        8_000_000.0
    } else if width <= 2560 && height <= 1440 {
        14_000_000.0
    } else {
        20_000_000.0
    };

    let fps_factor = (fps as f64) / 30.0;
    let video_bitrate = base_bitrate * fps_factor;
    let audio_bitrate = 192_000.0;
    let total_bitrate = video_bitrate + audio_bitrate;
    let estimated_size_mb = (total_bitrate * duration) / (8.0 * 1024.0 * 1024.0);

    Ok(VideoRecordingMetadata {
        size: estimated_size_mb,
        duration,
    })
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn close_recordings_overlay_window(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app_for_close = app.clone();
        app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) =
                app_for_close.get_webview_panel(&CapWindowId::RecordingsOverlay.label())
            {
                panel.released_when_closed(false);
                panel.close();
            }
        })
        .ok();
    }

    if !cfg!(target_os = "macos")
        && let Some(window) = CapWindowId::RecordingsOverlay.get(&app)
    {
        let _ = window.close();
    }
}

#[tauri::command(async)]
#[specta::specta]
#[instrument(skip(_app))]
fn focus_captures_panel(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let app_for_focus = _app.clone();
        _app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            if let Ok(panel) =
                app_for_focus.get_webview_panel(&CapWindowId::RecordingsOverlay.label())
            {
                panel.make_key_window();
            }
        })
        .ok();
    }
}

#[derive(Serialize, Deserialize, specta::Type, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct FramesRendered {
    rendered_count: u32,
    total_frames: u32,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn set_playhead_position(
    editor_instance: WindowEditorInstance,
    frame_number: u32,
) -> Result<(), String> {
    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn set_project_config(
    editor_instance: WindowEditorInstance,
    config: ProjectConfiguration,
) -> Result<(), String> {
    config.write(&editor_instance.project_path).unwrap();

    editor_instance.project_config.0.send(config).ok();

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn update_project_config_in_memory(
    editor_instance: WindowEditorInstance,
    config: ProjectConfiguration,
    frame_number: Option<u32>,
    fps: Option<u32>,
    resolution_base: Option<XY<u32>>,
) -> Result<(), String> {
    editor_instance.project_config.0.send(config).ok();
    if let (Some(frame), Some(f), Some(res)) = (frame_number, fps, resolution_base) {
        editor_instance.preview_tx.send_modify(|v| {
            *v = Some((frame, f, res));
        });
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn generate_zoom_segments_from_clicks(
    editor_instance: WindowEditorInstance,
) -> Result<Vec<ZoomSegment>, String> {
    let meta = editor_instance.meta();
    let recordings = &editor_instance.recordings;

    let zoom_segments = recording::generate_zoom_segments_for_project(meta, recordings);

    Ok(zoom_segments)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn generate_keyboard_segments(
    editor_instance: WindowEditorInstance,
    grouping_threshold_ms: f64,
    linger_duration_ms: f64,
    show_modifiers: bool,
    show_special_keys: bool,
) -> Result<Vec<cap_project::KeyboardTrackSegment>, String> {
    let meta = editor_instance.meta();

    let RecordingMetaInner::Studio(studio_meta) = &meta.inner else {
        return Ok(vec![]);
    };

    let segments = match studio_meta.as_ref() {
        StudioRecordingMeta::MultipleSegments { inner, .. } => &inner.segments,
        _ => return Ok(vec![]),
    };

    let mut all_events = cap_project::KeyboardEvents { presses: vec![] };

    for segment in segments {
        let events = segment.keyboard_events(meta);
        all_events.presses.extend(events.presses);
    }

    all_events.presses.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let grouped = cap_project::group_key_events(
        &all_events,
        grouping_threshold_ms,
        linger_duration_ms,
        show_modifiers,
        show_special_keys,
    );

    Ok(grouped)
}

#[tauri::command]
#[specta::specta]
#[instrument]
async fn list_audio_devices() -> Result<Vec<String>, ()> {
    if !permissions::do_permissions_check(false)
        .microphone
        .permitted()
    {
        return Ok(vec![]);
    }

    Ok(MicrophoneFeed::list().keys().cloned().collect())
}

#[derive(Serialize, Type, Debug, Clone)]
pub struct UploadProgress {
    progress: f64,
}

#[derive(Debug, Deserialize, Type)]
pub enum UploadMode {
    Initial {
        pre_created_video: Option<VideoUploadInfo>,
    },
    Reupload,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, channel))]
async fn upload_exported_video(
    app: AppHandle,
    path: PathBuf,
    mode: UploadMode,
    channel: Channel<UploadProgress>,
    organization_id: Option<String>,
) -> Result<UploadResult, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    let mut meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    let file_path = meta.output_path();
    if !file_path.exists() {
        notifications::send_notification(&app, notifications::NotificationType::UploadFailed);
        return Err("Failed to upload video: Rendered video not found".to_string());
    }

    let metadata = build_video_meta(&file_path)
        .map_err(|err| format!("Error getting output video meta: {err}"))?;

    if !auth.is_upgraded() && metadata.duration_in_secs > 300.0 {
        return Ok(UploadResult::UpgradeRequired);
    }

    channel.send(UploadProgress { progress: 0.0 }).ok();

    let s3_config = match async {
        let video_id = match mode {
            UploadMode::Initial { pre_created_video } => {
                if let Some(pre_created) = pre_created_video {
                    return Ok(pre_created.config);
                }
                None
            }
            UploadMode::Reupload => {
                let Some(sharing) = meta.sharing.clone() else {
                    return Err("No sharing metadata found".into());
                };

                Some(sharing.id)
            }
        };

        create_or_get_video(
            &app,
            false,
            video_id,
            Some(meta.pretty_name.clone()),
            Some(metadata.clone()),
            organization_id,
        )
        .await
    }
    .await
    {
        Ok(data) => data,
        Err(AuthedApiError::InvalidAuthentication) => return Ok(UploadResult::NotAuthenticated),
        Err(AuthedApiError::UpgradeRequired) => return Ok(UploadResult::UpgradeRequired),
        Err(err) => return Err(err.to_string()),
    };

    let screenshot_path = meta.project_path.join("screenshots/display.jpg");
    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: file_path.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: path.clone(),
    });
    meta.save_for_project()
        .map_err(|e| error!("Failed to save recording meta: {e}"))
        .ok();

    match upload_video(
        &app,
        s3_config.id.clone(),
        file_path,
        screenshot_path,
        metadata,
        Some(channel.clone()),
    )
    .await
    {
        Ok(uploaded_video) => {
            channel.send(UploadProgress { progress: 1.0 }).ok();

            meta.upload = Some(UploadMeta::Complete);
            meta.sharing = Some(SharingMeta {
                link: uploaded_video.link.clone(),
                id: uploaded_video.id.clone(),
            });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            let _ = app
                .state::<ArcLock<ClipboardContext>>()
                .write()
                .await
                .set_text(uploaded_video.link.clone());

            NotificationType::ShareableLinkCopied.send(&app);
            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(AuthedApiError::UpgradeRequired) => Ok(UploadResult::UpgradeRequired),
        Err(e) => {
            error!("Failed to upload video: {e}");

            NotificationType::UploadFailed.send(&app);

            meta.upload = Some(UploadMeta::Failed {
                error: e.to_string(),
            });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            Err(e.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, clipboard))]
async fn upload_screenshot(
    app: AppHandle,
    clipboard: MutableState<'_, ClipboardContext>,
    screenshot_path: PathBuf,
) -> Result<UploadResult, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    if !auth.is_upgraded() {
        ShowCapWindow::Upgrade.show(&app).await.ok();
        return Ok(UploadResult::UpgradeRequired);
    }

    println!("Uploading screenshot: {screenshot_path:?}");

    let screenshot_dir = screenshot_path.parent().unwrap().to_path_buf();
    let mut meta = RecordingMeta::load_for_project(&screenshot_dir).unwrap();

    let share_link = if let Some(sharing) = meta.sharing.as_ref() {
        println!("Screenshot already uploaded, using existing link");
        sharing.link.clone()
    } else {
        let uploaded = upload_image(&app, screenshot_path.clone())
            .await
            .map_err(|e| e.to_string())?;

        meta.sharing = Some(SharingMeta {
            link: uploaded.link.clone(),
            id: uploaded.id.clone(),
        });
        meta.save_for_project()
            .map_err(|err| format!("Error saving project: {err}"))?;

        uploaded.link
    };

    println!("Copying to clipboard: {share_link:?}");

    let _ = clipboard.write().await.set_text(share_link.clone());

    notifications::send_notification(&app, notifications::NotificationType::ShareableLinkCopied);

    Ok(UploadResult::Success(share_link))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn save_file_dialog(
    app: AppHandle,
    file_name: String,
    file_type: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    println!("save_file_dialog called with file_name: {file_name}, file_type: {file_type}");

    let file_name = file_name
        .strip_suffix(".cap")
        .unwrap_or(&file_name)
        .to_string();
    println!("File name after removing .cap suffix: {file_name}");

    let (name, extension) = match file_type.as_str() {
        "recording" => {
            println!("File type is recording");
            ("MP4 Video", "mp4")
        }
        "screenshot" => {
            println!("File type is screenshot");
            ("PNG Image", "png")
        }
        _ => {
            println!("Invalid file type: {file_type}");
            return Err("Invalid file type".to_string());
        }
    };

    println!("Showing save dialog with name: {name}, extension: {extension}");

    let (tx, rx) = std::sync::mpsc::channel();
    println!("Created channel for communication");

    app.dialog()
        .file()
        .set_title("Save File")
        .set_file_name(file_name)
        .add_filter(name, &[extension])
        .save_file(move |path| {
            println!("Save file callback triggered");
            let _ = tx.send(
                path.as_ref()
                    .and_then(|p| p.as_path())
                    .map(|p| p.to_string_lossy().to_string()),
            );
        });

    println!("Waiting for user selection");
    match rx.recv() {
        Ok(result) => {
            println!("Save dialog result: {result:?}");
            Ok(result)
        }
        Err(e) => {
            println!("Error receiving result: {e}");
            notifications::send_notification(
                &app,
                notifications::NotificationType::VideoSaveFailed,
            );
            Err(e.to_string())
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct RecordingMetaWithMetadata {
    #[serde(flatten)]
    pub inner: RecordingMeta,
    // Easier accessors for within webview
    // THESE MUST COME AFTER `inner` to override flattened fields with the same name
    pub mode: RecordingMode,
    pub status: StudioRecordingStatus,
}

impl RecordingMetaWithMetadata {
    fn new(inner: RecordingMeta) -> Self {
        Self {
            mode: match &inner.inner {
                RecordingMetaInner::Studio(_) => RecordingMode::Studio,
                RecordingMetaInner::Instant(_) => RecordingMode::Instant,
            },
            status: match &inner.inner {
                RecordingMetaInner::Studio(meta) => match &**meta {
                    StudioRecordingMeta::MultipleSegments { inner } => inner
                        .status
                        .clone()
                        .unwrap_or(StudioRecordingStatus::Complete),
                    StudioRecordingMeta::SingleSegment { .. } => StudioRecordingStatus::Complete,
                },
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                    StudioRecordingStatus::InProgress
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) => {
                    StudioRecordingStatus::Failed {
                        error: error.clone(),
                    }
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
                    StudioRecordingStatus::Complete
                }
            },
            inner,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Recording,
    Screenshot,
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
fn get_recording_meta(
    path: PathBuf,
    _file_type: FileType,
) -> Result<RecordingMetaWithMetadata, String> {
    RecordingMeta::load_for_project(&path)
        .map(RecordingMetaWithMetadata::new)
        .map_err(|e| format!("Failed to load recording meta: {e}"))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn list_recordings(app: AppHandle) -> Result<Vec<(PathBuf, RecordingMetaWithMetadata)>, String> {
    let recordings_dir = recordings_path(&app);

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {e}"))?
        .filter_map(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return None,
            };

            let path = entry.path();

            if !path.is_dir() {
                return None;
            }

            get_recording_meta(path.clone(), FileType::Recording)
                .ok()
                .map(|meta| (path, meta))
        })
        .collect::<Vec<_>>();

    result.sort_by(|a, b| {
        let b_time =
            b.0.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let a_time =
            a.0.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        b_time.cmp(&a_time)
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn list_screenshots(app: AppHandle) -> Result<Vec<(PathBuf, RecordingMeta)>, String> {
    let screenshots_dir = screenshots_path(&app);

    let mut result = std::fs::read_dir(&screenshots_dir)
        .map_err(|e| format!("Failed to read screenshots directory: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
                let meta = match get_recording_meta(path.clone(), FileType::Screenshot) {
                    Ok(meta) => meta.inner,
                    Err(_) => return None,
                };

                let png_path = std::fs::read_dir(&path)
                    .ok()?
                    .filter_map(|e| e.ok())
                    .find(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                    .map(|e| e.path())?;

                Some((png_path, meta))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    result.sort_by(|a, b| {
        b.0.metadata()
            .and_then(|m| m.created())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.0.metadata()
                    .and_then(|m| m.created())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn check_upgraded_and_update(app: AppHandle) -> Result<bool, String> {
    println!("Checking upgraded status and updating...");

    if let Ok(Some(settings)) = GeneralSettingsStore::get(&app)
        && settings.commercial_license.is_some()
    {
        return Ok(true);
    }

    let Ok(Some(auth)) = AuthStore::get(&app) else {
        println!("No auth found, clearing auth store");
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(false);
    };

    if let Some(ref plan) = auth.plan
        && plan.manual
    {
        return Ok(true);
    }

    println!(
        "Fetching plan for user {}",
        auth.user_id.as_deref().unwrap_or("unknown")
    );
    let response = app
        .authed_api_request("/api/desktop/plan", |client, url| client.get(url))
        .await
        .map_err(|e| {
            println!("Failed to fetch plan: {e}");
            e.to_string()
        })?;

    println!("Plan fetch response status: {}", response.status());
    let plan_data = response.json::<serde_json::Value>().await.map_err(|e| {
        println!("Failed to parse plan response: {e}");
        format!("Failed to parse plan response: {e}")
    })?;

    let is_pro = plan_data
        .get("upgraded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    println!("Pro status: {is_pro}");
    let updated_auth = AuthStore {
        secret: auth.secret,
        user_id: auth.user_id,
        plan: Some(Plan {
            upgraded: is_pro,
            manual: auth.plan.map(|p| p.manual).unwrap_or(false),
            last_checked: chrono::Utc::now().timestamp() as i32,
        }),
        organizations: auth.organizations,
    };
    println!("Updating auth store with new pro status");
    AuthStore::set(&app, Some(updated_auth)).map_err(|e| e.to_string())?;

    Ok(is_pro)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn open_external_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Ok(Some(settings)) = GeneralSettingsStore::get(&app)
        && settings.disable_auto_open_links
    {
        return Ok(());
    }

    app.shell()
        .open(&url, None)
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
async fn reset_camera_permissions(_app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = _app.config().identifier.clone();

        Command::new("tccutil")
            .arg("reset")
            .arg("Camera")
            .arg(bundle_id)
            .output()
            .map_err(|_| "Failed to reset camera permissions".to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_app))]
async fn reset_microphone_permissions(_app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = _app.config().identifier.clone();

        Command::new("tccutil")
            .arg("reset")
            .arg("Microphone")
            .arg(bundle_id)
            .output()
            .map_err(|_| "Failed to reset microphone permissions".to_string())?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn clear_presets(app: AppHandle) -> Result<(), String> {
    presets::PresetsStore::clear(&app)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn is_camera_window_open(app: AppHandle) -> bool {
    CapWindowId::Camera
        .get(&app)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn seek_to(editor_instance: WindowEditorInstance, frame_number: u32) -> Result<(), String> {
    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn get_display_frame_for_cropping(
    editor_instance: WindowEditorInstance,
    fps: u32,
) -> Result<Vec<u8>, String> {
    use cap_project::ClipOffsets;
    use cap_rendering::{PixelFormat, cpu_yuv};
    use image::{ImageEncoder, codecs::png::PngEncoder};
    use std::io::Cursor;
    use std::time::Instant;

    let total_started_at = Instant::now();

    let frame_number = editor_instance.state.lock().await.playhead_position;
    let time_secs = frame_number as f64 / fps as f64;

    let project = editor_instance.project_config.1.borrow().clone();
    let lookup_started_at = Instant::now();

    let (segment_time, segment) = project
        .get_segment_time(time_secs)
        .ok_or_else(|| "No segment found for current time".to_string())?;

    let segment_medias = editor_instance
        .segment_medias
        .get(segment.recording_clip as usize)
        .ok_or_else(|| "Segment media not found".to_string())?;

    let clip_offsets = project
        .clips
        .iter()
        .find(|v| v.index == segment.recording_clip)
        .map(|v| v.offsets)
        .unwrap_or(ClipOffsets::default());
    let lookup_elapsed_ms = lookup_started_at.elapsed().as_secs_f64() * 1000.0;

    let decode_started_at = Instant::now();
    let segment_frames = segment_medias
        .decoders
        .get_frames(segment_time as f32, false, true, clip_offsets)
        .await
        .ok_or_else(|| "Failed to get frame".to_string())?;
    let decode_elapsed_ms = decode_started_at.elapsed().as_secs_f64() * 1000.0;

    let screen_frame = segment_frames
        .screen_frame
        .ok_or_else(|| "Failed to get screen frame".to_string())?;
    let width = screen_frame.width();
    let height = screen_frame.height();

    let convert_started_at = Instant::now();
    let rgba_data = match screen_frame.format() {
        PixelFormat::Rgba => screen_frame.data().to_vec(),
        PixelFormat::Nv12 => {
            let y_plane = screen_frame.y_plane().ok_or("Missing Y plane")?;
            let uv_plane = screen_frame.uv_plane().ok_or("Missing UV plane")?;
            let mut rgba = vec![0u8; (width * height * 4) as usize];
            cpu_yuv::nv12_to_rgba(
                y_plane,
                uv_plane,
                width,
                height,
                screen_frame.y_stride(),
                screen_frame.uv_stride(),
                &mut rgba,
            );
            rgba
        }
        PixelFormat::Yuv420p => {
            let y_plane = screen_frame.y_plane().ok_or("Missing Y plane")?;
            let u_plane = screen_frame.u_plane().ok_or("Missing U plane")?;
            let v_plane = screen_frame.v_plane().ok_or("Missing V plane")?;
            let mut rgba = vec![0u8; (width * height * 4) as usize];
            cpu_yuv::yuv420p_to_rgba(
                y_plane,
                u_plane,
                v_plane,
                width,
                height,
                screen_frame.y_stride(),
                screen_frame.uv_stride(),
                &mut rgba,
            );
            rgba
        }
    };
    let convert_elapsed_ms = convert_started_at.elapsed().as_secs_f64() * 1000.0;

    let encode_started_at = Instant::now();
    let mut png_data = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut png_data);
    encoder
        .write_image(&rgba_data, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|e| format!("Failed to encode PNG: {e}"))?;
    let encode_elapsed_ms = encode_started_at.elapsed().as_secs_f64() * 1000.0;
    let total_elapsed_ms = total_started_at.elapsed().as_secs_f64() * 1000.0;

    debug!(
        target: "cap_crop_profile",
        frame_number = frame_number,
        time_secs = time_secs,
        segment_time = segment_time,
        width = width,
        height = height,
        lookup_ms = lookup_elapsed_ms,
        decode_ms = decode_elapsed_ms,
        convert_ms = convert_elapsed_ms,
        encode_ms = encode_elapsed_ms,
        total_ms = total_elapsed_ms,
        "crop frame profile"
    );

    Ok(png_data.into_inner())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn get_mic_waveforms(editor_instance: WindowEditorInstance) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segment_medias.iter() {
        if let Some(audio) = &segment.audio {
            out.push(audio::get_waveform(audio));
        } else {
            out.push(Vec::new());
        }
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
async fn get_system_audio_waveforms(
    editor_instance: WindowEditorInstance,
) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segment_medias.iter() {
        if let Some(audio) = &segment.system_audio {
            out.push(audio::get_waveform(audio));
        } else {
            out.push(Vec::new());
        }
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, editor_instance, window))]
async fn editor_delete_project(
    app: tauri::AppHandle,
    editor_instance: WindowEditorInstance,
    window: tauri::Window,
) -> Result<(), String> {
    let _ = window.close();

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let path = editor_instance.0.project_path.clone();
    drop(editor_instance);

    let _ = tokio::fs::remove_dir_all(&path).await;

    RecordingDeleted { path }.emit(&app).ok();

    Ok(())
}

// keep this async otherwise opening windows may hang on windows
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn show_window(app: AppHandle, window: ShowCapWindow) -> Result<(), String> {
    if matches!(window, ShowCapWindow::Camera { .. }) {
        let operation_lock = app.state::<CameraWindowOperationLock>();
        let _operation_guard = operation_lock.lock().await;
        window.show(&app).await.map_err(|e| e.to_string())?;
        return Ok(());
    }

    window.show(&app).await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
fn list_fails() -> Result<BTreeMap<String, bool>, ()> {
    Ok(cap_fail::get_state())
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
fn set_fail(name: String, value: bool) {
    cap_fail::set_fail(&name, value)
}

async fn check_notification_permissions(app: AppHandle) {
    let Ok(Some(settings)) = GeneralSettingsStore::get(&app) else {
        return;
    };

    if !settings.enable_notifications {
        return;
    }

    match app.notification().permission_state() {
        Ok(state) if state != PermissionState::Granted => {
            println!("Requesting notification permission");
            match app.notification().request_permission() {
                Ok(PermissionState::Granted) => {
                    println!("Notification permission granted");
                }
                Ok(_) | Err(_) => {
                    GeneralSettingsStore::update(&app, |s| {
                        s.enable_notifications = false;
                    })
                    .ok();
                }
            }
        }
        Ok(_) => {
            println!("Notification permission already granted");
        }
        Err(e) => {
            eprintln!("Error checking notification permission state: {e}");
        }
    }
}

// fn configure_logging(folder: &PathBuf) -> tracing_appender::non_blocking::WorkerGuard {
//     let file_appender = tracing_appender::rolling::daily(folder, "cap-logs.log");
//     let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

//     let filter = || tracing_subscriber::filter::EnvFilter::builder().parse_lossy("cap-*=TRACE");

//     tracing_subscriber::registry()
//         .with(
//             tracing_subscriber::fmt::layer()
//                 .with_ansi(false)
//                 .with_target(false)
//                 .with_writer(non_blocking)
//                 .with_filter(filter()),
//         )
//         .with(
//             tracing_subscriber::fmt::layer()
//                 .with_ansi(true)
//                 .with_target(false)
//                 .with_filter(filter()),
//         )
//         .init();

//     _guard
// }

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn set_server_url(app: MutableState<'_, App>, server_url: String) -> Result<(), ()> {
    let mut app = app.write().await;
    posthog::set_server_url(&server_url);
    app.server_url = server_url;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn set_camera_preview_state(
    app: MutableState<'_, App>,
    state: CameraPreviewState,
) -> Result<(), String> {
    let app_guard = app.read().await;
    let blur_mode = state.background_blur;
    app_guard
        .camera_preview
        .set_state(state)
        .map_err(|err| format!("Error saving camera window state: {err}"))?;

    app_guard.camera_blur_tx.send(blur_mode).ok();
    drop(app_guard);

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn set_camera_window_position(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let guard = app.state::<CameraWindowPositionGuard>();
    if guard.should_ignore() {
        return Ok(());
    }

    GeneralSettingsStore::update(&app, |settings| {
        update_camera_window_position_settings(settings, x, y);
    })?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument]
fn ignore_camera_window_position(
    guard: State<'_, CameraWindowPositionGuard>,
    duration_ms: u32,
) -> Result<(), String> {
    guard.ignore_for(duration_ms as u64);
    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(state))]
async fn refresh_camera_feed(state: MutableState<'_, App>) -> Result<(), String> {
    let app = state.read().await;
    let camera_feed = app.camera_feed.clone();

    #[allow(deprecated)]
    let camera_ws_sender = app.camera_ws_sender.clone();

    let camera_preview_sender = app.camera_preview.sender();

    drop(app);

    if let Some(sender) = camera_preview_sender {
        #[allow(deprecated)]
        camera_feed
            .ask(feeds::camera::RemoveSender(camera_ws_sender))
            .await
            .map_err(|err| format!("error removing camera ws sender: {err}"))?;

        camera_feed
            .ask(feeds::camera::AddSender(sender))
            .await
            .map_err(|err| format!("error re-adding camera preview sender: {err}"))?;
    } else {
        #[allow(deprecated)]
        camera_feed
            .ask(feeds::camera::AddSender(camera_ws_sender))
            .await
            .map_err(|err| format!("error re-adding camera ws sender: {err}"))?;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
async fn destroy_camera_window(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let shutdown_rx = {
        let mut app_state = state.write().await;
        app_state.camera_preview.begin_shutdown()
    };

    if let Some(rx) = shutdown_rx {
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), rx).await;
    }

    windows::cleanup_camera_window(&app, None, true, true).await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn await_camera_preview_ready(app: MutableState<'_, App>) -> Result<bool, String> {
    let app = app.read().await.camera_feed.clone();

    let (tx, rx) = oneshot::channel();
    app.tell(feeds::camera::ListenForReady(tx))
        .await
        .map_err(|err| format!("error registering ready listener: {err}"))?;
    rx.await
        .map_err(|err| format!("error receiving ready signal: {err}"))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn update_auth_plan(app: AppHandle) {
    AuthStore::update_auth_plan(&app).await.ok();
}

pub async fn open_target_picker(
    app: &tauri::AppHandle,
    target_mode: recording_settings::RecordingTargetMode,
) {
    use tauri::Manager;

    if let Some(window) = CapWindowId::Main.get(app) {
        window.hide().ok();
    }

    let state = app.state::<target_select_overlay::WindowFocusManager>();
    let display_id = None;

    let _ = target_select_overlay::open_target_select_overlays(
        app.clone(),
        state,
        None,
        display_id.clone(),
        Some(target_mode),
    )
    .await;

    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let _ = RequestSetTargetMode {
        target_mode: Some(target_mode),
        display_id,
    }
    .emit(app);
}

type FilteredRegistry = tracing_subscriber::layer::Layered<
    tracing_subscriber::filter::FilterFn<fn(m: &tracing::Metadata) -> bool>,
    tracing_subscriber::Registry,
>;

pub type DynLoggingLayer = Box<dyn tracing_subscriber::Layer<FilteredRegistry> + Send + Sync>;
type LoggingHandle = tracing_subscriber::reload::Handle<Option<DynLoggingLayer>, FilteredRegistry>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run(recording_logging_handle: LoggingHandle, logs_dir: PathBuf) {
    ffmpeg::init()
        .map_err(|e| {
            error!("Failed to initialize ffmpeg: {e}");
        })
        .ok();

    posthog::init();

    let tauri_context = tauri::generate_context!();

    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            set_mic_input,
            set_camera_input,
            recording_settings::set_recording_mode,
            upload_logs,
            get_system_diagnostics,
            recording::start_recording,
            recording::stop_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::toggle_pause_recording,
            recording::restart_recording,
            recording::delete_recording,
            recording::take_screenshot,
            recording::list_cameras,
            recording::get_camera_formats,
            recording::get_microphone_info,
            recording::list_capture_windows,
            recording::list_capture_displays,
            recording::list_displays_with_thumbnails,
            recording::list_windows_with_thumbnails,
            windows::refresh_window_content_protection,
            general_settings::get_default_excluded_windows,
            list_audio_devices,
            close_recordings_overlay_window,
            fake_window::set_fake_window_bounds,
            fake_window::remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            export::export_video,
            export::get_export_estimates,
            export::generate_export_preview,
            export::generate_export_preview_fast,
            import::start_video_import,
            import::check_import_ready,
            copy_file_to_path,
            copy_video_to_clipboard,
            copy_screenshot_to_clipboard,
            copy_image_to_clipboard,
            copy_rendered_screenshot_to_clipboard,
            open_file_path,
            get_video_metadata,
            create_editor_instance,
            get_editor_project_path,
            get_mic_waveforms,
            get_system_audio_waveforms,
            start_playback,
            stop_playback,
            set_playhead_position,
            set_project_config,
            update_project_config_in_memory,
            generate_zoom_segments_from_clicks,
            generate_keyboard_segments,
            render_screenshot_for_export,
            permissions::open_permission_settings,
            permissions::do_permissions_check,
            permissions::request_permission,
            get_devices_snapshot,
            upload_exported_video,
            upload_screenshot,
            create_screenshot_editor_instance,
            update_screenshot_config,
            get_recording_meta,
            save_file_dialog,
            list_recordings,
            list_screenshots,
            check_upgraded_and_update,
            open_external_link,
            hotkeys::set_hotkey,
            reset_camera_permissions,
            reset_microphone_permissions,
            clear_presets,
            is_camera_window_open,
            seek_to,
            get_display_frame_for_cropping,
            windows::position_traffic_lights,
            windows::set_theme,
            global_message_dialog,
            show_window,
            write_clipboard_string,
            platform::perform_haptic_feedback,
            platform::is_system_audio_capture_supported,
            list_fails,
            set_fail,
            update_auth_plan,
            set_window_transparent,
            get_editor_meta,
            get_recording_meta_by_path,
            set_pretty_name,
            set_server_url,
            set_camera_preview_state,
            set_camera_window_position,
            ignore_camera_window_position,
            await_camera_preview_ready,
            destroy_camera_window,
            refresh_camera_feed,
            captions::create_dir,
            captions::save_model_file,
            captions::transcribe_audio,
            captions::save_captions,
            captions::load_captions,
            captions::download_whisper_model,
            captions::check_model_exists,
            captions::delete_whisper_model,
            captions::download_parakeet_model,
            captions::check_parakeet_model_exists,
            captions::delete_parakeet_model,
            captions::export_captions_srt,
            target_select_overlay::open_target_select_overlays,
            target_select_overlay::close_target_select_overlays,
            target_select_overlay::update_camera_overlay_bounds,
            target_select_overlay::display_information,
            target_select_overlay::get_window_icon,
            target_select_overlay::focus_window,
            editor_delete_project,
            format_project_name,
            recovery::find_incomplete_recordings,
            recovery::recover_recording,
            recovery::discard_incomplete_recording,
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            NewStudioRecordingAdded,
            NewScreenshotAdded,
            RenderFrameEvent,
            EditorStateChanged,
            CurrentRecordingChanged,
            RecordingStarted,
            RecordingStopped,
            RequestStartRecording,
            RequestOpenRecordingPicker,
            RequestSetTargetMode,
            RequestOpenSettings,
            RequestScrollToSettingsSection,
            RequestScreenCapturePrewarm,
            NewNotification,
            audio_meter::AudioInputLevelChange,
            captions::DownloadProgress,
            recording::RecordingEvent,
            RecordingDeleted,
            target_select_overlay::TargetUnderCursor,
            hotkeys::OnEscapePress,
            upload::UploadProgressEvent,
            import::VideoImportProgress,
            SetCaptureAreaPending,
            DevicesUpdated,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .typ::<ProjectConfiguration>()
        .typ::<AuthStore>()
        .typ::<presets::PresetsStore>()
        .typ::<hotkeys::HotkeysStore>()
        .typ::<general_settings::GeneralSettingsStore>()
        .typ::<recording_settings::RecordingSettingsStore>()
        .typ::<cap_flags::Flags>()
        .typ::<crate::window_exclusion::WindowExclusion>();

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    let (camera_blur_tx, camera_blur_rx) =
        tokio::sync::watch::channel(cap_project::BackgroundBlurMode::Off);
    let (camera_tx, camera_ws_port, _shutdown) =
        camera_legacy::create_camera_preview_ws(camera_blur_rx).await;
    let camera_ws_sender = camera_tx.clone();

    let (mic_samples_tx, mic_samples_rx) = flume::bounded(8);
    let mic_meter_sender = mic_samples_tx.clone();

    let camera_feed = CameraFeed::spawn(CameraFeed::default());
    let _ = camera_feed.ask(feeds::camera::AddSender(camera_tx)).await;

    let (mic_error_tx, mic_error_rx) = flume::bounded(1);

    let mic_feed = {
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(mic_error_tx));

        if let Err(err) = mic_feed
            .ask(feeds::microphone::AddSender(mic_samples_tx))
            .await
        {
            error!("Failed to attach audio meter sender: {err}");
        }

        mic_feed
    };

    tauri::async_runtime::set(tokio::runtime::Handle::current());

    #[allow(unused_mut)]
    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            trace!("Single instance invoked with args {args:?}");

            // This is also handled as a deeplink on some platforms (eg macOS), see deeplink_actions
            let Some(cap_file) = args
                .iter()
                .find(|arg| arg.ends_with(".cap"))
                .map(PathBuf::from)
            else {
                let app = app.clone();
                tokio::spawn(async move {
                    ShowCapWindow::Main {
                        init_target_mode: None,
                    }
                    .show(&app)
                    .await
                });
                return;
            };

            let _ = open_project_from_path(&cap_file, app.clone());
        }));

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(flags::plugin::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags({
                    use tauri_plugin_window_state::StateFlags;
                    let mut flags = StateFlags::all();
                    flags.remove(StateFlags::VISIBLE);
                    flags
                })
                .with_denylist(&[
                    CapWindowId::Onboarding.label().as_str(),
                    CapWindowId::Main.label().as_str(),
                    CapWindowId::Settings.label().as_str(),
                    "window-capture-occluder",
                    "target-select-overlay",
                    CapWindowId::CaptureArea.label().as_str(),
                    CapWindowId::Camera.label().as_str(),
                    CapWindowId::RecordingsOverlay.label().as_str(),
                    CapWindowId::RecordingControls.label().as_str(),
                    CapWindowId::Upgrade.label().as_str(),
                    "editor",
                    "screenshot-editor",
                ])
                .map_label(|label| match label {
                    label if label.starts_with("editor-") => "editor",
                    label if label.starts_with("screenshot-editor-") => "screenshot-editor",
                    label if label.starts_with("window-capture-occluder-") => {
                        "window-capture-occluder"
                    }
                    label if label.starts_with("target-select-overlay") => "target-select-overlay",
                    _ => label,
                })
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let app = app.handle().clone();

            if let Err(err) = update_project_names::migrate_if_needed(&app) {
                tracing::error!("Failed to migrate project file names: {}", err);
            }

            specta_builder.mount_events(&app);
            hotkeys::init(&app);
            general_settings::init(&app);
            fake_window::init(&app);
            app.manage(target_select_overlay::WindowFocusManager::default());
            app.manage(EditorWindowIds::default());
            app.manage(ScreenshotEditorWindowIds::default());
            #[cfg(target_os = "macos")]
            app.manage(crate::platform::ScreenCapturePrewarmer::default());
            #[cfg(target_os = "macos")]
            app.manage(panel_manager::PanelManager::new());
            app.manage(http_client::HttpClient::default());
            app.manage(http_client::RetryableHttpClient::default());
            app.manage(PendingScreenshots::default());
            app.manage(FinalizingRecordings::default());

            gpu_context::prewarm_gpu();

            #[cfg(unix)]
            {
                let app_for_signal = app.clone();
                tokio::spawn(async move {
                    use tokio::signal::unix::{SignalKind, signal};
                    let Ok(mut term) = signal(SignalKind::terminate()) else {
                        tracing::warn!("Failed to register SIGTERM handler");
                        return;
                    };
                    let Ok(mut hup) = signal(SignalKind::hangup()) else {
                        tracing::warn!("Failed to register SIGHUP handler");
                        return;
                    };
                    tokio::select! {
                        _ = term.recv() => {
                            tracing::info!("Received SIGTERM; initiating graceful shutdown");
                        }
                        _ = hup.recv() => {
                            tracing::info!("Received SIGHUP; initiating graceful shutdown");
                        }
                    }
                    request_app_exit(app_for_signal).await;
                });
            }

            tokio::spawn({
                let camera_feed = camera_feed.clone();
                let app = app.clone();
                async move {
                    camera_feed
                        .tell(feeds::camera::OnFeedDisconnect(Box::new({
                            move || {
                                if app_is_exiting(&app) {
                                    return;
                                }

                                if let Some(win) = CapWindowId::Camera.get(&app) {
                                    win.hide().ok();
                                }
                            }
                        })))
                        .send()
                        .await
                        .map_err(|err| error!("Error registering on camera feed disconnect: {err}"))
                        .ok();
                }
            });

            if let Ok(Some(auth)) = AuthStore::load(&app) {
                sentry::configure_scope(|scope| {
                    scope.set_user(auth.user_id.map(|id| sentry::User {
                        id: Some(id),
                        ..Default::default()
                    }));
                });
            }

            {
                let (server_url, should_update) = if cfg!(debug_assertions)
                    && let Ok(url) = std::env::var("VITE_SERVER_URL")
                {
                    (url, true)
                } else if let Some(url) = GeneralSettingsStore::get(&app)
                    .ok()
                    .flatten()
                    .map(|v| v.server_url.clone())
                {
                    (url, false)
                } else {
                    (
                        option_env!("VITE_SERVER_URL")
                            .unwrap_or("https://cap.so")
                            .to_string(),
                        true,
                    )
                };

                // This ensures settings reflects the correct value if it's set at startup
                if should_update {
                    GeneralSettingsStore::update(&app, |s| {
                        s.server_url = server_url.clone();
                    })
                    .map_err(|err| warn!("Error updating server URL into settings store: {err}"))
                    .ok();
                }

                posthog::set_server_url(&server_url);

                let camera_preview = CameraPreviewManager::new(&app);
                let camera_session_id_handle = camera_preview.session_id_handle();

                app.manage(Arc::new(RwLock::new(App {
                    camera_ws_port,
                    camera_ws_sender,
                    handle: app.clone(),
                    camera_preview,
                    camera_blur_tx,
                    recording_state: RecordingState::None,
                    recording_logging_handle,
                    mic_feed,
                    mic_meter_sender,
                    selected_mic_label: None,
                    selected_camera_id: None,
                    camera_in_use: false,
                    camera_cleanup_done: false,
                    camera_feed,
                    server_url,
                    logs_dir: logs_dir.clone(),
                    disconnected_inputs: HashSet::new(),
                    was_camera_only_recording: false,
                })));

                app.manage(camera_session_id_handle);
                app.manage(CameraWindowCloseGate::default());
                app.manage(CameraWindowPositionGuard::default());
                app.manage(CameraWindowOperationLock::default());
                app.manage(AppExitState::default());
                app.manage(MainWindowReadyState::default());

                app.manage(Arc::new(RwLock::new(
                    ClipboardContext::new().expect("Failed to create clipboard context"),
                )));
            }

            app.listen_any("main-window-ready", {
                let app = app.clone();
                move |_| {
                    app.state::<MainWindowReadyState>().set_ready(true);
                }
            });

            tokio::spawn({
                let app = app.clone();
                async move {
                    resume_uploads(app)
                        .await
                        .map_err(|err| warn!("Error resuming uploads: {err}"))
                        .ok();
                }
            });

            spawn_mic_error_handler(app.clone(), mic_error_rx);
            spawn_device_watchers(app.clone());
            spawn_devices_snapshot_emitter(app.clone());
            spawn_system_resume_detector(app.clone());
            power_observer::install(&app);
            window_position_persistence::install(&app);

            tokio::spawn(check_notification_permissions(app.clone()));

            println!("Checking startup completion and permissions...");
            let permissions = permissions::do_permissions_check(false);
            println!("Permissions check result: {permissions:?}");

            tokio::spawn({
                let app = app.clone();
                async move {
                    if should_show_onboarding(&app) {
                        println!("Showing onboarding");
                        let _ = ShowCapWindow::Onboarding.show(&app).await;
                    } else {
                        println!("Showing main window");
                        let _ = ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(&app)
                        .await;
                    }
                }
            });

            audio_meter::spawn_event_emitter(app.clone(), mic_samples_rx);

            if let Err(err) = tray::create_tray(&app) {
                error!("Failed to create tray: {err}");
            }

            RequestStartRecording::listen_any_spawn(&app, async |event, app| {
                let settings = RecordingSettingsStore::get(&app)
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                let _ = set_mic_input(app.state(), settings.mic_name).await;
                let _ = set_camera_input(app.clone(), app.state(), settings.camera_id, None).await;

                let _ = start_recording(app.clone(), app.state(), {
                    recording::StartRecordingInputs {
                        capture_target: settings.target.unwrap_or_else(|| {
                            ScreenCaptureTarget::Display {
                                id: Display::primary().id(),
                            }
                        }),
                        mode: event.mode,
                        capture_system_audio: settings.system_audio,
                        organization_id: settings.organization_id,
                    }
                })
                .await;
            });

            RequestOpenRecordingPicker::listen_any_spawn(&app, async |event, app| {
                if let Some(target_mode) = event.target_mode {
                    open_target_picker(&app, target_mode).await;
                } else {
                    let _ = ShowCapWindow::Main {
                        init_target_mode: None,
                    }
                    .show(&app)
                    .await;
                }
            });

            RequestOpenSettings::listen_any_spawn(&app, async |payload, app| {
                let _ = ShowCapWindow::Settings {
                    page: Some(payload.page),
                }
                .show(&app)
                .await;
            });

            #[cfg(target_os = "macos")]
            RequestScreenCapturePrewarm::listen_any_spawn(&app, async |event, app| {
                let prewarmer = app.state::<crate::platform::ScreenCapturePrewarmer>();
                prewarmer.request(event.force).await;
            });

            let app_handle = app.clone();
            app.deep_link().on_open_url(move |event| {
                deeplink_actions::handle(&app_handle, event.urls());
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            let app = window.app_handle();

            if matches!(
                event,
                WindowEvent::CloseRequested { .. }
                    | WindowEvent::Moved(_)
                    | WindowEvent::Focused(_)
            ) && app_is_exiting(app)
            {
                return;
            }

            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    if let Ok(window_id) = CapWindowId::from_str(label) {
                        match window_id {
                            CapWindowId::Camera => {
                                if app
                                    .try_state::<CameraWindowCloseGate>()
                                    .is_some_and(|close_gate| close_gate.allow_close())
                                {
                                    return;
                                }

                                api.prevent_close();
                                let _ = window.hide();
                                tracing::warn!("Camera window CloseRequested event received!");
                                let session_id = app
                                    .try_state::<Arc<AtomicU64>>()
                                    .map(|state| state.load(Ordering::Acquire))
                                    .unwrap_or(0);
                                let app = app.clone();
                                spawn_on_runtime(async move {
                                    cleanup_camera_window(app, session_id).await;
                                });
                            }
                            CapWindowId::Main => {
                                api.prevent_close();
                                let _ = window.hide();

                                let Some(state) = app.try_state::<ArcLock<App>>() else {
                                    warn!("App state unavailable during main window close request");
                                    return;
                                };
                                let is_recording = state
                                    .try_read()
                                    .map(|s| s.is_recording_active_or_pending())
                                    .unwrap_or(true);

                                if !is_recording {
                                    if let Some(camera_window) = CapWindowId::Camera.get(app) {
                                        let _ = camera_window.hide();
                                    }

                                    close_target_select_overlays(app);

                                    let app = app.clone();
                                    spawn_on_runtime(async move {
                                        let Some(state) = app.try_state::<ArcLock<App>>() else {
                                            warn!("App state unavailable during main window close cleanup");
                                            return;
                                        };

                                        let (mic_feed, camera_feed) = {
                                            let mut app_state = state.write().await;
                                            app_state.camera_preview.pause();
                                            (
                                                app_state.mic_feed.clone(),
                                                app_state.camera_feed.clone(),
                                            )
                                        };

                                        let _ = tokio::time::timeout(
                                            APP_EXIT_STEP_TIMEOUT,
                                            mic_feed.ask(microphone::RemoveInput),
                                        )
                                        .await;
                                        let _ = tokio::time::timeout(
                                            APP_EXIT_STEP_TIMEOUT,
                                            camera_feed.ask(feeds::camera::RemoveInput),
                                        )
                                        .await;

                                        let mut app_state = state.write().await;
                                        app_state.selected_mic_label = None;
                                        app_state.camera_in_use = false;
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
                WindowEvent::Destroyed => {
                    fake_window::cancel_fake_window_listener(app, label);
                    if app_is_exiting(app) {
                        return;
                    }
                    if let Ok(window_id) = CapWindowId::from_str(label) {
                        if matches!(window_id, CapWindowId::Camera) {
                            tracing::warn!("Camera window Destroyed event received!");
                        }
                        match window_id {
                            CapWindowId::Main => {
                                let app = app.clone();

                                close_target_select_overlays(&app);

                                if let Some(camera) = CapWindowId::Camera.get(&app) {
                                    let _ = camera.hide();
                                }

                                spawn_on_runtime(async move {
                                    let Some(state) = app.try_state::<ArcLock<App>>() else {
                                        warn!("App state unavailable during main window destroyed cleanup");
                                        return;
                                    };

                                    let feeds = {
                                        let app_state = state.read().await;
                                        if app_state.is_recording_active_or_pending() {
                                            None
                                        } else {
                                            Some((
                                                app_state.mic_feed.clone(),
                                                app_state.camera_feed.clone(),
                                            ))
                                        }
                                    };

                                    if let Some((mic_feed, camera_feed)) = feeds {
                                        let _ = tokio::time::timeout(
                                            APP_EXIT_STEP_TIMEOUT,
                                            mic_feed.ask(microphone::RemoveInput),
                                        )
                                        .await;
                                        let _ = tokio::time::timeout(
                                            APP_EXIT_STEP_TIMEOUT,
                                            camera_feed.ask(feeds::camera::RemoveInput),
                                        )
                                        .await;

                                        let mut app_state = state.write().await;
                                        if !app_state.is_recording_active_or_pending() {
                                            app_state.selected_mic_label = None;
                                            app_state.selected_camera_id = None;
                                            app_state.camera_in_use = false;
                                        }
                                    }
                                });
                            }
                            CapWindowId::Editor { id } => {
                                let window_ids = EditorWindowIds::get(window.app_handle());
                                match window_ids.ids.lock() {
                                    Ok(mut ids) => ids.retain(|(_, _id)| *_id != id),
                                    Err(err) => warn!(error = %err, "Editor window ids lock poisoned"),
                                }

                                let label = window.label().to_string();
                                let pending = editor_window::PendingEditorInstances::get(app);
                                spawn_on_runtime(async move {
                                    pending.cancel_prewarm(&label).await;
                                });

                                spawn_on_runtime(EditorInstances::remove(window.clone()));

                                restore_main_windows_if_no_editors(app);
                            }
                            CapWindowId::ScreenshotEditor { id } => {
                                let window_ids =
                                    ScreenshotEditorWindowIds::get(window.app_handle());
                                match window_ids.ids.lock() {
                                    Ok(mut ids) => ids.retain(|(_, _id)| *_id != id),
                                    Err(err) => {
                                        warn!(error = %err, "Screenshot editor window ids lock poisoned");
                                    }
                                }

                                let label = window.label().to_string();
                                let pending = PendingScreenshotEditorInstances::get(app);
                                spawn_on_runtime(async move {
                                    pending.cancel_prewarm(&label).await;
                                });

                                spawn_on_runtime(ScreenshotEditorInstances::remove(window.clone()));

                                restore_main_windows_if_no_editors(app);
                            }
                            CapWindowId::Settings => {
                                for (label, window) in app.webview_windows() {
                                    if let Ok(id) = CapWindowId::from_str(&label) {
                                        match id {
                                            CapWindowId::TargetSelectOverlay { .. } => {
                                                show_overlay(&window);
                                            }
                                            CapWindowId::Main => {
                                                let _ = window.show();
                                            }
                                            _ => {}
                                        }
                                    }
                                }

                                restore_camera_window(app);

                                #[cfg(target_os = "windows")]
                                if !has_open_editor_window(app) {
                                    reopen_main_window(app);
                                }

                                #[cfg(target_os = "macos")]
                                return;
                            }
                            CapWindowId::Upgrade | CapWindowId::ModeSelect => {
                                for (label, window) in app.webview_windows() {
                                    if let Ok(id) = CapWindowId::from_str(&label) {
                                        match id {
                                            CapWindowId::TargetSelectOverlay { .. } => {
                                                show_overlay(&window);
                                            }
                                            CapWindowId::Main => {
                                                let _ = window.show();
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                restore_camera_window(app);
                                #[cfg(target_os = "macos")]
                                return;
                            }
                            CapWindowId::TargetSelectOverlay { display_id } => {
                                if let Some(focus_manager) =
                                    app.try_state::<target_select_overlay::WindowFocusManager>()
                                {
                                    focus_manager.destroy(&display_id, app.global_shortcut());
                                }
                                let session_id = app
                                    .try_state::<Arc<AtomicU64>>()
                                    .map(|state| state.load(Ordering::Acquire))
                                    .unwrap_or(0);
                                spawn_on_runtime(cleanup_camera_after_overlay_close(
                                    app.clone(),
                                    session_id,
                                ));
                            }
                            CapWindowId::Camera => {
                                tracing::info!(
                                    "Camera window Destroyed event - resetting panel state"
                                );
                                let session_id = app
                                    .try_state::<Arc<AtomicU64>>()
                                    .map(|state| state.load(Ordering::Acquire))
                                    .unwrap_or(0);
                                let app = app.clone();
                                spawn_on_runtime(async move {
                                    #[cfg(target_os = "macos")]
                                    {
                                        if let Some(panel_manager) =
                                            app.try_state::<panel_manager::PanelManager>()
                                        {
                                            panel_manager
                                                .force_reset(panel_manager::PanelWindowType::Camera)
                                                .await;
                                        }
                                    }
                                    cleanup_camera_window(app, session_id).await;
                                });
                            }
                            _ => {}
                        };
                    }

                    #[cfg(target_os = "macos")]
                    crate::permissions::sync_macos_dock_visibility(app);
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(focused) => {
                    let window_id = CapWindowId::from_str(label);

                    if matches!(window_id, Ok(CapWindowId::Upgrade)) {
                        for (label, window) in app.webview_windows() {
                            if let Ok(id) = CapWindowId::from_str(&label)
                                && matches!(id, CapWindowId::TargetSelectOverlay { .. })
                            {
                                hide_overlay(&window);
                            }
                        }
                    }

                    if *focused
                        && let Ok(window_id) = window_id
                        && window_id.activates_dock()
                    {
                        crate::permissions::sync_macos_dock_visibility(app);
                    }
                }
                WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    for path in paths {
                        let _ = open_project_from_path(path, app.clone());
                    }
                }
                WindowEvent::Moved(position) => {
                    if let Ok(window_id) = CapWindowId::from_str(label) {
                        let scale_factor = window.scale_factor().unwrap_or(1.0);
                        let logical_pos = position.to_logical::<f64>(scale_factor);
                        match window_id {
                            CapWindowId::Main => {
                                let display_id =
                                    display_id_for_position(logical_pos.x, logical_pos.y);
                                window_position_persistence::queue_main_position(
                                    app,
                                    general_settings::WindowPosition {
                                        x: logical_pos.x,
                                        y: logical_pos.y,
                                        display_id,
                                    },
                                );
                            }
                            CapWindowId::Camera => {
                                let guard = app.state::<CameraWindowPositionGuard>();
                                if guard.should_ignore() {
                                    return;
                                }
                                window_position_persistence::queue_camera_position(
                                    app,
                                    logical_pos.x,
                                    logical_pos.y,
                                );
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        })
        .build(tauri_context)
        .expect("error while running tauri application")
        .run(move |_handle, event| {
            let handle = _handle.clone();
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                handle_run_event(&handle, event);
            }));

            if let Err(panic) = result {
                let message = panic_payload_message(&panic);
                tracing::error!(panic = %message, "Suppressed panic in Tauri RunEvent handler");
                sentry::capture_message(
                    &format!("Tauri RunEvent panic suppressed: {message}"),
                    sentry::Level::Error,
                );
            }
        });
}

fn panic_payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

fn handle_run_event(_handle: &AppHandle, event: tauri::RunEvent) {
    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let should_focus_onboarding = should_show_onboarding(_handle);

            if should_focus_onboarding
                && let Some(onboarding) = CapWindowId::Onboarding.get(_handle)
            {
                onboarding.show().ok();
                onboarding.set_focus().ok();
                return;
            }

            let has_window = _handle.webview_windows().iter().any(|(label, _)| {
                label.starts_with("editor-")
                    || label.starts_with("screenshot-editor-")
                    || label.as_str() == "settings"
                    || label.as_str() == "signin"
                    || (should_focus_onboarding && label.as_str() == "onboarding")
            });

            if has_window {
                if let Some(window) = _handle
                    .webview_windows()
                    .iter()
                    .find(|(label, _)| {
                        label.starts_with("editor-")
                            || label.starts_with("screenshot-editor-")
                            || label.as_str() == "settings"
                            || label.as_str() == "signin"
                            || (should_focus_onboarding && label.as_str() == "onboarding")
                    })
                    .map(|(_, window)| window.clone())
                {
                    window.set_focus().ok();
                }
            } else {
                let handle = _handle.clone();
                spawn_on_runtime(async move {
                    let _ = ShowCapWindow::Main {
                        init_target_mode: None,
                    }
                    .show(&handle)
                    .await;
                });
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if _handle
                .try_state::<AppExitState>()
                .is_some_and(|state| state.is_exiting())
            {
                return;
            }

            api.prevent_exit();

            let _ = code;
            let handle = _handle.clone();
            spawn_on_runtime(async move {
                request_app_exit(handle).await;
            });
        }
        tauri::RunEvent::Exit => {
            let already_exiting = match _handle.try_state::<AppExitState>() {
                Some(state) => !state.begin(),
                None => false,
            };
            if already_exiting {
                return;
            }

            let handle = _handle.clone();
            spawn_on_runtime(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    cleanup_app_resources_for_exit(&handle),
                )
                .await;
            });
        }
        _ => {}
    }
}

fn spawn_on_runtime<F>(future: F)
where
    F: Future<Output = ()> + Send + 'static,
{
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(future);
        }
        Err(err) => {
            tracing::warn!(error = %err, "No tokio runtime available; dropping background task");
        }
    }
}

#[cfg(target_os = "windows")]
fn has_open_editor_window(app: &AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| matches!(CapWindowId::from_str(label), Ok(CapWindowId::Editor { .. })))
}

fn restore_main_windows_if_no_editors(app: &AppHandle) {
    let has_other_editors = app.webview_windows().keys().any(|label| {
        matches!(
            CapWindowId::from_str(label),
            Ok(CapWindowId::Editor { .. } | CapWindowId::ScreenshotEditor { .. })
        )
    });

    if !has_other_editors {
        if CapWindowId::Settings.get(app).is_none() {
            if let Some(main) = CapWindowId::Main.get(app) {
                let _ = main.show();
            }

            restore_camera_window(app);
        }

        spawn_on_runtime(captions::release_ml_models());
    }
}

fn restore_camera_window(app: &AppHandle) {
    let should_restore_camera = app
        .try_state::<ArcLock<App>>()
        .and_then(|state| {
            state
                .try_read()
                .ok()
                .map(|state| state.selected_camera_id.is_some() && !state.camera_cleanup_done)
        })
        .unwrap_or(false);

    if should_restore_camera {
        let app = app.clone();
        spawn_on_runtime(async move {
            let Some(operation_lock) = app.try_state::<CameraWindowOperationLock>() else {
                warn!("Camera window operation lock unavailable during restore");
                return;
            };
            let _operation_guard = operation_lock.lock().await;
            let _ = ShowCapWindow::Camera { centered: false }.show(&app).await;
        });
    }
}

fn close_target_select_overlays(app: &AppHandle) {
    let focus_manager = app.try_state::<target_select_overlay::WindowFocusManager>();
    let mut saw_overlay = false;

    for (label, window) in app.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay { display_id }) = CapWindowId::from_str(&label) {
            saw_overlay = true;
            hide_overlay(&window);
            if let Some(focus_manager) = focus_manager.as_ref() {
                focus_manager.destroy(&display_id, app.global_shortcut());
            }
        }
    }

    if !saw_overlay && let Some(focus_manager) = focus_manager {
        focus_manager.shutdown(app);
    }
}

#[cfg(target_os = "windows")]
fn reopen_main_window(app: &AppHandle) {
    if let Some(main) = CapWindowId::Main.get(app) {
        let _ = main.show();
        let _ = main.set_focus();
    } else {
        let handle = app.clone();
        tokio::spawn(async move {
            let _ = ShowCapWindow::Main {
                init_target_mode: None,
            }
            .show(&handle)
            .await;
        });
    }
}

async fn resume_uploads(app: AppHandle) -> Result<(), String> {
    let recordings_dir = recordings_path(&app);
    if !recordings_dir.exists() {
        return Err("Recording directory missing".to_string());
    }

    let entries = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
            // Load recording meta to check for in-progress recordings
            if let Ok(mut meta) = RecordingMeta::load_for_project(&path) {
                let mut needs_save = false;

                // Check if recording is still marked as in-progress and if so mark as failed
                // This should only happen if the application crashes while recording
                match &mut meta.inner {
                    RecordingMetaInner::Studio(meta_box) => {
                        if let StudioRecordingMeta::MultipleSegments { inner } = &mut **meta_box
                            && let Some(StudioRecordingStatus::InProgress) = &inner.status
                        {
                            inner.status = Some(StudioRecordingStatus::Failed {
                                error: "Recording crashed".to_string(),
                            });
                            needs_save = true;
                        }
                    }
                    RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                        meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Failed {
                            error: "Recording crashed".to_string(),
                        });
                        needs_save = true;
                    }
                    _ => {}
                }

                // Save the updated meta if we made changes
                if needs_save && let Err(err) = meta.save_for_project() {
                    error!("Failed to save recording meta for {path:?}: {err}");
                }

                // Handle upload resumption
                if let Some(upload_meta) = meta.upload {
                    match upload_meta {
                        UploadMeta::MultipartUpload {
                            video_id: _,
                            file_path,
                            pre_created_video,
                            recording_dir,
                        } => {
                            InstantMultipartUpload::spawn(
                                app.clone(),
                                file_path,
                                pre_created_video,
                                recording_dir,
                                None,
                            );
                        }
                        UploadMeta::SinglePartUpload {
                            video_id,
                            file_path,
                            screenshot_path,
                            recording_dir,
                        } => {
                            let app = app.clone();
                            tokio::spawn(async move {
                                if let Ok(meta) = build_video_meta(&file_path)
                                    .map_err(|error| {
                                        error!("Failed to resume video upload. error getting video metadata: {error}");

                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Failed { error });
                                            meta.save_for_project().map_err(|err| error!("Error saving project metadata: {err}")).ok();
                                        }
                                    })
                                    && let Ok(uploaded_video) = upload_video(
                                        &app,
                                        video_id,
                                        file_path,
                                        screenshot_path,
                                        meta,
                                        None,
                                    )
                                    .await
                                    .map_err(|error| {
                                        error!("Error completing resumed upload for video: {error}");

                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Failed { error: error.to_string() });
                                            meta.save_for_project().map_err(|err| error!("Error saving project metadata: {err}")).ok();
                                        }
                                    })
                                    {
                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Complete);
                                            meta.sharing = Some(SharingMeta {
                                                link: uploaded_video.link.clone(),
                                                id: uploaded_video.id.clone(),
                                            });
                                            meta.save_for_project()
                                                .map_err(|e| error!("Failed to save recording meta: {e}"))
                                                .ok();
                                        }

                                        let _ = app
                                            .state::<ArcLock<ClipboardContext>>()
                                            .write()
                                            .await
                                            .set_text(uploaded_video.link.clone());
                                        NotificationType::ShareableLinkCopied.send(&app);
                                    }
                            });
                        }
                        UploadMeta::SegmentUpload {
                            video_id,
                            pre_created_video,
                            recording_dir,
                        } => {
                            info!(video_id = video_id, "Resuming segment upload on restart");
                            let content_dir = recording_dir.join("content");
                            let display_dir = content_dir.join("display");
                            let audio_dir = content_dir.join("audio");

                            let (segment_tx, segment_rx) = std::sync::mpsc::channel::<
                                cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent,
                            >();

                            use cap_enc_ffmpeg::segmented_stream::{
                                SegmentCompletedEvent, SegmentMediaType,
                            };

                            fn read_durations_from_manifest(
                                dir: &std::path::Path,
                            ) -> std::collections::HashMap<u32, f64> {
                                let manifest_path = dir.join("manifest.json");
                                let mut map = std::collections::HashMap::new();
                                if let Ok(text) = std::fs::read_to_string(&manifest_path)
                                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&text)
                                    && let Some(segments) =
                                        v.get("segments").and_then(|s| s.as_array())
                                {
                                    for seg in segments {
                                        if let Some(index) =
                                            seg.get("index").and_then(|i| i.as_u64())
                                            && let Some(duration) =
                                                seg.get("duration").and_then(|d| d.as_f64())
                                            && seg
                                                .get("is_complete")
                                                .and_then(|c| c.as_bool())
                                                .unwrap_or(false)
                                        {
                                            map.insert(index as u32, duration);
                                        }
                                    }
                                }
                                map
                            }

                            let scan_and_send = |dir: &std::path::Path,
                                                 media_type: SegmentMediaType,
                                                 tx: &std::sync::mpsc::Sender<
                                SegmentCompletedEvent,
                            >| {
                                if !dir.exists() {
                                    return;
                                }
                                let durations = read_durations_from_manifest(dir);
                                let init_path = dir.join("init.mp4");
                                if init_path.exists()
                                    && let Ok(meta) = std::fs::metadata(&init_path)
                                {
                                    let _ = tx.send(SegmentCompletedEvent {
                                        path: init_path,
                                        index: 0,
                                        duration: 0.0,
                                        file_size: meta.len(),
                                        is_init: true,
                                        media_type,
                                    });
                                }
                                if let Ok(entries) = std::fs::read_dir(dir) {
                                    let mut segments: Vec<_> = entries
                                        .filter_map(|e| e.ok())
                                        .filter(|e| {
                                            e.path().extension().is_some_and(|ext| ext == "m4s")
                                        })
                                        .collect();
                                    segments.sort_by_key(|e| e.file_name());
                                    for entry in segments {
                                        let path = entry.path();
                                        if let Some(name) =
                                            path.file_name().and_then(|n| n.to_str())
                                            && let Some(idx_str) = name
                                                .strip_prefix("segment_")
                                                .and_then(|s| s.strip_suffix(".m4s"))
                                            && let Ok(index) = idx_str.parse::<u32>()
                                        {
                                            let file_size = std::fs::metadata(&path)
                                                .map(|m| m.len())
                                                .unwrap_or(0);
                                            let duration =
                                                durations.get(&index).copied().unwrap_or(3.0);
                                            let _ = tx.send(SegmentCompletedEvent {
                                                path,
                                                index,
                                                duration,
                                                file_size,
                                                is_init: false,
                                                media_type,
                                            });
                                        }
                                    }
                                }
                            };

                            scan_and_send(&display_dir, SegmentMediaType::Video, &segment_tx);
                            scan_and_send(&audio_dir, SegmentMediaType::Audio, &segment_tx);
                            drop(segment_tx);

                            crate::upload::SegmentUploader::spawn(
                                app.clone(),
                                video_id,
                                segment_rx,
                                None,
                                recording_dir,
                                pre_created_video,
                            );
                        }
                        UploadMeta::Failed { .. } | UploadMeta::Complete => {}
                    }
                }
            }
        }
    }

    Ok(())
}

async fn create_editor_instance_impl(
    app: &AppHandle,
    path: PathBuf,
    frame_cb: Box<dyn FnMut(cap_editor::EditorFrameOutput) + Send>,
) -> Result<(Arc<EditorInstance>, tauri::EventId), String> {
    let app = app.clone();

    wait_for_recording_ready(&app, &path).await?;

    let shared_device =
        gpu_context::get_shared_gpu()
            .await
            .map(|shared| cap_rendering::SharedWgpuDevice {
                instance: (*shared.instance).clone(),
                adapter: (*shared.adapter).clone(),
                device: (*shared.device).clone(),
                queue: (*shared.queue).clone(),
                is_software_adapter: shared.is_software_adapter,
            });

    let instance = {
        let app = app.clone();
        EditorInstance::new(
            path,
            move |state| {
                let _ = EditorStateChanged::new(state).emit(&app);
            },
            frame_cb,
            shared_device,
        )
        .await?
    };

    let event_id = RenderFrameEvent::listen_any(&app, {
        let preview_tx = instance.preview_tx.clone();
        move |e| {
            preview_tx.send_modify(|v| {
                *v = Some((
                    e.payload.frame_number,
                    e.payload.fps,
                    e.payload.resolution_base,
                ));
            });
        }
    });

    Ok((instance, event_id))
}

async fn wait_for_recording_ready(app: &AppHandle, path: &Path) -> Result<(), String> {
    let finalizing_state = app.state::<FinalizingRecordings>();

    if let Some(mut rx) = finalizing_state.is_finalizing(path) {
        info!("Recording is being finalized, waiting for completion...");
        rx.wait_for(|&ready| ready)
            .await
            .map_err(|_| "Finalization was cancelled".to_string())?;
        info!("Recording finalization completed");
        return Ok(());
    }

    let meta = match RecordingMeta::load_for_project(path) {
        Ok(meta) => meta,
        Err(e) => {
            return Err(format!("Failed to load recording meta: {e}"));
        }
    };

    if let Some(studio_meta) = meta.studio_meta()
        && matches!(studio_meta.status(), StudioRecordingStatus::InProgress)
    {
        info!("Recording/import is in progress, waiting for completion...");
        const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(250);
        const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(600);
        let start = std::time::Instant::now();

        loop {
            if start.elapsed() > MAX_WAIT {
                return Err("Timed out waiting for import to complete".to_string());
            }

            tokio::time::sleep(POLL_INTERVAL).await;

            let current_meta = match RecordingMeta::load_for_project(path) {
                Ok(m) => m,
                Err(_) => continue,
            };

            if let Some(current_studio) = current_meta.studio_meta() {
                match current_studio.status() {
                    StudioRecordingStatus::Complete => {
                        info!("Recording/import completed");
                        break;
                    }
                    StudioRecordingStatus::Failed { error } => {
                        return Err(format!("Import failed: {error}"));
                    }
                    StudioRecordingStatus::InProgress => continue,
                    StudioRecordingStatus::NeedsRemux => break,
                }
            }
        }
    }

    let meta = RecordingMeta::load_for_project(path)
        .map_err(|e| format!("Failed to reload recording meta: {e}"))?;

    if let Some(studio_meta) = meta.studio_meta()
        && recording::needs_fragment_remux(path, studio_meta)
    {
        info!("Recording needs remux (crash recovery), starting remux...");
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || recording::remux_fragmented_recording(&path))
            .await
            .map_err(|e| format!("Remux task panicked: {e}"))??;
        info!("Crash recovery remux completed");
    }

    Ok(())
}

fn recordings_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("recordings");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

// fn recording_path(app: &AppHandle, recording_id: &str) -> PathBuf {
//     recordings_path(app).join(format!("{recording_id}.cap"))
// }

fn screenshots_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("screenshots");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

// fn screenshot_path(app: &AppHandle, screenshot_id: &str) -> PathBuf {
//     screenshots_path(app).join(format!("{screenshot_id}.cap"))
// }

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn global_message_dialog(app: AppHandle, message: String) {
    app.dialog().message(message).show(|_| {});
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard))]
async fn write_clipboard_string(
    clipboard: MutableState<'_, ClipboardContext>,
    text: String,
) -> Result<(), String> {
    let writer = clipboard
        .try_write()
        .map_err(|e| format!("Failed to acquire lock on clipboard state: {e}"))?;
    writer
        .set_text(text)
        .map_err(|e| format!("Failed to write text to clipboard: {e}"))
}

#[tauri::command(async)]
#[specta::specta]
fn format_project_name(
    template: Option<String>,
    target_name: String,
    target_kind: String,
    recording_mode: RecordingMode,
    datetime: Option<chrono::DateTime<chrono::Local>>,
) -> String {
    recording::format_project_name(
        template.as_deref(),
        target_name.as_str(),
        target_kind.as_str(),
        recording_mode,
        datetime,
    )
}

trait EventExt: tauri_specta::Event {
    fn listen_any_spawn<Fut>(
        app: &AppHandle,
        handler: impl Fn(Self, AppHandle) -> Fut + Send + 'static + Clone,
    ) -> tauri::EventId
    where
        Fut: Future + Send,
        Self: serde::de::DeserializeOwned + Send + 'static,
    {
        let app = app.clone();
        Self::listen_any(&app.clone(), move |e| {
            let app = app.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                (handler)(e.payload, app).await;
            });
        })
    }
}

impl<T: tauri_specta::Event> EventExt for T {}

fn open_project_from_path(path: &Path, app: AppHandle) -> Result<(), String> {
    let meta = RecordingMeta::load_for_project(path).map_err(|v| v.to_string())?;

    match &meta.inner {
        RecordingMetaInner::Studio(meta) => {
            let status = meta.status();
            if let StudioRecordingStatus::Failed { .. } = status {
                return Err("Unable to open failed recording".to_string());
            } else if let StudioRecordingStatus::InProgress = status {
                return Err("Recording in progress".to_string());
            }

            let project_path = path.to_path_buf();
            tokio::spawn(async move { ShowCapWindow::Editor { project_path }.show(&app).await });
        }
        RecordingMetaInner::Instant(_) => {
            let mp4_path = path.join("content/output.mp4");

            if mp4_path.exists() && mp4_path.is_file() {
                let _ = app
                    .opener()
                    .open_path(mp4_path.to_str().unwrap_or_default(), None::<String>);
                if let Some(main_window) = CapWindowId::Main.get(&app) {
                    main_window.hide().ok();
                }
            }
        }
    }

    Ok(())
}
