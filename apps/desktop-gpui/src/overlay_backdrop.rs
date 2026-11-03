//! The desktop under a picker overlay, for the overlay's glass to read.
//!
//! The overlay is a transparent window, so its glass panes would otherwise
//! read only the overlay's own dimming. The overlay asks the window server
//! to leave it out of screen captures for a moment (`NSWindowSharingNone`
//! on macOS, `WDA_EXCLUDEFROMCAPTURE` on Windows: neither changes what is on
//! screen), captures its display, and paints that capture beneath its panes
//! through [`crate::ui::glass::Backdrop`].
//!
//! Linux has no way to leave a window out of a capture short of unmapping
//! it, so its panes keep the plain fallback fill.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};

use gpui::{AsyncApp, RenderImage, Window};
use scap_targets::DisplayId;

/// A capture older than this is retaken the next time the overlay draws.
pub const STALE_AFTER: Duration = Duration::from_secs(3);

/// How long the panels must hold still before a stale capture is retaken.
pub const SETTLE: Duration = Duration::from_millis(400);

/// The longest a capture may take before the panes give up on it.
const TIMEOUT: Duration = Duration::from_millis(1500);

/// How long the main thread runs between leaving the overlay out of captures
/// and capturing. The window server only learns of the change once the run
/// loop turns over: a capture started straight away held the overlay every
/// time on macOS 27, and painted its dimming back under itself. One frame was
/// enough there; this leaves margin.
const EXCLUDE_SETTLE: Duration = Duration::from_millis(40);

pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// Set by the picker probe to measure the picker without captures.
static DISABLED: AtomicBool = AtomicBool::new(false);

/// How long the last capture took, start to GPU-ready image, for the probe.
static LAST_CAPTURE_MS: AtomicU64 = AtomicU64::new(0);

pub fn enabled() -> bool {
    SUPPORTED && !DISABLED.load(Ordering::Relaxed)
}

#[cfg(debug_assertions)]
pub fn set_disabled(disabled: bool) {
    DISABLED.store(disabled, Ordering::Relaxed);
}

#[cfg(debug_assertions)]
pub fn last_capture_ms() -> u64 {
    LAST_CAPTURE_MS.load(Ordering::Relaxed)
}

#[cfg(target_os = "macos")]
const CAPTURE_HIDDEN: usize = 0;
#[cfg(windows)]
const CAPTURE_HIDDEN: usize =
    windows_sys::Win32::UI::WindowsAndMessaging::WDA_EXCLUDEFROMCAPTURE as usize;

/// Leave `window` out of screen captures, or put it back. True when the
/// window server now leaves it out: a Windows remote session keeps windows
/// in captures, and then a capture would hold the overlay itself.
#[cfg(any(target_os = "macos", windows))]
fn set_capture_hidden(window: &crate::platform::NativeWindow, hidden: bool) -> bool {
    let reported = crate::platform::set_window_capture_hidden(window, hidden);
    !hidden || reported == CAPTURE_HIDDEN
}

/// Capture `display` with `window` (the overlay on it) left out, at the
/// display's full resolution, ready for the GPU. `None` when the platform
/// cannot leave the overlay out or the capture fails.
///
/// `above` are Cap windows that sit over the overlay (the camera bubble):
/// they are left out too, or the capture would keep them where they were
/// and show them there after they move. One already left out (a Studio
/// camera is) stays that way.
pub async fn capture(
    window: Option<crate::platform::NativeWindow>,
    above: Vec<crate::platform::NativeWindow>,
    display: DisplayId,
    cx: &mut AsyncApp,
) -> Option<Arc<RenderImage>> {
    #[cfg(any(target_os = "macos", windows))]
    {
        let window = window?;
        // The overlay must be hidden from captures before one starts and
        // shown again whatever happens to it, so both run here on the main
        // thread with no gpui borrow held: AppKit calls back into gpui.
        if !set_capture_hidden(&window, true) {
            set_capture_hidden(&window, false);
            tracing::debug!("overlay backdrop: this session keeps windows in captures");
            return None;
        }
        let above: Vec<_> = above
            .into_iter()
            .filter(|window| !crate::platform::window_capture_hidden(window))
            .collect();
        for window in &above {
            set_capture_hidden(window, true);
        }
        cx.background_executor().timer(EXCLUDE_SETTLE).await;
        let started = std::time::Instant::now();
        let image = capture_bgra(display, cx).await;
        set_capture_hidden(&window, false);
        for window in &above {
            set_capture_hidden(window, false);
        }
        let image = Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
            image?
        )]));
        let elapsed_ms = started.elapsed().as_millis() as u64;
        LAST_CAPTURE_MS.store(elapsed_ms, Ordering::Relaxed);
        tracing::debug!(elapsed_ms, "overlay backdrop captured");
        Some(image)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, above, display, cx);
        None
    }
}

/// The display's pixels in gpui's BGRA order. macOS hands them over in
/// that order already; elsewhere the shared screenshot path is RGB.
#[cfg(target_os = "macos")]
async fn capture_bgra(display: DisplayId, cx: &mut AsyncApp) -> Option<image::RgbaImage> {
    let captured = cx
        .background_executor()
        .spawn(async move { mac::display_bgra(&display) });
    let timeout = cx.background_executor().timer(TIMEOUT);
    match futures_util::future::select(std::pin::pin!(captured), std::pin::pin!(timeout)).await {
        futures_util::future::Either::Left((image, _)) => image,
        futures_util::future::Either::Right(_) => {
            tracing::debug!("overlay backdrop: capture timed out");
            None
        }
    }
}

#[cfg(windows)]
async fn capture_bgra(display: DisplayId, cx: &mut AsyncApp) -> Option<image::RgbaImage> {
    let captured = gpui_tokio::Tokio::spawn(cx, async move {
        tokio::time::timeout(
            TIMEOUT,
            cap_recording::screenshot::capture_screenshot(
                cap_recording::sources::screen_capture::ScreenCaptureTarget::Display {
                    id: display,
                },
            ),
        )
        .await
    })
    .await;
    let image = match captured {
        Ok(Ok(Ok(image))) => image,
        Ok(Ok(Err(error))) => {
            tracing::debug!("overlay backdrop: capture failed: {error:#}");
            return None;
        }
        Ok(Err(_)) => {
            tracing::debug!("overlay backdrop: capture timed out");
            return None;
        }
        Err(error) => {
            tracing::debug!(%error, "overlay backdrop: capture task failed");
            return None;
        }
    };
    cx.background_executor()
        .spawn(async move {
            let mut image = image.into_rgba8();
            cap_gpui_kernels::frame::swap_red_blue(&mut image);
            image
        })
        .await
        .into()
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use core_foundation::base::TCFType;
    use core_foundation::data::{CFData, CFDataRef};
    use scap_targets::DisplayId;

    type CGImageRef = *const c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGDisplayCreateImage(display: u32) -> CGImageRef;
        fn CGImageGetWidth(image: CGImageRef) -> usize;
        fn CGImageGetHeight(image: CGImageRef) -> usize;
        fn CGImageGetBytesPerRow(image: CGImageRef) -> usize;
        fn CGImageGetBitsPerPixel(image: CGImageRef) -> usize;
        fn CGImageGetDataProvider(image: CGImageRef) -> *const c_void;
        fn CGDataProviderCopyData(provider: *const c_void) -> CFDataRef;
        fn CGImageRelease(image: CGImageRef);
    }

    /// Display images are 32-bit little-endian with the alpha byte skipped,
    /// so in memory they are BGRX: one copy per row, and alpha set opaque.
    pub fn display_bgra(display: &DisplayId) -> Option<image::RgbaImage> {
        let display = scap_targets::Display::from_id(display)?;
        let image = unsafe { CGDisplayCreateImage(display.raw_handle().inner().id) };
        if image.is_null() {
            return None;
        }
        let pixels = unsafe {
            let (width, height) = (CGImageGetWidth(image), CGImageGetHeight(image));
            let stride = CGImageGetBytesPerRow(image);
            let data = (CGImageGetBitsPerPixel(image) == 32)
                .then(|| CGDataProviderCopyData(CGImageGetDataProvider(image)))
                .filter(|data| !data.is_null())
                .map(|data| CFData::wrap_under_create_rule(data));
            CGImageRelease(image);
            let data = data?;
            let bytes = data.bytes();
            if width == 0 || height == 0 || stride < width * 4 || bytes.len() < stride * height {
                return None;
            }
            let mut pixels = Vec::with_capacity(width * height * 4);
            for row in bytes.chunks_exact(stride).take(height) {
                pixels.extend_from_slice(&row[..width * 4]);
            }
            for pixel in pixels.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            image::RgbaImage::from_raw(width as u32, height as u32, pixels)
        };
        pixels
    }
}

/// Whether a capture of `size` pixels can stand in for an overlay drawn at
/// `logical` points: the same shape, within a pixel's rounding.
pub fn fits(size: (u32, u32), logical: (f32, f32)) -> bool {
    if size.0 == 0 || size.1 == 0 || logical.0 <= 0. || logical.1 <= 0. {
        return false;
    }
    let scale_x = size.0 as f32 / logical.0;
    let scale_y = size.1 as f32 / logical.1;
    (scale_x / scale_y - 1.).abs() < 0.01
}

/// The overlay's own window, for [`capture`].
pub fn native(window: &Window) -> Option<crate::platform::NativeWindow> {
    crate::platform::native_window(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_fits_an_overlay_of_the_same_shape() {
        assert!(fits((3024, 1964), (1512., 982.)));
        assert!(fits((1920, 1080), (1920., 1080.)));
        assert!(fits((3841, 2160), (1920., 1080.)));
        assert!(!fits((1920, 1200), (1920., 1080.)));
        assert!(!fits((0, 1080), (1920., 1080.)));
        assert!(!fits((1920, 1080), (0., 1080.)));
    }
}
