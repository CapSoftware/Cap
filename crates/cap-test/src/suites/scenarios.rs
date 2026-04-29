use anyhow::{Context, Result};
use colored::Colorize;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tempfile::TempDir;
use tracing::{info, warn};

use crate::config::{FailureClassification, ScenarioType, TestConfig};
use crate::discovery::DiscoveredHardware;
use crate::results::{ScenarioResult, TestStatus, ValidationResult};

pub struct ScenarioRunner {
    config: TestConfig,
    hardware: DiscoveredHardware,
    interactive: bool,
}

impl ScenarioRunner {
    pub fn new(config: TestConfig, hardware: DiscoveredHardware, interactive: bool) -> Self {
        Self {
            config,
            hardware,
            interactive,
        }
    }

    pub async fn run_all(&self) -> Vec<ScenarioResult> {
        let scenarios = &self.config.scenarios.scenarios;
        let mut results = Vec::new();

        for scenario in scenarios {
            let result = self.run_scenario(scenario).await;
            results.push(result);
        }

        results
    }

    async fn run_scenario(&self, scenario: &ScenarioType) -> ScenarioResult {
        let scenario_id = format!("scenario-{}", scenario_id_str(scenario));
        let scenario_name = scenario.display_name().to_string();
        let related_task = scenario.related_task().to_string();
        let requires_interactive = scenario.requires_interactive();

        if requires_interactive && !self.interactive {
            return ScenarioResult {
                scenario_id,
                scenario_name,
                related_task,
                status: TestStatus::Skip,
                interactive_required: true,
                failure_reason: Some(
                    "Requires --interactive mode for operator-guided testing".to_string(),
                ),
                failure_classification: None,
                duration_secs: 0.0,
                validation: None,
                notes: vec![format!(
                    "Run with --interactive to execute this scenario (validates {})",
                    scenario.related_task()
                )],
            };
        }

        info!(
            "Running scenario: {} ({})",
            scenario_name,
            scenario.related_task()
        );

        let start = Instant::now();

        let run_result = match scenario {
            ScenarioType::MicDisconnectReconnect => self.run_mic_disconnect_scenario().await,
            ScenarioType::CameraDisconnectReconnect => self.run_camera_disconnect_scenario().await,
            ScenarioType::DisplayResolutionChange => {
                self.run_display_resolution_change_scenario().await
            }
            ScenarioType::SystemAudioDeviceSwitch => self.run_system_audio_switch_scenario().await,
            ScenarioType::CaptureSourceRestart => self.run_capture_restart_scenario().await,
            ScenarioType::MultiMonitorRecording => self.run_multi_monitor_scenario().await,
            ScenarioType::LongDurationStability => self.run_long_duration_scenario().await,
            ScenarioType::AllDevicesCombined => self.run_all_devices_combined_scenario().await,
        };

        let duration = start.elapsed();

        match run_result {
            Ok(validation) => {
                let (status, failure_reason, classification) =
                    classify_scenario_result(&validation);

                ScenarioResult {
                    scenario_id,
                    scenario_name,
                    related_task,
                    status,
                    interactive_required: requires_interactive,
                    failure_reason,
                    failure_classification: classification,
                    duration_secs: duration.as_secs_f64(),
                    validation: Some(validation),
                    notes: Vec::new(),
                }
            }
            Err(e) => {
                let classification =
                    if e.to_string().contains("panic") || e.to_string().contains("panicked") {
                        FailureClassification::Panic
                    } else if e.to_string().contains("Failed to start")
                        || e.to_string().contains("Failed to stop")
                    {
                        FailureClassification::UnrecoverableStop
                    } else {
                        FailureClassification::ValidationError
                    };

                ScenarioResult {
                    scenario_id,
                    scenario_name,
                    related_task,
                    status: TestStatus::Error,
                    interactive_required: requires_interactive,
                    failure_reason: Some(e.to_string()),
                    failure_classification: Some(classification),
                    duration_secs: duration.as_secs_f64(),
                    validation: None,
                    notes: Vec::new(),
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_recording_scenario(
        &self,
        description: &str,
        duration_secs: u64,
        with_camera: bool,
        with_mic: bool,
        with_system_audio: bool,
        pre_action: Option<&str>,
        mid_action: Option<(&str, u64)>,
    ) -> Result<ValidationResult> {
        use cap_recording::{
            CameraFeed, MicrophoneFeed, screen_capture::ScreenCaptureTarget, studio_recording,
        };
        use cpal::StreamError;
        use kameo::Actor as _;
        use scap_targets::Display;

        let temp_dir = TempDir::new()?;
        let output_path = temp_dir.path().to_path_buf();

        info!("Scenario [{}]: setting up recording", description);

        let display = Display::primary();
        let (error_tx, _error_rx) = flume::bounded::<StreamError>(16);

        #[cfg(target_os = "macos")]
        let shareable_content = cidre::sc::ShareableContent::current()
            .await
            .context("Failed to get shareable content")
            .map(cap_recording::SendableShareableContent::from)?;

        let mic_lock = if with_mic {
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
                warn!("Scenario [{}]: no microphone available", description);
                None
            }
        } else {
            None
        };

        let camera_lock = if with_camera {
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
                warn!("Scenario [{}]: no camera available", description);
                None
            }
        } else {
            None
        };

        let mut builder = studio_recording::Actor::builder(
            output_path.clone(),
            ScreenCaptureTarget::Display { id: display.id() },
        )
        .with_max_fps(30)
        .with_fragmented(true)
        .with_system_audio(with_system_audio);

        if let Some(mic) = mic_lock {
            builder = builder.with_mic_feed(mic);
        }

        if let Some(camera) = camera_lock {
            builder = builder.with_camera_feed(camera);
        }

        if let Some(action) = pre_action {
            prompt_operator(action);
        }

        info!("Scenario [{}]: starting recording", description);

        let handle = builder
            .build(
                #[cfg(target_os = "macos")]
                Some(shareable_content),
            )
            .await
            .context("Failed to start recording")?;

        if let Some((action, delay_secs)) = mid_action {
            let pre_delay = Duration::from_secs(delay_secs.min(duration_secs / 2));
            tokio::time::sleep(pre_delay).await;

            prompt_operator(action);

            let remaining = Duration::from_secs(duration_secs).saturating_sub(pre_delay);
            tokio::time::sleep(remaining).await;
        } else {
            tokio::time::sleep(Duration::from_secs(duration_secs)).await;
        }

        info!("Scenario [{}]: stopping recording", description);
        let completed = handle.stop().await.context("Failed to stop recording")?;

        info!(
            "Scenario [{}]: validating output at {}",
            description,
            completed.project_path.display()
        );
        let validation = super::validate::validate_recording(&completed.project_path).await?;

        Ok(validation)
    }

    async fn run_mic_disconnect_scenario(&self) -> Result<ValidationResult> {
        let has_mic = !self.hardware.audio_inputs.is_empty();
        if !has_mic {
            return Ok(skip_validation(
                "No microphone available for disconnect test",
            ));
        }

        self.run_recording_scenario(
            "mic-disconnect-reconnect",
            self.config.scenarios.duration_secs,
            false,
            true,
            false,
            None,
            Some((
                "DISCONNECT the microphone now, wait 3 seconds, then RECONNECT it",
                5,
            )),
        )
        .await
    }

    async fn run_camera_disconnect_scenario(&self) -> Result<ValidationResult> {
        let has_camera = !self.hardware.cameras.is_empty();
        if !has_camera {
            return Ok(skip_validation("No camera available for disconnect test"));
        }

        self.run_recording_scenario(
            "camera-disconnect-reconnect",
            self.config.scenarios.duration_secs,
            true,
            false,
            false,
            None,
            Some((
                "DISCONNECT the camera now, wait 3 seconds, then RECONNECT it",
                5,
            )),
        )
        .await
    }

    async fn run_display_resolution_change_scenario(&self) -> Result<ValidationResult> {
        self.run_recording_scenario(
            "display-resolution-change",
            self.config.scenarios.duration_secs,
            false,
            false,
            false,
            None,
            Some((
                "CHANGE the display resolution now (System Preferences > Displays), wait 3 seconds, then change it back",
                5,
            )),
        )
        .await
    }

    async fn run_system_audio_switch_scenario(&self) -> Result<ValidationResult> {
        self.run_recording_scenario(
            "system-audio-device-switch",
            self.config.scenarios.duration_secs,
            false,
            false,
            true,
            None,
            Some((
                "SWITCH the system audio output device now (e.g., plug in headphones or switch to Bluetooth speaker)",
                5,
            )),
        )
        .await
    }

    async fn run_capture_restart_scenario(&self) -> Result<ValidationResult> {
        self.run_recording_scenario(
            "capture-source-restart",
            self.config.scenarios.duration_secs,
            false,
            false,
            false,
            None,
            Some((
                "Trigger a capture restart: PUT THE DISPLAY TO SLEEP for 2 seconds, then wake it (press a key or move mouse)",
                5,
            )),
        )
        .await
    }

    async fn run_multi_monitor_scenario(&self) -> Result<ValidationResult> {
        if self.hardware.displays.len() < 2 {
            return Ok(skip_validation(
                "Only one display detected; multi-monitor test requires 2+ displays",
            ));
        }

        self.run_recording_scenario(
            "multi-monitor-recording",
            self.config.scenarios.duration_secs,
            false,
            false,
            false,
            None,
            None,
        )
        .await
    }

    async fn run_long_duration_scenario(&self) -> Result<ValidationResult> {
        let long_duration = self.config.scenarios.duration_secs.max(60);

        self.run_recording_scenario(
            "long-duration-stability",
            long_duration,
            false,
            true,
            true,
            None,
            None,
        )
        .await
    }

    async fn run_all_devices_combined_scenario(&self) -> Result<ValidationResult> {
        let has_mic = !self.hardware.audio_inputs.is_empty();
        let has_camera = !self.hardware.cameras.is_empty();

        self.run_recording_scenario(
            "all-devices-combined",
            self.config.scenarios.duration_secs,
            has_camera,
            has_mic,
            true,
            None,
            None,
        )
        .await
    }
}

fn scenario_id_str(scenario: &ScenarioType) -> &'static str {
    match scenario {
        ScenarioType::MicDisconnectReconnect => "mic-disconnect",
        ScenarioType::CameraDisconnectReconnect => "camera-disconnect",
        ScenarioType::DisplayResolutionChange => "display-resolution",
        ScenarioType::SystemAudioDeviceSwitch => "system-audio-switch",
        ScenarioType::CaptureSourceRestart => "capture-restart",
        ScenarioType::MultiMonitorRecording => "multi-monitor",
        ScenarioType::LongDurationStability => "long-duration",
        ScenarioType::AllDevicesCombined => "all-devices",
    }
}

fn prompt_operator(instruction: &str) {
    println!();
    println!(
        "{}",
        "╔══════════════════════════════════════════════════════╗"
            .bold()
            .yellow()
    );
    println!(
        "{}",
        "║           OPERATOR ACTION REQUIRED                  ║"
            .bold()
            .yellow()
    );
    println!(
        "{}",
        "╚══════════════════════════════════════════════════════╝"
            .bold()
            .yellow()
    );
    println!();
    println!("  {}", instruction.bold());
    println!();
    print!("  Press ENTER when done... ");
    std::io::stdout().flush().ok();
    let mut input = String::new();
    std::io::stdin().read_line(&mut input).ok();
    println!();
}

fn skip_validation(reason: &str) -> ValidationResult {
    ValidationResult {
        path: String::new(),
        valid: true,
        video_info: None,
        audio_info: None,
        sync_info: None,
        errors: Vec::new(),
        warnings: vec![reason.to_string()],
    }
}

fn classify_scenario_result(
    validation: &ValidationResult,
) -> (TestStatus, Option<String>, Option<FailureClassification>) {
    if validation.path.is_empty() && validation.warnings.len() == 1 {
        return (TestStatus::Skip, validation.warnings.first().cloned(), None);
    }

    if !validation.valid {
        let has_no_video = validation.video_info.is_none();
        let has_no_frames = validation
            .video_info
            .as_ref()
            .map(|v| v.frame_count == 0)
            .unwrap_or(false);
        let has_zero_duration = validation
            .video_info
            .as_ref()
            .map(|v| v.duration_secs <= 0.0)
            .unwrap_or(false);

        if has_no_video || has_no_frames || has_zero_duration {
            return (
                TestStatus::Fail,
                Some("Output is unplayable: no video frames produced".to_string()),
                Some(FailureClassification::UnplayableOutput),
            );
        }

        let reason = validation.errors.join("; ");
        return (
            TestStatus::Fail,
            Some(reason),
            Some(FailureClassification::ValidationError),
        );
    }

    if let Some(sync) = &validation.sync_info
        && !sync.in_sync
    {
        return (
            TestStatus::Fail,
            Some(format!("A/V drift too high: {:.1}ms", sync.drift_ms)),
            Some(FailureClassification::PerformanceBelowThreshold),
        );
    }

    (TestStatus::Pass, None, None)
}

pub fn classify_test_failure(result: &crate::results::TestResult) -> Option<FailureClassification> {
    if result.status == TestStatus::Pass || result.status == TestStatus::Skip {
        return None;
    }

    if let Some(reason) = &result.failure_reason {
        let reason_lower = reason.to_lowercase();
        if reason_lower.contains("panic") || reason_lower.contains("poisoned") {
            return Some(FailureClassification::Panic);
        }
        if reason_lower.contains("unrecoverable")
            || reason_lower.contains("fatal")
            || reason_lower.contains("failed to start")
            || reason_lower.contains("failed to stop")
        {
            return Some(FailureClassification::UnrecoverableStop);
        }
        if reason_lower.contains("unplayable")
            || reason_lower.contains("no video")
            || reason_lower.contains("no segments")
            || reason_lower.contains("corrupt")
        {
            return Some(FailureClassification::UnplayableOutput);
        }
    }

    for iteration in &result.iterations {
        if !iteration.errors.is_empty() {
            for err in &iteration.errors {
                let err_lower = err.to_lowercase();
                if err_lower.contains("panic") || err_lower.contains("poisoned") {
                    return Some(FailureClassification::Panic);
                }
            }
        }
    }

    if result.status == TestStatus::Error {
        return Some(FailureClassification::UnrecoverableStop);
    }

    Some(FailureClassification::PerformanceBelowThreshold)
}
