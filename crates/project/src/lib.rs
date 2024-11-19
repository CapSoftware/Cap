mod configuration;
mod cursor;

pub use configuration::*;
pub use cursor::*;

use either::Either;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::PathBuf;

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
pub struct RecordingSegment {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingMeta {
    // this field is just for convenience, it shouldn't be persisted
    #[serde(skip_serializing, default)]
    pub project_path: PathBuf,
    pub pretty_name: String,
    #[serde(default)]
    pub sharing: Option<SharingMeta>,
    pub display: Display,
    #[serde(default)]
    pub camera: Option<CameraMeta>,
    #[serde(default)]
    pub audio: Option<AudioMeta>,
    #[serde(default)]
    pub segments: Vec<RecordingSegment>,
    pub cursor: Option<PathBuf>,
}

impl RecordingMeta {
    pub fn load_for_project(project_path: &PathBuf) -> Result<Self, String> {
        let meta_path = project_path.join("recording-meta.json");
        let meta = match std::fs::read_to_string(&meta_path) {
            Ok(content) => content,
            Err(_) => {
                return Ok(Self {
                    project_path: project_path.clone(),
                    pretty_name: String::new(),
                    sharing: None,
                    display: Display {
                        path: PathBuf::new(),
                    },
                    camera: None,
                    audio: None,
                    segments: Vec::new(),
                    cursor: None,
                });
            }
        };
        let mut meta: Self = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
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

    pub fn cursor_data(&self) -> CursorData {
        let Some(cursor_path) = &self.cursor else {
            return CursorData::default();
        };

        let full_path = self.project_path.join(cursor_path);
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
        let cursors_dir = self.project_path.join("content").join("cursors");
        if data.cursor_images.is_empty() && cursors_dir.exists() {
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
                                .insert(id.to_string(), filename.to_string_lossy().into_owned());
                        }
                    }
                }
            }
            println!("Found {} cursor images", data.cursor_images.len());
        }
        data
    }
}
