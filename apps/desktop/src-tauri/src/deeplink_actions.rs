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
    SwitchMicrophone {
        mic_label: String,
    },
    SwitchCamera {
        camera: DeviceOrModelID,
    },
    ListMicrophones,
    ListCameras,
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
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                use cap_recording::feeds::microphone::MicrophoneFeed;

                let available_mics = MicrophoneFeed::list();
                if !available_mics.contains_key(&mic_label) {
                    let available: Vec<String> = available_mics.keys().cloned().collect();
                    return Err(format!(
                        "Microphone '{}' not found. Available microphones: {}",
                        mic_label,
                        available.join(", ")
                    ));
                }

                crate::set_mic_input(app.state(), Some(mic_label)).await
            }
            DeepLinkAction::SwitchCamera { camera } => {
                let available_cameras: Vec<_> = cap_camera::list_cameras().collect();
                let camera_exists = available_cameras.iter().any(|c| {
                    c.device_id() == camera.device_id()
                        || camera
                            .model_id()
                            .map_or(false, |mid| Some(mid) == c.model_id())
                });

                if !camera_exists {
                    let available: Vec<String> = available_cameras
                        .iter()
                        .map(|c| format!("{} ({})", c.display_name(), c.device_id()))
                        .collect();
                    return Err(format!(
                        "Camera not found. Available cameras: {}",
                        available.join(", ")
                    ));
                }

                crate::set_camera_input(app.clone(), app.state(), Some(camera), None)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::ListMicrophones => {
                let mics = list_available_microphones()?;
                let json = serde_json::to_string(&mics)
                    .map_err(|e| format!("Failed to serialize microphones: {}", e))?;
                println!("{}", json);
                Ok(())
            }
            DeepLinkAction::ListCameras => {
                let cameras = list_available_cameras()?;
                let json = serde_json::to_string(&cameras)
                    .map_err(|e| format!("Failed to serialize cameras: {}", e))?;
                println!("{}", json);
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

#[derive(Debug, Serialize, Deserialize)]
pub struct MicrophoneInfo {
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CameraInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

fn list_available_microphones() -> Result<Vec<MicrophoneInfo>, String> {
    use cap_recording::feeds::microphone::MicrophoneFeed;

    let mics: Vec<MicrophoneInfo> = MicrophoneFeed::list()
        .into_iter()
        .enumerate()
        .map(|(idx, (label, _))| MicrophoneInfo {
            label,
            is_default: idx == 0,
        })
        .collect();

    Ok(mics)
}

fn list_available_cameras() -> Result<Vec<CameraInfo>, String> {
    let cameras: Vec<CameraInfo> = cap_camera::list_cameras()
        .enumerate()
        .map(|(idx, camera)| CameraInfo {
            id: camera.device_id().to_string(),
            name: camera.display_name().to_string(),
            is_default: idx == 0,
        })
        .collect();

    Ok(cameras)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pause_recording_deeplink_parsing() {
        let json = r#"{"pause_recording":{}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::PauseRecording));
    }

    #[test]
    fn test_resume_recording_deeplink_parsing() {
        let json = r#"{"resume_recording":{}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::ResumeRecording));
    }

    #[test]
    fn test_toggle_pause_recording_deeplink_parsing() {
        let json = r#"{"toggle_pause_recording":{}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::TogglePauseRecording));
    }

    #[test]
    fn test_switch_microphone_deeplink_parsing() {
        let json = r#"{"switch_microphone":{"mic_label":"Test Microphone"}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                assert_eq!(mic_label, "Test Microphone");
            }
            _ => panic!("Expected SwitchMicrophone action"),
        }
    }

    #[test]
    fn test_switch_camera_deeplink_parsing() {
        let json = r#"{"switch_camera":{"camera":{"device_id":"test-camera-id"}}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SwitchCamera { camera } => {
                assert_eq!(camera.device_id(), "test-camera-id");
            }
            _ => panic!("Expected SwitchCamera action"),
        }
    }

    #[test]
    fn test_list_microphones_deeplink_parsing() {
        let json = r#"{"list_microphones":{}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::ListMicrophones));
    }

    #[test]
    fn test_list_cameras_deeplink_parsing() {
        let json = r#"{"list_cameras":{}}"#;
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(json));
        let url = Url::parse(&url_str).unwrap();

        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::ListCameras));
    }

    #[test]
    fn test_invalid_json_returns_error() {
        let invalid_json = r#"{"invalid_json"#;
        let url_str = format!(
            "cap-desktop://action?value={}",
            urlencoding::encode(invalid_json)
        );
        let url = Url::parse(&url_str).unwrap();

        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }

    #[test]
    fn test_missing_value_parameter_returns_error() {
        let url = Url::parse("cap-desktop://action").unwrap();
        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }

    #[test]
    fn test_non_action_domain_returns_not_action_error() {
        let url = Url::parse("cap-desktop://other?value=test").unwrap();
        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }

    #[test]
    fn test_deeplink_round_trip_pause() {
        let original = DeepLinkAction::PauseRecording;
        let json = serde_json::to_string(&original).unwrap();
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(&json));
        let url = Url::parse(&url_str).unwrap();
        let parsed = DeepLinkAction::try_from(&url).unwrap();

        assert!(matches!(parsed, DeepLinkAction::PauseRecording));
    }

    #[test]
    fn test_deeplink_round_trip_switch_microphone() {
        let original = DeepLinkAction::SwitchMicrophone {
            mic_label: "Test Mic".to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(&json));
        let url = Url::parse(&url_str).unwrap();
        let parsed = DeepLinkAction::try_from(&url).unwrap();

        match parsed {
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                assert_eq!(mic_label, "Test Mic");
            }
            _ => panic!("Expected SwitchMicrophone action"),
        }
    }

    #[test]
    fn test_url_encoding_special_characters() {
        let mic_label = "Test Mic (Built-in)";
        let original = DeepLinkAction::SwitchMicrophone {
            mic_label: mic_label.to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let url_str = format!("cap-desktop://action?value={}", urlencoding::encode(&json));
        let url = Url::parse(&url_str).unwrap();
        let parsed = DeepLinkAction::try_from(&url).unwrap();

        match parsed {
            DeepLinkAction::SwitchMicrophone {
                mic_label: parsed_label,
            } => {
                assert_eq!(parsed_label, mic_label);
            }
            _ => panic!("Expected SwitchMicrophone action"),
        }
    }

    #[test]
    fn test_serialization_maintains_snake_case() {
        let action = DeepLinkAction::PauseRecording;
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("pause_recording"));

        let action = DeepLinkAction::TogglePauseRecording;
        let json = serde_json::to_string(&action).unwrap();
        assert!(json.contains("toggle_pause_recording"));
    }
}
