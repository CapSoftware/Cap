//! `Select`'s trigger -- the closed half of the control [`crate::ui::Menu`]
//! opens. `KSelect.Trigger` in the Solid app is `flex h-8 rounded-lg bg-gray-3
//! px-2` plus a chevron that rotates on `data-expanded`; the settings window's
//! `SelectSettingItem` is the same shape at `px-2.5 py-1.5` with a border.
//!
//! The chevron does not rotate: this gpui rev has no transform (the same gap
//! that leaves the camera bubble's mirror button disabled).

use gpui::{
    App, ClickEvent, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    label: SharedString,
    padding_x: Pixels,
    padding_y: Pixels,
    height: Option<Pixels>,
    radius: Pixels,
    text_size: Pixels,
    bg: Option<Hsla>,
    border: Option<Hsla>,
    text: Hsla,
    chevron: Hsla,
    chevron_size: Pixels,
    /// `gap-1.5` on the settings row, `gap-2` on the editor's trigger.
    gap: Pixels,
    stretch: bool,
    disabled: bool,
    on_click: Option<crate::ui::button::ClickHandler>,
}

impl Select {
    /// `SelectSettingItem`'s button: `flex flex-row gap-1.5 text-xs items-center
    /// px-2.5 py-1.5 rounded-lg border bg-gray-3 text-gray-12 border-gray-4`,
    /// radius 8 under the settings material.
    pub fn settings(theme: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            padding_x: px(10.),
            padding_y: px(6.),
            height: None,
            radius: px(8.),
            text_size: px(12.),
            bg: Some(theme.settings_fill()),
            border: Some(theme.settings_border()),
            text: theme.settings_text(),
            chevron: theme.settings_muted(),
            chevron_size: px(14.),
            gap: px(6.),
            stretch: false,
            disabled: false,
            on_click: None,
        }
    }

    /// The editor's `KSelect.Trigger`: `flex items-center gap-2 h-9 px-3
    /// rounded-lg border border-gray-3 bg-gray-2 dark:bg-gray-3 text-sm
    /// text-gray-12`.
    pub fn plain(theme: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            padding_x: px(12.),
            padding_y: px(0.),
            height: Some(px(36.)),
            text_size: px(14.),
            bg: Some(if theme.is_dark() {
                Hsla::from(theme.gray_3)
            } else {
                Hsla::from(theme.gray_2)
            }),
            border: Some(Hsla::from(theme.gray_3)),
            text: Hsla::from(theme.gray_12),
            chevron: Hsla::from(theme.gray_11),
            chevron_size: px(16.),
            gap: px(8.),
            ..Self::settings(theme, id, label)
        }
    }

    /// The label takes the remaining width and the chevron is pushed to the
    /// end -- `EditorButton`'s `rightIconEnd`.
    pub fn stretch_label(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
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

impl RenderOnce for Select {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Select {
            id,
            label,
            padding_x,
            padding_y,
            height,
            radius,
            text_size,
            bg,
            border,
            text,
            chevron,
            chevron_size,
            gap,
            stretch,
            disabled,
            on_click,
        } = self;

        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(gap)
            .px(padding_x)
            .when(f32::from(padding_y) > 0., |this| this.py(padding_y))
            .when_some(height, |this, height| this.h(height))
            .rounded(radius)
            .when_some(border, |this, border| this.border_1().border_color(border))
            .when_some(bg, |this, bg| this.bg(bg))
            .text_size(text_size)
            .text_color(text)
            .when(disabled, |this| this.opacity(0.5))
            .map(|this| {
                if stretch {
                    this.child(div().flex_1().child(label))
                } else {
                    this.child(label)
                }
            })
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(chevron_size)
                    .flex_shrink_0()
                    .text_color(chevron),
            )
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
    }
}
