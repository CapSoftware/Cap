//! Audio latency correction module for Cap.
//!
//! This module provides comprehensive audio latency detection and correction to maintain
//! proper audio-video synchronization. It handles measuring hardware buffer delays and
//! compensating for transmission latency in wireless audio devices.
//!
//! # Quick Start
//!
//! ```rust,no_run
//! use cap_audio::{LatencyCorrector, LatencyCorrectionConfig, default_output_latency_hint};
//!
//! // Get initial latency hint from hardware
//! let hint = default_output_latency_hint(48000, 512);
//!
//! // Create corrector with default settings
//! let mut corrector = LatencyCorrector::new(hint, LatencyCorrectionConfig::default());
//!
//! // Apply initial compensation to audio playhead
//! let base_playhead = 5.0; // Current playback position in seconds
//! let compensated_playhead = base_playhead + corrector.initial_compensation_secs();
//! // audio_renderer.set_playhead(compensated_playhead);
//!
//! // In audio callback, update latency estimate
//! // let current_latency = corrector.update_from_callback(&callback_info);
//! ```
//!
//! # Transport Types
//!
//! The system automatically detects and handles different audio transports:
//! - **Wired**: Standard audio interfaces (20-50ms typical)
//! - **Bluetooth**: Wireless audio with encoding delays (120ms+ minimum)
//! - **AirPlay**: Network streaming with substantial buffering (1.8s+ minimum)
//!
//! # Platform Support
//!
//! - **macOS**: Full Core Audio integration with precise device inspection
//! - **Other platforms**: Buffer-based estimation with conservative defaults

use std::time::{Duration, Instant};

use cpal::OutputCallbackInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputTransportKind {
    Wired,
    Wireless,
    Airplay,
    ContinuityWireless,
    Unknown,
}

impl OutputTransportKind {
    pub const fn is_wireless(self) -> bool {
        matches!(
            self,
            Self::Wireless | Self::Airplay | Self::ContinuityWireless
        )
    }
}

#[derive(Debug, Clone, Copy)]
pub struct OutputLatencyHint {
    pub latency_secs: f64,
    pub transport: OutputTransportKind,
}

impl OutputLatencyHint {
    pub fn new(latency_secs: f64, transport: OutputTransportKind) -> Self {
        Self {
            latency_secs,
            transport,
        }
    }

    pub fn is_probably_wireless(&self) -> bool {
        self.transport.is_wireless()
    }
}

/// Configuration for dynamic latency correction during playback
#[derive(Debug, Clone, Copy)]
pub struct LatencyCorrectionConfig {
    /// Minimum change in latency (seconds) before applying correction
    pub min_apply_delta_secs: f64,
    /// Minimum number of latency updates before enabling dynamic correction
    pub min_updates_for_dynamic: u64,
    /// Maximum latency change per second to prevent artifacts
    pub max_change_per_sec: f64,
    /// Initial freeze duration to let the system stabilize
    pub initial_freeze_duration_secs: f64,
    /// Threshold for logging latency changes (milliseconds)
    pub log_change_threshold_ms: i32,
    /// Safety multiplier for initial latency compensation
    pub initial_safety_multiplier: f64,
}

impl Default for LatencyCorrectionConfig {
    fn default() -> Self {
        Self {
            min_apply_delta_secs: 0.005,
            min_updates_for_dynamic: 4,
            max_change_per_sec: 0.15,
            initial_freeze_duration_secs: 0.35,
            log_change_threshold_ms: 5,
            initial_safety_multiplier: 2.0,
        }
    }
}

/// Manages latency correction for audio playback
#[derive(Debug)]
pub struct LatencyCorrector {
    estimator: OutputLatencyEstimator,
    config: LatencyCorrectionConfig,
    last_latency_used: Option<f64>,
    last_logged_latency_ms: Option<i32>,
    last_latency_update_at: Instant,
    latency_freeze_until: Instant,
}

impl LatencyCorrector {
    pub fn new(hint: Option<OutputLatencyHint>, config: LatencyCorrectionConfig) -> Self {
        let estimator = match hint {
            Some(h) => OutputLatencyEstimator::from_hint(h),
            None => OutputLatencyEstimator::new(),
        };

        let now = Instant::now();
        Self {
            estimator,
            config,
            last_latency_used: None,
            last_logged_latency_ms: None,
            last_latency_update_at: now,
            latency_freeze_until: now
                + Duration::from_secs_f64(config.initial_freeze_duration_secs),
        }
    }

    /// Get the initial latency compensation value (with safety multiplier applied)
    pub fn initial_compensation_secs(&self) -> f64 {
        self.estimator.current_secs().unwrap_or_default() * self.config.initial_safety_multiplier
    }

    /// Update latency estimate from audio callback and return corrected latency
    pub fn update_from_callback(&mut self, info: &OutputCallbackInfo) -> f64 {
        let previous_update_count = self.estimator.update_count();
        let estimated_latency_secs = self
            .estimator
            .observe_callback(info)
            .or(self.last_latency_used)
            .unwrap_or_default();

        let now = Instant::now();

        let latency_secs = if let Some(previous) = self.last_latency_used {
            if now < self.latency_freeze_until {
                previous
            } else if self.estimator.update_count() >= self.config.min_updates_for_dynamic {
                let dt_secs = now
                    .checked_duration_since(self.last_latency_update_at)
                    .map(|d| d.as_secs_f64())
                    .unwrap_or(0.0);
                let max_delta = (self.config.max_change_per_sec * dt_secs)
                    .max(self.config.min_apply_delta_secs);
                let delta = estimated_latency_secs - previous;

                if delta.abs() <= max_delta {
                    self.last_latency_update_at = now;
                    estimated_latency_secs
                } else {
                    self.last_latency_update_at = now;
                    previous + delta.signum() * max_delta
                }
            } else if (estimated_latency_secs - previous).abs() < self.config.min_apply_delta_secs {
                previous
            } else {
                self.last_latency_update_at = now;
                estimated_latency_secs
            }
        } else {
            self.last_latency_update_at = now;
            estimated_latency_secs
        };

        self.last_latency_used = Some(latency_secs);

        // Log significant latency changes
        if self.estimator.update_count() != previous_update_count {
            let latency_ms = (latency_secs * 1_000.0).round() as i32;
            let should_log = match self.last_logged_latency_ms {
                Some(prev) => (prev - latency_ms).abs() >= self.config.log_change_threshold_ms,
                None => latency_ms >= 0,
            };

            if should_log {
                tracing::info!(
                    "Estimated audio output latency: {:.1} ms",
                    latency_secs * 1_000.0
                );
                self.last_logged_latency_ms = Some(latency_ms);
            }
        }

        latency_secs
    }

    /// Get the current latency estimate without updating
    pub fn current_latency_secs(&self) -> Option<f64> {
        self.last_latency_used
    }

    /// Get the underlying latency estimator for advanced use cases
    pub fn estimator(&self) -> &OutputLatencyEstimator {
        &self.estimator
    }

    /// Get the underlying latency estimator mutably for advanced use cases
    pub fn estimator_mut(&mut self) -> &mut OutputLatencyEstimator {
        &mut self.estimator
    }
}

const MAX_LATENCY_SECS: f64 = 3.0;
const MIN_VALID_LATENCY_SECS: f64 = 0.000_1;
const INCREASE_TAU_SECS: f64 = 0.25;
const DECREASE_TAU_SECS: f64 = 1.0;
const MAX_RISE_PER_SEC: f64 = 0.75;
const WARMUP_GUARD_SAMPLES: u32 = 3;
const WARMUP_SPIKE_RATIO: f64 = 50.0;
#[cfg(not(target_os = "macos"))]
const FALLBACK_WIRED_LATENCY_SECS: f64 = 0.03;
#[cfg(target_os = "macos")]
const WIRELESS_FALLBACK_LATENCY_SECS: f64 = 0.20;
const WIRELESS_MIN_LATENCY_SECS: f64 = 0.12;

#[cfg(target_os = "macos")]
const AIRPLAY_MIN_LATENCY_SECS: f64 = 1.8;

/// Tracks the measured output latency reported by the active audio device.
///
/// The estimator smooths reported values so that sudden increases are applied quickly while
/// decreases are adopted more conservatively. This keeps the playhead ahead of the hardware
/// buffer without reacting to transient spikes that would otherwise cause unnecessary seeks.
#[derive(Debug, Clone)]
pub struct OutputLatencyEstimator {
    smoothed_latency_secs: Option<f64>,
    last_raw_latency_secs: Option<f64>,
    update_count: u64,
    bias_secs: f64,
    last_update_at: Option<Instant>,
    min_floor_secs: f64,
    max_ceiling_secs: f64,
}

impl OutputLatencyEstimator {
    pub fn new() -> Self {
        Self::with_bias(0.0)
    }

    pub fn with_bias(bias_secs: f64) -> Self {
        let bias_secs = bias_secs.clamp(0.0, MAX_LATENCY_SECS);
        Self {
            smoothed_latency_secs: if bias_secs > 0.0 {
                Some(bias_secs)
            } else {
                None
            },
            last_raw_latency_secs: None,
            update_count: 0,
            bias_secs,
            last_update_at: None,
            min_floor_secs: 0.0,
            max_ceiling_secs: MAX_LATENCY_SECS,
        }
    }

    pub fn from_hint(hint: OutputLatencyHint) -> Self {
        let mut estimator = Self::with_bias(0.0);
        let (floor, ceiling) = transport_constraints(hint.transport);
        estimator.set_floor_and_ceiling(floor, ceiling);

        if hint.latency_secs > 0.0 {
            let seeded = hint
                .latency_secs
                .max(estimator.min_floor_secs)
                .min(estimator.max_ceiling_secs);
            estimator.smoothed_latency_secs = Some(seeded);
            estimator.last_update_at = Some(Instant::now());
        }

        estimator
    }

    pub fn set_bias_secs(&mut self, bias_secs: f64) {
        self.bias_secs = bias_secs.clamp(0.0, MAX_LATENCY_SECS);
    }

    pub fn set_floor_and_ceiling(&mut self, min_floor_secs: f64, max_ceiling_secs: f64) {
        self.min_floor_secs = min_floor_secs.clamp(0.0, MAX_LATENCY_SECS);
        self.max_ceiling_secs = max_ceiling_secs
            .max(self.min_floor_secs)
            .min(MAX_LATENCY_SECS);
        if let Some(current) = self.smoothed_latency_secs {
            self.smoothed_latency_secs =
                Some(current.max(self.min_floor_secs).min(self.max_ceiling_secs));
        }
    }

    pub fn reset(&mut self) {
        let bias = self.bias_secs;
        let floor = self.min_floor_secs;
        let ceiling = self.max_ceiling_secs;
        *self = Self::with_bias(bias);
        self.set_floor_and_ceiling(floor, ceiling);
    }

    /// Observes a callback invocation and updates the latency estimate when the backend reports a
    /// playback timestamp.
    pub fn observe_callback(&mut self, info: &OutputCallbackInfo) -> Option<f64> {
        let timestamp = info.timestamp();
        let latency = timestamp.playback.duration_since(&timestamp.callback);
        self.observe_latency(latency)
    }

    /// Observes a latency duration directly. Exposed for tests.
    pub fn observe_latency(&mut self, latency: Option<Duration>) -> Option<f64> {
        if let Some(duration) = latency {
            let secs = duration.as_secs_f64();
            if secs.is_finite() {
                self.record_latency(secs);
            }
        }

        self.smoothed_latency_secs
    }

    /// Returns the current smoothed latency estimate in seconds, if available.
    pub fn current_secs(&self) -> Option<f64> {
        self.smoothed_latency_secs
    }

    pub fn current_duration(&self) -> Option<Duration> {
        self.smoothed_latency_secs
            .map(|secs| Duration::from_secs_f64(secs.max(0.0)))
    }

    pub fn bias_secs(&self) -> f64 {
        self.bias_secs
    }

    pub fn last_raw_secs(&self) -> Option<f64> {
        self.last_raw_latency_secs
    }

    pub fn update_count(&self) -> u64 {
        self.update_count
    }

    fn record_latency(&mut self, secs: f64) {
        if secs < 0.0 {
            return;
        }

        let clamped = secs.min(self.max_ceiling_secs);

        if clamped < MIN_VALID_LATENCY_SECS {
            return;
        }

        if let Some(prev_raw) = self.last_raw_latency_secs
            && self.update_count < WARMUP_GUARD_SAMPLES as u64
            && clamped > prev_raw * WARMUP_SPIKE_RATIO
        {
            self.last_raw_latency_secs = Some(clamped);
            self.update_count = self.update_count.saturating_add(1);
            return;
        }

        let now = Instant::now();
        let dt_secs = self
            .last_update_at
            .map(|t| (now - t).as_secs_f64())
            .unwrap_or(0.0);
        self.last_update_at = Some(now);

        self.last_raw_latency_secs = Some(clamped);
        self.update_count = self.update_count.saturating_add(1);

        let mut target_latency = clamped + self.bias_secs;
        if target_latency < self.min_floor_secs {
            target_latency = self.min_floor_secs;
        }
        if target_latency > self.max_ceiling_secs {
            target_latency = self.max_ceiling_secs;
        }

        self.smoothed_latency_secs = Some(match self.smoothed_latency_secs {
            Some(current) => {
                let rising = target_latency > current;
                let tau = if rising {
                    INCREASE_TAU_SECS
                } else {
                    DECREASE_TAU_SECS
                };
                let alpha = time_based_alpha(dt_secs, tau);
                let mut next = current + (target_latency - current) * alpha;

                if rising && dt_secs > 0.0 {
                    let max_allowed = current + MAX_RISE_PER_SEC * dt_secs;
                    next = next.min(max_allowed);
                }

                next
            }
            None => target_latency,
        });
    }
}

impl Default for OutputLatencyEstimator {
    fn default() -> Self {
        Self::new()
    }
}

pub fn default_output_latency_hint(
    sample_rate: u32,
    buffer_size_frames: u32,
) -> Option<OutputLatencyHint> {
    if sample_rate == 0 {
        return None;
    }

    #[cfg(target_os = "macos")]
    {
        macos::default_output_latency_hint(sample_rate, buffer_size_frames)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let fallback = (buffer_size_frames as f64 / sample_rate as f64)
            .clamp(FALLBACK_WIRED_LATENCY_SECS, MAX_LATENCY_SECS);
        Some(OutputLatencyHint::new(
            fallback,
            OutputTransportKind::Unknown,
        ))
    }
}

#[derive(Debug, Clone, Copy)]
pub struct InputLatencyInfo {
    pub device_latency_secs: f64,
    pub buffer_latency_secs: f64,
    pub total_latency_secs: f64,
    pub transport: OutputTransportKind,
}

impl InputLatencyInfo {
    pub fn new(
        device_latency_secs: f64,
        buffer_latency_secs: f64,
        transport: OutputTransportKind,
    ) -> Self {
        Self {
            device_latency_secs,
            buffer_latency_secs,
            total_latency_secs: device_latency_secs + buffer_latency_secs,
            transport,
        }
    }

    pub fn from_buffer_only(sample_rate: u32, buffer_size_frames: u32) -> Self {
        let buffer_latency = if sample_rate > 0 {
            buffer_size_frames as f64 / sample_rate as f64
        } else {
            0.0
        };
        Self::new(0.0, buffer_latency, OutputTransportKind::Unknown)
    }
}

pub fn estimate_input_latency(
    sample_rate: u32,
    buffer_size_frames: u32,
    device_name: Option<&str>,
) -> InputLatencyInfo {
    if sample_rate == 0 {
        return InputLatencyInfo::new(0.0, 0.0, OutputTransportKind::Unknown);
    }

    #[cfg(target_os = "macos")]
    {
        macos::estimate_input_latency(sample_rate, buffer_size_frames, device_name)
            .unwrap_or_else(|| InputLatencyInfo::from_buffer_only(sample_rate, buffer_size_frames))
    }

    #[cfg(windows)]
    {
        windows::estimate_input_latency(sample_rate, buffer_size_frames, device_name)
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = device_name;
        InputLatencyInfo::from_buffer_only(sample_rate, buffer_size_frames)
    }
}

fn time_based_alpha(dt_secs: f64, tau_secs: f64) -> f64 {
    if tau_secs <= 0.0 {
        return 1.0;
    }

    if dt_secs <= 0.0 {
        1.0
    } else {
        let alpha = 1.0 - (-dt_secs / tau_secs).exp();
        alpha.clamp(0.0, 1.0)
    }
}

fn transport_constraints(transport: OutputTransportKind) -> (f64, f64) {
    #[cfg(target_os = "macos")]
    {
        match transport {
            OutputTransportKind::Airplay => (AIRPLAY_MIN_LATENCY_SECS, MAX_LATENCY_SECS),
            OutputTransportKind::Wireless | OutputTransportKind::ContinuityWireless => {
                (WIRELESS_MIN_LATENCY_SECS, MAX_LATENCY_SECS)
            }
            _ => (0.0, MAX_LATENCY_SECS),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        match transport {
            OutputTransportKind::Wireless | OutputTransportKind::ContinuityWireless => {
                (WIRELESS_MIN_LATENCY_SECS, MAX_LATENCY_SECS)
            }
            _ => (0.0, MAX_LATENCY_SECS),
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #[cfg(target_os = "macos")]
    use super::AIRPLAY_MIN_LATENCY_SECS;
    use super::{
        InputLatencyInfo, MAX_LATENCY_SECS, OutputLatencyHint, OutputTransportKind,
        WIRELESS_FALLBACK_LATENCY_SECS, WIRELESS_MIN_LATENCY_SECS, transport_constraints,
    };
    use cidre::{
        core_audio::{
            DeviceTransportType, PropElement, PropScope, PropSelector,
            hardware::{Device, Stream, System},
        },
        os,
    };

    pub(super) fn default_output_latency_hint(
        sample_rate: u32,
        fallback_buffer_frames: u32,
    ) -> Option<OutputLatencyHint> {
        let device = System::default_output_device().ok()?;
        compute_latency_hint(&device, sample_rate, fallback_buffer_frames).ok()
    }

    pub(super) fn estimate_input_latency(
        sample_rate: u32,
        buffer_size_frames: u32,
        _device_name: Option<&str>,
    ) -> Option<InputLatencyInfo> {
        let device = System::default_input_device().ok()?;
        compute_input_latency(&device, sample_rate, buffer_size_frames).ok()
    }

    fn compute_input_latency(
        device: &Device,
        sample_rate: u32,
        fallback_buffer_frames: u32,
    ) -> os::Result<InputLatencyInfo> {
        let transport = device
            .transport_type()
            .unwrap_or(DeviceTransportType::UNKNOWN);
        let transport_kind = transport_kind(transport);

        let device_latency_frames =
            scoped_u32(device, PropSelector::DEVICE_LATENCY, PropScope::INPUT).unwrap_or(0);
        let safety_offset_frames =
            scoped_u32(device, PropSelector::DEVICE_SAFETY_OFFSET, PropScope::INPUT).unwrap_or(0);
        let buffer_frames = device
            .prop(&PropSelector::DEVICE_BUF_FRAME_SIZE.global_addr())
            .unwrap_or(fallback_buffer_frames);
        let stream_latency_frames = max_input_stream_latency(device).unwrap_or(0);

        let device_sample_rate = device.nominal_sample_rate().unwrap_or(sample_rate as f64);
        let effective_rate = if device_sample_rate > 0.0 {
            device_sample_rate
        } else {
            sample_rate as f64
        };

        let device_latency_total_frames = device_latency_frames as u64
            + safety_offset_frames as u64
            + stream_latency_frames as u64;

        let device_latency_secs = device_latency_total_frames as f64 / effective_rate;
        let buffer_latency_secs = buffer_frames as f64 / effective_rate;

        Ok(InputLatencyInfo::new(
            device_latency_secs,
            buffer_latency_secs,
            transport_kind,
        ))
    }

    fn max_input_stream_latency(device: &Device) -> os::Result<u32> {
        let streams = device.streams()?;
        let mut max_latency = 0u32;

        for stream in streams {
            if is_input_stream(&stream)?
                && let Ok(latency) = stream.latency()
            {
                max_latency = max_latency.max(latency);
            }
        }

        Ok(max_latency)
    }

    fn is_input_stream(stream: &Stream) -> os::Result<bool> {
        stream.direction().map(|dir| dir == 1)
    }

    fn compute_latency_hint(
        device: &Device,
        sample_rate: u32,
        fallback_buffer_frames: u32,
    ) -> os::Result<OutputLatencyHint> {
        let transport = device
            .transport_type()
            .unwrap_or(DeviceTransportType::UNKNOWN);
        let transport_kind = transport_kind(transport);

        let device_latency_frames =
            scoped_u32(device, PropSelector::DEVICE_LATENCY, PropScope::OUTPUT).unwrap_or(0);
        let safety_offset_frames = scoped_u32(
            device,
            PropSelector::DEVICE_SAFETY_OFFSET,
            PropScope::OUTPUT,
        )
        .unwrap_or(0);
        let buffer_frames = device
            .prop(&PropSelector::DEVICE_BUF_FRAME_SIZE.global_addr())
            .unwrap_or(fallback_buffer_frames);
        let stream_latency_frames = max_output_stream_latency(device).unwrap_or(0);

        let device_sample_rate = device.nominal_sample_rate().unwrap_or(sample_rate as f64);
        let effective_rate = if device_sample_rate > 0.0 {
            device_sample_rate
        } else {
            sample_rate as f64
        };

        let total_frames = device_latency_frames as u64
            + safety_offset_frames as u64
            + buffer_frames as u64
            + stream_latency_frames as u64;

        if total_frames == 0 {
            let (floor, ceiling) = transport_constraints(transport_kind);
            let base_latency = (buffer_frames as f64 / effective_rate).min(ceiling);
            let fallback = if transport_kind.is_wireless() {
                base_latency.max(WIRELESS_FALLBACK_LATENCY_SECS).max(floor)
            } else {
                base_latency.max(floor)
            }
            .min(MAX_LATENCY_SECS);
            return Ok(OutputLatencyHint::new(fallback, transport_kind));
        }

        let mut latency_secs = total_frames as f64 / effective_rate;

        match transport_kind {
            OutputTransportKind::Airplay => {
                if latency_secs < AIRPLAY_MIN_LATENCY_SECS {
                    latency_secs = AIRPLAY_MIN_LATENCY_SECS;
                }
            }
            OutputTransportKind::Wireless | OutputTransportKind::ContinuityWireless => {
                if latency_secs < WIRELESS_MIN_LATENCY_SECS {
                    latency_secs = WIRELESS_MIN_LATENCY_SECS;
                }
            }
            _ => {}
        }

        latency_secs = latency_secs.min(MAX_LATENCY_SECS);

        Ok(OutputLatencyHint::new(latency_secs, transport_kind))
    }

    fn scoped_u32(device: &Device, selector: PropSelector, scope: PropScope) -> os::Result<u32> {
        device.prop(&selector.addr(scope, PropElement::MAIN))
    }

    fn max_output_stream_latency(device: &Device) -> os::Result<u32> {
        let streams = device.streams()?;
        let mut max_latency = 0u32;

        for stream in streams {
            if is_output_stream(&stream)?
                && let Ok(latency) = stream.latency()
            {
                max_latency = max_latency.max(latency);
            }
        }

        Ok(max_latency)
    }

    fn is_output_stream(stream: &Stream) -> os::Result<bool> {
        stream.direction().map(|dir| dir == 0)
    }

    fn transport_kind(transport: DeviceTransportType) -> OutputTransportKind {
        match transport {
            DeviceTransportType::AIR_PLAY => OutputTransportKind::Airplay,
            DeviceTransportType::BLUETOOTH | DeviceTransportType::BLUETOOTH_LE => {
                OutputTransportKind::Wireless
            }
            DeviceTransportType::CONTINUITY_CAPTURE_WIRELESS => {
                OutputTransportKind::ContinuityWireless
            }
            DeviceTransportType::UNKNOWN => OutputTransportKind::Unknown,
            _ => OutputTransportKind::Wired,
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::{InputLatencyInfo, OutputTransportKind, WIRELESS_MIN_LATENCY_SECS};
    use tracing::{debug, trace};
    use windows::{
        Win32::Devices::FunctionDiscovery::PKEY_Device_EnumeratorName,
        Win32::Media::Audio::{
            DEVICE_STATE, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, eCapture,
        },
        Win32::System::Com::{
            CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, STGM_READ,
        },
        core::PCWSTR,
    };

    const BLUETOOTH_DEVICE_PATTERNS: &[&str] = &[
        "airpod",
        "bluetooth",
        "bt ",
        "wireless",
        "bose",
        "sony wh",
        "sony wf",
        "jabra",
        "beats",
        "galaxy buds",
        "pixel buds",
        "anker",
        "jbl ",
        "soundcore",
        "tozo",
        "raycon",
        "skullcandy",
        "sennheiser momentum",
        "audio-technica ath-m50xbt",
        "marshall",
        "b&o",
        "bang & olufsen",
        "shokz",
        "aftershokz",
    ];

    fn is_likely_bluetooth_device(device_name: &str) -> bool {
        let lower = device_name.to_lowercase();
        BLUETOOTH_DEVICE_PATTERNS
            .iter()
            .any(|pattern| lower.contains(pattern))
    }

    fn detect_transport_via_mmdevice(device_name: &str) -> Option<OutputTransportKind> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;

            let collection = enumerator
                .EnumAudioEndpoints(eCapture, DEVICE_STATE(1))
                .ok()?;
            let count = collection.GetCount().ok()?;

            for i in 0..count {
                let device: IMMDevice = match collection.Item(i) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                let props = match device.OpenPropertyStore(STGM_READ) {
                    Ok(p) => p,
                    Err(_) => continue,
                };

                let friendly_name = get_device_friendly_name(&device);
                let matches_name = friendly_name
                    .as_ref()
                    .map(|n| n.to_lowercase().contains(&device_name.to_lowercase()))
                    .unwrap_or(false);

                if !matches_name {
                    continue;
                }

                if let Ok(bus_enum) = props.GetValue(&PKEY_Device_EnumeratorName) {
                    let bus_name = bus_enum.Anonymous.Anonymous.Anonymous.pwszVal;
                    if !bus_name.0.is_null() {
                        let bus_str = PCWSTR(bus_name.0).to_string().ok()?;
                        trace!(
                            device = ?friendly_name,
                            bus = %bus_str,
                            "Windows audio device bus enumerator"
                        );

                        let bus_lower = bus_str.to_lowercase();
                        if bus_lower.contains("bthenum") || bus_lower.contains("bluetooth") {
                            debug!(
                                device = ?friendly_name,
                                "Detected Bluetooth audio device via Windows API"
                            );
                            return Some(OutputTransportKind::Wireless);
                        }
                    }
                }

                return Some(OutputTransportKind::Wired);
            }

            None
        }
    }

    fn get_device_friendly_name(device: &IMMDevice) -> Option<String> {
        use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;

        unsafe {
            let props = device.OpenPropertyStore(STGM_READ).ok()?;
            let name_val = props.GetValue(&PKEY_Device_FriendlyName).ok()?;
            let name_ptr = name_val.Anonymous.Anonymous.Anonymous.pwszVal;
            if name_ptr.0.is_null() {
                return None;
            }
            PCWSTR(name_ptr.0).to_string().ok()
        }
    }

    pub fn estimate_input_latency(
        sample_rate: u32,
        buffer_size_frames: u32,
        device_name: Option<&str>,
    ) -> InputLatencyInfo {
        if sample_rate == 0 {
            return InputLatencyInfo::new(0.0, 0.0, OutputTransportKind::Unknown);
        }

        let buffer_latency_secs = buffer_size_frames as f64 / sample_rate as f64;

        let transport_kind = device_name
            .and_then(|name| {
                if let Some(transport) = detect_transport_via_mmdevice(name) {
                    return Some(transport);
                }

                if is_likely_bluetooth_device(name) {
                    debug!(
                        device = %name,
                        "Detected likely Bluetooth device via name pattern matching"
                    );
                    return Some(OutputTransportKind::Wireless);
                }

                None
            })
            .unwrap_or(OutputTransportKind::Unknown);

        let device_latency_secs = match transport_kind {
            OutputTransportKind::Wireless => {
                debug!(
                    device = ?device_name,
                    latency_ms = WIRELESS_MIN_LATENCY_SECS * 1000.0,
                    "Using wireless latency for audio device"
                );
                WIRELESS_MIN_LATENCY_SECS
            }
            _ => 0.01,
        };

        InputLatencyInfo::new(device_latency_secs, buffer_latency_secs, transport_kind)
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn detects_airpods() {
            assert!(is_likely_bluetooth_device("AirPods Pro"));
            assert!(is_likely_bluetooth_device("airpods"));
        }

        #[test]
        fn detects_generic_bluetooth() {
            assert!(is_likely_bluetooth_device("Bluetooth Headset"));
            assert!(is_likely_bluetooth_device("BT Audio"));
        }

        #[test]
        fn does_not_detect_wired() {
            assert!(!is_likely_bluetooth_device("Realtek HD Audio"));
            assert!(!is_likely_bluetooth_device("USB Microphone"));
            assert!(!is_likely_bluetooth_device("Blue Yeti"));
        }

        #[test]
        fn wireless_mic_gets_higher_latency() {
            let wireless = estimate_input_latency(48000, 1024, Some("AirPods Pro"));
            let wired = estimate_input_latency(48000, 1024, Some("USB Microphone"));

            assert!(wireless.device_latency_secs >= WIRELESS_MIN_LATENCY_SECS);
            assert!(wired.device_latency_secs < WIRELESS_MIN_LATENCY_SECS);
            assert!(wireless.total_latency_secs > wired.total_latency_secs);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unchecked_duration_subtraction)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn latency_estimator_increases_quickly() {
        let mut estimator = OutputLatencyEstimator::new();
        estimator.observe_latency(Some(Duration::from_millis(5)));
        estimator.last_update_at = Some(Instant::now() - Duration::from_millis(300));
        estimator.observe_latency(Some(Duration::from_millis(120)));

        let latency = estimator.current_secs().unwrap();
        assert!(latency > 0.05);
    }

    #[test]
    fn latency_estimator_decreases_slowly() {
        let mut estimator = OutputLatencyEstimator::new();
        estimator.observe_latency(Some(Duration::from_millis(150)));
        let first = estimator.current_secs().unwrap();

        estimator.last_update_at = Some(Instant::now() - Duration::from_millis(60));
        estimator.observe_latency(Some(Duration::from_millis(10)));
        let second = estimator.current_secs().unwrap();

        assert!(second > 0.02);
        assert!(second > 0.5 * first);
    }

    #[test]
    fn latency_estimator_ignores_initial_zero() {
        let mut estimator = OutputLatencyEstimator::new();
        estimator.observe_latency(Some(Duration::from_millis(0)));
        assert!(estimator.current_secs().is_none());

        estimator.last_update_at = Some(Instant::now() - Duration::from_millis(60));
        estimator.observe_latency(Some(Duration::from_millis(120)));

        assert!(estimator.current_secs().unwrap() > 0.1);
    }

    #[test]
    fn wireless_floor_is_enforced() {
        let hint = OutputLatencyHint::new(0.05, OutputTransportKind::Wireless);
        let mut estimator = OutputLatencyEstimator::from_hint(hint);
        assert!(estimator.current_secs().unwrap() >= WIRELESS_MIN_LATENCY_SECS);

        estimator.last_update_at = Some(Instant::now() - Duration::from_millis(60));
        estimator.observe_latency(Some(Duration::from_millis(20)));

        assert!(estimator.current_secs().unwrap() >= WIRELESS_MIN_LATENCY_SECS);
    }

    #[test]
    fn latency_corrector_applies_initial_multiplier() {
        let hint = OutputLatencyHint::new(0.05, OutputTransportKind::Wired);
        let config = LatencyCorrectionConfig::default();
        let corrector = LatencyCorrector::new(Some(hint), config);

        let initial = corrector.initial_compensation_secs();
        assert_eq!(initial, 0.05 * 2.0); // Default multiplier is 2.0
    }

    #[test]
    fn latency_corrector_freezes_initially() {
        let hint = OutputLatencyHint::new(0.05, OutputTransportKind::Wired);
        let config = LatencyCorrectionConfig::default();
        let corrector = LatencyCorrector::new(Some(hint), config);

        // Initially no latency used in callbacks
        assert!(corrector.current_latency_secs().is_none());

        // But initial compensation should be available with safety multiplier
        let initial_compensation = corrector.initial_compensation_secs();
        assert_eq!(initial_compensation, 0.05 * 2.0);
    }

    #[test]
    fn latency_corrector_with_custom_config() {
        let hint = OutputLatencyHint::new(0.1, OutputTransportKind::Wireless);
        let config = LatencyCorrectionConfig {
            initial_safety_multiplier: 3.0,
            min_apply_delta_secs: 0.01,
            ..Default::default()
        };
        let corrector = LatencyCorrector::new(Some(hint), config);

        // Should apply custom multiplier, but 0.1 gets constrained to WIRELESS_MIN_LATENCY_SECS (0.12)
        // So: 0.12 * 3.0 = 0.36
        assert!((corrector.initial_compensation_secs() - 0.36).abs() < f64::EPSILON);
    }

    #[test]
    fn default_latency_hint_fallback() {
        // Test fallback calculation for unknown sample rate
        let hint = default_output_latency_hint(0, 512);
        assert!(hint.is_none());

        // Test with valid parameters
        let hint = default_output_latency_hint(48000, 512);
        assert!(hint.is_some());

        if let Some(h) = hint {
            // Should have some reasonable latency value
            assert!(h.latency_secs > 0.0);
            assert!(h.latency_secs < 1.0); // Should be reasonable for most cases
        }
    }

    #[test]
    fn transport_kind_wireless_constraints() {
        let wireless_hint = OutputLatencyHint::new(0.01, OutputTransportKind::Wireless);
        let estimator = OutputLatencyEstimator::from_hint(wireless_hint);

        // Should enforce minimum wireless latency
        assert!(estimator.current_secs().unwrap() >= WIRELESS_MIN_LATENCY_SECS);
    }

    #[test]
    fn latency_estimator_bias() {
        let mut estimator = OutputLatencyEstimator::with_bias(0.05);
        assert_eq!(estimator.bias_secs(), 0.05);

        // Should start with bias value
        assert_eq!(estimator.current_secs(), Some(0.05));

        // Test bias modification
        estimator.set_bias_secs(0.1);
        assert_eq!(estimator.bias_secs(), 0.1);
    }

    #[test]
    fn integration_latency_correction_workflow() {
        // Simulate realistic audio playback scenario
        let sample_rate = 48000;
        let buffer_size = 512;

        // 1. Get initial hardware hint
        let hint = default_output_latency_hint(sample_rate, buffer_size);
        assert!(hint.is_some());

        let hint = hint.unwrap();
        assert!(hint.latency_secs > 0.0);
        assert!(hint.latency_secs < 1.0); // Reasonable for most hardware

        // 2. Create corrector with custom config
        let config = LatencyCorrectionConfig {
            initial_safety_multiplier: 2.0,
            min_apply_delta_secs: 0.001,
            min_updates_for_dynamic: 3,
            max_change_per_sec: 0.1,
            initial_freeze_duration_secs: 0.1,
            log_change_threshold_ms: 10,
        };

        let corrector = LatencyCorrector::new(Some(hint), config);

        // 3. Verify initial compensation
        let initial_compensation = corrector.initial_compensation_secs();
        assert!(initial_compensation >= hint.latency_secs * 1.5); // At least 1.5x due to constraints
        assert!(initial_compensation <= hint.latency_secs * 2.5); // But not more than 2.5x

        // 4. Simulate audio rendering setup
        let base_playhead = 5.0; // 5 seconds into the track
        let compensated_playhead = base_playhead + initial_compensation;
        assert!(compensated_playhead > base_playhead);

        // 5. Verify corrector state
        assert!(corrector.current_latency_secs().is_none()); // No callback updates yet
        assert_eq!(corrector.estimator().update_count(), 0);

        // This test demonstrates the complete workflow for integrating
        // latency correction into audio playback systems
    }

    #[test]
    fn output_transport_kind_wireless_detection() {
        assert!(OutputTransportKind::Wireless.is_wireless());
        assert!(OutputTransportKind::Airplay.is_wireless());
        assert!(OutputTransportKind::ContinuityWireless.is_wireless());
        assert!(!OutputTransportKind::Wired.is_wireless());
        assert!(!OutputTransportKind::Unknown.is_wireless());
    }

    #[test]
    fn output_latency_hint_creation() {
        let hint = OutputLatencyHint::new(0.05, OutputTransportKind::Wired);
        assert_eq!(hint.latency_secs, 0.05);
        assert_eq!(hint.transport, OutputTransportKind::Wired);
        assert!(!hint.is_probably_wireless());
    }

    #[test]
    fn wireless_hint_detection() {
        let wireless_hint = OutputLatencyHint::new(0.12, OutputTransportKind::Wireless);
        assert!(wireless_hint.is_probably_wireless());

        let wired_hint = OutputLatencyHint::new(0.03, OutputTransportKind::Wired);
        assert!(!wired_hint.is_probably_wireless());
    }
}
