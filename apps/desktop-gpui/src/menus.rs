//! The macOS app menu bar, the window shortcuts behind it, and the dock-icon
//! policy.
//!
//! Three things that are really one thing on macOS: the menu bar only exists
//! while the app is `NSApplicationActivationPolicyRegular`, ⌘W has to mean
//! something different on the main window than on every other window, and the
//! Tauri app decides between Regular and Accessory from exactly the set of
//! windows ⌘W changes.
//!
//! The menu itself is [`build_menus`], the GPUI model for the native menu bar.
//! macOS standard menu items are upgraded in `platform` after GPUI installs it.
//! gpui
//! builds the real `NSMenu` from it and takes each item's key equivalent from
//! the *keymap*, so an action with no `KeyBinding` renders without a shortcut
//! and an action with no live handler renders disabled
//! (`gpui_macos/src/platform.rs:322-420` + `validate_menu_item`). Both halves
//! are load-bearing: every action below is bound in [`init`] and given a global
//! handler there, and the Edit menu deliberately gets neither -- its items
//! carry the *text field's* actions, whose bindings are scoped to the
//! `TextInput` key context, so ⌘Z is a menu key equivalent only while a field
//! is focused and falls through to the editor's own project-undo otherwise.

use std::sync::atomic::{AtomicBool, Ordering};

use gpui::{
    AnyWindowHandle, App, Global, KeyBinding, Menu, MenuItem, OsAction, Subscription,
    SystemMenuType, actions,
};

use crate::{
    app_windows::{self, AppWindows},
    hotkeys,
    i18n::tr,
    main_window::MainWindow,
    platform,
    session::{Phase, RecordingSession},
    settings_window::Page,
    store,
    ui::text_input,
    updates,
};

/// `productName` in `tauri.conf.json`, which is what macOS renames the first
/// submenu to.
pub const APP_NAME: &str = "Cap";

struct MenuRegistration(UpdateRow);

impl Global for MenuRegistration {}

/// What the Check for Update row currently says. Download progress only moves
/// the badge, and only macOS applies it without rebuilding the menu bar, so a
/// percentage tick never touches the menu on the other platforms.
#[derive(Clone, PartialEq)]
struct UpdateRow {
    title: &'static str,
    enabled: bool,
    badge: Option<String>,
}

impl UpdateRow {
    fn of(status: &updates::UpdateStatus) -> Self {
        use updates::UpdateStatus;

        let title = match status {
            UpdateStatus::Idle => tr::menu::update::check(),
            UpdateStatus::Checking => tr::menu::update::checking(),
            UpdateStatus::Available { .. } => tr::menu::update::download(),
            UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. } => {
                tr::menu::update::downloading()
            }
            UpdateStatus::Ready { .. } | UpdateStatus::Installed { .. } => {
                tr::menu::update::restart()
            }
        };
        Self {
            title,
            enabled: !matches!(
                status,
                UpdateStatus::Checking
                    | UpdateStatus::Downloading { .. }
                    | UpdateStatus::Installing { .. }
            ),
            badge: update_menu_badge(status),
        }
    }
}

#[cfg(target_os = "macos")]
fn update_menu_badge(status: &updates::UpdateStatus) -> Option<String> {
    use updates::UpdateStatus;

    match status {
        UpdateStatus::Downloading {
            version,
            fraction: Some(fraction),
        } => Some(tr::menu::update::badge_progress(
            version,
            (fraction * 100.0).round() as u32,
        )),
        UpdateStatus::Available { version }
        | UpdateStatus::Downloading { version, .. }
        | UpdateStatus::Ready { version }
        | UpdateStatus::Installing { version }
        | UpdateStatus::Installed { version, .. } => Some(tr::menu::update::badge_version(version)),
        UpdateStatus::Idle | UpdateStatus::Checking => None,
    }
}

#[cfg(not(target_os = "macos"))]
fn update_menu_badge(_: &updates::UpdateStatus) -> Option<String> {
    None
}

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
        CheckForUpdate,
        /// `PredefinedMenuItem::hide` -- ⌘H.
        HideSelf,
        /// `PredefinedMenuItem::hide_others` -- ⌥⌘H.
        HideOthers,
        /// The Cap menu's explicit Quit item -- ⌘Q.
        Quit,
        /// Settings… -- ⌘, on macOS, Ctrl+, on Windows and Linux.
        OpenSettings,
        OpenFile,
        ImportMedia,
        Changelog,
        HelpDashboard,
        HelpDocs,
        HelpFaq,
        HelpSelfHosting,
        HelpCenter,
        HelpStatus,
        HelpDiscord,
        HelpFeedback,
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
    cx.bind_keys(bindings());

    cx.on_action(|_: &About, cx: &mut App| {
        cx.spawn(async move |_| platform::show_about_panel(APP_NAME, app_version()))
            .detach();
    });
    cx.on_action(|_: &CheckForUpdate, cx: &mut App| {
        updates::check_manually(cx);
    });
    cx.on_action(|_: &HideSelf, cx: &mut App| cx.hide());
    cx.on_action(|_: &HideOthers, cx: &mut App| cx.hide_other_apps());
    cx.on_action(|_: &Quit, cx: &mut App| quit(cx));
    cx.on_action(|_: &OpenFile, cx: &mut App| {
        let (files, directories) = if cfg!(target_os = "macos") {
            (true, false)
        } else {
            (false, true)
        };
        let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
            files,
            directories,
            multiple: false,
            prompt: Some(tr::menu::file::open_prompt().into()),
        });
        cx.spawn(async move |cx| {
            if let Ok(Ok(Some(paths))) = paths.await
                && let Some(path) = paths.into_iter().next()
            {
                cx.update(|cx| crate::tray::open_previous_item(path, cx));
            }
        })
        .detach();
    });
    cx.on_action(|_: &ImportMedia, cx: &mut App| {
        crate::import::pick_and_import_media(cx);
    });
    cx.on_action(|_: &Changelog, cx: &mut App| {
        app_windows::open_settings(crate::settings_window::Page::Changelog, cx)
    });
    cx.on_action(|_: &HelpDashboard, cx: &mut App| cx.open_url("https://cap.so/dashboard"));
    cx.on_action(|_: &HelpDocs, cx: &mut App| cx.open_url("https://cap.so/docs"));
    cx.on_action(|_: &HelpFaq, cx: &mut App| cx.open_url("https://cap.so/faq"));
    cx.on_action(|_: &HelpSelfHosting, cx: &mut App| cx.open_url("https://cap.so/self-hosting"));
    cx.on_action(|_: &HelpCenter, cx: &mut App| cx.open_url("https://help.cap.so/"));
    cx.on_action(|_: &HelpStatus, cx: &mut App| cx.open_url("https://cap.openstatus.dev/"));
    cx.on_action(|_: &HelpDiscord, cx: &mut App| cx.open_url("https://cap.link/discord"));
    cx.on_action(|_: &HelpFeedback, cx: &mut App| {
        app_windows::open_settings(crate::settings_window::Page::Feedback, cx)
    });
    cx.on_action(|_: &CloseWindow, cx: &mut App| close_key_window(cx));
    cx.on_action(|_: &Minimize, cx: &mut App| with_key_native(cx, platform::minimize_native));
    cx.on_action(|_: &Zoom, cx: &mut App| with_key_native(cx, platform::zoom_native));
    cx.on_action(|_: &OpenSettings, cx: &mut App| {
        // While a recording runs, onboarding is up or the Shortcuts page is
        // recording a combo, the chord belongs to whatever has focus.
        let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
        let onboarding_open = cx
            .try_global::<AppWindows>()
            .is_some_and(|windows| windows.onboarding.is_some());
        if !settings_shortcut_allowed(idle, onboarding_open, hotkeys::is_paused(cx)) {
            cx.propagate();
            return;
        }
        // Deferred: the keystroke arrives inside the key window's dispatch, and
        // `open_settings` updates the settings window, which may be that one.
        cx.defer(|cx: &mut App| {
            let page = cx
                .try_global::<AppWindows>()
                .and_then(|windows| windows.settings)
                .and_then(|settings| settings.read(cx).ok().map(|settings| settings.page))
                .unwrap_or(Page::General);
            app_windows::open_settings(page, cx);
            cx.activate(true);
        });
    });
    cx.on_action(|_: &ToggleFullscreen, cx: &mut App| {
        #[cfg(target_os = "windows")]
        if let Some(handle) = cx.active_window() {
            cx.defer(move |cx| {
                let _ = handle.update(cx, |_, window, _| window.toggle_fullscreen());
            });
        }
        #[cfg(not(target_os = "windows"))]
        with_key_native(cx, platform::toggle_fullscreen_native)
    });

    cx.set_global(MenuRegistration(UpdateRow::of(&updates::status(cx))));
    install_menus(cx);
    MENUS_INSTALLED.store(true, Ordering::Relaxed);
    #[cfg(target_os = "macos")]
    if crate::i18n::current() != crate::i18n::Locale::En {
        register_system_menus();
    }
}

static MENUS_INSTALLED: AtomicBool = AtomicBool::new(false);

/// Rebuild the menu bar in the current language, if [`init`] installed one.
pub fn refresh(cx: &mut App) {
    if !MENUS_INSTALLED.load(Ordering::Relaxed) {
        return;
    }
    install_menus(cx);
    #[cfg(target_os = "macos")]
    register_system_menus();
}

/// gpui only registers a Window menu titled "Window" and never registers Help.
/// English keeps exactly what gpui sets up; a translated bar gets both.
#[cfg(target_os = "macos")]
fn register_system_menus() {
    let translated = crate::i18n::current() != crate::i18n::Locale::En;
    platform::register_system_menus(
        tr::menu::window::title(),
        translated.then(tr::menu::help::title),
    );
}

pub(crate) fn refresh_update_menu(cx: &mut App) {
    if !cx.has_global::<MenuRegistration>() {
        return;
    }

    let row = UpdateRow::of(&updates::status(cx));
    if cx.global::<MenuRegistration>().0 == row {
        return;
    }
    cx.global_mut::<MenuRegistration>().0 = row.clone();

    #[cfg(target_os = "macos")]
    platform::set_update_menu_item(row.title, row.badge.as_deref(), row.enabled);
    #[cfg(not(target_os = "macos"))]
    install_menus(cx);
}

pub(crate) fn reapply_update_row(cx: &mut App) {
    if !cx.has_global::<MenuRegistration>() {
        return;
    }
    let row = UpdateRow::of(&updates::status(cx));
    cx.global_mut::<MenuRegistration>().0 = row.clone();
    #[cfg(target_os = "macos")]
    platform::set_update_menu_item(row.title, row.badge.as_deref(), row.enabled);
    #[cfg(not(target_os = "macos"))]
    install_menus(cx);
}

fn install_menus(cx: &mut App) {
    let update_status = updates::status(cx);
    let settings_enabled = !crate::app_windows::onboarding_is_open(cx);
    cx.set_menus(build_menus(&update_status, settings_enabled));
    #[cfg(target_os = "macos")]
    {
        platform::patch_standard_application_menu();
        // The badge lives only on the native item, so a rebuilt menu bar
        // (a language change, onboarding finishing) needs it put back.
        let row = UpdateRow::of(&update_status);
        if row.badge.is_some() {
            platform::set_update_menu_item(row.title, row.badge.as_deref(), row.enabled);
        }
    }
}

pub(crate) fn bindings() -> Vec<KeyBinding> {
    vec![
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-h", HideSelf, None),
        KeyBinding::new("alt-cmd-h", HideOthers, None),
        KeyBinding::new("cmd-w", CloseWindow, None),
        KeyBinding::new("cmd-m", Minimize, None),
        KeyBinding::new("ctrl-cmd-f", ToggleFullscreen, None),
        KeyBinding::new("secondary-,", OpenSettings, None),
    ]
}

fn settings_shortcut_allowed(idle: bool, onboarding_open: bool, hotkeys_paused: bool) -> bool {
    idle && !onboarding_open && !hotkeys_paused
}

/// The menu bar model.
///
/// One-to-one with `build_macos_app_menu`, including the empty Help submenu
/// (`Submenu::with_id_and_items(.., HELP_SUBMENU_ID, "Help", true, &[])`).
pub fn build_menus(update_status: &updates::UpdateStatus, settings_enabled: bool) -> Vec<Menu> {
    let update_row = UpdateRow::of(update_status);

    vec![
        Menu {
            name: APP_NAME.into(),
            disabled: false,
            items: vec![
                MenuItem::action(tr::menu::app::about(), About),
                MenuItem::action(update_row.title, CheckForUpdate).disabled(!update_row.enabled),
                MenuItem::separator(),
                MenuItem::action(tr::menu::app::settings(), OpenSettings)
                    .disabled(!settings_enabled),
                MenuItem::separator(),
                MenuItem::os_submenu(tr::menu::app::services(), SystemMenuType::Services),
                MenuItem::separator(),
                MenuItem::action(tr::menu::app::hide(), HideSelf),
                MenuItem::action(tr::menu::app::hide_others(), HideOthers),
                MenuItem::separator(),
                MenuItem::action(tr::menu::app::quit(), Quit),
            ],
        },
        Menu {
            name: tr::menu::file::title().into(),
            disabled: false,
            items: vec![
                MenuItem::action(tr::menu::file::open_file(), OpenFile),
                MenuItem::action(tr::menu::file::import_media(), ImportMedia),
                MenuItem::separator(),
                MenuItem::action(tr::menu::file::close_window(), CloseWindow),
            ],
        },
        Menu {
            name: tr::menu::edit::title().into(),
            disabled: false,
            // The text field's own actions, tagged with the AppKit selector
            // that belongs to each. gpui routes `cut:`/`copy:`/`paste:`/
            // `selectAll:` through the app delegate back into
            // `cx.dispatch_action`, so all six land in whatever element holds
            // focus -- there is no separate "menu implementation" of copy.
            items: vec![
                MenuItem::os_action(tr::menu::edit::undo(), text_input::Undo, OsAction::Undo),
                MenuItem::os_action(tr::menu::edit::redo(), text_input::Redo, OsAction::Redo),
                MenuItem::separator(),
                MenuItem::os_action(tr::menu::edit::cut(), text_input::Cut, OsAction::Cut),
                MenuItem::os_action(tr::menu::edit::copy(), text_input::Copy, OsAction::Copy),
                MenuItem::os_action(tr::menu::edit::paste(), text_input::Paste, OsAction::Paste),
                MenuItem::os_action(
                    tr::menu::edit::select_all(),
                    text_input::SelectAll,
                    OsAction::SelectAll,
                ),
            ],
        },
        Menu {
            name: tr::menu::view::title().into(),
            disabled: false,
            // muda's own string for this item is "Toggle Full Screen"; AppKit
            // relabels any item wired to `toggleFullScreen:` to "Enter Full
            // Screen", which is what the shipping menu shows. Our item carries
            // a gpui action rather than that selector, so the title is written
            // out -- and, unlike the shipping one, does not flip to "Exit Full
            // Screen" while fullscreen (noted deviation).
            items: vec![MenuItem::action(
                tr::menu::view::enter_full_screen(),
                ToggleFullscreen,
            )],
        },
        Menu {
            // gpui_macos hands this menu to `setWindowsMenu:` only when its
            // title is exactly "Window" (platform.rs:274); [`refresh`]
            // registers a translated one.
            name: tr::menu::window::title().into(),
            disabled: false,
            items: vec![
                MenuItem::action(tr::menu::window::minimize(), Minimize),
                MenuItem::action(tr::menu::window::zoom(), Zoom),
                MenuItem::separator(),
                MenuItem::action(tr::menu::window::close_window(), CloseWindow),
            ],
        },
        Menu {
            name: tr::menu::help::title().into(),
            disabled: false,
            items: vec![
                MenuItem::action(tr::menu::help::feedback(), HelpFeedback),
                MenuItem::separator(),
                MenuItem::action(tr::menu::help::changelog(), Changelog),
                MenuItem::separator(),
                MenuItem::action(tr::menu::help::dashboard(), HelpDashboard),
                MenuItem::action(tr::menu::help::documentation(), HelpDocs),
                MenuItem::action(tr::menu::help::faq(), HelpFaq),
                MenuItem::action(tr::menu::help::self_hosting(), HelpSelfHosting),
                MenuItem::action(tr::menu::help::help_center(), HelpCenter),
                MenuItem::action(tr::menu::help::system_status(), HelpStatus),
                MenuItem::action(tr::menu::help::discord(), HelpDiscord),
            ],
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
    let active = cx.active_window();
    // A ⌘-keystroke action arrives *inside* the key window's own dispatch,
    // which holds that window's lease -- `handle.update` on the same window
    // returns Err there (observed: ⌘W resolved no native handle and silently
    // did nothing). Deferred, so the lease is back first. The menu-click path
    // has no lease and rides the same defer unharmed.
    cx.defer(move |cx| {
        let Some(handle) = active.or_else(|| key_window(cx)) else {
            tracing::info!("window command: no key window");
            return;
        };
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
        if let Some(handle) = key_window(cx) {
            close_window_by_handle(handle, cx);
            return;
        }
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

/// The key window, if it has a close button. `active_window` is AppKit's
/// *main* window, and a `Floating` panel such as the teleprompter becomes key
/// without becoming main, which left ⌘W hiding the main window behind it.
/// Panels without a close button (the controls bar, camera bubble and target
/// overlays can all be key after a click) are skipped, so ⌘W never closes
/// them. Call it deferred: the key window's lease is held during its own
/// dispatch.
fn key_window(cx: &mut App) -> Option<gpui::AnyWindowHandle> {
    cx.windows().into_iter().find(|handle| {
        handle
            .update(cx, |_, window, _| {
                window.is_window_active() && platform::window_is_closable(window)
            })
            .unwrap_or(false)
    })
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

const QUIT_STOP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum QuitAction {
    Wait,
    Stop,
    Exit,
    Failed,
    TimedOut,
}

#[derive(Default)]
struct QuitGate {
    generation: u64,
    pending: Option<(u64, bool)>,
    exit_committed: bool,
}

impl QuitGate {
    fn recording_start_allowed(&self) -> bool {
        !self.exit_committed && self.pending.is_none()
    }

    fn cancel_exit(&mut self) {
        self.exit_committed = false;
    }

    fn request(&mut self, phase: Phase) -> Option<(u64, QuitAction)> {
        if self.exit_committed || self.pending.is_some() {
            return None;
        }
        self.generation = self.generation.wrapping_add(1);
        let action = match phase {
            Phase::Idle => QuitAction::Exit,
            Phase::Starting | Phase::Recording { .. } => QuitAction::Stop,
            Phase::Stopping => QuitAction::Wait,
        };
        if action != QuitAction::Exit {
            self.pending = Some((self.generation, phase != Phase::Starting));
        } else {
            self.exit_committed = true;
        }
        Some((self.generation, action))
    }

    fn advance(
        &mut self,
        generation: u64,
        phase: Phase,
        failed: bool,
        timed_out: bool,
    ) -> QuitAction {
        let Some((current, stop_requested)) = self.pending.as_mut() else {
            return QuitAction::Wait;
        };
        if *current != generation {
            return QuitAction::Wait;
        }
        let action = if failed {
            QuitAction::Failed
        } else if phase == Phase::Idle {
            QuitAction::Exit
        } else if timed_out {
            QuitAction::TimedOut
        } else {
            match phase {
                Phase::Recording { .. } if *stop_requested => QuitAction::Wait,
                Phase::Recording { .. } => {
                    *stop_requested = true;
                    QuitAction::Stop
                }
                Phase::Starting | Phase::Stopping => QuitAction::Wait,
                Phase::Idle => unreachable!(),
            }
        };
        if matches!(
            action,
            QuitAction::Exit | QuitAction::Failed | QuitAction::TimedOut
        ) {
            self.pending = None;
        }
        if action == QuitAction::Exit {
            self.exit_committed = true;
        }
        action
    }
}

#[derive(Default)]
struct QuitCoordinator {
    gate: QuitGate,
    observer: Option<Subscription>,
}

impl Global for QuitCoordinator {}

pub(crate) fn recording_start_allowed(cx: &App) -> bool {
    cx.try_global::<QuitCoordinator>()
        .is_none_or(|coordinator| coordinator.gate.recording_start_allowed())
}

fn quit_phase(phase: Phase, ui_cleanup_pending: bool) -> Phase {
    if phase == Phase::Idle && ui_cleanup_pending {
        Phase::Stopping
    } else {
        phase
    }
}

pub fn quit(cx: &mut App) {
    let session = RecordingSession::global(cx);
    if !cx.has_global::<QuitCoordinator>() {
        cx.set_global(QuitCoordinator::default());
    }
    let phase = session.read(cx).phase;
    let ui_cleanup_pending = app_windows::clean_capture_owned(cx);
    let finishing = ui_cleanup_pending || crate::recording::studio_thumbnails_pending();
    let Some((generation, action)) = cx
        .global_mut::<QuitCoordinator>()
        .gate
        .request(quit_phase(phase, finishing))
    else {
        return;
    };
    if action == QuitAction::Exit {
        apply_quit_action(action, cx);
        return;
    }

    tracing::info!("quit requested during a recording; stopping it first");
    let observer = cx.observe(&session, move |_, cx| {
        advance_pending_quit(generation, false, cx)
    });
    cx.global_mut::<QuitCoordinator>().observer = Some(observer);
    cx.spawn(async move |cx| {
        cx.background_executor().timer(QUIT_STOP_TIMEOUT).await;
        cx.update(|cx| advance_pending_quit(generation, true, cx));
    })
    .detach();
    apply_quit_action(action, cx);
    if phase == Phase::Idle && ui_cleanup_pending {
        app_windows::cancel_clean_capture(cx);
        advance_pending_quit(generation, false, cx);
    }
}

pub(crate) fn recheck_pending_quit(cx: &mut App) {
    let Some(generation) = cx
        .try_global::<QuitCoordinator>()
        .and_then(|coordinator| coordinator.gate.pending)
        .map(|(generation, _)| generation)
    else {
        return;
    };
    advance_pending_quit(generation, false, cx);
}

fn advance_pending_quit(generation: u64, timed_out: bool, cx: &mut App) {
    let session = RecordingSession::global(cx);
    let phase = quit_phase(
        session.read(cx).phase,
        app_windows::clean_capture_owned(cx) || crate::recording::studio_thumbnails_pending(),
    );
    let failed = session.read(cx).error.is_some();
    let action = cx
        .global_mut::<QuitCoordinator>()
        .gate
        .advance(generation, phase, failed, timed_out);
    apply_quit_action(action, cx);
}

fn apply_quit_action(action: QuitAction, cx: &mut App) {
    match action {
        QuitAction::Wait => {}
        QuitAction::Stop => RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx)),
        QuitAction::Exit => {
            cx.global_mut::<QuitCoordinator>().observer = None;
            cx.defer(|cx| {
                if let Err(error) = app_windows::flush_pending_editor_saves(cx) {
                    cx.global_mut::<QuitCoordinator>().gate.cancel_exit();
                    tracing::error!(%error, "quit canceled because editor changes could not be saved");
                    cx.spawn(async move |_| {
                        platform::alert_dialog(tr::dialog::quit::still_open(), &error);
                    })
                    .detach();
                    return;
                }
                #[cfg(target_os = "macos")]
                platform::permit_native_quit();
                cx.quit();
            });
        }
        QuitAction::Failed | QuitAction::TimedOut => {
            cx.global_mut::<QuitCoordinator>().observer = None;
            let message = RecordingSession::global(cx).update(cx, |session, cx| {
                let message = match session.error.as_deref() {
                    Some(error) => {
                        tr::dialog::quit::canceled(crate::i18n::messages::localize(error))
                    }
                    None if action == QuitAction::TimedOut => tr::dialog::quit::pending().into(),
                    None => tr::dialog::quit::unconfirmed().into(),
                };
                session.error = Some(message.clone());
                cx.notify();
                message
            });
            tracing::warn!(%message);
            cx.spawn(async move |_| {
                platform::alert_dialog(tr::dialog::quit::still_open(), &message)
            })
            .detach();
        }
    }
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
    schedule_dock_sync_after(cx, std::time::Duration::from_millis(100));
}

fn schedule_dock_sync_after(cx: &mut App, delay: std::time::Duration) {
    use std::sync::atomic::Ordering;
    let generation = DOCK_SYNC_GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    cx.spawn(async move |cx| {
        cx.background_executor().timer(delay).await;
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
    #[cfg(target_os = "macos")]
    if !show {
        let delay = platform::dock_hide_delay();
        if !delay.is_zero() {
            schedule_dock_sync_after(cx, delay);
            return;
        }
    }
    if !platform::set_activation_policy(show) && cfg!(target_os = "macos") {
        tracing::warn!(show, "Could not change Dock activation policy");
        return;
    }
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

    #[test]
    fn quit_waits_for_recording_ui_restoration() {
        for phase in [Phase::Idle, Phase::Starting] {
            let mut gate = QuitGate::default();
            let (generation, action) = gate.request(quit_phase(phase, true)).unwrap();
            assert_ne!(action, QuitAction::Exit);
            assert!(!gate.recording_start_allowed());
            assert_eq!(
                gate.advance(generation, quit_phase(Phase::Idle, true), false, false),
                QuitAction::Wait
            );
            assert_eq!(
                gate.advance(generation, quit_phase(Phase::Idle, false), false, false),
                QuitAction::Exit
            );
        }
    }

    #[test]
    fn restoration_failure_or_timeout_keeps_cap_open() {
        for failed in [false, true] {
            let mut gate = QuitGate::default();
            let (generation, _) = gate.request(quit_phase(Phase::Idle, true)).unwrap();
            assert_eq!(
                gate.advance(generation, quit_phase(Phase::Idle, true), failed, !failed),
                if failed {
                    QuitAction::Failed
                } else {
                    QuitAction::TimedOut
                }
            );
            assert!(gate.recording_start_allowed());
            assert_eq!(
                gate.advance(generation, quit_phase(Phase::Idle, false), false, false),
                QuitAction::Wait
            );
        }
    }

    #[test]
    fn quit_deadline_does_not_authorize_exit_after_a_delayed_stop() {
        let mut gate = QuitGate::default();
        let (generation, action) = gate.request(Phase::Recording { paused: false }).unwrap();
        assert_eq!(action, QuitAction::Stop);
        assert_eq!(
            gate.advance(generation, Phase::Stopping, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Stopping, false, true),
            QuitAction::TimedOut
        );
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, false),
            QuitAction::Wait
        );
        assert!(gate.pending.is_none());
    }

    #[test]
    fn failed_stop_cancels_quit_instead_of_exiting_or_retrying_stop() {
        let mut gate = QuitGate::default();
        let (generation, _) = gate.request(Phase::Recording { paused: false }).unwrap();
        assert_eq!(
            gate.advance(generation, Phase::Stopping, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Recording { paused: false }, true, false),
            QuitAction::Failed
        );
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, true),
            QuitAction::Wait
        );
    }

    #[test]
    fn quit_during_startup_stops_the_recording_once_it_starts() {
        let mut gate = QuitGate::default();
        let (generation, action) = gate.request(Phase::Starting).unwrap();
        assert_eq!(action, QuitAction::Stop);
        assert_eq!(
            gate.advance(generation, Phase::Starting, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Recording { paused: false }, false, false),
            QuitAction::Stop
        );
        assert_eq!(
            gate.advance(generation, Phase::Stopping, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, false),
            QuitAction::Exit
        );
    }

    #[test]
    fn quit_waits_when_stop_is_queued_behind_a_pause_acknowledgement() {
        let mut gate = QuitGate::default();
        let (generation, action) = gate.request(Phase::Recording { paused: false }).unwrap();
        assert_eq!(action, QuitAction::Stop);
        assert_eq!(
            gate.advance(generation, Phase::Recording { paused: false }, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Recording { paused: true }, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Stopping, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, false),
            QuitAction::Exit
        );
    }

    #[test]
    fn repeated_quit_does_not_replace_the_pending_request() {
        let mut gate = QuitGate::default();
        let (generation, _) = gate.request(Phase::Stopping).unwrap();
        assert_eq!(gate.request(Phase::Stopping), None);
        assert_eq!(gate.request(Phase::Idle), None);
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, false),
            QuitAction::Exit
        );
    }

    #[test]
    fn idle_quit_has_no_stop_or_deadline_wait() {
        let mut gate = QuitGate::default();
        let (_, action) = gate.request(Phase::Idle).unwrap();
        assert_eq!(action, QuitAction::Exit);
        assert!(gate.pending.is_none());
        assert!(gate.exit_committed);
    }

    #[test]
    fn failed_editor_save_allows_recording_and_a_later_quit() {
        for phase in [Phase::Idle, Phase::Stopping] {
            let mut gate = QuitGate::default();
            let (previous, action) = gate.request(phase).unwrap();
            if action == QuitAction::Wait {
                assert_eq!(
                    gate.advance(previous, Phase::Idle, false, false),
                    QuitAction::Exit
                );
            }
            assert!(!gate.recording_start_allowed());
            gate.cancel_exit();
            assert!(gate.recording_start_allowed());
            let (current, action) = gate.request(Phase::Idle).unwrap();
            assert_ne!(previous, current);
            assert_eq!(action, QuitAction::Exit);
            assert_eq!(
                gate.advance(previous, Phase::Idle, false, true),
                QuitAction::Wait
            );
            assert!(gate.exit_committed);
        }
    }

    #[test]
    fn committed_exit_closes_recording_admission_before_the_native_callback() {
        let mut gate = QuitGate::default();
        assert!(gate.recording_start_allowed());
        let (generation, _) = gate.request(Phase::Stopping).unwrap();
        assert!(!gate.recording_start_allowed());
        assert!(!gate.exit_committed);
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, false),
            QuitAction::Exit
        );
        assert!(gate.exit_committed);
        assert!(!gate.recording_start_allowed());
        assert_eq!(gate.request(Phase::Idle), None);
        assert_eq!(
            gate.advance(generation, Phase::Idle, false, true),
            QuitAction::Wait
        );
        assert!(gate.exit_committed);
        assert!(!gate.recording_start_allowed());
    }

    #[test]
    fn expired_quit_cannot_affect_a_new_recording_or_quit_request() {
        let mut gate = QuitGate::default();
        let (old, _) = gate.request(Phase::Stopping).unwrap();
        assert_eq!(
            gate.advance(old, Phase::Stopping, false, true),
            QuitAction::TimedOut
        );
        assert!(!gate.exit_committed);
        assert!(gate.recording_start_allowed());
        let (current, _) = gate.request(Phase::Recording { paused: false }).unwrap();
        assert_eq!(
            gate.advance(old, Phase::Idle, false, true),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(current, Phase::Stopping, false, false),
            QuitAction::Wait
        );
        assert_eq!(
            gate.advance(current, Phase::Idle, false, false),
            QuitAction::Exit
        );
    }

    #[test]
    fn completed_capture_with_finalization_error_does_not_exit() {
        let mut gate = QuitGate::default();
        let (generation, _) = gate.request(Phase::Stopping).unwrap();
        assert_eq!(
            gate.advance(generation, Phase::Idle, true, false),
            QuitAction::Failed
        );
        assert!(gate.pending.is_none());
    }

    #[test]
    fn settings_shortcut_yields_to_recording_onboarding_and_the_recorder() {
        assert!(settings_shortcut_allowed(true, false, false));
        assert!(!settings_shortcut_allowed(false, false, false));
        assert!(!settings_shortcut_allowed(true, true, false));
        assert!(!settings_shortcut_allowed(true, false, true));
    }

    fn keystrokes(binding: &KeyBinding) -> Vec<gpui::Keystroke> {
        binding
            .keystrokes()
            .iter()
            .map(|keystroke| keystroke.inner().clone())
            .collect()
    }

    #[test]
    fn global_keymap_is_unchanged_apart_from_settings() {
        let settings = if cfg!(target_os = "macos") {
            "cmd-,"
        } else {
            "ctrl-,"
        };
        let expected: &[(&str, &dyn gpui::Action)] = &[
            ("cmd-q", &Quit),
            ("cmd-h", &HideSelf),
            ("alt-cmd-h", &HideOthers),
            ("cmd-w", &CloseWindow),
            ("cmd-m", &Minimize),
            ("ctrl-cmd-f", &ToggleFullscreen),
            (settings, &OpenSettings),
        ];
        let bindings = bindings();
        assert_eq!(bindings.len(), expected.len());
        for (binding, (source, action)) in bindings.iter().zip(expected) {
            assert_eq!(
                keystrokes(binding),
                vec![gpui::Keystroke::parse(source).unwrap()],
                "{source}"
            );
            assert!(binding.action().partial_eq(*action), "{source}");
            assert!(binding.predicate().is_none(), "{source}");
        }
        let mut seen = std::collections::HashSet::new();
        for binding in &bindings {
            assert!(
                seen.insert(keystrokes(binding)),
                "{binding:?} is bound twice"
            );
        }
    }

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
    fn menu_bar_includes_native_and_cap_destinations() {
        let menus: Vec<_> = build_menus(&updates::UpdateStatus::Idle, true)
            .iter()
            .map(describe)
            .collect();
        let expected_file_items = vec![
            "Open File…".into(),
            "Import Media…".into(),
            "-".into(),
            "Close Window".into(),
        ];
        assert_eq!(
            menus,
            vec![
                (
                    "Cap".to_string(),
                    vec![
                        "About Cap".to_string(),
                        "Check for Update".into(),
                        "-".into(),
                        tr::menu::app::settings().into(),
                        "-".into(),
                        "Services".into(),
                        "-".into(),
                        "Hide Cap".into(),
                        "Hide Others".into(),
                        "-".into(),
                        "Quit Cap".into(),
                    ]
                ),
                ("File".into(), expected_file_items,),
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
                (
                    "Help".into(),
                    vec![
                        "Give Feedback…".into(),
                        "-".into(),
                        "Changelog".into(),
                        "-".into(),
                        "Dashboard".into(),
                        "Documentation".into(),
                        "FAQ".into(),
                        "Self-hosting".into(),
                        "Help Center".into(),
                        "System Status".into(),
                        "Join Discord Community".into(),
                    ],
                ),
            ]
        );
    }

    /// The row is the second item of the App menu (`menu_bar_...` pins that
    /// order); it greys out while a check or download is running so a second
    /// click cannot fire another one.
    #[test]
    fn the_update_row_greys_out_while_busy() {
        fn row(status: &updates::UpdateStatus) -> (String, bool) {
            let menus = build_menus(status, true);
            match &menus[0].items[1] {
                MenuItem::Action { name, disabled, .. } => (name.to_string(), *disabled),
                _ => panic!("the update row is an action"),
            }
        }

        assert_eq!(
            row(&updates::UpdateStatus::Idle),
            ("Check for Update".to_string(), false)
        );
        assert_eq!(
            row(&updates::UpdateStatus::Checking),
            ("Checking for Update…".to_string(), true)
        );
        assert_eq!(
            row(&updates::UpdateStatus::Downloading {
                version: semver::Version::parse("0.4.0").unwrap(),
                fraction: Some(0.42),
            }),
            ("Downloading update…".to_string(), true)
        );
        assert_eq!(
            row(&updates::UpdateStatus::Installing {
                version: semver::Version::parse("0.4.0").unwrap(),
            }),
            ("Downloading update…".to_string(), true)
        );
    }

    /// The version lives only in the badge, and a percentage tick changes
    /// nothing else -- that is what keeps a download from reinstalling the
    /// menu bar on every progress event.
    #[test]
    fn the_update_row_keeps_the_version_out_of_the_title() {
        use semver::Version;
        use updates::UpdateStatus;

        let version = Version::parse("0.4.0").unwrap();
        let downloading = |fraction| UpdateStatus::Downloading {
            version: version.clone(),
            fraction,
        };

        let available = UpdateRow::of(&UpdateStatus::Available {
            version: version.clone(),
        });
        let cold = UpdateRow::of(&downloading(None));
        let warm = UpdateRow::of(&downloading(Some(0.42)));
        assert_eq!(available.title, "Download update…");
        assert!(available.enabled);
        assert_eq!(cold.title, "Downloading update…");
        assert!(!cold.enabled);
        assert_eq!(warm.title, "Downloading update…");
        assert!(!warm.enabled);

        let ready = UpdateRow::of(&UpdateStatus::Ready {
            version: version.clone(),
        });
        let installed = UpdateRow::of(&UpdateStatus::Installed {
            version: version.clone(),
            executable: std::path::PathBuf::from("/Applications/Cap.app"),
        });
        assert_eq!(ready.title, "Restart to update…");
        assert_eq!(installed.title, ready.title);
        assert_eq!(installed.badge, ready.badge);

        let installing = UpdateRow::of(&UpdateStatus::Installing {
            version: version.clone(),
        });
        assert_eq!(installing.title, "Downloading update…");
        assert!(!installing.enabled);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_update_badge_shows_the_version_and_live_progress() {
        use semver::Version;
        use updates::UpdateStatus;

        let version = Version::parse("0.4.0").unwrap();
        let badge = |status| UpdateRow::of(&status).badge;

        assert_eq!(
            badge(UpdateStatus::Available {
                version: version.clone(),
            }),
            Some("v0.4.0".to_string())
        );
        assert_eq!(
            badge(UpdateStatus::Downloading {
                version: version.clone(),
                fraction: None,
            }),
            Some("v0.4.0".to_string())
        );
        assert_eq!(
            badge(UpdateStatus::Downloading {
                version: version.clone(),
                fraction: Some(0.42),
            }),
            Some("v0.4.0 · 42%".to_string())
        );
        assert_eq!(
            badge(UpdateStatus::Ready {
                version: version.clone(),
            }),
            Some("v0.4.0".to_string())
        );
        assert_eq!(badge(UpdateStatus::Idle), None);
        assert_eq!(badge(UpdateStatus::Checking), None);
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
