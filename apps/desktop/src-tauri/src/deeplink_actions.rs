use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url, Runtime, Emitter};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow, MutableState};
use crate::recording::{InProgressRecording, RecordingEvent, RecordingState};

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
    SwitchCamera {
        camera_id: DeviceOrModelID,
    },
    SwitchMic {
        mic_label: String,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
    GetStatus,
}

#[derive(Debug, Clone, Serialize)]
struct RecordingStatusPayload {
    status: String,
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

fn emit_status_change<R: Runtime>(app: &AppHandle<R>, status: &str) {
    let _ = app.emit_all("cap://recording-status", RecordingStatusPayload {
        status: status.to_string(),
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
                let state: MutableState<'_, App> = app.state();

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
                    .map(|_| {
                        emit_status_change(app, "recording");
                    })
            }
            DeepLinkAction::StopRecording => {
                let state: MutableState<'_, App> = app.state();
                crate::recording::stop_recording(app.clone(), state).await.map(|_| {
                    emit_status_change(app, "idle");
                })
            }
            DeepLinkAction::PauseRecording => {
                let state: MutableState<'_, App> = app.state();
                let mut state_guard = state.write().await;
                if let RecordingState::Active(recording) = &mut state_guard.recording_state {
                    recording.pause().await.map_err(|e| e.to_string())?;
                    RecordingEvent::Paused.emit(app).ok();
                    emit_status_change(app, "paused");
                }
                Ok(())
            }
            DeepLinkAction::ResumeRecording => {
                let state: MutableState<'_, App> = app.state();
                let mut state_guard = state.write().await;
                if let RecordingState::Active(recording) = &mut state_guard.recording_state {
                    recording.resume().await.map_err(|e| e.to_string())?;
                    RecordingEvent::Resumed.emit(app).ok();
                    emit_status_change(app, "recording");
                }
                Ok(())
            }
            DeepLinkAction::TogglePauseRecording => {
                let state: MutableState<'_, App> = app.state();
                let mut state_guard = state.write().await;
                if let RecordingState::Active(recording) = &mut state_guard.recording_state {
                    let is_paused = recording.is_paused().await.map_err(|e| e.to_string())?;
                    if is_paused {
                        recording.resume().await.map_err(|e| e.to_string())?;
                        RecordingEvent::Resumed.emit(app).ok();
                        emit_status_change(app, "recording");
                    } else {
                        recording.pause().await.map_err(|e| e.to_string())?;
                        RecordingEvent::Paused.emit(app).ok();
                        emit_status_change(app, "paused");
                    }
                }
                Ok(())
            }
            DeepLinkAction::SwitchCamera { camera_id } => {
                let state: MutableState<'_, App> = app.state();
                crate::set_camera_input(app.clone(), state, Some(camera_id), None).await
            }
            DeepLinkAction::SwitchMic { mic_label } => {
                let state: MutableState<'_, App> = app.state();
                crate::set_mic_input(state, Some(mic_label)).await
            }
            DeepLinkAction::GetStatus => {
                let state: MutableState<'_, App> = app.state();
                let state_guard = state.read().await;
                let status = match &state_guard.recording_state {
                    RecordingState::None => "idle",
                    RecordingState::Pending { .. } => "pending",
                    RecordingState::Active(recording) => {
                        if recording.is_paused().await.unwrap_or(false) {
                            "paused"
                        } else {
                            "recording"
                        }
                    }
                };
                emit_status_change(app, status);
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
