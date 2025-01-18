use std::sync::Arc;

use futures::TryFutureExt;
use tauri::{AppHandle, Manager, Url};
use tokio::sync::RwLock;

use crate::auth::{AuthState, AuthStore};

#[derive(Debug)]
enum CaptureMode {
    Screen(String),
    Window(String),
}

#[derive(Debug)]
enum DeepLinkAction {
    Oauth(AuthStore),
    StartRecording {
        mode: Option<CaptureMode>,
        camera: Option<String>,
        microphone: Option<String>,
    },
    StopRecording,
    OpenEditor(String),
}

pub fn handle(app_handle: &AppHandle, urls: Vec<Url>) -> Result<(), String> {
    for url in urls {
        if url.as_str().is_empty() {
            continue;
        }

        if let Ok(action) = DeepLinkAction::try_from(&url) {
            let handle = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = action.handle(&handle).await {
                    eprintln!("Failed to handle deep link action: {}", e);
                }
            });
        }
    }

    Ok(())
}

impl TryFrom<&Url> for DeepLinkAction {
    type Error = String;

    fn try_from(url: &Url) -> Result<Self, Self::Error> {
        let path = url.path();
        let params: std::collections::HashMap<_, _> = url.query_pairs().collect();

        match path {
            "/oauth-signin" => Ok(DeepLinkAction::Oauth(AuthStore {
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
            "/start_recording" => {
                let mode = params
                    .get("mode")
                    .and_then(|mode| match mode.to_string().as_str() {
                        "screen" => params
                            .get("target_native_id")
                            .map(|id| CaptureMode::Screen(id.to_string())),
                        "window" => params
                            .get("target_native_id")
                            .map(|id| CaptureMode::Window(id.to_string())),
                        _ => None,
                    });

                Ok(DeepLinkAction::StartRecording {
                    mode,
                    camera: params.get("camera").map(|s| s.to_string()),
                    microphone: params.get("mic").map(|s| s.to_string()),
                })
            }
            "/stop_recording" => Ok(DeepLinkAction::StopRecording),
            "/editor" => {
                let id = params
                    .get("id")
                    .ok_or("Missing 'id' parameter for editor")?
                    .to_string();
                Ok(DeepLinkAction::OpenEditor(id))
            }
            _ => {
                // if let Some(source) = params.get("from") {
                //     Ok(DeepLinkAction::Custom {
                //         source: source.to_string(),
                //         action: path.trim_start_matches('/').to_string(),
                //     })
                // } else {
                Err(format!("Unsupported deep-link path: {}", path).into())
            }
        }
    }
}

impl DeepLinkAction {
    async fn handle(self, app: &AppHandle) -> Result<(), String> {
        match self {
            Self::Oauth(auth) => {
                let app_state = app.state::<Arc<RwLock<crate::App>>>();
                let reader_guard = app_state.read().await;

                match &reader_guard.auth_state {
                    Some(AuthState::Listening) => {
                        AuthStore::set(app, Some(auth))?;
                        Ok(())
                    }
                    None | Some(_) => Err("Not listening for OAuth events".into()),
                }
            }
            _ => Err("Not implemented".into()),
            // DeepLinkAction::StartRecording {
            //     mode,
            //     camera,
            //     microphone,
            // } => {
            //     let state = app.state::<Arc<RwLock<App>>>();
            //     let capture_target = match mode {
            //         Some(CaptureMode::Screen(name)) => {
            //             let screens = ScreenCaptureSource::<AVFrameCapture>::list_screens();
            //             screens
            //                 .into_iter()
            //                 .find(|screen| screen.name == name)
            //                 .map(|screen| {
            //                     ScreenCaptureTarget::Screen(CaptureScreen {
            //                         id: screen.id,
            //                         name: screen.name,
            //                     })
            //                 })
            //                 .unwrap_or_else(|| {
            //                     // Default to first screen if target not found
            //                     let first = ScreenCaptureSource::<AVFrameCapture>::list_screens()
            //                         .into_iter()
            //                         .next()
            //                         .expect("No screens available");
            //                     ScreenCaptureTarget::Screen(CaptureScreen {
            //                         id: first.id,
            //                         name: first.name,
            //                     })
            //                 })
            //         }
            //         Some(CaptureMode::Window(name)) => {
            //             let windows = ScreenCaptureSource::<AVFrameCapture>::list_windows();
            //             windows
            //                 .into_iter()
            //                 .find(|window| window.name == name)
            //                 .map(|window| {
            //                     ScreenCaptureTarget::Window(CaptureWindow {
            //                         id: window.id,
            //                         name: window.name,
            //                         owner_name: window.owner_name,
            //                     })
            //                 })
            //                 .ok_or("Window not found")?
            //         }
            //         None => {
            //             // Default to first screen
            //             let first = ScreenCaptureSource::<AVFrameCapture>::list_screens()
            //                 .into_iter()
            //                 .next()
            //                 .expect("No screens available");
            //             ScreenCaptureTarget::Screen(CaptureScreen {
            //                 id: first.id,
            //                 name: first.name,
            //             })
            //         }
            //     };

            //     set_recording_options(
            //         state,
            //         RecordingOptions {
            //             capture_target,
            //             camera_label: camera,
            //             audio_input_name: microphone,
            //         },
            //     )
            //     .await?;

            //     start_recording(app.clone(), app.state()).await
            // }
            // DeepLinkAction::StopRecording => stop_recording(app.clone(), app.state()).await,
            // DeepLinkAction::OpenEditor(id) => {
            //     open_editor(app.clone(), id);
            //     Ok(())
            // }
            // DeepLinkAction::Custom { source, action } => {
            //     println!("Custom action '{}' from source '{}'", action, source);
            //     // Handle custom actions (e.g., open Raycast extension)
            //     Ok(())
            // }
        }
    }
}

// let app_handle_clone = app_handle.clone();
// app_handle.deep_link().on_open_url(move |event| {
//     if let Some(url) = event.urls().first() {
//         println!("Received deeplink: {}", url);

//         if let Ok(parsed_url) = url::Url::parse(url) {
//             let app_handle = app_handle_clone.clone();

//             match DeepLinkAction::from_url(&parsed_url) {
//                 Some(action) => {
//                     println!("Handling deep link action: {:?}", action);
//                     tauri::async_runtime::spawn(async move {
//                         if let Err(e) = action.handle(&app_handle).await {
//                             eprintln!("Failed to handle deep link action: {}", e);
//                         }
//                     });
//                 }
//                 None => println!("Could not parse deep link action from URL: {}", url),
//             }
//         } else {
//             println!("Invalid URL format: {}", url);
//         }
//     }
// });
