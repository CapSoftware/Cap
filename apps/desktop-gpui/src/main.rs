//! Cap desktop, rewritten in gpui.
//!
//! Milestone 1 is the main recording window (compact + expanded) with real
//! device enumeration. No tauri, no webview: the whole UI is gpui.

mod app_windows;
mod assets;
mod auth;
#[cfg(target_os = "macos")]
mod camera_bench;
mod camera_window;
mod controls_window;
mod dev_restore;
mod devices;
mod editor_audio;
mod editor_canvas;
mod editor_clips;
mod editor_color;
mod editor_crop;
mod editor_edits;
mod editor_export;
mod editor_panels;
mod editor_sidebar;
mod editor_tabs;
mod editor_timeline;
mod editor_window;
mod feeds;
mod import;
mod library;
mod main_window;
mod menus;
mod mode_select_window;
mod onboarding_window;
mod permissions;
mod platform;
mod presets;
mod recording;
mod session;
mod settings_pages;
mod settings_window;
mod single_instance;
mod store;
mod target_overlay;
mod teleprompter_window;
mod theme;
mod transcription;
mod tray;
mod ui;
mod upload;

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

/// `CAP_GPUI_AUTO_EDITOR`: a `.cap` path, or `1` for the newest studio
/// recording the library scan finds. The library is the same one Recents
/// reads, so `=1` opens exactly the card that would be first in the carousel
/// (skipping instant recordings and screenshots, which the editor rejects).
fn resolve_auto_editor(target: &str) -> Option<std::path::PathBuf> {
    if target != "1" {
        let path = std::path::PathBuf::from(target);
        return path.is_dir().then_some(path);
    }
    library::recent_media()
        .into_iter()
        .find(|item| item.kind == library::MediaKind::Studio)
        .map(|item| item.bundle)
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

    // A relaunch means "run the code I just built": take over from any
    // previous instance still alive in the tray (see `single_instance`).
    single_instance::acquire();

    platform::install_url_scheme_handler();
    for argument in std::env::args().skip(1) {
        if argument.contains("token") || argument.contains("api_key") {
            crate::auth::submit_deep_link(&argument);
        }
    }

    let app = gpui_platform::application().with_assets(Assets);
    // `RunEvent::Reopen`: the dock icon clicked while the app runs. Must be
    // registered on the builder -- gpui exposes it nowhere else -- with the
    // handler guarding against firing before the window registry exists.
    app.on_reopen(crate::app_windows::handle_dock_reopen);
    app.run(|cx: &mut App| {
        gpui_tokio::init(cx);
        // The dock icon: an unbundled dev binary shows the generic terminal
        // document without it. The bytes are the shipping app's icon.png.
        platform::set_dock_icon(include_bytes!("../assets/dock-icon.png"));

        if let Err(error) = Assets.load_fonts(cx) {
            tracing::error!("failed to load embedded fonts: {error:#}");
        }

        // 330x395 is what `CapWindowId::Main::min_size` uses in the Tauri app,
        // and the window is fixed at that size there too.
        // The text-input key map. Every editing chord in the app -- Backspace,
        // the arrows, Cmd-A/C/X/V/Z -- is an action scoped to the `TextInput`
        // key context, which is what stops a focused field's Backspace from
        // reaching the editor's delete-the-selection handler: a matched
        // binding consumes the keystroke before any `on_key_down` listener on
        // the path runs (`gpui/src/window.rs:5280-5296`).
        ui::bind_text_input_keys(cx);
        crate::theme::init(cx);

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

        // The app menu (and with it ⌘W/⌘M/⌘Q) and the status-bar item. Both
        // reach into the window registry, so they come after it -- and the menu
        // before the tray, because the tray's Quit item is the menu's Quit.
        if !std::env::var("CAP_GPUI_NO_MENUS").is_ok_and(|v| v == "1") {
            menus::init(cx);
        }
        if !std::env::var("CAP_GPUI_NO_TRAY").is_ok_and(|v| v == "1") {
            tray::init(cx);
        }
        // The gate's TCC queries (screen recording preflight, AXIsProcessTrusted)
        // are ~30ms of synchronous XPC on this Mac -- the whole startup delta
        // between the 08-17 and 08-18 builds. Both are thread-safe reads, so
        // the gate runs off-main and onboarding opens a beat after the main
        // window instead of holding it back.
        cx.spawn(async move |cx| {
            let show_onboarding = cx
                .background_executor()
                .spawn(async { crate::store::should_show_onboarding() })
                .await;
            if show_onboarding {
                cx.update(app_windows::open_onboarding);
            }
        })
        .detach();
        // `CAP_GPUI_AUTO_TRAY` / `CAP_GPUI_TRAY_DUMP`: the tray's harness path.
        tray::drive_from_env(cx);
        // `CAP_GPUI_AUTO_CLOSE=settings|main:<secs>`: run the ⌘W body against
        // that window after a delay -- exercises the exact deferred close path
        // without synthetic keypresses (which race whatever the user has
        // focused).
        if let Ok(spec) = std::env::var("CAP_GPUI_AUTO_CLOSE")
            && let Some((which, secs)) = spec.split_once(':')
            && let Ok(secs) = secs.parse::<u64>()
        {
            let which = which.to_string();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(secs))
                    .await;
                cx.update(|cx| {
                    let windows = cx.global::<app_windows::AppWindows>();
                    let handle: Option<gpui::AnyWindowHandle> = match which.as_str() {
                        "settings" => windows.settings.map(Into::into),
                        "main" => Some(windows.main.into()),
                        _ => None,
                    };
                    if let Some(handle) = handle {
                        menus::close_window_by_handle(handle, cx);
                    }
                });
            })
            .detach();
        }
        // The Tauri app syncs the dock the moment a dock-activating window is
        // shown; the main window is up by here.
        menus::sync_dock_visibility(cx);

        // `CAP_GPUI_DEV_RESTORE=<state file>`: `dev.sh`'s relaunch loop.
        // Reopens the previous process's windows in place and keeps the
        // state file current for the next swap.
        dev_restore::init(cx);

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
                view.auto_open_recent(window, cx);
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

        // `CAP_GPUI_DEBUG_LIGHTS=1`: poll the main window's style mask and
        // standard-button set, logging on change -- pins down *when* AppKit
        // materializes titlebar buttons on the buttonless main window.
        if std::env::var("CAP_GPUI_DEBUG_LIGHTS").is_ok_and(|v| v == "1") {
            cx.spawn(async move |cx| {
                let mut last = None::<String>;
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(250))
                        .await;
                    let state = cx.update(|cx| {
                        window_handle
                            .update(cx, |_, window, _| platform::debug_titlebar_state(window))
                            .ok()
                            .flatten()
                    });
                    if state != last {
                        tracing::info!(?state, "titlebar state changed");
                        last = state;
                    }
                }
            })
            .detach();
        }

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

        // `CAP_GPUI_AUTO_CAMERA_BENCH=1`: open the camera bubble and pump
        // synthetic frames through the production delivery path, reporting
        // gpui draw timings for that window. See `camera_bench`.
        #[cfg(target_os = "macos")]
        if std::env::var("CAP_GPUI_AUTO_CAMERA_BENCH").is_ok_and(|v| v == "1") {
            camera_bench::run(cx);
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

        // `CAP_GPUI_AUTO_EDITOR=<path-to-.cap>`: open the editor on that
        // bundle the way a Recents card does. `=1` picks the newest studio
        // recording in the library. Same reason as the other `CAP_GPUI_AUTO_*`
        // hooks -- unprivileged synthetic clicks are dropped, so the
        // screenshot harness needs a way in.
        if let Ok(target) = std::env::var("CAP_GPUI_AUTO_EDITOR")
            && !target.is_empty()
        {
            match resolve_auto_editor(&target) {
                Some(path) => app_windows::open_editor(path, cx),
                None => tracing::error!(target, "CAP_GPUI_AUTO_EDITOR: no studio .cap to open"),
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
        // Under the dev loop the app relaunches on every save; activating
        // would yank focus from the code editor each time. The restored
        // windows come forward with `orderFrontRegardless` instead, and the
        // main window floats at panel level 100 regardless of activation.
        if !dev_restore::enabled() {
            cx.activate(true);
        }
    });
}
