//! `Tooltip` -- `apps/desktop/src/components/Tooltip.tsx`, a Kobalte `Tooltip`
//! with an OS-aware kbd-chip renderer built in.
//!
//! gpui already owns the hover/dismiss half of the contract: `.tooltip(..)` on
//! any interactive element shows a view after `tooltip_show_delay` and hides it
//! on mouse-leave. What it does not own is the *look*, or the kbd chips, which
//! is what this is. `openDelay={200}` is the Solid default and the default
//! here.
//!
//! Not reproduced: the forced-open override the Solid `Slider` uses to pin a
//! value tooltip to the thumb mid-drag, and `getAnchorRect`. gpui's tooltip is
//! pointer-anchored and hover-driven only, so a slider that wants a live value
//! readout draws one itself -- which is what `GradientEditor` does anyway with
//! its redundant numeric readout beside the slider.

use std::time::Duration;

use gpui::{
    App, AppContext, Context, FontWeight, Hsla, IntoElement, ParentElement, Render, SharedString,
    Styled, Window, div, px,
};

use crate::{
    theme::Theme,
    ui::kbd::{KbdChip, kbd_symbol},
};

/// `openDelay={200}`.
pub const TOOLTIP_SHOW_DELAY: Duration = Duration::from_millis(200);

/// The two looks the app uses: the dark bubble, and `ComingSoonTooltip`'s pill
/// (which is the same bubble with an instant delay and fixed text).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TooltipStyle {
    /// `border border-gray-3 bg-gray-12 text-gray-1 rounded-md shadow-lg`.
    Dark,
    /// `bg-gray-2 text-gray-12 border border-gray-3 rounded-lg` -- the
    /// `TooltipIconButton` variant, meant to sit on a light page.
    Light,
}

/// A tooltip body. Build it with [`Tooltip::view`] and hand that to
/// `.tooltip(..)`.
pub struct Tooltip {
    label: SharedString,
    keys: Vec<SharedString>,
    style: TooltipStyle,
    theme: Theme,
}

impl Tooltip {
    pub fn new(theme: &Theme, label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            keys: Vec::new(),
            style: TooltipStyle::Dark,
            theme: *theme,
        }
    }

    /// `ComingSoonTooltip`: always the literal text, instant delay at the call
    /// site (`openDelay={0} closeDelay={0}`).
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

    pub fn style(mut self, style: TooltipStyle) -> Self {
        self.style = style;
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
        let (bg, text, border): (Hsla, Hsla, Hsla) = match self.style {
            TooltipStyle::Dark => (theme.gray(12), theme.gray(1), theme.gray(3)),
            TooltipStyle::Light => (theme.gray(2), theme.gray(12), theme.gray(3)),
        };
        let keys = self.keys.clone();

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .min_w(px(24.))
            .px(px(6.))
            .py(px(4.))
            .rounded(px(6.))
            .border_1()
            .border_color(border)
            .bg(bg)
            .text_size(px(12.))
            .text_color(text)
            .font_weight(FontWeight::MEDIUM)
            .shadow_lg()
            .child(self.label.clone())
            .children(
                keys.into_iter()
                    .map(|key| KbdChip::tooltip(&theme, key.as_ref())),
            )
    }
}
