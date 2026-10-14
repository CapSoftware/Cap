//! `Select`'s trigger -- the closed half of the control [`crate::ui::Menu`]
//! opens.
//!
//! The chevron does not rotate: this gpui rev has no transform (the same gap
//! that leaves the camera bubble's mirror button disabled).

use gpui::{
    App, Bounds, ClickEvent, ElementId, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use super::menu::OpenHandler;
use crate::theme::{RadiusToken, Theme, radius};

#[derive(IntoElement)]
pub struct Select {
    id: ElementId,
    label: SharedString,
    theme: Theme,
    stretch: bool,
    disabled: bool,
    on_click: Option<crate::ui::button::ClickHandler>,
    on_open: Option<OpenHandler>,
}

impl Select {
    pub fn new(theme: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            theme: *theme,
            stretch: false,
            disabled: false,
            on_click: None,
            on_open: None,
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

    pub fn on_open(
        mut self,
        handler: impl Fn(&Bounds<Pixels>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for Select {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Select {
            id,
            label,
            theme,
            stretch,
            disabled,
            on_click,
            on_open,
        } = self;
        let hover = theme.hover_bg;

        div()
            .id(id)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .h(px(28.))
            .px(px(10.))
            .rounded(radius(RadiusToken::Default))
            .border_1()
            .border_color(theme.border)
            .text_size(px(13.))
            .map(|this| {
                if disabled {
                    this.bg(theme.disabled_bg).text_color(theme.text_muted)
                } else {
                    this.bg(theme.surface_secondary)
                        .text_color(theme.text_primary)
                        .cursor_pointer()
                        .hover(move |style| style.bg(hover))
                }
            })
            .map(|this| {
                if stretch {
                    this.child(div().flex_1().min_w_0().truncate().child(label))
                } else {
                    this.child(label)
                }
            })
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(px(14.))
                    .flex_shrink_0()
                    .text_color(if disabled {
                        theme.text_muted
                    } else {
                        theme.icon
                    }),
            )
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .when_some(on_open.filter(|_| !disabled), crate::ui::Menu::trigger)
    }
}
