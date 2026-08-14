use crate::{
    App, ArcLock, RequestOpenRecordingPicker, RequestStartRecording, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    tray,
    windows::ShowCapWindow,
};
use cap_desktop_runtime::Event;
use cap_desktop_runtime::{AppHandle, Manager};
use cap_recording::feeds::microphone::MicrophoneFeed;
use cap_recording::screen_capture::ScreenCaptureTarget;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Mutex;
use tracing::instrument;

#[derive(Serialize, Deserialize, Type, PartialEq, Clone, Debug)]
pub struct Hotkey {
    #[specta(type = String)]
    code: String,
    meta: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl Hotkey {
    fn accelerator(&self) -> String {
        let mut parts = Vec::new();
        if self.meta {
            parts.push("CommandOrControl".to_string());
        }
        if self.ctrl && !self.meta {
            parts.push("Control".to_string());
        }
        if self.alt {
            parts.push("Alt".to_string());
        }
        if self.shift {
            parts.push("Shift".to_string());
        }
        let key = self
            .code
            .strip_prefix("Key")
            .or_else(|| self.code.strip_prefix("Digit"))
            .unwrap_or(&self.code);
        parts.push(key.to_string());
        parts.join("+")
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

#[derive(Serialize, Type, cap_desktop_runtime::Event, Debug, Clone)]
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

    app.native_request::<bool, _>(
        "dialog.confirm",
        serde_json::json!({
            "message": "This recording will not include your voice.",
            "title": "No microphone detected",
            "kind": "warning",
            "okLabel": "Record without microphone",
            "cancelLabel": "Cancel"
        }),
    )
    .await
    .unwrap_or(false)
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
    let store = match HotkeysStore::get(app) {
        Ok(Some(s)) => s,
        Ok(None) => HotkeysStore::default(),
        Err(e) => {
            eprintln!("Failed to load hotkeys store: {e}");
            HotkeysStore::default()
        }
    };

    app.manage(Mutex::new(store));
    sync_electron_hotkeys(app);

    let app_handle = app.clone();
    app.listen("hotkey://trigger", move |event| {
        let Ok(action) = serde_json::from_str::<HotkeyAction>(event.payload()) else {
            return;
        };
        tokio::spawn(handle_hotkey(app_handle.clone(), action));
    });
    let app_handle = app.clone();
    app.listen("hotkey://escape", move |_| {
        OnEscapePress.emit(&app_handle).ok();
    });
    let app_handle = app.clone();
    app.listen("hotkey://settings", move |_| {
        let app = app_handle.clone();
        tokio::spawn(async move {
            let _ = ShowCapWindow::Settings { page: None }.show(&app).await;
        });
    });
}

fn sync_electron_hotkeys(app: &AppHandle) {
    let state = app.state::<HotkeysState>();
    let store = state.lock().unwrap();
    let hotkeys = store
        .hotkeys
        .iter()
        .map(|(action, hotkey)| {
            serde_json::json!({
                "action": action,
                "accelerator": hotkey.accelerator()
            })
        })
        .collect::<Vec<_>>();
    let _ = app.native_operation(
        "hotkeys.configure",
        serde_json::json!({ "hotkeys": hotkeys }),
    );
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

#[cap_desktop_runtime::command(async)]
#[specta::specta]
#[instrument(skip(app))]
pub fn set_hotkey(app: AppHandle, action: HotkeyAction, hotkey: Option<Hotkey>) -> Result<(), ()> {
    let state = app.state::<HotkeysState>();
    let mut store = state.lock().unwrap();

    if let Some(hotkey) = hotkey {
        store.hotkeys.insert(action, hotkey);
    } else {
        store.hotkeys.remove(&action);
    }

    drop(store);
    sync_electron_hotkeys(&app);
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
