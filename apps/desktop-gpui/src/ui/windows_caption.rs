use gpui::{
    Div, InteractiveElement, ParentElement, StatefulInteractiveElement, Styled, div,
    prelude::FluentBuilder, px, rgb, rgba, svg,
};

use crate::theme::Theme;

pub fn windows_caption_controls(
    theme: Theme,
    active: bool,
    maximized: bool,
    minimizable: bool,
    resizable: bool,
) -> Div {
    let dark = theme.is_dark();
    let hover = rgba(if dark { 0xffffff0d } else { 0x0000000d });
    let pressed = rgba(if dark { 0xe9e9e908 } else { 0x00000008 });
    let button = |id: &'static str, icon: &'static str, height: f32, enabled: bool| {
        let foreground = Theme::with_alpha(
            rgb(if dark { 0xffffff } else { 0x12161f }),
            if active && enabled { 0.8 } else { 0.4 },
        );

        div()
            .id(id)
            .group(id)
            .when(enabled, |button| button.tab_index(0))
            .w(px(46.))
            .h_full()
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .cursor_default()
            .occlude()
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .when(enabled, |button| {
                button
                    .hover(move |style| {
                        style.bg(if id == "caption-close" {
                            rgb(0xc42b1c)
                        } else {
                            hover
                        })
                    })
                    .active(move |style| {
                        style.bg(if id == "caption-close" {
                            rgba(0xc42b1ce6)
                        } else {
                            pressed
                        })
                    })
            })
            .child(
                svg()
                    .path(icon)
                    .id("caption-glyph")
                    .w(px(10.))
                    .h(px(height))
                    .text_color(foreground)
                    .when(id == "caption-close", |icon| {
                        icon.group_hover("caption-close", |style| style.text_color(gpui::white()))
                            .group_active("caption-close", |style| style.text_color(gpui::white()))
                    }),
            )
    };

    div()
        .flex()
        .h_full()
        .flex_shrink_0()
        .occlude()
        .child(
            button(
                "caption-minimize",
                "icons/caption-minimize-windows.svg",
                1.,
                minimizable,
            )
            .when(minimizable, |button| {
                button.on_click(|_, window, _| window.minimize_window())
            }),
        )
        .when(resizable, |row| {
            row.child(
                button(
                    "caption-maximize",
                    if maximized {
                        "icons/caption-restore-windows.svg"
                    } else {
                        "icons/caption-maximize-windows.svg"
                    },
                    if maximized { 11. } else { 10. },
                    true,
                )
                .on_click(|_, window, _| {
                    if let Some(native) = crate::platform::native_window(window) {
                        crate::platform::zoom_native(&native);
                    }
                }),
            )
        })
        .child(
            button(
                "caption-close",
                "icons/caption-close-windows.svg",
                10.,
                true,
            )
            .on_click(|_, window, cx| {
                crate::menus::close_window_by_handle(window.window_handle(), cx);
            }),
        )
}
