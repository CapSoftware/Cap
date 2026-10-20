//! Needs a clip of at least 30 s so the `follow` scenario does not run off the
//! end. Run from `apps/desktop-gpui`:
//!   CAP_GPUI_AUTO_EDITOR=<studio .cap> CAP_GPUI_AUTO_TIMELINE_BENCH=1 \
//!     CAP_GPUI_NO_MENUS=1 CAP_GPUI_NO_TRAY=1 CAP_GPUI_MUTE_AUDIO=1 \
//!     cargo run --release

use std::time::{Duration, Instant};

use gpui::{AsyncApp, Context, Window, WindowHandle};

use crate::{draw_bench, editor_timeline, editor_window::EditorWindow};

const WARMUP_FRAMES: usize = 60;
const MEASURED_FRAMES: usize = 300;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const READY_POLL: Duration = Duration::from_millis(50);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const FOLLOW_ZOOM_SECS: f64 = 20.0;
const FOLLOW_START_FRACTION: f64 = 0.82;

#[derive(Clone, Copy)]
enum Scenario {
    Tick,
    TickZoomedOut,
    Hover,
    Follow,
    Clean,
}

impl Scenario {
    fn label(self) -> &'static str {
        match self {
            Self::Tick => "tick",
            Self::TickZoomedOut => "tick-zoomed-out",
            Self::Hover => "hover",
            Self::Follow => "follow",
            Self::Clean => "clean",
        }
    }

    fn prepare(self, view: &mut EditorWindow, window: &mut Window, cx: &mut Context<EditorWindow>) {
        match self {
            Self::Tick => {
                if !view.playing {
                    view.toggle_play(window, cx);
                }
            }
            Self::TickZoomedOut => {
                view.bench_zoom_to(view.total_duration(), cx);
                if !view.playing {
                    view.toggle_play(window, cx);
                }
            }
            Self::Hover => {
                if view.playing {
                    view.stop_for_measurement(cx);
                }
                view.bench_zoom_to(view.total_duration(), cx);
                view.seek_fraction(0., window, cx);
            }
            Self::Follow => {
                if view.playing {
                    view.stop_for_measurement(cx);
                }
                view.bench_zoom_to(FOLLOW_ZOOM_SECS, cx);
                view.seek_fraction(FOLLOW_START_FRACTION, window, cx);
                view.toggle_play(window, cx);
            }
            Self::Clean => {
                if view.playing {
                    view.stop_for_measurement(cx);
                }
                view.bench_zoom_to(view.total_duration(), cx);
            }
        }
    }

    fn step(
        self,
        iteration: usize,
        view: &mut EditorWindow,
        window: &mut Window,
        cx: &mut Context<EditorWindow>,
    ) {
        match self {
            Self::Tick | Self::TickZoomedOut | Self::Follow => {
                view.invalidate_playback_chrome(window, cx)
            }
            Self::Hover => {
                let viewport_width: f32 = window.viewport_size().width.into();
                let fraction = iteration as f32 / (WARMUP_FRAMES + MEASURED_FRAMES) as f32;
                let x = editor_timeline::content_left()
                    + editor_timeline::content_width(viewport_width) * fraction;
                view.timeline_hover(x, window, cx);
            }
            Self::Clean => {}
        }
    }
}

pub(crate) async fn run(handle: WindowHandle<EditorWindow>, cx: &mut AsyncApp) {
    if !std::env::var("CAP_GPUI_AUTO_TIMELINE_BENCH").is_ok_and(|value| value == "1") {
        return;
    }

    let started = Instant::now();
    loop {
        let ready = handle
            .update(cx, |view, _, _| {
                let (mic, system) = view.has_waveforms();
                view.latest_frame.is_some() && (mic || system)
            })
            .unwrap_or(false);
        if ready {
            break;
        }
        if started.elapsed() > READY_TIMEOUT {
            eprintln!(
                "timeline-bench: no rendered frame and waveforms within {}s",
                READY_TIMEOUT.as_secs()
            );
            std::process::exit(1);
        }
        cx.background_executor().timer(READY_POLL).await;
    }

    let Ok(header) = handle.update(cx, |view, window, _| {
        let viewport_width: f32 = window.viewport_size().width.into();
        let content_width = editor_timeline::content_width(viewport_width);
        let (mic, system) = view.has_waveforms();
        format!(
            "timeline-bench: viewport {viewport_width:.0}px, content {content_width:.0}px, \
             clip {:.1}s, mic {mic}, system {system}, target {} samples/path",
            view.total_duration(),
            editor_timeline::waveform_sample_count(f64::from(content_width)),
        )
    }) else {
        eprintln!("timeline-bench: the editor window closed");
        std::process::exit(1);
    };
    println!("{header}");

    for scenario in [
        Scenario::Tick,
        Scenario::TickZoomedOut,
        Scenario::Hover,
        Scenario::Follow,
        Scenario::Clean,
    ] {
        if handle
            .update(cx, |view, window, cx| scenario.prepare(view, window, cx))
            .is_err()
        {
            eprintln!("timeline-bench: the editor window closed");
            std::process::exit(1);
        }

        let mut draw_us = Vec::with_capacity(MEASURED_FRAMES);
        let mut built = 0;
        let mut reused = 0;
        for iteration in 0..WARMUP_FRAMES + MEASURED_FRAMES {
            cx.background_executor().timer(FRAME_INTERVAL).await;
            let elapsed = cx.update(|cx| {
                let before = handle
                    .update(cx, |view, window, cx| {
                        scenario.step(iteration, view, window, cx);
                        view.waveform_cache_stats()
                    })
                    .ok()?;
                let elapsed = draw_bench::timed_draw(handle.into(), cx)?;
                let after = handle
                    .update(cx, |view, _, _| view.waveform_cache_stats())
                    .ok()?;
                Some((
                    elapsed,
                    after.builds.saturating_sub(before.builds),
                    after.hits.saturating_sub(before.hits),
                ))
            });
            if iteration >= WARMUP_FRAMES
                && let Some((elapsed, draw_built, draw_reused)) = elapsed
            {
                draw_us.push(elapsed.as_secs_f64() * 1e6);
                built += draw_built;
                reused += draw_reused;
            }
        }

        if draw_us.len() < MEASURED_FRAMES {
            eprintln!(
                "timeline-bench: only {} of {MEASURED_FRAMES} {} draws completed",
                draw_us.len(),
                scenario.label()
            );
            std::process::exit(1);
        }
        draw_bench::report("timeline-bench", scenario.label(), &mut draw_us);
        println!(
            "timeline-bench: {} waveform paths built {built} / reused {reused} in {} timed draws",
            scenario.label(),
            draw_us.len()
        );
    }

    std::process::exit(0);
}
