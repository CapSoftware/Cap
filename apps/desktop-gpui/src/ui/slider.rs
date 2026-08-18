//! `Slider` -- the Kobalte `Slider` wrapper in `routes/editor/ui.tsx`, and the
//! footer's raw `<input type="range">` pills in `teleprompter.tsx`.
//!
//! Two things make a gpui slider work, and both are here rather than at each
//! call site:
//!
//! - **The track's rect comes back from prepaint.** Every slider in this app
//!   lives in a resizable pane, so its width is unknown at build time. A
//!   zero-sized [`gpui::canvas`] laid over the track writes its own painted
//!   bounds into a shared [`SliderTrack`] cell, which the pointer maths then
//!   reads.
//! - **A drag that leaves the track keeps tracking.** DOM pointer capture has
//!   no gpui equivalent, so the window paints a full-bleed transparent layer
//!   while the button is held ([`Slider::drag_layer`]) and the move handler
//!   lives there instead of on the 48px pill.

use std::{cell::Cell, rc::Rc};

use gpui::{
    App, Bounds, ElementId, Hsla, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
    MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point, RenderOnce, Styled, Window, canvas,
    div, prelude::FluentBuilder, px,
};

/// The shared cell a slider's track writes its prepaint bounds into.
///
/// Windows own one per slider and hand out clones; the cell is `Copy`-cheap
/// and never escapes the main thread.
pub type SliderTrack = Rc<Cell<Option<Bounds<Pixels>>>>;

/// Where along its track a pointer at `x` landed, clamped to `[0, 1]`.
///
/// Returns `None` for a track that has not been laid out yet (or has collapsed
/// to zero width), which is what stops a click during the first frame from
/// snapping a value to its minimum.
pub fn fraction_from_x(x: Pixels, track: Bounds<Pixels>) -> Option<f32> {
    let width = f32::from(track.size.width);
    if width <= 0. {
        return None;
    }
    Some(((f32::from(x) - f32::from(track.origin.x)) / width).clamp(0., 1.))
}

/// `minValue + fraction * (maxValue - minValue)`.
pub fn value_from_fraction(fraction: f32, minimum: f32, maximum: f32) -> f32 {
    minimum + fraction * (maximum - minimum)
}

/// Kobalte's `step`: values are quantised from `minValue`, not from zero, then
/// clamped back into the range (rounding at the top can overshoot when the span
/// is not a whole number of steps).
///
/// The quotient is pre-quantised to six decimal places before it is rounded,
/// and the division runs in `f64`. Without that, a step of `0.1` -- which is
/// not representable in binary -- puts an exact half-step *below* the boundary:
/// `(2.75 - 1.0) / 0.1f32` is `17.4999997`, so the value that should snap up to
/// 2.8 snaps down to 2.7 instead. The settings window's own formula
/// (`(v * 10).round() / 10`) never had that problem because ×10 is exact; this
/// one has to earn it. `slider_snapping_matches_the_formulas_it_replaced`
/// checks the whole range of both sliders that used to roll their own.
pub fn snap_to_step(value: f32, minimum: f32, maximum: f32, step: f32) -> f32 {
    if step <= 0. {
        return value.clamp(minimum, maximum);
    }
    let quotient = (f64::from(value) - f64::from(minimum)) / f64::from(step);
    let quotient = (quotient * 1e6).round() / 1e6;
    ((f64::from(minimum) + quotient.round() * f64::from(step)) as f32).clamp(minimum, maximum)
}

/// The press that begins a drag. Same shape as [`crate::ui::ClickHandler`]:
/// `cx.listener(..)` builds one directly.
type DragStartHandler = Box<dyn Fn(&MouseDownEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    fraction: f32,
    track_cell: SliderTrack,
    /// The row's own box -- `h-4` over a thinner track, so the thumb has room.
    row_height: Pixels,
    row_width: Option<Pixels>,
    fill_row: bool,
    track_height: Pixels,
    track_bg: Hsla,
    /// `bg-blue-9`, when the slider draws a filled portion at all. The
    /// teleprompter's pills do not.
    fill: Option<Hsla>,
    thumb: Option<ThumbStyle>,
    on_drag_start: Option<DragStartHandler>,
}

#[derive(Debug, Clone, Copy)]
struct ThumbStyle {
    size: Pixels,
    fill: Hsla,
    border: Option<Hsla>,
    /// The thumb's `top`. Defaults to centring it over the track; the settings
    /// zoom slider sits one pixel high of centre and that is transcribed, not
    /// corrected.
    top: Pixels,
}

impl Slider {
    pub fn new(id: impl Into<ElementId>, fraction: f32, track: SliderTrack) -> Self {
        Self {
            id: id.into(),
            fraction: fraction.clamp(0., 1.),
            track_cell: track,
            row_height: px(16.),
            row_width: None,
            fill_row: false,
            track_height: px(4.),
            track_bg: gpui::transparent_black(),
            fill: None,
            thumb: None,
            on_drag_start: None,
        }
    }

    /// The row stretches to fill its parent (`flex-1 min-w-0`) rather than
    /// taking a fixed width.
    pub fn flex(mut self) -> Self {
        self.fill_row = true;
        self
    }

    pub fn row_width(mut self, width: Pixels) -> Self {
        self.row_width = Some(width);
        self
    }

    pub fn row_height(mut self, height: Pixels) -> Self {
        self.row_height = height;
        self
    }

    /// `h-[0.3rem] bg-gray-4 rounded-full`, or whatever the surface remaps the
    /// track fill to.
    pub fn track(mut self, height: Pixels, bg: Hsla) -> Self {
        self.track_height = height;
        self.track_bg = bg;
        self
    }

    /// `absolute h-full rounded-full bg-blue-9`.
    pub fn fill(mut self, color: Hsla) -> Self {
        self.fill = Some(color);
        self
    }

    /// `bg-gray-1 dark:bg-gray-12 border border-gray-6 rounded-full size-4`.
    pub fn thumb(mut self, size: Pixels, fill: Hsla, border: Option<Hsla>) -> Self {
        let top = px(-(f32::from(size) - f32::from(self.track_height)) / 2.);
        self.thumb = Some(ThumbStyle {
            size,
            fill,
            border,
            top,
        });
        self
    }

    pub fn thumb_top(mut self, top: Pixels) -> Self {
        if let Some(thumb) = self.thumb.as_mut() {
            thumb.top = top;
        }
        self
    }

    pub fn on_drag_start(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_drag_start = Some(Box::new(handler));
        self
    }

    /// The full-bleed layer that keeps a drag alive once the pointer leaves the
    /// track. Paint it as the last child of the window root while a drag is in
    /// flight; the `id` only has to be unique within that window.
    pub fn drag_layer(
        id: impl Into<ElementId>,
        on_move: impl Fn(&MouseMoveEvent, &mut Window, &mut App) + 'static,
        on_up: impl Fn(&MouseUpEvent, &mut Window, &mut App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        div()
            .id(id.into())
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .on_mouse_move(on_move)
            .on_mouse_up(MouseButton::Left, on_up)
    }
}

impl RenderOnce for Slider {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Slider {
            id,
            fraction,
            track_cell,
            row_height,
            row_width,
            fill_row,
            track_height,
            track_bg,
            fill,
            thumb,
            on_drag_start,
        } = self;

        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .h(row_height)
            .when(fill_row, |this| this.flex_1().min_w_0())
            .when_some(row_width, |this, width| this.w(width).flex_shrink_0())
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(track_height)
                    .rounded_full()
                    .bg(track_bg)
                    .child(
                        canvas(
                            move |bounds, _window, _cx| track_cell.set(Some(bounds)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .children(fill.map(|color| {
                        div()
                            .absolute()
                            .left_0()
                            .top_0()
                            .h_full()
                            .w(gpui::relative(fraction))
                            .rounded_full()
                            .bg(color)
                    }))
                    .children(thumb.map(|thumb| {
                        div()
                            .absolute()
                            .top(thumb.top)
                            .left(gpui::relative(fraction))
                            .ml(px(-f32::from(thumb.size) / 2.))
                            .size(thumb.size)
                            .rounded_full()
                            .bg(thumb.fill)
                            .when_some(thumb.border, |this, border| {
                                this.border_1().border_color(border)
                            })
                    })),
            )
            .when_some(on_drag_start, |this, handler| {
                this.on_mouse_down(MouseButton::Left, move |event, window, cx| {
                    handler(event, window, cx)
                })
            })
    }
}

/// One live slider drag, and the undo bracket around it.
///
/// The Solid `Slider` takes `history.pause()` on the **first** `onChange` of a
/// drag and calls the closure it returns on `onChangeEnd`
/// (`routes/editor/ui.tsx:81, 96-104`), so a drag's sixty intermediate values
/// collapse into one undo entry. That is a correctness contract, not styling:
/// without it every sidebar drag spams the history stack.
///
/// gpui has no `onChangeEnd` -- a drag ends on the window-wide drag layer, not
/// on the slider -- so the bracket lives here instead, keyed by whatever the
/// window uses to tell its sliders apart. The pause and resume arrive as
/// callbacks, so this module stays free of editor types.
#[derive(Debug, Default)]
pub struct SliderDrag<K> {
    active: Option<K>,
}

impl<K: Copy + PartialEq> SliderDrag<K> {
    pub fn new() -> Self {
        Self { active: None }
    }

    /// Which slider is being dragged, if any. The window reads this to decide
    /// whether to paint the drag layer and where a move applies.
    pub fn active(&self) -> Option<K> {
        self.active
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// A press on `key`. `pause` runs exactly once per drag: a second press
    /// without an intervening release (a chorded pointer, a re-entrant event)
    /// must not push a second pause onto the history, or the resume would
    /// leave it paused forever.
    pub fn begin(&mut self, key: K, pause: impl FnOnce()) {
        if self.active.is_none() {
            pause();
        }
        self.active = Some(key);
    }

    /// The release. `resume` runs only if a drag was actually in flight, so a
    /// stray mouse-up cannot unbalance the pause count.
    pub fn end(&mut self, resume: impl FnOnce()) {
        if self.active.take().is_some() {
            resume();
        }
    }
}

/// A convenience for the "pointer landed here, what value is that" step every
/// call site repeats: read the track, map x to a fraction, snap to the step.
pub fn value_at(
    track: &SliderTrack,
    position: Point<Pixels>,
    minimum: f32,
    maximum: f32,
    step: f32,
) -> Option<f32> {
    let bounds = track.get()?;
    let fraction = fraction_from_x(position.x, bounds)?;
    Some(snap_to_step(
        value_from_fraction(fraction, minimum, maximum),
        minimum,
        maximum,
        step,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn track(origin_x: f32, width: f32) -> Bounds<Pixels> {
        Bounds {
            origin: point(px(origin_x), px(0.)),
            size: size(px(width), px(4.)),
        }
    }

    #[test]
    fn a_pointer_maps_to_a_fraction_of_the_track() {
        let bounds = track(100., 200.);
        assert_eq!(fraction_from_x(px(100.), bounds), Some(0.));
        assert_eq!(fraction_from_x(px(200.), bounds), Some(0.5));
        assert_eq!(fraction_from_x(px(300.), bounds), Some(1.));
    }

    #[test]
    fn a_pointer_outside_the_track_clamps_rather_than_extrapolating() {
        let bounds = track(100., 200.);
        assert_eq!(fraction_from_x(px(-40.), bounds), Some(0.));
        assert_eq!(fraction_from_x(px(9000.), bounds), Some(1.));
    }

    #[test]
    fn a_track_with_no_layout_yet_reports_nothing() {
        assert_eq!(fraction_from_x(px(10.), track(0., 0.)), None);
    }

    #[test]
    fn values_snap_to_their_step_from_the_minimum() {
        // The settings zoom slider: 1..4.5 step 0.1. 2.75 is an exact half
        // step and must round *up*, which is the whole reason for the f64
        // pre-quantisation.
        assert_eq!(
            snap_to_step(value_from_fraction(0., 1., 4.5), 1., 4.5, 0.1),
            1.
        );
        let mid = snap_to_step(value_from_fraction(0.5, 1., 4.5), 1., 4.5, 0.1);
        assert!((mid - 2.8).abs() < 1e-4, "{mid}");
        assert_eq!(
            snap_to_step(value_from_fraction(1., 1., 4.5), 1., 4.5, 0.1),
            4.5
        );
    }

    #[test]
    fn a_step_that_does_not_divide_the_range_still_clamps() {
        let top = snap_to_step(value_from_fraction(1., 0., 7.), 0., 7., 2.);
        assert_eq!(top, 7.);
        let near_top = snap_to_step(value_from_fraction(0.95, 0., 7.), 0., 7., 2.);
        assert_eq!(near_top, 6.);
    }

    /// The two sliders this component replaced quantised with two different
    /// formulas. Both are reproduced exactly, over their whole range.
    #[test]
    fn slider_snapping_matches_the_formulas_it_replaced() {
        for i in 0..=10_000 {
            let fraction = i as f32 / 10_000.;

            // `settings_window::set_zoom_from`: `((min + f * span) * 10).round() / 10`.
            let raw = value_from_fraction(fraction, 1., 4.5);
            let before = (raw * 10.).round() / 10.;
            let after = snap_to_step(raw, 1., 4.5, 0.1);
            assert!(
                (before - after).abs() < 1e-4,
                "zoom fraction {fraction}: {before} vs {after}"
            );

            // `teleprompter_window::stepped`, for both of its ranges.
            for (minimum, maximum, step) in [(60., 350., 5.), (45., 100., 5.)] {
                let raw = value_from_fraction(fraction, minimum, maximum);
                let before =
                    (minimum + ((raw - minimum) / step).round() * step).clamp(minimum, maximum);
                let after = snap_to_step(raw, minimum, maximum, step);
                assert_eq!(
                    before as u32, after as u32,
                    "range {minimum}..{maximum} fraction {fraction}"
                );
            }
        }
    }

    /// The undo bracket: one pause per drag, one resume, and nothing at all
    /// from an unmatched release.
    #[test]
    fn a_slider_drag_pauses_history_once_and_resumes_once() {
        use std::cell::Cell;

        let pauses = Cell::new(0);
        let resumes = Cell::new(0);
        let mut drag: SliderDrag<u8> = SliderDrag::new();

        drag.end(|| resumes.set(resumes.get() + 1));
        assert_eq!((pauses.get(), resumes.get()), (0, 0));

        drag.begin(1, || pauses.set(pauses.get() + 1));
        drag.begin(1, || pauses.set(pauses.get() + 1));
        assert_eq!(drag.active(), Some(1));
        assert_eq!((pauses.get(), resumes.get()), (1, 0));

        drag.end(|| resumes.set(resumes.get() + 1));
        assert_eq!(drag.active(), None);
        assert_eq!((pauses.get(), resumes.get()), (1, 1));

        drag.begin(2, || pauses.set(pauses.get() + 1));
        drag.end(|| resumes.set(resumes.get() + 1));
        assert_eq!((pauses.get(), resumes.get()), (2, 2));
    }

    #[test]
    fn value_at_walks_the_whole_pipeline() {
        let cell: SliderTrack = Rc::new(Cell::new(Some(track(0., 100.))));
        assert_eq!(
            value_at(&cell, point(px(50.), px(0.)), 1., 4.5, 0.1),
            Some(2.8)
        );
        let empty: SliderTrack = Rc::new(Cell::new(None));
        assert_eq!(value_at(&empty, point(px(50.), px(0.)), 1., 4.5, 0.1), None);
    }
}
