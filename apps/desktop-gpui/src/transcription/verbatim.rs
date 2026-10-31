use cap_project::CaptionWord;

/// Parakeet times a token by the encoder frame it was emitted on and ends it
/// where the next token starts, which stretches a word over any pause after
/// it. A word instead ends a few frames after its last token; snapping to the
/// pause that follows moves it to the real offset.
const TOKEN_REACH_SECONDS: f32 = 0.24;

pub(super) fn words_from_subword_tokens(
    tokens: impl IntoIterator<Item = CaptionWord>,
) -> Vec<CaptionWord> {
    let mut words: Vec<CaptionWord> = Vec::new();
    let mut open = false;
    for token in tokens {
        let text = token.text.trim_start();
        if text.trim().is_empty() {
            open = false;
            continue;
        }
        let joins = text.starts_with('\'') || text.starts_with('-');
        let starts_word = token.text.starts_with(' ') && !joins;
        match words.last_mut() {
            Some(word) if open && !starts_word => {
                word.text.push_str(text);
                if !text.chars().all(|c| c.is_ascii_punctuation()) {
                    word.end = token.end.min(token.start + TOKEN_REACH_SECONDS);
                }
            }
            _ => words.push(CaptionWord {
                text: text.to_string(),
                start: token.start,
                end: token.end.min(token.start + TOKEN_REACH_SECONDS),
            }),
        }
        open = true;
    }
    words
}

const HOP_SECONDS: f64 = 0.005;
const STATS_BLOCK_SECONDS: f64 = 1.0;
const STATS_SPAN_BLOCKS: usize = 5;
const SILENCE_ABOVE_FLOOR_DB: f32 = 8.0;
const SILENCE_BELOW_PEAK_DB: f32 = 45.0;
const MAX_RUN_EXTENSION_SECONDS: f64 = 2.0;

pub(super) struct Loudness {
    rate: f64,
    levels: Vec<f32>,
    silence_below: Vec<f32>,
}

impl Loudness {
    pub fn new(samples: &[f32], rate: u32) -> Self {
        Self::with_thresholds(samples, rate, SILENCE_ABOVE_FLOOR_DB, SILENCE_BELOW_PEAK_DB)
    }

    pub fn with_thresholds(
        samples: &[f32],
        rate: u32,
        above_floor_db: f32,
        below_peak_db: f32,
    ) -> Self {
        let hop = ((f64::from(rate) * HOP_SECONDS) as usize).max(1);
        let frames = samples.len().div_ceil(hop);
        let levels: Vec<f32> = (0..frames)
            .map(|frame| {
                let centre = frame * hop;
                let window =
                    &samples[centre.saturating_sub(hop)..(centre + hop).min(samples.len())];
                let power = window.iter().map(|s| s * s).sum::<f32>() / window.len().max(1) as f32;
                10.0 * (power + 1e-12).log10()
            })
            .collect();
        let per_block = (STATS_BLOCK_SECONDS / HOP_SECONDS) as usize;
        let blocks = levels.len().div_ceil(per_block).max(1);
        let silence_below = (0..blocks)
            .map(|block| {
                let first = block.saturating_sub(STATS_SPAN_BLOCKS) * per_block;
                let last = ((block + STATS_SPAN_BLOCKS + 1) * per_block).min(levels.len());
                let mut window: Vec<f32> = levels.get(first..last).unwrap_or_default().to_vec();
                if window.is_empty() {
                    return f32::NEG_INFINITY;
                }
                window.sort_by(f32::total_cmp);
                let at = |q: f32| window[((window.len() - 1) as f32 * q) as usize];
                (at(0.1) + above_floor_db).max(at(0.95) - below_peak_db)
            })
            .collect();
        Self {
            rate: 1.0 / HOP_SECONDS,
            levels,
            silence_below,
        }
    }

    pub fn duration(&self) -> f64 {
        self.seconds(self.levels.len())
    }

    fn frame(&self, seconds: f64) -> usize {
        ((seconds * self.rate).round().max(0.0) as usize).min(self.levels.len())
    }

    fn seconds(&self, frame: usize) -> f64 {
        frame as f64 / self.rate
    }

    fn silent(&self, frame: usize) -> bool {
        let block = (frame as f64 / (STATS_BLOCK_SECONDS * self.rate)) as usize;
        let threshold = self
            .silence_below
            .get(block.min(self.silence_below.len().saturating_sub(1)))
            .copied()
            .unwrap_or(f32::NEG_INFINITY);
        self.levels
            .get(frame)
            .is_some_and(|level| *level < threshold)
    }

    pub fn silent_runs(&self, from: f64, to: f64, min_seconds: f64) -> Vec<(f64, f64)> {
        let (first, last) = (self.frame(from), self.frame(to));
        let min_frames = (min_seconds * self.rate).round().max(1.0) as usize;
        let reach = (MAX_RUN_EXTENSION_SECONDS * self.rate) as usize;
        let mut runs = Vec::new();
        let mut frame = first;
        while frame < last {
            if !self.silent(frame) {
                frame += 1;
                continue;
            }
            let mut start = frame;
            if frame == first {
                let floor = first.saturating_sub(reach);
                while start > floor && self.silent(start - 1) {
                    start -= 1;
                }
            }
            let ceiling = (last + reach).min(self.levels.len());
            while frame < ceiling && self.silent(frame) {
                frame += 1;
            }
            if frame - start >= min_frames {
                runs.push((self.seconds(start), self.seconds(frame)));
            }
        }
        runs
    }
}

const SPEECH_GAP_SECONDS: f64 = 0.12;
const WORD_MARGIN_SECONDS: f64 = 0.06;
const MIN_UNHEARD_SECONDS: f64 = 0.2;
const MAX_OVERLAP_SECONDS: f32 = 0.05;

/// Stretches of sound no word accounts for: a filler the model dropped, or a
/// run of speech a decode lost. Each comes back padded by the silence around
/// it, ready to decode on its own.
pub(super) fn uncovered_speech(words: &[CaptionWord], loudness: &Loudness) -> Vec<(f64, f64)> {
    let duration = loudness.duration();
    let silences = loudness.silent_runs(0.0, duration, SPEECH_GAP_SECONDS);
    let mut speech = Vec::new();
    let mut cursor = 0.0;
    for (start, end) in silences
        .iter()
        .copied()
        .chain(std::iter::once((duration, duration)))
    {
        if start > cursor {
            speech.push((cursor, start));
        }
        cursor = cursor.max(end);
    }
    let mut covered: Vec<(f64, f64)> = words
        .iter()
        .map(|word| {
            (
                f64::from(word.start) - WORD_MARGIN_SECONDS,
                f64::from(word.end.max(word.start)) + WORD_MARGIN_SECONDS,
            )
        })
        .collect();
    covered.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut reach = Vec::with_capacity(covered.len());
    let mut furthest = f64::NEG_INFINITY;
    for &(_, to) in &covered {
        furthest = furthest.max(to);
        reach.push(furthest);
    }
    let mut unheard = Vec::new();
    for (start, end) in speech {
        let mut cursor = start;
        let mut index = reach.partition_point(|to| *to <= start);
        while index < covered.len() && covered[index].0 < end {
            let (from, to) = covered[index];
            if to > start {
                if from > cursor {
                    unheard.push((cursor, from.min(end)));
                }
                cursor = cursor.max(to);
            }
            index += 1;
        }
        if cursor < end {
            unheard.push((cursor, end));
        }
    }
    unheard.retain(|(start, end)| end - start >= MIN_UNHEARD_SECONDS);
    unheard
}

/// Below this a stretch of unheard sound is more often a breath, a click or
/// someone else in the room than lost words, so only a voiced hesitation
/// filler is taken from it.
const WHOLE_SPEECH_SECONDS: f64 = 1.0;
const MIN_VOICED_FRACTION: f64 = 0.4;

pub(super) fn span_voicing(samples: &[f32], rate: u32, span: (f64, f64)) -> Option<f64> {
    if span.1 - span.0 >= WHOLE_SPEECH_SECONDS {
        return Some(1.0);
    }
    let voiced = voiced_fraction(samples, rate, span);
    (voiced >= MIN_VOICED_FRACTION).then_some(voiced)
}

fn worth_redecoding(span: (f64, f64), voiced_fraction: f64) -> bool {
    span.1 - span.0 >= WHOLE_SPEECH_SECONDS || voiced_fraction >= MIN_VOICED_FRACTION
}

pub(super) fn insert_recovered(
    words: &mut Vec<CaptionWord>,
    found: Vec<CaptionWord>,
    span: (f64, f64),
    voiced_fraction: f64,
) {
    if !worth_redecoding(span, voiced_fraction) {
        return;
    }
    let short = span.1 - span.0 < WHOLE_SPEECH_SECONDS;
    for word in found {
        if short && !cap_project::disfluency::is_hesitation_filler(&word.text) {
            continue;
        }
        let middle = f64::from(word.start + word.end.max(word.start)) / 2.0;
        if middle < span.0 - WORD_MARGIN_SECONDS || middle > span.1 + WORD_MARGIN_SECONDS {
            continue;
        }
        let at = words.partition_point(|existing| existing.start <= word.start);
        let overlaps = |existing: &CaptionWord| {
            existing.end.min(word.end) - existing.start.max(word.start) > MAX_OVERLAP_SECONDS
        };
        if at
            .checked_sub(1)
            .is_some_and(|before| overlaps(&words[before]))
            || words.get(at).is_some_and(overlaps)
        {
            continue;
        }
        words.insert(at, word);
    }
}

/// The share of a span's audible 40 ms frames that are periodic: hesitations
/// are voiced, breaths and clicks are not.
pub(super) fn voiced_fraction(samples: &[f32], rate: u32, span: (f64, f64)) -> f64 {
    let rate_f = f64::from(rate);
    let first = ((span.0 * rate_f).max(0.0) as usize).min(samples.len());
    let last = ((span.1 * rate_f).max(0.0) as usize).min(samples.len());
    let audio = &samples[first..last];
    let frame = (rate / 25) as usize;
    let hop = (rate / 100) as usize;
    let (min_lag, max_lag) = ((rate / 400) as usize, (rate / 60) as usize);
    if frame == 0 || hop == 0 || audio.len() < frame + max_lag {
        return 0.0;
    }
    let peak = audio.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
    let mut audible = 0usize;
    let mut voiced = 0usize;
    let mut start = 0;
    while start + frame + max_lag <= audio.len() {
        let window = &audio[start..start + frame];
        let energy: f32 = window.iter().map(|s| s * s).sum();
        if energy.sqrt() / (frame as f32).sqrt() > peak * 0.05 {
            audible += 1;
            let best = (min_lag..=max_lag)
                .map(|lag| {
                    let shifted = &audio[start + lag..start + lag + frame];
                    let cross: f32 = window.iter().zip(shifted).map(|(a, b)| a * b).sum();
                    let shifted_energy: f32 = shifted.iter().map(|s| s * s).sum();
                    cross / (energy * shifted_energy).sqrt().max(1e-9)
                })
                .fold(f32::NEG_INFINITY, f32::max);
            if best > 0.6 {
                voiced += 1;
            }
        }
        start += hop;
    }
    if audible == 0 {
        0.0
    } else {
        voiced as f64 / audible as f64
    }
}

/// Whisper writes a stutter as one hyphenated word ("I-I", "the-the"). Each
/// repeat becomes its own word so it can be cut on its own; the span is shared
/// out evenly until alignment times them.
pub(super) fn split_stutters(words: Vec<CaptionWord>) -> Vec<CaptionWord> {
    let mut out = Vec::with_capacity(words.len());
    for word in words {
        let body = word.text.trim_end_matches(|c: char| !c.is_alphanumeric());
        let tail = &word.text[body.len()..];
        let parts: Vec<&str> = body.split('-').collect();
        let alphabetic = parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(char::is_alphabetic));
        let repeats = parts
            .iter()
            .take_while(|part| part.to_lowercase() == parts[0].to_lowercase())
            .count();
        if !alphabetic || repeats < 2 {
            out.push(word);
            continue;
        }
        let mut pieces: Vec<String> = parts[..repeats]
            .iter()
            .map(|part| (*part).to_string())
            .collect();
        if repeats < parts.len() {
            pieces.push(parts[repeats..].join("-"));
        }
        let step = (word.end - word.start).max(0.0) / pieces.len() as f32;
        let last = pieces.len() - 1;
        for (index, piece) in pieces.into_iter().enumerate() {
            out.push(CaptionWord {
                text: if index == last {
                    format!("{piece}{tail}")
                } else {
                    piece
                },
                start: word.start + step * index as f32,
                end: word.start + step * (index + 1) as f32,
            });
        }
    }
    out
}

#[derive(Debug, Clone, Copy)]
pub(super) struct SnapSettings {
    pub above_floor_db: f32,
    pub below_peak_db: f32,
    pub search: f64,
    pub end_search: f64,
    pub outer_search: f64,
    pub min_pause: f64,
    pub min_word: f64,
}

pub(super) const SNAP: SnapSettings = SnapSettings {
    above_floor_db: SILENCE_ABOVE_FLOOR_DB,
    below_peak_db: SILENCE_BELOW_PEAK_DB,
    search: 0.1,
    end_search: 0.45,
    outer_search: 0.4,
    min_pause: 0.03,
    min_word: 0.04,
};

const EDGE_SLACK_SECONDS: f64 = 0.02;

pub(super) fn snap_to_pauses(
    words: &mut [CaptionWord],
    loudness: &Loudness,
    settings: SnapSettings,
) {
    for index in 0..=words.len() {
        let (left, right) = words.split_at_mut(index);
        match (left.last_mut(), right.first_mut()) {
            (Some(before), Some(after)) => {
                let (end, start) = (f64::from(before.end), f64::from(after.start));
                let lower = f64::from(before.start) + settings.min_word;
                let upper = f64::from(after.end) - settings.min_word;
                let after_end = loudness
                    .silent_runs(
                        (end - EDGE_SLACK_SECONDS).max(lower),
                        (end + settings.end_search).min(start.max(end)),
                        settings.min_pause,
                    )
                    .into_iter()
                    .next();
                if let Some((silence_start, _)) = after_end {
                    before.end = silence_start.clamp(lower, upper.max(lower)) as f32;
                }
                let before_start = loudness
                    .silent_runs(
                        (start - settings.search).max(f64::from(before.end)),
                        (start + EDGE_SLACK_SECONDS).min(upper),
                        settings.min_pause,
                    )
                    .into_iter()
                    .last();
                if let Some((_, silence_end)) = before_start {
                    after.start = silence_end.clamp(f64::from(before.end), upper.max(lower)) as f32;
                }
                if after.start < before.end {
                    after.start = before.end;
                }
            }
            (None, Some(first)) => {
                let start = f64::from(first.start);
                let from = start - settings.outer_search;
                let to = (start + settings.search).min(f64::from(first.end) - settings.min_word);
                if let Some((_, silence_end)) =
                    loudness.silent_runs(from, to, settings.min_pause).last()
                {
                    first.start = silence_end.min(f64::from(first.end) - settings.min_word) as f32;
                }
            }
            (Some(last), None) => {
                let end = f64::from(last.end);
                let from = (end - settings.search).max(f64::from(last.start) + settings.min_word);
                let to = end + settings.outer_search;
                if let Some((silence_start, _)) =
                    loudness.silent_runs(from, to, settings.min_pause).first()
                {
                    last.end = silence_start.max(f64::from(last.start) + settings.min_word) as f32;
                }
            }
            (None, None) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(text: &str, start: f32, end: f32) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start,
            end,
        }
    }

    #[test]
    fn subword_tokens_join_into_words_and_keep_repeats() {
        let words = words_from_subword_tokens([
            token(" I", 0.0, 0.16),
            token(" I", 0.16, 0.4),
            token(" th", 0.4, 0.48),
            token("ink", 0.48, 0.64),
            token(",", 0.64, 0.72),
            token(" we", 0.72, 0.8),
            token("'re", 0.8, 0.96),
            token(" twenty", 0.96, 1.2),
            token("-two", 1.2, 1.4),
            token(" ", 1.4, 1.48),
            token("um", 1.48, 1.6),
        ]);
        let texts: Vec<_> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["I", "I", "think,", "we're", "twenty-two", "um"]);
        assert_eq!((words[2].start, words[2].end), (0.4, 0.64));
        assert!((words[1].end - 0.4).abs() < 1e-6);
        assert!(words_from_subword_tokens(Vec::new()).is_empty());
    }

    fn bursts(seconds: f64, spans: &[(f64, f64)], noise: f32) -> Vec<f32> {
        let rate = 16_000.0;
        let mut seed = 0x2545_f491_u32;
        (0..(seconds * rate) as usize)
            .map(|i| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                let hiss = (seed as f32 / u32::MAX as f32 - 0.5) * noise;
                let t = i as f64 / rate;
                let voiced = spans.iter().any(|(a, b)| t >= *a && t < *b);
                hiss + if voiced {
                    (t * 180.0 * std::f64::consts::TAU).sin() as f32 * 0.4
                } else {
                    0.0
                }
            })
            .collect()
    }

    fn word(text: &str, start: f32, end: f32) -> CaptionWord {
        token(text, start, end)
    }

    #[test]
    fn snapping_moves_boundaries_onto_the_pauses_around_a_filler() {
        let samples = bursts(4.0, &[(0.5, 1.0), (1.3, 1.8), (2.1, 2.6)], 0.002);
        let loudness = Loudness::new(&samples, 16_000);
        let mut words = vec![
            word("so", 0.42, 1.1),
            word("um", 1.1, 1.95),
            word("yes", 1.95, 2.75),
        ];
        snap_to_pauses(&mut words, &loudness, SNAP);
        let expected = [(0.5, 1.0), (1.3, 1.8), (2.1, 2.6)];
        for (word, (start, end)) in words.iter().zip(expected) {
            assert!((f64::from(word.start) - start).abs() <= 0.006, "{word:?}");
            assert!((f64::from(word.end) - end).abs() <= 0.006, "{word:?}");
        }
    }

    #[test]
    fn snapping_leaves_continuous_speech_and_short_closures_alone() {
        let samples = bursts(3.0, &[(0.5, 1.2), (1.215, 2.0)], 0.002);
        let loudness = Loudness::new(&samples, 16_000);
        let mut words = vec![word("one", 0.5, 1.0), word("two", 1.0, 2.0)];
        snap_to_pauses(&mut words, &loudness, SNAP);
        assert_eq!((words[0].end, words[1].start), (1.0, 1.0));
        assert!((words[0].start - 0.5).abs() <= 0.006);
        assert!((words[1].end - 2.0).abs() <= 0.006);
    }

    #[test]
    fn snapping_handles_silence_empty_input_and_one_word() {
        let silence = vec![0.0; 16_000];
        let loudness = Loudness::new(&silence, 16_000);
        let mut words = vec![word("hi", 0.2, 0.6)];
        snap_to_pauses(&mut words, &loudness, SNAP);
        assert!(words[0].start < words[0].end);
        snap_to_pauses(&mut [], &loudness, SNAP);
        let empty = Loudness::new(&[], 16_000);
        let mut words = vec![word("hi", 0.2, 0.6)];
        snap_to_pauses(&mut words, &empty, SNAP);
        assert_eq!((words[0].start, words[0].end), (0.2, 0.6));
    }

    #[test]
    fn loudness_threshold_follows_a_changing_noise_floor() {
        let mut samples = bursts(20.0, &[(2.0, 3.0), (15.0, 16.0)], 0.001);
        for (i, sample) in samples.iter_mut().enumerate().skip(10 * 16_000) {
            *sample += ((i as f32 * 0.37).sin()) * 0.02;
        }
        let loudness = Loudness::new(&samples, 16_000);
        assert_eq!(loudness.silent_runs(3.2, 4.0, 0.03).len(), 1);
        assert_eq!(loudness.silent_runs(16.2, 17.0, 0.03).len(), 1);
        assert!(loudness.silent_runs(2.2, 2.8, 0.03).is_empty());
        assert!(loudness.silent_runs(15.2, 15.8, 0.03).is_empty());
    }

    fn hum(seconds: f64, rate: u32, spans: &[(f64, f64)], periodic: bool) -> Vec<f32> {
        let mut seed = 0x9e37_79b9_u32;
        (0..(seconds * f64::from(rate)) as usize)
            .map(|i| {
                let t = i as f64 / f64::from(rate);
                if !spans.iter().any(|(a, b)| t >= *a && t < *b) {
                    return 0.0;
                }
                if periodic {
                    (t * 150.0 * std::f64::consts::TAU).sin() as f32 * 0.3
                } else {
                    seed ^= seed << 13;
                    seed ^= seed >> 17;
                    seed ^= seed << 5;
                    (seed as f32 / u32::MAX as f32 - 0.5) * 0.6
                }
            })
            .collect()
    }

    #[test]
    fn voicing_tells_a_hum_from_a_breath() {
        let voiced = hum(1.0, 16_000, &[(0.2, 0.8)], true);
        let breath = hum(1.0, 16_000, &[(0.2, 0.8)], false);
        assert!(voiced_fraction(&voiced, 16_000, (0.0, 1.0)) > 0.9);
        assert!(voiced_fraction(&breath, 16_000, (0.0, 1.0)) < 0.1);
        assert_eq!(voiced_fraction(&voiced, 16_000, (0.5, 0.51)), 0.0);
        assert_eq!(voiced_fraction(&[], 16_000, (0.0, 1.0)), 0.0);
    }

    #[test]
    fn unheard_speech_is_the_sound_no_word_covers() {
        let samples = bursts(
            6.0,
            &[(0.5, 1.0), (1.4, 1.9), (2.4, 2.9), (3.5, 5.5)],
            0.002,
        );
        let loudness = Loudness::new(&samples, 16_000);
        let words = vec![
            word("so", 0.5, 1.0),
            word("yes", 2.4, 2.9),
            word("we", 3.5, 3.9),
        ];
        let unheard = uncovered_speech(&words, &loudness);
        assert_eq!(unheard.len(), 2, "{unheard:?}");
        assert!((unheard[0].0 - 1.4).abs() < 0.02 && (unheard[0].1 - 1.9).abs() < 0.02);
        assert!((unheard[1].0 - 3.96).abs() < 0.02 && (unheard[1].1 - 5.5).abs() < 0.02);
        assert!(uncovered_speech(&[], &Loudness::new(&[], 16_000)).is_empty());
    }

    #[test]
    fn short_unheard_spans_only_give_back_voiced_fillers() {
        let mut words = vec![word("so", 0.5, 1.0), word("yes", 2.4, 2.9)];
        let found = vec![
            word("Yeah.", 1.45, 1.7),
            word("um,", 1.5, 1.85),
            word("so", 0.6, 0.9),
        ];
        insert_recovered(&mut words, found.clone(), (1.4, 1.9), 0.1);
        assert_eq!(words.len(), 2);
        insert_recovered(&mut words, found, (1.4, 1.9), 0.8);
        let texts: Vec<_> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["so", "um,", "yes"]);

        let mut heard = vec![word("Um", 0.56, 0.8), word("so", 1.3, 1.5)];
        insert_recovered(&mut heard, vec![word("Hmm.", 0.68, 1.16)], (0.86, 1.2), 0.9);
        let texts: Vec<_> = heard.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["Um", "so"]);

        let mut words = vec![word("so", 0.5, 1.0)];
        insert_recovered(
            &mut words,
            vec![
                word("we", 4.0, 4.2),
                word("lost", 4.3, 4.8),
                word("it", 9.0, 9.2),
            ],
            (3.96, 5.5),
            0.0,
        );
        let texts: Vec<_> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(texts, ["so", "we", "lost"]);
    }

    #[test]
    fn hyphenated_stutters_become_separate_words() {
        let words = split_stutters(vec![
            word("I-I", 1.0, 1.4),
            word("the-the-the,", 2.0, 2.6),
            word("re-record", 3.0, 3.5),
            word("mm-hmm.", 4.0, 4.4),
            word("so", 5.0, 5.2),
            word("we-we-start.", 6.0, 6.6),
        ]);
        let texts: Vec<_> = words.iter().map(|w| w.text.as_str()).collect();
        assert_eq!(
            texts,
            [
                "I",
                "I",
                "the",
                "the",
                "the,",
                "re-record",
                "mm-hmm.",
                "so",
                "we",
                "we",
                "start."
            ]
        );
        assert!((words[1].start - 1.2).abs() < 1e-6 && (words[1].end - 1.4).abs() < 1e-6);
        assert!((words[4].start - 2.4).abs() < 1e-5);
        assert!(split_stutters(Vec::new()).is_empty());
    }
}
