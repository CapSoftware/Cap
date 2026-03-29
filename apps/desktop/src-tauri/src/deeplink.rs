use tauri::{AppHandle, Manager};
use url::Url;

use crate::recording::{self, InProgressRecording};
use crate::audio;
use crate::camera;

/// Handle an incoming deep link URL, e.g. `cap://action/...`
pub async fn handle_deep_link(app: AppHandle, url: String) -> Result<(), String> {
    tracing::info!("Handling deep link: {}", url);

    let parsed = Url::parse(&url).map_err(|e| format!("Invalid deep link URL: {e}"))?;

    // We support two host conventions:
    //   cap://record/start
    //   cap://record/stop
    //   cap://record/pause
    //   cap://record/resume
    //   cap://record/restart
    //   cap://mic/set?name=<device_name>
    //   cap://camera/set?name=<device_name>
    //   cap://screenshot
    //   cap://window/main          (open the main window)

    let scheme = parsed.scheme();
    if scheme != "cap" {
        return Err(format!("Unknown scheme: {scheme}"));
    }

    let host = parsed.host_str().unwrap_or("");
    let path_segments: Vec<&str> = parsed
        .path_segments()
        .map(|s| s.collect())
        .unwrap_or_default();

    // Extract query params as a simple key=value map
    let params: std::collections::HashMap<String, String> = parsed
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();

    match (host, path_segments.first().copied().unwrap_or("")) {
        ("record", "start") => {
            tracing::info!("Deep link: start recording");
            app.emit("deeplink-action", serde_json::json!({ "action": "record/start" }))
                .map_err(|e| e.to_string())?;
        }
        ("record", "stop") => {
            tracing::info!("Deep link: stop recording");
            app.emit("deeplink-action", serde_json::json!({ "action": "record/stop" }))
                .map_err(|e| e.to_string())?;
        }
        ("record", "pause") => {
            tracing::info!("Deep link: pause recording");
            app.emit("deeplink-action", serde_json::json!({ "action": "record/pause" }))
                .map_err(|e| e.to_string())?;
        }
        ("record", "resume") => {
            tracing::info!("Deep link: resume recording");
            app.emit("deeplink-action", serde_json::json!({ "action": "record/resume" }))
                .map_err(|e| e.to_string())?;
        }
        ("record", "restart") => {
            tracing::info!("Deep link: restart recording");
            app.emit("deeplink-action", serde_json::json!({ "action": "record/restart" }))
                .map_err(|e| e.to_string())?;
        }
        ("screenshot", _) => {
            tracing::info!("Deep link: take screenshot");
            app.emit("deeplink-action", serde_json::json!({ "action": "screenshot" }))
                .map_err(|e| e.to_string())?;
        }
        ("mic", "set") => {
            let device_name = params.get("name").cloned().unwrap_or_default();
            tracing::info!("Deep link: set mic to '{}'", device_name);
            app.emit(
                "deeplink-action",
                serde_json::json!({ "action": "mic/set", "name": device_name }),
            )
            .map_err(|e| e.to_string())?;
        }
        ("mic", "list") => {
            tracing::info!("Deep link: list mics");
            app.emit("deeplink-action", serde_json::json!({ "action": "mic/list" }))
                .map_err(|e| e.to_string())?;
        }
        ("camera", "set") => {
            let device_name = params.get("name").cloned().unwrap_or_default();
            tracing::info!("Deep link: set camera to '{}'", device_name);
            app.emit(
                "deeplink-action",
                serde_json::json!({ "action": "camera/set", "name": device_name }),
            )
            .map_err(|e| e.to_string())?;
        }
        ("camera", "list") => {
            tracing::info!("Deep link: list cameras");
            app.emit("deeplink-action", serde_json::json!({ "action": "camera/list" }))
                .map_err(|e| e.to_string())?;
        }
        ("window", "main") => {
            tracing::info!("Deep link: open main window");
            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
                window.set_focus().ok();
            }
        }
        _ => {
            tracing::warn!("Unhandled deep link: host={} path={:?}", host, path_segments);
            return Err(format!("Unhandled deep link: {url}"));
        }
    }

    Ok(())
}
