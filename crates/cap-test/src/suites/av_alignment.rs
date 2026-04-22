use anyhow::Result;
use chrono::Utc;
use std::path::Path;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

use crate::discovery::DiscoveredHardware;
use crate::results::{
    AudioTestConfig, DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta,
    ResultsSummary, SyncMetrics, TestCaseConfig, TestResult, TestResults,
};

use super::ffprobe_ext::{AvAlignmentReading, probe_stream_stats};
use super::recording_helpers::{StudioRecordingOptions, record_studio_for_duration};

const TARGET_OFFSET_MS: f64 = 21.5;

pub async fn run_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let primary_display = hardware
        .displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| hardware.displays.first());

    let first_audio = hardware.audio_inputs.first();

    let Some(display) = primary_display else {
        warn!("No display available - skipping AV alignment suite");
        return Ok(empty_results(hardware, start.elapsed()));
    };

    let target_fps = 30u32;
    let duration_secs = duration.max(5);

    let test_config = TestCaseConfig {
        display: Some(DisplayTestConfig {
            width: display.physical_width,
            height: display.physical_height,
            fps: target_fps,
            display_id: Some(display.id.clone()),
        }),
        camera: None,
        audio: first_audio.map(|a| AudioTestConfig {
            sample_rate: *a.sample_rates.first().unwrap_or(&48000),
            channels: a.channels.min(2),
            device_id: Some(a.id.clone()),
            include_system_audio: false,
        }),
        duration_secs,
    };

    let mut result = TestResult::new(
        format!("av-alignment-{}-{}fps", display.id, target_fps),
        format!(
            "AV first-frame alignment {} @{}fps",
            display.resolution_label(),
            target_fps
        ),
        test_config,
    );

    match run_single_measurement(display.id.clone(), target_fps, duration_secs).await {
        Ok(reading) => {
            let offset_abs_ms = reading.offset_ms.abs();
            let sync = SyncMetrics {
                offset_ms: reading.offset_ms,
                drift_ms: reading.offset_ms,
                max_drift_ms: offset_abs_ms,
            };

            if offset_abs_ms > TARGET_OFFSET_MS {
                result.set_failed(&format!(
                    "First-frame AV offset {:.2}ms exceeds {:.2}ms target (video first={:.4}s audio first={:.4}s)",
                    reading.offset_ms,
                    TARGET_OFFSET_MS,
                    reading.video_first_secs,
                    reading.audio_first_secs,
                ));
            } else {
                info!(
                    "AV alignment pass: offset={:.2}ms (|Δ|={:.2}ms <= {:.2}ms target)",
                    reading.offset_ms, offset_abs_ms, TARGET_OFFSET_MS,
                );
            }

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: duration_secs as f64,
                frames: FrameMetrics {
                    received: 0,
                    encoded: 0,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: 0.0,
                    target_fps,
                },
                latency_ms: LatencyMetrics {
                    avg: 0.0,
                    min: 0.0,
                    p50: 0.0,
                    p95: 0.0,
                    p99: 0.0,
                    max: 0.0,
                },
                encoding_ms: None,
                av_sync_ms: Some(sync),
                errors: vec![],
            };
            result.add_iteration(iteration);
        }
        Err(e) => {
            error!("AV alignment measurement failed: {e}");
            result.set_error(&e.to_string());
        }
    }

    results.push(result);

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "AV Alignment Suite".to_string(),
            config_path: None,
            platform: hardware.system_info.platform.clone(),
            system: hardware.system_info.clone(),
            cap_version: None,
        },
        hardware: Some(hardware.clone()),
        summary: ResultsSummary::from_results(&results, start.elapsed()),
        results,
    })
}

async fn run_single_measurement(
    display_id: String,
    target_fps: u32,
    duration_secs: u64,
) -> Result<AvAlignmentReading> {
    let opts = StudioRecordingOptions {
        display_id: Some(display_id),
        target_fps,
        duration: Duration::from_secs(duration_secs),
        include_mic: true,
        include_system_audio: true,
        fragmented: true,
    };

    let artifacts = record_studio_for_duration(opts).await?;

    let candidate = artifacts
        .display_outputs
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("no display.mp4 produced after recording"))?;

    let stats = probe_stream_stats(&candidate)?;
    info!(
        "Probed display output {}: video_frames={:?} video_duration={:?} audio_samples={:?} audio_duration={:?}",
        candidate.display(),
        stats.video_frame_count,
        stats.video_duration_secs,
        stats.audio_sample_count,
        stats.audio_duration_secs,
    );

    let reading = measure_cross_track_av_alignment(&artifacts.project_path)?;
    drop(artifacts);
    Ok(reading)
}

fn measure_cross_track_av_alignment(project_path: &Path) -> Result<AvAlignmentReading> {
    let meta_path = project_path.join("recording-meta.json");
    let raw = std::fs::read_to_string(&meta_path)
        .with_context(|| format!("reading {}", meta_path.display()))?;
    let meta: serde_json::Value =
        serde_json::from_str(&raw).context("parsing recording-meta.json")?;

    info!(
        "recording-meta.json for diagnostic inspection:\n{}",
        serde_json::to_string_pretty(&meta).unwrap_or_else(|_| raw.clone())
    );

    let segments = meta
        .get("segments")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow::anyhow!("recording-meta.json missing segments array"))?;

    let segment = segments
        .first()
        .ok_or_else(|| anyhow::anyhow!("segments is empty"))?;

    let display_start = read_start_time(segment, "display").unwrap_or(0.0);
    let system_audio_start = read_start_time(segment, "system_audio");
    let mic_start = read_start_time(segment, "mic");

    let audio_start = system_audio_start.or(mic_start).ok_or_else(|| {
        anyhow::anyhow!(
            "neither system_audio nor mic start_time present — cannot measure AV alignment"
        )
    })?;

    let audio_source = if system_audio_start.is_some() {
        "system_audio"
    } else {
        "mic"
    };

    info!(
        "Track start_times (secs since recording start): display={display_start:.6} {audio_source}={audio_start:.6}"
    );

    Ok(AvAlignmentReading {
        video_first_secs: display_start,
        audio_first_secs: audio_start,
        offset_ms: (audio_start - display_start) * 1000.0,
    })
}

fn read_start_time(segment: &serde_json::Value, key: &str) -> Option<f64> {
    segment.get(key)?.get("start_time")?.as_f64()
}

use anyhow::Context;

fn empty_results(hardware: &DiscoveredHardware, elapsed: Duration) -> TestResults {
    TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "AV Alignment Suite".to_string(),
            config_path: None,
            platform: hardware.system_info.platform.clone(),
            system: hardware.system_info.clone(),
            cap_version: None,
        },
        hardware: Some(hardware.clone()),
        results: Vec::new(),
        summary: ResultsSummary::from_results(&[], elapsed),
    }
}
