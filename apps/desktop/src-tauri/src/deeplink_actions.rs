use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
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
    #[cfg(debug_assertions)]
    PauseRecording,
    #[cfg(debug_assertions)]
    ResumeRecording,
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

        match url.domain() {
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
            #[cfg(debug_assertions)]
            DeepLinkAction::PauseRecording => {
                crate::recording::pause_recording(app.clone(), app.state()).await
            }
            #[cfg(debug_assertions)]
            DeepLinkAction::ResumeRecording => {
                crate::recording::resume_recording(app.clone(), app.state()).await
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
    }
}
