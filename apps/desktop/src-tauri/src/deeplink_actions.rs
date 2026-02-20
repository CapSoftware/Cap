use cap_recording::{
    RecordingMode,
    feeds::{camera::DeviceOrModelID, microphone::MicrophoneFeed},
    sources::screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    StartCurrentRecording {
        mode: Option<RecordingMode>,
    },
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
    SwitchMicrophone {
        mic_label: Option<String>,
    },
    SwitchCamera {
        camera_selector: Option<String>,
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

        let host = url.host_str().or(url.domain());
        match host {
            Some("action") => {}
            Some(_) => return Err(ActionParseFromUrlError::NotAction),
            None => return Err(ActionParseFromUrlError::Invalid),
        }

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
            DeepLinkAction::StartCurrentRecording { mode } => {
                let settings = crate::recording_settings::RecordingSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                crate::set_mic_input(app.state(), settings.mic_name).await?;
                crate::set_camera_input(app.clone(), app.state(), settings.camera_id, None).await?;

                let inputs = StartRecordingInputs {
                    mode: mode.or(settings.mode).unwrap_or(RecordingMode::Studio),
                    capture_target: settings.target.unwrap_or_else(|| {
                        ScreenCaptureTarget::Display {
                            id: Display::primary().id(),
                        }
                    }),
                    capture_system_audio: settings.system_audio,
                    organization_id: settings.organization_id,
                };

                crate::recording::start_recording(app.clone(), app.state(), inputs)
                    .await
                    .map(|_| ())
            }
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
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                if let Some(mic_label) = mic_label {
                    return crate::set_mic_input(app.state(), Some(mic_label)).await;
                }

                let current_mic = app
                    .state::<ArcLock<App>>()
                    .read()
                    .await
                    .selected_mic_label
                    .clone();
                let mut microphones: Vec<String> = MicrophoneFeed::list().keys().cloned().collect();

                if microphones.is_empty() {
                    return Err("No microphone devices found".to_string());
                }

                microphones.sort_unstable();
                let next_mic = next_item(microphones, current_mic.as_ref())
                    .ok_or("No microphone devices found".to_string())?;

                crate::set_mic_input(app.state(), Some(next_mic)).await
            }
            DeepLinkAction::SwitchCamera { camera_selector } => {
                if let Some(camera_selector) = camera_selector {
                    let camera_id = find_camera_by_selector(&camera_selector)
                        .ok_or(format!("No camera matching \"{}\"", camera_selector))?;

                    return crate::set_camera_input(
                        app.clone(),
                        app.state(),
                        Some(camera_id),
                        None,
                    )
                    .await;
                }

                let camera_ids: Vec<DeviceOrModelID> = cap_camera::list_cameras()
                    .map(|camera| DeviceOrModelID::from_info(&camera))
                    .collect();

                if camera_ids.is_empty() {
                    return Err("No camera devices found".to_string());
                }

                let current_camera = app
                    .state::<ArcLock<App>>()
                    .read()
                    .await
                    .selected_camera_id
                    .clone();
                let next_camera = next_item(camera_ids, current_camera.as_ref())
                    .ok_or("No camera devices found".to_string())?;

                crate::set_camera_input(app.clone(), app.state(), Some(next_camera), None).await
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

fn find_camera_by_selector(selector: &str) -> Option<DeviceOrModelID> {
    cap_camera::list_cameras().find_map(|camera| {
        let model_id = camera.model_id().map(|id| id.to_string());
        if camera.display_name() == selector
            || camera.device_id() == selector
            || model_id.as_deref() == Some(selector)
        {
            Some(DeviceOrModelID::from_info(&camera))
        } else {
            None
        }
    })
}

fn next_item<T: Clone + PartialEq>(items: Vec<T>, current: Option<&T>) -> Option<T> {
    if items.is_empty() {
        return None;
    }

    let next_index = current
        .and_then(|value| items.iter().position(|item| item == value))
        .map(|index| (index + 1) % items.len())
        .unwrap_or(0);

    items.get(next_index).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action_url(action: DeepLinkAction) -> Url {
        let value = serde_json::to_string(&action).expect("serialize action");
        let mut url = Url::parse("cap-desktop://action").expect("parse base url");
        url.query_pairs_mut().append_pair("value", &value);
        url
    }

    #[test]
    fn parses_action_urls() {
        let action = DeepLinkAction::PauseRecording;
        let parsed = DeepLinkAction::try_from(&action_url(action.clone())).expect("parse action");
        assert_eq!(parsed, action);
    }

    #[test]
    fn parses_action_with_payload() {
        let action = DeepLinkAction::SwitchMicrophone {
            mic_label: Some("Shure MV7".to_string()),
        };
        let parsed = DeepLinkAction::try_from(&action_url(action.clone())).expect("parse action");
        assert_eq!(parsed, action);
    }

    #[test]
    fn parses_start_current_recording() {
        let action = DeepLinkAction::StartCurrentRecording {
            mode: Some(RecordingMode::Studio),
        };
        let parsed = DeepLinkAction::try_from(&action_url(action.clone())).expect("parse action");
        assert_eq!(parsed, action);
    }

    #[test]
    fn returns_not_action_for_non_action_host() {
        let url = Url::parse("cap-desktop://signin?token=abc").expect("parse url");
        let parsed = DeepLinkAction::try_from(&url);
        assert!(matches!(parsed, Err(ActionParseFromUrlError::NotAction)));
    }

    #[test]
    fn returns_invalid_without_value() {
        let url = Url::parse("cap-desktop://action").expect("parse url");
        let parsed = DeepLinkAction::try_from(&url);
        assert!(matches!(parsed, Err(ActionParseFromUrlError::Invalid)));
    }
}
