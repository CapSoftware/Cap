use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tracing::trace;

use crate::{
    App, ArcLock,
    recording::{self, StartRecordingInputs},
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
            Some("action") => Ok(()),
            Some(_) => Err(ActionParseFromUrlError::NotAction),
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
                confirm_sensitive_action(app, "start a recording")?;
                let state = app.state::<ArcLock<App>>();

                crate::set_camera_input(app.clone(), state.clone(), camera, None).await?;
                crate::set_mic_input(state.clone(), mic_label).await?;

                let capture_target = resolve_capture_target(capture_mode)?;

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
                confirm_sensitive_action(app, "stop the active recording")?;
                crate::recording::stop_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::PauseRecording => {
                confirm_sensitive_action(app, "pause the active recording")?;
                recording::pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::ResumeRecording => {
                confirm_sensitive_action(app, "resume the active recording")?;
                recording::resume_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::TogglePauseRecording => {
                confirm_sensitive_action(app, "toggle recording pause")?;
                recording::toggle_pause_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                confirm_sensitive_action(app, "take a screenshot")?;
                let target = resolve_capture_target(capture_mode)?;
                let path = recording::take_screenshot(app.clone(), target).await?;
                let _ = ShowCapWindow::ScreenshotEditor { path }.show(app).await;
                Ok(())
            }
            DeepLinkAction::SetMicrophone { mic_label } => {
                confirm_sensitive_action(app, "change the active microphone")?;
                with_recording_paused_for_input_change(app, async {
                    crate::set_mic_input(app.state(), mic_label).await
                })
                .await
            }
            DeepLinkAction::SetCamera { camera } => {
                confirm_sensitive_action(app, "change the active camera")?;
                with_recording_paused_for_input_change(app, async {
                    crate::set_camera_input(app.clone(), app.state(), camera, Some(true)).await
                })
                .await
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

fn confirm_sensitive_action(app: &AppHandle, action: &str) -> Result<(), String> {
    let approved = app
        .dialog()
        .message(format!(
            "An external app or website requested to {action} in Cap."
        ))
        .title("Confirm Cap action")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Allow".to_string(),
            "Cancel".to_string(),
        ))
        .blocking_show();

    if approved {
        Ok(())
    } else {
        Err("Cap action cancelled".to_string())
    }
}

fn resolve_capture_target(capture_mode: CaptureMode) -> Result<ScreenCaptureTarget, String> {
    match capture_mode {
        CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
            .into_iter()
            .find(|(s, _)| s.name == name)
            .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
            .ok_or(format!("No screen with name \"{}\"", &name)),
        CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
            .into_iter()
            .find(|(w, _)| w.name == name)
            .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
            .ok_or(format!("No window with name \"{}\"", &name)),
    }
}

async fn with_recording_paused_for_input_change<F>(
    app: &AppHandle,
    input_change: F,
) -> Result<(), String>
where
    F: Future<Output = Result<(), String>>,
{
    let should_resume = {
        let state = app.state::<ArcLock<App>>();
        let state = state.read().await;
        match state.current_recording() {
            Some(recording) => !recording.is_paused().await.map_err(|e| e.to_string())?,
            None => false,
        }
    };

    if should_resume {
        recording::pause_recording(app.clone(), app.state()).await?;
    }

    match input_change.await {
        Ok(()) => {
            if should_resume {
                recording::resume_recording(app.clone(), app.state()).await?;
            }
            Ok(())
        }
        Err(err) => {
            if should_resume {
                recording::resume_recording(app.clone(), app.state())
                    .await
                    .map_err(|resume_err| {
                        format!("{err}; failed to resume recording after input change error: {resume_err}")
                    })?;
            }
            Err(err)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action_from(value: &str) -> DeepLinkAction {
        let mut url = Url::parse("cap-desktop://action").unwrap();
        url.query_pairs_mut().append_pair("value", value);
        DeepLinkAction::try_from(&url).unwrap()
    }

    #[test]
    fn parses_action_host_links() {
        let action = action_from(r#"{"pause_recording":null}"#);

        assert!(matches!(action, DeepLinkAction::PauseRecording));
    }

    #[test]
    fn keeps_signin_links_out_of_action_handler() {
        let url = Url::parse("cap-desktop://signin?token=abc").unwrap();

        assert!(matches!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::NotAction)
        ));
    }

    #[test]
    fn parses_nullable_input_actions() {
        let mic = action_from(r#"{"set_microphone":{"mic_label":null}}"#);
        let camera = action_from(r#"{"set_camera":{"camera":null}}"#);

        assert!(matches!(
            mic,
            DeepLinkAction::SetMicrophone { mic_label: None }
        ));
        assert!(matches!(camera, DeepLinkAction::SetCamera { camera: None }));
    }
}
