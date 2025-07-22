use crate::{RequestStartRecording, recording};
use global_hotkey::HotKeyState;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_store::StoreExt;
use tauri_specta::Event;

#[derive(Serialize, Deserialize, Type, PartialEq, Clone, Copy)]
pub struct Hotkey {
    #[specta(type = String)]
    code: Code,
    meta: bool,
    ctrl: bool,
    alt: bool,
    shift: bool,
}

impl Hotkey {
    fn to_shortcut(&self) -> Shortcut {
        let mut modifiers = Modifiers::empty();

        if self.meta {
            modifiers |= Modifiers::META;
        }
        if self.ctrl {
            modifiers |= Modifiers::CONTROL;
        }
        if self.alt {
            modifiers |= Modifiers::ALT;
        }
        if self.shift {
            modifiers |= Modifiers::SHIFT;
        }

        Shortcut::new(Some(modifiers), self.code)
    }
}

#[derive(Serialize, Deserialize, Type, PartialEq, Eq, Hash, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    StartRecording,
    StopRecording,
    RestartRecording,
    // TakeScreenshot,
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

pub type HotkeysState = Mutex<HotkeysStore>;
pub fn init(app: &AppHandle) {
    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, shortcut, event| {
                if !matches!(event.state(), HotKeyState::Pressed) {
                    return;
                }

                let state = app.state::<HotkeysState>();
                let store = state.lock().unwrap();

                for (action, hotkey) in &store.hotkeys {
                    if &hotkey.to_shortcut() == shortcut {
                        tokio::spawn(handle_hotkey(app.clone(), *action));
                    }
                }
            })
            .build(),
    )
    .unwrap();

    let store = HotkeysStore::get(app).unwrap().unwrap_or_default();

    let global_shortcut = app.global_shortcut();

    for hotkey in store.hotkeys.values() {
        global_shortcut.register(hotkey.to_shortcut()).ok();
    }

    app.manage(Mutex::new(store));
}

async fn handle_hotkey(app: AppHandle, action: HotkeyAction) -> Result<(), String> {
    match action {
        HotkeyAction::StartRecording => {
            let _ = RequestStartRecording.emit(&app);
            Ok(())
        }
        HotkeyAction::StopRecording => recording::stop_recording(app.clone(), app.state()).await,
        HotkeyAction::RestartRecording => {
            recording::restart_recording(app.clone(), app.state()).await
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
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

    if let Some(prev) = prev {
        if !store.hotkeys.values().any(|h| h == &prev) {
            global_shortcut.unregister(prev.to_shortcut()).ok();
        }
    }

    if let Some(hotkey) = hotkey {
        global_shortcut.register(hotkey.to_shortcut()).ok();
    }

    Ok(())
}
