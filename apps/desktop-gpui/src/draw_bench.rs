use std::time::{Duration, Instant};

use gpui::{AnyWindowHandle, App};

/// One synchronous `Window::draw`, timed. `AnyWindowHandle::update` passes the
/// root as an unleased `AnyView`; the typed handle would lease the root entity
/// that `draw()` re-renders.
pub(crate) fn timed_draw(handle: AnyWindowHandle, cx: &mut App) -> Option<Duration> {
    handle
        .update(cx, |_, window, cx| {
            let started = Instant::now();
            window.draw(cx).clear();
            started.elapsed()
        })
        .ok()
}

pub(crate) fn report(prefix: &str, label: &str, samples: &mut [f64]) {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN draw times"));
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    let max = samples[samples.len() - 1];
    println!("{prefix}: {label} {mean:.1} mean / {p50:.1} p50 / {p95:.1} p95 / {max:.1} max us");
}
