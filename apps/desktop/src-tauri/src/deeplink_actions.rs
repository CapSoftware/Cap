use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{App, ArcLock, recording::StartRecordingInputs, windows::ShowCapWindow};

#[cfg(debug_assertions)]
use tauri::Emitter;

#[cfg(debug_assertions)]
use crate::camera::CameraPreviewState;

#[cfg(debug_assertions)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CaptureArea {
    screen: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
    #[cfg(debug_assertions)]
    Area(Box<CaptureArea>),
    #[cfg(debug_assertions)]
    CameraOnly,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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
    TakeScreenshot,
    SetCamera {
        device_id: String,
    },
    SetMicrophone {
        device_id: String,
    },
    #[cfg(debug_assertions)]
    OpenCamera {
        camera: DeviceOrModelID,
    },
    #[cfg(debug_assertions)]
    SetCameraPreviewState {
        state: CameraPreviewState,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
}

pub struct DeepLinkActionExecutor {
    tx: std::sync::mpsc::Sender<DeepLinkAction>,
}

impl DeepLinkActionExecutor {
    pub fn new(app: &AppHandle) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<DeepLinkAction>();
        let app_handle = app.clone();
        let runtime = tokio::runtime::Handle::current();

        trace!("Starting deep link action executor");
        let thread_result = std::thread::Builder::new()
            .name("deep-link-action-executor".to_string())
            .spawn(move || {
                trace!("Deep link action executor started");
                for action in rx {
                    trace!(?action, "Executing deep link action");
                    if let Err(err) = runtime.block_on(action.execute(&app_handle)) {
                        eprintln!("Failed to handle deep link action: {err}");
                    }
                }
            });

        if let Err(err) = thread_result {
            eprintln!("Failed to start deep link action executor: {err}");
        }

        Self { tx }
    }

    fn dispatch(
        &self,
        action: DeepLinkAction,
    ) -> Result<(), std::sync::mpsc::SendError<DeepLinkAction>> {
        self.tx.send(action)
    }
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

    trace!(action_count = actions.len(), "Parsed deep link actions");

    if actions.is_empty() {
        return;
    }

    let Some(executor) = app_handle.try_state::<DeepLinkActionExecutor>() else {
        eprintln!("Deep link action executor unavailable");
        return;
    };

    for action in actions {
        trace!(?action, "Queueing deep link action");
        if let Err(err) = executor.dispatch(action) {
            eprintln!("Failed to queue deep link action: {err}");
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
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

        if url.scheme() != "cap-desktop" {
            return Err(ActionParseFromUrlError::NotAction);
        }

        let host = url.host_str().unwrap_or_default();
        if host == "login" || host == "signin" || host == "auth" || host == "oauth" {
            return Err(ActionParseFromUrlError::NotAction);
        }

        let params: HashMap<_, _> = url.query_pairs().collect();

        if host == "action" {
            if let Some(json_value) = params.get("value") {
                let action: Self = serde_json::from_str(json_value)
                    .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))?;
                return Ok(action);
            }

            let path_action = url.path().trim_matches('/');
            if !path_action.is_empty() {
                return Self::from_action_name(path_action, &params);
            }

            return Err(ActionParseFromUrlError::Invalid);
        }

        if !host.is_empty() {
            Self::from_action_name(host, &params)
        } else {
            let path_action = url.path().trim_matches('/');
            if !path_action.is_empty() {
                Self::from_action_name(path_action, &params)
            } else {
                Err(ActionParseFromUrlError::Invalid)
            }
        }
    }
}

impl DeepLinkAction {
    fn from_action_name(
        action_name: &str,
        params: &HashMap<std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>>,
    ) -> Result<Self, ActionParseFromUrlError> {
        if let Some(json_value) = params.get("value") {
            if let Ok(action) = serde_json::from_str::<Self>(json_value) {
                return Ok(action);
            }
        }

        let normalized = action_name.to_ascii_lowercase().replace('-', "_");
        match normalized.as_str() {
            "pause_recording" | "pause" => Ok(Self::PauseRecording),
            "resume_recording" | "resume" => Ok(Self::ResumeRecording),
            "toggle_pause_recording" | "toggle_pause" => Ok(Self::TogglePauseRecording),
            "take_screenshot" | "screenshot" => Ok(Self::TakeScreenshot),
            "stop_recording" | "stop" => Ok(Self::StopRecording),
            "set_camera" | "camera" => {
                let device_id = params
                    .get("device_id")
                    .or_else(|| params.get("deviceId"))
                    .or_else(|| params.get("camera_id"))
                    .or_else(|| params.get("cameraId"))
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("device"))
                    .or_else(|| params.get("camera"))
                    .or_else(|| params.get("value"))
                    .map(|s| s.to_string());

                if let Some(device_id) = device_id {
                    Ok(Self::SetCamera { device_id })
                } else {
                    Err(ActionParseFromUrlError::Invalid)
                }
            }
            "set_microphone" | "set_mic" | "microphone" | "mic" => {
                let device_id = params
                    .get("device_id")
                    .or_else(|| params.get("deviceId"))
                    .or_else(|| params.get("mic_id"))
                    .or_else(|| params.get("micId"))
                    .or_else(|| params.get("mic_label"))
                    .or_else(|| params.get("micLabel"))
                    .or_else(|| params.get("id"))
                    .or_else(|| params.get("device"))
                    .or_else(|| params.get("microphone"))
                    .or_else(|| params.get("mic"))
                    .or_else(|| params.get("value"))
                    .map(|s| s.to_string());

                if let Some(device_id) = device_id {
                    Ok(Self::SetMicrophone { device_id })
                } else {
                    Err(ActionParseFromUrlError::Invalid)
                }
            }
            "open_settings" | "settings" => {
                let page = params
                    .get("page")
                    .or_else(|| params.get("value"))
                    .map(|s| s.to_string());
                Ok(Self::OpenSettings { page })
            }
            "open_editor" | "editor" => {
                let project_path = params
                    .get("project_path")
                    .or_else(|| params.get("projectPath"))
                    .or_else(|| params.get("path"))
                    .or_else(|| params.get("value"))
                    .map(|s| PathBuf::from(s.as_ref()));

                if let Some(project_path) = project_path {
                    Ok(Self::OpenEditor { project_path })
                } else {
                    Err(ActionParseFromUrlError::Invalid)
                }
            }
            "start_recording" | "start" => {
                if let Some(json_value) = params.get("value") {
                    serde_json::from_str(json_value)
                        .map_err(|e| ActionParseFromUrlError::ParseFailed(e.to_string()))
                } else {
                    Err(ActionParseFromUrlError::Invalid)
                }
            }
            _ => Err(ActionParseFromUrlError::NotAction),
        }
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
                    #[cfg(debug_assertions)]
                    CaptureMode::Area(area) => {
                        if area.width <= 0.0 || area.height <= 0.0 {
                            return Err("Area width and height must be positive".to_string());
                        }
                        let screen = cap_recording::screen_capture::list_displays()
                            .into_iter()
                            .find(|(display, _)| display.name == area.screen)
                            .map(|(display, _)| display.id)
                            .ok_or(format!("No screen with name \"{}\"", &area.screen))?;
                        ScreenCaptureTarget::Area {
                            screen,
                            bounds: scap_targets::bounds::LogicalBounds::new(
                                scap_targets::bounds::LogicalPosition::new(area.x, area.y),
                                scap_targets::bounds::LogicalSize::new(area.width, area.height),
                            ),
                        }
                    }
                    #[cfg(debug_assertions)]
                    CaptureMode::CameraOnly => ScreenCaptureTarget::CameraOnly,
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
            DeepLinkAction::TakeScreenshot => {
                use scap_targets::Display;

                let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
                let target = ScreenCaptureTarget::Display { id: display.id() };

                match crate::recording::take_screenshot(app.clone(), target.clone()).await {
                    Ok(path) => {
                        if crate::automation::should_open_screenshot_editor(app, &target) {
                            let _ = ShowCapWindow::ScreenshotEditor { path }.show(app).await;
                        }
                        Ok(())
                    }
                    Err(err) => Err(format!("Failed to take screenshot: {err}")),
                }
            }
            DeepLinkAction::SetCamera { device_id } => {
                let camera = if device_id.is_empty() || device_id.eq_ignore_ascii_case("none") {
                    None
                } else {
                    let id = DeviceOrModelID::DeviceID(device_id);
                    Some(id)
                };
                crate::set_camera_input(app.clone(), app.state::<ArcLock<App>>(), camera, None)
                    .await
            }
            DeepLinkAction::SetMicrophone { device_id } => {
                let mic = if device_id.is_empty() || device_id.eq_ignore_ascii_case("none") {
                    None
                } else {
                    let mic_names = cap_recording::feeds::microphone::MicrophoneFeed::list_names();
                    let matched = crate::find_mic_by_label_or_fuzzy(&mic_names, &device_id)
                        .unwrap_or(device_id);
                    Some(matched)
                };
                crate::set_mic_input(app.state::<ArcLock<App>>(), mic).await
            }
            #[cfg(debug_assertions)]
            DeepLinkAction::OpenCamera { camera } => {
                crate::set_camera_input(
                    app.clone(),
                    app.state::<ArcLock<App>>(),
                    Some(camera),
                    None,
                )
                .await?;

                if crate::general_settings::GeneralSettingsStore::native_camera_preview_enabled(app)
                {
                    crate::set_native_camera_preview_enabled(
                        app.clone(),
                        app.state::<ArcLock<App>>(),
                        true,
                    )
                    .await?;
                }

                app.emit("instant-mode-harness-camera-opened", ())
                    .map_err(|err| err.to_string())?;
                for delay_ms in [250, 750, 1500] {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    app.emit("instant-mode-harness-camera-opened", ())
                        .map_err(|err| err.to_string())?;
                }

                Ok(())
            }
            #[cfg(debug_assertions)]
            DeepLinkAction::SetCameraPreviewState { state } => {
                crate::set_camera_preview_state(app.state(), state).await
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

    #[test]
    fn parses_stop_recording_action_url() {
        let url = Url::parse("cap-desktop://action?value=%22stop_recording%22").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StopRecording)
        );

        let direct_url = Url::parse("cap-desktop://stop_recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_url),
            Ok(DeepLinkAction::StopRecording)
        );

        let hyphen_url = Url::parse("cap-desktop://stop-recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_url),
            Ok(DeepLinkAction::StopRecording)
        );

        let short_url = Url::parse("cap-desktop://stop").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&short_url),
            Ok(DeepLinkAction::StopRecording)
        );
    }

    #[test]
    fn parses_pause_and_resume_action_urls() {
        let pause_url = Url::parse("cap-desktop://action?value=%22pause_recording%22").unwrap();
        let resume_url = Url::parse("cap-desktop://action?value=%22resume_recording%22").unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&pause_url),
            Ok(DeepLinkAction::PauseRecording)
        );
        assert_eq!(
            DeepLinkAction::try_from(&resume_url),
            Ok(DeepLinkAction::ResumeRecording)
        );

        let direct_pause = Url::parse("cap-desktop://pause_recording").unwrap();
        let direct_resume = Url::parse("cap-desktop://resume_recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_pause),
            Ok(DeepLinkAction::PauseRecording)
        );
        assert_eq!(
            DeepLinkAction::try_from(&direct_resume),
            Ok(DeepLinkAction::ResumeRecording)
        );

        let hyphen_pause = Url::parse("cap-desktop://pause-recording").unwrap();
        let hyphen_resume = Url::parse("cap-desktop://resume-recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_pause),
            Ok(DeepLinkAction::PauseRecording)
        );
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_resume),
            Ok(DeepLinkAction::ResumeRecording)
        );

        let short_pause = Url::parse("cap-desktop://pause").unwrap();
        let short_resume = Url::parse("cap-desktop://resume").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&short_pause),
            Ok(DeepLinkAction::PauseRecording)
        );
        assert_eq!(
            DeepLinkAction::try_from(&short_resume),
            Ok(DeepLinkAction::ResumeRecording)
        );
    }

    #[test]
    fn parses_toggle_pause_action_urls() {
        let json_url =
            Url::parse("cap-desktop://action?value=%22toggle_pause_recording%22").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&json_url),
            Ok(DeepLinkAction::TogglePauseRecording)
        );

        let direct_url = Url::parse("cap-desktop://toggle_pause_recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_url),
            Ok(DeepLinkAction::TogglePauseRecording)
        );

        let hyphen_url = Url::parse("cap-desktop://toggle-pause-recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_url),
            Ok(DeepLinkAction::TogglePauseRecording)
        );

        let short_url = Url::parse("cap-desktop://toggle_pause").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&short_url),
            Ok(DeepLinkAction::TogglePauseRecording)
        );
    }

    #[test]
    fn parses_take_screenshot_action_urls() {
        let json_url = Url::parse("cap-desktop://action?value=%22take_screenshot%22").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&json_url),
            Ok(DeepLinkAction::TakeScreenshot)
        );

        let direct_url = Url::parse("cap-desktop://take_screenshot").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_url),
            Ok(DeepLinkAction::TakeScreenshot)
        );

        let hyphen_url = Url::parse("cap-desktop://take-screenshot").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_url),
            Ok(DeepLinkAction::TakeScreenshot)
        );

        let short_url = Url::parse("cap-desktop://screenshot").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&short_url),
            Ok(DeepLinkAction::TakeScreenshot)
        );
    }

    #[test]
    fn parses_set_camera_action_urls() {
        let value = serde_json::json!({
            "set_camera": {
                "device_id": "camera-facetime-1"
            }
        })
        .to_string();
        let json_url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&json_url),
            Ok(DeepLinkAction::SetCamera {
                device_id: "camera-facetime-1".to_string()
            })
        );

        let direct_url =
            Url::parse("cap-desktop://set_camera?device_id=camera-facetime-1").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_url),
            Ok(DeepLinkAction::SetCamera {
                device_id: "camera-facetime-1".to_string()
            })
        );

        let hyphen_url = Url::parse("cap-desktop://set-camera?deviceId=camera-facetime-1").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_url),
            Ok(DeepLinkAction::SetCamera {
                device_id: "camera-facetime-1".to_string()
            })
        );

        let camera_alias_url =
            Url::parse("cap-desktop://camera?camera_id=camera-facetime-1").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&camera_alias_url),
            Ok(DeepLinkAction::SetCamera {
                device_id: "camera-facetime-1".to_string()
            })
        );
    }

    #[test]
    fn parses_set_microphone_action_urls() {
        let value = serde_json::json!({
            "set_microphone": {
                "device_id": "mic-shure-mv7"
            }
        })
        .to_string();
        let json_url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&json_url),
            Ok(DeepLinkAction::SetMicrophone {
                device_id: "mic-shure-mv7".to_string()
            })
        );

        let direct_url =
            Url::parse("cap-desktop://set_microphone?device_id=mic-shure-mv7").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&direct_url),
            Ok(DeepLinkAction::SetMicrophone {
                device_id: "mic-shure-mv7".to_string()
            })
        );

        let hyphen_url =
            Url::parse("cap-desktop://set-microphone?mic_label=mic-shure-mv7").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&hyphen_url),
            Ok(DeepLinkAction::SetMicrophone {
                device_id: "mic-shure-mv7".to_string()
            })
        );

        let mic_alias_url = Url::parse("cap-desktop://set_mic?id=mic-shure-mv7").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&mic_alias_url),
            Ok(DeepLinkAction::SetMicrophone {
                device_id: "mic-shure-mv7".to_string()
            })
        );
    }

    #[test]
    fn parses_open_editor_and_settings_action_urls() {
        let editor_url =
            Url::parse("cap-desktop://open_editor?project_path=%2Fpath%2Fto%2Fproject").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&editor_url),
            Ok(DeepLinkAction::OpenEditor {
                project_path: PathBuf::from("/path/to/project")
            })
        );

        let settings_url = Url::parse("cap-desktop://settings?page=shortcuts").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&settings_url),
            Ok(DeepLinkAction::OpenSettings {
                page: Some("shortcuts".to_string())
            })
        );
    }

    #[test]
    fn parses_action_path_format() {
        let path_url = Url::parse("cap-desktop://action/pause_recording").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&path_url),
            Ok(DeepLinkAction::PauseRecording)
        );

        let camera_path_url =
            Url::parse("cap-desktop://action/set_camera?device_id=cam-123").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&camera_path_url),
            Ok(DeepLinkAction::SetCamera {
                device_id: "cam-123".to_string()
            })
        );
    }

    #[test]
    fn handles_invalid_and_malformed_action_urls() {
        let malformed_json_url = Url::parse("cap-desktop://action?value={invalid").unwrap();
        assert!(matches!(
            DeepLinkAction::try_from(&malformed_json_url),
            Err(ActionParseFromUrlError::ParseFailed(_))
        ));

        let missing_camera_id_url = Url::parse("cap-desktop://set_camera").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&missing_camera_id_url),
            Err(ActionParseFromUrlError::Invalid)
        );

        let missing_mic_id_url = Url::parse("cap-desktop://set_microphone").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&missing_mic_id_url),
            Err(ActionParseFromUrlError::Invalid)
        );

        let empty_action_url = Url::parse("cap-desktop://action").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&empty_action_url),
            Err(ActionParseFromUrlError::Invalid)
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_open_camera_action_url() {
        let value = serde_json::json!({
            "open_camera": {
                "camera": { "DeviceID": "camera-1" }
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::OpenCamera {
                camera: DeviceOrModelID::DeviceID("camera-1".to_string())
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_camera_preview_state_action_url() {
        let value = serde_json::json!({
            "set_camera_preview_state": {
                "state": {
                    "size": 400.0,
                    "shape": "full",
                    "mirrored": true,
                    "background_blur": "heavy"
                }
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::SetCameraPreviewState {
                state: CameraPreviewState {
                    size: 400.0,
                    shape: crate::camera::CameraPreviewShape::Full,
                    mirrored: true,
                    background_blur: cap_project::BackgroundBlurMode::Heavy,
                }
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_area_recording_action_url() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": {
                    "area": {
                        "screen": "Built-in Retina Display",
                        "x": 10.0,
                        "y": 20.0,
                        "width": 800.0,
                        "height": 600.0
                    }
                },
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "microphone-1",
                "capture_system_audio": false,
                "mode": "instant"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StartRecording {
                capture_mode: CaptureMode::Area(Box::new(CaptureArea {
                    screen: "Built-in Retina Display".to_string(),
                    x: 10.0,
                    y: 20.0,
                    width: 800.0,
                    height: 600.0,
                })),
                camera: Some(DeviceOrModelID::DeviceID("camera-1".to_string())),
                mic_label: Some("microphone-1".to_string()),
                capture_system_audio: false,
                mode: RecordingMode::Instant,
            })
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_camera_only_recording_action_url() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": "camera_only",
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "microphone-1",
                "capture_system_audio": false,
                "mode": "studio"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Ok(DeepLinkAction::StartRecording {
                capture_mode: CaptureMode::CameraOnly,
                camera: Some(DeviceOrModelID::DeviceID("camera-1".to_string())),
                mic_label: Some("microphone-1".to_string()),
                capture_system_audio: false,
                mode: RecordingMode::Studio,
            })
        );
    }

    #[test]
    fn parses_start_recording_action_url() {
        let url = Url::parse(
            "cap-desktop://action?value=%7B%22start_recording%22%3A%7B%22capture_mode%22%3A%7B%22screen%22%3A%22Odyssey%20G93SC%22%7D%2C%22camera%22%3Anull%2C%22mic_label%22%3A%22Shure%20MV7%2B%22%2C%22capture_system_audio%22%3Atrue%2C%22mode%22%3A%22studio%22%7D%7D",
        )
        .unwrap();

        let Ok(DeepLinkAction::StartRecording {
            capture_mode,
            camera,
            mic_label,
            capture_system_audio,
            mode,
        }) = DeepLinkAction::try_from(&url)
        else {
            panic!("expected start recording action");
        };

        assert_eq!(
            capture_mode,
            CaptureMode::Screen("Odyssey G93SC".to_string())
        );
        assert_eq!(camera, None);
        assert_eq!(mic_label.as_deref(), Some("Shure MV7+"));
        assert!(capture_system_audio);
        assert_eq!(mode, RecordingMode::Studio);
    }

    #[test]
    fn parses_start_recording_action_with_camera_device_id() {
        let value = serde_json::json!({
            "start_recording": {
                "capture_mode": { "screen": "Odyssey G93SC" },
                "camera": { "DeviceID": "camera-1" },
                "mic_label": "Shure MV7+",
                "capture_system_audio": true,
                "mode": "studio"
            }
        })
        .to_string();
        let url = Url::parse_with_params("cap-desktop://action", &[("value", value)]).unwrap();

        let Ok(DeepLinkAction::StartRecording {
            camera,
            mic_label,
            capture_system_audio,
            ..
        }) = DeepLinkAction::try_from(&url)
        else {
            panic!("expected start recording action");
        };

        assert_eq!(
            camera,
            Some(DeviceOrModelID::DeviceID("camera-1".to_string()))
        );
        assert_eq!(mic_label.as_deref(), Some("Shure MV7+"));
        assert!(capture_system_audio);
    }

    #[test]
    fn rejects_non_action_host() {
        let url = Url::parse("cap-desktop://login?value=%22stop_recording%22").unwrap();

        assert_eq!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::NotAction)
        );

        let signin_url = Url::parse("cap-desktop://signin?token=abc").unwrap();
        assert_eq!(
            DeepLinkAction::try_from(&signin_url),
            Err(ActionParseFromUrlError::NotAction)
        );
    }
}
