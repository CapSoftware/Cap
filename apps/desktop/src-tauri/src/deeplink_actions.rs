use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tokio::sync::Mutex;
use tracing::{trace, warn};

use crate::{
    App, ArcLock,
    recording::StartRecordingInputs,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    screenshot_post_capture::{self, ScreenshotPostCaptureAction},
    tray,
    windows::ShowCapWindow,
};

#[derive(Debug, Default)]
struct TemporaryScreenshotModeState {
    previous_mode: Option<RecordingMode>,
    active_count: usize,
}

impl TemporaryScreenshotModeState {
    fn begin(&mut self, previous_mode: Option<RecordingMode>) -> bool {
        if self.active_count > 0 {
            self.active_count += 1;
            return false;
        }

        if matches!(previous_mode, Some(RecordingMode::Screenshot)) {
            return false;
        }

        self.previous_mode = previous_mode;
        self.active_count = 1;
        true
    }

    fn restore(&mut self) -> Option<Option<RecordingMode>> {
        if self.active_count == 0 {
            return None;
        }

        self.active_count -= 1;
        if self.active_count > 0 {
            return None;
        }

        Some(self.previous_mode.take())
    }
}

static TEMPORARY_SCREENSHOT_MODE: Mutex<TemporaryScreenshotModeState> =
    Mutex::const_new(TemporaryScreenshotModeState {
        previous_mode: None,
        active_count: 0,
    });

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum ScreenshotTarget {
    CurrentDisplay,
    CurrentWindow,
    Area,
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
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
    TakeScreenshot {
        target: ScreenshotTarget,
        #[serde(default)]
        post_capture_action: Option<ScreenshotPostCaptureAction>,
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

        match url.domain() {
            Some("action") => {}
            Some(_) => return Err(ActionParseFromUrlError::NotAction),
            None => return Err(ActionParseFromUrlError::Invalid),
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
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
            DeepLinkAction::TakeScreenshot {
                target,
                post_capture_action,
            } => take_screenshot(app, target, post_capture_action).await,
        }
    }
}

async fn take_screenshot(
    app: &AppHandle,
    target: ScreenshotTarget,
    post_capture_action: Option<ScreenshotPostCaptureAction>,
) -> Result<(), String> {
    let capture_target = match target {
        ScreenshotTarget::CurrentDisplay => {
            use scap_targets::Display;

            let display = Display::get_containing_cursor().unwrap_or_else(Display::primary);
            ScreenCaptureTarget::Display { id: display.id() }
        }
        ScreenshotTarget::CurrentWindow => {
            use scap_targets::Window;

            let window = Window::get_topmost_at_cursor()
                .ok_or_else(|| "No window found under cursor".to_string())?;
            ScreenCaptureTarget::Window { id: window.id() }
        }
        ScreenshotTarget::Area => {
            if let Some(action) = post_capture_action {
                screenshot_post_capture::set_pending_action(app, action)?;
            } else {
                screenshot_post_capture::clear_pending_action(app);
            }

            if let Err(err) = begin_temporary_screenshot_mode(app).await {
                screenshot_post_capture::clear_pending_action(app);
                return Err(err);
            }

            crate::open_target_picker(app, RecordingTargetMode::Area).await;
            return Ok(());
        }
    };

    let action =
        post_capture_action.unwrap_or_else(|| ScreenshotPostCaptureAction::from_settings(app));
    let path = crate::recording::take_screenshot(app.clone(), capture_target)
        .await
        .map_err(|e| format!("Failed to take screenshot: {e}"))?;
    screenshot_post_capture::handle(app, path, action).await
}

fn set_recording_mode(app: &AppHandle, mode: RecordingMode) -> Result<(), String> {
    RecordingSettingsStore::set_mode(app, mode)?;
    tray::update_tray_icon_for_mode(app, mode);
    Ok(())
}

async fn begin_temporary_screenshot_mode(app: &AppHandle) -> Result<(), String> {
    let previous_mode = RecordingSettingsStore::get(app)
        .map(|settings| settings.and_then(|settings| settings.mode))?;

    let should_enable_screenshot_mode = {
        let mut temporary_mode = TEMPORARY_SCREENSHOT_MODE.lock().await;
        temporary_mode.begin(previous_mode)
    };

    if !should_enable_screenshot_mode {
        return Ok(());
    }

    if let Err(err) = set_recording_mode(app, RecordingMode::Screenshot) {
        let mut temporary_mode = TEMPORARY_SCREENSHOT_MODE.lock().await;
        let _ = temporary_mode.restore();
        return Err(err);
    }

    Ok(())
}

pub(crate) async fn restore_temporary_recording_mode(app: &AppHandle) {
    let previous_mode = {
        let mut temporary_mode = TEMPORARY_SCREENSHOT_MODE.lock().await;
        temporary_mode.restore()
    };

    let Some(previous_mode) = previous_mode else {
        return;
    };

    if let Err(err) = RecordingSettingsStore::set_mode_option(app, previous_mode) {
        warn!("Failed to restore recording mode after screenshot deeplink: {err}");
        return;
    }

    tray::update_tray_icon_for_mode(app, previous_mode.unwrap_or_default());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_take_screenshot_deeplink_with_post_capture_action() {
        let mut url = Url::parse("cap-desktop://action").unwrap();
        url.query_pairs_mut().append_pair(
            "value",
            &serde_json::to_string(&DeepLinkAction::TakeScreenshot {
                target: ScreenshotTarget::CurrentDisplay,
                post_capture_action: Some(ScreenshotPostCaptureAction::CopyToClipboard),
            })
            .unwrap(),
        );

        let action = DeepLinkAction::try_from(&url).unwrap();

        match action {
            DeepLinkAction::TakeScreenshot {
                target,
                post_capture_action,
            } => {
                assert_eq!(target, ScreenshotTarget::CurrentDisplay);
                assert_eq!(
                    post_capture_action,
                    Some(ScreenshotPostCaptureAction::CopyToClipboard)
                );
            }
            _ => panic!("expected TakeScreenshot"),
        }
    }

    #[test]
    fn ignores_non_action_deeplink() {
        let url = Url::parse("cap-desktop://login?value=ignored").unwrap();

        assert!(matches!(
            DeepLinkAction::try_from(&url),
            Err(ActionParseFromUrlError::NotAction)
        ));
    }

    #[test]
    fn temporary_screenshot_mode_restores_after_last_nested_flow() {
        let mut state = TemporaryScreenshotModeState::default();

        assert!(state.begin(Some(RecordingMode::Studio)));
        assert!(!state.begin(Some(RecordingMode::Screenshot)));
        assert_eq!(state.active_count, 2);

        assert_eq!(state.restore(), None);
        assert_eq!(state.restore(), Some(Some(RecordingMode::Studio)));
        assert_eq!(state.restore(), None);
    }

    #[test]
    fn temporary_screenshot_mode_preserves_missing_previous_mode() {
        let mut state = TemporaryScreenshotModeState::default();

        assert!(state.begin(None));

        assert_eq!(state.restore(), Some(None));
        assert_eq!(state.restore(), None);
    }

    #[test]
    fn temporary_screenshot_mode_noops_when_already_screenshot() {
        let mut state = TemporaryScreenshotModeState::default();

        assert!(!state.begin(Some(RecordingMode::Screenshot)));

        assert_eq!(state.active_count, 0);
        assert_eq!(state.restore(), None);
    }
}
