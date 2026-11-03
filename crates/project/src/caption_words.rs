use crate::CaptionWord;

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
pub fn caption_word_chunks(words: &[CaptionWord]) -> Vec<&[CaptionWord]> {
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < words.len() {
        let remaining = words.len() - start;
        if remaining <= TARGET_CAPTION_WORDS_PER_SEGMENT {
            chunks.push(&words[start..]);
            break;
        }

        let mut end = (start + TARGET_CAPTION_WORDS_PER_SEGMENT).min(words.len());
        while end < words.len()
            && caption_boundary_word_is_weak(&words[end - 1])
            && end - start < MAX_CAPTION_WORDS_PER_SEGMENT
        {
            end += 1;
        }

        let remaining_after = words.len() - end;
        if remaining_after > 0
            && remaining_after < MIN_FINAL_CAPTION_WORDS
            && caption_boundary_word_is_weak(&words[end])
        {
            end = words.len();
        }

        chunks.push(&words[start..end]);
        start = end;
    }

    chunks
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
}
