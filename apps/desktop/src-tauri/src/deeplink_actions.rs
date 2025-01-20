use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Url};
use tokio::sync::RwLock;

use crate::{
    auth::{AuthState, AuthStore},
    windows::ShowCapWindow,
    App,
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
    SignIn(AuthStore),
    StartRecording {
        mode: CaptureMode,
        camera_label: Option<String>,
        audio_input_name: Option<String>,
        fps: Option<u32>,
        output_resolution: Option<cap_project::Resolution>,
    },
    StopRecording,
    OpenEditor(String),
    OpenSettings,
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    #[cfg(debug_assertions)]
    println!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| {
            DeepLinkAction::try_from(&url)
                .map_err(|e| {
                    eprintln!("Failed to parse deep link \"{}\": {}", &url, e);
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
                eprintln!("Failed to handle deep link action: {}", e);
            }
        }
    });
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = String;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        if !url.domain().is_some_and(|v| v == "action") {
            return Err("Invalid format".into());
        }

        let params = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        let json_value = params.get("value").ok_or("No value")?;
        let action: Self = serde_json::from_str(json_value).map_err(|e| {
            format!(
                "Failed to parse deep-link action json value: {}",
                e.to_string()
            )
        })?;
        Ok(action)
    }
}

impl DeepLinkAction {
    pub async fn execute(self, app: &AppHandle) -> Result<(), String> {
        match self {
            Self::SignIn(auth) => {
                let app_state = app.state::<Arc<RwLock<App>>>();
                let reader_guard = app_state.read().await;

                match &reader_guard.auth_state {
                    Some(AuthState::Listening) => Ok(AuthStore::set(app, Some(auth))?),
                    _ => Err("Not listening for OAuth events".into()),
                }
            }
            DeepLinkAction::StartRecording {
                mode,
                camera_label,
                audio_input_name,
                fps,
                output_resolution,
            } => {
                use cap_media::sources::ScreenCaptureTarget;
                let capture_target: ScreenCaptureTarget = match mode {
                    CaptureMode::Screen(name) => cap_media::sources::list_screens()
                        .into_iter()
                        .find(|(s, _)| s.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Screen(s))
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_media::sources::list_windows()
                        .into_iter()
                        .find(|(w, _)| w.name == name)
                        .map(|(w, _)| ScreenCaptureTarget::Window(w))
                        .ok_or(format!("No window with name \"{}\"", &name))?,
                };

                let state = app.state::<Arc<RwLock<App>>>();
                crate::set_recording_options(
                    app.clone().to_owned(),
                    state,
                    cap_recording::RecordingOptions {
                        capture_target,
                        camera_label,
                        audio_input_name,
                        fps: fps.unwrap_or_default(),
                        output_resolution,
                    },
                )
                .await?;

                crate::recording::start_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::StopRecording => {
                crate::recording::stop_recording(app.clone(), app.state()).await
            }
            DeepLinkAction::OpenEditor(id) => {
                crate::open_editor(app.clone(), id);
                Ok(())
            }
            DeepLinkAction::OpenSettings => {
                _ = ShowCapWindow::Settings { page: None }
                    .show(app)
                    .map_err(|e| format!("Failed to open settings window: {}", e))?;
                Ok(())
            }
        }
    }
}
