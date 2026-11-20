use unicode_segmentation::UnicodeSegmentation;

pub(crate) fn fold(c: char) -> char {
    let mut lower = c.to_lowercase();
    match (lower.next(), lower.next()) {
        (Some(single), None) => single,
        _ => c,
    }
}

pub(crate) fn fold_query(query: &str) -> Vec<char> {
    query.trim().chars().map(fold).collect()
}

pub(crate) fn find_ci(haystack: &str, needle: &[char]) -> Option<(usize, usize)> {
    if needle.is_empty() {
        return None;
    }
    let chars: Vec<(usize, char)> = haystack.char_indices().collect();
    if chars.len() < needle.len() {
        return None;
    }
    (0..=chars.len() - needle.len()).find_map(|i| {
        let hit = needle
            .iter()
            .enumerate()
            .all(|(j, n)| fold(chars[i + j].1) == *n);
        hit.then(|| {
            let end = chars
                .get(i + needle.len())
                .map(|(b, _)| *b)
                .unwrap_or(haystack.len());
            (chars[i].0, end)
        })
    })
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
