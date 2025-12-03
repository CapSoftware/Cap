use crate::{
    RecordingStarted, RecordingStopped, RequestOpenRecordingPicker, RequestOpenSettings, recording,
    recording_settings::RecordingTargetMode, windows::ShowCapWindow,
};

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::Manager;
use tauri::menu::{MenuId, PredefinedMenuItem};
use tauri::{
    AppHandle,
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;

pub enum TrayItem {
    OpenCap,
    RecordDisplay,
    RecordWindow,
    RecordArea,
    PreviousRecordings,
    PreviousScreenshots,
    OpenSettings,
    UploadLogs,
    Quit,
}

impl From<TrayItem> for MenuId {
    fn from(value: TrayItem) -> Self {
        match value {
            TrayItem::OpenCap => "open_cap",
            TrayItem::RecordDisplay => "record_display",
            TrayItem::RecordWindow => "record_window",
            TrayItem::RecordArea => "record_area",
            TrayItem::PreviousRecordings => "previous_recordings",
            TrayItem::PreviousScreenshots => "previous_screenshots",
            TrayItem::OpenSettings => "open_settings",
            TrayItem::UploadLogs => "upload_logs",
            TrayItem::Quit => "quit",
        }
        .into()
    }
}

impl TryFrom<MenuId> for TrayItem {
    type Error = String;

    fn try_from(value: MenuId) -> Result<Self, Self::Error> {
        match value.0.as_str() {
            "open_cap" => Ok(TrayItem::OpenCap),
            "record_display" => Ok(TrayItem::RecordDisplay),
            "record_window" => Ok(TrayItem::RecordWindow),
            "record_area" => Ok(TrayItem::RecordArea),
            "previous_recordings" => Ok(TrayItem::PreviousRecordings),
            "previous_screenshots" => Ok(TrayItem::PreviousScreenshots),
            "open_settings" => Ok(TrayItem::OpenSettings),
            "upload_logs" => Ok(TrayItem::UploadLogs),
            "quit" => Ok(TrayItem::Quit),
            value => Err(format!("Invalid tray item id {value}")),
        }
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(
                app,
                TrayItem::OpenCap,
                "Open Main Window",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                TrayItem::RecordDisplay,
                "Record Display",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(
                app,
                TrayItem::RecordWindow,
                "Record Window",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, TrayItem::RecordArea, "Record Area", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            // &MenuItem::with_id(
            //     app,
            //     TrayItem::TakeScreenshot,
            //     "Take Screenshot",
            //     true,
            //     None::<&str>,
            // )?,
            &MenuItem::with_id(
                app,
                TrayItem::PreviousRecordings,
                "Previous Recordings",
                true,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, TrayItem::OpenSettings, "Settings", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, TrayItem::UploadLogs, "Upload Logs", true, None::<&str>)?,
            &MenuItem::with_id(
                app,
                "version",
                format!("Inflight v{}", env!("CARGO_PKG_VERSION")),
                false,
                None::<&str>,
            )?,
            &MenuItem::with_id(app, TrayItem::Quit, "Quit Inflight", true, None::<&str>)?,
        ],
    )?;
    let app = app.clone();
    let is_recording = Arc::new(AtomicBool::new(false));
    let _ = TrayIconBuilder::with_id("tray")
        .icon(Image::from_bytes(include_bytes!(
            "../icons/tray-default-icon.png"
        ))?)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event({
            let app_handle = app.clone();
            move |app: &AppHandle, event| match TrayItem::try_from(event.id) {
                Ok(TrayItem::OpenCap) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(&app)
                        .await;
                    });
                }
                Ok(TrayItem::RecordDisplay) => {
                    let _ = RequestOpenRecordingPicker {
                        target_mode: Some(RecordingTargetMode::Display),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::RecordWindow) => {
                    let _ = RequestOpenRecordingPicker {
                        target_mode: Some(RecordingTargetMode::Window),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::RecordArea) => {
                    let _ = RequestOpenRecordingPicker {
                        target_mode: Some(RecordingTargetMode::Area),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::PreviousRecordings) => {
                    let _ = RequestOpenSettings {
                        page: "recordings".to_string(),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::PreviousScreenshots) => {
                    let _ = RequestOpenSettings {
                        page: "screenshots".to_string(),
                    }
                    .emit(&app_handle);
                }
                Ok(TrayItem::OpenSettings) => {
                    let app = app.clone();
                    tokio::spawn(
                        async move { ShowCapWindow::Settings { page: None }.show(&app).await },
                    );
                }
                Ok(TrayItem::UploadLogs) => {
                    let app = app.clone();
                    tokio::spawn(async move {
                        match crate::logging::upload_log_file(&app).await {
                            Ok(_) => {
                                tracing::info!("Successfully uploaded logs");
                                app.dialog()
                                    .message("Logs uploaded successfully")
                                    .show(|_| {});
                            }
                            Err(e) => {
                                tracing::error!("Failed to upload logs: {e:#}");
                                app.dialog().message("Failed to upload logs").show(|_| {});
                            }
                        }
                    });
                }
                Ok(TrayItem::Quit) => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event({
            let is_recording = Arc::clone(&is_recording);
            let app_handle = app.clone();
            move |tray, event| {
                if let tauri::tray::TrayIconEvent::Click { .. } = event {
                    if is_recording.load(Ordering::Relaxed) {
                        let app = app_handle.clone();
                        tokio::spawn(async move {
                            let _ = recording::stop_recording(app.clone(), app.state()).await;
                        });
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
