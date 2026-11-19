use crate::{
    ClipSpeedAudioMode, CursorClickEvent, KeyPressEvent, KeyboardEvents, ProjectConfiguration,
    keyboard::{clip_windows, held_output_time, is_modifier_key},
};

/// One recording clip's input, in its own time base: cursor clicks are in
/// segment time, key presses are offset from it by `keyboard_offset_secs`.
#[derive(Clone, Copy)]
pub struct InputSoundTake<'a> {
    pub keyboard: &'a KeyboardEvents,
    pub keyboard_offset_secs: f64,
    pub clicks: &'a [CursorClickEvent],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KeySoundClass {
    Letter,
    Space,
    Enter,
    Backspace,
    Modifier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum InputSoundKind {
    Key { class: KeySoundClass, down: bool },
    Click { down: bool },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputSoundEvent {
    /// Output (timeline) seconds.
    pub time: f64,
    pub kind: InputSoundKind,
    /// Stable per press, so the same edit always picks the same variation.
    pub seed: u64,
    /// -1 is hard left, 1 hard right.
    pub pan: f32,
    /// The clip's own volume, so a quieter clip is quieter throughout.
    pub gain: f32,
}

impl KeySoundClass {
    pub fn of(key: &str) -> Self {
        match key {
            "Space" => Self::Space,
            "Enter" | "Return" => Self::Enter,
            "Backspace" | "Delete" => Self::Backspace,
            _ if is_modifier_key(key) || matches!(key, "CapsLock" | "Tab" | "Escape") => {
                Self::Modifier
            }
            _ => Self::Letter,
        }
    }
}

const KEY_ROWS: &[(f32, &[&str])] = &[
    (
        0.0,
        &[
            "Escape", "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
        ],
    ),
    (
        0.0,
        &[
            "Grave",
            "Key1",
            "Key2",
            "Key3",
            "Key4",
            "Key5",
            "Key6",
            "Key7",
            "Key8",
            "Key9",
            "Key0",
            "Minus",
            "Equal",
            "Backspace",
        ],
    ),
    (
        0.0,
        &[
            "Tab",
            "Q",
            "W",
            "E",
            "R",
            "T",
            "Y",
            "U",
            "I",
            "O",
            "P",
            "LeftBracket",
            "RightBracket",
            "BackSlash",
        ],
    ),
    (
        0.25,
        &[
            "CapsLock",
            "A",
            "S",
            "D",
            "F",
            "G",
            "H",
            "J",
            "K",
            "L",
            "Semicolon",
            "Apostrophe",
            "Enter",
        ],
    ),
    (
        0.75,
        &[
            "LShift", "Z", "X", "C", "V", "B", "N", "M", "Comma", "Dot", "Slash", "RShift",
        ],
    ),
];

/// Where a key sits across a full-size keyboard, so a mono recording can be
/// placed the way the press would reach a microphone in front of it.
fn key_pan(key_code: &str) -> f32 {
    const WIDTH: f32 = 14.0;
    let column = match key_code {
        "Space" => Some(6.5),
        "LControl" => Some(0.5),
        "LAlt" | "LOption" => Some(1.75),
        "Meta" | "LMeta" | "Command" => Some(3.0),
        "RMeta" | "RCommand" => Some(10.0),
        "RAlt" | "ROption" => Some(11.25),
        "RControl" | "Left" => Some(12.5),
        "Up" | "Down" => Some(13.25),
        "Right" | "Delete" | "Home" | "End" | "PageUp" | "PageDown" | "Insert" => Some(14.0),
        _ => KEY_ROWS.iter().find_map(|(offset, row)| {
            row.iter()
                .position(|candidate| *candidate == key_code)
                .map(|column| offset + column as f32 + 0.5)
        }),
    };
    column.map_or(0.0, |column| {
        ((column / WIDTH - 0.5) * 0.7).clamp(-0.35, 0.35)
    })
}

fn mix_seed(mut value: u64) -> u64 {
    value ^= value >> 33;
    value = value.wrapping_mul(0xff51_afd7_ed55_8ccd);
    value ^= value >> 33;
    value = value.wrapping_mul(0xc4ce_b9fe_1a85_ec53);
    value ^ (value >> 33)
}

fn text_seed(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn event_seed(kind: u64, recording_clip: u32, source_time_ms: f64, extra: u64) -> u64 {
    mix_seed(
        kind ^ (u64::from(recording_clip) << 48)
            ^ source_time_ms.to_bits().rotate_left(17)
            ^ extra.rotate_left(29),
    )
}

/// Merged, sorted output ranges of the keyboard track. Key sounds follow the
/// overlay: a press sounds only while its keys are on screen.
fn shown_key_ranges(project: &ProjectConfiguration) -> Vec<(f64, f64)> {
    let Some(timeline) = &project.timeline else {
        return Vec::new();
    };
    let mut ranges = timeline
        .keyboard_segments
        .iter()
        .filter(|segment| {
            segment.start.is_finite() && segment.end.is_finite() && segment.end > segment.start
        })
        .map(|segment| (segment.start, segment.end))
        .collect::<Vec<_>>();
    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

fn within(ranges: &[(f64, f64)], time: f64) -> bool {
    let index = ranges.partition_point(|range| range.1 < time);
    ranges
        .get(index)
        .is_some_and(|range| range.0 <= time && time <= range.1)
}

pub fn key_sounds_enabled(project: &ProjectConfiguration) -> bool {
    project
        .keyboard
        .as_ref()
        .is_some_and(|keyboard| keyboard.settings.enabled && keyboard.settings.key_sounds)
}

pub fn click_sounds_enabled(project: &ProjectConfiguration) -> bool {
    !project.cursor.hide && project.cursor.click_sounds
}

/// Every key and click sound the edited timeline plays, sorted by output
/// time. Recording time maps to output time exactly as the keyboard track
/// does, so sounds stay on the frames that show them through cuts, speed
/// changes, transitions and fullscreen-text holds.
pub fn input_sound_events(
    project: &ProjectConfiguration,
    takes: &[InputSoundTake<'_>],
) -> Vec<InputSoundEvent> {
    let keys = key_sounds_enabled(project);
    let clicks = click_sounds_enabled(project);
    let Some(timeline) = project.timeline.as_ref().filter(|_| keys || clicks) else {
        return Vec::new();
    };
    let shown = if keys {
        shown_key_ranges(project)
    } else {
        Vec::new()
    };
    let holds = timeline.hold_windows();
    let mut events = Vec::new();
    let mut ordered_keys: Vec<Option<Vec<&KeyPressEvent>>> = vec![None; takes.len()];
    let mut ordered_clicks: Vec<Option<Vec<&CursorClickEvent>>> = vec![None; takes.len()];
    let mut held: Vec<&str> = Vec::new();
    // Where the last clip's keys left off, so a key held across a split is
    // still released on the far side of it.
    let mut held_until: Option<(u32, f64, f64)> = None;

    for window in clip_windows(timeline) {
        let clip = window.clip;
        if clip.speed_audio_mode == Some(ClipSpeedAudioMode::Mute) {
            continue;
        }
        let Some(take) = takes.get(clip.recording_clip as usize) else {
            continue;
        };
        let gain = clip.volume() as f32;
        let to_output = |source_secs: f64| {
            held_output_time(
                &holds,
                window.edited_start + (source_secs - clip.start) / clip.timescale,
                false,
            )
        };

        if keys && !shown.is_empty() && take.keyboard_offset_secs.is_finite() {
            let presses = ordered_keys[clip.recording_clip as usize].get_or_insert_with(|| {
                let mut presses = take
                    .keyboard
                    .presses
                    .iter()
                    .filter(|press| press.time_ms.is_finite())
                    .collect::<Vec<_>>();
                presses.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
                presses
            });
            let source_start = clip.start + take.keyboard_offset_secs;
            let source_end = clip.end + take.keyboard_offset_secs;
            let first = presses.partition_point(|press| press.time_ms / 1000.0 < source_start);
            let last = presses.partition_point(|press| press.time_ms / 1000.0 < source_end);
            // Only a clip that carries straight on from the last one, in the
            // recording and on the timeline, keeps its held keys. After a cut
            // a release whose press was cut away stays silent, and across a
            // transition the clips overlap, so a release could land before
            // its press.
            let continues = held_until.is_some_and(|(recording_clip, end, edited_end)| {
                recording_clip == clip.recording_clip
                    && (end - clip.start).abs() < 1e-6
                    && (edited_end - window.edited_start).abs() < 1e-6
            });
            if !continues {
                held.clear();
            }
            held_until = Some((clip.recording_clip, clip.end, window.edited_end));
            for &press in &presses[first..last.max(first)] {
                let time = to_output(press.time_ms / 1000.0 - take.keyboard_offset_secs);
                if press.down {
                    if held.contains(&press.key_code.as_str()) || !within(&shown, time) {
                        continue;
                    }
                    held.push(press.key_code.as_str());
                } else if let Some(index) = held.iter().position(|key| *key == press.key_code) {
                    held.swap_remove(index);
                } else {
                    continue;
                }
                events.push(InputSoundEvent {
                    time,
                    kind: InputSoundKind::Key {
                        class: KeySoundClass::of(&press.key),
                        down: press.down,
                    },
                    seed: event_seed(
                        1,
                        clip.recording_clip,
                        press.time_ms,
                        text_seed(&press.key_code),
                    ),
                    pan: key_pan(&press.key_code),
                    gain,
                });
            }
        }

        if clicks {
            let presses = ordered_clicks[clip.recording_clip as usize].get_or_insert_with(|| {
                let mut presses = take
                    .clicks
                    .iter()
                    .filter(|click| click.time_ms.is_finite())
                    .collect::<Vec<_>>();
                presses.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
                presses
            });
            let first = presses.partition_point(|click| click.time_ms / 1000.0 < clip.start);
            let last = presses.partition_point(|click| click.time_ms / 1000.0 < clip.end);
            for &click in &presses[first..last.max(first)] {
                // A clip that hides the cursor hides its clicks too, fading
                // with the cursor at the ends of the hidden run.
                let time = to_output(click.time_ms / 1000.0);
                let visible = timeline.cursor_visibility_at(time) as f32;
                if visible <= 0.0 {
                    continue;
                }
                let seed = event_seed(
                    2,
                    clip.recording_clip,
                    click.time_ms,
                    u64::from(click.cursor_num),
                );
                events.push(InputSoundEvent {
                    time,
                    kind: InputSoundKind::Click { down: click.down },
                    seed,
                    pan: ((seed >> 40) as f32 / (1u64 << 24) as f32 - 0.5) * 0.1,
                    gain: gain * visible,
                });
            }
        }
    }

    events.retain(|event| event.time.is_finite() && event.time >= 0.0);
    events.sort_by(|a, b| a.time.total_cmp(&b.time).then(a.seed.cmp(&b.seed)));
    events
}

#[cfg(test)]
mod tests;
