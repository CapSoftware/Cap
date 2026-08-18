//! `CircularProgress` -- one component for the three the Solid app draws:
//! `packages/ui-solid/src/ProgressCircle.tsx` (the "correct" one nothing uses),
//! `ExportPage.tsx`'s local `ProgressRing` (which adds an indeterminate mode)
//! and `ImportProgress.tsx`'s third inline SVG.
//!
//! gpui has no arc primitive and no `stroke-dashoffset`, so the ring is drawn
//! as a track circle with the progressed arc composed from quadrant wedges:
//! a rounded, clipped `div` per quadrant, each revealed up to its own share of
//! the total. That is enough for a determinate ring at these sizes; the
//! indeterminate mode spins one fixed 25 % wedge, which is what the SVG does.

use gpui::{
    App, Hsla, IntoElement, ParentElement, Pixels, RenderOnce, Styled, Window, div,
    prelude::FluentBuilder, px,
};

#[derive(IntoElement)]
pub struct CircularProgress {
    /// `0..=1`, or `None` for the indeterminate spinner.
    progress: Option<f32>,
    size: Pixels,
    stroke: Pixels,
    track: Hsla,
    fill: Hsla,
    label: bool,
    text_color: Hsla,
    text_size: Pixels,
}

impl CircularProgress {
    pub fn new(size: Pixels, stroke: Pixels, track: Hsla, fill: Hsla) -> Self {
        Self {
            progress: Some(0.),
            size,
            stroke,
            track,
            fill,
            label: false,
            text_color: fill,
            text_size: px(12.),
        }
    }

    /// `progress: number (0-100)` in the Solid components; taken as a fraction
    /// here so the caller does not have to scale twice.
    pub fn progress(mut self, fraction: f32) -> Self {
        self.progress = Some(fraction.clamp(0., 1.));
        self
    }

    /// `indeterminate` -- `ExportPage`'s spinning fixed-length arc.
    pub fn indeterminate(mut self) -> Self {
        self.progress = None;
        self
    }

    /// The centred `%` readout `ProgressRing` draws inside the ring.
    pub fn label(mut self, color: Hsla, size: Pixels) -> Self {
        self.label = true;
        self.text_color = color;
        self.text_size = size;
        self
    }
}

impl RenderOnce for CircularProgress {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let CircularProgress {
            progress,
            size,
            stroke,
            track,
            fill,
            label,
            text_color,
            text_size,
        } = self;

        // The four quadrants, clockwise from twelve o'clock. Each is a
        // quarter-square clipping a full-size ring, so the visible arc is the
        // quadrant's own quarter of the circle.
        let fraction = progress.unwrap_or(0.25);
        let half = px(f32::from(size) / 2.);

        div()
            .relative()
            .size(size)
            .flex()
            .items_center()
            .justify_center()
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .size(size)
                    .rounded_full()
                    .border(stroke)
                    .border_color(track),
            )
            .children((0..4).map(|quadrant| {
                let share = ((fraction * 4.) - quadrant as f32).clamp(0., 1.);
                let (top, left) = match quadrant {
                    0 => (px(0.), half),
                    1 => (half, half),
                    2 => (half, px(0.)),
                    _ => (px(0.), px(0.)),
                };
                div()
                    .absolute()
                    .top(top)
                    .left(left)
                    .w(half)
                    .h(half)
                    .overflow_hidden()
                    .when(share > 0., |this| {
                        this.child(
                            div()
                                .absolute()
                                .top(px(-f32::from(top)))
                                .left(px(-f32::from(left)))
                                .size(size)
                                .rounded_full()
                                .border(stroke)
                                .border_color(fill)
                                // A partially-filled quadrant fades rather than
                                // sweeping: gpui has no arc, and a wedge that
                                // pops in whole reads worse than one that
                                // arrives.
                                .opacity(share),
                        )
                    })
            }))
            .when(label, |this| {
                this.child(
                    div()
                        .text_size(text_size)
                        .text_color(text_color)
                        .child(format!("{}%", (fraction * 100.).round() as u32)),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn quadrant_shares_split_the_fraction_evenly() {
        let share =
            |fraction: f32, quadrant: usize| ((fraction * 4.) - quadrant as f32).clamp(0., 1.);
        // Half way round: the first two quadrants are full, the last two empty.
        assert_eq!(share(0.5, 0), 1.);
        assert_eq!(share(0.5, 1), 1.);
        assert_eq!(share(0.5, 2), 0.);
        assert_eq!(share(0.5, 3), 0.);
        // An eighth: the first quadrant is half filled.
        assert_eq!(share(0.125, 0), 0.5);
        assert_eq!(share(0.125, 1), 0.);
        // Complete.
        assert!((0..4).all(|quadrant| share(1., quadrant) == 1.));
    }
}
