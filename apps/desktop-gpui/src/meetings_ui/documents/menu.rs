use std::rc::Rc;

use gpui::{
    AnyElement, App, Div, ElementId, InteractiveElement, IntoElement, MouseButton, ParentElement,
    Pixels, Point, SharedString, StatefulInteractiveElement, Styled, Window, anchored, deferred,
    div, prelude::FluentBuilder, px, svg,
};

use super::style::Palette;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry<A> {
    pub label: SharedString,
    pub action: Option<A>,
    pub danger: bool,
    pub checked: bool,
    pub separator: bool,
}

impl<A> Entry<A> {
    pub fn new(label: impl Into<SharedString>, action: A) -> Self {
        Self {
            label: label.into(),
            action: Some(action),
            danger: false,
            checked: false,
            separator: false,
        }
    }

    pub fn separator() -> Self {
        Self {
            label: SharedString::default(),
            action: None,
            danger: false,
            checked: false,
            separator: true,
        }
    }

    pub fn disabled(label: impl Into<SharedString>) -> Self {
        Self {
            label: label.into(),
            action: None,
            danger: false,
            checked: false,
            separator: false,
        }
    }

    pub fn danger(mut self) -> Self {
        self.danger = true;
        self
    }

    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }
}

pub struct OpenMenu<A> {
    pub id: &'static str,
    pub position: Point<Pixels>,
    pub entries: Vec<Entry<A>>,
}

pub fn surface(palette: &Palette) -> Div {
    div()
        .occlude()
        .bg(palette.popover)
        .border_1()
        .border_color(palette.popover_border)
        .rounded(px(10.))
        .shadow(palette.shadow())
        .text_size(px(13.))
        .text_color(palette.text)
}

pub fn panel<A: Clone + 'static>(
    palette: &Palette,
    id: &'static str,
    entries: &[Entry<A>],
    min_width: f32,
    pick: Rc<dyn Fn(&A, &mut Window, &mut App)>,
    dismiss: Rc<dyn Fn(&mut Window, &mut App)>,
) -> AnyElement {
    let any_checked = entries.iter().any(|e| e.checked);
    let rows = entries.iter().enumerate().map(|(index, entry)| {
        if entry.separator {
            return div()
                .h(px(9.))
                .flex()
                .items_center()
                .px(px(8.))
                .child(div().h(px(1.)).w_full().bg(palette.hairline))
                .into_any_element();
        }
        let enabled = entry.action.is_some();
        let color = if !enabled {
            palette.faint
        } else if entry.danger {
            palette.danger
        } else {
            palette.text
        };
        let action = entry.action.clone();
        let pick = pick.clone();
        div()
            .id(ElementId::NamedInteger(id.into(), index as u64))
            .h(px(28.))
            .px(px(8.))
            .rounded(px(6.))
            .flex()
            .items_center()
            .gap(px(6.))
            .text_color(color)
            .when(enabled, |el| {
                el.cursor_pointer()
                    .hover(|s| s.bg(palette.accent_soft))
                    .on_click(move |_, window, cx| {
                        if let Some(action) = &action {
                            pick(action, window, cx);
                        }
                    })
            })
            .when(any_checked, |el| {
                el.child(div().w(px(14.)).flex_shrink_0().when(entry.checked, |el| {
                    el.child(
                        svg()
                            .path("icons/check.svg")
                            .size(px(12.))
                            .text_color(color),
                    )
                }))
            })
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .child(entry.label.clone()),
            )
            .into_any_element()
    });
    surface(palette)
        .id(id)
        .min_w(px(min_width))
        .max_w(px(320.))
        .max_h(px(420.))
        .overflow_y_scroll()
        .p(px(5.))
        .flex()
        .flex_col()
        .children(rows)
        .on_mouse_down_out(move |_, window, cx| dismiss(window, cx))
        .on_mouse_down(MouseButton::Right, |_, _, cx| cx.stop_propagation())
        .into_any_element()
}

pub fn float_above(position: Point<Pixels>, child: AnyElement) -> AnyElement {
    deferred(
        anchored()
            .anchor(gpui::Anchor::BottomLeft)
            .position(position)
            .snap_to_window_with_margin(px(8.))
            .child(child),
    )
    .with_priority(2)
    .into_any_element()
}

pub fn float(position: Point<Pixels>, child: AnyElement) -> AnyElement {
    deferred(
        anchored()
            .position(position)
            .snap_to_window_with_margin(px(8.))
            .child(child),
    )
    .with_priority(2)
    .into_any_element()
}
