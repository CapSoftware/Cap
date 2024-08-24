use futures::future::join_all;
use scap::capturer::Resolution as ScapResolution;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::State;
use tokio::sync::{oneshot, Mutex};
use tokio::time::Duration;
use rand::Rng;
use image::{DynamicImage, GenericImageView};

use crate::app::config;
use crate::upload::{get_video_duration, upload_recording_asset, RecordingAssetType};

use crate::media::MediaRecorder;
use crate::utils::ffmpeg_path_as_str;

pub struct ActiveRecording {
    pub media_process: MediaRecorder,
    pub recording_options: RecordingOptions,
    pub shutdown_flag: Arc<AtomicBool>,
    pub uploading_finished: oneshot::Receiver<()>,
}

pub struct RecordingState {
    pub active_recording: Option<ActiveRecording>,
    pub data_dir: PathBuf,
    pub max_screen_width: usize,
    pub max_screen_height: usize,
}

unsafe impl Send for RecordingState {}
unsafe impl Sync for RecordingState {}
unsafe impl Send for MediaRecorder {}
unsafe impl Sync for MediaRecorder {}

#[derive(Debug, Serialize, Deserialize, Clone, specta::Type)]
pub struct RecordingOptions {
    pub user_id: String,
    pub video_id: String,
    pub screen_index: String,
    pub video_index: String,
    pub audio_name: String,
    pub aws_region: String,
    pub aws_bucket: String,
    pub video_resolution: String,
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn start_dual_recording(
    state: State<'_, Arc<Mutex<RecordingState>>>,
    options: RecordingOptions,
) -> Result<(), String> {
    tracing::info!("Starting screen recording...");
    let mut state = state.lock().await;

    if state.active_recording.is_some() {
        return Err("A recording is already in progress.".to_string());
    }

    let shutdown_flag = Arc::new(AtomicBool::new(false));

    let data_dir = state.data_dir.clone();

    tracing::debug!("data_dir: {:?}", data_dir);

    let screenshot_dir = data_dir.join("screenshots");
    let recording_dir = data_dir.join("recording");

    clean_and_create_dir(&screenshot_dir)?;
    clean_and_create_dir(&recording_dir)?;

    let audio_name = if options.audio_name.is_empty() {
        None
    } else {
        Some(options.audio_name.clone())
    };

    let media_recording_result = prepare_media_recording(
        &options,
        &screenshot_dir,
        &recording_dir,
        audio_name,
        state.max_screen_width,
        state.max_screen_height,
    )
    .await
    .map_err(|e| e.to_string())?;

    let uploading_finished = oneshot::channel();

    state.active_recording = Some(ActiveRecording {
        media_process: media_recording_result,
        recording_options: options.clone(),
        shutdown_flag: shutdown_flag.clone(),
        uploading_finished: uploading_finished.1,
    });

    drop(state);

    tokio::spawn(async move {
        if !config::is_local_mode() {
            let video_upload =
                hls_upload_loop(&recording_dir, shutdown_flag.clone(), options.clone());

            tracing::info!("Starting upload loop...");

            match video_upload.await {
                Ok(_) => {
                    tracing::info!("Upload loop completed successfully.");
                }
                Err(e) => {
                    tracing::error!("An error occurred: {}", e);
                }
            }
        } else {
            tracing::info!(
                "Skipping upload loops due to NEXT_PUBLIC_LOCAL_MODE being set to 'true'."
            );
        }

        uploading_finished.0.send(()).ok();
    });

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_all_recordings(
    state: State<'_, Arc<Mutex<RecordingState>>>,
    is_validation_check: Option<bool>
) -> Result<String, String> {
    let mut state = state.lock().await;

    let Some(mut active_recording) = state.active_recording.take() else {
        return Err("No recording is currently in progress.".to_string());
    };

    tracing::info!("Stopping media recording...");
    active_recording
        .media_process
        .stop_media_recording()
        .await
        .expect("Failed to stop media recording");

    tracing::info!("Uploading stream.m3u8");
    let upload_result = upload_recording_asset(
        active_recording.recording_options,
        state.data_dir.join("recording/stream.m3u8"),
        RecordingAssetType::CombinedSourcePlaylist,
        is_validation_check
    )
    .await;

    active_recording.shutdown_flag.store(true, Ordering::SeqCst);

    // if !config::is_local_mode() {
    //     tracing::debug!("Waiting for uploads to finish...");
    //     active_recording.uploading_finished.await.ok();
    // }

    tracing::info!("All recordings and uploads stopped.");

    upload_result
}

fn clean_and_create_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        // Instead of just reading the directory, this will also handle subdirectories.
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    Ok(())
}

async fn hls_upload_loop(
    recording_dir: &Path,
    shutdown_flag: Arc<AtomicBool>,
    options: RecordingOptions,
) -> Result<(), String> {
    let mut uploaded_segments: HashSet<PathBuf> = HashSet::new();
    let mut is_final_loop = false;

    let mut upload_tasks = vec![];

    loop {
        if shutdown_flag.load(Ordering::SeqCst) {
            if is_final_loop {
                break;
            }
            is_final_loop = true;
        }

        let files = std::fs::read_dir(recording_dir).map_err(|e| e.to_string())?;

        for file in files {
            let file = file.map_err(|e| e.to_string())?;
            let file_path = file.path().to_owned();

            if let Some(ext) = file_path.extension() {
                if ext != "ts" {
                    continue;
                }
            } else {
                continue;
            }

            if uploaded_segments.contains(&file_path) {
                continue;
            }

            let options = options.clone();

            upload_tasks.push(tokio::spawn(async move {
                tracing::debug!("Uploading segment {:?}", file.path());
                upload_recording_asset(
                    options,
                    file.path().to_owned(),
                    RecordingAssetType::CombinedSourceSegment,
                    None,
                )
                .await
                .ok();
            }));

            uploaded_segments.insert(file_path);
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    if !upload_tasks.is_empty() {
        join_all(upload_tasks).await;
    }

    Ok(())
}

async fn prepare_media_recording(
    options: &RecordingOptions,
    screenshot_dir: &Path,
    recording_dir: &Path,
    audio_name: Option<String>,
    max_screen_width: usize,
    max_screen_height: usize,
) -> Result<MediaRecorder, String> {
    let mut media_recorder = MediaRecorder::new();
    let video_resolution = match options.video_resolution.as_str() {
        "480p" => ScapResolution::_480p,
        "720p" => ScapResolution::_720p,
        "1080p" => ScapResolution::_1080p,
        "1440p" => ScapResolution::_1440p,
        "2160p" => ScapResolution::_2160p,
        "4320p" => ScapResolution::_4320p,
        _ => ScapResolution::Captured,
    };

    media_recorder
        .start_media_recording(
            options.clone(),
            screenshot_dir,
            recording_dir,
            audio_name.as_ref().map(String::as_str),
            max_screen_width,
            max_screen_height,
            video_resolution,
        )
        .await?;
    Ok(media_recorder)
}

pub async fn validate_video_segment(file_path: &Path, num_frames: usize) -> Result<bool, String> {
    let ffmpeg_binary_path_str = match ffmpeg_path_as_str() {
        Ok(path) => path.to_owned(),
        Err(_) => return Ok(false),
    };
    let duration = match get_video_duration(file_path) {
        Ok(d) => d,
        Err(_) => return Ok(false),
    };
    let mut rng = rand::thread_rng();
    let mut valid_frames = 0;

    for _ in 0..num_frames {
        let random_time = rng.gen_range(0.0..duration);
        let temp_path = format!(
            "{}/frame_{}.png",
            file_path.parent().unwrap().to_str().unwrap(),
            random_time.to_string()
        );
        let output = match Command::new(&ffmpeg_binary_path_str)
            .args(&[
                "-ss",
                &random_time.to_string(),
                "-i",
                file_path.to_str().unwrap(),
                "-vframes",
                "1",
                "-f",
                "image2",
                "-vcodec",
                "png",
                &temp_path,
            ])
            .output()
        {
            Ok(o) => o,
            Err(_) => return Ok(false),
        };

        if !output.status.success() {
            eprintln!("FFmpeg error: {}", String::from_utf8_lossy(&output.stderr));
            continue;
        }

        let img = match image::open(&temp_path) {
            Ok(i) => i,
            Err(_) => return Ok(false),
        };

        if is_frame_valid(&img) {
            valid_frames += 1;
        }
        if let Err(_) = std::fs::remove_file(&temp_path) {
            return Ok(false);
        }
    }

    let validity_ratio = valid_frames as f32 / num_frames as f32;
    Ok(validity_ratio >= 0.8) // Consider the segment valid if at least 80% of frames are valid
}

fn is_frame_valid(img: &DynamicImage) -> bool {
    let (width, height) = img.dimensions();
    let total_pixels = width * height;
    let mut non_black_pixels = 0;

    for pixel in img.pixels() {
        let [r, g, b, _] = pixel.2 .0;
        if r > 10 || g > 10 || b > 10 {
            non_black_pixels += 1;
        }
    }

    let non_black_ratio = non_black_pixels as f32 / total_pixels as f32;
    println!("non_black_ratio: {}", non_black_ratio);
    non_black_ratio > 0.05 // Consider the frame valid if more than 5% of pixels are non-black
}
