// credit @filleduchaos

use reqwest::{multipart::Form, Client, StatusCode};
use std::path::PathBuf;

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

pub struct UploadedVideo {
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
    let s3_config = get_s3_config(&client, server_url_base, &auth_token).await?;

    let file_key = format!("{}/{}/{}", s3_config.user_id, s3_config.id, file_name);

    println!("File key: {file_key}");

    let body = build_video_upload_body(
        &file_path,
        S3UploadBody {
            user_id: s3_config.user_id,
            file_key: file_key.clone(),
            aws_bucket: s3_config.aws_bucket,
            aws_region: s3_config.aws_region,
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

    let response = client
        .post(upload_url)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Failed to send upload file request: {}", e))?;

    if response.status().is_success() {
        println!("File uploaded successfully");
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

async fn get_s3_config(
    client: &Client,
    server_url_base: &str,
    auth_token: &str,
) -> Result<S3UploadMeta, String> {
    let config_url = format!(
        "{}/api/desktop/video/create?origin={}&recordingMode=desktopMP4",
        server_url_base, server_url_base
    );

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
