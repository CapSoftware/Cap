use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::{with_store, StoreCollection};

#[derive(Serialize, Deserialize, Type)]
pub struct AuthStore {
    pub token: String,
    pub expires: i32,
}

impl AuthStore {
    pub fn get(app: &AppHandle) -> Result<Option<Self>, String> {
        let stores = app
            .try_state::<StoreCollection<Wry>>()
            .ok_or("Store not found")?;
        with_store(app.clone(), stores, "store", |store| {
            let Some(store) = store.get("auth").cloned() else {
                return Ok(None);
            };

            Ok(serde_json::from_value(store)?)
        })
        .map_err(|e| e.to_string())
    }
}
