#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc};
use tokio::sync::Mutex;
use std::env;
use std::process::{Command, Child, Stdio};
use std::collections::HashMap;
use tauri::State;
use std::fs;
use std::path::Path;
use std::io;
use dotenvy_macro::dotenv;
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use s3::error::S3Error;
use serde::Serialize;
use serde::Deserialize;
use uuid::Uuid;
use tokio::sync::mpsc;
use tauri::{Manager, Window};
use tauri_plugin_positioner::{WindowExt, Position};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

struct RecordingState {
  process: Option<Child>,
  tx: Option<mpsc::Sender<()>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RecordingOptions {
  user_id: String,
  unique_id: String,
}

#[tauri::command]
async fn start_screen_recording(
  state: State<'_, Arc<Mutex<RecordingState>>>,
  options: RecordingOptions,
) -> Result<(), String> {
  println!("Starting screen recording...");

  let ffmpeg_binary_path = sidecar_dir().map_err(|e| e.to_string())?.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
  
  let chunks_dir = std::env::current_dir()
      .map_err(|_| "Cannot get current directory".to_string())?
      .join("chunks");
  std::fs::create_dir_all(&chunks_dir)
      .map_err(|_| "Failed to create chunks directory".to_string())?;

  let chunks_dir_str = chunks_dir.to_str().ok_or("Invalid chunks directory path")?;

  let output_filename_pattern = format!("{}/recording_chunk_%03d.mp4", chunks_dir.display());

  // Construct the ffmpeg command based on the OS
  let ffmpeg_args = match std::env::consts::OS {
      "macos" => vec![
              "-f", "avfoundation", "-capture_cursor", "1", "-r", "30",
              "-i", "1", "-pix_fmt", "uyvy422", "-c:v", "libx264", 
              "-crf", "20", "-preset", "veryfast", "-g", "60", 
              "-f", "segment", "-segment_time", "10", "-segment_wrap", "10",
              &output_filename_pattern,
      ],
      _ => return Err("Unsupported OS".to_string()),
  };
  
  // Use tokio's command to spawn the process so we can capture stdout/stderr in order to send file paths to the upload function
  let child = Command::new(ffmpeg_binary_path)
    .args(&ffmpeg_args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| e.to_string())?;
  
  let (tx, _rx) = mpsc::channel::<()>(1);
  
  // Store the recording process in the shared state
  let mut guard = state.lock().await;
  *guard = RecordingState {
    process: Some(child),
    tx: Some(tx),
  };
  drop(guard); 
  
  let user_id = options.user_id.clone();
  let unique_id = options.unique_id.clone();
  let chunks_dir = chunks_dir;

  tokio::spawn(async move {
      let upload_interval = std::time::Duration::from_secs(10);

      loop {
        let chunks_dir_path = chunks_dir.clone(); 
        let entries = match std::fs::read_dir(&chunks_dir_path) {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("Failed to read chunks dir: {}", e);
                tokio::time::sleep(upload_interval).await;
                continue;
            }
        };

          for entry in entries {
              let entry = match entry {
                  Ok(e) => e,
                  Err(e) => {
                      eprintln!("ReadDir entry error: {}", e);
                      continue;
                  }
              };
              let path = entry.path();
              if path.is_file() {
                  let filepath_str = path.to_str().unwrap_or_default().to_owned();
                  match upload_video(
                      user_id.clone(),
                      filepath_str.clone(),
                      unique_id.clone(),
                  ).await {
                      Ok(file_key) => {
                          println!("Chunk uploaded: {}", file_key);
                      },
                      Err(e) => {
                          eprintln!("Failed to upload chunk {}: {}", filepath_str, e);
                      }
                  }
              }
          }

          tokio::time::sleep(upload_interval).await;
      }
  });
  
  Ok(())
}

#[tauri::command]
async fn stop_screen_recording(state: State<'_, Arc<Mutex<RecordingState>>>) -> Result<(), String> {
    let mut guard = state.lock().await;
    
    // Attempt to kill the child process
    if let Some(mut child) = guard.process.take() {
        #[cfg(not(target_family = "unix"))]
        {
            if let Err(e) = child.kill() {
                eprintln!("Failed to kill ffmpeg child process: {}", e);
                return Err("Failed to kill ffmpeg process".to_string());
            }
        }

        // Try to wait for the process to exit
        let _ = child.wait().map_err(|e| {
            eprintln!("Failed to wait for the ffmpeg process to terminate: {}", e);
            "Failed to wait for ffmpeg process to terminate".to_string()
        })?;
    }

    // Notify the channel receiver to stop reading from the directory
    if let Some(tx) = guard.tx.take() {
        tx.send(()).await.map_err(|_| "Failed to send stop signal to channel".to_string())?;
    }

    Ok(())
}

fn run_command(command: &str, args: Vec<&str>) -> Result<(String, String), String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .expect("Failed to execute command");

    let stdout = String::from_utf8(output.stdout).unwrap_or_else(|_| "".to_string());
    let stderr = String::from_utf8(output.stderr).unwrap_or_else(|_| "".to_string());

    Ok((stdout, stderr))
}

async fn setup_s3_client() -> Result<Bucket, S3Error> {
    let access_key: &str = dotenv!("CLOUDFLARE_ACCESS_KEY");
    let secret_key: &str = dotenv!("CLOUDFLARE_SECRET_KEY");
    let r2_endpoint: &str = dotenv!("CLOUDFLARE_R2_ENDPOINT");

    let region = Region::Custom {
        region: "auto".to_string(),
        endpoint: r2_endpoint.to_string(), 
    };
    let credentials = Credentials::new(Some(&access_key), Some(&secret_key), None, None, None)?;
    let bucket = Bucket::new("caps", region, credentials)?;

    // Perform a simple health check operation, such as listing objects
    // Here we list the first object or prefix to minimize performance impact
    bucket.list("".to_string(), Some("/".to_string())).await.map_err(|e| e)?;
    
    Ok(bucket)
}

#[tauri::command]
async fn upload_video(
    user_id: String,
    file_path: String,
    unique_id: String
) -> Result<String, String> {
    let bucket_result = setup_s3_client().await;
    if let Err(e) = bucket_result {
        return Err(format!("Failed to setup S3 client: {}", e));
    }
    let bucket = bucket_result.unwrap();

    let video_folder_uuid = if unique_id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        unique_id
    };

    let file_name = Path::new(&file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let file_key = format!("{}/{}/{}", user_id, video_folder_uuid, file_name);

    let content = std::fs::read(&file_path)
        .map_err(|e| format!("Failed to read video file: {}", e))?;

    match bucket.put_object(&file_key, &content).await {
        Ok(data) => {
            if data.status_code() == 200 {
                println!("Video '{}' uploaded successfully.", file_name);

                // Remove the uploaded chunk file
                std::fs::remove_file(&file_path)
                    .map_err(|e| format!("Failed to remove file after upload: {}", e))?;

                Ok(file_key)
            } else {
                let error_message = format!("Failed to upload file: HTTP Status Code {}", data.status_code());
                Err(error_message)
            }
        },
        Err(e) => return Err(format!("Failed to upload file: {}", e)),
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct DeviceList {
    video_devices: Vec<String>,
    audio_devices: Vec<String>,
}

#[tauri::command]
fn list_devices() -> Result<DeviceList, String> {
    let os_type = std::env::consts::OS;
    let ffmpeg_binary_path = match sidecar_dir() {
        Ok(dir) => dir.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" }),
        Err(e) => return Err(e.to_string()),
    };
    let ffmpeg_binary_path_str = ffmpeg_binary_path.as_path().display().to_string();

    println!("OS: {}", os_type);
    println!("FFmpeg binary path: {}", ffmpeg_binary_path_str);

    match os_type {
        "macos" => {
            let (output, stderr) = run_command(&ffmpeg_binary_path_str, vec!["-f", "avfoundation", "-list_devices", "true", "-i", ""])?;
            let raw_output = if !stderr.trim().is_empty() { stderr } else { output };
            let (video_devices, audio_devices) = parse_devices_macos(&raw_output);

            println!("Video devices: {:?}", video_devices);
            println!("Audio devices: {:?}", audio_devices);

            Ok(DeviceList { video_devices, audio_devices })
        }
        "linux" => {
            let (raw_output, _) = run_command("v4l2-ctl", vec!["--list-devices"])?;
            let video_devices = raw_output.split('\n').map(|s| s.to_string()).collect();

            let (raw_output, _) = run_command("arecord", vec!["-l"])?;
            let audio_devices = raw_output.split('\n').map(|s| s.to_string()).collect();
            Ok(DeviceList { video_devices, audio_devices })
        }
        "windows" => {
            let (raw_output, _) = run_command(&ffmpeg_binary_path_str, vec!["-f", "dshow", "-list_devices", "true", "-i", ""])?;
            let (video_devices, audio_devices) = parse_devices_windows(&raw_output);
            Ok(DeviceList { video_devices, audio_devices })
        }
        _ => Err("Unsupported OS".to_string()),
    }
}

fn parse_devices_macos(raw_output: &str) -> (Vec<String>, Vec<String>) {
    let lines: Vec<&str> = raw_output.lines().collect();
    let video_start_index = lines.iter().position(|&x| x.contains("AVFoundation video devices:")).unwrap_or(0) + 1;
    let audio_start_index = lines.iter().position(|&x| x.contains("AVFoundation audio devices:")).unwrap_or(0) + 1;
    
    let video_devices = lines[video_start_index..audio_start_index-1]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let audio_devices = lines[audio_start_index..]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    (video_devices, audio_devices)
}

fn parse_devices_windows(raw_output: &str) -> (Vec<String>, Vec<String>) {
    let lines: Vec<&str> = raw_output.lines().collect();
    let video_start_index = lines.iter().position(|&x| x.contains("DirectShow video devices")).unwrap_or(0) + 1;
    let audio_start_index = lines.iter().position(|&x| x.contains("DirectShow audio devices")).unwrap_or(0) + 1;
    
    let video_devices = lines[video_start_index..audio_start_index-1]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let audio_devices = lines[audio_start_index..]
        .iter()
        .filter_map(|&line| {
            if line.contains("]") {
                Some(line.split("]").last()?.trim().to_string())
            } else {
                None
            }
        })
        .collect();

    (video_devices, audio_devices)
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        eprintln!("Thread panicked: {:?}", info);
    }));

    if which::which("ffmpeg").is_err() {
        if let Err(e) = handle_ffmpeg_installation() {
            eprintln!("Failed to handle FFmpeg installation: {}", e);
        }
    }

    fn handle_ffmpeg_installation() -> FfmpegResult<()> {
        if ffmpeg_is_installed() {
            println!("FFmpeg is already installed! 🎉");
            return Ok(());
        }

        match check_latest_version() {
            Ok(version) => println!("Latest available version: {}", version),
            Err(_) => println!("Skipping version check on this platform."),
        }

        let download_url = ffmpeg_download_url()?;
        let destination = sidecar_dir()?;

        println!("Downloading from: {:?}", download_url);
        let archive_path = download_ffmpeg_package(download_url, &destination)?;
        println!("Downloaded package: {:?}", archive_path);

        println!("Extracting...");
        unpack_ffmpeg(&archive_path, &destination)?;

        let version = ffmpeg_version()?;
        println!("FFmpeg version: {}", version);

        println!("Done! 🏁");
        Ok(())
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .setup(move |app| {
            tauri::async_runtime::block_on(async {
                if let Err(e) = setup_s3_client().await {
                    eprintln!("S3 client health check failed: {}", e);
                } else {
                    eprintln!("S3 client health check passed.");
                }
            });

            // Fetch the full path to the FFmpeg binary
            let ffmpeg_binary_path = sidecar_dir()?.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });

            let window = app.get_window("options").ok_or("Failed to get options window")?;

            if let Some(camera_window) = app.get_window("camera") { 
              let _ = camera_window.move_window(Position::BottomRight);
            }

            if let Some(options_window) = app.get_window("options") { 
              let _ = options_window.move_window(Position::Center);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_screen_recording,
            stop_screen_recording,
            upload_video,
            list_devices
        ])
        .manage(Arc::new(Mutex::new(RecordingState { process: None, tx: None })))
        .plugin(tauri_plugin_context_menu::init())
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}