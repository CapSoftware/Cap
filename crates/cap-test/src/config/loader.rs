use anyhow::{Context, Result};
use std::path::Path;

use super::types::*;

impl TestConfig {
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)
            .with_context(|| format!("Failed to read config file: {}", path.display()))?;

        toml::from_str(&content)
            .with_context(|| format!("Failed to parse config file: {}", path.display()))
    }

    pub fn standard() -> Self {
        Self {
            meta: MetaConfig {
                name: "Standard Hardware Matrix".to_string(),
                description: "Tests common hardware configurations".to_string(),
            },
            recording: RecordingConfig {
                duration_secs: 10,
                warmup_secs: 2,
                iterations: 3,
            },
            displays: DisplayConfig {
                resolutions: vec![
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(2560, 1440, "1440p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                    ResolutionPreset::new(3024, 1964, "MBP-14"),
                    ResolutionPreset::new(3456, 2234, "MBP-16"),
                ],
                frame_rates: vec![30, 60],
                use_discovered: true,
            },
            cameras: CameraConfig {
                resolutions: vec![
                    ResolutionPreset::new(640, 480, "VGA"),
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                ],
                frame_rates: vec![24, 30, 60],
                pixel_formats: vec![
                    "NV12".to_string(),
                    "YUYV422".to_string(),
                    "MJPEG".to_string(),
                ],
                enabled: true,
            },
            audio: AudioConfig {
                microphones: MicrophoneConfig {
                    sample_rates: vec![16000, 44100, 48000, 96000],
                    channels: vec![1, 2],
                    include_bluetooth: true,
                    include_usb: true,
                    include_builtin: true,
                    enabled: true,
                },
                system: SystemAudioConfig {
                    enabled: true,
                    sample_rates: vec![44100, 48000],
                },
            },
            thresholds: ThresholdConfig::default(),
            scenarios: ScenarioConfig::default(),
        }
    }

    pub fn quick() -> Self {
        Self {
            meta: MetaConfig {
                name: "Quick Smoke Tests".to_string(),
                description: "Minimal tests for CI".to_string(),
            },
            recording: RecordingConfig {
                duration_secs: 5,
                warmup_secs: 1,
                iterations: 1,
            },
            displays: DisplayConfig {
                resolutions: vec![ResolutionPreset::new(1920, 1080, "1080p")],
                frame_rates: vec![30],
                use_discovered: true,
            },
            cameras: CameraConfig {
                resolutions: vec![ResolutionPreset::new(1280, 720, "720p")],
                frame_rates: vec![30],
                pixel_formats: vec!["NV12".to_string()],
                enabled: true,
            },
            audio: AudioConfig {
                microphones: MicrophoneConfig {
                    sample_rates: vec![48000],
                    channels: vec![1],
                    include_bluetooth: false,
                    include_usb: true,
                    include_builtin: true,
                    enabled: true,
                },
                system: SystemAudioConfig {
                    enabled: true,
                    sample_rates: vec![48000],
                },
            },
            thresholds: ThresholdConfig {
                max_drop_rate_percent: 2.0,
                min_effective_fps_ratio: 0.90,
                max_p95_latency_ms: 100.0,
                max_av_sync_drift_ms: 200.0,
            },
            scenarios: ScenarioConfig::default(),
        }
    }

    pub fn exhaustive() -> Self {
        Self {
            meta: MetaConfig {
                name: "Exhaustive Hardware Matrix".to_string(),
                description: "Tests all hardware combinations".to_string(),
            },
            recording: RecordingConfig {
                duration_secs: 15,
                warmup_secs: 3,
                iterations: 5,
            },
            displays: DisplayConfig {
                resolutions: vec![
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(2560, 1440, "1440p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                    ResolutionPreset::new(5120, 2880, "5K"),
                    ResolutionPreset::new(2560, 1080, "UW-1080"),
                    ResolutionPreset::new(3440, 1440, "UW-1440"),
                    ResolutionPreset::new(5120, 1440, "SUW"),
                    ResolutionPreset::new(1080, 1920, "Portrait"),
                    ResolutionPreset::new(2880, 1800, "Retina"),
                    ResolutionPreset::new(3024, 1964, "MBP-14"),
                    ResolutionPreset::new(3456, 2234, "MBP-16"),
                ],
                frame_rates: vec![24, 30, 60, 120],
                use_discovered: true,
            },
            cameras: CameraConfig {
                resolutions: vec![
                    ResolutionPreset::new(320, 240, "QVGA"),
                    ResolutionPreset::new(640, 480, "VGA"),
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                ],
                frame_rates: vec![15, 24, 30, 60],
                pixel_formats: vec![
                    "NV12".to_string(),
                    "YUYV422".to_string(),
                    "UYVY422".to_string(),
                    "MJPEG".to_string(),
                    "RGB24".to_string(),
                    "BGRA".to_string(),
                ],
                enabled: true,
            },
            audio: AudioConfig {
                microphones: MicrophoneConfig {
                    sample_rates: vec![8000, 16000, 22050, 44100, 48000, 96000],
                    channels: vec![1, 2],
                    include_bluetooth: true,
                    include_usb: true,
                    include_builtin: true,
                    enabled: true,
                },
                system: SystemAudioConfig {
                    enabled: true,
                    sample_rates: vec![44100, 48000, 96000],
                },
            },
            thresholds: ThresholdConfig::default(),
            scenarios: ScenarioConfig {
                enabled: true,
                duration_secs: 20,
                scenarios: ScenarioType::all(),
            },
        }
    }

    pub fn synthetic() -> Self {
        Self {
            meta: MetaConfig {
                name: "Synthetic Tests".to_string(),
                description: "Tests using synthetic video/audio sources (no hardware required)"
                    .to_string(),
            },
            recording: RecordingConfig {
                duration_secs: 5,
                warmup_secs: 1,
                iterations: 3,
            },
            displays: DisplayConfig {
                resolutions: vec![
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(2560, 1440, "1440p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                ],
                frame_rates: vec![30, 60],
                use_discovered: false,
            },
            cameras: CameraConfig {
                resolutions: vec![
                    ResolutionPreset::new(640, 480, "VGA"),
                    ResolutionPreset::new(1280, 720, "720p"),
                ],
                frame_rates: vec![30],
                pixel_formats: vec!["NV12".to_string()],
                enabled: true,
            },
            audio: AudioConfig {
                microphones: MicrophoneConfig {
                    sample_rates: vec![44100, 48000],
                    channels: vec![1, 2],
                    include_bluetooth: false,
                    include_usb: false,
                    include_builtin: false,
                    enabled: true,
                },
                system: SystemAudioConfig {
                    enabled: true,
                    sample_rates: vec![48000],
                },
            },
            thresholds: ThresholdConfig::default(),
            scenarios: ScenarioConfig::default(),
        }
    }

    pub fn compatibility() -> Self {
        Self {
            meta: MetaConfig {
                name: "Compatibility Validation Matrix".to_string(),
                description: "Full compatibility validation for release sign-off covering all device types, OS variants, and resilience scenarios".to_string(),
            },
            recording: RecordingConfig {
                duration_secs: 15,
                warmup_secs: 3,
                iterations: 3,
            },
            displays: DisplayConfig {
                resolutions: vec![
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(2560, 1440, "1440p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                    ResolutionPreset::new(5120, 2880, "5K"),
                    ResolutionPreset::new(2560, 1080, "UW-1080"),
                    ResolutionPreset::new(3440, 1440, "UW-1440"),
                    ResolutionPreset::new(3024, 1964, "MBP-14"),
                    ResolutionPreset::new(3456, 2234, "MBP-16"),
                ],
                frame_rates: vec![30, 60],
                use_discovered: true,
            },
            cameras: CameraConfig {
                resolutions: vec![
                    ResolutionPreset::new(640, 480, "VGA"),
                    ResolutionPreset::new(1280, 720, "720p"),
                    ResolutionPreset::new(1920, 1080, "1080p"),
                    ResolutionPreset::new(3840, 2160, "4K"),
                ],
                frame_rates: vec![30, 60],
                pixel_formats: vec![
                    "NV12".to_string(),
                    "YUYV422".to_string(),
                    "MJPEG".to_string(),
                ],
                enabled: true,
            },
            audio: AudioConfig {
                microphones: MicrophoneConfig {
                    sample_rates: vec![8000, 16000, 44100, 48000, 96000],
                    channels: vec![1, 2],
                    include_bluetooth: true,
                    include_usb: true,
                    include_builtin: true,
                    enabled: true,
                },
                system: SystemAudioConfig {
                    enabled: true,
                    sample_rates: vec![44100, 48000],
                },
            },
            thresholds: ThresholdConfig {
                max_drop_rate_percent: 1.0,
                min_effective_fps_ratio: 0.95,
                max_p95_latency_ms: 50.0,
                max_av_sync_drift_ms: 100.0,
            },
            scenarios: ScenarioConfig {
                enabled: true,
                duration_secs: 15,
                scenarios: ScenarioType::all(),
            },
        }
    }
}
