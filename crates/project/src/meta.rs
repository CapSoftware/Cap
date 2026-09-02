use either::Either;
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    io::Write,
    path::{Path, PathBuf},
};
use tracing::{debug, info, warn};

use crate::{
    CaptionsData, CursorEvents, CursorImage, KeyboardEvents, ProjectConfiguration, XY,
    cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VideoMeta {
    #[specta(type = String)]
    pub path: RelativePathBuf,
    #[serde(default = "legacy_static_video_fps")]
    pub fps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

fn legacy_static_video_fps() -> u32 {
    30
}

/// Where the recording device's physical notch sits within the captured video.
///
/// macOS captures the pixels behind the notch, so without this the recording
/// shows an unbroken menu bar where the recorder saw a cutout. Fractions of the
/// captured frame rather than of the display, so area recordings, which are
/// cropped at capture time, need no extra context to interpret.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub struct DisplayNotch {
    /// Distance from the left edge of the video to the notch.
    pub x: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioMeta {
    #[specta(type = String)]
    pub path: RelativePathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gap_summary: Option<AudioGapSummary>,
}

/// Overlap-trim accounting captured by the recorder's audio gap tracker, persisted so the
/// editor can compensate for stale-startup audio drift from typed data instead of scraping
/// the recording log. See `cap-editor`'s `audio_timing_repair_offset`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct AudioGapSummary {
    /// Total audio trimmed from overlapping frames over the whole recording, in milliseconds.
    pub total_overlap_trimmed_ms: u32,
    /// Startup-window trim used for stale-startup repair, excluding mid-recording trims.
    #[serde(default)]
    pub startup_overlap_trimmed_ms: u32,
    /// Number of whole audio frames dropped because they fully overlapped the committed timeline.
    pub overlap_dropped_frames: u32,
    /// Subset of `overlap_dropped_frames` that dropped within the first few frames — the
    /// signature of a stale buffered burst at capture start.
    pub startup_overlap_drops: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SharingMeta {
    pub id: String,
    pub link: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum Platform {
    MacOS,
    Windows,
    Linux,
}

impl Default for Platform {
    fn default() -> Self {
        #[cfg(windows)]
        return Self::Windows;

        #[cfg(target_os = "macos")]
        return Self::MacOS;

        #[cfg(target_os = "linux")]
        return Self::Linux;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingMeta {
    #[serde(default)]
    pub platform: Option<Platform>,
    #[serde(skip_serializing, default)]
    pub project_path: PathBuf,
    pub pretty_name: String,
    #[serde(default)]
    pub sharing: Option<SharingMeta>,
    #[serde(flatten)]
    pub inner: RecordingMetaInner,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload: Option<UploadMeta>,
}

#[derive(Deserialize, Serialize, Clone, Type, Debug)]
pub struct S3UploadMeta {
    pub id: String,
}

#[derive(Clone, Serialize, Deserialize, specta::Type, Debug)]
pub struct VideoUploadInfo {
    pub id: String,
    pub link: String,
    pub config: S3UploadMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "state")]
pub enum UploadMeta {
    MultipartUpload {
        video_id: String,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
    },
    SinglePartUpload {
        video_id: String,
        recording_dir: PathBuf,
        file_path: PathBuf,
        screenshot_path: PathBuf,
    },
    SegmentUpload {
        video_id: String,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
    },
    Failed {
        error: String,
    },
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum RecordingMetaInner {
    Studio(Box<StudioRecordingMeta>),
    Instant(InstantRecordingMeta),
}

impl specta::Flatten for RecordingMetaInner {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum InstantRecordingMeta {
    InProgress { recording: bool },
    Failed { error: String },
    Complete { fps: u32, sample_rate: Option<u32> },
}

impl RecordingMeta {
    pub fn path(&self, relative: &RelativePathBuf) -> PathBuf {
        relative.to_path(&self.project_path)
    }

    pub fn load_for_project(project_path: &Path) -> Result<Self, Box<dyn Error>> {
        let meta_path = project_path.join("recording-meta.json");
        let mut meta: Self = serde_json::from_str(&std::fs::read_to_string(&meta_path)?)?;
        meta.project_path = project_path.to_path_buf();
        meta.normalize_paths();

        Ok(meta)
    }

    pub fn save_for_project(&self) -> Result<(), Either<serde_json::Error, std::io::Error>> {
        self.save_for_project_with(|file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()
        })
    }

    fn save_for_project_with(
        &self,
        prepare: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
    ) -> Result<(), Either<serde_json::Error, std::io::Error>> {
        let meta = serde_json::to_string_pretty(self).map_err(Either::Left)?;
        let meta_path = self.project_path.join("recording-meta.json");
        let permissions = match std::fs::symlink_metadata(&meta_path) {
            Ok(metadata) if !metadata.is_file() => {
                return Err(Either::Right(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "Recording metadata must be a regular file",
                )));
            }
            Ok(metadata) if metadata.permissions().readonly() => {
                return Err(Either::Right(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "Recording metadata is read-only",
                )));
            }
            Ok(metadata) => Some(metadata.permissions()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(Either::Right(error)),
        };
        let mut temporary = tempfile::Builder::new()
            .prefix(".recording-meta-")
            .suffix(".json.tmp")
            .tempfile_in(&self.project_path)
            .map_err(Either::Right)?;
        if let Some(permissions) = permissions {
            temporary
                .as_file()
                .set_permissions(permissions)
                .map_err(Either::Right)?;
        }
        prepare(temporary.as_file_mut(), meta.as_bytes()).map_err(Either::Right)?;
        #[cfg(windows)]
        {
            // tempfile 3.23 lacks Rust's Windows rename fallback for open readers.
            let (file, path) = temporary
                .keep()
                .map_err(|error| Either::Right(error.error))?;
            let mut path = tempfile::TempPath::from_path(path);
            std::fs::rename(&path, &meta_path).map_err(Either::Right)?;
            path.disable_cleanup(true);
            drop(file);
        }
        #[cfg(not(windows))]
        drop(
            temporary
                .persist(&meta_path)
                .map_err(|error| Either::Right(error.error))?,
        );
        Ok(())
    }

    pub fn project_config(&self) -> ProjectConfiguration {
        let mut config = ProjectConfiguration::load(&self.project_path).unwrap_or_default();

        let captions_path = self.project_path.join("captions.json");
        debug!("Checking for captions at: {:?}", captions_path);

        if let Ok(captions_str) = std::fs::read_to_string(&captions_path) {
            debug!("Found captions.json, attempting to parse");
            if let Ok(captions_data) = serde_json::from_str::<CaptionsData>(&captions_str) {
                info!(
                    "Successfully loaded captions with {} segments",
                    captions_data.segments.len()
                );
                config.captions = Some(captions_data);
            } else {
                warn!("Failed to parse captions.json");
            }
        } else {
            debug!("No captions.json found");
        }

        if let Some(ref captions) = config.captions {
            let timeline_has_captions = config
                .timeline
                .as_ref()
                .map(|t| !t.caption_segments.is_empty())
                .unwrap_or(false);

            if !timeline_has_captions && !captions.segments.is_empty() {
                let caption_track_segments: Vec<crate::CaptionTrackSegment> = captions
                    .segments
                    .iter()
                    .map(|seg| crate::CaptionTrackSegment {
                        id: seg.id.clone(),
                        start: seg.start as f64,
                        end: seg.end as f64,
                        text: seg.text.clone(),
                        words: seg.words.clone(),
                        fade_duration_override: None,
                        linger_duration_override: None,
                        position_override: None,
                        color_override: None,
                        background_color_override: None,
                        font_size_override: None,
                    })
                    .collect();

                if let Some(ref mut timeline) = config.timeline {
                    timeline.caption_segments = caption_track_segments;
                }
            }
        }

        config
    }

    pub fn output_path(&self) -> PathBuf {
        match &self.inner {
            RecordingMetaInner::Instant(_) => self.project_path.join("content/output.mp4"),
            RecordingMetaInner::Studio(_) => self.project_path.join("output").join("result.mp4"),
        }
    }

    pub fn studio_meta(&self) -> Option<&StudioRecordingMeta> {
        match &self.inner {
            RecordingMetaInner::Studio(meta) => Some(meta),
            _ => None,
        }
    }

    fn normalize_paths(&mut self) {
        let normalize_video = |meta: &mut VideoMeta| normalize_relative_path(&mut meta.path);
        let normalize_audio = |meta: &mut AudioMeta| normalize_relative_path(&mut meta.path);
        let normalize_cursor = |path: &mut Option<RelativePathBuf>| {
            if let Some(path) = path {
                normalize_relative_path(path);
            }
        };

        match &mut self.inner {
            RecordingMetaInner::Studio(meta) => match meta.as_mut() {
                StudioRecordingMeta::SingleSegment { segment } => {
                    normalize_video(&mut segment.display);
                    if let Some(camera) = &mut segment.camera {
                        normalize_video(camera);
                    }
                    if let Some(audio) = &mut segment.audio {
                        normalize_audio(audio);
                    }
                    normalize_cursor(&mut segment.cursor);
                }
                StudioRecordingMeta::MultipleSegments { inner } => {
                    for segment in &mut inner.segments {
                        normalize_video(&mut segment.display);
                        if let Some(camera) = &mut segment.camera {
                            normalize_video(camera);
                        }
                        if let Some(mic) = &mut segment.mic {
                            normalize_audio(mic);
                        }
                        if let Some(system_audio) = &mut segment.system_audio {
                            normalize_audio(system_audio);
                        }
                        normalize_cursor(&mut segment.cursor);
                    }

                    if let Cursors::Correct(cursors) = &mut inner.cursors {
                        for cursor in cursors.values_mut() {
                            normalize_relative_path(&mut cursor.image_path);
                        }
                    }
                }
            },
            RecordingMetaInner::Instant(_) => {}
        }
    }
}

fn normalize_relative_path(path: &mut RelativePathBuf) {
    let original = path.as_str();
    let normalized = original.replace('\\', "/");

    if normalized.starts_with("content/")
        || normalized.starts_with("screenshots/")
        || normalized.starts_with("output/")
    {
        return;
    }

    for root in ["content/", "screenshots/", "output/"] {
        if let Some(index) = normalized.find(root) {
            *path = RelativePathBuf::from(&normalized[index..]);
            return;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum StudioRecordingMeta {
    SingleSegment {
        #[serde(flatten)]
        #[specta(flatten)]
        segment: SingleSegment,
    },
    MultipleSegments {
        #[serde(flatten)]
        #[specta(flatten)]
        inner: MultipleSegments,
    },
}

impl StudioRecordingMeta {
    /// Notch captured with this recording. Every segment shares one display, so
    /// the first segment speaks for all of them. `None` for recordings made
    /// before Cap started capturing this, and for every non-macOS recording.
    pub fn display_notch(&self) -> Option<DisplayNotch> {
        match self {
            StudioRecordingMeta::SingleSegment { .. } => None,
            StudioRecordingMeta::MultipleSegments { inner } => {
                inner.segments.first().and_then(|s| s.display_notch)
            }
        }
    }

    pub fn status(&self) -> StudioRecordingStatus {
        match self {
            StudioRecordingMeta::SingleSegment { .. } => StudioRecordingStatus::Complete,
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .status
                .clone()
                .unwrap_or(StudioRecordingStatus::Complete),
        }
    }

    pub fn ensure_ordinary_media_access(&self, project_path: &Path) -> Result<(), String> {
        if let StudioRecordingStatus::Failed { error } = self.status() {
            return Err(format!(
                "This recording failed: {error}. Its original files are preserved and may contain incomplete tracks. Open the recording folder to inspect them."
            ));
        }

        let path = project_path.join("recording-diagnostics.json");
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "Cannot verify preserved recording diagnostics: {error}. Original files are unchanged."
                ));
            }
        };
        let diagnostics: serde_json::Value = serde_json::from_slice(&raw).map_err(|error| {
            format!("Cannot verify preserved recording diagnostics: {error}. Original files are unchanged.")
        })?;
        let failed = diagnostics
            .get("segments")
            .and_then(serde_json::Value::as_array)
            .is_none_or(|segments| {
                segments.iter().any(|segment| {
                    segment
                        .get("trackFailures")
                        .and_then(serde_json::Value::as_array)
                        .is_none_or(|failures| !failures.is_empty())
                })
            });
        if failed && self.legacy_omitted_track_failures(&diagnostics).is_none() {
            return Err(
                "This recording retains a requested-track failure or incomplete diagnostics. Its original files are preserved. Open the recording folder to inspect them."
                    .into(),
            );
        }
        Ok(())
    }

    pub fn legacy_omitted_track_failures(
        &self,
        diagnostics: &serde_json::Value,
    ) -> Option<Vec<(usize, &'static str)>> {
        let Self::MultipleSegments { inner } = self else {
            return None;
        };
        if !matches!(
            inner.status,
            Some(StudioRecordingStatus::Complete | StudioRecordingStatus::NeedsRemux)
        ) || diagnostics.get("version")?.as_u64()? != 1
        {
            return None;
        }

        let mut omitted = Vec::new();
        for segment in diagnostics.get("segments")?.as_array()? {
            let index = usize::try_from(segment.get("segmentIndex")?.as_u64()?).ok()?;
            let recorded = inner.segments.get(index)?;
            for failure in segment.get("trackFailures")?.as_array()? {
                if !matches!(failure.get("stage")?.as_str()?, "runtime" | "stop") {
                    return None;
                }
                failure.get("error")?.as_str()?;
                let track = match failure.get("track")?.as_str()? {
                    "microphone" if recorded.mic.is_none() => "microphone",
                    "camera" if recorded.camera.is_none() => "camera",
                    "systemAudio" if recorded.system_audio.is_none() => "systemAudio",
                    _ => return None,
                };
                omitted.push((index, track));
            }
        }
        Some(omitted)
    }

    pub fn camera_path(&self) -> Option<RelativePathBuf> {
        match self {
            Self::SingleSegment { segment } => segment.camera.as_ref().map(|c| c.path.clone()),
            Self::MultipleSegments { inner, .. } => inner
                .segments
                .first()
                .and_then(|s| s.camera.as_ref().map(|c| c.path.clone())),
        }
    }

    pub fn pointer_cursor_ids(&self) -> HashSet<String> {
        match self {
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner.pointer_cursor_ids(),
            _ => HashSet::new(),
        }
    }

    pub fn min_fps(&self) -> u32 {
        match self {
            Self::SingleSegment { segment } => segment.display.fps,
            Self::MultipleSegments { inner, .. } => {
                inner.segments.iter().map(|s| s.display.fps).min().unwrap()
            }
        }
    }

    pub fn max_fps(&self) -> u32 {
        match self {
            Self::SingleSegment { segment } => segment.display.fps,
            Self::MultipleSegments { inner, .. } => {
                inner.segments.iter().map(|s| s.display.fps).max().unwrap()
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SingleSegment {
    pub display: VideoMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<VideoMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<String>)]
    pub cursor: Option<RelativePathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MultipleSegments {
    pub segments: Vec<MultipleSegment>,
    #[serde(default, skip_serializing_if = "Cursors::is_empty")]
    pub cursors: Cursors,
    #[serde(default)]
    pub status: Option<StudioRecordingStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "status")]
pub enum StudioRecordingStatus {
    InProgress,
    NeedsRemux,
    Failed { error: String },
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum Cursors {
    Old(HashMap<String, String>),
    Correct(HashMap<String, CursorMeta>),
}

impl Cursors {
    pub fn is_empty(&self) -> bool {
        match self {
            Cursors::Old(map) => map.is_empty(),
            Cursors::Correct(map) => map.is_empty(),
        }
    }
}

impl Default for Cursors {
    fn default() -> Self {
        Self::Correct(Default::default())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CursorMeta {
    #[specta(type = String)]
    pub image_path: RelativePathBuf,
    pub hotspot: XY<f64>,
    #[serde(default)]
    pub shape: Option<cap_cursor_info::CursorShape>,
}

impl MultipleSegments {
    pub fn path(&self, meta: &RecordingMeta, path: impl AsRef<Path>) -> PathBuf {
        meta.project_path.join(path)
    }

    pub fn pointer_cursor_ids(&self) -> HashSet<String> {
        match &self.cursors {
            Cursors::Correct(map) => map
                .iter()
                .filter_map(|(id, cursor)| match cursor.shape.as_ref() {
                    Some(cap_cursor_info::CursorShape::MacOS(
                        cap_cursor_info::CursorShapeMacOS::Arrow,
                    ))
                    | Some(cap_cursor_info::CursorShape::Windows(
                        cap_cursor_info::CursorShapeWindows::Arrow,
                    )) => Some(id.clone()),
                    _ => None,
                })
                .collect(),
            Cursors::Old(_) => HashSet::new(),
        }
    }

    pub fn get_cursor_image(&self, meta: &RecordingMeta, id: &str) -> Option<CursorImage> {
        match &self.cursors {
            Cursors::Old(_) => None,
            Cursors::Correct(map) => {
                let cursor = map.get(id)?;
                Some(CursorImage {
                    path: meta.path(&cursor.image_path),
                    hotspot: cursor.hotspot,
                })
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MultipleSegment {
    pub display: VideoMeta,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<VideoMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "audio")]
    pub mic: Option<AudioMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_audio: Option<AudioMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<String>)]
    pub cursor: Option<RelativePathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<String>)]
    pub keyboard: Option<RelativePathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_notch: Option<DisplayNotch>,
}

impl MultipleSegment {
    pub fn path(&self, meta: &RecordingMeta, path: impl AsRef<Path>) -> PathBuf {
        meta.project_path.join(path)
    }

    pub fn cursor_events(&self, meta: &RecordingMeta) -> CursorEvents {
        let Some(cursor_path) = &self.cursor else {
            return CursorEvents::default();
        };

        let full_path = meta.path(cursor_path);

        let mut data = match CursorEvents::load_from_file(&full_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!("Failed to load cursor data: {e}");
                return CursorEvents::default();
            }
        };

        let pointer_ids = if let RecordingMetaInner::Studio(studio_meta) = &meta.inner {
            studio_meta.pointer_cursor_ids()
        } else {
            HashSet::new()
        };

        let pointer_ids_ref = (!pointer_ids.is_empty()).then_some(&pointer_ids);
        data.stabilize_short_lived_cursor_shapes(pointer_ids_ref, SHORT_CURSOR_SHAPE_DEBOUNCE_MS);

        data
    }

    pub fn keyboard_events(&self, meta: &RecordingMeta) -> KeyboardEvents {
        let keyboard_path = self.keyboard.clone().or_else(|| {
            let display_dir = self.display.path.parent()?;
            let binary = display_dir.join(crate::KEYBOARD_EVENTS_FILE_NAME);
            let binary_full = meta.path(&binary);
            if binary_full.exists() {
                return Some(binary);
            }

            let legacy = display_dir.join(crate::LEGACY_KEYBOARD_EVENTS_FILE_NAME);
            let legacy_full = meta.path(&legacy);
            legacy_full.exists().then_some(legacy)
        });

        let Some(keyboard_path) = keyboard_path else {
            return KeyboardEvents::default();
        };

        let full_path = meta.path(&keyboard_path);

        match KeyboardEvents::load_from_file(&full_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!("Failed to load keyboard data: {e}");
                KeyboardEvents::default()
            }
        }
    }

    pub fn latest_start_time(&self) -> Option<f64> {
        let mut value = self.display.start_time?;

        if let Some(camera) = &self.camera {
            value = value.max(camera.start_time?);
        }

        if let Some(mic) = &self.mic {
            value = value.max(mic.start_time?);
        }

        if let Some(system_audio) = &self.system_audio {
            value = value.max(system_audio.start_time?);
        }

        Some(value)
    }

    pub fn calculate_audio_offsets(&self) -> crate::ClipOffsets {
        self.calculate_audio_offsets_with_calibration(None)
    }

    pub fn calculate_audio_offsets_with_calibration(
        &self,
        calibration_offset: Option<f32>,
    ) -> crate::ClipOffsets {
        let latest = match self.latest_start_time() {
            Some(t) => t,
            None => return crate::ClipOffsets::default(),
        };

        let cal_offset = calibration_offset.unwrap_or(0.0);

        let camera_offset = self
            .camera
            .as_ref()
            .and_then(|c| c.start_time)
            .map(|t| (latest - t) as f32)
            .unwrap_or(0.0);

        let mic_offset = self
            .mic
            .as_ref()
            .and_then(|m| m.start_time)
            .map(|t| (latest - t) as f32 + cal_offset)
            .unwrap_or(0.0);

        let system_audio_offset = self
            .system_audio
            .as_ref()
            .and_then(|s| s.start_time)
            .map(|t| (latest - t) as f32 + cal_offset)
            .unwrap_or(0.0);

        crate::ClipOffsets {
            camera: camera_offset,
            mic: mic_offset,
            system_audio: system_audio_offset,
        }
    }

    pub fn camera_device_id(&self) -> Option<&str> {
        self.camera.as_ref().and_then(|c| c.device_id.as_deref())
    }

    pub fn mic_device_id(&self) -> Option<&str> {
        self.mic.as_ref().and_then(|m| m.device_id.as_deref())
    }
}

#[cfg(test)]
mod metadata_save_tests {
    use super::*;
    use std::io::Read;

    const LEGACY_METADATA: &str = r#"{"platform":"MacOS","pretty_name":"Cap 0.5.9 recording","sharing":null,"segments":[{"display":{"path":"content/segments/segment-0/display.mp4","fps":30,"start_time":0.0}}],"cursors":{},"status":{"status":"NeedsRemux"}}"#;

    fn recording(project: &Path) -> RecordingMeta {
        let mut meta: RecordingMeta = serde_json::from_str(LEGACY_METADATA).unwrap();
        meta.project_path = project.to_path_buf();
        meta
    }

    fn assert_no_temporary_metadata(project: &Path) {
        assert!(std::fs::read_dir(project).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".recording-meta-")
        }));
    }

    #[test]
    fn new_metadata_preserves_legacy_serialization_and_loads() {
        let project = tempfile::tempdir().unwrap();
        let meta = recording(project.path());
        meta.save_for_project().unwrap();
        assert_eq!(
            std::fs::read_to_string(project.path().join("recording-meta.json")).unwrap(),
            serde_json::to_string_pretty(&meta).unwrap()
        );
        let loaded = RecordingMeta::load_for_project(project.path()).unwrap();
        assert_eq!(
            serde_json::to_value(loaded).unwrap(),
            serde_json::to_value(meta).unwrap()
        );
        assert_no_temporary_metadata(project.path());
    }

    #[test]
    fn replacing_metadata_does_not_modify_the_previous_file() {
        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-meta.json");
        std::fs::write(&path, LEGACY_METADATA).unwrap();
        let mut previous = std::fs::File::open(&path).unwrap();
        let mut meta = recording(project.path());
        meta.pretty_name = "Finished recording".into();

        meta.save_for_project().unwrap();

        let mut previous_bytes = String::new();
        previous.read_to_string(&mut previous_bytes).unwrap();
        assert_eq!(previous_bytes, LEGACY_METADATA);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            serde_json::to_string_pretty(&meta).unwrap()
        );
        assert_eq!(
            RecordingMeta::load_for_project(project.path())
                .unwrap()
                .pretty_name,
            "Finished recording"
        );
        assert_no_temporary_metadata(project.path());
    }

    #[test]
    fn failed_staged_write_or_sync_preserves_previous_metadata() {
        for partial_write in [true, false] {
            let project = tempfile::tempdir().unwrap();
            let path = project.path().join("recording-meta.json");
            std::fs::write(&path, LEGACY_METADATA).unwrap();
            let mut meta = recording(project.path());
            meta.pretty_name = "Must not be published".into();
            let failure = if partial_write {
                "injected incomplete write"
            } else {
                "injected file sync failure"
            };

            let result = meta.save_for_project_with(|file, bytes| {
                let count = if partial_write {
                    bytes.len() / 2
                } else {
                    bytes.len()
                };
                file.write_all(&bytes[..count])?;
                assert_eq!(std::fs::read_to_string(&path).unwrap(), LEGACY_METADATA);
                Err(std::io::Error::other(failure))
            });

            assert!(matches!(result, Err(Either::Right(error)) if error.to_string() == failure));
            assert_eq!(std::fs::read_to_string(&path).unwrap(), LEGACY_METADATA);
            assert_eq!(
                RecordingMeta::load_for_project(project.path())
                    .unwrap()
                    .pretty_name,
                "Cap 0.5.9 recording"
            );
            assert_no_temporary_metadata(project.path());
        }
    }

    #[test]
    fn non_file_metadata_destination_is_preserved() {
        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-meta.json");
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("retained"), b"original").unwrap();

        assert!(recording(project.path()).save_for_project().is_err());

        assert_eq!(std::fs::read(path.join("retained")).unwrap(), b"original");
        assert_no_temporary_metadata(project.path());
    }

    #[cfg(windows)]
    #[test]
    fn denied_metadata_replacement_preserves_previous_metadata() {
        use std::os::windows::fs::OpenOptionsExt;

        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-meta.json");
        std::fs::write(&path, LEGACY_METADATA).unwrap();
        let mut locked = None;
        let result = recording(project.path()).save_for_project_with(|file, bytes| {
            file.write_all(bytes)?;
            file.sync_all()?;
            locked = Some(
                std::fs::OpenOptions::new()
                    .read(true)
                    .share_mode(0)
                    .open(&path)?,
            );
            Ok(())
        });

        assert!(locked.is_some());
        drop(locked);
        assert!(result.is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), LEGACY_METADATA);
        assert_no_temporary_metadata(project.path());
    }

    #[cfg(unix)]
    #[test]
    fn metadata_replacement_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-meta.json");
        std::fs::write(&path, LEGACY_METADATA).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o640)).unwrap();

        recording(project.path()).save_for_project().unwrap();

        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_metadata_and_its_target_are_preserved() {
        let project = tempfile::tempdir().unwrap();
        let target = project.path().join("original.json");
        let path = project.path().join("recording-meta.json");
        std::fs::write(&target, LEGACY_METADATA).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();

        assert!(recording(project.path()).save_for_project().is_err());

        assert!(
            std::fs::symlink_metadata(path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        assert_eq!(std::fs::read_to_string(target).unwrap(), LEGACY_METADATA);
        assert_no_temporary_metadata(project.path());
    }
}

#[cfg(test)]
mod test {
    use super::RecordingMeta;

    fn test_meta_deserialize(s: &str) {
        let _: RecordingMeta = serde_json::from_str(s).unwrap();
    }

    #[test]
    fn single_segment() {
        test_meta_deserialize(
            r#"{
						  "pretty_name": "Cap 2024-11-15 at 16.35.36",
						  "sharing": null,
						  "display": {
						    "path": "content/display.mp4"
						  },
						  "camera": null,
						  "audio": null,
						  "segments": [
						    {
						      "start": 0.0,
						      "end": 10.683263063430786
						    }
						  ],
						  "cursor": "cursor.json"
						}"#,
        );

        test_meta_deserialize(
            r#"{
	          "pretty_name": "Cap 2024-11-26 at 22.16.36",
	          "sharing": null,
	          "display": {
	            "path": "content/display.mp4"
	          },
	          "camera": {
	            "path": "content/camera.mp4"
	          },
	          "audio": {
	            "path": "content/audio-input.mp3"
	          },
	          "segments": [],
	          "cursor": "cursor.json"
	        }"#,
        );
    }

    #[test]
    fn multi_segment() {
        test_meta_deserialize(
            r#"{
              "pretty_name": "Cap 2024-11-26 at 22.29.30",
              "sharing": null,
              "segments": [
                {
                  "display": {
                    "path": "content/segments/segment-0/display.mp4"
                  },
                  "camera": {
                    "path": "content/segments/segment-0/camera.mp4"
                  },
                  "audio": {
                    "path": "content/segments/segment-0/audio-input.mp3"
                  }
                }
              ],
              "cursors": {
                "0": "content/cursors/cursor_0.png",
                "3": "content/cursors/cursor_3.png",
                "2": "content/cursors/cursor_2.png",
                "1": "content/cursors/cursor_1.png"
              }
            }"#,
        );

        test_meta_deserialize(
            r#"{
	          "pretty_name": "Cap 2024-11-26 at 22.32.26",
	          "sharing": null,
	          "segments": [
	            {
	              "display": {
	                "path": "content/segments/segment-0/display.mp4"
	              },
	              "camera": {
	                "path": "content/segments/segment-0/camera.mp4"
	              },
	              "audio": {
	                "path": "content/segments/segment-0/audio-input.mp3"
	              }
	            },
	            {
	              "display": {
	                "path": "content/segments/segment-1/display.mp4"
	              },
	              "camera": {
	                "path": "content/segments/segment-1/camera.mp4"
	              },
	              "audio": {
	                "path": "content/segments/segment-1/audio-input.mp3"
	              }
	            }
	          ]
	        }"#,
        );
    }

    mod audio_offsets {
        use crate::{AudioMeta, MultipleSegment, VideoMeta};
        use relative_path::RelativePathBuf;

        fn video(start_time: Option<f64>) -> VideoMeta {
            VideoMeta {
                path: RelativePathBuf::from("display.mp4"),
                fps: 30,
                start_time,
                device_id: None,
            }
        }

        fn audio(start_time: Option<f64>) -> AudioMeta {
            AudioMeta {
                path: RelativePathBuf::from("audio.ogg"),
                start_time,
                device_id: None,
                gap_summary: None,
            }
        }

        fn segment(
            display_start: f64,
            mic_start: Option<f64>,
            system_start: Option<f64>,
        ) -> MultipleSegment {
            MultipleSegment {
                display: video(Some(display_start)),
                camera: None,
                mic: mic_start.map(|s| audio(Some(s))),
                system_audio: system_start.map(|s| audio(Some(s))),
                cursor: None,
                keyboard: None,
                display_notch: None,
            }
        }

        // The recorder anchors system audio at the recording epoch
        // (start_time ~ 0.0), which keeps it from ever being the latest
        // start_time: the mic/display anchor — and therefore where playback
        // starts and how the mic aligns to video — must be identical with
        // and without a system audio track.
        #[test]
        fn epoch_anchored_system_audio_does_not_move_the_anchor() {
            let without = segment(0.58, Some(0.55), None);
            let with = segment(0.58, Some(0.55), Some(0.0));

            assert_eq!(without.latest_start_time(), Some(0.58));
            assert_eq!(with.latest_start_time(), Some(0.58));

            let offsets_without = without.calculate_audio_offsets();
            let offsets_with = with.calculate_audio_offsets();
            assert_eq!(offsets_without.mic, offsets_with.mic);
            assert!((offsets_with.mic - 0.03).abs() < 1e-6);
            // System audio positions itself by its own start.
            assert!((offsets_with.system_audio - 0.58).abs() < 1e-6);
        }

        // Legacy recordings (pre-epoch-anchor) stamped system audio with its
        // first packet time; those files keep their historical alignment:
        // a later system start is still the anchor for them.
        #[test]
        fn legacy_first_packet_system_audio_keeps_historical_anchor() {
            let legacy = segment(0.5824678, Some(0.5559852), Some(0.6586015));
            assert_eq!(legacy.latest_start_time(), Some(0.6586015));
            let offsets = legacy.calculate_audio_offsets();
            assert!((offsets.mic - (0.6586015 - 0.5559852) as f32).abs() < 1e-6);
            assert_eq!(offsets.system_audio, 0.0);
        }
    }
}

#[cfg(test)]
mod display_notch_tests {
    use crate::{DisplayNotch, RecordingMeta, RecordingMetaInner, StudioRecordingMeta};

    fn multiple_segments(display_notch: &str) -> String {
        format!(
            r#"{{
              "pretty_name": "Cap",
              "segments": [
                {{
                  "display": {{ "path": "content/segments/segment-0/display.mp4", "fps": 30 }}
                  {display_notch}
                }}
              ]
            }}"#
        )
    }

    fn studio(meta: &RecordingMeta) -> &StudioRecordingMeta {
        match &meta.inner {
            RecordingMetaInner::Studio(studio) => studio,
            RecordingMetaInner::Instant(_) => panic!("expected a studio recording"),
        }
    }

    /// Every recording made before this field existed must still load.
    #[test]
    fn absent_notch_loads_as_none() {
        let meta: RecordingMeta = serde_json::from_str(&multiple_segments("")).unwrap();

        assert_eq!(studio(&meta).display_notch(), None);
    }

    #[test]
    fn notch_round_trips() {
        let notch = DisplayNotch {
            x: 0.4384920634920635,
            width: 0.12235449735449735,
            height: 0.032586558044806514,
        };

        let meta: RecordingMeta = serde_json::from_str(&multiple_segments(
            r#", "display_notch": { "x": 0.4384920634920635, "width": 0.12235449735449735, "height": 0.032586558044806514 }"#,
        ))
        .unwrap();
        assert_eq!(studio(&meta).display_notch(), Some(notch));

        let reparsed: RecordingMeta =
            serde_json::from_str(&serde_json::to_string(&meta).unwrap()).unwrap();
        assert_eq!(studio(&reparsed).display_notch(), Some(notch));
    }

    /// Recordings without a notch shouldn't gain a null key in their metadata.
    #[test]
    fn absent_notch_is_not_serialized() {
        let meta: RecordingMeta = serde_json::from_str(&multiple_segments("")).unwrap();

        assert!(
            !serde_json::to_string(&meta)
                .unwrap()
                .contains("display_notch")
        );
    }

    /// Single-segment recordings predate the field entirely.
    #[test]
    fn legacy_single_segment_has_no_notch() {
        let meta: RecordingMeta = serde_json::from_str(
            r#"{
              "pretty_name": "Cap",
              "display": { "path": "content/display.mp4" },
              "segments": [{ "start": 0.0, "end": 1.0 }]
            }"#,
        )
        .unwrap();

        assert_eq!(studio(&meta).display_notch(), None);
    }
}

#[cfg(test)]
mod ordinary_media_access_tests {
    use super::{
        Cursors, MultipleSegments, RecordingMeta, StudioRecordingMeta, StudioRecordingStatus,
    };

    fn studio(status: Option<StudioRecordingStatus>) -> StudioRecordingMeta {
        StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments: Vec::new(),
                cursors: Cursors::default(),
                status,
            },
        }
    }

    fn check_diagnostics(raw: &[u8], expected_ok: bool) {
        let project = tempfile::tempdir().unwrap();
        let diagnostics = project.path().join("recording-diagnostics.json");
        let media = project.path().join("surviving-track.bin");
        let config = project.path().join("project-config.json");
        std::fs::write(&diagnostics, raw).unwrap();
        std::fs::write(&media, b"incomplete original media").unwrap();
        std::fs::write(&config, b"original config").unwrap();
        let meta = studio(Some(StudioRecordingStatus::Complete));
        let before = serde_json::to_vec(&meta).unwrap();
        assert_eq!(
            meta.ensure_ordinary_media_access(project.path()).is_ok(),
            expected_ok
        );
        assert_eq!(std::fs::read(diagnostics).unwrap(), raw);
        assert_eq!(std::fs::read(media).unwrap(), b"incomplete original media");
        assert_eq!(std::fs::read(config).unwrap(), b"original config");
        assert_eq!(serde_json::to_vec(&meta).unwrap(), before);
    }

    fn legacy_optional_failure() -> (StudioRecordingMeta, serde_json::Value) {
        let recording: RecordingMeta = serde_json::from_str(
            r#"{"platform":"MacOS","pretty_name":"Cap recording","sharing":null,"segments":[{"display":{"path":"content/segments/segment-0/display.mp4","fps":30,"start_time":0.0}}],"cursors":{},"status":{"status":"Complete"}}"#,
        )
        .unwrap();
        let diagnostics = serde_json::json!({
            "version": 1,
            "segments": [{
                "segmentIndex": 0,
                "start": 10.0,
                "end": 20.0,
                "trackFailures": [{
                    "track": "microphone",
                    "stage": "runtime",
                    "error": "microphone writer failed"
                }]
            }]
        });
        (recording.studio_meta().unwrap().clone(), diagnostics)
    }

    #[test]
    fn released_059_omitted_optional_failures_remain_accessible() {
        let project = tempfile::tempdir().unwrap();
        let path = project.path().join("recording-diagnostics.json");
        for status in [
            StudioRecordingStatus::Complete,
            StudioRecordingStatus::NeedsRemux,
        ] {
            for track in ["microphone", "camera", "systemAudio"] {
                let (mut meta, mut diagnostics) = legacy_optional_failure();
                let StudioRecordingMeta::MultipleSegments { inner } = &mut meta else {
                    unreachable!();
                };
                inner.status = Some(status.clone());
                diagnostics["segments"][0]["trackFailures"][0]["track"] = track.into();
                let raw = serde_json::to_vec(&diagnostics).unwrap();
                std::fs::write(&path, &raw).unwrap();
                let original_meta = serde_json::to_vec(&meta).unwrap();
                assert!(meta.ensure_ordinary_media_access(project.path()).is_ok());
                assert_eq!(std::fs::read(&path).unwrap(), raw);
                assert_eq!(serde_json::to_vec(&meta).unwrap(), original_meta);
            }
        }
    }

    #[test]
    fn legacy_diagnostics_do_not_override_failed_or_uncertain_status() {
        let project = tempfile::tempdir().unwrap();
        for status in [
            None,
            Some(StudioRecordingStatus::InProgress),
            Some(StudioRecordingStatus::Failed {
                error: "requested microphone failed".into(),
            }),
        ] {
            let (mut meta, diagnostics) = legacy_optional_failure();
            let StudioRecordingMeta::MultipleSegments { inner } = &mut meta else {
                unreachable!();
            };
            inner.status = status;
            std::fs::write(
                project.path().join("recording-diagnostics.json"),
                serde_json::to_vec(&diagnostics).unwrap(),
            )
            .unwrap();
            assert!(meta.ensure_ordinary_media_access(project.path()).is_err());
        }
    }

    #[test]
    fn current_or_unresolved_failures_cannot_use_legacy_compatibility() {
        let project = tempfile::tempdir().unwrap();
        for (pointer, value) in [
            ("/version", serde_json::json!(2)),
            ("/version", serde_json::json!(0)),
            ("/segments/0/segmentIndex", serde_json::json!(1)),
            (
                "/segments/0/trackFailures/0/track",
                serde_json::json!("display"),
            ),
            (
                "/segments/0/trackFailures/0/track",
                serde_json::json!("unknown"),
            ),
            ("/segments/0/trackFailures/0/stage", serde_json::Value::Null),
            ("/segments/0/trackFailures/0/error", serde_json::Value::Null),
        ] {
            let (meta, mut diagnostics) = legacy_optional_failure();
            *diagnostics.pointer_mut(pointer).unwrap() = value;
            std::fs::write(
                project.path().join("recording-diagnostics.json"),
                serde_json::to_vec(&diagnostics).unwrap(),
            )
            .unwrap();
            assert!(meta.ensure_ordinary_media_access(project.path()).is_err());
        }

        let (meta, diagnostics) = legacy_optional_failure();
        let mut raw_meta = serde_json::to_value(&meta).unwrap();
        raw_meta["segments"][0]["mic"] = serde_json::json!({
            "path": "content/segments/segment-0/audio-input.ogg"
        });
        let meta: StudioRecordingMeta = serde_json::from_value(raw_meta).unwrap();
        std::fs::write(
            project.path().join("recording-diagnostics.json"),
            serde_json::to_vec(&diagnostics).unwrap(),
        )
        .unwrap();
        assert!(meta.ensure_ordinary_media_access(project.path()).is_err());
    }

    #[test]
    fn failed_status_refuses_without_changing_metadata_or_media() {
        let project = tempfile::tempdir().unwrap();
        let media = project.path().join("raw.bin");
        std::fs::write(&media, b"retained").unwrap();
        let meta = studio(Some(StudioRecordingStatus::Failed {
            error: "microphone lost".into(),
        }));
        let before = serde_json::to_vec(&meta).unwrap();
        let error = meta
            .ensure_ordinary_media_access(project.path())
            .unwrap_err();
        assert!(error.contains("microphone lost"));
        assert!(!error.contains("may need to be recovered"));
        assert_eq!(serde_json::to_vec(&meta).unwrap(), before);
        assert_eq!(std::fs::read(media).unwrap(), b"retained");
    }

    #[test]
    fn absent_diagnostics_preserves_legacy_and_existing_status_policy() {
        let project = tempfile::tempdir().unwrap();
        for status in [
            None,
            Some(StudioRecordingStatus::Complete),
            Some(StudioRecordingStatus::InProgress),
            Some(StudioRecordingStatus::NeedsRemux),
        ] {
            assert!(
                studio(status)
                    .ensure_ordinary_media_access(project.path())
                    .is_ok()
            );
        }
    }

    #[test]
    fn legacy_single_segment_without_diagnostics_remains_allowed() {
        let project = tempfile::tempdir().unwrap();
        let meta: StudioRecordingMeta =
            serde_json::from_str(r#"{"display":{"path":"content/display.mp4"}}"#).unwrap();
        assert!(meta.ensure_ordinary_media_access(project.path()).is_ok());
    }

    #[test]
    fn clean_track_diagnostics_remain_allowed() {
        check_diagnostics(br#"{"segments":[{"trackFailures":[]}]}"#, true);
    }

    #[test]
    fn retained_failure_refuses_even_if_status_is_complete() {
        check_diagnostics(
            br#"{"segments":[{"trackFailures":["system audio lost"]}]}"#,
            false,
        );
    }

    #[test]
    fn malformed_diagnostics_refuse_without_modification() {
        check_diagnostics(b"{", false);
    }

    #[test]
    fn incomplete_diagnostic_schema_refuses_without_modification() {
        for raw in [
            b"{}".as_slice(),
            br#"{"segments":[{}]}"#,
            br#"{"segments":null}"#,
            br#"{"segments":[{"trackFailures":null}]}"#,
        ] {
            check_diagnostics(raw, false);
        }
    }

    #[test]
    fn empty_segment_diagnostics_preserve_existing_recovery_policy() {
        check_diagnostics(br#"{"segments":[]}"#, true);
    }

    #[test]
    fn diagnostics_read_error_refuses_without_changing_directory() {
        let project = tempfile::tempdir().unwrap();
        let diagnostics = project.path().join("recording-diagnostics.json");
        std::fs::create_dir(&diagnostics).unwrap();
        assert!(
            studio(None)
                .ensure_ordinary_media_access(project.path())
                .is_err()
        );
        assert!(diagnostics.is_dir());
    }
}
