//! Matching text the way people expect: case and accents never matter, so
//! "jose" finds "José" and "STRASSE" finds "straße".

/// Folds a whole string for matching: lowercase, accents removed, runs of
/// whitespace collapsed to one space, ends trimmed.
pub fn fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        push_folded(c, &mut out);
    }
    out
}

fn push_folded(c: char, out: &mut String) {
    if c.is_ascii() {
        out.push(c.to_ascii_lowercase());
        return;
    }
    if is_combining_mark(c) {
        return;
    }
    if c == 'ß' || c == 'ẞ' {
        out.push_str("ss");
        return;
    }
    let mut lower = c.to_lowercase();
    let first = lower.next().unwrap_or(c);
    if let Some(second) = lower.next() {
        // Multi-char lowercase forms (İ -> i̇): keep the base letter, the
        // combining dot is dropped like any other accent.
        out.push(strip_accent(first));
        if !is_combining_mark(second) {
            out.push(second);
        }
        for rest in lower {
            if !is_combining_mark(rest) {
                out.push(rest);
            }
        }
        return;
    }
    out.push(strip_accent(first));
}

fn is_combining_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036f | 0x1ab0..=0x1aff | 0x1dc0..=0x1dff | 0x20d0..=0x20ff | 0xfe20..=0xfe2f)
}

/// Base letter for the precomposed Latin letters people type in names.
/// Anything else (CJK, Cyrillic, Devanagari) is returned unchanged.
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

/// Whether `haystack` (already folded) contains `needle` (already folded).
/// An empty needle matches nothing: an unfinished rule never sweeps the
/// whole library into a folder.
pub fn contains(haystack: &str, needle: &str) -> bool {
    !needle.is_empty() && haystack.contains(needle)
}

/// Names compared the way people count: "Folder 2" before "Folder 10",
/// case and accents ignored, ties broken by the raw text so the order is total.
pub fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (fa, fb) = (fold(a), fold(b));
    let (mut x, mut y) = (fa.as_str(), fb.as_str());
    loop {
        match (x.chars().next(), y.chars().next()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let nx = x.len() - x.trim_start_matches(|c: char| c.is_ascii_digit()).len();
                let ny = y.len() - y.trim_start_matches(|c: char| c.is_ascii_digit()).len();
                let (dx, dy) = (
                    x[..nx].trim_start_matches('0'),
                    y[..ny].trim_start_matches('0'),
                );
                let order = dx.len().cmp(&dy.len()).then_with(|| dx.cmp(dy));
                if order != std::cmp::Ordering::Equal {
                    return order;
                }
                x = &x[nx..];
                y = &y[ny..];
            }
            (Some(c), Some(d)) => {
                if c != d {
                    return c.cmp(&d);
                }
                x = &x[c.len_utf8()..];
                y = &y[d.len_utf8()..];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_accents_and_spacing_never_matter() {
        assert_eq!(fold("  José   ÁLVAREZ "), "jose alvarez");
        assert_eq!(fold("Straße"), "strasse");
        assert_eq!(fold("ZOË"), "zoe");
        assert_eq!(fold("İstanbul"), "istanbul");
        assert_eq!(fold("Cafe\u{301}"), "cafe");
        assert_eq!(fold("Łódź"), "lodz");
    }

    #[test]
    fn non_latin_scripts_are_kept() {
        assert_eq!(fold("週次 ミーティング"), "週次 ミーティング");
        assert_eq!(fold("Привет"), "привет");
        assert_eq!(fold("नमस्ते"), "नमस्ते");
        assert!(contains(&fold("Weekly 週次 sync"), &fold("週次")));
    }

    #[test]
    fn an_empty_needle_matches_nothing() {
        assert!(!contains("anything", ""));
        assert!(!contains("", ""));
    }

    #[test]
    fn folder_names_sort_with_numbers_counted() {
        let mut names = vec![
            "Folder 10",
            "folder 2",
            "Folder 1",
            "Folder 100",
            "Álbum",
            "Folder 02",
            "alpha",
        ];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(
            names,
            [
                "Álbum",
                "alpha",
                "Folder 1",
                "Folder 02",
                "folder 2",
                "Folder 10",
                "Folder 100"
            ]
        );
    }
}
