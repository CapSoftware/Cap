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
}

pub async fn create_transcript_from_url(
    client: &AgentClient,
    app_id: &str,
    url: &str,
    options: &TranscriptOptions,
) -> Result<Value, AgentApiError> {
    let app_id = opaque_id(app_id, "Developer app ID")?;
    let parsed = url::Url::parse(url).map_err(|_| invalid("The URL is not valid"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(invalid("The URL must start with http:// or https://"));
    }
    client
        .mutate_json_confirmed(
            Method::POST,
            &format!("/developer/apps/{app_id}/transcripts"),
            &transcript_url_body(url, options),
        )
        .await
        .map(without_upload_target)
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

pub fn transcript_failure(value: &Value) -> AgentApiError {
    let transcript = value.get("transcript");
    let field = |name: &str| {
        transcript
            .and_then(|transcript| transcript.get(name))
            .and_then(Value::as_str)
    };
    AgentApiError {
        code: "TRANSCRIPT_FAILED".to_string(),
        message: format!(
            "{} ({})",
            field("errorMessage").unwrap_or("The transcript could not be created"),
            field("errorCode").unwrap_or("transcription_failed")
        ),
        retryable: false,
        retry_after_ms: None,
        request_id: value
            .get("requestId")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

pub fn validate_wait_seconds(timeout_seconds: Option<u64>) -> Result<u64, AgentApiError> {
    let timeout = timeout_seconds.unwrap_or(DEFAULT_WAIT_SECONDS);
    if timeout == 0 || timeout > MAX_WAIT_SECONDS {
        return Err(invalid("timeoutSeconds must be between 1 and 86400"));
    }
    Ok(timeout)
}

pub async fn wait_for_transcript(
    client: &AgentClient,
    app_id: &str,
    transcript_id: &str,
    timeout_seconds: u64,
) -> Result<Value, AgentApiError> {
    let path = transcript_path(app_id, transcript_id, false)?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout_seconds);
    let mut attempt = 0_u32;
    loop {
        let value = client.get_json(&path).await?;
        match transcript_status(&value) {
            Some("complete") => return Ok(value),
            Some("error") => return Err(transcript_failure(&value)),
            Some("uploading") => {
                return Err(AgentApiError {
                    code: "NOT_READY".to_string(),
                    message: "The transcript is still waiting for its file".to_string(),
                    retryable: false,
                    retry_after_ms: None,
                    request_id: None,
                });
            }
            Some("queued" | "processing") => {}
            _ => return Err(invalid("Cap returned an invalid transcript status")),
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(AgentApiError {
                code: "NOT_READY".to_string(),
                message: "Timed out waiting for the transcript".to_string(),
                retryable: true,
                retry_after_ms: Some(2_000),
                request_id: None,
            });
        }
        let delay = 500_u64.saturating_mul(1_u64 << attempt.min(4));
        tokio::time::sleep(Duration::from_millis(delay.min(5_000))).await;
        attempt = attempt.saturating_add(1);
    }
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
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        TranscriptOptions, transcript_failure, transcript_file_body, transcript_path,
        transcript_status, transcript_url_body, validate_wait_seconds, video_create_body,
        without_upload_target,
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
        let error = transcript_failure(&value);
        assert_eq!(error.code, "TRANSCRIPT_FAILED");
        assert!(error.message.contains("insufficient_credits"));
        assert_eq!(error.request_id.as_deref(), Some("r1"));
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
}
