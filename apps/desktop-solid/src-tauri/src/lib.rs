mod camera;
mod display;
mod ffmpeg;
mod macos;
mod utils;

use ffmpeg::{FFmpegRawSourceEncoder, FFmpegRecording, NamedPipeCapture};
use scap::Target;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;
use tokio::sync::RwLock;

use camera::{create_camera_window, get_cameras};
use display::{get_capture_windows, CaptureTarget};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    capture_target: CaptureTarget,
    camera_label: Option<String>,
}

pub struct InProgressRecording {
    recording_path: PathBuf,
    ffmpeg_recording: FFmpegRecording,
    display_capture: NamedPipeCapture,
    camera_capture: Option<NamedPipeCapture>,
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    current_recording: Option<InProgressRecording>,
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

    dbg!(&recording_options);

    let id = uuid::Uuid::new_v4().to_string();

    let recording_path = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));
    std::fs::create_dir_all(&recording_path).unwrap();
    let content_path = recording_path.join("content");

    let mut ffmpeg = FFmpegRawSourceEncoder::new();

    let camera_capture = {
        let Some(camera_info) = recording_options
            .camera_label
            .as_ref()
            .and_then(|camera_label| {
                camera::get_cameras()
                    .into_iter()
                    .find(|c| &c.human_name == camera_label)
            })
        else {
            todo!()
        };
        let source = camera::start_recording(&content_path, "camera", camera_info).await;

        Some(ffmpeg.add_source(move |cmd, i| source.apply_to_ffmpeg(cmd, i)))
    };

    let display_capture = {
        let camera_window_target =
            app.get_webview_window(camera::CAMERA_WINDOW)
                .and_then(|window| {
                    let ns_window = window.ns_window().unwrap() as *const objc2_app_kit::NSWindow;

                    let window_id = unsafe { (*ns_window).windowNumber() };
                    scap::get_all_targets()
                        .into_iter()
                        .find(|target| match target {
                            Target::Window(window) => window.raw_handle as isize == window_id,
                            _ => false,
                        })
                });

        let display_source = display::start_recording(
            &content_path,
            "display",
            &recording_options.capture_target,
            camera_window_target,
        );

        ffmpeg.add_source(move |cmd, i| display_source.apply_to_ffmpeg(cmd, i))
    };

    let current_recording = InProgressRecording {
        recording_path,
        ffmpeg_recording: ffmpeg.start(),
        display_capture,
        camera_capture,
    };

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

    current_recording.ffmpeg_recording.stop();
    current_recording.display_capture.stop();
    if let Some(camera_capture) = current_recording.camera_capture {
        camera_capture.stop();
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
            stop_recording,
            get_cameras,
            get_capture_windows
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

            app.manage(Arc::new(RwLock::new(AppState {
                start_recording_options: RecordingOptions {
                    capture_target: CaptureTarget::Display,
                    camera_label: None,
                },
                current_recording: None,
            })));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
