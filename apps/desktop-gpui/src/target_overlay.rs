//! The fullscreen target-select overlays -- `target-select-overlay.tsx`,
//! natively.
//!
//! One transparent window per display, opened when a capture target mode is
//! armed in the main window. The overlays own the real "Start Recording" flow:
//! the display variant records the display it covers, the window variant the
//! window under the cursor, the area variant a crop drawn on top of the
//! desktop.
//!
//! Two pieces live here:
//!
//! * [`TargetSelect`], an app-scoped entity holding the armed mode and what is
//!   under the cursor. The Tauri app computes the same thing in a 50ms tokio
//!   loop and pushes it to every overlay webview as a `TargetUnderCursor`
//!   event (`src-tauri/src/target_select_overlay.rs`); here the loop runs on
//!   gpui's background executor and the overlays observe the entity.
//! * [`OverlayWindow`], the per-display view.
//!
//! Metrics are transcribed from the TSX with the Tailwind class quoted next to
//! them, the same convention `main_window.rs` uses.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, Context, Entity, FontWeight, Global, Hsla, ImageFormat,
    InteractiveElement as _, IntoElement, MouseButton, MouseMoveEvent, MouseUpEvent,
    ParentElement as _, Pixels, Point, Render, SharedString, StatefulInteractiveElement as _,
    Styled, Window, div, img, linear_color_stop, linear_gradient, prelude::FluentBuilder as _, px,
    rgb, svg,
};
use scap_targets::{
    DisplayId, WindowId,
    bounds::{LogicalBounds, LogicalPosition, LogicalSize},
};

use crate::{
    app_windows,
    main_window::{Mode, TargetType},
    theme::Theme,
};

/// How often the cursor probe runs. The Tauri loop sleeps 50ms between
/// `Display::get_containing_cursor` / `Window::get_topmost_at_cursor` reads;
/// this one is a touch lazier because each probe walks the whole window list
/// through `CGWindowListCopyWindowInfo` and the result only drives a
/// highlight rectangle.
const POLL_INTERVAL: Duration = Duration::from_millis(80);

/// `MIN_SIZE` in the TSX -- the smallest area selection that can be recorded.
const AREA_MIN_SIZE: f32 = 150.;

/// `MIN_SCREENSHOT_SIZE` in the TSX: a screenshot area only has to be a
/// pixel, not the 150px a recording needs.
const SCREENSHOT_MIN_SIZE: f32 = 1.;

fn area_min_size(mode: Mode) -> f32 {
    match mode {
        Mode::Screenshot => SCREENSHOT_MIN_SIZE,
        _ => AREA_MIN_SIZE,
    }
}

/// How close to an edge or corner counts as grabbing that handle. The TSX's
/// corner buttons are 30px boxes hung 12px outside the crop and its edge
/// buttons are 10px strips straddling the border; this is the same reach
/// expressed as a distance test, because the hit zones are computed in one
/// place here rather than being eight elements with their own listeners.
const AREA_HANDLE_GRAB: f32 = 12.;

/// `w-104` on the controls cluster, and the height its one card comes out at
/// (`p-3` + `h-11` + `p-3`, plus `my-2.5` above and below). The TSX measures
/// its own controls element with a ResizeObserver to place it against the
/// crop; gpui has no layout read-back, so the two numbers are constants.
const CLUSTER_WIDTH: f32 = 416.;
const CLUSTER_HEIGHT: f32 = 88.;

/// The window under the cursor, as the overlays need it.
#[derive(Clone, Debug, PartialEq)]
pub struct HoveredWindow {
    pub id: WindowId,
    pub app_name: String,
    pub display_id: DisplayId,
    /// Bounds relative to the display's top-left, in logical points -- exactly
    /// what the overlay window's own coordinate space is. Carried as our own
    /// rect rather than `LogicalBounds` so the poll can compare frames for
    /// equality (`scap_targets`' bounds are not `PartialEq`).
    pub bounds: AreaRect,
}

impl HoveredWindow {
    pub fn from_window(window: &scap_targets::Window) -> Option<Self> {
        let bounds = window.display_relative_logical_bounds()?;
        Some(Self {
            id: window.id(),
            app_name: window.owner_name()?,
            display_id: window.display()?.id(),
            bounds: AreaRect {
                x: bounds.position().x() as f32,
                y: bounds.position().y() as f32,
                width: bounds.size().width() as f32,
                height: bounds.size().height() as f32,
            },
        })
    }
}

/// App-scoped target-select state: which mode is armed, what the cursor is
/// over, and which window a click has locked onto.
pub struct TargetSelect {
    /// `None` when no overlays are up.
    pub mode: Option<TargetType>,
    /// The recording mode the start cluster labels itself with.
    pub recording_mode: Mode,
    pub cursor_display: Option<DisplayId>,
    pub hovered_window: Option<HoveredWindow>,
    /// A window locked in by a click (or seeded from the main window's picker),
    /// which the highlight sticks to until another window is clicked.
    pub pinned_window: Option<HoveredWindow>,
    /// App icons by window id, fetched once per window.
    icons: HashMap<String, Arc<gpui::Image>>,
    _poll: Option<gpui::Task<()>>,
}

struct TargetSelectGlobal(Entity<TargetSelect>);
impl Global for TargetSelectGlobal {}

impl TargetSelect {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let select = cx.new(|_| Self {
            mode: None,
            recording_mode: Mode::Instant,
            cursor_display: None,
            hovered_window: None,
            pinned_window: None,
            icons: HashMap::new(),
            _poll: None,
        });
        cx.set_global(TargetSelectGlobal(select.clone()));
        select
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<TargetSelectGlobal>().0.clone()
    }

    /// Arm (or disarm) a target mode. Starts and stops the cursor probe.
    pub fn arm(
        &mut self,
        mode: Option<TargetType>,
        recording_mode: Mode,
        pinned_window: Option<HoveredWindow>,
        cx: &mut Context<Self>,
    ) {
        self.recording_mode = recording_mode;
        self.pinned_window = pinned_window;
        if self.mode == mode {
            cx.notify();
            return;
        }
        self.mode = mode;
        self.hovered_window = None;
        if mode.is_some() {
            self.start_polling(cx);
        } else {
            self._poll = None;
            self.cursor_display = None;
        }
        cx.notify();
    }

    pub fn set_recording_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if self.recording_mode != mode {
            self.recording_mode = mode;
            cx.notify();
        }
    }

    /// The window the window-variant overlay should highlight: a locked
    /// selection wins over what the cursor is currently over, matching
    /// `activeWindow = selectedWindow() ?? targetUnderCursor.window`.
    pub fn active_window(&self) -> Option<&HoveredWindow> {
        self.pinned_window.as_ref().or(self.hovered_window.as_ref())
    }

    pub fn icon_for(&self, id: &WindowId) -> Option<Arc<gpui::Image>> {
        self.icons.get(&id.to_string()).cloned()
    }

    /// Lock the highlight onto whatever the cursor is over -- the TSX's
    /// click-anywhere-to-select behavior.
    fn pin_hovered(&mut self, cx: &mut Context<Self>) {
        if let Some(hovered) = self.hovered_window.clone()
            && self.pinned_window.as_ref().map(|window| &window.id) != Some(&hovered.id)
        {
            self.pinned_window = Some(hovered);
            cx.notify();
        }
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        self._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                // Only the window variant needs the (much more expensive)
                // window probe; the others just want to know which display the
                // cursor is on.
                let Ok(want_window) =
                    this.read_with(cx, |this, _| this.mode == Some(TargetType::Window))
                else {
                    return;
                };

                let probe = cx
                    .background_executor()
                    .spawn(async move {
                        let display = scap_targets::Display::get_containing_cursor()
                            .map(|display| display.id());
                        let window = want_window
                            .then(scap_targets::Window::get_topmost_at_cursor)
                            .flatten()
                            .as_ref()
                            .and_then(HoveredWindow::from_window);
                        (display, window)
                    })
                    .await;

                let Ok(icon_wanted) = this.update(cx, |this: &mut Self, cx| {
                    let (display, window) = probe;
                    let changed = this.cursor_display != display || this.hovered_window != window;
                    this.cursor_display = display;
                    this.hovered_window = window;
                    if changed {
                        cx.notify();
                    }

                    this.active_window()
                        .map(|window| window.id.clone())
                        .filter(|id| !this.icons.contains_key(&id.to_string()))
                }) else {
                    return;
                };
                if let Some(id) = icon_wanted {
                    Self::fetch_icon(id, &this, cx).await;
                }

                // Repaint the overlays explicitly: none of them is the active
                // window while the user hovers another app, and an inactive
                // window only repaints when asked (the unit-2 finding).
                cx.update(app_windows::refresh_target_overlays);
                cx.background_executor().timer(POLL_INTERVAL).await;
            }
        }));
    }

    /// The hovered window's app icon, the way `get_window_icon` fetches it:
    /// `Window::app_icon()` PNG bytes, decoded by gpui's image path (`img`,
    /// not `svg` -- an app icon is full colour).
    async fn fetch_icon(id: WindowId, this: &gpui::WeakEntity<Self>, cx: &mut gpui::AsyncApp) {
        let key = id.to_string();
        let lookup = id.clone();
        let bytes = cx
            .background_executor()
            .spawn(async move {
                scap_targets::Window::from_id(&lookup).and_then(|window| window.app_icon())
            })
            .await;
        let Some(bytes) = bytes else { return };
        let image = Arc::new(gpui::Image::from_bytes(ImageFormat::Png, bytes));
        this.update(cx, |this, cx| {
            this.icons.insert(key, image);
            cx.notify();
        })
        .ok();
    }
}

/// A rectangle in the overlay's own coordinate space: display-relative logical
/// points, which is also what `ScreenCaptureTarget::Area` wants.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AreaRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl AreaRect {
    fn right(&self) -> f32 {
        self.x + self.width
    }

    fn bottom(&self) -> f32 {
        self.y + self.height
    }

    fn is_valid_for(&self, min: f32) -> bool {
        self.width >= min && self.height >= min
    }

    fn clamped(self, display: (f32, f32)) -> Self {
        let width = self.width.min(display.0);
        let height = self.height.min(display.1);
        Self {
            x: self.x.clamp(0., (display.0 - width).max(0.)),
            y: self.y.clamp(0., (display.1 - height).max(0.)),
            width,
            height,
        }
    }

    /// `x,y,width,height` -- the `CAP_GPUI_AUTO_AREA` harness format.
    pub fn parse(spec: &str) -> Option<Self> {
        let values: Vec<f32> = spec
            .split(',')
            .map(|part| part.trim().parse().ok())
            .collect::<Option<Vec<f32>>>()?;
        let [x, y, width, height] = values[..] else {
            return None;
        };
        Some(Self {
            x,
            y,
            width,
            height,
        })
    }

    fn to_bounds(self) -> LogicalBounds {
        LogicalBounds::new(
            LogicalPosition::new(self.x as f64, self.y as f64),
            LogicalSize::new(self.width as f64, self.height as f64),
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AreaHandle {
    North,
    South,
    East,
    West,
    NorthWest,
    NorthEast,
    SouthWest,
    SouthEast,
}

impl AreaHandle {
    const ALL: [Self; 8] = [
        Self::NorthWest,
        Self::North,
        Self::NorthEast,
        Self::East,
        Self::SouthEast,
        Self::South,
        Self::SouthWest,
        Self::West,
    ];

    fn north(self) -> bool {
        matches!(self, Self::North | Self::NorthWest | Self::NorthEast)
    }

    fn south(self) -> bool {
        matches!(self, Self::South | Self::SouthWest | Self::SouthEast)
    }

    fn west(self) -> bool {
        matches!(self, Self::West | Self::NorthWest | Self::SouthWest)
    }

    fn east(self) -> bool {
        matches!(self, Self::East | Self::NorthEast | Self::SouthEast)
    }

    fn is_corner(self) -> bool {
        matches!(
            self,
            Self::NorthWest | Self::NorthEast | Self::SouthWest | Self::SouthEast
        )
    }

    fn cursor(self) -> gpui::CursorStyle {
        use gpui::CursorStyle::*;
        match self {
            Self::North | Self::South => ResizeUpDown,
            Self::East | Self::West => ResizeLeftRight,
            Self::NorthWest | Self::SouthEast => ResizeUpLeftDownRight,
            Self::NorthEast | Self::SouthWest => ResizeUpRightDownLeft,
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::North => "handle-n",
            Self::South => "handle-s",
            Self::East => "handle-e",
            Self::West => "handle-w",
            Self::NorthWest => "handle-nw",
            Self::NorthEast => "handle-ne",
            Self::SouthWest => "handle-sw",
            Self::SouthEast => "handle-se",
        }
    }
}

enum AreaDrag {
    /// Drawing a fresh selection from an anchor point.
    Draw {
        anchor: (f32, f32),
    },
    /// Dragging the whole selection.
    Move {
        grab: (f32, f32),
        start: AreaRect,
    },
    Resize {
        handle: AreaHandle,
        start: AreaRect,
    },
}

/// One display's overlay.
pub struct OverlayWindow {
    theme: Theme,
    select: Entity<TargetSelect>,
    display_id: DisplayId,
    display_name: String,
    /// Logical size, which is this window's size and the space every
    /// coordinate here lives in.
    display_size: (f32, f32),
    /// Physical pixels, for the `1920x1080 · 60FPS` line.
    physical_size: Option<(u32, u32)>,
    refresh_rate: f64,
    focus: gpui::FocusHandle,
    crop: Option<AreaRect>,
    drag: Option<AreaDrag>,
}

impl OverlayWindow {
    pub fn new(
        display: &scap_targets::Display,
        select: Entity<TargetSelect>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, false);
        cx.observe(&select, |_, _, cx| cx.notify()).detach();

        let logical = display
            .logical_size()
            .map(|size| (size.width() as f32, size.height() as f32))
            .unwrap_or((1920., 1080.));

        Self {
            theme,
            select,
            display_id: display.id(),
            display_name: display
                .name()
                .unwrap_or_else(|| format!("Display {}", display.id())),
            display_size: logical,
            physical_size: display
                .physical_size()
                .map(|size| (size.width() as u32, size.height() as u32)),
            refresh_rate: display.refresh_rate(),
            focus: cx.focus_handle(),
            crop: None,
            drag: None,
        }
    }

    pub fn focus_handle(&self) -> gpui::FocusHandle {
        self.focus.clone()
    }

    /// Seed an area selection without drawing one -- the harness path
    /// (`CAP_GPUI_AUTO_AREA`), since unprivileged synthetic drags are dropped.
    pub fn set_crop(&mut self, crop: AreaRect, cx: &mut Context<Self>) {
        self.crop = Some(crop.clamped(self.display_size));
        cx.notify();
    }

    /// The target this overlay would record, or `None` when it has nothing to
    /// record yet (no window under the cursor, no valid area drawn).
    pub fn target(&self, cx: &App) -> Option<ScreenCaptureTarget> {
        let select = self.select.read(cx);
        let min = area_min_size(select.recording_mode);
        match select.mode? {
            TargetType::Display => Some(ScreenCaptureTarget::Display {
                id: self.display_id.clone(),
            }),
            TargetType::Window => {
                select
                    .active_window()
                    .map(|window| ScreenCaptureTarget::Window {
                        id: window.id.clone(),
                    })
            }
            TargetType::Area => self.crop.filter(|crop| crop.is_valid_for(min)).map(|crop| {
                ScreenCaptureTarget::Area {
                    screen: self.display_id.clone(),
                    bounds: crop.to_bounds(),
                }
            }),
            TargetType::CameraOnly => Some(ScreenCaptureTarget::CameraOnly),
        }
    }

    /// The overlay's Start button: close every overlay, then hand the target to
    /// the main window's start path (which opens the bar, hides the main
    /// window and starts the engine).
    pub fn start_recording(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.target(cx) else {
            return;
        };
        tracing::info!(target = ?target.kind_str(), "overlay start pressed");
        if self.select.read(cx).recording_mode == Mode::Screenshot {
            // Screenshots never reach the recording actors: the target goes
            // straight to the capture path, which closes these overlays
            // itself (`startRecording`'s screenshot branch,
            // `target-select-overlay.tsx:1995`).
            cx.defer(move |cx: &mut App| crate::screenshot::take_screenshot(target, cx));
            return;
        }
        // Deferred: this runs inside the overlay's own window update and the
        // orchestrator closes that very window.
        cx.defer(move |cx: &mut App| app_windows::start_recording_from_overlay(target, cx));
    }

    fn dismiss(&mut self, cx: &mut Context<Self>) {
        cx.defer(app_windows::dismiss_target_overlays);
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        self.theme.refresh(window, cx, false);
    }

    /// True when the cursor is on this overlay's display -- `data-over` in the
    /// display variant, `isActiveDisplay` in the area variant.
    fn is_active_display(&self, cx: &App) -> bool {
        self.select.read(cx).cursor_display.as_ref() == Some(&self.display_id)
    }
}

impl Render for OverlayWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let mode = self.select.read(cx).mode;

        let root = div()
            .id("overlay-root")
            .track_focus(&self.focus)
            .key_context("TargetSelectOverlay")
            .on_key_down(
                cx.listener(|this, event: &gpui::KeyDownEvent, _window, cx| {
                    // The Tauri app registers Escape as a *global* shortcut while
                    // the overlays are up; here it is a plain key handler on the
                    // overlay that has focus (see the README deviation).
                    tracing::debug!(key = %event.keystroke.key, "overlay key");
                    if event.keystroke.key.as_str() == "escape" {
                        this.dismiss(cx);
                    }
                }),
            )
            .size_full()
            .relative()
            .font_family("Geist")
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white());

        match mode {
            Some(TargetType::Display) => root
                .child(self.render_display_variant(cx))
                .into_any_element(),
            Some(TargetType::Window) => root
                .child(self.render_window_variant(cx))
                .into_any_element(),
            Some(TargetType::Area) => root.child(self.render_area_variant(cx)).into_any_element(),
            Some(TargetType::CameraOnly) => root
                .child(self.render_camera_variant(cx))
                .into_any_element(),
            None => root.into_any_element(),
        }
    }
}

impl OverlayWindow {
    /// `data-[over='true']:bg-blue-600/40` over `bg-black/60`, centered
    /// monitor art, name, resolution.
    fn render_display_variant(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let over = self.is_active_display(cx);
        let resolution = self.physical_size.map(|(width, height)| {
            // `${size().width}x${size().height} · ${display.refresh_rate}FPS`
            format!("{width}x{height} · {}FPS", self.refresh_rate)
        });

        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            // `<div class="absolute inset-0 bg-black/60 -z-10" />`, then the
            // root's own `bg-blue-600/40` on top of it when hovered.
            .child(div().absolute().inset_0().bg(gpui::hsla(0., 0., 0., 0.6)))
            .when(over, |this| {
                this.child(
                    div()
                        .absolute()
                        .inset_0()
                        .bg(Theme::with_alpha(rgb(Theme::TARGET_HIGHLIGHT), 0.4)),
                )
            })
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .items_center()
                    // `IconCapMonitor class="size-20 mb-3"`: the art is a
                    // full-colour gradient, so it goes through `img()` (an
                    // `svg()` would flatten it to a silhouette), and its
                    // 125x84 viewBox keeps its aspect inside the 80px box.
                    .child(
                        img("icons/monitor.svg")
                            .w(px(80.))
                            .h(px(80. * 84. / 125.))
                            .mb(px(12.)),
                    )
                    .child(
                        div()
                            .mb(px(8.))
                            .text_size(px(30.))
                            // `text-3xl font-semibold`
                            // (`target-select-overlay.tsx:426`). `font-semibold`
                            // renders 700: no 600 face is loaded over there
                            // (`ui-solid/vite.js:31-33` ships 400/500/700 only).
                            .font_weight(FontWeight::BOLD)
                            .child(SharedString::from(self.display_name.clone())),
                    )
                    .children(
                        resolution.map(|resolution| {
                            div().mb(px(8.)).text_size(px(12.)).child(resolution)
                        }),
                    )
                    .child(self.render_controls_cluster(self.target(cx), false, cx)),
            )
    }

    /// `bg-black/70` everywhere, `bg-blue-600/40` over the hovered window's
    /// rectangle with the app's icon, name and size stacked in it.
    ///
    /// Like the TSX, the whole variant only draws on the display the cursor is
    /// on -- the other overlays stay empty and transparent.
    fn render_window_variant(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let select = self.select.read(cx);
        let active = select
            .active_window()
            .filter(|window| window.display_id == self.display_id)
            .cloned();
        let icon = active
            .as_ref()
            .and_then(|window| select.icon_for(&window.id));

        let Some(active) = active else {
            return div().size_full().into_any_element();
        };
        let bounds = active.bounds;
        let width = bounds.width;
        let height = bounds.height;

        div()
            .size_full()
            .relative()
            .bg(gpui::hsla(0., 0., 0., 0.7))
            .id("window-variant")
            // Clicking anywhere locks the highlight onto whatever is under the
            // cursor, exactly as the TSX's two click handlers add up to.
            .on_click(cx.listener(|this, _, _window, cx| {
                this.select.update(cx, |select, cx| select.pin_hovered(cx));
            }))
            .child(
                div()
                    .absolute()
                    .left(px(bounds.x))
                    .top(px(bounds.y))
                    .w(px(width))
                    .h(px(height))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .items_center()
                    .bg(Theme::with_alpha(rgb(Theme::TARGET_HIGHLIGHT), 0.4))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .justify_center()
                            .items_center()
                            // `<div class="w-24 h-24">` around the icon.
                            .children(
                                icon.map(|icon| {
                                    img(icon).size(px(96.)).mb(px(12.)).rounded(px(8.))
                                }),
                            )
                            .child(
                                div()
                                    .mb(px(8.))
                                    .text_size(px(30.))
                                    // `text-3xl font-semibold`
                                    // (`target-select-overlay.tsx:681`):
                                    // renders 700, no 600 face loaded.
                                    .font_weight(FontWeight::BOLD)
                                    .child(SharedString::from(active.app_name.clone())),
                            )
                            .child(
                                div()
                                    .mb(px(8.))
                                    .text_size(px(12.))
                                    .child(format!("{}x{}", width as u32, height as u32)),
                            ),
                    )
                    .child(self.render_controls_cluster(self.target(cx), false, cx)),
            )
            .into_any_element()
    }

    /// The camera-only variant: no capture target to pick, just the start
    /// cluster over a dim screen. The TSX also inlines a camera preview here;
    /// ours keeps the preview bubble window it already has (README deviation).
    fn render_camera_variant(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            // `bg-black/70` with a second `bg-black/60` layer behind it.
            .bg(gpui::hsla(0., 0., 0., 0.7))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .mb(px(16.))
                    .child(
                        div()
                            .mb(px(8.))
                            .text_size(px(30.))
                            // `text-3xl font-semibold`
                            // (`target-select-overlay.tsx:392`): renders 700,
                            // no 600 face loaded.
                            .font_weight(FontWeight::BOLD)
                            .child("Camera Only"),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(self.theme.gray_11)
                            .child("Record using only your camera and microphone"),
                    ),
            )
            .child(self.render_controls_cluster(self.target(cx), false, cx))
    }

    /// The crop overlay: `bg-black/45` outside the selection, a `border-white/50`
    /// region with eight handles, a size readout on top and the start cluster
    /// placed against the crop.
    fn render_area_variant(&self, cx: &mut Context<Self>) -> gpui::Stateful<gpui::Div> {
        let interacting = self.drag.is_some();
        // `shouldShowOverlay = isInteracting() || isActiveDisplay()`.
        let visible = interacting || self.is_active_display(cx);
        let crop = self.crop;
        let min = area_min_size(self.select.read(cx).recording_mode);
        let valid = crop.is_some_and(|crop| crop.is_valid_for(min));

        let mut root = div()
            .id("area-root")
            .size_full()
            .relative()
            .cursor(gpui::CursorStyle::Crosshair)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                    this.area_mouse_down(event.position, cx);
                }),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, _window, cx| {
                this.area_mouse_move(event.position, cx);
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _: &MouseUpEvent, _window, cx| {
                    this.area_mouse_up(cx);
                }),
            );

        if !visible {
            // `classList={{ "opacity-0 pointer-events-none": !shouldShowOverlay() }}`
            return root.invisible();
        }

        // The occluder: four `bg-black/45` rectangles around the crop (one
        // full-screen rectangle while nothing is drawn).
        let dim: Hsla = gpui::hsla(0., 0., 0., 0.45);
        root = match crop {
            None => root.child(div().absolute().inset_0().bg(dim)),
            Some(crop) => root
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .h_full()
                        .w(px(crop.x.max(0.)))
                        .bg(dim),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .right_0()
                        .h_full()
                        .w(px((self.display_size.0 - crop.right()).max(0.)))
                        .bg(dim),
                )
                .child(
                    div()
                        .absolute()
                        .top_0()
                        .left(px(crop.x))
                        .w(px(crop.width))
                        .h(px(crop.y.max(0.)))
                        .bg(dim),
                )
                .child(
                    div()
                        .absolute()
                        .bottom_0()
                        .left(px(crop.x))
                        .w(px(crop.width))
                        .h(px((self.display_size.1 - crop.bottom()).max(0.)))
                        .bg(dim),
                ),
        };

        if let Some(crop) = crop {
            root = root.child(self.render_crop_region(crop));
        }

        root.child(self.render_area_toolbar(crop, valid))
            .child(self.render_area_controls(crop, valid, cx))
    }

    /// `border border-white/50` around the selection, plus the eight resize
    /// zones. The zones carry only a cursor: the drag itself is dispatched from
    /// the root's mouse-down through [`Self::area_zone_at`], so a grab that
    /// starts a pixel outside the handle still resizes.
    fn render_crop_region(&self, crop: AreaRect) -> impl IntoElement {
        let mut region = div()
            .absolute()
            .left(px(crop.x))
            .top(px(crop.y))
            .w(px(crop.width))
            .h(px(crop.height))
            .border_1()
            .border_color(gpui::hsla(0., 0., 1., 0.5))
            .cursor(gpui::CursorStyle::OpenHand);

        for handle in AreaHandle::ALL {
            let mut zone = div().id(handle.id()).absolute().cursor(handle.cursor());
            let reach = px(AREA_HANDLE_GRAB * 2.);

            zone = if handle.is_corner() {
                let zone = zone.size(reach);
                let zone = if handle.west() {
                    zone.left(px(-AREA_HANDLE_GRAB))
                } else {
                    zone.right(px(-AREA_HANDLE_GRAB))
                };
                if handle.north() {
                    zone.top(px(-AREA_HANDLE_GRAB))
                } else {
                    zone.bottom(px(-AREA_HANDLE_GRAB))
                }
            } else if handle.north() || handle.south() {
                let zone = zone
                    .left(px(AREA_HANDLE_GRAB))
                    .right(px(AREA_HANDLE_GRAB))
                    .h(reach);
                if handle.north() {
                    zone.top(px(-AREA_HANDLE_GRAB))
                } else {
                    zone.bottom(px(-AREA_HANDLE_GRAB))
                }
            } else {
                let zone = zone
                    .top(px(AREA_HANDLE_GRAB))
                    .bottom(px(AREA_HANDLE_GRAB))
                    .w(reach);
                if handle.west() {
                    zone.left(px(-AREA_HANDLE_GRAB))
                } else {
                    zone.right(px(-AREA_HANDLE_GRAB))
                }
            };

            // The corner glyph: the TSX draws an `M0 0 H12 M0 0 V12` stroke in
            // white at `stroke-width 4`. gpui's `div` has no paths, so the same
            // L is two 4px bars.
            if handle.is_corner() {
                let bar = |width: f32, height: f32| {
                    div()
                        .absolute()
                        .w(px(width))
                        .h(px(height))
                        .bg(gpui::white())
                };
                let arm = 18.;
                let thickness = 4.;
                let mut horizontal = bar(arm, thickness);
                let mut vertical = bar(thickness, arm);
                horizontal = if handle.west() {
                    horizontal.left(px(AREA_HANDLE_GRAB))
                } else {
                    horizontal.right(px(AREA_HANDLE_GRAB))
                };
                vertical = if handle.west() {
                    vertical.left(px(AREA_HANDLE_GRAB))
                } else {
                    vertical.right(px(AREA_HANDLE_GRAB))
                };
                horizontal = if handle.north() {
                    horizontal.top(px(AREA_HANDLE_GRAB))
                } else {
                    horizontal.bottom(px(AREA_HANDLE_GRAB))
                };
                vertical = if handle.north() {
                    vertical.top(px(AREA_HANDLE_GRAB))
                } else {
                    vertical.bottom(px(AREA_HANDLE_GRAB))
                };
                zone = zone.child(horizontal).child(vertical);
            }

            region = region.child(zone);
        }

        region
    }

    /// The floating readout: `top-12 left-1/2 -translate-x-1/2` over the
    /// liquid-glass surface, `min-w-28 px-2 text-base tabular-nums`. The
    /// aspect-ratio, reset, fill and lock controls that share this bar in the
    /// TSX are deferred (README).
    fn render_area_toolbar(&self, crop: Option<AreaRect>, valid: bool) -> impl IntoElement {
        let label = match crop.filter(|_| valid) {
            Some(crop) => format!("{} × {}", crop.width.round(), crop.height.round()),
            None => "Draw an area".to_string(),
        };

        div()
            .absolute()
            // `top-12` on macOS, centred by hand: gpui has no translate.
            .top(px(48.))
            .left(px((self.display_size.0 - 200.) / 2.))
            .w(px(200.))
            .flex()
            .justify_center()
            .child(
                self.glass_surface()
                    .h(px(48.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .p(px(6.))
                    .text_color(self.theme.gray_12)
                    .child(
                        div()
                            .min_w(px(112.))
                            .px(px(8.))
                            .text_size(px(16.))
                            // `text-base font-normal`
                            // (`target-select-overlay.tsx:1330`): an explicit
                            // `font-normal` that opts *out* of the `body`
                            // Medium default, so it must be stated here now
                            // that the window root carries Medium.
                            .font_weight(FontWeight::NORMAL)
                            .child(label),
                    ),
            )
    }

    /// The controls cluster, placed against the crop the way `controlsStyle`
    /// places it: below when it fits, above when it does not, inside the crop
    /// otherwise.
    fn render_area_controls(
        &self,
        crop: Option<AreaRect>,
        valid: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        const SIDE_MARGIN: f32 = 16.;
        const MARGIN_BELOW: f32 = 16.;
        const MARGIN_TOP_OUTSIDE: f32 = 16.;
        // `macos ? 40 : 28` / `macos ? 40 : 10`.
        const MARGIN_TOP_INSIDE: f32 = 40.;
        const TOP_SAFE_MARGIN: f32 = 40.;

        let crop = crop.unwrap_or(AreaRect {
            x: 0.,
            y: 0.,
            width: 0.,
            height: 0.,
        });
        let (screen_width, screen_height) = self.display_size;

        let below = crop.bottom() + MARGIN_BELOW;
        let y = if below + CLUSTER_HEIGHT <= screen_height {
            below
        } else {
            let above = crop.y - CLUSTER_HEIGHT - MARGIN_TOP_OUTSIDE;
            if above >= TOP_SAFE_MARGIN {
                above
            } else {
                crop.y + MARGIN_TOP_INSIDE
            }
        };
        let x = (crop.x + crop.width / 2. - CLUSTER_WIDTH / 2.).clamp(
            SIDE_MARGIN,
            (screen_width - CLUSTER_WIDTH - SIDE_MARGIN).max(SIDE_MARGIN),
        );

        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(CLUSTER_WIDTH))
            .flex()
            .flex_col()
            .items_center()
            .child(self.render_controls_cluster(self.target(cx), !valid, cx))
            .when(!valid, |this| {
                // `Minimum size is 150 x 150` / `W x H is too small`.
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .items_center()
                        .p(px(10.))
                        .my(px(8.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(self.theme.red_4)
                        .bg(self.theme.red_2)
                        .text_size(px(14.))
                        .text_color(self.theme.gray_12)
                        .child(format!(
                            "Minimum size is {} x {}",
                            AREA_MIN_SIZE as u32, AREA_MIN_SIZE as u32
                        ))
                        .child(div().text_size(px(11.)).child(format!(
                            "{} x {} is too small",
                            crop.width.round(),
                            crop.height.round()
                        ))),
                )
            })
    }

    /// `LIQUID_GLASS_SURFACE_CLASS`: `rounded-2xl border border-gray-12/10
    /// bg-gray-1/82 shadow-xl shadow-black/20 dark:border-white/10
    /// dark:bg-gray-2/82`. The `backdrop-blur-xl` is dropped -- this gpui rev
    /// has no per-element backdrop blur (same gap the recording overlay has).
    fn glass_surface(&self) -> gpui::Div {
        let theme = self.theme;
        div()
            .rounded(px(16.))
            .border_1()
            .border_color(if theme.is_dark() {
                gpui::hsla(0., 0., 1., 0.1)
            } else {
                Theme::with_alpha(theme.gray_12, 0.1)
            })
            .bg(if theme.is_dark() {
                Theme::with_alpha(theme.gray_2, 0.82)
            } else {
                Theme::with_alpha(theme.gray_1, 0.82)
            })
            .shadow(vec![gpui::BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.2),
                offset: gpui::point(px(0.), px(8.)),
                blur_radius: px(10.),
                spread_radius: px(-6.),
                inset: false,
            }])
    }

    /// `RecordingControls`: the close button, the gradient start pill with its
    /// mode line and caret, and the pre-recording settings button.
    ///
    /// The device row (a second glass card with camera and microphone selects)
    /// and the "What is X Mode?" link below it are deferred -- the device
    /// pickers live in the main window here (README).
    fn render_controls_cluster(
        &self,
        target: Option<ScreenCaptureTarget>,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let mode = self.select.read(cx).recording_mode;
        let disabled = disabled || target.is_none();

        // `flex flex-col gap-2.5 items-stretch my-2.5 w-104`.
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .items_stretch()
            .my(px(10.))
            .w(px(CLUSTER_WIDTH))
            // The cluster sits on top of the area overlay's drawing surface;
            // without this a click on Start would also start a new crop.
            .occlude()
            .child(
                self.glass_surface().p(px(12.)).child(
                    div()
                        .flex()
                        .flex_row()
                        .gap(px(10.))
                        .items_center()
                        .child(self.render_close_button(cx))
                        .child(self.render_start_button(target, disabled, mode, cx))
                        .child(
                            // `size-9 rounded-full border bg-gray-6 text-gray-12`.
                            // Inert: the countdown menu it opens needs the
                            // settings store (same gap as the bar's settings
                            // button).
                            div()
                                .flex()
                                .justify_center()
                                .items_center()
                                .size(px(36.))
                                .flex_shrink_0()
                                .rounded_full()
                                .border_1()
                                .border_color(theme.gray_5)
                                .bg(theme.gray_6)
                                .child(
                                    svg()
                                        .path("icons/gear.svg")
                                        .size(px(20.))
                                        .text_color(theme.gray_12),
                                ),
                        ),
                ),
            )
    }

    /// `size-9 rounded-full bg-gray-12` with the inverted X glyph.
    fn render_close_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        div()
            .id("overlay-close")
            .flex()
            .justify_center()
            .items_center()
            .size(px(36.))
            .flex_shrink_0()
            .rounded_full()
            .bg(theme.gray_12)
            .hover(|style| style.opacity(0.8))
            .child(
                svg()
                    .path("icons/x.svg")
                    // `invert dark:invert-0` on a black glyph: white on the
                    // light theme's dark circle, black on the dark theme's
                    // light one.
                    .size(px(12.))
                    .text_color(theme.gray_1),
            )
            .on_click(cx.listener(|this, _, _window, cx| {
                cx.stop_propagation();
                this.dismiss(cx);
            }))
    }

    /// The start affordance: `h-11 rounded-full bg-linear-to-r from-blue-10 to
    /// blue-11` (`blue-9`/`blue-10` in the dark theme), mode icon, two-line
    /// label, and the mode caret on a divided trailing block.
    fn render_start_button(
        &self,
        target: Option<ScreenCaptureTarget>,
        disabled: bool,
        mode: Mode,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let (from, to) = if theme.is_dark() {
            (theme.blue_9, theme.blue_10)
        } else {
            (theme.blue_10, theme.blue_11)
        };
        let label = match mode {
            Mode::Screenshot => "Take Screenshot",
            _ => "Start Recording",
        };
        let icon = match mode {
            Mode::Instant => "icons/instant.svg",
            Mode::Studio => "icons/film-cut.svg",
            Mode::Screenshot => "icons/camera.svg",
        };
        let mode_label = match mode {
            Mode::Instant => "Instant Mode",
            Mode::Studio => "Studio Mode",
            Mode::Screenshot => "Screenshot Mode",
        };
        let _ = target;

        div()
            .id("overlay-start")
            .flex()
            .flex_1()
            .min_w_0()
            .max_w(px(288.))
            .overflow_hidden()
            .flex_row()
            .h(px(44.))
            .rounded_full()
            .text_color(gpui::white())
            // `bg-linear-to-r from-blue-10 via-blue-10 to-blue-11`: the via
            // stop sits at 50% with the from colour, so the ramp only starts
            // halfway.
            .bg(linear_gradient(
                90.,
                linear_color_stop(Hsla::from(from), 0.5),
                linear_color_stop(Hsla::from(to), 1.0),
            ))
            .child(
                div()
                    .flex()
                    .flex_1()
                    .items_center()
                    .py(px(4.))
                    .pl(px(16.))
                    .min_w_0()
                    // `opacity-60 cursor-not-allowed hover:bg-transparent`.
                    .when(disabled, |this| this.opacity(0.6))
                    .when(!disabled, |this| {
                        this.hover(|style| style.bg(gpui::hsla(0., 0., 1., 0.1)))
                    })
                    .child(
                        svg()
                            .path(icon)
                            .size(px(16.))
                            .flex_shrink_0()
                            .text_color(gpui::white()),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .ml(px(12.))
                            .mr(px(8.))
                            .min_w_0()
                            .child(
                                div()
                                    // `text-[0.95rem] font-medium`.
                                    .text_size(px(15.2))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(label),
                            )
                            .child(
                                div()
                                    .mt(px(-2.))
                                    .text_size(px(11.))
                                    // `text-[11px] ... text-white/90
                                    //  font-light` (`t-s-overlay.tsx:2200`).
                                    // `font-light` is 300 and no 300 face is
                                    // loaded (`ui-solid/vite.js:31-33` ships
                                    // 400/500/700), so CSS font-matching
                                    // resolves it to 400 -- Regular, not Light
                                    // -- and it must opt out of the `body`
                                    // Medium default explicitly.
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(gpui::hsla(0., 0., 1., 0.9))
                                    .child(mode_label),
                            ),
                    ),
            )
            .child(
                // `pl-2.5 pr-3 py-1.5 border-l border-white/20 bg-white/5`.
                // The mode menu it drops down is deferred (README).
                div()
                    .flex()
                    .items_center()
                    .pl(px(10.))
                    .pr(px(12.))
                    .py(px(6.))
                    .border_l_1()
                    .border_color(gpui::hsla(0., 0., 1., 0.2))
                    .bg(gpui::hsla(0., 0., 1., 0.05))
                    .child(
                        svg()
                            .path("icons/caret-down.svg")
                            .w(px(10.))
                            .h(px(6.))
                            .text_color(gpui::white()),
                    ),
            )
            .when(!disabled, |this| {
                this.on_click(cx.listener(|this, _, window, cx| {
                    cx.stop_propagation();
                    this.start_recording(window, cx);
                }))
            })
    }
}

/// Area interaction: which part of the selection a point grabs.
enum AreaZone {
    Handle(AreaHandle),
    Inside,
}

impl OverlayWindow {
    fn area_zone_at(&self, point: (f32, f32)) -> Option<AreaZone> {
        let crop = self.crop?;
        let (x, y) = point;
        let near_left = (x - crop.x).abs() <= AREA_HANDLE_GRAB;
        let near_right = (x - crop.right()).abs() <= AREA_HANDLE_GRAB;
        let near_top = (y - crop.y).abs() <= AREA_HANDLE_GRAB;
        let near_bottom = (y - crop.bottom()).abs() <= AREA_HANDLE_GRAB;
        let within_x = x >= crop.x - AREA_HANDLE_GRAB && x <= crop.right() + AREA_HANDLE_GRAB;
        let within_y = y >= crop.y - AREA_HANDLE_GRAB && y <= crop.bottom() + AREA_HANDLE_GRAB;

        let handle = match (near_left, near_right, near_top, near_bottom) {
            (true, _, true, _) => Some(AreaHandle::NorthWest),
            (_, true, true, _) => Some(AreaHandle::NorthEast),
            (true, _, _, true) => Some(AreaHandle::SouthWest),
            (_, true, _, true) => Some(AreaHandle::SouthEast),
            (true, _, _, _) if within_y => Some(AreaHandle::West),
            (_, true, _, _) if within_y => Some(AreaHandle::East),
            (_, _, true, _) if within_x => Some(AreaHandle::North),
            (_, _, _, true) if within_x => Some(AreaHandle::South),
            _ => None,
        };

        if let Some(handle) = handle {
            return Some(AreaZone::Handle(handle));
        }
        (x > crop.x && x < crop.right() && y > crop.y && y < crop.bottom())
            .then_some(AreaZone::Inside)
    }

    fn area_mouse_down(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let point = (f32::from(position.x), f32::from(position.y));

        self.drag = match self.area_zone_at(point) {
            Some(AreaZone::Handle(handle)) => Some(AreaDrag::Resize {
                handle,
                start: self.crop.unwrap_or(AreaRect {
                    x: point.0,
                    y: point.1,
                    width: 0.,
                    height: 0.,
                }),
            }),
            Some(AreaZone::Inside) => Some(AreaDrag::Move {
                grab: point,
                start: self.crop.unwrap(),
            }),
            None => {
                // A press outside the selection starts a fresh one, the way the
                // Cropper's full-screen "Start selection" button does.
                self.crop = Some(AreaRect {
                    x: point.0,
                    y: point.1,
                    width: 0.,
                    height: 0.,
                });
                Some(AreaDrag::Draw { anchor: point })
            }
        };
        cx.notify();
    }

    fn area_mouse_move(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(drag) = &self.drag else { return };
        let x = f32::from(position.x).clamp(0., self.display_size.0);
        let y = f32::from(position.y).clamp(0., self.display_size.1);

        let next = match drag {
            AreaDrag::Draw { anchor } => AreaRect {
                x: anchor.0.min(x),
                y: anchor.1.min(y),
                width: (x - anchor.0).abs(),
                height: (y - anchor.1).abs(),
            },
            AreaDrag::Move { grab, start } => AreaRect {
                x: start.x + (x - grab.0),
                y: start.y + (y - grab.1),
                ..*start
            }
            .clamped(self.display_size),
            AreaDrag::Resize { handle, start } => {
                let mut left = start.x;
                let mut top = start.y;
                let mut right = start.right();
                let mut bottom = start.bottom();
                if handle.west() {
                    left = x;
                }
                if handle.east() {
                    right = x;
                }
                if handle.north() {
                    top = y;
                }
                if handle.south() {
                    bottom = y;
                }
                AreaRect {
                    x: left.min(right),
                    y: top.min(bottom),
                    width: (right - left).abs(),
                    height: (bottom - top).abs(),
                }
            }
        };

        self.crop = Some(next);
        cx.notify();
    }

    fn area_mouse_up(&mut self, cx: &mut Context<Self>) {
        let Some(drag) = self.drag.take() else {
            return;
        };
        if let Some(crop) = self.crop {
            // A click with no drag is not a selection.
            if crop.width < 2. || crop.height < 2. {
                self.crop = None;
            } else {
                self.crop = Some(crop.clamped(self.display_size));
            }
        }
        // Releasing a fresh draw in screenshot mode captures immediately --
        // the screenshot area picker has no confirm step
        // (`target-select-overlay.tsx`'s area mouse-up). Move/resize grabs
        // keep the crop for the Start button, same as recording mode.
        if matches!(drag, AreaDrag::Draw { .. })
            && self.select.read(cx).recording_mode == Mode::Screenshot
            && let Some(target) = self.target(cx)
        {
            cx.defer(move |cx: &mut App| crate::screenshot::take_screenshot(target, cx));
        }
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> AreaRect {
        AreaRect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn area_rects_clamp_into_the_display() {
        let display = (1000., 800.);
        // Dragged off the right edge: pushed back, size preserved.
        assert_eq!(
            rect(950., 10., 200., 100.).clamped(display),
            rect(800., 10., 200., 100.)
        );
        // Bigger than the display: capped, not offset.
        assert_eq!(
            rect(-50., -50., 2000., 2000.).clamped(display),
            rect(0., 0., 1000., 800.)
        );
    }

    /// `MIN_SIZE` is 150x150 for a recording; anything smaller is drawn but
    /// not recordable. A screenshot only needs `MIN_SCREENSHOT_SIZE` (1px).
    #[test]
    fn area_validity_matches_the_min_size() {
        assert!(rect(0., 0., 150., 150.).is_valid_for(area_min_size(Mode::Studio)));
        assert!(!rect(0., 0., 149., 400.).is_valid_for(area_min_size(Mode::Studio)));
        assert!(!rect(0., 0., 400., 149.).is_valid_for(area_min_size(Mode::Studio)));
        assert!(rect(0., 0., 20., 20.).is_valid_for(area_min_size(Mode::Screenshot)));
        assert!(!rect(0., 0., 0.5, 20.).is_valid_for(area_min_size(Mode::Screenshot)));
    }

    /// The `ScreenCaptureTarget::Area` bounds are display-relative logical
    /// points -- the same space the overlay draws in, which is what makes the
    /// crop and the recording agree.
    #[test]
    fn area_bounds_are_display_relative_logical_points() {
        let bounds = rect(120., 64., 800., 600.).to_bounds();
        assert_eq!(bounds.position().x(), 120.);
        assert_eq!(bounds.position().y(), 64.);
        assert_eq!(bounds.size().width(), 800.);
        assert_eq!(bounds.size().height(), 600.);
    }
}
