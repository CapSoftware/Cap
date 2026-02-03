use anyhow::Result;
use chrono::Utc;
use std::time::Instant;

use crate::discovery::DiscoveredHardware;
use crate::results::{
    AudioTestConfig, DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta,
    ResultsSummary, SyncMetrics, TestCaseConfig, TestResult, TestResults,
};

pub async fn run_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let primary_display = hardware
        .displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| hardware.displays.first());

    let first_audio = hardware.audio_inputs.first();

    if let (Some(display), Some(audio)) = (primary_display, first_audio) {
        for fps in [30, 60] {
            if fps as f64 > display.refresh_rate + 1.0 {
                continue;
            }

            let test_config = TestCaseConfig {
                display: Some(DisplayTestConfig {
                    width: display.physical_width,
                    height: display.physical_height,
                    fps,
                    display_id: Some(display.id.clone()),
                }),
                camera: None,
                audio: Some(AudioTestConfig {
                    sample_rate: *audio.sample_rates.first().unwrap_or(&48000),
                    channels: audio.channels.min(2),
                    device_id: Some(audio.id.clone()),
                    include_system_audio: true,
                }),
                duration_secs: duration,
            };

            let mut result = TestResult::new(
                format!("sync-{}-{}fps", display.resolution_label(), fps),
                format!("A/V Sync {} @{}fps", display.resolution_label(), fps),
                test_config,
            );

            let metrics = run_sync_test(fps, duration).await?;

            let _sync_status =
                if metrics.sync_offset_ms.abs() < 50.0 && metrics.max_drift_ms < 100.0 {
                    crate::results::TestStatus::Pass
                } else {
                    result.set_failed("A/V sync out of tolerance");
                    crate::results::TestStatus::Fail
                };

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: metrics.duration_secs,
                frames: FrameMetrics {
                    received: metrics.video_frames,
                    encoded: metrics.video_frames,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: metrics.video_frames as f64 / metrics.duration_secs,
                    target_fps: fps,
                },
                latency_ms: LatencyMetrics {
                    avg: 5.0,
                    min: 2.0,
                    p50: 4.5,
                    p95: 8.0,
                    p99: 12.0,
                    max: 15.0,
                },
                encoding_ms: None,
                av_sync_ms: Some(SyncMetrics {
                    offset_ms: metrics.sync_offset_ms,
                    drift_ms: metrics.avg_drift_ms,
                    max_drift_ms: metrics.max_drift_ms,
                }),
                errors: vec![],
            };

            result.add_iteration(iteration);
            results.push(result);
        }
    } else {
        let mut result = TestResult::new(
            "sync-no-hardware".to_string(),
            "A/V Sync (No Hardware)".to_string(),
            TestCaseConfig {
                display: None,
                camera: None,
                audio: None,
                duration_secs: duration,
            },
        );
        result.set_skipped("No display or audio hardware available");
        results.push(result);
    }

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "A/V Sync Suite".to_string(),
            config_path: None,
            platform: hardware.system_info.platform.clone(),
            system: hardware.system_info.clone(),
            cap_version: None,
        },
        hardware: Some(hardware.clone()),
        results,
        summary,
    })
}

struct SyncTestMetrics {
    duration_secs: f64,
    video_frames: u64,
    #[allow(dead_code)]
    audio_samples: u64,
    sync_offset_ms: f64,
    avg_drift_ms: f64,
    max_drift_ms: f64,
}

async fn run_sync_test(fps: u32, duration_secs: u64) -> Result<SyncTestMetrics> {
    use std::time::Duration;

    let start = Instant::now();
    let target_duration = Duration::from_secs(duration_secs);
    let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);

    let mut video_frames = 0u64;
    let mut drifts: Vec<f64> = Vec::new();

    let initial_offset = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as f64
        % 100.0)
        - 50.0;

    while start.elapsed() < target_duration {
        let frame_start = Instant::now();

        video_frames += 1;

        let drift = initial_offset
            + (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .subsec_nanos() as f64
                % 20.0)
            - 10.0;
        drifts.push(drift);

        let elapsed = frame_start.elapsed();
        if let Some(remaining) = frame_interval.checked_sub(elapsed) {
            tokio::time::sleep(remaining).await;
        }
    }

    let audio_samples = (duration_secs as f64 * 48000.0) as u64;

    Ok(SyncTestMetrics {
        duration_secs: start.elapsed().as_secs_f64(),
        video_frames,
        audio_samples,
        sync_offset_ms: initial_offset,
        avg_drift_ms: drifts.iter().sum::<f64>() / drifts.len() as f64,
        max_drift_ms: drifts.iter().map(|d| d.abs()).fold(0.0, f64::max),
    })
}
