// credit @filleduchaos

use crate::{
    UploadProgress, VideoUploadInfo,
    api::{self, PresignedS3PutRequest, PresignedS3PutRequestMethod, S3VideoMeta, UploadedPart},
    http_client::{HttpClient, RetryableHttpClient},
    posthog::{PostHogEvent, async_capture_event},
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
    sync::{Arc, Mutex, PoisonError},
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

#[instrument(skip(app, channel, file_path, screenshot_path))]
pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    screenshot_path: PathBuf,
    meta: S3VideoMeta,
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadedItem, AuthedApiError> {
    info!("Uploading video {video_id}...");

    let start = Instant::now();
    let upload_id = api::upload_multipart_initiate(app, &video_id).await?;

    let video_fut = async {
        let failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>> = Arc::new(Mutex::new(Vec::new()));

        let stream = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
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
            Ok(meta) => PostHogEvent::MultipartUploadComplete {
                duration: start.elapsed(),
                length: meta
                    .as_ref()
                    .map(|v| Duration::from_secs(v.duration_in_secs as u64))
                    .unwrap_or_default(),
                size: std::fs::metadata(file_path)
                    .map(|m| ((m.len() as f64) / 1_000_000.0) as u64)
                    .unwrap_or_default(),
            },
            Err(err) => PostHogEvent::MultipartUploadFailed {
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

#[instrument(skip(app))]
pub async fn upload_image(
    app: &AppHandle,
    file_path: PathBuf,
) -> Result<UploadedItem, AuthedApiError> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let s3_config = create_or_get_video(app, true, None, None, None, None).await?;

    let (stream, total_size) = file_reader_stream(file_path).await?;
    singlepart_uploader(
        app.clone(),
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: file_name,
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
        format!("/api/desktop/video/create?recordingMode={recording_mode}&videoId={id}")
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
        Self {
            handle: spawn_actor(async move {
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
                        Ok(meta) => PostHogEvent::MultipartUploadComplete {
                            duration: start.elapsed(),
                            length: meta
                                .as_ref()
                                .map(|v| Duration::from_secs(v.duration_in_secs as u64))
                                .unwrap_or_default(),
                            size: std::fs::metadata(file_path)
                                .map(|m| ((m.len() as f64) / 1_000_000.0) as u64)
                                .unwrap_or_default(),
                        },
                        Err(err) => PostHogEvent::MultipartUploadFailed {
                            duration: start.elapsed(),
                            error: err.to_string(),
                        },
                    },
                );

                result.map(|_| ())
            }),
        }
    }

    pub async fn run(
        app: AppHandle,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        recording_dir: PathBuf,
        realtime_video_done: Option<Receiver<()>>,
    ) -> Result<Option<S3VideoMeta>, AuthedApiError> {
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

        let upload_id = api::upload_multipart_initiate(&app, &video_id).await?;

        let failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>> = Arc::new(Mutex::new(Vec::new()));

        let mut parts = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
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

struct SegmentUploadState {
    uploaded_video_segments: std::collections::HashMap<u32, f64>,
    uploaded_audio_segments: std::collections::HashMap<u32, f64>,
    video_init_uploaded: bool,
    audio_init_uploaded: bool,
    failed_segments: Vec<FailedSegmentInfo>,
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
                        Ok(total_bytes) => PostHogEvent::MultipartUploadComplete {
                            duration: start.elapsed(),
                            length: start.elapsed(),
                            size: total_bytes / (1024 * 1024),
                        },
                        Err(err) => PostHogEvent::MultipartUploadFailed {
                            duration: start.elapsed(),
                            error: err.to_string(),
                        },
                    },
                );

                result.map(|_| ())
            }),
        }
    }

    async fn upload_segment_file(
        app: &AppHandle,
        video_id: &str,
        subpath: &str,
        file_path: &Path,
        expected_size: u64,
    ) -> Result<u64, AuthedApiError> {
        const MAX_RETRIES: u32 = 3;
        const FILE_WAIT_TIMEOUT: Duration = Duration::from_secs(10);
        const DATA_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

        let start = Instant::now();
        let actual_path = loop {
            if file_path.exists() {
                break file_path.to_path_buf();
            }
            if start.elapsed() > FILE_WAIT_TIMEOUT {
                return Err(format!(
                    "segment_upload/timeout/{subpath}: file not found after {:?} ({})",
                    FILE_WAIT_TIMEOUT,
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

            let size_ok = expected_size == 0 || data.len() as u64 >= expected_size;
            if !data.is_empty() && size_ok {
                break data;
            }

            if start.elapsed() > DATA_WAIT_TIMEOUT {
                if data.is_empty() {
                    warn!(
                        subpath,
                        path = %actual_path.display(),
                        "Segment file still empty after {:?}, skipping upload",
                        DATA_WAIT_TIMEOUT
                    );
                    return Ok(0);
                }
                break data;
            }

            tokio::time::sleep(Duration::from_millis(200)).await;
        };

        let file_size = file_data.len();
        let file_bytes = Bytes::from(file_data);

        for attempt in 0..MAX_RETRIES {
            let presigned_url = api::upload_signed(
                app,
                api::PresignedS3PutRequest {
                    video_id: video_id.to_string(),
                    subpath: subpath.to_string(),
                    method: api::PresignedS3PutRequestMethod::Put,
                    meta: None,
                },
            )
            .await?;

            let client = app
                .state::<RetryableHttpClient>()
                .as_ref()
                .map_err(|err| format!("segment_upload/client: {err:?}"))?
                .clone();

            let send_result = client
                .put(&presigned_url)
                .header("Content-Length", file_size)
                .timeout(Duration::from_secs(5 * 60))
                .body(file_bytes.clone())
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
    ) -> Result<(), AuthedApiError> {
        let json = serde_json::to_string_pretty(manifest)
            .map_err(|e| format!("segment_upload/manifest/serialize: {e}"))?;

        let presigned_url = api::upload_signed(
            app,
            api::PresignedS3PutRequest {
                video_id: video_id.to_string(),
                subpath: "segments/manifest.json".to_string(),
                method: api::PresignedS3PutRequestMethod::Put,
                meta: None,
            },
        )
        .await?;

        let client = app
            .state::<RetryableHttpClient>()
            .as_ref()
            .map_err(|err| format!("segment_upload/manifest/client: {err:?}"))?
            .clone();

        let resp = client
            .put(&presigned_url)
            .header("Content-Length", json.len())
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(60))
            .body(json)
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
            .map_err(|e| error!("Failed to save recording meta: {e}"))
            .ok();

        let state = Arc::new(Mutex::new(SegmentUploadState::new()));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(3));
        let consecutive_failures = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let mut in_flight = futures::stream::FuturesUnordered::<
            tokio::task::JoinHandle<Result<(), AuthedApiError>>,
        >::new();

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
                        match segment_rx.recv_timeout(std::time::Duration::from_millis(100)) {
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
                .map_err(|e| format!("Failed to spawn bridge thread: {e}"))?
        };

        use futures::StreamExt as _;

        const CONSECUTIVE_FAILURE_LIMIT: u32 = 5;

        loop {
            tokio::select! {
                biased;
                Some(join_result) = in_flight.next(), if !in_flight.is_empty() => {
                    if let Ok(Err(e)) = join_result {
                        warn!("Segment upload task error: {e}");
                    }
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
                    let permit = semaphore
                        .clone()
                        .acquire_owned()
                        .await
                        .map_err(|e| format!("segment_upload/semaphore: {e}"))?;

                    let file_path = event.path.clone();
                    let is_init = event.is_init;
                    let media_type = event.media_type;
                    let index = event.index;
                    let duration = event.duration;
                    let expected_size = event.file_size;
                    let subpath_for_fail = subpath.clone();

                    let handle = tokio::spawn(async move {
                        let _permit = permit;

                        let result =
                            Self::upload_segment_file(&app_clone, &video_id_clone, &subpath, &file_path, expected_size)
                                .await;

                        match result {
                            Err(e) => {
                                let prev = failures_clone.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                warn!(
                                    subpath,
                                    error = %e,
                                    consecutive_failures = prev + 1,
                                    "Failed to upload segment, queued for retry"
                                );
                                let mut s = state_clone.lock().unwrap_or_else(|e| e.into_inner());
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
                            Ok(bytes) => {
                                failures_clone.store(0, std::sync::atomic::Ordering::Relaxed);
                                let mut s = state_clone.lock().unwrap_or_else(|e| e.into_inner());
                                s.total_bytes_uploaded += bytes;
                                if is_init {
                                    match media_type {
                                        SegmentMediaType::Video => s.video_init_uploaded = true,
                                        SegmentMediaType::Audio => s.audio_init_uploaded = true,
                                    }
                                } else {
                                    match media_type {
                                        SegmentMediaType::Video => {
                                            s.uploaded_video_segments.insert(index, duration);
                                        }
                                        SegmentMediaType::Audio => {
                                            s.uploaded_audio_segments.insert(index, duration);
                                        }
                                    }
                                }
                            }
                        }

                        let manifest = state_clone
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .to_manifest();
                        if let Err(e) = Self::upload_manifest(&app_clone, &video_id_clone, &manifest).await
                        {
                            warn!("Failed to upload manifest after segment: {e}");
                        }

                        info!(subpath, "Segment uploaded successfully");

                        Ok(())
                    });

                    in_flight.push(handle);

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

        while let Some(join_result) = in_flight.next().await {
            if let Ok(Err(e)) = join_result {
                warn!("Segment upload task error: {e}");
            }
        }

        let _ = bridge_handle.join();

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
                match Self::upload_segment_file(
                    &app,
                    &video_id,
                    &seg.subpath,
                    &seg.file_path,
                    seg.expected_size,
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

        let final_manifest = state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .to_complete_manifest();
        Self::upload_manifest(&app, &video_id, &final_manifest).await?;

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
                            tokio::time::sleep(Duration::from_millis(1000 * (1 << attempt) as u64))
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

        let total_bytes = state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .total_bytes_uploaded;

        info!(total_bytes, "Segment upload complete for {video_id}");

        Ok(total_bytes)
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
    stream: impl Stream<Item = io::Result<Chunk>> + Send + 'static,
    failed_chunks: Arc<Mutex<Vec<FailedChunkInfo>>>,
) -> impl Stream<Item = Result<UploadedPart, AuthedApiError>> + 'static {
    const MAX_CONCURRENT_UPLOADS: usize = 5;

    debug!("Initializing multipart uploader for video {video_id:?}");
    let start = Instant::now();
    let video_id2 = video_id.clone();

    stream::once(async move {
        let use_md5_hashes = app.is_server_url_custom().await;
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

                                let mut req = client
                                    .put(&presigned_url)
                                    .header("Content-Length", size)
                                    .timeout(Duration::from_secs(5 * 60))
                                    .body(chunk);

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
                                        let mut retry_req = client
                                            .put(&retry_url)
                                            .header("Content-Length", size)
                                            .timeout(Duration::from_secs(5 * 60))
                                            .body(chunk_for_retry);
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

                                match !resp.status().is_success() {
                                    true => Err(format!(
                                        "uploader/part/{part_number}/error: {}",
                                        resp.text().await.unwrap_or_default()
                                    )),
                                    false => Ok(()),
                                }?;

                                trace!("Completed upload of part {part_number}");

                                Ok::<_, AuthedApiError>(UploadedPart {
                                    etag: etag.ok_or_else(|| {
                                        format!(
                                            "uploader/part/{part_number}/error: ETag header not found"
                                        )
                                    })?,
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
        .buffered(MAX_CONCURRENT_UPLOADS)
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

        let mut file = File::open(file_path)
            .await
            .map_err(|e| format!("retry/part/{}/open: {e}", failed.part_number))?;
        file.seek(std::io::SeekFrom::Start(failed.offset))
            .await
            .map_err(|e| format!("retry/part/{}/seek: {e}", failed.part_number))?;

        let mut buf = vec![0u8; failed.chunk_size];
        let mut total_read = 0;
        while total_read < failed.chunk_size {
            match file.read(&mut buf[total_read..]).await {
                Ok(0) => break,
                Ok(n) => total_read += n,
                Err(e) => return Err(format!("retry/part/{}/read: {e}", failed.part_number).into()),
            }
        }

        let chunk = Bytes::from(buf);

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

        let mut req = client
            .put(&presigned_url)
            .header("Content-Length", size)
            .timeout(Duration::from_secs(5 * 60))
            .body(chunk);

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
                let mut retry_req = client
                    .put(&retry_url)
                    .header("Content-Length", size)
                    .timeout(Duration::from_secs(5 * 60))
                    .body(chunk_for_retry);
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

        if !resp.status().is_success() {
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

        retry_parts.push(UploadedPart {
            etag: etag.ok_or_else(|| {
                format!(
                    "retry/part/{}/error: ETag header not found",
                    failed.part_number
                )
            })?,
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
    let presigned_url = api::upload_signed(&app, request).await?;

    let resp = app
        .state::<RetryableHttpClient>()
        .as_ref()
        .map_err(|err| format!("singlepart_uploader/client: {err:?}"))?
        .put(&presigned_url)
        .header("Content-Length", total_size)
        .body(reqwest::Body::wrap_stream(stream))
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
