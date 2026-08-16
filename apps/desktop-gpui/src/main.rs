//! Cap desktop, rewritten in gpui.
//!
//! Milestone 1 is the main recording window (compact + expanded) with real
//! device enumeration. No tauri, no webview: the whole UI is gpui.

mod assets;
mod devices;
mod main_window;
mod recording;
mod theme;

use gpui::{App, AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::{assets::Assets, main_window::MainWindow};

/// Matches the Tauri main window exactly (`CapWindowId::Main`).
const MAIN_WINDOW_WIDTH: f32 = 330.;
const MAIN_WINDOW_HEIGHT: f32 = 395.;

fn parse_auto_record(spec: &str) -> Option<(main_window::Mode, u64)> {
    let (mode, secs) = spec.split_once(':')?;
    let mode = match mode {
        "studio" => main_window::Mode::Studio,
        "instant" => main_window::Mode::Instant,
        _ => return None,
    };
    Some((mode, secs.parse().ok()?))
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            // The binary is `cap-gpui`, so the crate these spans are recorded
            // under is `cap_gpui` -- not `cap_desktop_gpui`, which is the
            // package name and matches nothing.
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "cap_gpui=info".into()),
        )
        .init();

    let app = gpui_platform::application().with_assets(Assets);
    app.run(|cx: &mut App| {
        gpui_tokio::init(cx);

        if let Err(error) = Assets.load_fonts(cx) {
            tracing::error!("failed to load embedded fonts: {error:#}");
        }

        // 330x395 is what `CapWindowId::Main::min_size` uses in the Tauri app,
        // and the window is fixed at that size there too.
        let bounds = Bounds::centered(
            None,
            size(px(MAIN_WINDOW_WIDTH), px(MAIN_WINDOW_HEIGHT)),
            cx,
        );
        let window_handle = cx
            .open_window(
                WindowOptions {
                    window_bounds: Some(WindowBounds::Windowed(bounds)),
                    // `None`, not a transparent titlebar with repositioned traffic
                    // lights: the Tauri main window returns `None` from
                    // `traffic_lights_position`, which routes it to
                    // `.decorations(false)`. There is no titlebar and there are no
                    // traffic lights -- the whole shell is custom-drawn. In gpui a
                    // `None` titlebar drops NSClosable/NSMiniaturizable/NSResizable
                    // from the style mask, which is the equivalent.
                    titlebar: None,
                    // TODO: always-on-top, `visible_on_all_workspaces(true)`
                    // and the NSPanel level-100 treatment the Tauri window
                    // gets. `WindowKind::Floating` is not the answer: it does
                    // float at NSFloatingWindowLevel, but it allocates an
                    // NSPanel, and a panel hides itself when the application
                    // deactivates -- the window vanishes the moment you click
                    // another app, which is exactly wrong for a recorder. This
                    // needs the AppKit calls `windows.rs` makes, on a normal
                    // window.
                    kind: gpui::WindowKind::Normal,
                    // The header is dragged by the app via `start_window_move`
                    // rather than by AppKit, so mark the content view as app-owned
                    // titlebar content.
                    app_owns_titlebar_drag: true,
                    window_background: gpui::WindowBackgroundAppearance::Transparent,
                    is_resizable: false,
                    is_minimizable: false,
                    ..Default::default()
                },
                |window, cx| cx.new(|cx| MainWindow::new(window, cx)),
            )
            .expect("failed to open the main window");

        // Enumeration is started here rather than in `MainWindow::new`, which
        // runs before the window is fully built -- see `start_enumeration`.
        window_handle
            .update(cx, |view, window, cx| view.start_enumeration(window, cx))
            .expect("failed to start device enumeration");

        // `CAP_GPUI_AUTO_RECORD=studio:5` / `instant:4`: arm the primary
        // display and record for N seconds. The end-to-end check drives the
        // recorder this way because unprivileged synthetic clicks are dropped.
        if let Ok(auto) = std::env::var("CAP_GPUI_AUTO_RECORD")
            && let Some((mode, secs)) = parse_auto_record(&auto)
        {
            window_handle
                .update(cx, |view, window, cx| {
                    view.auto_record(mode, secs, window, cx)
                })
                .expect("failed to arm auto-record");
        }
        cx.activate(true);
    });
}
