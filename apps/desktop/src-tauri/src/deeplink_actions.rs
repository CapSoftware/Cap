use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    StartSavedRecording {
        mode: Option<RecordingMode>,
    },
    StopRecording,
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    SetMicrophone {
        label: Option<String>,
    },
    SetCamera {
        selector: Option<CameraSelector>,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CameraSelector {
    DeviceId(String),
    ModelId(String),
    Label(String),
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    trace!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| {
            parse_deeplink(url.as_str())
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

#[derive(Debug, PartialEq, Eq)]
pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CameraIdentity {
    display_name: String,
    device_id: String,
    model_id: Option<String>,
}

impl CameraIdentity {
    fn current() -> Vec<Self> {
        crate::recording::list_cameras()
            .into_iter()
            .map(|camera| Self {
                display_name: camera.display_name().to_string(),
                device_id: camera.device_id().to_string(),
                model_id: camera.model_id().map(ToString::to_string),
            })
            .collect()
    }

    fn device_or_model_id(&self) -> Result<DeviceOrModelID, String> {
        match &self.model_id {
            Some(model_id) => cap_camera::ModelID::try_from(model_id.clone())
                .map(DeviceOrModelID::ModelID)
                .map_err(|_| format!("Invalid camera model ID \"{model_id}\"")),
            None => Ok(DeviceOrModelID::DeviceID(self.device_id.clone())),
        }
    }
}

pub fn parse_deeplink(url: &str) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    let url =
        Url::parse(url).map_err(|err| ActionParseFromUrlError::ParseFailed(err.to_string()))?;
    parse_url(&url)
}

fn parse_url(url: &Url) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    #[cfg(target_os = "macos")]
    if url.scheme() == "file" {
        return url
            .to_file_path()
            .map(|project_path| DeepLinkAction::OpenEditor { project_path })
            .map_err(|_| ActionParseFromUrlError::Invalid);
    }

    let host = url.host_str().ok_or(ActionParseFromUrlError::Invalid)?;

    match host {
        "action" => parse_action_url(url),
        "record" => parse_record_url(url),
        "device" => parse_device_url(url),
        _ => Err(ActionParseFromUrlError::NotAction),
    }
}

fn parse_action_url(url: &Url) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    let json_value = query_param(url, "value").ok_or(ActionParseFromUrlError::Invalid)?;
    serde_json::from_str(&json_value)
        .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))
}

fn parse_record_url(url: &Url) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    match path_segments(url)?.as_slice() {
        ["start"] => Ok(DeepLinkAction::StartSavedRecording {
            mode: query_param(url, "mode")
                .map(parse_recording_mode)
                .transpose()?,
        }),
        ["stop"] => Ok(DeepLinkAction::StopRecording),
        ["pause"] => Ok(DeepLinkAction::PauseRecording),
        ["resume"] => Ok(DeepLinkAction::ResumeRecording),
        ["toggle-pause"] => Ok(DeepLinkAction::TogglePauseRecording),
        _ => Err(ActionParseFromUrlError::Invalid),
    }
}

fn parse_device_url(url: &Url) -> Result<DeepLinkAction, ActionParseFromUrlError> {
    match path_segments(url)?.as_slice() {
        ["microphone"] => {
            if parse_bool_flag(url, "off")? {
                return Ok(DeepLinkAction::SetMicrophone { label: None });
            }

            Ok(DeepLinkAction::SetMicrophone {
                label: Some(non_empty_query_param(url, "label")?),
            })
        }
        ["camera"] => {
            if parse_bool_flag(url, "off")? {
                return Ok(DeepLinkAction::SetCamera { selector: None });
            }

            let selector =
                if let Some(device_id) = optional_non_empty_query_param(url, "device_id")? {
                    CameraSelector::DeviceId(device_id)
                } else if let Some(device_id) = optional_non_empty_query_param(url, "id")? {
                    CameraSelector::DeviceId(device_id)
                } else if let Some(model_id) = optional_non_empty_query_param(url, "model_id")? {
                    CameraSelector::ModelId(model_id)
                } else if let Some(label) = optional_non_empty_query_param(url, "label")? {
                    CameraSelector::Label(label)
                } else {
                    return Err(ActionParseFromUrlError::Invalid);
                };

            Ok(DeepLinkAction::SetCamera {
                selector: Some(selector),
            })
        }
        _ => Err(ActionParseFromUrlError::Invalid),
    }
}

fn parse_recording_mode(value: String) -> Result<RecordingMode, ActionParseFromUrlError> {
    serde_json::from_str::<RecordingMode>(&format!("\"{value}\""))
        .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))
}

fn parse_bool_flag(url: &Url, name: &str) -> Result<bool, ActionParseFromUrlError> {
    let Some(value) = query_param(url, name) else {
        return Ok(false);
    };

    match value.to_ascii_lowercase().as_str() {
        "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        _ => Err(ActionParseFromUrlError::ParseFailed(format!(
            "Invalid boolean value for \"{name}\": {value}"
        ))),
    }
}

fn optional_non_empty_query_param(
    url: &Url,
    name: &str,
) -> Result<Option<String>, ActionParseFromUrlError> {
    match query_param(url, name) {
        Some(value) if value.is_empty() => Err(ActionParseFromUrlError::Invalid),
        Some(value) => Ok(Some(value)),
        None => Ok(None),
    }
}

fn non_empty_query_param(url: &Url, name: &str) -> Result<String, ActionParseFromUrlError> {
    optional_non_empty_query_param(url, name)?.ok_or(ActionParseFromUrlError::Invalid)
}

fn path_segments(url: &Url) -> Result<Vec<&str>, ActionParseFromUrlError> {
    let segments: Vec<_> = url
        .path_segments()
        .ok_or(ActionParseFromUrlError::Invalid)?
        .filter(|segment| !segment.is_empty())
        .collect();

    if segments.is_empty() {
        return Err(ActionParseFromUrlError::Invalid);
    }

    Ok(segments)
}

fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn resolve_camera_selector(
    selector: &CameraSelector,
    cameras: &[CameraIdentity],
) -> Result<DeviceOrModelID, String> {
    match selector {
        CameraSelector::DeviceId(device_id) => cameras
            .iter()
            .find(|camera| camera.device_id.eq_ignore_ascii_case(device_id))
            .map(|_| DeviceOrModelID::DeviceID(device_id.clone()))
            .ok_or_else(|| format!("No camera with device ID \"{device_id}\"")),
        CameraSelector::ModelId(model_id) => {
            let Some(camera) = cameras.iter().find(|camera| {
                camera
                    .model_id
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(model_id))
            }) else {
                return Err(format!("No camera with model ID \"{model_id}\""));
            };

            camera.device_or_model_id()
        }
        CameraSelector::Label(label) => cameras
            .iter()
            .find(|camera| camera.display_name == *label)
            .ok_or_else(|| format!("No camera with label \"{label}\""))?
            .device_or_model_id(),
    }
}

async fn pause_for_input_change(app: &AppHandle) -> Result<(), String> {
    let should_pause = {
        let state = app.state::<ArcLock<App>>();
        let state = state.read().await;
        let Some(recording) = state.current_recording() else {
            return Ok(());
        };

        !recording.is_paused().await.map_err(|e| e.to_string())?
    };

    if should_pause {
        crate::recording::pause_recording(app.clone(), app.state()).await?;
    }

    Ok(())
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
            DeepLinkAction::StartSavedRecording { mode } => {
                crate::start_recording_from_saved_settings(app.clone(), mode)
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
            DeepLinkAction::SetMicrophone { label } => {
                pause_for_input_change(app).await?;
                crate::set_mic_input(app.state(), label).await
            }
            DeepLinkAction::SetCamera { selector } => {
                pause_for_input_change(app).await?;
                let camera_id = selector
                    .as_ref()
                    .map(|selector| resolve_camera_selector(selector, &CameraIdentity::current()))
                    .transpose()?;
                crate::set_camera_input(app.clone(), app.state(), camera_id, None).await
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
    fn parses_existing_action_link() {
        let action = serde_json::json!({
            "open_settings": {
                "page": "general"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", [("value", action)]).unwrap();

        assert_eq!(
            parse_deeplink(url.as_str()).unwrap(),
            DeepLinkAction::OpenSettings {
                page: Some("general".to_string()),
            }
        );
    }

    #[test]
    fn auth_link_is_not_handled_by_rust_actions() {
        assert_eq!(
            parse_deeplink("cap-desktop://signin?token=abc&user_id=123&expires=456"),
            Err(ActionParseFromUrlError::NotAction)
        );
    }

    #[test]
    fn url_host_and_path_shapes_are_pinned() {
        let action = Url::parse("cap-desktop://action?value=%7B%7D").unwrap();
        assert_eq!(action.host_str(), Some("action"));
        assert_eq!(action.path(), "");

        let record = Url::parse("cap-desktop://record/start?mode=studio").unwrap();
        assert_eq!(record.host_str(), Some("record"));
        assert_eq!(record.path(), "/start");
        assert_eq!(
            record.path_segments().unwrap().collect::<Vec<_>>(),
            vec!["start"]
        );
    }

    #[test]
    fn parses_record_control_links() {
        assert_eq!(
            parse_deeplink("cap-desktop://record/start?mode=studio").unwrap(),
            DeepLinkAction::StartSavedRecording {
                mode: Some(RecordingMode::Studio),
            }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://record/start").unwrap(),
            DeepLinkAction::StartSavedRecording { mode: None }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://record/stop").unwrap(),
            DeepLinkAction::StopRecording
        );
        assert_eq!(
            parse_deeplink("cap-desktop://record/pause").unwrap(),
            DeepLinkAction::PauseRecording
        );
        assert_eq!(
            parse_deeplink("cap-desktop://record/resume").unwrap(),
            DeepLinkAction::ResumeRecording
        );
        assert_eq!(
            parse_deeplink("cap-desktop://record/toggle-pause").unwrap(),
            DeepLinkAction::TogglePauseRecording
        );
    }

    #[test]
    fn parses_microphone_links() {
        assert_eq!(
            parse_deeplink("cap-desktop://device/microphone?label=Built-in%20Microphone").unwrap(),
            DeepLinkAction::SetMicrophone {
                label: Some("Built-in Microphone".to_string()),
            }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/microphone?off=true").unwrap(),
            DeepLinkAction::SetMicrophone { label: None }
        );
    }

    #[test]
    fn parses_camera_links() {
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera?device_id=device-123").unwrap(),
            DeepLinkAction::SetCamera {
                selector: Some(CameraSelector::DeviceId("device-123".to_string())),
            }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera?model_id=1a2b:3c4d").unwrap(),
            DeepLinkAction::SetCamera {
                selector: Some(CameraSelector::ModelId("1a2b:3c4d".to_string())),
            }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera?label=FaceTime%20HD%20Camera").unwrap(),
            DeepLinkAction::SetCamera {
                selector: Some(CameraSelector::Label("FaceTime HD Camera".to_string())),
            }
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera?off=true").unwrap(),
            DeepLinkAction::SetCamera { selector: None }
        );
    }

    #[test]
    fn rejects_malformed_or_missing_params() {
        assert!(matches!(
            parse_deeplink("cap-desktop://record/start?mode=bogus"),
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));
        assert_eq!(
            parse_deeplink("cap-desktop://device/microphone"),
            Err(ActionParseFromUrlError::Invalid)
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/microphone?label="),
            Err(ActionParseFromUrlError::Invalid)
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera"),
            Err(ActionParseFromUrlError::Invalid)
        );
        assert_eq!(
            parse_deeplink("cap-desktop://device/camera?id="),
            Err(ActionParseFromUrlError::Invalid)
        );
        assert!(matches!(
            parse_deeplink("cap-desktop://device/camera?off=maybe"),
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));
    }

    #[test]
    fn camera_resolution_surfaces_unknown_device() {
        let cameras = vec![CameraIdentity {
            display_name: "FaceTime HD Camera".to_string(),
            device_id: "known-device".to_string(),
            model_id: Some("1a2b:3c4d".to_string()),
        }];

        assert_eq!(
            resolve_camera_selector(
                &CameraSelector::DeviceId("missing-device".to_string()),
                &cameras,
            ),
            Err("No camera with device ID \"missing-device\"".to_string())
        );
        assert_eq!(
            resolve_camera_selector(
                &CameraSelector::Label("Missing Camera".to_string()),
                &cameras,
            ),
            Err("No camera with label \"Missing Camera\"".to_string())
        );
    }
}
