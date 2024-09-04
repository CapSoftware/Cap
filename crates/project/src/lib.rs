mod configuration;

use std::path::PathBuf;

pub use configuration::*;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Display {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Camera {
    pub path: PathBuf,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Audio {
    pub path: PathBuf,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct RecordingMeta {
    pub display: Display,
    #[serde(default)]
    pub camera: Option<Camera>,
    #[serde(default)]
    pub audio: Option<Audio>,
}

impl RecordingMeta {
    pub fn load_for_project(project_path: &PathBuf) -> Self {
        let meta_path = project_path.join("recording-meta.json");
        let meta = std::fs::read_to_string(meta_path).unwrap();
        serde_json::from_str(&meta).unwrap()
    }
}
