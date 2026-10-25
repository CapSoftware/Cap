//! Needs a clip of at least 30 s so the `follow` scenario does not run off the
//! end. Run from `apps/desktop-gpui`:
//!   CAP_GPUI_AUTO_EDITOR=<studio .cap> CAP_GPUI_AUTO_TIMELINE_BENCH=1 \
//!     CAP_GPUI_NO_MENUS=1 CAP_GPUI_NO_TRAY=1 CAP_GPUI_MUTE_AUDIO=1 \
//!     cargo run --release

use std::time::{Duration, Instant};

use gpui::{AsyncApp, Context, Window, WindowHandle};

use crate::{
    draw_bench, editor_panels::FieldKey, editor_sidebar::SidebarTab, editor_timeline,
    editor_window::EditorWindow,
};

const WARMUP_FRAMES: usize = 60;
const MEASURED_FRAMES: usize = 300;
const FRAME_INTERVAL: Duration = Duration::from_millis(16);
const READY_POLL: Duration = Duration::from_millis(50);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const FOLLOW_ZOOM_SECS: f64 = 20.0;
const FOLLOW_START_FRACTION: f64 = 0.82;
/// A generated transcript for a few minutes of speech, every segment of which
/// has been selected once, so each has its three sidebar fields.
const SEEDED_CAPTION_SEGMENTS: usize = 300;

#[derive(Clone, Copy)]
enum Scenario {
    Tick,
    TickZoomedOut,
    Hover,
    Follow,
    Clean,
    CaptionDownload,
    TickFields,
}

impl Scenario {
    fn label(self) -> &'static str {
        match self {
            Self::Tick => "tick",
            Self::TickZoomedOut => "tick-zoomed-out",
            Self::Hover => "hover",
            Self::Follow => "follow",
            Self::Clean => "clean",
            Self::CaptionDownload => "caption-download",
            Self::TickFields => "tick-fields",
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
            Self::CaptionDownload => {
                if view.playing {
                    view.stop_for_measurement(cx);
                }
                view.sidebar.tab = SidebarTab::Captions;
                cx.notify();
            }
            Self::TickFields => {
                if view.playing {
                    view.stop_for_measurement(cx);
                }
                view.sidebar.tab = SidebarTab::Background;
                seed_caption_fields(view, window, cx);
                cx.notify();
                view.toggle_play(window, cx);
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
            Self::Tick | Self::TickZoomedOut | Self::Follow | Self::TickFields => {
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
            Self::CaptionDownload if self.control(iteration) => cx.notify(),
            Self::CaptionDownload => view.repaint_caption_download(cx),
        }
    }

    /// Frames interleaved with the measured ones as an in-process reference:
    /// a whole-editor notify, which is what a download tick used to cost.
    fn control(self, iteration: usize) -> bool {
        matches!(self, Self::CaptionDownload) && iteration % 2 == 1
    }
}

/// In memory only: the segments are never saved, and the fields are created
/// the way selecting each segment in turn would create them.
fn seed_caption_fields(
    view: &mut EditorWindow,
    window: &mut Window,
    cx: &mut Context<EditorWindow>,
) {
    let step = view.total_duration() / SEEDED_CAPTION_SEGMENTS as f64;
    let Some(timeline) = view.project.timeline.as_mut() else {
        return;
    };
    timeline.caption_segments = (0..SEEDED_CAPTION_SEGMENTS)
        .map(|index| cap_project::CaptionTrackSegment {
            id: format!("bench-{index}"),
            start: index as f64 * step,
            end: (index as f64 + 0.8) * step,
            text: format!("Caption line {index} with a handful of words"),
            words: Vec::new(),
            fade_duration_override: None,
            linger_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
        })
        .collect();
    for index in 0..SEEDED_CAPTION_SEGMENTS {
        for key in [
            FieldKey::CaptionText(index),
            FieldKey::CaptionStart(index),
            FieldKey::CaptionEnd(index),
        ] {
            view.ensure_field(key, window, cx);
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
        Scenario::CaptionDownload,
        Scenario::TickFields,
    ] {
        if handle
            .update(cx, |view, window, cx| scenario.prepare(view, window, cx))
            .is_err()
        {
            eprintln!("timeline-bench: the editor window closed");
            std::process::exit(1);
        }

        let mut draw_us = Vec::with_capacity(MEASURED_FRAMES);
        let mut control_us = Vec::new();
        let mut built = 0;
        let mut reused = 0;
        for iteration in 0..WARMUP_FRAMES + MEASURED_FRAMES {
            cx.background_executor().timer(FRAME_INTERVAL).await;
            // The step gets its own update so the notifies it queues for
            // observers (each editor section observes the editor) are flushed
            // into the timed draw instead of the next, untimed, frame.
            let before = handle
                .update(cx, |view, window, cx| {
                    scenario.step(iteration, view, window, cx);
                    view.waveform_cache_stats()
                })
                .ok();
            let elapsed = cx.update(|cx| {
                let before = before?;
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
                if scenario.control(iteration) {
                    control_us.push(elapsed.as_secs_f64() * 1e6);
                    continue;
                }
                draw_us.push(elapsed.as_secs_f64() * 1e6);
                built += draw_built;
                reused += draw_reused;
            }
        }

        if draw_us.len() + control_us.len() < MEASURED_FRAMES {
            eprintln!(
                "timeline-bench: only {} of {MEASURED_FRAMES} {} draws completed",
                draw_us.len() + control_us.len(),
                scenario.label()
            );
            std::process::exit(1);
        }
        draw_bench::report("timeline-bench", scenario.label(), &mut draw_us);
        if !control_us.is_empty() {
            let label = format!("{}-full-notify", scenario.label());
            draw_bench::report("timeline-bench", &label, &mut control_us);
        }
        println!(
            "timeline-bench: {} waveform paths built {built} / reused {reused} in {} timed draws",
            scenario.label(),
            draw_us.len()
        );
    }

    // The per-render field sync on its own, with the seeded fields in place.
    let mut sync_us = Vec::with_capacity(MEASURED_FRAMES);
    for iteration in 0..WARMUP_FRAMES + MEASURED_FRAMES {
        let Ok((elapsed, fields)) = handle.update(cx, |view, window, cx| {
            if view.playing {
                view.stop_for_measurement(cx);
            }
            let started = Instant::now();
            view.sync_fields(window, cx);
            (started.elapsed(), view.fields.len())
        }) else {
            eprintln!("timeline-bench: the editor window closed");
            std::process::exit(1);
        };
        if iteration == 0 {
            println!("timeline-bench: sync-fields over {fields} fields");
        }
        if iteration >= WARMUP_FRAMES {
            sync_us.push(elapsed.as_secs_f64() * 1e6);
        }
    }
    draw_bench::report("timeline-bench", "sync-fields", &mut sync_us);

    std::process::exit(0);
}
