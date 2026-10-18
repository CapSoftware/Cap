//! Reference timeline model: what every output frame must show.
//!
//! Written for the tests from the project's documented rules, not by calling
//! the production mapping:
//! - Output frame `i` at `fps` is output time `i / fps`; an export has
//!   `ceil(fps * duration)` frames.
//! - Timeline segments play back to back; segment `k` covers
//!   `(end - start) / timescale` output seconds and maps output time `u`
//!   inside it to recording time `start + u * timescale`. A clip transition
//!   into segment `k` overlaps the two segments by its (clamped) duration:
//!   a cross-fade frame must be a blend of the outgoing segment's frame (at
//!   its last `duration` seconds) and the incoming one's; fades through black
//!   are not checked.
//! - Every track of a recording segment is aligned to the latest track start
//!   (`latest_start_time - track.start_time` is added to the request). The
//!   camera additionally takes the clip's camera offset when the user set it;
//!   an auto-calculated camera offset describes the same start alignment and
//!   must not be applied a second time.
//! - A request at track time `s` asks for frame slot `floor(s * fps_meta)`,
//!   where `fps_meta` is the track's nominal rate from recording-meta.json,
//!   and is answered by the newest source frame whose slot
//!   `round(pts * fps_meta)` is at or before it (the first frame before the
//!   track starts). Requests within float rounding of a slot boundary accept
//!   either neighbour.
//! - The camera is absent when hidden, when the segment has no camera, and
//!   inside a "hide camera" scene. A scene fades in over `transition_in`
//!   before its start and out over `transition_out` before its end; fades
//!   are not checked.

use cap_project::{ProjectConfiguration, RecordingMeta, SceneMode, StudioRecordingMeta};
use serde::{Deserialize, Serialize};

use crate::{
    fixture::{SourceTruth, TrackTruth},
    oracle::StreamExpectation,
    video_code::StreamKind,
};

const MIN_TRANSITION: f64 = 0.05;
const BOUNDARY_EPSILON: f64 = 1e-9;
const SLOT_EPSILON: f64 = 2e-3;

#[derive(Clone, Debug)]
struct ModelSegment {
    clip: usize,
    start: f64,
    end: f64,
    timescale: f64,
    transition_in: f64,
    /// The incoming transition is a cross-fade (fades through black are not
    /// checked).
    crossfade: bool,
}

impl ModelSegment {
    fn duration(&self) -> f64 {
        (self.end - self.start) / self.timescale
    }
}

#[derive(Clone, Debug)]
struct TrackTiming {
    fps: u32,
    offset: f64,
}

#[derive(Clone, Debug)]
struct ClipTiming {
    screen: TrackTiming,
    camera: Option<TrackTiming>,
    user_camera_offset: f64,
}

#[derive(Clone, Copy, Debug)]
enum SceneRule {
    HideCamera,
    Unchecked,
}

#[derive(Clone, Debug)]
struct Scene {
    start: f64,
    end: f64,
    fade_in: f64,
    fade_out: f64,
    rule: SceneRule,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameExpectation {
    pub screen: StreamExpectation,
    pub camera: StreamExpectation,
    /// (recording clip, recording time) the frame maps to, for reports.
    pub source: Option<(usize, f64)>,
}

impl FrameExpectation {
    pub fn get(&self, kind: StreamKind) -> &StreamExpectation {
        match kind {
            StreamKind::Screen => &self.screen,
            StreamKind::Camera => &self.camera,
        }
    }
}

enum Mapping {
    Single {
        segment: usize,
        source_time: f64,
    },
    Transition {
        outgoing: (usize, f64),
        incoming: (usize, f64),
        crossfade: bool,
        progress: f64,
    },
}

pub struct ReferenceModel {
    segments: Vec<ModelSegment>,
    output_starts: Vec<f64>,
    clips: Vec<ClipTiming>,
    truth: SourceTruth,
    camera_hidden: bool,
    scenes: Vec<Scene>,
    unsupported: Option<String>,
}

impl ReferenceModel {
    pub fn new(
        meta: &RecordingMeta,
        project: &ProjectConfiguration,
        truth: SourceTruth,
    ) -> anyhow::Result<Self> {
        let Some(StudioRecordingMeta::MultipleSegments { inner }) = meta.studio_meta() else {
            anyhow::bail!("the model covers multi-segment studio projects");
        };
        let clips = inner
            .segments
            .iter()
            .enumerate()
            .map(|(i, segment)| {
                let starts = [
                    segment.display.start_time,
                    segment.camera.as_ref().and_then(|c| c.start_time),
                    segment.mic.as_ref().and_then(|m| m.start_time),
                    segment.system_audio.as_ref().and_then(|s| s.start_time),
                ];
                let present = [
                    true,
                    segment.camera.is_some(),
                    segment.mic.is_some(),
                    segment.system_audio.is_some(),
                ];
                let all_known = starts
                    .iter()
                    .zip(present)
                    .all(|(start, present)| !present || start.is_some());
                let latest = all_known.then(|| {
                    starts
                        .iter()
                        .flatten()
                        .copied()
                        .fold(f64::NEG_INFINITY, f64::max)
                });
                let align = |start: Option<f64>| match (latest, start) {
                    (Some(latest), Some(start)) => latest - start,
                    _ => 0.0,
                };
                let clip = project.clips.iter().find(|c| c.index as usize == i);
                let user_camera_offset = clip
                    .filter(|c| !c.offsets_auto_calculated)
                    .map_or(0.0, |c| f64::from(c.offsets.camera));
                ClipTiming {
                    screen: TrackTiming {
                        fps: segment.display.fps,
                        offset: align(segment.display.start_time),
                    },
                    camera: segment.camera.as_ref().map(|c| TrackTiming {
                        fps: c.fps,
                        offset: align(c.start_time),
                    }),
                    user_camera_offset,
                }
            })
            .collect();
        let timeline = project
            .timeline
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("project has no timeline"))?;
        let mut segments: Vec<ModelSegment> = timeline
            .segments
            .iter()
            .map(|s| ModelSegment {
                clip: s.recording_clip as usize,
                start: s.start,
                end: s.end,
                timescale: s.timescale,
                transition_in: 0.0,
                crossfade: false,
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
                segments[k].crossfade =
                    matches!(transition.kind, cap_project::ClipTransitionType::CrossFade);
            }
        }
        let mut output_starts = Vec::with_capacity(segments.len());
        let mut at = 0.0;
        for (k, segment) in segments.iter().enumerate() {
            output_starts.push(at);
            let next_in = segments.get(k + 1).map_or(0.0, |n| n.transition_in);
            at += segment.duration() - next_in;
        }
        let scenes = timeline
            .scene_segments
            .iter()
            .filter(|s| !matches!(s.mode, SceneMode::Default))
            .map(|s| Scene {
                start: s.start,
                end: s.end,
                fade_in: s.transition_in.max(0.0),
                fade_out: s.transition_out.max(0.0),
                rule: if matches!(s.mode, SceneMode::HideCamera) {
                    SceneRule::HideCamera
                } else {
                    SceneRule::Unchecked
                },
            })
            .collect();
        let unsupported = if timeline.text_segments.iter().any(|t| t.enabled) {
            Some("text segments".to_string())
        } else if !timeline.zoom_segments.is_empty() {
            Some("zoom segments".to_string())
        } else if !timeline.camera3d_segments.is_empty() {
            Some("3D camera segments".to_string())
        } else {
            None
        };
        Ok(Self {
            segments,
            output_starts,
            clips,
            truth,
            camera_hidden: project.camera.hide,
            scenes,
            unsupported,
        })
    }

    pub fn duration(&self) -> f64 {
        let total: f64 = self.segments.iter().map(ModelSegment::duration).sum();
        total - self.segments.iter().map(|s| s.transition_in).sum::<f64>()
    }

    pub fn output_frames(&self, fps: u32) -> u32 {
        (f64::from(fps) * self.duration()).ceil() as u32
    }

    fn map(&self, t: f64) -> Option<Mapping> {
        for (k, segment) in self.segments.iter().enumerate() {
            let start = self.output_starts[k];
            let next_in = self.segments.get(k + 1).map_or(0.0, |n| n.transition_in);
            if t >= start && t < start + segment.transition_in {
                let elapsed = t - start;
                let prev = &self.segments[k - 1];
                let out_tick = prev.duration() - segment.transition_in + elapsed;
                return Some(Mapping::Transition {
                    outgoing: (k - 1, prev.start + out_tick * prev.timescale),
                    incoming: (k, segment.start + elapsed * segment.timescale),
                    crossfade: segment.crossfade,
                    progress: (elapsed / segment.transition_in).clamp(0.0, 1.0),
                });
            }
            if t >= start + segment.transition_in && t < start + segment.duration() - next_in {
                let elapsed = t - start;
                if elapsed > segment.duration() {
                    return None;
                }
                return Some(Mapping::Single {
                    segment: k,
                    source_time: segment.start + elapsed * segment.timescale,
                });
            }
        }
        None
    }

    fn near_boundary(&self, t: f64) -> bool {
        self.segments.iter().enumerate().any(|(k, segment)| {
            let start = self.output_starts[k];
            let edges = [
                start,
                start + segment.transition_in,
                start + segment.duration(),
            ];
            edges.iter().any(|e| (t - e).abs() < BOUNDARY_EPSILON)
        })
    }

    fn track(&self, clip: usize, kind: StreamKind) -> Option<(&TrackTruth, &TrackTiming)> {
        let truth = self.truth.segments.get(clip)?;
        let timing = self.clips.get(clip)?;
        match kind {
            StreamKind::Screen => Some((&truth.screen, &timing.screen)),
            StreamKind::Camera => Some((truth.camera.as_ref()?, timing.camera.as_ref()?)),
        }
    }

    /// Frames a decoder must answer for a request at recording time `time`
    /// (before the track's own alignment offset).
    pub fn answer(&self, clip: usize, kind: StreamKind, time: f64) -> StreamExpectation {
        let Some((track, timing)) = self.track(clip, kind) else {
            return StreamExpectation::Absent;
        };
        let mut request = time + timing.offset;
        if kind == StreamKind::Camera {
            request += self.clips[clip].user_camera_offset;
        }
        let x = request.max(0.0) * f64::from(timing.fps);
        let nearest = x.round();
        let slots: Vec<i64> = if (x - nearest).abs() < SLOT_EPSILON {
            vec![nearest as i64 - 1, nearest as i64]
        } else {
            vec![x.floor() as i64]
        };
        let numbers: Vec<i64> = track
            .frames
            .iter()
            .map(|f| (f.pts_secs * f64::from(timing.fps)).round() as i64)
            .collect();
        let mut allowed = Vec::new();
        for slot in slots {
            let upto = numbers.partition_point(|&n| n <= slot);
            let target = if upto == 0 {
                numbers[0]
            } else {
                numbers[upto - 1]
            };
            for (frame, &n) in track.frames.iter().zip(&numbers) {
                if n == target && !allowed.contains(&frame.index) {
                    allowed.push(frame.index);
                }
            }
        }
        allowed.sort_unstable();
        StreamExpectation::Frame {
            segment: track.segment,
            allowed,
        }
    }

    fn scene_rule(&self, t: f64) -> Option<(SceneRule, bool)> {
        self.scenes.iter().find_map(|scene| {
            // A scene fades in before its start and out before its end.
            if t < scene.start - scene.fade_in || t >= scene.end {
                return None;
            }
            let fading = t < scene.start || t >= scene.end - scene.fade_out;
            Some((scene.rule, fading))
        })
    }

    pub fn expect_at(&self, t: f64) -> FrameExpectation {
        let unchecked = |reason: &str| FrameExpectation {
            screen: StreamExpectation::Unchecked {
                reason: reason.into(),
            },
            camera: StreamExpectation::Unchecked {
                reason: reason.into(),
            },
            source: None,
        };
        if let Some(reason) = &self.unsupported {
            return unchecked(reason);
        }
        if self.near_boundary(t) {
            return unchecked("on a timeline segment boundary");
        }
        let (clip, source_time, mut screen, mut camera) = match self.map(t) {
            Some(Mapping::Single {
                segment,
                source_time,
            }) => {
                let clip = self.segments[segment].clip;
                let camera = if self.camera_hidden {
                    StreamExpectation::Absent
                } else {
                    self.answer(clip, StreamKind::Camera, source_time)
                };
                (
                    clip,
                    source_time,
                    self.answer(clip, StreamKind::Screen, source_time),
                    camera,
                )
            }
            Some(Mapping::Transition {
                outgoing,
                incoming,
                crossfade,
                progress,
            }) => {
                if !crossfade {
                    return unchecked("fade-through-black transition");
                }
                let (out_clip, in_clip) = (
                    self.segments[outgoing.0].clip,
                    self.segments[incoming.0].clip,
                );
                let blend = |kind: StreamKind| {
                    let a = self.answer(out_clip, kind, outgoing.1);
                    let b = self.answer(in_clip, kind, incoming.1);
                    match (a, b) {
                        (
                            StreamExpectation::Frame {
                                segment: sa,
                                allowed: aa,
                            },
                            StreamExpectation::Frame {
                                segment: sb,
                                allowed: ab,
                            },
                        ) => StreamExpectation::Blend {
                            outgoing: (sa, aa),
                            incoming: (sb, ab),
                            progress,
                        },
                        (StreamExpectation::Absent, StreamExpectation::Absent) => {
                            StreamExpectation::Absent
                        }
                        _ => StreamExpectation::Unchecked {
                            reason: "transition between camera and no camera".into(),
                        },
                    }
                };
                let camera = if self.camera_hidden {
                    StreamExpectation::Absent
                } else {
                    blend(StreamKind::Camera)
                };
                (in_clip, incoming.1, blend(StreamKind::Screen), camera)
            }
            None => return unchecked("past the end of the timeline"),
        };
        match self.scene_rule(t) {
            Some((_, true)) => {
                camera = StreamExpectation::Unchecked {
                    reason: "scene fade".into(),
                };
            }
            Some((SceneRule::HideCamera, false)) => camera = StreamExpectation::Absent,
            Some((SceneRule::Unchecked, false)) => {
                screen = StreamExpectation::Unchecked {
                    reason: "scene layout".into(),
                };
                camera = StreamExpectation::Unchecked {
                    reason: "scene layout".into(),
                };
            }
            None => {}
        }
        FrameExpectation {
            screen,
            camera,
            source: Some((clip, source_time)),
        }
    }

    pub fn expect(&self, output_frame: u32, fps: u32) -> FrameExpectation {
        self.expect_at(f64::from(output_frame) / f64::from(fps))
    }
}
