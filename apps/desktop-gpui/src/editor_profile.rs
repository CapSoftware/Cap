use std::io::Write as _;
use std::time::{Duration, Instant};

use gpui::{AsyncApp, WindowHandle};

use crate::{editor_window::EditorWindow, playback_probe};

const STEP: Duration = Duration::from_millis(16);

#[derive(Clone, Copy)]
enum Phase {
    Play,
    ScrubForward,
    ScrubBackward,
    ScrubHunt,
    Hover,
    Idle,
}

impl Phase {
    fn label(self) -> &'static str {
        match self {
            Self::Play => "play",
            Self::ScrubForward => "scrub-fwd",
            Self::ScrubBackward => "scrub-back",
            Self::ScrubHunt => "scrub-hunt",
            Self::Hover => "hover",
            Self::Idle => "idle",
        }
    }

    fn seconds(self) -> f64 {
        match self {
            Self::Play => 12.0,
            Self::Idle => 5.0,
            _ => 10.0,
        }
    }
}

fn hunt_position(t: f64) -> Option<f64> {
    let cycle = 1.4;
    let index = (t / cycle).floor();
    let local = t - index * cycle;
    let base = 0.1 + index * 0.06;
    if local < 0.3 {
        Some(base + 0.04 * local / 0.3)
    } else if local < 0.7 {
        None
    } else if local < 1.0 {
        Some(base + 0.04 - 0.025 * (local - 0.7) / 0.3)
    } else {
        None
    }
}

pub(crate) async fn run(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) {
    for phase in [
        Phase::Idle,
        Phase::Play,
        Phase::ScrubForward,
        Phase::ScrubBackward,
        Phase::ScrubHunt,
        Phase::Hover,
    ] {
        let _ = handle.update(cx, |view, window, cx| {
            view.bench_scrub_end(cx);
            if view.playing {
                view.stop_for_measurement(cx);
            }
            view.bench_zoom_to(view.total_duration(), cx);
            match phase {
                Phase::Play => {
                    view.seek_fraction(0.0, window, cx);
                }
                Phase::ScrubForward => view.bench_scrub_begin(0.05, window, cx),
                Phase::ScrubBackward => view.bench_scrub_begin(0.9, window, cx),
                Phase::ScrubHunt => view.bench_scrub_begin(0.1, window, cx),
                _ => {}
            }
        });
        cx.background_executor()
            .timer(Duration::from_millis(1500))
            .await;
        if matches!(phase, Phase::Play) {
            let _ = handle.update(cx, |view, window, cx| view.toggle_play(window, cx));
        }
        let _ = playback_probe::take_seek_latencies();
        println!("PROFILE-BEGIN {} {}", phase.label(), phase.seconds());
        let _ = std::io::stdout().flush();

        let gpui_before = playback_probe::snapshot();
        let render_before = cap_rendering::probe::snapshot();
        let main_before = cx.update(|_| playback_probe::thread_cpu_ns());
        let process_before = playback_probe::process_cpu_ns();
        let started = Instant::now();
        let mut step = 0u64;
        while started.elapsed().as_secs_f64() < phase.seconds() {
            cx.background_executor().timer(STEP).await;
            step += 1;
            let t = started.elapsed().as_secs_f64();
            let progress = t / phase.seconds();
            let _ = handle.update(cx, |view, window, cx| match phase {
                Phase::ScrubForward => view.bench_scrub_to(0.05 + 0.85 * progress, window, cx),
                Phase::ScrubBackward => view.bench_scrub_to(0.9 - 0.85 * progress, window, cx),
                Phase::ScrubHunt => {
                    if let Some(fraction) = hunt_position(t) {
                        view.bench_scrub_to(fraction, window, cx);
                    }
                }
                Phase::Hover => {
                    let viewport_width: f32 = window.viewport_size().width.into();
                    let x = crate::editor_timeline::content_left()
                        + crate::editor_timeline::content_width(viewport_width)
                            * (0.1 + 0.8 * progress) as f32;
                    view.timeline_hover(x, window, cx);
                }
                Phase::Play | Phase::Idle => {}
            });
        }
        let wall = started.elapsed().as_secs_f64();
        let main_after = cx.update(|_| playback_probe::thread_cpu_ns());
        let process_after = playback_probe::process_cpu_ns();
        let gpui_after = playback_probe::snapshot();
        let render_after = cap_rendering::probe::snapshot();
        let (satisfied, mut latencies) = playback_probe::take_seek_latencies();
        latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let pct = |q: f64| {
            if latencies.is_empty() {
                0.0
            } else {
                latencies[((latencies.len() as f64 * q) as usize).min(latencies.len() - 1)] / 1000.0
            }
        };
        let mut line = format!(
            "profile: {} wall_s={wall:.2} steps={step} cpu_pct={:.1} main_cpu_pct={:.1}",
            phase.label(),
            (process_after - process_before) as f64 / 1e9 / wall * 100.0,
            (main_after - main_before) as f64 / 1e9 / wall * 100.0,
        );
        for (index, name) in playback_probe::NAMES.iter().enumerate() {
            line.push_str(&format!(" {name}={}", gpui_after[index] - gpui_before[index]));
        }
        for (index, name) in cap_rendering::probe::NAMES.iter().enumerate() {
            line.push_str(&format!(" {name}={}", render_after[index] - render_before[index]));
        }
        line.push_str(&format!(
            " seek_satisfied={satisfied} seek_p50_ms={:.1} seek_p95_ms={:.1} seek_max_ms={:.1}",
            pct(0.5),
            pct(0.95),
            pct(1.0)
        ));
        println!("{line}");
        println!("PROFILE-END {}", phase.label());
        let _ = std::io::stdout().flush();
    }
}
