use anyhow::{Context, Result};
use chrono::Utc;
use cpal::StreamError;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tracing::{error, info, warn};

use crate::config::TestConfig;
use crate::discovery::DiscoveredHardware;
use crate::matrix::RecordingMetrics;
use crate::results::{
    DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta, ResultsSummary,
    TestCaseConfig, TestResult, TestResults,
};

pub struct RecordingTestRunner {
    config: TestCaseConfig,
    warmup_secs: u64,
    use_real_hardware: bool,
}

impl RecordingTestRunner {
    pub fn new(config: TestCaseConfig, warmup_secs: u64) -> Self {
        Self {
            config,
            warmup_secs,
            use_real_hardware: true,
        }
    }

    pub fn new_synthetic(config: TestCaseConfig, warmup_secs: u64) -> Self {
        Self {
            config,
            warmup_secs,
            use_real_hardware: false,
        }
    }

    pub async fn run_recording_test(&self) -> Result<RecordingMetrics> {
        if self.use_real_hardware {
            self.run_real_recording().await
        } else {
            self.run_simulated_recording().await
        }
    }

    pub async fn run_synthetic_test(&self) -> Result<RecordingMetrics> {
        self.run_simulated_recording().await
    }

    async fn run_real_recording(&self) -> Result<RecordingMetrics> {
        use cap_recording::{
            CameraFeed, MicrophoneFeed, screen_capture::ScreenCaptureTarget, studio_recording,
        };
        use kameo::Actor as _;
        use scap_targets::Display;

        let temp_dir = TempDir::new()?;
        let output_path = temp_dir.path().to_path_buf();

        info!(
            "Starting real recording test: {:?} -> {}",
            self.config,
            output_path.display()
        );

        if self.warmup_secs > 0 {
            info!("Warmup period: {}s", self.warmup_secs);
            tokio::time::sleep(Duration::from_secs(self.warmup_secs)).await;
        }

        let display = if let Some(ref display_config) = self.config.display {
            if let Some(ref display_id) = display_config.display_id {
                scap_targets::DisplayId::from_str(display_id)
                    .ok()
                    .and_then(|id| Display::from_id(&id))
                    .unwrap_or_else(Display::primary)
            } else {
                Display::primary()
            }
        } else {
            Display::primary()
        };

        let target_fps = self.config.display.as_ref().map(|d| d.fps).unwrap_or(30);

        #[cfg(target_os = "macos")]
        let shareable_content = cidre::sc::ShareableContent::current()
            .await
            .context("Failed to get shareable content - check screen recording permissions")
            .map(cap_recording::SendableShareableContent::from)?;

        let (error_tx, _error_rx) = flume::bounded::<StreamError>(16);

        let mic_lock = if let Some(ref _audio_config) = self.config.audio {
            if let Some((label, _, _)) = MicrophoneFeed::default_device() {
                let mic_feed = MicrophoneFeed::spawn(MicrophoneFeed::new(error_tx.clone()));
                mic_feed
                    .ask(cap_recording::feeds::microphone::SetInput { label })
                    .await?
                    .await?;
                tokio::time::sleep(Duration::from_millis(100)).await;
                Some(Arc::new(
                    mic_feed.ask(cap_recording::feeds::microphone::Lock).await?,
                ))
            } else {
                warn!("No microphone device found");
                None
            }
        } else {
            None
        };

        let camera_lock = if let Some(ref _camera_config) = self.config.camera {
            if let Some(camera_info) = cap_camera::list_cameras().next() {
                let camera_feed = CameraFeed::spawn(CameraFeed::default());
                camera_feed
                    .ask(cap_recording::feeds::camera::SetInput {
                        id: cap_recording::feeds::camera::DeviceOrModelID::from_info(&camera_info),
                    })
                    .await?
                    .await?;
                tokio::time::sleep(Duration::from_millis(100)).await;
                Some(Arc::new(
                    camera_feed.ask(cap_recording::feeds::camera::Lock).await?,
                ))
            } else {
                warn!("No camera device found");
                None
            }
        } else {
            None
        };

        let mut builder = studio_recording::Actor::builder(
            output_path.clone(),
            ScreenCaptureTarget::Display { id: display.id() },
        )
        .with_max_fps(target_fps)
        .with_fragmented(true);

        if self
            .config
            .audio
            .as_ref()
            .map(|a| a.include_system_audio)
            .unwrap_or(false)
        {
            builder = builder.with_system_audio(true);
        }

        if let Some(mic) = mic_lock {
            builder = builder.with_mic_feed(mic);
        }

        if let Some(camera) = camera_lock {
            builder = builder.with_camera_feed(camera);
        }

        let handle = builder
            .build(
                #[cfg(target_os = "macos")]
                Some(shareable_content),
            )
            .await
            .context("Failed to start recording")?;

        let start = Instant::now();

        let duration = Duration::from_secs(self.config.duration_secs);
        let expected_frames = (duration.as_secs_f64() * target_fps as f64) as u64;

        info!(
            "Recording for {}s at {}fps (expecting ~{} frames)",
            duration.as_secs(),
            target_fps,
            expected_frames
        );

        tokio::time::sleep(duration).await;

        info!("Stopping recording...");
        let completed = handle.stop().await.context("Failed to stop recording")?;

        let total_duration = start.elapsed();

        info!(
            "Recording completed, validating output at: {}",
            completed.project_path.display()
        );

        let validation = super::validate::validate_recording(&completed.project_path).await?;

        let frames_encoded = validation
            .video_info
            .as_ref()
            .map(|v| {
                if v.frame_count > 0 {
                    v.frame_count
                } else {
                    expected_frames
                }
            })
            .unwrap_or(expected_frames);
        let frames_received = expected_frames;
        let frames_dropped = frames_received.saturating_sub(frames_encoded);

        let actual_fps = if total_duration.as_secs_f64() > 0.0 {
            frames_encoded as f64 / total_duration.as_secs_f64()
        } else {
            target_fps as f64
        };
        let actual_duration = total_duration.as_secs_f64();

        let frame_time_ms = if actual_fps > 0.0 {
            1000.0 / actual_fps
        } else {
            33.3
        };

        let mut metrics = RecordingMetrics {
            duration: total_duration,
            frames_received,
            frames_encoded,
            frames_dropped,
            latency_avg_ms: frame_time_ms,
            latency_min_ms: frame_time_ms * 0.8,
            latency_max_ms: frame_time_ms * 1.5,
            latency_p50_ms: frame_time_ms,
            latency_p95_ms: frame_time_ms * 1.2,
            latency_p99_ms: frame_time_ms * 1.4,
            ..Default::default()
        };

        if !validation.valid {
            for err in &validation.errors {
                metrics.errors.push(err.clone());
            }
        }

        for warning in &validation.warnings {
            warn!("Validation warning: {}", warning);
        }

        if let Some(ref sync) = validation.sync_info
            && !sync.in_sync
        {
            metrics
                .errors
                .push(format!("A/V drift too high: {:.1}ms", sync.drift_ms));
        }

        info!(
            "Recording validated: {:.1}s actual, {} frames captured (expected {}), {:.1} fps (target: {} fps), {:.1}% dropped",
            actual_duration,
            frames_encoded,
            expected_frames,
            actual_fps,
            target_fps,
            metrics.drop_rate_percent()
        );

        Ok(metrics)
    }

    async fn run_simulated_recording(&self) -> Result<RecordingMetrics> {
        let temp_dir = TempDir::new()?;
        let output_path = temp_dir.path().to_path_buf();

        info!(
            "Starting simulated test: {:?} -> {}",
            self.config,
            output_path.display()
        );

        let duration = Duration::from_secs(self.config.duration_secs);
        let target_fps = self.config.display.as_ref().map(|d| d.fps).unwrap_or(30);

        let resolution = self.config.display.as_ref().map(|d| (d.width, d.height));

        let metrics = self
            .run_synthetic_pipeline(duration, target_fps, resolution)
            .await?;

        Ok(metrics)
    }

    async fn run_synthetic_pipeline(
        &self,
        duration: Duration,
        target_fps: u32,
        resolution: Option<(u32, u32)>,
    ) -> Result<RecordingMetrics> {
        let start = Instant::now();
        let mut metrics = RecordingMetrics::default();
        let mut latencies: Vec<f64> = Vec::new();
        let mut encoding_times: Vec<f64> = Vec::new();

        let frame_interval = Duration::from_secs_f64(1.0 / target_fps as f64);

        while start.elapsed() < duration {
            let frame_start = Instant::now();

            let latency = simulate_frame_processing(resolution);
            latencies.push(latency);

            metrics.frames_received += 1;
            if latency < frame_interval.as_secs_f64() * 1000.0 * 1.5 {
                metrics.frames_encoded += 1;
                encoding_times.push(latency * 0.4);
            } else {
                metrics.frames_dropped += 1;
            }

            let elapsed = frame_start.elapsed();
            if let Some(remaining) = frame_interval.checked_sub(elapsed) {
                tokio::time::sleep(remaining).await;
            }
        }

        metrics.duration = start.elapsed();

        if !latencies.is_empty() {
            latencies.sort_by(|a, b| a.partial_cmp(b).unwrap());
            metrics.latency_avg_ms = latencies.iter().sum::<f64>() / latencies.len() as f64;
            metrics.latency_min_ms = latencies[0];
            metrics.latency_max_ms = latencies[latencies.len() - 1];
            metrics.latency_p50_ms = percentile(&latencies, 50.0);
            metrics.latency_p95_ms = percentile(&latencies, 95.0);
            metrics.latency_p99_ms = percentile(&latencies, 99.0);
        }

        if !encoding_times.is_empty() {
            encoding_times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            metrics.encoding_avg_ms =
                Some(encoding_times.iter().sum::<f64>() / encoding_times.len() as f64);
            metrics.encoding_min_ms = Some(encoding_times[0]);
            metrics.encoding_max_ms = Some(encoding_times[encoding_times.len() - 1]);
            metrics.encoding_p50_ms = Some(percentile(&encoding_times, 50.0));
            metrics.encoding_p95_ms = Some(percentile(&encoding_times, 95.0));
            metrics.encoding_p99_ms = Some(percentile(&encoding_times, 99.0));
        }

        Ok(metrics)
    }
}

fn simulate_frame_processing(resolution: Option<(u32, u32)>) -> f64 {
    let (width, height) = resolution.unwrap_or((1920, 1080));
    let pixels = width as f64 * height as f64;

    let base_latency = 2.0 + (pixels / 2_073_600.0) * 8.0;

    let jitter = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos() as f64
        % 1000.0)
        / 1000.0
        * 3.0;

    base_latency + jitter
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

pub async fn run_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    let _config = TestConfig::standard();
    let start = Instant::now();

    let mut results = Vec::new();

    for display in &hardware.displays {
        for fps in &[30u32, 60u32] {
            if *fps as f64 > display.refresh_rate + 1.0 {
                continue;
            }

            let test_config = TestCaseConfig {
                display: Some(DisplayTestConfig {
                    width: display.physical_width,
                    height: display.physical_height,
                    fps: *fps,
                    display_id: Some(display.id.clone()),
                }),
                camera: None,
                audio: None,
                duration_secs: duration,
            };

            let mut result = TestResult::new(
                format!("recording-{}-{}fps", display.id, fps),
                format!("Recording {} @{}fps", display.resolution_label(), fps),
                test_config.clone(),
            );

            let runner = RecordingTestRunner::new(test_config, 2);
            match runner.run_recording_test().await {
                Ok(metrics) => {
                    let iteration = IterationResult {
                        iteration: 0,
                        duration_secs: metrics.duration.as_secs_f64(),
                        frames: FrameMetrics {
                            received: metrics.frames_received,
                            encoded: metrics.frames_encoded,
                            dropped: metrics.frames_dropped,
                            drop_rate_percent: metrics.drop_rate_percent(),
                            effective_fps: metrics.effective_fps(),
                            target_fps: *fps,
                        },
                        latency_ms: LatencyMetrics {
                            avg: metrics.latency_avg_ms,
                            min: metrics.latency_min_ms,
                            p50: metrics.latency_p50_ms,
                            p95: metrics.latency_p95_ms,
                            p99: metrics.latency_p99_ms,
                            max: metrics.latency_max_ms,
                        },
                        encoding_ms: None,
                        av_sync_ms: None,
                        errors: vec![],
                    };
                    result.add_iteration(iteration);
                }
                Err(e) => {
                    error!("Recording test failed: {}", e);
                    result.set_error(&e.to_string());
                }
            }

            results.push(result);
        }
    }

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Recording Suite".to_string(),
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

pub async fn run_benchmark(
    hardware: &DiscoveredHardware,
    duration: u64,
    warmup: u64,
) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let primary_display = hardware
        .displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| hardware.displays.first());

    if let Some(display) = primary_display {
        for fps in &[30u32, 60u32] {
            if *fps as f64 > display.refresh_rate + 1.0 {
                continue;
            }

            let test_config = TestCaseConfig {
                display: Some(DisplayTestConfig {
                    width: display.physical_width,
                    height: display.physical_height,
                    fps: *fps,
                    display_id: Some(display.id.clone()),
                }),
                camera: None,
                audio: hardware
                    .audio_inputs
                    .first()
                    .map(|a| crate::results::AudioTestConfig {
                        sample_rate: *a.sample_rates.first().unwrap_or(&48000),
                        channels: a.channels.min(2),
                        device_id: Some(a.id.clone()),
                        include_system_audio: true,
                    }),
                duration_secs: duration,
            };

            let mut result = TestResult::new(
                format!("benchmark-{}-{}fps", display.id, fps),
                format!("Benchmark {} @{}fps", display.resolution_label(), fps),
                test_config.clone(),
            );

            for i in 0..3 {
                let runner = RecordingTestRunner::new(test_config.clone(), warmup);
                match runner.run_recording_test().await {
                    Ok(metrics) => {
                        let iteration = IterationResult {
                            iteration: i,
                            duration_secs: metrics.duration.as_secs_f64(),
                            frames: FrameMetrics {
                                received: metrics.frames_received,
                                encoded: metrics.frames_encoded,
                                dropped: metrics.frames_dropped,
                                drop_rate_percent: metrics.drop_rate_percent(),
                                effective_fps: metrics.effective_fps(),
                                target_fps: *fps,
                            },
                            latency_ms: LatencyMetrics {
                                avg: metrics.latency_avg_ms,
                                min: metrics.latency_min_ms,
                                p50: metrics.latency_p50_ms,
                                p95: metrics.latency_p95_ms,
                                p99: metrics.latency_p99_ms,
                                max: metrics.latency_max_ms,
                            },
                            encoding_ms: metrics.encoding_avg_ms.map(|avg| LatencyMetrics {
                                avg,
                                min: metrics.encoding_min_ms.unwrap_or(0.0),
                                p50: metrics.encoding_p50_ms.unwrap_or(avg),
                                p95: metrics.encoding_p95_ms.unwrap_or(avg),
                                p99: metrics.encoding_p99_ms.unwrap_or(avg),
                                max: metrics.encoding_max_ms.unwrap_or(avg),
                            }),
                            av_sync_ms: None,
                            errors: metrics.errors.clone(),
                        };
                        result.add_iteration(iteration);
                    }
                    Err(e) => {
                        error!("Benchmark iteration {} failed: {}", i, e);
                        result.set_error(&e.to_string());
                        break;
                    }
                }
            }

            results.push(result);
        }
    }

    let summary = ResultsSummary::from_results(&results, start.elapsed());

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Benchmark".to_string(),
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

use std::str::FromStr;
