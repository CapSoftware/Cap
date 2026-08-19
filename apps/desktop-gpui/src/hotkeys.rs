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
//! Tauri app (`target_select_overlay.rs`, not a `HotkeyAction`).
//!
//! Deviation: the Tauri handler's mic-confirm dialog before a hotkey start
//! (`confirm_before_recording_without_microphone`) is not ported yet -- it
//! belongs with the recording countdown / mic-confirm parity unit.

use std::str::FromStr as _;

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use global_hotkey::{
    GlobalHotKeyEvent, GlobalHotKeyManager, HotKeyState,
    hotkey::{Code, HotKey, Modifiers},
};
use gpui::{App, Global};

use crate::{
    app_windows,
    main_window::{Mode, TargetType},
    session::RecordingSession,
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
    let old: Vec<HotKey> = hotkeys.bindings.iter().map(|(hotkey, _)| *hotkey).collect();
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

fn dispatch_id(id: u32, cx: &mut App) {
    let action = cx
        .global::<Hotkeys>()
        .bindings
        .iter()
        .find(|(hotkey, _)| hotkey.id() == id)
        .map(|(_, action)| *action);
    if let Some(action) = action {
        dispatch(action, cx);
    }
}

/// `handle_hotkey` (`hotkeys.rs:228-337` over there), against this app's
/// counterparts. Session methods are no-ops in the wrong phase, matching the
/// Tauri commands' own early returns.
fn dispatch(action: HotkeyAction, cx: &mut App) {
    tracing::info!(?action, "global hotkey");
    match action {
        HotkeyAction::StartStudioRecording => start_primary_display(Mode::Studio, cx),
        HotkeyAction::StartInstantRecording => start_primary_display(Mode::Instant, cx),
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
        HotkeyAction::ScreenshotWindow => match scap_targets::Window::get_topmost_at_cursor() {
            Some(window) => crate::screenshot::take_screenshot(
                ScreenCaptureTarget::Window { id: window.id() },
                cx,
            ),
            None => tracing::warn!("no window under the cursor to screenshot"),
        },
        HotkeyAction::ScreenshotArea => {
            // `set_mode(Screenshot)` + the area picker (`hotkeys.rs:311-323`):
            // the grab happens when the drawn area is released.
            app_windows::set_recording_mode(Mode::Screenshot, cx);
            app_windows::arm_target_mode(TargetType::Area, cx);
        }
    }
}

/// `RequestStartRecording`'s listener with no armed target records the
/// primary display (`lib.rs:5517-5538` over there); mic/camera come off the
/// main window's current selections through its ordinary start path.
fn start_primary_display(mode: Mode, cx: &mut App) {
    app_windows::set_recording_mode(mode, cx);
    let target = ScreenCaptureTarget::Display {
        id: scap_targets::Display::primary().id(),
    };
    let main = cx.global::<app_windows::AppWindows>().main;
    main.update(cx, |view, window, cx| {
        view.start_recording_with_target(target, Vec::new(), window, cx)
    })
    .ok();
}
