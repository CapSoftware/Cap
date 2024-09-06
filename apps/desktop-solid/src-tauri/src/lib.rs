mod audio;
mod camera;
mod display;
mod editor;
mod editor_instance;
mod macos;
mod playback;
mod project_recordings;
mod recording;
mod tray;

use camera::{create_camera_window, list_cameras};
use cap_ffmpeg::ffmpeg_path_as_str;
use cap_project::ProjectConfiguration;
use cap_rendering::{RecordingDecoders, RenderOptions};
use display::{list_capture_windows, Bounds, CaptureTarget};
use editor_instance::{EditorInstance, EditorState, FRAMES_WS_PATH};
use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};
use image::{ImageBuffer, Rgba};
use mp4::Mp4Reader;
use num_traits::ToBytes;
use objc2_app_kit::NSScreenSaverWindowLevel;
use recording::{DisplaySource, InProgressRecording};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::fs::File;
use std::io::{BufReader, Read, Write};
use std::{
    collections::HashMap, marker::PhantomData, path::PathBuf, process::Command, sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};
use tauri_nspanel::{cocoa::appkit::NSMainMenuWindowLevel, ManagerExt};
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_specta::Event;
use tokio::{
    sync::{Mutex, RwLock},
    time::sleep,
};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    capture_target: CaptureTarget,
    camera_label: Option<String>,
    audio_input_name: Option<String>,
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    handle: AppHandle,
    #[serde(skip)]
    current_recording: Option<InProgressRecording>,
    prev_recordings: Vec<PathBuf>,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Screen,
    Output,
}

const WINDOW_CAPTURE_OCCLUDER_LABEL: &str = "window-capture-occluder";

impl App {
    pub fn set_current_recording(&mut self, new_value: InProgressRecording) {
        let current_recording = self.current_recording.insert(new_value);

        if let DisplaySource::Window { .. } = &current_recording.display_source {
            match self
                .handle
                .get_webview_window(WINDOW_CAPTURE_OCCLUDER_LABEL)
            {
                None => {
                    let monitor = self.handle.primary_monitor().unwrap().unwrap();

                    let occluder_window = WebviewWindow::builder(
                        &self.handle,
                        WINDOW_CAPTURE_OCCLUDER_LABEL,
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
                Some(w) => {
                    w.show();
                }
            }
        } else {
            self.close_occluder_window();
        }
    }

    pub fn clear_current_recording(&mut self) -> Option<InProgressRecording> {
        self.close_occluder_window();

        self.current_recording.take()
    }

    fn close_occluder_window(&self) {
        self.handle
            .get_webview_window(WINDOW_CAPTURE_OCCLUDER_LABEL)
            .map(|window| window.close().ok());
    }

    fn set_start_recording_options(&mut self, new_value: RecordingOptions) {
        self.start_recording_options = new_value;
        let options = &self.start_recording_options;

        match self.handle.get_webview_window(camera::WINDOW_LABEL) {
            Some(window) if options.camera_label.is_none() => {
                window.close().ok();
            }
            None if options.camera_label.is_some() => {
                create_camera_window(self.handle.clone());
            }
            _ => {}
        }

        RecordingOptionsChanged.emit(&self.handle).ok();
    }
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

// dedicated event + command used as panel must be accessed on main thread
#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct ShowCapturesPanel;

// dedicated event + command used as panel must be accessed on main thread
#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RefreshCapturesPanel;

type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

#[tauri::command]
#[specta::specta]
async fn get_recording_options(state: MutableState<'_, App>) -> Result<RecordingOptions, ()> {
    let state = state.read().await;
    Ok(state.start_recording_options.clone())
}

#[tauri::command]
#[specta::specta]
async fn set_recording_options(
    state: MutableState<'_, App>,
    options: RecordingOptions,
) -> Result<(), ()> {
    state.write().await.set_start_recording_options(options);

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
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<InProgressRecording>>, ()> {
    let state = state.read().await;
    Ok(JsonValue::new(&state.current_recording))
}

#[tauri::command]
#[specta::specta]
async fn get_prev_recordings(state: MutableState<'_, App>) -> Result<Vec<PathBuf>, ()> {
    let state = state.read().await;
    Ok(state.prev_recordings.clone())
}

#[tauri::command]
#[specta::specta]
async fn start_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{id}.cap"));

    let recording = recording::start(recording_dir, &state.start_recording_options).await;

    state.set_current_recording(recording);

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;
    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

    let Some(mut current_recording) = state.clear_current_recording() else {
        return Err("Recording not in progress".to_string());
    };

    current_recording.stop().await;

    std::fs::create_dir_all(current_recording.recording_dir.join("screenshots")).ok();

    dbg!(&current_recording.display.output_path);
    Command::new(ffmpeg_binary_path_str)
        .args(["-ss", "0:00:00", "-i"])
        .arg(&current_recording.display.output_path)
        .args(["-frames:v", "1", "-q:v", "2"])
        .arg(
            current_recording
                .recording_dir
                .join("screenshots/display.jpg"),
        )
        .output()
        .unwrap();

    state.prev_recordings.push(current_recording.recording_dir);

    ShowCapturesPanel.emit(&app).ok();

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_rendered_video(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<PathBuf, String> {
    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;
    let output_path = editor_instance.project_path.join("output/result.mp4");

    if !output_path.exists() {
        render_to_file_impl(
            &editor_instance,
            project,
            output_path.clone(),
            |_| {},
        )
        .await?;
    }

    Ok(output_path)
}

#[tauri::command]
#[specta::specta]
async fn copy_file_to_path(src: String, dst: String) -> Result<(), String> {
    println!("Attempting to copy file from {} to {}", src, dst);
    match tokio::fs::copy(&src, &dst).await {
        Ok(bytes) => {
            println!(
                "Successfully copied {} bytes from {} to {}",
                bytes, src, dst
            );
            Ok(())
        }
        Err(e) => {
            eprintln!("Failed to copy file from {} to {}: {}", src, dst, e);
            Err(e.to_string())
        }
    }
}

async fn render_to_file_impl(
    editor_instance: &Arc<EditorInstance>,
    project: ProjectConfiguration,
    output_path: PathBuf,
    on_progress: impl Fn(u32) + Send + 'static,
) -> Result<PathBuf, String> {
    let recording_dir = &editor_instance.project_path;
    let audio = editor_instance.audio.clone();
    let decoders = editor_instance.decoders.clone();
    let options = editor_instance.render_constants.options.clone();

    let (tx_image_data, mut rx_image_data) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();

    let output_folder = output_path.parent().unwrap();
    std::fs::create_dir_all(output_folder)
        .map_err(|e| format!("Failed to create output directory: {:?}", e))?;
    let output_path_clone = output_path.clone();
    let recording_dir_clone = recording_dir.clone();

    tokio::spawn(async move {
        println!("Starting FFmpeg output process...");
        let mut ffmpeg = cap_ffmpeg::FFmpeg::new();

        let audio_path = if let Some(audio) = &audio {
            let dir = tempfile::tempdir().unwrap();
            let file_path = dir.path().join("audio.raw");
            let mut file = std::fs::File::create(&file_path).unwrap();

            file.write_all(
                audio
                    .buffer
                    .iter()
                    .flat_map(|f| f.to_le_bytes())
                    .collect::<Vec<_>>()
                    .as_slice(),
            )
            .unwrap();

            ffmpeg.add_input(cap_ffmpeg::FFmpegRawAudioInput {
                input: file_path.clone().into_os_string(),
                sample_format: "f64le".to_string(),
                sample_rate: 44100,
                channels: 1,
                wallclock: false,
            });

            Some((file_path, file, dir))
        } else {
            None
        };

        ffmpeg.add_input(cap_ffmpeg::FFmpegRawVideoInput {
            width: options.output_size.0,
            height: options.output_size.1,
            fps: 30,
            pix_fmt: "rgba",
            input: "pipe:0".into(),
        });

        ffmpeg
            .command
            .args([
                "-f", "mp4", /*, "-map", &format!("{}:v", ffmpeg_input.index) */
            ])
            .args(["-codec:v", "libx264", "-preset", "ultrafast"])
            .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
            .arg("-y")
            .arg(&output_path_clone);

        let mut ffmpeg_process = ffmpeg.start();

        let mut frame_count = 0;
        let mut first_frame = None;

        loop {
            match rx_image_data.recv().await {
                Some(frame) => {
                    // println!("Sending image data to FFmpeg");
                    on_progress(frame_count);

                    if frame_count == 0 {
                        first_frame = Some(frame.clone());
                    }

                    frame_count += 1;
                    if let Err(e) = ffmpeg_process.write_video_frame(&frame) {
                        eprintln!("Error writing video frame: {:?}", e);
                        break;
                    }
                }
                None => {
                    println!("All frames sent to FFmpeg");
                    break;
                }
            }
        }

        ffmpeg_process.stop();

        if let Some((audio_path, _, _)) = audio_path {
            std::fs::remove_file(audio_path).ok();
        }

        // Save the first frame as a screenshot
        if let Some(frame_data) = first_frame {
            let width = options.output_size.0;
            let height = options.output_size.1;
            let rgba_img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                ImageBuffer::from_raw(width, height, frame_data)
                    .expect("Failed to create image from frame data");

            // Convert RGBA to RGB
            let rgb_img: ImageBuffer<image::Rgb<u8>, Vec<u8>> =
                ImageBuffer::from_fn(width, height, |x, y| {
                    let rgba = rgba_img.get_pixel(x, y);
                    image::Rgb([rgba[0], rgba[1], rgba[2]])
                });

            let screenshot_path = recording_dir_clone.join("screenshots/display.jpg");
            std::fs::create_dir_all(screenshot_path.parent().unwrap()).unwrap_or_else(|e| {
                eprintln!("Failed to create screenshots directory: {:?}", e);
            });

            rgb_img.save(screenshot_path).unwrap_or_else(|e| {
                eprintln!("Failed to save screenshot: {:?}", e);
            });
        } else {
            eprintln!("No frames were processed, cannot save screenshot");
        }
    });

    println!("Rendering video to channel");

    cap_rendering::render_video_to_channel(options, project, tx_image_data, decoders).await?;

    println!("Copying file to {:?}", recording_dir);
    let result_path = recording_dir.join("output/result.mp4");
    // Function to check if the file is a valid MP4
    fn is_valid_mp4(path: &std::path::Path) -> bool {
        if let Ok(file) = std::fs::File::open(path) {
            let file_size = match file.metadata() {
                Ok(metadata) => metadata.len(),
                Err(_) => return false,
            };
            let reader = std::io::BufReader::new(file);
            Mp4Reader::read_header(reader, file_size).is_ok()
        } else {
            false
        }
    }

    if output_path != result_path {
        println!("Waiting for valid MP4 file at {:?}", output_path);
        // Wait for the file to become a valid MP4
        let mut attempts = 0;
        while attempts < 10 {
            // Wait for up to 60 seconds
            if is_valid_mp4(&output_path) {
                println!("Valid MP4 file detected after {} seconds", attempts);
                match std::fs::copy(&output_path, &result_path) {
                    Ok(bytes) => {
                        println!("Successfully copied {} bytes to {:?}", bytes, result_path)
                    }
                    Err(e) => eprintln!("Failed to copy file: {:?}", e),
                }
                break;
            }
            println!("Attempt {}: File not yet valid, waiting...", attempts + 1);
            std::thread::sleep(std::time::Duration::from_secs(1));
            attempts += 1;
        }

        if attempts == 10 {
            eprintln!("Timeout: Failed to detect a valid MP4 file after 60 seconds");
        }
    }

    Ok(output_path)
}

#[derive(Deserialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct RenderFrameEvent {
    frame_number: u32,
    project: ProjectConfiguration,
}

#[derive(Serialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct EditorStateChanged {
    playhead_position: u32,
}

impl EditorStateChanged {
    fn new(s: &EditorState) -> Self {
        Self {
            playhead_position: s.playhead_position,
        }
    }
}

#[derive(Clone)]
pub struct AudioData {
    pub buffer: Arc<Vec<f64>>,
    pub sample_rate: u32,
    // pub channels: u18
}

#[tauri::command]
#[specta::specta]
async fn start_playback(app: AppHandle, video_id: String, project: ProjectConfiguration) {
    upsert_editor_instance(&app, video_id)
        .await
        .start_playback(project)
        .await
}

#[tauri::command]
#[specta::specta]
async fn stop_playback(app: AppHandle, video_id: String) {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    let mut state = editor_instance.state.lock().await;

    if let Some(handle) = state.playback_task.take() {
        handle.stop();
    }
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
struct SerializedEditorInstance {
    frames_socket_url: String,
    recording_duration: f64,
    saved_project_config: Option<ProjectConfiguration>,
}

#[tauri::command]
#[specta::specta]
async fn create_editor_instance(
    app: AppHandle,
    video_id: String,
) -> Result<SerializedEditorInstance, String> {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    Ok(SerializedEditorInstance {
        frames_socket_url: format!("ws://localhost:{}{FRAMES_WS_PATH}", editor_instance.ws_port),
        recording_duration: editor_instance.recordings.duration(),
        saved_project_config: std::fs::read_to_string(
            &editor_instance.project_path.join("project-config.json"),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok()),
    })
}

#[tauri::command]
#[specta::specta]
async fn copy_rendered_video_to_clipboard(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<(), String> {
    let output_path = match get_rendered_video(app.clone(), video_id.clone(), project).await {
        Ok(path) => {
            println!("Successfully retrieved rendered video path: {:?}", path);
            path
        }
        Err(e) => {
            println!("Failed to get rendered video: {}", e);
            return Err(format!("Failed to get rendered video: {}", e));
        }
    };

    let output_path_str = output_path.to_str().unwrap();

    println!("Copying to clipboard: {:?}", output_path_str);

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSString, NSURL};
        use objc::rc::autoreleasepool;

        unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let url =
                    NSURL::fileURLWithPath_(nil, NSString::alloc(nil).init_str(output_path_str));

                let objects: id = NSArray::arrayWithObject(nil, url);

                NSPasteboard::writeObjects(pasteboard, objects);
            });
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_video_metadata(
    app: AppHandle,
    video_id: String,
    video_type: Option<VideoType>,
    state: MutableState<'_, App>,
) -> Result<(f64, f64), String> {
    let video_id = if video_id.ends_with(".cap") {
        video_id.trim_end_matches(".cap").to_string()
    } else {
        video_id
    };

    let video_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{}.cap", video_id));

    let screen_video_path = video_dir.join("content/display.mp4");
    let output_video_path = video_dir.join("output/result.mp4");

    let video_path = match video_type {
        Some(VideoType::Screen) => {
            println!("Using screen video path: {:?}", screen_video_path);
            if !screen_video_path.exists() {
                return Err(format!(
                    "Screen video does not exist: {:?}",
                    screen_video_path
                ));
            }
            screen_video_path
        }
        Some(VideoType::Output) | None => {
            if output_video_path.exists() {
                println!("Using output video path: {:?}", output_video_path);
                output_video_path
            } else {
                println!(
                    "Output video not found, falling back to screen video path: {:?}",
                    screen_video_path
                );
                if !screen_video_path.exists() {
                    return Err(format!(
                        "Screen video does not exist: {:?}",
                        screen_video_path
                    ));
                }
                screen_video_path
            }
        }
    };

    let file = File::open(&video_path).map_err(|e| {
        println!("Failed to open video file: {}", e);
        format!("Failed to open video file: {}", e)
    })?;

    let size = (file
        .metadata()
        .map_err(|e| {
            println!("Failed to get file metadata: {}", e);
            format!("Failed to get file metadata: {}", e)
        })?
        .len() as f64)
        / (1024.0 * 1024.0);

    println!("File size: {} MB", size);

    let reader = BufReader::new(file);
    let file_size = video_path
        .metadata()
        .map_err(|e| {
            println!("Failed to get file metadata: {}", e);
            format!("Failed to get file metadata: {}", e)
        })?
        .len();

    let duration = match Mp4Reader::read_header(reader, file_size) {
        Ok(mp4) => mp4.duration().as_secs_f64(),
        Err(e) => {
            println!(
                "Failed to read MP4 header: {}. Falling back to default duration.",
                e
            );
            // Return a default duration (e.g., 0.0) or try to estimate it based on file size
            0.0 // or some estimated value
        }
    };

    Ok((duration, size))
}

struct FakeWindowBounds(pub Arc<RwLock<HashMap<String, HashMap<String, Bounds>>>>);

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

#[tauri::command]
#[specta::specta]
fn show_previous_recordings_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window(PREV_RECORDINGS_WINDOW) {
        window.show().ok();
        return;
    }
    if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
        if !panel.is_visible() {
            panel.show();
        }
        return;
    };

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
    .accept_first_mouse(true)
    .content_protected(true)
    .inner_size(
        (monitor.size().width as f64) / monitor.scale_factor(),
        (monitor.size().height as f64) / monitor.scale_factor(),
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
                let x_min = (window_position.x as f64) + bounds.x * scale_factor;
                let x_max = (window_position.x as f64) + (bounds.x + bounds.width) * scale_factor;
                let y_min = (window_position.y as f64) + bounds.y * scale_factor;
                let y_max = (window_position.y as f64) + (bounds.y + bounds.height) * scale_factor;

                if mouse_position.x >= x_min
                    && mouse_position.x <= x_max
                    && mouse_position.y >= y_min
                    && mouse_position.y <= y_max
                {
                    ignore = false;
                    ShowCapturesPanel.emit(&app).ok();
                    break;
                }
            }

            window.set_ignore_cursor_events(ignore).ok();
        }
    });
}

#[tauri::command]
#[specta::specta]
fn close_previous_recordings_window(app: AppHandle) {
    if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
        panel.released_when_closed(true);
        panel.close();
    }
}

fn handle_ffmpeg_installation() -> Result<(), String> {
    if ffmpeg_is_installed() {
        println!("FFmpeg is already installed! 🎉");
        return Ok(());
    }

    println!("FFmpeg not found. Attempting to install...");
    match check_latest_version() {
        Ok(version) => println!("Latest available version: {}", version),
        Err(e) => println!("Skipping version check due to error: {e}"),
    }

    let download_url = ffmpeg_download_url().map_err(|e| e.to_string())?;
    let destination = sidecar_dir().map_err(|e| e.to_string())?;

    println!("Downloading from: {:?}", download_url);
    let archive_path =
        download_ffmpeg_package(download_url, &destination).map_err(|e| e.to_string())?;
    println!("Downloaded package: {:?}", archive_path);

    println!("Extracting...");
    unpack_ffmpeg(&archive_path, &destination).map_err(|e| e.to_string())?;

    let version = ffmpeg_version().map_err(|e| e.to_string())?;

    println!("Done! Installed FFmpeg version {} 🏁", version);
    Ok(())
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

#[derive(Serialize, Deserialize, specta::Type, Clone)]
#[serde(tag = "type")]
enum RenderProgress {
    Starting { total_frames: u32 },
    EstimatedTotalFrames { total_frames: u32 },
    FrameRendered { current_frame: u32 },
}

#[tauri::command]
#[specta::specta]
async fn render_to_file(
    app: AppHandle,
    output_path: PathBuf,
    video_id: String,
    project: ProjectConfiguration,
    progress_channel: tauri::ipc::Channel<RenderProgress>,
) {
    let (duration, _size) = get_video_metadata(
        app.clone(),
        video_id.clone(),
        Some(VideoType::Screen),
        app.state(),
    )
    .await
    .unwrap();

    // 30 FPS (calculated for output video)
    let total_frames = (duration * 30.0).round() as u32;

    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;

    render_to_file_impl(
        &editor_instance,
        project,
        output_path,
        move |current_frame| {
            if current_frame == 0 {
                progress_channel
                    .send(RenderProgress::EstimatedTotalFrames { total_frames })
                    .ok();
            }
            progress_channel
                .send(RenderProgress::FrameRendered { current_frame })
                .ok();
        },
    )
    .await
    .ok();

    RefreshCapturesPanel.emit(&app).ok();
}

#[tauri::command]
#[specta::specta]
async fn set_playhead_position(app: AppHandle, video_id: String, frame_number: u32) {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;
}

#[tauri::command]
#[specta::specta]
fn open_in_finder(path: PathBuf) {
    Command::new("open")
        .arg("-R")
        .arg(path)
        .spawn()
        .expect("Failed to open in Finder");
}

#[tauri::command]
#[specta::specta]
fn list_audio_devices() -> Vec<String> {
    let devices = audio::get_input_devices();

    devices.keys().cloned().collect()
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
            list_cameras,
            list_capture_windows,
            list_audio_devices,
            get_prev_recordings,
            show_previous_recordings_window,
            close_previous_recordings_window,
            set_fake_window_bounds,
            remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            render_to_file,
            get_rendered_video,
            copy_file_to_path,
            copy_rendered_video_to_clipboard,
            get_video_metadata,
            create_editor_instance,
            start_playback,
            stop_playback,
            set_playhead_position,
            open_in_finder
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            ShowCapturesPanel,
            RefreshCapturesPanel,
            RenderFrameEvent,
            EditorStateChanged
        ])
        .ty::<ProjectConfiguration>();

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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);

            #[cfg(all(desktop))]
            {
                let handle = app.handle();
                tray::create_tray(handle)?;
            }

            if let Err(_error) = handle_ffmpeg_installation() {
                println!("Failed to install FFmpeg, which is required for Cap to function. Shutting down now");
                // TODO: UI message instead
                panic!("Failed to install FFmpeg, which is required for Cap to function. Shutting down now")
            };

            app.manage(Arc::new(RwLock::new(App {
                handle: app.handle().clone(),
                start_recording_options: RecordingOptions {
                    capture_target: CaptureTarget::Screen,
                    camera_label: None,
                    audio_input_name: None
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
        .on_window_event(|window, event| {
        		let label = window.label();
        		if label.starts_with("editor-") {
		          	if let WindowEvent::CloseRequested {..} = event {
										let id = label.strip_prefix("editor-").unwrap().to_string();

										let app = window.app_handle().clone();

										tokio::spawn(async move {
											if let Some(editor) = remove_editor_instance(&app, id.clone()).await {
												editor.dispose().await;
											}
										});
								}
          	}
				})
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

pub async fn remove_editor_instance(
    app: &AppHandle,
    video_id: String,
) -> Option<Arc<EditorInstance>> {
    let map = match app.try_state::<Arc<Mutex<HashMap<String, Arc<EditorInstance>>>>>() {
        Some(s) => (*s).clone(),
        None => return None,
    };

    let mut map = map.lock().await;

    map.remove(&video_id).clone()
}

pub async fn upsert_editor_instance(app: &AppHandle, video_id: String) -> Arc<EditorInstance> {
    let map = match app.try_state::<Arc<Mutex<HashMap<String, Arc<EditorInstance>>>>>() {
        Some(s) => (*s).clone(),
        None => {
            let map = Arc::new(Mutex::new(HashMap::new()));
            app.manage(map.clone());
            map
        }
    };

    let mut map = map.lock().await;

    use std::collections::hash_map::Entry;
    match map.entry(video_id.clone()) {
        Entry::Occupied(o) => o.get().clone(),
        Entry::Vacant(v) => {
            let instance = create_editor_instance_impl(app, video_id).await;
            v.insert(instance.clone());
            instance
        }
    }
}

async fn create_editor_instance_impl(app: &AppHandle, video_id: String) -> Arc<EditorInstance> {
    let instance = EditorInstance::new(recordings_path(app), video_id, {
        let app = app.clone();
        move |state| {
            EditorStateChanged::new(state).emit(&app).ok();
        }
    })
    .await;

    RenderFrameEvent::listen_any(app, {
        let instance = instance.clone();
        move |e| {
            instance
                .preview_tx
                .send(Some((e.payload.frame_number, e.payload.project)))
                .ok();
        }
    });

    instance
}

// use EditorInstance.project_path instead of this
fn recordings_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("recordings")
}
