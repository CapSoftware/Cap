mod audio;
mod auth;
mod camera;
mod capture;
mod display;
mod editor;
mod editor_instance;
mod encoder;
mod flags;
mod hotkeys;
mod macos;
mod permissions;
mod playback;
mod project_recordings;
mod recording;
mod tray;
mod upload;

use audio::AppSounds;
use auth::AuthStore;
use camera::{create_camera_window, list_cameras};
use cap_ffmpeg::FFmpeg;
use cap_project::{
    ProjectConfiguration, RecordingMeta, SharingMeta, TimelineConfiguration, TimelineSegment,
};
use cap_rendering::ProjectUniforms;
use cap_utils::create_named_pipe;
use display::{list_capture_windows, Bounds, CaptureTarget, FPS};
use editor_instance::{EditorInstance, EditorState, FRAMES_WS_PATH};
use image::{ImageBuffer, Rgba};
use mp4::Mp4Reader;
use num_traits::ToBytes;
use objc2_app_kit::NSScreenSaverWindowLevel;
use png::{ColorType, Encoder};
use project_recordings::ProjectRecordings;
use recording::{DisplaySource, InProgressRecording};
use scap::capturer::Capturer;
use scap::frame::Frame;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::fs::File;
use std::io::BufWriter;
use std::io::{BufReader, Write};
use std::time::{SystemTime, UNIX_EPOCH};
use std::{
    collections::HashMap, marker::PhantomData, path::PathBuf, process::Command, sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_nspanel::{cocoa::appkit::NSMainMenuWindowLevel, ManagerExt};
use tauri_plugin_decorum::WebviewWindowExt;
use tauri_specta::Event;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc;
use tokio::task;
use tokio::{
    sync::{Mutex, RwLock},
    time::sleep,
};
use upload::{upload_image, upload_video};

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingOptions {
    capture_target: CaptureTarget,
    camera_label: Option<String>,
    audio_input_name: Option<String>,
}

impl RecordingOptions {
    fn camera_label(&self) -> Option<&str> {
        self.camera_label.as_deref()
    }

    fn audio_input_name(&self) -> Option<&str> {
        self.audio_input_name.as_deref()
    }
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    handle: AppHandle,
    #[serde(skip)]
    current_recording: Option<InProgressRecording>,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Screen,
    Output,
}

const WINDOW_CAPTURE_OCCLUDER_LABEL: &str = "window-capture-occluder";
const IN_PROGRESS_RECORDINGS_LABEL: &str = "in-progress-recordings";

impl App {
    pub fn set_current_recording(&mut self, new_value: InProgressRecording) {
        let option = Some(new_value);
        let json = JsonValue::new(&option);

        let new_value = option.unwrap();

        let current_recording = self.current_recording.insert(new_value);

        CurrentRecordingChanged(json).emit(&self.handle).ok();

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

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewRecordingAdded {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewScreenshotAdded {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStarted;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStopped {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestStartRecording;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestRestartRecording;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestNewScreenshot;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestStopRecording;

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

impl<T> Clone for JsonValue<T> {
    fn clone(&self) -> Self {
        Self(PhantomData, self.1.clone())
    }
}

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

#[derive(Serialize, Type, tauri_specta::Event, Clone)]
pub struct CurrentRecordingChanged(JsonValue<Option<InProgressRecording>>);

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

    if let Some(window) = app.get_webview_window("main") {
        window.minimize().ok();
    }

    let window = app
        .get_webview_window(IN_PROGRESS_RECORDINGS_LABEL)
        .unwrap();
    window.eval("window.location.reload()").unwrap();
    window.show().unwrap();

    AppSounds::StartRecording.play();

    RecordingStarted.emit(&app).ok();

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn pause_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = &mut state.current_recording {
        recording.pause().await?;
        recording.segments.push(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs_f64(),
        );
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn resume_recording(state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = &mut state.current_recording {
        recording.resume().await?;
        recording.segments.push(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs_f64(),
        );
    }
    Ok(())
}

fn create_in_progress_recording_window(app: &AppHandle) {
    let monitor = app.primary_monitor().unwrap().unwrap();

    let width = 120.0;
    let height = 40.0;

    WebviewWindow::builder(
        app,
        IN_PROGRESS_RECORDINGS_LABEL,
        tauri::WebviewUrl::App("/in-progress-recording".into()),
    )
    .title("Cap In Progress Recording")
    .maximized(false)
    .resizable(false)
    .fullscreen(false)
    .decorations(false)
    .shadow(true)
    .always_on_top(true)
    .transparent(true)
    .visible_on_all_workspaces(true)
    .content_protected(true)
    .accept_first_mouse(true)
    .inner_size(width, height)
    .position(
        ((monitor.size().width as f64) / monitor.scale_factor() - width) / 2.0,
        (monitor.size().height as f64) / monitor.scale_factor() - height - 120.0,
    )
    .visible(false)
    .build()
    .ok();
}

#[tauri::command]
#[specta::specta]
async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    // dropping the mutex lock is important to ensure that the getCurrentRecording query isn't blocked
    let Some(mut current_recording) = state.write().await.clear_current_recording() else {
        return Err("Recording not in progress".to_string());
    };

    current_recording.segments.push(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64(),
    );

    current_recording.stop();

    let window = app
        .get_webview_window(IN_PROGRESS_RECORDINGS_LABEL)
        .unwrap();
    window.hide().unwrap();

    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().ok();
    }

    std::fs::create_dir_all(current_recording.recording_dir.join("screenshots")).ok();
    dbg!(&current_recording.display.output_path);

    FFmpeg::new()
        .command
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

    FFmpeg::new()
        .command
        .args(["-ss", "0:00:00", "-i"])
        .arg(&current_recording.display.output_path)
        .args(["-frames:v", "1", "-vf", "scale=100:-1"])
        .arg(
            current_recording
                .recording_dir
                .join("screenshots/thumbnail.png"),
        )
        .output()
        .unwrap();

    let recording_dir = current_recording.recording_dir.clone();

    ShowCapturesPanel.emit(&app).ok();

    NewRecordingAdded {
        path: recording_dir.clone(),
    }
    .emit(&app)
    .ok();

    RecordingStopped {
        path: recording_dir,
    }
    .emit(&app)
    .ok();

    let config = {
        let mut segments = vec![];

        let mut passed_duration = 0.0;

        for i in (0..current_recording.segments.len()).step_by(2) {
            let start = passed_duration;

            passed_duration += current_recording.segments[i + 1] - current_recording.segments[i];

            segments.push(TimelineSegment {
                start,
                end: passed_duration,
                timescale: 1.0,
            });
        }

        ProjectConfiguration {
            timeline: Some(TimelineConfiguration { segments }),
            ..Default::default()
        }
    };

    std::fs::write(
        current_recording.recording_dir.join("project-config.json"),
        serde_json::to_string_pretty(&json!(&config)).unwrap(),
    )
    .unwrap();

    AppSounds::StopRecording.play();

    CurrentRecordingChanged(JsonValue::new(&None))
        .emit(&app)
        .ok();

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

    get_rendered_video_impl(editor_instance, project).await
}

async fn get_rendered_video_impl(
    editor_instance: Arc<EditorInstance>,
    project: ProjectConfiguration,
) -> Result<PathBuf, String> {
    let output_path = editor_instance.project_path.join("output/result.mp4");

    if !output_path.exists() {
        render_to_file_impl(&editor_instance, project, output_path.clone(), |_| {}).await?;
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

#[tauri::command]
#[specta::specta]
async fn copy_screenshot_to_clipboard(app: AppHandle, path: PathBuf) -> Result<(), String> {
    println!("Copying screenshot to clipboard: {:?}", path);

    let image_data = match tokio::fs::read(&path).await {
        Ok(data) => data,
        Err(e) => {
            println!("Failed to read screenshot file: {}", e);
            return Err(format!("Failed to read screenshot file: {}", e));
        }
    };

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::{NSImage, NSPasteboard};
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSData};
        use objc::rc::autoreleasepool;

        unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let ns_data = NSData::dataWithBytes_length_(
                    nil,
                    image_data.as_ptr() as *const std::os::raw::c_void,
                    image_data.len() as u64,
                );

                let image = NSImage::initWithData_(NSImage::alloc(nil), ns_data);
                if image != nil {
                    NSPasteboard::writeObjects(pasteboard, NSArray::arrayWithObject(nil, image));
                    Ok(())
                } else {
                    Err("Failed to create NSImage from data".to_string())
                }
            })
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Clipboard operations are only supported on macOS".to_string())
    }
}

#[tauri::command]
#[specta::specta]
async fn open_file_path(app: AppHandle, path: PathBuf) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .arg(&path)
            .output()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        Command::new("cmd")
            .args(&["/C", "start", ""])
            .arg(&path)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&path)
            .output()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

struct AudioRender {
    data: AudioData,
    pipe_tx: tokio::sync::mpsc::Sender<Vec<f64>>,
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

    let output_size = ProjectUniforms::get_output_size(&options, &project);

    let ffmpeg_handle = tokio::spawn({
        let project = project.clone();
        let output_path = output_path.clone();
        let recording_dir = recording_dir.clone();
        async move {
            println!("Starting FFmpeg output process...");
            let mut ffmpeg = cap_ffmpeg::FFmpeg::new();

            let audio_dir = tempfile::tempdir().unwrap();
            let video_dir = tempfile::tempdir().unwrap();

            let video_tx = {
                let pipe_path = video_dir.path().join("video.pipe");
                create_named_pipe(&pipe_path).unwrap();

                ffmpeg.add_input(cap_ffmpeg::FFmpegRawVideoInput {
                    width: output_size.0,
                    height: output_size.1,
                    fps: 30,
                    pix_fmt: "rgba",
                    input: pipe_path.clone().into_os_string(),
                });

                let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<u8>>(30);

                tokio::spawn(async move {
                    let mut file = std::fs::File::create(&pipe_path).unwrap();
                    println!("video pipe opened");

                    while let Some(bytes) = rx.recv().await {
                        file.write_all(&bytes).unwrap();
                    }

                    println!("done writing to video pipe");
                });

                tx
            };

            let audio = if let Some(audio) = audio {
                let pipe_path = audio_dir.path().join("audio.pipe");
                create_named_pipe(&pipe_path).unwrap();

                ffmpeg.add_input(cap_ffmpeg::FFmpegRawAudioInput {
                    input: pipe_path.clone().into_os_string(),
                    sample_format: "f64le".to_string(),
                    sample_rate: audio.sample_rate,
                    channels: 1,
                });

                let (tx, mut rx) = tokio::sync::mpsc::channel::<Vec<f64>>(30);

                tokio::spawn(async move {
                    let mut file = std::fs::File::create(&pipe_path).unwrap();
                    println!("audio pipe opened");

                    while let Some(bytes) = rx.recv().await {
                        let bytes = bytes
                            .iter()
                            .flat_map(|f| f.to_le_bytes())
                            .collect::<Vec<_>>();
                        file.write_all(&bytes).unwrap();
                    }

                    println!("done writing to audio pipe");
                });

                Some(AudioRender {
                    data: audio,
                    pipe_tx: tx,
                })
            } else {
                None
            };

            ffmpeg
                .command
                .args(["-f", "mp4", "-map", "0:v", "-map", "1:a"])
                .args(["-codec:v", "libx264", "-codec:a", "aac"])
                .args(["-preset", "ultrafast"])
                .args(["-pix_fmt", "yuv420p", "-tune", "zerolatency"])
                .arg("-y")
                .arg(&output_path);

            let mut ffmpeg_process = ffmpeg.start();

            let mut frame_count = 0;
            let mut first_frame = None;

            loop {
                match rx_image_data.recv().await {
                    Some(frame) => {
                        on_progress(frame_count);

                        if frame_count == 0 {
                            first_frame = Some(frame.clone());
                        }

                        if let Some(audio) = &audio {
                            let samples_per_frame = audio.data.sample_rate as f64 / FPS as f64;

                            let start_samples = match project.timeline() {
                                Some(timeline) => timeline
                                    .get_recording_time(frame_count as f64 / FPS as f64)
                                    .map(|recording_time| {
                                        recording_time * audio.data.sample_rate as f64
                                    }),
                                None => Some(frame_count as f64 * samples_per_frame),
                            };

                            if let Some(start) = start_samples {
                                let end = start + samples_per_frame;

                                let samples = &audio.data.buffer[start as usize..end as usize];
                                let mut samples_iter = samples.iter().copied();

                                let mut frame_samples = Vec::new();
                                for _ in 0..samples_per_frame as usize {
                                    frame_samples.push(samples_iter.next().unwrap_or(0.0));
                                }

                                audio.pipe_tx.send(frame_samples).await.unwrap();
                            }
                        }

                        video_tx.send(frame).await.unwrap();

                        frame_count += 1;
                    }
                    None => {
                        println!("All frames sent to FFmpeg");
                        break;
                    }
                }
            }

            ffmpeg_process.stop();

            // Save the first frame as a screenshot and thumbnail
            if let Some(frame_data) = first_frame {
                let width = output_size.0;
                let height = output_size.1;
                let rgba_img: ImageBuffer<Rgba<u8>, Vec<u8>> =
                    ImageBuffer::from_raw(width, height, frame_data)
                        .expect("Failed to create image from frame data");

                // Convert RGBA to RGB
                let rgb_img: ImageBuffer<image::Rgb<u8>, Vec<u8>> =
                    ImageBuffer::from_fn(width, height, |x, y| {
                        let rgba = rgba_img.get_pixel(x, y);
                        image::Rgb([rgba[0], rgba[1], rgba[2]])
                    });

                let screenshots_dir = recording_dir.join("screenshots");
                std::fs::create_dir_all(&screenshots_dir).unwrap_or_else(|e| {
                    eprintln!("Failed to create screenshots directory: {:?}", e);
                });

                // Save full-size screenshot
                let screenshot_path = screenshots_dir.join("display.jpg");
                rgb_img.save(&screenshot_path).unwrap_or_else(|e| {
                    eprintln!("Failed to save screenshot: {:?}", e);
                });

                // Create and save thumbnail
                let thumbnail = image::imageops::resize(
                    &rgb_img,
                    100,
                    100,
                    image::imageops::FilterType::Lanczos3,
                );
                let thumbnail_path = screenshots_dir.join("thumbnail.png");
                thumbnail.save(&thumbnail_path).unwrap_or_else(|e| {
                    eprintln!("Failed to save thumbnail: {:?}", e);
                });
            } else {
                eprintln!("No frames were processed, cannot save screenshot or thumbnail");
            }
        }
    });

    println!("Rendering video to channel");

    cap_rendering::render_video_to_channel(options, project, tx_image_data, decoders).await?;

    ffmpeg_handle.await.ok();

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
    recordings: ProjectRecordings,
    path: PathBuf,
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
            editor_instance.project_path.join("project-config.json"),
        )
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok()),
        recordings: editor_instance.recordings,
        path: editor_instance.project_path.clone(),
    })
}

#[tauri::command]
#[specta::specta]
async fn copy_rendered_video_to_clipboard(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<(), String> {
    println!("copying");
    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;

    let output_path = match get_rendered_video_impl(editor_instance, project).await {
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

#[tauri::command(async)]
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

    let Some(monitor) = app.primary_monitor().ok().flatten() else {
        return;
    };

    let Some(window) = WebviewWindow::builder(
        &app,
        PREV_RECORDINGS_WINDOW,
        tauri::WebviewUrl::App("/prev-recordings".into()),
    )
    .title("Cap")
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
        350.0,
        (monitor.size().height as f64) / monitor.scale_factor(),
    )
    .position(0.0, 0.0)
    .build()
    .ok() else {
        return;
    };

    use tauri_plugin_decorum::WebviewWindowExt;
    window.make_transparent().ok();

    app.run_on_main_thread({
        let window = window.clone();
        move || {
            use tauri_nspanel::cocoa::appkit::NSWindowCollectionBehavior;
            use tauri_nspanel::WebviewWindowExt as NSPanelWebviewWindowExt;

            let panel = window.to_panel().unwrap();

            panel.set_level(NSMainMenuWindowLevel);

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
        }
    })
    .ok();

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

#[tauri::command(async)]
#[specta::specta]
fn open_editor(app: AppHandle, id: String) {
    let window = WebviewWindow::builder(
        &app,
        format!("editor-{id}"),
        WebviewUrl::App(format!("/editor?id={id}").into()),
    )
    .inner_size(1150.0, 800.0)
    .title("Cap Editor")
    .hidden_title(true)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .accept_first_mouse(true)
    .theme(Some(tauri::Theme::Light))
    .build()
    .unwrap();

    window.create_overlay_titlebar().unwrap();
    #[cfg(target_os = "macos")]
    window.set_traffic_lights_inset(20.0, 48.0).unwrap();
}

#[tauri::command(async)]
#[specta::specta]
fn close_previous_recordings_window(app: AppHandle) {
    if let Ok(panel) = app.get_webview_panel(PREV_RECORDINGS_WINDOW) {
        panel.released_when_closed(true);
        panel.close();
    }
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

#[tauri::command(async)]
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
    let (duration, _size) =
        get_video_metadata(app.clone(), video_id.clone(), Some(VideoType::Screen))
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

    ShowCapturesPanel.emit(&app).ok();
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
async fn save_project_config(app: AppHandle, video_id: String, config: ProjectConfiguration) {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    std::fs::write(
        editor_instance.project_path.join("project-config.json"),
        serde_json::to_string_pretty(&json!(config)).unwrap(),
    )
    .unwrap();
}

#[tauri::command(async)]
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
async fn list_audio_devices() -> Result<Vec<String>, ()> {
    if !permissions::do_permissions_check(false)
        .microphone
        .permitted()
    {
        return Ok(vec![]);
    }

    tokio::task::spawn_blocking(|| {
        let devices = audio::get_input_devices();

        devices.keys().cloned().collect()
    })
    .await
    .map_err(|_| ())
}

#[tauri::command(async)]
#[specta::specta]
fn open_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        window.set_focus().ok();
        return;
    }

    let Some(window) = WebviewWindow::builder(&app, "main", tauri::WebviewUrl::App("/".into()))
        .title("Cap")
        .inner_size(300.0, 375.0)
        .resizable(false)
        .maximized(false)
        .shadow(true)
        .accept_first_mouse(true)
        .transparent(true)
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .theme(Some(tauri::Theme::Light))
        .build()
        .ok()
    else {
        return;
    };

    window.create_overlay_titlebar().unwrap();
    #[cfg(target_os = "macos")]
    window.set_traffic_lights_inset(14.0, 22.0).unwrap();
}

#[tauri::command]
#[specta::specta]
async fn open_feedback_window(app: AppHandle) {
    let window =
        WebviewWindow::builder(&app, "feedback", tauri::WebviewUrl::App("/feedback".into()))
            .title("Cap Feedback")
            .inner_size(400.0, 400.0)
            .resizable(false)
            .maximized(false)
            .shadow(true)
            .accept_first_mouse(true)
            .transparent(true)
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .build()
            .unwrap();

    window.create_overlay_titlebar().unwrap();
    #[cfg(target_os = "macos")]
    window.set_traffic_lights_inset(14.0, 22.0).unwrap();
}

#[tauri::command]
#[specta::specta]
async fn open_changelog_window(app: AppHandle) {
    let window = WebviewWindow::builder(
        &app,
        "changelog",
        tauri::WebviewUrl::App("/changelog".into()),
    )
    .title("Cap Changelog")
    .inner_size(600.0, 450.0)
    .resizable(true)
    .maximized(false)
    .shadow(true)
    .accept_first_mouse(true)
    .transparent(true)
    .hidden_title(true)
    .title_bar_style(tauri::TitleBarStyle::Overlay)
    .build()
    .unwrap();

    window.create_overlay_titlebar().unwrap();
    #[cfg(target_os = "macos")]
    window.set_traffic_lights_inset(14.0, 22.0).unwrap();
}

#[tauri::command]
#[specta::specta]
async fn open_settings_window(app: AppHandle) {
    let window =
        WebviewWindow::builder(&app, "settings", tauri::WebviewUrl::App("/settings".into()))
            .title("Cap Settings")
            .inner_size(600.0, 450.0)
            .resizable(true)
            .maximized(false)
            .shadow(true)
            .accept_first_mouse(true)
            .transparent(true)
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .build()
            .unwrap();

    window.create_overlay_titlebar().unwrap();
    #[cfg(target_os = "macos")]
    window.set_traffic_lights_inset(14.0, 22.0).unwrap();
}

#[tauri::command]
#[specta::specta]
async fn upload_rendered_video(
    app: AppHandle,
    video_id: String,
    project: ProjectConfiguration,
) -> Result<(), String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        println!("not authenticated!");
        return Err("Not authenticated".to_string());
    };

    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;

    let mut meta = editor_instance.meta();

    let share_link = if let Some(sharing) = meta.sharing {
        sharing.link
    } else {
        let output_path = match get_rendered_video_impl(editor_instance.clone(), project).await {
            Ok(path) => {
                println!("Successfully retrieved rendered video path: {:?}", path);
                path
            }
            Err(e) => {
                println!("Failed to get rendered video: {}", e);
                return Err(format!("Failed to get rendered video: {}", e));
            }
        };

        let uploaded_video = upload_video(video_id.clone(), auth.token, output_path)
            .await
            .unwrap();

        meta.sharing = Some(SharingMeta {
            link: uploaded_video.link.clone(),
            id: uploaded_video.id.clone(),
        });
        meta.save_for_project();
        RecordingMetaChanged { id: video_id }.emit(&app).ok();

        uploaded_video.link
    };

    println!("Copying to clipboard: {:?}", share_link);

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSString};
        use objc::rc::autoreleasepool;

        unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let ns_string = NSString::alloc(nil).init_str(&share_link);

                let objects: id = NSArray::arrayWithObject(nil, ns_string);

                NSPasteboard::writeObjects(pasteboard, objects);
            });
        }
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn upload_screenshot(app: AppHandle, screenshot_path: PathBuf) -> Result<String, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        println!("not authenticated!");
        return Err("Not authenticated".to_string());
    };

    println!("Uploading screenshot: {:?}", screenshot_path);

    let screenshot_dir = screenshot_path.parent().unwrap().to_path_buf();
    let mut meta = RecordingMeta::load_for_project(&screenshot_dir).unwrap();

    let share_link = if let Some(sharing) = meta.sharing.as_ref() {
        // Screenshot already uploaded, use existing link
        println!("Screenshot already uploaded, using existing link");
        sharing.link.clone()
    } else {
        // Upload the screenshot
        let uploaded = upload_image(auth.token, screenshot_path.clone())
            .await
            .map_err(|e| e.to_string())?;

        meta.sharing = Some(SharingMeta {
            link: uploaded.link.clone(),
            id: uploaded.id.clone(),
        });
        meta.save_for_project();

        RecordingMetaChanged {
            id: screenshot_path
                .file_stem()
                .unwrap()
                .to_str()
                .unwrap()
                .to_string(),
        }
        .emit(&app)
        .ok();

        uploaded.link
    };

    println!("Copying to clipboard: {:?}", share_link);

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSString};
        use objc::rc::autoreleasepool;

        unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let ns_string = NSString::alloc(nil).init_str(&share_link);

                let objects: id = NSArray::arrayWithObject(nil, ns_string);

                NSPasteboard::writeObjects(pasteboard, objects);
            });
        }
    }

    Ok(share_link)
}

#[tauri::command]
#[specta::specta]
async fn take_screenshot(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("screenshots")
        .join(format!("{id}.cap"));

    std::fs::create_dir_all(&recording_dir).map_err(|e| e.to_string())?;

    // Take screenshot using scap with optimized settings
    let options = scap::capturer::Options {
        fps: 1,
        output_type: scap::frame::FrameType::BGRAFrame,
        show_highlight: false,
        ..Default::default()
    };

    if let Some(window) = app.get_webview_window("main") {
        window.hide().ok();
    }

    let mut capturer = Capturer::new(options);
    capturer.start_capture();

    let frame = match capturer.get_next_frame() {
        Ok(frame) => frame,
        Err(e) => return Err(format!("Failed to get frame: {}", e)),
    };

    capturer.stop_capture();

    if let Frame::BGRA(bgra_frame) = frame {
        let width = bgra_frame.width as u32;
        let height = bgra_frame.height as u32;

        let now = chrono::Local::now();
        let screenshot_name = format!(
            "Cap {} at {}.png",
            now.format("%Y-%m-%d"),
            now.format("%H.%M.%S")
        );
        let screenshot_path = recording_dir.join(&screenshot_name);

        // Perform image processing and saving asynchronously
        let app_handle = app.clone();
        task::spawn_blocking(move || -> Result<(), String> {
            // Convert BGRA to RGBA
            let mut rgba_data = vec![0; bgra_frame.data.len()];
            for (bgra, rgba) in bgra_frame
                .data
                .chunks_exact(4)
                .zip(rgba_data.chunks_exact_mut(4))
            {
                rgba[0] = bgra[2];
                rgba[1] = bgra[1];
                rgba[2] = bgra[0];
                rgba[3] = bgra[3];
            }

            // Create file and PNG encoder
            let file = File::create(&screenshot_path).map_err(|e| e.to_string())?;
            let ref mut w = BufWriter::new(file);

            let mut encoder = Encoder::new(w, width, height);
            encoder.set_color(ColorType::Rgba);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;

            // Write image data
            writer
                .write_image_data(&rgba_data)
                .map_err(|e| e.to_string())?;

            AppSounds::Screenshot.play();

            if let Some(window) = app.get_webview_window("main") {
                window.show().ok();
            }

            let now = chrono::Local::now();
            let screenshot_name = format!(
                "Cap {} at {}.png",
                now.format("%Y-%m-%d"),
                now.format("%H.%M.%S")
            );

            use cap_project::*;
            RecordingMeta {
                project_path: recording_dir.clone(),
                sharing: None,
                pretty_name: screenshot_name,
                display: Display {
                    path: screenshot_path.clone(),
                },
                camera: None,
                audio: None,
                segments: vec![],
            }
            .save_for_project();

            NewScreenshotAdded {
                path: screenshot_path,
            }
            .emit(&app_handle)
            .ok();

            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;

        Ok(())
    } else {
        Err("Unexpected frame type".to_string())
    }
}

#[tauri::command]
#[specta::specta]
async fn save_file_dialog(
    app: AppHandle,
    file_name: String,
    file_type: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    open_main_window(app.clone());

    println!(
        "save_file_dialog called with file_name: {}, file_type: {}",
        file_name, file_type
    );

    // Remove the ".cap" suffix if present
    let file_name = file_name
        .strip_suffix(".cap")
        .unwrap_or(&file_name)
        .to_string();
    println!("File name after removing .cap suffix: {}", file_name);

    // Determine the file type and extension
    let (name, extension) = match file_type.as_str() {
        "recording" => {
            println!("File type is recording");
            ("MP4 Video", "mp4")
        }
        "screenshot" => {
            println!("File type is screenshot");
            ("PNG Image", "png")
        }
        _ => {
            println!("Invalid file type: {}", file_type);
            return Err("Invalid file type".to_string());
        }
    };

    println!(
        "Showing save dialog with name: {}, extension: {}",
        name, extension
    );

    let (tx, rx) = std::sync::mpsc::channel();
    println!("Created channel for communication");

    app.dialog()
        .file()
        .set_title("Save File")
        .set_file_name(file_name)
        .add_filter(name, &[extension])
        .save_file(move |path| {
            println!("Save file callback triggered");
            let _ = tx.send(path.map(|p| p.to_string_lossy().to_string()));
        });

    println!("Waiting for user selection");
    let result = rx.recv().map_err(|e| {
        println!("Error receiving result: {}", e);
        e.to_string()
    })?;

    println!("Save dialog result: {:?}", result);

    Ok(result)
}

#[derive(Serialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct RecordingMetaChanged {
    id: String,
}

#[tauri::command(async)]
#[specta::specta]
fn get_recording_meta(app: AppHandle, id: String, file_type: String) -> RecordingMeta {
    let meta_path = match file_type.as_str() {
        "recording" => recording_path(&app, &id),
        "screenshot" => screenshot_path(&app, &id),
        _ => panic!("Invalid file type: {}", file_type),
    };

    RecordingMeta::load_for_project(&meta_path).unwrap()
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
            pause_recording,
            resume_recording,
            take_screenshot,
            list_cameras,
            list_capture_windows,
            list_audio_devices,
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
            copy_screenshot_to_clipboard,
            open_file_path,
            get_video_metadata,
            create_editor_instance,
            start_playback,
            stop_playback,
            set_playhead_position,
            open_in_finder,
            save_project_config,
            open_editor,
            open_main_window,
            permissions::open_permission_settings,
            permissions::do_permissions_check,
            permissions::request_permission,
            upload_rendered_video,
            upload_screenshot,
            get_recording_meta,
            open_feedback_window,
            open_settings_window,
            open_changelog_window,
            save_file_dialog,
            hotkeys::set_hotkey
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            ShowCapturesPanel,
            NewRecordingAdded,
            NewScreenshotAdded,
            RenderFrameEvent,
            EditorStateChanged,
            CurrentRecordingChanged,
            RecordingMetaChanged,
            RecordingStarted,
            RecordingStopped,
            RequestStartRecording,
            RequestRestartRecording,
            RequestStopRecording,
            RequestNewScreenshot,
        ])
        .ty::<ProjectConfiguration>()
        .ty::<AuthStore>()
        .ty::<hotkeys::HotkeysStore>();

    #[cfg(debug_assertions)]
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
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            specta_builder.mount_events(app);
            hotkeys::init(app.handle());

            let app_handle = app.handle().clone();

            if permissions::do_permissions_check(true).necessary_granted() {
                open_main_window(app_handle.clone());
            } else {
                permissions::open_permissions_window(app);
            }

            app.manage(Arc::new(RwLock::new(App {
                handle: app_handle.clone(),
                start_recording_options: RecordingOptions {
                    capture_target: CaptureTarget::Screen,
                    camera_label: None,
                    audio_input_name: None,
                },
                current_recording: None,
            })));

            app.manage(FakeWindowBounds(Arc::new(RwLock::new(HashMap::new()))));

            tray::create_tray(&app_handle).unwrap();

            create_in_progress_recording_window(app.app_handle());

            let app_handle_clone = app_handle.clone();
            RequestStartRecording::listen_any(app, move |_| {
                let app_handle = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<Arc<RwLock<App>>>();
                    let is_recording = {
                        let app_state = state.read().await;
                        app_state.current_recording.is_some()
                    };

                    if is_recording {
                        if let Err(e) = stop_recording(app_handle.clone(), app_handle.state()).await
                        {
                            eprintln!("Failed to stop recording: {}", e);
                        }
                    } else {
                        if let Err(e) =
                            start_recording(app_handle.clone(), app_handle.state()).await
                        {
                            eprintln!("Failed to start recording: {}", e);
                        }
                    }
                });
            });

            let app_handle_clone = app_handle.clone();
            RequestStopRecording::listen_any(app, move |_| {
                let app_handle = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = stop_recording(app_handle.clone(), app_handle.state()).await {
                        eprintln!("Failed to stop recording: {}", e);
                    }
                });
            });

            let app_handle_clone = app_handle.clone();
            RequestRestartRecording::listen_any(app, move |_| {
                let app_handle = app_handle_clone.clone();
                println!("RequestRestartRecording received");
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<Arc<RwLock<App>>>();

                    // Stop and discard the current recording
                    {
                        let mut app_state = state.write().await;
                        if let Some(mut recording) = app_state.clear_current_recording() {
                            CurrentRecordingChanged(JsonValue::new(&None))
                                .emit(&app_handle)
                                .ok();

                            println!("Stopping and discarding current recording");
                            recording.stop_and_discard();
                        }
                    }

                    // Start a new recording immediately
                    println!("Starting new recording");
                    if let Err(e) = start_recording(app_handle.clone(), state).await {
                        eprintln!("Failed to start new recording: {}", e);
                    } else {
                        println!("New recording started successfully");
                    }
                });
            });

            let app_handle_clone = app_handle.clone();
            RequestNewScreenshot::listen_any(app, move |_| {
                let app_handle = app_handle_clone.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = take_screenshot(app_handle.clone(), app_handle.state()).await {
                        eprintln!("Failed to take screenshot: {}", e);
                    }
                });
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            if label.starts_with("editor-") {
                if let WindowEvent::CloseRequested { .. } = event {
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

type EditorInstancesState = Arc<Mutex<HashMap<String, Arc<EditorInstance>>>>;

pub async fn remove_editor_instance(
    app: &AppHandle,
    video_id: String,
) -> Option<Arc<EditorInstance>> {
    let map = match app.try_state::<EditorInstancesState>() {
        Some(s) => (*s).clone(),
        None => return None,
    };

    let mut map = map.lock().await;

    map.remove(&video_id).clone()
}

pub async fn upsert_editor_instance(app: &AppHandle, video_id: String) -> Arc<EditorInstance> {
    let map = match app.try_state::<EditorInstancesState>() {
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

fn recording_path(app: &AppHandle, recording_id: &str) -> PathBuf {
    recordings_path(app).join(format!("{}.cap", recording_id))
}

fn screenshots_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("screenshots")
}

fn screenshot_path(app: &AppHandle, screenshot_id: &str) -> PathBuf {
    screenshots_path(app).join(format!("{}.cap", screenshot_id))
}
