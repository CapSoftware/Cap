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
    time::Duration,
};
use tauri::{
    AppHandle, LogicalPosition, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Wry,
};
use tauri_specta::Event;
use tokio::sync::RwLock;
use tracing::{debug, error, instrument, warn};

#[cfg(target_os = "macos")]
use crate::panel_manager::{PanelManager, PanelState, PanelWindowType};

use crate::{
    App, ArcLock, CameraWindowCloseGate, CameraWindowPositionGuard, RequestScreenCapturePrewarm,
    RequestSetTargetMode,
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

#[cfg(target_os = "macos")]
fn is_system_dark_mode() -> bool {
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let app: id = msg_send![class!(NSApplication), sharedApplication];
        let appearance: id = msg_send![app, effectiveAppearance];
        if appearance == nil {
            return false;
        }
        let name: id = msg_send![appearance, name];
        if name == nil {
            return false;
        }
        let dark_appearance = NSString::alloc(nil).init_str("NSAppearanceNameDarkAqua");
        let vibrant_dark = NSString::alloc(nil).init_str("NSAppearanceNameVibrantDark");
        let is_dark: bool = msg_send![name, isEqualToString: dark_appearance];
        let is_vibrant_dark: bool = msg_send![name, isEqualToString: vibrant_dark];
        is_dark || is_vibrant_dark
    }
}

#[cfg(target_os = "windows")]
fn is_system_dark_mode() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    if let Ok(key) =
        hkcu.open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
        && let Ok(value) = key.get_value::<u32, _>("AppsUseLightTheme")
    {
        return value == 0;
    }
    false
}

#[cfg(target_os = "linux")]
fn is_system_dark_mode() -> bool {
    if let Ok(output) = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "gtk-theme"])
        .output()
    {
        let theme = String::from_utf8_lossy(&output.stdout);
        return theme.to_lowercase().contains("dark");
    }
    false
}

fn hide_recording_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if let Ok(id) = CapWindowId::from_str(&label)
            && matches!(
                id,
                CapWindowId::TargetSelectOverlay { .. } | CapWindowId::Main | CapWindowId::Camera
            )
        {
            let _ = window.hide();
        }
    }
}

async fn cleanup_camera_window(
    app: &AppHandle,
    window: Option<&WebviewWindow>,
    #[allow(unused_variables)] reset_panel: bool,
    wait_for_removal: bool,
) -> bool {
    use crate::CameraWindowCloseGate;

    #[cfg(target_os = "macos")]
    if reset_panel {
        let panel_manager = app.state::<PanelManager>();
        panel_manager.force_reset(PanelWindowType::Camera).await;
    }

    app.state::<CameraWindowCloseGate>().set_allow_close(true);

    #[cfg(target_os = "macos")]
    {
        let (panel_close_tx, panel_close_rx) = tokio::sync::oneshot::channel();
        let app_for_close = app.clone();
        app.run_on_main_thread(move || {
            use tauri_nspanel::ManagerExt;
            let label = CapWindowId::Camera.label();
            if let Ok(panel) = app_for_close.get_webview_panel(&label) {
                panel.released_when_closed(false);
                panel.close();
            }
            let _ = panel_close_tx.send(());
        })
        .ok();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), panel_close_rx).await;
    }

    if let Some(window) = window {
        let (destroy_tx, destroy_rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread({
            let window = window.clone();
            move || {
                let _ = window.destroy();
                let _ = destroy_tx.send(());
            }
        })
        .ok();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), destroy_rx).await;
    } else if let Some(stale) = CapWindowId::Camera.get(app) {
        let (destroy_tx, destroy_rx) = tokio::sync::oneshot::channel();
        app.run_on_main_thread({
            let stale = stale.clone();
            move || {
                let _ = stale.destroy();
                let _ = destroy_tx.send(());
            }
        })
        .ok();
        let _ = tokio::time::timeout(std::time::Duration::from_millis(500), destroy_rx).await;
    }

    if wait_for_removal {
        let start = std::time::Instant::now();
        let timeout = std::time::Duration::from_millis(2000);
        while start.elapsed() < timeout && CapWindowId::Camera.get(app).is_some() {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    let still_exists = CapWindowId::Camera.get(app).is_some();
    app.state::<CameraWindowCloseGate>().set_allow_close(false);

    !still_exists
}

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

fn center_camera_window(app: &AppHandle, window: &WebviewWindow) {
    let state = app.state::<ArcLock<crate::App>>();
    let camera_state = if let Ok(guard) = state.try_read() {
        guard.camera_preview.get_state().ok().unwrap_or_default()
    } else {
        crate::camera::CameraPreviewState::default()
    };

    let toolbar_height = 56.0;
    let size = camera_state.size as f64;
    let is_full = camera_state.shape == crate::camera::CameraPreviewShape::Full;
    let aspect_ratio = 16.0 / 9.0;

    let window_width = if is_full { size * aspect_ratio } else { size };
    let window_height = size + toolbar_height;

    let monitor_info = CursorMonitorInfo::get();
    let (pos_x, pos_y) = monitor_info.center_position(window_width, window_height);

    let _ = window.set_size(tauri::LogicalSize::new(window_width, window_height));
    app.state::<CameraWindowPositionGuard>().ignore_for(1000);
    let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));
}

fn is_position_on_display(display_id: &DisplayId, pos_x: f64, pos_y: f64) -> bool {
    Display::from_id(display_id)
        .and_then(|display| display.raw_handle().logical_bounds())
        .map(|bounds| {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
        })
        .unwrap_or(false)
}

fn display_name_for_position(pos_x: f64, pos_y: f64) -> Option<String> {
    Display::list().into_iter().find_map(|display| {
        let bounds = display.raw_handle().logical_bounds()?;
        let (x, y, width, height) = (
            bounds.position().x(),
            bounds.position().y(),
            bounds.size().width(),
            bounds.size().height(),
        );

        if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
            display.name().filter(|name| !name.trim().is_empty())
        } else {
            None
        }
    })
}

fn is_position_on_monitor_name(monitor_name: &str, pos_x: f64, pos_y: f64) -> bool {
    Display::list().into_iter().any(|display| {
        if display.name().as_deref() != Some(monitor_name) {
            return false;
        }

        display
            .raw_handle()
            .logical_bounds()
            .map(|bounds| {
                let (x, y, width, height) = (
                    bounds.position().x(),
                    bounds.position().y(),
                    bounds.size().width(),
                    bounds.size().height(),
                );

                pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height
            })
            .unwrap_or(false)
    })
}

fn is_position_on_any_screen(pos_x: f64, pos_y: f64) -> bool {
    for display in Display::list() {
        if let Some(bounds) = display.raw_handle().logical_bounds() {
            let (x, y, width, height) = (
                bounds.position().x(),
                bounds.position().y(),
                bounds.size().width(),
                bounds.size().height(),
            );

            if pos_x >= x && pos_x < x + width && pos_y >= y && pos_y < y + height {
                return true;
            }
        }
    }
    false
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
            Self::TargetSelectOverlay { .. } => "Cap Target Select".to_string(),
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

    pub fn is_transparent(&self) -> bool {
        matches!(
            self,
            Self::Main
                | Self::Camera
                | Self::WindowCaptureOccluder { .. }
                | Self::CaptureArea
                | Self::RecordingControls
                | Self::RecordingsOverlay
                | Self::TargetSelectOverlay { .. }
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
            Self::Camera
            | Self::Main
            | Self::WindowCaptureOccluder { .. }
            | Self::CaptureArea
            | Self::RecordingsOverlay
            | Self::RecordingControls
            | Self::TargetSelectOverlay { .. } => None,
            _ => Some(None),
        }
    }

    pub fn min_size(&self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Setup => (600.0, 600.0),
            Self::Main => (330.0, 395.0),
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

        if let Self::Camera { centered } = self {
            #[cfg(target_os = "macos")]
            {
                let panel_manager = app.state::<PanelManager>();
                let mut panel_state = panel_manager.get_state(PanelWindowType::Camera).await;

                if panel_state == PanelState::Destroying {
                    debug!("Camera window is being destroyed, waiting...");
                    let wait_result = panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::None],
                            std::time::Duration::from_millis(500),
                        )
                        .await;

                    if !wait_result {
                        warn!("Camera destroy wait timed out, force resetting state");
                        panel_manager.force_reset(PanelWindowType::Camera).await;
                    }
                    panel_state = panel_manager.get_state(PanelWindowType::Camera).await;
                }

                if panel_state == PanelState::Creating {
                    debug!("Camera window is being created, waiting...");
                    panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::Ready],
                            std::time::Duration::from_millis(500),
                        )
                        .await;
                }
            }

            if let Some(window) = self.id(app).get(app) {
                #[cfg(target_os = "macos")]
                {
                    use crate::panel_manager::is_window_handle_valid;

                    let handle_valid = is_window_handle_valid(&window);

                    if !handle_valid {
                        warn!(
                            "Camera window exists but handle is invalid, destroying and recreating..."
                        );
                        let cleanup_success =
                            cleanup_camera_window(app, Some(&window), true, true).await;
                        if !cleanup_success {
                            warn!(
                                "Camera window still in registry after cleanup attempts, will retry later"
                            );
                            return Err(tauri::Error::WindowNotFound);
                        }
                        debug!("Camera window successfully removed from registry");
                    } else {
                        let panel_manager = app.state::<PanelManager>();
                        let mut panel_state =
                            panel_manager.get_state(PanelWindowType::Camera).await;

                        if panel_state == PanelState::Creating {
                            debug!(
                                "Camera window valid but state is Creating, waiting for completion"
                            );
                            panel_manager
                                .wait_for_state(
                                    PanelWindowType::Camera,
                                    &[PanelState::Ready, PanelState::None],
                                    std::time::Duration::from_millis(1000),
                                )
                                .await;
                            panel_state = panel_manager.get_state(PanelWindowType::Camera).await;
                        }

                        if panel_state != PanelState::Ready {
                            debug!(
                                "Camera window exists but panel state is {:?}, updating to Ready",
                                panel_state
                            );
                            panel_manager.force_reset(PanelWindowType::Camera).await;
                            panel_manager.mark_ready(PanelWindowType::Camera, 0).await;
                        }

                        let state = app.state::<ArcLock<App>>();
                        let mut app_state = state.write().await;

                        let enable_native_camera_preview = GeneralSettingsStore::get(app)
                            .ok()
                            .and_then(|v| v.map(|v| v.enable_native_camera_preview))
                            .unwrap_or_default();

                        let shutdown_preview = if !enable_native_camera_preview {
                            app_state.camera_preview.begin_shutdown()
                        } else {
                            None
                        };

                        if enable_native_camera_preview {
                            let camera_feed = app_state.camera_feed.clone();
                            if let Err(err) = app_state
                                .camera_preview
                                .init_window(window.clone(), camera_feed)
                                .await
                            {
                                error!(
                                    "Error reinitializing camera preview for existing window: {err}"
                                );
                            }
                        }

                        drop(app_state);

                        if let Some(rx) = shutdown_preview {
                            let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
                        }

                        let (show_tx, show_rx) = tokio::sync::oneshot::channel();
                        app.run_on_main_thread({
                            let window = window.clone();
                            move || {
                                use crate::panel_manager::try_to_panel;

                                // IMPORTANT: We intentionally use window.show() + set_focus() here
                                // instead of panel.order_front_regardless().
                                //
                                // order_front_regardless() was found to cause a crash after ~4-5
                                // camera toggle cycles due to macOS internal state accumulation.
                                // The crash manifested as a hard crash in the Metal/CAMetalLayer
                                // subsystem, not in our Rust code.
                                //
                                // Using standard Tauri window APIs avoids this macOS-specific issue
                                // while still properly showing and focusing the camera preview window.
                                let _ = window.show();
                                let _ = window.set_focus();
                                let _ = show_tx.send(true);
                            }
                        })
                        .ok();

                        let show_result = show_rx.await.unwrap_or(false);

                        if show_result {
                            if *centered {
                                center_camera_window(app, &window);
                            }
                            return Ok(window);
                        } else {
                            warn!("Camera panel show failed, will recreate window");
                            let cleanup_success =
                                cleanup_camera_window(app, Some(&window), true, true).await;
                            if !cleanup_success {
                                warn!(
                                    "Camera window still in registry after show failure, will retry later"
                                );
                                return Err(tauri::Error::WindowNotFound);
                            }
                            debug!("Camera window successfully removed after show failure");
                        }
                    }
                }

                #[cfg(not(target_os = "macos"))]
                {
                    let state = app.state::<ArcLock<App>>();
                    let mut app_state = state.write().await;

                    let enable_native_camera_preview = GeneralSettingsStore::get(app)
                        .ok()
                        .and_then(|v| v.map(|v| v.enable_native_camera_preview))
                        .unwrap_or_default();

                    let shutdown_preview = if !enable_native_camera_preview {
                        app_state.camera_preview.begin_shutdown()
                    } else {
                        None
                    };

                    if enable_native_camera_preview && !app_state.camera_preview.is_initialized() {
                        let camera_feed = app_state.camera_feed.clone();
                        if let Err(err) = app_state
                            .camera_preview
                            .init_window(window.clone(), camera_feed)
                            .await
                        {
                            error!(
                                "Error reinitializing camera preview for existing window: {err}"
                            );
                        }
                    }

                    drop(app_state);

                    if let Some(rx) = shutdown_preview {
                        let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
                    }

                    if *centered {
                        center_camera_window(app, &window);
                    }
                    window.show().ok();
                    window.set_focus().ok();
                    return Ok(window);
                }
            }
        }

        #[cfg(target_os = "macos")]
        if let Self::InProgressRecording { .. } = self
            && let Some(window) = self.id(app).get(app)
        {
            use crate::panel_manager::is_window_handle_valid;

            if is_window_handle_valid(&window) {
                debug!("InProgressRecording: reusing existing window");
                let width = 320.0;
                let height = 150.0;
                let recording_monitor = CursorMonitorInfo::get();
                let (pos_x, pos_y) = recording_monitor.bottom_center_position(width, height, 120.0);
                let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                let label = window.label().to_string();
                app.run_on_main_thread({
                    let app = app.clone();
                    move || {
                        use tauri_nspanel::ManagerExt;
                        if let Ok(panel) = app.get_webview_panel(&label) {
                            panel.order_front_regardless();
                            panel.show();
                        }
                    }
                })
                .ok();
                return Ok(window);
            } else {
                warn!("InProgressRecording window handle invalid, destroying and recreating...");
                let _ = window.destroy();

                let window_id = self.id(app);
                let max_wait = std::time::Duration::from_millis(500);
                let poll_interval = std::time::Duration::from_millis(25);
                let start = std::time::Instant::now();
                while start.elapsed() < max_wait {
                    if window_id.get(app).is_none() {
                        debug!(
                            "InProgressRecording window removed from registry after {:?}",
                            start.elapsed()
                        );
                        break;
                    }
                    tokio::time::sleep(poll_interval).await;
                }

                if window_id.get(app).is_some() {
                    error!("InProgressRecording window STILL in registry, cannot recreate");
                    return Err(tauri::Error::WindowNotFound);
                }
                debug!("InProgressRecording window cleaned up, will recreate");
            }
        }

        #[cfg(not(target_os = "macos"))]
        if let Self::InProgressRecording { .. } = self
            && let Some(window) = self.id(app).get(app)
        {
            let width = 320.0;
            let height = 150.0;
            let recording_monitor = CursorMonitorInfo::get();
            let (pos_x, pos_y) = recording_monitor.bottom_center_position(width, height, 120.0);
            let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));
            window.show().ok();
            window.set_focus().ok();
            return Ok(window);
        }

        if !matches!(self, Self::Camera { .. } | Self::InProgressRecording { .. })
            && let Some(window) = self.id(app).get(app)
        {
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

            if let Self::Main {
                init_target_mode: Some(target_mode),
            } = self
            {
                window.hide().ok();
                let _ = RequestSetTargetMode {
                    target_mode: Some(*target_mode),
                    display_id: cursor_display_id,
                }
                .emit(app);
            } else {
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

                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                    .ok();

                let window = self
                    .window_builder(app, "/")
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .minimizable(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(should_protect)
                    .transparent(true)
                    .visible(false)
                    .initialization_script(format!(
                        "
                        window.__CAP__ = window.__CAP__ ?? {{}};
                        window.__CAP__.initialTargetMode = {}
                    ",
                        serde_json::to_string(init_target_mode)
                            .expect("Failed to serialize initial target mode")
                    ))
                    .build()?;

                let saved_position = GeneralSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .and_then(|s| s.main_window_position)
                    .filter(|pos| is_position_on_any_screen(pos.x, pos.y));

                let (pos_x, pos_y) = if let Some(pos) = saved_position {
                    (pos.x, pos.y)
                } else {
                    cursor_monitor.center_position(330.0, 395.0)
                };

                #[cfg(target_os = "macos")]
                {
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        move || {
                            use tauri::ActivationPolicy;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use crate::panel_manager::try_to_panel;

                            const MAIN_PANEL_LEVEL: i32 = 100;

                            let delegate = panel_delegate!(MainPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match try_to_panel(&window) {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert main window to panel: {}", e);
                                    app.set_activation_policy(ActivationPolicy::Regular).ok();
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            panel.set_level(MAIN_PANEL_LEVEL);

                            let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));

                            panel.order_front_regardless();
                            panel.show();

                            crate::platform::apply_squircle_corners(&window, 16.0);

                            app.set_activation_policy(ActivationPolicy::Regular).ok();
                        }
                    })
                    .ok();

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

                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_position(tauri::LogicalPosition::new(pos_x, pos_y));
                    window.show().ok();
                }

                window
            }
            Self::TargetSelectOverlay {
                display_id,
                target_mode,
            } => {
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

                let target_mode_param = match target_mode {
                    Some(RecordingTargetMode::Display) => "&targetMode=display",
                    Some(RecordingTargetMode::Window) => "&targetMode=window",
                    Some(RecordingTargetMode::Area) => "&targetMode=area",
                    Some(RecordingTargetMode::Camera) => "&targetMode=camera",
                    None => "",
                };

                let camera_ws_port = {
                    let state = app.state::<ArcLock<App>>();
                    let state = state.read().await;
                    state.camera_ws_port
                };

                #[cfg(target_os = "macos")]
                app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                    .ok();

                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/target-select-overlay?displayId={display_id}&isHoveredDisplay={is_hovered_display}{target_mode_param}"),
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
                    .visible(false)
                    .initialization_script(format!(
                        "window.__CAP__ = window.__CAP__ ?? {{}}; window.__CAP__.cameraWsPort = {};",
                        camera_ws_port
                    ));

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
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        move || {
                            use tauri::ActivationPolicy;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

                            #[link(name = "CoreGraphics", kind = "framework")]
                            unsafe extern "C" {
                                fn CGWindowLevelForKey(key: i32) -> i32;
                            }

                            #[allow(non_upper_case_globals)]
                            const kCGMaximumWindowLevelKey: i32 = 10;

                            let delegate = panel_delegate!(TargetSelectOverlayPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match window.to_panel() {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert target select overlay to panel: {:?}", e);
                                    app.set_activation_policy(ActivationPolicy::Regular).ok();
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            let max_level = unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                            panel.set_level(max_level - 1);

                            panel.order_front_regardless();
                            panel.show();

                            app.set_activation_policy(ActivationPolicy::Regular).ok();
                        }
                    })
                    .ok();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    window.show().ok();
                }

                window
            }
            Self::Settings { page } => {
                hide_recording_windows(app);

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
                hide_recording_windows(app);

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
                hide_recording_windows(app);

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
            Self::Camera { centered } => {
                const DEFAULT_WINDOW_SIZE: f64 = 230.0 * 2.0;
                const CENTERED_WINDOW_SIZE: f64 = 400.0;

                #[cfg(target_os = "macos")]
                let create_guard = {
                    let panel_manager = app.state::<PanelManager>();
                    panel_manager
                        .try_begin_create(PanelWindowType::Camera)
                        .await
                };

                #[cfg(target_os = "macos")]
                let Some(mut create_guard) = create_guard else {
                    let panel_manager = app.state::<PanelManager>();
                    let state = panel_manager.get_state(PanelWindowType::Camera).await;
                    warn!("Camera window creation blocked, current state: {:?}", state);
                    if state == PanelState::Ready
                        && let Some(window) = CapWindowId::Camera.get(app)
                    {
                        if *centered {
                            center_camera_window(app, &window);
                        }
                        return Ok(window);
                    }
                    panel_manager
                        .wait_for_state(
                            PanelWindowType::Camera,
                            &[PanelState::Ready, PanelState::None],
                            std::time::Duration::from_millis(500),
                        )
                        .await;
                    if let Some(window) = CapWindowId::Camera.get(app) {
                        if *centered {
                            center_camera_window(app, &window);
                        }
                        return Ok(window);
                    }
                    return Err(tauri::Error::WindowNotFound);
                };

                let enable_native_camera_preview = GeneralSettingsStore::get(app)
                    .ok()
                    .and_then(|v| v.map(|v| v.enable_native_camera_preview))
                    .unwrap_or_default();

                {
                    let state = app.state::<ArcLock<App>>();
                    let mut state = state.write().await;

                    let shutdown_preview =
                        if !enable_native_camera_preview && state.camera_preview.is_initialized() {
                            state.camera_preview.begin_shutdown()
                        } else {
                            None
                        };

                    if enable_native_camera_preview && state.camera_preview.is_initialized() {
                        warn!("Detected existing camera preview, will reuse it");
                    }

                    #[cfg(target_os = "macos")]
                    app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                        .ok();

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
			                window.__CAP__.cameraOnlyMode = {};
		                ",
                            state.camera_ws_port, centered
                        ))
                        .transparent(true)
                        .visible(false);

                    let window = match window_builder.build() {
                        Ok(w) => w,
                        Err(e) => {
                            let is_label_exists = e.to_string().contains("already exists");
                            if is_label_exists {
                                warn!(
                                    "Camera webview label already exists, cleaning up for next attempt"
                                );
                                cleanup_camera_window(app, None, false, false).await;
                            }

                            #[cfg(target_os = "macos")]
                            {
                                let panel_manager = app.state::<PanelManager>();
                                panel_manager.force_reset(PanelWindowType::Camera).await;
                            }
                            return Err(e);
                        }
                    };

                    let camera_monitor = CapWindowId::Main
                        .get(app)
                        .map(|w| CursorMonitorInfo::from_window(&w))
                        .unwrap_or(cursor_monitor);

                    let preferred_monitor_name = display_name_for_position(
                        camera_monitor.x + camera_monitor.width / 2.0,
                        camera_monitor.y + camera_monitor.height / 2.0,
                    );

                    let saved_position =
                        GeneralSettingsStore::get(app)
                            .ok()
                            .flatten()
                            .and_then(|settings| {
                                if let Some(monitor_name) = preferred_monitor_name.as_deref() {
                                    settings
                                        .camera_window_positions_by_monitor_name
                                        .get(monitor_name)
                                        .cloned()
                                        .filter(|pos| {
                                            is_position_on_monitor_name(monitor_name, pos.x, pos.y)
                                        })
                                        .or_else(|| {
                                            settings.camera_window_position.filter(|pos| {
                                                is_position_on_monitor_name(
                                                    monitor_name,
                                                    pos.x,
                                                    pos.y,
                                                )
                                            })
                                        })
                                } else {
                                    settings.camera_window_position.filter(|pos| {
                                        if let Some(display_id) = &pos.display_id {
                                            is_position_on_display(display_id, pos.x, pos.y)
                                        } else {
                                            is_position_on_any_screen(pos.x, pos.y)
                                        }
                                    })
                                }
                            });

                    let (camera_pos_x, camera_pos_y) = if let Some(pos) = saved_position {
                        (pos.x, pos.y)
                    } else if *centered {
                        let aspect_ratio = 16.0 / 9.0;
                        let toolbar_height = 56.0;
                        let window_width = CENTERED_WINDOW_SIZE * aspect_ratio;
                        let window_height = CENTERED_WINDOW_SIZE + toolbar_height;
                        camera_monitor.center_position(window_width, window_height)
                    } else {
                        let camera_pos_x =
                            camera_monitor.x + camera_monitor.width - DEFAULT_WINDOW_SIZE - 100.0;
                        let camera_pos_y =
                            camera_monitor.y + camera_monitor.height - DEFAULT_WINDOW_SIZE - 100.0;
                        (camera_pos_x, camera_pos_y)
                    };

                    #[cfg(not(target_os = "macos"))]
                    {
                        app.state::<CameraWindowPositionGuard>().ignore_for(1000);
                        let _ = window
                            .set_position(tauri::LogicalPosition::new(camera_pos_x, camera_pos_y));
                    }

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

                    #[cfg(target_os = "macos")]
                    {
                        let panel_manager = app.state::<PanelManager>();
                        let operation_id = create_guard.operation_id;

                        let (panel_tx, panel_rx) = tokio::sync::oneshot::channel();
                        app.run_on_main_thread({
                            let window = window.clone();
                            let app = app.clone();
                            move || {
                                use tauri::ActivationPolicy;
                                use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                                use tauri_nspanel::panel_delegate;
                                use crate::panel_manager::try_to_panel;

                                #[link(name = "CoreGraphics", kind = "framework")]
                                unsafe extern "C" {
                                    fn CGWindowLevelForKey(key: i32) -> i32;
                                }

                                #[allow(non_upper_case_globals)]
                                const kCGMaximumWindowLevelKey: i32 = 10;

                                let delegate = panel_delegate!(CameraPanelDelegate {
                                    window_did_become_key,
                                    window_did_resign_key
                                });

                                delegate.set_listener(Box::new(|_delegate_name: String| {}));

                                let panel = match try_to_panel(&window) {
                                    Ok(p) => p,
                                    Err(e) => {
                                        tracing::error!("Failed to convert camera to panel: {}", e);
                                        app.set_activation_policy(ActivationPolicy::Regular).ok();
                                        let _ = panel_tx.send(false);
                                        return;
                                    }
                                };

                                panel.set_collection_behaviour(
                                    NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                        | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                                );

                                panel.set_delegate(delegate);

                                let max_level =
                                    unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                                panel.set_level(max_level);

                                app.state::<CameraWindowPositionGuard>().ignore_for(1000);
                                let _ = window.set_position(tauri::LogicalPosition::new(
                                    camera_pos_x,
                                    camera_pos_y,
                                ));

                                panel.order_front_regardless();
                                panel.show();

                                app.set_activation_policy(ActivationPolicy::Regular).ok();
                                let _ = panel_tx.send(true);
                            }
                        })
                        .ok();

                        if panel_rx.await.unwrap_or(false) {
                            panel_manager
                                .mark_ready(PanelWindowType::Camera, operation_id)
                                .await;
                            create_guard.mark_completed();
                        } else {
                            warn!("Camera panel creation failed");
                            panel_manager.force_reset(PanelWindowType::Camera).await;
                        }
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
                        }
                    }

                    #[cfg(not(target_os = "macos"))]
                    {
                        window.show().ok();
                    }

                    drop(state);

                    if let Some(rx) = shutdown_preview {
                        let _ = tokio::time::timeout(Duration::from_millis(500), rx).await;
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

                #[cfg(target_os = "linux")]
                let position = display.raw_handle().logical_position();

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
                app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                    .ok();

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
                        .visible(false)
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

                #[cfg(target_os = "linux")]
                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
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
                    app.run_on_main_thread({
                        let window = window.clone();
                        let app = app.clone();
                        move || {
                            use tauri::ActivationPolicy;
                            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
                            use tauri_nspanel::panel_delegate;
                            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

                            #[link(name = "CoreGraphics", kind = "framework")]
                            unsafe extern "C" {
                                fn CGWindowLevelForKey(key: i32) -> i32;
                            }

                            #[allow(non_upper_case_globals)]
                            const kCGMaximumWindowLevelKey: i32 = 10;

                            let delegate = panel_delegate!(RecordingControlsPanelDelegate {
                                window_did_become_key,
                                window_did_resign_key
                            });

                            delegate.set_listener(Box::new(|_delegate_name: String| {}));

                            let panel = match window.to_panel() {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert recording controls to panel: {:?}", e);
                                    app.set_activation_policy(ActivationPolicy::Regular).ok();
                                    return;
                                }
                            };

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenPrimary,
                            );

                            panel.set_delegate(delegate);

                            let max_level = unsafe { CGWindowLevelForKey(kCGMaximumWindowLevelKey) };
                            panel.set_level(max_level);

                            panel.order_front_regardless();
                            panel.show();

                            app.set_activation_policy(ActivationPolicy::Regular).ok();
                        }
                    })
                    .ok();

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

                #[cfg(target_os = "linux")]
                {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    window.show().ok();
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
                            use crate::panel_manager::try_to_panel;

                            let panel = match try_to_panel(&window) {
                                Ok(p) => p,
                                Err(e) => {
                                    tracing::error!("Failed to convert recordings overlay to panel: {}", e);
                                    return;
                                }
                            };

                            panel.set_level(cocoa::appkit::NSMainMenuWindowLevel);

                            panel.set_collection_behaviour(
                                NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                                    | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
                            );

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

        if !id.is_transparent() {
            let is_dark = match theme {
                Some(tauri::Theme::Dark) => true,
                Some(tauri::Theme::Light) => false,
                None | Some(_) => is_system_dark_mode(),
            };

            let bg_color = if is_dark { "#141414" } else { "#ffffff" };
            let init_script = format!(
                r#"(function(){{var s=document.createElement('style');s.textContent='html,body{{background-color:{bg}}}';document.documentElement.appendChild(s);}})();"#,
                bg = bg_color
            );
            builder = builder.initialization_script(&init_script);
        }

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
            ShowCapWindow::TargetSelectOverlay { display_id, .. } => {
                CapWindowId::TargetSelectOverlay {
                    display_id: display_id.clone(),
                }
            }
            ShowCapWindow::WindowCaptureOccluder { screen_id } => {
                CapWindowId::WindowCaptureOccluder {
                    screen_id: screen_id.clone(),
                }
            }
            ShowCapWindow::CaptureArea { .. } => CapWindowId::CaptureArea,
            ShowCapWindow::Camera { .. } => CapWindowId::Camera,
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

        #[cfg(target_os = "linux")]
        {
            let Some(bounds) = self.raw_handle().logical_bounds() else {
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
