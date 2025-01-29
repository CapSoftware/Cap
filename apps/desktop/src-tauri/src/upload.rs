// credit @filleduchaos

use futures::stream;
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use reqwest::{multipart::Form, StatusCode};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::task;

use crate::web_api::{self, ManagerExt};

use crate::UploadProgress;
use serde::de::{self, Deserializer};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Deserialize, Serialize, Clone, Type)]
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
    is_individual: bool,
    existing_config: Option<S3UploadMeta>,
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

    let file_key = if is_individual {
        format!(
            "{}/{}/individual/{}",
            s3_config.user_id(),
            s3_config.id(),
            file_name
        )
    } else {
        format!("{}/{}/{}", s3_config.user_id(), s3_config.id(), file_name)
    };

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

    // Wrap file_bytes in an Arc for shared ownership
    let file_bytes = std::sync::Arc::new(file_bytes);

    // Create a stream that reports progress
    let file_part =
        {
            let progress_counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let app_handle = app.clone();
            let file_bytes = file_bytes.clone();

            let stream = stream::iter((0..file_bytes.len()).step_by(1024 * 1024).map(
                move |start| {
                    let end = (start + 1024 * 1024).min(file_bytes.len());
                    let chunk = file_bytes[start..end].to_vec();

                    let current = progress_counter
                        .fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::SeqCst)
                        as f64;

                    // Emit progress every chunk
                    UploadProgress {
                        progress: current / total_size,
                        message: format!("{:.0}%", (current / total_size * 100.0)),
                    }
                    .emit(&app_handle)
                    .ok();

                    Ok::<Vec<u8>, std::io::Error>(chunk)
                },
            ));

            reqwest::multipart::Part::stream_with_length(
                reqwest::Body::wrap_stream(stream),
                total_size as u64,
            )
            .file_name(file_name.clone())
            .mime_str("video/mp4")
            .map_err(|e| format!("Error setting MIME type: {}", e))?
        };

    let form = form.part("file", file_part);

    // Prepare screenshot upload
    let screenshot_path = file_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("screenshots")
        .join("display.jpg");

    let screenshot_upload = if screenshot_path.exists() {
        Some(prepare_screenshot_upload(app, &s3_config, screenshot_path).await?)
    } else {
        None
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
        // Final progress update
        UploadProgress {
            progress: 1.0,
            message: "100%".to_string(),
        }
        .emit(app)
        .ok();

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
    let origin = "http://tauri.localhost";
    let config_url = web_api::make_url(if let Some(id) = video_id {
        format!(
            "/api/desktop/video/create?origin={}&recordingMode=desktopMP4&videoId={}",
            origin, id
        )
    } else if is_screenshot {
        format!(
            "/api/desktop/video/create?origin={}&recordingMode=desktopMP4&isScreenshot=true",
            origin
        )
    } else {
        format!(
            "/api/desktop/video/create?origin={}&recordingMode=desktopMP4",
            origin
        )
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

async fn prepare_screenshot_upload(
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
