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
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    StopRecording,
    TakeScreenshot,
    SwitchMicrophone {
        mic_label: Option<String>,
    },
    SwitchCamera {
        camera: Option<DeviceOrModelID>,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
}

pub enum ActionParseFromUrlError {
    ParseFailed,
    Invalid,
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        if url.scheme() != "cap-desktop" {
            return Err(ActionParseFromUrlError::NotAction);
        }

        match url.domain() {
            Some("pause") => Ok(Self::PauseRecording),
            Some("resume") => Ok(Self::ResumeRecording),
            Some("toggle-pause") => Ok(Self::TogglePauseRecording),
            Some("stop") => Ok(Self::StopRecording),
            Some("screenshot") => Ok(Self::TakeScreenshot),
            Some("mic") => {
                let params = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
                let mic_label = params.get("name").map(|v| v.to_string());
                Ok(Self::SwitchMicrophone { mic_label })
            }
            Some("camera") => {
                let params = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
                let camera = params.get("id").map(|v| DeviceOrModelID::Device(v.to_string()));
                Ok(Self::SwitchCamera { camera })
            }
            _ => {
                if url.domain() == Some("action") {
                    let params = url.query_pairs().collect::<std::collections::HashMap<_, _>>();
                    let json_value = params.get("value").ok_or(ActionParseFromUrlError::Invalid)?;
                    let action: Self = serde_json::from_str(json_value)
                        .map_err(|_| ActionParseFromUrlError::ParseFailed)?;
                    Ok(action)
                } else {
                    Err(ActionParseFromUrlError::Invalid)
                }
            }
        }
    }
}

impl DeepLinkAction {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        trace!("Executing deep link action: {:?}", self);

        match self {
            Self::PauseRecording => {
                let state = app.state::<ArcLock<App>>();
                crate::recording::pause_recording(app.clone(), state.clone()).await?;
                let _ = ShowCapWindow::Main { init_target_mode: None }.show(app).await;
                Ok(())
            }
            Self::ResumeRecording => {
                let state = app.state::<ArcLock<App>>();
                crate::recording::resume_recording(app.clone(), state.clone()).await?;
                let _ = ShowCapWindow::Main { init_target_mode: None }.show(app).await;
                Ok(())
            }
            Self::TogglePauseRecording => {
                let state = app.state::<ArcLock<App>>();
                crate::recording::toggle_pause_recording(app.clone(), state.clone()).await?;
                let _ = ShowCapWindow::Main { init_target_mode: None }.show(app).await;
                Ok(())
            }
            Self::StopRecording => {
                let state = app.state::<ArcLock<App>>();
                crate::recording::stop_recording(app.clone(), state.clone()).await?;
                let _ = ShowCapWindow::Main { init_target_mode: None }.show(app).await;
                Ok(())
            }
            Self::TakeScreenshot => {
                use scap_targets::Display;
                let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
                let target = ScreenCaptureTarget::Display { id: display.id() };

                match crate::recording::take_screenshot(app.clone(), target).await {
                    Ok(path) => {
                        let _ = ShowCapWindow::ScreenshotEditor { path }.show(app).await;
                        Ok(())
                    }
                    Err(e) => Err(format!("Failed to take screenshot: {e}")),
                }
            }
            Self::SwitchMicrophone { mic_label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state.clone(), mic_label)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Self::SwitchCamera { camera } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state.clone(), camera, None)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Self::StartRecording {
                capture_mode,
                camera,
                mic_label,
                capture_system_audio,
                mode,
            } => {
                let state = app.state::<ArcLock<App>>();

                let capture_target = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::sources::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == *name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::sources::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == *name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or(format!("No window with name \"{}\"", &name))?,
                };

                let inputs = StartRecordingInputs {
                    capture_target,
                    capture_system_audio,
                    mode,
                    organization_id: None,
                };

                if let Some(camera_id) = camera {
                    crate::set_camera_input(app.clone(), state.clone(), Some(camera_id.clone()), None)
                        .await
                        .map_err(|e| e.to_string())?;
                }

                if let Some(mic) = mic_label {
                    crate::set_mic_input(state.clone(), Some(mic.clone()))
                        .await
                        .map_err(|e| e.to_string())?;
                }

                crate::recording::start_recording(app.clone(), state.clone(), inputs)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Self::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            Self::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page: page.clone() })
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
        }
    }
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    trace!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| DeepLinkAction::try_from(&url).ok())
        .collect();

    if actions.is_empty() {
        return;
    }

    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        for action in actions {
            if let Err(e) = action.execute(&app_handle).await {
                trace!("Failed to handle deep link action: {}", e);
            }
        }
    });
}
