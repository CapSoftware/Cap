//! `EditorButton` -- the editor's dominant small button
//! (`routes/editor/ui.tsx:317-424`): the header's undo/redo/delete, the
//! player toolbar's triggers, the background section's Reset and Import
//! actions, and every selection panel's Done/Delete pair.
//!
//! Visually it is the editor's ghost button: 28px tall, transparent at rest
//! with a `text-2` label, `ctl-hover` + `text-1` on hover and `ctl-active`
//! while pressed. `danger` keeps its solid red pressed state, and `text`
//! promotes the resting label to `text-1` for the player toolbar's triggers.
//!
use gpui::{
    App, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

use super::{ClickHandler, Tooltip, menu::OpenHandler};

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
    hover_text: Hsla,
    disabled_text: Hsla,
    hover_bg: Hsla,
    active_bg: Hsla,
    pressed_bg: Hsla,
    pressed_text: Hsla,
    chevron: Hsla,
    tooltip: Option<(Theme, SharedString)>,
    on_click: Option<ClickHandler>,
    on_open: Option<OpenHandler>,
}

impl EditorButton {
    pub fn plain(theme: &Theme, id: impl Into<ElementId>) -> Self {
        Self {
            id: id.into(),
            label: None,
            left_icon: None,
            right_icon: None,
            right_icon_end: false,
            icon_size: px(16.),
            right_icon_size: px(10.),
            width: None,
            variant: EditorButtonVariant::Primary,
            disabled: false,
            pressed: false,
            text: Hsla::from(theme.editor.text_2),
            hover_text: Hsla::from(theme.editor.text_1),
            disabled_text: Hsla::from(theme.editor.text_3),
            hover_bg: Hsla::from(theme.editor.ctl_hover),
            active_bg: Hsla::from(theme.editor.ctl_active),
            pressed_bg: Hsla::from(theme.editor.ctl_hover),
            pressed_text: Hsla::from(theme.editor.text_1),
            chevron: Hsla::from(theme.editor.text_3),
            tooltip: None,
            on_click: None,
            on_open: None,
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

    /// The "text" ghost: the resting label is `text-1` rather than `text-2`.
    pub fn text(mut self, theme: &Theme) -> Self {
        self.text = Hsla::from(theme.editor.text_1);
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

    pub fn tooltip(mut self, theme: &Theme, label: impl Into<SharedString>) -> Self {
        self.tooltip = Some((*theme, label.into()));
        self
    }

    pub fn on_click(
        mut self,
        handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(handler));
        self
    }

    pub fn on_open(
        mut self,
        handler: impl Fn(&gpui::Bounds<Pixels>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Box::new(handler));
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
            hover_text,
            disabled_text,
            hover_bg,
            active_bg,
            pressed_bg,
            pressed_text,
            chevron,
            tooltip,
            on_click,
            on_open,
        } = self;

        let foreground = if disabled {
            disabled_text
        } else if pressed {
            pressed_text
        } else {
            text
        };
        // gpui svgs do not inherit a parent's text colour, so the icon follows
        // the label through a group rather than through the cascade.
        let group: SharedString = match &id {
            ElementId::Name(name) => SharedString::from(format!("eb-{name}")),
            other => SharedString::from(format!("eb-{other:?}")),
        };
        let icon_hover = (!disabled && !pressed).then_some(hover_text);

        div()
            .id(id)
            .group(group.clone())
            .tab_index(0)
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .px(px(7.))
            .gap(px(6.))
            .h(px(28.))
            .min_w(px(28.))
            .rounded(px(7.))
            .flex_shrink_0()
            .when(right_icon_end, |this| this.justify_between())
            .when_some(width, |this, width| this.w(width))
            .text_size(px(13.))
            .font_weight(gpui::FontWeight::MEDIUM)
            .text_color(foreground)
            .when(disabled, |this| this.opacity(0.45))
            .when(pressed, |this| this.bg(pressed_bg))
            .when(!disabled && !pressed, |this| {
                this.cursor_pointer()
                    .hover(move |this| this.bg(hover_bg).text_color(hover_text))
                    .active(move |this| this.bg(active_bg))
            })
            .children(left_icon.map(|icon| {
                let group = group.clone();
                svg()
                    .path(icon)
                    .size(icon_size)
                    .flex_shrink_0()
                    .text_color(foreground)
                    .when_some(icon_hover, |this, color| {
                        this.group_hover(group, move |style| style.text_color(color))
                    })
            }))
            .children(label.map(|label| div().truncate().child(label)))
            .children(right_icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(right_icon_size)
                    .flex_shrink_0()
                    .when(right_icon_end, |this| this.ml_auto())
                    .text_color(if disabled { disabled_text } else { chevron })
            }))
            .when_some(tooltip, |this, (theme, label)| {
                this.tooltip_show_delay(crate::ui::TOOLTIP_SHOW_DELAY)
                    .tooltip(move |_window, cx| Tooltip::new(&theme, label.clone()).view(cx))
            })
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .when_some(on_open.filter(|_| !disabled), crate::ui::Menu::trigger)
    }
}
