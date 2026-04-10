use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager, Url};
use tracing::{error, trace};

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
    StartRecordingPath {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        apply_camera: bool,
        mic_label: Option<String>,
        apply_mic: bool,
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
                        error!("Failed to parse deep link \"{}\": {}", &url, msg)
                    }
                    ActionParseFromUrlError::Invalid => {
                        error!("Invalid deep link format \"{}\"", &url)
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
                error!("Failed to handle deep link action: {e}");
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

fn parse_optional_string(value: Option<&String>) -> Option<String> {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
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

fn parse_mode(value: Option<&String>) -> Result<RecordingMode, ActionParseFromUrlError> {
    match value
        .map(|value| value.trim().to_ascii_lowercase())
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

fn query_map(url: &Url) -> HashMap<String, String> {
    url.query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn path_action(url: &Url) -> Option<(String, String)> {
    if url.scheme() != "cap-desktop" {
        return None;
    }

    let domain = url.domain()?.to_string();
    let mut segments = url.path_segments()?;
    let action = segments.next()?.trim().to_string();

    if action.is_empty() {
        return None;
    }

    Some((domain, action))
}

fn parse_camera_from_query(
    query: &HashMap<String, String>,
) -> Result<Option<DeviceOrModelID>, ActionParseFromUrlError> {
    let device_id = parse_optional_string(query.get("device_id"));
    let model_id = parse_optional_string(query.get("model_id"));
    let off = parse_bool(query.get("off"), false)?;

    if off && (device_id.is_some() || model_id.is_some()) {
        return Err(ActionParseFromUrlError::ParseFailed(
            "camera deep link cannot combine 'off=true' with 'device_id' or 'model_id'".to_string(),
        ));
    }

    if off {
        return Ok(None);
    }

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

fn parse_microphone_from_query(
    query: &HashMap<String, String>,
    label_key: &str,
    off_key: &str,
) -> Result<(Option<String>, bool), ActionParseFromUrlError> {
    let label_present = query.contains_key(label_key);
    let label = parse_optional_string(query.get(label_key));
    let off = parse_bool(query.get(off_key), false)?;

    if off && label_present {
        return Err(ActionParseFromUrlError::ParseFailed(format!(
            "microphone deep link cannot combine '{off_key}=true' with '{label_key}'"
        )));
    }

    if off {
        return Ok((None, true));
    }

    if label_present {
        return Ok((label, true));
    }

    Ok((None, false))
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

        if let Some((domain, action)) = path_action(url) {
            let query = query_map(url);

            return match (domain.as_str(), action.as_str()) {
                ("record", "start") => {
                    let capture_type = parse_optional_string(query.get("capture_type"))
                        .ok_or_else(|| {
                            ActionParseFromUrlError::ParseFailed(
                                "missing required query parameter 'capture_type'".to_string(),
                            )
                        })?
                        .to_ascii_lowercase();
                    let target = parse_optional_string(query.get("target")).ok_or_else(|| {
                        ActionParseFromUrlError::ParseFailed(
                            "missing required query parameter 'target'".to_string(),
                        )
                    })?;
                    let capture_mode = match capture_type.as_str() {
                        "screen" => CaptureMode::Screen(target),
                        "window" => CaptureMode::Window(target),
                        _ => {
                            return Err(ActionParseFromUrlError::ParseFailed(
                                "capture_type must be 'screen' or 'window'".to_string(),
                            ));
                        }
                    };
                    let apply_camera = query.contains_key("device_id")
                        || query.contains_key("model_id")
                        || query.contains_key("off");
                    let (mic_label, apply_mic) =
                        parse_microphone_from_query(&query, "mic_label", "mic_off")?;

                    Ok(Self::StartRecordingPath {
                        capture_mode,
                        camera: parse_camera_from_query(&query)?,
                        apply_camera,
                        mic_label,
                        apply_mic,
                        capture_system_audio: parse_bool(
                            query.get("capture_system_audio"),
                            false,
                        )?,
                        mode: parse_mode(query.get("mode"))?,
                    })
                }
                ("record", "stop") => Ok(Self::StopRecording),
                ("record", "pause") => Ok(Self::PauseRecording),
                ("record", "resume") => Ok(Self::ResumeRecording),
                ("record", "toggle-pause") => Ok(Self::TogglePauseRecording),
                ("record", "restart") => Ok(Self::RestartRecording),
                ("device", "microphone") => {
                    let (mic_label, _) = parse_microphone_from_query(&query, "label", "off")?;
                    Ok(Self::SwitchMicrophone { mic_label })
                }
                ("device", "camera") => Ok(Self::SwitchCamera {
                    camera: parse_camera_from_query(&query)?,
                }),
                ("settings", "open") => Ok(Self::OpenSettings {
                    page: parse_optional_string(query.get("page")),
                }),
                _ => Err(ActionParseFromUrlError::NotAction),
            };
        }

        if url.scheme() != "cap-desktop" {
            return Err(ActionParseFromUrlError::NotAction);
        }

        match url.domain() {
            Some("action") => Ok(()),
            Some(_) => Err(ActionParseFromUrlError::NotAction),
            None => Err(ActionParseFromUrlError::Invalid),
        }?;

        let params = url.query_pairs().collect::<HashMap<_, _>>();
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
                        .find(|(screen, _)| screen.name == name)
                        .map(|(screen, _)| ScreenCaptureTarget::Display { id: screen.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(window, _)| window.name == name)
                        .map(|(window, _)| ScreenCaptureTarget::Window { id: window.id })
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
            DeepLinkAction::StartRecordingPath {
                capture_mode,
                camera,
                apply_camera,
                mic_label,
                apply_mic,
                capture_system_audio,
                mode,
            } => {
                let state = app.state::<ArcLock<App>>();

                if apply_camera {
                    crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
                }
                if apply_mic {
                    crate::set_mic_input(state.clone(), mic_label).await?;
                }

                let capture_target: ScreenCaptureTarget = match capture_mode {
                    CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                        .into_iter()
                        .find(|(screen, _)| screen.name == name)
                        .map(|(screen, _)| ScreenCaptureTarget::Display { id: screen.id })
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(window, _)| window.name == name)
                        .map(|(window, _)| ScreenCaptureTarget::Window { id: window.id })
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
                crate::set_camera_input(app.clone(), app.state::<ArcLock<App>>(), camera, None).await
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
            DeepLinkAction::StartRecordingPath {
                capture_mode,
                mic_label,
                apply_camera,
                apply_mic,
                capture_system_audio,
                mode,
                ..
            } => {
                assert!(matches!(mode, RecordingMode::Studio));
                assert!(capture_system_audio);
                assert_eq!(mic_label, Some("MacBook Mic".to_string()));
                assert!(apply_mic);
                assert!(!apply_camera);
                assert!(matches!(capture_mode, CaptureMode::Screen(name) if name == "Built-in Display"));
            }
            _ => panic!("expected StartRecordingPath action"),
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

        assert!(matches!(action, Err(ActionParseFromUrlError::ParseFailed(_))));
    }

    #[test]
    fn rejects_camera_off_with_device_id() {
        let url = Url::parse("cap-desktop://device/camera?off=true&device_id=abc").unwrap();
        let action = DeepLinkAction::try_from(&url);

        assert!(matches!(action, Err(ActionParseFromUrlError::ParseFailed(_))));
    }

    #[test]
    fn parses_switch_microphone_off() {
        let url = Url::parse("cap-desktop://device/microphone?off=true").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();

        assert!(matches!(
            action,
            DeepLinkAction::SwitchMicrophone { mic_label: None }
        ));
    }

    #[test]
    fn keeps_legacy_action_json_deeplink() {
        let url = Url::parse("cap-desktop://action?value=%22stop_recording%22").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();

        assert!(matches!(action, DeepLinkAction::StopRecording));
    }

    #[test]
    fn rejects_wrong_scheme() {
        let url = Url::parse("cap://record/stop").unwrap();
        let action = DeepLinkAction::try_from(&url);

        assert!(matches!(action, Err(ActionParseFromUrlError::NotAction)));
    }
}
