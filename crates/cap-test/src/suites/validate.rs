use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::process::Command;
use tracing::{debug, warn};

use crate::results::{AudioValidation, SyncValidation, ValidationResult, VideoValidation};

#[derive(Debug, Deserialize)]
struct FfprobeOutput {
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: String,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    duration: Option<String>,
    nb_frames: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u32>,
    start_time: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    #[allow(dead_code)]
    format_name: Option<String>,
}

fn parse_frame_rate(rate: &str) -> f64 {
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().unwrap_or(0.0);
        let den: f64 = den.parse().unwrap_or(1.0);
        if den > 0.0 {
            return num / den;
        }
    }
    rate.parse().unwrap_or(0.0)
}

fn run_ffprobe(path: &Path) -> Result<FfprobeOutput> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()
        .context("Failed to run ffprobe - is ffmpeg installed?")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffprobe failed: {}", stderr);
    }

    let json = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(&json).context("Failed to parse ffprobe output")
}

pub async fn validate_recording(path: &Path) -> Result<ValidationResult> {
    let path_str = path.display().to_string();

    if !path.exists() {
        return Ok(ValidationResult {
            path: path_str,
            valid: false,
            video_info: None,
            audio_info: None,
            sync_info: None,
            errors: vec!["Recording path does not exist".to_string()],
            warnings: vec![],
        });
    }

    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut video_info = None;
    let mut audio_info = None;
    let mut sync_info = None;

    if path.is_dir() {
        let (v, a, s, e, w) = validate_cap_project(path).await?;
        video_info = v;
        audio_info = a;
        sync_info = s;
        errors.extend(e);
        warnings.extend(w);
    } else if path
        .extension()
        .is_some_and(|e| e == "mp4" || e == "m4v" || e == "mov")
    {
        let (v, a, s, e, w) = validate_video_file(path).await?;
        video_info = v;
        audio_info = a;
        sync_info = s;
        errors.extend(e);
        warnings.extend(w);
    } else {
        errors.push("Unknown recording format".to_string());
    }

    let valid = errors.is_empty();

    Ok(ValidationResult {
        path: path_str,
        valid,
        video_info,
        audio_info,
        sync_info,
        errors,
        warnings,
    })
}

async fn validate_cap_project(
    path: &Path,
) -> Result<(
    Option<VideoValidation>,
    Option<AudioValidation>,
    Option<SyncValidation>,
    Vec<String>,
    Vec<String>,
)> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut video_info = None;
    let mut audio_info = None;

    let meta_path = path.join("recording-meta.json");
    if !meta_path.exists() {
        errors.push("Missing recording-meta.json".to_string());
    }

    let content_path = path.join("content");
    if !content_path.exists() {
        errors.push("Missing content directory".to_string());
        return Ok((None, None, None, errors, warnings));
    }

    let mut segment_files: Vec<_> = std::fs::read_dir(&content_path)
        .ok()
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .filter(|e| {
                    e.path()
                        .extension()
                        .is_some_and(|ext| ext == "m4s" || ext == "mp4")
                })
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default();

    segment_files.sort();

    if segment_files.is_empty() {
        errors.push("No video segments found".to_string());
        return Ok((None, None, None, errors, warnings));
    }

    let mut total_duration = 0.0;
    let mut total_frames = 0u64;
    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0f64;
    let mut codec = String::new();

    for segment in &segment_files {
        match run_ffprobe(segment) {
            Ok(probe) => {
                for stream in &probe.streams {
                    if stream.codec_type == "video" {
                        if width == 0 {
                            width = stream.width.unwrap_or(0);
                            height = stream.height.unwrap_or(0);
                            codec = stream.codec_name.clone().unwrap_or_default();
                            if let Some(ref rate) = stream.r_frame_rate {
                                fps = parse_frame_rate(rate);
                            } else if let Some(ref rate) = stream.avg_frame_rate {
                                fps = parse_frame_rate(rate);
                            }
                        }
                        if let Some(ref dur) = stream.duration
                            && let Ok(d) = dur.parse::<f64>()
                        {
                            total_duration += d;
                        }
                        if let Some(ref frames) = stream.nb_frames
                            && let Ok(f) = frames.parse::<u64>()
                        {
                            total_frames += f;
                        }
                    }
                }
                if total_duration == 0.0
                    && let Some(ref format) = probe.format
                    && let Some(ref dur) = format.duration
                    && let Ok(d) = dur.parse::<f64>()
                {
                    total_duration += d;
                }
            }
            Err(e) => {
                debug!("Failed to probe segment {:?}: {}", segment, e);
            }
        }
    }

    if width > 0 {
        if total_frames == 0 && fps > 0.0 {
            total_frames = (total_duration * fps) as u64;
        }
        video_info = Some(VideoValidation {
            width,
            height,
            fps,
            duration_secs: total_duration,
            frame_count: total_frames,
            codec,
        });
    } else {
        errors.push("Could not determine video properties from segments".to_string());
    }

    let audio_files = ["audio.ogg", "audio-input.ogg", "mic.ogg"];
    for audio_file in audio_files {
        let audio_path = path.join(audio_file);
        if audio_path.exists() {
            match run_ffprobe(&audio_path) {
                Ok(probe) => {
                    for stream in probe.streams {
                        if stream.codec_type == "audio" {
                            let duration = stream
                                .duration
                                .as_ref()
                                .and_then(|d| d.parse::<f64>().ok())
                                .or_else(|| {
                                    probe
                                        .format
                                        .as_ref()
                                        .and_then(|f| f.duration.as_ref())
                                        .and_then(|d| d.parse::<f64>().ok())
                                })
                                .unwrap_or(0.0);

                            audio_info = Some(AudioValidation {
                                sample_rate: stream
                                    .sample_rate
                                    .as_ref()
                                    .and_then(|s| s.parse().ok())
                                    .unwrap_or(48000),
                                channels: stream.channels.unwrap_or(2) as u16,
                                duration_secs: duration,
                                codec: stream.codec_name.unwrap_or_else(|| "unknown".to_string()),
                            });
                            break;
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to probe audio file {:?}: {}", audio_path, e);
                }
            }
            break;
        }
    }

    if audio_info.is_none() {
        warnings.push("No audio track found".to_string());
    }

    let sync_info = if let (Some(v), Some(a)) = (&video_info, &audio_info) {
        let drift = (v.duration_secs - a.duration_secs).abs() * 1000.0;
        Some(SyncValidation {
            video_duration_secs: v.duration_secs,
            audio_duration_secs: a.duration_secs,
            drift_ms: drift,
            in_sync: drift < 100.0,
        })
    } else {
        None
    };

    Ok((video_info, audio_info, sync_info, errors, warnings))
}

async fn validate_video_file(
    path: &Path,
) -> Result<(
    Option<VideoValidation>,
    Option<AudioValidation>,
    Option<SyncValidation>,
    Vec<String>,
    Vec<String>,
)> {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut video_info = None;
    let mut audio_info = None;

    let probe = match run_ffprobe(path) {
        Ok(p) => p,
        Err(e) => {
            errors.push(format!("Failed to probe file: {}", e));
            return Ok((None, None, None, errors, warnings));
        }
    };

    let mut video_start_time = 0.0f64;
    let mut audio_start_time = 0.0f64;

    for stream in &probe.streams {
        match stream.codec_type.as_str() {
            "video" => {
                let fps = stream
                    .r_frame_rate
                    .as_ref()
                    .map(|r| parse_frame_rate(r))
                    .or_else(|| stream.avg_frame_rate.as_ref().map(|r| parse_frame_rate(r)))
                    .unwrap_or(0.0);

                let duration = stream
                    .duration
                    .as_ref()
                    .and_then(|d| d.parse::<f64>().ok())
                    .or_else(|| {
                        probe
                            .format
                            .as_ref()
                            .and_then(|f| f.duration.as_ref())
                            .and_then(|d| d.parse::<f64>().ok())
                    })
                    .unwrap_or(0.0);

                let frame_count = stream
                    .nb_frames
                    .as_ref()
                    .and_then(|f| f.parse::<u64>().ok())
                    .unwrap_or((duration * fps) as u64);

                video_start_time = stream
                    .start_time
                    .as_ref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);

                video_info = Some(VideoValidation {
                    width: stream.width.unwrap_or(0),
                    height: stream.height.unwrap_or(0),
                    fps,
                    duration_secs: duration,
                    frame_count,
                    codec: stream.codec_name.clone().unwrap_or_default(),
                });
            }
            "audio" => {
                let duration = stream
                    .duration
                    .as_ref()
                    .and_then(|d| d.parse::<f64>().ok())
                    .or_else(|| {
                        probe
                            .format
                            .as_ref()
                            .and_then(|f| f.duration.as_ref())
                            .and_then(|d| d.parse::<f64>().ok())
                    })
                    .unwrap_or(0.0);

                audio_start_time = stream
                    .start_time
                    .as_ref()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);

                audio_info = Some(AudioValidation {
                    sample_rate: stream
                        .sample_rate
                        .as_ref()
                        .and_then(|s| s.parse().ok())
                        .unwrap_or(48000),
                    channels: stream.channels.unwrap_or(2) as u16,
                    duration_secs: duration,
                    codec: stream.codec_name.clone().unwrap_or_default(),
                });
            }
            _ => {}
        }
    }

    if video_info.is_none() {
        errors.push("No video stream found in file".to_string());
    }

    if audio_info.is_none() {
        warnings.push("No audio stream found in file".to_string());
    }

    let sync_info = if let (Some(v), Some(a)) = (&video_info, &audio_info) {
        let start_drift_ms = (video_start_time - audio_start_time).abs() * 1000.0;
        let duration_drift_ms = (v.duration_secs - a.duration_secs).abs() * 1000.0;
        let total_drift = start_drift_ms.max(duration_drift_ms);

        Some(SyncValidation {
            video_duration_secs: v.duration_secs,
            audio_duration_secs: a.duration_secs,
            drift_ms: total_drift,
            in_sync: total_drift < 100.0,
        })
    } else {
        None
    };

    Ok((video_info, audio_info, sync_info, errors, warnings))
}
