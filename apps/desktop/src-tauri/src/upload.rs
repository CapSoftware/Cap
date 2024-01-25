use serde_json::Value as JsonValue;
use std::path::{Path};
use reqwest;

use crate::recording::RecordingOptions;

#[tauri::command]
pub async fn upload_file(
    options: Option<RecordingOptions>,
    file_path: String,
    file_type: String,
) -> Result<String, String> {
    if let Some(ref options) = options {
        println!("Uploading video...");

        let file_name = Path::new(&file_path)
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid file path")?
            .to_string();

        let file_key = format!("{}/{}/{}/{}", options.user_id, options.video_id, file_type, file_name);

        // Here we assume your server listens on localhost:3000 and the route is `api/upload/new`
        let server_url = format!("http://localhost:3000/api/upload/new");

        // Create the request body for the Next.js handler
        let body = serde_json::json!({
            "userId": options.user_id,
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
            .mime_str("application/octet-stream")
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