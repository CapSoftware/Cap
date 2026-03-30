use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

use crate::recording::{PauseStopRecording, RecordingState};

/// Parse and handle a `cap://` deep-link URL.
///
/// Supported routes:
///   cap://recording/start
///   cap://recording/stop
///   cap://recording/pause
///   cap://recording/resume
///   cap://recording/restart
///   cap://recording/screenshot
///   cap://mic/set?deviceId=<id>
///   cap://camera/set?deviceId=<id>
///   cap://camera/toggle          (show / hide)
///   cap://mode/set?mode=<mode>   (e.g. "hd", "screenshot")
pub fn handle_deeplink(app: &AppHandle, url: &str) {
    let parsed = match Url::parse(url) {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[deeplink] Failed to parse URL `{}`: {}", url, e);
            return;
        }
    };

    // Only accept our custom scheme
    if parsed.scheme() != "cap" {
        eprintln!("[deeplink] Unexpected scheme: {}", parsed.scheme());
        return;
    }

    let host = parsed.host_str().unwrap_or("");
    let path = parsed.path().trim_start_matches('/');
    let route = if path.is_empty() {
        host.to_string()
    } else {
        format!("{}/{}", host, path)
    };

    println!("[deeplink] Handling route: {}", route);

    match route.as_str() {
        // ── Recording controls ──────────────────────────────────────────────
        "recording/start" => {
            app.emit("deeplink-recording-start", ()).ok();
        }
        "recording/stop" => {
            app.emit("deeplink-recording-stop", ()).ok();
        }
        "recording/pause" => {
            app.emit("deeplink-recording-pause", ()).ok();
        }
        "recording/resume" => {
            app.emit("deeplink-recording-resume", ()).ok();
        }
        "recording/restart" => {
            app.emit("deeplink-recording-restart", ()).ok();
        }
        "recording/screenshot" => {
            app.emit("deeplink-screenshot", ()).ok();
        }

        // ── Microphone ──────────────────────────────────────────────────────
        "mic/set" => {
            let device_id = query_param(&parsed, "deviceId");
            app.emit("deeplink-mic-set", device_id).ok();
        }

        // ── Camera ──────────────────────────────────────────────────────────
        "camera/set" => {
            let device_id = query_param(&parsed, "deviceId");
            app.emit("deeplink-camera-set", device_id).ok();
        }
        "camera/toggle" => {
            app.emit("deeplink-camera-toggle", ()).ok();
        }

        // ── Mode ────────────────────────────────────────────────────────────
        "mode/set" => {
            let mode = query_param(&parsed, "mode");
            app.emit("deeplink-mode-set", mode).ok();
        }

        // ── Status (returns JSON via a window event) ─────────────────────
        "recording/status" => {
            // The frontend will respond via the `recording-status-response` event
            app.emit("deeplink-recording-status", ()).ok();
        }

        unknown => {
            eprintln!("[deeplink] Unknown route: {}", unknown);
        }
    }
}

fn query_param(url: &Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}
