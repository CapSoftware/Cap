use crate::{NewRecordingAdded, RecordingStarted, RecordingStopped, RequestStopRecording};
use cap_project::RecordingMeta;
use std::path::PathBuf;
use std::result::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime,
};
use tauri_specta::Event;

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // Add version menu item as the first item
    let version = env!("CARGO_PKG_VERSION");
    let version_i = MenuItem::with_id(
        app,
        "version",
        format!("Cap v{}", version),
        false,
        None::<&str>,
    )?;

    let new_recording_i =
        MenuItem::with_id(app, "new_recording", "New Recording", true, None::<&str>)?;

    // Create a submenu for previous recordings
    let prev_recordings_submenu = create_prev_recordings_submenu(app)?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &version_i,
            &new_recording_i,
            &prev_recordings_submenu,
            &quit_i,
        ],
    )?;
    let app_handle = app.clone();
    let is_recording = Arc::new(AtomicBool::new(false));
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
        .on_tray_icon_event({
            let is_recording = Arc::clone(&is_recording);
            let app_handle = app_handle.clone();
            move |tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    if is_recording.load(Ordering::Relaxed) {
                        let _ = RequestStopRecording.emit(&app_handle);
                    } else {
                        let _ = tray.set_visible(true);
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

    RecordingStarted::listen_any(app, {
        let app_handle = app.clone();
        let is_recording = Arc::clone(&is_recording);
        move |_| {
            is_recording.store(true, Ordering::Relaxed);
            if let Some(tray) = app_handle.tray_by_id("tray") {
                if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-stop-icon.png")) {
                    let _ = tray.set_icon(Some(icon));
                }
            }
        }
    });

    RecordingStopped::listen_any(app, {
        let app_handle = app.clone();
        let is_recording = Arc::clone(&is_recording);
        move |_| {
            is_recording.store(false, Ordering::Relaxed);
            if let Some(tray) = app_handle.tray_by_id("tray") {
                if let Ok(icon) =
                    Image::from_bytes(include_bytes!("../icons/tray-default-icon.png"))
                {
                    let _ = tray.set_icon(Some(icon));
                }
            }
        }
    });

    Ok(())
}

fn create_prev_recordings_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let prev_recordings = get_prev_recordings(app).unwrap_or_default();

    let items: Vec<MenuItemKind<R>> = if prev_recordings.is_empty() {
        vec![MenuItem::with_id(
            app,
            "no_recordings",
            "No recordings yet",
            false,
            None::<&str>,
        )
        .map(MenuItemKind::MenuItem)
        .unwrap()]
    } else {
        prev_recordings
            .iter()
            .filter_map(|path| {
                let Ok(meta) = RecordingMeta::load_for_project(path) else {
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
            .collect()
    };

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

    let entries = std::fs::read_dir(recordings_dir).map_err(tauri::Error::Io)?;

    Ok(entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().map_or(false, |ext| ext == "cap"))
        .map(|entry| entry.path())
        .collect())
}

fn handle_new_recording_added<R: Runtime>(app: &AppHandle<R>, path: PathBuf) -> tauri::Result<()> {
    if let Some(tray_handle) = app.tray_by_id("tray") {
        // Recreate the entire menu
        let version = env!("CARGO_PKG_VERSION");
        let version_i = MenuItem::with_id(
            app,
            "version",
            format!("Cap v{}", version),
            false,
            None::<&str>,
        )?;
        let new_recording_i =
            MenuItem::with_id(app, "new_recording", "New Recording", true, None::<&str>)?;
        let prev_recordings_submenu = create_prev_recordings_submenu(app)?;
        let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

        let menu_items: Vec<&dyn IsMenuItem<R>> = vec![
            &version_i,
            &new_recording_i,
            &prev_recordings_submenu,
            &quit_i,
        ];
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
        let Ok(meta) = RecordingMeta::load_for_project(path) else {
            return false;
        };
        meta.pretty_name == pretty_name
    })
}
