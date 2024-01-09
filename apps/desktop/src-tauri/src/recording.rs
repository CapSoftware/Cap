use std::path::{Path, PathBuf};
use std::time::SystemTime;
use std::sync::Arc;
use std::process::Stdio;
use tokio::sync::{Mutex, mpsc};
use serde::{Serialize, Deserialize};
use tauri::State;

use crate::utils::ffmpeg_path_as_str;
use crate::upload::upload_video;

#[warn(dead_code)]
pub struct RecordingState {
  pub screen_process: Option<tokio::process::Child>,
  pub video_process: Option<tokio::process::Child>,
  pub tx: Option<mpsc::Sender<()>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingOptions {
  pub user_id: String,
  pub video_id: String,
  pub screen_index: String,
  pub video_index: String,
  pub aws_region: String,
  pub aws_bucket: String,
  pub framerate: String,
  pub resolution: String,
}

const FILE_MODIFICATION_THRESHOLD: u64 = 5;

#[tauri::command]
pub async fn start_dual_recording(
  state: State<'_, Arc<Mutex<RecordingState>>>,
  options: RecordingOptions,
) -> Result<(), String> {
  println!("Starting screen recording...");

  let ffmpeg_binary_path_str = ffmpeg_path_as_str()?;
  
  let screen_chunks_dir = std::env::current_dir()
      .map_err(|_| "Cannot get current directory".to_string())?
      .join("chunks/screen");

  let video_chunks_dir = std::env::current_dir()
      .map_err(|_| "Cannot get current directory".to_string())?
      .join("chunks/video");

  clean_and_create_dir(&screen_chunks_dir)?;
  clean_and_create_dir(&video_chunks_dir)?;

  let ffmpeg_screen_args_future = construct_recording_args(&options, &screen_chunks_dir, "screen", &options.screen_index);
  let ffmpeg_video_args_future = construct_recording_args(&options, &video_chunks_dir, "video", &options.video_index);

  // Await the futures to get the arguments
  let ffmpeg_screen_args = ffmpeg_screen_args_future.await.map_err(|e| e.to_string())?;
  let ffmpeg_video_args = ffmpeg_video_args_future.await.map_err(|e| e.to_string())?;
  
  println!("Screen args: {:?}", ffmpeg_screen_args);
  println!("Video args: {:?}", ffmpeg_video_args);

  let mut screen_child = tokio::process::Command::new(&ffmpeg_binary_path_str)
      .args(&ffmpeg_screen_args)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| e.to_string())?;

  let mut video_child = tokio::process::Command::new(&ffmpeg_binary_path_str)
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
    options: &RecordingOptions,
    chunks_dir: &Path, 
    video_type: &str,
    input_index: &str, 
) -> Result<Vec<String>, String> {
    let output_filename_pattern = format!("{}/recording_chunk_%03d.mkv", chunks_dir.display());
    let fps = if video_type == "screen" { "60" } else { &options.framerate };
    let preset = "veryfast".to_string();
    let crf = "20".to_string();
    let pix_fmt = "yuyv422".to_string();
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
                    "-pix_fmt".to_string(), pix_fmt,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "matroska".to_string(),
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "avfoundation".to_string(),
                    "-video_size".to_string(), options.resolution.to_string(),
                    "-framerate".to_string(), fps.to_string(),
                    "-i".to_string(), format!("{}:none", input_index),
                    "-c:v".to_string(), codec,
                    "-preset".to_string(), preset,
                    "-pix_fmt".to_string(), pix_fmt,
                    "-fps_mode".to_string(), "vfr".to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "matroska".to_string(),
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
            if path.is_file() && path.extension().map_or(false, |e| e == "mkv") {
                // Skip files that have been recently modified
                if let Ok(metadata) = std::fs::metadata(&path) {
                    if let Ok(modified) = metadata.modified() {
                        if SystemTime::now().duration_since(modified).unwrap_or_default().as_secs() < FILE_MODIFICATION_THRESHOLD {
                            println!("Skipping recently modified file: {}", path.display());
                            continue;
                        }
                    }
                }

                let filepath_str = path.to_str().unwrap_or_default().to_owned();

                // Log the file path, and the video type in one print, starting with "Uploading video from"
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