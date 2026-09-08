//! The in-app colour picker -- the popover a swatch opens.
//!
//! The Solid app leans on `<input type="color">` (`color-utils.tsx:52-64`),
//! which macOS renders as the floating `NSColorPanel` -- detached from the
//! swatch, parked wherever the OS last left it, and absent entirely on the
//! Windows/Linux builds of this app. This component replaces that seam with a
//! panel anchored to the swatch itself: a saturation/value field, a hue rail,
//! and the live swatch + hex entry, all drawn by gpui so every platform gets
//! the same picker.
//!
//! The maths is the standard HSV cylinder. The field is two layered
//! gradients -- white->hue left to right, transparent->black top to bottom --
//! which is exactly the `s`/`v` plane for the current hue, so the picture *is*
//! the model rather than an approximation of it.
//!
//! State lives with the caller (the editor window), as [`crate::ui::Menu`]'s
//! does: this element is a pure function of a [`ColorPickerSnapshot`] plus
//! callbacks, and the pointer->value conversions are exposed as free
//! functions so the caller's window-wide drag layer can keep converting after
//! the pointer leaves the panel.

use gpui::{
    App, Hsla, InteractiveElement, IntoElement, MouseButton, MouseDownEvent, ParentElement, Pixels,
    Point, RenderOnce, Rgba, Styled, Window, div, linear_color_stop, linear_gradient, point, px,
};

use crate::theme::Theme;

// ---------------------------------------------------------------------------
// Geometry -- fixed, so pointer maths never needs a layout pass.
// ---------------------------------------------------------------------------

pub const PANEL_WIDTH: f32 = 264.;
pub const PANEL_HEIGHT: f32 = PAD + SV_HEIGHT + GAP + HUE_HEIGHT + GAP + ROW_HEIGHT + PAD;

const PAD: f32 = 12.;
const GAP: f32 = 12.;
const SV_WIDTH: f32 = PANEL_WIDTH - PAD * 2.;
const SV_HEIGHT: f32 = 160.;
const HUE_HEIGHT: f32 = 14.;
const ROW_HEIGHT: f32 = 32.;
const THUMB: f32 = 14.;

/// The saturation/value field's rectangle, relative to the panel's top-left.
fn sv_offset() -> Point<f32> {
    point(PAD, PAD)
}

/// The hue rail's rectangle, relative to the panel's top-left.
fn hue_offset() -> Point<f32> {
    point(PAD, PAD + SV_HEIGHT + GAP)
}

/// Pointer -> `(saturation, value)`, given the panel's window origin.
pub fn sv_from_point(origin: Point<Pixels>, position: Point<Pixels>) -> (f32, f32) {
    let offset = sv_offset();
    let x = f32::from(position.x) - f32::from(origin.x) - offset.x;
    let y = f32::from(position.y) - f32::from(origin.y) - offset.y;
    let sat = (x / SV_WIDTH).clamp(0., 1.);
    let val = 1. - (y / SV_HEIGHT).clamp(0., 1.);
    (sat, val)
}

/// Pointer -> hue in degrees, given the panel's window origin.
pub fn hue_from_point(origin: Point<Pixels>, position: Point<Pixels>) -> f32 {
    let offset = hue_offset();
    let x = f32::from(position.x) - f32::from(origin.x) - offset.x;
    (x / SV_WIDTH).clamp(0., 1.) * 360.
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

/// HSV -> RGB, hue in degrees, `s`/`v` in `[0, 1]`.
pub fn hsv_to_rgb(hue: f32, sat: f32, val: f32) -> [u8; 3] {
    let hue = hue.rem_euclid(360.) / 60.;
    let chroma = val * sat;
    let x = chroma * (1. - (hue % 2. - 1.).abs());
    let (r, g, b) = match hue as u32 {
        0 => (chroma, x, 0.),
        1 => (x, chroma, 0.),
        2 => (0., chroma, x),
        3 => (0., x, chroma),
        4 => (x, 0., chroma),
        _ => (chroma, 0., x),
    };
    let m = val - chroma;
    let byte = |v: f32| ((v + m) * 255.).round().clamp(0., 255.) as u8;
    [byte(r), byte(g), byte(b)]
}

/// RGB -> `(hue, saturation, value)`.
///
/// A grey has no hue of its own; `0` comes back so a fresh picker on black or
/// white starts at red, which is what every OS picker does.
pub fn rgb_to_hsv(rgb: [u8; 3]) -> (f32, f32, f32) {
    let r = rgb[0] as f32 / 255.;
    let g = rgb[1] as f32 / 255.;
    let b = rgb[2] as f32 / 255.;
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;

    let hue = if delta <= f32::EPSILON {
        0.
    } else if max == r {
        60. * (((g - b) / delta).rem_euclid(6.))
    } else if max == g {
        60. * ((b - r) / delta + 2.)
    } else {
        60. * ((r - g) / delta + 4.)
    };
    let sat = if max <= 0. { 0. } else { delta / max };
    (hue, sat, max)
}

fn rgb_hsla(rgb: [u8; 3]) -> Hsla {
    Hsla::from(Rgba {
        r: rgb[0] as f32 / 255.,
        g: rgb[1] as f32 / 255.,
        b: rgb[2] as f32 / 255.,
        a: 1.,
    })
}

/// `getColorPreviewBorderColor` (`color-utils.tsx:7-9`):
/// `color-mix(in srgb, color 82%, black)`.
pub fn preview_ring(rgb: [u8; 3]) -> Hsla {
    let mix = |c: u8| (c as f32 * 0.82) / 255.;
    Hsla::from(Rgba {
        r: mix(rgb[0]),
        g: mix(rgb[1]),
        b: mix(rgb[2]),
        a: 1.,
    })
}

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

/// What the caller holds while the picker is open.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorPickerSnapshot {
    /// Panel top-left, window coordinates.
    pub origin: Point<Pixels>,
    pub hue: f32,
    pub sat: f32,
    pub val: f32,
}

impl ColorPickerSnapshot {
    pub fn new(origin: Point<Pixels>, rgb: [u8; 3]) -> Self {
        let (hue, sat, val) = rgb_to_hsv(rgb);
        Self {
            origin,
            hue,
            sat,
            val,
        }
    }

    pub fn rgb(&self) -> [u8; 3] {
        hsv_to_rgb(self.hue, self.sat, self.val)
    }

    /// Clamp the panel inside the viewport: preferred spot is just under the
    /// anchor point, flipped above it when the bottom edge would clip.
    pub fn place(anchor: Point<Pixels>, viewport: gpui::Size<Pixels>, rgb: [u8; 3]) -> Self {
        let x = f32::from(anchor.x)
            .min(f32::from(viewport.width) - PANEL_WIDTH - 12.)
            .max(12.);
        let below = f32::from(anchor.y) + 12.;
        let y = if below + PANEL_HEIGHT + 12. > f32::from(viewport.height) {
            (f32::from(anchor.y) - 12. - PANEL_HEIGHT).max(12.)
        } else {
            below
        };
        Self::new(point(px(x), px(y)), rgb)
    }
}

type PointerHandler = Box<dyn Fn(&MouseDownEvent, &mut Window, &mut App) + 'static>;

/// The panel. The caller wraps it in its own full-window layer (backdrop +
/// drag surface), exactly as it wraps [`crate::ui::Menu`].
#[derive(IntoElement)]
pub struct ColorPicker {
    theme: Theme,
    snapshot: ColorPickerSnapshot,
    hex_field: Option<gpui::AnyElement>,
    on_sv_down: Option<PointerHandler>,
    on_hue_down: Option<PointerHandler>,
}

impl ColorPicker {
    pub fn new(theme: &Theme, snapshot: ColorPickerSnapshot) -> Self {
        Self {
            theme: *theme,
            snapshot,
            hex_field: None,
            on_sv_down: None,
            on_hue_down: None,
        }
    }

    /// The hex entry beside the live swatch -- the caller owns the
    /// `TextInputState` so commits run through the same handler as the
    /// sidebar's own hex fields.
    pub fn hex_field(mut self, field: gpui::AnyElement) -> Self {
        self.hex_field = Some(field);
        self
    }

    pub fn on_sv_down(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_sv_down = Some(Box::new(handler));
        self
    }

    pub fn on_hue_down(
        mut self,
        handler: impl Fn(&MouseDownEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_hue_down = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for ColorPicker {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let ColorPicker {
            theme,
            snapshot,
            hex_field,
            on_sv_down,
            on_hue_down,
        } = self;

        let rgb = snapshot.rgb();
        let hue_rgb = hsv_to_rgb(snapshot.hue, 1., 1.);
        let sv_thumb = point(
            snapshot.sat * SV_WIDTH - THUMB / 2.,
            (1. - snapshot.val) * SV_HEIGHT - THUMB / 2.,
        );
        let hue_thumb_x = snapshot.hue / 360. * SV_WIDTH - THUMB / 2.;

        // The six two-stop legs of the hue rail: gpui gradients carry two
        // stops, so the rainbow is six of them end to end.
        const HUE_LEGS: [([u8; 3], [u8; 3]); 6] = [
            ([255, 0, 0], [255, 255, 0]),
            ([255, 255, 0], [0, 255, 0]),
            ([0, 255, 0], [0, 255, 255]),
            ([0, 255, 255], [0, 0, 255]),
            ([0, 0, 255], [255, 0, 255]),
            ([255, 0, 255], [255, 0, 0]),
        ];

        div()
            .id("color-picker-panel")
            .absolute()
            .left(snapshot.origin.x)
            .top(snapshot.origin.y)
            .w(px(PANEL_WIDTH))
            .flex()
            .flex_col()
            .p(px(PAD))
            .gap(px(GAP))
            .rounded(px(12.))
            .border_1()
            .border_color(Hsla::from(theme.gray_3))
            .bg(Hsla::from(theme.gray_1))
            .shadow_md()
            // A press on the panel body must not fall through to the
            // caller's click-away backdrop underneath.
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .id("color-picker-sv")
                    .relative()
                    .w(px(SV_WIDTH))
                    .h(px(SV_HEIGHT))
                    .rounded(px(8.))
                    .overflow_hidden()
                    .bg(linear_gradient(
                        90.,
                        linear_color_stop(gpui::white(), 0.),
                        linear_color_stop(rgb_hsla(hue_rgb), 1.),
                    ))
                    .child(div().size_full().bg(linear_gradient(
                        180.,
                        linear_color_stop(gpui::transparent_black(), 0.),
                        linear_color_stop(gpui::black(), 1.),
                    )))
                    .child(
                        div()
                            .absolute()
                            .left(px(sv_thumb.x))
                            .top(px(sv_thumb.y))
                            .size(px(THUMB))
                            .rounded_full()
                            .border_2()
                            .border_color(gpui::white())
                            .bg(rgb_hsla(rgb))
                            .shadow_sm(),
                    )
                    .when_some_mouse_down(on_sv_down),
            )
            .child(
                div()
                    .id("color-picker-hue")
                    .relative()
                    .w(px(SV_WIDTH))
                    .h(px(HUE_HEIGHT))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .w_full()
                            .h_full()
                            .rounded_full()
                            .overflow_hidden()
                            .children(HUE_LEGS.iter().map(|(from, to)| {
                                div().flex_1().h_full().bg(linear_gradient(
                                    90.,
                                    linear_color_stop(rgb_hsla(*from), 0.),
                                    linear_color_stop(rgb_hsla(*to), 1.),
                                ))
                            })),
                    )
                    .child(
                        div()
                            .absolute()
                            .left(px(hue_thumb_x))
                            .top(px((HUE_HEIGHT - THUMB) / 2.))
                            .size(px(THUMB))
                            .rounded_full()
                            .border_2()
                            .border_color(gpui::white())
                            .bg(rgb_hsla(hue_rgb))
                            .shadow_sm(),
                    )
                    .when_some_mouse_down(on_hue_down),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .h(px(ROW_HEIGHT))
                    .child(
                        div()
                            .size(px(32.))
                            .rounded(px(8.))
                            .flex_none()
                            .bg(rgb_hsla(rgb))
                            .border_1()
                            .border_color(preview_ring(rgb)),
                    )
                    .children(hex_field),
            )
    }
}

/// `.when_some(handler, ...)` reads poorly on two elements in a row; a tiny
/// extension keeps the pointer-down wiring uniform.
trait MouseDownExt {
    fn when_some_mouse_down(self, handler: Option<PointerHandler>) -> Self;
}

impl<T> MouseDownExt for T
where
    T: InteractiveElement + Sized,
{
    fn when_some_mouse_down(mut self, handler: Option<PointerHandler>) -> Self {
        if let Some(handler) = handler {
            self.interactivity()
                .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                    handler(event, window, cx)
                });
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hsv_round_trips_the_primaries() {
        for rgb in [
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [255, 255, 0],
            [0, 255, 255],
            [255, 0, 255],
            [255, 255, 255],
            [0, 0, 0],
        ] {
            let (h, s, v) = rgb_to_hsv(rgb);
            assert_eq!(hsv_to_rgb(h, s, v), rgb, "{rgb:?}");
        }
    }

    #[test]
    fn hsv_round_trips_arbitrary_colors_within_a_byte() {
        for rgb in [[71, 133, 255], [18, 52, 86], [200, 100, 50], [1, 2, 3]] {
            let (h, s, v) = rgb_to_hsv(rgb);
            let back = hsv_to_rgb(h, s, v);
            for (a, b) in rgb.iter().zip(back.iter()) {
                assert!(a.abs_diff(*b) <= 1, "{rgb:?} -> {back:?}");
            }
        }
    }

    #[test]
    fn greys_report_zero_hue_and_saturation() {
        let (h, s, v) = rgb_to_hsv([128, 128, 128]);
        assert_eq!(h, 0.);
        assert_eq!(s, 0.);
        assert!((v - 128. / 255.).abs() < 1e-6);
    }

    #[test]
    fn the_field_maps_corners_to_the_hsv_extremes() {
        let origin = point(px(100.), px(100.));
        // Top-left of the field: white -- zero saturation, full value.
        let top_left = point(px(100. + PAD), px(100. + PAD));
        assert_eq!(sv_from_point(origin, top_left), (0., 1.));
        // Bottom-right: the pure hue at full saturation, zero value.
        let bottom_right = point(px(100. + PAD + SV_WIDTH), px(100. + PAD + SV_HEIGHT));
        assert_eq!(sv_from_point(origin, bottom_right), (1., 0.));
        // Outside clamps rather than escaping the cylinder.
        let outside = point(px(0.), px(1000.));
        assert_eq!(sv_from_point(origin, outside), (0., 0.));
    }

    #[test]
    fn the_hue_rail_spans_the_circle() {
        let origin = point(px(0.), px(0.));
        let rail_y = px(hue_offset().y + 1.);
        assert_eq!(hue_from_point(origin, point(px(PAD), rail_y)), 0.);
        let end = hue_from_point(origin, point(px(PAD + SV_WIDTH), rail_y));
        assert_eq!(end, 360.);
        let mid = hue_from_point(origin, point(px(PAD + SV_WIDTH / 2.), rail_y));
        assert!((mid - 180.).abs() < 0.5, "{mid}");
    }

    #[test]
    fn placement_flips_above_the_anchor_near_the_bottom() {
        let viewport = gpui::size(px(1200.), px(800.));
        let low = ColorPickerSnapshot::place(point(px(50.), px(700.)), viewport, [0, 0, 0]);
        assert!(f32::from(low.origin.y) + PANEL_HEIGHT <= 700.);
        let high = ColorPickerSnapshot::place(point(px(50.), px(100.)), viewport, [0, 0, 0]);
        assert_eq!(f32::from(high.origin.y), 112.);
    }
}
