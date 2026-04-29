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

fn collect_display_dirs(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = entry.file_name();
            if name == "display" && path.join("init.mp4").exists() {
                out.push(path);
            } else {
                collect_display_dirs(&path, out);
            }
        }
    }
}

fn validate_dash_display_dirs(
    dirs: &[std::path::PathBuf],
) -> (Option<VideoValidation>, Vec<String>, Vec<String>) {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut width = 0u32;
    let mut height = 0u32;
    let mut fps = 0.0f64;
    let mut codec = String::new();
    let mut total_duration = 0.0f64;
    let mut total_frames = 0u64;

    for dir in dirs {
        let init_path = dir.join("init.mp4");
        if let Ok(probe) = run_ffprobe(&init_path) {
            for stream in &probe.streams {
                if stream.codec_type == "video" && width == 0 {
                    width = stream.width.unwrap_or(0);
                    height = stream.height.unwrap_or(0);
                    codec = stream.codec_name.clone().unwrap_or_default();
                    if let Some(ref rate) = stream.r_frame_rate {
                        fps = parse_frame_rate(rate);
                    } else if let Some(ref rate) = stream.avg_frame_rate {
                        fps = parse_frame_rate(rate);
                    }
                }
            }
        }

        let m3u8_path = dir.join("media_0.m3u8");
        if m3u8_path.exists()
            && let Ok(contents) = std::fs::read_to_string(&m3u8_path)
        {
            for line in contents.lines() {
                if let Some(duration_str) = line.strip_prefix("#EXTINF:") {
                    let dur_str = duration_str.split(',').next().unwrap_or("");
                    if let Ok(dur) = dur_str.parse::<f64>() {
                        total_duration += dur;
                    }
                }
            }
        }

        if total_duration == 0.0 {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            let m4s_count = entries
                .flatten()
                .filter(|e| e.path().extension().is_some_and(|ext| ext == "m4s"))
                .count();
            if m4s_count > 0 {
                total_duration = m4s_count as f64 * 3.0;
                warnings.push(format!(
                    "Estimated duration from {} m4s segments (no m3u8 found)",
                    m4s_count
                ));
            }
        }
    }

    if width == 0 {
        errors.push("Could not determine video properties from DASH segments".to_string());
        return (None, errors, warnings);
    }

    if fps > 240.0 {
        fps = 0.0;
    }

    if fps > 0.0 && total_duration > 0.0 {
        total_frames = (total_duration * fps) as u64;
    }

    (
        Some(VideoValidation {
            width,
            height,
            fps,
            duration_secs: total_duration,
            frame_count: total_frames,
            codec,
        }),
        errors,
        warnings,
    )
}

fn collect_video_segments(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_video_segments(&path, out);
        } else if path
            .extension()
            .is_some_and(|ext| ext == "m4s" || ext == "mp4")
        {
            out.push(path);
        }
    }
}

fn collect_audio_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio_files(&path, out);
        } else if path
            .extension()
            .is_some_and(|ext| ext == "m4a" || ext == "ogg" || ext == "aac")
        {
            out.push(path);
        }
    }
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

    let mut display_dirs = Vec::new();
    collect_display_dirs(&content_path, &mut display_dirs);

    if !display_dirs.is_empty() {
        let (v, e, w) = validate_dash_display_dirs(&display_dirs);
        video_info = v;
        errors.extend(e);
        warnings.extend(w);
    } else {
        let mut segment_files: Vec<_> = Vec::new();
        collect_video_segments(&content_path, &mut segment_files);
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
    }

    let mut audio_candidates = Vec::new();
    let top_level_audio = ["audio.ogg", "audio-input.ogg", "mic.ogg"];
    for audio_file in top_level_audio {
        let audio_path = path.join(audio_file);
        if audio_path.exists() {
            audio_candidates.push(audio_path);
        }
    }
    if audio_candidates.is_empty() {
        collect_audio_files(&content_path, &mut audio_candidates);
        audio_candidates.sort();
    }

    for audio_path in audio_candidates {
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
                if audio_info.is_some() {
                    break;
                }
            }
            Err(e) => {
                warn!("Failed to probe audio file {:?}: {}", audio_path, e);
            }
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
