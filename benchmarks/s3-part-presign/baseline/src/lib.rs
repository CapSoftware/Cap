use std::{collections::HashMap, io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use reqwest::StatusCode;
use serde::{Serialize, Deserialize};
use serde_json::{Value, json};
const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE: u64 = 15 * 1024 * 1024;
const DRIVE_CHUNK_ALIGNMENT: u64 = 256 * 1024;


#[derive(Debug, Clone)]
pub enum AuthApiError {
    InvalidAuthentication,
    UpgradeRequired,
    Timeout,
    Status(reqwest::StatusCode, String),
    Other(String),
}

impl AuthApiError {
    pub fn message(&self) -> String {
        match self {
            Self::InvalidAuthentication => {
                "User is not authenticated or credentials have expired!".into()
            }
            Self::UpgradeRequired => {
                "User needs to upgrade their account to use this feature!".into()
            }
            Self::Timeout => "The request has timed out".into(),
            Self::Status(_, message) | Self::Other(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for AuthApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}



#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
struct UploadedPart {
    part_number: u32,
    etag: String,
    size: usize,
    #[serde(skip)]
    object_identity: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct ReplacementUploadFile {
    path: PathBuf,
    size: u64,
    modified: std::time::SystemTime,
}

impl ReplacementUploadFile {
    fn read(path: &Path) -> Result<Self, AuthApiError> {
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            AuthApiError::Other(format!("Failed to inspect replacement export: {error}"))
        })?;
        if !metadata.file_type().is_file() || metadata.len() == 0 {
            return Err(replacement_source_changed());
        }
        Ok(Self {
            path: path.canonicalize().map_err(|error| {
                AuthApiError::Other(format!("Failed to resolve replacement export: {error}"))
            })?,
            size: metadata.len(),
            modified: metadata.modified().map_err(|error| {
                AuthApiError::Other(format!(
                    "Failed to inspect replacement export time: {error}"
                ))
            })?,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
struct ReplacementUploadChunk {
    offset: u64,
    size: usize,
    md5: String,
}

#[derive(Debug)]
struct ReplacementUploadSource {
    file: ReplacementUploadFile,
    chunks: Vec<ReplacementUploadChunk>,
    sealed: bool,
}

fn replacement_source_changed() -> AuthApiError {
    AuthApiError::Other("Rendered video changed during replacement upload".into())
}

impl ReplacementUploadSource {
    fn new(path: &Path) -> Result<Self, AuthApiError> {
        Ok(Self {
            file: ReplacementUploadFile::read(path)?,
            chunks: Vec::new(),
            sealed: false,
        })
    }

    fn validate_file(&self, path: &Path) -> Result<(), AuthApiError> {
        if ReplacementUploadFile::read(path)? != self.file {
            return Err(replacement_source_changed());
        }
        Ok(())
    }

    fn check_chunk(
        &mut self,
        part_number: u32,
        offset: u64,
        bytes: &[u8],
        file_size: u64,
    ) -> Result<(), AuthApiError> {
        let index = usize::try_from(part_number)
            .ok()
            .and_then(|part| part.checked_sub(1))
            .ok_or_else(replacement_source_changed)?;
        if file_size != self.file.size || bytes.is_empty() {
            return Err(replacement_source_changed());
        }
        let chunk = ReplacementUploadChunk {
            offset,
            size: bytes.len(),
            md5: md5_base64(bytes),
        };
        if self.sealed {
            if self.chunks.get(index) != Some(&chunk) {
                return Err(replacement_source_changed());
            }
        } else {
            let expected_offset = self
                .chunks
                .last()
                .map(|previous| previous.offset.saturating_add(previous.size as u64))
                .unwrap_or(0);
            if index != self.chunks.len() || offset != expected_offset {
                return Err(replacement_source_changed());
            }
            self.chunks.push(chunk);
        }
        Ok(())
    }

    fn seal_parts(&mut self, parts: &[UploadedPart]) -> Result<(), AuthApiError> {
        if parts.len() != self.chunks.len() || parts.is_empty() {
            return Err(replacement_source_changed());
        }
        let mut size = 0u64;
        for (index, (part, chunk)) in parts.iter().zip(&self.chunks).enumerate() {
            if usize::try_from(part.part_number).ok() != Some(index + 1)
                || part.size != chunk.size
                || chunk.offset != size
            {
                return Err(replacement_source_changed());
            }
            size = size
                .checked_add(chunk.size as u64)
                .ok_or_else(replacement_source_changed)?;
        }
        if size != self.file.size {
            return Err(replacement_source_changed());
        }
        self.sealed = true;
        Ok(())
    }
}



struct PartChunk {
    part_number: u32,
    offset: u64,
    bytes: bytes::Bytes,
}

struct PresignedPart {
    url: String,
    md5: Option<String>,
}

trait PartTransport: Sync {
    fn presign(
        &self,
        chunk: &PartChunk,
        cancel: &AtomicBool,
    ) -> impl Future<Output = Result<PresignedPart, AuthApiError>> + Send;
    fn put(
        &self,
        presigned: &PresignedPart,
        chunk: &PartChunk,
        total_size: u64,
        cancel: &AtomicBool,
    ) -> impl Future<Output = Result<UploadedPart, AuthApiError>> + Send;
}



mod cap_recording { pub mod upload_verification {
fn valid_object_identity(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 1024
        && value.starts_with('"')
        && value.ends_with('"')
        && value[1..value.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
}
pub fn completed_drive_object_identity(
    value: &serde_json::Value,
    expected_size: u64,
) -> Option<String> {
    let id = value.get("id")?.as_str()?;
    let version = value.get("version")?.as_str()?;
    let size = value.get("size")?.as_str()?.parse::<u64>().ok()?;
    if id.is_empty()
        || version.is_empty()
        || !version.bytes().all(|byte| byte.is_ascii_digit())
        || size != expected_size
        || size == 0
    {
        return None;
    }
    let identity = format!("\"{id}:{version}\"");
    valid_object_identity(&identity).then_some(identity)
}
}}

mod cap_gpui_kernels { pub mod codec { use md5::{Digest as _, Md5};
pub fn md5(bytes: &[u8]) -> [u8; 16] {
    let digest = Md5::digest(bytes);
    let mut output = [0; 16];
    output.copy_from_slice(&digest);
    output
}
}}

fn check_export_cancelled(cancel: &AtomicBool) -> Result<(), AuthApiError> {
    if cancel.load(Ordering::Acquire) {
        Err(AuthApiError::Other("Export cancelled".into()))
    } else {
        Ok(())
    }
}

async fn checked_upload_step<T, F>(
    cancel: &AtomicBool,
    step: impl FnOnce() -> F,
) -> Result<T, AuthApiError>
where
    F: Future<Output = Result<T, AuthApiError>>,
{
    check_export_cancelled(cancel)?;
    let result = step().await;
    check_export_cancelled(cancel)?;
    result
}

async fn upload_part_chunk(
    transport: &impl PartTransport,
    chunk: &PartChunk,
    total_size: u64,
    cancel: &AtomicBool,
) -> Result<UploadedPart, AuthApiError> {
    tokio::select! {
        biased;
        () = wait_for_export_cancel(cancel) => Err(AuthApiError::Other("Export cancelled".into())),
        result = async {
            let presigned = transport.presign(chunk, cancel).await?;
            transport.put(&presigned, chunk, total_size, cancel).await
        } => result,
    }
}

async fn wait_for_export_cancel(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn upload_file_parts(
    transport: &impl PartTransport,
    file_path: &Path,
    file_size: u64,
    chunk_size: u64,
    progress: &impl Fn(f64),
    cancel: &AtomicBool,
    mut replacement_source: Option<&mut ReplacementUploadSource>,
) -> Result<Vec<UploadedPart>, AuthApiError> {
    let mut parts = Vec::new();
    let mut failed = Vec::new();
    let mut offset = 0u64;
    let mut uploaded_bytes = 0u64;
    let mut part_number = 1u32;

    while offset < file_size {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        let size = (file_size - offset).min(chunk_size) as usize;
        let chunk = read_chunk(file_path, offset, size)?;
        if let Some(source) = &mut replacement_source {
            source.check_chunk(part_number, offset, &chunk, file_size)?;
        }
        let chunk = PartChunk {
            part_number,
            offset,
            bytes: chunk.into(),
        };
        match upload_part_chunk(transport, &chunk, file_size, cancel).await {
            Ok(part) => {
                uploaded_bytes += size as u64;
                progress((uploaded_bytes as f64 / file_size as f64).min(0.99));
                parts.push(part);
            }
            Err(error) => {
                check_export_cancelled(cancel)?;
                tracing::warn!(part_number, error = %error, "chunk upload failed; will retry");
                failed.push((chunk, error));
            }
        }
        offset += size as u64;
        part_number += 1;
    }

    for (chunk, first_error) in failed {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        match upload_part_chunk(transport, &chunk, file_size, cancel).await {
            Ok(part) => {
                uploaded_bytes += chunk.bytes.len() as u64;
                progress((uploaded_bytes as f64 / file_size as f64).min(0.99));
                parts.push(part);
            }
            Err(_) => {
                check_export_cancelled(cancel)?;
                return Err(first_error);
            }
        }
    }

    parts.sort_by_key(|part| part.part_number);
    let mut deduped = HashMap::new();
    for part in parts {
        deduped.insert(part.part_number, part);
    }
    let mut parts = deduped.into_values().collect::<Vec<_>>();
    parts.sort_by_key(|part| part.part_number);
    Ok(parts)
}

async fn put_presigned_part(
    client: &reqwest::Client,
    url: &str,
    chunk: &PartChunk,
    total_size: u64,
    is_drive: bool,
    md5_sum: Option<&str>,
    cancel: &AtomicBool,
) -> Result<UploadedPart, AuthApiError> {
    let PartChunk {
        part_number,
        offset,
        ref bytes,
    } = *chunk;
    let mut attempt = 0u32;
    loop {
        let mut request = client
            .put(url)
            .header("Content-Length", bytes.len())
            .timeout(Duration::from_secs(5 * 60))
            .body(bytes.clone());
        if is_drive || is_google_drive_resumable_url(url) {
            let end = offset.saturating_add(bytes.len() as u64).saturating_sub(1);
            request = request.header(
                "Content-Range",
                format!("bytes {offset}-{end}/{total_size}"),
            );
        }
        if let Some(md5_sum) = md5_sum {
            request = request.header("Content-MD5", md5_sum);
        }
        let response =
            checked_upload_step(cancel, || async { Ok(send_upload_request(request).await) })
                .await?;
        match response {
            Ok(response) => {
                if !upload_status_ok(
                    url,
                    response.status(),
                    offset,
                    bytes.len() as u64,
                    total_size,
                ) {
                    let status = response.status();
                    return Err(AuthApiError::Other(format!(
                        "uploader/part/{part_number}/status/{status}"
                    )));
                }
                let etag = response
                    .headers()
                    .get("ETag")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_string();
                let object_identity = if (is_drive || is_google_drive_resumable_url(url))
                    && response.status().is_success()
                {
                    response.json::<Value>().await.ok().and_then(|value| {
                        cap_recording::upload_verification::completed_drive_object_identity(
                            &value, total_size,
                        )
                    })
                } else {
                    None
                };
                return Ok(UploadedPart {
                    part_number,
                    etag,
                    size: bytes.len(),
                    object_identity,
                });
            }
            Err(error) if is_network_error(&error) && attempt < 4 => {
                attempt += 1;
                let delay = Duration::from_secs(2u64.saturating_pow(attempt).min(30));
                tracing::info!(
                    part_number,
                    attempt,
                    "network error uploading chunk; retrying in {delay:?}: {error}"
                );
                checked_upload_step(cancel, || async {
                    tokio::time::sleep(delay).await;
                    Ok(())
                })
                .await?;
            }
            Err(error) => {
                return Err(AuthApiError::Other(format!(
                    "uploader/part/{part_number}/error: {error}"
                )));
            }
        }
    }
}

async fn send_upload_request(
    request: reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    request.send().await.map_err(reqwest::Error::without_url)
}

fn read_chunk(path: &Path, offset: u64, size: usize) -> Result<Vec<u8>, AuthApiError> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| AuthApiError::Other(format!("Failed to open export: {error}")))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| AuthApiError::Other(format!("Failed to seek export: {error}")))?;
    let mut buffer = vec![0u8; size];
    file.read_exact(&mut buffer)
        .map_err(|error| AuthApiError::Other(format!("Failed to read export chunk: {error}")))?;
    Ok(buffer)
}

fn chunk_size_for(file_size: u64) -> u64 {
    let size = (file_size / 100).clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
    size / DRIVE_CHUNK_ALIGNMENT * DRIVE_CHUNK_ALIGNMENT
}

fn md5_base64(bytes: &[u8]) -> String {
    let digest = cap_gpui_kernels::codec::md5(bytes);
    base64::Engine::encode(&base64::engine::general_purpose::STANDARD, digest)
}

fn is_google_drive_resumable_url(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    url.host_str().is_some_and(|host| {
        (host == "googleapis.com" || host.ends_with(".googleapis.com"))
            && url.path().starts_with("/upload/drive/")
    })
}

fn upload_status_ok(
    url: &str,
    status: StatusCode,
    offset: u64,
    size: u64,
    total_size: u64,
) -> bool {
    status.is_success()
        || (is_google_drive_resumable_url(url)
            && status == StatusCode::PERMANENT_REDIRECT
            && offset.saturating_add(size) < total_size)
}

fn is_network_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

#[cfg(test)]
mod multipart_tests {
use super::*;
use std::collections::HashSet;
use std::sync::atomic::AtomicUsize;

struct TempExport(PathBuf);

impl TempExport {
    fn new(bytes: &[u8]) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "cap-gpui-multipart-{}-{}.mp4",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::AcqRel),
        ));
        std::fs::write(&path, bytes).unwrap();
        Self(path)
    }
}

impl Drop for TempExport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn export_bytes(len: usize) -> Vec<u8> {
    (0..len).map(|index| (index * 7 % 251) as u8).collect()
}

struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

const S3_URL: &str = "https://cap-test.s3.us-east-1.amazonaws.com/export.mp4?partNumber=";

#[derive(Default)]
struct FakeParts {
    /// Every part PUT in start order, with the bytes it sent.
    started: Mutex<Vec<(u32, u64, Vec<u8>)>>,
    /// (event, part) in order: "presign", "put".
    events: Mutex<Vec<(&'static str, u32)>>,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
    fail_once: Mutex<HashSet<u32>>,
    fail_always: HashSet<u32>,
    hang_from: Option<u32>,
}

impl FakeParts {
    fn started_parts(&self) -> Vec<u32> {
        self.started
            .lock()
            .unwrap()
            .iter()
            .map(|(part, _, _)| *part)
            .collect()
    }
}

impl PartTransport for FakeParts {
    async fn presign(
        &self,
        chunk: &PartChunk,
        _cancel: &AtomicBool,
    ) -> Result<PresignedPart, AuthApiError> {
        self.events
            .lock()
            .unwrap()
            .push(("presign", chunk.part_number));
        Ok(PresignedPart {
            url: format!("{S3_URL}{}", chunk.part_number),
            md5: None,
        })
    }

    async fn put(
        &self,
        _presigned: &PresignedPart,
        chunk: &PartChunk,
        _total_size: u64,
        _cancel: &AtomicBool,
    ) -> Result<UploadedPart, AuthApiError> {
        self.events.lock().unwrap().push(("put", chunk.part_number));
        self.started
            .lock()
            .unwrap()
            .push((chunk.part_number, chunk.offset, chunk.bytes.to_vec()));
        let now = self.in_flight.fetch_add(1, Ordering::AcqRel) + 1;
        let _guard = InFlight(&self.in_flight);
        self.max_in_flight.fetch_max(now, Ordering::AcqRel);
        if self.hang_from.is_some_and(|from| chunk.part_number >= from) {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
        if self.fail_always.contains(&chunk.part_number)
            || self.fail_once.lock().unwrap().remove(&chunk.part_number)
        {
            return Err(AuthApiError::Other(format!(
                "uploader/part/{}/status/500",
                chunk.part_number
            )));
        }
        Ok(UploadedPart {
            part_number: chunk.part_number,
            etag: format!("etag-{}", chunk.part_number),
            size: chunk.bytes.len(),
            object_identity: None,
        })
    }
}

async fn run(
    transport: &impl PartTransport,
    export: &TempExport,
    chunk_size: u64,
    cancel: &AtomicBool,
    source: Option<&mut ReplacementUploadSource>,
) -> (Result<Vec<UploadedPart>, AuthApiError>, Vec<f64>) {
    let progress = Mutex::new(Vec::new());
    let size = std::fs::metadata(&export.0).unwrap().len();
    let result = upload_file_parts(
        transport,
        &export.0,
        size,
        chunk_size,
        &|value| progress.lock().unwrap().push(value),
        cancel,
        source,
    )
    .await;
    (result, progress.into_inner().unwrap())
}

/// Compares the exact JSON `multipart_complete` sends for these parts.
fn assert_parts(parts: &[UploadedPart], sizes: &[usize]) {
    let expected = sizes
        .iter()
        .enumerate()
        .map(|(index, size)| {
            json!({ "partNumber": index + 1, "etag": format!("etag-{}", index + 1), "size": size })
        })
        .collect::<Vec<_>>();
    assert_eq!(serde_json::to_value(parts).unwrap(), Value::Array(expected));
}

#[tokio::test]
async fn parts_upload_one_at_a_time_in_order_with_serial_progress() {
    let bytes = export_bytes(18);
    let export = TempExport::new(&bytes);
    let transport = FakeParts::default();
    let (result, progress) = run(&transport, &export, 4, &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[4, 4, 4, 4, 2]);
    assert_eq!(transport.max_in_flight.load(Ordering::Acquire), 1);
    assert_eq!(
        *transport.events.lock().unwrap(),
        (1..=5)
            .flat_map(|part| [("presign", part), ("put", part)])
            .collect::<Vec<_>>()
    );
    for (part, offset, chunk) in transport.started.lock().unwrap().iter() {
        assert_eq!(*offset, u64::from(part - 1) * 4);
        let start = *offset as usize;
        assert_eq!(
            chunk.as_slice(),
            &bytes[start..(start + 4).min(bytes.len())]
        );
    }
    assert_eq!(
        progress,
        [4.0 / 18.0, 8.0 / 18.0, 12.0 / 18.0, 16.0 / 18.0, 0.99]
    );
}

#[tokio::test]
async fn failed_part_is_retried_after_the_rest_and_upload_completes() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts {
        fail_once: Mutex::new(HashSet::from([3, 6])),
        ..FakeParts::default()
    };
    let progress = Mutex::new(Vec::new());
    let result = upload_file_parts(
        &transport,
        &export.0,
        40,
        4,
        &|value| {
            progress
                .lock()
                .unwrap()
                .push((transport.started_parts().len(), value));
        },
        &AtomicBool::new(false),
        None,
    )
    .await;
    assert_parts(&result.unwrap(), &[4; 10]);
    let started = transport.started_parts();
    assert_eq!(started.len(), 12);
    assert_eq!(&started[10..], [3, 6]);
    assert_eq!(
        progress.into_inner().unwrap(),
        [
            (1, 0.1),
            (2, 0.2),
            (4, 0.3),
            (5, 0.4),
            (7, 0.5),
            (8, 0.6),
            (9, 0.7),
            (10, 0.8),
            (11, 0.9),
            (12, 0.99),
        ]
    );
    let retried = transport.started.lock().unwrap();
    assert_eq!(retried[10].2, retried[2].2);
}

#[tokio::test]
async fn part_failing_its_retry_returns_the_first_error() {
    let export = TempExport::new(&export_bytes(20));
    let transport = FakeParts {
        fail_always: HashSet::from([2]),
        ..FakeParts::default()
    };
    let (result, progress) = run(&transport, &export, 4, &AtomicBool::new(false), None).await;
    assert_eq!(
        result.unwrap_err().to_string(),
        "uploader/part/2/status/500"
    );
    assert_eq!(transport.started_parts(), [1, 2, 3, 4, 5, 2]);
    assert_eq!(progress, [0.2, 0.4, 0.6, 0.8]);
}

#[tokio::test]
async fn cancel_mid_upload_drops_the_in_flight_part_and_starts_no_more() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts {
        hang_from: Some(3),
        ..FakeParts::default()
    };
    let cancel = AtomicBool::new(false);
    let started = Instant::now();
    let (result, progress) = tokio::join!(run(&transport, &export, 4, &cancel, None), async {
        while transport.started_parts().len() < 3 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        cancel.store(true, Ordering::Release);
    })
    .0;
    assert!(result.unwrap_err().to_string().contains("Export cancelled"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(transport.started_parts(), [1, 2, 3]);
    assert_eq!(transport.in_flight.load(Ordering::Acquire), 0);
    assert_eq!(progress, [0.1, 0.2]);
}

#[tokio::test]
async fn cancelled_before_start_reads_no_parts() {
    let export = TempExport::new(&export_bytes(40));
    let transport = FakeParts::default();
    let (result, progress) = run(&transport, &export, 4, &AtomicBool::new(true), None).await;
    assert!(result.unwrap_err().to_string().contains("Export cancelled"));
    assert!(transport.started_parts().is_empty());
    assert!(progress.is_empty());
}

#[tokio::test]
async fn replacement_upload_checks_reads_in_order_and_seals() {
    let export = TempExport::new(&export_bytes(22));
    let mut source = ReplacementUploadSource::new(&export.0).unwrap();
    let transport = FakeParts::default();
    let (result, _) = run(
        &transport,
        &export,
        4,
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    let parts = result.unwrap();
    assert_eq!(
        source
            .chunks
            .iter()
            .map(|chunk| (chunk.offset, chunk.size))
            .collect::<Vec<_>>(),
        [(0, 4), (4, 4), (8, 4), (12, 4), (16, 4), (20, 2)]
    );
    source.seal_parts(&parts).unwrap();

    let restarted = FakeParts::default();
    let (result, _) = run(
        &restarted,
        &export,
        4,
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    assert_eq!(
        serde_json::to_value(result.unwrap()).unwrap(),
        serde_json::to_value(&parts).unwrap()
    );

    std::fs::write(&export.0, &export_bytes(23)[1..]).unwrap();
    let changed = FakeParts::default();
    let (result, _) = run(
        &changed,
        &export,
        4,
        &AtomicBool::new(false),
        Some(&mut source),
    )
    .await;
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("Rendered video changed")
    );
    assert!(changed.started_parts().is_empty());
}

/// A loopback HTTP/1.1 server that serves presign and part PUT requests over
/// real sockets while modelling a WAN link: handshake round trips on every new
/// connection, per-connection slow start capped by a send window, one round
/// trip per request, and a link bandwidth shared by all connections.
mod mock_network {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};

    const INITIAL_WINDOW: usize = 10 * 1460;

    #[derive(Clone, Copy)]
    pub(super) struct Profile {
        pub rtt: Duration,
        pub link_bytes_per_sec: f64,
        pub max_window: usize,
        pub handshake_rtts: u32,
        pub presign_server_time: Duration,
    }

    struct Link {
        profile: Profile,
        next_free: Mutex<std::time::Instant>,
    }

    impl Link {
        fn transmit(&self, bytes: usize) {
            let done = {
                let mut next_free = self.next_free.lock().unwrap();
                let start = (*next_free).max(std::time::Instant::now());
                *next_free =
                    start + Duration::from_secs_f64(bytes as f64 / self.profile.link_bytes_per_sec);
                *next_free
            };
            let wait = done.saturating_duration_since(std::time::Instant::now());
            if !wait.is_zero() {
                std::thread::sleep(wait);
            }
        }
    }

    #[derive(Default)]
    pub(super) struct Recorded {
        pub received: Mutex<HashMap<u32, usize>>,
        /// Every part PUT in arrival order with its Content-Range header.
        pub puts: Mutex<Vec<(u32, Option<String>)>>,
        active_puts: AtomicUsize,
        pub max_active_puts: AtomicUsize,
    }

    pub(super) struct Server {
        pub addr: std::net::SocketAddr,
        pub connections: Arc<AtomicUsize>,
        pub recorded: Arc<Recorded>,
        stop: Arc<AtomicBool>,
        listener: Option<std::thread::JoinHandle<()>>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            let _ = TcpStream::connect(self.addr);
            if let Some(listener) = self.listener.take() {
                let _ = listener.join();
            }
        }
    }

    pub(super) fn start(profile: Profile) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let link = Arc::new(Link {
            profile,
            next_free: Mutex::new(std::time::Instant::now()),
        });
        let connections = Arc::new(AtomicUsize::new(0));
        let recorded = Arc::new(Recorded::default());
        let stop = Arc::new(AtomicBool::new(false));
        let listener = std::thread::spawn({
            let connections = connections.clone();
            let recorded = recorded.clone();
            let stop = stop.clone();
            move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    let Ok(stream) = stream else { return };
                    connections.fetch_add(1, Ordering::AcqRel);
                    let link = link.clone();
                    let recorded = recorded.clone();
                    std::thread::spawn(move || serve(stream, addr, &link, &recorded));
                }
            }
        });
        Server {
            addr,
            connections,
            recorded,
            stop,
            listener: Some(listener),
        }
    }

    fn serve(stream: TcpStream, addr: std::net::SocketAddr, link: &Link, recorded: &Recorded) {
        let profile = link.profile;
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::with_capacity(64 * 1024, stream);
        let mut window = INITIAL_WINDOW;
        let mut handshake = true;
        loop {
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                return;
            }
            let mut content_length = 0usize;
            let mut content_range = None;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    return;
                }
                let line = line.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-length")
                {
                    content_length = value.trim().parse().unwrap();
                }
                if let Some((name, value)) = line.split_once(':')
                    && name.eq_ignore_ascii_case("content-range")
                {
                    content_range = Some(value.trim().to_string());
                }
            }
            let path = request_line.split(' ').nth(1).unwrap_or("/").to_string();
            let part = path
                .rsplit_once("/part/")
                .map(|(_, part)| part.split('?').next().unwrap().parse::<u32>().unwrap());
            if let Some(part) = part {
                recorded.puts.lock().unwrap().push((part, content_range));
                let active = recorded.active_puts.fetch_add(1, Ordering::AcqRel) + 1;
                recorded.max_active_puts.fetch_max(active, Ordering::AcqRel);
            }
            if std::mem::take(&mut handshake) {
                std::thread::sleep(profile.rtt * profile.handshake_rtts);
            }
            let mut remaining = content_length;
            let mut buffer = vec![0u8; 64 * 1024];
            while remaining > 0 {
                let round = std::time::Instant::now();
                let mut budget = window.min(remaining);
                while budget > 0 {
                    let read = reader.read(&mut buffer[..budget.min(64 * 1024)]).unwrap();
                    assert!(read > 0);
                    link.transmit(read);
                    budget -= read;
                    remaining -= read;
                }
                window = (window * 2).min(profile.max_window);
                let wait = profile.rtt.saturating_sub(round.elapsed());
                if remaining > 0 && !wait.is_zero() {
                    std::thread::sleep(wait);
                }
            }
            std::thread::sleep(profile.rtt);
            let response = if let Some(part) = path.strip_prefix("/presign/") {
                std::thread::sleep(profile.presign_server_time);
                let body = format!(r#"{{"presignedUrl":"http://{addr}/part/{part}"}}"#);
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
            } else {
                let part = part.unwrap();
                recorded
                    .received
                    .lock()
                    .unwrap()
                    .insert(part, content_length);
                format!("HTTP/1.1 200 OK\r\nETag: \"etag-{part}\"\r\nContent-Length: 0\r\n\r\n")
            };
            let written = writer.write_all(response.as_bytes());
            if part.is_some() {
                recorded.active_puts.fetch_sub(1, Ordering::AcqRel);
            }
            if written.is_err() {
                return;
            }
        }
    }
}

fn local_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

/// Presigns and PUTs over real HTTP, either on a fresh client per request (the
/// previous behaviour, where `auth::authed_request` and every part built their
/// own client) or on one API client and one storage client for the upload.
/// With `drive_urls`, presigning returns Google Drive resumable URLs that the
/// storage client resolves to the server.
struct MockPartTransport {
    addr: std::net::SocketAddr,
    shared: Option<(reqwest::Client, reqwest::Client)>,
    drive_urls: bool,
}

impl PartTransport for MockPartTransport {
    async fn presign(
        &self,
        chunk: &PartChunk,
        _cancel: &AtomicBool,
    ) -> Result<PresignedPart, AuthApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Presigned {
            presigned_url: String,
        }
        if self.drive_urls {
            return Ok(PresignedPart {
                url: format!(
                    "http://www.googleapis.com:{}/upload/drive/v3/files/part/{}?upload_id=cap-test",
                    self.addr.port(),
                    chunk.part_number
                ),
                md5: None,
            });
        }
        let fresh;
        let client = match &self.shared {
            Some((api, _)) => api,
            None => {
                fresh = local_client();
                &fresh
            }
        };
        let url = client
            .post(format!(
                "http://{}/presign/{}",
                self.addr, chunk.part_number
            ))
            .json(&json!({ "partNumber": chunk.part_number }))
            .send()
            .await
            .map_err(|error| AuthApiError::Other(error.to_string()))?
            .json::<Presigned>()
            .await
            .map_err(|error| AuthApiError::Other(error.to_string()))?
            .presigned_url;
        Ok(PresignedPart { url, md5: None })
    }

    async fn put(
        &self,
        presigned: &PresignedPart,
        chunk: &PartChunk,
        total_size: u64,
        cancel: &AtomicBool,
    ) -> Result<UploadedPart, AuthApiError> {
        let fresh;
        let client = match &self.shared {
            Some((_, storage)) => storage,
            None => {
                fresh = local_client();
                &fresh
            }
        };
        put_presigned_part(
            client,
            &presigned.url,
            chunk,
            total_size,
            false,
            None,
            cancel,
        )
        .await
    }
}

fn fast_local_profile() -> mock_network::Profile {
    mock_network::Profile {
        rtt: Duration::from_millis(10),
        link_bytes_per_sec: 1e9,
        max_window: 1 << 20,
        handshake_rtts: 0,
        presign_server_time: Duration::ZERO,
    }
}

#[tokio::test]
async fn drive_urls_without_a_drive_initiate_are_put_in_order_with_content_range() {
    const CHUNK: usize = 6 * 1024 * 1024;
    const SIZE: usize = 2 * CHUNK + 123;
    let export = TempExport::new(&export_bytes(SIZE));
    let server = mock_network::start(fast_local_profile());
    let transport = MockPartTransport {
        addr: server.addr,
        shared: Some((
            local_client(),
            reqwest::Client::builder()
                .no_proxy()
                .resolve("www.googleapis.com", server.addr)
                .build()
                .unwrap(),
        )),
        drive_urls: true,
    };
    let (result, progress) = run(
        &transport,
        &export,
        chunk_size_for(601 * 1024 * 1024),
        &AtomicBool::new(false),
        None,
    )
    .await;
    let parts = result.unwrap();
    assert_eq!(
        parts
            .iter()
            .map(|part| (part.part_number, part.size))
            .collect::<Vec<_>>(),
        [(1, CHUNK), (2, CHUNK), (3, 123)]
    );
    assert_eq!(
        *server.recorded.puts.lock().unwrap(),
        [
            (1, Some(format!("bytes 0-{}/{SIZE}", CHUNK - 1))),
            (2, Some(format!("bytes {CHUNK}-{}/{SIZE}", 2 * CHUNK - 1))),
            (3, Some(format!("bytes {}-{}/{SIZE}", 2 * CHUNK, SIZE - 1))),
        ]
    );
    assert_eq!(server.recorded.max_active_puts.load(Ordering::Acquire), 1);
    assert_eq!(progress, [CHUNK as f64 / SIZE as f64, 0.99, 0.99]);
}

#[tokio::test]
async fn s3_urls_reuse_one_connection_per_client_one_part_at_a_time() {
    let export = TempExport::new(&export_bytes(8000));
    let server = mock_network::start(fast_local_profile());
    let transport = MockPartTransport {
        addr: server.addr,
        shared: Some((local_client(), local_client())),
        drive_urls: false,
    };
    let (result, _) = run(&transport, &export, 1000, &AtomicBool::new(false), None).await;
    assert_parts(&result.unwrap(), &[1000; 8]);
    let puts = server.recorded.puts.lock().unwrap();
    assert_eq!(
        puts.iter().map(|(part, _)| *part).collect::<Vec<_>>(),
        (1..=8).collect::<Vec<_>>()
    );
    assert!(puts.iter().all(|(_, range)| range.is_none()));
    assert_eq!(server.recorded.max_active_puts.load(Ordering::Acquire), 1);
    assert_eq!(server.connections.load(Ordering::Acquire), 2);
}

/// `cargo test --bin cap-gpui multipart_mock_network_benchmark -- --ignored --nocapture`
/// `CAP_UPLOAD_BENCH_MB` overrides the export size (default 300).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "benchmark: moves hundreds of MB through a throttled loopback server"]
async fn multipart_mock_network_benchmark() {
    let megabytes = std::env::var("CAP_UPLOAD_BENCH_MB")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(300);
    let file_size = megabytes * 1_000_000;
    let export = TempExport(std::env::temp_dir().join(format!(
        "cap-gpui-multipart-bench-{}.mp4",
        std::process::id()
    )));
    {
        let file = std::fs::File::create(&export.0).unwrap();
        let block = export_bytes(1 << 20);
        let mut writer = std::io::BufWriter::new(file);
        let mut written = 0u64;
        while written < file_size {
            let take = (file_size - written).min(block.len() as u64) as usize;
            std::io::Write::write_all(&mut writer, &block[..take]).unwrap();
            written += take as u64;
        }
    }
    let chunk_size = chunk_size_for(file_size);
    let part_count = file_size.div_ceil(chunk_size);
    println!(
        "{megabytes} MB export, {part_count} parts of {} MB; window 2 MiB, TCP+TLS handshake 2 RTT, presign server 20 ms",
        chunk_size / 1_000_000
    );
    println!("| RTT | link | fresh clients (before) | shared clients (after) | speedup |");
    println!("|---|---|---|---|---|");
    for (rtt_ms, mbps) in [(50u64, 100.0f64), (150, 100.0), (50, 500.0), (150, 20.0)] {
        let profile = mock_network::Profile {
            rtt: Duration::from_millis(rtt_ms),
            link_bytes_per_sec: mbps * 1_000_000.0 / 8.0,
            max_window: 2 << 20,
            handshake_rtts: 2,
            presign_server_time: Duration::from_millis(20),
        };
        let mut times = Vec::new();
        for shared in [false, true] {
            let server = mock_network::start(profile);
            let transport = MockPartTransport {
                addr: server.addr,
                shared: shared.then(|| (local_client(), local_client())),
                drive_urls: false,
            };
            let progress = Mutex::new(Vec::new());
            let started = Instant::now();
            let parts = upload_file_parts(
                &transport,
                &export.0,
                file_size,
                chunk_size,
                &|value| progress.lock().unwrap().push(value),
                &AtomicBool::new(false),
                None,
            )
            .await
            .unwrap();
            let elapsed = started.elapsed();
            assert_eq!(parts.len() as u64, part_count);
            assert!(
                parts
                    .iter()
                    .enumerate()
                    .all(|(index, part)| part.part_number == index as u32 + 1
                        && part.etag == format!("etag-{}", index + 1))
            );
            assert_eq!(
                server
                    .recorded
                    .received
                    .lock()
                    .unwrap()
                    .values()
                    .sum::<usize>() as u64,
                file_size
            );
            assert_eq!(server.recorded.max_active_puts.load(Ordering::Acquire), 1);
            let progress = progress.into_inner().unwrap();
            assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
            assert_eq!(progress.last().copied(), Some(0.99));
            eprintln!(
                "rtt {rtt_ms} ms, {mbps} Mbps, shared {shared}: {elapsed:.1?}, {} connections",
                server.connections.load(Ordering::Acquire)
            );
            times.push(elapsed.as_secs_f64());
        }
        println!(
            "| {rtt_ms} ms | {mbps} Mbps | {:.1} s | {:.1} s | {:.2}x |",
            times[0],
            times[1],
            times[0] / times[1]
        );
    }
}


#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "controlled latency model over loopback sockets"]
async fn presign_latency_probe() {
    let megabytes = std::env::var("PROOF_MB").unwrap_or_else(|_| "60".into()).parse::<usize>().unwrap();
    let rtt_ms = std::env::var("PROOF_RTT_MS").unwrap_or_else(|_| "150".into()).parse::<u64>().unwrap();
    let size = megabytes * 1_000_000;
    let export = TempExport::new(&export_bytes(size));
    let server = mock_network::start(mock_network::Profile {
        rtt: Duration::from_millis(rtt_ms),
        link_bytes_per_sec: 100.0 * 1_000_000.0 / 8.0,
        max_window: 2 << 20,
        handshake_rtts: 2,
        presign_server_time: Duration::from_millis(20),
    });
    let transport = MockPartTransport {
        addr: server.addr,
        shared: Some((local_client(), local_client())),
        drive_urls: false,
    };
    let progress = Mutex::new(Vec::new());
    let start = Instant::now();
    let parts = upload_file_parts(&transport, &export.0, size as u64, chunk_size_for(size as u64), &|value| progress.lock().unwrap().push(value), &AtomicBool::new(false), None).await.unwrap();
    let seconds = start.elapsed().as_secs_f64();
    assert_eq!(server.recorded.max_active_puts.load(Ordering::Acquire), 1);
    assert_eq!(parts.iter().map(|part| part.size).sum::<usize>(), size);
    assert_eq!(server.recorded.received.lock().unwrap().values().sum::<usize>(), size);
    assert_eq!(server.recorded.puts.lock().unwrap().iter().map(|(number,_)| *number).collect::<Vec<_>>(), (1..=parts.len() as u32).collect::<Vec<_>>());
    assert!(parts.iter().enumerate().all(|(index, part)| part.part_number == index as u32+1 && part.etag == format!("etag-{}",index+1)));
    let progress = progress.into_inner().unwrap();
    assert!(progress.windows(2).all(|pair| pair[0] <= pair[1]));
    assert_eq!(progress.last().copied(), Some(0.99));
    println!("PRESIGN_PROOF {}", json!({"megabytes":megabytes,"rtt_ms":rtt_ms,"modeled_mbps":100,"seconds":seconds,"parts":parts.len(),"connections":server.connections.load(Ordering::Acquire),"max_active_puts":1,"received_bytes":size}));
}

}
