use serde::{Deserialize, Serialize};
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

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type)]
pub struct SystemsStatusResponse {
    connected: bool,
    latency: Option<f64>,
    status: u16,
    message: String,
}

#[derive(thiserror::Error, Debug, Serialize, specta::Type)]
#[serde(tag = "type", content = "data")]
pub enum SystemStatusResponseError {
    #[error("Timed out")]
    TimedOut(),
    #[error("io error: {0}")]
    ReqwestError(String),
}

#[tauri::command]
#[specta::specta]
pub async fn check_cap_systems_status() -> Result<SystemsStatusResponse, SystemStatusResponseError>
{
    let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");

    let client = reqwest::Client::new();
    let start_time = tokio::time::Instant::now();

    let timeout_duration = std::time::Duration::from_secs(5);

    let response_result =
        tokio::time::timeout(timeout_duration, client.get(server_url_base).send()).await;

    let latency = tokio::time::Instant::now().duration_since(start_time);
    let latency_ms = latency.as_secs_f64() * 1000.0;

    match response_result {
        Ok(Ok(response)) => {
            let status_code = response.status().as_u16();
            let connected = response.status().is_success();
            let message = if connected {
                "Connection successful".to_string()
            } else {
                "Failed to connect".to_string()
            };

            Ok(SystemsStatusResponse {
                connected,
                latency: Some(latency_ms),
                status: status_code,
                message,
            })
        }
        Ok(Err(err)) => Err(SystemStatusResponseError::ReqwestError(err.to_string())),
        Err(_) => Err(SystemStatusResponseError::TimedOut()),
    }
}
