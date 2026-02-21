use cap_recording::{
    RecordingMode,
    feeds::camera::DeviceOrModelID,
    sources::screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{
    App,
    ArcLock,
    recording::StartRecordingInputs,
    recording_settings::RecordingSettingsStore,
    windows::ShowCapWindow,
    get_devices_snapshot,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    StartRecording {
        #[serde(default)]
        capture_mode: Option<CaptureMode>,
        #[serde(default)]
        camera: Option<DeviceOrModelID>,
        #[serde(default)]
        mic_label: Option<String>,
        #[serde(default)]
        capture_system_audio: Option<bool>,
        #[serde(default)]
        mode: Option<RecordingMode>,
    },
    StopRecording,
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    SetCamera {
        device_id: Option<DeviceOrModelID>,
    },
    SetMicrophone {
        label: Option<String>,
    },
    SwitchCamera,
    SwitchMicrophone,
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    trace!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| {
            DeepLinkAction::try_from(&url)
                .map_err(|e| match e {
                    ActionParseFromUrlError::ParseFailed(msg) => {
                        eprintln!("Failed to parse deep link \"{}\": {}", &url, msg)
                    }
                    ActionParseFromUrlError::Invalid => {
                        eprintln!("Invalid deep link format \"{}\"", &url)
                    }
                    _ => {}
                    ActionParseFromUrlError::NotAction => {}
                })
                .ok()
        })
        .collect();

    if actions.is_empty() {
        return;
    }

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        for action in actions {
            if let Err(e) = action.execute(&app_handle).await {
                eprintln!("Failed to handle deep link action: {e}");
            }
        }
    });
}

pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        #[cfg(target_os = "macos")]
        if url.scheme() == "file" {
            return Ok(Self::OpenEditor {
                project_path: url.to_file_path().unwrap(),
            });
        }

        match url.domain() {
            Some(v) if v != "action" => Err(ActionParseFromUrlError::NotAction),
            _ => Err(ActionParseFromUrlError::Invalid),
        }?;

        let params = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let json_value = params
            .get("value")
            .ok_or(ActionParseFromUrlError::Invalid)?;
        let action: Self = serde_json::from_str(json_value)
            .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))?;
        Ok(action)
    }
}

impl DeepLinkAction {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        match self {
            DeepLinkAction::StartRecording {
                capture_mode,
                camera,
                mic_label,
                capture_system_audio,
                mode,
            } => {
                let settings = match RecordingSettingsStore::get(app) {
                    Ok(Some(store)) => store,
                    Ok(None) => RecordingSettingsStore::default(),
                    Err(e) => {
                        tracing::warn!("Failed to read recording settings: {e}");
                        RecordingSettingsStore::default()
                    }
                };

                let camera = camera.or_else(|| settings.camera_id.clone());
                let mic_label = mic_label.or_else(|| settings.mic_name.clone());
                let capture_system_audio = capture_system_audio.unwrap_or(settings.system_audio);
                let mode = mode.unwrap_or_else(|| settings.mode.unwrap_or(RecordingMode::Instant));

                let capture_target: ScreenCaptureTarget = match capture_mode {
                    Some(CaptureMode::Screen(name)) => cap_recording::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    Some(CaptureMode::Window(name)) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or(format!("No window with name \"{}\"", &name))?,
                    None => settings
                        .target
                        .clone()
                        .unwrap_or_else(|| ScreenCaptureTarget::Display {
                            id: Display::primary().id(),
                        }),
                };

                let state = app.state::<ArcLock<App>>();

                crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
                crate::set_mic_input(state.clone(), mic_label).await?;

                let inputs = StartRecordingInputs {
                    mode,
                    capture_target,
                    capture_system_audio,
                    organization_id: settings.organization_id.clone(),
                };

                crate::recording::start_recording(app.clone(), state, inputs)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
            DeepLinkAction::PauseRecording => {
                crate::recording::pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::ResumeRecording => {
                crate::recording::resume_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::SetCamera { device_id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state.clone(), device_id, None).await
            }
            DeepLinkAction::SetMicrophone { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state.clone(), label).await
            }
            DeepLinkAction::SwitchCamera => {
                let state = app.state::<ArcLock<App>>();
                switch_to_next_camera(app.clone(), state.clone()).await
            }
            DeepLinkAction::SwitchMicrophone => {
                let state = app.state::<ArcLock<App>>();
                switch_to_next_microphone(state.clone()).await
            }
        }
    }
}

async fn switch_to_next_camera(app: AppHandle, state: ArcLock<App>) -> Result<(), String> {
    let devices = get_devices_snapshot().await;
    if devices.cameras.is_empty() {
        return Err("No cameras available".to_string());
    }

    let current_camera = {
        let app = state.read().await;
        app.selected_camera_id.clone()
    };

    let current_index = current_camera.as_ref().and_then(|current_id| {
        devices.cameras.iter().position(|camera| {
            match current_id {
                cap_recording::feeds::camera::DeviceOrModelID::DeviceID(device_id) => {
                    camera.device_id() == device_id
                }
                cap_recording::feeds::camera::DeviceOrModelID::ModelID(model_id) => {
                    camera.model_id().is_some_and(|existing| existing == *model_id)
                }
            }
        })
    });

    let next_index = match current_index {
        Some(idx) => (idx + 1) % devices.cameras.len(),
        None => 0,
    };

    let next_camera = &devices.cameras[next_index];
    let next_device_id = cap_recording::feeds::camera::DeviceOrModelID::DeviceID(
        next_camera.device_id().to_string()
    );

    crate::set_camera_input(app, state, Some(next_device_id), None).await
}

async fn switch_to_next_microphone(state: ArcLock<App>) -> Result<(), String> {
    let devices = get_devices_snapshot().await;
    if devices.microphones.is_empty() {
        return Err("No microphones available".to_string());
    }

    let current_mic = {
        let app = state.read().await;
        app.selected_mic_label.clone()
    };

    let current_index = current_mic.as_ref().and_then(|current_label| {
        devices.microphones.iter().position(|mic| mic == current_label)
    });

    let next_index = match current_index {
        Some(idx) => (idx + 1) % devices.microphones.len(),
        None => 0,
    };

    let next_mic = &devices.microphones[next_index];
    crate::set_mic_input(state, Some(next_mic.clone())).await
}
