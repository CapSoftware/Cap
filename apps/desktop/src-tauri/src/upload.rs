// credit @filleduchaos

use crate::{
    UploadProgress, VideoUploadInfo,
    api::{self, PresignedS3PutRequest, PresignedS3PutRequestMethod, S3VideoMeta, UploadedPart},
    general_settings::GeneralSettingsStore,
    upload_legacy,
    web_api::ManagerExt,
};
use async_stream::{stream, try_stream};
use axum::http::Uri;
use bytes::Bytes;
use cap_project::{RecordingMeta, S3UploadMeta, UploadMeta};
use cap_utils::spawn_actor;
use ffmpeg::ffi::AV_TIME_BASE;
use flume::Receiver;
use futures::{Stream, StreamExt, TryStreamExt, stream};
use image::{ImageReader, codecs::jpeg::JpegEncoder};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::{
    io,
    path::{Path, PathBuf},
    pin::pin,
    str::FromStr,
    time::Duration,
};
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, BufReader},
    task::{self, JoinHandle},
    time,
};
use tokio_util::io::ReaderStream;
use tracing::{debug, error, info};

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

// a typical recommended chunk size is 5MB (AWS min part size).
const CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5MB

pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    screenshot_path: PathBuf,
    meta: S3VideoMeta,
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadedItem, String> {
    let is_new_uploader_enabled = GeneralSettingsStore::get(&app)
        .map_err(|err| error!("Error checking status of new uploader flow from settings: {err}"))
        .ok()
        .and_then(|v| v.map(|v| v.enable_new_uploader))
        .unwrap_or(false);
    if !is_new_uploader_enabled {
        return upload_legacy::upload_video(
            app,
            video_id,
            file_path,
            None,
            Some(screenshot_path),
            Some(meta),
            channel,
        )
        .await
        .map(|v| UploadedItem {
            link: v.link,
            id: v.id,
        });
    }

    info!("Uploading video {video_id}...");

    let (stream, total_size) = file_reader_stream(file_path).await?;
    let stream = progress(
        app.clone(),
        video_id.clone(),
        stream.map(move |v| v.map(move |v| (total_size, v))),
    );

    let stream = if let Some(channel) = channel {
        tauri_progress(channel, stream).boxed()
    } else {
        stream.boxed()
    };

    let video_fut = singlepart_uploader(
        app.clone(),
        PresignedS3PutRequest {
            video_id: video_id.clone(),
            subpath: "result.mp4".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: Some(meta),
        },
        total_size,
        stream.and_then(|(_, c)| async move { Ok(c) }),
    );

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

    let (video_result, thumbnail_result): (Result<_, String>, Result<_, String>) =
        tokio::join!(video_fut, thumbnail_fut);

    // TODO: Reporting errors to the frontend???
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

pub async fn upload_image(app: &AppHandle, file_path: PathBuf) -> Result<UploadedItem, String> {
    let is_new_uploader_enabled = GeneralSettingsStore::get(app)
        .map_err(|err| error!("Error checking status of new uploader flow from settings: {err}"))
        .ok()
        .and_then(|v| v.map(|v| v.enable_new_uploader))
        .unwrap_or(false);
    if !is_new_uploader_enabled {
        return upload_legacy::upload_image(app, file_path)
            .await
            .map(|v| UploadedItem {
                link: v.link,
                id: v.id,
            });
    }

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

pub async fn create_or_get_video(
    app: &AppHandle,
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<S3VideoMeta>,
) -> Result<S3UploadMeta, String> {
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
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {e}"))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    if response.status() != StatusCode::OK {
        #[derive(Deserialize, Clone, Debug)]
        pub struct CreateErrorResponse {
            error: String,
        }

        if let Ok(error) = response.json::<CreateErrorResponse>().await {
            if error.error == "upgrade_required" {
                return Err(
                    "You must upgrade to Cap Pro to upload recordings over 5 minutes in length"
                        .into(),
                );
            }

            return Err(format!("server error: {}", error.error));
        }

        return Err("Unknown error uploading video".into());
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
    pub handle: tokio::task::JoinHandle<Result<(), String>>,
}

impl InstantMultipartUpload {
    /// starts a progressive (multipart) upload that runs until recording stops
    /// and the file has stabilized (no additional data is being written).
    pub fn spawn(
        app: AppHandle,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        realtime_upload_done: Option<Receiver<()>>,
        recording_dir: PathBuf,
    ) -> Self {
        Self {
            handle: spawn_actor(Self::run(
                app,
                file_path,
                pre_created_video,
                realtime_upload_done,
                recording_dir,
            )),
        }
    }

    pub async fn run(
        app: AppHandle,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        realtime_video_done: Option<Receiver<()>>,
        recording_dir: PathBuf,
    ) -> Result<(), String> {
        let is_new_uploader_enabled = GeneralSettingsStore::get(&app)
            .map_err(|err| {
                error!("Error checking status of new uploader flow from settings: {err}")
            })
            .ok()
            .and_then(|v| v.map(|v| v.enable_new_uploader))
            .unwrap_or(false);
        if !is_new_uploader_enabled {
            return upload_legacy::InstantMultipartUpload::run(
                app,
                pre_created_video.id.clone(),
                file_path,
                pre_created_video,
                realtime_video_done,
            )
            .await;
        }

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

        let parts = progress(
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

        let metadata = build_video_meta(&file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        api::upload_multipart_complete(&app, &video_id, &upload_id, &parts, metadata).await?;
        info!("Multipart upload complete for {video_id}.");

        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).map_err(|err| {
            format!("Error reading project meta from {recording_dir:?} for upload complete: {err}")
        })?;
        project_meta.upload = Some(UploadMeta::Complete);
        project_meta
            .save_for_project()
            .map_err(|err| format!("Error reading project meta from {recording_dir:?}: {err}"))?;

        let _ = app.clipboard().write_text(pre_created_video.link.clone());

        Ok(())
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
pub fn from_file_to_chunks(path: PathBuf) -> impl Stream<Item = io::Result<Chunk>> {
    try_stream! {
        let file = File::open(path).await?;
        let total_size = file.metadata().await?.len();
        let mut file = BufReader::new(file);

        let mut buf = vec![0u8; CHUNK_SIZE as usize];
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
}

/// Creates a stream that reads chunks from a potentially growing file, yielding [Chunk]'s.
/// The first chunk of the file is yielded last to allow for header rewriting after recording completion.
/// This uploader will continually poll the filesystem and wait for the file to stop uploading before flushing the rest.
pub fn from_pending_file_to_chunks(
    path: PathBuf,
    realtime_upload_done: Option<Receiver<()>>,
) -> impl Stream<Item = io::Result<Chunk>> {
    try_stream! {
        let mut part_number = 2; // Start at 2 since part 1 will be yielded last
        let mut last_read_position: u64 = 0;
        let mut realtime_is_done = realtime_upload_done.as_ref().map(|_| false);
        let mut first_chunk_size: Option<u64> = None;

        loop {
            // Check if realtime recording is done
            if !realtime_is_done.unwrap_or(true) && let Some(ref realtime_receiver) = realtime_upload_done {
                match realtime_receiver.try_recv() {
                    Ok(_) => realtime_is_done = Some(true),
                    Err(flume::TryRecvError::Empty) => {},
                    Err(_) => yield Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "Realtime generation failed"
                    ))?,
                };
            }

            // Check file existence and size
            if !path.exists() {
                yield Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "File no longer exists"
                ))?;
            }

            let file_size = match tokio::fs::metadata(&path).await {
                Ok(metadata) => metadata.len(),
                Err(_) => {
                    // Retry on metadata errors (file might be temporarily locked)
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            let new_data_size = file_size.saturating_sub(last_read_position);

            // Read chunk if we have enough data OR if recording is done with any data
            let should_read_chunk = if let Some(is_done) = realtime_is_done {
                // We have a realtime receiver - check if recording is done or we have enough data
                (new_data_size >= CHUNK_SIZE) || (is_done && new_data_size > 0)
            } else {
                // No realtime receiver - read any available data
                new_data_size > 0
            };

            if should_read_chunk {
                let chunk_size = std::cmp::min(new_data_size, CHUNK_SIZE);

                let mut file = tokio::fs::File::open(&path).await?;
                file.seek(std::io::SeekFrom::Start(last_read_position)).await?;

                let mut chunk = vec![0u8; chunk_size as usize];
                let mut total_read = 0;

                while total_read < chunk_size as usize {
                    match file.read(&mut chunk[total_read..]).await {
                        Ok(0) => break, // EOF
                        Ok(n) => total_read += n,
                        Err(e) => yield Err(e)?,
                    }
                }

                if total_read > 0 {
                    chunk.truncate(total_read);

                    if last_read_position == 0 {
                        // This is the first chunk - remember its size but don't yield yet
                        first_chunk_size = Some(total_read as u64);
                    } else {
                        // Yield non-first chunks immediately
                        yield Chunk {
                            total_size: file_size,
                            part_number,
                            chunk: Bytes::from(chunk),
                        };
                        part_number += 1;
                    }

                    last_read_position += total_read as u64;
                }
            } else if new_data_size == 0 && realtime_is_done.unwrap_or(true) {
                // Recording is done and no new data - now yield the first chunk
                if let Some(first_size) = first_chunk_size {
                    let mut file = tokio::fs::File::open(&path).await?;
                    file.seek(std::io::SeekFrom::Start(0)).await?;

                    let mut first_chunk = vec![0u8; first_size as usize];
                    let mut total_read = 0;

                    while total_read < first_size as usize {
                        match file.read(&mut first_chunk[total_read..]).await {
                            Ok(0) => break,
                            Ok(n) => total_read += n,
                            Err(e) => yield Err(e)?,
                        }
                    }

                    if total_read > 0 {
                        first_chunk.truncate(total_read);
                        yield Chunk {
                            total_size: file_size,
                            part_number: 1,
                            chunk: Bytes::from(first_chunk),
                        };
                    }
                }
                break;
            } else {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

/// Takes an incoming stream of bytes and individually uploads them to S3.
///
/// Note: It's on the caller to ensure the chunks are sized correctly within S3 limits.
fn multipart_uploader(
    app: AppHandle,
    video_id: String,
    upload_id: String,
    stream: impl Stream<Item = io::Result<Chunk>>,
) -> impl Stream<Item = Result<UploadedPart, String>> {
    debug!("Initializing multipart uploader for video {video_id:?}");

    try_stream! {
        let mut stream = pin!(stream);
        let mut prev_part_number = None;
        while let Some(item) = stream.next().await {
            let Chunk { total_size, part_number, chunk } = item.map_err(|err| format!("uploader/part/{:?}/fs: {err:?}", prev_part_number.map(|p| p + 1)))?;
            debug!("Uploading chunk {part_number} for video {video_id:?}");
            prev_part_number = Some(part_number);
            let md5_sum = base64::encode(md5::compute(&chunk).0);
            let size = chunk.len();

            let presigned_url =
                api::upload_multipart_presign_part(&app, &video_id, &upload_id, part_number, &md5_sum)
                    .await?;

            let url = Uri::from_str(&presigned_url).map_err(|err| format!("uploader/part/{part_number}/invalid_url: {err:?}"))?;
            let resp = reqwest::Client::builder()
                .retry(reqwest::retry::for_host(url.host().unwrap_or("<unknown>").to_string()).classify_fn(|req_rep| {
                    if req_rep.status().is_some_and(|s| s.is_server_error()) {
                        req_rep.retryable()
                    } else {
                        req_rep.success()
                    }
                }))
                .build()
                .map_err(|err| format!("uploader/part/{part_number}/client: {err:?}"))?
                .put(&presigned_url)
                .header("Content-MD5", &md5_sum)
                .header("Content-Length", chunk.len())
                .timeout(Duration::from_secs(120))
                .body(chunk)
                .send()
                .await
                .map_err(|err| format!("uploader/part/{part_number}/error: {err:?}"))?;

            let etag = resp.headers().get("ETag").as_ref().and_then(|etag| etag.to_str().ok()).map(|v| v.trim_matches('"').to_string());

            match !resp.status().is_success() {
                true => Err(format!("uploader/part/{part_number}/error: {}", resp.text().await.unwrap_or_default())),
                false => Ok(()),
            }?;

            yield UploadedPart {
                etag: etag.ok_or_else(|| format!("uploader/part/{part_number}/error: ETag header not found"))?,
                part_number,
                size,
                total_size
            };
        }
    }
}

/// Takes an incoming stream of bytes and streams them to an S3 object.
pub async fn singlepart_uploader(
    app: AppHandle,
    request: PresignedS3PutRequest,
    total_size: u64,
    stream: impl Stream<Item = io::Result<Bytes>> + Send + 'static,
) -> Result<(), String> {
    let presigned_url = api::upload_signed(&app, request).await?;

    let url = Uri::from_str(&presigned_url)
        .map_err(|err| format!("singlepart_uploader/invalid_url: {err:?}"))?;
    let resp = reqwest::Client::builder()
        .retry(
            reqwest::retry::for_host(url.host().unwrap_or("<unknown>").to_string()).classify_fn(
                |req_rep| {
                    if req_rep.status().is_some_and(|s| s.is_server_error()) {
                        req_rep.retryable()
                    } else {
                        req_rep.success()
                    }
                },
            ),
        )
        .build()
        .map_err(|err| format!("singlepart_uploader/client: {err:?}"))?
        .put(&presigned_url)
        .header("Content-Length", total_size)
        .timeout(Duration::from_secs(120))
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
fn tauri_progress<T: UploadedChunk, E>(
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
