//! `CAP_GPUI_AUTO_LATENCY_BENCH=1` (with `CAP_GPUI_AUTO_EDITOR`): input to
//! paint latency of the editor preview, per interaction, from the marks
//! [`crate::editor_latency`] records. `CAP_GPUI_AUTO_LATENCY_SCENARIOS` picks a
//! comma list of `playback,scrub-fast,scrub-fine,zoom-drag,preset,slider,resize,pause`
//! (default all). Pointer scenarios post moves at 120 Hz through the timeline's
//! own handlers, like `CAP_GPUI_AUTO_HOVER_BENCH`.
//!
//! Run:
//!   CAP_GPUI_AUTO_EDITOR=<project.cap> CAP_GPUI_AUTO_LATENCY_BENCH=1 \
//!     CAP_GPUI_NO_MENUS=1 CAP_GPUI_NO_TRAY=1 CAP_GPUI_MUTE_AUDIO=1 \
//!     cargo run --release
//!
//! Half against Full, same project and scenarios, from `apps/desktop-gpui`:
//!   cargo run --release -- --preview-compare <project.cap>
//!
//! That runs `playback,pause` at `half` then `full`, five times, and swaps
//! which quality goes first on each repeat. It prints the adapter, playback
//! frames per second, and `playback_frame_latency_p95_ms` (render callback to
//! paint over the steady window). `pause_frame_latency_p95_ms` is the pause
//! to a canvas-sized frame. `--preview-compare-repeats`,
//! `--preview-compare-scenarios`, and `--preview-compare-qualities` override
//! those. The `build=` line is `release` or `dev`. A `dev` build leaves this
//! crate unoptimized, so its frame rate is not the shipping cost. The command
//! does not write the saved preview quality, and it does not change
//! [`crate::store::EditorPreviewQuality::for_this_machine`].

use std::time::{Duration, Instant};

use gpui::{AsyncApp, MouseButton, MouseDownEvent, MouseMoveEvent, WindowHandle, point, px, size};

use crate::{
    draw_bench,
    editor_latency::{self, Mark, Presentation, Stage},
    editor_sidebar::{BgSlider, SliderKey},
    editor_timeline::{self, TrackKind},
    editor_window::EditorWindow,
    store::SettingsEnum,
};

const DISPLAY_INTERVAL_MS: f64 = 1000.0 / 60.0;
const POINTER_HZ: u64 = 120;
const SETTLE: Duration = Duration::from_millis(600);
const PLAYBACK: Duration = Duration::from_secs(10);
const PLAYBACK_WARMUP: Duration = Duration::from_secs(1);
const DRAG: Duration = Duration::from_secs(4);
const PRESET_CLICKS: usize = 40;
const PRESET_GAP: Duration = Duration::from_millis(150);
const RESIZE_STEPS: usize = 120;
const PAUSE_ROUNDS: usize = 5;
const PAUSE_PLAY: Duration = Duration::from_millis(1500);
const PAUSE_SETTLE: Duration = Duration::from_secs(2);

type Handle = WindowHandle<EditorWindow>;

pub(crate) async fn run(handle: Handle, cx: &mut AsyncApp) {
    if !editor_latency::probe_enabled() {
        return;
    }
    let compare = std::env::var("CAP_GPUI_AUTO_PREVIEW_COMPARE").is_ok_and(|value| value == "1");
    let scenarios = std::env::var("CAP_GPUI_AUTO_LATENCY_SCENARIOS").unwrap_or_else(|_| {
        if compare {
            "playback,pause".into()
        } else {
            "playback,scrub-fast,scrub-fine,zoom-drag,preset,slider,resize,pause".into()
        }
    });

    let started = Instant::now();
    loop {
        let ready = handle
            .update(cx, |view, _, _| view.latest_frame.is_some())
            .unwrap_or(false);
        if ready {
            break;
        }
        if started.elapsed() > Duration::from_secs(60) {
            eprintln!("latency-bench: no rendered frame within 60s");
            std::process::exit(1);
        }
        wait(cx, Duration::from_millis(50)).await;
    }
    cx.update(|cx| {
        cx.activate(true);
        handle
            .update(cx, |_, window, _| window.activate_window())
            .ok();
    });
    wait(cx, Duration::from_secs(2)).await;
    let Some(header) = cx.update(|cx| {
        handle
            .update(cx, |view, window, _| {
                let viewport = window.viewport_size();
                format!(
                    "latency-bench: viewport {:.0}x{:.0}, scale {:.1}, timeline {:.1}s, {} zoom segments",
                    f32::from(viewport.width),
                    f32::from(viewport.height),
                    window.scale_factor(),
                    view.total_duration(),
                    view.bench_zoom_count(),
                )
            })
            .ok()
    }) else {
        exit_closed();
    };
    println!("{header}");
    memory_report("start");

    if compare {
        let failed = run_compare(handle, cx, &scenarios).await;
        std::process::exit(if failed { 1 } else { 0 });
    }

    for scenario in scenarios.split(',').map(str::trim) {
        match scenario {
            "playback" => {
                playback(handle, cx).await;
            }
            "scrub-fast" => scrub(handle, cx, "scrub-fast", 0.1, 0.6).await,
            "scrub-fine" => scrub(handle, cx, "scrub-fine", 0.3, 0.302).await,
            "zoom-drag" => zoom_drag(handle, cx).await,
            "preset" => preset(handle, cx).await,
            "slider" => slider(handle, cx).await,
            "resize" => resize(handle, cx).await,
            "pause" => {
                pause(handle, cx).await;
            }
            other => eprintln!("latency-bench: unknown scenario {other}"),
        }
        memory_report(scenario);
    }
    std::process::exit(0);
}

fn exit_closed() -> ! {
    eprintln!("latency-bench: the editor window closed");
    std::process::exit(1);
}

async fn wait(cx: &AsyncApp, duration: Duration) {
    cx.background_executor().timer(duration).await;
}

fn update<R>(
    handle: Handle,
    cx: &mut AsyncApp,
    f: impl FnOnce(&mut EditorWindow, &mut gpui::Window, &mut gpui::Context<EditorWindow>) -> R,
) -> R {
    match handle.update(cx, f) {
        Ok(value) => value,
        Err(_) => exit_closed(),
    }
}

async fn pause_at(handle: Handle, cx: &mut AsyncApp, fraction: f64) {
    update(handle, cx, |view, window, cx| {
        if view.playing {
            view.stop_for_measurement(cx);
        }
        view.bench_zoom_to(view.total_duration(), cx);
        view.seek_fraction(fraction, window, cx);
    });
    wait(cx, SETTLE).await;
}

async fn paced_inputs(
    handle: Handle,
    cx: &mut AsyncApp,
    hz: u64,
    duration: Duration,
    mut step: impl FnMut(f32, &mut EditorWindow, &mut gpui::Window, &mut gpui::Context<EditorWindow>),
) {
    let interval = Duration::from_micros(1_000_000 / hz);
    let started = Instant::now();
    let mut next = started;
    loop {
        next += interval;
        let now = Instant::now();
        if next > now {
            wait(cx, next.saturating_duration_since(now)).await;
        } else {
            next = now;
            tokio::task::yield_now().await;
        }
        let elapsed = started.elapsed();
        if elapsed >= duration {
            break;
        }
        let phase = elapsed.as_secs_f32() / duration.as_secs_f32();
        editor_latency::mark(Stage::Input, 0, 0);
        update(handle, cx, |view, window, cx| step(phase, view, window, cx));
    }
}

async fn playback(handle: Handle, cx: &mut AsyncApp) -> editor_latency::PlaybackStats {
    pause_at(handle, cx, 0.1).await;
    editor_latency::take();
    editor_latency::take_sizes();
    let before = update(handle, cx, |view, _, _| view.bench_pump_snapshot());
    let pressed = Instant::now();
    update(handle, cx, |view, window, cx| view.toggle_play(window, cx));
    wait(cx, PLAYBACK).await;
    update(handle, cx, |view, _, cx| view.stop_for_measurement(cx));
    let pump = update(handle, cx, |view, _, _| view.bench_pump_snapshot())
        .zip(before)
        .map(|(after, before)| after.since(before));
    wait(cx, SETTLE).await;
    let marks = editor_latency::take();
    let sizes = editor_latency::take_sizes();
    let (shown, replaced) = editor_latency::presentations(&marks);
    let first = shown
        .first()
        .map(|presentation| editor_latency::millis(pressed, presentation.painted));
    let stats = editor_latency::playback_stats(
        &marks,
        &sizes,
        pressed + PLAYBACK_WARMUP,
        pressed + PLAYBACK,
    );
    let window_secs = PLAYBACK.saturating_sub(PLAYBACK_WARMUP).as_secs_f64();
    let repeats = stats
        .steady
        .windows(2)
        .filter(|pair| pair[1].frame <= pair[0].frame)
        .count();
    let mut intervals = intervals(&stats.steady);
    let late = intervals
        .iter()
        .filter(|interval| **interval > DISPLAY_INTERVAL_MS * 1.5)
        .count();
    println!(
        "latency-bench: playback first-frame {} ms, {:.1} fps presented over {window_secs:.0}s, \
         {} source frames skipped, {repeats} out of order, {late} intervals over 25 ms, \
         {replaced} replaced before paint, pump dropped {}",
        first.map_or("-".into(), |ms| format!("{ms:.1}")),
        stats.fps,
        stats.skipped,
        pump.map_or(0, |pump| pump.dropped),
    );
    report("playback", "present interval", &mut intervals);
    stage_report("playback", &stats.steady);
    stats
}

async fn scrub(handle: Handle, cx: &mut AsyncApp, label: &str, from: f64, to: f64) {
    pause_at(handle, cx, from).await;
    let x_at = |window: &gpui::Window, fraction: f64| {
        let width: f32 = window.viewport_size().width.into();
        editor_timeline::content_left()
            + editor_timeline::content_width(width) * fraction.clamp(0.0, 1.0) as f32
    };
    update(handle, cx, |view, window, cx| {
        let event = MouseDownEvent {
            button: MouseButton::Left,
            position: point(px(x_at(window, from)), px(0.)),
            click_count: 1,
            ..Default::default()
        };
        view.timeline_mouse_down(&event, true, window, cx);
    });
    wait(cx, SETTLE).await;
    editor_latency::take();
    paced_inputs(handle, cx, POINTER_HZ, DRAG, |phase, view, window, cx| {
        let sweep = if phase < 0.5 {
            phase * 2.0
        } else {
            2.0 - phase * 2.0
        };
        let fraction = from + (to - from) * f64::from(sweep);
        let event = MouseMoveEvent {
            position: point(px(x_at(window, fraction)), px(0.)),
            pressed_button: Some(MouseButton::Left),
            ..Default::default()
        };
        view.timeline_mouse_move(&event, window, cx);
    })
    .await;
    update(handle, cx, |view, _, cx| view.window_mouse_up(cx));
    wait(cx, SETTLE).await;
    interaction_report(label, &editor_latency::take());
}

async fn zoom_drag(handle: Handle, cx: &mut AsyncApp) {
    let Some(index) = update(handle, cx, |view, _, _| {
        let count = view.bench_zoom_count();
        (count > 0).then_some(count / 2)
    }) else {
        println!("latency-bench: zoom-drag skipped, the project has no zoom segments");
        return;
    };
    let Some((start, end)) = update(handle, cx, |view, _, _| view.bench_zoom_segment(index)) else {
        return;
    };
    update(handle, cx, |view, window, cx| {
        if view.playing {
            view.stop_for_measurement(cx);
        }
        view.seek_to_time(end, cx);
        view.bench_zoom_to(((end - start) * 4.0).max(8.0), cx);
        window.refresh();
    });
    wait(cx, SETTLE).await;
    let Some((lane, x)) = update(handle, cx, |view, window, _| {
        view.bench_zoom_end_handle(index, window.viewport_size().width.into())
    }) else {
        println!("latency-bench: zoom-drag skipped, the segment end is off screen");
        return;
    };
    update(handle, cx, |view, window, cx| {
        let event = MouseDownEvent {
            button: MouseButton::Left,
            position: point(px(x), px(0.)),
            click_count: 1,
            ..Default::default()
        };
        view.track_mouse_down(TrackKind::Zoom, lane, &event, window, cx);
        view.drag_mouse_move(x - 6., true, window, cx);
    });
    wait(cx, SETTLE).await;
    editor_latency::take();
    paced_inputs(handle, cx, POINTER_HZ, DRAG, |phase, view, window, cx| {
        let offset = (phase * std::f32::consts::TAU * 2.0).sin() * 60.0;
        view.drag_mouse_move(x - 6. - offset.abs(), true, window, cx);
    })
    .await;
    update(handle, cx, |view, window, cx| {
        view.drag_mouse_up(window, cx);
        view.undo(window, cx);
    });
    wait(cx, SETTLE).await;
    interaction_report("zoom-drag", &editor_latency::take());
}

async fn preset(handle: Handle, cx: &mut AsyncApp) {
    pause_at(handle, cx, 0.4).await;
    let (original, alternate) = update(handle, cx, |view, _, _| {
        (
            view.project.clone(),
            crate::presets::default_project_config(&view.project),
        )
    });
    editor_latency::take();
    for click in 0..PRESET_CLICKS {
        let next = if click % 2 == 0 {
            alternate.clone()
        } else {
            original.clone()
        };
        editor_latency::mark(Stage::Input, 0, 0);
        update(handle, cx, |view, window, cx| {
            view.apply_project_preset(next, window, cx)
        });
        wait(cx, PRESET_GAP).await;
    }
    update(handle, cx, |view, window, cx| {
        view.apply_project_preset(original, window, cx)
    });
    wait(cx, SETTLE).await;
    interaction_report("preset", &editor_latency::take());
}

async fn slider(handle: Handle, cx: &mut AsyncApp) {
    pause_at(handle, cx, 0.45).await;
    let original = update(handle, cx, |view, _, _| view.project.clone());
    let padding = SliderKey::Bg(BgSlider::Padding);
    update(handle, cx, |view, _, _| view.bench_slider_press(padding));
    editor_latency::take();
    paced_inputs(handle, cx, POINTER_HZ, DRAG, |phase, view, window, cx| {
        let value = 2.0 + 38.0 * (phase * std::f32::consts::PI).sin();
        view.bench_slider_move(padding, value, window, cx);
    })
    .await;
    wait(cx, SETTLE).await;
    let marks = editor_latency::take();
    update(handle, cx, |view, _, cx| view.sidebar_mouse_up(cx));
    update(handle, cx, |view, window, cx| {
        view.apply_project_preset(original, window, cx)
    });
    wait(cx, SETTLE).await;
    interaction_report("slider", &marks);
}

async fn resize(handle: Handle, cx: &mut AsyncApp) {
    pause_at(handle, cx, 0.5).await;
    let base = update(handle, cx, |_, window, _| window.viewport_size());
    let mut draws = Vec::with_capacity(RESIZE_STEPS);
    let mut frames = Vec::with_capacity(RESIZE_STEPS);
    for step in 0..RESIZE_STEPS {
        let phase = (step as f32 / RESIZE_STEPS as f32 * std::f32::consts::TAU)
            .sin()
            .abs();
        let target = size(
            base.width - px(320. * phase),
            base.height - px(180. * phase),
        );
        wait(cx, Duration::from_micros(16_667)).await;
        update(handle, cx, |_, window, _| window.resize(target));
        let drawn = cx.update(|cx| {
            let elapsed = draw_bench::timed_draw(handle.into(), cx)?;
            let frame = handle
                .update(cx, |view, _, _| view.preview_frames_presented())
                .ok()
                .flatten();
            Some((elapsed, frame))
        });
        let Some((elapsed, frame)) = drawn else {
            exit_closed();
        };
        draws.push(elapsed.as_secs_f64() * 1000.0);
        frames.push(frame);
    }
    update(handle, cx, |_, window, _| window.resize(base));
    wait(cx, SETTLE).await;
    let rerendered = frames
        .first()
        .copied()
        .flatten()
        .zip(frames.last().copied().flatten())
        .map(|(first, last)| last.saturating_sub(first));
    println!(
        "latency-bench: resize {RESIZE_STEPS} steps up to -320x-180 px, {} preview re-renders",
        rerendered.map_or("-".into(), |count| count.to_string())
    );
    report("resize", "draw", &mut draws);
}

/// Play, pause, and time how long the paused frame takes to be drawn at the
/// canvas's own device-pixel size. A build that never re-renders on pause
/// reports the size it settles at instead.
async fn pause(handle: Handle, cx: &mut AsyncApp) -> PauseMeasure {
    let mut to_sharp = Vec::with_capacity(PAUSE_ROUNDS);
    for round in 0..PAUSE_ROUNDS {
        pause_at(handle, cx, 0.2 + 0.12 * round as f64).await;
        update(handle, cx, |view, window, cx| view.toggle_play(window, cx));
        wait(cx, PAUSE_PLAY).await;
        editor_latency::take();
        editor_latency::take_sizes();
        let paused = Instant::now();
        update(handle, cx, |view, _, cx| view.stop_for_measurement(cx));
        wait(cx, PAUSE_SETTLE).await;
        let marks = editor_latency::take();
        let sizes: std::collections::HashMap<u64, [u32; 2]> =
            editor_latency::take_sizes().into_iter().collect();
        let Some(canvas) = update(handle, cx, |view, window, _| {
            view.bench_preview_canvas(window)
        }) else {
            println!("latency-bench: pause skipped, the preview has no canvas");
            return PauseMeasure::NoCanvas;
        };
        let mut seen = std::collections::HashSet::new();
        let painted: Vec<(Instant, [u32; 2])> = marks
            .iter()
            .filter(|mark| mark.stage == Stage::Painted && mark.at >= paused)
            .filter(|mark| seen.insert(mark.sequence))
            .filter_map(|mark| sizes.get(&mark.sequence).map(|size| (mark.at, *size)))
            .collect();
        let covers =
            |size: [u32; 2]| size[0] * 100 >= canvas[0] * 98 || size[1] * 100 >= canvas[1] * 98;
        let sharp = painted
            .iter()
            .find(|(_, size)| covers(*size))
            .map(|(at, _)| editor_latency::millis(paused, *at));
        let settled = painted.last().map(|(_, size)| *size);
        if let Some(ms) = sharp {
            to_sharp.push(ms);
        }
        println!(
            "latency-bench: pause round {round} canvas {}x{} device px, settled frame {}, \
             magnified {}, canvas-size frame {} after pause, {} presentations",
            canvas[0],
            canvas[1],
            settled.map_or("-".into(), |size| format!("{}x{}", size[0], size[1])),
            settled.map_or("-".into(), |size| format!(
                "{:.2}x",
                canvas[0] as f64 / f64::from(size[0].max(1))
            )),
            sharp.map_or("never".into(), |ms| format!("{ms:.1} ms")),
            painted.len(),
        );
        if round + 1 == PAUSE_ROUNDS {
            screenshot(handle, cx);
            save_frame(handle, cx);
        }
    }
    let latency = editor_latency::percentiles(&mut to_sharp.clone()).map(|rank| rank[1]);
    report("pause", "pause->canvas-size frame", &mut to_sharp);
    PauseMeasure::Latency(latency)
}

/// `CAP_GPUI_AUTO_LATENCY_SHOT=<png>`: capture the screen with the settled
/// preview on it and print where the preview sits, so before and after crops
/// show what the display really drew.
fn screenshot(handle: Handle, cx: &mut AsyncApp) {
    let Some(path) = std::env::var("CAP_GPUI_AUTO_LATENCY_SHOT")
        .ok()
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    let Some(rect) = update(handle, cx, |view, window, _| {
        let frame = view.player_frame_rect.get()?.frame;
        let origin = window.bounds().origin;
        Some([
            f32::from(origin.x + frame.origin.x),
            f32::from(origin.y + frame.origin.y),
            f32::from(frame.size.width),
            f32::from(frame.size.height),
        ])
    }) else {
        return;
    };
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("screencapture")
            .args(["-x", &path])
            .status()
    } else {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".into());
        std::process::Command::new("ffmpeg")
            .args(["-v", "error", "-y", "-f", "x11grab", "-i", &display])
            .args(["-frames:v", "1", &path])
            .status()
    };
    println!(
        "latency-bench: screenshot preview at {:.0},{:.0} {:.0}x{:.0} pt -> {path} ({status:?})",
        rect[0], rect[1], rect[2], rect[3]
    );
}

/// `CAP_GPUI_AUTO_LATENCY_FRAME=<png>`: write the settled preview frame at
/// the size it was rendered, before the compositor scales it to the canvas.
fn save_frame(handle: Handle, cx: &mut AsyncApp) {
    let Some(path) = std::env::var("CAP_GPUI_AUTO_LATENCY_FRAME")
        .ok()
        .filter(|path| !path.is_empty())
    else {
        return;
    };
    let Some(frame) = update(handle, cx, |view, _, _| view.latest_frame.clone()) else {
        return;
    };
    let Some((width, height, mut pixels)) = frame_bgra(&frame) else {
        println!("latency-bench: frame could not be read");
        return;
    };
    for pixel in pixels.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    let saved = image::RgbaImage::from_raw(width, height, pixels)
        .map(|image| image.save(&path).is_ok())
        .unwrap_or(false);
    println!("latency-bench: frame {width}x{height} -> {path} (saved {saved})");
}

fn frame_bgra(frame: &crate::editor_window::EditorPreviewFrame) -> Option<(u32, u32, Vec<u8>)> {
    match frame {
        crate::editor_window::EditorPreviewFrame::Image(image) => {
            let size = image.size(0);
            Some((
                size.width.0 as u32,
                size.height.0 as u32,
                image.as_bytes(0)?.to_vec(),
            ))
        }
        #[cfg(not(target_os = "macos"))]
        crate::editor_window::EditorPreviewFrame::Stream(stream) => {
            let frame = stream.current()?;
            let (width, height) = (
                frame.size().width.0 as usize,
                frame.size().height.0 as usize,
            );
            let pixels = cap_gpui_kernels::frame::unpad_rgba_to_bgra(
                frame.bytes(),
                width,
                frame.stride(),
                height,
            )?;
            Some((width as u32, height as u32, pixels))
        }
        #[cfg(target_os = "macos")]
        crate::editor_window::EditorPreviewFrame::Surface(buffer) => {
            use core_video::pixel_buffer::kCVPixelBufferLock_ReadOnly;
            if buffer.lock_base_address(kCVPixelBufferLock_ReadOnly) != 0 {
                return None;
            }
            let (width, height, stride) = (
                buffer.get_width(),
                buffer.get_height(),
                buffer.get_bytes_per_row(),
            );
            let base = unsafe { buffer.get_base_address() }.cast::<u8>();
            let mut pixels = Vec::with_capacity(width * height * 4);
            if !base.is_null() {
                for row in 0..height {
                    let line =
                        unsafe { std::slice::from_raw_parts(base.add(row * stride), width * 4) };
                    pixels.extend_from_slice(line);
                }
            }
            buffer.unlock_base_address(kCVPixelBufferLock_ReadOnly);
            (!base.is_null()).then_some((width as u32, height as u32, pixels))
        }
    }
}

fn memory_report(label: &str) {
    let format = |mb: Option<f64>| mb.map_or("-".into(), |mb| format!("{mb:.1} MB"));
    println!(
        "latency-bench: memory after {label} gpu {}, footprint {}",
        format(gpu_mb()),
        format(footprint_mb())
    );
}

#[cfg(target_os = "macos")]
fn gpu_mb() -> Option<f64> {
    use objc2::{msg_send, runtime::AnyObject};
    let device = cidre::mtl::Device::sys_default()?;
    let object = std::ptr::from_ref::<cidre::mtl::Device>(&device).cast::<AnyObject>();
    let bytes: usize = unsafe { msg_send![&*object, currentAllocatedSize] };
    Some(bytes as f64 / 1_048_576.0)
}

#[cfg(not(target_os = "macos"))]
fn gpu_mb() -> Option<f64> {
    None
}

#[cfg(target_os = "macos")]
fn footprint_mb() -> Option<f64> {
    let mut info = std::mem::MaybeUninit::<libc::rusage_info_v2>::zeroed();
    let status = unsafe {
        libc::proc_pid_rusage(
            std::process::id() as i32,
            libc::RUSAGE_INFO_V2,
            info.as_mut_ptr().cast(),
        )
    };
    (status == 0).then(|| unsafe { info.assume_init() }.ri_phys_footprint as f64 / 1_048_576.0)
}

#[cfg(not(target_os = "macos"))]
fn footprint_mb() -> Option<f64> {
    None
}

fn intervals(shown: &[Presentation]) -> Vec<f64> {
    shown
        .windows(2)
        .map(|pair| editor_latency::millis(pair[0].painted, pair[1].painted))
        .collect()
}

fn interaction_report(label: &str, marks: &[Mark]) {
    let (shown, replaced) = editor_latency::presentations(marks);
    let outcomes = editor_latency::input_outcomes(marks, &shown);
    let with_target = outcomes
        .iter()
        .filter(|outcome| outcome.target.is_some())
        .count();
    let answered: Vec<_> = outcomes
        .iter()
        .filter_map(|outcome| outcome.shown.map(|shown| (outcome.at, shown)))
        .collect();
    let superseded = outcomes.iter().filter(|outcome| outcome.superseded).count();
    let inputs: Vec<Instant> = marks
        .iter()
        .filter(|mark| mark.stage == Stage::Input)
        .map(|mark| mark.at)
        .collect();
    let stale = shown
        .iter()
        .filter(|presentation| {
            inputs.iter().any(|input| {
                *input < presentation.painted
                    && editor_latency::millis(*input, presentation.painted) > DISPLAY_INTERVAL_MS
                    && presentation
                        .rendered
                        .is_some_and(|rendered| rendered < *input)
            })
        })
        .count();
    let mut latency: Vec<f64> = answered
        .iter()
        .map(|(at, shown)| editor_latency::millis(*at, shown.painted))
        .collect();
    let over_one = latency
        .iter()
        .filter(|ms| **ms > DISPLAY_INTERVAL_MS)
        .count();
    let over_two = latency
        .iter()
        .filter(|ms| **ms > DISPLAY_INTERVAL_MS * 2.0)
        .count();
    println!(
        "latency-bench: {label} {} inputs, {with_target} asked for a frame, {} shown, \
         {superseded} superseded, {} presentations ({} stale), {replaced} replaced before paint, \
         input->paint over 16.7 ms {over_one}, over 33.3 ms {over_two}",
        outcomes.len(),
        answered.len(),
        shown.len(),
        stale,
    );
    report(label, "input->paint", &mut latency);
    let mut to_render: Vec<f64> = answered
        .iter()
        .filter_map(|(at, shown)| {
            shown
                .rendered
                .map(|rendered| editor_latency::millis(*at, rendered))
        })
        .collect();
    report(label, "input->rendered", &mut to_render);
    stage_report(
        label,
        &answered.iter().map(|(_, shown)| *shown).collect::<Vec<_>>(),
    );
    let mut cadence = intervals(&shown);
    report(label, "present interval", &mut cadence);
}

fn stage_report(label: &str, shown: &[Presentation]) {
    let mut adopt: Vec<f64> = shown
        .iter()
        .filter_map(|presentation| {
            presentation
                .rendered
                .map(|rendered| editor_latency::millis(rendered, presentation.arrived))
        })
        .collect();
    let mut paint: Vec<f64> = shown
        .iter()
        .map(|presentation| editor_latency::millis(presentation.arrived, presentation.painted))
        .collect();
    report(label, "rendered->arrived", &mut adopt);
    report(label, "arrived->painted", &mut paint);
}

fn report(label: &str, stage: &str, samples: &mut [f64]) {
    let count = samples.len();
    match editor_latency::percentiles(samples) {
        Some([p50, p95, p99, max]) => println!(
            "latency-bench: {label} {stage} n={count} p50 {p50:.2} / p95 {p95:.2} / p99 {p99:.2} / max {max:.2} ms"
        ),
        None => println!("latency-bench: {label} {stage} n=0"),
    }
}

enum PauseMeasure {
    NoCanvas,
    Latency(Option<f64>),
}

struct MeasuredPass {
    quality: crate::store::EditorPreviewQuality,
    repeat: u32,
    fps: Option<f64>,
    frame_latency_p95_ms: Option<f64>,
    present_interval_p95_ms: Option<f64>,
    pause_frame_latency_p95_ms: Option<f64>,
    size: Option<[u32; 2]>,
    errors: u32,
}

struct QualitySummary {
    quality: crate::store::EditorPreviewQuality,
    samples: usize,
    fps: Vec<f64>,
    latency: Vec<f64>,
    present: Vec<f64>,
    pause: Vec<f64>,
    size: Option<[u32; 2]>,
    errors: u32,
}

struct CompareReport {
    text: String,
    failed: bool,
}

struct PreviewCompareLaunch {
    project: String,
    repeats: Option<String>,
    scenarios: Option<String>,
    qualities: Option<String>,
}

pub(crate) fn apply_preview_compare_args() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch = match preview_compare_launch(args.iter().map(String::as_str)) {
        Ok(Some(launch)) => launch,
        Ok(None) => return,
        Err(error) => {
            eprintln!("preview-compare: {error}");
            std::process::exit(1);
        }
    };
    if !std::path::Path::new(&launch.project).is_dir() {
        eprintln!(
            "preview-compare: {} is not a .cap project directory",
            launch.project
        );
        std::process::exit(1);
    }
    unsafe {
        std::env::set_var("CAP_GPUI_AUTO_EDITOR", &launch.project);
        std::env::set_var("CAP_GPUI_AUTO_PREVIEW_COMPARE", "1");
        std::env::set_var("CAP_GPUI_NO_MENUS", "1");
        std::env::set_var("CAP_GPUI_NO_TRAY", "1");
        std::env::set_var("CAP_GPUI_MUTE_AUDIO", "1");
        if let Some(repeats) = &launch.repeats {
            std::env::set_var("CAP_GPUI_AUTO_PREVIEW_COMPARE_REPEATS", repeats);
        }
        if let Some(scenarios) = &launch.scenarios {
            std::env::set_var("CAP_GPUI_AUTO_LATENCY_SCENARIOS", scenarios);
        }
        if let Some(qualities) = &launch.qualities {
            std::env::set_var("CAP_GPUI_AUTO_PREVIEW_QUALITIES", qualities);
        }
    }
}

fn preview_compare_launch<'a>(
    args: impl IntoIterator<Item = &'a str>,
) -> Result<Option<PreviewCompareLaunch>, String> {
    let args: Vec<&str> = args.into_iter().collect();
    let mut project = None;
    let mut repeats = None;
    let mut scenarios = None;
    let mut qualities = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index];
        match arg {
            "--preview-compare" => {
                project = Some(flag_value(&args, index, arg)?.to_string());
                index += 2;
            }
            "--preview-compare-repeats" => {
                let text = flag_value(&args, index, arg)?;
                parse_repeats(text)?;
                repeats = Some(text.to_string());
                index += 2;
            }
            "--preview-compare-scenarios" => {
                scenarios = Some(flag_value(&args, index, arg)?.to_string());
                index += 2;
            }
            "--preview-compare-qualities" => {
                let text = flag_value(&args, index, arg)?;
                parse_qualities(text)?;
                qualities = Some(text.to_string());
                index += 2;
            }
            other if other.starts_with("--preview-compare") => {
                return Err(format!("unknown argument {other}"));
            }
            _ => index += 1,
        }
    }
    let extra = repeats.is_some() || scenarios.is_some() || qualities.is_some();
    match project {
        Some(project) => Ok(Some(PreviewCompareLaunch {
            project,
            repeats,
            scenarios,
            qualities,
        })),
        None if extra => Err("missing --preview-compare <project.cap>".into()),
        None => Ok(None),
    }
}

fn flag_value<'a>(args: &[&'a str], index: usize, flag: &str) -> Result<&'a str, String> {
    args.get(index + 1)
        .copied()
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("{flag} needs a value"))
}

fn parse_qualities(text: &str) -> Result<Vec<crate::store::EditorPreviewQuality>, String> {
    let mut qualities = Vec::new();
    for part in text.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err("preview quality list has an empty entry".into());
        }
        let Some(quality) = crate::store::EditorPreviewQuality::from_json(part) else {
            return Err(format!("unknown preview quality '{part}'"));
        };
        qualities.push(quality);
    }
    if qualities.len() < 2 {
        return Err("preview compare needs at least two qualities".into());
    }
    Ok(qualities)
}

fn parse_repeats(text: &str) -> Result<u32, String> {
    let repeats = text
        .parse::<u32>()
        .map_err(|_| format!("repeats '{text}' is not a number"))?;
    if repeats == 0 {
        return Err("repeats must be at least 1".into());
    }
    Ok(repeats)
}

fn ordered_qualities(
    qualities: &[crate::store::EditorPreviewQuality],
    repeat_index: u32,
) -> Vec<crate::store::EditorPreviewQuality> {
    let mut order = qualities.to_vec();
    if repeat_index % 2 == 1 {
        order.reverse();
    }
    order
}

async fn run_compare(handle: Handle, cx: &mut AsyncApp, scenarios: &str) -> bool {
    let qualities = match parse_qualities(
        &std::env::var("CAP_GPUI_AUTO_PREVIEW_QUALITIES").unwrap_or_else(|_| "half,full".into()),
    ) {
        Ok(qualities) => qualities,
        Err(error) => {
            println!("preview-compare: {error}");
            return true;
        }
    };
    let repeats = match parse_repeats(
        &std::env::var("CAP_GPUI_AUTO_PREVIEW_COMPARE_REPEATS").unwrap_or_else(|_| "5".into()),
    ) {
        Ok(repeats) => repeats,
        Err(error) => {
            println!("preview-compare: {error}");
            return true;
        }
    };
    let adapter = match adapter_line().await {
        Ok(line) => line,
        Err(line) => {
            println!("{line}");
            return true;
        }
    };
    println!("{adapter}");
    println!(
        "preview-compare: build={}",
        if cfg!(debug_assertions) {
            "dev"
        } else {
            "release"
        }
    );
    println!(
        "preview-compare: qualities={} repeats={repeats} scenarios={scenarios}",
        qualities
            .iter()
            .map(|quality| quality.as_json())
            .collect::<Vec<_>>()
            .join(",")
    );
    let saved_choice = preview_choice_record();
    let mut passes = Vec::new();
    for index in 0..repeats {
        for quality in ordered_qualities(&qualities, index) {
            passes.push(run_pass(handle, cx, quality, index + 1, scenarios).await);
        }
    }
    let report = compare_report(&passes, preview_choice_record() == saved_choice);
    println!("{}", report.text);
    report.failed
}

async fn adapter_line() -> Result<String, String> {
    let Some(device) = crate::app_windows::shared_wgpu_device().await else {
        return Err(format_adapter("unavailable", "none", "none", true));
    };
    let info = device.adapter.get_info();
    Ok(format_adapter(
        &info.name,
        &format!("{:?}", info.backend),
        &format!("{:?}", info.device_type),
        device.is_software_adapter,
    ))
}

fn format_adapter(name: &str, backend: &str, device_type: &str, software: bool) -> String {
    let label = if software {
        "software-adapter"
    } else {
        "hardware-adapter"
    };
    let name = name.replace('"', "'");
    format!(
        "preview-compare: adapter label={label} name=\"{name}\" backend={backend} device_type={device_type} software={software}"
    )
}

async fn run_pass(
    handle: Handle,
    cx: &mut AsyncApp,
    quality: crate::store::EditorPreviewQuality,
    repeat: u32,
    scenarios: &str,
) -> MeasuredPass {
    update(handle, cx, |view, _, cx| {
        view.set_preview_quality_for_measurement(quality, cx);
    });
    let mut errors = 0u32;
    let mut playback_stats = None;
    let mut pause_latency = None;
    let mut saw_playback = false;
    for scenario in scenarios
        .split(',')
        .map(str::trim)
        .filter(|scenario| !scenario.is_empty())
    {
        match scenario {
            "playback" => {
                saw_playback = true;
                playback_stats = Some(playback(handle, cx).await);
            }
            "pause" => match pause(handle, cx).await {
                PauseMeasure::NoCanvas => errors += 1,
                PauseMeasure::Latency(latency) => pause_latency = latency,
            },
            "scrub-fast" => scrub(handle, cx, "scrub-fast", 0.1, 0.6).await,
            "scrub-fine" => scrub(handle, cx, "scrub-fine", 0.3, 0.302).await,
            "zoom-drag" => zoom_drag(handle, cx).await,
            "preset" => preset(handle, cx).await,
            "slider" => slider(handle, cx).await,
            "resize" => resize(handle, cx).await,
            other => {
                eprintln!("latency-bench: unknown scenario {other}");
                errors += 1;
            }
        }
        memory_report(scenario);
    }
    let frames = playback_stats.as_ref().map_or(0, |stats| stats.frames);
    let size = playback_stats.as_ref().and_then(|stats| stats.size);
    if !saw_playback || frames == 0 || size.is_none() {
        errors += 1;
    }
    let measured = playback_stats.as_ref().filter(|stats| stats.frames > 0);
    MeasuredPass {
        quality,
        repeat,
        fps: measured.map(|stats| stats.fps),
        frame_latency_p95_ms: measured.and_then(|stats| stats.rendered_to_painted_p95_ms),
        present_interval_p95_ms: measured.and_then(|stats| stats.present_p95_ms),
        pause_frame_latency_p95_ms: pause_latency,
        size: measured.and_then(|stats| stats.size),
        errors,
    }
}

fn compare_report(passes: &[MeasuredPass], default_unchanged: bool) -> CompareReport {
    let summaries = summarize(passes);
    let resolution = resolution_changed(&summaries);
    let mut failed =
        !default_unchanged || passes.iter().any(|pass| pass.errors > 0) || resolution != Some(true);
    if summaries.iter().any(|summary| summary.samples == 0) {
        failed = true;
    }
    let mut lines: Vec<String> = passes.iter().map(format_pass).collect();
    lines.extend(summaries.iter().map(format_summary));
    lines.push(format_verdict(&summaries, resolution, default_unchanged));
    CompareReport {
        text: lines.join("\n"),
        failed,
    }
}

fn summarize(passes: &[MeasuredPass]) -> Vec<QualitySummary> {
    let mut order = Vec::new();
    for pass in passes {
        if !order.contains(&pass.quality) {
            order.push(pass.quality);
        }
    }
    order
        .into_iter()
        .map(|quality| {
            let group: Vec<&MeasuredPass> = passes
                .iter()
                .filter(|pass| pass.quality == quality)
                .collect();
            let mut errors = group.iter().map(|pass| pass.errors).sum();
            let sizes: Vec<[u32; 2]> = group.iter().filter_map(|pass| pass.size).collect();
            let size = if sizes.is_empty() {
                None
            } else if sizes.iter().all(|size| *size == sizes[0]) {
                Some(sizes[0])
            } else {
                errors += 1;
                None
            };
            QualitySummary {
                quality,
                samples: group.iter().filter(|pass| pass.fps.is_some()).count(),
                fps: group.iter().filter_map(|pass| pass.fps).collect(),
                latency: group
                    .iter()
                    .filter_map(|pass| pass.frame_latency_p95_ms)
                    .collect(),
                present: group
                    .iter()
                    .filter_map(|pass| pass.present_interval_p95_ms)
                    .collect(),
                pause: group
                    .iter()
                    .filter_map(|pass| pass.pause_frame_latency_p95_ms)
                    .collect(),
                size,
                errors,
            }
        })
        .collect()
}

fn resolution_changed(summaries: &[QualitySummary]) -> Option<bool> {
    let sizes: Vec<[u32; 2]> = summaries
        .iter()
        .filter_map(|summary| summary.size)
        .collect();
    if sizes.len() < 2 || sizes.len() != summaries.len() {
        return None;
    }
    Some(sizes.iter().any(|size| *size != sizes[0]))
}

fn format_pass(pass: &MeasuredPass) -> String {
    format!(
        "preview-compare: quality={} repeat={} playback_fps={} playback_frame_latency_p95_ms={} present_interval_p95_ms={} pause_frame_latency_p95_ms={} size={} errors={}",
        pass.quality.as_json(),
        pass.repeat,
        fmt_fps(pass.fps),
        fmt_ms(pass.frame_latency_p95_ms),
        fmt_ms(pass.present_interval_p95_ms),
        fmt_ms(pass.pause_frame_latency_p95_ms),
        fmt_size(pass.size),
        pass.errors,
    )
}

fn format_summary(summary: &QualitySummary) -> String {
    format!(
        "preview-compare: quality={} samples={} playback_fps_median={} playback_frame_latency_p95_ms_median={} present_interval_p95_ms_median={} pause_frame_latency_p95_ms_median={} size={} errors={}",
        summary.quality.as_json(),
        summary.samples,
        fmt_spread(&summary.fps, true),
        fmt_spread(&summary.latency, false),
        fmt_spread(&summary.present, false),
        fmt_spread(&summary.pause, false),
        fmt_size(summary.size),
        summary.errors,
    )
}

fn format_verdict(
    summaries: &[QualitySummary],
    resolution: Option<bool>,
    default_unchanged: bool,
) -> String {
    let resolution = match resolution {
        Some(true) => "true",
        Some(false) => "false",
        None => "unknown",
    };
    format!(
        "preview-compare: playback_fps_ranges_overlap={} playback_frame_latency_ranges_overlap={} resolution_changed={resolution} default_unchanged={default_unchanged}",
        metric_overlap(summaries, |summary| &summary.fps),
        metric_overlap(summaries, |summary| &summary.latency),
    )
}

fn preview_choice_record() -> String {
    let path = crate::store::tauri_store_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return "missing".to_string();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return "unreadable".to_string();
    };
    let general = value.get("general_settings");
    let quality = general
        .and_then(|item| item.get("editorPreviewQuality"))
        .and_then(|item| item.as_str())
        .unwrap_or("-");
    let chosen = general
        .and_then(|item| item.get(crate::store::EDITOR_PREVIEW_QUALITY_CHOSEN_KEY))
        .map(|item| item.to_string())
        .unwrap_or_else(|| "-".to_string());
    format!("{quality}/{chosen}")
}

fn metric_overlap(
    summaries: &[QualitySummary],
    metric: impl Fn(&QualitySummary) -> &[f64],
) -> &'static str {
    if summaries.len() < 2 {
        return "inconclusive";
    }
    let mut saw_overlap = false;
    for (left_index, left) in summaries.iter().enumerate() {
        for right in summaries.iter().skip(left_index + 1) {
            match ranges_overlap(metric(left), metric(right)) {
                "inconclusive" => return "inconclusive",
                "true" => saw_overlap = true,
                _ => {}
            }
        }
    }
    if saw_overlap { "true" } else { "false" }
}

fn ranges_overlap(left: &[f64], right: &[f64]) -> &'static str {
    if left.len() < 5 || right.len() < 5 {
        return "inconclusive";
    }
    let Some((_, left_min, left_max)) = spread(left) else {
        return "inconclusive";
    };
    let Some((_, right_min, right_max)) = spread(right) else {
        return "inconclusive";
    };
    if left_min <= right_max && right_min <= left_max {
        "true"
    } else {
        "false"
    }
}

fn spread(values: &[f64]) -> Option<(f64, f64, f64)> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    let median = editor_latency::percentiles(&mut sorted)?[0];
    let min = sorted[0];
    let max = *sorted.last()?;
    Some((median, min, max))
}

fn fmt_fps(value: Option<f64>) -> String {
    value.map_or_else(|| "-".to_string(), |value| format!("{value:.1}"))
}

fn fmt_ms(value: Option<f64>) -> String {
    value.map_or_else(|| "-".to_string(), |value| format!("{value:.2}"))
}

fn fmt_size(size: Option<[u32; 2]>) -> String {
    size.map_or_else(
        || "-".to_string(),
        |size| format!("{}x{}", size[0], size[1]),
    )
}

fn fmt_spread(values: &[f64], fps: bool) -> String {
    let Some((median, min, max)) = spread(values) else {
        return "-".to_string();
    };
    if fps {
        format!("{median:.1} range={min:.1}..{max:.1}")
    } else {
        format!("{median:.2} range={min:.2}..{max:.2}")
    }
}

#[cfg(test)]
mod compare_tests {
    use super::*;
    use crate::store::SettingsEnum;

    fn pass(
        quality: crate::store::EditorPreviewQuality,
        repeat: u32,
        fps: f64,
        latency: f64,
        size: [u32; 2],
    ) -> MeasuredPass {
        MeasuredPass {
            quality,
            repeat,
            fps: Some(fps),
            frame_latency_p95_ms: Some(latency),
            present_interval_p95_ms: Some(16.7),
            pause_frame_latency_p95_ms: Some(12.0),
            size: Some(size),
            errors: 0,
        }
    }

    #[test]
    fn one_repeat_does_not_claim_the_ranges_separated() {
        let report = compare_report(
            &[
                pass(
                    crate::store::EditorPreviewQuality::Half,
                    1,
                    30.0,
                    8.0,
                    [1248, 702],
                ),
                pass(
                    crate::store::EditorPreviewQuality::Full,
                    1,
                    28.0,
                    9.0,
                    [1920, 1080],
                ),
            ],
            true,
        );
        assert!(!report.failed);
        assert!(
            report
                .text
                .contains("playback_fps_ranges_overlap=inconclusive")
        );
        assert!(
            report
                .text
                .contains("playback_frame_latency_ranges_overlap=inconclusive")
        );
        assert!(report.text.contains("resolution_changed=true"));
        assert!(report.text.contains("default_unchanged=true"));
        assert!(report.text.contains("size=1248x702"));
        assert!(report.text.contains("size=1920x1080"));
        assert!(report.text.contains("playback_fps=30.0"));
        assert!(report.text.contains("playback_frame_latency_p95_ms=8.00"));
    }

    #[test]
    fn a_changed_saved_preview_choice_fails() {
        let report = compare_report(
            &[
                pass(
                    crate::store::EditorPreviewQuality::Half,
                    1,
                    30.0,
                    8.0,
                    [1248, 702],
                ),
                pass(
                    crate::store::EditorPreviewQuality::Full,
                    1,
                    28.0,
                    9.0,
                    [1920, 1080],
                ),
            ],
            false,
        );
        assert!(report.failed);
        assert!(report.text.contains("default_unchanged=false"));
    }

    #[test]
    fn five_separated_runs_report_medians_and_no_overlap() {
        let half = [58.0, 59.0, 60.0, 61.0, 62.0];
        let full = [40.0, 41.0, 42.0, 43.0, 44.0];
        let mut passes = Vec::new();
        for (index, (half_fps, full_fps)) in half.into_iter().zip(full).enumerate() {
            let repeat = u32::try_from(index + 1).unwrap();
            passes.push(pass(
                crate::store::EditorPreviewQuality::Half,
                repeat,
                half_fps,
                4.0,
                [1248, 702],
            ));
            passes.push(pass(
                crate::store::EditorPreviewQuality::Full,
                repeat,
                full_fps,
                7.0,
                [1920, 1080],
            ));
        }
        let report = compare_report(&passes, true);
        assert!(!report.failed);
        assert!(
            report
                .text
                .contains("quality=half samples=5 playback_fps_median=60.0 range=58.0..62.0")
        );
        assert!(
            report
                .text
                .contains("quality=full samples=5 playback_fps_median=42.0 range=40.0..44.0")
        );
        assert!(report.text.contains("playback_fps_ranges_overlap=false"));
        assert!(
            report
                .text
                .contains("playback_frame_latency_ranges_overlap=false")
        );
    }

    #[test]
    fn non_adjacent_qualities_still_count_as_overlapping() {
        let quarter = [50.0, 52.0, 55.0, 58.0, 60.0];
        let half = [20.0, 22.0, 25.0, 28.0, 30.0];
        let full = [55.0, 57.0, 60.0, 63.0, 65.0];
        let mut passes = Vec::new();
        for (index, ((quarter_fps, half_fps), full_fps)) in
            quarter.into_iter().zip(half).zip(full).enumerate()
        {
            let repeat = u32::try_from(index + 1).unwrap();
            passes.push(pass(
                crate::store::EditorPreviewQuality::Quarter,
                repeat,
                quarter_fps,
                1.0,
                [480, 270],
            ));
            passes.push(pass(
                crate::store::EditorPreviewQuality::Half,
                repeat,
                half_fps,
                10.0,
                [1248, 702],
            ));
            passes.push(pass(
                crate::store::EditorPreviewQuality::Full,
                repeat,
                full_fps,
                20.0,
                [1920, 1080],
            ));
        }
        let report = compare_report(&passes, true);
        assert!(!report.failed);
        assert!(report.text.contains("playback_fps_ranges_overlap=true"));
        assert!(
            report
                .text
                .contains("playback_frame_latency_ranges_overlap=false")
        );
    }

    #[test]
    fn the_same_render_size_is_not_a_comparison() {
        let report = compare_report(
            &[
                pass(
                    crate::store::EditorPreviewQuality::Half,
                    1,
                    30.0,
                    8.0,
                    [1248, 702],
                ),
                pass(
                    crate::store::EditorPreviewQuality::Full,
                    1,
                    30.0,
                    8.0,
                    [1248, 702],
                ),
            ],
            true,
        );
        assert!(report.failed);
        assert!(report.text.contains("resolution_changed=false"));
    }

    #[test]
    fn a_pass_with_no_frames_fails() {
        let report = compare_report(
            &[
                MeasuredPass {
                    quality: crate::store::EditorPreviewQuality::Half,
                    repeat: 1,
                    fps: None,
                    frame_latency_p95_ms: None,
                    present_interval_p95_ms: None,
                    pause_frame_latency_p95_ms: None,
                    size: None,
                    errors: 1,
                },
                pass(
                    crate::store::EditorPreviewQuality::Full,
                    1,
                    30.0,
                    8.0,
                    [1920, 1080],
                ),
            ],
            true,
        );
        assert!(report.failed);
        assert!(report.text.contains("resolution_changed=unknown"));
        assert!(report.text.contains("errors=1"));
    }

    #[test]
    fn odd_repeats_reverse_the_quality_order() {
        let qualities = parse_qualities("half,full").unwrap();
        assert_eq!(
            ordered_qualities(&qualities, 0)
                .iter()
                .map(|quality| quality.as_json())
                .collect::<Vec<_>>(),
            ["half", "full"]
        );
        assert_eq!(
            ordered_qualities(&qualities, 1)
                .iter()
                .map(|quality| quality.as_json())
                .collect::<Vec<_>>(),
            ["full", "half"]
        );
    }

    #[test]
    fn qualities_and_repeats_reject_a_bad_value() {
        assert!(parse_qualities("half").is_err());
        assert!(parse_qualities("half,bogus").is_err());
        assert!(parse_qualities("half,,full").is_err());
        assert!(parse_repeats("0").is_err());
        assert!(parse_repeats("nope").is_err());
        assert_eq!(parse_repeats("5").unwrap(), 5);
    }

    #[test]
    fn the_launch_flag_reads_the_project_and_ignores_other_arguments() {
        let launch = preview_compare_launch([
            "--preview-compare",
            "/tmp/demo.cap",
            "--preview-compare-repeats",
            "1",
            "cap://example",
        ])
        .unwrap()
        .unwrap();
        assert_eq!(launch.project, "/tmp/demo.cap");
        assert_eq!(launch.repeats.as_deref(), Some("1"));
        assert!(preview_compare_launch(["cap://token"]).unwrap().is_none());
        assert!(preview_compare_launch(["--preview-compare"]).is_err());
        assert!(preview_compare_launch(["--preview-compare-repeats", "2"]).is_err());
    }

    #[test]
    fn a_software_adapter_is_labeled_as_software() {
        let line = format_adapter("llvmpipe (LLVM 18)", "Vulkan", "Cpu", true);
        assert!(line.contains("label=software-adapter"));
        assert!(line.contains("name=\"llvmpipe (LLVM 18)\""));
        assert!(line.contains("software=true"));
        let hardware = format_adapter("Radeon 780M", "Dx12", "IntegratedGpu", false);
        assert!(hardware.contains("label=hardware-adapter"));
        assert!(hardware.contains("software=false"));
    }
}
