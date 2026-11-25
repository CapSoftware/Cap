use unicode_segmentation::UnicodeSegmentation;

pub(crate) fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(single), None) => single,
        _ => c,
    }
}

pub(crate) fn fold_query(query: &str) -> Vec<char> {
    search_units(query.trim())
        .into_iter()
        .map(|u| u.2)
        .collect()
}

/// Where `needle` (from [`fold_query`]) is in `haystack`, as a byte range of
/// the original text. Case, accents and combining marks never matter, and
/// "ss" finds "ß", so "jose" finds "José" as it does in the Library.
pub(crate) fn find_ci(haystack: &str, needle: &[char]) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    let units = search_units(haystack);
    if units.len() < needle.len() {
        return None;
    }
    (0..=units.len() - needle.len()).find_map(|i| {
        let hit = units[i..i + needle.len()]
            .iter()
            .zip(needle)
            .all(|(unit, n)| unit.2 == *n);
        hit.then(|| {
            let last = units[i + needle.len() - 1].1;
            // Accents written as separate marks after the last letter belong
            // to the hit.
            let end = match units.get(i + needle.len()) {
                Some(next) => next.0.max(last),
                None => haystack.len(),
            };
            (units[i].0, end)
        })
    })
}

/// The text as search compares it: one folded char per unit with the bytes
/// it came from. Combining marks are dropped, "ß" is two units of "s".
fn search_units(text: &str) -> Vec<(usize, usize, char)> {
    let mut units = Vec::with_capacity(text.len());
    for (start, c) in text.char_indices() {
        let end = start + c.len_utf8();
        if is_combining_mark(c) {
            continue;
        }
        if c == '\u{df}' || c == '\u{1e9e}' {
            units.push((start, end, 's'));
            units.push((start, end, 's'));
            continue;
        }
        let mut lower = c.to_lowercase();
        let first = lower.next().unwrap_or(c);
        units.push((start, end, strip_accent(first)));
        for rest in lower.filter(|r| !is_combining_mark(*r)) {
            units.push((start, end, rest));
        }
    }
    units
}

fn is_combining_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f)
}

/// Base letter for the precomposed Latin letters people type in names (the
/// same set the Library folds).
fn strip_accent(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' | 'ǎ' => 'a',
        'ç' | 'ć' | 'ĉ' | 'ċ' | 'č' => 'c',
        'ď' | 'đ' => 'd',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ĕ' | 'ė' | 'ę' | 'ě' => 'e',
        'ĝ' | 'ğ' | 'ġ' | 'ģ' => 'g',
        'ĥ' | 'ħ' => 'h',
        'ì' | 'í' | 'î' | 'ï' | 'ĩ' | 'ī' | 'ĭ' | 'į' | 'ı' | 'ǐ' => 'i',
        'ĵ' => 'j',
        'ķ' => 'k',
        'ĺ' | 'ļ' | 'ľ' | 'ŀ' | 'ł' => 'l',
        'ñ' | 'ń' | 'ņ' | 'ň' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ŏ' | 'ő' | 'ǒ' => 'o',
        'ŕ' | 'ŗ' | 'ř' => 'r',
        'ś' | 'ŝ' | 'ş' | 'š' | 'ș' => 's',
        'ţ' | 'ť' | 'ŧ' | 'ț' => 't',
        'ù' | 'ú' | 'û' | 'ü' | 'ũ' | 'ū' | 'ŭ' | 'ů' | 'ű' | 'ų' | 'ǔ' => 'u',
        'ŵ' => 'w',
        'ý' | 'ÿ' | 'ŷ' => 'y',
        'ź' | 'ż' | 'ž' => 'z',
        other => other,
    }
}

pub(crate) fn snippet(text: &str, start: usize, end: usize, radius: usize) -> String {
    let before: Vec<(usize, char)> = text[..start].char_indices().collect();
    let from = before
        .len()
        .checked_sub(radius)
        .map(|i| before[i].0)
        .unwrap_or(0);
    let after = &text[end..];
    let to = after
        .char_indices()
        .nth(radius)
        .map(|(i, _)| end + i)
        .unwrap_or(text.len());
    let mut out = String::new();
    if from > 0 {
        out.push('\u{2026}');
    }
    out.push_str(
        text[from..to]
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .as_str(),
    );
    if to < text.len() {
        out.push('\u{2026}');
    }
    out
}

pub(crate) fn normalised_words(text: &str) -> Vec<String> {
    text.unicode_words()
        .map(|w| w.chars().map(fold).collect())
        .collect()
}

pub(crate) fn char_count(s: &str) -> usize {
    s.chars().count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit<'a>(haystack: &'a str, query: &str) -> Option<&'a str> {
        find_ci(haystack, &fold_query(query)).map(|(start, end)| &haystack[start..end])
    }

    #[test]
    fn search_ignores_case_accents_and_marks_like_the_library() {
        assert_eq!(
            hit("Call with José Álvarez", "jose alvarez"),
            Some("José Álvarez")
        );
        assert_eq!(hit("Treffen in der Straße", "strasse"), Some("Straße"));
        assert_eq!(hit("Treffen in der Straße", "STRASSE"), Some("Straße"));
        assert_eq!(hit("Cafe\u{301} au lait", "cafe"), Some("Cafe\u{301}"));
        assert_eq!(hit("Notes from İstanbul", "istanbul"), Some("İstanbul"));
        assert_eq!(hit("Łódź office", "lodz"), Some("Łódź"));
        assert_eq!(
            hit("週次 ミーティング", "ミーティング"),
            Some("ミーティング")
        );
        assert_eq!(hit("plain text", "José"), None);
        assert_eq!(hit("José", "josé"), Some("José"));
        assert_eq!(hit("", "a"), None);
        assert_eq!(hit("abc", ""), None);
    }

    #[test]
    fn hits_are_always_char_boundaries_for_snippets() {
        for text in ["Stra\u{df}e", "a\u{301}\u{302}b", "\u{130}x", "🚀 launch é"] {
            for query in ["s", "ss", "a", "b", "x", "i", "launch", "e"] {
                if let Some((start, end)) = find_ci(text, &fold_query(query)) {
                    assert!(text.is_char_boundary(start) && text.is_char_boundary(end));
                    let _ = snippet(text, start, end, 3);
                }
            }
        }
    }
}
