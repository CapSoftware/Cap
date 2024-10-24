use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Serialize, Deserialize, Clone, Type, Debug)]
pub struct CursorEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_id: String,
    pub process_time_ms: f64,
    pub unix_time_ms: f64,
    pub x: f64,
    pub y: f64,
}

#[derive(Default, Serialize, Deserialize)]
pub struct CursorData {
    pub clicks: Vec<CursorEvent>,
    pub moves: Vec<CursorEvent>,
}
