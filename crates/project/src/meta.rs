use either::Either;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    fs::File,
    path::{Path, PathBuf},
};

use crate::{CursorData, CursorEvents, CursorImages, ProjectConfiguration};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Display {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct CameraMeta {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AudioMeta {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SharingMeta {
    pub id: String,
    pub link: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingMeta {
    // this field is just for convenience, it shouldn't be persisted
    #[serde(skip_serializing, default)]
    pub project_path: PathBuf,
    pub pretty_name: String,
    #[serde(default)]
    pub sharing: Option<SharingMeta>,
    #[serde(flatten)]
    pub content: Content,
}

impl RecordingMeta {
    pub fn load_for_project(project_path: &PathBuf) -> Result<Self, String> {
        let meta_path = project_path.join("recording-meta.json");
        let mut meta: Self =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        meta.project_path = project_path.clone();

        Ok(meta)
    }

    pub fn save_for_project(&self) -> Result<(), Either<serde_json::Error, std::io::Error>> {
        let meta_path = &self.project_path.join("recording-meta.json");
        let meta = serde_json::to_string_pretty(&self).map_err(Either::Left)?;
        std::fs::write(meta_path, meta).map_err(Either::Right)?;
        Ok(())
    }

    pub fn project_config(&self) -> ProjectConfiguration {
        ProjectConfiguration::load(&self.project_path).unwrap_or_default()
    }

    pub fn output_path(&self) -> PathBuf {
        self.project_path.join("output").join("result.mp4")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum Content {
    SingleSegment {
        #[serde(flatten)]
        segment: SingleSegment,
    },
    MultipleSegments {
        #[serde(flatten)]
        inner: MultipleSegments,
    },
}

impl Content {
    pub fn camera_path(&self) -> Option<PathBuf> {
        match self {
            Content::SingleSegment { segment } => segment.camera.as_ref().map(|c| c.path.clone()),
            Content::MultipleSegments { inner } => inner
                .segments
                .first()
                .and_then(|s| s.camera.as_ref().map(|c| c.path.clone())),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct SingleSegment {
    pub display: Display,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<CameraMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<PathBuf>,
}

impl SingleSegment {
    pub fn path(&self, meta: &RecordingMeta, path: impl AsRef<Path>) -> PathBuf {
        meta.project_path.join(path)
    }

    pub fn cursor_data(&self, meta: &RecordingMeta) -> CursorData {
        let Some(cursor_path) = &self.cursor else {
            return CursorData::default();
        };

        let full_path = self.path(meta, cursor_path);
        println!("Loading cursor data from: {:?}", full_path);

        // Try to load the cursor data
        let mut data = match CursorData::load_from_file(&full_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!("Failed to load cursor data: {}", e);
                return CursorData::default();
            }
        };

        // If cursor_images is empty but cursor files exist, populate it
        let cursors_dir = self.path(meta, "cursors");
        if data.cursor_images.0.is_empty() && cursors_dir.exists() {
            println!("Scanning cursors directory: {:?}", cursors_dir);
            if let Ok(entries) = std::fs::read_dir(&cursors_dir) {
                for entry in entries {
                    let Ok(entry) = entry else {
                        continue;
                    };

                    let filename = entry.file_name();
                    let filename_str = filename.to_string_lossy();
                    if filename_str.starts_with("cursor_") && filename_str.ends_with(".png") {
                        // Extract cursor ID from filename (cursor_X.png -> X)
                        if let Some(id) = filename_str
                            .strip_prefix("cursor_")
                            .and_then(|s| s.strip_suffix(".png"))
                        {
                            println!("Found cursor image: {} -> {}", id, filename_str);
                            data.cursor_images
                                .0
                                .insert(id.to_string(), filename.to_string_lossy().into_owned());
                        }
                    }
                }
            }
            println!("Found {} cursor images", data.cursor_images.0.len());
        }
        data
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MultipleSegments {
    pub segments: Vec<MultipleSegment>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub cursors: HashMap<String, PathBuf>,
}

impl MultipleSegments {
    pub fn path(&self, meta: &RecordingMeta, path: impl AsRef<Path>) -> PathBuf {
        meta.project_path.join(path)
    }

    pub fn cursor_images(&self, meta: &RecordingMeta) -> Result<CursorImages, String> {
        let file = File::open(self.path(meta, "content/cursors.json"))
            .map_err(|e| format!("Failed to open cursor file: {}", e))?;
        let cursor_images: CursorImages = serde_json::from_reader(file)
            .map_err(|e| format!("Failed to parse cursor data: {}", e))?;

        // let cursors_dir = self.path(meta, "content/cursors");
        // if cursor_images.0.is_empty() && cursors_dir.exists() {
        //     println!("Scanning cursors directory: {:?}", cursors_dir);
        //     if let Ok(entries) = std::fs::read_dir(&cursors_dir) {
        //         for entry in entries {
        //             let Ok(entry) = entry else {
        //                 continue;
        //             };

        //             let filename = entry.file_name();
        //             let filename_str = filename.to_string_lossy();
        //             if filename_str.starts_with("cursor_") && filename_str.ends_with(".png") {
        //                 // Extract cursor ID from filename (cursor_X.png -> X)
        //                 if let Some(id) = filename_str
        //                     .strip_prefix("cursor_")
        //                     .and_then(|s| s.strip_suffix(".png"))
        //                 {
        //                     println!("Found cursor image: {} -> {}", id, filename_str);
        //                     cursor_images
        //                         .0
        //                         .insert(id.to_string(), filename.to_string_lossy().into_owned());
        //                 }
        //             }
        //         }
        //     }
        //     println!("Found {} cursor images", cursor_images.0.len());
        // }

        Ok(cursor_images)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MultipleSegment {
    pub display: Display,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<CameraMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<AudioMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<PathBuf>,
}

impl MultipleSegment {
    pub fn path(&self, meta: &RecordingMeta, path: impl AsRef<Path>) -> PathBuf {
        meta.project_path.join(path)
    }

    pub fn cursor_events(&self, meta: &RecordingMeta) -> CursorEvents {
        let Some(cursor_path) = &self.cursor else {
            return CursorEvents::default();
        };

        let full_path = self.path(meta, cursor_path);
        println!("Loading cursor data from: {:?}", full_path);

        // Try to load the cursor data
        match CursorEvents::load_from_file(&full_path) {
            Ok(data) => data,
            Err(e) => {
                eprintln!("Failed to load cursor data: {}", e);
                CursorEvents::default()
            }
        }
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
