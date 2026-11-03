use std::ops::Range;

use cap_project::TimelineConfiguration;

use super::energy::{EnergyEnvelope, HOP_SECONDS};
use super::model::{TranscriptDoc, TranscriptEdl, build_mappings, merge_ranges, recording_offsets};
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
/// When two words touch, the cut point is searched within this distance of the
/// shared boundary, and never past the middle of either word.
const TOUCHING_SEARCH: f64 = 0.04;
/// A point at the edge of the search window must be this many decibels
/// quieter than the middle to win, so equal silence splits a pause evenly.
const EDGE_PENALTY_DB: f32 = 6.0;
const MAX_SEARCH_STEPS: usize = 4_000;
/// Pause cuts shorter than this are not worth a clip boundary.
const MIN_PAUSE_CUT: f64 = 0.05;

/// The quietest point in `lo..hi`, preferring the middle when the audio does
/// not say otherwise. Without audio, the middle.
pub fn quietest_point(energy: Option<&EnergyEnvelope>, lo: f64, hi: f64) -> f64 {
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
        let Some(db) = energy.smoothed_db(time) else {
            continue;
        };
        let score = db + EDGE_PENALTY_DB * ((time - centre).abs() / half) as f32;
        if best.is_none_or(|(best_score, _)| score < best_score) {
            best = Some((score, time));
        }
    }
    best.map_or(centre, |(_, time)| time)
}

/// The cut point between word `index - 1` and word `index` (`index` may be 0
/// or `words.len()` for the edges). Deterministic per gap, so cutting two
/// neighbouring words one at a time lands on exactly the same boundary as
/// cutting them together.
pub fn gap_cut(doc: &TranscriptDoc, energy: Option<&EnergyEnvelope>, index: usize) -> f64 {
    let previous = index.checked_sub(1).and_then(|at| doc.words.get(at));
    let next = doc.words.get(index);
    let (previous_end, next_start) = match (previous, next) {
        (Some(previous), Some(next)) => (previous.end, next.start),
        (None, Some(next)) if next.start <= EDGE_REACH * 2.0 => return 0.0,
        (None, Some(next)) => ((next.start - EDGE_REACH).max(0.0), next.start),
        (Some(previous), None) => (previous.end, previous.end + EDGE_REACH),
        (None, None) => return 0.0,
    };
    let gap = next_start - previous_end;
    let (lo, hi) = if gap > 0.0 {
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

/// Source ranges that remove each run of words, with the cut edges in the
/// silences on either side. Overlapping and touching ranges are merged.
pub fn plan_word_cuts(
    doc: &TranscriptDoc,
    energy: Option<&EnergyEnvelope>,
    runs: &[Range<usize>],
) -> Vec<Range<f64>> {
    merge_ranges(
        runs.iter()
            .filter(|run| run.start < run.end && run.end <= doc.words.len())
            .map(|run| gap_cut(doc, energy, run.start)..gap_cut(doc, energy, run.end))
            .collect(),
    )
}

/// One pause the shorten-pauses action would trim: the words on either side
/// and the source range that would go.
#[derive(Clone, Debug, PartialEq)]
pub struct PauseCut {
    pub after_word: usize,
    pub length: f64,
    pub cut: Range<f64>,
}

/// Every silence between two kept words longer than `longer_than`, trimmed so
/// `keep` seconds of it remain: a little under half after the first word,
/// the rest before the next so the breath into it survives. Pauses that
/// already contain a cut are left alone.
pub fn plan_pause_cuts(
    doc: &TranscriptDoc,
    edl: &TranscriptEdl,
    energy: Option<&EnergyEnvelope>,
    longer_than: f64,
    keep: f64,
) -> Vec<PauseCut> {
    let keep = keep.max(0.0);
    let mut pauses = Vec::new();
    for index in 1..doc.words.len() {
        if !edl.is_kept(index - 1) || !edl.is_kept(index) {
            continue;
        }
        let previous_end = doc.words[index - 1].end;
        let next_start = doc.words[index].start;
        let length = next_start - previous_end;
        if length <= longer_than || length <= keep + MIN_PAUSE_CUT {
            continue;
        }
        if !edl.covers(previous_end..next_start) {
            continue;
        }
        let lead = keep * 0.45;
        let trail = keep - lead;
        let lo_limit = previous_end + TAIL_GUARD.min(lead);
        let hi_limit = next_start - ONSET_GUARD.min(trail);
        let start_target = previous_end + lead;
        let end_target = next_start - trail;
        let start = quietest_point(
            energy,
            (start_target - 0.06).max(lo_limit),
            (start_target + 0.06).min(end_target),
        );
        let end = quietest_point(
            energy,
            (end_target - 0.06).max(start),
            (end_target + 0.06).min(hi_limit),
        );
        if end - start < MIN_PAUSE_CUT {
            continue;
        }
        pauses.push(PauseCut {
            after_word: index - 1,
            length,
            cut: start..end,
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
    /// The clips on either side of the cut are not neighbours on the
    /// timeline (it was reordered), or the cut is not next to any clip.
    NotAdjacent,
    /// A transition sits on the cut.
    Transition,
}

const TOUCH_EPSILON: f64 = 1e-6;

/// Plays `hole` again by growing the clips that end and start at its edges,
/// rippling everything after each grown edge later, and merging the two
/// halves back into one clip when they become contiguous with the same
/// settings. `must_cover` is a source instant the restore has to bring back;
/// if it cannot, nothing changes.
pub fn restore_hole(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
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

/// Brings back every cut word in `words`, one cut stretch at a time. Returns
/// how many stretches were restored; stops at the first one that cannot be.
pub fn restore_words(
    timeline: &mut TimelineConfiguration,
    recording_durations: &[f64],
    doc: &TranscriptDoc,
    words: Range<usize>,
) -> Result<usize, RestoreBlocker> {
    let mut restored = 0;
    for _ in 0..=words.len() {
        let edl = TranscriptEdl::build(doc, timeline, recording_durations);
        let Some(index) = words.clone().find(|word| !edl.is_kept(*word)) else {
            break;
        };
        let word = &doc.words[index];
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
        restore_hole(timeline, recording_durations, hole, point)?;
        restored += 1;
    }
    Ok(restored)
}
