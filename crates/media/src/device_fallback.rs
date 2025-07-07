use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::{error, info, warn};

use crate::{
    error_context::{DeviceContext, ErrorContext},
    MediaError,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceFallbackConfig {
    pub video_fallbacks: VideoFallbackStrategy,
    pub audio_fallbacks: AudioFallbackStrategy,
    pub max_retry_attempts: u32,
    pub retry_delay_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFallbackStrategy {
    pub preferred_formats: Vec<VideoFormatConfig>,
    pub allow_resolution_downgrade: bool,
    pub allow_fps_downgrade: bool,
    pub min_acceptable_resolution: (u32, u32),
    pub min_acceptable_fps: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VideoFormatConfig {
    pub format: String,
    pub resolution: Option<(u32, u32)>,
    pub fps: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioFallbackStrategy {
    pub preferred_sample_rates: Vec<u32>,
    pub preferred_channels: Vec<u16>,
    pub allow_sample_rate_conversion: bool,
    pub allow_channel_downmix: bool,
}

impl Default for DeviceFallbackConfig {
    fn default() -> Self {
        Self {
            video_fallbacks: VideoFallbackStrategy {
                preferred_formats: vec![
                    VideoFormatConfig {
                        format: "BGRA".to_string(),
                        resolution: Some((1920, 1080)),
                        fps: Some(30),
                    },
                    VideoFormatConfig {
                        format: "RGB24".to_string(),
                        resolution: Some((1280, 720)),
                        fps: Some(30),
                    },
                    VideoFormatConfig {
                        format: "YUYV422".to_string(),
                        resolution: Some((640, 480)),
                        fps: Some(30),
                    },
                ],
                allow_resolution_downgrade: true,
                allow_fps_downgrade: true,
                min_acceptable_resolution: (640, 480),
                min_acceptable_fps: 15,
            },
            audio_fallbacks: AudioFallbackStrategy {
                preferred_sample_rates: vec![48000, 44100, 32000, 16000],
                preferred_channels: vec![2, 1],
                allow_sample_rate_conversion: true,
                allow_channel_downmix: true,
            },
            max_retry_attempts: 3,
            retry_delay_ms: 500,
        }
    }
}

pub struct DeviceFallbackManager {
    config: DeviceFallbackConfig,
    attempt_history: HashMap<String, Vec<FailedAttempt>>,
}

#[derive(Debug, Clone)]
struct FailedAttempt {
    device_id: String,
    config_tried: String,
    error: String,
    timestamp: chrono::DateTime<chrono::Utc>,
}

impl DeviceFallbackManager {
    pub fn new(config: Option<DeviceFallbackConfig>) -> Self {
        Self {
            config: config.unwrap_or_default(),
            attempt_history: HashMap::new(),
        }
    }

    pub async fn try_video_device_with_fallback<F, T>(
        &mut self,
        device_name: &str,
        device_id: &str,
        mut try_fn: F,
    ) -> Result<T, MediaError>
    where
        F: FnMut(VideoFormatConfig) -> Result<T, MediaError>,
    {
        let device_key = format!("video_{}", device_id);
        let mut attempts = 0;

        for format_config in &self.config.video_fallbacks.preferred_formats {
            if attempts >= self.config.max_retry_attempts {
                break;
            }

            attempts += 1;
            info!(
                "Attempting video device '{}' with format: {:?} (attempt {}/{})",
                device_name, format_config, attempts, self.config.max_retry_attempts
            );

            match try_fn(format_config.clone()) {
                Ok(result) => {
                    info!(
                        "Successfully initialized video device '{}' with format: {:?}",
                        device_name, format_config
                    );
                    return Ok(result);
                }
                Err(e) => {
                    warn!(
                        "Failed to initialize video device '{}' with format {:?}: {}",
                        device_name, format_config, e
                    );

                    // Record the failed attempt
                    let failed_attempt = FailedAttempt {
                        device_id: device_id.to_string(),
                        config_tried: format!("{:?}", format_config),
                        error: e.to_string(),
                        timestamp: chrono::Utc::now(),
                    };

                    self.attempt_history
                        .entry(device_key.clone())
                        .or_insert_with(Vec::new)
                        .push(failed_attempt);

                    // Report the error with context
                    let device_context = DeviceContext {
                        device_type: "video".to_string(),
                        device_name: Some(device_name.to_string()),
                        device_id: Some(device_id.to_string()),
                        format: Some(format!("{:?}", format_config)),
                        configuration: HashMap::new(),
                        initialization_time_ms: None,
                        frame_count: None,
                        last_frame_timestamp: None,
                    };

                    ErrorContext::new("VideoDeviceInitFailed", &e.to_string(), "device_fallback")
                        .with_device_context(device_context)
                        .add_data("attempt", serde_json::json!(attempts))
                        .add_data(
                            "format_config",
                            serde_json::to_value(format_config).unwrap(),
                        )
                        .report()
                        .await;

                    // Wait before next attempt
                    if attempts < self.config.max_retry_attempts {
                        tokio::time::sleep(tokio::time::Duration::from_millis(
                            self.config.retry_delay_ms,
                        ))
                        .await;
                    }
                }
            }
        }

        // All fallback attempts failed
        error!(
            "All fallback attempts failed for video device '{}' ({})",
            device_name, device_id
        );

        Err(MediaError::DeviceUnreachable(format!(
            "Failed to initialize video device '{}' after {} attempts",
            device_name, attempts
        )))
    }

    pub async fn try_audio_device_with_fallback<F, T>(
        &mut self,
        device_name: &str,
        mut try_fn: F,
    ) -> Result<T, MediaError>
    where
        F: FnMut(u32, u16) -> Result<T, MediaError>,
    {
        let device_key = format!("audio_{}", device_name);
        let mut attempts = 0;

        for sample_rate in &self.config.audio_fallbacks.preferred_sample_rates {
            for channels in &self.config.audio_fallbacks.preferred_channels {
                if attempts >= self.config.max_retry_attempts {
                    break;
                }

                attempts += 1;
                info!(
                    "Attempting audio device '{}' with {}Hz, {} channels (attempt {}/{})",
                    device_name, sample_rate, channels, attempts, self.config.max_retry_attempts
                );

                match try_fn(*sample_rate, *channels) {
                    Ok(result) => {
                        info!(
                            "Successfully initialized audio device '{}' with {}Hz, {} channels",
                            device_name, sample_rate, channels
                        );
                        return Ok(result);
                    }
                    Err(e) => {
                        warn!(
                            "Failed to initialize audio device '{}' with {}Hz, {} channels: {}",
                            device_name, sample_rate, channels, e
                        );

                        // Record the failed attempt
                        let failed_attempt = FailedAttempt {
                            device_id: device_name.to_string(),
                            config_tried: format!("{}Hz, {} channels", sample_rate, channels),
                            error: e.to_string(),
                            timestamp: chrono::Utc::now(),
                        };

                        self.attempt_history
                            .entry(device_key.clone())
                            .or_insert_with(Vec::new)
                            .push(failed_attempt);

                        // Wait before next attempt
                        if attempts < self.config.max_retry_attempts {
                            tokio::time::sleep(tokio::time::Duration::from_millis(
                                self.config.retry_delay_ms,
                            ))
                            .await;
                        }
                    }
                }
            }
        }

        // All fallback attempts failed
        error!(
            "All fallback attempts failed for audio device '{}'",
            device_name
        );

        Err(MediaError::DeviceUnreachable(format!(
            "Failed to initialize audio device '{}' after {} attempts",
            device_name, attempts
        )))
    }

    pub fn get_failure_history(&self, device_type: &str, device_id: &str) -> Vec<FailedAttempt> {
        let key = format!("{}_{}", device_type, device_id);
        self.attempt_history.get(&key).cloned().unwrap_or_default()
    }
}
