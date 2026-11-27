//! The notes window's surface tokens: capsules, chips, rows and the glass
//! they sit on. One place, so other document windows (the Library) match.
//!
//! Live blur only ever comes from the OS window material behind the window.
//! Everything drawn inside the window is painted (fill, lit lip, hairline,
//! contact shadow), so typing and scrolling cost the same as plain fills.

use gpui::{
    BoxShadow, Div, ElementId, FocusHandle, Hsla, InteractiveElement, ParentElement, Stateful,
    StatefulInteractiveElement, Styled, div, hsla, point, prelude::FluentBuilder, px,
};

use super::style::Palette;

/// Window corners: the titled window frame's own radius on macOS 26 and 27
/// (see `platform::install_window_material`). Anything larger leaves the
/// frame's edge showing outside the content's corners.
pub const WINDOW_RADIUS: f32 = 16.;
pub const ROW_HEIGHT: f32 = 28.;
pub const ROW_RADIUS: f32 = 8.;
pub const SECTION_TITLE_SIZE: f32 = 11.5;
pub const CHIP_HEIGHT: f32 = 28.;
pub const CAPSULE_HEIGHT: f32 = 32.;

fn alpha(color: Hsla, a: f32) -> Hsla {
    Hsla { a, ..color }
}

/// The system's Reduce Transparency: glass gives way to solid tones.
pub fn reduce_transparency() -> bool {
    #[cfg(target_os = "macos")]
    {
        objc2_app_kit::NSWorkspace::sharedWorkspace().accessibilityDisplayShouldReduceTransparency()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// What the sidebar paints over the window's glass: enough to keep its text
/// legible over any desktop, little enough that the glass reads as glass.
pub fn sidebar_wash(dark: bool) -> Hsla {
    if dark {
        hsla(240. / 360., 0.04, 0.11, 0.50)
    } else {
        hsla(0., 0., 1., 0.45)
    }
}

/// A toolbar group: icon buttons sharing one capsule, as on the system's
/// toolbars. Over the glass sidebar it is only a tint (no glass on glass).
pub fn toolbar_group(palette: &Palette) -> Div {
    let capsule = Capsule::new(palette);
    div()
        .h(px(CAPSULE_HEIGHT))
        .px(px(2.))
        .flex()
        .items_center()
        .gap(px(0.))
        .rounded_full()
        .border(px(1.))
        .border_color(capsule.border)
        .bg(capsule.fill)
        .shadow(capsule.shadows())
}

/// One button inside a [`toolbar_group`].
pub fn toolbar_button(
    palette: &Palette,
    id: impl Into<ElementId>,
    icon: &'static str,
) -> Stateful<Div> {
    let palette = *palette;
    div()
        .id(id)
        .h(px(CAPSULE_HEIGHT - 6.))
        .w(px(34.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .hover(move |s| s.bg(palette.hover))
        .active(move |s| s.bg(palette.selected))
        .child(
            gpui::svg()
                .path(icon)
                .size(px(15.))
                .text_color(alpha(palette.text, 0.72)),
        )
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Capsule {
    pub fill: Hsla,
    pub hover: Hsla,
    pub pressed: Hsla,
    pub border: Hsla,
    pub hover_border: Hsla,
    pub ink: Hsla,
    pub hover_ink: Hsla,
    /// The lit top edge: a 1 px inset highlight that makes a fill read as a
    /// raised surface rather than a tinted patch of the page.
    pub lip: Hsla,
    pub shadow: Hsla,
}

/// `top` laid over `under`, as one opaque colour: capsules float over text,
/// which must never show through them.
fn over(top: Hsla, under: Hsla) -> Hsla {
    let (t, u) = (gpui::Rgba::from(top), gpui::Rgba::from(under));
    let mix = |a: f32, b: f32| a * t.a + b * (1. - t.a);
    gpui::Rgba {
        r: mix(t.r, u.r),
        g: mix(t.g, u.g),
        b: mix(t.b, u.b),
        a: 1.,
    }
    .into()
}

impl Capsule {
    pub fn new(palette: &Palette) -> Self {
        let page = palette.content;
        if palette.dark {
            Self {
                fill: over(hsla(0., 0., 1., 0.075), page),
                hover: over(hsla(0., 0., 1., 0.12), page),
                pressed: over(hsla(0., 0., 1., 0.05), page),
                border: hsla(0., 0., 1., 0.09),
                hover_border: hsla(0., 0., 1., 0.14),
                ink: alpha(palette.text, 0.80),
                hover_ink: palette.text,
                lip: hsla(0., 0., 1., 0.07),
                shadow: hsla(0., 0., 0., 0.30),
            }
        } else {
            Self {
                fill: over(hsla(0., 0., 1., 0.92), page),
                hover: hsla(0., 0., 1., 1.),
                pressed: over(alpha(palette.text, 0.06), page),
                border: alpha(palette.text, 0.10),
                hover_border: alpha(palette.text, 0.16),
                ink: alpha(palette.text, 0.78),
                hover_ink: palette.text,
                lip: hsla(0., 0., 1., 0.9),
                shadow: alpha(palette.text, 0.07),
            }
        }
    }

    pub fn shadows(&self) -> Vec<BoxShadow> {
        vec![
            BoxShadow {
                color: self.shadow,
                offset: point(px(0.), px(1.)),
                blur_radius: px(2.),
                spread_radius: px(0.),
                inset: false,
            },
            BoxShadow {
                color: self.lip,
                offset: point(px(0.), px(1.)),
                blur_radius: px(0.),
                spread_radius: px(0.),
                inset: true,
            },
        ]
    }
}

/// A 2 pt accent ring drawn outside the shape, shown only for keyboard focus.
pub fn focus_ring(palette: &Palette) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: alpha(palette.accent, 0.85),
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(2.),
        inset: false,
    }]
}

/// A suggested prompt: a raised capsule that reads as a button at rest, a
/// brighter one on hover, dips when pressed and rings on keyboard focus.
pub fn chip(palette: &Palette, id: impl Into<ElementId>, focus: &FocusHandle) -> Stateful<Div> {
    let capsule = Capsule::new(palette);
    let ring = focus_ring(palette);
    div()
        .id(id)
        .role(gpui::Role::Button)
        .when(palette.keyboard, crate::ui::keyboard_nav::stop)
        .track_focus(focus)
        .h(px(CHIP_HEIGHT))
        .px(px(12.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .rounded_full()
        .border(px(1.))
        .border_color(capsule.border)
        .bg(capsule.fill)
        .shadow(capsule.shadows())
        .text_size(px(12.5))
        .text_color(capsule.ink)
        .whitespace_nowrap()
        .cursor_pointer()
        .hover(move |s| {
            s.bg(capsule.hover)
                .border_color(capsule.hover_border)
                .text_color(capsule.hover_ink)
        })
        .active(move |s| s.bg(capsule.pressed).shadow(Vec::new()))
        .focus_visible(move |s| s.shadow(ring).text_color(capsule.hover_ink))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{Appearance, Theme};

    fn contrast(a: Hsla, b: Hsla) -> f32 {
        let l = |c: Hsla| {
            let c = gpui::Rgba::from(c);
            let f = |v: f32| {
                if v <= 0.04045 {
                    v / 12.92
                } else {
                    ((v + 0.055) / 1.055).powf(2.4)
                }
            };
            0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
        };
        let (x, y) = (l(a), l(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    /// A chip has to stand apart from the page at rest, not only on hover,
    /// and its label has to stay readable on its own fill.
    #[test]
    fn chips_read_as_buttons_in_both_themes() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let palette = Palette::new(&Theme::new(appearance));
            let capsule = Capsule::new(&palette);
            let edge = over(capsule.border, palette.content);
            assert!(
                contrast(edge, palette.content) > 1.12,
                "{appearance:?} chip edge vanishes into the page"
            );
            let fill = over(capsule.fill, palette.content);
            assert!(
                contrast(over(capsule.ink, fill), fill) >= 4.5,
                "{appearance:?} chip label below AA"
            );
            assert_ne!(
                capsule.hover, palette.hover,
                "chip hover must not match text hover"
            );
            for fill in [capsule.fill, capsule.hover, capsule.pressed] {
                assert!(
                    fill.a >= 0.999,
                    "{appearance:?} text would show through a chip"
                );
            }
        }
    }

    #[test]
    fn speaker_names_read_at_aa_in_both_themes() {
        for appearance in [Appearance::Light, Appearance::Dark] {
            let palette = Palette::new(&Theme::new(appearance));
            for i in 0..super::super::style::SPEAKERS.len() {
                let c = contrast(palette.speaker(i), palette.content);
                assert!(c >= 4.5, "{appearance:?} speaker {i} at {c:.2}");
            }
        }
    }
}
