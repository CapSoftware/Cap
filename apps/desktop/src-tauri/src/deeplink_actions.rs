use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{
    App, ArcLock,
    recording::StartRecordingInputs,
    recording_settings::RecordingTargetMode,
    windows::ShowCapWindow,
};

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
    StartRecordingFromSettings {
        mode: RecordingMode,
    },
    StopRecording,
    RestartRecording,
    TogglePauseRecording,
    SetMicrophone {
        mic_label: Option<String>,
    },
    SetCamera {
        camera: Option<DeviceOrModelID>,
    },
    OpenRecordingPicker {
        target_mode: Option<RecordingTargetMode>,
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
            DeepLinkAction::StartRecordingFromSettings { mode } => {
                let state = app.state::<ArcLock<App>>();
                let settings = crate::recording_settings::RecordingSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                crate::set_mic_input(state.clone(), settings.mic_name).await?;
                crate::set_camera_input(app.clone(), state.clone(), settings.camera_id, None)
                    .await?;

                let inputs = StartRecordingInputs {
                    mode,
                    capture_target: settings.target.unwrap_or_else(|| {
                        ScreenCaptureTarget::Display {
                            id: scap_targets::Display::primary().id(),
                        }
                    }),
                    capture_system_audio: settings.system_audio,
                    organization_id: settings.organization_id,
                };

                crate::recording::start_recording(app.clone(), state, inputs)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::RestartRecording => crate::recording::restart_recording(
                app.clone(),
                app.state(),
            )
            .await
            .map(|_| ()),
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                crate::set_mic_input(app.state(), mic_label).await
            }
            DeepLinkAction::SetCamera { camera } => {
                crate::set_camera_input(app.clone(), app.state(), camera, None).await
            }
            DeepLinkAction::OpenRecordingPicker { target_mode } => {
                match target_mode {
                    Some(target_mode) => crate::open_target_picker(app, target_mode).await,
                    None => {
                        ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(app)
                        .await?;
                    }
                }

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

#[cfg(test)]
mod tests {
    use super::{ActionParseFromUrlError, DeepLinkAction};
    use crate::recording_settings::RecordingTargetMode;
    use tauri::Url;

    fn parse_action(encoded_value: &str) -> Result<DeepLinkAction, ActionParseFromUrlError> {
        let url = Url::parse(&format!("cap-desktop://action?value={encoded_value}")).unwrap();

        DeepLinkAction::try_from(&url)
    }

    #[test]
    fn parses_restart_recording_action() {
        assert!(matches!(
            parse_action("%22restart_recording%22").unwrap(),
            DeepLinkAction::RestartRecording
        ));
    }

    #[test]
    fn parses_start_recording_from_settings_action() {
        assert!(matches!(
            parse_action(
                "%7B%22start_recording_from_settings%22%3A%7B%22mode%22%3A%22studio%22%7D%7D"
            )
            .unwrap(),
            DeepLinkAction::StartRecordingFromSettings {
                mode: cap_recording::RecordingMode::Studio
            }
        ));
    }

    #[test]
    fn parses_toggle_pause_recording_action() {
        assert!(matches!(
            parse_action("%22toggle_pause_recording%22").unwrap(),
            DeepLinkAction::TogglePauseRecording
        ));
    }

    #[test]
    fn parses_set_microphone_action() {
        assert!(matches!(
            parse_action("%7B%22set_microphone%22%3A%7B%22mic_label%22%3Anull%7D%7D").unwrap(),
            DeepLinkAction::SetMicrophone { mic_label: None }
        ));
    }

    #[test]
    fn parses_set_camera_action() {
        assert!(matches!(
            parse_action(
                "%7B%22set_camera%22%3A%7B%22camera%22%3A%7B%22DeviceID%22%3A%22camera-device-id%22%7D%7D%7D"
            )
            .unwrap(),
            DeepLinkAction::SetCamera {
                camera: Some(cap_recording::feeds::camera::DeviceOrModelID::DeviceID(_))
            }
        ));
    }

    #[test]
    fn parses_open_recording_picker_action() {
        assert!(matches!(
            parse_action(
                "%7B%22open_recording_picker%22%3A%7B%22target_mode%22%3A%22display%22%7D%7D"
            )
            .unwrap(),
            DeepLinkAction::OpenRecordingPicker {
                target_mode: Some(RecordingTargetMode::Display)
            }
        ));
    }
}
