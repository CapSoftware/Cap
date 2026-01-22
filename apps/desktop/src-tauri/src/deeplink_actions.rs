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
    Primary,
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
    TogglePause,
    CycleMicrophone,
    CycleCamera,
    SwitchMicrophone {
        label: String,
    },
    SwitchCamera {
        id: DeviceOrModelID,
    },
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
                    CaptureMode::Primary => cap_recording::screen_capture::list_displays()
                        .first()
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or("No displays found".to_string())?,
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
                if let Some(recording) = app
                    .state::<ArcLock<App>>()
                    .read()
                    .await
                    .current_recording()
                {
                   recording.pause().await.map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            }
            DeepLinkAction::ResumeRecording => {
                if let Some(recording) = app
                    .state::<ArcLock<App>>()
                    .read()
                    .await
                    .current_recording()
                {
                   recording.resume().await.map_err(|e| e.to_string())
                } else {
                    Ok(())
                }
            }
            DeepLinkAction::TogglePause => {
                if let Some(recording) = app
                    .state::<ArcLock<App>>()
                    .read()
                    .await
                    .current_recording()
                {
                    if recording.is_paused().await.map_err(|e| e.to_string())? {
                        recording.resume().await.map_err(|e| e.to_string())
                    } else {
                        recording.pause().await.map_err(|e| e.to_string())
                    }
                } else {
                    Ok(())
                }
            }
            DeepLinkAction::SwitchMicrophone { label } => {
                crate::set_mic_input(app.state(), Some(label)).await
            }
            DeepLinkAction::SwitchCamera { id } => {
                crate::set_camera_input(app.clone(), app.state(), Some(id)).await
            }
            DeepLinkAction::CycleMicrophone => {
                use cap_recording::feeds::microphone::MicrophoneFeed;
                let mics = MicrophoneFeed::list();
                let mic_labels: Vec<&String> = mics.keys().collect();
                
                if mic_labels.is_empty() {
                    return Ok(());
                }

                // If no mic is selected (None), select the first one.
                // If the last one is selected, cycle to the first one.
                // Otherwise select the next one.
                
                let current_label = app.state::<ArcLock<App>>().read().await.selected_mic_label.clone();
                
                let next_label = match current_label {
                    Some(current) => {
                         if let Some(pos) = mic_labels.iter().position(|&l| *l == current) {
                             if pos + 1 < mic_labels.len() {
                                 Some(mic_labels[pos + 1].clone())
                             } else {
                                 Some(mic_labels[0].clone())
                             }
                         } else {
                             Some(mic_labels[0].clone())
                         }
                    }
                    None => Some(mic_labels[0].clone())
                };

                crate::set_mic_input(app.state(), next_label).await
            }
            DeepLinkAction::CycleCamera => {
                use cap_camera::list_cameras;
                let cameras: Vec<_> = list_cameras().collect();
                
                if cameras.is_empty() {
                    return Ok(());
                }

                let current_id = app.state::<ArcLock<App>>().read().await.selected_camera_id.clone();

                let next_id = match current_id {
                    Some(current) => {
                         if let Some(pos) = cameras.iter().position(|c| c.device_id() == &current) {
                             if pos + 1 < cameras.len() {
                                 Some(cameras[pos + 1].device_id().clone())
                             } else {
                                 Some(cameras[0].device_id().clone())
                             }
                         } else {
                             Some(cameras[0].device_id().clone())
                         }
                    }
                    None => Some(cameras[0].device_id().clone())
                };
                
                crate::set_camera_input(app.clone(), app.state(), next_id).await
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
