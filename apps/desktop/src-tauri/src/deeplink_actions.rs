use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
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
    RestartRecording,
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

#[derive(Debug)]
pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

fn path_action(url: &Url) -> Option<(String, String)> {
    let domain = url.domain()?.to_string();
    let mut segments = url.path_segments()?;
    let first = segments.next().unwrap_or("").to_string();
    if first.is_empty() {
        return None;
    }
    Some((domain, first))
}

fn query_map(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect::<HashMap<_, _>>()
}

fn parse_bool(value: Option<&String>, default: bool) -> Result<bool, ActionParseFromUrlError> {
    let Some(value) = value else {
        return Ok(default);
    };

    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => Err(ActionParseFromUrlError::ParseFailed(format!(
            "invalid boolean value '{value}'"
        ))),
    }
}

fn parse_optional_string(value: Option<&String>) -> Option<String> {
    value
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .map(ToString::to_string)
}

fn parse_mode(value: Option<&String>) -> Result<RecordingMode, ActionParseFromUrlError> {
    match value
        .map(|v| v.trim().to_ascii_lowercase())
        .as_deref()
        .unwrap_or("studio")
    {
        "studio" => Ok(RecordingMode::Studio),
        "instant" => Ok(RecordingMode::Instant),
        other => Err(ActionParseFromUrlError::ParseFailed(format!(
            "invalid mode '{other}', expected 'studio' or 'instant'"
        ))),
    }
}

fn parse_camera_from_query(
    query: &HashMap<String, String>,
) -> Result<Option<DeviceOrModelID>, ActionParseFromUrlError> {
    if parse_bool(query.get("off"), false)? {
        return Ok(None);
    }

    let device_id = parse_optional_string(query.get("device_id"));
    let model_id = parse_optional_string(query.get("model_id"));

    match (device_id, model_id) {
        (Some(device_id), None) => Ok(Some(DeviceOrModelID::DeviceID(device_id))),
        (None, Some(model_id)) => {
            let parsed_model_id = model_id.try_into().map_err(|_| {
                ActionParseFromUrlError::ParseFailed(
                    "invalid 'model_id' format, expected 'VID:PID'".to_string(),
                )
            })?;
            Ok(Some(DeviceOrModelID::ModelID(parsed_model_id)))
        }
        (None, None) => Ok(None),
        (Some(_), Some(_)) => Err(ActionParseFromUrlError::ParseFailed(
            "camera deep link can specify only one of 'device_id' or 'model_id'".to_string(),
        )),
    }
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

        if let Some((domain, action)) = path_action(url) {
            let query = query_map(url);

            return match (domain.as_str(), action.as_str()) {
                ("record", "start") => {
                    let mode = parse_mode(query.get("mode"))?;
                    let capture_system_audio =
                        parse_bool(query.get("capture_system_audio"), false)?;

                    let capture_type = parse_optional_string(query.get("capture_type"))
                        .ok_or_else(|| {
                            ActionParseFromUrlError::ParseFailed(
                                "missing required query parameter 'capture_type' (screen or window)"
                                    .to_string(),
                            )
                        })?
                        .to_ascii_lowercase();

                    let target_name =
                        parse_optional_string(query.get("target")).ok_or_else(|| {
                            ActionParseFromUrlError::ParseFailed(
                                "missing required query parameter 'target'".to_string(),
                            )
                        })?;

                    let capture_mode = match capture_type.as_str() {
                        "screen" => CaptureMode::Screen(target_name),
                        "window" => CaptureMode::Window(target_name),
                        _ => {
                            return Err(ActionParseFromUrlError::ParseFailed(
                                "capture_type must be 'screen' or 'window'".to_string(),
                            ));
                        }
                    };

                    Ok(Self::StartRecording {
                        capture_mode,
                        camera: parse_camera_from_query(&query)?,
                        mic_label: parse_optional_string(query.get("mic_label")),
                        capture_system_audio,
                        mode,
                    })
                }
                ("record", "stop") => Ok(Self::StopRecording),
                ("record", "pause") => Ok(Self::PauseRecording),
                ("record", "resume") => Ok(Self::ResumeRecording),
                ("record", "toggle-pause") => Ok(Self::TogglePauseRecording),
                ("record", "restart") => Ok(Self::RestartRecording),
                ("device", "microphone") => Ok(Self::SwitchMicrophone {
                    mic_label: parse_optional_string(query.get("label")),
                }),
                ("device", "camera") => Ok(Self::SwitchCamera {
                    camera: parse_camera_from_query(&query)?,
                }),
                ("settings", "open") => Ok(Self::OpenSettings {
                    page: parse_optional_string(query.get("page")),
                }),
                _ => Err(ActionParseFromUrlError::NotAction),
            };
        }

        match url.domain() {
            Some("action") => Ok(()),
            Some(_) => Err(ActionParseFromUrlError::NotAction),
            None => Err(ActionParseFromUrlError::Invalid),
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
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::RestartRecording => {
                crate::recording::restart_recording(app.clone(), app.state())
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                crate::set_mic_input(app.state(), mic_label).await
            }
            DeepLinkAction::SwitchCamera { camera } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, camera, None).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_start_recording_path_deeplink() {
        let url = Url::parse(
            "cap-desktop://record/start?mode=studio&capture_type=screen&target=Built-in+Display&capture_system_audio=true&mic_label=MacBook+Mic",
        )
        .unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();

        match action {
            DeepLinkAction::StartRecording {
                capture_mode,
                mic_label,
                capture_system_audio,
                mode,
                ..
            } => {
                assert!(matches!(mode, RecordingMode::Studio));
                assert!(capture_system_audio);
                assert_eq!(mic_label, Some("MacBook Mic".to_string()));
                assert!(
                    matches!(capture_mode, CaptureMode::Screen(name) if name == "Built-in Display")
                );
            }
            _ => panic!("expected StartRecording action"),
        }
    }

    #[test]
    fn parses_switch_camera_device_id() {
        let url = Url::parse("cap-desktop://device/camera?device_id=abc").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();

        assert!(matches!(
            action,
            DeepLinkAction::SwitchCamera {
                camera: Some(DeviceOrModelID::DeviceID(id))
            } if id == "abc"
        ));
    }

    #[test]
    fn rejects_camera_with_both_device_and_model_id() {
        let url = Url::parse("cap-desktop://device/camera?device_id=abc&model_id=def").unwrap();
        let action = DeepLinkAction::try_from(&url);

        assert!(matches!(
            action,
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));
    }

    #[test]
    fn keeps_legacy_action_json_deeplink() {
        let url = Url::parse("cap-desktop://action?value=%22stop_recording%22").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();

        assert!(matches!(action, DeepLinkAction::StopRecording));
    }
}
