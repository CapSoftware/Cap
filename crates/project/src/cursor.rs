use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::XY;

#[derive(Serialize, Deserialize, Clone, Type, Debug, PartialEq)]
pub struct CursorMoveEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_id: String,
    pub time_ms: f64,
    pub x: f64,
    pub y: f64,
}

impl PartialOrd for CursorMoveEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
}

#[derive(Serialize, Deserialize, Clone, Type, Debug, PartialEq)]
pub struct CursorClickEvent {
    pub active_modifiers: Vec<String>,
    pub cursor_num: u8,
    pub cursor_id: String,
    pub time_ms: f64,
    pub down: bool,
}

impl PartialOrd for CursorClickEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
#[serde(transparent)]
pub struct CursorImages(pub HashMap<String, CursorImage>);

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorImage {
    pub path: PathBuf,
    pub hotspot: XY<f64>,
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorData {
    pub clicks: Vec<CursorClickEvent>,
    pub moves: Vec<CursorMoveEvent>,
    pub cursor_images: CursorImages,
}

impl CursorData {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorEvents {
    pub clicks: Vec<CursorClickEvent>,
    pub moves: Vec<CursorMoveEvent>,
}

impl CursorEvents {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }

    pub fn cursor_position_at(&self, time: f64) -> Option<XY<f64>> {
        // Debug print to understand what we're looking for
        println!("Looking for cursor position at time: {time}");
        println!("Total cursor events: {}", self.moves.len());

        // Check if we have any move events at all
        if self.moves.is_empty() {
            println!("No cursor move events available");
            return None;
        }

        // Find the move event closest to the given time, preferring events that happened before
        let filtered_events = self
            .moves
            .iter()
            .filter(|event| event.time_ms <= time * 1000.0)
            .collect::<Vec<_>>();

        println!(
            "Found {} events before or at time {}",
            filtered_events.len(),
            time
        );

        if !filtered_events.is_empty() {
            // Take the most recent one before the given time
            let closest = filtered_events
                .iter()
                .max_by(|a, b| {
                    a.time_ms
                        .partial_cmp(&b.time_ms)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .unwrap();

            println!(
                "Selected event at time {} with pos ({}, {})",
                closest.time_ms, closest.x, closest.y
            );

            return Some(XY::new(closest.x, closest.y));
        }

        // If no events happened before, find the earliest one
        let earliest = self.moves.iter().min_by(|a, b| {
            a.time_ms
                .partial_cmp(&b.time_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        if let Some(event) = earliest {
            println!(
                "No events before requested time, using earliest at {} with pos ({}, {})",
                event.time_ms, event.x, event.y
            );
            return Some(XY::new(event.x, event.y));
        }

        println!("Could not find any usable cursor position");
        None
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
