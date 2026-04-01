use cap_upload::{AuthConfig, CapClient, UploadEngine, UploadProgress, VideoMetadata};
use clap::Args;
use indicatif::{ProgressBar, ProgressStyle};
use std::path::PathBuf;

#[derive(Args)]
pub struct UploadArgs {
    path: PathBuf,
    #[arg(long)]
    password: Option<String>,
    #[arg(long)]
    org: Option<String>,
}

struct CliProgress {
    bar: ProgressBar,
}

impl CliProgress {
    fn new(total: u64, filename: &str) -> Self {
        let bar = ProgressBar::new(total);
        bar.set_style(
            ProgressStyle::with_template(
                "Uploading {msg} [{bar:40.cyan/blue}] {percent}% ({bytes}/{total_bytes}) {bytes_per_sec}",
            )
            .unwrap()
            .progress_chars("=>-"),
        );
        bar.set_message(filename.to_string());
        Self { bar }
    }
}

impl UploadProgress for CliProgress {
    fn on_chunk_uploaded(&self, bytes_uploaded: u64, _total_bytes: u64) {
        self.bar.set_position(bytes_uploaded);
    }

    fn on_complete(&self) {
        self.bar.finish_with_message("done");
    }

    fn on_error(&self, error: &str) {
        self.bar.abandon_with_message(format!("error: {error}"));
    }
}

impl UploadArgs {
    pub async fn run(self, json: bool) -> Result<(), String> {
        let auth = AuthConfig::resolve().map_err(|e| e.to_string())?;
        let client = CapClient::new(auth).map_err(|e| e.to_string())?;
        let engine = UploadEngine::new(&client);

        let path = &self.path;
        if !path.exists() {
            return Err(format!("File not found: {}", path.display()));
        }

        let metadata = extract_metadata(path)?;

        let file_size = std::fs::metadata(path)
            .map_err(|e| format!("Cannot read file: {e}"))?
            .len();
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("video")
            .to_string();

        let progress: Option<Box<dyn UploadProgress>> = if json {
            None
        } else {
            Some(Box::new(CliProgress::new(file_size, &filename)))
        };

        let result = engine
            .upload_file(path, metadata, progress.as_deref(), self.org.as_deref())
            .await
            .map_err(|e| e.to_string())?;

        if let Some(ref pw) = self.password {
            match client.set_video_password(&result.video_id, Some(pw)).await {
                Ok(()) => {
                    if !json {
                        eprintln!("Password set on video.");
                    }
                }
                Err(e) => {
                    eprintln!("Warning: failed to set password: {e}");
                }
            }
        }

        if json {
            println!(
                "{}",
                serde_json::json!({
                    "video_id": result.video_id,
                    "share_url": result.share_url,
                    "size_bytes": file_size,
                    "password_set": self.password.is_some(),
                })
            );
        } else {
            println!("{}", result.share_url);
        }

        Ok(())
    }
}

fn extract_metadata(path: &std::path::Path) -> Result<VideoMetadata, String> {
    let output = std::process::Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("Failed to run ffprobe (is ffmpeg installed?): {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let probe: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("Failed to parse ffprobe output: {e}"))?;

    let video_stream = probe["streams"]
        .as_array()
        .and_then(|streams| {
            streams
                .iter()
                .find(|s| s["codec_type"].as_str() == Some("video"))
        })
        .ok_or_else(|| "No video stream found in file".to_string())?;

    let duration_secs = probe["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);

    let width = video_stream["width"].as_u64().unwrap_or(0) as u32;
    let height = video_stream["height"].as_u64().unwrap_or(0) as u32;

    let fps = video_stream["r_frame_rate"].as_str().and_then(|rate| {
        let parts: Vec<&str> = rate.split('/').collect();
        if parts.len() == 2 {
            let num = parts[0].parse::<f32>().ok()?;
            let den = parts[1].parse::<f32>().ok()?;
            if den > 0.0 { Some(num / den) } else { None }
        } else {
            rate.parse::<f32>().ok()
        }
    });

    Ok(VideoMetadata {
        duration_secs,
        width,
        height,
        fps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_metadata_missing_file() {
        let result = extract_metadata(std::path::Path::new("/tmp/nonexistent_cap_test_video.mp4"));
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("ffprobe"));
    }
}
