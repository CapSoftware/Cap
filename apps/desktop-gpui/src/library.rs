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
//! Everything in this module runs on the background executor --
//! [`spawn_decode_pool`] is the one function called from the foreground, and
//! all it does is fan jobs out to that executor. Nothing here touches gpui
//! state.

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
use cap_recording::{recovery::RecoveryManager, upload_resume::UploadLock};
use gpui::{App, RenderImage};

/// `RECENT_MEDIA_LIMIT` in `new-main/index.tsx:129`.
pub const RECENT_MEDIA_LIMIT: usize = 9;

/// Main-window recordings/screenshots panels slice to this many
/// (`new-main/index.tsx:2377-2393`).
pub const LIBRARY_PANEL_LIMIT: usize = 20;

/// Which of the three card shapes `RecentCard` draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Studio,
    Instant,
    Screenshot,
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
    pub thumbnail_version: Option<u128>,
    /// `meta.sharing.link` -- Instant Mode cards open this in the browser.
    pub sharing: Option<String>,
}

/// `media_sort_time_millis` (`lib.rs:3966-3972`): the filesystem `created()`
/// time of the path, falling back to `modified()`, then to the epoch.
fn media_sort_time_millis(path: &Path) -> f64 {
    path.metadata()
        .map_or(0.0, |metadata| metadata_sort_time_millis(&metadata))
}

fn metadata_sort_time_millis(metadata: &std::fs::Metadata) -> f64 {
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
/// The scan itself is [`recording_items_in`] -- one implementation, so the
/// carousel and the settings page can never disagree about what is in the
/// library.
fn scan_recordings(dirs: &[PathBuf], out: &mut Vec<RecentItem>) {
    out.extend(
        recording_items_in(dirs)
            .take(RECENT_MEDIA_LIMIT)
            .map(|item| RecentItem {
                kind: match item.mode {
                    RecordingMode::Studio => MediaKind::Studio,
                    RecordingMode::Instant => MediaKind::Instant,
                },
                pretty_name: item.pretty_name,
                clip_count: item.clip_count,
                sort_time_millis: item.sort_time_millis,
                thumbnail: item.thumbnail,
                thumbnail_version: item.thumbnail_version,
                sharing: item.sharing,
                bundle: item.path,
            }),
    );
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
    pub upload: Option<crate::upload::queue::UploadState>,
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
    pub thumbnail_version: Option<u128>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct IncompleteRecordingItem {
    pub project_path: PathBuf,
    pub pretty_name: String,
    pub segment_count: usize,
    pub estimated_duration_secs: f64,
}

impl RecordingItem {
    pub fn is_active(&self) -> bool {
        self.status == RecordingStatus::InProgress
            || self
                .upload
                .as_ref()
                .is_some_and(crate::upload::queue::UploadState::is_pending)
    }

    /// `studioCompleteCheck()`: the only rows whose whole body is clickable.
    pub fn opens_editor(&self) -> bool {
        self.mode == RecordingMode::Studio && self.status.is_complete()
    }
}

/// `RecordingMetaWithMetadata::new`'s mode (`lib.rs:3888-3925`).
fn recording_mode(meta: &RecordingMeta) -> RecordingMode {
    match &meta.inner {
        RecordingMetaInner::Studio(_) => RecordingMode::Studio,
        RecordingMetaInner::Instant(_) => RecordingMode::Instant,
    }
}

/// `RecordingMetaWithMetadata::new`'s status (`lib.rs:3888-3925`).
fn recording_status(meta: &RecordingMeta) -> RecordingStatus {
    match &meta.inner {
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
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: false }) => {
            RecordingStatus::NeedsRemux
        }
        RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true }) => {
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
    }
}

#[cfg(test)]
thread_local! {
    /// Full [`RecordingItem`]s built on this test thread. Recovery must stay on
    /// [`ScannedRecording`], so its tests can pin that this does not move.
    static RECORDING_ITEM_BUILDS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// `RecordingMetaWithMetadata::new` (`lib.rs:3888-3925`), plus the filesystem
/// lookups a card needs.
fn recording_item(path: PathBuf, meta: RecordingMeta, sort_time_millis: f64) -> RecordingItem {
    let mode = recording_mode(&meta);
    let clip_count = match &meta.inner {
        RecordingMetaInner::Studio(studio) => match &**studio {
            StudioRecordingMeta::MultipleSegments { inner } => inner.segments.len() as u32,
            StudioRecordingMeta::SingleSegment { .. } => 1,
        },
        RecordingMetaInner::Instant(_) => 1,
    };
    let status = recording_status(&meta);

    #[cfg(test)]
    RECORDING_ITEM_BUILDS.with(|builds| builds.set(builds.get() + 1));

    let preview = path.join("screenshots/preview.jpg");
    let thumbnail = if preview.is_file() {
        preview
    } else {
        bundle_thumbnail_path(&path)
    };
    let upload = crate::upload::queue::status(&path, &meta);
    RecordingItem {
        upload,
        mode,
        status,
        clip_count,
        pretty_name: meta.pretty_name,
        sharing: meta.sharing.map(|sharing| sharing.link),
        sort_time_millis,
        thumbnail_version: source_mtime_nanos(&thumbnail),
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
    recording_items_in(dirs).collect()
}

fn recording_items_in(dirs: &[PathBuf]) -> impl Iterator<Item = RecordingItem> {
    scanned_recordings_in(dirs).map(ScannedRecording::into_item)
}

/// A recording directory after its metadata has been parsed, before the
/// filesystem work a card needs (upload state, thumbnails, preview mtimes).
///
/// Both the library listing and the recovery scan walk every bundle, but
/// recovery drops complete recordings before it needs any of those fields.
/// Keeping this intermediate means the scan parses each `recording-meta.json`
/// once and recovery only pays for recordings it can actually return.
///
/// Skipping the fields is state-neutral: `upload::queue::status` only reads the
/// saved upload state (and settings for legacy records), and the thumbnail
/// checks are `stat`s.
struct ScannedRecording {
    path: PathBuf,
    meta: RecordingMeta,
    sort_time_millis: f64,
}

impl ScannedRecording {
    fn status(&self) -> RecordingStatus {
        recording_status(&self.meta)
    }

    fn into_item(self) -> RecordingItem {
        recording_item(self.path, self.meta, self.sort_time_millis)
    }
}

fn scanned_recordings_in(dirs: &[PathBuf]) -> impl Iterator<Item = ScannedRecording> {
    let mut paths = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let sort_time_millis = media_sort_time_millis(&path);
            paths.push((path, sort_time_millis));
        }
    }
    paths.sort_by(|(_, a), (_, b)| b.total_cmp(a));
    paths.into_iter().filter_map(|(path, sort_time_millis)| {
        let meta = RecordingMeta::load_for_project(&path).ok()?;
        Some(ScannedRecording {
            path,
            meta,
            sort_time_millis,
        })
    })
}

/// `list_recordings` against the real library.
pub fn list_recordings() -> Vec<RecordingItem> {
    list_recordings_in(&known_recordings_dirs())
}

pub fn list_recordings_limited(limit: usize) -> Vec<RecordingItem> {
    recording_items_in(&known_recordings_dirs())
        .take(limit)
        .collect()
}

pub fn find_incomplete_recordings_in(
    dirs: &[PathBuf],
    active_recording: Option<&Path>,
) -> Vec<IncompleteRecordingItem> {
    scanned_recordings_in(dirs)
        .filter(|recording| {
            matches!(
                recording.status(),
                RecordingStatus::InProgress | RecordingStatus::NeedsRemux
            ) && active_recording != Some(recording.path.as_path())
                && is_recording_after_recovery_cutoff(
                    &recording.meta.pretty_name,
                    recording.sort_time_millis,
                )
        })
        .filter_map(|recording| {
            let ScannedRecording { path, meta, .. } = recording;
            if recording_mode(&meta) == RecordingMode::Instant {
                let display = path.join("content/display");
                if !display.join("init.mp4").is_file() {
                    return None;
                }
                let segment_count = std::fs::read_dir(display)
                    .ok()?
                    .filter_map(Result::ok)
                    .filter(|entry| RecoveryManager::is_m4s_complete(&entry.path()))
                    .count();
                return (segment_count > 0).then_some(IncompleteRecordingItem {
                    project_path: path,
                    pretty_name: meta.pretty_name,
                    segment_count,
                    estimated_duration_secs: 0.0,
                });
            }
            let incomplete = RecoveryManager::inspect_recording(&path)?;
            (!incomplete.recoverable_segments.is_empty()).then_some(IncompleteRecordingItem {
                project_path: path,
                pretty_name: meta.pretty_name,
                segment_count: incomplete.recoverable_segments.len(),
                estimated_duration_secs: incomplete.estimated_duration.as_secs_f64(),
            })
        })
        .collect()
}

pub fn find_incomplete_recordings() -> Vec<IncompleteRecordingItem> {
    find_incomplete_recordings_in(&known_recordings_dirs(), None)
}

fn is_recording_after_recovery_cutoff(pretty_name: &str, sort_time_millis: f64) -> bool {
    let Some(date) = pretty_name
        .strip_prefix("Cap ")
        .and_then(|name| name.split(" at ").next())
        .and_then(|value| chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
        .or_else(|| {
            chrono::DateTime::from_timestamp_millis(sort_time_millis as i64)
                .map(|timestamp| timestamp.date_naive())
        })
    else {
        return false;
    };

    chrono::NaiveDate::from_ymd_opt(2025, 12, 31).is_some_and(|cutoff| date > cutoff)
}

pub fn recover_incomplete_recording(project_path: &Path) -> Result<PathBuf, String> {
    recover_incomplete_recording_in(&known_recordings_dirs(), project_path)
}

fn recover_incomplete_recording_in(
    dirs: &[PathBuf],
    project_path: &Path,
) -> Result<PathBuf, String> {
    if project_path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
        || !dirs.iter().any(|dir| project_path.starts_with(dir))
    {
        return Err("Path is not inside a recordings directory".to_string());
    }

    let canonical_path = project_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve recording path: {error}"))?;
    if !dirs.iter().any(|dir| {
        dir.canonicalize()
            .is_ok_and(|canonical_dir| canonical_path.starts_with(canonical_dir))
    }) {
        return Err("Path is not inside a recordings directory".to_string());
    }

    let meta = RecordingMeta::load_for_project(&canonical_path)
        .map_err(|error| format!("Failed to load recording metadata: {error}"))?;
    if matches!(meta.inner, RecordingMetaInner::Instant(_)) {
        let _upload_lock = UploadLock::acquire(&canonical_path).map_err(|error| {
            format!("Could not lock the instant recording for recovery: {error}")
        })?;
        return crate::recording::recover_instant_recording(&canonical_path)
            .map_err(|error| format!("Could not save the instant recording: {error:#}"));
    }
    let Some(studio) = meta.studio_meta() else {
        return Err("Only incomplete studio recordings can be recovered".to_string());
    };
    if !matches!(
        studio.status(),
        StudioRecordingStatus::InProgress | StudioRecordingStatus::NeedsRemux
    ) {
        return Err("Recording is not waiting for recovery".to_string());
    }

    let incomplete = RecoveryManager::inspect_recording(&canonical_path)
        .ok_or_else(|| "No recoverable segments found".to_string())?;
    crate::recording::ensure_finalization_storage(&canonical_path)
        .map_err(|error| format!("{error:#}"))?;
    let recovered = RecoveryManager::recover(&incomplete)
        .map_err(|error| format!("Failed to recover recording: {error}"))?;
    let display = match &recovered.meta {
        StudioRecordingMeta::SingleSegment { segment } => {
            segment.display.path.to_path(&recovered.project_path)
        }
        StudioRecordingMeta::MultipleSegments { inner } => inner
            .segments
            .first()
            .map(|segment| segment.display.path.to_path(&recovered.project_path))
            .ok_or_else(|| "Recovered recording has no display segments".to_string())?,
    };
    if let Err(error) = create_screenshot(
        &display,
        &bundle_thumbnail_path(&recovered.project_path),
        None,
    ) {
        tracing::warn!(path = %recovered.project_path.display(), %error, "failed to create recovered recording thumbnail");
    }

    Ok(recovered.project_path)
}

/// Existing targets and roots are canonicalized before containment is checked.
/// This keeps symlink escapes outside the allow-list while accepting Windows
/// editor paths whose canonical form has a `\\?\` prefix. A missing strict child
/// of an allowed root remains a no-op success.
pub fn delete_recording_directory_in(dirs: &[PathBuf], path: &Path) -> Result<(), String> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid path".to_string());
    }

    let canonical_dirs: Vec<_> = dirs
        .iter()
        .filter_map(|dir| dir.canonicalize().ok())
        .collect();
    if dirs.iter().chain(&canonical_dirs).any(|dir| path == dir) {
        return Err("Path is not inside a recordings directory".to_string());
    }

    let canonical_path = if path
        .try_exists()
        .map_err(|error| format!("Failed to inspect recording path: {error}"))?
    {
        let canonical_path = path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve recording path: {error}"))?;
        if canonical_dirs.iter().any(|dir| &canonical_path == dir)
            || !canonical_dirs
                .iter()
                .any(|dir| canonical_path.starts_with(dir))
        {
            return Err("Path is not inside a recordings directory".to_string());
        }
        Some(canonical_path)
    } else if dirs
        .iter()
        .chain(&canonical_dirs)
        .any(|dir| path.starts_with(dir))
    {
        None
    } else {
        return Err("Path is not inside a recordings directory".to_string());
    };

    if let Some(canonical_path) = canonical_path {
        let _thumbnails = crate::recording::hold_studio_thumbnail_writes().ok_or_else(|| {
            "Timed out waiting for the recording's thumbnail to finish writing".to_string()
        })?;
        std::fs::remove_dir_all(canonical_path)
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
/// An instant recording opens its `content` directory --
/// `commands.openFilePath` is `open <dir>` on macOS -- and anything else, or a
/// bundle with no `content` directory, is revealed in the file manager.
pub fn open_recording_folder(path: &Path, mode: RecordingMode, cx: &App) {
    let content = path.join("content");
    if mode == RecordingMode::Instant && content.is_dir() {
        open_with_system(&content, cx);
    } else {
        reveal_path(path, cx);
    }
}

// `std::fs::canonicalize` yields `\\?\` verbatim paths on Windows, which the
// shell APIs behind GPUI's reveal and open reject with E_INVALIDARG.
pub fn reveal_path(path: &Path, cx: &App) {
    cx.reveal_path(dunce::simplified(path));
}

pub fn open_with_system(path: &Path, cx: &App) {
    cx.open_with_system(dunce::simplified(path));
}

pub fn copy_file_to_path(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::copy(src, dest)
        .map(|_| ())
        .map_err(|error| format!("Failed to copy file: {error}"))
}

/// One `(png_path, ScreenshotMetaWithMetadata)` pair out of `list_screenshots`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenshotItem {
    /// The PNG inside the `.cap` bundle -- the listed path the Tauri command
    /// returns, and what copy / save / the screenshot editor take.
    pub path: PathBuf,
    /// The `.cap` directory itself -- what delete and reveal operate on.
    pub bundle: PathBuf,
    pub pretty_name: String,
    pub sort_time_millis: f64,
    pub thumbnail: Option<PathBuf>,
    /// The thumbnail PNG's version (mtime plus length), so a row can tell a
    /// re-scan that found the same file from one whose screenshot was
    /// rewritten in place.
    pub thumbnail_version: Option<u128>,
}

/// Whether a library row can keep the image it already has for `item`.
///
/// The PNG path and its version both have to match, the previous row must have
/// finished decoding, and it must not already be waiting on a newer decode: a
/// row whose decode never landed (or was cancelled) still has to ask again.
pub(crate) fn screenshot_thumbnail_is_current(
    item: &ScreenshotItem,
    previous: Option<&ScreenshotItem>,
    previous_has_thumbnail: bool,
    previous_stale: bool,
) -> bool {
    !previous_stale
        && previous.is_some_and(|previous| {
            previous.thumbnail == item.thumbnail
                && previous.thumbnail_version.is_some()
                && previous.thumbnail_version == item.thumbnail_version
                && previous_has_thumbnail
        })
}

/// `list_screenshots` (`lib.rs:4055-4091`): `*.cap` directories only, and the
/// sort key is the PNG's timestamp rather than the directory's.
pub fn list_screenshots_in(dir: &Path) -> Vec<ScreenshotItem> {
    screenshot_items_in(dir).collect()
}

fn screenshot_items_in(dir: &Path) -> impl Iterator<Item = ScreenshotItem> {
    let mut bundles = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let bundle = entry.path();
            if bundle.extension().and_then(|ext| ext.to_str()) != Some("cap") || !bundle.is_dir() {
                continue;
            }
            if let Some((png, sort_time_millis)) = screenshot_png(&bundle) {
                bundles.push((bundle, png, sort_time_millis));
            }
        }
    }
    bundles.sort_by(|(_, _, a), (_, _, b)| b.total_cmp(a));
    bundles
        .into_iter()
        .filter_map(|(bundle, png, sort_time_millis)| {
            let meta = RecordingMeta::load_for_project(&bundle).ok()?;
            Some(ScreenshotItem {
                path: png.clone(),
                pretty_name: meta.pretty_name,
                sort_time_millis,
                thumbnail_version: source_version(&png),
                thumbnail: Some(png),
                bundle,
            })
        })
}

/// Whether a `.cap` directory is a screenshot rather than a recording. The
/// same rule `list_screenshots` uses, so the two never disagree on a bundle.
pub fn is_screenshot_bundle(bundle: &Path) -> bool {
    bundle.extension().and_then(|ext| ext.to_str()) == Some("cap")
        && bundle.is_dir()
        && screenshot_png(bundle).is_some()
}

fn screenshot_png(bundle: &Path) -> Option<(PathBuf, f64)> {
    let original = bundle.join("original.png");
    if let Ok(metadata) = original.metadata() {
        return Some((original, metadata_sort_time_millis(&metadata)));
    }
    let png = std::fs::read_dir(bundle)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| path.extension().and_then(|ext| ext.to_str()) == Some("png"))?;
    let sort_time_millis = media_sort_time_millis(&png);
    Some((png, sort_time_millis))
}

pub fn list_screenshots() -> Vec<ScreenshotItem> {
    list_screenshots_in(&screenshots_dir())
}

pub fn list_screenshots_limited(limit: usize) -> Vec<ScreenshotItem> {
    screenshot_items_in(&screenshots_dir())
        .take(limit)
        .collect()
}

/// Delete the `.cap` bundle that owns `path` (the PNG or the directory).
pub fn delete_screenshot(path: &Path) -> Result<(), String> {
    let bundle = if path.is_dir() {
        path.to_path_buf()
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Invalid path".to_string())?
    };

    if bundle
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Invalid path".to_string());
    }

    let screenshots = screenshots_dir();
    if !bundle.starts_with(&screenshots) {
        return Err("Path is not inside the screenshots directory".to_string());
    }

    if bundle.exists() {
        let canonical = bundle
            .canonicalize()
            .map_err(|error| format!("Failed to resolve screenshot path: {error}"))?;
        let canonical_root = screenshots
            .canonicalize()
            .map_err(|error| format!("Failed to resolve screenshots directory: {error}"))?;
        if !canonical.starts_with(&canonical_root) {
            return Err("Path is not inside the screenshots directory".to_string());
        }
        std::fs::remove_dir_all(&canonical)
            .map_err(|error| format!("Failed to delete screenshot: {error}"))?;
    }

    Ok(())
}

fn scan_screenshots(dir: &Path, out: &mut Vec<RecentItem>) {
    out.extend(
        screenshot_items_in(dir)
            .take(RECENT_MEDIA_LIMIT)
            .map(|item| RecentItem {
                kind: MediaKind::Screenshot,
                bundle: item.bundle,
                pretty_name: item.pretty_name,
                clip_count: 1,
                sort_time_millis: item.sort_time_millis,
                thumbnail_version: item.thumbnail_version,
                thumbnail: item.thumbnail,
                sharing: None,
            }),
    );
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
    scan_recordings(recording_dirs, &mut recordings);

    let mut merged = recordings;
    scan_screenshots(screenshots_dir, &mut merged);
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

/// Cached thumbnails re-encode at 80: `display.jpg` is itself a quality-75
/// JPEG, and at a few hundred pixels wide the double re-encode stays clean
/// while the biggest cache file lands around 25KB.
const THUMBNAIL_JPEG_QUALITY: u8 = 80;

/// Workers per [`spawn_decode_pool`]. The macOS dispatcher hands every spawn
/// to a GCD global queue and a decode never yields, so each worker occupies a
/// pool thread until the queue drains -- capped so a cold library scan cannot
/// crowd out the camera and recording tasks sharing that executor.
const MAX_DECODE_WORKERS: usize = 8;

/// Fan `jobs` out to the background executor through a bounded worker pool;
/// results come back over the receiver in completion order.
///
/// Callers keep the returned tasks alive while draining the receiver --
/// dropping them cancels whatever has not started, and dropping the receiver
/// stops each running worker after its current decode, the same
/// cancel-on-reassign contract the sequential await-per-item loops this
/// replaced had.
pub fn spawn_decode_pool<J, R>(
    executor: &gpui::BackgroundExecutor,
    jobs: Vec<J>,
    decode: impl Fn(J) -> Option<R> + Send + Sync + Clone + 'static,
) -> (Vec<gpui::Task<()>>, flume::Receiver<R>)
where
    J: Send + 'static,
    R: Send + 'static,
{
    spawn_decode_pool_limited(executor, jobs, MAX_DECODE_WORKERS, decode)
}

pub fn spawn_decode_pool_limited<J, R>(
    executor: &gpui::BackgroundExecutor,
    jobs: Vec<J>,
    max_workers: usize,
    decode: impl Fn(J) -> Option<R> + Send + Sync + Clone + 'static,
) -> (Vec<gpui::Task<()>>, flume::Receiver<R>)
where
    J: Send + 'static,
    R: Send + 'static,
{
    let (job_tx, job_rx) = flume::unbounded();
    for job in jobs {
        let _ = job_tx.send(job);
    }
    drop(job_tx);

    let (result_tx, result_rx) = flume::unbounded();
    let workers = std::thread::available_parallelism()
        .map_or(4, std::num::NonZeroUsize::get)
        .min(max_workers.max(1))
        .min(job_rx.len().max(1));
    let tasks = (0..workers)
        .map(|_| {
            let job_rx = job_rx.clone();
            let result_tx = result_tx.clone();
            let decode = decode.clone();
            executor.spawn(async move { drain_decode_jobs(&job_rx, &result_tx, decode) })
        })
        .collect();
    (tasks, result_rx)
}

fn drain_decode_jobs<J, R>(
    jobs: &flume::Receiver<J>,
    results: &flume::Sender<R>,
    decode: impl Fn(J) -> Option<R>,
) {
    while !results.is_disconnected()
        && let Ok(job) = jobs.try_recv()
    {
        if let Some(result) = decode(job) {
            let _ = results.send(result);
        }
    }
}

/// Where the shared downscaled-thumbnail cache lives: the OS cache dir under
/// this app's own identifier (cache data is regenerable, so it belongs where
/// backups and migration skip it), not the `so.cap.desktop` app-data dir both
/// apps share.
fn thumbnail_cache_dir() -> PathBuf {
    // Verification runs point CAP_GPUI_APP_DATA_DIR at a sandbox; a cache that
    // still wrote to the user's real one would leak state across runs.
    if std::env::var("CAP_GPUI_APP_DATA_DIR").is_ok_and(|dir| !dir.trim().is_empty()) {
        return crate::store::app_data_dir().join("thumbnail-cache");
    }
    dirs::cache_dir().map_or_else(
        || crate::store::app_data_dir().join("thumbnail-cache"),
        |base| base.join("so.cap.desktop.gpui").join("thumbnails"),
    )
}

fn source_mtime_nanos(path: &Path) -> Option<u128> {
    path.metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|elapsed| elapsed.as_nanos())
}

/// A source file's version: its mtime plus its length, so a rewrite that
/// preserves the timestamp but changes the length (`cp -p` of a re-encoded
/// file, `touch -r` after an edit) still invalidates the image a screenshot
/// library row is holding and misses the decode cache. A rewrite that
/// preserves both is undetectable without reading the file. The high and low
/// halves cannot overlap (mtime is well under 2^64 nanos, length is shifted
/// above it), so this is a lossless encoding rather than a hash.
fn source_version(path: &Path) -> Option<u128> {
    let metadata = path.metadata().ok()?;
    let mtime = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(mtime ^ ((metadata.len() as u128) << 64))
}

/// FNV-1a, spelled out because `DefaultHasher`'s algorithm is unspecified
/// across Rust releases and a silent change would orphan every cached file.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    hash
}

/// A recording bundle's pre-baked `screenshots/display.jpg`. Its cache can
/// live next to it: the Tauri app only ever touches that directory by exact
/// filename (`screenshots/display.jpg` at write and upload), never by listing
/// it -- the extension scans in both apps are over the *screenshot* bundle
/// root and the app-data screenshots dir, neither of which is this.
fn is_bundle_display(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == "display.jpg" || name == "preview.jpg")
        && path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "screenshots")
}

/// One cache entry for a downscaled thumbnail: `<dir>/<prefix>-<version>.jpg`.
///
/// The source's version (mtime plus length) is baked into the file name, so
/// freshness is exact-name existence -- no comparison logic, and a source
/// whose version changes simply misses. [`Self::store`] sweeps the stale
/// version variants after writing.
pub struct CacheSlot {
    dir: PathBuf,
    prefix: String,
    version: u128,
}

impl CacheSlot {
    /// The slot [`decode_thumbnail`] uses: bundle-local for a recording's
    /// `display.jpg` (survives the bundle moving, dies with the bundle),
    /// shared-dir keyed by path hash + target size for everything else --
    /// screenshot PNGs live in bundles both apps extension-scan, so extra
    /// files are not written there.
    fn for_source(source: &Path) -> Option<Self> {
        let version = source_version(source)?;
        if is_bundle_display(source) {
            return Some(Self {
                dir: source.parent()?.to_path_buf(),
                prefix: if source.file_name().is_some_and(|name| name == "preview.jpg") {
                    "preview-thumbnail".to_string()
                } else {
                    "thumbnail".to_string()
                },
                version,
            });
        }
        Some(Self {
            dir: thumbnail_cache_dir(),
            prefix: format!(
                "{:016x}-{THUMBNAIL_WIDTH}x{THUMBNAIL_HEIGHT}",
                fnv1a64(source.to_string_lossy().as_bytes())
            ),
            version,
        })
    }

    /// A shared-dir slot under an explicit key -- the wallpaper tiles use
    /// this, keyed by wallpaper id, because the id is stabler (and more
    /// debuggable in the cache dir) than a hash of whichever install's asset
    /// path resolved this run.
    pub fn keyed(source: &Path, prefix: String) -> Option<Self> {
        Some(Self {
            dir: thumbnail_cache_dir(),
            prefix,
            version: source_version(source)?,
        })
    }

    fn file(&self) -> PathBuf {
        self.dir
            .join(format!("{}-{:x}.jpg", self.prefix, self.version))
    }

    pub fn load(&self) -> Option<Arc<RenderImage>> {
        self.load_rgba().map(rgba_to_render_image)
    }

    fn load_rgba(&self) -> Option<image::RgbaImage> {
        let bytes = std::fs::read(self.file()).ok()?;
        let decoded = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).ok()?;
        Some(decoded.into_rgba8())
    }

    /// Best effort throughout: a cache that cannot be written (read-only
    /// bundle, full disk) just means the next run decodes again, and a
    /// half-written file a parallel reader sees fails its JPEG decode and
    /// falls through to a fresh decode-and-store.
    pub fn store(&self, rgba: &image::RgbaImage) {
        if std::fs::create_dir_all(&self.dir).is_err() {
            return;
        }
        let Ok(encoded) =
            cap_gpui_kernels::codec::encode_jpeg_rgba_as_rgb(rgba, THUMBNAIL_JPEG_QUALITY)
        else {
            return;
        };
        let file = self.file();
        // The prefix keeps two same-version slots (wallpapers installed in one
        // copy) from interleaving writes into one tmp file.
        let tmp = self.dir.join(format!(
            "{}-{:x}.{}.tmp",
            self.prefix,
            self.version,
            std::process::id()
        ));
        if std::fs::write(&tmp, &encoded).is_err() || std::fs::rename(&tmp, &file).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
        self.remove_stale_variants(&file);
    }

    /// Sweep the other `<prefix>-<hex>.jpg` version variants. The remainder must
    /// parse as bare hex so that one key can never delete another key's files
    /// when it happens to be a string prefix of it (`wallpaper-a-128` vs a
    /// hypothetical `wallpaper-a-128-128`), and so `display.jpg` next to a
    /// bundle-local slot is untouchable by construction.
    fn remove_stale_variants(&self, keep: &Path) {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return;
        };
        let prefix = format!("{}-", self.prefix);
        for entry in entries.flatten() {
            let path = entry.path();
            if path.as_path() == keep {
                continue;
            }
            let is_stale_variant = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.strip_prefix(&prefix))
                .and_then(|rest| rest.strip_suffix(".jpg"))
                .is_some_and(|hex| u128::from_str_radix(hex, 16).is_ok());
            if is_stale_variant {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
pub fn thumbnail_cache_file(source: &Path) -> Option<PathBuf> {
    CacheSlot::for_source(source).map(|slot| slot.file())
}

/// gpui's atlas takes BGRA; `image`'s RgbaImage is just the container (the
/// same swap gpui's own asset loader does after decoding).
pub fn rgba_to_render_image(mut rgba: image::RgbaImage) -> Arc<RenderImage> {
    cap_gpui_kernels::frame::swap_red_blue(&mut rgba);
    Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
        rgba
    )]))
}

/// Decode a pre-baked bundle thumbnail into a gpui image, through the
/// persistent cache: a warm hit decodes a ~20KB JPEG instead of the
/// native-resolution original, which is what makes a revisit of Recents
/// effectively instant.
///
/// The scale factor covers the card rather than fitting inside it, because the
/// element paints with `ObjectFit::Cover` (`object-cover` on the TSX's `<img>`)
/// and a contain-fit source would letterbox. Never upscales: a thumbnail
/// smaller than the card is handed over as-is and the element stretches it,
/// same as the browser would.
pub fn decode_thumbnail(path: &Path) -> Option<Arc<RenderImage>> {
    thumbnail_rgba(path).map(rgba_to_render_image)
}

/// [`decode_thumbnail`]'s pixels before the BGRA swap, through the same cache.
pub fn thumbnail_rgba(path: &Path) -> Option<image::RgbaImage> {
    let cache = CacheSlot::for_source(path);
    if let Some(rgba) = cache.as_ref().and_then(CacheSlot::load_rgba) {
        return Some(rgba);
    }

    let bytes = std::fs::read(path).ok()?;
    // Sniff rather than trust the extension: `list_screenshots` finds the
    // preview by extension scan, and a bundle could hold a mislabelled file.
    let format = image::guess_format(&bytes).ok()?;
    let (decoded, width, height) = if format == image::ImageFormat::Jpeg {
        crate::jpeg_thumbnail::decode_jpeg_thumbnail(&bytes, |width, height| {
            let (_, target_width, target_height) = crate::jpeg_thumbnail::cover_target(
                width,
                height,
                THUMBNAIL_WIDTH,
                THUMBNAIL_HEIGHT,
            );
            (target_width, target_height)
        })
        .or_else(|| {
            let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
            let dimensions = (decoded.width(), decoded.height());
            Some((decoded, dimensions.0, dimensions.1))
        })?
    } else {
        let decoded = image::load_from_memory_with_format(&bytes, format).ok()?;
        let dimensions = (decoded.width(), decoded.height());
        (decoded, dimensions.0, dimensions.1)
    };
    let (width, height) = (width.max(1), height.max(1));
    let (_, target_width, target_height) =
        crate::jpeg_thumbnail::cover_target(width, height, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    // Box sampling for the big ratios (one pass over a multi-megapixel
    // source, and at 8x down every output pixel averages a whole block);
    // Triangle when the sizes are close, where box would alias and costs
    // nothing to avoid.
    let rgba = match crate::jpeg_thumbnail::thumbnail_resize(
        decoded.width(),
        decoded.height(),
        target_width,
        target_height,
    ) {
        crate::jpeg_thumbnail::ThumbnailResize::Box => decoded
            .thumbnail_exact(target_width, target_height)
            .into_rgba8(),
        crate::jpeg_thumbnail::ThumbnailResize::Triangle => decoded
            .resize_exact(
                target_width,
                target_height,
                image::imageops::FilterType::Triangle,
            )
            .into_rgba8(),
        crate::jpeg_thumbnail::ThumbnailResize::Identity => decoded.into_rgba8(),
    };

    if let Some(cache) = &cache {
        cache.store(&rgba);
    }
    Some(rgba)
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
/// *first* video frame comes out and save it as a JPEG at the source's own
/// size (`size: None` at every call site, so a native-resolution JPEG, not a
/// thumbnail). Blocking; callers hand it to `spawn_blocking`.
pub fn create_screenshot(
    input: &Path,
    output: &Path,
    size: Option<(u32, u32)>,
) -> Result<(), String> {
    let frame = first_video_frame(input)?;
    let size = size.unwrap_or((frame.width(), frame.height()));
    let jpeg = match encode_mjpeg(&frame, size) {
        Some(jpeg) => jpeg,
        None => encode_rgb_jpeg(&frame, size)?,
    };
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let staged = output.with_extension(format!("jpg.tmp-{}", crate::store::new_uuid_v4()));
    std::fs::write(&staged, jpeg)
        .and_then(|()| std::fs::rename(&staged, output))
        .map_err(|e| {
            let _ = std::fs::remove_file(&staged);
            e.to_string()
        })
}

fn first_video_frame(input: &Path) -> Result<ffmpeg::frame::Video, String> {
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

    let mut frame = ffmpeg::frame::Video::empty();
    for (stream, packet) in ictx.packets() {
        if stream.index() != video_stream_index {
            continue;
        }
        decoder.send_packet(&packet).map_err(|e| e.to_string())?;
        if decoder.receive_frame(&mut frame).is_ok() {
            return Ok(frame);
        }
    }

    Err("Failed to create screenshot".to_string())
}

/// FFmpeg's MJPEG encoder takes the decoded YUV frame directly, so a 4K
/// thumbnail skips the RGB round trip and `image`'s much slower JPEG encoder.
/// 4:4:4 at qscale 4 keeps the unsubsampled layout of the quality-75 JPEG
/// `image` wrote, with at least its quality.
fn encode_mjpeg(frame: &ffmpeg::frame::Video, (width, height): (u32, u32)) -> Option<Vec<u8>> {
    const QSCALE: i32 = 4;
    let format = ffmpeg::format::Pixel::YUV444P;
    let codec = ffmpeg::codec::encoder::find(ffmpeg::codec::Id::MJPEG)?;
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        frame.format(),
        frame.width(),
        frame.height(),
        format,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .ok()?;
    write_full_range(&mut scaler)?;
    let mut yuv = ffmpeg::frame::Video::empty();
    scaler.run(frame, &mut yuv).ok()?;

    let mut encoder = ffmpeg::codec::context::Context::new_with_codec(codec)
        .encoder()
        .video()
        .ok()?;
    encoder.set_width(width);
    encoder.set_height(height);
    encoder.set_format(format);
    encoder.set_color_range(ffmpeg::color::Range::JPEG);
    encoder.set_time_base((1, 1));
    encoder.set_flags(ffmpeg::codec::Flags::QSCALE);
    encoder.set_global_quality(QSCALE * ffmpeg::ffi::FF_QP2LAMBDA);
    encoder.set_qmin(QSCALE);
    encoder.set_qmax(QSCALE);
    let mut encoder = encoder.open().ok()?;

    yuv.set_pts(Some(0));
    encoder.send_frame(&yuv).ok()?;
    encoder.send_eof().ok()?;
    let mut packet = ffmpeg::Packet::empty();
    encoder.receive_packet(&mut packet).ok()?;
    packet.data().map(<[u8]>::to_vec)
}

/// JPEG stores full-range YUV, while swscale writes limited range unless told
/// otherwise; the source keeps whatever range swscale detected for it.
fn write_full_range(scaler: &mut ffmpeg::software::scaling::context::Context) -> Option<()> {
    let mut inv_table = std::ptr::null_mut();
    let mut table = std::ptr::null_mut();
    let (mut src_range, mut dst_range) = (0, 0);
    let (mut brightness, mut contrast, mut saturation) = (0, 0, 0);
    unsafe {
        let context = scaler.as_mut_ptr();
        let read = ffmpeg::ffi::sws_getColorspaceDetails(
            context,
            &mut inv_table,
            &mut src_range,
            &mut table,
            &mut dst_range,
            &mut brightness,
            &mut contrast,
            &mut saturation,
        );
        (read >= 0
            && ffmpeg::ffi::sws_setColorspaceDetails(
                context, inv_table, src_range, table, 1, brightness, contrast, saturation,
            ) >= 0)
            .then_some(())
    }
}

/// The original path, for an FFmpeg build without the MJPEG encoder.
fn encode_rgb_jpeg(
    frame: &ffmpeg::frame::Video,
    (width, height): (u32, u32),
) -> Result<Vec<u8>, String> {
    let mut rgb_frame = ffmpeg::frame::Video::empty();
    ffmpeg::software::scaling::context::Context::get(
        frame.format(),
        frame.width(),
        frame.height(),
        ffmpeg::format::Pixel::RGB24,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(|e| e.to_string())?
    .run(frame, &mut rgb_frame)
    .map_err(|e| e.to_string())?;

    // The scaler's rows are padded to its own stride; the image buffer is
    // tight, so the copy is row by row.
    let row_bytes = width as usize * 3;
    let buffer = cap_gpui_kernels::frame::copy_rows(
        rgb_frame.data(0),
        row_bytes,
        rgb_frame.stride(0),
        height as usize,
        false,
    )
    .ok_or("Failed to create image from frame data")?;
    cap_gpui_kernels::codec::encode_jpeg_rgb(&buffer, width, height, 75).map_err(|e| e.to_string())
}

pub fn bundle_thumbnail_path(project_dir: &Path) -> PathBuf {
    project_dir.join("screenshots").join("display.jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wait long enough that the next file gets a later timestamp. Kernels
    /// stamp files from a coarse clock (one 4 to 10 ms tick), so a shorter
    /// sleep can leave two bundles tied and sorted in directory order.
    fn next_timestamp() {
        std::thread::sleep(std::time::Duration::from_millis(25));
    }

    #[test]
    fn decode_jobs_stop_once_nobody_takes_the_results() {
        let (job_tx, job_rx) = flume::unbounded();
        for job in 0..6_u32 {
            job_tx.send(job).unwrap();
        }
        let (result_tx, result_rx) = flume::unbounded();
        let receiver = std::cell::RefCell::new(Some(result_rx));
        let decoded = std::cell::RefCell::new(Vec::new());

        drain_decode_jobs(&job_rx, &result_tx, |job| {
            decoded.borrow_mut().push(job);
            if job == 2 {
                receiver.borrow_mut().take();
            }
            (job != 1).then_some(job)
        });

        assert_eq!(*decoded.borrow(), [0, 1, 2]);
        assert_eq!(job_rx.len(), 3);
    }

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

    fn psnr(jpeg: &[u8], screen: &image::RgbImage) -> f64 {
        let decoded = image::load_from_memory(jpeg).unwrap().into_rgb8();
        assert_eq!(decoded.dimensions(), screen.dimensions());
        let squared: f64 = decoded
            .as_raw()
            .iter()
            .zip(screen.as_raw())
            .map(|(&a, &b)| (f64::from(a) - f64::from(b)).powi(2))
            .sum();
        10.0 * (255.0_f64.powi(2) * screen.as_raw().len() as f64 / squared).log10()
    }

    /// `screen` as a recording would hand it over: limited-range BT.709 4:2:0.
    fn recorded_frame(screen: &image::RgbImage) -> ffmpeg::frame::Video {
        let (width, height) = screen.dimensions();
        let mut rgb = ffmpeg::frame::Video::new(ffmpeg::format::Pixel::RGB24, width, height);
        let stride = rgb.stride(0);
        for (row, pixels) in rgb
            .data_mut(0)
            .chunks_mut(stride)
            .zip(screen.as_raw().chunks(width as usize * 3))
        {
            row[..pixels.len()].copy_from_slice(pixels);
        }
        let mut scaler = ffmpeg::software::scaling::context::Context::get(
            ffmpeg::format::Pixel::RGB24,
            width,
            height,
            ffmpeg::format::Pixel::YUV420P,
            width,
            height,
            ffmpeg::software::scaling::flag::Flags::BILINEAR,
        )
        .unwrap();
        unsafe {
            let bt709 = ffmpeg::ffi::sws_getCoefficients(ffmpeg::ffi::SWS_CS_ITU709);
            let set = ffmpeg::ffi::sws_setColorspaceDetails(
                scaler.as_mut_ptr(),
                bt709,
                1,
                bt709,
                0,
                0,
                1 << 16,
                1 << 16,
            );
            assert!(set >= 0);
        }
        let mut frame = ffmpeg::frame::Video::empty();
        scaler.run(&rgb, &mut frame).unwrap();
        frame.set_color_space(ffmpeg::color::Space::BT709);
        frame.set_color_range(ffmpeg::color::Range::MPEG);
        frame
    }

    #[test]
    fn screenshot_is_written_with_the_mjpeg_encoder() {
        ffmpeg::init().unwrap();
        let root = temp_dir("mjpeg-screenshot");
        let source = root.join("display.mp4");
        std::fs::write(
            &source,
            include_bytes!("../../media-server/src/__tests__/fixtures/test-with-audio.mp4"),
        )
        .unwrap();
        let output = bundle_thumbnail_path(&root);

        create_screenshot(&source, &output, None).unwrap();

        let frame = first_video_frame(&source).unwrap();
        let written = std::fs::read(&output).unwrap();
        let size = (frame.width(), frame.height());
        assert_eq!(written, encode_mjpeg(&frame, size).unwrap());
        let decoded = image::load_from_memory_with_format(&written, image::ImageFormat::Jpeg);
        assert_eq!(decoded.unwrap().to_rgb8().dimensions(), size);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mjpeg_screenshot_is_at_least_as_close_to_the_screen() {
        ffmpeg::init().unwrap();
        let screen = image::RgbImage::from_fn(640, 360, |x, y| {
            let text = (x / 2 + y / 3) % 7 == 0 && y % 24 < 14;
            match (x / 160, text) {
                (0, _) => image::Rgb([61, 106, 242]),
                (_, true) => image::Rgb([212, 212, 212]),
                (3, false) => image::Rgb([(x - 480) as u8, 53, (y / 2) as u8 + 60]),
                _ => image::Rgb([30, 31, 34]),
            }
        });
        let frame = recorded_frame(&screen);
        let size = screen.dimensions();

        let mjpeg = psnr(&encode_mjpeg(&frame, size).unwrap(), &screen);
        let rgb = psnr(&encode_rgb_jpeg(&frame, size).unwrap(), &screen);

        assert!(mjpeg >= rgb, "mjpeg {mjpeg:.2} dB, rgb {rgb:.2} dB");
    }

    /// Each source is a video; a `.png` beside it with the same name is the
    /// screen it recorded, which both JPEGs are scored against.
    #[test]
    #[ignore = "needs CAP_SCREENSHOT_BENCH_SOURCES"]
    fn benchmark_create_screenshot() {
        ffmpeg::init().unwrap();
        let sources = std::env::var("CAP_SCREENSHOT_BENCH_SOURCES").unwrap();
        let median = |mut runs: Vec<f64>| {
            runs.sort_by(f64::total_cmp);
            runs[runs.len() / 2]
        };
        println!(
            "source,width,height,decode_ms,rgb_ms,mjpeg_ms,rgb_bytes,mjpeg_bytes,rgb_psnr,mjpeg_psnr"
        );
        for source in sources.split(',').map(Path::new) {
            let started = std::time::Instant::now();
            let frame = first_video_frame(source).unwrap();
            let decode = started.elapsed().as_secs_f64() * 1e3;
            let size = (frame.width(), frame.height());
            let rgb = || encode_rgb_jpeg(&frame, size).unwrap();
            let mjpeg = || encode_mjpeg(&frame, size).unwrap();
            let time = |encode: &dyn Fn() -> Vec<u8>| {
                let started = std::time::Instant::now();
                std::hint::black_box(encode());
                started.elapsed().as_secs_f64() * 1e3
            };
            let (mut rgb_runs, mut mjpeg_runs) = (Vec::new(), Vec::new());
            for run in 0..15 {
                if run % 2 == 0 {
                    rgb_runs.push(time(&rgb));
                    mjpeg_runs.push(time(&mjpeg));
                } else {
                    mjpeg_runs.push(time(&mjpeg));
                    rgb_runs.push(time(&rgb));
                }
            }
            let (rgb, mjpeg) = (rgb(), mjpeg());
            let screen = image::open(source.with_extension("png")).map(|png| png.into_rgb8());
            let score = |jpeg: &[u8]| {
                screen
                    .as_ref()
                    .map_or(String::new(), |screen| format!("{:.2}", psnr(jpeg, screen)))
            };
            println!(
                "{},{},{},{decode:.1},{:.1},{:.1},{},{},{},{}",
                source.display(),
                size.0,
                size.1,
                median(rgb_runs),
                median(mjpeg_runs),
                rgb.len(),
                mjpeg.len(),
                score(&rgb),
                score(&mjpeg),
            );
        }
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

    fn complete_m4s_fragment() -> Vec<u8> {
        let mut fragment = Vec::new();
        for name in [b"moof", b"mdat"] {
            fragment.extend_from_slice(&72u32.to_be_bytes());
            fragment.extend_from_slice(name);
            fragment.extend_from_slice(&[0; 64]);
        }
        fragment
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
            next_timestamp();
        }

        let items = recent_media_in(std::slice::from_ref(&recordings), &screenshots);
        assert_eq!(items.len(), RECENT_MEDIA_LIMIT, "capped at the limit");
        assert_eq!(items[0].pretty_name, "rec-11", "newest first");
        assert_eq!(
            items[8].pretty_name, "rec-03",
            "oldest kept is the 9th newest"
        );
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
        next_timestamp();
        write_screenshot_bundle(&screenshots, "middle-screenshot");
        next_timestamp();
        write_studio_bundle(&recordings, "new-recording", 3);

        let items = recent_media_in(std::slice::from_ref(&recordings), &screenshots);
        let names: Vec<&str> = items.iter().map(|item| item.pretty_name.as_str()).collect();
        assert_eq!(
            names,
            ["new-recording", "middle-screenshot", "old-recording"],
            "one ordering across both kinds"
        );
        assert_eq!(items[0].kind, MediaKind::Studio);
        assert_eq!(
            items[0].clip_count, 3,
            "multi-segment studio meta counts segments"
        );
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

        let items = recent_media_in(
            std::slice::from_ref(&recordings),
            &root.join("missing-screenshots"),
        );
        assert_eq!(items.len(), 1, "only the bundle with a meta is listed");
        assert_eq!(items[0].thumbnail.as_deref(), Some(thumbnail.as_path()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edited_thumbnails_take_precedence_and_change_the_library_revision() {
        let root = temp_dir("edited-thumbnail");
        let bundle = write_studio_bundle(&root, "edited", 1);
        let original = bundle_thumbnail_path(&bundle);
        std::fs::create_dir_all(original.parent().unwrap()).unwrap();
        std::fs::write(&original, b"original").unwrap();
        let before = list_recordings_in(std::slice::from_ref(&root)).remove(0);
        let preview = bundle.join("screenshots/preview.jpg");
        std::fs::write(&preview, b"edited preview").unwrap();
        let after = list_recordings_in(std::slice::from_ref(&root)).remove(0);
        assert_eq!(before.thumbnail.as_ref(), Some(&original));
        assert_eq!(after.thumbnail.as_ref(), Some(&preview));
        assert!(after.thumbnail_version.is_some());
        assert_ne!(before, after);
        let recent = recent_media_in(std::slice::from_ref(&root), &root.join("missing"));
        assert_eq!(recent[0].thumbnail.as_ref(), Some(&preview));
        assert_eq!(recent[0].thumbnail_version, after.thumbnail_version);
        std::fs::remove_dir_all(root).unwrap();
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

    #[test]
    fn bounded_recordings_fill_from_valid_bundles_across_directories() {
        let root = temp_dir("bounded-recordings");
        let active = root.join("active");
        let archived = root.join("archived");
        std::fs::create_dir_all(&active).unwrap();
        std::fs::create_dir_all(&archived).unwrap();
        write_studio_bundle(&active, "old-studio", 1);
        next_timestamp();
        write_studio_bundle(&archived, "new-studio", 3);
        next_timestamp();
        write_bundle(
            &active,
            "instant",
            r#"{"pretty_name":"Instant","sharing":null,"fps":30,"sample_rate":48000}"#,
        );
        next_timestamp();
        std::fs::create_dir_all(archived.join("missing-meta")).unwrap();
        write_bundle(&active, "corrupt-meta", "{ not json ");
        std::fs::write(archived.join("loose.mp4"), b"").unwrap();
        let dirs = [active, archived, root.join("missing-directory")];

        let full = list_recordings_in(&dirs);
        let bounded: Vec<_> = recording_items_in(&dirs).take(2).collect();
        assert_eq!(bounded, full[..2]);
        assert_eq!(bounded[0].pretty_name, "Instant");
        assert_eq!(bounded[1].pretty_name, "new-studio");
        assert_eq!(bounded[1].clip_count, 3);
        assert!(recording_items_in(&dirs).take(0).next().is_none());
        assert_eq!(recording_items_in(&dirs).take(20).collect::<Vec<_>>(), full);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_screenshots_match_the_full_listing_and_parse_lazily() {
        fn eager_listing(dir: &Path) -> Vec<ScreenshotItem> {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let bundle = entry.path();
                if !bundle.is_dir()
                    || bundle.extension().and_then(|ext| ext.to_str()) != Some("cap")
                {
                    continue;
                }
                let Ok(meta) = RecordingMeta::load_for_project(&bundle) else {
                    continue;
                };
                let Some(png) = std::fs::read_dir(&bundle)
                    .unwrap()
                    .flatten()
                    .find_map(|entry| {
                        let path = entry.path();
                        (path.extension().and_then(|ext| ext.to_str()) == Some("png"))
                            .then_some(path)
                    })
                else {
                    continue;
                };
                out.push(ScreenshotItem {
                    path: png.clone(),
                    pretty_name: meta.pretty_name,
                    sort_time_millis: media_sort_time_millis(&png),
                    thumbnail_version: source_version(&png),
                    thumbnail: Some(png),
                    bundle,
                });
            }
            out.sort_by(|a, b| b.sort_time_millis.total_cmp(&a.sort_time_millis));
            out
        }

        fn write_shot(dir: &Path, name: &str) -> PathBuf {
            write_bundle(
                dir,
                name,
                &format!(r#"{{"pretty_name":"{name}","sharing":null,"fps":0}}"#),
            )
        }

        let root = temp_dir("bounded-screenshots");
        let legacy = write_shot(&root, "legacy");
        std::fs::write(legacy.join("shot.png"), b"png").unwrap();
        write_shot(&root, "no-png");
        let not_a_bundle = root.join("not-a-bundle");
        std::fs::create_dir_all(&not_a_bundle).unwrap();
        std::fs::write(not_a_bundle.join("original.png"), b"png").unwrap();
        std::fs::write(root.join("loose.cap"), b"").unwrap();
        for i in 0..30 {
            next_timestamp();
            let bundle = write_shot(&root, &format!("shot-{:02}", (i * 7) % 30));
            std::fs::write(bundle.join("original.png"), b"png").unwrap();
        }
        next_timestamp();
        let tie_a = write_shot(&root, "tie-a");
        std::fs::write(tie_a.join("original.png"), b"png").unwrap();
        let tie_b = write_shot(&root, "tie-b");
        std::fs::hard_link(tie_a.join("original.png"), tie_b.join("original.png")).unwrap();
        next_timestamp();
        let corrupt = write_bundle(&root, "corrupt", "{ not json ");
        std::fs::write(corrupt.join("original.png"), b"png").unwrap();

        let full = list_screenshots_in(&root);
        assert_eq!(full, eager_listing(&root));
        assert_eq!(full.len(), 33);
        assert!(full.iter().all(|item| item.bundle != corrupt));
        let legacy_item = full.iter().find(|item| item.bundle == legacy).unwrap();
        assert_eq!(legacy_item.path, legacy.join("shot.png"));

        let read_dir_order: Vec<PathBuf> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        let read_dir_position = |bundle: &Path| {
            read_dir_order
                .iter()
                .position(|path| path == bundle)
                .unwrap()
        };
        let tie_time = |bundle: &Path| {
            full.iter()
                .find(|item| item.bundle == bundle)
                .unwrap()
                .sort_time_millis
        };
        assert_eq!(tie_time(&tie_a), tie_time(&tie_b));
        assert!(
            full.windows(2).all(|pair| {
                pair[0].sort_time_millis > pair[1].sort_time_millis
                    || (pair[0].sort_time_millis == pair[1].sort_time_millis
                        && read_dir_position(&pair[0].bundle) < read_dir_position(&pair[1].bundle))
            }),
            "newest first, equal timestamps keep directory order"
        );

        for limit in [0, 1, 9, 20, 100] {
            assert_eq!(
                screenshot_items_in(&root).take(limit).collect::<Vec<_>>(),
                full[..limit.min(full.len())],
                "limit {limit}"
            );
        }

        let mut lazy = screenshot_items_in(&root);
        let head: Vec<_> = lazy.by_ref().take(RECENT_MEDIA_LIMIT).collect();
        assert_eq!(head, full[..RECENT_MEDIA_LIMIT]);
        for item in &full[RECENT_MEDIA_LIMIT..] {
            std::fs::remove_file(item.bundle.join("recording-meta.json")).unwrap();
        }
        assert!(
            lazy.next().is_none(),
            "metas past the consumed prefix are read on demand"
        );

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[ignore = "manual filesystem benchmark; set CAP_GPUI_LIBRARY_BENCH_DIR and CAP_GPUI_LIBRARY_BENCH_MODE"]
    fn recording_scan_benchmark() {
        fn eager_scan(dirs: &[PathBuf]) -> Vec<RecordingItem> {
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

        let dirs = [PathBuf::from(
            std::env::var("CAP_GPUI_LIBRARY_BENCH_DIR")
                .expect("Set the benchmark library directory"),
        )];
        let eager = match std::env::var("CAP_GPUI_LIBRARY_BENCH_MODE").as_deref() {
            Ok("eager") => true,
            Ok("bounded") => false,
            _ => panic!("CAP_GPUI_LIBRARY_BENCH_MODE must be eager or bounded"),
        };
        let limit = std::env::var("CAP_GPUI_LIBRARY_BENCH_LIMIT")
            .unwrap_or_else(|_| RECENT_MEDIA_LIMIT.to_string())
            .parse::<usize>()
            .expect("The benchmark limit must be an integer");
        let scan = || {
            if eager {
                let mut items = eager_scan(&dirs);
                items.truncate(limit);
                return items;
            }
            recording_items_in(&dirs).take(limit).collect()
        };
        let mut expected = eager_scan(&dirs);
        expected.truncate(limit);
        assert_eq!(
            recording_items_in(&dirs).take(limit).collect::<Vec<_>>(),
            expected
        );

        for _ in 0..3 {
            drop(std::hint::black_box(scan()));
        }
        let mut samples = Vec::new();
        for _ in 0..15 {
            let started = std::time::Instant::now();
            let items = std::hint::black_box(scan());
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(items, expected);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "{}",
            serde_json::json!({
                "mode": if eager { "eager" } else { "bounded" },
                "limit": limit,
                "items": expected.len(),
                "samples": samples.len(),
                "median_ms": samples[samples.len() / 2],
                "p95_ms": samples[(samples.len() * 95).div_ceil(100) - 1],
            })
        );
    }

    /// Same-process old vs new benchmark for the startup recovery scan.
    ///
    /// Old is the pre-change implementation: `list_recordings_in` (a full
    /// `RecordingItem` per recording) followed by the recovery filter. New is
    /// `find_incomplete_recordings_in`, which filters on parsed metadata first.
    ///
    /// Set `CAP_GPUI_RECOVERY_BENCH_DIR` to measure a real library. Without it
    /// the benchmark generates 600 complete Studio + 300 complete Instant
    /// recordings, with thumbnails and saved upload state where real ones have
    /// them, plus four recoverable incomplete recordings, one pre-cutoff
    /// recording, one corrupt meta and one missing meta: 907 directories,
    /// 905 parsed recordings. Run with:
    ///
    /// `cargo test -p cap-desktop-gpui recovery_scan_benchmark -- --ignored --nocapture`
    #[test]
    #[ignore = "manual filesystem benchmark; set CAP_GPUI_RECOVERY_BENCH_DIR for a real library"]
    fn recovery_scan_benchmark() {
        fn write_complete_studio(recordings: &Path, index: usize) {
            let bundle = recordings.join(format!("complete-studio-{index:04}.cap"));
            std::fs::create_dir_all(&bundle).unwrap();
            let segment_count = if index % 5 == 0 { 3 } else { 1 };
            let segments: Vec<String> = (0..segment_count)
                .map(|segment| {
                    format!(
                        r#"{{"display":{{"path":"content/segments/segment-{segment}/display.mp4","fps":30}}}}"#
                    )
                })
                .collect();
            let sharing = if index % 4 == 0 {
                r#"{"id":"share","link":"https://cap.so/s/share"}"#
            } else {
                "null"
            };
            std::fs::write(
                bundle.join("recording-meta.json"),
                format!(
                    r#"{{"pretty_name":"Studio {index}","sharing":{sharing},"segments":[{}]}}"#,
                    segments.join(",")
                ),
            )
            .unwrap();
            if index % 3 == 0 {
                let screenshots = bundle.join("screenshots");
                std::fs::create_dir_all(&screenshots).unwrap();
                std::fs::write(
                    screenshots.join(if index % 6 == 0 {
                        "preview.jpg"
                    } else {
                        "display.jpg"
                    }),
                    b"thumbnail",
                )
                .unwrap();
            }
        }

        fn write_complete_instant(recordings: &Path, index: usize) {
            let bundle = recordings.join(format!("complete-instant-{index:04}.cap"));
            std::fs::create_dir_all(&bundle).unwrap();
            std::fs::write(
                bundle.join("recording-meta.json"),
                format!(
                    r#"{{"pretty_name":"Instant {index}","sharing":null,"fps":30,"sample_rate":48000}}"#
                ),
            )
            .unwrap();
            if index % 2 == 0 {
                let state = serde_json::json!({
                    "version": 1,
                    "video_id": format!("bench-{index}"),
                    "server_url": "https://cap.example.invalid",
                    "owner_id": null,
                    "kind": "Mp4",
                    "requested_audio": null,
                    "preserve_local": true,
                    "phase": "Verified",
                    "attempt_count": 0,
                    "last_error": null,
                    "next_retry_at": null,
                    "verification": null,
                    "receipt": null,
                });
                std::fs::write(
                    bundle.join("instant-upload.json"),
                    serde_json::to_vec(&state).unwrap(),
                )
                .unwrap();
            }
            if index % 3 == 1 {
                let screenshots = bundle.join("screenshots");
                std::fs::create_dir_all(&screenshots).unwrap();
                std::fs::write(screenshots.join("display.jpg"), b"thumbnail").unwrap();
            }
        }

        let from_env = std::env::var("CAP_GPUI_RECOVERY_BENCH_DIR").ok();
        let generated = from_env.is_none().then(|| temp_dir("recovery-bench"));
        let dirs = match (&from_env, &generated) {
            (Some(dir), _) => vec![PathBuf::from(dir)],
            (None, Some(root)) => {
                let recordings = root.join("recordings");
                std::fs::create_dir_all(&recordings).unwrap();
                for index in 0..600 {
                    write_complete_studio(&recordings, index);
                }
                for index in 0..300 {
                    write_complete_instant(&recordings, index);
                }
                for index in 0..2 {
                    write_incomplete_bundle(
                        &recordings,
                        &format!("incomplete-studio-{index}"),
                        &format!("Cap 2026-02-0{index} at 10.00.00"),
                        "InProgress",
                        true,
                    );
                }
                write_incomplete_bundle(
                    &recordings,
                    "remux-studio",
                    "Cap 2026-02-03 at 10.00.00",
                    "NeedsRemux",
                    true,
                );
                write_incomplete_instant_bundle(
                    &recordings,
                    "incomplete-instant",
                    "Cap 2026-02-04 at 10.00.00",
                    false,
                );
                write_incomplete_bundle(
                    &recordings,
                    "pre-cutoff",
                    "Cap 2025-12-31 at 10.00.00",
                    "InProgress",
                    true,
                );
                write_bundle(&recordings, "corrupt-meta", "{ not json ");
                std::fs::create_dir_all(recordings.join("missing-meta")).unwrap();
                assert_eq!(
                    std::fs::read_dir(&recordings).unwrap().count(),
                    907,
                    "the generated fixture must keep its documented shape"
                );
                vec![recordings]
            }
            (None, None) => unreachable!(),
        };

        let expected = find_incomplete_recordings_in(&dirs, None);
        if from_env.is_none() {
            assert_eq!(
                expected.len(),
                4,
                "the generated fixture has four recoverable recordings"
            );
        }
        assert_eq!(
            find_incomplete_recordings_by_full_listing(&dirs, None),
            expected,
            "both implementations must agree before timing"
        );

        let old = || find_incomplete_recordings_by_full_listing(&dirs, None);
        let new = || find_incomplete_recordings_in(&dirs, None);
        let time = |scan: &dyn Fn() -> Vec<IncompleteRecordingItem>| {
            let started = std::time::Instant::now();
            let items = std::hint::black_box(scan());
            let millis = started.elapsed().as_secs_f64() * 1000.0;
            assert_eq!(items, expected);
            millis
        };

        for _ in 0..3 {
            std::hint::black_box(old());
            std::hint::black_box(new());
        }
        let mut old_samples = Vec::new();
        let mut new_samples = Vec::new();
        for sample in 0..15 {
            // Alternate the order so neither side systematically warms the
            // directory and metadata caches for the other.
            let (old_ms, new_ms) = if sample % 2 == 0 {
                (time(&old), time(&new))
            } else {
                let new_ms = time(&new);
                let old_ms = time(&old);
                (old_ms, new_ms)
            };
            old_samples.push(old_ms);
            new_samples.push(new_ms);
        }
        old_samples.sort_by(f64::total_cmp);
        new_samples.sort_by(f64::total_cmp);
        let median = |samples: &[f64]| samples[samples.len() / 2];

        let recordings = scanned_recordings_in(&dirs).count();
        let complete = scanned_recordings_in(&dirs)
            .filter(|recording| recording.status() == RecordingStatus::Complete)
            .count();
        if from_env.is_none() {
            assert_eq!(recordings, 905, "the generated fixture parses 905 bundles");
            assert_eq!(
                complete, 900,
                "the generated fixture has 900 complete bundles"
            );
        }
        println!(
            "{}",
            serde_json::json!({
                "fixture": if from_env.is_some() { "env" } else { "generated" },
                "recordings": recordings,
                "complete_recordings": complete,
                "recovered_recordings": expected.len(),
                "samples": old_samples.len(),
                "old_median_ms": median(&old_samples),
                "new_median_ms": median(&new_samples),
                "speedup": median(&old_samples) / median(&new_samples),
            })
        );

        if let Some(root) = generated {
            std::fs::remove_dir_all(root).ok();
        }
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
        next_timestamp();
        write_bundle(
            &recordings,
            "studio-single",
            r#"{"pretty_name":"Studio single","sharing":null,"display":{"path":"content/display.mp4","fps":30}}"#,
        );
        next_timestamp();
        write_bundle(
            &recordings,
            "studio-failed",
            &format!(
                r#"{{"pretty_name":"Studio failed","sharing":null,"segments":[{segment}],"status":{{"status":"Failed","error":"encoder died"}}}}"#
            ),
        );
        next_timestamp();
        write_bundle(
            &recordings,
            "studio-remux",
            &format!(
                r#"{{"pretty_name":"Studio remux","sharing":null,"segments":[{segment}],"status":{{"status":"NeedsRemux"}}}}"#
            ),
        );
        next_timestamp();
        let instant_complete = write_bundle(
            &recordings,
            "instant-complete",
            r#"{"pretty_name":"Instant complete","sharing":null,"fps":30,"sample_rate":48000}"#,
        );
        std::fs::write(
            instant_complete.join("instant-upload.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "video_id": "listing-instant",
                "server_url": "https://cap.example.invalid",
                "owner_id": null,
                "kind": "Mp4",
                "requested_audio": null,
                "preserve_local": true,
                "phase": "Verified",
                "attempt_count": 0,
                "last_error": null,
                "next_retry_at": null,
                "verification": null,
                "receipt": null,
            }))
            .unwrap(),
        )
        .unwrap();
        next_timestamp();
        write_bundle(
            &recordings,
            "instant-progress",
            r#"{"pretty_name":"Instant in progress","sharing":null,"recording":true}"#,
        );
        next_timestamp();
        write_bundle(
            &recordings,
            "instant-failed",
            r#"{"pretty_name":"Instant failed","sharing":null,"error":"upload died"}"#,
        );
        // Corrupt bundles are skipped in silence, exactly as `if let Ok` does.
        std::fs::create_dir_all(recordings.join("empty-dir")).unwrap();
        write_bundle(&recordings, "unparseable", "{ not json ");
        std::fs::write(recordings.join("loose-file.mp4"), b"").unwrap();

        let items = list_recordings_in(std::slice::from_ref(&recordings));
        let names: Vec<&str> = items.iter().map(|item| item.pretty_name.as_str()).collect();
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
        assert!(
            multi.opens_editor(),
            "studio + Complete is the clickable row"
        );
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
        assert!(
            !remux.is_active(),
            "deferred finalization does not keep polling"
        );

        let complete = by_name("Instant complete");
        assert_eq!(complete.mode, RecordingMode::Instant);
        assert_eq!(complete.clip_count, 1, "an instant recording is one clip");
        assert_eq!(complete.status, RecordingStatus::Complete);
        assert!(
            complete.upload.is_some(),
            "the listing still reads saved instant upload state"
        );
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

    fn write_incomplete_bundle(
        recordings: &Path,
        name: &str,
        pretty_name: &str,
        status: &str,
        fragments: bool,
    ) -> PathBuf {
        let bundle = write_bundle(
            recordings,
            name,
            &format!(
                r#"{{"pretty_name":"{pretty_name}","sharing":null,"segments":[],"status":{{"status":"{status}"}}}}"#
            ),
        );
        if fragments {
            let display = bundle.join("content/segments/segment-0/display");
            let fragment = complete_m4s_fragment();
            std::fs::create_dir_all(&display).unwrap();
            std::fs::write(display.join("init.mp4"), vec![0u8; 128]).unwrap();
            std::fs::write(display.join("segment_001.m4s"), &fragment).unwrap();
            std::fs::write(
                display.join("manifest.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version": 5,
                    "type": "m4s_segments",
                    "init_segment": "init.mp4",
                    "segments": [{
                        "path": "segment_001.m4s",
                        "is_complete": true,
                        "file_size": fragment.len()
                    }]
                }))
                .unwrap(),
            )
            .unwrap();
        }
        bundle
    }

    fn write_incomplete_instant_bundle(
        recordings: &Path,
        name: &str,
        pretty_name: &str,
        recording: bool,
    ) -> PathBuf {
        let bundle = write_bundle(
            recordings,
            name,
            &format!(r#"{{"pretty_name":"{pretty_name}","sharing":null,"recording":{recording}}}"#),
        );
        let display = bundle.join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        std::fs::write(display.join("init.mp4"), [0; 8]).unwrap();
        std::fs::write(display.join("segment_001.m4s"), complete_m4s_fragment()).unwrap();
        bundle
    }

    /// The recovery scan before the lean path: list every recording (building
    /// every `RecordingItem`), then filter. This is the reference implementation
    /// production must agree with, and the "old" side of the benchmark.
    fn find_incomplete_recordings_by_full_listing(
        dirs: &[PathBuf],
        active_recording: Option<&Path>,
    ) -> Vec<IncompleteRecordingItem> {
        list_recordings_in(dirs)
            .into_iter()
            .filter(|item| {
                matches!(
                    item.status,
                    RecordingStatus::InProgress | RecordingStatus::NeedsRemux
                ) && active_recording != Some(item.path.as_path())
                    && is_recording_after_recovery_cutoff(&item.pretty_name, item.sort_time_millis)
            })
            .filter_map(|item| {
                if item.mode == RecordingMode::Instant {
                    let display = item.path.join("content/display");
                    if !display.join("init.mp4").is_file() {
                        return None;
                    }
                    let segment_count = std::fs::read_dir(display)
                        .ok()?
                        .filter_map(Result::ok)
                        .filter(|entry| RecoveryManager::is_m4s_complete(&entry.path()))
                        .count();
                    return (segment_count > 0).then_some(IncompleteRecordingItem {
                        project_path: item.path,
                        pretty_name: item.pretty_name,
                        segment_count,
                        estimated_duration_secs: 0.0,
                    });
                }
                let incomplete = RecoveryManager::inspect_recording(&item.path)?;
                (!incomplete.recoverable_segments.is_empty()).then_some(IncompleteRecordingItem {
                    project_path: item.path,
                    pretty_name: item.pretty_name,
                    segment_count: incomplete.recoverable_segments.len(),
                    estimated_duration_secs: incomplete.estimated_duration.as_secs_f64(),
                })
            })
            .collect()
    }

    fn recording_item_builds() -> usize {
        RECORDING_ITEM_BUILDS.with(std::cell::Cell::get)
    }

    #[test]
    fn lean_recovery_matches_the_full_listing_on_a_mixed_library() {
        let root = temp_dir("recovery-equivalence");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();

        // Created oldest first; the recovery scan's order is creation order
        // reversed, so the expected output below is the reverse of the
        // recoverable fixtures' creation order.
        let pre_cutoff = write_incomplete_bundle(
            &recordings,
            "pre-cutoff",
            "Cap 2025-12-31 at 23.59.59",
            "InProgress",
            true,
        );
        next_timestamp();
        let complete_studio = write_incomplete_bundle(
            &recordings,
            "complete-studio",
            "Cap 2026-01-02 at 10.00.00",
            "Complete",
            true,
        );
        next_timestamp();
        write_bundle(&recordings, "corrupt-meta", "{ not json ");
        next_timestamp();
        std::fs::create_dir_all(recordings.join("missing-meta")).unwrap();
        next_timestamp();
        let active = write_incomplete_bundle(
            &recordings,
            "active",
            "Cap 2026-01-05 at 10.00.00",
            "InProgress",
            true,
        );
        next_timestamp();
        let in_progress = write_incomplete_bundle(
            &recordings,
            "in-progress",
            "Cap 2026-01-01 at 10.00.00",
            "InProgress",
            true,
        );
        next_timestamp();
        let remux = write_incomplete_bundle(
            &recordings,
            "remux",
            "Cap 2026-01-04 at 10.00.00",
            "NeedsRemux",
            true,
        );
        next_timestamp();
        let instant = write_incomplete_instant_bundle(
            &recordings,
            "instant-incomplete",
            "Cap 2026-01-03 at 10.00.00",
            false,
        );
        next_timestamp();
        let complete_instant = write_incomplete_instant_bundle(
            &recordings,
            "complete-instant",
            "Cap 2026-01-06 at 10.00.00",
            false,
        );
        // Complete status with fragments still on disk: recovery must trust
        // the metadata and leave them alone.
        std::fs::write(
            complete_instant.join("recording-meta.json"),
            r#"{"pretty_name":"Cap 2026-01-06 at 10.00.00","sharing":null,"fps":30,"sample_rate":48000}"#,
        )
        .unwrap();
        next_timestamp();
        let unrecoverable = write_incomplete_bundle(
            &recordings,
            "unrecoverable",
            "Cap 2026-01-07 at 10.00.00",
            "InProgress",
            false,
        );

        let dirs = std::slice::from_ref(&recordings);
        let found = find_incomplete_recordings_in(dirs, Some(active.as_path()));
        let reference = find_incomplete_recordings_by_full_listing(dirs, Some(active.as_path()));
        assert_eq!(
            found, reference,
            "the lean scan must stay byte-for-byte equivalent to listing everything"
        );

        let names: Vec<&str> = found.iter().map(|item| item.pretty_name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Cap 2026-01-03 at 10.00.00",
                "Cap 2026-01-04 at 10.00.00",
                "Cap 2026-01-01 at 10.00.00",
            ],
            "newest first, with only the eligible recoverable recordings"
        );
        assert_eq!(
            found
                .iter()
                .map(|item| (item.project_path.clone(), item.segment_count))
                .collect::<Vec<_>>(),
            [
                (instant.clone(), 1),
                (remux.clone(), 1),
                (in_progress.clone(), 1),
            ]
        );
        assert!(
            found
                .iter()
                .find(|item| item.project_path == instant)
                .is_some_and(|item| item.estimated_duration_secs == 0.0),
            "an Instant recording reports its measured segment count and zero duration"
        );
        for excluded in [
            &pre_cutoff,
            &complete_studio,
            &complete_instant,
            &active,
            &unrecoverable,
        ] {
            assert!(
                !found.iter().any(|item| &item.project_path == excluded),
                "{} must not be recoverable",
                excluded.display()
            );
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_cutoff_is_strictly_after_2025() {
        assert!(!is_recording_after_recovery_cutoff(
            "Cap 2025-12-31 at 23.59.59",
            0.0
        ));
        assert!(is_recording_after_recovery_cutoff(
            "Cap 2026-01-01 at 00.00.00",
            0.0
        ));
        assert!(
            !is_recording_after_recovery_cutoff("Custom instant recording", 0.0),
            "a name without a date falls back to the sort time"
        );
    }

    #[test]
    fn recovery_skips_full_item_work_and_inspection_for_complete_recordings() {
        let root = temp_dir("recovery-lean");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();

        // The complete Studio bundle contains exactly the fragments that make
        // `inspect_recording` return a recoverable recording. The complete
        // Instant bundle contains the init + m4s fragments the Instant path
        // counts. Recovery must filter both out on metadata alone.
        let complete_studio = write_incomplete_bundle(
            &recordings,
            "complete-studio",
            "Cap 2026-01-10 at 10.00.00",
            "Complete",
            true,
        );
        let complete_instant = write_incomplete_instant_bundle(
            &recordings,
            "complete-instant",
            "Cap 2026-01-11 at 10.00.00",
            false,
        );
        std::fs::write(
            complete_instant.join("recording-meta.json"),
            r#"{"pretty_name":"Cap 2026-01-11 at 10.00.00","sharing":null,"fps":30,"sample_rate":48000}"#,
        )
        .unwrap();
        let in_progress = write_incomplete_bundle(
            &recordings,
            "in-progress",
            "Cap 2026-01-12 at 10.00.00",
            "InProgress",
            true,
        );
        let remux_instant = write_incomplete_instant_bundle(
            &recordings,
            "remux-instant",
            "Cap 2026-01-13 at 10.00.00",
            false,
        );

        let builds_before = recording_item_builds();
        let found = find_incomplete_recordings_in(std::slice::from_ref(&recordings), None);
        assert_eq!(
            recording_item_builds(),
            builds_before,
            "recovery must not construct a full RecordingItem, even for complete recordings"
        );

        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|item| item.project_path == in_progress));
        assert!(found.iter().any(|item| item.project_path == remux_instant));

        // Behavior preservation: `inspect_recording` creates `.recovery.lock`
        // in the bundle it examines (and leaves it there after unlocking), so
        // a complete recording without one was never inspected.
        assert!(in_progress.join(".recovery.lock").is_file());
        assert!(!complete_studio.join(".recovery.lock").exists());
        assert!(!complete_instant.join(".recovery.lock").exists());
        assert!(
            !remux_instant.join(".recovery.lock").exists(),
            "instant recovery reads fragments directly and never calls inspect_recording"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_scan_preserves_active_terminal_legacy_and_unrecoverable_recordings() {
        let _ = ffmpeg::init();
        let root = temp_dir("recovery-scan");
        let recordings = root.join("recordings");
        std::fs::create_dir_all(&recordings).unwrap();
        let eligible = write_incomplete_bundle(
            &recordings,
            "eligible",
            "Cap 2026-01-02 at 10.00.00",
            "InProgress",
            true,
        );
        let active = write_incomplete_bundle(
            &recordings,
            "active",
            "Cap 2026-01-03 at 10.00.00",
            "InProgress",
            true,
        );
        let remux = write_incomplete_bundle(
            &recordings,
            "remux",
            "Cap 2026-01-04 at 10.00.00",
            "NeedsRemux",
            true,
        );
        write_incomplete_bundle(
            &recordings,
            "legacy",
            "Cap 2025-12-31 at 10.00.00",
            "InProgress",
            true,
        );
        write_incomplete_bundle(
            &recordings,
            "terminal",
            "Cap 2026-01-05 at 10.00.00",
            "Complete",
            true,
        );
        let corrupt = write_incomplete_bundle(
            &recordings,
            "unrecoverable",
            "Cap 2026-01-06 at 10.00.00",
            "InProgress",
            false,
        );
        let corrupt_before = std::fs::read(corrupt.join("recording-meta.json")).unwrap();

        let found = find_incomplete_recordings_in(
            std::slice::from_ref(&recordings),
            Some(active.as_path()),
        );

        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|item| item.project_path == eligible));
        assert!(found.iter().any(|item| item.project_path == remux));
        assert!(found.iter().all(|item| item.segment_count == 1));
        assert_eq!(
            std::fs::read(corrupt.join("recording-meta.json")).unwrap(),
            corrupt_before
        );
        assert!(active.exists());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_instant_recordings_are_recoverable_but_active_recordings_are_excluded() {
        for recording in [false, true] {
            let root = temp_dir("instant-storage-recovery");
            let metadata = serde_json::json!({
                "pretty_name": "Custom instant recording",
                "sharing": null,
                "recording": recording,
            })
            .to_string();
            let bundle = write_bundle(&root, "deferred-instant", &metadata);
            let display = bundle.join("content/display");
            std::fs::create_dir_all(&display).unwrap();
            std::fs::write(display.join("init.mp4"), [0; 8]).unwrap();
            let fragment = complete_m4s_fragment();
            std::fs::write(display.join("segment_001.m4s"), &fragment).unwrap();
            std::fs::write(
                display.join("segment_002.m4s"),
                &fragment[..fragment.len() - 1],
            )
            .unwrap();
            let items = list_recordings_in(std::slice::from_ref(&root));
            if !recording {
                assert_eq!(items[0].status, RecordingStatus::NeedsRemux);
                assert!(!items[0].is_active());
            }
            let recoverable = find_incomplete_recordings_in(std::slice::from_ref(&root), None);
            assert_eq!(recoverable.len(), 1);
            assert_eq!(recoverable[0].project_path, bundle);
            assert_eq!(recoverable[0].segment_count, 1);
            assert!(
                find_incomplete_recordings_in(std::slice::from_ref(&root), Some(&bundle))
                    .is_empty()
            );
            assert!(display.join("segment_001.m4s").is_file());
            assert!(display.join("segment_002.m4s").is_file());
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn interrupted_instant_recordings_with_only_partial_fragments_are_not_recoverable() {
        let root = temp_dir("instant-partial-recovery");
        let metadata = serde_json::json!({
            "pretty_name": "Custom instant recording",
            "sharing": null,
            "recording": false,
        })
        .to_string();
        let bundle = write_bundle(&root, "deferred-instant", &metadata);
        let display = bundle.join("content/display");
        std::fs::create_dir_all(&display).unwrap();
        std::fs::write(display.join("init.mp4"), [0; 8]).unwrap();
        let fragment = complete_m4s_fragment();
        std::fs::write(
            display.join("segment_001.m4s"),
            &fragment[..fragment.len() - 1],
        )
        .unwrap();

        let recoverable = find_incomplete_recordings_in(std::slice::from_ref(&root), None);

        assert!(recoverable.is_empty());
        assert!(display.join("segment_001.m4s").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_rejects_paths_outside_the_recording_library() {
        let root = temp_dir("recovery-path");
        let recordings = root.join("recordings");
        let elsewhere = root.join("elsewhere");
        std::fs::create_dir_all(&recordings).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();

        let result = recover_incomplete_recording_in(std::slice::from_ref(&recordings), &elsewhere);

        assert_eq!(
            result,
            Err("Path is not inside a recordings directory".to_string())
        );
        assert!(elsewhere.is_dir());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn instant_recovery_preserves_live_recording_while_its_upload_lock_is_held() {
        fn snapshot(directory: &Path) -> std::collections::BTreeMap<PathBuf, Option<Vec<u8>>> {
            let mut entries = std::collections::BTreeMap::new();
            let mut pending = vec![directory.to_path_buf()];
            while let Some(parent) = pending.pop() {
                for entry in std::fs::read_dir(parent).unwrap() {
                    let entry = entry.unwrap();
                    let path = entry.path();
                    let relative = path.strip_prefix(directory).unwrap().to_path_buf();
                    if entry.file_type().unwrap().is_dir() {
                        assert!(entries.insert(relative, None).is_none());
                        pending.push(path);
                    } else {
                        assert!(
                            entries
                                .insert(relative, Some(std::fs::read(path).unwrap()))
                                .is_none()
                        );
                    }
                }
            }
            entries
        }

        let root = temp_dir("instant-recovery-owned");
        let recordings = root.join("recordings");
        let metadata = serde_json::json!({
            "pretty_name": "Live instant recording",
            "sharing": null,
            "recording": true,
        })
        .to_string();
        let bundle = write_bundle(&recordings, "live-instant", &metadata);
        for (relative, contents) in [
            (
                "content/display/init.mp4",
                b"unfinished video init".as_slice(),
            ),
            (
                "content/display/segment_001.m4s",
                b"unfinished video fragment",
            ),
            (
                "content/audio/segment_001.m4s",
                b"unfinished audio fragment",
            ),
            ("content/output.mp4", b"existing partial output"),
        ] {
            let path = bundle.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, contents).unwrap();
        }
        let before = snapshot(&bundle);
        let owner = UploadLock::acquire(&bundle).unwrap();

        let result = recover_incomplete_recording_in(std::slice::from_ref(&recordings), &bundle);

        assert_eq!(
            result,
            Err("Could not lock the instant recording for recovery: Another upload owns this recording".to_string())
        );
        assert_eq!(snapshot(&bundle), before);
        assert!(matches!(
            RecordingMeta::load_for_project(&bundle).unwrap().inner,
            RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true })
        ));

        drop(owner);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_restores_interrupted_real_recording_when_fixture_is_provided() {
        let Ok(source) = std::env::var("CAP_GPUI_RECOVERY_FIXTURE") else {
            return;
        };
        let _ = ffmpeg::init();
        let source = PathBuf::from(source);
        let root = temp_dir("recovery-real");
        let recordings = root.join("recordings");
        let copy = recordings.join("interrupted.cap");
        std::fs::create_dir_all(&copy).unwrap();

        let mut pending = vec![(source, copy.clone())];
        while let Some((from, to)) = pending.pop() {
            for entry in std::fs::read_dir(from).unwrap() {
                let entry = entry.unwrap();
                let destination = to.join(entry.file_name());
                if entry.file_type().unwrap().is_dir() {
                    std::fs::create_dir_all(&destination).unwrap();
                    pending.push((entry.path(), destination));
                } else {
                    std::fs::copy(entry.path(), destination).unwrap();
                }
            }
        }

        let mut interrupted = RecordingMeta::load_for_project(&copy).unwrap();
        if matches!(interrupted.inner, RecordingMetaInner::Instant(_)) {
            interrupted.inner =
                RecordingMetaInner::Instant(InstantRecordingMeta::InProgress { recording: true });
            interrupted.save_for_project().unwrap();
        }

        let dirs = std::slice::from_ref(&recordings);
        let found = find_incomplete_recordings_in(dirs, None);
        assert_eq!(found.len(), 1);
        assert!(found[0].segment_count > 0);

        let recovered = recover_incomplete_recording_in(dirs, &copy).unwrap();
        let meta = RecordingMeta::load_for_project(&recovered).unwrap();

        match &meta.inner {
            RecordingMetaInner::Studio(studio) => {
                assert!(matches!(studio.status(), StudioRecordingStatus::Complete));
                assert!(
                    recovered
                        .join("content/segments/segment-0/display.mp4")
                        .is_file()
                );
                assert!(recovered.join("project-config.json").is_file());
            }
            RecordingMetaInner::Instant(InstantRecordingMeta::Complete { fps, sample_rate }) => {
                assert_eq!(*fps, 30);
                assert_eq!(*sample_rate, Some(48_000));
                let output = recovered.join("content/output.mp4");
                assert!(output.is_file());
                assert!(ffmpeg::format::input(&output).unwrap().duration() >= 2_900_000);
                assert!(recovered.join("content/display/segment_001.m4s").is_file());
                assert!(recovered.join("content/audio/segment_001.m4s").is_file());
                let status = std::process::Command::new("ffmpeg")
                    .args(["-v", "error", "-xerror", "-i"])
                    .arg(output)
                    .args(["-f", "null", "-"])
                    .status()
                    .unwrap();
                assert!(status.success());
            }
            _ => panic!("Recovery left incomplete metadata"),
        }
        assert!(bundle_thumbnail_path(&recovered).is_file());
        assert!(find_incomplete_recordings_in(dirs, None).is_empty());

        std::fs::remove_dir_all(root).unwrap();
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
        let symlink = std::os::unix::fs::symlink(&victim, &escape);
        #[cfg(windows)]
        let symlink = std::os::windows::fs::symlink_dir(&victim, &escape);
        match symlink {
            Ok(()) => assert_eq!(
                delete_recording_directory_in(&dirs, &escape),
                Err("Path is not inside a recordings directory".to_string()),
                "canonicalizing catches the symlink the prefix check let through"
            ),
            #[cfg(windows)]
            Err(error) if error.raw_os_error() == Some(1314) => {
                eprintln!("Skipping symlink assertion: Windows symlink privilege unavailable");
            }
            Err(error) => panic!("Failed to create symlink fixture: {error}"),
        }
        assert!(
            victim.join("recording.mp4").is_file(),
            "the symlink's target is untouched"
        );

        assert_eq!(
            delete_recording_directory_in(&dirs, &recordings),
            Err("Path is not inside a recordings directory".to_string())
        );
        assert!(recordings.is_dir(), "the recordings root survives");

        // And the happy path still deletes.
        assert_eq!(delete_recording_directory_in(&dirs, &bundle), Ok(()));
        assert!(!bundle.exists());
        // A path that is already gone is a no-op success, as it is there.
        assert_eq!(delete_recording_directory_in(&dirs, &bundle), Ok(()));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_rejects_an_allowed_root_nested_in_another_allowed_root() {
        let root = temp_dir("delete-nested-roots");
        let recordings = root.join("recordings");
        let nested = recordings.join("nested");
        let bundle = write_studio_bundle(&nested, "keep-me", 1);
        let dirs = [recordings, nested.clone()];

        for path in [&nested, &nested.canonicalize().unwrap()] {
            assert_eq!(
                delete_recording_directory_in(&dirs, path),
                Err("Path is not inside a recordings directory".to_string())
            );
            assert!(bundle.is_dir());
        }

        assert_eq!(delete_recording_directory_in(&dirs, &bundle), Ok(()));
        assert!(nested.is_dir());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn delete_accepts_a_canonical_windows_project_under_a_raw_root() {
        let root = temp_dir("delete-canonical-windows");
        let recordings = root.join("recordings");
        let bundle = write_studio_bundle(&recordings, "delete-me", 1);
        let canonical_bundle = bundle.canonicalize().unwrap();

        assert_eq!(
            delete_recording_directory_in(std::slice::from_ref(&recordings), &canonical_bundle),
            Ok(())
        );
        assert!(!canonical_bundle.exists());
        assert_eq!(
            delete_recording_directory_in(&[recordings], &canonical_bundle),
            Ok(())
        );

        std::fs::remove_dir_all(root).ok();
    }

    // -- The thumbnail cache ---------------------------------------------

    #[test]
    fn fnv1a64_matches_the_reference_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x85944171f73967e8);
    }

    #[test]
    fn a_bundle_display_caches_next_to_itself_and_a_png_does_not() {
        let root = temp_dir("slot");
        let screenshots = root.join("bundle.cap").join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        let display = screenshots.join("display.jpg");
        std::fs::write(&display, b"jpeg bytes").unwrap();

        let slot = CacheSlot::for_source(&display).unwrap();
        let file = slot.file();
        assert_eq!(file.parent(), Some(screenshots.as_path()));
        let name = file.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("thumbnail-") && name.ends_with(".jpg"));

        let png = root.join("shot.png");
        std::fs::write(&png, b"png bytes").unwrap();
        let shared = CacheSlot::for_source(&png).unwrap();
        assert_ne!(
            shared.file().parent(),
            Some(root.as_path()),
            "a non-display source caches in the shared dir, not beside itself"
        );
        assert!(
            shared
                .prefix
                .contains(&format!("{THUMBNAIL_WIDTH}x{THUMBNAIL_HEIGHT}")),
            "the target size is part of the key, so a size change re-decodes"
        );

        assert!(
            CacheSlot::for_source(&root.join("missing.jpg")).is_none(),
            "no version, no slot"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn store_sweeps_stale_version_variants_but_not_lookalike_keys() {
        let root = temp_dir("sweep");
        let rgba = image::RgbaImage::from_pixel(8, 6, image::Rgba([200, 40, 40, 255]));

        let stale = CacheSlot {
            dir: root.clone(),
            prefix: "wallpaper-a-128".to_string(),
            version: 1,
        };
        stale.store(&rgba);
        assert!(stale.file().is_file());

        // A different key that the sweep prefix happens to be a string prefix
        // of, and a non-hex sibling; neither may be swept.
        let lookalike = root.join("wallpaper-a-128-128-ff.jpg");
        std::fs::write(&lookalike, b"other key").unwrap();
        let display = root.join("display.jpg");
        std::fs::write(&display, b"not a variant").unwrap();

        let fresh = CacheSlot {
            dir: root.clone(),
            prefix: "wallpaper-a-128".to_string(),
            version: 2,
        };
        fresh.store(&rgba);

        assert!(!stale.file().exists(), "the old version variant is swept");
        assert!(fresh.file().is_file());
        assert!(lookalike.is_file(), "another key's file survives the sweep");
        assert!(display.is_file());

        let loaded = fresh.load().expect("a stored thumbnail loads back");
        assert_eq!(loaded.size(0).width.0, 8);
        assert_eq!(loaded.size(0).height.0, 6);
        let missing = CacheSlot {
            dir: root.clone(),
            prefix: "wallpaper-a-128".to_string(),
            version: 3,
        };
        assert!(
            missing.load().is_none(),
            "a missing version variant is a miss, not a fallback"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn decode_thumbnail_writes_reuses_and_invalidates_the_bundle_cache() {
        let root = temp_dir("decode");
        let screenshots = root.join("bundle.cap").join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        let display = screenshots.join("display.jpg");
        image::RgbImage::from_pixel(800, 600, image::Rgb([10, 120, 240]))
            .save_with_format(&display, image::ImageFormat::Jpeg)
            .unwrap();

        let cached_thumbs = || -> Vec<PathBuf> {
            std::fs::read_dir(&screenshots)
                .unwrap()
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("thumbnail-"))
                })
                .collect()
        };

        assert!(decode_thumbnail(&display).is_some());
        let first = cached_thumbs();
        assert_eq!(first.len(), 1, "one decode, one cached variant");
        // 800x600 covering 392x224: scale = 392/800, so 392x294.
        assert_eq!(image::image_dimensions(&first[0]).unwrap(), (392, 294));

        let image = decode_thumbnail(&display).expect("the warm path decodes the cache");
        assert_eq!(image.size(0).width.0, 392);
        assert_eq!(image.size(0).height.0, 294);
        assert_eq!(cached_thumbs(), first, "a hit rewrites nothing");

        // A regenerated display.jpg (new mtime) misses and re-caches.
        std::thread::sleep(std::time::Duration::from_millis(20));
        image::RgbImage::from_pixel(600, 600, image::Rgb([240, 120, 10]))
            .save_with_format(&display, image::ImageFormat::Jpeg)
            .unwrap();
        assert!(decode_thumbnail(&display).is_some());
        let second = cached_thumbs();
        assert_eq!(second.len(), 1, "the stale variant is swept");
        assert_ne!(second, first);
        // 600x600 covering 392x224: scale = 392/600, so 392x392.
        assert_eq!(image::image_dimensions(&second[0]).unwrap(), (392, 392));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_same_mtime_length_change_misses_the_decode_cache() {
        let root = temp_dir("same-mtime-cache");
        let screenshots = root.join("bundle.cap").join("screenshots");
        std::fs::create_dir_all(&screenshots).unwrap();
        let display = screenshots.join("display.jpg");
        image::RgbImage::from_pixel(800, 600, image::Rgb([10, 120, 240]))
            .save_with_format(&display, image::ImageFormat::Jpeg)
            .unwrap();
        let modified = std::fs::metadata(&display).unwrap().modified().unwrap();
        let first_len = std::fs::metadata(&display).unwrap().len();

        assert!(decode_thumbnail(&display).is_some());
        let first = thumbnail_cache_file(&display).expect("a cache slot");
        assert_eq!(image::image_dimensions(&first).unwrap(), (392, 294));

        // Rewrite the pixels, then put the old timestamp back: the only
        // difference the scan can see is the length.
        image::RgbImage::from_pixel(600, 600, image::Rgb([240, 120, 10]))
            .save_with_format(&display, image::ImageFormat::Jpeg)
            .unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&display)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_ne!(
            std::fs::metadata(&display).unwrap().len(),
            first_len,
            "the test needs a length change"
        );

        assert!(decode_thumbnail(&display).is_some());
        let second = thumbnail_cache_file(&display).expect("a cache slot");
        assert_ne!(
            second, first,
            "a length change at the same mtime is a new cache slot"
        );
        assert_eq!(
            image::image_dimensions(&second).unwrap(),
            (392, 392),
            "the new pixels are decoded, not the old cache entry"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn screenshot_thumbnail_reuse_tracks_the_png_version() {
        let item = ScreenshotItem {
            path: PathBuf::from("/lib/shot.cap/original.png"),
            bundle: PathBuf::from("/lib/shot.cap"),
            pretty_name: "shot".into(),
            sort_time_millis: 1.,
            thumbnail: Some(PathBuf::from("/lib/shot.cap/original.png")),
            thumbnail_version: Some(1),
        };
        assert!(!screenshot_thumbnail_is_current(&item, None, false, false));
        assert!(
            !screenshot_thumbnail_is_current(&item, Some(&item), false, false),
            "a row whose decode never landed still asks for one"
        );
        assert!(
            !screenshot_thumbnail_is_current(&item, Some(&item), true, true),
            "a row already waiting on a newer decode asks again"
        );
        assert!(screenshot_thumbnail_is_current(
            &item,
            Some(&item),
            true,
            false
        ));

        let mut changed = item.clone();
        changed.thumbnail_version = Some(2);
        assert!(
            !screenshot_thumbnail_is_current(&changed, Some(&item), true, false),
            "a rewritten png is a new version"
        );

        let mut moved = item.clone();
        moved.thumbnail = Some(PathBuf::from("/lib/other.cap/original.png"));
        assert!(
            !screenshot_thumbnail_is_current(&moved, Some(&item), true, false),
            "a different png path is a new source"
        );

        let mut unknown = item.clone();
        unknown.thumbnail_version = None;
        assert!(
            !screenshot_thumbnail_is_current(&unknown, Some(&unknown), true, false),
            "an unknown version cannot be reused"
        );
    }

    #[test]
    fn screenshot_items_stamp_the_png_they_thumbnail() {
        let root = temp_dir("screenshot-version");
        let bundle = write_screenshot_bundle(&root, "shot");
        let png = bundle.join("shot.png");
        let items = list_screenshots_in(&root);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].thumbnail.as_deref(), Some(png.as_path()));
        assert_eq!(items[0].thumbnail_version, source_version(&png));

        let modified = std::fs::metadata(&png).unwrap().modified().unwrap();
        let original_len = std::fs::metadata(&png).unwrap().len();
        std::fs::write(&png, b"new png with a different length").unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&png)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert_ne!(
            std::fs::metadata(&png).unwrap().len(),
            original_len,
            "the test needs a length change"
        );
        let rewritten = list_screenshots_in(&root);
        assert_eq!(rewritten.len(), 1);
        assert_ne!(
            rewritten[0].thumbnail_version, items[0].thumbnail_version,
            "a length change bumps the version even at the same mtime"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    /// The library panel drops and rebuilds its rows on every open; before
    /// the reconcile, that re-decoded all 20 thumbnails (a native PNG decode
    /// on the first pass, then a cache JPEG decode plus an atlas upload).
    #[test]
    #[ignore = "manual screenshot thumbnail reuse benchmark"]
    fn benchmark_screenshot_thumbnail_reuse() {
        let root = temp_dir("screenshot-bench");
        let dir = root.join("screenshots");
        std::fs::create_dir_all(&dir).unwrap();
        let source = root.join("source.png");
        image::RgbaImage::from_pixel(3024, 1964, image::Rgba([120, 90, 60, 255]))
            .save_with_format(&source, image::ImageFormat::Png)
            .unwrap();
        for i in 0..20 {
            let bundle = write_screenshot_bundle(&dir, &format!("shot-{i:02}"));
            std::fs::copy(&source, bundle.join("shot.png")).unwrap();
        }
        let items = list_screenshots_in(&dir);
        assert_eq!(items.len(), 20);
        let thumbnails: Vec<_> = items
            .iter()
            .filter_map(|item| item.thumbnail.as_deref())
            .collect();
        assert_eq!(thumbnails.len(), 20);
        for path in &thumbnails {
            if let Some(cache) = thumbnail_cache_file(path) {
                std::fs::remove_file(cache).ok();
            }
        }

        let cold_start = std::time::Instant::now();
        for path in &thumbnails {
            assert!(decode_thumbnail(path).is_some());
        }
        let cold = cold_start.elapsed();

        let warm_start = std::time::Instant::now();
        for path in &thumbnails {
            assert!(decode_thumbnail(path).is_some());
        }
        let warm = warm_start.elapsed();

        println!(
            "screenshots=20 first_open_cold={:.1}ms reopen_warm={:.1}ms",
            cold.as_secs_f64() * 1e3,
            warm.as_secs_f64() * 1e3,
        );

        for path in &thumbnails {
            if let Some(cache) = thumbnail_cache_file(path) {
                std::fs::remove_file(cache).ok();
            }
        }
        std::fs::remove_dir_all(root).ok();
    }
}
