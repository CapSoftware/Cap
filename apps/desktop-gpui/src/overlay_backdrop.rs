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

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{AsyncApp, RenderImage, Window};
use scap_targets::DisplayId;

/// A capture older than this is retaken the next time the overlay draws.
pub const STALE_AFTER: Duration = Duration::from_secs(3);

/// The longest a capture may take before the panes give up on it.
const TIMEOUT: Duration = Duration::from_millis(1500);

/// Whether this platform can capture the desktop without the overlay.
pub const SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

/// Set by the picker probe to measure the picker without captures.
static DISABLED: AtomicBool = AtomicBool::new(false);

/// How long the last capture took, start to GPU-ready image, for the probe.
static LAST_CAPTURE_MS: AtomicU64 = AtomicU64::new(0);

/// Whether overlays capture the desktop for their glass.
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
pub async fn capture(
    window: Option<crate::platform::NativeWindow>,
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
        let started = std::time::Instant::now();
        let captured = gpui_tokio::Tokio::spawn(cx, async move {
            tokio::time::timeout(
                TIMEOUT,
                cap_recording::screenshot::capture_screenshot(ScreenCaptureTarget::Display {
                    id: display,
                }),
            )
            .await
        })
        .await;
        set_capture_hidden(&window, false);
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
        let image = cx
            .background_executor()
            .spawn(async move { crate::library::rgba_to_render_image(image.into_rgba8()) })
            .await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        LAST_CAPTURE_MS.store(elapsed_ms, Ordering::Relaxed);
        tracing::debug!(elapsed_ms, "overlay backdrop captured");
        Some(image)
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (window, display, cx);
        None
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
