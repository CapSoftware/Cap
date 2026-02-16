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
pub enum Action {
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
    ToggleMicrophone,
    ToggleCamera,
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
            Action::try_from(&url)
                .map_err(|e| match e {
                    ActionParseFromUrlError::ParseFailed(msg) => {
                        eprintln!("Failed to parse deep link \"{}\": {}", &url, msg)
                    }
                    ActionParseFromUrlError::Invalid => {
                        eprintln!("Invalid deep link format \"{}\"", &url)
                    }
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

impl TryFrom<&Url> for Action {
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

impl Action {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        let state = app.state::<ArcLock<App>>();
        match self {
            Action::StartRecording { capture_mode, camera, mic_label, capture_system_audio, mode } => {
                let capture_target: ScreenCaptureTarget = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays().into_iter().find(|(s, _)| s.name == name).map(|(s, _)| ScreenCaptureTarget::Display { id: s.id }).ok_or(format!("No screen \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows().into_iter().find(|(w, _)| w.name == name).map(|(w, _)| ScreenCaptureTarget::Window { id: w.id }).ok_or(format!("No window \"{}\"", &name))?,
                };
                let inputs = StartRecordingInputs { mode, capture_target, capture_system_audio, organization_id: None };
                crate::recording::start_recording(app.clone(), state, inputs).await.map(|_| ())
            }
            Action::StopRecording => crate::recording::stop_recording(app.clone(), state).await,
            Action::PauseRecording => crate::recording::pause_recording(app.clone(), state).await,
            Action::ResumeRecording => crate::recording::resume_recording(app.clone(), state).await,
            Action::ToggleMicrophone => crate::set_mic_input(state.clone(), None).await.map_err(|e| e.to_string()),
            Action::ToggleCamera => crate::set_camera_input(app.clone(), state.clone(), None).await.map_err(|e| e.to_string()),
            Action::OpenEditor { project_path } => crate::open_project_from_path(Path::new(&project_path), app.clone()),
            Action::OpenSettings { page } => crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await,
        }
    }
}