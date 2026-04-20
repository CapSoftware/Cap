use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;
use tauri_specta::Event;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow, recording_settings::RecordingSettingsStore, NewNotification};

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
        #[serde(default)]
        capture_mode: Option<CaptureMode>,
        #[serde(default)]
        camera: Option<DeviceOrModelID>,
        #[serde(default)]
        mic_label: Option<String>,
        #[serde(default)]
        capture_system_audio: Option<bool>,
        #[serde(default)]
        mode: Option<RecordingMode>,
    },
    StopRecording,
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    MuteRecording,
    UnmuteRecording,
    ToggleMuteRecording,
    TakeScreenshot,
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
                NewNotification {
                    title: "Action Failed".to_string(),
                    body: e,
                    is_error: true,
                }
                .emit(&app_handle)
                .ok();
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

        let host = url.host_str().unwrap_or("");

        if host == "action" {
            let params = url
                .query_pairs()
                .collect::<std::collections::HashMap<_, _>>();
            let json_value = params
                .get("value")
                .ok_or(ActionParseFromUrlError::Invalid)?;
            let action: Self = serde_json::from_str(json_value)
                .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))?;
            return Ok(action);
        }

        match host {
            "start-recording" => Ok(Self::StartRecording {
                capture_mode: None,
                camera: None,
                mic_label: None,
                capture_system_audio: None,
                mode: None,
            }),
            "stop-recording" => Ok(Self::StopRecording),
            "pause-recording" => Ok(Self::PauseRecording),
            "resume-recording" => Ok(Self::ResumeRecording),
            "toggle-pause-recording" => Ok(Self::TogglePauseRecording),
            "mute-recording" => Ok(Self::MuteRecording),
            "unmute-recording" => Ok(Self::UnmuteRecording),
            "toggle-mute-recording" => Ok(Self::ToggleMuteRecording),
            "take-screenshot" => Ok(Self::TakeScreenshot),
            _ => Err(ActionParseFromUrlError::NotAction),
        }
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

                let settings = RecordingSettingsStore::get(app).ok().flatten().unwrap_or_default();

                let camera = camera.or(settings.camera_id);
                let mic_label = mic_label.or(settings.mic_name);
                let capture_system_audio = capture_system_audio.unwrap_or(settings.system_audio);
                let mode = mode.or(settings.mode).unwrap_or(RecordingMode::Instant);

                crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
                crate::set_mic_input(state.clone(), mic_label).await?;

                let capture_target: ScreenCaptureTarget = if let Some(capture_mode) = capture_mode {
                    match capture_mode {
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
                    }
                } else {
                    settings.target.unwrap_or_else(|| {
                        ScreenCaptureTarget::Display {
                            id: Display::get_containing_cursor().unwrap_or_else(Display::primary).id(),
                        }
                    })
                };

                let inputs = StartRecordingInputs {
                    mode,
                    capture_target,
                    capture_system_audio,
                    organization_id: settings.organization_id,
                };

                crate::recording::start_recording(app.clone(), state, inputs)
                    .await
                    .map(|_| ())?;

                NewNotification {
                    title: "Recording Started".to_string(),
                    body: "Recording has begun.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await?;
                NewNotification {
                    title: "Recording Stopped".to_string(),
                    body: "Recording has been saved.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::PauseRecording => {
                crate::recording::pause_recording(app.clone(), app.state()).await?;
                NewNotification {
                    title: "Recording Paused".to_string(),
                    body: "Recording is now paused.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::ResumeRecording => {
                crate::recording::resume_recording(app.clone(), app.state()).await?;
                NewNotification {
                    title: "Recording Resumed".to_string(),
                    body: "Recording has been resumed.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::TogglePauseRecording => {
                crate::recording::toggle_pause_recording(app.clone(), app.state()).await?;
                Ok(())
            }
            DeepLinkAction::MuteRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_state = state.read().await;
                app_state.mic_feed.tell(cap_recording::feeds::microphone::Mute).await.map_err(|e| e.to_string())?;
                NewNotification {
                    title: "Microphone Muted".to_string(),
                    body: "Microphone is now muted.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::UnmuteRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_state = state.read().await;
                app_state.mic_feed.tell(cap_recording::feeds::microphone::Unmute).await.map_err(|e| e.to_string())?;
                NewNotification {
                    title: "Microphone Unmuted".to_string(),
                    body: "Microphone is now active.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::ToggleMuteRecording => {
                let state = app.state::<ArcLock<App>>();
                let app_state = state.read().await;
                let muted = app_state.mic_feed.ask(cap_recording::feeds::microphone::ToggleMute).await.map_err(|e| e.to_string())?;
                NewNotification {
                    title: if muted { "Microphone Muted" } else { "Microphone Unmuted" }.to_string(),
                    body: if muted { "Microphone is now muted." } else { "Microphone is now active." }.to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
                Ok(())
            }
            DeepLinkAction::TakeScreenshot => {
                let settings = RecordingSettingsStore::get(app).ok().flatten().unwrap_or_default();
                let target = settings.target.unwrap_or_else(|| {
                    ScreenCaptureTarget::Display {
                        id: Display::get_containing_cursor().unwrap_or_else(Display::primary).id(),
                    }
                });
                crate::recording::take_screenshot(app.clone(), target).await.map(|_| ())?;
                NewNotification {
                    title: "Screenshot Taken".to_string(),
                    body: "Screenshot has been saved.".to_string(),
                    is_error: false,
                }
                .emit(app)
                .ok();
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
    use super::*;
    use tauri::Url;

    #[test]
    fn test_parse_simple_actions() {
        let urls = [
            ("cap://start-recording", "start-recording"),
            ("cap://stop-recording", "stop-recording"),
            ("cap://pause-recording", "pause-recording"),
            ("cap://resume-recording", "resume-recording"),
            ("cap://toggle-pause-recording", "toggle-pause-recording"),
            ("cap://take-screenshot", "take-screenshot"),
            ("cap://mute-recording", "mute-recording"),
            ("cap://unmute-recording", "unmute-recording"),
            ("cap://toggle-mute-recording", "toggle-mute-recording"),
        ];

        for (url_str, expected_host) in urls {
            let url = Url::parse(url_str).unwrap();
            let action = DeepLinkAction::try_from(&url);
            assert!(action.is_ok(), "Failed to parse action for {}", url_str);
        }
    }

    #[test]
    fn test_parse_complex_action() {
        let json = r#"{"start_recording":{"mic_label":"Blue Yeti","capture_system_audio":true}}"#;
        // Hardcoded URL-encoded value of the JSON string above
        let encoded_json = "%7B%22start_recording%22%3A%7B%22mic_label%22%3A%22Blue%20Yeti%22%2C%22capture_system_audio%22%3Atrue%7D%7D";
        let url_str = format!("cap://action?value={}", encoded_json);
        let url = Url::parse(&url_str).unwrap();
        let action = DeepLinkAction::try_from(&url).unwrap();

        match action {
            DeepLinkAction::StartRecording { mic_label, capture_system_audio, .. } => {
                assert_eq!(mic_label, Some("Blue Yeti".to_string()));
                assert_eq!(capture_system_audio, Some(true));
            }
            _ => panic!("Expected StartRecording action"),
        }
    }

    #[test]
    fn test_invalid_action() {
        let url = Url::parse("cap://invalid-action").unwrap();
        let action = DeepLinkAction::try_from(&url);
        assert!(matches!(action, Err(ActionParseFromUrlError::NotAction)));
    }
}
