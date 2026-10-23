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

#[derive(Debug, Clone)]
pub struct FrameGapReading {
    pub frame_count: usize,
    pub median_interval_secs: f64,
    pub max_gap_secs: f64,
    pub max_gap_at_secs: f64,
    /// Largest gap whose start falls in the warmup-boundary window (~2.0s).
    /// The wall-clock-rebase bug deterministically injects its step here, so this
    /// is the most reliable fingerprint even when its magnitude is small.
    pub boundary_gap_secs: f64,
    pub boundary_gap_at_secs: f64,
}

/// Content-time window around the encoder's 2.0s warmup boundary.
pub const WARMUP_BOUNDARY_SECS: f64 = 2.0;
pub const WARMUP_BOUNDARY_WINDOW_SECS: f64 = 0.1;

/// Reads every video frame's presentation timestamp and reports the largest
/// interval between consecutive frames (the "gap"), along with the median
/// interval for reference. A healthy continuous-capture stream (e.g. a camera)
/// has all intervals ≈ the median; a timestamp-injection bug shows up as a
/// single mid-stream gap many times the median (the warmup-boundary hole).
pub fn probe_frame_gaps(path: &Path) -> Result<FrameGapReading> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=pts_time",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .context("Failed to run ffprobe for frame gaps")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("ffprobe frame gaps failed: {stderr}");
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut pts: Vec<f64> = stdout
        .lines()
        .filter_map(|l| l.trim().trim_end_matches(',').parse::<f64>().ok())
        .collect();
    pts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    if pts.len() < 3 {
        anyhow::bail!(
            "not enough video frames to measure gaps ({} found)",
            pts.len()
        );
    }

    let mut intervals: Vec<f64> = Vec::with_capacity(pts.len() - 1);
    let mut max_gap_secs = 0.0_f64;
    let mut max_gap_at_secs = 0.0_f64;
    let mut boundary_gap_secs = 0.0_f64;
    let mut boundary_gap_at_secs = 0.0_f64;
    for window in pts.windows(2) {
        let gap = window[1] - window[0];
        let at = window[0];
        intervals.push(gap);
        if gap > max_gap_secs {
            max_gap_secs = gap;
            max_gap_at_secs = at;
        }
        if (at - WARMUP_BOUNDARY_SECS).abs() <= WARMUP_BOUNDARY_WINDOW_SECS
            && gap > boundary_gap_secs
        {
            boundary_gap_secs = gap;
            boundary_gap_at_secs = at;
        }
    }

    let mut sorted = intervals.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median_interval_secs = sorted[sorted.len() / 2];

    Ok(FrameGapReading {
        frame_count: pts.len(),
        median_interval_secs,
        max_gap_secs,
        max_gap_at_secs,
        boundary_gap_secs,
        boundary_gap_at_secs,
    })
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
