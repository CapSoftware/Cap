//! Multi-window orchestration -- the `windows.rs` of the gpui app.
//!
//! The registry lives in a global; the recording flow is driven by observing
//! the [`RecordingSession`]: the caller opens the bar and hides the main
//! window *before* starting the engine (the bar's window number has to exist
//! to be excluded from capture, and the real app shows the bar in its
//! "Starting" state from t=0), and the observer closes the bar and reshows the
//! main window whenever the session comes back to rest.

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    App, AppContext as _, Bounds, Entity, Global, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, point, px, size,
};
use scap_targets::DisplayId;

use crate::{
    camera_window::{self, CameraWindow},
    controls_window::ControlsWindow,
    editor_timeline,
    editor_window::{self, EditorWindow},
    main_window::{MainWindow, Mode, TargetType},
    mode_select_window::{self, ModeSelectWindow},
    onboarding_window::{self, OnboardingWindow},
    platform,
    recording::{RecordingMode, StartConfig},
    screenshot_editor::{self, ScreenshotEditorWindow},
    session::{Phase, RecordingSession},
    settings_window::{self, Page, SettingsWindow},
    target_overlay::{AreaRect, HoveredWindow, OverlayWindow, TargetSelect},
    teleprompter_window::{self, TeleprompterWindow},
};

/// Matches the Tauri `InProgressRecording` window and
/// `fake_window.rs` position math.
pub const CONTROLS_WIDTH: f32 = 320.;
pub const CONTROLS_HEIGHT: f32 = 150.;
const CONTROLS_BOTTOM_OFFSET: f64 = 120.;
const TARGET_CONTROLS_OFFSET_Y: f64 = 48.;

pub struct AppWindows {
    pub main: WindowHandle<MainWindow>,
    pub controls: Option<WindowHandle<ControlsWindow>>,
    pub camera: Option<WindowHandle<CameraWindow>>,
    pub settings: Option<WindowHandle<SettingsWindow>>,
    pub onboarding: Option<WindowHandle<OnboardingWindow>>,
    pub mode_select: Option<WindowHandle<ModeSelectWindow>>,
    pub teleprompter: Option<WindowHandle<TeleprompterWindow>>,
    /// One target-select overlay per display, keyed by display so a mode
    /// switch can keep the ones it still wants.
    pub overlays: Vec<(DisplayId, WindowHandle<OverlayWindow>)>,
    /// One editor per `.cap` path, reused on re-open -- the gpui spelling of
    /// `EditorWindowIds { ids: Arc<Mutex<Vec<(PathBuf, u32)>>> }`
    /// (`windows.rs:3656-3659`). The Tauri app keys its label off an
    /// incrementing id; the path is the identity in both.
    pub editors: Vec<(PathBuf, WindowHandle<EditorWindow>)>,
    /// One screenshot editor per `.cap` bundle -- the gpui spelling of
    /// `ScreenshotEditorWindowIds`, keyed by the bundle directory.
    pub screenshot_editors: Vec<(PathBuf, WindowHandle<ScreenshotEditorWindow>)>,
    /// `hasHiddenMainWindowForPicker` (`new-main/index.tsx:2016-2059`): the
    /// main window hides while the target picker is up, and comes back only on
    /// a dismissal that reveals ("cancelled" -- Escape, the overlay's close
    /// button, the tile toggled off). A recording start hands the foreground
    /// to the bar instead. Set even when the window was already hidden (the
    /// tray path): the Tauri effect does the same, which is why cancelling a
    /// tray-opened picker reveals the main window.
    pub main_hidden_for_picker: bool,
}

impl Global for AppWindows {}

/// Install the registry and wire the session observer that tears the bar down
/// when a recording ends (stop, delete, or a failed start).
pub fn init(main: WindowHandle<MainWindow>, session: Entity<RecordingSession>, cx: &mut App) {
    cx.set_global(AppWindows {
        main,
        controls: None,
        camera: None,
        settings: None,
        onboarding: None,
        mode_select: None,
        teleprompter: None,
        overlays: Vec::new(),
        editors: Vec::new(),
        screenshot_editors: Vec::new(),
        main_hidden_for_picker: false,
    });

    // The global-Escape drain: the Carbon hotkey (registered only while the
    // target picker is up -- `open_target_overlays`) posts here, and the
    // dismissal runs with a clean borrow. One task for the life of the
    // process, the tray-channel shape.
    let escape = platform::escape_hotkey_events();
    cx.spawn(async move |cx| {
        while escape.recv_async().await.is_ok() {
            cx.update(dismiss_target_overlays);
        }
    })
    .detach();

    let mut last_phase = Phase::Idle;
    cx.observe(&session, move |session, cx| {
        let phase = session.read(cx).phase;
        let recording = matches!(phase, Phase::Recording { .. });
        if recording != matches!(last_phase, Phase::Recording { .. }) {
            // `RecordingStarted` / `RecordingStopped` in `create_tray`: the
            // status item becomes a stop button while a capture runs.
            crate::tray::set_recording(recording, cx);
        }
        if phase == Phase::Idle && last_phase != Phase::Idle {
            close_controls(&session, cx);
            // `postStudioRecordingBehaviour` (`openEditor` is the default):
            // a cleanly-stopped studio recording goes straight to the editor,
            // main window staying hidden -- `editor_closed` brings it back
            // once the last editor goes away. Every other path (instant,
            // failures, `showOverlay` until an overlay exists) reshows the
            // main window as before.
            let finished_studio = session.update(cx, |session, _| session.finished_studio.take());
            let editor_project = finished_studio.filter(|_| {
                crate::store::GeneralSettings::load().post_studio_recording_behaviour
                    == crate::store::PostStudioBehaviour::OpenEditor
            });
            match editor_project {
                Some(project_dir) => open_editor(project_dir, cx),
                None => show_main_window(cx),
            }
            // `NewStudioRecordingAdded` -> `add_new_item_to_cache` +
            // `refresh_tray_menu`. The reshow is where the main window's own
            // Recents is rescanned, so the tray's Previous rides the same seam.
            crate::tray::refresh_previous(cx);
            // `apply_content_protection(app, false)` when the recording ends:
            // an always-excluded window is invisible on capture-based displays,
            // so the protection only holds while a capture is running.
            set_teleprompter_content_protection(false, cx);
        }
        last_phase = phase;
    })
    .detach();
}

/// `createThemeListener` + `commands.setTheme`: persist is already done; this
/// forces native appearance on every open window and invalidates so each
/// `sync_appearance` rebuilds the palette.
pub fn broadcast_theme(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let windows = cx.global::<AppWindows>();
    let main = windows.main;
    let settings = windows.settings;
    let onboarding = windows.onboarding;
    let mode_select = windows.mode_select;
    let teleprompter = windows.teleprompter;
    let controls = windows.controls;
    let camera = windows.camera;
    let overlays: Vec<_> = windows.overlays.iter().map(|(_, handle)| *handle).collect();
    let editors: Vec<_> = windows.editors.iter().map(|(_, handle)| *handle).collect();
    let screenshot_editors: Vec<_> = windows
        .screenshot_editors
        .iter()
        .map(|(_, handle)| *handle)
        .collect();

    let refresh = |window: &mut gpui::Window, cx: &mut gpui::App| {
        crate::theme::apply_native(window, cx);
    };

    let _ = main.update(cx, |_, window, cx| {
        refresh(window, cx);
        cx.notify();
    });
    if let Some(handle) = settings {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = onboarding {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = mode_select {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = teleprompter {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = controls {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    if let Some(handle) = camera {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in overlays {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in editors {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
    for handle in screenshot_editors {
        let _ = handle.update(cx, |_, window, cx| {
            refresh(window, cx);
            cx.notify();
        });
    }
}

/// `makeKeyAndOrderFront:` re-enters gpui's window callbacks, so it runs from
/// a task, never inside the borrow that decided to call it (the
/// `place_overlay_panel` rule).
///
/// Public because the tray's "Open Main Window" is exactly this
/// (`ShowCapWindow::Main { init_target_mode: None }`).
pub fn show_main_window(cx: &mut App) {
    if crate::store::should_show_onboarding() {
        open_onboarding(cx);
        return;
    }
    let main = cx.global::<AppWindows>().main;
    let native = main
        .update(cx, |view, window, cx| {
            // Every path back to the main window is a path a new capture may
            // have arrived on -- a finished recording most of all. The Tauri
            // app gets this from `invalidateRecentMedia` plus the query's
            // focus gate; here the reshow *is* the trigger, so a recording
            // made a moment ago is in the list without a restart.
            view.refresh_recents(window, cx);
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            // The recording flow leaves foreign titlebar buttons on the
            // hidden window (see `restore_borderless_style`); strip them
            // before the window is visible again.
            platform::restore_borderless_style(native);
            platform::show_native(native);
        }
        // The unit-3 macOS 26 display-link repair, and the reason a window
        // hidden before its FIRST paint reshows as nothing at all: AppKit
        // reports it visible (alpha 1, on the active Space) but it has no
        // backing surface and the frozen link never delivers one. Kick it and
        // ask for a frame, the `open_settings` recipe.
        cx.update(|cx| {
            main.update(cx, |_, window, cx| {
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
        });
        // `ShowCapWindow::show` ends with `sync_macos_dock_visibility` for
        // every window that `activates_dock()`, and Main is one. Scheduled
        // *after* the window is on screen, or the policy would be computed
        // from a still-hidden window. An Accessory app also has no menu bar,
        // so the sync's `cx.activate(true)` is what brings both back.
        cx.update(crate::menus::schedule_dock_sync);
    })
    .detach();
}

/// `getCurrentWindow().hide()` -- same rule, same reason.
pub fn hide_main_window(cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    let native = main
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            platform::hide_native(native);
            tracing::info!("main window hidden");
        }
        cx.update(crate::menus::schedule_dock_sync);
    })
    .detach();
}

/// ⌘W, the File/Window menus' Close Window, and the main window's own red
/// traffic light.
///
/// `CapWindowId::Main`'s `CloseRequested` arm (`lib.rs:5644-5697`), transcribed:
/// prevent the close and hide the window, sync the dock, and -- when nothing is
/// recording -- hide the camera bubble, close the target-select overlays, pause
/// the camera preview and release the mic and camera feeds.
///
/// Two deviations, both noted in the report: the camera bubble is *closed*
/// rather than hidden (this app has no hide-in-place path for it, and the
/// observable result is the same bubble-off-screen), and `camera_preview.pause()`
/// has no counterpart because there is no preview stream server here -- the
/// preview is the bubble, and closing it stops the pump.
pub fn request_close_main(cx: &mut App) {
    hide_main_window(cx);

    // `state.is_recording_active_or_pending()`: everything but Idle.
    if RecordingSession::global(cx).read(cx).phase != Phase::Idle {
        return;
    }

    close_camera_window(cx);
    close_target_overlays(cx);
    // Closing the main window explicitly is not a picker dismissal; a stale
    // flag here would reveal the window the user just closed.
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    crate::feeds::Feeds::global(cx).update(cx, |feeds, cx| feeds.release_inputs(cx));
}

/// `RunEvent::Reopen` (`lib.rs:6089-6133`) -- the dock icon clicked while the
/// app runs: focus an editor or the settings window when one is open,
/// otherwise show the main window. (The onboarding arm has no counterpart
/// here, and mode-select is deliberately absent from the focus list over
/// there too.) Registered on the `Application` builder in `main`, with a
/// global guard: the callback can in principle fire before `init` has run.
pub fn handle_dock_reopen(cx: &mut App) {
    if !cx.has_global::<AppWindows>() {
        return;
    }
    let windows = cx.global::<AppWindows>();
    if crate::store::should_show_onboarding() {
        if windows.onboarding.is_some() {
            open_onboarding(cx);
            cx.activate(true);
            return;
        }
        open_onboarding(cx);
        cx.activate(true);
        return;
    }
    let focus: Option<gpui::AnyWindowHandle> = windows
        .editors
        .first()
        .map(|(_, handle)| (*handle).into())
        .or_else(|| windows.settings.map(Into::into));
    tracing::info!(focus_existing = focus.is_some(), "dock reopen");
    match focus {
        Some(handle) => {
            let native = handle
                .update(cx, |_, window, _| platform::native_window(window))
                .ok()
                .flatten();
            cx.spawn(async move |_| {
                if let Some(native) = &native {
                    platform::show_native(native);
                }
            })
            .detach();
        }
        None => show_main_window(cx),
    }
    cx.activate(true);
}

/// Open the settings window on a page, and hide the main window.
///
/// The header gear in `new-main/index.tsx` is
/// `await commands.showWindow({ Settings: { page: "general" } });
/// getCurrentWindow().hide();` -- both halves, in that order. Must be reached
/// through `cx.defer` from anything inside an entity update: opening a window
/// paints it synchronously and would double-lease the caller.
pub fn open_settings(page: Page, cx: &mut App) {
    if let Some(handle) = cx.global::<AppWindows>().settings {
        // `ShowCapWindow::show` reuses a live window: show, focus, and let
        // the page argument re-target it.
        let native = handle
            .update(cx, |view, window, cx| {
                view.set_page(page, window, cx);
                platform::native_window(window)
            })
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(settings_window::SETTINGS_WIDTH),
            px(settings_window::SETTINGS_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // A real titlebar this time, transparent with the buttons moved
            // to (22, 22): `CapWindowId::Settings::traffic_lights_position` is
            // `Some(Some(...))`, which is what keeps the native lights and
            // repositions them. (The main window returns `None` there and
            // hand-draws its own.)
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Settings".into()),
                appears_transparent: true,
                traffic_light_position: Some(settings_window::TRAFFIC_LIGHTS),
            }),
            // A normal window, not a panel: the Tauri Settings window is an
            // ordinary window that activates the dock icon
            // (`activates_dock()`), with no level or Spaces treatment.
            // `WindowKind::Floating` would hide it whenever the app
            // deactivates.
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.resizable(true).maximized(false)`, and `min_inner_size`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(settings_window::SETTINGS_MIN_WIDTH),
                px(settings_window::SETTINGS_MIN_HEIGHT),
            )),
            // `builder.transparent(true)` on macOS -- the panes paint, the
            // material shows through the gap.
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| SettingsWindow::new(page, window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("settings window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().settings = Some(handle);

    // Read the native handle inside the update; act on it outside.
    let native = handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.start_enumeration(window, cx);
            // Whatever the page it opened on has to fetch -- the Recordings
            // page's library scan. Started here rather than in
            // `SettingsWindow::new` for the `start_enumeration` reason: a task
            // spawned inside the builder closure never schedules a frame.
            view.page_shown(window, cx);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                "settings window opened"
            );
            platform::native_window(window)
        })
        .ok()
        .flatten();

    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            // `applyMacOSWindowMaterial("settings")`: same install as the main
            // window, radius 26 instead of 16.
            let kind = platform::install_window_material(
                native,
                settings_window::SETTINGS_MATERIAL_RADIUS,
            );
            match kind {
                Some(kind) => tracing::info!(
                    ?kind,
                    radius = settings_window::SETTINGS_MATERIAL_RADIUS,
                    "installed settings window material"
                ),
                None => tracing::info!("no native window material available for settings"),
            }
            cx.update(|cx| {
                // The main window's install normally gets here first and both
                // windows resolve the same kind; this only fills the global in
                // if the settings window won the race.
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |_, window, cx| {
                // The unit-3 macOS 26 display-link repair, once the window is
                // actually on screen.
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();

    hide_main_window(cx);
}

/// Close the settings window from our side (Cmd-W). The close button goes
/// through `on_window_should_close` -> [`settings_closed`] instead.
pub fn close_settings(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().settings.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    restore_after_settings(cx);
}

/// The settings window is going away on its own. `CapWindowId::Settings`'s
/// `Destroyed` arm calls `restore_main_and_target_select_windows`, so the main
/// window comes back -- otherwise closing settings from the gear flow would
/// leave the app with no visible window at all.
pub fn settings_closed(cx: &mut App) {
    tracing::info!("settings window closed");
    cx.global_mut::<AppWindows>().settings.take();
    restore_after_settings(cx);
}

pub fn open_onboarding(cx: &mut App) {
    if let Some(handle) = cx.global::<AppWindows>().onboarding {
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(onboarding_window::ONBOARDING_WIDTH),
            px(onboarding_window::ONBOARDING_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Welcome to Cap".into()),
                appears_transparent: true,
                traffic_light_position: Some(onboarding_window::TRAFFIC_LIGHTS),
            }),
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: false,
            is_minimizable: true,
            window_min_size: Some(size(
                px(onboarding_window::ONBOARDING_WIDTH),
                px(onboarding_window::ONBOARDING_HEIGHT),
            )),
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| OnboardingWindow::new(window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("onboarding window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().onboarding = Some(handle);
    let native = handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.focus_root(window, cx);
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |_| {
        if let Some(native) = &native {
            platform::show_native(native);
        }
    })
    .detach();
    hide_main_window(cx);
    crate::tray::refresh_menu(cx);
}

pub fn onboarding_finished(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().onboarding.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    crate::tray::refresh_menu(cx);
    show_main_window(cx);
}

pub fn onboarding_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().onboarding.take();
    crate::tray::refresh_menu(cx);
    if !crate::store::should_show_onboarding() {
        show_main_window(cx);
    }
}

pub fn onboarding_is_open(cx: &App) -> bool {
    cx.has_global::<AppWindows>() && cx.global::<AppWindows>().onboarding.is_some()
}

fn restore_after_settings(cx: &mut App) {
    // Not while recording: the main window is deliberately hidden then, and
    // the session observer brings it back when the recording ends.
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        show_main_window(cx);
        return;
    }
    // `sync_macos_dock_visibility` still has to run: a dock-activating window
    // just went away and nothing else scheduled the sync.
    crate::menus::schedule_dock_sync(cx);
}

// -- Mode select ------------------------------------------------------------

/// Open the 580x340 mode picker, and hide the main window.
///
/// `ShowCapWindow::ModeSelect` hides Main first (`windows.rs:2083-2085`) and
/// its `Destroyed` arm brings it back, exactly like Settings. Returns false if
/// the window could not be opened, which is the main window's cue to fall back
/// to its in-body mode-info panel.
///
/// Must be reached through `cx.defer` from inside an entity update: opening a
/// window paints it synchronously and would double-lease the caller.
pub fn open_mode_select(cx: &mut App) -> bool {
    let main = cx.global::<AppWindows>().main;
    let mode = main
        .update(cx, |view, _window, _cx| view.mode())
        .unwrap_or(Mode::Instant);

    if let Some(handle) = cx.global::<AppWindows>().mode_select {
        // A live window is reused, re-reading the mode the way a re-shown
        // webview re-reads the options store.
        let native = handle
            .update(cx, |view, window, cx| {
                view.set_mode(mode, cx);
                platform::native_window(window)
            })
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return true;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(mode_select_window::MODE_SELECT_WIDTH),
            px(mode_select_window::MODE_SELECT_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // `traffic_lights_position` has no ModeSelect arm, so it takes the
            // `_ => Some(None)` catch-all: the native buttons stay where AppKit
            // puts them and only the title is hidden (`hidden_title(true)` +
            // `TitleBarStyle::Overlay`).
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Mode Selection".into()),
                appears_transparent: true,
                traffic_light_position: mode_select_window::TRAFFIC_LIGHTS,
            }),
            // An ordinary window that activates the dock icon
            // (`activates_dock()` lists ModeSelect); no level or Spaces
            // treatment, and no always-on-top (that is Upgrade's).
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.resizable(false).maximized(false).maximizable(false)`, with
            // `min_inner_size == inner_size`.
            is_resizable: false,
            is_minimizable: true,
            // Not in `is_transparent()`'s list: this window is opaque and
            // paints its own `bg-gray-1`, with no native material behind it
            // (`applyMacOSWindowMaterial` runs in the `(window-chrome)` layout,
            // which this route is not part of).
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| ModeSelectWindow::new(mode, window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("mode select window failed to open: {error:#}");
            return false;
        }
    };

    cx.global_mut::<AppWindows>().mode_select = Some(handle);
    handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                "mode select window opened"
            );
        })
        .ok();

    hide_main_window(cx);
    true
}

/// The mode select window is going away: same `Destroyed` arm as Upgrade,
/// which calls `restore_main_and_target_select_windows`.
pub fn mode_select_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().mode_select.take();
    restore_after_settings(cx);
}

/// Click a mode card in the open mode select window (harness path for
/// `CAP_GPUI_AUTO_MODE_SELECT=<mode>`; synthetic clicks are dropped).
pub fn choose_mode_in_mode_select(mode: Mode, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().mode_select else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.choose(mode, cx);
            window.refresh();
        })
        .ok();
}

/// `handleModeChange`: the recording option, then `setRecordingMode`. Every
/// mode affordance -- the main window's pill, its info panel, and the mode
/// select window -- lands here.
pub fn set_recording_mode(mode: Mode, cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.set_mode(mode, cx))
        .ok();
    // Open overlays label their start button with the mode.
    refresh_target_overlays(cx);
}

// -- Teleprompter -----------------------------------------------------------

/// Open (or re-show) the teleprompter -- `openTeleprompter()` in
/// `utils/teleprompter.ts`, which reuses a live window with
/// `unminimize()`/`show()`/`setFocus()` and otherwise builds a new one.
pub fn open_teleprompter(cx: &mut App) {
    if let Some(handle) = cx.global::<AppWindows>().teleprompter {
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(teleprompter_window::TELEPROMPTER_WIDTH),
            px(teleprompter_window::TELEPROMPTER_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // `decorations: true`, `titleBarStyle: "overlay"`, `hiddenTitle:
            // true`, `trafficLightPosition: (14, 14)` -- the real AppKit
            // buttons, moved, as on the settings window.
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Teleprompter".into()),
                appears_transparent: true,
                traffic_light_position: Some(teleprompter_window::TRAFFIC_LIGHTS),
            }),
            // `alwaysOnTop: true` + `visibleOnAllWorkspaces: true` are applied
            // below as level 101 + `CanJoinAllSpaces`, the same way the main
            // window gets level 100 -- a `WindowKind::PopUp` panel would be
            // non-activating, and this window has to take keystrokes for the
            // script.
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `resizable: true`, `minWidth: 420, minHeight: 220`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(teleprompter_window::TELEPROMPTER_MIN_WIDTH),
                px(teleprompter_window::TELEPROMPTER_MIN_HEIGHT),
            )),
            // `transparent: true`, `shadow: true`: the shell paints a tint and
            // the material shows through.
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| TeleprompterWindow::new(window, cx)),
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("teleprompter window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>().teleprompter = Some(handle);

    let opened = handle
        .update(cx, |view, window, cx| {
            // `commands.setTeleprompterWindowLevel(true)` -- level 101, and the
            // `visibleOnAllWorkspaces` half.
            platform::apply_panel_behavior(
                window,
                platform::PanelBehavior {
                    level: platform::teleprompter_level(),
                    join_all_spaces: true,
                    // `shadow: true` in the window options.
                    shadow: true,
                },
            );
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                level = platform::teleprompter_level(),
                "teleprompter window opened"
            );
            (platform::native_window(window), view.window_alpha())
        })
        .ok();

    let Some((native, alpha)) = opened else {
        return;
    };

    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            // `applyMacOSWindowMaterial("teleprompter")`: radius 22 on glass.
            let kind = platform::install_window_material(
                native,
                teleprompter_window::TELEPROMPTER_MATERIAL_RADIUS,
            );
            match kind {
                Some(kind) => tracing::info!(
                    ?kind,
                    radius = teleprompter_window::TELEPROMPTER_MATERIAL_RADIUS,
                    "installed teleprompter window material"
                ),
                None => tracing::info!("no native window material available for the teleprompter"),
            }
            // The opacity effect's first run.
            let applied = platform::set_window_alpha(native, alpha);
            tracing::info!(requested = alpha, applied, "teleprompter window alpha");
            cx.update(|cx| {
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |_, window, cx| {
                platform::kick_display_link(window);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();
}

/// Type into the open teleprompter (harness path for
/// `CAP_GPUI_AUTO_TELEPROMPTER=<script>`; synthetic key events are dropped
/// without Accessibility, and this drives the same `edit_script` the key
/// handler does, debounced write included).
pub fn type_into_teleprompter(text: String, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.type_script(&text, window, cx);
            window.refresh();
        })
        .ok();
}

/// Drive the teleprompter's play button (harness path for
/// `CAP_GPUI_AUTO_PLAY=1`). Only meaningful once the window has painted --
/// the scrollable height does not exist before that.
pub fn play_teleprompter(cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    handle
        .update(cx, |view, window, cx| {
            view.toggle_playback(window, cx);
            tracing::info!(playing = view.is_playing(), "teleprompter playback toggled");
            window.refresh();
        })
        .ok();
}

/// The teleprompter closed itself. Nothing to restore: unlike ModeSelect and
/// Settings this window never hid the main one.
pub fn teleprompter_closed(cx: &mut App) {
    cx.global_mut::<AppWindows>().teleprompter.take();
}

/// `apply_content_protection`: `setSharingType: None` while a capture is
/// running, back to `ReadOnly` when it stops. `window_capture_excluded` returns
/// true for the teleprompter's title unconditionally, so this window needs no
/// settings lookup -- but the gating on an active recording is theirs, and the
/// reason is in the comment above `capture_exclusion_hides_ui`: a permanently
/// excluded window is invisible on capture-based displays.
fn set_teleprompter_content_protection(hidden: bool, cx: &mut App) {
    let Some(handle) = cx.global::<AppWindows>().teleprompter else {
        return;
    };
    let native = handle
        .update(cx, |_, window, _| platform::native_window(window))
        .ok()
        .flatten();
    cx.spawn(async move |_| {
        if let Some(native) = &native {
            let sharing = platform::set_window_capture_hidden(native, hidden);
            tracing::info!(hidden, sharing, "teleprompter content protection");
        }
    })
    .detach();
}

/// The teleprompter's native window number, for capture exclusion.
fn teleprompter_window_number(cx: &mut App) -> Option<isize> {
    let handle = cx.global::<AppWindows>().teleprompter?;
    handle
        .update(cx, |_, window, _| platform::window_number(window))
        .ok()
        .flatten()
}

/// What the main window is asking the overlays to show.
#[derive(Clone)]
pub struct OverlayRequest {
    pub mode: TargetType,
    pub recording_mode: Mode,
    /// Restrict the overlays to one display. The Tauri command takes the same
    /// two narrowing inputs (`focused_target`, `specific_display_id`): a
    /// display picked from the main window's dropdown, or the display the
    /// picked window lives on.
    pub display: Option<DisplayId>,
    /// A window picked in the main window: the overlay pins its highlight to
    /// that window instead of following the cursor, the way the Tauri poll
    /// substitutes `focused_target`'s window for `get_topmost_at_cursor`.
    pub pinned_window: Option<scap_targets::WindowId>,
}

/// Everything the overlay needs about a pinned window, resolved once when the
/// overlays open. Cheap enough for the main thread (one window-list walk); the
/// cursor probe does the same work on the background executor because it does
/// it every 80ms.
fn resolve_window(id: &scap_targets::WindowId) -> Option<HoveredWindow> {
    HoveredWindow::from_window(&scap_targets::Window::from_id(id)?)
}

/// Open (or re-target) the fullscreen overlays.
///
/// A mode change tears the old windows down first: the overlay carries
/// per-mode state -- an area selection above all -- and re-opening is both
/// cheaper to reason about and what the Tauri flow does (the webviews are
/// recreated with a new `targetMode` query parameter).
pub fn open_target_overlays(request: OverlayRequest, cx: &mut App) {
    let select = TargetSelect::global(cx);
    let mode_changed = select.read(cx).mode != Some(request.mode);
    if mode_changed {
        close_overlay_windows(cx);
    }

    let pinned = request.pinned_window.as_ref().and_then(resolve_window);
    let display = request
        .display
        .clone()
        .or_else(|| pinned.as_ref().map(|window| window.display_id.clone()));

    select.update(cx, |select, cx| {
        select.arm(Some(request.mode), request.recording_mode, pinned, cx)
    });

    let displays = match &display {
        Some(id) => scap_targets::Display::from_id(id)
            .map(|display| vec![display])
            .unwrap_or_default(),
        None => scap_targets::Display::list(),
    };
    let displays = if displays.is_empty() {
        vec![scap_targets::Display::primary()]
    } else {
        displays
    };
    let wanted: Vec<DisplayId> = displays.iter().map(|display| display.id()).collect();

    // Drop overlays for displays this request no longer covers.
    let stale: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .filter(|(id, _)| !wanted.contains(id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in stale {
        close_overlay(&id, cx);
    }

    let focus_display = scap_targets::Display::get_containing_cursor()
        .map(|display| display.id())
        .filter(|id| wanted.contains(id))
        .or_else(|| wanted.first().cloned());

    for display in displays {
        let id = display.id();
        if cx
            .global::<AppWindows>()
            .overlays
            .iter()
            .any(|(existing, _)| existing == &id)
        {
            continue;
        }
        open_overlay(
            &display,
            select.clone(),
            Some(&id) == focus_display.as_ref(),
            cx,
        );
    }

    // `global_shortcut.register("Escape")` while the overlays are up
    // (`target_select_overlay.rs:595-617`): with the main window hidden below
    // and the overlays non-activating, a plain key handler has nothing to be
    // delivered to.
    platform::register_escape_hotkey();

    // `pickerActive && !hasHidden && !recording` -> `getCurrentWindow().hide()`
    // (`new-main/index.tsx:2024-2028`): the picker owns the screen; the main
    // window would otherwise float above the overlays at level 100.
    if RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        cx.global_mut::<AppWindows>().main_hidden_for_picker = true;
        hide_main_window(cx);
    }
}

/// Close the overlays and clear the main window's armed target -- Escape, the
/// overlay's own close button, or the main window toggling the mode off.
///
/// A "cancelled" dismissal in the Tauri vocabulary, which is the kind that
/// reveals the main window again (`dismissalReveals`,
/// `new-main/index.tsx:2047-2058`).
pub fn dismiss_target_overlays(cx: &mut App) {
    close_target_overlays(cx);
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.clear_target(cx))
        .ok();

    let hidden = std::mem::take(&mut cx.global_mut::<AppWindows>().main_hidden_for_picker);
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    tracing::info!(hidden, idle, "picker dismissed");
    if hidden && idle {
        show_main_window(cx);
    }
}

/// Close the overlays and disarm the cursor probe, leaving the main window's
/// selection alone.
pub fn close_target_overlays(cx: &mut App) {
    close_overlay_windows(cx);
    let select = TargetSelect::global(cx);
    select.update(cx, |select, cx| {
        let recording_mode = select.recording_mode;
        select.arm(None, recording_mode, None, cx);
    });
}

/// Repaint every overlay. The cursor probe runs while none of them is the
/// active window, and an inactive window only repaints when told to.
pub fn refresh_target_overlays(cx: &mut App) {
    let handles: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .map(|(_, handle)| *handle)
        .collect();
    for handle in handles {
        handle
            .update(cx, |_, window, cx| {
                cx.notify();
                window.refresh();
            })
            .ok();
    }
}

/// The overlays' native window numbers, for capture exclusion.
fn overlay_window_ids(cx: &mut App) -> Vec<scap_targets::WindowId> {
    let handles: Vec<_> = cx
        .global::<AppWindows>()
        .overlays
        .iter()
        .map(|(_, handle)| *handle)
        .collect();
    handles
        .into_iter()
        .filter_map(|handle| {
            handle
                .update(cx, |_, window, _| platform::window_number(window))
                .ok()
                .flatten()
        })
        .filter_map(|number| number.to_string().parse().ok())
        .collect()
}

/// The overlay's Start button: overlays down, then the main window's start
/// path with the target the overlay resolved.
pub fn start_recording_from_overlay(target: ScreenCaptureTarget, cx: &mut App) {
    // Collected before the windows go away: the capture starts a beat after
    // this, and an overlay that has not finished closing must not end up in
    // the recording.
    let excluded = overlay_window_ids(cx);
    close_target_overlays(cx);
    // A "recordingStudio" dismissal does not reveal the main window -- the bar
    // owns the foreground now, and the stop flow's reshow brings it back.
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;

    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, window, cx| {
        view.start_recording_with_target(target, excluded, window, cx)
    })
    .ok();
}

/// Seed an area selection on the overlay for a display (harness path -- the
/// real one is a mouse drag, and unprivileged synthetic drags are dropped).
pub fn seed_area_selection(display: Option<DisplayId>, crop: AreaRect, cx: &mut App) -> bool {
    let Some(handle) = overlay_handle(display, cx) else {
        return false;
    };
    handle
        .update(cx, |view, _window, cx| view.set_crop(crop, cx))
        .is_ok()
}

/// Drive an overlay's Start button (harness path).
pub fn start_from_overlay(display: Option<DisplayId>, cx: &mut App) -> bool {
    let Some(handle) = overlay_handle(display, cx) else {
        return false;
    };
    handle
        .update(cx, |view, window, cx| view.start_recording(window, cx))
        .is_ok()
}

fn overlay_handle(display: Option<DisplayId>, cx: &App) -> Option<WindowHandle<OverlayWindow>> {
    let overlays = &cx.global::<AppWindows>().overlays;
    match display {
        Some(id) => overlays
            .iter()
            .find(|(existing, _)| existing == &id)
            .map(|(_, handle)| *handle),
        None => overlays.first().map(|(_, handle)| *handle),
    }
}

fn open_overlay(
    display: &scap_targets::Display,
    select: Entity<TargetSelect>,
    focus: bool,
    cx: &mut App,
) {
    let Some(bounds) = display.raw_handle().logical_bounds() else {
        tracing::error!("display has no logical bounds; overlay not opened");
        return;
    };
    let width = bounds.size().width();
    let height = bounds.size().height();

    let handle = cx.open_window(
        WindowOptions {
            // The origin is corrected right after opening -- gpui's own
            // window-origin math cannot express "cover this display" (see
            // `platform::set_window_frame_cg`). The size is honoured, and it is
            // the size the renderer is built for.
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(0.), px(0.)),
                size: size(px(width as f32), px(height as f32)),
            })),
            titlebar: None,
            // `NSWindowStyleMaskNonActivatingPanel` in windows.rs: the overlay
            // takes clicks without activating the app over the one being
            // recorded.
            kind: WindowKind::PopUp,
            focus: false,
            // Shown once it has been moved onto its display, so it never
            // paints a frame in the wrong place.
            show: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        {
            let display = *display;
            move |window, cx| cx.new(|cx| OverlayWindow::new(&display, select, window, cx))
        },
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>()
                .overlays
                .push((display.id(), handle));
            // Only *read* the native handle while the App is borrowed; the
            // AppKit calls that move, raise and show the panel synchronously
            // re-enter gpui's own window callbacks, so they run from a fresh
            // runloop turn where nothing is borrowed (see
            // `platform::place_overlay_panel`).
            let native = handle
                .update(cx, |_, window, _| platform::native_window(window))
                .ok()
                .flatten();
            let (x, y) = (bounds.position().x(), bounds.position().y());
            cx.spawn(async move |cx| {
                if let Some(native) = &native {
                    platform::place_overlay_panel(
                        native,
                        x,
                        y,
                        width,
                        height,
                        platform::target_overlay_level(),
                    );
                }
                handle
                    .update(cx, |view, window, cx| {
                        // Restart the macOS 26 display link now that the
                        // window is visible (the unit-3 finding).
                        platform::kick_display_link(window);
                        if focus {
                            // Escape is a key handler on the overlay here
                            // rather than the Tauri app's global shortcut, so
                            // one overlay has to hold focus for it to arrive.
                            let focus_handle = view.focus_handle();
                            window.focus(&focus_handle, cx);
                        }
                        window.refresh();
                    })
                    .ok();
            })
            .detach();
        }
        Err(error) => tracing::error!("target select overlay failed to open: {error:#}"),
    }
}

fn close_overlay(id: &DisplayId, cx: &mut App) {
    let overlays = &mut cx.global_mut::<AppWindows>().overlays;
    let Some(index) = overlays.iter().position(|(existing, _)| existing == id) else {
        return;
    };
    let (_, handle) = overlays.remove(index);
    handle
        .update(cx, |_, window, _| window.remove_window())
        .ok();
}

fn close_overlay_windows(cx: &mut App) {
    // The Tauri unregister lives next to the close for the same reason: a
    // global Escape may only be swallowed while a picker is actually up.
    platform::unregister_escape_hotkey();
    let overlays = std::mem::take(&mut cx.global_mut::<AppWindows>().overlays);
    for (_, handle) in overlays {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// The whole start flow: bar up (in its Starting state), main window hidden,
/// engine started with the bar excluded from capture.
pub fn begin_recording(config: StartConfig, cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase != Phase::Idle {
        return;
    }

    let mut excluded: Vec<scap_targets::WindowId> = config.excluded_windows.clone();
    excluded.extend(open_controls(&config, session.clone(), cx));
    // The camera bubble is excluded from studio captures (the camera is its own
    // track, composited in the editor) but *included* in instant captures --
    // `filter_for_instant_mode` in the Tauri app strips the camera exclusion
    // there because instant has no compositing step.
    if config.mode == RecordingMode::Studio
        && let Some(number) = camera_window_number(cx)
        && let Ok(id) = number.to_string().parse()
    {
        excluded.push(id);
    }
    // `recording.rs:1897-1904` adds a `teleprompter_exclusion` to every active
    // recording, in both modes -- the script is for the presenter, never for
    // the audience. The window number is the exclusion; the content protection
    // below is the second half, for captures that are not ours.
    if let Some(number) = teleprompter_window_number(cx)
        && let Ok(id) = number.to_string().parse()
    {
        tracing::info!(number, "excluding the teleprompter window from the capture");
        excluded.push(id);
    }
    set_teleprompter_content_protection(true, cx);

    let bar_open = cx.global::<AppWindows>().controls.is_some();
    session.update(cx, |session, cx| {
        session.set_controls_open(bar_open, cx);
    });
    if bar_open {
        hide_main_window(cx);
    }

    let config = StartConfig {
        excluded_windows: excluded,
        ..config
    };
    session.update(cx, |session, cx| session.start(config, cx));
}

/// Open the camera preview bubble (idempotent). Placement mirrors the Tauri
/// default: bottom-right of the main window's display, 100px in from the
/// corner. Position is not persisted yet (deviation; the Tauri app remembers it
/// per monitor).
pub fn open_camera_window(cx: &mut App) {
    if cx.global::<AppWindows>().camera.is_some() {
        return;
    }

    let state = crate::store::load().camera_window.unwrap_or_default();
    let (width, height) = camera_window::window_size(&state, None);

    let display = scap_targets::Display::get_containing_cursor()
        .unwrap_or_else(scap_targets::Display::primary);
    let (x, y) = match display.raw_handle().logical_bounds() {
        Some(bounds) => (
            (bounds.position().x() + bounds.size().width() - width as f64 - 100.) as f32,
            (bounds.position().y() + bounds.size().height() - height as f64 - 100.) as f32,
        ),
        None => (100., 100.),
    };

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(x), px(y)),
                size: size(px(width), px(height)),
            })),
            titlebar: None,
            // Non-activating panel, same as the bar: the bubble is clickable
            // without stealing focus from what is being recorded.
            kind: WindowKind::PopUp,
            focus: false,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| CameraWindow::new(window, cx)),
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>().camera = Some(handle);
            handle
                .update(cx, |_, window, _| {
                    platform::apply_panel_behavior(
                        window,
                        platform::PanelBehavior {
                            // `set_level(max_level)` in windows.rs -- the same
                            // `CGWindowLevelForKey(10)` the bar uses.
                            level: platform::recording_controls_level(),
                            join_all_spaces: true,
                            // `.shadow(false)` in the Tauri builder; the shape
                            // container draws its own look.
                            shadow: false,
                        },
                    );
                    platform::show_window_without_focus(window);
                })
                .ok();
        }
        Err(error) => tracing::error!("camera window failed to open: {error:#}"),
    }
}

pub fn close_camera_window(cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().camera.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

/// Hand a camera frame to the preview window. Returns false when no window is
/// open (the pump drops the frame and keeps draining).
pub fn deliver_camera_frame(frame: cap_recording::NativeCameraFrame, cx: &mut App) -> bool {
    let Some(handle) = cx.global::<AppWindows>().camera else {
        return false;
    };
    handle
        .update(cx, |view, window, cx| view.frame_arrived(frame, window, cx))
        .is_ok()
}

// -- Editor -----------------------------------------------------------------

/// The canonical form of a `.cap` path, so the same bundle reached by two
/// spellings is one window. `EditorWindowIds` compares `PathBuf`s directly;
/// canonicalising is strictly the safer version of the same rule.
fn editor_key(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// Open (or focus) the editor for a `.cap` bundle.
///
/// `ShowCapWindow::Editor` looks the path up in `EditorWindowIds` and reuses
/// the window it finds (`windows.rs:1164-1181`), so opening the same project
/// twice focuses the first one. It also calls `hide_recording_windows(app,
/// false)` first (`windows.rs:1930`), which hides Main among others, and
/// `openRecording` in the frontend hides the main window again explicitly
/// (`new-main/index.tsx:2925`) -- so the main window going away is both halves
/// of the shipping behaviour, not an invention here.
///
/// Must be reached through `cx.defer` from anything inside an entity update:
/// opening a window paints it synchronously and would double-lease the caller.
pub fn open_editor(project_path: PathBuf, cx: &mut App) {
    let key = editor_key(&project_path);

    if let Some(handle) = cx
        .global::<AppWindows>()
        .editors
        .iter()
        .find(|(path, _)| path == &key)
        .map(|(_, handle)| *handle)
    {
        tracing::info!(
            path = %key.display(),
            "editor already open for this project; focusing it"
        );
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    // `cursor_monitor.center_position(1275.0, 800.0)` in the Tauri arm; gpui
    // centres on the active display, which is the same one in every
    // single-pointer case.
    let bounds = Bounds::centered(
        None,
        size(
            px(editor_window::EDITOR_WIDTH),
            px(editor_window::EDITOR_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // Native traffic lights, inset to (20, 32):
            // `CapWindowId::Editor::traffic_lights_position` is
            // `Some(Some(LogicalPosition::new(20.0, 32.0)))`, and the header's
            // left group reserves an `h-full w-16` spacer for them.
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Editor".into()),
                appears_transparent: true,
                traffic_light_position: editor_window::TRAFFIC_LIGHTS,
            }),
            // An ordinary window that activates the dock icon
            // (`activates_dock()` lists Editor); no level or Spaces treatment.
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            // `.maximizable(true)` with `min_inner_size == inner_size`.
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(editor_window::EDITOR_WIDTH),
                px(editor_window::EDITOR_HEIGHT),
            )),
            // Opaque, and no native material: `is_transparent()`
            // (`windows.rs:1069-1082`) does not list Editor, and
            // `applyMacOSWindowMaterial` runs only in the `(window-chrome)`
            // layout -- `/editor` is a sibling route, not one of its children.
            ..Default::default()
        },
        {
            let key = key.clone();
            move |window, cx| cx.new(|cx| EditorWindow::new(key, window, cx))
        },
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("editor window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>()
        .editors
        .push((key.clone(), handle));

    handle
        .update(cx, |view, window, cx| {
            platform::kick_display_link(window);
            view.focus_root(window, cx);
            tracing::info!(
                number = platform::window_number(window),
                path = %key.display(),
                "editor window opened"
            );
        })
        .ok();

    hide_main_window(cx);
    load_editor_project(key, handle, cx);
}

/// Build the `EditorInstance` and get frame 0 on screen.
///
/// Everything expensive is off the UI thread: the pre-flight validation runs
/// on gpui's background executor, and the instance -- decoders, renderer,
/// preview renderer, all of which are tokio-spawned -- is constructed on the
/// `gpui_tokio` runtime. `EditorInstance::new` on the main thread would block
/// it for however long the first segment takes to open.
fn load_editor_project(path: PathBuf, handle: WindowHandle<EditorWindow>, cx: &mut App) {
    cx.spawn(async move |cx| {
        let preflight_path = path.clone();
        let summary = cx
            .background_executor()
            .spawn(async move { editor_window::preflight(&preflight_path) })
            .await;

        let summary = match summary {
            Ok(summary) => summary,
            Err(message) => {
                handle
                    .update(cx, |view, window, cx| view.set_error(message, window, cx))
                    .ok();
                return;
            }
        };
        tracing::info!(
            path = %path.display(),
            clips = summary.timeline.clips.len(),
            duration = format!("{:.3}", summary.duration),
            camera = summary.has_camera,
            cursor = summary.has_cursor_data,
            "editor project validated"
        );
        log_timeline_model(&summary.timeline);
        if handle
            .update(cx, |view, window, cx| view.set_summary(summary, window, cx))
            .is_err()
        {
            return;
        }

        // The frame seam. Bounded and try_send-only: the renderer is already
        // latest-wins (`editor.rs:242-312`), so a full queue means the UI is
        // behind and the newest frame is the one that matters.
        let (frame_tx, frame_rx) = flume::bounded(2);
        let stats = Arc::new(editor_window::PumpStats::default());
        // The playhead seam. `on_state_change` is called from the
        // `cap-playback` OS thread and from tokio workers, so it may only
        // store and poke; the drain below is what touches the entity.
        let (playhead, playhead_rx) = editor_window::PlayheadSignal::new();
        let instance_path = path.clone();
        let task = cx.update(|cx| {
            let frame_stats = stats.clone();
            let playhead = playhead.clone();
            gpui_tokio::Tokio::spawn(cx, async move {
                // `EditorInstance::new`: the real constructor, exactly as the
                // Tauri app calls it (`lib.rs:6592`) -- except under
                // `CAP_GPUI_MUTE_AUDIO=1`, which swaps in the headless audio
                // output (the integration test's constructor) so playback
                // stays silent: verification probes must be able to run while
                // the user is on a call, and the editor otherwise plays the
                // recording's audio through the default output the moment
                // Play is pressed (the stream prewarms at load,
                // `editor_instance.rs:305`). The video pump is identical on
                // both paths.
                //
                // `shared_device: None`: gpui on macOS is Metal-direct and
                // exposes no wgpu device to share, so cap-rendering owns its
                // own. Two GPU contexts in-process is the shape the Tauri app
                // already has.
                let state_cb = editor_window::make_state_callback(playhead);
                let frame_cb = editor_window::make_frame_callback(frame_tx, frame_stats);
                #[cfg(target_os = "macos")]
                let frame_format = cap_editor::EditorFrameFormat::BgraSurface;
                #[cfg(not(target_os = "macos"))]
                let frame_format = cap_editor::EditorFrameFormat::Rgba;
                if std::env::var("CAP_GPUI_MUTE_AUDIO").is_ok_and(|v| v == "1") {
                    let silent = std::sync::Arc::new(cap_editor::AudioOutput::new_headless(
                        Box::new(|_samples, _at| {}),
                    ));
                    cap_editor::EditorInstance::new_with_audio_output_and_frame_format(
                        instance_path,
                        state_cb,
                        frame_cb,
                        None,
                        frame_format,
                        silent,
                    )
                    .await
                } else {
                    cap_editor::EditorInstance::new_with_frame_format(
                        instance_path,
                        state_cb,
                        frame_cb,
                        None,
                        frame_format,
                    )
                    .await
                }
            })
        });

        let instance = match task.await {
            Ok(Ok(instance)) => instance,
            Ok(Err(error)) => {
                handle
                    .update(cx, |view, window, cx| view.set_error(error, window, cx))
                    .ok();
                return;
            }
            Err(join_error) => {
                handle
                    .update(cx, |view, window, cx| {
                        view.set_error(
                            format!("Opening this recording failed: {join_error}"),
                            window,
                            cx,
                        )
                    })
                    .ok();
                return;
            }
        };

        tracing::info!(path = %path.display(), "editor instance ready");
        if handle
            .update(cx, |view, _window, _cx| view.set_instance(instance.clone()))
            .is_err()
        {
            instance.dispose().await;
            return;
        }

        // The pump: convert on the background executor (un-padding plus the
        // BGRA swap is a few megabytes per frame), deliver on the main one.
        cx.spawn({
            let stats = stats.clone();
            async move |cx| {
                while let Ok((output, layout)) = frame_rx.recv_async().await {
                    let (frame, number) = match output {
                        cap_editor::EditorFrameOutput::Rgba(rgba) => {
                            let stats = stats.clone();
                            let number = rgba.frame_number;
                            let image = cx
                                .background_executor()
                                .spawn(
                                    async move { editor_window::frame_image_timed(&rgba, &stats) },
                                )
                                .await;
                            let Some(image) = image else {
                                tracing::warn!(
                                    "a rendered frame could not be converted for display"
                                );
                                continue;
                            };
                            (editor_window::EditorPreviewFrame::Image(image), number)
                        }
                        cap_editor::EditorFrameOutput::Nv12(frame) => {
                            tracing::warn!(
                                number = frame.frame_number,
                                "buffer-backed NV12 preview is unsupported"
                            );
                            continue;
                        }
                        #[cfg(target_os = "macos")]
                        cap_editor::EditorFrameOutput::Surface(surface) => {
                            let number = surface.frame_number;
                            (editor_window::surface_preview_frame(surface), number)
                        }
                    };
                    if handle
                        .update(cx, |view, window, cx| {
                            view.frame_arrived(
                                editor_window::EditorFrame {
                                    frame,
                                    layout,
                                    number,
                                },
                                window,
                                cx,
                            )
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            }
        })
        .detach();

        // The playhead drain. The signal is latest-wins, so this reads the
        // atomic rather than a queue: at 60Hz a backlog would only ever
        // describe the past.
        cx.spawn(async move |cx| {
            while playhead_rx.recv_async().await.is_ok() {
                let frame = playhead.position();
                if handle
                    .update(cx, |view, window, cx| {
                        view.playhead_changed(frame, window, cx)
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
        .detach();

        // The transport driver: one task, applying the window's desired
        // transport state to the instance. Everything it calls locks
        // `instance.state`, so none of it may run on the UI thread.
        let (transport, driver) = editor_window::transport();
        let driver_instance = instance.clone();
        cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                editor_window::run_transport(driver_instance, driver).await;
            })
            .detach();
        });

        // `totalDuration()` (`context.ts:1374-1380`). Read off the instance
        // rather than the pre-flight, because `EditorInstance::new`
        // synthesises a timeline for a raw bundle -- and `timeline.duration()`
        // is exactly what the playback engine stops at
        // (`playback.rs:560-570`).
        //
        // The whole track model comes from the same read: the config the
        // instance actually loaded is the one being rendered, holds, clip
        // offsets and all. E4 hands the window the config itself rather than
        // the derived model, because it is what every edit mutates and what
        // the debounced save writes back.
        let (total, config) = {
            let config = instance.project_config.1.borrow().clone();
            let total = config
                .timeline
                .as_ref()
                .map_or(0.0, |timeline| timeline.duration());
            (total, config)
        };
        {
            let has_camera = instance
                .recordings
                .segments
                .iter()
                .any(|segment| segment.camera.is_some());
            let multiple_clips = instance.recordings.segments.len() > 1;
            log_timeline_model(&editor_timeline::TimelineModel::build(
                &config,
                has_camera,
                multiple_clips,
            ));
        }
        if handle
            .update(cx, |view, window, cx| view.set_project(config, window, cx))
            .is_err()
        {
            return;
        }
        load_editor_waveforms(instance.clone(), handle, cx);

        if handle
            .update(cx, |view, window, cx| {
                view.set_transport(transport, stats, total, window, cx)
            })
            .is_err()
        {
            return;
        }

        // The initial kick, exactly as `lib.rs:6617-6618` does it after
        // creating an instance. Without this the canvas stays black: `seek_to`
        // and `set_playhead_position` render nothing.
        editor_window::request_frame(
            &instance,
            0,
            editor_window::preview_resolution(
                crate::store::GeneralSettings::load().editor_preview_quality,
            ),
        );

        drive_auto_sidebar(handle, cx).await;
        drive_auto_playback(path, handle, cx).await;
    })
    .detach();
}

/// One line per timeline load naming every row and its segment count. The
/// track set is derived from the project's own content, so this is how a
/// fixture is checked to have actually deserialised rather than falling back
/// to the default config.
fn log_timeline_model(model: &editor_timeline::TimelineModel) {
    tracing::info!(
        rows = model.rows.len(),
        track_height = model.track_height(),
        total = format!("{:.3}", model.total_duration),
        clip = model.clips.len(),
        zoom = model.zoom.len(),
        scene = model.scene.len(),
        three_d = model.three_d.len(),
        text = model.text.len(),
        mask = model.mask.len(),
        audio = model.audio.len(),
        caption = model.caption.len(),
        keyboard = model.keyboard.len(),
        "editor timeline model"
    );
}

/// The clip track's waveforms (`get_mic_waveforms` / `get_system_audio_waveforms`,
/// `apps/desktop/src-tauri/src/lib.rs:4392-4434`).
///
/// Deliberately fire-and-forget, exactly as the frontend's own
/// `commands.getMicWaveforms().then(setMicWaveforms)` is
/// (`ED/context.ts:1526-1539`): the decode runs in the background after the
/// editor opens and may resolve well after the first frame, so nothing waits on
/// it and a failed track simply renders as an empty waveform. `AudioLoader::get`
/// awaits a tokio watch channel, so it runs on the tokio runtime; the peak
/// extraction itself is a per-sample loop over a whole track, which goes to the
/// background executor rather than the UI thread.
fn load_editor_waveforms(
    instance: Arc<cap_editor::EditorInstance>,
    handle: WindowHandle<EditorWindow>,
    cx: &mut gpui::AsyncApp,
) {
    cx.spawn(async move |cx| {
        let task = cx.update(|cx| {
            gpui_tokio::Tokio::spawn(cx, async move {
                let mut mic = Vec::with_capacity(instance.segment_medias.len());
                let mut system = Vec::with_capacity(instance.segment_medias.len());
                for segment in instance.segment_medias.iter() {
                    for (loader, out) in [
                        (&segment.audio, &mut mic),
                        (&segment.system_audio, &mut system),
                    ] {
                        match loader.get().await {
                            Ok(Some(audio)) => {
                                out.push((audio.samples().to_vec(), audio.channels()))
                            }
                            // A failed track is an empty waveform; playback and
                            // export surface the actual error.
                            _ => out.push((Vec::new(), 1)),
                        }
                    }
                }
                (mic, system)
            })
        });
        let Ok((mic, system)) = task.await else {
            return;
        };
        let peaks = cx
            .background_executor()
            .spawn(async move {
                let extract = |tracks: Vec<(Vec<f32>, u16)>| {
                    tracks
                        .into_iter()
                        .map(|(samples, channels)| {
                            Arc::new(editor_timeline::waveform_peaks(&samples, channels))
                        })
                        .collect::<Vec<_>>()
                };
                (extract(mic), extract(system))
            })
            .await;
        let _ = handle.update(cx, |view, window, cx| {
            tracing::info!(
                mic = peaks.0.iter().filter(|peaks| !peaks.is_empty()).count(),
                system = peaks.1.iter().filter(|peaks| !peaks.is_empty()).count(),
                "editor waveforms ready"
            );
            view.set_waveforms(peaks.0, peaks.1, window, cx)
        });
    })
    .detach();
}

/// `CAP_GPUI_AUTO_SIDEBAR=<tab>[:<scroll>]` selects a config-sidebar tab and
/// optionally scrolls its body, and `CAP_GPUI_AUTO_SELECT=<track>:<i>[,<i>]`
/// selects timeline segments so their panel opens.
///
/// They exist for the same reason as every other `CAP_GPUI_AUTO_*` hook, plus
/// one specific to this pane: **a synthetic wheel does not scroll the sidebar's
/// body.** A `CGEvent` scroll delivered over the sidebar reaches the app (the
/// timeline's own wheel handler logs one when the pointer is over the strip)
/// but moves nothing when it lands on the scroll body, so a tab taller than
/// 470px cannot be photographed below the fold without this.
async fn drive_auto_sidebar(handle: WindowHandle<EditorWindow>, cx: &mut gpui::AsyncApp) {
    let tab = std::env::var("CAP_GPUI_AUTO_SIDEBAR").ok();
    let select = std::env::var("CAP_GPUI_AUTO_SELECT").ok();
    let canvas = std::env::var("CAP_GPUI_AUTO_CANVAS").ok();
    let crop = std::env::var("CAP_GPUI_AUTO_CROP").ok();
    if tab.is_none() && select.is_none() && canvas.is_none() && crop.is_none() {
        return;
    }
    cx.background_executor()
        .timer(std::time::Duration::from_millis(1200))
        .await;

    if let Some(spec) = tab {
        let (name, scroll) = match spec.split_once(':') {
            Some((name, scroll)) => (name.to_string(), scroll.parse::<f32>().ok()),
            None => (spec, None),
        };
        handle
            .update(cx, |view, window, cx| {
                view.auto_select_sidebar_tab(&name, scroll, window, cx)
            })
            .ok();
    }

    if let Some(spec) = select {
        handle
            .update(cx, |view, _window, cx| view.auto_select_segments(&spec, cx))
            .ok();
    }

    // `CAP_GPUI_AUTO_CANVAS=1`: select the on-canvas display box, which a
    // click on it does. Before the crop hook, because opening the crop dialog
    // hides the overlay.
    if std::env::var("CAP_GPUI_AUTO_CANVAS").is_ok_and(|value| value == "1") {
        handle
            .update(cx, |view, window, cx| view.auto_canvas_select(window, cx))
            .ok();
    }

    // `CAP_GPUI_AUTO_CROP=1[:16x9][:nosnap]`: open the crop dialog through the
    // toolbar's own handler.
    if let Ok(spec) = std::env::var("CAP_GPUI_AUTO_CROP")
        && !spec.is_empty()
    {
        handle
            .update(cx, |view, window, cx| view.auto_crop(&spec, window, cx))
            .ok();
    }
}

/// `CAP_GPUI_AUTO_PLAYBACK=<seconds>` presses play once the project is up and
/// pauses N seconds later; `CAP_GPUI_AUTO_PLAYBACK_TORTURE=<cycles>` runs
/// play/pause/seek cycles instead. Both exist for the same reason as every
/// other `CAP_GPUI_AUTO_*` hook: unprivileged synthetic clicks are dropped, so
/// a verification run needs a way to press the button.
async fn drive_auto_playback(
    project_path: PathBuf,
    handle: WindowHandle<EditorWindow>,
    cx: &mut gpui::AsyncApp,
) {
    let play_secs = std::env::var("CAP_GPUI_AUTO_PLAYBACK")
        .ok()
        .and_then(|value| value.parse::<f64>().ok());
    let torture = std::env::var("CAP_GPUI_AUTO_PLAYBACK_TORTURE")
        .ok()
        .and_then(|value| value.parse::<u32>().ok());
    // `CAP_GPUI_AUTO_SEEK=0.6`: a paused seek to 60% along the timeline, the
    // way a click on the ruler there does it.
    let seek = std::env::var("CAP_GPUI_AUTO_SEEK")
        .ok()
        .and_then(|value| value.parse::<f64>().ok());
    if play_secs.is_none() && torture.is_none() && seek.is_none() {
        return;
    }

    let sleep = |cx: &gpui::AsyncApp, millis: u64| {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(millis))
    };
    // Let the first frame land and the decoders warm before the stopwatch
    // starts, the way a human would.
    sleep(cx, 1500).await;

    if let Some(cycles) = torture {
        tracing::info!(cycles, "auto playback torture: start");
        for cycle in 0..cycles {
            if handle
                .update(cx, |view, window, cx| view.toggle_play(window, cx))
                .is_err()
            {
                return;
            }
            sleep(cx, 320).await;
            if handle
                .update(cx, |view, window, cx| view.toggle_play(window, cx))
                .is_err()
            {
                return;
            }
            sleep(cx, 80).await;
            // A deterministic walk over the timeline rather than a random one,
            // so a failure is reproducible.
            let fraction = (cycle % 7) as f64 / 7.0;
            if handle
                .update(cx, |view, window, cx| {
                    view.seek_fraction(fraction, window, cx)
                })
                .is_err()
            {
                return;
            }
            sleep(cx, 120).await;
            tracing::info!(cycle = cycle + 1, "auto playback torture: cycle done");
        }
        tracing::info!(cycles, "auto playback torture: complete");
    }

    if let Some(fraction) = seek {
        handle
            .update(cx, |view, window, cx| {
                view.seek_fraction(fraction, window, cx)
            })
            .ok();
        tracing::info!(fraction, "auto seek");
    }

    // `CAP_GPUI_AUTO_EDITOR_CLOSE=<secs>`: close the editor that many seconds
    // into playback, through `performClose:` -- the traffic light's own path,
    // so the window's `on_window_should_close` handler and `editor_closed`
    // both run. Proof that a playing editor tears down cleanly.
    // Once only: the reopened editor runs the same code with the same
    // environment, and a second close would be an infinite loop rather than a
    // test.
    static CLOSE_SCENARIO_DONE: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);
    let close_after = std::env::var("CAP_GPUI_AUTO_EDITOR_CLOSE")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|_| !CLOSE_SCENARIO_DONE.swap(true, std::sync::atomic::Ordering::SeqCst));

    if let Some(secs) = play_secs {
        cx.update(|cx| cx.activate(true));
        if handle
            .update(cx, |_, window, _| window.activate_window())
            .is_err()
        {
            return;
        }
        sleep(cx, 200).await;
        if handle
            .update(cx, |view, window, cx| {
                tracing::info!(active = window.is_window_active(), "auto playback focus");
                view.toggle_play(window, cx)
            })
            .is_err()
        {
            return;
        }
        tracing::info!(secs, "auto playback: playing");
        if let Some(close_after) = close_after {
            sleep(cx, (close_after * 1000.0) as u64).await;
            let native = handle
                .update(cx, |_, window, _| platform::native_window(window))
                .ok()
                .flatten();
            tracing::info!(
                close_after,
                "auto playback: closing the editor mid-playback"
            );
            if let Some(native) = &native {
                platform::close_native(native);
            }
            // ...and open it again, to prove the teardown left nothing
            // behind. The second window takes the ordinary path: its own
            // instance, its own pump, its own transport.
            sleep(cx, 2000).await;
            tracing::info!("auto playback: reopening the editor");
            cx.update(|cx| open_editor(project_path, cx));
            return;
        }
        sleep(cx, (secs * 1000.0) as u64).await;
        handle
            .update(cx, |view, _window, cx| view.stop_for_measurement(cx))
            .ok();
    }
}

/// An editor window is going away. `CapWindowId::Editor`'s `Destroyed` arm
/// drops it from `EditorWindowIds`, disposes the instance, and calls
/// `restore_main_windows_if_no_editors` (`lib.rs:5777-5792`) -- so the main
/// window comes back only once the last editor has closed.
pub fn editor_closed(project_path: &Path, cx: &mut App) {
    let key = editor_key(project_path);
    let handle = {
        let editors = &mut cx.global_mut::<AppWindows>().editors;
        let index = editors.iter().position(|(path, _)| path == &key);
        index.map(|index| editors.remove(index).1)
    };

    if let Some(handle) = handle {
        // `onCleanup(() => { clearTimeout(saveTimer); flushProjectConfig() })`
        // (`ED/context.ts:1246-1252`): a `.cap` closed inside the 250ms save
        // debounce still gets its last edit written.
        if let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save()) {
            pending.borrow_mut().flush();
        }
        let instance = handle
            .update(cx, |view, _window, _cx| view.take_instance())
            .ok()
            .flatten();
        if let Some(instance) = instance {
            gpui_tokio::Tokio::spawn(cx, async move { instance.dispose().await }).detach();
        }
    }

    let windows = cx.global::<AppWindows>();
    let editors_left = windows.editors.len() + windows.screenshot_editors.len();
    tracing::info!(
        path = %key.display(),
        editors_left,
        "editor window closed"
    );
    if editors_left == 0 && RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        show_main_window(cx);
    } else {
        // A dock-activating window closed; the policy has to be recomputed
        // even when the main window is not the thing coming back.
        crate::menus::schedule_dock_sync(cx);
    }
}

/// `addExistingRecordingToEditor` ends with `EditorInstances::remove(window)`
/// and the sidebar reloads the webview (`ClipsSidebar.tsx:513-517`,
/// `import.rs:1892`): the same bundle, re-read from disk. The native
/// spelling: tear this editor window down -- discarding its pending config
/// write, which is older than what the import just wrote -- and open a fresh
/// one on the same path. The registry entry goes first so `open_editor` does
/// not just refocus the dying window, and the main window never flashes in
/// between.
pub fn reload_editor(project_path: &Path, cx: &mut App) {
    let key = editor_key(project_path);
    let handle = {
        let editors = &mut cx.global_mut::<AppWindows>().editors;
        let index = editors.iter().position(|(path, _)| path == &key);
        index.map(|index| editors.remove(index).1)
    };

    if let Some(handle) = handle {
        if let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save()) {
            pending.borrow_mut().discard();
        }
        let instance = handle
            .update(cx, |view, _window, _cx| view.take_instance())
            .ok()
            .flatten();
        if let Some(instance) = instance {
            gpui_tokio::Tokio::spawn(cx, async move { instance.dispose().await }).detach();
        }
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }

    tracing::info!(path = %key.display(), "reloading editor after import");
    open_editor(key, cx);
}

/// The tray's Record Display / Record Window / Record Area.
///
/// `crate::open_target_picker(&app, RecordingTargetMode::*)` over there, which
/// sets the target mode on the main window and opens the overlays; here the
/// main window owns that state, so it is the same `arm_overlay` the tiles call.
pub fn arm_target_mode(kind: crate::main_window::TargetType, cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, _window, cx| view.arm_overlay(kind, cx))
        .ok();
}

/// Repaint the bar between its own 250ms ticks -- the mic meter updates at
/// ~20Hz and the bar is never the active window.
pub fn refresh_controls_window(cx: &mut App) {
    if let Some(handle) = cx.global::<AppWindows>().controls {
        handle
            .update(cx, |_, window, cx| {
                cx.notify();
                window.refresh();
            })
            .ok();
    }
}

fn camera_window_number(cx: &mut App) -> Option<isize> {
    let handle = cx.global::<AppWindows>().camera?;
    handle
        .update(cx, |_, window, _| platform::window_number(window))
        .ok()
        .flatten()
}

/// Where the bar goes, from `fake_window.rs`: centered under a window target
/// (48px up from its bottom edge), bottom-center of the recorded display
/// otherwise (120px up).
fn controls_origin(config: &StartConfig) -> (f64, f64) {
    use cap_recording::sources::screen_capture::ScreenCaptureTarget;

    let width = CONTROLS_WIDTH as f64;
    let height = CONTROLS_HEIGHT as f64;

    if let ScreenCaptureTarget::Window { id } = &config.target
        && let Some(window) = scap_targets::Window::from_id(id)
        && let Some(bounds) = window.raw_handle().logical_bounds()
    {
        let x = bounds.position().x() + (bounds.size().width() - width) / 2.;
        let y = bounds.position().y() + bounds.size().height() - height - TARGET_CONTROLS_OFFSET_Y;
        return (x, y);
    }

    let display = match &config.target {
        ScreenCaptureTarget::Display { id } => scap_targets::Display::from_id(id),
        _ => scap_targets::Display::get_containing_cursor(),
    }
    .unwrap_or_else(scap_targets::Display::primary);

    match display.raw_handle().logical_bounds() {
        Some(bounds) => (
            bounds.position().x() + (bounds.size().width() - width) / 2.,
            bounds.position().y() + bounds.size().height() - height - CONTROLS_BOTTOM_OFFSET,
        ),
        None => (0., 0.),
    }
}

/// Open the bar. Returns the native window number for capture exclusion.
fn open_controls(
    config: &StartConfig,
    session: Entity<RecordingSession>,
    cx: &mut App,
) -> Option<scap_targets::WindowId> {
    let (x, y) = controls_origin(config);
    let has_microphone = config.microphone.is_some();

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(x as f32), px(y as f32)),
                size: size(px(CONTROLS_WIDTH), px(CONTROLS_HEIGHT)),
            })),
            // No titlebar at all: with one, the panel still draws standard
            // window buttons floating in the transparent top of the window.
            titlebar: None,
            // Non-activating panel: clickable without pulling focus from the
            // app being recorded -- the tauri_nspanel behavior.
            kind: WindowKind::PopUp,
            focus: false,
            show: true,
            is_resizable: false,
            is_minimizable: false,
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        |window, cx| cx.new(|cx| ControlsWindow::new(session, has_microphone, window, cx)),
    );

    match handle {
        Ok(handle) => {
            cx.global_mut::<AppWindows>().controls = Some(handle);
            // Panel treatment AFTER open_window returns: inside the builder
            // closure the platform window is not finished and gpui's own
            // PopUp setup would override the level.
            let number = handle
                .update(cx, |_, window, _| {
                    platform::apply_panel_behavior(
                        window,
                        platform::PanelBehavior {
                            level: platform::recording_controls_level(),
                            join_all_spaces: true,
                            // `.shadow(false)` in the Tauri builder: the bar
                            // draws its own shadow-free card.
                            shadow: false,
                        },
                    );
                    // `order_front_regardless` in the Tauri flow: front without
                    // taking key status from the app being recorded.
                    platform::show_window_without_focus(window);
                    platform::window_number(window)
                })
                .ok()
                .flatten()?;
            number.to_string().parse().ok()
        }
        Err(error) => {
            tracing::error!("recording controls window failed to open: {error:#}");
            None
        }
    }
}

/// Hide the pickers before a screenshot grab, the way `take_screenshot` hides
/// TargetSelectOverlay / CaptureArea / ModeSelect (`recording.rs:2876-2895`):
/// an overlay still on screen would be in the shot. Returns whether anything
/// was up -- the caller's cue to wait the same 150ms the Tauri command waits.
pub fn prepare_for_screenshot_capture(cx: &mut App) -> bool {
    if cx.global::<AppWindows>().overlays.is_empty() {
        return false;
    }
    close_target_overlays(cx);
    true
}

/// A screenshot finished (`Some` PNG path) or failed (`None`): refresh every
/// surface that lists screenshots -- the `NewScreenshotAdded` listeners in
/// the Tauri app -- and open the screenshot editor on the new bundle, the
/// `automationShouldOpenScreenshotEditor` default. A failure reveals the main
/// window if the picker had hidden it, since nothing else will.
pub fn screenshot_finished(captured: Option<PathBuf>, cx: &mut App) {
    let Some(png) = captured else {
        let hidden = std::mem::take(&mut cx.global_mut::<AppWindows>().main_hidden_for_picker);
        if hidden && RecordingSession::global(cx).read(cx).phase == Phase::Idle {
            show_main_window(cx);
        }
        return;
    };

    crate::tray::refresh_previous(cx);
    if let Some(settings) = cx.global::<AppWindows>().settings {
        settings
            .update(cx, |view, window, cx| view.refresh_screenshots(window, cx))
            .ok();
    }
    let main = cx.global::<AppWindows>().main;
    main.update(cx, |view, window, cx| view.refresh_recents(window, cx))
        .ok();

    // The editor owns the foreground now, the way a stopped studio recording
    // hands off to the video editor; `screenshot_editor_closed` brings the
    // main window back.
    cx.global_mut::<AppWindows>().main_hidden_for_picker = false;
    open_screenshot_editor(png, cx);
}

/// Open (or focus) the screenshot editor for a bundle -- the
/// `ShowCapWindow::ScreenshotEditor` arm: 1240x800, min 800x600, centered,
/// reused per path. Accepts the PNG or the `.cap` directory.
///
/// Must be reached through `cx.defer` from anything inside an entity update:
/// opening a window paints it synchronously and would double-lease the caller.
pub fn open_screenshot_editor(path: PathBuf, cx: &mut App) {
    let Some(bundle) = screenshot_editor::resolve_bundle(&path) else {
        tracing::error!(path = %path.display(), "not a screenshot bundle; not opening the editor");
        return;
    };
    let key = editor_key(&bundle);

    if let Some(handle) = cx
        .global::<AppWindows>()
        .screenshot_editors
        .iter()
        .find(|(existing, _)| existing == &key)
        .map(|(_, handle)| *handle)
    {
        tracing::info!(
            path = %key.display(),
            "screenshot editor already open for this bundle; focusing it"
        );
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::show_native(native);
            }
        })
        .detach();
        hide_main_window(cx);
        return;
    }

    let bounds = Bounds::centered(
        None,
        size(
            px(screenshot_editor::SCREENSHOT_EDITOR_WIDTH),
            px(screenshot_editor::SCREENSHOT_EDITOR_HEIGHT),
        ),
        cx,
    );

    let handle = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some("Cap Screenshot Editor".into()),
                appears_transparent: true,
                traffic_light_position: None,
            }),
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(
                px(screenshot_editor::SCREENSHOT_EDITOR_MIN_WIDTH),
                px(screenshot_editor::SCREENSHOT_EDITOR_MIN_HEIGHT),
            )),
            ..Default::default()
        },
        {
            let key = key.clone();
            move |window, cx| cx.new(|cx| ScreenshotEditorWindow::new(key, window, cx))
        },
    );

    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("screenshot editor window failed to open: {error:#}");
            return;
        }
    };

    cx.global_mut::<AppWindows>()
        .screenshot_editors
        .push((key.clone(), handle));
    handle
        .update(cx, |_, window, _| {
            platform::kick_display_link(window);
            tracing::info!(
                number = platform::window_number(window),
                path = %key.display(),
                "screenshot editor window opened"
            );
        })
        .ok();

    hide_main_window(cx);
    screenshot_editor::load_screenshot_project(key, handle, cx);
}

/// A screenshot editor window is going away: flush its pending config write
/// and bring the main window back once the last editor of either kind closes
/// -- the same `Destroyed` arm `editor_closed` mirrors.
pub fn screenshot_editor_closed(bundle: &Path, cx: &mut App) {
    let key = editor_key(bundle);
    let handle = {
        let editors = &mut cx.global_mut::<AppWindows>().screenshot_editors;
        let index = editors.iter().position(|(path, _)| path == &key);
        index.map(|index| editors.remove(index).1)
    };

    if let Some(handle) = handle
        && let Ok(pending) = handle.update(cx, |view, _window, _cx| view.pending_save())
    {
        pending.borrow_mut().flush();
    }

    let windows = cx.global::<AppWindows>();
    let editors_left = windows.editors.len() + windows.screenshot_editors.len();
    tracing::info!(
        path = %key.display(),
        editors_left,
        "screenshot editor window closed"
    );
    if editors_left == 0 && RecordingSession::global(cx).read(cx).phase == Phase::Idle {
        show_main_window(cx);
    } else {
        crate::menus::schedule_dock_sync(cx);
    }
}

pub fn refresh_library_after_delete(cx: &mut App) {
    let main = cx.global::<AppWindows>().main;
    let settings = cx.global::<AppWindows>().settings;
    main.update(cx, |view, window, cx| view.refresh_recents(window, cx))
        .ok();
    if let Some(settings) = settings {
        settings
            .update(cx, |view, window, cx| view.refresh_recordings(window, cx))
            .ok();
    }
}

fn close_controls(session: &Entity<RecordingSession>, cx: &mut App) {
    if let Some(handle) = cx.global_mut::<AppWindows>().controls.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
    session.update(cx, |session, cx| session.set_controls_open(false, cx));
}
