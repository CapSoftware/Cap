//! Deep link action handling for Cap screen recorder.
//!
//! This module provides deeplink support for controlling Cap via URL schemes.
//! Deeplinks follow the format: `cap://action?value=<url-encoded-json>`
//!
//! # Supported Actions
//! - `start_recording` - Start a new recording
//! - `stop_recording` - Stop current recording
//! - `pause_recording` - Pause current recording
//! - `resume_recording` - Resume paused recording
//! - `switch_microphone` - Change microphone input
//! - `switch_camera` - Change camera input
//! - `open_editor` - Open project in editor
//! - `open_settings` - Open settings page

use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

/// Capture mode specifying what to record.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    /// Capture a specific screen by name
    Screen(String),
    /// Capture a specific window by name
    Window(String),
}

/// Actions that can be invoked via deeplinks.
///
/// Each variant maps to a specific Cap operation that can be triggered
/// remotely via the `cap://action?value=<json>` URL scheme.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepLinkAction {
    /// Start a new recording with specified parameters.
    StartRecording {
        capture_mode: CaptureMode,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    /// Stop the current recording.
    StopRecording,
    /// Pause the current recording (can be resumed later).
    PauseRecording,
    /// Resume a previously paused recording.
    ResumeRecording,
    /// Switch to a different microphone input.
    /// Pass `None` to disable microphone.
    SwitchMicrophone {
        mic_label: Option<String>,
    },
    /// Switch to a different camera input.
    /// Pass `None` to disable camera.
    SwitchCamera {
        camera_id: Option<DeviceOrModelID>,
    },
    /// Open a project in the Cap editor.
    OpenEditor {
        project_path: PathBuf,
    },
    /// Open the Cap settings window.
    /// Optionally navigate to a specific settings page.
    OpenSettings {
        page: Option<String>,
    },
}

/// Handle incoming deeplink URLs.
///
/// Parses each URL into a `DeepLinkAction` and executes them asynchronously.
/// Invalid URLs are logged and skipped.
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

/// Errors that can occur when parsing a deeplink URL.
pub enum ActionParseFromUrlError {
    /// JSON parsing failed with the given error message.
    ParseFailed(String),
    /// URL format is invalid (missing required parameters).
    Invalid,
    /// URL is valid but not an action URL (e.g., login callback).
    NotAction,
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = ActionParseFromUrlError;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        #[cfg(target_os = "macos")]
        if url.scheme() == "file" {
            let project_path = url
                .to_file_path()
                .map_err(|_| ActionParseFromUrlError::ParseFailed(
                    "Invalid file URL: could not convert to file path".to_string()
                ))?;
            return Ok(Self::OpenEditor { project_path });
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
    /// Execute this deeplink action.
    ///
    /// # Errors
    /// Returns an error string if the action fails (e.g., device not found,
    /// recording not in expected state, etc.).
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
            DeepLinkAction::SwitchMicrophone { mic_label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state.clone(), mic_label).await
            }
            DeepLinkAction::SwitchCamera { camera_id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state.clone(), camera_id, None).await
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
