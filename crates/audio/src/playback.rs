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
            .max(FALLBACK_WIRED_LATENCY_SECS)
            .min(MAX_LATENCY_SECS);
        Some(OutputLatencyHint::new(
            fallback,
            OutputTransportKind::Unknown,
        ))
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
        let bias_secs = bias_secs.max(0.0).min(MAX_LATENCY_SECS);
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
        self.bias_secs = bias_secs.max(0.0).min(MAX_LATENCY_SECS);
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

        if let Some(prev_raw) = self.last_raw_latency_secs {
            if self.update_count < WARMUP_GUARD_SAMPLES as u64
                && clamped > prev_raw * WARMUP_SPIKE_RATIO
            {
                return;
            }
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
    use super::{
        AIRPLAY_MIN_LATENCY_SECS, MAX_LATENCY_SECS, OutputLatencyHint, OutputTransportKind,
        WIRELESS_MIN_LATENCY_SECS, transport_constraints,
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
                base_latency
                    .max(super::WIRELESS_FALLBACK_LATENCY_SECS)
                    .max(floor)
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
            if is_output_stream(&stream)? {
                if let Ok(latency) = stream.latency() {
                    max_latency = max_latency.max(latency);
                }
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
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn increases_quickly() {
        let mut estimator = OutputLatencyEstimator::new();
        estimator.observe_latency(Some(Duration::from_millis(5)));
        estimator.last_update_at = Some(Instant::now() - Duration::from_millis(300));
        estimator.observe_latency(Some(Duration::from_millis(120)));

        let latency = estimator.current_secs().unwrap();
        assert!(latency > 0.05);
    }

    #[test]
    fn decreases_slowly() {
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
    fn ignores_initial_zero() {
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
}
