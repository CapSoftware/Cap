use std::sync::Arc;

use tauri::{AppHandle, Manager, Url};
use tokio::sync::RwLock;

use crate::{
    auth::{AuthState, AuthStore},
    App,
};

#[derive(Debug)]
enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug)]
enum DeepLinkAction {
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
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) {
    #[cfg(debug_assertions)]
    println!("Handling deep actions for: {:?}", &urls);

    let actions: Vec<_> = urls
        .into_iter()
        .filter(|url| !url.as_str().is_empty())
        .filter_map(|url| DeepLinkAction::try_from(&url).ok())
        .collect();

    let handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        for action in actions {
            if let Err(e) = action.handle(&handle).await {
                eprintln!("Failed to handle deep link action: {}", e);
            }
        }
    });
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = String;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        let path = url.path();
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();

        match path {
            "/signin" => Ok(DeepLinkAction::SignIn(AuthStore {
                token: params
                    .get("token")
                    .and_then(|t| {
                        if !t.is_empty() && t.len() >= 32 {
                            Some(t)
                        } else {
                            None
                        }
                    })
                    .ok_or("Missing or incorrect 'token' parameter for OAuth")?
                    .to_string(),
                user_id: Some(
                    params
                        .get("user_id")
                        .ok_or("Missing 'user_id' parameter for OAuth")?
                        .to_string(),
                ),
                expires: params
                    .get("expires")
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0),
                plan: None,
            })),
            "/start_recording" => Ok(DeepLinkAction::StartRecording {
                mode: params
                    .get("mode")
                    .and_then(|mode| match mode.to_string().as_str() {
                        "screen" => params
                            .get("target_native_name")
                            .map(|name| CaptureMode::Screen(name.to_string())),
                        // TODO(Ilya) handle once screen area support is added.
                        "area" => params
                            .get("target_native_name")
                            .map(|name| CaptureMode::Screen(name.to_string())),
                        "window" => params
                            .get("target_native_name")
                            .map(|name| CaptureMode::Window(name.to_string())),
                        _ => None,
                    })
                    .ok_or("Invalid mode")?,
                camera_label: params.get("camera_label").map(|s| s.to_string()),
                audio_input_name: params.get("audio_input_name").map(|s| s.to_string()),
                fps: params.get("fps").and_then(|s| s.parse().ok()),
                output_resolution: params.get("output_resolution").and_then(|v| {
                    let mut parts = v.split('x');
                    let width = parts.next().and_then(|s| s.parse().ok());
                    let height = parts.next().and_then(|s| s.parse().ok());
                    width.zip(height).map(|(w, h)| cap_project::Resolution {
                        width: w,
                        height: h,
                    })
                }),
            }),
            "/stop_recording" => Ok(DeepLinkAction::StopRecording),
            "/editor" => Ok(DeepLinkAction::OpenEditor(
                params
                    .get("id")
                    .ok_or("Missing \"id\" parameter for editor")?
                    .to_string(),
            )),
            _ => Err(format!("Unsupported deep-link path: {}", path).into()),
        }
    }
}

impl DeepLinkAction {
    async fn handle(self, app: &AppHandle) -> Result<(), String> {
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
                        .find(|s| s.0.name == name)
                        .map(|(s, _)| ScreenCaptureTarget::Screen(s))
                        .ok_or(format!("No screen with name \"{}\"", &name))?,
                    CaptureMode::Window(name) => cap_media::sources::list_windows()
                        .into_iter()
                        .find(|w| w.0.name == name)
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
        }
    }
}
