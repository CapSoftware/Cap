//! Media import -- the gpui port of the Tauri binary's `import.rs`: a picked
//! video is transcoded into a fresh `.cap` studio bundle, a picked image
//! becomes a screenshot bundle, and progress is reported through a global the
//! main window's library panel draws.
//!
//! The Tauri version encodes through `cap-enc-ffmpeg`
//! (`H264EncoderBuilder` / `OpusEncoder`), which is not a dependency of this
//! standalone workspace -- the narrow slices of it the import path actually
//! exercises are transcribed here onto the same `ffmpeg-next` this app already
//! builds (each function cites its source). Progress travels the tray-channel
//! shape: the worker thread owns a `flume::Sender` and a foreground task
//! drains it into [`ActiveImports`] with a clean gpui borrow.

use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    time::Duration,
};

use cap_project::{
    AudioMeta, Cursors, MultipleSegment, MultipleSegments, Platform, ProjectConfiguration,
    RecordingMeta, RecordingMetaInner, SingleSegment, StudioRecordingMeta, StudioRecordingStatus,
    VideoMeta,
};
use ffmpeg::{ChannelLayout, codec as avcodec, format as avformat};
use gpui::{App, Global};

/// `import.rs:38-44` in the Tauri binary.
pub const VIDEO_IMPORT_EXTENSIONS: &[&str] =
    &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
pub const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
/// The tray's combined "Media Files" filter (`src-tauri/src/tray.rs:845-851`).
const MEDIA_IMPORT_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv", "png", "jpg", "jpeg", "webp", "gif",
    "bmp", "tif", "tiff",
];
const MAX_IMAGE_DIMENSION: u32 = 16_384;
static ACTIVE_IMPORT_WORKERS: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) static IMPORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `transcode_video` fails with exactly this when the bundle vanishes mid-way
/// (the user deleted it -- the Tauri cancellation seam, `import.rs:1253-1256`);
/// the drain recognises it and skips the error dialog.
const IMPORT_CANCELLED: &str = "Import cancelled";

fn has_supported_extension(path: &Path, extensions: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extensions
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

pub fn is_supported_video_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, VIDEO_IMPORT_EXTENSIONS)
}

pub fn is_supported_image_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, IMAGE_IMPORT_EXTENSIONS)
}

// ---------------------------------------------------------------------------
// Names and bundle paths
// ---------------------------------------------------------------------------

/// `generate_project_name` / `generate_image_project_name` (`import.rs:101-123`).
fn generate_project_name(source_path: &Path, fallback: &str) -> String {
    let stem = source_path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(fallback);
    let now = chrono::Local::now();
    format!("{stem} {}", now.format("%Y-%m-%d at %H.%M.%S"))
}

/// `import.rs:125-132`.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// The `(1)`-suffix uniquing loop from `start_video_import` (`import.rs:1370-1376`).
fn unique_project_path(recordings_dir: &Path, sanitized_name: &str) -> PathBuf {
    let mut project_path = recordings_dir.join(format!("{sanitized_name}.cap"));
    let mut counter = 1;
    while project_path.exists() {
        project_path = recordings_dir.join(format!("{sanitized_name} ({counter}).cap"));
        counter += 1;
    }
    project_path
}

fn check_project_exists(project_path: &Path) -> bool {
    project_path.exists() && project_path.join("recording-meta.json").exists()
}

/// The bundle both metas describe: `content/segments/segment-0/display.mp4`
/// plus an optional sibling `audio.ogg` (`import.rs:1413-1439` and `1506-1536`).
fn imported_video_meta(
    project_path: &Path,
    pretty_name: &str,
    fps: u32,
    has_audio: bool,
    status: StudioRecordingStatus,
) -> RecordingMeta {
    RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.to_path_buf(),
        pretty_name: pretty_name.to_string(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: vec![MultipleSegment {
                    display: VideoMeta {
                        path: "content/segments/segment-0/display.mp4".into(),
                        fps,
                        start_time: Some(0.0),
                        device_id: None,
                    },
                    camera: None,
                    mic: None,
                    system_audio: has_audio.then(|| AudioMeta {
                        path: "content/segments/segment-0/audio.ogg".into(),
                        start_time: Some(0.0),
                        device_id: None,
                        gap_summary: None,
                    }),
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                }],
                cursors: Cursors::default(),
                status: Some(status),
            },
        })),
        upload: None,
    }
}

// ---------------------------------------------------------------------------
// Progress state -- what the main window's library panel draws
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportKind {
    Video,
    Image,
}

/// `ImportStage` (`import.rs:47-53`). Terminal stages never sit in
/// [`ActiveImports`] -- the drain removes the entry and acts instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportStage {
    Probing,
    Converting,
    Finalizing,
    Complete,
    Failed,
}

/// One `VideoImportProgress` event (`import.rs:55-61`), as state instead of an
/// event: the worker sends snapshots and the drain keeps only the latest.
#[derive(Clone, Debug)]
pub struct ImportProgress {
    pub kind: ImportKind,
    pub project_path: PathBuf,
    pub pretty_name: String,
    pub stage: ImportStage,
    pub progress: f64,
    pub message: String,
}

#[derive(Default)]
pub struct ActiveImports(pub Vec<ImportProgress>);

impl Global for ActiveImports {}

/// Every import currently running, for render code. Cloned because paints hold
/// no long borrow on globals and the list is a handful of entries at most.
pub fn imports_snapshot(cx: &App) -> Vec<ImportProgress> {
    cx.try_global::<ActiveImports>()
        .map(|imports| imports.0.clone())
        .unwrap_or_default()
}

pub fn imports_in_flight(cx: &App) -> bool {
    ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire) != 0 || !imports_snapshot(cx).is_empty()
}

pub(crate) struct InFlightImport;

impl InFlightImport {
    pub(crate) fn begin() -> Self {
        ACTIVE_IMPORT_WORKERS.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for InFlightImport {
    fn drop(&mut self) {
        ACTIVE_IMPORT_WORKERS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// One worker->UI update, applied with a clean gpui borrow.
fn apply_progress(update: ImportProgress, cx: &mut App) {
    if !cx.has_global::<ActiveImports>() {
        cx.set_global(ActiveImports::default());
    }

    let terminal = matches!(update.stage, ImportStage::Complete | ImportStage::Failed);
    let complete = update.stage == ImportStage::Complete;
    let kind = update.kind;
    let project_path = update.project_path.clone();

    {
        let imports = cx.global_mut::<ActiveImports>();
        if terminal {
            imports.0.retain(|entry| entry.project_path != project_path);
        } else if let Some(existing) = imports
            .0
            .iter_mut()
            .find(|entry| entry.project_path == update.project_path)
        {
            *existing = update;
        } else {
            imports.0.push(update);
        }
    }

    if complete {
        refresh_libraries(cx);
        // `importVideoPath` opens the editor on the imported bundle; the
        // Tauri version opens it up front and shows `ImportProgress.tsx`
        // inside, this app opens it once the bundle is Complete (deviation:
        // the gpui editor has no importing screen). `importImagePath` ends in
        // `ShowCapWindow::ScreenshotEditor` the same way.
        if cx.has_global::<crate::app_windows::AppWindows>() {
            match kind {
                ImportKind::Video => crate::app_windows::open_editor(project_path, cx),
                ImportKind::Image => crate::app_windows::open_screenshot_editor(project_path, cx),
            }
        }
    }

    repaint_main_window(cx);
}

/// The refresh seam a finished import rides: the Recents carousel and the
/// settings Recordings page (`refresh_library_after_delete`), the open library
/// panel, and the tray's Previous submenu.
fn refresh_libraries(cx: &mut App) {
    if !cx.has_global::<crate::app_windows::AppWindows>() {
        return;
    }
    crate::app_windows::refresh_library_after_delete(cx);
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |view, window, cx| view.refresh_open_library(window, cx))
        .ok();
    crate::tray::refresh_previous(cx);
}

/// The main window is rarely the active window while an import ticks, and an
/// inactive window only repaints when asked (the `refresh_recents` rule).
fn repaint_main_window(cx: &mut App) {
    if !cx.has_global::<crate::app_windows::AppWindows>() {
        return;
    }
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |_, window, cx| {
        cx.notify();
        window.refresh();
    })
    .ok();
}

// ---------------------------------------------------------------------------
// Public API -- the pickers and the path seams the settings pages will call
// ---------------------------------------------------------------------------

pub fn pick_and_import_video(cx: &mut App) {
    cx.spawn(async move |cx| {
        // Blocking modal, so from a spawned task with no borrow held -- the
        // `save_file_panel` rule.
        let Some(path) = pick_import_file(&[("Video Files", VIDEO_IMPORT_EXTENSIONS)]) else {
            return;
        };
        cx.update(|cx| import_video_from_path(path, cx));
    })
    .detach();
}

pub fn pick_and_import_image(cx: &mut App) {
    cx.spawn(async move |cx| {
        let Some(path) = pick_import_file(&[("Image Files", IMAGE_IMPORT_EXTENSIONS)]) else {
            return;
        };
        cx.update(|cx| import_image_from_path(path, cx));
    })
    .detach();
}

/// The tray's "Import Media...": one picker over both filters, routed by
/// extension (`src-tauri/src/tray.rs:839-911`).
pub fn pick_and_import_media(cx: &mut App) {
    cx.spawn(async move |cx| {
        let Some(path) = pick_import_file(&[
            ("Media Files", MEDIA_IMPORT_EXTENSIONS),
            ("Video Files", VIDEO_IMPORT_EXTENSIONS),
            ("Image Files", IMAGE_IMPORT_EXTENSIONS),
        ]) else {
            return;
        };
        if is_supported_video_import_path(&path) {
            cx.update(|cx| import_video_from_path(path, cx));
        } else if is_supported_image_import_path(&path) {
            cx.update(|cx| import_image_from_path(path, cx));
        } else {
            tracing::error!(path = %path.display(), "unsupported media import path");
            show_error_dialog("Unsupported media file.".to_string());
        }
    })
    .detach();
}

/// `start_video_import`, minus the Tauri command envelope: probes, builds the
/// bundle, transcodes on a worker thread, and reports through [`ActiveImports`].
pub fn import_video_from_path(source_path: PathBuf, cx: &mut App) {
    tracing::info!(source = %source_path.display(), "starting video import");
    spawn_import(cx, move |tx| run_video_import(&source_path, &tx));
}

/// `start_image_import`: decodes on a worker thread and writes a screenshot
/// bundle under `<app data>/screenshots`.
pub fn import_image_from_path(source_path: PathBuf, cx: &mut App) {
    tracing::info!(source = %source_path.display(), "starting image import");
    spawn_import(cx, move |tx| run_image_import(&source_path, &tx));
}

/// One worker thread plus its foreground drain. A dedicated thread rather
/// than the background executor because a transcode holds it for the whole
/// conversion -- `tokio::task::spawn_blocking`'s role in the Tauri version.
fn spawn_import(cx: &mut App, work: impl FnOnce(flume::Sender<ImportProgress>) + Send + 'static) {
    let (tx, rx) = flume::unbounded::<ImportProgress>();
    let in_flight = InFlightImport::begin();
    let worker = std::thread::Builder::new()
        .name("cap-media-import".to_string())
        .spawn(move || {
            let _in_flight = in_flight;
            work(tx);
        });
    if let Err(error) = worker {
        tracing::error!("failed to spawn the import worker thread: {error}");
        return;
    }

    cx.spawn(async move |cx| {
        while let Ok(update) = rx.recv_async().await {
            let failed = update.stage == ImportStage::Failed;
            let cancelled = failed && update.message == IMPORT_CANCELLED;
            let kind = update.kind;
            let message = update.message.clone();
            cx.update(|cx| apply_progress(update, cx));
            if failed && !cancelled {
                // Outside the update: the modal spins AppKit's own run loop
                // and may not hold a gpui borrow (the `confirm_dialog` rule).
                show_import_error(kind, &message);
            }
        }
    })
    .detach();
}

/// `NSOpenPanel` through the platform helper on macOS (the generic file panel
/// behind `open_image_panel`), rfd elsewhere -- the same split the delete
/// confirms use.
fn pick_import_file(filters: &[(&str, &[&str])]) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let extensions: Vec<&str> = filters
            .iter()
            .flat_map(|(_, extensions)| extensions.iter().copied())
            .collect();
        crate::platform::open_image_panel(&extensions)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut dialog = rfd::FileDialog::new();
        for (name, extensions) in filters {
            dialog = dialog.add_filter(*name, extensions);
        }
        dialog.pick_file()
    }
}

/// `showImportError` (`utils/importMedia.ts:88-97`) / the tray's blocking
/// error dialogs, one implementation.
fn show_import_error(kind: ImportKind, message: &str) {
    let media = match kind {
        ImportKind::Video => "video",
        ImportKind::Image => "image",
    };
    tracing::error!("failed to import {media}: {message}");
    show_error_dialog(format!("Failed to import {media}: {message}"));
}

fn show_error_dialog(description: String) {
    let _ = rfd::MessageDialog::new()
        .set_title("Import Error")
        .set_description(description)
        .set_level(rfd::MessageLevel::Error)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

// ---------------------------------------------------------------------------
// The workers
// ---------------------------------------------------------------------------

/// The worker half of the progress seam: every send is a whole snapshot, so
/// the drain never has to merge.
struct ProgressSink<'a> {
    tx: &'a flume::Sender<ImportProgress>,
    kind: ImportKind,
    project_path: &'a Path,
    pretty_name: &'a str,
}

impl ProgressSink<'_> {
    fn send(&self, stage: ImportStage, progress: f64, message: &str) {
        let _ = self.tx.send(ImportProgress {
            kind: self.kind,
            project_path: self.project_path.to_path_buf(),
            pretty_name: self.pretty_name.to_string(),
            stage,
            progress,
            message: message.to_string(),
        });
    }
}

/// `start_video_import` (`import.rs:1361-1599`), linearised: the Tauri command
/// does the probe inline and spawns the transcode; here the whole pipeline is
/// already on a worker thread.
fn run_video_import(source_path: &Path, tx: &flume::Sender<ImportProgress>) {
    let recordings_dir = crate::recording::recordings_dir();
    let project_name = generate_project_name(source_path, "Imported Video");
    let project_path = unique_project_path(&recordings_dir, &sanitize_filename(&project_name));
    let sink = ProgressSink {
        tx,
        kind: ImportKind::Video,
        project_path: &project_path,
        pretty_name: &project_name,
    };

    sink.send(ImportStage::Probing, 0.0, "Analyzing video file...");
    match probe_video_can_decode(source_path) {
        Ok(true) => {}
        Ok(false) => {
            sink.send(
                ImportStage::Failed,
                0.0,
                "Video format not supported or file is corrupted",
            );
            return;
        }
        Err(error) => {
            sink.send(
                ImportStage::Failed,
                0.0,
                &format!("Cannot decode video: {error}"),
            );
            return;
        }
    }

    let segment_dir = project_path
        .join("content")
        .join("segments")
        .join("segment-0");
    if let Err(error) = std::fs::create_dir_all(&segment_dir) {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to create project directory: {error}"),
        );
        return;
    }

    let output_video_path = segment_dir.join("display.mp4");
    let output_audio_path = segment_dir.join("audio.ogg");

    // The InProgress meta first, so the library lists the bundle with its
    // "In progress" badge while the conversion runs.
    if let Err(error) = imported_video_meta(
        &project_path,
        &project_name,
        30,
        false,
        StudioRecordingStatus::InProgress,
    )
    .save_for_project()
    {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to save initial metadata: {error:?}"),
        );
        return;
    }

    sink.send(ImportStage::Converting, 0.0, "Starting conversion...");
    let result = transcode_video(
        source_path,
        &output_video_path,
        Some(&output_audio_path),
        &project_path,
        &|progress| {
            sink.send(
                ImportStage::Converting,
                progress,
                &format!("Converting video... {}%", (progress * 100.0) as u32),
            );
        },
        None,
    );

    let (fps, sample_rate) = match result {
        Ok(result) => result,
        Err(error) => {
            if error == IMPORT_CANCELLED {
                tracing::info!("video import cancelled");
            } else {
                tracing::error!("video import transcode failed: {error}");
                // The Tauri version leaves the InProgress meta behind, which
                // reads as a recording that never finishes; a Failed status
                // gives the library its "Recording failed" badge instead.
                if check_project_exists(&project_path)
                    && let Err(save_error) = imported_video_meta(
                        &project_path,
                        &project_name,
                        30,
                        false,
                        StudioRecordingStatus::Failed {
                            error: error.clone(),
                        },
                    )
                    .save_for_project()
                {
                    tracing::warn!("could not mark the import failed: {save_error:?}");
                }
            }
            sink.send(ImportStage::Failed, 0.0, &error);
            return;
        }
    };

    sink.send(
        ImportStage::Finalizing,
        0.95,
        "Creating project metadata...",
    );

    // `import.rs:1490-1504`: an Opus file this small is headers with no
    // samples, so the meta must not point playback at it.
    const MIN_VALID_AUDIO_SIZE: u64 = 1000;
    let audio_file_size = std::fs::metadata(&output_audio_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let has_audio = sample_rate.is_some() && audio_file_size > MIN_VALID_AUDIO_SIZE;

    if let Err(error) = imported_video_meta(
        &project_path,
        &project_name,
        fps,
        has_audio,
        StudioRecordingStatus::Complete,
    )
    .save_for_project()
    {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to save metadata: {error:?}"),
        );
        return;
    }

    // Written before Complete rather than fire-and-forget as the Tauri spawn
    // does, so the refresh that Complete triggers already finds the file.
    let thumbnail = crate::library::bundle_thumbnail_path(&project_path);
    if let Err(error) = crate::library::create_screenshot(&output_video_path, &thumbnail, None) {
        tracing::warn!("could not write the imported video's thumbnail: {error}");
    }

    sink.send(ImportStage::Complete, 1.0, "Import complete!");
    tracing::info!(path = %project_path.display(), "video import complete");
}

/// `start_image_import` (`import.rs:1899-2017`).
fn run_image_import(source_path: &Path, tx: &flume::Sender<ImportProgress>) {
    let screenshots_dir = crate::library::screenshots_dir();
    let project_name = generate_project_name(source_path, "Imported Image");
    // `import.rs:1947-1948`: `:` becomes `.` the way recording bundles spell
    // timestamps, then the reserved characters go.
    let bundle_name = format!("{}.cap", sanitize_filename(&project_name.replace(':', ".")));

    let placeholder_path = screenshots_dir.join(&bundle_name);
    let early = ProgressSink {
        tx,
        kind: ImportKind::Image,
        project_path: &placeholder_path,
        pretty_name: &project_name,
    };

    if !source_path.is_file() {
        early.send(ImportStage::Failed, 0.0, "Image file does not exist");
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&screenshots_dir) {
        early.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to create screenshots directory: {error}"),
        );
        return;
    }

    let project_path = match cap_utils::ensure_unique_filename(&bundle_name, &screenshots_dir) {
        Ok(name) => screenshots_dir.join(name),
        Err(error) => {
            early.send(ImportStage::Failed, 0.0, &error);
            return;
        }
    };
    let sink = ProgressSink {
        tx,
        kind: ImportKind::Image,
        project_path: &project_path,
        pretty_name: &project_name,
    };

    sink.send(ImportStage::Probing, 0.0, "Importing image...");

    let (width, height, rgba) = match decode_image_rgba(source_path) {
        Ok(decoded) => decoded,
        Err(error) => {
            sink.send(ImportStage::Failed, 0.0, &error);
            return;
        }
    };

    if let Err(error) = std::fs::create_dir_all(&project_path) {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to create screenshot project directory: {error}"),
        );
        return;
    }

    let image_path = project_path.join("original.png");
    if let Err(error) = write_png(&image_path, width, height, &rgba) {
        sink.send(ImportStage::Failed, 0.0, &error);
        return;
    }

    // The bundle shape `list_screenshots` scans for: a `.cap` directory whose
    // meta parses, holding a PNG (`import.rs:1981-2009`).
    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: project_path.clone(),
        pretty_name: project_name.clone(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::SingleSegment {
            segment: SingleSegment {
                display: VideoMeta {
                    path: "original.png".into(),
                    fps: 0,
                    start_time: Some(0.0),
                    device_id: None,
                },
                camera: None,
                audio: None,
                cursor: None,
            },
        })),
        upload: None,
    };
    if let Err(error) = meta.save_for_project() {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to save screenshot metadata: {error:?}"),
        );
        return;
    }
    if let Err(error) = ProjectConfiguration::default().write(&project_path) {
        sink.send(
            ImportStage::Failed,
            0.0,
            &format!("Failed to save screenshot project config: {error}"),
        );
        return;
    }

    sink.send(ImportStage::Complete, 1.0, "Import complete!");
    tracing::info!(path = %project_path.display(), "image import complete");
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

/// `probe_video_can_decode` (`crates/enc-ffmpeg/src/remux.rs:322-390`), minus
/// the log suppression that crate wraps around it.
fn probe_video_can_decode(path: &Path) -> Result<bool, String> {
    let input = avformat::input(path).map_err(|e| format!("Failed to open file: {e}"))?;

    let input_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "No video stream found".to_string())?;

    let decoder_ctx = avcodec::Context::from_parameters(input_stream.parameters())
        .map_err(|e| format!("Failed to create decoder context: {e}"))?;
    let mut decoder = decoder_ctx
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create video decoder: {e}"))?;

    let stream_index = input_stream.index();

    let mut input = avformat::input(path).map_err(|e| format!("Failed to reopen file: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();
    let mut packets_tried = 0;
    const MAX_PACKETS: usize = 100;

    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }

        packets_tried += 1;

        if let Err(e) = decoder.send_packet(&packet) {
            if packets_tried >= MAX_PACKETS {
                return Err(format!(
                    "Failed to send packet after {packets_tried} attempts: {e}"
                ));
            }
            continue;
        }

        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(ffmpeg::Error::Eof) => break,
            Err(e) => {
                if packets_tried >= MAX_PACKETS {
                    return Err(format!(
                        "Failed to decode frame after {packets_tried} packets: {e}"
                    ));
                }
                continue;
            }
        }
    }

    if let Err(e) = decoder.send_eof() {
        return Err(format!("Failed to send EOF: {e}"));
    }

    loop {
        match decoder.receive_frame(&mut frame) {
            Ok(()) => return Ok(true),
            Err(ffmpeg::Error::Eof) => break,
            Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => continue,
            Err(e) => return Err(format!("Failed to receive frame after EOF: {e}")),
        }
    }

    Ok(false)
}

/// `get_media_duration` (`remux.rs:543-557`).
fn media_duration(path: &Path) -> Option<Duration> {
    let input = avformat::input(path).ok()?;
    let duration = input.duration();
    (duration > 0).then(|| Duration::from_micros(duration as u64))
}

// ---------------------------------------------------------------------------
// The transcode -- `transcode_video` (`import.rs:1082-1357`)
// ---------------------------------------------------------------------------

/// `cap_media_info::ensure_even` (`crates/media-info/src/lib.rs:406-409`).
fn ensure_even(value: u32) -> u32 {
    let adjusted = value - (value % 2);
    if adjusted == 0 { 2 } else { adjusted }
}

/// `get_bitrate` (`enc-ffmpeg/src/video/h264.rs:1420-1427`) at the builder's
/// default `QUALITY_BPP = 0.3`, which is what the import uses.
fn h264_bitrate(width: u32, height: u32, frame_rate: f32) -> usize {
    let frame_rate_multiplier = ((f64::from(frame_rate) - 30.0).max(0.0) * 0.6) + 30.0;
    let area = f64::from(width) * f64::from(height);
    (area * frame_rate_multiplier * 0.3) as usize
}

pub(crate) fn transcode_editor_video(
    source_path: &Path,
    output_path: &Path,
    audio_output_path: &Path,
    project_path: &Path,
    cancelled: &AtomicBool,
) -> Result<(u32, Option<u32>), String> {
    check_editor_import_cancelled(project_path, Some(cancelled))?;
    if !source_path.is_file() || !has_supported_extension(source_path, &["mp4"]) {
        return Err("Select an MP4 video file to import".to_string());
    }
    transcode_video(
        source_path,
        output_path,
        Some(audio_output_path),
        project_path,
        &|_| {},
        Some(cancelled),
    )
}

fn check_editor_import_cancelled(
    project_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
    if let Some(cancelled) = cancelled
        && (cancelled.load(Ordering::Acquire) || !check_project_exists(project_path))
    {
        return Err(IMPORT_CANCELLED.to_string());
    }
    Ok(())
}

fn receive_import_output(
    result: Result<(), ffmpeg::Error>,
    strict: bool,
    operation: &str,
) -> Result<bool, String> {
    match result {
        Ok(()) => Ok(true),
        Err(ffmpeg::Error::Eof) => Ok(false),
        Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => Ok(false),
        Err(error) if strict => Err(format!("{operation} failed: {error}")),
        Err(_) => Ok(false),
    }
}

fn next_import_packet(
    input: &mut avformat::context::Input,
    project_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<Option<ffmpeg::Packet>, String> {
    loop {
        check_editor_import_cancelled(project_path, cancelled)?;
        let mut packet = ffmpeg::Packet::empty();
        match packet.read(input) {
            Ok(()) => return Ok(Some(packet)),
            Err(ffmpeg::Error::Eof) => return Ok(None),
            Err(error) if cancelled.is_some() => {
                check_editor_import_cancelled(project_path, cancelled)?;
                return Err(format!("Failed to read imported media: {error}"));
            }
            Err(_) => {}
        }
    }
}

fn transcode_video(
    source_path: &Path,
    output_path: &Path,
    audio_output_path: Option<&Path>,
    project_path: &Path,
    report_converting: &dyn Fn(f64),
    cancelled: Option<&AtomicBool>,
) -> Result<(u32, Option<u32>), String> {
    check_editor_import_cancelled(project_path, cancelled)?;
    let strict = cancelled.is_some();
    let mut input = match cancelled {
        Some(cancelled) => {
            avformat::input_with_interrupt(source_path, || cancelled.load(Ordering::Acquire))
        }
        None => avformat::input(source_path),
    }
    .map_err(|error| format!("Failed to open video file: {error}"))?;
    check_editor_import_cancelled(project_path, cancelled)?;

    let (video_stream_index, video_time_base, frame_rate, source_width, source_height) = {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found in file")?;
        let decoder = avcodec::Context::from_parameters(stream.parameters())
            .map_err(|e| format!("Failed to create decoder: {e}"))?
            .decoder()
            .video()
            .map_err(|e| format!("Failed to create decoder: {e}"))?;
        (
            stream.index(),
            stream.time_base(),
            stream.avg_frame_rate(),
            decoder.width(),
            decoder.height(),
        )
    };

    let output_width = ensure_even(source_width);
    let output_height = ensure_even(source_height);
    let fps = if frame_rate.denominator() > 0 {
        ((f64::from(frame_rate.numerator()) / f64::from(frame_rate.denominator())).round() as u32)
            .clamp(1, 120)
    } else {
        30
    };

    let source_duration = if strict {
        (input.duration() > 0).then(|| Duration::from_micros(input.duration() as u64))
    } else {
        media_duration(source_path)
    };
    let total_frames = source_duration
        .map(|duration| (duration.as_secs_f64() * f64::from(fps)) as u64)
        .unwrap_or(1000)
        .max(1);

    let mut video_decoder = avcodec::Context::from_parameters(
        input
            .stream(video_stream_index)
            .ok_or("No video stream found in file")?
            .parameters(),
    )
    .map_err(|e| format!("Failed to create decoder: {e}"))?
    .decoder()
    .video()
    .map_err(|e| format!("Failed to create decoder: {e}"))?;
    if strict {
        video_decoder.check(ffmpeg::codec::decoder::Check::EXPLODE);
    }

    // `import.rs:1122-1131`, empty-layout fixup included.
    let audio_stream_index = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .map(|stream| stream.index());
    if strict
        && audio_stream_index.is_none()
        && input
            .streams()
            .any(|stream| stream.parameters().medium() == ffmpeg::media::Type::Audio)
    {
        return Err("The imported audio track cannot be decoded".to_string());
    }
    let audio_decoder = audio_stream_index
        .map(|index| {
            let stream = input.stream(index).ok_or("Audio stream disappeared")?;
            let decoder_ctx = avcodec::Context::from_parameters(stream.parameters())
                .map_err(|error| format!("Failed to create audio decoder: {error}"))?;
            let mut decoder = decoder_ctx
                .decoder()
                .audio()
                .map_err(|error| format!("Failed to open audio decoder: {error}"))?;
            if strict {
                decoder.check(ffmpeg::codec::decoder::Check::EXPLODE);
            }
            if decoder.channel_layout().is_empty() {
                decoder.set_channel_layout(ChannelLayout::default(i32::from(decoder.channels())));
            }
            decoder.set_packet_time_base(stream.time_base());
            Ok::<_, String>((index, decoder))
        })
        .transpose();
    let mut audio_decoder = if strict {
        audio_decoder?
    } else {
        audio_decoder.unwrap_or(None)
    };

    check_editor_import_cancelled(project_path, cancelled)?;
    if let Some(parent) = output_path.parent() {
        if cancelled.is_some() {
            if !parent.is_dir() {
                return Err(IMPORT_CANCELLED.to_string());
            }
        } else {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create project directory: {e}"))?;
        }
    }

    let mut output =
        avformat::output(output_path).map_err(|e| format!("Failed to create encoder: {e}"))?;
    let mut video_encoder = open_h264_encoder(
        &mut output,
        output_width,
        output_height,
        fps,
        video_time_base,
    )?;
    video_encoder.strict = strict;

    let mut audio: Option<(avformat::context::Output, OpusOutput)> = None;
    let mut sample_rate = None;
    if let (Some((_, decoder)), Some(audio_path)) = (&audio_decoder, audio_output_path) {
        let mut audio_output = avformat::output(audio_path)
            .map_err(|e| format!("Failed to create audio output: {e}"))?;
        let mut opus = open_opus_encoder(
            &mut audio_output,
            decoder.format(),
            decoder.channel_layout(),
            decoder.rate(),
        )?;
        opus.strict = strict;
        audio_output
            .write_header()
            .map_err(|e| format!("Failed to write audio header: {e}"))?;
        sample_rate = Some(decoder.rate());
        audio = Some((audio_output, opus));
    }

    output
        .write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    let mut video_frame = ffmpeg::frame::Video::empty();
    let mut audio_frame = ffmpeg::frame::Audio::empty();
    let mut scaler: Option<ffmpeg::software::scaling::Context> = None;
    let mut frames_processed = 0u64;
    let mut audio_samples_processed = 0u64;
    let mut last_progress = 0.0;

    while let Some(packet) = next_import_packet(&mut input, project_path, cancelled)? {
        check_editor_import_cancelled(project_path, cancelled)?;
        let stream_index = packet.stream();
        if strict
            && packet.is_corrupt()
            && (stream_index == video_stream_index || Some(stream_index) == audio_stream_index)
        {
            return Err("Imported media contains a corrupt packet".to_string());
        }
        if stream_index == video_stream_index {
            video_decoder
                .send_packet(&packet)
                .map_err(|e| format!("Transcoding failed: {e}"))?;
            while receive_import_output(
                video_decoder.receive_frame(&mut video_frame),
                strict,
                "Video decode",
            )? {
                check_editor_import_cancelled(project_path, cancelled)?;
                if strict && video_frame.is_corrupt() {
                    return Err("Imported video contains a corrupt frame".to_string());
                }
                let timestamp = frame_timestamp(&video_frame, video_time_base);
                let frame = convert_for_encode(
                    &video_frame,
                    &mut scaler,
                    video_encoder.pixel_format,
                    output_width,
                    output_height,
                )?;
                video_encoder.queue_frame(frame, timestamp, &mut output)?;

                frames_processed += 1;
                let progress = (frames_processed as f64 / total_frames as f64).min(0.99);
                if progress - last_progress >= 0.01 {
                    last_progress = progress;
                    // Deleting the bundle is how an import is cancelled
                    // (`import.rs:1253-1256`).
                    if !check_project_exists(project_path) {
                        tracing::info!("import cancelled: project directory was deleted");
                        return Err(IMPORT_CANCELLED.to_string());
                    }
                    report_converting(progress);
                }
            }
        } else if let Some((audio_index, decoder)) = audio_decoder.as_mut()
            && stream_index == *audio_index
            && let Some((audio_output, opus)) = audio.as_mut()
        {
            decoder
                .send_packet(&packet)
                .map_err(|e| format!("Transcoding failed: {e}"))?;
            while receive_import_output(
                decoder.receive_frame(&mut audio_frame),
                strict,
                "Audio decode",
            )? {
                check_editor_import_cancelled(project_path, cancelled)?;
                if strict && audio_frame.is_corrupt() {
                    return Err("Imported audio contains a corrupt frame".to_string());
                }
                audio_samples_processed += audio_frame.samples() as u64;
                opus.queue_frame(&audio_frame, audio_output)?;
            }
        }
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    video_decoder
        .send_eof()
        .map_err(|e| format!("Transcoding failed: {e}"))?;
    while receive_import_output(
        video_decoder.receive_frame(&mut video_frame),
        strict,
        "Video decode flush",
    )? {
        check_editor_import_cancelled(project_path, cancelled)?;
        if strict && video_frame.is_corrupt() {
            return Err("Imported video contains a corrupt frame".to_string());
        }
        frames_processed += 1;
        let timestamp = frame_timestamp(&video_frame, video_time_base);
        let frame = convert_for_encode(
            &video_frame,
            &mut scaler,
            video_encoder.pixel_format,
            output_width,
            output_height,
        )?;
        video_encoder.queue_frame(frame, timestamp, &mut output)?;
    }

    if let Some((_, decoder)) = audio_decoder.as_mut() {
        decoder
            .send_eof()
            .map_err(|e| format!("Transcoding failed: {e}"))?;
        while receive_import_output(
            decoder.receive_frame(&mut audio_frame),
            strict,
            "Audio decode flush",
        )? {
            check_editor_import_cancelled(project_path, cancelled)?;
            if strict && audio_frame.is_corrupt() {
                return Err("Imported audio contains a corrupt frame".to_string());
            }
            audio_samples_processed += audio_frame.samples() as u64;
            if let Some((audio_output, opus)) = audio.as_mut() {
                opus.queue_frame(&audio_frame, audio_output)?;
            }
        }
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    if strict
        && (frames_processed == 0 || (audio_stream_index.is_some() && audio_samples_processed == 0))
    {
        return Err("Imported media has an empty video or audio track".to_string());
    }
    video_encoder.flush(&mut output)?;

    if let Some((mut audio_output, mut opus)) = audio.take() {
        opus.flush(&mut audio_output)?;
        audio_output
            .write_trailer()
            .map_err(|e| format!("Failed to write audio trailer: {e}"))?;
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    output
        .write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;
    drop(output);

    // `import.rs:1347-1354`: the editor opens this file the moment Complete
    // lands, so it has to actually be on disk.
    if strict {
        for path in [
            Some(output_path),
            audio_output_path.filter(|_| sample_rate.is_some()),
        ]
        .into_iter()
        .flatten()
        {
            std::fs::OpenOptions::new()
                .write(true)
                .open(path)
                .and_then(|file| file.sync_all())
                .map_err(|error| format!("Failed to save imported media: {error}"))?;
        }
    } else {
        if let Ok(file) = std::fs::File::open(output_path) {
            let _ = file.sync_all();
        }
        if let Some(audio_path) = audio_output_path
            && let Ok(file) = std::fs::File::open(audio_path)
        {
            let _ = file.sync_all();
        }
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    Ok((fps, sample_rate))
}

fn frame_timestamp(frame: &ffmpeg::frame::Video, time_base: ffmpeg::Rational) -> Duration {
    let timestamp = frame.pts().unwrap_or(0);
    let seconds = timestamp as f64 * f64::from(time_base.numerator())
        / f64::from(time_base.denominator().max(1));
    Duration::from_secs_f64(seconds.max(0.0))
}

/// The scaler half of the packet loop (`import.rs:1200-1241`), targeting the
/// encoder's negotiated pixel format instead of a hardcoded YUV420P.
fn convert_for_encode(
    frame: &ffmpeg::frame::Video,
    scaler: &mut Option<ffmpeg::software::scaling::Context>,
    pixel_format: avformat::Pixel,
    width: u32,
    height: u32,
) -> Result<ffmpeg::frame::Video, String> {
    if frame.format() == pixel_format && frame.width() == width && frame.height() == height {
        let mut reference = ffmpeg::frame::Video::empty();
        let status = unsafe { ffmpeg::ffi::av_frame_ref(reference.as_mut_ptr(), frame.as_ptr()) };
        return Ok(if status >= 0 {
            reference
        } else {
            frame.clone()
        });
    }

    if scaler.is_none() {
        *scaler = Some(
            ffmpeg::software::scaling::Context::get(
                frame.format(),
                frame.width(),
                frame.height(),
                pixel_format,
                width,
                height,
                ffmpeg::software::scaling::Flags::BILINEAR,
            )
            .map_err(|e| format!("Failed to create scaler: {e}"))?,
        );
    }
    let scaler = scaler.as_mut().expect("just created");

    let mut scaled = ffmpeg::frame::Video::new(pixel_format, width, height);
    scaler
        .run(frame, &mut scaled)
        .map_err(|e| format!("Transcoding failed: {e}"))?;
    scaled.set_pts(frame.pts());
    Ok(scaled)
}

// ---------------------------------------------------------------------------
// H264 -- the slice of `H264EncoderBuilder` the import path uses
// ---------------------------------------------------------------------------

/// `H264Encoder::TIME_BASE` (`h264.rs:692`).
const H264_STREAM_TIME_BASE: i32 = 90_000;
/// `DEFAULT_KEYFRAME_INTERVAL_SECS` (`h264.rs:993`).
const KEYFRAME_INTERVAL_SECS: u32 = 2;

struct H264Output {
    strict: bool,
    encoder: ffmpeg::codec::encoder::Video,
    stream_index: usize,
    pixel_format: avformat::Pixel,
    packet: ffmpeg::Packet,
    first_pts: Option<i64>,
    last_frame_pts: Option<i64>,
    last_written_dts: Option<i64>,
}

/// The encoder ladder for an offline import: VideoToolbox first on macOS with
/// the software fallback, libx264 alone elsewhere. The Tauri builder also
/// tries nvenc/qsv/amf on Windows, but only behind a round-trip self-test
/// this port does not carry (`h264.rs:1136-1151`); import is not realtime, so
/// libx264 is the safe cross-platform floor.
fn h264_encoder_candidates() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["h264_videotoolbox", "libx264"]
    }
    #[cfg(not(target_os = "macos"))]
    {
        &["libx264"]
    }
}

fn open_h264_encoder(
    output: &mut avformat::context::Output,
    width: u32,
    height: u32,
    fps: u32,
    time_base: ffmpeg::Rational,
) -> Result<H264Output, String> {
    let mut last_error = None;

    for name in h264_encoder_candidates() {
        let Some(codec) = ffmpeg::codec::encoder::find_by_name(name) else {
            continue;
        };

        // `open_video_encoder_inner` (`h264.rs:491-508`): use the codec's own
        // pixel format so the loop's scaler converts exactly once.
        let supports_yuv420p = match codec.video().ok().and_then(|video| video.formats()) {
            Some(mut formats) => formats.any(|format| format == avformat::Pixel::YUV420P),
            None => true,
        };
        let pixel_format = if supports_yuv420p {
            avformat::Pixel::YUV420P
        } else {
            avformat::Pixel::NV12
        };

        match open_h264_with_codec(codec, name, pixel_format, width, height, fps, time_base) {
            Ok(encoder) => {
                let mut stream = output
                    .add_stream(codec)
                    .map_err(|e| format!("Failed to create encoder: {e}"))?;
                let stream_index = stream.index();
                stream.set_time_base((1, H264_STREAM_TIME_BASE));
                stream.set_rate((fps as i32, 1));
                stream.set_parameters(&encoder);
                tracing::info!(
                    encoder = name,
                    width,
                    height,
                    fps,
                    "import H264 encoder ready"
                );
                return Ok(H264Output {
                    strict: false,
                    encoder,
                    stream_index,
                    pixel_format,
                    packet: ffmpeg::Packet::empty(),
                    first_pts: None,
                    last_frame_pts: None,
                    last_written_dts: None,
                });
            }
            Err(error) => {
                tracing::warn!(encoder = name, "import H264 encoder init failed: {error}");
                last_error = Some(error);
            }
        }
    }

    Err(last_error
        .map(|error| format!("Failed to create encoder: {error}"))
        .unwrap_or_else(|| "Failed to create encoder: no H264 codec found".to_string()))
}

fn open_h264_with_codec(
    codec: ffmpeg::codec::codec::Codec,
    name: &str,
    pixel_format: avformat::Pixel,
    width: u32,
    height: u32,
    fps: u32,
    time_base: ffmpeg::Rational,
) -> Result<ffmpeg::codec::encoder::Video, ffmpeg::Error> {
    // `get_codec_and_options` (`h264.rs:1021-1126`) for `H264Preset::Medium`
    // off the export path, which is what the import asks the builder for.
    let keyframe_interval = (KEYFRAME_INTERVAL_SECS * fps).max(1).to_string();
    let mut options = ffmpeg::Dictionary::new();
    match name {
        "h264_videotoolbox" => {
            options.set("realtime", "true");
            options.set("prio_speed", "true");
            options.set("profile", "main");
        }
        "libx264" => {
            options.set("preset", "veryfast");
            options.set("tune", "zerolatency");
            options.set("g", &keyframe_interval);
            options.set("keyint_min", &keyframe_interval);
        }
        _ => {}
    }

    let thread_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);

    let mut encoder_ctx = avcodec::Context::new_with_codec(codec);
    encoder_ctx.set_threading(ffmpeg::threading::Config::count(thread_count));
    let mut encoder = encoder_ctx.encoder().video()?;

    encoder.set_width(width);
    encoder.set_height(height);
    encoder.set_format(pixel_format);
    encoder.set_time_base(time_base);
    encoder.set_frame_rate(Some((fps as i32, 1)));
    encoder.set_colorspace(ffmpeg::color::Space::BT709);
    encoder.set_color_range(ffmpeg::color::Range::MPEG);
    // `h264.rs:611-615`: the BT709 tags travel in the codec context, and
    // ffmpeg-next exposes neither field.
    unsafe {
        (*encoder.as_mut_ptr()).color_primaries = ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709;
        (*encoder.as_mut_ptr()).color_trc =
            ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
    }

    let bitrate = h264_bitrate(width, height, fps as f32);
    encoder.set_bit_rate(bitrate);
    encoder.set_max_bit_rate(bitrate * 3 / 2);

    encoder.open_as_with(codec, options)
}

impl H264Output {
    /// `EncoderBase::update_pts` + `send_frame` (`enc-ffmpeg/src/base.rs:38-115`):
    /// the capture timestamp becomes a first-pts-normalised, strictly
    /// monotonic pts in the encoder's time base.
    fn queue_frame(
        &mut self,
        mut frame: ffmpeg::frame::Video,
        timestamp: Duration,
        output: &mut avformat::context::Output,
    ) -> Result<(), String> {
        let time_base = self.encoder.time_base();
        let ticks_per_second =
            f64::from(time_base.denominator()) / f64::from(time_base.numerator().max(1));
        let pts = (timestamp.as_secs_f64() * ticks_per_second).round() as i64;
        let first_pts = *self.first_pts.get_or_insert(pts);
        let mut pts = pts - first_pts;
        if let Some(last) = self.last_frame_pts
            && pts <= last
        {
            pts = last + 1;
        }
        self.last_frame_pts = Some(pts);
        frame.set_pts(Some(pts));

        self.encoder
            .send_frame(&frame)
            .map_err(|e| format!("Transcoding failed: {e}"))?;
        self.drain_packets(output)
    }

    fn flush(&mut self, output: &mut avformat::context::Output) -> Result<(), String> {
        self.encoder
            .send_eof()
            .map_err(|e| format!("Failed to flush video: {e}"))?;
        self.drain_packets(output)
    }

    fn drain_packets(&mut self, output: &mut avformat::context::Output) -> Result<(), String> {
        while receive_import_output(
            self.encoder.receive_packet(&mut self.packet),
            self.strict,
            "Video encode",
        )? {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                self.encoder.time_base(),
                output.stream(self.stream_index).unwrap().time_base(),
            );
            fix_packet_timestamps(&mut self.packet, &mut self.last_written_dts);
            self.packet
                .write_interleaved(output)
                .map_err(|e| format!("Transcoding failed: {e}"))?;
        }
        Ok(())
    }
}

/// `EncoderBase::process_packets`' timestamp repairs (`base.rs:129-163`),
/// without the one-packet reorder buffer -- that exists for fragmenting
/// muxers, and this path writes plain mp4/ogg.
fn fix_packet_timestamps(packet: &mut ffmpeg::Packet, last_written_dts: &mut Option<i64>) {
    match (packet.pts(), packet.dts()) {
        (Some(pts), None) => packet.set_dts(Some(pts)),
        (None, Some(dts)) => packet.set_pts(Some(dts)),
        _ => {}
    }

    if let (Some(dts), Some(last)) = (packet.dts(), *last_written_dts)
        && dts <= last
    {
        let fixed = last + 1;
        packet.set_dts(Some(fixed));
        if let Some(pts) = packet.pts()
            && pts < fixed
        {
            packet.set_pts(Some(fixed));
        }
    }

    if let (Some(pts), Some(dts)) = (packet.pts(), packet.dts())
        && pts < dts
    {
        packet.set_pts(Some(dts));
    }

    *last_written_dts = packet.dts();
}

// ---------------------------------------------------------------------------
// Opus -- the slice of `OpusEncoder` the import path uses
// ---------------------------------------------------------------------------

struct OpusOutput {
    strict: bool,
    encoder: ffmpeg::codec::encoder::Audio,
    stream_index: usize,
    resampler: ffmpeg::software::resampling::Context,
    /// Packed-f32 bytes waiting to fill a whole encoder frame. A plain FIFO
    /// rather than `BufferedResampler`: an imported file's audio is one
    /// contiguous stream, so the gap/silence machinery has nothing to do and
    /// a running sample counter is the correct pts.
    pending: Vec<u8>,
    bytes_per_sample: usize,
    frame_size: usize,
    channel_layout: ChannelLayout,
    sample_rate: u32,
    next_pts: i64,
    packet: ffmpeg::Packet,
    last_written_dts: Option<i64>,
}

/// `select_output_rate` (`enc-ffmpeg/src/audio/opus.rs:111-117`).
fn select_output_rate(input_rate: i32, supported_rates: &[i32]) -> Option<i32> {
    supported_rates
        .iter()
        .copied()
        .find(|&rate| rate >= input_rate)
        .or_else(|| supported_rates.iter().copied().max())
}

/// `OpusEncoder::init` (`opus.rs:41-95`).
fn open_opus_encoder(
    output: &mut avformat::context::Output,
    input_format: avformat::Sample,
    input_layout: ChannelLayout,
    input_rate: u32,
) -> Result<OpusOutput, String> {
    let codec = ffmpeg::codec::encoder::find_by_name("libopus")
        .ok_or_else(|| "Opus codec not found".to_string())?;

    let rate = {
        let mut rates: Vec<i32> = codec
            .audio()
            .map_err(|e| format!("Failed to create encoder: {e}"))?
            .rates()
            .into_iter()
            .flatten()
            .collect();
        rates.sort_unstable();
        select_output_rate(input_rate as i32, &rates)
            .ok_or_else(|| format!("Sample rate not supported: {input_rate}"))?
    };

    // `opus.rs:70-74`: libopus rejects surround layouts without a mapping
    // family; downmix to stereo through the resampler.
    let channels = input_layout.channels().clamp(1, 2);
    let output_layout = ChannelLayout::default(channels);
    let output_format = avformat::Sample::F32(avformat::sample::Type::Packed);

    let resampler = ffmpeg::software::resampler(
        (input_format, input_layout, input_rate),
        (output_format, output_layout, rate as u32),
    )
    .map_err(|e| format!("Failed to create encoder: audio resampler: {e}"))?;

    let thread_count = std::thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(1);
    let mut encoder_ctx = avcodec::Context::new_with_codec(codec);
    encoder_ctx.set_threading(ffmpeg::threading::Config::count(thread_count));
    let mut encoder = encoder_ctx
        .encoder()
        .audio()
        .map_err(|e| format!("Failed to create encoder: {e}"))?;

    // `OpusEncoder::OUTPUT_BITRATE` (`opus.rs:32`).
    encoder.set_bit_rate(128_000);
    encoder.set_rate(rate);
    encoder.set_format(output_format);
    encoder.set_channel_layout(output_layout);
    encoder.set_time_base((1, rate));

    let encoder = encoder
        .open()
        .map_err(|e| format!("Failed to create encoder: {e}"))?;

    let mut stream = output
        .add_stream(codec)
        .map_err(|e| format!("Failed to create encoder: {e}"))?;
    let stream_index = stream.index();
    stream.set_time_base((1, rate));
    stream.set_parameters(&encoder);

    let frame_size = (encoder.frame_size() as usize).max(1);

    Ok(OpusOutput {
        strict: false,
        encoder,
        stream_index,
        resampler,
        pending: Vec::new(),
        bytes_per_sample: channels as usize * 4,
        frame_size,
        channel_layout: output_layout,
        sample_rate: rate as u32,
        next_pts: 0,
        packet: ffmpeg::Packet::empty(),
        last_written_dts: None,
    })
}

impl OpusOutput {
    fn queue_frame(
        &mut self,
        frame: &ffmpeg::frame::Audio,
        output: &mut avformat::context::Output,
    ) -> Result<(), String> {
        let mut resampled = ffmpeg::frame::Audio::empty();
        let _ = self
            .resampler
            .run(frame, &mut resampled)
            .map_err(|e| format!("Transcoding failed: audio resample: {e}"))?;
        self.buffer_resampled(&resampled);
        self.encode_buffered(false, output)
    }

    fn buffer_resampled(&mut self, resampled: &ffmpeg::frame::Audio) {
        let bytes = resampled.samples() * self.bytes_per_sample;
        if bytes > 0 {
            self.pending.extend_from_slice(&resampled.data(0)[..bytes]);
        }
    }

    fn encode_buffered(
        &mut self,
        include_partial: bool,
        output: &mut avformat::context::Output,
    ) -> Result<(), String> {
        let chunk_bytes = self.frame_size * self.bytes_per_sample;
        while self.pending.len() >= chunk_bytes {
            let chunk: Vec<u8> = self.pending.drain(..chunk_bytes).collect();
            self.encode_chunk(&chunk, output)?;
        }
        // libopus takes a short final frame (AV_CODEC_CAP_SMALL_LAST_FRAME),
        // which is also how `BufferedResampler::flush` ends a stream.
        if include_partial && !self.pending.is_empty() {
            let chunk = std::mem::take(&mut self.pending);
            self.encode_chunk(&chunk, output)?;
        }
        Ok(())
    }

    fn encode_chunk(
        &mut self,
        chunk: &[u8],
        output: &mut avformat::context::Output,
    ) -> Result<(), String> {
        let samples = chunk.len() / self.bytes_per_sample;
        let mut frame = ffmpeg::frame::Audio::new(
            avformat::Sample::F32(avformat::sample::Type::Packed),
            samples,
            self.channel_layout,
        );
        frame.set_rate(self.sample_rate);
        frame.data_mut(0)[..chunk.len()].copy_from_slice(chunk);
        frame.set_pts(Some(self.next_pts));
        self.next_pts += samples as i64;

        self.encoder
            .send_frame(&frame)
            .map_err(|e| format!("Transcoding failed: audio encode: {e}"))?;
        self.drain_packets(output)
    }

    fn flush(&mut self, output: &mut avformat::context::Output) -> Result<(), String> {
        // Drain the resampler's tail the way `BufferedResampler::add_frame`
        // does (`buffered_resampler.rs:84-99`).
        while self.resampler.delay().is_some() {
            let mut resampled = ffmpeg::frame::Audio::new(
                avformat::Sample::F32(avformat::sample::Type::Packed),
                0,
                self.channel_layout,
            );
            let _ = self
                .resampler
                .flush(&mut resampled)
                .map_err(|e| format!("Failed to flush audio: {e}"))?;
            if resampled.samples() == 0 {
                break;
            }
            self.buffer_resampled(&resampled);
        }
        self.encode_buffered(true, output)?;

        self.encoder
            .send_eof()
            .map_err(|e| format!("Failed to flush audio: {e}"))?;
        self.drain_packets(output)
    }

    fn drain_packets(&mut self, output: &mut avformat::context::Output) -> Result<(), String> {
        while receive_import_output(
            self.encoder.receive_packet(&mut self.packet),
            self.strict,
            "Audio encode",
        )? {
            self.packet.set_stream(self.stream_index);
            self.packet.rescale_ts(
                self.encoder.time_base(),
                output.stream(self.stream_index).unwrap().time_base(),
            );
            fix_packet_timestamps(&mut self.packet, &mut self.last_written_dts);
            self.packet
                .write_interleaved(output)
                .map_err(|e| format!("Transcoding failed: audio mux: {e}"))?;
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Image decode + PNG encode
// ---------------------------------------------------------------------------

fn check_image_dimensions(width: u32, height: u32) -> Result<(), String> {
    if width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION {
        return Err(format!("Image dimensions exceed maximum: {width}x{height}"));
    }
    if width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .is_none()
    {
        return Err(format!("Image dimensions overflow: {width}x{height}"));
    }
    Ok(())
}

/// `start_image_import`'s decode (`import.rs:1908-1933`), with an ffmpeg
/// fallback: this workspace's `image` build only carries png/jpeg/webp
/// (Cargo.toml pins the features), so gif/bmp/tiff decode through the same
/// ffmpeg stack the video path uses.
fn decode_image_rgba(source_path: &Path) -> Result<(u32, u32, Vec<u8>), String> {
    match decode_image_with_image_crate(source_path) {
        Ok(decoded) => Ok(decoded),
        Err(image_error) => decode_image_with_ffmpeg(source_path)
            .map_err(|ffmpeg_error| format!("{image_error} ({ffmpeg_error})")),
    }
}

fn decode_image_with_image_crate(source_path: &Path) -> Result<(u32, u32, Vec<u8>), String> {
    let image = image::ImageReader::open(source_path)
        .map_err(|e| format!("Failed to open image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Failed to detect image format: {e}"))?
        .decode()
        .map_err(|e| format!("Failed to decode image: {e}"))?;

    let (width, height) = (image.width(), image.height());
    check_image_dimensions(width, height)?;
    Ok((width, height, image.to_rgba8().into_raw()))
}

fn decode_image_with_ffmpeg(source_path: &Path) -> Result<(u32, u32, Vec<u8>), String> {
    let mut input =
        avformat::input(source_path).map_err(|e| format!("Failed to open image: {e}"))?;
    let stream_index = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("Failed to decode image: no image stream")?
        .index();
    let mut decoder = avcodec::Context::from_parameters(
        input
            .stream(stream_index)
            .ok_or("Failed to decode image: no image stream")?
            .parameters(),
    )
    .map_err(|e| format!("Failed to decode image: {e}"))?
    .decoder()
    .video()
    .map_err(|e| format!("Failed to decode image: {e}"))?;

    let mut frame = ffmpeg::frame::Video::empty();
    let mut decoded = false;
    for (stream, packet) in input.packets() {
        if stream.index() != stream_index {
            continue;
        }
        if decoder.send_packet(&packet).is_err() {
            continue;
        }
        if decoder.receive_frame(&mut frame).is_ok() {
            decoded = true;
            break;
        }
    }
    if !decoded {
        decoder
            .send_eof()
            .map_err(|e| format!("Failed to decode image: {e}"))?;
        decoded = decoder.receive_frame(&mut frame).is_ok();
    }
    if !decoded {
        return Err("Failed to decode image".to_string());
    }

    let (width, height) = (frame.width(), frame.height());
    check_image_dimensions(width, height)?;

    let mut scaler = ffmpeg::software::scaling::Context::get(
        frame.format(),
        width,
        height,
        avformat::Pixel::RGBA,
        width,
        height,
        ffmpeg::software::scaling::Flags::BILINEAR,
    )
    .map_err(|e| format!("Failed to decode image: {e}"))?;
    let mut rgba_frame = ffmpeg::frame::Video::empty();
    scaler
        .run(&frame, &mut rgba_frame)
        .map_err(|e| format!("Failed to decode image: {e}"))?;

    // Row by row: the scaler pads rows to its own stride, the buffer is tight
    // (the `create_screenshot` copy, `library.rs:779-787`).
    let width_usize = width as usize;
    let height_usize = height as usize;
    let src_stride = rgba_frame.stride(0);
    let row_bytes = width_usize * 4;
    let mut buffer = vec![0u8; height_usize * row_bytes];
    for y in 0..height_usize {
        let src = &rgba_frame.data(0)[y * src_stride..y * src_stride + row_bytes];
        buffer[y * row_bytes..(y + 1) * row_bytes].copy_from_slice(src);
    }

    Ok((width, height, buffer))
}

/// The PNG write (`import.rs:1960-1977`).
fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create imported image file: {e}"))?;
    let encoder = image::codecs::png::PngEncoder::new_with_quality(
        std::io::BufWriter::new(file),
        image::codecs::png::CompressionType::Default,
        image::codecs::png::FilterType::Adaptive,
    );
    image::ImageEncoder::write_image(encoder, rgba, width, height, image::ColorType::Rgba8.into())
        .map_err(|e| format!("Failed to encode imported image: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_import_cancellation_interrupts_a_real_conversion() {
        ffmpeg::init().unwrap();
        let root = temp_dir("cancel-conversion");
        let source = root.join("source.mp4");
        let source_bytes =
            include_bytes!("../../media-server/src/__tests__/fixtures/test-with-audio.mp4");
        std::fs::write(&source, source_bytes).unwrap();
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let cancelled = AtomicBool::new(false);
        let result = transcode_video(
            &source,
            &root.join("display.mp4"),
            Some(&root.join("audio.ogg")),
            &root,
            &|_| cancelled.store(true, Ordering::Release),
            Some(&cancelled),
        );
        assert!(cancelled.load(Ordering::Acquire));
        assert!(result.unwrap_err().contains(IMPORT_CANCELLED));
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_editor_import_never_opens_or_creates_media() {
        let root = temp_dir("cancel-before-open");
        let source = root.join("source.mp4");
        std::fs::write(&source, b"invalid input must not be probed").unwrap();
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        let result = transcode_editor_video(
            &source,
            &output,
            &root.join("audio.ogg"),
            &root,
            &AtomicBool::new(true),
        );
        assert_eq!(result.unwrap_err(), IMPORT_CANCELLED);
        assert!(!output.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-import-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn imports_are_in_flight_before_their_first_progress_update() {
        let _imports = IMPORT_TEST_LOCK.lock().unwrap();
        let baseline = ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire);
        let in_flight = InFlightImport::begin();
        assert_eq!(ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire), baseline + 1);

        let (release, released) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _in_flight = in_flight;
            released.recv().unwrap();
        });

        assert_eq!(ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire), baseline + 1);
        release.send(()).unwrap();
        worker.join().unwrap();
        assert_eq!(ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire), baseline);
    }

    #[test]
    fn extension_filters_are_case_insensitive_and_file_gated() {
        let dir = temp_dir("extensions");
        let video = dir.join("clip.MP4");
        let image = dir.join("photo.JPEG");
        let other = dir.join("notes.txt");
        let misnamed_dir = dir.join("folder.mp4");
        std::fs::write(&video, b"v").unwrap();
        std::fs::write(&image, b"i").unwrap();
        std::fs::write(&other, b"t").unwrap();
        std::fs::create_dir_all(&misnamed_dir).unwrap();

        assert!(is_supported_video_import_path(&video));
        assert!(!is_supported_image_import_path(&video));
        assert!(is_supported_image_import_path(&image));
        assert!(!is_supported_video_import_path(&image));
        assert!(!is_supported_video_import_path(&other));
        assert!(!is_supported_image_import_path(&other));
        assert!(
            !is_supported_video_import_path(&misnamed_dir),
            "a directory named like a video is not importable"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sanitize_filename_replaces_reserved_characters() {
        assert_eq!(
            sanitize_filename(r#"a/b\c:d*e?f"g<h>i|j"#),
            "a_b_c_d_e_f_g_h_i_j"
        );
        assert_eq!(sanitize_filename("My Clip 2026"), "My Clip 2026");
    }

    #[test]
    fn project_names_carry_the_source_stem_and_a_timestamp() {
        let name = generate_project_name(Path::new("/tmp/My Clip.mp4"), "Imported Video");
        assert!(name.starts_with("My Clip "), "{name}");
        assert!(name.contains(" at "), "{name}");

        let fallback = generate_project_name(Path::new("/"), "Imported Video");
        assert!(fallback.starts_with("Imported Video "), "{fallback}");
    }

    #[test]
    fn unique_project_path_suffixes_like_the_tauri_import() {
        let dir = temp_dir("unique");

        let first = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00");
        assert!(first.ends_with("Video 2026-01-01 at 10.00.00.cap"));
        std::fs::create_dir_all(&first).unwrap();

        let second = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00");
        assert!(second.ends_with("Video 2026-01-01 at 10.00.00 (1).cap"));
        std::fs::create_dir_all(&second).unwrap();

        let third = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00");
        assert!(third.ends_with("Video 2026-01-01 at 10.00.00 (2).cap"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opus_output_rate_selection_matches_the_tauri_encoder() {
        let supported = [8_000, 12_000, 16_000, 24_000, 48_000];
        assert_eq!(select_output_rate(16_000, &supported), Some(16_000));
        assert_eq!(select_output_rate(96_000, &supported), Some(48_000));
        assert_eq!(select_output_rate(4_000, &supported), Some(8_000));
        assert_eq!(select_output_rate(44_100, &supported), Some(48_000));
    }

    #[test]
    fn ensure_even_rounds_down_and_never_hits_zero() {
        assert_eq!(ensure_even(1920), 1920);
        assert_eq!(ensure_even(1919), 1918);
        assert_eq!(ensure_even(1), 2);
        assert_eq!(ensure_even(0), 2);
    }

    #[test]
    fn matching_import_frame_reuses_reference_counted_pixels() {
        let mut original = ffmpeg::frame::Video::new(avformat::Pixel::YUV420P, 16, 12);
        original.set_pts(Some(417));
        original.data_mut(0)[0] = 81;
        let mut scaler = None;

        let converted =
            convert_for_encode(&original, &mut scaler, avformat::Pixel::YUV420P, 16, 12)
                .expect("reference-counted import frame");

        assert!(scaler.is_none());
        assert_eq!(converted.data(0).as_ptr(), original.data(0).as_ptr());
        assert_eq!(converted.pts(), Some(417));
        let buffer = unsafe { (*original.as_ptr()).buf[0] };
        assert_eq!(unsafe { ffmpeg::ffi::av_buffer_get_ref_count(buffer) }, 2);

        drop(original);

        assert_eq!(converted.data(0)[0], 81);
        let retained_buffer = unsafe { (*converted.as_ptr()).buf[0] };
        assert_eq!(
            unsafe { ffmpeg::ffi::av_buffer_get_ref_count(retained_buffer) },
            1
        );
    }

    #[test]
    fn mismatched_import_frame_still_converts_and_preserves_timestamp() {
        let mut original = ffmpeg::frame::Video::new(avformat::Pixel::RGBA, 16, 12);
        original.set_pts(Some(819));
        let mut scaler = None;

        let converted =
            convert_for_encode(&original, &mut scaler, avformat::Pixel::YUV420P, 16, 12)
                .expect("converted import frame");

        assert!(scaler.is_some());
        assert_eq!(converted.format(), avformat::Pixel::YUV420P);
        assert_eq!(converted.width(), 16);
        assert_eq!(converted.height(), 12);
        assert_eq!(converted.pts(), Some(819));
        assert_ne!(converted.data(0).as_ptr(), original.data(0).as_ptr());
    }
}
