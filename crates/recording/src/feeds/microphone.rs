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
        atomic::{AtomicBool, AtomicU64, Ordering},
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

#[cfg(target_os = "linux")]
fn audio_follows_confirmed_route(
    callback_received: Instant,
    capture_delay: Option<Duration>,
    route_required: bool,
    routed_at: Option<cap_timestamp::Timestamps>,
) -> bool {
    !route_required
        || capture_delay
            .and_then(|delay| callback_received.checked_sub(delay))
            .zip(routed_at)
            .is_some_and(|(captured_at, routed_at)| captured_at >= routed_at.instant())
}

#[cfg(target_os = "linux")]
fn cancellable_system_stream_ready(
    ready: StreamReadyFuture,
    cancel: tokio_util::sync::CancellationToken,
) -> StreamReadyFuture {
    async move {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(SetInputError::BuildStream("System audio reconnect cancelled".into())),
            result = ready => result,
        }
    }.boxed()
}

fn microphone_stream_error_handler(
    error_sender: flume::Sender<StreamError>,
    mut on_first_error: impl FnMut() + Send + 'static,
) -> impl FnMut(StreamError) + Send + 'static {
    let mut logged = false;
    move |error| {
        if !logged {
            error!("Microphone stream error: {error}");
            logged = true;
            on_first_error();
        }
        if error_sender.is_empty() {
            let _ = error_sender.try_send(error);
        }
    }
}

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
    #[cfg(any(target_os = "linux", windows))]
    pub(crate) stream_id: u32,
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

#[cfg(any(target_os = "linux", windows))]
struct StreamHealth {
    id: u32,
    failed: AtomicBool,
}

#[cfg(any(target_os = "linux", windows))]
impl StreamHealth {
    fn new(id: u32) -> Self {
        Self {
            id,
            failed: AtomicBool::new(false),
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
pub(crate) struct RecordingSourceHealth(Arc<std::sync::Mutex<RecordingSourceHealthState>>);

#[cfg(target_os = "linux")]
struct RecordingSourceHealthState {
    generation: u64,
    current: Arc<StreamHealth>,
    pending: Option<Arc<StreamHealth>>,
    recovery_origin: Option<u32>,
    terminal: Option<String>,
}

#[cfg(target_os = "linux")]
impl RecordingSourceHealth {
    fn new(generation: u64, current: Arc<StreamHealth>) -> Self {
        Self(Arc::new(std::sync::Mutex::new(
            RecordingSourceHealthState {
                generation,
                current,
                pending: None,
                recovery_origin: None,
                terminal: None,
            },
        )))
    }

    #[cfg(test)]
    pub(crate) fn test_healthy(id: u32) -> Self {
        Self::new(1, Arc::new(StreamHealth::new(id)))
    }

    #[cfg(test)]
    pub(crate) fn test_backend_failure(&self) {
        self.0
            .lock()
            .unwrap()
            .current
            .failed
            .store(true, Ordering::Release);
    }

    fn observe_ready(
        &self,
        generation: u64,
        id: u32,
        ready: StreamReadyFuture,
    ) -> StreamReadyFuture {
        let health = self.clone();
        ready
            .map(move |result| {
                if let Err(error) = &result {
                    health.fail_reconnect(
                        generation,
                        id,
                        format!("Requested audio stream rebuild failed: {error}"),
                    );
                }
                result
            })
            .boxed()
    }

    fn begin_reconnect(&self, generation: u64, pending: Arc<StreamHealth>) {
        let mut state = self.0.lock().unwrap();
        if state.generation == generation && state.terminal.is_none() {
            state.pending = Some(pending);
        }
    }

    fn expects_reconnect(&self, generation: u64, id: u32) -> bool {
        let state = self.0.lock().unwrap();
        state.generation == generation
            && state.terminal.is_none()
            && state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
    }

    fn commit_reconnect(&self, generation: u64, id: u32) {
        let mut state = self.0.lock().unwrap();
        if state.generation != generation || state.terminal.is_some() {
            return;
        }
        let Some(pending) = state
            .pending
            .as_ref()
            .filter(|pending| pending.id == id)
            .cloned()
        else {
            return;
        };
        if pending.failed.load(Ordering::Acquire) {
            state.terminal = Some("Replacement audio stream failed before acceptance".into());
            return;
        }
        if state.current.failed.load(Ordering::Acquire) || state.recovery_origin.is_some() {
            state.recovery_origin = Some(state.current.id);
        }
        state.current = pending;
        state.pending = None;
    }

    fn fail_current(&self, generation: u64, id: u32, error: String) {
        let mut state = self.0.lock().unwrap();
        if state.generation == generation && state.current.id == id {
            state.terminal.get_or_insert(error);
        }
    }

    fn fail_reconnect(&self, generation: u64, id: u32, error: String) {
        let mut state = self.0.lock().unwrap();
        if state.generation == generation
            && state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
        {
            state.terminal.get_or_insert(error);
        }
    }

    pub(crate) fn fail(&self, error: String) {
        self.0.lock().unwrap().terminal.get_or_insert(error);
    }

    pub(crate) fn terminal_error(&self) -> Option<String> {
        self.0.lock().unwrap().terminal.clone()
    }

    pub(crate) fn frame_is_current(&self, id: u32) -> bool {
        let mut state = self.0.lock().unwrap();
        if state.current.id != id || state.terminal.is_some() {
            return false;
        }
        if state.current.failed.load(Ordering::Acquire) {
            state.terminal =
                Some("Requested audio backend failed while continuing to deliver samples".into());
            return false;
        }
        true
    }

    pub(crate) fn accepted_frame(&self, id: u32) {
        let mut state = self.0.lock().unwrap();
        if state.current.id == id
            && state.terminal.is_none()
            && !state.current.failed.load(Ordering::Acquire)
            && state.recovery_origin.is_some_and(|origin| origin != id)
        {
            state.recovery_origin = None;
        }
    }

    pub(crate) fn stop_error(&self) -> Option<String> {
        let state = self.0.lock().unwrap();
        state.terminal.clone().or_else(|| {
            (state.current.failed.load(Ordering::Acquire)
                || state
                    .pending
                    .as_ref()
                    .is_some_and(|pending| pending.failed.load(Ordering::Acquire))
                || state.recovery_origin.is_some())
            .then(|| "Requested audio stream has an unresolved backend failure at Stop".into())
        })
    }
}

#[cfg(windows)]
pub(crate) struct RecordingSubscription {
    generation: u64,
    cancel: tokio_util::sync::CancellationToken,
    state: std::sync::Mutex<RecordingSubscriptionState>,
}

#[cfg(windows)]
#[derive(Default)]
struct RecordingSubscriptionState {
    current: Option<Arc<StreamHealth>>,
    pending: Option<Arc<StreamHealth>>,
    retired: bool,
    failure: Option<String>,
}

#[cfg(windows)]
impl RecordingSubscription {
    fn new(generation: u64, cancel: tokio_util::sync::CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            generation,
            cancel,
            state: std::sync::Mutex::new(RecordingSubscriptionState::default()),
        })
    }

    fn active(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.retired && !self.cancel.is_cancelled()
    }

    pub(crate) fn error(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if !state.retired
            && state.failure.is_none()
            && (state
                .current
                .as_ref()
                .is_some_and(|stream| stream.failed.load(Ordering::Acquire))
                || state
                    .pending
                    .as_ref()
                    .is_some_and(|stream| stream.failed.load(Ordering::Acquire)))
        {
            state.failure = Some("Requested microphone backend failed".into());
        }
        state.failure.clone()
    }

    pub(crate) fn accepts_frame(&self, id: u32) -> bool {
        let state = self.state.lock().unwrap();
        !state.retired
            && !self.cancel.is_cancelled()
            && state.failure.is_none()
            && state
                .current
                .as_ref()
                .is_some_and(|stream| stream.id == id && !stream.failed.load(Ordering::Acquire))
    }

    pub(crate) fn retire(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        if !state.retired
            && state.failure.is_none()
            && (state
                .current
                .as_ref()
                .is_some_and(|stream| stream.failed.load(Ordering::Acquire))
                || state
                    .pending
                    .as_ref()
                    .is_some_and(|stream| stream.failed.load(Ordering::Acquire)))
        {
            state.failure = Some("Requested microphone backend failed at Stop".into());
        }
        state.retired = true;
        let error = state.failure.clone();
        drop(state);
        self.cancel.cancel();
        error
    }

    fn begin_reconnect(&self, health: Arc<StreamHealth>) {
        let mut state = self.state.lock().unwrap();
        if !state.retired && !self.cancel.is_cancelled() {
            state.pending = Some(health);
        }
    }

    fn commit_reconnect(&self, id: u32) {
        let mut state = self.state.lock().unwrap();
        if !state.retired
            && state.failure.is_none()
            && state
                .current
                .as_ref()
                .is_some_and(|current| current.failed.load(Ordering::Acquire))
        {
            state.failure =
                Some("Requested microphone backend failed before replacement acceptance".into());
        }
        if state.retired || self.cancel.is_cancelled() || state.failure.is_some() {
            return;
        }
        if let Some(pending) = state.pending.take() {
            if pending.id == id && !pending.failed.load(Ordering::Acquire) {
                state.current = Some(pending);
            } else {
                state.pending = Some(pending);
            }
        }
    }

    fn fail_reconnect(&self, id: u32, error: String) {
        let mut state = self.state.lock().unwrap();
        if !state.retired
            && !self.cancel.is_cancelled()
            && state
                .pending
                .as_ref()
                .is_some_and(|pending| pending.id == id)
        {
            state.failure.get_or_insert(error);
        }
    }
}

#[cfg(windows)]
struct StreamExitHealth {
    health: Arc<StreamHealth>,
    expected: bool,
}

#[cfg(windows)]
impl Drop for StreamExitHealth {
    fn drop(&mut self) {
        if !self.expected {
            self.health.failed.store(true, Ordering::Release);
        }
    }
}

#[cfg(windows)]
struct WindowsReconnect {
    selection_generation: u64,
    generation: u64,
    previous_id: u32,
    id: u32,
    label: String,
    ready: futures::future::Shared<StreamReadyFuture>,
    done_tx: SyncSender<()>,
}

#[cfg(windows)]
impl WindowsReconnect {
    fn identity(&self) -> (u64, u32, u32) {
        (self.generation, self.previous_id, self.id)
    }
    fn connecting(&self) -> ConnectingState {
        let id = self.id;
        let label = self.label.clone();
        let done_tx = self.done_tx.clone();
        ConnectingState {
            id,
            ready: self
                .ready
                .clone()
                .map(move |result| {
                    result.map(|(config, buffer_size_frames)| InputConnected {
                        id,
                        label,
                        config,
                        buffer_size_frames,
                        done_tx,
                    })
                })
                .boxed(),
        }
    }
}

#[derive(Actor)]
pub struct MicrophoneFeed {
    #[cfg(windows)]
    selection_generation: u64,
    #[cfg(windows)]
    recording_reconnect: Option<WindowsReconnect>,
    #[cfg(any(target_os = "linux", windows))]
    stream_health: std::collections::HashMap<u32, Arc<StreamHealth>>,
    #[cfg(target_os = "linux")]
    recording_health: Option<RecordingSourceHealth>,
    #[cfg(target_os = "linux")]
    pulse_input_role: crate::sources::screen_capture::PulseInputRole,
    #[cfg(target_os = "linux")]
    system_stream_cancel: tokio_util::sync::CancellationToken,
    #[cfg(target_os = "linux")]
    system_failed_input: Option<u32>,
    #[cfg(target_os = "linux")]
    system_reconnect: Option<SystemReconnect>,
    input_id_counter: u32,
    lock_generation: u64,
    state: State,
    senders: Vec<MicrophoneFeedSender>,
    error_sender: flume::Sender<StreamError>,
    dropped_message_count: Arc<AtomicU64>,
}

#[cfg(target_os = "linux")]
struct SystemReconnect {
    previous_id: u32,
    id: u32,
    generation: u64,
    label: String,
    ready: futures::future::Shared<StreamReadyFuture>,
}

impl Drop for MicrophoneFeed {
    fn drop(&mut self) {
        #[cfg(target_os = "linux")]
        self.system_stream_cancel.cancel();
    }
}

struct MicrophoneFeedSender {
    #[cfg(windows)]
    subscription: Option<Arc<RecordingSubscription>>,
    sender: flume::Sender<MicrophoneSamples>,
    health_tx: Option<HealthSender>,
    label: Option<String>,
    stalled_since: Option<Instant>,
    last_stalled_event: Option<Instant>,
}

impl MicrophoneFeedSender {
    fn new(sender: flume::Sender<MicrophoneSamples>) -> Self {
        Self {
            #[cfg(windows)]
            subscription: None,
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
            #[cfg(windows)]
            subscription: None,
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
        .and_then(macos_device_name_released)
        .filter(|name| !name.is_empty())
    {
        names.insert(name, ());
    }

    match macos_helpers::get_audio_device_ids_for_scope(Scope::Input) {
        Ok(device_ids) => {
            for device_id in device_ids {
                if macos_helpers::get_audio_device_supports_scope(device_id, Scope::Input)
                    .unwrap_or(false)
                    && let Some(name) = macos_device_name_released(device_id)
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

// coreaudio-rs's get_device_name never releases the CFString it copies out of
// AudioObjectGetPropertyData (twice on the CFStringGetCStringPtr fallback
// path), leaking one or two strings per device per call; the devices snapshot
// emitter calls this every 5s for the process lifetime. This variant hands the
// +1 ref to core-foundation, which releases it on drop.
#[cfg(target_os = "macos")]
fn macos_device_name_released(device_id: coreaudio::sys::AudioDeviceID) -> Option<String> {
    use core_foundation::{
        base::TCFType,
        string::{CFString, CFStringRef},
    };
    use coreaudio::sys;

    let property_address = sys::AudioObjectPropertyAddress {
        mSelector: sys::kAudioDevicePropertyDeviceNameCFString,
        mScope: sys::kAudioDevicePropertyScopeOutput,
        mElement: sys::kAudioObjectPropertyElementMaster,
    };

    let mut device_name: CFStringRef = std::ptr::null();
    let mut data_size = std::mem::size_of::<CFStringRef>() as u32;
    let status = unsafe {
        sys::AudioObjectGetPropertyData(
            device_id,
            &property_address,
            0,
            std::ptr::null(),
            &mut data_size,
            (&mut device_name) as *mut CFStringRef as *mut _,
        )
    };
    if status != sys::kAudioHardwareNoError as i32 || device_name.is_null() {
        return None;
    }

    Some(unsafe { CFString::wrap_under_create_rule(device_name) }.to_string())
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
            #[cfg(target_os = "linux")]
            pulse_input_role: crate::sources::screen_capture::PulseInputRole::Microphone,
            #[cfg(target_os = "linux")]
            system_stream_cancel: tokio_util::sync::CancellationToken::new(),
            #[cfg(target_os = "linux")]
            system_failed_input: None,
            #[cfg(target_os = "linux")]
            system_reconnect: None,
            #[cfg(any(target_os = "linux", windows))]
            stream_health: std::collections::HashMap::new(),
            #[cfg(target_os = "linux")]
            recording_health: None,
            #[cfg(windows)]
            recording_reconnect: None,
            #[cfg(windows)]
            selection_generation: 0,
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

    #[cfg(target_os = "linux")]
    pub(crate) fn new_system_audio(error_sender: flume::Sender<StreamError>) -> Self {
        let mut feed = Self::new(error_sender);
        feed.pulse_input_role = crate::sources::screen_capture::PulseInputRole::SystemAudio;
        feed
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
            #[cfg(any(target_os = "linux", windows))]
            health,
            #[cfg(target_os = "linux")]
            pulse_input_role,
            #[cfg(target_os = "linux")]
            system_stream_cancel,
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
                #[cfg(windows)]
                let mut exit_health = StreamExitHealth {
                    health: health.clone(),
                    expected: false,
                };
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
                #[cfg(windows)]
                let mut capture_clock = crate::sources::capture_clock::CaptureClock::new(
                    cap_timestamp::Timestamps::now(),
                );

                let latency_info = estimate_input_latency(
                    callback_sample_rate,
                    buffer_size_frames.unwrap_or(1024),
                    Some(&label),
                );
                let capture_latency = Duration::from_secs_f64(
                    latency_info
                        .device_latency_secs
                        .clamp(0.0, MAX_CAPTURE_LATENCY_COMPENSATION_SECS),
                );
                if !capture_latency.is_zero() {
                    info!(
                        "🎤 Compensating capture timestamps by {:.1}ms input pipeline latency (transport: {:?})",
                        capture_latency.as_secs_f64() * 1000.0,
                        latency_info.transport
                    );
                }

                #[cfg(target_os = "linux")]
                let input_route = match crate::sources::screen_capture::PulseInputRoute::prepare(
                    &label,
                    pulse_input_role,
                ) {
                    Ok(route) => route,
                    Err(error) => {
                        let _ = ready_tx.send(Err(SetInputError::BuildStream(format!(
                            "Could not prepare the Linux audio input route: {error}"
                        ))));
                        return;
                    }
                };
                #[cfg(target_os = "linux")]
                let input_callback_observed = Arc::new(AtomicBool::new(false));
                #[cfg(target_os = "linux")]
                let route_required = input_route.is_some();
                #[cfg(target_os = "linux")]
                let routed_at = Arc::new(std::sync::OnceLock::<cap_timestamp::Timestamps>::new());

                let stream = match device.build_input_stream_raw(
                    &stream_config,
                    sample_format,
                    {
                        let actor_ref = actor_ref.clone();
                        #[cfg(target_os = "linux")]
                        let input_callback_observed = input_callback_observed.clone();
                        #[cfg(target_os = "linux")]
                        let routed_at = routed_at.clone();
                        #[cfg(target_os = "linux")]
                        let system_stream_cancel = system_stream_cancel.clone();
                        let mut callback_count = 0u64;
                        move |data, info| {
                            #[cfg(target_os = "linux")]
                            if system_stream_cancel.is_cancelled() {
                                return;
                            }
                            #[cfg(target_os = "linux")]
                            let callback_received = Instant::now();
                            let frame_count = callback_frame_count(
                                data.bytes().len(),
                                data.sample_format(),
                                callback_channels,
                            );
                            let input_timestamp = info.timestamp();
                            let effective_sample_rate =
                                sample_rate_estimator.sample_rate_for(input_timestamp, frame_count);

                            if callback_count == 0 {
                                #[cfg(target_os = "linux")]
                                input_callback_observed.store(true, Ordering::Release);
                                info!(
                                    "🎤 First audio callback - data size: {} bytes, frames: {}, format: {:?}, rate: {}",
                                    data.bytes().len(),
                                    frame_count,
                                    data.sample_format(),
                                    effective_sample_rate.sample_rate
                                );
                            }
                            callback_count += 1;

                            let timestamp = Timestamp::from_cpal(input_timestamp.capture);
                            #[cfg(target_os = "linux")]
                            // Linux Timestamp::from_cpal uses receipt time, so the route gate
                            // separately accounts for ALSA buffers without changing A/V compensation.
                            if !audio_follows_confirmed_route(
                                callback_received,
                                input_timestamp.callback.duration_since(&input_timestamp.capture),
                                route_required,
                                routed_at.get().copied(),
                            ) {
                                return;
                            }
                            #[cfg(windows)]
                            let timestamp = capture_clock.timestamp(
                                timestamp,
                                Instant::now(),
                                Duration::from_secs_f64(
                                    frame_count as f64
                                        / f64::from(effective_sample_rate.sample_rate.max(1)),
                                ),
                            );
                            let samples = MicrophoneSamples {
                                #[cfg(any(target_os = "linux", windows))]
                                stream_id: id,
                                data: data.bytes().to_vec(),
                                format: data.sample_format(),
                                sample_rate: effective_sample_rate.sample_rate,
                                channels: callback_channels,
                                info: info.clone(),
                                timestamp: timestamp - capture_latency,
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
                    microphone_stream_error_handler(error_sender, {
                        #[cfg(target_os = "linux")]
                        let actor = actor_ref.clone();
                        #[cfg(target_os = "linux")]
                        let cancel = system_stream_cancel.clone();
                        move || {
                            #[cfg(any(target_os = "linux", windows))]
                            health.failed.store(true, Ordering::Release);
                            #[cfg(target_os = "linux")]
                            if pulse_input_role == crate::sources::screen_capture::PulseInputRole::SystemAudio
                                && !cancel.is_cancelled()
                            {
                                let _ = actor.tell(SystemInputFailed { id }).try_send();
                            }
                        }
                    }),
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

                #[cfg(target_os = "linux")]
                if let Some(route) = input_route
                    && let Err(error) = route.apply(&input_callback_observed, &system_stream_cancel)
                {
                    let _ = ready_tx.send(Err(SetInputError::BuildStream(format!(
                        "Could not confirm the Linux audio input route: {error}"
                    ))));
                    return;
                }

                #[cfg(target_os = "linux")]
                let _ = routed_at.set(cap_timestamp::Timestamps::now());
                #[cfg(target_os = "linux")]
                if system_stream_cancel.is_cancelled() {
                    return;
                }

                let _ = ready_tx.send(Ok(buffer_size_frames));

                match done_rx.recv() {
                    Ok(_) => debug!("Microphone actor shut down, ending stream"),
                    Err(_) => debug!("Microphone shutdown signal channel closed, ending stream"),
                }
                #[cfg(windows)]
                {
                    exit_health.expected = true;
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

// The cpal capture timestamp (mHostTime / QPC) marks when samples left the
// audio HAL, not when the sound reached the microphone. The gap between the
// two is the input pipeline latency (device latency + safety offset + stream
// latency), which otherwise lands in the recording as the mic track running
// late relative to video. Buffer latency is deliberately excluded: the
// callback timestamp already refers to the first frame of the buffer.
const MAX_CAPTURE_LATENCY_COMPENSATION_SECS: f64 = 0.5;

fn stream_config_with_latency(
    config: &SupportedStreamConfig,
    device_name: Option<&str>,
) -> (cpal::StreamConfig, Option<u32>) {
    let mut stream_config: cpal::StreamConfig = config.clone().into();
    let buffer_size_frames = if uses_default_microphone_buffer(device_name) {
        None
    } else {
        desired_buffer_size_frames(config, device_name)
    };

    if let Some(frames) = buffer_size_frames {
        stream_config.buffer_size = BufferSize::Fixed(frames);
    }

    (stream_config, buffer_size_frames)
}

fn uses_default_microphone_buffer(device_name: Option<&str>) -> bool {
    cfg!(target_os = "linux")
        && device_name.is_some_and(|name| {
            ["default", "pulse", "pipewire"]
                .iter()
                .any(|backend| name.eq_ignore_ascii_case(backend))
        })
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
    #[cfg(windows)]
    generation: u64,
    #[cfg(target_os = "linux")]
    source_health: RecordingSourceHealth,
    actor: ActorRef<MicrophoneFeed>,
    config: SupportedStreamConfig,
    audio_info: AudioInfo,
    buffer_size_frames: Option<u32>,
    drop_tx: Option<oneshot::Sender<()>>,
    device_name: String,
    // Recording-scoped mute. The stream keeps flowing at its normal cadence —
    // the recording source zeroes sample payloads while this is set — so
    // timestamps, resampler state, and the muxer timeline are untouched by
    // muting. A fresh lock (i.e. every new recording) always starts unmuted.
    recording_muted: Arc<AtomicBool>,
    _token: Arc<()>,
}

impl MicrophoneFeedLock {
    #[cfg(windows)]
    pub(crate) fn recording_subscription(
        &self,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Arc<RecordingSubscription> {
        RecordingSubscription::new(self.generation, cancel)
    }

    #[cfg(windows)]
    pub(crate) async fn attach_recording_subscription(
        &self,
        subscription: Arc<RecordingSubscription>,
        sender: flume::Sender<MicrophoneSamples>,
        health_tx: HealthSender,
        label: String,
    ) -> anyhow::Result<()> {
        self.actor
            .ask(AttachRecordingSubscription {
                subscription,
                sender,
                health_tx,
                label,
            })
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    #[cfg(windows)]
    pub(crate) async fn detach_recording_subscription(
        &self,
        subscription: Arc<RecordingSubscription>,
    ) -> anyhow::Result<()> {
        self.actor
            .ask(DetachRecordingSubscription(subscription))
            .await
            .map_err(|error| anyhow::anyhow!("{error}"))
    }

    #[cfg(windows)]
    pub(crate) async fn reconnect_recording_subscription(
        &self,
        subscription: Arc<RecordingSubscription>,
        settings: MicrophoneDeviceSettings,
    ) -> Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>
    {
        self.actor
            .ask(ReconnectRecordingSubscription {
                subscription,
                label: self.device_name.clone(),
                settings,
            })
            .await
            .map_err(|error| SetInputError::BuildStream(format!("{error}")))
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn source_health(&self) -> RecordingSourceHealth {
        self.source_health.clone()
    }

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

    pub fn set_recording_muted(&self, muted: bool) {
        self.recording_muted.store(muted, Ordering::Relaxed);
    }

    pub fn is_recording_muted(&self) -> bool {
        self.recording_muted.load(Ordering::Relaxed)
    }

    pub fn recording_muted_handle(&self) -> Arc<AtomicBool> {
        self.recording_muted.clone()
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
    #[cfg(any(target_os = "linux", windows))]
    previous_id: u32,
    #[cfg(any(target_os = "linux", windows))]
    generation: u64,
    id: u32,
    label: String,
    config: SupportedStreamConfig,
    buffer_size_frames: Option<u32>,
    done_tx: mpsc::SyncSender<()>,
}

#[cfg(target_os = "linux")]
struct SystemInputFailed {
    id: u32,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct ReconnectSystemInput {
    id: u32,
    generation: u64,
}

#[cfg(target_os = "linux")]
struct SystemReconnectFailed {
    id: u32,
    generation: u64,
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
    #[cfg(any(target_os = "linux", windows))]
    health: Arc<StreamHealth>,
    #[cfg(target_os = "linux")]
    pulse_input_role: crate::sources::screen_capture::PulseInputRole,
    #[cfg(target_os = "linux")]
    system_stream_cancel: tokio_util::sync::CancellationToken,
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
        self.set_input(msg, ctx.actor_ref())
    }
}

impl MicrophoneFeed {
    fn set_input(
        &mut self,
        msg: SetInput,
        actor_ref: ActorRef<Self>,
    ) -> Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>
    {
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

                #[cfg(target_os = "linux")]
                if self.pulse_input_role
                    == crate::sources::screen_capture::PulseInputRole::SystemAudio
                {
                    self.system_stream_cancel.cancel();
                    self.system_stream_cancel = tokio_util::sync::CancellationToken::new();
                }
                #[cfg(windows)]
                {
                    self.selection_generation = self.selection_generation.wrapping_add(1);
                    self.recording_reconnect = None;
                }
                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) =
                    stream_config_with_latency(&config, Some(&label));

                let actor_ref = actor_ref.clone();
                #[cfg(any(target_os = "linux", windows))]
                let health = {
                    let health = Arc::new(StreamHealth::new(id));
                    self.stream_health
                        .retain(|key, _| state.attached.as_ref().is_some_and(|v| v.id == *key));
                    let _ = self.stream_health.insert(id, health.clone());
                    health
                };
                let (ready_future, done_tx) = Self::spawn_input_stream(StreamSpawnParams {
                    #[cfg(any(target_os = "linux", windows))]
                    health,
                    #[cfg(target_os = "linux")]
                    pulse_input_role: self.pulse_input_role,
                    #[cfg(target_os = "linux")]
                    system_stream_cancel: self.system_stream_cancel.clone(),
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

                #[cfg(windows)]
                if let Some(pending) = &self.recording_reconnect
                    && pending.generation == self.lock_generation
                    && pending.previous_id == inner.id
                    && pending.label == msg.label
                {
                    return Ok(pending
                        .ready
                        .clone()
                        .map(|result| result.map(|(config, _)| config))
                        .boxed());
                }

                #[cfg(target_os = "linux")]
                if let Some(pending) = &self.system_reconnect
                    && pending.generation == self.lock_generation
                    && pending.label == msg.label
                {
                    return Ok(pending
                        .ready
                        .clone()
                        .map(|result| result.map(|(config, _)| config))
                        .boxed());
                }

                let label = msg.label.clone();
                let Some((device, config)) =
                    Self::list_with_settings(msg.settings.as_ref()).swap_remove(&label)
                else {
                    #[cfg(target_os = "linux")]
                    if let Some(recording) = &self.recording_health {
                        recording.fail_current(
                            self.lock_generation,
                            inner.id,
                            "Requested audio device unavailable during reconnect".into(),
                        );
                    }
                    return Err(SetInputError::DeviceNotFound);
                };

                let sample_format = config.sample_format();
                let (stream_config, buffer_size_frames) =
                    stream_config_with_latency(&config, Some(&label));

                let new_id = self.input_id_counter;
                self.input_id_counter += 1;

                #[cfg(any(target_os = "linux", windows))]
                let previous_id = inner.id;
                #[cfg(any(target_os = "linux", windows))]
                let generation = self.lock_generation;
                #[cfg(target_os = "linux")]
                if self.pulse_input_role
                    == crate::sources::screen_capture::PulseInputRole::SystemAudio
                {
                    self.system_stream_cancel.cancel();
                    self.system_stream_cancel = tokio_util::sync::CancellationToken::new();
                }
                let _ = inner.done_tx.send(());

                #[cfg(any(target_os = "linux", windows))]
                let health = {
                    let health = Arc::new(StreamHealth::new(new_id));
                    self.stream_health.retain(|key, _| *key == inner.id);
                    let _ = self.stream_health.insert(new_id, health.clone());
                    #[cfg(target_os = "linux")]
                    if let Some(recording) = &self.recording_health {
                        recording.begin_reconnect(generation, health.clone());
                    }
                    health
                };
                let actor_ref = actor_ref.clone();
                #[cfg(windows)]
                let windows_health = health.clone();
                let (ready_future, done_tx) = Self::spawn_input_stream(StreamSpawnParams {
                    #[cfg(any(target_os = "linux", windows))]
                    health,
                    #[cfg(target_os = "linux")]
                    pulse_input_role: self.pulse_input_role,
                    #[cfg(target_os = "linux")]
                    system_stream_cancel: self.system_stream_cancel.clone(),
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
                #[cfg(target_os = "linux")]
                let ready_future = if self.pulse_input_role
                    == crate::sources::screen_capture::PulseInputRole::SystemAudio
                {
                    cancellable_system_stream_ready(ready_future, self.system_stream_cancel.clone())
                } else {
                    ready_future
                };
                #[cfg(target_os = "linux")]
                let ready_future = if let Some(health) = &self.recording_health {
                    health.observe_ready(generation, new_id, ready_future)
                } else {
                    ready_future
                };
                let ready = ready_future.shared();
                #[cfg(windows)]
                {
                    self.accept_windows_reconnect(
                        WindowsReconnect {
                            selection_generation: self.selection_generation,
                            generation,
                            previous_id,
                            id: new_id,
                            label: label.clone(),
                            ready: ready.clone(),
                            done_tx: done_tx.clone(),
                        },
                        windows_health,
                    );
                }

                #[cfg(target_os = "linux")]
                if self.pulse_input_role
                    == crate::sources::screen_capture::PulseInputRole::SystemAudio
                {
                    self.system_reconnect = Some(SystemReconnect {
                        previous_id,
                        id: new_id,
                        generation,
                        label: label.clone(),
                        ready: ready.clone(),
                    });
                }

                tokio::spawn({
                    let ready = ready.clone();
                    let actor = actor_ref;
                    let done_tx = done_tx.clone();
                    let label = label.clone();
                    async move {
                        match ready.await {
                            Ok((config, buffer_size_frames)) => {
                                let _ = actor
                                    .tell(LockedInputReconnected {
                                        #[cfg(any(target_os = "linux", windows))]
                                        previous_id,
                                        #[cfg(any(target_os = "linux", windows))]
                                        generation,
                                        id: new_id,
                                        label,
                                        config,
                                        buffer_size_frames,
                                        done_tx,
                                    })
                                    .await;
                            }
                            Err(_error) => {
                                #[cfg(windows)]
                                let _ = actor
                                    .tell(WindowsReconnectFailed {
                                        generation,
                                        id: new_id,
                                        error: format!(
                                            "Requested microphone rebuild failed: {_error}"
                                        ),
                                    })
                                    .await;
                                #[cfg(target_os = "linux")]
                                let _ = actor
                                    .tell(SystemReconnectFailed {
                                        id: new_id,
                                        generation,
                                    })
                                    .await;
                            }
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

        // Callers routinely discard this reply; a locked feed silently keeps
        // the cpal stream (and its per-callback allocations) alive, so make
        // that path visible in logs. debug-level because deselecting the mic
        // during a studio recording hits this legitimately.
        let state = match self.state.try_as_open() {
            Ok(state) => state,
            Err(err) => {
                debug!(
                    "Microphone feed RemoveInput deferred: feed is locked by an active consumer"
                );
                return Err(err);
            }
        };

        #[cfg(windows)]
        {
            self.selection_generation = self.selection_generation.wrapping_add(1);
            self.recording_reconnect = None;
        }
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

#[cfg(windows)]
struct AttachRecordingSubscription {
    subscription: Arc<RecordingSubscription>,
    sender: flume::Sender<MicrophoneSamples>,
    health_tx: HealthSender,
    label: String,
}

#[cfg(windows)]
struct DetachRecordingSubscription(Arc<RecordingSubscription>);

#[cfg(windows)]
struct ReconnectRecordingSubscription {
    subscription: Arc<RecordingSubscription>,
    label: String,
    settings: MicrophoneDeviceSettings,
}

#[cfg(windows)]
struct WindowsReconnectFailed {
    generation: u64,
    id: u32,
    error: String,
}

#[cfg(windows)]
impl MicrophoneFeed {
    fn accept_windows_reconnect(&mut self, pending: WindowsReconnect, health: Arc<StreamHealth>) {
        for sender in &self.senders {
            if let Some(subscription) = &sender.subscription {
                subscription.begin_reconnect(health.clone());
            }
        }
        self.recording_reconnect = Some(pending);
    }

    fn subscription_is_current(&self, subscription: &Arc<RecordingSubscription>) -> bool {
        subscription.active()
            && subscription.error().is_none()
            && subscription.generation == self.lock_generation
            && matches!(&self.state, State::Locked { inner, token } if token.strong_count() > 0 && subscription.accepts_frame(inner.id))
            && self.senders.iter().any(|sender| {
                sender
                    .subscription
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, subscription))
            })
    }

    fn attach_subscription(&mut self, msg: AttachRecordingSubscription) -> Result<(), String> {
        let State::Locked { inner, token } = &self.state else {
            return Err("Recording microphone lock is no longer current".into());
        };
        if !msg.subscription.active()
            || msg.subscription.generation != self.lock_generation
            || token.strong_count() == 0
        {
            return Err("Recording microphone subscription was retired".into());
        }
        let health = self
            .stream_health
            .get(&inner.id)
            .cloned()
            .ok_or("Current microphone stream health is unavailable")?;
        if health.failed.load(Ordering::Acquire) {
            return Err("Requested microphone backend is already failed".into());
        }
        let pending_health = if let Some(pending) = &self.recording_reconnect {
            if pending.selection_generation != self.selection_generation
                || pending.generation != self.lock_generation
                || pending.previous_id != inner.id
                || pending.label != inner.label
            {
                return Err("Pending microphone replacement is no longer current".into());
            }
            let health = self
                .stream_health
                .get(&pending.id)
                .cloned()
                .ok_or("Pending microphone stream health is unavailable")?;
            if health.failed.load(Ordering::Acquire) {
                return Err("Pending microphone backend is already failed".into());
            }
            Some(health)
        } else {
            None
        };
        let mut state = msg.subscription.state.lock().unwrap();
        if state.retired || msg.subscription.cancel.is_cancelled() || state.current.is_some() {
            return Err("Recording subscription already attached or retired".into());
        }
        state.current = Some(health);
        state.pending = pending_health;
        drop(state);
        let mut sender = MicrophoneFeedSender::recording(msg.sender, msg.health_tx, msg.label);
        sender.subscription = Some(msg.subscription);
        self.senders.push(sender);
        Ok(())
    }

    fn prepare_unlocked_recovery(&mut self) {
        if matches!(&self.state, State::Locked { token, .. } if token.strong_count() == 0) {
            let _ = self.state.try_as_open();
        }
        if let State::Open(state) = &mut self.state
            && state.connecting.is_none()
            && let Some(pending) = &self.recording_reconnect
            && pending.generation == self.lock_generation
            && pending.selection_generation == self.selection_generation
            && state.attached.as_ref().is_some_and(|inner| {
                inner.id == pending.previous_id && inner.label == pending.label
            })
        {
            state.connecting = Some(pending.connecting());
        }
    }
}

#[cfg(windows)]
impl Message<AttachRecordingSubscription> for MicrophoneFeed {
    type Reply = Result<(), String>;
    async fn handle(
        &mut self,
        msg: AttachRecordingSubscription,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.attach_subscription(msg)
    }
}

#[cfg(windows)]
impl Message<DetachRecordingSubscription> for MicrophoneFeed {
    type Reply = ();
    async fn handle(
        &mut self,
        msg: DetachRecordingSubscription,
        _: &mut Context<Self, Self::Reply>,
    ) {
        let _ = msg.0.retire();
        self.senders.retain(|sender| {
            !sender
                .subscription
                .as_ref()
                .is_some_and(|subscription| Arc::ptr_eq(subscription, &msg.0))
        });
    }
}

#[cfg(windows)]
impl Message<ReconnectRecordingSubscription> for MicrophoneFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;
    async fn handle(
        &mut self,
        msg: ReconnectRecordingSubscription,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if !self.subscription_is_current(&msg.subscription) {
            return Err(SetInputError::BuildStream(
                "Recording microphone subscription is retired".into(),
            ));
        }
        self.set_input(
            SetInput {
                label: msg.label,
                settings: Some(msg.settings),
            },
            ctx.actor_ref(),
        )
    }
}

#[cfg(windows)]
impl Message<WindowsReconnectFailed> for MicrophoneFeed {
    type Reply = ();
    async fn handle(&mut self, msg: WindowsReconnectFailed, _: &mut Context<Self, Self::Reply>) {
        if self.lock_generation != msg.generation {
            return;
        }
        for sender in &self.senders {
            if let Some(subscription) = &sender.subscription {
                subscription.fail_reconnect(msg.id, msg.error.clone());
            }
        }
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
            #[cfg(windows)]
            if sender
                .subscription
                .as_ref()
                .is_some_and(|subscription| !subscription.accepts_frame(msg.stream_id))
            {
                continue;
            }
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
        #[cfg(windows)]
        self.prepare_unlocked_recovery();

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
        #[cfg(windows)]
        {
            self.recording_reconnect = None;
        }
        let generation = self.lock_generation;
        #[cfg(target_os = "linux")]
        let source_health = RecordingSourceHealth::new(
            generation,
            self.stream_health
                .get(&attached.id)
                .cloned()
                .unwrap_or_else(|| Arc::new(StreamHealth::new(attached.id))),
        );
        #[cfg(target_os = "linux")]
        {
            self.recording_health = Some(source_health.clone());
        }
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
            #[cfg(windows)]
            generation,
            #[cfg(target_os = "linux")]
            source_health,
            audio_info,
            actor: ctx.actor_ref(),
            config,
            buffer_size_frames,
            drop_tx: Some(drop_tx),
            device_name,
            recording_muted: Arc::new(AtomicBool::new(false)),
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
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnected");

        // Lock can consume this connection before the notification reaches the mailbox.
        let Ok(state) = self.state.try_as_open() else {
            return;
        };

        state.handle_input_connected(msg);
    }
}

impl Message<InputConnectFailed> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: InputConnectFailed,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        trace!("MicrophoneFeed.InputConnectFailed");

        let Ok(state) = self.state.try_as_open() else {
            return;
        };

        if let Some(connecting) = &state.connecting
            && connecting.id == msg.id
        {
            state.connecting = None;
        }
    }
}

impl Message<LockedInputReconnected> for MicrophoneFeed {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: LockedInputReconnected,
        _: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        self.handle_locked_input_reconnected(msg);
    }
}

#[cfg(any(windows, test))]
fn recording_reconnect_is_current(
    current_generation: u64,
    pending: Option<(u64, u32, u32)>,
    current: Option<(u32, &str, bool)>,
    generation: u64,
    previous_id: u32,
    id: u32,
    label: &str,
) -> bool {
    current_generation == generation
        && pending == Some((generation, previous_id, id))
        && current.is_some_and(|(current_id, current_label, locked)| {
            locked && current_id == previous_id && current_label == label
        })
}

impl MicrophoneFeed {
    fn handle_locked_input_reconnected(&mut self, msg: LockedInputReconnected) {
        #[cfg(windows)]
        {
            let current = match &self.state {
                State::Locked { inner, token } => {
                    Some((inner.id, inner.label.as_str(), token.strong_count() > 0))
                }
                State::Open(state) => state.attached.as_ref().map(|inner| {
                    (
                        inner.id,
                        inner.label.as_str(),
                        state
                            .connecting
                            .as_ref()
                            .is_some_and(|pending| pending.id == msg.id),
                    )
                }),
            };
            if !recording_reconnect_is_current(
                self.lock_generation,
                self.recording_reconnect
                    .as_ref()
                    .filter(|pending| pending.selection_generation == self.selection_generation)
                    .map(WindowsReconnect::identity),
                current,
                msg.generation,
                msg.previous_id,
                msg.id,
                &msg.label,
            ) {
                return;
            }
            self.recording_reconnect = None;
            for sender in &self.senders {
                if let Some(subscription) = &sender.subscription {
                    subscription.commit_reconnect(msg.id);
                }
            }
            if let State::Open(state) = &mut self.state {
                state.handle_input_connected(InputConnected {
                    id: msg.id,
                    label: msg.label,
                    config: msg.config,
                    buffer_size_frames: msg.buffer_size_frames,
                    done_tx: msg.done_tx,
                });
                return;
            }
        }
        #[cfg(target_os = "linux")]
        if self.lock_generation != msg.generation
            || !matches!(&self.state, State::Locked { inner, token }
                if inner.id == msg.previous_id && inner.label == msg.label && token.strong_count() > 0)
            || self
                .recording_health
                .as_ref()
                .is_some_and(|health| !health.expects_reconnect(msg.generation, msg.id))
        {
            return;
        }
        #[cfg(target_os = "linux")]
        if self.pulse_input_role == crate::sources::screen_capture::PulseInputRole::SystemAudio {
            let current = !self.system_stream_cancel.is_cancelled()
                && matches!(&self.state, State::Locked { inner, token }
                    if token.strong_count() > 0 && inner.id == msg.previous_id && inner.label == msg.label);
            if !current
                || self.lock_generation != msg.generation
                || !self.system_reconnect.as_ref().is_some_and(|pending| {
                    pending.previous_id == msg.previous_id
                        && pending.id == msg.id
                        && pending.generation == msg.generation
                })
            {
                return;
            }
            self.system_reconnect = None;
            self.system_failed_input = None;
        }
        if let State::Locked { inner, .. } = &mut self.state
            && inner.label == msg.label
        {
            #[cfg(target_os = "linux")]
            if msg.generation == self.lock_generation
                && inner.id == msg.previous_id
                && let Some(recording) = &self.recording_health
            {
                recording.commit_reconnect(msg.generation, msg.id);
            }
            inner.id = msg.id;
            inner.config = msg.config;
            inner.buffer_size_frames = msg.buffer_size_frames;
            inner.done_tx = msg.done_tx;
        }
    }
}

#[cfg(target_os = "linux")]
impl MicrophoneFeed {
    fn take_system_error_reconnect(&mut self, id: u32) -> Option<ReconnectSystemInput> {
        if self.pulse_input_role == crate::sources::screen_capture::PulseInputRole::SystemAudio
            && self.system_reconnect.as_ref().is_some_and(|pending| {
                pending.id == id && pending.generation == self.lock_generation
            })
        {
            if let Some(recording) = &self.recording_health {
                recording.fail_reconnect(
                    self.lock_generation,
                    id,
                    "Replacement audio stream failed before acceptance".into(),
                );
            }
            self.system_failed_input = Some(id);
            self.system_stream_cancel.cancel();
            self.system_reconnect = None;
            return None;
        }
        if self.pulse_input_role != crate::sources::screen_capture::PulseInputRole::SystemAudio
            || self.system_stream_cancel.is_cancelled()
            || self.system_failed_input == Some(id)
            || self.system_reconnect.is_some()
        {
            return None;
        }
        let State::Locked { inner, token } = &self.state else {
            return None;
        };
        if inner.id != id || token.strong_count() == 0 {
            return None;
        }
        self.system_failed_input = Some(id);
        Some(ReconnectSystemInput {
            id,
            generation: self.lock_generation,
        })
    }

    fn system_reconnect_request_is_current(&self, msg: ReconnectSystemInput) -> bool {
        self.pulse_input_role == crate::sources::screen_capture::PulseInputRole::SystemAudio
            && self.lock_generation == msg.generation
            && !self.system_stream_cancel.is_cancelled()
            && matches!(&self.state, State::Locked { inner, token }
                if inner.id == msg.id && token.strong_count() > 0)
    }
}

#[cfg(target_os = "linux")]
impl Message<SystemInputFailed> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: SystemInputFailed, ctx: &mut Context<Self, Self::Reply>) {
        let Some(request) = self.take_system_error_reconnect(msg.id) else {
            return;
        };
        let actor = ctx.actor_ref();
        tokio::spawn(async move {
            match actor.ask(request).await {
                Ok(ready) => match ready.await {
                    Ok(_) => info!("System audio recovered after native stream error"),
                    Err(error) => warn!(%error, "System audio error recovery did not complete"),
                },
                Err(error) => warn!(%error, "System audio error recovery could not start"),
            }
        });
    }
}

#[cfg(target_os = "linux")]
impl Message<ReconnectSystemInput> for MicrophoneFeed {
    type Reply =
        Result<BoxFuture<'static, Result<SupportedStreamConfig, SetInputError>>, SetInputError>;

    async fn handle(
        &mut self,
        msg: ReconnectSystemInput,
        ctx: &mut Context<Self, Self::Reply>,
    ) -> Self::Reply {
        if !self.system_reconnect_request_is_current(msg) {
            return Err(SetInputError::BuildStream(
                "System audio recovery no longer belongs to the active input".into(),
            ));
        }
        let State::Locked { inner, .. } = &self.state else {
            return Err(SetInputError::Locked(FeedLockedError));
        };
        let request = SetInput {
            label: inner.label.clone(),
            settings: Some(MicrophoneDeviceSettings {
                sample_rate: Some(inner.config.sample_rate().0),
                channels: Some(inner.config.channels()),
            }),
        };
        info!(
            stream_id = msg.id,
            "Recovering system audio after native stream error"
        );
        self.set_input(request, ctx.actor_ref())
    }
}

#[cfg(target_os = "linux")]
impl Message<SystemReconnectFailed> for MicrophoneFeed {
    type Reply = ();

    async fn handle(&mut self, msg: SystemReconnectFailed, _: &mut Context<Self, Self::Reply>) {
        if let Some(recording) = &self.recording_health {
            recording.fail_reconnect(
                msg.generation,
                msg.id,
                "Requested audio stream rebuild failed".into(),
            );
        }
        if self
            .system_reconnect
            .as_ref()
            .is_some_and(|pending| pending.id == msg.id && pending.generation == msg.generation)
        {
            self.system_reconnect = None;
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

        #[cfg(target_os = "linux")]
        if self.pulse_input_role == crate::sources::screen_capture::PulseInputRole::SystemAudio {
            self.system_stream_cancel.cancel();
            self.system_reconnect = None;
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
        #[cfg(windows)]
        self.prepare_unlocked_recovery();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_stream_errors_are_coalesced_while_a_notification_is_pending() {
        let (sender, receiver) = flume::unbounded();
        let mut report = microphone_stream_error_handler(sender, || {});
        for _ in 0..1024 {
            report(StreamError::DeviceNotAvailable);
        }
        assert_eq!(receiver.len(), 1);
    }

    #[test]
    fn stream_error_consumers_can_receive_a_later_recovery_attempt() {
        let (sender, receiver) = flume::bounded(1);
        let mut report = microphone_stream_error_handler(sender, || {});
        report(StreamError::DeviceNotAvailable);
        assert!(receiver.try_recv().is_ok());
        report(StreamError::DeviceNotAvailable);
        assert!(receiver.try_recv().is_ok());
    }

    #[test]
    fn stream_error_callback_never_waits_for_a_receiver() {
        let (sender, receiver) = flume::bounded(0);
        let mut report = microphone_stream_error_handler(sender, || {});
        report(StreamError::DeviceNotAvailable);
        assert!(receiver.is_empty());
        drop(receiver);
        report(StreamError::DeviceNotAvailable);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn system_audio_feed_retains_its_input_role() {
        let (sender, _receiver) = flume::bounded(1);
        let microphone = MicrophoneFeed::new(sender.clone());
        let system_audio = MicrophoneFeed::new_system_audio(sender);
        assert_eq!(
            microphone.pulse_input_role,
            crate::sources::screen_capture::PulseInputRole::Microphone
        );
        assert_eq!(
            system_audio.pulse_input_role,
            crate::sources::screen_capture::PulseInputRole::SystemAudio
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn routed_audio_waits_until_the_route_is_confirmed() {
        let received = Instant::now();
        assert!(!audio_follows_confirmed_route(
            received,
            Some(Duration::ZERO),
            true,
            None
        ));
        assert!(audio_follows_confirmed_route(received, None, false, None));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn routed_audio_rejects_old_samples_delivered_after_the_route_changed() {
        let routed_at = cap_timestamp::Timestamps::now();
        let received = routed_at.instant() + Duration::from_millis(20);
        assert!(!audio_follows_confirmed_route(
            received,
            Some(Duration::from_millis(40)),
            true,
            Some(routed_at)
        ));
        assert!(audio_follows_confirmed_route(
            received,
            Some(Duration::from_millis(10)),
            true,
            Some(routed_at)
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn routed_audio_rejects_an_unknown_or_unrepresentable_capture_delay() {
        let routed_at = cap_timestamp::Timestamps::now();
        let received = routed_at.instant() + Duration::from_millis(20);
        assert!(!audio_follows_confirmed_route(
            received,
            None,
            true,
            Some(routed_at)
        ));
        assert!(!audio_follows_confirmed_route(
            received,
            Some(Duration::MAX),
            true,
            Some(routed_at)
        ));
    }

    #[cfg(target_os = "linux")]
    fn system_recovery_fixture() -> (MicrophoneFeed, Arc<()>, SupportedStreamConfig) {
        let (sender, _receiver) = flume::bounded(1);
        let mut feed = MicrophoneFeed::new_system_audio(sender);
        let token = Arc::new(());
        let config = SupportedStreamConfig::new(
            1,
            cpal::SampleRate(48_000),
            cpal::SupportedBufferSize::Unknown,
            SampleFormat::F32,
        );
        let (done_tx, _done_rx) = mpsc::sync_channel(1);
        feed.lock_generation = 11;
        feed.input_id_counter = 8;
        feed.state = State::Locked {
            inner: AttachedState {
                id: 7,
                label: "synthetic-system".into(),
                config: config.clone(),
                buffer_size_frames: None,
                done_tx,
            },
            token: Arc::downgrade(&token),
        };
        (feed, token, config)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn system_error_schedules_one_reconnect_and_ignores_stale_errors() {
        let (mut feed, _token, _) = system_recovery_fixture();
        assert!(feed.take_system_error_reconnect(6).is_none());
        let request = feed.take_system_error_reconnect(7).unwrap();
        assert_eq!((request.id, request.generation), (7, 11));
        assert!(feed.take_system_error_reconnect(7).is_none());
        assert!(feed.system_reconnect_request_is_current(request));
        feed.lock_generation += 1;
        assert!(!feed.system_reconnect_request_is_current(request));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn microphone_errors_do_not_enter_system_audio_recovery() {
        let (mut feed, _token, _) = system_recovery_fixture();
        feed.pulse_input_role = crate::sources::screen_capture::PulseInputRole::Microphone;
        assert!(feed.take_system_error_reconnect(7).is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn watchdog_joins_pending_system_reconnect_without_reopening_device() {
        let (mut feed, _token, config) = system_recovery_fixture();
        let (ready_tx, ready_rx) = oneshot::channel();
        feed.system_reconnect = Some(SystemReconnect {
            previous_id: 7,
            id: 8,
            generation: 11,
            label: "synthetic-system".into(),
            ready: async move { ready_rx.await.unwrap() }.boxed().shared(),
        });
        let actor = MicrophoneFeed::spawn(feed);
        let first = actor
            .ask(SetInput {
                label: "synthetic-system".into(),
                settings: None,
            })
            .await
            .unwrap();
        let second = actor
            .ask(SetInput {
                label: "synthetic-system".into(),
                settings: None,
            })
            .await
            .unwrap();
        ready_tx.send(Ok((config, None))).unwrap();
        assert_eq!(first.await.unwrap().sample_rate(), cpal::SampleRate(48_000));
        assert_eq!(
            second.await.unwrap().sample_rate(),
            cpal::SampleRate(48_000)
        );
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn stale_system_reconnect_completion_cannot_replace_current_input() {
        let (mut feed, _token, config) = system_recovery_fixture();
        feed.system_reconnect = Some(SystemReconnect {
            previous_id: 7,
            id: 8,
            generation: 11,
            label: "synthetic-system".into(),
            ready: futures::future::ready(Ok((config.clone(), None)))
                .boxed()
                .shared(),
        });
        for (previous_id, generation, id) in [(6, 11, 8), (7, 10, 8), (7, 11, 9)] {
            let (done_tx, _done_rx) = mpsc::sync_channel(1);
            feed.handle_locked_input_reconnected(LockedInputReconnected {
                previous_id,
                generation,
                id,
                label: "synthetic-system".into(),
                config: config.clone(),
                buffer_size_frames: None,
                done_tx,
            });
            assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id==7));
            assert!(feed.system_reconnect.is_some());
        }
        let (done_tx, _done_rx) = mpsc::sync_channel(1);
        feed.handle_locked_input_reconnected(LockedInputReconnected {
            previous_id: 7,
            generation: 11,
            id: 8,
            label: "synthetic-system".into(),
            config,
            buffer_size_frames: None,
            done_tx,
        });
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id==8));
        assert!(feed.system_reconnect.is_none());
        assert!(feed.take_system_error_reconnect(7).is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn system_unlock_cancels_pending_rebuild_and_rejects_late_completion() {
        let (mut feed, token, config) = system_recovery_fixture();
        let cancel = feed.system_stream_cancel.clone();
        let ready =
            cancellable_system_stream_ready(futures::future::pending().boxed(), cancel.clone())
                .shared();
        feed.system_reconnect = Some(SystemReconnect {
            previous_id: 7,
            id: 8,
            generation: 11,
            label: "synthetic-system".into(),
            ready: ready.clone(),
        });
        let actor = MicrophoneFeed::spawn(feed);
        drop(token);
        actor.tell(Unlock { generation: 11 }).await.unwrap();
        actor.ask(GetDroppedMessageCount).await.unwrap();
        assert!(cancel.is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), ready)
                .await
                .unwrap()
                .is_err()
        );
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        actor
            .tell(LockedInputReconnected {
                previous_id: 7,
                generation: 11,
                id: 8,
                label: "synthetic-system".into(),
                config,
                buffer_size_frames: None,
                done_tx,
            })
            .await
            .unwrap();
        actor.ask(GetDroppedMessageCount).await.unwrap();
        assert!(matches!(
            done_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn pending_system_stream_error_cancels_ready_and_rejects_completion() {
        let (mut feed, _token, config) = system_recovery_fixture();
        let cancel = feed.system_stream_cancel.clone();
        let ready =
            cancellable_system_stream_ready(futures::future::pending().boxed(), cancel.clone())
                .shared();
        feed.system_reconnect = Some(SystemReconnect {
            previous_id: 7,
            id: 8,
            generation: 11,
            label: "synthetic-system".into(),
            ready: ready.clone(),
        });
        assert!(feed.take_system_error_reconnect(6).is_none());
        assert!(!cancel.is_cancelled());
        assert!(feed.take_system_error_reconnect(8).is_none());
        assert!(cancel.is_cancelled());
        assert!(
            tokio::time::timeout(Duration::from_millis(100), ready)
                .await
                .unwrap()
                .is_err()
        );
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        feed.handle_locked_input_reconnected(LockedInputReconnected {
            previous_id: 7,
            generation: 11,
            id: 8,
            label: "synthetic-system".into(),
            config,
            buffer_size_frames: None,
            done_tx,
        });
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 7));
        assert!(matches!(
            done_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        assert!(feed.take_system_error_reconnect(8).is_none());
        assert!(feed.take_system_error_reconnect(7).is_none());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn fault_after_ready_success_retires_cached_reconnect_before_completion() {
        let (mut feed, _token, config) = system_recovery_fixture();
        let ready = futures::future::ready(Ok((config.clone(), None)))
            .boxed()
            .shared();
        ready.clone().await.unwrap();
        feed.system_reconnect = Some(SystemReconnect {
            previous_id: 7,
            id: 8,
            generation: 11,
            label: "synthetic-system".into(),
            ready,
        });
        assert!(feed.take_system_error_reconnect(8).is_none());
        assert!(feed.system_reconnect.is_none());
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        feed.handle_locked_input_reconnected(LockedInputReconnected {
            previous_id: 7,
            generation: 11,
            id: 8,
            label: "synthetic-system".into(),
            config,
            buffer_size_frames: None,
            done_tx,
        });
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 7));
        assert!(feed.system_reconnect.is_none());
        assert!(matches!(
            done_rx.try_recv(),
            Err(mpsc::TryRecvError::Disconnected)
        ));
        assert!(feed.take_system_error_reconnect(8).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn dropping_system_feed_cancels_stream_and_recovery_work() {
        let (feed, _token, _) = system_recovery_fixture();
        let cancel = feed.system_stream_cancel.clone();
        drop(feed);
        assert!(cancel.is_cancelled());
    }

    #[test]
    fn native_error_notifies_recovery_only_once_per_stream() {
        let (sender, _receiver) = flume::bounded(1);
        let calls = Arc::new(AtomicU64::new(0));
        let observed = calls.clone();
        let mut handler = microphone_stream_error_handler(sender, move || {
            observed.fetch_add(1, Ordering::Relaxed);
        });
        for _ in 0..1024 {
            handler(StreamError::DeviceNotAvailable);
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
    }

    async fn locked_test_microphone()
    -> (ActorRef<MicrophoneFeed>, MicrophoneFeedLock, InputConnected) {
        let (error_tx, _error_rx) = flume::bounded(1);
        let (done_tx, _done_rx) = mpsc::sync_channel(1);
        let config = SupportedStreamConfig::new(
            1,
            cpal::SampleRate(48_000),
            cpal::SupportedBufferSize::Unknown,
            SampleFormat::F32,
        );
        let connection = InputConnected {
            id: 1,
            label: "test microphone".to_string(),
            config: config.clone(),
            buffer_size_frames: Some(480),
            done_tx: done_tx.clone(),
        };
        let mut microphone = MicrophoneFeed::new(error_tx);
        microphone.state = State::Open(OpenState {
            connecting: Some(ConnectingState {
                id: 1,
                ready: futures::future::ready(Ok(InputConnected {
                    id: 1,
                    label: "test microphone".to_string(),
                    config,
                    buffer_size_frames: Some(480),
                    done_tx,
                }))
                .boxed(),
            }),
            attached: None,
        });
        let feed = MicrophoneFeed::spawn(microphone);
        let lock = feed.ask(Lock).await.unwrap();
        (feed, lock, connection)
    }

    #[tokio::test]
    async fn microphone_late_connection_notification_keeps_locked_feed_alive() {
        let (feed, lock, connection) = locked_test_microphone().await;
        feed.tell(connection).await.unwrap();
        let result = feed.ask(GetDroppedMessageCount).await;
        drop(lock);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(
            result.is_ok(),
            "late connection notification stopped the feed: {result:?}"
        );
    }

    #[tokio::test]
    async fn microphone_late_failure_notification_keeps_locked_feed_alive() {
        let (feed, lock, _connection) = locked_test_microphone().await;
        feed.tell(InputConnectFailed { id: 1 }).await.unwrap();
        let result = feed.ask(GetDroppedMessageCount).await;
        drop(lock);
        feed.kill();
        feed.wait_for_stop().await;
        assert!(
            result.is_ok(),
            "late failure notification stopped the feed: {result:?}"
        );
    }

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
    fn virtual_linux_microphones_use_the_backend_buffer_size() {
        let linux = cfg!(target_os = "linux");

        assert_eq!(uses_default_microphone_buffer(Some("default")), linux);
        assert_eq!(uses_default_microphone_buffer(Some("PULSE")), linux);
        assert_eq!(uses_default_microphone_buffer(Some("PipeWire")), linux);
        assert!(!uses_default_microphone_buffer(Some("USB Microphone")));
        assert!(!uses_default_microphone_buffer(None));
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

#[cfg(all(test, target_os = "linux"))]
mod required_recording_health_tests {
    use super::*;

    fn microphone_fixture() -> (
        MicrophoneFeed,
        RecordingSourceHealth,
        SupportedStreamConfig,
        Arc<()>,
    ) {
        let (errors, _) = flume::bounded(1);
        let mut feed = MicrophoneFeed::new(errors);
        let health = RecordingSourceHealth::new(3, Arc::new(StreamHealth::new(7)));
        let config = SupportedStreamConfig::new(
            1,
            cpal::SampleRate(48_000),
            cpal::SupportedBufferSize::Unknown,
            SampleFormat::F32,
        );
        let token = Arc::new(());
        let (done_tx, _) = mpsc::sync_channel(1);
        feed.lock_generation = 3;
        feed.recording_health = Some(health.clone());
        feed.state = State::Locked {
            inner: AttachedState {
                id: 7,
                label: "synthetic-microphone".into(),
                config: config.clone(),
                buffer_size_frames: None,
                done_tx,
            },
            token: Arc::downgrade(&token),
        };
        (feed, health, config, token)
    }

    fn replacement(
        config: SupportedStreamConfig,
        generation: u64,
        previous_id: u32,
        id: u32,
    ) -> LockedInputReconnected {
        let (done_tx, _) = mpsc::sync_channel(1);
        LockedInputReconnected {
            previous_id,
            generation,
            id,
            label: "synthetic-microphone".into(),
            config,
            buffer_size_frames: None,
            done_tx,
        }
    }

    #[test]
    fn older_microphone_rebuild_cannot_split_actual_input_from_current_health() {
        let (mut feed, health, config, _token) = microphone_fixture();
        health.begin_reconnect(3, Arc::new(StreamHealth::new(8)));
        health.begin_reconnect(3, Arc::new(StreamHealth::new(9)));
        feed.handle_locked_input_reconnected(replacement(config.clone(), 3, 7, 8));
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 7));
        assert!(health.frame_is_current(7));
        feed.handle_locked_input_reconnected(replacement(config, 3, 7, 9));
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 9));
        assert!(health.frame_is_current(9));
        assert!(!health.frame_is_current(8));
    }

    #[test]
    fn old_lock_or_previous_input_completion_cannot_replace_current_microphone() {
        let (mut feed, health, config, _token) = microphone_fixture();
        health.begin_reconnect(3, Arc::new(StreamHealth::new(8)));
        feed.handle_locked_input_reconnected(replacement(config.clone(), 2, 7, 8));
        feed.handle_locked_input_reconnected(replacement(config, 3, 6, 8));
        assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 7));
        assert!(health.frame_is_current(7));
        assert!(health.expects_reconnect(3, 8));
    }

    #[test]
    fn actual_backend_callback_requires_replacement_frame_before_success() {
        let stream = Arc::new(StreamHealth::new(7));
        let health = RecordingSourceHealth::new(3, stream.clone());
        let (tx, _rx) = flume::bounded(1);
        let mut callback = microphone_stream_error_handler(tx, move || {
            stream.failed.store(true, Ordering::Release);
        });
        callback(StreamError::DeviceNotAvailable);
        assert!(health.terminal_error().is_none());
        assert!(health.stop_error().is_some());
        let replacement = Arc::new(StreamHealth::new(8));
        health.begin_reconnect(3, replacement);
        health.commit_reconnect(3, 8);
        assert!(health.stop_error().is_some());
        assert!(!health.frame_is_current(7));
        health.accepted_frame(7);
        assert!(health.stop_error().is_some());
        assert!(health.frame_is_current(8));
        health.accepted_frame(8);
        assert!(health.stop_error().is_none());
    }

    #[tokio::test]
    async fn pulse_loss_failed_rebuild_is_retained_before_ready_reply() {
        let stream = Arc::new(StreamHealth::new(0));
        let health = RecordingSourceHealth::new(1, stream.clone());
        stream.failed.store(true, Ordering::Release);
        health.begin_reconnect(1, Arc::new(StreamHealth::new(1)));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let ready = health.observe_ready(
            1,
            1,
            async move {
                rx.await.unwrap();
                Err(SetInputError::DeviceNotFound)
            }
            .boxed(),
        );
        assert!(health.terminal_error().is_none());
        tx.send(()).unwrap();
        assert!(ready.await.is_err());
        assert!(health.terminal_error().unwrap().contains("DeviceNotFound"));
        health.commit_reconnect(1, 1);
        health.accepted_frame(1);
        assert!(health.stop_error().is_some());
    }

    #[test]
    fn discovery_failure_is_sticky_without_a_silence_threshold() {
        let health = RecordingSourceHealth::test_healthy(7);
        health.fail_current(1, 7, "DeviceNotFound".into());
        health.begin_reconnect(1, Arc::new(StreamHealth::new(8)));
        health.commit_reconnect(1, 8);
        health.accepted_frame(8);
        assert_eq!(health.stop_error().as_deref(), Some("DeviceNotFound"));
    }

    #[test]
    fn stale_generation_and_previous_rebuild_cannot_poison_current_stream() {
        let health = RecordingSourceHealth::new(3, Arc::new(StreamHealth::new(7)));
        health.begin_reconnect(3, Arc::new(StreamHealth::new(8)));
        health.fail_current(2, 7, "stale lock".into());
        health.fail_reconnect(2, 8, "stale lock".into());
        health.fail_reconnect(3, 6, "stale rebuild".into());
        health.commit_reconnect(3, 8);
        health.fail_current(3, 7, "retired stream".into());
        health.fail_reconnect(3, 8, "late old ready error".into());
        assert!(health.stop_error().is_none());
        assert!(health.frame_is_current(8));
        assert!(!health.frame_is_current(7));
    }

    #[test]
    fn failed_pending_stream_cannot_be_committed_as_healthy() {
        let health = RecordingSourceHealth::test_healthy(7);
        let replacement = Arc::new(StreamHealth::new(8));
        health.begin_reconnect(1, replacement.clone());
        replacement.failed.store(true, Ordering::Release);
        health.commit_reconnect(1, 8);
        health.accepted_frame(8);
        assert!(health.terminal_error().is_some());
    }

    #[test]
    fn failed_current_callbacks_cannot_wait_forever_for_a_receive_timeout() {
        let stream = Arc::new(StreamHealth::new(7));
        let health = RecordingSourceHealth::new(3, stream.clone());
        let (tx, _rx) = flume::bounded(1);
        let mut callback = microphone_stream_error_handler(tx, move || {
            stream.failed.store(true, Ordering::Release);
        });
        callback(StreamError::DeviceNotAvailable);
        assert!(health.terminal_error().is_none());
        for _ in 0..128 {
            assert!(!health.frame_is_current(7));
        }
        let error = health.terminal_error().unwrap();
        assert!(error.contains("failed while continuing to deliver samples"));
        assert_eq!(health.stop_error(), Some(error));
    }

    #[test]
    fn failed_retired_callbacks_do_not_poison_a_healthy_current_replacement() {
        let health = RecordingSourceHealth::new(3, Arc::new(StreamHealth::new(7)));
        health.test_backend_failure();
        health.begin_reconnect(3, Arc::new(StreamHealth::new(8)));
        health.commit_reconnect(3, 8);
        for _ in 0..128 {
            assert!(!health.frame_is_current(7));
        }
        assert!(health.terminal_error().is_none());
        assert!(health.frame_is_current(8));
        health.accepted_frame(8);
        assert!(health.stop_error().is_none());
    }

    #[test]
    fn callback_failure_is_not_cleared_by_stale_or_late_rebuild_completion() {
        let (mut feed, health, config, _token) = microphone_fixture();
        health.begin_reconnect(3, Arc::new(StreamHealth::new(8)));
        health.test_backend_failure();
        assert!(!health.frame_is_current(7));
        let error = health.terminal_error();
        for generation in [2, 3] {
            feed.handle_locked_input_reconnected(replacement(config.clone(), generation, 7, 8));
            health.accepted_frame(8);
            assert!(matches!(&feed.state, State::Locked { inner, .. } if inner.id == 7));
            assert!(!health.frame_is_current(8));
            assert_eq!(health.terminal_error(), error);
            assert_eq!(health.stop_error(), error);
        }
    }

    #[test]
    fn healthy_silence_and_ready_without_backend_error_remain_successful() {
        let health = RecordingSourceHealth::test_healthy(7);
        assert!(health.stop_error().is_none());
        health.begin_reconnect(1, Arc::new(StreamHealth::new(8)));
        assert!(health.stop_error().is_none());
        health.commit_reconnect(1, 8);
        health.accepted_frame(8);
        assert!(health.stop_error().is_none());
    }
}

#[cfg(test)]
mod recording_reconnect_ownership_tests {
    use super::recording_reconnect_is_current;

    #[test]
    fn current_requested_reconnect_can_commit() {
        assert!(recording_reconnect_is_current(
            4,
            Some((4, 10, 11)),
            Some((10, "requested", true)),
            4,
            10,
            11,
            "requested"
        ));
    }

    #[test]
    fn stale_or_superseded_reconnect_cannot_commit() {
        for (generation, previous, replacement) in [(3, 10, 11), (4, 9, 11), (4, 10, 12)] {
            assert!(!recording_reconnect_is_current(
                4,
                Some((4, 10, 11)),
                Some((10, "requested", true)),
                generation,
                previous,
                replacement,
                "requested"
            ));
        }
        assert!(!recording_reconnect_is_current(
            4,
            Some((4, 10, 12)),
            Some((10, "requested", true)),
            4,
            10,
            11,
            "requested"
        ));
    }

    #[test]
    fn unlocked_or_different_device_reconnect_cannot_commit() {
        for current in [
            None,
            Some((10, "requested", false)),
            Some((10, "different", true)),
            Some((11, "requested", true)),
        ] {
            assert!(!recording_reconnect_is_current(
                4,
                Some((4, 10, 11)),
                current,
                4,
                10,
                11,
                "requested"
            ));
        }
        assert!(!recording_reconnect_is_current(
            4,
            None,
            Some((10, "requested", true)),
            4,
            10,
            11,
            "requested"
        ));
    }
}

#[cfg(all(test, windows))]
mod recording_subscription_tests {
    use super::*;
    use crate::output_pipeline::{AudioFrame, AudioMuxer, Muxer, OutputPipeline, TaskPool};

    fn config() -> SupportedStreamConfig {
        SupportedStreamConfig::new(
            1,
            cpal::SampleRate(48_000),
            cpal::SupportedBufferSize::Unknown,
            SampleFormat::F32,
        )
    }

    struct SharedFeedProbe {
        native: mpsc::Receiver<()>,
        _preview: flume::Receiver<MicrophoneSamples>,
    }

    impl SharedFeedProbe {
        fn try_recv(&self) -> Result<(), mpsc::TryRecvError> {
            self.native.try_recv()
        }
    }

    fn fixture() -> (MicrophoneFeed, Arc<()>, SharedFeedProbe) {
        let (errors, _errors) = flume::bounded(1);
        let mut feed = MicrophoneFeed::new(errors);
        let token = Arc::new(());
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        feed.lock_generation = 3;
        feed.input_id_counter = 8;
        feed.state = State::Locked {
            inner: AttachedState {
                id: 7,
                label: "requested".into(),
                config: config(),
                buffer_size_frames: None,
                done_tx,
            },
            token: Arc::downgrade(&token),
        };
        let _ = feed.stream_health.insert(7, Arc::new(StreamHealth::new(7)));
        let (preview, preview_rx) = flume::bounded(4);
        feed.senders.push(MicrophoneFeedSender::new(preview));
        (
            feed,
            token,
            SharedFeedProbe {
                native: done_rx,
                _preview: preview_rx,
            },
        )
    }

    fn attach(subscription: Arc<RecordingSubscription>) -> AttachRecordingSubscription {
        let (sender, _receiver) = flume::bounded(4);
        let (health_tx, _health_rx) = tokio::sync::mpsc::channel(4);
        AttachRecordingSubscription {
            subscription,
            sender,
            health_tx,
            label: "recording-test".into(),
        }
    }

    fn accepted_recovery(
        feed: &mut MicrophoneFeed,
        id: u32,
    ) -> (LockedInputReconnected, mpsc::Receiver<()>) {
        let generation = feed.lock_generation;
        let previous_id = match &feed.state {
            State::Locked { inner, .. } => inner.id,
            _ => panic!("locked fixture"),
        };
        let health = Arc::new(StreamHealth::new(id));
        let _ = feed.stream_health.insert(id, health.clone());
        let (done_tx, done_rx) = mpsc::sync_channel(1);
        let ready: StreamReadyFuture = futures::future::ready(Ok((config(), None))).boxed();
        feed.accept_windows_reconnect(
            WindowsReconnect {
                selection_generation: feed.selection_generation,
                generation,
                previous_id,
                id,
                label: "requested".into(),
                ready: ready.shared(),
                done_tx: done_tx.clone(),
            },
            health,
        );
        (
            LockedInputReconnected {
                previous_id,
                generation,
                id,
                label: "requested".into(),
                config: config(),
                buffer_size_frames: None,
                done_tx,
            },
            done_rx,
        )
    }

    struct Snapshot;
    impl Message<Snapshot> for MicrophoneFeed {
        type Reply = (u64, u32, Option<u32>, usize, usize, u32);
        async fn handle(&mut self, _: Snapshot, _: &mut Context<Self, Self::Reply>) -> Self::Reply {
            let id = match &self.state {
                State::Locked { inner, .. } => inner.id,
                State::Open(state) => state.attached.as_ref().map_or(0, |inner| inner.id),
            };
            (
                self.lock_generation,
                id,
                self.recording_reconnect.as_ref().map(|pending| pending.id),
                self.senders.len(),
                self.senders
                    .iter()
                    .filter(|sender| sender.subscription.is_some())
                    .count(),
                self.input_id_counter,
            )
        }
    }

    #[tokio::test]
    async fn stop_before_dispatch_rejects_rebuild_and_detaches_only_owned_sender() {
        let (feed, _token, native) = fixture();
        let actor = MicrophoneFeed::spawn(feed);
        let subscription =
            RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        actor.ask(attach(subscription.clone())).await.unwrap();
        assert!(subscription.retire().is_none());
        let result = actor
            .ask(ReconnectRecordingSubscription {
                subscription: subscription.clone(),
                label: "requested".into(),
                settings: MicrophoneDeviceSettings::default(),
            })
            .await;
        assert!(result.is_err());
        actor
            .ask(DetachRecordingSubscription(subscription))
            .await
            .unwrap();
        let snapshot = actor.ask(Snapshot).await.unwrap();
        assert_eq!(snapshot, (3, 7, None, 1, 0, 8));
        assert!(matches!(native.try_recv(), Err(mpsc::TryRecvError::Empty)));
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn accepted_rebuild_survives_detach_and_unlock_for_shared_preview() {
        let (mut feed, token, _native) = fixture();
        let subscription =
            RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        feed.attach_subscription(attach(subscription.clone()))
            .unwrap();
        let (replacement, native) = accepted_recovery(&mut feed, 8);
        let actor = MicrophoneFeed::spawn(feed);
        assert!(subscription.retire().is_none());
        actor
            .ask(DetachRecordingSubscription(subscription.clone()))
            .await
            .unwrap();
        drop(token);
        actor.ask(Unlock { generation: 3 }).await.unwrap();
        actor.ask(replacement).await.unwrap();
        assert_eq!(actor.ask(Snapshot).await.unwrap(), (3, 8, None, 1, 0, 8));
        assert!(matches!(native.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(!subscription.accepts_frame(7));
        assert!(!subscription.accepts_frame(8));
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn old_recovery_cannot_replace_a_newly_connected_user_selection() {
        let (mut feed, token, _old_native) = fixture();
        let (old_callback, old_native) = accepted_recovery(&mut feed, 8);
        let (selected_done, selected_native) = mpsc::sync_channel(1);
        feed.selection_generation = 1;
        let selected_config = config();
        let ready: BoxFuture<'static, Result<InputConnected, SetInputError>> =
            futures::future::pending().boxed();
        feed.state = State::Open(OpenState {
            connecting: Some(ConnectingState { id: 9, ready }),
            attached: None,
        });
        let actor = MicrophoneFeed::spawn(feed);
        drop(token);
        actor
            .ask(InputConnected {
                id: 9,
                label: "latest-user-selection".into(),
                config: selected_config,
                buffer_size_frames: None,
                done_tx: selected_done,
            })
            .await
            .unwrap();
        actor.ask(old_callback).await.unwrap();
        assert_eq!(actor.ask(Snapshot).await.unwrap().1, 9);
        assert!(matches!(
            selected_native.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        assert!(matches!(
            old_native.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn resumed_subscription_accepts_current_callback_and_ignores_retired_pcm_health() {
        let (mut feed, _token, _native) = fixture();
        let retired = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        feed.attach_subscription(attach(retired.clone())).unwrap();
        assert!(retired.retire().is_none());
        let resumed = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        feed.attach_subscription(attach(resumed.clone())).unwrap();
        let (callback, _replacement_native) = accepted_recovery(&mut feed, 8);
        let old_health = feed.stream_health.get(&7).unwrap().clone();
        let actor = MicrophoneFeed::spawn(feed);
        actor
            .ask(DetachRecordingSubscription(retired.clone()))
            .await
            .unwrap();
        actor.ask(callback).await.unwrap();
        assert!(resumed.accepts_frame(8));
        assert!(!resumed.accepts_frame(7));
        assert!(!retired.accepts_frame(7));
        assert!(!retired.accepts_frame(8));
        old_health.failed.store(true, Ordering::Release);
        actor
            .ask(WindowsReconnectFailed {
                generation: 3,
                id: 7,
                error: "stale callback".into(),
            })
            .await
            .unwrap();
        assert!(resumed.error().is_none());
        assert!(retired.error().is_none());
        assert_eq!(actor.ask(Snapshot).await.unwrap().4, 1);
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn resume_after_reconnect_acceptance_adopts_pending_stream_before_callback() {
        let (mut feed, _token, _native) = fixture();
        let retired = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        feed.attach_subscription(attach(retired.clone())).unwrap();
        let (callback, _replacement_native) = accepted_recovery(&mut feed, 8);
        let actor = MicrophoneFeed::spawn(feed);
        assert!(retired.retire().is_none());
        actor
            .ask(DetachRecordingSubscription(retired.clone()))
            .await
            .unwrap();
        let resumed = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        actor.ask(attach(resumed.clone())).await.unwrap();
        assert!(resumed.accepts_frame(7));
        assert!(!resumed.accepts_frame(8));
        actor.ask(callback).await.unwrap();
        assert!(resumed.accepts_frame(8));
        assert!(!resumed.accepts_frame(7));
        assert!(!retired.accepts_frame(8));
        assert!(resumed.error().is_none());
        assert_eq!(actor.ask(Snapshot).await.unwrap(), (3, 8, None, 2, 1, 8));
        actor.kill();
        actor.wait_for_stop().await;
    }

    #[tokio::test]
    async fn resume_rejects_pending_replacement_with_stale_actor_identity() {
        for mismatch in 0..4 {
            let (mut feed, _token, _native) = fixture();
            let (_callback, _replacement_native) = accepted_recovery(&mut feed, 8);
            let pending = feed.recording_reconnect.as_mut().unwrap();
            match mismatch {
                0 => pending.selection_generation += 1,
                1 => pending.generation += 1,
                2 => pending.previous_id += 1,
                _ => pending.label = "other-device".into(),
            }
            let actor = MicrophoneFeed::spawn(feed);
            let resumed = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
            assert!(actor.ask(attach(resumed.clone())).await.is_err());
            assert_eq!(actor.ask(Snapshot).await.unwrap().4, 0);
            assert!(!resumed.accepts_frame(7));
            actor.kill();
            actor.wait_for_stop().await;
        }
    }

    #[tokio::test]
    async fn resume_rejects_missing_or_failed_pending_backend_health() {
        for failed in [false, true] {
            let (mut feed, _token, _native) = fixture();
            let (_callback, _replacement_native) = accepted_recovery(&mut feed, 8);
            if failed {
                feed.stream_health
                    .get(&8)
                    .unwrap()
                    .failed
                    .store(true, Ordering::Release);
            } else {
                assert!(feed.stream_health.remove(&8).is_some());
            }
            let actor = MicrophoneFeed::spawn(feed);
            let resumed = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
            assert!(actor.ask(attach(resumed.clone())).await.is_err());
            assert_eq!(actor.ask(Snapshot).await.unwrap().4, 0);
            assert!(!resumed.accepts_frame(7));
            actor.kill();
            actor.wait_for_stop().await;
        }
    }

    struct SinkMuxer;
    impl Muxer for SinkMuxer {
        type Config = ();
        async fn setup(
            _: (),
            _: std::path::PathBuf,
            _: Option<cap_media_info::VideoInfo>,
            _: Option<AudioInfo>,
            _: Arc<AtomicBool>,
            _: &mut TaskPool,
        ) -> anyhow::Result<Self> {
            Ok(Self)
        }
        fn finish(&mut self, _: Duration) -> anyhow::Result<anyhow::Result<()>> {
            Ok(Ok(()))
        }
    }
    impl AudioMuxer for SinkMuxer {
        fn send_audio_frame(&mut self, _: AudioFrame, _: Duration) -> anyhow::Result<()> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn actual_microphone_pipeline_stop_detaches_and_propagates_backend_failure() {
        for fail in [false, true] {
            let (feed, token, native) = fixture();
            let health = feed.stream_health.get(&7).unwrap().clone();
            let actor = MicrophoneFeed::spawn(feed);
            let config = config();
            let lock = Arc::new(MicrophoneFeedLock {
                generation: 3,
                actor: actor.clone(),
                audio_info: AudioInfo::from_stream_config_with_buffer(&config, None),
                config,
                buffer_size_frames: None,
                drop_tx: None,
                device_name: "requested".into(),
                recording_muted: Arc::new(AtomicBool::new(false)),
                _token: token,
            });
            let temp = tempfile::tempdir().unwrap();
            let pipeline = OutputPipeline::builder(temp.path().join("unused.ogg"))
                .with_audio_source::<crate::sources::Microphone>(lock.clone())
                .build::<SinkMuxer>(())
                .await
                .unwrap();
            assert_eq!(actor.ask(Snapshot).await.unwrap().4, 1);
            if fail {
                health.failed.store(true, Ordering::Release);
            }
            let stopped = tokio::time::timeout(Duration::from_secs(2), pipeline.stop())
                .await
                .unwrap();
            assert_eq!(stopped.is_ok(), !fail);
            assert_eq!(actor.ask(Snapshot).await.unwrap().4, 0);
            assert_eq!(actor.ask(Snapshot).await.unwrap().3, 1);
            assert!(matches!(native.try_recv(), Err(mpsc::TryRecvError::Empty)));
            drop(lock);
            actor.kill();
            actor.wait_for_stop().await;
        }
    }

    #[test]
    fn unexpected_native_exit_is_sticky_only_for_current_live_subscription() {
        let health = Arc::new(StreamHealth::new(7));
        let subscription =
            RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        subscription.state.lock().unwrap().current = Some(health.clone());
        drop(StreamExitHealth {
            health: health.clone(),
            expected: false,
        });
        assert!(subscription.error().is_some());
        assert!(subscription.retire().is_some());
        let other = RecordingSubscription::new(3, tokio_util::sync::CancellationToken::new());
        let healthy = Arc::new(StreamHealth::new(8));
        other.state.lock().unwrap().current = Some(healthy.clone());
        assert!(other.retire().is_none());
        drop(StreamExitHealth {
            health: healthy.clone(),
            expected: false,
        });
        assert!(other.error().is_none());
        let expected = Arc::new(StreamHealth::new(9));
        drop(StreamExitHealth {
            health: expected.clone(),
            expected: true,
        });
        assert!(!expected.failed.load(Ordering::Acquire));
    }
}
