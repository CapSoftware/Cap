use std::time::Duration;

use cap_meetings::{
    library::{DocMeta, MeetingDetails},
    templates::{NotesRequest, Template},
    transcript::Transcript,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::cloud::{self, CloudError};

pub const TRANSCRIPT_MAX_CHARS: usize = 400_000;
const USER_NOTES_MAX_CHARS: usize = 50_000;
const PREVIOUS_MAX_CHARS: usize = 100_000;
const INSTRUCTION_MAX_CHARS: usize = 2_000;
const QUESTION_MAX_CHARS: usize = 4_000;
const HISTORY_MAX: usize = 20;
const HISTORY_ITEM_MAX_CHARS: usize = 8_000;
const ASK_NOTES_MAX_CHARS: usize = 100_000;
const MEETING_ID_MAX: usize = 64;
pub(crate) const SUMMARY_LANGUAGES: [&str; 25] = [
    "en", "es", "fr", "de", "pt", "it", "nl", "pl", "ro", "sk", "ru", "tr", "ja", "ko", "zh", "ar",
    "hi", "bn", "ta", "te", "mr", "gu", "ur", "fa", "he",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GenerateOptions {
    pub template_id: Option<String>,
    pub instruction: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AskRole {
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AskTurn {
    pub role: AskRole,
    pub content: String,
    /// [`Transcript::left_out_basis`] when it was answered. A turn made
    /// before the person changed who is left out is not sent again.
    #[serde(skip)]
    pub left_out: String,
}

/// Ask's answer, and which lines were left out of what it was given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AskAnswer {
    pub text: String,
    pub left_out: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesError {
    NotSignedIn,
    UpgradeRequired,
    RateLimited {
        retry_after_secs: u64,
    },
    NotConfigured,
    Offline(String),
    /// Cap answered, then the answer stopped before it was finished.
    Interrupted(String),
    Failed(String),
    NothingToSummarize,
    NotFound,
    Busy,
}

impl NotesError {
    pub fn describe(&self) -> String {
        match self {
            NotesError::NotSignedIn => "Sign in to Cap to generate notes".into(),
            NotesError::UpgradeRequired => "Generating notes needs Cap Pro".into(),
            NotesError::RateLimited { retry_after_secs } => {
                format!("Too many requests, try again in {retry_after_secs}s")
            }
            NotesError::NotConfigured => "Notes generation is not available right now".into(),
            NotesError::Offline(_) => "Could not reach Cap, check your connection".into(),
            NotesError::Interrupted(_) => "Cap AI stopped partway, try again".into(),
            NotesError::Failed(_) => "Notes could not be generated, try again".into(),
            NotesError::NothingToSummarize => "There is nothing to summarize yet".into(),
            NotesError::NotFound => "This meeting no longer exists".into(),
            NotesError::Busy => "Notes are already being generated".into(),
        }
    }
}

impl From<CloudError> for NotesError {
    fn from(error: CloudError) -> Self {
        match error {
            CloudError::NotSignedIn => NotesError::NotSignedIn,
            CloudError::UpgradeRequired => NotesError::UpgradeRequired,
            CloudError::RateLimited { retry_after_secs } => {
                NotesError::RateLimited { retry_after_secs }
            }
            CloudError::NotConfigured => NotesError::NotConfigured,
            CloudError::Offline(reason) => NotesError::Offline(reason),
            CloudError::Failed(reason) => NotesError::Failed(reason),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SseEvent {
    Title(String),
    Delta(String),
    Done,
    Error(String),
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                out.extend(self.dispatch());
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
                None => (line, ""),
            };
            match field {
                "event" => self.event = Some(value.to_string()),
                "data" => self.data.push(value.to_string()),
                _ => {}
            }
        }
        out
    }

    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut out = self.push(b"\n");
        out.extend(self.dispatch());
        out
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = self.event.take();
        if self.data.is_empty() {
            return None;
        }
        let data = std::mem::take(&mut self.data).join("\n");
        let value: Value = serde_json::from_str(&data).unwrap_or(Value::Null);
        let text = |key: &str| {
            value
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string()
        };
        match event.as_deref().unwrap_or("message") {
            "title" => Some(SseEvent::Title(text("title"))),
            "delta" => Some(SseEvent::Delta(text("text"))),
            "done" => Some(SseEvent::Done),
            "error" => Some(SseEvent::Error(text("error"))),
            _ => None,
        }
    }
}

fn clip_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect()
}

pub struct NotesInput<'a> {
    pub meta: &'a DocMeta,
    pub transcript: &'a Transcript,
    pub user_notes_markdown: String,
    pub template: &'a Template,
    pub vocabulary: &'a [String],
    pub summary_language: Option<&'a str>,
    pub previous_markdown: Option<String>,
    pub instruction: Option<String>,
    pub time_zone: Option<String>,
    pub self_name: Option<&'a str>,
}

pub struct NotesBody {
    pub body: Value,
    pub title_requested: bool,
}

pub fn notes_body(input: NotesInput<'_>) -> Result<NotesBody, NotesError> {
    let meeting = input.meta.meeting.clone().unwrap_or_default();
    let prompt = input
        .transcript
        .labelled_for_prompt(TRANSCRIPT_MAX_CHARS, input.self_name);
    let heard = input.transcript.named_speakers(input.self_name);
    let participants = participant_names(&meeting, &heard);
    let mut builder = NotesRequest::builder(input.meta.title.clone(), input.template)
        .participants(participants)
        .user_notes(clip_chars(&input.user_notes_markdown, USER_NOTES_MAX_CHARS))
        .transcript(prompt)
        .vocabulary(input.vocabulary)
        .summary_language(input.summary_language.map(str::to_string));
    if let Some(started_at) = meeting.started_at {
        builder = builder.when(started_at, Some(meeting.duration_ms));
    }
    if let (Some(previous), Some(instruction)) = (input.previous_markdown, input.instruction) {
        builder = builder.rewrite(previous, instruction);
    }
    let request = builder.build();
    if request.transcript.trim().is_empty() && request.user_notes.trim().is_empty() {
        return Err(NotesError::NothingToSummarize);
    }

    let title_requested = input.meta.title_is_auto || request.title.is_empty();
    let sections: Vec<Value> = request
        .template
        .sections
        .iter()
        .filter(|s| !s.heading.trim().is_empty())
        .take(12)
        .map(|s| {
            json!({
                "heading": clip_chars(s.heading.trim(), 120),
                "instruction": clip_chars(&s.instruction, 500),
            })
        })
        .collect();
    let mut body = json!({
        "meetingId": meeting_id(&input.meta.id),
        "title": if title_requested { String::new() } else { clip_chars(&request.title, 300) },
        "participants": attendee_values(&meeting, &heard),
        "rawNotesMarkdown": request.user_notes,
        "transcript": request.transcript,
        "transcriptTruncated": request.transcript_truncated,
        "vocabulary": request
            .vocabulary
            .iter()
            .take(200)
            .map(|v| clip_chars(v, 100))
            .collect::<Vec<_>>(),
        "summaryLanguage": request
            .summary_language
            .as_deref()
            .filter(|l| SUMMARY_LANGUAGES.contains(l))
            .unwrap_or("auto"),
        "headingCount": request.heading_count.clamp(3, 10),
    });
    if !sections.is_empty() {
        body["template"] = json!({
            "name": clip_chars(&request.template.name, 100),
            "description": clip_chars(&input.template.description, 500),
            "sections": sections,
        });
    }
    if let Some(started_at) = request.started_at {
        body["startedAt"] = json!(started_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    }
    if let Some(zone) = input.time_zone.filter(|z| !z.is_empty() && z.len() <= 64) {
        body["timezone"] = json!(zone);
    }
    if let (Some(previous), Some(instruction)) =
        (request.previous_summary, request.rewrite_instruction)
    {
        body["previous"] = json!({
            "markdown": clip_chars(&previous, PREVIOUS_MAX_CHARS),
            "instruction": clip_chars(&instruction, INSTRUCTION_MAX_CHARS),
        });
    }
    Ok(NotesBody {
        body,
        title_requested,
    })
}

/// `heard` holds the names the transcript's voices carry (the user and anyone
/// renamed), used when the calendar has no list of people.
fn participant_names(meeting: &MeetingDetails, heard: &[(String, bool)]) -> Vec<String> {
    if !meeting.participants.is_empty() {
        return meeting.participants.clone();
    }
    let listed: Vec<String> = meeting
        .event
        .as_ref()
        .map(|e| {
            e.attendees
                .iter()
                .filter_map(|a| a.name.clone().or_else(|| a.email.clone()))
                .collect()
        })
        .unwrap_or_default();
    if !listed.is_empty() {
        return listed;
    }
    heard.iter().map(|(name, _)| name.clone()).collect()
}

fn attendee_values(meeting: &MeetingDetails, heard: &[(String, bool)]) -> Vec<Value> {
    if let Some(event) = meeting.event.as_ref().filter(|e| !e.attendees.is_empty()) {
        return event
            .attendees
            .iter()
            .take(100)
            .map(|a| {
                let mut value = json!({ "isSelf": a.is_self });
                if let Some(name) = a.name.as_deref().filter(|n| !n.trim().is_empty()) {
                    value["name"] = json!(clip_chars(name, 200));
                }
                if let Some(email) = a.email.as_deref().filter(|e| !e.trim().is_empty()) {
                    value["email"] = json!(clip_chars(email, 320));
                }
                value
            })
            .collect();
    }
    if !meeting.participants.is_empty() {
        return meeting
            .participants
            .iter()
            .take(100)
            .map(|name| json!({ "name": clip_chars(name, 200) }))
            .collect();
    }
    heard
        .iter()
        .take(100)
        .map(|(name, is_self)| json!({ "name": clip_chars(name, 200), "isSelf": is_self }))
        .collect()
}

pub fn meeting_id(doc_id: &str) -> String {
    let fits = (1..=MEETING_ID_MAX).contains(&doc_id.len())
        && doc_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if fits {
        return doc_id.to_string();
    }
    let hash = doc_id.bytes().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0000_0100_0000_01b3)
    });
    format!("doc-{hash:016x}")
}

pub fn ask_body(
    meeting: &str,
    title: &str,
    transcript: &Transcript,
    notes_markdown: &str,
    question: &str,
    history: &[AskTurn],
    self_name: Option<&str>,
    vocabulary: &[String],
) -> Result<Value, NotesError> {
    let transcript = transcript
        .labelled_for_prompt(TRANSCRIPT_MAX_CHARS, self_name)
        .text;
    if question.trim().is_empty() {
        return Err(NotesError::Failed("empty question".into()));
    }
    if transcript.trim().is_empty() && notes_markdown.trim().is_empty() {
        return Err(NotesError::NothingToSummarize);
    }
    let skip = history.len().saturating_sub(HISTORY_MAX);
    let history: Vec<Value> = history[skip..]
        .iter()
        .map(|turn| {
            json!({
                "role": turn.role,
                "content": clip_chars(&turn.content, HISTORY_ITEM_MAX_CHARS),
            })
        })
        .collect();
    let mut body = json!({
        "meetingId": meeting_id(meeting),
        "question": clip_chars(question.trim(), QUESTION_MAX_CHARS),
        "transcript": transcript,
        "notesMarkdown": clip_chars(notes_markdown, ASK_NOTES_MAX_CHARS),
        "history": history,
    });
    if !title.trim().is_empty() {
        body["title"] = json!(clip_chars(title.trim(), 300));
    }
    if !vocabulary.is_empty() {
        body["vocabulary"] = json!(
            vocabulary
                .iter()
                .take(200)
                .map(|v| clip_chars(v, 100))
                .collect::<Vec<_>>()
        );
    }
    Ok(body)
}

pub async fn stream(
    path: &'static str,
    body: Value,
    events: flume::Sender<SseEvent>,
) -> Result<(), NotesError> {
    let (server, token) = cloud::credentials()?;
    let client = cloud::client(None)?;
    let request = client
        .post(format!("{server}{path}"))
        .bearer_auth(token)
        .header("Accept", "text/event-stream")
        .json(&body);
    let response = crate::auth::apply_desktop_headers(request)
        .send()
        .await
        .map_err(|e| NotesError::from(cloud::request_error(e)))?;
    let status = response.status().as_u16();
    if status != 200 {
        let retry = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok());
        let body = response.text().await.unwrap_or_default();
        return Err(cloud::classify_status(status, &body, retry).into());
    }
    read_events(response.bytes_stream(), Duration::from_secs(90), &events).await
}

/// The events of an answer Cap has started. Once it answered, an answer
/// that stops early (cut off, quiet too long, broken) is an interruption,
/// not a missing connection.
pub(crate) async fn read_events<S, B, E>(
    bytes: S,
    idle: Duration,
    events: &flume::Sender<SseEvent>,
) -> Result<(), NotesError>
where
    S: futures_util::Stream<Item = Result<B, E>>,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    let mut bytes = std::pin::pin!(bytes);
    let mut parser = SseParser::default();
    loop {
        let next = tokio::time::timeout(idle, bytes.next())
            .await
            .map_err(|_| NotesError::Interrupted("the answer went quiet".into()))?;
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|e| NotesError::Interrupted(e.to_string()))?;
        for event in parser.push(chunk.as_ref()) {
            let terminal = matches!(event, SseEvent::Done | SseEvent::Error(_));
            if let SseEvent::Error(reason) = &event {
                return Err(NotesError::Failed(reason.clone()));
            }
            let _ = events.send(event);
            if terminal {
                return Ok(());
            }
        }
    }
    for event in parser.finish() {
        if let SseEvent::Error(reason) = &event {
            return Err(NotesError::Failed(reason.clone()));
        }
        let done = event == SseEvent::Done;
        let _ = events.send(event);
        if done {
            return Ok(());
        }
    }
    Err(NotesError::Interrupted("the answer ended early".into()))
}
