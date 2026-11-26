use std::ops::Range;

use cap_project::TimelineConfiguration;

use super::energy::{EnergyEnvelope, HOP_SECONDS};
use super::model::{
    TranscriptDoc, TranscriptEdl, build_mappings, hole_around, kept_ranges, merge_ranges,
    recording_offsets,
};
use crate::editor_edits::{self, RangeCut};

/// Speech decays after the recognizer's word end, so a cut keeps at least this
/// much of the silence after a kept word when the gap allows it...
pub const TAIL_GUARD: f64 = 0.04;
/// ...and this much before a kept word's onset.
pub const ONSET_GUARD: f64 = 0.02;
/// Where a word has no neighbour (the first or last word), the cut reaches
/// this far into the silence beyond it. A first word this close to the start
/// takes the lead-in with it, so cutting an opening "um" starts the video on
/// the next word instead of leaving a sliver of silence.
pub const EDGE_REACH: f64 = 0.6;
const TOUCHING_SEARCH: f64 = 0.04;
const EDGE_PENALTY_DB: f32 = 6.0;
const MAX_SEARCH_STEPS: usize = 4_000;
const MIN_PAUSE_CUT: f64 = 0.05;
pub const LONG_GAP: f64 = 0.8;

pub fn quietest_point(energy: Option<&EnergyEnvelope>, lo: f64, hi: f64) -> f64 {
    quietest_mapped(energy, lo, hi, Some)
}

fn quietest_mapped(
    energy: Option<&EnergyEnvelope>,
    lo: f64,
    hi: f64,
    to_source: impl Fn(f64) -> Option<f64>,
) -> f64 {
    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
    let centre = (lo + hi) / 2.0;
    let Some(energy) = energy else {
        return centre;
    };
    let half = (hi - lo) / 2.0;
    if half < HOP_SECONDS / 2.0 {
        return centre;
    }
    let step = (HOP_SECONDS).max((hi - lo) / MAX_SEARCH_STEPS as f64);
    let steps = ((hi - lo) / step).floor() as usize;
    let mut best: Option<(f32, f64)> = None;
    for index in 0..=steps {
        let time = (lo + index as f64 * step).min(hi);
        let Some(db) = to_source(time).and_then(|source| energy.smoothed_db(source)) else {
            continue;
        };
        let score = db + EDGE_PENALTY_DB * ((time - centre).abs() / half) as f32;
        if best.is_none_or(|(best_score, _)| score < best_score) {
            best = Some((score, time));
        }
    }
    best.map_or(centre, |(_, time)| time)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Removing {
    Before,
    After,
}

/// The cut point between word `index - 1` and word `index` (`index` may be 0
/// or `words.len()` for the edges), measured between the words' voiced parts.
/// Up to `LONG_GAP` the point is the same whichever side is removed, so
/// cutting two neighbours one at a time lands where cutting them together
/// does. In a longer silence the removed word takes at most `LONG_GAP / 2` of
/// it, and the rest stays for the pause controls to judge.
pub fn gap_cut(
    doc: &TranscriptDoc,
    energy: Option<&EnergyEnvelope>,
    index: usize,
    removing: Removing,
) -> f64 {
    let previous = index.checked_sub(1).and_then(|at| doc.voiced.get(at));
    let next = doc.voiced.get(index);
    let (previous_end, next_start) = match (previous, next) {
        (Some(previous), Some(next)) => (previous.end, next.start),
        (None, Some(next)) if next.start <= EDGE_REACH * 2.0 => return 0.0,
        (None, Some(next)) => ((next.start - EDGE_REACH).max(0.0), next.start),
        (Some(previous), None) => (previous.end, previous.end + EDGE_REACH),
        (None, None) => return 0.0,
    };
    let gap = next_start - previous_end;
    let (lo, hi) = if gap > LONG_GAP && previous.is_some() && next.is_some() {
        match removing {
            Removing::After => (next_start - LONG_GAP / 2.0, next_start - ONSET_GUARD),
            Removing::Before => (previous_end + TAIL_GUARD, previous_end + LONG_GAP / 2.0),
        }
    } else if gap > 0.0 {
        (
            previous_end + TAIL_GUARD.min(gap * 0.3),
            next_start - ONSET_GUARD.min(gap * 0.2),
        )
    } else {
        let centre = (previous_end + next_start) / 2.0;
        let floor = previous.map_or(f64::NEG_INFINITY, |word| (word.start + word.end) / 2.0);
        let ceiling = next.map_or(f64::INFINITY, |word| (word.start + word.end) / 2.0);
        (
            (centre - TOUCHING_SEARCH).max(floor).min(centre),
            (centre + TOUCHING_SEARCH).min(ceiling).max(centre),
        )
    };
    quietest_point(energy, lo, hi)
}

pub fn plan_word_cuts(
    doc: &TranscriptDoc,
    energy: Option<&EnergyEnvelope>,
    kept: Option<&[bool]>,
    runs: &[Range<usize>],
) -> Vec<Range<f64>> {
    let is_kept = |word: usize| kept.is_none_or(|kept| kept.get(word).copied().unwrap_or(true));
    let mut runs: Vec<Range<usize>> = runs
        .iter()
        .filter(|run| run.start < run.end && run.end <= doc.words.len())
        .cloned()
        .collect();
    runs.sort_by_key(|run| run.start);
    let mut joined: Vec<Range<usize>> = Vec::with_capacity(runs.len());
    for run in runs {
        match joined.last_mut() {
            Some(last) if run.start <= last.end => last.end = last.end.max(run.end),
            _ => joined.push(run),
        }
    }
    merge_ranges(
        joined
            .iter()
            .map(|run| {
                let start = if run.start > 0 && !is_kept(run.start - 1) {
                    Removing::Before
                } else {
                    Removing::After
                };
                let end = if run.end < doc.words.len() && !is_kept(run.end) {
                    Removing::After
                } else {
                    Removing::Before
                };
                gap_cut(doc, energy, run.start, start)..gap_cut(doc, energy, run.end, end)
            })
            .collect(),
    )
}

#[derive(Clone, Debug, PartialEq)]
pub struct PauseCut {
    pub after_word: usize,
    pub next_word: usize,
    pub length: f64,
    pub saves: f64,
    pub output: Range<f64>,
    pub cuts: Vec<Range<f64>>,
}

pub fn plan_pause_cuts(
    doc: &TranscriptDoc,
    edl: &TranscriptEdl,
    energy: Option<&EnergyEnvelope>,
    longer_than: f64,
    keep: f64,
) -> Vec<PauseCut> {
    let keep = keep.max(0.0);
    let floor = longer_than.max(keep + MIN_PAUSE_CUT);
    let slowest = edl
        .mappings
        .iter()
        .map(|mapping| mapping.timescale)
        .fold(f64::INFINITY, f64::min);
    let to_source = |output: f64| edl.output_to_source(output);
    let mut pauses = Vec::new();
    let mut previous: Option<(usize, Range<f64>)> = None;
    for index in 0..doc.voiced.len() {
        if doc.voiced[index].is_empty() {
            continue;
        }
        let Some(heard) = edl.audible_part(&doc.voiced[index]) else {
            continue;
        };
        let Some((before, before_heard)) = previous.replace((index, heard.clone())) else {
            continue;
        };
        let source = before_heard.end..heard.start;
        if source.end <= source.start
            || (slowest > 0.0 && source.end - source.start <= floor * slowest)
        {
            continue;
        }
        let (Some(from), Some(until)) = (
            edl.output_end_of(&before_heard),
            edl.output_start_of(&heard),
        ) else {
            continue;
        };
        let length = until - from;
        if length <= floor {
            continue;
        }
        let Some(pieces) = edl.source_pieces(from..until) else {
            continue;
        };
        if pieces
            .iter()
            .any(|piece| piece.start < source.start - 1e-6 || piece.end > source.end + 1e-6)
        {
            continue;
        }
        let lead = keep * 0.45;
        let trail = keep - lead;
        let lo_limit = from + TAIL_GUARD.min(lead);
        let hi_limit = until - ONSET_GUARD.min(trail);
        let start_target = from + lead;
        let end_target = until - trail;
        let start = quietest_mapped(
            energy,
            (start_target - 0.06).max(lo_limit),
            (start_target + 0.06).min(end_target),
            to_source,
        );
        let end = quietest_mapped(
            energy,
            (end_target - 0.06).max(start),
            (end_target + 0.06).min(hi_limit),
            to_source,
        );
        let saves = end - start;
        if saves < MIN_PAUSE_CUT {
            continue;
        }
        let Some(cuts) = edl.source_pieces(start..end) else {
            continue;
        };
        pauses.push(PauseCut {
            after_word: before,
            next_word: index,
            length,
            saves,
            output: from..until,
            cuts,
        });
    }
    pauses
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CutReport {
    pub applied: usize,
    pub transition: usize,
    pub hold: usize,
    pub last_clip: usize,
}

impl CutReport {
    pub fn skipped(&self) -> usize {
        self.transition + self.hold + self.last_clip
    }
}

/// Removes every source range from the timeline, wherever and however many
/// times it plays. Pieces are cut from the end backwards so each cut's clip
/// index and local times stay valid while the ones after it are applied.
pub fn apply_source_cuts(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    cuts: &[Range<f64>],
) -> CutReport {
    let cuts = merge_ranges(cuts.to_vec());
    let mappings = build_mappings(timeline, recording_durations);
    let mut pieces: Vec<(usize, f64, f64)> = Vec::new();
    for mapping in &mappings {
        let first = cuts.partition_point(|cut| cut.end <= mapping.source_start);
        for cut in cuts[first..]
            .iter()
            .take_while(|cut| cut.start < mapping.source_end)
        {
            let start = cut.start.max(mapping.source_start);
            let end = cut.end.min(mapping.source_end);
            if end > start {
                pieces.push((
                    mapping.segment,
                    (start - mapping.source_start) / mapping.timescale,
                    (end - mapping.source_start) / mapping.timescale,
                ));
            }
        }
    }
    pieces.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.total_cmp(&a.1)));

    let mut report = CutReport::default();
    for (segment, start, end) in pieces {
        match editor_edits::cut_clip_range(timeline, segment, start, end) {
            RangeCut::Applied => report.applied += 1,
            RangeCut::Empty => {}
            RangeCut::Transition => report.transition += 1,
            RangeCut::Hold => report.hold += 1,
            RangeCut::LastClip => report.last_clip += 1,
        }
    }
    report
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RestoreBlocker {
    NotAdjacent,
    Transition,
}

const TOUCH_EPSILON: f64 = 1e-6;

pub fn restore_hole(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    removed_takes: &[cap_project::TimelineSegment],
    hole: Range<f64>,
    must_cover: f64,
) -> Result<(), RestoreBlocker> {
    let offsets = recording_offsets(recording_durations);
    let clip_bounds = |clip: u32| {
        let start = offsets.get(clip as usize).copied().unwrap_or(0.0);
        let duration = recording_durations
            .get(clip as usize)
            .copied()
            .unwrap_or(f64::INFINITY);
        (start, start + duration)
    };
    let mut next = timeline.clone();
    let mappings = build_mappings(&next, recording_durations);
    let left = mappings
        .iter()
        .find(|mapping| (mapping.source_end - hole.start).abs() < TOUCH_EPSILON)
        .copied();
    let right = mappings
        .iter()
        .find(|mapping| (mapping.source_start - hole.end).abs() < TOUCH_EPSILON)
        .copied();
    match (left, right) {
        (Some(left), Some(right)) if right.segment != left.segment + 1 => {
            return Err(RestoreBlocker::NotAdjacent);
        }
        (None, None) => return Err(RestoreBlocker::NotAdjacent),
        _ => {}
    }
    if let Some(left) = left
        && next.effective_transition(left.segment + 1).is_some()
    {
        return Err(RestoreBlocker::Transition);
    }
    if let Some(right) = right
        && next.effective_transition(right.segment).is_some()
    {
        return Err(RestoreBlocker::Transition);
    }

    let mut restored_to = hole.start;
    if let Some(left) = left {
        let (clip_start, clip_end) = clip_bounds(left.recording_clip);
        let target = hole.end.min(clip_end);
        let grow = target - left.source_end;
        if grow > 0.0 {
            let holds = next.hold_windows();
            let boundary = editor_edits::effective_to_output(&holds, left.effective_end());
            next.segments[left.segment].end = target - clip_start;
            editor_edits::ripple_insert_output_tracks(&mut next, boundary, grow / left.timescale);
            restored_to = target;
        }
    }
    if let Some(right) = right {
        let (clip_start, _) = clip_bounds(right.recording_clip);
        let target = restored_to.max(hole.start).max(clip_start);
        let grow = right.source_start - target;
        if grow > 0.0 {
            let effective_start = build_mappings(&next, recording_durations)
                .get(right.segment)
                .map_or(right.effective_start, |mapping| mapping.effective_start);
            let holds = next.hold_windows();
            let boundary = editor_edits::effective_to_output(&holds, effective_start);
            next.segments[right.segment].start = target - clip_start;
            editor_edits::ripple_insert_output_tracks(&mut next, boundary, grow / right.timescale);
        }
    }

    let first_missing = left.map_or(0, |left| left.recording_clip + 1);
    let last_missing = right.map_or(recording_durations.len() as u32, |right| {
        right.recording_clip
    });
    let mut index = match (left, right) {
        (Some(left), _) => left.segment + 1,
        (None, Some(right)) => right.segment,
        (None, None) => 0,
    };
    for clip in first_missing..last_missing {
        let (start, end) = clip_bounds(clip);
        let duration = end - start;
        if !(duration.is_finite() && duration > 0.0)
            || start < hole.start - TOUCH_EPSILON
            || end > hole.end + TOUCH_EPSILON
        {
            continue;
        }
        let effective = crate::editor_timeline::clip_timeline_offsets(&next)
            .get(index)
            .copied()
            .unwrap_or_else(|| editor_edits::clip_timeline_duration(&next));
        let holds = next.hold_windows();
        let boundary = editor_edits::effective_to_output(&holds, effective);
        let removed = removed_takes
            .iter()
            .find(|segment| segment.recording_clip == clip);
        let template = removed
            .or_else(|| {
                left.or(right)
                    .and_then(|mapping| timeline.segments.get(mapping.segment))
            })
            .cloned()
            .unwrap_or(cap_project::TimelineSegment {
                timescale: 1.0,
                ..Default::default()
            });
        next.segments.insert(
            index,
            cap_project::TimelineSegment {
                recording_clip: clip,
                start: 0.0,
                end: duration,
                name: removed.and(template.name.clone()),
                ..template
            },
        );
        for transition in next.transitions.iter_mut() {
            if transition.segment_index as usize >= index {
                transition.segment_index += 1;
            }
        }
        let played = next.segments[index].duration();
        editor_edits::ripple_insert_output_tracks(&mut next, boundary, played);
        index += 1;
    }

    let covered = build_mappings(&next, recording_durations)
        .iter()
        .any(|mapping| mapping.source_start <= must_cover && must_cover < mapping.source_end);
    if !covered {
        return Err(RestoreBlocker::NotAdjacent);
    }

    if let (Some(left), Some(_)) = (left, right) {
        let mergeable = {
            let (a, b) = (
                &next.segments[left.segment],
                &next.segments[left.segment + 1],
            );
            a.recording_clip == b.recording_clip
                && (a.end - b.start).abs() < TOUCH_EPSILON
                && a.timescale == b.timescale
                && a.volume == b.volume
                && a.speed_audio_mode == b.speed_audio_mode
                && a.hide_cursor == b.hide_cursor
                && (b.name.is_none() || a.name == b.name)
        };
        if mergeable {
            editor_edits::merge_clip_segments(
                &mut next,
                left.segment,
                editor_edits::ClipMergeDirection::Next,
            );
        }
    }
    *timeline = next;
    Ok(())
}

/// Brings back every cut word in `words`, one cut stretch at a time, and
/// returns how many stretches that took. All or nothing: if any stretch
/// cannot be restored, the timeline is left exactly as it was.
pub fn restore_words(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    removed_takes: &[cap_project::TimelineSegment],
    doc: &TranscriptDoc,
    words: Range<usize>,
) -> Result<usize, RestoreBlocker> {
    let mut next = timeline.clone();
    let mut restored = 0;
    for _ in 0..=words.len() {
        let edl = TranscriptEdl::build(doc, &next, recording_durations);
        let Some(index) = words.clone().find(|word| !edl.is_kept(*word)) else {
            break;
        };
        let word = &doc.voiced[index];
        let first = edl
            .kept_ranges
            .partition_point(|range| range.end <= word.start);
        let uncovered = match edl.kept_ranges.get(first) {
            Some(range) if range.start <= word.start => range.end,
            _ => word.start,
        };
        let point = if uncovered < word.end {
            uncovered
        } else {
            word.start
        };
        let hole = edl.hole_around(point).ok_or(RestoreBlocker::NotAdjacent)?;
        restore_hole(&mut next, recording_durations, removed_takes, hole, point)?;
        restored += 1;
    }
    *timeline = next;
    Ok(restored)
}

/// Each word of `before` in `after`, the same transcript once its timings are
/// refined: the same words in the same order, with any the refinement
/// recovered in between. A word that could be either of two equal words in
/// `after`, because one was recovered beside it, follows neither.
fn follow_words(before: &TranscriptDoc, after: &TranscriptDoc) -> Vec<Option<usize>> {
    let mut next = 0;
    let earliest = before.words.iter().map(|word| {
        let found = next
            + after.words[next..]
                .iter()
                .position(|candidate| candidate.text == word.text)?;
        next = found + 1;
        Some(found)
    });
    let earliest: Vec<Option<usize>> = earliest.collect();
    let mut limit = after.words.len();
    let latest = before.words.iter().rev().map(|word| {
        let found = after.words[..limit]
            .iter()
            .rposition(|candidate| candidate.text == word.text)?;
        limit = found;
        Some(found)
    });
    let mut latest: Vec<Option<usize>> = latest.collect();
    latest.reverse();
    earliest
        .into_iter()
        .zip(latest)
        .map(|(earliest, latest)| earliest.filter(|_| earliest == latest))
        .collect()
}

/// A cut splits an audio segment that plays across it, and restoring the hole
/// only moves the second piece away, leaving silence where the first used to
/// carry on. Rejoins the pieces the restore pulled apart, so the cut that
/// replaces it splits a whole segment again. `false` when it pulled apart
/// pieces that cannot be rejoined as they were: different audio, or halves
/// whose fades at the split were edited since.
fn rejoin_split_audio(
    before: &[cap_project::AudioTrackSegment],
    restored: &mut Vec<cap_project::AudioTrackSegment>,
) -> bool {
    if before.len() != restored.len() {
        return false;
    }
    let mut joins: Vec<(usize, usize)> = Vec::new();
    for (first, head) in restored.iter().enumerate() {
        for (second, tail) in restored.iter().enumerate() {
            let pulled_apart = second != first
                && tail.track == head.track
                && (before[first].end - before[second].start).abs() < TOUCH_EPSILON
                && tail.start > head.end + TOUCH_EPSILON;
            if !pulled_apart {
                continue;
            }
            let one_segment = tail.path == head.path
                && tail.name == head.name
                && tail.enabled == head.enabled
                && tail.volume_db == head.volume_db
                && head.fade_out == 0.0
                && tail.fade_in == 0.0
                && ((tail.trim_start - head.trim_start) - (tail.start - head.start)).abs()
                    < TOUCH_EPSILON;
            if !one_segment {
                return false;
            }
            joins.push((first, second));
        }
    }
    for (first, second) in &joins {
        restored[*first].end = restored[*second].end;
        restored[*first].fade_out = restored[*second].fade_out;
    }
    let mut joined: Vec<usize> = joins.into_iter().map(|(_, second)| second).collect();
    joined.sort_unstable();
    joined.dedup();
    for second in joined.into_iter().rev() {
        restored.remove(second);
    }
    true
}

/// Moves word cuts made on the first pass's timings to where the refined
/// timings put the same words, and returns how many moved. The first pass can
/// place a word a third of a second off, so a cut planned on it removes the
/// silence beside a filler and leaves the filler playing.
///
/// Only a hole that is exactly what cutting its words would have produced
/// moves. Anything else, a trim made on the timeline or a word cut edited
/// since, stays where it is, as does a cut that cannot be redone.
pub fn follow_refined_words(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    removed_takes: &[cap_project::TimelineSegment],
    before: &TranscriptDoc,
    after: &TranscriptDoc,
    energy: Option<&EnergyEnvelope>,
) -> usize {
    let followed = follow_words(before, after);
    let mut moved = follow_planned_cuts(
        timeline,
        recording_durations,
        removed_takes,
        (before, energy),
        (after, energy),
        &followed,
    );
    if energy.is_some() {
        // A cut made while the loudness envelope was still loading was planned
        // without it, on the words' unrefined spans.
        let mut unheard = before.clone();
        unheard.refine_voiced(None);
        moved += follow_planned_cuts(
            timeline,
            recording_durations,
            removed_takes,
            (&unheard, None),
            (after, energy),
            &followed,
        );
    }
    moved
}

fn follow_planned_cuts(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    removed_takes: &[cap_project::TimelineSegment],
    (before, planned_with): (&TranscriptDoc, Option<&EnergyEnvelope>),
    (after, energy): (&TranscriptDoc, Option<&EnergyEnvelope>),
    followed: &[Option<usize>],
) -> usize {
    let total: f64 = recording_durations.iter().sum();
    let within = |range: &Range<f64>| range.start.clamp(0.0, total)..range.end.clamp(0.0, total);
    let same = |a: &Range<f64>, b: &Range<f64>| {
        (a.start - b.start).abs() < TOUCH_EPSILON && (a.end - b.end).abs() < TOUCH_EPSILON
    };
    let runs = TranscriptEdl::build(before, timeline, recording_durations).cut_runs;
    let mut moved = 0;
    for run in runs {
        let (Some(first), Some(last)) = (followed[run.start], followed[run.end - 1]) else {
            continue;
        };
        let followed_run = first..last + 1;
        let (Some(planned), Some(refined)) = (
            plan_word_cuts(before, planned_with, None, std::slice::from_ref(&run)).pop(),
            plan_word_cuts(after, energy, None, std::slice::from_ref(&followed_run)).pop(),
        ) else {
            continue;
        };
        let (planned, refined) = (within(&planned), within(&refined));
        if same(&planned, &refined) || refined.end <= refined.start {
            continue;
        }
        let inside = (planned.start + planned.end) / 2.0;
        let kept = kept_ranges(&build_mappings(timeline, recording_durations));
        let Some(hole) = hole_around(&kept, inside).filter(|hole| same(&within(hole), &planned))
        else {
            continue;
        };
        let mut next = timeline.clone();
        if restore_hole(&mut next, recording_durations, removed_takes, hole, inside).is_err() {
            continue;
        }
        if !rejoin_split_audio(&timeline.audio_segments, &mut next.audio_segments) {
            continue;
        }
        let report = apply_source_cuts(
            &mut next,
            recording_durations,
            std::slice::from_ref(&refined),
        );
        if report.applied == 0 || report.skipped() > 0 {
            continue;
        }
        *timeline = next;
        moved += 1;
    }
    moved
}
