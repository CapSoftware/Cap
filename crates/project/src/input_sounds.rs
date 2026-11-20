use crate::{
    CursorClickEvent, KeyPressEvent, KeyboardEvents, ProjectConfiguration,
    keyboard::{ClipWindow, clip_windows, held_output_time, is_modifier_key},
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
    // Keys added by hand sound their own text; a recorded press under one
    // is not on screen.
    let mut ranges = timeline
        .keyboard_segments
        .iter()
        .filter(|segment| !crate::keyboard::is_manual_keyboard_segment(segment))
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

/// What the keyboard track puts on screen when it shows shortcuts alone:
/// each recorded key it lists, at its output time, and the ranges of older
/// segments saved without their keys.
struct ShownShortcuts<'a> {
    keys: Vec<(f64, &'a str)>,
    unlisted: Vec<(f64, f64)>,
}

/// How far a listed key's time may sit from its press: both come from the
/// same output mapping, so only rounding separates them.
const SHOWN_KEY_TOLERANCE_SECS: f64 = 0.002;

impl<'a> ShownShortcuts<'a> {
    fn new(project: &'a ProjectConfiguration) -> Self {
        let mut shown = Self {
            keys: Vec::new(),
            unlisted: Vec::new(),
        };
        let Some(timeline) = &project.timeline else {
            return shown;
        };
        for segment in timeline
            .keyboard_segments
            .iter()
            .filter(|segment| !crate::keyboard::is_manual_keyboard_segment(segment))
            .filter(|segment| segment.start.is_finite() && segment.end > segment.start)
        {
            if segment.keys.is_empty() {
                shown.unlisted.push((segment.start, segment.end));
            }
            shown.keys.extend(
                segment
                    .keys
                    .iter()
                    .map(|key| (segment.start + key.time_offset / 1000.0, key.key.as_str())),
            );
        }
        shown.keys.sort_by(|a, b| a.0.total_cmp(&b.0));
        shown
    }

    fn shows(&self, key: &str, time: f64) -> bool {
        let first = self
            .keys
            .partition_point(|(at, _)| *at < time - SHOWN_KEY_TOLERANCE_SECS);
        self.keys[first..]
            .iter()
            .take_while(|(at, _)| *at <= time + SHOWN_KEY_TOLERANCE_SECS)
            .any(|(_, shown)| *shown == key)
            || self
                .unlisted
                .iter()
                .any(|(start, end)| *start <= time && time <= *end)
    }

    /// For each clip window, which of its presses belong to a shortcut on
    /// screen there: a key listed at that output time, and any modifier held
    /// down while one is struck. Each occurrence of a source range decides
    /// on its own; a modifier carries over only into a clip that continues
    /// straight on, so a split between a modifier and its key keeps both.
    fn heard(
        &self,
        windows: &[ClipWindow<'_>],
        takes: &[InputSoundTake<'_>],
        ordered: &[Vec<&KeyPressEvent>],
        holds: &[(f64, f64)],
    ) -> Vec<Vec<bool>> {
        let mut heard: Vec<Vec<bool>> = vec![Vec::new(); windows.len()];
        let mut held: Vec<(usize, usize, &str)> = Vec::new();
        let mut previous: Option<(u32, f64, f64)> = None;
        for (window_index, window) in windows.iter().enumerate() {
            let clip = window.clip;
            if clip.speed_audio_muted() {
                continue;
            }
            let Some(take) = takes.get(clip.recording_clip as usize) else {
                continue;
            };
            if !take.keyboard_offset_secs.is_finite() {
                continue;
            }
            let continues = previous.is_some_and(|(recording_clip, end, edited_end)| {
                recording_clip == clip.recording_clip
                    && (end - clip.start).abs() < 1e-6
                    && (edited_end - window.edited_start).abs() < 1e-6
            });
            if !continues {
                held.clear();
            }
            previous = Some((clip.recording_clip, clip.end, window.edited_end));
            let presses = &ordered[clip.recording_clip as usize];
            let source_start = clip.start + take.keyboard_offset_secs;
            let source_end = clip.end + take.keyboard_offset_secs;
            let first = presses.partition_point(|press| press.time_ms / 1000.0 < source_start);
            let last = presses.partition_point(|press| press.time_ms / 1000.0 < source_end);
            let presses = &presses[first..last.max(first)];
            heard[window_index] = vec![false; presses.len()];
            for (index, press) in presses.iter().enumerate() {
                if is_modifier_key(&press.key) {
                    if press.down {
                        held.push((window_index, index, press.key.as_str()));
                    } else {
                        held.retain(|(_, _, key)| *key != press.key);
                    }
                    continue;
                }
                if !press.down {
                    continue;
                }
                let time = held_output_time(
                    holds,
                    window.edited_start
                        + (press.time_ms / 1000.0 - take.keyboard_offset_secs - clip.start)
                            / clip.timescale,
                    false,
                );
                if self.shows(&press.key, time) {
                    heard[window_index][index] = true;
                    for &(modifier_window, modifier, _) in &held {
                        heard[modifier_window][modifier] = true;
                    }
                }
            }
        }
        heard
    }
}

fn ordered_presses<'a>(take: &InputSoundTake<'a>) -> Vec<&'a KeyPressEvent> {
    let mut presses = take
        .keyboard
        .presses
        .iter()
        .filter(|press| press.time_ms.is_finite())
        .collect::<Vec<_>>();
    presses.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));
    presses
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

/// Click sounds are on, and the cursor shows somewhere: globally, or in a
/// style segment that shows it over a hidden global cursor.
pub fn click_sounds_enabled(project: &ProjectConfiguration) -> bool {
    project.cursor.click_sounds
        && (!project.cursor.hide
            || project.timeline.as_ref().is_some_and(|timeline| {
                timeline.style_segments.iter().any(|segment| {
                    segment.enabled
                        && segment
                            .overrides
                            .cursor
                            .as_ref()
                            .is_some_and(|cursor| !cursor.hide)
                })
            }))
}

/// How long a key added by hand is held down before it springs back.
const MANUAL_KEY_HOLD_SECS: f64 = 0.085;

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
    let shortcuts = project
        .keyboard
        .as_ref()
        .filter(|keyboard| keys && !keyboard.settings.show_typing)
        .map(|_| ShownShortcuts::new(project));
    let holds = timeline.hold_windows();
    let mut events = Vec::new();
    let mut ordered_keys: Vec<Option<Vec<&KeyPressEvent>>> = vec![None; takes.len()];
    let windows = clip_windows(timeline);
    let heard = shortcuts.as_ref().map(|shortcuts| {
        let ordered = takes.iter().map(ordered_presses).collect::<Vec<_>>();
        let heard = shortcuts.heard(&windows, takes, &ordered, &holds);
        for (slot, presses) in ordered_keys.iter_mut().zip(ordered) {
            *slot = Some(presses);
        }
        heard
    });
    let mut ordered_clicks: Vec<Option<Vec<&CursorClickEvent>>> = vec![None; takes.len()];
    let mut held: Vec<&str> = Vec::new();
    // Where the last clip's keys left off, so a key held across a split is
    // still released on the far side of it.
    let mut held_until: Option<(u32, f64, f64)> = None;

    for (window_index, window) in windows.iter().enumerate() {
        let clip = window.clip;
        // A clip whose own audio is silent, muted or sped up without kept
        // audio, is silent here too.
        if clip.speed_audio_muted() {
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
            let presses = ordered_keys[clip.recording_clip as usize]
                .get_or_insert_with(|| ordered_presses(take));
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
            let heard = heard.as_ref().map(|heard| &heard[window_index]);
            let presses = &presses[first..last.max(first)];
            for (index, &press) in presses.iter().enumerate() {
                let time = to_output(press.time_ms / 1000.0 - take.keyboard_offset_secs);
                if press.down {
                    if held.contains(&press.key_code.as_str())
                        || !within(&shown, time)
                        || heard.is_some_and(|heard| !heard[index])
                    {
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
                // So does a style segment that hides it, and one that shows
                // it over a hidden global cursor brings them back.
                let visible = timeline.cursor_visibility_at(time) as f32;
                if visible <= 0.0 || project.cursor_at(time).hide {
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

    // Keys added by hand have no recording behind them: they sound as their
    // text strikes them, each key down and back up, over whatever clip lies
    // beneath (silent where that clip is).
    if keys {
        let windows = clip_windows(timeline);
        for (index, segment) in timeline
            .keyboard_segments
            .iter()
            .enumerate()
            .filter(|(_, segment)| crate::keyboard::is_manual_keyboard_segment(segment))
        {
            // Typed text strikes once per code point, but a character a reader
            // sees as one (an emoji with a skin tone, an accented letter)
            // sounds once, on the press that shows it.
            let code_points = segment.display_text.chars().count();
            let typed = segment.keys.len() == code_points
                && !segment.display_text.contains(['⌘', '⌥', '⌃']);
            let mut sounding = vec![true; segment.keys.len()];
            if typed {
                let mut at = 0;
                for piece in crate::keyboard::typed_characters(&segment.display_text) {
                    let length = piece.chars().count();
                    for inside in sounding
                        .iter_mut()
                        .skip(at + 1)
                        .take(length.saturating_sub(1))
                    {
                        *inside = false;
                    }
                    at += length;
                }
            }
            for (key, _) in segment
                .keys
                .iter()
                .zip(&sounding)
                .filter(|(_, sounds)| **sounds)
            {
                let down = segment.start + key.time_offset / 1000.0;
                if !down.is_finite() || down >= segment.end {
                    continue;
                }
                let edited = down - crate::configuration::held_time_before(&holds, down);
                let Some(window) = windows
                    .iter()
                    .find(|window| window.edited_start <= edited && edited < window.edited_end)
                else {
                    continue;
                };
                if window.clip.speed_audio_muted() {
                    continue;
                }
                let up = (down + MANUAL_KEY_HOLD_SECS).min(segment.end);
                let seed = event_seed(3, index as u32, key.time_offset, text_seed(&key.key));
                for (time, down) in [(down, true), (up, false)] {
                    events.push(InputSoundEvent {
                        time,
                        kind: InputSoundKind::Key {
                            class: KeySoundClass::of(&key.key),
                            down,
                        },
                        seed: seed ^ u64::from(down),
                        pan: key_pan(&key.key),
                        gain: window.clip.volume() as f32,
                    });
                }
            }
        }
    }

    events.retain(|event| event.time.is_finite() && event.time >= 0.0);
    events.sort_by(|a, b| a.time.total_cmp(&b.time).then(a.seed.cmp(&b.seed)));
    events
}

#[cfg(test)]
mod tests;
