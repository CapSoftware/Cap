//! `PositionPad` -- the 2D drag pad for a normalized `{x, y}` focal point
//! (`ConfigSidebar.tsx:6244-6291`).
//!
//! Three call sites share it in the source: the scene panel's Screen Position
//! and Camera Position (`:6462-6467, 6482-6487`) and the multi-zoom panel's
//! shared focal point (`:6035-6038`). The single-zoom panel draws the *same*
//! gesture over a decoded frame (`:5764-5867`), which it passes in as a
//! [`PadBackdrop`].
//!
//! The pad is `w-full h-28 rounded-lg border border-gray-3 bg-gray-2`, with a
//! 1px cross through the centre and a `size-6` knob carrying a `size-1.5` dot.
//! The knob is placed with `left: x%` / `top: y%` and pulled back half its own
//! size -- the source does that with `-translate-x-1/2 -translate-y-1/2`, and
//! this rev has no transform, so the pull-back is a negative margin, which is
//! exactly equivalent for a fixed-size box.
//!
//! The **history bracket is the pad's own**: `projectHistory.pause()` on the
//! press and `resumeHistory()` on the release (`:6250, 6265`), so a drag across
//! the pad is one undo entry -- the same contract `ui::Slider`'s drag has.

use std::sync::Arc;

use gpui::{
    App, Bounds, ElementId, Hsla, InteractiveElement, IntoElement, MouseDownEvent, ObjectFit,
    ParentElement, Pixels, Point, RenderImage, RenderOnce, Styled, StyledImage, Window, canvas,
    div, img, prelude::FluentBuilder, px, relative,
};

use crate::theme::Theme;

use super::SliderTrack;

/// `Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))` and the
/// same for y (`ConfigSidebar.tsx:6254-6257`).
///
/// Returns `None` for a pad that has not been laid out yet -- a press during
/// the first frame must not snap the value to the top-left corner, the same
/// guard [`super::fraction_from_x`] has.
pub fn pad_position(position: Point<Pixels>, bounds: Bounds<Pixels>) -> Option<(f64, f64)> {
    let width = f32::from(bounds.size.width);
    let height = f32::from(bounds.size.height);
    if width <= 0. || height <= 0. {
        return None;
    }
    let x = (f32::from(position.x) - f32::from(bounds.origin.x)) / width;
    let y = (f32::from(position.y) - f32::from(bounds.origin.y)) / height;
    Some((f64::from(x).clamp(0., 1.), f64::from(y).clamp(0., 1.)))
}

type PressHandler = Box<dyn Fn(&MouseDownEvent, &mut Window, &mut App) + 'static>;

/// `h-28`.
pub const PAD_HEIGHT: f32 = 112.;
/// `w-6 h-6`.
const KNOB: f32 = 24.;

pub struct PadBackdrop {
    pub image: Option<Arc<RenderImage>>,
    pub frame_size: (f32, f32),
    pub crop: Bounds<f32>,
}

#[derive(IntoElement)]
pub struct PositionPad {
    id: ElementId,
    x: f64,
    y: f64,
    bounds_cell: SliderTrack,
    bg: Hsla,
    border: Hsla,
    cross: Hsla,
    knob_bg: Hsla,
    knob_border: Hsla,
    dot: Hsla,
    backdrop: Option<PadBackdrop>,
    on_press: Option<PressHandler>,
}

impl PositionPad {
    /// The editor surface: `border-gray-3 bg-gray-2`, knob `bg-gray-1` with a
    /// `border-gray-400` ring and a `bg-gray-5` dot.
    pub fn plain(
        theme: &Theme,
        id: impl Into<ElementId>,
        x: f64,
        y: f64,
        bounds: SliderTrack,
    ) -> Self {
        Self {
            id: id.into(),
            x: x.clamp(0., 1.),
            y: y.clamp(0., 1.),
            bounds_cell: bounds,
            bg: Hsla::from(theme.gray_2),
            border: Hsla::from(theme.gray_3),
            cross: Hsla::from(theme.gray_3),
            knob_bg: Hsla::from(theme.gray_1),
            // `border-gray-400`, the legacy scale the source names here.
            knob_border: Hsla::from(theme.gray_400_legacy),
            dot: Hsla::from(theme.gray_5),
            backdrop: None,
            on_press: None,
        }
    }

    pub fn backdrop(mut self, backdrop: Option<PadBackdrop>) -> Self {
        self.backdrop = backdrop
            .filter(|backdrop| backdrop.crop.size.width > 0. && backdrop.crop.size.height > 0.);
        self
    }

    pub fn on_press(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_press = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for PositionPad {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let PositionPad {
            id,
            x,
            y,
            bounds_cell,
            bg,
            border,
            cross,
            knob_bg,
            knob_border,
            dot,
            backdrop,
            on_press,
        } = self;

        let has_image = backdrop
            .as_ref()
            .is_some_and(|backdrop| backdrop.image.is_some());
        let cell = bounds_cell.clone();
        let mut pad = div()
            .id(id)
            .relative()
            .w_full()
            .map(|pad| match &backdrop {
                Some(backdrop) => {
                    pad.aspect_ratio(backdrop.crop.size.width / backdrop.crop.size.height)
                }
                None => pad.h(px(PAD_HEIGHT)),
            })
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(border)
            .bg(bg)
            .cursor(gpui::CursorStyle::Crosshair)
            // The pad's own rect, written from prepaint -- the sidebar is a
            // fixed column but the pad still has to know its origin, and the
            // slider's zero-sized canvas is the established way to get it.
            .child(
                canvas(move |bounds, _, _| cell.set(Some(bounds)), |_, _, _, _| {})
                    .absolute()
                    .inset_0(),
            )
            .children(backdrop_image(backdrop.as_ref()))
            // `absolute inset-y-0 left-1/2 w-px`
            .when(!has_image, |pad| {
                pad.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(relative(0.5))
                        .ml(px(-0.5))
                        .w(px(1.))
                        .bg(cross),
                )
            })
            // `absolute inset-x-0 top-1/2 h-px`
            .when(!has_image, |pad| {
                pad.child(
                    div()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(relative(0.5))
                        .mt(px(-0.5))
                        .h(px(1.))
                        .bg(cross),
                )
            })
            .child(
                div()
                    .absolute()
                    .left(relative(x as f32))
                    .top(relative(y as f32))
                    .ml(px(-KNOB / 2.))
                    .mt(px(-KNOB / 2.))
                    .size(px(KNOB))
                    .rounded_full()
                    .border_1()
                    .border_color(knob_border)
                    .bg(knob_bg)
                    .flex()
                    .justify_center()
                    .items_center()
                    .child(div().size(px(6.)).rounded_full().bg(dot)),
            );

        if let Some(handler) = on_press {
            pad = pad.on_mouse_down(gpui::MouseButton::Left, move |event, window, cx| {
                handler(event, window, cx)
            });
        }
        pad
    }
}

fn backdrop_image(backdrop: Option<&PadBackdrop>) -> Option<impl IntoElement> {
    let backdrop = backdrop?;
    let image = backdrop.image.clone()?;
    let crop = backdrop.crop;
    let (frame_width, frame_height) = backdrop.frame_size;
    Some(
        img(image)
            .absolute()
            .left(relative(-crop.origin.x / crop.size.width))
            .top(relative(-crop.origin.y / crop.size.height))
            .w(relative(frame_width / crop.size.width))
            .h(relative(frame_height / crop.size.height))
            .object_fit(ObjectFit::Fill),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, size};

    fn pad() -> Bounds<Pixels> {
        Bounds {
            origin: point(px(100.), px(200.)),
            size: size(px(382.), px(PAD_HEIGHT)),
        }
    }

    #[test]
    fn a_press_maps_to_the_normalised_point_it_landed_on() {
        // Dead centre.
        let (x, y) = pad_position(point(px(291.), px(256.)), pad()).unwrap();
        assert!((x - 0.5).abs() < 1e-6, "{x}");
        assert!((y - 0.5).abs() < 1e-6, "{y}");

        // Three quarters across, one quarter down.
        let (x, y) = pad_position(point(px(100. + 286.5), px(200. + 28.)), pad()).unwrap();
        assert!((x - 0.75).abs() < 1e-6, "{x}");
        assert!((y - 0.25).abs() < 1e-6, "{y}");
    }

    #[test]
    fn a_drag_outside_the_pad_clamps_rather_than_escaping() {
        let (x, y) = pad_position(point(px(-400.), px(-400.)), pad()).unwrap();
        assert_eq!((x, y), (0., 0.));
        let (x, y) = pad_position(point(px(9999.), px(9999.)), pad()).unwrap();
        assert_eq!((x, y), (1., 1.));
    }

    #[test]
    fn a_pad_that_has_never_been_laid_out_does_not_move_the_value() {
        let empty = Bounds {
            origin: point(px(0.), px(0.)),
            size: size(px(0.), px(0.)),
        };
        assert_eq!(pad_position(point(px(10.), px(10.)), empty), None);
    }
}
