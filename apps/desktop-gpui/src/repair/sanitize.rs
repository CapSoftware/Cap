pub const TITLE_LIMIT: usize = 80;
pub const DETAIL_LIMIT: usize = 160;
pub const THOUGHT_LIMIT: usize = 600;
pub const SUMMARY_LIMIT: usize = 1200;
pub const TARGET_LIMIT: usize = 200;

const WEB_TLDS: [&str; 30] = [
    "com", "net", "org", "io", "co", "ai", "app", "dev", "so", "me", "xyz", "info", "biz", "ru",
    "cn", "us", "uk", "de", "link", "site", "online", "top", "ly", "gg", "to", "cc", "tk", "click",
    "live", "support",
];

fn is_invisible(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '\u{200B}'..='\u{200F}'
                | '\u{202A}'..='\u{202E}'
                | '\u{2060}'..='\u{2064}'
                | '\u{2066}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{00AD}'
        )
}

fn is_link_token(token: &str) -> bool {
    let lower = token.to_ascii_lowercase();
    if lower.contains("://") || lower.starts_with("www.") || lower.starts_with("mailto:") {
        return true;
    }
    if let Some((local, domain)) = lower.split_once('@')
        && !local.is_empty()
        && domain.contains('.')
    {
        return true;
    }
    let trimmed = lower.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
    let host = trimmed.split('/').next().unwrap_or(trimmed);
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|label| label.is_empty()) {
        return false;
    }
    let tld = labels[labels.len() - 1];
    WEB_TLDS.contains(&tld)
        && labels[..labels.len() - 1].iter().all(|label| {
            label
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
        })
}

fn strip_long_digit_runs(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        if ch.is_ascii_digit()
            || (ch == '+' && chars.get(index + 1).is_some_and(char::is_ascii_digit))
        {
            let start = index;
            let mut end = index;
            let mut digits = 0;
            let mut cursor = index;
            while cursor < chars.len() {
                let current = chars[cursor];
                if current.is_ascii_digit() {
                    digits += 1;
                    end = cursor + 1;
                } else if !matches!(current, ' ' | '-' | '.' | '(' | ')' | '+' | '/') {
                    break;
                }
                cursor += 1;
            }
            if digits >= 7 {
                out.push('…');
            } else {
                out.extend(&chars[start..end]);
            }
            index = end.max(start + 1);
        } else {
            out.push(ch);
            index += 1;
        }
    }
    out
}

pub fn clean(text: &str, limit: usize) -> String {
    let visible: String = text
        .chars()
        .map(|ch| if ch.is_whitespace() { ' ' } else { ch })
        .filter(|ch| !is_invisible(*ch))
        .collect();
    let words: Vec<&str> = visible
        .split(' ')
        .filter(|word| !word.is_empty() && !is_link_token(word))
        .collect();
    let joined = strip_long_digit_runs(&words.join(" "));
    let collapsed = joined.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate(&collapsed, limit)
}

pub fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let mut out: String = text.chars().take(limit.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_links_emails_and_phone_numbers() {
        let out = clean(
            "Your Mac is infected! Call +1 (800) 555-1234 or visit https://evil.example/fix or www.evil.com or evil-support.net/help, email help@evil.io",
            SUMMARY_LIMIT,
        );
        assert!(!out.contains("800"), "{out}");
        assert!(!out.contains("555"), "{out}");
        assert!(!out.contains("evil"), "{out}");
        assert!(!out.contains("http"), "{out}");
        assert!(!out.contains('@'), "{out}");
    }

    #[test]
    fn keeps_file_names_and_small_numbers() {
        let out = clean(
            "Marked segment_150.m4s and manifest.json incomplete; recovered 41 of 42 fragments in recovery.rs",
            SUMMARY_LIMIT,
        );
        assert_eq!(
            out,
            "Marked segment_150.m4s and manifest.json incomplete; recovered 41 of 42 fragments in recovery.rs"
        );
    }

    #[test]
    fn removes_invisible_and_control_characters() {
        let out = clean("a\u{202E}b\u{200B}c\u{0007}d\n\n\te", THOUGHT_LIMIT);
        assert_eq!(out, "abcd e");
    }

    #[test]
    fn caps_length_on_char_boundaries() {
        let out = clean(&"日本".repeat(200), TITLE_LIMIT);
        assert_eq!(out.chars().count(), TITLE_LIMIT);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn long_number_runs_are_removed_even_without_separators() {
        assert_eq!(clean("size 26214400 bytes", DETAIL_LIMIT), "size … bytes");
        assert_eq!(clean("2026-11-03", DETAIL_LIMIT), "…");
        assert_eq!(clean("take 3 of 12", DETAIL_LIMIT), "take 3 of 12");
    }
}
