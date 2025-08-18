mod audio;
mod audio_meter;
mod auth;
mod camera;
mod camera_legacy;
mod captions;
mod deeplink_actions;
mod editor_window;
mod export;
mod fake_window;
mod flags;
mod general_settings;
mod hotkeys;
mod notifications;
mod permissions;
mod platform;
mod presets;
mod recording;
mod target_select_overlay;
mod tray;
mod upload;
mod web_api;
mod windows;

use audio::AppSounds;
use auth::{AuthStore, AuthenticationInvalid, Plan};
use camera::{CameraPreview, CameraWindowState};
use cap_editor::EditorInstance;
use cap_editor::EditorState;
use cap_media::feeds::RawCameraFrame;
use cap_media::feeds::{AudioInputFeed, AudioInputSamplesSender};
use cap_media::platform::Bounds;
use cap_media::{feeds::CameraFeed, sources::ScreenCaptureTarget};
use cap_project::RecordingMetaInner;
use cap_project::XY;
use cap_project::{
    ProjectConfiguration, RecordingMeta, SharingMeta, StudioRecordingMeta, ZoomSegment,
};
use cap_rendering::ProjectRecordingsMeta;
use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContext};
use editor_window::EditorInstances;
use editor_window::WindowEditorInstance;
use general_settings::GeneralSettingsStore;
use mp4::Mp4Reader;
use notifications::NotificationType;
use png::{ColorType, Encoder};
use recording::InProgressRecording;
use relative_path::RelativePathBuf;

use scap::capturer::Capturer;
use scap::frame::Frame;
use scap::frame::VideoFrame;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;
use std::{
    fs::File,
    future::Future,
    io::{BufReader, BufWriter},
    marker::PhantomData,
    path::PathBuf,
    process::Command,
    str::FromStr,
    sync::Arc,
};
use tauri::Window;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_specta::Event;
use tokio::sync::mpsc;
use tokio::sync::{Mutex, RwLock};
use tokio::time::timeout;
use tracing::debug;
use tracing::error;
use tracing::trace;
use upload::{S3UploadMeta, create_or_get_video, upload_image, upload_video};
use web_api::ManagerExt as WebManagerExt;
use windows::EditorWindowIds;
use windows::set_window_transparent;
use windows::{CapWindowId, ShowCapWindow};

#[allow(clippy::large_enum_variant)]
pub enum RecordingState {
    None,
    Pending,
    Active(InProgressRecording),
}

#[derive(specta::Type, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct App {
    #[serde(skip)]
    #[deprecated = "can be removed when native camera preview is ready"]
    camera_tx: flume::Sender<RawCameraFrame>,
    #[deprecated = "can be removed when native camera preview is ready"]
    camera_ws_port: u16,
    #[serde(skip)]
    camera_feed: Option<Arc<Mutex<CameraFeed>>>,
    #[serde(skip)]
    camera_feed_initialization: Option<mpsc::Sender<()>>,
    #[serde(skip)]
    mic_feed: Option<AudioInputFeed>,
    #[serde(skip)]
    mic_samples_tx: AudioInputSamplesSender,
    #[serde(skip)]
    handle: AppHandle,
    #[serde(skip)]
    recording_state: RecordingState,
    #[serde(skip)]
    recording_logging_handle: LoggingHandle,
    server_url: String,
}

#[derive(specta::Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub enum VideoType {
    Screen,
    Output,
    Camera,
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub enum UploadResult {
    Success(String),
    NotAuthenticated,
    PlanCheckFailed,
    UpgradeRequired,
}

#[derive(Serialize, Deserialize, specta::Type, Debug)]
pub struct VideoRecordingMetadata {
    pub duration: f64,
    pub size: f64,
}

#[derive(Clone, Serialize, Deserialize, specta::Type, Debug)]
pub struct VideoUploadInfo {
    id: String,
    link: String,
    config: S3UploadMeta,
}

impl App {
    pub fn set_pending_recording(&mut self) {
        self.recording_state = RecordingState::Pending;
        CurrentRecordingChanged.emit(&self.handle).ok();
    }

    pub fn set_current_recording(&mut self, actor: InProgressRecording) {
        self.recording_state = RecordingState::Active(actor);
        CurrentRecordingChanged.emit(&self.handle).ok();
    }

    pub fn clear_current_recording(&mut self) -> Option<InProgressRecording> {
        match std::mem::replace(&mut self.recording_state, RecordingState::None) {
            RecordingState::Active(recording) => {
                self.close_occluder_windows();
                Some(recording)
            }
            _ => {
                self.close_occluder_windows();
                None
            }
        }
    }

    fn close_occluder_windows(&self) {
        for window in self.handle.webview_windows() {
            if window.0.starts_with("window-capture-occluder-") {
                let _ = window.1.close();
            }
        }
    }

    async fn add_recording_logging_handle(&mut self, path: &PathBuf) -> Result<(), String> {
        let logfile =
            std::fs::File::create(path).map_err(|e| format!("Failed to create logfile: {e}"))?;

        self.recording_logging_handle
            .reload(Some(Box::new(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_target(true)
                    .with_writer(logfile),
            ) as DynLoggingLayer))
            .map_err(|e| format!("Failed to reload logging layer: {e}"))?;

        Ok(())
    }

    pub fn current_recording(&self) -> Option<&InProgressRecording> {
        match &self.recording_state {
            RecordingState::Active(recording) => Some(recording),
            _ => None,
        }
    }

    pub fn current_recording_mut(&mut self) -> Option<&mut InProgressRecording> {
        match &mut self.recording_state {
            RecordingState::Active(recording) => Some(recording),
            _ => None,
        }
    }

    pub fn is_recording_active_or_pending(&self) -> bool {
        !matches!(self.recording_state, RecordingState::None)
    }
}

#[tauri::command]
#[specta::specta]
async fn set_mic_input(state: MutableState<'_, App>, label: Option<String>) -> Result<(), String> {
    let mut app = state.write().await;

    match (label, &mut app.mic_feed) {
        (Some(label), None) => {
            AudioInputFeed::init(&label)
                .await
                .map_err(|e| e.to_string())
                .map(async |feed| {
                    feed.add_sender(app.mic_samples_tx.clone()).await.unwrap();
                    app.mic_feed = Some(feed);
                })
                .transpose_async()
                .await
        }
        (Some(label), Some(feed)) => feed.switch_input(&label).await.map_err(|e| e.to_string()),
        (None, _) => {
            debug!("removing mic in set_start_recording_options");
            app.mic_feed.take();
            Ok(())
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn set_camera_input(
    app_handle: AppHandle,
    state: MutableState<'_, App>,
    camera_preview: State<'_, CameraPreview>,
    id: Option<cap_media::feeds::DeviceOrModelID>,
) -> Result<bool, String> {
    let mut app = state.write().await;

    match (id, app.camera_feed.as_ref()) {
        (Some(id), Some(camera_feed)) => {
            camera_feed
                .lock()
                .await
                .switch_cameras(id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
        (Some(id), None) => {
            let (shutdown_tx, mut shutdown_rx) = mpsc::channel(1);
            if let Some(cancel) = app.camera_feed_initialization.as_ref() {
                // Ask currently running setup to abort
                cancel.send(()).await.ok();

                // We can assume a window was already initialized.
                // Stop it so we can recreate it with the correct `camera_tx`
                if let Some(win) = CapWindowId::Camera.get(&app_handle) {
                    win.close().unwrap(); // TODO: Error handling
                };
            } else {
                app.camera_feed_initialization = Some(shutdown_tx);
            }

            let window = ShowCapWindow::Camera.show(&app_handle).await.unwrap();
            if let Some(win) = CapWindowId::Main.get(&app_handle) {
                win.set_focus().ok();
            };

            let camera_tx = if GeneralSettingsStore::get(&app_handle)
                .ok()
                .and_then(|v| v.map(|v| v.enable_native_camera_preview))
                .unwrap_or_default()
            {
                let (camera_tx, camera_rx) = flume::bounded::<RawCameraFrame>(4);

                let prev_err = &mut None;
                if timeout(Duration::from_secs(3), async {
                    while let Err(err) = camera_preview
                        .init_preview_window(window.clone(), camera_rx.clone())
                        .await
                    {
                        error!("Error initializing camera feed: {err}");
                        *prev_err = Some(err);
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    }
                })
                .await
                .is_err()
                {
                    let _ = window.close();
                    return Err(format!("Timeout initializing camera preview: {prev_err:?}"));
                };

                Some(camera_tx)
            } else {
                None
            };

            let legacy_camera_tx = app.camera_tx.clone();
            drop(app);

            let fut = CameraFeed::init(id);

            tokio::select! {
                result = fut => {
                    let feed = result.map_err(|err| err.to_string())?;
                    let mut app = state.write().await;

                    if let Some(cancel) = app.camera_feed_initialization.take() {
                        cancel.send(()).await.ok();
                    }

                    if app.camera_feed.is_none() {
                        if let Some(camera_tx) = camera_tx {
                            feed.attach(camera_tx);
                        } else {
                            feed.attach(legacy_camera_tx);
                        }
                        app.camera_feed = Some(Arc::new(Mutex::new(feed)));
                        Ok(true)
                    } else {
                        Ok(false)
                    }
                }
                _ = shutdown_rx.recv() => {
                    Ok(false)
                }
            }
        }
        (None, _) => {
            if let Some(cancel) = app.camera_feed_initialization.take() {
                cancel.send(()).await.ok();
            }
            app.camera_feed.take();
            if let Some(w) = CapWindowId::Camera.get(&app_handle) {
                w.close().ok();
            }
            Ok(true)
        }
    }
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewStudioRecordingAdded {
    path: PathBuf,
}

#[derive(specta::Type, tauri_specta::Event, Debug, Clone)]
pub struct RecordingDeleted {
    #[allow(unused)]
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewScreenshotAdded {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStarted;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStopped;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestStartRecording;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestNewScreenshot;

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

type ArcLock<T> = Arc<RwLock<T>>;
pub type MutableState<'a, T> = State<'a, Arc<RwLock<T>>>;

type SingleTuple<T> = (T,);

#[derive(Serialize, Type)]
struct JsonValue<T>(
    #[serde(skip)] PhantomData<T>,
    #[specta(type = SingleTuple<T>)] serde_json::Value,
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

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
enum CurrentRecordingTarget {
    Window { id: u32, bounds: Bounds },
    Screen { id: u32 },
    Area { screen: u32, bounds: Bounds },
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct CurrentRecording {
    target: CurrentRecordingTarget,
    r#type: RecordingType,
}

#[tauri::command]
#[specta::specta]
async fn get_current_recording(
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<CurrentRecording>>, ()> {
    let state = state.read().await;
    Ok(JsonValue::new(&state.current_recording().map(|r| {
        let bounds = r.bounds();

        let target = match r.capture_target() {
            ScreenCaptureTarget::Screen { id } => CurrentRecordingTarget::Screen { id: *id },
            ScreenCaptureTarget::Window { id } => CurrentRecordingTarget::Window {
                id: *id,
                bounds: *bounds,
            },
            ScreenCaptureTarget::Area { screen, bounds } => CurrentRecordingTarget::Area {
                screen: *screen,
                bounds: *bounds,
            },
        };

        CurrentRecording {
            target,
            r#type: match r {
                InProgressRecording::Instant { .. } => RecordingType::Instant,
                InProgressRecording::Studio { .. } => RecordingType::Studio,
            },
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
    println!("Creating screenshot: input={input:?}, output={output:?}, size={size:?}");

    let result: Result<(), String> = tokio::task::spawn_blocking(move || -> Result<(), String> {
        ffmpeg::init().map_err(|e| {
            eprintln!("Failed to initialize ffmpeg: {e}");
            e.to_string()
        })?;

        let mut ictx = ffmpeg::format::input(&input).map_err(|e| {
            eprintln!("Failed to create input context: {e}");
            e.to_string()
        })?;
        let input_stream = ictx
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found")?;
        let video_stream_index = input_stream.index();
        println!("Found video stream at index {video_stream_index}");

        let mut decoder =
            ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())
                .map_err(|e| {
                    eprintln!("Failed to create decoder context: {e}");
                    e.to_string()
                })?
                .decoder()
                .video()
                .map_err(|e| {
                    eprintln!("Failed to create video decoder: {e}");
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
            eprintln!("Failed to create scaler: {e}");
            e.to_string()
        })?;

        println!("Decoder and scaler initialized");

        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in ictx.packets() {
            if stream.index() == video_stream_index {
                decoder.send_packet(&packet).map_err(|e| {
                    eprintln!("Failed to send packet to decoder: {e}");
                    e.to_string()
                })?;
                if decoder.receive_frame(&mut frame).is_ok() {
                    println!("Frame received, scaling...");
                    let mut rgb_frame = ffmpeg::frame::Video::empty();
                    scaler.run(&frame, &mut rgb_frame).map_err(|e| {
                        eprintln!("Failed to scale frame: {e}");
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
                    println!("Saving image to {output:?}");

                    img.save_with_format(&output, image::ImageFormat::Jpeg)
                        .map_err(|e| {
                            eprintln!("Failed to save image: {e}");
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
    .map_err(|e| format!("Task join error: {e}"))?;

    result
}

// async fn create_thumbnail(input: PathBuf, output: PathBuf, size: (u32, u32)) -> Result<(), String> {
//     println!("Creating thumbnail: input={input:?}, output={output:?}, size={size:?}");

//     tokio::task::spawn_blocking(move || -> Result<(), String> {
//         let img = image::open(&input).map_err(|e| {
//             eprintln!("Failed to open image: {e}");
//             e.to_string()
//         })?;

//         let width = img.width() as usize;
//         let height = img.height() as usize;
//         let bytes_per_pixel = 3;
//         let src_stride = width * bytes_per_pixel;

//         let rgb_img = img.to_rgb8();
//         let img_buffer = rgb_img.as_raw();

//         let mut corrected_buffer = vec![0u8; height * src_stride];

//         for y in 0..height {
//             let src_slice = &img_buffer[y * src_stride..(y + 1) * src_stride];
//             let dst_slice = &mut corrected_buffer[y * src_stride..(y + 1) * src_stride];
//             dst_slice.copy_from_slice(src_slice);
//         }

//         let corrected_img =
//             image::RgbImage::from_raw(width as u32, height as u32, corrected_buffer)
//                 .ok_or("Failed to create corrected image")?;

//         let thumbnail = image::imageops::resize(
//             &corrected_img,
//             size.0,
//             size.1,
//             image::imageops::FilterType::Lanczos3,
//         );

//         thumbnail
//             .save_with_format(&output, image::ImageFormat::Png)
//             .map_err(|e| {
//                 eprintln!("Failed to save thumbnail: {e}");
//                 e.to_string()
//             })?;

//         println!("Thumbnail created successfully");
//         Ok(())
//     })
//     .await
//     .map_err(|e| format!("Task join error: {e}"))?
// }

#[tauri::command]
#[specta::specta]
async fn copy_file_to_path(app: AppHandle, src: String, dst: String) -> Result<(), String> {
    println!("Attempting to copy file from {src} to {dst}");

    let is_screenshot = src.contains("screenshots/");
    let is_gif = src.ends_with(".gif") || dst.ends_with(".gif");

    let src_path = std::path::Path::new(&src);
    if !src_path.exists() {
        return Err(format!("Source file {src} does not exist"));
    }

    if !is_screenshot && !is_gif && !is_valid_mp4(src_path) {
        let mut attempts = 0;
        while attempts < 10 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if is_valid_mp4(src_path) {
                break;
            }
            attempts += 1;
        }
        if attempts == 10 {
            return Err("Source video file is not a valid MP4".to_string());
        }
    }

    if let Some(parent) = std::path::Path::new(&dst).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create target directory: {e}"))?;
    }

    let mut attempts = 0;
    const MAX_ATTEMPTS: u32 = 3;
    let mut last_error = None;

    while attempts < MAX_ATTEMPTS {
        match tokio::fs::copy(&src, &dst).await {
            Ok(bytes) => {
                let src_size = match tokio::fs::metadata(&src).await {
                    Ok(metadata) => metadata.len(),
                    Err(e) => {
                        last_error = Some(format!("Failed to get source file metadata: {e}"));
                        attempts += 1;
                        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                        continue;
                    }
                };

                if bytes != src_size {
                    last_error = Some(format!(
                        "File copy verification failed: copied {bytes} bytes but source is {src_size} bytes"
                    ));
                    let _ = tokio::fs::remove_file(&dst).await;
                    attempts += 1;
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }

                if !is_screenshot && !is_gif && !is_valid_mp4(std::path::Path::new(&dst)) {
                    last_error = Some("Destination file is not a valid MP4".to_string());
                    let _ = tokio::fs::remove_file(&dst).await;
                    attempts += 1;
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }

                println!("Successfully copied {bytes} bytes from {src} to {dst}");

                notifications::send_notification(
                    &app,
                    if is_screenshot {
                        notifications::NotificationType::ScreenshotSaved
                    } else {
                        notifications::NotificationType::VideoSaved
                    },
                );
                return Ok(());
            }
            Err(e) => {
                last_error = Some(e.to_string());
                attempts += 1;
                if attempts < MAX_ATTEMPTS {
                    tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                    continue;
                }
            }
        }
    }

    eprintln!(
        "Failed to copy file from {} to {} after {} attempts. Last error: {}",
        src,
        dst,
        MAX_ATTEMPTS,
        last_error.as_ref().unwrap()
    );

    notifications::send_notification(
        &app,
        if is_screenshot {
            notifications::NotificationType::ScreenshotSaveFailed
        } else {
            notifications::NotificationType::VideoSaveFailed
        },
    );

    Err(last_error.unwrap_or_else(|| "Maximum retry attempts exceeded".to_string()))
}

pub fn is_valid_mp4(path: &std::path::Path) -> bool {
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

#[tauri::command]
#[specta::specta]
async fn copy_screenshot_to_clipboard(
    clipboard: MutableState<'_, ClipboardContext>,
    path: String,
) -> Result<(), String> {
    println!("Copying screenshot to clipboard: {path:?}");

    let img_data = clipboard_rs::RustImageData::from_path(&path)
        .map_err(|e| format!("Failed to copy screenshot to clipboard: {e}"))?;
    clipboard
        .write()
        .await
        .set_image(img_data)
        .map_err(|err| format!("Failed to copy screenshot to clipboard: {err}"))?;
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
            .map_err(|e| format!("Failed to open folder: {e}"))?;
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
    fps: u32,
    resolution_base: XY<u32>,
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
async fn start_playback(
    editor_instance: WindowEditorInstance,
    fps: u32,
    resolution_base: XY<u32>,
) -> Result<(), String> {
    editor_instance.start_playback(fps, resolution_base).await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn stop_playback(editor_instance: WindowEditorInstance) -> Result<(), String> {
    let mut state = editor_instance.state.lock().await;

    if let Some(handle) = state.playback_task.take() {
        handle.stop();
    }

    Ok(())
}

#[derive(Serialize, Type, Debug)]
#[serde(rename_all = "camelCase")]
struct SerializedEditorInstance {
    frames_socket_url: String,
    recording_duration: f64,
    saved_project_config: ProjectConfiguration,
    recordings: Arc<ProjectRecordingsMeta>,
    path: PathBuf,
}

#[tauri::command]
#[specta::specta]
async fn create_editor_instance(window: Window) -> Result<SerializedEditorInstance, String> {
    let CapWindowId::Editor { id } = CapWindowId::from_str(window.label()).unwrap() else {
        return Err("Invalid window".to_string());
    };

    let path = {
        let window_ids = EditorWindowIds::get(window.app_handle());
        let window_ids = window_ids.ids.lock().unwrap();

        let Some((path, _)) = window_ids.iter().find(|(_, _id)| *_id == id) else {
            return Err("Editor instance not found".to_string());
        };
        path.clone()
    };

    let editor_instance = EditorInstances::get_or_create(&window, path).await?;

    let meta = editor_instance.meta();

    println!("Pretty name: {}", meta.pretty_name);

    Ok(SerializedEditorInstance {
        frames_socket_url: format!("ws://localhost:{}", editor_instance.ws_port),
        recording_duration: editor_instance.recordings.duration(),
        saved_project_config: {
            let project_config = editor_instance.project_config.1.borrow();
            project_config.clone()
        },
        recordings: editor_instance.recordings.clone(),
        path: editor_instance.project_path.clone(),
    })
}

#[tauri::command]
#[specta::specta]
async fn get_editor_meta(editor: WindowEditorInstance) -> Result<RecordingMeta, String> {
    let path = editor.project_path.clone();
    RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())
}
#[tauri::command]
#[specta::specta]
async fn set_pretty_name(editor: WindowEditorInstance, pretty_name: String) -> Result<(), String> {
    let mut meta = editor.meta().clone();
    meta.pretty_name = pretty_name;
    meta.save_for_project().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn copy_video_to_clipboard(
    app: AppHandle,
    clipboard: MutableState<'_, ClipboardContext>,
    path: String,
) -> Result<(), String> {
    println!("copying");
    let _ = clipboard.write().await.set_files(vec![path]);

    notifications::send_notification(
        &app,
        notifications::NotificationType::VideoCopiedToClipboard,
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_video_metadata(path: PathBuf) -> Result<VideoRecordingMetadata, String> {
    let recording_meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    fn get_duration_for_path(path: PathBuf) -> Result<f64, String> {
        let reader = BufReader::new(
            File::open(&path).map_err(|e| format!("Failed to open video file: {e}"))?,
        );
        let file_size = path
            .metadata()
            .map_err(|e| format!("Failed to get file metadata: {e}"))?
            .len();

        let current_duration = match Mp4Reader::read_header(reader, file_size) {
            Ok(mp4) => mp4.duration().as_secs_f64(),
            Err(e) => {
                println!("Failed to read MP4 header: {e}. Falling back to default duration.");
                0.0_f64
            }
        };

        Ok(current_duration)
    }

    let display_paths = match &recording_meta.inner {
        RecordingMetaInner::Instant(_) => {
            vec![path.join("content/output.mp4")]
        }
        RecordingMetaInner::Studio(meta) => match meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                vec![recording_meta.path(&segment.display.path)]
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner
                .segments
                .iter()
                .map(|s| recording_meta.path(&s.display.path))
                .collect(),
        },
    };

    let duration = display_paths
        .into_iter()
        .map(get_duration_for_path)
        .sum::<Result<_, _>>()?;

    let (width, height) = (1920, 1080);
    let fps = 30;

    let base_bitrate = if width <= 1280 && height <= 720 {
        4_000_000.0
    } else if width <= 1920 && height <= 1080 {
        8_000_000.0
    } else if width <= 2560 && height <= 1440 {
        14_000_000.0
    } else {
        20_000_000.0
    };

    let fps_factor = (fps as f64) / 30.0;
    let video_bitrate = base_bitrate * fps_factor;
    let audio_bitrate = 192_000.0;
    let total_bitrate = video_bitrate + audio_bitrate;
    let estimated_size_mb = (total_bitrate * duration) / (8.0 * 1024.0 * 1024.0);

    Ok(VideoRecordingMetadata {
        size: estimated_size_mb,
        duration,
    })
}

#[tauri::command]
#[specta::specta]
fn close_recordings_overlay_window(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = app.get_webview_panel(&CapWindowId::RecordingsOverlay.label()) {
            panel.released_when_closed(true);
            panel.close();
        }
    }

    if !cfg!(target_os = "macos")
        && let Some(window) = CapWindowId::RecordingsOverlay.get(&app)
    {
        let _ = window.close();
    }
}

#[tauri::command(async)]
#[specta::specta]
fn focus_captures_panel(_app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use tauri_nspanel::ManagerExt;
        if let Ok(panel) = _app.get_webview_panel(&CapWindowId::RecordingsOverlay.label()) {
            panel.make_key_window();
        }
    }
}

#[derive(Serialize, Deserialize, specta::Type, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub struct FramesRendered {
    rendered_count: u32,
    total_frames: u32,
}

#[tauri::command]
#[specta::specta]
async fn set_playhead_position(
    editor_instance: WindowEditorInstance,
    frame_number: u32,
) -> Result<(), String> {
    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn set_project_config(
    editor_instance: WindowEditorInstance,
    config: ProjectConfiguration,
) -> Result<(), String> {
    config.write(&editor_instance.project_path).unwrap();

    editor_instance.project_config.0.send(config).ok();

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn generate_zoom_segments_from_clicks(
    editor_instance: WindowEditorInstance,
) -> Result<Vec<ZoomSegment>, String> {
    let meta = editor_instance.meta();
    let recordings = &editor_instance.recordings;

    let zoom_segments = recording::generate_zoom_segments_for_project(meta, recordings);

    Ok(zoom_segments)
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

#[derive(Serialize, Type, tauri_specta::Event, Debug, Clone)]
pub struct UploadProgress {
    progress: f64,
}

#[derive(Deserialize, Type)]
pub enum UploadMode {
    Initial {
        pre_created_video: Option<VideoUploadInfo>,
    },
    Reupload,
}

#[tauri::command]
#[specta::specta]
async fn upload_exported_video(
    app: AppHandle,
    path: PathBuf,
    mode: UploadMode,
) -> Result<UploadResult, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    let screen_metadata = get_video_metadata(path.clone()).await.map_err(|e| {
        sentry::capture_message(
            &format!("Failed to get video metadata: {e}"),
            sentry::Level::Error,
        );

        "Failed to read video metadata. The recording may be from an incompatible version."
            .to_string()
    })?;

    let camera_metadata = get_video_metadata(path.clone()).await.ok();

    let duration = screen_metadata.duration.max(
        camera_metadata
            .map(|m| m.duration)
            .unwrap_or(screen_metadata.duration),
    );

    if !auth.is_upgraded() && duration > 300.0 {
        return Ok(UploadResult::UpgradeRequired);
    }

    let mut meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    let output_path = meta.output_path();
    if !output_path.exists() {
        notifications::send_notification(&app, notifications::NotificationType::UploadFailed);
        return Err("Failed to upload video: Rendered video not found".to_string());
    }

    UploadProgress { progress: 0.0 }.emit(&app).ok();

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

        create_or_get_video(
            &app,
            false,
            video_id,
            Some(meta.pretty_name.clone()),
            Some(duration.to_string()),
        )
        .await
    }
    .await?;

    let upload_id = s3_config.id().to_string();

    match upload_video(
        &app,
        upload_id.clone(),
        output_path,
        Some(s3_config),
        Some(meta.project_path.join("screenshots/display.jpg")),
        Some(duration.to_string()),
    )
    .await
    {
        Ok(uploaded_video) => {
            UploadProgress { progress: 1.0 }.emit(&app).ok();

            meta.sharing = Some(SharingMeta {
                link: uploaded_video.link.clone(),
                id: uploaded_video.id.clone(),
            });
            meta.save_for_project().ok();

            let _ = app
                .state::<ArcLock<ClipboardContext>>()
                .write()
                .await
                .set_text(uploaded_video.link.clone());

            NotificationType::ShareableLinkCopied.send(&app);
            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(e) => {
            error!("Failed to upload video: {e}");

            NotificationType::UploadFailed.send(&app);
            Err(e)
        }
    }
}

#[tauri::command]
#[specta::specta]
async fn upload_screenshot(
    app: AppHandle,
    clipboard: MutableState<'_, ClipboardContext>,
    screenshot_path: PathBuf,
) -> Result<UploadResult, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    if !auth.is_upgraded() {
        ShowCapWindow::Upgrade.show(&app).await.ok();
        return Ok(UploadResult::UpgradeRequired);
    }

    println!("Uploading screenshot: {screenshot_path:?}");

    let screenshot_dir = screenshot_path.parent().unwrap().to_path_buf();
    let mut meta = RecordingMeta::load_for_project(&screenshot_dir).unwrap();

    let share_link = if let Some(sharing) = meta.sharing.as_ref() {
        println!("Screenshot already uploaded, using existing link");
        sharing.link.clone()
    } else {
        let uploaded = upload_image(&app, screenshot_path.clone())
            .await
            .map_err(|e| e.to_string())?;

        meta.sharing = Some(SharingMeta {
            link: uploaded.link.clone(),
            id: uploaded.id.clone(),
        });
        meta.save_for_project()
            .map_err(|err| format!("Error saving project: {err}"))?;

        uploaded.link
    };

    println!("Copying to clipboard: {share_link:?}");

    let _ = clipboard.write().await.set_text(share_link.clone());

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

    let (width, height, bgra_data) = {
        let options = scap::capturer::Options {
            fps: 1,
            output_type: scap::frame::FrameType::BGRAFrame,
            show_highlight: false,
            ..Default::default()
        };

        if let Some(window) = CapWindowId::Main.get(&app) {
            let _ = window.hide();
        }

        let mut capturer =
            Capturer::build(options).map_err(|e| format!("Failed to construct error: {e}"))?;
        capturer.start_capture();
        let frame = capturer
            .get_next_frame()
            .map_err(|e| format!("Failed to get frame: {e}"))?;
        capturer.stop_capture();

        if let Some(window) = CapWindowId::Main.get(&app) {
            let _ = window.show();
        }

        match frame {
            Frame::Video(VideoFrame::BGRA(bgra_frame)) => Ok((
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
        let mut rgba_data = vec![0; bgra_data.len()];
        for (bgra, rgba) in bgra_data.chunks_exact(4).zip(rgba_data.chunks_exact_mut(4)) {
            rgba[0] = bgra[2];
            rgba[1] = bgra[1];
            rgba[2] = bgra[0];
            rgba[3] = bgra[3];
        }

        let file = File::create(&screenshot_path).map_err(|e| e.to_string())?;
        let w = &mut BufWriter::new(file);

        let mut encoder = Encoder::new(w, width, height);
        encoder.set_color(ColorType::Rgba);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;

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
            platform: Some(Platform::default()),
            project_path: recording_dir.clone(),
            sharing: None,
            pretty_name: screenshot_name,
            inner: RecordingMetaInner::Studio(cap_project::StudioRecordingMeta::SingleSegment {
                segment: cap_project::SingleSegment {
                    display: VideoMeta {
                        path: RelativePathBuf::from_path(
                            screenshot_path.strip_prefix(&recording_dir).unwrap(),
                        )
                        .unwrap(),
                        fps: 0,
                        start_time: None,
                    },
                    camera: None,
                    audio: None,
                    cursor: None,
                },
            }),
        }
        .save_for_project()
        .unwrap();

        NewScreenshotAdded {
            path: screenshot_path,
        }
        .emit(&app_handle)
        .ok();

        Ok(())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))??;

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

    println!("save_file_dialog called with file_name: {file_name}, file_type: {file_type}");

    let file_name = file_name
        .strip_suffix(".cap")
        .unwrap_or(&file_name)
        .to_string();
    println!("File name after removing .cap suffix: {file_name}");

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
            println!("Invalid file type: {file_type}");
            return Err("Invalid file type".to_string());
        }
    };

    println!("Showing save dialog with name: {name}, extension: {extension}");

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
            println!("Save dialog result: {result:?}");
            Ok(result)
        }
        Err(e) => {
            println!("Error receiving result: {e}");
            notifications::send_notification(
                &app,
                notifications::NotificationType::VideoSaveFailed,
            );
            Err(e.to_string())
        }
    }
}

#[derive(Serialize, specta::Type)]
pub struct RecordingMetaWithType {
    #[serde(flatten)]
    pub inner: RecordingMeta,
    pub r#type: RecordingType,
}

impl RecordingMetaWithType {
    fn new(inner: RecordingMeta) -> Self {
        Self {
            r#type: match &inner.inner {
                RecordingMetaInner::Studio(_) => RecordingType::Studio,
                RecordingMetaInner::Instant(_) => RecordingType::Instant,
            },
            inner,
        }
    }
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum RecordingType {
    Studio,
    Instant,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Recording,
    Screenshot,
}

#[tauri::command(async)]
#[specta::specta]
fn get_recording_meta(
    path: PathBuf,
    _file_type: FileType,
) -> Result<RecordingMetaWithType, String> {
    RecordingMeta::load_for_project(&path)
        .map(RecordingMetaWithType::new)
        .map_err(|e| format!("Failed to load recording meta: {e}"))
}

#[tauri::command]
#[specta::specta]
fn list_recordings(app: AppHandle) -> Result<Vec<(PathBuf, RecordingMetaWithType)>, String> {
    let recordings_dir = recordings_path(&app);

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let mut result = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {e}"))?
        .filter_map(|entry| {
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return None,
            };

            let path = entry.path();

            if !path.is_dir() {
                return None;
            }

            get_recording_meta(path.clone(), FileType::Recording)
                .ok()
                .map(|meta| (path, meta))
        })
        .collect::<Vec<_>>();

    result.sort_by(|a, b| {
        let b_time =
            b.0.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        let a_time =
            a.0.metadata()
                .and_then(|m| m.created())
                .unwrap_or(std::time::SystemTime::UNIX_EPOCH);

        b_time.cmp(&a_time)
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
fn list_screenshots(app: AppHandle) -> Result<Vec<(PathBuf, RecordingMeta)>, String> {
    let screenshots_dir = screenshots_path(&app);

    let mut result = std::fs::read_dir(&screenshots_dir)
        .map_err(|e| format!("Failed to read screenshots directory: {e}"))?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
                let meta = match get_recording_meta(path.clone(), FileType::Screenshot) {
                    Ok(meta) => meta.inner,
                    Err(_) => return None,
                };

                let png_path = std::fs::read_dir(&path)
                    .ok()?
                    .filter_map(|e| e.ok())
                    .find(|e| e.path().extension().and_then(|s| s.to_str()) == Some("png"))
                    .map(|e| e.path())?;

                Some((png_path, meta))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    result.sort_by(|a, b| {
        b.0.metadata()
            .and_then(|m| m.created())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .cmp(
                &a.0.metadata()
                    .and_then(|m| m.created())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            )
    });

    Ok(result)
}

#[tauri::command]
#[specta::specta]
async fn check_upgraded_and_update(app: AppHandle) -> Result<bool, String> {
    println!("Checking upgraded status and updating...");

    if let Ok(Some(settings)) = GeneralSettingsStore::get(&app)
        && settings.commercial_license.is_some()
    {
        return Ok(true);
    }

    let Ok(Some(auth)) = AuthStore::get(&app) else {
        println!("No auth found, clearing auth store");
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(false);
    };

    if let Some(ref plan) = auth.plan
        && plan.manual
    {
        return Ok(true);
    }

    println!(
        "Fetching plan for user {}",
        auth.user_id.as_deref().unwrap_or("unknown")
    );
    let response = app
        .authed_api_request("/api/desktop/plan", |client, url| client.get(url))
        .await
        .map_err(|e| {
            println!("Failed to fetch plan: {e}");
            format!("Failed to fetch plan: {e}")
        })?;

    println!("Plan fetch response status: {}", response.status());
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        println!("Unauthorized response, clearing auth store");
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(false);
    }

    let plan_data = response.json::<serde_json::Value>().await.map_err(|e| {
        println!("Failed to parse plan response: {e}");
        format!("Failed to parse plan response: {e}")
    })?;

    let is_pro = plan_data
        .get("upgraded")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    println!("Pro status: {is_pro}");
    let updated_auth = AuthStore {
        secret: auth.secret,
        user_id: auth.user_id,
        intercom_hash: auth.intercom_hash,
        plan: Some(Plan {
            upgraded: is_pro,
            manual: auth.plan.map(|p| p.manual).unwrap_or(false),
            last_checked: chrono::Utc::now().timestamp() as i32,
        }),
    };
    println!("Updating auth store with new pro status");
    AuthStore::set(&app, Some(updated_auth)).map_err(|e| e.to_string())?;

    Ok(is_pro)
}

#[tauri::command]
#[specta::specta]
fn open_external_link(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Ok(Some(settings)) = GeneralSettingsStore::get(&app)
        && settings.disable_auto_open_links
    {
        return Ok(());
    }

    app.shell()
        .open(&url, None)
        .map_err(|e| format!("Failed to open URL: {e}"))?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn reset_camera_permissions(_app: AppHandle) -> Result<(), String> {
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
            .map_err(|_| "Failed to reset camera permissions".to_string())?;
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
async fn seek_to(editor_instance: WindowEditorInstance, frame_number: u32) -> Result<(), String> {
    editor_instance
        .modify_and_emit_state(|state| {
            state.playhead_position = frame_number;
        })
        .await;

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn get_mic_waveforms(editor_instance: WindowEditorInstance) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segments.iter() {
        if let Some(audio) = &segment.audio {
            out.push(audio::get_waveform(audio));
        } else {
            out.push(Vec::new());
        }
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
async fn get_system_audio_waveforms(
    editor_instance: WindowEditorInstance,
) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segments.iter() {
        if let Some(audio) = &segment.system_audio {
            out.push(audio::get_waveform(audio));
        } else {
            out.push(Vec::new());
        }
    }

    Ok(out)
}

// keep this async otherwise opening windows may hang on windows
#[tauri::command]
#[specta::specta]
async fn show_window(app: AppHandle, window: ShowCapWindow) -> Result<(), String> {
    let _ = window.show(&app).await;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
fn list_fails() -> Result<BTreeMap<String, bool>, ()> {
    Ok(cap_fail::get_state())
}

#[tauri::command(async)]
#[specta::specta]
fn set_fail(name: String, value: bool) {
    cap_fail::set_fail(&name, value)
}

async fn check_notification_permissions(app: AppHandle) {
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
            eprintln!("Error checking notification permission state: {e}");
        }
    }
}

// fn configure_logging(folder: &PathBuf) -> tracing_appender::non_blocking::WorkerGuard {
//     let file_appender = tracing_appender::rolling::daily(folder, "cap-logs.log");
//     let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

//     let filter = || tracing_subscriber::filter::EnvFilter::builder().parse_lossy("cap-*=TRACE");

//     tracing_subscriber::registry()
//         .with(
//             tracing_subscriber::fmt::layer()
//                 .with_ansi(false)
//                 .with_target(false)
//                 .with_writer(non_blocking)
//                 .with_filter(filter()),
//         )
//         .with(
//             tracing_subscriber::fmt::layer()
//                 .with_ansi(true)
//                 .with_target(false)
//                 .with_filter(filter()),
//         )
//         .init();

//     _guard
// }

#[tauri::command]
#[specta::specta]
async fn set_server_url(app: MutableState<'_, App>, server_url: String) -> Result<(), ()> {
    app.write().await.server_url = server_url;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn set_camera_preview_state(
    store: State<'_, CameraPreview>,
    state: CameraWindowState,
) -> Result<(), ()> {
    store.save(&state).map_err(|err| {
        error!("Error saving camera window state: {err}");
    })?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn await_camera_preview_ready(store: State<'_, CameraPreview>) -> Result<bool, ()> {
    store.wait_for_camera_to_load().await;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
async fn update_auth_plan(app: AppHandle) {
    AuthStore::update_auth_plan(&app).await.ok();
}

pub type FilteredRegistry = tracing_subscriber::layer::Layered<
    tracing_subscriber::filter::FilterFn<fn(m: &tracing::Metadata) -> bool>,
    tracing_subscriber::Registry,
>;

pub type DynLoggingLayer = Box<dyn tracing_subscriber::Layer<FilteredRegistry> + Send + Sync>;
type LoggingHandle = tracing_subscriber::reload::Handle<Option<DynLoggingLayer>, FilteredRegistry>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run(recording_logging_handle: LoggingHandle) {
    let tauri_context = tauri::generate_context!();

    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            set_mic_input,
            set_camera_input,
            recording::start_recording,
            recording::stop_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::restart_recording,
            recording::delete_recording,
            recording::list_cameras,
            recording::list_capture_windows,
            recording::list_capture_screens,
            take_screenshot,
            list_audio_devices,
            close_recordings_overlay_window,
            fake_window::set_fake_window_bounds,
            fake_window::remove_fake_window,
            focus_captures_panel,
            get_current_recording,
            export::export_video,
            export::get_export_estimates,
            copy_file_to_path,
            copy_video_to_clipboard,
            copy_screenshot_to_clipboard,
            open_file_path,
            get_video_metadata,
            create_editor_instance,
            get_mic_waveforms,
            get_system_audio_waveforms,
            start_playback,
            stop_playback,
            set_playhead_position,
            set_project_config,
            generate_zoom_segments_from_clicks,
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
            reset_camera_permissions,
            reset_microphone_permissions,
            is_camera_window_open,
            seek_to,
            windows::position_traffic_lights,
            windows::set_theme,
            global_message_dialog,
            show_window,
            write_clipboard_string,
            platform::perform_haptic_feedback,
            list_fails,
            set_fail,
            update_auth_plan,
            set_window_transparent,
            get_editor_meta,
            set_pretty_name,
            set_server_url,
            set_camera_preview_state,
            await_camera_preview_ready,
            captions::create_dir,
            captions::save_model_file,
            captions::transcribe_audio,
            captions::save_captions,
            captions::load_captions,
            captions::download_whisper_model,
            captions::check_model_exists,
            captions::delete_whisper_model,
            captions::export_captions_srt,
            target_select_overlay::open_target_select_overlays,
            target_select_overlay::close_target_select_overlays,
        ])
        .events(tauri_specta::collect_events![
            RecordingOptionsChanged,
            NewStudioRecordingAdded,
            NewScreenshotAdded,
            RenderFrameEvent,
            EditorStateChanged,
            CurrentRecordingChanged,
            RecordingStarted,
            RecordingStopped,
            RequestStartRecording,
            RequestNewScreenshot,
            RequestOpenSettings,
            NewNotification,
            AuthenticationInvalid,
            audio_meter::AudioInputLevelChange,
            UploadProgress,
            captions::DownloadProgress,
            recording::RecordingEvent,
            RecordingDeleted,
            target_select_overlay::TargetUnderCursor,
            hotkeys::OnEscapePress
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .typ::<ProjectConfiguration>()
        .typ::<AuthStore>()
        .typ::<presets::PresetsStore>()
        .typ::<hotkeys::HotkeysStore>()
        .typ::<general_settings::GeneralSettingsStore>()
        .typ::<cap_flags::Flags>();

    // #[cfg(debug_assertions)]
    // specta_builder
    //     .export(
    //         specta_typescript::Typescript::default(),
    //         "../src/utils/tauri.ts",
    //     )
    //     .expect("Failed to export typescript bindings");

    let (camera_tx, camera_ws_port, _shutdown) = camera_legacy::create_camera_preview_ws().await;

    let (audio_input_tx, audio_input_rx) = AudioInputFeed::create_channel();

    tauri::async_runtime::set(tokio::runtime::Handle::current());

    #[allow(unused_mut)]
    let mut builder =
        tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            trace!("Single instance invoked with args {args:?}");

            // This is also handled as a deeplink on some platforms (eg macOS), see deeplink_actions
            let Some(cap_file) = args
                .iter()
                .find(|arg| arg.ends_with(".cap"))
                .map(PathBuf::from)
            else {
                let app = app.clone();
                tokio::spawn(async move { ShowCapWindow::Main.show(&app).await });
                return;
            };

            let _ = open_project_from_path(&cap_file, app.clone());
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
        .plugin(flags::plugin::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
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
                    "window-capture-occluder",
                    "target-select-overlay",
                    CapWindowId::CaptureArea.label().as_str(),
                    CapWindowId::Camera.label().as_str(),
                    CapWindowId::RecordingsOverlay.label().as_str(),
                    CapWindowId::InProgressRecording.label().as_str(),
                    CapWindowId::Upgrade.label().as_str(),
                ])
                .map_label(|label| match label {
                    label if label.starts_with("editor-") => "editor",
                    label if label.starts_with("window-capture-occluder-") => {
                        "window-capture-occluder"
                    }
                    label if label.starts_with("target-select-overlay") => "target-select-overlay",
                    _ => label,
                })
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .setup(move |app| {
            let app = app.handle().clone();
            specta_builder.mount_events(&app);
            hotkeys::init(&app);
            general_settings::init(&app);
            fake_window::init(&app);
            app.manage(target_select_overlay::WindowFocusManager::default());
            app.manage(EditorWindowIds::default());

            if let Ok(Some(auth)) = AuthStore::load(&app) {
                sentry::configure_scope(|scope| {
                    scope.set_user(auth.user_id.map(|id| sentry::User {
                        id: Some(id),
                        ..Default::default()
                    }));
                });
            }

            {
                app.manage(Arc::new(RwLock::new(App {
                    camera_tx,
                    camera_ws_port,
                    handle: app.clone(),
                    camera_feed: None,
                    camera_feed_initialization: None,
                    mic_samples_tx: audio_input_tx,
                    mic_feed: None,
                    recording_state: RecordingState::None,
                    recording_logging_handle,
                    server_url: GeneralSettingsStore::get(&app)
                        .ok()
                        .flatten()
                        .map(|v| v.server_url.clone())
                        .unwrap_or_else(|| {
                            std::option_env!("VITE_SERVER_URL")
                                .unwrap_or("https://cap.so")
                                .to_string()
                        }),
                })));

                if let Ok(s) = CameraPreview::init(&app)
                    .map_err(|err| error!("Error initializing camera preview: {err}"))
                {
                    app.manage(s);
                }

                app.manage(Arc::new(RwLock::new(
                    ClipboardContext::new().expect("Failed to create clipboard context"),
                )));
            }

            tokio::spawn(check_notification_permissions(app.clone()));

            println!("Checking startup completion and permissions...");
            let permissions = permissions::do_permissions_check(false);
            println!("Permissions check result: {permissions:?}");

            tokio::spawn({
                let app = app.clone();
                async move {
                    if !permissions.screen_recording.permitted()
                        || !permissions.accessibility.permitted()
                        || GeneralSettingsStore::get(&app)
                            .ok()
                            .flatten()
                            .map(|s| !s.has_completed_startup)
                            .unwrap_or(false)
                    {
                        let _ = ShowCapWindow::Setup.show(&app).await;
                    } else {
                        println!("Permissions granted, showing main window");

                        let _ = ShowCapWindow::Main.show(&app).await;
                    }
                }
            });

            audio_meter::spawn_event_emitter(app.clone(), audio_input_rx);

            tray::create_tray(&app).unwrap();

            RequestNewScreenshot::listen_any_spawn(&app, |_, app| async move {
                if let Err(e) = take_screenshot(app.clone(), app.state()).await {
                    eprintln!("Failed to take screenshot: {e}");
                }
            });

            RequestOpenSettings::listen_any_spawn(&app, |payload, app| async move {
                let _ = ShowCapWindow::Settings {
                    page: Some(payload.page),
                }
                .show(&app)
                .await;
            });

            let app_handle = app.clone();
            app.deep_link().on_open_url(move |event| {
                deeplink_actions::handle(&app_handle, event.urls());
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            let app = window.app_handle();

            match event {
                WindowEvent::Destroyed => {
                    if let Ok(window_id) = CapWindowId::from_str(label) {
                        match window_id {
                            CapWindowId::Main => {
                                let app = app.clone();
                                tokio::spawn(async move {
                                    let state = app.state::<Arc<RwLock<App>>>();
                                    let app_state = &mut *state.write().await;

                                    if !app_state.is_recording_active_or_pending() {
                                        app_state.mic_feed.take();
                                        app_state.camera_feed.take();

                                        if let Some(camera) = CapWindowId::Camera.get(&app) {
                                            let _ = camera.close();
                                        }
                                    }
                                });
                            }
                            CapWindowId::Editor { id } => {
                                let window_ids = EditorWindowIds::get(window.app_handle());
                                window_ids.ids.lock().unwrap().retain(|(_, _id)| *_id != id);

                                tokio::spawn(EditorInstances::remove(window.clone()));
                            }
                            CapWindowId::Settings
                            | CapWindowId::Upgrade
                            | CapWindowId::ModeSelect => {
                                if let Some(window) = CapWindowId::Main.get(app) {
                                    let _ = window.show();
                                }
                                return;
                            }
                            CapWindowId::TargetSelectOverlay { display_id } => {
                                app.state::<target_select_overlay::WindowFocusManager>()
                                    .destroy(&display_id, app.global_shortcut());
                            }
                            _ => {}
                        };
                    }

                    if let Some(settings) = GeneralSettingsStore::get(app).unwrap_or(None)
                        && settings.hide_dock_icon
                        && app
                            .webview_windows()
                            .keys()
                            .all(|label| !CapWindowId::from_str(label).unwrap().activates_dock())
                    {
                        #[cfg(target_os = "macos")]
                        app.set_activation_policy(tauri::ActivationPolicy::Accessory)
                            .ok();
                    }
                }
                #[cfg(target_os = "macos")]
                WindowEvent::Focused(focused) if *focused => {
                    if let Ok(window_id) = CapWindowId::from_str(label)
                        && window_id.activates_dock()
                    {
                        app.set_activation_policy(tauri::ActivationPolicy::Regular)
                            .ok();
                    }
                }
                WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    for path in paths {
                        let _ = open_project_from_path(path, app.clone());
                    }
                }
                _ => {}
            }
        })
        .build(tauri_context)
        .expect("error while running tauri application")
        .run(move |handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let has_window = handle.webview_windows().iter().any(|(label, _)| {
                    label.starts_with("editor-")
                        || label.as_str() == "settings"
                        || label.as_str() == "signin"
                });

                if has_window {
                    if let Some(window) = handle
                        .webview_windows()
                        .iter()
                        .find(|(label, _)| {
                            label.starts_with("editor-")
                                || label.as_str() == "settings"
                                || label.as_str() == "signin"
                        })
                        .map(|(_, window)| window.clone())
                    {
                        window.set_focus().ok();
                    }
                } else {
                    let handle = handle.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Main.show(&handle).await;
                    });
                }
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            tauri::RunEvent::WindowEvent {
                event: WindowEvent::Resized(size),
                label,
                ..
            } => {
                if let Some(window) = handle.get_webview_window(&label) {
                    let size = size.to_logical(window.scale_factor().unwrap_or(1.0));
                    handle
                        .state::<CameraPreview>()
                        .update_window_size(size.width, size.height);
                }
            }
            _ => {}
        });
}

async fn create_editor_instance_impl(
    app: &AppHandle,
    path: PathBuf,
) -> Result<Arc<EditorInstance>, String> {
    let app = app.clone();

    let instance = EditorInstance::new(path, {
        let app = app.clone();
        move |state| {
            EditorStateChanged::new(state).emit(&app).ok();
        }
    })
    .await?;

    RenderFrameEvent::listen_any(&app, {
        let preview_tx = instance.preview_tx.clone();
        move |e| {
            preview_tx
                .send(Some((
                    e.payload.frame_number,
                    e.payload.fps,
                    e.payload.resolution_base,
                )))
                .ok();
        }
    });

    Ok(instance)
}

fn recordings_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("recordings");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

// fn recording_path(app: &AppHandle, recording_id: &str) -> PathBuf {
//     recordings_path(app).join(format!("{recording_id}.cap"))
// }

fn screenshots_path(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().unwrap().join("screenshots");
    std::fs::create_dir_all(&path).unwrap_or_default();
    path
}

// fn screenshot_path(app: &AppHandle, screenshot_id: &str) -> PathBuf {
//     screenshots_path(app).join(format!("{screenshot_id}.cap"))
// }

#[tauri::command]
#[specta::specta]
fn global_message_dialog(app: AppHandle, message: String) {
    app.dialog().message(message).show(|_| {});
}

#[tauri::command]
#[specta::specta]
async fn write_clipboard_string(
    clipboard: MutableState<'_, ClipboardContext>,
    text: String,
) -> Result<(), String> {
    let writer = clipboard
        .try_write()
        .map_err(|e| format!("Failed to acquire lock on clipboard state: {e}"))?;
    writer
        .set_text(text)
        .map_err(|e| format!("Failed to write text to clipboard: {e}"))
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

trait TransposeAsync {
    type Output;

    fn transpose_async(self) -> impl Future<Output = Self::Output>
    where
        Self: Sized;
}

impl<F: Future<Output = T>, T, E> TransposeAsync for Result<F, E> {
    type Output = Result<T, E>;

    async fn transpose_async(self) -> Self::Output
    where
        Self: Sized,
    {
        match self {
            Ok(f) => Ok(f.await),
            Err(e) => Err(e),
        }
    }
}

fn open_project_from_path(path: &Path, app: AppHandle) -> Result<(), String> {
    let meta = RecordingMeta::load_for_project(path).map_err(|v| v.to_string())?;

    match &meta.inner {
        RecordingMetaInner::Studio(_) => {
            let project_path = path.to_path_buf();

            tokio::spawn(async move { ShowCapWindow::Editor { project_path }.show(&app).await });
        }
        RecordingMetaInner::Instant(_) => {
            let mp4_path = path.join("content/output.mp4");

            if mp4_path.exists() && mp4_path.is_file() {
                let _ = app
                    .opener()
                    .open_path(mp4_path.to_str().unwrap_or_default(), None::<String>);
                if let Some(main_window) = CapWindowId::Main.get(&app) {
                    main_window.close().ok();
                }
            }
        }
    }

    Ok(())
}
