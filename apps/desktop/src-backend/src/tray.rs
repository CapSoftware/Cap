use cap_desktop_runtime::{AppHandle, Event};
use cap_recording::RecordingMode;
use serde_json::json;

use crate::{
    RecordingStarted, RecordingStopped, RequestOpenSettings, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    windows::ShowCapWindow,
};

fn current_mode(app: &AppHandle) -> RecordingMode {
    RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .and_then(|settings| settings.mode)
        .unwrap_or_default()
}

fn menu(app: &AppHandle) -> serde_json::Value {
    let mode = current_mode(app);
    let mut items = vec![
        json!({ "id": "open_cap", "text": "Open Cap" }),
        json!({ "type": "separator" }),
        json!({ "id": "record_display", "text": "Record Display" }),
        json!({ "id": "record_window", "text": "Record Window" }),
        json!({ "id": "record_area", "text": "Record Area" }),
        json!({ "id": "take_screenshot", "text": "Take Screenshot" }),
        json!({ "id": "import_video", "text": "Import Media" }),
        json!({
            "text": "Recording Mode",
            "items": [
                { "id": "mode_studio", "text": "Studio", "checked": mode == RecordingMode::Studio },
                { "id": "mode_instant", "text": "Instant", "checked": mode == RecordingMode::Instant },
                { "id": "mode_screenshot", "text": "Screenshot", "checked": mode == RecordingMode::Screenshot }
            ]
        }),
        json!({ "type": "separator" }),
        json!({ "id": "view_all_recordings", "text": "View Recordings" }),
        json!({ "id": "view_all_screenshots", "text": "View Screenshots" }),
        json!({ "id": "open_settings", "text": "Settings" }),
    ];
    if !crate::permissions::do_permissions_check(false).necessary_granted() {
        items.push(json!({ "id": "request_permissions", "text": "Grant Permissions" }));
    }
    items.extend([
        json!({ "id": "upload_logs", "text": "Upload Logs" }),
        json!({ "type": "separator" }),
        json!({ "id": "quit", "text": "Quit Cap" }),
    ]);
    json!({ "items": items, "mode": mode })
}

pub(crate) fn refresh_tray_menu_for_app(app: &AppHandle) {
    let _ = app.native_operation("tray.configure", menu(app));
}

pub fn update_tray_icon_for_mode(app: &AppHandle, mode: RecordingMode) {
    let _ = app.native_operation("tray.setMode", json!({ "mode": mode }));
    refresh_tray_menu_for_app(app);
}

pub fn create_tray(app: &AppHandle) -> cap_desktop_runtime::Result<()> {
    refresh_tray_menu_for_app(app);

    let app_handle = app.clone();
    app.listen("tray://click", move |event| {
        let Ok(id) = serde_json::from_str::<String>(event.payload()) else {
            return;
        };
        dispatch(app_handle.clone(), id);
    });

    let app_handle = app.clone();
    RecordingStarted::listen_any(app, move |_| {
        let _ = app_handle.native_operation("tray.setRecording", json!({ "recording": true }));
    });
    let app_handle = app.clone();
    RecordingStopped::listen_any(app, move |_| {
        let _ = app_handle.native_operation("tray.setRecording", json!({ "recording": false }));
        update_tray_icon_for_mode(&app_handle, current_mode(&app_handle));
    });
    Ok(())
}

fn dispatch(app: AppHandle, id: String) {
    tokio::spawn(async move {
        match id.as_str() {
            "open_cap" => {
                let _ = ShowCapWindow::Main {
                    init_target_mode: None,
                }
                .show(&app)
                .await;
            }
            "record_display" => crate::open_target_picker(&app, RecordingTargetMode::Display).await,
            "record_window" => crate::open_target_picker(&app, RecordingTargetMode::Window).await,
            "record_area" => crate::open_target_picker(&app, RecordingTargetMode::Area).await,
            "take_screenshot" => {
                use cap_recording::screen_capture::ScreenCaptureTarget;
                use scap_targets::Display;
                let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
                let target = ScreenCaptureTarget::Display { id: display.id() };
                match recording::take_screenshot(app.clone(), target.clone()).await {
                    Ok(path) if crate::automation::should_open_screenshot_editor(&app, &target) => {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                    }
                    Ok(_) => {}
                    Err(error) => tracing::error!(%error, "Failed to take screenshot from tray"),
                }
            }
            "stop_recording" => {
                let _ = recording::stop_recording(app.clone(), app.state()).await;
            }
            "import_video" => import_media(&app).await,
            "view_all_recordings" => {
                let _ = RequestOpenSettings {
                    page: "recordings".to_string(),
                }
                .emit(&app);
            }
            "view_all_screenshots" => {
                let _ = RequestOpenSettings {
                    page: "screenshots".to_string(),
                }
                .emit(&app);
            }
            "open_settings" => {
                let _ = ShowCapWindow::Settings { page: None }.show(&app).await;
            }
            "upload_logs" => {
                let result = crate::logging::upload_log_file(&app).await;
                let message = if result.is_ok() {
                    "Logs uploaded successfully"
                } else {
                    "Failed to upload logs"
                };
                let _ = app.native_operation("dialog.message", json!({ "message": message }));
            }
            "mode_studio" => set_mode(&app, RecordingMode::Studio),
            "mode_instant" => set_mode(&app, RecordingMode::Instant),
            "mode_screenshot" => set_mode(&app, RecordingMode::Screenshot),
            "request_permissions" => {
                let _ = ShowCapWindow::Onboarding.show(&app).await;
            }
            "quit" => crate::request_app_exit(app.clone()).await,
            _ => {}
        }
    });
}

fn set_mode(app: &AppHandle, mode: RecordingMode) {
    if let Err(error) = RecordingSettingsStore::set_mode(app, mode) {
        tracing::error!(%error, "Failed to set recording mode from tray");
        return;
    }
    update_tray_icon_for_mode(app, mode);
}

async fn import_media(app: &AppHandle) {
    let path = match app
        .native_request::<Option<String>, _>(
            "dialog.open",
            json!({
                "title": "Import Media",
                "filters": [{
                    "name": "Media Files",
                    "extensions": ["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"]
                }]
            }),
        )
        .await
    {
        Ok(Some(path)) => std::path::PathBuf::from(path),
        Ok(None) => return,
        Err(error) => {
            tracing::error!(%error, "Failed to open import dialog");
            return;
        }
    };

    let result = if crate::import::is_supported_video_import_path(&path) {
        crate::import::start_video_import(app.clone(), path)
            .await
            .map(|project_path| ShowCapWindow::Editor { project_path })
    } else if crate::import::is_supported_image_import_path(&path) {
        crate::import::start_image_import(app.clone(), path)
            .await
            .map(|path| ShowCapWindow::ScreenshotEditor { path })
    } else {
        Err("Unsupported media file".to_string())
    };

    match result {
        Ok(window) => {
            let _ = window.show(app).await;
        }
        Err(error) => {
            let _ = app.native_operation(
                "dialog.message",
                json!({ "title": "Import Error", "message": error, "kind": "error" }),
            );
        }
    }
}
