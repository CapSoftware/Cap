use ffmpeg_sidecar::paths::sidecar_dir;
use reqwest::Client;
use std::io::Error as IoError;
use std::process::Command;
use tokio::process::ChildStderr;

pub async fn send_metadata_api(
    video_id: &str,
    start_timestamp: f64,
    log_type: &str,
) -> Result<(), String> {
    let client = Client::new();
    println!(
        "Sending metadata API request for video {}: {}",
        video_id, start_timestamp
    );

    let params = [
        ("videoId", video_id),
        ("startTime", &start_timestamp.to_string()),
        ("logType", &log_type),
    ];

    let server_url_base: String = dotenv_codegen::dotenv!("NEXT_PUBLIC_URL").into();
    let server_url = format!("{}/api/desktop/video/metadata/create", server_url_base);

    match client.get(&server_url).query(&params).send().await {
        Ok(response) => {
            if response.status().is_success() {
                let _response_body = response.text().await.map_err(|e| e.to_string())?;
                Ok(())
            } else {
                Err(format!(
                    "API call failed with status {:?}",
                    response.status()
                ))
            }
        }
        Err(err) => Err(err.to_string()),
    }
}

pub async fn monitor_and_log_recording_start(
    stderr: ChildStderr,
    video_id: &str,
    log_type: &str,
) -> Result<(), std::io::Error> {
    use chrono::Utc;
    use tokio::io::{AsyncBufReadExt, BufReader};

    let reader = BufReader::new(stderr);
    let mut lines = reader.lines();

    while let Some(line) = lines.next_line().await? {
        if line.contains("001") && line.contains("for writing") {
            let timestamp = Utc::now().timestamp_millis() as f64;
            println!("{} recording started at timestamp: {}", log_type, timestamp);
            if send_metadata_api(video_id, timestamp, log_type)
                .await
                .is_err()
            {
                eprintln!("Failed to send metadata to API.");
            }
            return Ok(());
        }
    }

    Err(IoError::new(
        std::io::ErrorKind::Other,
        "Screen recording did not start successfully or start timestamp was not found.",
    ))
}

pub fn run_command(command: &str, args: Vec<&str>) -> Result<(String, String), String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8(output.stdout).unwrap_or_else(|_| "".to_string());
    let stderr = String::from_utf8(output.stderr).unwrap_or_else(|_| "".to_string());

    println!("Command output: {}", stdout);
    println!("Command error: {}", stderr);

    Ok((stdout, stderr))
}

pub fn ffmpeg_path_as_str() -> Result<String, String> {
    let binary_name = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };

    let path = sidecar_dir().map_err(|e| e.to_string())?.join(binary_name);
    path.to_str()
        .map(|s| s.to_owned()) // Converts the &str to a String
        .ok_or_else(|| "Failed to convert FFmpeg binary path to string".to_string())
}
