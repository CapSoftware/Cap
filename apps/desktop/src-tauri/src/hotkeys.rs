use crate::{
    App, ArcLock, RequestOpenRecordingPicker, RequestStartRecording, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    tray,
    windows::ShowCapWindow,
};
use cap_recording::feeds::microphone::MicrophoneFeed;
use cap_recording::screen_capture::ScreenCaptureTarget;
use global_hotkey::HotKeyState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;
use tracing::instrument;

#[derive(Serialize, Deserialize, Type, PartialEq, Clone, Copy, Debug)]
pub struct Hotkey {
    #[specta(type = String)]
    code: Code,
    meta: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl From<Hotkey> for Shortcut {
    fn from(hotkey: Hotkey) -> Self {
        let mut modifiers = Modifiers::empty();

        if hotkey.meta {
            modifiers |= Modifiers::META;
        }
        if hotkey.ctrl {
            modifiers |= Modifiers::CONTROL;
        }
        if hotkey.alt {
            modifiers |= Modifiers::ALT;
        }
        if hotkey.shift {
            modifiers |= Modifiers::SHIFT;
        }

        Shortcut::new(Some(modifiers), hotkey.code)
    }
}

#[derive(Serialize, Deserialize, Type, PartialEq, Eq, Hash, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::enum_variant_names)]
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
    #[serde(other)]
    Other,
}

#[derive(Serialize, Deserialize, Type, Default)]
pub struct HotkeysStore {
    hotkeys: HashMap<HotkeyAction, Hotkey>,
}

impl HotkeysStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let Ok(Some(store)) = app.store("store").map(|s| s.get("hotkeys")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
    }
}

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct OnEscapePress;

pub type HotkeysState = Mutex<HotkeysStore>;

const RECORDING_START_SAFETY_STORE_KEY: &str = "recording_start_safety";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct RecordingStartSafetySettings {
    confirm_before_recording_without_microphone: bool,
}

impl Default for RecordingStartSafetySettings {
    fn default() -> Self {
        Self {
            confirm_before_recording_without_microphone: true,
        }
    }
}

fn should_confirm_without_microphone(enabled: bool, microphone_available: bool) -> bool {
    enabled && !microphone_available
}

fn should_confirm_direct_recording(app: &AppHandle) -> bool {
    let enabled = app
        .store("store")
        .ok()
        .and_then(|store| store.get(RECORDING_START_SAFETY_STORE_KEY))
        .and_then(|value| serde_json::from_value::<RecordingStartSafetySettings>(value).ok())
        .unwrap_or_default()
        .confirm_before_recording_without_microphone;

    if !enabled {
        return false;
    }

    let microphone_name = RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .and_then(|settings| settings.mic_name);
    let microphone_available = microphone_name
        .as_deref()
        .is_some_and(|name| MicrophoneFeed::list().contains_key(name));

    should_confirm_without_microphone(enabled, microphone_available)
}

async fn confirm_direct_recording_without_microphone(app: &AppHandle) -> bool {
    if !should_confirm_direct_recording(app) {
        return true;
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message("This recording will not include your voice.")
        .title("No microphone detected")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Record without microphone".to_string(),
            "Cancel".to_string(),
        ))
        .show(move |confirmed| {
            let _ = sender.send(confirmed);
        });

    receiver.await.unwrap_or(false)
}

async fn start_recording_from_hotkey(
    app: AppHandle,
    mode: cap_recording::RecordingMode,
) -> Result<(), String> {
    if app
        .state::<ArcLock<App>>()
        .read()
        .await
        .is_recording_active_or_pending()
    {
        let _ = RequestStartRecording { mode }.emit(&app);
        return Ok(());
    }

    if confirm_direct_recording_without_microphone(&app).await {
        let _ = RequestStartRecording { mode }.emit(&app);
    }

    Ok(())
}

pub fn init(app: &AppHandle) {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if !matches!(event.state(), HotKeyState::Pressed) {
                    return;
                }

                if shortcut.key == Code::Escape {
                    OnEscapePress.emit(app).ok();
                }

                if shortcut.key == Code::Comma && shortcut.mods == Modifiers::META {
                    let app = app.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Settings { page: None }.show(&app).await;
                    });
                }

                let state = app.state::<HotkeysState>();
                let store = state.lock().unwrap();

                for (action, hotkey) in &store.hotkeys {
                    if &Shortcut::from(*hotkey) == shortcut {
                        tokio::spawn(handle_hotkey(app.clone(), *action));
                    }
                }
            })
            .build(),
    )
    .unwrap();

    let store = match HotkeysStore::get(app) {
        Ok(Some(s)) => s,
        Ok(None) => HotkeysStore::default(),
        Err(e) => {
            eprintln!("Failed to load hotkeys store: {e}");
            HotkeysStore::default()
        }
    };

    let global_shortcut = app.global_shortcut();
    for (action, hotkey) in store.hotkeys.iter() {
        // A shortcut stored on a previous run can stop being registrable, e.g.
        // another application claimed it since. Surface it in the log rather
        // than starting up with a binding the user believes is active.
        if let Err(e) = global_shortcut.register(Shortcut::from(*hotkey)) {
            tracing::warn!(?action, ?hotkey, "failed to register stored hotkey: {e}");
        }
    }

    app.manage(Mutex::new(store));
}

async fn handle_hotkey(app: AppHandle, action: HotkeyAction) -> Result<(), String> {
    match action {
        HotkeyAction::StartStudioRecording => {
            start_recording_from_hotkey(app, cap_recording::RecordingMode::Studio).await
        }
        HotkeyAction::StartInstantRecording => {
            start_recording_from_hotkey(app, cap_recording::RecordingMode::Instant).await
        }
        HotkeyAction::StopRecording => recording::stop_recording(app.clone(), app.state()).await,
        HotkeyAction::RestartRecording => recording::restart_recording(app.clone(), app.state())
            .await
            .map(|_| ()),
        HotkeyAction::TogglePauseRecording => {
            recording::toggle_pause_recording(app.clone(), app.state()).await
        }
        HotkeyAction::CycleRecordingMode => {
            let current = RecordingSettingsStore::get(&app)
                .ok()
                .flatten()
                .and_then(|s| s.mode)
                .unwrap_or_default();

            let next = match current {
                cap_recording::RecordingMode::Studio => cap_recording::RecordingMode::Instant,
                cap_recording::RecordingMode::Instant => cap_recording::RecordingMode::Screenshot,
                cap_recording::RecordingMode::Screenshot => cap_recording::RecordingMode::Studio,
            };

            RecordingSettingsStore::set_mode(&app, next)
                .map_err(|e| format!("Failed to cycle mode: {e}"))?;

            tray::update_tray_icon_for_mode(&app, next);

            Ok(())
        }
        HotkeyAction::OpenRecordingPicker => {
            let _ = RequestOpenRecordingPicker { target_mode: None }.emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerDisplay => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Display),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerWindow => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Window),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::OpenRecordingPickerArea => {
            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Area),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::ScreenshotDisplay => {
            use scap_targets::Display;

            let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
            let target = ScreenCaptureTarget::Display { id: display.id() };

            match recording::take_screenshot(app.clone(), target.clone()).await {
                Ok(path) => {
                    if crate::automation::should_open_screenshot_editor(&app, &target) {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                    }
                    Ok(())
                }
                Err(e) => Err(format!("Failed to take screenshot: {e}")),
            }
        }
        HotkeyAction::ScreenshotWindow => {
            use scap_targets::Window;

            let target = {
                let window = Window::get_topmost_at_cursor()
                    .ok_or_else(|| "No window found under cursor".to_string())?;
                ScreenCaptureTarget::Window { id: window.id() }
            };

            match recording::take_screenshot(app.clone(), target.clone()).await {
                Ok(path) => {
                    if crate::automation::should_open_screenshot_editor(&app, &target) {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(&app).await;
                    }
                    Ok(())
                }
                Err(e) => Err(format!("Failed to take screenshot: {e}")),
            }
        }
        HotkeyAction::ScreenshotArea => {
            RecordingSettingsStore::set_mode(&app, cap_recording::RecordingMode::Screenshot)
                .map_err(|e| format!("Failed to set screenshot mode: {e}"))?;

            tray::update_tray_icon_for_mode(&app, cap_recording::RecordingMode::Screenshot);

            let _ = RequestOpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Area),
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::Other => Ok(()),
    }
}

#[tauri::command(async)]
#[specta::specta]
#[instrument(skip(app))]
pub fn set_hotkey(
    app: AppHandle,
    action: HotkeyAction,
    hotkey: Option<Hotkey>,
) -> Result<(), String> {
    let global_shortcut = app.global_shortcut();
    let state = app.state::<HotkeysState>();
    let mut store = state.lock().unwrap();

    let prev = store.hotkeys.get(&action).cloned();

    // Apply to the store first so the "is this combination still used by
    // another action?" check below sees the post-change state, then reconcile
    // the OS registrations.
    if let Some(hotkey) = hotkey {
        store.hotkeys.insert(action, hotkey);
    } else {
        store.hotkeys.remove(&action);
    }

    // Release the previous combination before registering the new one: the
    // underlying global-hotkey layer rejects a shortcut that is already
    // registered, so re-binding an action to a combination another action just
    // gave up would otherwise fail.
    if let Some(prev) = prev
        && !store.hotkeys.values().any(|h| h == &prev)
    {
        if let Err(e) = global_shortcut.unregister(Shortcut::from(prev)) {
            // Not fatal on its own; log it so a stale registration that keeps
            // firing the old combination is diagnosable.
            tracing::warn!(?action, prev = ?prev, "failed to unregister previous hotkey: {e}");
        }
    }

    if let Some(hotkey) = hotkey {
        // The OS can refuse a shortcut: reserved by the system (PrintScreen on
        // Windows) or already claimed by another application. Previously this
        // was `.ok()`, so the binding was stored and shown in Settings while
        // pressing it did nothing.
        if let Err(e) = global_shortcut.register(Shortcut::from(hotkey)) {
            tracing::warn!(?action, ?hotkey, "failed to register hotkey: {e}");

            // Roll the store back so it matches what is actually registered.
            match prev {
                Some(prev) => {
                    store.hotkeys.insert(action, prev);
                    global_shortcut.register(Shortcut::from(prev)).ok();
                }
                None => {
                    store.hotkeys.remove(&action);
                }
            }

            return Err(format!(
                "Could not register this shortcut. It may already be in use by another application, or reserved by the system. ({e})"
            ));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::should_confirm_without_microphone;

    #[test]
    fn confirms_when_enabled_without_microphone() {
        assert!(should_confirm_without_microphone(true, false));
    }

    #[test]
    fn skips_confirmation_with_selected_microphone() {
        assert!(!should_confirm_without_microphone(true, true));
    }

    #[test]
    fn skips_confirmation_when_disabled() {
        assert!(!should_confirm_without_microphone(false, false));
    }
}
