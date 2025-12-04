#![allow(unused_mut)]
#![allow(unused_imports)]

use anyhow::anyhow;
use futures::pin_mut;
use scap_targets::{Display, DisplayId};
use serde::Deserialize;
use specta::Type;
use std::{
    f64,
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
    App, ArcLock, RequestScreenCapturePrewarm,
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
use crate::platform::{self, WebviewWindowExt};

#[derive(Clone, Deserialize, Type)]
pub enum CapWindowDef {
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

impl FromStr for CapWindowDef {
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

impl std::fmt::Display for CapWindowDef {
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

impl CapWindowDef {
    pub fn label(&self) -> String {
        self.to_string()
    }

    pub const fn title(&self) -> &str {
        match self {
            Self::Setup => "Cap Setup",
            Self::Settings => "Cap Settings",
            Self::WindowCaptureOccluder { .. } => "Cap Window Capture Occluder",
            Self::CaptureArea => "Cap Capture Area",
            Self::RecordingControls => "Cap Recording Controls",
            Self::Editor { .. } => "Cap Editor",
            Self::ScreenshotEditor { .. } => "Cap Screenshot Editor",
            Self::ModeSelect => "Cap Mode Selection",
            Self::Camera => "Cap Camera",
            Self::RecordingsOverlay => "Cap Recordings Overlay",
            _ => "Cap",
        }
    }

    pub const fn activates_dock(&self) -> bool {
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

    #[cfg(target_os = "macos")]
    pub const fn pre_solarium_traffic_lights_position(&self) -> LogicalPosition<f64> {
        match self {
            Self::Editor { .. } => LogicalPosition::new(20.0, 32.0),
            _ => LogicalPosition::new(12.0, 20.0),
        }
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.label();
        app.get_webview_window(&label)
    }

    #[cfg(target_os = "macos")]
    pub const fn undecorated(&self) -> bool {
        matches!(
            self,
            Self::Camera
                | Self::WindowCaptureOccluder { .. }
                | Self::CaptureArea
                | Self::RecordingsOverlay
                | Self::TargetSelectOverlay { .. }
        )
    }

    #[cfg(target_os = "macos")]
    pub const fn disables_window_buttons(&self) -> bool {
        matches!(self, Self::RecordingControls)
    }

    #[cfg(target_os = "macos")]
    pub const fn disables_fullscreen(&self) -> bool {
        matches!(self, Self::Settings)
    }

    #[cfg(target_os = "macos")]
    pub const fn window_level(&self) -> Option<objc2_app_kit::NSWindowLevel> {
        use objc2_app_kit::{
            NSMainMenuWindowLevel, NSPopUpMenuWindowLevel, NSScreenSaverWindowLevel,
        };

        match self {
            Self::RecordingControls => Some(NSMainMenuWindowLevel),
            Self::TargetSelectOverlay { .. } | Self::CaptureArea => Some(45),
            Self::RecordingsOverlay | Self::WindowCaptureOccluder { .. } => {
                Some(NSScreenSaverWindowLevel)
            }
            _ => None,
        }
    }
    pub const fn min_size(&self) -> Option<(f64, f64)> {
        Some(match self {
            Self::Setup => (600.0, 600.0),
            Self::Main => (300.0, 360.0),
            Self::Editor { .. } => (1275.0, 800.0),
            Self::ScreenshotEditor { .. } => (800.0, 600.0),
            Self::Settings => (600.0, 450.0),
            Self::Camera => (200.0, 200.0),
            Self::Upgrade => (950.0, 850.0),
            Self::ModeSelect => (900.0, 500.0),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Type, Deserialize)]
pub enum CapWindow {
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

impl CapWindow {
    pub async fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        use std::fmt::Write;

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

            let window_label = CapWindowDef::Editor { id: window_id }.label();
            PendingEditorInstances::start_prewarm(app, window_label, project_path.clone()).await;
        }

        let def = self.def(app);
        if let Some(window) = def.get(app) {
            window.show().ok();
            window.unminimize().ok();
            window.set_focus().ok();
            return Ok(window);
        }

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
            Self::Main { init_target_mode } => {
                if !permissions::do_permissions_check(false).necessary_granted() {
                    return Box::pin(Self::Setup.show(app)).await;
                }

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
                    .minimizable(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .center()
                    .initialization_script(format!(
                        "
                        window.__CAP__ = window.__CAP__ ?? {{}};
                        window.__CAP__.initialTargetMode = {}
                    ",
                        serde_json::to_string(init_target_mode)
                            .expect("Failed to serialize initial target mode")
                    ))
                    .build()?;

                #[cfg(target_os = "macos")]
                {
                    if new_recording_flow {
                        _ = window.run_on_main_thread({
                            let window = window.clone();
                            move || window.objc2_nswindow().setLevel(50)
                        });
                    }

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

                let mut builder = self
                    .window_builder(
                        app,
                        format!("/target-select-overlay?displayId={display_id}&isHoveredDisplay={is_hovered_display}"),
                    )
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    let position = display.raw_handle().logical_position();
                    let size = display.logical_size().unwrap();

                    builder = builder
                        .inner_size(size.width(), size.height())
                        .position(position.x(), position.y());
                }

                #[cfg(windows)]
                {
                    builder = window_builder.inner_size(100.0, 100.0).position(0.0, 0.0);
                }

                let window = builder.build()?;

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

                window
            }
            Self::Settings { page } => {
                // Hide main window and target select overlays when settings window opens
                for (label, window) in app.webview_windows() {
                    if let Ok(id) = CapWindowDef::from_str(&label)
                        && matches!(
                            id,
                            CapWindowDef::TargetSelectOverlay { .. }
                                | CapWindowDef::Main
                                | CapWindowDef::Camera
                        )
                    {
                        let _ = window.hide();
                    }
                }

                let mut builder = self
                    .window_builder(
                        app,
                        format!("/settings/{}", page.clone().unwrap_or_default()),
                    )
                    .resizable(true)
                    .maximized(false)
                    .center();

                builder.build()?
            }
            Self::Editor { .. } => {
                if let Some(main) = CapWindowDef::Main.get(app) {
                    let _ = main.close();
                };

                self.window_builder(app, "/editor")
                    .maximizable(true)
                    .inner_size(1240.0, 800.0)
                    .center()
                    .build()?
            }
            Self::ScreenshotEditor { path: _ } => {
                if let Some(main) = CapWindowDef::Main.get(app) {
                    let _ = main.close();
                };

                self.window_builder(app, "/screenshot-editor")
                    .maximizable(true)
                    .inner_size(1240.0, 800.0)
                    .center()
                    .build()?
            }
            Self::Upgrade => {
                // Hide main window when upgrade window opens
                if let Some(main) = CapWindowDef::Main.get(app) {
                    let _ = main.hide();
                }

                self.window_builder(app, "/upgrade")
                    .resizable(false)
                    .focused(true)
                    .always_on_top(true)
                    .maximized(false)
                    .shadow(true)
                    .center()
                    .build()?
            }
            Self::ModeSelect => {
                // Hide main window when mode select window opens
                if let Some(main) = CapWindowDef::Main.get(app) {
                    let _ = main.hide();
                }

                self.window_builder(app, "/mode-select")
                    .inner_size(900.0, 500.0)
                    .min_inner_size(900.0, 500.0)
                    .resizable(true)
                    .maximized(false)
                    .maximizable(false)
                    .center()
                    .focused(true)
                    .shadow(true)
                    .build()?
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
                        error!("Unable to initialize camera preview as one already exists!");
                        if let Some(window) = CapWindowDef::Camera.get(app) {
                            window.show().ok();
                        }
                        return Err(anyhow!(
                            "Unable to initialize camera preview as one already exists!"
                        )
                        .into());
                    }

                    let mut builder = self
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
			                window.__CAP__.cameraWsPort = {};
		                ",
                            state.camera_ws_port
                        ))
                        .transparent(true)
                        .visible(false); // We set this true in `CameraWindowState::init_window`

                    let window = builder.build()?;

                    if enable_native_camera_preview {
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

                        let camera_feed = state.camera_feed.clone();
                        if let Err(err) = state
                            .camera_preview
                            .init_window(window.clone(), camera_feed)
                            .await
                        {
                            error!("Error initializing camera preview: {err}");
                            window.close().ok();
                        }
                    }

                    #[cfg(target_os = "macos")]
                    dispatch2::run_on_main(|_| {
                        let nswindow = window.objc2_nswindow();
                        nswindow.setCollectionBehavior(
                            nswindow.collectionBehavior()
                                | objc2_app_kit::NSWindowCollectionBehavior::FullScreenAuxiliary,
                        );
                    });

                    window
                }
            }
            Self::WindowCaptureOccluder { screen_id } => {
                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                #[cfg(target_os = "macos")]
                let position = display.raw_handle().logical_position();

                #[cfg(windows)]
                let position = display.raw_handle().physical_position().unwrap();

                let bounds = display.physical_size().unwrap();

                let mut builder = self
                    .window_builder(app, "/window-capture-occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .inner_size(bounds.width(), bounds.height())
                    .position(position.x(), position.y())
                    .transparent(true);

                let window = builder.build()?;
                window.set_ignore_cursor_events(true).unwrap();
                window
            }
            Self::CaptureArea { screen_id } => {
                let mut builder = self
                    .window_builder(app, "/capture-area")
                    .maximized(false)
                    .fullscreen(false)
                    .shadow(false)
                    .always_on_top(true)
                    .skip_taskbar(true)
                    .closable(true)
                    .decorations(false)
                    .transparent(true);

                let Some(display) = Display::from_id(screen_id) else {
                    return Err(tauri::Error::WindowNotFound);
                };

                #[cfg(target_os = "macos")]
                if let Some(bounds) = display.raw_handle().logical_bounds() {
                    builder = builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                #[cfg(windows)]
                if let Some(bounds) = display.raw_handle().physical_bounds() {
                    builder = builder
                        .inner_size(bounds.size().width(), bounds.size().height())
                        .position(bounds.position().x(), bounds.position().y());
                }

                // Hide the main window if the target monitor is the same
                if let Some(main_window) = CapWindowDef::Main.get(app)
                    && let (Ok(outer_pos), Ok(outer_size)) =
                        (main_window.outer_position(), main_window.outer_size())
                    && let Ok(scale_factor) = main_window.scale_factor()
                    && display.intersects(outer_pos, outer_size, scale_factor)
                {
                    let _ = main_window.minimize();
                };

                builder.build()?
            }
            Self::InProgressRecording { countdown } => {
                let width = 320.0;
                let height = 150.0;

                let window = self
                    .window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(!cfg!(windows))
                    .always_on_top(true)
                    .transparent(true)
                    .visible_on_all_workspaces(true)
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

                            panel.set_level(objc2_app_kit::NSMainMenuWindowLevel as i32);

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

        #[cfg(target_os = "macos")]
        let _ = window.run_on_main_thread({
            let window = window.clone();
            move || {
                if def.disables_window_buttons() {
                    window.set_traffic_lights_visible(false);
                }

                let nswindow = window.objc2_nswindow();

                if def.disables_fullscreen() {
                    nswindow.setCollectionBehavior(
                        nswindow.collectionBehavior()
                            | objc2_app_kit::NSWindowCollectionBehavior::FullScreenNone,
                    );
                }

                if let Some(level) = def.window_level() {
                    nswindow.setLevel(level)
                }
            }
        });

        Ok(window)
    }

    fn window_builder<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        let def = self.def(app);
        let should_protect = should_protect_window(app, def.title());

        let mut builder = WebviewWindow::builder(app, def.label(), WebviewUrl::App(url.into()))
            .title(def.title())
            .visible(false)
            .accept_first_mouse(true)
            .shadow(true)
            .content_protected(should_protect);

        if let Some(min) = def.min_size() {
            builder = builder
                .inner_size(min.0, min.1)
                .min_inner_size(min.0, min.1);
        }

        #[cfg(target_os = "macos")]
        if def.undecorated() {
            builder = builder.decorations(false);
        } else {
            builder = builder
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .traffic_light_position(def.pre_solarium_traffic_lights_position());
        }

        #[cfg(windows)]
        {
            builder = builder.decorations(false);
        }

        builder
    }

    pub fn def(&self, app: &AppHandle) -> CapWindowDef {
        match self {
            CapWindow::Setup => CapWindowDef::Setup,
            CapWindow::Main { .. } => CapWindowDef::Main,
            CapWindow::Settings { .. } => CapWindowDef::Settings,
            CapWindow::Editor { project_path } => {
                let state = app.state::<EditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(path, _)| path == project_path).unwrap().1;
                CapWindowDef::Editor { id }
            }
            CapWindow::RecordingsOverlay => CapWindowDef::RecordingsOverlay,
            CapWindow::TargetSelectOverlay { display_id } => CapWindowDef::TargetSelectOverlay {
                display_id: display_id.clone(),
            },
            CapWindow::WindowCaptureOccluder { screen_id } => CapWindowDef::WindowCaptureOccluder {
                screen_id: screen_id.clone(),
            },
            CapWindow::CaptureArea { .. } => CapWindowDef::CaptureArea,
            CapWindow::Camera => CapWindowDef::Camera,
            CapWindow::InProgressRecording { .. } => CapWindowDef::RecordingControls,
            CapWindow::Upgrade => CapWindowDef::Upgrade,
            CapWindow::ModeSelect => CapWindowDef::ModeSelect,
            CapWindow::ScreenshotEditor { path } => {
                let state = app.state::<ScreenshotEditorWindowIds>();
                let s = state.ids.lock().unwrap();
                let id = s.iter().find(|(p, _)| p == path).unwrap().1;
                CapWindowDef::ScreenshotEditor { id }
            }
        }
    }
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
        if let Ok(id) = CapWindowDef::from_str(&label) {
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
