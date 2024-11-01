use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize, Type, Default)]
pub struct GeneralSettingsStore {
    pub upload_individual_files: bool,
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
        let Some(Some(store)) = app.get_store("store").map(|s| s.get("general_settings")) else {
            return Ok(None);
        };

        serde_json::from_value(store).map_err(|e| e.to_string())
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
