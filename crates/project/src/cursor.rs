use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub const SHORT_CURSOR_SHAPE_DEBOUNCE_MS: f64 = 1000.0;
pub const MIN_VISIBLE_CURSOR_SHAPE_MS: f64 = 150.0;
use std::fs::File;
use std::io::{BufReader, Read};
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
        serde_json::from_reader(BufReader::new(file))
            .map_err(|e| format!("Failed to parse cursor data: {e}"))
    }
}

#[derive(Default, Serialize, Deserialize, Debug, Clone)]
pub struct CursorEvents {
    pub clicks: Vec<CursorClickEvent>,
    pub moves: Vec<CursorMoveEvent>,
}

impl CursorEvents {
    pub fn load_clicks_from_file(path: &Path) -> Result<Vec<CursorClickEvent>, String> {
        #[derive(Deserialize)]
        struct Clicks {
            clicks: Vec<CursorClickEvent>,
        }

        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        deserialize_cursor_file::<Clicks>(file)
            .map(|events| events.clicks)
            .map_err(|e| format!("Failed to parse cursor clicks: {e}"))
    }

    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Failed to open cursor file: {e}"))?;
        deserialize_cursor_file(file).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }

    pub fn load_from_reader(reader: impl std::io::Read) -> Result<Self, String> {
        serde_json::from_reader(reader).map_err(|e| format!("Failed to parse cursor data: {e}"))
    }

    pub fn stabilize_short_lived_cursor_shapes(
        &mut self,
        pointer_ids: Option<&HashSet<String>>,
        threshold_ms: f64,
    ) {
        let Some(mut segments) = self.shape_segments() else {
            return;
        };
        let rest_id = rest_cursor_id(&segments, pointer_ids);

        for i in 0..segments.len() {
            let segment_id = segments[i].id.clone();
            let is_pointer_segment = pointer_ids
                .map(|set| set.contains(&segment_id))
                .unwrap_or(false);

            if segments[i].duration >= threshold_ms || is_pointer_segment {
                continue;
            }

            let replacement = rest_id
                .clone()
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
                event.cursor_id.clone_from(&replacement);
            }
            segments[i].id = replacement;
        }

        self.assign_click_shapes(&segments);
    }

    /// Shows every shape the recording captured, except that no shape is shown
    /// for less than `min_visible_ms` between the first and last: a shorter
    /// non-pointer shape becomes the pointer, and a shorter pointer gap
    /// between two other shapes keeps the shape before it. Moving across a
    /// row of buttons or the edge of a text field then shows no flashes,
    /// while a hover the user paused on keeps its shape.
    pub fn hold_brief_cursor_shapes(
        &mut self,
        pointer_ids: Option<&HashSet<String>>,
        min_visible_ms: f64,
    ) {
        let Some(mut segments) = self.shape_segments() else {
            return;
        };
        let Some(rest_id) = rest_cursor_id(&segments, pointer_ids) else {
            return;
        };
        let is_pointer =
            |id: &str| id == rest_id || pointer_ids.is_some_and(|set| set.contains(id));
        for segment in &mut segments {
            if segment.duration < min_visible_ms && !is_pointer(&segment.id) {
                segment.id.clone_from(&rest_id);
            }
        }

        let mut runs: Vec<ShapeRun> = Vec::new();
        for (index, segment) in segments.iter().enumerate() {
            match runs.last_mut() {
                Some(run) if segments[run.first].id == segment.id => {
                    run.end = index + 1;
                    run.duration += segment.duration;
                }
                _ => runs.push(ShapeRun {
                    first: index,
                    end: index + 1,
                    duration: segment.duration,
                    pointer: is_pointer(&segment.id),
                }),
            }
        }

        for r in 1..runs.len().saturating_sub(1) {
            let run = &runs[r];
            if !run.pointer
                || run.duration >= min_visible_ms
                || runs[r - 1].pointer
                || runs[r + 1].pointer
            {
                continue;
            }
            let held = segments[runs[r - 1].first].id.clone();
            for segment in &mut segments[run.first..run.end] {
                segment.id.clone_from(&held);
            }
        }

        for segment in &segments {
            let range = segment.range.clone();
            if self.moves[range.start].cursor_id != segment.id {
                for event in &mut self.moves[range] {
                    event.cursor_id.clone_from(&segment.id);
                }
            }
        }

        self.assign_click_shapes(&segments);
    }

    fn shape_segments(&self) -> Option<Vec<CursorSegment>> {
        if self.moves.len() < 2 {
            return None;
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
            return None;
        }

        let last_move_time = self.moves.last().map(|event| event.time_ms).unwrap_or(0.0);
        let final_segment = segments.last().unwrap();
        let last_confirmed_time = self
            .clicks
            .iter()
            .filter(|click| click.cursor_id == final_segment.id)
            .map(|click| click.time_ms)
            .fold(last_move_time, f64::max);

        for i in 0..segments.len() {
            let end_time = if i + 1 < segments.len() {
                segments[i + 1].start_time
            } else {
                last_confirmed_time
            };

            let duration = (end_time - segments[i].start_time).max(0.0);
            segments[i].duration = duration;
            segments[i].end_time = if i + 1 < segments.len() {
                end_time
            } else {
                f64::MAX
            };
        }

        Some(segments)
    }

    fn assign_click_shapes(&mut self, segments: &[CursorSegment]) {
        let mut segment_index = 0;
        for click in &mut self.clicks {
            while segment_index + 1 < segments.len()
                && click.time_ms >= segments[segment_index].end_time
            {
                segment_index += 1;
            }

            click.cursor_id.clone_from(&segments[segment_index].id);
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
        }
    }
}

const MAX_BUFFERED_CURSOR_FILE_BYTES: u64 = 8 * 1024 * 1024;

fn deserialize_cursor_file<T: serde::de::DeserializeOwned>(file: File) -> serde_json::Result<T> {
    if let Ok(metadata) = file.metadata()
        && metadata.is_file()
        && metadata.len() <= MAX_BUFFERED_CURSOR_FILE_BYTES
    {
        return deserialize_buffered_cursor_json(file, metadata.len() as usize);
    }
    serde_json::from_reader(BufReader::new(file))
}

fn deserialize_buffered_cursor_json<T: serde::de::DeserializeOwned>(
    reader: impl Read,
    initial_size: usize,
) -> serde_json::Result<T> {
    let mut reader = reader.take(MAX_BUFFERED_CURSOR_FILE_BYTES + 1);
    let mut bytes = Vec::with_capacity(initial_size + 1);
    reader
        .read_to_end(&mut bytes)
        .map_err(serde_json::Error::io)?;
    if bytes.len() as u64 <= MAX_BUFFERED_CURSOR_FILE_BYTES {
        // The reader and slice parsers report different columns for some malformed numbers.
        return serde_json::from_slice(&bytes)
            .or_else(|_| serde_json::from_reader(bytes.as_slice()));
    }
    // A file can grow after metadata is read; keep the prefix and stream the remainder.
    serde_json::from_reader(BufReader::new(
        std::io::Cursor::new(bytes).chain(reader.into_inner()),
    ))
}

#[derive(Clone)]
struct CursorSegment {
    range: Range<usize>,
    start_time: f64,
    end_time: f64,
    duration: f64,
    id: String,
}

struct ShapeRun {
    first: usize,
    end: usize,
    duration: f64,
    pointer: bool,
}

fn rest_cursor_id(
    segments: &[CursorSegment],
    pointer_ids: Option<&HashSet<String>>,
) -> Option<String> {
    let preferred_pointer = pointer_ids.and_then(|set| {
        segments
            .iter()
            .find(|segment| set.contains(&segment.id))
            .map(|segment| segment.id.clone())
    });
    if preferred_pointer.is_some() {
        return preferred_pointer;
    }

    let mut duration_by_id = HashMap::<String, f64>::new();
    for segment in segments {
        *duration_by_id.entry(segment.id.clone()).or_default() += segment.duration;
    }
    duration_by_id
        .iter()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(id, _)| id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffered_load_preserves_events_and_legacy_images_across_read_boundaries() {
        let data = CursorData {
            clicks: vec![click_event(0.0, "pointer"), click_event(9876.5, "文字🖱")],
            moves: (0..2000)
                .map(|index| move_event(f64::from(index) * 16.67, "文字🖱"))
                .collect(),
            cursor_images: CursorImages(HashMap::from([(
                "文字🖱".to_string(),
                CursorImage {
                    path: "cursors/文字.png".into(),
                    hotspot: XY::new(0.125, 0.75),
                },
            )])),
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");
        let json = serde_json::to_vec(&data).unwrap();
        std::fs::write(&path, &json).unwrap();

        let expected: CursorData = serde_json::from_reader(File::open(&path).unwrap()).unwrap();
        let events = CursorEvents::load_from_file(&path).unwrap();
        assert_eq!(events.moves, expected.moves);
        assert_eq!(events.clicks, expected.clicks);
        assert_eq!(
            CursorEvents::load_clicks_from_file(&path).unwrap(),
            expected.clicks
        );
        let legacy = CursorData::load_from_file(&path).unwrap();
        assert_eq!(
            serde_json::to_value(legacy).unwrap(),
            serde_json::to_value(expected).unwrap()
        );

        let events_json = serde_json::to_vec(&events).unwrap();
        std::fs::write(&path, events_json).unwrap();
        let expected: CursorEvents = serde_json::from_reader(File::open(&path).unwrap()).unwrap();
        let loaded_events = CursorEvents::load_from_file(&path).unwrap();
        assert_eq!(loaded_events.moves, expected.moves);
        assert_eq!(loaded_events.clicks, expected.clicks);
        assert_eq!(
            CursorEvents::load_clicks_from_file(&path).unwrap(),
            expected.clicks
        );
    }

    #[test]
    fn click_only_load_rejects_incomplete_files_and_invalid_clicks() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");
        assert!(CursorEvents::load_clicks_from_file(&path).is_err());
        for json in [
            r#"{"clicks":[],"moves":["#,
            r#"{"clicks":[{}],"moves":[]}"#,
            r#"{"clicks":[],"moves":[]} trailing"#,
            r#"{"moves":[]}"#,
        ] {
            std::fs::write(&path, json).unwrap();
            assert!(
                CursorEvents::load_clicks_from_file(&path).is_err(),
                "{json}"
            );
        }
    }

    #[test]
    fn buffered_load_preserves_parse_and_open_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.json");
        for json in [
            "",
            "{",
            r#"{"moves":[],"clicks":[]} trailing"#,
            r#"{"moves":[{"time_ms":1e999}],"clicks":[]}"#,
            r#"{"moves":[],"clicks":[],"cursor_images":null}"#,
        ] {
            for padding in [0, 8191, 8192] {
                std::fs::write(&path, format!("{}{json}", " ".repeat(padding))).unwrap();
                let expected_events =
                    serde_json::from_reader::<_, CursorEvents>(File::open(&path).unwrap())
                        .map_err(|error| format!("Failed to parse cursor data: {error}"));
                assert_eq!(
                    CursorEvents::load_from_file(&path).err(),
                    expected_events.err()
                );
                let expected_legacy =
                    serde_json::from_reader::<_, CursorData>(File::open(&path).unwrap())
                        .map_err(|error| format!("Failed to parse cursor data: {error}"));
                assert_eq!(
                    CursorData::load_from_file(&path).err(),
                    expected_legacy.err()
                );
            }
        }
        let missing = dir.path().join("missing.json");
        let expected = format!(
            "Failed to open cursor file: {}",
            File::open(&missing).unwrap_err()
        );
        assert_eq!(
            CursorEvents::load_from_file(&missing).unwrap_err(),
            expected
        );
        assert_eq!(CursorData::load_from_file(&missing).unwrap_err(), expected);
    }

    #[test]
    fn buffered_cursor_parser_preserves_the_remainder_after_growth() {
        let click = click_event(12.5, "文字🖱");
        let mut bytes = br#"{"moves":[],"clicks":["#.to_vec();
        bytes.resize(MAX_BUFFERED_CURSOR_FILE_BYTES as usize + 1, b' ');
        bytes.extend_from_slice(&serde_json::to_vec(&click).unwrap());
        bytes.extend_from_slice(b"]}");
        let actual: CursorEvents = deserialize_buffered_cursor_json(bytes.as_slice(), 0).unwrap();
        assert!(actual.moves.is_empty());
        assert_eq!(actual.clicks, vec![click]);

        let prefix = br#"{"moves":[],"clicks":[]}"#;
        bytes.clear();
        bytes.extend_from_slice(prefix);
        bytes.resize(MAX_BUFFERED_CURSOR_FILE_BYTES as usize + 1, b' ');
        bytes.push(b'!');
        let actual =
            deserialize_buffered_cursor_json::<CursorEvents>(bytes.as_slice(), prefix.len());
        let expected = serde_json::from_reader::<_, CursorEvents>(bytes.as_slice());
        assert_eq!(
            actual.unwrap_err().to_string(),
            expected.unwrap_err().to_string()
        );
    }

    #[test]
    fn cursor_file_parsing_matches_streaming_at_the_buffer_limit() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cursor.json");
        let events = CursorEvents {
            clicks: vec![click_event(12.5, "文字🖱")],
            moves: vec![move_event(0.125, "文字🖱")],
        };
        let json = serde_json::to_vec(&events).unwrap();
        for length in [
            json.len(),
            MAX_BUFFERED_CURSOR_FILE_BYTES as usize - 1,
            MAX_BUFFERED_CURSOR_FILE_BYTES as usize,
            MAX_BUFFERED_CURSOR_FILE_BYTES as usize + 1,
        ] {
            let mut bytes = vec![b' '; length - json.len()];
            bytes.extend_from_slice(&json);
            std::fs::write(&path, &bytes).unwrap();
            let loaded = CursorEvents::load_from_file(&path).unwrap();
            assert_eq!(loaded.moves, events.moves);
            assert_eq!(loaded.clicks, events.clicks);
            assert_eq!(
                CursorEvents::load_clicks_from_file(&path).unwrap(),
                events.clicks
            );

            bytes.push(b'!');
            std::fs::write(&path, &bytes).unwrap();
            let expected =
                CursorEvents::load_from_reader(BufReader::new(File::open(&path).unwrap()));
            assert_eq!(
                CursorEvents::load_from_file(&path).unwrap_err(),
                expected.unwrap_err()
            );
            assert!(CursorEvents::load_clicks_from_file(&path).is_err());
        }
    }

    #[test]
    fn slice_cursor_parsing_preserves_malformed_input_errors() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("cursor.json");
        for json in [
            br#"{"clicks":[],"moves":[],"unknown":"\uD800"}"#.as_slice(),
            b"{\"clicks\":[],\"moves\":[],\"unknown\":\"\xff\"}",
            br#"{"clicks":[],"moves":[],"unknown":1e999}"#,
            br#"{"clicks":[],"moves":[{"active_modifiers":[],"cursor_id":"0","time_ms":1.25,"x":0.125,"y":-0.0}],"moves":[]}"#,
            r#"{"clicks":[],"moves":[],"unknown":[true,false,null,{"value":"文字"}]}"#.as_bytes(),
        ] {
            std::fs::write(&path, json).unwrap();
            let expected = CursorEvents::load_from_reader(BufReader::new(File::open(&path).unwrap()));
            let actual = CursorEvents::load_from_file(&path);
            match (actual, expected) {
                (Ok(actual), Ok(expected)) => assert_eq!(serde_json::to_vec(&actual).unwrap(), serde_json::to_vec(&expected).unwrap()),
                (Err(actual), Err(expected)) => assert_eq!(actual, expected),
                values => panic!("different parsing outcomes: {values:?}"),
            }
        }
    }

    #[test]
    fn cursor_reader_preserves_unicode_and_events_across_short_reads() {
        struct ShortReads<'a>(&'a [u8]);

        impl std::io::Read for ShortReads<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = buffer.len().min(3).min(self.0.len());
                buffer[..count].copy_from_slice(&self.0[..count]);
                self.0 = &self.0[count..];
                Ok(count)
            }
        }

        let expected = CursorData {
            clicks: vec![click_event(12.5, "文字🖱")],
            moves: vec![move_event(1.25, "文字🖱"), move_event(99.75, "pointer")],
            cursor_images: CursorImages::default(),
        };
        let bytes = serde_json::to_vec(&expected).unwrap();
        let events = CursorEvents::load_from_reader(ShortReads(&bytes)).unwrap();
        assert_eq!(events.clicks, expected.clicks);
        assert_eq!(events.moves, expected.moves);
    }

    #[test]
    fn cursor_reader_does_not_turn_late_input_failure_into_success() {
        struct FailingReader {
            prefix: std::io::Cursor<Vec<u8>>,
        }

        impl std::io::Read for FailingReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let count = std::io::Read::read(&mut self.prefix, buffer)?;
                if count == 0 {
                    return Err(std::io::Error::other("retained source failed"));
                }
                Ok(count)
            }
        }

        let bytes = serde_json::to_vec(&CursorEvents::default()).unwrap();
        let error = CursorEvents::load_from_reader(FailingReader {
            prefix: std::io::Cursor::new(bytes),
        })
        .unwrap_err();
        assert!(error.starts_with("Failed to parse cursor data: "));
        assert!(error.contains("retained source failed"));
    }

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
    fn stabilization_preserves_event_fields_when_replacing_different_length_ids() {
        for (pointer, other) in [
            (String::from("0"), "1".into()),
            ("123".into(), "4".into()),
            ("a".into(), "🖱".into()),
            ("".into(), "old".into()),
            ("pointer".into(), "x".repeat(65_536)),
        ] {
            let pointers = HashSet::from([pointer.clone()]);
            let mut events = CursorEvents {
                moves: vec![
                    move_event(0.0, &pointer),
                    move_event(200.0, &other),
                    move_event(300.0, &other),
                    move_event(400.0, &pointer),
                ],
                clicks: vec![click_event(250.0, &other), click_event(1500.0, &pointer)],
            };
            events.moves[1].x = f64::from_bits(0x7ff8_0000_0000_1234);
            events.moves[2].y = -0.0;
            events.moves[1].active_modifiers = vec!["LShift".into()];
            events.clicks[0].active_modifiers = vec!["LMeta".into()];
            let mut expected = events.clone();
            for event in &mut expected.moves {
                event.cursor_id = pointer.clone();
            }
            for event in &mut expected.clicks {
                event.cursor_id = pointer.clone();
            }
            events.stabilize_short_lived_cursor_shapes(Some(&pointers), 1_000.0);
            assert_eq!(
                bincode::serde::encode_to_vec(&events, bincode::config::standard()).unwrap(),
                bincode::serde::encode_to_vec(&expected, bincode::config::standard()).unwrap()
            );
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
        };

        events.stabilize_short_lived_cursor_shapes(
            Some(&pointer_ids),
            SHORT_CURSOR_SHAPE_DEBOUNCE_MS,
        );

        assert_eq!(events.moves[1].cursor_id, "ibeam");
        assert_eq!(events.clicks[0].cursor_id, "ibeam");
    }

    #[test]
    fn final_shape_is_preserved_when_a_later_click_confirms_its_duration() {
        let pointer_ids = HashSet::from(["pointer".to_string()]);
        let mut events = CursorEvents {
            moves: vec![move_event(0.0, "pointer"), move_event(1500.0, "ibeam")],
            clicks: vec![click_event(2700.0, "ibeam")],
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

    fn shapes(events: &CursorEvents) -> Vec<&str> {
        events
            .moves
            .iter()
            .map(|event| event.cursor_id.as_str())
            .collect()
    }

    fn timeline(steps: &[(f64, &str)]) -> CursorEvents {
        CursorEvents {
            moves: steps
                .iter()
                .map(|&(time_ms, id)| move_event(time_ms, id))
                .collect(),
            clicks: vec![],
        }
    }

    fn hold(events: &mut CursorEvents) {
        let pointers = HashSet::from(["arrow".to_string()]);
        events.hold_brief_cursor_shapes(Some(&pointers), MIN_VISIBLE_CURSOR_SHAPE_MS);
    }

    #[test]
    fn a_hover_the_user_paused_on_keeps_its_shape() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "hand"),
            (1300.0, "hand"),
            (1569.0, "arrow"),
            (3000.0, "arrow"),
        ]);
        hold(&mut events);
        assert_eq!(shapes(&events), ["arrow", "hand", "hand", "arrow", "arrow"]);
    }

    #[test]
    fn sweeping_across_buttons_shows_no_hand_flashes() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "hand"),
            (1080.0, "arrow"),
            (1110.0, "hand"),
            (1200.0, "arrow"),
            (1240.0, "hand"),
            (1280.0, "arrow"),
            (3000.0, "arrow"),
        ]);
        hold(&mut events);
        assert!(shapes(&events).iter().all(|id| *id == "arrow"));
    }

    #[test]
    fn ibeam_and_arrow_toggling_over_text_stays_an_ibeam() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "ibeam"),
            (1400.0, "arrow"),
            (1440.0, "ibeam"),
            (1740.0, "arrow"),
            (1800.0, "ibeam"),
            (2300.0, "arrow"),
            (4000.0, "arrow"),
        ]);
        hold(&mut events);
        assert_eq!(
            shapes(&events),
            [
                "arrow", "ibeam", "ibeam", "ibeam", "ibeam", "ibeam", "arrow", "arrow"
            ]
        );
    }

    #[test]
    fn passing_a_window_edge_drops_the_resize_shape_but_a_resize_drag_keeps_it() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "resize"),
            (1060.0, "arrow"),
            (2000.0, "resize"),
            (2900.0, "arrow"),
            (4000.0, "arrow"),
        ]);
        events.clicks = vec![click_event(1030.0, "resize"), click_event(2100.0, "resize")];
        hold(&mut events);
        assert_eq!(
            shapes(&events),
            ["arrow", "arrow", "arrow", "resize", "arrow", "arrow"]
        );
        assert_eq!(events.clicks[0].cursor_id, "arrow");
        assert_eq!(events.clicks[1].cursor_id, "resize");
    }

    #[test]
    fn a_brief_pointer_gap_between_two_shapes_keeps_the_earlier_shape() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "hand"),
            (1600.0, "arrow"),
            (1640.0, "ibeam"),
            (2600.0, "arrow"),
            (4000.0, "arrow"),
        ]);
        hold(&mut events);
        assert_eq!(
            shapes(&events),
            ["arrow", "hand", "hand", "ibeam", "arrow", "arrow"]
        );
    }

    #[test]
    fn a_pointer_stretch_long_enough_to_see_stays_between_hovers() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "hand"),
            (1600.0, "arrow"),
            (1800.0, "hand"),
            (2400.0, "arrow"),
            (4000.0, "arrow"),
        ]);
        hold(&mut events);
        assert_eq!(
            shapes(&events),
            ["arrow", "hand", "arrow", "hand", "arrow", "arrow"]
        );
    }

    #[test]
    fn holding_uses_the_dominant_cursor_without_pointer_metadata() {
        let mut events = timeline(&[
            (0.0, "arrow"),
            (1000.0, "hand"),
            (1100.0, "arrow"),
            (1200.0, "ibeam"),
            (1900.0, "arrow"),
            (4000.0, "arrow"),
        ]);
        events.hold_brief_cursor_shapes(None, MIN_VISIBLE_CURSOR_SHAPE_MS);
        assert_eq!(
            shapes(&events),
            ["arrow", "arrow", "arrow", "ibeam", "arrow", "arrow"]
        );
    }

    #[test]
    fn holding_never_shows_an_inner_shape_for_less_than_the_minimum() {
        let ids = ["arrow", "hand", "ibeam", "resize"];
        let mut seed = 0x2545_f491_4f6c_dd1d_u64;
        let mut next = |bound: u64| {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed % bound
        };
        for _ in 0..2_000 {
            let mut time_ms = 0.0;
            let mut steps = Vec::new();
            for _ in 0..(2 + next(40)) {
                steps.push((time_ms, ids[next(ids.len() as u64) as usize]));
                time_ms += [5.0, 20.0, 60.0, 140.0, 149.9, 150.0, 400.0, 1200.0][next(8) as usize];
            }
            let mut events = timeline(&steps);
            let original = events.clone();
            hold(&mut events);

            let mut runs: Vec<(String, f64)> = Vec::new();
            for event in &events.moves {
                if runs.last().is_none_or(|(id, _)| *id != event.cursor_id) {
                    runs.push((event.cursor_id.clone(), event.time_ms));
                }
            }
            for window in runs.windows(3) {
                let shown = window[2].1 - window[1].1;
                assert!(
                    shown >= MIN_VISIBLE_CURSOR_SHAPE_MS,
                    "{:?} shows {} for {shown} ms",
                    steps,
                    window[1].0
                );
            }
            for (before, after) in original.moves.iter().zip(&events.moves) {
                assert_eq!(before.time_ms, after.time_ms);
                assert!(
                    after.cursor_id == before.cursor_id || ids.contains(&after.cursor_id.as_str())
                );
            }
        }
    }
}
