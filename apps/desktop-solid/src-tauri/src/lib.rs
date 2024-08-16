mod camera;
mod display;
mod ffmpeg;
mod macos;
mod recording;
mod utils;

// use macos::Bounds;
use scap::Target;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::{Command, Stdio},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_nspanel::{cocoa::appkit::NSMainMenuWindowLevel, ManagerExt};
use tauri_specta::Event;
use tokio::{sync::RwLock, time::sleep};

use camera::{create_camera_window, get_cameras};
use display::{get_capture_windows, CaptureTarget};

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
    current_recording: Option<recording::InProgressRecording>,
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

    state.current_recording = Some(recording::start(recording_dir, recording_options).await);

    Ok(())
}

fn get_target_for_window(window: &WebviewWindow) -> Option<Target> {
    let window_number = macos::get_ns_window_number(window.ns_window().unwrap());

    scap::get_all_targets()
        .into_iter()
        .find(|target| match target {
            Target::Window(window) => window.raw_handle as isize == window_number,
            _ => false,
        })
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(app: AppHandle, state: MutableState<'_, AppState>) -> Result<(), String> {
    let mut state = state.write().await;

    let Some(mut current_recording) = state.current_recording.take() else {
        return Err("Recording not in progress".to_string());
    };

    current_recording.stop();

    std::fs::create_dir_all(current_recording.recording_dir.join("screenshots")).ok();

    dbg!(&current_recording.display.output_path);
    Command::new("ffmpeg")
        .args(["-ss", "0:00:00", "-i"])
        .arg(&current_recording.display.output_path)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(
            current_recording
                .recording_dir
                .join("screenshots/display.jpg"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();

    state.prev_recordings.push(current_recording.recording_dir);

    show_previous_recordings_window(app);

    Ok(())
}

#[tauri::command]
#[specta::specta]
fn open_dat_shit(app: AppHandle) {
    show_previous_recordings_window(app);
}

struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, Bounds>>>>);

#[derive(Type, Deserialize, Debug)]
struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
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
    if let Some(window) = app.get_webview_window(PREV_RECORDINGS_WINDOW) {
        window.show().ok();
        return;
    };
    // if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
    //     panel.show();
    //     return;
    // };

    let monitor = app.primary_monitor().unwrap().unwrap();

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
        monitor.size().width as f64 / monitor.scale_factor(),
        monitor.size().height as f64 / monitor.scale_factor(),
    )
    .position(0.0, 0.0)
    .build()
    .unwrap();

    use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
    use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;
    use tauri_plugin_decorum::WebviewWindowExt;

    window.make_transparent().ok();
    let panel = window.to_panel().unwrap();

    panel.set_level(NSMainMenuWindowLevel + 1);

    panel.set_collection_behaviour(
        NSWindowCollectionBehavior::NSWindowCollectionBehaviorTransient
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorMoveToActiveSpace
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorFullScreenAuxiliary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle,
    );

    // seems like this doesn't work properly -_-
    #[allow(non_upper_case_globals)]
    const NSWindowStyleMaskNonActivatingPanel: i32 = 1 << 7;
    panel.set_style_mask(NSWindowStyleMaskNonActivatingPanel);

    tokio::spawn(async move {
        let state = app.state::<FakeWindowBounds>();

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
                let x_min = window_position.x as f64 + bounds.x * scale_factor;
                let x_max = window_position.x as f64 + (bounds.x + bounds.width) * scale_factor;
                let y_min = window_position.y as f64 + bounds.y * scale_factor;
                let y_max = window_position.y as f64 + (bounds.y + bounds.height) * scale_factor;

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
    };

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
            open_dat_shit,
            set_fake_window_bounds,
            remove_fake_window,
            focus_captures_panel
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            FocusCapturesPanel,
        ]);

    #[cfg(debug_assertions)] // <- Only export on non-release builds
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_nspanel::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            app.manage(Arc::new(RwLock::new(AppState {
                start_recording_options: RecordingOptions {
                    capture_target: CaptureTarget::Display,
                    camera_label: None,
                },
                current_recording: None,
                prev_recordings: std::fs::read_dir(
                    app.path().app_data_dir().unwrap().join("recordings"),
                )
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
            })));

            app.manage(FakeWindowBounds(Arc::new(RwLock::new(HashMap::new()))));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
