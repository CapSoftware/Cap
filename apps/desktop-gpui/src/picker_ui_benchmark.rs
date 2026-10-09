use std::time::{Duration, Instant};

use gpui::{App, WindowHandle};

use crate::{
    app_windows,
    feeds::Feeds,
    main_window::{MainWindow, TargetType},
};

pub fn run(main: WindowHandle<MainWindow>, cx: &mut App) {
    let Some(output) = std::env::var_os("CAP_PICKER_BENCHMARK_OUTPUT") else {
        return;
    };
    cx.spawn(async move |cx| {
        let delay = std::env::var("CAP_PICKER_BENCHMARK_DELAY_MS")
            .ok()
            .and_then(|delay| delay.parse().ok())
            .unwrap_or(2000);
        cx.background_executor()
            .timer(Duration::from_millis(delay))
            .await;
        let mut samples = Vec::new();
        for sample in 0..6 {
            let started = Instant::now();
            let kind = if sample % 2 == 0 {
                TargetType::Display
            } else {
                TargetType::Window
            };
            loop {
                let enumerating = main
                    .update(cx, |view, _, _| view.is_enumerating_devices())
                    .unwrap_or(true);
                if !enumerating || started.elapsed() > Duration::from_secs(15) {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(5))
                    .await;
            }
            let enumeration_ms = started.elapsed().as_secs_f64() * 1000.0;
            let readiness = main.update(cx, |view, _, cx| {
                view.arm_overlay(kind, cx);
                Feeds::global(cx).read(cx).input_readiness()
            });
            let mut errors = Vec::new();
            if let Ok(readiness) = readiness {
                for input in [readiness.camera, readiness.microphone]
                    .into_iter()
                    .flatten()
                {
                    if let Err(error) = input.await {
                        errors.push(error);
                    }
                }
            }
            let inputs_ms = started.elapsed().as_secs_f64() * 1000.0;
            let (sender, receiver) = flume::bounded(1);
            cx.update(|cx| {
                let overlay = cx
                    .global::<app_windows::AppWindows>()
                    .overlays
                    .first()
                    .map(|(_, window)| *window);
                if let Some(overlay) = overlay {
                    let _ = overlay.update(cx, |_, window, cx| {
                        cx.on_next_frame(window, move |_, window, cx| {
                            cx.on_next_frame(window, move |_, _, _| {
                                let _ = sender.send(());
                            });
                            window.refresh();
                        });
                        window.refresh();
                    });
                }
            });
            let ready = matches!(
                futures_util::future::select(
                    Box::pin(receiver.recv_async()),
                    Box::pin(cx.background_executor().timer(Duration::from_secs(20))),
                )
                .await,
                futures_util::future::Either::Left((Ok(()), _))
            );
            samples.push(serde_json::json!({
                "sample": sample,
                "mode": if kind == TargetType::Display { "display" } else { "window" },
                "elapsedMs": started.elapsed().as_secs_f64() * 1000.0,
                "enumerationMs": enumeration_ms,
                "inputsMs": inputs_ms,
                "ready": ready && errors.is_empty(),
                "errors": errors,
            }));
            cx.update(app_windows::dismiss_target_overlays);
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
        }
        if let Err(error) = std::fs::write(output, serde_json::json!(samples).to_string()) {
            tracing::error!(%error, "Could not write picker benchmark results");
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}
