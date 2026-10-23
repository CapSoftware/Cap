use std::time::Duration;

use gpui::{
    Animation, AnimationExt, AnyElement, Div, Hsla, IntoElement, ParentElement, Styled, div, px,
    relative,
};

use crate::theme::Theme;

fn block(theme: &Theme, width: f32, height: f32) -> Div {
    div()
        .w(px(width))
        .h(px(height))
        .flex_none()
        .rounded(px(5.))
        .bg(Hsla::from(theme.editor.ctl_hover))
}

fn pulse(id: &'static str, content: Div, animated: bool) -> AnyElement {
    if !animated {
        return content.into_any_element();
    }
    content
        .with_animation(
            id,
            Animation::new(Duration::from_millis(1800)).repeat(),
            |element, progress| {
                let opacity = 0.78 + 0.22 * (progress * std::f32::consts::TAU).cos();
                element.opacity(opacity)
            },
        )
        .into_any_element()
}

pub(super) fn preview(theme: &Theme, animated: bool) -> AnyElement {
    div()
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .p(px(24.))
        .bg(Hsla::from(theme.editor.card))
        .child(pulse(
            "editor-preview-skeleton",
            div()
                .w_full()
                .h_full()
                .rounded(px(12.))
                .bg(Hsla::from(theme.editor.ctl))
                .border_1()
                .border_color(Hsla::from(theme.editor.line)),
            animated,
        ))
        .into_any_element()
}

pub(super) fn sidebar(theme: &Theme, animated: bool) -> AnyElement {
    pulse(
        "editor-sidebar-skeleton",
        div()
            .flex()
            .flex_col()
            .p(px(16.))
            .gap(px(20.))
            .child(block(theme, 92., 12.))
            .child(
                div()
                    .flex()
                    .gap(px(6.))
                    .children((0..4).map(|_| block(theme, 64., 28.).flex_1().min_w_0())),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children((0..2).map(|_| {
                        div()
                            .flex()
                            .gap(px(8.))
                            .children((0..4).map(|_| block(theme, 64., 48.).flex_1().min_w_0()))
                    })),
            )
            .child(div().h(px(1.)).w_full().bg(Hsla::from(theme.editor.line)))
            .children([72., 88., 64.].into_iter().map(|width| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .child(block(theme, width, 10.))
                            .child(block(theme, 36., 20.)),
                    )
                    .child(block(theme, 0., 5.).w_full())
            })),
        animated,
    )
}

pub(super) fn timeline(theme: &Theme, animated: bool) -> AnyElement {
    pulse(
        "editor-timeline-skeleton",
        div()
            .size_full()
            .flex()
            .flex_col()
            .p(px(12.))
            .gap(px(12.))
            .child(
                div()
                    .h(px(24.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .children((0..8).map(|_| block(theme, 28., 8.))),
            )
            .children([1., 0.72].into_iter().map(|width| {
                div()
                    .flex()
                    .items_center()
                    .gap(px(16.))
                    .child(block(theme, 24., 24.))
                    .child(
                        div()
                            .flex_1()
                            .child(block(theme, 0., 28.).w(relative(width))),
                    )
            })),
        animated,
    )
}

pub(super) fn reveal(
    id: &'static str,
    content: impl IntoElement,
    placeholder: impl IntoElement,
) -> AnyElement {
    div()
        .relative()
        .size_full()
        .child(content)
        .child(
            div()
                .absolute()
                .inset_0()
                .child(placeholder)
                .with_animation(
                    id,
                    Animation::new(Duration::from_millis(180)),
                    |element, progress| {
                        if progress >= 1. {
                            div()
                        } else {
                            element.opacity((1. - progress).powi(3))
                        }
                    },
                ),
        )
        .into_any_element()
}
