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
    TakeScreenshot {
        capture_mode: CaptureMode,
    },
    SetMicrophone {
        mic_label: Option<String>,
    },
    SetCamera {
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
            return Ok(Self::OpenEditor {
                project_path: url.to_file_path().unwrap(),
            });
        }

        let domain = url.domain();

        // Path-based deeplinks: cap-desktop://record/start, cap-desktop://device/microphone, etc.
        if let Some(d) = domain {
            if let Some(action) = Self::try_from_path(d, url)? {
                return Ok(action);
            }
        }

        // Legacy JSON-based deeplinks: cap-desktop://action?value={...}
        match domain {
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
    /// Parse path-based deeplink URLs.
    ///
    /// Supported routes:
    /// - `cap-desktop://record/start?screen=<name>&mode=<studio|instant>`
    /// - `cap-desktop://record/stop`
    /// - `cap-desktop://record/pause`
    /// - `cap-desktop://record/resume`
    /// - `cap-desktop://record/toggle-pause`
    /// - `cap-desktop://record/restart`
    /// - `cap-desktop://screenshot?screen=<name>`
    /// - `cap-desktop://device/microphone?label=<name>` (omit label to disable)
    /// - `cap-desktop://device/camera?device_id=<id>` or `?model_id=<id>` or `?off=true`
    /// - `cap-desktop://settings?page=<page>`
    fn try_from_path(domain: &str, url: &Url) -> Result<Option<Self>, ActionParseFromUrlError> {
        let path = url.path().trim_start_matches('/');
        let params = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();

        match domain {
            "record" => match path {
                "start" => {
                    let screen = params.get("screen").map(|s| s.to_string());
                    let window = params.get("window").map(|s| s.to_string());
                    let capture_mode = if let Some(window_name) = window {
                        CaptureMode::Window(window_name)
                    } else if let Some(screen_name) = screen {
                        CaptureMode::Screen(screen_name)
                    } else {
                        return Err(ActionParseFromUrlError::ParseFailed(
                            "start recording requires 'screen' or 'window' parameter".to_string(),
                        ));
                    };

                    let mode = match params.get("mode").map(|s| s.as_ref()) {
                        Some("instant") => RecordingMode::Instant,
                        _ => RecordingMode::Studio,
                    };

                    let mic_label = params.get("mic").map(|s| s.to_string());
                    let capture_system_audio = params
                        .get("system_audio")
                        .map(|s| s == "true")
                        .unwrap_or(false);

                    Ok(Some(DeepLinkAction::StartRecording {
                        capture_mode,
                        camera: None,
                        mic_label,
                        capture_system_audio,
                        mode,
                    }))
                }
                "stop" => Ok(Some(DeepLinkAction::StopRecording)),
                "pause" => Ok(Some(DeepLinkAction::PauseRecording)),
                "resume" => Ok(Some(DeepLinkAction::ResumeRecording)),
                "toggle-pause" => Ok(Some(DeepLinkAction::TogglePauseRecording)),
                "restart" => {
                    // Restart = stop + start; handled as stop here (start requires capture params)
                    Ok(Some(DeepLinkAction::StopRecording))
                }
                _ => Err(ActionParseFromUrlError::ParseFailed(format!(
                    "unknown record action: '{path}'"
                ))),
            },
            "screenshot" => {
                let screen = params.get("screen").map(|s| s.to_string());
                let window = params.get("window").map(|s| s.to_string());
                let capture_mode = if let Some(window_name) = window {
                    CaptureMode::Window(window_name)
                } else if let Some(screen_name) = screen {
                    CaptureMode::Screen(screen_name)
                } else {
                    return Err(ActionParseFromUrlError::ParseFailed(
                        "screenshot requires 'screen' or 'window' parameter".to_string(),
                    ));
                };
                Ok(Some(DeepLinkAction::TakeScreenshot { capture_mode }))
            }
            "device" => match path {
                "microphone" => {
                    let label = params.get("label").map(|s| s.to_string());
                    Ok(Some(DeepLinkAction::SetMicrophone { mic_label: label }))
                }
                "camera" => {
                    let camera = if params.get("off").map(|s| s.as_ref()) == Some("true") {
                        None
                    } else if let Some(device_id) = params.get("device_id") {
                        Some(DeviceOrModelID::DeviceID(device_id.to_string()))
                    } else if let Some(model_id) = params.get("model_id") {
                        Some(DeviceOrModelID::ModelID(model_id.to_string()))
                    } else {
                        return Err(ActionParseFromUrlError::ParseFailed(
                            "camera requires 'device_id', 'model_id', or 'off=true' parameter"
                                .to_string(),
                        ));
                    };
                    Ok(Some(DeepLinkAction::SetCamera { camera }))
                }
                _ => Err(ActionParseFromUrlError::ParseFailed(format!(
                    "unknown device type: '{path}'"
                ))),
            },
            "settings" => {
                let page = params.get("page").map(|s| s.to_string());
                Ok(Some(DeepLinkAction::OpenSettings { page }))
            }
            _ => Ok(None),
        }
    }

    fn resolve_capture_target(
        capture_mode: CaptureMode,
    ) -> Result<ScreenCaptureTarget, String> {
        match capture_mode {
            CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                .into_iter()
                .find(|(s, _)| s.name == name)
                .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                .ok_or_else(|| {
                    format!(
                        "No screen with name \"{name}\" (must match exactly). Available: {:?}",
                        cap_recording::screen_capture::list_displays()
                            .iter()
                            .map(|(s, _)| &s.name)
                            .collect::<Vec<_>>()
                    )
                }),
            CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                .into_iter()
                .find(|(w, _)| w.name == name)
                .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                .ok_or_else(|| {
                    format!(
                        "No window with name \"{name}\" (must match exactly). Available: {:?}",
                        cap_recording::screen_capture::list_windows()
                            .iter()
                            .map(|(w, _)| &w.name)
                            .collect::<Vec<_>>()
                    )
                }),
        }
    }

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

                let capture_target = Self::resolve_capture_target(capture_mode)?;

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
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let capture_target = Self::resolve_capture_target(capture_mode)?;
                crate::recording::take_screenshot(app.clone(), capture_target)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, mic_label).await
            }
            DeepLinkAction::SetCamera { camera } => {
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
    fn parses_path_based_stop_recording() {
        let url = Url::parse("cap-desktop://record/stop").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::StopRecording));
    }

    #[test]
    fn parses_path_based_pause_recording() {
        let url = Url::parse("cap-desktop://record/pause").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::PauseRecording));
    }

    #[test]
    fn parses_path_based_resume_recording() {
        let url = Url::parse("cap-desktop://record/resume").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::ResumeRecording));
    }

    #[test]
    fn parses_path_based_toggle_pause() {
        let url = Url::parse("cap-desktop://record/toggle-pause").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::TogglePauseRecording));
    }

    #[test]
    fn parses_path_based_start_recording() {
        let url =
            Url::parse("cap-desktop://record/start?screen=Main%20Display&mode=studio").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::StartRecording {
                capture_mode,
                mode,
                ..
            } => {
                assert!(matches!(capture_mode, CaptureMode::Screen(ref n) if n == "Main Display"));
                assert!(matches!(mode, RecordingMode::Studio));
            }
            _ => panic!("Expected StartRecording"),
        }
    }

    #[test]
    fn parses_path_based_set_microphone() {
        let url =
            Url::parse("cap-desktop://device/microphone?label=MacBook%20Pro%20Microphone").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SetMicrophone { mic_label } => {
                assert_eq!(mic_label.as_deref(), Some("MacBook Pro Microphone"));
            }
            _ => panic!("Expected SetMicrophone"),
        }
    }

    #[test]
    fn parses_path_based_disable_microphone() {
        let url = Url::parse("cap-desktop://device/microphone").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SetMicrophone { mic_label } => {
                assert!(mic_label.is_none());
            }
            _ => panic!("Expected SetMicrophone"),
        }
    }

    #[test]
    fn parses_path_based_set_camera_device_id() {
        let url =
            Url::parse("cap-desktop://device/camera?device_id=0x1420000005ac8600").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SetCamera { camera } => {
                assert!(matches!(
                    camera,
                    Some(DeviceOrModelID::DeviceID(ref id)) if id == "0x1420000005ac8600"
                ));
            }
            _ => panic!("Expected SetCamera"),
        }
    }

    #[test]
    fn parses_path_based_disable_camera() {
        let url = Url::parse("cap-desktop://device/camera?off=true").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::SetCamera { camera } => {
                assert!(camera.is_none());
            }
            _ => panic!("Expected SetCamera with None"),
        }
    }

    #[test]
    fn parses_legacy_json_deeplink() {
        let url = Url::parse(
            "cap-desktop://action?value=%7B%22stop_recording%22%3Anull%7D",
        )
        .unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::StopRecording));
    }

    #[test]
    fn parses_settings_deeplink() {
        let url = Url::parse("cap-desktop://settings?page=recordings").unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();
        match action {
            DeepLinkAction::OpenSettings { page } => {
                assert_eq!(page.as_deref(), Some("recordings"));
            }
            _ => panic!("Expected OpenSettings"),
        }
    }

    #[test]
    fn rejects_unknown_record_action() {
        let url = Url::parse("cap-desktop://record/unknown").unwrap();
        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_camera_without_required_params() {
        let url = Url::parse("cap-desktop://device/camera").unwrap();
        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_start_recording_without_target() {
        let url = Url::parse("cap-desktop://record/start").unwrap();
        let result = DeepLinkAction::try_from(&url);
        assert!(result.is_err());
    }
}
