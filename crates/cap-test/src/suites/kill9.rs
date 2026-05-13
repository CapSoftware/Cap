use anyhow::{Context, Result};
use chrono::Utc;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tracing::{info, warn};

use crate::discovery::DiscoveredHardware;
use crate::results::{
    DisplayTestConfig, FrameMetrics, IterationResult, LatencyMetrics, ResultsMeta, ResultsSummary,
    TestCaseConfig, TestResult, TestResults,
};

use super::ffprobe_ext::verify_playable;
use super::recording_helpers::materialize_display_outputs;

const READY_POLL_INTERVAL: Duration = Duration::from_millis(200);
const READY_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn run_suite(hardware: &DiscoveredHardware, duration: u64) -> Result<TestResults> {
    let start = Instant::now();
    let mut results = Vec::new();

    let primary_display = hardware
        .displays
        .iter()
        .find(|d| d.is_primary)
        .or_else(|| hardware.displays.first());

    let Some(display) = primary_display else {
        warn!("No display available - skipping kill9 crash test suite");
        return Ok(empty_results(hardware, start.elapsed()));
    };

    let target_fps = 30u32;
    let duration_secs = duration.max(5);

    let test_config = TestCaseConfig {
        display: Some(DisplayTestConfig {
            width: display.physical_width,
            height: display.physical_height,
            fps: target_fps,
            display_id: Some(display.id.clone()),
        }),
        camera: None,
        audio: None,
        duration_secs,
    };

    let mut result = TestResult::new(
        format!("kill9-crash-{}-{}s", display.id, duration_secs),
        format!(
            "SIGKILL mid-recording crash recovery {} @{}fps",
            display.resolution_label(),
            target_fps
        ),
        test_config,
    );

    match run_single_kill9(&display.id, target_fps, duration_secs).await {
        Ok(report) => {
            info!(
                "Kill9 scenario: recovered_segments={} total_duration_secs={:.2} playable={}",
                report.recovered_segment_count, report.total_duration_secs, report.playable,
            );

            if !report.playable {
                result.set_failed(&format!(
                    "Recovered recording not playable: {}",
                    report.failure_reason.unwrap_or_default()
                ));
            } else if report.total_duration_secs < (duration_secs as f64 * 0.5) {
                result.set_failed(&format!(
                    "Recovered duration {:.2}s below 50% of wall-clock {}s",
                    report.total_duration_secs, duration_secs
                ));
            }

            let iteration = IterationResult {
                iteration: 0,
                duration_secs: report.total_duration_secs,
                frames: FrameMetrics {
                    received: 0,
                    encoded: 0,
                    dropped: 0,
                    drop_rate_percent: 0.0,
                    effective_fps: 0.0,
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
                av_sync_ms: None,
                errors: vec![],
            };
            result.add_iteration(iteration);
        }
        Err(err) => {
            warn!("kill9 scenario harness failed: {err}");
            result.set_error(&err.to_string());
        }
    }

    results.push(result);

    Ok(TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Kill9 Crash Suite".to_string(),
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

struct Kill9Report {
    recovered_segment_count: usize,
    total_duration_secs: f64,
    playable: bool,
    failure_reason: Option<String>,
}

async fn run_single_kill9(
    display_id: &str,
    target_fps: u32,
    kill_after_secs: u64,
) -> Result<Kill9Report> {
    let temp_dir = TempDir::new()?;
    let project_path = temp_dir.path().join("kill9-project");
    std::fs::create_dir_all(&project_path)?;

    let ready_file = temp_dir.path().join("harness-ready.flag");
    let cap_test_bin = std::env::current_exe().context("failed to resolve current exe path")?;

    let mut child = Command::new(&cap_test_bin)
        .arg("record-harness")
        .arg("--output")
        .arg(&project_path)
        .arg("--ready-file")
        .arg(&ready_file)
        .arg("--display")
        .arg(display_id)
        .arg("--fps")
        .arg(target_fps.to_string())
        .arg("--max-duration")
        .arg((kill_after_secs * 10).to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to spawn record-harness child process")?;

    let child_pid = child.id() as i32;
    info!(
        "Spawned record-harness child pid={child_pid} at {}",
        project_path.display()
    );

    let ready = wait_for_ready(&ready_file, READY_WAIT_TIMEOUT).await;

    if !ready {
        let _ = child.kill();
        let _ = child.wait();
        anyhow::bail!(
            "record-harness child never signaled ready within {:?}",
            READY_WAIT_TIMEOUT
        );
    }

    tokio::time::sleep(Duration::from_secs(kill_after_secs)).await;

    info!("Sending SIGKILL to record-harness child pid={child_pid}");
    send_sigkill(child_pid)?;

    let exit_status = child
        .wait()
        .context("failed waiting for record-harness child")?;
    info!("record-harness child exited: {exit_status:?}");

    let outputs = materialize_display_outputs(&project_path)?;
    if outputs.is_empty() {
        return Ok(Kill9Report {
            recovered_segment_count: 0,
            total_duration_secs: 0.0,
            playable: false,
            failure_reason: Some("no display.mp4 produced after recovery".to_string()),
        });
    }

    let mut total_duration = 0.0f64;
    let mut playable = true;
    let mut failure_reason: Option<String> = None;

    for output in &outputs {
        match verify_playable(output) {
            Ok(()) => {
                if let Ok(stats) = super::ffprobe_ext::probe_stream_stats(output) {
                    total_duration += stats
                        .video_duration_secs
                        .or(stats.container_duration_secs)
                        .unwrap_or(0.0);
                }
            }
            Err(err) => {
                playable = false;
                failure_reason = Some(format!("{}: {}", output.display(), err));
            }
        }
    }

    Ok(Kill9Report {
        recovered_segment_count: outputs.len(),
        total_duration_secs: total_duration,
        playable,
        failure_reason,
    })
}

async fn wait_for_ready(ready_file: &Path, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if ready_file.exists() {
            return true;
        }
        tokio::time::sleep(READY_POLL_INTERVAL).await;
    }
    false
}

#[cfg(unix)]
fn send_sigkill(pid: i32) -> Result<()> {
    let result = unsafe { libc::kill(pid, libc::SIGKILL) };
    if result != 0 {
        let err = std::io::Error::last_os_error();
        anyhow::bail!("kill(pid={pid}, SIGKILL) failed: {err}");
    }
    Ok(())
}

#[cfg(windows)]
fn send_sigkill(pid: i32) -> Result<()> {
    let output = Command::new("taskkill")
        .args(["/F", "/T", "/PID"])
        .arg(pid.to_string())
        .output()
        .context("failed to invoke taskkill")?;
    if !output.status.success() {
        anyhow::bail!(
            "taskkill /F failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(())
}

fn empty_results(hardware: &DiscoveredHardware, elapsed: Duration) -> TestResults {
    TestResults {
        meta: ResultsMeta {
            timestamp: Utc::now(),
            config_name: "Kill9 Crash Suite".to_string(),
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

pub struct RecordHarnessArgs {
    pub output: PathBuf,
    pub ready_file: Option<PathBuf>,
    pub display_id: Option<String>,
    pub fps: u32,
    pub max_duration_secs: u64,
    pub include_mic: bool,
    pub include_system_audio: bool,
}

pub async fn run_record_harness(args: RecordHarnessArgs) -> Result<()> {
    use super::recording_helpers::{StudioRecordingOptions, record_studio_at_path};

    if !args.output.exists() {
        std::fs::create_dir_all(&args.output)?;
    }

    if let Some(ready_file) = args.ready_file.as_ref() {
        spawn_ready_signal_writer(ready_file.clone(), args.output.clone());
    }

    let opts = StudioRecordingOptions {
        display_id: args.display_id,
        target_fps: args.fps,
        duration: Duration::from_secs(args.max_duration_secs),
        include_mic: args.include_mic,
        include_system_audio: args.include_system_audio,
        fragmented: true,
    };

    info!(
        "record-harness: recording to {} for up to {}s",
        args.output.display(),
        args.max_duration_secs
    );

    let _ = record_studio_at_path(opts, args.output).await?;
    Ok(())
}

fn spawn_ready_signal_writer(ready_file: PathBuf, output_path: PathBuf) {
    tokio::spawn(async move {
        let segments_dir = output_path.join("content").join("segments");
        let start = Instant::now();
        loop {
            if start.elapsed() > Duration::from_secs(60) {
                warn!("record-harness: ready signal timed out waiting for segments dir");
                return;
            }

            if segments_dir.is_dir() {
                let has_fragment = std::fs::read_dir(&segments_dir)
                    .map(|entries| {
                        entries.filter_map(|e| e.ok()).any(|e| {
                            let path = e.path();
                            path.is_dir()
                                && path
                                    .join("display")
                                    .read_dir()
                                    .map(|frag_entries| frag_entries.count() > 0)
                                    .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false);

                if has_fragment && let Err(err) = std::fs::write(&ready_file, b"ready") {
                    warn!("record-harness: failed to write ready file: {err}");
                }
                if has_fragment {
                    return;
                }
            }

            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    });
}
