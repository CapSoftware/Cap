use cap_project::caption_words::caption_text_from_words;
use cap_project::disfluency::normalize_word;
use cap_project::{CaptionWord, CaptionsData};

use super::model::{Word, word_sources};

/// How far a word may have moved, by a refinement landing while it was being
/// edited, and still be found again by its text.
const LOCATE_WINDOW: f64 = 1.0;

fn is_spoken(text: &str) -> bool {
    !normalize_word(text).is_empty()
}

/// Rewrites transcript word `word` as `text` in the source-time captions.
///
/// The word keeps the time it is spoken at, so it stays cut or kept exactly as
/// before and the captions, the export and later word cuts all see the new
/// spelling at the same moment. A replacement with as many spoken words as the
/// original keeps each one's own timing; any other count shares the word's
/// span evenly. Empty text drops the word from the captions only: the video is
/// never cut by an edit. `false` when nothing changed.
pub fn replace_word(captions: &mut CaptionsData, word: usize, text: &str) -> bool {
    let (words, sources) = word_sources(captions);
    let (Some(current), Some(members)) = (words.get(word), sources.get(word)) else {
        return false;
    };
    let tokens: Vec<&str> = text.split_whitespace().collect();
    if tokens.join(" ") == current.text {
        return false;
    }
    let spoken: Vec<(f32, f32)> = members
        .iter()
        .map(|&(segment, index)| &captions.segments[segment].words[index])
        .filter(|word| is_spoken(&word.text))
        .map(|word| (word.start, word.end.max(word.start)))
        .collect();
    let Some(&(start, _)) = spoken.first() else {
        return false;
    };
    let end = spoken.iter().fold(start, |end, span| end.max(span.1));
    let replacements = retime(&tokens, &spoken, start, end);

    let mut removing = members.clone();
    removing.sort_unstable();
    let (head_segment, head_index) = members[0];
    let insert_at = head_index
        - removing
            .iter()
            .filter(|&&(segment, index)| segment == head_segment && index < head_index)
            .count();
    for &(segment, index) in removing.iter().rev() {
        captions.segments[segment].words.remove(index);
    }
    captions.segments[head_segment]
        .words
        .splice(insert_at..insert_at, replacements);

    let mut touched: Vec<usize> = removing.iter().map(|(segment, _)| *segment).collect();
    touched.dedup();
    for &segment in &touched {
        let segment = &mut captions.segments[segment];
        segment.text = caption_text_from_words(&segment.words);
    }
    for &segment in touched.iter().rev() {
        if captions.segments[segment].words.is_empty() {
            captions.segments.remove(segment);
        }
    }
    true
}

/// Times each token. Punctuation and other unspoken tokens share the span of
/// the spoken token they sit beside, so the transcript folds them back into
/// it and its span is unchanged.
fn retime(tokens: &[&str], spoken: &[(f32, f32)], start: f32, end: f32) -> Vec<CaptionWord> {
    let spoken_tokens = tokens.iter().filter(|token| is_spoken(token)).count();
    let spans: Vec<(f32, f32)> = if spoken_tokens == spoken.len() {
        spoken.to_vec()
    } else {
        let parts = spoken_tokens.max(1);
        let (from, until) = (f64::from(start), f64::from(end));
        let step = (until - from) / parts as f64;
        (0..parts)
            .map(|part| {
                let part_end = if part + 1 == parts {
                    end
                } else {
                    (from + step * (part + 1) as f64) as f32
                };
                ((from + step * part as f64) as f32, part_end)
            })
            .collect()
    };
    let mut unit = 0;
    let mut seen_spoken = false;
    tokens
        .iter()
        .map(|token| {
            if is_spoken(token) {
                if seen_spoken {
                    unit += 1;
                }
                seen_spoken = true;
            }
            let (start, end) = spans[unit.min(spans.len() - 1)];
            CaptionWord {
                text: (*token).to_string(),
                start,
                end,
            }
        })
        .collect()
}

/// Finds a word again after the transcript was rebuilt under it: at `hint`
/// when nothing moved, otherwise the nearest word with the same text.
pub fn locate(words: &[Word], hint: usize, text: &str, start: f64) -> Option<usize> {
    if words
        .get(hint)
        .is_some_and(|word| word.text == text && (word.start - start).abs() < 1e-6)
    {
        return Some(hint);
    }
    let from = words.partition_point(|word| word.start < start - LOCATE_WINDOW);
    words[from..]
        .iter()
        .take_while(|word| word.start <= start + LOCATE_WINDOW)
        .enumerate()
        .filter(|(_, word)| word.text == text)
        .min_by(|a, b| {
            (a.1.start - start)
                .abs()
                .total_cmp(&(b.1.start - start).abs())
        })
        .map(|(offset, _)| from + offset)
}
