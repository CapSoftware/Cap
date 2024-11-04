#![allow(unused_mut)]
use std::path::PathBuf;

use tauri::{
    AppHandle, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry,
};

pub enum CapWindow {
    Main,
    Settings { page: Option<String> },
    Editor { project_id: String },
    Permissions,
    PrevRecordings,
    Notifications,
    WindowCaptureOccluder,
    Camera { ws_port: u16 },
    InProgressRecording { position: Option<(f64, f64)> },
    Feedback,
    Upgrade,
    Changelog,
}

pub enum CapWindowId {
    Main,
    Settings,
    Editor { project_id: String },
    Permissions,
    PrevRecordings,
    Notifications,
    WindowCaptureOccluder,
    Camera,
    InProgressRecording,
    Feedback,
    Upgrade,
    Changelog,
}

impl CapWindowId {
    pub fn from_label(label: &str) -> Self {
        match label {
            "main" => Self::Main,
            "settings" => Self::Settings,
            "camera" => Self::Camera,
            "window-capture-occluder" => Self::WindowCaptureOccluder,
            "in-progress-recording" => Self::InProgressRecording,
            "prev-recordings" => Self::PrevRecordings,
            "notifications" => Self::Notifications,
            "permissions" => Self::Permissions,
            "feedback" => Self::Feedback,
            "upgrade" => Self::Upgrade,
            "changelog" => Self::Changelog,
            s if s.starts_with("editor-") => Self::Editor {
                project_id: s.replace("editor-", ""),
            },
            _ => unreachable!("unknown window label: {}", label),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Main => "main".to_string(),
            Self::Settings => "settings".to_string(),
            Self::Camera => "camera".to_string(),
            Self::WindowCaptureOccluder => "window-capture-occluder".to_string(),
            Self::InProgressRecording => "in-progress-recording".to_string(),
            Self::PrevRecordings => "prev-recordings".to_string(),
            Self::Notifications => "notifications".to_string(),
            Self::Editor { project_id } => format!("editor-{}", project_id),
            Self::Permissions => "permissions".to_string(),
            Self::Feedback => "feedback".to_string(),
            Self::Upgrade => "upgrade".to_string(),
            Self::Changelog => "changelog".to_string(),
        }
    }

    pub fn title(&self) -> String {
        match self {
            Self::Settings => "Cap Settings".to_string(),
            Self::WindowCaptureOccluder => "Cap Window Capture Occluder".to_string(),
            Self::InProgressRecording => "Cap In Progress Recording".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
            Self::Notifications => "Cap Notifications".to_string(),
            Self::Permissions => "Cap Permissions".to_string(),
            Self::Changelog => "Cap Changelog".to_string(),
            _ => "Cap".to_string(),
        }
    }

    pub fn activates_dock(&self) -> bool {
        match self {
            Self::Main => true,
            Self::Editor { .. } => true,
            Self::Settings => true,
            Self::Notifications => true,
            Self::Permissions => true,
            Self::Feedback => true,
            Self::Upgrade => true,
            Self::Changelog => true,
            _ => false,
        }
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.label();
        app.get_webview_window(&label)
    }
}

impl CapWindow {
    pub fn from_label(label: &str) -> Self {
        match label {
            "main" => Self::Main,
            "settings" => Self::Settings { page: None },
            "camera" => Self::Camera { ws_port: 0 },
            "window-capture-occluder" => Self::WindowCaptureOccluder,
            "in-progress-recording" => Self::InProgressRecording { position: None },
            "prev-recordings" => Self::PrevRecordings,
            "notifications" => Self::Notifications,
            "permissions" => Self::Permissions,
            "feedback" => Self::Feedback,
            "upgrade" => Self::Upgrade,
            "changelog" => Self::Changelog,
            s if s.starts_with("editor-") => Self::Editor {
                project_id: s.replace("editor-", ""),
            },
            _ => unreachable!("unknown window label: {}", label),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Main => "main".to_string(),
            Self::Settings { .. } => "settings".to_string(),
            Self::Camera { .. } => "camera".to_string(),
            Self::WindowCaptureOccluder => "window-capture-occluder".to_string(),
            Self::InProgressRecording { .. } => "in-progress-recording".to_string(),
            Self::PrevRecordings => "prev-recordings".to_string(),
            Self::Notifications => "notifications".to_string(),
            Self::Editor { project_id } => format!("editor-{}", project_id),
            Self::Permissions => "permissions".to_string(),
            Self::Feedback => "feedback".to_string(),
            Self::Upgrade => "upgrade".to_string(),
            Self::Changelog => "changelog".to_string(),
        }
    }

    pub fn title(&self) -> String {
        match self {
            Self::Settings { .. } => "Cap Settings".to_string(),
            Self::WindowCaptureOccluder => "Cap Window Capture Occluder".to_string(),
            Self::InProgressRecording { .. } => "Cap In Progress Recording".to_string(),
            Self::Editor { .. } => "Cap Editor".to_string(),
            Self::Notifications => "Cap Notifications".to_string(),
            Self::Permissions => "Cap Permissions".to_string(),
            Self::Changelog => "Cap Changelog".to_string(),
            _ => "Cap".to_string(),
        }
    }

    pub fn activates_dock(&self) -> bool {
        match self {
            CapWindow::Main => true,
            CapWindow::Editor { .. } => true,
            CapWindow::Settings { .. } => true,
            CapWindow::Notifications => true,
            CapWindow::Permissions => true,
            CapWindow::Feedback => true,
            CapWindow::Upgrade => true,
            CapWindow::Changelog => true,
            _ => false,
        }
    }

    pub fn get(&self, app: &AppHandle<Wry>) -> Option<WebviewWindow> {
        let label = self.label();
        app.get_webview_window(&label)
    }

    pub fn show(&self, app: &AppHandle<Wry>) -> tauri::Result<WebviewWindow> {
        if let Some(window) = self.get(app) {
            window.show().ok();
            window.set_focus().ok();

            return Ok(window);
        }

        let monitor = app.primary_monitor()?.unwrap();

        Ok(match self {
            Self::Main => {
                let mut window_builder = self
                    .window_builder(app, "/")
                    .inner_size(300.0, 375.0)
                    .resizable(false)
                    .maximized(false)
                    .transparent(true)
                    .theme(Some(tauri::Theme::Light))
                    .shadow(true);

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .shadow(true);
                }

                #[cfg(target_os = "windows")]
                {
                    window_builder = window_builder.decorations(false).shadow(false);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
            }
            Self::Settings { page } => {
                let mut window_builder = self
                    .window_builder(
                        app,
                        format!("/settings/{}", page.clone().unwrap_or_default()),
                    )
                    .min_inner_size(600.0, 450.0)
                    .resizable(true)
                    .maximized(false)
                    .transparent(true);

                #[cfg(target_os = "windows")]
                {
                    window_builder = window_builder.decorations(false).shadow(false);
                }

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .shadow(true);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
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

                let window = window_builder.build()?;

                window
            }
            Self::WindowCaptureOccluder => {
                let mut window_builder = self
                    .window_builder(app, "/window-capture-occluder")
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .decorations(false)
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
                    .title(self.title())
                    .maximized(false)
                    .resizable(false)
                    .fullscreen(false)
                    .decorations(false)
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
                    .visible(false)
                    .build()?
            }
            Self::Notifications => {
                let window = self
                    .window_builder(app, "/notifications")
                    .maximized(false)
                    .transparent(true)
                    .resizable(false)
                    .fullscreen(false)
                    .decorations(false)
                    .shadow(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .content_protected(true)
                    .inner_size(350.0, 350.0)
                    .skip_taskbar(true)
                    .position(
                        (monitor.size().width as f64) / monitor.scale_factor() - 350.0,
                        0.0,
                    )
                    .build()?;

                // Make window non-interactive
                window.set_ignore_cursor_events(true)?;

                window
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
            Self::Editor { project_id } => {
                let mut window_builder = self
                    .window_builder(app, format!("/editor?id={project_id}"))
                    .inner_size(1150.0, 800.0)
                    .title(self.title())
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .theme(Some(tauri::Theme::Light));

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, Some(LogicalPosition::new(20.0, 48.0)));

                window
            }
            Self::Permissions => {
                let mut window_builder = self
                    .window_builder(app, "/permissions")
                    .title(self.title())
                    .inner_size(500.0, 425.0)
                    .resizable(false)
                    .maximized(false)
                    .shadow(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                }

                #[cfg(target_os = "windows")]
                {
                    window_builder = window_builder.decorations(false);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
            }
            Self::Feedback => {
                let mut window_builder = self
                    .window_builder(app, "/feedback")
                    .title(self.title())
                    .inner_size(400.0, 400.0)
                    .resizable(false)
                    .maximized(false)
                    .shadow(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                }

                #[cfg(target_os = "windows")]
                {
                    window_builder = window_builder.decorations(false);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
            }
            Self::Upgrade => {
                let mut window_builder = self
                    .window_builder(app, "/upgrade")
                    .title(self.title())
                    .inner_size(800.0, 850.0)
                    .resizable(false)
                    .maximized(false)
                    .shadow(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
            }
            Self::Changelog => {
                let mut window_builder = self
                    .window_builder(app, "/changelog")
                    .title(self.title())
                    .inner_size(600.0, 450.0)
                    .resizable(true)
                    .maximized(false)
                    .shadow(true)
                    .transparent(true);

                #[cfg(target_os = "macos")]
                {
                    window_builder = window_builder
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay);
                }

                #[cfg(target_os = "windows")]
                {
                    window_builder = window_builder.decorations(false);
                }

                let window = window_builder.build()?;

                #[cfg(target_os = "macos")]
                setup_delegates(&window, None);

                window
            }
        })
    }

    fn window_builder<'a>(
        &'a self,
        app: &'a AppHandle<Wry>,
        url: impl Into<PathBuf>,
    ) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
        WebviewWindow::builder(app, self.label(), WebviewUrl::App(url.into()))
            .title(self.title())
            .visible(false)
            .accept_first_mouse(true)
    }
}

#[cfg(target_os = "macos")]
fn setup_delegates(window: &WebviewWindow<Wry>, controls_inset: Option<LogicalPosition<f64>>) {
    use crate::platform::delegates;

    let target_window = window.clone();
    window
        .run_on_main_thread(move || {
            delegates::setup(
                target_window.as_ref().window(),
                controls_inset.unwrap_or(LogicalPosition::new(14.0, 22.0)),
            );

            let c_win = target_window.clone();
            target_window.on_window_event(move |event| match event {
                tauri::WindowEvent::ThemeChanged(..) => {
                    delegates::position_window_controls(
                        delegates::UnsafeWindowHandle(
                            c_win
                                .ns_window()
                                .expect("Failed to get native window handle"),
                        ),
                        &controls_inset.unwrap_or(LogicalPosition::new(14.0, 22.0)),
                    );
                }
                _ => (),
            });
        })
        .ok();
}
