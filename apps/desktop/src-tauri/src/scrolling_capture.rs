use cap_recording::screen_capture::ScreenCaptureTarget;
use image::DynamicImage;
use scap_targets::WindowId;
use tauri::AppHandle;
use tracing::debug;

/// Maximum number of scroll-and-capture iterations.
const MAX_FRAMES: usize = 60;
/// Maximum height of the stitched image, in pixels.
const MAX_STITCHED_HEIGHT: u32 = 16_000;
/// Wheel lines injected per scroll step.
const SCROLL_LINES: i32 = 5;
/// Delay after injecting a scroll before capturing the next frame.
const SETTLE_MS: u64 = 350;
/// Fraction of the frame height ignored at the top when matching frames, so
/// sticky headers and toolbars don't pin the detected offset to zero.
const HEADER_SKIP_FRACTION: f32 = 0.2;
/// Maximum mean absolute pixel difference for an overlap to count as a match.
const MATCH_THRESHOLD: f64 = 8.0;

/// Captures a window while scrolling it, stitching the frames into one tall
/// image. The window must be under the cursor so the injected wheel events
/// reach it.
#[tauri::command(async)]
#[specta::specta]
#[tracing::instrument(name = "capture_scrolling_window", skip(app))]
pub async fn capture_scrolling_window(
    app: AppHandle,
    window_id: WindowId,
) -> Result<std::path::PathBuf, String> {
    let target = ScreenCaptureTarget::Window {
        id: window_id.clone(),
    };

    let first = crate::recording::capture_screen_image(&app, target.clone()).await?;
    let frame_width = first.width();
    let frame_height = first.height();

    if frame_width == 0 || frame_height == 0 {
        return Err("Captured window is empty".to_string());
    }

    let mut stitched: Vec<DynamicImage> = vec![first.clone()];
    let mut stitched_height = frame_height;
    let mut prev = first.to_luma8();

    for frame_index in 0..MAX_FRAMES {
        inject_scroll(-SCROLL_LINES);
        tokio::time::sleep(std::time::Duration::from_millis(SETTLE_MS)).await;

        let frame = crate::recording::capture_screen_image(&app, target.clone()).await?;
        if frame.width() != frame_width || frame.height() != frame_height {
            debug!("Window resized during scrolling capture; stopping");
            break;
        }

        let cur = frame.to_luma8();
        let Some(offset) = find_scroll_offset(&prev, &cur) else {
            debug!("No overlap match on frame {frame_index}; stopping");
            break;
        };

        if offset == 0 {
            debug!("Content stopped scrolling on frame {frame_index}; done");
            break;
        }

        let new_rows = offset.min(frame_height);
        let strip = frame.crop_imm(0, frame_height - new_rows, frame_width, new_rows);
        stitched.push(strip);
        stitched_height += new_rows;
        prev = cur;

        if stitched_height >= MAX_STITCHED_HEIGHT {
            debug!("Stitched image reached the height cap; stopping");
            break;
        }
    }

    let mut canvas = image::RgbaImage::new(frame_width, stitched_height);
    let mut y = 0u32;
    for part in &stitched {
        image::imageops::replace(&mut canvas, &part.to_rgba8(), 0, i64::from(y));
        y += part.height();
    }

    crate::audio::AppSounds::Notification.play();

    crate::recording::save_screenshot_project(&app, DynamicImage::ImageRgba8(canvas), &target, true)
}

/// Finds how many pixels the content moved up between `prev` and `cur` by
/// locating the vertical shift with the smallest mean absolute difference
/// over the overlapping rows. Returns `None` when even the best candidate is
/// a poor match (e.g. the window repainted entirely).
fn find_scroll_offset(prev: &image::GrayImage, cur: &image::GrayImage) -> Option<u32> {
    let width = prev.width() as usize;
    let height = prev.height() as usize;
    let skip_top = (height as f32 * HEADER_SKIP_FRACTION) as usize;

    let prev_raw = prev.as_raw();
    let cur_raw = cur.as_raw();

    let col_step = (width / 64).max(1);
    let row_step = 4usize;

    let mut best_offset = 0usize;
    let mut best_score = f64::MAX;

    let max_offset = height - skip_top - row_step;
    for offset in (0..max_offset).step_by(2) {
        let overlap_rows = height - skip_top - offset;
        let mut sum = 0u64;
        let mut count = 0u64;

        for row in (0..overlap_rows).step_by(row_step) {
            let prev_row = skip_top + offset + row;
            let cur_row = skip_top + row;
            let prev_base = prev_row * width;
            let cur_base = cur_row * width;

            for col in (0..width).step_by(col_step) {
                let a = prev_raw[prev_base + col] as i32;
                let b = cur_raw[cur_base + col] as i32;
                sum += a.abs_diff(b) as u64;
                count += 1;
            }
        }

        if count == 0 {
            continue;
        }

        let score = sum as f64 / count as f64;
        if score < best_score {
            best_score = score;
            best_offset = offset;
        }

        if score < 0.5 && offset > 0 {
            break;
        }
    }

    (best_score <= MATCH_THRESHOLD).then_some(best_offset as u32)
}

/// Injects vertical mouse-wheel scrolling at the current cursor position.
/// Negative `lines` scrolls the content up (revealing content below).
#[allow(unused_variables)]
fn inject_scroll(lines: i32) {
    #[cfg(windows)]
    {
        use ::windows::Win32::UI::Input::KeyboardAndMouse::{
            INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT, SendInput,
        };

        const WHEEL_DELTA: i32 = 120;

        let input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: (lines * WHEEL_DELTA) as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };

        unsafe {
            SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;

        // kCGScrollEventUnitLine
        const UNITS_LINE: u32 = 1;
        // kCGHIDEventTap
        const HID_EVENT_TAP: u32 = 0;

        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGEventCreateScrollWheelEvent2(
                source: *const c_void,
                units: u32,
                wheel_count: u32,
                wheel1: i32,
                wheel2: i32,
                wheel3: i32,
            ) -> *mut c_void;
            fn CGEventPost(tap: u32, event: *mut c_void);
            fn CFRelease(cf: *const c_void);
        }

        unsafe {
            let event =
                CGEventCreateScrollWheelEvent2(std::ptr::null(), UNITS_LINE, 1, lines, 0, 0);
            if !event.is_null() {
                CGEventPost(HID_EVENT_TAP, event);
                CFRelease(event);
            }
        }
    }
}
