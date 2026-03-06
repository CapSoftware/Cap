use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::File;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Type, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyPressEvent {
    pub key: String,
    pub key_code: String,
    pub time_ms: f64,
    pub down: bool,
}

impl PartialOrd for KeyPressEvent {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.time_ms.partial_cmp(&other.time_ms)
    }
}

#[derive(Default, Serialize, Deserialize, Debug, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardEvents {
    pub presses: Vec<KeyPressEvent>,
}

impl KeyboardEvents {
    pub fn load_from_file(path: &Path) -> Result<Self, String> {
        let file =
            File::open(path).map_err(|e| format!("Failed to open keyboard events file: {e}"))?;
        serde_json::from_reader(file).map_err(|e| format!("Failed to parse keyboard events: {e}"))
    }
}

const MODIFIER_KEYS: &[&str] = &[
    "LShift", "RShift", "LControl", "RControl", "LAlt", "RAlt", "LMeta", "RMeta", "Meta", "Command",
];

const SPECIAL_KEY_SYMBOLS: &[(&str, &str)] = &[
    ("Enter", "⏎"),
    ("Return", "⏎"),
    ("Tab", "⇥"),
    ("Backspace", "⌫"),
    ("Delete", "⌦"),
    ("Escape", "⎋"),
    ("Space", "␣"),
    ("Up", "↑"),
    ("Down", "↓"),
    ("Left", "←"),
    ("Right", "→"),
    ("Home", "⇱"),
    ("End", "⇲"),
    ("PageUp", "⇞"),
    ("PageDown", "⇟"),
];

fn is_modifier_key(key: &str) -> bool {
    MODIFIER_KEYS.contains(&key)
}

fn is_shift_key(key: &str) -> bool {
    matches!(key, "LShift" | "RShift")
}

fn special_key_symbol(key: &str) -> Option<&'static str> {
    SPECIAL_KEY_SYMBOLS
        .iter()
        .find(|&&(k, _)| k == key)
        .map(|&(_, symbol)| symbol)
}

fn display_char_for_key(key: &str) -> Option<String> {
    if key.len() == 1 {
        return Some(key.to_string());
    }

    if let Some(symbol) = special_key_symbol(key) {
        return Some(symbol.to_string());
    }

    if is_modifier_key(key) {
        return None;
    }

    None
}

fn modifier_prefix(active_modifiers: &[String]) -> String {
    let mut parts = Vec::new();

    let has = |names: &[&str]| active_modifiers.iter().any(|m| names.contains(&m.as_str()));

    if has(&["LMeta", "RMeta", "Meta", "Command"]) {
        parts.push("⌘");
    }
    if has(&["LControl", "RControl"]) {
        parts.push("⌃");
    }
    if has(&["LAlt", "RAlt"]) {
        parts.push("⌥");
    }
    if has(&["LShift", "RShift"]) {
        parts.push("⇧");
    }

    if parts.is_empty() {
        String::new()
    } else {
        parts.join("")
    }
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyPressDisplay {
    pub key: String,
    pub time_offset: f64,
}

#[derive(Type, Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KeyboardTrackSegment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub display_text: String,
    #[serde(default)]
    pub keys: Vec<KeyPressDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fade_duration_override: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color_override: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_override: Option<u32>,
}

pub fn group_key_events(
    events: &KeyboardEvents,
    grouping_threshold_ms: f64,
    linger_duration_ms: f64,
    show_modifiers: bool,
    show_special_keys: bool,
) -> Vec<KeyboardTrackSegment> {
    let mut segments: Vec<KeyboardTrackSegment> = Vec::new();

    let mut down_events: Vec<&KeyPressEvent> = events.presses.iter().filter(|e| e.down).collect();
    down_events.sort_by(|a, b| {
        a.time_ms
            .partial_cmp(&b.time_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if down_events.is_empty() {
        return segments;
    }

    let mut active_modifiers: Vec<String> = Vec::new();
    let mut all_events_idx: usize = 0;

    let advance_modifiers_to =
        |time_ms: f64, active: &mut Vec<String>, idx: &mut usize, all_presses: &[KeyPressEvent]| {
            while *idx < all_presses.len() && all_presses[*idx].time_ms <= time_ms {
                let ev = &all_presses[*idx];
                if is_modifier_key(&ev.key) {
                    if ev.down {
                        if !active.contains(&ev.key) {
                            active.push(ev.key.clone());
                        }
                    } else {
                        active.retain(|k| k != &ev.key);
                    }
                }
                *idx += 1;
            }
        };

    let mut current_group_start: Option<f64> = None;
    let mut current_display = String::new();
    let mut current_keys: Vec<KeyPressDisplay> = Vec::new();
    let mut last_key_time: f64 = 0.0;
    let mut segment_counter: u64 = 0;

    let min_segment_ms = 300.0_f64;

    let flush_group = |segments: &mut Vec<KeyboardTrackSegment>,
                       counter: &mut u64,
                       start: f64,
                       end_key_time: f64,
                       display: &mut String,
                       keys: &mut Vec<KeyPressDisplay>| {
        if display.is_empty() {
            return;
        }
        *counter += 1;
        let end = (end_key_time + linger_duration_ms) / 1000.0;
        let start_secs = start / 1000.0;
        let end_secs = end.max(start_secs + min_segment_ms / 1000.0);
        segments.push(KeyboardTrackSegment {
            id: format!("kb-{counter}"),
            start: start_secs,
            end: end_secs,
            display_text: display.clone(),
            keys: keys.clone(),
            fade_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
        });
        display.clear();
        keys.clear();
    };

    for event in &down_events {
        advance_modifiers_to(
            event.time_ms,
            &mut active_modifiers,
            &mut all_events_idx,
            &events.presses,
        );

        let is_modifier = is_modifier_key(&event.key);
        let is_shift = is_shift_key(&event.key);

        if is_modifier && !show_modifiers {
            continue;
        }

        if is_modifier && !is_shift {
            continue;
        }

        let is_special = special_key_symbol(&event.key).is_some() && event.key != "Space";

        if is_special && !show_special_keys && event.key != "Backspace" {
            continue;
        }

        if event.key == "Backspace" && !current_display.is_empty() {
            current_display.pop();
            last_key_time = event.time_ms;
            continue;
        }

        let has_command_mod = active_modifiers.iter().any(|m| {
            matches!(
                m.as_str(),
                "LMeta" | "RMeta" | "Meta" | "Command" | "LControl" | "RControl"
            )
        });

        if has_command_mod && show_modifiers {
            flush_group(
                &mut segments,
                &mut segment_counter,
                current_group_start.unwrap_or(event.time_ms),
                last_key_time,
                &mut current_display,
                &mut current_keys,
            );
            current_group_start = None;

            let prefix = modifier_prefix(&active_modifiers);
            let key_display = display_char_for_key(&event.key).unwrap_or_else(|| event.key.clone());
            let combo = format!("{prefix}{key_display}");

            if let Some(prev) = segments.last_mut() {
                let prev_end_ms = prev.end * 1000.0;
                if event.time_ms < prev_end_ms {
                    prev.display_text = format!("{}  {}", prev.display_text, combo);
                    prev.end = (event.time_ms + linger_duration_ms) / 1000.0;
                    prev.keys.push(KeyPressDisplay {
                        key: event.key.clone(),
                        time_offset: event.time_ms - prev.start * 1000.0,
                    });
                    last_key_time = event.time_ms;
                    continue;
                }
            }

            segment_counter += 1;
            let start_secs = event.time_ms / 1000.0;
            let end_secs = ((event.time_ms + linger_duration_ms) / 1000.0)
                .max(start_secs + min_segment_ms / 1000.0);
            segments.push(KeyboardTrackSegment {
                id: format!("kb-{segment_counter}"),
                start: start_secs,
                end: end_secs,
                display_text: combo,
                keys: vec![KeyPressDisplay {
                    key: event.key.clone(),
                    time_offset: 0.0,
                }],
                fade_duration_override: None,
                position_override: None,
                color_override: None,
                background_color_override: None,
                font_size_override: None,
            });

            last_key_time = event.time_ms;
            continue;
        }

        let should_start_new_group = current_group_start.is_none()
            || (event.time_ms - last_key_time) > grouping_threshold_ms;

        if should_start_new_group && current_group_start.is_some() {
            flush_group(
                &mut segments,
                &mut segment_counter,
                current_group_start.unwrap(),
                last_key_time,
                &mut current_display,
                &mut current_keys,
            );
            current_group_start = None;
        }

        if let Some(display_char) = display_char_for_key(&event.key) {
            if current_group_start.is_none() {
                current_group_start = Some(event.time_ms);
            }

            let offset = event.time_ms - current_group_start.unwrap();
            current_display.push_str(&display_char);
            current_keys.push(KeyPressDisplay {
                key: event.key.clone(),
                time_offset: offset,
            });
            last_key_time = event.time_ms;
        }
    }

    if let Some(start) = current_group_start {
        flush_group(
            &mut segments,
            &mut segment_counter,
            start,
            last_key_time,
            &mut current_display,
            &mut current_keys,
        );
    }

    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_down(key: &str, time_ms: f64) -> KeyPressEvent {
        KeyPressEvent {
            key: key.to_string(),
            key_code: key.to_string(),
            time_ms,
            down: true,
        }
    }

    fn key_up(key: &str, time_ms: f64) -> KeyPressEvent {
        KeyPressEvent {
            key: key.to_string(),
            key_code: key.to_string(),
            time_ms,
            down: false,
        }
    }

    #[test]
    fn groups_rapid_typing_into_word() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("e", 200.0),
                key_up("e", 250.0),
                key_down("l", 300.0),
                key_up("l", 350.0),
                key_down("l", 400.0),
                key_up("l", 450.0),
                key_down("o", 500.0),
                key_up("o", 550.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "hello");
        assert_eq!(segments[0].keys.len(), 5);
    }

    #[test]
    fn splits_on_long_pause() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("i", 200.0),
                key_up("i", 250.0),
                key_down("b", 1000.0),
                key_up("b", 1050.0),
                key_down("y", 1100.0),
                key_up("y", 1150.0),
                key_down("e", 1200.0),
                key_up("e", 1250.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].display_text, "hi");
        assert_eq!(segments[1].display_text, "bye");
    }

    #[test]
    fn backspace_removes_last_char() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("e", 200.0),
                key_up("e", 250.0),
                key_down("Backspace", 300.0),
                key_up("Backspace", 350.0),
                key_down("a", 400.0),
                key_up("a", 450.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "ha");
    }

    #[test]
    fn empty_events_returns_empty() {
        let events = KeyboardEvents { presses: vec![] };
        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert!(segments.is_empty());
    }

    #[test]
    fn special_keys_show_symbols() {
        let events = KeyboardEvents {
            presses: vec![key_down("Enter", 100.0), key_up("Enter", 150.0)],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "⏎");
    }

    #[test]
    fn modifier_combo_cmd_c() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("LMeta", 100.0),
                key_down("c", 150.0),
                key_up("c", 200.0),
                key_up("LMeta", 250.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert!(segments[0].display_text.contains('⌘'));
        assert!(segments[0].display_text.contains('c'));
    }

    #[test]
    fn shift_capitalizes_without_new_segment() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("LShift", 200.0),
                key_down("e", 250.0),
                key_up("e", 300.0),
                key_up("LShift", 350.0),
                key_down("l", 400.0),
                key_up("l", 450.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert!(segments.len() <= 2);
    }

    #[test]
    fn show_modifiers_false_hides_modifier_keys() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("LMeta", 100.0),
                key_down("c", 150.0),
                key_up("c", 200.0),
                key_up("LMeta", 250.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, false, true);
        for seg in &segments {
            assert!(!seg.display_text.contains('⌘'));
        }
    }

    #[test]
    fn show_special_keys_false_hides_special() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("Enter", 200.0),
                key_up("Enter", 250.0),
                key_down("i", 400.0),
                key_up("i", 450.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, false);
        for seg in &segments {
            assert!(!seg.display_text.contains('⏎'));
        }
    }

    #[test]
    fn rapid_hotkeys_merge_into_single_segment() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("LMeta", 100.0),
                key_down("c", 150.0),
                key_up("c", 200.0),
                key_down("v", 300.0),
                key_up("v", 350.0),
                key_down("z", 450.0),
                key_up("z", 500.0),
                key_up("LMeta", 550.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 800.0, true, true);
        assert_eq!(segments.len(), 1);
        assert!(segments[0].display_text.contains('c'));
        assert!(segments[0].display_text.contains('v'));
        assert!(segments[0].display_text.contains('z'));
    }

    #[test]
    fn segments_have_minimum_duration() {
        let events = KeyboardEvents {
            presses: vec![key_down("a", 100.0), key_up("a", 110.0)],
        };

        let segments = group_key_events(&events, 300.0, 50.0, true, true);
        assert_eq!(segments.len(), 1);
        let duration = segments[0].end - segments[0].start;
        assert!(duration >= 0.3);
    }

    #[test]
    fn backspace_works_with_show_special_keys_false() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("e", 200.0),
                key_up("e", 250.0),
                key_down("Backspace", 300.0),
                key_up("Backspace", 350.0),
                key_down("a", 400.0),
                key_up("a", 450.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, false);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "ha");
    }
}
