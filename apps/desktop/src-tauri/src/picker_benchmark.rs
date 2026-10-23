use std::time::{Duration, Instant};

use tauri::{Listener, Manager};
use tauri_specta::Event;

use crate::{
    RequestSetTargetMode, recording_settings::RecordingTargetMode,
    target_select_overlay::WindowFocusManager,
};

pub const SCRIPT: &str = include_str!("picker-benchmark.js");

pub fn enabled() -> bool {
    std::env::var_os("CAP_PICKER_BENCHMARK_OUTPUT").is_some()
}

pub fn run(app: tauri::AppHandle) {
    let Some(output) = std::env::var_os("CAP_PICKER_BENCHMARK_OUTPUT") else {
        return;
    };
    tokio::spawn(async move {
        let delay = std::env::var("CAP_PICKER_BENCHMARK_DELAY_MS")
            .ok()
            .and_then(|delay| delay.parse().ok())
            .unwrap_or(2000);
        tokio::time::sleep(Duration::from_millis(delay)).await;
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let listener = app.listen_any("cap-picker-benchmark-ready", move |event| {
            let _ = sender.send(event.payload().to_owned());
        });
        // Six alternating Display/Window cycles by default; the overlay
        // soak (see CAP-CHANGES in vendor/tauri-nspanel) runs hundreds.
        let sample_count = std::env::var("CAP_PICKER_BENCHMARK_SAMPLES")
            .ok()
            .and_then(|count| count.parse::<usize>().ok())
            .filter(|count| *count > 0)
            .unwrap_or(6);
        let mut samples = Vec::new();
        for sample in 0..sample_count {
            let mode = if sample % 2 == 0 {
                RecordingTargetMode::Display
            } else {
                RecordingTargetMode::Window
            };
            for (label, window) in app.webview_windows() {
                if label.starts_with("target-select-overlay") {
                    let _ = window.eval("globalThis.__capArmPickerBenchmark?.()");
                }
            }
            let started = Instant::now();
            let _ = RequestSetTargetMode {
                target_mode: Some(mode),
                display_id: None,
            }
            .emit(&app);
            let result = tokio::time::timeout(Duration::from_secs(20), receiver.recv()).await;
            samples.push(serde_json::json!({
                "sample": sample,
                "mode": mode,
                "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
                "ready": matches!(result, Ok(Some(_))),
                "frontend": result.ok().flatten().and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok()),
            }));
            let _ = RequestSetTargetMode {
                target_mode: None,
                display_id: None,
            }
            .emit(&app);
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        if let Err(error) = std::fs::write(&output, serde_json::json!(samples).to_string()) {
            tracing::error!(%error, "Could not write picker benchmark results");
        }

        // Optional Escape phase: open the Display picker and confirm it is
        // dismissed through the Escape path. `CAP_PICKER_BENCHMARK_ESCAPE=direct`
        // calls the same dismissal the global-shortcut handler runs;
        // `CAP_PICKER_BENCHMARK_ESCAPE=wait:<ms>` instead holds the picker open
        // for that long while an external driver sends a real Escape keypress,
        // and records whether the picker session ended on its own.
        if let Ok(mode) = std::env::var("CAP_PICKER_BENCHMARK_ESCAPE") {
            let hold_ms = mode
                .strip_prefix("wait:")
                .and_then(|value| value.parse::<u64>().ok());
            let mut escape_samples = Vec::new();
            for cycle in 0..3 {
                for (label, window) in app.webview_windows() {
                    if label.starts_with("target-select-overlay") {
                        let _ = window.eval("globalThis.__capArmPickerBenchmark?.()");
                    }
                }
                let _ = RequestSetTargetMode {
                    target_mode: Some(RecordingTargetMode::Display),
                    display_id: None,
                }
                .emit(&app);
                let ready = tokio::time::timeout(Duration::from_secs(20), receiver.recv())
                    .await
                    .is_ok();
                let started = Instant::now();
                let picker_open = || app.state::<WindowFocusManager>().picker_session().is_some();
                let dismissed = if let Some(hold_ms) = hold_ms {
                    // Tell the external driver the picker is up so it sends
                    // exactly one Escape per cycle.
                    let marker = std::path::PathBuf::from(&output).with_extension("escape.ready");
                    let _ = std::fs::write(&marker, b"ready");
                    let deadline = Instant::now() + Duration::from_millis(hold_ms);
                    let mut dismissed = false;
                    while Instant::now() < deadline {
                        if !picker_open() {
                            dismissed = true;
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    let _ = std::fs::remove_file(&marker);
                    dismissed
                } else {
                    tokio::time::sleep(Duration::from_millis(400)).await;
                    crate::target_select_overlay::dismiss_picker_from_escape(&app);
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    !picker_open()
                };
                escape_samples.push(serde_json::json!({
                    "cycle": cycle,
                    "ready": ready,
                    "dismissed": dismissed,
                    "dismissMs": started.elapsed().as_secs_f64() * 1000.0,
                }));
                if !dismissed {
                    let _ = RequestSetTargetMode {
                        target_mode: None,
                        display_id: None,
                    }
                    .emit(&app);
                }
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
            let escape_output = std::path::PathBuf::from(&output).with_extension("escape.json");
            if let Err(error) =
                std::fs::write(escape_output, serde_json::json!(escape_samples).to_string())
            {
                tracing::error!(%error, "Could not write escape benchmark results");
            }
        }
        app.unlisten(listener);

        // Optional second phase: close and reopen the camera window, which is
        // destroyed and recreated under the same label. This exercises the
        // NSPanel store's stale-entry replacement and its Destroyed cleanup
        // (the paths that free a converted window for real), so an ownership
        // bug in the vendored tauri-nspanel surfaces here instead of in a
        // user's recording session. Results land next to the picker output.
        let camera_cycles = std::env::var("CAP_PICKER_BENCHMARK_CAMERA_CYCLES")
            .ok()
            .and_then(|count| count.parse::<usize>().ok())
            .unwrap_or(0);
        if camera_cycles > 0 {
            let mut camera_samples = Vec::new();
            for cycle in 0..camera_cycles {
                let started = Instant::now();
                let removed = crate::windows::cleanup_camera_window(&app, None, true, true).await;
                let close_ms = started.elapsed().as_secs_f64() * 1000.0;
                tokio::time::sleep(Duration::from_millis(400)).await;
                let started = Instant::now();
                let shown = (crate::windows::ShowCapWindow::Camera { centered: true })
                    .show(&app)
                    .await
                    .is_ok();
                camera_samples.push(serde_json::json!({
                    "cycle": cycle,
                    "removed": removed,
                    "closeMs": close_ms,
                    "shown": shown,
                    "showMs": started.elapsed().as_secs_f64() * 1000.0,
                }));
                tokio::time::sleep(Duration::from_millis(900)).await;
            }
            let camera_output = std::path::PathBuf::from(&output).with_extension("camera.json");
            if let Err(error) =
                std::fs::write(camera_output, serde_json::json!(camera_samples).to_string())
            {
                tracing::error!(%error, "Could not write camera benchmark results");
            }
        }
        tracing::info!("Picker benchmark complete; requesting app exit");
        app.exit(0);
    });
}
