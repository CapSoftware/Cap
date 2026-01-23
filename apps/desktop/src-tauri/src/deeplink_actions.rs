use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

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
    TakeScreenshot {
        capture_target: ScreenCaptureTarget,
    },
    SetCamera {
        id: Option<DeviceOrModelID>,
    },
    SetMicrophone {
        label: Option<String>,
    },
    ListCameras,
    ListMicrophones,
    ListDisplays,
    ListWindows,
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

                let capture_target: ScreenCaptureTarget = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or(format!("No window with name \"{}\"", &name))?,
                };

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
            DeepLinkAction::TakeScreenshot { capture_target } => {
                crate::recording::take_screenshot(app.clone(), capture_target)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::SetCamera { id } => {
                crate::set_camera_input(app.clone(), app.state(), id).await
            }
            DeepLinkAction::SetMicrophone { label } => {
                crate::set_mic_input(app.state(), label).await
            }
            DeepLinkAction::ListCameras => {
                let cameras = crate::recording::list_cameras();
                let cameras_json = serde_json::to_string(&cameras)
                    .map_err(|e| format!("Failed to serialize cameras: {}", e))?;
                tracing::info!("Available cameras: {}", cameras_json);
                Ok(())
            }
            DeepLinkAction::ListMicrophones => {
                use cap_recording::feeds::microphone::MicrophoneFeed;
                let microphones: Vec<String> = MicrophoneFeed::list().keys().cloned().collect();
                let mics_json = serde_json::to_string(&microphones)
                    .map_err(|e| format!("Failed to serialize microphones: {}", e))?;
                tracing::info!("Available microphones: {}", mics_json);
                Ok(())
            }
            DeepLinkAction::ListDisplays => {
                let displays = cap_recording::screen_capture::list_displays();
                let displays_data: Vec<_> = displays
                    .into_iter()
                    .map(|(capture_display, _)| {
                        serde_json::json!({
                            "id": capture_display.id,
                            "name": capture_display.name,
                        })
                    })
                    .collect();
                let displays_json = serde_json::to_string(&displays_data)
                    .map_err(|e| format!("Failed to serialize displays: {}", e))?;
                tracing::info!("Available displays: {}", displays_json);
                Ok(())
            }
            DeepLinkAction::ListWindows => {
                let windows = cap_recording::screen_capture::list_windows();
                let windows_data: Vec<_> = windows
                    .into_iter()
                    .map(|(capture_window, _)| {
                        serde_json::json!({
                            "id": capture_window.id,
                            "name": capture_window.name,
                        })
                    })
                    .collect();
                let windows_json = serde_json::to_string(&windows_data)
                    .map_err(|e| format!("Failed to serialize windows: {}", e))?;
                tracing::info!("Available windows: {}", windows_json);
                Ok(())
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
