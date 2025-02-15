use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct CursorMoveEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct CursorClickEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_num: u8,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub down: bool,
    pub x: f64,
    pub y: f64,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
#[serde(transparent)]
pub struct CursorImages(pub HashMap<String, PathBuf>);

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorData {
    pub clicks: Vec<CursorClickEvent>,
    pub moves: Vec<CursorMoveEvent>,
    pub cursor_images: CursorImages,
}

impl CursorData {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {}", e))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {}", e))
    }
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorEvents {
    pub clicks: Vec<CursorClickEvent>,
    pub moves: Vec<CursorMoveEvent>,
}

impl CursorEvents {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {}", e))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {}", e))
    }
}

impl From<CursorData> for CursorEvents {
    fn from(value: CursorData) -> Self {
        Self {
            clicks: value.clicks,
            moves: value.moves,
        }
    }
}
