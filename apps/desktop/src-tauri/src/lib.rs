mod audio;
mod auth;
mod camera;
mod flags;
mod general_settings;
mod hotkeys;
mod notifications;
mod permissions;
mod platform;
mod recording;
// mod resource;
mod audio_meter;
mod export;
mod fake_window;
mod tray;
mod upload;
mod web_api;
mod windows;

use audio::AppSounds;
use auth::{AuthStore, AuthenticationInvalid};
use cap_editor::EditorState;
use cap_editor::{EditorInstance, ProjectRecordings, FRAMES_WS_PATH};
use cap_media::feeds::{AudioInputFeed, AudioInputSamplesSender};
use cap_media::sources::CaptureScreen;
use cap_media::{
    feeds::{CameraFeed, CameraFrameSender},
    sources::ScreenCaptureTarget,
};
use cap_project::{Content, ProjectConfiguration, RecordingMeta, SharingMeta};
use cap_recording::RecordingOptions;
use fake_window::FakeWindowBounds;
// use display::{list_capture_windows, Bounds, CaptureTarget, FPS};
use general_settings::GeneralSettingsStore;
use mp4::Mp4Reader;
use notifications::NotificationType;
use png::{ColorType, Encoder};
use scap::capturer::Capturer;
use scap::frame::Frame;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::fs::File;
use std::future::Future;
use std::io::BufWriter;
use std::str::FromStr;
use std::{
    collections::HashMap, io::BufReader, marker::PhantomData, path::PathBuf, process::Command,
    sync::Arc,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_shell::ShellExt;
use tauri_specta::Event;
use tokio::sync::{Mutex, RwLock};
use upload::{get_s3_config, upload_image, upload_video, S3UploadMeta};
use windows::{CapWindowId, ShowCapWindow};

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    start_recording_options: RecordingOptions,
    #[serde(skip)]
    camera_tx: CameraFrameSender,
    camera_ws_port: u16,
    #[serde(skip)]
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    #[serde(skip)]
    audio_input_feed: Option<AudioInputFeed>,
    #[serde(skip)]
    audio_input_tx: AudioInputSamplesSender,
    #[serde(skip)]
    handle: AppHandle,
    #[serde(skip)]
    current_recording: Option<cap_recording::ActorHandle>,
    #[serde(skip)]
    pre_created_video: Option<PreCreatedVideo>,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Screen,
    Output,
}

#[derive(Serialize, Deserialize, specta::Type)]
enum UploadResult {
    Success(String),
    NotAuthenticated,
    PlanCheckFailed,
    UpgradeRequired,
}

#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct PreCreatedVideo {
    id: String,
    link: String,
    config: S3UploadMeta,
}

impl App {
    pub fn set_current_recording(&mut self, actor: cap_recording::ActorHandle) {
        let current_recording = self.current_recording.insert(actor);

        CurrentRecordingChanged.emit(&self.handle).ok();

        if matches!(
            current_recording.options.capture_target,
            ScreenCaptureTarget::Window(_)
        ) {
            let _ = ShowCapWindow::WindowCaptureOccluder.show(&self.handle);
        } else {
            self.close_occluder_window();
        }
    }

    pub fn clear_current_recording(&mut self) -> Option<cap_recording::ActorHandle> {
        self.close_occluder_window();

        self.current_recording.take()
    }

    fn close_occluder_window(&self) {
        if let Some(window) = CapWindowId::WindowCaptureOccluder.get(&self.handle) {
            window.close().ok();
        }
    }

    async fn set_start_recording_options(&mut self, new_options: RecordingOptions) {
        let options = new_options.clone();
        sentry::configure_scope(move |scope| {
            let mut ctx = std::collections::BTreeMap::new();
            ctx.insert(
                "capture_target".into(),
                match options.capture_target {
                    ScreenCaptureTarget::Screen(screen) => screen.name,
                    ScreenCaptureTarget::Window(window) => window.owner_name,
                }
                .into(),
            );
            ctx.insert(
                "camera".into(),
                options.camera_label.unwrap_or("None".into()).into(),
            );
            ctx.insert(
                "microphone".into(),
                options.audio_input_name.unwrap_or("None".into()).into(),
            );
            scope.set_context("recording_options", sentry::protocol::Context::Other(ctx));
        });

        match CapWindowId::Camera.get(&self.handle) {
            Some(window) if new_options.camera_label().is_none() => {
                println!("closing camera window");
                window.close().ok();
            }
            None if new_options.camera_label().is_some() => {
                println!("creating camera window");
                ShowCapWindow::Camera {
                    ws_port: self.camera_ws_port,
                }
                .show(&self.handle)
                .ok();
            }
            _ => {}
        }

        match new_options.camera_label() {
            Some(camera_label) => {
                if let Some(camera_feed) = self.camera_feed.as_ref() {
                    camera_feed
                        .lock()
                        .await
                        .switch_cameras(camera_label)
                        .await
                        .map_err(|error| eprintln!("{error}"))
                        .ok();
                } else {
                    self.camera_feed = CameraFeed::init(camera_label, self.camera_tx.clone())
                        .await
                        .map(Mutex::new)
                        .map(Arc::new)
                        .map_err(|error| eprintln!("{error}"))
                        .ok();
                }
            }
            None => {
                self.camera_feed = None;
            }
        }

        match new_options.audio_input_name() {
            Some(audio_input_name) => {
                if let Some(audio_input_feed) = self.audio_input_feed.as_mut() {
                    audio_input_feed
                        .switch_input(audio_input_name)
                        .await
                        .map_err(|error| eprintln!("{error}"))
                        .ok();
                } else {
                    self.audio_input_feed = if let Ok(feed) = AudioInputFeed::init(audio_input_name)
                        .await
                        .map_err(|error| eprintln!("{error}"))
                    {
                        feed.add_sender(self.audio_input_tx.clone()).await.unwrap();
                        Some(feed)
                    } else {
                        None
                    };
                }
            }
            None => {
                self.audio_input_feed = None;
            }
        }

        self.start_recording_options = new_options;

        RecordingOptionsChanged.emit(&self.handle).ok();
    }
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

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

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestOpenSettings {
    page: String,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewNotification {
    title: String,
    body: String,
    is_error: bool,
}

type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

#[tauri::command]
#[specta::specta]
async fn get_recording_options(state: MutableState<'_, App>) -> Result<RecordingOptions, ()> {
    let mut state = state.write().await;

    // If there's a saved audio input but no feed, initialize it
    if let Some(audio_input_name) = state.start_recording_options.audio_input_name() {
        if state.audio_input_feed.is_none() {
            state.audio_input_feed = if let Ok(feed) = AudioInputFeed::init(audio_input_name)
                .await
                .map_err(|error| eprintln!("{error}"))
            {
                feed.add_sender(state.audio_input_tx.clone()).await.unwrap();
                Some(feed)
            } else {
                None
            };
        }
    }

    Ok(state.start_recording_options.clone())
}

#[tauri::command]
#[specta::specta]
async fn set_recording_options(
    state: MutableState<'_, App>,
    options: RecordingOptions,
) -> Result<(), ()> {
    state
        .write()
        .await
        .set_start_recording_options(options)
        .await;

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

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecordingInfo {
    capture_target: ScreenCaptureTarget,
}

#[tauri::command]
#[specta::specta]
async fn get_current_recording(
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<RecordingInfo>>, ()> {
    let state = state.read().await;
    Ok(JsonValue::new(&state.current_recording.as_ref().map(|r| {
        RecordingInfo {
            capture_target: r.options.capture_target.clone(),
        }
    })))
}

#[derive(Serialize, Type, tauri_specta::Event, Clone)]
pub struct CurrentRecordingChanged;

async fn create_screenshot(
    input: PathBuf,
    output: PathBuf,
    size: Option<(u32, u32)>,
) -> Result<(), String> {
    println!(
        "Creating screenshot: input={:?}, output={:?}, size={:?}",
        input, output, size
    );

    let result: Result<(), String> = tokio::task::spawn_blocking(move || -> Result<(), String> {
        ffmpeg::init().map_err(|e| {
            eprintln!("Failed to initialize ffmpeg: {}", e);
            e.to_string()
        })?;

        let mut ictx = ffmpeg::format::input(&input).map_err(|e| {
            eprintln!("Failed to create input context: {}", e);
            e.to_string()
        })?;
        let input_stream = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found")?;
        let video_stream_index = input_stream.index();
        println!("Found video stream at index {}", video_stream_index);

        let mut decoder =
            ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())
                .map_err(|e| {
                    eprintln!("Failed to create decoder context: {}", e);
                    e.to_string()
                })?
                .decoder()
                .video()
                .map_err(|e| {
                    eprintln!("Failed to create video decoder: {}", e);
                    e.to_string()
                })?;

        let mut scaler = ffmpeg::software::scaling::context::Context::get(
            decoder.format(),
            decoder.width(),
            decoder.height(),
            ffmpeg::format::Pixel::RGB24,
            size.map_or(decoder.width(), |s| s.0),
            size.map_or(decoder.height(), |s| s.1),
            ffmpeg::software::scaling::flag::Flags::BILINEAR,
        )
        .map_err(|e| {
            eprintln!("Failed to create scaler: {}", e);
            e.to_string()
        })?;

        println!("Decoder and scaler initialized");

        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in ictx.packets() {
            if stream.index() == video_stream_index {
                decoder.send_packet(&packet).map_err(|e| {
                    eprintln!("Failed to send packet to decoder: {}", e);
                    e.to_string()
                })?;
                if decoder.receive_frame(&mut frame).is_ok() {
                    println!("Frame received, scaling...");
                    let mut rgb_frame = ffmpeg::frame::Video::empty();
                    scaler.run(&frame, &mut rgb_frame).map_err(|e| {
                        eprintln!("Failed to scale frame: {}", e);
                        e.to_string()
                    })?;

                    let width = rgb_frame.width() as usize;
                    let height = rgb_frame.height() as usize;
                    let bytes_per_pixel = 3;
                    let src_stride = rgb_frame.stride(0);
                    let dst_stride = width * bytes_per_pixel;

                    let mut img_buffer = vec![0u8; height * dst_stride];

                    for y in 0..height {
                        let src_slice =
                            &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
                        let dst_slice = &mut img_buffer[y * dst_stride..(y + 1) * dst_stride];
                        dst_slice.copy_from_slice(src_slice);
                    }

                    let img = image::RgbImage::from_raw(width as u32, height as u32, img_buffer)
                        .ok_or("Failed to create image from frame data")?;
                    println!("Saving image to {:?}", output);

                    img.save_with_format(&output, image::ImageFormat::Jpeg)
                        .map_err(|e| {
                            eprintln!("Failed to save image: {}", e);
                            e.to_string()
                        })?;

                    println!("Screenshot created successfully");
                    return Ok(());
                }
            }
        }

        eprintln!("Failed to create screenshot: No suitable frame found");
        Err("Failed to create screenshot".to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?;

    result
}

async fn create_thumbnail(input: PathBuf, output: PathBuf, size: (u32, u32)) -> Result<(), String> {
    println!(
        "Creating thumbnail: input={:?}, output={:?}, size={:?}",
        input, output, size
    );

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let img = image::open(&input).map_err(|e| {
            eprintln!("Failed to open image: {}", e);
            e.to_string()
        })?;

        let width = img.width() as usize;
        let height = img.height() as usize;
        let bytes_per_pixel = 3;
        let src_stride = width * bytes_per_pixel;

        let rgb_img = img.to_rgb8();
        let img_buffer = rgb_img.as_raw();

        let mut corrected_buffer = vec![0u8; height * src_stride];

        for y in 0..height {
            let src_slice = &img_buffer[y * src_stride..(y + 1) * src_stride];
            let dst_slice = &mut corrected_buffer[y * src_stride..(y + 1) * src_stride];
            dst_slice.copy_from_slice(src_slice);
        }

        let corrected_img =
            image::RgbImage::from_raw(width as u32, height as u32, corrected_buffer)
                .ok_or("Failed to create corrected image")?;

        let thumbnail = image::imageops::resize(
            &corrected_img,
            size.0,
            size.1,
            image::imageops::FilterType::Lanczos3,
        );

        thumbnail
            .save_with_format(&output, image::ImageFormat::Png)
            .map_err(|e| {
                eprintln!("Failed to save thumbnail: {}", e);
                e.to_string()
            })?;

        println!("Thumbnail created successfully");
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

async fn get_rendered_video_path(app: AppHandle, video_id: String) -> Result<PathBuf, String> {
    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;
    let output_path = editor_instance.meta().output_path();

    // If the file doesn't exist, return an error to trigger the progress-enabled path
    if !output_path.exists() {
        return Err("Rendered video does not exist".to_string());
    }

    Ok(output_path)
}

#[tauri::command]
#[specta::specta]
async fn copy_file_to_path(app: AppHandle, src: String, dst: String) -> Result<(), String> {
    println!("Attempting to copy file from {} to {}", src, dst);

    // Determine if this is a screenshot based on the path
    let is_screenshot = src.contains("screenshots/");

    match tokio::fs::copy(&src, &dst).await {
        Ok(bytes) => {
            println!(
                "Successfully copied {} bytes from {} to {}",
                bytes, src, dst
            );
            // Send appropriate success notification
            notifications::send_notification(
                &app,
                if is_screenshot {
                    notifications::NotificationType::ScreenshotSaved
                } else {
                    notifications::NotificationType::VideoSaved
                },
            );
            Ok(())
        }
        Err(e) => {
            eprintln!("Failed to copy file from {} to {}: {}", src, dst, e);
            notifications::send_notification(
                &app,
                if is_screenshot {
                    notifications::NotificationType::ScreenshotSaveFailed
                } else {
                    notifications::NotificationType::VideoSaveFailed
                },
            );
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
            notifications::send_notification(
                &app,
                notifications::NotificationType::ScreenshotCopyFailed,
            );
            return Err(format!("Failed to read screenshot file: {}", e));
        }
    };

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::{NSImage, NSPasteboard};
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSData};
        use objc::rc::autoreleasepool;

        let result = unsafe {
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
        };

        if let Err(e) = result {
            notifications::send_notification(
                &app,
                notifications::NotificationType::ScreenshotCopyFailed,
            );
            return Err(e);
        }

        notifications::send_notification(
            &app,
            notifications::NotificationType::ScreenshotCopiedToClipboard,
        );
    }

    // TODO(Ilya) (Windows) Add support
    #[cfg(not(target_os = "macos"))]
    {
        notifications::send_notification(
            &app,
            notifications::NotificationType::ScreenshotCopyFailed,
        );
        return Err("Clipboard operations are only supported on macOS".to_string());
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn open_file_path(_app: AppHandle, path: PathBuf) -> Result<(), String> {
    let path_str = path.to_str().ok_or("Invalid path")?;

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", path_str])
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-R")
            .arg(path_str)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(
                path.parent()
                    .ok_or("Invalid path")?
                    .to_str()
                    .ok_or("Invalid path")?,
            )
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

#[derive(Deserialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct RenderFrameEvent {
    frame_number: u32,
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

#[tauri::command]
#[specta::specta]
async fn start_playback(app: AppHandle, video_id: String) {
    upsert_editor_instance(&app, video_id)
        .await
        .start_playback()
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
    saved_project_config: ProjectConfiguration,
    recordings: ProjectRecordings,
    path: PathBuf,
    pretty_name: String,
}

#[tauri::command]
#[specta::specta]
async fn create_editor_instance(
    app: AppHandle,
    video_id: String,
) -> Result<SerializedEditorInstance, String> {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    // Load the RecordingMeta to get the pretty name
    let meta = RecordingMeta::load_for_project(&editor_instance.project_path)
        .map_err(|e| format!("Failed to load recording meta: {}", e))?;

    println!("Pretty name: {}", meta.pretty_name);

    Ok(SerializedEditorInstance {
        frames_socket_url: format!("ws://localhost:{}{FRAMES_WS_PATH}", editor_instance.ws_port),
        recording_duration: editor_instance.recordings.duration(),
        saved_project_config: {
            let project_config = editor_instance.project_config.1.borrow();
            project_config.clone()
        },
        recordings: editor_instance.recordings.clone(),
        path: editor_instance.project_path.clone(),
        pretty_name: meta.pretty_name,
    })
}

#[tauri::command]
#[specta::specta]
async fn copy_video_to_clipboard(app: AppHandle, path: String) -> Result<(), String> {
    println!("copying");

    #[cfg(target_os = "macos")]
    {
        use cocoa::appkit::NSPasteboard;
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSArray, NSString, NSURL};
        use objc::rc::autoreleasepool;

        let result: Result<(), String> = unsafe {
            autoreleasepool(|| {
                let pasteboard: id = NSPasteboard::generalPasteboard(nil);
                NSPasteboard::clearContents(pasteboard);

                let url_str = NSString::alloc(nil).init_str(&path);
                let url = NSURL::fileURLWithPath_(nil, url_str);

                if url == nil {
                    return Err("Failed to create NSURL".to_string());
                }

                let objects = NSArray::arrayWithObject(nil, url);
                if objects == nil {
                    return Err("Failed to create NSArray".to_string());
                }

                #[cfg(target_arch = "x86_64")]
                {
                    let write_result: i8 = NSPasteboard::writeObjects(pasteboard, objects);
                    if write_result == 0 {
                        return Err("Failed to write to pasteboard".to_string());
                    }
                }

                #[cfg(target_arch = "aarch64")]
                {
                    let write_result: bool = NSPasteboard::writeObjects(pasteboard, objects);
                    if !write_result {
                        return Err("Failed to write to pasteboard".to_string());
                    }
                }

                Ok(())
            })
        };

        if let Err(e) = result {
            println!("Failed to copy to clipboard: {}", e);
            notifications::send_notification(
                &app,
                notifications::NotificationType::VideoCopyFailed,
            );
            return Err(e);
        }
    }

    notifications::send_notification(
        &app,
        notifications::NotificationType::VideoCopiedToClipboard,
    );

    Ok(())
}

#[derive(Serialize, Deserialize, specta::Type)]
pub struct VideoRecordingMetadata {
    duration: f64,
    size: f64,
}

#[tauri::command]
#[specta::specta]
async fn get_video_metadata(
    app: AppHandle,
    video_id: String,
    video_type: Option<VideoType>,
) -> Result<VideoRecordingMetadata, String> {
    let video_id = if video_id.ends_with(".cap") {
        video_id.trim_end_matches(".cap").to_string()
    } else {
        video_id
    };

    let project_path = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("recordings")
        .join(format!("{}.cap", video_id));

    let meta = RecordingMeta::load_for_project(&project_path)?;

    fn content_paths(project_path: &PathBuf, meta: &RecordingMeta) -> Vec<PathBuf> {
        match &meta.content {
            Content::SingleSegment { segment } => {
                vec![segment.path(&meta, &segment.display.path)]
            }
            Content::MultipleSegments { inner } => inner
                .segments
                .iter()
                .map(|s| inner.path(&meta, &s.display.path))
                .collect(),
        }
    }

    let paths = match video_type {
        Some(VideoType::Screen) => content_paths(&project_path, &meta),
        Some(VideoType::Output) | None => {
            let output_video_path = project_path.join("output").join("result.mp4");
            println!("Using output video path: {:?}", output_video_path);
            if output_video_path.exists() {
                vec![output_video_path]
            } else {
                println!("Output video not found, falling back to screen paths");
                content_paths(&project_path, &meta)
            }
        }
    };

    let mut ret = VideoRecordingMetadata {
        size: 0.0,
        duration: 0.0,
    };

    for path in paths {
        let file = File::open(&path).map_err(|e| format!("Failed to open video file: {}", e))?;

        ret.size += (file
            .metadata()
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .len() as f64)
            / (1024.0 * 1024.0);

        let reader = BufReader::new(file);
        let file_size = path
            .metadata()
            .map_err(|e| format!("Failed to get file metadata: {}", e))?
            .len();

        ret.duration += match Mp4Reader::read_header(reader, file_size) {
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
    }

    Ok(ret)
}

#[tauri::command(async)]
#[specta::specta]
fn open_editor(app: AppHandle, id: String) {
    println!("Opening editor for recording: {}", id);

    if let Some(window) = app.get_webview_window("camera") {
        window.close().ok();
    }

    ShowCapWindow::Editor { project_id: id }.show(&app).unwrap();
}

#[tauri::command(async)]
#[specta::specta]
fn close_previous_recordings_window(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel(&CapWindowId::PrevRecordings.label()) {
            panel.released_when_closed(true);
            panel.close();
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
fn focus_captures_panel(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel(&CapWindowId::PrevRecordings.label()) {
            panel.make_key_window();
        }
    }
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
async fn set_project_config(app: AppHandle, video_id: String, config: ProjectConfiguration) {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    config.write(&editor_instance.project_path).unwrap();

    editor_instance.project_config.0.send(config).ok();
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

    Ok(AudioInputFeed::list_devices().keys().cloned().collect())
}

#[tauri::command(async)]
#[specta::specta]
fn open_main_window(app: AppHandle) {
    let permissions = permissions::do_permissions_check(false);
    if !permissions.screen_recording.permitted() || !permissions.accessibility.permitted() {
        return;
    }

    ShowCapWindow::Main.show(&app).ok();
}

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct UploadProgress {
    stage: String,
    progress: f64,
    message: String,
}

#[derive(Deserialize, Type)]
pub enum UploadMode {
    Initial {
        pre_created_video: Option<PreCreatedVideo>,
    },
    Reupload,
}

#[tauri::command]
#[specta::specta]
async fn upload_exported_video(
    app: AppHandle,
    video_id: String,
    mode: UploadMode,
) -> Result<UploadResult, String> {
    let Ok(Some(mut auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    // Check if user has an upgraded plan
    if !auth.is_upgraded() {
        match AuthStore::fetch_and_update_plan(&app).await {
            Ok(_) => match AuthStore::get(&app) {
                Ok(Some(updated_auth)) => {
                    auth = updated_auth;
                }
                Ok(None) => {
                    return Ok(UploadResult::NotAuthenticated);
                }
                Err(e) => return Err(format!("Failed to refresh auth: {}", e)),
            },
            Err(e) => {
                if e.contains("Authentication expired") {
                    return Ok(UploadResult::NotAuthenticated);
                }
                return Ok(UploadResult::PlanCheckFailed);
            }
        }

        if !auth.is_upgraded() {
            ShowCapWindow::Upgrade.show(&app).ok();
            return Ok(UploadResult::UpgradeRequired);
        }
    }

    let editor_instance = upsert_editor_instance(&app, video_id.clone()).await;
    let mut meta = editor_instance.meta();

    let output_path = meta.output_path();
    if !output_path.exists() {
        notifications::send_notification(&app, notifications::NotificationType::UploadFailed);
        return Err("Failed to upload video: Rendered video not found".to_string());
    }

    // Start upload progress
    UploadProgress {
        stage: "uploading".to_string(),
        progress: 0.0,
        message: "Starting upload...".to_string(),
    }
    .emit(&app)
    .ok();

    let s3_config = async {
        let video_id = match mode {
            UploadMode::Initial { pre_created_video } => {
                if let Some(pre_created) = pre_created_video {
                    return Ok(pre_created.config);
                }
                None
            }
            UploadMode::Reupload => {
                let Some(sharing) = meta.sharing.clone() else {
                    return Err("No sharing metadata found".to_string());
                };

                Some(sharing.id)
            }
        };

        get_s3_config(&app, false, video_id).await
    }
    .await?;

    match upload_video(&app, video_id.clone(), output_path, false, Some(s3_config)).await {
        Ok(uploaded_video) => {
            // Emit upload complete
            UploadProgress {
                stage: "uploading".to_string(),
                progress: 1.0,
                message: "Upload complete!".to_string(),
            }
            .emit(&app)
            .ok();

            meta.sharing = Some(SharingMeta {
                link: uploaded_video.link.clone(),
                id: uploaded_video.id.clone(),
            });
            meta.save_for_project().ok();
            RecordingMetaChanged { id: video_id }.emit(&app).ok();

            // Copy link to clipboard
            #[cfg(target_os = "macos")]
            platform::macos::write_string_to_pasteboard(&uploaded_video.link);

            NotificationType::ShareableLinkCopied.send(&app);

            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(e) => {
            NotificationType::UploadFailed.send(&app);
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn upload_screenshot(
    app: AppHandle,
    screenshot_path: PathBuf,
) -> Result<UploadResult, String> {
    let Ok(Some(mut auth)) = AuthStore::get(&app) else {
        // Sign out and redirect to sign in
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    if !auth.is_upgraded() {
        match AuthStore::fetch_and_update_plan(&app).await {
            Ok(_) => match AuthStore::get(&app) {
                Ok(Some(updated_auth)) => {
                    auth = updated_auth;
                }
                Ok(None) => {
                    return Ok(UploadResult::NotAuthenticated);
                }
                Err(e) => return Err(format!("Failed to refresh auth: {}", e)),
            },
            Err(e) => {
                if e.contains("Authentication expired") {
                    return Ok(UploadResult::NotAuthenticated);
                }
                return Ok(UploadResult::PlanCheckFailed);
            }
        }

        if !auth.is_upgraded() {
            ShowCapWindow::Upgrade.show(&app).ok();
            return Ok(UploadResult::UpgradeRequired);
        }
    }

    println!("Uploading screenshot: {:?}", screenshot_path);

    let screenshot_dir = screenshot_path.parent().unwrap().to_path_buf();
    let mut meta = RecordingMeta::load_for_project(&screenshot_dir).unwrap();

    let share_link = if let Some(sharing) = meta.sharing.as_ref() {
        // Screenshot already uploaded, use existing link
        println!("Screenshot already uploaded, using existing link");
        sharing.link.clone()
    } else {
        // Upload the screenshot
        let uploaded = upload_image(&app, screenshot_path.clone())
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

    // Copy link to clipboard
    #[cfg(target_os = "macos")]
    platform::write_string_to_pasteboard(&share_link);

    // Send notification after successful upload and clipboard copy
    notifications::send_notification(&app, notifications::NotificationType::ShareableLinkCopied);

    Ok(UploadResult::Success(share_link))
}

#[tauri::command]
#[specta::specta]
async fn take_screenshot(app: AppHandle, _state: MutableState<'_, App>) -> Result<(), String> {
    let id = uuid::Uuid::new_v4().to_string();

    let recording_dir = app
        .path()
        .app_data_dir()
        .unwrap()
        .join("screenshots")
        .join(format!("{id}.cap"));

    std::fs::create_dir_all(&recording_dir).map_err(|e| e.to_string())?;

    // Capture the screenshot synchronously before any await points
    let (width, height, bgra_data) = {
        // Take screenshot using scap with optimized settings
        let options = scap::capturer::Options {
            fps: 1,
            output_type: scap::frame::FrameType::BGRAFrame,
            show_highlight: false,
            ..Default::default()
        };

        // Hide main window before taking screenshot
        if let Some(window) = CapWindowId::Main.get(&app) {
            window.hide().ok();
        }

        // Create and use capturer on the main thread
        let mut capturer = Capturer::new(options);
        capturer.start_capture();
        let frame = capturer
            .get_next_frame()
            .map_err(|e| format!("Failed to get frame: {}", e))?;
        capturer.stop_capture();

        // Show main window after taking screenshot
        if let Some(window) = CapWindowId::Main.get(&app) {
            window.show().ok();
        }

        match frame {
            Frame::BGRA(bgra_frame) => Ok((
                bgra_frame.width as u32,
                bgra_frame.height as u32,
                bgra_frame.data,
            )),
            _ => Err("Unexpected frame type".to_string()),
        }
    }?;

    let now = chrono::Local::now();
    let screenshot_name = format!(
        "Cap {} at {}.png",
        now.format("%Y-%m-%d"),
        now.format("%H.%M.%S")
    );
    let screenshot_path = recording_dir.join(&screenshot_name);

    let app_handle = app.clone();
    let recording_dir = recording_dir.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Convert BGRA to RGBA
        let mut rgba_data = vec![0; bgra_data.len()];
        for (bgra, rgba) in bgra_data.chunks_exact(4).zip(rgba_data.chunks_exact_mut(4)) {
            rgba[0] = bgra[2];
            rgba[1] = bgra[1];
            rgba[2] = bgra[0];
            rgba[3] = bgra[3];
        }

        // Create file and PNG encoder
        let file = File::create(&screenshot_path).map_err(|e| e.to_string())?;
        let w = &mut BufWriter::new(file);

        let mut encoder = Encoder::new(w, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;

        // Write image data
        writer
            .write_image_data(&rgba_data)
            .map_err(|e| e.to_string())?;

        AppSounds::Screenshot.play();

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
            content: cap_project::Content::SingleSegment {
                segment: cap_project::SingleSegment {
                    display: Display {
                        path: screenshot_path.clone(),
                    },
                    camera: None,
                    audio: None,
                    cursor: None,
                },
            },
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
    .map_err(|e| format!("Task join error: {}", e))??;

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn save_file_dialog(
    app: AppHandle,
    file_name: String,
    file_type: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

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
            let _ = tx.send(
                path.as_ref()
                    .and_then(|p| p.as_path())
                    .map(|p| p.to_string_lossy().to_string()),
            );
        });

    println!("Waiting for user selection");
    match rx.recv() {
        Ok(result) => {
            println!("Save dialog result: {:?}", result);
            // Don't send any notifications here - we'll do it after the file is actually copied
            Ok(result)
        }
        Err(e) => {
            println!("Error receiving result: {}", e);
            notifications::send_notification(
                &app,
                notifications::NotificationType::VideoSaveFailed,
            );
            Err(e.to_string())
        }
    }
}

#[derive(Serialize, specta::Type, tauri_specta::Event, Debug, Clone)]
struct RecordingMetaChanged {
    id: String,
}

#[tauri::command(async)]
#[specta::specta]
fn get_recording_meta(
    app: AppHandle,
    id: String,
    file_type: String,
) -> Result<RecordingMeta, String> {
    let meta_path = match file_type.as_str() {
        "recording" => recording_path(&app, &id),
        "screenshot" => screenshot_path(&app, &id),
        _ => return Err("Invalid file type".to_string()),
    };

    RecordingMeta::load_for_project(&meta_path)
        .map_err(|e| format!("Failed to load recording meta: {}", e))
}

#[tauri::command]
#[specta::specta]
fn list_recordings(app: AppHandle) -> Result<Vec<(String, PathBuf, RecordingMeta)>, String> {
    let recordings_dir = recordings_path(&app);

    // First check if directory exists
    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?
        .filter_map(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return None,
            };

            let path = entry.path();

            // Multiple validation checks
            if !path.is_dir() {
                return None;
            }

            let extension = match path.extension().and_then(|s| s.to_str()) {
                Some("cap") => "cap",
                _ => return None,
            };

            let id = match path.file_stem().and_then(|s| s.to_str()) {
                Some(stem) => stem.to_string(),
                None => return None,
            };

            // Try to get recording meta, skip if it fails
            match get_recording_meta(app.clone(), id.clone(), "recording".to_string()) {
                Ok(meta) => Some((id, path.clone(), meta)),
                Err(_) => None,
            }
        })
        .collect::<Vec<_>>();

    // Sort the result by creation date of the actual file, newest first
    result.sort_by(|a, b| {
        let b_time =
            b.1.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let a_time =
            a.1.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        b_time.cmp(&a_time)
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn list_screenshots(app: AppHandle) -> Result<Vec<(String, PathBuf, RecordingMeta)>, String> {
    let screenshots_dir = screenshots_path(&app);

    let mut result = std::fs::read_dir(&screenshots_dir)
        .map_err(|e| format!("Failed to read screenshots directory: {}", e))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
                let id = path.file_stem()?.to_str()?.to_string();
                let meta =
                    match get_recording_meta(app.clone(), id.clone(), "screenshot".to_string()) {
                        Ok(meta) => meta,
                        Err(_) => return None, // Skip this entry if metadata can't be loaded
                    };

                // Find the nearest .png file inside the .cap folder
                let png_path = std::fs::read_dir(&path)
                    .ok()?
                    .filter_map(|e| e.ok())
                    .find(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                    .map(|e| e.path())?;

                Some((id, png_path, meta))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    // Sort the result by creation date of the actual file, newest first
    result.sort_by(|a, b| {
        b.1.metadata()
            .and_then(|m| m.created())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.1.metadata()
                    .and_then(|m| m.created())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
async fn check_upgraded_and_update(app: AppHandle) -> Result<bool, String> {
    if let Err(e) = AuthStore::fetch_and_update_plan(&app).await {
        return Err(format!(
            "Failed to update plan information. Try signing out and signing back in: {}",
            e
        ));
    }

    let auth = AuthStore::get(&app).map_err(|e| e.to_string())?;

    Ok(auth.map_or(false, |a| a.is_upgraded()))
}

#[tauri::command]
#[specta::specta]
fn open_external_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    // Check settings first
    if let Ok(Some(settings)) = GeneralSettingsStore::get(&app) {
        if settings.disable_auto_open_links {
            return Ok(());
        }
    }

    app.shell()
        .open(&url, None)
        .map_err(|e| format!("Failed to open URL: {}", e))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn delete_auth_open_signin(app: AppHandle) -> Result<(), String> {
    AuthStore::set(&app, None).map_err(|e| e.to_string())?;

    if let Some(window) = CapWindowId::Settings.get(&app) {
        window.close().ok();
    }

    if let Some(window) = CapWindowId::Camera.get(&app) {
        window.close().ok();
    }
    if let Some(window) = CapWindowId::Main.get(&app) {
        window.close().ok();
    }

    while CapWindowId::Main.get(&app).is_none() {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn reset_camera_permissions(_app: AppHandle) -> Result<(), ()> {
    #[cfg(target_os = "macos")]
    {
        #[cfg(debug_assertions)]
        let bundle_id =
            std::env::var("CAP_BUNDLE_ID").unwrap_or_else(|_| "com.apple.Terminal".to_string());
        #[cfg(not(debug_assertions))]
        let bundle_id = "so.cap.desktop";

        Command::new("tccutil")
            .arg("reset")
            .arg("Camera")
            .arg(bundle_id)
            .output()
            .expect("Failed to reset camera permissions");
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn reset_microphone_permissions(_app: AppHandle) -> Result<(), ()> {
    #[cfg(debug_assertions)]
    let bundle_id = "com.apple.Terminal";
    #[cfg(not(debug_assertions))]
    let bundle_id = "so.cap.desktop";

    Command::new("tccutil")
        .arg("reset")
        .arg("Microphone")
        .arg(bundle_id)
        .output()
        .expect("Failed to reset microphone permissions");

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn is_camera_window_open(app: AppHandle) -> bool {
    CapWindowId::Camera.get(&app).is_some()
}

#[tauri::command]
#[specta::specta]
async fn seek_to(app: AppHandle, video_id: String, frame_number: u32) {
    let editor_instance = upsert_editor_instance(&app, video_id).await;

    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;
}

#[tauri::command]
#[specta::specta]
fn show_window(app: AppHandle, window: ShowCapWindow) {
    window.show(&app).ok();
}

async fn check_notification_permissions(app: AppHandle) {
    // Check if we've already requested permissions
    let Ok(Some(settings)) = GeneralSettingsStore::get(&app) else {
        return;
    };

    if !settings.enable_notifications {
        return;
    }

    match app.notification().permission_state() {
        Ok(state) if state != PermissionState::Granted => {
            println!("Requesting notification permission");
            match app.notification().request_permission() {
                Ok(PermissionState::Granted) => {
                    println!("Notification permission granted");
                }
                Ok(_) | Err(_) => {
                    GeneralSettingsStore::update(&app, |s| {
                        s.enable_notifications = false;
                    })
                    .ok();
                }
            }
        }
        Ok(_) => {
            println!("Notification permission already granted");
        }
        Err(e) => {
            eprintln!("Error checking notification permission state: {}", e);
        }
    }
}

#[tauri::command]
#[specta::specta]
fn set_window_theme(window: tauri::Window, dark: bool) {
    window
        .set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            get_recording_options,
            set_recording_options,
            recording::start_recording,
            recording::stop_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::list_cameras,
            recording::list_capture_windows,
            recording::list_capture_screens,
            take_screenshot,
            list_audio_devices,
            close_previous_recordings_window,
            fake_window::set_fake_window_bounds,
            fake_window::remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            export::export_video,
            copy_file_to_path,
            copy_video_to_clipboard,
            copy_screenshot_to_clipboard,
            open_file_path,
            get_video_metadata,
            create_editor_instance,
            start_playback,
            stop_playback,
            set_playhead_position,
            set_project_config,
            open_editor,
            open_main_window,
            permissions::open_permission_settings,
            permissions::do_permissions_check,
            permissions::request_permission,
            upload_exported_video,
            upload_screenshot,
            get_recording_meta,
            save_file_dialog,
            list_recordings,
            list_screenshots,
            check_upgraded_and_update,
            open_external_link,
            hotkeys::set_hotkey,
            delete_auth_open_signin,
            reset_camera_permissions,
            reset_microphone_permissions,
            is_camera_window_open,
            seek_to,
            send_feedback_request,
            windows::position_traffic_lights,
            global_message_dialog,
            show_window,
            set_window_theme,
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
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
            RequestOpenSettings,
            NewNotification,
            AuthenticationInvalid,
            audio_meter::AudioInputLevelChange,
            UploadProgress,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .typ::<ProjectConfiguration>()
        .typ::<AuthStore>()
        .typ::<hotkeys::HotkeysStore>()
        .typ::<general_settings::GeneralSettingsStore>()
        .typ::<cap_flags::Flags>();

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    let (camera_tx, camera_rx) = CameraFeed::create_channel();
    let camera_ws_port = camera::create_camera_ws(camera_rx.clone()).await;

    let (audio_input_tx, audio_input_rx) = AudioInputFeed::create_channel();

    tauri::async_runtime::set(tokio::runtime::Handle::current());

    #[allow(unused_mut)]
    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = ShowCapWindow::Main.show(app);
        }));

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags({
                    use tauri_plugin_window_state::StateFlags;
                    let mut flags = StateFlags::all();
                    flags.remove(StateFlags::VISIBLE);
                    flags
                })
                .with_denylist(&[
                    CapWindowId::Setup.label().as_str(),
                    CapWindowId::WindowCaptureOccluder.label().as_str(),
                    CapWindowId::Camera.label().as_str(),
                    CapWindowId::PrevRecordings.label().as_str(),
                    CapWindowId::InProgressRecording.label().as_str(),
                ])
                .map_label(|label| match label {
                    label if label.starts_with("editor-") => "editor",
                    _ => label,
                })
                .build(),
        )
        .plugin(flags::plugin::init())
        .invoke_handler({
            let handler = specta_builder.invoke_handler();

            move |invoke| {
                sentry::configure_scope(|scope| {
                    scope.set_tag("cmd", invoke.message.command());
                });

                handler(invoke)
            }
        })
        .setup(move |app| {
            let app = app.handle().clone();
            specta_builder.mount_events(&app);
            hotkeys::init(&app);
            general_settings::init(&app);
            fake_window::init(&app);

            if let Ok(Some(auth)) = AuthStore::load(&app) {
                sentry::configure_scope(|scope| {
                    scope.set_user(auth.user_id.map(|id| sentry::User {
                        id: Some(id),
                        ..Default::default()
                    }));
                });
            }

            // Add this line to check notification permissions on startup
            tokio::spawn(check_notification_permissions(app.clone()));

            println!("Checking startup completion and permissions...");
            let permissions = permissions::do_permissions_check(false);
            println!("Permissions check result: {:?}", permissions);

            if !permissions.screen_recording.permitted()
                || !permissions.accessibility.permitted()
                || GeneralSettingsStore::get(&app)
                    .ok()
                    .flatten()
                    .map(|s| !s.has_completed_startup)
                    .unwrap_or(false)
            {
                ShowCapWindow::Setup.show(&app).ok();
            } else {
                println!("Permissions granted, showing main window");

                ShowCapWindow::Main.show(&app).ok();
            }

            ShowCapWindow::PrevRecordings.show(&app).ok();

            audio_meter::spawn_event_emitter(app.clone(), audio_input_rx);

            app.manage(Arc::new(RwLock::new(App {
                handle: app.clone(),
                camera_tx,
                camera_ws_port,
                camera_feed: None,
                audio_input_tx,
                audio_input_feed: None,
                start_recording_options: RecordingOptions {
                    capture_target: ScreenCaptureTarget::Screen(CaptureScreen {
                        id: 1,
                        name: "Default".to_string(),
                    }),
                    camera_label: None,
                    audio_input_name: None,
                },
                current_recording: None,
                pre_created_video: None,
            })));

            tray::create_tray(&app).unwrap();

            RequestStartRecording::listen_any_spawn(&app, |_, app| async move {
                let state = app.state::<Arc<RwLock<App>>>();
                let is_recording = {
                    let app_state = state.read().await;
                    app_state.current_recording.is_some()
                };

                if is_recording {
                    if let Err(e) = recording::stop_recording(app.clone(), app.state()).await {
                        eprintln!("Failed to stop recording: {}", e);
                    }
                } else if let Err(e) = recording::start_recording(app.clone(), app.state()).await {
                    eprintln!("Failed to start recording: {}", e);
                }
            });

            RequestStopRecording::listen_any_spawn(&app, |_, app| async move {
                if let Err(e) = recording::stop_recording(app.clone(), app.state()).await {
                    eprintln!("Failed to stop recording: {}", e);
                }
            });

            RequestRestartRecording::listen_any_spawn(&app, |_, app| async move {
                let state = app.state::<Arc<RwLock<App>>>();

                // Stop and discard the current recording
                {
                    let mut app_state = state.write().await;
                    if let Some(recording) = app_state.clear_current_recording() {
                        CurrentRecordingChanged /*(JsonValue::new(&None))*/
                            .emit(&app)
                            .ok();

                        recording.stop().await.ok();

                        // recording.stop_and_discard();
                    }
                }

                if let Err(e) = recording::start_recording(app.clone(), state).await {
                    eprintln!("Failed to start new recording: {}", e);
                } else {
                    println!("New recording started successfully");
                }
            });

            RequestNewScreenshot::listen_any_spawn(&app, |_, app| async move {
                if let Err(e) = take_screenshot(app.clone(), app.state()).await {
                    eprintln!("Failed to take screenshot: {}", e);
                }
            });

            RequestOpenSettings::listen_any_spawn(&app, |payload, app| async move {
                ShowCapWindow::Settings {
                    page: Some(payload.page),
                }
                .show(&app)
                .ok();
            });

            AuthenticationInvalid::listen_any_spawn(&app, |_, app| async move {
                delete_auth_open_signin(app).await.ok();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            let app = window.app_handle();

            match event {
                WindowEvent::Destroyed => {
                    match CapWindowId::from_str(label).unwrap() {
                        CapWindowId::Main => {
                            if let Some(w) = CapWindowId::Camera.get(app) {
                                w.close().ok();
                            }
                        }
                        CapWindowId::Editor { project_id } => {
                            let app_handle = app.clone();
                            tokio::spawn(async move {
                                let _ = remove_editor_instance(&app_handle, project_id).await;
                                tokio::task::yield_now().await;
                            });
                        }
                        CapWindowId::Settings | CapWindowId::Upgrade => {
                            // Don't quit the app when settings or upgrade window is closed
                            return;
                        }
                        _ => {}
                    };

                    if let Some(settings) = GeneralSettingsStore::get(app).unwrap_or(None) {
                        if settings.hide_dock_icon
                            && app.webview_windows().keys().all(|label| {
                                !CapWindowId::from_str(label).unwrap().activates_dock()
                            })
                        {
                            #[cfg(target_os = "macos")]
                            app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                                .ok();
                        }
                    }
                }
                WindowEvent::Focused(focused) if *focused => {
                    if CapWindowId::from_str(label).unwrap().activates_dock() {
                        #[cfg(target_os = "macos")]
                        app.set_activation_policy(tauri::ActivationPolicy::Regular)
                            .ok();
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                // Check if any editor or settings window is open
                let has_editor_or_settings = handle
                    .webview_windows()
                    .iter()
                    .any(|(label, _)| label.starts_with("editor-") || label.as_str() == "settings");

                if has_editor_or_settings {
                    // Find and focus the editor or settings window
                    if let Some(window) = handle
                        .webview_windows()
                        .iter()
                        .find(|(label, _)| {
                            label.starts_with("editor-") || label.as_str() == "settings"
                        })
                        .map(|(_, window)| window.clone())
                    {
                        window.set_focus().ok();
                    }
                } else {
                    // No editor or settings window open, show main window
                    open_main_window(handle.clone());
                }
            }
            _ => {}
        });
}

type EditorInstancesState = Arc<Mutex<HashMap<String, Arc<EditorInstance>>>>;

pub async fn remove_editor_instance(
    app: &AppHandle<impl Runtime>,
    video_id: String,
) -> Option<Arc<EditorInstance>> {
    let map = match app.try_state::<EditorInstancesState>() {
        Some(s) => (*s).clone(),
        None => return None,
    };

    let mut map = map.lock().await;

    if let Some(editor) = map.remove(&video_id) {
        editor.dispose().await;
        Some(editor)
    } else {
        None
    }
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
        let preview_tx = instance.preview_tx.clone();
        move |e| {
            preview_tx.send(Some(e.payload.frame_number)).ok();
        }
    });

    instance
}

// use EditorInstance.project_path instead of this
fn recordings_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("recordings");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

fn recording_path(app: &AppHandle, recording_id: &str) -> PathBuf {
    recordings_path(app).join(format!("{}.cap", recording_id))
}

fn screenshots_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("screenshots");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

fn screenshot_path(app: &AppHandle, screenshot_id: &str) -> PathBuf {
    screenshots_path(app).join(format!("{}.cap", screenshot_id))
}

#[tauri::command]
#[specta::specta]
async fn send_feedback_request(app: AppHandle, feedback: String) -> Result<(), String> {
    let auth = AuthStore::get(&app)
        .map_err(|e| e.to_string())?
        .ok_or("Not authenticated")?;

    let feedback_url = web_api::make_url("/api/desktop/feedback");

    // Create a proper multipart form
    let form = reqwest::multipart::Form::new().text("feedback", feedback);

    let client = reqwest::Client::new();
    let response = client
        .post(feedback_url)
        .header("Authorization", format!("Bearer {}", auth.token))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send feedback: {}", e))?;

    if !response.status().is_success() {
        println!("Feedback request failed with status: {}", response.status());

        let error_text = response
            .text()
            .await
            .map_err(|_| "Failed to read error response")?;

        println!("Error response: {}", error_text);

        // Parse the error response and convert to owned String immediately
        let error = match serde_json::from_str::<serde_json::Value>(&error_text) {
            Ok(v) => v
                .get("error")
                .and_then(|e| e.as_str())
                .map(ToString::to_string)
                .unwrap_or_else(|| "Failed to submit feedback".to_string()),
            Err(_) => "Failed to submit feedback".to_string(),
        };

        return Err(error);
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
fn global_message_dialog(app: AppHandle, message: String) {
    app.dialog().message(message).show(|_| {});
}

trait EventExt: tauri_specta::Event {
    fn listen_any_spawn<Fut>(
        app: &AppHandle,
        handler: impl Fn(Self, AppHandle) -> Fut + Send + 'static + Clone,
    ) -> tauri::EventId
    where
        Fut: Future + Send,
        Self: serde::de::DeserializeOwned + Send + 'static,
    {
        let app = app.clone();
        Self::listen_any(&app.clone(), move |e| {
            let app = app.clone();
            let handler = handler.clone();
            tokio::spawn(async move {
                (handler)(e.payload, app).await;
            });
        })
    }
}

impl<T: tauri_specta::Event> EventExt for T {}
