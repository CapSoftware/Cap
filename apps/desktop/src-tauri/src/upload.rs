// credit @filleduchaos

use crate::{
    UploadProgress, VideoUploadInfo,
    api::{self, PresignedS3PutRequest, PresignedS3PutRequestMethod, S3VideoMeta, UploadedPart},
    posthog::{PostHogEvent, async_capture_event},
    web_api::{AuthedApiError, ManagerExt},
};
use async_stream::{stream, try_stream};
use axum::http::Uri;
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
    str::FromStr,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, BufReader},
    task::{self, JoinHandle},
    time::{self, Instant, timeout},
};
use tokio_util::io::ReaderStream;
use tracing::{Span, debug, error, info, info_span, instrument, trace};
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

// The size of each S3 multipart upload chunk
const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5 MB
const MAX_CHUNK_SIZE: u64 = 20 * 1024 * 1024; // 20 MB

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
    let upload_id = api::upload_multipart_initiate(&app, &video_id).await?;

    let video_fut = async {
        let stream = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
                from_pending_file_to_chunks(file_path.clone(), None),
            ),
        );

        let stream = if let Some(channel) = channel {
            tauri_channel_progress(channel, stream).boxed()
        } else {
            stream.boxed()
        };

        let mut parts = stream.try_collect::<Vec<_>>().await?;

        // Deduplicate parts - keep the last occurrence of each part number
        let mut deduplicated_parts = HashMap::new();
        for part in parts {
            deduplicated_parts.insert(part.part_number, part);
        }
        parts = deduplicated_parts.into_values().collect::<Vec<_>>();
        parts.sort_by_key(|part| part.part_number);

        let metadata = build_video_meta(&file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        api::upload_multipart_complete(&app, &video_id, &upload_id, &parts, metadata.clone())
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

    async_capture_event(match &video_result {
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
    });

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

    let s3_config = create_or_get_video(app, true, None, None, None).await?;

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
) -> Result<S3UploadMeta, AuthedApiError> {
    let mut s3_config_url = if let Some(id) = video_id {
        format!("/api/desktop/video/create?recordingMode=desktopMP4&videoId={id}")
    } else if is_screenshot {
        "/api/desktop/video/create?recordingMode=desktopMP4&isScreenshot=true".to_string()
    } else {
        "/api/desktop/video/create?recordingMode=desktopMP4".to_string()
    };

    if let Some(name) = name {
        s3_config_url.push_str(&format!("&name={name}"));
    }

    if let Some(meta) = meta {
        s3_config_url.push_str(&format!("&durationInSecs={}", meta.duration_in_secs));
        s3_config_url.push_str(&format!("&width={}", meta.width));
        s3_config_url.push_str(&format!("&height={}", meta.height));
        if let Some(fps) = meta.fps {
            s3_config_url.push_str(&format!("&fps={}", fps));
        }
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
            .and_then(|body| serde_json::from_str::<CreateErrorResponse>(&*body).ok())
            && status == StatusCode::FORBIDDEN
        {
            if error.error == "upgrade_required" {
                return Err(AuthedApiError::UpgradeRequired);
            }
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
            .map(|v| (v.numerator() as f32 / v.denominator() as f32)),
    })
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
                    app,
                    file_path.clone(),
                    pre_created_video,
                    recording_dir,
                    realtime_upload_done,
                )
                .await;
                async_capture_event(match &result {
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
                });

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

        let mut parts = progress(
            app.clone(),
            video_id.clone(),
            multipart_uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
                from_pending_file_to_chunks(file_path.clone(), realtime_video_done),
            ),
        )
        .try_collect::<Vec<_>>()
        .await?;

        // Deduplicate parts - keep the last occurrence of each part number
        let mut deduplicated_parts = HashMap::new();
        for part in parts {
            deduplicated_parts.insert(part.part_number, part);
        }
        parts = deduplicated_parts.into_values().collect::<Vec<_>>();
        parts.sort_by_key(|part| part.part_number);

        let metadata = build_video_meta(&file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        api::upload_multipart_complete(&app, &video_id, &upload_id, &parts, metadata.clone())
            .await?;
        info!("Multipart upload complete for {video_id}.");

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

pub struct Chunk {
    /// The total size of the file to be uploaded.
    /// This can change as the recording grows.
    total_size: u64,
    /// The part number. `FILE_OFFSET = PART_NUMBER * CHUNK_SIZE`.
    part_number: u32,
    /// Actual data bytes of this chunk
    chunk: Bytes,
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
        loop {
            part_number += 1;
            let n = file.read(&mut buf).await?;
            if n == 0 { break; }
            yield Chunk {
                total_size,
                part_number,
                chunk: Bytes::copy_from_slice(&buf[..n]),
            };
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
        .map_err(|_| io::Error::new(io::ErrorKind::Other, "Failed to open file. The recording pipeline may have crashed?"))?;

        let mut part_number = 1;
        let mut last_read_position: u64 = 0;
        let mut realtime_is_done = realtime_upload_done.as_ref().map(|_| false);
        let mut first_chunk_size: Option<u64> = None;
        let mut chunk_buffer = vec![0u8; MAX_CHUNK_SIZE as usize];

        loop {
            // Check if realtime recording is done
            if !realtime_is_done.unwrap_or(true) {
                if let Some(ref realtime_receiver) = realtime_upload_done {
                    match realtime_receiver.try_recv() {
                        Ok(_) => realtime_is_done = Some(true),
                        Err(flume::TryRecvError::Empty) => {},
                        // This means all senders where dropped.
                        // This can assume this means realtime is done.
                        // It possibly means something has gone wrong but that's not the uploader's problem.
                        Err(_) => realtime_is_done = Some(true),
                    }
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
                    // Remember first chunk size for later re-emission with updated header
                    if last_read_position == 0 {
                        first_chunk_size = Some(total_read as u64);
                    }

                    yield Chunk {
                        total_size: file_size,
                        part_number,
                        chunk: Bytes::copy_from_slice(&chunk_buffer[..total_read]),
                    };
                    part_number += 1;
                    last_read_position += total_read as u64;
                }
            } else if new_data_size == 0 && realtime_is_done.unwrap_or(true) {
                // Recording is done and no new data - re-emit first chunk with corrected MP4 header
                if let Some(first_size) = first_chunk_size && realtime_upload_done.is_some() {
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

fn retryable_client(host: String) -> reqwest::ClientBuilder {
    reqwest::Client::builder().retry(
        reqwest::retry::for_host(host)
            .classify_fn(|req_rep| {
                match req_rep.status() {
                    // Server errors
                    Some(s) if s.is_server_error() || s == StatusCode::TOO_MANY_REQUESTS => {
                        req_rep.retryable()
                    }
                    // Network errors
                    None => req_rep.retryable(),
                    _ => req_rep.success(),
                }
            })
            .max_retries_per_request(5)
            .max_extra_load(5.0),
    )
}

/// Takes an incoming stream of bytes and individually uploads them to S3.
///
/// Note: It's on the caller to ensure the chunks are sized correctly within S3 limits.
#[instrument(skip(app, stream, upload_id))]
fn multipart_uploader(
    app: AppHandle,
    video_id: String,
    upload_id: String,
    stream: impl Stream<Item = io::Result<Chunk>> + Send + 'static,
) -> impl Stream<Item = Result<UploadedPart, AuthedApiError>> + 'static {
    const MAX_CONCURRENT_UPLOADS: usize = 3;

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

                async move {
                    let (Some(item), presigned_url) = join(stream.next(), async {
                        // Self-hosted still uses the legacy web API which requires these so we can't presign the URL.
                        if use_md5_hashes {
                            return Ok(None);
                        }

                        // We generate the presigned URL ahead of time for the part we expect to come next.
                        // If it's not the chunk that actually comes next we just throw it out.
                        // This means if the filesystem takes a while for the recording to reach previous total + CHUNK_SIZE, which is the common case, we aren't just doing nothing.
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
                            } = item.map_err(|err| {
                                format!("uploader/part/{:?}/fs: {err:?}", expected_part_number)
                            })?;
                            trace!(
                                "Uploading chunk {part_number} ({} bytes) for video {video_id:?}",
                                chunk.len()
                            );

                            // We prefetched for the wrong chunk. Let's try again with the correct part number now that we know it.
                            let md5_sum =
                                use_md5_hashes.then(|| base64::encode(md5::compute(&chunk).0));
                            let presigned_url = if let Some(url) = presigned_url?
                                && part_number == expected_part_number
                            {
                                url
                            } else if part_number == 1
                                && !use_md5_hashes
                                // We have a presigned URL left around from the first chunk
                                && let Some((url, expiry)) = first_chunk_presigned_url
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .clone()
                                // The URL hasn't expired
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

                            // We cache the presigned URL for the first chunk,
                            // as for instant mode we upload the first chunk at the end again to include the updated video metadata.
                            if part_number == 1 {
                                *first_chunk_presigned_url
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner) =
                                    Some((presigned_url.clone(), Instant::now()));
                            }

                            let size = chunk.len();
                            let url = Uri::from_str(&presigned_url).map_err(|err| {
                                format!("uploader/part/{part_number}/invalid_url: {err:?}")
                            })?;
                            let mut req =
                                retryable_client(url.host().unwrap_or("<unknown>").to_string())
                                    .build()
                                    .map_err(|err| {
                                        format!("uploader/part/{part_number}/client: {err:?}")
                                    })?
                                    .put(&presigned_url)
                                    .header("Content-Length", chunk.len())
                                    .timeout(Duration::from_secs(5 * 60))
                                    .body(chunk);

                            if let Some(md5_sum) = &md5_sum {
                                req = req.header("Content-MD5", md5_sum);
                            }

                            let resp = req
                                .send()
                                .instrument(info_span!("s3_put", size = size))
                                .await
                                .map_err(|err| {
                                    format!("uploader/part/{part_number}/error: {err:?}")
                                })?;

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
                        .instrument(info_span!("upload_part", part_number = part_number)),
                        (stream, expected_part_number + 1),
                    ))
                }
            },
        )
        .buffered(MAX_CONCURRENT_UPLOADS)
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

/// Takes an incoming stream of bytes and streams them to an S3 object.
#[instrument(skip(app, stream))]
pub async fn singlepart_uploader(
    app: AppHandle,
    request: PresignedS3PutRequest,
    total_size: u64,
    stream: impl Stream<Item = io::Result<Bytes>> + Send + 'static,
) -> Result<(), AuthedApiError> {
    let presigned_url = api::upload_signed(&app, request).await?;

    let url = Uri::from_str(&presigned_url)
        .map_err(|err| format!("singlepart_uploader/invalid_url: {err:?}"))?;
    let resp = retryable_client(url.host().unwrap_or("<unknown>").to_string())
        .build()
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
    let (video_id2, app_handle) = (video_id.clone(), app.clone());

    stream! {
        let mut stream = pin!(stream);

        while let Some(chunk) = stream.next().await {
            if let Ok(chunk) = &chunk {
                uploaded += chunk.size();
                let total = chunk.total();

                // Cancel any pending task
                if let Some(handle) = pending_task.take() {
                    handle.abort();
                }

                // Cancel any existing reemit task
                if let Some(handle) = reemit_task.take() {
                    handle.abort();
                }

                let should_send_immediately = uploaded >= total;

                if should_send_immediately {
                    // Send immediately if upload is complete
                    let app_clone = app.clone();
                    let video_id_clone = video_id.clone();
                    tokio::spawn(async move {
                        api::desktop_video_progress(&app_clone, &video_id_clone, uploaded, total).await.ok();
                    });
                } else {
                    // Schedule delayed update
                    let app_clone = app.clone();
                    let video_id_clone = video_id.clone();
                    pending_task = Some(tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        api::desktop_video_progress(&app_clone, &video_id_clone, uploaded, total).await.ok();
                    }));

                    // Start reemit task for continuous progress updates every 700ms
                    let app_reemit = app.clone();
                    let video_id_reemit = video_id.clone();
                    let uploaded_reemit = uploaded;
                    let total_reemit = total;
                    reemit_task = Some(tokio::spawn(async move {
                        let mut interval = time::interval(Duration::from_millis(700));
                        interval.tick().await; // Skip first immediate tick

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

                // Emit progress event for the app frontend
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

        // Clean up reemit task when stream ends
        if let Some(handle) = reemit_task.take() {
            handle.abort();
        }
    }
    .map(Some)
    .chain(stream::once(async move {
        // This will trigger the frontend to remove the event from the SolidJS store.
        UploadProgressEvent {
            video_id: video_id2,
            uploaded: "0".into(),
            total: "0".into(),
        }
        .emit(&app_handle)
        .ok();

        None
    }))
    .filter_map(|item| async move { item })
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
