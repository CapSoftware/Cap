//! `Select`'s trigger -- the closed half of the control [`crate::ui::Menu`]
//! opens. `KSelect.Trigger` in the Solid app is `flex h-8 rounded-lg bg-gray-3
//! px-2` plus a chevron that rotates on `data-expanded`; the settings window's
//! `SelectSettingItem` is the same shape at `px-2.5 py-1.5` with a border.
//!
//! The chevron does not rotate: this gpui rev has no transform (the same gap
//! that leaves the camera bubble's mirror button disabled).

use gpui::{
    App, Bounds, ClickEvent, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement,
    ParentElement, Pixels, RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder, px, svg,
};

use super::{keyboard_nav, menu::OpenHandler};
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
    /// The two triggers disagree: `SelectSettingItem`'s button names no
    /// `font-*` class and so inherits `body`'s Medium, while the editor's
    /// `KSelect.Value` says `font-normal` explicitly (`ConfigSidebar.tsx:740`
    /// and friends) and drops back to Regular.
    weight: FontWeight,
    bg: Option<Hsla>,
    border: Option<Hsla>,
    text: Hsla,
    chevron: Hsla,
    chevron_size: Pixels,
    /// `gap-1.5` on the settings row, `gap-2` on the editor's trigger.
    gap: Pixels,
    stretch: bool,
    chip: Option<Hsla>,
    disabled: bool,
    on_click: Option<crate::ui::button::ClickHandler>,
    on_open: Option<OpenHandler>,
}

impl Select {
    /// A settings row's pop-up, as macOS draws one in a grouped form
    /// (`scripts/glass-reference/gallery.swift`): the value as plain text and
    /// a 20 pt round chip holding an up-down chevron, with no border or fill.
    pub fn settings(
        theme: &Theme,
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            padding_x: px(2.),
            padding_y: px(0.),
            height: Some(px(22.)),
            radius: px(11.),
            text_size: px(13.),
            weight: FontWeight::NORMAL,
            bg: None,
            border: None,
            text: theme.settings_text(),
            chevron: theme.settings_text(),
            chevron_size: px(11.),
            gap: px(7.),
            stretch: false,
            chip: Some(if theme.is_dark() {
                gpui::hsla(0., 0., 1., 0.12)
            } else {
                gpui::hsla(0., 0., 0., 0.07)
            }),
            disabled: false,
            on_click: None,
            on_open: None,
        }
    }

    /// The editor's `KSelect.Trigger`: a borderless `ed-ctl` pill.
    pub fn plain(theme: &Theme, id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            padding_x: px(10.),
            padding_y: px(0.),
            height: Some(px(30.)),
            radius: px(7.),
            text_size: px(13.),
            // `KSelect.Value` is `text-sm ... font-normal`, which opts out of
            // `body`'s Medium (`ConfigSidebar.tsx:740`, `:3121`, `:3173`,
            // `:3369`, `:5283`, `:5380`).
            weight: FontWeight::NORMAL,
            bg: Some(Hsla::from(theme.editor.ctl)),
            border: None,
            text: Hsla::from(theme.editor.text_1),
            chevron: Hsla::from(theme.editor.text_3),
            chevron_size: px(12.),
            gap: px(8.),
            chip: None,
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

    pub fn on_open(
        mut self,
        handler: impl Fn(&Bounds<Pixels>, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_open = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let Select {
            id,
            label,
            padding_x,
            padding_y,
            height,
            radius,
            text_size,
            weight,
            bg,
            border,
            text,
            chevron,
            chevron_size,
            gap,
            stretch,
            chip,
            disabled,
            on_click,
            on_open,
        } = self;

        let interactive = !disabled && (on_click.is_some() || on_open.is_some());
        div()
            .id(id)
            .when(
                interactive && keyboard_nav::active(window, cx),
                keyboard_nav::stop,
            )
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
            .when(!disabled, |this| this.cursor_pointer())
            .text_size(text_size)
            // The label is the only text under here -- the chevron is an svg.
            .font_weight(weight)
            .text_color(text)
            .when(disabled, |this| this.opacity(0.5))
            .map(|this| {
                if stretch {
                    this.child(div().flex_1().child(label))
                } else {
                    this.child(label)
                }
            })
            .map(|this| match chip {
                Some(fill) => this.child(
                    div()
                        .size(px(20.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(fill)
                        .child(
                            svg()
                                .path("icons/chevrons-up-down.svg")
                                .size(chevron_size)
                                .text_color(chevron),
                        ),
                ),
                None => this.child(
                    svg()
                        .path("icons/chevron-down.svg")
                        .size(chevron_size)
                        .flex_shrink_0()
                        .text_color(chevron),
                ),
            })
            .when_some(on_click.filter(|_| !disabled), |this, handler| {
                this.on_click(move |event, window, cx| handler(event, window, cx))
            })
            .when_some(on_open.filter(|_| !disabled), crate::ui::Menu::trigger)
    }
}
