use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::captions::{transcribe_audio, CaptionData, TranscriptionEngine};

fn format_srt_timestamp(seconds: f64) -> String {
    let total_millis = (seconds * 1000.0).round() as u64;
    let hours = total_millis / 3_600_000;
    let minutes = (total_millis % 3_600_000) / 60_000;
    let secs = (total_millis % 60_000) / 1000;
    let millis = total_millis % 1000;
    format!("{hours:02}:{minutes:02}:{secs:02},{millis:03}")
}

fn convert_captions_to_srt(caption_data: &CaptionData) -> String {
    let mut srt = String::new();
    for (index, segment) in caption_data.segments.iter().enumerate() {
        let start = format_srt_timestamp(f64::from(segment.start));
        let end = format_srt_timestamp(f64::from(segment.end));
        srt.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            start,
            end,
            segment.text.trim()
        ));
    }
    srt
}

fn resolve_studio_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_local_data = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("Failed to resolve local app data directory: {e}"))?;

    let default_whisper = app_local_data.join("models").join("ggml-base.bin");
    if default_whisper.exists() {
        return Ok(default_whisper);
    }

    let default_parakeet = app_local_data.join("models").join("parakeet-tdt");
    if default_parakeet.exists() {
        return Ok(default_parakeet);
    }

    Ok(default_whisper)
}

#[tauri::command]
#[specta::specta]
pub async fn generate_studio_captions(
    app: AppHandle,
    audio_path: String,
    output_srt_path: String,
) -> Result<String, String> {
    let input = Path::new(&audio_path);
    if !input.exists() {
        return Err(format!("Studio recording path not found: {audio_path}"));
    }

    let model_path_buf = resolve_studio_model_path(&app)?;
    let model_path = model_path_buf.to_string_lossy().to_string();

    let engine = if model_path_buf.is_dir() {
        TranscriptionEngine::Parakeet
    } else {
        TranscriptionEngine::Whisper
    };

    let caption_data =
        transcribe_audio(app, audio_path, model_path, "auto".to_string(), engine).await?;

    let srt_content = convert_captions_to_srt(&caption_data);

    let output_path = PathBuf::from(&output_srt_path);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create output directory: {e}"))?;
    }

    fs::write(&output_path, srt_content)
        .map_err(|e| format!("Failed to write SRT captions file: {e}"))?;

    Ok(output_srt_path)
}
