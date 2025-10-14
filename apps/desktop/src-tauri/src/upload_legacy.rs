//! This is the legacy uploading module.
//! We are keeping it for now as an easy fallback.
//!
//! You should avoid making changes to it, make changes to the new upload module instead.

// credit @filleduchaos

use crate::api::S3VideoMeta;
use crate::web_api::{AuthedApiError, ManagerExt};
use crate::{UploadProgress, VideoUploadInfo};
use ffmpeg::ffi::AV_TIME_BASE;
use flume::Receiver;
use futures::StreamExt;
use image::ImageReader;
use image::codecs::jpeg::JpegEncoder;
use reqwest::StatusCode;
use reqwest::header::CONTENT_LENGTH;
use serde::{Deserialize, Serialize};
use serde_json::json;
use specta::Type;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::{AppHandle, ipc::Channel};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::task::{self, JoinHandle};
use tokio::time::sleep;
use tracing::{debug, error, info, trace, warn};

#[derive(Deserialize, Serialize, Clone, Type, Debug)]
pub struct S3UploadMeta {
    id: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct CreateErrorResponse {
    error: String,
}

// fn deserialize_empty_object_as_string<'de, D>(deserializer: D) -> Result<String, D::Error>
// where
//     D: Deserializer<'de>,
// {
//     struct StringOrObject;

//     impl<'de> de::Visitor<'de> for StringOrObject {
//         type Value = String;

//         fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
//             formatter.write_str("string or empty object")
//         }

//         fn visit_str<E>(self, value: &str) -> Result<String, E>
//         where
//             E: de::Error,
//         {
//             Ok(value.to_string())
//         }

//         fn visit_string<E>(self, value: String) -> Result<String, E>
//         where
//             E: de::Error,
//         {
//             Ok(value)
//         }

//         fn visit_map<M>(self, _map: M) -> Result<String, M::Error>
//         where
//             M: de::MapAccess<'de>,
//         {
//             // Return empty string for empty objects
//             Ok(String::new())
//         }
//     }

//     deserializer.deserialize_any(StringOrObject)
// }

// impl S3UploadMeta {
//     pub fn id(&self) -> &str {
//         &self.id
//     }

//     // pub fn new(id: String) -> Self {
//     //     Self { id }
//     // }
// }

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

// pub struct UploadedAudio {
//     pub link: String,
//     pub id: String,
//     pub config: S3UploadMeta,
// }

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

pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    existing_config: Option<S3UploadMeta>,
    screenshot_path: Option<PathBuf>,
    meta: Option<S3VideoMeta>,
    channel: Option<Channel<UploadProgress>>,
) -> Result<UploadedVideo, AuthedApiError> {
    println!("Uploading video {video_id}...");

    let client = reqwest::Client::new();
    let s3_config = match existing_config {
        Some(config) => config,
        None => create_or_get_video(app, false, Some(video_id.clone()), None, meta, None).await?,
    };

    let presigned_put = presigned_s3_put(
        app,
        PresignedS3PutRequest {
            video_id: video_id.clone(),
            subpath: "result.mp4".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: Some(build_video_meta(&file_path)?),
        },
    )
    .await?;

    let file = tokio::fs::File::open(&file_path)
        .await
        .map_err(|e| format!("Failed to open file: {e}"))?;

    let metadata = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to get file metadata: {e}"))?;

    let total_size = metadata.len();

    let reader_stream = tokio_util::io::ReaderStream::new(file);

    let mut bytes_uploaded = 0u64;
    let mut progress = UploadProgressUpdater::new(app.clone(), video_id);

    let progress_stream = reader_stream.inspect(move |chunk| {
        if let Ok(chunk) = chunk {
            bytes_uploaded += chunk.len() as u64;
        }

        if bytes_uploaded > 0 {
            if let Some(channel) = &channel {
                channel
                    .send(UploadProgress {
                        progress: bytes_uploaded as f64 / total_size as f64,
                    })
                    .ok();
            }

            progress.update(bytes_uploaded, total_size);
        }
    });

    let screenshot_upload = match screenshot_path {
        Some(screenshot_path) if screenshot_path.exists() => {
            Some(prepare_screenshot_upload(app, &s3_config, screenshot_path))
        }
        _ => None,
    };

    let video_upload = client
        .put(presigned_put)
        .body(reqwest::Body::wrap_stream(progress_stream))
        .header(CONTENT_LENGTH, metadata.len());

    let (video_upload, screenshot_result): (
        Result<reqwest::Response, reqwest::Error>,
        Option<Result<reqwest::Response, String>>,
    ) = tokio::join!(video_upload.send(), async {
        if let Some(screenshot_req) = screenshot_upload {
            Some(screenshot_req.await)
        } else {
            None
        }
    });

    let response = video_upload.map_err(|e| format!("Failed to send upload file request: {e}"))?;

    if response.status().is_success() {
        println!("Video uploaded successfully");

        if let Some(Ok(screenshot_response)) = screenshot_result {
            if screenshot_response.status().is_success() {
                println!("Screenshot uploaded successfully");
            } else {
                println!(
                    "Failed to upload screenshot: {}",
                    screenshot_response.status()
                );
            }
        }

        return Ok(UploadedVideo {
            link: app.make_app_url(format!("/s/{}", &s3_config.id)).await,
            id: s3_config.id.clone(),
            config: s3_config,
        });
    }

    let status = response.status();
    let error_body = response
        .text()
        .await
        .unwrap_or_else(|_| "<no response body>".to_string());
    tracing::error!(
        "Failed to upload file. Status: {}. Body: {}",
        status,
        error_body
    );
    Err(format!("Failed to upload file. Status: {status}. Body: {error_body}").into())
}

pub async fn upload_image(app: &AppHandle, file_path: PathBuf) -> Result<UploadedImage, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let s3_config = create_or_get_video(app, true, None, None, None, None).await?;

    let presigned_put = presigned_s3_put(
        app,
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: file_name,
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
    )
    .await?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let response = client
        .put(presigned_put)
        .header(CONTENT_LENGTH, file_content.len())
        .body(file_content)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload file request: {e}"))?;

    if response.status().is_success() {
        println!("File uploaded successfully");
        return Ok(UploadedImage {
            link: app.make_app_url(format!("/s/{}", &s3_config.id)).await,
            id: s3_config.id,
        });
    }

    let status = response.status();
    let error_body = response
        .text()
        .await
        .unwrap_or_else(|_| "<no response body>".to_string());
    tracing::error!(
        "Failed to upload file. Status: {}. Body: {}",
        status,
        error_body
    );
    Err(format!(
        "Failed to upload file. Status: {status}. Body: {error_body}"
    ))
}

pub async fn create_or_get_video(
    app: &AppHandle,
    is_screenshot: bool,
    video_id: Option<String>,
    name: Option<String>,
    meta: Option<S3VideoMeta>,
    organization_id: Option<String>,
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

    if let Some(org_id) = organization_id {
        s3_config_url.push_str(&format!("&orgId={}", org_id));
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
    video_id: String,
    subpath: String,
    method: PresignedS3PutRequestMethod,
    #[serde(flatten)]
    meta: Option<S3VideoMeta>,
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

// fn build_audio_upload_body(
//     path: &PathBuf,
//     base: S3UploadBody,
// ) -> Result<S3AudioUploadBody, String> {
//     let input =
//         ffmpeg::format::input(path).map_err(|e| format!("Failed to read input file: {e}"))?;
//     let stream = input
//         .streams()
//         .best(ffmpeg::media::Type::Audio)
//         .ok_or_else(|| "Failed to find appropriate audio stream in file".to_string())?;

//     let duration_millis = input.duration() as f64 / 1000.;

//     let codec = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
//         .map_err(|e| format!("Unable to read audio codec information: {e}"))?;
//     let codec_name = codec.id();

//     let is_mp3 = path.extension().is_some_and(|ext| ext == "mp3");

//     Ok(S3AudioUploadBody {
//         base,
//         duration: duration_millis.to_string(),
//         audio_codec: format!("{codec_name:?}").replace("Id::", "").to_lowercase(),
//         is_mp3,
//     })
// }

pub async fn prepare_screenshot_upload(
    app: &AppHandle,
    s3_config: &S3UploadMeta,
    screenshot_path: PathBuf,
) -> Result<reqwest::Response, String> {
    let presigned_put = presigned_s3_put(
        app,
        PresignedS3PutRequest {
            video_id: s3_config.id.clone(),
            subpath: "screenshot/screen-capture.jpg".to_string(),
            method: PresignedS3PutRequestMethod::Put,
            meta: None,
        },
    )
    .await?;

    let compressed_image = compress_image(screenshot_path).await?;

    reqwest::Client::new()
        .put(presigned_put)
        .header(CONTENT_LENGTH, compressed_image.len())
        .body(compressed_image)
        .send()
        .await
        .map_err(|e| format!("Error uploading screenshot: {e}"))
}

async fn compress_image(path: PathBuf) -> Result<Vec<u8>, String> {
    task::spawn_blocking(move || {
        let img = ImageReader::open(&path)
            .map_err(|e| format!("Failed to open image: {e}"))?
            .decode()
            .map_err(|e| format!("Failed to decode image: {e}"))?;

        let new_width = img.width() / 2;
        let new_height = img.height() / 2;

        let resized_img = img.resize(new_width, new_height, image::imageops::FilterType::Nearest);

        let mut buffer = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut buffer, 30);
        encoder
            .encode(
                resized_img.as_bytes(),
                new_width,
                new_height,
                resized_img.color().into(),
            )
            .map_err(|e| format!("Failed to compress image: {e}"))?;

        Ok(buffer)
    })
    .await
    .map_err(|e| format!("Failed to compress image: {e}"))?
}

// a typical recommended chunk size is 5MB (AWS min part size).
const CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5MB
// const MIN_PART_SIZE: u64 = 5 * 1024 * 1024; // For non-final parts

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultipartCompleteResponse<'a> {
    video_id: &'a str,
    upload_id: &'a str,
    parts: &'a [UploadedPart],
    #[serde(flatten)]
    meta: Option<S3VideoMeta>,
}

pub struct InstantMultipartUpload {}

impl InstantMultipartUpload {
    pub async fn run(
        app: AppHandle,
        video_id: String,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
        realtime_video_done: Option<Receiver<()>>,
    ) -> Result<(), String> {
        use std::time::Duration;

        use tokio::time::sleep;

        // --------------------------------------------
        // basic constants and info for chunk approach
        // --------------------------------------------
        let client = reqwest::Client::new();
        let s3_config = pre_created_video.config;

        let mut uploaded_parts = Vec::new();
        let mut part_number = 1;
        let mut last_uploaded_position: u64 = 0;
        let mut progress = UploadProgressUpdater::new(app.clone(), pre_created_video.id.clone());

        // --------------------------------------------
        // initiate the multipart upload
        // --------------------------------------------
        debug!("Initiating multipart upload for {video_id}...");
        let initiate_response = match app
            .authed_api_request("/api/upload/multipart/initiate", |c, url| {
                c.post(url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": s3_config.id,
                        "contentType": "video/mp4"
                    }))
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("Failed to initiate multipart upload: {e}"));
            }
        };

        if !initiate_response.status().is_success() {
            let status = initiate_response.status();
            let error_body = initiate_response
                .text()
                .await
                .unwrap_or_else(|_| "<no response body>".to_string());
            return Err(format!(
                "Failed to initiate multipart upload. Status: {status}. Body: {error_body}"
            ));
        }

        let initiate_data = match initiate_response.json::<serde_json::Value>().await {
            Ok(d) => d,
            Err(e) => {
                return Err(format!("Failed to parse initiate response: {e}"));
            }
        };

        let upload_id = match initiate_data.get("uploadId") {
            Some(val) => val.as_str().unwrap_or("").to_string(),
            None => {
                return Err("No uploadId returned from initiate endpoint".to_string());
            }
        };

        if upload_id.is_empty() {
            return Err("Empty uploadId returned from initiate endpoint".to_string());
        }

        println!("Multipart upload initiated with ID: {upload_id}");

        let mut realtime_is_done = realtime_video_done.as_ref().map(|_| false);

        // --------------------------------------------
        // Main loop while upload not complete:
        //   - If we have >= CHUNK_SIZE new data, upload.
        //   - If recording hasn't stopped, keep waiting.
        //   - If recording stopped, do leftover final(s).
        // --------------------------------------------
        loop {
            if !realtime_is_done.unwrap_or(true)
                && let Some(realtime_video_done) = &realtime_video_done
            {
                match realtime_video_done.try_recv() {
                    Ok(_) => {
                        realtime_is_done = Some(true);
                    }
                    Err(flume::TryRecvError::Empty) => {}
                    _ => {
                        warn!("cancelling upload as realtime generation failed");
                        return Err("cancelling upload as realtime generation failed".to_string());
                    }
                }
            }

            // Check the file's current size
            if !file_path.exists() {
                println!("File no longer exists, aborting upload");
                return Err("File no longer exists".to_string());
            }

            let file_size = match tokio::fs::metadata(&file_path).await {
                Ok(md) => md.len(),
                Err(e) => {
                    println!("Failed to get file metadata: {e}");
                    sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            let new_data_size = file_size - last_uploaded_position;

            if ((new_data_size >= CHUNK_SIZE)
                || new_data_size > 0 && realtime_is_done.unwrap_or(false))
                || (realtime_is_done.is_none() && new_data_size > 0)
            {
                // We have a full chunk to send
                match Self::upload_chunk(
                    &app,
                    &client,
                    &file_path,
                    &s3_config.id,
                    &upload_id,
                    &mut part_number,
                    &mut last_uploaded_position,
                    new_data_size.min(CHUNK_SIZE),
                    &mut progress,
                )
                .await
                {
                    Ok(part) => {
                        uploaded_parts.push(part);
                    }
                    Err(e) => {
                        println!(
                            "Error uploading chunk (part {part_number}): {e}. Retrying in 1s..."
                        );
                        sleep(Duration::from_secs(1)).await;
                    }
                }
            } else if new_data_size == 0 && realtime_is_done.unwrap_or(true) {
                if realtime_is_done.unwrap_or(false) {
                    info!("realtime video done, uploading header chunk");

                    let part = Self::upload_chunk(
                        &app,
                        &client,
                        &file_path,
                        &s3_config.id,
                        &upload_id,
                        &mut 1,
                        &mut 0,
                        uploaded_parts[0].size as u64,
                        &mut progress,
                    )
                    .await
                    .map_err(|err| format!("Failed to re-upload first chunk: {err}"))?;

                    uploaded_parts[0] = part;
                    println!("Successfully re-uploaded first chunk",);
                }

                // All leftover chunks are now uploaded. We finalize.
                println!(
                    "Completing multipart upload with {} parts",
                    uploaded_parts.len()
                );
                Self::finalize_upload(&app, &file_path, &s3_config.id, &upload_id, &uploaded_parts)
                    .await?;

                break;
            } else {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }

        // Copy link to clipboard early
        let _ = app.clipboard().write_text(pre_created_video.link.clone());

        Ok(())
    }

    /// Upload a single chunk from the file at `last_uploaded_position` for `chunk_size` bytes.
    /// Advances `last_uploaded_position` accordingly. Returns JSON { PartNumber, ETag, Size }.
    #[allow(clippy::too_many_arguments)]
    async fn upload_chunk(
        app: &AppHandle,
        client: &reqwest::Client,
        file_path: &PathBuf,
        video_id: &str,
        upload_id: &str,
        part_number: &mut i32,
        last_uploaded_position: &mut u64,
        chunk_size: u64,
        progress: &mut UploadProgressUpdater,
    ) -> Result<UploadedPart, String> {
        let file_size = match tokio::fs::metadata(file_path).await {
            Ok(metadata) => metadata.len(),
            Err(e) => return Err(format!("Failed to get file metadata: {e}")),
        };

        // Check if we're at the end of the file
        if *last_uploaded_position >= file_size {
            return Err("No more data to read - already at end of file".to_string());
        }

        // Calculate how much we can actually read
        let remaining = file_size - *last_uploaded_position;
        let bytes_to_read = std::cmp::min(chunk_size, remaining);

        let mut file = tokio::fs::File::open(file_path)
            .await
            .map_err(|e| format!("Failed to open file: {e}"))?;

        // Log before seeking
        println!(
            "Seeking to offset {} for part {} (file size: {}, remaining: {})",
            *last_uploaded_position, *part_number, file_size, remaining
        );

        // Seek to the position we left off
        if let Err(e) = file
            .seek(std::io::SeekFrom::Start(*last_uploaded_position))
            .await
        {
            return Err(format!("Failed to seek in file: {e}"));
        }

        // Read exactly bytes_to_read
        let mut chunk = vec![0u8; bytes_to_read as usize];
        let mut total_read = 0;

        while total_read < bytes_to_read as usize {
            match file.read(&mut chunk[total_read..]).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    total_read += n;
                    println!("Read {n} bytes, total so far: {total_read}/{bytes_to_read}");
                }
                Err(e) => return Err(format!("Failed to read chunk from file: {e}")),
            }
        }

        if total_read == 0 {
            return Err("No data to upload for this part.".to_string());
        }

        // Truncate the buffer to the actual bytes read
        chunk.truncate(total_read);

        // Basic content‑MD5 for data integrity
        let md5_sum = {
            let digest = md5::compute(&chunk);
            base64::encode(digest.0)
        };

        // Verify file position to ensure we're not experiencing file handle issues
        let pos_after_read = file
            .seek(std::io::SeekFrom::Current(0))
            .await
            .map_err(|e| format!("Failed to get current file position: {e}"))?;

        let expected_pos = *last_uploaded_position + total_read as u64;
        if pos_after_read != expected_pos {
            println!(
                "WARNING: File position after read ({pos_after_read}) doesn't match expected position ({expected_pos})"
            );
        }

        let file_size = tokio::fs::metadata(file_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let remaining = file_size - *last_uploaded_position;

        println!(
            "File size: {}, Last uploaded: {}, Remaining: {}, chunk_size: {}, part: {}",
            file_size, *last_uploaded_position, remaining, chunk_size, *part_number
        );
        println!(
            "Uploading part {} ({} bytes), MD5: {}",
            *part_number, total_read, md5_sum
        );

        // Request presigned URL for this part
        let presign_response = match app
            .authed_api_request("/api/upload/multipart/presign-part", |c, url| {
                c.post(url)
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "videoId": video_id,
                        "uploadId": upload_id,
                        "partNumber": *part_number,
                        "md5Sum": &md5_sum
                    }))
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return Err(format!(
                    "Failed to request presigned URL for part {}: {}",
                    *part_number, e
                ));
            }
        };

        progress.update(expected_pos, file_size);

        if !presign_response.status().is_success() {
            let status = presign_response.status();
            let error_body = presign_response
                .text()
                .await
                .unwrap_or_else(|_| "<no response body>".to_string());
            return Err(format!(
                "Presign-part failed for part {}: status={}, body={}",
                *part_number, status, error_body
            ));
        }

        let presign_data = match presign_response.json::<serde_json::Value>().await {
            Ok(d) => d,
            Err(e) => return Err(format!("Failed to parse presigned URL response: {e}")),
        };

        let presigned_url = presign_data
            .get("presignedUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        if presigned_url.is_empty() {
            return Err(format!("Empty presignedUrl for part {}", *part_number));
        }

        // Upload the chunk with retry
        let mut retry_count = 0;
        let max_retries = 3;
        let mut etag: Option<String> = None;

        while retry_count < max_retries && etag.is_none() {
            println!(
                "Sending part {} (attempt {}/{}): {} bytes",
                *part_number,
                retry_count + 1,
                max_retries,
                total_read
            );

            match client
                .put(&presigned_url)
                .header("Content-MD5", &md5_sum)
                .timeout(Duration::from_secs(120))
                .body(chunk.clone())
                .send()
                .await
            {
                Ok(upload_response) => {
                    if upload_response.status().is_success() {
                        if let Some(etag_val) = upload_response.headers().get("ETag") {
                            let e = etag_val
                                .to_str()
                                .unwrap_or("")
                                .trim_matches('"')
                                .to_string();
                            println!("Received ETag {} for part {}", e, *part_number);
                            etag = Some(e);
                        } else {
                            println!("No ETag in response for part {}", *part_number);
                            retry_count += 1;
                            sleep(Duration::from_secs(2)).await;
                        }
                    } else {
                        println!(
                            "Failed part {} (status {}). Will retry if possible.",
                            *part_number,
                            upload_response.status()
                        );
                        if let Ok(body) = upload_response.text().await {
                            println!("Error response: {body}");
                        }
                        retry_count += 1;
                        sleep(Duration::from_secs(2)).await;
                    }
                }
                Err(e) => {
                    println!(
                        "Part {} upload error (attempt {}/{}): {}",
                        *part_number,
                        retry_count + 1,
                        max_retries,
                        e
                    );
                    retry_count += 1;
                    sleep(Duration::from_secs(2)).await;
                }
            }
        }

        let etag = match etag {
            Some(e) => e,
            None => {
                return Err(format!(
                    "Failed to upload part {} after {} attempts",
                    *part_number, max_retries
                ));
            }
        };

        // Advance the global progress
        *last_uploaded_position += total_read as u64;
        println!(
            "After upload: new last_uploaded_position is {} ({}% of file)",
            *last_uploaded_position,
            (*last_uploaded_position as f64 / file_size as f64 * 100.0) as u32
        );

        let part = UploadedPart {
            part_number: *part_number,
            etag,
            size: total_read,
        };
        *part_number += 1;
        Ok(part)
    }

    /// Completes the multipart upload with the stored parts.
    /// Logs a final location if the complete call is successful.
    async fn finalize_upload(
        app: &AppHandle,
        file_path: &PathBuf,
        video_id: &str,
        upload_id: &str,
        uploaded_parts: &[UploadedPart],
    ) -> Result<(), String> {
        println!(
            "Completing multipart upload with {} parts",
            uploaded_parts.len()
        );

        if uploaded_parts.is_empty() {
            return Err("No parts uploaded before finalizing.".to_string());
        }

        let mut total_bytes_in_parts = 0;
        for part in uploaded_parts {
            let pn = part.part_number;
            let size = part.size;
            let etag = &part.etag;
            total_bytes_in_parts += part.size;
            println!("Part {pn}: {size} bytes (ETag: {etag})");
        }

        let file_final_size = tokio::fs::metadata(file_path)
            .await
            .map(|md| md.len())
            .unwrap_or(0);

        println!("Sum of all parts: {total_bytes_in_parts} bytes");
        println!("File size on disk: {file_final_size} bytes");
        println!("Proceeding with multipart upload completion...");

        let metadata = build_video_meta(file_path)
            .map_err(|e| error!("Failed to get video metadata: {e}"))
            .ok();

        let complete_response = match app
            .authed_api_request("/api/upload/multipart/complete", |c, url| {
                c.post(url).header("Content-Type", "application/json").json(
                    &MultipartCompleteResponse {
                        video_id,
                        upload_id,
                        parts: uploaded_parts,
                        meta: metadata,
                    },
                )
            })
            .await
        {
            Ok(response) => response,
            Err(e) => {
                return Err(format!("Failed to complete multipart upload: {e}"));
            }
        };

        if !complete_response.status().is_success() {
            let status = complete_response.status();
            let error_body = complete_response
                .text()
                .await
                .unwrap_or_else(|_| "<no response body>".to_string());
            return Err(format!(
                "Failed to complete multipart upload. Status: {status}. Body: {error_body}"
            ));
        }

        let complete_data = match complete_response.json::<serde_json::Value>().await {
            Ok(d) => d,
            Err(e) => {
                return Err(format!("Failed to parse completion response: {e}"));
            }
        };

        if let Some(location) = complete_data.get("location") {
            println!("Multipart upload complete. Final S3 location: {location}");
        } else {
            println!("Multipart upload complete. No 'location' in response.");
        }

        println!("Multipart upload complete for {video_id}.");
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UploadedPart {
    part_number: i32,
    etag: String,
    size: usize,
}
