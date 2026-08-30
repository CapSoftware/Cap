//! `Toggle` -- `apps/desktop/src/components/Toggle.tsx`, a Kobalte `Switch`.
//!
//! The `.cap-toggle` / `.cap-toggle-thumb` class names exist in the Solid app
//! *solely* so the macOS material layer can re-skin the track, which is why
//! this has one constructor per surface rather than one palette.

use gpui::{
    App, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px,
};

use crate::theme::Theme;

/// `cva` sizes. `lg` is `w-14 h-7 p-0.75` with a `size-6` thumb; no window
/// here uses it yet, but the scale is transcribed whole for the same reason
/// `Theme` carries the unused Radix steps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleSize {
    /// `w-9 h-5 p-0.5`, `size-4` thumb.
    Sm,
    /// `w-11 h-6 p-0.5`, `size-5` thumb -- the `cva` default.
    Md,
    /// `w-14 h-7 p-0.75`, `size-6` thumb.
    Lg,
}

impl ToggleSize {
    fn track(self) -> (Pixels, Pixels, Pixels) {
        match self {
            ToggleSize::Sm => (px(36.), px(20.), px(2.)),
            ToggleSize::Md => (px(44.), px(24.), px(2.)),
            ToggleSize::Lg => (px(56.), px(28.), px(3.)),
        }
    }

    fn thumb(self) -> Pixels {
        match self {
            ToggleSize::Sm => px(16.),
            ToggleSize::Md => px(20.),
            ToggleSize::Lg => px(24.),
        }
    }
}

#[derive(IntoElement)]
pub struct Toggle {
    id: ElementId,
    checked: bool,
    size: ToggleSize,
    /// `bg-gray-6`, or whatever the surface remaps it to.
    off_fill: Hsla,
    /// `data-checked:bg-blue-500`, or `--macos-settings-accent`.
    on_fill: Hsla,
    /// `bg-white` -- the thumb is white on every surface.
    thumb: Hsla,
    disabled: bool,
    on_click: Option<crate::ui::button::ClickHandler>,
}

impl Toggle {
    /// The plain Radix track: `bg-gray-6`, checked `bg-blue-500`.
    pub fn plain(theme: &Theme, id: impl Into<ElementId>, checked: bool) -> Self {
        Self {
            id: id.into(),
            checked,
            size: ToggleSize::Md,
            off_fill: Hsla::from(theme.gray_6),
            on_fill: Hsla::from(theme.blue_500),
            thumb: gpui::white(),
            disabled: false,
            on_click: None,
        }
    }

    /// The settings window: `[data-macos-native-material="settings"]
    /// .cap-toggle { background: var(--macos-settings-control-fill) }`, checked
    /// `var(--macos-settings-accent)`. The `inset 0 1px 2px rgba(0,0,0,.16)`
    /// bevel the same rule adds has no gpui equivalent (README deviation).
    pub fn settings(theme: &Theme, id: impl Into<ElementId>, checked: bool) -> Self {
        Self {
            size: ToggleSize::Sm,
            off_fill: theme
                .material
                .map(|material| Hsla::from(material.control_fill))
                .unwrap_or_else(|| Hsla::from(theme.gray_6)),
            on_fill: gpui::rgb(Theme::SETTINGS_ACCENT).into(),
            ..Self::plain(theme, id, checked)
        }
    }

    /// The teleprompter's settings popover: bare glass, so the track is a
    /// `gray-12/10` wash rather than a material token.
    pub fn glass(theme: &Theme, id: impl Into<ElementId>, checked: bool) -> Self {
        Self {
            size: ToggleSize::Sm,
            off_fill: Theme::with_alpha(theme.gray_12, 0.10),
            on_fill: gpui::rgb(Theme::SETTINGS_ACCENT).into(),
            ..Self::plain(theme, id, checked)
        }
    }

    pub fn size(mut self, size: ToggleSize) -> Self {
        self.size = size;
        self
    }

    /// `data-disabled:bg-gray-3`.
    pub fn disabled(mut self, theme: &Theme, disabled: bool) -> Self {
        self.disabled = disabled;
        if disabled && !self.checked {
            self.off_fill = Hsla::from(theme.gray_3);
        }
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for Toggle {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Toggle {
            id,
            checked,
            size,
            off_fill,
            on_fill,
            thumb,
            disabled,
            on_click,
        } = self;
        let (width, height, padding) = size.track();

        div()
            .id(id)
            .w(width)
            .h(height)
            .p(padding)
            .flex()
            .flex_row()
            .flex_shrink_0()
            .rounded_full()
            // `data-checked:translate-x-[calc(100%)]` on the thumb -- the same
            // end position a flex justification reaches, without a transform.
            .when(checked, |this| this.justify_end())
            .bg(if checked { on_fill } else { off_fill })
            .child(div().size(size.thumb()).rounded_full().bg(thumb))
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}
