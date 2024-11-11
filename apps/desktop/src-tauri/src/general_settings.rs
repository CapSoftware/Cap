use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsStore {
    pub hide_dock_icon: bool,
    pub has_completed_startup: bool,
    pub enable_notifications: bool,
    pub open_editor_after_recording: bool,
    pub auto_create_shareable_link: bool,
}

impl Default for GeneralSettingsStore {
    fn default() -> Self {
        Self {
            hide_dock_icon: false,
            enable_notifications: true,
            auto_create_shareable_link: false,
            open_editor_after_recording: true,
            has_completed_startup: false,
        }
    }
}

impl GeneralSettingsStore {
    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.get_store("store") {
            Some(store) => match store.get("general_settings") {
                Some(value) => {
                    // Try to deserialize existing settings
                    match serde_json::from_value(value) {
                        Ok(settings) => Ok(Some(settings)),
                        Err(_) => {
                            // If deserialization fails, return default settings
                            Ok(Some(Self::default()))
                        }
                    }
                }
                None => Ok(Some(Self::default())), // No settings found, return defaults
            },
            None => Ok(Some(Self::default())), // No store found, return defaults
        }
    }

    pub fn set(app: &AppHandle, settings: Self) -> Result<(), String> {
        let Some(store) = app.get_store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("general_settings", json!(settings));
        store.save().map_err(|e| e.to_string())
    }
}

pub type GeneralSettingsState = Mutex<GeneralSettingsStore>;

pub fn init(app: &AppHandle) {
    println!("Initializing GeneralSettingsStore");
    let store = GeneralSettingsStore::get(app).unwrap().unwrap_or_default();
    app.manage(GeneralSettingsState::new(store));
    println!("GeneralSettingsState managed");
}
