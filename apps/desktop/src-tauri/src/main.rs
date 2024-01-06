#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc};
use tokio::sync::Mutex;
use std::env;
use std::process::{Command, Child, Stdio};
use std::path::PathBuf;
use tauri::State;
use std::path::Path;
use serde::Serialize;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use tokio::sync::mpsc;
use tauri::{Manager};
use tauri_plugin_positioner::{WindowExt, Position};

use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    error::Result as FfmpegResult,
    paths::sidecar_dir,
    version::ffmpeg_version,
};

#[warn(dead_code)]
struct RecordingState {
  screen_process: Option<tokio::process::Child>,
  video_process: Option<tokio::process::Child>,
  tx: Option<mpsc::Sender<()>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct RecordingOptions {
  user_id: String,
  video_id: String,
  screen_index: String,
  video_index: String,
  aws_region: String,
  aws_bucket: String
}

#[tauri::command]
async fn start_dual_recording(
  state: State<'_, Arc<Mutex<RecordingState>>>,
  options: RecordingOptions,
) -> Result<(), String> {
  println!("Starting screen recording...");

  let ffmpeg_binary_path = sidecar_dir().map_err(|e| e.to_string())?.join(if cfg!(target_os = "windows") { "ffmpeg.exe" } else { "ffmpeg" });
  
  let screen_chunks_dir = std::env::current_dir()
      .map_err(|_| "Cannot get current directory".to_string())?
      .join("chunks/screen");

  let video_chunks_dir = std::env::current_dir()
      .map_err(|_| "Cannot get current directory".to_string())?
      .join("chunks/video");

  clean_and_create_dir(&screen_chunks_dir)?;
  clean_and_create_dir(&video_chunks_dir)?;

  let ffmpeg_screen_args_future = construct_recording_args(&options.screen_index, &screen_chunks_dir, "screen");
  let ffmpeg_video_args_future = construct_recording_args(&options.video_index, &video_chunks_dir, "video");

  // Await the futures to get the arguments
  let ffmpeg_screen_args = ffmpeg_screen_args_future.await.map_err(|e| e.to_string())?;
  let ffmpeg_video_args = ffmpeg_video_args_future.await.map_err(|e| e.to_string())?;
  
  println!("Screen args: {:?}", ffmpeg_screen_args);
  println!("Video args: {:?}", ffmpeg_video_args);

  let mut screen_child = tokio::process::Command::new(&ffmpeg_binary_path)
      .args(&ffmpeg_screen_args)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| e.to_string())?;

  let mut video_child = tokio::process::Command::new(&ffmpeg_binary_path)
      .args(&ffmpeg_video_args)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| e.to_string())?;

  let screen_stdout = screen_child.stdout.take().unwrap();
  let screen_stderr = screen_child.stderr.take().unwrap();
  tokio::spawn(log_output(screen_stdout, "Screen stdout".to_string()));
  tokio::spawn(log_output(screen_stderr, "Screen stderr".to_string()));

  // Video recording process
  let video_stdout = video_child.stdout.take().unwrap();
  let video_stderr = video_child.stderr.take().unwrap();
  tokio::spawn(log_output(video_stdout, "Video stdout".to_string()));
  tokio::spawn(log_output(video_stderr, "Video stderr".to_string()));

  let (tx, _rx) = mpsc::channel::<()>(1);

  let mut guard = state.lock().await;
  *guard = RecordingState {
      screen_process: Some(screen_child),
      video_process: Some(video_child),
      tx: Some(tx),
  };
  drop(guard);

  tokio::join!(
      start_upload_loop(screen_chunks_dir, options.clone(), "screen".to_string()),
      start_upload_loop(video_chunks_dir, options.clone(), "video".to_string())
  );
    
  Ok(())
}

fn clean_and_create_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.path().is_file() {
                std::fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
    } else {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn log_output(reader: impl tokio::io::AsyncRead + Unpin + Send + 'static, desc: String) {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut reader = BufReader::new(reader).lines();

    while let Ok(Some(line)) = reader.next_line().await {
        println!("{}: {}", desc, line);
    }
}

async fn construct_recording_args(
    input_index: &str, 
    chunks_dir: &Path, 
    video_type: &str
) -> Result<Vec<String>, String> {
    let output_filename_pattern = format!("{}/recording_chunk_%03d.ts", chunks_dir.display());
    let fps = if video_type == "screen" { "60" } else { "30" };
    let preset = "veryfast".to_string();
    let crf = "20".to_string();
    let pix_fmt = "yuv420p".to_string();
    let codec = "libx264".to_string();
    let gop = "60".to_string();
    let segment_time = "10".to_string();

    match std::env::consts::OS {
        "macos" => {
            if video_type == "screen" {
                Ok(vec![
                    "-f".to_string(), "avfoundation".to_string(),
                    "-framerate".to_string(), fps.to_string(),
                    "-i".to_string(), format!("{}:none", input_index),
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    "-pix_fmt".to_string(), pix_fmt,
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "avfoundation".to_string(),
                    "-framerate".to_string(), fps.to_string(),
                    "-s".to_string(), "640x480".to_string(),
                    "-i".to_string(), format!("{}:none", input_index),
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            }
        },
        "linux" => {
            if video_type == "screen" {
                Ok(vec![
                    "-f".to_string(), "x11grab".to_string(),
                    "-i".to_string(), format!("{}+0,0", input_index),
                    "-draw_mouse".to_string(), "1".to_string(),
                    "-pix_fmt".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "x11grab".to_string(),
                    "-i".to_string(), format!("{}+0,0", input_index),
                    "-pix_fmt".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            }
        },
        "windows" => {
            if video_type == "screen" {
                Ok(vec![
                    "-f".to_string(), "gdigrab".to_string(),
                    "-i".to_string(), "desktop".to_string(),
                    "-pix_fmt".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "dshow".to_string(),
                    "-i".to_string(), format!("video={}", input_index),
                    "-pix_fmt".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            }
        },
        _ => Err("Unsupported OS".to_string()),
    }
}

async fn start_upload_loop(chunks_dir: PathBuf, options: RecordingOptions, video_type: String) {
    println!("Starting upload loop for {}...", video_type);

    let upload_interval = std::time::Duration::from_secs(10);

    loop {
        let chunks_dir_path = chunks_dir.clone();
        let entries = match std::fs::read_dir(&chunks_dir_path) {
            Ok(entries) => entries,
            Err(e) => {
                eprintln!("Failed to read chunks dir for {}: {}", video_type, e);
                tokio::time::sleep(upload_interval).await;
                continue;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    eprintln!("ReadDir entry error for {}: {}", video_type, e);
                    continue;
                }
            };
            let path = entry.path();
            if path.is_file() && path.extension().map_or(false, |e| e == "ts") {
                let filepath_str = path.to_str().unwrap_or_default().to_owned();

                //Log the file path, and the video type in one print, starting with "Uploading video from"
                println!("Uploading video for {}: {}", video_type, filepath_str);

                match upload_video(
                    options.clone(),
                    filepath_str.clone(),
                    video_type.clone(),
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
}

fn run_command(command: &str, args: Vec<&str>) -> Result<(String, String), String> {
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

#[tauri::command]
async fn upload_video(
    options: RecordingOptions,
    file_path: String,
    video_type: String
) -> Result<String, String> {
    println!("Uploading video...");

    let file_name = Path::new(&file_path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Invalid file path")?
        .to_string();

    let file_key = format!("{}/{}/{}/{}", options.user_id, video_type, options.video_id, file_name);

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

    // Add the file content
    let file_bytes = tokio::fs::read(&file_path).await.map_err(|e| format!("Failed to read file: {}", e))?;
    let file_part = reqwest::multipart::Part::stream(reqwest::Body::from(file_bytes))
        .file_name(format!("{}", file_name)); 

    form = form.part("file", file_part);

    // Extract the URL and send the form to the presigned URL for upload
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
            if let Some(camera_window) = app.get_window("camera") { 
              let _ = camera_window.move_window(Position::BottomRight);
            }

            if let Some(options_window) = app.get_window("options") { 
              let _ = options_window.move_window(Position::Center);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_dual_recording,
            upload_video,
            list_devices
        ])
        .manage(Arc::new(Mutex::new(RecordingState { screen_process: None, video_process: None, tx: None })))
        .plugin(tauri_plugin_context_menu::init())
        .run(tauri::generate_context!())
        .expect("Error while running tauri application");
}