//! `Hint`: a title and a line of explanation in a bubble anchored to the
//! control it describes.
//!
//! gpui's `.tooltip(..)` pins its bubble to the pointer, so over a small
//! control the bubble covers the cursor and whatever it points at. A hint sits
//! beside its control instead, with an arrow pointing back at it, on whichever
//! side keeps it clear of the cursor and inside the window. It fades in
//! sliding out of the control, and fades back into it.
//!
//! A view owns one [`Hints`]. Each control adds [`Hints::anchor`] as a child,
//! which records where the control was painted and what its hint says, and
//! reports hover through [`Hints::hover`]. The view calls
//! [`Hints::begin_frame`] at the top of `render` and paints [`Hints::render`]
//! last, above everything else.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Duration,
};

use gpui::{
    Animation, AnimationExt as _, AnyElement, Bounds, BoxShadow, Context, FontWeight, Hsla,
    IntoElement, ParentElement as _, Pixels, Point, SharedString, Size, Styled as _, TextRun,
    Window, canvas, div, point, px, size, svg,
};

use crate::theme::Theme;

/// How long the pointer rests on a control before its hint appears. Moving
/// straight on to another control shows that one at once, as macOS does.
pub const SHOW_DELAY: Duration = Duration::from_millis(450);
const FADE_IN: Duration = Duration::from_millis(200);
const FADE_OUT: Duration = Duration::from_millis(130);

/// Between the control and the arrow's tip.
const GAP: f32 = 6.;
/// How far the arrow stands off the bubble.
const ARROW: f32 = 7.;
const ARROW_BASE: f32 = 14.;
/// How far the bubble travels as it fades in.
const SLIDE: f32 = 6.;
const RADIUS: f32 = 10.;
const PAD_X: f32 = 12.;
const PAD_Y: f32 = 8.;
const TEXT_WIDTH: f32 = 236.;
const TITLE_SIZE: f32 = 13.;
const TITLE_LINE: f32 = 18.;
const BODY_SIZE: f32 = 12.;
const BODY_LINE: f32 = 16.;
const BODY_GAP: f32 = 2.;
/// Kept clear of the window's edges.
const MARGIN: f32 = 8.;
/// The pointer's arrow, measured from its hotspot: it hangs down and to the
/// right, so a bubble below or right of a control can still land on it.
const CURSOR: (f32, f32, f32, f32) = (-2., -2., 16., 24.);

#[derive(Debug, Clone, PartialEq)]
pub struct Hint {
    pub title: SharedString,
    pub body: Option<SharedString>,
    /// The side to try first, for a control whose neighbours a hint above
    /// would cover.
    pub side: Option<Side>,
}

impl Hint {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            body: None,
            side: None,
        }
    }

    pub fn side(mut self, side: Side) -> Self {
        self.side = Some(side);
        self
    }

    pub fn body(mut self, body: impl Into<SharedString>) -> Self {
        self.body = Some(body.into());
        self
    }
}

/// Which side of its control a hint sits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Above,
    Below,
    Right,
    Left,
}

impl Side {
    /// Towards the control, which is where the bubble slides out from.
    fn towards_control(self) -> (f32, f32) {
        match self {
            Side::Above => (0., 1.),
            Side::Below => (0., -1.),
            Side::Right => (-1., 0.),
            Side::Left => (1., 0.),
        }
    }

    fn arrow_icon(self) -> &'static str {
        match self {
            Side::Above => "icons/hint-arrow-down.svg",
            Side::Below => "icons/hint-arrow-up.svg",
            Side::Right => "icons/hint-arrow-left.svg",
            Side::Left => "icons/hint-arrow-right.svg",
        }
    }
}

/// Where a hint goes: the bubble's bounds, the side it took, and how far
/// along the bubble's facing edge the arrow's centre sits.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub side: Side,
    pub bubble: Bounds<Pixels>,
    pub arrow_at: Pixels,
}

/// Places a `bubble`-sized hint beside `control` in a `window`-sized space:
/// above if it fits, then below, right and left, skipping any side that would
/// land on the pointer at `cursor`. `prefer` keeps a hint that is already
/// showing on its side while that still works, so it never jumps.
pub fn place(
    control: Bounds<Pixels>,
    bubble: Size<Pixels>,
    cursor: Point<Pixels>,
    window: Size<Pixels>,
    prefer: Option<Side>,
) -> Placement {
    let (w, h) = (f32::from(bubble.width), f32::from(bubble.height));
    let (win_w, win_h) = (f32::from(window.width), f32::from(window.height));
    let (left, top) = (f32::from(control.origin.x), f32::from(control.origin.y));
    let (right, bottom) = (
        left + f32::from(control.size.width),
        top + f32::from(control.size.height),
    );
    let (mid_x, mid_y) = ((left + right) / 2., (top + bottom) / 2.);
    let clamp_x = |x: f32| x.clamp(MARGIN, (win_w - MARGIN - w).max(MARGIN));
    let clamp_y = |y: f32| y.clamp(MARGIN, (win_h - MARGIN - h).max(MARGIN));

    let candidate = |side: Side| -> (f32, f32) {
        match side {
            Side::Above => (clamp_x(mid_x - w / 2.), top - GAP - ARROW - h),
            Side::Below => (clamp_x(mid_x - w / 2.), bottom + GAP + ARROW),
            Side::Right => (right + GAP + ARROW, clamp_y(mid_y - h / 2.)),
            Side::Left => (left - GAP - ARROW - w, clamp_y(mid_y - h / 2.)),
        }
    };
    let (cx, cy) = (f32::from(cursor.x), f32::from(cursor.y));
    let pointer = (cx + CURSOR.0, cy + CURSOR.1, cx + CURSOR.2, cy + CURSOR.3);
    let works = |side: Side| {
        let (x, y) = candidate(side);
        let inside = x >= MARGIN - 0.5
            && y >= MARGIN - 0.5
            && x + w <= win_w - MARGIN + 0.5
            && y + h <= win_h - MARGIN + 0.5;
        // The arrow counts too: it reaches back to the control.
        let (x0, y0, x1, y1) = match side {
            Side::Above => (x, y, x + w, top),
            Side::Below => (x, bottom, x + w, y + h),
            Side::Right => (right, y, x + w, y + h),
            Side::Left => (x, y, left, y + h),
        };
        let covers_pointer = pointer.0 < x1 && pointer.2 > x0 && pointer.1 < y1 && pointer.3 > y0;
        inside && !covers_pointer
    };

    let order = [Side::Above, Side::Below, Side::Right, Side::Left];
    let side = prefer
        .filter(|side| works(*side))
        .or_else(|| order.into_iter().find(|side| works(*side)))
        .unwrap_or(Side::Above);
    let (mut x, mut y) = candidate(side);
    if side == Side::Above && !works(side) {
        y = y.max(MARGIN);
        x = clamp_x(x);
    }
    let reach = RADIUS + ARROW_BASE / 2.;
    let arrow_at = match side {
        Side::Above | Side::Below => (mid_x - x).clamp(reach, w - reach),
        Side::Right | Side::Left => (mid_y - y).clamp(reach, h - reach),
    };
    Placement {
        side,
        bubble: Bounds::new(point(px(x), px(y)), size(px(w), px(h))),
        arrow_at: px(arrow_at),
    }
}

struct Anchor {
    bounds: Bounds<Pixels>,
    hint: Hint,
    frame: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// The pointer is resting on the control; the hint is not up yet.
    Waiting,
    Shown,
    Leaving,
}

struct Active {
    id: &'static str,
    phase: Phase,
    /// Counts showings, so each one plays its own fade.
    showing: u64,
    /// Taken over straight from another hint, so it appears at once.
    instant: bool,
}

#[derive(Default)]
pub struct Hints {
    anchors: Rc<RefCell<HashMap<&'static str, Anchor>>>,
    frame: u64,
    active: Option<Active>,
    /// Bumped by every hover change; a timer only acts if none came since.
    serial: u64,
    showings: u64,
    side: Cell<Option<Side>>,
}

impl Hints {
    pub fn begin_frame(&mut self) {
        self.frame += 1;
    }

    /// An invisible child of the control that records where it was painted
    /// and what its hint says. The control lays it out over itself.
    pub fn anchor(&self, id: &'static str, hint: Hint) -> impl IntoElement {
        let anchors = self.anchors.clone();
        let frame = self.frame;
        canvas(
            move |bounds, _, _| {
                anchors.borrow_mut().insert(
                    id,
                    Anchor {
                        bounds,
                        hint,
                        frame,
                    },
                );
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// The pointer entered or left control `id`. `hints` finds this
    /// [`Hints`] in the view, for the timers.
    pub fn hover<V: 'static>(
        &mut self,
        id: &'static str,
        hovered: bool,
        cx: &mut Context<V>,
        hints: fn(&mut V) -> &mut Hints,
    ) {
        self.serial += 1;
        let serial = self.serial;
        if hovered {
            let up = self
                .active
                .as_ref()
                .is_some_and(|active| active.phase != Phase::Waiting);
            if up {
                self.show(id, true);
            } else {
                self.active = Some(Active {
                    id,
                    phase: Phase::Waiting,
                    showing: 0,
                    instant: false,
                });
                later(SHOW_DELAY, serial, cx, hints, move |hints| {
                    hints.show(id, false)
                });
            }
            cx.notify();
            return;
        }
        let Some(active) = self.active.as_mut().filter(|active| active.id == id) else {
            return;
        };
        match active.phase {
            Phase::Waiting => self.active = None,
            Phase::Shown => {
                active.phase = Phase::Leaving;
                later(FADE_OUT, serial, cx, hints, |hints| hints.active = None);
            }
            Phase::Leaving => {}
        }
        cx.notify();
    }

    /// Takes the hint down at once: its control was clicked.
    pub fn dismiss(&mut self) {
        self.serial += 1;
        self.active = None;
    }

    fn show(&mut self, id: &'static str, instant: bool) {
        self.showings += 1;
        self.side.set(None);
        self.active = Some(Active {
            id,
            phase: Phase::Shown,
            showing: self.showings,
            instant,
        });
    }

    /// The hint that is up, painted over the whole window. `None` when there
    /// is none, or its control was not painted last frame.
    pub fn render(
        &self,
        window: &mut Window,
        theme: &Theme,
        reduce_motion: bool,
    ) -> Option<AnyElement> {
        let active = self
            .active
            .as_ref()
            .filter(|active| active.phase != Phase::Waiting)?;
        let (bounds, hint) = {
            let anchors = self.anchors.borrow();
            let anchor = anchors
                .get(active.id)
                .filter(|anchor| anchor.frame + 1 >= self.frame)?;
            (anchor.bounds, anchor.hint.clone())
        };

        let dark = theme.is_dark();
        let (fill, edge, title_color, body_color): (Hsla, Hsla, Hsla, Hsla) = if dark {
            (
                gpui::hsla(240. / 360., 0.04, 0.13, 1.),
                gpui::hsla(0., 0., 1., 0.12),
                gpui::hsla(0., 0., 1., 0.96),
                gpui::hsla(0., 0., 1., 0.62),
            )
        } else {
            (
                gpui::hsla(0., 0., 1., 1.),
                gpui::hsla(0., 0., 0., 0.09),
                gpui::hsla(0., 0., 0., 0.88),
                gpui::hsla(0., 0., 0., 0.56),
            )
        };

        let text = measure(window, &hint);
        let bubble = size(
            px((text.0 + 2. * PAD_X + 2.).ceil()),
            px((text.1 + 2. * PAD_Y + 2.).ceil()),
        );
        let placed = place(
            bounds,
            bubble,
            window.mouse_position(),
            window.viewport_size(),
            self.side.get().or(hint.side),
        );
        self.side.set(Some(placed.side));

        let (w, h) = (
            f32::from(placed.bubble.size.width),
            f32::from(placed.bubble.size.height),
        );
        let arrow_at = f32::from(placed.arrow_at);
        // The arrow overlaps the bubble's border by a pixel so the two read
        // as one shape; the edge-coloured arrow behind it draws its outline.
        let arrow = |grow: f32, color: Hsla| {
            let (base, depth) = (ARROW_BASE + grow * 2., ARROW + grow);
            let (aw, ah) = match placed.side {
                Side::Above | Side::Below => (base, depth),
                Side::Right | Side::Left => (depth, base),
            };
            let (left, top) = match placed.side {
                Side::Above => (arrow_at - aw / 2., h - 1.),
                Side::Below => (arrow_at - aw / 2., 1. - ah),
                Side::Right => (1. - aw, arrow_at - ah / 2.),
                Side::Left => (w - 1., arrow_at - ah / 2.),
            };
            svg()
                .path(placed.side.arrow_icon())
                .absolute()
                .left(px(left))
                .top(px(top))
                .w(px(aw))
                .h(px(ah))
                .text_color(color)
        };

        let shadow = vec![
            BoxShadow {
                color: gpui::hsla(0., 0., 0., if dark { 0.45 } else { 0.16 }),
                offset: point(px(0.), px(8.)),
                blur_radius: px(24.),
                spread_radius: px(0.),
                inset: false,
            },
            BoxShadow {
                color: gpui::hsla(0., 0., 0., if dark { 0.3 } else { 0.08 }),
                offset: point(px(0.), px(1.)),
                blur_radius: px(3.),
                spread_radius: px(0.),
                inset: false,
            },
        ];

        let body = div()
            .size_full()
            .rounded(px(RADIUS))
            .border_1()
            .border_color(edge)
            .bg(fill)
            .shadow(shadow)
            .px(px(PAD_X))
            .py(px(PAD_Y))
            .flex()
            .flex_col()
            .gap(px(BODY_GAP))
            .child(
                div()
                    .w(px(text.0 + 1.))
                    .text_size(px(TITLE_SIZE))
                    .line_height(px(TITLE_LINE))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(title_color)
                    .child(hint.title.clone()),
            )
            .children(hint.body.clone().map(|body| {
                div()
                    .w(px(text.0 + 1.))
                    .text_size(px(BODY_SIZE))
                    .line_height(px(BODY_LINE))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(body_color)
                    .child(body)
            }));

        let leaving = active.phase == Phase::Leaving;
        let (x, y) = (
            f32::from(placed.bubble.origin.x),
            f32::from(placed.bubble.origin.y),
        );
        let (dx, dy) = placed.side.towards_control();
        let slide = if reduce_motion { 0. } else { SLIDE };
        let id = SharedString::from(format!(
            "hint-{}-{}",
            active.showing,
            if leaving { "out" } else { "in" }
        ));
        let animation = if leaving {
            Animation::new(FADE_OUT).with_easing(gpui::ease_in_out)
        } else {
            Animation::new(FADE_IN).with_easing(gpui::ease_out_quint())
        };
        let bubble = div()
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(w))
            .h(px(h))
            .child(arrow(1., edge))
            .child(body)
            .child(arrow(0., fill));
        // Moving from one control straight to the next swaps the hint at
        // once, as macOS does; fading it in again would blink.
        if active.instant && !leaving {
            return Some(bubble.into_any_element());
        }
        Some(
            bubble
                .with_animation(id, animation, move |element, delta| {
                    let shown = if leaving { 1. - delta } else { delta };
                    let offset = (1. - shown) * slide;
                    element
                        .left(px(x + dx * offset))
                        .top(px(y + dy * offset))
                        .opacity(shown)
                })
                .into_any_element(),
        )
    }
}

/// The text block's size: the title and body wrapped at [`TEXT_WIDTH`], as
/// wide as the longest line.
fn measure(window: &Window, hint: &Hint) -> (f32, f32) {
    let shape = |text: &SharedString, font_size: f32, weight: FontWeight| {
        let mut font = gpui::font(crate::theme::UI_FONT);
        font.weight = weight;
        let run = TextRun {
            len: text.len(),
            font,
            color: gpui::black(),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        window
            .text_system()
            .shape_text(
                text.clone(),
                px(font_size),
                &[run],
                Some(px(TEXT_WIDTH)),
                None,
            )
            .map(|lines| {
                lines.iter().fold((0f32, 0usize), |(width, count), line| {
                    (
                        width.max(f32::from(line.width())),
                        count + line.wrap_boundaries().len() + 1,
                    )
                })
            })
            .unwrap_or((TEXT_WIDTH, 1))
    };
    let (title_w, title_lines) = shape(&hint.title, TITLE_SIZE, FontWeight::SEMIBOLD);
    let (mut width, mut height) = (title_w, title_lines as f32 * TITLE_LINE);
    if let Some(body) = &hint.body {
        let (body_w, body_lines) = shape(body, BODY_SIZE, FontWeight::NORMAL);
        width = width.max(body_w);
        height += BODY_GAP + body_lines as f32 * BODY_LINE;
    }
    (width.ceil(), height)
}

fn later<V: 'static>(
    delay: Duration,
    serial: u64,
    cx: &mut Context<V>,
    hints: fn(&mut V) -> &mut Hints,
    then: impl FnOnce(&mut Hints) + 'static,
) {
    cx.spawn(async move |view, cx| {
        cx.background_executor().timer(delay).await;
        view.update(cx, |view, cx| {
            let state = hints(view);
            if state.serial == serial {
                then(state);
                cx.notify();
            }
        })
        .ok();
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> {
        Bounds::new(point(px(x), px(y)), size(px(w), px(h)))
    }

    fn window() -> Size<Pixels> {
        size(px(1440.), px(900.))
    }

    #[test]
    fn sits_above_and_centred_on_its_control() {
        let control = rect(600., 700., 120., 32.);
        let placed = place(
            control,
            size(px(200.), px(50.)),
            point(px(610.), px(716.)),
            window(),
            None,
        );
        assert_eq!(placed.side, Side::Above);
        assert_eq!(
            placed.bubble.origin,
            point(px(560.), px(700. - GAP - ARROW - 50.))
        );
        assert_eq!(placed.arrow_at, px(100.));
    }

    #[test]
    fn flips_below_at_the_top_of_the_window() {
        let control = rect(600., 20., 120., 32.);
        let placed = place(
            control,
            size(px(200.), px(50.)),
            point(px(610.), px(26.)),
            window(),
            None,
        );
        assert_eq!(placed.side, Side::Below);
    }

    #[test]
    fn never_lands_on_the_pointer() {
        // At the top of the window, with the pointer at the control's bottom
        // edge: below would sit on the pointer's arrow, so it goes beside.
        let control = rect(600., 20., 120., 32.);
        let cursor = point(px(660.), px(50.));
        let placed = place(control, size(px(200.), px(50.)), cursor, window(), None);
        assert_ne!(placed.side, Side::Below);
        assert!(!placed.bubble.contains(&cursor));
    }

    #[test]
    fn stays_inside_the_window_with_the_arrow_on_the_control() {
        let control = rect(4., 700., 40., 32.);
        let placed = place(
            control,
            size(px(200.), px(50.)),
            point(px(10.), px(710.)),
            window(),
            None,
        );
        assert_eq!(placed.side, Side::Above);
        assert_eq!(placed.bubble.origin.x, px(MARGIN));
        // The arrow points at the control's centre, short of the corner.
        assert_eq!(placed.arrow_at, px(RADIUS + ARROW_BASE / 2.));
    }

    #[test]
    fn keeps_its_side_while_that_still_works() {
        let control = rect(600., 400., 120., 32.);
        let placed = place(
            control,
            size(px(200.), px(50.)),
            point(px(610.), px(406.)),
            window(),
            Some(Side::Left),
        );
        assert_eq!(placed.side, Side::Left);
    }
}
