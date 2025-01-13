mod configuration;
mod cursor;
mod meta;

pub use configuration::*;
pub use cursor::*;
pub use meta::*;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub resolution: Resolution,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Resolution {
    pub width: u32,
    pub height: u32,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            fps: 30,
            resolution: Resolution {
                width: 1920,
                height: 1080,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct GeneralSettingsStore {
    #[serde(default)]
    pub recording_config: Option<RecordingConfig>,
}

impl GeneralSettingsStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        match app.get_store("store").map(|s| s.get("general_settings")) {
            Some(Some(store)) => match serde_json::from_value(store) {
                Ok(settings) => Ok(Some(settings)),
                Err(_) => Ok(Some(GeneralSettingsStore::default())),
            },
            _ => Ok(None),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let store = app.get_store("store").ok_or("Store not found")?;
        store.set("general_settings", serde_json::json!(self));
        store.save().map_err(|e| e.to_string())
    }
}

impl Default for GeneralSettingsStore {
    fn default() -> Self {
        Self {
            recording_config: Some(RecordingConfig::default()),
        }
    }
}
