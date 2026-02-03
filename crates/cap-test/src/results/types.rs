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
