//! Cap desktop, rewritten in gpui.
//!
//! Milestone 1 is the main recording window (compact + expanded) with real
//! device enumeration. No tauri, no webview: the whole UI is gpui.

mod app_windows;
mod assets;
mod camera_window;
mod controls_window;
mod devices;
mod feeds;
mod main_window;
mod platform;
mod recording;
mod session;
mod store;
mod target_overlay;
mod theme;

use gpui::{App, AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::{assets::Assets, main_window::MainWindow, session::RecordingSession};

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
        let session = RecordingSession::init(cx);
        crate::feeds::Feeds::init(cx);
        crate::target_overlay::TargetSelect::init(cx);

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
                    // Stays `Normal` and gets its panel treatment (level 100,
                    // all Spaces) from `platform::apply_panel_behavior` below.
                    // `WindowKind::Floating` is not the answer: it allocates an
                    // NSPanel, and a panel hides itself when the application
                    // deactivates -- exactly wrong for a recorder.
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
                {
                    let session = session.clone();
                    move |window, cx| cx.new(|cx| MainWindow::new(session, window, cx))
                },
            )
            .expect("failed to open the main window");

        app_windows::init(window_handle, session, cx);

        // Enumeration is started here rather than in `MainWindow::new`, which
        // runs before the window is fully built -- see `start_enumeration`.
        // The panel behavior (`MAIN_PANEL_LEVEL`, all Spaces -- what the Tauri
        // app does via tauri_nspanel) is applied here for the same reason: the
        // NSWindow does not exist yet inside the builder closure.
        window_handle
            .update(cx, |view, window, cx| {
                platform::apply_panel_behavior(
                    window,
                    platform::PanelBehavior {
                        level: platform::MAIN_WINDOW_LEVEL,
                        join_all_spaces: true,
                        shadow: true,
                    },
                );
                view.start_enumeration(window, cx)
            })
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
        } else if let Some(kind) = main_window::auto_overlay_kind() {
            // `CAP_GPUI_AUTO_OVERLAY` without a recording: put the overlays up
            // and leave them there, which is how they get screenshotted.
            window_handle
                .update(cx, |view, window, cx| {
                    view.auto_open_overlay(kind, window, cx)
                })
                .expect("failed to arm the target overlay");
        }
        cx.activate(true);
    });
}
