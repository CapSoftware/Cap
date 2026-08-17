//! The recordings library -- the filesystem scan behind Recents.
//!
//! The Tauri main window's Recents is not backed by an index or a database. It
//! is two `std::fs::read_dir` walks (`list_recordings` and `list_screenshots`,
//! `apps/desktop/src-tauri/src/lib.rs:3974-4092`), each bundle's
//! `recording-meta.json` parsed through `RecordingMeta::load_for_project`,
//! sorted descending by `sort_time_millis` -- which is not stored data either
//! but the bundle directory's own `created()` (falling back to `modified()`),
//! recomputed on every call (`media_sort_time_millis`, `lib.rs:3955-3972`).
//! The `recentMedia` query (`new-main/index.tsx:2217-2263`) then takes the
//! first `RECENT_MEDIA_LIMIT` of each list, merges them, re-sorts by the same
//! key and re-slices.
//!
//! Thumbnails are pre-baked files inside the bundle, so nothing here decodes
//! video: a recording's card draws `<bundle>/screenshots/display.jpg` (written
//! once at recording finish, `recording.rs:3424-3429`), a screenshot's card
//! draws the bundle's own PNG. All of it is ordinary `std::fs` work, so it is
//! transcribed here rather than reached for through a Tauri command.
//!
//! Everything in this module is called from the background executor. Nothing
//! in it touches gpui state.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::UNIX_EPOCH,
};

use cap_project::{
    InstantRecordingMeta, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus,
};
use gpui::RenderImage;

/// `RECENT_MEDIA_LIMIT` in `new-main/index.tsx:129`.
pub const RECENT_MEDIA_LIMIT: usize = 9;

/// Which of the three card shapes `RecentCard` draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Studio,
    Instant,
    Screenshot,
}

impl MediaKind {
    /// `typeLabel()` in `Recents.tsx:116-119`.
    pub fn label(self) -> &'static str {
        match self {
            Self::Studio => "Studio Mode",
            Self::Instant => "Instant Mode",
            Self::Screenshot => "Screenshot",
        }
    }

    /// `TypeIcon()` in `Recents.tsx:120-128`, the `size-2.5` glyph in the pill.
    pub fn pill_icon(self) -> &'static str {
        match self {
            Self::Studio => "icons/clapperboard.svg",
            Self::Instant => "icons/zap.svg",
            Self::Screenshot => "icons/image.svg",
        }
    }

    /// The `size-7` glyph the card falls back to with no thumbnail
    /// (`Recents.tsx:148-155`): square-play for recordings, image for
    /// screenshots.
    pub fn fallback_icon(self) -> &'static str {
        match self {
            Self::Studio | Self::Instant => "icons/square-play.svg",
            Self::Screenshot => "icons/image.svg",
        }
    }
}

/// One `RecentMediaItem`.
#[derive(Debug, Clone, PartialEq)]
pub struct RecentItem {
    pub kind: MediaKind,
    /// The `.cap` bundle. `openRecentMedia` routes on this; here it is what
    /// the card reveals in Finder (see the README's deviation).
    pub bundle: PathBuf,
    /// `target.pretty_name` -- the card's title.
    pub pretty_name: String,
    /// `clip_count`, which drives the `"N clips"` sub-line for multi-segment
    /// studio recordings.
    pub clip_count: u32,
    /// `sort_time_millis`, and therefore `createdAt`.
    pub sort_time_millis: f64,
    /// The pre-baked thumbnail file, when the bundle actually has one. The
    /// TSX always builds the path and lets `<img onError>` fall back; the
    /// existence check happens here instead, on the same background pass that
    /// already stat'd the directory.
    pub thumbnail: Option<PathBuf>,
}

/// `media_sort_time_millis` (`lib.rs:3966-3972`): the filesystem `created()`
/// time of the path, falling back to `modified()`, then to the epoch.
fn media_sort_time_millis(path: &Path) -> f64 {
    let Ok(metadata) = path.metadata() else {
        return 0.0;
    };
    metadata
        .created()
        .or_else(|_| metadata.modified())
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}

/// `recordings_locations::known_recordings_dirs`: the active recordings
/// directory first, then the default location, then any previously used custom
/// folders -- so switching the storage folder never hides existing recordings.
/// Deduplicated by canonical path; directories that do not exist are skipped.
///
/// `CAP_GPUI_RECORDINGS_DIR` collapses the whole list to that one directory.
/// The override exists so a verification run stays out of the user's library,
/// and a scan that still walked the real one would defeat it.
pub fn known_recordings_dirs() -> Vec<PathBuf> {
    if let Ok(dir) = std::env::var("CAP_GPUI_RECORDINGS_DIR")
        && !dir.trim().is_empty()
    {
        return dedupe_existing_dirs(vec![PathBuf::from(dir)]);
    }

    let mut dirs = vec![
        crate::recording::recordings_dir(),
        crate::store::app_data_dir().join("recordings"),
    ];
    dirs.extend(
        crate::store::GeneralSettings::load()
            .previous_recordings_paths
            .iter()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute()),
    );
    dedupe_existing_dirs(dirs)
}

fn dedupe_existing_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        // Canonicalize so one folder reached by two spellings is scanned once;
        // otherwise every recording in it would be listed twice.
        let key = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if seen.insert(key) {
            out.push(dir);
        }
    }
    out
}

/// `screenshots_path(app)` (`lib.rs:6721-6726`): `<app data>/screenshots`.
/// Unlike recordings this one is not configurable -- the custom storage folder
/// setting only moves recordings.
pub fn screenshots_dir() -> PathBuf {
    crate::store::app_data_dir().join("screenshots")
}

/// `list_recordings`, narrowed to what a Recents card draws.
///
/// The scan itself is [`list_recordings_in`] -- one implementation, so the
/// carousel and the settings page can never disagree about what is in the
/// library.
fn scan_recordings(dir: &Path, out: &mut Vec<RecentItem>) {
    out.extend(list_recordings_in(std::slice::from_ref(&dir.to_path_buf())).into_iter().map(
        |item| RecentItem {
            kind: match item.mode {
                RecordingMode::Studio => MediaKind::Studio,
                RecordingMode::Instant => MediaKind::Instant,
            },
            pretty_name: item.pretty_name,
            clip_count: item.clip_count,
            sort_time_millis: item.sort_time_millis,
            thumbnail: item.thumbnail,
            bundle: item.path,
        },
    ));
}

// ---------------------------------------------------------------------------
// The whole library -- what the settings Recordings page lists
// ---------------------------------------------------------------------------

/// `RecordingMode`, i.e. `RecordingMetaWithMetadata::mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordingMode {
    Studio,
    Instant,
}

impl RecordingMode {
    /// The tab id and the serialized value: `meta.mode === activeTab()`
    /// compares against `"studio"` / `"instant"`.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Studio => "studio",
            Self::Instant => "instant",
        }
    }

    /// `firstLetterUpperCase()` on the badge -- the mode with its first letter
    /// capitalized, which for these two values is just the label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Studio => "Studio",
            Self::Instant => "Instant",
        }
    }

    /// `IconCapInstant` / `IconCapFilmCut`, the badge and tab glyphs.
    pub fn icon(self) -> &'static str {
        match self {
            Self::Studio => "icons/film-cut.svg",
            Self::Instant => "icons/instant.svg",
        }
    }
}

/// `StudioRecordingStatus` as the page reads it -- the enum is shared by both
/// modes in `RecordingMetaWithMetadata` (an instant recording's own
/// `InProgress` / `Failed` / `Complete` is mapped onto it).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordingStatus {
    InProgress,
    NeedsRemux,
    Failed { error: String },
    Complete,
}

impl RecordingStatus {
    pub fn is_complete(&self) -> bool {
        matches!(self, Self::Complete)
    }

    pub fn is_in_progress(&self) -> bool {
        matches!(self, Self::InProgress)
    }

    /// The tooltip text on the "Recording failed" badge.
    pub fn error(&self) -> Option<&str> {
        match self {
            Self::Failed { error } => Some(error.as_str()),
            _ => None,
        }
    }
}

/// One `(path, RecordingMetaWithMetadata)` pair out of `list_recordings`,
/// carrying only the fields `recordings.tsx` reads.
#[derive(Debug, Clone, PartialEq)]
pub struct RecordingItem {
    /// The `.cap` bundle -- the `path` half of the tuple, and what every row
    /// action takes.
    pub path: PathBuf,
    pub mode: RecordingMode,
    pub status: RecordingStatus,
    /// `clip_count`, which drives the `"N clips"` badge.
    pub clip_count: u32,
    pub pretty_name: String,
    /// `meta.sharing.link`, which the "Open link" button opens. The id and the
    /// content hash are not read by this page.
    pub sharing: Option<String>,
    pub sort_time_millis: f64,
    /// `${path}/screenshots/display.jpg`, existence-checked here rather than
    /// left to an `<img onError>`.
    pub thumbnail: Option<PathBuf>,
}

impl RecordingItem {
    /// `hasActiveRecording` (`recordings.tsx:66-73`) minus its upload half:
    /// there are no uploads in this app, so `MultipartUpload` /
    /// `SinglePartUpload` can never be the reason to keep polling.
    pub fn is_active(&self) -> bool {
        matches!(
            self.status,
            RecordingStatus::InProgress | RecordingStatus::NeedsRemux
        )
    }

    /// `studioCompleteCheck()`: the only rows whose whole body is clickable.
    pub fn opens_editor(&self) -> bool {
        self.mode == RecordingMode::Studio && self.status.is_complete()
    }
}

/// `RecordingMetaWithMetadata::new` (`lib.rs:3888-3925`).
fn recording_item(path: PathBuf, meta: RecordingMeta, sort_time_millis: f64) -> RecordingItem {
    let mode = match &meta.inner {
        RecordingMetaInner::Studio(_) => RecordingMode::Studio,
        RecordingMetaInner::Instant(_) => RecordingMode::Instant,
    };
    let clip_count = match &meta.inner {
        RecordingMetaInner::Studio(studio) => match &**studio {
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len() as u32,
            StudioRecordingMeta::SingleSegment { .. } => 1,
        },
        RecordingMetaInner::Instant(_) => 1,
    };
    let status = match &meta.inner {
        RecordingMetaInner::Studio(studio) => match &**studio {
            // A `MultipleSegments` meta with no `status` key at all is
            // Complete -- `.unwrap_or(StudioRecordingStatus::Complete)`.
            StudioRecordingMeta::MultipleSegments { inner } => match &inner.status {
                Some(StudioRecordingStatus::InProgress) => RecordingStatus::InProgress,
                Some(StudioRecordingStatus::NeedsRemux) => RecordingStatus::NeedsRemux,
                Some(StudioRecordingStatus::Failed { error }) => RecordingStatus::Failed {
                    error: error.clone(),
                },
                Some(StudioRecordingStatus::Complete) | None => RecordingStatus::Complete,
            },
            StudioRecordingMeta::SingleSegment { .. } => RecordingStatus::Complete,
        },
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { .. }) => {
            RecordingStatus::InProgress
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Failed { error }) => {
            RecordingStatus::Failed {
                error: error.clone(),
            }
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::Complete { .. }) => {
            RecordingStatus::Complete
        }
    };

    let thumbnail = bundle_thumbnail_path(&path);
    RecordingItem {
        mode,
        status,
        clip_count,
        pretty_name: meta.pretty_name,
        sharing: meta.sharing.map(|sharing| sharing.link),
        sort_time_millis,
        thumbnail: thumbnail.is_file().then_some(thumbnail),
        path,
    }
}

/// `list_recordings` (`lib.rs:3971-3999`), against explicit directories.
///
/// Every subdirectory of every known recordings folder whose
/// `recording-meta.json` parses; a directory whose meta is missing or corrupt
/// is skipped without a word, because `get_recording_meta` returns `Err` and
/// the `if let Ok` drops it. There is no `.cap` extension filter -- that is the
/// screenshots scan's rule, not this one. Sorted newest first by
/// `sort_time_millis`, which is the directory's own creation time recomputed on
/// every call.
///
/// Recordings only: `list_screenshots` is a separate command behind a separate
/// settings page.
pub fn list_recordings_in(dirs: &[PathBuf]) -> Vec<RecordingItem> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Ok(meta) = RecordingMeta::load_for_project(&path) else {
                continue;
            };
            let sort_time_millis = media_sort_time_millis(&path);
            out.push(recording_item(path, meta, sort_time_millis));
        }
    }
    out.sort_by(|a, b| b.sort_time_millis.total_cmp(&a.sort_time_millis));
    out
}

/// `list_recordings` against the real library.
pub fn list_recordings() -> Vec<RecordingItem> {
    list_recordings_in(&known_recordings_dirs())
}

/// `delete_recording_directory` (`lib.rs:4001-4046`), guards verbatim.
///
/// Three of them, and each one covers a hole the others leave:
///
/// 1. a `ParentDir` component anywhere is rejected up front, because
///    `Path::starts_with` compares raw components and would happily accept
///    `<recordings>/../../etc`;
/// 2. the path must start with one of the known recordings directories, which
///    is the same set the listing walks;
/// 3. both sides are canonicalized before the recursive delete, so a symlink
///    inside a recordings directory cannot point the delete somewhere else.
///
/// A path that does not exist is a no-op success, exactly as it is there.
pub fn delete_recording_directory_in(dirs: &[PathBuf], path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid path".to_string());
    }

    if !dirs.iter().any(|dir| path.starts_with(dir)) {
        return Err("Path is not inside a recordings directory".to_string());
    }

    if path.exists() {
        let canonical_path = path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve recording path: {error}"))?;

        let inside_known_dir = dirs.iter().any(|dir| {
            dir.canonicalize()
                .map(|dir| canonical_path.starts_with(&dir))
                .unwrap_or(false)
        });
        if !inside_known_dir {
            return Err("Path is not inside a recordings directory".to_string());
        }

        std::fs::remove_dir_all(&canonical_path)
            .map_err(|error| format!("Failed to delete recording: {error}"))?;
    }

    Ok(())
}

/// `delete_recording_directory` against the real library.
///
/// The Tauri command also emits `RecordingDeleted`, which the page listens for
/// to refetch; here the caller refreshes its own list instead.
pub fn delete_recording_directory(path: &Path) -> Result<(), String> {
    delete_recording_directory_in(&known_recordings_dirs(), path)
}

/// `openRecordingFolder` (`utils/recording.ts:53-70`).
///
/// An instant recording opens its `content` directory in Finder --
/// `commands.openFilePath` is `open <dir>` on macOS -- and anything else, or a
/// bundle with no `content` directory, is revealed with `open -R`. The trailing
/// separator the TS strips and re-adds does not survive `PathBuf`, and Finder
/// does not need it.
///
/// One deviation, deliberate: the TS treats *spawning* the opener as success,
/// so an instant bundle with no `content` directory silently opens nothing.
/// Here the directory is stat'd first and the bundle is revealed instead.
pub fn open_recording_folder(path: &Path, mode: RecordingMode) {
    #[cfg(target_os = "macos")]
    {
        let content = path.join("content");
        let (argument, target) = if mode == RecordingMode::Instant && content.is_dir() {
            (None, content)
        } else {
            (Some("-R"), path.to_path_buf())
        };
        let mut command = std::process::Command::new("open");
        if let Some(argument) = argument {
            command.arg(argument);
        }
        if let Err(error) = command.arg(&target).spawn() {
            tracing::warn!(path = %target.display(), "opening the recording folder failed: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (path, mode);
}

/// `list_screenshots`: `*.cap` directories only, and the sort key is the PNG's
/// timestamp rather than the directory's -- both quirks are the Tauri
/// command's, kept so the two apps order an identical library identically.
fn scan_screenshots(dir: &Path, out: &mut Vec<RecentItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || path.extension().and_then(|ext| ext.to_str()) != Some("cap") {
            continue;
        }
        let Ok(meta) = RecordingMeta::load_for_project(&path) else {
            continue;
        };
        let Some(png) = std::fs::read_dir(&path).ok().and_then(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("png"))
        }) else {
            continue;
        };

        out.push(RecentItem {
            kind: MediaKind::Screenshot,
            bundle: path,
            pretty_name: meta.pretty_name,
            clip_count: 1,
            // `previewPath = candidate.target.path` -- for a screenshot the
            // listed path *is* the PNG.
            sort_time_millis: media_sort_time_millis(&png),
            thumbnail: Some(png),
        });
    }
}

fn newest_first(items: &mut [RecentItem]) {
    items.sort_by(|a, b| b.sort_time_millis.total_cmp(&a.sort_time_millis));
}

/// The `recentMedia` query, against explicit directories.
///
/// Faithful to the shape as well as the result: each list is independently
/// sorted and capped at `RECENT_MEDIA_LIMIT` *before* the merge, then the
/// merged list is sorted and capped again. Capping twice is not redundant --
/// it is what stops ten screenshots from crowding out a recording that is
/// newer than nine of them.
pub fn recent_media_in(recording_dirs: &[PathBuf], screenshots_dir: &Path) -> Vec<RecentItem> {
    let mut recordings = Vec::new();
    for dir in recording_dirs {
        scan_recordings(dir, &mut recordings);
    }
    newest_first(&mut recordings);
    recordings.truncate(RECENT_MEDIA_LIMIT);

    let mut screenshots = Vec::new();
    scan_screenshots(screenshots_dir, &mut screenshots);
    newest_first(&mut screenshots);
    screenshots.truncate(RECENT_MEDIA_LIMIT);

    let mut merged = recordings;
    merged.extend(screenshots);
    newest_first(&mut merged);
    merged.truncate(RECENT_MEDIA_LIMIT);
    merged
}

/// The `recentMedia` query against the real library.
pub fn recent_media() -> Vec<RecentItem> {
    recent_media_in(&known_recordings_dirs(), &screenshots_dir())
}

// ---------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------

/// The card is `h-28 w-[196px]`; this is that at 2x.
///
/// The bundle's `display.jpg` is written at the display's *native* resolution
/// (`create_screenshot(.., None)`), which on this machine is 3024x1964 -- nine
/// of those uploaded whole would be ~200MB of sprite atlas for nine 196x112
/// cards. Decoding is a background-executor job either way, so it downsamples
/// there too.
const THUMBNAIL_WIDTH: u32 = 392;
const THUMBNAIL_HEIGHT: u32 = 224;

/// Decode a pre-baked bundle thumbnail into a gpui image.
///
/// The scale factor covers the card rather than fitting inside it, because the
/// element paints with `ObjectFit::Cover` (`object-cover` on the TSX's `<img>`)
/// and a contain-fit source would letterbox. Never upscales: a thumbnail
/// smaller than the card is handed over as-is and the element stretches it,
/// same as the browser would.
pub fn decode_thumbnail(path: &Path) -> Option<Arc<RenderImage>> {
    let bytes = std::fs::read(path).ok()?;
    // Sniff rather than trust the extension: `list_screenshots` finds the
    // preview by extension scan, and a bundle could hold a mislabelled file.
    let format = image::guess_format(&bytes).ok()?;
    let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;

    let (width, height) = (decoded.width().max(1), decoded.height().max(1));
    let scale = (THUMBNAIL_WIDTH as f32 / width as f32)
        .max(THUMBNAIL_HEIGHT as f32 / height as f32)
        .min(1.0);
    let mut rgba = if scale < 1.0 {
        decoded
            .resize_exact(
                ((width as f32 * scale).round() as u32).max(1),
                ((height as f32 * scale).round() as u32).max(1),
                image::imageops::FilterType::Triangle,
            )
            .into_rgba8()
    } else {
        decoded.into_rgba8()
    };

    // gpui's atlas takes BGRA; `image`'s RgbaImage is just the container (the
    // same swap gpui's own asset loader does after decoding).
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(rgba)
    ])))
}

// ---------------------------------------------------------------------------
// Generating the thumbnail a recording made here would otherwise never have
// ---------------------------------------------------------------------------

/// `create_screenshot` (`apps/desktop/src-tauri/src/lib.rs:2582-2655`), ported.
///
/// The Tauri app writes `<bundle>/screenshots/display.jpg` from
/// `handle_recording_finish`; `cap-recording` itself never does, so a recording
/// made by *this* app would show the icon fallback in both apps' Recents
/// forever. The function has no Tauri dependency beyond living in that binary
/// -- it is `ffmpeg-next` (already built here, for the recorder) plus the
/// `image` crate (already here, for camera frames) -- so it is transcribed
/// rather than deferred.
///
/// Faithful in the parts that matter to the output: decode packets until the
/// *first* video frame comes out, scale to RGB24 at the source's own size
/// (`size: None` at both call sites, so a native-resolution JPEG, not a
/// thumbnail), save as JPEG. Blocking; callers hand it to `spawn_blocking`.
pub fn create_screenshot(input: &Path, output: &Path, size: Option<(u32, u32)>) -> Result<(), String> {
    let mut ictx = ffmpeg::format::input(input).map_err(|e| e.to_string())?;
    let input_stream = ictx
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or("No video stream found")?;
    let video_stream_index = input_stream.index();

    let mut decoder = ffmpeg::codec::context::Context::from_parameters(input_stream.parameters())
        .map_err(|e| e.to_string())?
        .decoder()
        .video()
        .map_err(|e| e.to_string())?;

    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg::format::Pixel::RGB24,
        size.map_or(decoder.width(), |s| s.0),
        size.map_or(decoder.height(), |s| s.1),
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|e| e.to_string())?;

    let mut frame = ffmpeg::frame::Video::empty();
    for (stream, packet) in ictx.packets() {
        if stream.index() != video_stream_index {
            continue;
        }
        decoder.send_packet(&packet).map_err(|e| e.to_string())?;
        if decoder.receive_frame(&mut frame).is_err() {
            continue;
        }

        let mut rgb_frame = ffmpeg::frame::Video::empty();
        scaler.run(&frame, &mut rgb_frame).map_err(|e| e.to_string())?;

        // The scaler's rows are padded to its own stride; the image buffer is
        // tight, so the copy is row by row.
        let width = rgb_frame.width() as usize;
        let height = rgb_frame.height() as usize;
        let src_stride = rgb_frame.stride(0);
        let dst_stride = width * 3;
        let mut buffer = vec![0u8; height * dst_stride];
        for y in 0..height {
            let src = &rgb_frame.data(0)[y * src_stride..y * src_stride + dst_stride];
            buffer[y * dst_stride..(y + 1) * dst_stride].copy_from_slice(src);
        }

        let image = image::RgbImage::from_raw(width as u32, height as u32, buffer)
            .ok_or("Failed to create image from frame data")?;
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        return image
            .save_with_format(output, image::ImageFormat::Jpeg)
            .map_err(|e| e.to_string());
    }

    Err("Failed to create screenshot".to_string())
}

/// `<bundle>/screenshots/display.jpg` -- the one path both apps' Recents look
/// for.
pub fn bundle_thumbnail_path(project_dir: &Path) -> PathBuf {
    project_dir.join("screenshots").join("display.jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `.cap` bundle with a `recording-meta.json` the real parser accepts.
    /// `filetime` is not a dependency here, so the sort key -- the directory's
    /// own creation time -- is separated by creating the fixtures in order
    /// with a gap between them.
    fn write_studio_bundle(dir: &Path, name: &str, segments: usize) -> PathBuf {
        let bundle = dir.join(format!("{name}.cap"));
        std::fs::create_dir_all(&bundle).unwrap();
        let segments: Vec<String> = (0..segments)
            .map(|i| {
                format!(
                    r#"{{"display":{{"path":"content/segments/segment-{i}/display.mp4","fps":30}}}}"#
                )
            })
            .collect();
        std::fs::write(
            bundle.join("recording-meta.json"),
            format!(
                r#"{{"pretty_name":"{name}","sharing":null,"segments":[{}]}}"#,
                segments.join(",")
            ),
        )
        .unwrap();
        bundle
    }

    fn write_screenshot_bundle(dir: &Path, name: &str) -> PathBuf {
        let bundle = dir.join(format!("{name}.cap"));
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(
            bundle.join("recording-meta.json"),
            format!(r#"{{"pretty_name":"{name}","sharing":null,"fps":0}}"#),
        )
        .unwrap();
        // The scan finds the preview by extension, not by name.
        std::fs::write(bundle.join("shot.png"), b"not really a png").unwrap();
        bundle
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cap-gpui-library-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recents_are_newest_first_and_capped_at_nine() {
        let root = temp_dir("cap");
        let recordings = root.join("recordings");
        let screenshots = root.join("screenshots");
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::create_dir_all(&screenshots).unwrap();

        // Twelve recordings, oldest first, so the newest nine are 3..=11.
        for i in 0..12 {
            write_studio_bundle(&recordings, &format!("rec-{i:02}"), 1);
            std::thread::sleep(std::time::Duration::from_millis(6));
        }

        let items = recent_media_in(&[recordings.clone()], &screenshots);
        assert_eq!(items.len(), RECENT_MEDIA_LIMIT, "capped at the limit");
        assert_eq!(items[0].pretty_name, "rec-11", "newest first");
        assert_eq!(items[8].pretty_name, "rec-03", "oldest kept is the 9th newest");
        assert!(
            items
                .windows(2)
                .all(|pair| pair[0].sort_time_millis >= pair[1].sort_time_millis),
            "descending by sort time"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recordings_and_screenshots_merge_into_one_ordering() {
        let root = temp_dir("merge");
        let recordings = root.join("recordings");
        let screenshots = root.join("screenshots");
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::create_dir_all(&screenshots).unwrap();

        write_studio_bundle(&recordings, "old-recording", 1);
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_screenshot_bundle(&screenshots, "middle-screenshot");
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_studio_bundle(&recordings, "new-recording", 3);

        let items = recent_media_in(&[recordings.clone()], &screenshots);
        let names: Vec<&str> = items.iter().map(|item| item.pretty_name.as_str()).collect();
        assert_eq!(
            names,
            ["new-recording", "middle-screenshot", "old-recording"],
            "one ordering across both kinds"
        );
        assert_eq!(items[0].kind, MediaKind::Studio);
        assert_eq!(items[0].clip_count, 3, "multi-segment studio meta counts segments");
        assert_eq!(items[1].kind, MediaKind::Screenshot);
        assert!(
            items[1]
                .thumbnail
                .as_ref()
                .is_some_and(|path| path.extension().unwrap() == "png"),
            "a screenshot's own PNG is its thumbnail"
        );
        assert_eq!(items[2].clip_count, 1);
        assert!(
            items[2].thumbnail.is_none(),
            "no display.jpg on disk means the icon fallback, not a broken path"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_baked_thumbnail_is_found_and_junk_is_skipped() {
        let root = temp_dir("thumb");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();

        let bundle = write_studio_bundle(&recordings, "with-thumb", 1);
        let thumbnail = bundle_thumbnail_path(&bundle);
        std::fs::create_dir_all(thumbnail.parent().unwrap()).unwrap();
        std::fs::write(&thumbnail, b"jpeg bytes").unwrap();

        // Neither of these has a parseable meta, and neither may appear.
        std::fs::create_dir_all(recordings.join("not-a-recording")).unwrap();
        std::fs::write(recordings.join("loose-file.mp4"), b"").unwrap();

        let items = recent_media_in(&[recordings.clone()], &root.join("missing-screenshots"));
        assert_eq!(items.len(), 1, "only the bundle with a meta is listed");
        assert_eq!(items[0].thumbnail.as_deref(), Some(thumbnail.as_path()));

        std::fs::remove_dir_all(&root).ok();
    }

    // -- The settings page's listing ------------------------------------

    /// A bundle with a hand-written meta, so a test can spell out exactly the
    /// JSON `RecordingMeta` has to survive.
    fn write_bundle(dir: &Path, name: &str, meta: &str) -> PathBuf {
        let bundle = dir.join(format!("{name}.cap"));
        std::fs::create_dir_all(&bundle).unwrap();
        std::fs::write(bundle.join("recording-meta.json"), meta).unwrap();
        bundle
    }

    /// `RecordingMetaWithMetadata::new`: the mode, the clip count and the
    /// status for each shape of meta the two recorders write.
    #[test]
    fn every_meta_shape_derives_its_mode_status_and_clip_count() {
        let root = temp_dir("listing");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();

        let segment = r#"{"display":{"path":"content/segments/segment-0/display.mp4","fps":30}}"#;
        // Oldest first, so the sort assertion below has something to do.
        write_bundle(
            &recordings,
            "studio-multi",
            &format!(
                r#"{{"pretty_name":"Studio multi","sharing":{{"id":"abc","link":"https://cap.so/s/abc"}},"segments":[{segment},{segment},{segment}]}}"#
            ),
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "studio-single",
            r#"{"pretty_name":"Studio single","sharing":null,"display":{"path":"content/display.mp4","fps":30}}"#,
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "studio-failed",
            &format!(
                r#"{{"pretty_name":"Studio failed","sharing":null,"segments":[{segment}],"status":{{"status":"Failed","error":"encoder died"}}}}"#
            ),
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "studio-remux",
            &format!(
                r#"{{"pretty_name":"Studio remux","sharing":null,"segments":[{segment}],"status":{{"status":"NeedsRemux"}}}}"#
            ),
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "instant-complete",
            r#"{"pretty_name":"Instant complete","sharing":null,"fps":30,"sample_rate":48000}"#,
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "instant-progress",
            r#"{"pretty_name":"Instant in progress","sharing":null,"recording":true}"#,
        );
        std::thread::sleep(std::time::Duration::from_millis(6));
        write_bundle(
            &recordings,
            "instant-failed",
            r#"{"pretty_name":"Instant failed","sharing":null,"error":"upload died"}"#,
        );
        // Corrupt bundles are skipped in silence, exactly as `if let Ok` does.
        std::fs::create_dir_all(recordings.join("empty-dir")).unwrap();
        write_bundle(&recordings, "unparseable", "{ not json ");
        std::fs::write(recordings.join("loose-file.mp4"), b"").unwrap();

        let items = list_recordings_in(&[recordings.clone()]);
        let names: Vec<&str> = items
            .iter()
            .map(|item| item.pretty_name.as_str())
            .collect();
        assert_eq!(
            names,
            [
                "Instant failed",
                "Instant in progress",
                "Instant complete",
                "Studio remux",
                "Studio failed",
                "Studio single",
                "Studio multi",
            ],
            "newest first, and only the seven parseable bundles"
        );

        let by_name = |name: &str| {
            items
                .iter()
                .find(|item| item.pretty_name == name)
                .unwrap_or_else(|| panic!("{name} missing"))
        };

        let multi = by_name("Studio multi");
        assert_eq!(multi.mode, RecordingMode::Studio);
        assert_eq!(multi.clip_count, 3, "one clip per segment");
        assert_eq!(
            multi.status,
            RecordingStatus::Complete,
            "a MultipleSegments meta with no status key is Complete"
        );
        assert_eq!(multi.sharing.as_deref(), Some("https://cap.so/s/abc"));
        assert!(multi.opens_editor(), "studio + Complete is the clickable row");
        assert!(!multi.is_active());

        let single = by_name("Studio single");
        assert_eq!(single.mode, RecordingMode::Studio);
        assert_eq!(single.clip_count, 1);
        assert_eq!(single.status, RecordingStatus::Complete);
        assert_eq!(single.sharing, None);

        let failed = by_name("Studio failed");
        assert_eq!(
            failed.status,
            RecordingStatus::Failed {
                error: "encoder died".to_string()
            }
        );
        assert_eq!(failed.status.error(), Some("encoder died"));
        assert!(!failed.opens_editor(), "a failed studio row is inert");
        assert!(!failed.is_active(), "Failed does not keep the poll running");

        let remux = by_name("Studio remux");
        assert_eq!(remux.status, RecordingStatus::NeedsRemux);
        assert!(remux.is_active(), "NeedsRemux keeps the 2s poll running");

        let complete = by_name("Instant complete");
        assert_eq!(complete.mode, RecordingMode::Instant);
        assert_eq!(complete.clip_count, 1, "an instant recording is one clip");
        assert_eq!(complete.status, RecordingStatus::Complete);
        assert!(
            !complete.opens_editor(),
            "instant rows never open the editor, complete or not"
        );

        let progress = by_name("Instant in progress");
        assert_eq!(progress.status, RecordingStatus::InProgress);
        assert!(progress.is_active());

        assert_eq!(
            by_name("Instant failed").status,
            RecordingStatus::Failed {
                error: "upload died".to_string()
            }
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// The three `delete_recording_directory` guards, one test each.
    #[test]
    fn delete_rejects_traversal_paths_outside_and_symlink_escapes() {
        let root = temp_dir("delete");
        let recordings = root.join("recordings");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let dirs = vec![recordings.clone()];

        // 1. A `..` component anywhere, even one that resolves back inside.
        let bundle = write_studio_bundle(&recordings, "keep-me", 1);
        let traversal = recordings.join("..").join("elsewhere");
        assert_eq!(
            delete_recording_directory_in(&dirs, &traversal),
            Err("Invalid path".to_string())
        );
        assert!(elsewhere.is_dir(), "the traversal target survives");

        // 2. A real path that is simply not in a recordings directory.
        assert_eq!(
            delete_recording_directory_in(&dirs, &elsewhere),
            Err("Path is not inside a recordings directory".to_string())
        );
        assert!(elsewhere.is_dir());

        // 3. A symlink *inside* the recordings directory pointing out of it.
        let victim = elsewhere.join("precious");
        std::fs::create_dir_all(&victim).unwrap();
        std::fs::write(victim.join("recording.mp4"), b"irreplaceable").unwrap();
        let escape = recordings.join("escape.cap");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&victim, &escape).unwrap();
        assert_eq!(
            delete_recording_directory_in(&dirs, &escape),
            Err("Path is not inside a recordings directory".to_string()),
            "canonicalizing catches the symlink the prefix check let through"
        );
        assert!(
            victim.join("recording.mp4").is_file(),
            "the symlink's target is untouched"
        );

        // And the happy path still deletes.
        assert_eq!(delete_recording_directory_in(&dirs, &bundle), Ok(()));
        assert!(!bundle.exists());
        // A path that is already gone is a no-op success, as it is there.
        assert_eq!(delete_recording_directory_in(&dirs, &bundle), Ok(()));

        std::fs::remove_dir_all(&root).ok();
    }
}
