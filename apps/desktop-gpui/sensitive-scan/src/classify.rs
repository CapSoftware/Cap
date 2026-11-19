use std::sync::LazyLock;

use regex::Regex;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SensitiveKind {
    Email,
    Phone,
    CardNumber,
    Secret,
    CustomPhrase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SensitiveMatch {
    pub kind: SensitiveKind,
    pub start: usize,
    pub end: usize,
}

const KNOWN_SECRET_PREFIXES: &[(&str, usize)] = &[
    ("sk_live_", 10),
    ("sk_test_", 10),
    ("rk_live_", 10),
    ("rk_test_", 10),
    ("pk_live_", 10),
    ("pk_test_", 10),
    ("whsec_", 12),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("github_pat_", 20),
    ("glpat-", 16),
    ("xoxb-", 12),
    ("xoxp-", 12),
    ("xoxa-", 12),
    ("xoxs-", 12),
    ("xapp-", 12),
    ("sk-ant-", 16),
    ("sk-proj-", 16),
    ("sk-", 20),
    ("hf_", 20),
    ("npm_", 20),
    ("SG.", 20),
    ("shpat_", 16),
    ("shpss_", 16),
    ("dop_v1_", 20),
    ("AKIA", 12),
    ("ASIA", 12),
    ("AIza", 20),
];

const LONG_PASSPHRASE: usize = 12;

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[A-Za-z0-9._%+\-]+ ?@ ?[A-Za-z0-9\-]+(?: ?\. ?[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}")
        .expect("email pattern")
});

static PHONE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:\+\d{1,3}[ .\-]?)?(?:\(\d{2,4}\)[ .\-]?)?(?:\d{2,4}(?:[ .\-]\d{2,8}){1,4}|\d{7,13})",
    )
    .expect("phone pattern")
});

static DIGIT_RUN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d(?:[ \-]?\d){12,18}").expect("card pattern"));

static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_\-.+/]{8,}=*").expect("token pattern"));

static LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:\b|_)(?:api[_ \-]?key|secret(?:[_ \-]?key)?|client[_ \-]?secret|access[_ \-]?(?:key|token)|auth(?:orization)?[_ \-]?token|token|password|passwd|pwd|passphrase|private[_ \-]?key|credentials?)\s*[:=]\s*|\bbearer\s+",
    )
    .expect("label pattern")
});

static PHONE_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:phone|tel|mobile|cell|fax)\b\.?\s*[:#]?\s*").expect("phone label")
});

static CARD_LABEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:card(?:\s*(?:number|no\.?))?|visa|mastercard|amex|cc)\b\s*[:#]?\s*")
        .expect("card label")
});

static PEM_HEADER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").expect("pem pattern"));

pub fn find_sensitive(text: &str, phrases: &[String]) -> Vec<SensitiveMatch> {
    let text: &str = &text
        .chars()
        .map(|c| match c {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
            _ => c,
        })
        .collect::<String>();
    let offsets = CharOffsets::new(text);
    let mut found: Vec<SensitiveMatch> = Vec::new();
    let mut push = |kind: SensitiveKind, start: usize, end: usize| {
        if end > start {
            found.push(SensitiveMatch {
                kind,
                start: offsets.char_index(start),
                end: offsets.char_index(end),
            });
        }
    };

    for m in PEM_HEADER.find_iter(text) {
        push(SensitiveKind::Secret, m.start(), m.end());
    }

    for m in EMAIL.find_iter(text) {
        if is_email(m.as_str()) {
            push(SensitiveKind::Email, m.start(), m.end());
        }
    }

    for m in DIGIT_RUN.find_iter(text) {
        if standalone(text, m.start(), m.end(), true)
            && is_card_number(m.as_str(), labelled(&CARD_LABEL, text, m.start()))
        {
            push(SensitiveKind::CardNumber, m.start(), m.end());
        }
    }

    for m in PHONE.find_iter(text) {
        if standalone(text, m.start(), m.end(), m.as_str().starts_with(['+', '(']))
            && is_phone(m.as_str(), labelled(&PHONE_LABEL, text, m.start()))
        {
            push(SensitiveKind::Phone, m.start(), m.end());
        }
    }

    for m in TOKEN.find_iter(text) {
        let token = m.as_str().trim_end_matches(['.', ',']);
        let start = m.start() + secret_prefix_offset(token);
        let token = &text[start..m.start() + token.len()];
        if is_secret(token, label_before(&LABEL, text, start)) {
            push(SensitiveKind::Secret, start, start + token.len());
        }
    }

    for label in LABEL.find_iter(text) {
        let value_start = label.end();
        let value_len: usize = text[value_start..]
            .chars()
            .take_while(|c| !c.is_whitespace())
            .map(char::len_utf8)
            .sum();
        let value = text[value_start..value_start + value_len].trim_end_matches(['.', ',', ';']);
        if value.chars().count() >= 6 && labelled_secret(label.as_str(), value) {
            push(
                SensitiveKind::Secret,
                value_start,
                value_start + value.len(),
            );
        }
    }

    found.extend(find_phrases(text, phrases));
    merge_overlapping(found)
}

struct CharOffsets {
    byte_starts: Vec<usize>,
}

impl CharOffsets {
    fn new(text: &str) -> Self {
        Self {
            byte_starts: text.char_indices().map(|(index, _)| index).collect(),
        }
    }

    fn char_index(&self, byte: usize) -> usize {
        self.byte_starts.partition_point(|start| *start < byte)
    }
}

fn standalone(text: &str, start: usize, end: usize, after_letters: bool) -> bool {
    let before = text[..start].chars().next_back();
    let after = text[end..].chars().next();
    let joined = |c: Option<char>| {
        c.is_some_and(|c| {
            c.is_numeric() || "_./:".contains(c) || (c.is_alphabetic() && !after_letters)
        })
    };
    let after_joined = after.is_some_and(|c| c.is_alphanumeric() || c == '_')
        || text[end..].starts_with(['.', '/', ':'])
            && text[end..]
                .chars()
                .nth(1)
                .is_some_and(|c| c.is_alphanumeric());
    !joined(before) && !after_joined
}

fn label_before<'t>(label: &Regex, text: &'t str, byte: usize) -> Option<&'t str> {
    label
        .find_iter(&text[..byte])
        .find(|m| m.end() == byte)
        .map(|m| m.as_str())
}

fn labelled(label: &Regex, text: &str, byte: usize) -> bool {
    label_before(label, text, byte).is_some()
}

fn labelled_secret(label: &str, value: &str) -> bool {
    if !is_plain_word(value) {
        return true;
    }
    let separated = label.contains([':', '=']);
    let identifier = label.contains('_') || !label.chars().any(char::is_lowercase);
    label.trim_end().ends_with('=')
        || separated && (identifier || value.chars().count() >= LONG_PASSPHRASE)
}

fn is_email(candidate: &str) -> bool {
    let compact: String = candidate.chars().filter(|c| *c != ' ').collect();
    let Some((local, domain)) = compact.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !local.starts_with('.')
        && domain.contains('.')
        && domain
            .rsplit('.')
            .next()
            .is_some_and(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
}

fn luhn_valid(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(index, digit)| {
            if index % 2 == 1 {
                let doubled = digit * 2;
                if doubled > 9 { doubled - 9 } else { doubled }
            } else {
                *digit
            }
        })
        .sum();
    sum.is_multiple_of(10)
}

fn secret_prefix_offset(token: &str) -> usize {
    KNOWN_SECRET_PREFIXES
        .iter()
        .filter(|(prefix, _)| prefix.len() >= 4)
        .filter_map(|(prefix, _)| {
            token
                .match_indices(prefix)
                .map(|(index, _)| index)
                .find(|&index| {
                    let before = token[..index].chars().next_back();
                    index > 0
                        && (prefix.ends_with('_')
                            || before.is_some_and(|c| c.is_lowercase())
                                && prefix.starts_with(|c: char| c.is_uppercase()))
                })
        })
        .min()
        .unwrap_or(0)
}

fn is_card_number(candidate: &str, labelled: bool) -> bool {
    let digits: Vec<u32> = candidate.chars().filter_map(|c| c.to_digit(10)).collect();
    if !(13..=19).contains(&digits.len()) || digits.iter().all(|digit| *digit == digits[0]) {
        return false;
    }
    let groups: Vec<usize> = candidate
        .split([' ', '-'])
        .filter(|group| !group.is_empty())
        .map(str::len)
        .collect();
    let grouped_like_a_card = groups.len() == 1 || groups.iter().all(|len| (3..=6).contains(len));
    let loosely_grouped = groups[..groups.len() - 1].iter().all(|len| len % 4 == 0)
        || matches!(groups.as_slice(), [4, 6, 5] | [4, 6, 4]);
    luhn_valid(&digits) && loosely_grouped || grouped_like_a_card && labelled
}

fn is_phone(candidate: &str, labelled: bool) -> bool {
    let digits = candidate.chars().filter(char::is_ascii_digit).count();
    let international = candidate.starts_with('+');
    let groups: Vec<&str> = candidate
        .split([' ', '.', '-', '(', ')', '+'])
        .filter(|group| !group.is_empty())
        .collect();
    let dotted = candidate.contains('.') && !candidate.contains([' ', '-', '(']);
    if dotted && !international {
        return false;
    }
    if groups.len() >= 3 && groups[0].len() == 4 && candidate.contains('-') {
        return false;
    }
    let formatted = international || candidate.contains('(') || groups.len() >= 3;
    let enough_digits = if international {
        (8..=15).contains(&digits)
    } else {
        (10..=13).contains(&digits)
    };
    enough_digits && (formatted || labelled)
}

fn shannon_entropy(text: &str) -> f64 {
    let mut counts = [0usize; 128];
    let mut total = 0usize;
    for byte in text.bytes().filter(u8::is_ascii) {
        counts[byte as usize] += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = *count as f64 / total as f64;
            -p * p.log2()
        })
        .sum()
}

fn is_hex_like(token: &str) -> bool {
    token
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-' || c == ':')
}

fn is_plain_word(token: &str) -> bool {
    token
        .chars()
        .all(|c| c.is_alphabetic() || c == '-' || c == '\'')
}

fn is_secret(token: &str, label: Option<&str>) -> bool {
    if let Some((_, min_rest)) = KNOWN_SECRET_PREFIXES.iter().find(|(prefix, min_rest)| {
        token.starts_with(prefix) && token.len() >= prefix.len() + min_rest
    }) {
        let rest = &token[token.len() - min_rest..];
        return rest.chars().any(|c| c.is_ascii_digit()) || shannon_entropy(rest) >= 3.0;
    }

    if is_jwt(token) {
        return true;
    }

    if let Some(label) = label {
        return labelled_secret(label, token);
    }

    if token.len() < 20 || token.contains("://") || token.contains("..") || is_hex_like(token) {
        return false;
    }
    let path_segments = token.split('/').filter(|part| part.len() > 2).count();
    if path_segments > 2 || token.split('.').filter(|part| !part.is_empty()).count() > 3 {
        return false;
    }
    let digits = token.chars().filter(char::is_ascii_digit).count();
    let lower = token.chars().filter(char::is_ascii_lowercase).count();
    let upper = token.chars().filter(char::is_ascii_uppercase).count();
    digits >= 2 && lower >= 2 && upper >= 2 && shannon_entropy(token) >= 3.6
}

fn is_jwt(token: &str) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 3 && parts[0].starts_with("eyJ") && parts.iter().all(|part| part.len() >= 8)
}

fn normalize_for_phrase(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut chars = Vec::new();
    let mut origins = Vec::new();
    for (index, c) in text.chars().enumerate() {
        if c.is_whitespace() {
            continue;
        }
        for lower in c.to_lowercase() {
            chars.push(lower);
            origins.push(index);
        }
    }
    (chars, origins)
}

fn find_phrases(text: &str, phrases: &[String]) -> Vec<SensitiveMatch> {
    let (haystack, origins) = normalize_for_phrase(text);
    let mut found = Vec::new();
    for phrase in phrases {
        let (needle, _) = normalize_for_phrase(phrase);
        if needle.len() < 2 || needle.len() > haystack.len() {
            continue;
        }
        let allowed_mismatches = usize::from(needle.len() >= 6);
        let mut start = 0;
        while start + needle.len() <= haystack.len() {
            let mismatches = haystack[start..start + needle.len()]
                .iter()
                .zip(&needle)
                .filter(|(a, b)| a != b)
                .count();
            if mismatches <= allowed_mismatches {
                found.push(SensitiveMatch {
                    kind: SensitiveKind::CustomPhrase,
                    start: origins[start],
                    end: origins[start + needle.len() - 1] + 1,
                });
                start += needle.len();
            } else {
                start += 1;
            }
        }
    }
    found
}

fn merge_overlapping(mut found: Vec<SensitiveMatch>) -> Vec<SensitiveMatch> {
    found.sort_by_key(|m| (m.start, std::cmp::Reverse(m.end)));
    let mut merged: Vec<SensitiveMatch> = Vec::with_capacity(found.len());
    for m in found {
        match merged.last_mut() {
            Some(last) if m.start < last.end => last.end = last.end.max(m.end),
            _ => merged.push(m),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spans(text: &str, phrases: &[String]) -> Vec<(SensitiveKind, String)> {
        let chars: Vec<char> = text.chars().collect();
        find_sensitive(text, phrases)
            .into_iter()
            .map(|m| (m.kind, chars[m.start..m.end].iter().collect()))
            .collect()
    }

    fn assert_hidden(text: &str, secret: &str, kind: SensitiveKind) {
        let found = spans(text, &[]);
        assert!(
            found
                .iter()
                .any(|(found_kind, span)| *found_kind == kind && span.contains(secret)),
            "{secret:?} in {text:?} was not hidden as {kind:?}: {found:?}"
        );
        let hidden: usize = found.iter().map(|(_, span)| span.chars().count()).sum();
        assert!(
            hidden <= secret.chars().count() + 16,
            "{text:?} hid far more than {secret:?}: {found:?}"
        );
    }

    fn assert_clean(text: &str) {
        assert_eq!(spans(text, &[]), vec![], "{text}");
    }

    #[test]
    fn emails_are_found_with_their_exact_span() {
        assert_eq!(
            spans("Contact jane.doe+billing@acme-corp.co.uk today", &[]),
            vec![(
                SensitiveKind::Email,
                "jane.doe+billing@acme-corp.co.uk".to_string()
            )]
        );
        assert_hidden(
            "ops @ example.com",
            "ops @ example.com",
            SensitiveKind::Email,
        );
        assert_clean("user@localhost");
        assert_clean("@cap.so on social");
    }

    #[test]
    fn phone_numbers_need_formatting_or_a_label() {
        assert_hidden(
            "Call +44 20 7946 0958 now",
            "+44 20 7946 0958",
            SensitiveKind::Phone,
        );
        assert_hidden("(415) 555-0132", "(415) 555-0132", SensitiveKind::Phone);
        assert_hidden("415-555-0132 ext", "415-555-0132", SensitiveKind::Phone);
        assert_hidden("Phone: 4155550132", "4155550132", SensitiveKind::Phone);
        assert_hidden("+1.415.555.0132", "+1.415.555.0132", SensitiveKind::Phone);
        assert_clean("Order 4155550132 shipped");
    }

    #[test]
    fn fullwidth_punctuation_from_ocr_is_read_as_ascii() {
        assert_hidden("(415）555-0132", "(415）555-0132", SensitiveKind::Phone);
        assert_hidden("ops＠example.com", "ops＠example.com", SensitiveKind::Email);
    }

    #[test]
    fn version_numbers_dates_and_addresses_are_not_phones() {
        for text in [
            "Cap v0.6.3 and 2.14.0-beta.1 released",
            "Released 2026-11-19 at 10:30",
            "Updated 2026-11-19 10:42",
            "Server 192.168.100.200 responded",
            "ISBN 978-3-16-148410-0",
            "Build 2026.11.19.1042",
            "Updated 19/11/2026",
            "port 8080, pid 12345",
            "Totals 1,234,567.89 and 2,000,000",
            "Version 10.15.7 build 19H2",
            "Python 3.12.4 on linux 6.18.62",
        ] {
            assert_clean(text);
        }
    }

    #[test]
    fn card_numbers_must_pass_luhn_unless_labelled() {
        assert_hidden(
            "Paid with 4242 4242 4242 4242 exp 12/30",
            "4242 4242 4242 4242",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "amex 3782-822463-10005",
            "3782-822463-10005",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "Card number: 4000 1234 5678 9010",
            "4000 1234 5678 9010",
            SensitiveKind::CardNumber,
        );
        assert_clean("Order 4242 4242 4242 4241 shipped");
        assert_clean("Tracking 1111111111111111");
    }

    #[test]
    fn amex_and_diners_grouping_needs_no_label() {
        for card in ["3782 822463 10005", "3782-822463-10005", "3056 930902 5904"] {
            assert_hidden(
                &format!("Paid with {card} today"),
                card,
                SensitiveKind::CardNumber,
            );
        }
        assert_clean("Reference 3782 822463 10006 attached");
    }

    #[test]
    fn known_token_prefixes_are_secrets() {
        for token in [
            concat!("sk_live_", "51NzQkL2eZvKYlo2C8f9xQx3Y"),
            concat!("ghp_", "R7mK2vX9pQ4wL8nB3cZ6tY1uF5hJ0aS2dE4g"),
            concat!("github_pat_", "11ABCDEFG0123456789_abcdefghijklmnop"),
            concat!("xoxb-", "2847561920-9283746501-aB3cD4eF5gH6iJ7kL8"),
            concat!("AKIA", "IOSFODNN7EXAMPLE"),
            "AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY",
            concat!("sk-proj-", "Xq7v2LmN9pR4tW8yB3cF6hJ1kD5gS0aZ"),
            concat!("glpat-", "x7Kq2mVp9LrT4wNb8YcZ"),
            concat!("hf_", "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"),
        ] {
            assert_hidden(&format!("using {token} here"), token, SensitiveKind::Secret);
        }
    }

    #[test]
    fn jwts_and_private_keys_are_secrets() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        assert_hidden(jwt, jwt, SensitiveKind::Secret);
        assert_hidden(
            "-----BEGIN RSA PRIVATE KEY-----",
            "BEGIN RSA PRIVATE KEY",
            SensitiveKind::Secret,
        );
    }

    #[test]
    fn high_entropy_tokens_are_secrets_but_hashes_and_identifiers_are_not() {
        assert_hidden(
            "value Zx8Kq2Lm7Vp4Rt9Wn3Bc6Yh1Fd5Gs0Aq is set",
            "Zx8Kq2Lm7Vp4Rt9Wn3Bc6Yh1Fd5Gs0Aq",
            SensitiveKind::Secret,
        );
        assert_hidden(
            "export STRIPE=Zx8Kq2Lm7Vp4Rt9Wn3Bc6Yh1",
            "Zx8Kq2Lm7Vp4Rt9Wn3Bc6Yh1",
            SensitiveKind::Secret,
        );
        for text in [
            "Fixed in commit 3f9a1c2e4b5d6f708192a3b4c5d6e7f8091a2b3c yesterday",
            "sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "Request id 550e8400-e29b-41d4-a716-446655440000",
            "See https://github.com/CapSoftware/Cap/pull/4388 for details",
            "Path /Users/jane/Library/Application Support/Cap",
            "ThisIsAVeryLongCamelCaseIdentifierName",
            "useEffectQuery returns ExportPreviewSettings",
            "crates/sensitive-scan/src/classify.rs",
            "Merge pull request #4388 from CapSoftware/fix/studio-camera-switch-in-place",
            "base64 of hello is aGVsbG8=",
        ] {
            assert_clean(text);
        }
    }

    #[test]
    fn labelled_values_are_secrets_even_when_short_or_hex() {
        assert_hidden("password: hunter2!x", "hunter2!x", SensitiveKind::Secret);
        assert_hidden(
            "API_KEY=3f9a1c2e4b5d6f708192",
            "3f9a1c2e4b5d6f708192",
            SensitiveKind::Secret,
        );
        assert_hidden(
            "Authorization: Bearer abc123DEF456ghi789",
            "abc123DEF456ghi789",
            SensitiveKind::Secret,
        );
        assert_clean("Reset your password: click here");
        assert_clean("The token is valid");
    }

    #[test]
    fn alphabetic_passwords_in_assignments_are_secrets() {
        for (text, secret) in [
            (
                "PASSWORD=correcthorsebatterystaple",
                "correcthorsebatterystaple",
            ),
            ("db_password: sunshine", "sunshine"),
            ("password = trustno", "trustno"),
            (
                "password: correct-horse-battery-staple",
                "correct-horse-battery-staple",
            ),
            ("Password: correcthorsebattery", "correcthorsebattery"),
        ] {
            assert_hidden(text, secret, SensitiveKind::Secret);
        }
        for text in [
            "Password: required for every account",
            "Use bearer authentication for the API",
            "Your password: forgotten links expire",
        ] {
            assert_clean(text);
        }
    }

    #[test]
    fn custom_phrases_match_case_and_spacing_insensitively_with_one_typo() {
        let phrases = vec!["Acme Robotics".to_string(), "Jo".to_string()];
        assert_eq!(
            spans("Invoice for ACME  Robotlcs and jo", &phrases),
            vec![
                (SensitiveKind::CustomPhrase, "ACME  Robotlcs".to_string()),
                (SensitiveKind::CustomPhrase, "jo".to_string()),
            ]
        );
        assert!(find_sensitive("Acne", &["Acme".to_string()]).is_empty());
    }

    #[test]
    fn values_glued_to_their_label_by_ocr_are_still_found() {
        assert_hidden(
            concat!("AWS access keyAKIA", "MFJSTO7BDVQKWZYL"),
            concat!("AKIA", "MFJSTO7BDVQKWZYL"),
            SensitiveKind::Secret,
        );
        assert_hidden(
            concat!("GitHub tokenghp_", "cRyqvbZ6q7OE5GISKnpNfMc6kg6R1gGTJGcF"),
            concat!("ghp_", "cRyqvbZ6q7OE5GISKnpNfMc6kg6R1gGTJGcF"),
            SensitiveKind::Secret,
        );
        assert_hidden(
            "Card on file4363 7487 7518 1776",
            "4363 7487 7518 1776",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "Card on file4550 32818038 5818",
            "4550 32818038 5818",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "Card on file436374877518 1776",
            "436374877518 1776",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "Card onfile4550328180385818",
            "4550328180385818",
            SensitiveKind::CardNumber,
        );
        assert_hidden(
            "Support line+44 20 5209 2596",
            "+44 20 5209 2596",
            SensitiveKind::Phone,
        );
        assert_hidden("Mobile(415)555-9918", "(415)555-9918", SensitiveKind::Phone);
        assert_hidden(
            "Support line+44 20 60616709",
            "+44 20 60616709",
            SensitiveKind::Phone,
        );
        assert_eq!(
            spans("DATABASE_PASSWORD=wFRkvUU6j74G6O", &[]),
            vec![(SensitiveKind::Secret, "wFRkvUU6j74G6O".to_string())]
        );
        assert_hidden(
            "DATABASE_PASSWORD= XnvVul2ks89I60",
            "XnvVul2ks89I60",
            SensitiveKind::Secret,
        );
        for text in [
            "task-management-dashboard-v2 is live",
            "Order4242424242424241 shipped",
            "Build2026.11.19.1042 passed",
            "PANASIA2026 summit",
        ] {
            assert_clean(text);
        }
    }

    #[test]
    fn spans_are_character_indices_for_non_ascii_text() {
        assert_eq!(
            spans("Café → jane@example.com", &[]),
            vec![(SensitiveKind::Email, "jane@example.com".to_string())]
        );
    }

    #[test]
    fn overlapping_matches_merge_into_one_span() {
        assert_eq!(
            spans(concat!("token: sk_live_", "51NzQkL2eZvKYlo2C8f9xQx3Y"), &[]),
            vec![(
                SensitiveKind::Secret,
                concat!("sk_live_", "51NzQkL2eZvKYlo2C8f9xQx3Y").to_string()
            )]
        );
    }
}
