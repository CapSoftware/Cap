use std::{path::Path, time::Duration};

use reqwest::Method;
use serde_json::{Map, Value, json};
use tokio_util::io::ReaderStream;

use crate::{
    caps::{AgentApiError, AgentClient, opaque_id},
    upload,
};

pub const TRANSCRIPT_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const VIDEO_MAX_FILE_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const DEFAULT_WAIT_SECONDS: u64 = 900;
pub const MAX_WAIT_SECONDS: u64 = 86_400;

#[derive(Default)]
pub struct Created(std::sync::Mutex<Option<(String, String)>>);

impl Created {
    pub fn record(&self, id: &str, status: &str) {
        if let Ok(mut created) = self.0.lock() {
            *created = Some((id.to_string(), status.to_string()));
        }
    }

    pub fn get(&self) -> Option<(String, String)> {
        self.0.lock().ok().and_then(|created| created.clone())
    }

    fn record_from(&self, value: &Value, object: &str) {
        if let (Some(id), Some(status)) = (
            value_text(value, object, "id"),
            value_text(value, object, "status"),
        ) {
            self.record(id, status);
        }
    }
}

#[derive(Default)]
pub struct TranscriptOptions {
    pub name: Option<String>,
    pub language: Option<String>,
    pub user_id: Option<String>,
}

fn invalid(message: impl Into<String>) -> AgentApiError {
    AgentApiError {
        code: "INVALID_REQUEST".to_string(),
        message: message.into(),
        retryable: false,
        retry_after_ms: None,
        request_id: None,
        ..Default::default()
    }
}

fn file_name(path: &Path) -> Result<String, AgentApiError> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| invalid("File name is invalid"))
}

async fn file_length(path: &Path, max_bytes: u64, limit: &str) -> Result<u64, AgentApiError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| invalid(format!("Could not read {}: {error}", path.display())))?;
    if !metadata.is_file() {
        return Err(invalid(format!("{} is not a file", path.display())));
    }
    if metadata.len() == 0 {
        return Err(invalid(format!("{} is empty", path.display())));
    }
    if metadata.len() > max_bytes {
        return Err(invalid(format!(
            "{} is larger than the {limit} limit",
            path.display()
        )));
    }
    Ok(metadata.len())
}

fn ensure_audio_stream(path: &Path) -> Result<(), AgentApiError> {
    ffmpeg::init().map_err(|error| invalid(format!("Failed to initialise FFmpeg: {error}")))?;
    let input = ffmpeg::format::input(path)
        .map_err(|_| invalid(format!("{} is not an audio or video file", path.display())))?;
    if input.streams().best(ffmpeg::media::Type::Audio).is_none() {
        return Err(invalid(format!("{} has no audio track", path.display())));
    }
    Ok(())
}

fn options_body(options: &TranscriptOptions) -> Map<String, Value> {
    let mut body = Map::new();
    for (key, value) in [
        ("name", &options.name),
        ("language", &options.language),
        ("userId", &options.user_id),
    ] {
        if let Some(value) = value {
            body.insert(key.to_string(), Value::String(value.clone()));
        }
    }
    body
}

pub fn transcript_file_body(
    file_name: &str,
    content_length: u64,
    options: &TranscriptOptions,
) -> Value {
    let mut body = options_body(options);
    body.insert("fileName".to_string(), Value::String(file_name.to_string()));
    body.insert("contentLength".to_string(), Value::from(content_length));
    Value::Object(body)
}

pub fn transcript_url_body(url: &str, options: &TranscriptOptions) -> Value {
    let mut body = options_body(options);
    body.insert("url".to_string(), Value::String(url.to_string()));
    Value::Object(body)
}

pub fn without_upload_target(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.remove("upload");
    }
    value
}

async fn put_file(target: &Value, path: &Path, content_length: u64) -> Result<(), AgentApiError> {
    let url = target
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Cap returned an upload target without a URL"))?;
    if target.get("method").and_then(Value::as_str) != Some("PUT") {
        return Err(invalid("Cap returned an unsupported upload target"));
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| invalid(format!("Could not open {}: {error}", path.display())))?;
    let mut request = reqwest::Client::new()
        .put(url)
        .header(reqwest::header::CONTENT_LENGTH, content_length)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(file)));
    if let Some(headers) = target.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if name.eq_ignore_ascii_case("content-length") {
                continue;
            }
            if let Some(value) = value.as_str() {
                request = request.header(name, value);
            }
        }
    }
    let response = request.send().await.map_err(|error| AgentApiError {
        code: "TEMPORARY_UNAVAILABLE".to_string(),
        message: format!("File upload failed: {}", error.without_url()),
        retryable: true,
        retry_after_ms: Some(1_000),
        request_id: None,
        ..Default::default()
    })?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(AgentApiError {
            code: "TEMPORARY_UNAVAILABLE".to_string(),
            message: format!("Storage rejected the upload ({})", response.status()),
            retryable: false,
            retry_after_ms: None,
            request_id: None,
            ..Default::default()
        })
    }
}

fn transcript_id(value: &Value) -> Result<String, AgentApiError> {
    value
        .get("transcript")
        .and_then(|transcript| transcript.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid("Cap returned a transcript without an ID"))
}

pub async fn create_transcript_from_file(
    client: &AgentClient,
    app_id: &str,
    path: &Path,
    options: &TranscriptOptions,
    created_resource: &Created,
) -> Result<Value, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let content_length = file_length(path, TRANSCRIPT_MAX_FILE_BYTES, "2 GB").await?;
    ensure_audio_stream(path)?;
    let created = client
        .mutate_json_confirmed(
            Method::POST,
            &format!("/developer/apps/{app_id}/transcripts"),
            &transcript_file_body(&file_name(path)?, content_length, options),
        )
        .await?;
    let id = transcript_id(&created)?;
    created_resource.record(&id, "uploading");
    let started = async {
        let target = created
            .get("upload")
            .filter(|target| !target.is_null())
            .ok_or_else(|| invalid("Cap did not return an upload target"))?;
        put_file(target, path, content_length).await?;
        client
            .mutate_json_confirmed(
                Method::POST,
                &format!("/developer/apps/{app_id}/transcripts/{id}/start"),
                &json!({}),
            )
            .await
    };
    let started = started
        .await
        .map_err(|error| error.with_detail("transcriptId", id.as_str()))?;
    created_resource.record_from(&started, "transcript");
    Ok(started)
}

pub async fn create_transcript_from_url(
    client: &AgentClient,
    app_id: &str,
    url: &str,
    options: &TranscriptOptions,
    created_resource: &Created,
) -> Result<Value, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let parsed = url::Url::parse(url).map_err(|_| invalid("The URL is not valid"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("The URL must start with http:// or https://"));
    }
    let created = client
        .mutate_json_confirmed(
            Method::POST,
            &format!("/developer/apps/{app_id}/transcripts"),
            &transcript_url_body(url, options),
        )
        .await
        .map(without_upload_target)?;
    created_resource.record_from(&created, "transcript");
    Ok(created)
}

pub fn transcript_path(
    app_id: &str,
    transcript_id: &str,
    segments: bool,
) -> Result<String, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let transcript_id = opaque_id(transcript_id, "Developer transcript ID")?;
    let query = if segments { "?include=segments" } else { "" };
    Ok(format!(
        "/developer/apps/{app_id}/transcripts/{transcript_id}{query}"
    ))
}

pub fn transcript_status(value: &Value) -> Option<&str> {
    value
        .get("transcript")
        .and_then(|transcript| transcript.get("status"))
        .and_then(Value::as_str)
}

fn value_text<'a>(value: &'a Value, object: &str, field: &str) -> Option<&'a str> {
    value
        .get(object)
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
}

fn request_id(value: &Value) -> Option<String> {
    value
        .get("requestId")
        .and_then(Value::as_str)
        .map(str::to_string)
}

pub fn transcript_failure(value: &Value, transcript_id: &str) -> AgentApiError {
    AgentApiError {
        code: "TRANSCRIPT_FAILED".to_string(),
        message: format!(
            "{} ({})",
            value_text(value, "transcript", "errorMessage")
                .unwrap_or("The transcript could not be created"),
            value_text(value, "transcript", "errorCode").unwrap_or("transcription_failed")
        ),
        retryable: false,
        retry_after_ms: None,
        request_id: request_id(value),
        ..Default::default()
    }
    .with_detail("transcriptId", transcript_id)
    .with_detail("status", "error")
    .with_hint(
        "A failed transcript is not charged. Remove it with `cap developers transcripts delete`.",
    )
}

pub fn validate_wait_seconds(timeout_seconds: Option<u64>) -> Result<u64, AgentApiError> {
    let timeout = timeout_seconds.unwrap_or(DEFAULT_WAIT_SECONDS);
    if timeout == 0 || timeout > MAX_WAIT_SECONDS {
        return Err(invalid("timeoutSeconds must be between 1 and 86400"));
    }
    Ok(timeout)
}

fn wait_delay(attempt: u32) -> Duration {
    let delay = 500_u64.saturating_mul(1_u64 << attempt.min(4));
    Duration::from_millis(delay.min(5_000))
}

enum WaitProgress {
    Done,
    Pending(String),
}

struct Wait<'a> {
    path: String,
    resource: &'a str,
    id_field: &'a str,
    id: &'a str,
    timeout_seconds: u64,
    resume: String,
}

impl Wait<'_> {
    fn timed_out(&self, status: Option<&str>, request_id: Option<String>) -> AgentApiError {
        let error = AgentApiError {
            code: "NOT_READY".to_string(),
            message: format!(
                "Timed out after {} seconds waiting for the {}",
                self.timeout_seconds, self.resource
            ),
            retryable: true,
            retry_after_ms: Some(2_000),
            request_id,
            ..Default::default()
        }
        .with_detail(self.id_field, self.id)
        .with_hint(format!("Keep waiting with `{}`.", self.resume));
        match status {
            Some(status) => error.with_detail("status", status),
            None => error,
        }
    }

    async fn run(
        &self,
        client: &AgentClient,
        progress: impl Fn(&Value) -> Result<WaitProgress, AgentApiError>,
    ) -> Result<Value, AgentApiError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(self.timeout_seconds);
        let mut status: Option<String> = None;
        let mut last_request_id = None;
        let mut attempt = 0_u32;
        loop {
            let fetched = tokio::time::timeout_at(deadline, client.get_json(&self.path)).await;
            let Ok(fetched) = fetched else {
                return Err(self.timed_out(status.as_deref(), last_request_id));
            };
            let value = fetched.map_err(|error| error.with_detail(self.id_field, self.id))?;
            match progress(&value).map_err(|error| error.with_detail(self.id_field, self.id))? {
                WaitProgress::Done => return Ok(value),
                WaitProgress::Pending(current) => status = Some(current),
            }
            last_request_id = request_id(&value);
            let wake = tokio::time::Instant::now() + wait_delay(attempt);
            if wake >= deadline {
                tokio::time::sleep_until(deadline).await;
                return Err(self.timed_out(status.as_deref(), last_request_id));
            }
            tokio::time::sleep_until(wake).await;
            attempt = attempt.saturating_add(1);
        }
    }
}

pub async fn wait_for_transcript(
    client: &AgentClient,
    app_id: &str,
    transcript_id: &str,
    timeout_seconds: u64,
) -> Result<Value, AgentApiError> {
    let wait = Wait {
        path: transcript_path(app_id, transcript_id, false)?,
        resource: "transcript",
        id_field: "transcriptId",
        id: transcript_id,
        timeout_seconds,
        resume: format!("cap developers transcripts wait {app_id} {transcript_id}"),
    };
    wait.run(client, |value| match transcript_status(value) {
        Some("complete") => Ok(WaitProgress::Done),
        Some("error") => Err(transcript_failure(value, transcript_id)),
        Some("uploading") => Err(AgentApiError::local(
            "NOT_READY",
            "The transcript is still waiting for its file",
        )
        .with_detail("status", "uploading")),
        Some(status @ ("queued" | "processing")) => Ok(WaitProgress::Pending(status.to_string())),
        _ => Err(invalid("Cap returned an invalid transcript status")),
    })
    .await
}

pub fn video_path(app_id: &str, video_id: &str) -> Result<String, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let video_id = opaque_id(video_id, "Developer video ID")?;
    Ok(format!("/developer/apps/{app_id}/videos/{video_id}"))
}

pub fn video_status(value: &Value) -> Option<&str> {
    value_text(value, "video", "status")
}

pub fn video_failure(value: &Value, video_id: &str) -> AgentApiError {
    AgentApiError {
        code: "VIDEO_FAILED".to_string(),
        message: value_text(value, "video", "errorReason")
            .unwrap_or("The video could not be processed")
            .to_string(),
        retryable: false,
        retry_after_ms: None,
        request_id: request_id(value),
        ..Default::default()
    }
    .with_detail("videoId", video_id)
    .with_detail("status", "errored")
    .with_hint("Remove it with `cap developers videos delete`, then upload the file again.")
}

pub async fn get_video(
    client: &AgentClient,
    app_id: &str,
    video_id: &str,
) -> Result<Value, AgentApiError> {
    client.get_json(&video_path(app_id, video_id)?).await
}

pub async fn wait_for_video(
    client: &AgentClient,
    app_id: &str,
    video_id: &str,
    timeout_seconds: u64,
) -> Result<Value, AgentApiError> {
    let wait = Wait {
        path: video_path(app_id, video_id)?,
        resource: "video",
        id_field: "videoId",
        id: video_id,
        timeout_seconds,
        resume: format!("cap developers videos wait {app_id} {video_id}"),
    };
    wait.run(client, |value| match video_status(value) {
        Some("ready") => Ok(WaitProgress::Done),
        Some("errored") => Err(video_failure(value, video_id)),
        Some("uploading") => Err(AgentApiError::local(
            "NOT_READY",
            "The video is still waiting for its file",
        )
        .with_detail("status", "uploading")
        .with_hint("Upload the file with `cap developers videos upload`.")),
        Some("processing") => Ok(WaitProgress::Pending("processing".to_string())),
        _ => Err(invalid("Cap returned an invalid video status")),
    })
    .await
}

pub fn created_id(value: &Value, object: &str) -> Result<String, AgentApiError> {
    value_text(value, object, "id")
        .map(str::to_string)
        .ok_or_else(|| invalid(format!("Cap returned a {object} without an ID")))
}

async fn app_context(client: &AgentClient, app_id: &str) -> Result<Value, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    client
        .get_json(&format!("/developer/apps/{app_id}/context"))
        .await
}

fn preview(action: &str, effect: &str, target: Value) -> Value {
    json!({
        "dryRun": true,
        "action": action,
        "effect": effect,
        "target": target,
    })
}

fn active_keys(context: &Value) -> Vec<Value> {
    context
        .get("keys")
        .and_then(Value::as_array)
        .map(|keys| {
            keys.iter()
                .filter(|key| key.get("revokedAt").is_none_or(Value::is_null))
                .map(|key| {
                    json!({
                        "keyType": key.get("keyType"),
                        "keyPrefix": key.get("keyPrefix"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn app_target(context: &Value) -> Value {
    json!({
        "appId": context.pointer("/app/id"),
        "name": context.pointer("/app/name"),
        "environment": context.pointer("/app/environment"),
        "videoCount": context.pointer("/usage/videoCount"),
        "storageMinutes": context.pointer("/usage/storageMinutes"),
        "domainCount": context.get("domains").and_then(Value::as_array).map(Vec::len),
        "activeKeys": active_keys(context),
    })
}

pub async fn preview_app_delete(
    client: &AgentClient,
    app_id: &str,
) -> Result<Value, AgentApiError> {
    let context = app_context(client, app_id).await?;
    Ok(preview(
        "delete_developer_app",
        "Deletes the app, revokes its keys and stops playback of its videos. Unused credit is lost.",
        app_target(&context),
    ))
}

pub async fn preview_key_rotation(
    client: &AgentClient,
    app_id: &str,
) -> Result<Value, AgentApiError> {
    let context = app_context(client, app_id).await?;
    Ok(preview(
        "rotate_developer_keys",
        "Revokes the active keys at once and prints a new public and secret key one time.",
        app_target(&context),
    ))
}

pub fn domain_entry<'a>(context: &'a Value, domain: &str) -> Option<&'a Value> {
    let wanted = domain.trim_end_matches('/');
    context
        .get("domains")
        .and_then(Value::as_array)?
        .iter()
        .find(|entry| {
            ["id", "domain"].iter().any(|field| {
                entry
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.eq_ignore_ascii_case(wanted))
            })
        })
}

pub async fn resolve_domain(
    client: &AgentClient,
    app_id: &str,
    domain: &str,
) -> Result<Value, AgentApiError> {
    let context = app_context(client, app_id).await?;
    domain_entry(&context, domain).cloned().ok_or_else(|| {
        AgentApiError::local("NOT_FOUND", "Domain not found in this developer app").with_hint(
            format!("Run `cap developers get {app_id}` to list the app's domains and their ids."),
        )
    })
}

pub fn domain_removal_preview(app_id: &str, domain: &Value) -> Value {
    preview(
        "remove_developer_domain",
        "Requests from this origin are refused once it is removed.",
        json!({
            "appId": app_id,
            "domainId": domain.get("id"),
            "domain": domain.get("domain"),
        }),
    )
}

pub async fn preview_video_delete(
    client: &AgentClient,
    app_id: &str,
    video_id: &str,
) -> Result<Value, AgentApiError> {
    let value = client
        .get_json(&format!("{}?restart=false", video_path(app_id, video_id)?))
        .await?;
    Ok(preview(
        "delete_developer_video",
        "Deletes the video and stops its playback, share and embed links.",
        json!({
            "appId": app_id,
            "videoId": value.pointer("/video/id"),
            "name": value.pointer("/video/name"),
            "status": value.pointer("/video/status"),
            "durationSeconds": value.pointer("/video/durationSeconds"),
            "shareUrl": value.pointer("/video/shareUrl"),
        }),
    ))
}

pub async fn preview_transcript_delete(
    client: &AgentClient,
    app_id: &str,
    transcript_id: &str,
) -> Result<Value, AgentApiError> {
    let value = client
        .get_json(&transcript_path(app_id, transcript_id, false)?)
        .await?;
    Ok(preview(
        "delete_developer_transcript",
        "Deletes the transcript and its stored text. The charge is not refunded.",
        json!({
            "appId": app_id,
            "transcriptId": value.pointer("/transcript/id"),
            "name": value.pointer("/transcript/name"),
            "status": value.pointer("/transcript/status"),
            "durationSeconds": value.pointer("/transcript/durationSeconds"),
        }),
    ))
}

pub async fn usage(client: &AgentClient, app_id: &str) -> Result<Value, AgentApiError> {
    let context = app_context(client, app_id).await?;
    let field = |name: &str| context.get(name).cloned().unwrap_or(Value::Null);
    Ok(json!({
        "appId": context.pointer("/app/id"),
        "name": context.pointer("/app/name"),
        "usage": field("usage"),
        "credits": field("credits"),
        "billing": field("billing"),
        "billingHint": field("billingHint"),
        "requestId": field("requestId"),
    }))
}

pub const NO_SPEECH_NOTE: &str =
    "No speech was found, so the transcript is empty. It was billed for its audio length.";

pub fn transcript_has_no_speech(value: &Value) -> bool {
    transcript_status(value) == Some("complete")
        && value
            .get("transcript")
            .and_then(|transcript| transcript.get("wordCount"))
            .and_then(Value::as_u64)
            == Some(0)
        && value
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .is_empty()
}

pub fn video_create_body(
    file_name: &str,
    content_length: u64,
    name: Option<&str>,
    user_id: Option<&str>,
) -> Value {
    let mut body = Map::new();
    body.insert("fileName".to_string(), Value::String(file_name.to_string()));
    body.insert("contentLength".to_string(), Value::from(content_length));
    if let Some(name) = name {
        body.insert("name".to_string(), Value::String(name.to_string()));
    }
    if let Some(user_id) = user_id {
        body.insert("userId".to_string(), Value::String(user_id.to_string()));
    }
    Value::Object(body)
}

pub async fn upload_video(
    client: &AgentClient,
    app_id: &str,
    path: &Path,
    name: Option<&str>,
    user_id: Option<&str>,
    created_resource: &Created,
) -> Result<Value, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let content_length = file_length(path, VIDEO_MAX_FILE_BYTES, "5 GB").await?;
    let meta = upload::probe_video_meta(path).map_err(invalid)?;
    if meta.duration_in_secs <= 0.0 {
        return Err(invalid(format!(
            "Could not read the duration of {}",
            path.display()
        )));
    }
    let created = client
        .mutate_json_confirmed(
            Method::POST,
            &format!("/developer/apps/{app_id}/videos"),
            &video_create_body(&file_name(path)?, content_length, name, user_id),
        )
        .await?;
    let video_id = created
        .get("video")
        .and_then(|video| video.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Cap returned a video without an ID"))?
        .to_string();
    created_resource.record(&video_id, "uploading");
    let completed = async {
        let target = created
            .get("upload")
            .ok_or_else(|| invalid("Cap did not return an upload target"))?;
        put_file(target, path, content_length).await?;
        client
            .mutate_json_confirmed(
                Method::POST,
                &format!("/developer/apps/{app_id}/videos/{video_id}/complete"),
                &json!({
                    "durationSeconds": meta.duration_in_secs,
                    "width": meta.width,
                    "height": meta.height,
                    "fps": meta.fps,
                }),
            )
            .await
    };
    let completed = completed
        .await
        .map_err(|error| error.with_detail("videoId", video_id.as_str()))?;
    created_resource.record_from(&completed, "video");
    Ok(completed)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        TranscriptOptions, transcript_failure, transcript_file_body, transcript_has_no_speech,
        transcript_path, transcript_status, transcript_url_body, validate_wait_seconds,
        video_create_body, without_upload_target,
    };

    #[test]
    fn transcript_bodies_only_send_requested_options() {
        let bare = transcript_url_body("https://example.com/a.mp3", &TranscriptOptions::default());
        assert_eq!(bare, json!({ "url": "https://example.com/a.mp3" }));

        let options = TranscriptOptions {
            name: Some("Standup".to_string()),
            language: Some("en".to_string()),
            user_id: Some("user-1".to_string()),
        };
        assert_eq!(
            transcript_file_body("standup.m4a", 1_024, &options),
            json!({
                "fileName": "standup.m4a",
                "contentLength": 1_024,
                "name": "Standup",
                "language": "en",
                "userId": "user-1",
            })
        );
    }

    #[test]
    fn upload_targets_never_leave_the_process() {
        let value = without_upload_target(json!({
            "transcript": { "id": "t1" },
            "upload": { "method": "PUT", "url": "https://storage.example/signed" },
            "requestId": "r1",
        }));
        assert!(value.get("upload").is_none());
        assert_eq!(value["transcript"]["id"], "t1");
    }

    #[test]
    fn transcript_paths_reject_unsafe_identifiers() {
        assert_eq!(
            transcript_path("app_1", "tr-1", true).unwrap(),
            "/developer/apps/app_1/transcripts/tr-1?include=segments"
        );
        assert!(transcript_path("app/1", "tr-1", false).is_err());
        assert!(transcript_path("app_1", "../secrets", false).is_err());
    }

    #[test]
    fn failed_transcripts_report_the_server_reason() {
        let value = json!({
            "transcript": {
                "status": "error",
                "errorCode": "insufficient_credits",
                "errorMessage": "The credit balance could not cover this transcript.",
            },
            "requestId": "r1",
        });
        assert_eq!(transcript_status(&value), Some("error"));
        let error = transcript_failure(&value, "tr-1");
        assert_eq!(error.code, "TRANSCRIPT_FAILED");
        assert!(error.message.contains("insufficient_credits"));
        assert_eq!(error.request_id.as_deref(), Some("r1"));
    }

    #[test]
    fn only_a_complete_transcript_without_words_counts_as_no_speech() {
        let no_speech = |status: &str, words: serde_json::Value| {
            transcript_has_no_speech(&json!({
                "transcript": { "status": status, "wordCount": words },
                "text": "",
            }))
        };
        assert!(no_speech("complete", json!(0)));
        assert!(!no_speech("complete", json!(12)));
        assert!(!no_speech("complete", json!(null)));
        assert!(!no_speech("error", json!(0)));
        assert!(!no_speech("processing", json!(null)));
        assert!(!transcript_has_no_speech(&json!({ "text": "" })));
        assert!(!transcript_has_no_speech(&json!({
            "transcript": { "status": "complete", "wordCount": 0 },
            "text": "hello there",
        })));
        assert!(transcript_has_no_speech(&json!({
            "transcript": { "status": "complete", "wordCount": 0 },
        })));
    }

    #[test]
    fn wait_timeouts_are_bounded() {
        assert_eq!(validate_wait_seconds(None).unwrap(), 900);
        assert_eq!(validate_wait_seconds(Some(30)).unwrap(), 30);
        assert!(validate_wait_seconds(Some(0)).is_err());
        assert!(validate_wait_seconds(Some(86_401)).is_err());
    }

    #[test]
    fn video_bodies_only_send_requested_fields() {
        assert_eq!(
            video_create_body("demo.mp4", 2_048, None, None),
            json!({ "fileName": "demo.mp4", "contentLength": 2_048 })
        );
        assert_eq!(
            video_create_body("demo.mp4", 2_048, Some("Demo"), Some("user-1")),
            json!({
                "fileName": "demo.mp4",
                "contentLength": 2_048,
                "name": "Demo",
                "userId": "user-1",
            })
        );
    }

    #[test]
    fn video_paths_accept_ids_that_begin_with_a_dash() {
        assert_eq!(
            super::video_path("app_1", "-Vid0000000dash").unwrap(),
            "/developer/apps/app_1/videos/-Vid0000000dash"
        );
        assert_eq!(
            transcript_path("app_1", "-EDG5hrbuAwXDNY", false).unwrap(),
            "/developer/apps/app_1/transcripts/-EDG5hrbuAwXDNY"
        );
        assert!(super::video_path("app_1", "../video").is_err());
    }

    #[test]
    fn failed_waits_keep_the_id_they_waited_on() {
        let transcript = transcript_failure(
            &json!({
                "transcript": {
                    "status": "error",
                    "errorCode": "source_unreachable",
                    "errorMessage": "The URL answered 404",
                },
                "requestId": "r1",
            }),
            "-EDG5hrbuAwXDNY",
        );
        assert_eq!(
            transcript.context.details["transcriptId"],
            "-EDG5hrbuAwXDNY"
        );
        assert_eq!(transcript.context.details["status"], "error");
        assert!(transcript.context.hint.is_some());

        let video = super::video_failure(
            &json!({
                "video": { "status": "errored", "errorReason": "The file could not be decoded" },
                "requestId": "r2",
            }),
            "video-1",
        );
        assert_eq!(video.code, "VIDEO_FAILED");
        assert_eq!(video.message, "The file could not be decoded");
        assert_eq!(video.context.details["videoId"], "video-1");
        assert_eq!(video.request_id.as_deref(), Some("r2"));

        let serialized = serde_json::to_value(&video).unwrap();
        assert_eq!(serialized["videoId"], "video-1");
        assert_eq!(serialized["code"], "VIDEO_FAILED");
        assert!(serialized["hint"].is_string());
        assert!(video.describe().contains("videoId: video-1"));
    }

    #[test]
    fn server_hints_survive_parsing_and_extra_fields_are_dropped() {
        let error: crate::caps::AgentApiError = serde_json::from_value(json!({
            "_tag": "AgentForbiddenError",
            "code": "FORBIDDEN",
            "message": "The developer:read permission is required. Run `cap auth login --profile full`.",
            "retryable": false,
            "retryAfterMs": null,
            "requestId": "r3",
            "hint": "Run `cap auth login --profile full`.",
            "requiredScopes": ["developer:read"],
        }))
        .unwrap();
        assert_eq!(
            error.context.hint.as_deref(),
            Some("Run `cap auth login --profile full`.")
        );
        assert!(error.context.details.is_empty());
        assert!(!error.describe().contains("hint:"));
        let serialized = serde_json::to_value(&error).unwrap();
        assert!(serialized.get("_tag").is_none());
        assert_eq!(serialized["hint"], "Run `cap auth login --profile full`.");
    }

    #[test]
    fn domains_resolve_by_id_or_by_origin() {
        let context = json!({
            "domains": [
                { "id": "dom-1", "domain": "https://app.example.com" },
                { "id": "-dom-2", "domain": "https://www.example.com" },
            ],
        });
        let id = |value: &str| {
            super::domain_entry(&context, value)
                .and_then(|entry| entry.get("id"))
                .and_then(|id| id.as_str())
                .map(str::to_string)
        };
        assert_eq!(id("dom-1").as_deref(), Some("dom-1"));
        assert_eq!(id("https://app.example.com/").as_deref(), Some("dom-1"));
        assert_eq!(id("HTTPS://WWW.EXAMPLE.COM").as_deref(), Some("-dom-2"));
        assert_eq!(id("https://other.example.com"), None);
    }
}
