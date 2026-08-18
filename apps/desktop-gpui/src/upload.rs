use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use cap_project::{RecordingMeta, S3UploadMeta, SharingMeta, UploadMeta};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::auth::{self, AuthApiError};

const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE: u64 = 15 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadResult {
    Success(String),
    NotAuthenticated,
    UpgradeRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UploadMode {
    Initial,
    Reupload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadedPart {
    part_number: u32,
    etag: String,
    size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoMeta {
    #[serde(rename = "durationInSecs")]
    duration_in_secs: f64,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    fps: Option<f32>,
}

pub async fn upload_exported_video(
    project_path: PathBuf,
    mode: UploadMode,
    organization_id: Option<String>,
    progress: impl Fn(f64),
    cancel: std::sync::Arc<AtomicBool>,
) -> Result<UploadResult, String> {
    if store_auth_missing() {
        let _ = crate::store::set_auth(None);
        return Ok(UploadResult::NotAuthenticated);
    }

    let mut meta = RecordingMeta::load_for_project(&project_path)
        .map_err(|error| format!("Failed to load recording metadata: {error}"))?;
    let file_path = meta.output_path();
    if !file_path.exists() {
        return Err("Failed to upload video: Rendered video not found".into());
    }

    let metadata = build_video_meta(&file_path)?;
    if !crate::store::auth_snapshot().is_upgraded() && metadata.duration_in_secs > 300.0 {
        return Ok(UploadResult::UpgradeRequired);
    }

    progress(0.0);
    if cancel.load(Ordering::Relaxed) {
        return Err("Export cancelled".into());
    }

    let s3_config = match create_or_get_video(
        matches!(mode, UploadMode::Reupload)
            .then(|| {
                meta.sharing
                    .as_ref()
                    .map(|sharing| sharing.id.clone())
                    .ok_or_else(|| "No sharing metadata found".to_string())
            })
            .transpose()?,
        Some(meta.pretty_name.clone()),
        Some(&metadata),
        organization_id,
    )
    .await
    {
        Ok(config) => config,
        Err(AuthApiError::InvalidAuthentication) => return Ok(UploadResult::NotAuthenticated),
        Err(AuthApiError::UpgradeRequired) => return Ok(UploadResult::UpgradeRequired),
        Err(error) => return Err(error.to_string()),
    };

    let screenshot_path = meta.project_path.join("screenshots/display.jpg");
    meta.upload = Some(UploadMeta::SinglePartUpload {
        video_id: s3_config.id.clone(),
        file_path: file_path.clone(),
        screenshot_path: screenshot_path.clone(),
        recording_dir: project_path.clone(),
    });
    if let Err(error) = meta.save_for_project() {
        tracing::error!("Failed to save recording meta: {error}");
    }

    match upload_video(
        &s3_config.id,
        &file_path,
        &screenshot_path,
        &metadata,
        progress,
        &cancel,
    )
    .await
    {
        Ok(link) => {
            meta.upload = Some(UploadMeta::Complete);
            meta.sharing = Some(SharingMeta {
                link: link.clone(),
                id: s3_config.id.clone(),
                content_hash: None,
            });
            if let Err(error) = meta.save_for_project() {
                tracing::error!("Failed to save recording meta: {error}");
            }
            Ok(UploadResult::Success(link))
        }
        Err(AuthApiError::UpgradeRequired) => Ok(UploadResult::UpgradeRequired),
        Err(AuthApiError::InvalidAuthentication) => Ok(UploadResult::NotAuthenticated),
        Err(error) => {
            meta.upload = Some(UploadMeta::Failed {
                error: error.to_string(),
            });
            if let Err(save_error) = meta.save_for_project() {
                tracing::error!("Failed to save recording meta: {save_error}");
            }
            Err(error.to_string())
        }
    }
}

fn store_auth_missing() -> bool {
    !crate::store::auth_snapshot().signed_in()
}

async fn create_or_get_video(
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<&VideoMeta>,
    organization_id: Option<String>,
) -> Result<S3UploadMeta, AuthApiError> {
    let mut path = "/api/desktop/video/create?recordingMode=desktopMP4".to_string();
    if let Some(id) = video_id {
        path.push_str(&format!("&videoId={id}"));
    }
    if let Some(name) = name {
        path.push_str(&format!("&name={}", urlencoding(&name)));
    }
    if let Some(meta) = meta {
        path.push_str(&format!("&durationInSecs={}", meta.duration_in_secs));
        path.push_str(&format!("&width={}", meta.width));
        path.push_str(&format!("&height={}", meta.height));
        if let Some(fps) = meta.fps {
            path.push_str(&format!("&fps={fps}"));
        }
    }
    if let Some(org_id) = organization_id {
        path.push_str(&format!("&orgId={org_id}"));
    }

    let response = auth::authed_request(reqwest::Method::GET, &path, None).await?;
    if response.status() != StatusCode::OK {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::FORBIDDEN && body.contains("upgrade_required") {
            return Err(AuthApiError::UpgradeRequired);
        }
        return Err(AuthApiError::Other(format!(
            "create_or_get_video/error/{status}: {body:?}"
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|error| AuthApiError::Other(format!("Failed to read response body: {error}")))?;
    serde_json::from_str::<S3UploadMeta>(&text).map_err(|error| {
        AuthApiError::Other(format!(
            "Failed to deserialize response: {error}. Response body: {text}"
        ))
    })
}

async fn upload_video(
    video_id: &str,
    file_path: &Path,
    screenshot_path: &Path,
    metadata: &VideoMeta,
    progress: impl Fn(f64),
    cancel: &AtomicBool,
) -> Result<String, AuthApiError> {
    let initiate = multipart_initiate(video_id).await?;
    let is_drive = is_google_drive_upload(initiate.provider.as_deref(), &initiate.upload_id);
    let parts = upload_parts(
        video_id,
        &initiate.upload_id,
        file_path,
        is_drive,
        &progress,
        cancel,
    )
    .await?;
    if cancel.load(Ordering::Relaxed) {
        return Err(AuthApiError::Other("Export cancelled".into()));
    }
    multipart_complete(video_id, &initiate.upload_id, &parts, Some(metadata)).await?;
    progress(1.0);

    if screenshot_path.exists()
        && let Err(error) = upload_screenshot(video_id, screenshot_path).await
    {
        return Err(AuthApiError::Other(format!(
            "thumbnail upload failed: {error}"
        )));
    }

    Ok(format!("{}/s/{video_id}", auth::server_url()))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitiateResponse {
    upload_id: String,
    provider: Option<String>,
}

async fn multipart_initiate(video_id: &str) -> Result<InitiateResponse, AuthApiError> {
    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/initiate",
        Some(json!({
            "videoId": video_id,
            "contentType": "video/mp4"
        })),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_initiate/request: {error}"))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_initiate/{status}: {body}"
        )));
    }
    response.json().await.map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_initiate/response: {error}"))
    })
}

async fn multipart_presign(
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    md5_sum: Option<&str>,
) -> Result<String, AuthApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        presigned_url: String,
    }

    let mut body = serde_json::Map::from_iter([
        ("videoId".into(), json!(video_id)),
        ("uploadId".into(), json!(upload_id)),
        ("partNumber".into(), json!(part_number)),
    ]);
    if let Some(md5_sum) = md5_sum {
        body.insert("md5Sum".into(), json!(md5_sum));
    }

    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/presign-part",
        Some(Value::Object(body)),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!(
            "api/upload_multipart_presign_part/request: {error}"
        ))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_presign_part/{status}: {body}"
        )));
    }
    response
        .json::<Response>()
        .await
        .map(|data| data.presigned_url)
        .map_err(|error| {
            AuthApiError::Other(format!(
                "api/upload_multipart_presign_part/response: {error}"
            ))
        })
}

async fn multipart_complete(
    video_id: &str,
    upload_id: &str,
    parts: &[UploadedPart],
    meta: Option<&VideoMeta>,
) -> Result<(), AuthApiError> {
    let mut body = json!({
        "videoId": video_id,
        "uploadId": upload_id,
        "parts": parts,
    });
    if let Some(meta) = meta
        && let Value::Object(object) = &mut body
        && let Ok(Value::Object(extra)) = serde_json::to_value(meta)
    {
        object.extend(extra);
    }

    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/multipart/complete",
        Some(body),
    )
    .await
    .map_err(|error| {
        AuthApiError::Other(format!("api/upload_multipart_complete/request: {error}"))
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".into());
        return Err(AuthApiError::Other(format!(
            "api/upload_multipart_complete/{status}: {body}"
        )));
    }
    Ok(())
}

async fn upload_parts(
    video_id: &str,
    upload_id: &str,
    file_path: &Path,
    is_drive: bool,
    progress: &impl Fn(f64),
    cancel: &AtomicBool,
) -> Result<Vec<UploadedPart>, AuthApiError> {
    let file_size = std::fs::metadata(file_path)
        .map_err(|error| AuthApiError::Other(format!("Failed to read export size: {error}")))?
        .len();
    if file_size == 0 {
        return Err(AuthApiError::Other("Rendered video is empty".into()));
    }
    let chunk_size = chunk_size_for(file_size);
    let mut parts = Vec::new();
    let mut failed = Vec::new();
    let mut offset = 0u64;
    let mut part_number = 1u32;
    let use_md5 = auth::is_server_url_custom();

    while offset < file_size {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        let size = (file_size - offset).min(chunk_size) as usize;
        let chunk = read_chunk(file_path, offset, size)?;
        match put_part(
            video_id,
            upload_id,
            part_number,
            offset,
            file_size,
            &chunk,
            is_drive,
            use_md5,
        )
        .await
        {
            Ok(part) => parts.push(part),
            Err(error) => {
                tracing::warn!(part_number, error = %error, "chunk upload failed; will retry");
                failed.push((part_number, offset, chunk, error));
            }
        }
        offset += size as u64;
        part_number += 1;
        progress((offset as f64 / file_size as f64).min(0.99));
    }

    for (part_number, offset, chunk, first_error) in failed {
        if cancel.load(Ordering::Relaxed) {
            return Err(AuthApiError::Other("Export cancelled".into()));
        }
        match put_part(
            video_id,
            upload_id,
            part_number,
            offset,
            file_size,
            &chunk,
            is_drive,
            use_md5,
        )
        .await
        {
            Ok(part) => parts.push(part),
            Err(_) => {
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

#[allow(clippy::too_many_arguments)]
async fn put_part(
    video_id: &str,
    upload_id: &str,
    part_number: u32,
    offset: u64,
    total_size: u64,
    chunk: &[u8],
    is_drive: bool,
    use_md5: bool,
) -> Result<UploadedPart, AuthApiError> {
    let md5_sum = use_md5.then(|| md5_base64(chunk));
    let url = multipart_presign(video_id, upload_id, part_number, md5_sum.as_deref()).await?;
    let client = reqwest::Client::new();
    let mut attempt = 0u32;
    loop {
        let mut request = client
            .put(&url)
            .header("Content-Length", chunk.len())
            .timeout(Duration::from_secs(5 * 60))
            .body(chunk.to_vec());
        if is_drive || is_google_drive_resumable_url(&url) {
            let end = offset.saturating_add(chunk.len() as u64).saturating_sub(1);
            request = request.header(
                "Content-Range",
                format!("bytes {offset}-{end}/{total_size}"),
            );
        }
        if let Some(md5_sum) = &md5_sum {
            request = request.header("Content-MD5", md5_sum);
        }
        match request.send().await {
            Ok(response) => {
                if !upload_status_ok(
                    &url,
                    response.status(),
                    offset,
                    chunk.len() as u64,
                    total_size,
                ) {
                    let status = response.status();
                    let body = response.text().await.unwrap_or_default();
                    return Err(AuthApiError::Other(format!(
                        "uploader/part/{part_number}/status/{status}: {body}"
                    )));
                }
                let etag = response
                    .headers()
                    .get("ETag")
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .trim_matches('"')
                    .to_string();
                return Ok(UploadedPart {
                    part_number,
                    etag,
                    size: chunk.len(),
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
                tokio::time::sleep(delay).await;
            }
            Err(error) => {
                return Err(AuthApiError::Other(format!(
                    "uploader/part/{part_number}/error: {error}"
                )));
            }
        }
    }
}

async fn upload_screenshot(video_id: &str, path: &Path) -> Result<(), AuthApiError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Response {
        presigned_put_data: SignedUpload,
    }
    #[derive(Deserialize)]
    struct SignedUpload {
        url: String,
        #[serde(default)]
        headers: HashMap<String, String>,
    }

    let bytes = compress_image(path)?;
    let response = auth::authed_request(
        reqwest::Method::POST,
        "/api/upload/signed",
        Some(json!({
            "videoId": video_id,
            "subpath": "screenshot/screen-capture.jpg",
            "method": "put",
        })),
    )
    .await?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        return Err(AuthApiError::Other(format!(
            "api/upload_signed/{status}: {body}"
        )));
    }
    let target = response
        .json::<Response>()
        .await
        .map_err(|error| AuthApiError::Other(format!("api/upload_signed/response: {error}")))?
        .presigned_put_data;
    let mut request = reqwest::Client::new()
        .put(target.url)
        .header("Content-Length", bytes.len())
        .body(bytes);
    for (name, value) in target.headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| AuthApiError::Other(error.to_string()))?;
    if !response.status().is_success() {
        return Err(AuthApiError::Other(format!(
            "thumbnail upload failed: {}",
            response.status()
        )));
    }
    Ok(())
}

fn compress_image(path: &Path) -> Result<Vec<u8>, AuthApiError> {
    let img = image::ImageReader::open(path)
        .map_err(|error| AuthApiError::Other(format!("Failed to open image: {error}")))?
        .decode()
        .map_err(|error| AuthApiError::Other(format!("Failed to decode image: {error}")))?;
    let resized = img.resize(
        img.width() / 2,
        img.height() / 2,
        image::imageops::FilterType::Nearest,
    );
    let mut buffer = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 30);
    encoder
        .encode(
            resized.as_bytes(),
            resized.width(),
            resized.height(),
            resized.color().into(),
        )
        .map_err(|error| AuthApiError::Other(format!("Failed to compress image: {error}")))?;
    Ok(buffer)
}

fn build_video_meta(path: &Path) -> Result<VideoMeta, String> {
    let input = ffmpeg::format::input(path)
        .map_err(|error| format!("Failed to read input file: {error}"))?;
    let video_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "Failed to find appropriate video stream in file".to_string())?;
    let video_codec =
        ffmpeg::codec::context::Context::from_parameters(video_stream.parameters())
            .map_err(|error| format!("Unable to read video codec information: {error}"))?;
    let video = video_codec
        .decoder()
        .video()
        .map_err(|error| format!("Unable to get video decoder: {error}"))?;
    Ok(VideoMeta {
        duration_in_secs: input.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE),
        width: video.width(),
        height: video.height(),
        fps: video
            .frame_rate()
            .map(|rate| rate.numerator() as f32 / rate.denominator() as f32),
    })
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
    (file_size / 100).clamp(MIN_CHUNK_SIZE, MAX_CHUNK_SIZE)
}

fn md5_base64(bytes: &[u8]) -> String {
    use md5::{Digest, Md5};
    let digest = Md5::digest(bytes);
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

fn is_google_drive_upload(provider: Option<&str>, upload_id: &str) -> bool {
    provider == Some("googleDrive") || is_google_drive_resumable_url(upload_id)
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

fn urlencoding(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_size_clamps() {
        assert_eq!(chunk_size_for(1), MIN_CHUNK_SIZE);
        assert_eq!(chunk_size_for(MIN_CHUNK_SIZE * 200), MAX_CHUNK_SIZE);
        assert_eq!(chunk_size_for(MIN_CHUNK_SIZE * 50), MIN_CHUNK_SIZE);
    }

    #[test]
    fn drive_url_detection() {
        assert!(is_google_drive_resumable_url(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
        ));
        assert!(!is_google_drive_resumable_url(
            "https://s3.amazonaws.com/bucket/key"
        ));
        assert!(is_google_drive_upload(Some("googleDrive"), "abc"));
    }
}
