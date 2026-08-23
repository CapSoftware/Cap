//! Scrubs credentials out of log text before it leaves the machine.
//!
//! The desktop apps upload a tail of their log file alongside a diagnostic
//! report. Logs are written for local debugging and routinely contain URLs
//! that carry credentials in their query string -- most importantly presigned
//! S3 PUT URLs, which are live write capabilities for up to three hours.
//! `reqwest::Error`'s `Display` appends `" for url (<url>)"`, so any logged
//! upload error carries one.
//!
//! This runs at the upload seam rather than at each logging call site: a call
//! site can be fixed once, but a new one is added every time somebody logs an
//! error that happens to carry a URL. Fixing the worst offenders at source AND
//! scrubbing here is deliberate belt-and-braces.

/// Query parameters whose values are credentials. Matched case-insensitively.
const SENSITIVE_PARAMS: &[&str] = &[
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "awsaccesskeyid",
    "signature",
    "sig",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "key",
    "password",
    "secret",
];

/// URL prefixes that are themselves the secret, so the whole path is dropped.
const SENSITIVE_URL_PREFIXES: &[&str] = &[
    "https://hooks.slack.com/services/",
    "https://discord.com/api/webhooks/",
    "https://discordapp.com/api/webhooks/",
];

const REDACTED: &str = "[redacted]";

/// Replaces credential-bearing parts of every URL in `text`.
///
/// Everything that is not a URL is left exactly as it was, so the log stays
/// readable and line numbers/timestamps are untouched.
pub fn scrub_log_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(start) = find_url_start(rest) {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let end = tail.find(url_terminator).unwrap_or(tail.len());
        out.push_str(&scrub_url(&tail[..end]));
        rest = &tail[end..];
    }

    out.push_str(rest);
    out
}

fn find_url_start(text: &str) -> Option<usize> {
    let http = text.find("http://");
    let https = text.find("https://");
    match (http, https) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// A URL in a log line ends at whitespace or at punctuation that log
/// formatting wraps it in. `/`, `?`, `&`, `=`, `%`, `.`, `-`, `_`, `~` and `+`
/// are all legal inside one, so they are not terminators.
fn url_terminator(c: char) -> bool {
    c.is_whitespace()
        || matches!(
            c,
            '"' | '\'' | '<' | '>' | '`' | '|' | '\\' | '^' | '{' | '}'
        )
}

fn scrub_url(url: &str) -> String {
    // Trailing punctuation belongs to the sentence, not the URL.
    let trimmed_len = url.trim_end_matches([')', ']', ',', ';', ':', '.']).len();
    let (url, trailer) = url.split_at(trimmed_len);

    if let Some(prefix) = SENSITIVE_URL_PREFIXES.iter().find(|prefix| {
        url.len() >= prefix.len() && url[..prefix.len()].eq_ignore_ascii_case(prefix)
    }) {
        return format!("{prefix}{REDACTED}{trailer}");
    }

    let Some(query_start) = url.find('?') else {
        return format!("{url}{trailer}");
    };

    let (base, query) = url.split_at(query_start);
    let query = &query[1..];

    let mut scrubbed = String::with_capacity(query.len());
    for (index, pair) in query.split('&').enumerate() {
        if index > 0 {
            scrubbed.push('&');
        }
        match pair.split_once('=') {
            Some((name, _)) if is_sensitive_param(name) => {
                scrubbed.push_str(name);
                scrubbed.push('=');
                scrubbed.push_str(REDACTED);
            }
            _ => scrubbed.push_str(pair),
        }
    }

    format!("{base}?{scrubbed}{trailer}")
}

fn is_sensitive_param(name: &str) -> bool {
    SENSITIVE_PARAMS
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_presigned_put_url_loses_its_signature_and_credential() {
        let line = "Chunk upload failed error=error sending request for url (https://bucket.s3.amazonaws.com/vid/1.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20260822%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260822T101500Z&X-Amz-Expires=3600&X-Amz-Signature=deadbeefcafe&X-Amz-SignedHeaders=host)";
        let scrubbed = scrub_log_text(line);

        assert!(!scrubbed.contains("deadbeefcafe"), "{scrubbed}");
        assert!(!scrubbed.contains("AKIAEXAMPLE"), "{scrubbed}");
        // The parts that make the log useful survive.
        assert!(scrubbed.contains("bucket.s3.amazonaws.com/vid/1.mp4"));
        assert!(scrubbed.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(scrubbed.contains("X-Amz-Expires=3600"));
        assert!(scrubbed.contains("X-Amz-Signature=[redacted]"));
        assert!(scrubbed.contains("Chunk upload failed"));
    }

    #[test]
    fn a_slack_webhook_keeps_only_its_prefix() {
        let scrubbed = scrub_log_text(
            "sending webhook url=https://hooks.slack.com/services/T00/B00/XXXXsecret",
        );
        assert!(!scrubbed.contains("XXXXsecret"), "{scrubbed}");
        assert!(scrubbed.contains("https://hooks.slack.com/services/[redacted]"));
    }

    #[test]
    fn ordinary_text_and_plain_urls_are_untouched() {
        let line = "opened https://cap.so/s/abc123 for the user at /Users/x/Movies/a.cap";
        assert_eq!(scrub_log_text(line), line);
    }

    #[test]
    fn trailing_punctuation_stays_outside_the_url() {
        let scrubbed = scrub_log_text("failed (https://x.test/a?token=abc).");
        assert_eq!(scrubbed, "failed (https://x.test/a?token=[redacted]).");
    }

    #[test]
    fn multiple_urls_on_one_line_are_all_scrubbed() {
        let scrubbed =
            scrub_log_text("a https://x.test/1?sig=one b https://y.test/2?X-Amz-Signature=two c");
        assert!(!scrubbed.contains("=one"), "{scrubbed}");
        assert!(!scrubbed.contains("=two"), "{scrubbed}");
        assert!(scrubbed.contains(" b "));
        assert!(scrubbed.ends_with(" c"));
    }

    #[test]
    fn a_case_variant_parameter_is_still_redacted() {
        let scrubbed = scrub_log_text("https://x.test/a?ACCESS_TOKEN=zzz");
        assert!(!scrubbed.contains("zzz"), "{scrubbed}");
    }

    #[test]
    fn empty_and_urlless_input_round_trips() {
        assert_eq!(scrub_log_text(""), "");
        assert_eq!(scrub_log_text("no urls here"), "no urls here");
    }

    /// The scrubber also runs over the report and diagnostics JSON, so it must
    /// never introduce a character that breaks the document.
    #[test]
    fn scrubbing_json_leaves_it_parseable() {
        let doc = serde_json::json!({
            "syncTestError": "error sending request for url (https://b.s3.amazonaws.com/x?X-Amz-Signature=secret123&X-Amz-Expires=3600)",
            "nested": { "path": "~/Movies/a.cap", "count": 3 },
        });
        let scrubbed = scrub_log_text(&doc.to_string());

        let parsed: serde_json::Value =
            serde_json::from_str(&scrubbed).expect("scrubbed JSON must still parse");
        let error = parsed["syncTestError"].as_str().unwrap();
        assert!(!error.contains("secret123"), "{error}");
        assert!(error.contains("X-Amz-Signature=[redacted]"), "{error}");
        assert!(error.contains("X-Amz-Expires=3600"), "{error}");
        assert_eq!(parsed["nested"]["count"], 3);
    }

    #[test]
    fn multibyte_text_survives() {
        let line = "café ✅ https://x.test/a?token=abc ünïcode";
        let scrubbed = scrub_log_text(line);
        assert!(scrubbed.starts_with("café ✅ "));
        assert!(scrubbed.ends_with(" ünïcode"));
        assert!(!scrubbed.contains("=abc"));
    }
}
