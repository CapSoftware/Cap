use std::time::{Duration, Instant};

use tauri::{Listener, Manager};
use tauri_specta::Event;

use crate::{RequestSetTargetMode, recording_settings::RecordingTargetMode};

pub const SCRIPT: &str = include_str!("picker_benchmark.js");

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
        let mut samples = Vec::new();
        for sample in 0..6 {
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
        app.unlisten(listener);
        if let Err(error) = std::fs::write(output, serde_json::json!(samples).to_string()) {
            tracing::error!(%error, "Could not write picker benchmark results");
        }
        app.exit(0);
    });
}
