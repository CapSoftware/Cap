use crate::upload::{create_or_get_video, S3UploadMeta};
use crate::web_api::ManagerExt;
use cap_project::RecordingMeta;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;
use tokio::fs;
use zip::write::FileOptions;

#[derive(Serialize, Deserialize)]
struct UploadBundleResponse {
    url: String,
    bundle_id: String,
}

#[derive(Serialize)]
struct S3UploadBody {
    video_id: String,
    subpath: String,
}

#[tauri::command]
#[specta::specta]
pub async fn upload_recording_bundle(app: AppHandle, recording_path: String) -> Result<(), String> {
    let path = PathBuf::from(&recording_path);

    // Verify the path exists and is a .cap bundle
    if !path.exists() {
        return Err("Recording bundle not found".to_string());
    }

    if path.extension().and_then(|s| s.to_str()) != Some("cap") {
        return Err("Invalid recording bundle format".to_string());
    }

    // Load metadata to get recording info
    let meta = RecordingMeta::load_for_project(&path)
        .map_err(|e| format!("Failed to load recording metadata: {}", e))?;

    let bundle_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid bundle name")?
        .to_string();

    // Create a zip file of the .cap bundle
    let temp_zip_path = std::env::temp_dir().join(format!("{}.zip", bundle_name));

    // Use the zip crate to create the zip file
    zip_bundle(&path, &temp_zip_path).await?;

    // Get S3 upload config
    let s3_config = create_or_get_video(&app, false, None, None)
        .await
        .map_err(|e| format!("Failed to get S3 config: {}", e))?;

    // Upload to S3
    let bundle_key = format!("support-bundles/{}.zip", s3_config.id());

    // Read the zip file
    let file_content = fs::read(&temp_zip_path)
        .await
        .map_err(|e| format!("Failed to read zip file: {}", e))?;

    // Get presigned URL for upload
    let presigned_url = get_presigned_put_url(&app, &s3_config, &bundle_key).await?;

    // Upload to S3
    let client = reqwest::Client::new();
    let response = client
        .put(&presigned_url)
        .header("Content-Type", "application/zip")
        .header("Content-Length", file_content.len())
        .body(file_content)
        .send()
        .await
        .map_err(|e| format!("Failed to upload bundle: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to upload bundle: {}", response.status()));
    }

    // Clean up temp file
    let _ = fs::remove_file(&temp_zip_path).await;

    // Get the public URL using the app's API
    let bundle_url = app
        .make_app_url(format!("/api/desktop/download-bundle/{}", bundle_key))
        .await;

    // Send Discord notification
    send_discord_notification(&app, &bundle_url, &bundle_name, &meta.pretty_name).await?;

    Ok(())
}

async fn get_presigned_put_url(
    app: &AppHandle,
    s3_config: &S3UploadMeta,
    key: &str,
) -> Result<String, String> {
    #[derive(Deserialize)]
    struct PresignedPutData {
        url: String,
        #[allow(dead_code)]
        fields: serde_json::Value, // Accept fields but don't use it
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct PresignedResponse {
        presigned_put_data: PresignedPutData,
    }

    let body = S3UploadBody {
        video_id: s3_config.id().to_string(),
        subpath: key.to_string(),
    };

    let response = app
        .authed_api_request("/api/upload/signed", |client, url| {
            client.post(url).json(&serde_json::json!({
                "videoId": body.video_id,
                "subpath": body.subpath,
                "method": "put"
            }))
        })
        .await
        .map_err(|e| format!("Failed to get presigned URL: {}", e))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Failed to authenticate request; please log in again".into());
    }

    let result: PresignedResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse presigned URL response: {}", e))?;

    Ok(result.presigned_put_data.url)
}

async fn zip_bundle(bundle_path: &PathBuf, output_path: &PathBuf) -> Result<(), String> {
    let file = std::fs::File::create(output_path)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;

    let mut zip = zip::ZipWriter::new(file);
    let options = FileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .unix_permissions(0o755);

    // Add all files from the bundle directory
    add_dir_to_zip(&mut zip, bundle_path, "", &options)
        .map_err(|e| format!("Failed to create zip: {}", e))?;

    zip.finish()
        .map_err(|e| format!("Failed to finish zip: {}", e))?;

    Ok(())
}

fn add_dir_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    dir_path: &PathBuf,
    prefix: &str,
    options: &FileOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    let entries = std::fs::read_dir(dir_path)?;

    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        let zip_path = if prefix.is_empty() {
            name_str.to_string()
        } else {
            format!("{}/{}", prefix, name_str)
        };

        if path.is_dir() {
            // Add directory
            zip.add_directory(&zip_path, *options)?;
            // Recursively add contents
            add_dir_to_zip(zip, &path, &zip_path, options)?;
        } else {
            // Add file
            zip.start_file(&zip_path, *options)?;
            let mut file = std::fs::File::open(&path)?;
            std::io::copy(&mut file, zip)?;
        }
    }

    Ok(())
}

async fn send_discord_notification(
    app: &AppHandle,
    bundle_url: &str,
    bundle_name: &str,
    recording_name: &str,
) -> Result<(), String> {
    // Get user info
    let auth = crate::auth::AuthStore::load(app)
        .map_err(|e| format!("Failed to load auth: {}", e))?
        .ok_or("User not authenticated")?;

    let user_email = auth.user_id.unwrap_or_else(|| "Unknown user".to_string());

    // Send to Discord via the desktop API
    let response = app
        .authed_api_request("/api/desktop/notify-bundle-upload", |client, url| {
            client.post(url).json(&serde_json::json!({
                "bundleUrl": bundle_url,
                "bundleName": bundle_name,
                "recordingName": recording_name,
                "userEmail": user_email,
            }))
        })
        .await
        .map_err(|e| format!("Failed to send Discord notification: {}", e))?;

    if !response.status().is_success() {
        return Err("Failed to send Discord notification".to_string());
    }

    Ok(())
}
