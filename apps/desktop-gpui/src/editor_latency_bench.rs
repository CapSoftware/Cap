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

use std::time::{Duration, Instant};

use gpui::{AsyncApp, MouseButton, MouseDownEvent, MouseMoveEvent, WindowHandle, point, px, size};

use crate::{
    draw_bench,
    editor_latency::{self, Mark, Presentation, Stage},
    editor_sidebar::{BgSlider, SliderKey},
    editor_timeline::{self, TrackKind},
    editor_window::EditorWindow,
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
    if !std::env::var("CAP_GPUI_AUTO_LATENCY_BENCH").is_ok_and(|value| value == "1") {
        return;
    }
    let scenarios = std::env::var("CAP_GPUI_AUTO_LATENCY_SCENARIOS").unwrap_or_else(|_| {
        "playback,scrub-fast,scrub-fine,zoom-drag,preset,slider,resize,pause".into()
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

    for scenario in scenarios.split(',').map(str::trim) {
        match scenario {
            "playback" => playback(handle, cx).await,
            "scrub-fast" => scrub(handle, cx, "scrub-fast", 0.1, 0.6).await,
            "scrub-fine" => scrub(handle, cx, "scrub-fine", 0.3, 0.302).await,
            "zoom-drag" => zoom_drag(handle, cx).await,
            "preset" => preset(handle, cx).await,
            "slider" => slider(handle, cx).await,
            "resize" => resize(handle, cx).await,
            "pause" => pause(handle, cx).await,
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

async fn playback(handle: Handle, cx: &mut AsyncApp) {
    pause_at(handle, cx, 0.1).await;
    editor_latency::take();
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
    let (shown, replaced) = editor_latency::presentations(&marks);
    let first = shown
        .first()
        .map(|presentation| editor_latency::millis(pressed, presentation.painted));
    let steady: Vec<Presentation> = shown
        .iter()
        .copied()
        .filter(|presentation| presentation.painted >= pressed + PLAYBACK_WARMUP)
        .filter(|presentation| presentation.painted <= pressed + PLAYBACK)
        .collect();
    let window_secs = PLAYBACK.saturating_sub(PLAYBACK_WARMUP).as_secs_f64();
    let skipped: u32 = steady
        .windows(2)
        .map(|pair| {
            pair[1]
                .frame
                .saturating_sub(pair[0].frame)
                .saturating_sub(1)
        })
        .sum();
    let repeats = steady
        .windows(2)
        .filter(|pair| pair[1].frame <= pair[0].frame)
        .count();
    let mut intervals = intervals(&steady);
    let late = intervals
        .iter()
        .filter(|interval| **interval > DISPLAY_INTERVAL_MS * 1.5)
        .count();
    println!(
        "latency-bench: playback first-frame {} ms, {:.1} fps presented over {window_secs:.0}s, \
         {skipped} source frames skipped, {repeats} out of order, {late} intervals over 25 ms, \
         {replaced} replaced before paint, pump dropped {}",
        first.map_or("-".into(), |ms| format!("{ms:.1}")),
        steady.len() as f64 / window_secs,
        pump.map_or(0, |pump| pump.dropped),
    );
    report("playback", "present interval", &mut intervals);
    stage_report("playback", &steady);
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
async fn pause(handle: Handle, cx: &mut AsyncApp) {
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
            return;
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
    report("pause", "pause->canvas-size frame", &mut to_sharp);
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
