mod configuration;
mod cursor;

pub use configuration::*;
pub use cursor::*;

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

    pub fn save_for_project(&self) {
        let meta_path = &self.project_path.join("recording-meta.json");
        let meta = serde_json::to_string_pretty(&self).unwrap();
        std::fs::write(meta_path, meta).unwrap();
    }

    pub fn project_config(&self) -> ProjectConfiguration {
        std::fs::read_to_string(self.project_path.join("project-config.json"))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn cursor_data(&self) -> CursorData {
        self.cursor
            .as_ref()
            .and_then(|c| std::fs::read(self.project_path.join(c)).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }
}
