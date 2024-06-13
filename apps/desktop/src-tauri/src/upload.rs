use regex::Regex;
use reqwest;
use serde_json::Value as JsonValue;
use std::path::Path;
use std::process::{Command, Output};
use std::str;

use crate::recording::RecordingOptions;
use crate::utils::ffmpeg_path_as_str;

pub enum FileType {
    VideoWithAudio,
    Screenshot,
}

impl std::fmt::Display for FileType {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            FileType::VideoWithAudio => write!(f, "video-with-audio"),
            FileType::Screenshot => write!(f, "screenshot"),
        }
    }
}

pub async fn upload_file(
    options: Option<RecordingOptions>,
    file_path: String,
    file_type: FileType,
) -> Result<String, String> {
    if let Some(ref options) = options {
        println!("Uploading video...");

        let duration = get_video_duration(&file_path)
            .map_err(|e| format!("Failed to get video duration: {}", e))?;
        let duration_str = duration.to_string();

        let file_name = Path::new(&file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid file path")?
            .to_string();

        let file_key = format!(
            "{}/{}/{}/{}",
            options.user_id,
            options.video_id,
            file_type.to_string(),
            file_name
        );

        let server_url_base: &'static str = dotenv_codegen::dotenv!("NEXT_PUBLIC_URL");
        let server_url = format!("{}/api/upload/signed", server_url_base);

        let body = match file_type {
            FileType::VideoWithAudio => {
                let (codec_name, width, height, frame_rate, bit_rate) = log_video_info(&file_path)
                    .map_err(|e| format!("Failed to log video info: {}", e))?;

                serde_json::json!({
                    "userId": options.user_id,
                    "fileKey": file_key,
                    "awsBucket": options.aws_bucket,
                    "awsRegion": options.aws_region,
                    "duration": duration_str,
                    "resolution": format!("{}x{}", width, height),
                    "framerate": frame_rate,
                    "bandwidth": bit_rate,
                    "videoCodec": codec_name,
                })
            }
            FileType::Screenshot => {
                serde_json::json!({
                    "userId": options.user_id,
                    "fileKey": file_key,
                    "awsBucket": options.aws_bucket,
                    "awsRegion": options.aws_region,
                    "duration": duration_str,
                })
            }
        };

        let client = reqwest::Client::new();
        let server_response = client
            .post(server_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Failed to send request to Next.js handler: {}", e))?
            .text()
            .await
            .map_err(|e| format!("Failed to read response from Next.js handler: {}", e))?;

        println!("Server response: {}", server_response);

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

        println!("Uploading file: {}", file_path);

        let mime_type = if file_path.to_lowercase().ends_with(".aac") {
            "audio/aac"
        } else if file_path.to_lowercase().ends_with(".webm") {
            "audio/webm"
        } else {
            "video/mp2t"
        };

        let file_bytes = tokio::fs::read(&file_path)
            .await
            .map_err(|e| format!("Failed to read file: {}", e))?;
        let file_part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name.clone())
            .mime_str(mime_type)
            .map_err(|e| format!("Error setting MIME type: {}", e))?;

        form = form.part("file", file_part);

        let post_url = presigned_post_data["presignedPostData"]["url"]
            .as_str()
            .ok_or("URL is missing or not a string")?;

        println!("Uploading file to: {}", post_url);

        let response = client.post(post_url).multipart(form).send().await;

        match response {
            Ok(response) if response.status().is_success() => {
                println!("File uploaded successfully");
            }
            Ok(response) => {
                let status = response.status();
                let error_body = response
                    .text()
                    .await
                    .unwrap_or_else(|_| "<no response body>".to_string());
                eprintln!(
                    "Failed to upload file. Status: {}. Body: {}",
                    status, error_body
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

        println!("Removing file after upload: {}", file_path);
        let remove_result = tokio::fs::remove_file(&file_path).await;
        match &remove_result {
            Ok(_) => println!("File removed successfully"),
            Err(e) => println!("Failed to remove file after upload: {}", e),
        }
        remove_result.map_err(|e| format!("Failed to remove file after upload: {}", e))?;

        Ok(file_key)
    } else {
        return Err("No recording options provided".to_string());
    }
}

pub fn get_video_duration(file_path: &str) -> Result<f64, std::io::Error> {
    let ffmpeg_binary_path_str = ffmpeg_path_as_str().unwrap().to_owned();

    let output = Command::new(ffmpeg_binary_path_str)
        .arg("-i")
        .arg(file_path)
        .output()?;

    let output_str = str::from_utf8(&output.stderr).unwrap();
    let duration_regex = Regex::new(r"Duration: (\d{2}):(\d{2}):(\d{2})\.\d{2}").unwrap();
    let caps = duration_regex.captures(output_str).unwrap();

    let hours: f64 = caps.get(1).unwrap().as_str().parse().unwrap();
    let minutes: f64 = caps.get(2).unwrap().as_str().parse().unwrap();
    let seconds: f64 = caps.get(3).unwrap().as_str().parse().unwrap();

    let duration = hours * 3600.0 + minutes * 60.0 + seconds;

    Ok(duration)
}

fn log_video_info(file_path: &str) -> Result<(String, String, String, String, String), String> {
    let output: Output = Command::new("ffprobe")
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
