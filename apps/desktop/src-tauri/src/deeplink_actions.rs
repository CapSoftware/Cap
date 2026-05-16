use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_specta::Event;
use tracing::trace;

use crate::{
    App, ArcLock, RequestOpenRecordingPicker, RequestStartRecording,
    recording::StartRecordingInputs, recording_settings::RecordingTargetMode,
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
    StartRecordingWithSettings {
        mode: RecordingMode,
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
    TogglePauseRecording,
    SetMicInput {
        label: Option<String>,
    },
    SetCameraInput {
        id: Option<DeviceOrModelID>,
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
    fn confirmation_message(&self) -> Option<&'static str> {
        match self {
            Self::StartRecordingWithSettings { .. } | Self::StartRecording { .. } => {
                Some("A deep link is requesting permission to start a Cap recording.")
            }
            Self::StopRecording => {
                Some("A deep link is requesting permission to stop the current Cap recording.")
            }
            Self::PauseRecording | Self::ResumeRecording | Self::TogglePauseRecording => {
                Some("A deep link is requesting permission to control the current Cap recording.")
            }
            Self::SetMicInput { .. } => {
                Some("A deep link is requesting permission to change Cap's microphone input.")
            }
            Self::SetCameraInput { .. } => {
                Some("A deep link is requesting permission to change Cap's camera input.")
            }
            Self::OpenRecordingPicker { .. } => {
                Some("A deep link is requesting permission to open Cap's recording picker.")
            }
            Self::OpenEditor { .. } | Self::OpenSettings { .. } => None,
        }
    }

    fn confirm_if_sensitive(&self, app: &AppHandle) -> Result<(), String> {
        let Some(message) = self.confirmation_message() else {
            return Ok(());
        };

        let confirmed = app
            .dialog()
            .message(message)
            .title("Allow Cap deep link?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Allow".to_string(),
                "Cancel".to_string(),
            ))
            .blocking_show();

        if confirmed {
            Ok(())
        } else {
            Err("Deep link action cancelled".to_string())
        }
    }

    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        self.confirm_if_sensitive(app)?;

        match self {
            DeepLinkAction::StartRecordingWithSettings { mode } => {
                RequestStartRecording { mode }
                    .emit(app)
                    .map_err(|err| err.to_string())
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
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::SetMicInput { label } => crate::set_mic_input(app.state(), label).await,
            DeepLinkAction::SetCameraInput { id } => {
                crate::set_camera_input(app.clone(), app.state(), id, None).await
            }
            DeepLinkAction::OpenRecordingPicker { target_mode } => RequestOpenRecordingPicker {
                target_mode,
            }
            .emit(app)
            .map_err(|err| err.to_string()),
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
        }
    }
}
