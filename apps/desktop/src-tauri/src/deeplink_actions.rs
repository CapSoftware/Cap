use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::{warn, error};

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
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
    StartDefaultRecording,
    ResumeRecording,
    TogglePauseRecording,
    PauseRecording,
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| {
            DeepLinkAction::try_from(&url)
                .map_err(|e| {
                    let mut safe_url = url.clone();
                    safe_url.set_query(None);
                    safe_url.set_fragment(None);
                    match e {
                        ActionParseFromUrlError::ParseFailed(msg) => {
                            error!("Failed to parse deep link \"{}\": {}", safe_url, msg)
                        }
                        ActionParseFromUrlError::Invalid => {
                            warn!("Invalid deep link format \"{}\"", safe_url)
                        }
                        ActionParseFromUrlError::NotAction => {}
                    }
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
                error!("Failed to handle deep link action: {e}");
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
        let scheme = url.scheme().to_lowercase();

        #[cfg(target_os = "macos")]
        if scheme == "file" {
            return url
                .to_file_path()
                .map(|project_path| Self::OpenEditor { project_path })
                .map_err(|_| ActionParseFromUrlError::Invalid);
        }

        if scheme == "cap" {
            let host = url.host_str().unwrap_or_default();
            let path = url.path().trim_matches('/');

            let action = if host.eq_ignore_ascii_case("record") || path.eq_ignore_ascii_case("record") {
                Some(Self::StartDefaultRecording)
            } else if host.eq_ignore_ascii_case("stop") || path.eq_ignore_ascii_case("stop") {
                Some(Self::StopRecording)
            } else if host.eq_ignore_ascii_case("pause") || path.eq_ignore_ascii_case("pause") {
                Some(Self::PauseRecording)
            } else if host.eq_ignore_ascii_case("resume") || path.eq_ignore_ascii_case("resume") {
                Some(Self::ResumeRecording)
            } else if host.eq_ignore_ascii_case("toggle-pause") || path.eq_ignore_ascii_case("toggle-pause") {
                Some(Self::TogglePauseRecording)
            } else {
                None
            };

            return action.ok_or(ActionParseFromUrlError::Invalid);
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
        let should_notify = match &self {
            DeepLinkAction::StartRecording { .. }
            | DeepLinkAction::StartDefaultRecording
            | DeepLinkAction::StopRecording
            | DeepLinkAction::ResumeRecording
            | DeepLinkAction::PauseRecording
            | DeepLinkAction::TogglePauseRecording => true,
            _ => false,
        };

        let result = match self {
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
                        .ok_or_else(|| format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or_else(|| format!("No window with name \"{}\"", &name))?,
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
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
            DeepLinkAction::StartDefaultRecording => {
                crate::RequestOpenRecordingPicker { target_mode: None }.emit(app).map_err(|e| e.to_string())
            }
            DeepLinkAction::ResumeRecording => {
                crate::recording::resume_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::PauseRecording => {
                crate::recording::pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
        };

        if result.is_ok() && should_notify {
            crate::notifications::NotificationType::DeepLinkTriggered.send(app);
        }

        result
    }
}
