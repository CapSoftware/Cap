use either::Either;
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    path::{Path, PathBuf},
};
use tracing::{debug, info, warn};

use crate::{
    CaptionsData, CursorEvents, CursorImage, ProjectConfiguration, XY,
    cursor::SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct VideoMeta {
    #[specta(type = String)]
    pub path: RelativePathBuf,
    #[serde(default = "legacy_static_video_fps")]
    pub fps: u32,
    /// unix time of the first frame
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
}

fn legacy_static_video_fps() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioMeta {
    #[specta(type = String)]
    pub path: RelativePathBuf,
    /// unix time of the first frame
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SharingMeta {
    pub id: String,
    pub link: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum Platform {
    MacOS,
    Windows,
}

impl Default for Platform {
    fn default() -> Self {
        #[cfg(windows)]
        return Self::Windows;

        #[cfg(target_os = "macos")]
        return Self::MacOS;

        #[cfg(not(any(windows, target_os = "macos")))]
        return Self::MacOS;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingMeta {
    #[serde(default)]
    pub platform: Option<Platform>,
    // this field is just for convenience, it shouldn't be persisted
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
        // Cap web identifier
        video_id: String,
        // Data for resuming
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
    },
    SinglePartUpload {
        // Cap web identifier
        video_id: String,
        // Path of the Cap file
        recording_dir: PathBuf,
        // Path to video and screenshot files for resuming
        file_path: PathBuf,
        screenshot_path: PathBuf,
    },
    Failed {
        error: String,
    },
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum RecordingMetaInner {
    Studio(StudioRecordingMeta),
    Instant(InstantRecordingMeta),
}

impl specta::Flatten for RecordingMetaInner {}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum InstantRecordingMeta {
    InProgress {
        // This field means nothing and is just because this enum is untagged.
        recording: bool,
    },
    Failed {
        error: String,
    },
    Complete {
        fps: u32,
        sample_rate: Option<u32>,
    },
}

impl RecordingMeta {
    pub fn path(&self, relative: &RelativePathBuf) -> PathBuf {
        relative.to_path(&self.project_path)
    }

    pub fn load_for_project(project_path: &Path) -> Result<Self, Box<dyn Error>> {
        let meta_path = project_path.join("recording-meta.json");
        let mut meta: Self = serde_json::from_str(&std::fs::read_to_string(&meta_path)?)?;
        meta.project_path = project_path.to_path_buf();

        Ok(meta)
    }

    pub fn save_for_project(&self) -> Result<(), Either<serde_json::Error, std::io::Error>> {
        let meta_path = &self.project_path.join("recording-meta.json");
        let meta = serde_json::to_string_pretty(&self).map_err(Either::Left)?;
        std::fs::write(meta_path, meta).map_err(Either::Right)?;
        Ok(())
    }

    pub fn project_config(&self) -> ProjectConfiguration {
        let mut config = ProjectConfiguration::load(&self.project_path).unwrap_or_default();

        // Try to load captions from captions.json if it exists
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

    pub fn needs_recovery(project_path: &Path) -> bool {
        let partial_meta_path = project_path.join("recording-meta-partial.json");
        let full_meta_path = project_path.join("recording-meta.json");

        partial_meta_path.exists() && !full_meta_path.exists()
    }

    pub fn try_recover(project_path: &Path, pretty_name: String) -> Result<Self, Box<dyn Error>> {
        info!("Attempting to recover recording at {:?}", project_path);

        let segments_dir = project_path.join("content").join("segments");
        let cursors_dir = project_path.join("content").join("cursors");

        if !segments_dir.exists() {
            return Err("No segments directory found".into());
        }

        let mut segments = Vec::new();
        let mut segment_dirs: Vec<_> = std::fs::read_dir(&segments_dir)?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .collect();
        segment_dirs.sort_by_key(|e| e.path());

        const MIN_VIDEO_SIZE: u64 = 1024;

        let file_is_valid = |path: &Path, min_size: u64| -> bool {
            path.exists()
                && std::fs::metadata(path)
                    .map(|m| m.len() >= min_size)
                    .unwrap_or(false)
        };

        for segment_entry in segment_dirs {
            let segment_dir = segment_entry.path();

            let display_path = segment_dir.join("display.mp4");
            if !file_is_valid(&display_path, MIN_VIDEO_SIZE) {
                warn!(
                    "Skipping segment {:?} - display.mp4 missing or too small",
                    segment_dir.file_name()
                );
                continue;
            }

            let camera_path = segment_dir.join("camera.mp4");
            let mic_path = segment_dir.join("audio-input.ogg");
            let system_audio_path = segment_dir.join("system_audio.ogg");
            let cursor_path = segment_dir.join("cursor.json");

            let relative_base = segment_dir
                .strip_prefix(project_path)
                .map(|p| RelativePathBuf::from_path(p).ok())
                .ok()
                .flatten()
                .unwrap_or_else(|| RelativePathBuf::from("content/segments/segment-0"));

            segments.push(MultipleSegment {
                display: VideoMeta {
                    path: relative_base.join("display.mp4"),
                    fps: 30,
                    start_time: None,
                },
                camera: file_is_valid(&camera_path, MIN_VIDEO_SIZE).then(|| VideoMeta {
                    path: relative_base.join("camera.mp4"),
                    fps: 30,
                    start_time: None,
                }),
                mic: mic_path.exists().then(|| AudioMeta {
                    path: relative_base.join("audio-input.ogg"),
                    start_time: None,
                }),
                system_audio: system_audio_path.exists().then(|| AudioMeta {
                    path: relative_base.join("system_audio.ogg"),
                    start_time: None,
                }),
                cursor: cursor_path
                    .exists()
                    .then(|| relative_base.join("cursor.json")),
            });
        }

        if segments.is_empty() {
            return Err("No valid segments found for recovery".into());
        }

        let segment_count = segments.len();

        let mut cursor_map = HashMap::new();
        if cursors_dir.exists() {
            for entry in std::fs::read_dir(&cursors_dir)?.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "png") {
                    if let Some(file_stem) = path.file_stem().and_then(|s| s.to_str()) {
                        if let Some(id) = file_stem.strip_prefix("cursor_") {
                            let relative_path = RelativePathBuf::from("content/cursors")
                                .join(entry.file_name().to_string_lossy().as_ref());
                            cursor_map.insert(
                                id.to_string(),
                                CursorMeta {
                                    image_path: relative_path,
                                    hotspot: XY { x: 0.0, y: 0.0 },
                                    shape: None,
                                },
                            );
                        }
                    }
                }
            }
        }

        let meta = Self {
            platform: Some(Platform::default()),
            project_path: project_path.to_path_buf(),
            pretty_name,
            sharing: None,
            inner: RecordingMetaInner::Studio(StudioRecordingMeta::MultipleSegments {
                inner: MultipleSegments {
                    segments,
                    cursors: Cursors::Correct(cursor_map),
                    status: Some(StudioRecordingStatus::Complete),
                },
            }),
            upload: None,
        };

        meta.save_for_project().map_err(|e| match e {
            Either::Left(e) => Box::new(e) as Box<dyn Error>,
            Either::Right(e) => Box::new(e) as Box<dyn Error>,
        })?;

        let partial_meta_path = project_path.join("recording-meta-partial.json");
        if partial_meta_path.exists() {
            let _ = std::fs::remove_file(partial_meta_path);
        }

        info!(
            "Successfully recovered recording with {} segment(s)",
            segment_count
        );

        Ok(meta)
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
    pub fn status(&self) -> StudioRecordingStatus {
        match self {
            StudioRecordingMeta::SingleSegment { .. } => StudioRecordingStatus::Complete,
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .status
                .clone()
                .unwrap_or(StudioRecordingStatus::Complete),
        }
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
    Failed { error: String },
    Complete,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged, rename_all = "camelCase")]
pub enum Cursors {
    // needed for backwards compat as i wasn't strict enough with feature flagging 🤦
    Old(HashMap<String, String>),
    Correct(HashMap<String, CursorMeta>),
}

impl Cursors {
    fn is_empty(&self) -> bool {
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

        // Try to load the cursor data
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
        // single segment
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

        // multi segment, no cursor
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
}
