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

use crate::i18n::tr;

/// `import.rs:38-44` in the Tauri binary.
pub const VIDEO_IMPORT_EXTENSIONS: &[&str] =
    &["mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv"];
pub const IMAGE_IMPORT_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
pub const AUDIO_IMPORT_EXTENSIONS: &[&str] = &["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"];
/// The tray's combined "Media Files" filter (`src-tauri/src/tray.rs:845-851`).
const MEDIA_IMPORT_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "wmv", "m4v", "flv", "png", "jpg", "jpeg", "webp", "gif",
    "bmp", "tif", "tiff", "mp3", "wav", "m4a", "aac", "ogg", "opus", "flac",
];
pub(crate) const OVERLAY_IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const MAX_IMAGE_DIMENSION: u32 = 16_384;
static ACTIVE_IMPORT_WORKERS: AtomicUsize = AtomicUsize::new(0);

#[cfg(test)]
pub(crate) static IMPORT_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `transcode_video` fails with exactly this when the bundle vanishes mid-way
/// (the user deleted it -- the Tauri cancellation seam, `import.rs:1253-1256`);
/// the drain recognises it and skips the error dialog.
const IMPORT_CANCELLED: &str = "Import cancelled";

const IMPORT_STOPPED: &str = "The import stopped unexpectedly";

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

pub fn is_supported_audio_import_path(path: &Path) -> bool {
    path.is_file() && has_supported_extension(path, AUDIO_IMPORT_EXTENSIONS)
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

/// The `(1)`-suffix uniquing from `start_video_import` (`import.rs:1370-1376`),
/// through the helper the image import uses so a long source name is cut to
/// fit a folder name instead of failing the import.
fn unique_project_path(recordings_dir: &Path, sanitized_name: &str) -> Result<PathBuf, String> {
    cap_utils::ensure_unique_filename(&format!("{sanitized_name}.cap"), recordings_dir)
        .map(|name| recordings_dir.join(name))
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
                        digital_silence_ms: None,
                    }),
                    cursor: None,
                    keyboard: None,
                    display_notch: None,
                    cursor_shape_version: None,
                }],
                cursors: Cursors::default(),
                status: Some(status),
                cursor_shape_version: cap_project::CURSOR_SHAPE_VERSION,
                audio_only: false,
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

/// The refresh seam a finished import rides: the Recents carousel, the
/// settings Recordings page and the tray's Previous submenu
/// (`refresh_library_after_delete`), and the open library panel.
pub(crate) fn refresh_libraries(cx: &mut App) {
    if !cx.has_global::<crate::app_windows::AppWindows>() {
        return;
    }
    crate::app_windows::refresh_library_after_delete(cx);
    let main = cx.global::<crate::app_windows::AppWindows>().main;
    main.update(cx, |view, window, cx| view.refresh_open_library(window, cx))
        .ok();
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
        let Some(path) = pick_import_file(
            &[(tr::import::filter::video(), VIDEO_IMPORT_EXTENSIONS)],
            cx,
        )
        .await
        else {
            return;
        };
        cx.update(|cx| import_video_from_path(path, cx));
    })
    .detach();
}

pub fn pick_and_import_image(cx: &mut App) {
    cx.spawn(async move |cx| {
        let Some(path) = pick_import_file(
            &[(tr::import::filter::image(), IMAGE_IMPORT_EXTENSIONS)],
            cx,
        )
        .await
        else {
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
        let Some(path) = pick_import_file(
            &[
                (tr::import::filter::media(), MEDIA_IMPORT_EXTENSIONS),
                (tr::import::filter::video(), VIDEO_IMPORT_EXTENSIONS),
                (tr::import::filter::image(), IMAGE_IMPORT_EXTENSIONS),
                (tr::import::filter::audio(), AUDIO_IMPORT_EXTENSIONS),
            ],
            cx,
        )
        .await
        else {
            return;
        };
        if is_supported_video_import_path(&path) {
            cx.update(|cx| import_video_from_path(path, cx));
        } else if is_supported_image_import_path(&path) {
            cx.update(|cx| import_image_from_path(path, cx));
        } else if is_supported_audio_import_path(&path) {
            cx.update(|cx| import_audio_from_path(path, cx));
        } else {
            tracing::error!(path = %path.display(), "unsupported media import path");
            show_error_dialog(tr::import::unsupported().to_string());
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

pub fn import_audio_from_path(source_path: PathBuf, cx: &mut App) {
    tracing::info!(source = %source_path.display(), "starting audio import");
    let pretty_name = generate_project_name(&source_path, "Imported Audio");
    crate::audio_project::open_audio_in_editor(
        cap_export::audio_project::AudioProjectSources {
            microphone: Some(source_path),
            system_audio: None,
        },
        pretty_name,
        cx,
    );
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
        .stack_size(crate::MEDIA_THREAD_STACK_SIZE)
        .spawn(move || {
            let _in_flight = in_flight;
            work(tx);
        });
    if let Err(error) = worker {
        tracing::error!("failed to spawn the import worker thread: {error}");
        return;
    }

    cx.spawn(async move |cx| {
        // Every worker path ends each import it reported with Complete or
        // Failed. One that panics drops the sender first, and its entry would
        // otherwise keep `imports_in_flight` true for the rest of the session.
        let mut unfinished: Vec<ImportProgress> = Vec::new();
        while let Ok(update) = rx.recv_async().await {
            unfinished.retain(|entry| entry.project_path != update.project_path);
            if !matches!(update.stage, ImportStage::Complete | ImportStage::Failed) {
                unfinished.push(update.clone());
            }
            drain_progress(update, cx);
        }
        for mut update in unfinished {
            update.stage = ImportStage::Failed;
            update.progress = 0.0;
            update.message = IMPORT_STOPPED.to_string();
            drain_progress(update, cx);
        }
    })
    .detach();
}

fn drain_progress(update: ImportProgress, cx: &mut gpui::AsyncApp) {
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

/// `NSOpenPanel` through the platform helper on macOS (the generic file panel
/// behind `open_image_panel`), rfd elsewhere -- the same split the delete
/// confirms use.
pub(crate) async fn pick_import_file(
    filters: &[(&str, &[&str])],
    _cx: &mut gpui::AsyncApp,
) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let extensions: Vec<&str> = filters
            .iter()
            .flat_map(|(_, extensions)| extensions.iter().copied())
            .collect();
        crate::platform::open_image_panel(&extensions)
    }
    #[cfg(target_os = "linux")]
    {
        crate::platform::open_file_panel_from_app_async(filters, _cx).await
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
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
    // A blocking native dialog would hang a headless test run.
    if cfg!(test) {
        return;
    }
    show_error_dialog(match kind {
        ImportKind::Video => tr::import::video_failed(message),
        ImportKind::Image => tr::import::image_failed(message),
    });
}

pub(crate) fn show_error_dialog(description: String) {
    if cfg!(test) {
        return;
    }
    let _ = rfd::MessageDialog::new()
        .set_title(tr::import::error_title())
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
    let sanitized_name = sanitize_filename(&project_name);
    let project_path = match unique_project_path(&recordings_dir, &sanitized_name) {
        Ok(path) => path,
        Err(error) => {
            ProgressSink {
                tx,
                kind: ImportKind::Video,
                project_path: &recordings_dir.join(format!("{sanitized_name}.cap")),
                pretty_name: &project_name,
            }
            .send(ImportStage::Failed, 0.0, &error);
            return;
        }
    };
    let sink = ProgressSink {
        tx,
        kind: ImportKind::Video,
        project_path: &project_path,
        pretty_name: &project_name,
    };

    sink.send(ImportStage::Probing, 0.0, tr::import::progress::analyzing());
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

    sink.send(
        ImportStage::Converting,
        0.0,
        tr::import::progress::starting(),
    );
    let result = import_video(
        source_path,
        &output_video_path,
        Some(&output_audio_path),
        &project_path,
        &|progress| {
            sink.send(
                ImportStage::Converting,
                progress,
                &tr::import::progress::converting((progress * 100.0) as u32),
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
        tr::import::progress::metadata(),
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

    sink.send(ImportStage::Complete, 1.0, tr::import::progress::complete());
    tracing::info!(path = %project_path.display(), "video import complete");
    crate::automation::video_imported(project_path.clone());
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

    sink.send(ImportStage::Probing, 0.0, tr::import::progress::image());

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

    sink.send(ImportStage::Complete, 1.0, tr::import::progress::complete());
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

fn frame_duration_ticks(time_base: ffmpeg::Rational, fps: u32) -> i64 {
    let ticks = f64::from(time_base.denominator())
        / (f64::from(time_base.numerator().max(1)) * f64::from(fps.max(1)));
    (ticks.round() as i64).max(1)
}

fn import_decode_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |count| count.get().min(8))
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
    import_video(
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

    let (video_stream_index, video_time_base, frame_rate, unrotated_size, rotation, source_color) = {
        let stream = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .ok_or("No video stream found in file")?;
        let decoder = avcodec::Context::from_parameters(stream.parameters())
            .map_err(|e| format!("Failed to create decoder: {e}"))?
            .decoder()
            .video()
            .map_err(|e| format!("Failed to create decoder: {e}"))?;
        let stream_aspect =
            ffmpeg::Rational::from(unsafe { (*stream.as_ptr()).sample_aspect_ratio });
        (
            stream.index(),
            stream.time_base(),
            stream.avg_frame_rate(),
            square_pixel_size(
                decoder.width(),
                decoder.height(),
                [stream_aspect, decoder.aspect_ratio()],
            ),
            SourceRotation::from_parameters(&stream.parameters()),
            SourceColor::new(
                decoder.format(),
                decoder.color_space(),
                decoder.color_range(),
                decoder.height(),
            ),
        )
    };

    let (scaled_width, scaled_height) = unrotated_size;
    let (output_width, output_height) = rotation.rotated_size(scaled_width, scaled_height);
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
    .map_err(|e| format!("Failed to create decoder: {e}"))?;
    video_decoder.set_threading(ffmpeg::threading::Config {
        kind: ffmpeg::threading::Type::Frame,
        count: import_decode_threads(),
    });
    let mut video_decoder = video_decoder
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create decoder: {e}"))?;
    if strict {
        video_decoder.check(ffmpeg::codec::decoder::Check::EXPLODE);
    }

    let mut audio = ImportAudio::open_decoder(&input, strict)?;

    prepare_output_directory(output_path, project_path, cancelled)?;

    let mut output =
        avformat::output(output_path).map_err(|e| format!("Failed to create encoder: {e}"))?;
    let mut video_encoder = open_h264_encoder(
        &mut output,
        output_width,
        output_height,
        fps,
        video_time_base,
        source_color.output(),
    )?;
    video_encoder.strict = strict;

    audio.open_output(audio_output_path)?;

    output
        .write_header()
        .map_err(|e| format!("Failed to write header: {e}"))?;

    let mut video_frame = ffmpeg::frame::Video::empty();
    let mut scaler: Option<ImportScaler> = None;
    let mut frames_processed = 0u64;
    let mut last_progress = 0.0;

    while let Some(packet) = next_import_packet(&mut input, project_path, cancelled)? {
        check_editor_import_cancelled(project_path, cancelled)?;
        let stream_index = packet.stream();
        if strict
            && packet.is_corrupt()
            && (stream_index == video_stream_index || audio.reads_stream(stream_index))
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
                    scaled_width,
                    scaled_height,
                    source_color,
                )?;
                let frame = rotation.apply(frame)?;
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
        } else {
            audio.push(&packet, project_path, cancelled)?;
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
            scaled_width,
            scaled_height,
            source_color,
        )?;
        let frame = rotation.apply(frame)?;
        video_encoder.queue_frame(frame, timestamp, &mut output)?;
    }

    audio.flush_decoder(project_path, cancelled)?;

    check_editor_import_cancelled(project_path, cancelled)?;
    if strict && (frames_processed == 0 || audio.decoded_nothing()) {
        return Err("Imported media has an empty video or audio track".to_string());
    }
    video_encoder.flush(&mut output)?;

    let sample_rate = audio.finish()?;

    check_editor_import_cancelled(project_path, cancelled)?;
    output
        .write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;
    drop(output);

    sync_imported_media(output_path, audio_output_path, sample_rate, strict)?;

    check_editor_import_cancelled(project_path, cancelled)?;
    Ok((fps, sample_rate))
}

fn prepare_output_directory(
    output_path: &Path,
    project_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(), String> {
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
    Ok(())
}

/// `import.rs:1347-1354`: the editor opens this file the moment Complete
/// lands, so it has to actually be on disk.
fn sync_imported_media(
    output_path: &Path,
    audio_output_path: Option<&Path>,
    sample_rate: Option<u32>,
    strict: bool,
) -> Result<(), String> {
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
    Ok(())
}

struct ImportAudio {
    strict: bool,
    stream_index: Option<usize>,
    decoder: Option<(usize, ffmpeg::decoder::Audio)>,
    output: Option<(avformat::context::Output, OpusOutput)>,
    sample_rate: Option<u32>,
    frame: ffmpeg::frame::Audio,
    samples: u64,
}

impl ImportAudio {
    fn open_decoder(input: &avformat::context::Input, strict: bool) -> Result<Self, String> {
        let stream_index = input
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .map(|stream| stream.index());
        if strict
            && stream_index.is_none()
            && input
                .streams()
                .any(|stream| stream.parameters().medium() == ffmpeg::media::Type::Audio)
        {
            return Err("The imported audio track cannot be decoded".to_string());
        }
        let decoder = stream_index
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
                    decoder
                        .set_channel_layout(ChannelLayout::default(i32::from(decoder.channels())));
                }
                decoder.set_packet_time_base(stream.time_base());
                Ok::<_, String>((index, decoder))
            })
            .transpose();
        let decoder = if strict {
            decoder?
        } else {
            decoder.unwrap_or(None)
        };
        Ok(Self {
            strict,
            stream_index,
            decoder,
            output: None,
            sample_rate: None,
            frame: ffmpeg::frame::Audio::empty(),
            samples: 0,
        })
    }

    fn open_output(&mut self, audio_output_path: Option<&Path>) -> Result<(), String> {
        let (Some((_, decoder)), Some(audio_path)) = (&self.decoder, audio_output_path) else {
            return Ok(());
        };
        let mut audio_output = avformat::output(audio_path)
            .map_err(|e| format!("Failed to create audio output: {e}"))?;
        let mut opus = open_opus_encoder(
            &mut audio_output,
            decoder.format(),
            decoder.channel_layout(),
            decoder.rate(),
        )?;
        opus.strict = self.strict;
        audio_output
            .write_header()
            .map_err(|e| format!("Failed to write audio header: {e}"))?;
        self.sample_rate = Some(decoder.rate());
        self.output = Some((audio_output, opus));
        Ok(())
    }

    fn reads_stream(&self, stream_index: usize) -> bool {
        self.stream_index == Some(stream_index)
    }

    fn push(
        &mut self,
        packet: &ffmpeg::Packet,
        project_path: &Path,
        cancelled: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let Some((audio_index, decoder)) = self.decoder.as_mut() else {
            return Ok(());
        };
        let Some((audio_output, opus)) = self.output.as_mut() else {
            return Ok(());
        };
        if packet.stream() != *audio_index {
            return Ok(());
        }
        decoder
            .send_packet(packet)
            .map_err(|e| format!("Transcoding failed: {e}"))?;
        while receive_import_output(
            decoder.receive_frame(&mut self.frame),
            self.strict,
            "Audio decode",
        )? {
            check_editor_import_cancelled(project_path, cancelled)?;
            if self.strict && self.frame.is_corrupt() {
                return Err("Imported audio contains a corrupt frame".to_string());
            }
            self.samples += self.frame.samples() as u64;
            opus.queue_frame(&self.frame, audio_output)?;
        }
        Ok(())
    }

    fn flush_decoder(
        &mut self,
        project_path: &Path,
        cancelled: Option<&AtomicBool>,
    ) -> Result<(), String> {
        let Some((_, decoder)) = self.decoder.as_mut() else {
            return Ok(());
        };
        decoder
            .send_eof()
            .map_err(|e| format!("Transcoding failed: {e}"))?;
        while receive_import_output(
            decoder.receive_frame(&mut self.frame),
            self.strict,
            "Audio decode flush",
        )? {
            check_editor_import_cancelled(project_path, cancelled)?;
            if self.strict && self.frame.is_corrupt() {
                return Err("Imported audio contains a corrupt frame".to_string());
            }
            self.samples += self.frame.samples() as u64;
            if let Some((audio_output, opus)) = self.output.as_mut() {
                opus.queue_frame(&self.frame, audio_output)?;
            }
        }
        Ok(())
    }

    fn decoded_nothing(&self) -> bool {
        self.stream_index.is_some() && self.samples == 0
    }

    fn finish(mut self) -> Result<Option<u32>, String> {
        if let Some((mut audio_output, mut opus)) = self.output.take() {
            opus.flush(&mut audio_output)?;
            audio_output
                .write_trailer()
                .map_err(|e| format!("Failed to write audio trailer: {e}"))?;
        }
        Ok(self.sample_rate)
    }
}

// ---------------------------------------------------------------------------
// Keeping the source video
// ---------------------------------------------------------------------------

fn import_video(
    source_path: &Path,
    output_path: &Path,
    audio_output_path: Option<&Path>,
    project_path: &Path,
    report_converting: &dyn Fn(f64),
    cancelled: Option<&AtomicBool>,
) -> Result<(u32, Option<u32>), String> {
    let result = transcode_video(
        source_path,
        output_path,
        audio_output_path,
        project_path,
        report_converting,
        cancelled,
    )?;
    let kept_path = cap_rendering::source_video_path(output_path);
    match keep_source_video(source_path, &kept_path, project_path, cancelled) {
        Ok(()) => tracing::info!("import kept the source video next to the re-encode"),
        Err(error) => {
            if let Err(remove_error) = std::fs::remove_file(&kept_path)
                && remove_error.kind() != std::io::ErrorKind::NotFound
            {
                tracing::warn!("could not remove a partial kept video: {remove_error}");
            }
            match error {
                KeepError::Cancelled(error) => return Err(error),
                KeepError::Ineligible(reason) => {
                    tracing::info!(reason, "import keeps only the re-encode");
                }
                KeepError::Failed(error) => {
                    tracing::warn!("import could not keep the source video: {error}");
                }
            }
        }
    }
    Ok(result)
}

#[derive(Debug)]
enum KeepError {
    Ineligible(&'static str),
    Failed(String),
    Cancelled(String),
}

impl From<String> for KeepError {
    fn from(error: String) -> Self {
        if error == IMPORT_CANCELLED {
            Self::Cancelled(error)
        } else {
            Self::Failed(error)
        }
    }
}

/// The longest stretch between keyframes a kept video may have. A seek
/// decodes forward from the keyframe before it in software, so this bounds
/// the worst seek; the 4:4:4 sources this path exists for are often one long
/// group of pictures.
const KEEP_MAX_KEYFRAME_INTERVAL_SECS: f64 = 4.5;
/// The frame rate [`transcode_video`] records for the project. Higher rates
/// stay with the re-encode, which keeps every frame but records 120.
const KEEP_MAX_FPS: f64 = 120.0;
/// Pixels per second above which a kept stream, which decodes in software on
/// every platform, is re-encoded instead. 4K60 4:4:4 played back below its
/// frame rate on an M-series Mac; 1080p60 played at two to three times real
/// time.
const KEEP_MAX_PIXEL_RATE: f64 = 1920.0 * 1080.0 * 60.0;

#[derive(Debug)]
struct KeepPlan {
    stream_index: usize,
    first_pts: i64,
    packets: u64,
    untagged_matrix: Option<ImportMatrix>,
}

fn keep_stream_ineligibility(
    input: &avformat::context::Input,
    stream: &ffmpeg::format::stream::Stream,
) -> Option<&'static str> {
    use ffmpeg::ffi::{
        AVColorPrimaries as Primaries, AVColorRange as Range, AVColorSpace as Space,
        AVColorTransferCharacteristic as Transfer, AVFieldOrder, AVPixelFormat,
    };

    let container = input.format();
    if !container
        .name()
        .split(',')
        .any(|name| matches!(name, "mov" | "mp4"))
    {
        return Some("container");
    }
    let stream_parameters = stream.parameters();
    let parameters = unsafe { &*stream_parameters.as_ptr() };
    // HEVC stays with the re-encode: AVFoundation seeks in it took about
    // seven times as long as in the H.264 a re-encode writes.
    if stream_parameters.id() != ffmpeg::codec::Id::H264 {
        return Some("codec");
    }
    // `avc3` streams may keep their parameter sets in band only.
    if parameters.codec_tag != u32::from_le_bytes(*b"avc1") {
        return Some("sample entry");
    }
    // Only full chroma is worth keeping: kept 4:2:0 seeked up to three times
    // slower on macOS than the re-encode, which hardware decodes cheaply,
    // for no visible gain.
    if parameters.format != AVPixelFormat::AV_PIX_FMT_YUV444P as i32 {
        return Some("pixel format");
    }
    if parameters.color_range == Range::AVCOL_RANGE_JPEG {
        return Some("full range");
    }
    if !matches!(
        parameters.color_space,
        Space::AVCOL_SPC_UNSPECIFIED
            | Space::AVCOL_SPC_BT709
            | Space::AVCOL_SPC_SMPTE170M
            | Space::AVCOL_SPC_BT470BG
    ) {
        return Some("colour matrix");
    }
    if !matches!(
        parameters.color_trc,
        Transfer::AVCOL_TRC_UNSPECIFIED
            | Transfer::AVCOL_TRC_BT709
            | Transfer::AVCOL_TRC_SMPTE170M
            | Transfer::AVCOL_TRC_GAMMA22
            | Transfer::AVCOL_TRC_GAMMA28
            | Transfer::AVCOL_TRC_IEC61966_2_1
    ) {
        return Some("transfer");
    }
    if !matches!(
        parameters.color_primaries,
        Primaries::AVCOL_PRI_UNSPECIFIED
            | Primaries::AVCOL_PRI_BT709
            | Primaries::AVCOL_PRI_SMPTE170M
            | Primaries::AVCOL_PRI_BT470BG
    ) {
        return Some("primaries");
    }
    if !matches!(
        parameters.field_order,
        AVFieldOrder::AV_FIELD_PROGRESSIVE | AVFieldOrder::AV_FIELD_UNKNOWN
    ) {
        return Some("interlaced");
    }
    let (width, height) = (parameters.width, parameters.height);
    if width <= 0 || height <= 0 || width % 2 != 0 || height % 2 != 0 {
        return Some("dimensions");
    }
    if width as u32 > MAX_IMAGE_DIMENSION || height as u32 > MAX_IMAGE_DIMENSION {
        return Some("dimensions");
    }
    if width as usize * height as usize > cap_rendering::decoder::FULL_CHROMA_MAX_PIXELS {
        return Some("frame size");
    }
    let stream_aspect = unsafe { (*stream.as_ptr()).sample_aspect_ratio };
    for ratio in [parameters.sample_aspect_ratio, stream_aspect] {
        if ratio.num > 0 && ratio.den > 0 && ratio.num != ratio.den {
            return Some("sample aspect ratio");
        }
    }
    if source_has_display_matrix(parameters) {
        return Some("display matrix");
    }
    let rate = stream.avg_frame_rate();
    if rate.numerator() <= 0 || rate.denominator() <= 0 || f64::from(rate) > KEEP_MAX_FPS + 0.5 {
        return Some("frame rate");
    }
    let pixel_rate = f64::from(width) * f64::from(height) * f64::from(rate);
    if pixel_rate > KEEP_MAX_PIXEL_RATE * 1.01 {
        return Some("pixel rate");
    }
    None
}

fn source_has_display_matrix(parameters: &ffmpeg::ffi::AVCodecParameters) -> bool {
    const IDENTITY: [i32; 9] = [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 1 << 30];
    unsafe {
        let side_data = ffmpeg::ffi::av_packet_side_data_get(
            parameters.coded_side_data,
            parameters.nb_coded_side_data,
            ffmpeg::ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
        );
        if side_data.is_null() || (*side_data).data.is_null() {
            return false;
        }
        if (*side_data).size < 9 * std::mem::size_of::<i32>() {
            return true;
        }
        std::slice::from_raw_parts((*side_data).data.cast::<i32>(), 9) != IDENTITY
    }
}

fn plan_keep(
    source_path: &Path,
    project_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<KeepPlan, KeepError> {
    let mut input = open_import_input(source_path, cancelled)?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found in file".to_string())?;
    if let Some(reason) = keep_stream_ineligibility(&input, &stream) {
        return Err(KeepError::Ineligible(reason));
    }
    let stream_index = stream.index();
    let time_base = stream.time_base();
    let seconds = |ticks: i64| {
        ticks as f64 * f64::from(time_base.numerator()) / f64::from(time_base.denominator())
    };
    // An untagged source gets the matrix a re-encode would read it with and
    // tag it as, so keeping it does not change its colours.
    let untagged_matrix = {
        let parameters = unsafe { &*stream.parameters().as_ptr() };
        (parameters.color_space == ffmpeg::ffi::AVColorSpace::AVCOL_SPC_UNSPECIFIED).then(|| {
            SourceColor::new(
                avformat::Pixel::YUV444P,
                ffmpeg::color::Space::Unspecified,
                ffmpeg::color::Range::MPEG,
                parameters.height.max(0) as u32,
            )
            .output()
        })
    };
    let max_interval_ticks = (KEEP_MAX_KEYFRAME_INTERVAL_SECS * f64::from(time_base.denominator())
        / f64::from(time_base.numerator().max(1))) as i64;

    let mut presentation = Vec::new();
    let mut last_dts = None;
    let mut first_pts = None;
    let mut keyframes = Vec::new();
    while let Some(packet) = next_import_packet(&mut input, project_path, cancelled)? {
        if packet.stream() != stream_index {
            continue;
        }
        let (Some(pts), Some(dts)) = (packet.pts(), packet.dts()) else {
            return Err(KeepError::Ineligible("missing timestamps"));
        };
        if packet.is_corrupt()
            || unsafe { (*ffmpeg::packet::Ref::as_ptr(&packet)).flags }
                & ffmpeg::ffi::AV_PKT_FLAG_DISCARD
                != 0
            || packet.size() == 0
        {
            return Err(KeepError::Ineligible("unusable packet"));
        }
        if last_dts.is_some_and(|last| dts <= last) || pts < dts {
            return Err(KeepError::Ineligible("decode order"));
        }
        last_dts = Some(dts);
        if first_pts.is_none() {
            if !packet.is_key() {
                return Err(KeepError::Ineligible("no leading keyframe"));
            }
            first_pts = Some(pts);
        }
        if packet.is_key() {
            keyframes.push(pts);
        }
        presentation.push(pts);
    }
    let first_pts = first_pts.ok_or(KeepError::Ineligible("no video"))?;
    presentation.sort_unstable();
    if presentation[0] != first_pts {
        return Err(KeepError::Ineligible("frames before the first keyframe"));
    }
    if presentation.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(KeepError::Ineligible("repeated timestamps"));
    }
    keyframes.sort_unstable();
    keyframes.dedup();
    let end = *presentation.last().expect("at least one packet");
    let longest_gap = keyframes
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .chain(std::iter::once(end - keyframes[keyframes.len() - 1]))
        .max()
        .unwrap_or(0);
    if longest_gap > max_interval_ticks {
        tracing::info!(
            seconds = seconds(longest_gap),
            "source keyframes are too far apart to keep"
        );
        return Err(KeepError::Ineligible("keyframe interval"));
    }

    Ok(KeepPlan {
        stream_index,
        first_pts,
        packets: presentation.len() as u64,
        untagged_matrix,
    })
}

fn open_import_input(
    source_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<avformat::context::Input, String> {
    match cancelled {
        Some(cancelled) => {
            avformat::input_with_interrupt(source_path, || cancelled.load(Ordering::Acquire))
        }
        None => avformat::input(source_path),
    }
    .map_err(|error| format!("Failed to open video file: {error}"))
}

fn keep_source_video(
    source_path: &Path,
    output_path: &Path,
    project_path: &Path,
    cancelled: Option<&AtomicBool>,
) -> Result<(), KeepError> {
    check_editor_import_cancelled(project_path, cancelled)?;
    let plan = plan_keep(source_path, project_path, cancelled)?;
    let strict = cancelled.is_some();

    let mut input = open_import_input(source_path, cancelled)?;
    let source_stream = input
        .stream(plan.stream_index)
        .ok_or("No video stream found in file".to_string())?;
    let source_time_base = source_stream.time_base();
    let mut video_decoder = avcodec::Context::from_parameters(source_stream.parameters())
        .map_err(|e| format!("Failed to create decoder: {e}"))?;
    video_decoder.set_threading(ffmpeg::threading::Config {
        kind: ffmpeg::threading::Type::Frame,
        count: import_decode_threads(),
    });
    let mut video_decoder = video_decoder
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create decoder: {e}"))?;
    video_decoder.check(ffmpeg::codec::decoder::Check::EXPLODE);

    prepare_output_directory(output_path, project_path, cancelled)?;
    let mut output =
        avformat::output(output_path).map_err(|e| format!("Failed to create output: {e}"))?;
    let output_index = {
        let mut stream = output
            .add_stream(ffmpeg::encoder::find(ffmpeg::codec::Id::None))
            .map_err(|e| format!("Failed to create output: {e}"))?;
        stream.set_parameters(source_stream.parameters());
        stream.set_time_base(source_time_base);
        stream.set_rate(source_stream.avg_frame_rate());
        if let Some(matrix) = plan.untagged_matrix {
            let (space, primaries) = match matrix {
                ImportMatrix::Bt709 => (
                    ffmpeg::ffi::AVColorSpace::AVCOL_SPC_BT709,
                    ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709,
                ),
                ImportMatrix::Bt601 => (
                    ffmpeg::ffi::AVColorSpace::AVCOL_SPC_SMPTE170M,
                    ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_SMPTE170M,
                ),
            };
            unsafe {
                let parameters = &mut *(*stream.as_mut_ptr()).codecpar;
                parameters.color_space = space;
                parameters.color_primaries = primaries;
                parameters.color_trc = ffmpeg::ffi::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
                parameters.color_range = ffmpeg::ffi::AVColorRange::AVCOL_RANGE_MPEG;
            }
        }
        stream.index()
    };

    // The MP4 muxer leaves the colour tags out of the container unless asked,
    // and readers that open only the headers would then see none.
    let mut options = ffmpeg::Dictionary::new();
    options.set("movflags", "+write_colr");
    output
        .write_header_with(options)
        .map_err(|e| format!("Failed to write header: {e}"))?;
    let output_time_base = output
        .stream(output_index)
        .ok_or("Output stream disappeared".to_string())?
        .time_base();

    let mut video_frame = ffmpeg::frame::Video::empty();
    let mut packets_copied = 0u64;
    let mut frames_decoded = 0u64;
    let mut decode =
        |decoder: &mut ffmpeg::decoder::Video, frames_decoded: &mut u64| -> Result<(), KeepError> {
            loop {
                match decoder.receive_frame(&mut video_frame) {
                    Ok(()) => {}
                    Err(ffmpeg::Error::Eof) => return Ok(()),
                    Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::ffi::EAGAIN => {
                        return Ok(());
                    }
                    Err(error) => return Err(KeepError::Failed(format!("Video decode: {error}"))),
                }
                check_editor_import_cancelled(project_path, cancelled)?;
                if video_frame.is_corrupt() {
                    return Err(KeepError::Failed("corrupt frame".to_string()));
                }
                if video_frame.format() != avformat::Pixel::YUV444P
                    || video_frame.color_range() == ffmpeg::color::Range::JPEG
                {
                    return Err(KeepError::Ineligible("decoded pixel format"));
                }
                *frames_decoded += 1;
            }
        };

    while let Some(packet) = next_import_packet(&mut input, project_path, cancelled)? {
        check_editor_import_cancelled(project_path, cancelled)?;
        if packet.stream() == plan.stream_index {
            video_decoder
                .send_packet(&packet)
                .map_err(|e| KeepError::Failed(format!("Video decode: {e}")))?;
            decode(&mut video_decoder, &mut frames_decoded)?;

            let mut copy = packet;
            copy.set_stream(output_index);
            copy.set_pts(copy.pts().map(|pts| pts - plan.first_pts));
            copy.set_dts(copy.dts().map(|dts| dts - plan.first_pts));
            copy.set_position(-1isize);
            copy.rescale_ts(source_time_base, output_time_base);
            copy.write_interleaved(&mut output)
                .map_err(|e| format!("Failed to write video: {e}"))?;

            packets_copied += 1;
            if packets_copied % 100 == 0 && !check_project_exists(project_path) {
                tracing::info!("import cancelled: project directory was deleted");
                return Err(KeepError::Cancelled(IMPORT_CANCELLED.to_string()));
            }
        }
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    video_decoder
        .send_eof()
        .map_err(|e| KeepError::Failed(format!("Video decode: {e}")))?;
    decode(&mut video_decoder, &mut frames_decoded)?;
    if packets_copied != plan.packets || frames_decoded != plan.packets {
        return Err(KeepError::Failed(format!(
            "{frames_decoded} frames decoded from {packets_copied} of {} packets",
            plan.packets
        )));
    }

    check_editor_import_cancelled(project_path, cancelled)?;
    output
        .write_trailer()
        .map_err(|e| format!("Failed to write trailer: {e}"))?;
    drop(output);

    let expected_space = plan.untagged_matrix.map(|matrix| match matrix {
        ImportMatrix::Bt709 => ffmpeg::color::Space::BT709,
        ImportMatrix::Bt601 => ffmpeg::color::Space::SMPTE170M,
    });
    if !kept_color_reads_back(output_path, expected_space)? {
        return Err(KeepError::Ineligible("colour tags"));
    }

    sync_imported_media(output_path, None, None, strict)?;
    check_editor_import_cancelled(project_path, cancelled)?;
    Ok(())
}

/// Whether the written file reports one matrix everywhere the editor reads
/// it: the stream tags the native decoders' paths probe, and the decoded
/// frames the FFmpeg path converts. A bitstream that names a matrix of its
/// own overrides the container's tag in the frames.
fn kept_color_reads_back(
    path: &Path,
    expected: Option<ffmpeg::color::Space>,
) -> Result<bool, String> {
    let mut input =
        avformat::input(path).map_err(|e| format!("Failed to reopen kept video: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("Kept video has no video stream".to_string())?;
    let index = stream.index();
    let mut decoder = avcodec::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("Failed to create decoder: {e}"))?
        .decoder()
        .video()
        .map_err(|e| format!("Failed to create decoder: {e}"))?;
    let tagged = decoder.color_space();
    if expected.is_some_and(|expected| expected != tagged) {
        return Ok(false);
    }
    let mut frame = ffmpeg::frame::Video::empty();
    let mut decoded = false;
    for (stream, packet) in input.packets() {
        if stream.index() != index {
            continue;
        }
        decoder
            .send_packet(&packet)
            .map_err(|e| format!("Video decode: {e}"))?;
        if decoder.receive_frame(&mut frame).is_ok() {
            decoded = true;
            break;
        }
    }
    if !decoded {
        decoder
            .send_eof()
            .map_err(|e| format!("Video decode: {e}"))?;
        decoded = decoder.receive_frame(&mut frame).is_ok();
    }
    Ok(decoded
        && frame.color_space() == tagged
        && frame.color_range() != ffmpeg::color::Range::JPEG)
}

fn frame_timestamp(frame: &ffmpeg::frame::Video, time_base: ffmpeg::Rational) -> Duration {
    let timestamp = frame.pts().unwrap_or(0);
    let seconds = timestamp as f64 * f64::from(time_base.numerator())
        / f64::from(time_base.denominator().max(1));
    Duration::from_secs_f64(seconds.max(0.0))
}

/// The Y'CbCr matrix an imported display.mp4 is written and tagged with. The
/// renderer decodes with BT.709 for a BT.709 tag and BT.601 for anything
/// else, so the tag has to describe the samples the scaler wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImportMatrix {
    Bt601,
    Bt709,
}

/// How the imported video's samples are encoded: the matrix and whether they
/// use the full 0-255 range. The output is always limited range, which is
/// what the renderer reads.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SourceColor {
    matrix: ImportMatrix,
    full_range: bool,
    rgb: bool,
}

impl SourceColor {
    fn new(
        format: avformat::Pixel,
        space: ffmpeg::color::Space,
        range: ffmpeg::color::Range,
        height: u32,
    ) -> Self {
        let rgb = pixel_format_is_rgb(format);
        let matrix = match space {
            _ if rgb => ImportMatrix::Bt709,
            ffmpeg::color::Space::BT709 => ImportMatrix::Bt709,
            ffmpeg::color::Space::BT470BG | ffmpeg::color::Space::SMPTE170M => ImportMatrix::Bt601,
            // Untagged video follows the usual convention: BT.601 for
            // standard definition, BT.709 for HD.
            ffmpeg::color::Space::Unspecified if height < 720 => ImportMatrix::Bt601,
            _ => ImportMatrix::Bt709,
        };
        let full_range = rgb
            || range == ffmpeg::color::Range::JPEG
            || matches!(
                format,
                avformat::Pixel::YUVJ420P
                    | avformat::Pixel::YUVJ422P
                    | avformat::Pixel::YUVJ444P
                    | avformat::Pixel::YUVJ440P
                    | avformat::Pixel::YUVJ411P
            );
        Self {
            matrix,
            full_range,
            rgb,
        }
    }

    /// Swscale converts range between Y'CbCr formats but never the matrix, so
    /// a Y'CbCr source keeps its own; an RGB source is encoded with the
    /// matrix chosen above.
    fn output(self) -> ImportMatrix {
        self.matrix
    }
}

fn pixel_format_is_rgb(format: avformat::Pixel) -> bool {
    format.descriptor().is_some_and(|descriptor| unsafe {
        (*descriptor.as_ptr()).flags & ffmpeg::ffi::AV_PIX_FMT_FLAG_RGB as u64 != 0
    })
}

/// A swscale context built with the source range set before it initialises.
/// Swscale picks a plain copy for matching formats at init and ignores a
/// range changed afterwards, and `ffmpeg-next` only builds initialised
/// contexts, so the options go in through the C API here.
struct ImportScaler {
    context: *mut ffmpeg::ffi::SwsContext,
    input: (avformat::Pixel, u32, u32, bool),
    output: (avformat::Pixel, u32, u32),
}

impl ImportScaler {
    fn new(
        input: (avformat::Pixel, u32, u32, bool),
        output: (avformat::Pixel, u32, u32),
        rgb: bool,
    ) -> Result<Self, String> {
        let (input_format, input_width, input_height, full_range) = input;
        let (output_format, output_width, output_height) = output;
        let context = unsafe { ffmpeg::ffi::sws_alloc_context() };
        if context.is_null() {
            return Err("Failed to create scaler".to_string());
        }
        let scaler = Self {
            context,
            input,
            output,
        };
        let options: [(&std::ffi::CStr, i64); 9] = [
            (c"srcw", i64::from(input_width)),
            (c"srch", i64::from(input_height)),
            (
                c"src_format",
                ffmpeg::ffi::AVPixelFormat::from(input_format) as i64,
            ),
            (c"dstw", i64::from(output_width)),
            (c"dsth", i64::from(output_height)),
            (
                c"dst_format",
                ffmpeg::ffi::AVPixelFormat::from(output_format) as i64,
            ),
            (
                c"sws_flags",
                i64::from(ffmpeg::software::scaling::Flags::BILINEAR.bits()),
            ),
            (c"src_range", i64::from(full_range)),
            (c"dst_range", 0),
        ];
        for (name, value) in options {
            let status =
                unsafe { ffmpeg::ffi::av_opt_set_int(context.cast(), name.as_ptr(), value, 0) };
            if status < 0 {
                return Err(format!(
                    "Failed to configure the scaler ({}): {}",
                    name.to_string_lossy(),
                    ffmpeg::Error::from(status)
                ));
            }
        }
        let status = unsafe {
            ffmpeg::ffi::sws_init_context(context, std::ptr::null_mut(), std::ptr::null_mut())
        };
        if status < 0 {
            return Err(format!(
                "Failed to create scaler: {}",
                ffmpeg::Error::from(status)
            ));
        }
        // RGB input encodes with the BT.709 matrix the stream is tagged with
        // (swscale defaults to BT.601), as `cap_enc_ffmpeg` does. Y'CbCr input
        // keeps its matrix: swscale never converts it between Y'CbCr formats.
        if rgb {
            let status = unsafe {
                let bt709 = ffmpeg::ffi::sws_getCoefficients(ffmpeg::ffi::SWS_CS_ITU709);
                ffmpeg::ffi::sws_setColorspaceDetails(
                    context,
                    bt709,
                    1,
                    bt709,
                    0,
                    0,
                    1 << 16,
                    1 << 16,
                )
            };
            if status < 0 {
                return Err(format!(
                    "Failed to configure the scaler colour: {}",
                    ffmpeg::Error::from(status)
                ));
            }
        }
        Ok(scaler)
    }

    fn run(
        &mut self,
        frame: &ffmpeg::frame::Video,
        output: &mut ffmpeg::frame::Video,
    ) -> Result<(), String> {
        let (format, width, height) = self.output;
        if frame.width() != self.input.1
            || frame.height() != self.input.2
            || output.format() != format
            || output.width() != width
            || output.height() != height
        {
            return Err("Transcoding failed: scaler size changed".to_string());
        }
        let status = unsafe {
            ffmpeg::ffi::sws_scale(
                self.context,
                (*frame.as_ptr()).data.as_ptr() as *const *const _,
                (*frame.as_ptr()).linesize.as_ptr() as *const _,
                0,
                self.input.2 as std::os::raw::c_int,
                (*output.as_mut_ptr()).data.as_ptr(),
                (*output.as_mut_ptr()).linesize.as_ptr() as *mut _,
            )
        };
        if status < 0 {
            return Err(format!(
                "Transcoding failed: {}",
                ffmpeg::Error::from(status)
            ));
        }
        Ok(())
    }
}

impl Drop for ImportScaler {
    fn drop(&mut self) {
        unsafe { ffmpeg::ffi::sws_freeContext(self.context) };
    }
}

/// The scaler half of the packet loop (`import.rs:1200-1241`), targeting the
/// encoder's negotiated pixel format instead of a hardcoded YUV420P. The
/// scaler is rebuilt whenever a frame's format, size or range differs from
/// the one it was built for.
fn convert_for_encode(
    frame: &ffmpeg::frame::Video,
    scaler: &mut Option<ImportScaler>,
    pixel_format: avformat::Pixel,
    width: u32,
    height: u32,
    color: SourceColor,
) -> Result<ffmpeg::frame::Video, String> {
    let full_range = color.full_range || frame.color_range() == ffmpeg::color::Range::JPEG;
    if frame.format() == pixel_format
        && frame.width() == width
        && frame.height() == height
        && !full_range
    {
        let mut reference = ffmpeg::frame::Video::empty();
        let status = unsafe { ffmpeg::ffi::av_frame_ref(reference.as_mut_ptr(), frame.as_ptr()) };
        return Ok(if status >= 0 {
            reference
        } else {
            frame.clone()
        });
    }

    let input = (frame.format(), frame.width(), frame.height(), full_range);
    let output = (pixel_format, width, height);
    let reusable = scaler
        .as_ref()
        .is_some_and(|scaler| scaler.input == input && scaler.output == output);
    if !reusable {
        *scaler = Some(ImportScaler::new(input, output, color.rgb)?);
    }
    let scaler = scaler.as_mut().expect("just created");

    let mut scaled = ffmpeg::frame::Video::new(pixel_format, width, height);
    scaler.run(frame, &mut scaled)?;
    scaled.set_pts(frame.pts());
    Ok(scaled)
}

/// The coded size resampled to square pixels. Anamorphic sources (a non-1:1
/// sample aspect ratio) otherwise reach the editor at their coded size, which
/// stretches them because nothing downstream reads the ratio.
fn square_pixel_size(width: u32, height: u32, sample_aspects: [ffmpeg::Rational; 2]) -> (u32, u32) {
    let display_width = sample_aspects
        .into_iter()
        .find(|ratio| ratio.numerator() > 0 && ratio.denominator() > 0)
        .map(|ratio| {
            f64::from(width) * f64::from(ratio.numerator()) / f64::from(ratio.denominator())
        })
        .filter(|width| width.is_finite() && (2.0..=f64::from(MAX_IMAGE_DIMENSION)).contains(width))
        .map_or(width, |width| width.round() as u32);
    (ensure_even(display_width), ensure_even(height))
}

/// Clockwise turn that makes a source upright. Phone cameras store portrait
/// video as landscape pixels plus a display matrix; the bundle's display.mp4
/// carries no matrix and the editor never reads one, so the import bakes the
/// turn into the pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceRotation {
    None,
    Clockwise90,
    Clockwise180,
    Clockwise270,
}

impl SourceRotation {
    fn from_parameters(parameters: &avcodec::Parameters) -> Self {
        let counterclockwise = unsafe {
            let parameters = parameters.as_ptr();
            let side_data = ffmpeg::ffi::av_packet_side_data_get(
                (*parameters).coded_side_data,
                (*parameters).nb_coded_side_data,
                ffmpeg::ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
            );
            if side_data.is_null()
                || (*side_data).data.is_null()
                || (*side_data).size < 9 * std::mem::size_of::<i32>()
            {
                return Self::None;
            }
            ffmpeg::ffi::av_display_rotation_get((*side_data).data.cast::<i32>())
        };
        Self::from_counterclockwise_degrees(counterclockwise)
    }

    fn from_counterclockwise_degrees(degrees: f64) -> Self {
        if !degrees.is_finite() {
            return Self::None;
        }
        match (-degrees.round()).rem_euclid(360.0) as u32 {
            90 => Self::Clockwise90,
            180 => Self::Clockwise180,
            270 => Self::Clockwise270,
            _ => Self::None,
        }
    }

    fn rotated_size(self, width: u32, height: u32) -> (u32, u32) {
        match self {
            Self::Clockwise90 | Self::Clockwise270 => (height, width),
            Self::None | Self::Clockwise180 => (width, height),
        }
    }

    fn apply(self, frame: ffmpeg::frame::Video) -> Result<ffmpeg::frame::Video, String> {
        if self == Self::None {
            return Ok(frame);
        }
        let format = frame.format();
        if !matches!(format, avformat::Pixel::YUV420P | avformat::Pixel::NV12) {
            return Err(format!("Cannot rotate {format:?} video frames"));
        }
        let (width, height) = self.rotated_size(frame.width(), frame.height());
        let mut rotated = ffmpeg::frame::Video::new(format, width, height);
        for plane in 0..frame.planes() {
            let sample_bytes = if format == avformat::Pixel::NV12 && plane == 1 {
                2
            } else {
                1
            };
            let source = SourcePlane {
                data: frame.data(plane),
                stride: frame.stride(plane),
                width: frame.plane_width(plane) as usize,
                height: frame.plane_height(plane) as usize,
                sample_bytes,
            };
            let dst_stride = rotated.stride(plane);
            source.rotate_into(rotated.data_mut(plane), dst_stride, self);
        }
        rotated.set_pts(frame.pts());
        Ok(rotated)
    }
}

struct SourcePlane<'a> {
    data: &'a [u8],
    stride: usize,
    width: usize,
    height: usize,
    sample_bytes: usize,
}

impl SourcePlane<'_> {
    fn rotate_into(&self, dst: &mut [u8], dst_stride: usize, rotation: SourceRotation) {
        match self.sample_bytes {
            2 => self.rotate_samples::<2>(dst, dst_stride, rotation),
            _ => self.rotate_samples::<1>(dst, dst_stride, rotation),
        }
    }

    fn rotate_samples<const SAMPLE: usize>(
        &self,
        dst: &mut [u8],
        dst_stride: usize,
        rotation: SourceRotation,
    ) {
        let (width, height) = (self.width, self.height);
        match rotation {
            SourceRotation::None => self.copy_tiles::<SAMPLE>(dst, dst_stride, |x, y| (x, y)),
            SourceRotation::Clockwise90 => {
                self.copy_tiles::<SAMPLE>(dst, dst_stride, |x, y| (height - 1 - y, x))
            }
            SourceRotation::Clockwise180 => {
                self.copy_tiles::<SAMPLE>(dst, dst_stride, |x, y| (width - 1 - x, height - 1 - y))
            }
            SourceRotation::Clockwise270 => {
                self.copy_tiles::<SAMPLE>(dst, dst_stride, |x, y| (y, width - 1 - x))
            }
        }
    }

    fn copy_tiles<const SAMPLE: usize>(
        &self,
        dst: &mut [u8],
        dst_stride: usize,
        destination: impl Fn(usize, usize) -> (usize, usize),
    ) {
        const TILE: usize = 64;
        for tile_y in (0..self.height).step_by(TILE) {
            for tile_x in (0..self.width).step_by(TILE) {
                for y in tile_y..(tile_y + TILE).min(self.height) {
                    let row = &self.data[y * self.stride..];
                    for x in tile_x..(tile_x + TILE).min(self.width) {
                        let (dst_x, dst_y) = destination(x, y);
                        let to = dst_y * dst_stride + dst_x * SAMPLE;
                        let from = x * SAMPLE;
                        dst[to..to + SAMPLE].copy_from_slice(&row[from..from + SAMPLE]);
                    }
                }
            }
        }
    }
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
    frame_duration: i64,
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
    matrix: ImportMatrix,
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

        match open_h264_with_codec(
            codec,
            name,
            pixel_format,
            width,
            height,
            fps,
            time_base,
            matrix,
        ) {
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
                let frame_duration = frame_duration_ticks(encoder.time_base(), fps);
                return Ok(H264Output {
                    strict: false,
                    encoder,
                    stream_index,
                    pixel_format,
                    packet: ffmpeg::Packet::empty(),
                    frame_duration,
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

#[allow(clippy::too_many_arguments)]
fn open_h264_with_codec(
    codec: ffmpeg::codec::codec::Codec,
    name: &str,
    pixel_format: avformat::Pixel,
    width: u32,
    height: u32,
    fps: u32,
    time_base: ffmpeg::Rational,
    matrix: ImportMatrix,
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
            // zerolatency also switches x264 to sliced threads, which encode one
            // frame at a time. An offline import can take frame threads' few
            // frames of delay; the stream stays free of B-frames and lookahead.
            options.set("x264-params", "sliced-threads=0");
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
    // BT.601 sources keep their matrix, so the stream says so; the SMPTE 170M
    // primaries go with it. The transfer curve is the same for both.
    let (space, primaries) = match matrix {
        ImportMatrix::Bt709 => (
            ffmpeg::color::Space::BT709,
            ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_BT709,
        ),
        ImportMatrix::Bt601 => (
            ffmpeg::color::Space::SMPTE170M,
            ffmpeg::ffi::AVColorPrimaries::AVCOL_PRI_SMPTE170M,
        ),
    };
    encoder.set_colorspace(space);
    encoder.set_color_range(ffmpeg::color::Range::MPEG);
    // `h264.rs:611-615`: the primaries and transfer tags travel in the codec
    // context, and ffmpeg-next exposes neither field.
    unsafe {
        (*encoder.as_mut_ptr()).color_primaries = primaries;
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
            // Encoders leave this at 0, and the mp4 muxer then gives the last
            // sample no duration, so the edit list ends one frame early and
            // players discard the final frame.
            if self.packet.duration() <= 0 {
                self.packet.set_duration(self.frame_duration);
            }
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
    let image = cap_gpui_kernels::codec::decode_image_file(source_path)?;

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
    let buffer = cap_gpui_kernels::frame::copy_rows(
        rgba_frame.data(0),
        row_bytes,
        src_stride,
        height_usize,
        false,
    )
    .ok_or_else(|| "Failed to decode image".to_string())?;

    Ok((width, height, buffer))
}

/// The PNG write (`import.rs:1960-1977`).
fn write_png(path: &Path, width: u32, height: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path)
        .map_err(|e| format!("Failed to create imported image file: {e}"))?;
    cap_gpui_kernels::codec::write_png_file(
        file,
        rgba,
        width,
        height,
        image::ColorType::Rgba8.into(),
        image::codecs::png::CompressionType::Default,
        image::codecs::png::FilterType::Adaptive,
    )
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

    /// A worker that panics never sends Complete or Failed, so its import has
    /// to leave the list anyway or `imports_in_flight` stays true for good.
    #[cfg(target_os = "linux")]
    #[gpui::test]
    fn a_panicking_import_worker_leaves_no_import_in_flight(cx: &mut gpui::TestAppContext) {
        let _imports = IMPORT_TEST_LOCK.lock().unwrap();
        let baseline = ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire);
        let root = temp_dir("worker-panic");
        let project_path = root.join("Imported Video.cap");
        cx.update(|cx| {
            spawn_import(cx, move |tx| {
                let _ = tx.send(ImportProgress {
                    kind: ImportKind::Video,
                    project_path,
                    pretty_name: "Imported Video".to_string(),
                    stage: ImportStage::Converting,
                    progress: 0.5,
                    message: String::new(),
                });
                panic!("import worker panicked mid-conversion");
            });
        });

        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while ACTIVE_IMPORT_WORKERS.load(Ordering::Acquire) != baseline {
            assert!(std::time::Instant::now() < deadline, "worker never ended");
            std::thread::sleep(Duration::from_millis(5));
        }
        cx.run_until_parked();

        cx.update(|cx| {
            assert!(imports_snapshot(cx).is_empty());
            assert!(!imports_in_flight(cx));
        });
        std::fs::remove_dir_all(root).unwrap();
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

        let first = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00").unwrap();
        assert!(first.ends_with("Video 2026-01-01 at 10.00.00.cap"));
        std::fs::create_dir_all(&first).unwrap();

        let second = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00").unwrap();
        assert!(second.ends_with("Video 2026-01-01 at 10.00.00 (1).cap"));
        std::fs::create_dir_all(&second).unwrap();

        let third = unique_project_path(&dir, "Video 2026-01-01 at 10.00.00").unwrap();
        assert!(third.ends_with("Video 2026-01-01 at 10.00.00 (2).cap"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_project_path_fits_a_long_source_name_in_a_folder_name() {
        let dir = temp_dir("long-name");
        let name = format!("{} 2026-01-01 at 10.00.00", "a".repeat(236));

        let first = unique_project_path(&dir, &name).unwrap();
        std::fs::create_dir_all(&first).unwrap();
        let second = unique_project_path(&dir, &name).unwrap();
        std::fs::create_dir_all(&second).unwrap();

        for path in [&first, &second] {
            let folder = path.file_name().unwrap().to_str().unwrap();
            assert!(folder.len() <= 255, "{} bytes", folder.len());
            assert!(folder.starts_with("aaaa"), "{folder}");
        }
        assert!(first.to_str().unwrap().ends_with(".cap"));
        assert!(second.to_str().unwrap().ends_with(" (1).cap"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_project_path_cuts_long_names_on_a_character_boundary() {
        let dir = temp_dir("long-unicode");
        for stem in [
            "日本語".repeat(28),
            "🎬".repeat(63),
            "é".repeat(125),
            format!("{}.final.cut", "a".repeat(240)),
        ] {
            let name = sanitize_filename(&format!("{stem} 2026-01-01 at 10.00.00"));
            let first = unique_project_path(&dir, &name).unwrap();
            std::fs::create_dir_all(&first).unwrap();
            let second = unique_project_path(&dir, &name).unwrap();
            std::fs::create_dir_all(&second).unwrap();

            for path in [&first, &second] {
                let folder = path.file_name().unwrap().to_str().unwrap();
                assert!(folder.len() <= 255, "{} bytes", folder.len());
                assert!(folder.starts_with(&stem.chars().take(3).collect::<String>()));
                assert!(folder.ends_with(".cap"), "{folder}");
            }
            assert!(second.to_str().unwrap().ends_with(" (1).cap"));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unique_project_path_keeps_short_names_as_they_were() {
        let dir = temp_dir("short");
        for name in [
            "Video 2026-01-01 at 10.00.00",
            "clip.v2 2026-01-01 at 10.00.00",
            ".hidden 2026-01-01 at 10.00.00",
            "会议记录 2026-01-01 at 10.00.00",
        ] {
            assert_eq!(
                unique_project_path(&dir, name).unwrap(),
                dir.join(format!("{name}.cap"))
            );
        }
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

    fn limited_bt709() -> SourceColor {
        SourceColor::new(
            avformat::Pixel::YUV420P,
            ffmpeg::color::Space::BT709,
            ffmpeg::color::Range::MPEG,
            1080,
        )
    }

    fn yuv_frame(format: avformat::Pixel, [y, u, v]: [u8; 3]) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(format, 16, 12);
        frame.data_mut(0).fill(y);
        frame.data_mut(1).fill(u);
        frame.data_mut(2).fill(v);
        frame
    }

    /// The stored Y' sample at the centre of the first decoded frame, with
    /// no range conversion on the way.
    fn first_frame_center_luma(path: &Path) -> u8 {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                if decoder.receive_frame(&mut frame).is_ok() {
                    break;
                }
            }
        }
        if frame.width() == 0 {
            decoder.send_eof().unwrap();
            decoder.receive_frame(&mut frame).unwrap();
        }
        let (x, y) = (frame.width() as usize / 2, frame.height() as usize / 2);
        frame.data(0)[y * frame.stride(0) + x]
    }

    fn first_sample(frame: &ffmpeg::frame::Video) -> [u8; 3] {
        [frame.data(0)[0], frame.data(1)[0], frame.data(2)[0]]
    }

    #[test]
    fn source_matrix_follows_the_tag_and_the_sd_hd_convention() {
        let matrix = |format, space, height| {
            SourceColor::new(format, space, ffmpeg::color::Range::Unspecified, height).output()
        };
        use ffmpeg::color::Space;
        let yuv = avformat::Pixel::YUV420P;
        assert_eq!(matrix(yuv, Space::BT709, 480), ImportMatrix::Bt709);
        assert_eq!(matrix(yuv, Space::SMPTE170M, 1080), ImportMatrix::Bt601);
        assert_eq!(matrix(yuv, Space::BT470BG, 1080), ImportMatrix::Bt601);
        assert_eq!(matrix(yuv, Space::Unspecified, 1080), ImportMatrix::Bt709);
        assert_eq!(matrix(yuv, Space::Unspecified, 720), ImportMatrix::Bt709);
        assert_eq!(matrix(yuv, Space::Unspecified, 480), ImportMatrix::Bt601);
        assert_eq!(matrix(yuv, Space::BT2020NCL, 2160), ImportMatrix::Bt709);
        assert_eq!(
            matrix(avformat::Pixel::RGBA, Space::SMPTE170M, 480),
            ImportMatrix::Bt709
        );
    }

    #[test]
    fn full_range_sources_are_detected_from_tag_or_pixel_format() {
        let full_range = |format, range| {
            SourceColor::new(format, ffmpeg::color::Space::BT709, range, 1080).full_range
        };
        use ffmpeg::color::Range;
        assert!(!full_range(avformat::Pixel::YUV420P, Range::MPEG));
        assert!(!full_range(avformat::Pixel::YUV420P, Range::Unspecified));
        assert!(full_range(avformat::Pixel::YUV420P, Range::JPEG));
        assert!(full_range(avformat::Pixel::YUVJ420P, Range::Unspecified));
        assert!(full_range(avformat::Pixel::RGB24, Range::Unspecified));
    }

    #[test]
    fn full_range_frames_are_scaled_to_limited_range() {
        let color = SourceColor::new(
            avformat::Pixel::YUV420P,
            ffmpeg::color::Space::BT709,
            ffmpeg::color::Range::JPEG,
            12,
        );
        for (source, expected) in [([255, 128, 128], 235), ([0, 128, 128], 16)] {
            let mut frame = yuv_frame(avformat::Pixel::YUV420P, source);
            frame.set_color_range(ffmpeg::color::Range::JPEG);
            let mut scaler = None;
            let converted =
                convert_for_encode(&frame, &mut scaler, avformat::Pixel::YUV420P, 16, 12, color)
                    .unwrap();
            assert!(scaler.is_some(), "a full-range frame skipped the scaler");
            let [y, u, v] = first_sample(&converted);
            assert!(y.abs_diff(expected) <= 1, "Y {y} for {source:?}");
            assert!(
                u.abs_diff(128) <= 1 && v.abs_diff(128) <= 1,
                "chroma {u} {v}"
            );
        }
    }

    #[test]
    fn ten_bit_full_range_frames_are_scaled_to_limited_range() {
        let color = SourceColor::new(
            avformat::Pixel::YUV420P10LE,
            ffmpeg::color::Space::BT709,
            ffmpeg::color::Range::JPEG,
            12,
        );
        for (luma, expected) in [(1023u16, 235u8), (0, 16)] {
            let mut frame = ffmpeg::frame::Video::new(avformat::Pixel::YUV420P10LE, 16, 12);
            for (plane, value) in [(0, luma), (1, 512), (2, 512)] {
                for sample in frame.data_mut(plane).chunks_mut(2) {
                    sample.copy_from_slice(&value.to_le_bytes());
                }
            }
            frame.set_color_range(ffmpeg::color::Range::JPEG);
            let mut scaler = None;
            let converted =
                convert_for_encode(&frame, &mut scaler, avformat::Pixel::YUV420P, 16, 12, color)
                    .unwrap();
            let [y, u, v] = first_sample(&converted);
            assert!(y.abs_diff(expected) <= 1, "Y {y} for 10-bit {luma}");
            assert!(
                u.abs_diff(128) <= 1 && v.abs_diff(128) <= 1,
                "chroma {u} {v}"
            );
        }
    }

    #[test]
    fn a_range_change_mid_stream_rebuilds_the_scaler() {
        // Resized (anamorphic) frames always go through the scaler; a frame
        // that flips to full range must not abort the import.
        let color = limited_bt709();
        let mut scaler = None;
        let limited = yuv_frame(avformat::Pixel::YUV420P, [235, 128, 128]);
        let converted = convert_for_encode(
            &limited,
            &mut scaler,
            avformat::Pixel::YUV420P,
            20,
            12,
            color,
        )
        .unwrap();
        assert!(first_sample(&converted)[0].abs_diff(235) <= 1);

        let mut full = yuv_frame(avformat::Pixel::YUV420P, [255, 128, 128]);
        full.set_color_range(ffmpeg::color::Range::JPEG);
        let converted =
            convert_for_encode(&full, &mut scaler, avformat::Pixel::YUV420P, 20, 12, color)
                .unwrap();
        assert!(first_sample(&converted)[0].abs_diff(235) <= 1);

        let converted = convert_for_encode(
            &limited,
            &mut scaler,
            avformat::Pixel::YUV420P,
            20,
            12,
            color,
        )
        .unwrap();
        assert!(first_sample(&converted)[0].abs_diff(235) <= 1);
    }

    #[test]
    fn limited_range_bt601_frames_keep_their_samples() {
        let color = SourceColor::new(
            avformat::Pixel::YUV420P,
            ffmpeg::color::Space::SMPTE170M,
            ffmpeg::color::Range::MPEG,
            12,
        );
        let frame = yuv_frame(avformat::Pixel::YUV420P, [81, 90, 240]);
        let mut scaler = None;
        let converted =
            convert_for_encode(&frame, &mut scaler, avformat::Pixel::NV12, 16, 12, color).unwrap();
        assert_eq!(converted.data(0)[0], 81);
        assert_eq!(&converted.data(1)[..2], &[90, 240]);
    }

    #[test]
    fn rgb_frames_are_encoded_with_the_bt709_matrix_they_are_tagged_with() {
        let mut red = ffmpeg::frame::Video::new(avformat::Pixel::RGBA, 16, 12);
        let stride = red.stride(0);
        for row in red.data_mut(0).chunks_mut(stride) {
            for pixel in row[..16 * 4].chunks_mut(4) {
                pixel.copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        let color = SourceColor::new(
            avformat::Pixel::RGBA,
            ffmpeg::color::Space::Unspecified,
            ffmpeg::color::Range::Unspecified,
            12,
        );
        assert_eq!(color.output(), ImportMatrix::Bt709);
        let mut scaler = None;
        let converted =
            convert_for_encode(&red, &mut scaler, avformat::Pixel::YUV420P, 16, 12, color).unwrap();
        // BT.709 limited-range red is (63, 102, 240); BT.601 would give Y 81.
        let [y, u, v] = first_sample(&converted);
        assert!(y.abs_diff(63) <= 1, "Y {y}");
        assert!(u.abs_diff(102) <= 1, "Cb {u}");
        assert!(v.abs_diff(240) <= 1, "Cr {v}");
    }

    #[test]
    fn bt601_tagged_video_imports_tagged_bt601_with_its_samples_intact() {
        ffmpeg::init().unwrap();
        let root = temp_dir("bt601-source");
        let source = root.join("source.mp4");
        let mut output = avformat::output(&source).unwrap();
        let mut encoder = open_h264_encoder(
            &mut output,
            320,
            240,
            10,
            (1, 10).into(),
            ImportMatrix::Bt601,
        )
        .unwrap();
        output.write_header().unwrap();
        for index in 0..10u64 {
            let mut frame = ffmpeg::frame::Video::new(encoder.pixel_format, 320, 240);
            frame.data_mut(0).fill(81);
            if encoder.pixel_format == avformat::Pixel::NV12 {
                for pair in frame.data_mut(1).chunks_mut(2) {
                    pair.copy_from_slice(&[90, 240]);
                }
            } else {
                frame.data_mut(1).fill(90);
                frame.data_mut(2).fill(240);
            }
            encoder
                .queue_frame(frame, Duration::from_millis(index * 100), &mut output)
                .unwrap();
        }
        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
        drop(output);
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();

        let imported = root.join("display.mp4");
        transcode_video(&source, &imported, None, &root, &|_| {}, None).unwrap();

        let input = avformat::input(&imported).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        assert_eq!(decoder.color_space(), ffmpeg::color::Space::SMPTE170M);
        drop(input);

        let center = first_frame_center_luma(&imported);
        assert!(center.abs_diff(81) <= 2, "luma {center}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matching_import_frame_reuses_reference_counted_pixels() {
        let mut original = ffmpeg::frame::Video::new(avformat::Pixel::YUV420P, 16, 12);
        original.set_pts(Some(417));
        original.data_mut(0)[0] = 81;
        let mut scaler = None;

        let converted = convert_for_encode(
            &original,
            &mut scaler,
            avformat::Pixel::YUV420P,
            16,
            12,
            limited_bt709(),
        )
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

        let converted = convert_for_encode(
            &original,
            &mut scaler,
            avformat::Pixel::YUV420P,
            16,
            12,
            SourceColor::new(
                avformat::Pixel::RGBA,
                ffmpeg::color::Space::Unspecified,
                ffmpeg::color::Range::Unspecified,
                12,
            ),
        )
        .expect("converted import frame");

        assert!(scaler.is_some());
        assert_eq!(converted.format(), avformat::Pixel::YUV420P);
        assert_eq!(converted.width(), 16);
        assert_eq!(converted.height(), 12);
        assert_eq!(converted.pts(), Some(819));
        assert_ne!(converted.data(0).as_ptr(), original.data(0).as_ptr());
    }

    fn count_video_packets(path: &Path) -> usize {
        let mut input = avformat::input(path).unwrap();
        let index = input
            .streams()
            .best(ffmpeg::media::Type::Video)
            .unwrap()
            .index();
        input
            .packets()
            .filter(|(stream, _)| stream.index() == index)
            .count()
    }

    fn decoded_video_frames(path: &Path) -> usize {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        let mut frames = 0;
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                while decoder.receive_frame(&mut frame).is_ok() {
                    frames += 1;
                }
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut frame).is_ok() {
            frames += 1;
        }
        frames
    }

    fn decoded_audio_seconds(path: &Path) -> f64 {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Audio).unwrap();
        let index = stream.index();
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .audio()
            .unwrap();
        let mut frame = ffmpeg::frame::Audio::empty();
        let mut samples = 0;
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                while decoder.receive_frame(&mut frame).is_ok() {
                    samples += frame.samples();
                }
            }
        }
        decoder.send_eof().unwrap();
        while decoder.receive_frame(&mut frame).is_ok() {
            samples += frame.samples();
        }
        samples as f64 / f64::from(decoder.rate())
    }

    #[test]
    fn a_completed_conversion_keeps_every_source_frame_and_the_audio() {
        ffmpeg::init().unwrap();
        let root = temp_dir("complete-conversion");
        let source = root.join("source.mp4");
        std::fs::write(
            &source,
            include_bytes!("../../media-server/src/__tests__/fixtures/test-with-audio.mp4"),
        )
        .unwrap();
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        let audio = root.join("audio.ogg");

        let (fps, sample_rate) =
            transcode_video(&source, &output, Some(&audio), &root, &|_| {}, None).unwrap();

        assert_eq!(fps, 25);
        assert!(sample_rate.is_some());
        assert_eq!(count_video_packets(&source), 25);
        assert_eq!(count_video_packets(&output), 25);
        assert_eq!(decoded_video_frames(&output), 25);
        let duration = media_duration(&output).unwrap().as_secs_f64();
        assert!((duration - 1.0).abs() < 0.01, "{duration}");
        let audio_seconds = decoded_audio_seconds(&audio);
        assert!((0.9..=1.1).contains(&audio_seconds), "{audio_seconds}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn display_matrix_angles_map_to_the_clockwise_turn_ffmpeg_applies() {
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(-90.0),
            SourceRotation::Clockwise90
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(90.0),
            SourceRotation::Clockwise270
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(180.0),
            SourceRotation::Clockwise180
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(-180.0),
            SourceRotation::Clockwise180
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(-0.0),
            SourceRotation::None
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(45.0),
            SourceRotation::None
        );
        assert_eq!(
            SourceRotation::from_counterclockwise_degrees(f64::NAN),
            SourceRotation::None
        );
    }

    #[test]
    fn anamorphic_sources_resample_to_square_pixels() {
        let unset = ffmpeg::Rational::new(0, 1);
        assert_eq!(
            square_pixel_size(1440, 1080, [ffmpeg::Rational::new(4, 3), unset]),
            (1920, 1080)
        );
        assert_eq!(
            square_pixel_size(720, 720, [unset, ffmpeg::Rational::new(9, 16)]),
            (404, 720)
        );
        assert_eq!(square_pixel_size(1920, 1080, [unset, unset]), (1920, 1080));
        assert_eq!(
            square_pixel_size(1920, 1080, [ffmpeg::Rational::new(1, 1), unset]),
            (1920, 1080)
        );
        assert_eq!(
            square_pixel_size(1920, 1080, [ffmpeg::Rational::new(100, 1), unset]),
            (1920, 1080)
        );
    }

    /// Encodes a clip whose top-left quadrant is bright and everything else
    /// dark, tagged with the display matrix and sample aspect ratio a phone or
    /// editing app would write. The angle is the counterclockwise rotation
    /// ffprobe reports (-90 for an iPhone portrait clip); `av_display_rotation_set`
    /// takes the clockwise angle.
    fn write_tagged_source(
        path: &Path,
        width: u32,
        height: u32,
        counterclockwise_degrees: Option<f64>,
        sample_aspect: Option<(i32, i32)>,
    ) {
        let mut output = avformat::output(path).unwrap();
        let mut encoder = open_h264_encoder(
            &mut output,
            width,
            height,
            10,
            (1, 10).into(),
            ImportMatrix::Bt709,
        )
        .unwrap();
        unsafe {
            let stream = (*output.as_mut_ptr())
                .streams
                .add(encoder.stream_index)
                .read();
            let parameters = (*stream).codecpar;
            if let Some(degrees) = counterclockwise_degrees {
                let side_data = ffmpeg::ffi::av_packet_side_data_new(
                    &mut (*parameters).coded_side_data,
                    &mut (*parameters).nb_coded_side_data,
                    ffmpeg::ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
                    9 * std::mem::size_of::<i32>(),
                    0,
                );
                assert!(!side_data.is_null());
                ffmpeg::ffi::av_display_rotation_set((*side_data).data.cast::<i32>(), -degrees);
            }
            if let Some((num, den)) = sample_aspect {
                let ratio = ffmpeg::ffi::AVRational { num, den };
                (*parameters).sample_aspect_ratio = ratio;
                (*stream).sample_aspect_ratio = ratio;
            }
        }
        output.write_header().unwrap();
        for index in 0..10u64 {
            let mut frame = ffmpeg::frame::Video::new(encoder.pixel_format, width, height);
            let luma_stride = frame.stride(0);
            let luma = frame.data_mut(0);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    let bright = x < width as usize / 2 && y < height as usize / 2;
                    luma[y * luma_stride + x] = if bright { 235 } else { 16 };
                }
            }
            for plane in 1..frame.planes() {
                frame.data_mut(plane).fill(128);
            }
            encoder
                .queue_frame(frame, Duration::from_millis(index * 100), &mut output)
                .unwrap();
        }
        encoder.flush(&mut output).unwrap();
        output.write_trailer().unwrap();
    }

    fn first_frame_luma(path: &Path) -> (u32, u32, Vec<u8>) {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in input.packets() {
            if stream.index() != index {
                continue;
            }
            decoder.send_packet(&packet).unwrap();
            if decoder.receive_frame(&mut frame).is_ok() {
                break;
            }
        }
        if frame.width() == 0 {
            decoder.send_eof().unwrap();
            decoder.receive_frame(&mut frame).unwrap();
        }
        let mut gray = ffmpeg::frame::Video::empty();
        ffmpeg::software::scaling::Context::get(
            frame.format(),
            frame.width(),
            frame.height(),
            avformat::Pixel::GRAY8,
            frame.width(),
            frame.height(),
            ffmpeg::software::scaling::Flags::POINT,
        )
        .unwrap()
        .run(&frame, &mut gray)
        .unwrap();
        let (width, height, stride) = (gray.width(), gray.height(), gray.stride(0));
        let luma = (0..height as usize)
            .flat_map(|y| gray.data(0)[y * stride..y * stride + width as usize].to_vec())
            .collect();
        (width, height, luma)
    }

    /// Whether each quadrant is bright, in top-left, top-right, bottom-left,
    /// bottom-right order.
    fn quadrant_brightness(width: u32, height: u32, luma: &[u8]) -> [bool; 4] {
        let (width, height) = (width as usize, height as usize);
        let mut sums = [0u64; 4];
        let mut counts = [0u64; 4];
        for y in 0..height {
            for x in 0..width {
                let quadrant = usize::from(x >= width / 2) + 2 * usize::from(y >= height / 2);
                sums[quadrant] += u64::from(luma[y * width + x]);
                counts[quadrant] += 1;
            }
        }
        std::array::from_fn(|quadrant| sums[quadrant] / counts[quadrant].max(1) > 128)
    }

    fn import_tagged_source(
        tag: &str,
        width: u32,
        height: u32,
        counterclockwise_degrees: Option<f64>,
        sample_aspect: Option<(i32, i32)>,
    ) -> (u32, u32, [bool; 4]) {
        ffmpeg::init().unwrap();
        let root = temp_dir(tag);
        let source = root.join("source.mp4");
        write_tagged_source(
            &source,
            width,
            height,
            counterclockwise_degrees,
            sample_aspect,
        );
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        transcode_video(&source, &output, None, &root, &|_| {}, None).unwrap();
        let (out_width, out_height, luma) = first_frame_luma(&output);
        std::fs::remove_dir_all(root).unwrap();
        (
            out_width,
            out_height,
            quadrant_brightness(out_width, out_height, &luma),
        )
    }

    #[test]
    fn untagged_sources_import_unchanged() {
        assert_eq!(
            import_tagged_source("untagged", 320, 240, None, None),
            (320, 240, [true, false, false, false])
        );
    }

    #[test]
    fn iphone_portrait_video_imports_upright_and_portrait() {
        assert_eq!(
            import_tagged_source("rotate-cw", 320, 240, Some(-90.0), None),
            (240, 320, [false, true, false, false])
        );
    }

    #[test]
    fn counterclockwise_and_upside_down_sources_import_upright() {
        assert_eq!(
            import_tagged_source("rotate-ccw", 320, 240, Some(90.0), None),
            (240, 320, [false, false, true, false])
        );
        assert_eq!(
            import_tagged_source("rotate-180", 320, 240, Some(180.0), None),
            (320, 240, [false, false, false, true])
        );
    }

    #[test]
    fn anamorphic_video_imports_at_its_display_shape() {
        assert_eq!(
            import_tagged_source("anamorphic", 160, 240, None, Some((2, 1))),
            (320, 240, [true, false, false, false])
        );
        assert_eq!(
            import_tagged_source("anamorphic-rotated", 160, 240, Some(-90.0), Some((2, 1))),
            (240, 320, [false, true, false, false])
        );
    }

    const ALL_TURNS: [SourceRotation; 3] = [
        SourceRotation::Clockwise90,
        SourceRotation::Clockwise180,
        SourceRotation::Clockwise270,
    ];

    /// The source position whose sample lands at (x, y) of a plane turned
    /// clockwise, written from the output side so it does not mirror
    /// `rotate_samples`.
    fn source_position(
        rotation: SourceRotation,
        source_width: usize,
        source_height: usize,
        x: usize,
        y: usize,
    ) -> (usize, usize) {
        match rotation {
            SourceRotation::None => (x, y),
            SourceRotation::Clockwise90 => (y, source_height - 1 - x),
            SourceRotation::Clockwise180 => (source_width - 1 - x, source_height - 1 - y),
            SourceRotation::Clockwise270 => (source_width - 1 - y, x),
        }
    }

    /// Every sample in every plane gets its own value, and U never equals V,
    /// so a misplaced, swapped or split chroma sample changes the result.
    fn distinct_sample(plane: usize, channel: usize, x: usize, y: usize) -> u8 {
        let base = [0, 64, 160][plane + channel];
        (base + y * 8 + x) as u8
    }

    /// 8x6 luma with 4x3 chroma: small enough that every sample value above
    /// stays distinct within its plane.
    fn distinct_frame(format: avformat::Pixel) -> ffmpeg::frame::Video {
        let mut frame = ffmpeg::frame::Video::new(format, 8, 6);
        frame.set_pts(Some(42));
        for plane in 0..frame.planes() {
            let channels = if format == avformat::Pixel::NV12 && plane == 1 {
                2
            } else {
                1
            };
            let (width, height) = (frame.plane_width(plane), frame.plane_height(plane));
            let stride = frame.stride(plane);
            let data = frame.data_mut(plane);
            for y in 0..height as usize {
                for x in 0..width as usize {
                    for channel in 0..channels {
                        data[y * stride + x * channels + channel] =
                            distinct_sample(plane, channel, x, y);
                    }
                }
            }
        }
        frame
    }

    /// (plane, channel) for U and V in each supported layout.
    fn chroma_channels(format: avformat::Pixel) -> [(usize, usize); 2] {
        if format == avformat::Pixel::NV12 {
            [(1, 0), (1, 1)]
        } else {
            [(1, 0), (2, 0)]
        }
    }

    fn assert_turned_exactly(format: avformat::Pixel, rotation: SourceRotation) {
        let rotated = rotation.apply(distinct_frame(format)).unwrap();
        let (expected_width, expected_height) = rotation.rotated_size(8, 6);
        assert_eq!(
            (rotated.format(), rotated.width(), rotated.height()),
            (format, expected_width, expected_height),
            "{format:?} {rotation:?}"
        );
        assert_eq!(rotated.pts(), Some(42), "{format:?} {rotation:?}");

        let chroma_samples = if format == avformat::Pixel::NV12 {
            2
        } else {
            1
        };
        let [(u_plane, u_channel), (v_plane, v_channel)] = chroma_channels(format);
        for (plane, channel, channels, source_width, source_height) in [
            (0, 0, 1, 8, 6),
            (u_plane, u_channel, chroma_samples, 4, 3),
            (v_plane, v_channel, chroma_samples, 4, 3),
        ] {
            let (width, height) = rotation.rotated_size(source_width as u32, source_height as u32);
            assert_eq!(
                (rotated.plane_width(plane), rotated.plane_height(plane)),
                (width, height),
                "{format:?} {rotation:?} plane {plane}"
            );
            let (width, height) = (width as usize, height as usize);
            let stride = rotated.stride(plane);
            for y in 0..height {
                for x in 0..width {
                    let (source_x, source_y) =
                        source_position(rotation, source_width, source_height, x, y);
                    assert_eq!(
                        rotated.data(plane)[y * stride + x * channels + channel],
                        distinct_sample(plane, channel, source_x, source_y),
                        "{format:?} {rotation:?} plane {plane} channel {channel} at ({x}, {y})"
                    );
                }
            }
        }
    }

    #[test]
    fn planar_chroma_lands_where_each_turn_puts_it() {
        for rotation in ALL_TURNS {
            assert_turned_exactly(avformat::Pixel::YUV420P, rotation);
        }
    }

    #[test]
    fn interleaved_nv12_chroma_pairs_turn_together_in_order() {
        for rotation in ALL_TURNS {
            assert_turned_exactly(avformat::Pixel::NV12, rotation);
        }
    }

    #[test]
    fn turned_chroma_corners_match_hand_worked_positions() {
        // Source chroma is 4x3. A clockwise quarter turn moves the source's
        // bottom-left sample to the top-left, so U there is distinct_sample
        // at (0, 2); a counterclockwise one moves the top-right there.
        for format in [avformat::Pixel::YUV420P, avformat::Pixel::NV12] {
            let [(u_plane, u_channel), (v_plane, v_channel)] = chroma_channels(format);
            for (rotation, (source_x, source_y)) in [
                (SourceRotation::Clockwise90, (0, 2)),
                (SourceRotation::Clockwise180, (3, 2)),
                (SourceRotation::Clockwise270, (3, 0)),
            ] {
                let rotated = rotation.apply(distinct_frame(format)).unwrap();
                assert_eq!(
                    (
                        rotated.data(u_plane)[u_channel],
                        rotated.data(v_plane)[v_channel],
                    ),
                    (
                        distinct_sample(1, 0, source_x, source_y),
                        distinct_sample(1, 1, source_x, source_y),
                    ),
                    "{format:?} {rotation:?}"
                );
            }
        }
    }

    #[derive(Clone, Copy)]
    struct X264Source {
        width: u32,
        height: u32,
        fps: i32,
        frames: i64,
        pixel: avformat::Pixel,
        keyframe_interval: u32,
        b_frames: usize,
        range: ffmpeg::color::Range,
        space: ffmpeg::color::Space,
        counterclockwise_degrees: Option<f64>,
        sample_aspect: Option<(i32, i32)>,
    }

    impl X264Source {
        fn new(pixel: avformat::Pixel) -> Self {
            Self {
                width: 320,
                height: 240,
                fps: 30,
                frames: 45,
                pixel,
                keyframe_interval: 30,
                b_frames: 0,
                range: ffmpeg::color::Range::Unspecified,
                space: ffmpeg::color::Space::Unspecified,
                counterclockwise_degrees: None,
                sample_aspect: None,
            }
        }

        /// Returns false when this FFmpeg build has no libx264.
        fn write(self, path: &Path) -> bool {
            let Some(codec) = ffmpeg::codec::encoder::find_by_name("libx264") else {
                return false;
            };
            let mut output = avformat::output(path).unwrap();
            let mut encoder = avcodec::Context::new_with_codec(codec)
                .encoder()
                .video()
                .unwrap();
            encoder.set_width(self.width);
            encoder.set_height(self.height);
            encoder.set_format(self.pixel);
            encoder.set_time_base((1, self.fps));
            encoder.set_frame_rate(Some((self.fps, 1)));
            encoder.set_gop(self.keyframe_interval);
            encoder.set_max_b_frames(self.b_frames);
            encoder.set_color_range(self.range);
            encoder.set_colorspace(self.space);
            if output
                .format()
                .flags()
                .contains(avformat::Flags::GLOBAL_HEADER)
            {
                encoder.set_flags(ffmpeg::codec::Flags::GLOBAL_HEADER);
            }
            let mut options = ffmpeg::Dictionary::new();
            options.set("preset", "veryfast");
            options.set(
                "x264-params",
                &format!(
                    "keyint={0}:min-keyint={0}:scenecut=0:bframes={1}",
                    self.keyframe_interval, self.b_frames
                ),
            );
            let mut encoder = encoder.open_as_with(codec, options).unwrap();
            let stream_index = {
                let mut stream = output.add_stream(codec).unwrap();
                stream.set_time_base((1, self.fps));
                stream.set_parameters(&encoder);
                unsafe {
                    let parameters = (*stream.as_mut_ptr()).codecpar;
                    if let Some(degrees) = self.counterclockwise_degrees {
                        let side_data = ffmpeg::ffi::av_packet_side_data_new(
                            &mut (*parameters).coded_side_data,
                            &mut (*parameters).nb_coded_side_data,
                            ffmpeg::ffi::AVPacketSideDataType::AV_PKT_DATA_DISPLAYMATRIX,
                            9 * std::mem::size_of::<i32>(),
                            0,
                        );
                        assert!(!side_data.is_null());
                        ffmpeg::ffi::av_display_rotation_set(
                            (*side_data).data.cast::<i32>(),
                            -degrees,
                        );
                    }
                    if let Some((num, den)) = self.sample_aspect {
                        let ratio = ffmpeg::ffi::AVRational { num, den };
                        (*parameters).sample_aspect_ratio = ratio;
                        (*stream.as_mut_ptr()).sample_aspect_ratio = ratio;
                    }
                }
                stream.index()
            };
            output.write_header().unwrap();
            let stream_time_base = output.stream(stream_index).unwrap().time_base();
            let mut packet = ffmpeg::Packet::empty();
            let mut drain = |encoder: &mut ffmpeg::encoder::Video,
                             output: &mut avformat::context::Output| {
                while encoder.receive_packet(&mut packet).is_ok() {
                    packet.set_stream(stream_index);
                    packet.set_duration(1);
                    packet.rescale_ts((1, self.fps), stream_time_base);
                    packet.write_interleaved(output).unwrap();
                }
            };
            for index in 0..self.frames {
                let mut frame = ffmpeg::frame::Video::new(self.pixel, self.width, self.height);
                for plane in 0..frame.planes() {
                    let (width, height) = (
                        frame.plane_width(plane) as usize,
                        frame.plane_height(plane) as usize,
                    );
                    let stride = frame.stride(plane);
                    let data = frame.data_mut(plane);
                    for y in 0..height {
                        for x in 0..width {
                            let band = (x * 8 / width.max(1) + index as usize) % 8;
                            data[y * stride + x] = match plane {
                                0 => 40 + (band as u8) * 24 + (y % 7) as u8,
                                1 => 60 + ((band * 37) % 120) as u8,
                                _ => 200 - ((band * 53) % 140) as u8,
                            };
                        }
                    }
                }
                frame.set_pts(Some(index));
                encoder.send_frame(&frame).unwrap();
                drain(&mut encoder, &mut output);
            }
            encoder.send_eof().unwrap();
            drain(&mut encoder, &mut output);
            output.write_trailer().unwrap();
            true
        }
    }

    fn video_packets(path: &Path) -> Vec<(Vec<u8>, f64, bool)> {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let (index, time_base) = (stream.index(), stream.time_base());
        input
            .packets()
            .filter(|(stream, _)| stream.index() == index)
            .map(|(_, packet)| {
                (
                    packet.data().unwrap_or_default().to_vec(),
                    packet.pts().unwrap() as f64 * f64::from(time_base),
                    packet.is_key(),
                )
            })
            .collect()
    }

    fn decoded_frame_seconds(path: &Path) -> Vec<f64> {
        let mut input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let (index, time_base) = (stream.index(), stream.time_base());
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        let mut seconds = Vec::new();
        let mut collect = |decoder: &mut ffmpeg::decoder::Video| {
            while decoder.receive_frame(&mut frame).is_ok() {
                let pts = frame.timestamp().or(frame.pts()).unwrap();
                seconds.push(pts as f64 * f64::from(time_base));
            }
        };
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                collect(&mut decoder);
            }
        }
        decoder.send_eof().unwrap();
        collect(&mut decoder);
        seconds
    }

    /// The tag a reader sees without probing frames, as the native decoder
    /// paths do.
    fn header_color_space(path: &Path) -> ffmpeg::color::Space {
        let path = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        let mut context = std::ptr::null_mut();
        let status = unsafe {
            ffmpeg::ffi::avformat_open_input(
                &mut context,
                path.as_ptr(),
                std::ptr::null(),
                std::ptr::null_mut(),
            )
        };
        assert!(status >= 0);
        let input = unsafe { avformat::context::Input::wrap(context) };
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        ffmpeg::color::Space::from(unsafe { (*stream.parameters().as_ptr()).color_space })
    }

    fn stream_tags(path: &Path) -> (avformat::Pixel, ffmpeg::color::Space, ffmpeg::color::Range) {
        let input = avformat::input(path).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        (
            decoder.format(),
            decoder.color_space(),
            decoder.color_range(),
        )
    }

    fn import_x264_source(tag: &str, source: X264Source) -> Option<(PathBuf, PathBuf, PathBuf)> {
        ffmpeg::init().unwrap();
        let root = temp_dir(tag);
        let source_path = root.join("source.mp4");
        if !source.write(&source_path) {
            std::fs::remove_dir_all(root).unwrap();
            return None;
        }
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        import_video(&source_path, &output, None, &root, &|_| {}, None).unwrap();
        Some((root, source_path, output))
    }

    fn assert_display_is_the_reencode(display: &Path) {
        let (format, _, range) = stream_tags(display);
        assert!(
            matches!(format, avformat::Pixel::YUV420P | avformat::Pixel::NV12),
            "{format:?}"
        );
        assert_eq!(range, ffmpeg::color::Range::MPEG);
    }

    fn keep_reason(source: &Path) -> Option<&'static str> {
        let root = source.parent().unwrap();
        match plan_keep(source, root, None) {
            Ok(_) => None,
            Err(KeepError::Ineligible(reason)) => Some(reason),
            Err(error) => panic!("scan failed: {error:?}"),
        }
    }

    #[test]
    fn a_444_import_keeps_every_source_packet_and_its_timing() {
        let Some((root, source, output)) = import_x264_source(
            "keep-444",
            X264Source {
                b_frames: 2,
                ..X264Source::new(avformat::Pixel::YUV444P)
            },
        ) else {
            return;
        };
        assert_display_is_the_reencode(&output);
        let kept = cap_rendering::source_video_path(&output);
        let (source_packets, kept_packets) = (video_packets(&source), video_packets(&kept));
        assert_eq!(kept_packets.len(), 45);
        assert_eq!(
            source_packets
                .iter()
                .map(|(data, _, key)| (data, key))
                .collect::<Vec<_>>(),
            kept_packets
                .iter()
                .map(|(data, _, key)| (data, key))
                .collect::<Vec<_>>()
        );
        let source_times = decoded_frame_seconds(&source);
        let kept_times = decoded_frame_seconds(&kept);
        assert_eq!(kept_times.len(), 45);
        assert!(
            kept_times[0].abs() < 1e-9,
            "first frame at {}",
            kept_times[0]
        );
        for (kept, original) in kept_times.iter().zip(&source_times) {
            assert!(
                (kept - (original - source_times[0])).abs() < 1e-6,
                "{kept} vs {original}"
            );
        }
        assert_eq!(
            stream_tags(&kept),
            (
                avformat::Pixel::YUV444P,
                ffmpeg::color::Space::SMPTE170M,
                ffmpeg::color::Range::MPEG
            )
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn untagged_hd_is_kept_with_the_bt709_tag_a_reencode_writes() {
        let Some((root, source, output)) = import_x264_source(
            "keep-hd-untagged",
            X264Source {
                width: 1280,
                height: 720,
                frames: 4,
                ..X264Source::new(avformat::Pixel::YUV444P)
            },
        ) else {
            return;
        };
        assert_display_is_the_reencode(&output);
        assert_eq!(stream_tags(&output).1, ffmpeg::color::Space::BT709);
        let kept = cap_rendering::source_video_path(&output);
        assert_eq!(video_packets(&kept), video_packets(&source));
        assert_eq!(stream_tags(&kept).1, ffmpeg::color::Space::BT709);
        let headers_only = header_color_space(&kept);
        assert_eq!(headers_only, ffmpeg::color::Space::BT709);
        let mut input = avformat::input(&kept).unwrap();
        let stream = input.streams().best(ffmpeg::media::Type::Video).unwrap();
        let index = stream.index();
        let mut decoder = avcodec::Context::from_parameters(stream.parameters())
            .unwrap()
            .decoder()
            .video()
            .unwrap();
        let mut frame = ffmpeg::frame::Video::empty();
        for (stream, packet) in input.packets() {
            if stream.index() == index {
                decoder.send_packet(&packet).unwrap();
                if decoder.receive_frame(&mut frame).is_ok() {
                    break;
                }
            }
        }
        assert_eq!(frame.color_space(), ffmpeg::color::Space::BT709);
        drop(decoder);
        drop(input);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tagged_sources_keep_their_own_tags() {
        let Some((root, source, output)) = import_x264_source(
            "keep-tagged",
            X264Source {
                width: 1280,
                height: 720,
                frames: 4,
                space: ffmpeg::color::Space::SMPTE170M,
                range: ffmpeg::color::Range::MPEG,
                ..X264Source::new(avformat::Pixel::YUV444P)
            },
        ) else {
            return;
        };
        let kept = cap_rendering::source_video_path(&output);
        assert_eq!(video_packets(&kept), video_packets(&source));
        assert_eq!(stream_tags(&kept).1, ffmpeg::color::Space::SMPTE170M);
        assert_eq!(stream_tags(&output).1, ffmpeg::color::Space::SMPTE170M);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sources_the_editor_cannot_read_as_they_are_are_reencoded() {
        ffmpeg::init().unwrap();
        let cases = [
            ("pixel format", X264Source::new(avformat::Pixel::YUV420P)),
            ("pixel format", X264Source::new(avformat::Pixel::YUV422P)),
            (
                // x264 reports a full-range stream as yuvj420p.
                "pixel format",
                X264Source {
                    range: ffmpeg::color::Range::JPEG,
                    ..X264Source::new(avformat::Pixel::YUV420P)
                },
            ),
            (
                "keyframe interval",
                X264Source {
                    frames: 200,
                    keyframe_interval: 200,
                    ..X264Source::new(avformat::Pixel::YUV444P)
                },
            ),
            (
                "dimensions",
                X264Source {
                    width: 321,
                    ..X264Source::new(avformat::Pixel::YUV444P)
                },
            ),
        ];
        for (expected, source) in cases {
            let root = temp_dir("keep-reasons");
            let path = root.join("source.mp4");
            if !source.write(&path) {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            assert_eq!(keep_reason(&path), Some(expected));
            std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
            let output = root.join("display.mp4");
            import_video(&path, &output, None, &root, &|_| {}, None).unwrap();
            let (format, _, range) = stream_tags(&output);
            assert!(
                matches!(format, avformat::Pixel::YUV420P | avformat::Pixel::NV12),
                "{expected}: {format:?}"
            );
            assert_eq!(range, ffmpeg::color::Range::MPEG, "{expected}");
            assert_eq!(decoded_video_frames(&output), source.frames as usize);
            assert!(!cap_rendering::source_video_path(&output).exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn turned_and_anamorphic_sources_are_reencoded_upright_and_square() {
        ffmpeg::init().unwrap();
        for (tag, degrees, aspect, reason, size) in [
            (
                "keep-turned",
                Some(-90.0),
                None,
                "display matrix",
                (240, 320),
            ),
            (
                "keep-anamorphic",
                None,
                Some((4, 3)),
                "sample aspect ratio",
                (426, 240),
            ),
        ] {
            let root = temp_dir(tag);
            let source = root.join("source.mp4");
            let written = X264Source {
                counterclockwise_degrees: degrees,
                sample_aspect: aspect,
                ..X264Source::new(avformat::Pixel::YUV444P)
            }
            .write(&source);
            if !written {
                std::fs::remove_dir_all(root).unwrap();
                return;
            }
            assert_eq!(keep_reason(&source), Some(reason));
            std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
            let output = root.join("display.mp4");
            import_video(&source, &output, None, &root, &|_| {}, None).unwrap();
            let (width, height, _) = first_frame_luma(&output);
            assert_eq!((width, height), size, "{tag}");
            assert!(!cap_rendering::source_video_path(&output).exists());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn editor_clip_imports_keep_the_source_video_too() {
        ffmpeg::init().unwrap();
        let root = temp_dir("keep-editor-clip");
        let source = root.join("source.mp4");
        if !X264Source::new(avformat::Pixel::YUV444P).write(&source) {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        let (fps, sample_rate) = transcode_editor_video(
            &source,
            &output,
            &root.join("audio.ogg"),
            &root,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!((fps, sample_rate), (30, None));
        assert_display_is_the_reencode(&output);
        let kept = cap_rendering::source_video_path(&output);
        assert_eq!(video_packets(&source), video_packets(&kept));
        assert_eq!(stream_tags(&kept).0, avformat::Pixel::YUV444P);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn mux_with_audio(video: &Path, audio: &Path, output_path: &Path) {
        let mut output = avformat::output(output_path).unwrap();
        let mut inputs = [
            avformat::input(video).unwrap(),
            avformat::input(audio).unwrap(),
        ];
        let mut mapping = Vec::new();
        for (source, input) in inputs.iter().enumerate() {
            let medium = if source == 0 {
                ffmpeg::media::Type::Video
            } else {
                ffmpeg::media::Type::Audio
            };
            let stream = input.streams().best(medium).unwrap();
            let mut copy = output
                .add_stream(ffmpeg::encoder::find(ffmpeg::codec::Id::None))
                .unwrap();
            copy.set_parameters(stream.parameters());
            unsafe { (*(*copy.as_mut_ptr()).codecpar).codec_tag = 0 };
            mapping.push((stream.index(), stream.time_base(), copy.index()));
        }
        output.write_header().unwrap();
        for (source, input) in inputs.iter_mut().enumerate() {
            let (index, time_base, target) = mapping[source];
            let target_base = output.stream(target).unwrap().time_base();
            for (stream, mut packet) in input.packets() {
                if stream.index() != index {
                    continue;
                }
                packet.set_stream(target);
                packet.set_position(-1isize);
                packet.rescale_ts(time_base, target_base);
                packet.write_interleaved(&mut output).unwrap();
            }
        }
        output.write_trailer().unwrap();
    }

    #[test]
    fn a_kept_import_still_converts_the_audio() {
        ffmpeg::init().unwrap();
        let root = temp_dir("keep-with-audio");
        let video = root.join("video.mp4");
        if !X264Source::new(avformat::Pixel::YUV444P).write(&video) {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        let audio_source = root.join("audio-source.mp4");
        std::fs::write(
            &audio_source,
            include_bytes!("../../media-server/src/__tests__/fixtures/test-with-audio.mp4"),
        )
        .unwrap();
        let source = root.join("source.mp4");
        mux_with_audio(&video, &audio_source, &source);
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let output = root.join("display.mp4");
        let audio = root.join("audio.ogg");
        assert_eq!(keep_reason(&source), None);
        let (fps, sample_rate) =
            import_video(&source, &output, Some(&audio), &root, &|_| {}, None).unwrap();
        assert_eq!(fps, 30);
        assert!(sample_rate.is_some());
        assert_display_is_the_reencode(&output);
        assert_eq!(
            video_packets(&source),
            video_packets(&cap_rendering::source_video_path(&output))
        );
        let audio_seconds = decoded_audio_seconds(&audio);
        assert!((0.9..=1.1).contains(&audio_seconds), "{audio_seconds}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_kept_import_can_be_cancelled() {
        ffmpeg::init().unwrap();
        let root = temp_dir("keep-cancel");
        let source = root.join("source.mp4");
        if !X264Source::new(avformat::Pixel::YUV444P).write(&source) {
            std::fs::remove_dir_all(root).unwrap();
            return;
        }
        std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
        let cancelled = AtomicBool::new(false);
        let output = root.join("display.mp4");
        let result = import_video(
            &source,
            &output,
            None,
            &root,
            &|_| cancelled.store(true, Ordering::Release),
            Some(&cancelled),
        );
        assert_eq!(result.unwrap_err(), IMPORT_CANCELLED);
        assert!(!cap_rendering::source_video_path(&output).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// `CAP_IMPORT_BENCH_SOURCES=a.mp4,b.mp4 cargo test --bin cap-gpui benchmark_video_import -- --ignored --nocapture`
    #[test]
    #[ignore = "benchmark: transcodes the videos named by CAP_IMPORT_BENCH_SOURCES"]
    fn benchmark_video_import() {
        ffmpeg::init().unwrap();
        let sources = std::env::var("CAP_IMPORT_BENCH_SOURCES")
            .expect("CAP_IMPORT_BENCH_SOURCES must list the videos to import");
        let runs = std::env::var("CAP_IMPORT_BENCH_RUNS")
            .ok()
            .and_then(|runs| runs.parse::<usize>().ok())
            .unwrap_or(3)
            .max(1);

        println!("| source | duration | median import | slowest | realtime |");
        println!("| --- | ---: | ---: | ---: | ---: |");
        for source in sources.split(',').map(PathBuf::from) {
            let duration = media_duration(&source)
                .expect("benchmark source has a duration")
                .as_secs_f64();
            let mut seconds = (0..runs)
                .map(|_| {
                    let root = temp_dir("bench");
                    std::fs::write(root.join("recording-meta.json"), b"{}").unwrap();
                    let started = std::time::Instant::now();
                    transcode_video(
                        &source,
                        &root.join("display.mp4"),
                        Some(&root.join("audio.ogg")),
                        &root,
                        &|_| {},
                        None,
                    )
                    .unwrap();
                    let elapsed = started.elapsed().as_secs_f64();
                    std::fs::remove_dir_all(root).unwrap();
                    elapsed
                })
                .collect::<Vec<_>>();
            seconds.sort_by(f64::total_cmp);
            let middle = seconds.len() / 2;
            let median = if seconds.len() % 2 == 0 {
                (seconds[middle - 1] + seconds[middle]) / 2.0
            } else {
                seconds[middle]
            };
            println!(
                "| {} | {duration:.1} s | {median:.2} s | {:.2} s | {:.2}x |",
                source.file_name().unwrap().to_string_lossy(),
                seconds[seconds.len() - 1],
                duration / median,
            );
        }
    }
}

pub(crate) struct ImportedEditorImage {
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn import_editor_image(
    project_path: &Path,
    source: &Path,
) -> Result<ImportedEditorImage, String> {
    use std::{
        hash::BuildHasher,
        io::{Read, Write},
    };
    const MAX_BYTES: u64 = 64 * 1024 * 1024;
    if !project_path.is_dir() || !has_supported_extension(source, OVERLAY_IMAGE_EXTENSIONS) {
        return Err("Choose a PNG, JPEG, WebP, GIF or BMP image for this project".into());
    }
    let file = std::fs::File::open(source).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err("Image files must be 64 MiB or smaller".into());
    }
    let mut encoded = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut encoded)
        .map_err(|error| error.to_string())?;
    if encoded.len() as u64 > MAX_BYTES {
        return Err("Image files must be 64 MiB or smaller".into());
    }
    let (extension, width, height) = cap_gpui_kernels::codec::inspect_overlay_image(&encoded)?;
    let mut bytes = [0u8; 16];
    for chunk in bytes.chunks_exact_mut(8) {
        chunk.copy_from_slice(
            &std::collections::hash_map::RandomState::new()
                .hash_one(source)
                .to_be_bytes(),
        );
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let relative = format!("content/images/{id}.{extension}");
    let destination = project_path.join(&relative);
    std::fs::create_dir_all(project_path.join("content/images"))
        .map_err(|error| error.to_string())?;
    let mut destination_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination)
        .map_err(|error| error.to_string())?;
    if let Err(error) = destination_file
        .write_all(&encoded)
        .and_then(|()| destination_file.sync_all())
    {
        drop(destination_file);
        let _ = std::fs::remove_file(&destination);
        return Err(format!("Failed to save image: {error}"));
    }
    Ok(ImportedEditorImage {
        path: relative,
        name: source
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Image")
            .to_string(),
        width,
        height,
    })
}

#[cfg(test)]
mod style_image_tests {
    use super::*;

    #[test]
    fn style_image_import_rotates_exif_copies_source_and_keeps_relative_unique_assets() {
        let dir = std::env::temp_dir().join(format!(
            "cap-overlay-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.jpg");
        image::RgbImage::from_pixel(3, 2, image::Rgb([255, 30, 20]))
            .save(&source)
            .unwrap();
        let original = std::fs::read(&source).unwrap();
        let exif = b"Exif\0\0MM\0*\0\0\0\x08\0\x01\x01\x12\0\x03\0\0\0\x01\0\x06\0\0\0\0\0\0";
        let mut oriented = original[..2].to_vec();
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&original[2..]);
        std::fs::write(&source, &oriented).unwrap();
        let first = import_editor_image(&dir, &source).unwrap();
        let second = import_editor_image(&dir, &source).unwrap();
        assert_ne!(first.path, second.path);
        assert!(first.path.starts_with("content/images/"));
        assert!(!Path::new(&first.path).is_absolute());
        assert_eq!((first.width, first.height), (2, 3));
        assert_eq!(
            image::image_dimensions(dir.join(&first.path)).unwrap(),
            (3, 2)
        );
        assert_eq!(std::fs::read(dir.join(&first.path)).unwrap(), oriented);
        assert_eq!(std::fs::read(&source).unwrap(), oriented);
        for extension in ["gif", "bmp"] {
            let source = dir.join(format!("source.{extension}"));
            image::RgbaImage::from_pixel(3, 2, image::Rgba([200, 50, 80, 255]))
                .save(&source)
                .unwrap();
            let imported = import_editor_image(&dir, &source).unwrap();
            assert_eq!((imported.width, imported.height), (3, 2));
            assert_eq!(
                std::fs::read(dir.join(imported.path)).unwrap(),
                std::fs::read(source).unwrap()
            );
        }
        let invalid = dir.join("invalid.png");
        std::fs::write(&invalid, b"not an image").unwrap();
        assert!(import_editor_image(&dir, &invalid).is_err());
        let large = dir.join("large.png");
        std::fs::File::create(&large)
            .unwrap()
            .set_len(64 * 1024 * 1024 + 1)
            .unwrap();
        assert!(
            import_editor_image(&dir, &large)
                .err()
                .unwrap()
                .contains("64 MiB")
        );
        assert_eq!(
            std::fs::read_dir(dir.join("content/images"))
                .unwrap()
                .count(),
            4
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
