use cap_recording::{
    RecordingMode,
    feeds::{camera::DeviceOrModelID, microphone::MicrophoneFeed},
    sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{
    recording::StartRecordingInputs,
    windows::ShowCapWindow,
    App, ArcLock,
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
    /// Writes `raycast-device-cache.json` under the app data dir (displays, windows, cameras, mics).
    RefreshRaycastDeviceCache,
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

        // `cap-desktop://action?value=...` — host must be exactly `action` (see tauri deep-link config).
        if url.host_str() != Some("action") {
            return Err(if url.host_str().is_some() {
                ActionParseFromUrlError::NotAction
            } else {
                ActionParseFromUrlError::Invalid
            });
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

fn capture_target_from_mode(capture_mode: &CaptureMode) -> Result<ScreenCaptureTarget, String> {
    Ok(match capture_mode {
        CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|(s, _)| s.name == *name)
            .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
            .ok_or_else(|| format!("No screen with name \"{name}\""))?,
        CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|(w, _)| w.name == *name)
            .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
            .ok_or_else(|| format!("No window with name \"{name}\""))?,
    })
}

fn raycast_device_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(dir.join("raycast-device-cache.json"))
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

                let capture_target = capture_target_from_mode(&capture_mode)?;

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
                crate::recording::toggle_pause_recording(app.clone(), app.state())
                    .await
            }
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let target = capture_target_from_mode(&capture_mode)?;
                crate::recording::take_screenshot(app.clone(), target).await?;
                Ok(())
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, mic_label).await
            }
            DeepLinkAction::SetCamera { camera } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, camera, Some(true)).await
            }
            DeepLinkAction::RefreshRaycastDeviceCache => {
                let displays = crate::recording::list_capture_displays().await;
                let windows = crate::recording::list_capture_windows().await;
                let cameras = crate::recording::list_cameras();
                let microphones = if crate::permissions::do_permissions_check(false)
                    .microphone
                    .permitted()
                {
                    MicrophoneFeed::list()
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    vec![]
                };

                let cameras_json: Result<Vec<serde_json::Value>, String> = cameras
                    .iter()
                    .map(|c| {
                        let id = DeviceOrModelID::from_info(c);
                        Ok(json!({
                            "display_name": c.display_name(),
                            "device_or_model_id": serde_json::to_value(&id).map_err(|e| e.to_string())?,
                        }))
                    })
                    .collect();
                let cameras_json = cameras_json?;

                let payload = json!({
                    "generated_at": chrono::Utc::now().to_rfc3339(),
                    "displays": displays,
                    "windows": windows,
                    "cameras": cameras_json,
                    "microphones": microphones,
                });

                let path = raycast_device_cache_path(app)?;
                // Async fs only: `execute` runs on Tokio; `std::fs` would block a worker thread.
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
                tokio::fs::write(&path, json.as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
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
