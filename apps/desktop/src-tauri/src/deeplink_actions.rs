use cap_recording::{
    RecordingMode, feeds::camera::DeviceOrModelID, sources::screen_capture::ScreenCaptureTarget,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Url};
use tracing::trace;

use crate::{
    App, ArcLock,
    hotkeys::{self, HotkeyAction},
    recording::StartRecordingInputs,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    tray,
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
    StartRecordingWithCurrentSettings {
        mode: RecordingMode,
    },
    RunHotkeyAction {
        action: HotkeyAction,
    },
    StopRecording,
    RestartRecording,
    TogglePauseRecording,
    CycleRecordingMode,
    SetRecordingMode {
        mode: RecordingMode,
    },
    OpenMain,
    OpenRecordingPicker {
        target_mode: Option<RecordingTargetMode>,
    },
    OpenEditor {
        project_path: PathBuf,
    },
    OpenSettings {
        page: Option<String>,
    },
    OpenRecordings,
    OpenScreenshots,
    TakeScreenshot {
        target: ScreenshotTarget,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_action_deeplink() {
        let mut url = Url::parse("cap-desktop://action").unwrap();
        url.query_pairs_mut().append_pair(
            "value",
            &serde_json::to_string(&DeepLinkAction::RunHotkeyAction {
                action: HotkeyAction::ScreenshotArea,
            })
            .unwrap(),
        );

        let action = DeepLinkAction::try_from(&url).unwrap();

        match action {
            DeepLinkAction::RunHotkeyAction { action } => {
                assert_eq!(action, HotkeyAction::ScreenshotArea);
            }
            _ => panic!("expected RunHotkeyAction"),
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
            DeepLinkAction::StartRecordingWithCurrentSettings { mode } => {
                start_recording_with_current_settings(app, mode).await
            }
            DeepLinkAction::RunHotkeyAction { action } => {
                hotkeys::handle_action(app.clone(), action).await
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::RestartRecording => {
                hotkeys::handle_action(app.clone(), HotkeyAction::RestartRecording).await
            }
            DeepLinkAction::TogglePauseRecording => {
                hotkeys::handle_action(app.clone(), HotkeyAction::TogglePauseRecording).await
            }
            DeepLinkAction::CycleRecordingMode => {
                hotkeys::handle_action(app.clone(), HotkeyAction::CycleRecordingMode).await
            }
            DeepLinkAction::SetRecordingMode { mode } => set_recording_mode(app, mode),
            DeepLinkAction::OpenMain => {
                crate::show_window(
                    app.clone(),
                    ShowCapWindow::Main {
                        init_target_mode: None,
                    },
                )
                .await
            }
            DeepLinkAction::OpenRecordingPicker { target_mode } => {
                open_recording_picker(app, target_mode).await
            }
            DeepLinkAction::OpenEditor { project_path } => {
                crate::open_project_from_path(Path::new(&project_path), app.clone())
            }
            DeepLinkAction::OpenSettings { page } => {
                crate::show_window(app.clone(), ShowCapWindow::Settings { page }).await
            }
            DeepLinkAction::OpenRecordings => {
                open_settings_page(app, "recordings".to_string()).await
            }
            DeepLinkAction::OpenScreenshots => {
                open_settings_page(app, "screenshots".to_string()).await
            }
            DeepLinkAction::TakeScreenshot { target } => take_screenshot(app, target).await,
        }
    }
}

async fn start_recording_with_current_settings(
    app: &AppHandle,
    mode: RecordingMode,
) -> Result<(), String> {
    let settings = RecordingSettingsStore::get(app)
        .ok()
        .flatten()
        .unwrap_or_default();
    let state = app.state::<ArcLock<App>>();

    crate::set_mic_input(state.clone(), settings.mic_name).await?;
    crate::set_camera_input(app.clone(), state.clone(), settings.camera_id, None).await?;

    let capture_target = settings.target.unwrap_or_else(|| {
        use scap_targets::Display;

        ScreenCaptureTarget::Display {
            id: Display::primary().id(),
        }
    });

    crate::recording::start_recording(
        app.clone(),
        state,
        StartRecordingInputs {
            capture_target,
            mode,
            capture_system_audio: settings.system_audio,
            organization_id: settings.organization_id,
        },
    )
    .await
    .map(|_| ())
}

async fn open_recording_picker(
    app: &AppHandle,
    target_mode: Option<RecordingTargetMode>,
) -> Result<(), String> {
    if let Some(target_mode) = target_mode {
        crate::open_target_picker(app, target_mode).await;
        return Ok(());
    }

    crate::show_window(
        app.clone(),
        ShowCapWindow::Main {
            init_target_mode: None,
        },
    )
    .await
}

async fn open_settings_page(app: &AppHandle, page: String) -> Result<(), String> {
    crate::show_window(app.clone(), ShowCapWindow::Settings { page: Some(page) }).await
}

fn set_recording_mode(app: &AppHandle, mode: RecordingMode) -> Result<(), String> {
    RecordingSettingsStore::set_mode(app, mode)?;
    tray::update_tray_icon_for_mode(app, mode);
    Ok(())
}

async fn take_screenshot(app: &AppHandle, target: ScreenshotTarget) -> Result<(), String> {
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
            set_recording_mode(app, RecordingMode::Screenshot)?;
            crate::open_target_picker(app, RecordingTargetMode::Area).await;
            return Ok(());
        }
    };

    match crate::recording::take_screenshot(app.clone(), capture_target).await {
        Ok(path) => crate::show_window(app.clone(), ShowCapWindow::ScreenshotEditor { path }).await,
        Err(e) => Err(format!("Failed to take screenshot: {e}")),
    }
}
