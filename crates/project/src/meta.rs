use either::Either;
use relative_path::RelativePathBuf;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    error::Error,
    path::{Path, PathBuf},
};
use tracing::{debug, info, warn};

use crate::{CaptionsData, CursorEvents, CursorImage, ProjectConfiguration, XY};

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
    pub upload: Option<UploadState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "state")]
pub enum UploadState {
    // TODO: Do we care about what sort of upload it is???
    MultipartUpload { cap_id: String },
    SinglePartUpload { cap_id: String },
    Failed { error: String },
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
        match CursorEvents::load_from_file(&full_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!("Failed to load cursor data: {e}");
                CursorEvents::default()
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
