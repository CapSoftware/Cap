use crate::output_pipeline::{HealthSender, PipelineHealthEvent, emit_health};
use cap_audio::estimate_input_latency;
use cap_media_info::{AudioInfo, ffmpeg_sample_format_for};
use cap_timestamp::Timestamp;
use cpal::{
    BufferSize, Device, InputCallbackInfo, SampleFormat, StreamError, SupportedStreamConfig,
    SupportedStreamConfigRange,
    traits::{DeviceTrait, HostTrait, StreamTrait},
};
use flume::TrySendError;
use futures::{FutureExt, channel::oneshot, future::BoxFuture};
use indexmap::IndexMap;
use kameo::prelude::*;
use replace_with::replace_with_or_abort;
use std::{
    collections::VecDeque,
    ops::Deref,
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, Instant},
};
use tracing::{debug, error, info, trace, warn};

pub type MicrophonesMap = IndexMap<String, (Device, SupportedStreamConfig)>;
type StreamReadyFuture =
    BoxFuture<'static, Result<(SupportedStreamConfig, Option<u32>), SetInputError>>;

const SAMPLE_RATE_ESTIMATE_MIN_INTERVALS: u32 = 4;
const SAMPLE_RATE_ESTIMATE_MIN_DELTA: Duration = Duration::from_millis(2);
const SAMPLE_RATE_ESTIMATE_MAX_DELTA: Duration = Duration::from_millis(250);
const SAMPLE_RATE_ESTIMATE_MAX_PENDING: usize = 32;
const SAMPLE_RATE_CONFIGURED_TOLERANCE: f64 = 0.05;
const SAMPLE_RATE_STANDARD_TOLERANCE: f64 = 0.04;
const PENDING_TIMESTAMP_STALE_MIN: Duration = Duration::from_millis(5);
// A newly-inferred rate must be observed this many estimation windows in a row before
// it replaces the active rate. Each window already averages
// `SAMPLE_RATE_ESTIMATE_MIN_INTERVALS` callbacks, so a single slow/jittery callback
// batch (e.g. one late buffer under CPU load) cannot mislabel a correctly-clocked
// device — which would otherwise flip a true 48k mic to 44.1k and resample it at the
// wrong ratio, pitch-/time-stretching the audio until the next clean window.
const SAMPLE_RATE_CHANGE_AGREEMENTS: u32 = 3;
const STANDARD_SAMPLE_RATES: [u32; 13] = [
    8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 176_400,
    192_000,
];

#[derive(
    serde::Serialize, serde::Deserialize, specta::Type, Clone, Copy, Debug, PartialEq, Eq, Default,
)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDeviceSettings {
    pub sample_rate: Option<u32>,
    pub channels: Option<u16>,
}

#[derive(Clone)]
pub struct MicrophoneSamples {
    pub data: Vec<u8>,
    pub format: SampleFormat,
    pub sample_rate: u32,
    pub channels: u16,
    pub info: InputCallbackInfo,
    pub timestamp: Timestamp,
}

/// Debounces sample-rate changes: a freshly-inferred rate is only adopted after it is
/// observed `SAMPLE_RATE_CHANGE_AGREEMENTS` windows in a row, so a lone divergent
/// observation cannot flip a correctly-clocked device to the wrong standard rate.
struct RateChangeGate {
    current_rate: u32,
    pending_rate: Option<u32>,
    agreements: u32,
}

impl RateChangeGate {
    fn new(rate: u32) -> Self {
        Self {
            current_rate: rate,
            pending_rate: None,
            agreements: 0,
        }
    }

    /// Feed one window's inferred rate; returns the effective (debounced) rate.
    fn observe(&mut self, inferred: u32) -> u32 {
        if inferred == self.current_rate {
            self.pending_rate = None;
            self.agreements = 0;
        } else if self.pending_rate == Some(inferred) {
            self.agreements += 1;
            if self.agreements >= SAMPLE_RATE_CHANGE_AGREEMENTS {
                self.current_rate = inferred;
                self.pending_rate = None;
                self.agreements = 0;
            }
        } else {
            self.pending_rate = Some(inferred);
            self.agreements = 1;
        }

        self.current_rate
    }

    /// Drop any in-progress candidate without changing the active rate.
    fn clear_pending(&mut self) {
        self.pending_rate = None;
        self.agreements = 0;
    }
}

struct CallbackSampleRateEstimator {
    configured_rate: u32,
    gate: RateChangeGate,
    settled: bool,
    previous_capture: Option<cpal::StreamInstant>,
    previous_frame_count: Option<usize>,
    observation: SampleRateObservation,
}

struct SampleRateEstimate {
    sample_rate: u32,
    settled: bool,
}

impl CallbackSampleRateEstimator {
    fn new(configured_rate: u32) -> Self {
        Self {
            configured_rate,
            gate: RateChangeGate::new(configured_rate),
            settled: false,
            previous_capture: None,
            previous_frame_count: None,
            observation: SampleRateObservation::new(configured_rate),
        }
    }

    fn sample_rate_for(
        &mut self,
        timestamp: cpal::InputStreamTimestamp,
        frame_count: usize,
    ) -> SampleRateEstimate {
        if let (Some(previous_capture), Some(previous_frame_count)) =
            (self.previous_capture, self.previous_frame_count)
        {
            match timestamp.capture.duration_since(&previous_capture) {
                Some(delta) => {
                    if let Some(inferred) = self.observation.push(previous_frame_count, delta) {
                        let previous_rate = self.gate.current_rate;
                        let effective = self.gate.observe(inferred);
                        if effective != previous_rate {
                            info!(
                                configured_rate = self.configured_rate,
                                previous_rate,
                                inferred_rate = effective,
                                "Microphone callback sample rate adjusted"
                            );
                        }
                        // Must stay unconditional: an inference means the rate is now
                        // known, so buffered `pending_samples` can drain even when the
                        // debounce gate withholds the change. Gating this on
                        // `effective != previous_rate` would buffer audio until the
                        // pending cap and then dump it late.
                        self.settled = true;
                        self.observation.reset();
                    }
                }
                None => self.observation.reset(),
            }
        }

        self.previous_capture = Some(timestamp.capture);
        self.previous_frame_count = Some(frame_count);
        SampleRateEstimate {
            sample_rate: self.gate.current_rate,
            settled: self.settled,
        }
    }

    fn force_current(&mut self) -> u32 {
        self.settled = true;
        self.observation.reset();
        self.gate.clear_pending();
        self.gate.current_rate
    }
}

struct SampleRateObservation {
    configured_rate: u32,
    frame_count: u64,
    duration: Duration,
    intervals: u32,
}

impl SampleRateObservation {
    fn new(configured_rate: u32) -> Self {
        Self {
            configured_rate,
            frame_count: 0,
            duration: Duration::ZERO,
            intervals: 0,
        }
    }

    fn push(&mut self, frame_count: usize, delta: Duration) -> Option<u32> {
        if frame_count == 0
            || !(SAMPLE_RATE_ESTIMATE_MIN_DELTA..=SAMPLE_RATE_ESTIMATE_MAX_DELTA).contains(&delta)
        {
            self.reset();
            return None;
        }

        self.frame_count = self.frame_count.saturating_add(frame_count as u64);
        self.duration = self.duration.saturating_add(delta);
        self.intervals = self.intervals.saturating_add(1);

        if self.intervals < SAMPLE_RATE_ESTIMATE_MIN_INTERVALS {
            return None;
        }

        self.inferred_rate()
    }

    fn reset(&mut self) {
        self.frame_count = 0;
        self.duration = Duration::ZERO;
        self.intervals = 0;
    }

    fn inferred_rate(&self) -> Option<u32> {
        let duration_secs = self.duration.as_secs_f64();
        if duration_secs <= 0.0 {
            return None;
        }

        let observed_rate = self.frame_count as f64 / duration_secs;
        if relative_delta(self.configured_rate as f64, observed_rate)
            <= SAMPLE_RATE_CONFIGURED_TOLERANCE
        {
            return Some(self.configured_rate);
        }

        nearest_standard_sample_rate(observed_rate)
    }
}

fn nearest_standard_sample_rate(observed_rate: f64) -> Option<u32> {
    STANDARD_SAMPLE_RATES
        .iter()
        .copied()
        .min_by(|a, b| {
            relative_delta(*a as f64, observed_rate)
                .total_cmp(&relative_delta(*b as f64, observed_rate))
        })
        .filter(|rate| {
            relative_delta(*rate as f64, observed_rate) <= SAMPLE_RATE_STANDARD_TOLERANCE
        })
}

fn relative_delta(a: f64, b: f64) -> f64 {
    if b <= f64::EPSILON {
        return f64::INFINITY;
    }

    ((a - b) / b).abs()
}

fn callback_frame_count(data_len: usize, sample_format: SampleFormat, channels: u16) -> usize {
    let bytes_per_frame = sample_format
        .sample_size()
        .saturating_mul(usize::from(channels.max(1)));

    if bytes_per_frame == 0 {
        return 0;
    }

    data_len / bytes_per_frame
}

fn timestamp_duration_since(current: Timestamp, start: Timestamp) -> Option<Duration> {
    match (current, start) {
        (Timestamp::Instant(current), Timestamp::Instant(start)) => {
            current.checked_duration_since(start)
        }
        (Timestamp::SystemTime(current), Timestamp::SystemTime(start)) => {
            current.duration_since(start).ok()
        }
        #[cfg(windows)]
        (Timestamp::PerformanceCounter(current), Timestamp::PerformanceCounter(start)) => {
            current.checked_duration_since(start)
        }
        #[cfg(target_os = "macos")]
        (Timestamp::MachAbsoluteTime(current), Timestamp::MachAbsoluteTime(start)) => {
            current.checked_duration_since(start)
        }
        _ => None,
    }
}

fn pending_timestamp_stale_threshold(sample_duration: Duration) -> Duration {
    let half_duration = Duration::from_secs_f64(sample_duration.as_secs_f64() * 0.5);
    PENDING_TIMESTAMP_STALE_MIN.max(half_duration)
}

fn normalize_pending_timestamp(
    timestamp: &mut Timestamp,
    expected: Option<Timestamp>,
    stale_threshold: Duration,
) -> bool {
    let Some(expected) = expected else {
        return false;
    };

    if timestamp_duration_since(*timestamp, expected).is_some() {
        return false;
    }

    let Some(stale_by) = timestamp_duration_since(expected, *timestamp) else {
        return false;
    };

    if stale_by < stale_threshold {
        return false;
    }

    *timestamp = expected;
    true
}

fn microphone_sample_duration(samples: &MicrophoneSamples) -> Duration {
    let frame_count = callback_frame_count(samples.data.len(), samples.format, samples.channels);
    if frame_count == 0 || samples.sample_rate == 0 {
        return Duration::ZERO;
    }

    Duration::from_secs_f64(frame_count as f64 / samples.sample_rate as f64)
}

fn normalize_pending_timestamps<'a>(
    pending_timestamps: impl IntoIterator<Item = (&'a mut Timestamp, Duration)>,
) -> u32 {
    let mut next_timestamp = None;
    let mut adjusted_frames = 0u32;

    for (timestamp, sample_duration) in pending_timestamps {
        if normalize_pending_timestamp(
            timestamp,
            next_timestamp,
            pending_timestamp_stale_threshold(sample_duration),
        ) {
            adjusted_frames = adjusted_frames.saturating_add(1);
        }
        next_timestamp = Some(*timestamp + sample_duration);
    }

    adjusted_frames
}

fn prepare_pending_samples(pending_samples: &mut VecDeque<MicrophoneSamples>, sample_rate: u32) {
    let adjusted_frames = normalize_pending_timestamps(pending_samples.iter_mut().map(|pending| {
        pending.sample_rate = sample_rate;
        let sample_duration = microphone_sample_duration(pending);
        (&mut pending.timestamp, sample_duration)
    }));

    if adjusted_frames > 0 {
        debug!(
            adjusted_frames,
            sample_rate, "Normalized stale pending microphone timestamps"
        );
    }
}

fn enqueue_microphone_samples(
    actor_ref: &ActorRef<MicrophoneFeed>,
    dropped_message_count: &AtomicU64,
    samples: MicrophoneSamples,
) {
    if let Err(error) = actor_ref.tell(samples).try_send() {
        dropped_message_count.fetch_add(1, Ordering::Relaxed);
        warn!("Failed to enqueue microphone samples: {error}");
    }
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    input_id_counter: u32,
    lock_generation: u64,
    state: State,
    senders: Vec<MicrophoneFeedSender>,
    error_sender: flume::Sender<StreamError>,
    dropped_message_count: Arc<AtomicU64>,
}

struct MicrophoneFeedSender {
    sender: flume::Sender<MicrophoneSamples>,
    health_tx: Option<HealthSender>,
    label: Option<String>,
    stalled_since: Option<Instant>,
    last_stalled_event: Option<Instant>,
}

impl MicrophoneFeedSender {
    fn new(sender: flume::Sender<MicrophoneSamples>) -> Self {
        Self {
            sender,
            health_tx: None,
            label: None,
            stalled_since: None,
            last_stalled_event: None,
        }
    }

    fn recording(
        sender: flume::Sender<MicrophoneSamples>,
        health_tx: HealthSender,
        label: String,
    ) -> Self {
        Self {
            sender,
            health_tx: Some(health_tx),
            label: Some(label),
            stalled_since: None,
            last_stalled_event: None,
        }
    }

    fn reset_stall(&mut self) {
        self.stalled_since = None;
        self.last_stalled_event = None;
    }
}

enum State {
    Open(OpenState),
    Locked {
        inner: AttachedState,
        token: Weak<()>,
    },
}

impl State {
    fn try_as_open(&mut self) -> Result<&mut OpenState, FeedLockedError> {
        let is_stale = matches!(self, Self::Locked { token, .. } if token.strong_count() == 0);

        if is_stale {
            warn!("Detected stale microphone feed lock, auto-recovering");
            replace_with_or_abort(self, |state| {
                if let Self::Locked { inner, .. } = state {
                    Self::Open(OpenState {
                        connecting: None,
                        attached: Some(inner),
                    })
                } else {
                    state
                }
            });
        }

        if let Self::Open(open_state) = self {
            Ok(open_state)
        } else {
            Err(FeedLockedError)
        }
    }
}

struct OpenState {
    connecting: Option<ConnectingState>,
    attached: Option<AttachedState>,
}

impl OpenState {
    fn handle_input_connected(&mut self, data: InputConnected) {
        if let Some(connecting) = &self.connecting
            && data.id == connecting.id
        {
            self.attached = Some(AttachedState {
                id: data.id,
                label: data.label.clone(),
                config: data.config.clone(),
                buffer_size_frames: data.buffer_size_frames,
                done_tx: data.done_tx,
            });
            self.connecting = None;
        }
    }
}

struct ConnectingState {
    id: u32,
    ready: BoxFuture<'static, Result<InputConnected, SetInputError>>,
}

struct AttachedState {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: mpsc::SyncSender<()>,
}

#[cfg(target_os = "macos")]
fn list_input_device_names() -> Vec<String> {
    use coreaudio::audio_unit::{Scope, macos_helpers};

    let mut names = IndexMap::new();
    let default_id = macos_helpers::get_default_device_id(true);

    if let Some(name) = default_id
        .and_then(|id| macos_helpers::get_device_name(id).ok())
        .filter(|name| !name.is_empty())
    {
        names.insert(name, ());
    }

    match macos_helpers::get_audio_device_ids_for_scope(Scope::Input) {
        Ok(device_ids) => {
            for device_id in device_ids {
                if macos_helpers::get_audio_device_supports_scope(device_id, Scope::Input)
                    .unwrap_or(false)
                    && let Ok(name) = macos_helpers::get_device_name(device_id)
                    && !name.is_empty()
                {
                    names.entry(name).or_insert(());
                }
            }
        }
        Err(error) => {
            error!("Could not access audio input devices: {}", error);
        }
    }

    names.into_keys().collect()
}

#[cfg(not(target_os = "macos"))]
fn list_input_device_names() -> Vec<String> {
    let host = cpal::default_host();
    let mut names = IndexMap::new();

    if let Some(name) = host
        .default_input_device()
        .and_then(|device| device.name().ok())
    {
        names.insert(name, ());
    }

    match host.input_devices() {
        Ok(devices) => {
            for name in devices.filter_map(|device| device.name().ok()) {
                names.entry(name).or_insert(());
            }
        }
        Err(error) => {
            error!("Could not access audio input devices: {}", error);
        }
    }

    names.into_keys().collect()
}

impl MicrophoneFeed {
    pub fn new(error_sender: flume::Sender<StreamError>) -> Self {
        Self {
            input_id_counter: 0,
            lock_generation: 0,
            state: State::Open(OpenState {
                connecting: None,
                attached: None,
            }),
            senders: Vec::new(),
            error_sender,
            dropped_message_count: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn default_device() -> Option<(String, Device, SupportedStreamConfig)> {
        let host = cpal::default_host();
        host.default_input_device()
            .and_then(|device| get_usable_device(device, None))
    }

    pub fn list() -> MicrophonesMap {
        Self::list_with_settings(None)
    }

    pub fn list_names() -> Vec<String> {
        list_input_device_names()
    }

    pub fn list_with_settings(settings: Option<&MicrophoneDeviceSettings>) -> MicrophonesMap {
        let host = cpal::default_host();
        let mut device_map = IndexMap::new();

        if let Some((name, device, config)) = host
            .default_input_device()
            .and_then(|device| get_usable_device(device, settings))
        {
            device_map.insert(name, (device, config));
        }

        match host.input_devices() {
            Ok(devices) => {
                for (name, device, config) in
                    devices.filter_map(|device| get_usable_device(device, settings))
                {
                    device_map.entry(name).or_insert((device, config));
                }
            }
            Err(error) => {
                error!("Could not access audio input devices: {}", error);
            }
        }

        device_map
    }

    fn spawn_input_stream(params: StreamSpawnParams) -> (StreamReadyFuture, SyncSender<()>) {
        let StreamSpawnParams {
            id,
            label,
            device,
            config,
            stream_config,
            buffer_size_frames,
            sample_format,
            actor_ref,
            error_sender,
            dropped_message_count,
            log_action,
        } = params;

        let (ready_tx, ready_rx) = oneshot::channel::<Result<Option<u32>, SetInputError>>();
        let (done_tx, done_rx) = mpsc::sync_channel(0);

        let ready = {
            let config_for_ready = config.clone();
            ready_rx
                .map(move |v| {
                    let config = config_for_ready.clone();
                    v.map_err(|_| SetInputError::BuildStreamCrashed)
                        .and_then(|inner| inner)
                        .map(|buffer_size| (config, buffer_size))
                })
                .boxed()
        };

        std::thread::spawn({
            let stream_config = stream_config.clone();
            let config = config.clone();
            let actor_ref = actor_ref.clone();
            let error_sender = error_sender.clone();
            let dropped_message_count = dropped_message_count.clone();
            move || {
                let device_name_for_log = device.name().ok();

                if let Some(ref name) = device_name_for_log {
                    info!("Device '{}' available configs:", name);
                    for config in device.supported_input_configs().into_iter().flatten() {
                        info!(
                            "  Format: {:?}, Min rate: {}, Max rate: {}, Sample size: {}",
                            config.sample_format(),
                            config.min_sample_rate().0,
                            config.max_sample_rate().0,
                            config.sample_format().sample_size()
                        );
                    }
                }

                let buffer_size_description = match &stream_config.buffer_size {
                    BufferSize::Default => "default".to_string(),
                    BufferSize::Fixed(frames) => format!(
                        "{} frames (~{:.1}ms)",
                        frames,
                        (*frames as f64 / config.sample_rate().0 as f64) * 1000.0
                    ),
                };

                info!(
                    "🎤 {} stream (id {}, label '{}') for '{:?}' with config: rate={}, channels={}, format={:?}, buffer_size={}",
                    log_action.verb(),
                    id,
                    label,
                    device_name_for_log,
                    config.sample_rate().0,
                    config.channels(),
                    sample_format,
                    buffer_size_description
                );

                let callback_sample_rate = config.sample_rate().0;
                let callback_channels = config.channels();
                let mut sample_rate_estimator =
                    CallbackSampleRateEstimator::new(callback_sample_rate);
                let mut pending_samples = VecDeque::new();

                let stream = match device.build_input_stream_raw(
                    &stream_config,
                    sample_format,
                    {
                        let actor_ref = actor_ref.clone();
                        let mut callback_count = 0u64;
                        move |data, info| {
                            let frame_count = callback_frame_count(
                                data.bytes().len(),
                                data.sample_format(),
                                callback_channels,
                            );
                            let input_timestamp = info.timestamp();
                            let effective_sample_rate =
                                sample_rate_estimator.sample_rate_for(input_timestamp, frame_count);

                            if callback_count == 0 {
                                info!(
                                    "🎤 First audio callback - data size: {} bytes, frames: {}, format: {:?}, rate: {}",
                                    data.bytes().len(),
                                    frame_count,
                                    data.sample_format(),
                                    effective_sample_rate.sample_rate
                                );
                            }
                            callback_count += 1;

                            let samples = MicrophoneSamples {
                                data: data.bytes().to_vec(),
                                format: data.sample_format(),
                                sample_rate: effective_sample_rate.sample_rate,
                                channels: callback_channels,
                                info: info.clone(),
                                timestamp: Timestamp::from_cpal(input_timestamp.capture),
                            };

                            if !effective_sample_rate.settled {
                                pending_samples.push_back(samples);
                                if pending_samples.len() >= SAMPLE_RATE_ESTIMATE_MAX_PENDING {
                                    let sample_rate = sample_rate_estimator.force_current();
                                    prepare_pending_samples(&mut pending_samples, sample_rate);
                                    while let Some(pending) = pending_samples.pop_front() {
                                        enqueue_microphone_samples(
                                            &actor_ref,
                                            &dropped_message_count,
                                            pending,
                                        );
                                    }
                                }
                                return;
                            }

                            prepare_pending_samples(
                                &mut pending_samples,
                                effective_sample_rate.sample_rate,
                            );
                            while let Some(pending) = pending_samples.pop_front() {
                                enqueue_microphone_samples(
                                    &actor_ref,
                                    &dropped_message_count,
                                    pending,
                                );
                            }

                            enqueue_microphone_samples(
                                &actor_ref,
                                &dropped_message_count,
                                samples,
                            );
                        }
                    },
                    move |e| {
                        error!("Microphone stream error: {e}");

                        let _ = error_sender.send(e).is_err();
                    },
                    None,
                ) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(SetInputError::BuildStream(e.to_string())));
                        return;
                    }
                };

                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(SetInputError::PlayStream(e.to_string())));
                    return;
                }

                let _ = ready_tx.send(Ok(buffer_size_frames));

                match done_rx.recv() {
                    Ok(_) => debug!("Microphone actor shut down, ending stream"),
                    Err(_) => debug!("Microphone shutdown signal channel closed, ending stream"),
                }
            }
        });

        (ready, done_tx)
    }
}

fn get_usable_device(
    device: Device,
    settings: Option<&MicrophoneDeviceSettings>,
) -> Option<(String, Device, SupportedStreamConfig)> {
    let device_name_for_logging = device.name().ok();

    let native_rate = device
        .default_input_config()
        .ok()
        .map(|c| c.sample_rate().0)
        .unwrap_or(48_000);
    let preferred_rate = cpal::SampleRate(native_rate);

    let result = device
        .supported_input_configs()
        .map_err(|error| {
            error!(
                "Error getting supported input configs for device {:?}: {}",
                device_name_for_logging, error
            );
            error
        })
        .ok()
        .and_then(|configs| {
            let mut configs = configs.collect::<Vec<_>>();

            configs.sort_by(|a, b| {
                b.sample_format()
                    .sample_size()
                    .cmp(&a.sample_format().sample_size())
                    .then(b.max_sample_rate().cmp(&a.max_sample_rate()))
            });

            if let Some(settings) = settings
                && let Some(config) = select_preferred_config(&configs, settings)
            {
                return Some(config);
            }

            if let Some(config) = configs.iter().find(|config| {
                ffmpeg_sample_format_for(config.sample_format()).is_some()
                    && config.min_sample_rate().0 <= preferred_rate.0
                    && config.max_sample_rate().0 >= preferred_rate.0
            }) {
                return Some(config.with_sample_rate(preferred_rate));
            }

            configs.into_iter().find_map(|config| {
                ffmpeg_sample_format_for(config.sample_format())
                    .map(|_| config.with_sample_rate(select_sample_rate(&config)))
            })
        });

    result.and_then(|config| device.name().ok().map(|name| (name, device, config)))
}

fn select_preferred_config(
    configs: &[SupportedStreamConfigRange],
    settings: &MicrophoneDeviceSettings,
) -> Option<SupportedStreamConfig> {
    let rate = settings.sample_rate.map(cpal::SampleRate);
    let compatible_configs = configs
        .iter()
        .filter(|config| ffmpeg_sample_format_for(config.sample_format()).is_some())
        .collect::<Vec<_>>();

    let find_config = |channels: Option<u16>, rate: Option<cpal::SampleRate>| {
        compatible_configs.iter().find(|config| {
            channels.is_none_or(|channels| config.channels() == channels)
                && rate.is_none_or(|rate| {
                    config.min_sample_rate().0 <= rate.0 && config.max_sample_rate().0 >= rate.0
                })
        })
    };

    let config = find_config(settings.channels, rate)
        .or_else(|| rate.and_then(|rate| find_config(None, Some(rate))))
        .or_else(|| {
            settings
                .channels
                .and_then(|channels| find_config(Some(channels), None))
        })?;
    let sample_rate = rate
        .filter(|rate| supports_sample_rate(config, *rate))
        .unwrap_or_else(|| select_sample_rate(config));

    config.try_with_sample_rate(sample_rate)
}

fn supports_sample_rate(config: &SupportedStreamConfigRange, rate: cpal::SampleRate) -> bool {
    config.min_sample_rate().0 <= rate.0 && rate.0 <= config.max_sample_rate().0
}

fn select_sample_rate(config: &SupportedStreamConfigRange) -> cpal::SampleRate {
    const PREFERRED_RATES: [u32; 2] = [48_000, 44_100];

    for rate in PREFERRED_RATES {
        if config.min_sample_rate().0 <= rate && config.max_sample_rate().0 >= rate {
            return cpal::SampleRate(rate);
        }
    }

    cpal::SampleRate(config.max_sample_rate().0)
}

const TARGET_LATENCY_MS: u32 = 35;
const MIN_LATENCY_MS: u32 = 10;
const MAX_LATENCY_MS: u32 = 120;
const ABS_MIN_BUFFER_FRAMES: u32 = 128;

const WIRELESS_TARGET_LATENCY_MS: u32 = 80;
const WIRELESS_MIN_LATENCY_MS: u32 = 50;
const WIRELESS_MAX_LATENCY_MS: u32 = 200;

fn stream_config_with_latency(
    config: &SupportedStreamConfig,
    device_name: Option<&str>,
) -> (cpal::StreamConfig, Option<u32>) {
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    let buffer_size_frames = desired_buffer_size_frames(config, device_name);

    if let Some(frames) = buffer_size_frames {
        stream_config.buffer_size = BufferSize::Fixed(frames);
    }

    (stream_config, buffer_size_frames)
}

fn desired_buffer_size_frames(
    config: &SupportedStreamConfig,
    device_name: Option<&str>,
) -> Option<u32> {
    match config.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => {
            let sample_rate = config.sample_rate().0;

            if sample_rate == 0 || *max == 0 {
                return None;
            }

            let latency_info = estimate_input_latency(sample_rate, 1024, device_name);
            let is_wireless = latency_info.transport.is_wireless();

            let (target_ms, min_ms, max_ms) = if is_wireless {
                info!(
                    "Detected wireless microphone '{}', using extended buffer settings",
                    device_name.unwrap_or("unknown")
                );
                (
                    WIRELESS_TARGET_LATENCY_MS,
                    WIRELESS_MIN_LATENCY_MS,
                    WIRELESS_MAX_LATENCY_MS,
                )
            } else {
                (TARGET_LATENCY_MS, MIN_LATENCY_MS, MAX_LATENCY_MS)
            };

            let desired = latency_ms_to_frames(sample_rate, target_ms);
            let min_latency_frames = latency_ms_to_frames(sample_rate, min_ms);
            let max_latency_frames = latency_ms_to_frames(sample_rate, max_ms);

            let desired = desired.clamp(min_latency_frames, max_latency_frames);
            let device_max = *max;
            let device_min = ABS_MIN_BUFFER_FRAMES.min(device_max).max(*min);

            Some(desired.clamp(device_min, device_max))
        }
        cpal::SupportedBufferSize::Unknown => None,
    }
}

fn latency_ms_to_frames(sample_rate: u32, milliseconds: u32) -> u32 {
    let frames = (sample_rate as u64 * milliseconds as u64) / 1_000;
    frames.max(1) as u32
}

#[derive(Reply)]
pub struct MicrophoneFeedLock {
    actor: ActorRef<MicrophoneFeed>,
    config: SupportedStreamConfig,
    audio_info: AudioInfo,
    buffer_size_frames: Option<u32>,
    drop_tx: Option<oneshot::Sender<()>>,
    device_name: String,
    _token: Arc<()>,
}

impl MicrophoneFeedLock {
    pub fn config(&self) -> &SupportedStreamConfig {
        &self.config
    }

    pub fn audio_info(&self) -> AudioInfo {
        self.audio_info
    }

    pub fn buffer_size_frames(&self) -> Option<u32> {
        self.buffer_size_frames
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    pub async fn dropped_message_count(&self) -> u64 {
        self.actor.ask(GetDroppedMessageCount).await.unwrap_or(0)
    }
}

impl Deref for MicrophoneFeedLock {
    type Target = ActorRef<MicrophoneFeed>;

    fn deref(&self) -> &Self::Target {
        &self.actor
    }
}

impl Drop for MicrophoneFeedLock {
    fn drop(&mut self) {
        if let Some(drop_tx) = self.drop_tx.take() {
            let _ = drop_tx.send(());
        }
    }
}

// Public Requests

pub struct SetInput {
    pub label: String,
    pub settings: Option<MicrophoneDeviceSettings>,
}

pub struct RemoveInput;

pub struct AddSender(pub flume::Sender<MicrophoneSamples>);

pub struct RemoveSender(pub flume::Sender<MicrophoneSamples>);

pub struct AddRecordingSender {
    pub sender: flume::Sender<MicrophoneSamples>,
    pub health_tx: HealthSender,
    pub label: String,
}

pub struct Lock;

pub struct GetDroppedMessageCount;

// Private Events

struct InputConnected {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: SyncSender<()>,
}

struct LockedInputReconnected {
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: mpsc::SyncSender<()>,
}

struct InputConnectFailed {
    id: u32,
}

struct Unlock {
    generation: u64,
}

#[derive(Clone, Copy)]
enum StreamLogAction {
    Build,
    Rebuild,
}

impl StreamLogAction {
    fn verb(&self) -> &'static str {
        match self {
            Self::Build => "Building",
            Self::Rebuild => "Rebuilding",
        }
    }
}

struct StreamSpawnParams {
    id: u32,
    label: String,
    device: Device,
    config: SupportedStreamConfig,
    stream_config: cpal::StreamConfig,
    buffer_size_frames: Option<u32>,
    sample_format: SampleFormat,
    actor_ref: ActorRef<MicrophoneFeed>,
    error_sender: flume::Sender<StreamError>,
    dropped_message_count: Arc<AtomicU64>,
    log_action: StreamLogAction,
}

// Impls

#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error("FeedLocked")]
pub struct FeedLockedError;

#[derive(Clone, Debug, thiserror::Error)]
pub enum SetInputError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("DeviceNotFound")]
    DeviceNotFound,
    #[error("BuildStreamCrashed")]
    BuildStreamCrashed,
    // we use strings for these as the cpal errors aren't Clone
    #[error("BuildStream: {0}")]
    BuildStream(String),
    #[error("PlayStream: {0}")]
    PlayStream(String),
}

impl Message<SetInput> for MicrophoneFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;

    async fn handle(&mut self, msg: SetInput, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.SetInput('{}')", &msg.label);

        match &mut self.state {
            State::Open(state) => {
                let id = self.input_id_counter;
                self.input_id_counter += 1;

                let label = msg.label.clone();
                let Some((device, config)) =
                    Self::list_with_settings(msg.settings.as_ref()).swap_remove(&label)
                else {
                    return Err(SetInputError::DeviceNotFound);
                };

                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) =
                    stream_config_with_latency(&config, Some(&label));

                let actor_ref = ctx.actor_ref();
                let (ready_future, done_tx) = Self::spawn_input_stream(StreamSpawnParams {
                    id,
                    label: label.clone(),
                    device,
                    config,
                    stream_config,
                    buffer_size_frames,
                    sample_format,
                    actor_ref: actor_ref.clone(),
                    error_sender: self.error_sender.clone(),
                    dropped_message_count: self.dropped_message_count.clone(),
                    log_action: StreamLogAction::Build,
                });
                let ready = ready_future.shared();

                state.connecting = Some(ConnectingState {
                    id,
                    ready: {
                        let done_tx = done_tx.clone();
                        ready
                            .clone()
                            .map({
                                let label = label.clone();
                                move |v| {
                                    let label = label.clone();
                                    v.map(|(config, buffer_size_frames)| InputConnected {
                                        id,
                                        label,
                                        config,
                                        buffer_size_frames,
                                        done_tx,
                                    })
                                }
                            })
                            .boxed()
                    },
                });

                tokio::spawn({
                    let ready = ready.clone();
                    let actor = actor_ref.clone();
                    let done_tx = done_tx.clone();
                    let label = label.clone();
                    async move {
                        match ready.await {
                            Ok((config, buffer_size_frames)) => {
                                let _ = actor
                                    .tell(InputConnected {
                                        id,
                                        label,
                                        config,
                                        buffer_size_frames,
                                        done_tx,
                                    })
                                    .await;
                            }
                            Err(_) => {
                                let _ = actor.tell(InputConnectFailed { id }).await;
                            }
                        }
                    }
                });

                let ready_for_return = ready
                    .clone()
                    .map(|result| result.map(|(config, _)| config))
                    .boxed();

                Ok(ready_for_return)
            }
            State::Locked { inner, .. } => {
                if inner.label != msg.label {
                    return Err(SetInputError::Locked(FeedLockedError));
                }

                let label = msg.label.clone();
                let Some((device, config)) =
                    Self::list_with_settings(msg.settings.as_ref()).swap_remove(&label)
                else {
                    return Err(SetInputError::DeviceNotFound);
                };

                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) =
                    stream_config_with_latency(&config, Some(&label));

                let new_id = self.input_id_counter;
                self.input_id_counter += 1;

                let _ = inner.done_tx.send(());

                let actor_ref = ctx.actor_ref();
                let (ready_future, done_tx) = Self::spawn_input_stream(StreamSpawnParams {
                    id: new_id,
                    label: label.clone(),
                    device,
                    config,
                    stream_config,
                    buffer_size_frames,
                    sample_format,
                    actor_ref: actor_ref.clone(),
                    error_sender: self.error_sender.clone(),
                    dropped_message_count: self.dropped_message_count.clone(),
                    log_action: StreamLogAction::Rebuild,
                });
                let ready = ready_future.shared();

                tokio::spawn({
                    let ready = ready.clone();
                    let actor = actor_ref;
                    let done_tx = done_tx.clone();
                    let label = label.clone();
                    async move {
                        if let Ok((config, buffer_size_frames)) = ready.await {
                            let _ = actor
                                .tell(LockedInputReconnected {
                                    id: new_id,
                                    label,
                                    config,
                                    buffer_size_frames,
                                    done_tx,
                                })
                                .await;
                        }
                    }
                });

                let ready_for_return = ready.map(|result| result.map(|(config, _)| config)).boxed();

                Ok(ready_for_return)
            }
        }
    }
}

impl Message<RemoveInput> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(&mut self, _: RemoveInput, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.RemoveInput");

        let state = self.state.try_as_open()?;

        state.connecting = None;

        if let Some(AttachedState { done_tx, .. }) = state.attached.take() {
            let _ = done_tx.send(());
        }

        Ok(())
    }
}

impl Message<AddSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: AddSender, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        self.senders.push(MicrophoneFeedSender::new(msg.0));
    }
}

impl Message<RemoveSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: RemoveSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.senders
            .retain(|sender| !sender.sender.same_channel(&msg.0));
    }
}

impl Message<AddRecordingSender> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: AddRecordingSender,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.senders.push(MicrophoneFeedSender::recording(
            msg.sender,
            msg.health_tx,
            msg.label,
        ));
    }
}

impl Message<MicrophoneSamples> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: MicrophoneSamples,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        let mut to_remove = vec![];
        let now = Instant::now();
        let stall_emit_interval = Duration::from_secs(5);

        for (i, sender) in self.senders.iter_mut().enumerate() {
            match sender.sender.try_send(msg.clone()) {
                Ok(()) => sender.reset_stall(),
                Err(TrySendError::Full(_)) => {
                    let stalled_since = sender.stalled_since.get_or_insert(now);
                    let should_emit = sender
                        .last_stalled_event
                        .is_none_or(|last| now.duration_since(last) >= stall_emit_interval);
                    if should_emit {
                        sender.last_stalled_event = Some(now);
                        if let (Some(health_tx), Some(label)) = (&sender.health_tx, &sender.label) {
                            emit_health(
                                health_tx,
                                PipelineHealthEvent::Stalled {
                                    source: label.clone(),
                                    waited_ms: now.duration_since(*stalled_since).as_millis()
                                        as u64,
                                },
                            );
                        }
                    }
                }
                Err(TrySendError::Disconnected(_)) => {
                    debug!("Audio sender {} closed, will be removed", i);
                    to_remove.push(i);
                }
            }
        }

        if !to_remove.is_empty() {
            debug!("Removing {} closed audio senders", to_remove.len());
            for i in to_remove.into_iter().rev() {
                self.senders.swap_remove(i);
            }
        }
    }
}

#[derive(Clone, Debug, thiserror::Error)]
pub enum LockFeedError {
    #[error(transparent)]
    Locked(#[from] FeedLockedError),
    #[error("NoInput")]
    NoInput,
    #[error("InitializeFailed/{0}")]
    InitializeFailed(#[from] SetInputError),
}

impl Message<Lock> for MicrophoneFeed {
    type Reply = Result<MicrophoneFeedLock, LockFeedError>;

    async fn handle(&mut self, _: Lock, ctx: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Lock");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &mut state.connecting {
            let ready = &mut connecting.ready;
            let data = ready.await?;

            state.handle_input_connected(data);
        }

        let Some(attached) = state.attached.take() else {
            return Err(LockFeedError::NoInput);
        };

        let config = attached.config.clone();
        let buffer_size_frames = attached.buffer_size_frames;
        let device_name = attached.label.clone();

        self.lock_generation += 1;
        let generation = self.lock_generation;
        let token = Arc::new(());
        let token_weak = Arc::downgrade(&token);

        self.state = State::Locked {
            inner: attached,
            token: token_weak,
        };

        let (drop_tx, drop_rx) = oneshot::channel();

        let actor_ref = ctx.actor_ref();
        tokio::spawn(async move {
            let _ = drop_rx.await;
            let _ = actor_ref.tell(Unlock { generation }).await;
        });

        let latency_info = estimate_input_latency(
            config.sample_rate().0,
            buffer_size_frames.unwrap_or(1024),
            Some(&device_name),
        );
        let audio_info = AudioInfo::from_stream_config_with_buffer(&config, buffer_size_frames)
            .with_wireless_transport(latency_info.transport.is_wireless());

        Ok(MicrophoneFeedLock {
            audio_info,
            actor: ctx.actor_ref(),
            config,
            buffer_size_frames,
            drop_tx: Some(drop_tx),
            device_name,
            _token: token,
        })
    }
}

impl Message<GetDroppedMessageCount> for MicrophoneFeed {
    type Reply = u64;

    async fn handle(
        &mut self,
        _: GetDroppedMessageCount,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.dropped_message_count.load(Ordering::Relaxed)
    }
}

impl Message<InputConnected> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnected");

        let state = self.state.try_as_open()?;

        state.handle_input_connected(msg);

        Ok(())
    }
}

impl Message<InputConnectFailed> for MicrophoneFeed {
    type Reply = Result<(), FeedLockedError>;

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnectFailed");

        let state = self.state.try_as_open()?;

        if let Some(connecting) = &state.connecting
            && connecting.id == msg.id
        {
            state.connecting = None;
        }

        Ok(())
    }
}

impl Message<LockedInputReconnected> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: LockedInputReconnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if let State::Locked { inner, .. } = &mut self.state
            && inner.label == msg.label
        {
            inner.id = msg.id;
            inner.config = msg.config;
            inner.buffer_size_frames = msg.buffer_size_frames;
            inner.done_tx = msg.done_tx;
        }
    }
}

impl Message<Unlock> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: Unlock, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
        trace!("MicrophoneFeed.Unlock(gen={})", msg.generation);

        if msg.generation != self.lock_generation {
            trace!(
                "Ignoring stale microphone unlock (msg gen {} != current {})",
                msg.generation, self.lock_generation
            );
            return;
        }

        replace_with_or_abort(&mut self.state, |state| {
            if let State::Locked { inner, .. } = state {
                State::Open(OpenState {
                    connecting: None,
                    attached: Some(inner),
                })
            } else {
                state
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_range(rate: u32, channels: u16) -> SupportedStreamConfigRange {
        SupportedStreamConfigRange::new(
            channels,
            cpal::SampleRate(rate),
            cpal::SampleRate(rate),
            cpal::SupportedBufferSize::Unknown,
            SampleFormat::F32,
        )
    }

    fn estimate_rate(
        configured_rate: u32,
        frames_per_interval: usize,
        interval: Duration,
    ) -> Option<u32> {
        let mut observation = SampleRateObservation::new(configured_rate);
        let mut result = None;

        for _ in 0..SAMPLE_RATE_ESTIMATE_MIN_INTERVALS {
            result = observation.push(frames_per_interval, interval);
        }

        result
    }

    #[test]
    fn sample_rate_observation_keeps_configured_rate() {
        assert_eq!(
            estimate_rate(48_000, 480, Duration::from_millis(10)),
            Some(48_000)
        );
    }

    #[test]
    fn sample_rate_observation_keeps_configured_rate_for_small_jitter() {
        assert_eq!(
            estimate_rate(48_000, 458, Duration::from_millis(10)),
            Some(48_000)
        );
    }

    #[test]
    fn sample_rate_observation_detects_double_rate() {
        assert_eq!(
            estimate_rate(48_000, 960, Duration::from_millis(10)),
            Some(96_000)
        );
    }

    #[test]
    fn sample_rate_observation_detects_double_44100_rate() {
        assert_eq!(
            estimate_rate(44_100, 882, Duration::from_millis(10)),
            Some(88_200)
        );
    }

    #[test]
    fn sample_rate_observation_detects_lower_standard_rate() {
        assert_eq!(
            estimate_rate(48_000, 441, Duration::from_millis(10)),
            Some(44_100)
        );
    }

    #[test]
    fn sample_rate_observation_detects_half_standard_rate() {
        assert_eq!(
            estimate_rate(48_000, 240, Duration::from_millis(10)),
            Some(24_000)
        );
    }

    #[test]
    fn sample_rate_observation_ignores_distant_nonstandard_rate() {
        assert_eq!(estimate_rate(48_000, 550, Duration::from_millis(10)), None);
    }

    #[test]
    fn rate_change_gate_debounces_single_window_flip() {
        let mut gate = RateChangeGate::new(48_000);

        // A lone divergent window must not change the active rate...
        assert_eq!(gate.observe(44_100), 48_000);
        // ...and a window back at the true rate clears the candidate.
        assert_eq!(gate.observe(48_000), 48_000);
        assert_eq!(gate.observe(44_100), 48_000);
        assert_eq!(gate.observe(48_000), 48_000);

        // Only SAMPLE_RATE_CHANGE_AGREEMENTS consecutive agreeing windows switch.
        assert_eq!(gate.observe(44_100), 48_000);
        assert_eq!(gate.observe(44_100), 48_000);
        assert_eq!(gate.observe(44_100), 44_100);
    }

    #[test]
    fn rate_change_gate_resets_candidate_on_disagreement() {
        let mut gate = RateChangeGate::new(48_000);

        assert_eq!(gate.observe(44_100), 48_000);
        // A different candidate restarts the agreement count.
        assert_eq!(gate.observe(24_000), 48_000);
        assert_eq!(gate.observe(24_000), 48_000);
        assert_eq!(gate.observe(24_000), 24_000);
    }

    #[test]
    fn rate_change_gate_clear_pending_keeps_active_rate() {
        let mut gate = RateChangeGate::new(48_000);

        assert_eq!(gate.observe(44_100), 48_000);
        gate.clear_pending();
        // After clearing, the candidate must start over rather than flip early.
        assert_eq!(gate.observe(44_100), 48_000);
        assert_eq!(gate.observe(44_100), 48_000);
        assert_eq!(gate.observe(44_100), 44_100);
    }

    #[test]
    fn callback_frame_count_uses_channel_count() {
        let frames =
            callback_frame_count(960 * 2 * std::mem::size_of::<f32>(), SampleFormat::F32, 2);

        assert_eq!(frames, 960);
    }

    #[test]
    fn normalize_pending_timestamp_advances_stale_startup_timestamps() {
        let base = Timestamp::Instant(Instant::now());
        let expected = base + Duration::from_millis(35);
        let mut timestamp = base;

        assert!(normalize_pending_timestamp(
            &mut timestamp,
            Some(expected),
            pending_timestamp_stale_threshold(Duration::from_millis(35))
        ));

        assert_eq!(
            timestamp_duration_since(timestamp, expected),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn normalize_pending_timestamp_keeps_small_startup_jitter() {
        let base = Timestamp::Instant(Instant::now());
        let expected = base + Duration::from_millis(35);
        let jittered = expected - Duration::from_millis(3);
        let mut timestamp = jittered;

        assert!(!normalize_pending_timestamp(
            &mut timestamp,
            Some(expected),
            pending_timestamp_stale_threshold(Duration::from_millis(35))
        ));

        assert_eq!(
            timestamp_duration_since(timestamp, jittered),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn normalize_pending_timestamp_keeps_forward_timestamps() {
        let base = Timestamp::Instant(Instant::now());
        let expected = base + Duration::from_millis(35);
        let forward = expected + Duration::from_millis(2);
        let mut timestamp = forward;

        assert!(!normalize_pending_timestamp(
            &mut timestamp,
            Some(expected),
            pending_timestamp_stale_threshold(Duration::from_millis(35))
        ));

        assert_eq!(
            timestamp_duration_since(timestamp, forward),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn normalize_pending_timestamps_recovers_repeated_stale_startup_sequence() {
        let base = Timestamp::Instant(Instant::now());
        let sample_duration = Duration::from_millis(35);
        let mut timestamps = [base; 8];

        let adjusted_frames =
            normalize_pending_timestamps(timestamps.iter_mut().map(|ts| (ts, sample_duration)));

        assert_eq!(adjusted_frames, 7);
        for (index, timestamp) in timestamps.iter().copied().enumerate() {
            let expected = base + sample_duration * index as u32;
            assert_eq!(
                timestamp_duration_since(timestamp, expected),
                Some(Duration::ZERO)
            );
        }
    }

    #[test]
    fn normalize_pending_timestamps_preserves_small_jitter_sequence() {
        let base = Timestamp::Instant(Instant::now());
        let sample_duration = Duration::from_millis(35);
        let mut timestamps = vec![
            base,
            base + Duration::from_millis(32),
            base + Duration::from_millis(64),
            base + Duration::from_millis(96),
        ];
        let original = timestamps.clone();

        let adjusted_frames =
            normalize_pending_timestamps(timestamps.iter_mut().map(|ts| (ts, sample_duration)));

        assert_eq!(adjusted_frames, 0);
        for (timestamp, expected) in timestamps.into_iter().zip(original) {
            assert_eq!(
                timestamp_duration_since(timestamp, expected),
                Some(Duration::ZERO)
            );
        }
    }

    #[test]
    fn preferred_config_uses_requested_rate_when_supported() {
        let configs = [config_range(48_000, 1), config_range(96_000, 1)];

        let selected = select_preferred_config(
            &configs,
            &MicrophoneDeviceSettings {
                sample_rate: Some(96_000),
                channels: Some(1),
            },
        )
        .expect("config");

        assert_eq!(selected.sample_rate().0, 96_000);
        assert_eq!(selected.channels(), 1);
    }

    #[test]
    fn preferred_config_falls_back_when_requested_rate_is_unsupported() {
        let configs = [config_range(44_100, 1)];

        let selected = select_preferred_config(
            &configs,
            &MicrophoneDeviceSettings {
                sample_rate: Some(96_000),
                channels: Some(1),
            },
        )
        .expect("config");

        assert_eq!(selected.sample_rate().0, 44_100);
        assert_eq!(selected.channels(), 1);
    }

    #[test]
    fn preferred_config_never_panics_for_stale_settings_matrix() {
        let configs = [
            config_range(44_100, 1),
            config_range(48_000, 1),
            config_range(96_000, 1),
            config_range(48_000, 2),
        ];
        let sample_rates = [
            None,
            Some(8_000),
            Some(44_100),
            Some(48_000),
            Some(96_000),
            Some(192_000),
        ];
        let channels = [None, Some(1), Some(2), Some(8)];

        for sample_rate in sample_rates {
            for channels in channels {
                let settings = MicrophoneDeviceSettings {
                    sample_rate,
                    channels,
                };
                let result =
                    std::panic::catch_unwind(|| select_preferred_config(&configs, &settings));

                assert!(
                    result.is_ok(),
                    "select_preferred_config panicked for settings={settings:?}"
                );

                if let Some(selected) = result.expect("panic checked") {
                    assert!(
                        configs.iter().any(|config| {
                            config.channels() == selected.channels()
                                && supports_sample_rate(config, selected.sample_rate())
                        }),
                        "selected unsupported config {selected:?} for settings={settings:?}"
                    );
                }
            }
        }
    }
}
