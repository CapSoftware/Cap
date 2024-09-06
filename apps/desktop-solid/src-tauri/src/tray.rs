use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::TrayIconBuilder, AppHandle, Manager, Runtime,
};

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let new_recording_i =
        MenuItem::with_id(app, "new_recording", "New Recording", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&new_recording_i, &quit_i])?;

    let _ = TrayIconBuilder::with_id("tray")
        .icon(Image::from_path(app.path().resolve(
            "icons/tray-default-icon.png",
            BaseDirectory::Resource,
        )?)?)
        .menu(&menu)
        .menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "new_recording" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app);

    Ok(())
}
