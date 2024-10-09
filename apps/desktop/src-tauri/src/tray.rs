use crate::{
    RecordingStarted, RecordingStopped, RequestNewScreenshot, RequestOpenSettings,
    RequestStartRecording, RequestStopRecording,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{
    image::Image,
    menu::{IsMenuItem, Menu, MenuItem},
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

    let previous_recordings_i = MenuItem::with_id(
        app,
        "previous_recordings",
        "Previous Recordings",
        true,
        None::<&str>,
    )?;

    let previous_screenshots_i = MenuItem::with_id(
        app,
        "previous_screenshots",
        "Previous Screenshots",
        true,
        None::<&str>,
    )?;

    let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &version_i,
            &new_recording_i,
            &take_screenshot_i,
            &previous_recordings_i,
            &previous_screenshots_i,
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
                            let c_app = app.clone();
                            #[allow(unused_mut)]
                            let mut window_builder = WebviewWindow::builder(
                                &c_app,
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
                            .theme(Some(tauri::Theme::Light));

                            #[cfg(target_os = "macos")]
                            {
                                window_builder = window_builder
                                    .hidden_title(true)
                                    .title_bar_style(tauri::TitleBarStyle::Overlay);
                            }

                            window_builder.build().ok();
                        }

                        let _ = RequestStartRecording.emit(&app_handle);

                        // window.create_overlay_titlebar().unwrap();
                        // #[cfg(target_os = "macos")]
                        // window.set_traffic_lights_inset(14.0, 22.0).unwrap();
                    }
                    "take_screenshot" => {
                        let _ = RequestNewScreenshot.emit(&app_handle);
                    }
                    "previous_recordings" => {
                        let _ = RequestOpenSettings {
                            page: "recordings".to_string(),
                        }
                        .emit(&app_handle);
                    }
                    "previous_screenshots" => {
                        let _ = RequestOpenSettings {
                            page: "screenshots".to_string(),
                        }
                        .emit(&app_handle);
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {
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

    RecordingStarted::listen_any(app, {
        let app_handle = app.clone();
        let is_recording = Arc::clone(&is_recording);
        move |_| {
            let app_handle = app_handle.clone();
            let is_recording = Arc::clone(&is_recording);
            tauri::async_runtime::spawn(async move {
                is_recording.store(true, Ordering::Relaxed);
                if let Some(tray) = app_handle.tray_by_id("tray") {
                    if let Ok(icon) =
                        Image::from_bytes(include_bytes!("../icons/tray-stop-icon.png"))
                    {
                        let _ = tray.set_icon(Some(icon));
                    }
                }
            });
        }
    });

    RecordingStopped::listen_any(app, {
        let app_handle = app.clone();
        let is_recording = Arc::clone(&is_recording);
        move |_| {
            let app_handle = app_handle.clone();
            let is_recording = Arc::clone(&is_recording);
            tauri::async_runtime::spawn(async move {
                is_recording.store(false, Ordering::Relaxed);
                if let Some(tray) = app_handle.tray_by_id("tray") {
                    if let Ok(icon) =
                        Image::from_bytes(include_bytes!("../icons/tray-default-icon.png"))
                    {
                        let _ = tray.set_icon(Some(icon));
                    }
                }
            });
        }
    });

    Ok(())
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
        let previous_recordings_i = MenuItem::with_id(
            app,
            "previous_recordings",
            "Previous Recordings",
            true,
            None::<&str>,
        )?;
        let previous_screenshots_i = MenuItem::with_id(
            app,
            "previous_screenshots",
            "Previous Screenshots",
            true,
            None::<&str>,
        )?;
        let quit_i = MenuItem::with_id(app, "quit", "Quit Cap", true, None::<&str>)?;

        let menu_items: Vec<&dyn IsMenuItem<R>> = vec![
            &version_i,
            &new_recording_i,
            &take_screenshot_i,
            &previous_recordings_i,
            &previous_screenshots_i,
            &quit_i,
        ];
        let menu = Menu::with_items(app, &menu_items)?;

        // Set the updated menu
        tray_handle.set_menu(Some(menu))?;
    }

    Ok(())
}
