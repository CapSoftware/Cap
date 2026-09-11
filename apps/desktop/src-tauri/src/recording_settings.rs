use cap_recording::{
    RecordingMode,
    feeds::{
        camera::{CameraDeviceSettings, DeviceOrModelID},
        microphone::MicrophoneDeviceSettings,
    },
    sources::screen_capture::ScreenCaptureTarget,
};
use std::collections::HashMap;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_store::StoreExt;

use crate::tray;

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RecordingTargetMode {
    Display,
    Window,
    Area,
    Camera,
}

#[derive(serde::Serialize, serde::Deserialize, specta::Type, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordingSettingsStore {
    pub target: Option<ScreenCaptureTarget>,
    pub mic_name: Option<String>,
    #[serde(deserialize_with = "deserialize_camera_id")]
    pub camera_id: Option<DeviceOrModelID>,
    pub mode: Option<RecordingMode>,
    pub system_audio: bool,
    pub organization_id: Option<String>,
    pub camera_device_settings: HashMap<String, CameraDeviceSettings>,
    pub microphone_device_settings: HashMap<String, MicrophoneDeviceSettings>,
}

fn deserialize_camera_id<'de, D>(deserializer: D) -> Result<Option<DeviceOrModelID>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;
    match serde_json::from_value(value) {
        Ok(camera_id) => Ok(camera_id),
        Err(error) => {
            tracing::warn!(%error, "Ignoring invalid saved camera selection");
            Ok(None)
        }
    }
}

impl RecordingSettingsStore {
    const KEY: &'static str = "recording_settings";

    pub fn get(app: &AppHandle<Wry>) -> Result<Option<Self>, String> {
        match app.store("store").map(|s| s.get(Self::KEY)) {
            Ok(Some(store)) => match serde_json::from_value(store) {
                Ok(settings) => Ok(Some(settings)),
                Err(e) => Err(format!(
                    "Failed to deserialize recording settings store: {e}"
                )),
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

    pub fn camera_settings_for(
        app: &AppHandle<Wry>,
        id: &DeviceOrModelID,
    ) -> Option<CameraDeviceSettings> {
        Self::get(app).ok().flatten().and_then(|settings| {
            settings
                .camera_device_settings
                .get(&camera_key(id))
                .copied()
        })
    }

    pub fn microphone_settings_for(
        app: &AppHandle<Wry>,
        label: &str,
    ) -> Option<MicrophoneDeviceSettings> {
        Self::get(app)
            .ok()
            .flatten()
            .and_then(|settings| settings.microphone_device_settings.get(label).copied())
    }
}

pub fn camera_key(id: &DeviceOrModelID) -> String {
    match id {
        DeviceOrModelID::DeviceID(device_id) => format!("device:{device_id}"),
        DeviceOrModelID::ModelID(model_id) => format!("model:{model_id}"),
    }
}

#[tauri::command]
#[specta::specta]
pub fn set_recording_mode(app: AppHandle, mode: RecordingMode) -> Result<(), String> {
    RecordingSettingsStore::set_mode(&app, mode)?;
    tray::update_tray_icon_for_mode(&app, mode);

    // A mode switch invalidates any pending "restore this overlay when
    // Settings closes" instruction — otherwise a stale label can pop the
    // target-select overlay back up as a screen-wide input-eating surface
    // after the user has moved on to a different mode. See #1945.
    if let Some(focus_manager) = app.try_state::<crate::target_select_overlay::WindowFocusManager>()
    {
        focus_manager.clear_overlay_restore_labels();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::RecordingSettingsStore;
    use serde_json::json;

    #[test]
    fn invalid_camera_selection_preserves_other_recording_preferences() {
        for camera_id in [
            json!({"DeviceID": "camera-a", "ModelID": "046d:08e5"}),
            json!({"ModelID": "missing-separator"}),
            json!({"DeviceID": 123}),
            json!({"unknown": "camera-a"}),
            json!({}),
            json!("camera-a"),
        ] {
            let mut saved = json!({
                "target": {"variant": "cameraOnly"},
                "micName": "Saved microphone",
                "cameraId": camera_id,
                "mode": "studio",
                "systemAudio": true,
                "organizationId": "saved-organization",
                "cameraDeviceSettings": {
                    "model:046d:08e5": {"width": 1280, "height": 720, "frameRate": 60.0}
                },
                "microphoneDeviceSettings": {
                    "Saved microphone": {"sampleRate": 48000, "channels": 1}
                }
            });
            let settings: RecordingSettingsStore = serde_json::from_value(saved.clone()).unwrap();
            assert!(settings.camera_id.is_none());
            saved["cameraId"] = serde_json::Value::Null;
            assert_eq!(serde_json::to_value(settings).unwrap(), saved);
        }
    }

    #[test]
    fn valid_camera_variants_and_none_round_trip() {
        for camera_id in [
            json!({"DeviceID": "camera-a"}),
            json!({"ModelID": "046d:08e5"}),
            serde_json::Value::Null,
        ] {
            let settings: RecordingSettingsStore =
                serde_json::from_value(json!({"cameraId": camera_id})).unwrap();
            assert_eq!(
                serde_json::to_value(settings).unwrap()["cameraId"],
                camera_id
            );
        }
        let settings: RecordingSettingsStore = serde_json::from_value(json!({})).unwrap();
        assert!(settings.camera_id.is_none());
    }
}
