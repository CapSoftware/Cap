use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::fs::File;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Window, Emitter};
use tempfile::tempdir;
use tokio::sync::Mutex;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
use tokio::io::AsyncWriteExt;
use cap_project;

// Re-export caption types from cap_project
pub use cap_project::{CaptionSegment, CaptionSettings};

// Convert the project type's float precision from f32 to f64 for compatibility
#[derive(Debug, Serialize, Deserialize, Type, Clone)]
pub struct CaptionData {
    pub segments: Vec<CaptionSegment>,
    pub settings: Option<CaptionSettings>,
}

// Model context is shared and cached
lazy_static::lazy_static! {
    static ref WHISPER_CONTEXT: Arc<Mutex<Option<WhisperContext>>> = Arc::new(Mutex::new(None));
}

// Constants
const WHISPER_SAMPLE_RATE: u32 = 16000;

/// Function to handle creating directories for the model
#[tauri::command]
#[specta::specta]
pub async fn create_dir(path: String, _recursive: bool) -> Result<(), String> {
    std::fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create directory: {}", e))
}

/// Function to save the model file
#[tauri::command]
#[specta::specta]
pub async fn save_model_file(path: String, data: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, &data)
        .map_err(|e| format!("Failed to write model file: {}", e))
}

/// Extract audio from a video file and save it as a temporary WAV file
async fn extract_audio_from_video(video_path: &str, output_path: &PathBuf) -> Result<(), String> {
    // First check if the video has an audio stream
    let status = Command::new("ffprobe")
        .args([
            "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=codec_type",
            "-of", "default=noprint_wrappers=1:nokey=1",
            video_path,
        ])
        .output()
        .map_err(|e| format!("Failed to execute ffprobe: {}", e))?;

    if !status.status.success() || status.stdout.is_empty() {
        return Err("No audio stream found in the video file".to_string());
    }

    let output_path_str = output_path.to_str().ok_or("Invalid path")?;
    
    // Use ffmpeg to extract audio from the video and convert to WAV format
    let status = Command::new("ffmpeg")
        .args([
            "-i", video_path,  // Input video file
            "-vn",            // Disable video recording
            "-acodec", "pcm_s16le", // PCM 16-bit little-endian audio codec
            "-ar", "16000",    // Set audio sampling rate to 16kHz (required by Whisper)
            "-ac", "1",        // Mono audio channel
            "-y",              // Overwrite output file
            output_path_str,    // Output WAV file
        ])
        .status()
        .map_err(|e| format!("Failed to execute ffmpeg: {}", e))?;
    
    if !status.success() {
        return Err(format!("ffmpeg failed with status: {}", status));
    }
    
    Ok(())
}

/// Load or initialize the WhisperContext
async fn get_whisper_context(model_path: &str) -> Result<Arc<WhisperContext>, String> {
    let mut context_guard = WHISPER_CONTEXT.lock().await;
    
    // Always create a new context to avoid issues with multiple uses
    log::info!("Initializing Whisper context with model: {}", model_path);
    let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .map_err(|e| format!("Failed to load Whisper model: {}", e))?;
    
    *context_guard = Some(ctx);
    
    // Get a reference to the context and wrap it in an Arc
    let context_ref = context_guard.as_ref().unwrap();
    let context_arc = unsafe { Arc::new(std::ptr::read(context_ref)) };
    Ok(context_arc)
}

/// Process audio file with Whisper for transcription
fn process_with_whisper(audio_path: &PathBuf, context: Arc<WhisperContext>, language: &str) -> Result<CaptionData, String> {
    log::info!("Processing audio file: {:?}", audio_path);
    
    // Set up parameters for Whisper
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    
    // Configure parameters for better caption quality
    params.set_translate(false);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_token_timestamps(true);  // Enable timestamps for captions
    params.set_language(Some(if language == "auto" { "auto" } else { language }));  // Use selected language or auto-detect
    params.set_max_len(i32::MAX);       // No max length for transcription
    
    // Load audio file
    let mut audio_file = File::open(audio_path)
        .map_err(|e| format!("Failed to open audio file: {} at path: {:?}", e, audio_path))?;
    let mut audio_data = Vec::new();
    audio_file.read_to_end(&mut audio_data)
        .map_err(|e| format!("Failed to read audio file: {}", e))?;
    
    log::info!("Processing audio file of size: {} bytes", audio_data.len());
    
    // Convert audio data to the required format (16-bit mono PCM)
    let mut audio_data_f32 = Vec::new();
    for i in (0..audio_data.len()).step_by(2) {
        if i + 1 < audio_data.len() {
            let sample = i16::from_le_bytes([audio_data[i], audio_data[i + 1]]) as f32 / 32768.0;
            audio_data_f32.push(sample);
        }
    }
    
    log::info!("Converted {} samples to f32 format", audio_data_f32.len());
    
    // Run the transcription
    let mut state = context.create_state()
        .map_err(|e| format!("Failed to create Whisper state: {}", e))?;
    
    state.full(params, &audio_data_f32[..])
        .map_err(|e| format!("Failed to run Whisper transcription: {}", e))?;
    
    // Process results: convert Whisper segments to CaptionSegment
    let num_segments = state.full_n_segments()
        .map_err(|e| format!("Failed to get number of segments: {}", e))?;
    
    log::info!("Found {} segments", num_segments);
    
    let mut segments = Vec::new();
    
    for i in 0..num_segments {
        let text = state.full_get_segment_text(i)
            .map_err(|e| format!("Failed to get segment text: {}", e))?;
        
        // Properly unwrap the Result first, then convert i64 to f64
        let start_i64 = state.full_get_segment_t0(i)
            .map_err(|e| format!("Failed to get segment start time: {}", e))?;
        let end_i64 = state.full_get_segment_t1(i)
            .map_err(|e| format!("Failed to get segment end time: {}", e))?;
        
        // Convert timestamps from centiseconds to seconds (as f32 for CaptionSegment)
        let start_time = (start_i64 as f32) / 100.0;
        let end_time = (end_i64 as f32) / 100.0;
        
        // Add debug logging for timestamps
        log::info!("Segment {}: start={}, end={}, text='{}'", i, start_time, end_time, text.trim());
        
        if !text.trim().is_empty() {
            segments.push(CaptionSegment {
                id: format!("segment-{}", i),
                start: start_time, 
                end: end_time,
                text: text.trim().to_string(),
            });
        }
    }
    
    log::info!("Successfully processed {} segments", segments.len());
    
    Ok(CaptionData { segments, settings: None })
}

/// Function to transcribe audio from a video file using Whisper
#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio(video_path: String, model_path: String, language: String) -> Result<CaptionData, String> {
    // Check if files exist
    if !std::path::Path::new(&video_path).exists() {
        return Err(format!("Audio file not found: {}", video_path));
    }
    
    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }
    
    // Create temp dir first and keep it alive until the end of the function
    let temp_dir = tempdir().map_err(|e| format!("Failed to create temp dir: {}", e))?;
    let audio_path = temp_dir.path().join("audio.wav");
    
    // Extract audio from video
    extract_audio_from_video(&video_path, &audio_path).await?;
    
    // Verify the audio file was created
    if !audio_path.exists() {
        return Err("Failed to create audio file".to_string());
    }
    
    log::info!("Audio file created at: {:?}", audio_path);
    
    // Get or initialize Whisper context
    let context = get_whisper_context(&model_path).await?;
    
    // Process with Whisper
    let captions = process_with_whisper(&audio_path, context, &language)?;
    
    // Temp dir will be cleaned up when it goes out of scope here
    Ok(captions)
}

/// Function to save caption data to a file
#[tauri::command]
#[specta::specta]
pub async fn save_captions(video_id: String, captions: CaptionData, app: AppHandle) -> Result<(), String> {
    tracing::info!("Saving captions for video_id: {}", video_id);
    
    let captions_dir = app_captions_dir(&app, &video_id)?;
    
    if !captions_dir.exists() {
        tracing::info!("Creating captions directory: {:?}", captions_dir);
        std::fs::create_dir_all(&captions_dir).map_err(|e| {
            tracing::error!("Failed to create captions directory: {}", e);
            format!("Failed to create captions directory: {}", e)
        })?;
    }
    
    let captions_path = captions_dir.join("captions.json");
    
    tracing::info!("Writing captions to: {:?}", captions_path);
    
    // Convert CaptionData to project CaptionsData
    let project_captions = cap_project::CaptionsData {
        segments: captions.segments.iter().map(|seg| cap_project::CaptionSegment {
            id: seg.id.clone(),
            start: seg.start, // Already f32, no conversion needed
            end: seg.end,     // Already f32, no conversion needed
            text: seg.text.clone(),
        }).collect(),
        settings: captions.settings.clone().unwrap_or_default(),
    };
    
    // Serialize to JSON
    let json = serde_json::to_string_pretty(&project_captions).map_err(|e| {
        tracing::error!("Failed to serialize captions: {}", e);
        format!("Failed to serialize captions: {}", e)
    })?;
    
    std::fs::write(captions_path, json).map_err(|e| {
        tracing::error!("Failed to write captions file: {}", e);
        format!("Failed to write captions file: {}", e)
    })?;
    
    tracing::info!("Successfully saved captions");
    Ok(())
}

/// Function to load caption data from a file
#[tauri::command]
#[specta::specta]
pub async fn load_captions(video_id: String, app: AppHandle) -> Result<Option<CaptionData>, String> {
    tracing::info!("Loading captions for video_id: {}", video_id);
    let captions_dir = app_captions_dir(&app, &video_id)?;
    let captions_path = captions_dir.join("captions.json");
    
    if !captions_path.exists() {
        tracing::info!("No captions file found at: {:?}", captions_path);
        return Ok(None);
    }
    
    tracing::info!("Reading captions from: {:?}", captions_path);
    let json = match std::fs::read_to_string(captions_path.clone()) {
        Ok(j) => j,
        Err(e) => {
            tracing::error!("Failed to read captions file: {}", e);
            return Err(format!("Failed to read captions file: {}", e));
        }
    };
    
    tracing::info!("Parsing captions JSON");
    match serde_json::from_str::<cap_project::CaptionsData>(&json) {
        Ok(project_captions) => {
            tracing::info!("Successfully loaded captions");
            
            // Convert cap_project::CaptionsData to CaptionData
            let tauri_captions = CaptionData {
                segments: project_captions.segments.iter().map(|seg| CaptionSegment {
                    id: seg.id.clone(),
                    start: seg.start, // Don't convert - keep as f32
                    end: seg.end,     // Don't convert - keep as f32
                    text: seg.text.clone(),
                }).collect(),
                settings: Some(project_captions.settings),
            };
            
            Ok(Some(tauri_captions))
        }
        Err(e) => {
            tracing::error!("Failed to parse captions: {}", e);
            Err(format!("Failed to parse captions: {}", e))
        }
    }
}

/// Helper function to get the captions directory for a video
fn app_captions_dir(app: &AppHandle, video_id: &str) -> Result<PathBuf, String> {
    tracing::info!("Getting captions directory for video_id: {}", video_id);
    
    // Get the app data directory
    let app_dir = app.path().app_data_dir()
        .map_err(|_| "Failed to get app data directory".to_string())?;
    
    // Create a dedicated captions directory
    // Strip .cap extension if present in video_id
    let clean_video_id = video_id.trim_end_matches(".cap");
    let captions_dir = app_dir.join("captions").join(clean_video_id);
    
    tracing::info!("Captions directory path: {:?}", captions_dir);
    Ok(captions_dir)
}

// Add new type for download progress
#[derive(Debug, Serialize, Type, tauri_specta::Event, Clone)]
pub struct DownloadProgress {
    pub progress: f64,
    pub message: String,
}

impl DownloadProgress {
    const EVENT_NAME: &'static str = "download-progress";
}

/// Helper function to download a Whisper model from Hugging Face Hub
#[tauri::command]
#[specta::specta]
pub async fn download_whisper_model(window: Window, model_name: String, output_path: String) -> Result<(), String> {
    // Define model URLs based on model names
    let model_url = match model_name.as_str() {
        "tiny" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
        "base" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
        "small" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
        "medium" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
        "large" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        "large-v3" => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin",
        _ => "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin", // Default to tiny
    };
    
    // Create the client and download the model
    let client = Client::new();
    let response = client.get(model_url)
        .send()
        .await
        .map_err(|e| format!("Failed to download model: {}", e))?;
    
    if !response.status().is_success() {
        return Err(format!("Failed to download model: HTTP {}", response.status()));
    }
    
    // Get the total size for progress calculation
    let total_size = response.content_length().unwrap_or(0);
    
    // Create a file to write to
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    let mut file = tokio::fs::File::create(&output_path)
        .await
        .map_err(|e| format!("Failed to create file: {}", e))?;
    
    // Download and write in chunks
    let mut downloaded = 0;
    let mut bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to get response bytes: {}", e))?;
    
    // Write the bytes in chunks to show progress
    const CHUNK_SIZE: usize = 1024 * 1024; // 1MB chunks
    while !bytes.is_empty() {
        let chunk_size = std::cmp::min(CHUNK_SIZE, bytes.len());
        let chunk = bytes.split_to(chunk_size);
        
        file.write_all(&chunk).await
            .map_err(|e| format!("Error while writing to file: {}", e))?;
        
        downloaded += chunk_size as u64;
        
        // Calculate and emit progress
        let progress = if total_size > 0 {
            (downloaded as f64 / total_size as f64) * 100.0
        } else {
            0.0
        };
        
        window.emit(
            DownloadProgress::EVENT_NAME,
            DownloadProgress {
                message: format!("Downloading model: {:.1}%", progress),
                progress,
            },
        ).map_err(|e| format!("Failed to emit progress: {}", e))?;
    }

    // Ensure file is properly written
    file.flush().await
        .map_err(|e| format!("Failed to flush file: {}", e))?;

    Ok(())
}

/// Function to check if a model file exists
#[tauri::command]
#[specta::specta]
pub async fn check_model_exists(model_path: String) -> Result<bool, String> {
    Ok(std::path::Path::new(&model_path).exists())
}

/// Function to delete a downloaded model
#[tauri::command]
#[specta::specta]
pub async fn delete_whisper_model(model_path: String) -> Result<(), String> {
    if !std::path::Path::new(&model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }

    tokio::fs::remove_file(&model_path)
        .await
        .map_err(|e| format!("Failed to delete model file: {}", e))?;

    Ok(())
}

/// Convert caption segments to SRT format
fn captions_to_srt(captions: &CaptionData) -> String {
    let mut srt = String::new();
    for (i, segment) in captions.segments.iter().enumerate() {
        // Convert start and end times from seconds to HH:MM:SS,mmm format
        let start_time = format_srt_time(f64::from(segment.start));
        let end_time = format_srt_time(f64::from(segment.end));
        
        // Write SRT entry
        srt.push_str(&format!("{}\n{} --> {}\n{}\n\n", 
            i + 1, 
            start_time,
            end_time,
            segment.text.trim()
        ));
    }
    srt
}

/// Format time in seconds to SRT time format (HH:MM:SS,mmm)
fn format_srt_time(seconds: f64) -> String {
    let hours = (seconds / 3600.0) as i32;
    let minutes = ((seconds % 3600.0) / 60.0) as i32;
    let secs = (seconds % 60.0) as i32;
    let millis = ((seconds % 1.0) * 1000.0) as i32;
    format!("{:02}:{:02}:{:02},{:03}", hours, minutes, secs, millis)
}

/// Export captions to an SRT file
#[tauri::command]
#[specta::specta]
pub async fn export_captions_srt(video_id: String, app: AppHandle) -> Result<Option<PathBuf>, String> {
    tracing::info!("Starting SRT export for video_id: {}", video_id);
    
    // Load captions
    tracing::info!("Loading captions from storage");
    let captions = match load_captions(video_id.clone(), app.clone()).await? {
        Some(c) => {
            tracing::info!("Found {} caption segments to export", c.segments.len());
            c
        }
        None => {
            tracing::info!("No captions found for video_id: {}", video_id);
            return Ok(None);
        }
    };
    
    // Convert to SRT format
    tracing::info!("Converting captions to SRT format");
    let srt_content = captions_to_srt(&captions);
    
    // Get path for SRT file
    let captions_dir = app_captions_dir(&app, &video_id)?;
    let srt_path = captions_dir.join("captions.srt");
    tracing::info!("Will write SRT file to: {:?}", srt_path);
    
    // Write SRT file
    match std::fs::write(&srt_path, srt_content) {
        Ok(_) => {
            tracing::info!("Successfully wrote SRT file to: {:?}", srt_path);
            Ok(Some(srt_path))
        }
        Err(e) => {
            tracing::error!("Failed to write SRT file: {}", e);
            Err(format!("Failed to write SRT file: {}", e))
        }
    }
}
