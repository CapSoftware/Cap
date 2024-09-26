use crate::{
    NewRecordingAdded, NewScreenshotAdded, RecordingStarted, RecordingStopped,
    RequestNewScreenshot, RequestStartRecording, RequestStopRecording,
};
use cap_project::RecordingMeta;
use std::path::PathBuf;
use std::result::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, MenuItemKind, Submenu},
    tray::TrayIconBuilder,
    AppHandle, Manager, Runtime, WebviewWindow,
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

    let new_recording_i = MenuItem::with_id(
        app,
        "new_recording",
        "Start New Recording",
        true,
        None::<&str>,
    )?;

    let take_screenshot_i = MenuItem::with_id(
        app,
        "take_screenshot",
        "Take Screenshot",
        true,
        None::<&str>,
    )?;

    // Create a submenu for previous recordings
    let prev_recordings_submenu = create_prev_recordings_submenu(app)?;

    // Create a submenu for previous screenshots
    let prev_screenshots_submenu = create_prev_screenshots_submenu(app)?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &version_i,
            &new_recording_i,
            &take_screenshot_i,
            &prev_recordings_submenu,
            &prev_screenshots_submenu,
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
        .on_menu_event({
            let app_handle = app_handle.clone();
            move |app: &AppHandle<R>, event| {
                match event.id.as_ref() {
                    "new_recording" => {
                        if let Some(window) = app.get_webview_window("main") {
                            window.set_focus().ok();
                        } else {
                            let Some(_window) = WebviewWindow::builder(
                                &app.clone(),
                                "main",
                                tauri::WebviewUrl::App("/".into()),
                            )
                            .title("Cap")
                            .inner_size(300.0, 375.0)
                            .resizable(false)
                            .maximized(false)
                            .shadow(true)
                            .accept_first_mouse(true)
                            .transparent(true)
                            .hidden_title(true)
                            .title_bar_style(tauri::TitleBarStyle::Overlay)
                            .theme(Some(tauri::Theme::Light))
                            .build()
                            .ok() else {
                                return;
                            };
                        }

                        let _ = RequestStartRecording.emit(&app_handle);

                        // window.create_overlay_titlebar().unwrap();
                        // #[cfg(target_os = "macos")]
                        // window.set_traffic_lights_inset(14.0, 22.0).unwrap();
                    }
                    "take_screenshot" => {
                        let _ = RequestNewScreenshot.emit(&app_handle);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {
                        // Handle previous recording menu item clicks
                        if let Some(path) =
                            get_recording_path_by_pretty_name(app, event.id.as_ref())
                        {
                            NewRecordingAdded { path }.emit(app).unwrap();
                        } else if let Some(path) =
                            get_screenshot_path_by_name(app, event.id.as_ref())
                        {
                            NewScreenshotAdded { path }.emit(app).unwrap();
                        } else {
                            println!("Unhandled menu item clicked: {:?}", event);
                        }
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

                let screenshots_dir = path.join("screenshots");
                let png_files: Vec<_> = std::fs::read_dir(screenshots_dir)
                    .ok()?
                    .filter_map(|entry| {
                        let entry = entry.ok()?;
                        let path = entry.path();
                        if path.extension()?.to_str()? == "png" {
                            Some(path)
                        } else {
                            None
                        }
                    })
                    .collect();

                if let Some(png_path) = png_files.first() {
                    match Image::from_path(png_path) {
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

fn create_prev_screenshots_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let screenshots_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("screenshots"))?;

    let items: Vec<MenuItemKind<R>> = if !screenshots_dir.exists() {
        vec![MenuItem::with_id(
            app,
            "no_screenshots",
            "No screenshots yet",
            false,
            None::<&str>,
        )
        .map(MenuItemKind::MenuItem)
        .unwrap()]
    } else {
        std::fs::read_dir(screenshots_dir)
            .map_err(tauri::Error::Io)?
            .filter_map(|entry| {
                let entry = entry.ok()?;
                let path = entry.path();
                if path.is_dir() {
                    let png_files: Vec<_> = std::fs::read_dir(&path)
                        .ok()?
                        .filter_map(|file_entry| {
                            let file_entry = file_entry.ok()?;
                            let file_path = file_entry.path();
                            if file_path.extension()?.to_str()? == "png" {
                                Some(file_path)
                            } else {
                                None
                            }
                        })
                        .collect();

                    if let Some(png_path) = png_files.first() {
                        let file_name = png_path.file_stem()?.to_str()?.to_string();
                        let id = file_name.clone();
                        match Image::from_path(png_path) {
                            Ok(image) => IconMenuItem::with_id(
                                app,
                                &id,
                                &file_name,
                                true,
                                Some(image),
                                None::<&str>,
                            )
                            .map(MenuItemKind::Icon)
                            .ok(),
                            Err(_) => MenuItem::with_id(app, &id, &file_name, true, None::<&str>)
                                .map(MenuItemKind::MenuItem)
                                .ok(),
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
            .collect()
    };

    let items_ref: Vec<&dyn IsMenuItem<R>> = items
        .iter()
        .map(|item| item as &dyn IsMenuItem<R>)
        .collect();

    Submenu::with_items(app, "Previous Screenshots", true, &items_ref)
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
        let new_recording_i = MenuItem::with_id(
            app,
            "new_recording",
            "Start New Recording",
            true,
            None::<&str>,
        )?;
        let take_screenshot_i = MenuItem::with_id(
            app,
            "take_screenshot",
            "Take Screenshot",
            true,
            None::<&str>,
        )?;
        let prev_recordings_submenu = create_prev_recordings_submenu(app)?;
        let prev_screenshots_submenu = create_prev_screenshots_submenu(app)?;
        let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

        let menu_items: Vec<&dyn IsMenuItem<R>> = vec![
            &version_i,
            &new_recording_i,
            &take_screenshot_i,
            &prev_recordings_submenu,
            &prev_screenshots_submenu,
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

fn get_screenshot_path_by_name<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    let screenshots_dir = app.path().app_data_dir().ok()?.join("screenshots");

    std::fs::read_dir(screenshots_dir)
        .ok()?
        .filter_map(Result::ok)
        .find_map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                std::fs::read_dir(path)
                    .ok()?
                    .filter_map(Result::ok)
                    .find_map(|file_entry| {
                        let file_path = file_entry.path();
                        if file_path.file_stem()?.to_str()? == name {
                            Some(file_path)
                        } else {
                            None
                        }
                    })
            } else {
                None
            }
        })
}
