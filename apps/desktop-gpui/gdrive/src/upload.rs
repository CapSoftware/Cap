use std::{
    collections::BTreeMap,
    fmt,
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, LOCATION, RANGE};
use serde::Serialize;

use crate::api::{DriveHttp, FileInfo, classify, is_success, network_error, parse_file, read, url};
use crate::types::{CHUNK_ALIGN, DriveError, Endpoints, Progress, UploadOptions};

const CHUNK_TIMEOUT_FLOOR: Duration = Duration::from_secs(120);
const SLOWEST_UPLINK_BYTES_PER_SEC: u64 = 16 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct Session {
    pub uri: String,
    pub started_at_ms: i64,
}

pub(crate) struct Redacted;

impl fmt::Debug for Redacted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("uri", &Redacted)
            .field("started_at_ms", &self.started_at_ms)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMetadata {
    pub name: String,
    pub mime_type: String,
    pub parents: Vec<String>,
    pub description: Option<String>,
    pub app_properties: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionStatus {
    Received(u64),
    Complete(FileInfo),
    Gone,
    Rejected(DriveError),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UploadFailure {
    Interrupted(DriveError),
    SessionGone,
    Restart(DriveError),
    Fatal(DriveError),
}

#[derive(Clone, Copy, Debug)]
pub struct UploadSource<'a> {
    pub session: &'a Session,
    pub file: &'a Path,
    pub total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InitBody<'a> {
    name: &'a str,
    mime_type: &'a str,
    parents: &'a [String],
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    app_properties: &'a BTreeMap<String, String>,
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

pub(crate) fn transient(error: &DriveError) -> bool {
    match error {
        DriveError::Offline | DriveError::RateLimited => true,
        DriveError::Server { status, .. } => *status >= 500,
        _ => false,
    }
}

pub async fn start_session(
    http: &DriveHttp,
    endpoints: &Endpoints,
    token: &str,
    meta: &FileMetadata,
    total: u64,
) -> Result<Session, DriveError> {
    let body = serde_json::to_vec(&InitBody {
        name: &meta.name,
        mime_type: &meta.mime_type,
        parents: &meta.parents,
        description: meta.description.as_deref(),
        app_properties: &meta.app_properties,
    })
    .map_err(|e| DriveError::Protocol(e.to_string()))?;
    let response = http
        .api
        .post(url(&endpoints.upload, &["files"])?)
        .query(&[
            ("uploadType", "resumable"),
            ("fields", "id,webViewLink,size"),
        ])
        .bearer_auth(token)
        .header(CONTENT_TYPE, "application/json; charset=UTF-8")
        .header("X-Upload-Content-Type", meta.mime_type.as_str())
        .header("X-Upload-Content-Length", total)
        .body(body)
        .send()
        .await
        .map_err(network_error)?;
    let location = response
        .headers()
        .get(LOCATION)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let (status, body) = read(response).await?;
    if !is_success(status) {
        return Err(classify(status, &body));
    }
    let uri = location.ok_or_else(|| {
        DriveError::Protocol("Google Drive started an upload without a session URI".into())
    })?;
    Ok(Session {
        uri,
        started_at_ms: now_ms(),
    })
}

pub async fn query_status(
    http: &DriveHttp,
    session: &Session,
    total: u64,
) -> Result<SessionStatus, DriveError> {
    let response = http
        .upload
        .put(&session.uri)
        .timeout(chunk_timeout(0))
        .header(CONTENT_LENGTH, 0)
        .header(CONTENT_RANGE, format!("bytes */{total}"))
        .send()
        .await
        .map_err(network_error)?;
    let range = range_header(&response);
    let (status, body) = read(response).await?;
    match status {
        308 => Ok(SessionStatus::Received(
            parse_range(range.as_deref()).unwrap_or(0),
        )),
        200 | 201 => parse_file(&body).map(SessionStatus::Complete),
        404 | 410 => Ok(SessionStatus::Gone),
        _ => {
            let error = classify(status, &body);
            if (400..500).contains(&status) && !transient(&error) {
                Ok(SessionStatus::Rejected(error))
            } else {
                Err(error)
            }
        }
    }
}

fn range_header(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get(RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

async fn read_chunk(file: &Path, offset: u64, len: usize) -> Result<Vec<u8>, DriveError> {
    let path = file.to_path_buf();
    tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let mut file = std::fs::File::open(&path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0; len];
        file.read_exact(&mut buf)?;
        Ok(buf)
    })
    .await
    .map_err(|e| DriveError::LocalFile(e.to_string()))?
    .map_err(|e| DriveError::LocalFile(e.to_string()))
}

fn chunk_failure(status: u16, body: &str) -> UploadFailure {
    if status == 404 || status == 410 {
        return UploadFailure::SessionGone;
    }
    let error = classify(status, body);
    if transient(&error) {
        UploadFailure::Interrupted(error)
    } else if matches!(error, DriveError::StorageFull | DriveError::AdminBlocked) {
        UploadFailure::Fatal(error)
    } else if (400..500).contains(&status) {
        UploadFailure::Restart(error)
    } else {
        UploadFailure::Fatal(error)
    }
}

fn finish_empty(status: Result<SessionStatus, DriveError>) -> Result<FileInfo, UploadFailure> {
    match status {
        Ok(SessionStatus::Complete(info)) => Ok(info),
        Ok(SessionStatus::Gone) => Err(UploadFailure::SessionGone),
        Ok(SessionStatus::Rejected(error)) => Err(UploadFailure::Restart(error)),
        Ok(SessionStatus::Received(_)) => Err(UploadFailure::Restart(DriveError::Protocol(
            "Google Drive did not finish the upload after the last byte".into(),
        ))),
        Err(error) if transient(&error) => Err(UploadFailure::Interrupted(error)),
        Err(error) => Err(UploadFailure::Restart(error)),
    }
}

pub async fn upload_from(
    http: &DriveHttp,
    source: UploadSource<'_>,
    offset: u64,
    options: &UploadOptions,
    progress: &(dyn Fn(Progress) + Send + Sync),
    cancel: &AtomicBool,
    on_offset: &(dyn Fn(u64) + Send + Sync),
) -> Result<FileInfo, UploadFailure> {
    let UploadSource {
        session,
        file,
        total,
    } = source;
    let mut offset = offset;
    let mut stalled = 0u32;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(UploadFailure::Fatal(DriveError::Cancelled));
        }
        let len = chunk_len(offset, total, options.chunk_size);
        if len == 0 {
            match query_status(http, session, total).await {
                Ok(SessionStatus::Received(next)) if next < offset => {
                    offset = next;
                    on_offset(next);
                    continue;
                }
                status => {
                    let info = finish_empty(status)?;
                    progress(Progress { sent: total, total });
                    return Ok(info);
                }
            }
        }
        let bytes = read_chunk(file, offset, len)
            .await
            .map_err(UploadFailure::Fatal)?;
        let end = offset + len as u64 - 1;
        let response = http
            .upload
            .put(&session.uri)
            .timeout(chunk_timeout(len))
            .header(CONTENT_RANGE, format!("bytes {offset}-{end}/{total}"))
            .body(bytes)
            .send()
            .await
            .map_err(|e| UploadFailure::Interrupted(network_error(e)))?;
        let range = range_header(&response);
        let (status, body) = read(response).await.map_err(UploadFailure::Interrupted)?;
        match status {
            308 => {
                let next = parse_range(range.as_deref()).unwrap_or(0);
                if next > total {
                    return Err(UploadFailure::Restart(DriveError::Protocol(format!(
                        "Google Drive reported {next} of {total} bytes"
                    ))));
                }
                if next > offset {
                    stalled = 0;
                } else {
                    stalled += 1;
                    if stalled >= options.max_attempts.max(1) {
                        return Err(UploadFailure::Interrupted(DriveError::Protocol(
                            "Google Drive kept none of the bytes sent".into(),
                        )));
                    }
                }
                offset = next;
                on_offset(next);
                progress(Progress { sent: next, total });
            }
            200 | 201 => {
                let info = parse_file(&body).map_err(UploadFailure::Fatal)?;
                progress(Progress { sent: total, total });
                return Ok(info);
            }
            _ => return Err(chunk_failure(status, &body)),
        }
    }
}

pub fn chunk_timeout(len: usize) -> Duration {
    let seconds = (len as u64).div_ceil(SLOWEST_UPLINK_BYTES_PER_SEC);
    Duration::from_secs(seconds).max(CHUNK_TIMEOUT_FLOOR)
}

pub fn parse_range(header: Option<&str>) -> Option<u64> {
    let last = header?.trim().strip_prefix("bytes=0-")?;
    last.parse::<u64>().ok()?.checked_add(1)
}

pub fn chunk_len(offset: u64, total: u64, chunk_size: usize) -> usize {
    let aligned = (chunk_size / CHUNK_ALIGN).max(1) * CHUNK_ALIGN;
    let remaining = total.saturating_sub(offset);
    usize::try_from(remaining).map_or(aligned, |remaining| remaining.min(aligned))
}
