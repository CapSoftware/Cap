use std::ops::Range;

use cap_project::disfluency::{Disfluency, DisfluencyToken, detect_disfluencies};
use cap_project::{CaptionsData, TimelineConfiguration};
use gpui::SharedString;

use super::energy::EnergyEnvelope;
use crate::editor_edits;
use crate::editor_timeline;

const PARAGRAPH_PAUSE: f64 = 1.6;
const SENTENCE_PARAGRAPH_PAUSE: f64 = 0.7;
const SOFT_PARAGRAPH_WORDS: usize = 70;
const HARD_PARAGRAPH_WORDS: usize = 140;
const ACTIVE_WORD_LINGER: f64 = 0.25;
pub const WORD_TRIM_MIN: f64 = 0.25;
const WORD_EDGE_SLACK: f64 = 0.08;
const MIN_VOICED: f64 = 0.04;

#[derive(Clone, Debug, PartialEq)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug)]
pub struct Paragraph {
    pub words: Range<usize>,
    pub text: SharedString,
    pub spans: Vec<Range<usize>>,
}

impl Paragraph {
    pub fn word_at_byte(&self, byte: usize) -> usize {
        let local = self
            .spans
            .partition_point(|span| span.end < byte)
            .min(self.spans.len().saturating_sub(1));
        self.words.start + local
    }

    pub fn span(&self, word: usize) -> Option<Range<usize>> {
        self.spans.get(word.checked_sub(self.words.start)?).cloned()
    }
}

#[derive(Clone)]
pub struct TranscriptDoc {
    pub words: Vec<Word>,
    pub voiced: Vec<Range<f64>>,
    pub paragraphs: Vec<Paragraph>,
    pub paragraph_of: Vec<u32>,
    pub fillers: Vec<Disfluency>,
    pub filler_of: Vec<u32>,
    pub signature: u64,
}

pub const NO_FILLER: u32 = u32::MAX;

fn attaches_to_previous(text: &str) -> bool {
    text.chars().next().is_some_and(|first| {
        matches!(
            first,
            ',' | '.'
                | '!'
                | '?'
                | ';'
                | ':'
                | '%'
                | ')'
                | ']'
                | '}'
                | '\''
                | '’'
                | '、'
                | '。'
                | '！'
                | '？'
                | '；'
                | '：'
                | '，'
        )
    })
}

fn ends_sentence(text: &str) -> bool {
    let trimmed = text.trim_end_matches(['"', '\'', '”', '’', ')']);
    trimmed.ends_with(['.', '!', '?', '。', '！', '？', '…'])
}

fn ends_clause(text: &str) -> bool {
    ends_sentence(text) || text.ends_with([',', ';', ':', '—', '-', '，'])
}

pub fn captions_signature(captions: Option<&CaptionsData>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    if let Some(captions) = captions {
        captions.source_timed.hash(&mut hasher);
        captions.segments.len().hash(&mut hasher);
        for segment in &captions.segments {
            segment.words.len().hash(&mut hasher);
            for word in &segment.words {
                word.text.hash(&mut hasher);
                word.start.to_bits().hash(&mut hasher);
                word.end.to_bits().hash(&mut hasher);
            }
        }
    }
    hasher.finish()
}

pub fn flatten_words(captions: &CaptionsData) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    let mut raw: Vec<(&str, f64, f64)> = captions
        .segments
        .iter()
        .flat_map(|segment| segment.words.iter())
        .filter_map(|word| {
            let text = word.text.trim();
            let (start, end) = (f64::from(word.start), f64::from(word.end));
            (!text.is_empty() && start.is_finite() && end.is_finite()).then_some((
                text,
                start,
                end.max(start),
            ))
        })
        .collect();
    raw.sort_by(|a, b| a.1.total_cmp(&b.1));
    for (text, start, end) in raw {
        let spoken = !cap_project::disfluency::normalize_word(text).is_empty();
        match words.last_mut() {
            Some(previous) if !spoken || attaches_to_previous(text) => {
                previous.text.push_str(text);
                if spoken {
                    previous.end = previous.end.max(end);
                }
            }
            _ if !spoken => {}
            _ => words.push(Word {
                text: text.to_string(),
                start,
                end,
            }),
        }
    }
    words
}

fn build_paragraphs(words: &[Word]) -> Vec<Range<usize>> {
    let mut paragraphs = Vec::new();
    let mut start = 0;
    for index in 1..words.len() {
        let previous = &words[index - 1];
        let gap = words[index].start - previous.end;
        let length = index - start;
        let sentence = ends_sentence(&previous.text);
        let breaks = gap >= PARAGRAPH_PAUSE
            || (sentence && gap >= SENTENCE_PARAGRAPH_PAUSE)
            || (sentence && length >= SOFT_PARAGRAPH_WORDS)
            || (length >= HARD_PARAGRAPH_WORDS && (ends_clause(&previous.text) || gap >= 0.3))
            || length >= HARD_PARAGRAPH_WORDS * 2;
        if breaks {
            paragraphs.push(start..index);
            start = index;
        }
    }
    if start < words.len() {
        paragraphs.push(start..words.len());
    }
    paragraphs
}

impl TranscriptDoc {
    pub fn build(captions: &CaptionsData) -> Self {
        let words = flatten_words(captions);
        let tokens: Vec<DisfluencyToken> = words
            .iter()
            .map(|word| DisfluencyToken {
                text: &word.text,
                start: word.start,
                end: word.end,
            })
            .collect();
        let fillers = detect_disfluencies(&tokens);
        let mut filler_of = vec![NO_FILLER; words.len()];
        for (index, filler) in fillers.iter().enumerate() {
            for slot in &mut filler_of[filler.words.clone()] {
                *slot = index as u32;
            }
        }

        let ranges = build_paragraphs(&words);
        let mut paragraph_of = vec![0u32; words.len()];
        let paragraphs = ranges
            .into_iter()
            .enumerate()
            .map(|(index, range)| {
                let mut text = String::new();
                let mut spans = Vec::with_capacity(range.len());
                for word in &words[range.clone()] {
                    if !text.is_empty() {
                        text.push(' ');
                    }
                    let start = text.len();
                    text.push_str(&word.text);
                    spans.push(start..text.len());
                }
                for slot in &mut paragraph_of[range.clone()] {
                    *slot = index as u32;
                }
                Paragraph {
                    words: range,
                    text: text.into(),
                    spans,
                }
            })
            .collect();

        Self {
            voiced: words.iter().map(|word| word.start..word.end).collect(),
            words,
            paragraphs,
            paragraph_of,
            fillers,
            filler_of,
            signature: captions_signature(Some(captions)),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    pub fn paragraph_of(&self, word: usize) -> usize {
        self.paragraph_of.get(word).copied().unwrap_or(0) as usize
    }

    pub fn word_at_source(&self, source: f64) -> Option<usize> {
        let index = self
            .voiced
            .partition_point(|span| span.start <= source)
            .checked_sub(1)?;
        let span = &self.voiced[index];
        (source <= span.end.max(span.start) + ACTIVE_WORD_LINGER).then_some(index)
    }

    pub fn refine_voiced(&mut self, energy: Option<&EnergyEnvelope>) {
        self.voiced = match energy {
            Some(energy) => voiced_spans(&self.words, energy),
            None => self.words.iter().map(|word| word.start..word.end).collect(),
        };
    }

    pub fn filler(&self, word: usize) -> Option<&Disfluency> {
        let index = *self.filler_of.get(word)?;
        (index != NO_FILLER).then(|| &self.fillers[index as usize])
    }

    pub fn text_of(&self, words: Range<usize>) -> String {
        let mut text = String::new();
        for word in &self.words[words] {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&word.text);
        }
        text
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mapping {
    pub segment: usize,
    pub recording_clip: u32,
    pub source_start: f64,
    pub source_end: f64,
    pub effective_start: f64,
    pub timescale: f64,
}

impl Mapping {
    pub fn effective_end(&self) -> f64 {
        self.effective_start + (self.source_end - self.source_start) / self.timescale
    }

    pub fn effective_at(&self, source: f64) -> f64 {
        self.effective_start + (source - self.source_start) / self.timescale
    }
}

pub fn recording_offsets(recording_durations: &[f64]) -> Vec<f64> {
    let mut offsets = Vec::with_capacity(recording_durations.len());
    let mut total = 0.0;
    for duration in recording_durations {
        offsets.push(total);
        total += duration;
    }
    offsets
}

pub fn build_mappings(
    timeline: &TimelineConfiguration,
    recording_durations: &[f64],
) -> Vec<Mapping> {
    let offsets = recording_offsets(recording_durations);
    editor_timeline::clip_timeline_offsets(timeline)
        .into_iter()
        .zip(&timeline.segments)
        .enumerate()
        .map(|(segment_index, (effective_start, segment))| {
            let offset = offsets
                .get(segment.recording_clip as usize)
                .copied()
                .unwrap_or(0.0);
            Mapping {
                segment: segment_index,
                recording_clip: segment.recording_clip,
                source_start: offset + segment.start,
                source_end: offset + segment.end,
                effective_start,
                timescale: segment.timescale,
            }
        })
        .collect()
}

/// Which words survive the current edit list. A word counts as kept when at
/// least half of it plays, which is what makes a cut placed in the silence
/// beside a word never hide it, while a word trimmed down to a sliver reads as
/// cut.
pub struct TranscriptEdl {
    pub kept: Vec<bool>,
    pub mappings: Vec<Mapping>,
    pub holds: Vec<(f64, f64)>,
    pub kept_ranges: Vec<Range<f64>>,
    pub cut_runs: Vec<Range<usize>>,
    pub kept_count: usize,
}

pub fn voiced_spans(words: &[Word], energy: &EnergyEnvelope) -> Vec<Range<f64>> {
    words
        .iter()
        .map(|word| {
            let (mut start, mut end) = (word.start, word.end);
            if end - start < WORD_TRIM_MIN + MIN_VOICED {
                return start..end;
            }
            let silences = energy.silences_overlapping(start..end);
            if let Some(cover) = silences.iter().find(|silence| {
                silence.start <= start + WORD_EDGE_SLACK && silence.end >= end - WORD_EDGE_SLACK
            }) {
                let point = cover.start.clamp(start, end);
                return point..point;
            }
            if let Some(head) = silences.first()
                && head.start <= start + WORD_EDGE_SLACK
                && head.end - start >= WORD_TRIM_MIN
                && head.end + MIN_VOICED <= end
            {
                start = head.end;
            }
            if let Some(tail) = silences.last()
                && tail.end >= end - WORD_EDGE_SLACK
                && end - tail.start >= WORD_TRIM_MIN
                && tail.start - MIN_VOICED >= start
            {
                end = tail.start;
            }
            start..end
        })
        .collect()
}

pub fn merge_ranges(mut ranges: Vec<Range<f64>>) -> Vec<Range<f64>> {
    ranges.retain(|range| range.end > range.start);
    ranges.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut merged: Vec<Range<f64>> = Vec::with_capacity(ranges.len());
    for range in ranges {
        match merged.last_mut() {
            Some(last) if range.start <= last.end + 1e-9 => last.end = last.end.max(range.end),
            _ => merged.push(range),
        }
    }
    merged
}

impl TranscriptEdl {
    pub fn build(
        doc: &TranscriptDoc,
        timeline: &TimelineConfiguration,
        recording_durations: &[f64],
    ) -> Self {
        let mappings = build_mappings(timeline, recording_durations);
        let kept_ranges = kept_ranges(&mappings);
        let mut kept = Vec::with_capacity(doc.voiced.len());
        let mut cursor = 0;
        for word in &doc.voiced {
            while kept_ranges
                .get(cursor)
                .is_some_and(|range| range.end <= word.start)
            {
                cursor += 1;
            }
            let duration = word.end - word.start;
            let is_kept = if duration <= 1e-6 {
                kept_ranges
                    .get(cursor)
                    .is_some_and(|range| range.start <= word.start && word.start < range.end)
            } else {
                let covered: f64 = kept_ranges[cursor.min(kept_ranges.len())..]
                    .iter()
                    .take_while(|range| range.start < word.end)
                    .map(|range| (range.end.min(word.end) - range.start.max(word.start)).max(0.0))
                    .sum();
                covered >= duration * 0.5
            };
            kept.push(is_kept);
        }

        let mut cut_runs = Vec::new();
        let mut run_start = None;
        for (index, is_kept) in kept.iter().enumerate() {
            match (run_start, is_kept) {
                (None, false) => run_start = Some(index),
                (Some(start), true) => {
                    cut_runs.push(start..index);
                    run_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = run_start {
            cut_runs.push(start..kept.len());
        }

        Self {
            kept_count: kept.iter().filter(|kept| **kept).count(),
            kept,
            mappings,
            holds: timeline.hold_windows(),
            kept_ranges,
            cut_runs,
        }
    }

    pub fn is_kept(&self, word: usize) -> bool {
        self.kept.get(word).copied().unwrap_or(false)
    }

    pub fn cut_run_of(&self, word: usize) -> Option<usize> {
        let index = self.cut_runs.partition_point(|run| run.end <= word);
        self.cut_runs
            .get(index)
            .filter(|run| run.contains(&word))
            .map(|_| index)
    }

    pub fn source_to_output(&self, source: f64) -> Option<f64> {
        let mapping = self
            .mappings
            .iter()
            .find(|mapping| mapping.source_start <= source && source < mapping.source_end)
            .or_else(|| {
                self.mappings
                    .iter()
                    .find(|mapping| (mapping.source_end - source).abs() < 1e-9)
            })?;
        Some(editor_edits::effective_to_output(
            &self.holds,
            mapping.effective_at(source),
        ))
    }

    pub fn audible_part(&self, span: &Range<f64>) -> Option<Range<f64>> {
        let first = self
            .kept_ranges
            .partition_point(|range| range.end <= span.start);
        let mut heard: Option<Range<f64>> = None;
        for range in self.kept_ranges[first..]
            .iter()
            .take_while(|range| range.start < span.end)
        {
            let start = range.start.max(span.start);
            let end = range.end.min(span.end);
            if end > start {
                heard = Some(heard.map_or(start, |heard| heard.start)..end);
            }
        }
        heard
    }

    pub fn output_start_of(&self, word: &Range<f64>) -> Option<f64> {
        self.source_to_output(word.start).or_else(|| {
            let index = self
                .kept_ranges
                .partition_point(|range| range.end <= word.start);
            let range = self.kept_ranges.get(index)?;
            if range.start >= word.end {
                return None;
            }
            self.source_to_output(range.start.max(word.start))
        })
    }

    pub fn output_end_of(&self, word: &Range<f64>) -> Option<f64> {
        self.source_to_output(word.end).or_else(|| {
            let index = self
                .kept_ranges
                .partition_point(|range| range.start < word.end)
                .checked_sub(1)?;
            let range = &self.kept_ranges[index];
            if range.end <= word.start {
                return None;
            }
            self.source_to_output(range.end.min(word.end))
        })
    }

    pub fn source_pieces(&self, output: Range<f64>) -> Option<Vec<Range<f64>>> {
        if self
            .holds
            .iter()
            .any(|(start, end)| *start < output.end && output.start < *end)
        {
            return None;
        }
        let from = output.start - editor_edits::held_time_before(&self.holds, output.start);
        let until = from + (output.end - output.start);
        let first = self
            .mappings
            .partition_point(|mapping| mapping.effective_end() <= from + 1e-9);
        let mut pieces = Vec::new();
        let mut previous_end: Option<f64> = None;
        for mapping in &self.mappings[first..] {
            if mapping.effective_start >= until - 1e-9 {
                break;
            }
            if previous_end.is_some_and(|end| mapping.effective_start < end - 1e-6) {
                return None;
            }
            let start = from.max(mapping.effective_start);
            let end = until.min(mapping.effective_end());
            if end > start {
                pieces.push(
                    mapping.source_start + (start - mapping.effective_start) * mapping.timescale
                        ..mapping.source_start
                            + (end - mapping.effective_start) * mapping.timescale,
                );
            }
            previous_end = Some(mapping.effective_end());
        }
        Some(pieces)
    }

    pub fn output_to_source(&self, output: f64) -> Option<f64> {
        let effective = output - editor_edits::held_time_before(&self.holds, output);
        let index = self
            .mappings
            .partition_point(|mapping| mapping.effective_start <= effective)
            .checked_sub(1)?;
        let mapping = &self.mappings[index];
        (effective <= mapping.effective_end() + 1e-9).then_some(
            mapping.source_start + (effective - mapping.effective_start) * mapping.timescale,
        )
    }

    pub fn hole_around(&self, source: f64) -> Option<Range<f64>> {
        hole_around(&self.kept_ranges, source)
    }
}

pub fn kept_ranges(mappings: &[Mapping]) -> Vec<Range<f64>> {
    merge_ranges(
        mappings
            .iter()
            .map(|mapping| mapping.source_start..mapping.source_end)
            .collect(),
    )
}

pub fn hole_around(kept_ranges: &[Range<f64>], source: f64) -> Option<Range<f64>> {
    let after = kept_ranges.partition_point(|range| range.start <= source);
    if after > 0 && kept_ranges[after - 1].end > source {
        return None;
    }
    let start = after
        .checked_sub(1)
        .map_or(f64::NEG_INFINITY, |before| kept_ranges[before].end);
    let end = kept_ranges
        .get(after)
        .map_or(f64::INFINITY, |range| range.start);
    Some(start..end)
}
