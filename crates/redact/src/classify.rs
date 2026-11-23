use std::sync::LazyLock;

use cap_project::RedactCategory;
use regex::Regex;

use crate::names;

/// A sensitive span inside one recognised line, in char indices.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finding {
    pub category: RedactCategory,
    pub start: usize,
    pub end: usize,
}

/// A recognised line with its place on screen, for rules that read a label
/// on one line and the value on the next (a "Password" field, an "API key"
/// setting).
#[derive(Clone, Debug)]
pub struct LineContext<'a> {
    pub text: &'a str,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("valid classifier pattern")
}

static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(r"[A-Za-z0-9][A-Za-z0-9._%+'\-]*\s?@\s?[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,24}")
});
static PARTIAL_EMAIL: LazyLock<Regex> =
    LazyLock::new(|| re(r"[A-Za-z0-9][A-Za-z0-9._%+'\-]*@[A-Za-z0-9\-][A-Za-z0-9.\-]*"));
static URL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)\b(?:(?:https?|ftp|wss?|file)://|www\.)[^\s<>"'`]+|\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|co|ai|app|dev|me|so|gg|xyz|info|biz|us|uk|de|fr|es|it|nl|se|no|dk|fi|ca|au|nz|jp|cn|in|br|mx|ru|ch|at|be|pl|ie|pt|cz|tv|ly|sh|to|edu|gov)\b(?:/[^\s<>"'`]*)?"#,
    )
});
static URL_CREDENTIALS: LazyLock<Regex> =
    LazyLock::new(|| re(r"[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s:/@]+:([^\s@/]+)@[^\s]+"));
static IPV4: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^0-9A-Za-z.])((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){3})(?::[0-9]{1,5})?(?:/[0-9]{1,2})?(?:$|[^0-9A-Za-z.])",
    )
});
static IPV6: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)(?:^|[^0-9a-z:])((?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?::[0-9a-f]{1,4}){1,6}|::(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})(?:$|[^0-9a-z:])",
    )
});
static DIGIT_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"\+?\(?[0-9][0-9 ().\-/]*[0-9]"));
static IBAN: LazyLock<Regex> = LazyLock::new(|| re(r"\b[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}\b"));
static DATE_LIKE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:[0-9]{4}[\-/.][0-9]{1,2}[\-/.][0-9]{1,2}|[0-9]{1,2}[\-/.][0-9]{1,2}[\-/.][0-9]{2,4})(?:[ T][0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)?$",
    )
});
static NANP: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^(?:\+?1[ .\-]?)?(?:\([2-9][0-9]{2}\) ?|[2-9][0-9]{2}([ .\-]))[0-9]{3}[ .\-][0-9]{4}$")
});
static TRUNK_GROUPED: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\(?0[0-9]{1,5}\)?(?:[ .\-][0-9]{2,8}){1,4}$"));
static INTERNATIONAL: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\+[0-9]{1,3}(?:[ .\-]?\(?[0-9]{1,6}\)?){1,6}$"));
static PHONE_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:phone|tel|telephone|mobile|mob|cell|fax|call|whatsapp|sms|contact|ph|t)\s*[.:#]|\b(?:phone|telephone|mobile|cell|whatsapp)\b",
    )
});
static ACCOUNT_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b(?:account|acct|a/c|routing|sort\s*code|bsb|aba|swift|bic|iban|bank)\b")
});
static SWIFT: LazyLock<Regex> =
    LazyLock::new(|| re(r"\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b"));

static KNOWN_TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    re(concat!(
        r"(?:",
        r"\b(?:sk|rk|pk)_(?:[lI1]ive|[tT]est)_[A-Za-z0-9]{8,}",
        r"|\bwhsec_[A-Za-z0-9]{16,}",
        r"|\bsk-(?:proj-|ant-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}",
        r"|\bgh[pousr]_[A-Za-z0-9]{20,}",
        r"|\bgithub_pat_[A-Za-z0-9_]{20,}",
        r"|\bglpat-[A-Za-z0-9_\-]{16,}",
        r"|\bxox[abposre]-[A-Za-z0-9\-]{10,}",
        r"|\bxapp-[0-9]-[A-Za-z0-9\-]{10,}",
        r"|\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b",
        r"|\bAIza[0-9A-Za-z_\-]{30,}",
        r"|\bya29\.[0-9A-Za-z_\-]{20,}",
        r"|\bnpm_[A-Za-z0-9]{30,}",
        r"|\bhf_[A-Za-z0-9]{30,}",
        r"|\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}",
        r"|\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}",
        r"|\bdop_v1_[a-f0-9]{40,}",
        r"|\bkey-[0-9a-f]{32}\b",
        r"|\bsq0(?:atp|csp)-[0-9A-Za-z_\-]{20,}",
        r"|\b(?:AC|SK)[0-9a-f]{32}\b",
        r"|\bxai-[A-Za-z0-9]{20,}",
        r"|\bgsk_[A-Za-z0-9]{20,}",
        r"|\bpplx-[A-Za-z0-9]{20,}",
        r"|\br8_[A-Za-z0-9]{20,}",
        r"|\bvercel_[A-Za-z0-9]{16,}",
        r"|\bnfp_[A-Za-z0-9]{20,}",
        r"|\bpscale_(?:tkn|pw|oauth)_[A-Za-z0-9_\-]{16,}",
        r"|\bsntrys_[A-Za-z0-9_=]{20,}",
        r"|\blin_api_[A-Za-z0-9]{20,}",
        r"|\bphc_[A-Za-z0-9]{20,}",
        r"|\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}",
        r"|\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        r"|-----BEGIN [A-Z ]*PRIVATE KEY-----",
        r"|\bAccountKey=[A-Za-z0-9+/=]{20,}",
        r"|\bSharedAccessSignature=[^\s;]{16,}",
        r")"
    ))
});
static ASSIGNED_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)(?:^|[^a-z])((?:[a-z0-9]+[_\-. ]?)?(?:password|passwd|passphrase|pwd|pass|secret|token|api[_\-. ]?key|apikey|access[_\-. ]?key|private[_\-. ]?key|client[_\-. ]?secret|auth(?:orization)?|bearer|credentials?|session[_\-. ]?id|cookie|signing[_\-. ]?key|license[_\-. ]?key|otp|pin)(?:[_\-. ]?[a-z0-9]+)?)\s*["']?\s*(?:[:=]|=>|:=)\s*["']?([^\s"',;]{4,})"#,
    )
});
static BEARER: LazyLock<Regex> = LazyLock::new(|| {
    re(r#"(?i)\b(?:bearer|basic)\s+([^\s"']{8,})|\btoken\s+([A-Za-z0-9_\-.=+/]{16,})"#)
});
static LABEL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^\s*(?:[a-z\-]+\s+){0,3}(?:password|passcode|passphrase|secret|key|api\s*key|token|credentials?|pin|recovery\s*(?:code|phrase)|seed\s*phrase)\s*[:*]?\s*$",
    )
});
static SPACED_SECRET: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:password|passphrase|passcode|secret|api\s?key|access\s?key|token|pin)(?:\s{2,}|\t+)(\S{4,})",
    )
});
static COMMIT_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)\b(?:commit|merge|head is now at|sha|revision|rev|checkout|cherry-pick|revert|tag|build|digest|sha1|sha256|md5|checksum)\b[: ]*$",
    )
});
static TOKENISH: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9+/_\-.~]{20,}={0,2}"));
static HEX_ONLY: LazyLock<Regex> = LazyLock::new(|| re(r"^[0-9a-fA-F]+$"));
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
});

static STREET: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b[0-9]{1,6}[A-Za-z]?(?:-[0-9]{1,4})?,?\s+(?:[NSEW]\.?\s+)?(?:[A-Z][A-Za-z'\-]+\.?\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Court|Ct|Place|Pl|Terrace|Ter|Circle|Cir|Highway|Hwy|Parkway|Pkwy|Square|Sq|Crescent|Cres|Close|Grove|Gardens|Row|Mews|Alley|Trail|Trl|Plaza|Loop|Walk|Hill)\b\.?(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|Fl|Floor|#)\.?\s*[A-Za-z0-9\-]+)?",
    )
});
static CITY_STATE_ZIP: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"\b[A-Z][A-Za-z.\- ]{1,30},\s+(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s+[0-9]{5}(?:-[0-9]{4})?\b",
    )
});
static UK_POSTCODE: LazyLock<Regex> = LazyLock::new(|| {
    re(r"\b(?:[A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKMNPR-Y]?)\s[0-9][ABD-HJLNP-UW-Z]{2}\b")
});
static EU_STREET: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:\b[0-9]{1,5}[A-Za-z]?,?\s+)?\b(?:rue|avenue|boulevard|bd|chemin|place|allée|quai|impasse|route|via|viale|piazza|corso|calle|avenida|carrer|rua|plaza|paseo)\s+(?:\p{Ll}{1,4}\s+){0,3}\p{L}[\p{L}'\-]+(?:\s+[0-9]{1,5}[a-z]?)?|\b\p{Lu}\p{Ll}+(?:straße|strasse|str\.|weg|allee|gasse|platz|ring|damm|laan|straat|gatan|vej|gade)\s+[0-9]{1,4}[a-z]?",
    )
});
static ADDRESS_TAIL: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^(?:,?\s*(?:Apt|Apartment|Suite|Ste|Unit|Fl|Floor|#)\.?\s*[A-Za-z0-9\-]+)?(?:,\s*|\s+)(?:\p{Lu}[\p{L}.\-]+(?:\s\p{Lu}[\p{L}.\-]+){0,3},?\s+)?(?:[A-Z]{2}\s+[0-9]{5}(?:-[0-9]{4})?|(?:NSW|QLD|VIC|WA|SA|TAS|ACT|NT)\s+[0-9]{4}|(?:[A-PR-UWYZ][A-HK-Y]?[0-9][0-9A-HJKMNPR-Y]?)\s[0-9][ABD-HJLNP-UW-Z]{2}|[0-9]{4,5}\s+\p{Lu}\p{Ll}+(?:[ \-]\p{Lu}\p{Ll}+)*|[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9])\b",
    )
});
static ADDRESS_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^\s*(?:(?:street|home|billing|shipping|mailing|postal|delivery)\s+)?address(?:\s+line\s*[12])?(?:\s*[:\-]\s*|\s{2,})(\S.{4,})$",
    )
});

/// Classifies one recognised line. `text` is what the recogniser read, so
/// rules tolerate the usual confusions (O for 0, l for 1) in digit runs.
pub fn classify_line(text: &str) -> Vec<Finding> {
    let findings = classify_raw(text);
    glue_split_tokens(text, findings)
}

/// The recogniser sometimes reads a space inside small text ("gH1j K21Mn",
/// "examp le.com"). A partial email takes the next word when the two read
/// as a whole address, and a long token takes a short next fragment that
/// mixes digits or cases like the token itself.
fn glue_split_tokens(text: &str, mut findings: Vec<Finding>) -> Vec<Finding> {
    let chars = text.chars().collect::<Vec<_>>();
    let next_word = |end: usize| -> Option<(usize, usize)> {
        if chars.get(end) != Some(&' ') || chars.get(end + 1).is_none_or(|c| c.is_whitespace()) {
            return None;
        }
        let stop = (end + 1..chars.len())
            .find(|i| chars[*i].is_whitespace())
            .unwrap_or(chars.len());
        Some((end + 1, stop))
    };
    for finding in &mut findings {
        let Some((word_start, word_end)) = next_word(finding.end) else {
            continue;
        };
        let current = chars[finding.start..finding.end].iter().collect::<String>();
        let word = chars[word_start..word_end].iter().collect::<String>();
        let joined = format!("{current}{word}");
        let glue = match finding.category {
            RedactCategory::Email => {
                !EMAIL.is_match(&current)
                    && EMAIL
                        .find(&joined)
                        .is_some_and(|m| m.start() == 0 && m.end() == joined.len())
            }
            RedactCategory::Secret => {
                let digits = word.chars().any(|c| c.is_ascii_digit());
                let upper = word.chars().any(|c| c.is_ascii_uppercase());
                let lower = word.chars().any(|c| c.is_ascii_lowercase());
                !current.contains(' ')
                    && current.chars().count() >= 10
                    && word
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                    && if word.chars().count() <= 10 {
                        digits && (upper || lower) || upper && lower
                    } else {
                        word.chars().count() <= 48 && digits && upper && lower
                    }
            }
            _ => false,
        };
        if glue {
            finding.end = word_end;
        }
    }
    resolve_overlaps(findings)
}

fn classify_raw(text: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    let normalized = normalize_digits(text);
    let index = CharIndex::new(text);

    secrets(text, &index, &mut findings);
    emails(text, &index, &mut findings);
    cards_and_banks(text, &normalized, &index, &mut findings);
    phones(text, &normalized, &index, &mut findings);
    ips(text, &index, &mut findings);
    urls(text, &index, &mut findings);
    addresses(text, &index, &mut findings);
    for (start, end) in names::find_names(text) {
        push(&mut findings, RedactCategory::Name, start, end);
    }

    resolve_overlaps(findings)
}

/// Classifies every line of a frame, adding values whose label sits on
/// another line (a field labelled "Password" with the value under or beside
/// it).
pub fn classify_frame(lines: &[LineContext<'_>]) -> Vec<Vec<Finding>> {
    let mut results = lines
        .iter()
        .map(|line| classify_line(line.text))
        .collect::<Vec<_>>();
    for (label_index, label) in lines.iter().enumerate() {
        if !LABEL_ONLY.is_match(label.text) {
            continue;
        }
        let mut best: Option<(usize, f32)> = None;
        for (index, line) in lines.iter().enumerate() {
            if index == label_index || line.text.trim().chars().count() < 4 {
                continue;
            }
            let below = line.y > label.y
                && line.y - (label.y + label.h) < label.h * 2.5
                && line.x < label.x + label.w.max(label.h * 4.0)
                && line.x + line.w > label.x - label.h;
            let beside = (line.y + line.h * 0.5 - (label.y + label.h * 0.5)).abs() < label.h * 0.6
                && line.x > label.x + label.w
                && line.x - (label.x + label.w) < label.h * 12.0;
            if !(below || beside) {
                continue;
            }
            let distance = (line.y - label.y).abs() + (line.x - label.x).abs() * 0.25;
            if best.is_none_or(|(_, d)| distance < d) {
                best = Some((index, distance));
            }
        }
        if let Some((index, _)) = best {
            let text = lines[index].text;
            if looks_like_value(text) {
                let len = text.chars().count();
                let start = text.chars().take_while(|c| c.is_whitespace()).count();
                let end = len - text.chars().rev().take_while(|c| c.is_whitespace()).count();
                if end > start {
                    results[index].push(Finding {
                        category: RedactCategory::Secret,
                        start,
                        end,
                    });
                    results[index] = resolve_overlaps(std::mem::take(&mut results[index]));
                }
            }
        }
    }
    results
}

fn looks_like_value(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.contains(' ') && trimmed.split_whitespace().count() > 3 {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "show"
            | "hide"
            | "forgot password?"
            | "forgot password"
            | "required"
            | "optional"
            | "copy"
            | "reveal"
            | "generate"
            | "change"
            | "edit"
            | "save"
            | "cancel"
    ) && !lower.starts_with("enter ")
        && !lower.starts_with("must ")
        && !lower.starts_with("at least")
}

struct CharIndex {
    byte_to_char: Vec<usize>,
}

impl CharIndex {
    fn new(text: &str) -> Self {
        let mut byte_to_char = vec![0; text.len() + 1];
        let mut count = 0;
        for (byte, ch) in text.char_indices() {
            for slot in &mut byte_to_char[byte..byte + ch.len_utf8()] {
                *slot = count;
            }
            count += 1;
        }
        byte_to_char[text.len()] = count;
        Self { byte_to_char }
    }

    fn chars(&self, start: usize, end: usize) -> (usize, usize) {
        (self.byte_to_char[start], self.byte_to_char[end])
    }
}

fn push(findings: &mut Vec<Finding>, category: RedactCategory, start: usize, end: usize) {
    if end > start {
        findings.push(Finding {
            category,
            start,
            end,
        });
    }
}

fn push_bytes(
    findings: &mut Vec<Finding>,
    index: &CharIndex,
    category: RedactCategory,
    start: usize,
    end: usize,
) {
    let (start, end) = index.chars(start, end);
    push(findings, category, start, end);
}

/// Replaces letters the recogniser confuses with digits, inside tokens that
/// are mostly digits. Keeps byte offsets (every swap is ASCII for ASCII).
fn normalize_digits(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for token in split_keep(text) {
        let ascii = token.is_ascii();
        let digits = token.chars().filter(char::is_ascii_digit).count();
        let confusable = token
            .chars()
            .filter(|c| matches!(c, 'O' | 'o' | 'l' | 'I' | '|' | 'S' | 'B'))
            .count();
        let alnum = token.chars().filter(|c| c.is_ascii_alphanumeric()).count();
        if ascii && digits >= 2 && confusable > 0 && digits * 10 >= alnum * 7 {
            out.extend(token.chars().map(|c| match c {
                'O' | 'o' => '0',
                'l' | 'I' | '|' => '1',
                'S' => '5',
                'B' => '8',
                other => other,
            }));
        } else {
            out.push_str(token);
        }
    }
    out
}

fn split_keep(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut start = 0;
    let mut in_space = None;
    for (index, ch) in text.char_indices() {
        let space = ch.is_whitespace();
        if in_space.is_some_and(|previous| previous != space) {
            parts.push(&text[start..index]);
            start = index;
        }
        in_space = Some(space);
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

fn secrets(text: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    for (start, end) in crate::gitleaks::find(text) {
        push_bytes(findings, index, RedactCategory::Secret, start, end);
    }
    for found in KNOWN_TOKENS.find_iter(text) {
        push_bytes(
            findings,
            index,
            RedactCategory::Secret,
            found.start(),
            found.end(),
        );
    }
    for captures in ASSIGNED_SECRET.captures_iter(text) {
        let (Some(key), Some(value)) = (captures.get(1), captures.get(2)) else {
            continue;
        };
        if assigned_value_is_secret(key.as_str(), value.as_str()) {
            push_bytes(
                findings,
                index,
                RedactCategory::Secret,
                value.start(),
                value.end(),
            );
        }
    }
    for captures in BEARER.captures_iter(text) {
        if let Some(value) = captures.get(1).or_else(|| captures.get(2)) {
            push_bytes(
                findings,
                index,
                RedactCategory::Secret,
                value.start(),
                value.end(),
            );
        }
    }
    for captures in URL_CREDENTIALS.captures_iter(text) {
        if let Some(password) = captures.get(1) {
            push_bytes(
                findings,
                index,
                RedactCategory::Secret,
                password.start(),
                password.end(),
            );
        }
    }
    for captures in SPACED_SECRET.captures_iter(text) {
        if let Some(value) = captures.get(1)
            && !value.as_str().chars().all(|c| matches!(c, '*' | '•' | '●'))
        {
            push_bytes(
                findings,
                index,
                RedactCategory::Secret,
                value.start(),
                value.end(),
            );
        }
    }
    for found in TOKENISH.find_iter(text) {
        let token = found
            .as_str()
            .trim_matches(|c| matches!(c, '.' | '=' | '-' | '_'));
        let before = &text[..found.start()];
        if before.ends_with(':') && before.to_ascii_lowercase().ends_with("sha256:") {
            continue;
        }
        if high_entropy_token(token) || hex_secret(token, before) {
            push_bytes(
                findings,
                index,
                RedactCategory::Secret,
                found.start(),
                found.end(),
            );
        }
    }
}

/// Bare 32+ character hex reads as a key; a 40 character one (a git object
/// id) or any hex after a word like "commit" or "sha256:" does not.
fn hex_secret(token: &str, before: &str) -> bool {
    HEX_ONLY.is_match(token)
        && token.len() >= 32
        && token.len() != 40
        && token.chars().any(|c| c.is_ascii_alphabetic())
        && token.chars().any(|c| c.is_ascii_digit())
        && !COMMIT_CONTEXT.is_match(before)
}

fn assigned_value_is_secret(key: &str, value: &str) -> bool {
    let lower_value = value.to_ascii_lowercase();
    let lower_key = key.to_ascii_lowercase();
    if lower_value
        .chars()
        .all(|c| c == '*' || c == '•' || c == '●' || c == 'x')
    {
        return false;
    }
    if matches!(
        lower_value.as_str(),
        "true"
            | "false"
            | "null"
            | "none"
            | "nil"
            | "undefined"
            | "required"
            | "optional"
            | "string"
            | "str"
            | "number"
            | "int"
            | "bool"
            | "boolean"
            | "text"
            | "password"
            | "secret"
            | "token"
            | "hidden"
            | "env"
            | "process.env"
            | "os.environ"
            | "self"
            | "this"
            | "value"
            | "input"
            | "type"
            | "default"
            | "<redacted>"
            | "redacted"
    ) {
        return false;
    }
    if lower_value.starts_with("process.env")
        || lower_value.starts_with("os.environ")
        || lower_value.starts_with("env.")
        || lower_value.starts_with("env(")
        || lower_value.starts_with("${")
        || lower_value.starts_with("$(")
        || lower_value.starts_with("{{")
        || lower_value.starts_with("getenv")
        || lower_value.starts_with("std::env")
        || lower_value.ends_with("()")
        || lower_value.ends_with('(')
    {
        return false;
    }
    if lower_key.contains("type")
        || lower_key.contains("length")
        || lower_key.contains("field")
        || lower_key.contains("label")
        || lower_key.contains("placeholder")
        || lower_key.contains("expir")
        || lower_key.ends_with("_url")
        || lower_key.ends_with("path")
        || lower_key.contains("count")
    {
        return false;
    }
    let short_key = matches!(lower_key.trim(), "pin" | "otp" | "pass" | "pwd" | "auth");
    if short_key && value.len() < 4 {
        return false;
    }
    if lower_key.trim() == "pin" || lower_key.trim() == "otp" {
        return value.chars().all(|c| c.is_ascii_digit()) && (4..=8).contains(&value.len());
    }
    if value.chars().all(|c| c.is_ascii_alphabetic() || c == '_')
        && value.chars().any(|c| c == '_')
        && value.to_ascii_uppercase() == value
    {
        // FOO_BAR style references to another variable.
        return false;
    }
    true
}

fn shannon_entropy(token: &str) -> f64 {
    let mut counts = [0u32; 128];
    let mut total = 0u32;
    for byte in token.bytes() {
        if byte < 128 {
            counts[byte as usize] += 1;
            total += 1;
        }
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = f64::from(*count) / f64::from(total);
            -p * p.log2()
        })
        .sum()
}

fn high_entropy_token(token: &str) -> bool {
    if token.len() < 20 || token.contains("://") || token.starts_with("www.") {
        return false;
    }
    if token.contains('/')
        && token
            .split('/')
            .filter(|part| !part.is_empty())
            .all(|part| {
                part.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.')
                }) || part
                    .chars()
                    .all(|c| c.is_ascii_alphabetic() || matches!(c, '-' | '_' | '.'))
            })
    {
        return false;
    }
    if token.contains('.')
        && token.split('.').all(|part| {
            part.chars()
                .all(|c| c.is_ascii_lowercase() || c == '_' || c == '-')
        })
    {
        return false;
    }
    if UUID.is_match(token) || HEX_ONLY.is_match(token) {
        return false;
    }
    let upper = token.chars().any(|c| c.is_ascii_uppercase());
    let lower = token.chars().any(|c| c.is_ascii_lowercase());
    let digit = token.chars().filter(char::is_ascii_digit).count();
    if !(upper && lower && digit >= 2) {
        return false;
    }
    // camelCase identifiers and words joined by separators are long but read
    // as words: they have long letter runs and few case switches per char.
    let switches = token
        .as_bytes()
        .windows(2)
        .filter(|pair| char_class(pair[0]) != char_class(pair[1]))
        .count();
    let longest_letters = token
        .split(|c: char| !c.is_ascii_alphabetic())
        .map(str::len)
        .max()
        .unwrap_or(0);
    let switch_rate = switches as f64 / token.len() as f64;
    let base64 = token.contains(['+', '/']) && token.len() >= 28;
    let long_key = token.len() >= 32 && shannon_entropy(token) >= 4.2;
    shannon_entropy(token) >= 3.7
        && (switch_rate >= 0.3 || base64 || long_key)
        && (longest_letters < 12 || base64 || long_key)
}

fn char_class(byte: u8) -> u8 {
    if byte.is_ascii_uppercase() {
        0
    } else if byte.is_ascii_lowercase() {
        1
    } else if byte.is_ascii_digit() {
        2
    } else {
        3
    }
}

fn emails(text: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    let mut covered = Vec::new();
    let remote = |end: usize| text[end..].starts_with(':') && !text[end..].starts_with(": ");
    for found in EMAIL.find_iter(text) {
        if remote(found.end()) {
            covered.push(found.range());
            continue;
        }
        push_bytes(
            findings,
            index,
            RedactCategory::Email,
            found.start(),
            found.end(),
        );
        covered.push(found.range());
    }
    for found in PARTIAL_EMAIL.find_iter(text) {
        if covered
            .iter()
            .any(|range| range.start <= found.start() && found.end() <= range.end)
        {
            continue;
        }
        let at = text[found.start()..].find('@').unwrap() + found.start();
        let local = &text[found.start()..at];
        let domain = &text[at + 1..found.end()];
        let ip_like = domain.chars().all(|c| c.is_ascii_digit() || c == '.');
        if local.chars().count() >= 2 && !ip_like && !remote(found.end()) {
            push_bytes(
                findings,
                index,
                RedactCategory::Email,
                found.start(),
                found.end(),
            );
        }
    }
}

fn luhn_valid(digits: &[u8]) -> bool {
    let mut sum = 0u32;
    for (position, digit) in digits.iter().rev().enumerate() {
        let mut value = u32::from(*digit);
        if position % 2 == 1 {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
    }
    sum % 10 == 0
}

fn iban_valid(candidate: &str) -> bool {
    let compact = candidate
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>();
    if !(15..=34).contains(&compact.len()) {
        return false;
    }
    let (head, tail) = compact.split_at(4);
    let mut remainder = 0u32;
    for ch in tail.chars().chain(head.chars()) {
        let value = match ch {
            '0'..='9' => ch as u32 - '0' as u32,
            'A'..='Z' => ch as u32 - 'A' as u32 + 10,
            _ => return false,
        };
        remainder = if value >= 10 {
            (remainder * 100 + value) % 97
        } else {
            (remainder * 10 + value) % 97
        };
    }
    remainder == 1
}

fn aba_valid(digits: &[u8]) -> bool {
    if digits.len() != 9 {
        return false;
    }
    let weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
    let sum: u32 = digits
        .iter()
        .zip(weights)
        .map(|(digit, weight)| u32::from(*digit) * weight)
        .sum();
    sum % 10 == 0 && sum > 0
}

fn digits_of(text: &str) -> Vec<u8> {
    text.bytes()
        .filter(u8::is_ascii_digit)
        .map(|byte| byte - b'0')
        .collect()
}

fn separators_consistent(run: &str) -> bool {
    let separators = run
        .chars()
        .filter(|c| !c.is_ascii_digit())
        .collect::<String>();
    separators.chars().all(|c| c == ' ')
        || separators.chars().all(|c| c == '-')
        || separators.is_empty()
}

fn cards_and_banks(text: &str, normalized: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    for found in DIGIT_RUN.find_iter(normalized) {
        let run = found.as_str().trim_start_matches(['+', '(']);
        let digits = digits_of(run);
        let touches_word = normalized[..found.start()]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-')
            || normalized[found.end()..]
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-');
        if !touches_word
            && (13..=19).contains(&digits.len())
            && separators_consistent(run)
            && !run.contains(['.', '/', '(', ')'])
            && luhn_valid(&digits)
            && !digits.iter().all(|d| *d == digits[0])
        {
            push_bytes(
                findings,
                index,
                RedactCategory::Card,
                found.start(),
                found.end(),
            );
        }
    }
    for found in IBAN.find_iter(normalized) {
        if iban_valid(found.as_str()) {
            push_bytes(
                findings,
                index,
                RedactCategory::Card,
                found.start(),
                found.end(),
            );
        }
    }
    if ACCOUNT_CONTEXT.is_match(text) {
        for found in DIGIT_RUN.find_iter(normalized) {
            let run = found.as_str();
            let digits = digits_of(run);
            if run.contains(['.', '/', '(', ')', '+']) {
                continue;
            }
            let sort_code = digits.len() == 6 && run.matches('-').count() == 2;
            if (6..=17).contains(&digits.len()) || sort_code || aba_valid(&digits) {
                // The label right before the number goes with it ("Account
                // 4899325039"): what the number is matters as much.
                let start = ACCOUNT_CONTEXT
                    .find_iter(text)
                    .filter(|m| m.end() <= found.start() && found.start() - m.end() <= 12)
                    .last()
                    .map_or(found.start(), |m| m.start());
                push_bytes(findings, index, RedactCategory::Card, start, found.end());
            }
        }
        for found in SWIFT.find_iter(text) {
            let code = found.as_str();
            if code.chars().skip(4).take(2).all(|c| c.is_ascii_uppercase())
                && code.chars().any(|c| c.is_ascii_uppercase())
                && !code.chars().all(|c| c.is_ascii_uppercase())
                || text.to_ascii_lowercase().contains("swift")
                || text.to_ascii_lowercase().contains("bic")
            {
                push_bytes(
                    findings,
                    index,
                    RedactCategory::Card,
                    found.start(),
                    found.end(),
                );
            }
        }
    }
}

fn is_phone(run: &str, context: bool) -> bool {
    if DATE_LIKE.is_match(run) || run.contains('/') {
        return false;
    }
    let digits = digits_of(run);
    let count = digits.len();
    if run.starts_with('+') {
        (8..=15).contains(&count) && INTERNATIONAL.is_match(run)
    } else if NANP.is_match(run) {
        true
    } else if TRUNK_GROUPED.is_match(run) && (9..=12).contains(&count) {
        !run.contains('.') || run.matches('.').count() >= 2
    } else {
        context
            && (7..=15).contains(&count)
            && !run.contains('.')
            && !(count >= 13 && luhn_valid(&digits))
    }
}

fn phones(text: &str, normalized: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    let context = PHONE_CONTEXT.is_match(text);
    for found in DIGIT_RUN.find_iter(normalized) {
        // The run can swallow neighbours ("(415) 555-0132 (9am"); try the
        // longest piece made of whole space-separated groups that reads as a
        // phone number.
        let run = found.as_str();
        let mut groups = Vec::new();
        let mut group_start = None;
        for (offset, ch) in run.char_indices() {
            match (ch == ' ', group_start) {
                (false, None) => group_start = Some(offset),
                (true, Some(start)) => {
                    groups.push((start, offset));
                    group_start = None;
                }
                _ => {}
            }
        }
        if let Some(start) = group_start {
            groups.push((start, run.len()));
        }
        let mut first = 0;
        while first < groups.len() {
            let mut matched = None;
            for last in (first..groups.len()).rev() {
                let mut start = found.start() + groups[first].0;
                let mut end = found.start() + groups[last].1;
                let mut piece = &normalized[start..end];
                if piece.starts_with('(') && !piece.contains(')') {
                    piece = &piece[1..];
                    start += 1;
                }
                if piece.ends_with('(') {
                    piece = &piece[..piece.len() - 1];
                    end -= 1;
                }
                if piece.ends_with(')') && !piece.contains('(') {
                    piece = &piece[..piece.len() - 1];
                    end -= 1;
                }
                let before = normalized[..start].chars().next_back();
                let after = normalized[end..].chars().next();
                let boxed_in = before
                    .is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == '#' || c == '$')
                    || after.is_some_and(|c| c.is_ascii_alphanumeric() || c == '%')
                    || after == Some('.')
                        && normalized[end + 1..]
                            .chars()
                            .next()
                            .is_some_and(|c| c.is_ascii_digit());
                if !boxed_in && digits_of(piece).len() >= 7 && is_phone(piece, context) {
                    matched = Some((start, end, last));
                    break;
                }
            }
            match matched {
                Some((start, end, last)) => {
                    push_bytes(findings, index, RedactCategory::Phone, start, end);
                    first = last + 1;
                }
                None => first += 1,
            }
        }
    }
}

fn ips(text: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    let lower = text.to_ascii_lowercase();
    for captures in IPV4.captures_iter(text) {
        let Some(ip) = captures.get(1) else { continue };
        let before = &lower[..ip.start()];
        let last_word = before
            .trim_end()
            .rsplit(|c: char| !c.is_ascii_alphanumeric())
            .next()
            .unwrap_or("");
        if before.ends_with('v')
            || matches!(
                last_word,
                "v" | "version" | "ver" | "build" | "release" | "firmware"
            )
        {
            continue;
        }
        let address = ip.as_str();
        let suffix_word = text[ip.end()..]
            .strip_prefix('-')
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_alphabetic()));
        if suffix_word
            || address == "127.0.0.1"
            || address == "0.0.0.0"
            || address.starts_with("255.")
            || address.split('.').all(|part| part.len() == 1)
        {
            continue;
        }
        let whole_end = captures.get(0).map_or(ip.end(), |m| m.end());
        let tail = &text[ip.end()..whole_end];
        let suffix = tail
            .char_indices()
            .take_while(|(_, c)| c.is_ascii_digit() || *c == ':' || *c == '/')
            .last()
            .map_or(0, |(offset, c)| offset + c.len_utf8());
        push_bytes(
            findings,
            index,
            RedactCategory::Ip,
            ip.start(),
            ip.end() + suffix,
        );
    }
    for captures in IPV6.captures_iter(text) {
        let Some(ip) = captures.get(1) else { continue };
        let value = ip.as_str();
        let groups = value
            .split(':')
            .filter(|g| !g.is_empty())
            .collect::<Vec<_>>();
        let has_hex_letter = value.chars().any(|c| c.is_ascii_alphabetic());
        let long_group = groups.iter().any(|g| g.len() >= 3);
        if value == "::" || value == "::1" || groups.len() < 2 {
            continue;
        }
        if !(has_hex_letter || long_group || value.contains("::")) {
            continue;
        }
        if groups
            .iter()
            .all(|g| g.len() <= 2 && g.chars().all(|c| c.is_ascii_digit()))
        {
            continue;
        }
        push_bytes(findings, index, RedactCategory::Ip, ip.start(), ip.end());
    }
}

const FILE_EXTENSIONS: [&str; 12] = [
    ".io", ".sh", ".so", ".me", ".to", ".in", ".it", ".at", ".be", ".co", ".us", ".ai",
];

fn urls(text: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    for found in URL.find_iter(text) {
        let value = found
            .as_str()
            .trim_end_matches(['.', ',', ')', ']', ';', ':', '!', '?']);
        if value.contains('@') && !value.contains("://") {
            continue;
        }
        let bare = !value.contains("://") && !value.to_ascii_lowercase().starts_with("www.");
        if bare {
            let lower = value.to_ascii_lowercase();
            if !lower.contains('/')
                && FILE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext))
                && lower.matches('.').count() == 1
                && lower.len() < 8
            {
                continue;
            }
            let before = text[..found.start()].chars().next_back();
            if before.is_some_and(|c| c == '.' || c == '_' || c == '/' || c == '\\' || c == '@') {
                continue;
            }
            if lower.chars().next().is_some_and(|c| c.is_ascii_digit())
                && lower
                    .split('.')
                    .next()
                    .is_some_and(|p| p.chars().all(|c| c.is_ascii_digit()))
            {
                continue;
            }
        }
        push_bytes(
            findings,
            index,
            RedactCategory::Url,
            found.start(),
            found.start() + value.len(),
        );
    }
}

fn addresses(text: &str, index: &CharIndex, findings: &mut Vec<Finding>) {
    let mut streets = STREET
        .find_iter(text)
        .chain(EU_STREET.find_iter(text))
        .map(|m| (m.start(), m.end()))
        .collect::<Vec<_>>();
    streets.sort_unstable();
    for (start, mut end) in streets {
        if let Some(tail) = ADDRESS_TAIL.find(&text[end..]) {
            end += tail.end();
        }
        push_bytes(findings, index, RedactCategory::Address, start, end);
    }
    for found in CITY_STATE_ZIP.find_iter(text) {
        push_bytes(
            findings,
            index,
            RedactCategory::Address,
            found.start(),
            found.end(),
        );
    }
    for found in UK_POSTCODE.find_iter(text) {
        push_bytes(
            findings,
            index,
            RedactCategory::Address,
            found.start(),
            found.end(),
        );
    }
    if let Some(captures) = ADDRESS_CONTEXT.captures(text)
        && let Some(value) = captures.get(1)
        && value.as_str().chars().any(|c| c.is_ascii_digit())
    {
        push_bytes(
            findings,
            index,
            RedactCategory::Address,
            value.start(),
            value.end(),
        );
    }
}

/// Merges overlapping findings of the same category. Findings of different
/// categories may overlap (a token inside a link is both), so each category
/// hides everything it covers whichever others are on.
fn resolve_overlaps(mut findings: Vec<Finding>) -> Vec<Finding> {
    findings.sort_by_key(|f| (f.category, f.start, std::cmp::Reverse(f.end)));
    let mut kept: Vec<Finding> = Vec::new();
    for finding in findings {
        if let Some(last) = kept.last_mut()
            && last.category == finding.category
            && finding.start <= last.end
        {
            last.end = last.end.max(finding.end);
            continue;
        }
        kept.push(finding);
    }
    kept.sort_by_key(|f| (f.start, f.category));
    kept
}

#[cfg(test)]
mod tests;
