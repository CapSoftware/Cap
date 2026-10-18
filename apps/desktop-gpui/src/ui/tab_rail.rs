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
//! item paints its own `active-bg` box.
//!
//! Each tab is exactly one element -- the pill. A wrapper carrying the hit box,
//! the tooltip anchor or a focus ring would paint its own square corners around
//! the pill's radius, which is what the first pass shipped.

use gpui::{
    App, ElementId, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels, RenderOnce,
    SharedString, StatefulInteractiveElement, Styled, Window, div, prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

#[derive(Debug, Clone)]
pub struct TabRailItem {
    pub icon: SharedString,
    /// The tab's name. It is not drawn -- the rail is icon-only -- so it is
    /// carried as the tooltip instead.
    pub label: SharedString,
    pub selected: bool,
    pub disabled: bool,
}

impl TabRailItem {
    pub fn new(
        icon: impl Into<SharedString>,
        label: impl Into<SharedString>,
        selected: bool,
        disabled: bool,
    ) -> Self {
        Self {
            icon: icon.into(),
            label: label.into(),
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
    bg: Hsla,
    theme: Theme,
    on_select: Option<TabHandler>,
}

impl TabRail {
    pub fn editor(
        theme: &Theme,
        id: impl Into<ElementId>,
        panel_bg: Hsla,
        items: Vec<TabRailItem>,
    ) -> Self {
        Self {
            id: id.into(),
            items,
            height: px(40.),
            bg: panel_bg,
            theme: *theme,
            on_select: None,
        }
    }

    /// `h-16` on the editor's rail. Kept a parameter so the call site can go
    /// on quoting its own metric.
    pub fn height(mut self, height: Pixels) -> Self {
        self.height = height;
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
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
            bg,
            theme,
            on_select,
        } = self;
        let hover_bg = theme.hover_bg;
        let hover_icon = theme.text_hover;

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
            .rounded_t(crate::theme::radius(crate::theme::RadiusToken::Medium))
            .justify_around()
            .px(px(8.))
            .border_b_1()
            .border_color(theme.border)
            .bg(bg)
            .children(items.into_iter().enumerate().map(|(index, item)| {
                let handler = handler.clone();
                let selected = item.selected;
                let disabled = item.disabled;
                let label = item.label.clone();
                let group = SharedString::from(format!("{prefix}-{index}-group"));
                let icon = if disabled {
                    theme.text_muted
                } else if selected {
                    theme.text_active
                } else {
                    theme.text_interactive
                };
                let interactive = !selected && !disabled;

                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .group(group.clone())
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .h(px(28.))
                    .w(px(32.))
                    .rounded(crate::theme::radius(crate::theme::RadiusToken::Default))
                    .when(selected, |this| this.bg(theme.active_bg))
                    .when(interactive, |this| {
                        this.cursor_pointer().hover(move |style| style.bg(hover_bg))
                    })
                    .tooltip_show_delay(crate::ui::TOOLTIP_SHOW_DELAY)
                    .tooltip(move |_, cx| crate::ui::Tooltip::new(&theme, label.clone()).view(cx))
                    .child(
                        svg().path(item.icon).size(px(16.)).text_color(icon).when(
                            interactive,
                            |this| {
                                this.group_hover(group, move |style| style.text_color(hover_icon))
                            },
                        ),
                    )
                    .when_some(handler.filter(|_| !disabled), |this, handler| {
                        this.on_click(move |_, window, cx| handler(&index, window, cx))
                    })
            }))
    }
}
