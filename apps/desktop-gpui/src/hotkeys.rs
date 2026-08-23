//! Global hotkeys -- `apps/desktop/src-tauri/src/hotkeys.rs`, natively.
//!
//! The Tauri app registers the store's bindings through
//! `tauri_plugin_global_shortcut`, which wraps the `global-hotkey` crate;
//! this module uses that crate directly at the same pin, so the platform
//! mapping from the store's W3C `KeyboardEvent.code` strings to Carbon
//! virtual keycodes is the exact code path the shipping app runs. Bindings
//! live in the shared store (`hotkeys.hotkeys`, see `store::hotkeys_raw`),
//! and the settings Shortcuts page's commit calls [`reload`] where the Tauri
//! page calls `commands.setHotkey`.
//!
//! The overlay's global Escape stays on its own Carbon registration
//! (`platform::register_escape_hotkey`) exactly as it is separate in the
//! Tauri app (`target_select_overlay.rs`, not a `HotkeyAction`). The Tauri
//! handler's `OnEscapePress` emit only ever reaches that overlay too -- its
//! sole listener is `target-select-overlay.tsx` -- so the native registration
//! covers the whole behaviour.

use std::str::FromStr as _;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use global_hotkey::{
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
    hotkey::{Code, HotKey, Modifiers},
};
use gpui::{App, Global, PromptButton, PromptLevel};

use crate::{
    app_windows,
    main_window::{Mode, TargetType},
    session::{Phase, RecordingSession},
    store,
};

/// `HotkeyAction` (`hotkeys.rs:52-71` over there); the variants are the
/// camelCase store keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HotkeyAction {
    StartStudioRecording,
    StartInstantRecording,
    StopRecording,
    RestartRecording,
    TogglePauseRecording,
    CycleRecordingMode,
    OpenRecordingPicker,
    OpenRecordingPickerDisplay,
    OpenRecordingPickerWindow,
    OpenRecordingPickerArea,
    ScreenshotDisplay,
    ScreenshotWindow,
    ScreenshotArea,
}

impl HotkeyAction {
    fn from_store_key(key: &str) -> Option<Self> {
        Some(match key {
            "startStudioRecording" => Self::StartStudioRecording,
            "startInstantRecording" => Self::StartInstantRecording,
            "stopRecording" => Self::StopRecording,
            "restartRecording" => Self::RestartRecording,
            "togglePauseRecording" => Self::TogglePauseRecording,
            "cycleRecordingMode" => Self::CycleRecordingMode,
            "openRecordingPicker" => Self::OpenRecordingPicker,
            "openRecordingPickerDisplay" => Self::OpenRecordingPickerDisplay,
            "openRecordingPickerWindow" => Self::OpenRecordingPickerWindow,
            "openRecordingPickerArea" => Self::OpenRecordingPickerArea,
            "screenshotDisplay" => Self::ScreenshotDisplay,
            "screenshotWindow" => Self::ScreenshotWindow,
            "screenshotArea" => Self::ScreenshotArea,
            // `#[serde(other)] Other` over there: a newer app's action
            // survives in the store and registers nothing here.
            _ => return None,
        })
    }
}

struct Hotkeys {
    manager: GlobalHotKeyManager,
    bindings: Vec<(HotKey, HotkeyAction)>,
}

impl Global for Hotkeys {}

/// Create the manager (main thread -- it installs the Carbon event handler),
/// register the store's bindings, and start the drain. The handler callback
/// fires on the OS event seam, so it only forwards into a channel; the gpui
/// task dispatches with a clean borrow -- the tray-channel discipline.
pub fn init(cx: &mut App) {
    let manager = match GlobalHotKeyManager::new() {
        Ok(manager) => manager,
        Err(error) => {
            tracing::error!("the global hotkey manager failed to start: {error}");
            return;
        }
    };
    cx.set_global(Hotkeys {
        manager,
        bindings: Vec::new(),
    });
    register_from_store(cx);

    let (tx, rx) = flume::unbounded::<GlobalHotKeyEvent>();
    GlobalHotKeyEvent::set_event_handler(Some(move |event: GlobalHotKeyEvent| {
        let _ = tx.send(event);
    }));
    cx.spawn(async move |cx| {
        while let Ok(event) = rx.recv_async().await {
            // Pressed only, like the Tauri handler (`hotkeys.rs:183-185`).
            if event.state == HotKeyState::Pressed {
                cx.update(|cx| dispatch_id(event.id(), cx));
            }
        }
    })
    .detach();
}

/// Re-read the store and swap every OS registration -- the settings page's
/// commit seam (`commands.setHotkey` re-registers over there).
pub fn reload(cx: &mut App) {
    if !cx.has_global::<Hotkeys>() {
        return;
    }
    let hotkeys = cx.global_mut::<Hotkeys>();
    // Two actions on one combo share one OS registration, so unregister each
    // combo once.
    let mut old: Vec<HotKey> = Vec::new();
    for (hotkey, _) in &hotkeys.bindings {
        if !old.iter().any(|existing| existing.id() == hotkey.id()) {
            old.push(*hotkey);
        }
    }
    if let Err(error) = hotkeys.manager.unregister_all(&old) {
        tracing::warn!("unregistering global hotkeys failed: {error}");
    }
    hotkeys.bindings.clear();
    register_from_store(cx);
}

fn register_from_store(cx: &mut App) {
    let stored = store::hotkeys_raw();
    let hotkeys = cx.global_mut::<Hotkeys>();
    for (key, value) in &stored {
        let Some(action) = HotkeyAction::from_store_key(key) else {
            tracing::debug!(key, "hotkey action unknown to this build; skipped");
            continue;
        };
        let Some(binding) = store::hotkey_from_value(value) else {
            tracing::warn!(key, "unparseable hotkey binding in the store");
            continue;
        };
        let Ok(code) = Code::from_str(&binding.code) else {
            tracing::warn!(key, code = %binding.code, "unknown hotkey code");
            continue;
        };
        let mut mods = Modifiers::empty();
        if binding.meta {
            mods |= Modifiers::META;
        }
        if binding.ctrl {
            mods |= Modifiers::CONTROL;
        }
        if binding.alt {
            mods |= Modifiers::ALT;
        }
        if binding.shift {
            mods |= Modifiers::SHIFT;
        }
        let hotkey = HotKey::new(Some(mods), code);
        // The same combo bound to a second action keeps the one OS
        // registration; the dispatch fires every action on it, the way the
        // Tauri handler loops the whole map per press (`hotkeys.rs:201-205`
        // over there).
        if hotkeys
            .bindings
            .iter()
            .any(|(existing, _)| existing.id() == hotkey.id())
        {
            hotkeys.bindings.push((hotkey, action));
            continue;
        }
        match hotkeys.manager.register(hotkey) {
            Ok(()) => hotkeys.bindings.push((hotkey, action)),
            Err(error) => {
                tracing::warn!(?action, code = %binding.code, "registering global hotkey failed: {error}")
            }
        }
    }
    tracing::info!(count = hotkeys.bindings.len(), "global hotkeys registered");
}

/// `CAP_GPUI_AUTO_HOTKEY=<store key>`: run an action's dispatch arm without
/// the OS keypress (unprivileged synthetic key events are dropped, the same
/// reason every other `CAP_GPUI_AUTO_*` hook exists).
pub fn dispatch_for_harness(key: &str, cx: &mut App) {
    match HotkeyAction::from_store_key(key) {
        Some(action) => dispatch(action, cx),
        None => tracing::error!(key, "CAP_GPUI_AUTO_HOTKEY: unknown action"),
    }
}

// The Tauri handler carries a ⌘, special case (`shortcut.mods ==
// Modifiers::META && shortcut.key == Code::Comma` opens Settings,
// `hotkeys.rs:191-196` over there) that is dead code at this pin:
// `HotKey::new` rewrites META into SUPER on every registration path, so no
// shortcut the handler ever sees carries META. Not reproduced -- the audit
// keeps the *observed* behaviour, which is that a Comma binding runs its
// action and nothing else.
fn dispatch_id(id: u32, cx: &mut App) {
    let actions = actions_for(&cx.global::<Hotkeys>().bindings, id);
    for action in actions {
        dispatch(action, cx);
    }
}

/// Every action bound to the pressed combo, in store order. The Tauri handler
/// loops the whole map per press (`hotkeys.rs:201-205` over there), so two
/// actions sharing one binding both fire.
fn actions_for(bindings: &[(HotKey, HotkeyAction)], id: u32) -> Vec<HotkeyAction> {
    bindings
        .iter()
        .filter(|(hotkey, _)| hotkey.id() == id)
        .map(|(_, action)| *action)
        .collect()
}

/// `handle_hotkey` (`hotkeys.rs:228-337` over there), against this app's
/// counterparts. Session methods are no-ops in the wrong phase, matching the
/// Tauri commands' own early returns.
fn dispatch(action: HotkeyAction, cx: &mut App) {
    tracing::info!(?action, "global hotkey");
    match action {
        HotkeyAction::StartStudioRecording => start_from_hotkey(Mode::Studio, cx),
        HotkeyAction::StartInstantRecording => start_from_hotkey(Mode::Instant, cx),
        HotkeyAction::StopRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.stop(cx));
        }
        HotkeyAction::RestartRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.restart(cx));
        }
        HotkeyAction::TogglePauseRecording => {
            RecordingSession::global(cx).update(cx, |session, cx| session.toggle_pause(cx));
        }
        HotkeyAction::CycleRecordingMode => {
            // `Studio -> Instant -> Screenshot -> Studio` (`hotkeys.rs:262`).
            let next = match Mode::from_store() {
                Mode::Studio => Mode::Instant,
                Mode::Instant => Mode::Screenshot,
                Mode::Screenshot => Mode::Studio,
            };
            app_windows::set_recording_mode(next, cx);
        }
        HotkeyAction::OpenRecordingPicker => {
            app_windows::show_main_window(cx);
            cx.activate(true);
        }
        HotkeyAction::OpenRecordingPickerDisplay => {
            app_windows::arm_target_mode(TargetType::Display, cx)
        }
        HotkeyAction::OpenRecordingPickerWindow => {
            app_windows::arm_target_mode(TargetType::Window, cx)
        }
        HotkeyAction::OpenRecordingPickerArea => app_windows::arm_target_mode(TargetType::Area, cx),
        HotkeyAction::ScreenshotDisplay => {
            let display = scap_targets::Display::get_containing_cursor()
                .unwrap_or_else(scap_targets::Display::primary);
            crate::screenshot::take_screenshot(
                ScreenCaptureTarget::Display { id: display.id() },
                cx,
            );
        }
        // Falls through our own windows to the one beneath, like the picker
        // list and the overlay hover (`devices::topmost_foreign_window_at_cursor`).
        HotkeyAction::ScreenshotWindow => {
            match crate::devices::topmost_foreign_window_at_cursor() {
                Some(window) => crate::screenshot::take_screenshot(
                    ScreenCaptureTarget::Window { id: window.id() },
                    cx,
                ),
                None => tracing::warn!("no window under the cursor to screenshot"),
            }
        }
        HotkeyAction::ScreenshotArea => {
            // `set_mode(Screenshot)` + the area picker (`hotkeys.rs:311-323`):
            // the grab happens when the drawn area is released.
            app_windows::set_recording_mode(Mode::Screenshot, cx);
            app_windows::arm_target_mode(TargetType::Area, cx);
        }
    }
}

/// `start_recording_from_hotkey` + the `RequestStartRecording` listener
/// (`hotkeys.rs:158-177`, `lib.rs:5529-5551` over there): confirm a start
/// without a working microphone, then record the store's
/// `recording_settings.target` -- whatever either app recorded last -- with
/// the primary display as the fallback. Mic/camera come off the main window's
/// current selections through its ordinary start path.
///
/// The mode is set through [`app_windows::set_recording_mode`] first, so the
/// pill, the tray tick and the shared store all follow the hotkey; the Tauri
/// listener hands the mode straight to the engine and leaves the setting
/// where it was. Deliberate: this app's start path reads the window's mode,
/// and a recording visibly in Studio mode with the pill saying Instant is the
/// worse mismatch.
fn start_from_hotkey(mode: Mode, cx: &mut App) {
    app_windows::set_recording_mode(mode, cx);
    let target = stored_target().unwrap_or_else(|| ScreenCaptureTarget::Display {
        id: scap_targets::Display::primary().id(),
    });
    let main = cx.global::<app_windows::AppWindows>().main;

    // `is_recording_active_or_pending` (`hotkeys.rs:162-170` over there): an
    // active session skips the confirm -- the re-start is a no-op either way,
    // `start_recording_with_target`'s phase check here and `start_recording`'s
    // over there.
    let idle = RecordingSession::global(cx).read(cx).phase == Phase::Idle;
    let confirm_enabled = store::GeneralSettings::load().confirm_without_microphone;
    if !idle || !confirm_enabled {
        start_now(main, target, cx);
        return;
    }
    let mic_name = main.read(cx).ok().and_then(|view| {
        view.microphone_selection()
            .map(|microphone| microphone.name.clone())
    });

    cx.spawn(async move |cx| {
        // `MicrophoneFeed::list().contains_key(name)` -- the exact
        // availability probe the Tauri confirm runs (`hotkeys.rs:126-135`
        // over there), on the background executor because it enumerates
        // CoreAudio devices. No selection means no microphone, which needs no
        // enumeration to know.
        let available = match mic_name {
            Some(name) => {
                cx.background_executor()
                    .spawn(async move {
                        cap_recording::feeds::microphone::MicrophoneFeed::list().contains_key(&name)
                    })
                    .await
            }
            None => false,
        };
        if available {
            cx.update(|cx| start_now(main, target, cx));
            return;
        }
        // The Tauri dialog, word for word
        // (`confirm_direct_recording_without_microphone`). gpui prompts are
        // window sheets rather than free-standing alerts, so the main window
        // comes forward to host it.
        let receiver = cx.update(|cx| {
            app_windows::show_main_window(cx);
            cx.activate(true);
            main.update(cx, |_, window, cx| {
                window.prompt(
                    PromptLevel::Warning,
                    "No microphone detected",
                    Some("This recording will not include your voice."),
                    &[
                        PromptButton::ok("Record without microphone"),
                        PromptButton::cancel("Cancel"),
                    ],
                    cx,
                )
            })
        });
        let Ok(receiver) = receiver else {
            return;
        };
        // `receiver.await.unwrap_or(false)`: a dismissed sheet records
        // nothing.
        if receiver.await == Ok(0) {
            cx.update(|cx| start_now(main, target, cx));
        }
    })
    .detach();
}

fn start_now(
    main: gpui::WindowHandle<crate::main_window::MainWindow>,
    target: ScreenCaptureTarget,
    cx: &mut App,
) {
    main.update(cx, |view, window, cx| {
        view.start_recording_with_target(target, Vec::new(), window, cx)
    })
    .ok();
}

/// `RecordingSettingsStore.target`, straight off the shared store's JSON. A
/// missing key, a `null`, or a shape this build's `ScreenCaptureTarget` does
/// not know is `None` -- the primary-display fallback.
fn stored_target() -> Option<ScreenCaptureTarget> {
    let value = store::store_section(store::RECORDING_SETTINGS).remove("target")?;
    serde_json::from_value(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every store key the Tauri `HotkeyAction`'s camelCase serde produces
    /// maps to a variant here, and an unknown key registers nothing.
    #[test]
    fn action_keys_match_the_tauri_serde_names() {
        for key in [
            "startStudioRecording",
            "startInstantRecording",
            "stopRecording",
            "restartRecording",
            "togglePauseRecording",
            "cycleRecordingMode",
            "openRecordingPicker",
            "openRecordingPickerDisplay",
            "openRecordingPickerWindow",
            "openRecordingPickerArea",
            "screenshotDisplay",
            "screenshotWindow",
            "screenshotArea",
        ] {
            assert!(
                HotkeyAction::from_store_key(key).is_some(),
                "{key} should map to an action"
            );
        }
        assert_eq!(HotkeyAction::from_store_key("someFutureAction"), None);
    }

    /// Two actions on the same combo both fire on one press -- the Tauri
    /// handler loops the whole map (`hotkeys.rs:201-205` over there).
    #[test]
    fn a_shared_binding_fires_every_action_on_it() {
        let stop = HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyS);
        let restart = HotKey::new(Some(Modifiers::META | Modifiers::SHIFT), Code::KeyS);
        let pause = HotKey::new(Some(Modifiers::META), Code::KeyP);
        assert_eq!(stop.id(), restart.id());

        let bindings = vec![
            (stop, HotkeyAction::StopRecording),
            (pause, HotkeyAction::TogglePauseRecording),
            (restart, HotkeyAction::RestartRecording),
        ];
        assert_eq!(
            actions_for(&bindings, stop.id()),
            vec![HotkeyAction::StopRecording, HotkeyAction::RestartRecording]
        );
        assert_eq!(
            actions_for(&bindings, pause.id()),
            vec![HotkeyAction::TogglePauseRecording]
        );
    }

    /// Why the Tauri handler's ⌘, special case is not reproduced (see
    /// [`dispatch_id`]): registration rewrites META into SUPER, so its
    /// `mods == Modifiers::META` guard can never hold.
    #[test]
    fn registration_never_leaves_meta_in_the_modifiers() {
        let settings = HotKey::new(Some(Modifiers::META), Code::Comma);
        assert!(!settings.mods.contains(Modifiers::META));
        assert!(settings.mods.contains(Modifiers::SUPER));
    }
}
