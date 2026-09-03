//! `RadioCards` -- the "radio button as a full-width bordered card" idiom the
//! cursor settings use twice (`ConfigSidebar.tsx:835-861` for Cursor Type,
//! `:919-945` for Cursor Movement Style) and the screenshot editor's background
//! popover uses again.
//!
//! It is one shape with two instances in the Solid app and no shared component,
//! which is exactly the kind of thing this library exists to hold: a card
//! (`rounded-lg border border-gray-3`, selected `border-blue-8 bg-blue-3/40`)
//! containing a `size-4` radio dot (`border-gray-7`, selected `border-blue-9
//! bg-blue-9`) and a title/description block.
//!
//! Kobalte's `RadioGroup` also gives it a roving-tabindex keyboard contract
//! (arrows move *and* select, Space commits). This rev has no focus ring or key
//! handling on it -- the same gap `SegmentedControl` has -- so it is
//! pointer-driven only.

use gpui::{
    App, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

#[derive(Debug, Clone)]
pub struct RadioCard {
    pub label: SharedString,
    pub description: Option<SharedString>,
    pub disabled: bool,
}

impl RadioCard {
    pub fn new(label: impl Into<SharedString>, description: Option<&str>) -> Self {
        Self {
            label: label.into(),
            description: description.map(SharedString::from),
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// The index arrives by reference, like the other index-dispatching components,
/// so `cx.listener(..)` builds the handler directly.
type SelectHandler = Box<dyn Fn(&usize, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct RadioCards {
    id: ElementId,
    items: Vec<RadioCard>,
    selected: Option<usize>,
    border: Hsla,
    selected_border: Hsla,
    selected_bg: Hsla,
    dot_border: Hsla,
    dot_fill: Hsla,
    title: Hsla,
    description: Hsla,
    on_select: Option<SelectHandler>,
}

impl RadioCards {
    /// The editor surface. `data-checked:bg-blue-3/40` is `blue-3` at 40%.
    pub fn plain(
        theme: &Theme,
        id: impl Into<ElementId>,
        items: Vec<RadioCard>,
        selected: Option<usize>,
    ) -> Self {
        let mut selected_bg = Hsla::from(theme.blue_3);
        selected_bg.a = 0.4;
        Self {
            id: id.into(),
            items,
            selected,
            border: Hsla::from(theme.gray_3),
            selected_border: Hsla::from(theme.blue_8),
            selected_bg,
            dot_border: Hsla::from(theme.gray_7),
            dot_fill: Hsla::from(theme.blue_9),
            title: Hsla::from(theme.gray_12),
            description: Hsla::from(theme.gray_11),
            on_select: None,
        }
    }

    pub fn on_select(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for RadioCards {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let RadioCards {
            id,
            items,
            selected,
            border,
            selected_border,
            selected_bg,
            dot_border,
            dot_fill,
            title,
            description,
            on_select,
        } = self;

        let prefix: SharedString = match &id {
            ElementId::Name(name) => name.clone(),
            other => SharedString::from(format!("{other:?}")),
        };
        let handler: Option<std::rc::Rc<SelectHandler>> = on_select.map(std::rc::Rc::new);

        // `class="flex flex-col gap-2"`
        div()
            .id(id)
            .flex()
            .flex_col()
            .gap(px(8.))
            .children(items.into_iter().enumerate().map(|(index, item)| {
                let handler = handler.clone();
                let checked = selected == Some(index);

                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(if checked { selected_border } else { border })
                    .when(checked, |this| this.bg(selected_bg))
                    .when(item.disabled, |this| this.opacity(0.5))
                    .child(
                        // `flex items-start gap-3 p-3`
                        div()
                            .flex()
                            .items_start()
                            .gap(px(12.))
                            .p(px(12.))
                            .child(
                                // `mt-1 size-4 rounded-full border border-gray-7`
                                div()
                                    .mt(px(4.))
                                    .size(px(16.))
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(if checked { dot_fill } else { dot_border })
                                    .when(checked, |this| {
                                        this.bg(dot_fill).child(
                                            svg()
                                                .path("icons/check.svg")
                                                .size(px(12.))
                                                .text_color(Hsla::from(gpui::rgb(0xffffff))),
                                        )
                                    }),
                            )
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(title)
                                            .child(item.label),
                                    )
                                    .children(item.description.map(|text| {
                                        div().text_size(px(12.)).text_color(description).child(text)
                                    })),
                            ),
                    )
                    .when_some(handler.filter(|_| !item.disabled), |this, handler| {
                        this.on_click(move |_, window, cx| handler(&index, window, cx))
                    })
            }))
    }
}
