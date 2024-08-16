use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager, Window};
use tauri_plugin_oauth::start;

use crate::{HEALTH_CHECK, UPLOAD_SPEED};

#[tauri::command]
#[specta::specta]
pub async fn start_server(window: Window) -> Result<u16, String> {
    start(move |url| {
        let _ = window.emit("redirect_uri", url);
    })
    .map_err(|err| err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn has_screen_capture_access() -> bool {
    scap::has_permission()
}

#[tauri::command]
#[specta::specta]
pub fn open_screen_capture_preferences() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .expect("failed to open system preferences");
}

#[tauri::command]
#[specta::specta]
pub fn open_mic_preferences() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
        .spawn()
        .expect("failed to open system preferences");
}

#[tauri::command]
#[specta::specta]
pub fn open_camera_preferences() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")
        .spawn()
        .expect("failed to open system preferences");
}

#[tauri::command]
#[specta::specta]
pub fn reset_screen_permissions() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("tccutil")
        .arg("reset")
        .arg("ScreenCapture")
        .arg("so.cap.desktop")
        .spawn()
        .expect("failed to reset screen permissions");
}

#[tauri::command]
#[specta::specta]
pub fn reset_microphone_permissions() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("tccutil")
        .arg("reset")
        .arg("Microphone")
        .arg("so.cap.desktop")
        .spawn()
        .expect("failed to reset microphone permissions");
}

#[tauri::command]
#[specta::specta]
pub fn reset_camera_permissions() {
    #[cfg(target_os = "macos")]
    std::process::Command::new("tccutil")
        .arg("reset")
        .arg("Camera")
        .arg("so.cap.desktop")
        .spawn()
        .expect("failed to reset camera permissions");
}

#[tauri::command]
#[specta::specta]
pub fn close_webview(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    match app_handle.get_webview_window(&label) {
        Some(window) => {
            let _ = window.close();
            Ok(())
        }
        None => Err(format!("No window found with label {}", &label).to_string()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn make_webview_transparent(app_handle: tauri::AppHandle, label: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_decorum::WebviewWindowExt;

        match app_handle.get_webview_window(&label) {
            Some(window) => {
                let _ = window.make_transparent();
                Ok(())
            }
            None => Err(format!("No window found with label {}", &label).to_string()),
        }
    }
    #[cfg(not(target_os = "macos"))]
    "This command is only available on macOS."
}

#[tauri::command]
#[specta::specta]
pub fn get_health_check_status() -> bool {
    let health = HEALTH_CHECK.load(Ordering::Relaxed);
    return health;
}

#[tauri::command]
#[specta::specta]
pub fn get_upload_speed() -> f64 {
    let upload_speed = UPLOAD_SPEED.load(Ordering::Relaxed);
    return upload_speed;
}

#[cfg(test)]
mod tests {
    use super::{get_health_check_status, get_upload_speed, HEALTH_CHECK, UPLOAD_SPEED};
    use std::sync::atomic::Ordering;

    #[test]
    fn test_get_health_check_status() {
        // example 1
        HEALTH_CHECK.store(true, Ordering::Relaxed);
        assert_eq!(get_health_check_status(), true);

        // example 2
        HEALTH_CHECK.store(false, Ordering::Relaxed);
        assert_eq!(get_health_check_status(), false);
    }

    #[test]
    fn test_get_upload_speed() {
        // example 1
        UPLOAD_SPEED.store(10.5, Ordering::Relaxed);
        assert_eq!(get_upload_speed(), 10.5);

        // example 2
        UPLOAD_SPEED.store(20.7, Ordering::Relaxed);
        assert_eq!(get_upload_speed(), 20.7);
    }
}