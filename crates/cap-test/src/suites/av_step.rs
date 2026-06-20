use anyhow::{Context, Result};
use chrono::Utc;
use std::time::{Duration, Instant};
use tracing::{error, info, warn};

use crate::discovery::DiscoveredHardware;
use crate::results::{
    AudioTestConfig, DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta,
    ResultsSummary, SyncMetrics, TestCaseConfig, TestResult, TestResults,
};

use super::ffprobe_ext::{FrameGapReading, probe_frame_gaps};
use super::recording_helpers::{
    StudioRecordingOptions, materialize_camera_outputs, materialize_display_outputs,
    record_instant_camera_for_duration, record_studio_for_duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordMode {
    Studio,
    Instant,
}

impl RecordMode {
    fn label(&self) -> &'static str {
        match self {
            RecordMode::Studio => "studio",
            RecordMode::Instant => "instant",
        }
    }
}

// A continuous-capture stream (camera, or screen while it is changing) advances
// one frame per ~median interval. The historical wall-clock-rebase A/V bug
// injected a single mid-stream "hole" the size of the capture startup latency
// (hundreds of ms) at the ~2s warmup boundary, which is what pushed video behind
// audio for the rest of the recording. A frame whose gap to the next exceeds this
// many medians is that fingerprint, not normal jitter or an isolated dropped
// frame.
const GAP_RATIO_THRESHOLD: f64 = 4.0;
// Absolute floor so a very tight median doesn't flag sub-frame jitter.
const GAP_ABS_FLOOR_SECS: f64 = 0.12;
// A gap *at the 2.0s warmup boundary* is the bug's deterministic fingerprint, so
// a much lower ratio is enough there. On fast hardware the injected step can be
// as small as ~1.8x the median (e.g. camera-only instant mode on an M4 Max),
// while a clean recording's boundary frame sits at ~1.0x.
const BOUNDARY_RATIO_THRESHOLD: f64 = 1.5;

pub async fn run_suite(
    hardware: &DiscoveredHardware,
    duration: u64,
    mode: RecordMode,
) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let primary_display = hardware
        .displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| hardware.displays.first());

    let first_audio = hardware.audio_inputs.first();
    let has_camera = !hardware.cameras.is_empty();

    let Some(display) = primary_display else {
        warn!("No display available - skipping AV step suite");
        return Ok(empty_results(hardware, start.elapsed()));
    };

    // Instant-mode probe records camera-only, so a camera is mandatory there.
    if mode == RecordMode::Instant && !has_camera {
        warn!("No camera available - skipping instant-mode AV step probe");
        let mut skipped = TestResult::new(
            "av-step-instant-no-camera".to_string(),
            "A/V timeline step probe (instant, no camera)".to_string(),
            TestCaseConfig {
                display: None,
                camera: None,
                audio: None,
                duration_secs: duration,
            },
        );
        skipped.set_skipped("No camera device available for instant-mode probe");
        results.push(skipped);
        return Ok(TestResults {
            meta: ResultsMeta {
                timestamp: Utc::now(),
                config_name: "AV Step Suite".to_string(),
                config_path: None,
                platform: hardware.system_info.platform.clone(),
                system: hardware.system_info.clone(),
                cap_version: None,
            },
            hardware: Some(hardware.clone()),
            summary: ResultsSummary::from_results(&results, start.elapsed()),
            results,
        });
    }

    if mode == RecordMode::Studio && !has_camera {
        warn!("No camera available - the camera stream is the most reliable signal for this check");
    }

    let target_fps = 30u32;
    // The warmup boundary is at ~2s, so the recording must run well past it.
    let duration_secs = duration.max(8);

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
        format!("av-step-{}-{}-{}fps", mode.label(), display.id, target_fps),
        format!(
            "A/V timeline step probe ({} mode) {} @{}fps (camera={})",
            mode.label(),
            display.resolution_label(),
            target_fps,
            has_camera
        ),
        test_config,
    );

    match run_measurement(
        display.id.clone(),
        target_fps,
        duration_secs,
        has_camera,
        mode,
    )
    .await
    {
        Ok(reading) => {
            let median = reading.median_interval_secs.max(1e-9);
            let gap_ratio = reading.max_gap_secs / median;
            let boundary_ratio = reading.boundary_gap_secs / median;
            let max_gap_ms = reading.max_gap_secs * 1000.0;
            let boundary_gap_ms = reading.boundary_gap_secs * 1000.0;
            let median_ms = reading.median_interval_secs * 1000.0;
            let general_threshold_secs =
                (reading.median_interval_secs * GAP_RATIO_THRESHOLD).max(GAP_ABS_FLOOR_SECS);

            // A large gap anywhere, or any clear step exactly at the warmup
            // boundary, is the bug.
            let general_fail = reading.max_gap_secs > general_threshold_secs;
            let boundary_fail =
                reading.boundary_gap_secs > 0.0 && boundary_ratio >= BOUNDARY_RATIO_THRESHOLD;

            info!(
                "AV-STEP probe [{}]: frames={} median_interval={:.2}ms max_gap={:.2}ms ({:.1}x) at {:.3}s | boundary_gap(@2.0s)={:.2}ms ({:.1}x) at {:.3}s",
                reading.stream_label,
                reading.frame_count,
                median_ms,
                max_gap_ms,
                gap_ratio,
                reading.max_gap_at_secs,
                boundary_gap_ms,
                boundary_ratio,
                reading.boundary_gap_at_secs,
            );

            if boundary_fail {
                result.set_failed(&format!(
                    "Warmup-boundary timeline step in {}: {:.1}ms gap ({:.1}x median {:.2}ms) at {:.3}s — the wall-clock-rebase fingerprint; audio runs ahead of video after this point",
                    reading.stream_label,
                    boundary_gap_ms,
                    boundary_ratio,
                    median_ms,
                    reading.boundary_gap_at_secs,
                ));
            } else if general_fail {
                result.set_failed(&format!(
                    "Mid-stream timeline step in {}: {:.1}ms gap ({:.1}x median {:.2}ms) at {:.3}s exceeds {:.1}ms threshold",
                    reading.stream_label,
                    max_gap_ms,
                    gap_ratio,
                    median_ms,
                    reading.max_gap_at_secs,
                    general_threshold_secs * 1000.0,
                ));
            } else {
                info!(
                    "AV step probe PASS: max gap {:.1}ms ({:.1}x), boundary gap {:.1}ms ({:.1}x) — no warmup-boundary step",
                    max_gap_ms, gap_ratio, boundary_gap_ms, boundary_ratio,
                );
            }

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: duration_secs as f64,
                frames: FrameMetrics {
                    received: reading.frame_count as u64,
                    encoded: reading.frame_count as u64,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: reading.frame_count as f64 / duration_secs.max(1) as f64,
                    target_fps,
                },
                latency_ms: LatencyMetrics {
                    avg: median_ms,
                    min: 0.0,
                    p50: median_ms,
                    p95: 0.0,
                    p99: 0.0,
                    max: max_gap_ms,
                },
                encoding_ms: None,
                av_sync_ms: Some(SyncMetrics {
                    offset_ms: max_gap_ms,
                    drift_ms: gap_ratio,
                    max_drift_ms: max_gap_ms,
                }),
                errors: vec![],
            };
            result.add_iteration(iteration);
        }
        Err(e) => {
            error!("AV step measurement failed: {e}");
            result.set_error(&e.to_string());
        }
    }

    results.push(result);

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "AV Step Suite".to_string(),
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

struct StepReading {
    stream_label: String,
    frame_count: usize,
    median_interval_secs: f64,
    max_gap_secs: f64,
    max_gap_at_secs: f64,
    boundary_gap_secs: f64,
    boundary_gap_at_secs: f64,
}

impl StepReading {
    fn from_gap(stream_label: String, gap: FrameGapReading) -> Self {
        Self {
            stream_label,
            frame_count: gap.frame_count,
            median_interval_secs: gap.median_interval_secs,
            max_gap_secs: gap.max_gap_secs,
            max_gap_at_secs: gap.max_gap_at_secs,
            boundary_gap_secs: gap.boundary_gap_secs,
            boundary_gap_at_secs: gap.boundary_gap_at_secs,
        }
    }
}

// When CAP_AV_STEP_KEEP=<dir> is set, copy the probed video out of the temp
// recording before it is cleaned up, so the raw frame timing can be inspected
// directly with ffprobe.
fn persist_if_requested(src: &std::path::Path, label: &str) {
    let Ok(dir) = std::env::var("CAP_AV_STEP_KEEP") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        warn!("CAP_AV_STEP_KEEP: failed to create {}: {e}", dir.display());
        return;
    }
    let safe: String = label
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();
    let dest = dir.join(format!("{safe}.mp4"));
    match std::fs::copy(src, &dest) {
        Ok(_) => info!("Kept recording for inspection: {}", dest.display()),
        Err(e) => warn!("CAP_AV_STEP_KEEP: copy of {} failed: {e}", src.display()),
    }
}

async fn run_measurement(
    display_id: String,
    target_fps: u32,
    duration_secs: u64,
    include_camera: bool,
    mode: RecordMode,
) -> Result<StepReading> {
    match mode {
        RecordMode::Studio => {
            let opts = StudioRecordingOptions {
                display_id: Some(display_id),
                target_fps,
                duration: Duration::from_secs(duration_secs),
                include_mic: true,
                include_camera,
                include_system_audio: false,
                fragmented: false,
            };

            let artifacts = record_studio_for_duration(opts).await?;

            // The camera stream is the authoritative signal: a camera never
            // legitimately stops delivering frames, so any large mid-stream gap
            // there is the bug.
            let camera_outputs = materialize_camera_outputs(&artifacts.project_path);
            if let Some(camera) = camera_outputs.first() {
                persist_if_requested(camera, "studio camera");
                let gap = probe_frame_gaps(camera)
                    .with_context(|| format!("probing camera frame gaps: {}", camera.display()))?;
                return Ok(StepReading::from_gap("studio camera".to_string(), gap));
            }

            // Fall back to the display stream when no camera was recorded.
            let display_outputs = materialize_display_outputs(&artifacts.project_path)?;
            let display = display_outputs.first().ok_or_else(|| {
                anyhow::anyhow!("no camera.mp4 or display.mp4 produced after recording")
            })?;
            persist_if_requested(display, "studio display");
            let gap = probe_frame_gaps(display)
                .with_context(|| format!("probing display frame gaps: {}", display.display()))?;
            Ok(StepReading::from_gap("studio display".to_string(), gap))
        }
        RecordMode::Instant => {
            let artifacts = record_instant_camera_for_duration(
                target_fps,
                Duration::from_secs(duration_secs),
                true,
            )
            .await?;

            persist_if_requested(&artifacts.output_path, "instant camera output");
            let gap = probe_frame_gaps(&artifacts.output_path).with_context(|| {
                format!(
                    "probing instant output.mp4 frame gaps: {}",
                    artifacts.output_path.display()
                )
            })?;
            Ok(StepReading::from_gap(
                "instant camera (output.mp4)".to_string(),
                gap,
            ))
        }
    }
}

fn empty_results(hardware: &DiscoveredHardware, elapsed: Duration) -> TestResults {
    TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "AV Step Suite".to_string(),
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
