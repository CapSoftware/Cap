use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Deserialize)]
struct StreamsEnvelope {
    streams: Vec<StreamEntry>,
    format: Option<FormatEntry>,
}

#[derive(Debug, Deserialize)]
struct StreamEntry {
    codec_type: String,
    nb_frames: Option<String>,
    nb_read_packets: Option<String>,
    sample_rate: Option<String>,
    duration: Option<String>,
    r_frame_rate: Option<String>,
    avg_frame_rate: Option<String>,
    channels: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct FormatEntry {
    duration: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AvAlignmentReading {
    pub video_first_secs: f64,
    pub audio_first_secs: f64,
    pub offset_ms: f64,
}

#[derive(Debug, Clone, Default)]
pub struct StreamStats {
    pub video_frame_count: Option<u64>,
    pub video_duration_secs: Option<f64>,
    pub video_fps: Option<f64>,
    pub audio_sample_count: Option<u64>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channels: Option<u32>,
    pub audio_duration_secs: Option<f64>,
    pub container_duration_secs: Option<f64>,
}

fn parse_frame_rate(rate: &str) -> Option<f64> {
    if let Some((num, den)) = rate.split_once('/') {
        let num: f64 = num.parse().ok()?;
        let den: f64 = den.parse().ok()?;
        if den > 0.0 {
            return Some(num / den);
        }
    }
    rate.parse().ok()
}

pub fn probe_stream_stats(path: &Path) -> Result<StreamStats> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            "-count_packets",
        ])
        .arg(path)
        .output()
        .context("Failed to run ffprobe for stream stats")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffprobe stream stats failed: {stderr}");
    }

    let json = String::from_utf8_lossy(&output.stdout);
    let parsed: StreamsEnvelope =
        serde_json::from_str(&json).context("Failed to parse ffprobe streams envelope")?;

    let mut stats = StreamStats {
        container_duration_secs: parsed
            .format
            .as_ref()
            .and_then(|f| f.duration.as_deref())
            .and_then(|d| d.parse::<f64>().ok()),
        ..Default::default()
    };

    for stream in parsed.streams {
        match stream.codec_type.as_str() {
            "video" => {
                stats.video_frame_count = stream
                    .nb_frames
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| {
                        stream
                            .nb_read_packets
                            .as_deref()
                            .and_then(|s| s.parse::<u64>().ok())
                    });
                stats.video_duration_secs = stream
                    .duration
                    .as_deref()
                    .and_then(|d| d.parse::<f64>().ok())
                    .or(stats.container_duration_secs);
                stats.video_fps = stream
                    .r_frame_rate
                    .as_deref()
                    .and_then(parse_frame_rate)
                    .or_else(|| stream.avg_frame_rate.as_deref().and_then(parse_frame_rate))
                    .filter(|f| *f > 0.0 && *f < 1000.0);
            }
            "audio" => {
                stats.audio_sample_rate = stream
                    .sample_rate
                    .as_deref()
                    .and_then(|s| s.parse::<u32>().ok());
                stats.audio_channels = stream.channels;
                stats.audio_duration_secs = stream
                    .duration
                    .as_deref()
                    .and_then(|d| d.parse::<f64>().ok())
                    .or(stats.container_duration_secs);
                if let (Some(rate), Some(dur)) =
                    (stats.audio_sample_rate, stats.audio_duration_secs)
                {
                    stats.audio_sample_count = Some((dur * rate as f64).round() as u64);
                }
            }
            _ => {}
        }
    }

    Ok(stats)
}

pub fn verify_playable(path: &Path) -> Result<()> {
    let output = Command::new("ffprobe")
        .args(["-v", "error", "-show_streams", "-show_format"])
        .arg(path)
        .output()
        .context("Failed to run ffprobe for playability check")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffprobe playability check failed: {stderr}");
    }

    Ok(())
}
