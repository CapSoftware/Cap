use cap_audio::AudioData;
use cap_project::{
    ClickSoundType, KeySoundType, KeyboardEvents, ProjectConfiguration, RecordingMeta,
    StudioRecordingMeta,
    input_sounds::{
        InputSoundEvent, InputSoundKind, InputSoundTake, KeySoundClass, click_sounds_enabled,
        input_sound_events, key_sounds_enabled,
    },
};
use std::sync::{Arc, OnceLock};
use tracing::warn;

use crate::SegmentMedia;

mod packs;

#[derive(Clone, Copy)]
struct Stroke {
    down: (u32, u32),
    up: Option<(u32, u32)>,
}

struct Pack {
    bytes: &'static [u8],
    frames: u32,
    strokes: [&'static [Stroke]; 6],
}

const LETTER: usize = 0;
const CLICK: usize = 5;

#[derive(Clone, Copy, PartialEq, Eq)]
enum PackId {
    Mechanical,
    Deep,
    Laptop,
    Typewriter,
    Mouse,
    Trackpad,
}

impl PackId {
    #[cfg(test)]
    const ALL: [Self; 6] = [
        Self::Mechanical,
        Self::Deep,
        Self::Laptop,
        Self::Typewriter,
        Self::Mouse,
        Self::Trackpad,
    ];

    fn keys(kind: KeySoundType) -> Self {
        match kind {
            KeySoundType::Mechanical => Self::Mechanical,
            KeySoundType::Deep => Self::Deep,
            KeySoundType::Laptop => Self::Laptop,
            KeySoundType::Typewriter => Self::Typewriter,
        }
    }

    fn clicks(kind: ClickSoundType) -> Self {
        match kind {
            ClickSoundType::Mouse => Self::Mouse,
            ClickSoundType::Trackpad => Self::Trackpad,
        }
    }

    fn index(self) -> usize {
        self as usize
    }

    fn pack(self) -> &'static Pack {
        match self {
            Self::Mechanical => &packs::MECHANICAL,
            Self::Deep => &packs::DEEP,
            Self::Laptop => &packs::LAPTOP,
            Self::Typewriter => &packs::TYPEWRITER,
            Self::Mouse => &packs::MOUSE,
            Self::Trackpad => &packs::TRACKPAD,
        }
    }
}

/// Mono 48 kHz samples of one bundled pack, decoded on first use and kept for
/// the life of the process. Packs nobody turns on are never decoded.
fn decoded(id: PackId) -> Option<&'static [f32]> {
    static DECODED: [OnceLock<Option<Vec<f32>>>; 6] = [const { OnceLock::new() }; 6];
    DECODED[id.index()]
        .get_or_init(|| {
            let pack = id.pack();
            let audio = match AudioData::from_memory(pack.bytes) {
                Ok(audio) => audio,
                Err(error) => {
                    warn!(%error, "Could not decode an input sound pack");
                    return None;
                }
            };
            let channels = usize::from(audio.channels().max(1));
            let samples: Vec<f32> = audio
                .samples()
                .chunks_exact(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32)
                .collect();
            if samples.len() < pack.frames as usize {
                warn!(
                    decoded = samples.len(),
                    expected = pack.frames,
                    "Input sound pack decoded short"
                );
                return None;
            }
            Some(samples)
        })
        .as_deref()
}

#[derive(Clone, Copy)]
struct Voice {
    start: usize,
    offset: u32,
    len: u32,
    frames: usize,
    step: f32,
    left: f32,
    right: f32,
    pack: PackId,
}

/// Key and click sounds placed on the output timeline, ready to be mixed into
/// any block of rendered audio. Built once per play or export; mixing reads
/// only pre-sorted voices and never allocates.
pub struct InputSounds {
    voices: Vec<Voice>,
    banks: [Option<&'static [f32]>; 6],
    longest: usize,
    fingerprint: u64,
}

fn unit(seed: u64, shift: u32) -> f32 {
    ((seed >> shift) & 0xffff) as f32 / 65_535.0
}

fn volume_gain(volume: f32) -> f32 {
    let volume = if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        0.0
    };
    volume * volume
}

fn class_slot(class: KeySoundClass) -> usize {
    match class {
        KeySoundClass::Letter => 0,
        KeySoundClass::Space => 1,
        KeySoundClass::Enter => 2,
        KeySoundClass::Backspace => 3,
        KeySoundClass::Modifier => 4,
    }
}

/// Stabilised keys sound lower than letters. The shift is small enough to
/// keep the recording's character while separating space from enter.
fn class_rate(class: KeySoundClass) -> f32 {
    match class {
        KeySoundClass::Letter => 1.0,
        KeySoundClass::Space => 0.95,
        KeySoundClass::Enter => 0.97,
        KeySoundClass::Backspace => 0.985,
        KeySoundClass::Modifier => 1.015,
    }
}

fn mix_fingerprint(hash: u64, value: u64) -> u64 {
    (hash ^ value).wrapping_mul(0x0100_0000_01b3).rotate_left(5)
}

impl InputSounds {
    pub fn new(project: &ProjectConfiguration, takes: &[InputSoundTake<'_>]) -> Option<Arc<Self>> {
        let events = input_sound_events(project, takes);
        Self::from_events(project, &events)
    }

    pub fn for_segments(
        project: &ProjectConfiguration,
        segments: &[SegmentMedia],
    ) -> Option<Arc<Self>> {
        if !key_sounds_enabled(project) && !click_sounds_enabled(project) {
            return None;
        }
        let takes = segments
            .iter()
            .map(|segment| InputSoundTake {
                keyboard: &segment.keyboard,
                keyboard_offset_secs: segment.keyboard_offset_secs,
                clicks: &segment.cursor.clicks,
            })
            .collect::<Vec<_>>();
        Self::new(project, &takes)
    }

    /// Reads each take's input from disk, for renderers that never load
    /// [`SegmentMedia`].
    pub fn load(
        project: &ProjectConfiguration,
        recording: &RecordingMeta,
        studio: &StudioRecordingMeta,
    ) -> Option<Arc<Self>> {
        let keys = key_sounds_enabled(project);
        let clicks = click_sounds_enabled(project);
        if !keys && !clicks {
            return None;
        }
        let inputs: Vec<(KeyboardEvents, f64, Vec<cap_project::CursorClickEvent>)> = match studio {
            StudioRecordingMeta::SingleSegment { segment } => {
                let clicks = segment
                    .cursor
                    .as_ref()
                    .filter(|_| clicks)
                    .and_then(|path| {
                        cap_project::CursorEvents::load_from_file(&recording.path(path)).ok()
                    })
                    .map(|cursor| cursor.clicks)
                    .unwrap_or_default();
                vec![(KeyboardEvents::default(), 0.0, clicks)]
            }
            StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .map(|segment| {
                    (
                        if keys {
                            segment.keyboard_events(recording)
                        } else {
                            KeyboardEvents::default()
                        },
                        segment.latest_start_time().unwrap_or(0.0),
                        if clicks {
                            segment.cursor_events(recording).clicks
                        } else {
                            Vec::new()
                        },
                    )
                })
                .collect(),
        };
        let takes = inputs
            .iter()
            .map(|(keyboard, offset, clicks)| InputSoundTake {
                keyboard,
                keyboard_offset_secs: *offset,
                clicks,
            })
            .collect::<Vec<_>>();
        Self::new(project, &takes)
    }

    fn from_events(
        project: &ProjectConfiguration,
        events: &[InputSoundEvent],
    ) -> Option<Arc<Self>> {
        if events.is_empty() {
            return None;
        }
        let key_settings = project.keyboard.as_ref().map(|keyboard| &keyboard.settings);
        let key_pack = PackId::keys(
            key_settings.map_or(KeySoundType::default(), |settings| settings.key_sound_type),
        );
        let click_pack = PackId::clicks(project.cursor.click_sound_type);
        let key_gain = volume_gain(key_settings.map_or(0.0, |settings| settings.key_sound_volume));
        let click_gain = volume_gain(project.cursor.click_sound_volume);
        Self::schedule(events, key_pack, key_gain, click_pack, click_gain)
    }

    fn schedule(
        events: &[InputSoundEvent],
        key_pack: PackId,
        key_gain: f32,
        click_pack: PackId,
        click_gain: f32,
    ) -> Option<Arc<Self>> {
        let rate = AudioData::SAMPLE_RATE as f64;
        let mut banks = [None; 6];
        let mut last_variant = [[[usize::MAX; 2]; 6]; 6];
        let mut voices = Vec::with_capacity(events.len());
        for event in events {
            let (pack_id, slot, class, down, gain) = match event.kind {
                InputSoundKind::Key { class, down } => {
                    (key_pack, class_slot(class), Some(class), down, key_gain)
                }
                InputSoundKind::Click { down } => (click_pack, CLICK, None, down, click_gain),
            };
            let gain = gain * event.gain;
            if gain <= 0.0 {
                continue;
            }
            let bank = match banks[pack_id.index()] {
                Some(bank) => bank,
                None => {
                    let Some(bank) = decoded(pack_id) else {
                        continue;
                    };
                    banks[pack_id.index()] = Some(bank);
                    bank
                }
            };
            let pack = pack_id.pack();
            let (pool, slot) = if pack.strokes[slot].is_empty() {
                (pack.strokes[LETTER], LETTER)
            } else {
                (pack.strokes[slot], slot)
            };
            if pool.is_empty() {
                continue;
            }
            let seed = event.seed;
            let part = usize::from(!down);
            let previous = &mut last_variant[pack_id.index()][slot][part];
            let mut variant = (seed % pool.len() as u64) as usize;
            if pool.len() > 1 && variant == *previous {
                variant = (variant + 1 + (seed >> 20) as usize % (pool.len() - 1)) % pool.len();
            }
            *previous = variant;
            let stroke = pool[variant];
            let Some((offset, len)) = (if down { Some(stroke.down) } else { stroke.up }) else {
                continue;
            };
            if len < 4 || (offset + len) as usize > bank.len() {
                continue;
            }
            let jitter = (unit(seed, 8) - 0.5) * 0.03;
            let step = class.map_or(1.0, class_rate) * (1.0 + jitter);
            let level = gain * 10f32.powf((unit(seed, 24) - 0.5) * 2.0 / 20.0);
            let level = if class == Some(KeySoundClass::Modifier) {
                level * 0.85
            } else {
                level
            };
            let pan = (event.pan + (unit(seed, 40) - 0.5) * 0.06).clamp(-1.0, 1.0);
            let start = (event.time * rate).round();
            if !start.is_finite() || start < 0.0 || start > usize::MAX as f64 / 2.0 {
                continue;
            }
            voices.push(Voice {
                start: start as usize,
                offset,
                len,
                frames: ((len - 1) as f32 / step) as usize + 1,
                step,
                left: level * (1.0 - pan.max(0.0)),
                right: level * (1.0 + pan.min(0.0)),
                pack: pack_id,
            });
        }
        if voices.is_empty() {
            return None;
        }
        voices.sort_by_key(|voice| voice.start);
        let longest = voices.iter().map(|voice| voice.frames).max().unwrap_or(0);
        let fingerprint = voices.iter().fold(0xcbf2_9ce4_8422_2325, |hash, voice| {
            let hash = mix_fingerprint(hash, voice.start as u64);
            let hash =
                mix_fingerprint(hash, (u64::from(voice.offset) << 32) | u64::from(voice.len));
            let hash = mix_fingerprint(hash, voice.pack as u64);
            let hash = mix_fingerprint(hash, u64::from(voice.step.to_bits()));
            mix_fingerprint(
                hash,
                (u64::from(voice.left.to_bits()) << 32) | u64::from(voice.right.to_bits()),
            )
        });
        Some(Arc::new(Self {
            voices,
            banks,
            longest,
            fingerprint,
        }))
    }

    pub fn fingerprint(&self) -> u64 {
        self.fingerprint
    }

    pub fn len(&self) -> usize {
        self.voices.len()
    }

    pub fn is_empty(&self) -> bool {
        self.voices.is_empty()
    }

    /// Adds every sound overlapping `[frame_start, frame_start + frames)` to
    /// interleaved stereo `output`, where `frame_start` is the output-timeline
    /// frame of `output[0]`.
    pub fn mix(&self, output: &mut [f32], frame_start: usize) {
        let frames = output.len() / 2;
        if frames == 0 {
            return;
        }
        let frame_end = frame_start.saturating_add(frames);
        let first = self
            .voices
            .partition_point(|voice| voice.start.saturating_add(self.longest) <= frame_start);
        for voice in &self.voices[first..] {
            if voice.start >= frame_end {
                break;
            }
            let voice_end = voice.start + voice.frames;
            if voice_end <= frame_start {
                continue;
            }
            let Some(bank) = self.banks[voice.pack.index()] else {
                continue;
            };
            let samples = &bank[voice.offset as usize..(voice.offset + voice.len) as usize];
            let from = frame_start.max(voice.start);
            let to = frame_end.min(voice_end);
            let out = &mut output[(from - frame_start) * 2..(to - frame_start) * 2];
            let first_frame = from - voice.start;
            if voice.step == 1.0 {
                for (frame, sample) in out
                    .chunks_exact_mut(2)
                    .zip(&samples[first_frame..first_frame + (to - from)])
                {
                    frame[0] += sample * voice.left;
                    frame[1] += sample * voice.right;
                }
            } else {
                for (index, frame) in out.chunks_exact_mut(2).enumerate() {
                    let sample = cubic(samples, (first_frame + index) as f32 * voice.step);
                    frame[0] += sample * voice.left;
                    frame[1] += sample * voice.right;
                }
            }
        }
    }
}

fn input_sound_inputs(project: &ProjectConfiguration) -> Option<Vec<u8>> {
    let keys = key_sounds_enabled(project);
    let clicks = click_sounds_enabled(project);
    if !keys && !clicks {
        return None;
    }
    let settings = project
        .keyboard
        .as_ref()
        .map(|keyboard| &keyboard.settings)
        .filter(|_| keys);
    let timeline = project.timeline.as_ref();
    serde_json::to_vec(&(
        settings.map(|settings| (settings.key_sound_type, settings.key_sound_volume)),
        keys.then(|| {
            timeline.map(|timeline| {
                timeline
                    .keyboard_segments
                    .iter()
                    .map(|segment| (segment.start, segment.end))
                    .collect::<Vec<_>>()
            })
        }),
        clicks.then_some((
            project.cursor.click_sound_type,
            project.cursor.click_sound_volume,
            project.cursor.hide,
        )),
        // Style segments that hide or show the cursor gate its clicks.
        clicks.then(|| {
            timeline.map(|timeline| {
                timeline
                    .style_segments
                    .iter()
                    .filter_map(|segment| {
                        let cursor = segment.overrides.cursor.as_ref()?;
                        Some((
                            segment.start,
                            segment.end,
                            segment.track,
                            segment.enabled,
                            cursor.hide,
                        ))
                    })
                    .collect::<Vec<_>>()
            })
        }),
        timeline.map(|timeline| {
            (
                timeline
                    .segments
                    .iter()
                    .map(|segment| {
                        (
                            segment.recording_clip,
                            segment.start,
                            segment.end,
                            segment.timescale,
                            segment.speed_audio_mode,
                            segment.volume(),
                            segment.hides_cursor(),
                        )
                    })
                    .collect::<Vec<_>>(),
                &timeline.transitions,
                timeline.hold_windows(),
            )
        }),
    ))
    .ok()
}

/// Whether an edit moves, adds, removes or restyles any key or click sound.
pub(crate) fn input_sounds_changed(
    previous: &ProjectConfiguration,
    next: &ProjectConfiguration,
) -> bool {
    input_sound_inputs(previous) != input_sound_inputs(next)
}

/// Catmull-Rom interpolation, clamped at the sample's ends. Pitch variation is
/// a few percent, so this keeps transients clean without a filter bank.
fn cubic(samples: &[f32], position: f32) -> f32 {
    let last = samples.len() - 1;
    let position = position.clamp(0.0, last as f32);
    let index = position as usize;
    let t = position - index as f32;
    let at = |offset: isize| samples[(index as isize + offset).clamp(0, last as isize) as usize];
    let (p0, p1, p2, p3) = (at(-1), at(0), at(1), at(2));
    p1 + 0.5
        * t
        * (p2 - p0 + t * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + t * (3.0 * (p1 - p2) + p3 - p0)))
}

#[derive(Clone, Copy, Debug)]
pub enum InputSoundPreview {
    Keys(KeySoundType),
    Clicks(ClickSoundType),
}

/// A short phrase of typing or clicking with the chosen pack, as interleaved
/// 48 kHz stereo, so the settings can be auditioned without a recording.
pub fn render_input_sound_preview(preview: InputSoundPreview, volume: f32) -> Option<Vec<f32>> {
    let gain = volume_gain(volume);
    let mut events = Vec::new();
    let mut seed = 0x5eed_u64;
    let mut push = |time: f64, kind: InputSoundKind, pan: f32| {
        seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        events.push(InputSoundEvent {
            time,
            kind,
            seed: seed ^ (seed >> 29),
            pan,
            gain: 1.0,
        });
    };
    let (keys, clicks) = match preview {
        InputSoundPreview::Keys(kind) => {
            let typed: [(KeySoundClass, f32, f64); 12] = [
                (KeySoundClass::Letter, 0.05, 0.0),
                (KeySoundClass::Letter, -0.12, 0.11),
                (KeySoundClass::Letter, 0.2, 0.2),
                (KeySoundClass::Letter, 0.2, 0.31),
                (KeySoundClass::Letter, 0.18, 0.43),
                (KeySoundClass::Space, 0.0, 0.58),
                (KeySoundClass::Letter, -0.17, 0.72),
                (KeySoundClass::Letter, 0.18, 0.83),
                (KeySoundClass::Letter, -0.1, 0.92),
                (KeySoundClass::Letter, 0.2, 1.04),
                (KeySoundClass::Letter, -0.08, 1.15),
                (KeySoundClass::Enter, 0.27, 1.42),
            ];
            for (class, pan, time) in typed {
                push(time, InputSoundKind::Key { class, down: true }, pan);
                push(
                    time + 0.075,
                    InputSoundKind::Key { class, down: false },
                    pan,
                );
            }
            (PackId::keys(kind), PackId::Mouse)
        }
        InputSoundPreview::Clicks(kind) => {
            for time in [0.0, 0.55, 0.68] {
                push(time, InputSoundKind::Click { down: true }, 0.0);
                push(time + 0.07, InputSoundKind::Click { down: false }, 0.0);
            }
            (PackId::Mechanical, PackId::clicks(kind))
        }
    };
    events.sort_by(|a, b| a.time.total_cmp(&b.time));
    let sounds = InputSounds::schedule(&events, keys, gain, clicks, gain)?;
    let frames = sounds
        .voices
        .iter()
        .map(|voice| voice.start + voice.frames)
        .max()
        .unwrap_or(0);
    let mut output = vec![0.0; frames * 2];
    sounds.mix(&mut output, 0);
    Some(output)
}

#[cfg(test)]
mod tests;
