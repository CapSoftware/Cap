use cap_recording::{
    MicrophoneFeed, RecordingMode, feeds::camera::DeviceOrModelID,
    sources::screen_capture::ScreenCaptureTarget,
};
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
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    RestartRecording,
    TakeScreenshot {
        capture_mode: CaptureMode,
    },
    #[serde(alias = "switch_microphone")]
    SetMicrophone {
        mic_label: Option<String>,
    },
    #[serde(alias = "switch_camera")]
    SetCamera {
        camera: Option<DeviceOrModelID>,
    },
    RefreshRaycastDeviceCache,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RaycastDeviceCache {
    displays: Vec<String>,
    windows: Vec<String>,
    microphones: Vec<String>,
    cameras: Vec<RaycastCamera>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RaycastScreenshotResult {
    path: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RaycastCamera {
    name: String,
    camera: DeviceOrModelID,
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

        match url.host_str() {
            Some(v) if v != "action" => Err(ActionParseFromUrlError::NotAction),
            Some(_) => Ok(()),
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

                let capture_target = capture_target_from_mode(capture_mode).await?;

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
            DeepLinkAction::RestartRecording => crate::recording::restart_recording(
                app.clone(),
                app.state(),
            )
            .await
            .map(|_| ()),
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let capture_target = capture_target_from_mode(capture_mode).await?;
                let path = crate::recording::take_screenshot(app.clone(), capture_target).await?;
                write_raycast_screenshot_result(app, path).await
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                crate::set_mic_input(app.state(), mic_label).await
            }
            DeepLinkAction::SetCamera { camera } => {
                crate::set_camera_input(app.clone(), app.state(), camera, Some(true)).await
            }
            DeepLinkAction::RefreshRaycastDeviceCache => refresh_raycast_device_cache(app).await,
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
        }
    }
}

async fn capture_target_from_mode(capture_mode: CaptureMode) -> Result<ScreenCaptureTarget, String> {
    tokio::task::spawn_blocking(move || match capture_mode {
        CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|(screen, _)| screen.name == name)
            .map(|(screen, _)| ScreenCaptureTarget::Display { id: screen.id })
            .ok_or(format!("No screen with name \"{}\"", &name)),
        CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|(window, _)| window.name == name)
            .map(|(window, _)| ScreenCaptureTarget::Window { id: window.id })
            .ok_or(format!("No window with name \"{}\"", &name)),
    })
    .await
    .map_err(|err| err.to_string())?
}

async fn refresh_raycast_device_cache(app: &AppHandle) -> Result<(), String> {
    let cache = tokio::task::spawn_blocking(|| {
        let displays = cap_recording::screen_capture::list_displays()
            .into_iter()
            .map(|(display, _)| display.name)
            .collect();
        let windows = cap_recording::screen_capture::list_windows()
            .into_iter()
            .map(|(window, _)| window.name)
            .collect();
        let microphones = MicrophoneFeed::list().keys().cloned().collect();
        let cameras = cap_camera::list_cameras()
            .map(|camera| RaycastCamera {
                name: camera.display_name().to_string(),
                camera: DeviceOrModelID::from_info(&camera),
            })
            .collect();

        RaycastDeviceCache {
            displays,
            windows,
            microphones,
            cameras,
        }
    })
    .await
    .map_err(|err| err.to_string())?;

    write_raycast_json(app, "raycast-device-cache.json", &cache).await
}

async fn write_raycast_screenshot_result(app: &AppHandle, path: PathBuf) -> Result<(), String> {
    write_raycast_json(
        app,
        "raycast-last-screenshot.json",
        &RaycastScreenshotResult { path },
    )
    .await
}

async fn write_raycast_json<T: Serialize>(
    app: &AppHandle,
    file_name: &str,
    value: &T,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .join(file_name);
    let json = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|err| err.to_string())?;
    }
    tokio::fs::write(path, json)
        .await
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_action(value: serde_json::Value) -> DeepLinkAction {
        let mut url = Url::parse("cap-desktop://action").unwrap();
        url.query_pairs_mut()
            .append_pair("value", &value.to_string());

        DeepLinkAction::try_from(&url).unwrap()
    }

    #[test]
    fn parses_action_host_deeplinks() {
        assert_eq!(
            parse_action(serde_json::json!("pause_recording")),
            DeepLinkAction::PauseRecording
        );
        assert_eq!(
            parse_action(serde_json::json!("resume_recording")),
            DeepLinkAction::ResumeRecording
        );
        assert_eq!(
            parse_action(serde_json::json!("toggle_pause_recording")),
            DeepLinkAction::TogglePauseRecording
        );
        assert_eq!(
            parse_action(serde_json::json!("restart_recording")),
            DeepLinkAction::RestartRecording
        );
        assert_eq!(
            parse_action(serde_json::json!("refresh_raycast_device_cache")),
            DeepLinkAction::RefreshRaycastDeviceCache
        );
    }

    #[test]
    fn parses_nullable_input_selection_payloads() {
        assert_eq!(
            parse_action(serde_json::json!({
                "set_microphone": {
                    "mic_label": "MacBook Pro Microphone"
                }
            })),
            DeepLinkAction::SetMicrophone {
                mic_label: Some("MacBook Pro Microphone".to_string())
            }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "switch_microphone": {
                    "mic_label": "Desk Mic"
                }
            })),
            DeepLinkAction::SetMicrophone {
                mic_label: Some("Desk Mic".to_string())
            }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "set_microphone": {
                    "mic_label": null
                }
            })),
            DeepLinkAction::SetMicrophone { mic_label: None }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "set_camera": {
                    "camera": {
                        "DeviceID": "camera-device-id"
                    }
                }
            })),
            DeepLinkAction::SetCamera {
                camera: Some(DeviceOrModelID::DeviceID("camera-device-id".to_string()))
            }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "switch_camera": {
                    "camera": {
                        "ModelID": "AppleCamera-123"
                    }
                }
            })),
            DeepLinkAction::SetCamera {
                camera: Some(DeviceOrModelID::ModelID("AppleCamera-123".to_string()))
            }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "set_camera": {
                    "camera": null
                }
            })),
            DeepLinkAction::SetCamera { camera: None }
        );
    }

    #[test]
    fn parses_capture_payloads() {
        assert_eq!(
            parse_action(serde_json::json!({
                "take_screenshot": {
                    "capture_mode": {
                        "screen": "Built-in Display"
                    }
                }
            })),
            DeepLinkAction::TakeScreenshot {
                capture_mode: CaptureMode::Screen("Built-in Display".to_string())
            }
        );
        assert_eq!(
            parse_action(serde_json::json!({
                "start_recording": {
                    "capture_mode": {
                        "window": "Cap"
                    },
                    "camera": null,
                    "mic_label": null,
                    "capture_system_audio": false,
                    "mode": "studio"
                }
            })),
            DeepLinkAction::StartRecording {
                capture_mode: CaptureMode::Window("Cap".to_string()),
                camera: None,
                mic_label: None,
                capture_system_audio: false,
                mode: RecordingMode::Studio,
            }
        );
    }

    #[test]
    fn rejects_non_action_hosts_without_blocking_auth_links() {
        let url = Url::parse("cap-desktop://signin?token=abc").unwrap();

        assert!(matches!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::NotAction)
        ));
    }
}
