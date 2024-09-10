mod configuration;

use std::path::PathBuf;

pub use configuration::*;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Display {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Camera {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Audio {
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Sharing {
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
    pub sharing: Option<Sharing>,
    pub display: Display,
    #[serde(default)]
    pub camera: Option<Camera>,
    #[serde(default)]
    pub audio: Option<Audio>,
}

impl RecordingMeta {
    pub fn load_for_project(project_path: &PathBuf) -> Result<Self, String> {
        let meta_path = project_path.join("recording-meta.json");
        let meta = std::fs::read_to_string(meta_path).map_err(|e| e.to_string())?;
        let mut meta: Self = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
        meta.project_path = project_path.clone();
        Ok(meta)
    }

    pub fn save_for_project(&self) {
        let meta_path = &self.project_path.join("recording-meta.json");
        let meta = serde_json::to_string_pretty(&self).unwrap();
        std::fs::write(meta_path, meta).unwrap();
    }
}
