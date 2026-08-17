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
mod library;
mod main_window;
mod mode_select_window;
mod platform;
mod recording;
mod session;
mod settings_window;
mod store;
mod target_overlay;
mod teleprompter_window;
mod theme;

use gpui::{App, AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::{assets::Assets, main_window::MainWindow, session::RecordingSession};

/// Matches the Tauri main window exactly (`CapWindowId::Main`).
const MAIN_WINDOW_WIDTH: f32 = 330.;
const MAIN_WINDOW_HEIGHT: f32 = 395.;

/// The corner radius the native material is clipped to. `radius = 16` for
/// material `"panel"` on both visual systems in
/// `apps/desktop/src/utils/macos-window-material.ts`, and the same 16 the
/// shell paints with (`rounded-[16px]`).
const MAIN_WINDOW_MATERIAL_RADIUS: f64 = 16.;

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
        let native_main = window_handle
            .update(cx, |view, window, cx| {
                platform::apply_panel_behavior(
                    window,
                    platform::PanelBehavior {
                        level: platform::MAIN_WINDOW_LEVEL,
                        join_all_spaces: true,
                        shadow: true,
                    },
                );
                tracing::info!(
                    number = platform::window_number(window),
                    "main window opened"
                );
                view.start_enumeration(window, cx);
                view.auto_expand(window, cx);
                // The AppKit work below must not run inside this update:
                // inserting a subview and mutating the content view's layer
                // synchronously re-enters gpui's own window callbacks, which
                // re-borrow the App. Grab the retained NSWindow here, act on
                // it from a task (the `place_overlay_panel` rule).
                platform::native_window(window)
            })
            .expect("failed to start device enumeration");

        // The native window material: `NSGlassEffectView` on macOS 26+,
        // `NSVisualEffectView` vibrancy below that -- what
        // `applyMacOSWindowMaterial("panel")` does in the Tauri app. Nothing
        // paints it; the shell paints a translucent tint *over* it, so the
        // window has to be told which one landed.
        cx.spawn(async move |cx| {
            let Some(native) = native_main else {
                tracing::error!("no NSWindow behind the main window; material not installed");
                return;
            };
            let kind = platform::install_window_material(&native, MAIN_WINDOW_MATERIAL_RADIUS);
            match kind {
                Some(kind) => tracing::info!(?kind, "installed main window material"),
                None => tracing::info!("no native window material available"),
            }
            cx.update(|cx| {
                cx.set_global(platform::WindowMaterial(kind));
                // The palette is resolved in `render`, which has already run
                // by now -- nudge it so the tint replaces the opaque shell.
                window_handle.update(cx, |_, _, cx| cx.notify()).ok();
            });
        })
        .detach();

        // `CAP_GPUI_AUTO_SETTINGS=1` (or a page slug, e.g. `hotkeys`): open
        // the settings window the way the header gear does. Same reason as
        // every other `CAP_GPUI_AUTO_*` hook -- unprivileged synthetic clicks
        // are dropped, so the screenshot harness needs a way in.
        if let Ok(page) = std::env::var("CAP_GPUI_AUTO_SETTINGS")
            && !page.is_empty()
        {
            let page =
                settings_window::Page::from_slug(&page).unwrap_or(settings_window::Page::General);
            app_windows::open_settings(page, cx);
        }

        // `CAP_GPUI_AUTO_MODE_SELECT=1`: open the 580x340 mode picker the way
        // the mode dot does, main window hidden included. A mode name instead
        // of `1` also clicks that card.
        if let Ok(mode) = std::env::var("CAP_GPUI_AUTO_MODE_SELECT")
            && !mode.is_empty()
        {
            app_windows::open_mode_select(cx);
            if let Some(mode) = match mode.as_str() {
                "instant" => Some(main_window::Mode::Instant),
                "studio" => Some(main_window::Mode::Studio),
                "screenshot" => Some(main_window::Mode::Screenshot),
                _ => None,
            } {
                app_windows::choose_mode_in_mode_select(mode, cx);
            }
        }

        // `CAP_GPUI_AUTO_TELEPROMPTER=1`: open the teleprompter the way the
        // header's scan-text button does. Same reason as the other hooks:
        // unprivileged synthetic clicks are dropped. Any other value is typed
        // into the script through the same path a keystroke takes, which is how
        // the persistence round trip is checked.
        if let Ok(script) = std::env::var("CAP_GPUI_AUTO_TELEPROMPTER")
            && !script.is_empty()
        {
            app_windows::open_teleprompter(cx);
            if script != "1" {
                app_windows::type_into_teleprompter(script, cx);
            }
            // `CAP_GPUI_AUTO_PLAY=1`: press play once the window has painted --
            // the scrollable height, which is what decides whether playback can
            // start at all, does not exist before the first frame.
            if std::env::var("CAP_GPUI_AUTO_PLAY").is_ok_and(|value| value == "1") {
                cx.spawn(async move |cx| {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(1200))
                        .await;
                    cx.update(app_windows::play_teleprompter);
                })
                .detach();
            }
        }

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
