mod api;
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
mod frame_ws;
mod general_settings;
mod hotkeys;
mod http_client;
mod logging;
mod notifications;
mod permissions;
mod platform;
mod posthog;
mod presets;
mod recording;
mod recording_settings;
mod target_select_overlay;
mod thumbnails;
mod tray;
mod upload;
mod web_api;
mod window_exclusion;
mod windows;

use audio::AppSounds;
use auth::{AuthStore, Plan};
use camera::CameraPreviewState;
use cap_editor::{EditorInstance, EditorState};
use cap_project::{
    InstantRecordingMeta, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SharingMeta,
    StudioRecordingMeta, StudioRecordingStatus, UploadMeta, VideoUploadInfo, XY, ZoomSegment,
};
use cap_recording::{
    RecordingMode,
    feeds::{
        self,
        camera::{CameraFeed, DeviceOrModelID},
        microphone::{self, MicrophoneFeed},
    },
    sources::screen_capture::ScreenCaptureTarget,
};
use cap_rendering::{ProjectRecordingsMeta, RenderedFrame};
use clipboard_rs::common::RustImage;
use clipboard_rs::{Clipboard, ClipboardContext};
use cpal::StreamError;
use editor_window::{EditorInstances, WindowEditorInstance};
use ffmpeg::ffi::AV_TIME_BASE;
use general_settings::GeneralSettingsStore;
use kameo::{Actor, actor::ActorRef};
use notifications::NotificationType;
use recording::InProgressRecording;
use scap_targets::{Display, DisplayId, WindowId, bounds::LogicalBounds};
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{
    collections::BTreeMap,
    future::Future,
    marker::PhantomData,
    path::{Path, PathBuf},
    process::Command,
    str::FromStr,
    sync::Arc,
};
use tauri::{AppHandle, Manager, State, Window, WindowEvent, ipc::Channel};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::ShellExt;
use tauri_specta::Event;
use tokio::sync::{RwLock, oneshot};
use tracing::*;
use upload::{create_or_get_video, upload_image, upload_video};
use web_api::AuthedApiError;
use web_api::ManagerExt as WebManagerExt;
use windows::{CapWindowId, EditorWindowIds, ShowCapWindow, set_window_transparent};

use crate::{
    camera::CameraPreviewManager,
    recording_settings::{RecordingSettingsStore, RecordingTargetMode},
    upload::InstantMultipartUpload,
};
use crate::{recording::start_recording, upload::build_video_meta};

#[allow(clippy::large_enum_variant)]
pub enum RecordingState {
    None,
    Pending {
        mode: RecordingMode,
        target: ScreenCaptureTarget,
    },
    Active(InProgressRecording),
}

pub struct App {
    #[deprecated = "can be removed when native camera preview is ready"]
    camera_ws_port: u16,
    camera_preview: CameraPreviewManager,
    handle: AppHandle,
    recording_state: RecordingState,
    recording_logging_handle: LoggingHandle,
    mic_feed: ActorRef<feeds::microphone::MicrophoneFeed>,
    mic_meter_sender: flume::Sender<microphone::MicrophoneSamples>,
    selected_mic_label: Option<String>,
    camera_feed: ActorRef<feeds::camera::CameraFeed>,
    server_url: String,
    logs_dir: PathBuf,
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

impl App {
    pub fn set_pending_recording(&mut self, mode: RecordingMode, target: ScreenCaptureTarget) {
        self.recording_state = RecordingState::Pending { mode, target };
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

    async fn restart_mic_feed(&mut self) -> Result<(), String> {
        info!("Restarting microphone feed after actor shutdown");

        let (error_tx, error_rx) = flume::bounded(1);
        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));

        spawn_mic_error_logger(error_rx);

        mic_feed
            .ask(microphone::AddSender(self.mic_meter_sender.clone()))
            .await
            .map_err(|e| e.to_string())?;

        if let Some(label) = self.selected_mic_label.clone() {
            let ready = mic_feed
                .ask(microphone::SetInput { label })
                .await
                .map_err(|e| e.to_string())?;
            ready.await.map_err(|e| e.to_string())?;
        }

        self.mic_feed = mic_feed;

        Ok(())
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
#[instrument(skip(state))]
async fn set_mic_input(state: MutableState<'_, App>, label: Option<String>) -> Result<(), String> {
    let mic_feed = state.read().await.mic_feed.clone();
    let desired_label = label.clone();

    match desired_label.as_ref() {
        None => {
            mic_feed
                .ask(microphone::RemoveInput)
                .await
                .map_err(|e| e.to_string())?;
        }
        Some(label) => {
            mic_feed
                .ask(feeds::microphone::SetInput {
                    label: label.clone(),
                })
                .await
                .map_err(|e| e.to_string())?
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    {
        let mut app = state.write().await;
        app.selected_mic_label = desired_label;
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn upload_logs(app_handle: AppHandle) -> Result<(), String> {
    logging::upload_log_file(&app_handle).await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app_handle, state))]
async fn set_camera_input(
    app_handle: AppHandle,
    state: MutableState<'_, App>,
    id: Option<DeviceOrModelID>,
) -> Result<(), String> {
    let camera_feed = state.read().await.camera_feed.clone();

    match id {
        None => {
            camera_feed
                .ask(feeds::camera::RemoveInput)
                .await
                .map_err(|e| e.to_string())?;
        }
        Some(id) => {
            ShowCapWindow::Camera
                .show(&app_handle)
                .await
                .map_err(|err| error!("Failed to show camera preview window: {err}"))
                .ok();

            camera_feed
                .ask(feeds::camera::SetInput { id })
                .await
                .map_err(|e| e.to_string())?
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn spawn_mic_error_logger(error_rx: flume::Receiver<StreamError>) {
    tokio::spawn(async move {
        let Ok(err) = error_rx.recv_async().await else {
            return;
        };

        error!("Mic feed actor error: {err}");
    });
}

#[derive(specta::Type, Serialize, tauri_specta::Event, Clone)]
pub struct RecordingOptionsChanged;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewStudioRecordingAdded {
    path: PathBuf,
}

#[derive(specta::Type, tauri_specta::Event, Debug, Clone, Serialize)]
pub struct RecordingDeleted {
    #[allow(unused)]
    path: PathBuf,
}

#[derive(specta::Type, tauri_specta::Event, Serialize)]
pub struct SetCaptureAreaPending(bool);

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct NewScreenshotAdded {
    path: PathBuf,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStarted;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RecordingStopped;

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestStartRecording {
    pub mode: RecordingMode,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestOpenRecordingPicker {
    pub target_mode: Option<RecordingTargetMode>,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestOpenSettings {
    page: String,
}

#[derive(Deserialize, specta::Type, Serialize, tauri_specta::Event, Debug, Clone)]
pub struct RequestScreenCapturePrewarm {
    #[serde(default)]
    pub force: bool,
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
    Window {
        id: WindowId,
        bounds: LogicalBounds,
    },
    Screen {
        id: DisplayId,
    },
    Area {
        screen: DisplayId,
        bounds: LogicalBounds,
    },
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
struct CurrentRecording {
    target: CurrentRecordingTarget,
    mode: RecordingMode,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(state))]
async fn get_current_recording(
    state: MutableState<'_, App>,
) -> Result<JsonValue<Option<CurrentRecording>>, ()> {
    let state = state.read().await;

    let (mode, capture_target) = match &state.recording_state {
        RecordingState::None => return Ok(JsonValue::new(&None)),
        RecordingState::Pending { mode, target } => (*mode, target),
        RecordingState::Active(inner) => (inner.mode(), inner.capture_target()),
    };

    let target = match capture_target {
        ScreenCaptureTarget::Display { id } => CurrentRecordingTarget::Screen { id: id.clone() },
        ScreenCaptureTarget::Window { id } => CurrentRecordingTarget::Window {
            id: id.clone(),
            bounds: scap_targets::Window::from_id(id)
                .ok_or(())?
                .display_relative_logical_bounds()
                .ok_or(())?,
        },
        ScreenCaptureTarget::Area { screen, bounds } => CurrentRecordingTarget::Area {
            screen: screen.clone(),
            bounds: *bounds,
        },
    };

    Ok(JsonValue::new(&Some(CurrentRecording { target, mode })))
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
#[instrument(skip(app))]
async fn copy_file_to_path(app: AppHandle, src: String, dst: String) -> Result<(), String> {
    println!("Attempting to copy file from {src} to {dst}");

    let is_screenshot = src.contains("screenshots/");
    let is_gif = src.ends_with(".gif") || dst.ends_with(".gif");

    let src_path = std::path::Path::new(&src);
    if !src_path.exists() {
        return Err(format!("Source file {src} does not exist"));
    }

    if !is_screenshot && !is_gif && !is_valid_video(src_path) {
        let mut attempts = 0;
        while attempts < 10 {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if is_valid_video(src_path) {
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

                if !is_screenshot && !is_gif && !is_valid_video(std::path::Path::new(&dst)) {
                    last_error = Some("Destination file is not a valid".to_string());
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

pub fn is_valid_video(path: &std::path::Path) -> bool {
    match ffmpeg::format::input(path) {
        Ok(input_context) => {
            // Check if we have at least one video stream
            input_context
                .streams()
                .any(|stream| stream.parameters().medium() == ffmpeg::media::Type::Video)
        }
        Err(_) => false,
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard))]
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
#[instrument(skip(_app))]
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
#[instrument(skip(editor_instance))]
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
#[instrument(skip(editor_instance))]
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
#[instrument(skip(window))]
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
#[instrument(skip(editor))]
async fn get_editor_meta(editor: WindowEditorInstance) -> Result<RecordingMeta, String> {
    let path = editor.project_path.clone();
    RecordingMeta::load_for_project(&path).map_err(|e| e.to_string())
}
#[tauri::command]
#[specta::specta]
#[instrument(skip(editor))]
async fn set_pretty_name(editor: WindowEditorInstance, pretty_name: String) -> Result<(), String> {
    let mut meta = editor.meta().clone();
    meta.pretty_name = pretty_name;
    meta.save_for_project().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, clipboard))]
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
#[instrument]
async fn get_video_metadata(path: PathBuf) -> Result<VideoRecordingMetadata, String> {
    let recording_meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    fn get_duration_for_path(path: PathBuf) -> Result<f64, String> {
        let input =
            ffmpeg::format::input(&path).map_err(|e| format!("Failed to open video file: {e}"))?;

        let raw_duration = input.duration();
        if raw_duration <= 0 {
            return Err(format!(
                "Unknown or invalid duration for video file: {path:?}"
            ));
        }

        let duration = raw_duration as f64 / AV_TIME_BASE as f64;
        Ok(duration)
    }

    let display_paths = match &recording_meta.inner {
        RecordingMetaInner::Instant(_) => {
            vec![path.join("content/output.mp4")]
        }
        RecordingMetaInner::Studio(meta) => {
            let status = meta.status();
            if let StudioRecordingStatus::Failed { .. } = status {
                return Err("Unable to get metadata on failed recording".to_string());
            } else if let StudioRecordingStatus::InProgress = status {
                return Err("Unable to get metadata on in-progress recording".to_string());
            }

            match meta {
                StudioRecordingMeta::SingleSegment { segment } => {
                    vec![recording_meta.path(&segment.display.path)]
                }
                StudioRecordingMeta::MultipleSegments { inner } => inner
                    .segments
                    .iter()
                    .map(|s| recording_meta.path(&s.display.path))
                    .collect(),
            }
        }
    };

    let duration = display_paths
        .into_iter()
        .map(get_duration_for_path)
        .try_fold(0f64, |acc, item| -> Result<f64, String> {
            let d = item?;
            Ok(acc + d)
        })?;

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
#[instrument(skip(app))]
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
#[instrument(skip(_app))]
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
#[instrument(skip(editor_instance))]
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
#[instrument(skip(editor_instance))]
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
#[instrument(skip(editor_instance))]
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
#[instrument]
async fn list_audio_devices() -> Result<Vec<String>, ()> {
    if !permissions::do_permissions_check(false)
        .microphone
        .permitted()
    {
        return Ok(vec![]);
    }

    Ok(MicrophoneFeed::list().keys().cloned().collect())
}

#[derive(Serialize, Type, Debug, Clone)]
pub struct UploadProgress {
    progress: f64,
}

#[derive(Debug, Deserialize, Type)]
pub enum UploadMode {
    Initial {
        pre_created_video: Option<VideoUploadInfo>,
    },
    Reupload,
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, channel))]
async fn upload_exported_video(
    app: AppHandle,
    path: PathBuf,
    mode: UploadMode,
    channel: Channel<UploadProgress>,
    organization_id: Option<String>,
) -> Result<UploadResult, String> {
    let Ok(Some(auth)) = AuthStore::get(&app) else {
        AuthStore::set(&app, None).map_err(|e| e.to_string())?;
        return Ok(UploadResult::NotAuthenticated);
    };

    let mut meta = RecordingMeta::load_for_project(&path).map_err(|v| v.to_string())?;

    let file_path = meta.output_path();
    if !file_path.exists() {
        notifications::send_notification(&app, notifications::NotificationType::UploadFailed);
        return Err("Failed to upload video: Rendered video not found".to_string());
    }

    let metadata = build_video_meta(&file_path)
        .map_err(|err| format!("Error getting output video meta: {err}"))?;

    if !auth.is_upgraded() && metadata.duration_in_secs > 300.0 {
        return Ok(UploadResult::UpgradeRequired);
    }

    channel.send(UploadProgress { progress: 0.0 }).ok();

    let s3_config = match async {
        let video_id = match mode {
            UploadMode::Initial { pre_created_video } => {
                if let Some(pre_created) = pre_created_video {
                    return Ok(pre_created.config);
                }
                None
            }
            UploadMode::Reupload => {
                let Some(sharing) = meta.sharing.clone() else {
                    return Err("No sharing metadata found".into());
                };

                Some(sharing.id)
            }
        };

        create_or_get_video(
            &app,
            false,
            video_id,
            Some(meta.pretty_name.clone()),
            Some(metadata.clone()),
            organization_id,
        )
        .await
    }
    .await
    {
        Ok(data) => data,
        Err(AuthedApiError::InvalidAuthentication) => return Ok(UploadResult::NotAuthenticated),
        Err(AuthedApiError::UpgradeRequired) => return Ok(UploadResult::UpgradeRequired),
        Err(err) => return Err(err.to_string()),
    };

    let screenshot_path = meta.project_path.join("screenshots/display.jpg");
    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: file_path.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: path.clone(),
    });
    meta.save_for_project()
        .map_err(|e| error!("Failed to save recording meta: {e}"))
        .ok();

    match upload_video(
        &app,
        s3_config.id.clone(),
        file_path,
        screenshot_path,
        metadata,
        Some(channel.clone()),
    )
    .await
    {
        Ok(uploaded_video) => {
            channel.send(UploadProgress { progress: 1.0 }).ok();

            meta.upload = Some(UploadMeta::Complete);
            meta.sharing = Some(SharingMeta {
                link: uploaded_video.link.clone(),
                id: uploaded_video.id.clone(),
            });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            let _ = app
                .state::<ArcLock<ClipboardContext>>()
                .write()
                .await
                .set_text(uploaded_video.link.clone());

            NotificationType::ShareableLinkCopied.send(&app);
            Ok(UploadResult::Success(uploaded_video.link))
        }
        Err(AuthedApiError::UpgradeRequired) => Ok(UploadResult::UpgradeRequired),
        Err(e) => {
            error!("Failed to upload video: {e}");

            NotificationType::UploadFailed.send(&app);

            meta.upload = Some(UploadMeta::Failed {
                error: e.to_string(),
            });
            meta.save_for_project()
                .map_err(|e| error!("Failed to save recording meta: {e}"))
                .ok();

            Err(e.to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, clipboard))]
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
#[instrument(skip(app))]
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
pub struct RecordingMetaWithMetadata {
    #[serde(flatten)]
    pub inner: RecordingMeta,
    // Easier accessors for within webview
    // THESE MUST COME AFTER `inner` to override flattened fields with the same name
    pub mode: RecordingMode,
    pub status: StudioRecordingStatus,
}

impl RecordingMetaWithMetadata {
    fn new(inner: RecordingMeta) -> Self {
        Self {
            mode: match &inner.inner {
                RecordingMetaInner::Studio(_) => RecordingMode::Studio,
                RecordingMetaInner::Instant(_) => RecordingMode::Instant,
            },
            status: match &inner.inner {
                RecordingMetaInner::Studio(StudioRecordingMeta::MultipleSegments { inner }) => {
                    inner
                        .status
                        .clone()
                        .unwrap_or(StudioRecordingStatus::Complete)
                }
                RecordingMetaInner::Studio(StudioRecordingMeta::SingleSegment { .. }) => {
                    StudioRecordingStatus::Complete
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                    StudioRecordingStatus::InProgress
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) => {
                    StudioRecordingStatus::Failed {
                        error: error.clone(),
                    }
                }
                RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
                    StudioRecordingStatus::Complete
                }
            },
            inner,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileType {
    Recording,
    Screenshot,
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
fn get_recording_meta(
    path: PathBuf,
    _file_type: FileType,
) -> Result<RecordingMetaWithMetadata, String> {
    RecordingMeta::load_for_project(&path)
        .map(RecordingMetaWithMetadata::new)
        .map_err(|e| format!("Failed to load recording meta: {e}"))
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
fn list_recordings(app: AppHandle) -> Result<Vec<(PathBuf, RecordingMetaWithMetadata)>, String> {
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
#[instrument(skip(app))]
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
#[instrument(skip(app))]
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
            e.to_string()
        })?;

    println!("Plan fetch response status: {}", response.status());
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
        organizations: auth.organizations,
    };
    println!("Updating auth store with new pro status");
    AuthStore::set(&app, Some(updated_auth)).map_err(|e| e.to_string())?;

    Ok(is_pro)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
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
#[instrument(skip(_app))]
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
#[instrument(skip(_app))]
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
#[instrument(skip(app))]
async fn is_camera_window_open(app: AppHandle) -> bool {
    CapWindowId::Camera.get(&app).is_some()
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(editor_instance))]
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
#[instrument(skip(editor_instance))]
async fn get_mic_waveforms(editor_instance: WindowEditorInstance) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segment_medias.iter() {
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
#[instrument(skip(editor_instance))]
async fn get_system_audio_waveforms(
    editor_instance: WindowEditorInstance,
) -> Result<Vec<Vec<f32>>, String> {
    let mut out = Vec::new();

    for segment in editor_instance.segment_medias.iter() {
        if let Some(audio) = &segment.system_audio {
            out.push(audio::get_waveform(audio));
        } else {
            out.push(Vec::new());
        }
    }

    Ok(out)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, editor_instance, window))]
async fn editor_delete_project(
    app: tauri::AppHandle,
    editor_instance: WindowEditorInstance,
    window: tauri::Window,
) -> Result<(), String> {
    let _ = window.close();

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let path = editor_instance.0.project_path.clone();
    drop(editor_instance);

    let _ = tokio::fs::remove_dir_all(&path).await;

    RecordingDeleted { path }.emit(&app).ok();

    Ok(())
}

// keep this async otherwise opening windows may hang on windows
#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn show_window(app: AppHandle, window: ShowCapWindow) -> Result<(), String> {
    let _ = window.show(&app).await;
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
fn list_fails() -> Result<BTreeMap<String, bool>, ()> {
    Ok(cap_fail::get_state())
}

#[tauri::command(async)]
#[specta::specta]
#[instrument]
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
#[instrument(skip(app))]
async fn set_server_url(app: MutableState<'_, App>, server_url: String) -> Result<(), ()> {
    let mut app = app.write().await;
    posthog::set_server_url(&server_url);
    app.server_url = server_url;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn set_camera_preview_state(
    app: MutableState<'_, App>,
    state: CameraPreviewState,
) -> Result<(), String> {
    app.read()
        .await
        .camera_preview
        .set_state(state)
        .map_err(|err| format!("Error saving camera window state: {err}"))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn await_camera_preview_ready(app: MutableState<'_, App>) -> Result<bool, String> {
    let app = app.read().await.camera_feed.clone();

    let (tx, rx) = oneshot::channel();
    app.tell(feeds::camera::ListenForReady(tx))
        .await
        .map_err(|err| format!("error registering ready listener: {err}"))?;
    rx.await
        .map_err(|err| format!("error receiving ready signal: {err}"))?;
    Ok(true)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app))]
async fn update_auth_plan(app: AppHandle) {
    AuthStore::update_auth_plan(&app).await.ok();
}

type FilteredRegistry = tracing_subscriber::layer::Layered<
    tracing_subscriber::filter::FilterFn<fn(m: &tracing::Metadata) -> bool>,
    tracing_subscriber::Registry,
>;

pub type DynLoggingLayer = Box<dyn tracing_subscriber::Layer<FilteredRegistry> + Send + Sync>;
type LoggingHandle = tracing_subscriber::reload::Handle<Option<DynLoggingLayer>, FilteredRegistry>;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub async fn run(recording_logging_handle: LoggingHandle, logs_dir: PathBuf) {
    ffmpeg::init()
        .map_err(|e| {
            error!("Failed to initialize ffmpeg: {e}");
        })
        .ok();

    posthog::init();

    let tauri_context = tauri::generate_context!();

    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands![
            set_mic_input,
            set_camera_input,
            upload_logs,
            recording::start_recording,
            recording::stop_recording,
            recording::pause_recording,
            recording::resume_recording,
            recording::restart_recording,
            recording::delete_recording,
            recording::list_cameras,
            recording::list_capture_windows,
            recording::list_capture_displays,
            recording::list_displays_with_thumbnails,
            recording::list_windows_with_thumbnails,
            windows::refresh_window_content_protection,
            general_settings::get_default_excluded_windows,
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
            platform::is_system_audio_capture_supported,
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
            target_select_overlay::display_information,
            target_select_overlay::get_window_icon,
            target_select_overlay::focus_window,
            editor_delete_project
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
            RequestOpenRecordingPicker,
            RequestOpenSettings,
            RequestScreenCapturePrewarm,
            NewNotification,
            audio_meter::AudioInputLevelChange,
            captions::DownloadProgress,
            recording::RecordingEvent,
            RecordingDeleted,
            target_select_overlay::TargetUnderCursor,
            hotkeys::OnEscapePress,
            upload::UploadProgressEvent,
            SetCaptureAreaPending,
        ])
        .error_handling(tauri_specta::ErrorHandlingMode::Throw)
        .typ::<ProjectConfiguration>()
        .typ::<AuthStore>()
        .typ::<presets::PresetsStore>()
        .typ::<hotkeys::HotkeysStore>()
        .typ::<general_settings::GeneralSettingsStore>()
        .typ::<recording_settings::RecordingSettingsStore>()
        .typ::<cap_flags::Flags>()
        .typ::<crate::window_exclusion::WindowExclusion>();

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/utils/tauri.ts",
        )
        .expect("Failed to export typescript bindings");

    let (camera_tx, camera_ws_port, _shutdown) = camera_legacy::create_camera_preview_ws().await;

    let (mic_samples_tx, mic_samples_rx) = flume::bounded(8);
    let mic_meter_sender = mic_samples_tx.clone();

    let camera_feed = CameraFeed::spawn(CameraFeed::default());
    let _ = camera_feed.ask(feeds::camera::AddSender(camera_tx)).await;

    let mic_feed = {
        let (error_tx, error_rx) = flume::bounded(1);

        let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx));

        spawn_mic_error_logger(error_rx);

        if let Err(err) = mic_feed
            .ask(feeds::microphone::AddSender(mic_samples_tx))
            .await
        {
            error!("Failed to attach audio meter sender: {err}");
        }

        mic_feed
    };

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
                tokio::spawn(async move {
                    ShowCapWindow::Main {
                        init_target_mode: None,
                    }
                    .show(&app)
                    .await
                });
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
                    CapWindowId::RecordingControls.label().as_str(),
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
            #[cfg(target_os = "macos")]
            app.manage(crate::platform::ScreenCapturePrewarmer::default());
            app.manage(http_client::HttpClient::default());
            app.manage(http_client::RetryableHttpClient::default());

            tokio::spawn({
                let camera_feed = camera_feed.clone();
                let app = app.clone();
                async move {
                    camera_feed
                        .tell(feeds::camera::OnFeedDisconnect(Box::new({
                            move || {
                                if let Some(win) = CapWindowId::Camera.get(&app) {
                                    win.close().ok();
                                }
                            }
                        })))
                        .send()
                        .await
                        .map_err(|err| error!("Error registering on camera feed disconnect: {err}"))
                        .ok();
                }
            });

            if let Ok(Some(auth)) = AuthStore::load(&app) {
                sentry::configure_scope(|scope| {
                    scope.set_user(auth.user_id.map(|id| sentry::User {
                        id: Some(id),
                        ..Default::default()
                    }));
                });
            }

            tokio::spawn({
                let app = app.clone();
                async move {
                    resume_uploads(app)
                        .await
                        .map_err(|err| warn!("Error resuming uploads: {err}"))
                        .ok();
                }
            });

            {
                let (server_url, should_update) = if cfg!(debug_assertions)
                    && let Ok(url) = std::env::var("VITE_SERVER_URL")
                {
                    (url, true)
                } else if let Some(url) = GeneralSettingsStore::get(&app)
                    .ok()
                    .flatten()
                    .map(|v| v.server_url.clone())
                {
                    (url, false)
                } else {
                    (
                        option_env!("VITE_SERVER_URL")
                            .unwrap_or("https://cap.so")
                            .to_string(),
                        true,
                    )
                };

                // This ensures settings reflects the correct value if it's set at startup
                if should_update {
                    GeneralSettingsStore::update(&app, |s| {
                        s.server_url = server_url.clone();
                    })
                    .map_err(|err| warn!("Error updating server URL into settings store: {err}"))
                    .ok();
                }

                posthog::set_server_url(&server_url);

                app.manage(Arc::new(RwLock::new(App {
                    camera_ws_port,
                    handle: app.clone(),
                    camera_preview: CameraPreviewManager::new(&app),
                    recording_state: RecordingState::None,
                    recording_logging_handle,
                    mic_feed,
                    mic_meter_sender,
                    selected_mic_label: None,
                    camera_feed,
                    server_url,
                    logs_dir: logs_dir.clone(),
                })));

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

                        let _ = ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(&app)
                        .await;
                    }
                }
            });

            audio_meter::spawn_event_emitter(app.clone(), mic_samples_rx);

            tray::create_tray(&app).unwrap();

            RequestStartRecording::listen_any_spawn(&app, async |event, app| {
                let settings = RecordingSettingsStore::get(&app)
                    .ok()
                    .flatten()
                    .unwrap_or_default();

                let _ = set_mic_input(app.state(), settings.mic_name).await;
                let _ = set_camera_input(app.clone(), app.state(), settings.camera_id).await;

                let _ = start_recording(app.clone(), app.state(), {
                    recording::StartRecordingInputs {
                        capture_target: settings.target.unwrap_or_else(|| {
                            ScreenCaptureTarget::Display {
                                id: Display::primary().id(),
                            }
                        }),
                        mode: event.mode,
                        capture_system_audio: settings.system_audio,
                        organization_id: settings.organization_id,
                    }
                })
                .await;
            });

            RequestOpenRecordingPicker::listen_any_spawn(&app, async |event, app| {
                let _ = ShowCapWindow::Main {
                    init_target_mode: event.target_mode,
                }
                .show(&app)
                .await;
            });

            RequestOpenSettings::listen_any_spawn(&app, async |payload, app| {
                let _ = ShowCapWindow::Settings {
                    page: Some(payload.page),
                }
                .show(&app)
                .await;
            });

            #[cfg(target_os = "macos")]
            RequestScreenCapturePrewarm::listen_any_spawn(&app, async |event, app| {
                let prewarmer = app.state::<crate::platform::ScreenCapturePrewarmer>();
                prewarmer.request(event.force).await;
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

                                for (id, window) in app.webview_windows() {
                                    if let Ok(CapWindowId::TargetSelectOverlay { .. }) =
                                        CapWindowId::from_str(&id)
                                    {
                                        let _ = window.close();
                                    }
                                }

                                tokio::spawn(async move {
                                    let state = app.state::<ArcLock<App>>();
                                    let app_state = &mut *state.write().await;

                                    if !app_state.is_recording_active_or_pending() {
                                        let _ =
                                            app_state.mic_feed.ask(microphone::RemoveInput).await;
                                        let _ = app_state
                                            .camera_feed
                                            .ask(feeds::camera::RemoveInput)
                                            .await;
                                    }
                                });
                            }
                            CapWindowId::Editor { id } => {
                                let window_ids = EditorWindowIds::get(window.app_handle());
                                window_ids.ids.lock().unwrap().retain(|(_, _id)| *_id != id);

                                tokio::spawn(EditorInstances::remove(window.clone()));

                                #[cfg(target_os = "windows")]
                                if CapWindowId::Settings.get(&app).is_none() {
                                    reopen_main_window(&app);
                                }
                            }
                            CapWindowId::Settings => {
                                for (label, window) in app.webview_windows() {
                                    if let Ok(id) = CapWindowId::from_str(&label)
                                        && matches!(
                                            id,
                                            CapWindowId::TargetSelectOverlay { .. }
                                                | CapWindowId::Main
                                                | CapWindowId::Camera
                                        )
                                    {
                                        let _ = window.show();
                                    }
                                }

                                #[cfg(target_os = "windows")]
                                if !has_open_editor_window(&app) {
                                    reopen_main_window(&app);
                                }

                                return;
                            }
                            CapWindowId::Upgrade | CapWindowId::ModeSelect => {
                                for (label, window) in app.webview_windows() {
                                    if let Ok(id) = CapWindowId::from_str(&label)
                                        && matches!(
                                            id,
                                            CapWindowId::TargetSelectOverlay { .. }
                                                | CapWindowId::Main
                                                | CapWindowId::Camera
                                        )
                                    {
                                        let _ = window.show();
                                    }
                                }
                                return;
                            }
                            CapWindowId::TargetSelectOverlay { display_id } => {
                                app.state::<target_select_overlay::WindowFocusManager>()
                                    .destroy(&display_id, app.global_shortcut());
                            }
                            CapWindowId::Camera => {
                                let app = app.clone();
                                tokio::spawn(async move {
                                    app.state::<ArcLock<App>>()
                                        .write()
                                        .await
                                        .camera_preview
                                        .on_window_close();
                                });
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
                WindowEvent::Focused(focused) => {
                    let window_id = CapWindowId::from_str(label);

                    if matches!(window_id, Ok(CapWindowId::Upgrade)) {
                        for (label, window) in app.webview_windows() {
                            if let Ok(id) = CapWindowId::from_str(&label)
                                && matches!(id, CapWindowId::TargetSelectOverlay { .. })
                            {
                                let _ = window.hide();
                            }
                        }
                    }

                    if *focused
                        && let Ok(window_id) = window_id
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
        .run(move |_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                let has_window = _handle.webview_windows().iter().any(|(label, _)| {
                    label.starts_with("editor-")
                        || label.as_str() == "settings"
                        || label.as_str() == "signin"
                });

                if has_window {
                    if let Some(window) = _handle
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
                    let handle = _handle.clone();
                    tokio::spawn(async move {
                        let _ = ShowCapWindow::Main {
                            init_target_mode: None,
                        }
                        .show(&handle)
                        .await;
                    });
                }
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            _ => {}
        });
}

#[cfg(target_os = "windows")]
fn has_open_editor_window(app: &AppHandle) -> bool {
    app.webview_windows()
        .keys()
        .any(|label| matches!(CapWindowId::from_str(label), Ok(CapWindowId::Editor { .. })))
}

#[cfg(target_os = "windows")]
fn reopen_main_window(app: &AppHandle) {
    if let Some(main) = CapWindowId::Main.get(app) {
        let _ = main.show();
        let _ = main.set_focus();
    } else {
        let handle = app.clone();
        tokio::spawn(async move {
            let _ = ShowCapWindow::Main {
                init_target_mode: None,
            }
            .show(&handle)
            .await;
        });
    }
}

async fn resume_uploads(app: AppHandle) -> Result<(), String> {
    let recordings_dir = recordings_path(&app);
    if !recordings_dir.exists() {
        return Err("Recording directory missing".to_string());
    }

    let entries = std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && path.extension().and_then(|s| s.to_str()) == Some("cap") {
            // Load recording meta to check for in-progress recordings
            if let Ok(mut meta) = RecordingMeta::load_for_project(&path) {
                let mut needs_save = false;

                // Check if recording is still marked as in-progress and if so mark as failed
                // This should only happen if the application crashes while recording
                match &mut meta.inner {
                    RecordingMetaInner::Studio(StudioRecordingMeta::MultipleSegments { inner }) => {
                        if let Some(StudioRecordingStatus::InProgress) = &inner.status {
                            inner.status = Some(StudioRecordingStatus::Failed {
                                error: "Recording crashed".to_string(),
                            });
                            needs_save = true;
                        }
                    }
                    RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
                        meta.inner = RecordingMetaInner::Instant(InstantRecordingMeta::Failed {
                            error: "Recording crashed".to_string(),
                        });
                        needs_save = true;
                    }
                    _ => {}
                }

                // Save the updated meta if we made changes
                if needs_save && let Err(err) = meta.save_for_project() {
                    error!("Failed to save recording meta for {path:?}: {err}");
                }

                // Handle upload resumption
                if let Some(upload_meta) = meta.upload {
                    match upload_meta {
                        UploadMeta::MultipartUpload {
                            video_id: _,
                            file_path,
                            pre_created_video,
                            recording_dir,
                        } => {
                            InstantMultipartUpload::spawn(
                                app.clone(),
                                file_path,
                                pre_created_video,
                                recording_dir,
                                None,
                            );
                        }
                        UploadMeta::SinglePartUpload {
                            video_id,
                            file_path,
                            screenshot_path,
                            recording_dir,
                        } => {
                            let app = app.clone();
                            tokio::spawn(async move {
                                if let Ok(meta) = build_video_meta(&file_path)
                                    .map_err(|error| {
                                        error!("Failed to resume video upload. error getting video metadata: {error}");

                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Failed { error });
                                            meta.save_for_project().map_err(|err| error!("Error saving project metadata: {err}")).ok();
                                        }
                                    })
                                    && let Ok(uploaded_video) = upload_video(
                                        &app,
                                        video_id,
                                        file_path,
                                        screenshot_path,
                                        meta,
                                        None,
                                    )
                                    .await
                                    .map_err(|error| {
                                        error!("Error completing resumed upload for video: {error}");

                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Failed { error: error.to_string() });
                                            meta.save_for_project().map_err(|err| error!("Error saving project metadata: {err}")).ok();
                                        }
                                    })
                                    {
                                        if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| error!("Error loading project metadata: {err}")) {
                                            meta.upload = Some(UploadMeta::Complete);
                                            meta.sharing = Some(SharingMeta {
                                                link: uploaded_video.link.clone(),
                                                id: uploaded_video.id.clone(),
                                            });
                                            meta.save_for_project()
                                                .map_err(|e| error!("Failed to save recording meta: {e}"))
                                                .ok();
                                        }

                                        let _ = app
                                            .state::<ArcLock<ClipboardContext>>()
                                            .write()
                                            .await
                                            .set_text(uploaded_video.link.clone());
                                        NotificationType::ShareableLinkCopied.send(&app);
                                    }
                            });
                        }
                        UploadMeta::Failed { .. } | UploadMeta::Complete => {}
                    }
                }
            }
        }
    }

    Ok(())
}

async fn create_editor_instance_impl(
    app: &AppHandle,
    path: PathBuf,
    frame_cb: Box<dyn FnMut(RenderedFrame) + Send>,
) -> Result<Arc<EditorInstance>, String> {
    let app = app.clone();

    let instance = {
        let app = app.clone();
        EditorInstance::new(
            path,
            move |state| {
                let _ = EditorStateChanged::new(state).emit(&app);
            },
            frame_cb,
        )
        .await?
    };

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
#[instrument(skip(app))]
fn global_message_dialog(app: AppHandle, message: String) {
    app.dialog().message(message).show(|_| {});
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(clipboard))]
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

fn open_project_from_path(path: &Path, app: AppHandle) -> Result<(), String> {
    let meta = RecordingMeta::load_for_project(path).map_err(|v| v.to_string())?;

    match &meta.inner {
        RecordingMetaInner::Studio(meta) => {
            let status = meta.status();
            if let StudioRecordingStatus::Failed { .. } = status {
                return Err("Unable to open failed recording".to_string());
            } else if let StudioRecordingStatus::InProgress = status {
                return Err("Recording in progress".to_string());
            }

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
