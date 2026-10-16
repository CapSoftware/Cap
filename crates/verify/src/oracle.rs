//! Compares decoded markers against the reference model's expectations.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::video_code::{Readout, StreamKind};

/// What one output frame must show for one stream.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "expect", rename_all = "lowercase")]
pub enum StreamExpectation {
    /// The stream must show one of `allowed` (the first is canonical; more
    /// than one only when the product's documented rule is ambiguous, e.g. a
    /// request within float rounding of a frame boundary).
    Frame { segment: u8, allowed: Vec<u32> },
    /// The stream must not be visible.
    Absent,
    /// A cross-fade between two source frames (a clip transition). Each side
    /// lists its allowed indices like `Frame`.
    Blend {
        outgoing: (u8, Vec<u32>),
        incoming: (u8, Vec<u32>),
        /// Transition progress (0 = all outgoing). The measured blend weight
        /// must be within `BLEND_PROGRESS_TOLERANCE` of it (the tolerance
        /// covers blending in linear light, where the code's luma weight is
        /// a gamma curve of the progress).
        progress: f64,
    },
    /// Not checked, with the reason.
    Unchecked { reason: String },
}

impl StreamExpectation {
    pub fn frame(segment: u8, index: u32) -> Self {
        StreamExpectation::Frame {
            segment,
            allowed: vec![index],
        }
    }

    pub fn canonical(&self) -> Option<(u8, u32)> {
        match self {
            StreamExpectation::Frame { segment, allowed } => {
                allowed.first().map(|&i| (*segment, i))
            }
            StreamExpectation::Blend { outgoing, .. } => {
                outgoing.1.first().map(|&i| (outgoing.0, i))
            }
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MismatchKind {
    /// An older source frame than the model's.
    Stale,
    /// A source frame from the future.
    Ahead,
    /// A frame from a different recording segment.
    WrongSegment,
    /// The stream is visible but its code is damaged.
    Unreadable,
    /// The stream should be visible and is not.
    Missing,
    /// The stream should be hidden and is visible.
    Unexpected,
    /// A transition frame blends the right two frames with the wrong weight.
    BlendWeight,
}

/// Largest allowed difference between a transition frame's measured blend
/// weight and the transition progress.
pub const BLEND_PROGRESS_TOLERANCE: f64 = 0.1;

/// Source frames searched on each side of a cross-fade for a pair that
/// explains the picture better than the expected one.
pub const BLEND_SEARCH: i64 = 12;

/// Source frames searched on one side of a cross-fade with the other side
/// held at its expected frame (a reader left far behind or ahead).
pub const BLEND_SEARCH_ONE_SIDE: i64 = 240;

/// How much better (in worst per-cell residual) another pair must fit than
/// the expected pair before the blend is read as that pair.
pub const BLEND_SIDE_MARGIN: f64 = 0.05;

/// How many times smaller the other pair's residual must be.
pub const BLEND_SIDE_RATIO: f64 = 3.0;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mismatch {
    /// Position in the checked sequence (request number for seek runs).
    pub position: usize,
    pub output_frame: u32,
    pub time_secs: f64,
    pub kind: MismatchKind,
    pub expected: Option<(u8, u32)>,
    pub observed: Option<(u8, u32)>,
    /// observed - expected, in source frames, for stale/ahead.
    pub delta: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct StreamReport {
    pub stream: Option<StreamKind>,
    pub checked: u32,
    pub unchecked: u32,
    pub stale: u32,
    pub ahead: u32,
    pub wrong_segment: u32,
    pub unreadable: u32,
    pub missing: u32,
    pub unexpected: u32,
    #[serde(default)]
    pub blend_weight: u32,
    pub max_ahead: i64,
    pub max_stale: i64,
    /// Source frames the model shows that never appeared.
    pub skipped_source_frames: Vec<u32>,
    /// Source frames shown on more output frames than the model says.
    pub repeated_source_frames: Vec<u32>,
    pub mismatches: Vec<Mismatch>,
}

impl StreamReport {
    pub fn failures(&self) -> u32 {
        self.stale
            + self.ahead
            + self.wrong_segment
            + self.unreadable
            + self.missing
            + self.unexpected
            + self.blend_weight
    }

    pub fn passed(&self) -> bool {
        self.failures() == 0
    }

    pub fn summary(&self) -> String {
        let name = self.stream.map_or("stream", StreamKind::name);
        if self.passed() {
            return format!("{name}: {} frames correct", self.checked);
        }
        let mut parts = Vec::new();
        for (label, n) in [
            ("stale", self.stale),
            ("ahead", self.ahead),
            ("wrong segment", self.wrong_segment),
            ("unreadable", self.unreadable),
            ("missing", self.missing),
            ("unexpected", self.unexpected),
            ("blended with the wrong weight", self.blend_weight),
        ] {
            if n > 0 {
                parts.push(format!("{n} {label}"));
            }
        }
        let mut text = format!(
            "{name}: {} of {} frames wrong ({})",
            self.failures(),
            self.checked,
            parts.join(", ")
        );
        if self.max_ahead > 0 {
            text.push_str(&format!(", up to {} source frames ahead", self.max_ahead));
        }
        if self.max_stale > 0 {
            text.push_str(&format!(", up to {} stale", self.max_stale));
        }
        if let Some(first) = self.mismatches.first() {
            let shown: Vec<String> = self
                .mismatches
                .iter()
                .take(4)
                .map(|m| match (&m.kind, &m.detail) {
                    (MismatchKind::BlendWeight, Some(detail)) => format!(
                        "#{} frame {} ({:.3}s) {detail}",
                        m.position, m.output_frame, m.time_secs
                    ),
                    _ => format!(
                        "#{} frame {} ({:.3}s) expected {} got {}",
                        m.position,
                        m.output_frame,
                        m.time_secs,
                        m.expected.map_or("-".into(), |(s, i)| format!("{s}:{i}")),
                        m.observed.map_or("-".into(), |(s, i)| format!("{s}:{i}")),
                    ),
                })
                .collect();
            text.push_str(&format!("; {}", shown.join("; ")));
            let _ = first;
        }
        text
    }
}

/// Checks one stream of a sequence of output frames. `observed[i]` is the
/// readout of output frame `frame_numbers[i]` (defaults to i).
pub fn check_stream(
    stream: StreamKind,
    expectations: &[StreamExpectation],
    observed: &[Readout],
    fps: u32,
) -> StreamReport {
    let frames: Vec<u32> = (0..observed.len() as u32).collect();
    check_stream_at(stream, expectations, observed, &frames, fps)
}

pub fn check_stream_at(
    stream: StreamKind,
    expectations: &[StreamExpectation],
    observed: &[Readout],
    frame_numbers: &[u32],
    fps: u32,
) -> StreamReport {
    let mut report = StreamReport {
        stream: Some(stream),
        ..Default::default()
    };
    let mut expected_counts: BTreeMap<(u8, u32), u32> = BTreeMap::new();
    let mut observed_counts: BTreeMap<(u8, u32), u32> = BTreeMap::new();
    for (position, ((expectation, readout), &frame)) in expectations
        .iter()
        .zip(observed)
        .zip(frame_numbers)
        .enumerate()
    {
        let time_secs = f64::from(frame) / f64::from(fps);
        let push = |report: &mut StreamReport,
                    kind: MismatchKind,
                    observed: Option<(u8, u32)>,
                    delta: Option<i64>,
                    detail: Option<String>| {
            report.mismatches.push(Mismatch {
                position,
                output_frame: frame,
                time_secs,
                kind,
                expected: expectation.canonical(),
                observed,
                delta,
                detail,
            });
        };
        match expectation {
            StreamExpectation::Unchecked { .. } => {
                report.unchecked += 1;
                continue;
            }
            StreamExpectation::Absent => {
                report.checked += 1;
                match readout {
                    Readout::Absent => {}
                    Readout::Marker { marker, .. } => {
                        report.unexpected += 1;
                        push(
                            &mut report,
                            MismatchKind::Unexpected,
                            Some((marker.segment, marker.index)),
                            None,
                            None,
                        );
                    }
                    Readout::Unreadable { reason } => {
                        report.unexpected += 1;
                        push(
                            &mut report,
                            MismatchKind::Unexpected,
                            None,
                            None,
                            Some(reason.clone()),
                        );
                    }
                    Readout::Blend { incoming, .. } => {
                        report.unexpected += 1;
                        push(
                            &mut report,
                            MismatchKind::Unexpected,
                            Some((incoming.segment, incoming.index)),
                            None,
                            Some("blend".into()),
                        );
                    }
                }
            }
            StreamExpectation::Blend {
                outgoing,
                incoming,
                progress: expected_progress,
            } => {
                report.checked += 1;
                if let Readout::Blend {
                    progress: observed, ..
                } = readout
                    && (observed - expected_progress).abs() > BLEND_PROGRESS_TOLERANCE
                {
                    report.blend_weight += 1;
                    report.mismatches.push(Mismatch {
                        position,
                        output_frame: frame,
                        time_secs,
                        kind: MismatchKind::BlendWeight,
                        expected: None,
                        observed: None,
                        delta: None,
                        detail: Some(format!(
                            "transition blend weight {observed:.2}, expected progress {expected_progress:.2}"
                        )),
                    });
                }
                let sides: Vec<(u8, u32)> = match readout {
                    Readout::Blend {
                        outgoing: o,
                        incoming: i,
                        ..
                    } => vec![(o.segment, o.index), (i.segment, i.index)],
                    Readout::Marker { marker, .. } => vec![(marker.segment, marker.index)],
                    Readout::Absent => {
                        report.missing += 1;
                        push(&mut report, MismatchKind::Missing, None, None, None);
                        continue;
                    }
                    Readout::Unreadable { reason } => {
                        report.unreadable += 1;
                        push(
                            &mut report,
                            MismatchKind::Unreadable,
                            None,
                            None,
                            Some(reason.clone()),
                        );
                        continue;
                    }
                };
                let fits = |got: (u8, u32), side: &(u8, Vec<u32>)| {
                    got.0 == side.0 && side.1.contains(&got.1)
                };
                let ok = match sides.as_slice() {
                    [o, i] => fits(*o, outgoing) && fits(*i, incoming),
                    [one] => fits(*one, outgoing) || fits(*one, incoming),
                    _ => false,
                };
                if !ok {
                    let (got, side) = match sides.as_slice() {
                        [o, _] if !fits(*o, outgoing) => (*o, outgoing),
                        [_, i] => (*i, incoming),
                        [one] => (*one, incoming),
                        _ => continue,
                    };
                    let reference = i64::from(*side.1.first().unwrap_or(&0));
                    let delta = i64::from(got.1) - reference;
                    let kind = if got.0 != side.0 {
                        report.wrong_segment += 1;
                        MismatchKind::WrongSegment
                    } else if delta < 0 {
                        report.stale += 1;
                        report.max_stale = report.max_stale.max(-delta);
                        MismatchKind::Stale
                    } else {
                        report.ahead += 1;
                        report.max_ahead = report.max_ahead.max(delta);
                        MismatchKind::Ahead
                    };
                    report.mismatches.push(Mismatch {
                        position,
                        output_frame: frame,
                        time_secs,
                        kind,
                        expected: Some((side.0, reference as u32)),
                        observed: Some(got),
                        delta: Some(delta),
                        detail: Some(
                            if std::ptr::eq(side, incoming) {
                                "transition, incoming side"
                            } else {
                                "transition, outgoing side"
                            }
                            .into(),
                        ),
                    });
                }
            }
            StreamExpectation::Frame { segment, allowed } => {
                report.checked += 1;
                let canonical = (*segment, allowed[0]);
                *expected_counts.entry(canonical).or_default() += 1;
                match readout {
                    Readout::Absent => {
                        report.missing += 1;
                        push(&mut report, MismatchKind::Missing, None, None, None);
                    }
                    Readout::Blend { .. } => {
                        report.unreadable += 1;
                        push(
                            &mut report,
                            MismatchKind::Unreadable,
                            None,
                            None,
                            Some("blend where a single frame was expected".into()),
                        );
                    }
                    Readout::Unreadable { reason } => {
                        report.unreadable += 1;
                        push(
                            &mut report,
                            MismatchKind::Unreadable,
                            None,
                            None,
                            Some(reason.clone()),
                        );
                    }
                    Readout::Marker { marker, .. } => {
                        let got = (marker.segment, marker.index);
                        if marker.segment != *segment {
                            *observed_counts.entry(got).or_default() += 1;
                            report.wrong_segment += 1;
                            push(
                                &mut report,
                                MismatchKind::WrongSegment,
                                Some(got),
                                None,
                                None,
                            );
                        } else if allowed.contains(&marker.index) {
                            *observed_counts.entry(canonical).or_default() += 1;
                        } else {
                            *observed_counts.entry(got).or_default() += 1;
                            let lo = *allowed.iter().min().unwrap_or(&0);
                            let hi = *allowed.iter().max().unwrap_or(&0);
                            if marker.index < lo {
                                let delta = i64::from(marker.index) - i64::from(lo);
                                report.stale += 1;
                                report.max_stale = report.max_stale.max(-delta);
                                push(
                                    &mut report,
                                    MismatchKind::Stale,
                                    Some(got),
                                    Some(delta),
                                    None,
                                );
                            } else {
                                let delta = i64::from(marker.index) - i64::from(hi);
                                report.ahead += 1;
                                report.max_ahead = report.max_ahead.max(delta);
                                push(
                                    &mut report,
                                    MismatchKind::Ahead,
                                    Some(got),
                                    Some(delta),
                                    None,
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    report.skipped_source_frames = expected_counts
        .iter()
        .filter(|(key, _)| !observed_counts.contains_key(key))
        .map(|((_, index), _)| *index)
        .collect();
    report.repeated_source_frames = observed_counts
        .iter()
        .filter(|(key, n)| **n > expected_counts.get(key).copied().unwrap_or(0))
        .map(|((_, index), _)| *index)
        .collect();
    report
}

/// Reads one stream of a picture knowing what the model expects there: a
/// plain decode, or for a cross-fade the best-fitting blend of the expected
/// outgoing and incoming codes (searching nearby frames when none fits, so
/// a wrong answer is reported as such rather than as unreadable).
pub fn read_expecting(
    img: &impl crate::video_code::PixelSource,
    kind: StreamKind,
    expectation: &StreamExpectation,
) -> Readout {
    use crate::video_code::{self, BLEND_TOLERANCE, FrameMarker};
    let StreamExpectation::Blend {
        outgoing,
        incoming,
        progress: expected_progress,
    } = expectation
    else {
        return video_code::read_stream(img, kind);
    };
    let cells = match video_code::read_cells(img, kind) {
        Ok(cells) => cells,
        Err(readout) => return readout,
    };
    let best_of = |pairs: &mut dyn Iterator<Item = (FrameMarker, FrameMarker)>| {
        pairs
            .map(|(o, i)| {
                let (p, residual) = video_code::blend_fit(&cells, o, i);
                (o, i, p, residual)
            })
            .min_by(|a, b| a.3.total_cmp(&b.3))
    };
    let marker = |seg: u8, index: i64| {
        (0..=i64::from(video_code::MAX_INDEX))
            .contains(&index)
            .then(|| FrameMarker::new(kind, seg, index as u32))
    };
    let expected = best_of(&mut outgoing.1.iter().flat_map(|&o| {
        incoming.1.iter().filter_map(move |&i| {
            Some((
                marker(outgoing.0, i64::from(o))?,
                marker(incoming.0, i64::from(i))?,
            ))
        })
    }));
    if let Some((o, i, p, residual)) = expected
        && residual <= BLEND_TOLERANCE
    {
        // Both sides are verified: a wrong frame on the weaker side leaves
        // residuals of only about its weight, which the tolerance alone would
        // accept. Any other pair of nearby frames that explains the picture
        // clearly better than the expected pair is what the stream shows.
        let allowed = |side: &(u8, Vec<u32>), m: FrameMarker| {
            m.segment == side.0 && side.1.contains(&m.index)
        };
        let (o0, i0) = (i64::from(o.index), i64::from(i.index));
        let near = (-BLEND_SEARCH..=BLEND_SEARCH).flat_map(|d_o| {
            (-BLEND_SEARCH..=BLEND_SEARCH).filter_map(move |d_i| {
                Some((marker(o.segment, o0 + d_o)?, marker(i.segment, i0 + d_i)?))
            })
        });
        // One side wrong by far (a stale reader position) with the other
        // side right.
        let far = (-BLEND_SEARCH_ONE_SIDE..=BLEND_SEARCH_ONE_SIDE).flat_map(|d| {
            [
                marker(o.segment, o0 + d).map(|ao| (ao, i)),
                marker(i.segment, i0 + d).map(|ai| (o, ai)),
            ]
            .into_iter()
            .flatten()
        });
        // The same two frames with the sides swapped (weight 1 - p) are the
        // same picture, not an alternative: a cross-fade inside one clip has
        // both sides in the same segment.
        let swapped = |ao: FrameMarker, ai: FrameMarker| ao == i && ai == o;
        let alternative = best_of(&mut near.chain(far).filter(|(ao, ai)| {
            !(swapped(*ao, *ai) || allowed(outgoing, *ao) && allowed(incoming, *ai))
        }));
        if std::env::var("CAP_VERIFY_TRACE_BLEND").as_deref() == Ok("2") {
            eprintln!(
                "[cap-verify-blend-sides] {}",
                serde_json::json!({
                    "stream": kind,
                    "expected": [o.index, i.index],
                    "p": p,
                    "progress": expected_progress,
                    "residual": residual,
                    "alternative": alternative.map(|(ao, ai, ap, ares)| (ao.index, ai.index, ap, ares)),
                })
            );
        }
        // Clearly better, absolutely and relative to the expected pair's
        // residual: on a noisy stream (the Linux camera code, residuals 0.13
        // to 0.17 on correct blends) a neighbouring pair can fit a little
        // better by chance; a wrong side leaves the expected pair with a
        // residual several times the alternative's.
        if let Some((ao, ai, ap, ares)) = alternative
            && ares + BLEND_SIDE_MARGIN < residual
            && ares * BLEND_SIDE_RATIO < residual
        {
            return Readout::Blend {
                outgoing: ao,
                incoming: ai,
                progress: ap,
                residual: ares,
            };
        }
        return Readout::Blend {
            outgoing: o,
            incoming: i,
            progress: p,
            residual,
        };
    }
    let single = video_code::read_stream(img, kind);
    if single.marker().is_some() {
        return single;
    }
    let (o0, i0) = (
        i64::from(*outgoing.1.first().unwrap_or(&0)),
        i64::from(*incoming.1.first().unwrap_or(&0)),
    );
    let nearby = best_of(&mut (-12i64..=12).flat_map(|d_o| {
        (-12i64..=12).filter_map(move |d_i| {
            Some((marker(outgoing.0, o0 + d_o)?, marker(incoming.0, i0 + d_i)?))
        })
    }));
    match nearby {
        Some((o, i, p, residual)) if residual <= BLEND_TOLERANCE => Readout::Blend {
            outgoing: o,
            incoming: i,
            progress: p,
            residual,
        },
        _ => Readout::Unreadable {
            reason: format!(
                "transition blend matches no expected pair (best residual {:.2})",
                expected.map_or(f64::NAN, |e| e.3)
            ),
        },
    }
}
