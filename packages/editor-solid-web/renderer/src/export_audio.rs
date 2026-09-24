//! Offline audio mix for local exports. Mirrors the native export mixer in
//! `cap-editor` (`AudioRenderer`) and `cap-audio` (`render_audio`): per-clip
//! microphone and system tracks with dB gains and stereo mode, clip volume and
//! speed modes, silent holds, transition gain curves, and timeline music.

use std::collections::HashMap;

use cap_project::{
    ClipSpeedAudioMode, ClipTransitionType, ProjectConfiguration, StereoMode,
    TimelineConfiguration, TimelineFrameMapping, TimelineSource,
};
use wasm_bindgen::prelude::*;

use crate::{AudioSampleSource, VoiceEnhancer, VoiceProfile, js_error};

pub const SAMPLE_RATE: u32 = 48_000;
const MUSIC_SILENCE_DB: f32 = -60.0;

struct Track {
    channels: usize,
    samples: Vec<f32>,
}

impl Track {
    fn frames(&self) -> usize {
        self.samples.len() / self.channels
    }
}

impl AudioSampleSource for Track {
    fn channels(&self) -> u16 {
        self.channels as u16
    }
    fn sample_count(&self) -> usize {
        self.frames()
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        self.samples.get(index)
    }
    fn sample_slice(&self, range: std::ops::Range<usize>) -> Option<&[f32]> {
        self.samples.get(range)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TrackKind {
    Microphone,
    System,
}

struct ClipTrack {
    kind: TrackKind,
    offset_samples: isize,
    track: Track,
    /// Studio Sound state for microphone tracks (profile measured once).
    voice: Option<(VoiceProfile, Option<VoiceEnhancer>)>,
}

#[wasm_bindgen]
pub struct BrowserExportAudio {
    project: ProjectConfiguration,
    timeline: std::rc::Rc<TimelineConfiguration>,
    clips: HashMap<u32, Vec<ClipTrack>>,
    music: HashMap<String, Track>,
    elapsed: usize,
    pending: Vec<f32>,
    total: usize,
}

fn samples_at(seconds: f64) -> usize {
    (seconds * f64::from(SAMPLE_RATE)).round().max(0.0) as usize
}

fn gain_for_db(db: f32) -> Option<f32> {
    (db > -30.0).then(|| 10.0_f32.powf(db / 20.0))
}

fn music_gain(volume_db: f32) -> f32 {
    if volume_db <= MUSIC_SILENCE_DB {
        0.0
    } else {
        10.0_f32.powf(volume_db / 20.0)
    }
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Band-limited resampling of interleaved samples to 48 kHz: a Hann-windowed
/// sinc (cutoff 0.97 of the lower Nyquist, like the native resampler) with
/// one precomputed filter per output phase.
pub fn resample(input: &[f32], channels: usize, rate: u32) -> Vec<f32> {
    if rate == SAMPLE_RATE || input.is_empty() || rate == 0 {
        return input.to_vec();
    }
    const HALF_TAPS: i64 = 16;
    const TAPS: usize = (HALF_TAPS * 2) as usize;
    let divisor = gcd(u64::from(SAMPLE_RATE), u64::from(rate));
    let up = u64::from(SAMPLE_RATE) / divisor;
    let down = u64::from(rate) / divisor;
    let ratio = f64::from(SAMPLE_RATE) / f64::from(rate);
    let cutoff = 0.97 * ratio.min(1.0);
    let frames = (input.len() / channels) as i64;
    let out_frames = ((frames as f64) * ratio).round() as usize;
    // Phase p holds the taps for an output sample whose source position has
    // fractional part p / up.
    let mut table = vec![0.0f32; up as usize * TAPS];
    for phase in 0..up as usize {
        let fraction = phase as f64 / up as f64;
        let mut total = 0.0;
        let weights = &mut table[phase * TAPS..(phase + 1) * TAPS];
        for (index, weight) in weights.iter_mut().enumerate() {
            let x = fraction - (index as i64 - HALF_TAPS + 1) as f64;
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                (std::f64::consts::PI * x * cutoff).sin() / (std::f64::consts::PI * x)
            };
            let window = if x.abs() < HALF_TAPS as f64 {
                0.5 + 0.5 * (std::f64::consts::PI * x / HALF_TAPS as f64).cos()
            } else {
                0.0
            };
            let value = sinc * window;
            *weight = value as f32;
            total += value;
        }
        if total.abs() > 1e-12 {
            for weight in weights.iter_mut() {
                *weight = (f64::from(*weight) / total) as f32;
            }
        }
    }
    let mut output = vec![0.0f32; out_frames * channels];
    for frame in 0..out_frames as u64 {
        let numerator = frame * down;
        let center = (numerator / up) as i64;
        let phase = (numerator % up) as usize;
        let weights = &table[phase * TAPS..(phase + 1) * TAPS];
        let first = center - HALF_TAPS + 1;
        for channel in 0..channels {
            let mut value = 0.0f32;
            for (index, weight) in weights.iter().enumerate() {
                let tap = first + index as i64;
                if tap >= 0 && tap < frames {
                    value += weight * input[tap as usize * channels + channel];
                }
            }
            output[frame as usize * channels + channel] = value;
        }
    }
    output
}

impl BrowserExportAudio {
    fn stereo_mode(&self, kind: TrackKind) -> StereoMode {
        match kind {
            TrackKind::Microphone => self.project.audio.mic_stereo_mode.clone(),
            TrackKind::System => StereoMode::Stereo,
        }
    }

    fn track_gain(&self, kind: TrackKind) -> Option<f32> {
        if self.project.audio.mute {
            return None;
        }
        gain_for_db(match kind {
            TrackKind::Microphone => self.project.audio.mic_volume_db,
            TrackKind::System => self.project.audio.system_volume_db,
        })
    }

    /// `cap_audio::render_audio` for one clip at 1x: mixes every track into
    /// `out` starting at recording sample `offset` and clamps the sum.
    fn mix_clip(&mut self, clip: u32, offset: usize, out: &mut [f32]) {
        let improve = self.project.audio.improve && !self.project.audio.mute;
        let strength = self.project.audio.isolation.strength();
        let gains = [
            self.track_gain(TrackKind::Microphone),
            self.track_gain(TrackKind::System),
        ];
        let mic_mode = self.stereo_mode(TrackKind::Microphone);
        let Some(tracks) = self.clips.get_mut(&clip) else {
            return;
        };
        let frames = out.len() / 2;
        let mut wrote = false;
        for clip_track in tracks.iter_mut() {
            let Some(gain) = gains[match clip_track.kind {
                TrackKind::Microphone => 0,
                TrackKind::System => 1,
            }] else {
                continue;
            };
            let mode = match clip_track.kind {
                TrackKind::Microphone => mic_mode.clone(),
                TrackKind::System => StereoMode::Stereo,
            };
            let track = &clip_track.track;
            let start = offset as isize + clip_track.offset_samples;
            // `render_audio_data_chunk`: microphone tracks mix their Studio
            // Sound rendering in place of the original samples.
            let enhanced = match (&mut clip_track.voice, improve) {
                (Some((profile, enhancer)), true) => {
                    let first = start.max(0) as usize;
                    let end = (start + frames as isize).max(0) as usize;
                    if first >= end || first >= track.frames() {
                        None
                    } else {
                        let enhancer = enhancer.get_or_insert_with(|| {
                            VoiceEnhancer::with_settings(track.channels as u16, strength, *profile)
                        });
                        Some(enhancer.render(track, first, end - first))
                    }
                }
                _ => None,
            };
            for (index, frame) in out.chunks_exact_mut(2).enumerate().take(frames) {
                let source = start + index as isize;
                if source < 0 || source as usize >= track.frames() {
                    continue;
                }
                let base = source as usize * track.channels;
                let sample_at = |index: usize| match &enhanced {
                    Some(audio) => audio.sample(index).copied(),
                    None => track.samples.get(index).copied(),
                };
                let (left, right) = if track.channels == 1 {
                    let Some(sample) = sample_at(base) else {
                        continue;
                    };
                    let sample = sample * 0.707;
                    (sample, sample)
                } else {
                    let (Some(left), Some(right)) = (sample_at(base), sample_at(base + 1)) else {
                        continue;
                    };
                    match mode {
                        StereoMode::Stereo => (left, right),
                        StereoMode::MonoL => (left, left),
                        StereoMode::MonoR => (right, right),
                    }
                };
                frame[0] += left * gain;
                frame[1] += right * gain;
                wrote = true;
            }
        }
        if wrote {
            for sample in out {
                *sample = sample.clamp(-1.0, 1.0);
            }
        }
    }

    /// `AudioRenderer::render_segment_chunk`: one timeline source for
    /// `frames` output samples starting `span_offset` samples into its span.
    fn render_source(&mut self, source: TimelineSource<'_>, span_offset: usize, out: &mut [f32]) {
        let segment = source.segment;
        let frames = out.len() / 2;
        if segment.timescale == 1.0 {
            if segment.speed_audio_mode == Some(ClipSpeedAudioMode::Mute) {
                return;
            }
            self.mix_clip(
                segment.recording_clip,
                samples_at(source.source_time) + span_offset,
                out,
            );
        } else {
            let mode = segment.speed_audio_mode.unwrap_or_default();
            if self.project.audio.mute
                || mode == ClipSpeedAudioMode::Mute
                || !segment.timescale.is_finite()
                || !(0.25..=8.0).contains(&segment.timescale)
            {
                return;
            }
            let start = source.source_time * f64::from(SAMPLE_RATE)
                + span_offset as f64 * segment.timescale;
            let source_frames = (frames as f64 * segment.timescale).ceil() as usize + 2;
            let mut source_buffer = vec![0.0; source_frames * 2];
            self.mix_clip(
                segment.recording_clip,
                start.floor() as usize,
                &mut source_buffer,
            );
            match mode {
                ClipSpeedAudioMode::MatchSpeed => {
                    let fraction = start - start.floor();
                    for (index, frame) in out.chunks_exact_mut(2).enumerate() {
                        let position = fraction + index as f64 * segment.timescale;
                        let left = position.floor() as usize;
                        let t = (position - position.floor()) as f32;
                        for channel in 0..2 {
                            let a = source_buffer
                                .get(left * 2 + channel)
                                .copied()
                                .unwrap_or(0.0);
                            let b = source_buffer
                                .get((left + 1) * 2 + channel)
                                .copied()
                                .unwrap_or(a);
                            frame[channel] = a + (b - a) * t;
                        }
                    }
                }
                ClipSpeedAudioMode::MaintainPitch => {
                    time_stretch(&source_buffer, segment.timescale, out);
                }
                ClipSpeedAudioMode::Mute => {}
            }
        }
        let volume = segment.volume() as f32;
        if volume != 1.0 {
            for sample in out.iter_mut() {
                *sample *= volume;
            }
        }
    }

    fn mix_music(&self, frame_start: usize, out: &mut [f32]) {
        let rate = f64::from(SAMPLE_RATE);
        let frames = out.len() / 2;
        let frame_start = frame_start as i64;
        let frame_end = frame_start + frames as i64;
        for segment in &self.timeline.audio_segments {
            if !segment.enabled || segment.end <= segment.start {
                continue;
            }
            let gain = music_gain(segment.volume_db);
            if gain <= 0.0 {
                continue;
            }
            let Some(data) = self.music.get(&segment.path) else {
                continue;
            };
            let start_sample = (segment.start * rate).round() as i64;
            let end_sample = (segment.end * rate).round() as i64;
            let segment_len = end_sample - start_sample;
            if segment_len <= 0 {
                continue;
            }
            let lo = start_sample.max(frame_start);
            let hi = end_sample.min(frame_end);
            if lo >= hi {
                continue;
            }
            let trim = (segment.trim_start.max(0.0) * rate).round() as i64;
            let fade_in = (segment.fade_in.max(0.0) * rate).round() as i64;
            let fade_out = (segment.fade_out.max(0.0) * rate).round() as i64;
            let source_frames = data.frames() as i64;
            for out_sample in lo..hi {
                let local = out_sample - start_sample;
                let source = trim + local;
                if source < 0 || source >= source_frames {
                    continue;
                }
                let mut g = gain;
                if fade_in > 0 && local < fade_in {
                    g *= local as f32 / fade_in as f32;
                }
                let until_end = segment_len - local;
                if fade_out > 0 && until_end <= fade_out {
                    g *= (until_end as f32 / fade_out as f32).clamp(0.0, 1.0);
                }
                if g <= 0.0 {
                    continue;
                }
                let base = source as usize * data.channels;
                let (left, right) = if data.channels == 1 {
                    let sample = data.samples[base] * 0.707;
                    (sample, sample)
                } else {
                    (data.samples[base], data.samples[base + 1])
                };
                let index = ((out_sample - frame_start) as usize) * 2;
                out[index] = (out[index] + left * g).clamp(-1.0, 1.0);
                out[index + 1] = (out[index + 1] + right * g).clamp(-1.0, 1.0);
            }
        }
    }

    /// Renders the next mapping span (or part of it) into `pending`.
    fn render_span(&mut self, max_frames: usize) -> bool {
        if self.elapsed >= self.total {
            return false;
        }
        let rate = f64::from(SAMPLE_RATE);
        let mut mapping_time = self.elapsed as f64 / rate;
        let timeline = self.timeline.clone();
        let (mapping, end) = loop {
            let Some(mapping) = timeline.get_frame_mapping(mapping_time) else {
                let frames = (self.total - self.elapsed).min(max_frames);
                let start = self.elapsed;
                let mut out = vec![0.0; frames * 2];
                self.mix_music(start, &mut out);
                self.pending.extend_from_slice(&out);
                self.elapsed += frames;
                return true;
            };
            let output_end = match mapping {
                TimelineFrameMapping::Single { output_end, .. }
                | TimelineFrameMapping::Transition { output_end, .. }
                | TimelineFrameMapping::Hold { output_end, .. } => output_end,
            };
            let end = samples_at(output_end);
            if end > self.elapsed {
                break (mapping, end);
            }
            if output_end <= mapping_time {
                let frames = (self.total - self.elapsed).min(max_frames);
                self.pending.extend(std::iter::repeat_n(0.0, frames * 2));
                self.elapsed += frames;
                return true;
            }
            mapping_time = output_end;
        };
        let span_start_time = mapping_time;
        let span_offset = self.elapsed - samples_at(span_start_time);
        let frames = end
            .min(self.total)
            .saturating_sub(self.elapsed)
            .min(max_frames)
            .max(1);
        let mut out = vec![0.0; frames * 2];
        match mapping {
            TimelineFrameMapping::Single { source, .. } => {
                self.render_source(source, span_offset, &mut out);
            }
            TimelineFrameMapping::Hold { .. } => {}
            TimelineFrameMapping::Transition {
                outgoing,
                incoming,
                kind,
                progress,
                duration,
                ..
            } => {
                let mut outgoing_buffer = vec![0.0; frames * 2];
                let mut incoming_buffer = vec![0.0; frames * 2];
                self.render_source(outgoing, span_offset, &mut outgoing_buffer);
                self.render_source(incoming, span_offset, &mut incoming_buffer);
                let per_sample = 1.0 / (duration * rate);
                for (index, frame) in out.chunks_exact_mut(2).enumerate() {
                    let progress = (progress + index as f64 * per_sample).clamp(0.0, 1.0);
                    let (outgoing_gain, incoming_gain) = match kind {
                        ClipTransitionType::CrossFade => {
                            let angle = progress * std::f64::consts::FRAC_PI_2;
                            (angle.cos() as f32, angle.sin() as f32)
                        }
                        ClipTransitionType::FadeThroughBlack => (
                            (1.0 - progress * 2.0).max(0.0) as f32,
                            (progress * 2.0 - 1.0).max(0.0) as f32,
                        ),
                    };
                    for channel in 0..2 {
                        frame[channel] = (outgoing_buffer[index * 2 + channel] * outgoing_gain
                            + incoming_buffer[index * 2 + channel] * incoming_gain)
                            .clamp(-1.0, 1.0);
                    }
                }
            }
        }
        self.mix_music(self.elapsed, &mut out);
        self.pending.extend_from_slice(&out);
        self.elapsed += frames;
        true
    }
}

/// WSOLA time stretch of an interleaved stereo buffer by `timescale`
/// (> 1 speeds up), keeping pitch.
fn time_stretch(source: &[f32], timescale: f64, out: &mut [f32]) {
    const WINDOW: usize = 1024;
    const OVERLAP: usize = WINDOW / 2;
    const SEARCH: isize = 256;
    let source_frames = source.len() / 2;
    let out_frames = out.len() / 2;
    let hop_out = WINDOW - OVERLAP;
    let hop_in = hop_out as f64 * timescale;
    let mut previous_tail: Vec<f32> = Vec::new();
    let mut written = 0;
    let mut segment = 0usize;
    while written < out_frames {
        let nominal = (segment as f64 * hop_in).round() as isize;
        let mut best = nominal;
        if !previous_tail.is_empty() {
            let mut best_score = f32::MIN;
            for delta in -SEARCH..=SEARCH {
                let start = nominal + delta;
                if start < 0 || start as usize + OVERLAP >= source_frames {
                    continue;
                }
                let mut score = 0.0;
                for index in (0..OVERLAP).step_by(4) {
                    let base = (start as usize + index) * 2;
                    score += source[base] * previous_tail[index * 2]
                        + source[base + 1] * previous_tail[index * 2 + 1];
                }
                if score > best_score {
                    best_score = score;
                    best = start;
                }
            }
        }
        let start = best.max(0) as usize;
        for index in 0..WINDOW {
            let out_index = written + index;
            if out_index >= out_frames {
                break;
            }
            let source_index = start + index;
            let (left, right) = if source_index < source_frames {
                (source[source_index * 2], source[source_index * 2 + 1])
            } else {
                (0.0, 0.0)
            };
            if index < OVERLAP && !previous_tail.is_empty() {
                let fade = index as f32 / OVERLAP as f32;
                out[out_index * 2] = previous_tail[index * 2] * (1.0 - fade) + left * fade;
                out[out_index * 2 + 1] = previous_tail[index * 2 + 1] * (1.0 - fade) + right * fade;
            } else if index < hop_out {
                out[out_index * 2] = left;
                out[out_index * 2 + 1] = right;
            }
        }
        previous_tail.clear();
        for index in hop_out..WINDOW {
            let source_index = start + index;
            if source_index < source_frames {
                previous_tail.push(source[source_index * 2]);
                previous_tail.push(source[source_index * 2 + 1]);
            } else {
                previous_tail.push(0.0);
                previous_tail.push(0.0);
            }
        }
        written += hop_out;
        segment += 1;
    }
}

#[wasm_bindgen]
impl BrowserExportAudio {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, total_frames: u32) -> Result<BrowserExportAudio, JsValue> {
        let project: ProjectConfiguration = serde_json::from_str(config_json).map_err(js_error)?;
        let timeline = std::rc::Rc::new(
            project
                .timeline
                .clone()
                .ok_or_else(|| js_error("Export timeline is missing"))?,
        );
        Ok(Self {
            project,
            timeline,
            clips: HashMap::new(),
            music: HashMap::new(),
            elapsed: 0,
            pending: Vec::new(),
            total: total_frames as usize,
        })
    }

    /// Adds a decoded recording track. `offset_seconds` is where recording
    /// time zero falls in the track (the preview's `audio_times` offset).
    pub fn add_track(
        &mut self,
        clip: u32,
        microphone: bool,
        channels: u32,
        sample_rate: u32,
        offset_seconds: f64,
        samples: Vec<f32>,
    ) -> Result<(), JsValue> {
        if !(1..=2).contains(&channels) || sample_rate == 0 {
            return Err(js_error("Export audio track is invalid"));
        }
        let channels = channels as usize;
        let samples = resample(&samples, channels, sample_rate);
        let track = Track { channels, samples };
        let voice = (microphone && self.project.audio.improve)
            .then(|| (VoiceProfile::analyze(&track), None));
        self.clips.entry(clip).or_default().push(ClipTrack {
            kind: if microphone {
                TrackKind::Microphone
            } else {
                TrackKind::System
            },
            offset_samples: (offset_seconds * f64::from(SAMPLE_RATE)).round() as isize,
            track,
            voice,
        });
        Ok(())
    }

    pub fn add_music(
        &mut self,
        path: &str,
        channels: u32,
        sample_rate: u32,
        samples: Vec<f32>,
    ) -> Result<(), JsValue> {
        if !(1..=2).contains(&channels) || sample_rate == 0 {
            return Err(js_error("Export music track is invalid"));
        }
        let channels = channels as usize;
        self.music.insert(
            path.to_owned(),
            Track {
                channels,
                samples: resample(&samples, channels, sample_rate),
            },
        );
        Ok(())
    }

    /// Interleaved stereo 48 kHz samples; empty once the timeline is done.
    pub fn next_chunk(&mut self, frames: u32) -> Vec<f32> {
        let frames = frames.max(1) as usize;
        while self.pending.len() < frames * 2 && self.render_span(frames) {}
        let take = self.pending.len().min(frames * 2);
        self.pending.drain(..take).collect()
    }
}
