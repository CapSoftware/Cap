// credit @filleduchaos

use cap_utils::spawn_actor;
use futures::stream;
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use reqwest::{multipart::Form, StatusCode};
use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_specta::Event;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::mpsc;
use tokio::sync::RwLock;
use tokio::task;
use tokio::time::sleep;

use crate::web_api::{self, ManagerExt};

use crate::{notifications, App, MutableState, RecordingStopped, UploadProgress, VideoUploadInfo};
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Clone, Type, Debug)]
pub struct S3UploadMeta {
    id: String,
    user_id: String,
    #[serde(default)]
    aws_region: String,
    #[serde(default, deserialize_with = "deserialize_empty_object_as_string")]
    aws_bucket: String,
    #[serde(default)]
    aws_endpoint: String,
}

fn deserialize_empty_object_as_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    struct StringOrObject;

    impl<'de> de::Visitor<'de> for StringOrObject {
        type Value = String;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("string or empty object")
        }

        fn visit_str<E>(self, value: &str) -> Result<String, E>
        where
            E: de::Error,
        {
            Ok(value.to_string())
        }

        fn visit_string<E>(self, value: String) -> Result<String, E>
        where
            E: de::Error,
        {
            Ok(value)
        }

        fn visit_map<M>(self, _map: M) -> Result<String, M::Error>
        where
            M: de::MapAccess<'de>,
        {
            // Return empty string for empty objects
            Ok(String::new())
        }
    }

    deserializer.deserialize_any(StringOrObject)
}

impl S3UploadMeta {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn user_id(&self) -> &str {
        &self.user_id
    }

    pub fn aws_region(&self) -> &str {
        &self.aws_region
    }

    pub fn aws_bucket(&self) -> &str {
        &self.aws_bucket
    }

    pub fn aws_endpoint(&self) -> &str {
        &self.aws_endpoint
    }

    pub fn new(
        id: String,
        user_id: String,
        aws_region: String,
        aws_bucket: String,
        aws_endpoint: String,
    ) -> Self {
        Self {
            id,
            user_id,
            aws_region,
            aws_bucket,
            aws_endpoint,
        }
    }

    pub fn ensure_defaults(&mut self) {
        if self.aws_region.is_empty() {
            self.aws_region = std::env::var("NEXT_PUBLIC_CAP_AWS_REGION")
                .unwrap_or_else(|_| "us-east-1".to_string());
        }
        if self.aws_bucket.is_empty() {
            self.aws_bucket =
                std::env::var("NEXT_PUBLIC_CAP_AWS_BUCKET").unwrap_or_else(|_| "capso".to_string());
        }
        if self.aws_endpoint.is_empty() {
            self.aws_endpoint = std::env::var("NEXT_PUBLIC_CAP_AWS_ENDPOINT")
                .unwrap_or_else(|_| "https://s3.amazonaws.com".to_string());
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct S3UploadBody {
    user_id: String,
    file_key: String,
    aws_bucket: String,
    aws_region: String,
    aws_endpoint: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct S3VideoUploadBody {
    #[serde(flatten)]
    base: S3UploadBody,
    duration: String,
    resolution: String,
    framerate: String,
    bandwidth: String,
    video_codec: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct S3ImageUploadBody {
    #[serde(flatten)]
    base: S3UploadBody,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct S3AudioUploadBody {
    #[serde(flatten)]
    base: S3UploadBody,
    duration: String,
    audio_codec: String,
    is_mp3: bool,
}

pub struct UploadedVideo {
    pub link: String,
    pub id: String,
    pub config: S3UploadMeta,
}

pub struct UploadedImage {
    pub link: String,
    pub id: String,
}

pub struct UploadedAudio {
    pub link: String,
    pub id: String,
    pub config: S3UploadMeta,
}

pub async fn upload_video(
    app: &AppHandle,
    video_id: String,
    file_path: PathBuf,
    existing_config: Option<S3UploadMeta>,
    screenshot_path: Option<PathBuf>,
) -> Result<UploadedVideo, String> {
    println!("Uploading video {video_id}...");

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let s3_config = match existing_config {
        Some(config) => config,
        None => get_s3_config(app, false, Some(video_id)).await?,
    };

    let file_key = format!(
        "{}/{}/{}",
        s3_config.user_id(),
        s3_config.id(),
        "result.mp4"
    );

    let body = build_video_upload_body(
        &file_path,
        S3UploadBody {
            user_id: s3_config.user_id().to_string(),
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket().to_string(),
            aws_region: s3_config.aws_region().to_string(),
            aws_endpoint: s3_config.aws_endpoint().to_string(),
        },
    )?;

    let (upload_url, form) = presigned_s3_url(app, body).await?;

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let total_size = file_bytes.len() as f64;

    // Create a stream that reports progress
    let file_part = reqwest::multipart::Part::stream_with_length(
        reqwest::Body::from(file_bytes),
        total_size as u64,
    )
    .file_name(file_name.clone())
    .mime_str("video/mp4")
    .map_err(|e| format!("Error setting MIME type: {}", e))?;

    let form = form.part("file", file_part);

    let screenshot_upload = match screenshot_path {
        Some(screenshot_path) if screenshot_path.exists() => {
            Some(prepare_screenshot_upload(app, &s3_config, screenshot_path).await?)
        }
        _ => None,
    };

    let (video_upload, screenshot_result): (
        Result<reqwest::Response, reqwest::Error>,
        Option<Result<reqwest::Response, reqwest::Error>>,
    ) = tokio::join!(client.post(upload_url).multipart(form).send(), async {
        if let Some((screenshot_url, screenshot_form)) = screenshot_upload {
            Some(
                client
                    .post(screenshot_url)
                    .multipart(screenshot_form)
                    .send()
                    .await,
            )
        } else {
            None
        }
    });

    let response =
        video_upload.map_err(|e| format!("Failed to send upload file request: {}", e))?;

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
            link: web_api::make_url(format!("/s/{}", &s3_config.id)),
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
    Err(format!(
        "Failed to upload file. Status: {}. Body: {}",
        status, error_body
    ))
}

pub async fn upload_image(app: &AppHandle, file_path: PathBuf) -> Result<UploadedImage, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let s3_config = get_s3_config(app, true, None).await?;

    let file_key = format!("{}/{}/{}", s3_config.user_id, s3_config.id, file_name);

    println!("File key: {file_key}");

    let body = S3ImageUploadBody {
        base: S3UploadBody {
            user_id: s3_config.user_id,
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket,
            aws_region: s3_config.aws_region,
            aws_endpoint: s3_config.aws_endpoint,
        },
    };

    let (upload_url, mut form) = presigned_s3_url_image(app, body).await?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let file_part = reqwest::multipart::Part::bytes(file_content)
        .file_name(file_name.clone())
        .mime_str("image/jpeg")
        .map_err(|e| format!("Error setting MIME type: {}", e))?;
    form = form.part("file", file_part);

    let response = client
        .post(upload_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload file request: {}", e))?;

    if response.status().is_success() {
        println!("File uploaded successfully");
        return Ok(UploadedImage {
            link: web_api::make_url(format!("/s/{}", &s3_config.id)),
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
        "Failed to upload file. Status: {}. Body: {}",
        status, error_body
    ))
}

pub async fn upload_audio(app: &AppHandle, file_path: PathBuf) -> Result<UploadedAudio, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let s3_config = get_s3_config(app, false, None).await?;

    let file_key = format!("{}/{}/{}", s3_config.user_id, s3_config.id, file_name);

    println!("File key: {file_key}");

    let body = build_audio_upload_body(
        &file_path,
        S3UploadBody {
            user_id: s3_config.user_id.clone(),
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket.clone(),
            aws_region: s3_config.aws_region.clone(),
            aws_endpoint: s3_config.aws_endpoint.clone(),
        },
    )?;

    let (upload_url, mut form) = presigned_s3_url_audio(app, body).await?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let mime_type = if file_name.ends_with(".mp3") {
        "audio/mpeg"
    } else {
        "audio/wav"
    };

    let file_part = reqwest::multipart::Part::bytes(file_content)
        .file_name(file_name.clone())
        .mime_str(mime_type)
        .map_err(|e| format!("Error setting MIME type: {}", e))?;
    form = form.part("file", file_part);

    let response = client
        .post(upload_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload file request: {}", e))?;

    if response.status().is_success() {
        println!("Audio file uploaded successfully");
        return Ok(UploadedAudio {
            link: web_api::make_url(format!("/s/{}", &s3_config.id)),
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
        "Failed to upload audio file. Status: {}. Body: {}",
        status,
        error_body
    );
    Err(format!(
        "Failed to upload audio file. Status: {}. Body: {}",
        status, error_body
    ))
}

pub async fn get_s3_config(
    app: &AppHandle,
    is_screenshot: bool,
    video_id: Option<String>,
) -> Result<S3UploadMeta, String> {
    let config_url = web_api::make_url(if let Some(id) = video_id {
        format!("/api/desktop/video/create?recordingMode=desktopMP4&videoId={id}")
    } else if is_screenshot {
        "/api/desktop/video/create?recordingMode=desktopMP4&isScreenshot=true".to_string()
    } else {
        "/api/desktop/video/create?recordingMode=desktopMP4".to_string()
    });

    let response = app
        .authed_api_request(|client| client.get(config_url))
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let mut config = serde_json::from_str::<S3UploadMeta>(&response_text).map_err(|e| {
        format!(
            "Failed to deserialize response: {}. Response body: {}",
            e, response_text
        )
    })?;

    config.ensure_defaults();
    Ok(config)
}

async fn presigned_s3_url(
    app: &AppHandle,
    body: S3VideoUploadBody,
) -> Result<(String, Form), String> {
    let response = app
        .authed_api_request(|client| {
            client
                .post(web_api::make_url("/api/upload/signed"))
                .json(&serde_json::json!(body))
        })
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    let presigned_post_data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to deserialize server response: {}", e))?;

    let fields = presigned_post_data["presignedPostData"]["fields"]
        .as_object()
        .ok_or("Fields object is missing or not an object")?;
    let post_url = presigned_post_data["presignedPostData"]["url"]
        .as_str()
        .ok_or("URL is missing or not a string")?
        .to_string();

    let mut form = Form::new();

    for (key, value) in fields.iter() {
        let value_str = value
            .as_str()
            .ok_or(format!("Value for key '{}' is not a string", key))?;
        form = form.text(key.to_string(), value_str.to_owned());
    }

    Ok((post_url, form))
}

async fn presigned_s3_url_image(
    app: &AppHandle,
    body: S3ImageUploadBody,
) -> Result<(String, Form), String> {
    let response = app
        .authed_api_request(|client| {
            client
                .post(web_api::make_url("/api/upload/signed"))
                .json(&serde_json::json!(body))
        })
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?;

    let presigned_post_data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to deserialize server response: {}", e))?;

    let fields = presigned_post_data["presignedPostData"]["fields"]
        .as_object()
        .ok_or("Fields object is missing or not an object")?;
    let post_url = presigned_post_data["presignedPostData"]["url"]
        .as_str()
        .ok_or("URL is missing or not a string")?
        .to_string();

    let mut form = Form::new();

    for (key, value) in fields.iter() {
        let value_str = value
            .as_str()
            .ok_or(format!("Value for key '{}' is not a string", key))?;
        form = form.text(key.to_string(), value_str.to_owned());
    }

    Ok((post_url, form))
}

async fn presigned_s3_url_audio(
    app: &AppHandle,
    body: S3AudioUploadBody,
) -> Result<(String, Form), String> {
    let response = app
        .authed_api_request(|client| {
            client
                .post(web_api::make_url("/api/upload/signed"))
                .json(&serde_json::json!(body))
        })
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?;

    let presigned_post_data = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("Failed to deserialize server response: {}", e))?;

    let fields = presigned_post_data["presignedPostData"]["fields"]
        .as_object()
        .ok_or("Fields object is missing or not an object")?;
    let post_url = presigned_post_data["presignedPostData"]["url"]
        .as_str()
        .ok_or("URL is missing or not a string")?
        .to_string();

    let mut form = Form::new();

    for (key, value) in fields.iter() {
        let value_str = value
            .as_str()
            .ok_or(format!("Value for key '{}' is not a string", key))?;
        form = form.text(key.to_string(), value_str.to_owned());
    }

    Ok((post_url, form))
}

fn build_video_upload_body(
    path: &PathBuf,
    base: S3UploadBody,
) -> Result<S3VideoUploadBody, String> {
    let input =
        ffmpeg::format::input(path).map_err(|e| format!("Failed to read input file: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| "Failed to find appropriate video stream in file".to_string())?;

    let duration_millis = input.duration() as f64 / 1000.;

    let codec = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("Unable to read video codec information: {e}"))?;
    let codec_name = codec.id();
    let video = codec.decoder().video().unwrap();
    let width = video.width();
    let height = video.height();
    let frame_rate = video
        .frame_rate()
        .map(|fps| fps.to_string())
        .unwrap_or("-".into());
    let bit_rate = video.bit_rate();

    Ok(S3VideoUploadBody {
        base,
        duration: duration_millis.to_string(),
        resolution: format!("{}x{}", width, height),
        framerate: frame_rate,
        bandwidth: bit_rate.to_string(),
        video_codec: format!("{codec_name:?}").replace("Id::", "").to_lowercase(),
    })
}

fn build_audio_upload_body(
    path: &PathBuf,
    base: S3UploadBody,
) -> Result<S3AudioUploadBody, String> {
    let input =
        ffmpeg::format::input(path).map_err(|e| format!("Failed to read input file: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| "Failed to find appropriate audio stream in file".to_string())?;

    let duration_millis = input.duration() as f64 / 1000.;

    let codec = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(|e| format!("Unable to read audio codec information: {e}"))?;
    let codec_name = codec.id();

    let is_mp3 = path.extension().map_or(false, |ext| ext == "mp3");

    Ok(S3AudioUploadBody {
        base,
        duration: duration_millis.to_string(),
        audio_codec: format!("{codec_name:?}").replace("Id::", "").to_lowercase(),
        is_mp3,
    })
}

pub async fn upload_individual_file(
    app: &AppHandle,
    file_path: PathBuf,
    s3_config: S3UploadMeta,
    file_name: &str,
    is_audio: bool,
) -> Result<(), String> {
    let client = reqwest::Client::new();

    let file_key = format!(
        "{}/{}/individual/{}",
        s3_config.user_id, s3_config.id, file_name
    );

    let base_upload_body = S3UploadBody {
        user_id: s3_config.user_id.clone(),
        file_key: file_key.clone(),
        aws_bucket: s3_config.aws_bucket.clone(),
        aws_region: s3_config.aws_region.clone(),
        aws_endpoint: s3_config.aws_endpoint.clone(),
    };

    let (upload_url, mut form) = if is_audio {
        let audio_body = build_audio_upload_body(&file_path, base_upload_body)?;
        presigned_s3_url_audio(app, audio_body).await?
    } else {
        let video_body = build_video_upload_body(&file_path, base_upload_body)?;
        presigned_s3_url(app, video_body).await?
    };

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let mime_type = if is_audio { "audio/mpeg" } else { "video/mp4" };

    let file_part = reqwest::multipart::Part::bytes(file_content)
        .file_name(file_name.to_string())
        .mime_str(mime_type)
        .map_err(|e| format!("Error setting MIME type: {}", e))?;
    form = form.part("file", file_part);

    let response = client
        .post(upload_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload file request: {}", e))?;

    if response.status().is_success() {
        println!("Individual file uploaded successfully");
        Ok(())
    } else {
        let status = response.status();
        let error_body = response
            .text()
            .await
            .unwrap_or_else(|_| "<no response body>".to_string());
        Err(format!(
            "Failed to upload individual file. Status: {}. Body: {}",
            status, error_body
        ))
    }
}

pub async fn prepare_screenshot_upload(
    app: &AppHandle,
    s3_config: &S3UploadMeta,
    screenshot_path: PathBuf,
) -> Result<(String, Form), String> {
    let file_name = screenshot_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid screenshot file path")?
        .to_string();
    let file_key = format!(
        "{}/{}/screenshot/screen-capture.jpg",
        s3_config.user_id, s3_config.id
    );

    let body = S3ImageUploadBody {
        base: S3UploadBody {
            user_id: s3_config.user_id.clone(),
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket.clone(),
            aws_region: s3_config.aws_region.clone(),
            aws_endpoint: s3_config.aws_endpoint.clone(),
        },
    };

    let (upload_url, mut form) = presigned_s3_url_image(app, body).await?;

    let compressed_image = compress_image(screenshot_path).await?;

    let file_part = reqwest::multipart::Part::bytes(compressed_image)
        .file_name(file_name)
        .mime_str("image/jpeg")
        .map_err(|e| format!("Error setting MIME type for screenshot: {}", e))?;
    form = form.part("file", file_part);

    Ok((upload_url, form))
}

async fn compress_image(path: PathBuf) -> Result<Vec<u8>, String> {
    task::spawn_blocking(move || {
        let img = ImageReader::open(&path)
            .map_err(|e| format!("Failed to open image: {}", e))?
            .decode()
            .map_err(|e| format!("Failed to decode image: {}", e))?;

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
            .map_err(|e| format!("Failed to compress image: {}", e))?;

        Ok(buffer)
    })
    .await
    .map_err(|e| format!("Failed to compress image: {}", e))?
}

// a typical recommended chunk size is 5MB (AWS min part size).
const CHUNK_SIZE: u64 = 5 * 1024 * 1024; // 5MB
const MIN_PART_SIZE: u64 = 5 * 1024 * 1024; // For non-final parts

pub struct ProgressiveUploadTask {
    pub handle: tokio::task::JoinHandle<Result<(), String>>,
}

impl ProgressiveUploadTask {
    /// starts a progressive (multipart) upload that runs until recording stops
    /// and the file has stabilized (no additional data is being written).
    pub fn spawn(
        app: AppHandle,
        video_id: String,
        file_path: PathBuf,
        pre_created_video: VideoUploadInfo,
    ) -> Self {
        Self {
            handle: spawn_actor(async move {
                use std::time::Duration;
                use tokio::sync::mpsc;
                use tokio::time::sleep;

                // --------------------------------------------
                // listen for a "RecordingStopped" signal. We'll
                // finalize only after we know there's no more
                // incoming data from the pipeline (plus we do
                // an extra stabilization check).
                // --------------------------------------------
                let (recording_end_tx, mut recording_end_rx) = mpsc::channel::<()>(1);

                RecordingStopped::listen_any(&app.clone(), {
                    let app = app.clone();
                    move |_| {
                        let tx = recording_end_tx.clone();
                        let app = app.clone();

                        tokio::spawn(async move {
                            let state = app.state::<Arc<RwLock<App>>>();
                            let app_state = state.read().await;
                            if app_state.current_recording.is_none() {
                                // Recording truly ended
                                let _ = tx.send(()).await;
                            }
                        });
                    }
                });

                // --------------------------------------------
                // basic constants and info for chunk approach
                // --------------------------------------------
                let file_name = "result.mp4";
                let client = reqwest::Client::new();
                let s3_config = pre_created_video.config;
                let file_key = format!("{}/{}/{}", s3_config.user_id(), s3_config.id(), file_name);

                let mut uploaded_parts = Vec::new();
                let mut part_number = 1;
                let mut last_uploaded_position: u64 = 0;

                let mut upload_complete = false;
                let mut recording_stopped = false;

                println!("Starting multipart upload for {video_id}...");

                // --------------------------------------------
                // wait until the file hits 5MB or more
                // before initiating the multipart upload.
                // --------------------------------------------
                loop {
                    if !file_path.exists() {
                        println!("File does not exist yet, waiting...");
                        sleep(Duration::from_millis(500)).await;
                        continue;
                    }
                    match tokio::fs::metadata(&file_path).await {
                        Ok(metadata) => {
                            if metadata.len() < MIN_PART_SIZE {
                                println!(
                                "Waiting for file to grow to at least 5MB before starting upload"
                            );
                                sleep(Duration::from_millis(500)).await;
                                continue;
                            } else {
                                break;
                            }
                        }
                        Err(e) => {
                            println!("Failed to get file metadata: {}", e);
                            sleep(Duration::from_millis(500)).await;
                        }
                    }
                }

                // Copy link to clipboard early
                let _ = app.clipboard().write_text(pre_created_video.link.clone());

                notifications::send_notification(
                    &app,
                    notifications::NotificationType::ShareableLinkCopied,
                );

                // --------------------------------------------
                // initiate the multipart upload
                // --------------------------------------------
                println!("Initiating multipart upload for {video_id}...");
                let initiate_response = match app
                    .authed_api_request(|c| {
                        c.post(web_api::make_url("/api/upload/multipart/initiate"))
                            .header("Content-Type", "application/json")
                            .json(&serde_json::json!({
                                "fileKey": file_key,
                                "contentType": "video/mp4"
                            }))
                    })
                    .await
                {
                    Ok(r) => r,
                    Err(e) => {
                        return Err(format!("Failed to initiate multipart upload: {}", e));
                    }
                };

                if !initiate_response.status().is_success() {
                    let status = initiate_response.status();
                    let error_body = initiate_response
                        .text()
                        .await
                        .unwrap_or_else(|_| "<no response body>".to_string());
                    return Err(format!(
                        "Failed to initiate multipart upload. Status: {}. Body: {}",
                        status, error_body
                    ));
                }

                let initiate_data = match initiate_response.json::<serde_json::Value>().await {
                    Ok(d) => d,
                    Err(e) => {
                        return Err(format!("Failed to parse initiate response: {}", e));
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

                println!("Multipart upload initiated with ID: {}", upload_id);

                // --------------------------------------------
                // Main loop while upload not complete:
                //   - If we have >= CHUNK_SIZE new data, upload.
                //   - If recording hasn't stopped, keep waiting.
                //   - If recording stopped, do leftover final(s).
                // --------------------------------------------
                while !upload_complete {
                    if !recording_stopped {
                        // Check if the recording pipeline is done
                        if let Ok(_) = recording_end_rx.try_recv() {
                            println!("Recording end detected, will finalize soon.");
                            recording_stopped = true;
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
                            println!("Failed to get file metadata: {}", e);
                            sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                    };

                    let new_data_size = file_size.saturating_sub(last_uploaded_position);

                    if new_data_size >= CHUNK_SIZE {
                        // We have a full chunk to send
                        match Self::upload_chunk(
                            &app,
                            &client,
                            &file_path,
                            &file_key,
                            &upload_id,
                            &mut part_number,
                            &mut last_uploaded_position,
                            CHUNK_SIZE,
                        )
                        .await
                        {
                            Ok(part) => {
                                uploaded_parts.push(part);
                            }
                            Err(e) => {
                                println!(
                                    "Error uploading chunk (part {}): {}. Retrying in 1s...",
                                    part_number, e
                                );
                                sleep(Duration::from_secs(1)).await;
                            }
                        }
                    } else {
                        // If recording is not done, keep waiting a bit
                        if !recording_stopped {
                            sleep(Duration::from_millis(500)).await;
                            continue;
                        }

                        // --------------------------------------------
                        // Recording has stopped. We do repeated
                        // checks to ensure the file is stable (not
                        // still growing). Then we keep uploading
                        // leftover chunks until no more data arrives.
                        // --------------------------------------------
                        let max_stabilize_attempts = 8;
                        let mut attempts = 0;

                        // We'll loop to catch any last bits that appear
                        // after we do a leftover chunk upload.
                        loop {
                            // Wait for the file to stabilize
                            println!("Waiting for file to stabilize...");
                            let mut stable_count = 0;
                            let stable_required = 3; // e.g. 3 consecutive stable checks

                            // Keep track of last known size
                            let mut prev_size = tokio::fs::metadata(&file_path)
                                .await
                                .map(|md| md.len())
                                .unwrap_or(0);

                            while stable_count < stable_required {
                                sleep(Duration::from_secs(1)).await;
                                let size_now = match tokio::fs::metadata(&file_path).await {
                                    Ok(md) => md.len(),
                                    Err(_) => 0,
                                };
                                if size_now == prev_size {
                                    stable_count += 1;
                                } else {
                                    stable_count = 0;
                                    prev_size = size_now;
                                }
                            }

                            // At this point, the file has stayed the same size
                            // for ~ stable_required seconds.
                            let final_size = prev_size;
                            let leftover_size = final_size.saturating_sub(last_uploaded_position);

                            // Double-check moov if you want
                            // let moov_found = found_moov_atom(&file_path).await;

                            if leftover_size > 0 {
                                if leftover_size >= MIN_PART_SIZE {
                                    // We still have at least 5MB leftover, treat it like a normal part:
                                    println!(
                                "File stabilized, but leftover >= 5MB. Uploading leftover chunk of {} bytes.",
                                leftover_size
                            );
                                    match Self::upload_chunk(
                                        &app,
                                        &client,
                                        &file_path,
                                        &file_key,
                                        &upload_id,
                                        &mut part_number,
                                        &mut last_uploaded_position,
                                        leftover_size, // read leftover
                                    )
                                    .await
                                    {
                                        Ok(part) => {
                                            uploaded_parts.push(part);
                                        }
                                        Err(e) => {
                                            return Err(format!(
                                                "Failed uploading leftover chunk: {}",
                                                e
                                            ));
                                        }
                                    }
                                } else {
                                    // Less than 5 MB leftover -> final chunk
                                    println!(
                                    "Uploading final leftover chunk of {} bytes before completion",
                                    leftover_size
                                );
                                    match Self::upload_chunk(
                                        &app,
                                        &client,
                                        &file_path,
                                        &file_key,
                                        &upload_id,
                                        &mut part_number,
                                        &mut last_uploaded_position,
                                        leftover_size,
                                    )
                                    .await
                                    {
                                        Ok(part) => {
                                            uploaded_parts.push(part);
                                            println!(
                                                "Successfully uploaded leftover chunk, part {}",
                                                part_number - 1
                                            );
                                        }
                                        Err(e) => {
                                            return Err(format!(
                                                "Failed to upload leftover chunk: {}",
                                                e
                                            ));
                                        }
                                    }
                                }

                                // We just uploaded a leftover chunk, but let's see
                                // if more data arrives. We'll try again. If no more
                                // new data arrives, we can finalize.
                                attempts += 1;
                                if attempts > max_stabilize_attempts {
                                    println!(
                                    "Reached maximum leftover attempts, proceeding to finalize."
                                );
                                    break;
                                }
                            } else {
                                // No leftover. We have stabilized with no new data.
                                println!("File is stable with no leftover data, finalizing...");
                                break;
                            }
                        }

                        match Self::upload_chunk(
                            &app,
                            &client,
                            &file_path,
                            &file_key,
                            &upload_id,
                            &mut 1,
                            &mut 0,
                            uploaded_parts[0].size as u64,
                        )
                        .await
                        {
                            Ok(part) => {
                                uploaded_parts[0] = part;
                                println!("Successfully re-uploaded first chunk",);
                            }
                            Err(e) => {
                                return Err(format!("Failed to re-upload first chunk"));
                            }
                        }

                        // All leftover chunks are now uploaded. We finalize.
                        println!(
                            "Completing multipart upload with {} parts",
                            uploaded_parts.len()
                        );
                        Self::finalize_upload(
                            &app,
                            &file_path,
                            &file_key,
                            &upload_id,
                            &uploaded_parts,
                            &video_id,
                        )
                        .await?;

                        upload_complete = true;
                    }
                }

                Ok(())
            }),
        }
    }

    /// Upload a single chunk from the file at `last_uploaded_position` for `chunk_size` bytes.
    /// Advances `last_uploaded_position` accordingly. Returns JSON { PartNumber, ETag, Size }.
    async fn upload_chunk(
        app: &AppHandle,
        client: &reqwest::Client,
        file_path: &PathBuf,
        file_key: &str,
        upload_id: &str,
        part_number: &mut i32,
        last_uploaded_position: &mut u64,
        chunk_size: u64,
    ) -> Result<UploadedPart, String> {
        let file_size = match tokio::fs::metadata(file_path).await {
            Ok(metadata) => metadata.len(),
            Err(e) => return Err(format!("Failed to get file metadata: {}", e)),
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
            .map_err(|e| format!("Failed to open file: {}", e))?;

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
            return Err(format!("Failed to seek in file: {}", e));
        }

        // Read exactly bytes_to_read
        let mut chunk = vec![0u8; bytes_to_read as usize];
        let mut total_read = 0;

        while total_read < bytes_to_read as usize {
            match file.read(&mut chunk[total_read..]).await {
                Ok(0) => break, // EOF
                Ok(n) => {
                    total_read += n;
                    println!(
                        "Read {} bytes, total so far: {}/{}",
                        n, total_read, bytes_to_read
                    );
                }
                Err(e) => return Err(format!("Failed to read chunk from file: {}", e)),
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
            .map_err(|e| format!("Failed to get current file position: {}", e))?;

        let expected_pos = *last_uploaded_position + total_read as u64;
        if pos_after_read != expected_pos {
            println!(
                "WARNING: File position after read ({}) doesn't match expected position ({})",
                pos_after_read, expected_pos
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
            .authed_api_request(|c| {
                c.post(web_api::make_url("/api/upload/multipart/presign-part"))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "fileKey": file_key,
                        "uploadId": upload_id,
                        "partNumber": *part_number
                    }))
            })
            .await
        {
            Ok(r) => r,
            Err(e) => {
                return Err(format!(
                    "Failed to request presigned URL for part {}: {}",
                    *part_number, e
                ))
            }
        };

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
            Err(e) => return Err(format!("Failed to parse presigned URL response: {}", e)),
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
                            println!("Error response: {}", body);
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
                ))
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
        file_key: &str,
        upload_id: &str,
        uploaded_parts: &[UploadedPart],
        video_id: &str,
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
            println!("Part {}: {} bytes (ETag: {})", pn, size, etag);
        }

        let file_final_size = tokio::fs::metadata(file_path)
            .await
            .map(|md| md.len())
            .unwrap_or(0);

        println!("Sum of all parts: {} bytes", total_bytes_in_parts);
        println!("File size on disk: {} bytes", file_final_size);
        println!("Proceeding with multipart upload completion...");

        let complete_response = match app
            .authed_api_request(|c| {
                c.post(web_api::make_url("/api/upload/multipart/complete"))
                    .header("Content-Type", "application/json")
                    .json(&serde_json::json!({
                        "fileKey": file_key,
                        "uploadId": upload_id,
                        "parts": uploaded_parts
                    }))
            })
            .await
        {
            Ok(response) => response,
            Err(e) => {
                return Err(format!("Failed to complete multipart upload: {}", e));
            }
        };

        if !complete_response.status().is_success() {
            let status = complete_response.status();
            let error_body = complete_response
                .text()
                .await
                .unwrap_or_else(|_| "<no response body>".to_string());
            return Err(format!(
                "Failed to complete multipart upload. Status: {}. Body: {}",
                status, error_body
            ));
        }

        let complete_data = match complete_response.json::<serde_json::Value>().await {
            Ok(d) => d,
            Err(e) => {
                return Err(format!("Failed to parse completion response: {}", e));
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
