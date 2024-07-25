use futures::future::join_all;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::File;
use std::io::{self, BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::State;
use tokio::sync::Mutex;
use tokio::time::Duration;

use crate::app::config;
use crate::upload::{self, upload_file};

use crate::media::MediaRecorder;

pub struct RecordingState {
    pub media_process: Option<MediaRecorder>,
    pub recording_options: Option<RecordingOptions>,
    pub shutdown_flag: Arc<AtomicBool>,
    pub video_uploading_finished: Arc<AtomicBool>,
    pub audio_uploading_finished: Arc<AtomicBool>,
    pub data_dir: Option<PathBuf>,
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
}

#[tauri::command]
#[specta::specta]
#[tracing::instrument(skip(state))]
pub async fn start_dual_recording(
    state: State<'_, Arc<Mutex<RecordingState>>>,
    options: RecordingOptions,
) -> Result<(), String> {
    tracing::info!("Starting screen recording...");
    let mut state_guard = state.lock().await;

    let shutdown_flag = Arc::new(AtomicBool::new(false));

    let data_dir = state_guard
        .data_dir
        .as_ref()
        .ok_or("Data directory is not set in the recording state".to_string())?
        .clone();

    tracing::debug!("data_dir: {:?}", data_dir);

    let screenshot_dir = data_dir.join("screenshots");
    let audio_chunks_dir = data_dir.join("chunks/audio");
    let video_chunks_dir = data_dir.join("chunks/video");

    clean_and_create_dir(&screenshot_dir)?;
    clean_and_create_dir(&audio_chunks_dir)?;
    clean_and_create_dir(&video_chunks_dir)?;

    let audio_name = if options.audio_name.is_empty() {
        None
    } else {
        Some(options.audio_name.clone())
    };

    let media_recording_preparation = prepare_media_recording(
        &options,
        &screenshot_dir,
        &audio_chunks_dir,
        &video_chunks_dir,
        audio_name,
        state_guard.max_screen_width,
        state_guard.max_screen_height,
    );
    let media_recording_result = media_recording_preparation
        .await
        .map_err(|e| e.to_string())?;

    state_guard.media_process = Some(media_recording_result);
    state_guard.recording_options = Some(options.clone());
    state_guard.shutdown_flag = shutdown_flag.clone();
    state_guard.video_uploading_finished = Arc::new(AtomicBool::new(false));
    state_guard.audio_uploading_finished = Arc::new(AtomicBool::new(false));

    if !config::is_local_mode() {
        let video_upload = start_upload_loop(
            video_chunks_dir.clone(),
            options.clone(),
            upload::FileType::Video,
            shutdown_flag.clone(),
            state_guard.video_uploading_finished.clone(),
        );
        let audio_upload = start_upload_loop(
            audio_chunks_dir,
            options.clone(),
            upload::FileType::Audio,
            shutdown_flag.clone(),
            state_guard.audio_uploading_finished.clone(),
        );

        drop(state_guard);

        tracing::info!("Starting upload loops...");

        match tokio::try_join!(video_upload, audio_upload) {
            Ok(_) => {
                tracing::info!("Both upload loops completed successfully.");
            }
            Err(e) => {
                tracing::error!("An error occurred: {}", e);
            }
        }
    } else {
        tracing::info!("Skipping upload loops due to NEXT_PUBLIC_LOCAL_MODE being set to 'true'.");
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn stop_all_recordings(
    state: State<'_, Arc<Mutex<RecordingState>>>,
) -> Result<(), String> {
    let mut guard = state.lock().await;

    if let Some(mut media_process) = guard.media_process.take() {
        tracing::info!("Stopping media recording...");
        media_process
            .stop_media_recording()
            .await
            .expect("Failed to stop media recording");
    }

    guard.shutdown_flag.store(true, Ordering::SeqCst);

    if !config::is_local_mode() {
        while !guard.video_uploading_finished.load(Ordering::SeqCst)
            || !guard.audio_uploading_finished.load(Ordering::SeqCst)
        {
            tracing::debug!("Waiting for uploads to finish...");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    tracing::info!("All recordings and uploads stopped.");

    Ok(())
}

fn clean_and_create_dir(dir: &Path) -> Result<(), String> {
    if dir.exists() {
        // Instead of just reading the directory, this will also handle subdirectories.
        std::fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    if !dir.to_string_lossy().contains("screenshots") {
        let segment_list_path = dir.join("segment_list.txt");
        match File::open(&segment_list_path) {
            Ok(_) => Ok(()),
            Err(ref e) if e.kind() == ErrorKind::NotFound => {
                File::create(&segment_list_path).map_err(|e| e.to_string())?;
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    } else {
        Ok(())
    }
}

async fn start_upload_loop(
    chunks_dir: PathBuf,
    options: RecordingOptions,
    file_type: upload::FileType,
    shutdown_flag: Arc<AtomicBool>,
    uploading_finished: Arc<AtomicBool>,
) -> Result<(), String> {
    let mut watched_segments: HashSet<String> = HashSet::new();
    let mut is_final_loop = false;

    loop {
        let mut upload_tasks = vec![];
        if shutdown_flag.load(Ordering::SeqCst) {
            if is_final_loop {
                break;
            }
            is_final_loop = true;
        }

        let current_segments = load_segment_list(&chunks_dir.join("segment_list.txt"))
            .map_err(|e| e.to_string())?
            .difference(&watched_segments)
            .cloned()
            .collect::<HashSet<String>>();

        for segment_filename in &current_segments {
            let segment_path = chunks_dir.join(segment_filename);
            if segment_path.is_file() {
                let options_clone = options.clone();
                upload_tasks.push(tokio::spawn(async move {
                    tracing::debug!("Uploading video for {file_type}: {segment_path:?}");
                    upload_file(Some(options_clone), segment_path, file_type)
                        .await
                        .map(|_| ())
                }));
            }
            watched_segments.insert(segment_filename.clone());
        }

        if !upload_tasks.is_empty() {
            let _ = join_all(upload_tasks).await;
        }

        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    uploading_finished.store(true, Ordering::SeqCst);
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

async fn prepare_media_recording(
    options: &RecordingOptions,
    screenshot_dir: &Path,
    audio_chunks_dir: &Path,
    video_chunks_dir: &Path,
    audio_name: Option<String>,
    max_screen_width: usize,
    max_screen_height: usize,
) -> Result<MediaRecorder, String> {
    let mut media_recorder = MediaRecorder::new();
    media_recorder
        .start_media_recording(
            options.clone(),
            screenshot_dir,
            audio_chunks_dir,
            video_chunks_dir,
            audio_name.as_ref().map(String::as_str),
            max_screen_width,
            max_screen_height,
        )
        .await?;
    Ok(media_recorder)
}
