//! `SegmentedControl` -- one component for the four idioms the Solid app grew
//! independently (digest section 7, item 13).
//!
//! | idiom | where | shape |
//! |---|---|---|
//! | sliding pill | `packages/ui-solid/src/SwitchTab.tsx` | bordered strip, `KTabs.Indicator` slides a `bg-gray-1` pill |
//! | tab rail | `ConfigSidebar.tsx`, `FrameButton.tsx` | icon triggers, `size-9` indicator box |
//! | flat pills | `ExportPage.tsx` | loose `gap-1.5` buttons, selected `bg-gray-3 border-gray-5` |
//! | icon grid | `ConfigSidebar.tsx` text-align | `grid-cols-3` cells in a bordered box, selected `bg-gray-5` |
//!
//! The superset is: a container (padding, radius, border, fill, gap) holding
//! items (padding, radius, text size/weight, per-state fill and colour), each
//! either a label, an icon, or both. The tab-rail idiom keeps its own component
//! ([`crate::ui::TabRail`]) because its items are `flex-1` icon boxes with a
//! separate indicator layer, not padded pills.
//!
//! The indicator does not slide. Kobalte positions it from the selected
//! trigger's measured rect and animates a transform; this gpui rev has no
//! transform, so the selected item paints its own fill -- which is what the
//! settings window has always done here.

use gpui::{
    App, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::Theme;

/// One segment. `selected` is computed by the caller so the control never has
/// to know what the value type is.
#[derive(Debug, Clone)]
pub struct SegmentOption {
    pub label: Option<SharedString>,
    pub icon: Option<SharedString>,
    pub selected: bool,
    pub disabled: bool,
}

impl SegmentOption {
    pub fn new(label: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            label: Some(label.into()),
            icon: None,
            selected,
            disabled: false,
        }
    }

    pub fn icon(icon: impl Into<SharedString>, selected: bool) -> Self {
        Self {
            label: None,
            icon: Some(icon.into()),
            selected,
            disabled: false,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// Maps a click on segment `index` back onto a value from a fixed list, which
/// is the one piece of the old per-window `segmented::<T>` helper worth
/// keeping: every call site had the same `T::ALL.get(index)` guard.
pub fn option_at<T: Copy>(values: &[T], index: usize) -> Option<T> {
    values.get(index).copied()
}

/// The index arrives by reference so `cx.listener(|this, index: &usize, ..)`
/// builds one of these directly -- gpui's listeners take exactly one event
/// argument, and the index *is* the event here.
type SegmentHandler = Box<dyn Fn(&usize, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct SegmentedControl {
    id: ElementId,
    options: Vec<SegmentOption>,
    container_padding: Pixels,
    container_radius: Pixels,
    container_gap: Pixels,
    container_bg: Option<Hsla>,
    container_border: Option<Hsla>,
    item_padding_x: Pixels,
    item_padding_y: Pixels,
    item_radius: Pixels,
    item_gap: Pixels,
    text_size: Pixels,
    font_weight: Option<FontWeight>,
    icon_size: Pixels,
    selected_bg: Option<Hsla>,
    selected_text: Hsla,
    idle_text: Hsla,
    idle_bg: Option<Hsla>,
    hover_bg: Option<Hsla>,
    stretch: bool,
    on_select: Option<SegmentHandler>,
}

impl SegmentedControl {
    fn base(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            id: id.into(),
            options,
            container_padding: px(2.),
            container_radius: px(8.),
            container_gap: px(0.),
            container_bg: None,
            container_border: None,
            item_padding_x: px(12.),
            item_padding_y: px(4.),
            item_radius: px(6.),
            item_gap: px(6.),
            text_size: px(12.),
            font_weight: Some(FontWeight::MEDIUM),
            icon_size: px(14.),
            selected_bg: None,
            selected_text: theme.gray(12),
            idle_text: theme.gray(11),
            idle_bg: None,
            hover_bg: None,
            stretch: false,
            on_select: None,
        }
    }

    /// The settings window: `inline-flex p-0.5 rounded-lg border border-gray-3
    /// bg-gray-3` with `px-3 py-1 text-xs font-medium rounded-md` items. The
    /// selected item is `bg-gray-1 text-gray-12 shadow-sm` -- `bg-gray-1` is
    /// not in the settings material's remap list, so it stays literal.
    pub fn settings(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_bg: Some(theme.settings_fill()),
            container_border: Some(theme.settings_border()),
            selected_bg: Some(Hsla::from(theme.gray_1)),
            selected_text: theme.settings_text(),
            idle_text: theme.settings_muted(),
            ..Self::base(theme, id, options)
        }
    }

    /// `ExportPage`'s loose pills: no container chrome, `flex gap-1.5`,
    /// selected `bg-gray-3 border-gray-5 text-gray-12`, idle transparent with
    /// `hover:bg-gray-3`.
    pub fn pills(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(0.),
            container_gap: px(6.),
            container_bg: None,
            container_border: None,
            item_radius: px(8.),
            selected_bg: Some(theme.gray(3)),
            hover_bg: Some(theme.gray(3)),
            idle_text: theme.gray(11),
            ..Self::base(theme, id, options)
        }
    }

    /// The text-align icon grid: `grid grid-cols-N gap-1 rounded-lg border
    /// border-gray-3 bg-gray-2 p-1`, selected `bg-gray-5 text-gray-12`.
    pub fn icons(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(4.),
            container_gap: px(4.),
            container_bg: Some(theme.gray(2)),
            container_border: Some(theme.gray(3)),
            item_padding_x: px(6.),
            item_padding_y: px(6.),
            selected_bg: Some(theme.gray(5)),
            stretch: true,
            ..Self::base(theme, id, options)
        }
    }

    pub fn stretch(mut self) -> Self {
        self.stretch = true;
        self
    }

    pub fn text_size(mut self, size: Pixels) -> Self {
        self.text_size = size;
        self
    }

    pub fn item_padding(mut self, x: Pixels, y: Pixels) -> Self {
        self.item_padding_x = x;
        self.item_padding_y = y;
        self
    }

    pub fn idle_bg(mut self, bg: Hsla) -> Self {
        self.idle_bg = Some(bg);
        self
    }

    pub fn on_select(mut self, handler: impl Fn(&usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Box::new(handler));
        self
    }
}

impl RenderOnce for SegmentedControl {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let SegmentedControl {
            id,
            options,
            container_padding,
            container_radius,
            container_gap,
            container_bg,
            container_border,
            item_padding_x,
            item_padding_y,
            item_radius,
            item_gap,
            text_size,
            font_weight,
            icon_size,
            selected_bg,
            selected_text,
            idle_text,
            idle_bg,
            hover_bg,
            stretch,
            on_select,
        } = self;

        let handler: Option<std::rc::Rc<SegmentHandler>> = on_select.map(std::rc::Rc::new);
        let prefix: SharedString = match &id {
            ElementId::Name(name) => name.clone(),
            other => SharedString::from(format!("{other:?}")),
        };

        div()
            .id(id)
            .flex()
            .flex_row()
            .p(container_padding)
            .gap(container_gap)
            .rounded(container_radius)
            .when_some(container_bg, |this, bg| this.bg(bg))
            .when_some(container_border, |this, border| {
                this.border_1().border_color(border)
            })
            .children(options.into_iter().enumerate().map(|(index, option)| {
                let handler = handler.clone();
                let selected = option.selected;
                let disabled = option.disabled;

                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(item_gap)
                    .px(item_padding_x)
                    .py(item_padding_y)
                    .rounded(item_radius)
                    .text_size(text_size)
                    .when(stretch, |this| this.flex_1())
                    .when_some(font_weight, |this, weight| this.font_weight(weight))
                    .when(disabled, |this| this.opacity(0.5))
                    .map(|this| {
                        if selected {
                            let this = this.text_color(selected_text);
                            match selected_bg {
                                Some(bg) => this.bg(bg),
                                None => this,
                            }
                        } else {
                            let this = this.text_color(idle_text);
                            let this = match idle_bg {
                                Some(bg) => this.bg(bg),
                                None => this,
                            };
                            match hover_bg {
                                Some(bg) if !disabled => this.hover(move |style| style.bg(bg)),
                                _ => this,
                            }
                        }
                    })
                    .children(option.icon.map(|icon| {
                        svg()
                            .path(icon)
                            .size(icon_size)
                            .flex_shrink_0()
                            .text_color(if selected { selected_text } else { idle_text })
                    }))
                    .children(option.label)
                    .when_some(handler.filter(|_| !disabled), |this, handler| {
                        this.on_click(move |_, window, cx| handler(&index, window, cx))
                    })
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum Quality {
        Low,
        Medium,
        High,
    }

    #[test]
    fn a_click_index_maps_back_onto_its_value() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        assert_eq!(option_at(&all, 0), Some(Quality::Low));
        assert_eq!(option_at(&all, 2), Some(Quality::High));
    }

    /// The old per-window helper guarded this with `if let Some(value) =
    /// T::ALL.get(index)`; a stale index from a re-rendered control must be a
    /// no-op, never a panic.
    #[test]
    fn an_index_past_the_end_selects_nothing() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        assert_eq!(option_at(&all, 3), None);
        assert_eq!(option_at::<Quality>(&[], 0), None);
    }

    #[test]
    fn exactly_one_option_is_marked_selected_for_a_value() {
        let all = [Quality::Low, Quality::Medium, Quality::High];
        let current = Quality::Medium;
        let options: Vec<SegmentOption> = all
            .iter()
            .map(|value| SegmentOption::new(format!("{value:?}"), *value == current))
            .collect();
        assert_eq!(options.iter().filter(|option| option.selected).count(), 1);
        assert!(options[1].selected);
    }
}
