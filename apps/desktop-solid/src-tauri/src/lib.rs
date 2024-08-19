mod camera;
mod display;
mod ffmpeg;
mod macos;
mod recording;
mod utils;
mod video_renderer;

use objc2_app_kit::{NSPopUpMenuWindowLevel, NSScreenSaverWindowLevel};
use recording::{DisplaySource, InProgressRecording};
// use macos::Bounds;
use scap::Target;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{
    collections::HashMap,
    marker::PhantomData,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_nspanel::{cocoa::appkit::NSMainMenuWindowLevel, ManagerExt};
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_specta::Event;
use tokio::{sync::RwLock, time::sleep};

use crate::utils::ffmpeg_path_as_str;
use camera::{create_camera_window, get_cameras};
use display::{get_capture_windows, CaptureTarget};
use ffmpeg::handle_ffmpeg_installation;

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    capture_target: CaptureTarget,
    camera_label: Option<String>,
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    current_recording: Option<InProgressRecording>,
    prev_recordings: Vec<PathBuf>,
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

// dedicated event + command used as panel must be accessed on main thread
#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct FocusCapturesPanel;

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

type Bruh<T> = (T,);

#[derive(Serialize, Type)]
struct JsonValue<T>(
    #[serde(skip)] PhantomData<T>,
    #[specta(type = Bruh<T>)] serde_json::Value,
);

impl<T: Serialize> JsonValue<T> {
    fn new(value: &T) -> Self {
        Self(PhantomData, json!(value))
    }
}

#[tauri::command]
#[specta::specta]
async fn get_current_recording(
    state: MutableState<'_, AppState>,
) -> Result<JsonValue<Option<InProgressRecording>>, ()> {
    let state = state.read().await;
    Ok(JsonValue::new(&state.current_recording))
}

#[tauri::command]
#[specta::specta]
async fn get_prev_recordings(state: MutableState<'_, AppState>) -> Result<Vec<PathBuf>, ()> {
    let state = state.read().await;
    Ok(state.prev_recordings.clone())
}

#[tauri::command]
#[specta::specta]
async fn start_recording(app: AppHandle, state: MutableState<'_, AppState>) -> Result<(), String> {
    let mut state = state.write().await;
    let recording_options = &state.start_recording_options;

    dbg!(&recording_options);

    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    let current_recording = recording::start(recording_dir, recording_options).await;
    let current_recording = state.current_recording.insert(current_recording);

    if let DisplaySource::Window { .. } = &current_recording.display_source {
        let monitor = app.primary_monitor().unwrap().unwrap();

        let occluder_window = WebviewWindow::builder(
            &app,
            "window-capture-occluder",
            tauri::WebviewUrl::App("/window-capture-occluder".into()),
        )
        .title("Cap Window Capture Occluder")
        .maximized(false)
        .resizable(false)
        .fullscreen(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .content_protected(true)
        .inner_size(
            (monitor.size().width as f64) / monitor.scale_factor(),
            (monitor.size().height as f64) / monitor.scale_factor(),
        )
        .position(0.0, 0.0)
        .build()
        .unwrap();

        occluder_window
            .set_window_level(NSScreenSaverWindowLevel as u32)
            .unwrap();
        occluder_window.set_ignore_cursor_events(true).unwrap();
        occluder_window.make_transparent().unwrap();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(app: AppHandle, state: MutableState<'_, AppState>) -> Result<(), String> {
    let mut state = state.write().await;

    match state.current_recording.take() {
        Some(mut current_recording) => {
            println!("Stopping current recording");
            current_recording.stop();
            println!("Recording stopped");

            state
                .prev_recordings
                .push(current_recording.recording_dir.clone());
            println!("Added to previous recordings");

            drop(state);

            println!("Dropped state");

            show_previous_recordings_window(app);

            println!("Previous recordings window shown");
            Ok(())
        }
        None => {
            eprintln!("No current recording to stop");
            Err("Recording not in progress".to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn render_video(
    screen_recording_path: String,
    webcam_recording_path: String,
    webcam_size: (u32, u32),
    webcam_position: (f32, f32),
    webcam_style: video_renderer::WebcamStyle,
    output_size: (u32, u32),
    background: video_renderer::Background,
) -> Result<String, String> {
    let options = video_renderer::RenderOptions {
        screen_recording_path: PathBuf::from(screen_recording_path),
        webcam_recording_path: PathBuf::from(webcam_recording_path),
        webcam_size,
        webcam_position,
        webcam_style,
        output_size,
        background,
    };

    match video_renderer::render_video(options).await {
        Ok(path) => Ok(path.to_string_lossy().into_owned()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
#[specta::specta]
fn open_previous_recordings_window(app: AppHandle) {
    show_previous_recordings_window(app);
}

struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, Bounds>>>>);

#[derive(Type, Serialize, Deserialize, Debug, Clone)]
struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
#[specta::specta]
async fn set_fake_window_bounds(
    window: tauri::Window,
    name: String,
    bounds: Bounds,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let map = state.entry(window.label().to_string()).or_default();

    map.insert(name, bounds);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn remove_fake_window(
    window: tauri::Window,
    name: String,
    state: tauri::State<'_, FakeWindowBounds>,
) -> Result<(), String> {
    let mut state = state.0.write().await;
    let Some(map) = state.get_mut(window.label()) else {
        return Ok(());
    };

    map.remove(&name);

    if map.is_empty() {
        state.remove(window.label());
    }

    Ok(())
}

const PREV_RECORDINGS_WINDOW: &str = "prev-recordings";

fn show_previous_recordings_window(app: AppHandle) {
    tauri::async_runtime::block_on(async move {
        println!("Attempting to show previous recordings window");

        if let Some(window) = app.get_webview_window(PREV_RECORDINGS_WINDOW) {
            println!("Found existing window, showing it");
            window.show().ok();
            return;
        }
        // if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
        //     panel.show();
        //     return;
        // };

        let monitor = app.primary_monitor().unwrap().unwrap();
        println!("Primary monitor obtained");

        let window = WebviewWindow::builder(
            &app,
            PREV_RECORDINGS_WINDOW,
            tauri::WebviewUrl::App("/prev-recordings".into()),
        )
        .title("Cap Recordings")
        .maximized(false)
        .resizable(false)
        .fullscreen(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .content_protected(true)
        .inner_size(
            (monitor.size().width as f64) / monitor.scale_factor(),
            (monitor.size().height as f64) / monitor.scale_factor(),
        )
        .position(0.0, 0.0)
        .build()
        .unwrap();
        println!("Window built successfully");

        use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
        use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;
        use tauri_plugin_decorum::WebviewWindowExt;

        window.make_transparent().ok();
        println!("Window made transparent");

        let panel = window.to_panel().unwrap();

        println!("Setting panel level");
        panel.set_level(NSMainMenuWindowLevel + 1);
        println!("Panel level set");

        println!("Setting panel collection behaviour");
        panel.set_collection_behaviour(
            NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
                | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
        );
        println!("Panel collection behaviour set");

        // seems like this doesn't work properly -_-
        #[allow(non_upper_case_globals)]
        const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
        println!("Setting panel style mask");
        panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);
        println!("Panel style mask set");

        tokio::spawn(async move {
            let state = app.state::<FakeWindowBounds>();
            println!("Spawned async task for window bounds");

            loop {
                sleep(Duration::from_millis(1000 / 60)).await;

                let map = state.0.read().await;
                let Some(windows) = map.get("prev-recordings") else {
                    window.set_ignore_cursor_events(true).ok();
                    continue;
                };

                let window_position = window.outer_position().unwrap();
                let mouse_position = window.cursor_position().unwrap();
                let scale_factor = window.scale_factor().unwrap();

                let mut ignore = true;

                for (_, bounds) in windows {
                    let x_min = (window_position.x as f64) + bounds.x * scale_factor;
                    let x_max =
                        (window_position.x as f64) + (bounds.x + bounds.width) * scale_factor;
                    let y_min = (window_position.y as f64) + bounds.y * scale_factor;
                    let y_max =
                        (window_position.y as f64) + (bounds.y + bounds.height) * scale_factor;

                    if mouse_position.x >= x_min
                        && mouse_position.x <= x_max
                        && mouse_position.y >= y_min
                        && mouse_position.y <= y_max
                    {
                        ignore = false;
                        FocusCapturesPanel.emit(&app).ok();
                        break;
                    }
                }

                window.set_ignore_cursor_events(ignore).ok();
            }
        });
        println!("Async task for window bounds spawned");
    });
}

fn on_recording_options_change(app: &AppHandle, options: &RecordingOptions) {
    match app.get_webview_window(camera::WINDOW_LABEL) {
        Some(window) if options.camera_label.is_none() => {
            window.close().ok();
        }
        None if options.camera_label.is_some() => {
            create_camera_window(app.clone());
        }
        _ => {}
    }

    RecordingOptionsChanged.emit(app).ok();
}

#[tauri::command]
#[specta::specta]
fn focus_captures_panel(app: AppHandle) {
    let panel = app.get_webview_panel(PREV_RECORDINGS_WINDOW).unwrap();
    panel.make_key_window();
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
            get_capture_windows,
            get_prev_recordings,
            open_previous_recordings_window,
            set_fake_window_bounds,
            remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            render_video
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            FocusCapturesPanel
        ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder
        ::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_nspanel::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            if let Err(error) = handle_ffmpeg_installation() {
                panic!(
                    "Failed to install FFmpeg, which is required for Cap to function. Shutting down now"
                );
            }

            app.manage(
                Arc::new(
                    RwLock::new(AppState {
                        start_recording_options: RecordingOptions {
                            capture_target: CaptureTarget::Screen,
                            camera_label: None,
                        },
                        current_recording: None,
                        prev_recordings: std::fs
                            ::read_dir(app.path().app_data_dir().unwrap().join("recordings"))
                            .map(|d| d.into_iter().collect::<Vec<_>>())
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|entry| {
                                let path = entry.unwrap().path();
                                if path.extension()? == "cap" {
                                    Some(path)
                                } else {
                                    None
                                }
                            })
                            .collect(),
                    })
                )
            );

            app.manage(FakeWindowBounds(Arc::new(RwLock::new(HashMap::new()))));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
