use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{with_store, StoreCollection};

#[derive(Serialize, Deserialize, Type, Default)]
pub struct GeneralSettingsStore {
    pub upload_individual_files: bool,
    pub open_editor_after_recording: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub auto_create_shareable_link: bool,
}

impl GeneralSettingsStore {
    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        println!("Attempting to get GeneralSettingsStore");
        let stores = app
            .try_state::<StoreCollection<Wry>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            let Some(store) = store.get("general_settings").cloned() else {
                println!("No general_settings found in store");
                return Ok(None);
            };

            println!("Found general_settings in store");
            Ok(serde_json::from_value(store)?)
        })
        .map_err(|e| {
            println!("Error getting GeneralSettingsStore: {}", e);
            e.to_string()
        })
    }

    pub fn set(app: &AppHandle, settings: Self) -> Result<(), String> {
        println!("Attempting to set GeneralSettingsStore");
        let stores = app
            .try_state::<StoreCollection<Wry>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            store.insert("general_settings".to_string(), json!(settings))?;
            store.save()
        })
        .map_err(|e| {
            println!("Error setting GeneralSettingsStore: {}", e);
            e.to_string()
        })
    }
}

pub type GeneralSettingsState = Mutex<GeneralSettingsStore>;

pub fn init(app: &AppHandle) {
    println!("Initializing GeneralSettingsStore");
    let store = GeneralSettingsStore::get(app).unwrap().unwrap_or_default();
    app.manage(GeneralSettingsState::new(store));
    println!("GeneralSettingsState managed");
}
