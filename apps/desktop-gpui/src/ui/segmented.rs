//! Pill tabs based on the supplied Theme System's `.ui-tabs` and `.ui-tab`.

use gpui::{
    App, ElementId, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Pixels,
    RenderOnce, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, svg,
};

use crate::theme::{RadiusToken, Theme, radius};

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
    item_height: Option<Pixels>,
    item_radius: Pixels,
    item_gap: Pixels,
    text_size: Pixels,
    font_weight: Option<FontWeight>,
    icon_size: Pixels,
    selected_bg: Option<Hsla>,
    selected_text: Hsla,
    idle_text: Hsla,
    hover_text: Hsla,
    active_text: Hsla,
    muted_text: Hsla,
    focus_ring: Hsla,
    selected_border: Option<Hsla>,
    idle_icon: Hsla,
    active_icon: Hsla,
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
            container_radius: radius(RadiusToken::Large),
            container_gap: px(2.),
            container_bg: Some(Hsla::from(theme.surface_raised)),
            container_border: None,
            item_padding_x: px(8.),
            item_padding_y: px(0.),
            item_height: Some(px(24.)),
            item_radius: radius(RadiusToken::Large),
            item_gap: px(6.),
            text_size: px(12.),
            font_weight: Some(FontWeight::NORMAL),
            icon_size: px(14.),
            selected_bg: Some(Hsla::from(theme.surface)),
            selected_text: Hsla::from(theme.text_active),
            idle_text: Hsla::from(theme.text_interactive),
            hover_text: Hsla::from(theme.text_hover),
            active_text: Hsla::from(theme.text_active),
            muted_text: Hsla::from(theme.text_muted),
            focus_ring: Hsla::from(theme.ring_primary),
            selected_border: Some(Hsla::from(theme.border)),
            idle_icon: Hsla::from(theme.icon),
            active_icon: Hsla::from(theme.icon_active),
            idle_bg: None,
            hover_bg: None,
            stretch: false,
            on_select: None,
        }
    }

    pub fn settings(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self::base(theme, id, options)
    }

    pub fn pills(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(0.),
            container_gap: px(6.),
            container_bg: None,
            hover_bg: Some(Hsla::from(theme.hover_bg)),
            ..Self::base(theme, id, options)
        }
    }

    pub fn editor(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self::base(theme, id, options)
    }

    pub fn icons(theme: &Theme, id: impl Into<ElementId>, options: Vec<SegmentOption>) -> Self {
        Self {
            container_padding: px(4.),
            container_gap: px(4.),
            container_radius: radius(RadiusToken::Default),
            container_border: Some(Hsla::from(theme.border)),
            item_padding_x: px(6.),
            item_padding_y: px(6.),
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

    pub fn item_height(mut self, height: Pixels) -> Self {
        self.item_height = Some(height);
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
            item_height,
            item_radius,
            item_gap,
            text_size,
            font_weight,
            icon_size,
            selected_bg,
            selected_text,
            idle_text,
            hover_text,
            active_text,
            muted_text,
            focus_ring,
            selected_border,
            idle_icon,
            active_icon,
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
                let group = SharedString::from(format!("{prefix}-{index}"));

                div()
                    .id(SharedString::from(format!("{prefix}-{index}")))
                    .group(group.clone())
                    .tab_index(if selected && !disabled { 0 } else { -1 })
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(item_gap)
                    .px(item_padding_x)
                    .when(f32::from(item_padding_y) > 0., |this| {
                        this.py(item_padding_y)
                    })
                    .when_some(item_height, |this, height| this.h(height))
                    .rounded(item_radius)
                    .border_1()
                    .border_color(if selected {
                        selected_border.unwrap_or(gpui::transparent_black())
                    } else {
                        gpui::transparent_black()
                    })
                    .text_size(text_size)
                    .when(stretch, |this| this.flex_1().min_w_0())
                    .when_some(font_weight, |this, weight| this.font_weight(weight))
                    .focus_visible(move |style| style.border_color(focus_ring))
                    .map(|this| {
                        if selected {
                            let this = this.text_color(selected_text);
                            match selected_bg {
                                Some(bg) => this.bg(bg),
                                None => this,
                            }
                        } else {
                            let this = this
                                .text_color(if disabled { muted_text } else { idle_text })
                                .when(!disabled, |this| {
                                    this.cursor_pointer()
                                        .hover(move |style| style.text_color(hover_text))
                                        .active(move |style| style.text_color(active_text))
                                });
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
                        let icon_color = if disabled {
                            muted_text
                        } else if selected {
                            active_icon
                        } else {
                            idle_icon
                        };
                        svg()
                            .path(icon)
                            .id(SharedString::from(format!("{prefix}-icon-{index}")))
                            .size(icon_size)
                            .flex_shrink_0()
                            .text_color(icon_color)
                            .when(!selected && !disabled, |this| {
                                this.group_hover(group.clone(), move |style| {
                                    style.text_color(active_icon)
                                })
                                .group_active(group, move |style| style.text_color(active_icon))
                            })
                    }))
                    .children(
                        option
                            .label
                            .map(|label| div().min_w_0().truncate().child(label)),
                    )
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
