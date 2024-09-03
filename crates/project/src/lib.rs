mod configuration;

pub use configuration::*;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Copy)]
pub struct Display {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Copy)]
pub struct Camera {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Copy)]
pub struct RecordingMeta {
    pub display: Display,
    pub camera: Option<Camera>,
    #[serde(default)]
    pub has_audio: bool,
}
