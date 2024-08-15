use futures::future::join_all;
use scap::capturer::Resolution;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_specta::Event;
use tokio::sync::{oneshot, Mutex};
use tokio::time::Duration;

use crate::app::config;
use crate::upload::{upload_recording_asset, ProgressInfo, RecordingAssetType};

use crate::media::MediaRecorder;

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
    pub resolution: String,
    pub video_index: String,
    pub audio_name: String,
    pub aws_region: String,
    pub aws_bucket: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default, specta::Type)]
pub enum OutputResolution {
    _480p,
    _720p,
    _1080p,
    _1440p,
    _2160p,
    _4320p,

    #[default]
    Captured,
}

impl OutputResolution {
    pub fn from_str(input: &str) -> Option<OutputResolution> {
        match input {
            "480p" => Some(Self::_480p),
            "720p" => Some(Self::_720p),
            "1080p" => Some(Self::_1080p),
            "1440p" => Some(Self::_1440p),
            "2160p" => Some(Self::_2160p),
            "4320p" => Some(Self::_4320p),
            "Captured" => Some(Self::Captured),
            _ => None,
        }
    }

    pub fn to_scap_resolution(self) -> Resolution {
        match self {
            Self::_480p => Resolution::_480p,
            Self::_720p => Resolution::_720p,
            Self::_1080p => Resolution::_1080p,
            Self::_1440p => Resolution::_1440p,
            Self::_2160p => Resolution::_2160p,
            Self::_4320p => Resolution::_4320p,
            Self::Captured => Resolution::Captured,
        }
    }
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

#[derive(Serialize, Deserialize, Debug, Clone, specta::Type, tauri_specta::Event)]
pub struct UploadProgressEvent(ProgressInfo);

#[tauri::command]
#[specta::specta]
pub async fn stop_all_recordings(
    app_handle: AppHandle,
    state: State<'_, Arc<Mutex<RecordingState>>>,
) -> Result<(), String> {
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

    upload_recording_asset(
        active_recording.recording_options,
        state.data_dir.join("recording/stream.m3u8"),
        RecordingAssetType::CombinedSourcePlaylist,
        Some(move |info: ProgressInfo| {
            if let Err(err) = UploadProgressEvent(info.into()).emit(&app_handle) {
                tracing::error!("Failed to emit event for upload progress: {}", err);
            };
        }),
    )
    .await
    .ok();

    active_recording.shutdown_flag.store(true, Ordering::SeqCst);

    // if !config::is_local_mode() {
    //     tracing::debug!("Waiting for uploads to finish...");
    //     active_recording.uploading_finished.await.ok();
    // }

    tracing::info!("All recordings and uploads stopped.");

    Ok(())
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
                upload_recording_asset::<fn(ProgressInfo)>(
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
    media_recorder
        .start_media_recording(
            options.clone(),
            screenshot_dir,
            recording_dir,
            audio_name.as_ref().map(String::as_str),
            max_screen_width,
            max_screen_height,
        )
        .await?;
    Ok(media_recorder)
}
