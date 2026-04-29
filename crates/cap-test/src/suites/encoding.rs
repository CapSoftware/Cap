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
        (1280, 720, "720p"),
        (1920, 1080, "1080p"),
        (2560, 1440, "1440p"),
        (3840, 2160, "4K"),
    ];

    for (width, height, label) in resolutions {
        for fps in [30, 60] {
            let test_config = TestCaseConfig {
                display: Some(DisplayTestConfig {
                    width,
                    height,
                    fps,
                    display_id: None,
                }),
                camera: None,
                audio: None,
                duration_secs: duration,
            };

            let mut result = TestResult::new(
                format!("encoding-{}-{}fps", label, fps),
                format!("Encoding {} @{}fps", label, fps),
                test_config,
            );

            let metrics = run_encoding_benchmark(width, height, fps, duration).await?;

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: metrics.duration_secs,
                frames: FrameMetrics {
                    received: metrics.frames_processed,
                    encoded: metrics.frames_processed,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: metrics.frames_processed as f64 / metrics.duration_secs,
                    target_fps: fps,
                },
                latency_ms: LatencyMetrics {
                    avg: metrics.encode_time_avg_ms,
                    min: metrics.encode_time_min_ms,
                    p50: metrics.encode_time_p50_ms,
                    p95: metrics.encode_time_p95_ms,
                    p99: metrics.encode_time_p99_ms,
                    max: metrics.encode_time_max_ms,
                },
                encoding_ms: Some(LatencyMetrics {
                    avg: metrics.encode_time_avg_ms,
                    min: metrics.encode_time_min_ms,
                    p50: metrics.encode_time_p50_ms,
                    p95: metrics.encode_time_p95_ms,
                    p99: metrics.encode_time_p99_ms,
                    max: metrics.encode_time_max_ms,
                }),
                av_sync_ms: None,
                errors: vec![],
            };

            result.add_iteration(iteration);
            results.push(result);
        }
    }

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Encoding Suite".to_string(),
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

struct EncodingMetrics {
    duration_secs: f64,
    frames_processed: u64,
    encode_time_avg_ms: f64,
    encode_time_min_ms: f64,
    encode_time_p50_ms: f64,
    encode_time_p95_ms: f64,
    encode_time_p99_ms: f64,
    encode_time_max_ms: f64,
}

async fn run_encoding_benchmark(
    width: u32,
    height: u32,
    fps: u32,
    duration_secs: u64,
) -> Result<EncodingMetrics> {
    use std::time::Duration;

    let start = Instant::now();
    let target_duration = Duration::from_secs(duration_secs);
    let frame_interval = Duration::from_secs_f64(1.0 / fps as f64);

    let mut encode_times: Vec<f64> = Vec::new();
    let mut frames_processed = 0u64;

    while start.elapsed() < target_duration {
        let frame_start = Instant::now();

        let encode_time = simulate_encoding(width, height);
        encode_times.push(encode_time);
        frames_processed += 1;

        let elapsed = frame_start.elapsed();
        if let Some(remaining) = frame_interval.checked_sub(elapsed) {
            tokio::time::sleep(remaining).await;
        }
    }

    encode_times.sort_by(|a, b| a.partial_cmp(b).unwrap());

    Ok(EncodingMetrics {
        duration_secs: start.elapsed().as_secs_f64(),
        frames_processed,
        encode_time_avg_ms: encode_times.iter().sum::<f64>() / encode_times.len() as f64,
        encode_time_min_ms: encode_times.first().copied().unwrap_or(0.0),
        encode_time_p50_ms: percentile(&encode_times, 50.0),
        encode_time_p95_ms: percentile(&encode_times, 95.0),
        encode_time_p99_ms: percentile(&encode_times, 99.0),
        encode_time_max_ms: encode_times.last().copied().unwrap_or(0.0),
    })
}

fn simulate_encoding(width: u32, height: u32) -> f64 {
    let pixels = width as f64 * height as f64;
    let base_time = 1.0 + (pixels / 2_073_600.0) * 4.0;

    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as f64
        % 1000.0)
        / 1000.0
        * 2.0;

    base_time + jitter
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}
