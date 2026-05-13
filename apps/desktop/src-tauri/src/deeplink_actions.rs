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
    ToggleMicrophone {
        mic_label: Option<String>,
    },
    ToggleCamera {
        camera: Option<DeviceOrModelID>,
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
            return url
                .to_file_path()
                .map(|project_path| Self::OpenEditor { project_path })
                .map_err(|_| ActionParseFromUrlError::Invalid);
        }

        match url.domain() {
            Some("action") => parse_action_url(url),
            Some(v) if v != "action" => Err(ActionParseFromUrlError::NotAction),
            _ => Err(ActionParseFromUrlError::Invalid),
        }
    }
}

fn parse_action_url(url: &Url) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    let params = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();

    if let Some(action) = params.get("action").or_else(|| params.get("value")) {
        return serde_json::from_str::<DeepLinkAction>(action)
            .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()));
    }

    let command = url
        .path_segments()
        .and_then(|mut segments| segments.next())
        .filter(|segment| !segment.is_empty())
        .ok_or(ActionParseFromUrlError::Invalid)?;

    match command {
        "record" | "start-recording" | "start_recording" => Ok(DeepLinkAction::StartRecording {
            capture_mode: parse_capture_mode(&params)?,
            camera: parse_camera(&params)?,
            mic_label: params.get("mic").or_else(|| params.get("mic_label")).map(|v| v.to_string()),
            capture_system_audio: parse_bool_param(&params, "system_audio", false),
            mode: parse_recording_mode(&params)?,
        }),
        "stop" | "stop-recording" | "stop_recording" => Ok(DeepLinkAction::StopRecording),
        "pause" | "pause-recording" | "pause_recording" => Ok(DeepLinkAction::PauseRecording),
        "resume" | "resume-recording" | "resume_recording" => Ok(DeepLinkAction::ResumeRecording),
        "toggle-pause" | "toggle_pause" | "toggle-pause-recording" | "toggle_pause_recording" => {
            Ok(DeepLinkAction::TogglePauseRecording)
        }
        "toggle-microphone" | "toggle_microphone" | "mic" => Ok(DeepLinkAction::ToggleMicrophone {
            mic_label: params.get("mic").or_else(|| params.get("mic_label")).map(|v| v.to_string()),
        }),
        "toggle-camera" | "toggle_camera" | "camera" => Ok(DeepLinkAction::ToggleCamera {
            camera: parse_camera(&params)?,
        }),
        "settings" | "open-settings" | "open_settings" => Ok(DeepLinkAction::OpenSettings {
            page: params.get("page").map(|v| v.to_string()),
        }),
        _ => Err(ActionParseFromUrlError::Invalid),
    }
}

fn parse_capture_mode(
    params: &std::collections::HashMap<std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>>,
) -> Result<CaptureMode, ActionParseFromUrlError> {
    if let Some(display) = params.get("display").or_else(|| params.get("screen")) {
        return Ok(CaptureMode::Screen(display.to_string()));
    }

    if let Some(window) = params.get("window") {
        return Ok(CaptureMode::Window(window.to_string()));
    }

    Err(ActionParseFromUrlError::Invalid)
}

fn parse_camera(
    params: &std::collections::HashMap<std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>>,
) -> Result<Option<DeviceOrModelID>, ActionParseFromUrlError> {
    if let Some(device_id) = params.get("camera_device_id").or_else(|| params.get("camera")) {
        return Ok(Some(DeviceOrModelID::DeviceID(device_id.to_string())));
    }

    if let Some(model_id) = params.get("camera_model_id") {
        return serde_json::from_value(serde_json::json!({ "ModelID": model_id.to_string() }))
            .map(Some)
            .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()));
    }

    Ok(None)
}

fn parse_bool_param(
    params: &std::collections::HashMap<std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>>,
    key: &str,
    default: bool,
) -> bool {
    params
        .get(key)
        .and_then(|value| value.parse::<bool>().ok())
        .unwrap_or(default)
}

fn parse_recording_mode(
    params: &std::collections::HashMap<std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>>,
) -> Result<RecordingMode, ActionParseFromUrlError> {
    match params.get("mode").map(|v| v.as_ref()) {
        Some("instant") => Ok(RecordingMode::Instant),
        Some("studio") | None => Ok(RecordingMode::Studio),
        Some(value) => Err(ActionParseFromUrlError::ParseFailed(format!(
            "Unsupported recording mode: {value}"
        ))),
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
                    CaptureMode::Screen(name) => cap_recording::sources::screen_capture::list_displays()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::sources::screen_capture::list_windows()
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
            DeepLinkAction::PauseRecording => crate::recording::pause_recording(app.state()).await,
            DeepLinkAction::ResumeRecording => crate::recording::resume_recording(app.state()).await,
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.state()).await
            }
            DeepLinkAction::ToggleMicrophone { mic_label } => {
                crate::set_mic_input(app.state(), mic_label).await
            }
            DeepLinkAction::ToggleCamera { camera } => {
                crate::set_camera_input(app.clone(), app.state(), camera, None).await
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
