use cap_project::Resolution;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

#[derive(Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsStore {
    #[serde(default)]
    pub upload_individual_files: bool,
    #[serde(default)]
    pub open_editor_after_recording: bool,
    #[serde(default)]
    pub hide_dock_icon: bool,
    #[serde(default)]
    pub auto_create_shareable_link: bool,
    #[serde(default = "true_b")]
    pub enable_notifications: bool,
    #[serde(default)]
    pub disable_auto_open_links: bool,
    // first launch: store won't exist so show startup
    #[serde(default = "true_b")]
    pub has_completed_startup: bool,
    #[serde(default)]
    pub theme: AppTheme,
    #[serde(default)]
    pub recording_config: Option<RecordingConfig>,
}

#[derive(Default, Debug, Copy, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum AppTheme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingConfig {
    pub fps: u32,
    pub resolution: Resolution,
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

fn true_b() -> bool {
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

    // i don't trust anyone to not overwrite the whole store lols
    pub fn update(app: &AppHandle, update: impl FnOnce(&mut Self)) -> Result<(), String> {
        let Some(store) = app.get_store("store") else {
            return Err("Store not found".to_string());
        };

        let mut settings = Self::get(app)?.unwrap_or_default();
        update(&mut settings);
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

#[tauri::command]
#[specta::specta]
pub async fn get_recording_config(app: AppHandle) -> Result<RecordingConfig, String> {
    let settings = GeneralSettingsStore::get(&app)?;
    Ok(settings
        .and_then(|s| s.recording_config)
        .unwrap_or_default())
}

#[tauri::command]
#[specta::specta]
pub async fn set_recording_config(app: AppHandle, config: RecordingConfig) -> Result<(), String> {
    GeneralSettingsStore::update(&app, |settings| {
        settings.recording_config = Some(config);
    })
}
