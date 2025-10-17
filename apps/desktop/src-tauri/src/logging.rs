use crate::{ArcLock, web_api::ManagerExt};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

async fn get_latest_log_file(app: &AppHandle) -> Option<PathBuf> {
    let logs_dir = app
        .state::<ArcLock<crate::App>>()
        .read()
        .await
        .logs_dir
        .clone();

    let entries = fs::read_dir(&logs_dir).ok()?;
    let mut log_files: Vec<_> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.is_file() && path.file_name()?.to_str()?.contains("cap-desktop.log") {
                let metadata = fs::metadata(&path).ok()?;
                let modified = metadata.modified().ok()?;
                Some((path, modified))
            } else {
                None
            }
        })
        .collect();

    log_files.sort_by(|a, b| b.1.cmp(&a.1));
    log_files.first().map(|(path, _)| path.clone())
}

pub async fn upload_log_file(app: &AppHandle) -> Result<(), String> {
    let log_file = get_latest_log_file(app).await.ok_or("No log file found")?;

    let metadata =
        fs::metadata(&log_file).map_err(|e| format!("Failed to read log file metadata: {}", e))?;
    let file_size = metadata.len();

    const MAX_SIZE: u64 = 1 * 1024 * 1024;

    let log_content = if file_size > MAX_SIZE {
        let content =
            fs::read_to_string(&log_file).map_err(|e| format!("Failed to read log file: {}", e))?;

        let header = format!(
            "⚠️ Log file truncated (original size: {} bytes, showing last ~1MB)\n\n",
            file_size
        );
        let max_content_size = (MAX_SIZE as usize) - header.len();

        if content.len() > max_content_size {
            let start_pos = content.len() - max_content_size;
            let truncated = &content[start_pos..];
            if let Some(newline_pos) = truncated.find('\n') {
                format!("{}{}", header, &truncated[newline_pos + 1..])
            } else {
                format!("{}{}", header, truncated)
            }
        } else {
            content
        }
    } else {
        fs::read_to_string(&log_file).map_err(|e| format!("Failed to read log file: {}", e))?
    };

    let form = reqwest::multipart::Form::new()
        .text("log", log_content)
        .text("os", std::env::consts::OS)
        .text("version", env!("CARGO_PKG_VERSION"));

    let response = app
        .api_request("/api/desktop/logs", |client, url| {
            client.post(url).multipart(form)
        })
        .await
        .map_err(|e| format!("Failed to upload logs: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Upload failed with status: {}", response.status()));
    }

    Ok(())
}
