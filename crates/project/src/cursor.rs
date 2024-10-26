use serde::{Deserialize, Serialize};
use serde_json;
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct CursorEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorData {
    pub clicks: Vec<CursorEvent>,
    pub moves: Vec<CursorEvent>,
    pub cursor_images: HashMap<String, String>,
}

impl CursorData {
    // Add a helper method to load from a file
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {}", e))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {}", e))
    }
}
