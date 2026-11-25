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
#[derive(Clone)]
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
/// Three octets and a dot at the end of a line: an address cut off by a
/// window over it or the frame edge.
/// What a string cut by the frame's right edge starts with, and what one cut
/// by its left edge ends with: eight or more digits (a card or account
/// number), an IBAN's country, check digits and first groups, or a long
/// key-like token.
static CUT_RIGHT: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^0-9A-Za-z])((?:[0-9][ \-]?){7}[0-9][0-9 \-]*|[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]{4}){1,}[A-Z0-9 ]*|[A-Za-z0-9_\-]{20,})\s*$",
    )
});
static CUT_LEFT: LazyLock<Regex> = LazyLock::new(|| {
    re(r"^\s*([0-9 \-]*(?:[0-9][ \-]?){7}[0-9]|[A-Za-z0-9_\-]{20,})(?:$|[^0-9A-Za-z])")
});
/// Lines whose left or right end is within this fraction of the frame's width
/// of its edge are cut by it.
const FRAME_EDGE: f32 = 0.002;

/// A whole line of three IPv4 octets: an address its cell or pane cuts off.
static IPV4_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){2}\.?\s*$",
    )
});
static CUT_IPV4: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:^|[^0-9A-Za-z.])((?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){2}\.)\s*$",
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
/// A date, with the time after it when there is one (a log or table
/// timestamp, its seconds or minutes possibly cut off), or a clock time.
static DATE_TIME: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?:[0-9]{4}[\-/.][0-9]{1,2}[\-/.][0-9]{1,2}|[0-9]{1,2}[\-/.][0-9]{1,2}[\-/.][0-9]{2,4})(?:[ T][0-9]{1,2}(?::[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]{1,6})?)?)?)?|[0-9]{1,2}:[0-9]{2}(?::[0-9]{2}(?:[.,][0-9]{1,6})?)?",
    )
});
/// A year and month alone, the start of a cut-off date ("2026-11-").
static YEAR_MONTH: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\s*(?:19|20)[0-9]{2}[\-/.](?:0?[1-9]|1[0-2])[\-/.]?\s*$"));
static ACCOUNT_CONTEXT: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?i)\b(?:account|acct|a/c|routing|sort\s*code|bsb|aba|swift|bic|iban|bank)")
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
/// A capitalised name of two to four words before an address in angle
/// brackets: "Jane Roe <jane@example.com>".
static DISPLAY_NAME: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?:^|[:\s,])(\p{Lu}[\p{L}'.\-]*(?:\s+\p{Lu}[\p{L}'.\-]*){1,3})\s*<[^<>\s]+@[^<>\s]+>")
});
/// A person field: "From: Jane Roe", "Organizer: John Roe".
static PERSON_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:From|To|Cc|Bcc|Reply-To|Sender|Attendees?|Organi[sz]er|Assignee|Owner|Reporter|Host)\s*:\s*(\p{Lu}[\p{L}'.\-]*(?:\s+\p{Lu}[\p{L}'.\-]*){1,3})\s*(?:$|<|,|\()",
    )
});
/// "Hi Juno,", "Dear Jane Roe,".
static SALUTATION: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"^\s*(?:Hi|Hello|Hey|Dear|Thanks|Thank you)\s+(\p{Lu}[\p{L}'\-]+(?:\s+\p{Lu}[\p{L}'\-]+){0,2})\s*[,!]",
    )
});
/// A line that is only a capitalised name of one to four words.
static NAME_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^\s*\p{Lu}[\p{L}'.\-]*(?:\s+\p{Lu}[\p{L}'.\-]*){0,3}\s*$"));
static SIGN_OFF: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^\s*(?:best|thanks|thank you|regards|cheers|sincerely|kind regards|best regards|warm regards|many thanks|all the best),?\s*$",
    )
});
static CLOCK: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)^\s*\d{1,2}:\d{2}\s*(?:am|pm)?\s*$"));
static LABEL_ONLY: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r"(?i)^\s*(?:[a-z\-]+\s+){0,3}(?:password|passcode|passphrase|secret|key|api\s*key|token|credentials?|pin|recovery\s*(?:code|phrase)|seed\s*phrase)\s*[:*]?\s*$",
    )
});
static PIN_LABEL: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\b(?:pin|passcode)\b"));
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
static TOKENISH: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9+/_\-.~|]{20,}={0,2}"));
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
    let findings = glue_split_tokens(text, findings);
    widen(text, findings)
}

/// Capitalised words that stand next to names without being part of them.
const NOT_NAMES: [&str; 16] = [
    "hi", "hello", "hey", "dear", "thanks", "from", "to", "cc", "bcc", "by", "with", "for", "the",
    "and", "mr", "ms",
];

/// Grows every finding to whole tokens, and a name over the capitalised
/// words and initials right next to it ("Rosa" in "Rosa Testa" when only
/// the surname is a known name), so a mask never stops inside a word.
fn widen(text: &str, findings: Vec<Finding>) -> Vec<Finding> {
    let chars = text.chars().collect::<Vec<_>>();
    let word_at = |start: usize| {
        let end = (start..chars.len())
            .find(|i| chars[*i].is_whitespace())
            .unwrap_or(chars.len());
        (start, end)
    };
    let name_like = |(start, end): (usize, usize)| {
        let word = &chars[start..end];
        let lower = word.iter().collect::<String>().to_lowercase();
        let lower = lower.trim_end_matches([',', ':', '.']);
        !NOT_NAMES.contains(&lower)
            && word.first().is_some_and(|c| c.is_uppercase())
            && word
                .iter()
                .all(|c| c.is_alphabetic() || matches!(c, '.' | '\'' | '-'))
    };
    let widened = findings
        .into_iter()
        .map(|mut f| {
            while f.start > 0 && chars[f.start - 1].is_alphanumeric() {
                f.start -= 1;
            }
            while f.end < chars.len() && chars[f.end].is_alphanumeric() {
                f.end += 1;
            }
            if f.category == RedactCategory::Name {
                for _ in 0..2 {
                    let before = (0..f.start).rev().find(|i| !chars[*i].is_whitespace());
                    let Some(last) = before else { break };
                    let first = (0..=last)
                        .rev()
                        .take_while(|i| !chars[*i].is_whitespace())
                        .last()
                        .unwrap_or(last);
                    if !name_like((first, last + 1)) {
                        break;
                    }
                    f.start = first;
                }
                for _ in 0..2 {
                    let Some(next) = (f.end..chars.len()).find(|i| !chars[*i].is_whitespace())
                    else {
                        break;
                    };
                    let word = word_at(next);
                    if !name_like(word) {
                        break;
                    }
                    f.end = word.1;
                }
            }
            f
        })
        .collect();
    resolve_overlaps(widened)
}

/// Categories whose patterns are strict enough (checksums, fixed shapes) to
/// accept a match found only in a reading made of runner-up characters.
const STRICT: [RedactCategory; 4] = [
    RedactCategory::Card,
    RedactCategory::Phone,
    RedactCategory::Email,
    RedactCategory::Ip,
];

/// [`classify_line`], plus strict-pattern matches in the reading the
/// recogniser's runner-up characters make: a digit read as a letter next to
/// other digits ("ó011-7783-..." for a card), an "@" read as something else,
/// a space it nearly left out ("168. 144").
pub fn classify_line_with_alternatives(
    text: &str,
    alternatives: &[crate::model::Alternatives],
) -> Vec<Finding> {
    let mut findings = classify_line(text);
    let chars = text.chars().collect::<Vec<_>>();
    if alternatives.len() != chars.len() {
        return findings;
    }
    let (alternative, origin) = alternative_reading(&chars, alternatives);
    if alternative == text {
        return findings;
    }
    let before = findings.len();
    for found in classify_line(&alternative) {
        if !STRICT.contains(&found.category) || found.end == 0 || found.end > origin.len() {
            continue;
        }
        let start = origin[found.start];
        let end = origin[found.end - 1] + 1;
        let covered = findings
            .iter()
            .any(|f| f.category == found.category && f.start <= start && f.end >= end);
        if !covered {
            findings.push(Finding {
                category: found.category,
                start,
                end,
            });
        }
    }
    if findings.len() > before {
        findings = resolve_overlaps(findings);
    }
    findings
}

/// The reading with runner-up characters substituted, and for each of its
/// characters the index of the character it came from.
fn alternative_reading(
    chars: &[char],
    alternatives: &[crate::model::Alternatives],
) -> (String, Vec<usize>) {
    let digit_at = |i: Option<usize>| {
        i.and_then(|i| chars.get(i))
            .is_some_and(char::is_ascii_digit)
    };
    let mut text = String::with_capacity(chars.len());
    let mut origin = Vec::with_capacity(chars.len());
    for (index, (&ch, alternative)) in chars.iter().zip(alternatives).enumerate() {
        if ch == ' ' && alternative.blank >= 0.1 {
            continue;
        }
        let near_digit = digit_at(index.checked_sub(1))
            || digit_at(index.checked_sub(2))
            || digit_at(Some(index + 1))
            || digit_at(Some(index + 2));
        let mut out = ch;
        if near_digit
            && !ch.is_ascii_digit()
            && !matches!(ch, ' ' | '-' | '.' | '/' | '(' | ')' | '+' | ':')
            && let Some((digit, _)) = alternative
                .options
                .iter()
                .find(|(c, p)| c.is_ascii_digit() && *p >= 0.05)
        {
            out = *digit;
        }
        if ch != '@'
            && alternative
                .options
                .iter()
                .any(|(c, p)| *c == '@' && *p >= 0.05)
        {
            out = '@';
        }
        text.push(out);
        origin.push(index);
    }
    (text, origin)
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
    for pattern in [&*DISPLAY_NAME, &*PERSON_FIELD, &*SALUTATION] {
        for captures in pattern.captures_iter(text) {
            if let Some(name) = captures.get(1) {
                push_bytes(
                    &mut findings,
                    &index,
                    RedactCategory::Name,
                    name.start(),
                    name.end(),
                );
            }
        }
    }

    resolve_overlaps(findings)
}

/// Classifies every line of a frame, adding values whose label sits on
/// another line (a field labelled "Password" with the value under or beside
/// it).
pub fn classify_frame(lines: &[LineContext<'_>]) -> Vec<Vec<Finding>> {
    let results = lines
        .iter()
        .map(|line| classify_line(line.text))
        .collect::<Vec<_>>();
    classify_frame_with(lines, results)
}

/// [`classify_frame`] for lines whose own findings (`classify_line`) are
/// already known.
pub fn classify_frame_with(
    lines: &[LineContext<'_>],
    mut results: Vec<Vec<Finding>>,
) -> Vec<Vec<Finding>> {
    join_wrapped_lines(lines, &mut results);
    names_from_layout(lines, &mut results);
    ips_from_columns(lines, &mut results);
    cards_from_columns(lines, &mut results);
    cut_by_the_frame(lines, &mut results);
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
            if looks_like_value(text, label.text) {
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

/// The visible part of a number or key that runs out of the frame: digits,
/// an IBAN's start or a long token touching the edge it is cut by. A token
/// needs digits and both cases, so plain words never match.
fn cut_by_the_frame(lines: &[LineContext<'_>], results: &mut [Vec<Finding>]) {
    for (index, line) in lines.iter().enumerate() {
        let left = line.x <= FRAME_EDGE;
        let right = line.x + line.w >= 1.0 - FRAME_EDGE;
        let found = [(right, &*CUT_RIGHT), (left, &*CUT_LEFT)]
            .into_iter()
            .filter(|(cut, _)| *cut)
            .filter_map(|(_, pattern)| pattern.captures(line.text)?.get(1))
            .next();
        let Some(found) = found else { continue };
        let value = found.as_str();
        let digits = digits_outside_dates(value, 0, value.len());
        let token = value.len() >= 20
            && value.chars().any(|c| c.is_ascii_uppercase())
            && value.chars().any(|c| c.is_ascii_lowercase());
        let category = if digits >= 8 && !token {
            RedactCategory::Card
        } else if token && digits > 0 {
            RedactCategory::Secret
        } else if value.chars().take(2).all(|c| c.is_ascii_uppercase())
            && value.chars().filter(char::is_ascii_digit).count() >= 6
        {
            RedactCategory::Card
        } else {
            continue;
        };
        let start = line.text[..found.start()].chars().count();
        let end = start + value.trim_end().chars().count();
        if results[index]
            .iter()
            .any(|f| f.start <= start && f.end >= end)
        {
            continue;
        }
        results[index].push(Finding {
            category,
            start,
            end,
        });
        results[index] = resolve_overlaps(std::mem::take(&mut results[index]));
    }
}

/// Three octets alone on a line, in the same column as a line holding an IP
/// address (a sheet or table column too narrow for the whole address), are
/// the visible part of one.
fn ips_from_columns(lines: &[LineContext<'_>], results: &mut [Vec<Finding>]) {
    from_columns(lines, results, RedactCategory::Ip, |text| {
        IPV4_PREFIX.is_match(text)
    });
}

/// A line of 12 to 19 digits (spaces and dashes between groups), in the same
/// column as a line holding a card number, is one even when its checksum
/// fails: a run of the same narrow digit can be read a few digits short
/// ("4111111111111" for "4111111111111111").
fn cards_from_columns(lines: &[LineContext<'_>], results: &mut [Vec<Finding>]) {
    from_columns(lines, results, RedactCategory::Card, |text| {
        let trimmed = text.trim();
        let digits = trimmed.chars().filter(char::is_ascii_digit).count();
        trimmed
            .chars()
            .all(|c| c.is_ascii_digit() || c == ' ' || c == '-')
            && (12..=19).contains(&digits)
            && digits_outside_dates(trimmed, 0, trimmed.len()) == digits
    });
}

/// Marks as `category` every line `candidate` accepts that has no finding of
/// that category yet and shares a column (more than half the narrower width,
/// within eight line heights) with a line that has one.
fn from_columns(
    lines: &[LineContext<'_>],
    results: &mut [Vec<Finding>],
    category: RedactCategory,
    candidate: impl Fn(&str) -> bool,
) {
    let has = |index: usize| results[index].iter().any(|f| f.category == category);
    let found = (0..lines.len())
        .filter(|&index| !has(index) && candidate(lines[index].text))
        .filter(|&index| {
            let line = &lines[index];
            (0..lines.len()).any(|other| {
                let o = &lines[other];
                let shared = (line.x + line.w).min(o.x + o.w) - line.x.max(o.x);
                other != index
                    && has(other)
                    && shared > 0.5 * line.w.min(o.w)
                    && (o.y - line.y).abs() < line.h * 8.0
            })
        })
        .collect::<Vec<_>>();
    for index in found {
        let text = lines[index].text;
        let start = text.chars().take_while(|c| c.is_whitespace()).count();
        let end =
            text.chars().count() - text.chars().rev().take_while(|c| c.is_whitespace()).count();
        results[index].push(Finding {
            category,
            start,
            end,
        });
    }
}

/// Names the page's layout gives away: the line under a sign-off ("Best" /
/// "Jane Roe"), and a name with a clock time beside it on its row (a
/// sender in a message list).
fn names_from_layout(lines: &[LineContext<'_>], results: &mut [Vec<Finding>]) {
    let whole = |text: &str| {
        let start = text.chars().take_while(|c| c.is_whitespace()).count();
        let end =
            text.chars().count() - text.chars().rev().take_while(|c| c.is_whitespace()).count();
        (start, end)
    };
    for (index, line) in lines.iter().enumerate() {
        if !NAME_LINE.is_match(line.text) || line.text.trim().chars().count() < 3 {
            continue;
        }
        let words = line.text.split_whitespace().count();
        let signed = lines.iter().any(|above| {
            SIGN_OFF.is_match(above.text)
                && line.y > above.y
                && line.y - (above.y + above.h) < above.h * 2.5
                && (line.x - above.x).abs() < above.h * 2.0
        });
        let listed = words >= 2
            && lines.iter().any(|beside| {
                CLOCK.is_match(beside.text)
                    && beside.x > line.x + line.w
                    && ((beside.y + beside.h * 0.5) - (line.y + line.h * 0.5)).abs() < line.h * 0.5
            });
        if signed || listed {
            let (start, end) = whole(line.text);
            if end > start
                && !results[index]
                    .iter()
                    .any(|f| f.category == RedactCategory::Name && f.start <= start && f.end >= end)
            {
                results[index].push(Finding {
                    category: RedactCategory::Name,
                    start,
                    end,
                });
                results[index] = resolve_overlaps(std::mem::take(&mut results[index]));
            }
        }
    }
}

/// A string wrapped onto the next line ("+1 (436)" / "519-9838", "4013
/// Pine Court, Suite" / "754, Columbus, OH 26159") is only recognisable
/// whole: each line followed by the one right under it at the same left
/// edge is classified joined, and a finding across the join is split back
/// onto both lines.
fn join_wrapped_lines(lines: &[LineContext<'_>], results: &mut [Vec<Finding>]) {
    for (upper_index, upper) in lines.iter().enumerate() {
        let Some((lower_index, lower)) = lines.iter().enumerate().find(|(index, line)| {
            *index != upper_index
                && line.y > upper.y
                && line.y - (upper.y + upper.h) < upper.h * 0.8
                && (line.x - upper.x).abs() < upper.h * 1.5
                && (line.h - upper.h).abs() < upper.h * 0.35
        }) else {
            continue;
        };
        let upper_len = upper.text.chars().count();
        // Glued as well as spaced: a wrap after a hyphen ("(631) 555-" /
        // "0153") or inside a token leaves no space in the string.
        for joiner in [" ", ""] {
            let gap = joiner.len();
            let joined = format!("{}{joiner}{}", upper.text, lower.text);
            for finding in classify_line(&joined) {
                if finding.start >= upper_len || finding.end <= upper_len + gap {
                    continue;
                }
                let already = |found: &[Finding], start: usize, end: usize| {
                    found
                        .iter()
                        .any(|f| f.category == finding.category && f.start <= start && f.end >= end)
                };
                let (upper_start, upper_end) = (finding.start, upper_len);
                let (lower_start, lower_end) = (0, finding.end - upper_len - gap);
                if !already(&results[upper_index], upper_start, upper_end) {
                    results[upper_index].push(Finding {
                        category: finding.category,
                        start: upper_start,
                        end: upper_end,
                    });
                }
                if !already(&results[lower_index], lower_start, lower_end) {
                    results[lower_index].push(Finding {
                        category: finding.category,
                        start: lower_start,
                        end: lower_end,
                    });
                }
            }
        }
    }
    for found in results.iter_mut() {
        *found = resolve_overlaps(std::mem::take(found));
    }
}

/// A labelled value is one token of at least this many characters.
const MIN_VALUE_CHARS: usize = 6;

/// Whether the line under or beside a secret's label holds its value: a
/// masked field, or one token of at least [`MIN_VALUE_CHARS`] characters
/// mixing two kinds of character (letters and digits, cases, symbols), or 4 to
/// 8 digits under a PIN or passcode label. Words and phrases are never a
/// value, whatever label is near them.
fn looks_like_value(text: &str, label: &str) -> bool {
    let trimmed = text.trim();
    if PIN_LABEL.is_match(label)
        && (4..=8).contains(&trimmed.chars().count())
        && trimmed.chars().all(|c| c.is_ascii_digit())
    {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    if matches!(
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
    ) || lower.starts_with("enter ")
        || lower.starts_with("must ")
        || lower.starts_with("at least")
    {
        return false;
    }
    let masked =
        trimmed.chars().count() >= 4 && trimmed.chars().all(|c| matches!(c, '•' | '●' | '*' | '·'));
    if masked {
        return true;
    }
    let classes = [
        trimmed.chars().any(|c| c.is_lowercase()),
        trimmed.chars().any(|c| c.is_uppercase()),
        trimmed.chars().any(|c| c.is_ascii_digit()),
        trimmed.chars().any(|c| !c.is_alphanumeric()),
    ];
    !trimmed.contains(char::is_whitespace)
        && trimmed.chars().count() >= MIN_VALUE_CHARS
        && classes.iter().filter(|c| **c).count() >= 2
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
    // The country code is letters, which digit normalisation turns into
    // digits ("ES42..." -> "E542..."), so both forms are tried.
    for source in [text, normalized] {
        for found in IBAN.find_iter(source) {
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
    }
    if ACCOUNT_CONTEXT.is_match(text) {
        for found in DIGIT_RUN.find_iter(normalized) {
            let run = found.as_str();
            let digits = digits_of(run);
            let sort_code = digits.len() == 6 && run.matches('-').count() == 2;
            if run.contains(['.', '/', '(', ')', '+'])
                || !sort_code && digits_outside_dates(normalized, found.start(), found.end()) < 6
            {
                continue;
            }
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

/// Digits in `start..end` of `text` that are not part of a date, timestamp
/// or clock time there (a run can span two timestamps, like a log column
/// joined across lines). A short day-month-year shape that runs on into more
/// digit groups ("06-12-34-56") is a number, not a date.
fn digits_outside_dates(text: &str, start: usize, end: usize) -> usize {
    let bytes = text.as_bytes();
    let digit = |i: Option<usize>| i.and_then(|i| bytes.get(i)).is_some_and(u8::is_ascii_digit);
    let separator = |i: Option<usize>| {
        i.and_then(|i| bytes.get(i))
            .is_some_and(|c| matches!(c, b'-' | b'/' | b'.' | b':'))
    };
    let runs_on_before = |at: usize| {
        digit(at.checked_sub(1)) || separator(at.checked_sub(1)) && digit(at.checked_sub(2))
    };
    let runs_on_after = |at: usize| digit(Some(at)) || separator(Some(at)) && digit(Some(at + 1));
    let dates = DATE_TIME
        .find_iter(text)
        .filter(|m| {
            let shape = m.as_str();
            let iso_or_time =
                shape.contains(':') || shape.as_bytes()[..4].iter().all(u8::is_ascii_digit);
            iso_or_time || !runs_on_before(m.start()) && !runs_on_after(m.end())
        })
        .map(|m| m.range())
        .collect::<Vec<_>>();
    text[start..end]
        .char_indices()
        .filter(|(i, c)| c.is_ascii_digit() && !dates.iter().any(|d| d.contains(&(start + i))))
        .count()
}

/// Whether a phone or card finding is really a date: a year-month fragment
/// ("2026-11-"), or a string with digits inside dates or times and fewer than
/// seven outside them (a timestamp). A number with no date in it (the first
/// half of a wrapped phone, "+1 (436)") is not one.
pub(crate) fn date_not_number(text: &str) -> bool {
    let all = text.chars().filter(char::is_ascii_digit).count();
    let outside = digits_outside_dates(text, 0, text.len());
    YEAR_MONTH.is_match(text) || all > outside && outside < 7
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
                if !boxed_in
                    && digits_of(piece).len() >= 7
                    && digits_outside_dates(normalized, start, end) >= 7
                    && is_phone(piece, context)
                {
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
    if let Some(cut) = CUT_IPV4.captures(text).and_then(|c| c.get(1))
        && cut
            .as_str()
            .split('.')
            .filter(|part| !part.is_empty())
            .any(|part| part.len() > 1)
    {
        push_bytes(findings, index, RedactCategory::Ip, cut.start(), cut.end());
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
