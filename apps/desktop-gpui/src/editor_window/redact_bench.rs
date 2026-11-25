//! Harness only, built with `--features redact-bench`: measures auto
//! redact in a real editor session.
//!
//! - `CAP_GPUI_AUTO_REDACT=soak:<n>` scans the open project n times from
//!   scratch (every fourth scan is turned off halfway instead), and after each
//!   one turns every category off and on again, logging how long each toggle
//!   took and whether it started a scan.
//! - `CAP_GPUI_AUTO_REDACT=play:<seconds>` plays the timeline for that long
//!   while a scan runs, then again with none, with frame stats both times.
//! - `CAP_GPUI_AUTO_REDACT=demo:<seconds>` walks through the feature for a
//!   screen recording: opens the card, turns auto redact on, waits for the
//!   scan, adds a category, then selects the first redact span, pausing that
//!   long between steps.
//! - `CAP_GPUI_AUTO_REDACT=idle:<seconds>` leaves the editor paused for that
//!   long while a scan runs, then again with none, and logs the main thread's
//!   CPU time for each, which is what the scan's progress costs the UI.

use std::time::{Duration, Instant};

use cap_project::RedactCategory;
use gpui::{AsyncApp, WindowHandle};

use super::EditorWindow;

fn main_thread_cpu_seconds() -> f64 {
    #[cfg(unix)]
    {
        let mut time = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // SAFETY: `time` is a valid timespec for the call to fill.
        if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) } == 0 {
            return time.tv_sec as f64 + time.tv_nsec as f64 / 1e9;
        }
    }
    0.0
}

async fn pause(cx: &AsyncApp, millis: u64) {
    cx.background_executor()
        .timer(Duration::from_millis(millis))
        .await;
}

/// Waits for the scan to end, or with `stop_at` turns auto redact off once
/// it reaches that progress. Returns whether it was stopped.
async fn wait_for_scan(
    handle: WindowHandle<EditorWindow>,
    cx: &mut AsyncApp,
    stop_at: Option<f32>,
) -> bool {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(600) {
        pause(cx, 100).await;
        let Ok((running, progress)) = handle.update(cx, |view, _, _| {
            (view.redact_running(), view.redact.progress)
        }) else {
            return false;
        };
        if !running {
            return false;
        }
        if stop_at.is_some_and(|at| progress >= at) {
            handle
                .update(cx, |view, window, cx| {
                    view.set_redact_enabled(false, window, cx)
                })
                .ok();
            return true;
        }
    }
    false
}

async fn start_fresh_scan(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) {
    handle
        .update(cx, |view, window, cx| {
            view.forget_redact_scan(window, cx);
            view.set_redact_enabled(true, window, cx);
        })
        .ok();
}

pub(crate) async fn run(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) {
    let Ok(plan) = std::env::var("CAP_GPUI_AUTO_REDACT") else {
        return;
    };
    let Some((mode, amount)) = plan.split_once(':') else {
        return;
    };
    let Ok(amount) = amount.parse::<f64>() else {
        return;
    };
    pause(cx, 1500).await;
    match mode {
        "soak" => {
            for scan in 0..amount as usize {
                let started = Instant::now();
                start_fresh_scan(handle, cx).await;
                let stopped = wait_for_scan(handle, cx, (scan % 4 == 3).then_some(0.5)).await;
                let found = handle
                    .update(cx, |view, _, _| {
                        view.redact
                            .redactions
                            .as_ref()
                            .map_or(0, |redactions| redactions.regions.len())
                    })
                    .unwrap_or(0);
                tracing::info!(
                    scan,
                    seconds = format!("{:.2}", started.elapsed().as_secs_f64()),
                    stopped,
                    found,
                    "redact soak: scan"
                );
                if stopped {
                    handle
                        .update(cx, |view, window, cx| {
                            view.set_redact_enabled(true, window, cx)
                        })
                        .ok();
                    wait_for_scan(handle, cx, None).await;
                }
                let mut slowest: f64 = 0.0;
                let mut rescans = 0;
                for category in RedactCategory::ALL {
                    for _ in 0..2 {
                        let Ok((took, rescan)) = handle.update(cx, |view, window, cx| {
                            let at = Instant::now();
                            view.toggle_redact_category(category, window, cx);
                            (at.elapsed().as_secs_f64() * 1000.0, view.redact_running())
                        }) else {
                            return;
                        };
                        slowest = slowest.max(took);
                        rescans += usize::from(rescan);
                        pause(cx, 120).await;
                    }
                }
                tracing::info!(
                    scan,
                    toggles = RedactCategory::ALL.len() * 2,
                    slowest_ms = format!("{slowest:.3}"),
                    rescans,
                    "redact soak: categories"
                );
                pause(cx, 500).await;
            }
            tracing::info!("redact soak: done");
        }
        "demo" => {
            let beat = (amount * 1000.0) as u64;
            handle
                .update(cx, |view, window, cx| {
                    view.forget_redact_scan(window, cx);
                    view.open_redact_card(cx);
                })
                .ok();
            pause(cx, beat).await;
            handle
                .update(cx, |view, window, cx| {
                    view.set_redact_enabled(true, window, cx)
                })
                .ok();
            tracing::info!("redact demo: scan started");
            wait_for_scan(handle, cx, None).await;
            tracing::info!("redact demo: scan finished");
            pause(cx, beat * 2).await;
            handle
                .update(cx, |view, window, cx| {
                    if !view.project.auto_redact.has_category(RedactCategory::Name) {
                        view.toggle_redact_category(RedactCategory::Name, window, cx);
                    }
                })
                .ok();
            tracing::info!("redact demo: names on");
            pause(cx, beat * 2).await;
            handle
                .update(cx, |view, _, cx| {
                    view.close_redact_card(cx);
                    view.auto_select_segments("redact:0", cx);
                })
                .ok();
            tracing::info!("redact demo: span selected");
            pause(cx, beat * 2).await;
            handle
                .update(cx, |view, window, cx| {
                    let first = view
                        .timeline
                        .redact
                        .first()
                        .map(|span| (span.start, span.end));
                    if let Some(region) = first.and_then(|(start, end)| {
                        view.redact_regions_between(start, end).into_iter().next()
                    }) {
                        view.set_redact_kept(std::slice::from_ref(&region.id), true, window, cx);
                        tracing::info!(id = region.id, "redact demo: kept one visible");
                    }
                })
                .ok();
            pause(cx, beat * 2).await;
            tracing::info!("redact demo: done");
        }
        "play" | "idle" => {
            for with_scan in [true, false] {
                if with_scan {
                    start_fresh_scan(handle, cx).await;
                    let started = Instant::now();
                    while started.elapsed() < Duration::from_secs(60) {
                        pause(cx, 50).await;
                        let scanning = handle
                            .update(cx, |view, _, _| view.redact_scanning())
                            .unwrap_or(false);
                        if scanning {
                            break;
                        }
                    }
                }
                let Ok(cpu_before) = handle.update(cx, |view, window, cx| {
                    if mode == "play" {
                        view.seek_fraction(0.0, window, cx);
                        view.toggle_play(window, cx);
                        view.measure_frame_times(amount, window, cx);
                    }
                    main_thread_cpu_seconds()
                }) else {
                    return;
                };
                let started = Instant::now();
                pause(cx, (amount * 1000.0) as u64 + 300).await;
                let Ok((cpu_after, still_scanning)) = handle.update(cx, |view, _, cx| {
                    if mode == "play" {
                        view.stop_for_measurement(cx);
                    }
                    (main_thread_cpu_seconds(), view.redact_scanning())
                }) else {
                    return;
                };
                let seconds = started.elapsed().as_secs_f64();
                tracing::info!(
                    mode,
                    with_scan,
                    still_scanning,
                    main_thread_cpu_percent =
                        format!("{:.2}", (cpu_after - cpu_before) / seconds * 100.0),
                    "redact {mode}: window"
                );
                if with_scan {
                    wait_for_scan(handle, cx, None).await;
                }
                pause(cx, 1000).await;
            }
            tracing::info!("redact {mode}: done");
        }
        _ => {}
    }
}
