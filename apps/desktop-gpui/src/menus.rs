//! The macOS app menu bar, the window shortcuts behind it, and the dock-icon
//! policy.
//!
//! Three things that are really one thing on macOS: the menu bar only exists
//! while the app is `NSApplicationActivationPolicyRegular`, ⌘W has to mean
//! something different on the main window than on every other window, and the
//! Tauri app decides between Regular and Accessory from exactly the set of
//! windows ⌘W changes.
//!
//! The menu itself is [`build_menus`], a byte-for-byte transcription of
//! `build_macos_app_menu` (`apps/desktop/src-tauri/src/lib.rs:479-566`). gpui
//! builds the real `NSMenu` from it and takes each item's key equivalent from
//! the *keymap*, so an action with no `KeyBinding` renders without a shortcut
//! and an action with no live handler renders disabled
//! (`gpui_macos/src/platform.rs:322-420` + `validate_menu_item`). Both halves
//! are load-bearing: every action below is bound in [`init`] and given a global
//! handler there, and the Edit menu deliberately gets neither -- its items
//! carry the *text field's* actions, whose bindings are scoped to the
//! `TextInput` key context, so ⌘Z is a menu key equivalent only while a field
//! is focused and falls through to the editor's own project-undo otherwise.

use gpui::{AnyWindowHandle, App, KeyBinding, Menu, MenuItem, OsAction, SystemMenuType, actions};

use crate::{
    app_windows::{self, AppWindows},
    main_window::MainWindow,
    platform,
    session::{Phase, RecordingSession},
    store,
    ui::text_input,
};

/// `productName` in `tauri.conf.json`, which is what macOS renames the first
/// submenu to and what the About/Hide/Quit labels interpolate.
pub const APP_NAME: &str = "Cap";

/// `env!("CARGO_PKG_VERSION")`, exactly as `build_tray_menu` spells it -- this
/// crate's version, which is the gpui app's own (0.1.x) rather than the
/// shipping desktop app's. Noted as a deviation in the report: there is no
/// shared version constant to read.
pub fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

actions!(
    cap,
    [
        /// `PredefinedMenuItem::about` -- `orderFrontStandardAboutPanel`.
        About,
        /// `PredefinedMenuItem::hide` -- ⌘H.
        HideSelf,
        /// `PredefinedMenuItem::hide_others` -- ⌥⌘H.
        HideOthers,
        /// The Cap menu's explicit Quit item -- ⌘Q.
        Quit,
        /// `PredefinedMenuItem::close_window` -- ⌘W. Present twice in the
        /// Tauri menu (File and Window), one action either way.
        CloseWindow,
        /// `PredefinedMenuItem::minimize` -- ⌘M.
        Minimize,
        /// `PredefinedMenuItem::maximize`, titled "Zoom" on macOS. No
        /// accelerator over there, so none here.
        Zoom,
        /// `PredefinedMenuItem::fullscreen` -- ⌃⌘F.
        ToggleFullscreen,
    ]
);

/// Bind the keys, register the handlers, install the menu bar. Called once from
/// `main`, after [`crate::app_windows::init`] -- every handler reaches into the
/// window registry.
pub fn init(cx: &mut App) {
    // No key context: these are window/application commands, not field
    // commands. Deliberately *not* including cmd-z/x/c/v/a -- those stay the
    // text field's own `TextInput`-scoped bindings (and, for the editor, its
    // `on_key_down` project-undo). A global binding here would shadow both.
    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", HideSelf, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullscreen, None),
    ]);

    cx.on_action(|_: &About, cx: &mut App| {
        // Ordering a window front re-enters gpui's window callbacks, so it runs
        // from a task with no borrow held (`platform::place_overlay_panel`'s
        // rule).
        cx.spawn(async move |_| platform::show_about_panel(APP_NAME, app_version()))
            .detach();
    });
    cx.on_action(|_: &HideSelf, cx: &mut App| cx.hide());
    cx.on_action(|_: &HideOthers, cx: &mut App| cx.hide_other_apps());
    cx.on_action(|_: &Quit, cx: &mut App| quit(cx));
    cx.on_action(|_: &CloseWindow, cx: &mut App| close_key_window(cx));
    cx.on_action(|_: &Minimize, cx: &mut App| with_key_native(cx, platform::minimize_native));
    cx.on_action(|_: &Zoom, cx: &mut App| with_key_native(cx, platform::zoom_native));
    cx.on_action(|_: &ToggleFullscreen, cx: &mut App| {
        with_key_native(cx, platform::toggle_fullscreen_native)
    });

    cx.set_menus(build_menus());
}

/// The menu bar model.
///
/// One-to-one with `build_macos_app_menu`, including the empty Help submenu
/// (`Submenu::with_id_and_items(.., HELP_SUBMENU_ID, "Help", true, &[])`).
pub fn build_menus() -> Vec<Menu> {
    vec![
        Menu {
            name: APP_NAME.into(),
            disabled: false,
            items: vec![
                MenuItem::action(format!("About {APP_NAME}"), About),
                MenuItem::separator(),
                MenuItem::os_submenu("Services", SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action(format!("Hide {APP_NAME}"), HideSelf),
                MenuItem::action("Hide Others", HideOthers),
                MenuItem::separator(),
                MenuItem::action(format!("Quit {APP_NAME}"), Quit),
            ],
        },
        Menu {
            name: "File".into(),
            disabled: false,
            items: vec![MenuItem::action("Close Window", CloseWindow)],
        },
        Menu {
            name: "Edit".into(),
            disabled: false,
            // The text field's own actions, tagged with the AppKit selector
            // that belongs to each. gpui routes `cut:`/`copy:`/`paste:`/
            // `selectAll:` through the app delegate back into
            // `cx.dispatch_action`, so all six land in whatever element holds
            // focus -- there is no separate "menu implementation" of copy.
            items: vec![
                MenuItem::os_action("Undo", text_input::Undo, OsAction::Undo),
                MenuItem::os_action("Redo", text_input::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action("Cut", text_input::Cut, OsAction::Cut),
                MenuItem::os_action("Copy", text_input::Copy, OsAction::Copy),
                MenuItem::os_action("Paste", text_input::Paste, OsAction::Paste),
                MenuItem::os_action("Select All", text_input::SelectAll, OsAction::SelectAll),
            ],
        },
        Menu {
            name: "View".into(),
            disabled: false,
            // muda's own string for this item is "Toggle Full Screen"; AppKit
            // relabels any item wired to `toggleFullScreen:` to "Enter Full
            // Screen", which is what the shipping menu shows. Our item carries
            // a gpui action rather than that selector, so the title is written
            // out -- and, unlike the shipping one, does not flip to "Exit Full
            // Screen" while fullscreen (noted deviation).
            items: vec![MenuItem::action("Enter Full Screen", ToggleFullscreen)],
        },
        Menu {
            name: "Window".into(),
            disabled: false,
            items: vec![
                MenuItem::action("Minimize", Minimize),
                MenuItem::action("Zoom", Zoom),
                MenuItem::separator(),
                MenuItem::action("Close Window", CloseWindow),
            ],
        },
        Menu {
            name: "Help".into(),
            disabled: false,
            items: vec![],
        },
    ]
}

// -- Window commands ---------------------------------------------------------

/// Run an AppKit window command on the key window, from a task.
///
/// `miniaturize:`, `zoom:` and `toggleFullScreen:` all synchronously re-enter
/// gpui's own move/resize/occlusion callbacks, so they may not run inside the
/// update that read the handle -- the `place_overlay_panel` rule, which is also
/// why gpui's own `Window::minimize_window` is not called here.
fn with_key_native(cx: &mut App, action: fn(&platform::NativeWindow)) {
    let Some(handle) = cx.active_window() else {
        tracing::info!("window command: no key window");
        return;
    };
    // A ⌘-keystroke action arrives *inside* the key window's own dispatch,
    // which holds that window's lease -- `handle.update` on the same window
    // returns Err there (observed: ⌘W resolved no native handle and silently
    // did nothing). Deferred, so the lease is back first. The menu-click path
    // has no lease and rides the same defer unharmed.
    cx.defer(move |cx| {
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                action(native);
            }
        })
        .detach();
    });
}

/// ⌘W, the File > Close Window item, and the Window > Close Window item.
///
/// Every window except the main one closes through its own close path --
/// `performClose:`, i.e. what clicking its red traffic light sends -- so
/// `on_window_should_close` runs and the registry bookkeeping
/// (`settings_closed`, `editor_closed`, `mode_select_closed`,
/// `teleprompter_closed`) happens exactly once, on one code path.
///
/// The main window is the exception, and it is the whole reason this function
/// exists: `CapWindowId::Main`'s `CloseRequested` arm calls
/// `api.prevent_close()` and hides the window instead
/// (`apps/desktop/src-tauri/src/lib.rs:5644-5697`).
pub fn close_key_window(cx: &mut App) {
    if let Some(handle) = cx.active_window() {
        close_window_by_handle(handle, cx);
        return;
    }
    // The main window is a non-activating panel: the app can be active with
    // the main window frontmost while gpui tracks NO key window at all, and
    // the ⌘W that reached the menu then had nothing to route to (observed
    // live: this log line firing while the main window sat visible). The
    // Tauri app never meets this state -- its main webview window is a
    // regular key window -- so match its observable contract instead: ⌘W
    // with the app active and the main window up hides the main window.
    // Everything below is deferred: the keystroke still arrived THROUGH the
    // main window's dispatch (its lease is held even when gpui says no window
    // is active), so even the visibility probe's `main.update` would silently
    // Err here -- the with_key_native trap, again.
    cx.defer(|cx| {
        if !cx.has_global::<app_windows::AppWindows>() {
            return;
        }
        let main = cx.global::<app_windows::AppWindows>().main;
        let visible = main
            .update(cx, |_, window, _| platform::window_is_visible(window))
            .unwrap_or(false);
        if visible {
            tracing::info!("close window: no key window; routing to the visible main window");
            app_windows::request_close_main(cx);
        } else {
            tracing::info!("close window: no key window and no visible main window");
        }
    });
}

/// The ⌘W body, keyed by handle -- split out so the harness can close a
/// specific window without depending on focus (synthetic activation races
/// whatever the user has focused).
pub fn close_window_by_handle(handle: gpui::AnyWindowHandle, cx: &mut App) {
    tracing::info!(
        main = handle.downcast::<MainWindow>().is_some(),
        "close window"
    );
    // Deferred for the `with_key_native` reason: the ⌘W keystroke's dispatch
    // holds the key window's lease, and both arms below update windows.
    cx.defer(move |cx| {
        if handle.downcast::<MainWindow>().is_some() {
            app_windows::request_close_main(cx);
            return;
        }
        let native = handle
            .update(cx, |_, window, _| platform::native_window(window))
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                platform::close_native(native);
            }
        })
        .detach();
    });
}

/// ⌘Q, the Cap menu's Quit item, and the tray's "Quit Cap".
///
/// `request_app_exit` stops a live recording before tearing the app down; the
/// closest thing here is the session's own stop, which is asynchronous, so the
/// quit waits for the session to come back to `Idle` (bounded, so a wedged
/// finalize cannot make the app unquittable).
pub fn quit(cx: &mut App) {
    let session = RecordingSession::global(cx);
    if session.read(cx).phase == Phase::Idle {
        cx.quit();
        return;
    }

    tracing::info!("quit requested during a recording; stopping it first");
    session.update(cx, |session, cx| session.stop(cx));
    cx.spawn(async move |cx| {
        for _ in 0..100 {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(100))
                .await;
            let idle = cx.update(|cx| session.read(cx).phase == Phase::Idle);
            if idle {
                break;
            }
        }
        cx.update(|cx| cx.quit());
    })
    .detach();
}

// -- The dock icon -----------------------------------------------------------

/// Whether the dock icon (and therefore the menu bar) should be showing.
///
/// `sync_macos_dock_visibility` (`src-tauri/src/permissions.rs:212-249`),
/// factored out so the rule can be tested without an NSApplication:
///
/// - a visible *panel* window (camera bubble, recording bar, target-select
///   overlay, teleprompter) while the user has asked for no dock icon leaves
///   the policy exactly as it is -- `None` here, which is the `return` there;
/// - otherwise the icon shows unless the user asked for it hidden and no
///   dock-activating window (main, settings, mode select, editor) is visible.
pub fn dock_decision(
    hide_dock_icon: bool,
    has_visible_panel_window: bool,
    has_visible_dock_window: bool,
) -> Option<bool> {
    if has_visible_panel_window && hide_dock_icon {
        return None;
    }
    Some(!hide_dock_icon || has_visible_dock_window)
}

/// Bumped by every [`schedule_dock_sync`]; only the newest scheduled sync runs.
static DOCK_SYNC_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `schedule_macos_dock_visibility_sync`: coalesce a burst of window changes
/// into one policy change, 100ms later.
pub fn schedule_dock_sync(cx: &mut App) {
    use std::sync::atomic::Ordering;
    let generation = DOCK_SYNC_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    cx.spawn(async move |cx| {
        cx.background_executor()
            .timer(std::time::Duration::from_millis(100))
            .await;
        if DOCK_SYNC_GENERATION.load(Ordering::Acquire) != generation {
            return;
        }
        cx.update(sync_dock_visibility);
    })
    .detach();
}

/// Apply [`dock_decision`] to the live window registry.
pub fn sync_dock_visibility(cx: &mut App) {
    // "Changing the activation policy while any window owns a fullscreen Space
    // makes AppKit throw an NSException that aborts the process when it unwinds
    // into Rust" -- `macos_any_window_fullscreen`'s comment, and the reason the
    // View menu's fullscreen item and this function have to stay out of each
    // other's way.
    if any_window_fullscreen(cx) {
        return;
    }

    let hide_dock_icon = store::GeneralSettings::load().hide_dock_icon;
    let (panel, dock) = visible_window_classes(cx);
    let Some(show) = dock_decision(hide_dock_icon, panel, dock) else {
        return;
    };

    let before = platform::activation_policy();
    let want = if show { 0 } else { 1 };
    if before == want {
        return;
    }
    platform::set_activation_policy(show);
    tracing::info!(
        hide_dock_icon,
        panel_visible = panel,
        dock_visible = dock,
        show,
        policy = platform::activation_policy(),
        "dock visibility synced"
    );
    if show {
        // An Accessory app has no menu bar. Coming back to Regular is not
        // enough on its own -- the app has to be the active application for
        // macOS to draw its menu bar, and the transition drops activation.
        cx.activate(true);
    }
}

/// Is any window fullscreen? Read-only, so it is safe inside an update.
fn any_window_fullscreen(cx: &mut App) -> bool {
    cx.windows().into_iter().any(|handle: AnyWindowHandle| {
        handle
            .update(cx, |_, window, _| window.is_fullscreen())
            .unwrap_or(false)
    })
}

/// `(has_visible_panel_window, has_visible_dock_window)`.
///
/// The split is `CapWindowId::activates_dock()` (`windows.rs:1049-1060`): Main,
/// Editor, Settings, ModeSelect, Onboarding (plus Upgrade/ScreenshotEditor,
/// which this app has no equivalent of) activate the dock; the camera bubble,
/// the recording bar, the target-select overlays and the teleprompter do not.
///
/// A window in the registry is on screen -- these are opened shown and removed
/// when closed -- except the main one, which is hidden and shown in place, so
/// that one is asked.
fn visible_window_classes(cx: &mut App) -> (bool, bool) {
    let main = cx.global::<AppWindows>().main;
    let main_visible = main
        .update(cx, |_, window, _| platform::window_is_visible(window))
        .unwrap_or(false);
    let teleprompter = cx.global::<AppWindows>().teleprompter;
    let teleprompter_visible = teleprompter
        .and_then(|handle| {
            handle
                .update(cx, |_, window, _| platform::window_is_visible(window))
                .ok()
        })
        .unwrap_or(false);

    let windows = cx.global::<AppWindows>();
    let panel = windows.camera.is_some()
        || windows.controls.is_some()
        || !windows.overlays.is_empty()
        || teleprompter_visible;
    let dock = main_visible
        || windows.settings.is_some()
        || windows.onboarding.is_some()
        || windows.mode_select.is_some()
        || !windows.editors.is_empty();
    (panel, dock)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The menu bar, transcribed from `build_macos_app_menu`. Separators are
    /// spelled `"-"` so the ordering is checked too.
    fn describe(menu: &Menu) -> (String, Vec<String>) {
        let items = menu
            .items
            .iter()
            .map(|item| match item {
                MenuItem::Separator => "-".to_string(),
                MenuItem::Action { name, .. } => name.to_string(),
                MenuItem::Submenu(menu) => menu.name.to_string(),
                MenuItem::SystemMenu(menu) => menu.name.to_string(),
            })
            .collect();
        (menu.name.to_string(), items)
    }

    #[test]
    fn menu_bar_matches_the_tauri_structure() {
        let menus: Vec<_> = build_menus().iter().map(describe).collect();
        assert_eq!(
            menus,
            vec![
                (
                    "Cap".to_string(),
                    vec![
                        "About Cap".to_string(),
                        "-".into(),
                        "Services".into(),
                        "-".into(),
                        "Hide Cap".into(),
                        "Hide Others".into(),
                        "-".into(),
                        "Quit Cap".into(),
                    ]
                ),
                ("File".into(), vec!["Close Window".into()]),
                (
                    "Edit".into(),
                    vec![
                        "Undo".into(),
                        "Redo".into(),
                        "-".into(),
                        "Cut".into(),
                        "Copy".into(),
                        "Paste".into(),
                        "Select All".into(),
                    ]
                ),
                ("View".into(), vec!["Enter Full Screen".into()]),
                (
                    "Window".into(),
                    vec![
                        "Minimize".into(),
                        "Zoom".into(),
                        "-".into(),
                        "Close Window".into(),
                    ]
                ),
                ("Help".into(), vec![]),
            ]
        );
    }

    /// `sync_macos_dock_visibility`'s three branches.
    #[test]
    fn dock_policy_matches_the_tauri_rule() {
        // The dock icon is never hidden while the setting is off.
        assert_eq!(dock_decision(false, false, false), Some(true));
        assert_eq!(dock_decision(false, true, false), Some(true));
        assert_eq!(dock_decision(false, true, true), Some(true));

        // With the setting on: a visible panel window freezes the policy...
        assert_eq!(dock_decision(true, true, false), None);
        assert_eq!(dock_decision(true, true, true), None);
        // ...and otherwise the icon follows the dock-activating windows.
        assert_eq!(dock_decision(true, false, true), Some(true));
        assert_eq!(dock_decision(true, false, false), Some(false));
    }
}
