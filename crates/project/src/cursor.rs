use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub const SHORT_CURSOR_SHAPE_DEBOUNCE_MS: f64 = 1000.0;
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

#[derive(Serialize, Deserialize, Clone, Type, Debug, PartialEq)]
pub struct KeyboardEvent {
    pub active_modifiers: Vec<String>,
    pub key: String,
    pub time_ms: f64,
    pub down: bool,
}

impl PartialOrd for KeyboardEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
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
    #[serde(default)]
    pub keyboard: Vec<KeyboardEvent>,
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
    #[serde(default)]
    pub keyboard: Vec<KeyboardEvent>,
}

impl CursorEvents {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }

    pub fn stabilize_short_lived_cursor_shapes(
        &mut self,
        pointer_ids: Option<&HashSet<String>>,
        threshold_ms: f64,
    ) {
        if self.moves.len() < 2 {
            return;
        }

        let mut segments: Vec<CursorSegment> = Vec::new();
        let mut idx = 0;

        while idx < self.moves.len() {
            let start_index = idx;
            let start_time = self.moves[idx].time_ms;
            let id = self.moves[idx].cursor_id.clone();

            idx += 1;
            while idx < self.moves.len() && self.moves[idx].cursor_id == id {
                idx += 1;
            }

            segments.push(CursorSegment {
                range: start_index..idx,
                start_time,
                end_time: 0.0,
                duration: 0.0,
                id,
            });
        }

        if segments.len() < 2 {
            return;
        }

        let last_move_time = self.moves.last().map(|event| event.time_ms).unwrap_or(0.0);

        for i in 0..segments.len() {
            let end_time = if i + 1 < segments.len() {
                segments[i + 1].start_time
            } else {
                last_move_time
            };

            let duration = (end_time - segments[i].start_time).max(0.0);
            segments[i].duration = duration;
            segments[i].end_time = if i + 1 < segments.len() {
                end_time
            } else {
                f64::MAX
            };
        }

        let mut duration_by_id = HashMap::<String, f64>::new();
        for segment in &segments {
            *duration_by_id.entry(segment.id.clone()).or_default() += segment.duration;
        }

        let preferred_pointer = pointer_ids.and_then(|set| {
            segments
                .iter()
                .find(|segment| set.contains(&segment.id))
                .map(|segment| segment.id.clone())
        });

        let global_fallback = duration_by_id
            .iter()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
            .map(|(id, _)| id.clone());

        for i in 0..segments.len() {
            let segment_id = segments[i].id.clone();
            let is_pointer_segment = pointer_ids
                .map(|set| set.contains(&segment_id))
                .unwrap_or(false);

            if segments[i].duration >= threshold_ms || is_pointer_segment {
                continue;
            }

            let replacement = preferred_pointer
                .clone()
                .or_else(|| global_fallback.clone())
                .or_else(|| {
                    if i > 0 {
                        Some(segments[i - 1].id.clone())
                    } else {
                        None
                    }
                })
                .or_else(|| segments.get(i + 1).map(|segment| segment.id.clone()))
                .unwrap_or_else(|| segment_id.clone());

            if replacement == segment_id {
                continue;
            }

            for event in &mut self.moves[segments[i].range.clone()] {
                event.cursor_id = replacement.clone();
            }
            segments[i].id = replacement;
        }

        if self.clicks.is_empty() {
            return;
        }

        let mut segment_index = 0;
        for click in &mut self.clicks {
            while segment_index + 1 < segments.len()
                && click.time_ms >= segments[segment_index].end_time
            {
                segment_index += 1;
            }

            click.cursor_id = segments[segment_index].id.clone();
        }
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
            keyboard: value.keyboard,
        }
    }
}

#[derive(Clone)]
struct CursorSegment {
    range: Range<usize>,
    start_time: f64,
    end_time: f64,
    duration: f64,
    id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn move_event(time_ms: f64, cursor_id: &str) -> CursorMoveEvent {
        CursorMoveEvent {
            active_modifiers: vec![],
            cursor_id: cursor_id.to_string(),
            time_ms,
            x: 0.0,
            y: 0.0,
        }
    }

    fn click_event(time_ms: f64, cursor_id: &str) -> CursorClickEvent {
        CursorClickEvent {
            active_modifiers: vec![],
            cursor_id: cursor_id.to_string(),
            cursor_num: 0,
            down: true,
            time_ms,
        }
    }

    #[test]
    fn short_lived_segments_are_replaced_with_pointer() {
        let mut pointer_ids = HashSet::new();
        pointer_ids.insert("pointer".to_string());

        let mut events = CursorEvents {
            moves: vec![
                move_event(0.0, "pointer"),
                move_event(200.0, "ibeam"),
                move_event(400.0, "pointer"),
                move_event(900.0, "pointer"),
            ],
            clicks: vec![click_event(250.0, "ibeam")],
            keyboard: vec![],
        };

        events.stabilize_short_lived_cursor_shapes(
            Some(&pointer_ids),
            SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
        );

        assert!(
            events
                .moves
                .iter()
                .all(|event| event.cursor_id == "pointer")
        );
        assert!(
            events
                .clicks
                .iter()
                .all(|event| event.cursor_id == "pointer")
        );
    }

    #[test]
    fn longer_segments_are_preserved() {
        let mut pointer_ids = HashSet::new();
        pointer_ids.insert("pointer".to_string());

        let mut events = CursorEvents {
            moves: vec![
                move_event(0.0, "pointer"),
                move_event(200.0, "ibeam"),
                move_event(1500.0, "pointer"),
            ],
            clicks: vec![click_event(400.0, "ibeam")],
            keyboard: vec![],
        };

        events.stabilize_short_lived_cursor_shapes(
            Some(&pointer_ids),
            SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
        );

        assert_eq!(events.moves[1].cursor_id, "ibeam");
        assert_eq!(events.clicks[0].cursor_id, "ibeam");
    }

    #[test]
    fn falls_back_to_dominant_cursor_without_pointer_metadata() {
        let mut events = CursorEvents {
            moves: vec![
                move_event(0.0, "pointer"),
                move_event(200.0, "ibeam"),
                move_event(400.0, "pointer"),
                move_event(1200.0, "pointer"),
            ],
            clicks: vec![click_event(250.0, "ibeam")],
            keyboard: vec![],
        };

        events.stabilize_short_lived_cursor_shapes(None, SHORT_CURSOR_SHAPE_DEBOUNCE_MS);

        assert!(
            events
                .moves
                .iter()
                .all(|event| event.cursor_id == "pointer")
        );
        assert!(
            events
                .clicks
                .iter()
                .all(|event| event.cursor_id == "pointer")
        );
    }
}
