use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RecordingTargetMode {
    Display,
    Window,
    Area,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSettingsStore {
    pub target: Option<ScreenCaptureTarget>,
    pub mic_name: Option<String>,
    pub camera_id: Option<DeviceOrModelID>,
    pub mode: Option<RecordingMode>,
    pub system_audio: bool,
    pub organization_id: Option<String>,
}

impl RecordingSettingsStore {
    const KEY: &'static str = "recording_settings";

    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get(Self::KEY)) {
            Ok(Some(store)) => {
                // Handle potential deserialization errors gracefully
                match serde_json::from_value(store) {
                    Ok(settings) => Ok(Some(settings)),
                    Err(e) => Err(format!("Failed to deserialize general settings store: {e}")),
                }
            }
            _ => Ok(None),
        }
    }

    // i don't trust anyone to not overwrite the whole store lols
    // pub fn update(app: &AppHandle, update: impl FnOnce(&mut Self)) -> Result<(), String> {
    //     let Ok(store) = app.store("store") else {
    //         return Err("Store not found".to_string());
    //     };

    //     let mut settings = Self::get(app)?.unwrap_or_default();
    //     update(&mut settings);
    //     store.set(Self::KEY, json!(settings));
    //     store.save().map_err(|e| e.to_string())
    // }

    // fn save(&self, app: &AppHandle) -> Result<(), String> {
    //     let Ok(store) = app.store("store") else {
    //         return Err("Store not found".to_string());
    //     };

    //     store.set(Self::KEY, json!(self));
    //     store.save().map_err(|e| e.to_string())
    // }
}
