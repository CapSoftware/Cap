use std::time::{Duration, Instant};

use cap_notes_ui::NotesTheme;
use gpui::{
    BoxShadow, Div, Hsla, IntoElement, ParentElement, SharedString, Styled, div, hsla, point, px,
    rgb, rgba,
};

use crate::{
    doodle::{self, Doodle},
    theme::{Theme, UI_FONT},
};

pub const TOOLBAR_HEIGHT: f32 = 52.;
pub const SIDEBAR_WIDTH: f32 = 220.;
pub const COLUMN_WIDTH: f32 = 680.;
pub const DOCK_WIDTH: f32 = 600.;
pub const NARROW_BREAKPOINT: f32 = 520.;
pub const MATERIAL_RADIUS: f64 = super::glass::WINDOW_RADIUS as f64;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub dark: bool,
    /// The window's native glass is live and shown (a material installed
    /// and Reduce Transparency off), so the chrome may let it through.
    pub glass: bool,
    pub sidebar: Hsla,
    pub content: Hsla,
    pub card: Hsla,
    pub track: Hsla,
    pub text: Hsla,
    pub muted: Hsla,
    pub faint: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    pub hairline: Hsla,
    pub field: Hsla,
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub on_ink: Hsla,
    pub green: Hsla,
    pub danger: Hsla,
    pub warning: Hsla,
    pub warning_soft: Hsla,
    pub live: Hsla,
    pub capsule: Hsla,
    pub capsule_border: Hsla,
    pub popover: Hsla,
    pub popover_border: Hsla,
    pub highlight: Hsla,
}

/// Speaker colours as (hue, saturation, lightness on light, on dark). Every
/// name reads at 4.5:1 on the page in both themes, and each pair stays apart
/// for red-green and blue-yellow colour blindness, not only by hue. Six,
/// not eight: AA text on a light page squeezes the whole yellow to cyan half
/// of the wheel into dark greens, so two more would be near twins.
pub const SPEAKERS: [(f32, f32, f32, f32); 6] = [
    (282., 0.46, 0.33, 0.59),
    (167., 0.53, 0.20, 0.72),
    (11., 0.50, 0.32, 0.70),
    (336., 0.56, 0.43, 0.64),
    (203., 0.48, 0.40, 0.68),
    (40., 0.62, 0.34, 0.75),
];

fn alpha(color: Hsla, a: f32) -> Hsla {
    Hsla { a, ..color }
}

impl Palette {
    pub fn new(theme: &Theme) -> Self {
        let dark = theme.is_dark();
        let (content, card, ink, soft, accent, red, green, track, amber): (
            Hsla,
            Hsla,
            Hsla,
            Hsla,
            Hsla,
            Hsla,
            Hsla,
            Hsla,
            Hsla,
        ) = if dark {
            (
                rgb(0x18181b).into(),
                rgba(0xffffff0d).into(),
                rgb(0xf2f2f3).into(),
                rgb(0x8e8e96).into(),
                rgb(0x4d8dff).into(),
                rgb(0xff6369).into(),
                rgb(0x3dd68c).into(),
                rgb(0x3a3a40).into(),
                rgb(0xf5b84a).into(),
            )
        } else {
            (
                rgb(0xfbfaf7).into(),
                rgba(0xffffffa6).into(),
                rgb(0x20242c).into(),
                rgb(0x8b8f98).into(),
                rgb(0x4785ff).into(),
                rgb(0xe5484d).into(),
                rgb(0x2f9e69).into(),
                rgb(0xdcdcd4).into(),
                rgb(0xb7791f).into(),
            )
        };
        let glass = theme.material.is_some() && !super::glass::reduce_transparency();
        let sidebar = if glass {
            super::glass::sidebar_wash(dark)
        } else if dark {
            rgb(0x131315).into()
        } else {
            rgb(0xf3f2ed).into()
        };
        Self {
            dark,
            glass,
            sidebar,
            content,
            card,
            track,
            text: ink,
            muted: soft,
            faint: alpha(ink, if dark { 0.36 } else { 0.34 }),
            hover: alpha(ink, if dark { 0.06 } else { 0.045 }),
            selected: alpha(ink, if dark { 0.10 } else { 0.075 }),
            hairline: alpha(ink, if dark { 0.09 } else { 0.08 }),
            field: alpha(ink, if dark { 0.07 } else { 0.05 }),
            accent,
            accent_soft: alpha(accent, if dark { 0.18 } else { 0.10 }),
            on_ink: content,
            green,
            danger: red,
            warning: amber,
            warning_soft: if dark {
                alpha(amber, 0.16)
            } else {
                rgb(0xfdf3dc).into()
            },
            live: red,
            capsule: if dark {
                rgb(0x232327).into()
            } else {
                gpui::white()
            },
            capsule_border: if dark { track } else { alpha(ink, 0.10) },
            popover: if dark {
                rgb(0x232327).into()
            } else {
                gpui::white()
            },
            popover_border: if dark { track } else { alpha(ink, 0.10) },
            highlight: alpha(amber, if dark { 0.30 } else { 0.22 }),
        }
    }

    pub fn shadow(&self) -> Vec<BoxShadow> {
        vec![
            BoxShadow {
                color: hsla(0., 0., 0., if self.dark { 0.38 } else { 0.08 }),
                offset: point(px(0.), px(8.)),
                blur_radius: px(24.),
                spread_radius: px(0.),
                inset: false,
            },
            BoxShadow {
                color: hsla(0., 0., 0., if self.dark { 0.30 } else { 0.05 }),
                offset: point(px(0.), px(1.)),
                blur_radius: px(3.),
                spread_radius: px(0.),
                inset: false,
            },
        ]
    }

    pub fn speaker(&self, index: usize) -> Hsla {
        let (hue, saturation, light, dark) = SPEAKERS[index % SPEAKERS.len()];
        hsla(
            hue / 360.,
            saturation,
            if self.dark { dark } else { light },
            1.,
        )
    }

    pub fn doodle(&self) -> doodle::Palette {
        doodle::Palette {
            ink: self.text,
            soft: self.muted,
            accent: self.accent,
            red: self.danger,
            green: self.green,
            track: self.track,
        }
    }

    pub fn warning_doodle(&self) -> doodle::Palette {
        doodle::Palette {
            red: self.warning,
            ..self.doodle()
        }
    }

    pub fn paper_card(&self) -> Div {
        div()
            .rounded(px(20.))
            .border(px(1.5))
            .border_color(self.track)
            .bg(self.card)
    }
}

pub fn notes_theme(theme: &Theme) -> NotesTheme {
    let palette = Palette::new(theme);
    let mut notes = if palette.dark {
        NotesTheme::dark()
    } else {
        NotesTheme::light()
    };
    notes.background = gpui::transparent_black();
    notes.page = palette.content;
    notes.ink = palette.text;
    notes.ink_secondary = alpha(palette.text, if palette.dark { 0.64 } else { 0.62 });
    notes.ink_tertiary = palette.faint;
    notes.accent = palette.accent;
    notes.selection = alpha(palette.accent, if palette.dark { 0.32 } else { 0.22 });
    notes.popover_fill = palette.popover;
    notes.popover_border = palette.popover_border;
    notes.popover_highlight = palette.accent_soft;
    notes.popover_text = palette.text;
    notes.popover_muted = palette.muted;
    notes.body_font = SharedString::from(UI_FONT);
    notes.top_padding = px(14.);
    notes.max_content_width = px(COLUMN_WIDTH);
    notes.narrow_breakpoint = px(NARROW_BREAKPOINT);
    notes
}

pub fn column_padding(width: f32) -> f32 {
    if width < NARROW_BREAKPOINT { 16. } else { 32. }
}

static REDUCE_MOTION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_reduce_motion(reduce: bool) {
    REDUCE_MOTION.store(reduce, std::sync::atomic::Ordering::Relaxed);
}

pub fn reduce_motion() -> bool {
    REDUCE_MOTION.load(std::sync::atomic::Ordering::Relaxed)
}

/// A doodle that draws itself on once and then holds still: a working window
/// must not keep repainting to boil ink nobody is looking at.
pub fn art(
    art: &'static Doodle,
    palette: doodle::Palette,
    shown_at: Instant,
    width: f32,
    height: f32,
) -> impl IntoElement {
    let settled = Duration::from_millis(u64::from(art.settled_at()) + 120);
    let still = reduce_motion() || shown_at.elapsed() >= settled;
    doodle::doodle(art, palette, shown_at, still, width, height)
}

/// The paper fading out under a docked bar, so rows slide beneath it rather
/// than butting into it.
pub fn dock_fade(palette: &Palette, height: f32) -> Div {
    div()
        .absolute()
        .bottom_0()
        .left_0()
        .right_0()
        .h(px(height))
        .bg(gpui::linear_gradient(
            180.,
            gpui::linear_color_stop(alpha(palette.content, 0.), 0.),
            gpui::linear_color_stop(palette.content, 0.7),
        ))
}

/// Behind a dock that stacks lines over the bar: solid up to the top of the
/// dock, so no text shows through between its rows, then a short fade.
pub fn dock_backdrop(palette: &Palette, solid: f32, fade: f32) -> Div {
    div()
        .absolute()
        .bottom_0()
        .left_0()
        .right_0()
        .h(px(solid + fade))
        .bg(gpui::linear_gradient(
            180.,
            gpui::linear_color_stop(alpha(palette.content, 0.), 0.),
            gpui::linear_color_stop(palette.content, fade / (solid + fade)),
        ))
}

pub fn heading(palette: &Palette, title: impl Into<SharedString>, shown_at: Instant) -> Div {
    div()
        .flex()
        .flex_col()
        .child(
            div()
                .text_size(px(28.))
                .line_height(px(34.))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(palette.text)
                .child(title.into()),
        )
        .child(div().mt(px(2.)).ml(px(-2.)).child(art(
            &crate::onboarding_doodles::UNDERLINE,
            palette.doodle(),
            shown_at,
            110.,
            10.,
        )))
}

/// How many speakers can be told apart by colour (see [`Palette::speaker`]).
pub const SPEAKER_COLOURS: usize = SPEAKERS.len();

pub fn ink_pill(palette: &Palette, id: impl Into<gpui::ElementId>) -> gpui::Stateful<Div> {
    use gpui::{InteractiveElement, StatefulInteractiveElement};
    let palette = *palette;
    div()
        .id(id)
        .role(gpui::Role::Button)
        .h(px(34.))
        .px(px(16.))
        .flex()
        .items_center()
        .gap(px(7.))
        .rounded_full()
        .bg(palette.text)
        .text_color(palette.on_ink)
        .text_size(px(13.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .cursor_pointer()
        .hover(|s| s.opacity(0.88))
}

pub fn quiet_pill(palette: &Palette, id: impl Into<gpui::ElementId>) -> gpui::Stateful<Div> {
    use gpui::{InteractiveElement, StatefulInteractiveElement};
    let palette = *palette;
    div()
        .id(id)
        .role(gpui::Role::Button)
        .h(px(30.))
        .px(px(13.))
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded_full()
        .border(px(1.5))
        .border_color(palette.track)
        .text_color(palette.text)
        .text_size(px(13.))
        .font_weight(gpui::FontWeight::MEDIUM)
        .cursor_pointer()
        .hover(move |s| s.bg(palette.hover))
}

pub fn icon_button(
    palette: &Palette,
    id: impl Into<gpui::ElementId>,
    icon: &'static str,
    size: f32,
    label: impl Into<SharedString>,
) -> gpui::Stateful<Div> {
    use gpui::{InteractiveElement, StatefulInteractiveElement};
    let palette = *palette;
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label)
        .size(px(size))
        .flex()
        .flex_shrink_0()
        .items_center()
        .justify_center()
        .rounded_full()
        .cursor_pointer()
        .hover(move |s| s.bg(palette.hover))
        .child(
            gpui::svg()
                .path(icon)
                .size(px((size * 0.5).round()))
                .text_color(palette.muted),
        )
}
