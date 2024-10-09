use tauri::{AppHandle, Manager, WebviewWindow};

pub fn create_main_window(app: AppHandle) -> WebviewWindow {
    if let Some(window) = app.get_webview_window("main") {
        println!("Main window already exists, setting focus");
        window.set_focus().ok();
        return window;
    }

    println!("Creating new main window");
    #[allow(unused_mut)]
    let mut window_builder =
        WebviewWindow::builder(&app, "main", tauri::WebviewUrl::App("/".into()))
            .title("Cap")
            .inner_size(300.0, 375.0)
            .resizable(false)
            .maximized(false)
            .shadow(true)
            .accept_first_mouse(true)
            .transparent(true);

    #[cfg(target_os = "macos")]
    {
        window_builder = window_builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    let window = window_builder.build().unwrap();

    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;

        println!("Creating overlay titlebar");
        window.create_overlay_titlebar().unwrap();

        println!("Setting traffic lights inset for macOS");
        window.set_traffic_lights_inset(14.0, 22.0).unwrap();
    }

    println!("Showing main window");
    window.show().unwrap();
    println!("Main window opened successfully");

    window
}
