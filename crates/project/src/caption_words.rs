use std::borrow::Cow;

use crate::{CaptionTrackSegment, CaptionWord, disfluency::is_hesitation_filler};

/// Whisper/Parakeet sometimes stretch a trailing word's end across a following
/// silence (e.g. a 16s "seconds."), which leaves the rendered caption stuck on
/// screen and duplicates the word across timeline cuts once projected. Real
/// spoken words never approach this, so cap each word's duration to keep timing
/// tied to speech rather than silence.
pub const MAX_CAPTION_WORD_DURATION: f32 = 2.5;
pub const TARGET_CAPTION_WORDS_PER_SEGMENT: usize = 6;
pub const MAX_CAPTION_WORDS_PER_SEGMENT: usize = 8;
pub const MIN_FINAL_CAPTION_WORDS: usize = 3;

fn caption_char_attaches_to_previous(value: char) -> bool {
    matches!(
        value,
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
}

fn caption_token_attaches_to_previous(text: &str) -> bool {
    text.trim()
        .chars()
        .next()
        .is_some_and(caption_char_attaches_to_previous)
}

/// A caption segment should not end on a one letter word or a short connector
/// when more words follow, since that reads badly on screen. Comparing
/// `chars().count()` matters: a byte length check counts non-ASCII letters like
/// "à" as two and treats them as strong boundary words.
pub fn caption_boundary_word_is_weak(word: &CaptionWord) -> bool {
    let normalized = word
        .text
        .trim()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect::<String>()
        .to_lowercase();

    normalized.chars().count() <= 1
        || matches!(
            normalized.as_str(),
            "an" | "as"
                | "at"
                | "be"
                | "by"
                | "do"
                | "he"
                | "if"
                | "in"
                | "is"
                | "it"
                | "me"
                | "my"
                | "of"
                | "on"
                | "or"
                | "so"
                | "to"
                | "up"
                | "we"
        )
}

pub fn normalize_caption_words(words: Vec<CaptionWord>) -> Vec<CaptionWord> {
    let mut normalized: Vec<CaptionWord> = Vec::with_capacity(words.len());

    for word in words {
        let text = word.text.trim();
        if text.is_empty() {
            continue;
        }

        if caption_token_attaches_to_previous(text)
            && let Some(previous) = normalized.last_mut()
        {
            previous.text.push_str(text);
            previous.end = word.end;
        } else {
            normalized.push(CaptionWord {
                text: text.to_string(),
                start: word.start,
                end: word.end,
            });
        }
    }

    for word in &mut normalized {
        word.end = word.end.min(word.start + MAX_CAPTION_WORD_DURATION);
    }

    normalized
}

pub fn caption_text_from_words<'a>(words: impl IntoIterator<Item = &'a CaptionWord>) -> String {
    let mut text = String::new();

    for word in words {
        let word_text = word.text.trim();
        if word_text.is_empty() {
            continue;
        }

        if !text.is_empty() && !caption_token_attaches_to_previous(word_text) {
            text.push(' ');
        }
        text.push_str(word_text);
    }

    text
}

/// Groups normalized words into caption segments aiming for
/// [`TARGET_CAPTION_WORDS_PER_SEGMENT`] words. The boundary word may move past
/// the target, up to [`MAX_CAPTION_WORDS_PER_SEGMENT`], to avoid ending on a
/// weak word, and a trailing fragment shorter than [`MIN_FINAL_CAPTION_WORDS`]
/// merges into the previous segment when it starts with a weak word, which can
/// put the merged segment over the max.
///
/// Hesitation fillers do not count towards those sizes and open the segment
/// after them, so with fillers hidden from display the captions break exactly
/// where a transcript without them would.
pub fn caption_word_chunks(words: &[CaptionWord]) -> Vec<&[CaptionWord]> {
    let spoken: Vec<usize> = words
        .iter()
        .enumerate()
        .filter(|(_, word)| !is_hesitation_filler(&word.text))
        .map(|(index, _)| index)
        .collect();
    if spoken.is_empty() {
        return chunk_spans(words.len(), |index| {
            caption_boundary_word_is_weak(&words[index])
        })
        .into_iter()
        .map(|range| &words[range])
        .collect();
    }
    let spans = chunk_spans(spoken.len(), |index| {
        caption_boundary_word_is_weak(&words[spoken[index]])
    });
    let last = spans.len() - 1;
    let mut start = 0;
    spans
        .into_iter()
        .enumerate()
        .map(|(chunk, range)| {
            let end = if chunk == last {
                words.len()
            } else {
                spoken[range.end - 1] + 1
            };
            let slice = &words[start..end];
            start = end;
            slice
        })
        .collect()
}

fn chunk_spans(len: usize, weak: impl Fn(usize) -> bool) -> Vec<std::ops::Range<usize>> {
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < len {
        let remaining = len - start;
        if remaining <= TARGET_CAPTION_WORDS_PER_SEGMENT {
            chunks.push(start..len);
            break;
        }

        let mut end = (start + TARGET_CAPTION_WORDS_PER_SEGMENT).min(len);
        while end < len && weak(end - 1) && end - start < MAX_CAPTION_WORDS_PER_SEGMENT {
            end += 1;
        }

        let remaining_after = len - end;
        if remaining_after > 0 && remaining_after < MIN_FINAL_CAPTION_WORDS && weak(end) {
            end = len;
        }

        chunks.push(start..end);
        start = end;
    }

    chunks
}

/// The caption as it should be drawn: with `show_fillers` off, hesitation
/// fillers leave its words and text, and a filler at either edge no longer
/// holds the caption on screen. `None` when nothing but fillers is left.
pub fn caption_display_segment(
    segment: &CaptionTrackSegment,
    show_fillers: bool,
) -> Option<Cow<'_, CaptionTrackSegment>> {
    if show_fillers
        || (!segment
            .words
            .iter()
            .any(|word| is_hesitation_filler(&word.text))
            && !segment.text.split_whitespace().any(is_hesitation_filler))
    {
        return Some(Cow::Borrowed(segment));
    }
    let words: Vec<CaptionWord> = segment
        .words
        .iter()
        .filter(|word| !is_hesitation_filler(&word.text))
        .cloned()
        .collect();
    let text_follows_words = segment
        .text
        .split_whitespace()
        .eq(caption_text_from_words(&segment.words).split_whitespace());
    let text = if text_follows_words {
        caption_text_from_words(&words)
    } else {
        segment
            .text
            .split_whitespace()
            .filter(|token| !is_hesitation_filler(token))
            .collect::<Vec<_>>()
            .join(" ")
    };
    if text.is_empty() {
        return None;
    }
    let mut start = segment.start;
    let mut end = segment.end;
    if let (Some(first), Some(last)) = (words.first(), words.last()) {
        if segment
            .words
            .first()
            .is_some_and(|word| is_hesitation_filler(&word.text))
        {
            start = start.max(f64::from(first.start));
        }
        if segment
            .words
            .last()
            .is_some_and(|word| is_hesitation_filler(&word.text))
        {
            end = end.min(f64::from(last.end)).max(start);
        }
    }
    Some(Cow::Owned(CaptionTrackSegment {
        start,
        end,
        text,
        words,
        ..segment.clone()
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(text: &str, index: usize) -> CaptionWord {
        CaptionWord {
            text: text.to_string(),
            start: index as f32,
            end: index as f32 + 0.5,
        }
    }

    #[test]
    fn normalize_caption_words_attaches_punctuation() {
        let words = normalize_caption_words(vec![
            word("test", 0),
            word(",", 1),
            word("test", 2),
            word(".", 3),
        ]);

        assert_eq!(caption_text_from_words(&words), "test, test.");
        assert_eq!(words.len(), 2);
    }

    #[test]
    fn normalize_caption_words_clamps_inflated_trailing_word() {
        let words = normalize_caption_words(vec![CaptionWord {
            text: "seconds.".to_string(),
            start: 53.92,
            end: 70.16,
        }]);

        assert_eq!(words.len(), 1);
        assert!((words[0].end - (53.92 + MAX_CAPTION_WORD_DURATION)).abs() < 1e-4);
    }

    #[test]
    fn normalize_caption_words_keeps_normal_word_durations() {
        let words = normalize_caption_words(vec![CaptionWord {
            text: "hello".to_string(),
            start: 1.0,
            end: 1.4,
        }]);

        assert_eq!(words.len(), 1);
        assert!((words[0].end - 1.4).abs() < 1e-4);
    }

    #[test]
    fn caption_word_chunks_do_not_end_on_short_connector_when_more_words_follow() {
        for connector in ["I", "à", "à,", "a\u{300}", "日"] {
            let words = [
                "This", "is", "where", "we", "record", connector, "want", "clean", "captions",
            ]
            .iter()
            .enumerate()
            .map(|(index, text)| word(text, index))
            .collect::<Vec<_>>();

            let chunks = caption_word_chunks(&words);

            assert_eq!(
                caption_text_from_words(chunks[0]),
                format!("This is where we record {connector} want"),
                "connector {connector}"
            );
            assert_eq!(caption_text_from_words(chunks[1]), "clean captions");
        }
    }

    #[test]
    fn caption_word_chunks_merge_short_tail_starting_with_connector() {
        for connector in ["I", "à", "à,", "a\u{300}", "日"] {
            let words = [
                "These", "captions", "should", "stay", "grouped", "together", connector, "Paris",
            ]
            .iter()
            .enumerate()
            .map(|(index, text)| word(text, index))
            .collect::<Vec<_>>();

            let chunks = caption_word_chunks(&words);

            assert_eq!(chunks.len(), 1, "connector {connector}");
            assert_eq!(
                caption_text_from_words(chunks[0]),
                format!("These captions should stay grouped together {connector} Paris")
            );
        }
    }

    #[test]
    fn caption_word_chunks_target_size_groups_strong_boundaries() {
        let words = (0..12)
            .map(|index| word(&format!("w{index}"), index))
            .collect::<Vec<_>>();

        let chunks = caption_word_chunks(&words);

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 6);
        assert_eq!(chunks[1].len(), 6);
    }

    fn words(texts: &[&str]) -> Vec<CaptionWord> {
        texts
            .iter()
            .enumerate()
            .map(|(index, text)| word(text, index))
            .collect()
    }

    fn texts<'a>(chunks: &[&'a [CaptionWord]]) -> Vec<Vec<&'a str>> {
        chunks
            .iter()
            .map(|chunk| chunk.iter().map(|word| word.text.as_str()).collect())
            .collect()
    }

    #[test]
    fn caption_word_chunks_do_not_count_fillers() {
        let plain = words(&[
            "So",
            "I",
            "think",
            "we",
            "should",
            "start",
            "with",
            "the",
            "dashboard",
            "today",
            "please",
            "now",
        ]);
        let verbatim = words(&[
            "So,",
            "um,",
            "I",
            "think",
            "we",
            "should,",
            "uh,",
            "start",
            "with",
            "the",
            "dashboard",
            "today",
            "please",
            "now",
        ]);

        assert_eq!(
            texts(&caption_word_chunks(&verbatim)),
            vec![
                vec!["So,", "um,", "I", "think", "we", "should,", "uh,", "start"],
                vec!["with", "the", "dashboard", "today", "please", "now"],
            ]
        );
        let spoken = |chunks: Vec<&[CaptionWord]>| {
            chunks
                .iter()
                .map(|chunk| {
                    chunk
                        .iter()
                        .filter(|word| !is_hesitation_filler(&word.text))
                        .count()
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(
            spoken(caption_word_chunks(&verbatim)),
            spoken(caption_word_chunks(&plain))
        );
    }

    #[test]
    fn caption_word_chunks_keep_trailing_and_all_filler_runs() {
        let tail = words(&["one", "two", "three", "four", "five", "six", "seven", "um"]);
        let chunks = caption_word_chunks(&tail);
        assert_eq!(chunks.concat().len(), tail.len());
        assert_eq!(chunks.last().unwrap().last().unwrap().text, "um");

        let fillers = words(&["um", "uh", "hmm", "um", "uh", "er", "ah", "mm"]);
        let chunks = caption_word_chunks(&fillers);
        assert_eq!(chunks.concat().len(), fillers.len());
        assert_eq!(chunks.len(), 2);

        assert!(caption_word_chunks(&[]).is_empty());
    }

    fn track(text: &str, words: &[(&str, f32, f32)]) -> CaptionTrackSegment {
        CaptionTrackSegment {
            id: "caption".into(),
            start: f64::from(words.first().map_or(0.0, |w| w.1)),
            end: f64::from(words.last().map_or(1.0, |w| w.2)),
            text: text.into(),
            words: words
                .iter()
                .map(|(text, start, end)| CaptionWord {
                    text: (*text).into(),
                    start: *start,
                    end: *end,
                })
                .collect(),
            fade_duration_override: Some(0.3),
            linger_duration_override: None,
            position_override: None,
            color_override: None,
            background_color_override: None,
            font_size_override: Some(40),
        }
    }

    #[test]
    fn display_hides_fillers_and_trims_edges() {
        let segment = track(
            "Um, so I, uh, think um",
            &[
                ("Um,", 1.0, 1.4),
                ("so", 1.6, 1.8),
                ("I,", 1.8, 1.9),
                ("uh,", 2.0, 2.3),
                ("think", 2.4, 2.7),
                ("um", 2.8, 3.2),
            ],
        );

        let shown = caption_display_segment(&segment, false).unwrap();
        assert_eq!(shown.text, "so I, think");
        assert_eq!(
            shown
                .words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>(),
            ["so", "I,", "think"]
        );
        assert!((shown.start - 1.6).abs() < 1e-6);
        assert!((shown.end - 2.7).abs() < 1e-6);
        assert_eq!(shown.font_size_override, Some(40));
        assert_eq!(shown.fade_duration_override, Some(0.3));

        let verbatim = caption_display_segment(&segment, true).unwrap();
        assert!(matches!(verbatim, Cow::Borrowed(_)));
        assert_eq!(verbatim.text, segment.text);
    }

    #[test]
    fn display_keeps_plain_captions_borrowed_and_drops_filler_only_ones() {
        let plain = track(
            "so I think",
            &[("so", 1.0, 1.2), ("I", 1.2, 1.3), ("think", 1.3, 1.6)],
        );
        assert!(matches!(
            caption_display_segment(&plain, false),
            Some(Cow::Borrowed(_))
        ));
        let fillers = track("Um, uh.", &[("Um,", 1.0, 1.4), ("uh.", 1.5, 1.9)]);
        assert!(caption_display_segment(&fillers, false).is_none());
        assert!(caption_display_segment(&fillers, true).is_some());
    }

    #[test]
    fn display_filters_edited_text_and_wordless_captions() {
        let edited = track(
            "Um we ship today",
            &[("um", 1.0, 1.3), ("we", 1.4, 1.6), ("ship", 1.6, 2.0)],
        );
        let shown = caption_display_segment(&edited, false).unwrap();
        assert_eq!(shown.text, "we ship today");
        assert_eq!(shown.words.len(), 2);

        let mut wordless = track("hmm okay then", &[]);
        wordless.start = 4.0;
        wordless.end = 6.0;
        let shown = caption_display_segment(&wordless, false).unwrap();
        assert_eq!(shown.text, "okay then");
        assert_eq!((shown.start, shown.end), (4.0, 6.0));
    }
}
