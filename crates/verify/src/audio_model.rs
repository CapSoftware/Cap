//! Reference model and oracle for audio: where every source marker must be
//! heard in an output (export or offline playback), at what level, and
//! nowhere else.
//!
//! Written from the project's documented rules, not by calling the
//! production mapping:
//! - Timeline segments play back to back; segment `k` covers
//!   `(end - start) / timescale` output seconds and maps output time `u` in it
//!   to recording time `start + u * timescale`. A transition into segment `k`
//!   overlaps the two segments by its clamped duration. A cross-fade mixes
//!   the outgoing clip at `cos(p * pi / 2)` and the incoming one at
//!   `sin(p * pi / 2)` (equal power, `p` = progress through the overlap); a
//!   fade through black at `max(1 - 2p, 0)` and `max(2p - 1, 0)`. Markers
//!   wholly inside the overlap whose blend gain is at least
//!   `BLEND_REQUIRED_GAIN` must be heard at that gain; the rest may be heard
//!   at any level.
//! - A recording audio track sample at track time `t` plays at recording time
//!   `t - offset`, where `offset` is the clip's stored offset for that track
//!   (mic or system audio; auto-calculated offsets align every track to the
//!   latest track start).
//! - Stale-startup repair: a track whose recording-meta gap summary reports
//!   at least 3 startup overlap drops, at least 3 dropped frames and 100 to
//!   2000 ms of startup overlap trimmed plays that many ms earlier (its offset
//!   is reduced by the trimmed time).
//! - Track gain is `10^(dB / 20)`; at or below -30 dB, or with the project
//!   muted, the track is silent. Clip volume multiplies the recording mix. A
//!   mono track is centre-panned at -3 dB (0.707 per channel).
//! - Retimed segments (timescale != 1) are silent in the default `mute` speed
//!   audio mode; `matchSpeed` plays the source resampled (the marker is
//!   compressed in time by the timescale and its pitch scaled with it);
//!   `maintainPitch` time-stretches and is not marker-checked.
//! - Timeline music (audio segments) plays in output time from `trim_start`,
//!   independent of recording edits, at `10^(volume_db / 20)` (silent at or
//!   below -60 dB), with linear fades that are not level-checked.
//! - Studio Sound processes the microphone only: mic markers must still be
//!   heard exactly once at the right time, but their level is not checked.

use std::path::Path;

use anyhow::{Context, bail};
use cap_project::{
    ClipSpeedAudioMode, ClipTransitionType, ProjectConfiguration, RecordingMeta,
    StudioRecordingMeta,
};
use serde::{Deserialize, Serialize};

use crate::{
    audio_code::{self, AudioSource, LocatedMarker, MARKER_SECS},
    media,
};

/// Sample rate every analysis runs at (the editor's mixing rate).
pub const ANALYSIS_RATE: u32 = 48_000;
/// Largest allowed difference between a marker's heard and expected time.
pub const TIME_TOLERANCE_SECS: f64 = 0.005;
/// Largest allowed relative level error where the level is checked.
pub const GAIN_TOLERANCE: f64 = 0.25;
const MATCH_WINDOW_SECS: f64 = 0.040;
/// Detections quieter than this (-60 dB below a unit marker) are numerical
/// noise: the chirp correlation is normalised, so near-silent rounding
/// residue can correlate. Real markers are heard at 0.05 or more.
const MIN_HEARD_GAIN: f64 = 1e-3;
/// Chirps of one source correlate weakly (up to ~0.7) with another source's
/// chirp and bit tones. Undecodable detections below this are that
/// cross-talk; unprocessed markers correlate above 0.95 even after AAC.
/// Studio Sound bends the mic chirp (down to ~0.74) and can smear its bits,
/// so processed mic markers are matched by time instead.
const CROSSTALK_CORRELATION: f64 = 0.8;
const MIN_TRANSITION: f64 = 0.05;
const MONO_PAN: f64 = 0.707;
/// Blend gain from which a marker inside a transition must be heard (and its
/// level checked); quieter blended markers may be missed by the detector.
const BLEND_REQUIRED_GAIN: f64 = 0.75;
/// Offset of the point a marker's level is measured at (the chirp centre).
const CHIRP_CENTRE_SECS: f64 = 0.010;

/// Gain a transition applies to the outgoing (`incoming == false`) or
/// incoming clip at progress `p`.
fn blend_gain(kind: ClipTransitionType, p: f64, incoming: bool) -> f64 {
    let p = p.clamp(0.0, 1.0);
    match (kind, incoming) {
        (ClipTransitionType::CrossFade, false) => (p * std::f64::consts::FRAC_PI_2).cos(),
        (ClipTransitionType::CrossFade, true) => (p * std::f64::consts::FRAC_PI_2).sin(),
        (ClipTransitionType::FadeThroughBlack, false) => (1.0 - 2.0 * p).max(0.0),
        (ClipTransitionType::FadeThroughBlack, true) => (2.0 * p - 1.0).max(0.0),
    }
}

/// One marker found in a source file.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct SourceMarker {
    pub index: u32,
    /// Chirp start in seconds of file time.
    pub time_secs: f64,
    /// Level relative to a unit marker, averaged over the file's channels.
    pub gain: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackAudioTruth {
    pub source: AudioSource,
    pub channels: usize,
    pub markers: Vec<SourceMarker>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SegmentAudioTruth {
    pub mic: Option<TrackAudioTruth>,
    pub system: Option<TrackAudioTruth>,
}

/// Markers of every recording audio track (and timeline music files), read
/// back from the files.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AudioTruth {
    pub segments: Vec<SegmentAudioTruth>,
    /// Music file path (as written in the project) -> markers.
    pub music: Vec<(String, TrackAudioTruth)>,
}

/// Locates every marker of `source` in a file (all channels averaged).
pub fn read_track_truth(path: &Path, source: AudioSource) -> anyhow::Result<TrackAudioTruth> {
    let decoded = media::decode_audio(path, Some(ANALYSIS_RATE))
        .with_context(|| format!("decode {path:?}"))?;
    let found = audio_code::locate_markers(&decoded.mono(), ANALYSIS_RATE, source);
    let mut markers = Vec::new();
    for marker in found {
        let Some(index) = marker.index else {
            bail!(
                "{path:?}: undecodable {} marker at {:.3}s",
                source.name(),
                marker.time_secs
            );
        };
        markers.push(SourceMarker {
            index,
            time_secs: marker.time_secs + decoded.start_secs,
            gain: marker.gain,
        });
    }
    if markers.is_empty() {
        bail!("{path:?}: no {} markers", source.name());
    }
    Ok(TrackAudioTruth {
        source,
        channels: decoded.channels.len(),
        markers,
    })
}

impl AudioTruth {
    /// Reads every audio track of a multi-segment studio project plus the
    /// music files referenced by `config`. Cached in the project directory.
    pub fn read(project: &Path, config: &ProjectConfiguration) -> anyhow::Result<Self> {
        let cache = project.join("verify-audio-truth.json");
        let mut truth: AudioTruth = std::fs::read_to_string(&cache)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let meta = RecordingMeta::load_for_project(project)
            .map_err(|e| anyhow::anyhow!("load meta: {e:?}"))?;
        let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
            bail!("not a multi-segment studio project");
        };
        let mut changed = false;
        if truth.segments.len() != inner.segments.len() {
            truth.segments = inner
                .segments
                .iter()
                .map(|segment| -> anyhow::Result<SegmentAudioTruth> {
                    Ok(SegmentAudioTruth {
                        mic: segment
                            .mic
                            .as_ref()
                            .map(|m| {
                                read_track_truth(&project.join(m.path.as_str()), AudioSource::Mic)
                            })
                            .transpose()?,
                        system: segment
                            .system_audio
                            .as_ref()
                            .map(|s| {
                                read_track_truth(
                                    &project.join(s.path.as_str()),
                                    AudioSource::System,
                                )
                            })
                            .transpose()?,
                    })
                })
                .collect::<anyhow::Result<_>>()?;
            changed = true;
        }
        if let Some(timeline) = &config.timeline {
            for segment in &timeline.audio_segments {
                if truth.music.iter().any(|(p, _)| *p == segment.path) {
                    continue;
                }
                let path = Path::new(&segment.path);
                let path = if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    project.join(path)
                };
                truth.music.push((
                    segment.path.clone(),
                    read_track_truth(&path, AudioSource::Media)?,
                ));
                changed = true;
            }
        }
        if changed {
            let _ = std::fs::write(&cache, serde_json::to_string(&truth)?);
        }
        Ok(truth)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    /// Must be heard exactly once.
    Required,
    /// May be heard (cut by an edit boundary, inside a transition or fade);
    /// if heard it must be at the right time.
    Optional,
}

/// Where one source marker must be heard in the output.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExpectedMarker {
    pub source: AudioSource,
    pub index: u32,
    /// Output time of the chirp start.
    pub time_secs: f64,
    /// Expected level of the output's channel average, when checked.
    pub gain: Option<f64>,
    pub presence: Presence,
    /// Time compression of the marker (the segment timescale for
    /// `matchSpeed`, else 1).
    pub rate: f64,
    /// Recording clip and recording time the marker belongs to (`None` for
    /// timeline music), for A/V checks and reports.
    pub recording: Option<(usize, f64)>,
    /// Whether the marker's payload survives processing. Studio Sound can
    /// smear the FSK bits; such a marker is matched by its chirp time.
    pub payload: bool,
    /// Whether the marker sounds inside a clip transition, where the video
    /// is a blend of two frames and has no single frame to time it against.
    #[serde(default)]
    pub blended: bool,
}

/// An output window in which detections of `source` are not judged.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UncheckedWindow {
    pub source: AudioSource,
    pub start: f64,
    pub end: f64,
    pub reason: String,
}

/// A window of output time with time-compressed markers (`matchSpeed`).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RateWindow {
    pub start: f64,
    pub end: f64,
    pub rate: f64,
}

#[derive(Clone, Debug)]
struct ModelSegment {
    clip: usize,
    start: f64,
    end: f64,
    timescale: f64,
    mode: ClipSpeedAudioMode,
    volume: f64,
    transition_in: f64,
    transition_kind: ClipTransitionType,
}

impl ModelSegment {
    fn duration(&self) -> f64 {
        (self.end - self.start) / self.timescale
    }
}

/// Clip track offsets as stored in the project.
#[derive(Clone, Copy, Debug)]
struct ClipAudioOffsets {
    mic: f64,
    system: f64,
}

pub struct AudioModel {
    pub expected: Vec<ExpectedMarker>,
    pub unchecked: Vec<UncheckedWindow>,
    pub rate_windows: Vec<RateWindow>,
    pub duration: f64,
}

fn db_gain(db: f32) -> Option<f64> {
    (db > -30.0).then(|| 10f64.powf(f64::from(db) / 20.0))
}

impl AudioModel {
    pub fn new(
        meta: &RecordingMeta,
        project: &ProjectConfiguration,
        truth: &AudioTruth,
    ) -> anyhow::Result<Self> {
        let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
            bail!("the audio model covers multi-segment studio projects");
        };
        let timeline = project
            .timeline
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("project has no timeline"))?;
        let repair = |audio: Option<&cap_project::AudioMeta>| {
            audio
                .and_then(|a| a.gap_summary.as_ref())
                .filter(|s| {
                    s.startup_overlap_drops >= 3
                        && s.overlap_dropped_frames >= 3
                        && (100..=2000).contains(&s.startup_overlap_trimmed_ms)
                })
                .map_or(0.0, |s| -f64::from(s.startup_overlap_trimmed_ms) / 1000.0)
        };
        let offsets: Vec<ClipAudioOffsets> = (0..inner.segments.len())
            .map(|i| {
                let clip = project.clips.iter().find(|c| c.index as usize == i);
                let segment = &inner.segments[i];
                ClipAudioOffsets {
                    mic: clip.map_or(0.0, |c| f64::from(c.offsets.mic))
                        + repair(segment.mic.as_ref()),
                    system: clip.map_or(0.0, |c| f64::from(c.offsets.system_audio))
                        + repair(segment.system_audio.as_ref()),
                }
            })
            .collect();
        let mut segments: Vec<ModelSegment> = timeline
            .segments
            .iter()
            .map(|s| ModelSegment {
                clip: s.recording_clip as usize,
                start: s.start,
                end: s.end,
                timescale: s.timescale,
                mode: s.speed_audio_mode.unwrap_or_default(),
                volume: s
                    .volume
                    .filter(|v| v.is_finite())
                    .unwrap_or(1.0)
                    .clamp(0.0, 2.0),
                transition_in: 0.0,
                transition_kind: ClipTransitionType::CrossFade,
            })
            .collect();
        for transition in &timeline.transitions {
            let k = transition.segment_index as usize;
            if k == 0 || k >= segments.len() {
                continue;
            }
            let max = segments[k - 1].duration().min(segments[k].duration()) / 2.0;
            if transition.duration.is_finite() && transition.duration > 0.0 && max >= MIN_TRANSITION
            {
                segments[k].transition_in = transition.duration.clamp(MIN_TRANSITION, max);
                segments[k].transition_kind = transition.kind;
            }
        }
        let mut output_starts = Vec::with_capacity(segments.len());
        let mut at = 0.0;
        for (k, segment) in segments.iter().enumerate() {
            output_starts.push(at);
            let next_in = segments.get(k + 1).map_or(0.0, |n| n.transition_in);
            at += segment.duration() - next_in;
        }
        let duration = at;
        let audio = &project.audio;
        let mut expected = Vec::new();
        let mut unchecked = Vec::new();
        let mut rate_windows = Vec::new();
        // Whether each recording marker in `expected` sounds inside a transition.
        let mut in_blend: Vec<bool> = Vec::new();

        for (k, segment) in segments.iter().enumerate() {
            let out_start = output_starts[k];
            let out_end = out_start + segment.duration();
            // Output window shared with a neighbour's transition.
            let blend_until = out_start + segment.transition_in;
            let next_in = segments.get(k + 1).map_or(0.0, |n| n.transition_in);
            let next_kind = segments
                .get(k + 1)
                .map_or(ClipTransitionType::CrossFade, |n| n.transition_kind);
            let blend_from = out_end - next_in;
            let Some(clip_truth) = truth.segments.get(segment.clip) else {
                continue;
            };
            let retimed = (segment.timescale - 1.0).abs() > f64::EPSILON;
            if retimed && segment.mode == ClipSpeedAudioMode::MaintainPitch {
                for source in [AudioSource::Mic, AudioSource::System] {
                    unchecked.push(UncheckedWindow {
                        source,
                        start: out_start,
                        end: out_end,
                        reason: "maintainPitch time stretch".into(),
                    });
                }
                continue;
            }
            let silent = audio.mute || (retimed && segment.mode == ClipSpeedAudioMode::Mute);
            if retimed && !silent {
                rate_windows.push(RateWindow {
                    start: out_start,
                    end: out_end,
                    rate: segment.timescale,
                });
            }
            let tracks = [
                (
                    clip_truth.mic.as_ref(),
                    offsets[segment.clip].mic,
                    db_gain(audio.mic_volume_db),
                    audio.improve,
                ),
                (
                    clip_truth.system.as_ref(),
                    offsets[segment.clip].system,
                    db_gain(audio.system_volume_db),
                    false,
                ),
            ];
            for (track, offset, gain, processed) in tracks {
                let Some(track) = track else { continue };
                let Some(gain) = gain.filter(|_| !silent) else {
                    continue;
                };
                let pan = if track.channels == 1 { MONO_PAN } else { 1.0 };
                let marker_len = MARKER_SECS * segment.timescale;
                for marker in &track.markers {
                    let recording_time = marker.time_secs - offset;
                    if recording_time + marker_len <= segment.start || recording_time >= segment.end
                    {
                        continue;
                    }
                    let time = out_start + (recording_time - segment.start) / segment.timescale;
                    let whole = recording_time >= segment.start
                        && recording_time + marker_len <= segment.end;
                    let marker_end = time + MARKER_SECS / segment.timescale;
                    let blended = time < blend_until || marker_end > blend_from;
                    // Blend gain when the whole marker lies in one overlap.
                    let blend = if !blended {
                        Some(1.0)
                    } else if marker_end <= blend_until && time >= out_start {
                        let p = (time + CHIRP_CENTRE_SECS - out_start) / segment.transition_in;
                        Some(blend_gain(segment.transition_kind, p, true))
                    } else if time >= blend_from && marker_end <= out_end && next_in > 0.0 {
                        let p = (time + CHIRP_CENTRE_SECS - blend_from) / next_in;
                        Some(blend_gain(next_kind, p, false))
                    } else {
                        None
                    };
                    let level_known = !processed && segment.volume > 0.0;
                    let audible = blend.filter(|&b| !blended || b >= BLEND_REQUIRED_GAIN);
                    let presence = if whole && audible.is_some() && segment.volume > 0.0 {
                        Presence::Required
                    } else {
                        Presence::Optional
                    };
                    if segment.volume == 0.0 {
                        continue;
                    }
                    in_blend.push(blended);
                    expected.push(ExpectedMarker {
                        source: track.source,
                        index: marker.index,
                        time_secs: time,
                        gain: audible
                            .filter(|_| level_known)
                            .map(|b| marker.gain * pan * gain * segment.volume * b),
                        presence,
                        rate: if retimed { segment.timescale } else { 1.0 },
                        recording: Some((segment.clip, recording_time)),
                        payload: !processed,
                        blended,
                    });
                }
            }
        }

        // Two markers of one source sounding at once (the two sides of a
        // transition) disturb each other's detection: neither is required.
        let overlapping: Vec<bool> = expected
            .iter()
            .zip(&in_blend)
            .map(|(e, &blended)| {
                blended
                    && expected.iter().any(|o: &ExpectedMarker| {
                        !std::ptr::eq(e, o)
                            && o.source == e.source
                            && (o.time_secs - e.time_secs).abs() < MARKER_SECS + 0.005
                    })
            })
            .collect();
        for (e, overlaps) in expected.iter_mut().zip(overlapping) {
            if overlaps {
                e.presence = Presence::Optional;
                e.gain = None;
            }
        }

        for music in &timeline.audio_segments {
            let gain = if music.volume_db <= -60.0 {
                continue;
            } else {
                10f64.powf(f64::from(music.volume_db) / 20.0)
            };
            if !music.enabled || music.end <= music.start {
                continue;
            }
            let Some((_, track)) = truth.music.iter().find(|(p, _)| *p == music.path) else {
                bail!("no truth for music file {}", music.path);
            };
            let pan = if track.channels == 1 { MONO_PAN } else { 1.0 };
            let trim = music.trim_start.max(0.0);
            let seg_end = music.end.min(duration);
            for marker in &track.markers {
                let time = music.start + marker.time_secs - trim;
                if time + MARKER_SECS <= music.start || time >= seg_end {
                    continue;
                }
                let whole = time >= music.start && time + MARKER_SECS <= seg_end;
                let faded = time < music.start + music.fade_in.max(0.0)
                    || time + MARKER_SECS > music.end - music.fade_out.max(0.0);
                expected.push(ExpectedMarker {
                    source: AudioSource::Media,
                    index: marker.index,
                    time_secs: time,
                    gain: (!faded).then_some(marker.gain * pan * gain),
                    presence: if whole {
                        Presence::Required
                    } else {
                        Presence::Optional
                    },
                    rate: 1.0,
                    recording: None,
                    payload: true,
                    blended: false,
                });
            }
        }
        expected.sort_by(|a, b| a.time_secs.total_cmp(&b.time_secs));
        Ok(Self {
            expected,
            unchecked,
            rate_windows,
            duration,
        })
    }

    /// Expectations for an output that starts at timeline time `from` and
    /// covers `length` seconds; times become relative to the output start.
    pub fn window(&self, from: f64, length: f64) -> Self {
        let to = from + length;
        let expected = self
            .expected
            .iter()
            .filter(|e| e.time_secs + MARKER_SECS / e.rate > from && e.time_secs < to)
            .map(|e| {
                let whole = e.time_secs >= from && e.time_secs + MARKER_SECS / e.rate <= to;
                ExpectedMarker {
                    time_secs: e.time_secs - from,
                    presence: if whole {
                        e.presence
                    } else {
                        Presence::Optional
                    },
                    ..e.clone()
                }
            })
            .collect();
        Self {
            expected,
            unchecked: self
                .unchecked
                .iter()
                .map(|w| UncheckedWindow {
                    start: w.start - from,
                    end: w.end - from,
                    ..w.clone()
                })
                .collect(),
            rate_windows: self
                .rate_windows
                .iter()
                .map(|w| RateWindow {
                    start: w.start - from,
                    end: w.end - from,
                    rate: w.rate,
                })
                .collect(),
            duration: length,
        }
    }

    /// Appends `other` (a later output window) shifted by `at` seconds.
    pub fn append(&mut self, other: Self, at: f64) {
        self.expected
            .extend(other.expected.into_iter().map(|e| ExpectedMarker {
                time_secs: e.time_secs + at,
                ..e
            }));
        self.unchecked
            .extend(other.unchecked.into_iter().map(|w| UncheckedWindow {
                start: w.start + at,
                end: w.end + at,
                ..w
            }));
        self.rate_windows
            .extend(other.rate_windows.into_iter().map(|w| RateWindow {
                start: w.start + at,
                end: w.end + at,
                rate: w.rate,
            }));
        self.duration = self.duration.max(at + other.duration);
    }

    pub fn required(&self) -> usize {
        self.expected
            .iter()
            .filter(|e| e.presence == Presence::Required)
            .count()
    }
}

/// A located marker with its time relative to the analysed output.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct HeardMarker {
    pub source: AudioSource,
    pub index: Option<u32>,
    pub time_secs: f64,
    pub gain: f64,
    pub rate: f64,
    pub correlation: f64,
}

/// Finds every marker of every source in a mono output (at
/// [`ANALYSIS_RATE`]), including time-compressed markers inside
/// `rate_windows`. `start_secs` is the output time of sample 0.
pub fn hear(mono: &[f32], start_secs: f64, rate_windows: &[RateWindow]) -> Vec<HeardMarker> {
    let mut heard = Vec::new();
    for source in AudioSource::ALL {
        for m in audio_code::locate_markers(mono, ANALYSIS_RATE, source) {
            if m.gain.abs() < MIN_HEARD_GAIN {
                continue;
            }
            let time = m.time_secs + start_secs;
            if rate_windows
                .iter()
                .any(|w| time >= w.start - 0.001 && time < w.end)
            {
                continue;
            }
            heard.push(heard_marker(m, time, 1.0));
        }
        for window in rate_windows {
            let scaled_rate = (f64::from(ANALYSIS_RATE) / window.rate).round() as u32;
            let from = (((window.start - start_secs) * f64::from(ANALYSIS_RATE))
                .floor()
                .max(0.0)) as usize;
            let to = ((((window.end - start_secs) * f64::from(ANALYSIS_RATE)).ceil()) as usize
                + (MARKER_SECS * f64::from(ANALYSIS_RATE)) as usize)
                .min(mono.len());
            if from >= to {
                continue;
            }
            for m in audio_code::locate_markers(&mono[from..to], scaled_rate, source) {
                if m.gain.abs() < MIN_HEARD_GAIN {
                    continue;
                }
                let time = start_secs
                    + from as f64 / f64::from(ANALYSIS_RATE)
                    + m.time_secs * f64::from(scaled_rate) / f64::from(ANALYSIS_RATE);
                if time >= window.start - 0.001 && time < window.end {
                    heard.push(heard_marker(m, time, window.rate));
                }
            }
        }
    }
    heard.sort_by(|a, b| a.time_secs.total_cmp(&b.time_secs));
    heard
}

fn heard_marker(m: LocatedMarker, time_secs: f64, rate: f64) -> HeardMarker {
    HeardMarker {
        source: m.source,
        index: m.index,
        time_secs,
        gain: m.gain,
        rate,
        correlation: m.correlation,
    }
}

/// The verdict of one output against the model.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AudioReport {
    pub required: usize,
    pub matched: usize,
    pub missing: Vec<String>,
    pub doubled: Vec<String>,
    pub unexpected: Vec<String>,
    pub mistimed: Vec<String>,
    pub level: Vec<String>,
    pub damaged: Vec<String>,
    pub max_time_error_ms: f64,
    pub max_gain_error: f64,
    pub min_correlation: f64,
    /// (expected, heard) pairs, for A/V checks.
    #[serde(skip)]
    pub pairs: Vec<(ExpectedMarker, HeardMarker)>,
}

impl AudioReport {
    pub fn passed(&self) -> bool {
        self.missing.is_empty()
            && self.doubled.is_empty()
            && self.unexpected.is_empty()
            && self.mistimed.is_empty()
            && self.level.is_empty()
            && self.damaged.is_empty()
    }

    /// Failure classes for `expectations.toml` (empty when passed).
    pub fn classes(&self) -> Vec<&'static str> {
        [
            ("audio-missing", &self.missing),
            ("audio-doubled", &self.doubled),
            ("audio-unexpected", &self.unexpected),
            ("audio-timing", &self.mistimed),
            ("audio-level", &self.level),
            ("audio-undecodable", &self.damaged),
        ]
        .into_iter()
        .filter(|(_, list)| !list.is_empty())
        .map(|(class, _)| class)
        .collect()
    }

    pub fn summary(&self) -> String {
        let mut parts = vec![format!(
            "audio {}/{} required markers matched, max time error {:.3} ms, max level error {:.0}%, min correlation {:.2}",
            self.matched,
            self.required,
            self.max_time_error_ms,
            self.max_gain_error * 100.0,
            self.min_correlation
        )];
        for (label, list) in [
            ("missing", &self.missing),
            ("doubled", &self.doubled),
            ("unexpected", &self.unexpected),
            ("mistimed", &self.mistimed),
            ("wrong level", &self.level),
            ("undecodable", &self.damaged),
        ] {
            if !list.is_empty() {
                parts.push(format!(
                    "{} {label} (first: {})",
                    list.len(),
                    list.iter().take(4).cloned().collect::<Vec<_>>().join("; ")
                ));
            }
        }
        parts.join(", ")
    }
}

fn describe(e: &ExpectedMarker) -> String {
    match e.recording {
        Some((clip, t)) => format!(
            "{} #{} at {:.4}s (clip {clip} {:.4}s)",
            e.source.name(),
            e.index,
            e.time_secs,
            t
        ),
        None => format!("{} #{} at {:.4}s", e.source.name(), e.index, e.time_secs),
    }
}

/// Matches what was heard against the model.
pub fn check(model: &AudioModel, heard: &[HeardMarker]) -> AudioReport {
    let mut report = AudioReport {
        required: model.required(),
        min_correlation: 1.0,
        ..Default::default()
    };
    let mut hits = vec![0usize; model.expected.len()];
    for h in heard {
        let unchecked = model.unchecked.iter().any(|w| {
            w.source == h.source
                && h.time_secs >= w.start - MATCH_WINDOW_SECS
                && h.time_secs < w.end
        });
        if unchecked || h.time_secs < -MATCH_WINDOW_SECS || h.time_secs > model.duration + 0.5 {
            continue;
        }
        let candidate = model
            .expected
            .iter()
            .enumerate()
            .filter(|(_, e)| {
                e.source == h.source && (e.time_secs - h.time_secs).abs() <= MATCH_WINDOW_SECS
            })
            .min_by(|a, b| {
                let key = |e: &ExpectedMarker| {
                    (h.index != Some(e.index), (e.time_secs - h.time_secs).abs())
                };
                let (ka, kb) = (key(a.1), key(b.1));
                ka.0.cmp(&kb.0).then(ka.1.total_cmp(&kb.1))
            });
        let time_only = h.index.is_none() && candidate.is_some_and(|(_, e)| !e.payload);
        if h.index.is_none() && !time_only && h.correlation < CROSSTALK_CORRELATION {
            continue;
        }
        let Some((i, e)) = candidate else {
            report.unexpected.push(format!(
                "{} #{} at {:.4}s (correlation {:.2})",
                h.source.name(),
                h.index.map_or("?".into(), |i| i.to_string()),
                h.time_secs,
                h.correlation
            ));
            continue;
        };
        match h.index {
            None if e.presence == Presence::Optional => continue,
            None if !e.payload => {}
            None => {
                report
                    .damaged
                    .push(format!("{} heard at {:.4}s", describe(e), h.time_secs));
                hits[i] += 1;
                continue;
            }
            Some(index) if index != e.index => {
                report.unexpected.push(format!(
                    "{} #{index} at {:.4}s (near {})",
                    h.source.name(),
                    h.time_secs,
                    describe(e)
                ));
                continue;
            }
            Some(_) => {}
        }
        hits[i] += 1;
        report.min_correlation = report.min_correlation.min(h.correlation);
        let error = h.time_secs - e.time_secs;
        report.max_time_error_ms = report.max_time_error_ms.max(error.abs() * 1000.0);
        if error.abs() > TIME_TOLERANCE_SECS {
            report.mistimed.push(format!(
                "{} heard at {:.4}s ({:+.2} ms)",
                describe(e),
                h.time_secs,
                error * 1000.0
            ));
        }
        if let Some(gain) = e.gain {
            let rel = h.gain / gain - 1.0;
            report.max_gain_error = report.max_gain_error.max(rel.abs());
            if rel.abs() > GAIN_TOLERANCE {
                report.level.push(format!(
                    "{} level {:.3}, expected {:.3}",
                    describe(e),
                    h.gain,
                    gain
                ));
            }
        }
        report.pairs.push((e.clone(), *h));
    }
    for (e, hits) in model.expected.iter().zip(hits) {
        match (e.presence, hits) {
            (Presence::Required, 0) => report.missing.push(describe(e)),
            (Presence::Required, 1) => report.matched += 1,
            (_, 0 | 1) => {}
            (_, n) => report
                .doubled
                .push(format!("{} heard {n} times", describe(e))),
        }
    }
    report
}

/// Splits interleaved stereo into its channel average.
pub fn interleaved_mono(samples: &[f32], channels: usize) -> Vec<f32> {
    samples
        .chunks_exact(channels.max(1))
        .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
        .collect()
}

/// Peak absolute difference between two PCM buffers in dBFS (`None` when
/// identical), and the first differing sample.
pub fn pcm_difference(a: &[f32], b: &[f32]) -> Option<(f64, usize)> {
    let mut peak = 0.0f32;
    let mut first = None;
    for (i, (x, y)) in a.iter().zip(b).enumerate() {
        let d = (x - y).abs();
        if d > 0.0 && first.is_none() {
            first = Some(i);
        }
        peak = peak.max(d);
    }
    if a.len() != b.len() && first.is_none() {
        first = Some(a.len().min(b.len()));
        peak = peak.max(1.0);
    }
    first.map(|i| (20.0 * f64::from(peak.max(1e-12)).log10(), i))
}
