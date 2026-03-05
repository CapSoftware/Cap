use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use scap_targets::Display;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tracing::trace;

use crate::{
    App, ArcLock, permissions, recording::StartRecordingInputs,
    recording_settings::RecordingSettingsStore, windows::ShowCapWindow,
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
        capture_mode: Option<CaptureMode>,
        camera: Option<DeviceOrModelID>,
        mic_label: Option<String>,
        capture_system_audio: bool,
        mode: RecordingMode,
    },
    StartCurrentRecording {
        mode: Option<RecordingMode>,
    },
    StopRecording,
    PauseRecording,
    ResumeRecording,
    TogglePauseRecording,
    RestartRecording,
    TakeScreenshot {
        capture_mode: Option<CaptureMode>,
    },
    ListCameras,
    SetCamera {
        id: Option<DeviceOrModelID>,
    },
    ListMicrophones,
    SetMicrophone {
        label: Option<String>,
    },
    ListDisplays,
    ListWindows,
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

        match url.host_str() {
            Some("action") => {}
            Some(_) => return Err(ActionParseFromUrlError::NotAction),
            None => return Err(ActionParseFromUrlError::Invalid),
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

impl DeepLinkAction {
    fn resolve_capture_target(capture_mode: &CaptureMode) -> Result<ScreenCaptureTarget, String> {
        match capture_mode {
            CaptureMode::Screen(name) => cap_recording::screen_capture::list_displays()
                .into_iter()
                .find(|(s, _)| s.name.eq_ignore_ascii_case(name))
                .map(|(s, _)| ScreenCaptureTarget::Display { id: s.id })
                .ok_or(format!("No screen with name \"{}\"", name)),
            CaptureMode::Window(name) => cap_recording::screen_capture::list_windows()
                .into_iter()
                .find(|(w, _)| w.name.eq_ignore_ascii_case(name))
                .map(|(w, _)| ScreenCaptureTarget::Window { id: w.id })
                .ok_or(format!("No window with name \"{}\"", name)),
        }
    }

    fn default_display_target() -> Result<ScreenCaptureTarget, String> {
        if cap_recording::screen_capture::list_displays().is_empty() {
            return Err("No displays found".to_string());
        }
        Ok(ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        })
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

                let capture_target = match capture_mode {
                    Some(mode) => Self::resolve_capture_target(&mode)?,
                    None => Self::default_display_target()?,
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
            DeepLinkAction::StartCurrentRecording { mode } => {
                let settings = RecordingSettingsStore::get(app)
                    .inspect_err(|e| eprintln!("Failed to read recording settings: {e}"))
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                let RecordingSettingsStore {
                    target,
                    mic_name,
                    camera_id,
                    mode: saved_mode,
                    system_audio,
                    organization_id,
                } = settings;

                let state = app.state::<ArcLock<App>>();

                crate::set_mic_input(state.clone(), mic_name).await?;
                crate::set_camera_input(app.clone(), state.clone(), camera_id, None).await?;

                let inputs = StartRecordingInputs {
                    mode: mode.or(saved_mode).unwrap_or(RecordingMode::Studio),
                    capture_target: match target {
                        Some(t) => t,
                        None => Self::default_display_target()?,
                    },
                    capture_system_audio: system_audio,
                    organization_id,
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
            DeepLinkAction::RestartRecording => {
                crate::recording::restart_recording(app.clone(), app.state())
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::TakeScreenshot { capture_mode } => {
                let target = match capture_mode {
                    Some(mode) => Self::resolve_capture_target(&mode)?,
                    None => Self::default_display_target()?,
                };

                crate::recording::take_screenshot(app.clone(), target)
                    .await
                    .map(|_| ())
            }
            DeepLinkAction::ListCameras => {
                if !permissions::do_permissions_check(false).camera.permitted() {
                    return Err("Camera permission not granted".to_string());
                }
                let cameras = crate::recording::list_cameras();
                let json = serde_json::to_string(&cameras).map_err(|e| e.to_string())?;
                app.clipboard()
                    .write_text(&json)
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            DeepLinkAction::SetCamera { id } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_camera_input(app.clone(), state, id, None).await
            }
            DeepLinkAction::ListMicrophones => {
                let mics = cap_recording::feeds::microphone::MicrophoneFeed::list();
                let mut labels: Vec<String> = mics.keys().cloned().collect();
                labels.sort();
                let json = serde_json::to_string(&labels).map_err(|e| e.to_string())?;
                app.clipboard()
                    .write_text(&json)
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            DeepLinkAction::SetMicrophone { label } => {
                let state = app.state::<ArcLock<App>>();
                crate::set_mic_input(state, label).await
            }
            DeepLinkAction::ListDisplays => {
                if !permissions::do_permissions_check(false)
                    .screen_recording
                    .permitted()
                {
                    return Err("Screen recording permission not granted".to_string());
                }
                let displays = crate::recording::list_capture_displays().await;
                let json = serde_json::to_string(&displays).map_err(|e| e.to_string())?;
                app.clipboard()
                    .write_text(&json)
                    .map_err(|e| e.to_string())?;
                Ok(())
            }
            DeepLinkAction::ListWindows => {
                if !permissions::do_permissions_check(false)
                    .screen_recording
                    .permitted()
                {
                    return Err("Screen recording permission not granted".to_string());
                }
                let windows = crate::recording::list_capture_windows().await;
                let json = serde_json::to_string(&windows).map_err(|e| e.to_string())?;
                app.clipboard()
                    .write_text(&json)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn action_url(value: &str) -> String {
        let mut url = Url::parse("cap-desktop://action").unwrap();
        url.query_pairs_mut().append_pair("value", value);
        url.to_string()
    }

    fn parse(url_str: &str) -> Result<DeepLinkAction, ActionParseFromUrlError> {
        let url = Url::parse(url_str).unwrap();
        DeepLinkAction::try_from(&url)
    }

    #[test]
    fn parse_unit_variants() {
        let cases = [
            ("stop_recording", "StopRecording"),
            ("pause_recording", "PauseRecording"),
            ("resume_recording", "ResumeRecording"),
            ("toggle_pause_recording", "TogglePauseRecording"),
            ("restart_recording", "RestartRecording"),
            ("list_cameras", "ListCameras"),
            ("list_microphones", "ListMicrophones"),
            ("list_displays", "ListDisplays"),
            ("list_windows", "ListWindows"),
        ];

        for (action_str, label) in cases {
            let url = action_url(&format!("\"{}\"", action_str));
            let result = parse(&url);
            assert!(
                result.is_ok(),
                "Failed to parse {label}: {:?}",
                result.err()
            );
        }
    }

    #[test]
    fn parse_start_recording_studio() {
        let json = serde_json::json!({
            "start_recording": {
                "capture_mode": null,
                "camera": null,
                "mic_label": null,
                "capture_system_audio": false,
                "mode": "studio"
            }
        });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::StartRecording {
                mode: RecordingMode::Studio,
                ..
            }
        ));
    }

    #[test]
    fn parse_start_recording_instant() {
        let json = serde_json::json!({
            "start_recording": {
                "capture_mode": null,
                "camera": null,
                "mic_label": null,
                "capture_system_audio": true,
                "mode": "instant"
            }
        });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::StartRecording {
                mode: RecordingMode::Instant,
                capture_system_audio: true,
                ..
            }
        ));
    }

    #[test]
    fn parse_start_current_recording() {
        let json = serde_json::json!({ "start_current_recording": { "mode": null } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::StartCurrentRecording { mode: None }
        ));
    }

    #[test]
    fn parse_start_current_recording_with_mode() {
        let json = serde_json::json!({ "start_current_recording": { "mode": "instant" } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::StartCurrentRecording {
                mode: Some(RecordingMode::Instant)
            }
        ));
    }

    #[test]
    fn parse_take_screenshot() {
        let json = serde_json::json!({ "take_screenshot": { "capture_mode": null } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::TakeScreenshot { capture_mode: None }
        ));
    }

    #[test]
    fn parse_set_camera() {
        let json = serde_json::json!({ "set_camera": { "id": null } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::SetCamera { id: None }));
    }

    #[test]
    fn parse_set_microphone() {
        let json = serde_json::json!({ "set_microphone": { "label": "Built-in Microphone" } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::SetMicrophone { label: Some(_) }
        ));
    }

    #[test]
    fn parse_open_editor() {
        let json = serde_json::json!({ "open_editor": { "project_path": "/tmp/test-project" } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(action, DeepLinkAction::OpenEditor { .. }));
    }

    #[test]
    fn parse_open_settings() {
        let json = serde_json::json!({ "open_settings": { "page": "general" } });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::OpenSettings { page: Some(_) }
        ));
    }

    #[test]
    fn parse_invalid_domain_returns_not_action() {
        let url = "cap-desktop://something-else?value=%22stop_recording%22";
        let result = parse(url);
        assert!(matches!(result, Err(ActionParseFromUrlError::NotAction)));
    }

    #[test]
    fn parse_missing_value_param_returns_invalid() {
        let url = "cap-desktop://action?other=123";
        let result = parse(url);
        assert!(matches!(result, Err(ActionParseFromUrlError::Invalid)));
    }

    #[test]
    fn parse_malformed_json_returns_parse_failed() {
        let url = "cap-desktop://action?value=not-valid-json";
        let result = parse(url);
        assert!(matches!(
            result,
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));
    }

    #[test]
    fn parse_capture_mode_screen() {
        let json = serde_json::json!({
            "take_screenshot": {
                "capture_mode": { "screen": "Main Display" }
            }
        });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::TakeScreenshot {
                capture_mode: Some(CaptureMode::Screen(_))
            }
        ));
    }

    #[test]
    fn parse_capture_mode_window() {
        let json = serde_json::json!({
            "take_screenshot": {
                "capture_mode": { "window": "Safari" }
            }
        });
        let url = action_url(&json.to_string());
        let action = parse(&url).unwrap();
        assert!(matches!(
            action,
            DeepLinkAction::TakeScreenshot {
                capture_mode: Some(CaptureMode::Window(_))
            }
        ));
    }
}
