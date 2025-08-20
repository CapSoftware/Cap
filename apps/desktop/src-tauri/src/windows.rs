#![allow(unused_mut)]
#![allow(unused_imports)]

use crate::{
    App, ArcLock, fake_window,
    general_settings::{AppTheme, GeneralSettingsStore},
    permissions,
    target_select_overlay::WindowFocusManager,
};
use cap_displays::DisplayId;
use cap_media::{platform::logical_monitor_bounds, sources::CaptureScreen};
use futures::pin_mut;
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
use tokio::sync::RwLock;
use tracing::debug;

#[cfg(target_os = "macos")]
const DEFAULT_TRAFFIC_LIGHTS_INSET: LogicalPosition<f64> = LogicalPosition::new(12.0, 12.0);

#[derive(Clone, Deserialize, Type)]
pub enum CapWindowId {
    // Contains onboarding + permissions
    Setup,
    Main,
    Settings,
    Editor { id: u32 },
    RecordingsOverlay,
    WindowCaptureOccluder { screen_id: u32 },
    TargetSelectOverlay { display_id: DisplayId },
    CaptureArea,
    Camera,
    InProgressRecording,
    Upgrade,
    ModeSelect,
    Debug,
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
            "in-progress-recording" => Self::InProgressRecording,
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
            s if s.starts_with("window-capture-occluder-") => Self::WindowCaptureOccluder {
                screen_id: s
                    .replace("window-capture-occluder-", "")
                    .parse::<u32>()
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
            Self::InProgressRecording => write!(f, "in-progress-recording"),
            Self::RecordingsOverlay => write!(f, "recordings-overlay"),
            Self::Upgrade => write!(f, "upgrade"),
            Self::ModeSelect => write!(f, "mode-select"),
            Self::Editor { id } => write!(f, "editor-{id}"),
            Self::Debug => write!(f, "debug"),
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
            Self::InProgressRecording => "Cap In Progress Recording".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
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
            Self::Editor { .. } => Some(Some(LogicalPosition::new(20.0, 32.0))),
            Self::InProgressRecording => Some(Some(LogicalPosition::new(-100.0, -100.0))),
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
            Self::Main => (300.0, 360.0),
            Self::Editor { .. } => (1275.0, 800.0),
            Self::Settings => (600.0, 450.0),
            Self::Camera => (460.0, 920.0),
            Self::Upgrade => (950.0, 850.0),
            Self::ModeSelect => (900.0, 500.0),
            _ => return None,
        })
    }
}

#[derive(Clone, Type, Deserialize)]
pub enum ShowCapWindow {
    Setup,
    Main,
    Settings { page: Option<String> },
    Editor { project_path: PathBuf },
    RecordingsOverlay,
    WindowCaptureOccluder { screen_id: u32 },
    TargetSelectOverlay { display_id: DisplayId },
    CaptureArea { screen_id: u32 },
    Camera,
    InProgressRecording { countdown: Option<u32> },
    Upgrade,
    ModeSelect,
}

impl ShowCapWindow {
    pub async fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        if let Self::Editor { project_path } = &self {
            let state = app.state::<EditorWindowIds>();
            let mut s = state.ids.lock().unwrap();
            if !s.iter().any(|(path, _)| path == project_path) {
                s.push((
                    project_path.clone(),
                    state
                        .counter
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                ));
            }
        }

        if let Some(window) = self.id(app).get(app) {
            window.set_focus().ok();
            return Ok(window);
        }

        let _id = self.id(app);
        let monitor = app.primary_monitor()?.unwrap();

        let window = match self {
            Self::Setup => self
                .window_builder(app, "/setup")
                .resizable(false)
                .maximized(false)
                .center()
                .focused(true)
                .maximizable(false)
                .shadow(true)
                .build()?,
            Self::Main => {
                if permissions::do_permissions_check(false).necessary_granted() {
                    let new_recording_flow = GeneralSettingsStore::get(app)
                        .ok()
                        .flatten()
                        .map(|s| s.enable_new_recording_flow)
                        .unwrap_or_default();

                    let window = self
                        .window_builder(app, if new_recording_flow { "/new-main" } else { "/" })
                        .resizable(false)
                        .maximized(false)
                        .maximizable(false)
                        .always_on_top(true)
                        .visible_on_all_workspaces(true)
                        .center()
                        .build()?;

                    if new_recording_flow {
                        #[cfg(target_os = "macos")]
                        crate::platform::set_window_level(window.as_ref().window(), 50);
                    }

                    window
                } else {
                    Box::pin(Self::Setup.show(app)).await?
                }
            }
            Self::TargetSelectOverlay { display_id } => {
                let Some(display) = cap_displays::Display::from_id(display_id.clone()) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                let size = display.raw_handle().logical_size();
                let position = display.raw_handle().logical_position();

                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/target-select-overlay?displayId={display_id}"),
                    )
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(cfg!(target_os = "macos"))
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .inner_size(size.width(), size.height())
                    .position(position.x(), position.y())
                    .transparent(true);

                let window = window_builder.build()?;

                app.state::<WindowFocusManager>()
                    .spawn(display_id, window.clone());

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 45);
                }

                window
            }
            Self::Settings { page } => {
                // Hide main window when settings window opens
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                self.window_builder(
                    app,
                    format!("/settings/{}", page.clone().unwrap_or_default()),
                )
                .resizable(true)
                .maximized(false)
                .center()
                .build()?
            }
            Self::Editor { .. } => {
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.close();
                };

                self.window_builder(app, "/editor")
                    .maximizable(true)
                    .inner_size(1240.0, 800.0)
                    .center()
                    .build()?
            }
            Self::Upgrade => {
                // Hide main window when upgrade window opens
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let mut builder = self
                    .window_builder(app, "/upgrade")
                    .resizable(false)
                    .focused(true)
                    .always_on_top(true)
                    .maximized(false)
                    .shadow(true)
                    .center();

                builder.build()?
            }
            Self::ModeSelect => {
                // Hide main window when mode select window opens
                if let Some(main) = CapWindowId::Main.get(app) {
                    let _ = main.hide();
                }

                let mut builder = self
                    .window_builder(app, "/mode-select")
                    .inner_size(900.0, 500.0)
                    .min_inner_size(900.0, 500.0)
                    .resizable(true)
                    .maximized(false)
                    .maximizable(false)
                    .center()
                    .focused(true)
                    .shadow(true);

                builder.build()?
            }
            Self::Camera => {
                const WINDOW_SIZE: f64 = 230.0 * 2.0;

                let port = app.state::<Arc<RwLock<App>>>().read().await.camera_ws_port;
                let mut window_builder = self
                    .window_builder(app, "/camera")
                    .maximized(false)
                    .resizable(false)
                    .shadow(false)
                    .fullscreen(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .position(
                        100.0,
                        (monitor.size().height as f64) / monitor.scale_factor()
                            - WINDOW_SIZE
                            - 100.0,
                    )
                    .initialization_script(format!(
                        "
			                window.__CAP__ = window.__CAP__ ?? {{}};
			                window.__CAP__.cameraWsPort = {port};
		                ",
                    ))
                    .transparent(true)
                    .visible(false); // We set this true in `CameraWindowState::init_window`

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                {
                    _ = window.run_on_main_thread({
                        let window = window.as_ref().window();
                        move || unsafe {
                            let win = window.ns_window().unwrap() as *const objc2_app_kit::NSWindow;
                            (*win).setCollectionBehavior(
                            		(*win).collectionBehavior() | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary,
                            );
                        }
                    });
                }

                window
            }
            Self::WindowCaptureOccluder { screen_id } => {
                let Some(bounds) = logical_monitor_bounds(*screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                let mut window_builder = self
                    .window_builder(app, "/window-capture-occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .skip_taskbar(true)
                    .inner_size(bounds.size.width, bounds.size.height)
                    .position(bounds.position.x, bounds.position.y)
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
                let mut window_builder = self
                    .window_builder(app, "/capture-area")
                    .maximized(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .content_protected(true)
                    .skip_taskbar(true)
                    .closable(true)
                    .decorations(false)
                    .transparent(true);

                let screen_bounds = cap_media::platform::monitor_bounds(*screen_id);
                let target_monitor = app
                    .monitor_from_point(screen_bounds.x, screen_bounds.y)
                    .ok()
                    .flatten()
                    .unwrap_or(monitor);

                let size = target_monitor.size();
                let scale_factor = target_monitor.scale_factor();
                let pos = target_monitor.position();
                window_builder = window_builder
                    .inner_size(
                        (size.width as f64) / scale_factor,
                        (size.height as f64) / scale_factor,
                    )
                    .position(pos.x as f64, pos.y as f64);

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                crate::platform::set_window_level(
                    window.as_ref().window(),
                    objc2_app_kit::NSScreenSaverWindowLevel,
                );

                // Hide the main window if the target monitor is the same
                if let Some(main_window) = CapWindowId::Main.get(app)
                    && let (Ok(outer_pos), Ok(outer_size)) =
                        (main_window.outer_position(), main_window.outer_size())
                    && target_monitor.intersects(outer_pos, outer_size)
                {
                    let _ = main_window.minimize();
                };

                window
            }
            Self::InProgressRecording { countdown } => {
                let mut width = 180.0 + 32.0;

                let height = 40.0;

                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(true)
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .inner_size(width, height)
                    .position(
                        ((monitor.size().width as f64) / monitor.scale_factor() - width) / 2.0,
                        (monitor.size().height as f64) / monitor.scale_factor() - height - 120.0,
                    )
                    .skip_taskbar(true)
                    .initialization_script(format!(
                        "window.COUNTDOWN = {};",
                        countdown.unwrap_or_default()
                    ))
                    .build()?;

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(window.as_ref().window(), 1000);
                }

                window
            }
            Self::RecordingsOverlay => {
                let window = self
                    .window_builder(app, "/recordings-overlay")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .accept_first_mouse(true)
                    .content_protected(true)
                    .inner_size(
                        (monitor.size().width as f64) / monitor.scale_factor(),
                        (monitor.size().height as f64) / monitor.scale_factor(),
                    )
                    .skip_taskbar(true)
                    .position(0.0, 0.0)
                    .transparent(true)
                    .build()?;

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

        let mut builder = WebviewWindow::builder(app, id.label(), WebviewUrl::App(url.into()))
            .title(id.title())
            .visible(false)
            .accept_first_mouse(true)
            .shadow(true);

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
            ShowCapWindow::Main => CapWindowId::Main,
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
                    screen_id: *screen_id,
                }
            }
            ShowCapWindow::CaptureArea { .. } => CapWindowId::CaptureArea,
            ShowCapWindow::Camera => CapWindowId::Camera,
            ShowCapWindow::InProgressRecording { .. } => CapWindowId::InProgressRecording,
            ShowCapWindow::Upgrade => CapWindowId::Upgrade,
            ShowCapWindow::ModeSelect => CapWindowId::ModeSelect,
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

// Credits: tauri-plugin-window-state
trait MonitorExt {
    fn intersects(&self, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool;
}

impl MonitorExt for Monitor {
    fn intersects(&self, position: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> bool {
        let PhysicalPosition { x, y } = *self.position();
        let PhysicalSize { width, height } = *self.size();

        let left = x;
        let right = x + width as i32;
        let top = y;
        let bottom = y + height as i32;

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

#[specta::specta]
#[tauri::command(async)]
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
