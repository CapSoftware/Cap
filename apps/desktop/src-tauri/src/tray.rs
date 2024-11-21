use crate::windows::ShowCapWindow;
use crate::{
    RecordingStarted, RecordingStopped, RequestNewScreenshot, RequestOpenSettings,
    RequestStartRecording, RequestStopRecording,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{MenuId, PredefinedMenuItem};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle,
};
use tauri_specta::Event;

pub enum TrayItem {
    OpenCap,
    StartNewRecording,
    TakeScreenshot,
    PreviousRecordings,
    PreviousScreenshots,
    OpenSettings,
    Quit,
}

impl From<TrayItem> for MenuId {
    fn from(value: TrayItem) -> Self {
        match value {
            TrayItem::OpenCap => "open_cap",
            TrayItem::StartNewRecording => "new_recording",
            TrayItem::TakeScreenshot => "take_screenshot",
            TrayItem::PreviousRecordings => "previous_recordings",
            TrayItem::PreviousScreenshots => "previous_screenshots",
            TrayItem::OpenSettings => "open_settings",
            TrayItem::Quit => "quit",
        }
        .into()
    }
}

impl From<MenuId> for TrayItem {
    fn from(value: MenuId) -> Self {
        match value.0.as_str() {
            "open_cap" => TrayItem::OpenCap,
            "new_recording" => TrayItem::StartNewRecording,
            "take_screenshot" => TrayItem::TakeScreenshot,
            "previous_recordings" => TrayItem::PreviousRecordings,
            "previous_screenshots" => TrayItem::PreviousScreenshots,
            "open_settings" => TrayItem::OpenSettings,
            "quit" => TrayItem::Quit,
            value => unreachable!("Invalid tray item id {value}"),
        }
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                "version",
                format!("Cap v{}", env!("CARGO_PKG_VERSION")),
                false,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, TrayItem::OpenCap, "Open Cap", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                TrayItem::StartNewRecording,
                "Start New Recording",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                TrayItem::TakeScreenshot,
                "Take Screenshot",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                TrayItem::PreviousRecordings,
                "Previous Recordings",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                TrayItem::PreviousScreenshots,
                "Previous Screenshots",
                true,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, TrayItem::OpenSettings, "Settings", true, None::<&str>)?,
            &MenuItem::with_id(app, TrayItem::Quit, "Quit Cap", true, None::<&str>)?,
        ],
    )?;
    let app = app.clone();
    let is_recording = Arc::new(AtomicBool::new(false));
    let _ = TrayIconBuilder::with_id("tray")
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray-default-icon.png"
        ))?)
        .menu(&menu)
        .menu_on_left_click(true)
        .on_menu_event({
            let app_handle = app.clone();
            move |app: &AppHandle, event| match TrayItem::from(event.id) {
                TrayItem::OpenCap => {
                    ShowCapWindow::Main.show(&app_handle).ok();
                }
                TrayItem::StartNewRecording => {
                    let _ = RequestStartRecording.emit(&app_handle);
                }
                TrayItem::TakeScreenshot => {
                    let _ = RequestNewScreenshot.emit(&app_handle);
                }
                TrayItem::PreviousRecordings => {
                    let _ = RequestOpenSettings {
                        page: "recordings".to_string(),
                    }
                    .emit(&app_handle);
                }
                TrayItem::PreviousScreenshots => {
                    let _ = RequestOpenSettings {
                        page: "screenshots".to_string(),
                    }
                    .emit(&app_handle);
                }
                TrayItem::OpenSettings => {
                    ShowCapWindow::Settings { page: None }
                        .show(&app_handle)
                        .ok();
                }
                TrayItem::Quit => {
                    app.exit(0);
                }
            }
        })
        .on_tray_icon_event({
            let is_recording = Arc::clone(&is_recording);
            let app_handle = app.clone();
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
        .build(&app);

    RecordingStarted::listen_any(&app, {
        let app = app.clone();
        let is_recording = is_recording.clone();
        move |_| {
            is_recording.store(true, Ordering::Relaxed);
            let Some(tray) = app.tray_by_id("tray") else {
                return;
            };

            if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-stop-icon.png")) {
                let _ = tray.set_icon(Some(icon));
            }
        }
    });

    RecordingStopped::listen_any(&app, {
        let app_handle = app.clone();
        let is_recording = is_recording.clone();
        move |_| {
            is_recording.store(false, Ordering::Relaxed);
            let Some(tray) = app_handle.tray_by_id("tray") else {
                return;
            };

            if let Ok(icon) = Image::from_bytes(include_bytes!("../icons/tray-default-icon.png")) {
                let _ = tray.set_icon(Some(icon));
            }
        }
    });

    Ok(())
}
