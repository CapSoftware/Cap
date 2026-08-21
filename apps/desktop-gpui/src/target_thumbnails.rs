//! Live thumbnails for the display and window pickers.
//!
//! A port of the Tauri app's `thumbnails` module
//! (`apps/desktop/src-tauri/src/thumbnails/{mod,mac}.rs`) plus the refresh
//! policy the frontend wraps around it (`utils/queries.ts:29-77` and
//! `routes/(window-chrome)/new-main/index.tsx`).
//!
//! What is ported literally:
//!
//! * `THUMBNAIL_WIDTH`/`THUMBNAIL_HEIGHT` = 320x180 (`mod.rs:21-22`) and
//!   `normalize_thumbnail_dimensions` (`mod.rs:44-87`) — a uniform Lanczos3
//!   downscale to *fit* 320x180, centre-composited onto a fully transparent
//!   320x180 canvas. Never upscales past the box, but *does* upscale a smaller
//!   source: the scale is `min(320/w, 180/h)` with no `.min(1.0)` clamp, so a
//!   160x90 capture comes back as a full-bleed 320x180.
//! * The capture itself (`mac.rs:7-42`): a display filter with **no** window
//!   exclusions — Cap's own windows deliberately appear in display thumbnails —
//!   a `with_desktop_independent_window` filter for windows, and an
//!   `sc::StreamCfg` sized 320x180 with the cursor hidden, handed to
//!   `sc::ScreenshotManager::capture_sample_buf`. The pixel buffer is asked for
//!   at thumbnail size, so nothing full-resolution is ever read back.
//! * The pixel conversions (`mac.rs:111-275`): the four 32-bit channel orders
//!   and video-range NV12, through the same RAII `CVPixelBufferLock`.
//! * Sequencing: one shareable-content fetch per batch and one capture at a
//!   time (`mod.rs:88-137` is a plain `for` loop; there is no concurrency to
//!   port, and SCK screenshots do not like being fanned out).
//! * The refresh policy: 5s cheap-list staleness, 10s thumbnail staleness, an
//!   idle prewarm shortly after launch, and signature-driven refetch while a
//!   picker is open (see the constants and `*_signature` below).
//!
//! Deliberate deviations:
//!
//! * No base64 and no PNG round-trip. The Tauri command has to hand bytes to a
//!   webview; here the RGBA buffer goes straight to `RenderImage`, which skips
//!   a PNG encode and a base64 encode per target per refresh.
//! * Results stream out of the batch one target at a time instead of landing as
//!   one `Vec` at the end. The order and the concurrency are unchanged — this
//!   only means a 40-window picker fills in progressively instead of staying
//!   blank for the whole sweep, which a single IPC reply could not do.
//! * App icons cross the channel as PNG bytes rather than as `gpui::Image`; the
//!   wrap is free and it keeps the capture future's captured state boring.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use gpui::RenderImage;
use image::RgbaImage;
use scap_targets::{DisplayId, WindowId};

use crate::devices::{DisplayOption, WindowOption};

/// `THUMBNAIL_WIDTH` (`thumbnails/mod.rs:21`).
pub const THUMBNAIL_WIDTH: u32 = 320;
/// `THUMBNAIL_HEIGHT` (`thumbnails/mod.rs:22`).
pub const THUMBNAIL_HEIGHT: u32 = 180;

/// `CAPTURE_LIST_STALE_TIME` (`new-main/index.tsx:131`) — how often the cheap,
/// thumbnail-less target list is re-read while a picker is open.
pub const LIST_STALE_TIME: Duration = Duration::from_secs(5);

/// `CAPTURE_THUMBNAIL_STALE_TIME` (`new-main/index.tsx:133`), which is also the
/// `refetchInterval` on `listDisplaysWithThumbnails` (`utils/queries.ts:75`)
/// that the editor sidebar inherits — display thumbnails go stale on a timer,
/// window thumbnails only on a signature change.
pub const THUMBNAIL_STALE_TIME: Duration = Duration::from_secs(10);

/// `window.setTimeout(run, 250)` — the fallback branch of
/// `scheduleTargetListPrewarm` (`new-main/index.tsx:1955-1959`). gpui has no
/// `requestIdleCallback`, so the fallback *is* the implementation; the 1500ms
/// idle timeout is the deadline that branch would have used anyway.
pub const PREWARM_DELAY: Duration = Duration::from_millis(250);

/// A card's images. Both halves are optional and independent: a window can have
/// an icon and no thumbnail (capture refused) or the reverse (no bundle icon).
#[derive(Clone, Default)]
pub struct TargetThumb {
    pub image: Option<Arc<RenderImage>>,
    pub app_icon: Option<Arc<gpui::Image>>,
}

/// One display's worth of progress from a capture batch.
pub enum DisplayEvent {
    /// The freshly enumerated list this batch is capturing from, sent before
    /// the first capture. `collect_displays_with_thumbnails` re-lists rather
    /// than trusting the caller's list (`thumbnails/mod.rs:91`), so the rows and
    /// their thumbnails always agree.
    Listed(Vec<DisplayOption>),
    Captured(DisplayId, Arc<RenderImage>),
}

/// One window's worth of progress from a capture batch.
pub enum WindowEvent {
    Listed(Vec<WindowOption>),
    Captured {
        id: WindowId,
        image: Option<Arc<RenderImage>>,
        /// Raw PNG bytes from `Window::app_icon()` (`thumbnails/mod.rs:113-122`).
        app_icon: Option<Vec<u8>>,
    },
}

/// Per-view thumbnail state.
///
/// Deliberately *not* an app-global. gpui's sprite atlas is per-window
/// (`Window::drop_image` evicts from the calling window's atlas only), so an
/// `Arc<RenderImage>` shared between the main window and the editor would need
/// every eviction fanned out to every window that had ever painted it. Keeping
/// one cache per view makes replacement a local `window.drop_image(old)`, the
/// same shape `MainWindow::set_recents` already uses.
///
/// It also happens to be what the Tauri app does: the main window and the
/// editor are separate webviews with separate TanStack `QueryClient`s, so
/// `listWindowsWithThumbnails` is cached — and captured — once per window there
/// too.
#[derive(Default)]
pub struct ThumbnailCache {
    displays: HashMap<String, Arc<RenderImage>>,
    windows: HashMap<String, TargetThumb>,
    /// Signature of the list the cached display thumbnails were captured from.
    display_signature: Option<String>,
    window_signature: Option<String>,
    display_inflight: bool,
    window_inflight: bool,
    /// Set once the launch prewarm has been scheduled, so it never runs twice.
    prewarmed: bool,
}

impl ThumbnailCache {
    pub fn display(&self, id: &DisplayId) -> TargetThumb {
        TargetThumb {
            image: self.displays.get(&id.to_string()).cloned(),
            app_icon: None,
        }
    }

    pub fn window(&self, id: &WindowId) -> TargetThumb {
        self.windows
            .get(&id.to_string())
            .cloned()
            .unwrap_or_default()
    }

    /// Install a display thumbnail, handing back whatever it replaced so the
    /// caller can evict it from the window's atlas.
    #[must_use = "the replaced image has to be dropped from the window's atlas"]
    pub fn insert_display(
        &mut self,
        id: &DisplayId,
        image: Arc<RenderImage>,
    ) -> Option<Arc<RenderImage>> {
        self.displays.insert(id.to_string(), image)
    }

    #[must_use = "the replaced image has to be dropped from the window's atlas"]
    pub fn insert_window(
        &mut self,
        id: &WindowId,
        image: Option<Arc<RenderImage>>,
        app_icon: Option<Arc<gpui::Image>>,
    ) -> Option<Arc<RenderImage>> {
        let slot = self.windows.entry(id.to_string()).or_default();
        // A refresh that failed to capture must not blank a thumbnail that is
        // already on screen: only a real capture replaces one. Same for the
        // icon, which the Tauri card keeps for the life of the row.
        let replaced = match image {
            Some(image) => slot.image.replace(image),
            None => None,
        };
        if app_icon.is_some() {
            slot.app_icon = app_icon;
        }
        replaced
    }

    /// Drop cache entries for targets that are no longer in the list, handing
    /// the images back for atlas eviction. Reconciliation is by id, so a
    /// refresh only ever *adds* to what is already showing.
    #[must_use = "the pruned images have to be dropped from the window's atlas"]
    pub fn retain_displays(&mut self, list: &[DisplayOption]) -> Vec<Arc<RenderImage>> {
        let live: std::collections::HashSet<String> =
            list.iter().map(|display| display.id.to_string()).collect();
        let mut dropped = Vec::new();
        self.displays.retain(|id, image| {
            if live.contains(id) {
                true
            } else {
                dropped.push(image.clone());
                false
            }
        });
        dropped
    }

    #[must_use = "the pruned images have to be dropped from the window's atlas"]
    pub fn retain_windows(&mut self, list: &[WindowOption]) -> Vec<Arc<RenderImage>> {
        let live: std::collections::HashSet<String> =
            list.iter().map(|window| window.id.to_string()).collect();
        let mut dropped = Vec::new();
        self.windows.retain(|id, thumb| {
            if live.contains(id) {
                true
            } else {
                dropped.extend(thumb.image.clone());
                false
            }
        });
        dropped
    }

    /// Empty the cache, handing back every image for atlas eviction.
    ///
    /// Clears the in-flight flags as well, because the only caller that resets
    /// is one that is also dropping the tasks those flags belong to (the record
    /// modal reopening). Leaving a flag set behind a dropped task would wedge
    /// that kind's refresh permanently. A sweep whose `flume` receiver went
    /// with the task stops at its next `send`, so at worst one extra screenshot
    /// overlaps the new sweep.
    #[must_use = "the images have to be dropped from the window's atlas"]
    pub fn reset(&mut self) -> Vec<Arc<RenderImage>> {
        let mut images: Vec<_> = self.displays.drain().map(|(_, image)| image).collect();
        images.extend(self.windows.drain().filter_map(|(_, thumb)| thumb.image));
        self.display_signature = None;
        self.window_signature = None;
        self.display_inflight = false;
        self.window_inflight = false;
        images
    }

    pub fn display_inflight(&self) -> bool {
        self.display_inflight
    }

    pub fn window_inflight(&self) -> bool {
        self.window_inflight
    }

    pub fn set_display_inflight(&mut self, inflight: bool) {
        self.display_inflight = inflight;
    }

    pub fn set_window_inflight(&mut self, inflight: bool) {
        self.window_inflight = inflight;
    }

    /// `displayThumbnailsSignature` (`new-main/index.tsx:2617-2620`): the
    /// signature of the list the last successful capture ran against.
    pub fn set_display_signature(&mut self, signature: String) {
        self.display_signature = Some(signature);
    }

    pub fn set_window_signature(&mut self, signature: String) {
        self.window_signature = Some(signature);
    }

    /// The `signature !== undefined && thumbnailsSignature() !== signature`
    /// half of the refetch effects (`new-main/index.tsx:2621-2639`).
    pub fn displays_stale(&self, list: &[DisplayOption]) -> bool {
        self.display_signature.as_deref() != Some(display_signature(list).as_str())
    }

    pub fn windows_stale(&self, list: &[WindowOption]) -> bool {
        self.window_signature.as_deref() != Some(window_signature(list).as_str())
    }

    /// `cancelScheduledTargetListPrewarm` guards the Tauri prewarm against
    /// re-entry; this is the same one-shot latch.
    pub fn take_prewarm(&mut self) -> bool {
        if self.prewarmed {
            return false;
        }
        self.prewarmed = true;
        true
    }
}

/// The card's thumbnail block, shared by the main window's picker and the
/// editor's "record a new clip" picker because both render `TargetCard`.
///
/// A 1:1 read of `TargetCard.tsx:366-401`:
///
/// * `relative h-19 w-full overflow-hidden bg-gray-4/40` — the 76px block.
/// * the thumbnail as `object-cover w-full h-full`, or, when there is none (or
///   the `<img>` errored), `flex items-center justify-center bg-gray-4` with a
///   24px icon at `text-gray-9 opacity-70`.
/// * the app icon `absolute inset-0` on a `bg-black/45` scrim, drawn
///   `h-16 w-16 max-h-[55%] max-w-[55%] rounded-lg border border-black/20
///   object-contain`. 55% of 76px is what actually binds, so it lands at ~42px.
/// * `absolute inset-0 border border-black/5 opacity-60` — a hairline that
///   keeps a pale thumbnail from bleeding into the card.
/// * `absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-black/40` — the
///   scrim under the labels.
///
/// The card's `overflow-hidden rounded-lg` does the corner clipping in the
/// Tauri app. gpui content masks are rectangles — a child's paint (and an
/// `img()` above all) is *not* clipped to the parent's rounded corners — so
/// every full-bleed layer here carries the card's top rounding itself: 7px,
/// the card's 8px radius minus the 1px border the slot sits inside. The
/// slot's bottom edge is mid-card and stays square, exactly like the `h-19`
/// block over there.
pub fn render_thumbnail_slot(
    thumb: TargetThumb,
    icon: &'static str,
    theme: crate::theme::Theme,
) -> gpui::Div {
    use gpui::prelude::FluentBuilder as _;
    use gpui::{
        Hsla, IntoElement as _, ParentElement as _, Styled as _, StyledImage as _, div, hsla, img,
        linear_color_stop, linear_gradient, px, svg,
    };

    let black = |alpha: f32| hsla(0., 0., 0., alpha);
    // The inner corner radius: the card is `rounded(8.)` with a 1px border.
    const TOP_RADIUS: f32 = 7.;

    div()
        .relative()
        .w_full()
        .h(px(76.))
        .overflow_hidden()
        .rounded_t(px(TOP_RADIUS))
        .bg(theme.body_fill(4))
        .child(match thumb.image {
            Some(image) => img(image)
                .size_full()
                .object_fit(gpui::ObjectFit::Cover)
                .rounded_t(px(TOP_RADIUS))
                .into_any_element(),
            None => div()
                .flex()
                .size_full()
                .items_center()
                .justify_center()
                .rounded_t(px(TOP_RADIUS))
                .bg(theme.body_fill(4))
                .child(
                    // `svg()` does not inherit `text_color`; the fallback icon
                    // has to set its own or it paints black.
                    svg()
                        .path(icon)
                        .size(px(24.))
                        .text_color(Hsla::from(theme.gray_9)),
                )
                .into_any_element(),
        })
        .when_some(thumb.app_icon, |this, app_icon| {
            this.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_t(px(TOP_RADIUS))
                    .bg(black(0.45))
                    .child(
                        img(app_icon)
                            .w(px(64.))
                            .h(px(64.))
                            .max_w(gpui::relative(0.55))
                            .max_h(gpui::relative(0.55))
                            .rounded(px(8.))
                            .border_1()
                            .border_color(black(0.2))
                            .object_fit(gpui::ObjectFit::Contain),
                    ),
            )
        })
        .child(
            div()
                .absolute()
                .inset_0()
                .rounded_t(px(TOP_RADIUS))
                .border_1()
                // `border-black/5` under `opacity-60`.
                .border_color(black(0.03)),
        )
        .child(
            div()
                .absolute()
                .bottom_0()
                .left_0()
                .right_0()
                .h(px(40.))
                .bg(linear_gradient(
                    0.,
                    linear_color_stop(black(0.4), 0.),
                    linear_color_stop(black(0.), 1.),
                )),
        )
}

/// `createWindowSignature` (`new-main/index.tsx:376-398`): every field that can
/// change what a window's thumbnail should look like, joined per item with `:`
/// and across items with `|`.
///
/// The join characters and the field order are the source's; the *numeric*
/// formatting is Rust's, because the string never leaves this process — it is
/// only ever compared against another string this function produced.
pub fn window_signature(list: &[WindowOption]) -> String {
    list.iter()
        .map(|window| {
            let (x, y) = window.position.unwrap_or((0., 0.));
            let (width, height) = window.size.unwrap_or((0, 0));
            format!(
                "{}:{}:{}:{}:{}:{}:{}:{}",
                window.id,
                window.app,
                window.label,
                x,
                y,
                width,
                height,
                window.refresh_rate.unwrap_or(0.),
            )
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// `createDisplaySignature` (`new-main/index.tsx:400-408`): id, name, refresh
/// rate. A display has no position to move to, so those three are the whole
/// identity as far as its thumbnail is concerned.
pub fn display_signature(list: &[DisplayOption]) -> String {
    list.iter()
        .map(|display| format!("{}:{}:{}", display.id, display.label, display.refresh_rate))
        .collect::<Vec<_>>()
        .join("|")
}

/// The content rect inside ScreenCaptureKit's 320x180 screenshot buffer: the
/// source's aspect ratio fitted inside 320x180.
///
/// `SCScreenshotManager` scales the content to FIT the flat 320x180 request,
/// anchors it at the buffer's top-left, and pads the right/bottom with opaque
/// black; since the buffer comes back exactly 320x180,
/// [`normalize_thumbnail_dimensions`]'s early return would keep that padding
/// where SCK put it -- on a card the black bar reads as a broken corner
/// radius down the right side. The capture path crops the buffer to this rect
/// before normalizing, so the letterbox bars end up transparent and centred
/// (the card's slot background shows through, as in the Tauri picker).
/// Requesting this size FROM SCK instead is not an option: for some sizes
/// `capture_sample_buf` never resolves -- no error, the future hangs.
pub fn fitted_capture_size(source: Option<(f64, f64)>) -> (usize, usize) {
    let Some((width, height)) = source else {
        return (THUMBNAIL_WIDTH as usize, THUMBNAIL_HEIGHT as usize);
    };
    if width <= 0. || height <= 0. {
        return (THUMBNAIL_WIDTH as usize, THUMBNAIL_HEIGHT as usize);
    }
    let scale = (THUMBNAIL_WIDTH as f64 / width).min(THUMBNAIL_HEIGHT as f64 / height);
    (
        (width * scale).round().clamp(1., THUMBNAIL_WIDTH as f64) as usize,
        (height * scale).round().clamp(1., THUMBNAIL_HEIGHT as f64) as usize,
    )
}

/// `normalize_thumbnail_dimensions` (`thumbnails/mod.rs:44-87`), verbatim.
pub fn normalize_thumbnail_dimensions(image: &RgbaImage) -> RgbaImage {
    let width = image.width();
    let height = image.height();

    if width == THUMBNAIL_WIDTH && height == THUMBNAIL_HEIGHT {
        return image.clone();
    }

    if width == 0 || height == 0 {
        return RgbaImage::from_pixel(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, image::Rgba([0, 0, 0, 0]));
    }

    let scale = (THUMBNAIL_WIDTH as f32 / width as f32)
        .min(THUMBNAIL_HEIGHT as f32 / height as f32)
        .max(f32::MIN_POSITIVE);

    let scaled_width = (width as f32 * scale)
        .round()
        .clamp(1.0, THUMBNAIL_WIDTH as f32) as u32;
    let scaled_height = (height as f32 * scale)
        .round()
        .clamp(1.0, THUMBNAIL_HEIGHT as f32) as u32;

    let resized = image::imageops::resize(
        image,
        scaled_width.max(1),
        scaled_height.max(1),
        image::imageops::FilterType::Lanczos3,
    );

    let mut canvas =
        RgbaImage::from_pixel(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, image::Rgba([0, 0, 0, 0]));

    let offset_x = (THUMBNAIL_WIDTH - scaled_width) / 2;
    let offset_y = (THUMBNAIL_HEIGHT - scaled_height) / 2;

    image::imageops::overlay(&mut canvas, &resized, offset_x as i64, offset_y as i64);

    canvas
}

/// Run a capture sweep somewhere it is allowed to be non-`Send`.
///
/// `sc::ScreenshotManager::capture_sample_buf` holds `&sc::ContentFilter` across
/// its await, and cidre's ObjC handles are `Send` but not `Sync`, so the sweep's
/// future is not `Send` and a multi-threaded tokio worker will not take it. It
/// gets a blocking thread with its own single-threaded runtime instead: the
/// completion block fires on ScreenCaptureKit's dispatch queue and only has to
/// wake a local waker, so nothing in here needs the app's reactor.
///
/// The consequence is that a sweep cannot be aborted mid-capture — dropping the
/// caller's task closes the `flume` receiver instead, and the very next `send`
/// ends the loop. Sweeps are one capture deep, so that is at most one wasted
/// screenshot.
async fn run_capture<F, Fut>(make: F)
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()>,
{
    let joined = tokio::task::spawn_blocking(move || {
        match tokio::runtime::Builder::new_current_thread().build() {
            Ok(runtime) => runtime.block_on(make()),
            Err(error) => tracing::error!("could not start the thumbnail runtime: {error}"),
        }
    })
    .await;
    if let Err(error) = joined {
        tracing::error!("thumbnail capture task failed: {error}");
    }
}

/// Enumerate the displays, then capture each one in turn, streaming the
/// results. `collect_displays_with_thumbnails` (`thumbnails/mod.rs:88-105`).
pub async fn capture_displays(events: flume::Sender<DisplayEvent>) {
    run_capture(move || capture_displays_inner(events)).await
}

/// The window twin. `collect_windows_with_thumbnails` (`thumbnails/mod.rs:107-137`)
/// also reads `Window::app_icon()` per row, which is what the card's centred
/// icon-on-scrim overlay paints.
pub async fn capture_windows(events: flume::Sender<WindowEvent>) {
    run_capture(move || capture_windows_inner(events)).await
}

async fn capture_displays_inner(events: flume::Sender<DisplayEvent>) {
    let targets = crate::devices::list_display_targets();
    if events
        .send(DisplayEvent::Listed(
            targets.iter().map(|(option, _)| option.clone()).collect(),
        ))
        .is_err()
    {
        return;
    }

    let Some(content) = shareable_content().await else {
        return;
    };

    let total = targets.len();
    let mut captured = 0usize;
    for (option, display) in targets {
        let Some(rgba) = capture_display_thumbnail(&display, content.retained()).await else {
            tracing::debug!(id = %option.id, "display thumbnail capture missed");
            continue;
        };
        captured += 1;
        if events
            .send(DisplayEvent::Captured(
                option.id,
                crate::library::rgba_to_render_image(rgba),
            ))
            .is_err()
        {
            return;
        }
    }
    tracing::debug!(captured, total, "display thumbnail sweep finished");
}

async fn capture_windows_inner(events: flume::Sender<WindowEvent>) {
    let targets = crate::devices::list_window_targets();
    let total = targets.len();
    let mut captured = 0usize;
    if events
        .send(WindowEvent::Listed(
            targets.iter().map(|(option, _)| option.clone()).collect(),
        ))
        .is_err()
    {
        return;
    }

    let Some(content) = shareable_content().await else {
        return;
    };

    for (option, window) in targets {
        let image = capture_window_thumbnail(&window, content.retained())
            .await
            .map(crate::library::rgba_to_render_image);
        let app_icon = window.app_icon().filter(|bytes| !bytes.is_empty());
        if image.is_some() {
            captured += 1;
        }
        if image.is_none() && app_icon.is_none() {
            tracing::debug!(id = %option.id, app = %option.app, "window thumbnail capture missed");
            continue;
        }
        if events
            .send(WindowEvent::Captured {
                id: option.id,
                image,
                app_icon,
            })
            .is_err()
        {
            return;
        }
    }
    tracing::debug!(captured, total, "window thumbnail sweep finished");
}

// -- macOS capture ---------------------------------------------------------

#[cfg(target_os = "macos")]
mod platform {
    use cidre::{arc, cv, sc};
    use image::RgbaImage;
    use tracing::warn;

    use super::normalize_thumbnail_dimensions;

    /// The shareable content one capture batch shares, the way
    /// `capture_*_thumbnail` in `thumbnails/mac.rs:7-20` shares the Tauri app's
    /// cached `get_shareable_content()`. This app has no such cache, so the
    /// batch fetches once and hands the same handle to every target rather than
    /// paying for a window-server round trip per card.
    ///
    /// The `current_process` fallback is `recording.rs:684-697`'s: a machine
    /// that has not granted screen recording yet answers `current()` with an
    /// empty display list.
    pub async fn shareable_content() -> Option<arc::R<sc::ShareableContent>> {
        match sc::ShareableContent::current().await {
            Ok(content) if !content.displays().is_empty() => {
                tracing::debug!(
                    displays = content.displays().len(),
                    windows = content.windows().len(),
                    "thumbnail sweep shareable content"
                );
                Some(content)
            }
            Ok(content) => match sc::ShareableContent::current_process().await {
                Ok(process) if !process.displays().is_empty() => Some(process),
                // Empty content resolves every capture to a silent `None`;
                // say so once per sweep or a permission gap looks like a
                // rendering bug.
                _ => {
                    warn!(
                        "shareable content came back empty; thumbnail captures will all miss \
                         (screen-recording permission?)"
                    );
                    Some(content)
                }
            },
            Err(error) => {
                warn!(error = ?error, "could not read shareable content for thumbnails");
                None
            }
        }
    }

    /// `capture_display_thumbnail` (`mac.rs:7-12`).
    ///
    /// `as_content_filter` excludes nothing, which is not an oversight: Cap's
    /// own windows show up in display thumbnails in the Tauri app and the
    /// picker is expected to look the same here.
    pub async fn capture_display_thumbnail(
        display: &scap_targets::Display,
        content: arc::R<sc::ShareableContent>,
    ) -> Option<RgbaImage> {
        let size = display
            .physical_size()
            .map(|size| (size.width(), size.height()));
        let filter = display.raw_handle().as_content_filter(content)?;
        capture_thumbnail_from_filter(filter, super::fitted_capture_size(size)).await
    }

    /// `capture_window_thumbnail` (`mac.rs:14-20`).
    pub async fn capture_window_thumbnail(
        window: &scap_targets::Window,
        content: arc::R<sc::ShareableContent>,
    ) -> Option<RgbaImage> {
        let size = window
            .physical_size()
            .map(|size| (size.width(), size.height()));
        let sc_window = window.raw_handle().as_sc(content)?;
        let filter = sc::ContentFilter::with_desktop_independent_window(&sc_window);
        capture_thumbnail_from_filter(filter, super::fitted_capture_size(size)).await
    }

    /// `capture_thumbnail_from_filter` (`mac.rs:22-109`) minus the PNG/base64
    /// tail, which only existed to cross the IPC boundary into a webview.
    ///
    /// The request is always the flat 320x180 the Tauri code asks for.
    /// `SCScreenshotManager` scales the content to FIT that buffer, anchors
    /// it top-left, and pads the rest with opaque black -- which is where the
    /// picker's black-bar-over-the-card-corner artifact came from. Asking SCK
    /// for the aspect-fitted size instead looked cleaner but capture_sample_buf
    /// NEVER RESOLVES for some sizes (no error, the future just hangs; every
    /// sweep in the app silently froze) -- so the padding is cropped off after
    /// conversion instead: the content rect is exactly
    /// [`fitted_capture_size`]'s dims at the buffer's top-left, and
    /// [`normalize_thumbnail_dimensions`] then letterboxes the cropped image
    /// onto the transparent canvas, centred.
    async fn capture_thumbnail_from_filter(
        filter: arc::R<sc::ContentFilter>,
        (content_width, content_height): (usize, usize),
    ) -> Option<RgbaImage> {
        let mut config = sc::StreamCfg::new();
        config.set_width(super::THUMBNAIL_WIDTH as usize);
        config.set_height(super::THUMBNAIL_HEIGHT as usize);
        config.set_shows_cursor(false);

        let sample_buf =
            match unsafe { sc::ScreenshotManager::capture_sample_buf(filter.as_ref(), &config) }
                .await
            {
                Ok(buf) => buf,
                Err(err) => {
                    warn!(error = ?err, "Failed to capture sample buffer for thumbnail");
                    return None;
                }
            };

        let Some(image_buf) = sample_buf.image_buf() else {
            warn!("Sample buffer missing image data");
            return None;
        };
        let mut image_buf = image_buf.retained();

        let width = image_buf.width();
        let height = image_buf.height();
        if width == 0 || height == 0 {
            warn!(
                width = width,
                height = height,
                "Captured thumbnail had empty dimensions"
            );
            return None;
        }

        let pixel_format = image_buf.pixel_format();

        let lock = match PixelBufferLock::new(
            image_buf.as_mut(),
            cv::pixel_buffer::LockFlags::READ_ONLY,
        ) {
            Ok(lock) => lock,
            Err(err) => {
                warn!(error = ?err, "Failed to lock pixel buffer for thumbnail");
                return None;
            }
        };

        let rgba_data = match pixel_format {
            cv::PixelFormat::_32_BGRA
            | cv::PixelFormat::_32_RGBA
            | cv::PixelFormat::_32_ARGB
            | cv::PixelFormat::_32_ABGR => {
                // Safe: `lock` is live for the whole call, so the base address
                // and stride it reports describe a readable mapping.
                unsafe {
                    super::convert_32bit_pixel_buffer(
                        lock.base_address(),
                        lock.bytes_per_row(),
                        width,
                        height,
                        pixel_format.into(),
                    )
                }?
            }
            cv::PixelFormat::_420V => unsafe {
                super::convert_nv12_pixel_buffer(
                    super::Nv12Planes {
                        y: lock.base_address_of_plane(0),
                        y_stride: lock.bytes_per_row_of_plane(0),
                        y_height: lock.height_of_plane(0),
                        uv: lock.base_address_of_plane(1),
                        uv_stride: lock.bytes_per_row_of_plane(1),
                        uv_height: lock.height_of_plane(1),
                    },
                    width,
                    height,
                    super::Nv12Range::Video,
                )
            }?,
            other => {
                warn!(?other, "Unsupported pixel format for thumbnail capture");
                return None;
            }
        };

        let Some(img) = RgbaImage::from_raw(width as u32, height as u32, rgba_data) else {
            warn!("Failed to construct RGBA image for thumbnail");
            return None;
        };
        // Crop SCK's top-left-anchored content out of the padded buffer (see
        // the function doc). Bounded to the buffer so a surprise SCK size can
        // never panic the crop.
        let crop_width = (content_width as u32).min(img.width()).max(1);
        let crop_height = (content_height as u32).min(img.height()).max(1);
        let img = if crop_width < img.width() || crop_height < img.height() {
            image::imageops::crop_imm(&img, 0, 0, crop_width, crop_height).to_image()
        } else {
            img
        };
        Some(normalize_thumbnail_dimensions(&img))
    }

    impl From<cv::PixelFormat> for super::ChannelOrder {
        fn from(value: cv::PixelFormat) -> Self {
            match value {
                cv::PixelFormat::_32_BGRA => Self::Bgra,
                cv::PixelFormat::_32_RGBA => Self::Rgba,
                cv::PixelFormat::_32_ARGB => Self::Argb,
                cv::PixelFormat::_32_ABGR => Self::Abgr,
                // `capture_thumbnail_from_filter` only reaches the conversion
                // for the four 32-bit orders; anything else has already
                // returned. Mirrors the source's `_ => unreachable!()`.
                other => unreachable!("unsupported 32-bit pixel format {other:?}"),
            }
        }
    }

    /// `PixelBufferLock` (`mac.rs:277-318`) and the `CVPixelBuffer*` externs
    /// below it — cidre does not surface the plane accessors, so the C
    /// functions are declared here exactly as the Tauri module declares them.
    struct PixelBufferLock<'a> {
        buffer: &'a mut cv::PixelBuf,
        flags: cv::pixel_buffer::LockFlags,
    }

    impl<'a> PixelBufferLock<'a> {
        fn new(
            buffer: &'a mut cv::PixelBuf,
            flags: cv::pixel_buffer::LockFlags,
        ) -> cidre::os::Result<Self> {
            unsafe { buffer.lock_base_addr(flags) }.result()?;
            Ok(Self { buffer, flags })
        }

        fn base_address(&self) -> *const u8 {
            unsafe { cv_pixel_buffer_get_base_address(self.buffer) as *const u8 }
        }

        fn bytes_per_row(&self) -> usize {
            unsafe { cv_pixel_buffer_get_bytes_per_row(self.buffer) }
        }

        fn base_address_of_plane(&self, plane_index: usize) -> *const u8 {
            unsafe {
                cv_pixel_buffer_get_base_address_of_plane(self.buffer, plane_index) as *const u8
            }
        }

        fn bytes_per_row_of_plane(&self, plane_index: usize) -> usize {
            unsafe { cv_pixel_buffer_get_bytes_per_row_of_plane(self.buffer, plane_index) }
        }

        fn height_of_plane(&self, plane_index: usize) -> usize {
            unsafe { cv_pixel_buffer_get_height_of_plane(self.buffer, plane_index) }
        }
    }

    impl Drop for PixelBufferLock<'_> {
        fn drop(&mut self) {
            unsafe {
                let _ = self.buffer.unlock_lock_base_addr(self.flags);
            }
        }
    }

    unsafe fn cv_pixel_buffer_get_base_address(buffer: &cv::PixelBuf) -> *mut std::ffi::c_void {
        unsafe extern "C" {
            fn CVPixelBufferGetBaseAddress(pixel_buffer: &cv::PixelBuf) -> *mut std::ffi::c_void;
        }

        unsafe { CVPixelBufferGetBaseAddress(buffer) }
    }

    unsafe fn cv_pixel_buffer_get_bytes_per_row(buffer: &cv::PixelBuf) -> usize {
        unsafe extern "C" {
            fn CVPixelBufferGetBytesPerRow(pixel_buffer: &cv::PixelBuf) -> usize;
        }

        unsafe { CVPixelBufferGetBytesPerRow(buffer) }
    }

    unsafe fn cv_pixel_buffer_get_base_address_of_plane(
        buffer: &cv::PixelBuf,
        plane_index: usize,
    ) -> *mut std::ffi::c_void {
        unsafe extern "C" {
            fn CVPixelBufferGetBaseAddressOfPlane(
                pixel_buffer: &cv::PixelBuf,
                plane_index: usize,
            ) -> *mut std::ffi::c_void;
        }

        unsafe { CVPixelBufferGetBaseAddressOfPlane(buffer, plane_index) }
    }

    unsafe fn cv_pixel_buffer_get_bytes_per_row_of_plane(
        buffer: &cv::PixelBuf,
        plane_index: usize,
    ) -> usize {
        unsafe extern "C" {
            fn CVPixelBufferGetBytesPerRowOfPlane(
                pixel_buffer: &cv::PixelBuf,
                plane_index: usize,
            ) -> usize;
        }

        unsafe { CVPixelBufferGetBytesPerRowOfPlane(buffer, plane_index) }
    }

    unsafe fn cv_pixel_buffer_get_height_of_plane(
        buffer: &cv::PixelBuf,
        plane_index: usize,
    ) -> usize {
        unsafe extern "C" {
            fn CVPixelBufferGetHeightOfPlane(
                pixel_buffer: &cv::PixelBuf,
                plane_index: usize,
            ) -> usize;
        }

        unsafe { CVPixelBufferGetHeightOfPlane(buffer, plane_index) }
    }
}

/// Windows and Linux have their own `thumbnails/{windows,linux}.rs` in the
/// Tauri app; neither is ported yet, and the picker falls back to the icon
/// card, which is exactly what it did before this unit.
#[cfg(not(target_os = "macos"))]
mod platform {
    use image::RgbaImage;

    #[derive(Clone)]
    pub struct ShareableContent;

    impl ShareableContent {
        pub fn retained(&self) -> Self {
            self.clone()
        }
    }

    pub async fn shareable_content() -> Option<ShareableContent> {
        None
    }

    pub async fn capture_display_thumbnail(
        _display: &scap_targets::Display,
        _content: ShareableContent,
    ) -> Option<RgbaImage> {
        None
    }

    pub async fn capture_window_thumbnail(
        _window: &scap_targets::Window,
        _content: ShareableContent,
    ) -> Option<RgbaImage> {
        None
    }
}

use platform::{capture_display_thumbnail, capture_window_thumbnail, shareable_content};

// -- pixel conversion ------------------------------------------------------
//
// Split out of the macOS module and taking raw pointers rather than a
// `PixelBufferLock` so the arithmetic can be unit tested against hand-built
// buffers on any host.

/// The four 32-bit orders `capture_thumbnail_from_filter` accepts
/// (`thumbnails/mac.rs:73-78`).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ChannelOrder {
    Bgra,
    Rgba,
    Argb,
    Abgr,
}

/// `convert_32bit_pixel_buffer` (`thumbnails/mac.rs:111-160`).
///
/// # Safety
/// `base_ptr` must be the base address of a locked pixel buffer holding at
/// least `bytes_per_row * height` readable bytes.
unsafe fn convert_32bit_pixel_buffer(
    base_ptr: *const u8,
    bytes_per_row: usize,
    width: usize,
    height: usize,
    order: ChannelOrder,
) -> Option<Vec<u8>> {
    if base_ptr.is_null() {
        tracing::warn!("Pixel buffer base address was null");
        return None;
    }

    let total_len = bytes_per_row.checked_mul(height)?;
    let raw_data = unsafe { std::slice::from_raw_parts(base_ptr, total_len) };
    convert_32bit_rows(raw_data, bytes_per_row, width, height, order)
}

/// The row loop of `convert_32bit_pixel_buffer`, over a slice.
fn convert_32bit_rows(
    raw_data: &[u8],
    bytes_per_row: usize,
    width: usize,
    height: usize,
    order: ChannelOrder,
) -> Option<Vec<u8>> {
    let mut rgba_data = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        let row_start = y * bytes_per_row;
        let row_end = row_start + width * 4;
        if row_end > raw_data.len() {
            tracing::warn!(
                row_start = row_start,
                row_end = row_end,
                raw_len = raw_data.len(),
                "Row bounds exceeded raw data length during thumbnail capture",
            );
            return None;
        }

        let row = &raw_data[row_start..row_end];
        for chunk in row.chunks_exact(4) {
            match order {
                ChannelOrder::Bgra => {
                    rgba_data.extend_from_slice(&[chunk[2], chunk[1], chunk[0], chunk[3]])
                }
                ChannelOrder::Rgba => rgba_data.extend_from_slice(chunk),
                ChannelOrder::Argb => {
                    rgba_data.extend_from_slice(&[chunk[1], chunk[2], chunk[3], chunk[0]])
                }
                ChannelOrder::Abgr => {
                    rgba_data.extend_from_slice(&[chunk[3], chunk[2], chunk[1], chunk[0]])
                }
            }
        }
    }

    Some(rgba_data)
}

#[derive(Copy, Clone)]
pub enum Nv12Range {
    Video,
    _Full,
}

/// The plane geometry `convert_nv12_pixel_buffer` reads out of the lock.
struct Nv12Planes {
    y: *const u8,
    y_stride: usize,
    y_height: usize,
    uv: *const u8,
    uv_stride: usize,
    uv_height: usize,
}

/// `convert_nv12_pixel_buffer` (`thumbnails/mac.rs:168-254`).
///
/// # Safety
/// Both plane pointers must address at least `stride * plane_height` readable
/// bytes of a locked pixel buffer.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
unsafe fn convert_nv12_pixel_buffer(
    planes: Nv12Planes,
    width: usize,
    height: usize,
    range: Nv12Range,
) -> Option<Vec<u8>> {
    if planes.y.is_null() || planes.uv.is_null() {
        tracing::warn!("NV12 plane base address was null");
        return None;
    }

    if planes.y_stride == 0 || planes.uv_stride == 0 {
        tracing::warn!(
            planes.y_stride,
            planes.uv_stride,
            "NV12 plane bytes per row was zero"
        );
        return None;
    }

    if planes.y_height < height || planes.uv_height < height.div_ceil(2) {
        tracing::warn!(
            planes.y_height,
            planes.uv_height,
            expected_y = height,
            expected_uv = height.div_ceil(2),
            "NV12 plane height smaller than expected",
        );
        return None;
    }

    let y_plane =
        unsafe { std::slice::from_raw_parts(planes.y, planes.y_stride * planes.y_height) };
    let uv_plane =
        unsafe { std::slice::from_raw_parts(planes.uv, planes.uv_stride * planes.uv_height) };

    convert_nv12_planes(
        y_plane,
        planes.y_stride,
        uv_plane,
        planes.uv_stride,
        width,
        height,
        range,
    )
}

/// The pixel loop of `convert_nv12_pixel_buffer`, over slices.
fn convert_nv12_planes(
    y_plane: &[u8],
    y_stride: usize,
    uv_plane: &[u8],
    uv_stride: usize,
    width: usize,
    height: usize,
    range: Nv12Range,
) -> Option<Vec<u8>> {
    let mut rgba_data = vec![0u8; width * height * 4];

    for y_idx in 0..height {
        let y_row_start = y_idx * y_stride;
        if y_row_start + width > y_plane.len() {
            tracing::warn!(
                y_row_start,
                width,
                y_plane_len = y_plane.len(),
                "Y row exceeded plane length during conversion",
            );
            return None;
        }
        let y_row = &y_plane[y_row_start..y_row_start + width];

        let uv_row_start = (y_idx / 2) * uv_stride;
        if uv_row_start + width > uv_plane.len() {
            tracing::warn!(
                uv_row_start,
                width,
                uv_plane_len = uv_plane.len(),
                "UV row exceeded plane length during conversion",
            );
            return None;
        }
        let uv_row = &uv_plane[uv_row_start..uv_row_start + width];

        for (x, y_val) in y_row.iter().enumerate().take(width) {
            let uv_index = (x / 2) * 2;
            if uv_index + 1 >= uv_row.len() {
                tracing::warn!(
                    uv_index,
                    uv_row_len = uv_row.len(),
                    "UV index out of bounds during conversion",
                );
                return None;
            }

            let cb = uv_row[uv_index];
            let cr = uv_row[uv_index + 1];
            let (r, g, b) = ycbcr_to_rgb(*y_val, cb, cr, range);
            let out = (y_idx * width + x) * 4;
            rgba_data[out] = r;
            rgba_data[out + 1] = g;
            rgba_data[out + 2] = b;
            rgba_data[out + 3] = 255;
        }
    }

    Some(rgba_data)
}

/// `ycbcr_to_rgb` (`thumbnails/mac.rs:256-275`): BT.601 coefficients, with the
/// video-range 16..235 luma expansion.
fn ycbcr_to_rgb(y: u8, cb: u8, cr: u8, range: Nv12Range) -> (u8, u8, u8) {
    let y = y as f32;
    let cb = cb as f32 - 128.0;
    let cr = cr as f32 - 128.0;

    let (y_value, scale) = match range {
        Nv12Range::Video => ((y - 16.0).max(0.0), 1.164383_f32),
        Nv12Range::_Full => (y, 1.0_f32),
    };

    let r = scale * y_value + 1.596027_f32 * cr;
    let g = scale * y_value - 0.391762_f32 * cb - 0.812968_f32 * cr;
    let b = scale * y_value + 2.017232_f32 * cb;

    (clamp_channel(r), clamp_channel(g), clamp_channel(b))
}

fn clamp_channel(value: f32) -> u8 {
    value.clamp(0.0, 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use scap_targets::{DisplayId, WindowId};
    use std::str::FromStr;

    fn solid(width: u32, height: u32, colour: [u8; 4]) -> RgbaImage {
        RgbaImage::from_pixel(width, height, image::Rgba(colour))
    }

    #[test]
    fn fitted_capture_size_keeps_the_source_aspect_inside_320x180() {
        // Exact 16:9 fills the whole request.
        assert_eq!(fitted_capture_size(Some((3200., 1800.))), (320, 180));
        // Squarer than 16:9 (the 1706x1410 Chrome window from the probe):
        // height binds, width shrinks -- no right-hand padding for SCK to add.
        assert_eq!(fitted_capture_size(Some((1706., 1410.))), (218, 180));
        // Wider than 16:9: width binds.
        assert_eq!(fitted_capture_size(Some((3440., 1440.))), (320, 134));
        // Tiny sources upscale, same as normalize's locked-in behaviour.
        assert_eq!(fitted_capture_size(Some((100., 50.))), (320, 160));
        // Unknown or degenerate sizes fall back to the flat request.
        assert_eq!(fitted_capture_size(None), (320, 180));
        assert_eq!(fitted_capture_size(Some((0., 1410.))), (320, 180));
    }

    #[test]
    fn normalize_passes_an_exact_target_through_untouched() {
        let source = solid(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, [10, 20, 30, 255]);
        let out = normalize_thumbnail_dimensions(&source);
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        assert_eq!(out.as_raw(), source.as_raw());
    }

    #[test]
    fn normalize_degenerate_dimensions_give_a_transparent_canvas() {
        let out = normalize_thumbnail_dimensions(&RgbaImage::new(0, 4));
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        assert!(out.pixels().all(|p| p.0 == [0, 0, 0, 0]));
    }

    /// 16:9 at any size fills the canvas edge to edge -- 3840x2160 scales by
    /// 320/3840 = 180/2160 = 0.0833, so 320x180 exactly, no letterbox.
    #[test]
    fn normalize_sixteen_by_nine_fills_the_canvas() {
        let out = normalize_thumbnail_dimensions(&solid(3840, 2160, [255, 0, 0, 255]));
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        // Every corner is opaque: nothing was letterboxed away.
        for (x, y) in [(0, 0), (319, 0), (0, 179), (319, 179)] {
            assert_eq!(
                out.get_pixel(x, y).0[3],
                255,
                "corner ({x},{y}) is transparent"
            );
        }
    }

    /// 1000x200 is wider than 16:9. scale = min(320/1000, 180/200) = 0.32, so
    /// 320x64 centred with (180-64)/2 = 58 transparent rows top and bottom.
    #[test]
    fn normalize_wide_source_letterboxes_top_and_bottom() {
        let out = normalize_thumbnail_dimensions(&solid(1000, 200, [0, 255, 0, 255]));
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        assert_eq!(
            out.get_pixel(160, 57).0,
            [0, 0, 0, 0],
            "row 57 should be padding"
        );
        assert_eq!(
            out.get_pixel(160, 90).0[3],
            255,
            "the centre row should be image"
        );
        assert_eq!(
            out.get_pixel(160, 122).0,
            [0, 0, 0, 0],
            "row 122 should be padding"
        );
        // Full width: 58 + 64 = 122, so 122..180 is padding again.
        assert_eq!(out.get_pixel(0, 90).0[3], 255);
        assert_eq!(out.get_pixel(319, 90).0[3], 255);
    }

    /// 200x1000 is taller than 16:9. scale = min(320/200, 180/1000) = 0.18, so
    /// 36x180 centred with (320-36)/2 = 142 transparent columns either side.
    #[test]
    fn normalize_tall_source_pillarboxes_left_and_right() {
        let out = normalize_thumbnail_dimensions(&solid(200, 1000, [0, 0, 255, 255]));
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        assert_eq!(
            out.get_pixel(141, 90).0,
            [0, 0, 0, 0],
            "column 141 should be padding"
        );
        assert_eq!(
            out.get_pixel(142, 90).0[3],
            255,
            "column 142 starts the image"
        );
        assert_eq!(
            out.get_pixel(177, 90).0[3],
            255,
            "column 177 ends the image"
        );
        assert_eq!(
            out.get_pixel(178, 90).0,
            [0, 0, 0, 0],
            "column 178 should be padding"
        );
    }

    /// The source clamps `scale` at `f32::MIN_POSITIVE` but never at 1.0, so a
    /// source smaller than the box is scaled *up* to fit it -- 160x90 doubles
    /// to a full-bleed 320x180. Locking that in because it is the behaviour the
    /// Tauri card renders, not because it is the obvious choice.
    #[test]
    fn normalize_upscales_a_smaller_source() {
        let out = normalize_thumbnail_dimensions(&solid(160, 90, [200, 100, 50, 255]));
        assert_eq!(out.dimensions(), (THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT));
        for (x, y) in [(0, 0), (319, 0), (0, 179), (319, 179)] {
            assert_eq!(
                out.get_pixel(x, y).0[3],
                255,
                "corner ({x},{y}) is transparent"
            );
        }
    }

    /// A 2x1 buffer with a stride wider than the row, so the padding bytes have
    /// to be skipped. Channels: two pixels, hand-swizzled per order.
    #[test]
    fn thirty_two_bit_orders_swizzle_to_rgba() {
        // Pixel A = bytes 1,2,3,4; pixel B = bytes 5,6,7,8; then 4 stride bytes.
        let raw = vec![1, 2, 3, 4, 5, 6, 7, 8, 0xff, 0xff, 0xff, 0xff];

        let bgra = convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Bgra).unwrap();
        assert_eq!(bgra, vec![3, 2, 1, 4, 7, 6, 5, 8]);

        let rgba = convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Rgba).unwrap();
        assert_eq!(rgba, vec![1, 2, 3, 4, 5, 6, 7, 8]);

        let argb = convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Argb).unwrap();
        assert_eq!(argb, vec![2, 3, 4, 1, 6, 7, 8, 5]);

        let abgr = convert_32bit_rows(&raw, 12, 2, 1, ChannelOrder::Abgr).unwrap();
        assert_eq!(abgr, vec![4, 3, 2, 1, 8, 7, 6, 5]);
    }

    #[test]
    fn thirty_two_bit_rejects_a_short_buffer() {
        // One row of 2 pixels needs 8 bytes; give it 6.
        let raw = vec![1, 2, 3, 4, 5, 6];
        assert!(convert_32bit_rows(&raw, 8, 2, 1, ChannelOrder::Bgra).is_none());
    }

    /// Video-range NV12, hand-computed from the source's coefficients.
    ///
    /// Y=16, Cb=Cr=128 is the black point: y_value = 0, chroma = 0, so RGB = 0.
    /// Y=235, Cb=Cr=128 is the white point: 1.164383 * 219 = 254.999... -> 254
    /// after the `as u8` truncation the source uses (not a round).
    /// Y=81, Cb=90, Cr=240 is BT.601 video-range red: r = 1.164383*65 +
    /// 1.596027*112 = 75.68 + 178.75 = 254.4 -> 254; g = 75.68 - 0.391762*-38 -
    /// 0.812968*112 = 75.68 + 14.89 - 91.05 = -0.48 -> 0; b = 75.68 +
    /// 2.017232*-38 = 75.68 - 76.65 = -0.97 -> 0.
    #[test]
    fn nv12_video_range_converts_known_points() {
        assert_eq!(ycbcr_to_rgb(16, 128, 128, Nv12Range::Video), (0, 0, 0));
        assert_eq!(
            ycbcr_to_rgb(235, 128, 128, Nv12Range::Video),
            (254, 254, 254)
        );
        assert_eq!(ycbcr_to_rgb(81, 90, 240, Nv12Range::Video), (254, 0, 0));
        // Below the black point clamps at 0 rather than going negative.
        assert_eq!(ycbcr_to_rgb(0, 128, 128, Nv12Range::Video), (0, 0, 0));
    }

    #[test]
    fn nv12_full_range_leaves_luma_alone() {
        assert_eq!(
            ycbcr_to_rgb(255, 128, 128, Nv12Range::_Full),
            (255, 255, 255)
        );
        assert_eq!(ycbcr_to_rgb(0, 128, 128, Nv12Range::_Full), (0, 0, 0));
    }

    /// A 2x2 NV12 image with padded strides: one 2x2 chroma block, so all four
    /// pixels share Cb/Cr. Luma 16 then 235 across the top row proves the row
    /// stride is honoured and the UV row is reused for both luma rows.
    #[test]
    fn nv12_plane_walk_honours_strides() {
        // y_stride 4 for a width of 2: two padding bytes per row.
        let y_plane = vec![16, 235, 0xaa, 0xaa, 235, 16, 0xaa, 0xaa];
        // uv_stride 4, one chroma row for two luma rows.
        let uv_plane = vec![128, 128, 0xaa, 0xaa];

        let out = convert_nv12_planes(&y_plane, 4, &uv_plane, 4, 2, 2, Nv12Range::Video).unwrap();
        assert_eq!(out.len(), 2 * 2 * 4);
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        assert_eq!(&out[4..8], &[254, 254, 254, 255]);
        assert_eq!(&out[8..12], &[254, 254, 254, 255]);
        assert_eq!(&out[12..16], &[0, 0, 0, 255]);
    }

    #[test]
    fn nv12_rejects_a_short_y_row() {
        let y_plane = vec![16];
        let uv_plane = vec![128, 128];
        assert!(convert_nv12_planes(&y_plane, 4, &uv_plane, 4, 2, 1, Nv12Range::Video).is_none());
    }

    fn window(id: &str, app: &str, label: &str) -> WindowOption {
        WindowOption {
            id: WindowId::from_str(id).unwrap(),
            label: label.into(),
            app: app.into(),
            size: Some((1920, 1080)),
            position: Some((0., 0.)),
            refresh_rate: Some(60.),
        }
    }

    fn display(id: &str, label: &str) -> DisplayOption {
        DisplayOption {
            id: DisplayId::from_str(id).unwrap(),
            label: label.into(),
            refresh_rate: 60.,
        }
    }

    #[test]
    fn window_signature_joins_every_field_the_source_joins() {
        let list = [window("1", "Cap", "Main"), window("2", "Cap", "Editor")];
        assert_eq!(
            window_signature(&list),
            "1:Cap:Main:0:0:1920:1080:60|2:Cap:Editor:0:0:1920:1080:60"
        );
    }

    #[test]
    fn window_signature_notices_a_move_a_resize_a_rename_and_a_reorder() {
        let base = [window("1", "Cap", "Main")];

        let mut moved = base.clone();
        moved[0].position = Some((10., 0.));
        assert_ne!(window_signature(&base), window_signature(&moved));

        let mut resized = base.clone();
        resized[0].size = Some((1280, 720));
        assert_ne!(window_signature(&base), window_signature(&resized));

        let mut renamed = base.clone();
        renamed[0].label = "Untitled".into();
        assert_ne!(window_signature(&base), window_signature(&renamed));

        let pair = [window("1", "Cap", "Main"), window("2", "Cap", "Editor")];
        let swapped = [window("2", "Cap", "Editor"), window("1", "Cap", "Main")];
        assert_ne!(window_signature(&pair), window_signature(&swapped));
    }

    #[test]
    fn display_signature_covers_id_name_and_refresh_rate() {
        let list = [display("1", "Built-in"), display("2", "Studio Display")];
        assert_eq!(
            display_signature(&list),
            "1:Built-in:60|2:Studio Display:60"
        );

        let mut renamed = list.clone();
        renamed[1].label = "Sidecar".into();
        assert_ne!(display_signature(&list), display_signature(&renamed));

        let mut slower = list.clone();
        slower[0].refresh_rate = 30.;
        assert_ne!(display_signature(&list), display_signature(&slower));
    }

    #[test]
    fn an_empty_list_has_an_empty_signature() {
        assert_eq!(window_signature(&[]), "");
        assert_eq!(display_signature(&[]), "");
    }

    /// The reconcile-by-id rule: a refresh that produced nothing for a target
    /// still on the list must leave that target's image alone.
    #[test]
    fn a_failed_capture_never_blanks_a_shown_thumbnail() {
        let mut cache = ThumbnailCache::default();
        let id = WindowId::from_str("7").unwrap();
        let image = crate::library::rgba_to_render_image(solid(2, 2, [1, 2, 3, 255]));

        assert!(
            cache
                .insert_window(&id, Some(image.clone()), None)
                .is_none()
        );
        assert!(cache.window(&id).image.is_some());

        // A refresh with no capture and no icon: the slot survives untouched.
        assert!(cache.insert_window(&id, None, None).is_none());
        assert!(cache.window(&id).image.is_some());

        // An icon arriving on its own does not disturb the thumbnail either.
        let icon = Arc::new(gpui::Image::from_bytes(
            gpui::ImageFormat::Png,
            vec![0u8; 4],
        ));
        assert!(cache.insert_window(&id, None, Some(icon)).is_none());
        let thumb = cache.window(&id);
        assert!(thumb.image.is_some());
        assert!(thumb.app_icon.is_some());
    }

    #[test]
    fn replacing_a_thumbnail_hands_back_the_old_one_for_eviction() {
        let mut cache = ThumbnailCache::default();
        let id = DisplayId::from_str("1").unwrap();
        let first = crate::library::rgba_to_render_image(solid(2, 2, [1, 1, 1, 255]));
        let second = crate::library::rgba_to_render_image(solid(2, 2, [2, 2, 2, 255]));

        assert!(cache.insert_display(&id, first.clone()).is_none());
        let replaced = cache.insert_display(&id, second).expect("old image");
        assert!(Arc::ptr_eq(&replaced, &first));
    }

    #[test]
    fn pruning_returns_the_images_of_targets_that_went_away() {
        let mut cache = ThumbnailCache::default();
        let kept = DisplayId::from_str("1").unwrap();
        let gone = DisplayId::from_str("2").unwrap();
        let gone_image = crate::library::rgba_to_render_image(solid(2, 2, [9, 9, 9, 255]));
        let _ = cache.insert_display(
            &kept,
            crate::library::rgba_to_render_image(solid(2, 2, [1; 4])),
        );
        let _ = cache.insert_display(&gone, gone_image.clone());

        let dropped = cache.retain_displays(&[display("1", "Built-in")]);
        assert_eq!(dropped.len(), 1);
        assert!(Arc::ptr_eq(&dropped[0], &gone_image));
        assert!(cache.display(&kept).image.is_some());
        assert!(cache.display(&gone).image.is_none());
    }

    #[test]
    fn staleness_tracks_the_signature_of_the_captured_list() {
        let mut cache = ThumbnailCache::default();
        let list = [window("1", "Cap", "Main")];

        // Nothing captured yet: always stale.
        assert!(cache.windows_stale(&list));

        cache.set_window_signature(window_signature(&list));
        assert!(!cache.windows_stale(&list));

        let mut moved = list.clone();
        moved[0].position = Some((5., 5.));
        assert!(cache.windows_stale(&moved));
    }

    #[test]
    fn prewarm_is_a_one_shot_latch() {
        let mut cache = ThumbnailCache::default();
        assert!(cache.take_prewarm());
        assert!(!cache.take_prewarm());
    }

    /// The wedge this guards against: resetting the cache drops the tasks that
    /// own the in-flight flags, so a reset that left one set would block that
    /// kind's refresh for the life of the view.
    #[test]
    /// The nested-runtime trick `run_capture` leans on: a blocking-pool thread
    /// is allowed to stand up its own current-thread runtime and `block_on`,
    /// where a worker thread would panic with "cannot start a runtime from
    /// within a runtime". Asserted here rather than discovered at the first
    /// capture, because the capture itself needs a screen-recording grant and
    /// so cannot be exercised in a test.
    #[test]
    fn a_sweep_runs_on_a_blocking_thread_inside_a_multi_thread_runtime() {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .build()
            .unwrap();
        let (tx, rx) = flume::unbounded::<&'static str>();
        runtime.block_on(run_capture(move || async move {
            // A yield across an await point, so the inner runtime really has
            // to drive the future rather than complete it on first poll.
            tokio::task::yield_now().await;
            let _ = tx.send("captured");
        }));
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec!["captured"]);
    }

    #[test]
    fn reset_returns_every_image_and_clears_the_inflight_flags() {
        let mut cache = ThumbnailCache::default();
        let _ = cache.insert_display(
            &DisplayId::from_str("1").unwrap(),
            crate::library::rgba_to_render_image(solid(2, 2, [1; 4])),
        );
        let _ = cache.insert_window(
            &WindowId::from_str("2").unwrap(),
            Some(crate::library::rgba_to_render_image(solid(2, 2, [2; 4]))),
            None,
        );
        cache.set_display_inflight(true);
        cache.set_window_inflight(true);
        cache.set_display_signature("stale".into());

        let images = cache.reset();
        assert_eq!(images.len(), 2);
        assert!(!cache.display_inflight());
        assert!(!cache.window_inflight());
        assert!(cache.displays_stale(&[]));
        assert!(
            cache
                .display(&DisplayId::from_str("1").unwrap())
                .image
                .is_none()
        );
    }
}
