use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, Wry};

pub enum CapWindow {
    Main,
    Settings { page: Option<String> },
    Editor { project_id: String },
    Permissions,
    PrevRecordings,
    WindowCaptureOccluder,
    Camera { ws_port: u16 },
    InProgressRecording { position: Option<(f64, f64)> },
    Feedback,
    Upgrade,
    Changelog,
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
        let label = self.label();

        if let Some(window) = self.get(app) {
            window.show().ok();
            window.set_focus().ok();

            return Ok(window);
        }

        let monitor = app.primary_monitor()?.unwrap();

        Ok(match self {
            Self::Main => {
                let window = WebviewWindow::builder(app, label, WebviewUrl::App("/".into()))
                    .title(self.title())
                    .inner_size(300.0, 375.0)
                    .resizable(false)
                    .maximized(false)
                    .shadow(true)
                    .accept_first_mouse(true)
                    .transparent(true)
                    .hidden_title(true)
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .theme(Some(tauri::Theme::Light))
                    .build()?;

                apply_window_chrome(&window);

                window
            }
            Self::Settings { page } => {
                let window = WebviewWindow::builder(
                    app,
                    label,
                    WebviewUrl::App(
                        format!("/settings/{}", page.clone().unwrap_or_default()).into(),
                    ),
                )
                .title(self.title())
                .min_inner_size(600.0, 450.0)
                .resizable(true)
                .maximized(false)
                .shadow(true)
                .accept_first_mouse(true)
                .transparent(true)
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .build()?;

                apply_window_chrome(&window);

                window
            }
            Self::Camera { ws_port } => {
                const WINDOW_SIZE: f64 = 230.0 * 2.0;

                let window = tauri::webview::WebviewWindow::builder(
                    app,
                    label,
                    WebviewUrl::App("/camera".into()),
                )
                .title("Cap")
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
                .position(
                    100.0,
                    (monitor.size().height as f64) / monitor.scale_factor() - WINDOW_SIZE - 100.0,
                )
                .initialization_script(&format!(
                    "
			                window.__CAP__ = window.__CAP__ ?? {{}};
			                window.__CAP__.cameraWsPort = {ws_port};
		                ",
                ))
                .build()?;

                #[cfg(target_os = "macos")]
                {
                    use tauri_plugin_decorum::WebviewWindowExt;

                    window.make_transparent().ok();
                }

                window
            }
            Self::WindowCaptureOccluder => {
                let window = WebviewWindow::builder(
                    app,
                    label,
                    WebviewUrl::App("/window-capture-occluder".into()),
                )
                .title(self.title())
                .maximized(false)
                .resizable(false)
                .fullscreen(false)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .visible_on_all_workspaces(true)
                .content_protected(true)
                .inner_size(
                    (monitor.size().width as f64) / monitor.scale_factor(),
                    (monitor.size().height as f64) / monitor.scale_factor(),
                )
                .position(0.0, 0.0)
                .build()
                .unwrap();

                window.set_ignore_cursor_events(true).unwrap();

                #[cfg(target_os = "macos")]
                {
                    use objc2_app_kit::NSScreenSaverWindowLevel;
                    use tauri_plugin_decorum::WebviewWindowExt;

                    window
                        .set_window_level(NSScreenSaverWindowLevel as u32)
                        .unwrap();
                    window.make_transparent().unwrap();
                }

                window
            }
            Self::InProgressRecording { position } => {
                let width = 160.0;
                let height = 40.0;

                let window = WebviewWindow::builder(
                    app,
                    label,
                    tauri::WebviewUrl::App("/in-progress-recording".into()),
                )
                .title("Cap In Progress Recording")
                .maximized(false)
                .resizable(false)
                .fullscreen(false)
                .decorations(false)
                .shadow(true)
                .always_on_top(true)
                .transparent(true)
                .visible_on_all_workspaces(true)
                .content_protected(true)
                .accept_first_mouse(true)
                .inner_size(width, height)
                .position(
                    ((monitor.size().width as f64) / monitor.scale_factor() - width) / 2.0,
                    (monitor.size().height as f64) / monitor.scale_factor() - height - 120.0,
                )
                .visible(false)
                .build()?;

                window
            }
            Self::PrevRecordings => {
                let window =
                    WebviewWindow::builder(app, &label, WebviewUrl::App("/prev-recordings".into()))
                        .title(self.title())
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
                        .position(0.0, 0.0)
                        .build()?;

                #[cfg(target_os = "macos")]
                {
                    use tauri_plugin_decorum::WebviewWindowExt;
                    window.make_transparent().ok();

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
                let window = WebviewWindow::builder(
                    app,
                    label,
                    WebviewUrl::App(format!("/editor?id={project_id}").into()),
                )
                .inner_size(1150.0, 800.0)
                .title(self.title())
                .hidden_title(true)
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .accept_first_mouse(true)
                .theme(Some(tauri::Theme::Light))
                .build()?;

                #[cfg(target_os = "macos")]
                {
                    use tauri_plugin_decorum::WebviewWindowExt;
                    window.create_overlay_titlebar().unwrap();
                    window.set_traffic_lights_inset(20.0, 48.0).unwrap();
                }

                window
            }
            Self::Permissions => {
                let window =
                    WebviewWindow::builder(app, label, WebviewUrl::App("/permissions".into()))
                        .title(self.title())
                        .inner_size(300.0, 350.0)
                        .resizable(false)
                        .maximized(false)
                        .shadow(true)
                        .accept_first_mouse(true)
                        .transparent(true)
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .build()?;

                apply_window_chrome(&window);

                window
            }
            Self::Feedback => {
                let window =
                    WebviewWindow::builder(app, label, tauri::WebviewUrl::App("/feedback".into()))
                        .title(self.title())
                        .inner_size(400.0, 400.0)
                        .resizable(false)
                        .maximized(false)
                        .shadow(true)
                        .accept_first_mouse(true)
                        .transparent(true)
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .build()?;

                apply_window_chrome(&window);

                window
            }
            Self::Upgrade => {
                let window =
                    WebviewWindow::builder(app, label, tauri::WebviewUrl::App("/upgrade".into()))
                        .title(self.title())
                        .inner_size(800.0, 850.0)
                        .resizable(false)
                        .maximized(false)
                        .shadow(true)
                        .accept_first_mouse(true)
                        .transparent(true)
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .build()?;

                apply_window_chrome(&window);

                window
            }
            Self::Changelog => {
                let window =
                    WebviewWindow::builder(app, label, tauri::WebviewUrl::App("/changelog".into()))
                        .title(self.title())
                        .inner_size(600.0, 450.0)
                        .resizable(true)
                        .maximized(false)
                        .shadow(true)
                        .accept_first_mouse(true)
                        .transparent(true)
                        .hidden_title(true)
                        .title_bar_style(tauri::TitleBarStyle::Overlay)
                        .build()?;

                apply_window_chrome(&window);

                window
            }
        })
    }
}

fn apply_window_chrome(window: &WebviewWindow<Wry>) {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;
        window.create_overlay_titlebar().unwrap();
        window.set_traffic_lights_inset(14.0, 22.0).unwrap();
    }
}
