//! `CAP_PICKER_PROBE_AREA_RECORDING=1`: record an area through the picker and
//! check its outline from the outside. While the recording runs, the outline
//! has to be on screen, out of the recorded video, and out of the way of the
//! mouse; once it stops, nothing of the outline may stay behind.
//!
//! The overlay is left out of screen captures for the length of the
//! recording, so a screenshot cannot see it either. The probe lifts that for
//! one screenshot, after the frames the video check reads: what the display
//! shows is the same either way, only captures differ.

use std::path::{Path, PathBuf};

use gpui::{AsyncApp, WindowHandle};
use image::RgbImage;

use super::sleep;
use crate::{
    app_windows,
    main_window::{MainWindow, Mode, TargetType},
    session::{Phase, RecordingSession},
    target_overlay::AreaRect,
};

const AREA: AreaRect = AreaRect {
    x: 200.,
    y: 200.,
    width: 640.,
    height: 360.,
};
/// The outline is a 2pt white border just inside the area and a 1pt dark
/// line 3pt outside it; the band covers both.
const BAND: f32 = 4.;
/// A channel this far apart is a different pixel, not capture noise.
const CHANGED: u8 = 24;
/// The video is H.264, so its pixels sit further from the screenshot's.
const CHANGED_IN_VIDEO: u8 = 48;
/// When in the recording the video check reads a frame: well before the
/// probe lifts the overlay's capture exclusion.
const VIDEO_FRAME_SECS: f64 = 1.;

pub async fn run(
    output: &std::ffi::OsStr,
    main: WindowHandle<MainWindow>,
    cx: &mut AsyncApp,
) -> serde_json::Value {
    let directory = Path::new(output)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    // Nothing should come forward when the recording ends, so the last
    // screenshot shows only what the outline may have left behind.
    crate::store::set_store_setting(
        crate::store::GENERAL_SETTINGS,
        "postStudioRecordingBehaviour",
        "doNothing".into(),
    );

    // A fresh profile starts in Instant, which needs a signed-in user.
    main.update(cx, |view, _, cx| {
        view.set_mode(Mode::Studio, cx);
        view.arm_overlay(TargetType::Area, cx);
    })
    .ok();
    let recordings = recordings_dir().map(|directory| projects(&directory));
    sleep(cx, 1500).await;
    cx.update(|cx| app_windows::seed_area_selection(None, AREA, cx));
    sleep(cx, 800).await;
    let started = cx.update(|cx| app_windows::start_from_overlay(None, cx));
    if !started {
        return serde_json::json!({ "passed": false, "error": "no overlay to start from" });
    }
    let session = cx.update(|cx| RecordingSession::global(cx));
    if !wait_for(cx, &session, 600, |phase| {
        matches!(phase, Phase::Recording { .. })
    })
    .await
    {
        return serde_json::json!({ "passed": false, "error": "the recording never started" });
    }
    sleep(cx, 2500).await;

    let overlay = cx.update(|cx| {
        cx.global::<app_windows::AppWindows>()
            .overlays
            .first()
            .map(|(_, overlay)| *overlay)
    });
    let native = overlay.and_then(|overlay| {
        overlay
            .update(cx, |_, window, _| crate::platform::native_window(window))
            .ok()
            .flatten()
    });
    let excluded_while_recording = native
        .as_ref()
        .is_some_and(crate::platform::window_capture_hidden);
    let click_through = clicks_pass_through(native.as_ref(), cx);

    let hidden = super::screenshot(output, "area-recording-excluded", cx).await;
    if let Some(native) = &native {
        crate::platform::set_window_capture_hidden(native, false);
    }
    sleep(cx, 400).await;
    let shown = super::screenshot(output, "area-recording-on-screen", cx).await;
    if let Some(native) = &native {
        crate::platform::set_window_capture_hidden(native, true);
    }
    sleep(cx, 600).await;

    cx.update(|cx| session.update(cx, |session, cx| session.stop(cx)));
    let stopped = wait_for(cx, &session, 600, |phase| phase == Phase::Idle).await;
    sleep(cx, 1500).await;
    let after = super::screenshot(output, "area-recording-after", cx).await;

    let scale = hidden.as_ref().map_or(1., |image| display_scale(image));
    let band = outline_band(scale);
    let hidden = hidden.map(|image| image.to_rgb8());
    let shown = shown.map(|image| image.to_rgb8());
    let after = after.map(|image| image.to_rgb8());
    let on_screen = changed_fraction(hidden.as_ref(), shown.as_ref(), &band, CHANGED);
    let left_behind = changed_fraction(hidden.as_ref(), after.as_ref(), &band, CHANGED);

    let video = recorded_display(recordings.unwrap_or_default(), cx).await;
    let frame = video
        .as_deref()
        .and_then(|video| frame_at(video, VIDEO_FRAME_SECS));
    if let Some(frame) = &frame {
        let _ = frame.save(directory.join("area-recording-frame.png"));
    }
    let in_video = match (&hidden, &frame) {
        (Some(hidden), Some(frame)) => video_outline_fraction(hidden, frame, scale),
        _ => None,
    };

    let passed = stopped
        && on_screen.is_some_and(|fraction| fraction > 0.15)
        && in_video.is_some_and(|fraction| fraction < 0.05)
        && left_behind.is_some_and(|fraction| fraction < 0.05)
        && click_through != Some(false);
    serde_json::json!({
        "passed": passed,
        "overlayKept": overlay.is_some(),
        "excludedWhileRecording": excluded_while_recording,
        "clickThrough": click_through,
        "outlineBandPixels": band.len(),
        "outlineOnScreen": on_screen,
        "outlineInVideo": in_video,
        "outlineLeftBehind": left_behind,
        "video": video.map(|video| video.display().to_string()),
        "stopped": stopped,
    })
}

async fn wait_for(
    cx: &mut AsyncApp,
    session: &gpui::Entity<RecordingSession>,
    polls: usize,
    done: impl Fn(Phase) -> bool,
) -> bool {
    for _ in 0..polls {
        if cx.update(|cx| done(session.read(cx).phase)) {
            return true;
        }
        sleep(cx, 100).await;
    }
    false
}

/// Physical pixels per point on the primary display.
fn display_scale(image: &image::DynamicImage) -> f32 {
    scap_targets::Display::primary()
        .raw_handle()
        .logical_bounds()
        .map(|bounds| image.width() as f32 / bounds.size().width() as f32)
        .filter(|scale| scale.is_finite() && *scale > 0.)
        .unwrap_or(1.)
}

/// Every pixel within [`BAND`] points of the area's edge, both sides.
fn outline_band(scale: f32) -> Vec<(u32, u32)> {
    let (left, top) = (AREA.x * scale, AREA.y * scale);
    let (right, bottom) = (left + AREA.width * scale, top + AREA.height * scale);
    let band = BAND * scale;
    let mut pixels = Vec::new();
    for y in (top - band) as u32..(bottom + band) as u32 {
        for x in (left - band) as u32..(right + band) as u32 {
            let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
            let inside_outer =
                px >= left - band && px < right + band && py >= top - band && py < bottom + band;
            let inside_inner =
                px >= left + band && px < right - band && py >= top + band && py < bottom - band;
            if inside_outer && !inside_inner {
                pixels.push((x, y));
            }
        }
    }
    pixels
}

fn differs(a: &image::Rgb<u8>, b: &image::Rgb<u8>, threshold: u8) -> bool {
    a.0.iter().zip(b.0).any(|(a, b)| a.abs_diff(b) > threshold)
}

fn changed_fraction(
    before: Option<&RgbImage>,
    after: Option<&RgbImage>,
    pixels: &[(u32, u32)],
    threshold: u8,
) -> Option<f64> {
    let (before, after) = (before?, after?);
    if before.dimensions() != after.dimensions() || pixels.is_empty() {
        return None;
    }
    let changed = pixels
        .iter()
        .filter(|(x, y)| *x < before.width() && *y < before.height())
        .filter(|(x, y)| differs(before.get_pixel(*x, *y), after.get_pixel(*x, *y), threshold))
        .count();
    Some(changed as f64 / pixels.len() as f64)
}

/// The share of the video frame's edge band (the part of the outline that
/// lies inside the area) that does not match the screen without the outline.
fn video_outline_fraction(screen: &RgbImage, frame: &RgbImage, scale: f32) -> Option<f64> {
    let (left, top) = ((AREA.x * scale) as u32, (AREA.y * scale) as u32);
    let (width, height) = (
        (AREA.width * scale).round() as u32,
        (AREA.height * scale).round() as u32,
    );
    if left + width > screen.width() || top + height > screen.height() {
        return None;
    }
    let expected = image::imageops::crop_imm(screen, left, top, width, height).to_image();
    let frame = if frame.dimensions() == (width, height) {
        frame.clone()
    } else {
        image::imageops::resize(frame, width, height, image::imageops::FilterType::Triangle)
    };
    let band = (BAND * scale).ceil() as u32;
    let mut total = 0usize;
    let mut changed = 0usize;
    for y in 0..height {
        for x in 0..width {
            let edge = x < band || y < band || x >= width - band || y >= height - band;
            if !edge {
                continue;
            }
            total += 1;
            if differs(
                expected.get_pixel(x, y),
                frame.get_pixel(x, y),
                CHANGED_IN_VIDEO,
            ) {
                changed += 1;
            }
        }
    }
    (total > 0).then(|| changed as f64 / total as f64)
}

fn recordings_dir() -> Option<PathBuf> {
    std::env::var_os("CAP_GPUI_RECORDINGS_DIR").map(PathBuf::from)
}

fn projects(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
        .unwrap_or_default()
}

/// The display track of the recording this probe made (a project that was
/// not there before it started), once the stop has remuxed it.
async fn recorded_display(before: Vec<PathBuf>, cx: &mut AsyncApp) -> Option<PathBuf> {
    let directory = recordings_dir()?;
    for _ in 0..120 {
        let found = projects(&directory)
            .into_iter()
            .filter(|project| !before.contains(project))
            .map(|project| project.join("content/segments/segment-0/display.mp4"))
            .find(|path| path.is_file());
        if let Some(path) = found {
            sleep(cx, 1000).await;
            return Some(path);
        }
        sleep(cx, 500).await;
    }
    None
}

fn frame_at(path: &Path, seconds: f64) -> Option<RgbImage> {
    let mut input = ffmpeg::format::input(path).ok()?;
    let stream = input.streams().best(ffmpeg::media::Type::Video)?;
    let index = stream.index();
    let time_base = f64::from(stream.time_base());
    let start = stream.start_time().max(0) as f64 * time_base;
    let mut decoder = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .ok()?
        .decoder()
        .video()
        .ok()?;
    let mut frame = ffmpeg::frame::Video::empty();
    let mut picked = false;
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        if decoder.send_packet(&packet).is_err() {
            continue;
        }
        while !picked && decoder.receive_frame(&mut frame).is_ok() {
            picked = frame.timestamp().unwrap_or(0) as f64 * time_base - start >= seconds;
        }
        if picked {
            break;
        }
    }
    if !picked {
        return None;
    }
    let (width, height) = (frame.width(), frame.height());
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        frame.format(),
        width,
        height,
        ffmpeg::format::Pixel::RGB24,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .ok()?;
    let mut rgb = ffmpeg::frame::Video::empty();
    scaler.run(&frame, &mut rgb).ok()?;
    let stride = rgb.stride(0);
    let data = rgb.data(0);
    let mut pixels = Vec::with_capacity((width * height * 3) as usize);
    for row in 0..height as usize {
        pixels.extend_from_slice(&data[row * stride..row * stride + width as usize * 3]);
    }
    RgbImage::from_raw(width, height, pixels)
}

/// Whether a click in the middle of the area reaches the app under it rather
/// than the outline. `None` where the probe cannot ask.
#[cfg(windows)]
fn clicks_pass_through(
    native: Option<&crate::platform::NativeWindow>,
    cx: &mut AsyncApp,
) -> Option<bool> {
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::WindowsAndMessaging::{
            GA_ROOT, GetAncestor, GetWindowThreadProcessId, WindowFromPoint,
        },
    };
    native?;
    let scale = cx.update(|cx| {
        let overlay = cx
            .global::<app_windows::AppWindows>()
            .overlays
            .first()
            .map(|(_, overlay)| *overlay)?;
        overlay
            .update(cx, |_, window, _| window.scale_factor())
            .ok()
    });
    let scale = scale.unwrap_or(1.);
    let point = POINT {
        x: ((AREA.x + AREA.width / 2.) * scale) as i32,
        y: ((AREA.y + AREA.height / 2.) * scale) as i32,
    };
    let root = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
    let mut owner = 0;
    unsafe { GetWindowThreadProcessId(root, &mut owner) };
    Some(owner != std::process::id())
}

#[cfg(not(windows))]
fn clicks_pass_through(
    _native: Option<&crate::platform::NativeWindow>,
    _cx: &mut AsyncApp,
) -> Option<bool> {
    None
}
