use crate::NewRecordingAdded;
use cap_project::RecordingMeta;
use std::path::PathBuf;
use std::result::Result;
use tauri::{
    image::Image,
    menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};
use tauri_specta::Event;

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let new_recording_i =
        MenuItem::with_id(app, "new_recording", "New Recording", true, None::<&str>)?;

    // Create a submenu for previous recordings
    let prev_recordings_submenu = create_prev_recordings_submenu(app)?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&new_recording_i, &prev_recordings_submenu, &quit_i])?;
    let _ = TrayIconBuilder::with_id("tray")
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray-default-icon.png"
        ))?)
        .menu(&menu)
        .menu_on_left_click(true)
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "new_recording" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {
                    // Handle previous recording menu item clicks
                    if event.id.as_ref().starts_with("Cap ") {
                        if let Some(path) =
                            get_recording_path_by_pretty_name(app, event.id.as_ref())
                        {
                            NewRecordingAdded { path }.emit(app).unwrap();
                        } else {
                            println!("Unknown menu item clicked: {:?}", event);
                        }
                    } else {
                        println!("Unhandled menu item clicked: {:?}", event);
                    }
                }
            }
        })
        .build(app);

    let app_handle = app.clone();
    NewRecordingAdded::listen_any(app, {
        println!("New recording added");
        let app_handle = app_handle.clone();
        move |event| {
            handle_new_recording_added(&app_handle, event.payload.path).unwrap();
        }
    });

    Ok(())
}

fn create_prev_recordings_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let prev_recordings = get_prev_recordings(app).unwrap_or_default();

    let items: Vec<MenuItemKind<R>> = prev_recordings
        .iter()
        .filter_map(|path| {
            let Ok(meta) = RecordingMeta::load_for_project(&path) else {
                return None;
            };
            let pretty_name = meta.pretty_name.clone();
            let id = pretty_name.clone();

            let thumbnail_path = path.join("screenshots").join("thumbnail.png");
            if thumbnail_path.exists() {
                match Image::from_path(&thumbnail_path) {
                    Ok(image) => IconMenuItem::with_id(
                        app,
                        &id,
                        &pretty_name,
                        true,
                        Some(image),
                        None::<&str>,
                    )
                    .map(MenuItemKind::Icon)
                    .ok(),
                    Err(_) => MenuItem::with_id(app, &id, &pretty_name, true, None::<&str>)
                        .map(MenuItemKind::MenuItem)
                        .ok(),
                }
            } else {
                MenuItem::with_id(app, &id, &pretty_name, true, None::<&str>)
                    .map(MenuItemKind::MenuItem)
                    .ok()
            }
        })
        .collect();

    let items_ref: Vec<&dyn IsMenuItem<R>> = items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();

    Submenu::with_items(app, "Previous Recordings", true, &items_ref)
}

fn get_prev_recordings<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>, tauri::Error> {
    let recordings_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("recordings"))?;

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(recordings_dir).map_err(|e| tauri::Error::Io(e))?;

    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "cap"))
        .map(|entry| entry.path())
        .collect())
}

fn handle_new_recording_added<R: Runtime>(app: &AppHandle<R>, path: PathBuf) -> tauri::Result<()> {
    if let Some(tray_handle) = app.tray_by_id("tray") {
        // Recreate the entire menu
        let new_recording_i =
            MenuItem::with_id(app, "new_recording", "New Recording", true, None::<&str>)?;
        let prev_recordings_submenu = create_prev_recordings_submenu(app)?;
        let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

        let menu_items: Vec<&dyn IsMenuItem<R>> =
            vec![&new_recording_i, &prev_recordings_submenu, &quit_i];
        let menu = Menu::with_items(app, &menu_items)?;

        // Set the updated menu
        tray_handle.set_menu(Some(menu))?;
    }

    Ok(())
}

fn get_recording_path_by_pretty_name<R: Runtime>(
    app: &AppHandle<R>,
    pretty_name: &str,
) -> Option<PathBuf> {
    get_prev_recordings(app).ok()?.into_iter().find(|path| {
        let Ok(meta) = RecordingMeta::load_for_project(&path) else {
            return false;
        };
        meta.pretty_name == pretty_name
    })
}
