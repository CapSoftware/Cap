use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::error;

use crate::diagnostics::SystemDiagnostics;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct ErrorContext {
    pub error_type: String,
    pub error_message: String,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    #[specta(type = Option<i64>)]
    pub timestamp: Option<chrono::DateTime<chrono::Utc>>,
    pub component: String,
    pub device_context: Option<DeviceContext>,
    pub system_diagnostics: Option<SystemDiagnostics>,
    pub stack_trace: Option<String>,
    pub performance_metrics: Option<PerformanceMetrics>,
    pub ffmpeg_details: Option<FfmpegErrorDetails>,
    pub additional_data: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DeviceContext {
    pub device_type: String,
    pub device_name: Option<String>,
    pub device_id: Option<String>,
    pub format: Option<String>,
    pub configuration: HashMap<String, serde_json::Value>,
    pub initialization_time_ms: Option<u64>,
    pub frame_count: Option<u64>,
    #[serde(with = "chrono::serde::ts_seconds_option")]
    #[specta(type = Option<i64>)]
    pub last_frame_timestamp: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct PerformanceMetrics {
    pub frame_drop_count: u64,
    pub average_fps: f32,
    pub audio_video_sync_offset_ms: Option<f32>,
    pub encoding_lag_ms: Option<f32>,
    pub capture_to_preview_lag_ms: Option<f32>,
    pub memory_usage_mb: Option<u64>,
    pub cpu_usage_percent: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct FfmpegErrorDetails {
    pub command: String,
    pub exit_code: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: Option<String>,
    pub detected_issue: Option<String>,
}

impl ErrorContext {
    pub fn new(
        error_type: impl Into<String>,
        message: impl Into<String>,
        component: impl Into<String>,
    ) -> Self {
        Self {
            error_type: error_type.into(),
            error_message: message.into(),
            timestamp: Some(chrono::Utc::now()),
            component: component.into(),
            device_context: None,
            system_diagnostics: None,
            stack_trace: None,
            performance_metrics: None,
            ffmpeg_details: None,
            additional_data: HashMap::new(),
        }
    }

    pub fn with_device_context(mut self, device: DeviceContext) -> Self {
        self.device_context = Some(device);
        self
    }

    pub fn with_performance_metrics(mut self, metrics: PerformanceMetrics) -> Self {
        self.performance_metrics = Some(metrics);
        self
    }

    pub fn with_ffmpeg_details(mut self, details: FfmpegErrorDetails) -> Self {
        self.ffmpeg_details = Some(details);
        self
    }

    pub fn with_stack_trace(mut self) -> Self {
        // Capture the current stack trace
        let backtrace = std::backtrace::Backtrace::capture();
        self.stack_trace = Some(format!("{:?}", backtrace));
        self
    }

    pub fn add_data(mut self, key: impl Into<String>, value: serde_json::Value) -> Self {
        self.additional_data.insert(key.into(), value);
        self
    }

    pub async fn capture_full_context(mut self) -> Self {
        // Capture system diagnostics if not already present
        if self.system_diagnostics.is_none() {
            if let Ok(diagnostics) = SystemDiagnostics::collect().await {
                self.system_diagnostics = Some(diagnostics);
            }
        }
        self
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub async fn report(&self) {
        // Log the error context
        error!("Error occurred: {}", self.error_type);
        error!("Component: {}", self.component);
        error!("Message: {}", self.error_message);

        if let Some(device) = &self.device_context {
            error!(
                "Device: {} ({}) - Format: {}",
                device
                    .device_name
                    .as_ref()
                    .unwrap_or(&"Unknown".to_string()),
                device.device_type,
                device.format.as_ref().unwrap_or(&"Unknown".to_string())
            );

            if let Some(lag) = device.initialization_time_ms {
                if lag > 2000 {
                    error!("WARNING: Device initialization took {}ms (>2s)", lag);
                }
            }
        }

        if let Some(metrics) = &self.performance_metrics {
            if metrics.frame_drop_count > 0 {
                error!("Frame drops detected: {}", metrics.frame_drop_count);
            }

            if let Some(sync_offset) = metrics.audio_video_sync_offset_ms {
                if sync_offset.abs() > 40.0 {
                    error!("Audio/Video sync issue: {}ms offset", sync_offset);
                }
            }

            if let Some(preview_lag) = metrics.capture_to_preview_lag_ms {
                if preview_lag > 100.0 {
                    error!("Preview lag detected: {}ms", preview_lag);
                }
            }
        }

        if let Some(ffmpeg) = &self.ffmpeg_details {
            error!("FFmpeg command: {}", ffmpeg.command);
            if let Some(stderr) = &ffmpeg.stderr {
                error!("FFmpeg stderr: {}", stderr);
            }
            if let Some(issue) = &ffmpeg.detected_issue {
                error!("Detected issue: {}", issue);
            }
        }

        // Save to file for later analysis
        let timestamp = self
            .timestamp
            .as_ref()
            .map(|t| t.format("%Y%m%d_%H%M%S").to_string())
            .unwrap_or_default();
        let filename = format!("error_report_{}_{}.json", self.component, timestamp);

        if let Ok(json) = self.to_json() {
            let error_dir = std::path::Path::new("error_reports");
            if !error_dir.exists() {
                let _ = std::fs::create_dir_all(error_dir);
            }

            let path = error_dir.join(filename);
            if let Err(e) = std::fs::write(&path, json) {
                error!("Failed to write error report: {:?}", e);
            } else {
                error!("Error report saved to: {:?}", path);
            }
        }

        // If Sentry is configured, send the error
        #[cfg(feature = "sentry")]
        self.send_to_sentry();
    }

    #[cfg(feature = "sentry")]
    fn send_to_sentry(&self) {
        sentry::configure_scope(|scope| {
            scope.set_tag("component", &self.component);
            scope.set_tag("error_type", &self.error_type);

            if let Some(device) = &self.device_context {
                scope.set_tag("device_type", &device.device_type);
                if let Some(name) = &device.device_name {
                    scope.set_tag("device_name", name);
                }
            }

            if let Some(metrics) = &self.performance_metrics {
                scope.set_extra("frame_drops", metrics.frame_drop_count.into());
                if let Some(sync) = metrics.audio_video_sync_offset_ms {
                    scope.set_extra("av_sync_offset_ms", sync.into());
                }
            }

            if let Some(diagnostics) = &self.system_diagnostics {
                scope.set_context(
                    "system",
                    sentry::protocol::Context::Other(
                        serde_json::to_value(diagnostics)
                            .unwrap_or_default()
                            .as_object()
                            .unwrap()
                            .clone(),
                    ),
                );
            }
        });

        sentry::capture_message(&self.error_message, sentry::Level::Error);
    }
}

// Helper function to detect FFmpeg issues from stderr
impl FfmpegErrorDetails {
    pub fn analyze_stderr(&mut self) {
        if let Some(stderr) = &self.stderr {
            let stderr_lower = stderr.to_lowercase();

            if stderr_lower.contains("no such filter") {
                self.detected_issue = Some(
                    "Missing FFmpeg filter. May need to rebuild FFmpeg with additional filters."
                        .to_string(),
                );
            } else if stderr_lower.contains("invalid argument") {
                self.detected_issue =
                    Some("Invalid FFmpeg argument. Check format compatibility.".to_string());
            } else if stderr_lower.contains("permission denied") {
                self.detected_issue =
                    Some("Permission denied. Check file/device access rights.".to_string());
            } else if stderr_lower.contains("device or resource busy") {
                self.detected_issue = Some(
                    "Device busy. Another application may be using the camera/microphone."
                        .to_string(),
                );
            } else if stderr_lower.contains("no such device") {
                self.detected_issue =
                    Some("Device not found. Device may have been disconnected.".to_string());
            } else if stderr_lower.contains("cannot find a valid device") {
                self.detected_issue =
                    Some("No valid capture device found. Check device availability.".to_string());
            } else if stderr_lower.contains("codec") && stderr_lower.contains("not found") {
                self.detected_issue =
                    Some("Codec not found. FFmpeg may need additional codec support.".to_string());
            } else if stderr_lower.contains("out of memory") {
                self.detected_issue = Some(
                    "Out of memory. Close other applications or reduce resolution.".to_string(),
                );
            }
        }
    }
}

// Convenience macros for error reporting
#[macro_export]
macro_rules! report_device_error {
    ($error_type:expr, $message:expr, $component:expr, $device:expr) => {{
        use $crate::error_context::{DeviceContext, ErrorContext};

        let context = ErrorContext::new($error_type, $message, $component)
            .with_device_context($device)
            .with_stack_trace();

        tokio::spawn(async move {
            context.capture_full_context().await.report().await;
        });
    }};
}

#[macro_export]
macro_rules! report_sync_error {
    ($component:expr, $metrics:expr) => {{
        use $crate::error_context::{ErrorContext, PerformanceMetrics};

        let context = ErrorContext::new(
            "SyncError",
            "Audio/Video synchronization issue detected",
            $component,
        )
        .with_performance_metrics($metrics)
        .with_stack_trace();

        tokio::spawn(async move {
            context.capture_full_context().await.report().await;
        });
    }};
}

#[macro_export]
macro_rules! report_ffmpeg_error {
    ($component:expr, $command:expr, $exit_code:expr, $stdout:expr, $stderr:expr) => {{
        use $crate::error_context::{ErrorContext, FfmpegErrorDetails};

        let mut details = FfmpegErrorDetails {
            command: $command,
            exit_code: $exit_code,
            stdout: $stdout,
            stderr: $stderr.clone(),
            detected_issue: None,
        };

        details.analyze_stderr();

        let context = ErrorContext::new(
            "FfmpegError",
            &format!("FFmpeg process failed with exit code {:?}", $exit_code),
            $component,
        )
        .with_ffmpeg_details(details)
        .with_stack_trace();

        tokio::spawn(async move {
            context.capture_full_context().await.report().await;
        });
    }};
}
