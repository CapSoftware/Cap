#![allow(unused_mut)]
use std::path::PathBuf;

use tauri::{
    AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

const DEFAULT_TRAFFIC_LIGHTS_INSET: LogicalPosition<f64> = LogicalPosition::new(12.0, 12.0);

#[derive(Clone)]
pub enum CapWindow {
    Setup,
    Main,
    Settings { page: Option<String> },
    Editor { project_id: String },
    PrevRecordings,
    WindowCaptureOccluder,
    Camera { ws_port: u16 },
    InProgressRecording { position: Option<(f64, f64)> },
    Upgrade,
}

#[derive(Clone)]
pub enum CapWindowId {
    // Contains onboarding + permissions
    Setup,
    Main,
    Settings,
    Editor { project_id: String },
    PrevRecordings,
    WindowCaptureOccluder,
    Camera,
    InProgressRecording,
    Upgrade,
}

impl CapWindowId {
    pub fn from_label(label: &str) -> Self {
        match label {
            "setup" => Self::Setup,
            "main" => Self::Main,
            "settings" => Self::Settings,
            "camera" => Self::Camera,
            "window-capture-occluder" => Self::WindowCaptureOccluder,
            "in-progress-recording" => Self::InProgressRecording,
            "prev-recordings" => Self::PrevRecordings,
            "upgrade" => Self::Upgrade,
            s if s.starts_with("editor-") => Self::Editor {
                project_id: s.replace("editor-", ""),
            },
            _ => unreachable!("unknown window label: {}", label),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Setup => "setup".to_string(),
            Self::Main => "main".to_string(),
            Self::Settings => "settings".to_string(),
            Self::Camera => "camera".to_string(),
            Self::WindowCaptureOccluder => "window-capture-occluder".to_string(),
            Self::InProgressRecording => "in-progress-recording".to_string(),
            Self::PrevRecordings => "prev-recordings".to_string(),
            Self::Upgrade => "upgrade".to_string(),
            Self::Editor { project_id } => format!("editor-{}", project_id),
        }
    }

    pub fn title(&self) -> String {
        match self {
            Self::Setup => "Cap Setup".to_string(),
            Self::Settings => "Cap Settings".to_string(),
            Self::WindowCaptureOccluder => "Cap Window Capture Occluder".to_string(),
            Self::InProgressRecording => "Cap In Progress Recording".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
            _ => "Cap".to_string(),
        }
    }

    pub fn activates_dock(&self) -> bool {
        matches!(
            self,
            Self::Setup | Self::Main | Self::Editor { .. } | Self::Settings | Self::Upgrade
        )
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.label();
        app.get_webview_window(&label)
    }

    pub fn traffic_lights_position(&self) -> Option<Option<LogicalPosition<f64>>> {
        match self {
            Self::Camera | Self::WindowCaptureOccluder | Self::PrevRecordings => None,
            Self::Editor { .. } => Some(Some(LogicalPosition::new(20.0, 48.0))),
            Self::InProgressRecording => Some(Some(LogicalPosition::new(-100.0, -100.0))),
            _ => Some(None),
        }
    }
}

impl CapWindow {
    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.id().label();
        app.get_webview_window(&label)
    }

    pub fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        if let Some(window) = self.get(app) {
            window.show().ok();
            window.set_focus().ok();

            return Ok(window);
        }

        let id = self.id();

        let monitor = app.primary_monitor()?.unwrap();

        let window = match self {
            Self::Setup => {
                let mut window_builder = self
                    .window_builder(app, "/setup")
                    .inner_size(600.0, 600.0)
                    .resizable(false)
                    .maximized(false)
                    .center()
                    .focused(true)
                    .maximizable(false)
                    .theme(Some(tauri::Theme::Light))
                    .visible(true)
                    .shadow(true);

                let window = window_builder.build()?;
                window.set_focus().ok();
                window
            }
            Self::Main => {
                let mut window_builder = self
                    .window_builder(app, "/")
                    .inner_size(300.0, 360.0)
                    .resizable(false)
                    .maximized(false)
                    .maximizable(false)
                    .maximized(false)
                    .theme(Some(tauri::Theme::Light));

                window_builder.build()?
            }
            Self::Settings { page } => {
                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/settings/{}", page.clone().unwrap_or_default()),
                    )
                    .min_inner_size(600.0, 450.0)
                    .resizable(true)
                    .maximized(false);

                window_builder.build()?
            }
            Self::Editor { project_id } => {
                let mut window_builder = self
                    .window_builder(app, format!("/editor?id={project_id}"))
                    .inner_size(1150.0, 800.0)
                    .maximizable(true)
                    .theme(Some(tauri::Theme::Light));

                window_builder.build()?
            }
            Self::Upgrade => {
                let mut window_builder = self
                    .window_builder(app, "/upgrade")
                    .inner_size(800.0, 850.0)
                    .resizable(false)
                    .maximized(false)
                    .transparent(true);

                window_builder.build()?
            }
            Self::Camera { ws_port } => {
                const WINDOW_SIZE: f64 = 230.0 * 2.0;

                let mut window_builder = self
                    .window_builder(app, "/camera")
                    .maximized(false)
                    .resizable(false)
                    .shadow(false)
                    .fullscreen(false)
                    .decorations(false)
                    .always_on_top(true)
                    .content_protected(true)
                    .visible_on_all_workspaces(true)
                    .min_inner_size(WINDOW_SIZE, WINDOW_SIZE * 2.0)
                    .inner_size(WINDOW_SIZE, WINDOW_SIZE * 2.0)
                    .skip_taskbar(true)
                    .position(
                        100.0,
                        (monitor.size().height as f64) / monitor.scale_factor()
                            - WINDOW_SIZE
                            - 100.0,
                    )
                    .initialization_script(&format!(
                        "
			                window.__CAP__ = window.__CAP__ ?? {{}};
			                window.__CAP__.cameraWsPort = {ws_port};
		                ",
                    ))
                    .transparent(true);

                window_builder.build()?
            }
            Self::WindowCaptureOccluder => {
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
                    .inner_size(
                        (monitor.size().width as f64) / monitor.scale_factor(),
                        (monitor.size().height as f64) / monitor.scale_factor(),
                    )
                    .position(0.0, 0.0)
                    .transparent(true);

                let window = window_builder.build()?;

                window.set_ignore_cursor_events(true).unwrap();

                #[cfg(target_os = "macos")]
                {
                    crate::platform::set_window_level(
                        window.as_ref().window(),
                        objc2_app_kit::NSScreenSaverWindowLevel as u32,
                    );
                }

                window
            }
            Self::InProgressRecording {
                position: _position,
            } => {
                let width = 160.0;
                let height = 40.0;

                self.window_builder(app, "/in-progress-recording")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .shadow(true)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .inner_size(width, height)
                    .position(
                        ((monitor.size().width as f64) / monitor.scale_factor() - width) / 2.0,
                        (monitor.size().height as f64) / monitor.scale_factor() - height - 120.0,
                    )
                    .visible(false)
                    .theme(Some(tauri::Theme::Dark))
                    .build()?
            }
            Self::PrevRecordings => {
                let mut window_builder = self
                    .window_builder(app, "/prev-recordings")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .decorations(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .accept_first_mouse(true)
                    .content_protected(true)
                    .inner_size(
                        350.0,
                        (monitor.size().height as f64) / monitor.scale_factor(),
                    )
                    .skip_taskbar(true)
                    .position(0.0, 0.0)
                    .transparent(true);

                let window = window_builder.build()?;

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
		                }).ok();
                }

                window
            }
        };

        if let Some(position) = id.traffic_lights_position() {
            add_traffic_lights(&window, position);
        }

        Ok(window)
    }

    fn window_builder<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        let id = self.id();

        let mut builder = WebviewWindow::builder(app, id.label(), WebviewUrl::App(url.into()))
            .title(id.title())
            .visible(false)
            .accept_first_mouse(true)
            .shadow(true);

        #[cfg(target_os = "macos")]
        {
            if id.traffic_lights_position().is_some() {
                builder = builder
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay);
            }
        }

        #[cfg(target_os = "windows")]
        {
            builder = builder.decorations(false);
        }

        builder
    }

    pub fn id(&self) -> CapWindowId {
        match self {
            CapWindow::Setup => CapWindowId::Setup,
            CapWindow::Main => CapWindowId::Main,
            CapWindow::Settings { .. } => CapWindowId::Settings,
            CapWindow::Editor { project_id } => CapWindowId::Editor {
                project_id: project_id.clone(),
            },
            CapWindow::PrevRecordings => CapWindowId::PrevRecordings,
            CapWindow::WindowCaptureOccluder => CapWindowId::WindowCaptureOccluder,
            CapWindow::Camera { .. } => CapWindowId::Camera,
            CapWindow::InProgressRecording { .. } => CapWindowId::InProgressRecording,
            CapWindow::Upgrade => CapWindowId::Upgrade,
        }
    }
}
fn add_traffic_lights(window: &WebviewWindow<Wry>, controls_inset: Option<LogicalPosition<f64>>) {
    #[cfg(target_os = "macos")]
    {
        use crate::platform::delegates;

        let target_window = window.clone();
        window
            .run_on_main_thread(move || {
                delegates::setup(
                    target_window.as_ref().window(),
                    controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
                );

                let c_win = target_window.clone();
                target_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::ThemeChanged(..) = event {
                        delegates::position_window_controls(
                            delegates::UnsafeWindowHandle(
                                c_win
                                    .ns_window()
                                    .expect("Failed to get native window handle"),
                            ),
                            &controls_inset.unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
                        );
                    }
                });
            })
            .ok();
    }
}

#[tauri::command]
#[specta::specta]
pub fn position_traffic_lights(window: tauri::Window, controls_inset: Option<(f64, f64)>) {
    #[cfg(target_os = "macos")]
    {
        use crate::platform::delegates::{position_window_controls, UnsafeWindowHandle};
        let c_win = window.clone();

        window
            .run_on_main_thread(move || {
                position_window_controls(
                    UnsafeWindowHandle(
                        c_win
                            .ns_window()
                            .expect("Failed to get native window handle"),
                    ),
                    &controls_inset
                        .map(LogicalPosition::from)
                        .unwrap_or(DEFAULT_TRAFFIC_LIGHTS_INSET),
                );
            })
            .ok();
    }
}
