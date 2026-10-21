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
    if let Ok(Some(specs)) = handle.update(cx, |_, window, _| window.gpu_specs()) {
        println!(
            "timeline-bench-gpu: {} / {} / {} software={}",
            specs.device_name, specs.driver_name, specs.driver_info, specs.is_software_emulated
        );
    }

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
        let stats = handle
            .update(cx, |view, _, _| view.pump_stats())
            .ok()
            .flatten();
        let mut measured_from = None;
        for iteration in 0..WARMUP_FRAMES + MEASURED_FRAMES {
            if iteration == WARMUP_FRAMES {
                measured_from = Some((
                    Instant::now(),
                    process_cpu_seconds(),
                    main_thread_cpu_seconds(),
                    stats.as_ref().map(|stats| stats.snapshot()),
                ));
            }
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
        if let Some((started, cpu_before, main_before, before)) = measured_from {
            let wall = started.elapsed().as_secs_f64();
            let cpu = process_cpu_seconds() - cpu_before;
            let main_cpu = main_thread_cpu_seconds() - main_before;
            let delta = match (stats.as_ref(), before) {
                (Some(stats), Some(before)) => Some(stats.snapshot().since(before)),
                _ => None,
            };
            println!(
                "timeline-bench-ab: {} presented={} rendered={} convert_avg_us={:.1} cpu_s={:.3} wall_s={:.3} cpu_pct={:.1} main_cpu_pct={:.1}",
                scenario.label(),
                delta.map_or(0, |delta| delta.presented),
                delta.map_or(0, |delta| delta.rendered),
                delta.map_or(0.0, |delta| delta.convert_micros()),
                cpu,
                wall,
                cpu / wall.max(0.001) * 100.0,
                main_cpu / wall.max(0.001) * 100.0,
            );
        }
        println!(
            "timeline-bench: {} waveform paths built {built} / reused {reused} in {} timed draws",
            scenario.label(),
            draw_us.len()
        );
    }

    std::process::exit(0);
}

#[cfg(unix)]
fn process_cpu_seconds() -> f64 {
    let mut usage = unsafe { std::mem::zeroed::<libc::rusage>() };
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let seconds = |time: libc::timeval| time.tv_sec as f64 + time.tv_usec as f64 / 1e6;
    seconds(usage.ru_utime) + seconds(usage.ru_stime)
}

#[cfg(windows)]
fn process_cpu_seconds() -> f64 {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentProcess, GetProcessTimes},
    };
    let mut creation = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut exit = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut kernel = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut user = unsafe { std::mem::zeroed::<FILETIME>() };
    unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    let seconds = |time: FILETIME| {
        ((time.dwHighDateTime as u64) << 32 | time.dwLowDateTime as u64) as f64 / 1e7
    };
    seconds(kernel) + seconds(user)
}

#[cfg(unix)]
fn main_thread_cpu_seconds() -> f64 {
    let mut time = unsafe { std::mem::zeroed::<libc::timespec>() };
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) };
    time.tv_sec as f64 + time.tv_nsec as f64 / 1e9
}

#[cfg(windows)]
fn main_thread_cpu_seconds() -> f64 {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        System::Threading::{GetCurrentThread, GetThreadTimes},
    };
    let mut creation = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut exit = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut kernel = unsafe { std::mem::zeroed::<FILETIME>() };
    let mut user = unsafe { std::mem::zeroed::<FILETIME>() };
    unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    let seconds = |time: FILETIME| {
        ((time.dwHighDateTime as u64) << 32 | time.dwLowDateTime as u64) as f64 / 1e7
    };
    seconds(kernel) + seconds(user)
}
