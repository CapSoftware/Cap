//! Cap desktop, rewritten in gpui.
//!
//! Milestone 1 is the main recording window (compact + expanded) with real
//! device enumeration. No tauri, no webview: the whole UI is gpui.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod app_windows;
mod assets;
mod auth;
#[cfg(target_os = "macos")]
mod camera_bench;
#[cfg(target_os = "macos")]
mod camera_blur;
#[cfg(any(not(target_os = "macos"), test))]
mod camera_blur_portable;
mod camera_window;
mod controls_window;
mod deeplink;
mod dev_restore;
mod devices;
mod diagnostics;
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
mod hotkeys;
mod import;
mod library;
mod main_window;
mod menus;
mod mode_select_window;
mod onboarding_audio;
mod onboarding_window;
mod permissions;
mod permissions_ui;
mod platform;
mod presets;
mod recording;
mod screenshot;
mod screenshot_annotations;
mod screenshot_crop;
mod screenshot_editor;
mod screenshot_export;
mod session;
mod settings_pages;
mod settings_window;
mod single_instance;
mod store;
mod target_overlay;
mod target_thumbnails;
mod teleprompter_window;
mod theme;
mod transcription;
mod tray;
mod ui;
mod updates;
mod upload;

use gpui::{App, AppContext as _, Bounds, WindowBounds, WindowOptions, px, size};

use crate::{assets::Assets, main_window::MainWindow, session::RecordingSession};

const MAIN_WINDOW_WIDTH: f32 = 330.;
const MAIN_WINDOW_HEIGHT: f32 = 440.;

/// The corner radius the native material is clipped to. `radius = 16` for
/// material `"panel"` on both visual systems in
/// `apps/desktop/src/utils/macos-window-material.ts`, and the same 16 the
/// shell paints with (`rounded-[16px]`).
#[cfg(target_os = "macos")]
const MAIN_WINDOW_MATERIAL_RADIUS: f64 = 16.;

fn parse_auto_record(spec: &str) -> Option<(main_window::Mode, u64)> {
    if spec == "screenshot" {
        // A capture has no duration; the harness arms the target, captures,
        // and the stop half of the driver is a no-op on an idle session.
        return Some((main_window::Mode::Screenshot, 0));
    }
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

/// `CAP_GPUI_AUTO_SCREENSHOT_EDITOR`: a screenshot `.cap` path, or `1` for
/// the newest screenshot in the library -- [`resolve_auto_editor`]'s shape
/// for the screenshot editor.
fn resolve_auto_screenshot_editor(target: &str) -> Option<std::path::PathBuf> {
    if target != "1" {
        let path = std::path::PathBuf::from(target);
        return path.is_dir().then_some(path);
    }
    library::recent_media()
        .into_iter()
        .find(|item| item.kind == library::MediaKind::Screenshot)
        .map(|item| item.bundle)
}

/// stdout, plus a rolling daily file the Feedback page can upload.
///
/// Mirrors `src-tauri/src/main.rs`: `tracing_appender::rolling::daily` into
/// `~/Library/Logs/so.cap.desktop` on macOS (the directory the Tauri app
/// already writes into) under a **different** filename prefix, so the two apps
/// never interleave lines into one file. Returns the non-blocking writer's
/// guard, which has to outlive `main` or the last lines never reach the disk.
fn init_logging() -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::{Layer as _, layer::SubscriberExt as _, util::SubscriberInitExt as _};

    // The binary is `cap-gpui`, so the crate these spans are recorded under is
    // `cap_gpui` -- not `cap_desktop_gpui`, which is the package name and
    // matches nothing.
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "cap_gpui=info".into())
    };

    let logs_dir = diagnostics::logs_dir();
    let file = match std::fs::create_dir_all(&logs_dir) {
        Ok(()) => {
            let (writer, guard) = tracing_appender::non_blocking(tracing_appender::rolling::daily(
                &logs_dir,
                diagnostics::LOG_FILE_PREFIX,
            ));
            Some((
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(writer)
                    .with_filter(filter()),
                guard,
            ))
        }
        Err(error) => {
            // A log file is a nice-to-have; losing it must never stop the app.
            eprintln!("failed to create the logs directory {logs_dir:?}: {error}");
            None
        }
    };
    let (file_layer, guard) = match file {
        Some((layer, guard)) => (Some(layer), Some(guard)),
        None => (None, None),
    };

    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(filter()))
        .with(file_layer)
        .init();
    guard
}

fn main() {
    #[cfg(target_os = "linux")]
    if let Some(threads) = cap_utils::linux_runtime::llvmpipe_thread_count() {
        // Mesa counts host CPUs inside containers; apply the process limit before logging starts threads.
        unsafe {
            std::env::set_var("LP_NUM_THREADS", threads.to_string());
        }
    }

    #[cfg(target_os = "linux")]
    if let Some(config) = cap_utils::linux_package::appimage_alsa_config_path() {
        // Logging starts a worker thread, so configure the process environment first.
        unsafe {
            std::env::set_var("ALSA_CONFIG_PATH", config);
        }
    }

    let _log_guard = init_logging();

    single_instance::acquire();
    store::mark_handoff_session();

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
                    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
                    titlebar: None,
                    #[cfg(target_os = "windows")]
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Cap".into()),
                        appears_transparent: true,
                        ..Default::default()
                    }),
                    #[cfg(target_os = "linux")]
                    titlebar: Some(gpui::TitlebarOptions {
                        title: Some("Cap".into()),
                        ..Default::default()
                    }),
                    #[cfg(target_os = "linux")]
                    app_id: Some("Cap".into()),
                    #[cfg(target_os = "linux")]
                    window_min_size: Some(size(px(MAIN_WINDOW_WIDTH), px(MAIN_WINDOW_HEIGHT))),
                    #[cfg(target_os = "linux")]
                    window_decorations: Some(gpui::WindowDecorations::Client),
                    #[cfg(target_os = "macos")]
                    kind: gpui::WindowKind::Floating,
                    #[cfg(not(target_os = "macos"))]
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
            .inspect_err(|error| tracing::error!("failed to open the main window: {error:#}"));
        let Ok(window_handle) = window_handle else {
            cx.quit();
            return;
        };

        cx.on_app_quit(|_| async {
            crate::store::clear_handoff_marker();
        })
        .detach();

        app_windows::init(window_handle, session, cx);
        #[cfg(target_os = "macos")]
        match platform::install_native_quit_handler() {
            Ok(requests) => {
                cx.spawn(async move |cx| {
                    while requests.recv_async().await.is_ok() {
                        cx.update(menus::quit);
                    }
                })
                .detach();
            }
            Err(error) => {
                tracing::error!(%error, "Could not install safe native Quit handling");
                menus::quit(cx);
                return;
            }
        }
        #[cfg(target_os = "linux")]
        single_instance::init_linux_reopen(cx);
        updates::schedule_startup_check(cx);
        upload::queue::init(cx);

        // The app menu (and with it ⌘W/⌘M/⌘Q) and the status-bar item. Both
        // reach into the window registry, so they come after it -- and the menu
        // before the tray, because the tray's Quit item is the menu's Quit.
        if !std::env::var("CAP_GPUI_NO_MENUS").is_ok_and(|v| v == "1") {
            menus::init(cx);
        }
        if !std::env::var("CAP_GPUI_NO_TRAY").is_ok_and(|v| v == "1") {
            tray::init(cx);
        }
        // The store's global shortcuts, after the registry they dispatch into.
        hotkeys::init(cx);
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
                #[cfg(target_os = "linux")]
                if let Err(error) = platform::remove_x11_window_decorations(window) {
                    tracing::warn!(%error, "could not remove X11 main window decorations");
                }
                tracing::info!(
                    number = platform::window_number(window),
                    "main window opened"
                );
                view.start_enumeration(window, cx);
                view.start_recovery_check(window, cx);
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
        #[cfg(target_os = "macos")]
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
        #[cfg(not(target_os = "macos"))]
        let _ = native_main;

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

        permissions_ui::auto_open_from_env(cx); // `CAP_GPUI_AUTO_PERMISSIONS=1`: the permissions surface.

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

        // `CAP_GPUI_AUTO_HOTKEY=<store key>`: run a hotkey action's dispatch
        // arm (e.g. `screenshotDisplay`) as if the OS shortcut fired.
        if let Ok(action) = std::env::var("CAP_GPUI_AUTO_HOTKEY")
            && !action.is_empty()
        {
            let action = action.clone();
            cx.spawn(async move |cx| {
                // Give enumeration and the first paint the same beat the
                // other harness hooks give them.
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(2))
                    .await;
                cx.update(|cx| hotkeys::dispatch_for_harness(&action, cx));
            })
            .detach();
        }

        // `CAP_GPUI_AUTO_SCREENSHOT_EDITOR=<path-to-.cap>` (or `1` for the
        // newest screenshot): open the screenshot editor the way a Recents
        // card does.
        if let Ok(target) = std::env::var("CAP_GPUI_AUTO_SCREENSHOT_EDITOR")
            && !target.is_empty()
        {
            match resolve_auto_screenshot_editor(&target) {
                Some(path) => app_windows::open_screenshot_editor(path, cx),
                None => tracing::error!(
                    target,
                    "CAP_GPUI_AUTO_SCREENSHOT_EDITOR: no screenshot .cap to open"
                ),
            }
        }

        // `CAP_GPUI_AUTO_RECORD=studio:5` / `instant:4` / `screenshot`: arm
        // the primary display and record for N seconds (or capture once). The
        // end-to-end check drives the recorder this way because unprivileged
        // synthetic clicks are dropped.
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
