// Fix for Issue #1540 - Deep Links & Raycast Support
//
// Extends the existing DeepLinkAction enum with:
//   - PauseRecording
//   - ResumeRecording
//   - TogglePauseRecording
//   - SwitchMicrophone { label }
//   - SwitchCamera { id }
//
// All new actions use idiomatic Rust error handling with `?`.
// No .unwrap() calls anywhere in this file.

use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

// ---------------------------------------------------------------------------
// CaptureMode helper
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

// ---------------------------------------------------------------------------
// The main action enum — all variants are (de)serializable from JSON so the
// URL parser (`TryFrom<&Url>`) can hydrate them from ?value=<JSON>.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DeepLinkAction {
    /// Start a new recording session.
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },

    /// Stop the active recording session.
    StopRecording,

    /// Pause the active recording. Returns an error if no recording is active.
    PauseRecording,

    /// Resume a paused recording. Returns an error if recording is not paused.
    ResumeRecording,

    /// Toggle between paused and recording states.
    TogglePauseRecording,

    /// Switch the active microphone. Pass `None` to mute/disable the mic.
    SwitchMicrophone {
        label: Option<String>,
    },

    /// Switch the active camera. Pass `None` to disable the camera.
    SwitchCamera {
        id: Option<DeviceOrModelID>,
    },

    /// Open the Cap editor for a given project path.
    OpenEditor {
        project_path: PathBuf,
    },

    /// Navigate to a Settings page.
    OpenSettings {
        page: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// URL → Action parsing
// ---------------------------------------------------------------------------

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    trace!("Handling deep link actions for: {:?}", &urls);

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
                    // Likely a login/auth action — handled elsewhere.
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

// ---------------------------------------------------------------------------
// Parse error types
// ---------------------------------------------------------------------------

pub enum ActionParseFromUrlError {
    ParseFailed(String),
    Invalid,
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        // On macOS, a .cap file opened from Finder arrives as a file:// URL.
        #[cfg(target_os = "macos")]
        if url.scheme() == "file" {
            return url
                .to_file_path()
                .map(|project_path| Self::OpenEditor { project_path })
                .map_err(|_| ActionParseFromUrlError::Invalid);
        }

        // All programmatic deep links use the "action" domain:
        // cap-desktop://action?value=<JSON>
        match url.domain() {
            Some(v) if v != "action" => return Err(ActionParseFromUrlError::NotAction),
            _ => {}
        };

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

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

impl DeepLinkAction {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        match self {
            // ----------------------------------------------------------------
            // Start Recording
            // ----------------------------------------------------------------
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
                        .ok_or_else(|| format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                        .ok_or_else(|| format!("No window with name \"{}\"", &name))?,
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

            // ----------------------------------------------------------------
            // Stop Recording
            // ----------------------------------------------------------------
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
            }

            // ----------------------------------------------------------------
            // Pause Recording
            // ----------------------------------------------------------------
            DeepLinkAction::PauseRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_lock = state.read().await;

                let recording = app_lock
                    .current_recording()
                    .ok_or_else(|| "No active recording to pause".to_string())?;

                recording
                    .pause()
                    .await
                    .map_err(|e| format!("Failed to pause recording: {e}"))?;

                crate::recording::RecordingEvent::Paused.emit(app).ok();
                Ok(())
            }

            // ----------------------------------------------------------------
            // Resume Recording
            // ----------------------------------------------------------------
            DeepLinkAction::ResumeRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_lock = state.read().await;

                let recording = app_lock
                    .current_recording()
                    .ok_or_else(|| "No active recording to resume".to_string())?;

                let is_paused = recording
                    .is_paused()
                    .await
                    .map_err(|e| format!("Failed to query pause state: {e}"))?;

                if !is_paused {
                    return Err("Recording is not currently paused".to_string());
                }

                recording
                    .resume()
                    .await
                    .map_err(|e| format!("Failed to resume recording: {e}"))?;

                crate::recording::RecordingEvent::Resumed.emit(app).ok();
                Ok(())
            }

            // ----------------------------------------------------------------
            // Toggle Pause / Resume
            // ----------------------------------------------------------------
            DeepLinkAction::TogglePauseRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_lock = state.read().await;

                let recording = app_lock
                    .current_recording()
                    .ok_or_else(|| "No active recording".to_string())?;

                let is_paused = recording
                    .is_paused()
                    .await
                    .map_err(|e| format!("Failed to query pause state: {e}"))?;

                if is_paused {
                    recording
                        .resume()
                        .await
                        .map_err(|e| format!("Failed to resume recording: {e}"))?;

                    crate::recording::RecordingEvent::Resumed.emit(app).ok();
                    Ok(())
                } else {
                    recording
                        .pause()
                        .await
                        .map_err(|e| format!("Failed to pause recording: {e}"))?;

                    crate::recording::RecordingEvent::Paused.emit(app).ok();
                    Ok(())
                }
            }

            // ----------------------------------------------------------------
            // Switch Microphone
            // ----------------------------------------------------------------
            DeepLinkAction::SwitchMicrophone { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, label).await
            }

            // ----------------------------------------------------------------
            // Switch Camera
            // ----------------------------------------------------------------
            DeepLinkAction::SwitchCamera { id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, id, None).await
            }

            // ----------------------------------------------------------------
            // Open Editor
            // ----------------------------------------------------------------
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }

            // ----------------------------------------------------------------
            // Open Settings
            // ----------------------------------------------------------------
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
        }
    }
}
