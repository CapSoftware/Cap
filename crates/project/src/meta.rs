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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
}

fn legacy_static_video_fps() -> u32 {
    30
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioMeta {
    #[specta(type = String)]
    pub path: RelativePathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_time: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
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
    Linux,
}

impl Default for Platform {
    fn default() -> Self {
        #[cfg(target_os = "windows")]
        return Self::Windows;

        #[cfg(target_os = "linux")]
        return Self::Linux;

        #[cfg(target_os = "macos")]
        return Self::MacOS;

        #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
        return Self::MacOS;
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
}
