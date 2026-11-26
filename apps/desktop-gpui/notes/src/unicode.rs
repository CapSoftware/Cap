use std::ops::Range;

use unicode_segmentation::{GraphemeCursor, UnicodeSegmentation};

pub(crate) fn floor_char(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

pub fn is_grapheme_boundary(text: &str, offset: usize) -> bool {
    if offset > text.len() || !text.is_char_boundary(offset) {
        return false;
    }
    let mut cursor = GraphemeCursor::new(offset, text.len(), true);
    cursor.is_boundary(text, 0).unwrap_or(true)
}

pub fn clamp_to_grapheme(text: &str, offset: usize) -> usize {
    let offset = floor_char(text, offset);
    if is_grapheme_boundary(text, offset) {
        offset
    } else {
        prev_grapheme(text, offset)
    }
}

pub fn prev_grapheme(text: &str, offset: usize) -> usize {
    let offset = floor_char(text, offset);
    if offset == 0 {
        return 0;
    }
    let mut cursor = GraphemeCursor::new(offset, text.len(), true);
    match cursor.prev_boundary(text, 0) {
        Ok(Some(prev)) => prev,
        Ok(None) => 0,
        Err(_) => floor_char(text, offset - 1),
    }
}

pub fn next_grapheme(text: &str, offset: usize) -> usize {
    let offset = floor_char(text, offset);
    if offset >= text.len() {
        return text.len();
    }
    let mut cursor = GraphemeCursor::new(offset, text.len(), true);
    match cursor.next_boundary(text, 0) {
        Ok(Some(next)) => next,
        Ok(None) => text.len(),
        Err(_) => {
            let mut next = offset + 1;
            while !text.is_char_boundary(next) {
                next += 1;
            }
            next
        }
    }
}

fn is_wordlike(segment: &str) -> bool {
    segment.chars().any(char::is_alphanumeric)
}

pub fn next_word(text: &str, offset: usize) -> usize {
    let offset = clamp_to_grapheme(text, offset);
    for (start, segment) in text.split_word_bound_indices() {
        let end = start + segment.len();
        if end > offset && is_wordlike(segment) {
            return end;
        }
    }
    text.len()
}

pub fn prev_word(text: &str, offset: usize) -> usize {
    let offset = clamp_to_grapheme(text, offset);
    let mut result = 0;
    for (start, segment) in text.split_word_bound_indices() {
        if start >= offset {
            break;
        }
        if is_wordlike(segment) {
            result = start;
        }
    }
    result
}

pub fn word_range_at(text: &str, offset: usize) -> Range<usize> {
    let offset = clamp_to_grapheme(text, offset);
    let mut previous: Option<Range<usize>> = None;
    for (start, segment) in text.split_word_bound_indices() {
        let range = start..start + segment.len();
        if offset < range.end {
            if offset == range.start
                && !is_wordlike(segment)
                && let Some(prev) = previous.filter(|prev| is_wordlike(&text[prev.clone()]))
            {
                return prev;
            }
            return range;
        }
        previous = Some(range);
    }
    previous.unwrap_or(offset..offset)
}
