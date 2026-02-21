use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{
    App, ArcLock, feeds::microphone::MicrophoneFeed, recording::StartRecordingInputs,
    windows::ShowCapWindow,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeepLinkRecordingStatus {
    pub is_recording: bool,
    pub is_paused: bool,
    pub recording_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeepLinkDevices {
    pub cameras: Vec<DeepLinkCamera>,
    pub microphones: Vec<String>,
    pub screens: Vec<DeepLinkScreen>,
    pub windows: Vec<DeepLinkWindow>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeepLinkCamera {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeepLinkScreen {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DeepLinkWindow {
    pub name: String,
    pub owner_name: String,
}

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
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    StopRecording,
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    RestartRecording,
    TakeScreenshot {
        capture_mode: CaptureMode,
    },
    SetMicrophone {
        label: Option<String>,
    },
    SetCamera {
        id: Option<DeviceOrModelID>,
    },
    ListDevices,
    GetStatus,
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
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
                    // Likely login action, not handled here.
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

fn resolve_capture_target(capture_mode: &CaptureMode) -> Result<ScreenCaptureTarget, String> {
    match capture_mode {
        CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|(s, _)| s.name == *name)
            .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
            .ok_or_else(|| format!("No screen with name \"{}\"", name)),
        CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|(w, _)| w.name == *name)
            .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
            .ok_or_else(|| format!("No window with name \"{}\"", name)),
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
                let state = app.state::<ArcLock<App>>();

                crate::set_camera_input(app.clone(), state.clone(), camera).await?;
                crate::set_mic_input(state.clone(), mic_label).await?;

                let capture_target = resolve_capture_target(&capture_mode)?;

                let inputs = StartRecordingInputs {
                    mode,
                    capture_target,
                    capture_system_audio,
                    organization_id: None,
                };

                crate::recording::start_recording(app.clone(), state, inputs)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
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
            DeepLinkAction::RestartRecording => {
                crate::recording::restart_recording(app.clone(), app.state())
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let capture_target = resolve_capture_target(&capture_mode)?;

                crate::recording::take_screenshot(app.clone(), capture_target)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::SetMicrophone { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, label).await
            }
            DeepLinkAction::SetCamera { id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, id).await
            }
            DeepLinkAction::ListDevices => {
                let devices = get_available_devices();
                write_deeplink_response(app, &devices)
            }
            DeepLinkAction::GetStatus => {
                let state = app.state::<ArcLock<App>>();
                let app_state = state.read().await;
                let status = if let Some(recording) = app_state.current_recording() {
                    let is_paused = recording.is_paused().await.unwrap_or(false);
                    let mode = match recording {
                        crate::recording::InProgressRecording::Instant { .. } => {
                            Some("instant".to_string())
                        }
                        crate::recording::InProgressRecording::Studio { .. } => {
                            Some("studio".to_string())
                        }
                    };
                    DeepLinkRecordingStatus {
                        is_recording: true,
                        is_paused,
                        recording_mode: mode,
                    }
                } else {
                    DeepLinkRecordingStatus {
                        is_recording: false,
                        is_paused: false,
                        recording_mode: None,
                    }
                };
                write_deeplink_response(app, &status)
            }
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
        }
    }
}

fn write_deeplink_response<T: Serialize>(app: &AppHandle, data: &T) -> Result<(), String> {
    let response_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {e}"))?;

    std::fs::create_dir_all(&response_dir)
        .map_err(|e| format!("Failed to create app data dir: {e}"))?;

    let response_path = response_dir.join("deeplink-response.json");
    let temp_path = response_dir.join("deeplink-response.json.tmp");

    let json = serde_json::to_string(data).map_err(|e| e.to_string())?;

    // Atomic write: write to temp file, then rename
    std::fs::write(&temp_path, &json).map_err(|e| format!("Failed to write response file: {e}"))?;
    let _ = std::fs::remove_file(&response_path);
    std::fs::rename(&temp_path, &response_path)
        .map_err(|e| format!("Failed to rename response file: {e}"))?;

    trace!("Wrote deeplink response to {:?}", response_path);
    Ok(())
}

fn get_available_devices() -> DeepLinkDevices {
    let cameras: Vec<DeepLinkCamera> = cap_camera::list_cameras()
        .map(|c| DeepLinkCamera {
            name: c.display_name().to_string(),
            id: c.device_id().to_string(),
        })
        .collect();

    let microphones: Vec<String> = MicrophoneFeed::list().keys().cloned().collect();

    let screens: Vec<DeepLinkScreen> = cap_recording::screen_capture::list_displays()
        .into_iter()
        .map(|(s, _)| DeepLinkScreen {
            name: s.name,
            id: s.id.to_string(),
        })
        .collect();

    let windows: Vec<DeepLinkWindow> = cap_recording::screen_capture::list_windows()
        .into_iter()
        .map(|(w, _)| DeepLinkWindow {
            name: w.name,
            owner_name: w.owner_name,
        })
        .collect();

    DeepLinkDevices {
        cameras,
        microphones,
        screens,
        windows,
    }
}
