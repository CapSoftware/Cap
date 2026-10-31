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

use std::cell::Cell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

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

use crate::i18n::tr;
use crate::theme::LocaleFont as _;
use crate::{
    app_windows,
    editor_canvas::{
        GuideAxis, NormRect, SNAP_PX, SnapGuide, build_snap_targets, snap_moving_rect,
    },
    main_window::{Mode, TargetType},
    sign_in::SignIn,
    theme::Theme,
    ui::Hint,
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

fn required_window_title_matches(required: Option<&str>, actual: Option<&str>) -> bool {
    required.is_none_or(|required| actual == Some(required))
}

fn overlay_display_is_active(
    cursor_display: Option<&DisplayId>,
    display: &DisplayId,
    only_overlay: bool,
    window_hovered: bool,
) -> bool {
    cursor_display.map_or(only_overlay || window_hovered, |cursor| cursor == display)
}

/// Whether a new mic level should repaint an overlay: only when it drew the
/// meter and the fill moves by a device pixel. The cluster's width bounds the
/// meter's.
fn overlay_meter_moved(drawn: Option<f32>, next: f32, scale: f32) -> bool {
    drawn.is_some_and(|drawn| crate::ui::moves_a_device_pixel(drawn, next, CLUSTER_WIDTH * scale))
}

fn overlay_viewport_size(viewport: (f32, f32), previous: (f32, f32)) -> (f32, f32) {
    if viewport.0.is_finite() && viewport.1.is_finite() && viewport.0 > 0. && viewport.1 > 0. {
        viewport
    } else {
        previous
    }
}

pub(crate) fn capture_scale_factor(window: &Window) -> f32 {
    #[cfg(target_os = "linux")]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        if HasWindowHandle::window_handle(window).is_ok_and(|handle| {
            matches!(
                handle.as_raw(),
                RawWindowHandle::Xlib(_) | RawWindowHandle::Xcb(_)
            )
        }) {
            // X11 capture bounds are physical pixels, even when scap calls them logical.
            return window.scale_factor();
        }
    }
    let _ = window;
    1.
}

fn recording_devices_available(cx: &App) -> bool {
    crate::session::RecordingSession::global(cx).read(cx).phase == crate::session::Phase::Idle
        && !app_windows::clean_capture_owned(cx)
        && cx
            .global::<app_windows::AppWindows>()
            .main
            .read(cx)
            .is_ok_and(|view| !view.is_preparing_recording())
}

/// How close to an edge or corner counts as grabbing that handle: wider than
/// the TSX's 12px so a handle is easy to catch. A distance test, because the
/// hit zones are computed in one place here rather than being eight elements
/// with their own listeners.
const AREA_HANDLE_GRAB: f32 = 18.;

/// `w-104` on the controls cluster, and the height its one card comes out at
/// (`p-3` + `h-11` + `p-3`, plus `my-2.5` above and below). The TSX measures
/// its own controls element with a ResizeObserver to place it against the
/// crop; gpui has no layout read-back, so the two numbers are constants.
const CLUSTER_WIDTH: f32 = 416.;
const CLUSTER_HEIGHT: f32 = 88.;

fn area_controls_position(crop: AreaRect, available: AreaRect, cluster_height: f32) -> (f32, f32) {
    let left = available.x + 16.;
    let right = (available.right() - CLUSTER_WIDTH - 16.).max(left);
    let top = available.y + 40.;
    let bottom = (available.bottom() - cluster_height - 16.).max(top);
    let below = crop.bottom() + 16.;
    let above = crop.y - cluster_height - 16.;
    let y = if below <= bottom {
        below
    } else if above >= top {
        above
    } else {
        crop.y + 40.
    };
    (
        (crop.x + crop.width / 2. - CLUSTER_WIDTH / 2.).clamp(left, right),
        y.clamp(top, bottom),
    )
}

const COUNTDOWN_OPTIONS: &[(u32, fn() -> &'static str)] = &[
    (0, tr::settings::general::recording::countdown::off),
    (3, tr::settings::general::recording::countdown::seconds_3),
    (5, tr::settings::general::recording::countdown::seconds_5),
    (10, tr::settings::general::recording::countdown::seconds_10),
];

const SELECTION_HINT_CYCLE: Duration = Duration::from_millis(2800);

/// The hint redraws on a 30 fps timer rather than every display refresh: it
/// is a small illustration, but each frame repaints a full-screen overlay.
const SELECTION_HINT_FRAME: Duration = Duration::from_nanos(1_000_000_000 / 30);

/// Where the hint is in its cycle, the way gpui's repeating `Animation`
/// computes it: linear time since it first drew, wrapped to `0..1`.
fn selection_hint_progress(elapsed: Duration) -> f32 {
    (elapsed.as_secs_f32() / SELECTION_HINT_CYCLE.as_secs_f32()) % 1.
}

fn material_ease(progress: f32) -> f32 {
    let progress = progress.clamp(0., 1.);
    if progress <= 0. {
        return 0.;
    }
    if progress >= 1. {
        return 1.;
    }
    let mut low = 0.;
    let mut high = 1.;
    for _ in 0..10 {
        let t = (low + high) / 2.;
        let inverse = 1. - t;
        let x = 3. * inverse * inverse * t * 0.4 + 3. * inverse * t * t * 0.2 + t * t * t;
        if x < progress {
            low = t;
        } else {
            high = t;
        }
    }
    let t = (low + high) / 2.;
    let inverse = 1. - t;
    3. * inverse * t * t + t * t * t
}

fn selection_drag_progress(progress: f32) -> f32 {
    if progress <= 0.5 {
        material_ease(progress * 2.)
    } else {
        1. - material_ease((progress - 0.5) * 2.)
    }
}

fn norm_area_rect(rect: AreaRect, display_size: (f32, f32)) -> NormRect {
    let width = f64::from(display_size.0.max(1.));
    let height = f64::from(display_size.1.max(1.));
    NormRect {
        x: f64::from(rect.x) / width,
        y: f64::from(rect.y) / height,
        w: f64::from(rect.width) / width,
        h: f64::from(rect.height) / height,
    }
}

fn snap_area_rect(
    rect: AreaRect,
    display_size: (f32, f32),
    others: &[NormRect],
) -> (AreaRect, Vec<SnapGuide>) {
    let rect = rect.clamped(display_size);
    let targets = build_snap_targets(others, None);
    let normalized = norm_area_rect(rect, display_size);
    let (dx, dy, guides) = snap_moving_rect(
        normalized,
        &targets,
        SNAP_PX / f64::from(display_size.0.max(1.)),
        SNAP_PX / f64::from(display_size.1.max(1.)),
    );
    (
        AreaRect {
            x: rect.x + (dx * f64::from(display_size.0)) as f32,
            y: rect.y + (dy * f64::from(display_size.1)) as f32,
            ..rect
        }
        .clamped(display_size),
        guides,
    )
}

fn snap_area_point(
    point: (f32, f32),
    display_size: (f32, f32),
    others: &[NormRect],
) -> ((f32, f32), Vec<SnapGuide>) {
    let rect = AreaRect {
        x: point.0,
        y: point.1,
        width: 0.,
        height: 0.,
    };
    let (snapped, guides) = snap_area_rect(rect, display_size, others);
    ((snapped.x, snapped.y), guides)
}

/// Snap the edges a resize handle moves: only the axes it drags snap, so an
/// edge handle never nudges the other axis.
fn snap_resize_point(
    point: (f32, f32),
    display_size: (f32, f32),
    others: &[NormRect],
    horizontal: bool,
    vertical: bool,
) -> ((f32, f32), Vec<SnapGuide>) {
    let ((x, y), guides) = snap_area_point(point, display_size, others);
    let guides = guides
        .into_iter()
        .filter(|guide| match guide.axis {
            GuideAxis::V => horizontal,
            GuideAxis::H => vertical,
        })
        .collect();
    (
        (
            if horizontal { x } else { point.0 },
            if vertical { y } else { point.1 },
        ),
        guides,
    )
}

/// The smallest window an area snaps to: anything smaller is a palette or a
/// badge, and its edges would only get in the way.
const AREA_SNAP_WINDOW_MIN: f32 = 48.;

fn area_snap_rects(
    work_area: AreaRect,
    windows: &[AreaRect],
    display_size: (f32, f32),
) -> Vec<NormRect> {
    let whole = |rect: &AreaRect| {
        rect.x.abs() < 1.
            && rect.y.abs() < 1.
            && (rect.width - display_size.0).abs() < 1.
            && (rect.height - display_size.1).abs() < 1.
    };
    std::iter::once(work_area)
        .chain(windows.iter().copied())
        .filter_map(|rect| rect.intersected(display_size))
        .filter(|rect| {
            rect.width >= AREA_SNAP_WINDOW_MIN
                && rect.height >= AREA_SNAP_WINDOW_MIN
                && !whole(rect)
        })
        .map(|rect| norm_area_rect(rect, display_size))
        .collect()
}

#[cfg(debug_assertions)]
#[derive(Clone, Copy)]
pub(crate) enum ProbeDrag {
    Press,
    Move,
    Release,
}

#[cfg(debug_assertions)]
pub(crate) mod probe_frames {
    use std::sync::Mutex;
    use std::time::Instant;

    use scap_targets::DisplayId;

    /// Only the dragged display's overlay counts: another display repainting
    /// for the mic meter would add frames it did not draw.
    static FRAMES: Mutex<Option<(DisplayId, Vec<Instant>)>> = Mutex::new(None);

    pub(crate) fn rendered(display: &DisplayId) {
        if let Ok(mut frames) = FRAMES.lock()
            && let Some((measured, frames)) = frames.as_mut()
            && measured == display
        {
            frames.push(Instant::now());
        }
    }

    pub(crate) fn begin(display: DisplayId) {
        if let Ok(mut frames) = FRAMES.lock() {
            *frames = Some((display, Vec::with_capacity(4096)));
        }
    }

    pub(crate) fn end() -> Vec<Instant> {
        FRAMES
            .lock()
            .ok()
            .and_then(|mut frames| frames.take())
            .map(|(_, frames)| frames)
            .unwrap_or_default()
    }
}

fn snap_off(modifiers: &gpui::Modifiers) -> bool {
    if cfg!(target_os = "macos") {
        modifiers.platform
    } else {
        modifiers.control
    }
}

fn render_thirds(crop: AreaRect) -> impl IntoElement {
    let line = gpui::hsla(0., 0., 1., 0.28);
    let mut grid = div()
        .absolute()
        .left(px(crop.x))
        .top(px(crop.y))
        .w(px(crop.width))
        .h(px(crop.height));
    for third in [1. / 3., 2. / 3.] {
        grid = grid
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left(px((crop.width * third).round()))
                    .w(px(1.))
                    .h_full()
                    .bg(line),
            )
            .child(
                div()
                    .absolute()
                    .left_0()
                    .top(px((crop.height * third).round()))
                    .h(px(1.))
                    .w_full()
                    .bg(line),
            );
    }
    grid
}

/// The window under the cursor, as the overlays need it.
#[derive(Clone, Debug, PartialEq)]
pub struct HoveredWindow {
    pub id: WindowId,
    pub app_name: String,
    pub display_id: DisplayId,
    /// Bounds relative to the display's top-left in capture coordinates;
    /// X11 overlays convert these physical pixels to logical points. Carried as our own
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
    microphone_fill: f32,
    /// App icons by window id, fetched once per window.
    icons: HashMap<String, Arc<gpui::Image>>,
    /// Windows the picker moved or resized, keyed by id, with where they
    /// were: dismissing the picker puts them back, starting a recording
    /// keeps them where the user shaped them.
    arranged: HashMap<String, ArrangedWindow>,
    /// Focus, shared by every display's overlay because the recording reads
    /// the one setting it mirrors.
    pub focus_window: bool,
    pub focus_center: bool,
    _poll: Option<gpui::Task<()>>,
}

/// A window the picker moved, as the picker found it.
#[derive(Clone)]
pub struct ArrangedWindow {
    pub window: HoveredWindow,
    /// Set when its bounds alone cannot put it back (a maximized window).
    pub placement: Option<crate::foreign_window::Placement>,
}

enum Arrangement {
    Frame(AreaRect),
    PutBack(ArrangedWindow),
}

/// Focus records a window by itself, which only macOS and Windows capture.
const FOCUS_SUPPORTED: bool = cfg!(any(target_os = "macos", windows));

fn saved_focus() -> bool {
    FOCUS_SUPPORTED
        && crate::store::GeneralSettings::load().window_capture_style
            == crate::store::WindowCaptureStyle::FocusedWindow
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
            microphone_fill: 0.,
            icons: HashMap::new(),
            arranged: HashMap::new(),
            focus_window: saved_focus(),
            focus_center: crate::store::GeneralSettings::load().focus_center,
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
        if self.mode.is_none() && mode.is_some() {
            // Left over from a picker that closed some way that neither put
            // them back nor recorded them.
            crate::foreign_window::put_back_all(self.take_arranged(), cx.background_executor());
            self.focus_window = saved_focus();
            self.focus_center = crate::store::GeneralSettings::load().focus_center;
        }
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

    /// Remember where `window` was before the picker first moves it.
    pub fn remember_arranged(&mut self, window: &HoveredWindow) {
        self.arranged
            .entry(window.id.to_string())
            .or_insert_with(|| ArrangedWindow {
                window: window.clone(),
                placement: crate::foreign_window::placement(&window.id),
            });
    }

    /// Where the picker found window `id`, if it has moved it since.
    pub fn arranged_original(&self, id: &WindowId) -> Option<&ArrangedWindow> {
        self.arranged.get(&id.to_string())
    }

    pub fn has_arranged(&self) -> bool {
        !self.arranged.is_empty()
    }

    /// Every window the picker moved, with where it was, forgetting them.
    pub fn take_arranged(&mut self) -> Vec<ArrangedWindow> {
        self.arranged.drain().map(|(_, window)| window).collect()
    }

    pub fn set_pinned(&mut self, window: HoveredWindow, cx: &mut Context<Self>) {
        if self.pinned_window.as_ref() != Some(&window) {
            self.pinned_window = Some(window);
            cx.notify();
        }
    }

    /// Lock the highlight onto whatever the cursor is over -- the TSX's
    /// click-anywhere-to-select behavior. True when that picked a new window.
    fn pin_hovered(&mut self, cx: &mut Context<Self>) -> bool {
        if let Some(hovered) = self.hovered_window.clone()
            && self.pinned_window.as_ref().map(|window| &window.id) != Some(&hovered.id)
        {
            self.pinned_window = Some(hovered);
            cx.notify();
            return true;
        }
        false
    }

    fn start_polling(&mut self, cx: &mut Context<Self>) {
        self._poll = Some(cx.spawn(async move |this, cx| {
            loop {
                // Only the window variant needs the (much more expensive)
                // window probe; the others just want to know which display the
                // cursor is on.
                let Ok((want_window, pinned)) = this.read_with(cx, |this, _| {
                    (
                        this.mode == Some(TargetType::Window),
                        this.pinned_window.as_ref().map(|window| window.id.clone()),
                    )
                }) else {
                    return;
                };

                let probe = cx
                    .background_executor()
                    .spawn(async move {
                        let display = scap_targets::Display::get_containing_cursor()
                            .map(|display| display.id());
                        let window = want_window
                            .then(crate::devices::topmost_foreign_window_at_cursor)
                            .flatten()
                            .as_ref()
                            .and_then(HoveredWindow::from_window);
                        // The pinned window is re-read too: it may have been
                        // moved or resized, by the picker or by its app.
                        let pinned = pinned
                            .filter(|_| want_window)
                            .and_then(|id| scap_targets::Window::from_id(&id))
                            .as_ref()
                            .and_then(HoveredWindow::from_window);
                        (display, window, pinned)
                    })
                    .await;

                let Ok((icon_wanted, active, changed, microphone_changed)) =
                    this.update(cx, |this: &mut Self, cx| {
                        let (display, window, pinned) = probe;
                        let pinned_moved = pinned.as_ref().is_some_and(|pinned| {
                            this.pinned_window
                                .as_ref()
                                .is_some_and(|current| current.id == pinned.id && current != pinned)
                        });
                        if pinned_moved {
                            this.pinned_window = pinned;
                        }
                        let microphone_fill = crate::ui::MicrophoneLevel::capture_fill(cx);
                        // The mic level stays out of `changed`: only the overlays
                        // drawing the meter repaint for it, below.
                        let changed = pinned_moved
                            || this.cursor_display != display
                            || this.hovered_window != window;
                        let microphone_changed = this.microphone_fill != microphone_fill;
                        this.microphone_fill = microphone_fill;
                        this.cursor_display = display;
                        this.hovered_window = window;
                        if changed {
                            cx.notify();
                        }

                        (
                            this.active_window()
                                .map(|window| window.id.clone())
                                .filter(|id| !this.icons.contains_key(&id.to_string())),
                            this.active_window().cloned(),
                            changed,
                            microphone_changed,
                        )
                    })
                else {
                    return;
                };
                let fetched_icon = icon_wanted.is_some();
                if let Some(id) = icon_wanted {
                    Self::fetch_icon(id, &this, cx).await;
                }

                // The overlay's camera-parking effect runs off the same signal
                // as the highlight (`target-select-overlay.tsx:518-545`), and
                // like the repaint below it has to happen with no entity borrow
                // held -- it moves a native window.
                cx.update(|cx| app_windows::sync_camera_park(active, cx));

                // Repaint the overlays explicitly: none of them is the active
                // window while the user hovers another app, and an inactive
                // window only repaints when asked (the unit-2 finding). A tick
                // that changed nothing they draw has nothing to repaint.
                if changed || fetched_icon {
                    cx.update(app_windows::refresh_target_overlays);
                } else if microphone_changed {
                    cx.update(app_windows::refresh_microphone_overlays);
                }
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

/// The aspect ratios the area toolbar cycles through, `None` first for a free
/// selection. The 0.6.0 picker offered the same set (`COMMON_RATIOS`).
const AREA_RATIOS: [Option<(u32, u32)>; 9] = [
    None,
    Some((16, 9)),
    Some((4, 3)),
    Some((1, 1)),
    Some((9, 16)),
    Some((16, 10)),
    Some((21, 9)),
    Some((3, 2)),
    Some((2, 1)),
];

const AREA_SELECTION_STORE: &str = "gpui_area_selection";

fn stored_area_ratio() -> Option<(u32, u32)> {
    let section = crate::store::store_section(AREA_SELECTION_STORE);
    let ratio = section.get("aspectRatio")?.as_array()?;
    let [width, height] = ratio.as_slice() else {
        return None;
    };
    let ratio = (width.as_u64()? as u32, height.as_u64()? as u32);
    AREA_RATIOS.contains(&Some(ratio)).then_some(ratio)
}

fn store_area_ratio(ratio: Option<(u32, u32)>) {
    crate::store::update_store_section(AREA_SELECTION_STORE, |section| {
        section.insert(
            "aspectRatio".into(),
            ratio.map_or(serde_json::Value::Null, |(width, height)| {
                serde_json::json!([width, height])
            }),
        );
        true
    });
}

fn stored_locked_area() -> Option<(String, AreaRect)> {
    let section = crate::store::store_section(AREA_SELECTION_STORE);
    if !section.get("locked")?.as_bool()? {
        return None;
    }
    let display = section.get("screenId")?.as_str()?.to_string();
    let bounds = section.get("bounds")?;
    let value = |key: &str| bounds.get(key)?.as_f64().map(|value| value as f32);
    let bounds = AreaRect {
        x: value("x")?,
        y: value("y")?,
        width: value("width")?,
        height: value("height")?,
    };
    [bounds.x, bounds.y, bounds.width, bounds.height]
        .iter()
        .all(|value| value.is_finite())
        .then_some((display, bounds))
}

fn store_locked_area(locked: Option<(&DisplayId, AreaRect)>) {
    crate::store::update_store_section(AREA_SELECTION_STORE, |section| {
        match locked {
            Some((display, bounds)) => {
                section.insert("locked".into(), true.into());
                section.insert("screenId".into(), display.to_string().into());
                section.insert(
                    "bounds".into(),
                    serde_json::json!({
                        "x": bounds.x,
                        "y": bounds.y,
                        "width": bounds.width,
                        "height": bounds.height,
                    }),
                );
            }
            None => {
                section.insert("locked".into(), false.into());
            }
        }
        true
    });
}

fn locked_area_for(display: &DisplayId, display_size: (f32, f32), min: f32) -> Option<AreaRect> {
    let (locked_display, bounds) = stored_locked_area()?;
    (locked_display == display.to_string())
        .then(|| bounds.clamped(display_size))
        .filter(|bounds| bounds.is_valid_for(min))
}

const QUICK_AREA_RATIOS: [Option<(u32, u32)>; 5] = [
    None,
    Some((16, 9)),
    Some((4, 3)),
    Some((1, 1)),
    Some((9, 16)),
];

fn more_area_ratios() -> Vec<(u32, u32)> {
    AREA_RATIOS
        .iter()
        .flatten()
        .copied()
        .filter(|ratio| !QUICK_AREA_RATIOS.contains(&Some(*ratio)))
        .collect()
}

/// Whether the picker captures the desktop under its glass in `mode`.
/// Windows composites the display and window pickers' target fill opaque,
/// so a capture under their panes showed through it as hard-edged blocks;
/// there the panes sit on the fallback fill, as they do where no capture
/// is possible.
fn backdrop_suits(mode: Option<TargetType>) -> bool {
    match mode {
        None => false,
        Some(TargetType::Display | TargetType::Window) => !cfg!(windows),
        Some(TargetType::Area | TargetType::CameraOnly) => true,
    }
}

const AREA_RESHAPE: Duration = Duration::from_millis(240);

/// What the picker's glass sits on when there is no capture of the desktop
/// beneath it: the panel fill the picker had before it had glass.
fn fallback_fill(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        Theme::with_alpha(theme.gray_2, 0.82)
    } else {
        Theme::with_alpha(theme.gray_1, 0.82)
    }
}

fn area_fill(display: (f32, f32), ratio: Option<f32>) -> AreaRect {
    let (width, height) = match ratio {
        Some(ratio) if display.0 / display.1 > ratio => (display.1 * ratio, display.1),
        Some(ratio) => (display.0, display.0 / ratio),
        None => display,
    };
    AreaRect {
        x: (display.0 - width) / 2.,
        y: (display.1 - height) / 2.,
        width,
        height,
    }
}

fn area_between(from: AreaRect, to: AreaRect, t: f32) -> AreaRect {
    let t = 1. - (1. - t.clamp(0., 1.)).powi(3);
    let mix = |a: f32, b: f32| a + (b - a) * t;
    AreaRect {
        x: mix(from.x, to.x),
        y: mix(from.y, to.y),
        width: mix(from.width, to.width),
        height: mix(from.height, to.height),
    }
}

fn ratio_value((width, height): (u32, u32)) -> f32 {
    width as f32 / height.max(1) as f32
}

/// An area at `ratio` (width over height) spanning from the fixed `anchor`
/// towards `pointer`: the longer span wins, and the area shrinks to stay on
/// the display.
fn area_from_anchor_with_ratio(
    anchor: (f32, f32),
    pointer: (f32, f32),
    ratio: f32,
    display: (f32, f32),
) -> AreaRect {
    let (dx, dy) = (pointer.0 - anchor.0, pointer.1 - anchor.1);
    let (mut width, mut height) = (dx.abs(), dy.abs());
    if width / ratio >= height {
        height = width / ratio;
    } else {
        width = height * ratio;
    }
    let room_x = if dx >= 0. {
        display.0 - anchor.0
    } else {
        anchor.0
    };
    let room_y = if dy >= 0. {
        display.1 - anchor.1
    } else {
        anchor.1
    };
    let fit = [
        1.,
        room_x / width.max(f32::EPSILON),
        room_y / height.max(f32::EPSILON),
    ]
    .into_iter()
    .fold(f32::INFINITY, f32::min)
    .max(0.);
    width *= fit;
    height *= fit;
    AreaRect {
        x: if dx >= 0. { anchor.0 } else { anchor.0 - width },
        y: if dy >= 0. {
            anchor.1
        } else {
            anchor.1 - height
        },
        width,
        height,
    }
}

/// An edge-handle resize at `ratio`: the opposite edge stays put, the dragged
/// edge follows the pointer to whichever side of it the pointer is, and the
/// other span grows around the area's centre line, shrinking to stay on the
/// display.
fn area_edge_resize_with_ratio(
    handle: AreaHandle,
    start: AreaRect,
    pointer: (f32, f32),
    ratio: f32,
    display: (f32, f32),
) -> AreaRect {
    let (center_x, center_y) = (start.x + start.width / 2., start.y + start.height / 2.);
    if handle.east() || handle.west() {
        let anchor = if handle.west() {
            start.right()
        } else {
            start.x
        };
        let before = pointer.0 < anchor;
        let room_x = if before { anchor } else { display.0 - anchor };
        let room_y = 2. * center_y.min(display.1 - center_y);
        let width = (pointer.0 - anchor)
            .abs()
            .min(room_x)
            .min(room_y * ratio)
            .max(0.);
        let height = width / ratio;
        AreaRect {
            x: if before { anchor - width } else { anchor },
            y: center_y - height / 2.,
            width,
            height,
        }
    } else {
        let anchor = if handle.north() {
            start.bottom()
        } else {
            start.y
        };
        let before = pointer.1 < anchor;
        let room_y = if before { anchor } else { display.1 - anchor };
        let room_x = 2. * center_x.min(display.0 - center_x);
        let height = (pointer.1 - anchor)
            .abs()
            .min(room_y)
            .min(room_x / ratio)
            .max(0.);
        let width = height * ratio;
        AreaRect {
            x: center_x - width / 2.,
            y: if before { anchor - height } else { anchor },
            width,
            height,
        }
    }
}

/// An existing area brought to `ratio` around its centre, keeping its width
/// unless that would not fit the display.
fn area_with_ratio(area: AreaRect, ratio: f32, display: (f32, f32)) -> AreaRect {
    let (center_x, center_y) = (area.x + area.width / 2., area.y + area.height / 2.);
    let mut width = area.width.min(display.0);
    let mut height = width / ratio;
    if height > display.1 {
        height = display.1;
        width = height * ratio;
    }
    AreaRect {
        x: center_x - width / 2.,
        y: center_y - height / 2.,
        width,
        height,
    }
    .clamped(display)
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

    fn intersected(self, display: (f32, f32)) -> Option<Self> {
        let (left, top) = (self.x.max(0.), self.y.max(0.));
        let (right, bottom) = (self.right().min(display.0), self.bottom().min(display.1));
        (right > left && bottom > top).then_some(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
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

    fn scaled(self, scale: f32) -> Self {
        Self {
            x: self.x * scale,
            y: self.y * scale,
            width: self.width * scale,
            height: self.height * scale,
        }
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
        /// The area the press replaced, for Escape to bring back.
        previous: Option<AreaRect>,
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
    capture_scale: f32,
    controls_work_area: AreaRect,
    /// Physical pixels, for the `1920x1080 · 60FPS` line.
    physical_size: Option<(u32, u32)>,
    refresh_rate: f64,
    focus: gpui::FocusHandle,
    crop: Option<AreaRect>,
    drag: Option<AreaDrag>,
    snap_guides: Vec<SnapGuide>,
    /// The aspect ratio a drawn or resized area keeps, `None` for free.
    area_ratio: Option<(u32, u32)>,
    area_locked: bool,
    area_snap: Vec<NormRect>,
    area_windows_requested: bool,
    area_hover: Option<AreaZone>,
    /// The camera still has to follow the area: after a drag step (so it
    /// moves once a frame) or a restored area.
    area_camera_pending: bool,
    recording_area: bool,
    /// The mode menu the start pill's caret drops down -- `menuModes()`
    /// popped up at the event location (`target-select-overlay.tsx:2064-2090,
    /// 2206-2210`). `Some` while it is open.
    mode_menu: Option<crate::ui::MenuState>,
    countdown_menu: Option<crate::ui::MenuState>,
    aspect_menu: Option<crate::ui::MenuState>,
    /// The selection drawn mid-reshape: where it started and when. `crop`
    /// already holds where it is going.
    reshape: Option<(AreaRect, Instant)>,
    /// The picked window's size and ratio menu.
    window_menu: Option<crate::ui::MenuState>,
    /// The window highlight mid-move, the way `reshape` is for an area:
    /// where it was drawn and when the window started moving.
    window_reshape: Option<(AreaRect, Instant)>,
    /// Where the window highlight was last drawn, for a move to start from.
    window_drawn: Cell<Option<AreaRect>>,
    hints: crate::ui::Hints,
    /// The desktop under this overlay, for its glass panes to read.
    backdrop: crate::ui::glass::Backdrop,
    /// When the backdrop was captured, and whether a capture is running.
    backdrop_at: Option<Instant>,
    backdrop_capturing: bool,
    /// The area as the last render drew it, and when it last changed: a
    /// capture waits for the panels to stop moving.
    backdrop_crop: Option<AreaRect>,
    crop_moved_at: Option<Instant>,
    backdrop_wake_pending: bool,
    inline_camera: Option<Entity<crate::camera_window::CameraWindow>>,
    inline_camera_subscription: Option<gpui::Subscription>,
    empty_camera_state: crate::store::CameraWindowState,
    device_menu: Option<OverlayDeviceMenu>,
    /// Cached off the store so the start pill does not re-read the settings
    /// file every frame; refreshed whenever the shared sign-in reports.
    signed_in: bool,
    /// The mic fill the last render drew, `None` when it drew no meter.
    drawn_microphone_fill: Cell<Option<f32>>,
    /// When the area hint first drew since it was last hidden.
    selection_hint_started: Option<Instant>,
    selection_hint_redraw: Option<gpui::Task<()>>,
    _main_subscription: Option<gpui::Subscription>,
}

#[derive(Clone)]
enum OverlayDeviceChoice {
    Camera(Option<crate::devices::CameraOption>),
    Microphone(Option<crate::devices::MicrophoneOption>),
    Access(crate::permissions::OSPermission),
}

struct OverlayDeviceMenu {
    state: crate::ui::MenuState,
    items: Vec<crate::ui::MenuItem>,
    choices: Vec<OverlayDeviceChoice>,
}

/// `menuModes` (`target-select-overlay.tsx:2064-2090`): three check items, in
/// this order, checked on the current mode. Picking one switches the mode and
/// never starts a recording.
const MODE_MENU: [(fn() -> &'static str, Mode); 3] = [
    (tr::main::mode::header::studio, Mode::Studio),
    (tr::main::mode::header::instant, Mode::Instant),
    (tr::main::mode::header::screenshot, Mode::Screenshot),
];

fn mode_menu_items(current: Mode) -> Vec<crate::ui::MenuItem> {
    MODE_MENU
        .into_iter()
        .map(|(label, mode)| crate::ui::MenuItem::new(label(), mode == current))
        .collect()
}

/// Overlays are never the active window while the picker is up, and an
/// inactive window may not present a bare notify, so every state an overlay
/// draws asks for its repaint explicitly.
fn repaint(window: &mut Window, cx: &mut Context<OverlayWindow>) {
    cx.notify();
    window.refresh();
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
        cx.observe_in(&select, window, |_, _, window, cx| repaint(window, cx))
            .detach();
        // Activating an overlay (a click, or the focus hand-off when it opens)
        // lifts it to the top of its band on Windows and X11, over the camera.
        cx.observe_window_activation(window, |_, window, cx| {
            if window.is_window_active() {
                cx.spawn(async move |_, cx| app_windows::raise_camera_above_overlays(cx))
                    .detach();
            }
        })
        .detach();
        let session = crate::session::RecordingSession::global(cx);
        let mut drawn_phase = session.read(cx).phase;
        cx.observe_in(&session, window, move |_, session, window, cx| {
            let phase = session.read(cx).phase;
            if phase != drawn_phase {
                drawn_phase = phase;
                repaint(window, cx);
            }
        })
        .detach();
        let main = cx.global::<app_windows::AppWindows>().main;
        let main_subscription = main
            .update(cx, |_, _, cx| cx.entity())
            .ok()
            .map(|main| cx.observe_in(&main, window, |_, _, window, cx| repaint(window, cx)));
        let media = crate::media_access::MediaAccess::global(cx);
        media.update(cx, |access, cx| access.refresh(cx));
        cx.observe_in(&media, window, |_, _, window, cx| repaint(window, cx))
            .detach();
        cx.observe_in(
            &SignIn::global(cx),
            window,
            |this: &mut Self, _, window, cx| {
                this.signed_in = crate::store::auth_snapshot().signed_in();
                repaint(window, cx);
            },
        )
        .detach();

        let capture_scale = capture_scale_factor(window);
        let logical = display
            .logical_size()
            .map(|size| {
                (
                    size.width() as f32 / capture_scale,
                    size.height() as f32 / capture_scale,
                )
            })
            .unwrap_or((1920., 1080.));

        let controls_work_area = display
            .raw_handle()
            .logical_bounds()
            .zip(app_windows::display_work_area(Some(display), cx))
            .map(|(bounds, available)| AreaRect {
                x: f32::from(available.origin.x) - bounds.position().x() as f32 / capture_scale,
                y: f32::from(available.origin.y) - bounds.position().y() as f32 / capture_scale,
                width: f32::from(available.size.width),
                height: f32::from(available.size.height),
            })
            .unwrap_or(AreaRect {
                x: 0.,
                y: 0.,
                width: logical.0,
                height: logical.1,
            })
            .clamped(logical);
        let locked_area = locked_area_for(
            &display.id(),
            logical,
            area_min_size(select.read(cx).recording_mode),
        );

        Self {
            theme,
            select,
            display_id: display.id(),
            display_name: display
                .name()
                .unwrap_or_else(|| tr::overlay::display_fallback(display.id())),
            display_size: logical,
            capture_scale,
            controls_work_area,
            physical_size: display
                .physical_size()
                .map(|size| (size.width() as u32, size.height() as u32)),
            refresh_rate: display.refresh_rate(),
            focus: cx.focus_handle(),
            crop: locked_area,
            drag: None,
            snap_guides: Vec::new(),
            area_ratio: stored_area_ratio(),
            area_locked: locked_area.is_some(),
            area_snap: area_snap_rects(controls_work_area, &[], logical),
            area_windows_requested: false,
            area_hover: None,
            area_camera_pending: locked_area.is_some(),
            recording_area: false,
            mode_menu: None,
            countdown_menu: None,
            aspect_menu: None,
            reshape: None,
            window_menu: None,
            window_reshape: None,
            window_drawn: Cell::new(None),
            hints: crate::ui::Hints::default(),
            backdrop: crate::ui::glass::Backdrop::new(fallback_fill(&theme)),
            backdrop_at: None,
            backdrop_capturing: false,
            backdrop_crop: None,
            crop_moved_at: None,
            backdrop_wake_pending: false,
            inline_camera: None,
            inline_camera_subscription: None,
            empty_camera_state: crate::store::load().camera_window.unwrap_or_default(),
            device_menu: None,
            signed_in: crate::store::auth_snapshot().signed_in(),
            drawn_microphone_fill: Cell::new(None),
            selection_hint_started: None,
            selection_hint_redraw: None,
            _main_subscription: main_subscription,
        }
    }

    pub fn focus_handle(&self) -> gpui::FocusHandle {
        self.focus.clone()
    }

    /// Seed an area selection without drawing one -- the harness path
    /// (`CAP_GPUI_AUTO_AREA`), since unprivileged synthetic drags are dropped.
    pub fn set_crop(&mut self, crop: AreaRect, cx: &mut Context<Self>) {
        if self.recording_area {
            return;
        }
        self.crop = Some(crop.clamped(self.display_size));
        self.sync_area_camera(cx);
        cx.notify();
    }

    pub fn commit_area_for_recording(&mut self, cx: &mut Context<Self>) -> bool {
        if self.select.read(cx).mode != Some(TargetType::Area) || self.target(cx).is_none() {
            return false;
        }
        self.recording_area = true;
        self.drag = None;
        self.snap_guides.clear();
        self.mode_menu = None;
        self.countdown_menu = None;
        self.device_menu = None;
        self.aspect_menu = None;
        self.reshape = None;
        cx.notify();
        true
    }

    pub fn is_recording_area(&self) -> bool {
        self.recording_area
    }

    /// The target this overlay would record, or `None` when it has nothing to
    /// record yet (no window under the cursor, no valid area drawn).
    pub fn target(&self, cx: &App) -> Option<ScreenCaptureTarget> {
        if self.recording_area {
            return self.crop.map(|crop| ScreenCaptureTarget::Area {
                screen: self.display_id.clone(),
                bounds: crop.scaled(self.capture_scale).to_bounds(),
            });
        }
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
                    bounds: crop.scaled(self.capture_scale).to_bounds(),
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
        if self.needs_sign_in(self.select.read(cx).recording_mode, cx) {
            self.signed_in = crate::store::auth_snapshot().signed_in();
            if !self.signed_in {
                self.start_sign_in(cx);
                return;
            }
        }
        if let ScreenCaptureTarget::Window { id } = &target {
            let window = scap_targets::Window::from_id(id);
            let expected_title = crate::main_window::auto_window_title();
            let actual_title = window.as_ref().and_then(scap_targets::Window::name);
            if window.is_none()
                || !required_window_title_matches(
                    expected_title.as_deref(),
                    actual_title.as_deref(),
                )
            {
                tracing::warn!(
                    window = %id,
                    expected = ?expected_title,
                    actual = ?actual_title,
                    "refusing unavailable or unexpected recording window"
                );
                cx.defer(app_windows::reject_unavailable_window);
                return;
            }
        }
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

    /// Instant mode uploads as it records, so it cannot start signed out
    /// (`target-select-overlay.tsx`'s "Sign In To Use"). The editor's record
    /// flow always records Studio whatever the pill says.
    fn needs_sign_in(&self, mode: Mode, cx: &App) -> bool {
        mode == Mode::Instant
            && !self.signed_in
            && crate::session::RecordingSession::global(cx)
                .read(cx)
                .editor_recording_target()
                .is_none()
    }

    /// The overlays sit above every app, browser included, so they step aside
    /// for the main window's sign-in prompt, and re-open for the same target
    /// kind once signed in.
    fn start_sign_in(&mut self, cx: &mut Context<Self>) {
        let Some(kind) = self.select.read(cx).mode else {
            return;
        };
        cx.defer(move |cx: &mut App| app_windows::show_instant_sign_in(kind, cx));
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        self.theme.refresh(window, cx, false);
        self.backdrop.set_fallback(fallback_fill(&self.theme));
    }

    /// Keep the capture under this overlay's glass current while the overlay
    /// shows controls, and let it go when it does not. A capture is taken
    /// only when the overlay draws, so a picker left alone takes none.
    fn sync_backdrop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let showing = crate::overlay_backdrop::enabled()
            && !self.recording_area
            && backdrop_suits(self.select.read(cx).mode)
            && self.is_active_display(window, cx);
        if !showing {
            if self.backdrop.has_image() {
                self.backdrop.set_image(None, gpui::Bounds::default());
                self.backdrop_at = None;
            }
            return;
        }
        if self.backdrop_crop != self.crop {
            self.backdrop_crop = self.crop;
            self.crop_moved_at = Some(Instant::now());
        }
        // A drawn area moves the camera into it, so a capture from before the
        // area last changed is stale however recent it is.
        let moved_since = self
            .crop_moved_at
            .zip(self.backdrop_at)
            .is_some_and(|(moved, captured)| moved > captured);
        if self.backdrop_capturing
            || (!moved_since
                && self
                    .backdrop_at
                    .is_some_and(|at| at.elapsed() < crate::overlay_backdrop::STALE_AFTER))
        {
            return;
        }
        // While the panels move with a dragged area the old capture holds:
        // retake it once they settle rather than mid-drag.
        let settling = self.backdrop.has_image()
            && self
                .crop_moved_at
                .is_some_and(|at| at.elapsed() < crate::overlay_backdrop::SETTLE);
        if settling {
            if !self.backdrop_wake_pending {
                self.backdrop_wake_pending = true;
                cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(crate::overlay_backdrop::SETTLE)
                        .await;
                    this.update(cx, |this, cx| {
                        this.backdrop_wake_pending = false;
                        cx.notify();
                    })
                    .ok();
                })
                .detach();
            }
            return;
        }
        self.backdrop_capturing = true;
        let native = crate::overlay_backdrop::native(window);
        let display = self.display_id.clone();
        let started = Instant::now();
        let overlay_window = window.window_handle();
        cx.spawn(async move |this, cx| {
            let camera = cx.update(|cx| {
                cx.global::<app_windows::AppWindows>()
                    .camera
                    .and_then(|camera| {
                        camera
                            .update(cx, |_, window, _| crate::overlay_backdrop::native(window))
                            .ok()
                            .flatten()
                    })
            });
            let image =
                crate::overlay_backdrop::capture(native, camera.into_iter().collect(), display, cx)
                    .await;
            this.update(cx, |this, cx| {
                this.backdrop_capturing = false;
                this.backdrop_at = Some(started);
                let size = this.display_size;
                let image = image.filter(|image| {
                    let pixels = image.size(0);
                    crate::overlay_backdrop::fits(
                        (pixels.width.0 as u32, pixels.height.0 as u32),
                        size,
                    )
                });
                this.backdrop.set_image(
                    image,
                    gpui::Bounds::new(
                        gpui::point(px(0.), px(0.)),
                        gpui::size(px(size.0), px(size.1)),
                    ),
                );
                cx.notify();
            })
            .ok();
            // An inactive overlay (another display's) may not present on a bare
            // notification; see `repaint`.
            cx.update_window(overlay_window, |_, window, _| window.refresh())
                .ok();
        })
        .detach();
    }

    #[cfg(debug_assertions)]
    pub(crate) fn backdrop_image(&self) -> Option<Arc<gpui::RenderImage>> {
        self.backdrop.image()
    }

    #[cfg(debug_assertions)]
    pub(crate) fn probe_drag(
        &mut self,
        step: ProbeDrag,
        point: (f32, f32),
        cx: &mut Context<Self>,
    ) -> bool {
        let position = gpui::point(px(point.0), px(point.1));
        match step {
            ProbeDrag::Press => {
                // A lock saved on this display would hold the area still.
                self.area_locked = false;
                self.area_mouse_down(position, cx);
            }
            ProbeDrag::Move => self.area_mouse_move(position, false, cx),
            ProbeDrag::Release => self.area_mouse_up(position, false, cx),
        }
        self.drag.is_some()
    }

    /// Move the drawn area `offset` points right, the way a drag would, for
    /// the picker probe's timing.
    #[cfg(debug_assertions)]
    pub(crate) fn probe_offset_area(
        &mut self,
        base: AreaRect,
        offset: f32,
        cx: &mut Context<Self>,
    ) {
        self.crop = Some(
            AreaRect {
                x: base.x + offset,
                ..base
            }
            .clamped(self.display_size),
        );
        cx.notify();
    }

    /// Retake the backdrop once a moved window has settled.
    fn retake_backdrop_soon(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(350))
                .await;
            this.update(cx, |this, cx| {
                this.backdrop_at = None;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn sync_inline_camera(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let camera = (self.select.read(cx).mode == Some(TargetType::CameraOnly))
            .then(|| app_windows::camera_preview_entity(cx))
            .flatten();
        if self.inline_camera.as_ref().map(Entity::entity_id)
            == camera.as_ref().map(Entity::entity_id)
        {
            return;
        }
        self.inline_camera_subscription = camera
            .as_ref()
            .map(|camera| cx.observe_in(camera, window, |_, _, window, cx| repaint(window, cx)));
        self.inline_camera = camera;
    }

    fn sync_area_camera(&self, cx: &mut Context<Self>) {
        if self.select.read(cx).recording_mode == Mode::Screenshot {
            return;
        }
        let display = self.display_id.clone();
        let crop = self.crop;
        let epoch = app_windows::camera_picker_epoch(cx);
        cx.defer(move |cx| {
            if app_windows::camera_picker_epoch(cx) == epoch {
                app_windows::sync_camera_area(display, crop, cx);
            }
        });
    }

    pub fn microphone_level_moved(&self, window: &Window, cx: &App) -> bool {
        overlay_meter_moved(
            self.drawn_microphone_fill.get(),
            self.select.read(cx).microphone_fill,
            window.scale_factor(),
        )
    }

    /// True when the cursor is on this overlay's display -- `data-over` in the
    /// display variant, `isActiveDisplay` in the area variant.
    fn is_active_display(&self, window: &Window, cx: &App) -> bool {
        overlay_display_is_active(
            self.select.read(cx).cursor_display.as_ref(),
            &self.display_id,
            cx.global::<app_windows::AppWindows>().overlays.len() == 1,
            cfg!(target_os = "linux") && window.is_window_hovered(),
        )
    }
}

impl Render for OverlayWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(debug_assertions)]
        probe_frames::rendered(&self.display_id);
        self.sync_appearance(window, cx);
        self.sync_inline_camera(window, cx);
        self.sync_backdrop(window, cx);
        let viewport = window.viewport_size();
        let display_size = overlay_viewport_size(
            (f32::from(viewport.width), f32::from(viewport.height)),
            self.display_size,
        );
        if !self.recording_area && self.display_size != display_size {
            self.display_size = display_size;
            self.crop = self.crop.map(|crop| crop.clamped(display_size));
            self.drag = None;
            self.snap_guides.clear();
            self.sync_area_camera(cx);
        }
        let mode = self.select.read(cx).mode;
        self.drawn_microphone_fill.set(None);
        self.hints.begin_frame();

        let root = div()
            .id("overlay-root")
            .track_focus(&self.focus)
            .key_context("TargetSelectOverlay")
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, window, cx| {
                if let Some(menu) = &mut this.countdown_menu {
                    match menu.on_key(&event.keystroke.key) {
                        crate::ui::MenuKey::Commit(index) => this.choose_countdown(index, cx),
                        crate::ui::MenuKey::Dismiss => {
                            this.countdown_menu = None;
                            cx.notify();
                        }
                        crate::ui::MenuKey::Moved => cx.notify(),
                        crate::ui::MenuKey::Ignored => return,
                    }
                    cx.stop_propagation();
                    return;
                }
                if let Some(menu) = &mut this.window_menu {
                    match menu.on_key(&event.keystroke.key) {
                        crate::ui::MenuKey::Commit(index) => this.choose_window_size(index, cx),
                        crate::ui::MenuKey::Dismiss => {
                            this.window_menu = None;
                            cx.notify();
                        }
                        crate::ui::MenuKey::Moved => cx.notify(),
                        crate::ui::MenuKey::Ignored => return,
                    }
                    cx.stop_propagation();
                    return;
                }
                if let Some(menu) = &mut this.aspect_menu {
                    match menu.on_key(&event.keystroke.key) {
                        crate::ui::MenuKey::Commit(index) => this.choose_aspect(index, cx),
                        crate::ui::MenuKey::Dismiss => {
                            this.aspect_menu = None;
                            cx.notify();
                        }
                        crate::ui::MenuKey::Moved => cx.notify(),
                        crate::ui::MenuKey::Ignored => return,
                    }
                    cx.stop_propagation();
                    return;
                }
                if let Some(menu) = &mut this.device_menu {
                    match menu.state.on_key(&event.keystroke.key) {
                        crate::ui::MenuKey::Commit(index) => this.choose_device(index, cx),
                        crate::ui::MenuKey::Dismiss => {
                            this.device_menu = None;
                            cx.notify();
                        }
                        crate::ui::MenuKey::Moved => cx.notify(),
                        crate::ui::MenuKey::Ignored => return,
                    }
                    cx.stop_propagation();
                    return;
                }
                // The Tauri app registers Escape as a *global* shortcut while
                // the overlays are up; here it is a plain key handler on the
                // overlay that has focus (see the README deviation).
                tracing::debug!(key = %event.keystroke.key, "overlay key");
                // The mode menu takes its keys first, like the menus above.
                if this.mode_menu.is_none() && this.area_key(&event.keystroke, window, cx) {
                    cx.stop_propagation();
                    return;
                }
                if event.keystroke.key.as_str() == "escape" {
                    // An open mode menu takes the Escape before the
                    // overlay does -- the native menu in the Tauri app
                    // eats it the same way during menu tracking.
                    if this.mode_menu.is_some() {
                        this.mode_menu = None;
                        cx.notify();
                    } else {
                        this.dismiss(cx);
                    }
                }
            }))
            .size_full()
            .relative()
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white())
            .child(self.backdrop.layer());

        let root = if self.recording_area {
            root.child(self.render_area_variant(window, cx))
        } else {
            match mode {
                Some(TargetType::Display) => root.child(self.render_display_variant(window, cx)),
                Some(TargetType::Window) => root.child(self.render_window_variant(window, cx)),
                Some(TargetType::Area) => root.child(self.render_area_variant(window, cx)),
                Some(TargetType::CameraOnly) => root.child(self.render_camera_variant(cx)),
                None => root,
            }
        };
        // Painted after the variant so the dropdown sits above the start
        // cluster it drops from.
        // A hint gives way to any open menu, which is what it would explain.
        let menu_open = self.mode_menu.is_some()
            || self.countdown_menu.is_some()
            || self.aspect_menu.is_some()
            || self.window_menu.is_some()
            || self.device_menu.is_some();
        let hint = (!menu_open)
            .then(|| self.hints.render(window, &self.theme, cx.reduce_motion()))
            .flatten();
        root.children(self.render_mode_menu(cx))
            .children(self.render_countdown_menu(cx))
            .children(self.render_aspect_menu(cx))
            .children(self.render_window_menu(cx))
            .children(self.render_device_menu(cx))
            .children(hint)
            .into_any_element()
    }
}

impl OverlayWindow {
    fn render_device_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.device_menu.as_ref()?;
        Some(
            crate::ui::Menu::plain(
                &self.theme,
                "overlay-device-menu",
                menu.items.clone(),
                &menu.state,
            )
            .on_select(cx.listener(|this, index: &usize, _, cx| {
                this.choose_device(*index, cx);
            }))
            .on_dismiss(cx.listener(|this, _, _, cx| {
                this.device_menu = None;
                cx.notify();
            }))
            .into_any_element(),
        )
    }

    fn choose_device(&mut self, index: usize, cx: &mut Context<Self>) {
        let choice = self
            .device_menu
            .take()
            .and_then(|menu| menu.choices.get(index).cloned());
        if let Some(choice) = choice {
            self.apply_device_choice(choice, cx);
        }
        cx.notify();
    }

    fn apply_device_choice(&mut self, choice: OverlayDeviceChoice, cx: &mut Context<Self>) {
        self.device_menu = None;
        let main = cx.global::<app_windows::AppWindows>().main;
        let needs_access = match &choice {
            OverlayDeviceChoice::Camera(Some(_)) => Some(crate::permissions::OSPermission::Camera),
            OverlayDeviceChoice::Microphone(Some(_)) => {
                Some(crate::permissions::OSPermission::Microphone)
            }
            OverlayDeviceChoice::Access(permission) => Some(*permission),
            _ => None,
        };
        if let Some(permission) = needs_access {
            request_media_access(permission, cx);
        }
        cx.defer(move |cx| {
            if !recording_devices_available(cx) {
                return;
            }
            if let Err(error) = main.update(cx, |view, _, cx| match choice {
                OverlayDeviceChoice::Camera(camera) => view.set_camera_selection(camera, cx),
                OverlayDeviceChoice::Microphone(mic) => view.set_microphone_selection(mic, cx),
                OverlayDeviceChoice::Access(_) => {}
            }) {
                tracing::warn!(%error, "could not update the recording device");
            }
        });
        cx.notify();
    }

    fn open_device_menu(&mut self, camera: bool, position: Point<Pixels>, cx: &mut Context<Self>) {
        if !recording_devices_available(cx) {
            return;
        }
        let main = cx.global::<app_windows::AppWindows>().main;
        let Ok(view) = main.read(cx) else { return };
        if view.is_enumerating_devices() {
            return;
        }
        let permission = if camera {
            crate::permissions::OSPermission::Camera
        } else {
            crate::permissions::OSPermission::Microphone
        };
        let access = crate::media_access::MediaAccess::global(cx);
        let access_item = (!access.read(cx).allowed(permission)).then(|| {
            let label = match (
                camera,
                access.read(cx).status(permission)
                    == crate::permissions::OSPermissionStatus::Denied,
            ) {
                (true, true) => tr::overlay::device::camera_turn_on(),
                (true, false) => tr::overlay::device::camera_allow(),
                (false, true) => tr::overlay::device::microphone_turn_on(),
                (false, false) => tr::overlay::device::microphone_allow(),
            };
            (
                crate::ui::MenuItem::new(label, false),
                OverlayDeviceChoice::Access(permission),
            )
        });
        let (mut items, mut choices) = if camera {
            let mut items = vec![crate::ui::MenuItem::new(
                tr::main::device::no_camera(),
                view.camera_selection().is_none(),
            )];
            let mut choices = vec![OverlayDeviceChoice::Camera(None)];
            for camera in &view.device_snapshot().cameras {
                items.push(crate::ui::MenuItem::new(
                    camera.label.clone(),
                    view.camera_selection()
                        .is_some_and(|selected| selected.device_id == camera.device_id),
                ));
                choices.push(OverlayDeviceChoice::Camera(Some(camera.clone())));
            }
            (items, choices)
        } else {
            let mut items = vec![crate::ui::MenuItem::new(
                tr::main::device::no_microphone(),
                view.microphone_selection().is_none(),
            )];
            let mut choices = vec![OverlayDeviceChoice::Microphone(None)];
            for mic in &view.device_snapshot().microphones {
                items.push(crate::ui::MenuItem::new(
                    mic.name.clone(),
                    view.microphone_selection()
                        .is_some_and(|selected| selected.name == mic.name),
                ));
                choices.push(OverlayDeviceChoice::Microphone(Some(mic.clone())));
            }
            (items, choices)
        };
        if let Some((item, choice)) = access_item {
            items.insert(0, item);
            choices.insert(0, choice);
        }
        self.mode_menu = None;
        self.countdown_menu = None;
        self.aspect_menu = None;
        self.window_menu = None;
        self.device_menu = Some(OverlayDeviceMenu {
            state: crate::ui::MenuState::new(position, &items),
            items,
            choices,
        });
        cx.notify();
    }

    fn render_device_control(&self, camera: bool, cx: &mut Context<Self>) -> gpui::AnyElement {
        let main = cx.global::<app_windows::AppWindows>().main;
        let Ok(view) = main.read(cx) else {
            return div().into_any_element();
        };
        let selected = if camera {
            view.camera_selection()
                .map(|camera| crate::main_window::camera_label(&camera.label))
        } else {
            view.microphone_selection().map(|mic| mic.name.clone())
        };
        let enabled = selected.is_some();
        let disabled = view.is_enumerating_devices() || !recording_devices_available(cx);
        let theme = self.theme;
        let permission = if camera {
            crate::permissions::OSPermission::Camera
        } else {
            crate::permissions::OSPermission::Microphone
        };
        let access = crate::media_access::MediaAccess::global(cx);
        let access = access.read(cx);
        let blocked = enabled && !access.allowed(permission);
        let pill_label = if !blocked {
            if enabled {
                tr::main::device::pill::on()
            } else {
                tr::main::device::pill::off()
            }
        } else if access.requesting(permission) {
            tr::main::device::pill::asking()
        } else if access.status(permission) == crate::permissions::OSPermissionStatus::Denied {
            tr::main::device::pill::allow_in_settings()
        } else {
            tr::main::device::pill::allow()
        };
        div()
            .id(if camera {
                "overlay-camera"
            } else {
                "overlay-microphone"
            })
            .relative()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .h(px(42.))
            .flex_1()
            .min_w_0()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.gray_5)
            .bg(theme.gray_3)
            .text_color(theme.gray_12)
            .overflow_hidden()
            .when(disabled, |row| row.opacity(0.7))
            .when(!camera && enabled && !disabled, |row| {
                let fill = self.select.read(cx).microphone_fill;
                self.drawn_microphone_fill.set(Some(fill));
                row.child(
                    crate::ui::MicrophoneLevel::snapshot(fill, theme.blue_9.into())
                        .absolute()
                        .top_0()
                        .left_0(),
                )
            })
            .child(
                svg()
                    .path(if camera {
                        "icons/camera.svg"
                    } else {
                        "icons/microphone.svg"
                    })
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(theme.gray_11),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(14.))
                    .child(selected.unwrap_or_else(|| {
                        if camera {
                            tr::main::device::no_camera()
                        } else {
                            tr::main::device::no_microphone()
                        }
                        .into()
                    })),
            )
            .child(
                div()
                    .id(if camera {
                        "overlay-camera-toggle"
                    } else {
                        "overlay-microphone-toggle"
                    })
                    .px(px(10.))
                    .h(px(24.))
                    .min_w(px(40.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .text_size(px(11.))
                    .bg(if blocked {
                        Hsla::from(theme.amber_3)
                    } else if enabled {
                        Hsla::from(theme.blue_9)
                    } else {
                        Hsla::from(theme.gray_5)
                    })
                    .text_color(if blocked {
                        Hsla::from(theme.amber_11)
                    } else if enabled {
                        gpui::white()
                    } else {
                        Hsla::from(theme.gray_11)
                    })
                    .child(pill_label)
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                        cx.stop_propagation();
                        if disabled {
                            return;
                        }
                        if blocked {
                            this.apply_device_choice(OverlayDeviceChoice::Access(permission), cx);
                        } else if enabled {
                            this.apply_device_choice(
                                if camera {
                                    OverlayDeviceChoice::Camera(None)
                                } else {
                                    OverlayDeviceChoice::Microphone(None)
                                },
                                cx,
                            );
                        } else {
                            this.open_device_menu(camera, event.position(), cx);
                        }
                    })),
            )
            .on_click(cx.listener(move |this, event: &gpui::ClickEvent, _, cx| {
                this.open_device_menu(camera, event.position(), cx);
            }))
            .into_any_element()
    }

    /// The caret's dropdown while it is open -- `Menu.popup` in the source,
    /// rendered with the app's own menu component here (the closest thing to
    /// a native context menu this side of AppKit; check state, outside-click
    /// dismissal and Escape behave the same).
    fn render_mode_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let state = self.mode_menu.as_ref()?;
        let items = mode_menu_items(self.select.read(cx).recording_mode);
        Some(
            crate::ui::Menu::plain(&self.theme, "overlay-mode-menu", items, state)
                .on_select(cx.listener(|this, index: &usize, _window, cx| {
                    this.choose_mode(*index, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    this.mode_menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    fn render_countdown_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let state = self.countdown_menu.as_ref()?;
        let current = crate::store::GeneralSettings::load()
            .recording_countdown
            .unwrap_or(0);
        let items = COUNTDOWN_OPTIONS
            .iter()
            .map(|(value, label)| crate::ui::MenuItem::new(label(), *value == current))
            .collect();
        Some(
            crate::ui::Menu::plain(&self.theme, "overlay-countdown-menu", items, state)
                .on_select(cx.listener(|this, index: &usize, _, cx| {
                    this.choose_countdown(*index, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _, cx| {
                    this.countdown_menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    fn choose_countdown(&mut self, index: usize, cx: &mut Context<Self>) {
        self.countdown_menu = None;
        if let Some((value, _)) = COUNTDOWN_OPTIONS.get(index)
            && !crate::store::set_store_setting(
                crate::store::GENERAL_SETTINGS,
                "recordingCountdown",
                serde_json::Value::from(*value),
            )
        {
            tracing::warn!(value, "could not save the recording countdown");
        }
        cx.notify();
    }

    /// A `CheckMenuItem` action: `setOptions("mode", ..)` +
    /// `commands.setRecordingMode(..)` -- the app's single mode funnel
    /// (`app_windows::set_recording_mode` -> `MainWindow::set_mode`), which
    /// writes the shared store key, relabels every open overlay through
    /// `TargetSelect::set_recording_mode`, and refreshes the tray.
    fn choose_mode(&mut self, index: usize, cx: &mut Context<Self>) {
        self.mode_menu = None;
        if crate::session::RecordingSession::global(cx)
            .read(cx)
            .editor_recording_target()
            .is_some()
        {
            cx.notify();
            return;
        }
        if let Some((_, mode)) = MODE_MENU.get(index).copied() {
            app_windows::set_recording_mode(mode, cx);
        }
        cx.notify();
    }

    /// `data-[over='true']:bg-blue-600/40` over `bg-black/60`, centered
    /// monitor art, name, resolution.
    fn render_display_variant(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let over = self.is_active_display(window, cx);
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
    fn render_window_variant(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let select = self.select.read(cx);
        let focus = select.focus_window && crate::foreign_window::can_arrange();
        let active = select
            .active_window()
            .filter(|window| window.display_id == self.display_id)
            .cloned();
        let icon = active
            .as_ref()
            .and_then(|window| select.icon_for(&window.id));

        let Some(active) = active else {
            self.window_drawn.set(None);
            return div().size_full().into_any_element();
        };
        let target = active.bounds.scaled(1. / self.capture_scale);
        let bounds = match self.window_reshape {
            Some((from, started)) => {
                let t = started.elapsed().as_secs_f32() / AREA_RESHAPE.as_secs_f32();
                if t >= 1. {
                    self.window_reshape = None;
                    target
                } else {
                    window.request_animation_frame();
                    area_between(from, target, t)
                }
            }
            None => target,
        };
        self.window_drawn.set(Some(bounds));

        div()
            .size_full()
            .relative()
            .bg(gpui::hsla(0., 0., 0., 0.7))
            .id("window-variant")
            // Clicking anywhere locks the highlight onto whatever is under the
            // cursor, exactly as the TSX's two click handlers add up to.
            .on_click(cx.listener(|this, _, _window, cx| {
                this.window_menu = None;
                let picked = this.select.update(cx, |select, cx| select.pin_hovered(cx));
                if picked && this.select.read(cx).focus_window {
                    this.set_focus(true, cx);
                }
                // `setOriginalCameraBounds(null)` on the first click
                // (`target-select-overlay.tsx:609-617`): committing a pick
                // leaves the camera bubble parked in the picked window.
                cx.defer(app_windows::release_camera_park);
            }))
            .when(focus, |variant| {
                variant.child(crate::focus_border::ring(bounds, &self.theme))
            })
            .child(
                div()
                    .absolute()
                    .left(px(bounds.x))
                    .top(px(bounds.y))
                    .w(px(bounds.width))
                    .h(px(bounds.height))
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
                            .child(self.render_window_size(target, cx))
                            .children(self.render_focus_toggle(cx)),
                    )
                    .child(self.render_controls_cluster(self.target(cx), false, cx)),
            )
            .into_any_element()
    }

    /// Recorded pixels per logical point of this display.
    fn pixels_per_point(&self) -> f32 {
        self.physical_size
            .map(|(width, _)| width as f32 / self.display_size.0.max(1.))
            .unwrap_or(1.)
    }

    /// The picked window's size as it will record, which opens the ratio and
    /// size menu where Cap can shape other apps' windows.
    fn render_window_size(&self, window: AreaRect, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let scale = self.pixels_per_point();
        let mut label = format!(
            "{} × {}",
            (window.width * scale).round(),
            (window.height * scale).round()
        );
        if let Some((w, h)) = crate::window_arrange::matching_ratio(window) {
            label.push_str(&format!("  ·  {w}:{h}"));
        }
        let arrangeable = crate::foreign_window::can_arrange();
        let hint = if arrangeable {
            Hint::new(tr::overlay::window::size_title()).body(tr::overlay::window::size_body())
        } else if cfg!(target_os = "macos") {
            Hint::new(tr::overlay::window::size_needs_accessibility_title())
                .body(tr::overlay::window::size_needs_accessibility_body())
        } else {
            Hint::new(tr::overlay::window::size_unavailable_title())
                .body(tr::overlay::window::size_unavailable_body())
        };
        let chip = self.glass_capsule(28.).id("window-size");
        self.hinted(chip, "window-size", hint, cx)
            .mb(px(8.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_size(px(12.))
            .text_color(theme.gray_12)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(label)
            .when(arrangeable, |chip| {
                chip.cursor_pointer()
                    .hover(move |style| style.bg(Theme::with_alpha(theme.gray_12, 0.08)))
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(12.))
                            .text_color(theme.gray_12),
                    )
                    .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                        cx.stop_propagation();
                        this.open_window_menu(event.position(), cx);
                    }))
            })
    }

    fn render_focus_toggle(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        if !FOCUS_SUPPORTED || !crate::foreign_window::can_arrange() {
            return None;
        }
        let theme = self.theme;
        let select = self.select.read(cx);
        let (focus, center) = (select.focus_window, select.focus_center);
        // Instant records the camera bubble off the screen, so with a camera
        // it keeps the screen region (see `instant_capture_window`).
        let camera = cx
            .global::<app_windows::AppWindows>()
            .main
            .read(cx)
            .is_ok_and(|view| view.camera_selection().is_some());
        let title = if focus {
            tr::overlay::window::focus_disable()
        } else {
            tr::overlay::window::focus_enable()
        };
        let explanation = if select.recording_mode == Mode::Instant && camera {
            tr::overlay::window::focus_body_instant_camera()
        } else {
            tr::overlay::window::focus_body()
        };
        let card = self.glass_surface().id("window-focus");
        let hint = Hint::new(title)
            .body(explanation)
            .side(crate::ui::HintSide::Left);
        let accent = Hsla::from(theme.blue_9);
        // The hint belongs to the Focus row alone: Center on screen explains
        // itself under its title.
        let header = self
            .hinted(
                div().id("window-focus-header").relative(),
                "window-focus",
                hint,
                cx,
            )
            .h(px(52.))
            .pl(px(10.))
            .pr(px(6.))
            .flex()
            .items_center()
            .gap(px(10.))
            .cursor_pointer()
            // The whole row is the switch's label, as a macOS form row is.
            .on_click(cx.listener(|this, _, _, cx| {
                cx.stop_propagation();
                let focus = this.select.read(cx).focus_window;
                this.set_focus(!focus, cx);
            }))
            .child(
                div()
                    .size(px(32.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(9.))
                    .bg(if focus {
                        accent
                    } else {
                        Theme::with_alpha(theme.gray_12, 0.08)
                    })
                    .child(
                        svg()
                            .path("icons/box-select.svg")
                            .size(px(17.))
                            .text_color(if focus {
                                gpui::white().into()
                            } else {
                                Hsla::from(theme.gray_12)
                            }),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .pr(px(14.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(17.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray_12)
                            .child(tr::overlay::window::focus_title()),
                    )
                    .child(
                        div()
                            .text_size(px(11.5))
                            .line_height(px(15.))
                            .font_weight(FontWeight::NORMAL)
                            .text_color(theme.gray_11)
                            .child(if focus {
                                tr::overlay::window::focus_on()
                            } else {
                                tr::overlay::window::focus_off()
                            }),
                    ),
            )
            .child(
                div().flex_shrink_0().child(
                    crate::ui::GlassSwitch::new("window-focus-toggle", focus, theme.is_dark())
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            let focus = this.select.read(cx).focus_window;
                            this.set_focus(!focus, cx);
                        })),
                ),
            );
        let details = focus.then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .px(px(12.))
                .pt(px(2.))
                .pb(px(10.))
                .child(
                    div()
                        .text_size(px(11.5))
                        .line_height(px(15.))
                        .text_color(theme.gray_11)
                        .child(explanation),
                )
                .child(div().h(px(1.)).bg(Theme::with_alpha(theme.gray_12, 0.08)))
                .child(
                    div()
                        .id("window-focus-center")
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .cursor_pointer()
                        .on_click(cx.listener(|this, _, _, cx| {
                            cx.stop_propagation();
                            let center = this.select.read(cx).focus_center;
                            this.set_focus_center(!center, cx);
                        }))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .text_size(px(12.5))
                                        .line_height(px(16.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(theme.gray_12)
                                        .child(tr::overlay::window::center_title()),
                                )
                                .child(
                                    div()
                                        .text_size(px(11.))
                                        .line_height(px(14.))
                                        .text_color(theme.gray_11)
                                        .child(tr::overlay::window::center_description()),
                                ),
                        )
                        .child(
                            div().flex_shrink_0().child(
                                crate::ui::GlassSwitch::new(
                                    "window-focus-center-toggle",
                                    center,
                                    theme.is_dark(),
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        cx.stop_propagation();
                                        let center = this.select.read(cx).focus_center;
                                        this.set_focus_center(!center, cx);
                                    },
                                )),
                            ),
                        ),
                )
        });
        Some(
            card.mb(px(10.))
                .w(px(300.))
                .flex()
                .flex_col()
                .when(focus, |card| {
                    card.border_1().border_color(accent.opacity(0.7))
                })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(header)
                .children(details),
        )
    }

    /// What each row of the window menu does.
    fn window_menu_entries(&self, window: AreaRect) -> Vec<(String, bool, AreaRect)> {
        use crate::window_arrange::{RATIOS, SIZES, fit_to_ratio, fit_to_size, matching_ratio};
        let work_area = self.controls_work_area;
        let scale = self.pixels_per_point();
        let current = matching_ratio(window);
        let recorded = (
            (window.width * scale).round() as u32,
            (window.height * scale).round() as u32,
        );
        let mut entries: Vec<(String, bool, AreaRect)> = RATIOS
            .into_iter()
            .map(|ratio| {
                (
                    format!("{}:{}", ratio.0, ratio.1),
                    current == Some(ratio),
                    fit_to_ratio(window, ratio, work_area),
                )
            })
            .collect();
        entries.extend(SIZES.into_iter().filter_map(|(name, width, height)| {
            fit_to_size(window, (width, height), scale, work_area).map(|frame| {
                (
                    format!("{name}  ·  {width} × {height}"),
                    recorded == (width, height),
                    frame,
                )
            })
        }));
        entries
    }

    fn active_window_logical(&self, cx: &App) -> Option<AreaRect> {
        self.select
            .read(cx)
            .active_window()
            .filter(|window| window.display_id == self.display_id)
            .map(|window| window.bounds.scaled(1. / self.capture_scale))
    }

    fn open_window_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(window) = self.active_window_logical(cx) else {
            return;
        };
        // The menu acts on this window until it closes, whatever the
        // pointer passes over on the way to a row.
        if let Some(active) = self.select.read(cx).active_window().cloned() {
            self.select
                .update(cx, |select, cx| select.set_pinned(active, cx));
        }
        let items: Vec<crate::ui::MenuItem> = self
            .window_menu_entries(window)
            .into_iter()
            .map(|(label, checked, _)| crate::ui::MenuItem::new(label, checked))
            .collect();
        self.mode_menu = None;
        self.countdown_menu = None;
        self.device_menu = None;
        self.aspect_menu = None;
        self.window_menu = Some(crate::ui::MenuState::new(position, &items));
        cx.notify();
    }

    fn render_window_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let state = self.window_menu.as_ref()?;
        let window = self.active_window_logical(cx)?;
        let items = self
            .window_menu_entries(window)
            .into_iter()
            .map(|(label, checked, _)| crate::ui::MenuItem::new(label, checked))
            .collect();
        Some(
            crate::ui::Menu::plain(&self.theme, "overlay-window-menu", items, state)
                .on_select(cx.listener(|this, index: &usize, _, cx| {
                    this.choose_window_size(*index, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _, cx| {
                    this.window_menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }

    pub(crate) fn choose_window_size(&mut self, index: usize, cx: &mut Context<Self>) {
        self.window_menu = None;
        let frame = self
            .active_window_logical(cx)
            .and_then(|window| self.window_menu_entries(window).into_iter().nth(index))
            .map(|(_, _, frame)| frame);
        match frame {
            Some(frame) => self.arrange_active_window(Arrangement::Frame(frame), false, cx),
            None => cx.notify(),
        }
    }

    pub(crate) fn set_focus(&mut self, focus: bool, cx: &mut Context<Self>) {
        self.select.update(cx, |select, cx| {
            select.focus_window = focus;
            cx.notify();
        });
        let style = if focus {
            crate::store::WindowCaptureStyle::FocusedWindow
        } else {
            crate::store::WindowCaptureStyle::ScreenRegion
        };
        if !crate::store::set_store_setting(
            crate::store::GENERAL_SETTINGS,
            "windowCaptureStyle",
            serde_json::Value::from(crate::store::SettingsEnum::as_json(style)),
        ) {
            tracing::warn!("could not save the window capture style");
        }
        let Some(window) = self.active_window_logical(cx) else {
            cx.notify();
            return;
        };
        if focus {
            if self.select.read(cx).focus_center {
                let centred = crate::window_arrange::centre(window, self.controls_work_area);
                self.arrange_active_window(Arrangement::Frame(centred), true, cx);
            } else {
                cx.notify();
            }
        } else {
            let original = self
                .select
                .read(cx)
                .active_window()
                .and_then(|active| self.select.read(cx).arranged_original(&active.id).cloned());
            match original {
                Some(original) => {
                    self.arrange_active_window(Arrangement::PutBack(original), false, cx)
                }
                None => cx.notify(),
            }
        }
    }

    pub(crate) fn set_focus_center(&mut self, center: bool, cx: &mut Context<Self>) {
        self.select.update(cx, |select, cx| {
            select.focus_center = center;
            cx.notify();
        });
        if !crate::store::set_store_setting(
            crate::store::GENERAL_SETTINGS,
            "focusCenter",
            serde_json::Value::Bool(center),
        ) {
            tracing::warn!("could not save Focus centering");
        }
        if !self.select.read(cx).focus_window {
            return;
        }
        let Some(window) = self.active_window_logical(cx) else {
            return;
        };
        if center {
            let centred = crate::window_arrange::centre(window, self.controls_work_area);
            self.arrange_active_window(Arrangement::Frame(centred), true, cx);
        } else {
            let original = self
                .select
                .read(cx)
                .active_window()
                .and_then(|active| self.select.read(cx).arranged_original(&active.id).cloned());
            if let Some(original) = original {
                self.arrange_active_window(Arrangement::PutBack(original), false, cx);
            }
        }
    }

    /// Move the picked window (`Frame` in this overlay's logical points, or
    /// back where the picker found it), then follow wherever its app
    /// actually put it.
    fn arrange_active_window(
        &mut self,
        arrangement: Arrangement,
        raise: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(window) = self.select.read(cx).active_window().cloned() else {
            return;
        };
        let from = self
            .window_drawn
            .get()
            .unwrap_or(window.bounds.scaled(1. / self.capture_scale));
        self.select.update(cx, |select, cx| {
            select.remember_arranged(&window);
            select.set_pinned(window.clone(), cx);
        });
        let capture_scale = self.capture_scale;
        let (id, display) = (window.id.clone(), window.display_id.clone());
        let before = window.bounds;
        let requested = id.clone();
        let select = self.select.clone();
        cx.spawn(async move |this, cx| {
            let moved = crate::foreign_window::in_order(move || {
                let arranged = match arrangement {
                    Arrangement::Frame(frame) => {
                        crate::foreign_window::arrange(&id, &display, frame.scaled(capture_scale))
                    }
                    Arrangement::PutBack(original) => crate::foreign_window::put_back(&original),
                };
                if raise {
                    crate::foreign_window::raise(&id);
                }
                // The window list lags the move by a few frames: wait for the
                // new frame to show up, or the camera would see no move.
                let read = || {
                    scap_targets::Window::from_id(&id)
                        .as_ref()
                        .and_then(HoveredWindow::from_window)
                };
                let mut fresh = read();
                let deadline = Instant::now() + Duration::from_millis(500);
                while arranged
                    && fresh.as_ref().is_some_and(|fresh| fresh.bounds == before)
                    && Instant::now() < deadline
                {
                    std::thread::sleep(Duration::from_millis(16));
                    fresh = read();
                }
                (arranged, fresh)
            })
            .await
            .unwrap_or((false, None));
            let (arranged, fresh) = moved;
            if !arranged {
                tracing::warn!("the picked window could not be arranged");
            }
            // Only while this picker is still up with the same window picked:
            // a slow move must not replace a newer choice.
            let still_picked = this
                .update(cx, |_, cx| {
                    select
                        .read(cx)
                        .active_window()
                        .is_some_and(|window| window.id == requested)
                })
                .unwrap_or(false);
            if !still_picked {
                return;
            }
            if let Some(fresh) = fresh {
                // The camera bubble rides along, as it does to a newly
                // picked window.
                cx.update(|cx| app_windows::carry_camera_with_window(&window, &fresh, cx));
                select.update(cx, |select, cx| select.set_pinned(fresh, cx));
            }
            this.update(cx, |this, cx| {
                this.window_reshape = Some((from, Instant::now()));
                this.retake_backdrop_soon(cx);
                cx.notify();
            })
            .ok();
            cx.update(app_windows::refresh_target_overlays);
        })
        .detach();
    }

    fn render_camera_variant(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let preview = if let Some(camera) = &self.inline_camera {
            let (width, height) = camera.read(cx).inline_size(self.display_size);
            div()
                .w(px(width))
                .h(px(height))
                .flex_none()
                .child(camera.clone())
                .into_any_element()
        } else {
            let (width, height) = crate::camera_window::inline_preview_size(
                &self.empty_camera_state,
                None,
                self.display_size,
            );
            div()
                .w(px(width))
                .h(px(height))
                .pt(px(crate::camera_window::CAMERA_TOOLBAR_HEIGHT))
                .child(
                    div()
                        .size_full()
                        .flex()
                        .flex_col()
                        .items_center()
                        .justify_center()
                        .gap(px(8.))
                        .rounded(px(crate::camera_window::preview_radius(
                            &self.empty_camera_state,
                        )))
                        .border_1()
                        .border_color(self.theme.gray_6)
                        .bg(gpui::black())
                        .text_size(px(14.))
                        .text_color(self.theme.gray_11)
                        .child(svg().path("icons/camera.svg").size(px(32.)))
                        .child(tr::overlay::camera_only::select_camera()),
                )
                .into_any_element()
        };
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
                            .child(tr::main::target::camera_only()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(self.theme.gray_11)
                            .child(tr::overlay::camera_only::description()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .justify_center()
                    .w_full()
                    .px(px(24.))
                    .mb(px(16.))
                    .child(preview),
            )
            .child(self.render_controls_cluster(self.target(cx), false, cx))
    }

    /// The crop overlay: `bg-black/45` outside the selection, a `border-white/50`
    /// region with eight handles, a size readout on top and the start cluster
    /// placed against the crop.
    fn render_area_variant(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        // Taken so the hint restarts whenever a render leaves it out, as a
        // gpui animation's element state would.
        let hint_started = self.selection_hint_started.take();
        let interacting = self.drag.is_some();
        // `shouldShowOverlay = isInteracting() || isActiveDisplay()`.
        let visible = self.recording_area || interacting || self.is_active_display(window, cx);
        let crop = self.crop;
        let shown = self.displayed_crop(window);
        let min = area_min_size(self.select.read(cx).recording_mode);
        let valid = crop.is_some_and(|crop| crop.is_valid_for(min));
        let interactive = !self.recording_area;
        let editable = interactive && !self.area_locked;
        if interactive && !self.area_windows_requested {
            self.load_area_windows(cx);
        }
        if std::mem::take(&mut self.area_camera_pending) {
            self.sync_area_camera(cx);
        }

        let mut root = div()
            .id("area-root")
            .size_full()
            .relative()
            .when(interactive, |this| {
                this.when(editable, |this| this.cursor(gpui::CursorStyle::Crosshair))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                            this.area_mouse_down(event.position, cx);
                        }),
                    )
                    .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                        this.area_hover_at(event.position, window, cx);
                        this.area_mouse_move(event.position, snap_off(&event.modifiers), cx);
                    }))
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseUpEvent, _window, cx| {
                            this.area_mouse_up(event.position, snap_off(&event.modifiers), cx);
                        }),
                    )
            });

        if !visible {
            // `classList={{ "opacity-0 pointer-events-none": !shouldShowOverlay() }}`
            return root.invisible();
        }

        // The occluder: four `bg-black/45` rectangles around the crop (one
        // full-screen rectangle while nothing is drawn).
        let dim: Hsla = gpui::hsla(0., 0., 0., 0.45);
        root = match shown {
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

        if let Some(shown) = shown {
            root = root.child(self.render_crop_region(shown, editable));
            if interactive && self.drag.is_some() {
                root = root
                    .child(render_thirds(shown))
                    .child(self.render_area_size(shown));
            }
            if interactive && self.area_locked {
                root = root.child(self.render_locked_badge(shown, cx));
            }
        }

        root = root.children(self.render_snap_guides());
        if self.recording_area {
            return root;
        }
        if crop.is_none() && !interacting {
            root = root.child(self.render_selection_hint(hint_started, window, cx));
        }
        root = root.child(self.render_area_toolbar(crop, valid, cx));
        if crop.is_some() {
            root.child(self.render_area_controls(shown, valid, cx))
        } else {
            root
        }
    }

    /// The zones carry only a cursor: the drag itself is dispatched from the
    /// root's mouse-down through [`Self::area_zone_at`], so a grab that starts
    /// a pixel outside the handle still resizes. The dark line outside the
    /// white border keeps the bounds visible over light content.
    fn render_crop_region(&self, crop: AreaRect, interactive: bool) -> impl IntoElement {
        let hover = self
            .area_hover
            .filter(|_| interactive && self.drag.is_none());
        let moving = matches!(self.drag, Some(AreaDrag::Move { .. }));
        let resizing = match self.drag {
            Some(AreaDrag::Resize { handle, .. }) => Some(handle),
            _ => None,
        };
        let mut region = div()
            .absolute()
            .left(px(crop.x))
            .top(px(crop.y))
            .w(px(crop.width))
            .h(px(crop.height))
            .border_2()
            .border_color(gpui::hsla(0., 0., 1., if interactive { 0.95 } else { 0.7 }))
            .when(hover == Some(AreaZone::Inside) || moving, |this| {
                this.bg(gpui::hsla(0., 0., 1., 0.06))
            })
            .when(interactive, |this| {
                this.cursor(if moving {
                    gpui::CursorStyle::ClosedHand
                } else {
                    gpui::CursorStyle::OpenHand
                })
            })
            .child(
                div()
                    .absolute()
                    .top(px(-3.))
                    .left(px(-3.))
                    .right(px(-3.))
                    .bottom(px(-3.))
                    .border_1()
                    .border_color(gpui::hsla(0., 0., 0., 0.45)),
            );

        if hover == Some(AreaZone::Inside) && crop.width >= 220. && crop.height >= 120. {
            region = region.child(
                div()
                    .absolute()
                    .inset_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .h(px(28.))
                            .px(px(10.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded_full()
                            .bg(gpui::hsla(0., 0., 0., 0.62))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui::white())
                            .child(
                                svg()
                                    .path("icons/move.svg")
                                    .size(px(13.))
                                    .text_color(gpui::white()),
                            )
                            .child(tr::overlay::area::drag_to_move()),
                    ),
            );
        }

        for handle in AreaHandle::ALL.into_iter().filter(|_| interactive) {
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

            // Edge grips are left off a side too short to hold one clear of
            // the corners.
            let hot = hover == Some(AreaZone::Handle(handle)) || resizing == Some(handle);
            let horizontal = handle.north() || handle.south();
            let side = if horizontal { crop.width } else { crop.height };
            let knob = if handle.is_corner() {
                let size = if hot { 18. } else { 14. };
                Some(div().size(px(size)))
            } else if side >= 80. {
                let (long, short) = if hot { (36., 10.) } else { (28., 8.) };
                let (width, height) = if horizontal {
                    (long, short)
                } else {
                    (short, long)
                };
                Some(div().w(px(width)).h(px(height)))
            } else {
                None
            };
            if let Some(knob) = knob {
                zone = zone.flex().items_center().justify_center().child(
                    knob.rounded_full()
                        .bg(gpui::white())
                        .border_1()
                        .border_color(gpui::hsla(0., 0., 0., 0.35))
                        .shadow_md(),
                );
            }

            region = region.child(zone);
        }

        region
    }

    fn render_snap_guides(&self) -> Vec<gpui::AnyElement> {
        self.snap_guides
            .iter()
            .map(|guide| {
                let color = gpui::rgb(0xFF3B6B);
                match guide.axis {
                    GuideAxis::V => div()
                        .absolute()
                        .left(px(guide.pos as f32 * self.display_size.0))
                        .top(px(guide.start as f32 * self.display_size.1))
                        .w(px(1.))
                        .h(px((guide.end - guide.start) as f32 * self.display_size.1))
                        .bg(color)
                        .into_any_element(),
                    GuideAxis::H => div()
                        .absolute()
                        .top(px(guide.pos as f32 * self.display_size.1))
                        .left(px(guide.start as f32 * self.display_size.0))
                        .h(px(1.))
                        .w(px((guide.end - guide.start) as f32 * self.display_size.0))
                        .bg(color)
                        .into_any_element(),
                }
            })
            .collect()
    }

    fn render_selection_hint(
        &mut self,
        started: Option<Instant>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let cursor_path = if cfg!(target_os = "windows") {
            "onboarding/cursor-windows.svg"
        } else {
            "onboarding/cursor-macos.svg"
        };
        let started = started.unwrap_or_else(Instant::now);
        self.selection_hint_started = Some(started);
        // Reduced motion holds the first frame, as gpui's animations do.
        let progress = if cx.reduce_motion() {
            0.
        } else {
            if self.selection_hint_redraw.is_none() {
                self.selection_hint_redraw = Some(cx.spawn_in(window, async move |this, cx| {
                    cx.background_executor().timer(SELECTION_HINT_FRAME).await;
                    this.update_in(cx, |this, window, cx| {
                        this.selection_hint_redraw = None;
                        repaint(window, cx);
                    })
                    .ok();
                }));
            }
            selection_hint_progress(started.elapsed())
        };
        let drag = selection_drag_progress(progress);
        let selection = div()
            .absolute()
            .left(px(41.))
            .top(px(26.))
            .border_1()
            .border_color(gpui::hsla(0., 0., 1., 0.82))
            .bg(linear_gradient(
                135.,
                linear_color_stop(gpui::hsla(0.55, 1., 0.72, 0.4), 0.),
                linear_color_stop(gpui::hsla(0.62, 1., 0.59, 0.2), 1.),
            ))
            .w(px(10. + 58. * drag))
            .h(px(8. + 44. * drag));
        let cursor = img(cursor_path)
            .absolute()
            .left(px(41. + 68. * drag))
            .top(px(26. + 52. * drag))
            .w(px(18.))
            .h(px(26.));
        let (scale, opacity) = if (0.1..0.12).contains(&progress) {
            (
                (progress - 0.1) / 0.02 * 0.2,
                (progress - 0.1) / 0.02 * 0.95,
            )
        } else if (0.12..0.18).contains(&progress) {
            (
                0.2 + (progress - 0.12) / 0.06 * 0.65,
                0.95 * (1. - (progress - 0.12) / 0.06),
            )
        } else {
            (0., 0.)
        };
        let size = 20. * scale;
        let click = div()
            .absolute()
            .rounded_full()
            .border_2()
            .border_color(gpui::hsla(0., 0., 1., 0.85))
            .left(px(41. + 68. * drag + 9. - size / 2.))
            .top(px(26. + 52. * drag + 14.3 - size / 2.))
            .size(px(size))
            .opacity(opacity);

        div()
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(20.))
                    .child(
                        div()
                            .relative()
                            .w(px(152.))
                            .h(px(104.))
                            .mb(px(24.))
                            .child(img("icons/monitor.svg").size_full())
                            .child(
                                div()
                                    .absolute()
                                    .left(px(4.5))
                                    .top(px(4.5))
                                    .w(px(143.))
                                    .h(px(94.5))
                                    .overflow_hidden()
                                    .child(selection)
                                    .child(click)
                                    .child(cursor),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .text_size(px(16.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(tr::overlay::area::hint()),
                            )
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(gpui::hsla(0., 0., 1., 0.72))
                                    .child(tr::overlay::area::fit_window_hint()),
                            ),
                    ),
            )
    }

    /// The floating readout: `top-12 left-1/2 -translate-x-1/2` over the
    /// liquid-glass surface, `min-w-28 px-2 text-base tabular-nums`, and the
    /// aspect-ratio control beside it. The reset, fill and lock controls that
    /// share this bar in the TSX are deferred (README).
    fn render_area_toolbar(
        &self,
        crop: Option<AreaRect>,
        valid: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        const WIDTH: f32 = 600.;
        let theme = self.theme;
        let locked = self.area_locked;
        let label = match crop.filter(|_| valid) {
            Some(crop) => format!("{} × {}", crop.width.round(), crop.height.round()),
            None => tr::overlay::area::draw().to_string(),
        };
        let divider = || div().h(px(24.)).w(px(1.)).flex_shrink_0().bg(theme.gray_5);
        let icon_button = |id: &'static str, icon: &'static str| {
            div()
                .id(id)
                .size(px(36.))
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(12.))
                .cursor_pointer()
                .group(id)
                .hover(move |style| style.bg(Theme::with_alpha(theme.gray_12, 0.08)))
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                // An svg takes its own text colour, not its parent's.
                .child(
                    svg()
                        .path(icon)
                        .size(px(16.))
                        .text_color(theme.gray_11)
                        .group_hover(id, move |style| style.text_color(theme.gray_12)),
                )
        };
        let in_more = self
            .area_ratio
            .is_some_and(|ratio| !QUICK_AREA_RATIOS.contains(&Some(ratio)));
        let chips = QUICK_AREA_RATIOS.iter().enumerate().map(|(index, ratio)| {
            let selected = self.area_ratio == *ratio;
            let ratio = *ratio;
            div()
                .id(("area-ratio", index))
                .h(px(32.))
                .px(px(8.))
                .flex()
                .items_center()
                .rounded(px(8.))
                .cursor_pointer()
                .text_size(px(12.))
                .font_weight(FontWeight::NORMAL)
                .when(selected, |chip| {
                    chip.bg(Theme::with_alpha(theme.gray_12, 0.12))
                        .text_color(theme.gray_12)
                })
                .when(!selected, |chip| {
                    chip.text_color(theme.gray_11)
                        .hover(move |style| style.bg(Theme::with_alpha(theme.gray_12, 0.08)))
                })
                .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .on_click(cx.listener(move |this, _, _, cx| this.set_area_ratio(ratio, cx)))
                .child(match ratio {
                    Some((width, height)) => format!("{width}:{height}"),
                    None => tr::overlay::area::free_ratio().to_string(),
                })
        });

        div()
            .absolute()
            // `top-12` on macOS, centred by hand: gpui has no translate.
            .top(px(48.))
            .left(px((self.display_size.0 - WIDTH) / 2.))
            .w(px(WIDTH))
            .flex()
            .justify_center()
            .child(
                self.glass_surface()
                    .occlude()
                    .h(px(48.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .p(px(6.))
                    .text_color(theme.gray_12)
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
                    )
                    .child(divider())
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(2.))
                            .p(px(2.))
                            .rounded(px(12.))
                            .bg(Theme::with_alpha(theme.gray_12, 0.06))
                            .children(chips),
                    )
                    .child(
                        self.hinted(
                            icon_button("area-ratio-more", "icons/ratio.svg")
                                .when(in_more, |button| {
                                    button.bg(Theme::with_alpha(theme.gray_12, 0.12))
                                })
                                .on_click(cx.listener(|this, event: &gpui::ClickEvent, _, cx| {
                                    cx.stop_propagation();
                                    this.open_aspect_menu(event.position(), cx);
                                })),
                            "area-ratio-more",
                            Hint::new(tr::overlay::area::more_ratios_title())
                                .body(tr::overlay::area::more_ratios_body()),
                            cx,
                        ),
                    )
                    .child(divider())
                    .child(
                        self.hinted(
                            icon_button("area-reset", "icons/rotate-ccw.svg")
                                .on_click(cx.listener(|this, _, _, cx| this.reset_area(cx))),
                            "area-reset",
                            Hint::new(tr::overlay::area::reset_title())
                                .body(tr::overlay::area::reset_body()),
                            cx,
                        ),
                    )
                    .child(
                        self.hinted(
                            icon_button("area-fill", "icons/maximize.svg")
                                .on_click(cx.listener(|this, _, _, cx| this.fill_area(cx))),
                            "area-fill",
                            Hint::new(tr::overlay::area::fill_title())
                                .body(tr::overlay::area::fill_body()),
                            cx,
                        ),
                    )
                    .child(divider())
                    .child(
                        self.hinted(
                            icon_button(
                                "area-lock",
                                if locked {
                                    "icons/lock.svg"
                                } else {
                                    "icons/lock-open.svg"
                                },
                            )
                            .when(locked, |button| {
                                button.bg(Theme::with_alpha(theme.gray_12, 0.12))
                            })
                            .when(!locked && !valid, |button| button.opacity(0.4))
                            .on_click(cx.listener(|this, _, _, cx| this.toggle_area_lock(cx))),
                            "area-lock",
                            if locked {
                                Hint::new(tr::overlay::area::unlock_title())
                                    .body(tr::overlay::area::unlock_body())
                            } else if valid {
                                Hint::new(tr::overlay::area::lock_title())
                                    .body(tr::overlay::area::lock_body())
                            } else {
                                Hint::new(tr::overlay::area::lock_title())
                                    .body(tr::overlay::area::lock_needs_area())
                            },
                            cx,
                        ),
                    ),
            )
    }

    fn render_area_size(&self, crop: AreaRect) -> impl IntoElement {
        const HEIGHT: f32 = 24.;
        const GAP: f32 = 8.;
        let label = format!("{} × {}", crop.width.round(), crop.height.round());
        let below = crop.bottom() + GAP + HEIGHT <= self.display_size.1;
        let top = if below {
            crop.bottom() + GAP
        } else {
            (crop.bottom() - GAP - HEIGHT).max(0.)
        };
        div()
            .absolute()
            .top(px(top))
            .right(px((self.display_size.0 - crop.right()).max(0.)))
            .h(px(HEIGHT))
            .px(px(8.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .bg(gpui::hsla(0., 0., 0., 0.72))
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(gpui::white())
            .child(label)
    }

    fn render_locked_badge(&self, crop: AreaRect, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .absolute()
            .left(px(crop.x + 8.))
            .top(px(crop.y + 8.))
            .child(
                self.hinted(
                    div()
                        .id("area-locked-badge")
                        .h(px(26.))
                        .px(px(9.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .rounded_full()
                        .cursor_pointer()
                        .bg(gpui::hsla(0., 0., 0., 0.62))
                        .hover(|style| style.bg(gpui::hsla(0., 0., 0., 0.78)))
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(gpui::white())
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_area_lock(cx)))
                        .child(
                            svg()
                                .path("icons/lock.svg")
                                .size(px(12.))
                                .text_color(gpui::white()),
                        )
                        .child(tr::overlay::area::locked()),
                    "area-locked-badge",
                    Hint::new(tr::overlay::area::locked_title())
                        .body(tr::overlay::area::locked_body()),
                    cx,
                ),
            )
    }

    /// Put the area back where the drag found it. False when nothing was
    /// being dragged, so Escape can go on to close the picker.
    pub fn cancel_area_drag(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(drag) = self.drag.take() else {
            return false;
        };
        self.crop = match drag {
            AreaDrag::Draw { previous, .. } => previous,
            AreaDrag::Move { start, .. } | AreaDrag::Resize { start, .. } => Some(start),
        };
        self.snap_guides.clear();
        self.sync_area_camera(cx);
        cx.notify();
        true
    }

    /// Only the display the saved lock belongs to clears it.
    fn unlock_area(&mut self) {
        self.area_locked = false;
        if stored_locked_area().is_some_and(|(display, _)| display == self.display_id.to_string()) {
            store_locked_area(None);
        }
    }

    fn toggle_area_lock(&mut self, cx: &mut Context<Self>) {
        if self.area_locked {
            self.unlock_area();
        } else {
            let min = area_min_size(self.select.read(cx).recording_mode);
            let Some(crop) = self.crop.filter(|crop| crop.is_valid_for(min)) else {
                return;
            };
            self.area_locked = true;
            self.drag = None;
            self.snap_guides.clear();
            store_locked_area(Some((&self.display_id, crop)));
            // One lock is saved: another display's lock is replaced.
            let display = self.display_id.clone();
            cx.defer(move |cx| app_windows::release_other_area_locks(&display, cx));
        }
        cx.notify();
    }

    pub fn release_area_lock(&mut self, cx: &mut Context<Self>) {
        if self.area_locked {
            self.area_locked = false;
            cx.notify();
        }
    }

    /// Keep a locked area's stored bounds in step with a toolbar change. Only
    /// the display the lock belongs to writes, so another display's overlay
    /// never takes the lock over.
    fn persist_locked_area(&self) {
        let Some(crop) = self.crop.filter(|_| self.area_locked) else {
            return;
        };
        if stored_locked_area().is_some_and(|(display, _)| display == self.display_id.to_string()) {
            store_locked_area(Some((&self.display_id, crop)));
        }
    }

    fn load_area_windows(&mut self, cx: &mut Context<Self>) {
        self.area_windows_requested = true;
        let display = self.display_id.clone();
        let scale = self.capture_scale;
        cx.spawn(async move |this, cx| {
            let windows = cx
                .background_executor()
                .spawn(async move {
                    crate::devices::list_window_targets()
                        .into_iter()
                        .filter_map(|(_, window)| HoveredWindow::from_window(&window))
                        .filter(|window| window.display_id == display)
                        .map(|window| window.bounds.scaled(1. / scale))
                        .collect::<Vec<_>>()
                })
                .await;
            this.update(cx, |this, _| {
                this.area_snap =
                    area_snap_rects(this.controls_work_area, &windows, this.display_size);
            })
            .ok();
        })
        .detach();
    }

    fn fit_area_to_window_at(&mut self, point: (f32, f32), cx: &mut Context<Self>) {
        // Looked up during the release, while the pointer is still where it
        // clicked: a lookup that ran later would find whatever window the
        // pointer had moved over since.
        let Some(window) = crate::devices::topmost_foreign_window_at_cursor()
            .as_ref()
            .and_then(HoveredWindow::from_window)
            .filter(|window| window.display_id == self.display_id)
        else {
            return;
        };
        let Some(mut bounds) = window
            .bounds
            .scaled(1. / self.capture_scale)
            .intersected(self.display_size)
        else {
            return;
        };
        if let Some(ratio) = self.area_ratio {
            bounds = area_with_ratio(bounds, ratio_value(ratio), self.display_size);
        }
        if !bounds.is_valid_for(area_min_size(self.select.read(cx).recording_mode)) {
            return;
        }
        self.crop = Some(AreaRect {
            x: point.0,
            y: point.1,
            width: 0.,
            height: 0.,
        });
        self.reshape_area(bounds, cx);
    }

    fn area_key(
        &mut self,
        keystroke: &gpui::Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.recording_area || self.select.read(cx).mode != Some(TargetType::Area) {
            return false;
        }
        let key = keystroke.key.as_str();
        if key == "escape" && self.cancel_area_drag(cx) {
            return true;
        }
        if key == "enter" && self.drag.is_none() && self.target(cx).is_some() {
            self.start_recording(window, cx);
            return true;
        }
        let step = if keystroke.modifiers.shift { 10. } else { 1. };
        let (dx, dy) = match key {
            "left" => (-step, 0.),
            "right" => (step, 0.),
            "up" => (0., -step),
            "down" => (0., step),
            _ => return false,
        };
        let Some(crop) = self
            .crop
            .filter(|_| !self.area_locked && self.drag.is_none())
        else {
            return false;
        };
        self.reshape = None;
        self.crop = Some(
            AreaRect {
                x: crop.x + dx,
                y: crop.y + dy,
                ..crop
            }
            .clamped(self.display_size),
        );
        self.sync_area_camera(cx);
        cx.notify();
        true
    }

    fn open_aspect_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let items = self.aspect_menu_items();
        self.mode_menu = None;
        self.countdown_menu = None;
        self.device_menu = None;
        self.window_menu = None;
        self.aspect_menu = Some(crate::ui::MenuState::new(position, &items));
        cx.notify();
    }

    fn aspect_menu_items(&self) -> Vec<crate::ui::MenuItem> {
        more_area_ratios()
            .into_iter()
            .map(|ratio| {
                crate::ui::MenuItem::new(
                    format!("{}:{}", ratio.0, ratio.1),
                    self.area_ratio == Some(ratio),
                )
            })
            .collect()
    }

    fn render_aspect_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let state = self.aspect_menu.as_ref()?;
        Some(
            crate::ui::Menu::plain(
                &self.theme,
                "overlay-aspect-menu",
                self.aspect_menu_items(),
                state,
            )
            .on_select(cx.listener(|this, index: &usize, _, cx| {
                this.choose_aspect(*index, cx);
            }))
            .on_dismiss(cx.listener(|this, _, _, cx| {
                this.aspect_menu = None;
                cx.notify();
            }))
            .into_any_element(),
        )
    }

    fn choose_aspect(&mut self, index: usize, cx: &mut Context<Self>) {
        self.aspect_menu = None;
        if let Some(ratio) = more_area_ratios().get(index) {
            self.set_area_ratio(Some(*ratio), cx);
        } else {
            cx.notify();
        }
    }

    fn displayed_crop(&mut self, window: &Window) -> Option<AreaRect> {
        let crop = self.crop?;
        let Some((from, started)) = self.reshape else {
            return Some(crop);
        };
        let t = started.elapsed().as_secs_f32() / AREA_RESHAPE.as_secs_f32();
        if t >= 1. {
            self.reshape = None;
            return Some(crop);
        }
        window.request_animation_frame();
        Some(area_between(from, crop, t))
    }

    fn reshape_area(&mut self, to: AreaRect, cx: &mut Context<Self>) {
        let from = match (self.crop, self.reshape) {
            (Some(crop), Some((from, started))) => area_between(
                from,
                crop,
                started.elapsed().as_secs_f32() / AREA_RESHAPE.as_secs_f32(),
            ),
            (Some(crop), None) => crop,
            (None, _) => area_fill(self.display_size, None),
        };
        self.reshape = Some((from, Instant::now()));
        self.crop = Some(to.clamped(self.display_size));
        self.persist_locked_area();
        self.sync_area_camera(cx);
        cx.notify();
    }

    fn fill_area(&mut self, cx: &mut Context<Self>) {
        let to = area_fill(self.display_size, self.area_ratio.map(ratio_value));
        self.reshape_area(to, cx);
    }

    fn reset_area(&mut self, cx: &mut Context<Self>) {
        if self.area_locked {
            self.unlock_area();
        }
        self.reshape = None;
        self.crop = None;
        self.sync_area_camera(cx);
        cx.notify();
    }

    /// Locks drawn and resized areas to `ratio`, reshaping the current one
    /// around its centre, and remembers the choice for the next picker.
    fn set_area_ratio(&mut self, ratio: Option<(u32, u32)>, cx: &mut Context<Self>) {
        self.area_ratio = ratio;
        store_area_ratio(ratio);
        if let (Some(ratio), Some(crop)) = (ratio, self.crop) {
            self.reshape_area(
                area_with_ratio(crop, ratio_value(ratio), self.display_size),
                cx,
            );
        } else {
            cx.notify();
        }
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
        let crop = crop.unwrap_or(AreaRect {
            x: 0.,
            y: 0.,
            width: 0.,
            height: 0.,
        });
        let min = area_min_size(self.select.read(cx).recording_mode);
        let available = self.controls_work_area.clamped(self.display_size);
        let cluster_height = CLUSTER_HEIGHT
            + if self.select.read(cx).recording_mode == Mode::Screenshot {
                0.
            } else {
                78.
            };
        let (x, y) = area_controls_position(crop, available, cluster_height);

        div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(CLUSTER_WIDTH))
            .flex()
            .flex_col()
            .items_center()
            .when(valid, |this| {
                this.child(self.render_controls_cluster(self.target(cx), false, cx))
            })
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
                        .child(tr::overlay::area::minimum_size(min as u32, min as u32))
                        .child(div().text_size(px(11.)).child(tr::overlay::area::too_small(
                            crop.width.round(),
                            crop.height.round(),
                        ))),
                )
            })
    }

    /// The picker's panels: Regular glass over the desktop beneath.
    fn glass_surface(&self) -> gpui::Div {
        crate::ui::glass::pane_over(
            crate::ui::glass::GlassKind::Regular,
            self.theme.is_dark(),
            16.,
            &self.backdrop,
        )
    }

    /// A round Clear glass button, for controls floating on a panel.
    fn glass_button(&self, size: f32) -> gpui::Div {
        crate::ui::glass::pane_over(
            crate::ui::glass::GlassKind::Clear,
            self.theme.is_dark(),
            size / 2.,
            &self.backdrop,
        )
        .size(px(size))
        .flex_shrink_0()
        .flex()
        .justify_center()
        .items_center()
    }

    /// A Clear glass capsule `height` tall, for the chips over a window.
    fn glass_capsule(&self, height: f32) -> gpui::Div {
        crate::ui::glass::pane_over(
            crate::ui::glass::GlassKind::Clear,
            self.theme.is_dark(),
            height / 2.,
            &self.backdrop,
        )
        .h(px(height))
    }

    /// `RecordingControls`: the close button, the gradient start pill with its
    /// mode line and caret, and the pre-recording settings button.
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
                            self.hinted(
                                self.glass_button(36.).id("overlay-countdown"),
                                "overlay-countdown",
                                Hint::new(tr::overlay::countdown_title())
                                    .body(tr::overlay::countdown_body()),
                                cx,
                            )
                            .child(
                                svg()
                                    .path("icons/gear.svg")
                                    .size(px(20.))
                                    .text_color(theme.gray_12),
                            )
                            .hover(|style| style.opacity(0.8))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                cx.stop_propagation();
                            })
                            .on_click(cx.listener(
                                |this, event: &gpui::ClickEvent, _, cx| {
                                    cx.stop_propagation();
                                    let current = crate::store::GeneralSettings::load()
                                        .recording_countdown
                                        .unwrap_or(0);
                                    let items = COUNTDOWN_OPTIONS
                                        .iter()
                                        .map(|(value, label)| {
                                            crate::ui::MenuItem::new(label(), *value == current)
                                        })
                                        .collect::<Vec<_>>();
                                    this.mode_menu = None;
                                    this.device_menu = None;
                                    this.aspect_menu = None;
                                    this.window_menu = None;
                                    this.countdown_menu =
                                        Some(crate::ui::MenuState::new(event.position(), &items));
                                    cx.notify();
                                },
                            )),
                        ),
                ),
            )
            .when(mode != Mode::Screenshot, |cluster| {
                cluster.child(
                    self.glass_surface().p(px(12.)).child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .w_full()
                            .child(self.render_device_control(true, cx))
                            .child(self.render_device_control(false, cx)),
                    ),
                )
            })
    }

    /// `size-9 rounded-full bg-gray-12` with the inverted X glyph.
    /// `element` with `hint` beside it while the pointer rests on it.
    fn hinted<E>(&self, element: E, id: &'static str, hint: Hint, cx: &mut Context<Self>) -> E
    where
        E: gpui::StatefulInteractiveElement + gpui::ParentElement,
    {
        element
            .child(self.hints.anchor(id, hint))
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                this.hints.hover(id, *hovered, cx, |this| &mut this.hints);
            }))
    }

    fn render_close_button(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        // Red-tinted glass, so cancelling reads apart from the controls.
        let tint = gpui::Rgba {
            a: 0.55,
            ..theme.red_9
        };
        crate::ui::glass::pane_over_tinted(
            crate::ui::glass::GlassKind::Clear,
            theme.is_dark(),
            18.,
            &self.backdrop,
            tint,
        )
        .size(px(36.))
        .flex_shrink_0()
        .flex()
        .justify_center()
        .items_center()
        .id("overlay-close")
        .hover(|style| style.opacity(0.8))
        .child(
            svg()
                .path("icons/x.svg")
                .size(px(12.))
                .text_color(gpui::white()),
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
        let needs_sign_in = self.needs_sign_in(mode, cx);
        let label = match mode {
            Mode::Screenshot => tr::overlay::start::take_screenshot(),
            _ if needs_sign_in => tr::overlay::start::sign_in(),
            _ => tr::overlay::start::start_recording(),
        };
        let icon = match mode {
            Mode::Instant if needs_sign_in => "icons/user-round.svg",
            Mode::Instant => "icons/instant.svg",
            Mode::Studio => "icons/film-cut.svg",
            Mode::Screenshot => "icons/camera.svg",
        };
        let mode_label = match mode {
            Mode::Instant if needs_sign_in => tr::overlay::start::instant_sign_in(),
            Mode::Instant => tr::overlay::start::instant(),
            Mode::Studio => tr::overlay::start::studio(),
            Mode::Screenshot => tr::main::mode::header::screenshot(),
        };
        let _ = target;

        div()
            .id("overlay-start")
            .relative()
            .child(self.hints.keep_clear("overlay-start"))
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
                    .id("overlay-start-action")
                    .flex()
                    .flex_1()
                    .items_center()
                    .py(px(4.))
                    .pl(px(16.))
                    .min_w_0()
                    // The pill's `overflow-hidden rounded-full` clips these
                    // fills in the Tauri app; gpui masks are rectangles, so
                    // the halves round their own outer caps (h-11 -> 22px) or
                    // they paint square corners past the pill onto the glass
                    // card behind it.
                    .rounded_l(px(22.))
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
                                    .truncate()
                                    .child(label),
                            )
                            .child(
                                div()
                                    .mt(px(-2.))
                                    .text_size(px(11.))
                                    .whitespace_nowrap()
                                    .truncate()
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
                // `pl-2.5 pr-3 py-1.5 border-l border-white/20 bg-white/5`,
                // `onMouseDown/onClick={showMenu(menuModes(), e)}`: the caret
                // pops the mode menu at the press location and must never arm
                // the pill's start click -- gpui arms clicks on mouse-down per
                // hitbox, so the stop has to happen here, not on a click
                // handler. Active even while start is disabled, same as the
                // source (the disabled styling only wraps the leading half).
                self.hinted(
                    div().id("overlay-mode-picker"),
                    "overlay-mode-picker",
                    Hint::new(tr::overlay::mode_title()).body(tr::overlay::mode_body()),
                    cx,
                )
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                        cx.stop_propagation();
                        if crate::session::RecordingSession::global(cx)
                            .read(cx)
                            .editor_recording_target()
                            .is_some()
                        {
                            return;
                        }
                        let current = this.select.read(cx).recording_mode;
                        this.device_menu = None;
                        this.countdown_menu = None;
                        this.aspect_menu = None;
                        this.window_menu = None;
                        this.mode_menu = Some(crate::ui::MenuState::new(
                            event.position,
                            &mode_menu_items(current),
                        ));
                        cx.notify();
                    }),
                )
                .flex()
                .items_center()
                .pl(px(10.))
                .pr(px(12.))
                .py(px(6.))
                // The right cap of the pill, for the same reason the
                // leading half takes `rounded_l`: its `bg-white/5` panel
                // otherwise pokes square corners past `rounded-full`.
                .rounded_r(px(22.))
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AreaZone {
    Handle(AreaHandle),
    Inside,
}

impl OverlayWindow {
    fn area_hover_at(
        &mut self,
        position: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let hover = (self.drag.is_none() && !self.area_locked && !self.recording_area)
            .then(|| self.area_zone_at((f32::from(position.x), f32::from(position.y))))
            .flatten();
        if hover != self.area_hover {
            self.area_hover = hover;
            repaint(window, cx);
        }
    }

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
        if self.recording_area {
            return;
        }
        if self.area_locked {
            self.aspect_menu = None;
            cx.notify();
            return;
        }
        let point = (f32::from(position.x), f32::from(position.y));
        self.snap_guides.clear();
        // Mid-reshape, `crop` is where the selection is going, not where it
        // is drawn; a grab has to land on what the user sees.
        if let (Some(crop), Some((from, started))) = (self.crop, self.reshape.take()) {
            self.crop = Some(area_between(
                from,
                crop,
                started.elapsed().as_secs_f32() / AREA_RESHAPE.as_secs_f32(),
            ));
        }
        self.aspect_menu = None;

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
                let previous = self.crop.replace(AreaRect {
                    x: point.0,
                    y: point.1,
                    width: 0.,
                    height: 0.,
                });
                Some(AreaDrag::Draw {
                    anchor: point,
                    previous,
                })
            }
        };
        self.sync_area_camera(cx);
        cx.notify();
    }

    fn area_mouse_move(&mut self, position: Point<Pixels>, free: bool, cx: &mut Context<Self>) {
        if self.recording_area {
            return;
        }
        let Some(drag) = &self.drag else { return };
        let x = f32::from(position.x).clamp(0., self.display_size.0);
        let y = f32::from(position.y).clamp(0., self.display_size.1);

        let ratio = self.area_ratio.map(ratio_value);
        let (next, guides) = match (drag, ratio) {
            (AreaDrag::Draw { anchor, .. }, Some(ratio)) => (
                area_from_anchor_with_ratio(*anchor, (x, y), ratio, self.display_size),
                Vec::new(),
            ),
            (AreaDrag::Resize { handle, start }, Some(ratio)) => (
                if handle.east() != handle.west() && handle.north() != handle.south() {
                    let anchor = (
                        if handle.west() {
                            start.right()
                        } else {
                            start.x
                        },
                        if handle.north() {
                            start.bottom()
                        } else {
                            start.y
                        },
                    );
                    area_from_anchor_with_ratio(anchor, (x, y), ratio, self.display_size)
                } else {
                    area_edge_resize_with_ratio(*handle, *start, (x, y), ratio, self.display_size)
                },
                Vec::new(),
            ),
            (AreaDrag::Draw { anchor, .. }, None) => {
                let ((x, y), guides) = if free {
                    ((x, y), Vec::new())
                } else {
                    snap_area_point((x, y), self.display_size, &self.area_snap)
                };
                (
                    AreaRect {
                        x: anchor.0.min(x),
                        y: anchor.1.min(y),
                        width: (x - anchor.0).abs(),
                        height: (y - anchor.1).abs(),
                    },
                    guides,
                )
            }
            (AreaDrag::Move { grab, start }, _) => {
                let moved = AreaRect {
                    x: start.x + (x - grab.0),
                    y: start.y + (y - grab.1),
                    ..*start
                };
                if free {
                    (moved.clamped(self.display_size), Vec::new())
                } else {
                    snap_area_rect(moved, self.display_size, &self.area_snap)
                }
            }
            (AreaDrag::Resize { handle, start }, None) => {
                let ((x, y), guides) = if free {
                    ((x, y), Vec::new())
                } else {
                    snap_resize_point(
                        (x, y),
                        self.display_size,
                        &self.area_snap,
                        handle.east() || handle.west(),
                        handle.north() || handle.south(),
                    )
                };
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
                (
                    AreaRect {
                        x: left.min(right),
                        y: top.min(bottom),
                        width: (right - left).abs(),
                        height: (bottom - top).abs(),
                    },
                    guides,
                )
            }
        };

        self.crop = Some(next);
        self.snap_guides = guides;
        // Mouse events outrun the display: the camera follows on the next
        // frame, once, rather than once per event.
        self.area_camera_pending = true;
        cx.notify();
    }

    fn area_mouse_up(&mut self, position: Point<Pixels>, free: bool, cx: &mut Context<Self>) {
        if self.recording_area {
            return;
        }
        self.area_mouse_move(position, free, cx);
        let Some(drag) = self.drag.take() else {
            return;
        };
        self.snap_guides.clear();
        // Measured from the pointer, not the crop: snapping can stretch a
        // stationary click into a few points of selection.
        let clicked = match drag {
            AreaDrag::Draw { anchor, .. } => {
                (f32::from(position.x) - anchor.0).abs() < 3.
                    && (f32::from(position.y) - anchor.1).abs() < 3.
            }
            _ => false,
        };
        if let Some(crop) = self.crop {
            // A click with no drag is not a selection: it fits the area to
            // the window under it instead.
            if clicked || crop.width < 2. || crop.height < 2. {
                self.crop = None;
                if clicked {
                    self.fit_area_to_window_at((f32::from(position.x), f32::from(position.y)), cx);
                }
            } else {
                self.crop = Some(crop.clamped(self.display_size));
            }
        }
        self.sync_area_camera(cx);
        // Releasing a fresh draw in screenshot mode captures immediately --
        // the screenshot area picker has no confirm step
        // (`target-select-overlay.tsx`'s area mouse-up). Move/resize grabs
        // keep the crop for the Start button, same as recording mode.
        // A click fitted to a window waits for the button instead, so a stray
        // click never takes a screenshot.
        if matches!(drag, AreaDrag::Draw { .. })
            && !clicked
            && self.select.read(cx).recording_mode == Mode::Screenshot
            && let Some(target) = self.target(cx)
        {
            cx.defer(move |cx: &mut App| crate::screenshot::take_screenshot(target, cx));
        }
        cx.notify();
    }
}

/// Ask for camera/mic access from the overlay. The macOS prompt floats above
/// the overlays, but System Settings is an ordinary window they would cover,
/// so a denied permission steps the picker aside before opening the pane.
fn request_media_access(permission: crate::permissions::OSPermission, cx: &mut App) {
    let access = crate::media_access::MediaAccess::global(cx);
    if access.read(cx).allowed(permission) {
        return;
    }
    let denied =
        access.read(cx).status(permission) == crate::permissions::OSPermissionStatus::Denied;
    if denied {
        cx.defer(move |cx| {
            app_windows::dismiss_target_overlays(cx);
            crate::media_access::MediaAccess::global(cx)
                .update(cx, |access, cx| access.request(permission, cx));
        });
    } else {
        access.update(cx, |access, cx| access.request(permission, cx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_display_and_window_pickers_take_no_backdrop() {
        assert!(!backdrop_suits(None));
        assert!(backdrop_suits(Some(TargetType::Area)));
        assert!(backdrop_suits(Some(TargetType::CameraOnly)));
        assert_eq!(backdrop_suits(Some(TargetType::Display)), !cfg!(windows));
        assert_eq!(backdrop_suits(Some(TargetType::Window)), !cfg!(windows));
    }

    fn ratio_of(area: AreaRect) -> f32 {
        area.width / area.height
    }

    fn inside(area: AreaRect, display: (f32, f32)) -> bool {
        area.x >= -0.01
            && area.y >= -0.01
            && area.right() <= display.0 + 0.01
            && area.bottom() <= display.1 + 0.01
    }

    /// A 0.6.1 report: the 0.6.0 picker could hold an area at 16:9, and the
    /// new one could not. Drawing with a ratio keeps it from any direction.
    #[test]
    fn a_drawn_area_keeps_the_chosen_aspect_ratio() {
        let display = (1920., 1080.);
        let ratio = ratio_value((16, 9));
        for pointer in [(900., 300.), (100., 900.), (1500., 1000.), (120., 140.)] {
            let area = area_from_anchor_with_ratio((800., 500.), pointer, ratio, display);
            assert!(
                (ratio_of(area) - ratio).abs() < 0.001,
                "{pointer:?}: {area:?}"
            );
            assert!(inside(area, display), "{pointer:?}: {area:?}");
        }
        // The longer span wins: a wide drag sets the width.
        let wide = area_from_anchor_with_ratio((100., 100.), (900., 300.), ratio, display);
        assert_eq!((wide.x, wide.y, wide.width), (100., 100., 800.));
        assert!((wide.height - 450.).abs() < 0.01);
        // A drag that would leave the display shrinks to fit instead.
        let edge = area_from_anchor_with_ratio((1800., 100.), (1900., 1000.), ratio, display);
        assert!(inside(edge, display) && (ratio_of(edge) - ratio).abs() < 0.001);
    }

    #[test]
    fn resizing_an_area_keeps_the_chosen_aspect_ratio() {
        let display = (1920., 1080.);
        let ratio = ratio_value((1, 1));
        let start = AreaRect {
            x: 400.,
            y: 300.,
            width: 400.,
            height: 400.,
        };
        for handle in AreaHandle::ALL {
            for pointer in [(1000., 900.), (100., 50.), (650., 520.)] {
                let area = if handle.east() != handle.west() && handle.north() != handle.south() {
                    let anchor = (
                        if handle.west() {
                            start.right()
                        } else {
                            start.x
                        },
                        if handle.north() {
                            start.bottom()
                        } else {
                            start.y
                        },
                    );
                    area_from_anchor_with_ratio(anchor, pointer, ratio, display)
                } else {
                    area_edge_resize_with_ratio(handle, start, pointer, ratio, display)
                };
                assert!(
                    area.height == 0. || (ratio_of(area) - ratio).abs() < 0.001,
                    "{handle:?} {pointer:?}: {area:?}"
                );
                assert!(inside(area, display), "{handle:?} {pointer:?}: {area:?}");
            }
        }
        // An east edge drag keeps the west edge and the centre line.
        let east =
            area_edge_resize_with_ratio(AreaHandle::East, start, (1000., 0.), ratio, display);
        assert_eq!((east.x, east.width), (400., 600.));
        assert_eq!(east.y + east.height / 2., 500.);
        // Past the opposite edge, the selection follows the pointer over it.
        let crossed =
            area_edge_resize_with_ratio(AreaHandle::East, start, (300., 0.), ratio, display);
        assert_eq!((crossed.x, crossed.width), (300., 100.));
        let crossed =
            area_edge_resize_with_ratio(AreaHandle::South, start, (0., 200.), ratio, display);
        assert_eq!((crossed.y, crossed.height), (200., 100.));
        let crossed =
            area_edge_resize_with_ratio(AreaHandle::West, start, (900., 0.), ratio, display);
        assert_eq!((crossed.x, crossed.width), (800., 100.));
    }

    #[test]
    fn quick_and_more_ratios_cover_every_ratio_once() {
        let more = more_area_ratios();
        assert_eq!(more, vec![(16, 10), (21, 9), (3, 2), (2, 1)]);
        let mut all: Vec<Option<(u32, u32)>> = QUICK_AREA_RATIOS.to_vec();
        all.extend(more.into_iter().map(Some));
        all.sort();
        let mut expected = AREA_RATIOS.to_vec();
        expected.sort();
        assert_eq!(all, expected);
    }

    #[test]
    fn fill_takes_the_display_or_the_largest_centred_area_of_the_ratio() {
        let display = (1512., 982.);
        let free = area_fill(display, None);
        assert_eq!(
            (free.x, free.y, free.width, free.height),
            (0., 0., 1512., 982.)
        );
        let wide = area_fill(display, Some(16. / 9.));
        assert_eq!((wide.x, wide.width), (0., 1512.));
        assert!((wide.height - 850.5).abs() < 0.01);
        assert!((wide.y - (982. - wide.height) / 2.).abs() < 0.01);
        let tall = area_fill(display, Some(9. / 16.));
        assert_eq!((tall.y, tall.height), (0., 982.));
        assert!((tall.width - 552.375).abs() < 0.01);
        assert!((tall.x - (1512. - tall.width) / 2.).abs() < 0.01);
    }

    #[test]
    fn a_reshape_starts_and_ends_exactly_and_moves_monotonically() {
        let from = rect(10., 20., 300., 200.);
        let to = rect(100., 50., 640., 360.);
        assert_eq!(area_between(from, to, 0.), from);
        assert_eq!(area_between(from, to, 1.), to);
        assert_eq!(area_between(from, to, 3.), to);
        let mut previous = from.width;
        for step in 1..=20 {
            let width = area_between(from, to, step as f32 / 20.).width;
            assert!(width >= previous);
            previous = width;
        }
        assert!(area_between(from, to, 0.5).width > (from.width + to.width) / 2.);
    }

    #[test]
    fn choosing_a_ratio_reshapes_the_area_around_its_centre() {
        let display = (1920., 1080.);
        let area = area_with_ratio(
            AreaRect {
                x: 100.,
                y: 300.,
                width: 800.,
                height: 200.,
            },
            ratio_value((16, 9)),
            display,
        );
        assert_eq!((area.x, area.width), (100., 800.));
        assert!((area.height - 450.).abs() < 0.01);
        assert!((area.y + area.height / 2. - 400.).abs() < 0.01);
        assert!(inside(area, display));
    }

    #[test]
    fn a_single_overlay_remains_interactive_without_a_global_cursor_probe() {
        let display = "1".parse::<DisplayId>().unwrap();
        let other = "2".parse::<DisplayId>().unwrap();
        assert!(overlay_display_is_active(None, &display, true, false));
        assert!(!overlay_display_is_active(None, &display, false, false));
        assert!(overlay_display_is_active(
            Some(&display),
            &display,
            false,
            false
        ));
        assert!(!overlay_display_is_active(
            Some(&other),
            &display,
            true,
            false
        ));
    }

    #[test]
    fn native_window_hover_activates_the_correct_overlay_without_global_coordinates() {
        let display = "1".parse::<DisplayId>().unwrap();
        let other = "2".parse::<DisplayId>().unwrap();
        assert!(overlay_display_is_active(None, &display, false, true));
        assert!(!overlay_display_is_active(None, &display, false, false));
        assert!(!overlay_display_is_active(
            Some(&other),
            &display,
            false,
            true
        ));
    }

    #[test]
    fn area_controls_stay_above_the_dock_on_a_small_display() {
        let available = rect(0., 25., 1024., 684.);
        let height = CLUSTER_HEIGHT + 78.;
        let (x, y) = area_controls_position(rect(202., 216., 641., 361.), available, height);
        assert!(x >= available.x && x + CLUSTER_WIDTH <= available.right());
        assert!(y >= available.y && y + height <= available.bottom());
        assert!(y < 577.);
    }

    #[test]
    fn area_controls_respect_side_taskbars_and_bottom_edge_crops() {
        let available = rect(64., 24., 736., 416.);
        for crop in [rect(0., 0., 800., 480.), rect(600., 350., 180., 120.)] {
            let (x, y) = area_controls_position(crop, available, CLUSTER_HEIGHT + 78.);
            assert!(x >= available.x && x + CLUSTER_WIDTH <= available.right());
            assert!(y >= available.y && y + CLUSTER_HEIGHT + 78. <= available.bottom());
        }
    }

    #[test]
    fn area_controls_keep_available_space_below_or_above_a_crop() {
        let available = rect(0., 0., 1280., 800.);
        assert_eq!(
            area_controls_position(rect(100., 100., 640., 360.), available, 166.).1,
            476.
        );
        assert_eq!(
            area_controls_position(rect(100., 500., 640., 240.), available, 166.).1,
            318.
        );
    }

    #[test]
    fn compositor_viewport_replaces_placeholder_size_and_clamps_the_selection() {
        let viewport = overlay_viewport_size((1024., 768.), (1920., 1080.));
        assert_eq!(viewport, (1024., 768.));
        let crop = rect(700., 400., 640., 480.).clamped(viewport);
        assert!(crop.x >= 0. && crop.y >= 0.);
        assert!(crop.right() <= 1024. && crop.bottom() <= 768.);
        assert_eq!(overlay_viewport_size((0., 0.), viewport), viewport);
        assert_eq!(overlay_viewport_size((f32::NAN, 768.), viewport), viewport);
        assert_eq!(
            overlay_viewport_size((1024., f32::INFINITY), viewport),
            viewport
        );
    }

    #[test]
    fn mode_menu_matches_menu_modes() {
        // `menuModes` order (`target-select-overlay.tsx:2064-2090`) with the
        // check on the current mode.
        let items = mode_menu_items(Mode::Instant);
        assert_eq!(
            items
                .iter()
                .map(|item| (item.label.to_string(), item.checked))
                .collect::<Vec<_>>(),
            vec![
                ("Studio Mode".to_string(), false),
                ("Instant Mode".to_string(), true),
                ("Screenshot Mode".to_string(), false),
            ],
        );
        assert_eq!(MODE_MENU[2].1, Mode::Screenshot);
    }

    #[test]
    fn required_window_titles_match_exactly_or_fail_closed() {
        assert!(required_window_title_matches(None, None));
        assert!(required_window_title_matches(None, Some("Other window")));
        assert!(required_window_title_matches(
            Some("Synthetic target"),
            Some("Synthetic target")
        ));
        assert!(!required_window_title_matches(
            Some("Synthetic target"),
            Some("Synthetic target - private window")
        ));
        assert!(!required_window_title_matches(
            Some("Synthetic target"),
            Some("Private window")
        ));
        assert!(!required_window_title_matches(
            Some("Synthetic target"),
            None
        ));
    }

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

    #[test]
    fn scaled_overlay_selections_preserve_the_physical_capture_region() {
        let capture = rect(300., 240., 900., 600.);
        for (scale, expected) in [
            (1., rect(300., 240., 900., 600.)),
            (1.5, rect(200., 160., 600., 400.)),
            (2., rect(150., 120., 450., 300.)),
        ] {
            let overlay = capture.scaled(1. / scale);
            assert_eq!(overlay, expected);
            let bounds = overlay.scaled(scale).to_bounds();
            assert_eq!(bounds.position().x(), 300.);
            assert_eq!(bounds.position().y(), 240.);
            assert_eq!(bounds.size().width(), 900.);
            assert_eq!(bounds.size().height(), 600.);
        }
    }

    #[test]
    fn moving_area_snaps_to_display_centres_and_edges() {
        let display = (1000., 800.);
        let (centered, center_guides) = snap_area_rect(rect(446., 180., 100., 120.), display, &[]);
        assert_eq!(centered, rect(450., 180., 100., 120.));
        assert!(
            center_guides
                .iter()
                .any(|guide| guide.axis == GuideAxis::V && guide.pos == 0.5)
        );

        let (edge, edge_guides) = snap_area_rect(rect(894., 180., 100., 120.), display, &[]);
        assert_eq!(edge, rect(900., 180., 100., 120.));
        assert!(
            edge_guides
                .iter()
                .any(|guide| guide.axis == GuideAxis::V && guide.pos == 1.)
        );
    }

    #[test]
    fn drawing_endpoint_snaps_per_axis_within_seven_pixels() {
        let display = (1000., 800.);
        let (snapped, guides) = snap_area_point((496., 404.), display, &[]);
        assert_eq!(snapped, (500., 400.));
        assert!(
            guides
                .iter()
                .any(|guide| guide.axis == GuideAxis::V && guide.pos == 0.5)
        );
        assert!(
            guides
                .iter()
                .any(|guide| guide.axis == GuideAxis::H && guide.pos == 0.5)
        );

        let (unsnapped, guides) = snap_area_point((490., 390.), display, &[]);
        assert_eq!(unsnapped, (490., 390.));
        assert!(guides.is_empty());
    }

    #[test]
    fn only_an_overlay_drawing_the_meter_repaints_for_the_level() {
        assert!(!overlay_meter_moved(None, 0.8, 2.));
        assert!(overlay_meter_moved(Some(0.), 0.8, 2.));
        assert!(overlay_meter_moved(
            Some(0.5),
            0.5 + 1. / (CLUSTER_WIDTH * 2.),
            2.
        ));
        assert!(!overlay_meter_moved(
            Some(0.5),
            0.5 + 0.4 / (CLUSTER_WIDTH * 2.),
            2.
        ));
        assert!(!overlay_meter_moved(Some(0.), 0., 1.));
    }

    #[test]
    fn selection_hint_progress_repeats_like_a_gpui_animation() {
        let at = |ms| selection_hint_progress(Duration::from_millis(ms));
        assert_eq!(at(0), 0.);
        assert!((at(1400) - 0.5).abs() < 1e-4);
        assert!((at(2800 + 700) - 0.25).abs() < 1e-4);
        assert!((at(5 * 2800 + 1400) - 0.5).abs() < 1e-3);
        assert!(at(2799) < 1.);
    }

    #[test]
    fn selection_hint_paces_to_thirty_frames_a_second() {
        let frames = SELECTION_HINT_CYCLE.as_secs_f32() / SELECTION_HINT_FRAME.as_secs_f32();
        assert!((83.9..84.1).contains(&frames), "{frames}");
        // The click ring (`0.1..0.18` of the cycle) still gets several frames.
        let ring = 0.08 * SELECTION_HINT_CYCLE.as_secs_f32() / SELECTION_HINT_FRAME.as_secs_f32();
        assert!(ring >= 6., "{ring}");
    }

    #[test]
    fn selection_hint_curve_reaches_both_drag_extents() {
        assert_eq!(selection_drag_progress(0.), 0.);
        assert!((selection_drag_progress(0.5) - 1.).abs() < 0.001);
        assert_eq!(selection_drag_progress(1.), 0.);
    }

    #[test]
    fn an_area_snaps_to_windows_and_the_work_area() {
        let display = (1000., 800.);
        let window = AreaRect {
            x: 200.,
            y: 150.,
            width: 400.,
            height: 300.,
        };
        let work_area = AreaRect {
            x: 0.,
            y: 25.,
            width: 1000.,
            height: 700.,
        };
        let others = area_snap_rects(work_area, &[window], display);

        // A moving area's left edge 4 points off the window's lands on it.
        let (moved, guides) = snap_area_rect(
            AreaRect {
                x: 204.,
                y: 500.,
                width: 120.,
                height: 90.,
            },
            display,
            &others,
        );
        assert_eq!(moved.x, 200.);
        assert!(guides.iter().any(|guide| guide.axis == GuideAxis::V));

        // The dock's edge (the work area's bottom) catches a drawn corner.
        let ((_, y), _) = snap_area_point((700., 722.), display, &others);
        assert_eq!(y, 725.);
    }

    #[test]
    fn an_edge_handle_snaps_only_its_own_axis() {
        let display = (1000., 800.);
        let others = area_snap_rects(
            AreaRect {
                x: 0.,
                y: 0.,
                width: 1000.,
                height: 800.,
            },
            &[AreaRect {
                x: 300.,
                y: 300.,
                width: 200.,
                height: 200.,
            }],
            display,
        );
        // Near both the window's left edge and its top: an east/west handle
        // takes the x snap and leaves y alone.
        let ((x, y), guides) = snap_resize_point((303., 297.), display, &others, true, false);
        assert_eq!((x, y), (300., 297.));
        assert!(guides.iter().all(|guide| guide.axis == GuideAxis::V));
    }

    #[test]
    fn snap_rects_drop_tiny_whole_display_and_off_screen_windows() {
        let display = (1000., 800.);
        let whole = AreaRect {
            x: 0.,
            y: 0.,
            width: 1000.,
            height: 800.,
        };
        let windows = [
            // A badge.
            AreaRect {
                x: 10.,
                y: 10.,
                width: 20.,
                height: 20.,
            },
            // Fullscreen.
            whole,
            // On another display.
            AreaRect {
                x: 1200.,
                y: 0.,
                width: 400.,
                height: 400.,
            },
            // Half on this display: kept, cut to it.
            AreaRect {
                x: 800.,
                y: 100.,
                width: 400.,
                height: 300.,
            },
        ];
        let rects = area_snap_rects(whole, &windows, display);
        assert_eq!(rects.len(), 1);
        assert!((rects[0].x - 0.8).abs() < 1e-6);
        assert!((rects[0].w - 0.2).abs() < 1e-6);
    }
}
