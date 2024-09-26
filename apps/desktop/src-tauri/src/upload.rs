// credit @filleduchaos

use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use reqwest::{multipart::Form, Client, StatusCode};
use std::io::Cursor;
use std::path::PathBuf;
use tokio::task;

#[derive(serde::Deserialize)]
struct S3UploadMeta {
    id: String,
    user_id: String,
    aws_region: String,
    aws_bucket: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct S3UploadBody {
    user_id: String,
    file_key: String,
    aws_bucket: String,
    aws_region: String,
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

pub struct UploadedVideo {
    pub link: String,
    pub id: String,
}

pub struct UploadedImage {
    pub link: String,
    pub id: String,
}

pub async fn upload_video(
    video_id: String,
    auth_token: String,
    file_path: PathBuf,
) -> Result<UploadedVideo, String> {
    println!("Uploading video {video_id}...");

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
    let s3_config = get_s3_config(&client, server_url_base, &auth_token, false).await?;

    let file_key = format!("{}/{}/{}", s3_config.user_id, s3_config.id, file_name);

    println!("File key: {file_key}");

    let body = build_video_upload_body(
        &file_path,
        S3UploadBody {
            user_id: s3_config.user_id.clone(),
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket.clone(),
            aws_region: s3_config.aws_region.clone(),
        },
    )?;

    let (upload_url, mut form) =
        presigned_s3_url(&client, server_url_base, body, &auth_token).await?;

    let file_bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;
    let file_part = reqwest::multipart::Part::bytes(file_bytes)
        .file_name(file_name.clone())
        .mime_str("video/mp4")
        .map_err(|e| format!("Error setting MIME type: {}", e))?;
    form = form.part("file", file_part);

    // Prepare screenshot upload
    let screenshot_path = file_path
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("screenshots")
        .join("display.jpg");

    let screenshot_upload = if screenshot_path.exists() {
        Some(prepare_screenshot_upload(&client, &s3_config, &auth_token, screenshot_path).await?)
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
            link: format!("{server_url_base}/s/{}", &s3_config.id),
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

pub async fn upload_image(
    auth_token: String,
    file_path: PathBuf,
    solo_screenshot: bool,
) -> Result<UploadedImage, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let client = reqwest::Client::new();
    let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");

    let s3_config = get_s3_config(&client, server_url_base, &auth_token, solo_screenshot).await?;

    let file_key: String = if solo_screenshot {
        format!("{}/{}/{}", s3_config.user_id, s3_config.id, file_name)
    } else {
        format!(
            "{}/{}/screenshot/screen-capture.jpg",
            s3_config.user_id, s3_config.id
        )
    };

    println!("File key: {file_key}");

    let body = S3ImageUploadBody {
        base: S3UploadBody {
            user_id: s3_config.user_id,
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket,
            aws_region: s3_config.aws_region,
        },
    };

    let (upload_url, mut form) =
        presigned_s3_url_image(&client, server_url_base, body, &auth_token).await?;

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
            link: format!("{server_url_base}/s/{}", &s3_config.id),
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

async fn get_s3_config(
    client: &Client,
    server_url_base: &str,
    auth_token: &str,
    is_screenshot: bool,
) -> Result<S3UploadMeta, String> {
    let config_url = if is_screenshot {
        format!(
            "{}/api/desktop/video/create?origin={}&recordingMode=desktopMP4&isScreenshot=true",
            server_url_base, server_url_base
        )
    } else {
        format!(
            "{}/api/desktop/video/create?origin={}&recordingMode=desktopMP4",
            server_url_base, server_url_base
        )
    };

    let response = client
        .get(config_url)
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?;

    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    let response_text = response
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {}", e))?;

    let config = serde_json::from_str::<S3UploadMeta>(&response_text).map_err(|e| {
        format!(
            "Failed to deserialize response: {}. Response body: {}",
            e, response_text
        )
    })?;

    Ok(config)
}

async fn presigned_s3_url(
    client: &Client,
    server_url_base: &str,
    body: S3VideoUploadBody,
    auth_token: &str,
) -> Result<(String, Form), String> {
    let presigned_upload_url = format!("{}/api/upload/signed", server_url_base);

    let response = client
        .post(presigned_upload_url)
        .json(&serde_json::json!(body))
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
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
    client: &Client,
    server_url_base: &str,
    body: S3ImageUploadBody,
    auth_token: &str,
) -> Result<(String, Form), String> {
    let presigned_upload_url = format!("{}/api/upload/signed", server_url_base);

    let response = client
        .post(presigned_upload_url)
        .json(&serde_json::json!(body))
        .header("Authorization", format!("Bearer {auth_token}"))
        .send()
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

fn build_video_upload_body(
    path: &PathBuf,
    base: S3UploadBody,
) -> Result<S3VideoUploadBody, String> {
    let input =
        ffmpeg_next::format::input(path).map_err(|e| format!("Failed to read input file: {e}"))?;
    let stream = input
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .ok_or_else(|| "Failed to find appropriate video stream in file".to_string())?;

    let duration_millis = input.duration() as f64 / 1000.;

    let codec = ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
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

async fn prepare_screenshot_upload(
    client: &Client,
    s3_config: &S3UploadMeta,
    auth_token: &str,
    screenshot_path: PathBuf,
) -> Result<(String, Form), String> {
    let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
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
        },
    };

    let (upload_url, mut form) =
        presigned_s3_url_image(client, server_url_base, body, auth_token).await?;

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
