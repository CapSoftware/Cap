//! Cap desktop, rewritten in gpui.
//!
//! Milestone 1 is the main recording window (compact + expanded) with real
//! device enumeration. No tauri, no webview: the whole UI is gpui.

mod assets;
mod devices;

use gpui::{
    App, AppContext as _, Bounds, TitlebarOptions, WindowBounds, WindowOptions, div, prelude::*, px,
    size,
};

use crate::assets::Assets;

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cap_desktop_gpui=info".into()),
        )
        .init();

    let app = gpui_platform::application().with_assets(Assets);
    app.run(|cx: &mut App| {
        gpui_tokio::init(cx);

        if let Err(error) = Assets.load_fonts(cx) {
            tracing::error!("failed to load embedded fonts: {error:#}");
        }

        let bounds = Bounds::centered(None, size(px(330.), px(395.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: None,
                    appears_transparent: true,
                    traffic_light_position: Some(gpui::point(px(12.), px(12.))),
                }),
                app_owns_titlebar_drag: true,
                window_background: gpui::WindowBackgroundAppearance::Transparent,
                is_resizable: false,
                ..Default::default()
            },
            |_window, cx| {
                cx.new(|_cx| Placeholder {
                    _private: std::marker::PhantomData,
                })
            },
        )
        .expect("failed to open the main window");
        cx.activate(true);
    });
}

struct Placeholder {
    _private: std::marker::PhantomData<()>,
}

impl Render for Placeholder {
    fn render(&mut self, _window: &mut gpui::Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .rounded(px(16.))
            .bg(gpui::rgb(0x111111))
            .text_color(gpui::rgb(0xa1a1a1))
            .child("Cap")
    }
}
