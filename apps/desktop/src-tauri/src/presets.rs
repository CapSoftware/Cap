use cap_project::{ProjectConfiguration, TimelineConfiguration};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;
use tracing::error;

#[derive(Serialize, Deserialize, Type, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PresetsStore {
    presets: Vec<Preset>,
    default: Option<u32>,
}

#[derive(Serialize, Deserialize, Type, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Preset {
    name: String,
    pub config: ProjectConfiguration,
}

impl PresetsStore {
    fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get("presets")) {
            Ok(Some(store)) => {
                // Handle potential deserialization errors gracefully
                match serde_json::from_value(store) {
                    Ok(settings) => Ok(Some(settings)),
                    Err(_) => {
                        error!("Failed to deserialize presets store");
                        Ok(None)
                    }
                }
            }
            _ => Ok(None),
        }
    }

    pub fn get_default_preset(app: &AppHandle<Wry>) -> Result<Option<Preset>, String> {
        let Some(this) = Self::get(app)? else {
            return Ok(None);
        };

        let Some(default_i) = this.default else {
            return Ok(None);
        };

        Ok(this.presets.get(default_i as usize).cloned())
    }

    #[allow(unused)]
    pub fn update(app: &AppHandle, update: impl FnOnce(&mut Self)) -> Result<(), String> {
        let Ok(store) = app.store("store") else {
            return Err("Store not found".to_string());
        };

        let mut settings = Self::get(app)?.unwrap_or_default();
        update(&mut settings);
        store.set("presets", json!(settings));
        store.save().map_err(|e| e.to_string())
    }
}

impl Preset {
    #[allow(unused)]
    fn resolve(&self, timeline: TimelineConfiguration) -> ProjectConfiguration {
        let mut ret = self.config.clone();
        ret.timeline = Some(timeline);
        ret
    }
}
