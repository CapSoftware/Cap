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
    /// Not checked (blends such as transitions), with the reason.
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mismatch {
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
            text.push_str(&format!(
                "; first at output frame {} ({:.3}s): expected {:?}, got {:?}",
                first.output_frame, first.time_secs, first.expected, first.observed
            ));
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
    for ((expectation, readout), &frame) in expectations.iter().zip(observed).zip(frame_numbers) {
        let time_secs = f64::from(frame) / f64::from(fps);
        let push = |report: &mut StreamReport,
                    kind: MismatchKind,
                    observed: Option<(u8, u32)>,
                    delta: Option<i64>,
                    detail: Option<String>| {
            report.mismatches.push(Mismatch {
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
