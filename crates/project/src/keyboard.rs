use serde::{Deserialize, Serialize};
use specta::Type;
use std::path::Path;

pub const KEYBOARD_EVENTS_FILE_NAME: &str = "keyboard.bin";
pub const LEGACY_KEYBOARD_EVENTS_FILE_NAME: &str = "keyboard.json";
const KEYBOARD_EVENTS_MAGIC: &[u8; 6] = b"CPKB01";

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
        let bytes =
            std::fs::read(path).map_err(|e| format!("Failed to open keyboard events file: {e}"))?;
        let config = bincode::config::standard();

        if let Some(payload) = bytes.strip_prefix(KEYBOARD_EVENTS_MAGIC) {
            return bincode::serde::decode_from_slice::<Self, _>(payload, config)
                .map(|(events, _)| events)
                .map_err(|e| format!("Failed to parse keyboard events binary payload: {e}"));
        }

        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension == "bin")
            && let Ok((events, _)) = bincode::serde::decode_from_slice::<Self, _>(&bytes, config)
        {
            return Ok(events);
        }

        serde_json::from_slice(&bytes)
            .map_err(|e| format!("Failed to parse keyboard events legacy JSON: {e}"))
    }

    pub fn write_to_file(&self, path: &Path) -> Result<(), String> {
        let mut bytes = KEYBOARD_EVENTS_MAGIC.to_vec();
        let payload = bincode::serde::encode_to_vec(self, bincode::config::standard())
            .map_err(|e| format!("Failed to serialize keyboard events: {e}"))?;
        bytes.extend(payload);
        std::fs::write(path, bytes)
            .map_err(|e| format!("Failed to write keyboard events file: {e}"))
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
    #[serde(default)]
    pub fade_duration_override: Option<f32>,
    #[serde(default)]
    pub position_override: Option<String>,
    #[serde(default)]
    pub color_override: Option<String>,
    #[serde(default)]
    pub background_color_override: Option<String>,
    #[serde(default)]
    pub font_size_override: Option<u32>,
    #[serde(default)]
    pub uppercase_override: Option<bool>,
}

impl KeyboardTrackSegment {
    pub fn remap_times(&mut self, map: impl Fn(f64) -> f64) {
        let old_start = self.start;
        let new_start = map(old_start);
        for key in &mut self.keys {
            key.time_offset =
                ((map(old_start + key.time_offset / 1000.0) - new_start) * 1000.0).max(0.0);
        }
        self.start = new_start;
        self.end = map(self.end).max(new_start);
    }

    pub fn ripple_delete(&mut self, cut_start: f64, cut_end: f64, shift: f64) -> bool {
        if self.end <= cut_start {
            return true;
        }
        if self.start >= cut_start && self.end <= cut_end {
            return false;
        }
        let old_start = self.start;
        let retained: Vec<bool> = self
            .keys
            .iter()
            .map(|key| {
                let time = old_start + key.time_offset / 1000.0;
                time < cut_start || time >= cut_end
            })
            .collect();
        let removes_keys = retained.iter().any(|keep| !keep);
        let chars: Vec<char> = self.display_text.chars().collect();
        if removes_keys && chars.len() != self.keys.len() {
            return false;
        }
        if removes_keys {
            self.display_text = chars
                .into_iter()
                .zip(&retained)
                .filter_map(|(ch, keep)| keep.then_some(ch))
                .collect();
        }
        if self.start >= cut_end {
            self.start -= shift;
            self.end -= shift;
        } else if self.start < cut_start && self.end > cut_end {
            self.end -= shift;
        } else if self.start < cut_start {
            self.end = cut_start;
        } else {
            self.start = cut_start;
            self.end = (self.end - shift).max(self.start);
        }
        let new_start = self.start;
        let mut index = 0;
        self.keys.retain_mut(|key| {
            let keep = retained[index];
            index += 1;
            if keep {
                let time = old_start + key.time_offset / 1000.0;
                let mapped = if time >= cut_end { time - shift } else { time };
                key.time_offset = ((mapped - new_start) * 1000.0).max(0.0);
            }
            keep
        });
        self.end > self.start && (!removes_keys || !self.keys.is_empty())
    }

    pub fn split_at(&self, at: f64) -> Option<(Self, Self)> {
        if !at.is_finite() || at <= self.start || at >= self.end {
            return None;
        }
        let mut left = self.clone();
        let mut right = self.clone();
        left.end = at;
        right.start = at;
        if self.keys.is_empty() {
            return Some((left, right));
        }
        let chars: Vec<char> = self.display_text.chars().collect();
        if chars.len() != self.keys.len() {
            return None;
        }
        left.keys.clear();
        right.keys.clear();
        left.display_text.clear();
        right.display_text.clear();
        for (key, ch) in self.keys.iter().zip(chars) {
            let absolute = self.start + key.time_offset / 1000.0;
            if absolute < at {
                left.keys.push(key.clone());
                left.display_text.push(ch);
            } else {
                right.keys.push(KeyPressDisplay {
                    key: key.key.clone(),
                    time_offset: (absolute - at) * 1000.0,
                });
                right.display_text.push(ch);
            }
        }
        if left.keys.is_empty() || right.keys.is_empty() {
            return None;
        }
        Some((left, right))
    }
}

fn load_project_keyboard_events(
    meta: &crate::RecordingMeta,
) -> Result<Vec<(KeyboardEvents, f64)>, String> {
    let Some(crate::StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        return Ok(Vec::new());
    };
    inner
        .segments
        .iter()
        .map(|take| {
            let path = take.keyboard.clone().or_else(|| {
                let directory = take.display.path.parent()?;
                [KEYBOARD_EVENTS_FILE_NAME, LEGACY_KEYBOARD_EVENTS_FILE_NAME]
                    .into_iter()
                    .map(|name| directory.join(name))
                    .find(|path| meta.path(path).exists())
            });
            let events = match path {
                Some(path) => KeyboardEvents::load_from_file(&meta.path(&path))?,
                None => KeyboardEvents::default(),
            };
            Ok((events, take.latest_start_time().unwrap_or(0.0)))
        })
        .collect()
}

pub fn generate_project_keyboard_segments(
    meta: &crate::RecordingMeta,
    timeline: &crate::TimelineConfiguration,
    settings: &crate::KeyboardSettings,
) -> Result<Vec<KeyboardTrackSegment>, String> {
    let takes = load_project_keyboard_events(meta)?;
    Ok(project_keyboard_events(&takes, timeline, settings))
}

pub fn synchronize_legacy_keyboard(
    meta: &crate::RecordingMeta,
    project: &mut crate::ProjectConfiguration,
) {
    let (Some(keyboard), Some(timeline)) = (&project.keyboard, &mut project.timeline) else {
        return;
    };
    if timeline.keyboard_segments.is_empty()
        || timeline
            .keyboard_segments
            .iter()
            .any(|segment| segment.id.starts_with("kb-edit-"))
    {
        return;
    }
    let Some(crate::StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
        return;
    };
    let Ok(takes) = load_project_keyboard_events(meta) else {
        return;
    };
    let mut events = KeyboardEvents {
        presses: takes
            .into_iter()
            .flat_map(|(events, _)| events.presses)
            .collect(),
    };
    events
        .presses
        .sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    let legacy = group_key_events(
        &events,
        keyboard.settings.grouping_threshold_ms,
        f64::from(keyboard.settings.linger_duration) * 1000.0,
        keyboard.settings.show_modifiers,
        keyboard.settings.show_special_keys,
    );
    let unchanged = legacy.len() == timeline.keyboard_segments.len()
        && legacy
            .iter()
            .zip(&timeline.keyboard_segments)
            .all(|(generated, saved)| {
                generated.id == saved.id
                    && (generated.start - saved.start).abs() <= 1e-6
                    && (generated.end - saved.end).abs() <= 1e-6
                    && generated.display_text == saved.display_text
                    && generated.keys.len() == saved.keys.len()
                    && generated.keys.iter().zip(&saved.keys).all(|(a, b)| {
                        a.key == b.key && (a.time_offset - b.time_offset).abs() <= 1e-3
                    })
            });
    if !unchanged {
        return;
    }
    // Older projects have no clock marker. Only untouched generated timings
    // can be identified safely; ambiguous manual edits remain as authored.
    let Ok(mut generated) = generate_project_keyboard_segments(meta, timeline, &keyboard.settings)
    else {
        return;
    };
    let clip_offsets = crate::caption_timing::clip_timeline_offsets(timeline);
    let holds = timeline.hold_windows();
    for segment in &mut generated {
        let Some(index) = segment
            .id
            .strip_prefix("kb-edit-")
            .and_then(|id| id.split_once('-'))
            .and_then(|(index, _)| index.parse::<usize>().ok())
        else {
            continue;
        };
        let Some(clip) = timeline.segments.get(index) else {
            continue;
        };
        let held_time: f64 = holds
            .iter()
            .map(|(start, end)| (segment.start - start).clamp(0.0, end - start))
            .sum();
        let source_time =
            clip.start + (segment.start - held_time - clip_offsets[index]) * clip.timescale;
        let offset = inner
            .segments
            .get(clip.recording_clip as usize)
            .and_then(|take| take.latest_start_time())
            .unwrap_or(0.0);
        let captured = source_time + offset;
        let Some(previous) = timeline
            .keyboard_segments
            .iter()
            .rev()
            .find(|previous| captured >= previous.start && captured < previous.end)
        else {
            continue;
        };
        segment.fade_duration_override = previous.fade_duration_override;
        segment.position_override = previous.position_override.clone();
        segment.color_override = previous.color_override.clone();
        segment.background_color_override = previous.background_color_override.clone();
        segment.font_size_override = previous.font_size_override;
        segment.uppercase_override = previous.uppercase_override;
    }
    timeline.keyboard_segments = generated;
}

fn project_keyboard_events(
    takes: &[(KeyboardEvents, f64)],
    timeline: &crate::TimelineConfiguration,
    settings: &crate::KeyboardSettings,
) -> Vec<KeyboardTrackSegment> {
    let holds = timeline.hold_windows();
    let output_time = |time: f64, end: bool| {
        let mut output = time;
        for (start, finish) in &holds {
            if output > *start || (!end && output == *start) {
                output += finish - start;
            } else {
                break;
            }
        }
        output
    };
    let mut edited_start = 0.0;
    let mut result = Vec::new();
    for (index, clip) in timeline.segments.iter().enumerate() {
        if !clip.start.is_finite()
            || !clip.end.is_finite()
            || !clip.timescale.is_finite()
            || clip.timescale <= 0.0
            || clip.end <= clip.start
        {
            continue;
        }
        edited_start -= timeline
            .effective_transition(index)
            .map_or(0.0, |transition| transition.duration);
        let edited_end = edited_start + clip.duration();
        if let Some((events, capture_offset)) = takes.get(clip.recording_clip as usize)
            && capture_offset.is_finite()
        {
            let source_start = clip.start + capture_offset;
            let source_end = clip.end + capture_offset;
            let mut presses = Vec::new();
            let mut modifiers = Vec::new();
            let mut ordered: Vec<_> = events
                .presses
                .iter()
                .filter(|event| event.time_ms.is_finite())
                .collect();
            ordered.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
            for event in ordered {
                let source = event.time_ms / 1000.0;
                if source < source_start {
                    if is_modifier_key(&event.key) {
                        modifiers.retain(|key: &KeyPressEvent| key.key != event.key);
                        if event.down {
                            modifiers.push(event.clone());
                        }
                    }
                    continue;
                }
                if source >= source_end {
                    break;
                }
                if presses.is_empty() {
                    for mut modifier in modifiers.drain(..) {
                        modifier.time_ms = output_time(edited_start, false) * 1000.0;
                        presses.push(modifier);
                    }
                }
                let mut projected = event.clone();
                projected.time_ms = output_time(
                    edited_start + (source - source_start) / clip.timescale,
                    false,
                ) * 1000.0;
                presses.push(projected);
            }
            let mut grouped = group_key_events(
                &KeyboardEvents { presses },
                settings.grouping_threshold_ms,
                f64::from(settings.linger_duration) * 1000.0,
                settings.show_modifiers,
                settings.show_special_keys,
            );
            for segment in &mut grouped {
                segment.id = format!("kb-edit-{index}-{}", segment.id);
                segment.end = segment.end.min(output_time(edited_end, true));
            }
            result.extend(
                grouped
                    .into_iter()
                    .filter(|segment| segment.end > segment.start),
            );
        }
        edited_start = edited_end;
    }
    result.sort_by(|a, b| a.start.total_cmp(&b.start));
    result
}

pub fn group_key_events(
    events: &KeyboardEvents,
    grouping_threshold_ms: f64,
    linger_duration_ms: f64,
    show_modifiers: bool,
    show_special_keys: bool,
) -> Vec<KeyboardTrackSegment> {
    let mut segments: Vec<KeyboardTrackSegment> = Vec::new();

    let down_events: Vec<&KeyPressEvent> = events.presses.iter().filter(|e| e.down).collect();

    if down_events.is_empty() {
        return segments;
    }

    let active_modifiers_at = |time_ms: f64| -> Vec<String> {
        let mut active = Vec::new();
        for event in &events.presses {
            if event.time_ms > time_ms {
                break;
            }
            if is_modifier_key(&event.key) {
                if event.down {
                    if !active.contains(&event.key) {
                        active.push(event.key.clone());
                    }
                } else {
                    active.retain(|k| k != &event.key);
                }
            }
        }
        active
    };

    let mut current_group_start: Option<f64> = None;
    let mut current_display = String::new();
    let mut current_keys: Vec<KeyPressDisplay> = Vec::new();
    let mut last_key_time: f64 = 0.0;
    let mut segment_counter: u64 = 0;

    for event in &down_events {
        let is_modifier = is_modifier_key(&event.key);

        if is_modifier && !show_modifiers {
            continue;
        }

        let is_special = special_key_symbol(&event.key).is_some() && event.key != "Space";

        if is_special && !show_special_keys && !is_modifier {
            continue;
        }

        if event.key == "Space" {
            let typing_active = current_group_start.is_some()
                && !current_display.is_empty()
                && (event.time_ms - last_key_time) <= grouping_threshold_ms;

            if typing_active {
                if let Some(start) = current_group_start {
                    segment_counter += 1;
                    segments.push(KeyboardTrackSegment {
                        id: format!("kb-{segment_counter}"),
                        start: start / 1000.0,
                        end: (event.time_ms + linger_duration_ms) / 1000.0,
                        display_text: current_display.clone(),
                        keys: current_keys.clone(),
                        fade_duration_override: None,
                        position_override: None,
                        color_override: None,
                        background_color_override: None,
                        font_size_override: None,
                        uppercase_override: None,
                    });
                }
                current_display.clear();
                current_keys.clear();
                current_group_start = None;
                last_key_time = event.time_ms;
                continue;
            }

            if let Some(start) = current_group_start
                && !current_display.is_empty()
            {
                segment_counter += 1;
                segments.push(KeyboardTrackSegment {
                    id: format!("kb-{segment_counter}"),
                    start: start / 1000.0,
                    end: (last_key_time + linger_duration_ms) / 1000.0,
                    display_text: current_display.clone(),
                    keys: current_keys.clone(),
                    fade_duration_override: None,
                    position_override: None,
                    color_override: None,
                    background_color_override: None,
                    font_size_override: None,
                    uppercase_override: None,
                });
                current_display.clear();
                current_keys.clear();
                current_group_start = None;
            }

            if (event.time_ms - last_key_time) > grouping_threshold_ms {
                segment_counter += 1;
                segments.push(KeyboardTrackSegment {
                    id: format!("kb-{segment_counter}"),
                    start: event.time_ms / 1000.0,
                    end: (event.time_ms + linger_duration_ms) / 1000.0,
                    display_text: "␣".to_string(),
                    keys: vec![KeyPressDisplay {
                        key: event.key.clone(),
                        time_offset: 0.0,
                    }],
                    fade_duration_override: None,
                    position_override: None,
                    color_override: None,
                    background_color_override: None,
                    font_size_override: None,
                    uppercase_override: None,
                });
            }

            last_key_time = event.time_ms;
            continue;
        }

        let should_start_new_group = current_group_start.is_none()
            || (event.time_ms - last_key_time) > grouping_threshold_ms
            || is_modifier;

        if should_start_new_group && let Some(start) = current_group_start {
            if !current_display.is_empty() {
                segment_counter += 1;
                segments.push(KeyboardTrackSegment {
                    id: format!("kb-{segment_counter}"),
                    start: start / 1000.0,
                    end: (last_key_time + linger_duration_ms) / 1000.0,
                    display_text: current_display.clone(),
                    keys: current_keys.clone(),
                    fade_duration_override: None,
                    position_override: None,
                    color_override: None,
                    background_color_override: None,
                    font_size_override: None,
                    uppercase_override: None,
                });
            }
            current_display.clear();
            current_keys.clear();
            current_group_start = None;
        }

        if is_modifier {
            let modifiers = active_modifiers_at(event.time_ms);
            let prefix = modifier_prefix(&modifiers);
            if !prefix.is_empty() {
                current_group_start = Some(event.time_ms);
                current_display = prefix;
                current_keys.push(KeyPressDisplay {
                    key: event.key.clone(),
                    time_offset: 0.0,
                });
                last_key_time = event.time_ms;
            }
            continue;
        }

        if event.key == "Backspace" && !current_display.is_empty() {
            current_display.pop();
            last_key_time = event.time_ms;
            continue;
        }

        let active_mods = active_modifiers_at(event.time_ms);
        let has_command_mod = active_mods.iter().any(|m| {
            matches!(
                m.as_str(),
                "LMeta" | "RMeta" | "Meta" | "Command" | "LControl" | "RControl"
            )
        });

        if has_command_mod && show_modifiers {
            let prefix = modifier_prefix(&active_mods);
            let key_display = display_char_for_key(&event.key).unwrap_or_else(|| event.key.clone());
            let combo = format!("{prefix}{}", key_display.to_uppercase());

            segment_counter += 1;
            segments.push(KeyboardTrackSegment {
                id: format!("kb-{segment_counter}"),
                start: event.time_ms / 1000.0,
                end: (event.time_ms + linger_duration_ms) / 1000.0,
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
                uppercase_override: None,
            });

            current_display.clear();
            current_keys.clear();
            current_group_start = None;
            last_key_time = event.time_ms;
            continue;
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

    if let Some(start) = current_group_start
        && !current_display.is_empty()
    {
        segment_counter += 1;
        segments.push(KeyboardTrackSegment {
            id: format!("kb-{segment_counter}"),
            start: start / 1000.0,
            end: (last_key_time + linger_duration_ms) / 1000.0,
            display_text: current_display,
            keys: current_keys,
            fade_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: None,
            uppercase_override: None,
        });
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
    fn backspace_to_empty_does_not_emit_blank_segment() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("a", 100.0),
                key_up("a", 150.0),
                key_down("Backspace", 200.0),
                key_up("Backspace", 250.0),
                key_down("x", 1000.0),
                key_up("x", 1050.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "x");
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
    fn roundtrips_binary_keyboard_events() {
        let events = KeyboardEvents {
            presses: vec![key_down("a", 100.0), key_up("a", 150.0)],
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEYBOARD_EVENTS_FILE_NAME);

        events.write_to_file(&path).unwrap();

        let loaded = KeyboardEvents::load_from_file(&path).unwrap();
        assert_eq!(loaded.presses, events.presses);
    }

    #[test]
    fn loads_legacy_json_keyboard_events() {
        let events = KeyboardEvents {
            presses: vec![key_down("b", 100.0), key_up("b", 150.0)],
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LEGACY_KEYBOARD_EVENTS_FILE_NAME);

        std::fs::write(&path, serde_json::to_vec(&events).unwrap()).unwrap();

        let loaded = KeyboardEvents::load_from_file(&path).unwrap();
        assert_eq!(loaded.presses, events.presses);
    }

    #[test]
    fn space_splits_continuous_typing_into_words() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("i", 200.0),
                key_up("i", 250.0),
                key_down("Space", 300.0),
                key_up("Space", 350.0),
                key_down("b", 400.0),
                key_up("b", 450.0),
                key_down("y", 500.0),
                key_up("y", 550.0),
                key_down("e", 600.0),
                key_up("e", 650.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].display_text, "hi");
        assert_eq!(segments[1].display_text, "bye");
    }

    #[test]
    fn consecutive_spaces_do_not_create_empty_segments() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("a", 100.0),
                key_up("a", 150.0),
                key_down("Space", 200.0),
                key_up("Space", 250.0),
                key_down("Space", 300.0),
                key_up("Space", 350.0),
                key_down("b", 400.0),
                key_up("b", 450.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].display_text, "a");
        assert_eq!(segments[1].display_text, "b");
    }

    #[test]
    fn space_at_start_is_ignored() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("Space", 100.0),
                key_up("Space", 150.0),
                key_down("h", 200.0),
                key_up("h", 250.0),
                key_down("i", 300.0),
                key_up("i", 350.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "hi");
    }

    #[test]
    fn long_sentence_splits_into_word_segments() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("s", 100.0),
                key_up("s", 120.0),
                key_down("e", 150.0),
                key_up("e", 170.0),
                key_down("e", 200.0),
                key_up("e", 220.0),
                key_down("m", 250.0),
                key_up("m", 270.0),
                key_down("Space", 300.0),
                key_up("Space", 320.0),
                key_down("m", 350.0),
                key_up("m", 370.0),
                key_down("u", 400.0),
                key_up("u", 420.0),
                key_down("s", 450.0),
                key_up("s", 470.0),
                key_down("t", 500.0),
                key_up("t", 520.0),
                key_down("Space", 550.0),
                key_up("Space", 570.0),
                key_down("o", 600.0),
                key_up("o", 620.0),
                key_down("r", 650.0),
                key_up("r", 670.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0].display_text, "seem");
        assert_eq!(segments[1].display_text, "must");
        assert_eq!(segments[2].display_text, "or");
    }

    #[test]
    fn standalone_space_after_gap_shows_symbol() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("a", 100.0),
                key_up("a", 150.0),
                key_down("Space", 2000.0),
                key_up("Space", 2050.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].display_text, "a");
        assert_eq!(segments[1].display_text, "␣");
    }

    #[test]
    fn space_after_gap_with_stale_group_finalizes_both() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("h", 100.0),
                key_up("h", 150.0),
                key_down("i", 200.0),
                key_up("i", 250.0),
                key_down("Space", 2000.0),
                key_up("Space", 2050.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].display_text, "hi");
        assert_eq!(segments[1].display_text, "␣");
    }

    #[test]
    fn loads_unversioned_binary_keyboard_events() {
        let events = KeyboardEvents {
            presses: vec![key_down("c", 100.0), key_up("c", 150.0)],
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(KEYBOARD_EVENTS_FILE_NAME);
        let bytes = bincode::serde::encode_to_vec(&events, bincode::config::standard()).unwrap();

        std::fs::write(&path, bytes).unwrap();

        let loaded = KeyboardEvents::load_from_file(&path).unwrap();
        assert_eq!(loaded.presses, events.presses);
    }

    #[test]
    fn modifier_combos_uppercase_the_key() {
        let events = KeyboardEvents {
            presses: vec![
                key_down("LMeta", 100.0),
                key_down("w", 150.0),
                key_up("w", 200.0),
                key_up("LMeta", 250.0),
            ],
        };

        let segments = group_key_events(&events, 300.0, 500.0, true, true);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].display_text, "⌘W");
    }
}

#[cfg(test)]
mod timing_tests {
    use super::*;
    use crate::{KeyboardSettings, TimelineConfiguration};

    fn timeline(segments: serde_json::Value) -> TimelineConfiguration {
        serde_json::from_value(serde_json::json!({"segments": segments, "zoomSegments": []}))
            .unwrap()
    }

    fn events(keys: &[(&str, f64)]) -> KeyboardEvents {
        KeyboardEvents {
            presses: keys
                .iter()
                .map(|(key, time)| KeyPressEvent {
                    key: (*key).into(),
                    key_code: (*key).into(),
                    time_ms: time * 1000.0,
                    down: true,
                })
                .collect(),
        }
    }

    #[test]
    fn legacy_generated_tracks_migrate_once_without_overwriting_manual_edits() {
        let directory = tempfile::tempdir().unwrap();
        let captured = events(&[("a", 8.2)]);
        captured
            .write_to_file(&directory.path().join("keyboard.bin"))
            .unwrap();
        let mut meta: crate::RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name":"legacy", "segments":[{"display":{"path":"display.mp4","fps":30,"start_time":0.2},"keyboard":"keyboard.bin"}],"cursors":{}
        })).unwrap();
        meta.project_path = directory.path().to_path_buf();
        let mut project = crate::ProjectConfiguration {
            keyboard: Some(crate::KeyboardData::default()),
            timeline: Some(timeline(serde_json::json!([
                {"start":0.0,"end":5.0,"timescale":1.0},
                {"start":6.0,"end":10.0,"timescale":1.0}
            ]))),
            ..Default::default()
        };
        project.timeline.as_mut().unwrap().keyboard_segments =
            group_key_events(&captured, 500.0, 800.0, true, true);
        project.timeline.as_mut().unwrap().keyboard_segments[0].color_override =
            Some("#123456".into());
        let mut manual = project.clone();
        manual.timeline.as_mut().unwrap().keyboard_segments[0].start += 0.1;
        let original_manual = serde_json::to_string(&manual).unwrap();
        synchronize_legacy_keyboard(&meta, &mut manual);
        assert_eq!(serde_json::to_string(&manual).unwrap(), original_manual);
        synchronize_legacy_keyboard(&meta, &mut project);
        let segment = &project.timeline.as_ref().unwrap().keyboard_segments[0];
        assert!((segment.start - 7.0).abs() < 1e-9);
        assert_eq!(segment.color_override.as_deref(), Some("#123456"));
        let migrated = serde_json::to_string(&project).unwrap();
        synchronize_legacy_keyboard(&meta, &mut project);
        assert_eq!(serde_json::to_string(&project).unwrap(), migrated);
        assert_eq!(
            KeyboardEvents::load_from_file(&directory.path().join("keyboard.bin"))
                .unwrap()
                .presses,
            captured.presses
        );
    }

    #[test]
    fn legacy_styles_follow_their_take_during_a_transition() {
        let directory = tempfile::tempdir().unwrap();
        let first = events(&[("a", 4.5)]);
        let second = events(&[("b", 0.5)]);
        first
            .write_to_file(&directory.path().join("first.bin"))
            .unwrap();
        second
            .write_to_file(&directory.path().join("second.bin"))
            .unwrap();
        let mut meta: crate::RecordingMeta = serde_json::from_value(serde_json::json!({
            "pretty_name":"transition", "segments":[
                {"display":{"path":"first.mp4","fps":30},"keyboard":"first.bin"},
                {"display":{"path":"second.mp4","fps":30},"keyboard":"second.bin"}
            ],"cursors":{}
        }))
        .unwrap();
        meta.project_path = directory.path().to_path_buf();
        let timeline = serde_json::from_value(serde_json::json!({
            "segments":[
                {"recordingSegment":0,"start":0.0,"end":5.0,"timescale":1.0},
                {"recordingSegment":1,"start":0.0,"end":5.0,"timescale":1.0}
            ], "zoomSegments":[],
            "transitions":[{"segmentIndex":1,"type":"cross-fade","duration":1.0}]
        }))
        .unwrap();
        let mut project = crate::ProjectConfiguration {
            keyboard: Some(crate::KeyboardData::default()),
            timeline: Some(timeline),
            ..Default::default()
        };
        let mut legacy =
            group_key_events(&events(&[("b", 0.5), ("a", 4.5)]), 500.0, 800.0, true, true);
        legacy[0].color_override = Some("#222222".into());
        legacy[1].color_override = Some("#111111".into());
        project.timeline.as_mut().unwrap().keyboard_segments = legacy;
        synchronize_legacy_keyboard(&meta, &mut project);
        let segments = &project.timeline.unwrap().keyboard_segments;
        assert_eq!(segments.len(), 2);
        for segment in segments {
            assert!((segment.start - 4.5).abs() < 1e-9);
            assert_eq!(
                segment.color_override.as_deref(),
                Some(if segment.display_text == "a" {
                    "#111111"
                } else {
                    "#222222"
                })
            );
        }
    }

    #[test]
    fn regeneration_reports_corrupt_capture_logs() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("keyboard.bin"),
            b"invalid capture log",
        )
        .unwrap();
        let mut meta: crate::RecordingMeta = serde_json::from_value(serde_json::json!({"pretty_name":"corrupt", "segments":[{"display":{"path":"display.mp4","fps":30,"start_time":0.0},"keyboard":"keyboard.bin"}],"cursors":{}})).unwrap();
        meta.project_path = directory.path().to_path_buf();
        let timeline = timeline(serde_json::json!([{ "start":0.0,"end":10.0,"timescale":1.0 }]));
        assert!(
            generate_project_keyboard_segments(&meta, &timeline, &KeyboardSettings::default())
                .is_err()
        );
    }

    #[test]
    fn regeneration_uses_retained_frames_and_capture_start_offset() {
        let timeline = timeline(serde_json::json!([
            {"start":0.0,"end":5.0,"timescale":1.0},
            {"start":6.0,"end":10.0,"timescale":1.0}
        ]));
        let takes = [(events(&[("x", 5.7), ("a", 8.2)]), 0.2)];
        let result = project_keyboard_events(&takes, &timeline, &KeyboardSettings::default());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].display_text, "a");
        assert!((result[0].start - 7.0).abs() < 1e-9);
        let (source_time, _) = timeline.get_segment_time(result[0].start).unwrap();
        assert!((source_time + takes[0].1 - 8.2).abs() < 1e-9);
    }

    #[test]
    fn regeneration_keeps_take_identity_and_repeated_clip_ids() {
        let timeline = timeline(serde_json::json!([
            {"recordingSegment":1,"start":0.0,"end":3.0,"timescale":1.0},
            {"recordingSegment":0,"start":0.0,"end":3.0,"timescale":1.0},
            {"recordingSegment":1,"start":0.0,"end":3.0,"timescale":1.0}
        ]));
        let result = project_keyboard_events(
            &[(events(&[("a", 1.0)]), 0.0), (events(&[("b", 1.0)]), 0.0)],
            &timeline,
            &KeyboardSettings::default(),
        );
        assert_eq!(
            result
                .iter()
                .map(|s| (s.display_text.as_str(), s.start))
                .collect::<Vec<_>>(),
            vec![("b", 1.0), ("a", 4.0), ("b", 7.0)]
        );
        assert_ne!(result[0].id, result[2].id);
    }

    #[test]
    fn regeneration_uses_transition_adjusted_clip_offsets() {
        let mut timeline = timeline(serde_json::json!([
            {"recordingSegment":0,"start":0.0,"end":5.0,"timescale":1.0},
            {"recordingSegment":1,"start":0.0,"end":5.0,"timescale":1.0}
        ]));
        timeline.transitions = serde_json::from_value(
            serde_json::json!([{"segmentIndex":1,"type":"cross-fade","duration":1.0}]),
        )
        .unwrap();
        let result = project_keyboard_events(
            &[
                (KeyboardEvents::default(), 0.0),
                (events(&[("b", 1.0)]), 0.0),
            ],
            &timeline,
            &KeyboardSettings::default(),
        );
        assert_eq!(result[0].start, 5.0);
        let (source, clip) = timeline.get_segment_time(result[0].start).unwrap();
        assert_eq!(source, 1.0);
        assert_eq!(clip.recording_clip, 1);
    }

    #[test]
    fn regeneration_scales_individual_key_offsets() {
        let timeline = timeline(serde_json::json!([{ "start":7.0,"end":10.0,"timescale":2.0 }]));
        let result = project_keyboard_events(
            &[(events(&[("a", 8.0), ("b", 8.4)]), 0.0)],
            &timeline,
            &KeyboardSettings::default(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].start, 0.5);
        assert!((result[0].keys[1].time_offset - 200.0).abs() < 1e-9);
    }

    #[test]
    fn regeneration_does_not_type_during_fullscreen_holds() {
        let mut timeline =
            timeline(serde_json::json!([{ "start":0.0,"end":10.0,"timescale":1.0 }]));
        timeline.text_segments.push(
            serde_json::from_value(
                serde_json::json!({"start":2.0,"end":4.0,"layout":"fullscreen"}),
            )
            .unwrap(),
        );
        let result = project_keyboard_events(
            &[(events(&[("a", 2.0), ("b", 3.0)]), 0.0)],
            &timeline,
            &KeyboardSettings::default(),
        );
        assert_eq!(result[0].start, 4.0);
        assert_eq!(result[1].start, 5.0);
    }

    #[test]
    fn regeneration_preserves_modifiers_held_across_trim() {
        let timeline = timeline(serde_json::json!([{ "start":2.0,"end":5.0,"timescale":1.0 }]));
        let result = project_keyboard_events(
            &[(events(&[("LMeta", 1.0), ("w", 2.2)]), 0.0)],
            &timeline,
            &KeyboardSettings::default(),
        );
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].display_text, "⌘W");
        assert!((result[0].start - 0.2).abs() < 1e-9);
    }

    fn typed_segment() -> KeyboardTrackSegment {
        group_key_events(
            &events(&[("a", 10.0), ("b", 11.0), ("c", 12.0)]),
            1500.0,
            1000.0,
            true,
            true,
        )
        .remove(0)
    }

    #[test]
    fn ripple_removes_cut_keys_and_rebases_survivors() {
        let mut segment = typed_segment();
        assert!(segment.ripple_delete(10.5, 11.5, 1.0));
        assert_eq!(segment.display_text, "ac");
        assert_eq!(segment.start, 10.0);
        assert_eq!(segment.end, 12.0);
        assert_eq!(segment.keys[1].time_offset, 1000.0);
    }

    #[test]
    fn speed_remaps_key_times_with_segment_bounds() {
        let mut segment = typed_segment();
        segment.remap_times(|time| 10.0 + (time - 10.0) / 2.0);
        assert_eq!(segment.end, 11.5);
        assert_eq!(segment.keys[1].time_offset, 500.0);
        assert_eq!(segment.keys[2].time_offset, 1000.0);
    }

    #[test]
    fn split_partitions_and_rebases_generated_keys() {
        let segment = typed_segment();
        let (left, right) = segment.split_at(11.0).unwrap();
        assert_eq!(left.display_text, "a");
        assert_eq!(right.display_text, "bc");
        assert_eq!(right.keys[0].time_offset, 0.0);
        assert_eq!(right.keys[1].time_offset, 1000.0);
    }

    #[test]
    fn atomic_shortcuts_are_preserved_or_removed_without_corruption() {
        let mut segment = typed_segment();
        segment.display_text = "⌘W".into();
        assert!(segment.split_at(11.0).is_none());
        assert!(!segment.ripple_delete(10.5, 11.5, 1.0));
    }
}
