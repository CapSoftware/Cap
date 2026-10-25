#[cfg(any(windows, target_os = "macos"))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(any(windows, target_os = "macos"))]
use std::time::Duration;

#[cfg(any(windows, target_os = "macos"))]
use anyhow::Context as _;
#[cfg(any(windows, target_os = "macos"))]
use cap_recording::sources::screen_capture::ScreenCaptureTarget;
#[cfg(any(windows, target_os = "macos"))]
use gpui::App;

#[cfg(any(windows, target_os = "macos"))]
const MAX_FRAMES: usize = 60;
#[cfg(any(windows, target_os = "macos", test))]
const MAX_STITCHED_HEIGHT: u32 = 16_000;
#[cfg(any(windows, target_os = "macos"))]
const SCROLL_NOTCHES: i32 = 2;
#[cfg(any(windows, target_os = "macos"))]
const SETTLE_MS: u64 = 600;
const HEADER_SKIP_FRACTION: f32 = 0.2;
const MATCH_THRESHOLD: f64 = 12.0;
const MIN_OVERLAP_FRACTION: f32 = 0.25;
#[cfg(any(windows, target_os = "macos"))]
static SCROLLING_CAPTURE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

#[cfg(any(windows, target_os = "macos"))]
struct InProgressGuard;

#[cfg(any(windows, target_os = "macos"))]
impl InProgressGuard {
    fn acquire() -> Option<Self> {
        SCROLLING_CAPTURE_IN_PROGRESS
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self)
    }
}

#[cfg(any(windows, target_os = "macos"))]
impl Drop for InProgressGuard {
    fn drop(&mut self) {
        SCROLLING_CAPTURE_IN_PROGRESS.store(false, Ordering::Release);
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub fn capture_scrolling_window(target: ScreenCaptureTarget, cx: &mut App) {
    let Some(guard) = InProgressGuard::acquire() else {
        tracing::debug!("scrolling capture is already in progress");
        return;
    };
    let settle = crate::app_windows::prepare_for_screenshot_capture(cx);
    let task = gpui_tokio::Tokio::spawn_result(cx, async move {
        let _guard = guard;
        if settle {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        capture_and_write(target).await
    });

    cx.spawn(async move |cx| {
        let captured = match task.await {
            Ok(png) => {
                tracing::info!(path = %png.display(), "scrolling capture saved");
                crate::app_sounds::AppSound::Notification.play();
                Some(png)
            }
            Err(error) => {
                tracing::error!("scrolling capture failed: {error:#}");
                None
            }
        };
        cx.update(|cx| crate::app_windows::screenshot_finished(captured, cx));
    })
    .detach();
}

#[cfg(any(windows, target_os = "macos"))]
async fn capture_and_write(target: ScreenCaptureTarget) -> anyhow::Result<std::path::PathBuf> {
    let first = cap_recording::screenshot::capture_screenshot(target.clone())
        .await
        .context("capturing the first window frame")?;
    let frame_width = first.width();
    let frame_height = first.height();
    if frame_width == 0 || frame_height == 0 {
        anyhow::bail!("Captured window is empty");
    }

    let first_part = first.crop_imm(0, 0, frame_width, frame_height.min(MAX_STITCHED_HEIGHT));
    let mut stitch = Stitch {
        height: first_part.height(),
        parts: vec![first_part],
        footer_height: 0,
        footer_established: false,
        max_height: MAX_STITCHED_HEIGHT,
    };
    let mut prev = first.to_luma8();
    let mut last_frame = first.clone();

    for frame_index in 0..MAX_FRAMES {
        if !cursor_is_over_target(&target) {
            tracing::debug!(
                frame_index,
                "cursor left the target window; stopping scrolling capture"
            );
            break;
        }
        inject_scroll(-SCROLL_NOTCHES);
        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;

        let frame = cap_recording::screenshot::capture_screenshot(target.clone())
            .await
            .context("capturing a scrolled window frame")?;
        if frame.width() != frame_width || frame.height() != frame_height {
            tracing::debug!("window resized during scrolling capture; stopping");
            break;
        }

        let cur = frame.to_luma8();
        let Some(step) =
            find_scroll_step(&prev, &cur, stitch.footer_established, stitch.footer_height)
        else {
            tracing::debug!(
                frame_index,
                "window content stopped scrolling or no overlap matched"
            );
            break;
        };
        let new_rows = stitch.append_step(&first, &frame, step);
        last_frame = frame.clone();
        prev = cur;
        if new_rows == 0 {
            tracing::debug!("scrolling capture reached its height cap");
            break;
        }

        if stitch.height >= stitch.max_height {
            tracing::debug!("scrolling capture reached its height cap");
            break;
        }
    }

    let footer_height = stitch.footer_height;
    append_footer(&mut stitch.parts, &last_frame, footer_height);

    let canvas = stitch_parts(
        &stitch.parts,
        frame_width,
        stitch.height.saturating_add(footer_height),
    );
    crate::screenshot::write_screenshot_bundle(image::DynamicImage::ImageRgba8(canvas), &target)
        .await
}

#[cfg(any(windows, target_os = "macos"))]
fn cursor_is_over_target(target: &ScreenCaptureTarget) -> bool {
    let ScreenCaptureTarget::Window { id } = target else {
        return false;
    };
    crate::devices::topmost_foreign_window_at_cursor().is_some_and(|window| &window.id() == id)
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Copy)]
struct ScrollStep {
    footer_height: u32,
    offset: u32,
}

#[cfg(any(windows, target_os = "macos", test))]
struct Stitch {
    parts: Vec<image::DynamicImage>,
    height: u32,
    footer_height: u32,
    footer_established: bool,
    max_height: u32,
}

#[cfg(any(windows, target_os = "macos", test))]
impl Stitch {
    fn append_step(
        &mut self,
        first: &image::DynamicImage,
        frame: &image::DynamicImage,
        step: ScrollStep,
    ) -> u32 {
        if !self.footer_established {
            self.footer_height = step.footer_height;
            let first_content = crop_content(first, self.footer_height);
            let first_content_height = first_content
                .height()
                .min(self.max_height.saturating_sub(self.footer_height));
            let first_content = first_content.crop_imm(0, 0, first.width(), first_content_height);
            self.height = self
                .height
                .saturating_sub(self.parts[0].height())
                .saturating_add(first_content.height());
            self.parts[0] = first_content;
            self.footer_established = true;
        }

        let remaining_rows = self
            .max_height
            .saturating_sub(self.height)
            .saturating_sub(self.footer_height);
        let appended = append_new_rows(
            &mut self.parts,
            frame,
            step.offset,
            remaining_rows,
            self.footer_height,
        );
        self.height = self.height.saturating_add(appended);
        appended
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn find_scroll_step(
    prev: &image::GrayImage,
    cur: &image::GrayImage,
    footer_established: bool,
    footer_height: u32,
) -> Option<ScrollStep> {
    if frames_effectively_identical(prev, cur) {
        return None;
    }

    let footer_height = if footer_established {
        footer_height
    } else {
        static_footer_height(prev, cur)
    };
    let prev_content = crop_luma_content(prev, footer_height);
    let cur_content = crop_luma_content(cur, footer_height);
    let offset = find_scroll_offset(&prev_content, &cur_content)?;
    (offset > 0).then_some(ScrollStep {
        footer_height,
        offset,
    })
}

#[cfg(any(windows, target_os = "macos", test))]
fn frames_effectively_identical(prev: &image::GrayImage, cur: &image::GrayImage) -> bool {
    if prev.dimensions() != cur.dimensions() || prev.width() == 0 || prev.height() == 0 {
        return false;
    }
    let width = prev.width() as usize;
    let height = prev.height() as usize;
    let col_step = (width / 64).max(1);
    let row_step = (height / 128).max(1);
    let prev_raw = prev.as_raw();
    let cur_raw = cur.as_raw();
    let mut difference = 0u64;
    let mut samples = 0u64;

    for row in (0..height).step_by(row_step) {
        for col in (0..width).step_by(col_step) {
            difference += (prev_raw[row * width + col] as i32)
                .abs_diff(cur_raw[row * width + col] as i32) as u64;
            samples += 1;
        }
    }

    (difference as f64 / samples as f64) < 1.0
}

#[cfg(any(windows, target_os = "macos", test))]
fn static_footer_height(prev: &image::GrayImage, cur: &image::GrayImage) -> u32 {
    if prev.dimensions() != cur.dimensions() {
        return 0;
    }
    let width = prev.width() as usize;
    let height = prev.height() as usize;
    if width == 0 {
        return 0;
    }
    let col_step = (width / 64).max(1);
    let max_footer = height / 3;
    let prev_raw = prev.as_raw();
    let cur_raw = cur.as_raw();
    let mut footer_height = 0;

    for distance_from_bottom in 0..max_footer {
        let row = height - distance_from_bottom - 1;
        let row_start = row * width;
        let mut difference = 0u64;
        let mut samples = 0u64;
        for col in (0..width).step_by(col_step) {
            difference +=
                (prev_raw[row_start + col] as i32).abs_diff(cur_raw[row_start + col] as i32) as u64;
            samples += 1;
        }
        if difference as f64 / samples as f64 >= 1.0 {
            break;
        }
        footer_height += 1;
    }

    footer_height as u32
}

#[cfg(any(windows, target_os = "macos", test))]
fn crop_content(frame: &image::DynamicImage, footer_height: u32) -> image::DynamicImage {
    let content_height = frame.height().saturating_sub(footer_height);
    frame.crop_imm(0, 0, frame.width(), content_height)
}

#[cfg(any(windows, target_os = "macos", test))]
fn crop_luma_content(frame: &image::GrayImage, footer_height: u32) -> image::GrayImage {
    let content_height = frame.height().saturating_sub(footer_height);
    image::imageops::crop_imm(frame, 0, 0, frame.width(), content_height).to_image()
}

#[cfg(any(windows, target_os = "macos", test))]
fn append_new_rows(
    stitched: &mut Vec<image::DynamicImage>,
    frame: &image::DynamicImage,
    offset: u32,
    remaining_rows: u32,
    footer_height: u32,
) -> u32 {
    let content_height = frame.height().saturating_sub(footer_height);
    let source_start = content_height.saturating_sub(offset);
    let new_rows = offset
        .min(remaining_rows)
        .min(content_height.saturating_sub(source_start));
    if new_rows > 0 {
        stitched.push(frame.crop_imm(0, source_start, frame.width(), new_rows));
    }
    new_rows
}

#[cfg(any(windows, target_os = "macos", test))]
fn append_footer(
    stitched: &mut Vec<image::DynamicImage>,
    last_frame: &image::DynamicImage,
    footer_height: u32,
) {
    if footer_height > 0 {
        stitched.push(last_frame.crop_imm(
            0,
            last_frame.height() - footer_height,
            last_frame.width(),
            footer_height,
        ));
    }
}

#[cfg(any(windows, target_os = "macos", test))]
fn stitch_parts(parts: &[image::DynamicImage], width: u32, height: u32) -> image::RgbaImage {
    let mut canvas = image::RgbaImage::new(width, height);
    let mut y = 0u32;
    for part in parts {
        image::imageops::replace(&mut canvas, &part.to_rgba8(), 0, i64::from(y));
        y += part.height();
    }
    canvas
}

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

    let matchable_rows = height.saturating_sub(skip_top);
    if matchable_rows == 0 {
        return None;
    }
    let min_overlap = ((matchable_rows as f32 * MIN_OVERLAP_FRACTION) as usize)
        .max(row_step)
        .min(matchable_rows);
    let max_offset = matchable_rows.saturating_sub(min_overlap);
    for offset in 0..=max_offset {
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

#[cfg(any(windows, target_os = "macos"))]
fn inject_scroll(notches: i32) {
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
                    mouseData: (notches * WHEEL_DELTA) as u32,
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

        const UNITS_LINE: u32 = 1;
        const HID_EVENT_TAP: u32 = 0;
        const LINES_PER_NOTCH: i32 = 3;

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
            let event = CGEventCreateScrollWheelEvent2(
                std::ptr::null(),
                UNITS_LINE,
                1,
                notches * LINES_PER_NOTCH,
                0,
                0,
            );
            if !event.is_null() {
                CGEventPost(HID_EVENT_TAP, event);
                CFRelease(event);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use image::{DynamicImage, GenericImageView, GrayImage, Luma};

    use super::{
        MAX_STITCHED_HEIGHT, Stitch, append_footer, append_new_rows, find_scroll_offset,
        find_scroll_step, stitch_parts,
    };

    #[test]
    fn finds_a_known_scroll_offset() {
        let prev = GrayImage::from_fn(80, 120, |x, y| Luma([((x * 17 + y * 37) % 256) as u8]));
        let cur = GrayImage::from_fn(80, 120, |x, y| {
            *prev.get_pixel(x, (y + 12).min(prev.height() - 1))
        });

        assert_eq!(find_scroll_offset(&prev, &cur), Some(12));
    }

    #[test]
    fn identical_frames_have_no_scroll_offset() {
        let frame = GrayImage::from_fn(80, 120, |x, y| Luma([((x * 17 + y * 37) % 256) as u8]));

        assert_eq!(find_scroll_offset(&frame, &frame), Some(0));
    }

    #[test]
    fn unrelated_noise_has_no_matching_offset() {
        let prev = GrayImage::from_pixel(80, 120, Luma([0]));
        let cur = GrayImage::from_pixel(80, 120, Luma([255]));

        assert_eq!(find_scroll_offset(&prev, &cur), None);
    }

    #[test]
    fn identical_terminal_frame_keeps_stitched_content_and_established_footer() {
        let width = 80;
        let content_height = 260;
        let frame_height = 300;
        let footer_height = 40;
        let scroll = 150;
        let make_frame = |scroll: u32| {
            GrayImage::from_fn(width, frame_height, |x, y| {
                if y >= content_height {
                    Luma([230])
                } else {
                    let row = y + scroll;
                    Luma([((x * 17 + row * 31) % 251) as u8])
                }
            })
        };
        let prev = make_frame(0);
        let first = DynamicImage::ImageLuma8(prev);
        let scrolled = DynamicImage::ImageLuma8(make_frame(scroll));
        let terminal = scrolled.clone();
        let first_part = first.crop_imm(0, 0, width, frame_height);
        let mut stitch = Stitch {
            parts: vec![first_part],
            height: frame_height,
            footer_height: 0,
            footer_established: false,
            max_height: MAX_STITCHED_HEIGHT,
        };
        let mut previous = first.to_luma8();
        let mut last_frame = first.clone();

        for frame in [scrolled, terminal] {
            let current = frame.to_luma8();
            let Some(step) = find_scroll_step(
                &previous,
                &current,
                stitch.footer_established,
                stitch.footer_height,
            ) else {
                break;
            };
            assert_eq!(step.offset, scroll);
            assert_eq!(step.footer_height, footer_height);
            let appended = stitch.append_step(&first, &frame, step);
            assert_eq!(appended, scroll);
            last_frame = frame.clone();
            previous = current;
        }

        assert_eq!(stitch.footer_height, footer_height);
        assert!(stitch.footer_established);
        append_footer(&mut stitch.parts, &last_frame, stitch.footer_height);
        let stitched = stitch_parts(&stitch.parts, width, stitch.height + stitch.footer_height);
        assert_eq!(stitched.height(), 410 + footer_height);
        for y in 0..410 {
            for x in 0..width {
                assert_eq!(
                    stitched.get_pixel(x, y).0[0],
                    ((x * 17 + y * 31) % 251) as u8
                );
            }
        }
        for y in 410..410 + footer_height {
            for x in 0..width {
                assert_eq!(stitched.get_pixel(x, y).0[0], 230);
            }
        }
    }

    #[test]
    fn height_limit_appends_the_first_new_rows_for_the_scroll_offset() {
        let width = 80;
        let frame_height = 300;
        let footer_height = 40;
        let content_height = frame_height - footer_height;
        let offset = 150;
        let remaining_rows = 50;
        let frame = DynamicImage::ImageLuma8(GrayImage::from_fn(width, frame_height, |x, y| {
            Luma([((x * 17 + y * 31) % 251) as u8])
        }));
        let mut parts = Vec::new();

        let appended = append_new_rows(&mut parts, &frame, offset, remaining_rows, footer_height);

        assert_eq!(appended, remaining_rows);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].height(), remaining_rows);
        for y in 0..remaining_rows {
            for x in 0..width {
                assert_eq!(
                    parts[0].get_pixel(x, y).0[0],
                    ((x * 17 + (content_height - offset + y) * 31) % 251) as u8
                );
            }
        }
    }
}
