use anyhow::Result;
use chrono::Utc;
use std::time::Instant;

use crate::discovery::DiscoveredHardware;
use crate::results::{
    DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta, ResultsSummary,
    TestCaseConfig, TestResult, TestResults,
};

pub async fn run_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let resolutions = [
        (1920, 1080, "1080p"),
        (2560, 1440, "1440p"),
        (3840, 2160, "4K"),
    ];

    for (width, height, label) in resolutions {
        let test_config = TestCaseConfig {
            display: Some(DisplayTestConfig {
                width,
                height,
                fps: 30,
                display_id: None,
            }),
            camera: None,
            audio: None,
            duration_secs: duration,
        };

        let mut result = TestResult::new(
            format!("playback-{}", label),
            format!("Playback {}", label),
            test_config,
        );

        let metrics = run_playback_test(width, height, duration).await?;

        let iteration = IterationResult {
            iteration: 0,
            duration_secs: metrics.duration_secs,
            frames: FrameMetrics {
                received: metrics.frames_decoded,
                encoded: metrics.frames_decoded,
                dropped: metrics.frames_dropped,
                drop_rate_percent: if metrics.frames_decoded > 0 {
                    metrics.frames_dropped as f64 / metrics.frames_decoded as f64 * 100.0
                } else {
                    0.0
                },
                effective_fps: metrics.effective_fps,
                target_fps: 30,
            },
            latency_ms: LatencyMetrics {
                avg: metrics.decode_time_avg_ms,
                min: metrics.decode_time_min_ms,
                p50: metrics.decode_time_p50_ms,
                p95: metrics.decode_time_p95_ms,
                p99: metrics.decode_time_p99_ms,
                max: metrics.decode_time_max_ms,
            },
            encoding_ms: None,
            av_sync_ms: None,
            errors: vec![],
        };

        result.add_iteration(iteration);
        results.push(result);
    }

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Playback Suite".to_string(),
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

struct PlaybackMetrics {
    duration_secs: f64,
    frames_decoded: u64,
    frames_dropped: u64,
    effective_fps: f64,
    decode_time_avg_ms: f64,
    decode_time_min_ms: f64,
    decode_time_p50_ms: f64,
    decode_time_p95_ms: f64,
    decode_time_p99_ms: f64,
    decode_time_max_ms: f64,
}

async fn run_playback_test(width: u32, height: u32, duration_secs: u64) -> Result<PlaybackMetrics> {
    use std::time::Duration;

    let start = Instant::now();
    let target_duration = Duration::from_secs(duration_secs);
    let frame_interval = Duration::from_secs_f64(1.0 / 30.0);

    let mut decode_times: Vec<f64> = Vec::new();
    let mut frames_decoded = 0u64;
    let mut frames_dropped = 0u64;

    while start.elapsed() < target_duration {
        let frame_start = Instant::now();

        let decode_time = simulate_decoding(width, height);
        decode_times.push(decode_time);

        if decode_time < frame_interval.as_secs_f64() * 1000.0 {
            frames_decoded += 1;
        } else {
            frames_dropped += 1;
        }

        let elapsed = frame_start.elapsed();
        if let Some(remaining) = frame_interval.checked_sub(elapsed) {
            tokio::time::sleep(remaining).await;
        }
    }

    let total_duration = start.elapsed().as_secs_f64();
    decode_times.sort_by(|a, b| a.partial_cmp(b).unwrap());

    Ok(PlaybackMetrics {
        duration_secs: total_duration,
        frames_decoded,
        frames_dropped,
        effective_fps: frames_decoded as f64 / total_duration,
        decode_time_avg_ms: decode_times.iter().sum::<f64>() / decode_times.len() as f64,
        decode_time_min_ms: decode_times.first().copied().unwrap_or(0.0),
        decode_time_p50_ms: percentile(&decode_times, 50.0),
        decode_time_p95_ms: percentile(&decode_times, 95.0),
        decode_time_p99_ms: percentile(&decode_times, 99.0),
        decode_time_max_ms: decode_times.last().copied().unwrap_or(0.0),
    })
}

fn simulate_decoding(width: u32, height: u32) -> f64 {
    let pixels = width as f64 * height as f64;
    let base_time = 0.5 + (pixels / 2_073_600.0) * 3.0;

    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as f64
        % 1000.0)
        / 1000.0
        * 1.5;

    base_time + jitter
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
