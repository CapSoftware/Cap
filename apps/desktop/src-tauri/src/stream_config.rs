use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

#[derive(Default, Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamConfigStore {
    pub server_url: String,
    pub stream_key: String,
    pub preset_index: Option<u32>,
}

impl StreamConfigStore {
    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get("stream_config")) {
            Ok(Some(store)) => serde_json::from_value(store).map(Some).map_err(|e| e.to_string()),
            _ => Ok(None),
        }
    }

    pub fn set(app: &AppHandle<Wry>, value: Option<Self>) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        store.set("stream_config", json!(value));
        store.save().map_err(|e| e.to_string())
    }
}
