use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize, Type, Default)]
pub struct GeneralSettingsStore {
    #[serde(default)]
    pub upload_individual_files: bool,
    #[serde(default)]
    pub open_editor_after_recording: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub auto_create_shareable_link: bool,
    #[serde(default = "default_enable_notifications")]
    pub enable_notifications: bool,
}

fn default_enable_notifications() -> bool {
    true
}

impl GeneralSettingsStore {
    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.get_store("store").map(|s| s.get("general_settings")) {
            Some(Some(store)) => {
                // Handle potential deserialization errors gracefully
                match serde_json::from_value(store) {
                    Ok(settings) => Ok(Some(settings)),
                    Err(_) => Ok(Some(GeneralSettingsStore::default())),
                }
            }
            _ => Ok(None),
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
    // Use unwrap_or_default() to handle potential errors gracefully
    let store = GeneralSettingsStore::get(app)
        .unwrap_or(None)
        .unwrap_or_default();
    app.manage(GeneralSettingsState::new(store));
    println!("GeneralSettingsState managed");
}
