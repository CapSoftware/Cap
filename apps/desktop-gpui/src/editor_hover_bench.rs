//! `CAP_GPUI_AUTO_HOVER_BENCH=1` (with `CAP_GPUI_AUTO_EDITOR`): the editor's
//! per-move cost while the pointer glides over a paused timeline. The pointer
//! sweeps the timeline at a fixed speed and moves arrive at
//! `CAP_GPUI_AUTO_HOVER_BENCH_HZ` (default 120); a move that lands while the
//! previous one is still being handled is coalesced into the next, as the OS
//! does. Each move runs the timeline's own hover handler, then one synchronous
//! `Window::draw` (view renders + layout + prepaint + paint) is timed with it.
//! `CAP_GPUI_AUTO_SIDEBAR` picks the sidebar tab that stays open meanwhile.
//! `CAP_GPUI_AUTO_HOVER_BENCH_SCRUB=1` holds the ruler down for the whole run,
//! so every move is also a paused scrub step through the ruler's own handlers.
//!
//! Run:
//!   CAP_GPUI_AUTO_EDITOR=<project.cap> CAP_GPUI_AUTO_HOVER_BENCH=1 \
//!     CAP_GPUI_AUTO_SIDEBAR=captions CAP_GPUI_NO_MENUS=1 CAP_GPUI_NO_TRAY=1 \
//!     cargo run --release

use std::time::{Duration, Instant};

use gpui::{App, MouseButton, MouseDownEvent, MouseMoveEvent, WindowHandle, point, px};

use crate::editor_window::EditorWindow;

const DEFAULT_MOUSE_HZ: u64 = 120;
const DEFAULT_SWEEP_SECS: f32 = 3.;
const WARMUP: Duration = Duration::from_secs(1);
const MEASURED: Duration = Duration::from_secs(6);

pub async fn run(handle: WindowHandle<EditorWindow>, cx: &mut gpui::AsyncApp) {
    if !std::env::var("CAP_GPUI_AUTO_HOVER_BENCH").is_ok_and(|value| value == "1") {
        return;
    }
    cx.background_executor()
        .timer(Duration::from_millis(2500))
        .await;
    cx.update(|cx| {
        cx.activate(true);
        handle
            .update(cx, |_, window, _| window.activate_window())
            .ok();
    });
    cx.background_executor()
        .timer(Duration::from_millis(500))
        .await;

    let mouse_hz = std::env::var("CAP_GPUI_AUTO_HOVER_BENCH_HZ")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|hz| *hz > 0)
        .unwrap_or(DEFAULT_MOUSE_HZ);
    let interval = Duration::from_micros(1_000_000 / mouse_hz);
    let sweep_secs = std::env::var("CAP_GPUI_AUTO_HOVER_BENCH_SWEEP_SECS")
        .ok()
        .and_then(|value| value.parse::<f32>().ok())
        .filter(|secs| *secs > 0.)
        .unwrap_or(DEFAULT_SWEEP_SECS);
    let scrub = std::env::var("CAP_GPUI_AUTO_HOVER_BENCH_SCRUB").is_ok_and(|value| value == "1");
    let pointer_x = |width: f32, phase: f32| 140. + (width - 180.).max(1.) * phase;
    if scrub {
        cx.update(|cx| {
            handle
                .update(cx, |view, window, cx| {
                    let x = pointer_x(f32::from(window.viewport_size().width), 0.);
                    let event = MouseDownEvent {
                        button: MouseButton::Left,
                        position: point(px(x), px(0.)),
                        click_count: 1,
                        ..Default::default()
                    };
                    view.timeline_mouse_down(&event, true, window, cx);
                })
                .ok()
        });
    }
    let started = Instant::now();
    let mut next_move = started;
    let mut move_us = Vec::new();
    let mut frames_at_start = None;
    loop {
        next_move += interval;
        let now = Instant::now();
        if next_move > now {
            cx.background_executor()
                .timer(next_move.saturating_duration_since(now))
                .await;
        } else {
            next_move = now;
            // An overloaded loop must still give the preview pump and the run
            // loop a turn between moves, as real event dispatch does.
            tokio::task::yield_now().await;
        }
        let elapsed = started.elapsed();
        if elapsed >= WARMUP + MEASURED {
            break;
        }
        let measuring = elapsed >= WARMUP;
        if measuring && frames_at_start.is_none() {
            frames_at_start = cx.update(|cx| frames_presented(handle, cx));
        }
        let phase = (elapsed.as_secs_f32() / sweep_secs).fract();
        // Two separate updates: observers of the editor (its section views)
        // only hear about the move once the first update flushes its effects,
        // and nothing yields to the run loop in between, so the platform
        // cannot draw the frame before it is timed here.
        let move_started = Instant::now();
        let hovered = cx.update(|cx| {
            handle
                .update(cx, |view, window, cx| {
                    let x = pointer_x(f32::from(window.viewport_size().width), phase);
                    view.timeline_hover(x, window, cx);
                    if scrub {
                        let event = MouseMoveEvent {
                            position: point(px(x), px(0.)),
                            pressed_button: Some(MouseButton::Left),
                            ..Default::default()
                        };
                        view.timeline_mouse_move(&event, window, cx);
                    }
                })
                .is_ok()
        });
        let drawn = cx.update(|cx| draw_editor_window(handle, cx));
        if !hovered || drawn.is_none() {
            eprintln!("hover-bench: the editor window went away");
            std::process::exit(1);
        }
        if measuring {
            move_us.push(move_started.elapsed().as_secs_f64() * 1e6);
        }
    }
    let frames = cx
        .update(|cx| frames_presented(handle, cx))
        .zip(frames_at_start)
        .map(|(end, start)| end.saturating_sub(start));

    if scrub {
        cx.update(|cx| {
            handle
                .update(cx, |view, _, cx| view.window_mouse_up(cx))
                .ok()
        });
    }
    println!(
        "hover-bench: {}sidebar tab {}, pointer at {mouse_hz}Hz crossing the timeline in {sweep_secs}s, {} moves handled and {frames:?} preview frames presented in {:.1}s",
        if scrub { "ruler scrub, " } else { "" },
        std::env::var("CAP_GPUI_AUTO_SIDEBAR").unwrap_or_else(|_| "default".into()),
        move_us.len(),
        MEASURED.as_secs_f64(),
    );
    report("move", &mut move_us);
    std::process::exit(0);
}

fn frames_presented(handle: WindowHandle<EditorWindow>, cx: &mut App) -> Option<u64> {
    handle
        .update(cx, |view, _, _| view.preview_frames_presented())
        .ok()
        .flatten()
}

fn report(label: &str, samples: &mut [f64]) {
    if samples.is_empty() {
        println!("hover-bench: no {label} samples");
        return;
    }
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN draw times"));
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    let max = samples[samples.len() - 1];
    println!("hover-bench: {label} {mean:.1} mean / {p50:.1} p50 / {p95:.1} p95 / {max:.1} max us");
}

/// `AnyWindowHandle::update` hands over the root as an unleased `AnyView`;
/// the typed handle would lease the root entity that `draw()` re-renders.
fn draw_editor_window(handle: WindowHandle<EditorWindow>, cx: &mut App) -> Option<()> {
    gpui::AnyWindowHandle::from(handle)
        .update(cx, |_, window, cx| window.draw(cx).clear())
        .ok()
}
