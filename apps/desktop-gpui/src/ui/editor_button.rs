//! `EditorButton` -- the editor's dominant small button
//! (`routes/editor/ui.tsx:317-424`): the header's undo/redo/delete, the
//! player toolbar's triggers, the background section's Reset and Import
//! actions, and every selection panel's Done/Delete pair.
//!
//! `cva` gives it two variants and a pile of group-driven icon colours. The
//! two that matter are reproduced:
//!
//! - **primary** `text-gray-12 enabled:hover:not-data-pressed:bg-gray-3
//!   data-expanded:bg-gray-3` -- it self-highlights while the popover it
//!   triggers is open;
//! - **danger** whose *pressed/expanded* state flips to a solid `bg-red-300
//!   text-gray-1` rather than a wash.
//!
//! Disabled is `opacity-50 text-gray-11` on both.
//!
//! The polymorphic `as={KSelect.Trigger}` half has no gpui equivalent -- there
//! is no element to become -- so a call site that needs this button to open a
//! menu opens one from its own `on_click`, which is what `ui::Select` already
//! does.

use gpui::{
    App, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

use super::ClickHandler;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorButtonVariant {
    Primary,
    Danger,
}

#[derive(IntoElement)]
pub struct EditorButton {
    id: ElementId,
    label: Option<SharedString>,
    left_icon: Option<SharedString>,
    right_icon: Option<SharedString>,
    /// `rightIconEnd` -- pushes the right icon to `ml-auto` and the row to
    /// `justify-between`, which is how the select-style triggers park their
    /// chevron.
    right_icon_end: bool,
    icon_size: Pixels,
    right_icon_size: Pixels,
    width: Option<Pixels>,
    variant: EditorButtonVariant,
    disabled: bool,
    /// `data-pressed` / `data-expanded`.
    pressed: bool,
    text: Hsla,
    disabled_text: Hsla,
    hover_bg: Hsla,
    pressed_bg: Hsla,
    pressed_text: Hsla,
    on_click: Option<ClickHandler>,
}

impl EditorButton {
    pub fn plain(theme: &Theme, id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            label: None,
            left_icon: None,
            right_icon: None,
            right_icon_end: false,
            icon_size: px(20.),
            right_icon_size: px(12.),
            width: None,
            variant: EditorButtonVariant::Primary,
            disabled: false,
            pressed: false,
            text: Hsla::from(theme.gray_12),
            disabled_text: Hsla::from(theme.gray_11),
            hover_bg: Hsla::from(theme.gray_3),
            pressed_bg: Hsla::from(theme.gray_3),
            pressed_text: Hsla::from(theme.gray_12),
            on_click: None,
        }
    }

    /// `variant="danger"`: the pressed/expanded state is a solid `bg-red-300`
    /// with `text-gray-1` on it, not a wash.
    pub fn danger(mut self, theme: &Theme) -> Self {
        self.variant = EditorButtonVariant::Danger;
        self.pressed_bg = Hsla::from(theme.red_300);
        self.pressed_text = Hsla::from(theme.gray_1);
        self
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    pub fn left_icon(mut self, icon: impl Into<SharedString>) -> Self {
        self.left_icon = Some(icon.into());
        self
    }

    pub fn right_icon(mut self, icon: impl Into<SharedString>) -> Self {
        self.right_icon = Some(icon.into());
        self
    }

    pub fn right_icon_end(mut self, end: bool) -> Self {
        self.right_icon_end = end;
        self
    }

    pub fn icon_size(mut self, size: Pixels) -> Self {
        self.icon_size = size;
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.width = Some(width);
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn pressed(mut self, pressed: bool) -> Self {
        self.pressed = pressed;
        self
    }

    pub fn on_click(mut self, handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for EditorButton {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let EditorButton {
            id,
            label,
            left_icon,
            right_icon,
            right_icon_end,
            icon_size,
            right_icon_size,
            width,
            variant: _,
            disabled,
            pressed,
            text,
            disabled_text,
            hover_bg,
            pressed_bg,
            pressed_text,
            on_click,
        } = self;

        let foreground = if disabled {
            disabled_text
        } else if pressed {
            pressed_text
        } else {
            text
        };

        div()
            .id(id)
            // `flex flex-row items-center px-1.5 gap-1.5 h-8 rounded-lg
            //  text-[0.875rem]`
            .flex()
            .flex_row()
            .items_center()
            .px(px(6.))
            .gap(px(6.))
            .h(px(32.))
            .rounded(px(8.))
            .flex_shrink_0()
            .when(right_icon_end, |this| this.justify_between())
            .when_some(width, |this, width| this.w(width))
            .text_size(px(14.))
            .text_color(foreground)
            .when(disabled, |this| this.opacity(0.5))
            .when(pressed, |this| this.bg(pressed_bg))
            .when(!disabled && !pressed, |this| {
                this.cursor_pointer().hover(|this| this.bg(hover_bg))
            })
            .children(
                left_icon.map(|icon| {
                    svg()
                        .path(icon)
                        .size(icon_size)
                        .flex_shrink_0()
                        .text_color(foreground)
                }),
            )
            .children(label.map(|label| div().truncate().child(label)))
            .children(right_icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(right_icon_size)
                    .flex_shrink_0()
                    .when(right_icon_end, |this| this.ml_auto())
                    .text_color(foreground)
            }))
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}
