use anyhow::anyhow;
use cap_fail::fail;
use cap_media_info::ffmpeg_sample_format_for;
use cap_project::CursorMoveEvent;
use cap_project::cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS;
use cap_project::{
    CameraShape, CursorClickEvent, GlideDirection, InstantRecordingMeta, MultipleSegments,
    Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner, SharingMeta,
    StudioRecordingMeta, StudioRecordingStatus, TimelineConfiguration, TimelineSegment, ZoomMode,
    ZoomSegment, cursor::CursorEvents,
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
use cpal::traits::DeviceTrait;
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
    collections::BTreeSet,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, Manager, path::BaseDirectory};
use tauri_plugin_dialog::{DialogExt, MessageDialogBuilder};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_specta::Event;
use tracing::*;

use crate::camera::{CameraPreviewManager, CameraPreviewShape};
#[cfg(target_os = "macos")]
use crate::general_settings;
use crate::permissions;
use crate::web_api::AuthedApiError;
#[cfg(target_os = "macos")]
use crate::window_exclusion::WindowExclusion;
use crate::{
    App, CameraWindowOperationLock, CurrentRecordingChanged, EditorRecordingAdded,
    FinalizingRecordings, MutableState, NewStudioRecordingAdded, RecordingStarted, RecordingState,
    RecordingStopped, VideoUploadInfo,
    api::PresignedS3PutRequestMethod,
    audio::AppSounds,
    auth::AuthStore,
    create_screenshot, create_screenshot_source_from_segments,
    general_settings::{GeneralSettingsStore, PostDeletionBehaviour, PostStudioRecordingBehaviour},
    open_external_link,
    presets::PresetsStore,
    thumbnails::*,
    upload::{InstantMultipartUpload, SegmentUploader, compress_image},
    web_api::ManagerExt,
    windows::{
        CapWindowId, EditorRecordingTarget, ShowCapWindow, editor_window_for_path, hide_overlay,
    },
};

fn recording_stopped_share_url(link: &str) -> String {
    if link.contains('?') {
        format!("{link}&recordingStopped=1")
    } else {
        format!("{link}?recordingStopped=1")
    }
}

const CURRENT_DESKTOP_BACKGROUND_BASENAME: &str = "current-desktop-background";
const CURRENT_DESKTOP_BACKGROUND_FILENAME: &str = "current-desktop-background.jpg";
const CURRENT_DESKTOP_BACKGROUND_PENDING_FILENAME: &str = "current-desktop-background.pending.jpg";
const DESKTOP_BACKGROUND_MAX_DIMENSION: u32 = 2560;
const DESKTOP_BACKGROUND_JPEG_QUALITY: u8 = 82;

fn current_desktop_background_snapshot_path(recording_dir: &Path) -> PathBuf {
    recording_dir
        .join("assets")
        .join(CURRENT_DESKTOP_BACKGROUND_FILENAME)
}

fn stored_current_desktop_background_path(recording_dir: &Path) -> Option<String> {
    let path = current_desktop_background_snapshot_path(recording_dir);
    path.exists().then(|| path.to_string_lossy().into_owned())
}

fn pending_current_desktop_background_snapshot_path(recording_dir: &Path) -> PathBuf {
    recording_dir
        .join("assets")
        .join(CURRENT_DESKTOP_BACKGROUND_PENDING_FILENAME)
}

fn spawn_current_desktop_background_snapshot(
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
) {
    if matches!(capture_target, ScreenCaptureTarget::CameraOnly) {
        return;
    }

    tokio::spawn(async move {
        match store_current_desktop_background_snapshot(recording_dir, capture_target).await {
            Ok(CurrentDesktopBackgroundSnapshot::Stored(path)) => debug!(
                path = %path.display(),
                "Stored current desktop background for recording"
            ),
            Ok(CurrentDesktopBackgroundSnapshot::SkippedProtectedLocation(path)) => debug!(
                path = %path.display(),
                "Skipped current desktop background from protected location"
            ),
            Err(reason) => debug!(
                %reason,
                "Current desktop background snapshot unavailable"
            ),
        }
    });
}

enum CurrentDesktopBackgroundSnapshot {
    Stored(PathBuf),
    SkippedProtectedLocation(PathBuf),
}

enum CurrentDesktopBackgroundWrite {
    Stored,
    SkippedProtectedLocation(PathBuf),
}

async fn store_current_desktop_background_snapshot(
    recording_dir: PathBuf,
    capture_target: ScreenCaptureTarget,
) -> Result<CurrentDesktopBackgroundSnapshot, String> {
    let display_id = capture_target
        .display()
        .map(|display| display.id().to_string());

    tokio::task::spawn_blocking(move || {
        let output_path = current_desktop_background_snapshot_path(&recording_dir);
        let pending_path = pending_current_desktop_background_snapshot_path(&recording_dir);
        write_current_desktop_background_to(
            &output_path,
            &pending_path,
            display_id.as_deref(),
            true,
        )
        .map(|result| match result {
            CurrentDesktopBackgroundWrite::Stored => {
                CurrentDesktopBackgroundSnapshot::Stored(output_path)
            }
            CurrentDesktopBackgroundWrite::SkippedProtectedLocation(path) => {
                CurrentDesktopBackgroundSnapshot::SkippedProtectedLocation(path)
            }
        })
    })
    .await
    .map_err(|err| format!("Desktop background snapshot task failed: {err}"))?
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn import_current_desktop_background(project_path: String) -> Result<String, String> {
    let project_dir = PathBuf::from(project_path);

    tokio::task::spawn_blocking(move || {
        let assets_dir = project_dir.join("assets");
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or(0);
        let output_name = format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-{timestamp}.jpg");
        let output_path = assets_dir.join(&output_name);
        let pending_path = assets_dir.join(format!(
            "{CURRENT_DESKTOP_BACKGROUND_BASENAME}-{timestamp}.pending.jpg"
        ));

        if !matches!(
            write_current_desktop_background_to(&output_path, &pending_path, None, false)?,
            CurrentDesktopBackgroundWrite::Stored
        ) {
            return Err("Current desktop background snapshot was skipped".to_string());
        }
        remove_imported_desktop_background_snapshots(&assets_dir, &output_name);

        Ok(output_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| format!("Desktop background snapshot task failed: {err}"))?
}

fn remove_imported_desktop_background_snapshots(assets_dir: &Path, keep_name: &str) {
    let Ok(entries) = std::fs::read_dir(assets_dir) else {
        return;
    };

    let prefix = format!("{CURRENT_DESKTOP_BACKGROUND_BASENAME}-");
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str()
            && name != keep_name
            && name.starts_with(prefix.as_str())
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn write_current_desktop_background_to(
    output_path: &Path,
    pending_path: &Path,
    display_id: Option<&str>,
    enforce_protected_check: bool,
) -> Result<CurrentDesktopBackgroundWrite, String> {
    let source_path = current_desktop_background_source_path(display_id)
        .ok_or_else(|| "Current desktop background path not found".to_string())?;

    if enforce_protected_check && desktop_background_source_requires_user_prompt(&source_path) {
        return Ok(CurrentDesktopBackgroundWrite::SkippedProtectedLocation(
            source_path,
        ));
    }

    if !source_path.exists() {
        return Err(format!(
            "Current desktop background does not exist: {}",
            source_path.display()
        ));
    }

    if let Some(parent) = output_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Failed to create background assets directory: {err}"))?;
    }

    let _ = std::fs::remove_file(pending_path);
    if let Err(error) = write_desktop_background_snapshot(&source_path, pending_path) {
        let _ = std::fs::remove_file(pending_path);
        return Err(error);
    }

    if output_path.exists() {
        std::fs::remove_file(output_path)
            .map_err(|err| format!("Failed to replace current desktop background: {err}"))?;
    }

    std::fs::rename(pending_path, output_path)
        .map_err(|err| format!("Failed to store current desktop background: {err}"))?;

    Ok(CurrentDesktopBackgroundWrite::Stored)
}

#[cfg(target_os = "macos")]
fn current_desktop_background_source_path(display_id: Option<&str>) -> Option<PathBuf> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    unsafe {
        let screen =
            macos_screen_for_display_id(display_id).unwrap_or_else(|| NSScreen::mainScreen(nil));
        if screen == nil {
            return None;
        }

        let workspace: id = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace == nil {
            return None;
        }

        let url: id = msg_send![workspace, desktopImageURLForScreen: screen];
        if url == nil {
            return None;
        }

        let path: id = msg_send![url, path];
        if path == nil {
            return None;
        }

        let path = CStr::from_ptr(NSString::UTF8String(path))
            .to_string_lossy()
            .to_string();
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

#[cfg(target_os = "macos")]
fn macos_screen_for_display_id(display_id: Option<&str>) -> Option<cocoa::base::id> {
    use cocoa::appkit::NSScreen;
    use cocoa::base::{id, nil};
    use cocoa::foundation::{NSArray, NSDictionary, NSString};
    use objc::{msg_send, sel, sel_impl};

    let expected_id = display_id?.parse::<u32>().ok()?;

    unsafe {
        let screens = NSScreen::screens(nil);
        if screens == nil {
            return None;
        }

        let screen_number_key = NSString::alloc(nil).init_str("NSScreenNumber");
        for index in 0..NSArray::count(screens) {
            let screen: id = screens.objectAtIndex(index);
            if screen == nil {
                continue;
            }

            let device_description = NSScreen::deviceDescription(screen);
            let number = NSDictionary::valueForKey_(device_description, screen_number_key) as id;
            if number == nil {
                continue;
            }

            let number_value: u32 = msg_send![number, unsignedIntValue];
            if number_value == expected_id {
                return Some(screen);
            }
        }
    }

    None
}

#[cfg(target_os = "windows")]
fn current_desktop_background_source_path(_display_id: Option<&str>) -> Option<PathBuf> {
    use std::{ffi::OsString, os::windows::ffi::OsStringExt};
    use windows::Win32::UI::WindowsAndMessaging::{
        SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SystemParametersInfoW,
    };

    let mut buffer = vec![0u16; 32_768];
    unsafe {
        SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            u32::try_from(buffer.len()).ok()?,
            Some(buffer.as_mut_ptr().cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .ok()?;
    }

    let len = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(buffer.len());
    (len > 0).then(|| PathBuf::from(OsString::from_wide(&buffer[..len])))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn current_desktop_background_source_path(_display_id: Option<&str>) -> Option<PathBuf> {
    None
}

fn desktop_background_source_requires_user_prompt(source_path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().is_some_and(|home_dir| {
            desktop_background_source_requires_user_prompt_for_home(source_path, &home_dir)
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = source_path;
        false
    }
}

#[cfg(any(target_os = "macos", test))]
fn desktop_background_source_requires_user_prompt_for_home(
    source_path: &Path,
    home_dir: &Path,
) -> bool {
    [
        home_dir.join("Desktop"),
        home_dir.join("Documents"),
        home_dir.join("Downloads"),
        home_dir.join("Library/Mobile Documents"),
        home_dir.join("Library/CloudStorage"),
    ]
    .iter()
    .any(|protected_dir| source_path.starts_with(protected_dir))
}

#[cfg(target_os = "macos")]
fn macos_image_pixel_dimensions(path: &Path) -> Option<(u32, u32)> {
    let output = std::process::Command::new("sips")
        .arg("-g")
        .arg("pixelWidth")
        .arg("-g")
        .arg("pixelHeight")
        .arg(path)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut width = None;
    let mut height = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(value) = line.strip_prefix("pixelWidth:") {
            width = value.trim().parse::<u32>().ok();
        } else if let Some(value) = line.strip_prefix("pixelHeight:") {
            height = value.trim().parse::<u32>().ok();
        }
    }

    Some((width?, height?))
}

#[cfg(target_os = "macos")]
fn write_desktop_background_snapshot(source_path: &Path, output_path: &Path) -> Result<(), String> {
    // `sips -Z` resizes in both directions, so it upscales sources smaller than the
    // target. Only cap dimensions when the source actually exceeds the limit.
    let needs_downscale =
        macos_image_pixel_dimensions(source_path).is_none_or(|(width, height)| {
            width > DESKTOP_BACKGROUND_MAX_DIMENSION || height > DESKTOP_BACKGROUND_MAX_DIMENSION
        });

    let mut command = std::process::Command::new("sips");
    command
        .arg("-s")
        .arg("format")
        .arg("jpeg")
        .arg("-s")
        .arg("formatOptions")
        .arg(DESKTOP_BACKGROUND_JPEG_QUALITY.to_string());

    if needs_downscale {
        command
            .arg("-Z")
            .arg(DESKTOP_BACKGROUND_MAX_DIMENSION.to_string());
    }

    let sips_result = command
        .arg(source_path)
        .arg("--out")
        .arg(output_path)
        .output();

    if let Ok(output) = sips_result
        && output.status.success()
    {
        return Ok(());
    }

    write_desktop_background_snapshot_with_image_crate(source_path, output_path)
}

#[cfg(not(target_os = "macos"))]
fn write_desktop_background_snapshot(source_path: &Path, output_path: &Path) -> Result<(), String> {
    write_desktop_background_snapshot_with_image_crate(source_path, output_path)
}

fn write_desktop_background_snapshot_with_image_crate(
    source_path: &Path,
    output_path: &Path,
) -> Result<(), String> {
    use image::ImageEncoder;
    use std::io::Write;

    let image = image::open(source_path)
        .map_err(|err| format!("Failed to decode current desktop background: {err}"))?;

    let image = if image.width() > DESKTOP_BACKGROUND_MAX_DIMENSION
        || image.height() > DESKTOP_BACKGROUND_MAX_DIMENSION
    {
        image.resize(
            DESKTOP_BACKGROUND_MAX_DIMENSION,
            DESKTOP_BACKGROUND_MAX_DIMENSION,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };

    let rgb = image.to_rgb8();
    let file = std::fs::File::create(output_path)
        .map_err(|err| format!("Failed to create current desktop background: {err}"))?;
    let mut writer = std::io::BufWriter::new(file);

    image::codecs::jpeg::JpegEncoder::new_with_quality(
        &mut writer,
        DESKTOP_BACKGROUND_JPEG_QUALITY,
    )
    .write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .map_err(|err| format!("Failed to save current desktop background: {err}"))?;

    writer
        .flush()
        .map_err(|err| format!("Failed to finalize current desktop background: {err}"))
}

pub fn spawn_heal_oversized_desktop_background_snapshots(recording_dir: PathBuf) {
    tokio::task::spawn_blocking(move || {
        heal_oversized_desktop_background_snapshots(&recording_dir);
    });
}

fn heal_oversized_desktop_background_snapshots(recording_dir: &Path) {
    let assets_dir = recording_dir.join("assets");
    let Ok(entries) = std::fs::read_dir(&assets_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if !name.starts_with(CURRENT_DESKTOP_BACKGROUND_BASENAME)
            || name.contains(".pending.")
            || !name.ends_with(".jpg")
        {
            continue;
        }

        match downscale_background_snapshot_in_place(&path) {
            Ok(true) => {
                info!(path = %path.display(), "Recompressed oversized desktop background snapshot")
            }
            Ok(false) => {}
            Err(error) => {
                debug!(%error, path = %path.display(), "Failed to recompress desktop background snapshot")
            }
        }
    }
}

fn downscale_background_snapshot_in_place(path: &Path) -> Result<bool, String> {
    let (width, height) = image::image_dimensions(path)
        .map_err(|err| format!("Failed to read background dimensions: {err}"))?;

    if width <= DESKTOP_BACKGROUND_MAX_DIMENSION && height <= DESKTOP_BACKGROUND_MAX_DIMENSION {
        return Ok(false);
    }

    let pending_path = path.with_extension("pending.jpg");
    let _ = std::fs::remove_file(&pending_path);

    if let Err(error) = write_desktop_background_snapshot_with_image_crate(path, &pending_path) {
        let _ = std::fs::remove_file(&pending_path);
        return Err(error);
    }

    std::fs::rename(&pending_path, path)
        .map_err(|err| format!("Failed to replace desktop background snapshot: {err}"))?;

    Ok(true)
}

#[derive(Clone)]
pub struct InProgressRecordingCommon {
    pub target_name: String,
    pub inputs: StartRecordingInputs,
    pub recording_dir: PathBuf,
    pub health: Arc<crate::recording_telemetry::RecordingHealthAccumulator>,
}

pub struct StopFailureContext {
    pub segment_upload: SegmentUploader,
    pub video_upload_info: VideoUploadInfo,
}

pub enum InProgressRecording {
    Instant {
        handle: instant_recording::ActorHandle,
        segment_upload: SegmentUploader,
        video_upload_info: VideoUploadInfo,
        common: InProgressRecordingCommon,
        mic_feed: Option<Arc<microphone::MicrophoneFeedLock>>,
        camera_feed: Option<Arc<CameraFeedLock>>,
    },
    Studio {
        handle: studio_recording::ActorHandle,
        common: InProgressRecordingCommon,
        mic_feed: Option<Arc<microphone::MicrophoneFeedLock>>,
        camera_feed: Option<Arc<CameraFeedLock>>,
    },
}

#[cfg(target_os = "macos")]
async fn acquire_shareable_content_for_target(
    capture_target: &ScreenCaptureTarget,
) -> anyhow::Result<SendableShareableContent> {
    let mut available_display_ids = Vec::new();

    for attempt in 0..3 {
        let shareable_content = read_recording_shareable_content().await?;
        available_display_ids = shareable_content_display_ids(&shareable_content);
        if !shareable_content_missing_target_display(capture_target, &shareable_content) {
            return Ok(shareable_content);
        }

        if attempt < 2 {
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    }

    let requested_display = capture_target
        .display()
        .map(|display| display.id().to_string())
        .unwrap_or_else(|| "none".to_string());

    Err(anyhow!(
        "ScreenCaptureKit shareable content missing target display {requested_display}. Available display ids: {available_display_ids:?}"
    ))
}

#[cfg(target_os = "macos")]
async fn read_recording_shareable_content() -> anyhow::Result<SendableShareableContent> {
    let content = cidre::sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!(format!("ReadShareableContent: {e}")))?;
    if !content.displays().is_empty() {
        return Ok(SendableShareableContent::from(content));
    }

    let process_content = cidre::sc::ShareableContent::current_process()
        .await
        .map_err(|e| anyhow!(format!("ReadCurrentProcessShareableContent: {e}")))?;
    if !process_content.displays().is_empty() {
        return Ok(SendableShareableContent::from(process_content));
    }

    Ok(SendableShareableContent::from(content))
}

#[cfg(target_os = "macos")]
fn shareable_content_display_ids(shareable_content: &SendableShareableContent) -> Vec<String> {
    shareable_content
        .retained()
        .displays()
        .iter()
        .map(|display| display.display_id().0.to_string())
        .collect()
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

    pub fn common(&self) -> &InProgressRecordingCommon {
        match self {
            Self::Instant { common, .. } => common,
            Self::Studio { common, .. } => common,
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

    pub async fn stop(
        self,
    ) -> Result<CompletedRecording, (anyhow::Error, Option<StopFailureContext>)> {
        match self {
            Self::Instant {
                handle,
                segment_upload,
                video_upload_info,
                common,
                ..
            } => match handle.stop().await {
                Ok(recording) => Ok(CompletedRecording::Instant {
                    recording,
                    segment_upload,
                    video_upload_info,
                    target_name: common.target_name,
                }),
                Err(e) => Err((
                    e,
                    Some(StopFailureContext {
                        segment_upload,
                        video_upload_info,
                    }),
                )),
            },
            Self::Studio { handle, common, .. } => match handle.stop().await {
                Ok(recording) => Ok(CompletedRecording::Studio {
                    recording,
                    target_name: common.target_name,
                    capture_target: common.inputs.capture_target,
                }),
                Err(e) => Err((e, None)),
            },
        }
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
        segment_upload: SegmentUploader,
        video_upload_info: VideoUploadInfo,
    },
    Studio {
        recording: studio_recording::CompletedRecording,
        target_name: String,
        capture_target: ScreenCaptureTarget,
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
    let preferred_rate = 59.0..=60.0;
    let supported_rate = 24.0..=60.0;

    let mut ideal_formats = formats
        .iter()
        .filter(|f| preferred_rate.contains(&f.frame_rate) && f.width <= 1280 && f.height <= 720)
        .collect::<Vec<_>>();

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .iter()
            .filter(|f| preferred_rate.contains(&f.frame_rate) && f.width < 2000 && f.height < 2000)
            .collect();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .iter()
            .filter(|f| {
                supported_rate.contains(&f.frame_rate) && f.width <= 1280 && f.height <= 720
            })
            .collect();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats
            .iter()
            .filter(|f| supported_rate.contains(&f.frame_rate) && f.width < 2000 && f.height < 2000)
            .collect();
    }

    if ideal_formats.is_empty() {
        ideal_formats = formats.iter().collect();
    }

    ideal_formats.sort_by(|a, b| {
        let target_aspect_ratio = 16.0 / 9.0;
        let aspect_ratio_a = a.width as f32 / a.height as f32;
        let aspect_ratio_b = b.width as f32 / b.height as f32;
        let aspect_cmp_a = (aspect_ratio_a - target_aspect_ratio).abs();
        let aspect_cmp_b = (aspect_ratio_b - target_aspect_ratio).abs();
        let resolution_cmp = (a.width * a.height).cmp(&(b.width * b.height));
        let fr_cmp_a = (a.frame_rate - 60.0).abs();
        let fr_cmp_b = (b.frame_rate - 60.0).abs();

        aspect_cmp_a
            .partial_cmp(&aspect_cmp_b)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(resolution_cmp.reverse())
            .then(
                fr_cmp_a
                    .partial_cmp(&fr_cmp_b)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });

    ideal_formats.into_iter().next().cloned()
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
    pub formats: Vec<MicrophoneFormatInfo>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneFormatInfo {
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
        .map(|(name, (device, config))| {
            let formats = microphone_format_infos(&device);
            MicrophoneInfo {
                name,
                sample_rate: config.sample_rate().0,
                channels: config.channels(),
                formats,
            }
        })
}

fn microphone_format_infos(device: &cpal::Device) -> Vec<MicrophoneFormatInfo> {
    let Ok(configs) = device.supported_input_configs() else {
        return vec![];
    };
    let mut formats = BTreeSet::new();

    for config in configs {
        if ffmpeg_sample_format_for(config.sample_format()).is_none() {
            continue;
        }

        for sample_rate in [
            config.min_sample_rate().0,
            44_100,
            48_000,
            96_000,
            config.max_sample_rate().0,
        ] {
            if config.min_sample_rate().0 <= sample_rate
                && sample_rate <= config.max_sample_rate().0
            {
                formats.insert((sample_rate, config.channels()));
            }
        }
    }

    formats
        .into_iter()
        .map(|(sample_rate, channels)| MicrophoneFormatInfo {
            sample_rate,
            channels,
        })
        .collect()
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn list_displays_with_thumbnails() -> Result<Vec<CaptureDisplayWithThumbnail>, String> {
    run_non_send_thumbnail_future(collect_displays_with_thumbnails())
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn list_windows_with_thumbnails() -> Result<Vec<CaptureWindowWithThumbnail>, String> {
    run_non_send_thumbnail_future(collect_windows_with_thumbnails())
}

fn run_non_send_thumbnail_future<T, F>(future: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(|| tauri::async_runtime::block_on(future))
        } else {
            tauri::async_runtime::block_on(future)
        }
    }));

    match result {
        Ok(result) => result,
        Err(panic) => {
            let message = crate::panic_payload_message(&panic);
            error!(panic = %message, "Suppressed panic while collecting capture thumbnails");
            Err(format!("Failed to collect capture thumbnails: {message}"))
        }
    }
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

fn desktop_recording_defaults(
    general_settings: Option<&GeneralSettingsStore>,
) -> cap_recording::RecordingDefaults {
    match general_settings {
        Some(settings) => cap_recording::RecordingDefaults {
            custom_cursor_capture: settings.custom_cursor_capture,
            capture_keyboard_events: settings.capture_keyboard_events,
            crash_recovery_recording: settings.crash_recovery_recording,
            max_fps: settings.max_fps,
            studio_recording_quality: settings.studio_recording_quality.into(),
            out_of_process_muxer: settings.out_of_process_muxer,
            instant_mode_max_resolution: cap_recording::DEFAULT_INSTANT_MODE_MAX_RESOLUTION,
        },
        None => cap_recording::RecordingDefaults::default(),
    }
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
    // Emitted when start_recording aborts before any recording exists. Distinct from
    // `Failed` because the in-progress window treats `Failed` as "the active recording
    // died", which would misreport a healthy recording when a second start is refused.
    StartFailed { error: String },
    InputLost { input: RecordingInputKind },
    InputRestored { input: RecordingInputKind },
    Degraded { reason: String },
    Recovered,
}

/// Every abort path out of `start_recording` must be observable: in the log, and as an
/// event the main window surfaces to the user. The picker overlay that invoked the
/// command is often already closed (or being torn down) when the error comes back, so
/// an error returned to the caller alone can vanish without a trace.
fn notify_recording_start_failed(app: &AppHandle, error: &str) {
    error!(%error, "Recording failed to start");
    let _ = RecordingEvent::StartFailed {
        error: error.to_string(),
    }
    .emit(app);
}

#[derive(Serialize, Type)]
pub enum RecordingAction {
    Started,
    InvalidAuthentication,
    UpgradeRequired,
}

const MICROPHONE_INPUT_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const CAMERA_INPUT_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

fn camera_id_label(id: &camera::DeviceOrModelID) -> String {
    match id {
        camera::DeviceOrModelID::DeviceID(device_id) => device_id.clone(),
        camera::DeviceOrModelID::ModelID(model_id) => format!("{model_id:?}"),
    }
}

fn camera_lock_matches_id(lock: &CameraFeedLock, selected_id: &camera::DeviceOrModelID) -> bool {
    let camera_info = lock.camera_info();
    match selected_id {
        camera::DeviceOrModelID::DeviceID(device_id) => camera_info.device_id() == device_id,
        camera::DeviceOrModelID::ModelID(model_id) => camera_info.model_id() == Some(model_id),
    }
}

async fn initialize_selected_camera(
    camera_feed: &kameo::actor::ActorRef<camera::CameraFeed>,
    id: &camera::DeviceOrModelID,
    settings: Option<camera::CameraDeviceSettings>,
) -> anyhow::Result<()> {
    let label = camera_id_label(id);
    let ready = camera_feed
        .ask(camera::SetInput {
            id: id.clone(),
            settings,
        })
        .await
        .map_err(|err| anyhow!("Failed to initialize selected camera '{label}': {err}"))?;

    ready.await.map(|_| ()).map_err(|err| match err {
        camera::SetInputError::DeviceNotFound => {
            anyhow!("Selected camera '{label}' is no longer available")
        }
        err => anyhow!("Failed to initialize selected camera '{label}': {err}"),
    })
}

async fn lock_initialized_camera(
    camera_feed: &kameo::actor::ActorRef<camera::CameraFeed>,
    id: &camera::DeviceOrModelID,
) -> anyhow::Result<CameraFeedLock> {
    let label = camera_id_label(id);
    match camera_feed.ask(camera::Lock).await {
        Ok(lock) => Ok(lock),
        Err(kameo::error::SendError::HandlerError(camera::LockFeedError::NoInput)) => Err(anyhow!(
            "Selected camera '{label}' did not become ready after initialization"
        )),
        Err(err) => Err(anyhow!("Failed to lock selected camera '{label}': {err}")),
    }
}

#[cfg(not(target_os = "macos"))]
async fn validate_camera_receiving(
    lock: &CameraFeedLock,
    id: &camera::DeviceOrModelID,
) -> anyhow::Result<()> {
    let label = camera_id_label(id);
    let (tx, rx) = flume::bounded(1);
    let remove_sender = tx.clone();

    tokio::time::timeout(CAMERA_INPUT_PROBE_TIMEOUT, lock.ask(camera::AddSender(tx)))
        .await
        .map_err(|_| anyhow!("Timed out attaching selected camera '{label}' probe"))?
        .map_err(|err| anyhow!("Failed to probe selected camera '{label}': {err}"))?;

    let result = tokio::time::timeout(CAMERA_INPUT_PROBE_TIMEOUT, rx.recv_async()).await;
    let _ = tokio::time::timeout(
        CAMERA_INPUT_PROBE_TIMEOUT,
        lock.ask(camera::RemoveSender(remove_sender)),
    )
    .await;

    match result {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(_)) => Err(anyhow!(
            "Selected camera '{label}' stopped before sending a frame"
        )),
        Err(_) => Err(anyhow!(
            "Selected camera '{label}' is not sending video frames"
        )),
    }
}

#[cfg(target_os = "macos")]
async fn validate_camera_receiving(
    lock: &CameraFeedLock,
    id: &camera::DeviceOrModelID,
) -> anyhow::Result<()> {
    let label = camera_id_label(id);
    let (tx, rx) = flume::bounded(1);
    let remove_sender = tx.clone();

    tokio::time::timeout(
        CAMERA_INPUT_PROBE_TIMEOUT,
        lock.ask(camera::AddNativeSender(tx)),
    )
    .await
    .map_err(|_| anyhow!("Timed out attaching selected camera '{label}' probe"))?
    .map_err(|err| anyhow!("Failed to probe selected camera '{label}': {err}"))?;

    let result = tokio::time::timeout(CAMERA_INPUT_PROBE_TIMEOUT, rx.recv_async()).await;
    let _ = tokio::time::timeout(
        CAMERA_INPUT_PROBE_TIMEOUT,
        lock.ask(camera::RemoveNativeSender(remove_sender)),
    )
    .await;

    match result {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(_)) => Err(anyhow!(
            "Selected camera '{label}' stopped before sending a frame"
        )),
        Err(_) => Err(anyhow!(
            "Selected camera '{label}' is not sending video frames"
        )),
    }
}

async fn lock_selected_camera(
    camera_feed: &kameo::actor::ActorRef<camera::CameraFeed>,
    selected_id: Option<camera::DeviceOrModelID>,
    selected_settings: Option<camera::CameraDeviceSettings>,
    capture_target: &ScreenCaptureTarget,
) -> anyhow::Result<Option<Arc<CameraFeedLock>>> {
    let Some(id) = selected_id else {
        if matches!(capture_target, ScreenCaptureTarget::CameraOnly) {
            return Err(anyhow!(
                "Camera-only recording requires a selected camera. Please select a camera before starting."
            ));
        }

        return Ok(None);
    };

    let existing_lock = match camera_feed.ask(camera::Lock).await {
        Ok(lock) if camera_lock_matches_id(&lock, &id) => Some(lock),
        Ok(lock) => {
            drop(lock);
            tokio::time::sleep(Duration::from_millis(50)).await;
            None
        }
        Err(kameo::error::SendError::HandlerError(camera::LockFeedError::NoInput)) => None,
        Err(err) => {
            return Err(anyhow!(
                "Failed to lock selected camera '{}': {err}",
                camera_id_label(&id)
            ));
        }
    };

    let lock = if let Some(lock) = existing_lock {
        lock
    } else {
        initialize_selected_camera(camera_feed, &id, selected_settings).await?;
        lock_initialized_camera(camera_feed, &id).await?
    };

    validate_camera_receiving(&lock, &id).await?;
    Ok(Some(Arc::new(lock)))
}

async fn initialize_selected_microphone(
    mic_feed: &kameo::actor::ActorRef<microphone::MicrophoneFeed>,
    label: &str,
    settings: Option<microphone::MicrophoneDeviceSettings>,
) -> anyhow::Result<()> {
    let ready = mic_feed
        .ask(microphone::SetInput {
            label: label.to_string(),
            settings,
        })
        .await
        .map_err(|err| anyhow!("Failed to initialize selected microphone '{label}': {err}"))?;

    ready.await.map(|_| ()).map_err(|err| match err {
        microphone::SetInputError::DeviceNotFound => {
            anyhow!("Selected microphone '{label}' is no longer available")
        }
        err => anyhow!("Failed to initialize selected microphone '{label}': {err}"),
    })
}

async fn lock_initialized_microphone(
    mic_feed: &kameo::actor::ActorRef<microphone::MicrophoneFeed>,
    label: &str,
) -> anyhow::Result<microphone::MicrophoneFeedLock> {
    match mic_feed.ask(microphone::Lock).await {
        Ok(lock) => Ok(lock),
        Err(kameo::error::SendError::HandlerError(microphone::LockFeedError::NoInput)) => Err(
            anyhow!("Selected microphone '{label}' did not become ready after initialization"),
        ),
        Err(err) => Err(anyhow!(
            "Failed to lock selected microphone '{label}': {err}"
        )),
    }
}

async fn validate_microphone_receiving(
    lock: &microphone::MicrophoneFeedLock,
    label: &str,
) -> anyhow::Result<()> {
    let (tx, rx) = flume::bounded(1);
    let remove_sender = tx.clone();

    lock.ask(microphone::AddSender(tx))
        .await
        .map_err(|err| anyhow!("Failed to probe selected microphone '{label}': {err}"))?;

    let result = tokio::time::timeout(MICROPHONE_INPUT_PROBE_TIMEOUT, rx.recv_async()).await;
    let _ = lock.ask(microphone::RemoveSender(remove_sender)).await;

    match result {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(_)) => Err(anyhow!(
            "Selected microphone '{label}' stopped before sending audio"
        )),
        Err(_) => Err(anyhow!(
            "Selected microphone '{label}' is not sending audio"
        )),
    }
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
    let mut inputs = inputs;

    if EditorRecordingTarget::current(&app).is_some() {
        inputs.mode = RecordingMode::Studio;
    }

    let is_camera_only = matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly);

    if is_camera_only {
        inputs.capture_system_audio = false;
    }

    {
        let mut app_state = state_mtx.write().await;
        if let Err(error) =
            app_state.set_pending_recording(inputs.mode, inputs.capture_target.clone())
        {
            drop(app_state);
            // Deliberately no clear_pending_recording: the pending/active state that
            // caused the refusal belongs to another recording and must survive.
            notify_recording_start_failed(&app, &error);
            return Err(error);
        }
        if is_camera_only {
            app_state.was_camera_only_recording = true;
        }
    }

    macro_rules! pending_try {
        ($expr:expr, $map_err:expr) => {
            match $expr {
                Ok(value) => value,
                Err(err) => {
                    let error = ($map_err)(err);
                    state_mtx.write().await.clear_pending_recording();
                    notify_recording_start_failed(&app, &error);
                    return Err(error);
                }
            }
        };
    }

    if is_camera_only {
        let operation_lock = app.state::<CameraWindowOperationLock>();
        let _operation_guard = operation_lock.lock().await;
        if let Err(err) = (ShowCapWindow::Camera { centered: true }).show(&app).await {
            let error = format!("Failed to show centered camera window: {err}");
            state_mtx.write().await.clear_pending_recording();
            notify_recording_start_failed(&app, &error);
            return Err(error);
        }
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

    let recordings_base_dir = GeneralSettingsStore::recordings_dir(&app);

    pending_try!(ensure_dir(&recordings_base_dir), |e| format!(
        "Failed to create recordings directory: {e}"
    ));

    match cap_utils::disk_space::free_bytes_for_path(&recordings_base_dir) {
        Ok(bytes) => {
            if bytes <= cap_utils::disk_space::LOW_DISK_STOP_BYTES {
                let gb = bytes as f64 / 1_073_741_824.0;
                let error = format!(
                    "Not enough disk space to start recording ({:.2} GB free). Free up at least {} MB and try again.",
                    gb,
                    (cap_utils::disk_space::LOW_DISK_STOP_BYTES / (1024 * 1024))
                );
                error!(
                    bytes_remaining = bytes,
                    "Refusing to start recording: disk full"
                );
                state_mtx.write().await.clear_pending_recording();
                notify_recording_start_failed(&app, &error);
                return Err(error);
            }
            if bytes <= cap_utils::disk_space::LOW_DISK_WARN_BYTES {
                let gb = bytes as f64 / 1_073_741_824.0;
                warn!(
                    bytes_remaining = bytes,
                    available_gb = gb,
                    "Starting recording with low disk space"
                );
            }
        }
        Err(e) => {
            warn!(error = %e, "Failed to check disk space before starting recording");
        }
    }

    let project_file_path = recordings_base_dir.join(&pending_try!(
        cap_utils::ensure_unique_filename(&filename, &recordings_base_dir,),
        |e| e
    ));

    pending_try!(ensure_dir(&project_file_path), |e| format!(
        "Failed to create recording directory: {e}"
    ));
    pending_try!(
        state_mtx
            .write()
            .await
            .add_recording_logging_handle(&project_file_path.join("recording-logs.log"))
            .await,
        |e| e
    );

    if let Some(window) = CapWindowId::Camera.get(&app)
        && let Err(error) = window.set_content_protected(
            matches!(inputs.mode, RecordingMode::Studio)
                && !crate::windows::capture_exclusion_hides_ui(),
        )
    {
        warn!(%error, "Failed to update camera window content protection");
    }

    let (video_upload_info, instant_mode_max_resolution) = match inputs.mode {
        RecordingMode::Instant => {
            let Some(auth) = AuthStore::get(&app).ok().flatten() else {
                let error = "Please sign in to use instant recording".to_string();
                state_mtx.write().await.clear_pending_recording();
                notify_recording_start_failed(&app, &error);
                return Err(error);
            };
            let instant_mode_max_resolution = if auth.is_upgraded() {
                general_settings
                    .map_or(cap_recording::PRO_INSTANT_MODE_MAX_RESOLUTION, |settings| {
                        settings.instant_mode_max_resolution
                    })
            } else {
                cap_recording::FREE_INSTANT_MODE_MAX_RESOLUTION
            };
            let upload_mode = if matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly) {
                "desktopMP4"
            } else {
                "desktopSegments"
            };

            let s3_config = match crate::upload::create_or_get_video_with_mode(
                &app,
                false,
                None,
                Some(project_name.clone()),
                None,
                inputs.organization_id.clone(),
                upload_mode,
            )
            .await
            {
                Ok(meta) => meta,
                Err(AuthedApiError::InvalidAuthentication) => {
                    state_mtx.write().await.clear_pending_recording();
                    // Returned as an action rather than an error, but the picker that
                    // invoked us may already be gone — surface it as a start failure too.
                    notify_recording_start_failed(
                        &app,
                        "Your session has expired. Please sign in again to use instant recording.",
                    );
                    return Ok(RecordingAction::InvalidAuthentication);
                }
                Err(AuthedApiError::UpgradeRequired) => {
                    state_mtx.write().await.clear_pending_recording();
                    notify_recording_start_failed(
                        &app,
                        "Instant recording requires an upgraded plan.",
                    );
                    return Ok(RecordingAction::UpgradeRequired);
                }
                Err(err) => {
                    let error = format!("Could not create the shareable link: {err}");
                    state_mtx.write().await.clear_pending_recording();
                    notify_recording_start_failed(&app, &error);
                    return Err(error);
                }
            };

            let link = app.make_app_url(format!("/s/{}", s3_config.id)).await;
            info!("Pre-created shareable link: {}", link);

            (
                Some(VideoUploadInfo {
                    id: s3_config.id.to_string(),
                    link: link.clone(),
                    config: s3_config,
                }),
                instant_mode_max_resolution,
            )
        }
        RecordingMode::Studio => (None, cap_recording::PRO_INSTANT_MODE_MAX_RESOLUTION),
        RecordingMode::Screenshot => {
            let error = "Use take_screenshot for screenshots".to_string();
            state_mtx.write().await.clear_pending_recording();
            notify_recording_start_failed(&app, &error);
            return Err(error);
        }
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
                state_mtx.write().await.clear_pending_recording();
                return Err("Use take_screenshot for screenshots".to_string());
            }
        },
        sharing: None,
        upload: None,
    };

    pending_try!(meta.save_for_project(), |e| format!(
        "Failed to save recording meta: {e}"
    ));

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

    let countdown = general_settings.and_then(|v| v.recording_countdown);
    crate::target_select_overlay::close_target_select_overlay_windows(&app);
    let _ = ShowCapWindow::InProgressRecording {
        countdown,
        capture_target: Some(inputs.capture_target.clone()),
    }
    .show(&app)
    .await;

    if let Some(window) = CapWindowId::Main.get(&app) {
        let _ = general_settings
            .map(|v| v.main_window_recording_start_behaviour)
            .unwrap_or_default()
            .perform(&window);
    }

    crate::windows::apply_content_protection(&app, true);

    if let Some(editor_target) = EditorRecordingTarget::current(&app)
        && let Some(editor_window) = editor_window_for_path(&app, &editor_target)
    {
        let _ = editor_window.set_content_protected(!crate::windows::capture_exclusion_hides_ui());
        let _ = editor_window.minimize();
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

            let (camera_feed_actor, selected_camera_id, selected_camera_settings) = {
                let state = state_mtx.read().await;
                let selected_camera_settings = state.selected_camera_id.as_ref().and_then(|id| {
                    crate::recording_settings::RecordingSettingsStore::camera_settings_for(
                        &state.handle,
                        id,
                    )
                });
                (
                    state.camera_feed.clone(),
                    state.selected_camera_id.clone(),
                    selected_camera_settings,
                )
            };

            let camera_feed = lock_selected_camera(
                &camera_feed_actor,
                selected_camera_id,
                selected_camera_settings,
                &inputs.capture_target,
            )
            .await?;
            debug!(
                camera_selected = camera_feed.is_some(),
                "Selected camera locked for recording"
            );

            let mut state = state_mtx.write().await;

            state.camera_in_use = camera_feed.is_some();

            #[cfg(target_os = "macos")]
            let mut shareable_content = match inputs.capture_target {
                ScreenCaptureTarget::CameraOnly => None,
                _ => {
                    debug!("Acquiring shareable content for recording target");
                    let content =
                        acquire_shareable_content_for_target(&inputs.capture_target).await?;
                    debug!("Acquired shareable content for recording target");
                    Some(content)
                }
            };

            let health = crate::recording_telemetry::RecordingHealthAccumulator::new();
            let common = InProgressRecordingCommon {
                target_name: project_name,
                inputs: inputs.clone(),
                recording_dir: recording_dir.clone(),
                health,
            };

            #[cfg(target_os = "macos")]
            let excluded_windows = {
                let window_exclusions = general_settings
                    .as_ref()
                    .map_or_else(general_settings::default_excluded_windows, |settings| {
                        settings.excluded_windows.clone()
                    });

                let window_exclusions = if matches!(inputs.mode, RecordingMode::Instant) {
                    let camera_title = CapWindowId::Camera.title();
                    crate::window_exclusion::filter_for_instant_mode(
                        window_exclusions,
                        &camera_title,
                    )
                } else {
                    window_exclusions
                };

                let teleprompter_exclusion = WindowExclusion {
                    bundle_identifier: None,
                    owner_name: None,
                    window_title: Some(CapWindowId::Teleprompter.title()),
                };
                let mut window_exclusions = window_exclusions;
                if !window_exclusions.contains(&teleprompter_exclusion) {
                    window_exclusions.push(teleprompter_exclusion);
                }

                let mut excluded_window_ids =
                    crate::window_exclusion::resolve_window_ids(&window_exclusions);
                crate::window_exclusion::append_matching_webview_window_ids(
                    &mut excluded_window_ids,
                    &app_handle,
                    &window_exclusions,
                );
                info!(
                    configured_exclusions = window_exclusions.len(),
                    resolved_window_ids = excluded_window_ids.len(),
                    "Resolved macOS recording window exclusions"
                );
                excluded_window_ids
            };

            let mut mic_restart_attempts = 0;

            let (done_fut, health_rx) = loop {
                let actor_result: Result<InProgressRecording, anyhow::Error> = async {
                    let selected_mic_label = state.selected_mic_label.clone();
                    let selected_mic_settings = selected_mic_label
                        .as_ref()
                        .and_then(|label| state.microphone_settings_for_label(label));
                    debug!(
                        mic_selected = selected_mic_label.is_some(),
                        "Locking selected microphone for recording"
                    );
                    let mic_feed = lock_selected_microphone(
                        &state.mic_feed,
                        selected_mic_label,
                        selected_mic_settings,
                    )
                    .await?;
                    debug!(
                        mic_selected = mic_feed.is_some(),
                        "Selected microphone locked for recording"
                    );
                    let defaults = desktop_recording_defaults(general_settings.as_ref());

                    match inputs.mode {
                        RecordingMode::Studio => {
                            let mut builder = defaults.apply_to_studio_builder(
                                studio_recording::Actor::builder(
                                    recording_dir.clone(),
                                    inputs.capture_target.clone(),
                                )
                                .with_system_audio(inputs.capture_system_audio),
                                camera_feed.is_some(),
                                None,
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

                            debug!("Building studio recording actor");
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

                            debug!("Studio recording actor built");
                            Ok(InProgressRecording::Studio {
                                handle,
                                common: common.clone(),
                                mic_feed: mic_feed.clone(),
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
                            .with_max_output_size(instant_mode_max_resolution);

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

                            let segment_rx = handle.take_segment_rx();

                            let segment_upload = if let Some(rx) = segment_rx {
                                SegmentUploader::spawn(
                                    app_handle.clone(),
                                    video_upload_info.id.clone(),
                                    rx,
                                    Some(finish_upload_rx.clone()),
                                    recording_dir.clone(),
                                    video_upload_info.clone(),
                                )
                            } else {
                                let progressive_upload = InstantMultipartUpload::spawn(
                                    app_handle.clone(),
                                    recording_dir.join("content/output.mp4"),
                                    video_upload_info.clone(),
                                    recording_dir.clone(),
                                    Some(finish_upload_rx.clone()),
                                );
                                SegmentUploader {
                                    handle: progressive_upload.handle,
                                }
                            };

                            Ok(InProgressRecording::Instant {
                                handle,
                                segment_upload,
                                video_upload_info,
                                common: common.clone(),
                                mic_feed: mic_feed.clone(),
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
                    Err(err)
                        if mic_restart_attempts < 3
                            && (mic_actor_not_running(&err) || mic_feed_locked(&err)) =>
                    {
                        mic_restart_attempts += 1;
                        warn!(
                            attempt = mic_restart_attempts,
                            error = %err,
                            "Recovering microphone feed before retrying recording start"
                        );
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

    if matches!(inputs.mode, RecordingMode::Studio) {
        spawn_current_desktop_background_snapshot(
            project_file_path.clone(),
            inputs.capture_target.clone(),
        );
    }

    let _ = RecordingEvent::Started.emit(&app);
    let _ = RecordingStarted.emit(&app);

    emit_recording_started_telemetry(&app, &state_mtx).await;

    spawn_actor({
        let app = app.clone();
        let state_mtx = Arc::clone(&state_mtx);
        let project_file_path = project_file_path.clone();
        async move {
            fail!("recording::wait_actor_done");
            let disposition = {
                let res = actor_done_fut.await;
                info!("recording wait actor done: {:?}", &res);
                let recording_still_active = matches!(
                    state_mtx.read().await.recording_state,
                    RecordingState::Active(_)
                );
                classify_actor_done_result(res, recording_still_active)
            };
            match disposition {
                ActorDoneDisposition::UserInitiatedStop => {
                    let _ = finish_upload_tx.send(());
                    let _ = RecordingEvent::Stopped.emit(&app);
                }
                ActorDoneDisposition::UnexpectedStop { error }
                | ActorDoneDisposition::Failed { error } => {
                    let mut state = state_mtx.write().await;

                    let _ = RecordingEvent::Failed {
                        error: error.clone(),
                    }
                    .emit(&app);

                    let mut dialog = MessageDialogBuilder::new(
                        app.dialog().clone(),
                        "An error occurred".to_string(),
                        error.clone(),
                    )
                    .kind(tauri_plugin_dialog::MessageDialogKind::Error);

                    if let Some(window) = CapWindowId::RecordingControls.get(&app) {
                        dialog = dialog.parent(&window);
                    }

                    dialog.blocking_show();

                    handle_recording_end(app, Err(error), &mut state, project_file_path)
                        .await
                        .ok();
                }
            }
        }
    });

    if let Some(mut health_rx) = health_rx {
        let accumulator_mode = {
            let state = state_mtx.read().await;
            state
                .current_recording()
                .map(|r| (r.common().health.clone(), r.inputs().mode))
        };

        spawn_actor({
            let app = app.clone();
            async move {
                let mut is_degraded = false;
                while let Some(event) = health_rx.recv().await {
                    if let Some((health, mode)) = accumulator_mode.as_ref()
                        && let Some((reason_text, critical)) = health.record_event(&event)
                    {
                        use crate::posthog::{PostHogEvent, async_capture_event};
                        use crate::recording_telemetry::{CriticalEvent, mode_label};
                        match critical {
                            CriticalEvent::MuxerCrashed {
                                seconds_into_recording,
                                ..
                            } => {
                                async_capture_event(
                                    &app,
                                    PostHogEvent::RecordingMuxerCrashed {
                                        mode: mode_label(*mode),
                                        reason: reason_text,
                                        seconds_into_recording,
                                    },
                                );
                            }
                            CriticalEvent::AudioDegraded {
                                seconds_into_recording,
                                ..
                            } => {
                                async_capture_event(
                                    &app,
                                    PostHogEvent::RecordingAudioDegraded {
                                        mode: mode_label(*mode),
                                        reason: reason_text,
                                        seconds_into_recording,
                                    },
                                );
                            }
                        }
                    }

                    if let Some((_, mode)) = accumulator_mode.as_ref() {
                        use crate::posthog::{PostHogEvent, async_capture_event};
                        use crate::recording_telemetry::mode_label;
                        let mode_str = mode_label(*mode);
                        match &event {
                            cap_recording::PipelineHealthEvent::DiskSpaceLow {
                                bytes_remaining,
                                ..
                            } => async_capture_event(
                                &app,
                                PostHogEvent::RecordingDiskSpaceLow {
                                    mode: mode_str,
                                    bytes_remaining: *bytes_remaining,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::DiskSpaceExhausted {
                                bytes_remaining,
                            } => async_capture_event(
                                &app,
                                PostHogEvent::RecordingDiskSpaceExhausted {
                                    mode: mode_str,
                                    bytes_remaining: *bytes_remaining,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::DeviceLost { subsystem } => {
                                async_capture_event(
                                    &app,
                                    PostHogEvent::RecordingDeviceLost {
                                        mode: mode_str,
                                        subsystem: subsystem.clone(),
                                    },
                                )
                            }
                            cap_recording::PipelineHealthEvent::EncoderRebuilt {
                                backend,
                                attempt,
                            } => async_capture_event(
                                &app,
                                PostHogEvent::RecordingEncoderRebuilt {
                                    mode: mode_str,
                                    backend: backend.clone(),
                                    attempt: *attempt,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::SourceAudioReset {
                                source,
                                starvation_ms,
                            } => async_capture_event(
                                &app,
                                PostHogEvent::RecordingSourceAudioReset {
                                    mode: mode_str,
                                    source: source.clone(),
                                    starvation_ms: *starvation_ms,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::CaptureTargetLost { target } => {
                                async_capture_event(
                                    &app,
                                    PostHogEvent::RecordingCaptureTargetLost {
                                        mode: mode_str,
                                        target: target.clone(),
                                    },
                                )
                            }
                            cap_recording::PipelineHealthEvent::RecoveryFragmentCorrupt {
                                ..
                            } => {}
                            _ => {}
                        }
                    }

                    let reason = match &event {
                        cap_recording::PipelineHealthEvent::FrameDropRateHigh {
                            source,
                            rate_pct,
                        } => Some(format!("High frame drop rate on {source}: {rate_pct:.0}%")),
                        cap_recording::PipelineHealthEvent::AudioGapDetected { gap_ms } => {
                            Some(format!("Audio gap detected: {gap_ms}ms"))
                        }
                        cap_recording::PipelineHealthEvent::SourceRestarting => {
                            Some("Capture source restarting".to_string())
                        }
                        cap_recording::PipelineHealthEvent::AudioDegradedToVideoOnly { reason } => {
                            Some(format!("Audio lost: {reason}"))
                        }
                        cap_recording::PipelineHealthEvent::Stalled { source, waited_ms } => {
                            Some(format!("Pipeline stalled on {source} ({waited_ms}ms)"))
                        }
                        cap_recording::PipelineHealthEvent::MuxerCrashed { reason } => {
                            Some(format!("Muxer crashed: {reason}"))
                        }
                        cap_recording::PipelineHealthEvent::DiskSpaceLow {
                            bytes_remaining,
                            ..
                        } => Some(format!(
                            "Low disk space: {:.2} GB remaining",
                            *bytes_remaining as f64 / 1_073_741_824.0
                        )),
                        cap_recording::PipelineHealthEvent::DiskSpaceExhausted {
                            bytes_remaining,
                        } => Some(format!(
                            "Disk full: {:.2} GB remaining",
                            *bytes_remaining as f64 / 1_073_741_824.0
                        )),
                        cap_recording::PipelineHealthEvent::DeviceLost { subsystem } => {
                            Some(format!("Graphics device lost: {subsystem}"))
                        }
                        cap_recording::PipelineHealthEvent::EncoderRebuilt { backend, attempt } => {
                            Some(format!("Encoder rebuilt: {backend} (attempt {attempt})"))
                        }
                        cap_recording::PipelineHealthEvent::SourceAudioReset {
                            source,
                            starvation_ms,
                        } => Some(format!("Audio source reset: {source} ({starvation_ms}ms)")),
                        cap_recording::PipelineHealthEvent::RecoveryFragmentCorrupt {
                            path,
                            reason,
                        } => Some(format!(
                            "Corrupt recovery fragment skipped: {path} ({reason})"
                        )),
                        cap_recording::PipelineHealthEvent::CaptureTargetLost { target } => {
                            Some(format!("Capture target lost: {target}"))
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
#[instrument(skip(state))]
pub async fn set_mic_recording_muted(
    state: MutableState<'_, App>,
    muted: bool,
) -> Result<(), String> {
    let state = state.read().await;

    let Some(recording) = state.current_recording() else {
        return Err("No recording in progress".to_string());
    };

    let mic_feed = match recording {
        InProgressRecording::Instant { mic_feed, .. } => mic_feed.as_ref(),
        // Studio records the mic as an editable track; muting would silently
        // bake zeros into it. The bar only offers mute for instant mode —
        // enforce the same contract here so no future caller can corrupt a
        // studio track.
        InProgressRecording::Studio { .. } => {
            return Err("Mic mute is only available for instant recordings".to_string());
        }
    };

    let Some(mic_feed) = mic_feed else {
        return Err("Recording has no microphone".to_string());
    };

    mic_feed.set_recording_muted(muted);
    info!(muted, "Recording microphone mute set");
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
    error!(
        recording_dir = %recording_dir.display(),
        error = %message,
        "Recording actor spawn failed"
    );

    let _ = RecordingEvent::Failed {
        error: message.clone(),
    }
    .emit(app);

    // DeviceNotFound errors are surfaced to the user via the frontend toast; skip the
    // blocking native dialog so the overlay stays responsive and the error isn't repeated.
    let is_device_not_found =
        message.contains("no longer available") || message.contains("DeviceNotFound");

    if !is_device_not_found {
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
    }

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

async fn lock_selected_microphone(
    mic_feed: &kameo::actor::ActorRef<microphone::MicrophoneFeed>,
    selected_label: Option<String>,
    selected_settings: Option<microphone::MicrophoneDeviceSettings>,
) -> anyhow::Result<Option<Arc<microphone::MicrophoneFeedLock>>> {
    let Some(label) = selected_label else {
        return Ok(None);
    };

    let existing_lock = match mic_feed.ask(microphone::Lock).await {
        Ok(lock) if lock.device_name() == label => Some(lock),
        Ok(lock) => {
            drop(lock);
            tokio::time::sleep(Duration::from_millis(50)).await;
            None
        }
        Err(kameo::error::SendError::HandlerError(microphone::LockFeedError::NoInput)) => None,
        Err(err) => {
            return Err(anyhow!(
                "Failed to lock selected microphone '{label}': {err}"
            ));
        }
    };

    let lock = if let Some(lock) = existing_lock {
        lock
    } else {
        initialize_selected_microphone(mic_feed, &label, selected_settings).await?;
        lock_initialized_microphone(mic_feed, &label).await?
    };

    validate_microphone_receiving(&lock, &label).await?;
    Ok(Some(Arc::new(lock)))
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

fn mic_feed_locked(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<microphone::FeedLockedError>()
            .is_some()
            || cause
                .downcast_ref::<microphone::LockFeedError>()
                .is_some_and(|err| matches!(err, microphone::LockFeedError::Locked(_)))
            || cause
                .downcast_ref::<microphone::SetInputError>()
                .is_some_and(|err| matches!(err, microphone::SetInputError::Locked(_)))
    }) || err.to_string().contains("FeedLocked")
}

#[derive(Debug, PartialEq, Eq)]
enum ActorDoneDisposition {
    UserInitiatedStop,
    UnexpectedStop { error: String },
    Failed { error: String },
}

fn classify_actor_done_result<E>(
    result: Result<(), E>,
    recording_still_active: bool,
) -> ActorDoneDisposition
where
    E: ToString,
{
    match result {
        Ok(()) if recording_still_active => ActorDoneDisposition::UnexpectedStop {
            error: "Recording stopped unexpectedly before it was ended.".to_string(),
        },
        Ok(()) => ActorDoneDisposition::UserInitiatedStop,
        Err(error) => ActorDoneDisposition::Failed {
            error: error.to_string(),
        },
    }
}

async fn cancel_discarded_recording(
    app: &AppHandle,
    recording: InProgressRecording,
) -> Option<String> {
    match recording {
        InProgressRecording::Instant {
            handle,
            segment_upload,
            video_upload_info,
            ..
        } => {
            let video_id = video_upload_info.id;
            segment_upload.handle.abort();

            if let Err(err) = handle.cancel().await {
                warn!("Failed to cancel instant recording while discarding: {err:#}");
            }

            match segment_upload.handle.await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => warn!("Instant upload ended while discarding recording: {err}"),
                Err(err) if err.is_cancelled() => {}
                Err(err) => {
                    warn!("Failed to join instant upload while discarding recording: {err}")
                }
            }

            crate::upload::emit_upload_complete(app, &video_id);
            Some(video_id)
        }
        InProgressRecording::Studio { handle, .. } => {
            if let Err(err) = handle.cancel().await {
                warn!("Failed to cancel studio recording while discarding: {err:#}");
            }

            None
        }
    }
}

async fn remove_recording_dir(recording_dir: &Path) -> Result<(), String> {
    match tokio::fs::remove_dir_all(recording_dir).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Failed to delete recording files: {err}")),
    }
}

async fn delete_remote_instant_video(app: &AppHandle, video_id: &str) -> Result<(), String> {
    let response = app
        .authed_api_request(
            format!("/api/desktop/video/delete?videoId={video_id}"),
            |client, url| client.delete(url),
        )
        .await
        .map_err(|err| format!("Failed to delete instant recording: {err}"))?;

    let status = response.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        return Ok(());
    }

    let body = response
        .text()
        .await
        .unwrap_or_else(|err| format!("Failed to read response body: {err}"));

    Err(format!(
        "Failed to delete instant recording {video_id}: {status}: {body}"
    ))
}

async fn discard_recording(app: &AppHandle, recording: InProgressRecording) -> Result<(), String> {
    let recording_dir = recording.recording_dir().clone();
    let video_id = cancel_discarded_recording(app, recording).await;
    let local_delete = remove_recording_dir(&recording_dir).await;
    let remote_delete = if let Some(video_id) = video_id {
        delete_remote_instant_video(app, &video_id).await
    } else {
        Ok(())
    };

    remote_delete?;
    local_delete
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    let mut state = state.write().await;
    let recording_pending = matches!(&state.recording_state, RecordingState::Pending { .. });
    let Some(current_recording) = state.clear_current_recording() else {
        if recording_pending {
            debug!("Stop recording requested before recording actor was ready");
            return Err("Recording is still starting".to_string());
        }
        debug!("Stop recording requested without active recording");
        return Ok(());
    };

    let recording_dir = current_recording.recording_dir().clone();
    if let InProgressRecording::Instant {
        video_upload_info, ..
    } = &current_recording
    {
        let _ = open_external_link(
            app.clone(),
            recording_stopped_share_url(&video_upload_info.link),
        );
    }

    let recording_outcome = match current_recording.stop().await {
        Ok(completed) => Ok(completed),
        Err((e, ctx)) => {
            error!("Recording stop failed: {e:#}");
            if let Some(ctx) = ctx {
                ctx.segment_upload.handle.abort();
                crate::upload::emit_upload_complete(&app, &ctx.video_upload_info.id);
            }
            Err(e.to_string())
        }
    };

    handle_recording_end(app, recording_outcome, &mut state, recording_dir).await?;

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
    let recording_dir = recording.recording_dir().clone();

    // Cleanup of the discarded recording must not block or abort the restart:
    // the old recording is already cancelled at this point, and the new one
    // writes to a fresh directory.
    if let Some(video_id) = cancel_discarded_recording(&app, recording).await {
        let app = app.clone();
        tokio::spawn(async move {
            if let Err(err) = delete_remote_instant_video(&app, &video_id).await {
                warn!("Failed to delete remote instant video while restarting: {err}");
            }
        });
    }

    if let Err(err) = remove_recording_dir(&recording_dir).await {
        warn!("Failed to delete recording files while restarting: {err}");
    }

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
        CurrentRecordingChanged.emit(&app).ok();
        RecordingStopped {}.emit(&app).ok();

        if let Some(window) = CapWindowId::RecordingControls.get(&app) {
            let _ = window.hide();
        }

        let delete_result = discard_recording(&app, recording).await;

        let settings = GeneralSettingsStore::get(&app)
            .ok()
            .flatten()
            .unwrap_or_default();

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

        delete_result?;
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

    let mut hid_any = false;
    for (label, window) in app.webview_windows() {
        if let Ok(id) = CapWindowId::from_str(&label)
            && matches!(
                id,
                CapWindowId::TargetSelectOverlay { .. }
                    | CapWindowId::WindowCaptureOccluder { .. }
                    | CapWindowId::CaptureArea
                    | CapWindowId::ModeSelect
                    | CapWindowId::RecordingsOverlay
            )
        {
            hide_overlay(&window);
            hid_any = true;
        }
    }

    if hid_any {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    let automation_target = target.clone();

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

    let mut screenshot_config = cap_project::ProjectConfiguration::default();
    screenshot_config.background.source = cap_project::BackgroundSource::Color {
        value: [255, 255, 255],
        alpha: 0,
    };
    screenshot_config.background.shadow = 0.0;
    screenshot_config
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

                crate::automation::run_screenshot_automations(
                    app_handle.clone(),
                    image_path_for_emit.clone(),
                    &automation_target,
                );

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
    let cleared = app.clear_recording_state();

    if let Some(in_progress) = cleared.as_ref() {
        let mode = in_progress.inputs().mode;
        let (snapshot, duration_secs, mic_feed) = {
            match in_progress {
                InProgressRecording::Instant {
                    common, mic_feed, ..
                }
                | InProgressRecording::Studio {
                    common, mic_feed, ..
                } => (
                    common.health.snapshot(),
                    common.health.seconds_since_start() as u64,
                    mic_feed.clone(),
                ),
            }
        };
        let (status, error_class) = match &recording {
            Ok(_) => ("stopped", None),
            Err(e) => ("failed", Some(classify_error_message(e.as_str()))),
        };
        let drop_rate_pct = 0.0_f64;
        let dropped_mic_messages = match mic_feed {
            Some(feed) => feed.dropped_message_count().await,
            None => 0,
        };
        crate::posthog::async_capture_event(
            &handle,
            crate::posthog::PostHogEvent::RecordingCompleted {
                mode: crate::recording_telemetry::mode_label(mode),
                status,
                duration_secs,
                segment_count: 1,
                track_failure_count: 0,
                error_class,
                video_frames_captured: 0,
                video_frames_dropped: 0,
                drop_rate_pct,
                capture_stalls_count: snapshot.capture_stalls_count,
                capture_stalls_max_ms: snapshot.capture_stalls_max_ms,
                mixer_stalls_count: snapshot.mixer_stalls_count,
                mixer_stalls_max_ms: snapshot.mixer_stalls_max_ms,
                audio_gaps_count: snapshot.audio_gaps_count,
                audio_gaps_total_ms: snapshot.audio_gaps_total_ms,
                frame_drop_rate_high_count: snapshot.frame_drop_rate_high_count,
                source_restarts_count: snapshot.source_restarts_count,
                muxer_crash_count: snapshot.muxer_crash_count,
                audio_degraded_count: snapshot.audio_degraded_count,
                dropped_mic_messages,
            },
        );
    }

    app.disconnected_inputs.clear();
    app.camera_in_use = false;

    if recording.is_err()
        && let Some(InProgressRecording::Instant {
            segment_upload,
            video_upload_info,
            ..
        }) = cleared.as_ref()
    {
        info!("Aborting segment upload due to recording failure");
        segment_upload.handle.abort();
        crate::upload::emit_upload_complete(&handle, &video_upload_info.id);
    }

    drop(cleared);

    if app.was_camera_only_recording {
        app.was_camera_only_recording = false;
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

    // Destroy any target-select overlays so they don't reappear when the main window comes back.
    // On Windows, hide() leaves the DirectComposition transparency surface composited on screen
    // (ghost overlay); closing the window releases the surface entirely.
    let focus_manager = handle.try_state::<crate::target_select_overlay::WindowFocusManager>();
    for (label, window) in handle.webview_windows() {
        if let Ok(CapWindowId::TargetSelectOverlay { display_id }) = CapWindowId::from_str(&label) {
            #[cfg(windows)]
            let _ = window.close();
            #[cfg(not(windows))]
            hide_overlay(&window);
            if let Some(ref fm) = focus_manager {
                fm.destroy(&display_id, handle.global_shortcut());
            }
        }
    }

    if let Some(camera) = CapWindowId::Camera.get(&handle) {
        let _ = camera.hide();
    }

    app.camera_preview.pause();
    let _ = app.mic_feed.ask(microphone::RemoveInput).await;
    let _ = app.camera_feed.ask(camera::RemoveInput).await;

    let main_window = CapWindowId::Main.get(&handle);

    // When the finish path handed the foreground to an editor window, leave
    // the main window alone: un-minimizing it here (Windows `Close` behaviour
    // minimizes; macOS `Minimise` miniaturizes) would restore it on top of the
    // editor that just opened.
    let editor_took_foreground = matches!(&res, Some(Ok(true)));

    if let Some(window) = main_window {
        if !editor_took_foreground {
            window.unminimize().ok();
        }
        if let Err(err) = app.ensure_selected_mic_ready().await {
            warn!("Failed to restore microphone preview after recording: {err}");
        }
    } else {
        app.selected_mic_label = None;
        app.selected_camera_id = None;
    }

    // Fallback for in-editor recordings that did NOT reach
    // `apply_post_studio_editor_behaviour` (failed/cancelled recordings, or
    // non-studio modes). On the studio success path `handle_recording_finish`
    // — awaited above into `res` — already consumed the target and emitted
    // `EditorRecordingAdded`, so this `take()` returns `None` and is a no-op.
    // Using `take()` (not `current()`) here is deliberate: it restores the
    // editor window AND clears any stale target so it can't leak into the next
    // recording session.
    if let Some(editor_path) = EditorRecordingTarget::take(&handle)
        && let Some(editor_window) = editor_window_for_path(&handle, &editor_path)
    {
        let _ = editor_window.unminimize();
        let _ = editor_window.show();
        let _ = editor_window.set_focus();
    }

    CurrentRecordingChanged.emit(&handle).ok();

    if let Some(res) = res {
        let _editor_took_foreground: bool = res?;
    }

    Ok(())
}

fn compute_studio_duration_secs(recording_dir: &std::path::Path) -> f64 {
    let Ok(meta) = RecordingMeta::load_for_project(recording_dir) else {
        return 0.0;
    };
    let Some(studio_meta) = meta.studio_meta() else {
        return 0.0;
    };
    ProjectRecordingsMeta::new(&recording_dir.to_path_buf(), studio_meta)
        .map(|r| r.duration())
        .unwrap_or(0.0)
}

/// Returns `true` when an editor window took the foreground (in-editor
/// re-record, or the post-recording behaviour opened the editor). Callers use
/// this to keep the main window suppressed so it can't cover the editor.
async fn apply_post_studio_editor_behaviour(
    app: &AppHandle,
    recording_dir: PathBuf,
    duration_secs: f64,
) -> bool {
    if let Some(editor_path) = EditorRecordingTarget::take(app) {
        if let Some(editor_window) = editor_window_for_path(app, &editor_path) {
            let _ = editor_window.unminimize();
            let _ = editor_window.show();
            let _ = editor_window.set_focus();
        }

        let _ = EditorRecordingAdded {
            editor_path,
            recording_path: recording_dir,
        }
        .emit(app);

        return true;
    }

    let default = GeneralSettingsStore::get(app)
        .ok()
        .flatten()
        .map(|v| v.post_studio_recording_behaviour)
        .unwrap_or(PostStudioRecordingBehaviour::OpenEditor);

    match crate::automation::studio_recording_editor_behaviour(
        app,
        &recording_dir,
        duration_secs,
        default,
    ) {
        Some(PostStudioRecordingBehaviour::OpenEditor) => {
            let _ = ShowCapWindow::Editor {
                project_path: recording_dir,
            }
            .show(app)
            .await;

            true
        }
        Some(PostStudioRecordingBehaviour::ShowOverlay) => {
            let _ = ShowCapWindow::RecordingsOverlay.show(app).await;

            let app = AppHandle::clone(app);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(1000)).await;
                let _ = NewStudioRecordingAdded {
                    path: recording_dir,
                }
                .emit(&app);
            });

            false
        }
        None => {
            let _ = NewStudioRecordingAdded {
                path: recording_dir,
            }
            .emit(app);

            false
        }
    }
}

// runs when a recording successfully finishes; Ok(true) means an editor
// window took the foreground and the main window must stay suppressed
async fn handle_recording_finish(
    app: &AppHandle,
    completed_recording: CompletedRecording,
) -> Result<bool, String> {
    let recording_dir = completed_recording.project_path().clone();

    let screenshots_dir = recording_dir.join("screenshots");
    std::fs::create_dir_all(&screenshots_dir).ok();

    let (meta_inner, sharing) = match completed_recording {
        CompletedRecording::Studio {
            recording,
            capture_target,
            ..
        } => {
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
                info!(
                    "Recording has fragments queued for finalization - opening editor immediately"
                );

                let finalizing_state = app.state::<FinalizingRecordings>();
                finalizing_state.start_finalizing(recording_dir.clone());

                let duration = compute_studio_duration_secs(&recording_dir);
                let editor_took_foreground =
                    apply_post_studio_editor_behaviour(app, recording_dir.clone(), duration).await;

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
                        Some(capture_target),
                    )
                    .await;

                    match result {
                        Ok(()) => {
                            let duration =
                                compute_studio_duration_secs(&recording_dir_for_finalize);
                            crate::automation::run_studio_recording_automations(
                                app.clone(),
                                recording_dir_for_finalize.clone(),
                                duration,
                            );
                        }
                        Err(e) => error!("Failed to finalize recording: {e}"),
                    }

                    app.state::<FinalizingRecordings>()
                        .finish_finalizing(&recording_dir_for_finalize);
                });

                return Ok(editor_took_foreground);
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
                Some(&capture_target),
                stored_current_desktop_background_path(&recording_dir),
            );

            config.write(&recording_dir).map_err(|e| e.to_string())?;

            (
                RecordingMetaInner::Studio(Box::new(updated_studio_meta)),
                None,
            )
        }
        CompletedRecording::Instant {
            recording,
            segment_upload,
            video_upload_info,
            ..
        } => {
            if !recording.health.is_uploadable()
                && let cap_recording::RecordingHealth::Damaged { ref reason } = recording.health
            {
                error!(
                    reason,
                    "Instant recording is damaged and cannot be uploaded"
                );
                RecordingEvent::Failed {
                    error: format!("Recording output is damaged: {reason}"),
                }
                .emit(app)
                .ok();
                return Ok(false);
            }

            let app = app.clone();
            let is_camera_only =
                matches!(recording.display_source, ScreenCaptureTarget::CameraOnly);

            let display_screenshot = screenshots_dir.join("display.jpg");
            let screenshot_task = if is_camera_only {
                let output_mp4 = recording_dir.join("content/output.mp4");
                tokio::spawn({
                    let display_screenshot = display_screenshot.clone();
                    async move { create_screenshot(output_mp4, display_screenshot, None).await }
                })
            } else {
                let segments_dir = recording_dir.join("content/display");
                tokio::spawn({
                    let display_screenshot = display_screenshot.clone();
                    async move {
                        let screenshot_source: Result<PathBuf, String> =
                            create_screenshot_source_from_segments(&segments_dir).await;
                        match screenshot_source {
                            Ok(temp_path) => {
                                let result =
                                    create_screenshot(temp_path.clone(), display_screenshot, None)
                                        .await;
                                let _ = tokio::fs::remove_file(&temp_path).await;
                                result
                            }
                            Err(e) => Err(format!("Failed to create screenshot source: {e}")),
                        }
                    }
                })
            };

            spawn_actor({
                let video_upload_info = video_upload_info.clone();
                let recording_dir = recording_dir.clone();

                async move {
                    let upload_succeeded = segment_upload
                        .handle
                        .await
                        .map_err(|e| e.to_string())
                        .and_then(|r| r.map_err(|v| v.to_string()))
                        .is_ok();

                    if upload_succeeded {
                        info!("Segment upload succeeded");
                        crate::automation::run_upload_completed_automations(
                            app.clone(),
                            recording_dir.clone(),
                            Some(video_upload_info.link.clone()),
                            Some(video_upload_info.id.clone()),
                        );
                    } else {
                        crate::upload::emit_upload_complete(&app, &video_upload_info.id);
                    }

                    let _ = screenshot_task.await;

                    if upload_succeeded
                        && let Ok(bytes) =
                            compress_image(display_screenshot).await.map_err(|err| {
                                error!(
                                    "Error compressing thumbnail for instant mode progressive upload: {err}"
                                )
                            })
                    {
                        let res = crate::upload::singlepart_uploader(
                            app.clone(),
                            crate::api::PresignedS3PutRequest {
                                video_id: video_upload_info.id.clone(),
                                subpath: "screenshot/screen-capture.jpg".to_string(),
                                method: PresignedS3PutRequestMethod::Put,
                                meta: None,
                            },
                            bytes.len() as u64,
                            stream::once(async move {
                                Ok::<_, std::io::Error>(bytes::Bytes::from(bytes))
                            }),
                        )
                        .await;
                        if let Err(err) = res {
                            error!(
                                "Error updating thumbnail for instant mode progressive upload: {err}"
                            );
                        }
                    }

                    if upload_succeeded
                        && GeneralSettingsStore::get(&app)
                            .ok()
                            .flatten()
                            .unwrap_or_default()
                            .delete_instant_recordings_after_upload
                        && let Err(err) = tokio::fs::remove_dir_all(&recording_dir).await
                    {
                        error!("Failed to remove recording files after upload: {err:?}");
                    }
                }
            });

            (
                RecordingMetaInner::Instant(recording.meta),
                Some(SharingMeta {
                    link: video_upload_info.link,
                    id: video_upload_info.id,
                    content_hash: None,
                }),
            )
        }
    };

    let instant_share = sharing.as_ref().map(|s| (s.link.clone(), s.id.clone()));

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

    if let RecordingMetaInner::Instant(_) = &meta_inner {
        let (link, id) = match instant_share {
            Some((link, id)) => (Some(link), Some(id)),
            None => (None, None),
        };
        crate::automation::run_instant_recording_automations(
            app.clone(),
            recording_dir.clone(),
            link,
            id,
        );
    }

    let mut editor_took_foreground = false;
    if let RecordingMetaInner::Studio(_) = meta_inner {
        let duration = compute_studio_duration_secs(&recording_dir);
        crate::automation::run_studio_recording_automations(
            app.clone(),
            recording_dir.clone(),
            duration,
        );
        editor_took_foreground =
            apply_post_studio_editor_behaviour(app, recording_dir, duration).await;
    }

    // Play sound to indicate recording has stopped
    AppSounds::StopRecording.play();

    Ok(editor_took_foreground)
}

async fn finalize_studio_recording(
    app: &AppHandle,
    recording_dir: PathBuf,
    screenshots_dir: PathBuf,
    recording: cap_recording::studio_recording::CompletedRecording,
    default_preset: Option<ProjectConfiguration>,
    capture_target: Option<ScreenCaptureTarget>,
) -> Result<(), String> {
    info!("Starting background finalization for recording");

    let recording_dir_for_remux = recording_dir.clone();
    let app_for_remux = app.clone();
    let remux_result = tokio::task::spawn_blocking(move || {
        remux_fragmented_recording_with_trigger(
            &recording_dir_for_remux,
            "recording_stop",
            Some(&app_for_remux),
        )
    })
    .await
    .map_err(|e| format!("Recording finalization task panicked: {e}"))?;

    if let Err(e) = remux_result {
        error!("Failed to finalize fragmented recording: {e}");
        return Err(format!("Failed to finalize fragmented recording: {e}"));
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
        capture_target.as_ref(),
        stored_current_desktop_background_path(&recording_dir),
    );

    config
        .write(&recording_dir)
        .map_err(|e| format!("Failed to write project config: {e}"))?;

    info!("Background finalization completed for recording");

    Ok(())
}

fn generate_zoom_segments_from_clicks_impl(
    mut clicks: Vec<CursorClickEvent>,
    _moves: Vec<CursorMoveEvent>,
    max_duration: f64,
) -> Vec<ZoomSegment> {
    const MS_PER_SECOND: f64 = 1000.0;
    const START_MIN_MS: f64 = 1.0;
    const CLICK_PRE_PADDING_MS: f64 = 300.0;
    const CLICK_POST_PADDING_MS: f64 = 2500.0;
    const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0;
    const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
    const MERGE_GAP_MS: f64 = 2500.0;
    const AUTO_ZOOM_AMOUNT: f64 = 2.0;

    if max_duration <= 0.0 {
        return Vec::new();
    }

    let duration_ms = max_duration * MS_PER_SECOND;
    let click_cutoff_ms = duration_ms - TRAILING_CLICK_IGNORE_MS;
    let end_limit_ms = duration_ms - CLICK_END_CLAMP_PADDING_MS;
    if click_cutoff_ms <= 0.0 || end_limit_ms <= START_MIN_MS {
        return Vec::new();
    }

    clicks.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut intervals: Vec<(f64, f64)> = Vec::new();
    for click in clicks {
        let time_ms = click.time_ms.floor();
        if time_ms >= click_cutoff_ms {
            continue;
        }

        let start = (time_ms - CLICK_PRE_PADDING_MS).max(START_MIN_MS);
        let end = (time_ms + CLICK_POST_PADDING_MS).min(end_limit_ms);

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
            && interval.0 <= last.1 + MERGE_GAP_MS
        {
            last.1 = last.1.max(interval.1);
            continue;
        }
        merged.push(interval);
    }

    merged
        .into_iter()
        .map(|(start, end)| ZoomSegment {
            start: start.round() / MS_PER_SECOND,
            end: end.round() / MS_PER_SECOND,
            amount: AUTO_ZOOM_AMOUNT,
            mode: ZoomMode::Auto,
            glide_direction: GlideDirection::None,
            glide_speed: 0.5,
            instant_animation: false,
            edge_snap_ratio: 0.25,
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
    capture_target: Option<&ScreenCaptureTarget>,
    stored_desktop_background_path: Option<String>,
) -> ProjectConfiguration {
    let settings = GeneralSettingsStore::get(app)
        .unwrap_or(None)
        .unwrap_or_default();

    let using_default_config = default_config.is_none();
    let mut config = default_config.unwrap_or_default();
    config.cursor.size = cap_project::CursorConfiguration::default().size;
    apply_recording_presentation_defaults(
        app,
        &mut config,
        capture_target,
        using_default_config,
        stored_desktop_background_path,
    );

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

        config.camera.background_blur = cap_project::BackgroundBlurConfig {
            mode: camera_preview_state.background_blur,
        };
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
            name: None,
            speed_audio_mode: None,
        })
        .collect::<Vec<_>>();

    let zoom_segments = if settings.auto_zoom_on_clicks {
        generate_zoom_segments_from_clicks(completed_recording, recordings)
    } else {
        Vec::new()
    };

    config.timeline = Some(TimelineConfiguration {
        segments: timeline_segments,
        transitions: Vec::new(),
        zoom_segments,
        scene_segments: Vec::new(),
        mask_segments: Vec::new(),
        text_segments: Vec::new(),
        caption_segments: Vec::new(),
        keyboard_segments: Vec::new(),
        audio_segments: Vec::new(),
    });

    config
}

fn apply_recording_presentation_defaults(
    app: &AppHandle,
    config: &mut ProjectConfiguration,
    capture_target: Option<&ScreenCaptureTarget>,
    using_default_config: bool,
    stored_desktop_background_path: Option<String>,
) {
    let default_wallpaper_path = if using_default_config {
        stored_desktop_background_path.or_else(|| {
            app.path()
                .resolve("assets/backgrounds/cities/sf.jpg", BaseDirectory::Resource)
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
    } else {
        None
    };

    apply_screen_recording_presentation_defaults(
        config,
        capture_target,
        using_default_config,
        default_wallpaper_path,
    );
}

const DEFAULT_SCREEN_RECORDING_BACKGROUND_ROUNDING_PERCENT: f64 = 7.5;

fn apply_screen_recording_presentation_defaults(
    config: &mut ProjectConfiguration,
    capture_target: Option<&ScreenCaptureTarget>,
    using_default_config: bool,
    default_wallpaper_path: Option<String>,
) {
    use cap_project::{BackgroundSource, ScreenMovementSpring};

    if matches!(capture_target, Some(ScreenCaptureTarget::CameraOnly)) {
        return;
    }

    let has_default_background = matches!(
        &config.background.source,
        BackgroundSource::Color { value, alpha } if *value == [255, 255, 255] && *alpha == 255
    );

    if using_default_config && has_default_background {
        if let Some(path) = default_wallpaper_path {
            config.background.source = BackgroundSource::Wallpaper { path: Some(path) };
        }
    }

    if config.background.padding <= f64::EPSILON {
        config.background.padding = 10.0;
    }

    if matches!(
        capture_target,
        Some(ScreenCaptureTarget::Window { .. } | ScreenCaptureTarget::Display { .. })
    ) && config.background.rounding <= f64::EPSILON
    {
        config.background.rounding = DEFAULT_SCREEN_RECORDING_BACKGROUND_ROUNDING_PERCENT;
    }

    if (config.screen_movement_spring.stiffness - 120.0).abs() < f32::EPSILON
        && (config.screen_movement_spring.damping - 14.0).abs() < f32::EPSILON
        && (config.screen_movement_spring.mass - 1.0).abs() < f32::EPSILON
    {
        config.screen_movement_spring = ScreenMovementSpring::default();
    }
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

pub const FRAGMENTED_EXPORT_FFMPEG_MARKER: &str = ".force-ffmpeg-export";

fn fragmented_export_ffmpeg_marker_path(recording_dir: &Path) -> PathBuf {
    recording_dir.join(FRAGMENTED_EXPORT_FFMPEG_MARKER)
}

fn mark_fragmented_recording_for_ffmpeg_export(recording_dir: &Path) -> Result<(), String> {
    std::fs::write(
        fragmented_export_ffmpeg_marker_path(recording_dir),
        b"fragmented-remux",
    )
    .map_err(|e| format!("Failed to mark recording for FFmpeg export: {e}"))
}

pub fn remux_fragmented_recording(recording_dir: &Path) -> Result<(), String> {
    remux_fragmented_recording_with_trigger(recording_dir, "manual_remux", None)
}

pub fn remux_fragmented_recording_with_trigger(
    recording_dir: &Path,
    trigger: &'static str,
    app: Option<&AppHandle>,
) -> Result<(), String> {
    let incomplete_recording = RecoveryManager::inspect_recording(recording_dir);

    if let Some(recording) = incomplete_recording {
        let normal_stop = trigger == "recording_stop";
        let validation_start = std::time::Instant::now();
        let outcome = if normal_stop {
            RecoveryManager::finalize(&recording)
        } else {
            RecoveryManager::recover(&recording)
        };
        let validation_took_ms = validation_start.elapsed().as_millis() as u64;

        match outcome {
            Ok(_) => {
                mark_fragmented_recording_for_ffmpeg_export(recording_dir)?;
                if normal_stop {
                    info!("Successfully finalized fragmented recording");
                } else {
                    info!("Successfully recovered fragmented recording");
                }

                if let Some(app_handle) = app
                    && !normal_stop
                {
                    let recovered_duration_secs = RecordingMeta::load_for_project(recording_dir)
                        .ok()
                        .and_then(|meta| match meta.inner {
                            RecordingMetaInner::Studio(studio) => match *studio {
                                StudioRecordingMeta::MultipleSegments { inner } => Some(
                                    inner
                                        .segments
                                        .iter()
                                        .filter_map(|seg| seg.display.start_time)
                                        .fold(0.0_f64, |acc, v| acc.max(v)),
                                ),
                                StudioRecordingMeta::SingleSegment { .. } => None,
                            },
                            _ => None,
                        })
                        .map(|s| s as u64)
                        .unwrap_or_default();

                    let segments_recovered = RecordingMeta::load_for_project(recording_dir)
                        .ok()
                        .and_then(|meta| match meta.inner {
                            RecordingMetaInner::Studio(studio) => match *studio {
                                StudioRecordingMeta::MultipleSegments { inner } => {
                                    Some(inner.segments.len() as u32)
                                }
                                StudioRecordingMeta::SingleSegment { .. } => Some(1),
                            },
                            _ => None,
                        })
                        .unwrap_or(0);

                    crate::posthog::async_capture_event(
                        app_handle,
                        crate::posthog::PostHogEvent::RecordingRecovered {
                            trigger,
                            recovered_duration_secs,
                            segments_recovered,
                            validation_took_ms,
                        },
                    );
                }
                Ok(())
            }
            Err(e) => {
                let reason = format!("{e}");
                if let Some(app_handle) = app {
                    crate::posthog::async_capture_event(
                        app_handle,
                        crate::posthog::PostHogEvent::RecordingRecoveryFailed {
                            trigger,
                            reason: reason.clone(),
                        },
                    );
                }
                let action = if normal_stop { "finalize" } else { "recover" };
                Err(format!("Failed to {action} recording: {reason}"))
            }
        }
    } else {
        Err("Could not find fragments to remux".to_string())
    }
}

fn classify_error_message(error: &str) -> String {
    let lowered = error.to_ascii_lowercase();
    let class = if lowered.contains("permission") {
        "permission"
    } else if lowered.contains("disk") || lowered.contains("no space") {
        "disk"
    } else if lowered.contains("camera") {
        "camera"
    } else if lowered.contains("microphone") || lowered.contains("mic") {
        "microphone"
    } else if lowered.contains("display") || lowered.contains("screen") {
        "display"
    } else if lowered.contains("muxer") {
        "muxer"
    } else if lowered.contains("timeout") {
        "timeout"
    } else if lowered.contains("cancel") {
        "cancelled"
    } else {
        "other"
    };
    class.to_string()
}

async fn emit_recording_started_telemetry(app: &AppHandle, state_mtx: &MutableState<'_, App>) {
    use crate::posthog::{PostHogEvent, async_capture_event};
    use crate::recording_telemetry::{mode_label, target_kind_label};

    let (mode, recording_mode, target_kind, has_camera, has_mic, has_system_audio) = {
        let state = state_mtx.read().await;
        let Some(recording) = state.current_recording() else {
            return;
        };
        let inputs = recording.inputs();
        let target_kind = target_kind_label(recording.capture_target());
        let has_camera = match recording {
            InProgressRecording::Instant { camera_feed, .. }
            | InProgressRecording::Studio { camera_feed, .. } => camera_feed.is_some(),
        };
        (
            mode_label(inputs.mode),
            inputs.mode,
            target_kind,
            has_camera,
            state.selected_mic_label.is_some(),
            inputs.capture_system_audio,
        )
    };

    let general = GeneralSettingsStore::get(app).ok().flatten();
    let defaults = desktop_recording_defaults(general.as_ref());
    let fragmented = defaults.crash_recovery_recording;
    let custom_cursor_capture = defaults.custom_cursor_capture;
    // Studio applies the camera fps clamp via `apply_to_studio_builder`; Instant records screen at a
    // fixed fps, so report the value each mode actually uses rather than the raw studio cap.
    let target_fps = match recording_mode {
        RecordingMode::Studio => defaults.studio_max_fps(has_camera, None),
        RecordingMode::Instant | RecordingMode::Screenshot => {
            cap_recording::DEFAULT_INSTANT_MODE_FPS
        }
    };

    async_capture_event(
        app,
        PostHogEvent::RecordingStarted {
            mode,
            target_kind,
            has_camera,
            has_mic,
            has_system_audio,
            target_fps,
            target_width: 0,
            target_height: 0,
            fragmented,
            custom_cursor_capture,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn click_event_with_state(time_ms: f64, down: bool) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_num: 0,
            cursor_id: "default".to_string(),
            time_ms,
            down,
        }
    }

    fn click_event(time_ms: f64) -> CursorClickEvent {
        click_event_with_state(time_ms, true)
    }

    fn click_up_event(time_ms: f64) -> CursorClickEvent {
        click_event_with_state(time_ms, false)
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
    fn mic_feed_locked_detects_feed_lock_errors() {
        assert!(mic_feed_locked(&anyhow::Error::new(
            microphone::FeedLockedError
        )));
        assert!(mic_feed_locked(&anyhow::Error::new(
            microphone::LockFeedError::Locked(microphone::FeedLockedError)
        )));
        assert!(mic_feed_locked(&anyhow::Error::new(
            microphone::SetInputError::Locked(microphone::FeedLockedError)
        )));
    }

    #[test]
    fn mic_feed_locked_ignores_unrelated_errors() {
        assert!(!mic_feed_locked(&anyhow!("different failure")));
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
    fn merges_clicks_with_three_second_gap() {
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
        assert_eq!(segments.len(), 1);
        assert_eq!(first.start, 0.9);
        assert_eq!(first.end, 6.7);
    }

    #[test]
    fn separates_click_groups_across_long_idle_gap() {
        let clicks = vec![
            click_event(2_271.0),
            click_event(9_137.0),
            click_event(9_915.0),
            click_event(19_404.0),
        ];
        let moves = vec![
            move_event(562.0, 0.48, 0.50),
            move_event(2_271.0, 0.05, 0.08),
            move_event(9_137.0, 0.94, 0.06),
            move_event(9_915.0, 0.94, 0.07),
            move_event(19_364.0, 0.44, 0.95),
        ];

        let segments = generate_zoom_segments_from_clicks_impl(clicks, moves, 19.436_667);

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start, 1.971);
        assert_eq!(segments[0].end, 4.771);
        assert_eq!(segments[1].start, 8.837);
        assert_eq!(segments[1].end, 12.415);
    }

    #[test]
    fn extends_segment_until_after_mouse_up() {
        let clicks = vec![click_event(1_000.0), click_up_event(2_500.0)];

        let segments = generate_zoom_segments_from_clicks_impl(clicks, vec![], 10.0);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 0.7);
        assert_eq!(segments[0].end, 5.0);
    }

    #[test]
    fn clamps_zoom_end_before_recording_end() {
        let clicks = vec![click_event(8_999.0), click_event(9_000.0)];

        let segments = generate_zoom_segments_from_clicks_impl(clicks, vec![], 10.0);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 8.699);
        assert_eq!(segments[0].end, 9.2);
    }

    #[test]
    fn does_not_zoom_without_clicks() {
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

    #[test]
    fn marks_fragmented_recordings_for_ffmpeg_export() {
        let dir = tempdir().unwrap();

        assert!(!fragmented_export_ffmpeg_marker_path(dir.path()).exists());

        mark_fragmented_recording_for_ffmpeg_export(dir.path()).unwrap();

        assert!(fragmented_export_ffmpeg_marker_path(dir.path()).exists());
    }

    #[test]
    fn skips_desktop_background_paths_that_can_trigger_macos_prompts() {
        let home = Path::new("/Users/test");

        assert!(desktop_background_source_requires_user_prompt_for_home(
            Path::new("/Users/test/Downloads/wallpaper.jpg"),
            home
        ));
        assert!(desktop_background_source_requires_user_prompt_for_home(
            Path::new("/Users/test/Library/CloudStorage/iCloud Drive/wallpaper.jpg"),
            home
        ));
        assert!(!desktop_background_source_requires_user_prompt_for_home(
            Path::new("/Users/test/Pictures/wallpaper.jpg"),
            home
        ));
        assert!(!desktop_background_source_requires_user_prompt_for_home(
            Path::new("/System/Library/Desktop Pictures/wallpaper.jpg"),
            home
        ));
    }

    #[test]
    fn skips_screen_presentation_defaults_for_camera_only_recordings() {
        let mut config = ProjectConfiguration::default();

        apply_screen_recording_presentation_defaults(
            &mut config,
            Some(&ScreenCaptureTarget::CameraOnly),
            true,
            Some("wallpaper.jpg".to_string()),
        );

        assert_eq!(config.background.padding, 0.0);
        assert!(matches!(
            config.background.source,
            cap_project::BackgroundSource::Color {
                value: [255, 255, 255],
                alpha: 255,
            }
        ));
    }

    #[test]
    fn applies_screen_presentation_defaults_for_screen_recordings() {
        let mut config = ProjectConfiguration::default();
        let capture_target = ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        };

        apply_screen_recording_presentation_defaults(
            &mut config,
            Some(&capture_target),
            true,
            Some("wallpaper.jpg".to_string()),
        );

        assert_eq!(config.background.padding, 10.0);
        assert_eq!(config.background.rounding, 7.5);
        assert!(matches!(
            config.background.source,
            cap_project::BackgroundSource::Wallpaper { path: Some(path) } if path == "wallpaper.jpg"
        ));
    }

    #[test]
    fn screen_presentation_defaults_apply_window_rounding_without_default_border() {
        let mut config = ProjectConfiguration::default();
        let capture_target = ScreenCaptureTarget::Window {
            id: "1".parse().unwrap(),
        };

        apply_screen_recording_presentation_defaults(
            &mut config,
            Some(&capture_target),
            true,
            Some("wallpaper.jpg".to_string()),
        );

        assert_eq!(config.background.rounding, 7.5);
        assert!(config.background.border.is_none());
    }

    #[test]
    fn classifies_unsolicited_pipeline_completion_as_unexpected_stop() {
        let disposition = classify_actor_done_result(Ok::<(), anyhow::Error>(()), true);

        assert_eq!(
            disposition,
            ActorDoneDisposition::UnexpectedStop {
                error: "Recording stopped unexpectedly before it was ended.".to_string()
            }
        );
    }

    #[test]
    fn classifies_pipeline_completion_after_user_stop_as_expected() {
        let disposition = classify_actor_done_result(Ok::<(), anyhow::Error>(()), false);

        assert_eq!(disposition, ActorDoneDisposition::UserInitiatedStop);
    }

    #[test]
    fn classifies_pipeline_failure_as_failure() {
        let disposition = classify_actor_done_result(Err(anyhow!("feed lost")), true);

        assert_eq!(
            disposition,
            ActorDoneDisposition::Failed {
                error: "feed lost".to_string()
            }
        );
    }
}
