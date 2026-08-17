//! The tab rail: `ConfigSidebar`'s six icon-only triggers under a
//! `KTabs.Indicator` box (`ConfigSidebar.tsx:593-692`).
//!
//! **This is not the settings sidebar's shape.** The usage matrix lists `KTabs`
//! in the editor and the screenshot editor only; the settings window's sidebar
//! is a vertical nav *list* (icon plus label rows, `.cap-settings-nav`), and
//! `settings.tsx` renders it with `<For>` over `settingsItems`, not with tabs.
//! They were checked against each other and kept apart deliberately -- merging
//! them would mean inventing a shared component neither app has.
//!
//! The indicator does not slide (no transform in this gpui rev); the selected
//! item paints the `size-9 rounded-lg bg-gray-3` box itself, which is what the
//! editor window has always done.

use gpui::{
    App, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

#[derive(Debug, Clone)]
pub struct TabRailItem {
    pub icon: SharedString,
    pub selected: bool,
    pub disabled: bool,
}

impl TabRailItem {
    pub fn new(icon: impl Into<SharedString>, selected: bool, disabled: bool) -> Self {
        Self {
            icon: icon.into(),
            selected,
            disabled,
        }
    }
}

/// The index arrives by reference, the same shape the other index-dispatching
/// components use, so `cx.listener` builds the handler directly.
type TabHandler = Box<dyn Fn(&usize, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct TabRail {
    id: ElementId,
    items: Vec<TabRailItem>,
    height: Pixels,
    box_size: Pixels,
    icon_size: Pixels,
    bg: Hsla,
    border: Hsla,
    indicator: Hsla,
    selected_icon: Hsla,
    idle_icon: Hsla,
    on_select: Option<TabHandler>,
}

impl TabRail {
    /// The editor's config sidebar rail: an `h-16` bar over `bg-gray-1
    /// dark:bg-gray-2` with a `border-b border-gray-3`, `size-9` boxes and
    /// `text-lg` (18px) icons.
    pub fn editor(
        theme: &Theme,
        id: impl Into<ElementId>,
        panel_bg: Hsla,
        items: Vec<TabRailItem>,
    ) -> Self {
        Self {
            id: id.into(),
            items,
            height: px(64.),
            box_size: px(36.),
            icon_size: px(18.),
            bg: panel_bg,
            border: Hsla::from(theme.gray_3),
            indicator: Hsla::from(theme.gray_3),
            selected_icon: Hsla::from(theme.gray_12),
            idle_icon: Hsla::from(theme.gray_11),
            on_select: None,
        }
    }

    /// `h-16` on the editor's rail. Kept a parameter so the call site can go
    /// on quoting its own metric.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = height;
        self
    }

    pub fn on_select(
        mut self,
        handler: impl Fn(&usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for TabRail {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let TabRail {
            id,
            items,
            height,
            box_size,
            icon_size,
            bg,
            border,
            indicator,
            selected_icon,
            idle_icon,
            on_select,
        } = self;

        let prefix: SharedString = match &id {
            ElementId::Name(name) => name.clone(),
            other => SharedString::from(format!("{other:?}")),
        };
        let handler: Option<std::rc::Rc<TabHandler>> = on_select.map(std::rc::Rc::new);

        div()
            .id(id)
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .h(height)
            .flex_none()
            .overflow_hidden()
            .border_b_1()
            .border_color(border)
            .bg(bg)
            .children(items.into_iter().enumerate().map(|(index, item)| {
                let handler = handler.clone();
                let selected = item.selected;
                let disabled = item.disabled;

                // Trigger: `flex relative z-10 flex-1 justify-center
                // items-center px-4 py-2`.
                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .relative()
                    .flex()
                    .flex_1()
                    .justify_center()
                    .items_center()
                    .px(px(16.))
                    .py(px(8.))
                    .when(disabled, |this| this.opacity(0.5))
                    .child(
                        // The icon box and, under it, the selection pill: both
                        // `size-9`, the pill `rounded-lg bg-gray-3`.
                        div()
                            .flex()
                            .items_center()
                            .justify_center()
                            .size(box_size)
                            .rounded(px(8.))
                            .when(selected, |this| this.bg(indicator))
                            .child(svg().path(item.icon).size(icon_size).text_color(
                                if selected { selected_icon } else { idle_icon },
                            )),
                    )
                    .when_some(handler.filter(|_| !disabled), |this, handler| {
                        this.on_click(move |_, window, cx| handler(&index, window, cx))
                    })
            }))
    }
}
