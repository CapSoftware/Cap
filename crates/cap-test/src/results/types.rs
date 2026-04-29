use anyhow::Context as _;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::discovery::{DiscoveredHardware, SystemInfo};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResults {
    pub meta: ResultsMeta,
    pub hardware: Option<DiscoveredHardware>,
    pub results: Vec<TestResult>,
    pub summary: ResultsSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultsMeta {
    pub timestamp: DateTime<Utc>,
    pub config_name: String,
    pub config_path: Option<String>,
    pub platform: String,
    pub system: SystemInfo,
    pub cap_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub test_id: String,
    pub name: String,
    pub config: TestCaseConfig,
    pub iterations: Vec<IterationResult>,
    pub status: TestStatus,
    pub failure_reason: Option<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestCaseConfig {
    pub display: Option<DisplayTestConfig>,
    pub camera: Option<CameraTestConfig>,
    pub audio: Option<AudioTestConfig>,
    pub duration_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayTestConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub display_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraTestConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pixel_format: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioTestConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub device_id: Option<String>,
    pub include_system_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IterationResult {
    pub iteration: u32,
    pub duration_secs: f64,
    pub frames: FrameMetrics,
    pub latency_ms: LatencyMetrics,
    pub encoding_ms: Option<LatencyMetrics>,
    pub av_sync_ms: Option<SyncMetrics>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameMetrics {
    pub received: u64,
    pub encoded: u64,
    pub dropped: u64,
    pub drop_rate_percent: f64,
    pub effective_fps: f64,
    pub target_fps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LatencyMetrics {
    pub avg: f64,
    pub min: f64,
    pub p50: f64,
    pub p95: f64,
    pub p99: f64,
    pub max: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncMetrics {
    pub offset_ms: f64,
    pub drift_ms: f64,
    pub max_drift_ms: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TestStatus {
    Pass,
    Fail,
    Skip,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultsSummary {
    pub total_tests: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub errors: u32,
    pub duration_secs: f64,
    pub pass_rate: f64,
}

impl TestResult {
    pub fn new(test_id: String, name: String, config: TestCaseConfig) -> Self {
        Self {
            test_id,
            name,
            config,
            iterations: Vec::new(),
            status: TestStatus::Pass,
            failure_reason: None,
            notes: Vec::new(),
        }
    }

    pub fn add_iteration(&mut self, result: IterationResult) {
        self.iterations.push(result);
    }

    pub fn set_failed(&mut self, reason: &str) {
        self.status = TestStatus::Fail;
        self.failure_reason = Some(reason.to_string());
    }

    pub fn set_error(&mut self, reason: &str) {
        self.status = TestStatus::Error;
        self.failure_reason = Some(reason.to_string());
    }

    pub fn set_skipped(&mut self, reason: &str) {
        self.status = TestStatus::Skip;
        self.failure_reason = Some(reason.to_string());
    }

    pub fn avg_effective_fps(&self) -> f64 {
        if self.iterations.is_empty() {
            return 0.0;
        }
        let sum: f64 = self.iterations.iter().map(|i| i.frames.effective_fps).sum();
        sum / self.iterations.len() as f64
    }

    pub fn avg_drop_rate(&self) -> f64 {
        if self.iterations.is_empty() {
            return 0.0;
        }
        let sum: f64 = self
            .iterations
            .iter()
            .map(|i| i.frames.drop_rate_percent)
            .sum();
        sum / self.iterations.len() as f64
    }

    pub fn avg_p95_latency(&self) -> f64 {
        if self.iterations.is_empty() {
            return 0.0;
        }
        let sum: f64 = self.iterations.iter().map(|i| i.latency_ms.p95).sum();
        sum / self.iterations.len() as f64
    }
}

impl ResultsSummary {
    pub fn from_results(results: &[TestResult], total_duration: Duration) -> Self {
        let total = results.len() as u32;
        let passed = results
            .iter()
            .filter(|r| r.status == TestStatus::Pass)
            .count() as u32;
        let failed = results
            .iter()
            .filter(|r| r.status == TestStatus::Fail)
            .count() as u32;
        let skipped = results
            .iter()
            .filter(|r| r.status == TestStatus::Skip)
            .count() as u32;
        let errors = results
            .iter()
            .filter(|r| r.status == TestStatus::Error)
            .count() as u32;

        let pass_rate = if total > 0 {
            passed as f64 / total as f64 * 100.0
        } else {
            0.0
        };

        Self {
            total_tests: total,
            passed,
            failed,
            skipped,
            errors,
            duration_secs: total_duration.as_secs_f64(),
            pass_rate,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidationResult {
    pub path: String,
    pub valid: bool,
    pub video_info: Option<VideoValidation>,
    pub audio_info: Option<AudioValidation>,
    pub sync_info: Option<SyncValidation>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoValidation {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration_secs: f64,
    pub frame_count: u64,
    pub codec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioValidation {
    pub sample_rate: u32,
    pub channels: u16,
    pub duration_secs: f64,
    pub codec: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncValidation {
    pub video_duration_secs: f64,
    pub audio_duration_secs: f64,
    pub drift_ms: f64,
    pub in_sync: bool,
}

impl ValidationResult {
    pub fn print_summary(&self) {
        use colored::Colorize;

        println!("\n{}", "=== Recording Validation ===".bold().cyan());
        println!("Path: {}", self.path);

        let status = if self.valid {
            "VALID".green().bold()
        } else {
            "INVALID".red().bold()
        };
        println!("Status: {}", status);

        if let Some(video) = &self.video_info {
            println!("\n{}", "Video:".bold());
            println!("  Resolution: {}x{}", video.width, video.height);
            println!("  FPS: {:.2}", video.fps);
            println!("  Duration: {:.2}s", video.duration_secs);
            println!("  Frames: {}", video.frame_count);
            println!("  Codec: {}", video.codec);
        }

        if let Some(audio) = &self.audio_info {
            println!("\n{}", "Audio:".bold());
            println!("  Sample Rate: {}Hz", audio.sample_rate);
            println!("  Channels: {}", audio.channels);
            println!("  Duration: {:.2}s", audio.duration_secs);
            println!("  Codec: {}", audio.codec);
        }

        if let Some(sync) = &self.sync_info {
            println!("\n{}", "A/V Sync:".bold());
            println!("  Video Duration: {:.3}s", sync.video_duration_secs);
            println!("  Audio Duration: {:.3}s", sync.audio_duration_secs);
            println!("  Drift: {:.1}ms", sync.drift_ms);
            let sync_status = if sync.in_sync {
                "IN SYNC".green()
            } else {
                "OUT OF SYNC".red()
            };
            println!("  Status: {}", sync_status);
        }

        if !self.errors.is_empty() {
            println!("\n{}", "Errors:".red().bold());
            for error in &self.errors {
                println!("  - {}", error);
            }
        }

        if !self.warnings.is_empty() {
            println!("\n{}", "Warnings:".yellow().bold());
            for warning in &self.warnings {
                println!("  - {}", warning);
            }
        }

        println!();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComparisonResult {
    pub current_summary: ResultsSummary,
    pub baseline_summary: ResultsSummary,
    pub regressions: Vec<Regression>,
    pub improvements: Vec<Improvement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Regression {
    pub test_id: String,
    pub metric: String,
    pub baseline_value: f64,
    pub current_value: f64,
    pub change_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Improvement {
    pub test_id: String,
    pub metric: String,
    pub baseline_value: f64,
    pub current_value: f64,
    pub change_percent: f64,
}

impl ComparisonResult {
    pub fn print_summary(&self) {
        use colored::Colorize;

        println!("\n{}", "=== Results Comparison ===".bold().cyan());

        println!("\n{}", "Summary:".bold());
        println!(
            "  Baseline: {} tests, {:.1}% pass rate",
            self.baseline_summary.total_tests, self.baseline_summary.pass_rate
        );
        println!(
            "  Current:  {} tests, {:.1}% pass rate",
            self.current_summary.total_tests, self.current_summary.pass_rate
        );

        let pass_rate_diff = self.current_summary.pass_rate - self.baseline_summary.pass_rate;
        let diff_str = if pass_rate_diff >= 0.0 {
            format!("+{:.1}%", pass_rate_diff).green()
        } else {
            format!("{:.1}%", pass_rate_diff).red()
        };
        println!("  Change: {}", diff_str);

        if !self.regressions.is_empty() {
            println!(
                "\n{} ({})",
                "Regressions:".red().bold(),
                self.regressions.len()
            );
            for reg in &self.regressions {
                println!(
                    "  {} [{}]: {:.2} -> {:.2} ({:+.1}%)",
                    reg.test_id,
                    reg.metric,
                    reg.baseline_value,
                    reg.current_value,
                    reg.change_percent
                );
            }
        }

        if !self.improvements.is_empty() {
            println!(
                "\n{} ({})",
                "Improvements:".green().bold(),
                self.improvements.len()
            );
            for imp in &self.improvements {
                println!(
                    "  {} [{}]: {:.2} -> {:.2} ({:+.1}%)",
                    imp.test_id,
                    imp.metric,
                    imp.baseline_value,
                    imp.current_value,
                    imp.change_percent
                );
            }
        }

        println!();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityReport {
    pub meta: ResultsMeta,
    pub hardware: Option<DiscoveredHardware>,
    pub device_coverage: DeviceCoverage,
    pub matrix_results: TestResults,
    pub scenario_results: Vec<ScenarioResult>,
    pub blocking_failures: Vec<BlockingFailure>,
    pub release_gate_passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCoverage {
    pub displays_tested: u32,
    pub displays_total: u32,
    pub cameras_tested: u32,
    pub cameras_total: u32,
    pub builtin_mics_tested: u32,
    pub usb_mics_tested: u32,
    pub bluetooth_mics_tested: u32,
    pub virtual_cameras_tested: u32,
    pub capture_cards_tested: u32,
    pub multi_monitor: bool,
}

impl DeviceCoverage {
    pub fn from_hardware_and_results(
        hardware: &DiscoveredHardware,
        results: &[TestResult],
    ) -> Self {
        let displays_total = hardware.displays.len() as u32;
        let cameras_total = hardware.cameras.len() as u32;

        let displays_tested = results
            .iter()
            .filter(|r| r.config.display.is_some() && r.status != TestStatus::Skip)
            .map(|r| {
                r.config
                    .display
                    .as_ref()
                    .and_then(|d| d.display_id.clone())
                    .unwrap_or_default()
            })
            .collect::<std::collections::HashSet<_>>()
            .len() as u32;

        let cameras_tested = results
            .iter()
            .filter(|r| r.config.camera.is_some() && r.status != TestStatus::Skip)
            .map(|r| {
                r.config
                    .camera
                    .as_ref()
                    .and_then(|c| c.device_id.clone())
                    .unwrap_or_default()
            })
            .collect::<std::collections::HashSet<_>>()
            .len() as u32;

        let audio_tested_ids: std::collections::HashSet<_> = results
            .iter()
            .filter(|r| r.config.audio.is_some() && r.status != TestStatus::Skip)
            .filter_map(|r| r.config.audio.as_ref().and_then(|a| a.device_id.clone()))
            .collect();

        let builtin_mics_tested = hardware
            .audio_inputs
            .iter()
            .filter(|a| a.is_builtin && audio_tested_ids.contains(&a.id))
            .count() as u32;

        let usb_mics_tested = hardware
            .audio_inputs
            .iter()
            .filter(|a| a.is_usb && audio_tested_ids.contains(&a.id))
            .count() as u32;

        let bluetooth_mics_tested = hardware
            .audio_inputs
            .iter()
            .filter(|a| a.is_bluetooth && audio_tested_ids.contains(&a.id))
            .count() as u32;

        let camera_tested_ids: std::collections::HashSet<_> = results
            .iter()
            .filter(|r| r.config.camera.is_some() && r.status != TestStatus::Skip)
            .filter_map(|r| r.config.camera.as_ref().and_then(|c| c.device_id.clone()))
            .collect();

        let virtual_cameras_tested = hardware
            .cameras
            .iter()
            .filter(|c| c.is_virtual && camera_tested_ids.contains(&c.id))
            .count() as u32;

        let capture_cards_tested = hardware
            .cameras
            .iter()
            .filter(|c| c.is_capture_card && camera_tested_ids.contains(&c.id))
            .count() as u32;

        let multi_monitor = displays_total > 1 && displays_tested > 1;

        Self {
            displays_tested,
            displays_total,
            cameras_tested,
            cameras_total,
            builtin_mics_tested,
            usb_mics_tested,
            bluetooth_mics_tested,
            virtual_cameras_tested,
            capture_cards_tested,
            multi_monitor,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioResult {
    pub scenario_id: String,
    pub scenario_name: String,
    pub related_task: String,
    pub status: TestStatus,
    pub interactive_required: bool,
    pub failure_reason: Option<String>,
    pub failure_classification: Option<crate::config::FailureClassification>,
    pub duration_secs: f64,
    pub validation: Option<ValidationResult>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockingFailure {
    pub test_id: String,
    pub test_name: String,
    pub classification: crate::config::FailureClassification,
    pub reason: String,
    pub reproduction_steps: Vec<String>,
}

impl CompatibilityReport {
    pub fn save_json(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let json = serde_json::to_string_pretty(self)
            .context("Failed to serialize compatibility report")?;
        std::fs::write(path, json)
            .with_context(|| format!("Failed to write report to {}", path.display()))?;
        Ok(())
    }

    pub fn print_summary(&self) {
        use colored::Colorize;

        println!(
            "\n{}",
            "=== Compatibility Validation Report ===".bold().cyan()
        );
        println!(
            "  OS: {} ({})",
            self.meta.system.os_version, self.meta.system.platform
        );
        println!("  CPU: {}", self.meta.system.cpu);
        println!("  Memory: {} GB", self.meta.system.memory_gb);
        if let Some(gpu) = &self.meta.system.gpu {
            println!("  GPU: {}", gpu);
        }
        println!("  Timestamp: {}", self.meta.timestamp);

        println!("\n{}", "Device Coverage:".bold());
        println!(
            "  Displays: {}/{}",
            self.device_coverage.displays_tested, self.device_coverage.displays_total
        );
        println!(
            "  Cameras: {}/{}",
            self.device_coverage.cameras_tested, self.device_coverage.cameras_total
        );
        println!(
            "  Built-in Mics: {}",
            self.device_coverage.builtin_mics_tested
        );
        println!("  USB Mics: {}", self.device_coverage.usb_mics_tested);
        println!(
            "  Bluetooth Mics: {}",
            self.device_coverage.bluetooth_mics_tested
        );
        println!(
            "  Virtual Cameras: {}",
            self.device_coverage.virtual_cameras_tested
        );
        println!(
            "  Capture Cards: {}",
            self.device_coverage.capture_cards_tested
        );
        let multi_status = if self.device_coverage.multi_monitor {
            "Yes".green()
        } else {
            "N/A (single monitor)".yellow()
        };
        println!("  Multi-Monitor: {}", multi_status);

        self.matrix_results.print_summary();

        if !self.scenario_results.is_empty() {
            println!("{}", "Scenario Results:".bold().cyan());
            for scenario in &self.scenario_results {
                let status_str = match scenario.status {
                    TestStatus::Pass => "PASS".green().bold(),
                    TestStatus::Fail => "FAIL".red().bold(),
                    TestStatus::Skip => "SKIP".yellow().bold(),
                    TestStatus::Error => "ERROR".red().bold(),
                };
                let interactive_tag = if scenario.interactive_required {
                    " [interactive]"
                } else {
                    ""
                };
                println!(
                    "  {} {} ({}){}",
                    status_str, scenario.scenario_name, scenario.related_task, interactive_tag
                );
                if let Some(reason) = &scenario.failure_reason {
                    println!("    Reason: {}", reason.dimmed());
                }
                if let Some(classification) = &scenario.failure_classification {
                    let class_str = if classification.is_blocking() {
                        classification.display_name().red().bold()
                    } else {
                        classification.display_name().yellow().bold()
                    };
                    println!("    Classification: {}", class_str);
                }
            }
            println!();
        }

        if !self.blocking_failures.is_empty() {
            println!(
                "{} ({})",
                "BLOCKING FAILURES:".red().bold(),
                self.blocking_failures.len()
            );
            for failure in &self.blocking_failures {
                println!(
                    "  [{}] {} - {}",
                    failure.classification.display_name().red(),
                    failure.test_name,
                    failure.reason
                );
                if !failure.reproduction_steps.is_empty() {
                    println!("    Reproduction:");
                    for step in &failure.reproduction_steps {
                        println!("      - {}", step);
                    }
                }
            }
            println!();
        }

        let gate_str = if self.release_gate_passed {
            "RELEASE GATE: PASSED".green().bold()
        } else {
            "RELEASE GATE: FAILED".red().bold()
        };
        println!("{}\n", gate_str);
    }
}

pub fn compare(current: &TestResults, baseline: &TestResults) -> ComparisonResult {
    let mut regressions = Vec::new();
    let mut improvements = Vec::new();

    for current_test in &current.results {
        if let Some(baseline_test) = baseline
            .results
            .iter()
            .find(|t| t.test_id == current_test.test_id)
        {
            let current_fps = current_test.avg_effective_fps();
            let baseline_fps = baseline_test.avg_effective_fps();

            if baseline_fps > 0.0 {
                let fps_change = (current_fps - baseline_fps) / baseline_fps * 100.0;

                if fps_change < -5.0 {
                    regressions.push(Regression {
                        test_id: current_test.test_id.clone(),
                        metric: "effective_fps".to_string(),
                        baseline_value: baseline_fps,
                        current_value: current_fps,
                        change_percent: fps_change,
                    });
                } else if fps_change > 5.0 {
                    improvements.push(Improvement {
                        test_id: current_test.test_id.clone(),
                        metric: "effective_fps".to_string(),
                        baseline_value: baseline_fps,
                        current_value: current_fps,
                        change_percent: fps_change,
                    });
                }
            }

            let current_drop = current_test.avg_drop_rate();
            let baseline_drop = baseline_test.avg_drop_rate();

            if current_drop > baseline_drop + 0.5 {
                regressions.push(Regression {
                    test_id: current_test.test_id.clone(),
                    metric: "drop_rate".to_string(),
                    baseline_value: baseline_drop,
                    current_value: current_drop,
                    change_percent: if baseline_drop > 0.0 {
                        (current_drop - baseline_drop) / baseline_drop * 100.0
                    } else {
                        100.0
                    },
                });
            } else if current_drop < baseline_drop - 0.5 {
                improvements.push(Improvement {
                    test_id: current_test.test_id.clone(),
                    metric: "drop_rate".to_string(),
                    baseline_value: baseline_drop,
                    current_value: current_drop,
                    change_percent: if baseline_drop > 0.0 {
                        (current_drop - baseline_drop) / baseline_drop * 100.0
                    } else {
                        -100.0
                    },
                });
            }
        }
    }

    ComparisonResult {
        current_summary: current.summary.clone(),
        baseline_summary: baseline.summary.clone(),
        regressions,
        improvements,
    }
}
