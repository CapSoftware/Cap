use std::time::Duration;

use serde::Deserialize;

use super::timeline::{self, RATE};

pub const CLIP_MAX_SECONDS: u64 = 120;
pub const CLIP_MAX_BYTES: usize = 4_000_000;
pub const KEYWORDS_HEADER: &str = "x-cap-keywords";
const KEYWORDS_MAX: usize = 100;
const KEYWORD_MAX_CHARS: usize = 50;
const KEYWORDS_HEADER_MAX: usize = 8_000;
const TARGET_MIN_MS: u64 = 20_000;
const TARGET_FULL_MS: u64 = 28_000;
const BILLING_STEP_MS: u64 = 10_000;
const BILLING_SLACK_MS: u64 = 2_000;
pub const IDLE_FLUSH: Duration = Duration::from_secs(8);
const GAP_MS: u64 = 200;
const HARD_MAX_MS: u64 = 110_000;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Limits {
    pub max_clip_seconds: u64,
    pub max_clip_bytes: u64,
    pub max_transcript_chars: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Capabilities {
    pub transcription: bool,
    pub notes: bool,
    pub limits: Limits,
    pub notes_trial_remaining: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloudError {
    NotSignedIn,
    UpgradeRequired,
    RateLimited { retry_after_secs: u64 },
    NotConfigured,
    Offline(String),
    Failed(String),
}

impl CloudError {
    /// The server's answer for this account, as opposed to a failure that
    /// may clear on its own (offline, rate limited, a server error).
    pub fn is_final(&self) -> bool {
        matches!(
            self,
            CloudError::NotSignedIn | CloudError::UpgradeRequired | CloudError::NotConfigured
        )
    }

    pub fn describe(&self) -> String {
        match self {
            CloudError::NotSignedIn => "Sign in to use cloud transcription".into(),
            CloudError::UpgradeRequired => "Cloud transcription needs Cap Pro".into(),
            CloudError::RateLimited { retry_after_secs } => {
                format!("Cloud transcription is busy, retrying in {retry_after_secs}s")
            }
            CloudError::NotConfigured => "Cloud transcription is not available right now".into(),
            CloudError::Offline(reason) => format!("Could not reach Cap: {reason}"),
            CloudError::Failed(reason) => format!("Cloud transcription failed: {reason}"),
        }
    }
}

#[derive(Deserialize)]
struct ErrorBody {
    #[serde(default)]
    error: String,
    #[serde(default, rename = "retryAfterSeconds")]
    retry_after_seconds: Option<u64>,
}

pub fn classify_status(status: u16, body: &str, retry_header: Option<u64>) -> CloudError {
    let parsed: Option<ErrorBody> = serde_json::from_str(body).ok();
    match status {
        401 => CloudError::NotSignedIn,
        402 => CloudError::UpgradeRequired,
        429 => CloudError::RateLimited {
            retry_after_secs: parsed
                .and_then(|b| b.retry_after_seconds)
                .or(retry_header)
                .unwrap_or(30)
                .clamp(1, 3_600),
        },
        // The meeting endpoints never answer 404 themselves: it means this server doesn't have them yet.
        404 => CloudError::NotConfigured,
        // Cap's own switch says the feature is off. Any other 503 is a
        // server or proxy that is busy for now, like a 5xx.
        503 if parsed.as_ref().is_some_and(|b| b.error == "not_configured") => {
            CloudError::NotConfigured
        }
        _ => CloudError::Failed(
            parsed
                .map(|b| b.error)
                .filter(|e| !e.is_empty())
                .unwrap_or_else(|| format!("HTTP {status}")),
        ),
    }
}

pub fn from_auth_error(error: crate::auth::AuthApiError) -> CloudError {
    use crate::auth::AuthApiError;
    match error {
        AuthApiError::InvalidAuthentication => CloudError::NotSignedIn,
        AuthApiError::UpgradeRequired => CloudError::UpgradeRequired,
        AuthApiError::Timeout => CloudError::Offline("timed out".into()),
        AuthApiError::Status(status, body) => classify_status(status.as_u16(), &body, None),
        AuthApiError::Other(reason) => CloudError::Offline(reason),
    }
}

pub fn credentials() -> Result<(String, String), CloudError> {
    let token = crate::store::auth_snapshot()
        .token
        .ok_or(CloudError::NotSignedIn)?;
    Ok((crate::auth::server_url(), token))
}

pub fn client(total: Option<Duration>) -> Result<reqwest::Client, CloudError> {
    // A long request waits for its answer as long as it may take in all.
    let read = total.map_or(Duration::from_secs(60), |t| t.max(Duration::from_secs(60)));
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(read);
    if let Some(total) = total {
        builder = builder.timeout(total);
    }
    builder
        .build()
        .map_err(|e| CloudError::Failed(e.to_string()))
}

pub fn request_error(error: reqwest::Error) -> CloudError {
    if error.is_timeout() {
        CloudError::Offline("timed out".into())
    } else if error.is_connect() || error.is_request() {
        CloudError::Offline(error.to_string())
    } else {
        CloudError::Failed(error.to_string())
    }
}

pub async fn capabilities() -> Result<Capabilities, CloudError> {
    let response = crate::auth::authed_request(
        reqwest::Method::GET,
        "/api/desktop/meetings/capabilities",
        None,
    )
    .await
    .map_err(from_auth_error)?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(request_error)?;
    if status != 200 {
        return Err(classify_status(status, &body, None));
    }
    serde_json::from_str(&body).map_err(|e| CloudError::Failed(e.to_string()))
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudWord {
    pub text: String,
    pub start_ms: f64,
    pub end_ms: f64,
    /// The farm's speaker letter ("A", "B", ...) when the clip named a speaker
    /// session; the same letter is the same voice for the whole meeting track.
    pub speaker: Option<String>,
}

impl CloudWord {
    /// The farm's voice number (0 for "A").
    pub fn voice(&self) -> Option<usize> {
        let s = self.speaker.as_deref()?;
        let c = s.bytes().next().filter(|_| s.len() == 1)?;
        c.is_ascii_uppercase().then(|| (c - b'A') as usize)
    }
}

/// Speaker labels for a meeting's clips: one session per meeting and track,
/// clips numbered in the order they are sent (a retry keeps its number).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpeakerSession {
    pub session: String,
    pub seq: u64,
}

impl SpeakerSession {
    /// The session of a document's track: only characters the server accepts.
    pub fn name(doc_id: &str, track: &str) -> String {
        let doc: String = doc_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
            .take(80)
            .collect();
        format!("{doc}:{track}")
    }
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CloudTranscript {
    pub text: String,
    pub words: Vec<CloudWord>,
}

pub async fn transcribe(
    wav: Vec<u8>,
    language: &str,
    vocabulary: &[String],
    speakers: Option<&SpeakerSession>,
    timeout: Duration,
) -> Result<CloudTranscript, CloudError> {
    let (server, token) = credentials()?;
    let client = client(Some(timeout))?;
    let mut request = client
        .post(format!("{server}/api/desktop/meetings/transcribe"))
        .query(&[("language", language)]);
    if let Some(s) = speakers {
        request = request.query(&[("session", s.session.as_str()), ("seq", &s.seq.to_string())]);
    }
    let mut request = request
        .header("Content-Type", "audio/wav")
        .bearer_auth(token)
        .body(wav);
    if let Some(keywords) = keywords_header(vocabulary) {
        request = request.header(KEYWORDS_HEADER, keywords);
    }
    let response = crate::auth::apply_desktop_headers(request)
        .send()
        .await
        .map_err(request_error)?;
    let status = response.status().as_u16();
    let retry = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok());
    let body = response.text().await.map_err(request_error)?;
    if status != 200 {
        return Err(classify_status(status, &body, retry));
    }
    serde_json::from_str(&body).map_err(|e| CloudError::Failed(e.to_string()))
}

pub fn percent_encode(term: &str) -> String {
    let mut out = String::with_capacity(term.len());
    for byte in term.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

pub fn keywords_header(vocabulary: &[String]) -> Option<String> {
    let mut header = String::new();
    let mut count = 0usize;
    for term in vocabulary {
        let term = term.split_whitespace().collect::<Vec<_>>().join(" ");
        if term.is_empty() || term.chars().count() > KEYWORD_MAX_CHARS {
            continue;
        }
        let encoded = percent_encode(&term);
        let extra = encoded.len() + usize::from(!header.is_empty());
        if header.len() + extra > KEYWORDS_HEADER_MAX || count >= KEYWORDS_MAX {
            break;
        }
        if !header.is_empty() {
            header.push(',');
        }
        header.push_str(&encoded);
        count += 1;
    }
    (!header.is_empty()).then_some(header)
}

pub fn wav_bytes(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32_767.0).round() as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClipPart {
    pub source_start_sample: u64,
    pub clip_offset_samples: u64,
    pub len: u64,
}

#[derive(Clone, Debug, Default)]
pub struct Clip {
    pub samples: Vec<f32>,
    pub parts: Vec<ClipPart>,
    pub jobs: Vec<super::capture::SegmentJob>,
    /// The ledger gap this clip repairs, when it is not live audio.
    pub repair: Option<String>,
}

impl Clip {
    /// The source time of a moment of the clip (ms), None in the gaps between its parts.
    pub fn source_ms(&self, clip_ms: f64) -> Option<u64> {
        let at = (clip_ms.max(0.0) * RATE as f64 / 1000.0) as u64;
        self.parts
            .iter()
            .find(|p| at >= p.clip_offset_samples && at < p.clip_offset_samples + p.len)
            .map(|p| timeline::samples_to_ms(p.source_start_sample + (at - p.clip_offset_samples)))
    }

    pub fn duration_ms(&self) -> u64 {
        timeline::samples_to_ms(self.samples.len() as u64)
    }

    pub fn is_empty(&self) -> bool {
        self.parts.is_empty()
    }

    fn push(&mut self, job: super::capture::SegmentJob) {
        if !self.parts.is_empty() {
            let gap = timeline::ms_to_samples(GAP_MS) as usize;
            self.samples.extend(std::iter::repeat_n(0.0, gap));
        }
        self.parts.push(ClipPart {
            source_start_sample: job.start_sample,
            clip_offset_samples: self.samples.len() as u64,
            len: job.samples.len() as u64,
        });
        self.samples.extend_from_slice(&job.samples);
        self.jobs.push(job);
    }

    pub fn words_by_part(&self, words: &[CloudWord]) -> Vec<Vec<cap_meetings::transcript::Word>> {
        let mut out: Vec<Vec<cap_meetings::transcript::Word>> = vec![Vec::new(); self.parts.len()];
        for word in words {
            let text = word.text.trim();
            if text.is_empty() {
                continue;
            }
            let start = word.start_ms.max(0.0) as u64;
            let end = (word.end_ms.max(0.0) as u64).max(start);
            let at = timeline::ms_to_samples(start);
            let index = self
                .parts
                .iter()
                .rposition(|p| p.clip_offset_samples <= at)
                .unwrap_or(0);
            let part = &self.parts[index];
            let offset_ms = timeline::samples_to_ms(part.clip_offset_samples);
            let part_ms = timeline::samples_to_ms(part.len);
            let local_start = start.saturating_sub(offset_ms).min(part_ms);
            let local_end = end.saturating_sub(offset_ms).min(part_ms).max(local_start);
            let base = timeline::samples_to_ms(part.source_start_sample);
            out[index].push(cap_meetings::transcript::Word {
                text: text.to_string(),
                start_ms: base + local_start,
                end_ms: base + local_end,
            });
        }
        out
    }
}

#[derive(Debug, Default)]
pub struct Batcher {
    clip: Clip,
}

impl Batcher {
    pub fn is_empty(&self) -> bool {
        self.clip.is_empty()
    }

    pub fn push(&mut self, job: super::capture::SegmentJob) -> Option<Clip> {
        let job_ms = timeline::samples_to_ms(job.samples.len() as u64);
        let mut flushed = None;
        if !self.clip.is_empty() && self.clip.duration_ms() + GAP_MS + job_ms > HARD_MAX_MS {
            flushed = Some(std::mem::take(&mut self.clip));
        }
        self.clip.push(job);
        let total = self.clip.duration_ms();
        let near_boundary = total % BILLING_STEP_MS >= BILLING_STEP_MS - BILLING_SLACK_MS;
        if flushed.is_none()
            && (total >= TARGET_FULL_MS || (total >= TARGET_MIN_MS && near_boundary))
        {
            flushed = Some(std::mem::take(&mut self.clip));
        }
        flushed
    }

    pub fn take(&mut self) -> Option<Clip> {
        (!self.clip.is_empty()).then(|| std::mem::take(&mut self.clip))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_refused_account_or_a_missing_route_is_final() {
        assert_eq!(classify_status(401, "", None), CloudError::NotSignedIn);
        assert_eq!(classify_status(402, "", None), CloudError::UpgradeRequired);
        assert_eq!(classify_status(404, "", None), CloudError::NotConfigured);
        assert_eq!(
            classify_status(503, r#"{"error":"not_configured"}"#, None),
            CloudError::NotConfigured
        );
        assert!(matches!(classify_status(503, "Service Unavailable", None), CloudError::Failed(_)));
        assert!(matches!(classify_status(502, r#"{"error":"transcription_failed"}"#, None), CloudError::Failed(_)));
        assert!(matches!(classify_status(408, "", None), CloudError::Failed(_)));
        assert_eq!(
            classify_status(429, "", Some(7)),
            CloudError::RateLimited { retry_after_secs: 7 }
        );
    }

    #[test]
    fn farm_letters_are_voice_numbers() {
        let w = |s: Option<&str>| CloudWord { speaker: s.map(str::to_string), ..Default::default() };
        assert_eq!(w(Some("A")).voice(), Some(0));
        assert_eq!(w(Some("C")).voice(), Some(2));
        assert_eq!(w(None).voice(), None);
        assert_eq!(w(Some("AB")).voice(), None);
        assert_eq!(w(Some("a")).voice(), None);
    }

    #[test]
    fn a_word_without_a_speaker_field_still_parses() {
        let t: CloudTranscript = serde_json::from_str(r#"{"text":"hi","words":[{"text":"hi","startMs":1,"endMs":2}]}"#).unwrap();
        assert_eq!(t.words[0].speaker, None);
        let t: CloudTranscript =
            serde_json::from_str(r#"{"text":"hi","words":[{"text":"hi","startMs":1,"endMs":2,"speaker":"B"}]}"#).unwrap();
        assert_eq!(t.words[0].voice(), Some(1));
    }

    #[test]
    fn session_names_keep_only_what_the_server_accepts() {
        assert_eq!(SpeakerSession::name("20261118T215402519Z-0y136b", "mic"), "20261118T215402519Z-0y136b:mic");
        assert_eq!(SpeakerSession::name("a b/c", "system"), "abc:system");
    }

    #[test]
    fn clip_times_map_back_to_the_meeting() {
        let clip = Clip {
            samples: vec![0.0; 16_000 * 3],
            parts: vec![
                ClipPart { source_start_sample: 160_000, clip_offset_samples: 0, len: 16_000 },
                ClipPart { source_start_sample: 480_000, clip_offset_samples: 19_200, len: 16_000 },
            ],
            jobs: Vec::new(),
            repair: None,
        };
        assert_eq!(clip.source_ms(500.0), Some(10_500));
        assert_eq!(clip.source_ms(1_100.0), None, "the gap between parts");
        assert_eq!(clip.source_ms(1_300.0), Some(30_100));
    }
}
