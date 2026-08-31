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
use tauri_plugin_store::StoreExt;
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
    upload::{SegmentUploader, compress_image},
    web_api::ManagerExt,
    windows::{
        CapWindowId, EditorRecordingTarget, ShowCapWindow, editor_window_for_path, hide_overlay,
    },
};

#[cfg(not(target_os = "linux"))]
use crate::upload::InstantMultipartUpload;

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

#[cfg(target_os = "linux")]
type InstantUploader = Arc<tokio::sync::Mutex<SegmentUploader>>;
#[cfg(not(target_os = "linux"))]
type InstantUploader = SegmentUploader;

async fn await_instant_upload(
    upload: InstantUploader,
) -> Result<Result<(), AuthedApiError>, String> {
    #[cfg(target_os = "linux")]
    {
        (&mut upload.lock().await.handle)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        upload.handle.await.map_err(|error| error.to_string())
    }
}

pub struct StopFailureContext {
    pub segment_upload: InstantUploader,
    pub video_upload_info: VideoUploadInfo,
}

#[cfg(target_os = "linux")]
type InstantActorHandle = Arc<instant_recording::ActorHandle>;
#[cfg(not(target_os = "linux"))]
type InstantActorHandle = instant_recording::ActorHandle;

pub enum InProgressRecording {
    Instant {
        handle: InstantActorHandle,
        segment_upload: InstantUploader,
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
            Self::Instant { handle, .. } => {
                #[cfg(target_os = "linux")]
                {
                    let _ = handle;
                    Err(anyhow!(
                        "Instant recordings cannot pause or resume; use Stop"
                    ))
                }
                #[cfg(not(target_os = "linux"))]
                {
                    handle.pause().await
                }
            }
            Self::Studio { handle, .. } => handle.pause().await,
        }
    }

    pub async fn resume(&self) -> anyhow::Result<()> {
        match self {
            Self::Instant { handle, .. } => {
                #[cfg(target_os = "linux")]
                {
                    let _ = handle;
                    Err(anyhow!(
                        "Instant recordings cannot pause or resume; use Stop"
                    ))
                }
                #[cfg(not(target_os = "linux"))]
                {
                    handle.resume().await
                }
            }
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
                    #[cfg(target_os = "linux")]
                    finalized: false,
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
            Self::Instant { handle, .. } => {
                #[cfg(target_os = "linux")]
                {
                    Arc::get_mut(handle).and_then(instant_recording::ActorHandle::take_health_rx)
                }
                #[cfg(not(target_os = "linux"))]
                {
                    handle.take_health_rx()
                }
            }
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
        #[cfg(target_os = "linux")]
        finalized: bool,
        recording: instant_recording::CompletedRecording,
        target_name: String,
        segment_upload: InstantUploader,
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
pub async fn list_capture_windows(window: tauri::Window) -> Vec<CaptureWindow> {
    let windows = if window.label() == CapWindowId::Settings.label() {
        screen_capture::list_excludable_windows()
    } else {
        screen_capture::list_windows()
    };

    windows.into_iter().map(|(v, _)| v).collect()
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

fn recording_start_mode_error(mode: RecordingMode, authenticated: bool) -> Option<&'static str> {
    match mode {
        RecordingMode::Instant if !authenticated => Some("Please sign in to use instant recording"),
        RecordingMode::Screenshot => Some("Use take_screenshot for screenshots"),
        RecordingMode::Studio | RecordingMode::Instant => None,
    }
}

#[derive(Serialize, Type)]
pub enum RecordingAction {
    Started,
    InvalidAuthentication,
    UpgradeRequired,
}

const MICROPHONE_INPUT_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const CAMERA_INPUT_PROBE_TIMEOUT: Duration = Duration::from_millis(1500);

pub(crate) fn camera_id_label(id: &camera::DeviceOrModelID) -> String {
    match id {
        camera::DeviceOrModelID::DeviceID(device_id) => device_id.clone(),
        camera::DeviceOrModelID::ModelID(model_id) => format!("{model_id:?}"),
    }
}

fn validate_selected_camera_for_start(
    selected_id: Option<&camera::DeviceOrModelID>,
    is_available: impl FnOnce(&camera::DeviceOrModelID) -> bool,
) -> anyhow::Result<()> {
    if let Some(id) = selected_id
        && !is_available(id)
    {
        return Err(anyhow!(
            "Selected camera '{}' is no longer available. Reconnect it or choose another camera before recording.",
            camera_id_label(id)
        ));
    }
    Ok(())
}

fn selected_microphone_for_start(
    selected_label: Option<String>,
    available_names: &[String],
) -> anyhow::Result<Option<String>> {
    let Some(label) = selected_label else {
        return Ok(None);
    };
    if !available_names.contains(&label) {
        return Err(anyhow!(
            "Selected microphone '{label}' is no longer available. Reconnect it or choose another microphone before recording."
        ));
    }
    Ok(Some(label))
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
        Ok(lock) if camera_lock_matches_id(&lock, id) => Ok(lock),
        Ok(_) => Err(anyhow!(
            "Selected camera '{label}' changed during initialization. Select the camera again before recording."
        )),
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
        Ok(lock) if lock.device_name() == label => Ok(lock),
        Ok(_) => Err(anyhow!(
            "Selected microphone '{label}' changed during initialization. Select the microphone again before recording."
        )),
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
    #[cfg(target_os = "linux")]
    if inputs.mode != RecordingMode::Instant && linux_instant::current(&app).is_some() {
        return Err("Finish the pending Instant cleanup before recording".into());
    }
    #[cfg(target_os = "linux")]
    if inputs.mode == RecordingMode::Instant && EditorRecordingTarget::current(&app).is_none() {
        return linux_instant::start(app, state_mtx, inputs).await;
    }
    start_recording_inner(app, state_mtx, inputs).await
}

async fn start_recording_inner(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    inputs: StartRecordingInputs,
) -> Result<RecordingAction, String> {
    let mut inputs = inputs;

    #[cfg(target_os = "linux")]
    let has_instant_owner = linux_instant::current(&app).is_some();
    #[cfg(not(target_os = "linux"))]
    let has_instant_owner = false;
    if EditorRecordingTarget::current(&app).is_some() && !has_instant_owner {
        inputs.mode = RecordingMode::Studio;
    }

    let requested_state = app.state::<crate::RequestedInputsState>();
    let requested_inputs = match requested_state.ready_snapshot() {
        Ok(snapshot) => snapshot,
        Err(error) => {
            notify_recording_start_failed(&app, &error);
            return Err(error);
        }
    };
    #[cfg(target_os = "linux")]
    linux_instant::validate_screen_request(&inputs, &requested_inputs).inspect_err(|error| {
        notify_recording_start_failed(&app, error);
    })?;
    let clean_generation = crate::clean_capture::prepare(&app, &inputs, None)
        .await
        .inspect_err(|error| {
            notify_recording_start_failed(&app, error);
        })?;
    let result = start_recording_prepared(
        app.clone(),
        state_mtx.clone(),
        inputs,
        requested_inputs,
        clean_generation,
    )
    .await;
    if !matches!(&result, Ok(RecordingAction::Started))
        && let Some(generation) = clean_generation
        && crate::clean_capture::is_current(&app, generation)
    {
        state_mtx.write().await.clear_pending_recording();
        crate::clean_capture::release(&app, generation, false);
    }
    result
}

async fn start_recording_prepared(
    app: AppHandle,
    state_mtx: MutableState<'_, App>,
    mut inputs: StartRecordingInputs,
    requested_inputs: crate::RequestedInputs,
    clean_generation: Option<u32>,
) -> Result<RecordingAction, String> {
    let requested_state = app.state::<crate::RequestedInputsState>();
    let mut _input_operation = Some(requested_state.operation.lock().await);
    if let Err(error) = requested_state.ready_snapshot() {
        notify_recording_start_failed(&app, &error);
        return Err(error);
    }
    if !requested_state.is_current(&requested_inputs) {
        let error = "Input selection changed before recording could start. Try recording again."
            .to_string();
        notify_recording_start_failed(&app, &error);
        return Err(error);
    }

    let is_camera_only = matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly);

    #[cfg(target_os = "linux")]
    linux_instant::validate_inputs(&inputs)?;

    if is_camera_only {
        inputs.capture_system_audio = false;
    }

    {
        let mut app_state = state_mtx.write().await;
        let pending_result = if let Some(generation) = clean_generation {
            if crate::clean_capture::is_current(&app, generation)
                && matches!(app_state.recording_state, RecordingState::Pending { .. })
            {
                Ok(())
            } else {
                Err("Recording preflight was cancelled or superseded".to_string())
            }
        } else {
            app_state.set_pending_recording(inputs.mode, inputs.capture_target.clone())
        };
        if let Err(error) = pending_result {
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

    if cfg!(target_os = "linux") && inputs.mode == RecordingMode::Instant {
        drop(_input_operation.take());
    }

    let instant_auth = if matches!(inputs.mode, RecordingMode::Instant) {
        AuthStore::get(&app).ok().flatten()
    } else {
        None
    };
    if let Some(error) = recording_start_mode_error(inputs.mode, instant_auth.is_some()) {
        state_mtx.write().await.clear_pending_recording();
        notify_recording_start_failed(&app, error);
        return Err(error.to_string());
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
    #[cfg(target_os = "linux")]
    if inputs.mode == RecordingMode::Instant
        && let Some(attempt) = linux_instant::current(&app)
    {
        attempt.set_directory(project_file_path.clone());
        if attempt.cancelled() {
            return Err("Instant startup cancelled".into());
        }
    }

    pending_try!(ensure_dir(&project_file_path), |e| format!(
        "Failed to create recording directory: {e}"
    ));
    if let Some(generation) = clean_generation {
        crate::clean_capture::set_start_directory(&app, generation, project_file_path.clone())?;
    }
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
            let Some(auth) = instant_auth else {
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

    if clean_generation.is_none() {
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
    }
    let countdown = general_settings.and_then(|v| v.recording_countdown);
    crate::target_select_overlay::close_target_select_overlay_windows(&app);
    if clean_generation.is_none() {
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
            #[cfg(target_os = "linux")]
            if inputs.mode == RecordingMode::Instant
                && linux_instant::current(&app).is_none_or(|attempt| attempt.cancelled())
            {
                return Err("Instant startup cancelled".into());
            }
            let _ = RecordingEvent::Countdown {
                value: countdown - t,
            }
            .emit(&app);
            tokio::time::sleep(Duration::from_secs(1)).await;
            if clean_generation
                .is_some_and(|generation| crate::clean_capture::stop_requested(&app, generation))
            {
                return Err("Recording cancelled".into());
            }
        }
    }

    let (finish_upload_tx, finish_upload_rx) = flume::bounded(1);
    #[cfg(target_os = "linux")]
    drop(finish_upload_rx);

    if _input_operation.is_none() {
        _input_operation = Some(requested_state.operation.lock().await);
        if !requested_state.is_current(&requested_inputs) {
            return Err("Input selection changed during startup".into());
        }
    }

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
                let selected_camera_settings =
                    requested_inputs.camera.value.as_ref().and_then(|id| {
                        crate::recording_settings::RecordingSettingsStore::camera_settings_for(
                            &state.handle,
                            id,
                        )
                    });
                (
                    state.camera_feed.clone(),
                    requested_inputs.camera.value.clone(),
                    selected_camera_settings,
                )
            };

            validate_selected_camera_for_start(
                selected_camera_id.as_ref(),
                crate::is_camera_available,
            )?;

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

            let has_camera_feed = camera_feed.is_some();

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
                    if !app_handle
                        .state::<crate::RequestedInputsState>()
                        .is_current(&requested_inputs)
                    {
                        return Err(anyhow!(
                            "Input selection changed during recording startup. Try recording again."
                        ));
                    }
                    let selected_mic_label = match requested_inputs.microphone.value.clone() {
                        Some(label) => selected_microphone_for_start(
                            Some(label),
                            &microphone::MicrophoneFeed::list_names(),
                        )?,
                        None => None,
                    };
                    let (mic_actor, selected_mic_settings) = {
                        let mut state = state_mtx.write().await;
                        let settings = selected_mic_label
                            .as_ref()
                            .and_then(|label| state.microphone_settings_for_label(label));
                        state.applied_mic_input.invalidate();
                        (state.mic_feed.clone(), settings)
                    };
                    debug!(
                        mic_selected = selected_mic_label.is_some(),
                        "Locking selected microphone for recording"
                    );
                    let mic_feed = lock_selected_microphone(
                        &mic_actor,
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

                            #[cfg(target_os = "linux")]
                            let attempt = linux_instant::current(&app_handle)
                                .ok_or_else(|| anyhow!("Instant startup owner was lost"))?;
                            #[cfg(target_os = "linux")]
                            attempt
                                .attach(recording_dir.clone(), builder.lifecycle())
                                .await
                                .map_err(anyhow::Error::msg)?;
                            #[cfg(target_os = "linux")]
                            {
                                let prepared = match clean_generation {
                                    Some(generation) => linux_instant::prepare_screen_camera(
                                        &app_handle,
                                        &attempt,
                                        generation,
                                        &inputs,
                                        &requested_inputs,
                                        camera_feed.clone(),
                                    )
                                    .await
                                    .map_err(anyhow::Error::msg)?,
                                    None => None,
                                };
                                builder = linux_instant::configure_screen_camera(
                                    builder,
                                    &inputs.capture_target,
                                    requested_inputs.camera.value.is_some(),
                                    prepared,
                                )
                                .map_err(anyhow::Error::msg)?;
                                attempt.checked(Ok(())).map_err(anyhow::Error::msg)?;
                            }
                            let upload_session = crate::upload::lifecycle::prepare(
                                &app_handle,
                                &recording_dir,
                                &video_upload_info.id,
                                inputs.capture_system_audio || mic_feed.is_some(),
                            )
                            .await
                            .map_err(anyhow::Error::from)?;
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

                            #[cfg(target_os = "linux")]
                            let handle = Arc::new(handle);
                            #[cfg(target_os = "linux")]
                            let segment_upload = {
                                let events = handle.take_segment_rx();
                                linux_instant::persist_upload_start(
                                    &recording_dir,
                                    &video_upload_info,
                                    events.is_some(),
                                )
                                .map_err(anyhow::Error::msg)?;
                                attempt.upload_started();
                                Arc::new(tokio::sync::Mutex::new(
                                    crate::upload::strict_instant::spawn(
                                        app_handle.clone(),
                                        upload_session,
                                        video_upload_info.clone(),
                                        events,
                                        attempt.upload(),
                                        inputs.capture_system_audio || mic_feed.is_some(),
                                    ),
                                ))
                            };
                            #[cfg(not(target_os = "linux"))]
                            let segment_upload = {
                                let segment_rx = handle.take_segment_rx();

                                if let Some(rx) = segment_rx {
                                    SegmentUploader::spawn(
                                        app_handle.clone(),
                                        rx,
                                        Some(finish_upload_rx.clone()),
                                        upload_session,
                                        video_upload_info.clone(),
                                        inputs.capture_system_audio || mic_feed.is_some(),
                                    )
                                } else {
                                    let progressive_upload = InstantMultipartUpload::spawn(
                                        app_handle.clone(),
                                        recording_dir.join("content/output.mp4"),
                                        video_upload_info.clone(),
                                        upload_session,
                                        Some(finish_upload_rx.clone()),
                                        inputs.capture_system_audio || mic_feed.is_some(),
                                    );
                                    SegmentUploader {
                                        handle: progressive_upload.handle,
                                        session: progressive_upload.session,
                                    }
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
                        let mut state = state_mtx.write().await;
                        if clean_generation.is_some_and(|generation| {
                            !crate::clean_capture::is_current(&app_handle, generation)
                        }) || !matches!(state.recording_state, RecordingState::Pending { .. })
                        {
                            drop(state);
                            let _ = cancel_discarded_recording(&app_handle, actor).await;
                            return Err(anyhow!("Recording startup was cancelled or superseded"));
                        }
                        #[cfg(target_os = "linux")]
                        if inputs.mode == RecordingMode::Instant
                            && (linux_instant::current(&app_handle).is_none_or(|attempt| {
                                attempt.cancelled() || !attempt.owns_directory(&recording_dir)
                            }) || clean_generation.is_some_and(|generation| {
                                crate::clean_capture::stop_requested(&app_handle, generation)
                            }) || !app_handle
                                .state::<crate::RequestedInputsState>()
                                .is_current(&requested_inputs))
                        {
                            drop(state);
                            let _ = cancel_discarded_recording(&app_handle, actor).await;
                            return Err(anyhow!("Instant startup was cancelled"));
                        }
                        let done_fut = actor.done_fut();
                        let health_rx = actor.take_health_rx();
                        let mut candidate = Some(actor);
                        let published = app_handle
                            .state::<crate::RequestedInputsState>()
                            .publish_if_current(&requested_inputs, || {
                                state.selected_mic_label =
                                    requested_inputs.microphone.value.clone();
                                state.selected_camera_id = requested_inputs.camera.value.clone();
                                state.camera_in_use = has_camera_feed;
                                state.applied_mic_input.confirm();
                                state.set_current_recording(candidate.take().unwrap());
                                if let Some(generation) = clean_generation {
                                    crate::clean_capture::publish(
                                        &app_handle,
                                        generation,
                                        recording_dir.clone(),
                                    );
                                }
                            });
                        if !published {
                            drop(state);
                            let _ =
                                cancel_discarded_recording(&app_handle, candidate.take().unwrap())
                                    .await;
                            return Err(anyhow!(
                                "Input selection changed during recording startup. Try recording again."
                            ));
                        }
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
                            && !(inputs.mode == RecordingMode::Instant
                                && clean_generation.is_some())
                            && (mic_actor_not_running(&err) || mic_feed_locked(&err)) =>
                    {
                        mic_restart_attempts += 1;
                        warn!(
                            attempt = mic_restart_attempts,
                            error = %err,
                            "Recovering microphone feed before retrying recording start"
                        );
                        if clean_generation.is_some() {
                            if mic_feed_locked(&err) {
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                continue;
                            }
                            return Err(anyhow!(
                                "The selected microphone stopped during startup. Reselect it before recording: {err:#}"
                            ));
                        }
                        state_mtx
                            .write()
                            .await
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

    drop(_input_operation);
    if clean_generation
        .is_some_and(|generation| crate::clean_capture::stop_requested(&app, generation))
    {
        #[cfg(target_os = "linux")]
        if inputs.mode == RecordingMode::Instant {
            if let Some(attempt) = linux_instant::current(&app) {
                attempt.cancel();
            }
            return Err("Instant startup cancelled".into());
        }
        Box::pin(stop_recording(app.clone(), state_mtx.clone())).await?;
        return Ok(RecordingAction::Started);
    }

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
        #[cfg(any(target_os = "linux", windows))]
        let instant_watch = inputs.mode == RecordingMode::Instant;
        async move {
            fail!("recording::wait_actor_done");
            let disposition = {
                let res = actor_done_fut.await;
                #[cfg(target_os = "linux")]
                if instant_watch {
                    if let Some(attempt) = linux_instant::current(&app)
                        && attempt.owns_directory(&project_file_path)
                        && attempt.terminal_needs_cleanup()
                    {
                        let _ = linux_instant::control(app.clone(), attempt, false).await;
                    }
                    return;
                }
                #[cfg(target_os = "linux")]
                if !instant_watch {
                    let state = state_mtx.read().await;
                    if let Some(InProgressRecording::Studio { handle, common, .. }) =
                        state.current_recording()
                        && common.recording_dir == project_file_path
                        && handle.lifecycle().terminal_started()
                    {
                        return;
                    }
                }
                #[cfg(windows)]
                if !instant_watch {
                    let state = state_mtx.read().await;
                    if let Some(InProgressRecording::Studio { handle, common, .. }) =
                        state.current_recording()
                        && common.recording_dir == project_file_path
                        && handle.terminal_started()
                    {
                        return;
                    }
                }
                if let Some(generation) = clean_generation
                    && (crate::clean_capture::owner(&app, &project_file_path) != Some(generation)
                        || matches!(
                            crate::clean_capture::phase(&app),
                            Some(
                                crate::clean_capture::Phase::Stopping
                                    | crate::clean_capture::Phase::Restoring
                            )
                        ))
                {
                    return;
                }
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
                    #[cfg(any(target_os = "linux", windows))]
                    if !instant_watch {
                        let _ = control_studio_recording(
                            &app,
                            &state_mtx,
                            Some(&project_file_path),
                            StudioTerminalAction::Stop,
                            Some(error),
                        )
                        .await;
                        return;
                    }
                    let mut state = state_mtx.write().await;
                    if let Some(generation) = clean_generation
                        && (crate::clean_capture::owner(&app, &project_file_path)
                            != Some(generation)
                            || state.current_recording().is_none_or(|recording| {
                                recording.recording_dir() != &project_file_path
                            })
                            || matches!(
                                crate::clean_capture::phase(&app),
                                Some(
                                    crate::clean_capture::Phase::Stopping
                                        | crate::clean_capture::Phase::Restoring
                                )
                            ))
                    {
                        return;
                    }

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

                    if crate::clean_capture::phase(&app).is_none() {
                        dialog.blocking_show();
                    }

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
                        use crate::recording_telemetry::{CriticalEvent, mode_label};
                        use crate::telemetry::{AnalyticsEvent, async_capture_event};
                        match critical {
                            CriticalEvent::MuxerCrashed {
                                seconds_into_recording,
                                ..
                            } => {
                                async_capture_event(
                                    &app,
                                    AnalyticsEvent::RecordingMuxerCrashed {
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
                                    AnalyticsEvent::RecordingAudioDegraded {
                                        mode: mode_label(*mode),
                                        reason: reason_text,
                                        seconds_into_recording,
                                    },
                                );
                            }
                        }
                    }

                    if let Some((_, mode)) = accumulator_mode.as_ref() {
                        use crate::recording_telemetry::mode_label;
                        use crate::telemetry::{AnalyticsEvent, async_capture_event};
                        let mode_str = mode_label(*mode);
                        match &event {
                            cap_recording::PipelineHealthEvent::DiskSpaceLow {
                                bytes_remaining,
                                ..
                            } => async_capture_event(
                                &app,
                                AnalyticsEvent::RecordingDiskSpaceLow {
                                    mode: mode_str,
                                    bytes_remaining: *bytes_remaining,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::DiskSpaceExhausted {
                                bytes_remaining,
                            } => async_capture_event(
                                &app,
                                AnalyticsEvent::RecordingDiskSpaceExhausted {
                                    mode: mode_str,
                                    bytes_remaining: *bytes_remaining,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::DeviceLost { subsystem } => {
                                async_capture_event(
                                    &app,
                                    AnalyticsEvent::RecordingDeviceLost {
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
                                AnalyticsEvent::RecordingEncoderRebuilt {
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
                                AnalyticsEvent::RecordingSourceAudioReset {
                                    mode: mode_str,
                                    source: source.clone(),
                                    starvation_ms: *starvation_ms,
                                },
                            ),
                            cap_recording::PipelineHealthEvent::CaptureTargetLost { target } => {
                                async_capture_event(
                                    &app,
                                    AnalyticsEvent::RecordingCaptureTargetLost {
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
    if crate::clean_capture::phase(&app).is_some() {
        return crate::clean_capture::control(&app, false).await;
    }
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
    let requested = app.state::<crate::RequestedInputsState>();
    let _input_operation = requested.try_resume_guard()?;
    if crate::clean_capture::phase(&app).is_some() {
        requested.ensure_ready_for_resume()?;
        return crate::clean_capture::control(&app, true).await;
    }
    let mut state = state.write().await;
    requested.ensure_ready_for_resume()?;

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
    if crate::clean_capture::phase(&app).is_some() {
        if crate::clean_capture::is_paused(&app).await? {
            let requested = app.state::<crate::RequestedInputsState>();
            let _input_operation = requested.try_resume_guard()?;
            return crate::clean_capture::control(&app, true).await;
        }
        return crate::clean_capture::control(&app, false).await;
    }
    let state = state.read().await;

    if let Some(recording) = state.current_recording() {
        if recording.is_paused().await.map_err(|e| e.to_string())? {
            let requested = app.state::<crate::RequestedInputsState>();
            let _input_operation = requested.try_resume_guard()?;
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
    #[cfg(target_os = "linux")]
    if linux_instant::current(app).is_some_and(|attempt| attempt.owns_directory(recording_dir)) {
        notify_recording_start_failed(app, &message);
        return Err(message);
    }
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

    if !is_device_not_found && crate::clean_capture::phase(app).is_none() {
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
            #[cfg(target_os = "linux")]
            {
                if let Some(attempt) = linux_instant::current(app) {
                    attempt.cancel();
                }
                if let Err(error) = handle.cancel().await {
                    warn!(%error, "Instant cancellation failed");
                }
                if handle.lifecycle().wait_for_quiescence().await
                    != instant_recording::InstantQuiescence::Joined
                {
                    return None;
                }
                if let Some(attempt) = linux_instant::current(app)
                    && !attempt.upload_cleanup().await
                {
                    return None;
                }
                let _ = await_instant_upload(segment_upload).await;
            }
            #[cfg(not(target_os = "linux"))]
            {
                segment_upload.session.mark_cancelled().ok();
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
    if let Some(video_id) = video_id {
        delete_remote_instant_video(app, &video_id).await?;
    }
    remove_recording_dir(&recording_dir).await
}

#[cfg(target_os = "linux")]
async fn after_studio_join<T, F>(
    stop: impl std::future::Future<Output = studio_recording::StudioStopReport>,
    finish: impl FnOnce(Result<studio_recording::CompletedRecording, String>) -> F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let report = stop.await;
    if !report.accepted_intent {
        return Err("Another Studio terminal action owns cleanup".into());
    }
    if report.quiescence != studio_recording::StudioQuiescence::Joined {
        return Err("Studio cleanup is unconfirmed; recording and Stop control retained".into());
    }
    finish(report.result).await
}

#[cfg(any(target_os = "linux", windows))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum StudioTerminalAction {
    Stop,
    Discard,
    Restart,
}

#[cfg(target_os = "linux")]
async fn control_studio_recording(
    app: &AppHandle,
    state: &Arc<tokio::sync::RwLock<App>>,
    expected_directory: Option<&Path>,
    action: StudioTerminalAction,
    failure: Option<String>,
) -> Option<Result<(), String>> {
    let (handle, directory, target_name, capture_target, generation) = {
        let state = state.read().await;
        let InProgressRecording::Studio { handle, common, .. } = state.current_recording()? else {
            return None;
        };
        if expected_directory.is_some_and(|expected| expected != common.recording_dir) {
            return Some(Err(
                "Studio terminal operation belongs to an older recording".into(),
            ));
        }
        (
            handle.clone(),
            common.recording_dir.clone(),
            common.target_name.clone(),
            common.inputs.capture_target.clone(),
            crate::clean_capture::owner(app, &common.recording_dir),
        )
    };
    let discard = action != StudioTerminalAction::Stop;
    let intent = if discard {
        studio_recording::StudioStopIntent::Discard
    } else {
        studio_recording::StudioStopIntent::Preserve
    };
    let stopping = handle.clone();
    Some(
        after_studio_join(
            async move { stopping.stop_with_intent(intent).await },
            |result| async move {
                let outcome = match failure {
                    Some(error) => Err(error),
                    None => result,
                };
                if discard && let Err(error) = &outcome {
                    return Err(error.clone());
                }
                let mut state = state.write().await;
                let current = match state.current_recording() {
                    Some(InProgressRecording::Studio {
                        handle: current,
                        common,
                        ..
                    }) => {
                        common.recording_dir == directory
                            && current.lifecycle().same_attempt(&handle.lifecycle())
                            && crate::clean_capture::owner(app, &directory) == generation
                    }
                    _ => false,
                };
                if !current {
                    return Err("Studio terminal completion is stale".into());
                }
                if discard && let Err(error) = remove_recording_dir(&directory).await {
                    return Err(error);
                }
                let error = outcome.as_ref().err().cloned();
                let completed = if discard {
                    Err("Recording discarded after confirmed capture shutdown".into())
                } else {
                    outcome.map(|recording| CompletedRecording::Studio {
                        recording,
                        target_name,
                        capture_target,
                    })
                };
                if let Some(error) = &error {
                    let _ = RecordingEvent::Failed {
                        error: error.clone(),
                    }
                    .emit(app);
                }
                let cleanup = handle_recording_end_inner(
                    app.clone(),
                    completed,
                    &mut state,
                    directory,
                    action == StudioTerminalAction::Restart,
                )
                .await;
                match error {
                    Some(error) => Err(error),
                    None => cleanup,
                }
            },
        )
        .await,
    )
}

#[cfg(windows)]
async fn after_windows_studio_stop<T, F>(
    stop: impl std::future::Future<Output = studio_recording::WindowsStudioStopReport>,
    finish: impl FnOnce(studio_recording::CompletedRecording) -> F,
) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    let report = stop.await;
    if !report.accepted_intent {
        return Err("Another Studio terminal action owns cleanup".into());
    }
    if !report.stop_acknowledged {
        return Err(format!(
            "Studio cleanup is unconfirmed; recording and Stop control retained: {}",
            report
                .result
                .err()
                .unwrap_or_else(|| "terminal acknowledgement missing".into())
        ));
    }
    finish(report.result?).await
}

#[cfg(windows)]
async fn control_studio_recording(
    app: &AppHandle,
    state: &Arc<tokio::sync::RwLock<App>>,
    expected_directory: Option<&Path>,
    action: StudioTerminalAction,
    failure: Option<String>,
) -> Option<Result<(), String>> {
    let (handle, directory, target_name, capture_target, generation) = {
        let state = state.read().await;
        let InProgressRecording::Studio { handle, common, .. } = state.current_recording()? else {
            return None;
        };
        if expected_directory.is_some_and(|expected| expected != common.recording_dir) {
            return Some(Err(
                "Studio terminal operation belongs to an older recording".into(),
            ));
        }
        (
            handle.clone(),
            common.recording_dir.clone(),
            common.target_name.clone(),
            common.inputs.capture_target.clone(),
            crate::clean_capture::owner(app, &common.recording_dir),
        )
    };
    let discard = action != StudioTerminalAction::Stop;
    let intent = if discard {
        studio_recording::StudioStopIntent::Discard
    } else {
        studio_recording::StudioStopIntent::Preserve
    };
    let stopping = handle.clone();
    let finishing = handle.clone();
    let result = after_windows_studio_stop(
        async move { stopping.stop_with_intent(intent).await },
        |recording| async move {
            let mut state = state.write().await;
            let current = match state.current_recording() {
                Some(InProgressRecording::Studio {
                    handle: current,
                    common,
                    ..
                }) => {
                    common.recording_dir == directory
                        && current.same_attempt(&finishing)
                        && crate::clean_capture::owner(app, &directory) == generation
                }
                _ => false,
            };
            if !current {
                return Err("Studio terminal completion is stale".into());
            }
            if let Some(error) = failure {
                return Err(error);
            }
            if discard {
                remove_recording_dir(&directory).await?;
            }
            let completed = if discard {
                Err("Recording discarded after Studio stop acknowledgement".into())
            } else {
                Ok(CompletedRecording::Studio {
                    recording,
                    target_name,
                    capture_target,
                })
            };
            handle_recording_end_inner(
                app.clone(),
                completed,
                &mut state,
                directory,
                action == StudioTerminalAction::Restart,
            )
            .await
        },
    )
    .await;
    if let Err(error) = &result {
        let state = state.read().await;
        if let Some(InProgressRecording::Studio {
            handle: current,
            common,
            ..
        }) = state.current_recording()
            && current.same_attempt(&handle)
            && expected_directory.is_none_or(|expected| expected == common.recording_dir)
        {
            let _ = RecordingEvent::Failed {
                error: error.clone(),
            }
            .emit(app);
        }
    }
    Some(result)
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn stop_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(attempt) = linux_instant::current(&app) {
        return linux_instant::control(app, attempt, false).await;
    }
    if crate::clean_capture::queue_stop(&app) {
        return Ok(());
    }
    #[cfg(any(target_os = "linux", windows))]
    if let Some(result) =
        control_studio_recording(&app, &state, None, StudioTerminalAction::Stop, None).await
    {
        return result;
    }
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
                #[cfg(not(target_os = "linux"))]
                {
                    ctx.segment_upload.session.cancel();
                    let _ = ctx.segment_upload.handle.await;
                }
                #[cfg(target_os = "linux")]
                if let Some(attempt) = linux_instant::current(&app) {
                    attempt.cancel();
                }
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
    #[cfg(target_os = "linux")]
    if let Some(attempt) = linux_instant::current(&app) {
        let inputs = state
            .read()
            .await
            .current_recording()
            .ok_or("No recording in progress")?
            .inputs()
            .clone();
        let restore_generation =
            crate::clean_capture::phase(&app).map(|_| crate::clean_capture::generation(&app));
        linux_instant::control(app.clone(), attempt, true).await?;
        if let Some(generation) = restore_generation {
            crate::clean_capture::wait_restored(&app, generation).await?;
        }
        return Box::pin(start_recording(app, state, inputs)).await;
    }
    #[cfg(any(target_os = "linux", windows))]
    {
        let current = {
            let state = state.read().await;
            match state.current_recording() {
                Some(InProgressRecording::Studio { common, .. }) => Some((
                    common.inputs.clone(),
                    common.recording_dir.clone(),
                    crate::clean_capture::owner(&app, &common.recording_dir),
                )),
                _ => None,
            }
        };
        if let Some((inputs, directory, generation)) = current {
            return complete_studio_restart(async move {
                let state = app.state::<crate::ArcLock<App>>();
                let target = EditorRecordingTarget::get(&app);
                restart_with_editor_target(
                    &target,
                    async {
                        control_studio_recording(
                            &app,
                            &state,
                            Some(&directory),
                            StudioTerminalAction::Restart,
                            None,
                        )
                        .await
                        .ok_or("Studio recording changed before restart")??;
                        Ok(())
                    },
                    async {
                        #[cfg(target_os = "linux")]
                        if let Some(generation) = generation {
                            crate::clean_capture::wait_restored(&app, generation).await?;
                        }
                        #[cfg(windows)]
                        let _ = generation;
                        Ok(())
                    },
                    || Box::pin(start_recording(app.clone(), app.state(), inputs)),
                    |expected, cleanup_completed| {
                        let app = &app;
                        let state = &state;
                        let target = &target;
                        async move {
                            let state = state.read().await;
                            if let Some(editor_path) = take_failed_restart_editor_target(
                                target,
                                expected.as_deref(),
                                cleanup_completed
                                    && matches!(state.recording_state, RecordingState::None),
                            ) && let Some(window) = editor_window_for_path(app, &editor_path)
                            {
                                let _ = window.unminimize();
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    },
                )
                .await
            })
            .await;
        }
    }
    if crate::clean_capture::phase(&app) == Some(crate::clean_capture::Phase::Recording) {
        crate::clean_capture::control(&app, false).await?;
    }

    let (recording, clean_generation) = {
        let mut state = state.write().await;
        let recording = state
            .current_recording()
            .ok_or("No recording in progress")?;
        let generation = crate::clean_capture::begin_restart(&app, recording.recording_dir())?;
        (state.clear_current_recording().unwrap(), generation)
    };

    let _ = CurrentRecordingChanged.emit(&app);

    let inputs = recording.inputs().clone();
    let recording_dir = recording.recording_dir().clone();

    let upload_session = match &recording {
        InProgressRecording::Instant { segment_upload, .. } => {
            #[cfg(not(target_os = "linux"))]
            let session = segment_upload.session.clone();
            #[cfg(target_os = "linux")]
            let session = segment_upload.lock().await.session.clone();
            Some(session)
        }
        _ => None,
    };
    let video_id = cancel_discarded_recording(&app, recording).await;
    if let (Some(video_id), Some(session)) = (video_id, upload_session) {
        let cleanup_app = app.clone();
        let cleanup_directory = recording_dir.clone();
        if let Err(error) = crate::upload::lifecycle::supervise(app.clone(), session, async move {
            delete_remote_instant_video(&cleanup_app, &video_id)
                .await
                .map_err(AuthedApiError::from)?;
            remove_recording_dir(&cleanup_directory)
                .await
                .map_err(AuthedApiError::from)
        })
        .await
        {
            warn!(%error, "Restart retained the cancelled recording");
        }
    } else if let Err(error) = remove_recording_dir(&recording_dir).await {
        warn!(%error, "Failed to delete recording files while restarting");
    }

    if let Some(generation) = clean_generation {
        let result = async {
            crate::clean_capture::hide(&app, generation).await?;
            let requested = app
                .state::<crate::RequestedInputsState>()
                .ready_snapshot()?;
            crate::clean_capture::prepare(&app, &inputs, Some(generation)).await?;
            state
                .write()
                .await
                .set_pending_recording(inputs.mode, inputs.capture_target.clone())?;
            start_recording_prepared(
                app.clone(),
                state.clone(),
                inputs,
                requested,
                Some(generation),
            )
            .await
        }
        .await;
        if !matches!(&result, Ok(RecordingAction::Started)) {
            state.write().await.clear_pending_recording();
            crate::clean_capture::release(&app, generation, false);
        }
        return result;
    }
    start_recording(app.clone(), state, inputs).await
}

#[cfg(any(target_os = "linux", windows, test))]
async fn complete_studio_restart(
    restart: impl std::future::Future<Output = Result<RecordingAction, String>> + Send + 'static,
) -> Result<RecordingAction, String> {
    tokio::spawn(restart)
        .await
        .map_err(|error| format!("Recording restart task failed: {error}"))?
}

#[cfg(any(target_os = "linux", windows, test))]
async fn restart_with_editor_target<C, R, S, F>(
    target: &EditorRecordingTarget,
    cleanup: C,
    restore: R,
    start: impl FnOnce() -> S,
    on_failure: impl FnOnce(Option<PathBuf>, bool) -> F,
) -> Result<RecordingAction, String>
where
    C: std::future::Future<Output = Result<(), String>>,
    R: std::future::Future<Output = Result<(), String>>,
    S: std::future::Future<Output = Result<RecordingAction, String>>,
    F: std::future::Future<Output = ()>,
{
    let expected = target.0.lock().unwrap().clone();
    let cleanup_result = cleanup.await;
    let cleanup_completed = cleanup_result.is_ok();
    let result = match cleanup_result {
        Ok(()) => match restore.await {
            Ok(()) => {
                let unchanged = *target.0.lock().unwrap() == expected;
                if unchanged {
                    start().await
                } else {
                    Err("Recording editor target changed before restart".into())
                }
            }
            Err(error) => Err(error),
        },
        Err(error) => Err(error),
    };
    if !matches!(&result, Ok(RecordingAction::Started)) {
        on_failure(expected, cleanup_completed).await;
    }
    result
}

#[cfg(any(target_os = "linux", windows, test))]
fn take_failed_restart_editor_target(
    target: &EditorRecordingTarget,
    expected: Option<&Path>,
    recording_cleared: bool,
) -> Option<PathBuf> {
    if !recording_cleared {
        return None;
    }
    let mut current = target.0.lock().unwrap();
    if current.as_deref() == expected {
        current.take()
    } else {
        None
    }
}

fn take_editor_target_after_recording(
    target: &EditorRecordingTarget,
    preserve: bool,
) -> Option<PathBuf> {
    if preserve {
        None
    } else {
        target.0.lock().unwrap().take()
    }
}

#[tauri::command]
#[specta::specta]
#[instrument(skip(app, state))]
pub async fn delete_recording(app: AppHandle, state: MutableState<'_, App>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(attempt) = linux_instant::current(&app) {
        return linux_instant::control(app, attempt, true).await;
    }
    #[cfg(any(target_os = "linux", windows))]
    if let Some(result) =
        control_studio_recording(&app, &state, None, StudioTerminalAction::Discard, None).await
    {
        return result;
    }
    if crate::clean_capture::phase(&app) == Some(crate::clean_capture::Phase::Recording) {
        crate::clean_capture::control(&app, false).await?;
    }

    if matches!(
        crate::clean_capture::phase(&app),
        Some(
            crate::clean_capture::Phase::Starting
                | crate::clean_capture::Phase::AwaitingShortcut
                | crate::clean_capture::Phase::Pausing
                | crate::clean_capture::Phase::Resuming
                | crate::clean_capture::Phase::ResumeFailed
                | crate::clean_capture::Phase::Restarting
        )
    ) {
        return Err("Recording is changing state. Use Ctrl+Shift+F9 to stop.".into());
    }
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

        let clean_generation = crate::clean_capture::owner(&app, recording.recording_dir());
        if let Some(generation) = clean_generation {
            crate::clean_capture::set_phase(
                &app,
                generation,
                crate::clean_capture::Phase::Stopping,
            );
        }
        let delete_result = discard_recording(&app, recording).await;
        if let Some(generation) = clean_generation {
            crate::clean_capture::release(&app, generation, false);
        }

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
    handle_recording_end_inner(handle, recording, app, recording_dir, false).await
}

async fn handle_recording_end_inner(
    handle: AppHandle,
    recording: Result<CompletedRecording, String>,
    app: &mut App,
    recording_dir: PathBuf,
    preserve_editor_target: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if let Some(InProgressRecording::Studio {
        handle: studio,
        common,
        ..
    }) = app.current_recording()
        && common.recording_dir == recording_dir
        && studio.lifecycle().quiescence() != studio_recording::StudioQuiescence::Joined
    {
        return Err("Studio capture cleanup is unconfirmed; active recording retained".into());
    }
    #[cfg(windows)]
    if let Some(InProgressRecording::Studio {
        handle: studio,
        common,
        ..
    }) = app.current_recording()
        && common.recording_dir == recording_dir
        && !studio.stop_acknowledged()
    {
        return Err("Studio stop is unconfirmed; active recording retained".into());
    }
    #[cfg(target_os = "linux")]
    if linux_instant::current(&handle)
        .is_some_and(|attempt| attempt.owns_directory(&recording_dir) && !attempt.capture_joined())
    {
        return Err("Instant capture cleanup is unconfirmed; recording state retained".into());
    }
    #[cfg(target_os = "linux")]
    let strict_attempt =
        linux_instant::current(&handle).filter(|attempt| attempt.owns_directory(&recording_dir));
    #[cfg(target_os = "linux")]
    let mut recording = match &strict_attempt {
        Some(attempt) => attempt.checked(recording),
        None => recording,
    };
    let clean_generation = crate::clean_capture::owner(&handle, &recording_dir);
    if crate::clean_capture::phase(&handle).is_some() && clean_generation.is_none() {
        return Ok(());
    }
    let cleared = app.clear_recording_state();
    #[cfg(not(target_os = "linux"))]
    let mut cleared = cleared;

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
        let drop_rate_pct = 0.0_f64;
        let dropped_mic_messages = match mic_feed {
            Some(feed) => feed.dropped_message_count().await,
            None => 0,
        };
        #[cfg(target_os = "linux")]
        if let Some(attempt) = &strict_attempt {
            recording = attempt.checked(recording);
        }
        let (status, error_class) = match &recording {
            Ok(_) => ("stopped", None),
            Err(e) => ("failed", Some(classify_error_message(e.as_str()))),
        };
        crate::telemetry::async_capture_event(
            &handle,
            crate::telemetry::AnalyticsEvent::RecordingCompleted {
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
        info!("Ending upload after recording failure");
        #[cfg(not(target_os = "linux"))]
        segment_upload.session.cancel();
        #[cfg(target_os = "linux")]
        {
            let _ = segment_upload;
            if let Some(attempt) = linux_instant::current(&handle) {
                attempt.upload().deny();
            }
        }
        crate::upload::emit_upload_complete(&handle, &video_upload_info.id);
    }

    #[cfg(not(target_os = "linux"))]
    if recording.is_err()
        && let Some(InProgressRecording::Instant { segment_upload, .. }) = cleared.take()
    {
        let session = segment_upload.session.clone();
        let _ = crate::upload::lifecycle::supervise(handle.clone(), session, async move {
            segment_upload
                .handle
                .await
                .map_err(|error| error.to_string())?
        })
        .await;
    }
    drop(cleared);

    if app.was_camera_only_recording {
        app.was_camera_only_recording = false;
    }

    #[cfg(target_os = "linux")]
    if let Some(attempt) = &strict_attempt {
        recording = attempt.checked(recording);
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
    app.applied_mic_input.invalidate();
    let _ = app.mic_feed.ask(microphone::RemoveInput).await;
    let _ = app.camera_feed.ask(camera::RemoveInput).await;

    let main_window = CapWindowId::Main.get(&handle);

    // When the finish path handed the foreground to an editor window, leave
    // the main window alone: un-minimizing it here (Windows `Close` behaviour
    // minimizes; macOS `Minimise` miniaturizes) would restore it on top of the
    // editor that just opened.
    let mut editor_took_foreground = matches!(&res, Some(Ok(true)));

    if let Some(window) = main_window {
        if !editor_took_foreground && clean_generation.is_none() {
            window.unminimize().ok();
        }
        let requested = handle.state::<crate::RequestedInputsState>().snapshot();
        if clean_generation.is_none()
            && !requested.microphone.pending
            && requested.microphone.error.is_none()
            && requested.microphone.value == app.selected_mic_label
            && let Err(err) = app.ensure_selected_mic_ready().await
        {
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
    if let Some(editor_path) = take_editor_target_after_recording(
        &EditorRecordingTarget::get(&handle),
        preserve_editor_target,
    ) && let Some(editor_window) = editor_window_for_path(&handle, &editor_path)
    {
        editor_took_foreground = true;
        let _ = editor_window.unminimize();
        let _ = editor_window.show();
        let _ = editor_window.set_focus();
    }

    CurrentRecordingChanged.emit(&handle).ok();
    if let Some(generation) = clean_generation {
        crate::clean_capture::release_after_recording(&handle, generation, editor_took_foreground);
    }

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
            #[cfg(target_os = "linux")]
            finalized,
            recording,
            segment_upload,
            video_upload_info,
            ..
        } => {
            #[cfg(target_os = "linux")]
            if finalized {
                if let Some(attempt) = linux_instant::current(app) {
                    attempt.checked(Ok(()))?;
                }
                return Ok(false);
            }
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

            #[cfg(not(target_os = "linux"))]
            let session = segment_upload.session.clone();
            #[cfg(target_os = "linux")]
            let session = segment_upload.lock().await.session.clone();
            session
                .persist_local_complete(
                    recording.meta.clone(),
                    SharingMeta {
                        id: video_upload_info.id.clone(),
                        link: video_upload_info.link.clone(),
                        content_hash: None,
                    },
                )
                .map_err(|error| error.to_string())?;
            session
                .mark_ready(false)
                .map_err(|error| error.to_string())?;
            let job_session = session.clone();
            crate::upload::lifecycle::supervise(app.clone(), session, {
                let video = video_upload_info.clone();
                let recording_dir = recording_dir.clone();
                async move {
                    let uploaded = await_instant_upload(segment_upload).await;
                    let screenshot = screenshot_task.await;
                    uploaded.map_err(AuthedApiError::from)??;
                    screenshot
                        .map_err(|error| error.to_string())?
                        .map_err(AuthedApiError::from)?;
                    job_session.check()?;
                    let bytes = compress_image(display_screenshot).await?;
                    crate::upload::singlepart_uploader(
                        app.clone(),
                        crate::api::PresignedS3PutRequest {
                            video_id: video.id.clone(),
                            subpath: "screenshot/screen-capture.jpg".into(),
                            method: PresignedS3PutRequestMethod::Put,
                            meta: None,
                        },
                        bytes.len() as u64,
                        stream::once(
                            async move { Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)) },
                        ),
                    )
                    .await?;
                    job_session.complete_locally(&app).await?;
                    crate::automation::run_upload_completed_automations(
                        app,
                        recording_dir,
                        Some(video.link),
                        Some(video.id),
                    );
                    Ok(())
                }
            })
            .await
            .map_err(|error| error.to_string())?;

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

pub const DEFAULT_AUTO_ZOOM_AMOUNT: f64 = 2.0;

fn generate_zoom_segments_from_clicks_impl(
    mut clicks: Vec<CursorClickEvent>,
    _moves: Vec<CursorMoveEvent>,
    max_duration: f64,
    zoom_amount: f64,
) -> Vec<ZoomSegment> {
    const MS_PER_SECOND: f64 = 1000.0;
    const START_MIN_MS: f64 = 1.0;
    const CLICK_PRE_PADDING_MS: f64 = 300.0;
    const CLICK_POST_PADDING_MS: f64 = 2500.0;
    const CLICK_END_CLAMP_PADDING_MS: f64 = 800.0;
    const TRAILING_CLICK_IGNORE_MS: f64 = 1000.0;
    const MERGE_GAP_MS: f64 = 2500.0;

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
            amount: zoom_amount,
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
    zoom_amount: f64,
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

    generate_zoom_segments_for_project(&recording_meta, recordings, zoom_amount)
}

/// Generates zoom segments from clicks for an existing project.
/// Used in the editor context where we have RecordingMeta.
pub fn generate_zoom_segments_for_project(
    recording_meta: &RecordingMeta,
    recordings: &ProjectRecordingsMeta,
    zoom_amount: f64,
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

    generate_zoom_segments_from_clicks_impl(
        all_clicks,
        all_moves,
        recordings.duration(),
        zoom_amount,
    )
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
    if using_default_config {
        let library = app
            .store("store")
            .ok()
            .and_then(|store| store.get("animated_gradients"))
            .and_then(|value| serde_json::from_value(value).ok());
        apply_animated_gradient_default(
            &mut config,
            library.as_ref(),
            using_default_config,
            capture_target,
        );
    }
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
        generate_zoom_segments_from_clicks(
            completed_recording,
            recordings,
            settings
                .default_zoom_amount
                .unwrap_or(DEFAULT_AUTO_ZOOM_AMOUNT),
        )
    } else {
        Vec::new()
    };

    if should_enable_notch_overlay(
        capture_target,
        settings.macbook_notch_overlay.unwrap_or(false),
        completed_recording.meta.display_notch().is_some(),
    ) {
        config.background.notch = Some(cap_project::NotchConfiguration {
            enabled: true,
            ..Default::default()
        });
    }

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
        camera3d_segments: Vec::new(),
    });

    config
}

fn should_enable_notch_overlay(
    capture_target: Option<&ScreenCaptureTarget>,
    setting_enabled: bool,
    has_recorded_notch: bool,
) -> bool {
    setting_enabled
        && has_recorded_notch
        && matches!(
            capture_target,
            Some(ScreenCaptureTarget::Display { .. } | ScreenCaptureTarget::Area { .. })
        )
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

fn apply_animated_gradient_default(
    config: &mut ProjectConfiguration,
    library: Option<&cap_project::AnimatedGradientLibrary>,
    using_default_config: bool,
    capture_target: Option<&ScreenCaptureTarget>,
) {
    if using_default_config
        && !matches!(capture_target, Some(ScreenCaptureTarget::CameraOnly))
        && let Some(library) = library
        && library.selected
        && let Some(gradient) = &library.last_used
    {
        config.background.source = cap_project::BackgroundSource::AnimatedGradient {
            config: gradient.normalized(),
        };
    }
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

                    crate::telemetry::async_capture_event(
                        app_handle,
                        crate::telemetry::AnalyticsEvent::RecordingRecovered {
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
                    crate::telemetry::async_capture_event(
                        app_handle,
                        crate::telemetry::AnalyticsEvent::RecordingRecoveryFailed {
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
    use crate::recording_telemetry::{mode_label, target_kind_label};
    use crate::telemetry::{AnalyticsEvent, async_capture_event};

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
        AnalyticsEvent::RecordingStarted {
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

    #[test]
    fn requested_microphone_absence_is_an_error_not_an_empty_track() {
        let error = selected_microphone_for_start(Some("Requested mic".into()), &[])
            .unwrap_err()
            .to_string();
        assert!(error.contains("Requested mic"));
        assert!(error.contains("no longer available"));
        assert!(error.contains("Reconnect"));
    }

    #[test]
    fn requested_microphone_requires_exact_name_without_substring_fallback() {
        for names in [
            vec!["Requested mic alternate".into()],
            vec!["mic".into()],
            vec!["requested mic".into()],
        ] {
            assert!(selected_microphone_for_start(Some("Requested mic".into()), &names).is_err());
        }
        assert_eq!(
            selected_microphone_for_start(
                Some("Requested mic".into()),
                &["Requested mic alternate".into(), "Requested mic".into()],
            )
            .unwrap(),
            Some("Requested mic".into())
        );
    }

    #[test]
    fn intentional_no_microphone_is_preserved() {
        assert_eq!(selected_microphone_for_start(None, &[]).unwrap(), None);
        assert_eq!(
            selected_microphone_for_start(None, &["Another mic".into()]).unwrap(),
            None
        );
    }

    #[test]
    fn requested_camera_absence_is_an_error_for_screen_capture_too() {
        let id = camera::DeviceOrModelID::DeviceID("requested-camera".into());
        let error = validate_selected_camera_for_start(Some(&id), |_| false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("requested-camera"));
        assert!(error.contains("no longer available"));
        assert!(error.contains("Reconnect"));
        assert!(validate_selected_camera_for_start(Some(&id), |_| true).is_ok());
    }

    #[test]
    fn intentional_no_camera_does_not_probe_or_choose_another_device() {
        assert!(
            validate_selected_camera_for_start(None, |_| { panic!("No camera was requested") })
                .is_ok()
        );
    }

    #[test]
    fn animated_gradient_default_is_remembered_without_overwriting_explicit_presets() {
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(cap_project::AnimatedGradientConfig::from_seed(42)),
            ..Default::default()
        };
        let mut project = ProjectConfiguration::default();
        apply_animated_gradient_default(&mut project, Some(&library), false, None);
        assert!(matches!(
            project.background.source,
            cap_project::BackgroundSource::Color { .. }
        ));
        apply_animated_gradient_default(&mut project, Some(&library), true, None);
        apply_screen_recording_presentation_defaults(
            &mut project,
            None,
            true,
            Some("wallpaper.jpg".into()),
        );
        let cap_project::BackgroundSource::AnimatedGradient { config } = project.background.source
        else {
            panic!("Expected remembered gradient");
        };
        assert_eq!(Some(config), library.last_used);
        assert_eq!(project.background.padding, 10.0);
    }

    #[test]
    fn deselected_or_missing_animated_gradient_keeps_recording_defaults() {
        let mut project = ProjectConfiguration::default();
        let library = cap_project::AnimatedGradientLibrary {
            last_used: Some(cap_project::AnimatedGradientConfig::default()),
            ..Default::default()
        };
        apply_animated_gradient_default(&mut project, Some(&library), true, None);
        apply_animated_gradient_default(&mut project, None, true, None);
        assert!(matches!(
            project.background.source,
            cap_project::BackgroundSource::Color { .. }
        ));
    }

    #[test]
    fn animated_gradient_default_preserves_camera_only_presentation() {
        let library = cap_project::AnimatedGradientLibrary {
            selected: true,
            last_used: Some(cap_project::AnimatedGradientConfig::default()),
            ..Default::default()
        };
        let mut project = ProjectConfiguration::default();
        let original = serde_json::to_value(&project.background).unwrap();
        apply_animated_gradient_default(
            &mut project,
            Some(&library),
            true,
            Some(&ScreenCaptureTarget::CameraOnly),
        );
        assert_eq!(serde_json::to_value(project.background).unwrap(), original);
    }

    #[test]
    fn recording_start_preflight_requires_authentication_for_instant_recordings() {
        assert_eq!(
            recording_start_mode_error(RecordingMode::Instant, false),
            Some("Please sign in to use instant recording")
        );
        assert_eq!(
            recording_start_mode_error(RecordingMode::Instant, true),
            None
        );
    }

    #[test]
    fn recording_start_preflight_preserves_studio_and_rejects_screenshot_modes() {
        assert_eq!(
            recording_start_mode_error(RecordingMode::Studio, false),
            None
        );
        assert_eq!(
            recording_start_mode_error(RecordingMode::Screenshot, true),
            Some("Use take_screenshot for screenshots")
        );
    }

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
        let segments = generate_zoom_segments_from_clicks_impl(
            vec![click_event(11_900.0)],
            vec![],
            12.0,
            DEFAULT_AUTO_ZOOM_AMOUNT,
        );

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

        let segments =
            generate_zoom_segments_from_clicks_impl(clicks, moves, 20.0, DEFAULT_AUTO_ZOOM_AMOUNT);

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

        let segments = generate_zoom_segments_from_clicks_impl(
            clicks,
            moves,
            19.436_667,
            DEFAULT_AUTO_ZOOM_AMOUNT,
        );

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].start, 1.971);
        assert_eq!(segments[0].end, 4.771);
        assert_eq!(segments[1].start, 8.837);
        assert_eq!(segments[1].end, 12.415);
    }

    #[test]
    fn extends_segment_until_after_mouse_up() {
        let clicks = vec![click_event(1_000.0), click_up_event(2_500.0)];

        let segments =
            generate_zoom_segments_from_clicks_impl(clicks, vec![], 10.0, DEFAULT_AUTO_ZOOM_AMOUNT);

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start, 0.7);
        assert_eq!(segments[0].end, 5.0);
    }

    #[test]
    fn clamps_zoom_end_before_recording_end() {
        let clicks = vec![click_event(8_999.0), click_event(9_000.0)];

        let segments =
            generate_zoom_segments_from_clicks_impl(clicks, vec![], 10.0, DEFAULT_AUTO_ZOOM_AMOUNT);

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

        let segments = generate_zoom_segments_from_clicks_impl(
            Vec::new(),
            jitter_moves,
            15.0,
            DEFAULT_AUTO_ZOOM_AMOUNT,
        );

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
    fn notch_overlay_requires_recorded_geometry_on_screen_target() {
        let display = ScreenCaptureTarget::Display {
            id: "1".parse().unwrap(),
        };
        let area = ScreenCaptureTarget::Area {
            screen: "1".parse().unwrap(),
            bounds: scap_targets::bounds::LogicalBounds::new(
                scap_targets::bounds::LogicalPosition::new(0.0, 0.0),
                scap_targets::bounds::LogicalSize::new(100.0, 100.0),
            ),
        };

        assert!(should_enable_notch_overlay(Some(&display), true, true));
        assert!(should_enable_notch_overlay(Some(&area), true, true));
        assert!(!should_enable_notch_overlay(Some(&display), true, false));
        assert!(!should_enable_notch_overlay(Some(&area), true, false));
        assert!(!should_enable_notch_overlay(Some(&display), false, true));
        assert!(!should_enable_notch_overlay(
            Some(&ScreenCaptureTarget::CameraOnly),
            true,
            true
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

#[cfg(target_os = "linux")]
pub(crate) mod linux_instant {
    use super::*;
    use crate::upload::strict_instant::{Control, Permission};
    use std::sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    };

    #[derive(Clone)]
    pub struct Attempt(Arc<AttemptInner>);

    struct AttemptInner {
        lifecycle: Mutex<Option<instant_recording::InstantLifecycle>>,
        directory: Mutex<Option<PathBuf>>,
        cancelled: AtomicBool,
        cancel_changed: tokio::sync::watch::Sender<bool>,
        started: tokio::sync::watch::Sender<bool>,
        operation: tokio::sync::Mutex<()>,
        upload: Control,
        permission: Mutex<Option<Permission>>,
        uploading: AtomicBool,
        ui_ready: AtomicBool,
        cleanup_uncertain: AtomicBool,
        upload_result: Mutex<Option<Result<(), String>>>,
        terminal: Mutex<Option<TerminalControl>>,
    }

    #[derive(Clone, Copy)]
    enum ControlSuccess {
        Stopped,
        Discarded,
    }

    #[derive(Clone)]
    struct TerminalControl {
        kind: ControlSuccess,
        result: Result<(), String>,
    }

    impl Attempt {
        fn new() -> Self {
            let (upload, permission) = Control::new();
            let (started, _) = tokio::sync::watch::channel(false);
            Self(Arc::new(AttemptInner {
                lifecycle: Mutex::new(None),
                directory: Mutex::new(None),
                cancelled: AtomicBool::new(false),
                cancel_changed: tokio::sync::watch::channel(false).0,
                started,
                operation: tokio::sync::Mutex::new(()),
                upload,
                ui_ready: AtomicBool::new(false),
                cleanup_uncertain: AtomicBool::new(false),
                upload_result: Mutex::new(None),
                terminal: Mutex::new(None),
                permission: Mutex::new(Some(permission)),
                uploading: AtomicBool::new(false),
            }))
        }

        pub(crate) fn checked<T>(&self, result: Result<T, String>) -> Result<T, String> {
            result.and_then(|value| {
                if self.cancelled() {
                    Err("Instant attempt cancelled; local recording retained".into())
                } else {
                    Ok(value)
                }
            })
        }

        fn terminal_result(&self, discard: bool) -> Option<Result<(), String>> {
            let mut terminal = self.0.terminal.lock().unwrap();
            let terminal = terminal.as_mut()?;
            terminal.result = self.checked(terminal.result.clone());
            Some(
                terminal
                    .result
                    .clone()
                    .and_then(|()| match (terminal.kind, discard) {
                        (ControlSuccess::Stopped, true) => {
                            Err("Instant recording was stopped, not discarded".into())
                        }
                        _ => Ok(()),
                    }),
            )
        }

        fn record_terminal(&self, discard: bool, result: Result<(), String>) -> Result<(), String> {
            let result = self.checked(result);
            let kind = if discard {
                ControlSuccess::Discarded
            } else {
                ControlSuccess::Stopped
            };
            let mut terminal = self.0.terminal.lock().unwrap();
            if terminal.is_none() {
                *terminal = Some(TerminalControl { kind, result });
            }
            drop(terminal);
            self.terminal_result(discard).unwrap()
        }

        pub fn control_in_progress(&self) -> bool {
            self.0.operation.try_lock().is_err()
        }
        pub fn terminal_needs_cleanup(&self) -> bool {
            if self.control_in_progress() {
                false
            } else {
                self.cancel();
                true
            }
        }

        fn prepare_control(&self) {
            if self.0.operation.try_lock().is_err() || !*self.0.started.borrow() {
                self.cancel();
            }
        }

        pub fn cancel(&self) {
            self.0.cancelled.store(true, Ordering::Release);
            self.0.cancel_changed.send_replace(true);
            self.0.upload.deny();
            if let Some(lifecycle) = self.lifecycle() {
                lifecycle.cancel();
            }
        }

        pub fn cancelled(&self) -> bool {
            self.0.cancelled.load(Ordering::Acquire)
        }
        pub(crate) async fn while_active<T>(
            &self,
            operation: impl std::future::Future<Output = Result<T, String>>,
        ) -> Result<T, String> {
            self.checked(Ok(()))?;
            let mut changed = self.0.cancel_changed.subscribe();
            tokio::select! {
                biased;
                _ = async {
                    while !*changed.borrow_and_update() {
                        if changed.changed().await.is_err() { break; }
                    }
                } => Err("Instant preparation cancelled".into()),
                result = operation => self.checked(result),
            }
        }

        pub fn upload(&self) -> Control {
            self.0.upload.clone()
        }
        pub fn upload_started(&self) {
            self.0.uploading.store(true, Ordering::Release);
        }
        fn lifecycle(&self) -> Option<instant_recording::InstantLifecycle> {
            self.0.lifecycle.lock().unwrap().clone()
        }
        pub fn owns_directory(&self, directory: &Path) -> bool {
            self.0.directory.lock().unwrap().as_deref() == Some(directory)
        }
        pub fn capture_joined(&self) -> bool {
            self.lifecycle().is_none_or(|lifecycle| {
                lifecycle.quiescence() == instant_recording::InstantQuiescence::Joined
            })
        }
        pub fn has_capture(&self) -> bool {
            self.lifecycle().is_some()
        }
        pub fn ui_ready(&self) -> bool {
            self.0.ui_ready.load(Ordering::Acquire)
        }
        pub fn set_directory(&self, directory: PathBuf) {
            *self.0.directory.lock().unwrap() = Some(directory);
        }
        pub(crate) fn same(&self, other: &Self) -> bool {
            Arc::ptr_eq(&self.0, &other.0)
        }

        pub async fn attach(
            &self,
            directory: PathBuf,
            lifecycle: instant_recording::InstantLifecycle,
        ) -> Result<(), String> {
            if let Some(previous) = self.lifecycle()
                && previous.wait_for_quiescence().await
                    != instant_recording::InstantQuiescence::Joined
            {
                lifecycle.cancel();
                return Err("Previous Instant startup cleanup is unconfirmed".into());
            }
            *self.0.directory.lock().unwrap() = Some(directory);
            *self.0.lifecycle.lock().unwrap() = Some(lifecycle.clone());
            if self.cancelled() {
                lifecycle.cancel();
                return Err("Instant startup cancelled".into());
            }
            Ok(())
        }

        async fn capture_cleanup(&self) -> bool {
            match self.lifecycle() {
                Some(lifecycle) => {
                    lifecycle.wait_for_quiescence().await
                        == instant_recording::InstantQuiescence::Joined
                }
                None => true,
            }
        }

        pub(super) async fn upload_cleanup(&self) -> bool {
            !self.0.uploading.load(Ordering::Acquire) || self.0.upload.joined().await
        }

        async fn join_upload(&self, upload: InstantUploader) -> Result<(), String> {
            if let Some(result) = self.0.upload_result.lock().unwrap().clone() {
                return result;
            }
            let result = await_instant_upload(upload)
                .await
                .and_then(|result| result.map_err(|error| error.to_string()));
            *self.0.upload_result.lock().unwrap() = Some(result.clone());
            result
        }

        async fn wait_started(&self) -> Result<(), String> {
            let mut started = self.0.started.subscribe();
            loop {
                if *started.borrow_and_update() {
                    return Ok(());
                }
                started
                    .changed()
                    .await
                    .map_err(|_| "Instant startup owner was lost")?;
            }
        }

        fn authorize(&self) -> Result<(), String> {
            if self.cancelled() {
                return Err("Instant attempt was cancelled".into());
            }
            self.0
                .permission
                .lock()
                .unwrap()
                .take()
                .ok_or("Instant completion permission was consumed")?
                .grant()
                .map_err(|error| error.to_string())
        }
    }

    struct Waiter(Option<Attempt>);
    impl Drop for Waiter {
        fn drop(&mut self) {
            if let Some(attempt) = self.0.take() {
                attempt.cancel();
            }
        }
    }

    pub fn current(app: &AppHandle) -> Option<Attempt> {
        app.try_state::<crate::clean_capture::State>()
            .and_then(|state| state.instant.lock().unwrap().clone())
    }

    fn is_current(app: &AppHandle, attempt: &Attempt) -> bool {
        current(app).is_some_and(|value| value.same(attempt))
    }

    fn release(app: &AppHandle, attempt: &Attempt) {
        let state = app.state::<crate::clean_capture::State>();
        let mut current = state.instant.lock().unwrap();
        if current.as_ref().is_some_and(|value| value.same(attempt)) {
            drop(current.take());
        }
    }

    pub fn blocks_cleanup(app: &AppHandle) -> bool {
        current(app).is_some_and(|attempt| !attempt.capture_joined())
    }

    pub(crate) fn validate_screen_request(
        inputs: &StartRecordingInputs,
        requested: &crate::RequestedInputs,
    ) -> Result<(), String> {
        validate_screen_camera_support(
            inputs,
            requested.camera.value.is_some(),
            std::env::var_os("DISPLAY").is_some()
                && std::env::var_os("WAYLAND_DISPLAY").is_none()
                && std::env::var("XDG_SESSION_TYPE")
                    .is_ok_and(|value| value.eq_ignore_ascii_case("x11")),
        )
    }

    fn validate_screen_camera_support(
        inputs: &StartRecordingInputs,
        camera_requested: bool,
        x11: bool,
    ) -> Result<(), String> {
        if inputs.mode != RecordingMode::Instant
            || !camera_requested
            || matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly)
        {
            return Ok(());
        }
        if !x11 {
            return Err(
                "Instant camera composition requires an X11 desktop; Wayland is not supported."
                    .into(),
            );
        }
        Ok(())
    }

    pub(crate) fn capture_rect(
        target: &ScreenCaptureTarget,
    ) -> Result<crate::linux_instant_camera::PhysicalRect, String> {
        let (display, crop) =
            cap_recording::target_to_display_and_crop(target).map_err(|error| error.to_string())?;
        let position = display
            .raw_handle()
            .physical_position()
            .ok_or("Display physical position unavailable")?;
        if matches!(target, ScreenCaptureTarget::Window { .. }) {
            let crop = crop.ok_or("Capture window bounds unavailable")?;
            return physical_window_capture_rect(
                position.x() + crop.position().x(),
                position.y() + crop.position().y(),
                crop.size().width(),
                crop.size().height(),
            );
        }
        let size = display
            .physical_size()
            .ok_or("Display physical size unavailable")?;
        physical_capture_rect(
            (position.x(), position.y(), size.width(), size.height()),
            crop.map(|crop| {
                (
                    crop.position().x(),
                    crop.position().y(),
                    crop.size().width(),
                    crop.size().height(),
                )
            }),
        )
    }

    fn physical_window_capture_rect(
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<crate::linux_instant_camera::PhysicalRect, String> {
        let coordinates = f64::from(i32::MIN)..=f64::from(i32::MAX);
        let dimensions = 2.0..=f64::from(i32::MAX);
        if ![x, y, width, height]
            .iter()
            .all(|value| value.is_finite() && value.fract() == 0.0)
            || !coordinates.contains(&x)
            || !coordinates.contains(&y)
            || !dimensions.contains(&width)
            || !dimensions.contains(&height)
        {
            return Err("Capture window has invalid physical bounds".into());
        }
        Ok(crate::linux_instant_camera::PhysicalRect {
            x: x as i32,
            y: y as i32,
            width: width as u32,
            height: height as u32,
        })
    }

    fn physical_capture_rect(
        display: (f64, f64, f64, f64),
        crop: Option<(f64, f64, f64, f64)>,
    ) -> Result<crate::linux_instant_camera::PhysicalRect, String> {
        let (x, y, width, height) = cap_recording::sources::screen_capture::x11_capture_rect(
            display.0, display.1, display.2, display.3, crop,
        )
        .map_err(|error| error.to_string())?;
        Ok(crate::linux_instant_camera::PhysicalRect {
            x,
            y,
            width,
            height,
        })
    }

    pub(crate) struct PreparedScreenCamera {
        pub source: instant_recording::LinuxProcessedCameraSource,
        pub presentation: instant_recording::LinuxCameraPresentation,
        pub reference_size: (u32, u32),
    }

    pub(crate) fn configure_screen_camera(
        builder: instant_recording::ActorBuilder,
        target: &ScreenCaptureTarget,
        camera_requested: bool,
        prepared: Option<PreparedScreenCamera>,
    ) -> Result<instant_recording::ActorBuilder, String> {
        if let Some(prepared) = prepared {
            if !camera_requested || matches!(target, ScreenCaptureTarget::CameraOnly) {
                return Err("Unexpected Instant screen camera preparation".into());
            }
            Ok(builder.with_linux_processed_camera(
                prepared.source,
                prepared.presentation,
                prepared.reference_size,
            ))
        } else if camera_requested && !matches!(target, ScreenCaptureTarget::CameraOnly) {
            Err(
                "Requested Instant screen camera was not prepared; no raw fallback is allowed"
                    .into(),
            )
        } else {
            Ok(builder)
        }
    }

    pub(crate) async fn prepare_screen_camera(
        app: &AppHandle,
        attempt: &Attempt,
        generation: u32,
        inputs: &StartRecordingInputs,
        requested: &crate::RequestedInputs,
        camera: Option<Arc<CameraFeedLock>>,
    ) -> Result<Option<PreparedScreenCamera>, String> {
        validate_screen_request(inputs, requested)?;
        if camera.is_some() != requested.camera.value.is_some() {
            return Err("Requested camera lock is missing or unexpected".into());
        }
        let capture = capture_rect(&inputs.capture_target)?;
        let prepared = if let Some(camera) = camera {
            let presentation = attempt
                .while_active(crate::linux_instant_camera::request_presentation(
                    app, generation, capture,
                ))
                .await?;
            let state = app.state::<crate::ArcLock<App>>();
            let factory = state.read().await.camera_processing.clone();
            let source = attempt
                .while_active(async {
                    factory
                        .subscribe(camera, &presentation)
                        .await
                        .map_err(|error| error.to_string())
                })
                .await?;
            Some((presentation, source))
        } else {
            None
        };
        let (presentation, source) = match prepared {
            Some((presentation, source)) => (Some(presentation), Some(source)),
            None => (None, None),
        };
        let seal = crate::clean_capture::seal_instant(
            app,
            crate::clean_capture::InstantSeal {
                generation,
                attempt: attempt.clone(),
                requested: requested.clone(),
                target: inputs.capture_target.clone(),
                capture,
                presentation,
            },
        )
        .await?;
        match (seal.presentation, source) {
            (Some(presentation), Some(source)) => Ok(Some(PreparedScreenCamera {
                source,
                presentation: presentation.presentation,
                reference_size: presentation.reference_size,
            })),
            (None, None) => Ok(None),
            _ => Err("Instant prepared camera ownership was lost".into()),
        }
    }

    pub fn validate_inputs(inputs: &StartRecordingInputs) -> Result<(), String> {
        if inputs.mode == RecordingMode::Instant
            && matches!(inputs.capture_target, ScreenCaptureTarget::CameraOnly)
            && inputs.capture_system_audio
        {
            Err("System audio is not supported for Linux Instant CameraOnly. Disable it before recording.".into())
        } else {
            Ok(())
        }
    }

    pub async fn start(
        app: AppHandle,
        state: MutableState<'_, App>,
        inputs: StartRecordingInputs,
    ) -> Result<RecordingAction, String> {
        validate_inputs(&inputs)?;
        let attempt = Attempt::new();
        {
            let app_state = state.write().await;
            if !matches!(app_state.recording_state, RecordingState::None) {
                return Err("Recording already in progress".into());
            }
            let state = app.state::<crate::clean_capture::State>();
            let mut slot = state.instant.lock().unwrap();
            if slot.is_some() {
                return Err("Finish the previous Instant attempt before recording".into());
            }
            *slot = Some(attempt.clone());
        }
        let work_attempt = attempt.clone();
        let abandoned_attempt = attempt.clone();
        let abandoned_app = app.clone();
        owned_reply(
            attempt,
            async move {
                let attempt = work_attempt;
                let state = app.state::<crate::ArcLock<App>>();
                let result =
                    AssertUnwindSafe(start_recording_inner(app.clone(), state.clone(), inputs))
                        .catch_unwind()
                        .await
                        .unwrap_or_else(|panic| {
                            Err(format!(
                                "Instant startup panicked: {}",
                                panic_message(panic)
                            ))
                        });
                let started =
                    matches!(result, Ok(RecordingAction::Started)) && !attempt.cancelled();
                if !started {
                    attempt.cancel();
                    let joined = attempt.capture_cleanup().await;
                    let upload_joined = attempt.upload_cleanup().await;
                    if joined && upload_joined && is_current(&app, &attempt) {
                        let upload = {
                            let state = state.read().await;
                            match state.current_recording() {
                                Some(InProgressRecording::Instant { segment_upload, .. }) => {
                                    Some(segment_upload.clone())
                                }
                                _ => None,
                            }
                        };
                        if let Some(upload) = upload {
                            let _ = attempt.join_upload(upload).await;
                        }
                        attempt.0.ui_ready.store(true, Ordering::Release);
                        let directory = attempt.0.directory.lock().unwrap().clone();
                        if let Some(directory) = directory {
                            let mut state = state.write().await;
                            let _ = handle_recording_end(
                                app.clone(),
                                Err("Instant startup failed or was cancelled".into()),
                                &mut state,
                                directory,
                            )
                            .await;
                        } else {
                            state.write().await.clear_pending_recording();
                        }
                        let terminal = result.as_ref().err().cloned().unwrap_or_else(|| {
                            "Instant startup did not establish a recording".into()
                        });
                        let _ = attempt.record_terminal(false, Err(terminal));
                        release(&app, &attempt);
                    }
                }
                attempt.0.started.send_replace(true);
                match result {
                    Ok(RecordingAction::Started) if !started => {
                        Err("Instant startup cancelled".into())
                    }
                    result => result,
                }
            },
            async move {
                let _ = execute(abandoned_app, abandoned_attempt, false).await;
            },
        )
        .await
    }

    pub fn control(
        app: AppHandle,
        attempt: Attempt,
        discard: bool,
    ) -> futures::future::BoxFuture<'static, Result<(), String>> {
        Box::pin(async move {
            attempt.prepare_control();
            let worker = attempt.clone();
            owned_reply(
                attempt,
                async move {
                    let result = execute(app.clone(), worker, discard).await;
                    if let Err(error) = &result {
                        let _ = RecordingEvent::Failed {
                            error: error.clone(),
                        }
                        .emit(&app);
                    }
                    result
                },
                async {},
            )
            .await
        })
    }

    async fn owned_reply<T, F, A>(attempt: Attempt, work: F, abandoned: A) -> Result<T, String>
    where
        T: Send + 'static,
        F: std::future::Future<Output = Result<T, String>> + Send + 'static,
        A: std::future::Future<Output = ()> + Send + 'static,
    {
        let mut waiter = Waiter(Some(attempt.clone()));
        let (reply, result) = tokio::sync::oneshot::channel();
        drop(tauri::async_runtime::spawn(async move {
            let result = match AssertUnwindSafe(work).catch_unwind().await {
                Ok(result) => result,
                Err(panic) => {
                    attempt.0.cleanup_uncertain.store(true, Ordering::Release);
                    attempt.cancel();
                    attempt.0.started.send_replace(true);
                    let _ = attempt.upload_cleanup().await;
                    Err(format!(
                        "Instant owned work panicked; cleanup is unconfirmed: {}",
                        panic_message(panic)
                    ))
                }
            };
            if result.is_err() {
                attempt.cancel();
            }
            if reply.send(result).is_err() {
                attempt.cancel();
                abandoned.await;
            }
        }));
        let result = result
            .await
            .map_err(|_| "Instant cleanup owner was lost".to_string())?;
        drop(waiter.0.take());
        result
    }

    async fn run_control<F, W>(
        attempt: &Attempt,
        discard: bool,
        current: impl FnOnce() -> bool,
        work: W,
    ) -> Result<(), String>
    where
        F: std::future::Future<Output = Result<(), String>>,
        W: FnOnce() -> F,
    {
        attempt.wait_started().await?;
        let _operation = attempt.0.operation.lock().await;
        if let Some(result) = attempt.terminal_result(discard) {
            return result;
        }
        if !current() {
            return Err("Instant attempt was superseded without a terminal result".into());
        }
        work().await
    }

    async fn complete_local<T, G, L, F, W>(
        attempt: &Attempt,
        outcome: Result<T, String>,
        acquire: L,
        finish: W,
    ) -> Result<(), String>
    where
        L: std::future::Future<Output = G>,
        F: std::future::Future<Output = Result<(), String>>,
        W: FnOnce(G, Result<T, String>) -> F,
    {
        let guard = acquire.await;
        let outcome = attempt.checked(outcome);
        let failure = outcome.as_ref().err().cloned();
        let cleanup = finish(guard, outcome).await;
        attempt.checked(failure.map_or(cleanup, Err))
    }

    async fn execute(app: AppHandle, attempt: Attempt, discard: bool) -> Result<(), String> {
        run_control(
            &attempt,
            discard,
            || is_current(&app, &attempt),
            || execute_current(app.clone(), attempt.clone(), discard),
        )
        .await
    }

    async fn execute_current(
        app: AppHandle,
        attempt: Attempt,
        discard: bool,
    ) -> Result<(), String> {
        if attempt.0.cleanup_uncertain.load(Ordering::Acquire) {
            attempt.cancel();
            return Err("Instant finalization cleanup is unconfirmed; local recording and Stop ownership retained".into());
        }
        let state = app.state::<crate::ArcLock<App>>();
        let (handle, directory, segment_upload, video_upload_info, target_name) = {
            let state = state.read().await;
            match state.current_recording() {
                Some(InProgressRecording::Instant {
                    handle,
                    common,
                    segment_upload,
                    video_upload_info,
                    ..
                }) if attempt.owns_directory(&common.recording_dir) => (
                    handle.clone(),
                    common.recording_dir.clone(),
                    segment_upload.clone(),
                    video_upload_info.clone(),
                    common.target_name.clone(),
                ),
                _ => return Err("Instant recording is unavailable; cleanup state retained".into()),
            }
        };
        if discard {
            attempt.upload().deny();
        }
        let stopped = if discard || attempt.cancelled() {
            handle.cancel().await.map(|()| None)
        } else {
            handle.stop().await.map(Some)
        };
        if stopped.is_err() {
            attempt.cancel();
        }
        if !attempt.capture_cleanup().await {
            return Err("Instant capture cleanup is unconfirmed. Local recording retained; use Stop to retry.".into());
        }
        let video_id = video_upload_info.id.clone();
        let share_info = video_upload_info.clone();
        let result = match stopped {
            Ok(Some(recording)) if !attempt.cancelled() => {
                let mut completed = CompletedRecording::Instant {
                    recording,
                    segment_upload: segment_upload.clone(),
                    video_upload_info,
                    target_name,
                    finalized: false,
                };
                match finalize(&attempt, &mut completed).await {
                    Ok(()) => Ok(Some(completed)),
                    Err(error) => {
                        attempt.cancel();
                        let _ = attempt.upload_cleanup().await;
                        Err(error)
                    }
                }
            }
            result => {
                attempt.upload().deny();
                if !attempt.upload_cleanup().await {
                    return Err(
                        "Instant upload reader cleanup is unconfirmed; local recording retained"
                            .into(),
                    );
                }
                match result {
                    Ok(None) if discard && !attempt.cancelled() => Ok(None),
                    Ok(_) => {
                        Err("Instant recording was cancelled; local recording retained".into())
                    }
                    Err(error) => Err(error.to_string()),
                }
            }
        };
        if !matches!(result, Ok(Some(_))) {
            if !attempt.upload_cleanup().await {
                return Err(
                    "Instant upload cleanup is unconfirmed; local recording retained".into(),
                );
            }
            let _ = attempt.join_upload(segment_upload.clone()).await;
        }
        let successful_discard = matches!(result, Ok(None));
        let successful_upload = matches!(result, Ok(Some(_)));
        let finish_app = app.clone();
        let finish_attempt = attempt.clone();
        let finish_directory = directory.clone();
        let mut result = complete_local(
            &attempt,
            result,
            state.write(),
            move |mut state, result| async move {
                if !is_current(&finish_app, &finish_attempt)
                    || state
                        .current_recording()
                        .is_none_or(|recording| recording.recording_dir() != &finish_directory)
                {
                    return Err("Instant completion no longer owns the recording".into());
                }
                let outcome = match result {
                    Ok(Some(completed)) => Ok(completed),
                    Ok(None) => Err("Recording discarded".into()),
                    Err(error) => Err(error),
                };
                finish_attempt.0.ui_ready.store(true, Ordering::Release);
                handle_recording_end(finish_app, outcome, &mut state, finish_directory).await
            },
        )
        .await;
        if result.is_ok() && successful_upload {
            let session = segment_upload.lock().await.session.clone();
            result = session.mark_ready(false).map_err(|error| error.to_string());
            if result.is_ok() {
                let network_attempt = attempt.clone();
                let network_app = app.clone();
                let network_video = share_info.clone();
                let network_session = session.clone();
                result = crate::upload::lifecycle::supervise(app.clone(), session, async move {
                    let authorized = network_attempt.authorize();
                    let uploaded = network_attempt.join_upload(segment_upload).await;
                    let joined = network_attempt.upload_cleanup().await;
                    authorized.map_err(AuthedApiError::from)?;
                    uploaded.map_err(AuthedApiError::from)?;
                    if !joined {
                        return Err("Instant upload cleanup is unconfirmed".into());
                    }
                    let bytes =
                        compress_image(network_session.directory.join("screenshots/display.jpg"))
                            .await?;
                    crate::upload::strict_instant::upload_thumbnail(
                        &network_app,
                        &network_video.id,
                        bytes,
                        &network_attempt.upload(),
                    )
                    .await?;
                    network_session.complete_locally(&network_app).await?;
                    crate::automation::run_upload_completed_automations(
                        network_app,
                        network_session.directory.clone(),
                        Some(network_video.link),
                        Some(network_video.id),
                    );
                    Ok(())
                })
                .await
                .map_err(|error| error.to_string());
            }
            if result.is_ok() {
                result = successful_effects(&app, &attempt, &directory, &share_info);
            }
        }
        result = attempt.checked(result);
        if result.is_ok() && successful_discard {
            result = delete_remote_instant_video(&app, &video_id).await;
            result = attempt.checked(result);
            if result.is_ok() {
                result = crate::upload::lifecycle::mark_cancelled(&directory)
                    .map_err(|error| error.to_string());
            }
            if result.is_ok() {
                result = remove_owned_directory(directory.clone(), attempt.clone(), false).await;
                result = attempt.checked(result);
            }
        }
        result = attempt.checked(result);
        if let Err(error) = &result {
            attempt.cancel();
            persist_terminal_failure(&directory, error).await;
        }
        let result = attempt.record_terminal(discard, result);
        release(&app, &attempt);
        attempt.terminal_result(discard).unwrap_or(result)
    }

    async fn persist_terminal_failure(directory: &Path, error: &str) {
        let directory = directory.to_path_buf();
        let failure = error.to_string();
        let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut meta =
                RecordingMeta::load_for_project(&directory).map_err(|error| error.to_string())?;
            meta.inner =
                RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error: failure });
            meta.save_for_project().map_err(|error| error.to_string())
        })
        .await;
        if !matches!(&result, Ok(Ok(()))) {
            error!(
                ?result,
                "Failed to persist Instant terminal error; local recording retained"
            );
        }
    }

    struct SuccessEffects<R, U, O, C, S> {
        recording_automation: R,
        upload_automation: U,
        open_link: O,
        copy_link: C,
        sound: S,
    }

    fn dispatch_success_effects<R, U, O, C, S>(
        attempt: &Attempt,
        share_link: &str,
        effects: SuccessEffects<R, U, O, C, S>,
    ) -> Result<(), String>
    where
        R: FnOnce(),
        U: FnOnce(),
        O: FnOnce(String) -> Result<(), String>,
        C: FnOnce(String) -> Result<(), String>,
        S: FnOnce(),
    {
        attempt.checked(Ok(()))?;
        (effects.recording_automation)();
        attempt.checked(Ok(()))?;
        (effects.upload_automation)();
        attempt.checked(Ok(()))?;
        (effects.open_link)(recording_stopped_share_url(share_link))?;
        attempt.checked(Ok(()))?;
        let _ = (effects.copy_link)(share_link.to_string());
        attempt.checked(Ok(()))?;
        (effects.sound)();
        attempt.checked(Ok(()))
    }

    fn successful_effects(
        app: &AppHandle,
        attempt: &Attempt,
        directory: &Path,
        video: &VideoUploadInfo,
    ) -> Result<(), String> {
        use tauri_plugin_clipboard_manager::ClipboardExt;
        dispatch_success_effects(
            attempt,
            &video.link,
            SuccessEffects {
                recording_automation: || {
                    crate::automation::run_instant_recording_automations(
                        app.clone(),
                        directory.to_path_buf(),
                        Some(video.link.clone()),
                        Some(video.id.clone()),
                    )
                },
                upload_automation: || {},
                open_link: |link| open_external_link(app.clone(), link),
                copy_link: |link| {
                    app.clipboard()
                        .write_text(link)
                        .map_err(|error| error.to_string())
                },
                sound: || AppSounds::StopRecording.play(),
            },
        )
    }

    async fn remove_owned_directory(
        directory: PathBuf,
        attempt: Attempt,
        uploaded: bool,
    ) -> Result<(), String> {
        if attempt.cancelled() {
            return Err("Instant cleanup cancelled; local recording retained".into());
        }
        let worker = attempt.clone();
        tokio::task::spawn_blocking(move || {
            if worker.cancelled() {
                return Err("Instant cleanup cancelled before deletion".to_string());
            }
            if uploaded {
                worker.upload().check().map_err(|error| error.to_string())?;
            }
            std::fs::remove_dir_all(directory).map_err(|error| error.to_string())
        })
        .await
        .map_err(|error| error.to_string())??;
        if attempt.cancelled() {
            return Err("Instant cleanup cancelled during deletion".into());
        }
        Ok(())
    }

    pub fn persist_upload_start(
        directory: &Path,
        video: &VideoUploadInfo,
        segmented: bool,
    ) -> Result<(), String> {
        let mut meta =
            RecordingMeta::load_for_project(directory).map_err(|error| error.to_string())?;
        meta.upload = Some(if segmented {
            cap_project::UploadMeta::SegmentUpload {
                video_id: video.id.clone(),
                pre_created_video: video.clone(),
                recording_dir: directory.into(),
            }
        } else {
            cap_project::UploadMeta::MultipartUpload {
                video_id: video.id.clone(),
                pre_created_video: video.clone(),
                recording_dir: directory.into(),
                file_path: directory.join("content/output.mp4"),
            }
        });
        meta.save_for_project().map_err(|error| error.to_string())
    }

    async fn finalize(attempt: &Attempt, completed: &mut CompletedRecording) -> Result<(), String> {
        let CompletedRecording::Instant {
            recording,
            segment_upload: _,
            video_upload_info,
            finalized,
            ..
        } = completed
        else {
            unreachable!()
        };
        if !recording.health.is_uploadable() {
            return Err("Instant recording output is damaged".into());
        }
        let directory = &recording.project_path;
        let screenshots = directory.join("screenshots");
        std::fs::create_dir_all(&screenshots).map_err(|error| error.to_string())?;
        let screenshot = screenshots.join("display.jpg");
        let source = if matches!(recording.display_source, ScreenCaptureTarget::CameraOnly) {
            directory.join("content/output.mp4")
        } else {
            create_screenshot_source_from_segments(&directory.join("content/display")).await?
        };
        create_screenshot(source, screenshot.clone(), None).await?;
        let mut meta =
            RecordingMeta::load_for_project(directory).map_err(|error| error.to_string())?;
        attempt.checked(Ok(()))?;
        meta.sharing = Some(SharingMeta {
            link: video_upload_info.link.clone(),
            id: video_upload_info.id.clone(),
            content_hash: None,
        });
        meta.inner = RecordingMetaInner::Instant(recording.meta.clone());
        meta.save_for_project().map_err(|error| error.to_string())?;
        attempt.checked(Ok(()))?;
        *finalized = true;
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[tokio::test]
        async fn preflight_cancel_before_f9_unblocks_start_and_stop_only_after_owned_cleanup() {
            for discard in [false, true] {
                let state = Arc::new(crate::clean_capture::instant_preflight_fixture(7));
                let attempt = Attempt::new();
                let starter = attempt.clone();
                let waiting = state.clone();
                let (polled_tx, polled_rx) = tokio::sync::oneshot::channel();
                let (cancelled_tx, cancelled_rx) = tokio::sync::oneshot::channel();
                let (cleanup_tx, cleanup_rx) = tokio::sync::oneshot::channel();
                let startup = tokio::spawn(async move {
                    polled_tx.send(()).unwrap();
                    let error = crate::clean_capture::await_instant_shortcut(&waiting, 7, &starter)
                        .await
                        .unwrap_err();
                    cancelled_tx.send(()).unwrap();
                    cleanup_rx.await.unwrap();
                    assert!(starter.capture_cleanup().await);
                    assert!(starter.upload_cleanup().await);
                    let result = starter.record_terminal(false, Err(error));
                    starter.0.started.send_replace(true);
                    result
                });
                polled_rx.await.unwrap();
                attempt.prepare_control();
                let controller = attempt.clone();
                let stop = tokio::spawn(async move {
                    run_control(
                        &controller,
                        discard,
                        || true,
                        || async { panic!("cancelled preflight has no active actor to finalize") },
                    )
                    .await
                });
                tokio::time::timeout(std::time::Duration::from_secs(2), cancelled_rx)
                    .await
                    .expect("Cancel must wake preflight without F9")
                    .unwrap();
                assert!(!stop.is_finished());
                assert!(!*attempt.0.started.borrow());
                assert!(!attempt.ui_ready());
                cleanup_tx.send(()).unwrap();
                let startup_error = startup.await.unwrap().unwrap_err();
                assert_eq!(stop.await.unwrap().unwrap_err(), startup_error);
                assert!(attempt.upload().check().is_err());
            }
        }

        #[tokio::test]
        async fn preflight_cancelled_before_wait_poll_does_not_need_state_notification() {
            let state = crate::clean_capture::instant_preflight_fixture(7);
            let attempt = Attempt::new();
            attempt.cancel();
            assert!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    crate::clean_capture::await_instant_shortcut(&state, 7, &attempt),
                )
                .await
                .expect("pre-cancelled wait must return")
                .is_err()
            );
        }

        #[tokio::test]
        async fn preflight_command_waiter_drop_wakes_shortcut_wait_without_aborting_cleanup() {
            let state = Arc::new(crate::clean_capture::instant_preflight_fixture(7));
            let attempt = Attempt::new();
            let waiter = Waiter(Some(attempt.clone()));
            let owner = attempt.clone();
            let (polled_tx, polled_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                polled_tx.send(()).unwrap();
                crate::clean_capture::await_instant_shortcut(&state, 7, &owner).await
            });
            polled_rx.await.unwrap();
            drop(waiter);
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(2), task)
                    .await
                    .expect("dropped command must wake preflight")
                    .unwrap()
                    .is_err()
            );
            assert!(attempt.capture_cleanup().await);
            assert!(attempt.upload_cleanup().await);
            assert!(attempt.authorize().is_err());
        }

        #[tokio::test]
        async fn preflight_cancel_wins_when_f9_and_cancel_are_ready_together() {
            let state = Arc::new(crate::clean_capture::instant_preflight_fixture(7));
            let attempt = Attempt::new();
            let owner = attempt.clone();
            let waiting = state.clone();
            let (polled_tx, polled_rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                polled_tx.send(()).unwrap();
                crate::clean_capture::await_instant_shortcut(&waiting, 7, &owner).await
            });
            polled_rx.await.unwrap();
            crate::clean_capture::deliver_preflight_shortcut(&state);
            attempt.cancel();
            assert!(task.await.unwrap().is_err());
        }

        #[tokio::test]
        async fn preflight_actual_shortcut_wait_preserves_success_and_rejects_wrong_generation() {
            let state = Arc::new(crate::clean_capture::instant_preflight_fixture(7));
            assert!(
                crate::clean_capture::wait_for_shortcut(&state, 8)
                    .await
                    .is_err()
            );
            let waiting = state.clone();
            let task =
                tokio::spawn(
                    async move { crate::clean_capture::wait_for_shortcut(&waiting, 7).await },
                );
            crate::clean_capture::deliver_preflight_shortcut(&state);
            task.await.unwrap().unwrap();
        }

        #[test]
        fn instant_window_capture_reference_preserves_exact_size_and_origin() {
            assert_eq!(
                physical_window_capture_rect(-40.0, 31.0, 1281.0, 721.0).unwrap(),
                crate::linux_instant_camera::PhysicalRect {
                    x: -40,
                    y: 31,
                    width: 1281,
                    height: 721,
                }
            );
            assert_eq!(
                physical_window_capture_rect(-1921.0, -1081.0, 1919.0, 1079.0).unwrap(),
                crate::linux_instant_camera::PhysicalRect {
                    x: -1921,
                    y: -1081,
                    width: 1919,
                    height: 1079,
                }
            );
        }

        #[test]
        fn instant_window_capture_reference_rejects_invalid_geometry() {
            for value in [
                f64::NAN,
                f64::INFINITY,
                0.0,
                1.0,
                400.5,
                f64::from(u32::MAX),
            ] {
                assert!(physical_window_capture_rect(0.0, 0.0, value, 720.0).is_err());
                assert!(physical_window_capture_rect(0.0, 0.0, 1280.0, value).is_err());
            }
            for value in [
                f64::NAN,
                f64::NEG_INFINITY,
                -0.5,
                f64::from(i32::MIN) - 1.0,
                f64::from(i32::MAX) + 1.0,
            ] {
                assert!(physical_window_capture_rect(value, 0.0, 1280.0, 720.0).is_err());
                assert!(physical_window_capture_rect(0.0, value, 1280.0, 720.0).is_err());
            }
        }

        #[test]
        fn instant_physical_capture_reference_matches_negative_origin_fractional_crop_and_even_rounding()
         {
            assert_eq!(
                physical_capture_rect(
                    (-1920.0, 0.0, 1920.0, 1080.0),
                    Some((10.25, 20.75, 301.25, 199.5))
                )
                .unwrap(),
                crate::linux_instant_camera::PhysicalRect {
                    x: -1910,
                    y: 20,
                    width: 302,
                    height: 200
                },
            );
            assert_eq!(
                physical_capture_rect((0.0, -1080.0, 1919.0, 1079.0), None).unwrap(),
                crate::linux_instant_camera::PhysicalRect {
                    x: 0,
                    y: -1080,
                    width: 1918,
                    height: 1078
                },
            );
        }

        #[test]
        fn instant_physical_capture_reference_clamps_and_rejects_invalid_geometry() {
            assert_eq!(
                physical_capture_rect(
                    (0.0, 0.0, 1920.0, 1080.0),
                    Some((-50.0, -10.0, 3000.0, 2000.0))
                )
                .unwrap(),
                crate::linux_instant_camera::PhysicalRect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080
                },
            );
            assert!(physical_capture_rect((f64::NAN, 0.0, 1920.0, 1080.0), None).is_err());
        }

        struct PreparationLease(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for PreparationLease {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        #[tokio::test]
        async fn instant_preparation_cancel_wakes_pending_first_frame_and_drops_source_reservation()
        {
            let attempt = Attempt::new();
            let dropped = Arc::new(AtomicBool::new(false));
            let source = PreparationLease(dropped.clone());
            let owner = attempt.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                owner
                    .while_active(async move {
                        let _source = source;
                        tx.send(()).unwrap();
                        std::future::pending::<Result<(), String>>().await
                    })
                    .await
            });
            rx.await.unwrap();
            attempt.cancel();
            assert!(task.await.unwrap().is_err());
            assert!(dropped.load(Ordering::SeqCst));
            assert!(!attempt.has_capture());
            assert!(attempt.upload().check().is_err());
        }

        #[tokio::test]
        async fn instant_preparation_cancel_before_poll_never_requests_or_hides_preview() {
            let attempt = Attempt::new();
            attempt.cancel();
            let result: Result<(), String> = attempt
                .while_active(async {
                    panic!("cancelled preparation must not contact the preview or hide windows")
                })
                .await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn instant_preparation_rechecks_cancel_after_first_frame_arrives() {
            let attempt = Attempt::new();
            let owner = attempt.clone();
            let result = attempt
                .while_active(async move {
                    owner.cancel();
                    Ok(7)
                })
                .await;
            assert!(result.is_err());
        }

        #[tokio::test]
        async fn instant_preparation_preserves_fresh_source_and_failure_identity() {
            let attempt = Attempt::new();
            assert_eq!(attempt.while_active(async { Ok(7) }).await.unwrap(), 7);
            let result: Result<(), String> = attempt
                .while_active(async { Err("first mask unavailable".into()) })
                .await;
            assert_eq!(result.unwrap_err(), "first mask unavailable");
            assert!(!attempt.cancelled());
        }

        #[tokio::test]
        async fn instant_builder_rejects_unprepared_screen_camera_and_joins_unused_attempt() {
            let target = ScreenCaptureTarget::Window {
                id: "1".parse().unwrap(),
            };
            let builder = instant_recording::Actor::builder(
                PathBuf::from("unused-activation-test"),
                target.clone(),
            );
            let lifecycle = builder.lifecycle();
            assert!(configure_screen_camera(builder, &target, true, None).is_err());
            assert_eq!(
                lifecycle.wait_for_quiescence().await,
                instant_recording::InstantQuiescence::Joined
            );
        }

        #[tokio::test]
        async fn instant_builder_preserves_camera_only_and_unselected_camera_paths() {
            for (target, requested) in [
                (ScreenCaptureTarget::CameraOnly, true),
                (
                    ScreenCaptureTarget::Window {
                        id: "1".parse().unwrap(),
                    },
                    false,
                ),
            ] {
                let builder = instant_recording::Actor::builder(
                    PathBuf::from("unused-activation-test"),
                    target.clone(),
                );
                let lifecycle = builder.lifecycle();
                drop(configure_screen_camera(builder, &target, requested, None).unwrap());
                assert_eq!(
                    lifecycle.wait_for_quiescence().await,
                    instant_recording::InstantQuiescence::Joined
                );
            }
        }

        #[test]
        fn instant_screen_camera_support_allows_x11_window_and_preserves_wayland_rejection() {
            let mut inputs = StartRecordingInputs {
                capture_target: ScreenCaptureTarget::Window {
                    id: "1".parse().unwrap(),
                },
                capture_system_audio: false,
                mode: RecordingMode::Instant,
                organization_id: None,
            };
            assert!(validate_screen_camera_support(&inputs, true, true).is_ok());
            assert!(validate_screen_camera_support(&inputs, true, false).is_err());
            assert!(validate_screen_camera_support(&inputs, false, false).is_ok());
            inputs.capture_target = ScreenCaptureTarget::Display {
                id: "1".parse().unwrap(),
            };
            assert!(validate_screen_camera_support(&inputs, true, true).is_ok());
            assert!(validate_screen_camera_support(&inputs, true, false).is_err());
            inputs.mode = RecordingMode::Studio;
            assert!(validate_screen_camera_support(&inputs, true, false).is_ok());
            inputs.mode = RecordingMode::Instant;
            inputs.capture_target = ScreenCaptureTarget::CameraOnly;
            assert!(validate_screen_camera_support(&inputs, true, false).is_ok());
        }

        #[tokio::test]
        async fn owned_waiter_drop_cancels_without_aborting_cleanup() {
            let attempt = Attempt::new();
            let (release, released) = tokio::sync::oneshot::channel();
            let (finished, finished_rx) = tokio::sync::oneshot::channel();
            let cleaned = Arc::new(AtomicBool::new(false));
            let worker_cleaned = cleaned.clone();
            let mut waiter = Box::pin(owned_reply(
                attempt.clone(),
                async move {
                    released.await.unwrap();
                    worker_cleaned.store(true, Ordering::Release);
                    Ok(())
                },
                async move {
                    finished.send(()).unwrap();
                },
            ));
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut waiter)
                    .await
                    .is_err()
            );
            drop(waiter);
            assert!(attempt.cancelled());
            assert!(!cleaned.load(Ordering::Acquire));
            release.send(()).unwrap();
            tokio::time::timeout(Duration::from_secs(1), finished_rx)
                .await
                .unwrap()
                .unwrap();
            assert!(cleaned.load(Ordering::Acquire));
        }
        #[tokio::test]
        async fn owned_work_failure_returns_error_without_success_or_permission() {
            let attempt = Attempt::new();
            let result: Result<(), _> = owned_reply(
                attempt.clone(),
                async { Err("required output failed".into()) },
                async {},
            )
            .await;
            assert!(result.is_err());
            assert!(!attempt.ui_ready());
            attempt.cancel();
            assert!(attempt.authorize().is_err());
        }
        #[tokio::test]
        async fn owned_work_panic_retains_unconfirmed_cleanup() {
            let attempt = Attempt::new();
            let result: Result<(), _> = owned_reply(
                attempt.clone(),
                async { panic!("failed finalization owner") },
                async {},
            )
            .await;
            assert!(result.unwrap_err().contains("unconfirmed"));
            assert!(attempt.0.cleanup_uncertain.load(Ordering::Acquire));
            assert!(attempt.cancelled());
            assert!(!attempt.ui_ready());
        }
        #[tokio::test]
        async fn cancel_before_builder_poll_joins_unused_core_lifecycle() {
            let attempt = Attempt::new();
            let builder = instant_recording::Actor::builder(
                PathBuf::from("unused-synthetic.cap"),
                ScreenCaptureTarget::CameraOnly,
            );
            attempt
                .attach(PathBuf::from("unused-synthetic.cap"), builder.lifecycle())
                .await
                .unwrap();
            attempt.cancel();
            drop(builder);
            assert!(attempt.capture_cleanup().await);
            assert!(attempt.cancelled());
            assert!(attempt.authorize().is_err());
        }
        #[tokio::test]
        async fn stop_retry_signals_cancellation_before_waiting_for_operation_lock() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            let active = attempt.0.operation.lock().await;
            attempt.prepare_control();
            assert!(attempt.cancelled());
            assert!(attempt.upload().check().is_err());
            drop(active);
        }
        #[test]
        fn explicit_camera_only_system_audio_request_is_rejected_before_normalization() {
            let mut inputs = StartRecordingInputs {
                capture_target: ScreenCaptureTarget::CameraOnly,
                capture_system_audio: true,
                mode: RecordingMode::Instant,
                organization_id: None,
            };
            assert!(validate_inputs(&inputs).is_err());
            assert!(inputs.capture_system_audio);
            inputs.capture_system_audio = false;
            assert!(validate_inputs(&inputs).is_ok());
            inputs.capture_system_audio = true;
            inputs.mode = RecordingMode::Studio;
            assert!(validate_inputs(&inputs).is_ok());
        }
        #[tokio::test]
        async fn terminal_observer_does_not_revoke_an_owned_successful_stop() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            let active = attempt.0.operation.lock().await;
            assert!(!attempt.terminal_needs_cleanup());
            assert!(!attempt.cancelled());
            drop(active);
            assert!(attempt.terminal_needs_cleanup());
            assert!(attempt.cancelled());
        }
        #[tokio::test]
        async fn local_completion_rechecks_after_held_app_lock_before_success_or_delete() {
            for delete_after_upload in [false, true] {
                let attempt = Attempt::new();
                attempt.0.started.send_replace(true);
                let state = tokio::sync::RwLock::new(Vec::new());
                let held = state.read().await;
                let deleted = AtomicBool::new(false);
                let shared = AtomicBool::new(false);
                let future = run_control(
                    &attempt,
                    false,
                    || true,
                    || async {
                        let result = complete_local(
                            &attempt,
                            Ok(()),
                            state.write(),
                            |mut state, result| async move {
                                state.push(result.is_ok());
                                Ok(())
                            },
                        )
                        .await;
                        if result.is_ok() {
                            shared.store(true, Ordering::Release);
                            if delete_after_upload {
                                deleted.store(true, Ordering::Release);
                            }
                        }
                        attempt.record_terminal(false, result)
                    },
                );
                tokio::pin!(future);
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut future)
                        .await
                        .is_err()
                );
                attempt.prepare_control();
                drop(held);
                assert!(future.await.is_err());
                assert_eq!(*state.read().await, vec![false]);
                assert!(!deleted.load(Ordering::Acquire));
                assert!(!shared.load(Ordering::Acquire));
            }
        }

        #[tokio::test]
        async fn local_completion_rechecks_after_owned_cleanup_await() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            let state = tokio::sync::RwLock::new(false);
            let (release, released) = tokio::sync::oneshot::channel();
            let (entered, entering) = tokio::sync::oneshot::channel();
            let shared = AtomicBool::new(false);
            let future = run_control(
                &attempt,
                false,
                || true,
                || async {
                    let result = complete_local(
                        &attempt,
                        Ok(()),
                        state.write(),
                        |mut state, result| async move {
                            assert!(result.is_ok());
                            entered.send(()).unwrap();
                            released.await.unwrap();
                            *state = true;
                            Ok(())
                        },
                    )
                    .await;
                    if result.is_ok() {
                        shared.store(true, Ordering::Release);
                    }
                    attempt.record_terminal(false, result)
                },
            );
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            entering.await.unwrap();
            attempt.prepare_control();
            release.send(()).unwrap();
            assert!(future.await.is_err());
            assert!(*state.read().await);
            assert!(!shared.load(Ordering::Acquire));
        }

        #[tokio::test]
        async fn queued_stop_and_discard_replay_first_joined_error() {
            for queued_discard in [false, true] {
                let attempt = Attempt::new();
                attempt.0.started.send_replace(true);
                let current = AtomicBool::new(true);
                let state = tokio::sync::RwLock::new(());
                let (release, released) = tokio::sync::oneshot::channel();
                let first = run_control(
                    &attempt,
                    false,
                    || current.load(Ordering::Acquire),
                    || async {
                        released.await.unwrap();
                        let result = complete_local(
                            &attempt,
                            Err::<(), _>("required audio failed".into()),
                            state.write(),
                            |_, result| async move {
                                assert_eq!(result.unwrap_err(), "required audio failed");
                                Err("later cleanup error".into())
                            },
                        )
                        .await;
                        attempt.0.ui_ready.store(true, Ordering::Release);
                        let result = attempt.record_terminal(false, result);
                        current.store(false, Ordering::Release);
                        result
                    },
                );
                tokio::pin!(first);
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut first)
                        .await
                        .is_err()
                );
                attempt.prepare_control();
                let second = run_control(
                    &attempt,
                    queued_discard,
                    || current.load(Ordering::Acquire),
                    || async { panic!("queued control must not finalize or delete again") },
                );
                tokio::pin!(second);
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), &mut second)
                        .await
                        .is_err()
                );
                release.send(()).unwrap();
                assert_eq!(first.await.unwrap_err(), "required audio failed");
                assert_eq!(second.await.unwrap_err(), "required audio failed");
            }
        }

        #[tokio::test]
        async fn successful_stop_is_idempotent_but_is_not_successful_discard() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            run_control(
                &attempt,
                false,
                || true,
                || async { attempt.record_terminal(false, Ok(())) },
            )
            .await
            .unwrap();
            run_control(
                &attempt,
                false,
                || false,
                || async { panic!("already finished") },
            )
            .await
            .unwrap();
            let result = run_control(
                &attempt,
                true,
                || false,
                || async { panic!("must not delete") },
            )
            .await;
            assert!(result.unwrap_err().contains("not discarded"));
            run_control(
                &attempt,
                false,
                || false,
                || async { panic!("already finished") },
            )
            .await
            .unwrap();
        }

        #[tokio::test]
        async fn uncertain_cleanup_and_unrelated_generation_never_replay_ui_ready_success() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            attempt.0.ui_ready.store(true, Ordering::Release);
            for _ in 0..2 {
                assert_eq!(
                    run_control(
                        &attempt,
                        false,
                        || true,
                        || async { Err("cleanup unconfirmed".into()) }
                    )
                    .await
                    .unwrap_err(),
                    "cleanup unconfirmed"
                );
            }
            assert!(attempt.0.terminal.lock().unwrap().is_none());
            let result = run_control(
                &attempt,
                false,
                || false,
                || async { panic!("stale generation must not execute") },
            )
            .await;
            assert!(result.unwrap_err().contains("superseded"));
        }

        #[tokio::test]
        async fn terminal_failure_persists_failed_metadata_and_keeps_local_media() {
            let path =
                std::env::temp_dir().join(format!("cap-instant-terminal-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            let media = path.join("synthetic-bytes");
            std::fs::write(&media, b"preserve").unwrap();
            RecordingMeta {
                platform: None,
                project_path: path.clone(),
                pretty_name: "Synthetic terminal failure".into(),
                sharing: None,
                inner: RecordingMetaInner::Instant(InstantRecordingMeta::InProgress {
                    recording: false,
                }),
                upload: Some(cap_project::UploadMeta::Complete),
            }
            .save_for_project()
            .unwrap();
            persist_terminal_failure(&path, "late cancellation").await;
            let meta = RecordingMeta::load_for_project(&path).unwrap();
            assert!(
                matches!(meta.inner, RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) if error == "late cancellation")
            );
            assert_eq!(std::fs::read(&media).unwrap(), b"preserve");
            std::fs::remove_dir_all(path).unwrap();
        }
        fn synthetic_success_effects(
            attempt: &Attempt,
            copies: &Mutex<Vec<String>>,
            cancel_before_copy: bool,
            clipboard_error: bool,
        ) -> Result<(), String> {
            dispatch_success_effects(
                attempt,
                "https://example.invalid/s/fixture?existing=1",
                SuccessEffects {
                    recording_automation: || {},
                    upload_automation: || {},
                    open_link: |_| {
                        if cancel_before_copy {
                            attempt.cancel();
                        }
                        Ok(())
                    },
                    copy_link: |link| {
                        copies.lock().unwrap().push(link);
                        if clipboard_error {
                            Err("synthetic clipboard unavailable".into())
                        } else {
                            Ok(())
                        }
                    },
                    sound: || {},
                },
            )
        }

        async fn finish_synthetic_control(
            attempt: &Attempt,
            state: &tokio::sync::RwLock<()>,
            copies: &Mutex<Vec<String>>,
            outcome: Result<Option<()>, String>,
            discard: bool,
        ) -> Result<(), String> {
            let successful_upload = matches!(outcome, Ok(Some(())));
            let mut result =
                complete_local(attempt, outcome, state.write(), |_, _| async { Ok(()) }).await;
            if result.is_ok() && successful_upload {
                result = synthetic_success_effects(attempt, copies, false, false);
            }
            attempt.record_terminal(discard, result)
        }

        #[tokio::test]
        async fn normal_instant_success_copies_original_link_once_without_auto_open_and_not_on_replay()
         {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            let state = tokio::sync::RwLock::new(());
            let copies = Mutex::new(Vec::new());
            run_control(
                &attempt,
                false,
                || true,
                || finish_synthetic_control(&attempt, &state, &copies, Ok(Some(())), false),
            )
            .await
            .unwrap();
            run_control(
                &attempt,
                false,
                || false,
                || async { panic!("successful replay must not dispatch effects") },
            )
            .await
            .unwrap();
            assert_eq!(
                *copies.lock().unwrap(),
                vec!["https://example.invalid/s/fixture?existing=1"]
            );
        }

        #[tokio::test]
        async fn failed_and_discarded_controls_never_copy_share_link() {
            for (outcome, discard) in [
                (Err("required source failed".into()), false),
                (Ok(None), true),
            ] {
                let attempt = Attempt::new();
                attempt.0.started.send_replace(true);
                let state = tokio::sync::RwLock::new(());
                let copies = Mutex::new(Vec::new());
                let result = run_control(
                    &attempt,
                    discard,
                    || true,
                    || finish_synthetic_control(&attempt, &state, &copies, outcome, discard),
                )
                .await;
                assert_eq!(result.is_ok(), discard);
                assert!(copies.lock().unwrap().is_empty());
            }
        }

        #[tokio::test]
        async fn cancelled_held_local_completion_and_queued_replay_never_copy_link() {
            let attempt = Attempt::new();
            attempt.0.started.send_replace(true);
            let state = tokio::sync::RwLock::new(());
            let held = state.read().await;
            let copies = Mutex::new(Vec::new());
            let first = run_control(
                &attempt,
                false,
                || true,
                || finish_synthetic_control(&attempt, &state, &copies, Ok(Some(())), false),
            );
            tokio::pin!(first);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut first)
                    .await
                    .is_err()
            );
            attempt.prepare_control();
            let second = run_control(
                &attempt,
                false,
                || false,
                || async { panic!("cancelled replay must not dispatch effects") },
            );
            tokio::pin!(second);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut second)
                    .await
                    .is_err()
            );
            drop(held);
            assert!(first.await.is_err());
            assert!(second.await.is_err());
            assert!(copies.lock().unwrap().is_empty());
        }

        #[test]
        fn clipboard_boundary_rechecks_revocation_and_preserves_nonfatal_clipboard_error_policy() {
            let cancelled = Attempt::new();
            let cancelled_copies = Mutex::new(Vec::new());
            assert!(synthetic_success_effects(&cancelled, &cancelled_copies, true, false).is_err());
            assert!(cancelled_copies.lock().unwrap().is_empty());
            let healthy = Attempt::new();
            let attempted_copies = Mutex::new(Vec::new());
            synthetic_success_effects(&healthy, &attempted_copies, false, true).unwrap();
            assert_eq!(attempted_copies.lock().unwrap().len(), 1);
        }
    }
}

#[cfg(test)]
mod editor_recording_restart_tests {
    use super::*;
    use std::sync::Mutex;

    fn editor_target(path: &str) -> EditorRecordingTarget {
        EditorRecordingTarget(Arc::new(Mutex::new(Some(PathBuf::from(path)))))
    }

    #[tokio::test]
    async fn successful_restart_keeps_destination_through_terminal_cleanup() {
        let target = editor_target("original.cap");
        let result = restart_with_editor_target(
            &target,
            async {
                assert!(take_editor_target_after_recording(&target, true).is_none());
                Ok(())
            },
            async { Ok(()) },
            || async {
                assert_eq!(
                    target.0.lock().unwrap().as_deref(),
                    Some(Path::new("original.cap"))
                );
                Ok(RecordingAction::Started)
            },
            |_, _| async { panic!("successful restart must retain the destination") },
        )
        .await;
        assert!(matches!(result, Ok(RecordingAction::Started)));
        assert_eq!(
            take_editor_target_after_recording(&target, false),
            Some(PathBuf::from("original.cap"))
        );
        assert!(target.0.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn failed_replacement_start_clears_only_its_editor_destination() {
        let target = editor_target("original.cap");
        let restored = Mutex::new(None);
        let result = restart_with_editor_target(
            &target,
            async { Ok(()) },
            async { Ok(()) },
            || async { Err("requested microphone unavailable".into()) },
            |expected, cleanup_completed| {
                let target = &target;
                let restored = &restored;
                async move {
                    *restored.lock().unwrap() = take_failed_restart_editor_target(
                        target,
                        expected.as_deref(),
                        cleanup_completed,
                    );
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            *restored.lock().unwrap(),
            Some(PathBuf::from("original.cap"))
        );
        assert!(target.0.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn unconfirmed_old_stop_keeps_active_editor_ownership() {
        let target = editor_target("original.cap");
        let result = restart_with_editor_target(
            &target,
            async { Err("Studio cleanup is unconfirmed".into()) },
            async { panic!("controls cannot restore before confirmed cleanup") },
            || async { panic!("replacement cannot start before confirmed cleanup") },
            |expected, cleanup_completed| {
                let target = &target;
                async move {
                    assert!(
                        take_failed_restart_editor_target(
                            target,
                            expected.as_deref(),
                            cleanup_completed
                        )
                        .is_none()
                    );
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            target.0.lock().unwrap().as_deref(),
            Some(Path::new("original.cap"))
        );
    }

    #[tokio::test]
    async fn replaced_editor_destination_cancels_restart_without_consuming_new_target() {
        let target = editor_target("original.cap");
        let result = restart_with_editor_target(
            &target,
            async {
                *target.0.lock().unwrap() = Some(PathBuf::from("replacement.cap"));
                Ok(())
            },
            async { Ok(()) },
            || async { panic!("a different editor now owns recording") },
            |expected, cleanup_completed| {
                let target = &target;
                async move {
                    assert!(
                        take_failed_restart_editor_target(
                            target,
                            expected.as_deref(),
                            cleanup_completed
                        )
                        .is_none()
                    );
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            target.0.lock().unwrap().as_deref(),
            Some(Path::new("replacement.cap"))
        );
    }

    #[tokio::test]
    async fn losing_restart_cannot_clear_the_winners_target_after_recording_state_is_cleared() {
        let target = editor_target("original.cap");
        let result = restart_with_editor_target(
            &target,
            async { Err("Studio terminal completion is stale".into()) },
            async { panic!("the losing restart cannot restore controls") },
            || async { panic!("the losing restart cannot start another recording") },
            |expected, cleanup_completed| {
                let target = &target;
                async move {
                    let recording_cleared = true;
                    assert!(
                        take_failed_restart_editor_target(
                            target,
                            expected.as_deref(),
                            cleanup_completed && recording_cleared,
                        )
                        .is_none()
                    );
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            target.0.lock().unwrap().as_deref(),
            Some(Path::new("original.cap"))
        );
    }

    #[tokio::test]
    async fn restoration_failure_clears_the_owned_target_before_any_replacement_start() {
        let target = editor_target("original.cap");
        let result = restart_with_editor_target(
            &target,
            async { Ok(()) },
            async { Err("Recording controls could not be restored".into()) },
            || async { panic!("replacement cannot start before controls are restored") },
            |expected, cleanup_completed| {
                let target = &target;
                async move {
                    assert_eq!(
                        take_failed_restart_editor_target(
                            target,
                            expected.as_deref(),
                            cleanup_completed,
                        ),
                        Some(PathBuf::from("original.cap")),
                    );
                }
            },
        )
        .await;
        assert!(result.is_err());
        assert!(target.0.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn caller_cancellation_does_not_abandon_restart_after_old_capture_stops() {
        let target = editor_target("original.cap");
        let retained = target.clone();
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let (finished, finish) = tokio::sync::oneshot::channel();
        let caller = tokio::spawn(async move {
            complete_studio_restart(async move {
                let result = restart_with_editor_target(
                    &target,
                    async {
                        assert!(take_editor_target_after_recording(&target, true).is_none());
                        entered.send(()).unwrap();
                        released.await.unwrap();
                        Ok(())
                    },
                    async { Ok(()) },
                    || async { Ok(RecordingAction::Started) },
                    |_, _| async {
                        panic!("owned replacement must finish after caller cancellation")
                    },
                )
                .await;
                finished.send(()).unwrap();
                result
            })
            .await
        });
        entry.await.unwrap();
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(2), finish)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retained.0.lock().unwrap().as_deref(),
            Some(Path::new("original.cap"))
        );
    }
}

#[cfg(all(test, target_os = "linux"))]
mod studio_joined_completion_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn unconfirmed_stop_never_enters_local_completion() {
        let effects = AtomicUsize::new(0);
        let result = after_studio_join(
            async {
                studio_recording::StudioStopReport {
                    accepted_intent: true,
                    quiescence: studio_recording::StudioQuiescence::Unconfirmed,
                    result: Err("source stop unknown".into()),
                }
            },
            |_| async {
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(result.is_err());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn losing_preserve_cannot_finish_while_discard_local_cleanup_is_waiting() {
        let effects = Arc::new(AtomicUsize::new(0));
        let (entered, entry) = tokio::sync::oneshot::channel();
        let (release, released) = tokio::sync::oneshot::channel();
        let owner = tokio::spawn({
            let effects = effects.clone();
            async move {
                after_studio_join(
                    async {
                        studio_recording::StudioStopReport {
                            accepted_intent: true,
                            quiescence: studio_recording::StudioQuiescence::Joined,
                            result: Ok(studio_recording::CompletedRecording {
                                project_path: std::path::PathBuf::from("synthetic.cap"),
                                meta: cap_project::StudioRecordingMeta::MultipleSegments {
                                    inner: cap_project::MultipleSegments {
                                        segments: Vec::new(),
                                        cursors: Default::default(),
                                        status: Some(cap_project::StudioRecordingStatus::Complete),
                                    },
                                },
                                cursor_data: Default::default(),
                            }),
                        }
                    },
                    |_| async move {
                        entered.send(()).unwrap();
                        released.await.unwrap();
                        effects.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    },
                )
                .await
            }
        });
        entry.await.unwrap();
        let losing = after_studio_join(
            async {
                studio_recording::StudioStopReport {
                    accepted_intent: false,
                    quiescence: studio_recording::StudioQuiescence::Joined,
                    result: Err("different terminal action owns attempt".into()),
                }
            },
            |_| async {
                effects.fetch_add(100, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;
        assert!(losing.is_err());
        assert!(!owner.is_finished());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        release.send(()).unwrap();
        owner.await.unwrap().unwrap();
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn joined_failure_waits_for_app_lock_without_turning_into_success() {
        let app_lock = Arc::new(tokio::sync::RwLock::new(()));
        let held = app_lock.clone().write_owned().await;
        let effects = Arc::new(AtomicUsize::new(0));
        let (joined_tx, joined_rx) = tokio::sync::oneshot::channel();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn({
            let effects = effects.clone();
            async move {
                after_studio_join(
                    async {
                        joined_rx.await.unwrap();
                        studio_recording::StudioStopReport {
                            accepted_intent: true,
                            quiescence: studio_recording::StudioQuiescence::Joined,
                            result: Err("requested microphone failed".into()),
                        }
                    },
                    |result| async move {
                        let _ = entered_tx.send(());
                        let _state = app_lock.write().await;
                        effects.fetch_add(1, Ordering::SeqCst);
                        result.map(|_| ())
                    },
                )
                .await
            }
        });
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        joined_tx.send(()).unwrap();
        entered_rx.await.unwrap();
        assert!(!task.is_finished());
        assert_eq!(effects.load(Ordering::SeqCst), 0);
        drop(held);
        assert!(task.await.unwrap().is_err());
        assert_eq!(effects.load(Ordering::SeqCst), 1);
    }
}

#[cfg(all(test, windows))]
mod windows_studio_control_tests {
    use super::*;

    #[tokio::test]
    async fn studio_unconfirmed_or_losing_stop_cannot_restore_or_delete() {
        for (accepted_intent, stop_acknowledged) in [(true, false), (false, true), (false, false)] {
            let effects = std::sync::atomic::AtomicUsize::new(0);
            let result = after_windows_studio_stop(
                async {
                    studio_recording::WindowsStudioStopReport {
                        accepted_intent,
                        stop_acknowledged,
                        result: Err("encoder join unconfirmed".into()),
                    }
                },
                |_| async {
                    effects.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .await;
            assert!(result.is_err());
            assert_eq!(effects.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
    }
}
