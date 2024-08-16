use tauri::{Emitter, Manager, Window};
use tauri_plugin_oauth::start;

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
