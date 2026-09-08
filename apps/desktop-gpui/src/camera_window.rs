//! The camera preview bubble -- `camera.tsx` + `CameraPreviewChrome.tsx`,
//! natively.
//!
//! Layout parity: a transparent always-dark window (`camera.tsx:128` forces
//! the dark class), 56px toolbar strip on top (chrome appears on hover),
//! preview container below it clipped to the shape (round / square / full),
//! four corner resize handles with the bracket visuals below the toolbar,
//! drag-anywhere to move the window. Frames arrive as CoreVideo pixel buffers
//! from the app-scoped [`CameraFeed`]; VideoToolbox converts them to BGRA
//! IOSurfaces (and flips them in hardware when mirrored) and gpui paints
//! those directly via `paint_surface_fitted` (cover-fit + rounded clip on the
//! primitive) -- no CPU pixel copies and no sprite-atlas uploads on the frame
//! path. With background blur on, the converted surface takes a detour
//! through the [`crate::camera_blur`] worker -- the same
//! `cap_camera_effects::BlurProcessor` the recording's project config points
//! the editor at -- and the blurred surface is painted instead.
//!
//! Invalidation mirrors the editor window: each frame notifies only the
//! [`CameraPreviewView`] child entity, while the toolbar chrome lives in a
//! [`CameraToolbarView`] mounted `.cached()`, re-rendered only when the parent
//! notifies (hover, resize, state mutations). A per-frame `window.refresh()`
//! would bust every cache and relayout the whole window at camera rate
//! (`CAP_GPUI_AUTO_CAMERA_BENCH`, 8 interleaved A/B pairs: median p50 draw
//! 319us -> 222us; the remainder is gpui's fixed per-draw cost, which a
//! clean-draw floor measurement puts at ~150us on this window either way).
//! Verified live on a real C920: 29.9fps delivered, 29.9fps painted with no
//! per-frame refresh.
//!
//! Window placement is the Tauri decision (`windows.rs:2278-2345`): the saved
//! per-monitor position when it is still on that monitor, else the saved
//! global position, else bottom-right of the main window's display; moves are
//! debounced into the shared store's `cameraWindowPosition` keys
//! (`lib.rs:4621-4634`), so the two apps remember one bubble position.
//!
//! Known deviations (also in the README): no 150ms opacity/translate
//! transitions on the toolbar and resize brackets (no animation pass in this
//! port), no `backdrop-blur-xs` behind the issue overlay (no per-element
//! backdrop blur hook in this gpui rev), no "Camera disconnected" overlay on
//! recording input loss (the Tauri `recordingEvent` InputLost seam has no
//! counterpart in this app yet), no `cursor-move` on the drag surface (gpui
//! has no 4-way move cursor; the resize handles do get their diagonal resize
//! cursors), and chrome state persists to `gpui-state.json` rather than
//! `localStorage`.

use std::sync::{
    Arc,
    atomic::{AtomicU32, AtomicU64, Ordering},
};
use std::time::{Duration, Instant};

#[cfg(not(target_os = "macos"))]
use gpui::StyledImage as _;
use gpui::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement as _, Render,
    StatefulInteractiveElement as _, StyleRefinement, Styled, Subscription, WeakEntity, Window,
    div, prelude::FluentBuilder as _, px, size, svg,
};
use serde_json::Value;

use crate::{
    feeds::Feeds,
    platform,
    store::{self, BlurMode, CameraShape, CameraWindowState},
    theme::Theme,
};

#[cfg(target_os = "macos")]
use crate::camera_blur;

pub const CAMERA_MIN_SIZE: f32 = 150.;
pub const CAMERA_MAX_SIZE: f32 = 600.;
pub const CAMERA_DEFAULT_SIZE: f32 = 230.;
pub const CAMERA_PRESET_SMALL: f32 = 230.;
pub const CAMERA_PRESET_LARGE: f32 = 400.;
pub const CAMERA_TOOLBAR_HEIGHT: f32 = 56.;
/// `CAMERA_WIDE_ASPECT_RATIO`.
const WIDE_ASPECT: f32 = 16. / 9.;

pub fn clamp_size(scale: f32) -> f32 {
    scale.clamp(CAMERA_MIN_SIZE, CAMERA_MAX_SIZE)
}

/// `cameraPreviewDimensions`: height is the size; width follows the aspect
/// ratio (1 unless the shape is `full`).
pub fn preview_dimensions(state: &CameraWindowState, frame_aspect: Option<f32>) -> (f32, f32) {
    let base = clamp_size(state.size);
    let aspect = match state.shape {
        CameraShape::Full => frame_aspect
            .filter(|aspect| aspect.is_finite() && *aspect > 0.)
            .map_or(WIDE_ASPECT, |aspect| aspect.max(WIDE_ASPECT)),
        _ => 1.,
    };
    (base * aspect, base)
}

pub fn window_size(state: &CameraWindowState, frame_aspect: Option<f32>) -> (f32, f32) {
    let (width, height) = preview_dimensions(state, frame_aspect);
    (width, height + CAMERA_TOOLBAR_HEIGHT)
}

pub(crate) fn inline_preview_size(
    state: &CameraWindowState,
    frame_aspect: Option<f32>,
    viewport: (f32, f32),
) -> (f32, f32) {
    let (width, height) = preview_dimensions(state, frame_aspect);
    let scale = ((viewport.0 - 48.).max(160.) / width)
        .min((viewport.1 - 320.).max(160.) / height)
        .min(1.);
    (
        (width * scale).round(),
        (height * scale).round() + CAMERA_TOOLBAR_HEIGHT,
    )
}

#[cfg(test)]
mod inline_preview_tests {
    use super::*;

    #[test]
    fn camera_only_preview_preserves_size_until_viewport_requires_scaling() {
        let state = CameraWindowState::default();
        assert_eq!(
            inline_preview_size(&state, Some(16. / 9.), (1920., 1080.)),
            window_size(&state, Some(16. / 9.)),
        );
        assert_eq!(
            inline_preview_size(&state, None, (100., 100.)),
            (160., 216.),
        );
    }

    #[test]
    fn camera_only_wide_preview_preserves_aspect_and_toolbar_space() {
        let state = CameraWindowState {
            size: 600.,
            shape: CameraShape::Full,
            ..Default::default()
        };
        assert_eq!(
            inline_preview_size(&state, Some(16. / 9.), (800., 600.)),
            (498., 336.),
        );
        assert_eq!(state.size, 600.);
    }
}

/// 0..1 across the 150..600 size range -- drives the toolbar scale and the
/// issue overlay's text metrics, like `cameraToolbarScale` /
/// `cameraOverlayTextMetrics`.
fn normalized_size(state: &CameraWindowState) -> f32 {
    (clamp_size(state.size) - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE)
}

/// The visible bubble's corner radius. The shipped Tauri experience is the
/// legacy webview preview (`enable_native_camera_preview` defaults to false,
/// re-forced by the `native_camera_preview_default_rollback_v1` migration,
/// `general_settings.rs:259-261, 526-530`), whose video container is
/// `rounded-full` for round and `rounded-3xl` -- 24px -- for square and full
/// (`camera.tsx:805-807`). The `cameraBorderRadius` 3rem formula styles only
/// the native page's issue overlay, and the native WGSL mask uses its own
/// smaller radii; the 24px container is what users see.
pub(crate) fn preview_radius(state: &CameraWindowState) -> f32 {
    match state.shape {
        CameraShape::Round => clamp_size(state.size) / 2.,
        _ => 24.,
    }
}

fn picker_preview_radius(state: &CameraWindowState, picker_size: Option<(f32, f32)>) -> f32 {
    match (state.shape, picker_size) {
        (CameraShape::Round, Some((width, height))) => {
            width.max(0.).min((height - CAMERA_TOOLBAR_HEIGHT).max(0.)) / 2.
        }
        _ => preview_radius(state),
    }
}

#[cfg(test)]
mod preview_radius_tests {
    use super::*;

    #[test]
    fn parked_circle_tracks_visible_content_and_restores_saved_radius() {
        let state = CameraWindowState::default();
        let saved = state;
        assert_eq!(picker_preview_radius(&state, Some((136., 192.))), 68.);
        assert_eq!(picker_preview_radius(&state, Some((120., 192.))), 60.);
        assert_eq!(picker_preview_radius(&state, Some((136., 156.))), 50.);
        assert_eq!(picker_preview_radius(&state, None), saved.size / 2.);
        assert_eq!(state, saved);
    }

    #[test]
    fn parked_rectangular_shapes_preserve_their_corner_style() {
        for shape in [CameraShape::Square, CameraShape::Full] {
            let state = CameraWindowState {
                shape,
                ..Default::default()
            };
            assert_eq!(picker_preview_radius(&state, Some((136., 192.))), 24.);
            assert_eq!(picker_preview_radius(&state, None), 24.);
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LinuxCameraPhysicalRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct LinuxCameraRecordingSnapshot {
    pub content_rect: LinuxCameraPhysicalRect,
    pub state: CameraWindowState,
    pub corner_radius_pixels: f32,
}

#[cfg(target_os = "linux")]
fn recording_physical_extent(logical: f32, scale_factor: f32) -> anyhow::Result<u32> {
    let physical = (logical * scale_factor).round();
    if !logical.is_finite()
        || logical <= 0.0
        || !physical.is_finite()
        || physical < 1.0
        || f64::from(physical) > f64::from(i32::MAX)
    {
        anyhow::bail!("Camera geometry has invalid or unsupported physical dimensions");
    }
    Ok(physical as u32)
}

#[cfg(target_os = "linux")]
fn linux_camera_recording_snapshot(
    state: CameraWindowState,
    frame_dimensions: (usize, usize),
    client_rect: LinuxCameraPhysicalRect,
    viewport: (f32, f32),
    scale_factor: f32,
    picker_size: Option<(f32, f32)>,
) -> anyhow::Result<LinuxCameraRecordingSnapshot> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        anyhow::bail!("Camera window has an invalid scale factor");
    }
    if !state.size.is_finite() || state.size <= 0.0 {
        anyhow::bail!("Camera window has an invalid preview size");
    }
    let (frame_width, frame_height) = frame_dimensions;
    if frame_width == 0
        || frame_height == 0
        || u32::try_from(frame_width).is_err()
        || u32::try_from(frame_height).is_err()
    {
        anyhow::bail!("Camera recording requires valid delivered frame dimensions");
    }
    let physical_viewport = (
        recording_physical_extent(viewport.0, scale_factor)?,
        recording_physical_extent(viewport.1, scale_factor)?,
    );
    if physical_viewport != (client_rect.width, client_rect.height) {
        anyhow::bail!("Camera viewport and X11 client dimensions disagree; wait for resizing");
    }
    let expected = picker_size
        .unwrap_or_else(|| window_size(&state, Some(frame_width as f32 / frame_height as f32)));
    if (
        recording_physical_extent(expected.0, scale_factor)?,
        recording_physical_extent(expected.1, scale_factor)?,
    ) != physical_viewport
    {
        anyhow::bail!("Camera presentation and viewport disagree; wait for resizing");
    }

    // X11 supplies the client origin; only the local toolbar offset uses GPUI's scale.
    let toolbar_height = recording_physical_extent(CAMERA_TOOLBAR_HEIGHT, scale_factor)?;
    let content_height = client_rect
        .height
        .checked_sub(toolbar_height)
        .filter(|height| *height > 0)
        .ok_or_else(|| anyhow::anyhow!("Camera viewport has no preview below its toolbar"))?;
    let content_y = i32::try_from(i64::from(client_rect.y) + i64::from(toolbar_height))?;
    i32::try_from(i64::from(client_rect.x) + i64::from(client_rect.width))?;
    i32::try_from(i64::from(client_rect.y) + i64::from(client_rect.height))?;
    if state.shape == CameraShape::Round && client_rect.width.abs_diff(content_height) > 1 {
        anyhow::bail!("Round camera preview does not have square physical bounds");
    }

    Ok(LinuxCameraRecordingSnapshot {
        content_rect: LinuxCameraPhysicalRect {
            x: client_rect.x,
            y: content_y,
            width: client_rect.width,
            height: content_height,
        },
        state,
        corner_radius_pixels: preview_radius(&state) * scale_factor,
    })
}

#[cfg(target_os = "macos")]
mod frame {
    use cidre::{arc, cf, cv, vt};

    /// A converted preview frame: the BGRA IOSurface pixel buffer to paint or
    /// blur, its dimensions, and the ring generation (bumped on every ring
    /// rebuild so the blur worker's imported-texture cache can never alias a
    /// recycled allocation).
    pub struct Converted {
        pub buffer: arc::R<cv::PixelBuf>,
        pub dims: (usize, usize),
        pub generation: u64,
    }

    /// Converts camera frames (typically `420v`) into BGRA IOSurface-backed
    /// pixel buffers that gpui paints directly via `paint_surface_fitted`.
    ///
    /// VideoToolbox does the `420v` -> BGRA conversion in hardware either way;
    /// pointing it at an IOSurface destination removes the old per-frame CPU
    /// row-copy into a `RenderImage` and the sprite-atlas re-upload
    /// (`camera-preview-convert-benchmark`: 196us -> 137us per 720p frame on
    /// the conversion alone, byte-identical output, before atlas savings).
    /// The same transfer also downscales when a maximum size is given (blur
    /// caps its input at 640x360, `camera.rs:46-47`), so the blur path's
    /// scaling costs nothing extra.
    ///
    /// Mirroring is a second hardware pass: a `VTPixelRotationSession` with
    /// `FlipHorizontalOrientation` flips the converted BGRA buffer into a
    /// sibling ring. This is the preview-only mirror the Tauri bubble has --
    /// its shader flips the sampling UV (`camera.wgsl:97-100`), its legacy
    /// page flips the canvas with `scaleX(-1)` (`camera.tsx:869`), and
    /// neither touches the recorded camera track.
    ///
    /// The fixed rings keep a buffer alive while gpui's scene still references
    /// the previous one; four slots at camera rates leaves ~100ms before a
    /// slot is overwritten.
    pub struct FrameConverter {
        session: arc::R<vt::PixelTransferSession>,
        /// `None` when unmirrored, or when the rotation session could not be
        /// created (the preview then degrades to unmirrored, logged once).
        flip_session: Option<arc::R<vt::PixelRotationSession>>,
        ring: Vec<arc::R<cv::PixelBuf>>,
        mirror_ring: Vec<arc::R<cv::PixelBuf>>,
        next: usize,
        src_dims: (usize, usize),
        dst_dims: (usize, usize),
        mirrored: bool,
        generation: u64,
    }

    // Only touched from the main thread; the CF objects have atomic refcounts.
    unsafe impl Send for FrameConverter {}

    const RING_SIZE: usize = 4;

    fn buffer_ring(width: usize, height: usize) -> Option<Vec<arc::R<cv::PixelBuf>>> {
        let io_surface_properties = cf::Dictionary::new();
        let keys: [&cf::Type; 2] = [
            cv::pixel_buffer::keys::io_surf_props().as_ref(),
            cv::pixel_buffer::keys::metal_compatibility().as_ref(),
        ];
        let values: [&cf::Type; 2] = [
            io_surface_properties.as_ref(),
            cf::Boolean::value_true().as_ref(),
        ];
        let attrs = cf::Dictionary::with_keys_values(&keys, &values)?;
        (0..RING_SIZE)
            .map(|_| {
                cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attrs))
                    .ok()
                    .filter(|buf| buf.io_surf().is_some())
            })
            .collect::<Option<Vec<_>>>()
    }

    /// Scale-to-fit inside `max`, aspect preserved, never upscaling.
    fn fit_within(src: (usize, usize), max: (usize, usize)) -> (usize, usize) {
        let scale = (max.0 as f64 / src.0.max(1) as f64)
            .min(max.1 as f64 / src.1.max(1) as f64)
            .min(1.0);
        if scale >= 1.0 {
            return src;
        }
        (
            ((src.0 as f64 * scale).round() as usize).max(1),
            ((src.1 as f64 * scale).round() as usize).max(1),
        )
    }

    impl FrameConverter {
        fn new(
            src_dims: (usize, usize),
            dst_dims: (usize, usize),
            mirrored: bool,
            generation: u64,
        ) -> Option<Self> {
            let mut session = vt::PixelTransferSession::new().ok()?;
            session.set_realtime(true).ok()?;

            let flip_session = if mirrored {
                let flip = vt::PixelRotationSession::new()
                    .ok()
                    .and_then(|mut session| {
                        session.set_horizontal_flip(true).ok().map(|_| session)
                    });
                if flip.is_none() {
                    tracing::warn!(
                        "VTPixelRotationSession unavailable; camera preview mirroring disabled"
                    );
                }
                flip
            } else {
                None
            };

            let ring = buffer_ring(dst_dims.0, dst_dims.1)?;
            let mirror_ring = if flip_session.is_some() {
                buffer_ring(dst_dims.0, dst_dims.1)?
            } else {
                Vec::new()
            };

            Some(Self {
                session,
                flip_session,
                ring,
                mirror_ring,
                next: 0,
                src_dims,
                dst_dims,
                mirrored,
                generation,
            })
        }

        /// The frame as a BGRA IOSurface-backed pixel buffer, downscaled to
        /// fit `max_dims` when given and horizontally flipped when
        /// `mirrored`. Recreates the rings when the camera's frame size, the
        /// target size or the mirror toggle changes.
        pub fn convert(
            this: &mut Option<Self>,
            frame: &cap_recording::NativeCameraFrame,
            max_dims: Option<(usize, usize)>,
            mirrored: bool,
        ) -> Option<Converted> {
            let src = frame.sample_buf.image_buf()?;
            let src_dims = (src.width(), src.height());
            let dst_dims = max_dims.map_or(src_dims, |max| fit_within(src_dims, max));
            if this.as_ref().is_none_or(|converter| {
                converter.src_dims != src_dims
                    || converter.dst_dims != dst_dims
                    || converter.mirrored != mirrored
            }) {
                let generation = this.as_ref().map_or(0, |c| c.generation + 1);
                *this = Self::new(src_dims, dst_dims, mirrored, generation);
            }
            let converter = this.as_mut()?;

            let dst = converter.ring[converter.next].clone();
            converter.session.transfer(src, &dst).ok()?;
            let out = if let Some(flip) = &converter.flip_session {
                let mut flipped = converter.mirror_ring[converter.next].clone();
                flip.rotate(&dst, &mut flipped).ok()?;
                flipped
            } else {
                dst
            };
            converter.next = (converter.next + 1) % RING_SIZE;
            Some(Converted {
                buffer: out,
                dims: converter.dst_dims,
                generation: converter.generation,
            })
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResizeCorner {
    NorthWest,
    NorthEast,
    SouthWest,
    SouthEast,
}

impl ResizeCorner {
    const ALL: [Self; 4] = [
        Self::NorthWest,
        Self::NorthEast,
        Self::SouthWest,
        Self::SouthEast,
    ];

    fn east(self) -> bool {
        matches!(self, Self::NorthEast | Self::SouthEast)
    }

    fn south(self) -> bool {
        matches!(self, Self::SouthWest | Self::SouthEast)
    }
}

struct ResizeDrag {
    corner: ResizeCorner,
    start_size: f32,
    start_picker_size: Option<(f32, f32)>,
    start_position: gpui::Point<gpui::Pixels>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum ResizeTarget {
    Picker((f32, f32)),
    State(f32),
}

fn resize_start(state_size: f32, picker_size: Option<(f32, f32)>) -> (f32, Option<(f32, f32)>) {
    let picker_size = picker_size.filter(|(width, height)| {
        width.is_finite() && *width > 0. && height.is_finite() && *height > CAMERA_TOOLBAR_HEIGHT
    });
    let start_size = picker_size
        .map(|(_, height)| height - CAMERA_TOOLBAR_HEIGHT)
        .unwrap_or(clamp_size(state_size));
    (start_size, picker_size)
}

fn resize_target(
    start_size: f32,
    start_picker_size: Option<(f32, f32)>,
    delta: f32,
) -> ResizeTarget {
    let minimum = start_picker_size.map_or(CAMERA_MIN_SIZE, |_| start_size.min(CAMERA_MIN_SIZE));
    let next = (start_size + delta).clamp(minimum, CAMERA_MAX_SIZE);
    if next < CAMERA_MIN_SIZE
        && let Some((start_width, _)) = start_picker_size
    {
        return ResizeTarget::Picker((
            start_width * next / start_size,
            next + CAMERA_TOOLBAR_HEIGHT,
        ));
    }
    ResizeTarget::State(next)
}

#[cfg(test)]
mod resize_tests {
    use super::*;

    fn close(left: f32, right: f32) {
        assert!((left - right).abs() < 0.001, "{left} != {right}");
    }

    #[test]
    fn parked_square_resizes_from_its_visible_size() {
        let (start, picker) = resize_start(230., Some((100., 156.)));
        assert_eq!(start, 100.);
        assert_eq!(
            resize_target(start, picker, 1.),
            ResizeTarget::Picker((101., 157.))
        );
    }

    #[test]
    fn parked_landscape_preserves_aspect_below_the_saved_size_floor() {
        let (start, picker) = resize_start(180., Some((144., 137.)));
        let ResizeTarget::Picker((width, height)) = resize_target(start, picker, 1.) else {
            panic!("expected temporary picker geometry");
        };
        close(start, 81.);
        close(height, 138.);
        close(width / (height - CAMERA_TOOLBAR_HEIGHT), 16. / 9.);
    }

    #[test]
    fn parked_resize_hands_off_continuously_at_the_saved_size_floor() {
        let (start, picker) = resize_start(180., Some((144., 137.)));
        assert_eq!(
            resize_target(start, picker, CAMERA_MIN_SIZE - start),
            ResizeTarget::State(CAMERA_MIN_SIZE)
        );
        let expected_width = 144. * CAMERA_MIN_SIZE / start;
        let state = CameraWindowState {
            size: CAMERA_MIN_SIZE,
            shape: CameraShape::Full,
            ..Default::default()
        };
        let (width, height) = window_size(&state, Some(16. / 9.));
        close(width, expected_width);
        close(height, CAMERA_MIN_SIZE + CAMERA_TOOLBAR_HEIGHT);
    }

    #[test]
    fn parked_resize_does_not_shrink_below_its_visible_size() {
        let (start, picker) = resize_start(230., Some((100., 156.)));
        assert_eq!(
            resize_target(start, picker, -50.),
            ResizeTarget::Picker((100., 156.))
        );
    }
}

/// `cameraOverlayTextMetrics` (`camera.tsx:891-909`), rem resolved at 16px.
struct OverlayMetrics {
    gap: f32,
    max_width: f32,
    line_height: f32,
    message_size: f32,
    title_size: f32,
}

fn overlay_metrics(size: f32) -> OverlayMetrics {
    let normalized = (clamp_size(size) - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE);
    OverlayMetrics {
        gap: (0.375 + normalized * 0.25) * 16.,
        max_width: (size / 16.).clamp(7.5, 18.) * 16.,
        line_height: (1.2 + normalized * 0.2) * 16.,
        message_size: (0.625 + normalized * 0.25) * 16.,
        title_size: (0.75 + normalized * 0.375) * 16.,
    }
}

/// `camera_preview_error_message` (`lib.rs:755-774`) plus the fixed title
/// from `emit_camera_preview_error` (`lib.rs:776-784`). The error strings
/// come from the same `cap-recording` camera errors the Tauri app matches on.
fn camera_issue(error: &str) -> (&'static str, &'static str) {
    let message = if error.contains("DeviceNotFound") {
        "This camera is no longer available. Check that it is connected and allowed by system permissions."
    } else if error.contains("CameraTimeout") {
        "No frames were received from this camera. It may be closed, disconnected, covered, or in use by another app."
    } else if error.contains("StartCapturing") {
        "The system could not start this camera. It may be unavailable or in use by another app."
    } else if error.contains("InvalidFormat") {
        "This camera did not report a usable capture format."
    } else {
        "The selected camera could not be started. Choose another camera or reconnect this one."
    };
    ("Camera unavailable", message)
}

/// The per-frame half of the window: owns the latest converted (or blurred)
/// frame and is the only entity notified at camera rate. Chrome invalidation
/// goes through the parent [`CameraWindow`] instead, so a frame draw reuses
/// the cached toolbar subtree.
struct CameraPreviewView {
    theme: Theme,
    radius: f32,
    /// Clamped bubble size, for the issue overlay's scaled text metrics.
    size: f32,
    #[cfg(target_os = "macos")]
    latest_frame: Option<core_video::pixel_buffer::CVPixelBuffer>,
    #[cfg(not(target_os = "macos"))]
    latest_frame: Option<Arc<gpui::RenderImage>>,
    frame_dims: Option<(usize, usize)>,
    /// Bumped by the canvas paint callback; the parent's cadence log reads it
    /// to prove notify-driven repaints actually present.
    paints: Arc<AtomicU32>,
    /// `Feeds::camera_error`, copied on change. The observe must not notify
    /// unconditionally: `Feeds` also carries the mic meter, which notifies at
    /// ~20Hz whenever a microphone is selected, and each of those would
    /// repaint the whole preview for a message that did not change.
    camera_error: Option<String>,
    _feeds_subscription: Subscription,
}

impl CameraPreviewView {
    fn new(
        theme: Theme,
        radius: f32,
        size: f32,
        paints: Arc<AtomicU32>,
        cx: &mut Context<Self>,
    ) -> Self {
        let feeds = Feeds::global(cx);
        let camera_error = feeds.read(cx).camera_error.clone();
        let feeds_subscription = cx.observe(&feeds, |this: &mut Self, feeds, cx| {
            let error = feeds.read(cx).camera_error.clone();
            if this.camera_error != error {
                this.camera_error = error;
                cx.notify();
            }
        });
        Self {
            theme,
            radius,
            size,
            #[cfg(target_os = "macos")]
            latest_frame: None,
            #[cfg(not(target_os = "macos"))]
            latest_frame: None,
            frame_dims: None,
            paints,
            camera_error,
            _feeds_subscription: feeds_subscription,
        }
    }

    #[cfg(target_os = "macos")]
    fn set_frame(
        &mut self,
        frame: core_video::pixel_buffer::CVPixelBuffer,
        dims: (usize, usize),
        cx: &mut Context<Self>,
    ) {
        self.latest_frame = Some(frame);
        self.frame_dims = Some(dims);
        cx.notify();
    }

    #[cfg(not(target_os = "macos"))]
    fn set_frame(
        &mut self,
        frame: Arc<gpui::RenderImage>,
        dims: (usize, usize),
        cx: &mut Context<Self>,
    ) -> Option<Arc<gpui::RenderImage>> {
        let previous = self.latest_frame.replace(frame);
        self.frame_dims = Some(dims);
        cx.notify();
        previous
    }

    fn set_chrome(&mut self, radius: f32, size: f32, cx: &mut Context<Self>) {
        if self.radius != radius || self.size != size {
            self.radius = radius;
            self.size = size;
            cx.notify();
        }
    }
}

impl Render for CameraPreviewView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let radius = self.radius;

        let mut container = div()
            .relative()
            .size_full()
            .overflow_hidden()
            .rounded(px(radius))
            .bg(theme.gray_1)
            .text_color(theme.gray_12);

        #[cfg(target_os = "macos")]
        if let Some(buffer) = self.latest_frame.clone() {
            let frame_dims = self.frame_dims;
            let paints = self.paints.clone();
            // Cover-fit painted straight from the IOSurface: `ObjectFit::Cover`
            // computes the same fitted box the old `img()` element used, and
            // `paint_surface_fitted` UV-crops it to the element bounds so the
            // corner radii round the visible rect (circle shape included).
            container = container.child(
                gpui::canvas(
                    |_, _, _| {},
                    move |bounds, _, window, _| {
                        let Some((width, height)) = frame_dims else {
                            return;
                        };
                        let frame_size = gpui::size(
                            gpui::DevicePixels(width as i32),
                            gpui::DevicePixels(height as i32),
                        );
                        let fitted = gpui::ObjectFit::Cover.get_bounds(bounds, frame_size);
                        window.paint_surface_fitted(
                            bounds,
                            fitted,
                            gpui::Corners::all(px(radius)).clamp_radii_for_quad_size(bounds.size),
                            buffer.clone(),
                        );
                        paints.fetch_add(1, Ordering::Relaxed);
                    },
                )
                .size_full(),
            );
        }

        #[cfg(not(target_os = "macos"))]
        if let Some(image) = self.latest_frame.clone() {
            self.paints.fetch_add(1, Ordering::Relaxed);
            container = container.child(
                gpui::img(image)
                    .size_full()
                    .rounded(px(radius))
                    .object_fit(gpui::ObjectFit::Cover),
            );
        }

        let showing_frame = self.latest_frame.is_some();

        if !showing_frame {
            container = container.child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(16.))
                    .text_color(theme.gray_11)
                    .child("Loading camera..."),
            );
        }

        // `CameraIssueOverlay` (`camera.tsx:911-955`): a black/75 wash over
        // the preview with a centred, size-scaled title + message. The
        // `backdrop-blur-xs` behind it has no per-element hook in this gpui
        // rev (the recording overlay documents the same gap).
        if let Some(error) = self.camera_error.clone() {
            let (title, message) = camera_issue(&error);
            let metrics = overlay_metrics(self.size);
            container = container.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .overflow_hidden()
                    .rounded(px(radius))
                    .bg(gpui::hsla(0., 0., 0., 0.75))
                    .px(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .text_center()
                            .gap(px(metrics.gap))
                            .max_w(px(metrics.max_width))
                            .child(
                                div()
                                    .text_size(px(metrics.title_size))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(gpui::white())
                                    .child(title),
                            )
                            .child(
                                div()
                                    .text_size(px(metrics.message_size))
                                    .line_height(px(metrics.line_height))
                                    .text_color(gpui::hsla(0., 0., 1., 0.75))
                                    .child(message),
                            ),
                    ),
            );
        }

        container
    }
}

#[cfg(not(target_os = "macos"))]
pub struct CameraPreviewFrame {
    pub image: Arc<gpui::RenderImage>,
    pub dims: (usize, usize),
}

/// The chrome half: renders the parent's toolbar, re-rendered only when the
/// parent notifies (same shape as the editor's `EditorSectionView`).
struct CameraToolbarView {
    camera: WeakEntity<CameraWindow>,
    _camera_subscription: Subscription,
}

impl CameraToolbarView {
    fn new(camera: &Entity<CameraWindow>, cx: &mut Context<Self>) -> Self {
        let camera_subscription = cx.observe(camera, |_, _, cx| cx.notify());
        Self {
            camera: camera.downgrade(),
            _camera_subscription: camera_subscription,
        }
    }
}

impl Render for CameraToolbarView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(camera) = self.camera.upgrade() else {
            return div().into_any_element();
        };
        camera.update(cx, |camera, cx| {
            camera.render_toolbar(cx).into_any_element()
        })
    }
}

/// Channels to and from the `camera-blur` worker thread, plus the foreground
/// pump that paints its outputs. Dropping this closes the job channel, which
/// ends the thread and releases the ONNX/GPU resources -- the
/// `release_blur_resources` behaviour (`camera.rs:1477-1484`).
#[cfg(target_os = "macos")]
struct BlurBridge {
    tx: flume::Sender<camera_blur::BlurJob>,
    /// The first blurred output may land while the window is inactive, where
    /// a notify alone may not present (the unit-2 first-frame finding); the
    /// pump answers it with one explicit `refresh`.
    first_output_pending: bool,
    _pump: gpui::Task<()>,
}

pub struct CameraWindow {
    theme: Theme,
    state: CameraWindowState,
    inline: bool,
    picker_size: Option<(f32, f32)>,
    size_generation: Arc<AtomicU64>,
    chrome_visible: bool,
    resizing: Option<ResizeDrag>,
    hovered_handle: Option<ResizeCorner>,
    #[cfg(target_os = "macos")]
    converter: Option<frame::FrameConverter>,
    #[cfg(target_os = "macos")]
    blur: Option<BlurBridge>,
    /// Latched when the worker dies (device/ONNX bring-up failed); cleared
    /// when the blur mode changes, which is the retry point -- the
    /// `blur_processor_init_attempted` shape (`camera.rs:1500-1518`).
    #[cfg(target_os = "macos")]
    blur_failed: bool,
    preview: Entity<CameraPreviewView>,
    toolbar: Entity<CameraToolbarView>,
    frame_dims: Option<(usize, usize)>,
    // Cadence instrumentation: proves the preview stays live (delivered) and
    // actually presents (painted) while the window is inactive.
    frames_in_window: u32,
    cadence_window_start: Instant,
    paints: Arc<AtomicU32>,
    paints_at_window_start: u32,
    /// Debounce for the position save, the `queueCameraPositionSave` 200ms
    /// (`camera.tsx:93-112`): only the newest generation writes.
    position_save_generation: Arc<AtomicU64>,
    last_saved_position: Option<(f32, f32)>,
}

impl CameraWindow {
    #[cfg(target_os = "linux")]
    pub(crate) fn recording_snapshot(
        &self,
        window: &Window,
    ) -> anyhow::Result<LinuxCameraRecordingSnapshot> {
        use anyhow::Context as _;
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        use x11rb::protocol::xproto::ConnectionExt as _;

        let frame_dimensions = self
            .frame_dims
            .context("Camera recording requires a delivered preview frame")?;
        let window_id = match HasWindowHandle::window_handle(window)?.as_raw() {
            RawWindowHandle::Xlib(handle) => u32::try_from(handle.window)?,
            RawWindowHandle::Xcb(handle) => handle.window.get(),
            _ => anyhow::bail!("Camera recording geometry requires an X11 window"),
        };
        let (connection, _) = x11rb::connect(None)?;
        let geometry = connection.get_geometry(window_id)?.reply()?;
        let origin = connection
            .translate_coordinates(window_id, geometry.root, 0, 0)?
            .reply()?;
        if !origin.same_screen {
            anyhow::bail!("Camera client and root window are on different X11 screens");
        }
        let viewport = window.viewport_size();
        linux_camera_recording_snapshot(
            self.state,
            frame_dimensions,
            LinuxCameraPhysicalRect {
                x: i32::from(origin.dst_x),
                y: i32::from(origin.dst_y),
                width: u32::from(geometry.width),
                height: u32::from(geometry.height),
            },
            (f32::from(viewport.width), f32::from(viewport.height)),
            window.scale_factor(),
            self.picker_size,
        )
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // `document.documentElement.classList.toggle("dark", true)`
        // (`camera.tsx:128`): the bubble is always dark, whatever the app
        // theme preference says.
        #[cfg(target_os = "windows")]
        platform::apply_window_theme(
            window,
            platform::ForcedAppearance::Dark,
            cx.foreground_executor(),
        );
        #[cfg(not(target_os = "windows"))]
        platform::apply_window_theme(window, platform::ForcedAppearance::Dark);
        let theme = Theme::dark();
        let state = store::load().camera_window.unwrap_or_default();
        #[cfg(not(target_os = "macos"))]
        Feeds::global(cx).update(cx, |feeds, _| {
            feeds.set_camera_preview_state(state.mirrored, state.background_blur)
        });
        let paints = Arc::new(AtomicU32::new(0));
        let preview = cx.new({
            let paints = paints.clone();
            let radius = preview_radius(&state);
            let size = clamp_size(state.size);
            move |cx| CameraPreviewView::new(theme, radius, size, paints, cx)
        });
        let camera = cx.entity();
        let toolbar = cx.new(|cx| CameraToolbarView::new(&camera, cx));

        // `currentWindow.onMoved` + the 400ms position sync
        // (`camera.tsx:167-216`): every move lands in the shared store,
        // debounced, so the next open -- from either app -- restores it.
        cx.observe_window_bounds(window, |this, window, cx| {
            this.queue_position_save(window, cx);
        })
        .detach();

        Self {
            theme,
            state,
            inline: false,
            picker_size: None,
            size_generation: Arc::new(AtomicU64::new(0)),
            chrome_visible: false,
            resizing: None,
            hovered_handle: None,
            #[cfg(target_os = "macos")]
            converter: None,
            #[cfg(target_os = "macos")]
            blur: None,
            #[cfg(target_os = "macos")]
            blur_failed: false,
            preview,
            toolbar,
            frame_dims: None,
            frames_in_window: 0,
            cadence_window_start: Instant::now(),
            paints,
            paints_at_window_start: 0,
            position_save_generation: Arc::new(AtomicU64::new(0)),
            last_saved_position: None,
        }
    }

    pub fn set_inline(&mut self, inline: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.inline == inline {
            return;
        }
        self.inline = inline;
        self.invalidate_pending_resize();
        self.resizing = None;
        self.chrome_visible = false;
        self.hovered_handle = None;
        if !inline {
            self.apply_window_size(window, cx);
        }
        cx.notify();
    }

    pub fn inline_size(&self, viewport: (f32, f32)) -> (f32, f32) {
        inline_preview_size(&self.state, self.frame_aspect(), viewport)
    }

    pub fn is_inline(&self) -> bool {
        self.inline
    }

    pub fn picker_size(&self) -> Option<(f32, f32)> {
        self.picker_size
    }

    pub fn invalidate_pending_resize(&self) {
        self.size_generation.fetch_add(1, Ordering::AcqRel);
    }

    pub fn set_picker_size(
        &mut self,
        size: Option<(f32, f32)>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker_size != size {
            self.invalidate_pending_resize();
            self.picker_size = size;
            self.sync_preview_chrome(cx);
            cx.notify();
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn preview_image(&self, cx: &gpui::App) -> Option<Arc<gpui::RenderImage>> {
        self.preview.read(cx).latest_frame.clone()
    }

    /// Called by the feed pump for every camera frame. Only the preview child
    /// is notified, so the cached toolbar chrome is reused; `refresh` is
    /// reserved for the first frame, where an inactive window may need the
    /// explicit ask (unit-2 finding).
    pub fn frame_arrived(
        &mut self,
        #[cfg(target_os = "macos")] frame: cap_recording::NativeCameraFrame,
        #[cfg(not(target_os = "macos"))] frame: CameraPreviewFrame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        #[cfg(target_os = "macos")]
        {
            use core_foundation::base::TCFType as _;
            use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};

            let blur_mode = self.active_blur_mode();
            let max_dims = blur_mode.is_some().then_some(camera_blur::BLUR_MAX_DIMS);
            if let Some(converted) = frame::FrameConverter::convert(
                &mut self.converter,
                &frame,
                max_dims,
                self.state.mirrored,
            ) {
                let first_frame = self.frame_dims.is_none();
                let dims = converted.dims;
                let dims_changed = self.frame_dims != Some(dims);
                self.frame_dims = Some(dims);

                let mut paint_raw = blur_mode.is_none();
                if let Some(mode) = blur_mode {
                    let job = camera_blur::BlurJob {
                        buffer: camera_blur::SendPixelBuf(converted.buffer.clone()),
                        width: dims.0 as u32,
                        height: dims.1 as u32,
                        ring_generation: converted.generation,
                        mode,
                    };
                    match self.ensure_blur_bridge(window, cx).tx.try_send(job) {
                        Ok(()) => {}
                        // Worker busy: drop this frame and keep the last
                        // painted one -- the bounded(1) latest-wins shape of
                        // the Tauri preview's `camera_tx` (`camera.rs:424`).
                        Err(flume::TrySendError::Full(_)) => {}
                        Err(flume::TrySendError::Disconnected(_)) => {
                            // The worker could not come up (no device, no
                            // ONNX runtime, low-level failure). Same degrade
                            // as `ensure_blur_processor` returning false:
                            // raw frames, latched until the mode changes.
                            tracing::warn!(
                                "camera blur worker unavailable; preview continues unblurred"
                            );
                            self.blur = None;
                            self.blur_failed = true;
                            paint_raw = true;
                        }
                    }
                }

                if paint_raw {
                    let raw =
                        converted.buffer.as_ref() as *const cidre::cv::PixelBuf as CVPixelBufferRef;
                    let buffer = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };
                    self.preview
                        .update(cx, |preview, cx| preview.set_frame(buffer, dims, cx));
                }
                if dims_changed {
                    self.apply_window_size(window, cx);
                    cx.notify();
                }
                if first_frame && !window.is_window_active() {
                    window.refresh();
                }
            } else if self.frame_dims.is_none() && self.frames_in_window == 0 {
                tracing::warn!("camera frame could not be converted for preview");
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let first_frame = self.frame_dims.is_none();
            let dims_changed = self.frame_dims != Some(frame.dims);
            self.frame_dims = Some(frame.dims);
            let previous = self.preview.update(cx, |preview, cx| {
                preview.set_frame(frame.image, frame.dims, cx)
            });
            if let Some(previous) = previous {
                let _ = window.drop_image(previous);
            }
            if dims_changed {
                self.apply_window_size(window, cx);
                cx.notify();
            }
            if first_frame && !window.is_window_active() {
                window.refresh();
            }
        }

        self.frames_in_window += 1;
        let elapsed = self.cadence_window_start.elapsed();
        if elapsed >= Duration::from_secs(5) {
            let painted = self
                .paints
                .load(Ordering::Relaxed)
                .wrapping_sub(self.paints_at_window_start);
            tracing::info!(
                fps = format!(
                    "{:.1}",
                    self.frames_in_window as f64 / elapsed.as_secs_f64()
                ),
                painted_fps = format!("{:.1}", painted as f64 / elapsed.as_secs_f64()),
                "camera preview cadence"
            );
            self.frames_in_window = 0;
            self.cadence_window_start = Instant::now();
            self.paints_at_window_start = self.paints.load(Ordering::Relaxed);
        }
    }

    /// The blur mode frames should be processed with right now: `None` when
    /// off, latched off after a worker failure, and always `None` on low-spec
    /// machines (`ensure_blur_processor`'s early return, `camera.rs:1491-1498`
    /// -- the toggle still cycles and persists there too).
    #[cfg(target_os = "macos")]
    fn active_blur_mode(&self) -> Option<cap_camera_effects::BlurMode> {
        if self.blur_failed || camera_blur::is_low_spec_preview() {
            return None;
        }
        match self.state.background_blur {
            BlurMode::Off => None,
            BlurMode::Light => Some(cap_camera_effects::BlurMode::Light),
            BlurMode::Heavy => Some(cap_camera_effects::BlurMode::Heavy),
        }
    }

    #[cfg(target_os = "macos")]
    fn ensure_blur_bridge(&mut self, window: &Window, cx: &mut Context<Self>) -> &BlurBridge {
        if self.blur.is_none() {
            let (job_tx, job_rx) = flume::bounded::<camera_blur::BlurJob>(1);
            let (out_tx, out_rx) = flume::bounded::<camera_blur::BlurOutput>(2);
            if let Err(error) = std::thread::Builder::new()
                .name("camera-blur".into())
                .spawn(move || camera_blur::run(job_rx, out_tx))
            {
                // job_rx is gone; the caller's try_send sees Disconnected and
                // latches the raw-frame fallback.
                tracing::warn!("camera blur thread failed to spawn: {error}");
            }
            let handle = window.window_handle();
            let pump = cx.spawn(async move |this, cx| {
                while let Ok(output) = out_rx.recv_async().await {
                    let first = match this.update(cx, |this: &mut CameraWindow, cx| {
                        this.blurred_frame_arrived(output, cx)
                    }) {
                        Ok(first) => first,
                        Err(_) => break,
                    };
                    if first {
                        handle
                            .update(cx, |_, window, _| {
                                if !window.is_window_active() {
                                    window.refresh();
                                }
                            })
                            .ok();
                    }
                }
            });
            self.blur = Some(BlurBridge {
                tx: job_tx,
                first_output_pending: true,
                _pump: pump,
            });
        }
        self.blur.as_ref().expect("just ensured")
    }

    /// A blurred surface came back from the worker; paint it. Returns whether
    /// it was the bridge's first output (the pump may owe an explicit
    /// refresh).
    #[cfg(target_os = "macos")]
    fn blurred_frame_arrived(
        &mut self,
        output: camera_blur::BlurOutput,
        cx: &mut Context<Self>,
    ) -> bool {
        // A stale output can land after the mode flips back to Off; the raw
        // path is already painting again, so drop it.
        if self.state.background_blur == BlurMode::Off {
            return false;
        }
        let first = self
            .blur
            .as_mut()
            .is_some_and(|bridge| std::mem::take(&mut bridge.first_output_pending));

        use core_foundation::base::TCFType as _;
        use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};
        let dims = (output.width as usize, output.height as usize);
        let raw = &*output.buffer.0 as *const cidre::cv::PixelBuf as CVPixelBufferRef;
        let buffer = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };
        self.preview
            .update(cx, |preview, cx| preview.set_frame(buffer, dims, cx));
        first
    }

    fn frame_aspect(&self) -> Option<f32> {
        self.frame_dims
            .map(|(width, height)| width as f32 / height.max(1) as f32)
    }

    fn toolbar_scale(&self) -> f32 {
        0.7 + normalized_size(&self.state) * 0.3
    }

    /// Pushes the chrome inputs the preview renders with (its own notify is
    /// the only thing that busts its cache).
    fn sync_preview_chrome(&mut self, cx: &mut Context<Self>) {
        let radius = picker_preview_radius(&self.state, self.picker_size);
        let size = clamp_size(self.state.size);
        self.preview
            .update(cx, |preview, cx| preview.set_chrome(radius, size, cx));
    }

    fn mutate_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        mutate: impl FnOnce(&mut CameraWindowState),
    ) {
        #[cfg(target_os = "macos")]
        let blur_before = self.state.background_blur;
        self.picker_size = None;
        mutate(&mut self.state);
        self.state.size = clamp_size(self.state.size);
        #[cfg(not(target_os = "macos"))]
        Feeds::global(cx).update(cx, |feeds, _| {
            feeds.set_camera_preview_state(self.state.mirrored, self.state.background_blur)
        });
        #[cfg(target_os = "macos")]
        {
            if self.state.background_blur != blur_before {
                // Changing the mode is the retry point after a failed
                // bring-up.
                self.blur_failed = false;
            }
            if self.state.background_blur == BlurMode::Off {
                // Ends the worker thread, dropping the ONNX session and every
                // GPU texture -- `release_blur_resources`
                // (`camera.rs:1477-1484`).
                self.blur = None;
            }
        }
        self.apply_window_size(window, cx);
        self.sync_preview_chrome(cx);
        self.persist(cx);
        cx.notify();
    }

    /// Resize to the state's dimensions, top-left anchored, clamped inside
    /// the current monitor -- `resize_window` (`camera.rs:1683-1788`), which
    /// runs on every size/shape/aspect change over there. gpui's
    /// `Window::resize` is AppKit `setContentSize:`, which anchors the
    /// *bottom*-left, so the anchor and the clamp both go through one native
    /// `setFrame:` instead.
    fn apply_window_size(&self, window: &mut Window, cx: &mut Context<Self>) {
        if self.inline {
            return;
        }
        let (width, height) = self
            .picker_size
            .unwrap_or_else(|| window_size(&self.state, self.frame_aspect()));
        let generation = self.size_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let generations = self.size_generation.clone();

        let bounds = window.bounds();
        let (x, y) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
        let (mut new_x, mut new_y) = (x, y);
        if let Some(display_bounds) = window.display(cx).map(|display| display.bounds()) {
            let (dx, dy) = (
                f32::from(display_bounds.origin.x),
                f32::from(display_bounds.origin.y),
            );
            let (dw, dh) = (
                f32::from(display_bounds.size.width),
                f32::from(display_bounds.size.height),
            );
            if new_x + width > dx + dw {
                new_x = dx + dw - width;
            }
            if new_y + height > dy + dh {
                new_y = dy + dh - height;
            }
            if new_x < dx {
                new_x = dx;
            }
            if new_y < dy {
                new_y = dy;
            }
        }

        #[cfg(target_os = "windows")]
        if let Some(native) = platform::native_window(window) {
            cx.spawn(async move |_, _| {
                if generations.load(Ordering::Acquire) != generation {
                    return;
                }
                platform::set_window_logical_frame(
                    &native,
                    f64::from(new_x),
                    f64::from(new_y),
                    f64::from(width),
                    f64::from(height),
                );
            })
            .detach();
        } else {
            window.resize(size(px(width), px(height)));
        }

        #[cfg(not(target_os = "windows"))]
        if let Some(native) = platform::native_window(window) {
            let (frame_x, frame_y, _, frame_height) = platform::window_frame(&native);
            // AppKit y grows upward: keep the gpui-space top edge, then apply
            // the clamp deltas (gpui +y = AppKit -y).
            let appkit_x = frame_x + (new_x - x) as f64;
            let appkit_y = (frame_y + frame_height) - (new_y - y) as f64 - height as f64;
            // `setFrame:` synchronously re-enters gpui's own window
            // callbacks, so it runs from a fresh runloop turn (the
            // `set_window_frame` rule).
            cx.spawn(async move |_, _| {
                if generations.load(Ordering::Acquire) != generation {
                    return;
                }
                platform::set_window_frame(
                    &native,
                    appkit_x,
                    appkit_y,
                    width as f64,
                    height as f64,
                );
            })
            .detach();
        } else {
            window.resize(size(px(width), px(height)));
        }
    }

    fn persist(&self, cx: &mut Context<Self>) {
        let state = self.state;
        cx.background_executor()
            .spawn(async move {
                store::update(|persisted| persisted.camera_window = Some(state));
            })
            .detach();
    }

    /// `queueCameraPositionSave` (`camera.tsx:93-112`): a 200ms debounce over
    /// the window's logical top-left, skipped when it has not moved a whole
    /// pixel.
    fn queue_position_save(&mut self, window: &Window, cx: &mut Context<Self>) {
        let origin = window.bounds().origin;
        let (x, y) = (f32::from(origin.x), f32::from(origin.y));
        if self
            .last_saved_position
            .is_some_and(|(sx, sy)| (sx - x).abs() < 1. && (sy - y).abs() < 1.)
        {
            return;
        }
        self.last_saved_position = Some((x, y));
        let generation = self.position_save_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let generations = self.position_save_generation.clone();
        let executor = cx.background_executor().clone();
        cx.background_executor()
            .spawn(async move {
                executor.timer(Duration::from_millis(200)).await;
                if generations.load(Ordering::Acquire) == generation {
                    persist_camera_position(x as f64, y as f64);
                }
            })
            .detach();
    }

    fn close(&mut self, cx: &mut Context<Self>) {
        // Deselecting the camera is what closes the window (`Feeds` observes
        // the selection); mirrors the Tauri close button closing the webview
        // and the main window's selection following it.
        Feeds::global(cx).update(cx, |feeds, cx| feeds.set_camera(None, cx));
    }

    // Mirrors `ControlButton`'s prop list; a config struct would just rename
    // the same eight things. No hover style on purpose: `ControlButton`
    // (`CameraPreviewChrome.tsx:206-216`) styles only the pressed state.
    #[allow(clippy::too_many_arguments)]
    fn toolbar_button(
        &self,
        id: &'static str,
        icon: &'static str,
        pressed: bool,
        scale: f32,
        label: Option<&'static str>,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id(id)
            .p(px(8. * scale))
            .rounded(px(8. * scale))
            .when(pressed, |this| {
                this.bg(theme.gray_3).text_color(theme.gray_12)
            })
            // No `.occlude()` here: an occluding hitbox breaks gpui's hit
            // test at the button (`hit_test` stops at `BlockMouse`), which
            // drops `camera-root` from the hover set -- the chrome would
            // vanish the moment the cursor reached a control, before it could
            // be clicked. The Tauri page keeps its chrome up while the
            // pointer is anywhere over the window, controls included
            // (`camera.tsx:781-783`). Keeping the press out of the root's
            // window-move listener is stop_propagation's job instead; the
            // button's own click tracker dispatches before this listener
            // (deepest-first bubble order), so the click still lands.
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.prevent_default();
                cx.stop_propagation();
            })
            .on_click(cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                on_click(this, window, cx);
            }))
            .child(
                div()
                    .relative()
                    .child(
                        svg()
                            .path(icon)
                            .size(px(22. * scale))
                            .text_color(if pressed {
                                theme.gray_12.into()
                            } else {
                                gpui::Hsla::from(theme.gray_10)
                            }),
                    )
                    .when_some(label, |this, label| {
                        this.child(
                            div()
                                .absolute()
                                .bottom(px(-4. * scale))
                                .left_0()
                                .right_0()
                                .flex()
                                .justify_center()
                                .text_size(px(7. * scale))
                                .font_weight(gpui::FontWeight::BOLD)
                                .text_color(theme.gray_12)
                                .child(label),
                        )
                    }),
            )
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let scale = self.toolbar_scale();
        let shape_icon = match self.state.shape {
            CameraShape::Round => "icons/circle.svg",
            CameraShape::Square => "icons/square.svg",
            CameraShape::Full => "icons/rectangle-horizontal.svg",
        };

        div()
            .h(px(CAMERA_TOOLBAR_HEIGHT))
            .w_full()
            .flex_none()
            .flex()
            .flex_row()
            .justify_center()
            .items_center()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(4. * scale))
                    .p(px(4. * scale))
                    .rounded(px(12. * scale))
                    .bg(theme.gray_1)
                    .border_1()
                    .border_color(gpui::hsla(0., 0., 1., 0.2))
                    .text_color(theme.gray_10)
                    .when(!self.chrome_visible && self.resizing.is_none(), |this| {
                        this.invisible()
                    })
                    .child(self.toolbar_button(
                        "close",
                        "icons/circle-x.svg",
                        false,
                        scale,
                        None,
                        cx,
                        |this, _, cx| this.close(cx),
                    ))
                    .child(self.toolbar_button(
                        "size",
                        "icons/enlarge.svg",
                        self.state.size >= CAMERA_PRESET_LARGE,
                        scale,
                        None,
                        cx,
                        |this, window, cx| {
                            this.mutate_state(window, cx, |state| {
                                state.size = if state.size < CAMERA_PRESET_LARGE {
                                    CAMERA_PRESET_LARGE
                                } else {
                                    CAMERA_PRESET_SMALL
                                };
                            })
                        },
                    ))
                    .child(self.toolbar_button(
                        "shape",
                        shape_icon,
                        self.state.shape != CameraShape::Round,
                        scale,
                        None,
                        cx,
                        |this, window, cx| {
                            this.mutate_state(window, cx, |state| {
                                state.shape = match state.shape {
                                    CameraShape::Round => CameraShape::Square,
                                    CameraShape::Square => CameraShape::Full,
                                    CameraShape::Full => CameraShape::Round,
                                };
                            })
                        },
                    ))
                    // Preview-only, like both Tauri paths (the WGSL UV flip /
                    // the legacy `scaleX(-1)`); the recorded camera track is
                    // never mirrored by either app.
                    .child(self.toolbar_button(
                        "mirror",
                        "icons/arrows.svg",
                        self.state.mirrored,
                        scale,
                        None,
                        cx,
                        |this, window, cx| {
                            this.mutate_state(window, cx, |state| {
                                state.mirrored = !state.mirrored;
                            })
                        },
                    ))
                    .child(self.toolbar_button(
                        "blur",
                        "icons/person-standing.svg",
                        self.state.background_blur != BlurMode::Off,
                        scale,
                        self.state.background_blur.label(),
                        cx,
                        |this, window, cx| {
                            this.mutate_state(window, cx, |state| {
                                state.background_blur = state.background_blur.cycle();
                            })
                        },
                    )),
            )
    }

    /// `CameraResizeHandles` + `ResizeCornerHandle`
    /// (`CameraPreviewChrome.tsx:218-357`): a 28px hit area per corner, with
    /// a 14px white 2px-bordered bracket inset 6px, rounded 6px on its outer
    /// corner. Opacity 0 hidden / 0.7 with chrome visible / 1.0 hovered or
    /// resizing. The 150ms transition, the hover `scale-110` and the
    /// `drop-shadow` filter have no hooks here (no animation pass, no
    /// transform, and a box shadow would shadow the bracket's full rect, not
    /// its L-shape).
    fn render_resize_handles(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let visible = self.chrome_visible || self.resizing.is_some();
        let mut layer = div()
            .absolute()
            .top(px(CAMERA_TOOLBAR_HEIGHT))
            .bottom_0()
            .left_0()
            .right_0();

        for corner in ResizeCorner::ALL {
            let id: &'static str = match corner {
                ResizeCorner::NorthWest => "resize-nw",
                ResizeCorner::NorthEast => "resize-ne",
                ResizeCorner::SouthWest => "resize-sw",
                ResizeCorner::SouthEast => "resize-se",
            };
            let active = self
                .resizing
                .as_ref()
                .is_some_and(|drag| drag.corner == corner)
                || self.hovered_handle == Some(corner);

            let mut bracket = div()
                .absolute()
                .size(px(14.))
                .border_color(gpui::white())
                .opacity(if active {
                    1.0
                } else if visible {
                    0.7
                } else {
                    0.0
                });
            bracket = match corner {
                ResizeCorner::NorthWest => bracket
                    .top(px(6.))
                    .left(px(6.))
                    .border_t_2()
                    .border_l_2()
                    .rounded_tl(px(6.)),
                ResizeCorner::NorthEast => bracket
                    .top(px(6.))
                    .right(px(6.))
                    .border_t_2()
                    .border_r_2()
                    .rounded_tr(px(6.)),
                ResizeCorner::SouthWest => bracket
                    .bottom(px(6.))
                    .left(px(6.))
                    .border_b_2()
                    .border_l_2()
                    .rounded_bl(px(6.)),
                ResizeCorner::SouthEast => bracket
                    .bottom(px(6.))
                    .right(px(6.))
                    .border_b_2()
                    .border_r_2()
                    .rounded_br(px(6.)),
            };

            // Like the toolbar buttons, no `.occlude()`: it would knock the
            // root's hover flag false over the 28px corner hit areas (even
            // while the brackets are invisible) and hide the chrome mid-
            // travel. The handle's own on_mouse_down stops propagation, which
            // is what keeps a resize press from starting a window move.
            let mut handle = div().id(id).absolute().size(px(28.)).child(bracket);
            // `cursor-nw-resize` and friends (`CameraPreviewChrome.tsx:306-317`).
            handle = match corner {
                ResizeCorner::NorthWest => handle
                    .top_0()
                    .left_0()
                    .cursor(gpui::CursorStyle::ResizeUpLeftDownRight),
                ResizeCorner::NorthEast => handle
                    .top_0()
                    .right_0()
                    .cursor(gpui::CursorStyle::ResizeUpRightDownLeft),
                ResizeCorner::SouthWest => handle
                    .bottom_0()
                    .left_0()
                    .cursor(gpui::CursorStyle::ResizeUpRightDownLeft),
                ResizeCorner::SouthEast => handle
                    .bottom_0()
                    .right_0()
                    .cursor(gpui::CursorStyle::ResizeUpLeftDownRight),
            };
            layer = layer.child(
                handle
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        let next = if *hovered { Some(corner) } else { None };
                        let relevant = *hovered || this.hovered_handle == Some(corner);
                        if relevant && this.hovered_handle != next {
                            this.hovered_handle = next;
                            cx.notify();
                        }
                    }))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                            window.prevent_default();
                            cx.stop_propagation();
                            let (start_size, start_picker_size) =
                                resize_start(this.state.size, this.picker_size);
                            this.resizing = Some(ResizeDrag {
                                corner,
                                start_size,
                                start_picker_size,
                                start_position: event.position,
                            });
                            cx.notify();
                        }),
                    ),
            );
        }
        layer
    }

    fn handle_resize_move(
        &mut self,
        event: &MouseMoveEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(drag) = &self.resizing else {
            return;
        };
        // `CameraResizeHandles.handleResizeMove`: outward drag on either axis
        // grows the square size, diagonal takes the larger delta.
        let delta_x = f32::from(event.position.x - drag.start_position.x);
        let delta_y = f32::from(event.position.y - drag.start_position.y);
        let dx = if drag.corner.east() {
            delta_x
        } else {
            -delta_x
        };
        let dy = if drag.corner.south() {
            delta_y
        } else {
            -delta_y
        };
        let delta = dx.max(dy);
        match resize_target(drag.start_size, drag.start_picker_size, delta) {
            ResizeTarget::Picker(next) => {
                if self.picker_size.is_some_and(|current| {
                    (current.0 - next.0).abs() <= 0.5 && (current.1 - next.1).abs() <= 0.5
                }) {
                    return;
                }
                self.picker_size = Some(next);
                self.apply_window_size(window, cx);
                self.sync_preview_chrome(cx);
                cx.notify();
            }
            ResizeTarget::State(next) => {
                if self.picker_size.is_none() && (next - self.state.size).abs() <= 0.5 {
                    return;
                }
                self.picker_size = None;
                self.state.size = next;
                self.apply_window_size(window, cx);
                self.sync_preview_chrome(cx);
                cx.notify();
            }
        }
    }

    fn end_resize(&mut self, cx: &mut Context<Self>) {
        if self.resizing.take().is_some() {
            self.persist(cx);
            cx.notify();
        }
    }
}

impl Render for CameraWindow {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let resizing = self.resizing.is_some();

        div()
            .id("camera-root")
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            // One hover region for the whole window -- bubble, toolbar and
            // resize handles alike -- matching the Tauri page's container
            // (`onPointerMove={chrome.show}` / `onPointerLeave={chrome.hide}`,
            // `camera.tsx:781-783`, no linger timeout). This only holds while
            // no descendant occludes: `hitbox.is_hovered` walks the hit test
            // top-down and stops at the first `BlockMouse` hitbox, so an
            // `.occlude()` on any control would flip this false while the
            // cursor is over that control and hide the chrome under it.
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if this.chrome_visible != *hovered {
                    this.chrome_visible = *hovered;
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| {
                    if this.resizing.is_none() && !this.inline {
                        window.start_window_move();
                    }
                }),
            )
            .when(resizing, |this| {
                let move_camera = cx.entity().downgrade();
                let up_camera = cx.entity().downgrade();
                this.child(gpui::canvas(
                    |_bounds, _window, _cx| (),
                    move |_bounds, (), window, _cx| {
                        let camera = move_camera.clone();
                        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, cx| {
                            if phase != gpui::DispatchPhase::Bubble {
                                return;
                            }
                            camera
                                .update(cx, |this, cx| {
                                    if event.dragging() {
                                        this.handle_resize_move(event, window, cx);
                                    } else {
                                        this.end_resize(cx);
                                    }
                                })
                                .ok();
                        });
                        let camera = up_camera.clone();
                        window.on_mouse_event(move |event: &MouseUpEvent, phase, _window, cx| {
                            if phase != gpui::DispatchPhase::Bubble
                                || event.button != MouseButton::Left
                            {
                                return;
                            }
                            camera.update(cx, |this, cx| this.end_resize(cx)).ok();
                        });
                    },
                ))
            })
            .child(
                self.toolbar.clone().cached(
                    StyleRefinement::default()
                        .w_full()
                        .h(px(CAMERA_TOOLBAR_HEIGHT))
                        .flex_none(),
                ),
            )
            .child(
                self.preview
                    .clone()
                    .cached(StyleRefinement::default().w_full().flex_1()),
            )
            .child(self.render_resize_handles(cx))
    }
}

// ---------------------------------------------------------------------------
// Position persistence -- the shared store's `cameraWindowPosition`
// ---------------------------------------------------------------------------

/// `WindowPosition` (`general_settings.rs:145-150`), camelCase in the store
/// like the rest of `general_settings`. `DisplayId` is the same
/// `scap_targets` type the Tauri app serializes, so the bytes interop.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWindowPosition {
    x: f64,
    y: f64,
    #[serde(default)]
    display_id: Option<scap_targets::DisplayId>,
}

fn display_contains(display: &scap_targets::Display, x: f64, y: f64) -> bool {
    display.raw_handle().logical_bounds().is_some_and(|bounds| {
        x >= bounds.position().x()
            && x < bounds.position().x() + bounds.size().width()
            && y >= bounds.position().y()
            && y < bounds.position().y() + bounds.size().height()
    })
}

/// `display_for_position` (`lib.rs:1612-1625`).
pub fn display_for_point(x: f64, y: f64) -> Option<scap_targets::Display> {
    scap_targets::Display::list()
        .into_iter()
        .find(|display| display_contains(display, x, y))
}

/// `is_position_on_monitor_name` (`windows.rs:857-878`).
fn position_on_monitor_name(name: &str, x: f64, y: f64) -> bool {
    scap_targets::Display::list()
        .into_iter()
        .any(|display| display.name().as_deref() == Some(name) && display_contains(&display, x, y))
}

/// `is_position_on_any_screen` (`windows.rs:880-896`).
fn any_display_contains(x: f64, y: f64) -> bool {
    scap_targets::Display::list()
        .into_iter()
        .any(|display| display_contains(&display, x, y))
}

/// The saved position that is still valid for `preferred` -- the Tauri
/// restore decision (`windows.rs:2289-2321`): the per-monitor-name entry for
/// the preferred monitor when the point is still on a monitor of that name,
/// else the global `cameraWindowPosition` on the preferred monitor; with no
/// monitor name, the global position validated against its recorded display
/// (or any screen).
fn saved_position(preferred: &scap_targets::Display) -> Option<(f64, f64)> {
    let settings = store::store_section(store::GENERAL_SETTINGS);
    let parse = |value: &Value| serde_json::from_value::<StoredWindowPosition>(value.clone()).ok();
    let global = settings.get("cameraWindowPosition").and_then(parse);

    let position = match preferred.name().filter(|name| !name.trim().is_empty()) {
        Some(name) => settings
            .get("cameraWindowPositionsByMonitorName")
            .and_then(|value| value.as_object())
            .and_then(|map| map.get(&name))
            .and_then(parse)
            .filter(|pos| position_on_monitor_name(&name, pos.x, pos.y))
            .or_else(|| global.filter(|pos| position_on_monitor_name(&name, pos.x, pos.y))),
        None => global.filter(|pos| match &pos.display_id {
            Some(id) => scap_targets::Display::from_id(id)
                .is_some_and(|display| display_contains(&display, pos.x, pos.y)),
            None => any_display_contains(pos.x, pos.y),
        }),
    };
    position.map(|pos| (pos.x, pos.y))
}

/// Where a fresh bubble opens: the saved position when still valid, else the
/// Tauri default slot -- bottom-right of the preferred monitor measured with
/// `DEFAULT_WINDOW_SIZE = 230.0 * 2.0` (`windows.rs:2160, 2340-2344`; the
/// constant, not the actual window size, is what the shipping app subtracts).
pub fn opening_position(preferred: &scap_targets::Display) -> (f32, f32) {
    if let Some((x, y)) = saved_position(preferred) {
        tracing::info!(x, y, "camera window restored to its saved position");
        return (x as f32, y as f32);
    }
    const TAURI_DEFAULT_WINDOW_SIZE: f64 = 230.0 * 2.0;
    match preferred.raw_handle().logical_bounds() {
        Some(bounds) => (
            (bounds.position().x() + bounds.size().width() - TAURI_DEFAULT_WINDOW_SIZE - 100.)
                as f32,
            (bounds.position().y() + bounds.size().height() - TAURI_DEFAULT_WINDOW_SIZE - 100.)
                as f32,
        ),
        None => (100., 100.),
    }
}

/// `update_camera_window_position_settings` (`lib.rs:1645-1666`): the global
/// position plus the per-monitor-name map entry, both carrying the display
/// id. Runs on the background executor -- two store read-modify-writes.
fn persist_camera_position(x: f64, y: f64) {
    let display = display_for_point(x, y);
    let position = StoredWindowPosition {
        x,
        y,
        display_id: display.as_ref().map(|display| display.id()),
    };
    let Ok(value) = serde_json::to_value(&position) else {
        return;
    };
    store::set_store_setting(
        store::GENERAL_SETTINGS,
        "cameraWindowPosition",
        value.clone(),
    );

    let monitor_name = display
        .as_ref()
        .and_then(|display| display.name())
        .filter(|name| !name.trim().is_empty());
    if let Some(name) = monitor_name {
        let mut map = store::store_section(store::GENERAL_SETTINGS)
            .remove("cameraWindowPositionsByMonitorName")
            .and_then(|value| match value {
                Value::Object(map) => Some(map),
                _ => None,
            })
            .unwrap_or_default();
        map.insert(name, value);
        store::set_store_setting(
            store::GENERAL_SETTINGS,
            "cameraWindowPositionsByMonitorName",
            Value::Object(map),
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod recording_snapshot_tests {
    use super::*;

    fn geometry(
        state: CameraWindowState,
        frame_dimensions: (usize, usize),
        scale: f32,
        origin: (i32, i32),
    ) -> (LinuxCameraPhysicalRect, (f32, f32)) {
        let logical = window_size(
            &state,
            Some(frame_dimensions.0 as f32 / frame_dimensions.1 as f32),
        );
        let width = (logical.0 * scale).round() as u32;
        let height = (logical.1 * scale).round() as u32;
        (
            LinuxCameraPhysicalRect {
                x: origin.0,
                y: origin.1,
                width,
                height,
            },
            (width as f32 / scale, height as f32 / scale),
        )
    }

    #[test]
    fn snapshot_uses_client_origin_and_scaled_toolbar_at_supported_scales() {
        let state = CameraWindowState::default();
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for origin in [(37, 91), (-1920, -1080)] {
                let (client, viewport) = geometry(state, (640, 480), scale, origin);
                let snapshot = linux_camera_recording_snapshot(
                    state,
                    (640, 480),
                    client,
                    viewport,
                    scale,
                    None,
                )
                .unwrap();
                let expected_side = (state.size * scale).round() as u32;
                assert_eq!(
                    snapshot.content_rect,
                    LinuxCameraPhysicalRect {
                        x: origin.0,
                        y: origin.1 + (CAMERA_TOOLBAR_HEIGHT * scale).round() as i32,
                        width: expected_side,
                        height: expected_side,
                    }
                );
                assert_eq!(snapshot.corner_radius_pixels, state.size * scale / 2.0);
                assert_eq!(snapshot.state, state);
            }
        }
    }

    #[test]
    fn snapshot_preserves_full_aspect_and_live_effect_state() {
        let state = CameraWindowState {
            size: 400.0,
            shape: CameraShape::Full,
            mirrored: true,
            background_blur: BlurMode::Heavy,
        };
        let (client, viewport) = geometry(state, (1920, 1080), 1.5, (-1400, 20));
        let snapshot =
            linux_camera_recording_snapshot(state, (1920, 1080), client, viewport, 1.5, None)
                .unwrap();
        assert_eq!(snapshot.content_rect.width, 1067);
        assert_eq!(snapshot.content_rect.height, 600);
        assert_eq!(snapshot.content_rect.x, -1400);
        assert_eq!(snapshot.content_rect.y, 104);
        assert_eq!(snapshot.corner_radius_pixels, 36.0);
        assert_eq!(snapshot.state, state);
    }

    #[test]
    fn snapshot_accepts_temporary_picker_size_without_changing_saved_size() {
        let state = CameraWindowState::default();
        let viewport = (150.0, 206.0);
        let client = LinuxCameraPhysicalRect {
            x: 80,
            y: 120,
            width: 150,
            height: 206,
        };
        assert!(
            linux_camera_recording_snapshot(state, (640, 480), client, viewport, 1.0, None,)
                .is_err()
        );
        let snapshot = linux_camera_recording_snapshot(
            state,
            (640, 480),
            client,
            viewport,
            1.0,
            Some(viewport),
        )
        .unwrap();
        assert_eq!(snapshot.state, state);
        assert_eq!(
            snapshot.content_rect,
            LinuxCameraPhysicalRect {
                x: 80,
                y: 176,
                width: 150,
                height: 150,
            }
        );
        assert!(
            linux_camera_recording_snapshot(
                state,
                (640, 480),
                client,
                viewport,
                1.0,
                Some((151.0, 206.0)),
            )
            .is_err()
        );
    }

    #[test]
    fn snapshot_square_radius_scales_without_becoming_a_circle() {
        let state = CameraWindowState {
            shape: CameraShape::Square,
            background_blur: BlurMode::Light,
            ..CameraWindowState::default()
        };
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let (client, viewport) = geometry(state, (1280, 720), scale, (0, 0));
            let snapshot =
                linux_camera_recording_snapshot(state, (1280, 720), client, viewport, scale, None)
                    .unwrap();
            assert_eq!(snapshot.content_rect.width, snapshot.content_rect.height);
            assert_eq!(snapshot.corner_radius_pixels, 24.0 * scale);
            assert_eq!(snapshot.state, state);
        }
    }

    #[test]
    fn snapshot_rejects_native_viewport_and_pending_state_resize_mismatches() {
        let state = CameraWindowState::default();
        let (client, viewport) = geometry(state, (640, 480), 1.25, (0, 0));
        assert!(
            linux_camera_recording_snapshot(
                state,
                (640, 480),
                client,
                (viewport.0 + 1.0, viewport.1),
                1.25,
                None,
            )
            .is_err()
        );
        assert!(
            linux_camera_recording_snapshot(
                CameraWindowState {
                    size: 400.0,
                    ..state
                },
                (640, 480),
                client,
                viewport,
                1.25,
                None,
            )
            .is_err()
        );
        let full = CameraWindowState {
            shape: CameraShape::Full,
            ..state
        };
        let (client, viewport) = geometry(full, (1920, 1080), 1.0, (0, 0));
        assert!(
            linux_camera_recording_snapshot(full, (2400, 1000), client, viewport, 1.0, None)
                .is_err()
        );
    }

    #[test]
    fn snapshot_rejects_invalid_scale_size_frame_and_viewport() {
        let state = CameraWindowState::default();
        let (client, viewport) = geometry(state, (640, 480), 1.0, (0, 0));
        for invalid in [0.0, -1.0, f32::NAN, f32::INFINITY] {
            assert!(
                linux_camera_recording_snapshot(state, (640, 480), client, viewport, invalid, None)
                    .is_err()
            );
            assert!(
                linux_camera_recording_snapshot(
                    CameraWindowState {
                        size: invalid,
                        ..state
                    },
                    (640, 480),
                    client,
                    viewport,
                    1.0,
                    None,
                )
                .is_err()
            );
            assert!(
                linux_camera_recording_snapshot(
                    state,
                    (640, 480),
                    client,
                    (invalid, viewport.1),
                    1.0,
                    None,
                )
                .is_err()
            );
        }
        for frame in [(0, 480), (640, 0)] {
            assert!(
                linux_camera_recording_snapshot(state, frame, client, viewport, 1.0, None).is_err()
            );
        }
        assert!(
            linux_camera_recording_snapshot(
                state,
                (640, 480),
                LinuxCameraPhysicalRect { width: 0, ..client },
                viewport,
                1.0,
                None,
            )
            .is_err()
        );
    }

    #[test]
    fn snapshot_rejects_coordinate_and_scaled_extent_overflow() {
        let state = CameraWindowState::default();
        for origin in [(i32::MAX, 0), (0, i32::MAX)] {
            let (client, viewport) = geometry(state, (640, 480), 1.0, origin);
            assert!(
                linux_camera_recording_snapshot(state, (640, 480), client, viewport, 1.0, None)
                    .is_err()
            );
        }
        assert!(recording_physical_extent(f32::MAX, 2.0).is_err());
        assert!(recording_physical_extent(i32::MAX as f32, 1.0).is_err());
    }

    #[test]
    fn snapshot_preserves_one_pixel_rounding_difference_at_fractional_scale() {
        let state = CameraWindowState::default();
        let scale = 4.0 / 3.0;
        let (client, viewport) = geometry(state, (640, 480), scale, (0, 0));
        let snapshot =
            linux_camera_recording_snapshot(state, (640, 480), client, viewport, scale, None)
                .unwrap();
        assert_eq!(snapshot.content_rect.width, 307);
        assert_eq!(snapshot.content_rect.height, 306);
        assert_eq!(snapshot.content_rect.x, client.x);
        assert_eq!(snapshot.content_rect.y, client.y + 75);
    }
}
