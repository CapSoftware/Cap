mod camera;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::sync::RwLock;

use camera::create_camera_window;

#[derive(Default, specta::Type, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    camera_label: Option<String>,
}

pub struct CurrentRecording {
    camera_recording: Option<camera::FfmpegRecording>,
}

#[derive(Default, specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    current_recording: Option<CurrentRecording>,
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

#[tauri::command]
#[specta::specta]
async fn get_recording_options(state: MutableState<'_, AppState>) -> Result<RecordingOptions, ()> {
    let state = state.read().await;
    Ok(state.start_recording_options.clone())
}

#[tauri::command]
#[specta::specta]
async fn set_recording_options(
    app: AppHandle,
    state: MutableState<'_, AppState>,
    options: RecordingOptions,
) -> Result<(), ()> {
    let mut state = state.write().await;
    state.start_recording_options = options;

    on_recording_options_change(&app, &state.start_recording_options);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn start_recording(app: AppHandle, state: MutableState<'_, AppState>) -> Result<(), String> {
    let mut state = state.write().await;
    let recording_options = &state.start_recording_options;

    let id = uuid::Uuid::new_v4().to_string();

    let recording_path = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    std::fs::create_dir_all(&recording_path).unwrap();

    let camera_info = recording_options
        .camera_label
        .as_ref()
        .and_then(|camera_label| {
            let cameras = dbg!(nokhwa::query(nokhwa::utils::ApiBackend::AVFoundation)).unwrap();

            cameras
                .into_iter()
                .find(|c| c.human_name().as_str() == camera_label)
        });

    let camera_recording = match camera_info {
        Some(camera_info) => {
            Some(camera::start_recording(&recording_path.join("camera"), camera_info).await)
        }
        _ => None,
    };

    let current_recording = CurrentRecording { camera_recording };

    state.current_recording = Some(current_recording);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(state: MutableState<'_, AppState>) -> Result<(), String> {
    let mut state = state.write().await;

    let Some(current_recording) = state.current_recording.take() else {
        return Err("Recording not in progress".to_string());
    };

    if let Some(camera_recording) = current_recording.camera_recording {
        camera_recording.stop();
    };

    Ok(())
}

fn on_recording_options_change(app: &AppHandle, options: &RecordingOptions) {
    match app.get_webview_window(camera::CAMERA_WINDOW) {
        Some(window) if options.camera_label.is_none() => {
            window.close().ok();
        }
        None if options.camera_label.is_some() => {
            create_camera_window(app.clone());
        }
        _ => {}
    };

    RecordingOptionsChanged.emit(app).ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            get_recording_options,
            set_recording_options,
            create_camera_window,
            start_recording,
            stop_recording
        ])
        .events(tauri_specta::collect_events![RecordingOptionsChanged]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            app.manage(Arc::new(RwLock::new(AppState::default())));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
