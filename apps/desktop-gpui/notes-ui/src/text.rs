pub(crate) use cap_notes::{next_grapheme, prev_grapheme};

pub(crate) fn word_start(text: &str, offset: usize) -> usize {
    cap_notes::prev_word(text, offset.min(text.len()))
}

pub(crate) fn word_end(text: &str, offset: usize) -> usize {
    cap_notes::next_word(text, offset.min(text.len()))
}

pub(crate) fn offset_from_utf16(text: &str, offset: usize) -> usize {
    let mut utf8 = 0;
    let mut utf16 = 0;
    for ch in text.chars() {
        if utf16 >= offset {
            break;
        }
        utf16 += ch.len_utf16();
        utf8 += ch.len_utf8();
    }
    utf8
}

pub(crate) fn offset_to_utf16(text: &str, offset: usize) -> usize {
    let mut utf16 = 0;
    let mut utf8 = 0;
    for ch in text.chars() {
        if utf8 >= offset {
            break;
        }
        utf8 += ch.len_utf8();
        utf16 += ch.len_utf16();
    }
    utf16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_round_trip_through_astral_characters() {
        let text = "a😀b";
        assert_eq!(offset_to_utf16(text, 5), 3);
        assert_eq!(offset_from_utf16(text, 3), 5);
        assert_eq!(offset_from_utf16(text, 4), 6);
        assert_eq!(offset_to_utf16(text, 6), 4);
    }
}
