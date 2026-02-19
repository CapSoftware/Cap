use anyhow::Result;
use chrono::Utc;
use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use std::time::{Duration, Instant};
use tracing::error;

use crate::config::TestConfig;
use crate::discovery::{DiscoveredHardware, SystemInfo};
use crate::results::{
    FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta, ResultsSummary, TestResult,
    TestResults,
};
use crate::suites::RecordingTestRunner;

use super::generator::{MatrixGenerator, TestCase, TestCaseSource};

pub struct MatrixRunner {
    config: TestConfig,
    hardware: Option<DiscoveredHardware>,
    test_cases: Vec<TestCase>,
}

impl MatrixRunner {
    pub fn new(config: TestConfig, hardware: DiscoveredHardware) -> Self {
        let generator = MatrixGenerator::new(config.clone(), Some(hardware.clone()));
        let test_cases = generator.generate();

        Self {
            config,
            hardware: Some(hardware),
            test_cases,
        }
    }

    pub fn new_synthetic(config: TestConfig) -> Self {
        let generator = MatrixGenerator::new(config.clone(), None);
        let test_cases = generator.generate();

        Self {
            config,
            hardware: None,
            test_cases,
        }
    }

    pub async fn run(&self) -> Result<TestResults> {
        let start_time = Instant::now();

        println!(
            "\n{} {}",
            "Running test matrix:".bold().cyan(),
            self.config.meta.name
        );
        println!(
            "  {} test cases, {} iterations each",
            self.test_cases.len(),
            self.config.recording.iterations
        );
        println!();

        let progress = ProgressBar::new(self.test_cases.len() as u64);
        progress.set_style(
            ProgressStyle::default_bar()
                .template("{spinner:.green} [{bar:40.cyan/blue}] {pos}/{len} {msg}")
                .unwrap()
                .progress_chars("=>-"),
        );

        let mut results = Vec::new();

        for test_case in &self.test_cases {
            progress.set_message(test_case.name.to_string());

            let result = self.run_test_case(test_case).await;
            results.push(result);

            progress.inc(1);
        }

        progress.finish_with_message("Complete");

        let total_duration = start_time.elapsed();
        let summary = ResultsSummary::from_results(&results, total_duration);

        let system_info = self
            .hardware
            .as_ref()
            .map(|h| h.system_info.clone())
            .unwrap_or_else(|| SystemInfo {
                platform: std::env::consts::OS.to_string(),
                os_version: "Unknown".to_string(),
                cpu: "Unknown".to_string(),
                memory_gb: 0,
                gpu: None,
            });

        Ok(TestResults {
            meta: ResultsMeta {
                timestamp: Utc::now(),
                config_name: self.config.meta.name.clone(),
                config_path: None,
                platform: system_info.platform.clone(),
                system: system_info,
                cap_version: option_env!("CARGO_PKG_VERSION").map(String::from),
            },
            hardware: self.hardware.clone(),
            results,
            summary,
        })
    }

    async fn run_test_case(&self, test_case: &TestCase) -> TestResult {
        let mut result = TestResult::new(
            test_case.id.clone(),
            test_case.name.clone(),
            test_case.config.clone(),
        );

        match &test_case.source {
            TestCaseSource::RealHardware {
                display_id: _,
                camera_id: _,
                audio_input_id: _,
            } => {
                for iteration in 0..self.config.recording.iterations {
                    match self.run_real_hardware_test(test_case, iteration).await {
                        Ok(iteration_result) => {
                            if !self.check_thresholds(&iteration_result) {
                                result.set_failed("Performance below thresholds");
                            }
                            result.add_iteration(iteration_result);
                        }
                        Err(e) => {
                            error!(
                                "Test {} iteration {} failed: {}",
                                test_case.id, iteration, e
                            );
                            result.set_error(&e.to_string());
                            break;
                        }
                    }
                }
            }
            TestCaseSource::Synthetic => {
                for iteration in 0..self.config.recording.iterations {
                    match self.run_synthetic_test(test_case, iteration).await {
                        Ok(iteration_result) => {
                            if !self.check_thresholds(&iteration_result) {
                                result.set_failed("Performance below thresholds");
                            }
                            result.add_iteration(iteration_result);
                        }
                        Err(e) => {
                            error!(
                                "Synthetic test {} iteration {} failed: {}",
                                test_case.id, iteration, e
                            );
                            result.set_error(&e.to_string());
                            break;
                        }
                    }
                }
            }
        }

        result
    }

    async fn run_real_hardware_test(
        &self,
        test_case: &TestCase,
        iteration: u32,
    ) -> Result<IterationResult> {
        let runner =
            RecordingTestRunner::new(test_case.config.clone(), self.config.recording.warmup_secs);

        let metrics = runner.run_recording_test().await?;

        Ok(self.metrics_to_iteration_result(iteration, &metrics, test_case))
    }

    async fn run_synthetic_test(
        &self,
        test_case: &TestCase,
        iteration: u32,
    ) -> Result<IterationResult> {
        let runner = RecordingTestRunner::new_synthetic(
            test_case.config.clone(),
            self.config.recording.warmup_secs,
        );

        let metrics = runner.run_synthetic_test().await?;

        Ok(self.metrics_to_iteration_result(iteration, &metrics, test_case))
    }

    fn metrics_to_iteration_result(
        &self,
        iteration: u32,
        metrics: &RecordingMetrics,
        test_case: &TestCase,
    ) -> IterationResult {
        let target_fps = test_case
            .config
            .display
            .as_ref()
            .map(|d| d.fps)
            .or_else(|| test_case.config.camera.as_ref().map(|c| c.fps))
            .unwrap_or(30);

        IterationResult {
            iteration,
            duration_secs: metrics.duration.as_secs_f64(),
            frames: FrameMetrics {
                received: metrics.frames_received,
                encoded: metrics.frames_encoded,
                dropped: metrics.frames_dropped,
                drop_rate_percent: metrics.drop_rate_percent(),
                effective_fps: metrics.effective_fps(),
                target_fps,
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
        }
    }

    fn check_thresholds(&self, result: &IterationResult) -> bool {
        let thresholds = &self.config.thresholds;

        if result.frames.drop_rate_percent > thresholds.max_drop_rate_percent {
            return false;
        }

        let fps_ratio = result.frames.effective_fps / result.frames.target_fps as f64;
        if fps_ratio < thresholds.min_effective_fps_ratio {
            return false;
        }

        if result.latency_ms.p95 > thresholds.max_p95_latency_ms {
            return false;
        }

        true
    }
}

#[derive(Debug, Clone, Default)]
pub struct RecordingMetrics {
    pub duration: Duration,
    pub frames_received: u64,
    pub frames_encoded: u64,
    pub frames_dropped: u64,
    pub latency_avg_ms: f64,
    pub latency_min_ms: f64,
    pub latency_p50_ms: f64,
    pub latency_p95_ms: f64,
    pub latency_p99_ms: f64,
    pub latency_max_ms: f64,
    pub encoding_avg_ms: Option<f64>,
    pub encoding_min_ms: Option<f64>,
    pub encoding_p50_ms: Option<f64>,
    pub encoding_p95_ms: Option<f64>,
    pub encoding_p99_ms: Option<f64>,
    pub encoding_max_ms: Option<f64>,
    pub errors: Vec<String>,
}

impl RecordingMetrics {
    pub fn drop_rate_percent(&self) -> f64 {
        if self.frames_received == 0 {
            0.0
        } else {
            self.frames_dropped as f64 / self.frames_received as f64 * 100.0
        }
    }

    pub fn effective_fps(&self) -> f64 {
        if self.duration.as_secs_f64() > 0.0 {
            self.frames_encoded as f64 / self.duration.as_secs_f64()
        } else {
            0.0
        }
    }
}

pub struct CompatMatrixRunner {
    config: TestConfig,
    hardware: DiscoveredHardware,
    interactive: bool,
}

impl CompatMatrixRunner {
    pub fn new(config: TestConfig, hardware: DiscoveredHardware, interactive: bool) -> Self {
        Self {
            config,
            hardware,
            interactive,
        }
    }

    pub async fn run(&self) -> Result<crate::results::CompatibilityReport> {
        use crate::results::{BlockingFailure, CompatibilityReport, DeviceCoverage, ResultsMeta};
        use crate::suites::{ScenarioRunner, classify_test_failure};

        println!(
            "\n{}",
            "╔══════════════════════════════════════════════════════╗"
                .bold()
                .cyan()
        );
        println!(
            "{}",
            "║       COMPATIBILITY VALIDATION MATRIX                ║"
                .bold()
                .cyan()
        );
        println!(
            "{}",
            "╚══════════════════════════════════════════════════════╝"
                .bold()
                .cyan()
        );
        println!();
        println!("  OS: {}", self.hardware.system_info.os_version);
        println!("  CPU: {}", self.hardware.system_info.cpu);
        println!("  Memory: {} GB", self.hardware.system_info.memory_gb);
        println!("  Displays: {}", self.hardware.displays.len());
        println!("  Cameras: {}", self.hardware.cameras.len());
        println!("  Audio Inputs: {}", self.hardware.audio_inputs.len());
        println!("  Interactive: {}", self.interactive);
        println!();

        let matrix_runner = MatrixRunner::new(self.config.clone(), self.hardware.clone());
        let matrix_results = matrix_runner.run().await?;

        let scenario_results = if self.config.scenarios.enabled {
            println!("\n{}", "Running resilience scenarios...".bold().cyan());
            let scenario_runner =
                ScenarioRunner::new(self.config.clone(), self.hardware.clone(), self.interactive);
            scenario_runner.run_all().await
        } else {
            Vec::new()
        };

        let mut blocking_failures = Vec::new();

        for result in &matrix_results.results {
            if let Some(classification) = classify_test_failure(result)
                && classification.is_blocking()
            {
                blocking_failures.push(BlockingFailure {
                    test_id: result.test_id.clone(),
                    test_name: result.name.clone(),
                    classification,
                    reason: result
                        .failure_reason
                        .clone()
                        .unwrap_or_else(|| "Unknown failure".to_string()),
                    reproduction_steps: build_reproduction_steps(result),
                });
            }
        }

        for scenario in &scenario_results {
            if let Some(classification) = &scenario.failure_classification
                && classification.is_blocking()
            {
                blocking_failures.push(BlockingFailure {
                    test_id: scenario.scenario_id.clone(),
                    test_name: scenario.scenario_name.clone(),
                    classification: *classification,
                    reason: scenario
                        .failure_reason
                        .clone()
                        .unwrap_or_else(|| "Unknown failure".to_string()),
                    reproduction_steps: vec![format!(
                        "Run: cap-test compat-matrix --interactive (scenario: {})",
                        scenario.scenario_name
                    )],
                });
            }
        }

        let device_coverage =
            DeviceCoverage::from_hardware_and_results(&self.hardware, &matrix_results.results);

        let release_gate_passed = blocking_failures.is_empty();

        let meta = ResultsMeta {
            timestamp: Utc::now(),
            config_name: self.config.meta.name.clone(),
            config_path: None,
            platform: self.hardware.system_info.platform.clone(),
            system: self.hardware.system_info.clone(),
            cap_version: option_env!("CARGO_PKG_VERSION").map(String::from),
        };

        Ok(CompatibilityReport {
            meta,
            hardware: Some(self.hardware.clone()),
            device_coverage,
            matrix_results,
            scenario_results,
            blocking_failures,
            release_gate_passed,
        })
    }
}

fn build_reproduction_steps(result: &crate::results::TestResult) -> Vec<String> {
    let mut steps = Vec::new();

    let mut config_parts = Vec::new();
    if let Some(display) = &result.config.display {
        config_parts.push(format!(
            "display={}x{}@{}fps",
            display.width, display.height, display.fps
        ));
        if let Some(id) = &display.display_id {
            config_parts.push(format!("display_id={}", id));
        }
    }
    if let Some(camera) = &result.config.camera {
        config_parts.push(format!(
            "camera={}x{}@{}fps",
            camera.width, camera.height, camera.fps
        ));
        if let Some(id) = &camera.device_id {
            config_parts.push(format!("camera_id={}", id));
        }
    }
    if let Some(audio) = &result.config.audio {
        config_parts.push(format!(
            "audio={}Hz/{}ch",
            audio.sample_rate, audio.channels
        ));
        if let Some(id) = &audio.device_id {
            config_parts.push(format!("audio_device={}", id));
        }
    }

    steps.push(format!("Configuration: {}", config_parts.join(", ")));
    steps.push(format!("Duration: {}s", result.config.duration_secs));

    if let Some(reason) = &result.failure_reason {
        steps.push(format!("Failure: {}", reason));
    }

    for iteration in &result.iterations {
        if !iteration.errors.is_empty() {
            for err in &iteration.errors {
                steps.push(format!(
                    "Error (iteration {}): {}",
                    iteration.iteration, err
                ));
            }
        }
    }

    steps
}
