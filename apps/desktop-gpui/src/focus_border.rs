//! The Focus ring: a soft outline just outside the window Focus records.
//!
//! The picker draws it around the picked window while Focus is on, and a
//! recording keeps it up in a window of its own: a transparent panel over the
//! recorded window's display that ignores the mouse and stays out of
//! captures, following the window if it moves. It marks which window is
//! being recorded without sitting on any of its pixels.

use std::time::Duration;

use gpui::{
    App, AppContext as _, Context, Global, IntoElement, ParentElement as _, Render, Styled as _,
    Task, Window, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, point, px, size,
};
use scap_targets::{DisplayId, WindowId};

use crate::{
    platform,
    target_overlay::{AreaRect, HoveredWindow},
    theme::Theme,
};

/// Recording keeps the ring up only where its window can let clicks through
/// to the app being recorded. Windows and X11 still need that, so there the
/// ring shows in the picker alone.
pub const SUPPORTED: bool = cfg!(target_os = "macos");

/// How far outside the window the ring sits, so it never covers the window.
const OUTSET: f32 = 4.;
const WIDTH: f32 = 2.;
/// How often a recording rereads where its window is.
const FOLLOW: Duration = Duration::from_millis(120);

/// The corner radius of other apps' windows, which the ring follows.
const WINDOW_RADIUS: f32 = if cfg!(target_os = "macos") {
    16.
} else if cfg!(windows) {
    8.
} else {
    10.
};

/// The ring around `window`, positioned in the same space as `window`: a
/// crisp line with two fainter ones outside it for a glow. Borders only, since
/// gpui paints a box shadow under the whole element and would tint the window.
pub fn ring(window: AreaRect, theme: &Theme) -> impl IntoElement {
    let color = gpui::Hsla::from(theme.blue_9);
    let band = |outset: f32, alpha: f32| {
        div()
            .absolute()
            .left(px(window.x - outset))
            .top(px(window.y - outset))
            .w(px(window.width + 2. * outset))
            .h(px(window.height + 2. * outset))
            .rounded(px(WINDOW_RADIUS + outset))
            .border(px(WIDTH))
            .border_color(color.opacity(alpha))
    };
    div()
        .absolute()
        .size_full()
        .child(band(OUTSET + 2. * WIDTH, 0.1))
        .child(band(OUTSET + WIDTH, 0.28))
        .child(band(OUTSET, 0.9))
}

struct FocusBorderWindow(WindowHandle<FocusBorder>);
impl Global for FocusBorderWindow {}

pub struct FocusBorder {
    window: WindowId,
    display: DisplayId,
    bounds: Option<AreaRect>,
    theme: Theme,
    _follow: Task<()>,
}

impl FocusBorder {
    fn new(target: HoveredWindow, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let follow = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(FOLLOW).await;
                let Ok(id) = this.read_with(cx, |this, _| this.window.clone()) else {
                    return;
                };
                let lookup = id.clone();
                let found = cx
                    .background_executor()
                    .spawn(async move {
                        scap_targets::Window::from_id(&lookup)
                            .as_ref()
                            .and_then(HoveredWindow::from_window)
                    })
                    .await;
                let updated = this.update(cx, |this, cx| {
                    if found
                        .as_ref()
                        .is_some_and(|found| found.display_id != this.display)
                    {
                        return true;
                    }
                    let bounds = found.map(|found| found.bounds);
                    if this.bounds != bounds {
                        this.bounds = bounds;
                        cx.notify();
                    }
                    false
                });
                match updated {
                    Ok(false) => {}
                    // The window went to another display: the ring's panel
                    // covers one display, so a new one opens over the other.
                    Ok(true) => {
                        cx.update(|cx| cx.defer(move |cx| reopen(&id, cx)));
                        return;
                    }
                    Err(_) => return,
                }
            }
        });
        Self {
            window: target.id,
            display: target.display_id,
            bounds: Some(target.bounds),
            theme: Theme::for_window(window, cx, false),
            _follow: follow,
        }
    }
}

impl Render for FocusBorder {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .relative()
            .children(self.bounds.map(|bounds| ring(bounds, &self.theme)))
    }
}

fn reopen(target: &WindowId, cx: &mut App) {
    if cx.has_global::<FocusBorderWindow>() {
        open(target, cx);
    }
}

/// Puts the ring around `target` for the length of a recording. The native
/// id of the ring's own window comes back, for the capture to leave out.
pub fn open(target: &WindowId, cx: &mut App) -> Option<WindowId> {
    if !SUPPORTED {
        return None;
    }
    close(cx);
    let found = scap_targets::Window::from_id(target)?;
    let target = HoveredWindow::from_window(&found)?;
    let display = found.display()?;
    let logical = display.raw_handle().logical_bounds()?;
    let (x, y) = (logical.position().x(), logical.position().y());
    let (width, height) = (logical.size().width(), logical.size().height());

    let handle = cx
        .open_window(
            WindowOptions {
                // Moved onto its display right after opening, as the picker's
                // overlays are: gpui's origin math cannot say "cover this display".
                window_bounds: Some(WindowBounds::Windowed(gpui::Bounds {
                    origin: point(px(0.), px(0.)),
                    size: size(px(width as f32), px(height as f32)),
                })),
                titlebar: None,
                kind: WindowKind::PopUp,
                focus: false,
                show: false,
                is_resizable: false,
                is_minimizable: false,
                window_background: gpui::WindowBackgroundAppearance::Transparent,
                ..Default::default()
            },
            move |window, cx| cx.new(|cx| FocusBorder::new(target, window, cx)),
        )
        .inspect_err(|error| tracing::warn!("focus ring window failed to open: {error:#}"))
        .ok()?;
    cx.set_global(FocusBorderWindow(handle));

    let (native, number) = handle
        .update(cx, |_, window, _| {
            (
                platform::native_window(window),
                platform::window_number(window),
            )
        })
        .ok()?;
    let native = native?;
    // Out of every capture, and clicks go straight through to the window it
    // marks. Without both the ring would be in the video, or in the way.
    let hidden = platform::set_window_capture_hidden(&native, true);
    let click_through = platform::set_window_click_through(&native, true);
    if !click_through {
        tracing::warn!(
            hidden,
            "focus ring could not let clicks through; not showing it"
        );
        close(cx);
        return None;
    }
    // AppKit re-enters gpui as it orders the panel in, so that runs from a
    // fresh turn with nothing borrowed (see `platform::place_overlay_panel`).
    cx.spawn(async move |cx| {
        let open = cx.update(|cx| {
            cx.try_global::<FocusBorderWindow>()
                .is_some_and(|current| current.0 == handle)
        });
        if open {
            platform::place_overlay_panel(
                &native,
                x,
                y,
                width,
                height,
                platform::target_overlay_level() - 1,
            );
        }
    })
    .detach();
    number?.to_string().parse().ok()
}

pub fn close(cx: &mut App) {
    if let Some(FocusBorderWindow(handle)) = cx.try_global::<FocusBorderWindow>() {
        let handle = *handle;
        cx.remove_global::<FocusBorderWindow>();
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}
