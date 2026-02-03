use colored::Colorize;

use super::types::{TestResults, TestStatus};

impl TestResults {
    pub fn print_summary(&self) {
        println!("\n{}", "=== Test Results Summary ===".bold().cyan());

        println!("\n{}", "Configuration:".bold());
        println!("  Name: {}", self.meta.config_name);
        println!("  Platform: {}", self.meta.platform);
        println!("  Timestamp: {}", self.meta.timestamp);

        println!("\n{}", "Results:".bold());
        let passed_str = format!("{} passed", self.summary.passed).green();
        let failed_str = if self.summary.failed > 0 {
            format!("{} failed", self.summary.failed).red()
        } else {
            format!("{} failed", self.summary.failed).normal()
        };
        let skipped_str = if self.summary.skipped > 0 {
            format!("{} skipped", self.summary.skipped).yellow()
        } else {
            format!("{} skipped", self.summary.skipped).normal()
        };
        let errors_str = if self.summary.errors > 0 {
            format!("{} errors", self.summary.errors).red().bold()
        } else {
            format!("{} errors", self.summary.errors).normal()
        };

        println!(
            "  {} | {} | {} | {} | {} total",
            passed_str, failed_str, skipped_str, errors_str, self.summary.total_tests
        );

        let pass_rate_color = if self.summary.pass_rate >= 95.0 {
            self.summary.pass_rate.to_string().green()
        } else if self.summary.pass_rate >= 80.0 {
            self.summary.pass_rate.to_string().yellow()
        } else {
            self.summary.pass_rate.to_string().red()
        };
        println!("  Pass Rate: {}%", pass_rate_color);
        println!("  Duration: {:.1}s", self.summary.duration_secs);

        let failed_tests: Vec<_> = self
            .results
            .iter()
            .filter(|r| r.status == TestStatus::Fail || r.status == TestStatus::Error)
            .collect();

        if !failed_tests.is_empty() {
            println!("\n{}", "Failed Tests:".red().bold());
            for test in failed_tests {
                let status_icon = match test.status {
                    TestStatus::Fail => "✗".red(),
                    TestStatus::Error => "!".red().bold(),
                    _ => "?".normal(),
                };
                println!("  {} {}", status_icon, test.name);
                if let Some(reason) = &test.failure_reason {
                    println!("    Reason: {}", reason.dimmed());
                }
            }
        }

        println!();
    }

    pub fn print_detailed_report(&self) {
        self.print_summary();

        println!("{}", "=== Detailed Results ===".bold().cyan());

        for test in &self.results {
            let status_str = match test.status {
                TestStatus::Pass => "PASS".green().bold(),
                TestStatus::Fail => "FAIL".red().bold(),
                TestStatus::Skip => "SKIP".yellow().bold(),
                TestStatus::Error => "ERROR".red().bold(),
            };

            println!("\n{} - {}", test.name.bold(), status_str);

            if let Some(display) = &test.config.display {
                println!(
                    "  Display: {}x{} @ {}fps",
                    display.width, display.height, display.fps
                );
            }
            if let Some(camera) = &test.config.camera {
                println!(
                    "  Camera: {}x{} @ {}fps",
                    camera.width, camera.height, camera.fps
                );
            }
            if let Some(audio) = &test.config.audio {
                println!("  Audio: {}Hz, {} ch", audio.sample_rate, audio.channels);
            }

            if !test.iterations.is_empty() {
                let avg_fps = test.avg_effective_fps();
                let avg_drop = test.avg_drop_rate();
                let avg_latency = test.avg_p95_latency();

                println!("  Performance ({} iterations):", test.iterations.len());
                println!("    Effective FPS: {:.1}", avg_fps);
                println!("    Drop Rate: {:.2}%", avg_drop);
                println!("    P95 Latency: {:.1}ms", avg_latency);

                let target_fps = test
                    .iterations
                    .first()
                    .map(|i| i.frames.target_fps)
                    .unwrap_or(30);
                let fps_ratio = avg_fps / target_fps as f64;

                let fps_status = if fps_ratio >= 0.95 {
                    "OK".green()
                } else if fps_ratio >= 0.85 {
                    "WARN".yellow()
                } else {
                    "LOW".red()
                };
                println!(
                    "    FPS Status: {} ({:.1}% of target)",
                    fps_status,
                    fps_ratio * 100.0
                );
            }

            if let Some(reason) = &test.failure_reason {
                println!("  {}: {}", "Failure".red(), reason);
            }

            for note in &test.notes {
                println!("  Note: {}", note.dimmed());
            }
        }

        println!();
    }
}
