use core::fmt;
use regex::Regex;
use reqwest;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::str;
use std::sync::Arc;

use crate::recording::RecordingOptions;
use crate::utils::ffmpeg_path_as_str;

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

#[derive(Clone, Copy, Debug)]
pub enum RecordingAssetType {
    ScreenCapture,
    CombinedSourceSegment,
    CombinedSourcePlaylist,
}

impl fmt::Display for RecordingAssetType {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            RecordingAssetType::ScreenCapture => write!(f, "ScreenCapture"),
            RecordingAssetType::CombinedSourceSegment => write!(f, "CombinedSourceSegment"),
            RecordingAssetType::CombinedSourcePlaylist => write!(f, "CombinedSourcePlaylist"),
        }
    }
}

#[tracing::instrument(skip(on_progress))]
pub async fn upload_recording_asset<F>(
    options: RecordingOptions,
    file_path: PathBuf,
    file_type: RecordingAssetType,
    on_progress: Option<F>,
) -> Result<String, String>
where
    F: Fn(ProgressInfo) + Send + Sync + 'static,
{
    tracing::info!("Uploading recording asset {file_type}...");

    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let file_key_base = format!("{}/{}", options.user_id, options.video_id);
    let file_key = match file_type {
        RecordingAssetType::ScreenCapture => {
            format!("{file_key_base}/screenshot/screen-capture.jpg")
        }
        RecordingAssetType::CombinedSourceSegment => {
            format!("{file_key_base}/combined-source/{}", file_name)
        }
        RecordingAssetType::CombinedSourcePlaylist => {
            format!("{file_key_base}/combined-source/stream.m3u8")
        }
    };

    tracing::info!("File key: {file_key}");

    let server_url_base: &'static str = dotenvy_macro::dotenv!("NEXT_PUBLIC_URL");
    let server_url = format!("{}/api/upload/signed", server_url_base);

    let body = S3UploadBody {
        user_id: options.user_id,
        file_key: file_key.clone(),
        aws_bucket: options.aws_bucket,
        aws_region: options.aws_region,
    };

    let body_json = match file_type {
        RecordingAssetType::ScreenCapture | RecordingAssetType::CombinedSourcePlaylist => {
            serde_json::json!(body)
        }
        RecordingAssetType::CombinedSourceSegment => {
            let (codec_name, width, height, frame_rate, bit_rate) = log_video_info(&file_path)
                .map_err(|e| format!("Failed to log video info: {}", e))?;

            let duration = get_video_duration(&file_path)
                .map_err(|e| format!("Failed to get video duration: {}", e))?;

            serde_json::json!(S3VideoUploadBody {
                base: body,
                duration: duration.to_string(),
                resolution: format!("{}x{}", width, height),
                framerate: frame_rate,
                bandwidth: bit_rate,
                video_codec: codec_name,
            })
        }
    };

    let client = reqwest::Client::new();
    let server_response = client
        .post(server_url)
        .json(&body_json)
        .send()
        .await
        .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read response from Next.js handler: {}", e))?;

    tracing::info!("Server response: {}", server_response);

    // Deserialize the server response
    let presigned_post_data: JsonValue = serde_json::from_str(&server_response)
        .map_err(|e| format!("Failed to deserialize server response: {}", e))?;

    // Construct the multipart form for the file upload
    let fields = presigned_post_data["presignedPostData"]["fields"]
        .as_object()
        .ok_or("Fields object is missing or not an object")?;

    let mut form = reqwest::multipart::Form::new();

    for (key, value) in fields.iter() {
        let value_str = value
            .as_str()
            .ok_or(format!("Value for key '{}' is not a string", key))?;
        form = form.text(key.to_string(), value_str.to_owned());
    }

    tracing::info!("Uploading file: {file_path:?}");

    let mime_type = match file_path.extension() {
        Some(ext) if ext == "aac" => "audio/aac",
        Some(ext) if ext == "mp3" => "audio/mpeg",
        Some(ext) if ext == "webm" => "audio/webm",
        Some(ext) if ext == "m3u8" => "application/x-mpegURL",
        _ => "video/mp2t",
    };

    let file_data = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let post_url = presigned_post_data["presignedPostData"]["url"]
        .as_str()
        .ok_or("URL is missing or not a string")?;

    tracing::info!("Uploading file to: {}", post_url);

    let response = match file_type {
        // Only send combined source playlist in chunks.
        RecordingAssetType::CombinedSourcePlaylist => {
            // TODO: Might need adjustments
            let chunk_size = 1024 * 1024; // 1MB chunks
            post_multipart_chunks(
                &client,
                post_url,
                form,
                file_name.clone(),
                file_data,
                mime_type,
                chunk_size,
                on_progress,
            )
            .await
        }
        _ => client.post(post_url).multipart(form).send().await,
    };

    match response {
        Ok(response) if response.status().is_success() => {
            tracing::info!("File uploaded successfully");
        }
        Ok(response) => {
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
            return Err(format!(
                "Failed to upload file. Status: {}. Body: {}",
                status, error_body
            ));
        }
        Err(e) => {
            return Err(format!("Failed to send upload file request: {}", e));
        }
    }

    tracing::info!("Removing file after upload: {file_path:?}");
    let remove_result = tokio::fs::remove_file(&file_path).await;
    match &remove_result {
        Ok(_) => tracing::info!("File removed successfully"),
        Err(e) => tracing::info!("Failed to remove file after upload: {}", e),
    }
    remove_result.map_err(|e| format!("Failed to remove file after upload: {}", e))?;

    Ok(file_key)
}

pub fn get_video_duration(file_path: &Path) -> Result<f64, std::io::Error> {
    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

    let output = Command::new(ffmpeg_binary_path_str)
        .arg("-i")
        .arg(file_path)
        .output()?;

    let output_str = str::from_utf8(&output.stderr).unwrap();
    let duration_regex = Regex::new(r"Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})").unwrap();
    let caps = duration_regex.captures(output_str).unwrap();

    let hours: f64 = caps.get(1).unwrap().as_str().parse().unwrap();
    let minutes: f64 = caps.get(2).unwrap().as_str().parse().unwrap();
    let seconds: f64 = caps.get(3).unwrap().as_str().parse::<f64>().unwrap();
    let milliseconds: f64 = caps.get(4).unwrap().as_str().parse::<f64>().unwrap() / 100.0;
    let duration = hours * 3600.0 + minutes * 60.0 + seconds + milliseconds;

    Ok(duration)
}

fn log_video_info(file_path: &Path) -> Result<(String, String, String, String, String), String> {
    let ffprobe_binary_path_str = ffmpeg_path_as_str()
        .unwrap()
        .replace("ffmpeg", "ffprobe")
        .to_owned();

    let output: Output = Command::new(ffprobe_binary_path_str)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("stream=bit_rate,codec_name,height,width,r_frame_rate")
        .arg("-of")
        .arg("default=noprint_wrappers=1:nokey=1")
        .arg(file_path)
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {}", e))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe exited with non-zero status: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let info = String::from_utf8_lossy(&output.stdout);
    let info_parts: Vec<&str> = info.split('\n').collect();
    let codec_name = info_parts[0].to_string();
    let width: String = info_parts[1].to_string();
    let height: String = info_parts[2].to_string();

    // Parse frame rate as a fraction and convert to float
    let frame_rate_parts: Vec<&str> = info_parts[3].split('/').collect();
    let frame_rate: f64 =
        frame_rate_parts[0].parse::<f64>().unwrap() / frame_rate_parts[1].parse::<f64>().unwrap();
    let frame_rate: String = frame_rate.to_string();

    let bit_rate: String = info_parts[4].to_string();

    Ok((codec_name, width, height, frame_rate, bit_rate))
}

#[derive(Clone, Debug, Serialize, Deserialize, specta::Type)]
pub struct ProgressInfo {
    pub progress: f64,
    pub speed: f64,
    pub total_size: u64,
    pub uploaded_bytes: u64,
    pub error: Option<String>,
}

async fn post_multipart_chunks<F>(
    client: &reqwest::Client,
    url: &str,
    mut form: reqwest::multipart::Form,
    file_name: String,
    file_data: Vec<u8>,
    mime_type: &str,
    chunk_size: usize,
    progress_callback: Option<F>,
) -> Result<reqwest::Response, reqwest::Error>
where
    F: Fn(ProgressInfo) + Send + Sync + 'static,
{
    let total_size = file_data.len() as u64;
    let start_time = tokio::time::Instant::now();

    let on_progress = Arc::new(progress_callback);
    let on_progress_clone = Arc::clone(&on_progress);

    let mut uploaded_bytes = 0u64;

    // Create a stream of file chunks using async_stream
    // Credit: https://github.com/mihaigalos/aim/ (MIT License.)
    // source: https://github.com/mihaigalos/aim/blob/723daabfb8c97a0b57bf772500c90b62bffcf598/src/https.rs#L44
    let file_stream = async_stream::stream! {
        let on_progress_ref = on_progress_clone.as_ref();

        for chunk in file_data.chunks(chunk_size) {
            let chunk = chunk.to_vec();

            if let Some(callback) = on_progress_ref {
                uploaded_bytes += chunk.len() as u64;

                let progress = (uploaded_bytes as f64 / total_size as f64) * 100.0;
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = uploaded_bytes as f64 / elapsed;

                callback(ProgressInfo {
                    progress,
                    speed,
                    total_size,
                    uploaded_bytes,
                    error: None,
                });
            }

            yield Ok::<_, std::io::Error>(chunk);
        }
    };

    // Create a Part from the stream
    let file_part = reqwest::multipart::Part::stream(reqwest::Body::wrap_stream(file_stream))
        .file_name(file_name)
        .mime_str(mime_type)?;

    form = form.part("file", file_part);

    let response = client.post(url).multipart(form).send().await;

    match response {
        Ok(resp) => {
            if let Some(callback) = on_progress.as_ref() {
                callback(ProgressInfo {
                    progress: 100.0,
                    speed: total_size as f64 / start_time.elapsed().as_secs_f64(),
                    total_size,
                    uploaded_bytes: total_size,
                    error: None,
                });
            }
            Ok(resp)
        }
        Err(e) => {
            let error_msg = e.to_string();
            if let Some(callback) = on_progress.as_ref() {
                callback(ProgressInfo {
                    progress: 0.0,
                    speed: 0.0,
                    total_size,
                    uploaded_bytes: 0,
                    error: Some(error_msg.clone()),
                });
            }
            Err(e)
        }
    }
}
