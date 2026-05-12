use anyhow::Result;
use chrono::Utc;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

use crate::discovery::DiscoveredHardware;
use crate::results::{
    AudioTestConfig, DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta,
    ResultsSummary, SyncMetrics, TestCaseConfig, TestResult, TestResults,
};

use super::ffprobe_ext::{StreamStats, probe_stream_stats};
use super::recording_helpers::{StudioRecordingOptions, record_studio_for_duration};

pub const TARGET_DRIFT_MS_PER_MINUTE: f64 = 50.0;

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
        warn!("No display available - skipping drift suite");
        return Ok(empty_results(hardware, start.elapsed()));
    };

    let target_fps = 30u32;
    let duration_secs = duration.max(60);

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
        format!("drift-{}-{}fps-{}s", display.id, target_fps, duration_secs),
        format!(
            "A/V drift over {}s {} @{}fps",
            duration_secs,
            display.resolution_label(),
            target_fps
        ),
        test_config,
    );

    match run_drift_measurement(display.id.clone(), target_fps, duration_secs).await {
        Ok(reading) => {
            let minutes = duration_secs as f64 / 60.0;
            let drift_per_minute = if minutes > 0.0 {
                reading.drift_ms / minutes
            } else {
                reading.drift_ms
            };

            info!(
                "Drift reading: video_duration={:.3}s audio_duration={:.3}s drift={:.2}ms ({:.2}ms/min)",
                reading.video_duration_secs,
                reading.audio_duration_secs,
                reading.drift_ms,
                drift_per_minute,
            );

            if drift_per_minute.abs() > TARGET_DRIFT_MS_PER_MINUTE {
                result.set_failed(&format!(
                    "Drift {:.2}ms over {:.2}min ({:.2}ms/min) exceeds {:.2}ms/min target",
                    reading.drift_ms, minutes, drift_per_minute, TARGET_DRIFT_MS_PER_MINUTE,
                ));
            }

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: duration_secs as f64,
                frames: FrameMetrics {
                    received: reading.video_frame_count.unwrap_or(0),
                    encoded: reading.video_frame_count.unwrap_or(0),
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: reading
                        .video_frame_count
                        .map(|f| f as f64 / duration_secs.max(1) as f64)
                        .unwrap_or(0.0),
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
                av_sync_ms: Some(SyncMetrics {
                    offset_ms: reading.drift_ms,
                    drift_ms: drift_per_minute,
                    max_drift_ms: reading.drift_ms.abs(),
                }),
                errors: vec![],
            };
            result.add_iteration(iteration);
        }
        Err(e) => {
            error!("Drift measurement failed: {e}");
            result.set_error(&e.to_string());
        }
    }

    results.push(result);

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Drift Suite".to_string(),
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

struct DriftReading {
    video_duration_secs: f64,
    audio_duration_secs: f64,
    drift_ms: f64,
    video_frame_count: Option<u64>,
}

async fn run_drift_measurement(
    display_id: String,
    target_fps: u32,
    duration_secs: u64,
) -> Result<DriftReading> {
    let opts = StudioRecordingOptions {
        display_id: Some(display_id),
        target_fps,
        duration: Duration::from_secs(duration_secs),
        include_mic: true,
        include_system_audio: false,
        fragmented: true,
    };

    let artifacts = record_studio_for_duration(opts).await?;

    let mut video_stats_total = StreamStats::default();
    let mut video_segments = 0u32;
    for path in &artifacts.display_outputs {
        match probe_stream_stats(path) {
            Ok(stats) => {
                video_stats_total.video_frame_count = Some(
                    video_stats_total.video_frame_count.unwrap_or(0)
                        + stats.video_frame_count.unwrap_or(0),
                );
                video_stats_total.video_duration_secs = Some(
                    video_stats_total.video_duration_secs.unwrap_or(0.0)
                        + stats.video_duration_secs.unwrap_or(0.0),
                );
                video_stats_total.video_fps = video_stats_total.video_fps.or(stats.video_fps);
                video_segments += 1;
            }
            Err(err) => warn!(
                "Failed to probe display segment {}: {}",
                path.display(),
                err
            ),
        }
    }

    if video_segments == 0 {
        anyhow::bail!("no playable display outputs produced for drift measurement");
    }

    let mut audio_duration = 0.0f64;
    let mut audio_samples_total = 0u64;
    let mut audio_sample_rate = None;
    for audio_path in find_audio_track_files(&artifacts.project_path) {
        match probe_stream_stats(&audio_path) {
            Ok(stats) => {
                audio_duration += stats.audio_duration_secs.unwrap_or(0.0);
                audio_samples_total += stats.audio_sample_count.unwrap_or(0);
                audio_sample_rate = audio_sample_rate.or(stats.audio_sample_rate);
            }
            Err(err) => warn!(
                "Failed to probe audio file {}: {}",
                audio_path.display(),
                err
            ),
        }
    }

    if audio_duration <= 0.0 {
        warn!(
            "No audio durations measured across {} display segment(s) — drift will compare video-only",
            video_segments
        );
    }

    let video_duration = video_stats_total.video_duration_secs.unwrap_or(0.0);
    let drift_ms = (video_duration - audio_duration) * 1000.0;

    info!(
        "Drift inputs: video_segments={video_segments} audio_samples={audio_samples_total} audio_rate={:?}",
        audio_sample_rate
    );

    Ok(DriftReading {
        video_duration_secs: video_duration,
        audio_duration_secs: audio_duration,
        drift_ms,
        video_frame_count: video_stats_total.video_frame_count,
    })
}

fn find_audio_track_files(project_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    use std::fs;
    let mut tracks = Vec::new();

    let segments_root = project_path.join("content").join("segments");
    let Ok(segments) = fs::read_dir(&segments_root) else {
        return tracks;
    };

    for segment_entry in segments.flatten() {
        let segment_dir = segment_entry.path();
        if !segment_dir.is_dir() {
            continue;
        }
        for candidate in [
            "audio-input.ogg",
            "audio-input.m4a",
            "system_audio.ogg",
            "system_audio.m4a",
        ] {
            let path = segment_dir.join(candidate);
            if path.exists() {
                tracks.push(path);
            }
        }
    }

    tracks
}

fn empty_results(hardware: &DiscoveredHardware, elapsed: Duration) -> TestResults {
    TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Drift Suite".to_string(),
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
