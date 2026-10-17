use std::time::Duration;

use gpui::{
    App, AppContext, Context, FontWeight, IntoElement, ParentElement, Render, SharedString, Styled,
    Window, div, px, svg,
};

use crate::{
    theme::{RadiusToken, Theme, radius},
    ui::kbd::{KbdChip, kbd_symbol},
};

pub const TOOLTIP_SHOW_DELAY: Duration = Duration::from_millis(500);

const TAIL: &str = "ui/tooltip-pointer.svg";
const TAIL_SIZE: f32 = 10.;
const TAIL_LEFT: f32 = 8.;
/// Far enough below the pointer hotspot to clear the system arrow cursor.
const BODY_TOP: f32 = 20.;

/// A tooltip body. Build it with [`Tooltip::view`] and hand that to
/// `.tooltip(..)`.
pub struct Tooltip {
    label: SharedString,
    keys: Vec<SharedString>,
    theme: Theme,
}

impl Tooltip {
    pub fn new(theme: &Theme, label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            keys: Vec::new(),
            theme: *theme,
        }
    }

    pub fn coming_soon(theme: &Theme) -> Self {
        Self::new(theme, "Coming Soon")
    }

    /// `EditorButton`'s `kbd` prop: one chip per key, in order.
    pub fn keys<I, S>(mut self, keys: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.keys = keys
            .into_iter()
            .map(|key| kbd_symbol(key.as_ref()))
            .collect();
        self
    }

    /// Build the view `.tooltip(..)` wants.
    pub fn view(self, cx: &mut App) -> gpui::AnyView {
        cx.new(|_| self).into()
    }
}

impl Render for Tooltip {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let keys = self.keys.clone();

        // GPUI places a tooltip 1px from the pointer hotspot, under the
        // cursor bitmap; the transparent inset drops the body below the
        // cursor, and the tail points back up at it. The tail is a border
        // diamond with a surface diamond 1px lower on top, so only its two
        // upper edges keep the border and the body's top border is covered
        // where they meet.
        let tail = |color: gpui::Hsla, top: f32| {
            svg()
                .path(TAIL)
                .absolute()
                .left(px(TAIL_LEFT))
                .top(px(top))
                .size(px(TAIL_SIZE))
                .text_color(color)
        };
        div()
            .relative()
            .pt(px(BODY_TOP))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .max_w(px(320.))
                    .px(px(8.))
                    .py(px(4.))
                    .rounded(radius(RadiusToken::Small))
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.surface)
                    .font_family(crate::theme::ui_font())
                    .text_size(px(12.))
                    .text_color(theme.text_primary)
                    .font_weight(FontWeight::NORMAL)
                    .child(self.label.clone())
                    .children(
                        keys.into_iter()
                            .map(|key| KbdChip::tooltip(&theme, key.as_ref())),
                    ),
            )
            .child(tail(theme.border.into(), BODY_TOP - TAIL_SIZE / 2.))
            .child(tail(theme.surface.into(), BODY_TOP - TAIL_SIZE / 2. + 1.))
    }
}
