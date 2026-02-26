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

/// Response types for deeplink queries
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct RecordingStatusResponse {
    pub is_recording: bool,
    pub is_paused: bool,
    pub mode: Option<RecordingMode>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct DisplayInfo {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WindowInfo {
    pub name: String,
    pub owner_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct AudioDeviceInfo {
    pub label: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct CameraInfo {
    pub name: String,
    pub id: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    /// Start a new recording
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    /// Stop the current recording
    StopRecording,
    /// Pause the current recording
    PauseRecording,
    /// Resume a paused recording
    ResumeRecording,
    /// Toggle pause state of the current recording
    TogglePause,
    /// Switch the microphone input
    SetMicrophone {
        label: Option<String>,
    },
    /// Switch the camera input
    SetCamera {
        device_id: Option<String>,
    },
    /// Take a screenshot
    TakeScreenshot,
    /// Open a project in the editor
    OpenEditor {
        project_path: PathBuf,
    },
    /// Open the settings window
    OpenSettings {
        page: Option<String>,
    },
    /// Show the main Cap window
    ShowMainWindow,
    /// List available displays
    ListDisplays,
    /// List available windows
    ListWindows,
    /// List available microphones
    ListMicrophones,
    /// List available cameras
    ListCameras,
    /// Get current recording status
    GetRecordingStatus,
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

                crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
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
            DeepLinkAction::TogglePause => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::SetMicrophone { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, label).await
            }
            DeepLinkAction::SetCamera { device_id } => {
                let state = app.state::<ArcLock<App>>();
                let camera_id = device_id.map(|id| DeviceOrModelID::DeviceID(id));
                crate::set_camera_input(app.clone(), state, camera_id, None).await
            }
            DeepLinkAction::TakeScreenshot => {
                // Take a screenshot of the primary display
                let displays = cap_recording::screen_capture::list_displays();
                if let Some((display, _)) = displays.into_iter().next() {
                    let target = ScreenCaptureTarget::Display { id: display.id };
                    crate::recording::take_screenshot(app.clone(), target)
                        .await
                        .map(|_| ())
                } else {
                    Err("No display found for screenshot".to_string())
                }
            }
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
            DeepLinkAction::ShowMainWindow => {
                crate::show_window(app.clone(), ShowCapWindow::Main { init_target_mode: None }).await
            }
            DeepLinkAction::ListDisplays => {
                let displays: Vec<DisplayInfo> = cap_recording::screen_capture::list_displays()
                    .into_iter()
                    .map(|(d, _)| DisplayInfo {
                        name: d.name.clone(),
                        id: format!("{:?}", d.id),
                    })
                    .collect();
                // Log for debugging; in practice this could be returned via a different mechanism
                trace!("Available displays: {:?}", displays);
                Ok(())
            }
            DeepLinkAction::ListWindows => {
                let windows: Vec<WindowInfo> = cap_recording::screen_capture::list_windows()
                    .into_iter()
                    .map(|(w, _)| WindowInfo {
                        name: w.name.clone(),
                        owner_name: w.owner_name.clone(),
                    })
                    .collect();
                trace!("Available windows: {:?}", windows);
                Ok(())
            }
            DeepLinkAction::ListMicrophones => {
                use cap_recording::feeds::microphone::MicrophoneFeed;
                let mics: Vec<AudioDeviceInfo> = MicrophoneFeed::list()
                    .keys()
                    .map(|label| AudioDeviceInfo {
                        label: label.clone(),
                    })
                    .collect();
                trace!("Available microphones: {:?}", mics);
                Ok(())
            }
            DeepLinkAction::ListCameras => {
                let cameras: Vec<CameraInfo> = cap_camera::list_cameras()
                    .map(|c| CameraInfo {
                        name: c.display_name().to_string(),
                        id: c.device_id().to_string(),
                    })
                    .collect();
                trace!("Available cameras: {:?}", cameras);
                Ok(())
            }
            DeepLinkAction::GetRecordingStatus => {
                let state = app.state::<ArcLock<App>>();
                let app_state = state.read().await;
                let status = match &app_state.recording_state {
                    crate::RecordingState::None => RecordingStatusResponse {
                        is_recording: false,
                        is_paused: false,
                        mode: None,
                    },
                    crate::RecordingState::Pending { mode, .. } => RecordingStatusResponse {
                        is_recording: false,
                        is_paused: false,
                        mode: Some(*mode),
                    },
                    crate::RecordingState::Active(recording) => {
                        let is_paused = recording.is_paused().await.unwrap_or(false);
                        RecordingStatusResponse {
                            is_recording: true,
                            is_paused,
                            mode: Some(recording.mode()),
                        }
                    }
                };
                trace!("Recording status: {:?}", status);
                Ok(())
            }
        }
    }
}
