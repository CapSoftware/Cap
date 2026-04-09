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

    /// Open Cap's target selection overlay UI (clean UX for Raycast).
    OpenTargetPicker {
        /// Optional: open the picker in a specific target mode if supported by the UI.
        target_mode: Option<crate::RecordingTargetMode>,
    },

    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },

    /// Copies a JSON list of cameras to the clipboard.
    ListCameras,
    /// Sets the camera by Device/Model ID (null disables camera).
    SetCamera {
        camera: Option<DeviceOrModelID>,
    },

    /// Copies a JSON list of microphone labels to the clipboard.
    ListMicrophones,
    /// Sets the microphone by label (null disables microphone).
    SetMicrophone {
        mic_label: Option<String>,
    },

    /// Copies a JSON list of capture displays to the clipboard.
    ListDisplays,
    /// Copies a JSON list of capture windows to the clipboard.
    ListWindows,
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

            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let target: ScreenCaptureTarget = match capture_mode {
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

                crate::recording::take_screenshot(app.clone(), target)
                    .await
                    .map(|_| ())
            }

            DeepLinkAction::OpenTargetPicker { target_mode } => {
                // Show the overlay on the primary display (best-effort).
                // If display enumeration fails, fall back to showing the main window.
                let display_id = cap_recording::screen_capture::list_displays()
                    .into_iter()
                    .next()
                    .map(|(d, _)| d.id)
                    .ok_or_else(|| "No displays found".to_string());

                match display_id {
                    Ok(display_id) => ShowCapWindow::TargetSelectOverlay {
                        display_id,
                        target_mode,
                    }
                    .show(app)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                    Err(_) => ShowCapWindow::Main {
                        init_target_mode: target_mode,
                    }
                    .show(app)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                }
            }

            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }

            DeepLinkAction::ListCameras => {
                let cameras: Vec<_> = cap_camera::list_cameras()
                    .map(|c| {
                        serde_json::json!({
                            "device_id": c.device_id(),
                            "display_name": c.display_name(),
                            "model_id": c.model_id(),
                        })
                    })
                    .collect();

                let json = serde_json::to_string(&cameras).map_err(|e| e.to_string())?;
                crate::write_clipboard_string(app.state(), json).await
            }
            DeepLinkAction::SetCamera { camera } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, camera, None).await
            }

            DeepLinkAction::ListMicrophones => {
                let mics = cap_recording::feeds::microphone::MicrophoneFeed::list();
                let names: Vec<_> = mics.keys().cloned().collect();
                let json = serde_json::to_string(&names).map_err(|e| e.to_string())?;
                crate::write_clipboard_string(app.state(), json).await
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, mic_label).await
            }

            DeepLinkAction::ListDisplays => {
                let displays: Vec<_> = cap_recording::screen_capture::list_displays()
                    .into_iter()
                    .map(|(d, _)| {
                        serde_json::json!({
                            "id": d.id,
                            "name": d.name,
                        })
                    })
                    .collect();

                let json = serde_json::to_string(&displays).map_err(|e| e.to_string())?;
                crate::write_clipboard_string(app.state(), json).await
            }
            DeepLinkAction::ListWindows => {
                let windows: Vec<_> = cap_recording::screen_capture::list_windows()
                    .into_iter()
                    .map(|(w, _)| {
                        serde_json::json!({
                            "id": w.id,
                            "name": w.name,
                        })
                    })
                    .collect();

                let json = serde_json::to_string(&windows).map_err(|e| e.to_string())?;
                crate::write_clipboard_string(app.state(), json).await
            }
        }
    }
}
