//! The camera preview bubble -- `camera.tsx` + `CameraPreviewChrome.tsx`,
//! natively.
//!
//! Layout parity: a transparent window, 56px toolbar strip on top (chrome
//! appears on hover), preview container below it clipped to the shape
//! (round / square / full), four corner resize handles below the toolbar,
//! drag-anywhere to move the window. Frames arrive as CoreVideo pixel buffers
//! from the app-scoped [`CameraFeed`]; VideoToolbox converts them to BGRA
//! IOSurfaces and gpui paints those directly via `paint_surface_fitted`
//! (cover-fit + rounded clip on the primitive) -- no CPU pixel copies and no
//! sprite-atlas uploads on the frame path.
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
//! Known deviations (also in the README): no mirroring (the toolbar button is
//! present but disabled), background blur cycles/persists but does not
//! process frames yet, and the window position is not persisted per-monitor.

use std::sync::{
    Arc,
    atomic::{AtomicU32, Ordering},
};
use std::time::{Duration, Instant};

use gpui::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement as _, Render,
    StatefulInteractiveElement as _, StyleRefinement, Styled, Subscription, WeakEntity, Window,
    div, prelude::FluentBuilder as _, px, size, svg,
};

use crate::{
    feeds::Feeds,
    store::{self, BlurMode, CameraShape, CameraWindowState},
    theme::Theme,
};

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

/// 0..1 across the 150..600 size range -- drives the toolbar scale and the
/// square-shape corner radius, like `cameraToolbarScale` /
/// `cameraBorderRadius`.
fn normalized_size(state: &CameraWindowState) -> f32 {
    (clamp_size(state.size) - CAMERA_MIN_SIZE) / (CAMERA_MAX_SIZE - CAMERA_MIN_SIZE)
}

fn preview_radius(state: &CameraWindowState) -> f32 {
    match state.shape {
        CameraShape::Round => clamp_size(state.size) / 2.,
        // 3rem + normalized * 1.5rem.
        _ => 48. + normalized_size(state) * 24.,
    }
}

#[cfg(target_os = "macos")]
mod frame {
    use cidre::{arc, cf, cv};

    /// Converts camera frames (typically `420v`) into BGRA IOSurface-backed
    /// pixel buffers that gpui paints directly via `paint_surface_fitted`.
    ///
    /// VideoToolbox does the `420v` -> BGRA conversion in hardware either way;
    /// pointing it at an IOSurface destination removes the old per-frame CPU
    /// row-copy into a `RenderImage` and the sprite-atlas re-upload
    /// (`camera-preview-convert-benchmark`: 196us -> 137us per 720p frame on
    /// the conversion alone, byte-identical output, before atlas savings).
    ///
    /// The fixed ring keeps a buffer alive while gpui's scene still references
    /// the previous one; four slots at camera rates leaves ~100ms before a
    /// slot is overwritten.
    pub struct FrameConverter {
        session: arc::R<cidre::vt::PixelTransferSession>,
        ring: Vec<arc::R<cv::PixelBuf>>,
        next: usize,
        dims: (usize, usize),
    }

    // Only touched from the main thread; the CF objects have atomic refcounts.
    unsafe impl Send for FrameConverter {}

    const RING_SIZE: usize = 4;

    impl FrameConverter {
        fn new(width: usize, height: usize) -> Option<Self> {
            let mut session = cidre::vt::PixelTransferSession::new().ok()?;
            session.set_realtime(true).ok()?;
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
            let ring = (0..RING_SIZE)
                .map(|_| {
                    cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, Some(&attrs))
                        .ok()
                        .filter(|buf| buf.io_surf().is_some())
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Self {
                session,
                ring,
                next: 0,
                dims: (width, height),
            })
        }

        /// The frame as a BGRA IOSurface-backed pixel buffer. Recreates the
        /// ring when the camera's frame size changes.
        pub fn convert(
            this: &mut Option<Self>,
            frame: &cap_recording::NativeCameraFrame,
        ) -> Option<arc::R<cv::PixelBuf>> {
            let src = frame.sample_buf.image_buf()?;
            let dims = (src.width(), src.height());
            if this.as_ref().is_none_or(|converter| converter.dims != dims) {
                *this = Self::new(dims.0, dims.1);
            }
            let converter = this.as_mut()?;

            let dst = converter.ring[converter.next].clone();
            converter.next = (converter.next + 1) % converter.ring.len();
            converter.session.transfer(&src, &dst).ok()?;
            Some(dst)
        }
    }
}

#[derive(Debug, Clone, Copy)]
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
    start_position: gpui::Point<gpui::Pixels>,
}

/// The per-frame half of the window: owns the latest converted frame and is
/// the only entity notified at camera rate. Chrome invalidation goes through
/// the parent [`CameraWindow`] instead, so a frame draw reuses the cached
/// toolbar subtree.
struct CameraPreviewView {
    theme: Theme,
    radius: f32,
    #[cfg(target_os = "macos")]
    latest_frame: Option<core_video::pixel_buffer::CVPixelBuffer>,
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
    fn new(theme: Theme, radius: f32, paints: Arc<AtomicU32>, cx: &mut Context<Self>) -> Self {
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
            #[cfg(target_os = "macos")]
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

    fn set_chrome(&mut self, theme: Theme, radius: f32, cx: &mut Context<Self>) {
        if self.theme.appearance != theme.appearance || self.radius != radius {
            self.theme = theme;
            self.radius = radius;
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
                            gpui::Corners::all(px(radius)),
                            buffer.clone(),
                        );
                        paints.fetch_add(1, Ordering::Relaxed);
                    },
                )
                .size_full(),
            );
        }

        #[cfg(target_os = "macos")]
        let showing_frame = self.latest_frame.is_some();
        #[cfg(not(target_os = "macos"))]
        let showing_frame = false;

        if !showing_frame {
            let message = self
                .camera_error
                .clone()
                .unwrap_or_else(|| "Loading camera...".into());
            container = container.child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(14.))
                    .text_color(theme.gray_11)
                    .child(message),
            );
        }

        container
    }
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

pub struct CameraWindow {
    theme: Theme,
    state: CameraWindowState,
    chrome_visible: bool,
    resizing: Option<ResizeDrag>,
    #[cfg(target_os = "macos")]
    converter: Option<frame::FrameConverter>,
    preview: Entity<CameraPreviewView>,
    toolbar: Entity<CameraToolbarView>,
    frame_dims: Option<(usize, usize)>,
    // Cadence instrumentation: proves the preview stays live (delivered) and
    // actually presents (painted) while the window is inactive.
    frames_in_window: u32,
    cadence_window_start: Instant,
    paints: Arc<AtomicU32>,
    paints_at_window_start: u32,
}

impl CameraWindow {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, false);
        let state = store::load().camera_window.unwrap_or_default();
        let paints = Arc::new(AtomicU32::new(0));
        let preview = cx.new({
            let paints = paints.clone();
            let radius = preview_radius(&state);
            move |cx| CameraPreviewView::new(theme, radius, paints, cx)
        });
        let camera = cx.entity();
        let toolbar = cx.new(|cx| CameraToolbarView::new(&camera, cx));
        Self {
            theme,
            state,
            chrome_visible: false,
            resizing: None,
            #[cfg(target_os = "macos")]
            converter: None,
            preview,
            toolbar,
            frame_dims: None,
            frames_in_window: 0,
            cadence_window_start: Instant::now(),
            paints,
            paints_at_window_start: 0,
        }
    }

    /// Called by the feed pump for every camera frame. Only the preview child
    /// is notified, so the cached toolbar chrome is reused; `refresh` is
    /// reserved for the first frame, where an inactive window may need the
    /// explicit ask (unit-2 finding).
    pub fn frame_arrived(
        &mut self,
        frame: cap_recording::NativeCameraFrame,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        #[cfg(target_os = "macos")]
        {
            use core_foundation::base::TCFType as _;
            use core_video::pixel_buffer::{CVPixelBuffer, CVPixelBufferRef};

            if let Some(buffer) = frame::FrameConverter::convert(&mut self.converter, &frame) {
                let first_frame = self.frame_dims.is_none();
                let dims = (buffer.width(), buffer.height());
                let dims_changed = self.frame_dims != Some(dims);
                self.frame_dims = Some(dims);
                let raw = buffer.as_ref() as *const cidre::cv::PixelBuf as CVPixelBufferRef;
                let buffer = unsafe { CVPixelBuffer::wrap_under_get_rule(raw) };
                self.preview
                    .update(cx, |preview, cx| preview.set_frame(buffer, dims, cx));
                if dims_changed {
                    self.apply_window_size(window);
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
            let _ = (frame, window);
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
        let theme = self.theme;
        let radius = preview_radius(&self.state);
        self.preview
            .update(cx, |preview, cx| preview.set_chrome(theme, radius, cx));
    }

    fn mutate_state(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        mutate: impl FnOnce(&mut CameraWindowState),
    ) {
        mutate(&mut self.state);
        self.state.size = clamp_size(self.state.size);
        self.apply_window_size(window);
        self.sync_preview_chrome(cx);
        self.persist(cx);
        cx.notify();
    }

    fn apply_window_size(&self, window: &mut Window) {
        let (width, height) = window_size(&self.state, self.frame_aspect());
        window.resize(size(px(width), px(height)));
    }

    fn persist(&self, cx: &mut Context<Self>) {
        let state = self.state;
        cx.background_executor()
            .spawn(async move {
                store::update(|persisted| persisted.camera_window = Some(state));
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
    // the same nine things.
    #[allow(clippy::too_many_arguments)]
    fn toolbar_button(
        &self,
        id: &'static str,
        icon: &'static str,
        pressed: bool,
        enabled: bool,
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
            .when(!enabled, |this| this.opacity(0.5))
            .when(enabled, |this| {
                this.hover(|style| style.bg(theme.gray_3))
                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                        window.prevent_default();
                    })
                    .on_click(cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        on_click(this, window, cx);
                    }))
            })
            .occlude()
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
                        true,
                        scale,
                        None,
                        cx,
                        |this, _, cx| this.close(cx),
                    ))
                    .child(self.toolbar_button(
                        "size",
                        "icons/enlarge.svg",
                        self.state.size >= CAMERA_PRESET_LARGE,
                        true,
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
                        true,
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
                    // Mirroring needs a horizontal flip on the painted surface;
                    // this gpui rev has no such transform. Present but disabled.
                    .child(self.toolbar_button(
                        "mirror",
                        "icons/arrows.svg",
                        false,
                        false,
                        scale,
                        None,
                        cx,
                        |_, _, _| {},
                    ))
                    .child(self.toolbar_button(
                        "blur",
                        "icons/person-standing.svg",
                        self.state.background_blur != BlurMode::Off,
                        true,
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

    fn render_resize_handles(&self, cx: &mut Context<Self>) -> impl IntoElement {
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
            let mut handle = div().id(id).absolute().size(px(16.)).occlude();
            handle = match corner {
                ResizeCorner::NorthWest => handle.top_0().left_0(),
                ResizeCorner::NorthEast => handle.top_0().right_0(),
                ResizeCorner::SouthWest => handle.bottom_0().left_0(),
                ResizeCorner::SouthEast => handle.bottom_0().right_0(),
            };
            layer = layer.child(handle.on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &gpui::MouseDownEvent, window, cx| {
                    window.prevent_default();
                    cx.stop_propagation();
                    this.resizing = Some(ResizeDrag {
                        corner,
                        start_size: this.state.size,
                        start_position: event.position,
                    });
                    cx.notify();
                }),
            ));
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
        let next = clamp_size(drag.start_size + delta);
        if (next - self.state.size).abs() > 0.5 {
            self.state.size = next;
            self.apply_window_size(window);
            self.sync_preview_chrome(cx);
            cx.notify();
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.theme.refresh(window, cx, false) {
            self.sync_preview_chrome(cx);
        }
        let resizing = self.resizing.is_some();

        div()
            .id("camera-root")
            .size_full()
            .flex()
            .flex_col()
            .font_family("Geist")
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if this.chrome_visible != *hovered {
                    this.chrome_visible = *hovered;
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, _| {
                    if this.resizing.is_none() {
                        window.start_window_move();
                    }
                }),
            )
            .when(resizing, |this| {
                this.on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                    this.handle_resize_move(event, window, cx);
                }))
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _: &MouseUpEvent, _, cx| this.end_resize(cx)),
                )
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
