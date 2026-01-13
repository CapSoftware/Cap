#![allow(unused_mut)]
#![allow(unused_imports)]

use anyhow::anyhow;
use futures::pin_mut;
use scap_targets::{Display, DisplayId};
use serde::Deserialize;
use specta::Type;
use std::{
    ops::Deref,
    path::PathBuf,
    str::FromStr,
    sync::{Arc, Mutex, atomic::AtomicU32},
};
use tauri::{
    AppHandle, LogicalPosition, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_specta::Event;
use tokio::sync::RwLock;
use tracing::{debug, error, instrument, warn};

use crate::{
    App, ArcLock, RequestScreenCapturePrewarm, RequestSetTargetMode,
    editor_window::PendingEditorInstances,
    fake_window,
    general_settings::{self, AppTheme, GeneralSettingsStore},
    permissions,
    recording_settings::RecordingTargetMode,
    target_select_overlay::WindowFocusManager,
    window_exclusion::WindowExclusion,
};
use cap_recording::feeds;

#[cfg(target_os = "macos")]
const DEFAULT_TRAFFIC_LIGHTS_INSET: LogicalPosition<f64> = LogicalPosition::new(12.0, 12.0);

const DEFAULT_FALLBACK_DISPLAY_WIDTH: f64 = 1920.0;
const DEFAULT_FALLBACK_DISPLAY_HEIGHT: f64 = 1080.0;

struct CursorMonitorInfo {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl CursorMonitorInfo {
    fn get() -> Self {
        let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
        let bounds = display.raw_handle().logical_bounds();
        let (x, y, width, height) = bounds
            .map(|b| {
                (
                    b.position().x(),
                    b.position().y(),
                    b.size().width(),
                    b.size().height(),
                )
            })
            .unwrap_or((
                0.0,
                0.0,
                DEFAULT_FALLBACK_DISPLAY_WIDTH,
                DEFAULT_FALLBACK_DISPLAY_HEIGHT,
            ));

        Self {
            x,
            y,
            width,
            height,
        }
    }

    fn center_position(&self, window_width: f64, window_height: f64) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + (self.height - window_height) / 2.0;
        (pos_x, pos_y)
    }

    fn bottom_center_position(
        &self,
        window_width: f64,
        window_height: f64,
        offset_y: f64,
    ) -> (f64, f64) {
        let pos_x = self.x + (self.width - window_width) / 2.0;
        let pos_y = self.y + self.height - window_height - offset_y;
        (pos_x, pos_y)
    }

    fn from_window(window: &tauri::WebviewWindow) -> Self {
        let window_pos = window
            .outer_position()
            .ok()
            .map(|p| (p.x as f64, p.y as f64))
            .unwrap_or((0.0, 0.0));

        for display in Display::list() {
            if let Some(bounds) = display.raw_handle().logical_bounds() {
                let (x, y, width, height) = (
                    bounds.position().x(),
                    bounds.position().y(),
                    bounds.size().width(),
                    bounds.size().height(),
                );

                if window_pos.0 >= x
                    && window_pos.0 < x + width
                    && window_pos.1 >= y
                    && window_pos.1 < y + height
                {
                    return Self {
                        x,
                        y,
                        width,
                        height,
                    };
                }
            }
        }

        Self::get()
    }
}

#[derive(Clone, Deserialize, Type)]
pub enum CapWindowId {
    // Contains onboarding + permissions
    Setup,
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
}

impl FromStr for CapWindowId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ok(match s {
            "setup" => Self::Setup,
            "main" => Self::Main,
            "settings" => Self::Settings,
            "camera" => Self::Camera,
            "capture-area" => Self::CaptureArea,
            // legacy identifier
            "in-progress-recording" => Self::RecordingControls,
            "recordings-overlay" => Self::RecordingsOverlay,
            "upgrade" => Self::Upgrade,
            "mode-select" => Self::ModeSelect,
            "debug" => Self::Debug,
            s if s.starts_with("editor-") => Self::Editor {
                id: s
                    .replace("editor-", "")
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("screenshot-editor-") => Self::ScreenshotEditor {
                id: s
                    .replace("screenshot-editor-", "")
                    .parse::<u32>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("window-capture-occluder-") => Self::WindowCaptureOccluder {
                screen_id: s
                    .replace("window-capture-occluder-", "")
                    .parse::<DisplayId>()
                    .map_err(|e| e.to_string())?,
            },
            s if s.starts_with("target-select-overlay-") => Self::TargetSelectOverlay {
                display_id: s
                    .replace("target-select-overlay-", "")
                    .parse::<DisplayId>()
                    .map_err(|e| e.to_string())?,
            },
            _ => return Err(format!("unknown window label: {s}")),
        })
    }
}

impl std::fmt::Display for CapWindowId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Setup => write!(f, "setup"),
            Self::Main => write!(f, "main"),
            Self::Settings => write!(f, "settings"),
            Self::Camera => write!(f, "camera"),
            Self::WindowCaptureOccluder { screen_id } => {
                write!(f, "window-capture-occluder-{screen_id}")
            }
            Self::CaptureArea => write!(f, "capture-area"),
            Self::TargetSelectOverlay { display_id } => {
                write!(f, "target-select-overlay-{display_id}")
            }
            Self::RecordingControls => write!(f, "in-progress-recording"), // legacy identifier
            Self::RecordingsOverlay => write!(f, "recordings-overlay"),
            Self::Upgrade => write!(f, "upgrade"),
            Self::ModeSelect => write!(f, "mode-select"),
            Self::Editor { id } => write!(f, "editor-{id}"),
            Self::Debug => write!(f, "debug"),
            Self::ScreenshotEditor { id } => write!(f, "screenshot-editor-{id}"),
        }
    }
}

impl CapWindowId {
    pub fn label(&self) -> String {
        self.to_string()
    }

    pub fn title(&self) -> String {
        match self {
            Self::Setup => "Cap Setup".to_string(),
            Self::Settings => "Cap Settings".to_string(),
            Self::WindowCaptureOccluder { .. } => "Cap Window Capture Occluder".to_string(),
            Self::CaptureArea => "Cap Capture Area".to_string(),
            Self::RecordingControls => "Cap Recording Controls".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
            Self::ScreenshotEditor { .. } => "Cap Screenshot Editor".to_string(),
            Self::ModeSelect => "Cap Mode Selection".to_string(),
            Self::Camera => "Cap Camera".to_string(),
            Self::RecordingsOverlay => "Cap Recordings Overlay".to_string(),
            _ => "Cap".to_string(),
        }
    }

    pub fn activates_dock(&self) -> bool {
        matches!(
            self,
            Self::Setup
                | Self::Main
                | Self::Editor { .. }
                | Self::ScreenshotEditor { .. }
                | Self::Settings
                | Self::Upgrade
                | Self::ModeSelect
        )
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.label();
        app.get_webview_window(&label)
    }

    #[cfg(target_os = "macos")]
    pub fn traffic_lights_position(&self) -> Option<Option<LogicalPosition<f64>>> {
        match self {
            Self::Editor { .. } | Self::ScreenshotEditor { .. } => {
                Some(Some(LogicalPosition::new(20.0, 32.0)))
            }
            Self::RecordingControls => Some(Some(LogicalPosition::new(-100.0, -100.0))),
            Self::Camera
            | Self::WindowCaptureOccluder { .. }
            | Self::CaptureArea
            | Self::RecordingsOverlay
            | Self::TargetSelectOverlay { .. } => None,
            _ => Some(None),
        }
    }

    pub fn min_size(&self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Setup => (600.0, 600.0),
            Self::Main => (330.0, 345.0),
            Self::Editor { .. } => (1275.0, 800.0),
            Self::ScreenshotEditor { .. } => (800.0, 600.0),
            Self::Settings => (700.0, 540.0),
            Self::Camera => (200.0, 200.0),
            Self::Upgrade => (950.0, 850.0),
            Self::ModeSelect => (580.0, 340.0),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Type, Deserialize)]
pub enum ShowCapWindow {
    Setup,
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
    },
    CaptureArea {
        screen_id: DisplayId,
    },
    Camera,
    InProgressRecording {
        countdown: Option<u32>,
    },
    Upgrade,
    ModeSelect,
    ScreenshotEditor {
        path: PathBuf,
    },
}

impl ShowCapWindow {
    pub async fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        if let Self::Editor { project_path } = &self {
            let state = app.state::<EditorWindowIds>();
            let window_id = {
                let mut s = state.ids.lock().unwrap();
                if !s.iter().any(|(path, _)| path == project_path) {
                    let id = state
                        .counter
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    s.push((project_path.clone(), id));
                    id
                } else {
                    s.iter().find(|(path, _)| path == project_path).unwrap().1
                }
            };

            let window_label = CapWindowId::Editor { id: window_id }.label();
            PendingEditorInstances::start_prewarm(app, window_label, project_path.clone()).await;
        }

        if let Self::ScreenshotEditor { path } = &self {
            let state = app.state::<ScreenshotEditorWindowIds>();
            let mut s = state.ids.lock().unwrap();
            if !s.iter().any(|(p, _)| p == path) {
                s.push((
                    path.clone(),
                    state
                        .counter
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                ));
            }
        }

        if let Some(window) = self.id(app).get(app) {
            let cursor_display_id = if let Self::Main { init_target_mode } = self {
                if init_target_mode.is_some() {
                    Display::get_containing_cursor()
                        .map(|d| d.id().to_string())
                        .or_else(|| Some(Display::primary().id().to_string()))
                } else {
                    None
                }
            } else {
                None
            };

            match self {
                Self::Main { .. } => {
                    let cursor_monitor = CursorMonitorInfo::get();
                    let (pos_x, pos_y) = cursor_monitor.center_position(330.0, 345.0);
                    let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                    if let Some(camera_window) = CapWindowId::Camera.get(app) {
                        const WINDOW_SIZE: f64 = 230.0 * 2.0;
                        let camera_pos_x =
                            cursor_monitor.x + cursor_monitor.width - WINDOW_SIZE - 100.0;
                        let camera_pos_y =
                            cursor_monitor.y + cursor_monitor.height - WINDOW_SIZE - 100.0;
                        let _ = camera_window
                            .set_position(tauri::LogicalPosition::new(camera_pos_x, camera_pos_y));
                    }
                }
                Self::Camera => {
                    const WINDOW_SIZE: f64 = 230.0 * 2.0;
                    let camera_monitor = CapWindowId::Main
                        .get(app)
                        .map(|w| CursorMonitorInfo::from_window(&w))
                        .unwrap_or_else(CursorMonitorInfo::get);
                    let camera_pos_x =
                        camera_monitor.x + camera_monitor.width - WINDOW_SIZE - 100.0;
                    let camera_pos_y =
                        camera_monitor.y + camera_monitor.height - WINDOW_SIZE - 100.0;
                    let _ = window
                        .set_position(tauri::LogicalPosition::new(camera_pos_x, camera_pos_y));
                }
                _ => {}
            }

            window.show().ok();
            window.unminimize().ok();
            window.set_focus().ok();

            if let Self::Main { init_target_mode } = self {
                let _ = RequestSetTargetMode {
                    target_mode: *init_target_mode,
                    display_id: cursor_display_id,
                }
                .emit(app);
            }

            return Ok(window);
        }

        let _id = self.id(app);
        let cursor_monitor = CursorMonitorInfo::get();

        let window = match self {
            Self::Setup => {
                let window = self
                    .window_builder(app, "/setup")
                    .inner_size(600.0, 600.0)
                    .min_inner_size(600.0, 600.0)
                    .resizable(false)
                    .maximized(false)
                    .focused(true)
                    .maximizable(false)
                    .shadow(true)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(600.0, 600.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(600.0, 600.0)) {
                        warn!("Failed to set Setup window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!("Failed to position Setup window on Windows: {}", e);
                    }
                }

                window
            }
            Self::Main { init_target_mode } => {
                if !permissions::do_permissions_check(false).necessary_granted() {
                    return Box::pin(Self::Setup.show(app)).await;
                }

                let title = CapWindowId::Main.title();
                let should_protect = should_protect_window(app, &title);

                let window = self
                    .window_builder(app, "/")
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .minimizable(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .initialization_script(format!(
                        "
                        window.__CAP__ = window.__CAP__ ?? {{}};
                        window.__CAP__.initialTargetMode = {}
                    ",
                        serde_json::to_string(init_target_mode)
                            .expect("Failed to serialize initial target mode")
                    ))
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(330.0, 345.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(target_os = "macos")]
                crate::platform::set_window_level(window.as_ref().window(), 50);

                #[cfg(target_os = "macos")]
                {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let prewarmer =
                            app_handle.state::<crate::platform::ScreenCapturePrewarmer>();
                        prewarmer.request(false).await;
                    });

                    if let Err(error) = (RequestScreenCapturePrewarm { force: false }).emit(app) {
                        warn!(%error, "Failed to emit ScreenCaptureKit prewarm event");
                    }
                }

                window
            }
            Self::TargetSelectOverlay { display_id } => {
                let Some(display) = scap_targets::Display::from_id(display_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };
                let is_hovered_display = scap_targets::Display::get_containing_cursor()
                    .map(|d| d.id())
                    == Some(display.id());

                let title = CapWindowId::TargetSelectOverlay {
                    display_id: display_id.clone(),
                }
                .title();
                let should_protect = should_protect_window(app, &title);

                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/target-select-overlay?displayId={display_id}&isHoveredDisplay={is_hovered_display}"),
                    )
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .content_protected(should_protect)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .transparent(true)
                    .visible(false);

                #[cfg(target_os = "macos")]
                {
                    let position = display.raw_handle().logical_position();
                    let size = display.logical_size().unwrap();

                    window_builder = window_builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                #[cfg(windows)]
                {
                    window_builder = window_builder.inner_size(100.0, 100.0).position(0.0, 0.0);
                }

                let window = window_builder.build()?;

                #[cfg(windows)]
                {
                    let position = display.raw_handle().physical_position().unwrap();
                    let logical_size = display.logical_size().unwrap();
                    let physical_size = display.physical_size().unwrap();
                    use tauri::{LogicalSize, PhysicalPosition, PhysicalSize};
                    let _ = window.set_size(LogicalSize::new(
                        logical_size.width(),
                        logical_size.height(),
                    ));
                    let _ = window.set_position(PhysicalPosition::new(position.x(), position.y()));
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

                    let actual_physical_size = window.inner_size().unwrap();
                    // this third time makes it work when the resulting size is wrong, god knows why
                    if physical_size.width() != actual_physical_size.width as f64 {
                        let _ = window.set_size(LogicalSize::new(
                            logical_size.width(),
                            logical_size.height(),
                        ));
                    }
                }

                app.state::<WindowFocusManager>()
                    .spawn(display_id, window.clone());

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 45);
                }

                window
            }
            Self::Settings { page } => {
                for (label, window) in app.webview_windows() {
                    if let Ok(id) = CapWindowId::from_str(&label)
                        && matches!(
                            id,
                            CapWindowId::TargetSelectOverlay { .. }
                                | CapWindowId::Main
                                | CapWindowId::Camera
                        )
                    {
                        let _ = window.hide();
                    }
                }

                let window = self
                    .window_builder(
                        app,
                        format!("/settings/{}", page.clone().unwrap_or_default()),
                    )
                    .inner_size(600.0, 465.0)
                    .min_inner_size(600.0, 465.0)
                    .resizable(true)
                    .maximized(false)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(600.0, 465.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(600.0, 465.0)) {
                        warn!("Failed to set Settings window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!("Failed to position Settings window on Windows: {}", e);
                    }
                }

                window
            }
            Self::Editor { .. } => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.close();
                };
                if let Some(camera) = CapWindowId::Camera.get(app) {
                    let _ = camera.close();
                };

                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular)
                    .ok();

                let window = self
                    .window_builder(app, "/editor")
                    .maximizable(true)
                    .inner_size(1275.0, 800.0)
                    .min_inner_size(1275.0, 800.0)
                    .focused(true)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(1275.0, 800.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(1275.0, 800.0)) {
                        warn!("Failed to set Editor window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!("Failed to position Editor window on Windows: {}", e);
                    }
                }

                window
            }
            Self::ScreenshotEditor { path: _ } => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.close();
                };
                if let Some(camera) = CapWindowId::Camera.get(app) {
                    let _ = camera.close();
                };

                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Regular)
                    .ok();

                let window = self
                    .window_builder(app, "/screenshot-editor")
                    .maximizable(true)
                    .inner_size(1240.0, 800.0)
                    .min_inner_size(800.0, 600.0)
                    .focused(true)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(1240.0, 800.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(1240.0, 800.0)) {
                        warn!(
                            "Failed to set ScreenshotEditor window size on Windows: {}",
                            e
                        );
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!(
                            "Failed to position ScreenshotEditor window on Windows: {}",
                            e
                        );
                    }
                }

                window
            }
            Self::Upgrade => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let window = self
                    .window_builder(app, "/upgrade")
                    .inner_size(950.0, 850.0)
                    .min_inner_size(950.0, 850.0)
                    .resizable(false)
                    .focused(true)
                    .always_on_top(true)
                    .maximized(false)
                    .shadow(true)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(950.0, 850.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(950.0, 850.0)) {
                        warn!("Failed to set Upgrade window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!("Failed to position Upgrade window on Windows: {}", e);
                    }
                }

                window
            }
            Self::ModeSelect => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let window = self
                    .window_builder(app, "/mode-select")
                    .inner_size(580.0, 340.0)
                    .min_inner_size(580.0, 340.0)
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .focused(true)
                    .shadow(true)
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.center_position(580.0, 340.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                #[cfg(windows)]
                {
                    use tauri::LogicalSize;
                    if let Err(e) = window.set_size(LogicalSize::new(580.0, 340.0)) {
                        warn!("Failed to set ModeSelect window size on Windows: {}", e);
                    }
                    if let Err(e) = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y)) {
                        warn!("Failed to position ModeSelect window on Windows: {}", e);
                    }
                }

                window
            }
            Self::Camera => {
                const WINDOW_SIZE: f64 = 230.0 * 2.0;

                let enable_native_camera_preview = GeneralSettingsStore::get(app)
                    .ok()
                    .and_then(|v| v.map(|v| v.enable_native_camera_preview))
                    .unwrap_or_default();

                {
                    let state = app.state::<ArcLock<App>>();
                    let mut state = state.write().await;

                    if enable_native_camera_preview && state.camera_preview.is_initialized() {
                        warn!("Cleaning up stale camera preview before creating new one");
                        state.camera_preview.on_window_close();
                        if let Some(window) = CapWindowId::Camera.get(app) {
                            window.close().ok();
                        }
                    }

                    let mut window_builder = self
                        .window_builder(app, "/camera")
                        .maximized(false)
                        .resizable(false)
                        .shadow(false)
                        .fullscreen(false)
                        .always_on_top(true)
                        .visible_on_all_workspaces(true)
                        .skip_taskbar(true)
                        .initialization_script(format!(
                            "
			                window.__CAP__ = window.__CAP__ ?? {{}};
			                window.__CAP__.cameraWsPort = {};
		                ",
                            state.camera_ws_port
                        ))
                        .transparent(true)
                        .visible(false);

                    let window = window_builder.build()?;

                    let camera_monitor = CapWindowId::Main
                        .get(app)
                        .map(|w| CursorMonitorInfo::from_window(&w))
                        .unwrap_or(cursor_monitor);
                    let camera_pos_x =
                        camera_monitor.x + camera_monitor.width - WINDOW_SIZE - 100.0;
                    let camera_pos_y =
                        camera_monitor.y + camera_monitor.height - WINDOW_SIZE - 100.0;
                    let _ = window
                        .set_position(tauri::LogicalPosition::new(camera_pos_x, camera_pos_y));

                    if let Some(id) = state.selected_camera_id.clone()
                        && !state.camera_in_use
                    {
                        match state.camera_feed.ask(feeds::camera::SetInput { id }).await {
                            Ok(ready_future) => {
                                if let Err(err) = ready_future.await {
                                    error!("Camera failed to initialize: {err}");
                                }
                            }
                            Err(err) => {
                                error!("Failed to send SetInput to camera feed: {err}");
                            }
                        }
                        state.camera_in_use = true;
                    }

                    if enable_native_camera_preview {
                        let camera_feed = state.camera_feed.clone();
                        if let Err(err) = state
                            .camera_preview
                            .init_window(window.clone(), camera_feed)
                            .await
                        {
                            error!(
                                "Error initializing camera preview, falling back to WebSocket preview: {err}"
                            );
                            window.show().ok();
                        }
                    } else {
                        window.show().ok();
                    }

                    #[cfg(target_os = "macos")]
                    {
                        crate::platform::set_window_level(window.as_ref().window(), 60);

                        _ = window.run_on_main_thread({
                            let window = window.as_ref().window();
                            move || unsafe {
                                let Ok(win) = window.ns_window() else {
                                    return;
                                };
                                let win = win as *const objc2_app_kit::NSWindow;
                                (*win).setCollectionBehavior(
                                		(*win).collectionBehavior() | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary,
                                );
                            }
                        });
                    }

                    window
                }
            }
            Self::WindowCaptureOccluder { screen_id } => {
                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                let title = CapWindowId::WindowCaptureOccluder {
                    screen_id: screen_id.clone(),
                }
                .title();
                let should_protect = should_protect_window(app, &title);

                #[cfg(target_os = "macos")]
                let position = display.raw_handle().logical_position();

                #[cfg(windows)]
                let position = display.raw_handle().physical_position().unwrap();

                let bounds = display.physical_size().unwrap();

                let mut window_builder = self
                    .window_builder(app, "/window-capture-occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .skip_taskbar(true)
                    .inner_size(bounds.width(), bounds.height())
                    .position(position.x(), position.y())
                    .transparent(true);

                let window = window_builder.build()?;

                window.set_ignore_cursor_events(true).unwrap();

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 900);
                }

                window
            }
            Self::CaptureArea { screen_id } => {
                let title = CapWindowId::CaptureArea.title();
                let should_protect = should_protect_window(app, &title);

                let mut window_builder = self
                    .window_builder(app, "/capture-area")
                    .maximized(false)
                    .fullscreen(false)
                    .shadow(false)
                    .resizable(false)
                    .always_on_top(true)
                    .content_protected(should_protect)
                    .skip_taskbar(true)
                    .closable(true)
                    .decorations(false)
                    .transparent(true);

                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                #[cfg(target_os = "macos")]
                if let Some(bounds) = display.raw_handle().logical_bounds() {
                    window_builder = window_builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                #[cfg(windows)]
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    window_builder = window_builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                crate::platform::set_window_level(
                    window.as_ref().window(),
                    objc2_app_kit::NSPopUpMenuWindowLevel,
                );

                // Hide the main window if the target monitor is the same
                if let Some(main_window) = CapWindowId::Main.get(app)
                    && let (Ok(outer_pos), Ok(outer_size)) =
                        (main_window.outer_position(), main_window.outer_size())
                    && let Ok(scale_factor) = main_window.scale_factor()
                    && display.intersects(outer_pos, outer_size, scale_factor)
                {
                    let _ = main_window.minimize();
                };

                window
            }
            Self::InProgressRecording { countdown } => {
                let width = 320.0;
                let height = 150.0;

                let title = CapWindowId::RecordingControls.title();
                let should_protect = should_protect_window(app, &title);

                #[cfg(target_os = "macos")]
                let window = {
                    self.window_builder(app, "/in-progress-recording")
                        .maximized(false)
                        .resizable(false)
                        .fullscreen(false)
                        .shadow(false)
                        .always_on_top(true)
                        .transparent(true)
                        .visible_on_all_workspaces(true)
                        .content_protected(should_protect)
                        .inner_size(width, height)
                        .skip_taskbar(true)
                        .initialization_script(format!(
                            "window.COUNTDOWN = {};",
                            countdown.unwrap_or_default()
                        ))
                        .build()?
                };

                #[cfg(windows)]
                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .inner_size(width, height)
                    .skip_taskbar(false)
                    .initialization_script(format!(
                        "window.COUNTDOWN = {};",
                        countdown.unwrap_or_default()
                    ))
                    .build()?;

                let (pos_x, pos_y) = cursor_monitor.bottom_center_position(width, height, 120.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                debug!(
                    "InProgressRecording window: cursor_monitor=({}, {}, {}, {}), pos=({}, {})",
                    cursor_monitor.x,
                    cursor_monitor.y,
                    cursor_monitor.width,
                    cursor_monitor.height,
                    pos_x,
                    pos_y
                );

                debug!(
                    "InProgressRecording window created: label={}, inner_size={:?}, outer_position={:?}",
                    window.label(),
                    window.inner_size(),
                    window.outer_position()
                );

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 1000);
                }

                #[cfg(target_os = "macos")]
                {
                    let show_result = window.show();
                    debug!(
                        "InProgressRecording window.show() result: {:?}",
                        show_result
                    );
                    fake_window::spawn_fake_window_listener(app.clone(), window.clone());
                }

                #[cfg(windows)]
                {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let show_result = window.show();
                    debug!(
                        "InProgressRecording window.show() result: {:?}",
                        show_result
                    );
                    window.set_focus().ok();
                    fake_window::spawn_fake_window_listener(app.clone(), window.clone());
                }

                window
            }
            Self::RecordingsOverlay => {
                let title = CapWindowId::RecordingsOverlay.title();
                let should_protect = should_protect_window(app, &title);

                let window = self
                    .window_builder(app, "/recordings-overlay")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .accept_first_mouse(true)
                    .content_protected(should_protect)
                    .inner_size(cursor_monitor.width, cursor_monitor.height)
                    .skip_taskbar(true)
                    .transparent(true)
                    .build()?;

                let _ = window.set_position(tauri::LogicalPosition::new(
                    cursor_monitor.x,
                    cursor_monitor.y,
                ));

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        move || {
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

                            let panel = window.to_panel().unwrap();

                            panel.set_level(cocoa::appkit::NSMainMenuWindowLevel);

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                            );

                            // seems like this doesn't work properly -_-
                            #[allow(non_upper_case_globals)]
                            const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
                            panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
                        }
                    })
                    .ok();
                }

                fake_window::spawn_fake_window_listener(app.clone(), window.clone());

                window
            }
        };

        // removing this for now as it causes windows to just stay hidden sometimes -_-
        // window.hide().ok();

        #[cfg(target_os = "macos")]
        if let Some(position) = _id.traffic_lights_position() {
            add_traffic_lights(&window, position);
        }

        Ok(window)
    }

    fn window_builder<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        let id = self.id(app);

        let theme = GeneralSettingsStore::get(app)
            .ok()
            .flatten()
            .map(|s| match s.theme {
                AppTheme::System => None,
                AppTheme::Light => Some(tauri::Theme::Light),
                AppTheme::Dark => Some(tauri::Theme::Dark),
            })
            .unwrap_or(None);

        let mut builder = WebviewWindow::builder(app, id.label(), WebviewUrl::App(url.into()))
            .title(id.title())
            .visible(false)
            .accept_first_mouse(true)
            .shadow(true)
            .theme(theme);

        if let Some(min) = id.min_size() {
            builder = builder
                .inner_size(min.0, min.1)
                .min_inner_size(min.0, min.1);
        }

        #[cfg(target_os = "macos")]
        {
            if id.traffic_lights_position().is_some() {
                builder = builder
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay);
            } else {
                builder = builder.decorations(false)
            }
        }

        #[cfg(windows)]
        {
            builder = builder.decorations(false);
        }

        builder
    }

    pub fn id(&self, app: &AppHandle) -> CapWindowId {
        match self {
            ShowCapWindow::Setup => CapWindowId::Setup,
            ShowCapWindow::Main { .. } => CapWindowId::Main,
            ShowCapWindow::Settings { .. } => CapWindowId::Settings,
            ShowCapWindow::Editor { project_path } => {
                let state = app.state::<EditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(path, _)| path == project_path).unwrap().1;
                CapWindowId::Editor { id }
            }
            ShowCapWindow::RecordingsOverlay => CapWindowId::RecordingsOverlay,
            ShowCapWindow::TargetSelectOverlay { display_id } => CapWindowId::TargetSelectOverlay {
                display_id: display_id.clone(),
            },
            ShowCapWindow::WindowCaptureOccluder { screen_id } => {
                CapWindowId::WindowCaptureOccluder {
                    screen_id: screen_id.clone(),
                }
            }
            ShowCapWindow::CaptureArea { .. } => CapWindowId::CaptureArea,
            ShowCapWindow::Camera => CapWindowId::Camera,
            ShowCapWindow::InProgressRecording { .. } => CapWindowId::RecordingControls,
            ShowCapWindow::Upgrade => CapWindowId::Upgrade,
            ShowCapWindow::ModeSelect => CapWindowId::ModeSelect,
            ShowCapWindow::ScreenshotEditor { path } => {
                let state = app.state::<ScreenshotEditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(p, _)| p == path).unwrap().1;
                CapWindowId::ScreenshotEditor { id }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn add_traffic_lights(window: &WebviewWindow<Wry>, controls_inset: Option<LogicalPosition<f64>>) {
    use crate::platform::delegates;

    let target_window = window.clone();
    window
        .run_on_main_thread(move || {
            delegates::setup(
                target_window.as_ref().window(),
                controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
            );

            let c_win = target_window.clone();
            target_window.on_window_event(move |event| match event {
                tauri::WindowEvent::ThemeChanged(..) | tauri::WindowEvent::Focused(..) => {
                    position_traffic_lights_impl(&c_win.as_ref().window(), controls_inset);
                }
                _ => {}
            });
        })
        .ok();
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(window))]
pub fn set_theme(window: tauri::Window, theme: AppTheme) {
    let _ = window.set_theme(match theme {
        AppTheme::System => None,
        AppTheme::Light => Some(tauri::Theme::Light),
        AppTheme::Dark => Some(tauri::Theme::Dark),
    });

    #[cfg(target_os = "macos")]
    match CapWindowId::from_str(window.label()) {
        Ok(win) if win.traffic_lights_position().is_some() => position_traffic_lights(window, None),
        Ok(_) | Err(_) => {}
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(_window))]
pub fn position_traffic_lights(_window: tauri::Window, _controls_inset: Option<(f64, f64)>) {
    #[cfg(target_os = "macos")]
    position_traffic_lights_impl(
        &_window,
        _controls_inset.map(LogicalPosition::from).or_else(|| {
            // Attempt to get the default inset from the window's traffic lights position
            CapWindowId::from_str(_window.label())
                .ok()
                .and_then(|id| id.traffic_lights_position().flatten())
        }),
    );
}

#[cfg(target_os = "macos")]
fn position_traffic_lights_impl(
    window: &tauri::Window,
    controls_inset: Option<LogicalPosition<f64>>,
) {
    use crate::platform::delegates::{UnsafeWindowHandle, position_window_controls};
    let c_win = window.clone();
    window
        .run_on_main_thread(move || {
            let ns_window = match c_win.ns_window() {
                Ok(handle) => handle,
                Err(_) => return,
            };
            position_window_controls(
                UnsafeWindowHandle(ns_window),
                &controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
            );
        })
        .ok();
}

fn should_protect_window(app: &AppHandle<Wry>, window_title: &str) -> bool {
    let matches = |list: &[WindowExclusion]| {
        list.iter()
            .any(|entry| entry.matches(None, None, Some(window_title)))
    };

    GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|settings| matches(&settings.excluded_windows))
        .unwrap_or_else(|| matches(&general_settings::default_excluded_windows()))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
pub fn refresh_window_content_protection(app: AppHandle<Wry>) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if let Ok(id) = CapWindowId::from_str(&label) {
            let title = id.title();
            window
                .set_content_protected(should_protect_window(&app, &title))
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

// Credits: tauri-plugin-window-state
trait MonitorExt {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        scale: f64,
    ) -> bool;
}

impl MonitorExt for Display {
    fn intersects(
        &self,
        position: PhysicalPosition<i32>,
        size: PhysicalSize<u32>,
        _scale: f64,
    ) -> bool {
        #[cfg(target_os = "macos")]
        {
            let Some(bounds) = self.raw_handle().logical_bounds() else {
                return false;
            };

            let left = (bounds.position().x() * _scale) as i32;
            let right = left + (bounds.size().width() * _scale) as i32;
            let top = (bounds.position().y() * _scale) as i32;
            let bottom = top + (bounds.size().height() * _scale) as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }

        #[cfg(windows)]
        {
            let Some(bounds) = self.raw_handle().physical_bounds() else {
                return false;
            };

            let left = bounds.position().x() as i32;
            let right = left + bounds.size().width() as i32;
            let top = bounds.position().y() as i32;
            let bottom = top + bounds.size().height() as i32;

            [
                (position.x, position.y),
                (position.x + size.width as i32, position.y),
                (position.x, position.y + size.height as i32),
                (
                    position.x + size.width as i32,
                    position.y + size.height as i32,
                ),
            ]
            .into_iter()
            .any(|(x, y)| x >= left && x < right && y >= top && y < bottom)
        }
    }
}

#[specta::specta]
#[tauri::command(async)]
#[instrument(skip(_window))]
pub fn set_window_transparent(_window: tauri::Window, _value: bool) {
    #[cfg(target_os = "macos")]
    {
        let ns_win = _window
            .ns_window()
            .expect("Failed to get native window handle")
            as *const objc2_app_kit::NSWindow;

        unsafe {
            (*ns_win).setOpaque(!_value);
        }
    }
}

#[derive(Default, Clone)]
pub struct EditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    pub counter: Arc<AtomicU32>,
}

impl EditorWindowIds {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<EditorWindowIds>().deref().clone()
    }
}

#[derive(Default, Clone)]
pub struct ScreenshotEditorWindowIds {
    pub ids: Arc<Mutex<Vec<(PathBuf, u32)>>>,
    pub counter: Arc<AtomicU32>,
}

impl ScreenshotEditorWindowIds {
    pub fn get(app: &AppHandle) -> Self {
        app.state::<ScreenshotEditorWindowIds>().deref().clone()
    }
}
