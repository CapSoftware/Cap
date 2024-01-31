use std::path::{Path, PathBuf};
use std::collections::HashSet;
use std::io::{self, BufReader, BufRead, ErrorKind};
use std::fs::File;
use std::sync::Arc;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::{Semaphore, Mutex};
use tokio::task::JoinHandle;
use tokio::time::{timeout, Duration};
use serde::{Serialize, Deserialize};
use tauri::State;

use crate::utils::ffmpeg_path_as_str;
use crate::upload::upload_file;

pub struct RecordingState {
  pub screen_process: Option<tokio::process::Child>,
  pub video_process: Option<tokio::process::Child>,
  pub upload_handles: Mutex<Vec<JoinHandle<Result<(), String>>>>,
  pub recording_options: Option<RecordingOptions>,
  pub shutdown_flag: Arc<AtomicBool>,
  pub data_dir: Option<PathBuf>, 
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

#[tauri::command]
pub async fn start_dual_recording(
  state: State<'_, Arc<Mutex<RecordingState>>>,
  options: RecordingOptions,
) -> Result<(), String> {
  println!("Starting screen recording...");
  let mut state_guard = state.lock().await;

  let shutdown_flag = Arc::new(AtomicBool::new(false));

  let ffmpeg_binary_path_str = ffmpeg_path_as_str()?;

  let data_dir = state_guard.data_dir.as_ref()
      .ok_or("Data directory is not set in the recording state".to_string())?;

  //print the data_dir
  println!("data_dir: {:?}", data_dir);
  
  let screen_chunks_dir = data_dir.join("chunks/screen");
  let video_chunks_dir = data_dir.join("chunks/video");

  clean_and_create_dir(&screen_chunks_dir)?;
  clean_and_create_dir(&video_chunks_dir)?;

  let ffmpeg_screen_args_future = construct_recording_args(&options, &screen_chunks_dir, "screen", &options.screen_index);
  // let ffmpeg_video_args_future = construct_recording_args(&options, &video_chunks_dir, "video", &options.video_index);
  let ffmpeg_screen_args = ffmpeg_screen_args_future.await.map_err(|e| e.to_string())?;
  // let ffmpeg_video_args = ffmpeg_video_args_future.await.map_err(|e| e.to_string())?;
  
  println!("Screen args: {:?}", ffmpeg_screen_args);
  // println!("Video args: {:?}", ffmpeg_video_args);

  let mut screen_child = tokio::process::Command::new(&ffmpeg_binary_path_str)
      .args(&ffmpeg_screen_args)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| e.to_string())?;

  // let mut video_child = tokio::process::Command::new(&ffmpeg_binary_path_str)
  //     .args(&ffmpeg_video_args)
  //     .stdout(Stdio::piped())
  //     .stderr(Stdio::piped())
  //     .spawn()
  //     .map_err(|e| e.to_string())?;

  let screen_stdout = screen_child.stdout.take().unwrap();
  let screen_stderr = screen_child.stderr.take().unwrap();
  tokio::spawn(log_output(screen_stdout, "Screen stdout".to_string()));
  tokio::spawn(log_output(screen_stderr, "Screen stderr".to_string()));

  // let video_stdout = video_child.stdout.take().unwrap();
  // let video_stderr = video_child.stderr.take().unwrap();
  // tokio::spawn(log_output(video_stdout, "Video stdout".to_string()));
  // tokio::spawn(log_output(video_stderr, "Video stderr".to_string()));

  state_guard.screen_process = Some(screen_child);
  // guard.video_process = Some(video_child);
  state_guard.upload_handles = Mutex::new(vec![]);
  state_guard.recording_options = Some(options.clone());
  state_guard.shutdown_flag = shutdown_flag.clone();

  drop(state_guard);

  println!("Starting upload loops...");

  let screen_upload = start_upload_loop(state.clone(), screen_chunks_dir, options.clone(), "screen".to_string(), shutdown_flag.clone());
  let video_upload = start_upload_loop(state.clone(), video_chunks_dir, options.clone(), "video".to_string(), shutdown_flag.clone());

  match tokio::try_join!(screen_upload, video_upload) {
      Ok(_) => {
          println!("Both upload loops completed successfully.");
      },
      Err(e) => {
          eprintln!("An error occurred: {}", e);
      },
  }

  Ok(())
}

#[tauri::command]
pub async fn stop_all_recordings(state: State<'_, Arc<Mutex<RecordingState>>>) -> Result<(), String> {
    println!("!!STOPPING screen recording...");

    // Lock the state to access shared data.
    let mut guard = state.lock().await;

    // Immediately instruct ongoing operations to stop.
    guard.shutdown_flag.store(true, Ordering::SeqCst);

    // Immediately try to close running FFmpeg processes.
    if let Some(child_process) = &mut guard.screen_process {
        let _ = child_process.kill().await;
    }
    // Assuming there's a video_process similar to screen_process.
    //if let Some(child_process) = &mut guard.video_process {
    //    let _ = child_process.kill().await;
    //}

    // Swap out the current upload_handles for an empty vector to take ownership.
    let mut upload_handles_lock = guard.upload_handles.lock().await;
    let upload_handles = std::mem::take(&mut *upload_handles_lock);

    // Explicitly drop the locks so other async operations can proceed.
    drop(upload_handles_lock);
    drop(guard);

    // Now using try_join_all with the owned join handles obtained from the state.
    // This will wait for all the current upload handles to complete.
    let _ = futures::future::try_join_all(upload_handles.into_iter()).await;

    println!("All recordings and uploads stopped.");

    Ok(())
}

fn clean_and_create_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        // Instead of just reading the directory, this will also handle subdirectories.
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Ensure the segment list file exists within the given directory
    // This assumes a naming convention where the segment list file is named "segment_list.txt"
    let segment_list_path = dir.join("segment_list.txt");
    match File::open(&segment_list_path) {
        Ok(_) => Ok(()), // File already exists, return Ok(())
        Err(ref e) if e.kind() == ErrorKind::NotFound => {
            // Create the file if it does not exist, but ignore the returned File object
            File::create(&segment_list_path).map_err(|e| e.to_string())?;
            Ok(()) // Now the file is created, return Ok(())
        },
        Err(e) => Err(e.to_string()), // Handle other possible file I/O errors
    }
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
    let output_filename_pattern = format!("{}/recording_chunk_%03d.ts", chunks_dir.display());
    let segment_list_filename = format!("{}/segment_list.txt", chunks_dir.display());
    
    ensure_segment_list_exists(PathBuf::from(&segment_list_filename))
        .map_err(|e| format!("Failed to ensure segment list file exists: {}", e))?;
      
    let fps = if video_type == "screen" { "60" } else { &options.framerate };
    let preset = "ultrafast".to_string();
    let crf = "28".to_string();
    let pix_fmt = "nv12".to_string();
    let codec = "libx264".to_string();
    let gop = "30".to_string();
    let segment_time = "3".to_string();
    let segment_list_type = "flat".to_string();
    let input_string = format!("{}:none", input_index);

    match std::env::consts::OS {
        "macos" => {
            if video_type == "screen" {
                Ok(vec![
                    "-f".to_string(), "avfoundation".to_string(),
                    "-framerate".to_string(), fps.to_string(),
                    "-i".to_string(), input_string.to_string(),
                    "-c:v".to_string(), codec,
                    "-preset".to_string(), preset,
                    "-pix_fmt".to_string(), pix_fmt,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "avfoundation".to_string(),
                    "-video_size".to_string(), options.resolution.to_string(),
                    "-framerate".to_string(), fps.to_string(),
                    "-i".to_string(), input_string.to_string(),
                    "-c:v".to_string(), codec,
                    "-preset".to_string(), preset,
                    "-pix_fmt".to_string(), pix_fmt,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
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
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
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
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
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
                    "-pixel_format".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            } else {
                Ok(vec![
                    "-f".to_string(), "dshow".to_string(),
                    "-i".to_string(), format!("video={}", input_index),
                    "-pixel_format".to_string(), pix_fmt,
                    "-c:v".to_string(), codec,
                    "-crf".to_string(), crf,
                    "-preset".to_string(), preset,
                    "-g".to_string(), gop,
                    "-r".to_string(), fps.to_string(),
                    "-f".to_string(), "segment".to_string(),
                    "-segment_time".to_string(), segment_time,
                    "-segment_format".to_string(), "mpegts".to_string(),
                    "-segment_list".to_string(), segment_list_filename,
                    "-segment_list_type".to_string(), segment_list_type,
                    "-reset_timestamps".to_string(), "1".to_string(),
                    output_filename_pattern,
                ])
            }
        },
        _ => Err("Unsupported OS".to_string()),
    }
}

async fn start_upload_loop(
    state: State<'_, Arc<Mutex<RecordingState>>>,
    chunks_dir: PathBuf,
    options: RecordingOptions,
    video_type: String,
    shutdown_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    println!("Starting upload loop for {}", video_type);

    //print the chunks_dir
    println!("chunks_dir: {:?}", chunks_dir);

    let segment_list_path = chunks_dir.join("segment_list.txt");
    
    let mut watched_segments: HashSet<String> = HashSet::new();

    loop {
        if shutdown_flag.load(Ordering::SeqCst) {
            println!("Shutdown flag set, exiting upload loop for {}", video_type);
            break;
        }

        match load_segment_list(&segment_list_path) {
            Ok(new_segments) => {
                for segment_filename in new_segments {
                    let segment_path = chunks_dir.join(&segment_filename);

                    // Check if the segment is new and schedule it for upload
                    if segment_path.is_file() && watched_segments.insert(segment_filename.clone()) {
                        let filepath_str = segment_path.to_str().unwrap_or_default().to_owned();
                        let options_clone = options.clone();
                        let video_type_clone = video_type.clone();

                        let handle = tokio::spawn(async move {
                            // Log the file path and the video type in one print, starting with "Uploading video from"
                            println!("Uploading video for {}: {}", video_type_clone, filepath_str);
  
                            match upload_file(Some(options_clone.clone()), filepath_str.clone(), video_type_clone.clone()).await {
                                Ok(file_key) => {
                                    println!("Chunk uploaded: {}", file_key);
                                },
                                Err(e) => {
                                    eprintln!("Failed to upload chunk {}: {}", filepath_str, e);
                                }
                            }

                            Ok(())
                        });

                        // Store the handle in the state for later awaits or cancels if required.
                        let guard = state.lock().await;
                        guard.upload_handles.lock().await.push(handle);

                        drop(guard);
                    }
                }
            }
            Err(e) => eprintln!("Failed to read segment list for {}: {}", video_type, e),
        }

        tokio::time::sleep(Duration::from_secs(3)).await;
    }

    Ok(())
}

fn ensure_segment_list_exists(file_path: PathBuf) -> io::Result<()> {
    match File::open(&file_path) {
        Ok(_) => (), 
        Err(ref e) if e.kind() == ErrorKind::NotFound => {
            File::create(&file_path)?;
        },
        Err(e) => {
            return Err(e);
        },
    }
    Ok(())
}

fn load_segment_list(segment_list_path: &Path) -> io::Result<HashSet<String>> {
    let file = File::open(segment_list_path)?;
    let reader = BufReader::new(file);

    let mut segments = HashSet::new();
    for line_result in reader.lines() {
        let line = line_result?;
        if !line.is_empty() {
            segments.insert(line);
        }
    }

    Ok(segments)
}

async fn upload_remaining_chunks(
    chunks_dir: &PathBuf,
    options: Option<RecordingOptions>,
    video_type: &str,
    shutdown_flag: Arc<AtomicBool>,
) -> Result<(), String> {
    // Include shutdown_flag in parameters and check it inside loop to quickly react to stop signals.

    if let Some(actual_options) = options {
        let retry_interval = Duration::from_secs(2);
        let upload_timeout = Duration::from_secs(15);
        let file_stability_timeout = Duration::from_secs(1);
        let file_stability_checks = 2;

        // Adjusted for immediate reaction to shutdown_flag.
        if shutdown_flag.load(Ordering::SeqCst) {
            return Ok(());
        }

        let entries = std::fs::read_dir(chunks_dir).map_err(|e| format!("Error reading directory: {}", e))?;

        let semaphore = Arc::new(Semaphore::new(16));

        let tasks: Vec<_> = entries.filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let path = entry.path();
                if path.is_file() && (path.extension().map_or(false, |e| e == "ts" || e == "webm")) && !shutdown_flag.load(Ordering::SeqCst) {
                    let video_type = video_type.to_string();
                    let semaphore_clone = semaphore.clone();
                    let actual_options_clone = actual_options.clone();
                    let shutdown_flag_clone = shutdown_flag.clone();

                    Some(tokio::spawn(async move {
                        let _permit = semaphore_clone.acquire().await;
                        let filepath_str = path.to_str().unwrap_or_default().to_owned();

                        // Quick exit if shutdown signal is received.
                        if shutdown_flag_clone.load(Ordering::SeqCst) {
                            return;
                        }

                        // Check for file size stability
                        let mut last_size = 0;
                        let mut stable_count = 0;
                        while stable_count < file_stability_checks {
                            if !path.exists() {
                                eprintln!("File does not exist: {}", path.display());
                                break; // Exit the loop if the file does not exist
                            }
                            match std::fs::metadata(&path) {
                                Ok(metadata) => {
                                    let current_size = metadata.len();
                                    if last_size == current_size {
                                        stable_count += 1;
                                    } else {
                                        last_size = current_size;
                                        stable_count = 0;
                                    }
                                },
                                Err(e) => {
                                    eprintln!("Failed to get file metadata: {}", e);
                                    break; // Exit the loop if any other error occurs
                                }
                            }
                            tokio::time::sleep(file_stability_timeout).await;
                        }

                        println!("File size stable: {}", filepath_str);

                        // Proceed with upload after confirming file stability
                        let mut attempts = 0;
                        // Retry loop with timeout
                        while attempts < 3 {
                            attempts += 1;
                            match timeout(upload_timeout, upload_file(Some(actual_options_clone.clone()), filepath_str.clone(), video_type.clone())).await {
                                Ok(Ok(_)) => {
                                    // Upload succeeded
                                    println!("Successful upload on attempt {}", attempts);
                                    break; // Break out of the loop on success
                                }
                                Ok(Err(e)) => {
                                    // Upload failed but did not timeout
                                    eprintln!("Failed to upload (attempt {}): {}", attempts, e);
                                }
                                Err(_) => {
                                    // Upload attempt timed out
                                    eprintln!("Upload attempt timed out (attempt {})", attempts);
                                }
                            }
                            // Wait for retry_interval before retrying
                            tokio::time::sleep(retry_interval).await;
                        }
                    }))
                } else {
                    None
                }
            })
            .collect();

        // Await all tasks concurrently.
        let _ = futures::future::try_join_all(tasks).await;

        Ok(())
    } else {
        Err("No recording options provided".to_string())
    }
}