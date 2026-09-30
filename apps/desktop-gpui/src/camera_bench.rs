//! `CAP_GPUI_AUTO_CAMERA_BENCH=1`: the camera bubble's per-frame draw cost,
//! measured on the production path. Opens the real camera window, pumps
//! synthetic 420v camera frames through `deliver_camera_frame` at ~30fps, and
//! times `Window::draw` for that window: view render + taffy layout + prepaint
//! + paint scene, which is exactly the work a per-frame repaint re-does.
//!
//! Draws are driven synchronously (the same `Window::draw` the platform
//! frame-request loop runs) so the measurement works on an idle or locked
//! display too, where the display link never ticks.
//!
//! Run:
//!   CAP_GPUI_AUTO_CAMERA_BENCH=1 CAP_GPUI_NO_MENUS=1 CAP_GPUI_NO_TRAY=1 \
//!     cargo run --release

use std::time::{Duration, Instant};

use gpui::App;

use crate::app_windows::{self, AppWindows};

const FRAME_WIDTH: usize = 1280;
const FRAME_HEIGHT: usize = 720;
const FPS: u64 = 30;
const WARMUP_FRAMES: usize = 60;
const MEASURED_FRAMES: usize = 300;

pub fn run(cx: &mut App) {
    app_windows::open_camera_window(cx);
    let Some(handle) = cx.global::<AppWindows>().camera else {
        eprintln!("camera-bench: camera window did not open");
        std::process::exit(1);
    };

    let sources: Vec<_> = (0..4)
        .map(|seed| make_camera_sample_buf(seed as u8))
        .collect();

    cx.spawn(async move |cx| {
        let interval = Duration::from_micros(1_000_000 / FPS);

        for index in 0..WARMUP_FRAMES {
            cx.background_executor().timer(interval).await;
            let frame = native_frame(&sources[index % sources.len()]);
            let delivered = cx.update(|cx| {
                let delivered = app_windows::deliver_camera_frame(frame, cx);
                let _ = draw_camera_window(handle, cx);
                delivered
            });
            if !delivered {
                eprintln!("camera-bench: frame delivery failed during warmup");
                std::process::exit(1);
            }
        }

        let mut draw_us = Vec::with_capacity(MEASURED_FRAMES);
        for index in 0..MEASURED_FRAMES {
            cx.background_executor().timer(interval).await;
            let frame = native_frame(&sources[index % sources.len()]);
            let elapsed = cx.update(|cx| {
                app_windows::deliver_camera_frame(frame, cx);
                draw_camera_window(handle, cx)
            });
            if let Some(elapsed) = elapsed {
                draw_us.push(elapsed.as_secs_f64() * 1e6);
            }
        }

        if draw_us.len() < MEASURED_FRAMES {
            eprintln!(
                "camera-bench: only {} of {MEASURED_FRAMES} draws completed",
                draw_us.len()
            );
            std::process::exit(1);
        }

        // Floor: draws with no frame delivered since the last draw, so nothing
        // is dirty. Isolates the always-relayouted part of the tree from the
        // per-frame preview work.
        let mut clean_us = Vec::with_capacity(MEASURED_FRAMES);
        for _ in 0..MEASURED_FRAMES {
            cx.background_executor().timer(interval).await;
            let elapsed = cx.update(|cx| draw_camera_window(handle, cx));
            if let Some(elapsed) = elapsed {
                clean_us.push(elapsed.as_secs_f64() * 1e6);
            }
        }

        println!(
            "camera-bench: {} frames at {FPS}fps ({FRAME_WIDTH}x{FRAME_HEIGHT} 420v camera frames)",
            draw_us.len()
        );
        report("frame draw", &mut draw_us);
        report("clean draw", &mut clean_us);
        std::process::exit(0);
    })
    .detach();
}

fn report(label: &str, samples: &mut [f64]) {
    samples.sort_by(|a, b| a.partial_cmp(b).expect("no NaN draw times"));
    let mean = samples.iter().sum::<f64>() / samples.len() as f64;
    let p50 = samples[samples.len() / 2];
    let p95 = samples[(samples.len() as f64 * 0.95) as usize];
    let max = samples[samples.len() - 1];
    println!(
        "camera-bench: {label} {mean:.1} mean / {p50:.1} p50 / {p95:.1} p95 / {max:.1} max us"
    );
}

/// One synchronous `Window::draw`, timed. `AnyWindowHandle::update` passes the
/// root as an unleased `AnyView`; the typed handle would lease the root entity
/// that `draw()` re-renders.
fn draw_camera_window(
    handle: gpui::WindowHandle<crate::camera_window::CameraWindow>,
    cx: &mut App,
) -> Option<Duration> {
    gpui::AnyWindowHandle::from(handle)
        .update(cx, |_, window, cx| {
            let started = Instant::now();
            window.draw(cx).clear();
            started.elapsed()
        })
        .ok()
}

fn native_frame(
    sample_buf: &cidre::arc::R<cidre::cm::SampleBuf>,
) -> cap_recording::NativeCameraFrame {
    cap_recording::NativeCameraFrame {
        sample_buf: sample_buf.clone(),
        timestamp: cap_timestamp::Timestamp::Instant(Instant::now()),
    }
}

fn make_camera_sample_buf(seed: u8) -> cidre::arc::R<cidre::cm::SampleBuf> {
    use cidre::{cf, cm, cv};

    let io_surface_properties = cf::Dictionary::new();
    let keys: [&cf::Type; 2] = [
        cv::pixel_buffer::keys::io_surf_props().as_ref(),
        cv::pixel_buffer::keys::metal_compatibility().as_ref(),
    ];
    let values: [&cf::Type; 2] = [
        io_surface_properties.as_ref(),
        cf::Boolean::value_true().as_ref(),
    ];
    let attrs = cf::Dictionary::with_keys_values(&keys, &values).expect("pixel buffer attributes");
    let mut buf = cv::PixelBuf::new(
        FRAME_WIDTH,
        FRAME_HEIGHT,
        cv::PixelFormat::_420V,
        Some(&attrs),
    )
    .expect("420v camera frame");

    unsafe {
        buf.lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT)
            .result()
            .expect("lock 420v frame");
        let y_stride = buf.plane_bytes_per_row(0);
        let y_height = buf.plane_height(0);
        let y_base = buf.plane_base_address(0).cast_mut();
        for row in 0..y_height {
            for col in 0..FRAME_WIDTH {
                *y_base.add(row * y_stride + col) =
                    16 + ((row * 7 + col * 3 + seed as usize * 31) % 220) as u8;
            }
        }
        let uv_stride = buf.plane_bytes_per_row(1);
        let uv_height = buf.plane_height(1);
        let uv_base = buf.plane_base_address(1).cast_mut();
        for row in 0..uv_height {
            for pair in 0..(FRAME_WIDTH / 2) {
                *uv_base.add(row * uv_stride + pair * 2) =
                    16 + ((row * 5 + pair * 2 + seed as usize * 17) % 208) as u8;
                *uv_base.add(row * uv_stride + pair * 2 + 1) =
                    16 + ((row * 3 + pair * 5 + seed as usize * 23) % 208) as u8;
            }
        }
        buf.unlock_lock_base_addr(cv::pixel_buffer::LockFlags::DEFAULT);
    }

    let format_desc = cm::VideoFormatDesc::with_image_buf(&buf).expect("format description");
    let timing = cm::SampleTimingInfo {
        duration: cm::Time::new(1_000_000 / FPS as i64, 1_000_000),
        pts: cm::Time::new(0, 1_000_000),
        dts: cm::Time::invalid(),
    };
    cm::SampleBuf::with_image_buf(&buf, true, None, std::ptr::null(), &format_desc, &timing)
        .expect("sample buffer")
}
