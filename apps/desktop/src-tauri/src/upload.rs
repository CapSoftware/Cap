use serde_json::Value as JsonValue;
use std::path::{Path};
use std::process::Command;
use reqwest;

use crate::recording::RecordingOptions;
use crate::utils::ffmpeg_path_as_str;

#[tauri::command]
pub async fn upload_file(
    options: Option<RecordingOptions>,
    file_path: String,
    file_type: String,
) -> Result<String, String> {
    if let Some(ref options) = options {
        println!("Uploading video...");

        let video_duration = get_video_duration(&file_path).await?;
        let video_duration_str = format!("{:.1}", video_duration);

        let file_name = Path::new(&file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid file path")?
            .to_string();

        let file_key = format!("{}/{}/{}/{}", options.user_id, options.video_id, file_type, file_name);

        let server_url = format!("http://localhost:3000/api/upload/signed");

        // Create the request body for the Next.js handler
        let body = serde_json::json!({
            "userId": options.user_id,
            "duration": video_duration_str,
            "fileKey": file_key,
            "awsBucket": options.aws_bucket,
            "awsRegion": options.aws_region,
        });

        let client = reqwest::Client::new();
        let server_response = client.post(server_url)
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
        let fields = presigned_post_data["presignedPostData"]["fields"].as_object()
            .ok_or("Fields object is missing or not an object")?;
        
        let mut form = reqwest::multipart::Form::new();
        
        for (key, value) in fields.iter() {
            let value_str = value.as_str()
                .ok_or(format!("Value for key '{}' is not a string", key))?;
            form = form.text(key.to_string(), value_str.to_owned());
        }

        println!("Uploading file: {}", file_path);

        let file_bytes = tokio::fs::read(&file_path).await.map_err(|e| format!("Failed to read file: {}", e))?;
        let file_part = reqwest::multipart::Part::bytes(file_bytes)
            .file_name(file_name.clone())
            .mime_str("video/mp2t")
            .map_err(|e| format!("Error setting MIME type: {}", e))?;

        form = form.part("file", file_part);

        let post_url = presigned_post_data["presignedPostData"]["url"].as_str()
            .ok_or("URL is missing or not a string")?;

        println!("Uploading file to: {}", post_url);

        let response = client.post(post_url)
            .multipart(form)
            .send()
            .await;

        match response {
            Ok(response) if response.status().is_success() => {
                println!("File uploaded successfully");
            }
            Ok(response) => {
                // The response was received without a network error, but the status code isn't a success.
                let status = response.status(); // Get the status before consuming the response
                let error_body = response.text().await.unwrap_or_else(|_| "<no response body>".to_string());
                eprintln!("Failed to upload file. Status: {}. Body: {}", status, error_body);
                return Err(format!("Failed to upload file. Status: {}. Body: {}", status, error_body));
            }
            Err(e) => {
                // The send operation failed before we got any response at all (e.g., a network error).
                return Err(format!("Failed to send upload file request: {}", e));
            }
        }

        // Clean up the uploaded file
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

async fn get_video_duration(file_path: &str) -> Result<f64, String> {
    let ffmpeg_binary_path_str = ffmpeg_path_as_str()?;

    let output = Command::new(&ffmpeg_binary_path_str)
        .args(&[
            "-i", file_path,
            "-f", "null",
            "-"])
        .output()
        .map_err(|e| format!("Failed to execute FFmpeg for getting duration: {}", e))?;
    
    // Extract the duration from FFmpeg's stderr
    let stderr = String::from_utf8_lossy(&output.stderr);

    println!("Stderr: {}", stderr);

    let duration_line = stderr.split('\n')
        .find(|line| line.contains("Duration"))
        .ok_or("Duration line not found in FFmpeg output")?;

    println!("Duration line: {}", duration_line);

    let duration_str = duration_line.split("Duration:").nth(1).unwrap()
        .split(',').next().unwrap()
        .trim();

    println!("Duration string: {}", duration_str);

    let duration_parts: Vec<&str> = duration_str.split(':').collect();
    if duration_parts.len() != 3 {
        return Err("Invalid duration format".to_string());
    }

    let hours: f64 = duration_parts[0].parse().map_err(|_| "Failed to parse hours")?;
    let minutes: f64 = duration_parts[1].parse().map_err(|_| "Failed to parse minutes")?;
    let seconds: f64 = duration_parts[2].parse().map_err(|_| "Failed to parse seconds")?;

    let total_seconds = hours * 3600.0 + minutes * 60.0 + seconds;

    Ok(total_seconds)
}