use crate::{
    RequestOpenRecordingPicker, RequestStartRecording, recording,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    tray,
    windows::ShowCapWindow,
};
use global_hotkey::HotKeyState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
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
    CycleRecordingMode,
    OpenRecordingPicker,
    OpenRecordingPickerDisplay,
    OpenRecordingPickerWindow,
    OpenRecordingPickerArea,
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
    for hotkey in store.hotkeys.values() {
        global_shortcut.register(Shortcut::from(*hotkey)).ok();
    }

    app.manage(Mutex::new(store));
}

async fn handle_hotkey(app: AppHandle, action: HotkeyAction) -> Result<(), String> {
    match action {
        HotkeyAction::StartStudioRecording => {
            let _ = RequestStartRecording {
                mode: cap_recording::RecordingMode::Studio,
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::StartInstantRecording => {
            let _ = RequestStartRecording {
                mode: cap_recording::RecordingMode::Instant,
            }
            .emit(&app);
            Ok(())
        }
        HotkeyAction::StopRecording => recording::stop_recording(app.clone(), app.state()).await,
        HotkeyAction::RestartRecording => recording::restart_recording(app.clone(), app.state())
            .await
            .map(|_| ()),
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
        HotkeyAction::Other => Ok(()),
    }
}

#[tauri::command(async)]
#[specta::specta]
#[instrument(skip(app))]
pub fn set_hotkey(app: AppHandle, action: HotkeyAction, hotkey: Option<Hotkey>) -> Result<(), ()> {
    let global_shortcut = app.global_shortcut();
    let state = app.state::<HotkeysState>();
    let mut store = state.lock().unwrap();

    let prev = store.hotkeys.get(&action).cloned();

    if let Some(hotkey) = hotkey {
        store.hotkeys.insert(action, hotkey);
    } else {
        store.hotkeys.remove(&action);
    }

    if let Some(prev) = prev
        && !store.hotkeys.values().any(|h| h == &prev)
    {
        global_shortcut.unregister(Shortcut::from(prev)).ok();
    }

    if let Some(hotkey) = hotkey {
        global_shortcut.register(Shortcut::from(hotkey)).ok();
    }

    Ok(())
}
