use anyhow::anyhow;
use cap_fail::fail;
use cap_project::CursorMoveEvent;
use cap_project::cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS;
use cap_project::{
    CameraShape, CursorClickEvent, GlideDirection, InstantRecordingMeta, MultipleSegments,
    Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SharingMeta,
    StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration, TimelineSegment, UploadMeta,
    ZoomMode, ZoomSegment, cursor::CursorEvents,
};
#[cfg(target_os = "macos")]
use cap_recording::SendableShareableContent;
use cap_recording::feeds::camera::CameraFeedLock;
#[cfg(target_os = "macos")]
use cap_recording::sources::screen_capture::SourceError;
use cap_recording::{
    RecordingMode,
    feeds::{camera, microphone},
    instant_recording,
    recovery::RecoveryManager,
    sources::MicrophoneSourceError,
    sources::{
        screen_capture,
        screen_capture::{CaptureDisplay, CaptureWindow, ScreenCaptureTarget},
    },
    studio_recording,
};
use cap_rendering::ProjectRecordingsMeta;
use cap_utils::{ensure_dir, moment_format_to_chrono, spawn_actor};
use futures::{FutureExt, stream};
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::borrow::Cow;
#[cfg(target_os = "macos")]
use std::error::Error as StdError;
use std::{
    any::Any,
    collections::{HashMap, VecDeque},
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder};
use tauri_specta::Event;
use tracing::*;

use crate::camera::{CameraPreviewManager, CameraPreviewShape, CameraPreviewState};
#[cfg(target_os = "macos")]
use crate::general_settings;
use crate::permissions;
use crate::web_api::AuthedApiError;
use crate::{
    App, CameraWindowOperationLock, CurrentRecordingChanged, FinalizingRecordings, MutableState,
    NewStudioRecordingAdded, RecordingStarted, RecordingState, RecordingStopped, VideoUploadInfo,
    api::PresignedS3PutRequestMethod,
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot,
    general_settings::{GeneralSettingsStore, PostDeletionBehaviour, PostStudioRecordingBehaviour},
    open_external_link,
    presets::PresetsStore,
    thumbnails::*,
    upload::{
        InstantMultipartUpload, build_video_meta, compress_image, create_or_get_video, upload_video,
    },
    web_api::ManagerExt,
    windows::{CapWindowId, ShowCapWindow},
};

#[derive(Clone)]
pub struct InProgressRecordingCommon {
    pub target_name: String,
    pub inputs: StartRecordingInputs,
    pub recording_dir: PathBuf,
}

pub enum InProgressRecording {
    Instant {
        handle: instant_recording::ActorHandle,
        progressive_upload: InstantMultipartUpload,
        video_upload_info: VideoUploadInfo,
        common: InProgressRecordingCommon,
        camera_feed: Option<Arc<CameraFeedLock>>,
    },
    Studio {
        handle: studio_recording::ActorHandle,
        common: InProgressRecordingCommon,
        camera_feed: Option<Arc<CameraFeedLock>>,
    },
}

#[cfg(target_os = "macos")]
async fn acquire_shareable_content_for_target(
    capture_target: &ScreenCaptureTarget,
) -> anyhow::Result<SendableShareableContent> {
    let mut refreshed = false;

    loop {
        let shareable_content = SendableShareableContent::from(
            crate::platform::get_shareable_content()
                .await
                .map_err(|e| anyhow!(format!("GetShareableContent: {e}")))?
                .ok_or_else(|| anyhow!("GetShareableContent/NotAvailable"))?,
        );

        if !shareable_content_missing_target_display(capture_target, &shareable_content) {
            return Ok(shareable_content);
        }

        if refreshed {
            return Err(anyhow!("GetShareableContent/DisplayMissing"));
        }

        crate::platform::refresh_shareable_content()
            .await
            .map_err(|e| anyhow!(format!("RefreshShareableContent: {e}")))?;
        refreshed = true;
    }
}

#[cfg(target_os = "macos")]
fn shareable_content_missing_target_display(
    capture_target: &ScreenCaptureTarget,
    shareable_content: &SendableShareableContent,
) -> bool {
    match capture_target.display() {
        Some(display) => display
            .raw_handle()
            .as_sc(shareable_content.retained())
            .is_none(),
        None => false,
    }
}

#[cfg(target_os = "macos")]
fn is_shareable_content_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        let cause: &dyn StdError = cause;
        if let Some(source_error) = cause.downcast_ref::<SourceError>() {
            matches!(source_error, SourceError::AsContentFilter)
        } else {
            false
        }
    })
}

impl InProgressRecording {
    pub fn capture_target(&self) -> &ScreenCaptureTarget {
        match self {
            Self::Instant { handle, .. } => &handle.capture_target,
            Self::Studio { handle, .. } => &handle.capture_target,
        }
    }

    pub fn inputs(&self) -> &StartRecordingInputs {
        match self {
            Self::Instant { common, .. } => &common.inputs,
            Self::Studio { common, .. } => &common.inputs,
        }
    }

    pub async fn pause(&self) -> anyhow::Result<()> {
        match self {
            Self::Instant { handle, .. } => handle.pause().await,
            Self::Studio { handle, .. } => handle.pause().await,
        }
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        match self {
            Self::Instant { handle, .. } => handle.resume().await,
            Self::Studio { handle, .. } => handle.resume().await,
        }
    }

    pub async fn is_paused(&self) -> anyhow::Result<bool> {
        match self {
            Self::Instant { handle, .. } => handle.is_paused().await,
            Self::Studio { handle, .. } => handle.is_paused().await,
        }
    }

    pub fn recording_dir(&self) -> &PathBuf {
        match self {
            Self::Instant { common, .. } => &common.recording_dir,
            Self::Studio { common, .. } => &common.recording_dir,
        }
    }

    pub async fn stop(self) -> anyhow::Result<CompletedRecording> {
        Ok(match self {
            Self::Instant {
                handle,
                progressive_upload,
                video_upload_info,
                common,
                ..
            } => CompletedRecording::Instant {
                recording: handle.stop().await?,
                progressive_upload,
                video_upload_info,
                target_name: common.target_name,
            },
            Self::Studio { handle, common, .. } => CompletedRecording::Studio {
                recording: handle.stop().await?,
                target_name: common.target_name,
            },
        })
    }

    pub fn done_fut(&self) -> cap_recording::DoneFut {
        match self {
            Self::Instant { handle, .. } => handle.done_fut(),
            Self::Studio { handle, .. } => handle.done_fut(),
        }
    }

    pub fn take_health_rx(&mut self) -> Option<cap_recording::HealthReceiver> {
        match self {
            Self::Instant { handle, .. } => handle.take_health_rx(),
            Self::Studio { .. } => None,
        }
    }

    pub async fn cancel(self) -> anyhow::Result<()> {
        match self {
            Self::Instant { handle, .. } => handle.cancel().await,
            Self::Studio { handle, .. } => handle.cancel().await,
        }
    }

    pub fn mode(&self) -> RecordingMode {
        match self {
            Self::Instant { .. } => RecordingMode::Instant,
            Self::Studio { .. } => RecordingMode::Studio,
        }
    }
}

pub enum CompletedRecording {
    Instant {
        recording: instant_recording::CompletedRecording,
        target_name: String,
        progressive_upload: InstantMultipartUpload,
        video_upload_info: VideoUploadInfo,
    },
    Studio {
        recording: studio_recording::CompletedRecording,
        target_name: String,
    },
}

impl CompletedRecording {
    pub fn project_path(&self) -> &PathBuf {
        match self {
            Self::Instant { recording, .. } => &recording.project_path,
            Self::Studio { recording, .. } => &recording.project_path,
        }
    }

    pub fn target_name(&self) -> &String {
        match self {
            Self::Instant { target_name, .. } => target_name,
            Self::Studio { target_name, .. } => target_name,
        }
    }
}

#[tauri::command(async)]
#[specta::specta]
pub async fn list_capture_displays() -> Vec<CaptureDisplay> {
    screen_capture::list_displays()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub async fn list_capture_windows() -> Vec<CaptureWindow> {
    screen_capture::list_windows()
        .into_iter()
        .map(|(v, _)| v)
        .collect()
}

#[tauri::command(async)]
#[specta::specta]
pub fn list_cameras() -> Vec<cap_camera::CameraInfo> {
    if !permissions::do_permissions_check(false).camera.permitted() {
        return vec![];
    }
    cap_camera::list_cameras().collect()
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraFormatInfo {
    pub width: u32,
    pub height: u32,
    pub frame_rate: f32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CameraWithFormats {
    pub device_id: String,
    pub display_name: String,
    pub model_id: Option<String>,
    pub formats: Vec<CameraFormatInfo>,
    pub best_format: Option<CameraFormatInfo>,
}

fn get_best_format(formats: &[CameraFormatInfo]) -> Option<CameraFormatInfo> {
    formats
        .iter()
        .filter(|f| f.frame_rate >= 24.0 && f.frame_rate <= 60.0)
        .max_by(|a, b| {
            let res_a = a.width * a.height;
            let res_b = b.width * b.height;
            res_a.cmp(&res_b)
        })
        .or_else(|| {
            formats.iter().max_by(|a, b| {
                let res_a = a.width * a.height;
                let res_b = b.width * b.height;
                res_a.cmp(&res_b)
            })
        })
        .cloned()
}

#[tauri::command(async)]
#[specta::specta]
pub fn get_camera_formats(device_id: String) -> Option<CameraWithFormats> {
    if !permissions::do_permissions_check(false).camera.permitted() {
        return None;
    }

    cap_camera::list_cameras()
        .find(|c| c.device_id() == device_id)
        .map(|camera| {
            let formats: Vec<CameraFormatInfo> = camera
                .formats()
                .unwrap_or_default()
                .into_iter()
                .map(|f| CameraFormatInfo {
                    width: f.width(),
                    height: f.height(),
                    frame_rate: f.frame_rate(),
                })
                .collect();

            let best_format = get_best_format(&formats);

            CameraWithFormats {
                device_id: camera.device_id().to_string(),
                display_name: camera.display_name().to_string(),
                model_id: camera.model_id().map(|m| m.to_string()),
                formats,
                best_format,
            }
        })
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneInfo {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
}

#[tauri::command(async)]
#[specta::specta]
pub fn get_microphone_info(name: String) -> Option<MicrophoneInfo> {
    if !permissions::do_permissions_check(false)
        .microphone
        .permitted()
    {
        return None;
    }

    microphone::MicrophoneFeed::list()
        .into_iter()
        .find(|(n, _)| *n == name)
        .map(|(name, (_device, config))| MicrophoneInfo {
            name,
            sample_rate: config.sample_rate().0,
            channels: config.channels(),
        })
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn list_displays_with_thumbnails() -> Result<Vec<CaptureDisplayWithThumbnail>, String> {
    tokio::task::spawn_blocking(|| {
        tauri::async_runtime::block_on(collect_displays_with_thumbnails())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn list_windows_with_thumbnails() -> Result<Vec<CaptureWindowWithThumbnail>, String> {
    tokio::task::spawn_blocking(
        || tauri::async_runtime::block_on(collect_windows_with_thumbnails()),
    )
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Deserialize, Type, Clone, Debug)]
pub struct StartRecordingInputs {
    pub capture_target: ScreenCaptureTarget,
    #[serde(default)]
    pub capture_system_audio: bool,
    pub mode: RecordingMode,
    #[serde(default)]
    pub organization_id: Option<String>,
}

#[derive(Deserialize, Type, Serialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum RecordingInputKind {
    Microphone,
    Camera,
}

#[derive(tauri_specta::Event, specta::Type, Clone, Debug, serde::Serialize)]
#[serde(tag = "variant")]
pub enum RecordingEvent {
    Countdown { value: u32 },
    Started,
    Stopped,
    Paused,
    Resumed,
    Failed { error: String },
    InputLost { input: RecordingInputKind },
    InputRestored { input: RecordingInputKind },
    Degraded { reason: String },
    Recovered,
}

#[derive(Serialize, Type)]
pub enum RecordingAction {
    Started,
    InvalidAuthentication,
    UpgradeRequired,
}

pub fn format_project_name<'a>(
    template: Option<&str>,
    target_name: &'a str,
    target_kind: &'a str,
    recording_mode: RecordingMode,
    datetime: Option<chrono::DateTime<chrono::Local>>,
) -> String {
    const DEFAULT_FILENAME_TEMPLATE: &str = "{target_name} ({target_kind}) {date} {time}";
    const MAX_TARGET_NAME_CHARS: usize = 180;
    let datetime = datetime.unwrap_or(chrono::Local::now());

    let truncated_target_name: std::borrow::Cow<'_, str> =
        if target_name.chars().count() > MAX_TARGET_NAME_CHARS {
            std::borrow::Cow::Owned(
                target_name
                    .chars()
                    .take(MAX_TARGET_NAME_CHARS)
                    .collect::<String>()
                    + "...",
            )
        } else {
            std::borrow::Cow::Borrowed(target_name)
        };

    lazy_static! {
        static ref DATE_REGEX: Regex = Regex::new(r"\{date(?::([^}]+))?\}").unwrap();
        static ref TIME_REGEX: Regex = Regex::new(r"\{time(?::([^}]+))?\}").unwrap();
        static ref MOMENT_REGEX: Regex = Regex::new(r"\{moment(?::([^}]+))?\}").unwrap();
        static ref AC: aho_corasick::AhoCorasick = {
            aho_corasick::AhoCorasick::new([
                "{recording_mode}",
                "{mode}",
                "{target_kind}",
                "{target_name}",
            ])
            .expect("Failed to build AhoCorasick automaton")
        };
    }
    let haystack = template.unwrap_or(DEFAULT_FILENAME_TEMPLATE);

    // Get recording mode information
    let (recording_mode, mode) = match recording_mode {
        RecordingMode::Studio => ("Studio", "studio"),
        RecordingMode::Instant => ("Instant", "instant"),
        RecordingMode::Screenshot => ("Screenshot", "screenshot"),
    };

    let result = AC
        .try_replace_all(
            haystack,
            &[recording_mode, mode, target_kind, &truncated_target_name],
        )
        .expect("AhoCorasick replace should never fail with default configuration");

    let result = DATE_REGEX.replace_all(&result, |caps: &regex::Captures| {
        datetime
            .format(
                &caps
                    .get(1)
                    .map(|m| m.as_str())
                    .map(moment_format_to_chrono)
                    .unwrap_or(Cow::Borrowed("%Y-%m-%d")),
            )
            .to_string()
    });

    let result = TIME_REGEX.replace_all(&result, |caps: &regex::Captures| {
        datetime
            .format(
                &caps
                    .get(1)
                    .map(|m| m.as_str())
                    .map(moment_format_to_chrono)
                    .unwrap_or(Cow::Borrowed("%I:%M %p")),
            )
            .to_string()
    });

    let result = MOMENT_REGEX.replace_all(&result, |caps: &regex::Captures| {
        datetime
            .format(
                &caps
                    .get(1)
                    .map(|m| m.as_str())
                    .map(moment_format_to_chrono)
                    .unwrap_or(Cow::Borrowed("%Y-%m-%d %H:%M")),
            )
            .to_string()
    });

    result.into_owned()
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(name = "recording", skip_all)]
pub async fn start_recording(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    inputs: StartRecordingInputs,
) -> Result<RecordingAction, String> {
    if !matches!(state_mtx.read().await.recording_state, RecordingState::None) {
        return Err("Recording already in progress".to_string());
    }

    let mut inputs = inputs;
    if matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly) {
        inputs.capture_system_audio = false;

        {
            let mut app_state = state_mtx.write().await;
            app_state.was_camera_only_recording = true;

            let current_mirrored = app_state
                .camera_preview
                .get_state()
                .map(|s| s.mirrored)
                .unwrap_or(false);

            let camera_state = CameraPreviewState {
                size: crate::camera::CAMERA_PRESET_LARGE,
                shape: CameraPreviewShape::Full,
                mirrored: current_mirrored,
            };

            if let Err(err) = app_state.camera_preview.set_state(camera_state) {
                error!("Failed to set camera preview state for camera-only mode: {err}");
            }
        }

        let operation_lock = app.state::<CameraWindowOperationLock>();
        let _operation_guard = operation_lock.lock().await;
        ShowCapWindow::Camera { centered: true }
            .show(&app)
            .await
            .map_err(|err| format!("Failed to show centered camera window: {err}"))?;
    }

    let general_settings = GeneralSettingsStore::get(&app).ok().flatten();
    let general_settings = general_settings.as_ref();

    let project_name = format_project_name(
        general_settings
            .and_then(|s| s.default_project_name_template.clone())
            .as_deref(),
        inputs
            .capture_target
            .title()
            .as_deref()
            .unwrap_or("Unknown"),
        inputs.capture_target.kind_str(),
        inputs.mode,
        None,
    );

    let filename = project_name.replace(":", ".");
    let filename = format!("{}.cap", sanitize_filename::sanitize(&filename));

    let recordings_base_dir = app.path().app_data_dir().unwrap().join("recordings");

    let project_file_path = recordings_base_dir.join(&cap_utils::ensure_unique_filename(
        &filename,
        &recordings_base_dir,
    )?);

    ensure_dir(&project_file_path)
        .map_err(|e| format!("Failed to create recording directory: {e}"))?;
    state_mtx
        .write()
        .await
        .add_recording_logging_handle(&project_file_path.join("recording-logs.log"))
        .await?;

    if let Some(window) = CapWindowId::Camera.get(&app) {
        let _ = window.set_content_protected(matches!(inputs.mode, RecordingMode::Studio));
    }

    let video_upload_info = match inputs.mode {
        RecordingMode::Instant => {
            match AuthStore::get(&app).ok().flatten() {
                Some(_) => {
                    // Pre-create the video and get the shareable link
                    let s3_config = match create_or_get_video(
                        &app,
                        false,
                        None,
                        Some(project_name.clone()),
                        None,
                        inputs.organization_id.clone(),
                    )
                    .await
                    {
                        Ok(meta) => meta,
                        Err(AuthedApiError::InvalidAuthentication) => {
                            return Ok(RecordingAction::InvalidAuthentication);
                        }
                        Err(AuthedApiError::UpgradeRequired) => {
                            return Ok(RecordingAction::UpgradeRequired);
                        }
                        Err(err) => {
                            error!("Error creating instant mode video: {err}");
                            return Err(err.to_string());
                        }
                    };

                    let link = app.make_app_url(format!("/s/{}", s3_config.id)).await;
                    info!("Pre-created shareable link: {}", link);

                    Some(VideoUploadInfo {
                        id: s3_config.id.to_string(),
                        link: link.clone(),
                        config: s3_config,
                    })
                }
                // Allow the recording to proceed without error for any signed-in user
                _ => {
                    // User is not signed in
                    return Err("Please sign in to use instant recording".to_string());
                }
            }
        }
        RecordingMode::Studio => None,
        RecordingMode::Screenshot => return Err("Use take_screenshot for screenshots".to_string()),
    };

    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_file_path.clone(),
        pretty_name: project_name.clone(),
        inner: match inputs.mode {
            RecordingMode::Studio => {
                RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
                    inner: MultipleSegments {
                        segments: Default::default(),
                        cursors: Default::default(),
                        status: Some(StudioRecordingStatus::InProgress),
                    },
                }))
            }
            RecordingMode::Instant => {
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true })
            }
            RecordingMode::Screenshot => {
                return Err("Use take_screenshot for screenshots".to_string());
            }
        },
        sharing: None,
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e}"))?;

    match &inputs.capture_target {
        ScreenCaptureTarget::Window { id: _id } => {
            if let Some(show) = inputs
                .capture_target
                .display()
                .map(|d| ShowCapWindow::WindowCaptureOccluder { screen_id: d.id() })
            {
                let _ = show.show(&app).await;
            }
        }
        ScreenCaptureTarget::Area { screen, .. } => {
            let _ = ShowCapWindow::WindowCaptureOccluder {
                screen_id: screen.clone(),
            }
            .show(&app)
            .await;
        }
        _ => {}
    }

    // Set pending state BEFORE closing main window and starting countdown
    state_mtx
        .write()
        .await
        .set_pending_recording(inputs.mode, inputs.capture_target.clone());

    let countdown = general_settings.and_then(|v| v.recording_countdown);
    for (id, win) in app
        .webview_windows()
        .iter()
        .filter_map(|(label, win)| CapWindowId::from_str(label).ok().map(|id| (id, win)))
    {
        if matches!(id, CapWindowId::TargetSelectOverlay { .. }) {
            win.hide().ok();
        }
    }
    let _ = ShowCapWindow::InProgressRecording { countdown }
        .show(&app)
        .await;

    if let Some(window) = CapWindowId::Main.get(&app) {
        let _ = general_settings
            .map(|v| v.main_window_recording_start_behaviour)
            .unwrap_or_default()
            .perform(&window);
    }

    if let Some(countdown) = countdown {
        for t in 0..countdown {
            let _ = RecordingEvent::Countdown {
                value: countdown - t,
            }
            .emit(&app);
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    let (finish_upload_tx, finish_upload_rx) = flume::bounded(1);

    debug!("spawning start_recording actor");

    let app_handle = app.clone();
    let actor_task = {
        let state_mtx = Arc::clone(&state_mtx);
        let general_settings = general_settings.cloned();
        let recording_dir = project_file_path.clone();
        let inputs = inputs.clone();
        async move {
            fail!("recording::spawn_actor");
            use kameo::error::SendError;

            // Initialize camera if selected but not active
            let (camera_feed_actor, selected_camera_id) = {
                let state = state_mtx.read().await;
                (state.camera_feed.clone(), state.selected_camera_id.clone())
            };

            let camera_lock_result = camera_feed_actor.ask(camera::Lock).await;

            let camera_feed_lock = match camera_lock_result {
                Ok(lock) => Some(lock),
                Err(SendError::HandlerError(camera::LockFeedError::NoInput)) => {
                    if let Some(id) = selected_camera_id {
                        info!(
                            "Camera selected but not initialized, initializing: {:?}",
                            id
                        );
                        match camera_feed_actor
                            .ask(camera::SetInput { id: id.clone() })
                            .await
                        {
                            Ok(fut) => match fut.await {
                                Ok(_) => match camera_feed_actor.ask(camera::Lock).await {
                                    Ok(lock) => Some(lock),
                                    Err(e) => {
                                        warn!("Failed to lock camera after initialization: {}", e);
                                        None
                                    }
                                },
                                Err(e) => {
                                    warn!("Failed to initialize camera: {}", e);
                                    None
                                }
                            },
                            Err(e) => {
                                warn!("Failed to ask SetInput: {}", e);
                                None
                            }
                        }
                    } else {
                        None
                    }
                }
                Err(e) => return Err(anyhow!(e.to_string())),
            };

            let mut state = state_mtx.write().await;

            let camera_feed = camera_feed_lock.map(Arc::new);

            state.camera_in_use = camera_feed.is_some();

            #[cfg(target_os = "macos")]
            let mut shareable_content = match inputs.capture_target {
                ScreenCaptureTarget::CameraOnly => None,
                _ => Some(acquire_shareable_content_for_target(&inputs.capture_target).await?),
            };

            let common = InProgressRecordingCommon {
                target_name: project_name,
                inputs: inputs.clone(),
                recording_dir: recording_dir.clone(),
            };

            #[cfg(target_os = "macos")]
            let excluded_windows = {
                let window_exclusions = general_settings
                    .as_ref()
                    .map_or_else(general_settings::default_excluded_windows, |settings| {
                        settings.excluded_windows.clone()
                    });

                crate::window_exclusion::resolve_window_ids(&window_exclusions)
            };

            let mut mic_restart_attempts = 0;

            let (done_fut, health_rx) = loop {
                let mic_feed = match state.mic_feed.ask(microphone::Lock).await {
                    Ok(lock) => Some(Arc::new(lock)),
                    Err(SendError::HandlerError(microphone::LockFeedError::NoInput)) => None,
                    Err(e) => return Err(anyhow!(e.to_string())),
                };

                let actor_result: Result<InProgressRecording, anyhow::Error> = async {
                    match inputs.mode {
                        RecordingMode::Studio => {
                            let mut builder = studio_recording::Actor::builder(
                                recording_dir.clone(),
                                inputs.capture_target.clone(),
                            )
                            .with_system_audio(inputs.capture_system_audio)
                            .with_custom_cursor(
                                general_settings
                                    .as_ref()
                                    .map(|s| s.custom_cursor_capture)
                                    .unwrap_or_default(),
                            )
                            .with_fragmented(
                                general_settings
                                    .as_ref()
                                    .map(|s| s.crash_recovery_recording)
                                    .unwrap_or_default(),
                            )
                            .with_max_fps(
                                general_settings.as_ref().map(|s| s.max_fps).unwrap_or(60),
                            );

                            #[cfg(target_os = "macos")]
                            {
                                builder = builder.with_excluded_windows(excluded_windows.clone());
                            }

                            if let Some(camera_feed) = camera_feed.clone() {
                                builder = builder.with_camera_feed(camera_feed);
                            }

                            if let Some(mic_feed) = mic_feed.clone() {
                                builder = builder.with_mic_feed(mic_feed);
                            }

                            let handle = builder
                                .build(
                                    #[cfg(target_os = "macos")]
                                    shareable_content.clone(),
                                )
                                .await
                                .map_err(|e| {
                                    error!("Failed to spawn studio recording actor: {e:#}");
                                    e
                                })?;

                            Ok(InProgressRecording::Studio {
                                handle,
                                common: common.clone(),
                                camera_feed: camera_feed.clone(),
                            })
                        }
                        RecordingMode::Instant => {
                            let Some(video_upload_info) = video_upload_info.clone() else {
                                return Err(anyhow!("Video upload info not found"));
                            };

                            let mut builder = instant_recording::Actor::builder(
                                recording_dir.clone(),
                                inputs.capture_target.clone(),
                            )
                            .with_system_audio(inputs.capture_system_audio)
                            .with_max_output_size(
                                general_settings
                                    .as_ref()
                                    .map(|settings| settings.instant_mode_max_resolution)
                                    .unwrap_or(1920),
                            );

                            #[cfg(target_os = "macos")]
                            {
                                builder = builder.with_excluded_windows(excluded_windows.clone());
                            }

                            if let Some(camera_feed) = camera_feed.clone() {
                                builder = builder.with_camera_feed(camera_feed);
                            }

                            if let Some(mic_feed) = mic_feed.clone() {
                                builder = builder.with_mic_feed(mic_feed);
                            }

                            let handle = builder
                                .build(
                                    #[cfg(target_os = "macos")]
                                    shareable_content.clone(),
                                )
                                .await
                                .map_err(|e| {
                                    error!("Failed to spawn instant recording actor: {e:#}");
                                    e
                                })?;

                            let progressive_upload = InstantMultipartUpload::spawn(
                                app_handle.clone(),
                                recording_dir.join("content/output.mp4"),
                                video_upload_info.clone(),
                                recording_dir.clone(),
                                Some(finish_upload_rx.clone()),
                            );

                            Ok(InProgressRecording::Instant {
                                handle,
                                progressive_upload,
                                video_upload_info,
                                common: common.clone(),
                                camera_feed: camera_feed.clone(),
                            })
                        }
                        RecordingMode::Screenshot => Err(anyhow!(
                            "Screenshot mode should be handled via take_screenshot"
                        )),
                    }
                }
                .await;

                match actor_result {
                    Ok(mut actor) => {
                        let done_fut = actor.done_fut();
                        let health_rx = actor.take_health_rx();
                        state.set_current_recording(actor);
                        break (done_fut, health_rx);
                    }
                    #[cfg(target_os = "macos")]
                    Err(err) if is_shareable_content_error(&err) => {
                        shareable_content = Some(
                            acquire_shareable_content_for_target(&inputs.capture_target).await?,
                        );
                        continue;
                    }
                    Err(err) if mic_restart_attempts < 3 && mic_actor_not_running(&err) => {
                        mic_restart_attempts += 1;
                        state
                            .restart_mic_feed()
                            .await
                            .map_err(|restart_err| anyhow!(restart_err))?;
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    Err(err) => return Err(err),
                }
            };

            Ok::<_, anyhow::Error>((done_fut, health_rx))
        }
    };

    let actor_task_res = AssertUnwindSafe(actor_task).catch_unwind().await;

    let (actor_done_fut, health_rx) = match actor_task_res {
        Ok(Ok(v)) => v,
        Ok(Err(err)) => {
            let message = format!("{err:#}");
            handle_spawn_failure(
                &app,
                &state_mtx,
                project_file_path.as_path(),
                message.clone(),
            )
            .await?;
            return Err(message);
        }
        Err(panic) => {
            let panic_msg = panic_message(panic);
            let message = format!("Failed to spawn recording actor: {panic_msg}");
            handle_spawn_failure(
                &app,
                &state_mtx,
                project_file_path.as_path(),
                message.clone(),
            )
            .await?;
            return Err(message);
        }
    };

    let _ = RecordingEvent::Started.emit(&app);
    let _ = RecordingStarted.emit(&app);

    spawn_actor({
        let app = app.clone();
        let state_mtx = Arc::clone(&state_mtx);
        async move {
            fail!("recording::wait_actor_done");
            let res = actor_done_fut.await;
            info!("recording wait actor done: {:?}", &res);
            match res {
                Ok(()) => {
                    let _ = finish_upload_tx.send(());
                    let _ = RecordingEvent::Stopped.emit(&app);
                }
                Err(e) => {
                    let error = e.to_string();
                    let _ = RecordingEvent::Failed {
                        error: error.clone(),
                    }
                    .emit(&app);

                    {
                        let mut state = state_mtx.write().await;
                        handle_recording_end(
                            app.clone(),
                            Err(error.clone()),
                            &mut state,
                            project_file_path,
                        )
                        .await
                        .ok();
                    }

                    let mut dialog = MessageDialogBuilder::new(
                        app.dialog().clone(),
                        "An error occurred".to_string(),
                    if let Some(window) = CapWindowId::Main
                        .get(&app)
                        .or_else(|| CapWindowId::RecordingControls.get(&app))
                    {
                        dialog = dialog.parent(&window);
                    }
                    )
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error);

                    if let Some(window) = CapWindowId::RecordingControls.get(&app) {
                        dialog = dialog.parent(&window);
                    }

                    dialog.blocking_show();
                }
            }
        }
    });

    if let Some(mut health_rx) = health_rx {
        spawn_actor({
            let app = app.clone();
            async move {
                let mut is_degraded = false;
                while let Some(event) = health_rx.recv().await {
                    let reason = match &event {
                        cap_recording::PipelineHealthEvent::FrameDropRateHigh { rate_pct } => {
                            Some(format!("High frame drop rate: {rate_pct:.0}%"))
                        }
                        cap_recording::PipelineHealthEvent::AudioGapDetected { gap_ms } => {
                            Some(format!("Audio gap detected: {gap_ms}ms"))
                        }
                        cap_recording::PipelineHealthEvent::SourceRestarting => {
                            Some("Capture source restarting".to_string())
                        }
                        cap_recording::PipelineHealthEvent::SourceRestarted => None,
                    };

                    if let Some(reason) = reason {
                        if !is_degraded {
                            is_degraded = true;
                            RecordingEvent::Degraded { reason }.emit(&app).ok();
                        }
                    } else if matches!(event, cap_recording::PipelineHealthEvent::SourceRestarted)
                        && is_degraded
                    {
                        is_degraded = false;
                        RecordingEvent::Recovered.emit(&app).ok();
                    }
                }
            }
        });
    }

    AppSounds::StartRecording.play();

    Ok(RecordingAction::Started)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn pause_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording_mut() {
        recording.pause().await.map_err(|e| e.to_string())?;
        RecordingEvent::Paused.emit(&app).ok();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn resume_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;

    if let Some(recording) = state.current_recording_mut() {
        recording.resume().await.map_err(|e| e.to_string())?;
        RecordingEvent::Resumed.emit(&app).ok();
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn toggle_pause_recording(
    app: AppHandle,
    state: MutableState<'_, App>,
) -> Result<(), String> {
    let state = state.read().await;

    if let Some(recording) = state.current_recording() {
        if recording.is_paused().await.map_err(|e| e.to_string())? {
            recording.resume().await.map_err(|e| e.to_string())?;
            RecordingEvent::Resumed.emit(&app).ok();
        } else {
            recording.pause().await.map_err(|e| e.to_string())?;
            RecordingEvent::Paused.emit(&app).ok();
        }
    }

    Ok(())
}

async fn handle_spawn_failure(
    app: &AppHandle,
    state_mtx: &MutableState<'_, App>,
    recording_dir: &Path,
    message: String,
) -> Result<(), String> {
    let _ = RecordingEvent::Failed {
        error: message.clone(),
    }
    .emit(app);

    let mut dialog = MessageDialogBuilder::new(
        app.dialog().clone(),
        "An error occurred".to_string(),
        message.clone(),
    )
    .kind(tauri_plugin_dialog::MessageDialogKind::Error);

    if let Some(window) = CapWindowId::RecordingControls.get(app) {
        dialog = dialog.parent(&window);
    }

    dialog.blocking_show();

    let mut state = state_mtx.write().await;
    let _ = handle_recording_end(
        app.clone(),
        Err(message),
        &mut state,
        recording_dir.to_path_buf(),
    )
    .await;

    Ok(())
}

fn panic_message(panic: Box<dyn Any + Send>) -> String {
    if let Some(msg) = panic.downcast_ref::<&str>() {
        msg.to_string()
    } else if let Some(msg) = panic.downcast_ref::<String>() {
        msg.clone()
    } else {
        "unknown panic".to_string()
    }
}

fn mic_actor_not_running(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        if let Some(source) = cause.downcast_ref::<MicrophoneSourceError>() {
            matches!(source, MicrophoneSourceError::ActorNotRunning)
        } else {
            false
        }
    })
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;
    let Some(current_recording) = state.clear_current_recording() else {
        return Err("Recording not in progress".to_string())?;
    };

    let completed_recording = current_recording.stop().await.map_err(|e| e.to_string())?;
    let recording_dir = completed_recording.project_path().clone();

    handle_recording_end(app, Ok(completed_recording), &mut state, recording_dir).await?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn restart_recording(
    app: AppHandle,
    state: MutableState<'_, App>,
) -> Result<RecordingAction, String> {
    let Some(recording) = state.write().await.clear_current_recording() else {
        return Err("No recording in progress".to_string());
    };

    let _ = CurrentRecordingChanged.emit(&app);

    let inputs = recording.inputs().clone();

    let _ = recording.cancel().await;

    tokio::time::sleep(Duration::from_millis(1000)).await;

    start_recording(app.clone(), state, inputs).await
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn delete_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let recording_data = {
        let mut app_state = state.write().await;
        app_state.clear_current_recording()
    };

    if let Some(recording) = recording_data {
        let recording_dir = recording.recording_dir().clone();
        CurrentRecordingChanged.emit(&app).ok();
        RecordingStopped {}.emit(&app).ok();

        let video_id = match &recording {
            InProgressRecording::Instant {
                video_upload_info,
                progressive_upload,
                ..
            } => {
                debug!(
                    "User deleted recording. Aborting multipart upload for {:?}",
                    video_upload_info.id
                );
                progressive_upload.handle.abort();

                Some(video_upload_info.id.clone())
            }
            _ => None,
        };

        let _ = recording.cancel().await;

        std::fs::remove_dir_all(&recording_dir).ok();

        if let Some(id) = video_id {
            let _ = app
                .authed_api_request(
                    format!("/api/desktop/video/delete?videoId={id}"),
                    |c, url| c.delete(url),
                )
                .await;
        }

        // Check user's post-deletion behavior setting
        let settings = GeneralSettingsStore::get(&app)
            .ok()
            .flatten()
            .unwrap_or_default();

        if let Some(window) = CapWindowId::RecordingControls.get(&app) {
            let _ = window.hide();
        }

        match settings.post_deletion_behaviour {
            PostDeletionBehaviour::DoNothing => {}
            PostDeletionBehaviour::ReopenRecordingWindow => {
                let _ = ShowCapWindow::Main {
                    init_target_mode: None,
                }
                .show(&app)
                .await;
            }
        }
    }

    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
#[tracing::instrument(name = "take_screenshot", skip(app))]
pub async fn take_screenshot(
    app: AppHandle,
    target: ScreenCaptureTarget,
) -> Result<PathBuf, String> {
    use crate::NewScreenshotAdded;
    use crate::notifications;
    use crate::{PendingScreenshot, PendingScreenshots};
    use cap_recording::screenshot::capture_screenshot;
    use image::ImageEncoder;
    use std::time::Instant;

    let general_settings = GeneralSettingsStore::get(&app).ok().flatten();
    let general_settings = general_settings.as_ref();

    let project_name = format_project_name(
        general_settings
            .and_then(|s| s.default_project_name_template.clone())
            .as_deref(),
        target.title().as_deref().unwrap_or("Unknown"),
        target.kind_str(),
        RecordingMode::Screenshot,
        None,
    );

    let image = capture_screenshot(target)
        .await
        .map_err(|e| format!("Failed to capture screenshot: {e}"))?;

    AppSounds::Notification.play();

    let image_width = image.width();
    let image_height = image.height();
    let channels: u32 = match &image {
        image::DynamicImage::ImageRgba8(_) => 4,
        _ => 3,
    };
    let color_type = if channels == 4 {
        image::ColorType::Rgba8
    } else {
        image::ColorType::Rgb8
    };
    let image_data = image.into_bytes();

    let filename = project_name.replace(":", ".");
    let filename = format!("{}.cap", sanitize_filename::sanitize(&filename));

    let screenshots_base_dir = app.path().app_data_dir().unwrap().join("screenshots");

    let project_file_path = screenshots_base_dir.join(&cap_utils::ensure_unique_filename(
        &filename,
        &screenshots_base_dir,
    )?);

    ensure_dir(&project_file_path)
        .map_err(|e| format!("Failed to create screenshots directory: {e}"))?;

    let image_filename = "original.png";
    let image_path = project_file_path.join(image_filename);
    let cap_dir_key = project_file_path.to_string_lossy().to_string();

    let pending_screenshots = app.state::<PendingScreenshots>();
    pending_screenshots.insert(
        cap_dir_key.clone(),
        PendingScreenshot {
            data: image_data.clone(),
            width: image_width,
            height: image_height,
            channels,
            created_at: Instant::now(),
        },
    );

    let relative_path = relative_path::RelativePathBuf::from(image_filename);

    let video_meta = cap_project::VideoMeta {
        path: relative_path,
        fps: 0,
        start_time: Some(0.0),
        device_id: None,
    };

    let segment = cap_project::SingleSegment {
        display: video_meta,
        camera: None,
        audio: None,
        cursor: None,
    };

    let meta = cap_project::RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_file_path.clone(),
        pretty_name: project_name,
        sharing: None,
        inner: cap_project::RecordingMetaInner::Studio(Box::new(
            cap_project::StudioRecordingMeta::SingleSegment { segment },
        )),
        upload: None,
    };

    meta.save_for_project()
        .map_err(|e| format!("Failed to save recording meta: {e}"))?;

    cap_project::ProjectConfiguration::default()
        .write(&project_file_path)
        .map_err(|e| format!("Failed to save project config: {e}"))?;

    let is_large_capture = (image_width as u64).saturating_mul(image_height as u64) > 8_000_000;
    let compression = if is_large_capture {
        image::codecs::png::CompressionType::Fast
    } else {
        image::codecs::png::CompressionType::Default
    };
    let image_path_for_emit = image_path.clone();
    let image_path_for_write = image_path.clone();
    let app_handle = app.clone();
    let pending_state = PendingScreenshots(pending_screenshots.0.clone());

    tauri::async_runtime::spawn(async move {
        let encode_result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let file = std::fs::File::create(&image_path_for_write)
                .map_err(|e| format!("Failed to create screenshot file: {e}"))?;
            let encoder = image::codecs::png::PngEncoder::new_with_quality(
                std::io::BufWriter::new(file),
                compression,
                image::codecs::png::FilterType::Adaptive,
            );

            ImageEncoder::write_image(
                encoder,
                &image_data,
                image_width,
                image_height,
                color_type.into(),
            )
            .map_err(|e| format!("Failed to encode PNG: {e}"))
        })
        .await;

        pending_state.remove(&cap_dir_key);

        match encode_result {
            Ok(Ok(())) => {
                let _ = NewScreenshotAdded {
                    path: image_path_for_emit.clone(),
                }
                .emit(&app_handle);

                notifications::send_notification(
                    &app_handle,
                    notifications::NotificationType::ScreenshotSaved,
                );
            }
            Ok(Err(e)) => {
                error!("Failed to encode PNG: {e}");
                notifications::send_notification(
                    &app_handle,
                    notifications::NotificationType::ScreenshotSaveFailed,
                );
            }
            Err(e) => {
                error!("Failed to join screenshot encoding task: {e}");
                notifications::send_notification(
                    &app_handle,
                    notifications::NotificationType::ScreenshotSaveFailed,
                );
            }
        }
    });

    Ok(image_path)
}

async fn handle_recording_end(
    handle: AppHandle,
    recording: Result<CompletedRecording, String>,
    app: &mut App,
    recording_dir: PathBuf,
) -> Result<(), String> {
    let cleared = app.clear_current_recording();
    app.disconnected_inputs.clear();
    app.camera_in_use = false;

    if recording.is_err()
        && let Some(InProgressRecording::Instant {
            progressive_upload,
            video_upload_info,
            ..
        }) = cleared
    {
        info!("Aborting progressive upload due to recording failure");
        progressive_upload.handle.abort();
        crate::upload::emit_upload_complete(&handle, &video_upload_info.id);
    }

    if app.was_camera_only_recording {
        app.was_camera_only_recording = false;

        let default_state = CameraPreviewState::default();
        if let Err(err) = app.camera_preview.set_state(default_state) {
            error!("Failed to reset camera preview state after camera-only recording: {err}");
        }
    }

    let res = match recording {
        // we delay reporting errors here so that everything else happens first
        Ok(recording) => Some(handle_recording_finish(&handle, recording).await),
        Err(error) => {
            if let Ok(mut project_meta) =
                RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
                    error!("Error loading recording meta while finishing recording: {err}")
                })
            {
                match &mut project_meta.inner {
                    RecordingMetaInner::Studio(meta) => {
                        if let StudioRecordingMeta::MultipleSegments { inner } = &mut **meta {
                            inner.status = Some(StudioRecordingStatus::Failed { error });
                        }
                    }
                    RecordingMetaInner::Instant(meta) => {
                        *meta = InstantRecordingMeta::Failed { error };
                    }
                }
                project_meta
                    .save_for_project()
                    .map_err(|err| {
                        error!("Error saving recording meta while finishing recording: {err}")
                    })
                    .ok();
            }

            None
        }
    };

    let _ = RecordingStopped.emit(&handle);

    let _ = app.recording_logging_handle.reload(None);

    if let Some(window) = CapWindowId::RecordingControls.get(&handle) {
        let _ = window.hide();
    }

    if let Some(camera) = CapWindowId::Camera.get(&handle) {
        let _ = camera.hide();
    }

    if let Some(window) = CapWindowId::Main.get(&handle) {
        window.unminimize().ok();
    } else {
        let _ = app.mic_feed.ask(microphone::RemoveInput).await;
        let _ = app.camera_feed.ask(camera::RemoveInput).await;
        app.selected_mic_label = None;
        app.selected_camera_id = None;
    }

    CurrentRecordingChanged.emit(&handle).ok();

    if let Some(res) = res {
        res?;
    }

    Ok(())
}

// runs when a recording successfully finishes
async fn handle_recording_finish(
    app: &AppHandle,
    completed_recording: CompletedRecording,
) -> Result<(), String> {
    let recording_dir = completed_recording.project_path().clone();

    let screenshots_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshots_dir).ok();

    let (meta_inner, sharing) = match completed_recording {
        CompletedRecording::Studio { recording, .. } => {
            let meta_inner = RecordingMetaInner::Studio(Box::new(recording.meta.clone()));

            if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
                error!("Failed to load recording meta while saving finished recording: {err}")
            }) {
                meta.inner = meta_inner.clone();
                meta.sharing = None;
                meta.save_for_project()
                    .map_err(|e| format!("Failed to save recording meta: {e}"))?;
            }

            let needs_remux = needs_fragment_remux(&recording_dir, &recording.meta);

            if needs_remux {
                info!("Recording has fragments that need remuxing - opening editor immediately");

                let finalizing_state = app.state::<FinalizingRecordings>();
                finalizing_state.start_finalizing(recording_dir.clone());

                let post_behaviour = GeneralSettingsStore::get(app)
                    .ok()
                    .flatten()
                    .map(|v| v.post_studio_recording_behaviour)
                    .unwrap_or(PostStudioRecordingBehaviour::OpenEditor);

                match post_behaviour {
                    PostStudioRecordingBehaviour::OpenEditor => {
                        let _ = ShowCapWindow::Editor {
                            project_path: recording_dir.clone(),
                        }
                        .show(app)
                        .await;
                    }
                    PostStudioRecordingBehaviour::ShowOverlay => {
                        let _ = ShowCapWindow::RecordingsOverlay.show(app).await;

                        let app_clone = AppHandle::clone(app);
                        let recording_dir_clone = recording_dir.clone();
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(1000)).await;
                            let _ = NewStudioRecordingAdded {
                                path: recording_dir_clone,
                            }
                            .emit(&app_clone);
                        });
                    }
                }

                AppSounds::StopRecording.play();

                let app = app.clone();
                let recording_dir_for_finalize = recording_dir.clone();
                let screenshots_dir = screenshots_dir.clone();
                let default_preset = PresetsStore::get_default_preset(&app)
                    .ok()
                    .flatten()
                    .map(|p| p.config);

                tokio::spawn(async move {
                    let result = finalize_studio_recording(
                        &app,
                        recording_dir_for_finalize.clone(),
                        screenshots_dir,
                        recording,
                        default_preset,
                    )
                    .await;

                    if let Err(e) = result {
                        error!("Failed to finalize recording: {e}");
                    }

                    app.state::<FinalizingRecordings>()
                        .finish_finalizing(&recording_dir_for_finalize);
                });

                return Ok(());
            }

            let updated_studio_meta = recording.meta.clone();

            let display_output_path = match &updated_studio_meta {
                StudioRecordingMeta::SingleSegment { segment } => {
                    segment.display.path.to_path(&recording_dir)
                }
                StudioRecordingMeta::MultipleSegments { inner, .. } => {
                    inner.segments[0].display.path.to_path(&recording_dir)
                }
            };

            let display_screenshot = screenshots_dir.join("display.jpg");
            tokio::spawn(create_screenshot(
                display_output_path,
                display_screenshot.clone(),
                None,
            ));

            let recordings = ProjectRecordingsMeta::new(&recording_dir, &updated_studio_meta)?;

            let config = project_config_from_recording(
                app,
                &cap_recording::studio_recording::CompletedRecording {
                    project_path: recording.project_path,
                    meta: updated_studio_meta.clone(),
                    cursor_data: recording.cursor_data,
                },
                &recordings,
                PresetsStore::get_default_preset(app)?.map(|p| p.config),
            );

            config.write(&recording_dir).map_err(|e| e.to_string())?;

            (
                RecordingMetaInner::Studio(Box::new(updated_studio_meta)),
                None,
            )
        }
        CompletedRecording::Instant {
            recording,
            progressive_upload,
            video_upload_info,
            ..
        } => {
            let app = app.clone();
            let output_path = recording_dir.join("content/output.mp4");

            let display_screenshot = screenshots_dir.join("display.jpg");
            let screenshot_task = tokio::spawn(create_screenshot(
                output_path.clone(),
                display_screenshot.clone(),
                None,
            ));

            let _ = open_external_link(app.clone(), video_upload_info.link.clone());

            spawn_actor({
                let video_upload_info = video_upload_info.clone();
                let recording_dir = recording_dir.clone();

                async move {
                    let video_upload_succeeded = match progressive_upload
                        .handle
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|r| r.map_err(|v| v.to_string()))
                    {
                        Ok(()) => {
                            info!(
                                "Not attempting instant recording upload as progressive upload succeeded"
                            );
                            true
                        }
                        Err(e) => {
                            error!("Progressive upload failed: {}", e);
                            false
                        }
                    };

                    let _ = screenshot_task.await;

                    if video_upload_succeeded {
                        if let Ok(bytes) =
                            compress_image(display_screenshot).await
                            .map_err(|err|
                                error!("Error compressing thumbnail for instant mode progressive upload: {err}")
                            ) {
                                let res = crate::upload::singlepart_uploader(
                                    app.clone(),
                                    crate::api::PresignedS3PutRequest {
                                        video_id: video_upload_info.id.clone(),
                                        subpath: "screenshot/screen-capture.jpg".to_string(),
                                        method: PresignedS3PutRequestMethod::Put,
                                        meta: None,
                                    },
                                    bytes.len() as u64,
                                    stream::once(async move { Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)) }),
                                )
                                .await;
                                if let Err(err) = res {
	                                error!("Error updating thumbnail for instant mode progressive upload: {err}");
	                                return;
                                }

                                if GeneralSettingsStore::get(&app).ok().flatten().unwrap_or_default().delete_instant_recordings_after_upload && let Err(err) = tokio::fs::remove_dir_all(&recording_dir).await {
	                                	error!("Failed to remove recording files after upload: {err:?}");
	                                }

                            }
                    } else {
                        let meta = match build_video_meta(&output_path) {
                            Ok(m) => Some(m),
                            Err(err) => {
                                error!("Error getting video metadata: {err}");
                                warn!(
                                    "Attempting to repair corrupt recording before fallback upload"
                                );
                                match crate::upload::try_repair_corrupt_mp4(&output_path) {
                                    Ok(()) => {
                                        info!("Repair succeeded, retrying metadata extraction");
                                        build_video_meta(&output_path)
                                            .map_err(|e| {
                                                error!("Still unreadable after repair: {e}")
                                            })
                                            .ok()
                                    }
                                    Err(e) => {
                                        error!("Repair failed: {e}");
                                        None
                                    }
                                }
                            }
                        };

                        if let Some(meta) = meta {
                            upload_video(
                                &app,
                                video_upload_info.id.clone(),
                                output_path,
                                display_screenshot.clone(),
                                meta,
                                None,
                            )
                            .await
                            .map(|_| {
                                info!("Final video upload with screenshot completed successfully")
                            })
                            .map_err(|error| {
                                error!("Error in upload_video: {error}");

                                if let Ok(mut meta) =
                                    RecordingMeta::load_for_project(&recording_dir)
                                {
                                    meta.upload = Some(UploadMeta::Failed {
                                        error: error.to_string(),
                                    });
                                    meta.save_for_project()
                                        .map_err(|e| format!("Failed to save recording meta: {e}"))
                                        .ok();
                                }
                            })
                            .ok();
                        } else {
                            crate::upload::emit_upload_complete(&app, &video_upload_info.id);
                        }
                    }
                }
            });

            (
                RecordingMetaInner::Instant(recording.meta),
                Some(SharingMeta {
                    link: video_upload_info.link,
                    id: video_upload_info.id,
                }),
            )
        }
    };

    if let RecordingMetaInner::Instant(_) = &meta_inner
        && let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            error!("Failed to load recording meta while saving finished recording: {err}")
        })
    {
        meta.inner = meta_inner.clone();
        meta.sharing = sharing;
        meta.save_for_project()
            .map_err(|e| format!("Failed to save recording meta: {e}"))?;
    }

    if let RecordingMetaInner::Studio(_) = meta_inner {
        match GeneralSettingsStore::get(app)
            .ok()
            .flatten()
            .map(|v| v.post_studio_recording_behaviour)
            .unwrap_or(PostStudioRecordingBehaviour::OpenEditor)
        {
            PostStudioRecordingBehaviour::OpenEditor => {
                let _ = ShowCapWindow::Editor {
                    project_path: recording_dir,
                }
                .show(app)
                .await;
            }
            PostStudioRecordingBehaviour::ShowOverlay => {
                let _ = ShowCapWindow::RecordingsOverlay.show(app).await;

                let app = AppHandle::clone(app);
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1000)).await;

                    let _ = NewStudioRecordingAdded {
                        path: recording_dir.clone(),
                    }
                    .emit(&app);
                });
            }
        };
    }

    // Play sound to indicate recording has stopped
    AppSounds::StopRecording.play();

    Ok(())
}

async fn finalize_studio_recording(
    app: &AppHandle,
    recording_dir: PathBuf,
    screenshots_dir: PathBuf,
    recording: cap_recording::studio_recording::CompletedRecording,
    default_preset: Option<ProjectConfiguration>,
) -> Result<(), String> {
    info!("Starting background finalization for recording");

    let recording_dir_for_remux = recording_dir.clone();
    let remux_result =
        tokio::task::spawn_blocking(move || remux_fragmented_recording(&recording_dir_for_remux))
            .await
            .map_err(|e| format!("Remux task panicked: {e}"))?;

    if let Err(e) = remux_result {
        error!("Failed to remux fragmented recording: {e}");
        return Err(format!("Failed to remux fragmented recording: {e}"));
    }

    let updated_meta = RecordingMeta::load_for_project(&recording_dir)
        .map_err(|e| format!("Failed to reload recording meta: {e}"))?;
    let updated_studio_meta = updated_meta
        .studio_meta()
        .ok_or_else(|| "Expected studio meta after remux".to_string())?
        .clone();

    let display_output_path = match &updated_studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            segment.display.path.to_path(&recording_dir)
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            inner.segments[0].display.path.to_path(&recording_dir)
        }
    };

    let display_screenshot = screenshots_dir.join("display.jpg");
    tokio::spawn(create_screenshot(
        display_output_path,
        display_screenshot,
        None,
    ));

    let recordings = ProjectRecordingsMeta::new(&recording_dir, &updated_studio_meta)
        .map_err(|e| format!("Failed to create project recordings meta: {e}"))?;

    let config = project_config_from_recording(
        app,
        &cap_recording::studio_recording::CompletedRecording {
            project_path: recording.project_path,
            meta: updated_studio_meta,
            cursor_data: recording.cursor_data,
        },
        &recordings,
        default_preset,
    );

    config
        .write(&recording_dir)
        .map_err(|e| format!("Failed to write project config: {e}"))?;

    info!("Background finalization completed for recording");

    Ok(())
}

/// Core logic for generating zoom segments based on mouse click events.
/// This is an experimental feature that automatically creates zoom effects
/// around user interactions to highlight important moments.
fn generate_zoom_segments_from_clicks_impl(
    mut clicks: Vec<CursorClickEvent>,
    mut moves: Vec<CursorMoveEvent>,
    max_duration: f64,
) -> Vec<ZoomSegment> {
    const STOP_PADDING_SECONDS: f64 = 0.5;
    const CLICK_GROUP_TIME_THRESHOLD_SECS: f64 = 2.5;
    const CLICK_GROUP_SPATIAL_THRESHOLD: f64 = 0.15;
    const CLICK_PRE_PADDING: f64 = 0.4;
    const CLICK_POST_PADDING: f64 = 1.8;
    const MOVEMENT_PRE_PADDING: f64 = 0.3;
    const MOVEMENT_POST_PADDING: f64 = 1.5;
    const MERGE_GAP_THRESHOLD: f64 = 0.8;
    const MIN_SEGMENT_DURATION: f64 = 1.0;
    const MOVEMENT_WINDOW_SECONDS: f64 = 1.5;
    const MOVEMENT_EVENT_DISTANCE_THRESHOLD: f64 = 0.02;
    const MOVEMENT_WINDOW_DISTANCE_THRESHOLD: f64 = 0.08;
    const AUTO_ZOOM_AMOUNT: f64 = 1.5;
    const SHAKE_FILTER_THRESHOLD: f64 = 0.33;
    const SHAKE_FILTER_WINDOW_MS: f64 = 150.0;

    if max_duration <= 0.0 {
        return Vec::new();
    }

    let activity_end_limit = if max_duration > STOP_PADDING_SECONDS {
        max_duration - STOP_PADDING_SECONDS
    } else {
        max_duration
    };

    if activity_end_limit <= f64::EPSILON {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    moves.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    while let Some(index) = clicks.iter().rposition(|c| c.down) {
        let time_secs = clicks[index].time_ms / 1000.0;
        if time_secs > activity_end_limit {
            clicks.remove(index);
        } else {
            break;
        }
    }

    let click_positions: HashMap<usize, (f64, f64)> = clicks
        .iter()
        .enumerate()
        .filter(|(_, c)| c.down)
        .filter_map(|(idx, click)| {
            let click_time = click.time_ms;
            moves
                .iter()
                .rfind(|m| m.time_ms <= click_time)
                .map(|m| (idx, (m.x, m.y)))
        })
        .collect();

    let mut click_groups: Vec<Vec<usize>> = Vec::new();
    let down_clicks: Vec<(usize, &CursorClickEvent)> = clicks
        .iter()
        .enumerate()
        .filter(|(_, c)| c.down && c.time_ms / 1000.0 < activity_end_limit)
        .collect();

    for (idx, click) in &down_clicks {
        let click_time = click.time_ms / 1000.0;
        let click_pos = click_positions.get(idx);

        let mut found_group = false;
        for group in click_groups.iter_mut() {
            let can_join = group.iter().any(|&group_idx| {
                let group_click = &clicks[group_idx];
                let group_time = group_click.time_ms / 1000.0;
                let time_close = (click_time - group_time).abs() < CLICK_GROUP_TIME_THRESHOLD_SECS;

                let spatial_close = match (click_pos, click_positions.get(&group_idx)) {
                    (Some((x1, y1)), Some((x2, y2))) => {
                        let dx = x1 - x2;
                        let dy = y1 - y2;
                        (dx * dx + dy * dy).sqrt() < CLICK_GROUP_SPATIAL_THRESHOLD
                    }
                    _ => true,
                };

                time_close && spatial_close
            });

            if can_join {
                group.push(*idx);
                found_group = true;
                break;
            }
        }

        if !found_group {
            click_groups.push(vec![*idx]);
        }
    }

    let mut intervals: Vec<(f64, f64)> = Vec::new();

    for group in click_groups {
        if group.is_empty() {
            continue;
        }

        let times: Vec<f64> = group
            .iter()
            .map(|&idx| clicks[idx].time_ms / 1000.0)
            .collect();
        let group_start = times.iter().cloned().fold(f64::INFINITY, f64::min);
        let group_end = times.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        let start = (group_start - CLICK_PRE_PADDING).max(0.0);
        let end = (group_end + CLICK_POST_PADDING).min(activity_end_limit);

        if end > start {
            intervals.push((start, end));
        }
    }

    let mut last_move_by_cursor: HashMap<String, (f64, f64, f64)> = HashMap::new();
    let mut distance_window: VecDeque<(f64, f64)> = VecDeque::new();
    let mut window_distance = 0.0_f64;
    let mut shake_window: VecDeque<(f64, f64, f64)> = VecDeque::new();

    for mv in moves.iter() {
        let time = mv.time_ms / 1000.0;
        if time >= activity_end_limit {
            break;
        }

        let distance = if let Some((_, last_x, last_y)) = last_move_by_cursor.get(&mv.cursor_id) {
            let dx = mv.x - last_x;
            let dy = mv.y - last_y;
            (dx * dx + dy * dy).sqrt()
        } else {
            0.0
        };

        last_move_by_cursor.insert(mv.cursor_id.clone(), (time, mv.x, mv.y));

        if distance <= f64::EPSILON {
            continue;
        }

        shake_window.push_back((mv.time_ms, mv.x, mv.y));
        while let Some(&(old_time, _, _)) = shake_window.front() {
            if mv.time_ms - old_time > SHAKE_FILTER_WINDOW_MS {
                shake_window.pop_front();
            } else {
                break;
            }
        }

        if shake_window.len() >= 3 {
            let positions: Vec<(f64, f64)> =
                shake_window.iter().map(|(_, x, y)| (*x, *y)).collect();
            let mut direction_changes = 0;
            for i in 1..positions.len() - 1 {
                let dx1 = positions[i].0 - positions[i - 1].0;
                let dy1 = positions[i].1 - positions[i - 1].1;
                let dx2 = positions[i + 1].0 - positions[i].0;
                let dy2 = positions[i + 1].1 - positions[i].1;

                if (dx1 * dx2 + dy1 * dy2) < 0.0 {
                    direction_changes += 1;
                }
            }

            let total_dist: f64 = positions
                .windows(2)
                .map(|w| ((w[1].0 - w[0].0).powi(2) + (w[1].1 - w[0].1).powi(2)).sqrt())
                .sum();

            if direction_changes >= 2 && total_dist < SHAKE_FILTER_THRESHOLD * 3.0 {
                continue;
            }
        }

        distance_window.push_back((time, distance));
        window_distance += distance;

        while let Some(&(old_time, old_distance)) = distance_window.front() {
            if time - old_time > MOVEMENT_WINDOW_SECONDS {
                distance_window.pop_front();
                window_distance -= old_distance;
            } else {
                break;
            }
        }

        if window_distance < 0.0 {
            window_distance = 0.0;
        }

        let significant_movement = distance >= MOVEMENT_EVENT_DISTANCE_THRESHOLD
            || window_distance >= MOVEMENT_WINDOW_DISTANCE_THRESHOLD;

        if !significant_movement {
            continue;
        }

        let start = (time - MOVEMENT_PRE_PADDING).max(0.0);
        let end = (time + MOVEMENT_POST_PADDING).min(activity_end_limit);

        if end > start {
            intervals.push((start, end));
        }
    }

    if intervals.is_empty() {
        return Vec::new();
    }

    intervals.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut merged: Vec<(f64, f64)> = Vec::new();
    for interval in intervals {
        if let Some(last) = merged.last_mut()
            && interval.0 <= last.1 + MERGE_GAP_THRESHOLD
        {
            last.1 = last.1.max(interval.1);
            continue;
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .filter_map(|(start, end)| {
            let duration = end - start;
            if duration < MIN_SEGMENT_DURATION {
                return None;
            }

            Some(ZoomSegment {
                start,
                end,
                amount: AUTO_ZOOM_AMOUNT,
                mode: ZoomMode::Auto,
                glide_direction: GlideDirection::None,
                glide_speed: 0.5,
                instant_animation: false,
                edge_snap_ratio: 0.25,
            })
        })
        .collect()
}

/// Generates zoom segments based on mouse click events during recording.
/// Used during the recording completion process.
pub fn generate_zoom_segments_from_clicks(
    recording: &studio_recording::CompletedRecording,
    recordings: &ProjectRecordingsMeta,
) -> Vec<ZoomSegment> {
    // Build a temporary RecordingMeta so we can use the common implementation
    let recording_meta = RecordingMeta {
        platform: None,
        project_path: recording.project_path.clone(),
        pretty_name: String::new(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(recording.meta.clone())),
        upload: None,
    };

    generate_zoom_segments_for_project(&recording_meta, recordings)
}

/// Generates zoom segments from clicks for an existing project.
/// Used in the editor context where we have RecordingMeta.
pub fn generate_zoom_segments_for_project(
    recording_meta: &RecordingMeta,
    recordings: &ProjectRecordingsMeta,
) -> Vec<ZoomSegment> {
    let RecordingMetaInner::Studio(studio_meta) = &recording_meta.inner else {
        return Vec::new();
    };

    let mut all_clicks = Vec::new();
    let mut all_moves = Vec::new();

    match &**studio_meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            if let Some(cursor_path) = &segment.cursor {
                let mut events = CursorEvents::load_from_file(&recording_meta.path(cursor_path))
                    .unwrap_or_default();
                let pointer_ids = studio_meta.pointer_cursor_ids();
                let pointer_ids_ref = (!pointer_ids.is_empty()).then_some(&pointer_ids);
                events.stabilize_short_lived_cursor_shapes(
                    pointer_ids_ref,
                    SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
                );
                all_clicks = events.clicks;
                all_moves = events.moves;
            }
        }
        StudioRecordingMeta::MultipleSegments { inner, .. } => {
            for segment in inner.segments.iter() {
                let events = segment.cursor_events(recording_meta);
                all_clicks.extend(events.clicks);
                all_moves.extend(events.moves);
            }
        }
    }

    generate_zoom_segments_from_clicks_impl(all_clicks, all_moves, recordings.duration())
}

fn project_config_from_recording(
    app: &AppHandle,
    completed_recording: &studio_recording::CompletedRecording,
    recordings: &ProjectRecordingsMeta,
    default_config: Option<ProjectConfiguration>,
) -> ProjectConfiguration {
    let settings = GeneralSettingsStore::get(app)
        .unwrap_or(None)
        .unwrap_or_default();

    let mut config = default_config.unwrap_or_default();

    let camera_preview_manager = CameraPreviewManager::new(app);
    if let Ok(camera_preview_state) = camera_preview_manager.get_state() {
        match camera_preview_state.shape {
            CameraPreviewShape::Round => {
                config.camera.shape = CameraShape::Square;
                config.camera.rounding = 100.0;
            }
            CameraPreviewShape::Square => {
                config.camera.shape = CameraShape::Square;
                config.camera.rounding = 25.0;
            }
            CameraPreviewShape::Full => {
                config.camera.shape = CameraShape::Source;
                config.camera.rounding = 25.0;
            }
        }
    }

    let timeline_segments = recordings
        .segments
        .iter()
        .enumerate()
        .map(|(i, segment)| TimelineSegment {
            recording_clip: i as u32,
            start: 0.0,
            end: segment.duration(),
            timescale: 1.0,
        })
        .collect::<Vec<_>>();

    let zoom_segments = if settings.auto_zoom_on_clicks {
        generate_zoom_segments_from_clicks(completed_recording, recordings)
    } else {
        Vec::new()
    };

    if !zoom_segments.is_empty() {
        config.cursor.size = 200;
    }

    config.timeline = Some(TimelineConfiguration {
        segments: timeline_segments,
        zoom_segments,
        scene_segments: Vec::new(),
        mask_segments: Vec::new(),
        text_segments: Vec::new(),
    });

    config
}

pub fn needs_fragment_remux(recording_dir: &Path, meta: &StudioRecordingMeta) -> bool {
    let StudioRecordingMeta::MultipleSegments { inner, .. } = meta else {
        return false;
    };

    for segment in &inner.segments {
        let display_path = segment.display.path.to_path(recording_dir);
        if display_path.is_dir() {
            return true;
        }
    }

    false
}

pub fn remux_fragmented_recording(recording_dir: &Path) -> Result<(), String> {
    let incomplete_recording = RecoveryManager::find_incomplete_single(recording_dir);

    if let Some(recording) = incomplete_recording {
        RecoveryManager::recover(&recording)
            .map_err(|e| format!("Failed to remux recording: {e}"))?;
        info!("Successfully remuxed fragmented recording");
        Ok(())
    } else {
        Err("Could not find fragments to remux".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click_event(time_ms: f64) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 0,
            cursor_id: "default".to_string(),
            time_ms,
            down: true,
        }
    }

    fn move_event(time_ms: f64, x: f64, y: f64) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: "default".to_string(),
            time_ms,
            x,
            y,
        }
    }

    #[test]
    fn skips_trailing_stop_click() {
        let segments =
            generate_zoom_segments_from_clicks_impl(vec![click_event(11_900.0)], vec![], 12.0);

        assert!(
            segments.is_empty(),
            "expected trailing stop click to be ignored"
        );
    }

    #[test]
    fn generates_segment_for_sustained_activity() {
        let clicks = vec![click_event(1_200.0), click_event(4_200.0)];
        let moves = vec![
            move_event(1_500.0, 0.10, 0.12),
            move_event(1_720.0, 0.42, 0.45),
            move_event(1_940.0, 0.74, 0.78),
        ];

        let segments = generate_zoom_segments_from_clicks_impl(clicks, moves, 20.0);

        assert!(
            !segments.is_empty(),
            "expected activity to produce zoom segments"
        );
        let first = &segments[0];
        assert!(first.start < first.end);
        assert!(first.end - first.start >= 1.3);
        assert!(first.end <= 19.5);
    }

    #[test]
    fn ignores_cursor_jitter() {
        let jitter_moves = (0..30)
            .map(|i| {
                let t = 1_000.0 + (i as f64) * 30.0;
                let delta = (i as f64) * 0.0004;
                move_event(t, 0.5 + delta, 0.5)
            })
            .collect::<Vec<_>>();

        let segments = generate_zoom_segments_from_clicks_impl(Vec::new(), jitter_moves, 15.0);

        assert!(
            segments.is_empty(),
            "small jitter should not generate segments"
        );
    }
}
