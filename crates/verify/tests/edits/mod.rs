//! Random timeline edits shared by `editing.rs` and `captions.rs`.
//!
//! - [`Op`]: one user edit (split, delete, trim, speed, reorder, clip
//!   volume, clip transition, fullscreen text hold). Parameters are
//!   fractions, so any sub-sequence of a recorded sequence replays to a valid
//!   project; an op that no longer applies is skipped. That makes failures
//!   shrinkable: [`shrink`] drops ops while the failure persists.
//! - [`TimeModel`]: an independent model of the output -> recording mapping,
//!   written from the documented rules rather than by calling
//!   `cap_project`:
//!   - segments play back to back; segment `k` lasts
//!     `(end - start) / timescale` and maps `u` seconds into it to recording
//!     time `start + u * timescale`;
//!   - a clip transition into `k` overlaps `k - 1` and `k` by its duration,
//!     clamped to `[0.05, min(dur(k - 1), dur(k)) / 2]` and dropped when that
//!     range is empty; inside it both sides play, `k - 1` from
//!     `dur(k - 1) - transition` on;
//!   - enabled fullscreen text segments are holds: the recording clock
//!     pauses for their output-time window (overlapping or touching windows
//!     merge), showing the frame at the hold start; the timeline grows by the
//!     held time. A hold starting at the clips' end (a closing title) shows
//!     the last clip's final frame; a hold starting past it is never reached
//!     and is left out, so the timeline does not grow by it.

#![allow(dead_code)]

use cap_project::{
    ClipConfiguration, ClipTransition, ClipTransitionType, MultipleSegment, MultipleSegments,
    Platform, ProjectConfiguration, RecordingMeta, RecordingMetaInner, StudioRecordingMeta,
    StudioRecordingStatus, TextSegment, TimelineConfiguration, TimelineFrameMapping,
    TimelineSegment, VideoMeta,
};
use cap_verify::fixture::{Rng, SegmentTruth, SourceFrame, SourceTruth, TrackTruth};
use cap_verify::video_code::StreamKind;
use relative_path::RelativePathBuf;

/// No edit leaves a timeline segment shorter than this (recording seconds).
pub const MIN_SOURCE: f64 = 0.4;
pub const MIN_TRANSITION: f64 = 0.05;
const SPEEDS: [f64; 6] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Split { segment: usize, at: f64 },
    Delete { segment: usize },
    TrimStart { segment: usize, by: f64 },
    TrimEnd { segment: usize, by: f64 },
    Speed { segment: usize, timescale: f64 },
    Move { from: usize, to: usize },
    Volume { segment: usize, volume: f64 },
    Transition { segment: usize, duration: f64 },
    Hold { at: f64, length: f64 },
}

#[derive(Clone, Copy, Debug)]
pub struct OpMix {
    pub transitions: bool,
    pub holds: bool,
}

pub fn timeline(config: &ProjectConfiguration) -> &TimelineConfiguration {
    config.timeline.as_ref().expect("timeline")
}

fn timeline_mut(config: &mut ProjectConfiguration) -> &mut TimelineConfiguration {
    config.timeline.as_mut().expect("timeline")
}

fn source_len(segment: &TimelineSegment) -> f64 {
    segment.end - segment.start
}

/// Keeps transitions sorted, one per boundary, on boundaries that exist.
fn tidy_transitions(timeline: &mut TimelineConfiguration) {
    let count = timeline.segments.len();
    timeline
        .transitions
        .retain(|t| t.segment_index >= 1 && (t.segment_index as usize) < count);
    timeline.transitions.sort_by_key(|t| t.segment_index);
    timeline
        .transitions
        .dedup_by(|later, earlier| later.segment_index == earlier.segment_index);
}

/// Applies `op`; false when it does not apply to this project (it is then
/// skipped, which keeps every sub-sequence replayable).
pub fn apply(config: &mut ProjectConfiguration, op: &Op) -> bool {
    let total = timeline(config).duration();
    let timeline = timeline_mut(config);
    let count = timeline.segments.len();
    let valid = |index: usize| index < count;
    match *op {
        Op::Split { segment, at } => {
            if !valid(segment) || source_len(&timeline.segments[segment]) < 2.0 * MIN_SOURCE {
                return false;
            }
            let s = &timeline.segments[segment];
            let cut = s.start + MIN_SOURCE + at * (source_len(s) - 2.0 * MIN_SOURCE);
            let mut tail = s.clone();
            tail.start = cut;
            timeline.segments[segment].end = cut;
            timeline.segments.insert(segment + 1, tail);
            for t in &mut timeline.transitions {
                if t.segment_index as usize > segment {
                    t.segment_index += 1;
                }
            }
        }
        Op::Delete { segment } => {
            if !valid(segment) || count < 2 {
                return false;
            }
            timeline.segments.remove(segment);
            let k = segment as u32;
            timeline
                .transitions
                .retain(|t| t.segment_index != k && t.segment_index != k + 1);
            for t in &mut timeline.transitions {
                if t.segment_index > k + 1 {
                    t.segment_index -= 1;
                }
            }
        }
        Op::TrimStart { segment, by } | Op::TrimEnd { segment, by } => {
            if !valid(segment) {
                return false;
            }
            let s = &mut timeline.segments[segment];
            let room = source_len(s) - MIN_SOURCE;
            if room <= 0.0 {
                return false;
            }
            if matches!(op, Op::TrimStart { .. }) {
                s.start += by * room;
            } else {
                s.end -= by * room;
            }
        }
        Op::Speed { segment, timescale } => {
            if !valid(segment) {
                return false;
            }
            timeline.segments[segment].timescale = timescale;
        }
        Op::Move { from, to } => {
            if !valid(from) || !valid(to) || from == to {
                return false;
            }
            let moved = timeline.segments.remove(from);
            timeline.segments.insert(to, moved);
            timeline.transitions.clear();
        }
        Op::Volume { segment, volume } => {
            if !valid(segment) {
                return false;
            }
            timeline.segments[segment].volume = Some(volume);
        }
        Op::Transition { segment, duration } => {
            if segment == 0 || !valid(segment) {
                return false;
            }
            timeline
                .transitions
                .retain(|t| t.segment_index as usize != segment);
            timeline.transitions.push(ClipTransition {
                segment_index: segment as u32,
                kind: ClipTransitionType::CrossFade,
                duration,
            });
        }
        Op::Hold { at, length } => {
            let start = at * total;
            timeline
                .text_segments
                .push(fullscreen_text(start, start + length));
        }
    }
    tidy_transitions(timeline);
    true
}

pub fn fullscreen_text(start: f64, end: f64) -> TextSegment {
    serde_json::from_value(serde_json::json!({
        "start": start,
        "end": end,
        "content": "hold",
        "layout": "fullscreen",
    }))
    .expect("text segment")
}

pub fn random_op(rng: &mut Rng, config: &ProjectConfiguration, mix: OpMix) -> Op {
    let count = timeline(config).segments.len() as u64;
    let segment = |rng: &mut Rng| rng.range(0, count - 1) as usize;
    loop {
        let op = match rng.range(0, 9) {
            0 | 1 => Op::Split {
                segment: segment(rng),
                at: rng.f64(),
            },
            2 => Op::Delete {
                segment: segment(rng),
            },
            3 => Op::TrimStart {
                segment: segment(rng),
                by: rng.f64() * 0.6,
            },
            4 => Op::TrimEnd {
                segment: segment(rng),
                by: rng.f64() * 0.6,
            },
            5 => Op::Speed {
                segment: segment(rng),
                timescale: SPEEDS[rng.range(0, SPEEDS.len() as u64 - 1) as usize],
            },
            6 => Op::Move {
                from: segment(rng),
                to: segment(rng),
            },
            7 => Op::Volume {
                segment: segment(rng),
                volume: [0.0, 0.5, 1.5][rng.range(0, 2) as usize],
            },
            8 if mix.transitions => Op::Transition {
                segment: segment(rng),
                duration: [0.02, 0.2, 0.4, 0.8, 3.0][rng.range(0, 4) as usize],
            },
            9 if mix.holds => Op::Hold {
                at: rng.f64(),
                length: 0.2 + rng.f64() * 1.5,
            },
            _ => continue,
        };
        return op;
    }
}

/// `count` random ops that all apply, starting from `base`.
pub fn random_sequence(
    rng: &mut Rng,
    base: &ProjectConfiguration,
    count: usize,
    mix: OpMix,
) -> Vec<Op> {
    let mut config = base.clone();
    let mut ops = Vec::new();
    let mut attempts = 0;
    while ops.len() < count && attempts < count * 20 {
        attempts += 1;
        let op = random_op(rng, &config, mix);
        if apply(&mut config, &op) {
            ops.push(op);
        }
    }
    ops
}

pub fn replay(base: &ProjectConfiguration, ops: &[Op]) -> ProjectConfiguration {
    let mut config = base.clone();
    for op in ops {
        apply(&mut config, op);
    }
    config
}

/// Greedy shrink: drops ops one at a time while `fails` still fails.
pub fn shrink(ops: &[Op], fails: impl Fn(&[Op]) -> bool) -> Vec<Op> {
    let mut current = ops.to_vec();
    loop {
        let mut reduced = false;
        let mut i = 0;
        while i < current.len() {
            let mut candidate = current.clone();
            candidate.remove(i);
            if fails(&candidate) {
                current = candidate;
                reduced = true;
            } else {
                i += 1;
            }
        }
        if !reduced {
            return current;
        }
    }
}

/// A project whose recording clips last `durations` seconds, each on the
/// timeline once, in order.
pub fn base_config(durations: &[f64]) -> ProjectConfiguration {
    let mut config = cap_verify::fixture::verification_project_config();
    config.timeline = Some(TimelineConfiguration {
        segments: durations
            .iter()
            .enumerate()
            .map(|(i, &d)| TimelineSegment {
                recording_clip: i as u32,
                timescale: 1.0,
                start: 0.0,
                end: d,
                name: None,
                speed_audio_mode: None,
                volume: None,
                hide_cursor: None,
            })
            .collect(),
        transitions: Vec::new(),
        zoom_segments: Vec::new(),
        scene_segments: Vec::new(),
        style_segments: Vec::new(),
        image_segments: Vec::new(),
        mask_segments: Vec::new(),
        text_segments: Vec::new(),
        caption_segments: Vec::new(),
        keyboard_segments: Vec::new(),
        audio_segments: Vec::new(),
        camera3d_segments: Vec::new(),
    });
    config.clips = (0..durations.len())
        .map(|i| ClipConfiguration {
            index: i as u32,
            offsets: Default::default(),
            offsets_auto_calculated: true,
        })
        .collect();
    config
}

/// 1 to 3 recording clips of 2 to 8 s (whole 30 fps frames).
pub fn random_durations(rng: &mut Rng) -> Vec<f64> {
    (0..rng.range(1, 3))
        .map(|_| rng.range(60, 240) as f64 / 30.0)
        .collect()
}

/// In-memory recording meta + source truth for `durations` (30 fps screen,
/// no other tracks), so the core reference model can be built without media.
pub fn synthetic_meta(durations: &[f64]) -> (RecordingMeta, SourceTruth) {
    let segments = durations
        .iter()
        .enumerate()
        .map(|(i, _)| MultipleSegment {
            display: VideoMeta {
                path: RelativePathBuf::from(format!("content/segments/segment-{i}/display.mp4")),
                fps: 30,
                start_time: Some(0.0),
                device_id: None,
            },
            camera: None,
            mic: None,
            system_audio: None,
            cursor: None,
            keyboard: None,
            display_notch: None,
        })
        .collect();
    let meta = RecordingMeta {
        platform: Some(Platform::default()),
        project_path: std::env::temp_dir(),
        pretty_name: "synthetic".into(),
        sharing: None,
        inner: RecordingMetaInner::Studio(Box::new(StudioRecordingMeta::MultipleSegments {
            inner: MultipleSegments {
                segments,
                cursors: Default::default(),
                status: Some(StudioRecordingStatus::Complete),
            },
        })),
        upload: None,
    };
    let truth = SourceTruth {
        segments: durations
            .iter()
            .enumerate()
            .map(|(i, &d)| SegmentTruth {
                screen: TrackTruth {
                    kind: StreamKind::Screen,
                    segment: i as u8,
                    frames: (0..(d * 30.0).round() as u32)
                        .map(|k| SourceFrame {
                            pts_secs: f64::from(k) / 30.0,
                            index: k,
                        })
                        .collect(),
                },
                camera: None,
            })
            .collect(),
    };
    (meta, truth)
}

#[derive(Clone, Debug)]
pub struct Placed {
    pub clip: u32,
    pub start: f64,
    pub end: f64,
    pub timescale: f64,
    pub duration: f64,
    pub out_start: f64,
    pub transition_in: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Source {
    pub segment: usize,
    pub time: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mapping {
    Single {
        source: Source,
        output_end: f64,
    },
    Transition {
        outgoing: Source,
        incoming: Source,
        progress: f64,
        output_end: f64,
    },
    Hold {
        source: Source,
        output_end: f64,
    },
}

impl Mapping {
    /// The source a single-frame consumer shows: the incoming side of a
    /// transition.
    pub fn shown(&self) -> Source {
        match *self {
            Mapping::Single { source, .. } | Mapping::Hold { source, .. } => source,
            Mapping::Transition { incoming, .. } => incoming,
        }
    }
}

pub struct TimeModel {
    pub segments: Vec<Placed>,
    /// Merged hold windows in output time.
    pub holds: Vec<(f64, f64)>,
}

impl TimeModel {
    pub fn new(config: &ProjectConfiguration) -> Self {
        let timeline = timeline(config);
        let mut segments: Vec<Placed> = timeline
            .segments
            .iter()
            .map(|s| Placed {
                clip: s.recording_clip,
                start: s.start,
                end: s.end,
                timescale: s.timescale,
                duration: (s.end - s.start) / s.timescale,
                out_start: 0.0,
                transition_in: 0.0,
            })
            .collect();
        for k in 1..segments.len() {
            // The last transition listed for a boundary wins.
            let Some(t) = timeline
                .transitions
                .iter()
                .rev()
                .find(|t| t.segment_index as usize == k)
            else {
                continue;
            };
            let max = segments[k - 1].duration.min(segments[k].duration) / 2.0;
            if t.duration.is_finite() && t.duration > 0.0 && max >= MIN_TRANSITION {
                segments[k].transition_in = t.duration.max(MIN_TRANSITION).min(max);
            }
        }
        let mut at = 0.0;
        for s in &mut segments {
            at -= s.transition_in;
            s.out_start = at;
            at += s.duration;
        }
        let mut windows: Vec<(f64, f64)> = timeline
            .text_segments
            .iter()
            .filter(|t| {
                t.enabled && t.layout == cap_project::TextLayout::Fullscreen && t.end > t.start
            })
            .map(|t| (t.start, t.end))
            .collect();
        windows.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut holds: Vec<(f64, f64)> = Vec::new();
        for w in windows {
            match holds.last_mut() {
                Some(last) if w.0 <= last.1 => last.1 = last.1.max(w.1),
                _ => holds.push(w),
            }
        }
        let mut model = Self {
            segments,
            holds: Vec::new(),
        };
        let clips_end = model.base_duration();
        let mut held = 0.0;
        for (a, b) in holds {
            if a - held > clips_end + 1e-9 {
                break;
            }
            held += b - a;
            model.holds.push((a, b));
        }
        model
    }

    /// Output duration without holds.
    pub fn base_duration(&self) -> f64 {
        self.segments
            .iter()
            .map(|s| s.duration - s.transition_in)
            .sum()
    }

    pub fn duration(&self) -> f64 {
        self.base_duration() + self.holds.iter().map(|h| h.1 - h.0).sum::<f64>()
    }

    fn transition_out(&self, k: usize) -> f64 {
        self.segments.get(k + 1).map_or(0.0, |n| n.transition_in)
    }

    /// Hold-free mapping at gapless time `e`.
    pub fn base_map(&self, e: f64) -> Option<Mapping> {
        for (k, s) in self.segments.iter().enumerate() {
            let u = e - s.out_start;
            if s.transition_in > 0.0 && u >= 0.0 && u < s.transition_in {
                let prev = &self.segments[k - 1];
                return Some(Mapping::Transition {
                    outgoing: Source {
                        segment: k - 1,
                        time: prev.start + (prev.duration - s.transition_in + u) * prev.timescale,
                    },
                    incoming: Source {
                        segment: k,
                        time: s.start + u * s.timescale,
                    },
                    progress: u / s.transition_in,
                    output_end: s.out_start + s.transition_in,
                });
            }
            let single_end = s.out_start + s.duration - self.transition_out(k);
            if u >= s.transition_in && e < single_end {
                return Some(Mapping::Single {
                    source: Source {
                        segment: k,
                        time: s.start + u * s.timescale,
                    },
                    output_end: single_end,
                });
            }
        }
        None
    }

    /// Held output time before output time `o`.
    pub fn held_before(&self, o: f64) -> f64 {
        self.holds
            .iter()
            .map(|&(a, b)| (o.min(b) - a).max(0.0))
            .sum()
    }

    /// Gapless -> output time, landing after every hold that starts at or
    /// before the gapless point.
    pub fn to_output(&self, e: f64) -> f64 {
        let mut held = 0.0;
        for &(a, b) in &self.holds {
            if e >= a - held {
                held += b - a;
            }
        }
        e + held
    }

    /// Gapless -> output time for the end of a range: a range ending exactly
    /// where a hold starts ends before the hold.
    pub fn to_output_end(&self, e: f64) -> f64 {
        let mut held = 0.0;
        for &(a, b) in &self.holds {
            if e > a - held {
                held += b - a;
            }
        }
        e + held
    }

    /// Output -> recording position on the concatenated source (clip `c`
    /// starts at the sum of the earlier clips' durations), preferring the
    /// last timeline segment that contains the gapless time, ends included.
    pub fn output_to_source(&self, o: f64, clip_starts: &[f64]) -> Option<f64> {
        let e = o - self.held_before(o);
        self.segments.iter().rev().find_map(|s| {
            let edited_end = s.out_start + s.duration;
            (e >= s.out_start && e <= edited_end)
                .then(|| clip_starts[s.clip as usize] + s.start + (e - s.out_start) * s.timescale)
        })
    }

    pub fn map(&self, o: f64) -> Option<Mapping> {
        if let Some(&(a, b)) = self.holds.iter().find(|&&(a, b)| o >= a && o < b) {
            let e = a - self.held_before(a);
            let source = match self.base_map(e) {
                Some(mapping) => mapping.shown(),
                None if (e - self.base_duration()).abs() <= 1e-9 => {
                    let (segment, s) = self
                        .segments
                        .iter()
                        .enumerate()
                        .rfind(|(_, s)| s.duration > 0.0)?;
                    Source {
                        segment,
                        time: s.end,
                    }
                }
                None => return None,
            };
            return Some(Mapping::Hold {
                source,
                output_end: b,
            });
        }
        let next_hold = self.holds.iter().map(|h| h.0).find(|&a| a > o);
        let end = |e: f64| {
            let out = self.to_output(e);
            next_hold.map_or(out, |a| out.min(a))
        };
        Some(match self.base_map(o - self.held_before(o))? {
            Mapping::Single { source, output_end } => Mapping::Single {
                source,
                output_end: end(output_end),
            },
            Mapping::Transition {
                outgoing,
                incoming,
                progress,
                output_end,
            } => Mapping::Transition {
                outgoing,
                incoming,
                progress,
                output_end: end(output_end),
            },
            hold @ Mapping::Hold { .. } => hold,
        })
    }

    /// Whether output time `o` is within `eps` of an edge where the mapping
    /// changes (either side is then acceptable).
    pub fn near_edge(&self, o: f64, eps: f64) -> bool {
        if self
            .holds
            .iter()
            .any(|&(a, b)| (o - a).abs() < eps || (o - b).abs() < eps)
        {
            return true;
        }
        let e = o - self.held_before(o);
        self.segments.iter().enumerate().any(|(k, s)| {
            [
                s.out_start,
                s.out_start + s.transition_in,
                s.out_start + s.duration - self.transition_out(k),
                s.out_start + s.duration,
            ]
            .iter()
            .any(|edge| (e - edge).abs() < eps)
        })
    }
}

fn product_source(source: &cap_project::TimelineSource<'_>) -> Source {
    Source {
        segment: source.segment_index,
        time: source.source_time,
    }
}

/// The engine's mapping in model terms.
pub fn product_map(timeline: &TimelineConfiguration, o: f64) -> Option<Mapping> {
    Some(match timeline.get_frame_mapping(o)? {
        TimelineFrameMapping::Single { source, output_end } => Mapping::Single {
            source: product_source(&source),
            output_end,
        },
        TimelineFrameMapping::Transition {
            outgoing,
            incoming,
            progress,
            output_end,
            ..
        } => Mapping::Transition {
            outgoing: product_source(&outgoing),
            incoming: product_source(&incoming),
            progress,
            output_end,
        },
        TimelineFrameMapping::Hold { source, output_end } => Mapping::Hold {
            source: product_source(&source),
            output_end,
        },
    })
}

fn close(a: f64, b: f64, tolerance: f64) -> bool {
    (a - b).abs() <= tolerance
}

fn same_source(a: Source, b: Source, tolerance: f64) -> bool {
    a.segment == b.segment && close(a.time, b.time, tolerance)
}

pub fn same_mapping(a: &Mapping, b: &Mapping, tolerance: f64) -> bool {
    match (a, b) {
        (
            Mapping::Single {
                source: s1,
                output_end: e1,
            },
            Mapping::Single {
                source: s2,
                output_end: e2,
            },
        )
        | (
            Mapping::Hold {
                source: s1,
                output_end: e1,
            },
            Mapping::Hold {
                source: s2,
                output_end: e2,
            },
        ) => same_source(*s1, *s2, tolerance) && close(*e1, *e2, tolerance),
        (
            Mapping::Transition {
                outgoing: o1,
                incoming: i1,
                progress: p1,
                output_end: e1,
            },
            Mapping::Transition {
                outgoing: o2,
                incoming: i2,
                progress: p2,
                output_end: e2,
            },
        ) => {
            same_source(*o1, *o2, tolerance)
                && same_source(*i1, *i2, tolerance)
                && close(*p1, *p2, tolerance)
                && close(*e1, *e2, tolerance)
        }
        _ => false,
    }
}
