use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use tauri::{AppHandle, Wry};
use tauri_plugin_store::StoreExt;

use crate::tray;

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
            Ok(Some(store)) => match serde_json::from_value(store) {
                Ok(settings) => Ok(Some(settings)),
                Err(e) => Err(format!("Failed to deserialize general settings store: {e}")),
            },
            _ => Ok(None),
        }
    }

    pub fn set_mode(app: &AppHandle<Wry>, mode: RecordingMode) -> Result<(), String> {
        let store = app.store("store").map_err(|e| e.to_string())?;

        let mut settings = Self::get(app)?.unwrap_or_default();
        settings.mode = Some(mode);

        store.set(Self::KEY, serde_json::json!(settings));
        store.save().map_err(|e| e.to_string())
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_recording_mode(app: AppHandle, mode: RecordingMode) -> Result<(), String> {
    RecordingSettingsStore::set_mode(&app, mode)?;
    tray::update_tray_icon_for_mode(&app, mode);
    Ok(())
}
