use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConfig {
    pub meta: MetaConfig,
    pub recording: RecordingConfig,
    pub displays: DisplayConfig,
    pub cameras: CameraConfig,
    pub audio: AudioConfig,
    pub thresholds: ThresholdConfig,
    #[serde(default)]
    pub scenarios: ScenarioConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaConfig {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingConfig {
    #[serde(default = "default_duration")]
    pub duration_secs: u64,
    #[serde(default = "default_warmup")]
    pub warmup_secs: u64,
    #[serde(default = "default_iterations")]
    pub iterations: u32,
}

fn default_duration() -> u64 {
    10
}

fn default_warmup() -> u64 {
    2
}

fn default_iterations() -> u32 {
    3
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            duration_secs: 10,
            warmup_secs: 2,
            iterations: 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DisplayConfig {
    #[serde(default)]
    pub resolutions: Vec<ResolutionPreset>,
    #[serde(default = "default_frame_rates")]
    pub frame_rates: Vec<u32>,
    #[serde(default)]
    pub use_discovered: bool,
}

fn default_frame_rates() -> Vec<u32> {
    vec![30, 60]
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            resolutions: vec![
                ResolutionPreset::new(1920, 1080, "1080p"),
                ResolutionPreset::new(2560, 1440, "1440p"),
                ResolutionPreset::new(3840, 2160, "4K"),
            ],
            frame_rates: vec![30, 60],
            use_discovered: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolutionPreset {
    pub width: u32,
    pub height: u32,
    pub label: String,
}

impl ResolutionPreset {
    pub fn new(width: u32, height: u32, label: &str) -> Self {
        Self {
            width,
            height,
            label: label.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraConfig {
    #[serde(default)]
    pub resolutions: Vec<ResolutionPreset>,
    #[serde(default = "default_camera_frame_rates")]
    pub frame_rates: Vec<u32>,
    #[serde(default = "default_pixel_formats")]
    pub pixel_formats: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_camera_frame_rates() -> Vec<u32> {
    vec![30]
}

fn default_pixel_formats() -> Vec<String> {
    vec!["NV12".to_string(), "YUYV422".to_string()]
}

fn default_true() -> bool {
    true
}

impl Default for CameraConfig {
    fn default() -> Self {
        Self {
            resolutions: vec![
                ResolutionPreset::new(640, 480, "VGA"),
                ResolutionPreset::new(1280, 720, "720p"),
                ResolutionPreset::new(1920, 1080, "1080p"),
            ],
            frame_rates: vec![30],
            pixel_formats: vec!["NV12".to_string(), "YUYV422".to_string()],
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AudioConfig {
    pub microphones: MicrophoneConfig,
    pub system: SystemAudioConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicrophoneConfig {
    #[serde(default = "default_sample_rates")]
    pub sample_rates: Vec<u32>,
    #[serde(default = "default_channels")]
    pub channels: Vec<u16>,
    #[serde(default = "default_true")]
    pub include_bluetooth: bool,
    #[serde(default = "default_true")]
    pub include_usb: bool,
    #[serde(default = "default_true")]
    pub include_builtin: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_sample_rates() -> Vec<u32> {
    vec![44100, 48000]
}

fn default_channels() -> Vec<u16> {
    vec![1, 2]
}

impl Default for MicrophoneConfig {
    fn default() -> Self {
        Self {
            sample_rates: vec![44100, 48000],
            channels: vec![1, 2],
            include_bluetooth: true,
            include_usb: true,
            include_builtin: true,
            enabled: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemAudioConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_system_sample_rates")]
    pub sample_rates: Vec<u32>,
}

fn default_system_sample_rates() -> Vec<u32> {
    vec![44100, 48000]
}

impl Default for SystemAudioConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            sample_rates: vec![44100, 48000],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThresholdConfig {
    #[serde(default = "default_max_drop_rate")]
    pub max_drop_rate_percent: f64,
    #[serde(default = "default_min_fps_ratio")]
    pub min_effective_fps_ratio: f64,
    #[serde(default = "default_max_latency")]
    pub max_p95_latency_ms: f64,
    #[serde(default = "default_max_sync_drift")]
    pub max_av_sync_drift_ms: f64,
}

fn default_max_drop_rate() -> f64 {
    1.0
}

fn default_min_fps_ratio() -> f64 {
    0.95
}

fn default_max_latency() -> f64 {
    50.0
}

fn default_max_sync_drift() -> f64 {
    100.0
}

impl Default for ThresholdConfig {
    fn default() -> Self {
        Self {
            max_drop_rate_percent: 1.0,
            min_effective_fps_ratio: 0.95,
            max_p95_latency_ms: 50.0,
            max_av_sync_drift_ms: 100.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScenarioConfig {
    #[serde(default = "default_scenarios_enabled")]
    pub enabled: bool,
    #[serde(default = "default_scenario_duration")]
    pub duration_secs: u64,
    #[serde(default)]
    pub scenarios: Vec<ScenarioType>,
}

fn default_scenarios_enabled() -> bool {
    false
}

fn default_scenario_duration() -> u64 {
    15
}

impl Default for ScenarioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            duration_secs: 15,
            scenarios: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScenarioType {
    MicDisconnectReconnect,
    CameraDisconnectReconnect,
    DisplayResolutionChange,
    SystemAudioDeviceSwitch,
    CaptureSourceRestart,
    MultiMonitorRecording,
    LongDurationStability,
    AllDevicesCombined,
}

impl ScenarioType {
    pub fn requires_interactive(&self) -> bool {
        matches!(
            self,
            ScenarioType::MicDisconnectReconnect
                | ScenarioType::CameraDisconnectReconnect
                | ScenarioType::DisplayResolutionChange
                | ScenarioType::SystemAudioDeviceSwitch
                | ScenarioType::CaptureSourceRestart
        )
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            ScenarioType::MicDisconnectReconnect => "Microphone Disconnect/Reconnect",
            ScenarioType::CameraDisconnectReconnect => "Camera Disconnect/Reconnect",
            ScenarioType::DisplayResolutionChange => "Display Resolution Change",
            ScenarioType::SystemAudioDeviceSwitch => "System Audio Device Switch",
            ScenarioType::CaptureSourceRestart => "Capture Source Restart",
            ScenarioType::MultiMonitorRecording => "Multi-Monitor Recording",
            ScenarioType::LongDurationStability => "Long Duration Stability",
            ScenarioType::AllDevicesCombined => "All Devices Combined",
        }
    }

    pub fn related_task(&self) -> &'static str {
        match self {
            ScenarioType::MicDisconnectReconnect => "task 6",
            ScenarioType::CameraDisconnectReconnect => "task 17",
            ScenarioType::DisplayResolutionChange => "task 9",
            ScenarioType::SystemAudioDeviceSwitch => "task 7",
            ScenarioType::CaptureSourceRestart => "task 8",
            ScenarioType::MultiMonitorRecording => "task 10",
            ScenarioType::LongDurationStability => "stability",
            ScenarioType::AllDevicesCombined => "integration",
        }
    }

    pub fn all() -> Vec<ScenarioType> {
        vec![
            ScenarioType::MicDisconnectReconnect,
            ScenarioType::CameraDisconnectReconnect,
            ScenarioType::DisplayResolutionChange,
            ScenarioType::SystemAudioDeviceSwitch,
            ScenarioType::CaptureSourceRestart,
            ScenarioType::MultiMonitorRecording,
            ScenarioType::LongDurationStability,
            ScenarioType::AllDevicesCombined,
        ]
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureClassification {
    Panic,
    UnrecoverableStop,
    UnplayableOutput,
    PerformanceBelowThreshold,
    ValidationError,
}

impl FailureClassification {
    pub fn is_blocking(&self) -> bool {
        matches!(
            self,
            FailureClassification::Panic
                | FailureClassification::UnrecoverableStop
                | FailureClassification::UnplayableOutput
        )
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            FailureClassification::Panic => "PANIC",
            FailureClassification::UnrecoverableStop => "UNRECOVERABLE STOP",
            FailureClassification::UnplayableOutput => "UNPLAYABLE OUTPUT",
            FailureClassification::PerformanceBelowThreshold => "PERFORMANCE BELOW THRESHOLD",
            FailureClassification::ValidationError => "VALIDATION ERROR",
        }
    }
}

#[allow(dead_code)]
impl TestConfig {
    pub fn recording_duration(&self) -> Duration {
        Duration::from_secs(self.recording.duration_secs)
    }

    pub fn warmup_duration(&self) -> Duration {
        Duration::from_secs(self.recording.warmup_secs)
    }
}
