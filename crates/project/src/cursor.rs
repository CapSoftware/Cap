use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::ops::Range;

pub const SHORT_CURSOR_SHAPE_DEBOUNCE_MS: f64 = 1000.0;
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
                event.cursor_id.clone_from(&replacement);
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
}
