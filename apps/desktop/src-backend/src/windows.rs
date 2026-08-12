use std::{
    ops::Deref,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Duration,
};

use cap_desktop_runtime::{
    AppHandle, DesktopOperation, Event, LogicalPosition, Position, WebviewWindow, Window,
    WindowOptions, WindowState,
};
use cap_recording::{feeds, sources::screen_capture::ScreenCaptureTarget};
use scap_targets::DisplayId;
use serde::Deserialize;
use specta::Type;
use tracing::{error, warn};

use crate::{
    App, ArcLock, NewNotification, camera_preview_error_message,
    editor_window::PendingEditorInstances,
    emit_camera_preview_clear, emit_camera_preview_error,
    recording::{RecordingEvent, RecordingInputKind},
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    screenshot_editor::PendingScreenshotEditorInstances,
};

pub fn hide_overlay(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(true);
    let _ = window.hide();
}

pub fn show_overlay(window: &WebviewWindow) {
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.show();
}

pub fn logical_point_position(pos_x: f64, pos_y: f64) -> Position {
    LogicalPosition::new(pos_x, pos_y).into()
}

pub(crate) async fn ensure_camera_input_active(app_state: &mut App) {
    if let Some(id) = app_state.selected_camera_id.clone()
        && !app_state.camera_in_use
    {
        let settings = RecordingSettingsStore::camera_settings_for(&app_state.handle, &id);
        match app_state
            .camera_feed
            .ask(feeds::camera::SetInput { id, settings })
            .await
        {
            Ok(ready_future) => {
                if let Err(error) = ready_future.await {
                    error!(%error, "Camera failed to initialize");
                    return;
                }
            }
            Err(error) => {
                error!(%error, "Failed to send SetInput to camera feed");
                return;
            }
        }
        app_state.camera_in_use = true;
        app_state.camera_cleanup_done = false;
    }
}

pub(crate) async fn restore_main_window_inputs(app: &AppHandle) {
    let Some(state) = app.try_state::<ArcLock<App>>() else {
        warn!("App state unavailable while restoring main window inputs");
        return;
    };
    if !state
        .try_read()
        .map(|state| !state.is_recording_active_or_pending())
        .unwrap_or(false)
    {
        return;
    }

    let settings = RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .unwrap_or_default();
    if let Err(error) = crate::set_mic_input(state.clone(), settings.mic_name).await {
        warn!(%error, "Failed to restore microphone input for main window");
    }

    let camera_to_restore = state
        .try_read()
        .ok()
        .and_then(|state| {
            (!state.camera_cleanup_done && !state.camera_in_use)
                .then(|| {
                    state
                        .selected_camera_id
                        .clone()
                        .or(settings.camera_id.clone())
                })
                .flatten()
        })
        .filter(crate::is_camera_available);

    let Some(camera_id) = camera_to_restore else {
        return;
    };
    emit_camera_preview_clear(app);
    let camera_settings = RecordingSettingsStore::camera_settings_for(app, &camera_id);
    let camera_feed = {
        let app_state = &mut *state.write().await;
        app_state.selected_camera_id = Some(camera_id.clone());
        app_state.camera_in_use = true;
        app_state.camera_cleanup_done = false;
        app_state.camera_feed.clone()
    };

    let mut attempts = 0;
    let result = loop {
        attempts += 1;
        match camera_feed
            .ask(feeds::camera::SetInput {
                id: camera_id.clone(),
                settings: camera_settings,
            })
            .await
        {
            Ok(ready) => match ready.await {
                Ok(_) => break Ok(()),
                Err(error) if attempts < 3 => {
                    warn!(%error, attempts, "Camera restore attempt failed");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err(error) => break Err(error.to_string()),
            },
            Err(error) if attempts < 3 => {
                warn!(%error, attempts, "Camera restore request failed");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(error) => break Err(error.to_string()),
        }
    };

    if let Err(error) = result {
        let message = camera_preview_error_message(&error);
        let _ = camera_feed.ask(feeds::camera::RemoveInput).await;
        let emit_input_lost = {
            let app_state = &mut *state.write().await;
            app_state.selected_camera_id = None;
            app_state.camera_in_use = false;
            app_state
                .disconnected_inputs
                .insert(RecordingInputKind::Camera)
        };
        if emit_input_lost {
            let _ = RecordingEvent::InputLost {
                input: RecordingInputKind::Camera,
            }
            .emit(app);
        }
        emit_camera_preview_error(app, message.clone());
        let _ = NewNotification {
            title: "Camera unavailable".to_string(),
            body: message,
            is_error: true,
        }
        .emit(app);
    }
}

pub(crate) async fn cleanup_camera_window(
    app: &AppHandle,
    window: Option<&WebviewWindow>,
    _reset_panel: bool,
    wait_for_removal: bool,
) -> bool {
    let windows = window
        .cloned()
        .map(|window| vec![window])
        .unwrap_or_else(|| {
            app.webview_windows()
                .into_iter()
                .filter(|(label, _)| is_camera_window_label(label))
                .map(|(_, window)| window)
                .collect()
        });
    for window in windows {
        let _ = window.destroy();
    }
    if wait_for_removal {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    !app.webview_windows()
        .keys()
        .any(|label| is_camera_window_label(label))
}

fn is_camera_window_label(label: &str) -> bool {
    label == "camera"
        || label
            .strip_prefix("camera-")
            .is_some_and(|suffix| suffix.parse::<u64>().is_ok())
}

#[derive(Clone, Deserialize, Type)]
pub enum CapWindowId {
    Main,
    Settings,
    Editor { id: u32 },
    RecordingsOverlay,
    WindowCaptureOccluder { screen_id: DisplayId },
    TargetSelectOverlay { display_id: DisplayId },
    CaptureArea,
    Camera,
    RecordingControls,
    Upgrade,
    ModeSelect,
    Debug,
    ScreenshotEditor { id: u32 },
    Onboarding,
    Teleprompter,
}

impl FromStr for CapWindowId {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(match value {
            "main" => Self::Main,
            "settings" => Self::Settings,
            value if is_camera_window_label(value) => Self::Camera,
            "capture-area" => Self::CaptureArea,
            "in-progress-recording" => Self::RecordingControls,
            "recordings-overlay" => Self::RecordingsOverlay,
            "upgrade" => Self::Upgrade,
            "mode-select" => Self::ModeSelect,
            "debug" => Self::Debug,
            "onboarding" => Self::Onboarding,
            "teleprompter" => Self::Teleprompter,
            value if value.starts_with("editor-") => Self::Editor {
                id: value
                    .strip_prefix("editor-")
                    .expect("guarded by starts_with")
                    .parse::<u32>()
                    .map_err(|error| error.to_string())?,
            },
            value if value.starts_with("screenshot-editor-") => Self::ScreenshotEditor {
                id: value
                    .strip_prefix("screenshot-editor-")
                    .expect("guarded by starts_with")
                    .parse::<u32>()
                    .map_err(|error| error.to_string())?,
            },
            value if value.starts_with("window-capture-occluder-") => Self::WindowCaptureOccluder {
                screen_id: value
                    .strip_prefix("window-capture-occluder-")
                    .expect("guarded by starts_with")
                    .parse::<DisplayId>()
                    .map_err(|error| error.to_string())?,
            },
            value if value.starts_with("target-select-overlay-") => Self::TargetSelectOverlay {
                display_id: value
                    .strip_prefix("target-select-overlay-")
                    .expect("guarded by starts_with")
                    .parse::<DisplayId>()
                    .map_err(|error| error.to_string())?,
            },
            _ => return Err(format!("unknown window label: {value}")),
        })
    }
}

impl std::fmt::Display for CapWindowId {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Main => write!(formatter, "main"),
            Self::Settings => write!(formatter, "settings"),
            Self::Editor { id } => write!(formatter, "editor-{id}"),
            Self::RecordingsOverlay => write!(formatter, "recordings-overlay"),
            Self::WindowCaptureOccluder { screen_id } => {
                write!(formatter, "window-capture-occluder-{screen_id}")
            }
            Self::TargetSelectOverlay { display_id } => {
                write!(formatter, "target-select-overlay-{display_id}")
            }
            Self::CaptureArea => write!(formatter, "capture-area"),
            Self::Camera => write!(formatter, "camera"),
            Self::RecordingControls => write!(formatter, "in-progress-recording"),
            Self::Upgrade => write!(formatter, "upgrade"),
            Self::ModeSelect => write!(formatter, "mode-select"),
            Self::Debug => write!(formatter, "debug"),
            Self::ScreenshotEditor { id } => write!(formatter, "screenshot-editor-{id}"),
            Self::Onboarding => write!(formatter, "onboarding"),
            Self::Teleprompter => write!(formatter, "teleprompter"),
        }
    }
}

impl CapWindowId {
    pub fn label(&self) -> String {
        self.to_string()
    }

    #[cfg(target_os = "macos")]
    pub fn activates_dock(&self) -> bool {
        matches!(
            self,
            Self::Main
                | Self::Editor { .. }
                | Self::ScreenshotEditor { .. }
                | Self::Settings
                | Self::Upgrade
                | Self::ModeSelect
                | Self::Onboarding
        )
    }

    pub fn title(&self) -> String {
        match self {
            Self::Settings => "Cap Settings",
            Self::WindowCaptureOccluder { .. } => "Cap Window Capture Occluder",
            Self::CaptureArea => "Cap Capture Area",
            Self::RecordingControls => "Cap Recording Controls",
            Self::Editor { .. } => "Cap Editor",
            Self::ScreenshotEditor { .. } => "Cap Screenshot Editor",
            Self::ModeSelect => "Cap Mode Selection",
            Self::Onboarding => "Welcome to Cap",
            Self::Camera => "Cap Camera",
            Self::RecordingsOverlay => "Cap Recordings Overlay",
            Self::TargetSelectOverlay { .. } => "Cap Target Select",
            Self::Teleprompter => "Cap Teleprompter",
            _ => "Cap",
        }
        .to_string()
    }

    pub fn get(&self, app: &AppHandle) -> Option<WebviewWindow> {
        if matches!(self, Self::Camera) {
            return app
                .webview_windows()
                .into_iter()
                .filter(|(label, _)| is_camera_window_label(label))
                .max_by_key(|(label, _)| label.clone())
                .map(|(_, window)| window);
        }
        app.get_webview_window(&self.label())
    }

    fn min_size(&self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Main => (330.0, 395.0),
            Self::Editor { .. } => (1275.0, 800.0),
            Self::ScreenshotEditor { .. } => (800.0, 600.0),
            Self::Settings => (780.0, 560.0),
            Self::Camera => (200.0, 200.0),
            Self::Upgrade => (950.0, 850.0),
            Self::ModeSelect => (580.0, 340.0),
            Self::Onboarding => (860.0, 690.0),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Type, Deserialize)]
pub enum ShowCapWindow {
    Main {
        init_target_mode: Option<RecordingTargetMode>,
    },
    Settings {
        page: Option<String>,
    },
    Editor {
        project_path: PathBuf,
    },
    RecordingsOverlay,
    WindowCaptureOccluder {
        screen_id: DisplayId,
    },
    TargetSelectOverlay {
        display_id: DisplayId,
        target_mode: Option<RecordingTargetMode>,
    },
    CaptureArea {
        screen_id: DisplayId,
    },
    Camera {
        centered: bool,
    },
    InProgressRecording {
        countdown: Option<u32>,
        #[serde(default)]
        capture_target: Option<ScreenCaptureTarget>,
    },
    Upgrade,
    ModeSelect,
    ScreenshotEditor {
        path: PathBuf,
    },
    Onboarding,
}

impl ShowCapWindow {
    pub async fn show(&self, app: &AppHandle) -> cap_desktop_runtime::Result<WebviewWindow> {
        self.prepare(app).await;
        let id = self.id(app);
        if let Some(window) = id.get(app) {
            window.show()?;
            window.set_focus()?;
            return Ok(window);
        }

        let (route, width, height, always_on_top, skip_taskbar, focus, visible) = match self {
            Self::Main { init_target_mode } => (
                format!("/{}", target_mode_query(init_target_mode.as_ref())),
                352.0,
                520.0,
                false,
                false,
                true,
                true,
            ),
            Self::Settings { page } => (
                format!("/settings/{}", page.as_deref().unwrap_or_default()),
                782.0,
                775.0,
                false,
                false,
                true,
                true,
            ),
            Self::Editor { .. } => (
                "/editor".to_string(),
                1275.0,
                800.0,
                false,
                false,
                true,
                false,
            ),
            Self::ScreenshotEditor { .. } => (
                "/screenshot-editor".to_string(),
                1100.0,
                760.0,
                false,
                false,
                true,
                false,
            ),
            Self::RecordingsOverlay => (
                "/recordings-overlay".to_string(),
                440.0,
                560.0,
                true,
                true,
                false,
                false,
            ),
            Self::WindowCaptureOccluder { .. } => (
                "/window-capture-occluder".to_string(),
                800.0,
                600.0,
                true,
                true,
                false,
                true,
            ),
            Self::TargetSelectOverlay {
                display_id,
                target_mode,
            } => (
                format!(
                    "/target-select-overlay?displayId={display_id}{}",
                    target_mode_param(target_mode.as_ref())
                ),
                800.0,
                600.0,
                true,
                true,
                false,
                true,
            ),
            Self::CaptureArea { screen_id } => (
                format!("/capture-area?screenId={screen_id}"),
                800.0,
                600.0,
                true,
                true,
                true,
                true,
            ),
            Self::Camera { .. } => ("/camera".to_string(), 320.0, 320.0, true, true, false, true),
            Self::InProgressRecording { countdown, .. } => (
                format!(
                    "/in-progress-recording?countdown={}",
                    countdown.unwrap_or_default()
                ),
                360.0,
                120.0,
                true,
                true,
                false,
                true,
            ),
            Self::Upgrade => (
                "/upgrade".to_string(),
                950.0,
                850.0,
                false,
                false,
                true,
                true,
            ),
            Self::ModeSelect => (
                "/mode-select".to_string(),
                580.0,
                340.0,
                false,
                false,
                true,
                true,
            ),
            Self::Onboarding => (
                "/onboarding".to_string(),
                860.0,
                690.0,
                false,
                false,
                true,
                true,
            ),
        };
        let (min_width, min_height) = id
            .min_size()
            .map_or((None, None), |(width, height)| (Some(width), Some(height)));
        let initialization = self.initialization(app).await?;
        let label = id.label();
        app.send(cap_desktop_runtime::BackendMessage::CreateWindow {
            options: WindowOptions {
                label: label.clone(),
                route,
                title: id.title(),
                x: None,
                y: None,
                width,
                height,
                min_width,
                min_height,
                transparent: matches!(
                    id,
                    CapWindowId::Main
                        | CapWindowId::Onboarding
                        | CapWindowId::Camera
                        | CapWindowId::CaptureArea
                        | CapWindowId::TargetSelectOverlay { .. }
                        | CapWindowId::RecordingControls
                        | CapWindowId::RecordingsOverlay
                        | CapWindowId::WindowCaptureOccluder { .. }
                ),
                decorations: false,
                resizable: !matches!(
                    id,
                    CapWindowId::TargetSelectOverlay { .. }
                        | CapWindowId::RecordingControls
                        | CapWindowId::RecordingsOverlay
                ),
                always_on_top,
                visible_on_all_workspaces: always_on_top,
                skip_taskbar,
                content_protected: true,
                focus,
                visible,
                initialization,
            },
        })?;
        app.update_window_state(label.clone(), WindowState::default());
        Ok(Window::new(app.clone(), label))
    }

    async fn initialization(
        &self,
        app: &AppHandle,
    ) -> cap_desktop_runtime::Result<serde_json::Value> {
        match self {
            Self::Main { init_target_mode } => Ok(serde_json::json!({
                "initialTargetMode": init_target_mode,
            })),
            Self::TargetSelectOverlay { .. } => Ok(serde_json::json!({
                "cameraWsPort": camera_ws_port(app).await?,
            })),
            Self::Camera { centered } => Ok(serde_json::json!({
                "cameraWsPort": camera_ws_port(app).await?,
                "cameraOnlyMode": centered,
                "enableNativeCameraPreview":
                    crate::general_settings::GeneralSettingsStore::native_camera_preview_enabled(app),
            })),
            Self::InProgressRecording { countdown, .. } => Ok(serde_json::json!({
                "countdown": countdown.unwrap_or_default(),
            })),
            _ => Ok(serde_json::json!({})),
        }
    }

    async fn prepare(&self, app: &AppHandle) {
        match self {
            Self::Editor { project_path } => {
                let state = app.state::<EditorWindowIds>();
                let id = state.id_for(project_path);
                PendingEditorInstances::start_prewarm(
                    app,
                    CapWindowId::Editor { id }.label(),
                    project_path.clone(),
                )
                .await;
            }
            Self::ScreenshotEditor { path } => {
                let state = app.state::<ScreenshotEditorWindowIds>();
                let id = state.id_for(path);
                PendingScreenshotEditorInstances::start_prewarm(
                    app,
                    CapWindowId::ScreenshotEditor { id }.label(),
                    path.clone(),
                )
                .await;
            }
            _ => {}
        }
    }

    pub fn id(&self, app: &AppHandle) -> CapWindowId {
        match self {
            Self::Main { .. } => CapWindowId::Main,
            Self::Settings { .. } => CapWindowId::Settings,
            Self::Editor { project_path } => CapWindowId::Editor {
                id: app.state::<EditorWindowIds>().id_for(project_path),
            },
            Self::RecordingsOverlay => CapWindowId::RecordingsOverlay,
            Self::WindowCaptureOccluder { screen_id } => CapWindowId::WindowCaptureOccluder {
                screen_id: screen_id.clone(),
            },
            Self::TargetSelectOverlay { display_id, .. } => CapWindowId::TargetSelectOverlay {
                display_id: display_id.clone(),
            },
            Self::CaptureArea { .. } => CapWindowId::CaptureArea,
            Self::Camera { .. } => CapWindowId::Camera,
            Self::InProgressRecording { .. } => CapWindowId::RecordingControls,
            Self::Upgrade => CapWindowId::Upgrade,
            Self::ModeSelect => CapWindowId::ModeSelect,
            Self::ScreenshotEditor { path } => CapWindowId::ScreenshotEditor {
                id: app.state::<ScreenshotEditorWindowIds>().id_for(path),
            },
            Self::Onboarding => CapWindowId::Onboarding,
        }
    }
}

async fn camera_ws_port(app: &AppHandle) -> cap_desktop_runtime::Result<u16> {
    let state = app
        .try_state::<ArcLock<App>>()
        .ok_or_else(|| "App state unavailable while creating camera window".to_string())?;
    #[allow(deprecated)]
    let port = state.read().await.camera_ws_port;
    Ok(port)
}

fn target_mode_query(mode: Option<&RecordingTargetMode>) -> String {
    mode.map(|mode| format!("?targetMode={}", mode_name(mode)))
        .unwrap_or_default()
}

fn target_mode_param(mode: Option<&RecordingTargetMode>) -> String {
    mode.map(|mode| format!("&targetMode={}", mode_name(mode)))
        .unwrap_or_default()
}

fn mode_name(mode: &RecordingTargetMode) -> &'static str {
    match mode {
        RecordingTargetMode::Display => "display",
        RecordingTargetMode::Window => "window",
        RecordingTargetMode::Area => "area",
        RecordingTargetMode::Camera => "camera",
    }
}

pub fn update_window_rasterization_scale(_window: &WebviewWindow, _scale_factor: f64) {}

#[cap_desktop_runtime::command]
pub fn set_theme(window: Window, theme: crate::general_settings::AppTheme) {
    let theme = match theme {
        crate::general_settings::AppTheme::System => "system",
        crate::general_settings::AppTheme::Light => "light",
        crate::general_settings::AppTheme::Dark => "dark",
    };
    let _ = window.operation(DesktopOperation::SetTheme {
        theme: theme.to_string(),
    });
}

#[cap_desktop_runtime::command]
pub fn position_traffic_lights(window: Window, controls_inset: Option<(f64, f64)>) {
    let (x, y) = controls_inset
        .map(|(x, y)| (Some(x), Some(y)))
        .unwrap_or((None, None));
    let _ = window.operation(DesktopOperation::SetTrafficLightPosition { x, y });
}

#[cap_desktop_runtime::command]
pub fn set_teleprompter_window_level(window: Window, always_on_top: bool) {
    let _ = window.set_always_on_top(always_on_top);
}

#[cap_desktop_runtime::command]
pub fn set_teleprompter_window_opacity(window: Window, opacity: f64) {
    let _ = window.set_opacity(opacity);
}

#[cfg(target_os = "windows")]
pub fn capture_exclusion_hides_ui() -> bool {
    true
}

#[cfg(not(target_os = "windows"))]
pub fn capture_exclusion_hides_ui() -> bool {
    false
}

pub fn apply_content_protection(app: &AppHandle, enabled: bool) {
    for window in app.webview_windows().into_values() {
        let _ = window.set_content_protected(enabled);
    }
}

#[cap_desktop_runtime::command]
pub fn refresh_window_content_protection(app: AppHandle) -> Result<(), String> {
    apply_content_protection(&app, true);
    Ok(())
}

#[cap_desktop_runtime::command]
pub async fn apply_macos_liquid_glass_background(
    _window: Window,
    enabled: bool,
    radius: f64,
) -> Result<bool, String> {
    let _ = (enabled, radius);
    Ok(false)
}

#[cap_desktop_runtime::command]
pub fn set_window_transparent(_window: Window, value: bool) {
    let _ = value;
}

#[derive(Default)]
pub struct EditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    counter: AtomicU32,
}

impl EditorWindowIds {
    fn id_for(&self, path: &Path) -> u32 {
        let mut ids = self.ids.lock().expect("editor window ids lock poisoned");
        if let Some((_, id)) = ids.iter().find(|(current, _)| current == path) {
            return *id;
        }
        let id = self.counter.fetch_add(1, Ordering::SeqCst);
        ids.push((path.to_path_buf(), id));
        id
    }

    pub fn get(app: &AppHandle) -> cap_desktop_runtime::State<'_, Self> {
        app.state()
    }
}

#[derive(Default)]
pub struct ScreenshotEditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    counter: AtomicU32,
}

impl ScreenshotEditorWindowIds {
    fn id_for(&self, path: &Path) -> u32 {
        let mut ids = self
            .ids
            .lock()
            .expect("screenshot editor window ids lock poisoned");
        if let Some((_, id)) = ids.iter().find(|(current, _)| current == path) {
            return *id;
        }
        let id = self.counter.fetch_add(1, Ordering::SeqCst);
        ids.push((path.to_path_buf(), id));
        id
    }

    pub fn get(app: &AppHandle) -> cap_desktop_runtime::State<'_, Self> {
        app.state()
    }
}

#[derive(Clone, Default)]
pub struct EditorRecordingTarget(pub Arc<Mutex<Option<PathBuf>>>);

impl EditorRecordingTarget {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<Self>().deref().clone()
    }

    pub fn set(app: &AppHandle, path: Option<PathBuf>) {
        *Self::get(app).0.lock().unwrap() = path;
    }

    pub fn current(app: &AppHandle) -> Option<PathBuf> {
        Self::get(app).0.lock().unwrap().clone()
    }

    pub fn take(app: &AppHandle) -> Option<PathBuf> {
        Self::get(app).0.lock().unwrap().take()
    }
}

impl Deref for EditorRecordingTarget {
    type Target = Arc<Mutex<Option<PathBuf>>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

pub fn editor_window_for_path(app: &AppHandle, path: &Path) -> Option<WebviewWindow> {
    let ids = EditorWindowIds::get(app);
    let id = ids
        .ids
        .lock()
        .ok()?
        .iter()
        .find(|(candidate, _)| candidate == path)
        .map(|(_, id)| *id)?;
    CapWindowId::Editor { id }.get(app)
}

#[cfg(test)]
mod tests {
    use super::CapWindowId;
    use std::str::FromStr;

    #[test]
    fn parses_dynamic_window_labels_without_fixed_byte_offsets() {
        for label in [
            "editor-42",
            "screenshot-editor-7",
            "window-capture-occluder-1",
            "target-select-overlay-1",
        ] {
            let parsed = CapWindowId::from_str(label).unwrap();
            assert_eq!(parsed.to_string(), label);
        }
    }
}
