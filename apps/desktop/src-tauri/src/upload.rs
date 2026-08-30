// credit @filleduchaos

use crate::{
    UploadProgress, VideoUploadInfo,
    api::{self, PresignedS3PutRequest, PresignedS3PutRequestMethod, S3VideoMeta, UploadedPart},
    http_client::{HttpClient, RetryableHttpClient},
    telemetry::{AnalyticsEvent, async_capture_event},
    web_api::{AuthedApiError, ManagerExt},
};
use async_stream::{stream, try_stream};
use bytes::Bytes;
use cap_project::{RecordingMeta, S3UploadMeta, UploadMeta};
use cap_utils::spawn_actor;
use ffmpeg::ffi::AV_TIME_BASE;
use flume::Receiver;
use futures::future::join;
use futures::{Stream, StreamExt, TryStreamExt, stream};
use image::{ImageReader, codecs::jpeg::JpegEncoder};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    pin::pin,
    sync::{
        Arc, Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, ipc::Channel};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, BufReader},
    task::{self, JoinHandle},
    time::{self, Instant, timeout},
};
use tokio_util::io::ReaderStream;
use tracing::{Span, debug, error, info, info_span, instrument, trace, warn};

pub(crate) mod resume;
use tracing_futures::Instrument;

pub struct UploadedItem {
    pub link: String,
    pub id: String,
    // #[allow(unused)]
    // pub config: S3UploadMeta,
}

#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct UploadProgressEvent {
    video_id: String,
    uploaded: String,
    total: String,
}

const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE: u64 = 15 * 1024 * 1024;
const NETWORK_RECOVERY_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CONNECTIVITY_PROBE_INITIAL_DELAY: Duration = Duration::from_secs(2);
const CONNECTIVITY_PROBE_MAX_DELAY: Duration = Duration::from_secs(30);

static ACTIVE_UPLOADS: AtomicUsize = AtomicUsize::new(0);

struct ActiveUploadGuard<'a>(&'a AtomicUsize);

impl<'a> ActiveUploadGuard<'a> {
    fn new(active: &'a AtomicUsize) -> Self {
        active.fetch_add(1, Ordering::AcqRel);
        Self(active)
    }
}

impl Drop for ActiveUploadGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) fn upload_session_active() -> bool {
    ACTIVE_UPLOADS.load(Ordering::Acquire) > 0
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

fn with_drive_content_range(
    request: reqwest::RequestBuilder,
    url: &str,
    offset: u64,
    size: u64,
    total_size: u64,
) -> reqwest::RequestBuilder {
    if !is_google_drive_resumable_url(url) || size == 0 {
        return request;
    }

    let end = offset.saturating_add(size).saturating_sub(1);
    request.header(
        "Content-Range",
        format!("bytes {offset}-{end}/{total_size}"),
    )
}

fn is_upload_response_accepted(
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

fn content_type_for_upload_subpath(subpath: &str) -> &'static str {
    if subpath.ends_with(".json") {
        "application/json"
    } else if subpath.ends_with(".mp4") || subpath.ends_with(".m4s") {
        "video/mp4"
    } else if subpath.ends_with(".jpg") || subpath.ends_with(".jpeg") {
        "image/jpeg"
    } else if subpath.ends_with(".png") {
        "image/png"
    } else if subpath.ends_with(".aac") {
        "audio/aac"
    } else if subpath.ends_with(".webm") {
        "audio/webm"
    } else if subpath.ends_with(".m3u8") {
        "application/x-mpegURL"
    } else {
        "application/octet-stream"
    }
}

#[instrument(skip(app, channel, file_path, screenshot_path))]
pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    screenshot_path: PathBuf,
    meta: S3VideoMeta,
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadedItem, AuthedApiError> {
    let _active_upload = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
    info!("Uploading video {video_id}...");

    let start = Instant::now();
    let upload = api::upload_multipart_initiate(app, &video_id).await?;
    let is_drive_upload = is_google_drive_upload(upload.provider.as_deref(), &upload.upload_id);
    let upload_id = upload.upload_id;

    let video_fut = async {
        let failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>> = Arc::new(Mutex::new(Vec::new()));

        let stream = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
                is_drive_upload,
                from_pending_file_to_chunks(file_path.clone(), None),
                failed_chunks.clone(),
            ),
        );

        let stream = if let Some(channel) = channel {
            tauri_channel_progress(channel, stream).boxed()
        } else {
            stream.boxed()
        };

        let mut parts = stream.try_collect::<Vec<_>>().await?;

        let failed =
            std::mem::take(&mut *failed_chunks.lock().unwrap_or_else(PoisonError::into_inner));
        if !failed.is_empty() {
            info!(
                count = failed.len(),
                "Retrying {} failed chunk(s) after main upload pass",
                failed.len()
            );
            let retry_parts =
                retry_failed_chunks(app, &video_id, &upload_id, &file_path, failed).await?;
            parts.extend(retry_parts);
        }

        let mut deduplicated_parts = HashMap::new();
        for part in parts {
            deduplicated_parts.insert(part.part_number, part);
        }
        parts = deduplicated_parts.into_values().collect::<Vec<_>>();
        parts.sort_by_key(|part| part.part_number);

        let metadata = build_video_meta(&file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        api::upload_multipart_complete(app, &video_id, &upload_id, &parts, metadata.clone())
            .await?;

        Ok(metadata)
    };

    // TODO: We don't report progress on image upload
    let bytes = compress_image(screenshot_path).await?;
    let thumbnail_fut = singlepart_uploader(
        app.clone(),
        PresignedS3PutRequest {
            video_id: video_id.clone(),
            subpath: "screenshot/screen-capture.jpg".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
        bytes.len() as u64,
        stream::once(async move { Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)) }),
    );

    let (video_result, thumbnail_result): (Result<_, AuthedApiError>, Result<_, AuthedApiError>) =
        tokio::join!(video_fut, thumbnail_fut);

    emit_upload_complete(app, &video_id);

    async_capture_event(
        app,
        match &video_result {
            Ok(meta) => AnalyticsEvent::MultipartUploadComplete {
                duration: start.elapsed(),
                length: meta
                    .as_ref()
                    .map(|v| Duration::from_secs(v.duration_in_secs as u64))
                    .unwrap_or_default(),
                size: std::fs::metadata(file_path)
                    .map(|m| ((m.len() as f64) / 1_000_000.0) as u64)
                    .unwrap_or_default(),
            },
            Err(err) => AnalyticsEvent::MultipartUploadFailed {
                duration: start.elapsed(),
                error: err.to_string(),
            },
        },
    );

    let _ = (video_result?, thumbnail_result?);

    Ok(UploadedItem {
        link: app.make_app_url(format!("/s/{video_id}")).await,
        id: video_id,
    })
}

/// Open a file and construct a stream to it.
async fn file_reader_stream(path: impl AsRef<Path>) -> Result<(ReaderStream<File>, u64), String> {
    let file = File::open(path)
        .await
        .map_err(|e| format!("Failed to open file: {e}"))?;

    let metadata = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to get file metadata: {e}"))?;

    Ok((ReaderStream::new(file), metadata.len()))
}

fn screenshot_upload_subpath(content_type: &str) -> &'static str {
    if content_type.eq_ignore_ascii_case("image/png") {
        "screenshot/screen-capture.png"
    } else {
        "screenshot/screen-capture.jpg"
    }
}

fn screenshot_content_type_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        _ => "image/jpeg",
    }
}

pub async fn upload_screenshot_bytes(
    app: &AppHandle,
    image_bytes: Vec<u8>,
    content_type: &str,
    video_id: Option<String>,
    organization_id: Option<String>,
) -> Result<UploadedItem, AuthedApiError> {
    let _active_upload = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
    let s3_config = create_or_get_video(app, true, video_id, None, None, organization_id).await?;
    let subpath = screenshot_upload_subpath(content_type);
    let total_size = image_bytes.len() as u64;

    singlepart_uploader(
        app.clone(),
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: subpath.to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
        total_size,
        stream::once(async move { Ok::<_, std::io::Error>(Bytes::from(image_bytes)) }),
    )
    .await?;

    Ok(UploadedItem {
        link: app.make_app_url(format!("/s/{}", &s3_config.id)).await,
        id: s3_config.id,
    })
}

pub async fn upload_screenshot_file(
    app: &AppHandle,
    file_path: PathBuf,
    video_id: Option<String>,
    organization_id: Option<String>,
) -> Result<UploadedItem, AuthedApiError> {
    let _active_upload = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
    let content_type = screenshot_content_type_from_path(&file_path);
    let s3_config = create_or_get_video(app, true, video_id, None, None, organization_id).await?;
    let subpath = screenshot_upload_subpath(content_type);
    let (stream, total_size) = file_reader_stream(file_path).await?;

    singlepart_uploader(
        app.clone(),
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: subpath.to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
        total_size,
        stream,
    )
    .await?;

    Ok(UploadedItem {
        link: app.make_app_url(format!("/s/{}", &s3_config.id)).await,
        id: s3_config.id,
    })
}

#[instrument(skip(app))]
pub async fn create_or_get_video(
    app: &AppHandle,
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<S3VideoMeta>,
    organization_id: Option<String>,
) -> Result<S3UploadMeta, AuthedApiError> {
    create_or_get_video_with_mode(
        app,
        is_screenshot,
        video_id,
        name,
        meta,
        organization_id,
        "desktopMP4",
    )
    .await
}

#[instrument(skip(app))]
pub async fn create_or_get_video_with_mode(
    app: &AppHandle,
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<S3VideoMeta>,
    organization_id: Option<String>,
    recording_mode: &str,
) -> Result<S3UploadMeta, AuthedApiError> {
    let mut s3_config_url = if let Some(id) = video_id {
        let mut url =
            format!("/api/desktop/video/create?recordingMode={recording_mode}&videoId={id}");
        if is_screenshot {
            url.push_str("&isScreenshot=true");
        }
        url
    } else if is_screenshot {
        format!("/api/desktop/video/create?recordingMode={recording_mode}&isScreenshot=true")
    } else {
        format!("/api/desktop/video/create?recordingMode={recording_mode}")
    };

    if let Some(name) = name {
        s3_config_url.push_str(&format!("&name={name}"));
    }

    if let Some(meta) = meta {
        s3_config_url.push_str(&format!("&durationInSecs={}", meta.duration_in_secs));
        s3_config_url.push_str(&format!("&width={}", meta.width));
        s3_config_url.push_str(&format!("&height={}", meta.height));
        if let Some(fps) = meta.fps {
            s3_config_url.push_str(&format!("&fps={fps}"));
        }
    }

    if let Some(org_id) = organization_id {
        s3_config_url.push_str(&format!("&orgId={org_id}"));
    }

    let response = app
        .authed_api_request(s3_config_url, |client, url| client.get(url))
        .await?;

    if response.status() != StatusCode::OK {
        #[derive(Deserialize, Clone, Debug)]
        pub struct CreateErrorResponse {
            error: String,
        }

        let status = response.status();
        let body = response.text().await;

        if let Some(error) = body
            .as_ref()
            .ok()
            .and_then(|body| serde_json::from_str::<CreateErrorResponse>(body).ok())
            && status == StatusCode::FORBIDDEN
            && error.error == "upgrade_required"
        {
            return Err(AuthedApiError::UpgradeRequired);
        }

        return Err(format!("create_or_get_video/error/{status}: {body:?}").into());
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let config = serde_json::from_str::<S3UploadMeta>(&response_text).map_err(|e| {
        format!("Failed to deserialize response: {e}. Response body: {response_text}")
    })?;

    Ok(config)
}

#[instrument]
pub fn build_video_meta(path: &PathBuf) -> Result<S3VideoMeta, String> {
    let input =
        ffmpeg::format::input(path).map_err(|e| format!("Failed to read input file: {e}"))?;
    let video_stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "Failed to find appropriate video stream in file".to_string())?;

    let video_codec = ffmpeg::codec::context::Context::from_parameters(video_stream.parameters())
        .map_err(|e| format!("Unable to read video codec information: {e}"))?;
    let video = video_codec
        .decoder()
        .video()
        .map_err(|e| format!("Unable to get video decoder: {e}"))?;

    Ok(S3VideoMeta {
        duration_in_secs: input.duration() as f64 / AV_TIME_BASE as f64,
        width: video.width(),
        height: video.height(),
        fps: video
            .frame_rate()
            .map(|v| v.numerator() as f32 / v.denominator() as f32),
    })
}

pub fn try_repair_corrupt_mp4(path: &Path) -> Result<(), String> {
    let repaired_path = path.with_extension("repaired.mp4");

    info!(
        original = %path.display(),
        repaired = %repaired_path.display(),
        "Attempting to repair corrupt MP4 via FFmpeg remux"
    );

    cap_enc_ffmpeg::remux::remux_file(path, &repaired_path)
        .map_err(|e| format!("FFmpeg remux repair failed for {}: {e}", path.display()))?;

    let repaired_size = std::fs::metadata(&repaired_path)
        .map(|m| m.len())
        .unwrap_or(0);

    if repaired_size == 0 {
        let _ = std::fs::remove_file(&repaired_path);
        return Err("Repaired file is empty — no recoverable data".to_string());
    }

    std::fs::rename(&repaired_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&repaired_path);
        format!("Failed to replace original file with repaired version: {e}")
    })?;

    info!(
        repaired_size_mb = repaired_size as f64 / 1_000_000.0,
        "Successfully replaced corrupt file with repaired version"
    );

    Ok(())
}

#[instrument]
pub async fn compress_image(path: PathBuf) -> Result<Vec<u8>, String> {
    task::spawn_blocking(move || {
        let img = ImageReader::open(&path)
            .map_err(|e| format!("Failed to open image: {e}"))?
            .decode()
            .map_err(|e| format!("Failed to decode image: {e}"))?;

        let resized_img = img.resize(
            img.width() / 2,
            img.height() / 2,
            image::imageops::FilterType::Nearest,
        );

        let mut buffer = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 30);
        encoder
            .encode(
                resized_img.as_bytes(),
                resized_img.width(),
                resized_img.height(),
                resized_img.color().into(),
            )
            .map_err(|e| format!("Failed to compress image: {e}"))?;

        Ok(buffer)
    })
    .await
    .map_err(|e| format!("Failed to compress image: {e}"))?
}

pub struct InstantMultipartUpload {
    #[cfg(not(target_os = "linux"))]
    pub handle: tokio::task::JoinHandle<Result<(), AuthedApiError>>,
}

impl InstantMultipartUpload {
    /// starts a progressive (multipart) upload that runs until recording stops
    /// and the file has stabilized (no additional data is being written).
    pub fn spawn(
        app: AppHandle,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
        realtime_upload_done: Option<Receiver<()>>,
    ) -> Self {
        let handle = spawn_actor(async move {
            let start = Instant::now();
            let result = Self::run(
                app.clone(),
                file_path.clone(),
                pre_created_video,
                recording_dir,
                realtime_upload_done,
            )
            .await;
            async_capture_event(
                &app,
                match &result {
                    Ok(meta) => AnalyticsEvent::MultipartUploadComplete {
                        duration: start.elapsed(),
                        length: meta
                            .as_ref()
                            .map(|v| Duration::from_secs(v.duration_in_secs as u64))
                            .unwrap_or_default(),
                        size: std::fs::metadata(file_path)
                            .map(|m| ((m.len() as f64) / 1_000_000.0) as u64)
                            .unwrap_or_default(),
                    },
                    Err(err) => AnalyticsEvent::MultipartUploadFailed {
                        duration: start.elapsed(),
                        error: err.to_string(),
                    },
                },
            );

            result.map(|_| ())
        });
        #[cfg(target_os = "linux")]
        drop(handle);
        Self {
            #[cfg(not(target_os = "linux"))]
            handle,
        }
    }

    pub async fn run(
        app: AppHandle,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
        realtime_video_done: Option<Receiver<()>>,
    ) -> Result<Option<S3VideoMeta>, AuthedApiError> {
        let _active_upload = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
        let video_id = pre_created_video.id.clone();
        debug!("Initiating multipart upload for {video_id}...");

        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            format!("Error reading project meta from {recording_dir:?} for upload init: {err}")
        })?;
        project_meta.upload = Some(UploadMeta::MultipartUpload {
            video_id: video_id.clone(),
            file_path: file_path.clone(),
            pre_created_video: pre_created_video.clone(),
            recording_dir: recording_dir.clone(),
        });
        project_meta
            .save_for_project()
            .map_err(|e| error!("Failed to save recording meta: {e}"))
            .ok();

        let upload = api::upload_multipart_initiate(&app, &video_id).await?;
        let is_drive_upload = is_google_drive_upload(upload.provider.as_deref(), &upload.upload_id);
        let upload_id = upload.upload_id;

        let failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>> = Arc::new(Mutex::new(Vec::new()));

        let mut parts = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
                is_drive_upload,
                from_pending_file_to_chunks(file_path.clone(), realtime_video_done),
                failed_chunks.clone(),
            ),
        )
        .try_collect::<Vec<_>>()
        .await?;

        let failed =
            std::mem::take(&mut *failed_chunks.lock().unwrap_or_else(PoisonError::into_inner));
        if !failed.is_empty() {
            info!(
                count = failed.len(),
                "Retrying {} failed chunk(s) after main upload pass",
                failed.len()
            );
            let retry_parts =
                retry_failed_chunks(&app, &video_id, &upload_id, &file_path, failed).await?;
            parts.extend(retry_parts);
        }

        let mut deduplicated_parts = HashMap::new();
        for part in parts {
            deduplicated_parts.insert(part.part_number, part);
        }
        parts = deduplicated_parts.into_values().collect::<Vec<_>>();
        parts.sort_by_key(|part| part.part_number);

        let metadata = match build_video_meta(&file_path) {
            Ok(meta) => Some(meta),
            Err(e) => {
                error!("Failed to get video metadata: {e}");
                warn!("Output file may be corrupt, attempting FFmpeg remux repair for {video_id}");

                match try_repair_corrupt_mp4(&file_path) {
                    Ok(()) => {
                        info!("Successfully repaired corrupt recording for {video_id}");
                        match build_video_meta(&file_path) {
                            Ok(meta) => Some(meta),
                            Err(repair_meta_err) => {
                                error!(
                                    "File still unreadable after repair attempt: {repair_meta_err}"
                                );
                                return Err(format!(
                                    "Recording file could not be salvaged after encoder failure. \
                                     Original error: {e}, Post-repair error: {repair_meta_err}"
                                )
                                .into());
                            }
                        }
                    }
                    Err(repair_err) => {
                        error!("FFmpeg repair also failed: {repair_err}");
                        return Err(format!(
                            "Recording file could not be salvaged after encoder failure. \
                             Original error: {e}, Repair error: {repair_err}"
                        )
                        .into());
                    }
                }
            }
        };

        api::upload_multipart_complete(&app, &video_id, &upload_id, &parts, metadata.clone())
            .await?;
        info!("Multipart upload complete for {video_id}.");

        emit_upload_complete(&app, &video_id);

        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            format!("Error reading project meta from {recording_dir:?} for upload complete: {err}")
        })?;
        project_meta.upload = Some(UploadMeta::Complete);
        project_meta
            .save_for_project()
            .map_err(|err| format!("Error reading project meta from {recording_dir:?}: {err}"))?;

        let _ = app.clipboard().write_text(pre_created_video.link.clone());

        Ok(metadata)
    }
}

pub struct SegmentUploader {
    pub handle: tokio::task::JoinHandle<Result<(), AuthedApiError>>,
}

type SegmentUploadTasks =
    futures::stream::FuturesUnordered<tokio::task::JoinHandle<Result<(), AuthedApiError>>>;

struct SegmentUploadState {
    uploaded_video_segments: std::collections::HashMap<u32, f64>,
    uploaded_audio_segments: std::collections::HashMap<u32, f64>,
    video_init_uploaded: bool,
    audio_init_uploaded: bool,
    failed_segments: Vec<FailedSegmentInfo>,
    worker_error: Option<String>,
    total_bytes_uploaded: u64,
}

#[derive(Clone)]
struct FailedSegmentInfo {
    subpath: String,
    file_path: PathBuf,
    is_init: bool,
    media_type: cap_enc_ffmpeg::segmented_stream::SegmentMediaType,
    index: u32,
    duration: f64,
    expected_size: u64,
}

impl SegmentUploadState {
    fn new() -> Self {
        Self {
            uploaded_video_segments: std::collections::HashMap::new(),
            uploaded_audio_segments: std::collections::HashMap::new(),
            video_init_uploaded: false,
            audio_init_uploaded: false,
            failed_segments: Vec::new(),
            worker_error: None,
            total_bytes_uploaded: 0,
        }
    }

    fn to_manifest(&self) -> SegmentUploadManifest {
        let mut video_segments: Vec<SegmentManifestEntry> = self
            .uploaded_video_segments
            .iter()
            .map(|(&index, &duration)| SegmentManifestEntry { index, duration })
            .collect();
        video_segments.sort_by_key(|s| s.index);
        let mut audio_segments: Vec<SegmentManifestEntry> = self
            .uploaded_audio_segments
            .iter()
            .map(|(&index, &duration)| SegmentManifestEntry { index, duration })
            .collect();
        audio_segments.sort_by_key(|s| s.index);

        SegmentUploadManifest {
            version: 2,
            video_init_uploaded: self.video_init_uploaded,
            audio_init_uploaded: self.audio_init_uploaded,
            video_segments,
            audio_segments,
            is_complete: false,
        }
    }

    fn to_complete_manifest(&self) -> SegmentUploadManifest {
        let mut manifest = self.to_manifest();
        manifest.is_complete = true;
        manifest
    }

    fn record_worker_failure(&mut self, error: String) {
        warn!(%error, "Segment upload worker failed");
        if self.worker_error.is_none() {
            self.worker_error = Some(error);
        }
    }

    fn record_task_result(
        &mut self,
        result: Result<Result<(), AuthedApiError>, tokio::task::JoinError>,
    ) {
        let error = match result {
            Ok(Ok(())) => return,
            Ok(Err(error)) => error.to_string(),
            Err(error) => format!("Segment upload task did not complete: {error}"),
        };
        self.record_worker_failure(error);
    }

    fn completed_manifest(&self) -> Result<SegmentUploadManifest, AuthedApiError> {
        if let Some(error) = &self.worker_error {
            return Err(error.clone().into());
        }
        if !self.failed_segments.is_empty() {
            return Err(format!(
                "Segment upload is incomplete: {} required segment uploads failed",
                self.failed_segments.len()
            )
            .into());
        }
        let manifest = self.to_complete_manifest();
        if !manifest.has_video_content() {
            return Err("Segment upload completed without video segments".into());
        }
        Ok(manifest)
    }
}

async fn publish_completed_segments<T, F, Fut>(
    state: &Mutex<SegmentUploadState>,
    publish: F,
) -> Result<T, AuthedApiError>
where
    F: FnOnce(SegmentUploadManifest) -> Fut,
    Fut: std::future::Future<Output = Result<T, AuthedApiError>>,
{
    let manifest = state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .completed_manifest()?;
    publish(manifest).await
}

async fn drain_segment_upload_tasks(
    state: &Mutex<SegmentUploadState>,
    tasks: &mut SegmentUploadTasks,
) {
    while let Some(result) = tasks.next().await {
        state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .record_task_result(result);
    }
}

async fn cancel_segment_prefetch_tasks(
    tasks: &mut futures::stream::FuturesUnordered<tokio::task::JoinHandle<()>>,
) {
    for task in tasks.iter() {
        task.abort();
    }
    while let Some(result) = tasks.next().await {
        if let Err(error) = result
            && !error.is_cancelled()
        {
            warn!(%error, "Optional segment URL prefetch failed");
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct SegmentManifestEntry {
    index: u32,
    duration: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct SegmentUploadManifest {
    version: u32,
    video_init_uploaded: bool,
    audio_init_uploaded: bool,
    video_segments: Vec<SegmentManifestEntry>,
    audio_segments: Vec<SegmentManifestEntry>,
    is_complete: bool,
}

impl SegmentUploadManifest {
    fn has_video_content(&self) -> bool {
        self.video_init_uploaded && !self.video_segments.is_empty()
    }
}

struct PresignedUrlCache {
    urls: tokio::sync::Mutex<HashMap<String, String>>,
}

impl PresignedUrlCache {
    fn new() -> Self {
        Self {
            urls: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    async fn prefetch(&self, app: &AppHandle, video_id: &str, segment_count: u32) {
        let mut subpaths = Vec::with_capacity((segment_count as usize) * 2 + 3);
        subpaths.push("segments/video/init.mp4".to_string());
        subpaths.push("segments/audio/init.mp4".to_string());
        subpaths.push("segments/manifest.json".to_string());
        for i in 1..=segment_count {
            subpaths.push(format!("segments/video/segment_{i:03}.m4s"));
            subpaths.push(format!("segments/audio/segment_{i:03}.m4s"));
        }

        match api::upload_signed_batch(app, video_id, &subpaths).await {
            Ok(urls) => {
                let mut cache = self.urls.lock().await;
                let count = urls.len();
                for (subpath, url) in urls {
                    cache.insert(subpath, url);
                }
                info!(count, "Pre-fetched presigned URLs for segments");
            }
            Err(e) => {
                warn!("Failed to batch-prefetch presigned URLs: {e}");
            }
        }
    }

    async fn get_or_fetch(
        &self,
        app: &AppHandle,
        video_id: &str,
        subpath: &str,
    ) -> Result<String, AuthedApiError> {
        {
            let mut cache = self.urls.lock().await;
            if let Some(url) = cache.remove(subpath) {
                return Ok(url);
            }
        }

        api::upload_signed(
            app,
            api::PresignedS3PutRequest {
                video_id: video_id.to_string(),
                subpath: subpath.to_string(),
                method: api::PresignedS3PutRequestMethod::Put,
                meta: None,
            },
        )
        .await
        .map(|target| target.url)
    }

    async fn extend_prefetch(&self, app: &AppHandle, video_id: &str, from: u32, count: u32) {
        let mut subpaths = Vec::with_capacity((count as usize) * 2);
        for i in from..from + count {
            subpaths.push(format!("segments/video/segment_{i:03}.m4s"));
            subpaths.push(format!("segments/audio/segment_{i:03}.m4s"));
        }

        match api::upload_signed_batch(app, video_id, &subpaths).await {
            Ok(urls) => {
                let mut cache = self.urls.lock().await;
                let count = urls.len();
                for (subpath, url) in urls {
                    cache.insert(subpath, url);
                }
                info!(count, from, "Extended presigned URL cache");
            }
            Err(e) => {
                warn!("Failed to extend presigned URL cache: {e}");
            }
        }
    }
}

impl SegmentUploader {
    pub fn spawn(
        app: AppHandle,
        video_id: String,
        segment_rx: std::sync::mpsc::Receiver<
            cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent,
        >,
        recording_done: Option<flume::Receiver<()>>,
        recording_dir: PathBuf,
        pre_created_video: VideoUploadInfo,
    ) -> Self {
        Self {
            handle: spawn_actor(async move {
                let start = Instant::now();
                let result = Self::run(
                    app.clone(),
                    video_id.clone(),
                    segment_rx,
                    recording_done,
                    recording_dir.clone(),
                    pre_created_video,
                )
                .await;

                async_capture_event(
                    &app,
                    match &result {
                        Ok(total_bytes) => AnalyticsEvent::MultipartUploadComplete {
                            duration: start.elapsed(),
                            length: start.elapsed(),
                            size: total_bytes / (1024 * 1024),
                        },
                        Err(err) => AnalyticsEvent::MultipartUploadFailed {
                            duration: start.elapsed(),
                            error: err.to_string(),
                        },
                    },
                );

                result.map(|_| ())
            }),
        }
    }

    async fn read_segment_data(
        file_path: &Path,
        subpath: &str,
        expected_size: u64,
    ) -> Result<Bytes, AuthedApiError> {
        const FILE_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
        const DATA_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

        Self::read_segment_data_with_timeouts(
            file_path,
            subpath,
            expected_size,
            FILE_WAIT_TIMEOUT,
            DATA_WAIT_TIMEOUT,
        )
        .await
    }

    async fn read_segment_data_with_timeouts(
        file_path: &Path,
        subpath: &str,
        expected_size: u64,
        file_wait_timeout: Duration,
        data_wait_timeout: Duration,
    ) -> Result<Bytes, AuthedApiError> {
        if expected_size == 0 {
            return Err(format!("segment_upload/{subpath}: expected segment size is zero").into());
        }

        let start = Instant::now();
        let actual_path = loop {
            if file_path.exists() {
                break file_path.to_path_buf();
            }
            if start.elapsed() >= file_wait_timeout {
                return Err(format!(
                    "segment_upload/timeout/{subpath}: file not found after {:?} ({})",
                    file_wait_timeout,
                    file_path.display()
                )
                .into());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        let start = Instant::now();
        let file_data = loop {
            let data = tokio::fs::read(&actual_path).await.map_err(|e| {
                format!(
                    "segment_upload/read/{subpath}: {e} ({})",
                    actual_path.display()
                )
            })?;

            if data.len() as u64 == expected_size {
                break data;
            }

            if data.len() as u64 > expected_size || start.elapsed() >= data_wait_timeout {
                return Err(format!(
                    "segment_upload/{subpath}: expected {expected_size} bytes, found {}",
                    data.len()
                )
                .into());
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
        };

        Ok(Bytes::from(file_data))
    }

    async fn put_segment_to_s3(
        app: &AppHandle,
        video_id: &str,
        subpath: &str,
        file_bytes: Bytes,
        url_cache: &PresignedUrlCache,
        prefetched_url: Option<String>,
    ) -> Result<u64, AuthedApiError> {
        const MAX_RETRIES: u32 = 3;
        let file_size = file_bytes.len();
        let mut cached_url = prefetched_url;

        for attempt in 0..MAX_RETRIES {
            let presigned_url = match cached_url.take() {
                Some(url) => url,
                None => url_cache.get_or_fetch(app, video_id, subpath).await?,
            };

            let client = app
                .state::<RetryableHttpClient>()
                .as_ref()
                .map_err(|err| format!("segment_upload/client: {err:?}"))?
                .clone();

            let request = client
                .put(&presigned_url)
                .header("Content-Length", file_size)
                .header("Content-Type", content_type_for_upload_subpath(subpath))
                .timeout(Duration::from_secs(5 * 60))
                .body(file_bytes.clone());
            let send_result = with_drive_content_range(
                request,
                &presigned_url,
                0,
                file_size as u64,
                file_size as u64,
            )
            .send()
            .await;

            match send_result {
                Ok(resp) if resp.status().is_success() => {
                    return Ok(file_size as u64);
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    if attempt < MAX_RETRIES - 1 {
                        warn!(
                            attempt = attempt + 1,
                            subpath,
                            status = %status,
                            "Segment upload failed, retrying"
                        );
                        tokio::time::sleep(Duration::from_millis(500 * (1 << attempt) as u64))
                            .await;
                        continue;
                    }
                    return Err(format!("segment_upload/{subpath}/error: {status} {body}").into());
                }
                Err(err) if is_reqwest_network_error(&err) => {
                    if attempt < MAX_RETRIES - 1 {
                        warn!(
                            attempt = attempt + 1,
                            subpath,
                            error = %err,
                            "Segment upload network error, retrying"
                        );
                        if !wait_for_network_recovery(app, video_id).await {
                            return Err(
                                format!("segment_upload/{subpath}/network_timeout: {err}").into()
                            );
                        }
                        continue;
                    }
                    return Err(format!("segment_upload/{subpath}/network_error: {err}").into());
                }
                Err(err) => {
                    return Err(format!("segment_upload/{subpath}/error: {err}").into());
                }
            }
        }

        Err(format!("segment_upload/{subpath}/exhausted_retries").into())
    }

    async fn upload_manifest(
        app: &AppHandle,
        video_id: &str,
        manifest: &SegmentUploadManifest,
        url_cache: &PresignedUrlCache,
    ) -> Result<(), AuthedApiError> {
        let json = serde_json::to_string_pretty(manifest)
            .map_err(|e| format!("segment_upload/manifest/serialize: {e}"))?;

        let presigned_url = url_cache
            .get_or_fetch(app, video_id, "segments/manifest.json")
            .await?;

        let client = app
            .state::<RetryableHttpClient>()
            .as_ref()
            .map_err(|err| format!("segment_upload/manifest/client: {err:?}"))?
            .clone();

        let content_length = json.len() as u64;
        let request = client
            .put(&presigned_url)
            .header("Content-Length", content_length)
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(60))
            .body(json);
        let resp =
            with_drive_content_range(request, &presigned_url, 0, content_length, content_length)
                .send()
                .await
                .map_err(|err| format!("segment_upload/manifest/error: {err}"))?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("segment_upload/manifest/error: {body}").into());
        }

        Ok(())
    }

    async fn run(
        app: AppHandle,
        video_id: String,
        segment_rx: std::sync::mpsc::Receiver<
            cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent,
        >,
        recording_done: Option<flume::Receiver<()>>,
        recording_dir: PathBuf,
        pre_created_video: VideoUploadInfo,
    ) -> Result<u64, AuthedApiError> {
        use cap_enc_ffmpeg::segmented_stream::SegmentMediaType;

        let _active_upload = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
        info!("Starting segment uploader for {video_id}");

        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            format!("Error reading project meta from {recording_dir:?} for segment upload: {err}")
        })?;
        project_meta.upload = Some(UploadMeta::SegmentUpload {
            video_id: video_id.clone(),
            pre_created_video: pre_created_video.clone(),
            recording_dir: recording_dir.clone(),
        });
        project_meta
            .save_for_project()
            .map_err(|error| format!("Failed to persist resumable segment upload: {error}"))?;

        let state = Arc::new(Mutex::new(SegmentUploadState::new()));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
        let read_semaphore = Arc::new(tokio::sync::Semaphore::new(12));
        let consecutive_failures = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut in_flight = SegmentUploadTasks::new();
        let mut prefetch_tasks = futures::stream::FuturesUnordered::new();

        let url_cache = Arc::new(PresignedUrlCache::new());
        {
            let cache = url_cache.clone();
            let app = app.clone();
            let vid = video_id.clone();
            prefetch_tasks.push(tokio::spawn(async move {
                cache.prefetch(&app, &vid, 20).await;
            }));
        }

        let manifest_dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let manifest_shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let manifest_notify = Arc::new(tokio::sync::Notify::new());
        let manifest_handle = {
            let app = app.clone();
            let video_id = video_id.clone();
            let state = state.clone();
            let dirty = manifest_dirty.clone();
            let shutdown = manifest_shutdown.clone();
            let notify = manifest_notify.clone();
            let url_cache = url_cache.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {}
                        _ = notify.notified() => {}
                    }
                    if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        let manifest = state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .to_manifest();
                        if let Err(e) =
                            Self::upload_manifest(&app, &video_id, &manifest, &url_cache).await
                        {
                            warn!("Periodic manifest upload failed: {e}");
                        }
                    }
                    if shutdown.load(std::sync::atomic::Ordering::Acquire) {
                        if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                            let manifest = state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .to_manifest();
                            Self::upload_manifest(&app, &video_id, &manifest, &url_cache)
                                .await
                                .ok();
                        }
                        break;
                    }
                }
            })
        };

        let (async_segment_tx, mut async_segment_rx) = tokio::sync::mpsc::unbounded_channel::<
            cap_enc_ffmpeg::segmented_stream::SegmentCompletedEvent,
        >();

        let bridge_handle = {
            let async_segment_tx = async_segment_tx;
            let recording_done = recording_done.clone();
            std::thread::Builder::new()
                .name("segment-rx-bridge".to_string())
                .spawn(move || {
                    loop {
                        match segment_rx.recv_timeout(std::time::Duration::from_millis(20)) {
                            Ok(event) => {
                                if async_segment_tx.send(event).is_err() {
                                    break;
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                                if let Some(ref done_rx) = recording_done
                                    && done_rx.try_recv().is_ok()
                                {
                                    while let Ok(event) = segment_rx.try_recv() {
                                        if async_segment_tx.send(event).is_err() {
                                            return;
                                        }
                                    }
                                    break;
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                while let Ok(event) = segment_rx.try_recv() {
                                    if async_segment_tx.send(event).is_err() {
                                        return;
                                    }
                                }
                                break;
                            }
                        }
                    }
                })
                .map_err(|e| format!("Failed to spawn bridge thread: {e}"))
        };

        let bridge_handle = match bridge_handle {
            Ok(handle) => handle,
            Err(error) => {
                manifest_shutdown.store(true, std::sync::atomic::Ordering::Release);
                manifest_notify.notify_one();
                let _ = manifest_handle.await;
                cancel_segment_prefetch_tasks(&mut prefetch_tasks).await;
                return Err(error.into());
            }
        };

        use futures::StreamExt as _;

        const CONSECUTIVE_FAILURE_LIMIT: u32 = 5;

        loop {
            tokio::select! {
                biased;
                Some(join_result) = in_flight.next(), if !in_flight.is_empty() => {
                    state.lock().unwrap_or_else(|error| error.into_inner()).record_task_result(join_result);
                }
                maybe_event = async_segment_rx.recv() => {
                    let Some(event) = maybe_event else {
                        break;
                    };

                    let subpath = match (event.is_init, event.media_type) {
                        (true, SegmentMediaType::Video) => "segments/video/init.mp4".to_string(),
                        (true, SegmentMediaType::Audio) => "segments/audio/init.mp4".to_string(),
                        (false, SegmentMediaType::Video) => {
                            format!("segments/video/segment_{:03}.m4s", event.index)
                        }
                        (false, SegmentMediaType::Audio) => {
                            format!("segments/audio/segment_{:03}.m4s", event.index)
                        }
                    };

                    let app_clone = app.clone();
                    let video_id_clone = video_id.clone();
                    let state_clone = state.clone();
                    let failures_clone = consecutive_failures.clone();
                    let semaphore_clone = semaphore.clone();
                    let read_semaphore_clone = read_semaphore.clone();
                    let url_cache_clone = url_cache.clone();
                    let manifest_dirty_clone = manifest_dirty.clone();
                    let manifest_notify_clone = manifest_notify.clone();

                    let file_path = event.path.clone();
                    let is_init = event.is_init;
                    let media_type = event.media_type;
                    let index = event.index;
                    let duration = event.duration;
                    let expected_size = event.file_size;
                    let subpath_for_fail = subpath.clone();

                    let handle = tokio::spawn(async move {
                        let _read_permit = read_semaphore_clone
                            .acquire()
                            .await
                            .map_err(|e| format!("segment_upload/read_semaphore: {e}"))?;

                        let (file_result, url_result) = tokio::join!(
                            Self::read_segment_data(&file_path, &subpath, expected_size),
                            url_cache_clone.get_or_fetch(
                                &app_clone,
                                &video_id_clone,
                                &subpath
                            ),
                        );

                        let file_data = match file_result {
                            Ok(data) => data,
                            Err(e) => {
                                let prev = failures_clone
                                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                warn!(
                                    subpath,
                                    error = %e,
                                    consecutive_failures = prev + 1,
                                    "Failed to read segment, queued for retry"
                                );
                                let mut s =
                                    state_clone.lock().unwrap_or_else(|e| e.into_inner());
                                s.failed_segments.push(FailedSegmentInfo {
                                    subpath: subpath_for_fail,
                                    file_path,
                                    is_init,
                                    media_type,
                                    index,
                                    duration,
                                    expected_size,
                                });
                                return Ok(());
                            }
                        };

                        let prefetched_url = match url_result {
                            Ok(url) => Some(url),
                            Err(e) => {
                                warn!(subpath, error = %e, "Pre-fetch URL failed, will fetch on demand");
                                None
                            }
                        };

                        drop(_read_permit);

                        let permit = semaphore_clone
                            .acquire_owned()
                            .await
                            .map_err(|e| format!("segment_upload/semaphore: {e}"))?;

                        let result = Self::put_segment_to_s3(
                            &app_clone,
                            &video_id_clone,
                            &subpath,
                            file_data,
                            &url_cache_clone,
                            prefetched_url,
                        )
                        .await;

                        drop(permit);

                        match result {
                            Err(e) => {
                                let prev = failures_clone
                                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                warn!(
                                    subpath,
                                    error = %e,
                                    consecutive_failures = prev + 1,
                                    "Failed to upload segment, queued for retry"
                                );
                                let mut s =
                                    state_clone.lock().unwrap_or_else(|e| e.into_inner());
                                s.failed_segments.push(FailedSegmentInfo {
                                    subpath: subpath_for_fail,
                                    file_path,
                                    is_init,
                                    media_type,
                                    index,
                                    duration,
                                    expected_size,
                                });
                            }
                            Ok(bytes) => {
                                failures_clone
                                    .store(0, std::sync::atomic::Ordering::Relaxed);
                                let mut s =
                                    state_clone.lock().unwrap_or_else(|e| e.into_inner());
                                s.total_bytes_uploaded += bytes;
                                if is_init {
                                    match media_type {
                                        SegmentMediaType::Video => {
                                            s.video_init_uploaded = true
                                        }
                                        SegmentMediaType::Audio => {
                                            s.audio_init_uploaded = true
                                        }
                                    }
                                } else {
                                    match media_type {
                                        SegmentMediaType::Video => {
                                            s.uploaded_video_segments
                                                .insert(index, duration);
                                        }
                                        SegmentMediaType::Audio => {
                                            s.uploaded_audio_segments
                                                .insert(index, duration);
                                        }
                                    }
                                }
                                manifest_dirty_clone
                                    .store(true, std::sync::atomic::Ordering::Release);
                                manifest_notify_clone.notify_one();
                                info!(subpath, "Segment uploaded successfully");
                            }
                        }

                        Ok(())
                    });

                    in_flight.push(handle);

                    if !event.is_init
                        && event.media_type == SegmentMediaType::Video
                        && event.index > 0
                        && event.index % 15 == 0
                    {
                        let cache = url_cache.clone();
                        let app_ref = app.clone();
                        let vid_ref = video_id.clone();
                        let from = event.index + 1;
                        prefetch_tasks.push(tokio::spawn(async move {
                            cache.extend_prefetch(&app_ref, &vid_ref, from, 20).await;
                        }));
                    }

                    if consecutive_failures.load(std::sync::atomic::Ordering::Relaxed) >= CONSECUTIVE_FAILURE_LIMIT {
                        warn!("Consecutive upload failures reached threshold, attempting network recovery");
                        if !wait_for_network_recovery(&app, &video_id).await {
                            warn!("Network recovery failed during segment upload");
                        }
                        consecutive_failures.store(0, std::sync::atomic::Ordering::Relaxed);
                    }
                }
            }
        }

        drain_segment_upload_tasks(&state, &mut in_flight).await;

        if bridge_handle.join().is_err() {
            state
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .record_worker_failure("Segment upload bridge did not complete".to_string());
        }

        manifest_shutdown.store(true, std::sync::atomic::Ordering::Release);
        manifest_dirty.store(true, std::sync::atomic::Ordering::Release);
        manifest_notify.notify_one();
        let manifest_result = manifest_handle.await;
        state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .record_task_result(manifest_result.map(|()| Ok(())));
        cancel_segment_prefetch_tasks(&mut prefetch_tasks).await;

        let failed = {
            let s = state.lock().unwrap_or_else(|e| e.into_inner());
            s.failed_segments.clone()
        };

        if !failed.is_empty() {
            info!(
                count = failed.len(),
                "Retrying failed segment uploads before completing"
            );
            for seg in failed {
                let file_data =
                    Self::read_segment_data(&seg.file_path, &seg.subpath, seg.expected_size).await;

                let file_data = match file_data {
                    Ok(data) => data,
                    Err(e) => {
                        warn!(
                            subpath = seg.subpath,
                            error = %e,
                            "Failed segment retry read failed, segment will be missing"
                        );
                        continue;
                    }
                };

                match Self::put_segment_to_s3(
                    &app,
                    &video_id,
                    &seg.subpath,
                    file_data,
                    &url_cache,
                    None,
                )
                .await
                {
                    Ok(bytes) => {
                        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                        s.total_bytes_uploaded += bytes;
                        if seg.is_init {
                            match seg.media_type {
                                SegmentMediaType::Video => s.video_init_uploaded = true,
                                SegmentMediaType::Audio => s.audio_init_uploaded = true,
                            }
                        } else {
                            match seg.media_type {
                                SegmentMediaType::Video => {
                                    s.uploaded_video_segments.insert(seg.index, seg.duration);
                                }
                                SegmentMediaType::Audio => {
                                    s.uploaded_audio_segments.insert(seg.index, seg.duration);
                                }
                            }
                        }
                        s.failed_segments.retain(|f| f.subpath != seg.subpath);
                        info!(subpath = seg.subpath, "Failed segment retry succeeded");
                    }
                    Err(e) => {
                        warn!(
                            subpath = seg.subpath,
                            error = %e,
                            "Failed segment retry also failed, segment will be missing"
                        );
                    }
                }
            }
        }

        let completion_state = state.as_ref();
        publish_completed_segments(completion_state, |final_manifest| async move {
            {
                let mut manifest_err: Option<AuthedApiError> = None;
                for attempt in 0..3u32 {
                    match Self::upload_manifest(&app, &video_id, &final_manifest, &url_cache).await
                    {
                        Ok(()) => {
                            manifest_err = None;
                            break;
                        }
                        Err(e) => {
                            warn!(
                                attempt = attempt + 1,
                                "Failed to upload final manifest: {e}"
                            );
                            manifest_err = Some(e);
                            if attempt < 2 {
                                tokio::time::sleep(Duration::from_millis(
                                    1000 * (1 << attempt) as u64,
                                ))
                                .await;
                            }
                        }
                    }
                }
                if let Some(e) = manifest_err {
                    error!("All attempts to upload final manifest failed for {video_id}");

                    // Leave the UploadMeta::SegmentUpload written at upload start in
                    // place so resume_uploads retries this recording on next launch.
                    emit_upload_complete(&app, &video_id);

                    return Err(format!("segment_upload/final_manifest: {e}").into());
                }
            }

            {
                let mut signal_ok = false;
                for attempt in 0..3u32 {
                    match api::signal_recording_complete(&app, &video_id).await {
                        Ok(()) => {
                            signal_ok = true;
                            break;
                        }
                        Err(e) => {
                            warn!(
                                attempt = attempt + 1,
                                "Failed to signal recording complete: {e}"
                            );
                            if attempt < 2 {
                                tokio::time::sleep(Duration::from_millis(
                                    1000 * (1 << attempt) as u64,
                                ))
                                .await;
                            }
                        }
                    }
                }
                if !signal_ok {
                    error!("All attempts to signal recording complete failed for {video_id}");

                    if let Ok(mut meta) = RecordingMeta::load_for_project(&recording_dir) {
                        meta.upload = Some(UploadMeta::SegmentUpload {
                            video_id: video_id.clone(),
                            pre_created_video: pre_created_video.clone(),
                            recording_dir: recording_dir.clone(),
                        });
                        meta.save_for_project().ok();
                    }

                    emit_upload_complete(&app, &video_id);

                    return Err(format!(
                        "Failed to signal recording complete for {video_id} after 3 attempts"
                    )
                    .into());
                }
            }

            emit_upload_complete(&app, &video_id);

            let mut project_meta = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            format!("Error reading project meta from {recording_dir:?} for upload complete: {err}")
        })?;
            project_meta.upload = Some(UploadMeta::Complete);
            project_meta
                .save_for_project()
                .map_err(|err| format!("Error saving project meta for {recording_dir:?}: {err}"))?;

            let _ = app.clipboard().write_text(pre_created_video.link.clone());

            let total_bytes = completion_state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .total_bytes_uploaded;

            info!(total_bytes, "Segment upload complete for {video_id}");

            Ok(total_bytes)
        })
        .await
    }
}

pub struct Chunk {
    total_size: u64,
    part_number: u32,
    offset: u64,
    chunk: Bytes,
}

struct FailedChunkInfo {
    part_number: u32,
    offset: u64,
    chunk_size: usize,
    total_size: u64,
    error: String,
}

/// Creates a stream that reads chunks from a file, yielding [Chunk]'s.
#[allow(unused)]
#[instrument]
pub fn from_file_to_chunks(path: PathBuf) -> impl Stream<Item = io::Result<Chunk>> {
    try_stream! {
        let file = File::open(path).await?;
        let total_size = file.metadata().await?.len();
        let mut file = BufReader::new(file);

        let mut buf = vec![0u8; MAX_CHUNK_SIZE as usize];
        let mut part_number = 0;
        let mut current_offset: u64 = 0;
        loop {
            part_number += 1;
            let n = file.read(&mut buf).await?;
            if n == 0 { break; }
            yield Chunk {
                total_size,
                part_number,
                offset: current_offset,
                chunk: Bytes::copy_from_slice(&buf[..n]),
            };
            current_offset += n as u64;
        }
    }
    .instrument(Span::current())
}

/// Creates a stream that reads chunks from a potentially growing file, yielding [Chunk]'s.
/// The first chunk of the file is yielded last to allow for header rewriting after recording completion.
/// This uploader will continually poll the filesystem and wait for the file to stop uploading before flushing the rest.
#[instrument(skip(realtime_upload_done))]
pub fn from_pending_file_to_chunks(
    path: PathBuf,
    realtime_upload_done: Option<Receiver<()>>,
) -> impl Stream<Item = io::Result<Chunk>> {
    try_stream! {
        let mut file = timeout(Duration::from_secs(20), async move {
            loop {
                if let Ok(file) = tokio::fs::File::open(&path).await.map_err(|err| error!("from_pending_file_to_chunks/open: {err:?}")) {
                    break file;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await
        .map_err(|_| io::Error::other("Failed to open file. The recording pipeline may have crashed?"))?;

        let mut part_number = 1;
        let mut last_read_position: u64 = 0;
        let mut realtime_is_done = realtime_upload_done.as_ref().map(|_| false);
        let mut recording_completed_cleanly = false;
        let mut first_chunk_size: Option<u64> = None;
        let mut chunk_buffer = vec![0u8; MAX_CHUNK_SIZE as usize];

        loop {
            if !realtime_is_done.unwrap_or(true) && let Some(ref realtime_receiver) = realtime_upload_done {
                    match realtime_receiver.try_recv() {
                        Ok(_) => {
                            realtime_is_done = Some(true);
                            recording_completed_cleanly = true;
                        },
                        Err(flume::TryRecvError::Empty) => {},
                        Err(flume::TryRecvError::Disconnected) => {
                            warn!(
                                "Recording channel disconnected without completion signal — \
                                 recording may have failed, finishing upload without header correction"
                            );
                            realtime_is_done = Some(true);
                        },
                    }

            }

            let file_size = match file.metadata().await {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    // File might be temporarily locked, retry with shorter delay
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };

            let new_data_size = file_size.saturating_sub(last_read_position);

            // Determine if we should read a chunk
            let should_read_chunk = if let Some(is_done) = realtime_is_done {
                (new_data_size >= MIN_CHUNK_SIZE) || (is_done && new_data_size > 0)
            } else {
                new_data_size > 0
            };

            if should_read_chunk {
                let chunk_size = std::cmp::min(new_data_size, MAX_CHUNK_SIZE) as usize;

                file.seek(std::io::SeekFrom::Start(last_read_position)).await?;

                let mut total_read = 0;
                while total_read < chunk_size {
                    match file.read(&mut chunk_buffer[total_read..chunk_size]).await {
                        Ok(0) => break, // EOF
                        Ok(n) => total_read += n,
                        Err(e) => yield Err(e)?,
                    }
                }

                if total_read > 0 {
                    if last_read_position == 0 {
                        first_chunk_size = Some(total_read as u64);
                    }

                    yield Chunk {
                        total_size: file_size,
                        part_number,
                        offset: last_read_position,
                        chunk: Bytes::copy_from_slice(&chunk_buffer[..total_read]),
                    };
                    part_number += 1;
                    last_read_position += total_read as u64;
                }
            } else if new_data_size == 0 && realtime_is_done.unwrap_or(true) {
                if let Some(first_size) = first_chunk_size && realtime_upload_done.is_some() && recording_completed_cleanly {
                    file.seek(std::io::SeekFrom::Start(0)).await?;

                    let chunk_size = first_size as usize;
                    let mut total_read = 0;

                    while total_read < chunk_size {
                        match file.read(&mut chunk_buffer[total_read..chunk_size]).await {
                            Ok(0) => break,
                            Ok(n) => total_read += n,
                            Err(e) => yield Err(e)?,
                        }
                    }

                    if total_read > 0 {
                        yield Chunk {
                            total_size: file_size,
                            part_number: 1,
                            offset: 0,
                            chunk: Bytes::copy_from_slice(&chunk_buffer[..total_read]),
                        };
                    }
                }
                break;
            } else {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    .instrument(Span::current())
}

#[instrument(skip(app, stream, upload_id, failed_chunks))]
fn multipart_uploader(
    app: AppHandle,
    video_id: String,
    upload_id: String,
    is_drive_upload: bool,
    stream: impl Stream<Item = io::Result<Chunk>> + Send + 'static,
    failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>>,
) -> impl Stream<Item = Result<UploadedPart, AuthedApiError>> + 'static {
    const MAX_CONCURRENT_UPLOADS: usize = 5;

    debug!("Initializing multipart uploader for video {video_id:?}");
    let start = Instant::now();
    let video_id2 = video_id.clone();

    stream::once(async move {
        let use_md5_hashes = app.is_server_url_custom().await;
        let max_concurrent_uploads = if is_drive_upload {
            1
        } else {
            MAX_CONCURRENT_UPLOADS
        };
        let first_chunk_presigned_url = Arc::new(Mutex::new(None::<(String, Instant)>));

        stream::unfold(
            (Box::pin(stream), 1),
            move |(mut stream, expected_part_number)| {
                let app = app.clone();
                let video_id = video_id.clone();
                let upload_id = upload_id.clone();
                let first_chunk_presigned_url = first_chunk_presigned_url.clone();
                let failed_chunks = failed_chunks.clone();

                async move {
                    let (Some(item), presigned_url) = join(stream.next(), async {
                        if use_md5_hashes {
                            return Ok(None);
                        }

                        api::upload_multipart_presign_part(
                            &app,
                            &video_id,
                            &upload_id,
                            expected_part_number,
                            None,
                        )
                        .await
                        .map(Some)
                    })
                    .await
                    else {
                        return None;
                    };

                    let part_number = item
                        .as_ref()
                        .map(|c| c.part_number.to_string())
                        .unwrap_or_else(|_| "--".into());

                    Some((
                        async move {
                            let Chunk {
                                total_size,
                                part_number,
                                chunk,
                                offset,
                            } = match item {
                                Ok(c) => c,
                                Err(err) => {
                                    return Some(Err(AuthedApiError::Other(format!(
                                        "uploader/part/{expected_part_number:?}/fs: {err:?}"
                                    ))));
                                }
                            };

                            let chunk_size = chunk.len();

                            let upload_result = async move {
                                trace!(
                                    "Uploading chunk {part_number} ({chunk_size} bytes) for video {video_id:?}",
                                );

                                let md5_sum =
                                    use_md5_hashes.then(|| base64::encode(md5::compute(&chunk).0));
                                let presigned_url = if let Some(url) = presigned_url?
                                    && part_number == expected_part_number
                                {
                                    url
                                } else if part_number == 1
                                    && !use_md5_hashes
                                    && let Some((url, expiry)) = first_chunk_presigned_url
                                        .lock()
                                        .unwrap_or_else(PoisonError::into_inner)
                                        .clone()
                                    && expiry.elapsed() < Duration::from_secs(60 * 50)
                                {
                                    url
                                } else {
                                    api::upload_multipart_presign_part(
                                        &app,
                                        &video_id,
                                        &upload_id,
                                        part_number,
                                        md5_sum.as_deref(),
                                    )
                                    .await?
                                };

                                if part_number == 1 {
                                    *first_chunk_presigned_url
                                        .lock()
                                        .unwrap_or_else(PoisonError::into_inner) =
                                        Some((presigned_url.clone(), Instant::now()));
                                }

                                let size = chunk.len();
                                let chunk_for_retry = chunk.clone();
                                let client = app
                                    .state::<RetryableHttpClient>()
                                    .as_ref()
                                    .map_err(|err| {
                                        format!("uploader/part/{part_number}/client: {err:?}")
                                    })?
                                    .clone();

                                let req = client
                                    .put(&presigned_url)
                                    .header("Content-Length", size)
                                    .timeout(Duration::from_secs(5 * 60))
                                    .body(chunk);
                                let mut req = with_drive_content_range(
                                    req,
                                    &presigned_url,
                                    offset,
                                    size as u64,
                                    total_size,
                                );

                                if let Some(md5_sum) = &md5_sum {
                                    req = req.header("Content-MD5", md5_sum);
                                }

                                let send_result = req
                                    .send()
                                    .instrument(info_span!("s3_put", size = size))
                                    .await;

                                let resp = match send_result {
                                    Ok(resp) => resp,
                                    Err(err) if is_reqwest_network_error(&err) => {
                                        info!(
                                            part_number,
                                            error = %err,
                                            "Chunk upload failed due to network error, waiting for connectivity"
                                        );
                                        if !wait_for_network_recovery(&app, &video_id).await {
                                            return Err(format!(
                                                "uploader/part/{part_number}/network_timeout: {err:?}"
                                            )
                                            .into());
                                        }
                                        let retry_url = api::upload_multipart_presign_part(
                                            &app,
                                            &video_id,
                                            &upload_id,
                                            part_number,
                                            md5_sum.as_deref(),
                                        )
                                        .await?;
                                        let retry_req = client
                                            .put(&retry_url)
                                            .header("Content-Length", size)
                                            .timeout(Duration::from_secs(5 * 60))
                                            .body(chunk_for_retry);
                                        let mut retry_req = with_drive_content_range(
                                            retry_req,
                                            &retry_url,
                                            offset,
                                            size as u64,
                                            total_size,
                                        );
                                        if let Some(md5_sum) = &md5_sum {
                                            retry_req =
                                                retry_req.header("Content-MD5", md5_sum);
                                        }
                                        retry_req
                                            .send()
                                            .instrument(info_span!(
                                                "s3_put_after_network_recovery",
                                                size = size
                                            ))
                                            .await
                                            .map_err(|err| {
                                                format!(
                                                    "uploader/part/{part_number}/network_retry_error: {err:?}"
                                                )
                                            })?
                                    }
                                    Err(err) => {
                                        return Err(format!(
                                            "uploader/part/{part_number}/error: {err:?}"
                                        )
                                        .into());
                                    }
                                };

                                let etag = resp
                                    .headers()
                                    .get("ETag")
                                    .as_ref()
                                    .and_then(|etag| etag.to_str().ok())
                                    .map(|v| v.trim_matches('"').to_string());

                                match !is_upload_response_accepted(
                                    &presigned_url,
                                    resp.status(),
                                    offset,
                                    size as u64,
                                    total_size,
                                ) {
                                    true => Err(format!(
                                        "uploader/part/{part_number}/error: {}",
                                        resp.text().await.unwrap_or_default()
                                    )),
                                    false => Ok(()),
                                }?;

                                trace!("Completed upload of part {part_number}");

                                let etag = match etag {
                                    Some(etag) => etag,
                                    None if is_google_drive_resumable_url(&presigned_url) => {
                                        format!("drive-{part_number}")
                                    }
                                    None => {
                                        return Err(format!(
                                            "uploader/part/{part_number}/missing_etag"
                                        )
                                        .into());
                                    }
                                };

                                Ok::<_, AuthedApiError>(UploadedPart {
                                    etag,
                                    part_number,
                                    size,
                                    total_size,
                                })
                            }
                            .await;

                            match upload_result {
                                Ok(part) => Some(Ok(part)),
                                Err(err) => {
                                    warn!(
                                        part_number = part_number,
                                        offset = offset,
                                        chunk_size = chunk_size,
                                        error = %err,
                                        "Chunk upload failed, will retry after remaining chunks"
                                    );
                                    failed_chunks
                                        .lock()
                                        .unwrap_or_else(PoisonError::into_inner)
                                        .push(FailedChunkInfo {
                                            part_number,
                                            offset,
                                            chunk_size,
                                            total_size,
                                            error: err.to_string(),
                                        });
                                    None
                                }
                            }
                        }
                        .instrument(info_span!("upload_part", part_number = part_number)),
                        (stream, expected_part_number + 1),
                    ))
                }
            },
        )
        .buffered(max_concurrent_uploads)
        .filter_map(|item| async { item })
        .boxed()
    })
    .chain(stream::once(async move {
        debug!(
            "Completed multipart upload for {video_id2:?} in {:?}",
            start.elapsed()
        );

        stream::empty().boxed()
    }))
    .flatten()
    .instrument(Span::current())
}

async fn read_exact_upload_chunk(
    file_path: &Path,
    offset: u64,
    chunk_size: usize,
) -> io::Result<Bytes> {
    if chunk_size == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Upload chunk must contain bytes",
        ));
    }
    let mut file = File::open(file_path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut buffer = vec![0u8; chunk_size];
    file.read_exact(&mut buffer).await?;
    Ok(Bytes::from(buffer))
}

#[instrument(skip(app, failed_chunks))]
async fn retry_failed_chunks(
    app: &AppHandle,
    video_id: &str,
    upload_id: &str,
    file_path: &Path,
    failed_chunks: Vec<FailedChunkInfo>,
) -> Result<Vec<UploadedPart>, AuthedApiError> {
    let use_md5_hashes = app.is_server_url_custom().await;
    let mut retry_parts = Vec::new();

    for failed in &failed_chunks {
        info!(
            part_number = failed.part_number,
            offset = failed.offset,
            chunk_size = failed.chunk_size,
            original_error = %failed.error,
            "Retrying failed chunk upload"
        );

        let chunk = read_exact_upload_chunk(file_path, failed.offset, failed.chunk_size)
            .await
            .map_err(|error| format!("retry/part/{}/read: {error}", failed.part_number))?;

        let md5_sum = use_md5_hashes.then(|| base64::encode(md5::compute(&chunk).0));

        let presigned_url = api::upload_multipart_presign_part(
            app,
            video_id,
            upload_id,
            failed.part_number,
            md5_sum.as_deref(),
        )
        .await?;

        let size = chunk.len();
        let chunk_for_retry = chunk.clone();
        let client = app
            .state::<RetryableHttpClient>()
            .as_ref()
            .map_err(|err| format!("retry/part/{}/client: {err:?}", failed.part_number))?
            .clone();

        let req = client
            .put(&presigned_url)
            .header("Content-Length", size)
            .timeout(Duration::from_secs(5 * 60))
            .body(chunk);
        let mut req = with_drive_content_range(
            req,
            &presigned_url,
            failed.offset,
            size as u64,
            failed.total_size,
        );

        if let Some(md5_sum) = &md5_sum {
            req = req.header("Content-MD5", md5_sum);
        }

        let send_result = req
            .send()
            .instrument(info_span!(
                "s3_put_retry",
                part_number = failed.part_number,
                size = size
            ))
            .await;

        let resp = match send_result {
            Ok(resp) => resp,
            Err(err) if is_reqwest_network_error(&err) => {
                info!(
                    part_number = failed.part_number,
                    error = %err,
                    "Retry chunk upload failed due to network error, waiting for connectivity"
                );
                if !wait_for_network_recovery(app, video_id).await {
                    return Err(format!(
                        "retry/part/{}/network_timeout: {err:?}",
                        failed.part_number
                    )
                    .into());
                }
                let retry_url = api::upload_multipart_presign_part(
                    app,
                    video_id,
                    upload_id,
                    failed.part_number,
                    md5_sum.as_deref(),
                )
                .await?;
                let retry_req = client
                    .put(&retry_url)
                    .header("Content-Length", size)
                    .timeout(Duration::from_secs(5 * 60))
                    .body(chunk_for_retry);
                let mut retry_req = with_drive_content_range(
                    retry_req,
                    &retry_url,
                    failed.offset,
                    size as u64,
                    failed.total_size,
                );
                if let Some(md5_sum) = &md5_sum {
                    retry_req = retry_req.header("Content-MD5", md5_sum);
                }
                retry_req
                    .send()
                    .instrument(info_span!(
                        "s3_put_retry_after_network_recovery",
                        part_number = failed.part_number,
                        size = size
                    ))
                    .await
                    .map_err(|err| {
                        format!(
                            "retry/part/{}/network_retry_error: {err:?}",
                            failed.part_number
                        )
                    })?
            }
            Err(err) => {
                return Err(format!("retry/part/{}/error: {err:?}", failed.part_number).into());
            }
        };

        let etag = resp
            .headers()
            .get("ETag")
            .as_ref()
            .and_then(|etag| etag.to_str().ok())
            .map(|v| v.trim_matches('"').to_string());

        if !is_upload_response_accepted(
            &presigned_url,
            resp.status(),
            failed.offset,
            size as u64,
            failed.total_size,
        ) {
            return Err(format!(
                "retry/part/{}/error: {}",
                failed.part_number,
                resp.text().await.unwrap_or_default()
            )
            .into());
        }

        info!(
            part_number = failed.part_number,
            "Successfully retried chunk upload"
        );

        let etag = match etag {
            Some(etag) => etag,
            None if is_google_drive_resumable_url(&presigned_url) => {
                format!("drive-{}", failed.part_number)
            }
            None => {
                return Err(format!("retry/part/{}/missing_etag", failed.part_number).into());
            }
        };

        retry_parts.push(UploadedPart {
            etag,
            part_number: failed.part_number,
            size,
            total_size: failed.total_size,
        });
    }

    Ok(retry_parts)
}

fn is_reqwest_network_error(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout() || err.status().is_none()
}

async fn probe_connectivity(app: &AppHandle) -> bool {
    let url = app.make_app_url("/").await;
    app.state::<HttpClient>()
        .head(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .is_ok()
}

async fn wait_for_network_recovery(app: &AppHandle, video_id: &str) -> bool {
    let start = Instant::now();
    let mut delay = CONNECTIVITY_PROBE_INITIAL_DELAY;

    warn!(
        video_id,
        "Network loss detected, pausing uploads until connectivity is restored"
    );

    loop {
        if start.elapsed() > NETWORK_RECOVERY_TIMEOUT {
            error!(
                video_id,
                elapsed_secs = start.elapsed().as_secs(),
                "Network recovery timeout exceeded (5 minutes), giving up"
            );
            return false;
        }

        tokio::time::sleep(delay).await;

        if probe_connectivity(app).await {
            info!(
                video_id,
                waited_secs = start.elapsed().as_secs(),
                "Network connectivity restored, resuming uploads"
            );
            return true;
        }

        delay = (delay * 2).min(CONNECTIVITY_PROBE_MAX_DELAY);
    }
}

#[instrument(skip(app, stream))]
pub async fn singlepart_uploader(
    app: AppHandle,
    request: PresignedS3PutRequest,
    total_size: u64,
    stream: impl Stream<Item = io::Result<Bytes>> + Send + 'static,
) -> Result<(), AuthedApiError> {
    let upload_target = api::upload_signed(&app, request).await?;
    let presigned_url = upload_target.url;

    let mut request = app
        .state::<RetryableHttpClient>()
        .as_ref()
        .map_err(|err| format!("singlepart_uploader/client: {err:?}"))?
        .put(&presigned_url)
        .header("Content-Length", total_size)
        .body(reqwest::Body::wrap_stream(stream));

    for (key, value) in upload_target.headers {
        if key.eq_ignore_ascii_case("content-length") {
            continue;
        }
        request = request.header(key, value);
    }

    let resp = with_drive_content_range(request, &presigned_url, 0, total_size, total_size)
        .send()
        .await
        .map_err(|err| format!("singlepart_uploader/error: {err:?}"))?;

    match !resp.status().is_success() {
        true => Err(format!(
            "singlepart_uploader/error: {}",
            resp.text().await.unwrap_or_default()
        )),
        false => Ok(()),
    }?;

    Ok(())
}

pub trait UploadedChunk {
    /// total size of the file
    fn total(&self) -> u64;

    /// size of the current chunk
    fn size(&self) -> u64;
}

impl UploadedChunk for UploadedPart {
    fn total(&self) -> u64 {
        self.total_size
    }

    fn size(&self) -> u64 {
        self.size as u64
    }
}

impl UploadedChunk for Chunk {
    fn total(&self) -> u64 {
        self.total_size
    }

    fn size(&self) -> u64 {
        self.chunk.len() as u64
    }
}

impl UploadedChunk for (u64, Bytes) {
    fn total(&self) -> u64 {
        self.0
    }

    fn size(&self) -> u64 {
        self.1.len() as u64
    }
}

/// Monitor the stream to report the upload progress
fn progress<T: UploadedChunk, E>(
    app: AppHandle,
    video_id: String,
    stream: impl Stream<Item = Result<T, E>>,
) -> impl Stream<Item = Result<T, E>> {
    let mut uploaded = 0u64;
    let mut pending_task: Option<JoinHandle<()>> = None;
    let mut reemit_task: Option<JoinHandle<()>> = None;

    stream! {
        let mut stream = pin!(stream);

        while let Some(chunk) = stream.next().await {
            if let Ok(chunk) = &chunk {
                uploaded += chunk.size();
                let total = chunk.total();

                if let Some(handle) = pending_task.take() {
                    handle.abort();
                }

                if let Some(handle) = reemit_task.take() {
                    handle.abort();
                }

                let should_send_immediately = uploaded >= total;

                if should_send_immediately {
                    let app_clone = app.clone();
                    let video_id_clone = video_id.clone();
                    tokio::spawn(async move {
                        api::desktop_video_progress(&app_clone, &video_id_clone, uploaded, total).await.ok();
                    });
                } else {
                    let app_clone = app.clone();
                    let video_id_clone = video_id.clone();
                    pending_task = Some(tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        api::desktop_video_progress(&app_clone, &video_id_clone, uploaded, total).await.ok();
                    }));

                    let app_reemit = app.clone();
                    let video_id_reemit = video_id.clone();
                    let uploaded_reemit = uploaded;
                    let total_reemit = total;
                    reemit_task = Some(tokio::spawn(async move {
                        let mut interval = time::interval(Duration::from_millis(700));
                        interval.tick().await;

                        loop {
                            interval.tick().await;
                            UploadProgressEvent {
                                video_id: video_id_reemit.clone(),
                                uploaded: uploaded_reemit.to_string(),
                                total: total_reemit.to_string(),
                            }
                            .emit(&app_reemit)
                            .ok();
                        }
                    }));
                }

                UploadProgressEvent {
                    video_id: video_id.clone(),
                    uploaded: uploaded.to_string(),
                    total: total.to_string(),
                }
                .emit(&app)
                .ok();
            }

            yield chunk;
        }

        if let Some(handle) = reemit_task.take() {
            handle.abort();
        }
    }
}

pub fn emit_upload_complete(app: &AppHandle, video_id: &str) {
    UploadProgressEvent {
        video_id: video_id.to_string(),
        uploaded: "0".into(),
        total: "0".into(),
    }
    .emit(app)
    .ok();
}

/// Track the upload progress into a Tauri channel
fn tauri_channel_progress<T: UploadedChunk, E>(
    channel: Channel<UploadProgress>,
    stream: impl Stream<Item = Result<T, E>>,
) -> impl Stream<Item = Result<T, E>> {
    let mut uploaded = 0u64;

    stream! {
        let mut stream = pin!(stream);

        while let Some(chunk) = stream.next().await {
            if let Ok(chunk) = &chunk {
                uploaded += chunk.size();

                channel.send(UploadProgress {
                    progress: uploaded as f64 / chunk.total() as f64
                })
                .ok();
            }

            yield chunk;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    #[test]
    fn active_upload_guards_track_overlapping_sessions() {
        let active = AtomicUsize::new(0);
        let first = ActiveUploadGuard::new(&active);
        let second = ActiveUploadGuard::new(&active);

        assert_eq!(active.load(Ordering::Acquire), 2);
        drop(first);
        assert_eq!(active.load(Ordering::Acquire), 1);
        drop(second);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn dropping_an_upload_future_releases_its_session() {
        let active = AtomicUsize::new(0);
        let mut upload = Box::pin(async {
            let _guard = ActiveUploadGuard::new(&active);
            std::future::pending::<()>().await;
        });

        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(std::future::Future::poll(upload.as_mut(), &mut context).is_pending());
        assert_eq!(active.load(Ordering::Acquire), 1);
        drop(upload);
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn screenshot_upload_subpath_matches_content_type() {
        assert_eq!(
            screenshot_upload_subpath("image/png"),
            "screenshot/screen-capture.png"
        );
        assert_eq!(
            screenshot_upload_subpath("image/jpeg"),
            "screenshot/screen-capture.jpg"
        );
        assert_eq!(
            screenshot_content_type_from_path(Path::new("screen-capture.png")),
            "image/png"
        );
        assert_eq!(
            screenshot_content_type_from_path(Path::new("screen-capture.jpg")),
            "image/jpeg"
        );
    }

    #[tokio::test]
    async fn multipart_retry_reads_exact_file_range_without_padding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.mp4");
        let data = b"init-video-fragment-final";
        std::fs::write(&path, data).unwrap();

        let chunk = read_exact_upload_chunk(&path, 5, 14).await.unwrap();
        assert_eq!(chunk.as_ref(), &data[5..19]);

        for (offset, size) in [(5, data.len()), (data.len() as u64, 1)] {
            let error = read_exact_upload_chunk(&path, offset, size)
                .await
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        }
        assert_eq!(
            read_exact_upload_chunk(&path, 0, 0)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );

        std::fs::write(&path, b"").unwrap();
        assert_eq!(
            read_exact_upload_chunk(&path, 0, 1)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::UnexpectedEof
        );
    }

    #[tokio::test]
    async fn read_segment_data_returns_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment_001.m4s");
        std::fs::write(&path, b"fake segment data 12345").unwrap();

        let result = SegmentUploader::read_segment_data(
            &path,
            "segments/video/segment_001.m4s",
            b"fake segment data 12345".len() as u64,
        )
        .await;

        let data = result.unwrap();
        assert_eq!(data.as_ref(), b"fake segment data 12345");
    }

    #[tokio::test]
    async fn read_segment_data_waits_for_file_to_appear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment_002.m4s");

        let path_clone = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::write(&path_clone, b"delayed segment data").unwrap();
        });

        let start = Instant::now();
        let result = SegmentUploader::read_segment_data(
            &path,
            "segments/video/segment_002.m4s",
            b"delayed segment data".len() as u64,
        )
        .await;
        let elapsed = start.elapsed();

        let data = result.unwrap();
        assert_eq!(data.as_ref(), b"delayed segment data");
        assert!(
            elapsed >= Duration::from_millis(150),
            "should have waited for file: {elapsed:?}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "should not have waited too long: {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn read_segment_data_waits_for_expected_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment_003.m4s");

        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(b"sm").unwrap();
        file.flush().unwrap();
        drop(file);

        let path_clone = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::write(&path_clone, b"full segment data here!").unwrap();
        });

        let result = SegmentUploader::read_segment_data(
            &path,
            "segments/video/segment_003.m4s",
            b"full segment data here!".len() as u64,
        )
        .await;

        let data = result.unwrap();
        assert_eq!(data.as_ref(), b"full segment data here!");
    }

    #[tokio::test]
    async fn read_segment_data_rejects_empty_short_oversized_and_unknown_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment.m4s");
        for (bytes, expected_size) in [
            (b"".as_slice(), 5),
            (b"tiny".as_slice(), 5),
            (b"too long".as_slice(), 5),
            (b"valid".as_slice(), 0),
        ] {
            std::fs::write(&path, bytes).unwrap();
            let result = SegmentUploader::read_segment_data_with_timeouts(
                &path,
                "segments/video/segment.m4s",
                expected_size,
                Duration::ZERO,
                Duration::ZERO,
            )
            .await;
            assert!(result.is_err(), "accepted {bytes:?} for {expected_size}");
        }
    }

    #[tokio::test]
    async fn read_segment_data_rejects_missing_and_unreadable_input() {
        let dir = tempfile::tempdir().unwrap();
        for path in [dir.path().join("missing.m4s"), dir.path().to_path_buf()] {
            let result = SegmentUploader::read_segment_data_with_timeouts(
                &path,
                "segments/video/segment.m4s",
                5,
                Duration::ZERO,
                Duration::ZERO,
            )
            .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn read_segment_data_polls_at_50ms_not_200ms() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment_fast.m4s");

        let path_clone = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            std::fs::write(&path_clone, b"fast poll data").unwrap();
        });

        let start = Instant::now();
        let result = SegmentUploader::read_segment_data(
            &path,
            "segments/video/segment_fast.m4s",
            b"fast poll data".len() as u64,
        )
        .await;
        let elapsed = start.elapsed();

        assert!(result.is_ok());
        assert!(
            elapsed < Duration::from_millis(300),
            "50ms polling should detect file within ~170ms, got {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn url_cache_returns_prefetched_url() {
        let cache = PresignedUrlCache::new();
        {
            let mut urls = cache.urls.lock().await;
            urls.insert(
                "segments/video/segment_001.m4s".to_string(),
                "https://s3.example.com/presigned/seg1".to_string(),
            );
            urls.insert(
                "segments/video/segment_002.m4s".to_string(),
                "https://s3.example.com/presigned/seg2".to_string(),
            );
        }

        let mut urls = cache.urls.lock().await;
        let url1 = urls.remove("segments/video/segment_001.m4s");
        let url2 = urls.remove("segments/video/segment_002.m4s");
        let url3 = urls.remove("segments/video/segment_003.m4s");
        drop(urls);

        assert_eq!(
            url1.as_deref(),
            Some("https://s3.example.com/presigned/seg1")
        );
        assert_eq!(
            url2.as_deref(),
            Some("https://s3.example.com/presigned/seg2")
        );
        assert!(url3.is_none(), "uncached key should return None");
    }

    #[tokio::test]
    async fn url_cache_consumes_entry_on_use() {
        let cache = PresignedUrlCache::new();
        {
            let mut urls = cache.urls.lock().await;
            urls.insert(
                "segments/video/init.mp4".to_string(),
                "https://s3.example.com/presigned/init".to_string(),
            );
        }

        let mut urls = cache.urls.lock().await;
        let first = urls.remove("segments/video/init.mp4");
        let second = urls.remove("segments/video/init.mp4");
        drop(urls);

        assert!(first.is_some(), "first access should hit cache");
        assert!(second.is_none(), "second access should miss (consumed)");
    }

    #[tokio::test]
    async fn semaphore_allows_six_concurrent_uploads() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
        let active = Arc::new(AtomicU32::new(0));
        let peak = Arc::new(AtomicU32::new(0));
        let completed = Arc::new(AtomicU32::new(0));

        let mut handles = Vec::new();
        for _ in 0..12 {
            let sem = semaphore.clone();
            let active = active.clone();
            let peak = peak.clone();
            let completed = completed.clone();
            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(current, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(50)).await;
                active.fetch_sub(1, Ordering::SeqCst);
                completed.fetch_add(1, Ordering::SeqCst);
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        assert_eq!(completed.load(Ordering::SeqCst), 12);
        assert_eq!(
            peak.load(Ordering::SeqCst),
            6,
            "peak concurrency should be 6"
        );
    }

    #[tokio::test]
    async fn file_read_runs_outside_semaphore() {
        let semaphore = Arc::new(tokio::sync::Semaphore::new(2));
        let dir = tempfile::tempdir().unwrap();

        let read_start_times = Arc::new(tokio::sync::Mutex::new(Vec::<Instant>::new()));
        let overall_start = Instant::now();

        let mut handles = Vec::new();
        for i in 0..6u32 {
            let path = dir.path().join(format!("seg_{i:03}.m4s"));
            std::fs::write(&path, format!("data for segment {i}")).unwrap();

            let sem = semaphore.clone();
            let times = read_start_times.clone();
            handles.push(tokio::spawn(async move {
                {
                    let mut t = times.lock().await;
                    t.push(Instant::now());
                }
                let _data = tokio::fs::read(&path).await.unwrap();

                let _permit = sem.acquire().await.unwrap();
                tokio::time::sleep(Duration::from_millis(100)).await;
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        let times = read_start_times.lock().await;
        let max_read_delay = times
            .iter()
            .map(|t| t.duration_since(overall_start))
            .max()
            .unwrap();

        assert!(
            max_read_delay < Duration::from_millis(50),
            "all file reads should start nearly immediately (not blocked by semaphore), max delay was {max_read_delay:?}"
        );
    }

    #[tokio::test]
    async fn manifest_debounce_reduces_upload_count() {
        let dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let notify = Arc::new(tokio::sync::Notify::new());
        let upload_count = Arc::new(AtomicU32::new(0));

        let manifest_handle = {
            let dirty = dirty.clone();
            let shutdown = shutdown.clone();
            let notify = notify.clone();
            let upload_count = upload_count.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(100));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {}
                        _ = notify.notified() => {}
                    }
                    if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        upload_count.fetch_add(1, Ordering::SeqCst);
                    }
                    if shutdown.load(std::sync::atomic::Ordering::Acquire) {
                        if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                            upload_count.fetch_add(1, Ordering::SeqCst);
                        }
                        break;
                    }
                }
            })
        };

        for _ in 0..20 {
            dirty.store(true, std::sync::atomic::Ordering::Release);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        tokio::time::sleep(Duration::from_millis(200)).await;

        shutdown.store(true, std::sync::atomic::Ordering::Release);
        dirty.store(true, std::sync::atomic::Ordering::Release);
        notify.notify_one();
        manifest_handle.await.unwrap();

        let count = upload_count.load(Ordering::SeqCst);
        assert!(
            count < 10,
            "debounce should batch 20 dirty flags into far fewer uploads, got {count}"
        );
        assert!(
            count >= 1,
            "should have uploaded manifest at least once, got {count}"
        );
    }

    #[tokio::test]
    async fn manifest_notify_wakes_immediately_on_shutdown() {
        let dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let notify = Arc::new(tokio::sync::Notify::new());
        let upload_count = Arc::new(AtomicU32::new(0));

        let manifest_handle = {
            let dirty = dirty.clone();
            let shutdown = shutdown.clone();
            let notify = notify.clone();
            let upload_count = upload_count.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(60));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {}
                        _ = notify.notified() => {}
                    }
                    if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        upload_count.fetch_add(1, Ordering::SeqCst);
                    }
                    if shutdown.load(std::sync::atomic::Ordering::Acquire) {
                        if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                            upload_count.fetch_add(1, Ordering::SeqCst);
                        }
                        break;
                    }
                }
            })
        };

        tokio::time::sleep(Duration::from_millis(50)).await;

        let start = Instant::now();
        shutdown.store(true, std::sync::atomic::Ordering::Release);
        dirty.store(true, std::sync::atomic::Ordering::Release);
        notify.notify_one();
        manifest_handle.await.unwrap();
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_millis(100),
            "notify should wake task immediately, not wait for interval. took {elapsed:?}"
        );
        assert_eq!(upload_count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn parallel_file_read_and_url_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("segment_001.m4s");
        std::fs::write(&path, vec![0u8; 4096]).unwrap();

        let start = Instant::now();
        let (file_result, url_result) = tokio::join!(
            async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                tokio::fs::read(&path).await
            },
            async {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Ok::<String, String>("https://s3.example.com/presigned".to_string())
            },
        );
        let elapsed = start.elapsed();

        assert!(file_result.is_ok());
        assert!(url_result.is_ok());
        assert!(
            elapsed < Duration::from_millis(180),
            "parallel operations (100ms each) should complete in ~100ms, not ~200ms. took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn new_architecture_faster_than_old() {
        let segment_count = 12u32;

        let old_start = Instant::now();
        {
            let semaphore = Arc::new(tokio::sync::Semaphore::new(3));
            let completed = Arc::new(AtomicU32::new(0));
            let mut in_flight = futures::stream::FuturesUnordered::new();

            for _ in 0..segment_count {
                let permit = semaphore.clone().acquire_owned().await.unwrap();
                let completed = completed.clone();
                in_flight.push(tokio::spawn(async move {
                    let _permit = permit;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    completed.fetch_add(1, Ordering::SeqCst);
                }));
            }

            use futures::StreamExt;
            while in_flight.next().await.is_some() {}
        }
        let old_duration = old_start.elapsed();

        let new_start = Instant::now();
        {
            let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
            let completed = Arc::new(AtomicU32::new(0));
            let manifest_uploads = Arc::new(AtomicU32::new(0));
            let mut in_flight = futures::stream::FuturesUnordered::new();

            for _ in 0..segment_count {
                let semaphore = semaphore.clone();
                let completed = completed.clone();
                let manifest_uploads = manifest_uploads.clone();
                in_flight.push(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(10)).await;

                    let _permit = semaphore.acquire_owned().await.unwrap();
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    drop(_permit);

                    completed.fetch_add(1, Ordering::SeqCst);
                    let _ = &manifest_uploads;
                }));
            }

            use futures::StreamExt;
            while in_flight.next().await.is_some() {}
        }
        let new_duration = new_start.elapsed();

        assert!(
            new_duration < old_duration,
            "new architecture ({new_duration:?}) should be faster than old ({old_duration:?})"
        );

        let speedup =
            old_duration.as_secs_f64() / new_duration.as_secs_f64().max(f64::MIN_POSITIVE);
        assert!(
            speedup > 1.5,
            "expected at least 1.5x speedup, got {speedup:.2}x (old={old_duration:?}, new={new_duration:?})"
        );
    }

    fn upload_state_with_video() -> SegmentUploadState {
        let mut state = SegmentUploadState::new();
        state.video_init_uploaded = true;
        state.uploaded_video_segments.insert(1, 3.0);
        state
    }

    #[tokio::test]
    async fn failed_required_segment_prevents_all_completion_side_effects() {
        use cap_enc_ffmpeg::segmented_stream::SegmentMediaType;

        for (media_type, is_init) in [
            (SegmentMediaType::Video, true),
            (SegmentMediaType::Video, false),
            (SegmentMediaType::Audio, true),
            (SegmentMediaType::Audio, false),
        ] {
            let mut state = upload_state_with_video();
            state.failed_segments.push(FailedSegmentInfo {
                subpath: "required segment".to_string(),
                file_path: PathBuf::from("required.m4s"),
                is_init,
                media_type,
                index: 2,
                duration: 3.0,
                expected_size: 7,
            });
            let state = Mutex::new(state);
            let published = AtomicUsize::new(0);
            let result = publish_completed_segments(&state, |_| async {
                published.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
            assert!(result.is_err());
            assert_eq!(published.load(Ordering::SeqCst), 0);
            assert_eq!(state.lock().unwrap().failed_segments.len(), 1);
        }
    }

    #[tokio::test]
    async fn successful_required_segment_retry_restores_completion() {
        let mut state = upload_state_with_video();
        state.failed_segments.push(FailedSegmentInfo {
            subpath: "segments/video/segment_002.m4s".to_string(),
            file_path: PathBuf::from("segment_002.m4s"),
            is_init: false,
            media_type: cap_enc_ffmpeg::segmented_stream::SegmentMediaType::Video,
            index: 2,
            duration: 3.0,
            expected_size: 7,
        });
        assert!(state.completed_manifest().is_err());
        state.uploaded_video_segments.insert(2, 3.0);
        state.failed_segments.clear();
        let published = AtomicUsize::new(0);
        let result = publish_completed_segments(&Mutex::new(state), |manifest| {
            assert!(manifest.is_complete);
            assert_eq!(manifest.video_segments.len(), 2);
            published.fetch_add(1, Ordering::SeqCst);
            async { Ok(()) }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(published.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn missing_video_and_publication_errors_do_not_become_success() {
        let result: Result<(), AuthedApiError> =
            publish_completed_segments(&Mutex::new(SegmentUploadState::new()), |_| async {
                panic!("an empty upload must not publish")
            })
            .await;
        assert!(result.is_err());

        let result: Result<(), AuthedApiError> =
            publish_completed_segments(&Mutex::new(upload_state_with_video()), |_| async {
                Err("injected manifest failure".into())
            })
            .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("injected manifest failure")
        );
    }

    #[tokio::test]
    async fn panicked_and_cancelled_upload_workers_block_completion() {
        for cancel in [false, true] {
            let task: tokio::task::JoinHandle<Result<(), AuthedApiError>> = if cancel {
                let task = tokio::spawn(std::future::pending());
                task.abort();
                task
            } else {
                tokio::spawn(async { panic!("injected segment worker panic") })
            };
            let mut state = upload_state_with_video();
            state.record_task_result(task.await);
            let result: Result<(), AuthedApiError> =
                publish_completed_segments(&Mutex::new(state), |_| async {
                    panic!("a failed worker must not publish")
                })
                .await;
            assert!(result.is_err());
        }
    }

    #[tokio::test]
    async fn failed_upload_worker_does_not_skip_joining_other_owned_work() {
        let state = Mutex::new(upload_state_with_video());
        let mut tasks = SegmentUploadTasks::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        tasks.push(tokio::spawn(async {
            Err("injected upload failure".into())
        }));
        tasks.push(tokio::spawn(async move {
            entered_tx.send(()).unwrap();
            release_rx.await.unwrap();
            Ok(())
        }));
        entered_rx.await.unwrap();
        let mut drain = Box::pin(drain_segment_upload_tasks(&state, &mut tasks));
        assert!(futures::poll!(&mut drain).is_pending());
        release_tx.send(()).unwrap();
        drain.await;
        assert!(tasks.is_empty());
        let result: Result<(), AuthedApiError> = publish_completed_segments(&state, |_| async {
            panic!("a failed upload must not publish after its workers are joined")
        })
        .await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn optional_prefetch_panic_does_not_block_successful_media_completion() {
        let mut tasks = futures::stream::FuturesUnordered::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        tasks.push(tokio::spawn(async move {
            entered_tx.send(()).unwrap();
            panic!("injected optional URL prefetch panic");
        }));
        entered_rx.await.unwrap();
        assert!(tasks.iter().all(tokio::task::JoinHandle::is_finished));
        cancel_segment_prefetch_tasks(&mut tasks).await;
        assert!(tasks.is_empty());

        let published = AtomicUsize::new(0);
        let result =
            publish_completed_segments(&Mutex::new(upload_state_with_video()), |_| async {
                published.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        assert!(result.is_ok());
        assert_eq!(published.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn upload_state_manifest_generation() {
        let state = SegmentUploadState::new();
        let manifest = state.to_manifest();
        assert!(!manifest.is_complete);
        assert!(!manifest.video_init_uploaded);
        assert!(!manifest.audio_init_uploaded);
        assert!(manifest.video_segments.is_empty());
        assert!(manifest.audio_segments.is_empty());
    }

    #[tokio::test]
    async fn upload_state_tracks_segments() {
        let mut state = SegmentUploadState::new();
        state.video_init_uploaded = true;
        state.audio_init_uploaded = true;
        state.uploaded_video_segments.insert(1, 3.0);
        state.uploaded_video_segments.insert(2, 3.0);
        state.uploaded_audio_segments.insert(1, 3.0);

        let manifest = state.to_manifest();
        assert!(manifest.video_init_uploaded);
        assert!(manifest.audio_init_uploaded);
        assert_eq!(manifest.video_segments.len(), 2);
        assert_eq!(manifest.audio_segments.len(), 1);
        assert!(!manifest.is_complete);

        let complete = state.to_complete_manifest();
        assert!(complete.is_complete);
        assert_eq!(complete.video_segments.len(), 2);
        assert!(complete.has_video_content());
    }

    #[tokio::test]
    async fn upload_state_without_video_segments_has_no_video_content() {
        let mut state = SegmentUploadState::new();
        state.video_init_uploaded = true;
        state.audio_init_uploaded = true;

        let complete = state.to_complete_manifest();
        assert!(complete.is_complete);
        assert!(!complete.has_video_content());
    }

    #[tokio::test]
    async fn end_to_end_pipeline_simulation() {
        let segment_count = 10u32;
        let semaphore = Arc::new(tokio::sync::Semaphore::new(6));
        let state = Arc::new(Mutex::new(SegmentUploadState::new()));
        let manifest_dirty = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let manifest_shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let manifest_notify = Arc::new(tokio::sync::Notify::new());
        let manifest_upload_count = Arc::new(AtomicU32::new(0));

        let manifest_handle = {
            let dirty = manifest_dirty.clone();
            let shutdown = manifest_shutdown.clone();
            let notify = manifest_notify.clone();
            let count = manifest_upload_count.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(100));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    tokio::select! {
                        _ = interval.tick() => {}
                        _ = notify.notified() => {}
                    }
                    if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        count.fetch_add(1, Ordering::SeqCst);
                    }
                    if shutdown.load(std::sync::atomic::Ordering::Acquire) {
                        if dirty.swap(false, std::sync::atomic::Ordering::AcqRel) {
                            count.fetch_add(1, Ordering::SeqCst);
                        }
                        break;
                    }
                }
            })
        };

        let dir = tempfile::tempdir().unwrap();
        let start = Instant::now();
        let mut handles = Vec::new();

        for i in 0..segment_count {
            let path = dir.path().join(format!("segment_{i:03}.m4s"));
            std::fs::write(&path, vec![0u8; 1024]).unwrap();

            let sem = semaphore.clone();
            let st = state.clone();
            let dirty = manifest_dirty.clone();
            let mn = manifest_notify.clone();
            handles.push(tokio::spawn(async move {
                let (_data, _url) = tokio::join!(tokio::fs::read(&path), async {
                    Ok::<_, ()>("https://example.com/presigned")
                },);

                let _permit = sem.acquire_owned().await.unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
                drop(_permit);

                {
                    let mut s = st.lock().unwrap_or_else(|e| e.into_inner());
                    s.uploaded_video_segments.insert(i, 3.0);
                    s.total_bytes_uploaded += 1024;
                }
                dirty.store(true, std::sync::atomic::Ordering::Release);
                mn.notify_one();
            }));
        }

        for h in handles {
            h.await.unwrap();
        }

        let upload_duration = start.elapsed();

        let shutdown_start = Instant::now();
        manifest_shutdown.store(true, std::sync::atomic::Ordering::Release);
        manifest_dirty.store(true, std::sync::atomic::Ordering::Release);
        manifest_notify.notify_one();
        manifest_handle.await.unwrap();
        let shutdown_duration = shutdown_start.elapsed();

        let manifest_count = manifest_upload_count.load(Ordering::SeqCst);
        let final_state = state.lock().unwrap();

        assert_eq!(
            final_state.uploaded_video_segments.len(),
            segment_count as usize,
            "all segments should be tracked"
        );
        assert_eq!(
            final_state.total_bytes_uploaded,
            segment_count as u64 * 1024
        );
        assert!(
            manifest_count < segment_count,
            "manifest uploads ({manifest_count}) should be fewer than segment count ({segment_count})"
        );
        assert!(
            manifest_count >= 1,
            "at least one manifest upload should happen"
        );

        let per_segment_ms = upload_duration.as_millis() as f64 / segment_count as f64;
        assert!(
            per_segment_ms < 40.0,
            "with concurrency 6, per-segment time should be well under 50ms, got {per_segment_ms:.1}ms"
        );

        assert!(
            shutdown_duration < Duration::from_millis(200),
            "manifest shutdown should be near-instant via Notify, took {shutdown_duration:?}"
        );
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod strict_instant {
    use super::*;
    use cap_enc_ffmpeg::segmented_stream::{SegmentCompletedEvent, SegmentMediaType};
    use futures::{FutureExt as _, stream::FuturesUnordered};
    use std::{future::Future, panic::AssertUnwindSafe, sync::atomic::AtomicBool};

    #[derive(Clone)]
    pub struct Control(Arc<ControlInner>);

    struct ControlInner {
        decision: tokio::sync::watch::Sender<u8>,
        cleanup: tokio::sync::watch::Sender<Option<bool>>,
    }

    pub struct Permission {
        control: Control,
        granted: bool,
    }

    impl Control {
        pub fn new() -> (Self, Permission) {
            let (decision, _) = tokio::sync::watch::channel(0);
            let (cleanup, _) = tokio::sync::watch::channel(None);
            let control = Self(Arc::new(ControlInner { decision, cleanup }));
            (
                control.clone(),
                Permission {
                    control,
                    granted: false,
                },
            )
        }

        pub fn deny(&self) {
            self.0.decision.send_replace(2);
        }

        pub fn check(&self) -> Result<(), AuthedApiError> {
            if *self.0.decision.borrow() == 2 {
                Err("Instant upload authorization revoked".to_string().into())
            } else {
                Ok(())
            }
        }

        pub async fn step<T, F>(&self, step: impl FnOnce() -> F) -> Result<T, AuthedApiError>
        where
            F: Future<Output = Result<T, AuthedApiError>>,
        {
            self.check()?;
            let result = step().await;
            self.check()?;
            result
        }

        async fn complete<T, F>(&self, complete: impl FnOnce() -> F) -> Result<(), AuthedApiError>
        where
            F: Future<Output = Result<T, AuthedApiError>>,
        {
            self.step(complete).await.map(drop)
        }

        async fn permission(&self) -> Result<(), AuthedApiError> {
            let mut decision = self.0.decision.subscribe();
            loop {
                let value = *decision.borrow_and_update();
                match value {
                    1 => return self.check(),
                    2 => return Err("Instant completion was denied".to_string().into()),
                    _ => decision
                        .changed()
                        .await
                        .map_err(|_| "Instant authorization owner lost")?,
                }
            }
        }

        async fn cancelled(&self) {
            let mut decision = self.0.decision.subscribe();
            loop {
                if *decision.borrow_and_update() == 2 {
                    return;
                }
                if decision.changed().await.is_err() {
                    return;
                }
            }
        }

        pub async fn joined(&self) -> bool {
            let mut cleanup = self.0.cleanup.subscribe();
            loop {
                let state = *cleanup.borrow_and_update();
                if let Some(joined) = state {
                    return joined;
                }
                if cleanup.changed().await.is_err() {
                    return false;
                }
            }
        }
    }

    impl Permission {
        pub fn grant(mut self) -> Result<(), AuthedApiError> {
            let changed = self.control.0.decision.send_if_modified(|state| {
                if *state != 0 {
                    return false;
                }
                *state = 1;
                true
            });
            if !changed {
                return Err("Instant completion permission is no longer valid"
                    .to_string()
                    .into());
            }
            self.granted = true;
            self.control.check()
        }
    }

    impl Drop for Permission {
        fn drop(&mut self) {
            if !self.granted {
                self.control.deny();
            }
        }
    }

    struct WorkerGuard(Control);
    impl Drop for WorkerGuard {
        fn drop(&mut self) {
            let missing = self.0.0.cleanup.borrow().is_none();
            if missing {
                self.0.deny();
                let _ = self.0.0.cleanup.send_replace(Some(false));
            }
        }
    }

    struct Bridge {
        events: tokio::sync::mpsc::Receiver<SegmentCompletedEvent>,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl Bridge {
        fn new(
            source: std::sync::mpsc::Receiver<SegmentCompletedEvent>,
        ) -> Result<Self, AuthedApiError> {
            let (sender, events) = tokio::sync::mpsc::channel(12);
            let stop = Arc::new(AtomicBool::new(false));
            let stop_thread = stop.clone();
            let thread = std::thread::Builder::new()
                .name("strict-instant-events".into())
                .spawn(move || {
                    while !stop_thread.load(Ordering::Acquire) {
                        match source.recv_timeout(Duration::from_millis(100)) {
                            Ok(event) => {
                                if sender.blocking_send(event).is_err() {
                                    break;
                                }
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }
                })
                .map_err(|error| format!("Starting owned Instant event bridge: {error}"))?;
            Ok(Self {
                events,
                stop,
                thread: Some(thread),
            })
        }

        async fn finish(mut self) -> bool {
            self.events.close();
            self.stop.store(true, Ordering::Release);
            let thread = self.thread.take().unwrap();
            tokio::task::spawn_blocking(move || thread.join().is_ok())
                .await
                .unwrap_or(false)
        }
    }

    impl Drop for Bridge {
        fn drop(&mut self) {
            self.events.close();
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                drop(tokio::task::spawn_blocking(move || thread.join()));
            }
        }
    }

    trait Transport: Send + Sync {
        fn put(
            &self,
            path: &str,
            bytes: Bytes,
        ) -> impl Future<Output = Result<(), AuthedApiError>> + Send;
        fn complete(&self) -> impl Future<Output = Result<(), AuthedApiError>> + Send;
    }

    struct LiveTransport<'a> {
        app: &'a AppHandle,
        video_id: &'a str,
        control: &'a Control,
    }

    impl Transport for LiveTransport<'_> {
        async fn put(&self, path: &str, bytes: Bytes) -> Result<(), AuthedApiError> {
            let mut failure = None;
            for attempt in 0..3 {
                if attempt > 0 {
                    self.control
                        .step(|| async {
                            tokio::time::sleep(Duration::from_millis(500u64 << (attempt - 1)))
                                .await;
                            Ok(())
                        })
                        .await?;
                }
                let target = self
                    .control
                    .step(|| {
                        api::upload_signed(
                            self.app,
                            PresignedS3PutRequest {
                                video_id: self.video_id.into(),
                                subpath: path.into(),
                                method: PresignedS3PutRequestMethod::Put,
                                meta: None,
                            },
                        )
                    })
                    .await?;
                let size = bytes.len() as u64;
                let mut request = self
                    .app
                    .state::<HttpClient>()
                    .put(&target.url)
                    .header("Content-Length", size)
                    .header("Content-Type", content_type_for_upload_subpath(path))
                    .timeout(Duration::from_secs(5 * 60))
                    .body(bytes.clone());
                for (name, value) in target.headers {
                    if !name.eq_ignore_ascii_case("content-length") {
                        request = request.header(name, value);
                    }
                }
                let result = self
                    .control
                    .step(|| async {
                        let response =
                            with_drive_content_range(request, &target.url, 0, size, size)
                                .send()
                                .await
                                .map_err(AuthedApiError::from)?;
                        if !response.status().is_success() {
                            return Err(format!("Instant PUT failed: {}", response.status()).into());
                        }
                        Ok(())
                    })
                    .await;
                match result {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        let network = matches!(&error, AuthedApiError::Timeout)
                            || matches!(&error, AuthedApiError::Request(error) if is_reqwest_network_error(error));
                        failure = Some(error);
                        self.control.check()?;
                        if network && attempt < 2 {
                            network_recovery(self.app, self.control).await?;
                        }
                    }
                }
                self.control.check()?;
            }
            Err(failure.unwrap())
        }

        async fn complete(&self) -> Result<(), AuthedApiError> {
            let mut failure = None;
            for attempt in 0..3 {
                if attempt > 0 {
                    self.control
                        .step(|| async {
                            tokio::time::sleep(Duration::from_millis(1000u64 << (attempt - 1)))
                                .await;
                            Ok(())
                        })
                        .await?;
                }
                match self
                    .control
                    .step(|| api::signal_recording_complete(self.app, self.video_id))
                    .await
                {
                    Ok(()) => return Ok(()),
                    Err(error) => failure = Some(error),
                }
                self.control.check()?;
            }
            Err(failure.unwrap())
        }
    }

    fn event_path(event: &SegmentCompletedEvent) -> String {
        let media = match event.media_type {
            SegmentMediaType::Video => "video",
            SegmentMediaType::Audio => "audio",
        };
        if event.is_init {
            format!("segments/{media}/init.mp4")
        } else {
            format!("segments/{media}/segment_{:03}.m4s", event.index)
        }
    }

    async fn segment(
        transport: &impl Transport,
        control: &Control,
        event: SegmentCompletedEvent,
    ) -> Result<SegmentCompletedEvent, AuthedApiError> {
        control.check()?;
        let path = event_path(&event);
        let bytes = control
            .step(|| SegmentUploader::read_segment_data(&event.path, &path, event.file_size))
            .await?;
        if bytes.is_empty() || (event.file_size > 0 && (bytes.len() as u64) < event.file_size) {
            return Err(format!("Required Instant segment is incomplete: {path}").into());
        }
        control.step(|| transport.put(&path, bytes)).await?;
        Ok(event)
    }

    async fn segments(
        transport: &impl Transport,
        control: &Control,
        events: &mut tokio::sync::mpsc::Receiver<SegmentCompletedEvent>,
        required_audio: bool,
    ) -> Result<(), AuthedApiError> {
        let mut uploads = FuturesUnordered::new();
        let mut state = SegmentUploadState::new();
        let mut closed = false;
        let mut failure = None;
        let mut manifest_at = Instant::now();
        while !closed || !uploads.is_empty() {
            tokio::select! {
                _ = control.cancelled(), if failure.is_none() => { failure = Some("Instant upload cancelled".to_string().into()); closed = true; events.close(); }
                event = events.recv(), if !closed && uploads.len() < 6 => {
                    match event { Some(event) => uploads.push(segment(transport, control, event)), None => closed = true }
                }
                Some(result) = uploads.next(), if !uploads.is_empty() => {
                    match result {
                        Ok(event) => {
                            match (event.is_init, event.media_type) {
                                (true, SegmentMediaType::Video) => state.video_init_uploaded = true,
                                (true, SegmentMediaType::Audio) => state.audio_init_uploaded = true,
                                (false, SegmentMediaType::Video) => { let _ = state.uploaded_video_segments.insert(event.index, event.duration); }
                                (false, SegmentMediaType::Audio) => { let _ = state.uploaded_audio_segments.insert(event.index, event.duration); }
                            }
                            if failure.is_none() && manifest_at.elapsed() >= Duration::from_secs(1) {
                                let manifest = serde_json::to_vec(&state.to_manifest()).map_err(|error| error.to_string());
                                let result = match manifest { Ok(bytes) => control.step(|| transport.put("segments/manifest.json", bytes.into())).await, Err(error) => Err(error.into()) };
                                if let Err(error) = result { failure = Some(error); closed = true; events.close(); }
                                manifest_at = Instant::now();
                            }
                        }
                        Err(error) => { failure = Some(error); closed = true; events.close(); }
                    }
                }
            }
            if failure.is_some() {
                control.deny();
                closed = true;
                events.close();
            }
        }
        if let Some(error) = failure {
            return Err(error);
        }
        control.permission().await?;
        let manifest = state.to_complete_manifest();
        if !manifest.has_video_content()
            || (required_audio
                && (!state.audio_init_uploaded || state.uploaded_audio_segments.is_empty()))
        {
            return Err("Required Instant media track is missing".to_string().into());
        }
        let bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
        control
            .step(|| transport.put("segments/manifest.json", bytes.into()))
            .await?;
        control.step(|| transport.complete()).await
    }

    pub fn spawn(
        app: AppHandle,
        recording_dir: PathBuf,
        video: VideoUploadInfo,
        events: Option<std::sync::mpsc::Receiver<SegmentCompletedEvent>>,
        control: Control,
        required_audio: bool,
    ) -> SegmentUploader {
        SegmentUploader {
            handle: spawn_actor(async move {
                let _owner = WorkerGuard(control.clone());
                let _active = ActiveUploadGuard::new(&ACTIVE_UPLOADS);
                let result = if let Some(events) = events {
                    match Bridge::new(events) {
                        Ok(mut bridge) => {
                            let transport = LiveTransport {
                                app: &app,
                                video_id: &video.id,
                                control: &control,
                            };
                            let result = AssertUnwindSafe(segments(
                                &transport,
                                &control,
                                &mut bridge.events,
                                required_audio,
                            ))
                            .catch_unwind()
                            .await;
                            let joined = bridge.finish().await;
                            let _ = control
                                .0
                                .cleanup
                                .send_replace(Some(joined && result.is_ok()));
                            match result {
                                Ok(result) if joined => result,
                                _ => {
                                    Err("Instant upload cleanup is unconfirmed".to_string().into())
                                }
                            }
                        }
                        Err(error) => {
                            let _ = control.0.cleanup.send_replace(Some(true));
                            Err(error)
                        }
                    }
                } else {
                    let result =
                        AssertUnwindSafe(multipart(&app, &recording_dir, &video, &control))
                            .catch_unwind()
                            .await;
                    let _ = control.0.cleanup.send_replace(Some(result.is_ok()));
                    result.unwrap_or_else(|_| {
                        Err("Instant multipart cleanup is unconfirmed"
                            .to_string()
                            .into())
                    })
                };
                if result.is_err() {
                    control.deny();
                }
                result
            }),
        }
    }

    async fn network_recovery(app: &AppHandle, control: &Control) -> Result<(), AuthedApiError> {
        let started = Instant::now();
        let mut delay = CONNECTIVITY_PROBE_INITIAL_DELAY;
        while started.elapsed() <= NETWORK_RECOVERY_TIMEOUT {
            control
                .step(|| async {
                    tokio::time::sleep(delay).await;
                    Ok(())
                })
                .await?;
            if control
                .step(|| async { Ok(probe_connectivity(app).await) })
                .await?
            {
                return Ok(());
            }
            delay = (delay * 2).min(CONNECTIVITY_PROBE_MAX_DELAY);
        }
        Err("Instant upload network recovery timed out"
            .to_string()
            .into())
    }

    struct MultipartTarget<'a> {
        app: &'a AppHandle,
        video_id: &'a str,
        upload_id: &'a str,
        control: &'a Control,
        use_md5: bool,
    }

    async fn part(
        target: &MultipartTarget<'_>,
        chunk: Chunk,
    ) -> Result<UploadedPart, AuthedApiError> {
        let size = chunk.chunk.len();
        let md5_sum = target
            .use_md5
            .then(|| base64::encode(md5::compute(&chunk.chunk).0));
        for attempt in 0..2 {
            let url = target
                .control
                .step(|| {
                    api::upload_multipart_presign_part(
                        target.app,
                        target.video_id,
                        target.upload_id,
                        chunk.part_number,
                        md5_sum.as_deref(),
                    )
                })
                .await?;
            let mut request = target
                .app
                .state::<HttpClient>()
                .put(&url)
                .header("Content-Length", size)
                .timeout(Duration::from_secs(5 * 60))
                .body(chunk.chunk.clone());
            if let Some(md5_sum) = &md5_sum {
                request = request.header("Content-MD5", md5_sum);
            }
            let request = with_drive_content_range(
                request,
                &url,
                chunk.offset,
                size as u64,
                chunk.total_size,
            );
            let sent = target
                .control
                .step(|| async { Ok(request.send().await) })
                .await?;
            let response = match sent {
                Ok(response) => response,
                Err(error) if attempt == 0 && is_reqwest_network_error(&error) => {
                    network_recovery(target.app, target.control).await?;
                    continue;
                }
                Err(error) => return Err(error.to_string().into()),
            };
            if !is_upload_response_accepted(
                &url,
                response.status(),
                chunk.offset,
                size as u64,
                chunk.total_size,
            ) {
                return Err(format!("Instant multipart part failed: {}", response.status()).into());
            }
            let etag = response
                .headers()
                .get("ETag")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.trim_matches('"').to_string())
                .or_else(|| {
                    is_google_drive_resumable_url(&url)
                        .then(|| format!("drive-{}", chunk.part_number))
                })
                .ok_or_else(|| {
                    format!(
                        "Instant multipart part {} is missing ETag",
                        chunk.part_number
                    )
                })?;
            target.control.check()?;
            return Ok(UploadedPart {
                part_number: chunk.part_number,
                etag,
                size,
                total_size: chunk.total_size,
            });
        }
        Err("Instant multipart retries exhausted".to_string().into())
    }

    async fn multipart(
        app: &AppHandle,
        directory: &Path,
        video: &VideoUploadInfo,
        control: &Control,
    ) -> Result<(), AuthedApiError> {
        let upload = control
            .step(|| api::upload_multipart_initiate(app, &video.id))
            .await?;
        let concurrency = if is_google_drive_upload(upload.provider.as_deref(), &upload.upload_id) {
            1
        } else {
            5
        };
        let target = MultipartTarget {
            app,
            video_id: &video.id,
            upload_id: &upload.upload_id,
            control,
            use_md5: app.is_server_url_custom().await,
        };
        let path = directory.join("content/output.mp4");
        let stream = strict_chunks(path.clone(), control.clone());
        let parts = transfer_parts(&path, stream, &target, control, concurrency).await?;
        let metadata = tokio::task::spawn_blocking(move || build_video_meta(&path))
            .await
            .map_err(|error| error.to_string())??;
        control
            .complete(|| {
                api::upload_multipart_complete(
                    app,
                    &video.id,
                    &upload.upload_id,
                    &parts,
                    Some(metadata),
                )
            })
            .await
    }

    fn strict_chunks(path: PathBuf, control: Control) -> impl Stream<Item = io::Result<Chunk>> {
        try_stream! {
            let started = Instant::now();
            let mut file = loop {
                control.check().map_err(io::Error::other)?;
                let opened = File::open(&path).await;
                control.check().map_err(io::Error::other)?;
                match opened {
                    Ok(file) => break file,
                    Err(error) if started.elapsed() >= Duration::from_secs(20) => Err(error)?,
                    Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
                }
            };
            let mut offset = 0u64;
            let mut number = 1;
            let mut first_size = None;
            let mut buffer = vec![0; MAX_CHUNK_SIZE as usize];
            loop {
                control.check().map_err(io::Error::other)?;
                let done = *control.0.decision.borrow() == 1;
                let size = file.metadata().await?.len();
                control.check().map_err(io::Error::other)?;
                let available = size.saturating_sub(offset);
                if available >= MIN_CHUNK_SIZE || (done && available > 0) {
                    let count = available.min(MAX_CHUNK_SIZE) as usize;
                    file.seek(std::io::SeekFrom::Start(offset)).await?;
                    control.check().map_err(io::Error::other)?;
                    file.read_exact(&mut buffer[..count]).await?;
                    control.check().map_err(io::Error::other)?;
                    if offset == 0 { first_size = Some(count); }
                    yield Chunk { total_size: size, part_number: number, offset, chunk: Bytes::copy_from_slice(&buffer[..count]) };
                    offset += count as u64; number += 1;
                } else if done && available == 0 {
                    if let Some(count) = first_size {
                        file.seek(std::io::SeekFrom::Start(0)).await?;
                        control.check().map_err(io::Error::other)?;
                        file.read_exact(&mut buffer[..count]).await?;
                        control.check().map_err(io::Error::other)?;
                        yield Chunk { total_size: size, part_number: 1, offset: 0, chunk: Bytes::copy_from_slice(&buffer[..count]) };
                    }
                    break;
                } else {
                    tokio::select! { _ = tokio::time::sleep(Duration::from_millis(100)) => {}, _ = control.cancelled() => {} }
                }
            }
        }
    }

    trait PartTransport: Send + Sync {
        fn send(
            &self,
            chunk: Chunk,
        ) -> impl Future<Output = Result<UploadedPart, AuthedApiError>> + Send;
    }
    impl PartTransport for MultipartTarget<'_> {
        async fn send(&self, chunk: Chunk) -> Result<UploadedPart, AuthedApiError> {
            part(self, chunk).await
        }
    }

    async fn transfer_parts(
        path: &Path,
        stream: impl Stream<Item = io::Result<Chunk>>,
        transport: &impl PartTransport,
        control: &Control,
        concurrency: usize,
    ) -> Result<Vec<UploadedPart>, AuthedApiError> {
        let mut chunks = Box::pin(stream);
        let mut pending = futures::stream::FuturesOrdered::new();
        let mut parts = Vec::new();
        let mut failed = Vec::new();
        let mut failure = None;
        let mut closed = false;
        while !closed || !pending.is_empty() {
            tokio::select! {
                _ = control.cancelled(), if failure.is_none() => { failure = Some("Instant multipart cancelled".to_string().into()); }
                chunk = chunks.next(), if !closed && pending.len() < concurrency && failure.is_none() => {
                    match chunk {
                        Some(Ok(chunk)) => {
                            let info = FailedChunkInfo { part_number: chunk.part_number, offset: chunk.offset, chunk_size: chunk.chunk.len(), total_size: chunk.total_size, error: String::new() };
                            let target = transport;
                            pending.push_back(async move { (info, control.step(|| target.send(chunk)).await) });
                        }
                        Some(Err(error)) => { failure = Some(error.to_string().into()); closed = true; }
                        None => closed = true,
                    }
                }
                Some((info, result)) = pending.next(), if !pending.is_empty() => {
                    match result { Ok(part) => parts.push(part), Err(error) => { failed.push(info); if control.check().is_err() { failure = Some(error); } } }
                }
            }
            if failure.is_some() {
                control.deny();
                if !closed {
                    let _ = chunks.next().await;
                }
                closed = true;
            }
        }
        drop(chunks);
        if let Some(error) = failure {
            return Err(error);
        }
        control.permission().await?;
        for info in failed {
            control.check()?;
            let mut file = File::open(path).await.map_err(|error| error.to_string())?;
            control.check()?;
            file.seek(std::io::SeekFrom::Start(info.offset))
                .await
                .map_err(|error| error.to_string())?;
            control.check()?;
            let mut bytes = vec![0; info.chunk_size];
            file.read_exact(&mut bytes)
                .await
                .map_err(|error| error.to_string())?;
            control.check()?;
            parts.push(
                control
                    .step(|| {
                        transport.send(Chunk {
                            part_number: info.part_number,
                            offset: info.offset,
                            total_size: info.total_size,
                            chunk: bytes.into(),
                        })
                    })
                    .await?,
            );
        }
        let mut deduplicated = HashMap::new();
        for part in parts {
            let _ = deduplicated.insert(part.part_number, part);
        }
        let mut parts: Vec<_> = deduplicated.into_values().collect();
        parts.sort_by_key(|part| part.part_number);
        if parts.is_empty()
            || parts
                .iter()
                .enumerate()
                .any(|(index, part)| part.part_number as usize != index + 1 || part.size == 0)
        {
            return Err("Required Instant multipart data is incomplete"
                .to_string()
                .into());
        }
        Ok(parts)
    }

    pub async fn upload_thumbnail(
        app: &AppHandle,
        video_id: &str,
        bytes: Vec<u8>,
        control: &Control,
    ) -> Result<(), AuthedApiError> {
        let transport = LiveTransport {
            app,
            video_id,
            control,
        };
        control
            .step(|| transport.put("screenshot/screen-capture.jpg", bytes.into()))
            .await
    }

    pub fn resume(
        app: AppHandle,
        directory: PathBuf,
        video: VideoUploadInfo,
        events: Option<std::sync::mpsc::Receiver<SegmentCompletedEvent>>,
        required_audio: bool,
    ) {
        let (control, permission) = Control::new();
        if permission.grant().is_err() {
            return;
        }
        let upload = spawn(
            app.clone(),
            directory.clone(),
            video.clone(),
            events,
            control.clone(),
            required_audio,
        );
        drop(tauri::async_runtime::spawn(async move {
            let result = upload.handle.await;
            if matches!(result, Ok(Ok(()))) && control.joined().await && control.check().is_ok() {
                let result = (|| -> Result<(), String> {
                    let mut meta = RecordingMeta::load_for_project(&directory)
                        .map_err(|error| error.to_string())?;
                    control.check().map_err(|error| error.to_string())?;
                    meta.upload = Some(UploadMeta::Complete);
                    meta.save_for_project().map_err(|error| error.to_string())?;
                    control.check().map_err(|error| error.to_string())
                })();
                if let Err(error) = result {
                    error!(%error, "Resumed Instant upload local completion failed");
                }
            }
            emit_upload_complete(&app, &video.id);
        }));
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[derive(Default)]
        struct FakeTransport {
            calls: Mutex<Vec<String>>,
            fail_audio: AtomicBool,
            delay_complete: AtomicBool,
            entered: tokio::sync::Notify,
            released: tokio::sync::Notify,
        }
        impl Transport for FakeTransport {
            async fn put(&self, path: &str, _: Bytes) -> Result<(), AuthedApiError> {
                self.calls.lock().unwrap().push(path.into());
                if self.fail_audio.load(Ordering::Acquire) && path.starts_with("segments/audio/") {
                    return Err("required audio upload failed".into());
                }
                Ok(())
            }
            async fn complete(&self) -> Result<(), AuthedApiError> {
                self.calls.lock().unwrap().push("Complete".into());
                if self.delay_complete.load(Ordering::Acquire) {
                    self.entered.notify_one();
                    self.released.notified().await;
                }
                Ok(())
            }
        }
        fn directory(tag: &str) -> PathBuf {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "cap-strict-upload-{tag}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::AcqRel)
            ));
            std::fs::create_dir_all(&path).unwrap();
            path
        }
        fn event(path: PathBuf, audio: bool, init: bool) -> SegmentCompletedEvent {
            SegmentCompletedEvent {
                path,
                index: u32::from(!init),
                duration: if init { 0.0 } else { 1.0 },
                file_size: 4,
                is_init: init,
                media_type: if audio {
                    SegmentMediaType::Audio
                } else {
                    SegmentMediaType::Video
                },
            }
        }
        fn events(path: &Path, audio: bool) -> tokio::sync::mpsc::Receiver<SegmentCompletedEvent> {
            let file = path.join("synthetic-bytes");
            std::fs::write(&file, b"test").unwrap();
            let (sender, receiver) = tokio::sync::mpsc::channel(12);
            for init in [true, false] {
                sender.try_send(event(file.clone(), false, init)).unwrap();
                if audio {
                    sender.try_send(event(file.clone(), true, init)).unwrap();
                }
            }
            receiver
        }
        #[tokio::test]
        async fn strict_segment_eof_waits_for_owned_permission() {
            let dir = directory("eof");
            let transport = FakeTransport::default();
            let (control, permission) = Control::new();
            let mut source = events(&dir, false);
            let future = segments(&transport, &control, &mut source, false);
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            assert!(
                !transport
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|value| value == "Complete")
            );
            permission.grant().unwrap();
            future.await.unwrap();
            assert!(
                transport
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|value| value == "Complete")
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
        #[tokio::test]
        async fn strict_required_audio_failure_or_absence_never_completes() {
            for present in [false, true] {
                let dir = directory("audio");
                let transport = FakeTransport::default();
                transport.fail_audio.store(present, Ordering::Release);
                let (control, permission) = Control::new();
                permission.grant().unwrap();
                let mut source = events(&dir, present);
                assert!(
                    segments(&transport, &control, &mut source, true)
                        .await
                        .is_err()
                );
                assert!(
                    !transport
                        .calls
                        .lock()
                        .unwrap()
                        .iter()
                        .any(|value| value == "Complete")
                );
                std::fs::remove_dir_all(&dir).unwrap();
            }
        }
        #[tokio::test]
        async fn strict_complete_inflight_revocation_rejects_late_success() {
            let dir = directory("late-complete");
            let transport = FakeTransport::default();
            transport.delay_complete.store(true, Ordering::Release);
            let (control, permission) = Control::new();
            permission.grant().unwrap();
            let mut source = events(&dir, false);
            let future = segments(&transport, &control, &mut source, false);
            tokio::pin!(future);
            tokio::select! { _ = transport.entered.notified() => {}, result = &mut future => panic!("Unexpected completion: {result:?}") }
            control.deny();
            transport.released.notify_one();
            assert!(future.await.is_err());
            assert_eq!(
                transport
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|value| *value == "Complete")
                    .count(),
                1
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
        #[tokio::test]
        async fn strict_permission_drop_and_old_generation_cannot_complete() {
            let dir = directory("owner-drop");
            let transport = FakeTransport::default();
            let (old, old_permission) = Control::new();
            old.deny();
            assert!(old_permission.grant().is_err());
            let (control, permission) = Control::new();
            let mut source = events(&dir, false);
            let future = segments(&transport, &control, &mut source, false);
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            drop(permission);
            assert!(future.await.is_err());
            assert!(
                !transport
                    .calls
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|value| value == "Complete")
            );
            std::fs::remove_dir_all(&dir).unwrap();
        }
        #[tokio::test]
        async fn owned_bridge_closes_full_queue_before_actual_thread_join() {
            let (sender, receiver) = std::sync::mpsc::channel();
            for _ in 0..30 {
                sender
                    .send(event(PathBuf::from("unused"), false, false))
                    .unwrap();
            }
            let bridge = Bridge::new(receiver).unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
            assert!(
                tokio::time::timeout(Duration::from_secs(1), bridge.finish())
                    .await
                    .unwrap()
            );
            assert!(
                sender
                    .send(event(PathBuf::from("unused"), false, false))
                    .is_err()
            );
        }
        #[derive(Default)]
        struct FakeParts {
            entered: tokio::sync::Notify,
            released: tokio::sync::Notify,
            delayed: AtomicBool,
            calls: AtomicUsize,
        }
        impl PartTransport for FakeParts {
            async fn send(&self, chunk: Chunk) -> Result<UploadedPart, AuthedApiError> {
                self.calls.fetch_add(1, Ordering::AcqRel);
                if self.delayed.load(Ordering::Acquire) {
                    self.entered.notify_one();
                    self.released.notified().await;
                }
                Ok(UploadedPart {
                    part_number: chunk.part_number,
                    etag: "synthetic".into(),
                    size: chunk.chunk.len(),
                    total_size: chunk.total_size,
                })
            }
        }
        fn chunks() -> impl Stream<Item = io::Result<Chunk>> {
            stream::iter([Ok(Chunk {
                total_size: 4,
                part_number: 1,
                offset: 0,
                chunk: Bytes::from_static(b"test"),
            })])
        }
        #[tokio::test]
        async fn strict_multipart_eof_without_permission_does_not_finalize() {
            let transport = FakeParts::default();
            let (control, permission) = Control::new();
            let future = transfer_parts(Path::new("unused"), chunks(), &transport, &control, 5);
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            permission.grant().unwrap();
            assert_eq!(future.await.unwrap().len(), 1);
        }
        #[tokio::test]
        async fn strict_multipart_cancel_drains_inflight_part_before_error() {
            let transport = FakeParts::default();
            transport.delayed.store(true, Ordering::Release);
            let (control, permission) = Control::new();
            permission.grant().unwrap();
            let future = transfer_parts(Path::new("unused"), chunks(), &transport, &control, 5);
            tokio::pin!(future);
            tokio::select! { _ = transport.entered.notified() => {}, result = &mut future => panic!("Unexpected result: {result:?}") }
            control.deny();
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            transport.released.notify_one();
            assert!(future.await.is_err());
            assert_eq!(transport.calls.load(Ordering::Acquire), 1);
        }
        #[tokio::test]
        async fn strict_request_boundary_stops_following_request_after_late_response() {
            let (control, permission) = Control::new();
            let called = AtomicBool::new(false);
            let (reply, response) = tokio::sync::oneshot::channel();
            let future = async {
                control
                    .step(|| async {
                        response.await.unwrap();
                        Ok(())
                    })
                    .await?;
                control
                    .step(|| async {
                        called.store(true, Ordering::Release);
                        Ok(())
                    })
                    .await
            };
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(1), &mut future)
                    .await
                    .is_err()
            );
            drop(permission);
            reply.send(()).unwrap();
            assert!(future.await.is_err());
            assert!(!called.load(Ordering::Acquire));
        }
        #[tokio::test]
        async fn lost_upload_worker_marks_cleanup_unconfirmed_and_wakes_waiter() {
            let (control, _permission) = Control::new();
            let worker = control.clone();
            let task = tokio::spawn(async move {
                let _guard = WorkerGuard(worker);
                panic!("lost uploader");
            });
            assert!(task.await.is_err());
            assert!(
                !tokio::time::timeout(Duration::from_secs(1), control.joined())
                    .await
                    .unwrap()
            );
            assert!(control.check().is_err());
        }
        #[tokio::test]
        async fn strict_reader_waits_for_permission_then_rewrites_first_part() {
            let dir = directory("reader");
            let path = dir.join("bytes");
            std::fs::write(&path, b"test").unwrap();
            let (control, permission) = Control::new();
            let mut stream = Box::pin(strict_chunks(path, control));
            assert!(
                tokio::time::timeout(Duration::from_millis(10), stream.next())
                    .await
                    .is_err()
            );
            permission.grant().unwrap();
            let first = stream.next().await.unwrap().unwrap();
            assert_eq!(first.part_number, 1);
            assert_eq!(first.chunk.as_ref(), b"test");
            let rewritten = stream.next().await.unwrap().unwrap();
            assert_eq!(rewritten.part_number, 1);
            assert_eq!(rewritten.chunk.as_ref(), b"test");
            assert!(stream.next().await.is_none());
            drop(stream);
            std::fs::remove_dir_all(dir).unwrap();
        }
        #[tokio::test]
        async fn strict_reader_cancellation_is_error_not_successful_eof() {
            let dir = directory("cancel-reader");
            let path = dir.join("bytes");
            std::fs::write(&path, b"test").unwrap();
            let (control, permission) = Control::new();
            let mut stream = Box::pin(strict_chunks(path, control));
            assert!(
                tokio::time::timeout(Duration::from_millis(10), stream.next())
                    .await
                    .is_err()
            );
            drop(permission);
            assert!(
                tokio::time::timeout(Duration::from_secs(1), stream.next())
                    .await
                    .unwrap()
                    .unwrap()
                    .is_err()
            );
            drop(stream);
            std::fs::remove_dir_all(dir).unwrap();
        }
        #[tokio::test]
        async fn strict_multipart_complete_maps_optional_success_and_retains_errors_and_late_revocation()
         {
            let (control, permission) = Control::new();
            permission.grant().unwrap();
            let result: Result<(), AuthedApiError> = control
                .complete(|| async { Ok(Some("synthetic-location".to_string())) })
                .await;
            result.unwrap();
            assert!(
                control
                    .complete(|| async {
                        Err::<Option<String>, _>("required completion failed".into())
                    })
                    .await
                    .is_err()
            );
            let (release, released) = tokio::sync::oneshot::channel();
            let future = control.complete(|| async {
                released.await.unwrap();
                Ok(Some("late-location".to_string()))
            });
            tokio::pin!(future);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut future)
                    .await
                    .is_err()
            );
            control.deny();
            release.send(()).unwrap();
            assert!(future.await.is_err());
        }
    }
}
