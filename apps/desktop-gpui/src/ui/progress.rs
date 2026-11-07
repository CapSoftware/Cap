//! `CircularProgress` -- one component for the three the Solid app draws:
//! `packages/ui-solid/src/ProgressCircle.tsx` (the "correct" one nothing uses),
//! `ExportPage.tsx`'s local `ProgressRing` (which adds an indeterminate mode)
//! and `ImportProgress.tsx`'s third inline SVG.

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

    fn percentage_label(&self) -> Option<String> {
        self.progress
            .filter(|_| self.label)
            .map(|fraction| format!("{}%", (fraction * 100.).round() as u32))
    }
}

impl RenderOnce for CircularProgress {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let percentage_label = self.percentage_label();
        let CircularProgress {
            progress,
            size,
            stroke,
            track,
            fill,
            label: _,
            text_color,
            text_size,
        } = self;

        let fraction = progress.unwrap_or(0.25);

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
            .child(
                gpui::canvas(
                    move |bounds, _, _| {
                        if fraction <= 0. {
                            return None;
                        }
                        let center = bounds.center();
                        let radius = (f32::from(size) - f32::from(stroke)) / 2.;
                        let at = |angle: f32| {
                            gpui::point(
                                center.x + px(radius * angle.sin()),
                                center.y - px(radius * angle.cos()),
                            )
                        };
                        let mut path = gpui::PathBuilder::stroke(stroke);
                        path.move_to(at(0.));
                        let segments = (fraction * 2.).ceil() as u32;
                        for segment in 1..=segments {
                            path.arc_to(
                                gpui::point(px(radius), px(radius)),
                                px(0.),
                                false,
                                true,
                                at(fraction * std::f32::consts::TAU * segment as f32
                                    / segments as f32),
                            );
                        }
                        if fraction == 1. {
                            path.close();
                        }
                        path.build().ok()
                    },
                    move |_, path, window, _| {
                        if let Some(path) = path {
                            window.paint_path(path, fill);
                        }
                    },
                )
                .absolute()
                .size_full(),
            )
            .when_some(percentage_label, |this, label| {
                this.child(
                    div()
                        .text_size(text_size)
                        .text_color(text_color)
                        .child(label),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indeterminate_progress_has_no_percentage_label() {
        let ring = CircularProgress::new(px(80.), px(6.), gpui::black(), gpui::white())
            .label(gpui::white(), px(14.))
            .indeterminate();
        assert_eq!(ring.percentage_label(), None);
    }

    #[test]
    fn determinate_progress_labels_only_measured_progress() {
        for (fraction, expected) in [(0., "0%"), (0.25, "25%"), (1., "100%")] {
            let ring = CircularProgress::new(px(80.), px(6.), gpui::black(), gpui::white())
                .label(gpui::white(), px(14.))
                .progress(fraction);
            assert_eq!(ring.percentage_label().as_deref(), Some(expected));
        }
    }
}

#[cfg(test)]
#[path = "progress_tests.rs"]
mod render_tests;
