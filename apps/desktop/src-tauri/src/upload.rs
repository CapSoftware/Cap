// credit @filleduchaos

use crate::api::{S3VideoMeta, UploadedPart};
use crate::web_api::ManagerExt;
use crate::{UploadProgress, VideoUploadInfo, api};
use async_stream::{stream, try_stream};
use axum::body::Body;
use bytes::Bytes;
use cap_project::{RecordingMeta, RecordingMetaInner, UploadState};
use cap_utils::spawn_actor;
use ffmpeg::ffi::AV_TIME_BASE;
use flume::Receiver;
use futures::{Stream, StreamExt, TryStreamExt, stream};
use image::ImageReader;
use image::codecs::jpeg::JpegEncoder;
use reqwest::StatusCode;
use reqwest::header::CONTENT_LENGTH;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::error::Error;
use std::io;
use std::path::Path;
use std::pin::pin;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::watch;
use tokio::task::{self, JoinHandle};
use tokio::time::sleep;
use tokio_util::io::ReaderStream;
use tracing::{debug, error, info, trace, warn};

#[derive(Deserialize, Serialize, Clone, Type, Debug)]
pub struct S3UploadMeta {
    id: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CreateErrorResponse {
    error: String,
}

impl S3UploadMeta {
    pub fn id(&self) -> &str {
        &self.id
    }
}

pub struct UploadedVideo {
    pub link: String,
    pub id: String,
    #[allow(unused)]
    pub config: S3UploadMeta,
}

pub struct UploadedImage {
    pub link: String,
    pub id: String,
}

pub fn upload_v2(app: AppHandle) {
    // TODO: Progress reporting
    // TODO: Multipart or regular upload automatically sorted out
    // TODO: Allow either FS derived or Rust progress derived multipart upload source
    // TODO: Support screenshots, or videos

    todo!();
}

pub struct UploadProgressUpdater {
    video_state: Option<VideoProgressState>,
    app: AppHandle,
    video_id: String,
}

struct VideoProgressState {
    uploaded: u64,
    total: u64,
    pending_task: Option<JoinHandle<()>>,
    last_update_time: Instant,
}

impl UploadProgressUpdater {
    pub fn new(app: AppHandle, video_id: String) -> Self {
        Self {
            video_state: None,
            app,
            video_id,
        }
    }

    pub fn update(&mut self, uploaded: u64, total: u64) {
        let should_send_immediately = {
            let state = self.video_state.get_or_insert_with(|| VideoProgressState {
                uploaded,
                total,
                pending_task: None,
                last_update_time: Instant::now(),
            });

            // Cancel any pending task
            if let Some(handle) = state.pending_task.take() {
                handle.abort();
            }

            state.uploaded = uploaded;
            state.total = total;
            state.last_update_time = Instant::now();

            // Send immediately if upload is complete
            uploaded >= total
        };

        let app = self.app.clone();
        if should_send_immediately {
            tokio::spawn({
                let video_id = self.video_id.clone();
                async move {
                    Self::send_api_update(&app, video_id, uploaded, total).await;
                }
            });

            // Clear state since upload is complete
            self.video_state = None;
        } else {
            // Schedule delayed update
            let handle = {
                let video_id = self.video_id.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    Self::send_api_update(&app, video_id, uploaded, total).await;
                })
            };

            if let Some(state) = &mut self.video_state {
                state.pending_task = Some(handle);
            }
        }
    }

    async fn send_api_update(app: &AppHandle, video_id: String, uploaded: u64, total: u64) {
        let response = app
            .authed_api_request("/api/desktop/video/progress", |client, url| {
                client
                    .post(url)
                    .header("X-Cap-Desktop-Version", env!("CARGO_PKG_VERSION"))
                    .json(&json!({
                        "videoId": video_id,
                        "uploaded": uploaded,
                        "total": total,
                        "updatedAt": chrono::Utc::now().to_rfc3339()
                    }))
            })
            .await;

        match response {
            Ok(resp) if resp.status().is_success() => {
                trace!("Progress update sent successfully");
            }
            Ok(resp) => error!("Failed to send progress update: {}", resp.status()),
            Err(err) => error!("Failed to send progress update: {err}"),
        }
    }
}

#[derive(Default, Debug)]
pub enum UploadPartProgress {
    #[default]
    Presigning,
    Uploading {
        uploaded: i64,
        total: i64,
    },
    Done,
    Error(String),
}

#[derive(Default, Debug)]
pub struct UploadVideoProgress {
    video: UploadPartProgress,
    thumbnail: UploadPartProgress,
}

pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    screenshot_path: PathBuf,
    s3_config: S3UploadMeta,
    meta: S3VideoMeta,
    // TODO: Hook this back up?
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadedVideo, String> {
    let (tx, mut rx) = watch::channel(UploadVideoProgress::default());

    // TODO: Hook this up properly
    tokio::spawn(async move {
        loop {
            println!("STATUS: {:?}", *rx.borrow_and_update());
            if rx.changed().await.is_err() {
                break;
            }
        }
    });

    info!("Uploading video {video_id}...");

    let (stream, total_size) = file_reader_stream(file_path).await?;
    let video_upload_fut = do_presigned_upload(
        app,
        stream,
        total_size,
        PresignedS3PutRequest {
            video_id: video_id.clone(),
            subpath: "result.mp4".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: Some(meta),
        },
        {
            let tx = tx.clone();
            move |p| tx.send_modify(|v| v.video = p)
        },
    );

    let (stream, total_size) = bytes_into_stream(compress_image(screenshot_path).await?);
    let thumbnail_upload_fut = do_presigned_upload(
        app,
        stream,
        total_size,
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: "screenshot/screen-capture.jpg".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
        {
            let tx = tx.clone();
            move |p| tx.send_modify(|v| v.thumbnail = p)
        },
    );

    let (video_result, thumbnail_result): (Result<(), String>, Result<(), String>) =
        tokio::join!(video_upload_fut, thumbnail_upload_fut);

    if let Some(err) = video_result.err() {
        error!("Failed to upload video for {video_id}: {err}");
        tx.send_modify(|v| v.video = UploadPartProgress::Error(err.clone()));
        return Err(err); // TODO: Maybe don't do this
    }
    if let Some(err) = thumbnail_result.err() {
        error!("Failed to upload thumbnail for video {video_id}: {err}");
        tx.send_modify(|v| v.thumbnail = UploadPartProgress::Error(err.clone()));
        return Err(err); // TODO: Maybe don't do this
    }

    Ok(UploadedVideo {
        link: app.make_app_url(format!("/s/{}", &s3_config.id)).await,
        id: s3_config.id.clone(),
        config: s3_config,
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

pub async fn do_presigned_upload(
    app: &AppHandle,
    stream: impl Stream<Item = Result<Bytes, io::Error>> + Send + 'static,
    total_size: u64,
    request: PresignedS3PutRequest,
    mut set_progress: impl FnMut(UploadPartProgress) + Send + 'static,
) -> Result<(), String> {
    set_progress(UploadPartProgress::Presigning);
    let client = reqwest::Client::new();
    let presigned_url = presigned_s3_put(app, request).await?;

    set_progress(UploadPartProgress::Uploading {
        uploaded: 0,
        total: 0,
    });
    let mut uploaded = 0i64;
    let total = total_size as i64;
    let stream = stream.inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            uploaded += chunk.len() as i64;
            set_progress(UploadPartProgress::Uploading { uploaded, total });
        }
    });

    let response = client
        .put(presigned_url)
        .header("Content-Length", total_size)
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await
        .map_err(|e| format!("Failed to upload file: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        return Err(format!(
            "Failed to upload file. Status: {status}. Body: {error_body}"
        ));
    }

    Ok(())
}

pub async fn upload_image(app: &AppHandle, file_path: PathBuf) -> Result<UploadedImage, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let s3_config = create_or_get_video(app, true, None, None, None).await?;

    let (stream, total_size) = file_reader_stream(file_path).await?;
    do_presigned_upload(
        app,
        stream,
        total_size as u64,
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: file_name,
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
        |p| {
            // TODO
        },
    )
    .await?;

    Ok(UploadedImage {
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresignedS3PutRequest {
    pub video_id: String,
    pub subpath: String,
    pub method: PresignedS3PutRequestMethod,
    #[serde(flatten)]
    pub meta: Option<S3VideoMeta>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PresignedS3PutRequestMethod {
    #[allow(unused)]
    Post,
    Put,
}

async fn presigned_s3_put(app: &AppHandle, body: PresignedS3PutRequest) -> Result<String, String> {
    #[derive(Deserialize, Debug)]
    struct Data {
        url: String,
    }

    #[derive(Deserialize, Debug)]
    #[serde(rename_all = "camelCase")]
    struct Wrapper {
        presigned_put_data: Data,
    }

    let response = app
        .authed_api_request("/api/upload/signed", |client, url| {
            client.post(url).json(&body)
        })
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {e}"))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    let Wrapper { presigned_put_data } = response
        .json::<Wrapper>()
        .await
        .map_err(|e| format!("Failed to deserialize server response: {e}"))?;

    Ok(presigned_put_data.url)
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

pub fn bytes_into_stream(
    bytes: Vec<u8>,
) -> (impl Stream<Item = Result<Bytes, std::io::Error>>, u64) {
    let total_size = bytes.len();
    let stream = stream::once(async move { Ok::<_, std::io::Error>(bytes::Bytes::from(bytes)) });
    (stream, total_size as u64)
}

#[derive(Clone, Serialize, Type, tauri_specta::Event)]
pub struct UploadProgressEvent {
    video_id: String,
    // TODO: Account for different states -> Eg. uploading video vs thumbnail
    uploaded: String,
    total: String,
}

// a typical recommended chunk size is 5MB (AWS min part size).
const CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5MB

pub struct InstantMultipartUpload {
    pub handle: tokio::task::JoinHandle<Result<(), String>>,
}

impl InstantMultipartUpload {
    /// starts a progressive (multipart) upload that runs until recording stops
    /// and the file has stabilized (no additional data is being written).
    pub fn spawn(
        app: AppHandle,
        video_id: String,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        realtime_upload_done: Option<Receiver<()>>,
        recording_dir: PathBuf,
    ) -> Self {
        Self {
            handle: spawn_actor(Self::run(
                app,
                video_id,
                file_path,
                pre_created_video,
                realtime_upload_done,
                recording_dir,
            )),
        }
    }

    pub async fn run(
        app: AppHandle,
        video_id: String,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        realtime_video_done: Option<Receiver<()>>,
        recording_dir: PathBuf,
    ) -> Result<(), String> {
        debug!("Initiating multipart upload for {video_id}...");

        // TODO: Reuse this + error handling
        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
        project_meta.upload = Some(UploadState::MultipartUpload);
        project_meta.save_for_project().unwrap();

        // TODO: Allow injecting this for Studio mode upload
        // let file = File::open(path).await.unwrap(); // TODO: Error handling
        // ReaderStream::new(file) // TODO: Map into part numbers

        let upload_id = api::upload_multipart_initiate(&app, &video_id).await?;

        // TODO: Will it be a problem that `ReaderStream` doesn't have a fixed chunk size??? We should fix that!!!!
        let parts = progress(
            app.clone(),
            video_id.clone(),
            uploader(
                app.clone(),
                video_id.clone(),
                upload_id.clone(),
                from_pending_file(file_path.clone(), realtime_video_done),
            ),
        )
        .try_collect::<Vec<_>>()
        .await?;

        let metadata = build_video_meta(&file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        api::upload_multipart_complete(&app, &video_id, &upload_id, &parts, metadata).await?;
        info!("Multipart upload complete for {video_id}.");

        // TODO: Reuse this + error handling
        let mut project_meta = RecordingMeta::load_for_project(&recording_dir).unwrap();
        project_meta.upload = Some(UploadState::Complete);
        project_meta.save_for_project().unwrap();

        let _ = app.clipboard().write_text(pre_created_video.link.clone());

        Ok(())
    }
}

struct Chunk {
    /// The total size of the file to be uploaded.
    /// This can change as the recording grows.
    total_size: u64,
    /// The part number. `FILE_OFFSET = PART_NUMBER * CHUNK_SIZE`.
    part_number: u32,
    /// Actual data bytes of this chunk
    chunk: Bytes,
}

/// Creates a stream that reads chunks from a potentially growing file,
/// yielding (part_number, chunk_data) pairs. The first chunk is yielded last
/// to allow for header rewriting after recording completion.
pub fn from_pending_file(
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
            if !realtime_is_done.unwrap_or(true) {
                if let Some(ref realtime_receiver) = realtime_upload_done {
                    match realtime_receiver.try_recv() {
                        Ok(_) => realtime_is_done = Some(true),
                        Err(flume::TryRecvError::Empty) => {},
                        Err(_) => {
                            todo!(); // TODO
                            // return Err(std::io::Error::new(
                            //     std::io::ErrorKind::Interrupted,
                            //     "Realtime generation failed"
                            // ));
                        }
                    }
                }
            }

            // Check file existence and size
            if !path.exists() {
                todo!();
                // return Err(std::io::Error::new(
                //     std::io::ErrorKind::NotFound,
                //     "File no longer exists"
                // ));
            }

            let file_size = match tokio::fs::metadata(&path).await {
                Ok(metadata) => metadata.len(),
                Err(e) => {
                    // Retry on metadata errors (file might be temporarily locked)
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            let new_data_size = file_size.saturating_sub(last_read_position);

            // Determine if we should read a chunk
            let should_read_chunk = (new_data_size >= CHUNK_SIZE)
                || (new_data_size > 0 && realtime_is_done.unwrap_or(false))
                || (realtime_is_done.is_none() && new_data_size > 0);

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
                        Err(e) => todo!(), // TODO: return Err(e),
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
                            Err(e) => todo!(), // TODO: return Err(e),
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
                // Wait for more data
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// Takes an incoming stream of bytes and individually uploads them to S3.
///
/// Note: It's on the caller to ensure the chunks are sized correctly within S3 limits.
fn uploader(
    app: AppHandle,
    video_id: String,
    upload_id: String,
    stream: impl Stream<Item = io::Result<Chunk>>,
) -> impl Stream<Item = Result<UploadedPart, String>> {
    let client = reqwest::Client::default();

    try_stream! {
        let mut stream = pin!(stream);
        let mut prev_part_number = None;
        while let Some(item) = stream.next().await {
            let Chunk { total_size, part_number, chunk } = item.map_err(|err| format!("uploader/part/{:?}/fs: {err:?}", prev_part_number.map(|p| p + 1)))?;
            prev_part_number = Some(part_number);
            let md5_sum = base64::encode(md5::compute(&chunk).0);
            let size = chunk.len();

            let presigned_url =
                api::upload_multipart_presign_part(&app, &video_id, &upload_id, part_number, &md5_sum)
                    .await?;

            // TODO: Retries
            let resp = client
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

/// Monitor the stream to report the upload progress
fn progress(
    app: AppHandle,
    video_id: String,
    stream: impl Stream<Item = Result<UploadedPart, String>>,
) -> impl Stream<Item = Result<UploadedPart, String>> {
    // TODO: Flatten this implementation into here
    let mut progress = UploadProgressUpdater::new(app.clone(), video_id.clone());
    let mut uploaded = 0;

    stream! {
        let mut stream = pin!(stream);

        while let Some(part) = stream.next().await {
            if let Ok(part) = &part {
                uploaded += part.size as u64;

                progress.update(uploaded, part.total_size);
                UploadProgressEvent {
                    video_id: video_id.to_string(),
                    uploaded: uploaded.to_string(),
                    total: part.total_size.to_string(),
                }
                .emit(&app)
                .ok();
            }

            yield part;
        }
    }
}
