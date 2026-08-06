use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{MasterClock, SourceClockOutcome, SourceClockState, Timestamp, Timestamps};
use futures::{
    FutureExt, SinkExt, StreamExt, TryFutureExt,
    channel::{mpsc, oneshot},
    future::{BoxFuture, Shared},
    lock::Mutex,
    stream::FuturesUnordered,
};
use std::{
    any::Any,
    future,
    marker::PhantomData,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{self, AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::task::JoinHandle;
use tokio_util::sync::{CancellationToken, DropGuard};
use tracing::*;

const CONSECUTIVE_ANOMALY_ERROR_THRESHOLD: u64 = 60;
const LARGE_BACKWARD_JUMP_SECS: f64 = 1.0;
const LARGE_FORWARD_JUMP_SECS: f64 = 2.0;
/// How far a timestamp may lead the pipeline wall clock before a forward jump
/// is treated as a source-clock glitch instead of a real delivery gap. Covers
/// driver timestamp skew and warmup baseline offset.
const FORWARD_JUMP_WALL_TOLERANCE_SECS: f64 = 0.3;

const HEALTH_CHANNEL_CAPACITY: usize = 32;

pub const STALL_BUDGET_MS: u64 = 50;
pub(crate) const STALL_POLL_INTERVAL: Duration = Duration::from_micros(500);

pub const VIDEO_START_GATE_TIMEOUT: Duration = Duration::from_millis(500);

pub const AV_START_ALIGNMENT_LIMIT_NS: u64 = 500_000_000;

pub(crate) fn frame_timing_log_threshold_ms(video_config: &VideoInfo) -> u128 {
    let fps = if video_config.frame_rate.0 > 0 && video_config.frame_rate.1 > 0 {
        video_config.frame_rate.0 as f64 / video_config.frame_rate.1 as f64
    } else {
        30.0
    };
    ((1000.0 / fps) * 0.75).round().max(5.0) as u128
}

#[derive(Clone)]
pub struct VideoStartGate {
    inner: Arc<VideoStartGateInner>,
}

struct VideoStartGateInner {
    notify: tokio::sync::Notify,
    start_ns: AtomicU64,
    armed: AtomicBool,
}

impl VideoStartGate {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(VideoStartGateInner {
                notify: tokio::sync::Notify::new(),
                start_ns: AtomicU64::new(0),
                armed: AtomicBool::new(false),
            }),
        }
    }

    pub fn publish(&self, start_ns: u64) {
        if self
            .inner
            .armed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.inner.start_ns.store(start_ns, Ordering::Release);
            self.inner.notify.notify_waiters();
        }
    }

    pub fn is_armed(&self) -> bool {
        self.inner.armed.load(Ordering::Acquire)
    }

    pub fn start_ns_if_armed(&self) -> Option<u64> {
        if self.is_armed() {
            Some(self.inner.start_ns.load(Ordering::Acquire))
        } else {
            None
        }
    }

    pub async fn wait_with_timeout(&self, timeout: Duration) -> Option<u64> {
        if let Some(v) = self.start_ns_if_armed() {
            return Some(v);
        }
        let notified = self.inner.notify.notified();
        tokio::pin!(notified);
        match tokio::time::timeout(timeout, notified).await {
            Ok(()) => Some(self.inner.start_ns.load(Ordering::Acquire)),
            Err(_) => None,
        }
    }
}

impl Default for VideoStartGate {
    fn default() -> Self {
        Self::new()
    }
}

pub(crate) fn ns_to_sample_count(ns: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    (ns as u128 * sample_rate as u128 / 1_000_000_000u128) as u64
}

pub(crate) enum VideoStartGateAction {
    Passthrough,
    UseFrame(AudioFrame),
    DropFrame,
}

impl std::fmt::Debug for VideoStartGateAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Passthrough => f.write_str("Passthrough"),
            Self::UseFrame(frame) => write!(
                f,
                "UseFrame {{ samples: {}, rate: {} }}",
                frame.inner.samples(),
                frame.inner.rate()
            ),
            Self::DropFrame => f.write_str("DropFrame"),
        }
    }
}

pub(crate) async fn apply_video_start_gate(
    gate: &VideoStartGate,
    frame: &AudioFrame,
    master_clock: &Arc<MasterClock>,
    generator: &mut AudioTimestampGenerator,
    sample_rate: u32,
) -> VideoStartGateAction {
    let video_start_ns = match gate.wait_with_timeout(VIDEO_START_GATE_TIMEOUT).await {
        Some(v) => v,
        None => {
            warn!(
                timeout_ms = VIDEO_START_GATE_TIMEOUT.as_millis() as u64,
                "Video start gate expired before first video frame; \
                 audio will start without encoder-pair gating"
            );
            return VideoStartGateAction::Passthrough;
        }
    };

    let audio_start_ns_i64 = master_clock.remap_raw_ns(frame.timestamp);
    let audio_start_ns = audio_start_ns_i64.max(0) as u64;

    let offset_ns: i128 = video_start_ns as i128 - audio_start_ns as i128;
    let limit = AV_START_ALIGNMENT_LIMIT_NS as i128;
    if offset_ns.abs() > limit {
        warn!(
            video_start_ns,
            audio_start_ns,
            offset_ns = offset_ns as i64,
            limit_ns = AV_START_ALIGNMENT_LIMIT_NS,
            "First-frame A/V offset exceeds alignment limit; skipping trim"
        );
        return VideoStartGateAction::Passthrough;
    }

    if offset_ns == 0 {
        return VideoStartGateAction::Passthrough;
    }

    if offset_ns > 0 {
        let trim_samples = ns_to_sample_count(offset_ns as u64, sample_rate) as usize;
        if trim_samples == 0 {
            return VideoStartGateAction::Passthrough;
        }
        let total_samples = frame.inner.samples();
        if trim_samples >= total_samples {
            return VideoStartGateAction::DropFrame;
        }
        match trim_audio_frame_front(&frame.inner, trim_samples) {
            Some(trimmed) => {
                debug!(
                    trimmed_samples = trim_samples,
                    kept_samples = total_samples - trim_samples,
                    offset_ns = offset_ns as i64,
                    "Trimmed leading audio samples for encoder-pair alignment"
                );
                // Advance the timestamp to the first *committed* sample so that
                // first_timestamp (and therefore mic_start_time in metadata) reflects
                // the actual capture time after the trim, not the pre-trim buffer start.
                // Without this, the editor's mic_offset = display_start - mic_start equals
                // trim_duration and causes it to skip that same duration a second time.
                let trim_duration =
                    Duration::from_nanos(trim_samples as u64 * 1_000_000_000 / sample_rate as u64);
                VideoStartGateAction::UseFrame(AudioFrame::new(
                    trimmed,
                    frame.timestamp + trim_duration,
                ))
            }
            None => {
                warn!(
                    trim_samples,
                    total_samples,
                    "Audio frame trim helper returned None; falling back to passthrough"
                );
                VideoStartGateAction::Passthrough
            }
        }
    } else {
        let silence_ns = (-offset_ns) as u64;
        let silence_samples = ns_to_sample_count(silence_ns, sample_rate);
        if silence_samples == 0 {
            return VideoStartGateAction::Passthrough;
        }
        let advanced = generator.advance_by_duration(Duration::from_nanos(silence_ns));
        debug!(
            silence_ns,
            silence_samples,
            advanced,
            "Advanced audio timeline to match video start (audio arrived after video)"
        );
        VideoStartGateAction::Passthrough
    }
}

pub(crate) fn trim_audio_frame_front(
    frame: &ffmpeg::frame::Audio,
    samples_to_trim: usize,
) -> Option<ffmpeg::frame::Audio> {
    let total = frame.samples();
    if samples_to_trim == 0 {
        return Some(frame.clone());
    }
    if samples_to_trim >= total {
        return None;
    }
    let new_samples = total - samples_to_trim;
    let format = frame.format();
    let channels = frame.channels().max(1) as usize;
    let layout = frame.channel_layout();
    let rate = frame.rate();
    let bytes_per_sample = format.bytes();

    let mut new_frame = ffmpeg::frame::Audio::new(format, new_samples, layout);
    new_frame.set_rate(rate);
    new_frame.set_channel_layout(layout);

    if frame.is_planar() {
        for plane_idx in 0..channels.min(frame.planes()) {
            let src = frame.data(plane_idx);
            let dst = new_frame.data_mut(plane_idx);
            let offset = samples_to_trim * bytes_per_sample;
            let len = new_samples * bytes_per_sample;
            if src.len() < offset + len || dst.len() < len {
                return None;
            }
            dst[..len].copy_from_slice(&src[offset..offset + len]);
        }
    } else {
        let src = frame.data(0);
        let dst = new_frame.data_mut(0);
        let offset = samples_to_trim * bytes_per_sample * channels;
        let len = new_samples * bytes_per_sample * channels;
        if src.len() < offset + len || dst.len() < len {
            return None;
        }
        dst[..len].copy_from_slice(&src[offset..offset + len]);
    }

    Some(new_frame)
}

#[cfg(any(test, target_os = "macos", windows))]
pub(crate) enum BlockingThreadFinish {
    Clean,
    Failed(anyhow::Error),
    TimedOut(anyhow::Error),
}

#[cfg(any(test, target_os = "macos", windows))]
fn join_blocking_thread(
    handle: std::thread::JoinHandle<anyhow::Result<()>>,
    label: &str,
) -> anyhow::Result<()> {
    match handle.join() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(anyhow!("{label} returned error: {error:#}")),
        Err(panic_payload) => Err(anyhow!("{label} panicked during finish: {panic_payload:?}")),
    }
}

#[cfg(any(test, target_os = "macos", windows))]
pub(crate) fn spawn_blocking_thread_timeout_cleanup(
    handle: std::thread::JoinHandle<anyhow::Result<()>>,
    label: &str,
) -> std::sync::mpsc::Receiver<anyhow::Result<()>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let label = label.to_string();
    std::thread::spawn(move || {
        let result = join_blocking_thread(handle, &label);
        match &result {
            Ok(()) => warn!(worker = %label, "Timed-out blocking worker later exited cleanly"),
            Err(error) => error!(
                worker = %label,
                error = %error,
                "Timed-out blocking worker later exited with failure"
            ),
        }
        let _ = tx.send(result);
    });
    rx
}

#[derive(Debug, Clone)]
pub enum PipelineHealthEvent {
    FrameDropRateHigh {
        source: String,
        rate_pct: f64,
    },
    AudioGapDetected {
        gap_ms: u64,
    },
    AudioDegradedToVideoOnly {
        reason: String,
    },
    SourceRestarting,
    SourceRestarted,
    Stalled {
        source: String,
        waited_ms: u64,
    },
    MuxerCrashed {
        reason: String,
    },
    DiskSpaceLow {
        bytes_remaining: u64,
        warn_threshold_bytes: u64,
    },
    DiskSpaceExhausted {
        bytes_remaining: u64,
    },
    DeviceLost {
        subsystem: String,
    },
    EncoderRebuilt {
        backend: String,
        attempt: u32,
    },
    SourceAudioReset {
        source: String,
        starvation_ms: u64,
    },
    RecoveryFragmentCorrupt {
        path: String,
        reason: String,
    },
    CaptureTargetLost {
        target: String,
    },
}

pub type HealthSender = tokio::sync::mpsc::Sender<PipelineHealthEvent>;
pub type HealthReceiver = tokio::sync::mpsc::Receiver<PipelineHealthEvent>;

fn new_health_channel() -> (HealthSender, HealthReceiver) {
    tokio::sync::mpsc::channel(HEALTH_CHANNEL_CAPACITY)
}

pub fn emit_health(tx: &HealthSender, event: PipelineHealthEvent) {
    let _ = tx.try_send(event);
}

#[derive(Clone, Default)]
pub struct SharedHealthSender {
    inner: Arc<std::sync::RwLock<Option<HealthSender>>>,
}

impl SharedHealthSender {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(std::sync::RwLock::new(None)),
        }
    }

    pub fn set(&self, tx: HealthSender) {
        if let Ok(mut guard) = self.inner.write() {
            *guard = Some(tx);
        }
    }

    pub fn get(&self) -> Option<HealthSender> {
        self.inner.read().ok().and_then(|guard| guard.clone())
    }

    pub fn emit(&self, event: PipelineHealthEvent) {
        if let Some(tx) = self.get() {
            emit_health(&tx, event);
        }
    }
}

pub const DISK_SPACE_POLL_INTERVAL: Duration = Duration::from_secs(2);

pub struct DiskSpaceMonitor {
    last_poll: Option<Instant>,
    last_status: cap_utils::disk_space::DiskSpaceStatus,
    stopped: bool,
}

impl DiskSpaceMonitor {
    pub fn new() -> Self {
        Self {
            last_poll: None,
            last_status: cap_utils::disk_space::DiskSpaceStatus::Ok,
            stopped: false,
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn poll(&mut self, path: &Path, health: &SharedHealthSender) -> DiskSpacePollResult {
        if self.stopped {
            return DiskSpacePollResult::Stopped;
        }

        let now = Instant::now();
        if let Some(last) = self.last_poll
            && now.duration_since(last) < DISK_SPACE_POLL_INTERVAL
        {
            return DiskSpacePollResult::Skipped;
        }
        self.last_poll = Some(now);

        let bytes = match cap_utils::disk_space::free_bytes_for_path(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                trace!(error = %err, path = %path.display(), "DiskSpaceMonitor: free_bytes_for_path failed");
                return DiskSpacePollResult::Ok;
            }
        };

        let status = cap_utils::disk_space::DiskSpaceStatus::from_bytes(bytes);
        let changed = status != self.last_status;
        self.last_status = status;

        match status {
            cap_utils::disk_space::DiskSpaceStatus::Ok => DiskSpacePollResult::Ok,
            cap_utils::disk_space::DiskSpaceStatus::Low => {
                if changed {
                    warn!(
                        bytes_remaining = bytes,
                        warn_threshold_bytes = cap_utils::disk_space::LOW_DISK_WARN_BYTES,
                        path = %path.display(),
                        "Disk space low"
                    );
                    health.emit(PipelineHealthEvent::DiskSpaceLow {
                        bytes_remaining: bytes,
                        warn_threshold_bytes: cap_utils::disk_space::LOW_DISK_WARN_BYTES,
                    });
                }
                DiskSpacePollResult::Low {
                    bytes_remaining: bytes,
                }
            }
            cap_utils::disk_space::DiskSpaceStatus::Exhausted => {
                if changed {
                    error!(
                        bytes_remaining = bytes,
                        path = %path.display(),
                        "Disk space exhausted; stopping recording"
                    );
                    health.emit(PipelineHealthEvent::DiskSpaceExhausted {
                        bytes_remaining: bytes,
                    });
                }
                self.stopped = true;
                DiskSpacePollResult::Exhausted {
                    bytes_remaining: bytes,
                }
            }
        }
    }
}

impl Default for DiskSpaceMonitor {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskSpacePollResult {
    Skipped,
    Ok,
    Low { bytes_remaining: u64 },
    Exhausted { bytes_remaining: u64 },
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallSendOutcome {
    Sent,
    StalledAndDropped { waited_ms: u64 },
    Disconnected,
}

pub(crate) fn send_with_stall_budget_futures<T>(
    tx: &mut mpsc::Sender<T>,
    frame: T,
    source: &'static str,
    health_tx: &HealthSender,
) -> StallSendOutcome {
    let start = Instant::now();
    let budget = Duration::from_millis(STALL_BUDGET_MS);
    let mut frame = Some(frame);
    loop {
        let payload = frame.take().expect("frame retained across loop iterations");
        match tx.try_send(payload) {
            Ok(()) => return StallSendOutcome::Sent,
            Err(err) if err.is_full() => {
                let elapsed = start.elapsed();
                if elapsed >= budget {
                    let waited_ms = elapsed.as_millis() as u64;
                    emit_health(
                        health_tx,
                        PipelineHealthEvent::Stalled {
                            source: source.to_string(),
                            waited_ms,
                        },
                    );
                    return StallSendOutcome::StalledAndDropped { waited_ms };
                }
                frame = Some(err.into_inner());
                std::thread::sleep(STALL_POLL_INTERVAL);
            }
            Err(_) => return StallSendOutcome::Disconnected,
        }
    }
}

#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(crate) fn send_with_stall_budget_flume<T>(
    tx: &flume::Sender<T>,
    frame: T,
    source: &'static str,
    health_tx: &HealthSender,
) -> StallSendOutcome {
    let start = Instant::now();
    let deadline = start + Duration::from_millis(STALL_BUDGET_MS);
    match tx.send_deadline(frame, deadline) {
        Ok(()) => StallSendOutcome::Sent,
        Err(flume::SendTimeoutError::Timeout(_)) => {
            let waited_ms = start.elapsed().as_millis() as u64;
            emit_health(
                health_tx,
                PipelineHealthEvent::Stalled {
                    source: source.to_string(),
                    waited_ms,
                },
            );
            StallSendOutcome::StalledAndDropped { waited_ms }
        }
        Err(flume::SendTimeoutError::Disconnected(_)) => StallSendOutcome::Disconnected,
    }
}

#[cfg(any(test, target_os = "macos", windows))]
pub(crate) fn wait_for_blocking_thread_finish(
    handle: std::thread::JoinHandle<anyhow::Result<()>>,
    timeout: Duration,
    label: &str,
) -> BlockingThreadFinish {
    let start = Instant::now();

    loop {
        if handle.is_finished() {
            return match join_blocking_thread(handle, label) {
                Ok(()) => BlockingThreadFinish::Clean,
                Err(error) => BlockingThreadFinish::Failed(error),
            };
        }

        if start.elapsed() > timeout {
            drop(spawn_blocking_thread_timeout_cleanup(handle, label));
            return BlockingThreadFinish::TimedOut(anyhow!(
                "{label} did not finish within {:?}",
                timeout
            ));
        }

        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(any(target_os = "macos", windows))]
pub(crate) fn combine_finish_errors(
    primary: anyhow::Error,
    secondary: anyhow::Error,
) -> anyhow::Error {
    anyhow!("{primary:#}; {secondary:#}")
}

fn video_mux_send_error(frame_count: u64, error: anyhow::Error) -> anyhow::Error {
    anyhow!("Video muxer stopped accepting frames at frame {frame_count}: {error}")
}

pub(crate) struct AudioTimestampGenerator {
    sample_rate: u32,
    total_samples: u64,
    clock_samples_advanced: u64,
    master_clock: Option<Arc<MasterClock>>,
}

const VIDEO_WALL_CLOCK_TOLERANCE_SECS: f64 = 0.1;

impl AudioTimestampGenerator {
    #[cfg(test)]
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            total_samples: 0,
            clock_samples_advanced: 0,
            master_clock: None,
        }
    }

    #[cfg(test)]
    fn from_master_clock(master_clock: Arc<MasterClock>) -> Self {
        let rate = master_clock.sample_rate();
        Self::from_master_clock_with_rate(master_clock, rate)
    }

    /// The generator converts counted samples into time, so it must run at
    /// the audio source's real sample rate. The shared master clock may run
    /// at a different (default 48kHz) rate: counting a 44.1kHz mic's samples
    /// against a 48kHz clock makes the audio timeline lag real time and the
    /// gap tracker "corrects" the difference with bogus silence — the
    /// recording then plays at the wrong speed.
    fn from_master_clock_with_rate(master_clock: Arc<MasterClock>, sample_rate: u32) -> Self {
        Self {
            sample_rate: if sample_rate > 0 {
                sample_rate
            } else {
                master_clock.sample_rate()
            },
            total_samples: 0,
            clock_samples_advanced: 0,
            master_clock: Some(master_clock),
        }
    }

    fn advance_clock(&mut self) {
        let Some(clock) = &self.master_clock else {
            return;
        };
        // Convert source-rate samples into clock-rate samples so the shared
        // clock advances by real time regardless of the source's rate. The
        // conversion runs on the cumulative total: converting each buffer
        // independently truncates up to one clock sample per call, which
        // accumulates into real drift for non-integer ratios (44.1k -> 48k).
        let target = if clock.sample_rate() == self.sample_rate {
            self.total_samples
        } else {
            (self.total_samples as u128 * clock.sample_rate() as u128
                / u128::from(self.sample_rate.max(1))) as u64
        };
        let delta = target.saturating_sub(self.clock_samples_advanced);
        self.clock_samples_advanced = target;
        if delta > 0 {
            clock.advance_samples(delta);
        }
    }

    fn next_timestamp(&mut self, frame_samples: u64) -> Duration {
        let timestamp_nanos = samples_to_nanos(self.total_samples, self.sample_rate);
        self.total_samples += frame_samples;
        self.advance_clock();
        Duration::from_nanos(timestamp_nanos)
    }

    fn advance_by_duration(&mut self, duration: Duration) -> u64 {
        let samples = (duration.as_secs_f64() * self.sample_rate as f64).round() as u64;
        self.total_samples += samples;
        self.advance_clock();
        samples
    }
}

fn samples_to_nanos(samples: u64, sample_rate: u32) -> u64 {
    if sample_rate == 0 {
        return 0;
    }
    let nanos = (samples as u128 * 1_000_000_000u128) / sample_rate as u128;
    if nanos > u64::MAX as u128 {
        u64::MAX
    } else {
        nanos as u64
    }
}

const WIRED_GAP_THRESHOLD: Duration = Duration::from_millis(70);
const WIRELESS_GAP_THRESHOLD: Duration = Duration::from_millis(160);
const AUDIO_WALL_CLOCK_TOLERANCE: Duration = Duration::from_millis(100);
const AUDIO_OVERLAP_TOLERANCE: Duration = Duration::from_millis(5);
const LONG_SILENCE_LOG_THRESHOLD: Duration = Duration::from_secs(1);
/// Cap on individual synthesized-silence frames; long fills are emitted as a
/// sequence of frames so a multi-second dead zone doesn't allocate one giant
/// buffer.
const SILENCE_FRAME_MAX: Duration = Duration::from_secs(1);

/// How much trailing silence the track needs to reach the stop point.
/// `track_target_elapsed` must be in the track's own timeline (epoch-relative
/// target minus the track's start offset); both the previous overshoot
/// (mic tracks padded past the stop point) and the previous shortfall
/// (a system-audio track whose last sound came long before stop stayed
/// short) came from comparing an epoch-relative target against the
/// track-local timeline.
fn audio_tail_padding_duration(
    audio_elapsed: Duration,
    track_target_elapsed: Duration,
) -> Duration {
    track_target_elapsed.saturating_sub(audio_elapsed)
}

const STARTUP_OVERLAP_DROP_FRAME_COUNT: u64 = 3;

/// Overlap-trim accounting surfaced from the audio mux task at finish so the editor can
/// compensate for stale-startup drift from typed metadata rather than the recording log.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct AudioGapSummary {
    pub total_overlap_trimmed_ms: u32,
    pub startup_overlap_trimmed_ms: u32,
    pub overlap_dropped_frames: u32,
    pub startup_overlap_drops: u32,
}

struct AudioGapTracker {
    first_frame_ts: Option<Timestamp>,
    first_frame_wall_clock: Option<Instant>,
    reference: Timestamps,
    gap_threshold: Duration,
    total_silence_inserted: Duration,
    silence_insertion_count: u64,
    last_silence_log: Option<Instant>,
    overlap_event_count: u64,
    overlap_dropped_frames: u64,
    startup_overlap_drops: u64,
    total_overlap_trimmed: Duration,
    startup_overlap_trimmed: Duration,
}

impl AudioGapTracker {
    fn new(has_wireless_source: bool, reference: Timestamps) -> Self {
        Self {
            first_frame_ts: None,
            first_frame_wall_clock: None,
            reference,
            gap_threshold: if has_wireless_source {
                WIRELESS_GAP_THRESHOLD
            } else {
                WIRED_GAP_THRESHOLD
            },
            total_silence_inserted: Duration::ZERO,
            silence_insertion_count: 0,
            last_silence_log: None,
            overlap_event_count: 0,
            overlap_dropped_frames: 0,
            startup_overlap_drops: 0,
            total_overlap_trimmed: Duration::ZERO,
            startup_overlap_trimmed: Duration::ZERO,
        }
    }

    fn record_overlap(&mut self, overlap: Duration, dropped_whole_frame: bool, frame_count: u64) {
        self.overlap_event_count += 1;
        self.total_overlap_trimmed = self.total_overlap_trimmed.saturating_add(overlap);
        let is_startup_overlap = frame_count < STARTUP_OVERLAP_DROP_FRAME_COUNT;
        if is_startup_overlap {
            self.startup_overlap_trimmed = self.startup_overlap_trimmed.saturating_add(overlap);
        }
        if dropped_whole_frame {
            self.overlap_dropped_frames += 1;
            if is_startup_overlap {
                self.startup_overlap_drops += 1;
            }
        }
    }

    fn gap_summary(&self) -> AudioGapSummary {
        AudioGapSummary {
            total_overlap_trimmed_ms: u32::try_from(self.total_overlap_trimmed.as_millis())
                .unwrap_or(u32::MAX),
            startup_overlap_trimmed_ms: u32::try_from(self.startup_overlap_trimmed.as_millis())
                .unwrap_or(u32::MAX),
            overlap_dropped_frames: u32::try_from(self.overlap_dropped_frames).unwrap_or(u32::MAX),
            startup_overlap_drops: u32::try_from(self.startup_overlap_drops).unwrap_or(u32::MAX),
        }
    }

    fn mark_started(&mut self, frame_ts: Timestamp, wall_clock: Instant) {
        if self.first_frame_ts.is_none() {
            self.first_frame_ts = Some(frame_ts);
            self.first_frame_wall_clock = Some(wall_clock);
        }
    }

    fn started(&self) -> bool {
        self.first_frame_ts.is_some()
    }

    /// Offset of this track's timeline zero from the pipeline epoch: the
    /// capture time of the first muxed frame, or zero when the track is
    /// anchored at the epoch itself.
    fn track_start_offset(&self) -> Option<Duration> {
        let secs = self
            .first_frame_ts?
            .signed_duration_since_secs(self.reference);
        Some(Duration::from_secs_f64(secs.max(0.0)))
    }

    fn capture_elapsed(
        &self,
        current_frame_ts: Timestamp,
        total_pause_duration: Duration,
        wall_clock: Instant,
    ) -> Option<Duration> {
        let first_ts = self.first_frame_ts?;
        let first_wall_clock = self.first_frame_wall_clock?;
        let delta_secs = current_frame_ts.signed_duration_since_secs(self.reference)
            - first_ts.signed_duration_since_secs(self.reference);
        if !delta_secs.is_finite() || delta_secs <= 0.0 {
            return Some(Duration::ZERO);
        }
        let capture_elapsed =
            Duration::from_secs_f64(delta_secs).saturating_sub(total_pause_duration);
        let wall_clock_elapsed = wall_clock
            .saturating_duration_since(first_wall_clock)
            .saturating_sub(total_pause_duration)
            .saturating_add(AUDIO_WALL_CLOCK_TOLERANCE);

        Some(capture_elapsed.min(wall_clock_elapsed))
    }

    fn detect_gap(
        &self,
        current_frame_ts: Timestamp,
        sample_based_elapsed: Duration,
        total_pause_duration: Duration,
        wall_clock: Instant,
    ) -> Option<Duration> {
        let capture_elapsed =
            self.capture_elapsed(current_frame_ts, total_pause_duration, wall_clock)?;

        if capture_elapsed <= sample_based_elapsed {
            return None;
        }

        let gap = capture_elapsed.saturating_sub(sample_based_elapsed);
        if gap > self.gap_threshold {
            // The full gap is inserted: capture_elapsed is already clamped to
            // wall-clock elapsed (+tolerance), so a large value here is a real
            // silent stretch (e.g. WASAPI loopback delivers nothing while the
            // system plays no sound), not a bogus timestamp. Truncating it
            // (the old 1s cap) placed the audio that follows a long dead zone
            // up to the truncated amount too early until repeated insertions
            // converged, smearing the first seconds after the gap.
            Some(gap)
        } else {
            None
        }
    }

    fn detect_overlap(
        &self,
        current_frame_ts: Timestamp,
        sample_based_elapsed: Duration,
        total_pause_duration: Duration,
        wall_clock: Instant,
    ) -> Option<Duration> {
        let capture_elapsed =
            self.capture_elapsed(current_frame_ts, total_pause_duration, wall_clock)?;

        if sample_based_elapsed <= capture_elapsed.saturating_add(AUDIO_OVERLAP_TOLERANCE) {
            return None;
        }

        Some(sample_based_elapsed.saturating_sub(capture_elapsed))
    }

    fn record_insertion(&mut self, duration: Duration) {
        self.silence_insertion_count += 1;
        self.total_silence_inserted += duration;

        let should_log = self
            .last_silence_log
            .map(|t| t.elapsed() >= Duration::from_secs(5))
            .unwrap_or(true);

        if should_log {
            warn!(
                gap_ms = duration.as_millis(),
                total_silence_ms = self.total_silence_inserted.as_millis(),
                insertion_count = self.silence_insertion_count,
                threshold_ms = self.gap_threshold.as_millis(),
                "Audio gap detected, inserting silence"
            );
            self.last_silence_log = Some(Instant::now());
        }
    }
}

/// Send `total_samples` of synthesized silence starting at the track-local
/// sample position `start_samples`, split into frames of at most
/// [`SILENCE_FRAME_MAX`]. Each frame's mux timestamp is derived from the
/// running sample count so long fills stay sample-accurate.
async fn send_silence_frames<TMuxer: AudioMuxer>(
    muxer: &Arc<Mutex<TMuxer>>,
    audio_info: &AudioInfo,
    frame_ts: Timestamp,
    start_samples: u64,
    total_samples: u64,
) -> anyhow::Result<()> {
    let sample_rate = audio_info.sample_rate;
    let chunk_max = ((sample_rate.max(1) as u64) * SILENCE_FRAME_MAX.as_millis() as u64) / 1000;
    let chunk_max = chunk_max.max(1);
    let mut sent = 0u64;
    while sent < total_samples {
        let n = (total_samples - sent).min(chunk_max);
        let elapsed = Duration::from_nanos(samples_to_nanos(start_samples + sent, sample_rate));
        let silence = create_silence_frame(audio_info, n as usize);
        muxer
            .lock()
            .await
            .send_audio_frame(AudioFrame::new(silence, frame_ts), elapsed)?;
        sent += n;
    }
    Ok(())
}

fn create_silence_frame(audio_info: &AudioInfo, sample_count: usize) -> ffmpeg::frame::Audio {
    let mut frame = ffmpeg::frame::Audio::new(
        audio_info.sample_format,
        sample_count,
        audio_info.channel_layout(),
    );

    for i in 0..frame.planes() {
        frame.data_mut(i).fill(0);
    }

    frame.set_rate(audio_info.sample_rate);
    frame
}

fn duration_to_sample_count(duration: Duration, sample_rate: u32) -> u64 {
    let ns = duration.as_nanos().min(u64::MAX as u128) as u64;
    ns_to_sample_count(ns, sample_rate)
}

struct VideoDriftTracker {
    anchor: Option<(f64, f64)>,
    capped_frame_count: u64,
    clamp_warning_logged: bool,
}

impl VideoDriftTracker {
    fn new() -> Self {
        Self {
            anchor: None,
            capped_frame_count: 0,
            clamp_warning_logged: false,
        }
    }

    // Post-warmup video PTS are pinned to the wall clock, but anchored at the
    // warmup boundary's *source content time* rather than rebased onto the
    // absolute wall clock. The capture pipeline's startup latency makes the
    // source content clock lag the pipeline wall clock by a fixed amount (the
    // first frame arrives hundreds of ms after the pipeline starts). Rebasing the
    // output onto the absolute wall clock therefore injects that startup latency
    // as a one-time forward step at the boundary, freezing the video for the
    // latency duration and leaving every later frame behind the audio leg — which
    // is timestamped on its own content clock (samples since the first sample,
    // zeroed at the first frame just like video) and never wall-rebased. Anchoring
    // at the boundary keeps the output continuous with the warmup phase (which
    // emits raw source content time) so video and audio keep their shared zero.
    // The wall-clock *delta* from the anchor is still used, so collapsed capture
    // gaps (e.g. a static screen where the OS stops delivering frames) are covered
    // and long-run source-clock drift stays bounded to the wall clock.
    fn calculate_timestamp(
        &mut self,
        camera_duration: Duration,
        wall_clock_elapsed: Duration,
    ) -> Duration {
        let camera_secs = camera_duration.as_secs_f64();
        let wall_clock_secs = wall_clock_elapsed.as_secs_f64();
        let max_allowed_secs = wall_clock_secs + VIDEO_WALL_CLOCK_TOLERANCE_SECS;

        if self.anchor.is_none() && (wall_clock_secs < 2.0 || camera_secs < 2.0) {
            let result_secs = camera_secs.min(max_allowed_secs);
            if result_secs < camera_secs {
                self.capped_frame_count += 1;
            }
            return Duration::from_secs_f64(result_secs);
        }

        let (anchor_camera_secs, anchor_wall_secs) = *self.anchor.get_or_insert_with(|| {
            debug!(
                wall_clock_secs,
                camera_secs,
                baseline_offset_secs = camera_secs - wall_clock_secs,
                "Anchoring video output timeline at warmup boundary"
            );
            (camera_secs, wall_clock_secs)
        });

        let corrected_secs = anchor_camera_secs + (wall_clock_secs - anchor_wall_secs).max(0.0);

        let final_secs = corrected_secs.min(max_allowed_secs);
        if final_secs < corrected_secs {
            self.capped_frame_count += 1;
            if !self.clamp_warning_logged {
                warn!(
                    corrected_secs,
                    wall_clock_secs,
                    anchor_camera_secs,
                    anchor_wall_secs,
                    "Video timestamp exceeded wall-clock bound, clamping"
                );
                self.clamp_warning_logged = true;
            }
        }

        Duration::from_secs_f64(final_secs)
    }

    fn baseline_offset_secs(&self) -> Option<f64> {
        self.anchor
            .map(|(camera_secs, wall_secs)| camera_secs - wall_secs)
    }

    fn capped_frame_count(&self) -> u64 {
        self.capped_frame_count
    }
}
const DEFAULT_VIDEO_SOURCE_CHANNEL_CAPACITY: usize = 300;

fn get_video_source_channel_capacity() -> usize {
    std::env::var("CAP_VIDEO_SOURCE_BUFFER_SIZE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_VIDEO_SOURCE_CHANNEL_CAPACITY)
}

pub struct TimestampAnomalyTracker {
    stream_name: &'static str,
    anomaly_count: u64,
    consecutive_anomalies: u64,
    total_backward_skew_secs: f64,
    max_backward_skew_secs: f64,
    total_forward_skew_secs: f64,
    max_forward_skew_secs: f64,
    last_valid_duration: Option<Duration>,
    first_frame_baseline: Option<Duration>,
    accumulated_compensation_secs: f64,
    resync_count: u64,
    did_resync: bool,
    wall_clock_start: Option<Instant>,
    last_valid_wall_clock: Option<Instant>,
    wall_clock_confirmed_jumps: u64,
}

impl TimestampAnomalyTracker {
    pub fn new(stream_name: &'static str) -> Self {
        Self {
            stream_name,
            anomaly_count: 0,
            consecutive_anomalies: 0,
            total_backward_skew_secs: 0.0,
            max_backward_skew_secs: 0.0,
            total_forward_skew_secs: 0.0,
            max_forward_skew_secs: 0.0,
            last_valid_duration: None,
            first_frame_baseline: None,
            accumulated_compensation_secs: 0.0,
            resync_count: 0,
            did_resync: false,
            wall_clock_start: None,
            last_valid_wall_clock: None,
            wall_clock_confirmed_jumps: 0,
        }
    }

    pub fn process_timestamp(
        &mut self,
        timestamp: Timestamp,
        timestamps: Timestamps,
        wall_elapsed: Duration,
    ) -> Result<Duration, TimestampAnomalyError> {
        let now = Instant::now();

        if self.wall_clock_start.is_none() {
            self.wall_clock_start = Some(now);
        }

        let signed_secs = timestamp.signed_duration_since_secs(timestamps);

        if signed_secs < 0.0 {
            return self.handle_backward_timestamp(signed_secs);
        }

        let signed_duration = Duration::from_secs_f64(signed_secs);
        let baseline = self.first_frame_baseline.get_or_insert(signed_duration);
        let baseline_adjusted = signed_duration.saturating_sub(*baseline);
        let adjusted_secs =
            (baseline_adjusted.as_secs_f64() + self.accumulated_compensation_secs).max(0.0);
        let adjusted = Duration::from_secs_f64(adjusted_secs);

        if let Some(last) = self.last_valid_duration
            && let Some(forward_jump) = adjusted.checked_sub(last)
        {
            let jump_secs = forward_jump.as_secs_f64();
            if jump_secs > LARGE_FORWARD_JUMP_SECS {
                let result = self.handle_forward_jump(last, adjusted, jump_secs, now, wall_elapsed);
                self.last_valid_wall_clock = Some(now);
                return result;
            }
        }

        if self.consecutive_anomalies > 0 {
            info!(
                stream = self.stream_name,
                burst_length = self.consecutive_anomalies,
                total_anomalies = self.anomaly_count,
                resync_count = self.resync_count,
                "Timestamp anomaly burst resolved - valid timestamps resumed"
            );
            self.consecutive_anomalies = 0;
        }
        self.last_valid_duration = Some(adjusted);
        self.last_valid_wall_clock = Some(now);
        Ok(adjusted)
    }

    fn handle_backward_timestamp(
        &mut self,
        signed_secs: f64,
    ) -> Result<Duration, TimestampAnomalyError> {
        let skew_secs = signed_secs.abs();
        self.anomaly_count += 1;
        self.consecutive_anomalies += 1;
        self.total_backward_skew_secs += skew_secs;
        if skew_secs > self.max_backward_skew_secs {
            self.max_backward_skew_secs = skew_secs;
        }

        if self.consecutive_anomalies >= CONSECUTIVE_ANOMALY_ERROR_THRESHOLD {
            error!(
                stream = self.stream_name,
                consecutive = self.consecutive_anomalies,
                total_anomalies = self.anomaly_count,
                max_backward_skew_secs = self.max_backward_skew_secs,
                "Timestamp anomaly threshold exceeded - too many consecutive backward timestamps"
            );
            return Err(TimestampAnomalyError::TooManyConsecutiveAnomalies {
                count: self.consecutive_anomalies,
            });
        }

        if skew_secs >= LARGE_BACKWARD_JUMP_SECS {
            warn!(
                stream = self.stream_name,
                backward_secs = skew_secs,
                consecutive = self.consecutive_anomalies,
                total_anomalies = self.anomaly_count,
                resync_count = self.resync_count,
                "Large backward timestamp jump detected (clock skew?), compensating"
            );

            self.accumulated_compensation_secs += skew_secs;
            self.resync_count += 1;
            self.did_resync = true;
            self.consecutive_anomalies = 0;

            let adjusted = self.last_valid_duration.unwrap_or(Duration::ZERO);

            return Ok(adjusted);
        }

        if self.consecutive_anomalies == 1 {
            debug!(
                stream = self.stream_name,
                backward_secs = skew_secs,
                "Minor backward timestamp detected, using last valid"
            );
        }

        Ok(self.last_valid_duration.unwrap_or(Duration::ZERO))
    }

    fn handle_forward_jump(
        &mut self,
        last: Duration,
        current: Duration,
        jump_secs: f64,
        now: Instant,
        wall_elapsed: Duration,
    ) -> Result<Duration, TimestampAnomalyError> {
        let arrival_confirmed = self.last_valid_wall_clock.is_some_and(|last_wc| {
            let wall_clock_gap_secs = now.duration_since(last_wc).as_secs_f64();
            wall_clock_gap_secs >= jump_secs * 0.5
        });
        // A frame captured in real time can never be stamped ahead of the
        // wall clock, so a jump landing at-or-behind it is a real delivery
        // gap even when downstream queueing bunched the arrivals together
        // (a loaded encoder drains the pre-gap backlog and the post-gap
        // frame back-to-back, defeating the arrival-spacing check above).
        // Only future-stamped jumps are source-clock glitches.
        let within_wall_clock =
            current.as_secs_f64() <= wall_elapsed.as_secs_f64() + FORWARD_JUMP_WALL_TOLERANCE_SECS;
        let wall_clock_confirmed = arrival_confirmed || within_wall_clock;

        self.total_forward_skew_secs += jump_secs;
        if jump_secs > self.max_forward_skew_secs {
            self.max_forward_skew_secs = jump_secs;
        }

        if wall_clock_confirmed {
            // Frame delivery paused for about as long as the timestamp jump:
            // this is a real gap (static screen, stream restart, sleep/wake),
            // not a source-clock glitch. The gap must stay in the timeline —
            // collapsing it desyncs video from audio whenever it happens
            // before the wall-clock anchor exists to re-expand it.
            let wall_clock_gap_secs = self
                .last_valid_wall_clock
                .map(|wc| now.duration_since(wc).as_secs_f64())
                .unwrap_or(0.0);

            self.wall_clock_confirmed_jumps += 1;
            self.consecutive_anomalies = 0;
            self.last_valid_duration = Some(current);

            info!(
                stream = self.stream_name,
                forward_secs = jump_secs,
                wall_clock_gap_secs = format!("{:.3}", wall_clock_gap_secs),
                last_valid_ms = last.as_millis(),
                current_ms = current.as_millis(),
                resync_count = self.resync_count,
                confirmed_jumps = self.wall_clock_confirmed_jumps,
                "Wall-clock-confirmed forward jump (gap in frame delivery), accepting new baseline"
            );

            return Ok(current);
        }

        let expected_increment = Duration::from_millis(33);
        let adjusted = last.saturating_add(expected_increment);

        let compensation_secs = current.as_secs_f64() - adjusted.as_secs_f64();
        self.accumulated_compensation_secs -= compensation_secs;
        self.resync_count += 1;
        self.did_resync = true;

        {
            self.anomaly_count += 1;

            let wall_clock_gap_secs = self
                .last_valid_wall_clock
                .map(|wc| now.duration_since(wc).as_secs_f64())
                .unwrap_or(0.0);

            warn!(
                stream = self.stream_name,
                forward_secs = jump_secs,
                wall_clock_gap_secs = format!("{:.3}", wall_clock_gap_secs),
                last_valid_ms = last.as_millis(),
                current_ms = current.as_millis(),
                total_anomalies = self.anomaly_count,
                resync_count = self.resync_count,
                compensation_applied_secs = format!("{:.3}", compensation_secs),
                accumulated_compensation_secs =
                    format!("{:.3}", self.accumulated_compensation_secs),
                "Spurious forward timestamp jump (source clock glitch), resyncing timeline"
            );
        }

        self.last_valid_duration = Some(adjusted);
        self.consecutive_anomalies = 0;

        Ok(adjusted)
    }

    pub fn log_stats_if_notable(&self) {
        if self.anomaly_count == 0 && self.wall_clock_confirmed_jumps == 0 {
            return;
        }

        info!(
            stream = self.stream_name,
            anomaly_count = self.anomaly_count,
            wall_clock_confirmed_jumps = self.wall_clock_confirmed_jumps,
            total_backward_skew_secs = format!("{:.3}", self.total_backward_skew_secs),
            max_backward_skew_secs = format!("{:.3}", self.max_backward_skew_secs),
            total_forward_skew_secs = format!("{:.3}", self.total_forward_skew_secs),
            max_forward_skew_secs = format!("{:.3}", self.max_forward_skew_secs),
            resync_count = self.resync_count,
            accumulated_compensation_secs = format!("{:.3}", self.accumulated_compensation_secs),
            "Timestamp anomaly statistics"
        );
    }

    pub fn anomaly_count(&self) -> u64 {
        self.anomaly_count
    }

    pub fn take_resync_flag(&mut self) -> bool {
        let flag = self.did_resync;
        self.did_resync = false;
        flag
    }
}

#[derive(Debug, Clone)]
pub enum TimestampAnomalyError {
    TooManyConsecutiveAnomalies { count: u64 },
}

struct SharedPauseStateInner {
    paused_at: Option<Duration>,
    offset: Duration,
}

#[derive(Clone)]
pub struct SharedPauseState {
    flag: Arc<AtomicBool>,
    inner: Arc<std::sync::Mutex<SharedPauseStateInner>>,
}

impl SharedPauseState {
    pub fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            inner: Arc::new(std::sync::Mutex::new(SharedPauseStateInner {
                paused_at: None,
                offset: Duration::ZERO,
            })),
        }
    }

    pub fn adjust(&self, timestamp: Duration) -> anyhow::Result<Option<Duration>> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| anyhow!("Lock poisoned: {e}"))?;

        if self.flag.load(Ordering::Acquire) {
            if inner.paused_at.is_none() {
                inner.paused_at = Some(timestamp);
            }
            return Ok(None);
        }

        if let Some(start) = inner.paused_at.take() {
            let delta = match timestamp.checked_sub(start) {
                Some(d) => d,
                None => {
                    warn!(
                        resume_at = ?start,
                        current = ?timestamp,
                        "Timestamp anomaly: frame timestamp went backward during unpause (clock skew?), treating as zero delta"
                    );
                    Duration::ZERO
                }
            };

            inner.offset = match inner.offset.checked_add(delta) {
                Some(o) => o,
                None => {
                    warn!(
                        offset = ?inner.offset,
                        delta = ?delta,
                        "Timestamp anomaly: pause offset overflow, clamping to MAX"
                    );
                    Duration::MAX
                }
            };
        }

        let adjusted = match timestamp.checked_sub(inner.offset) {
            Some(t) => t,
            None => {
                warn!(
                    timestamp = ?timestamp,
                    offset = ?inner.offset,
                    "Timestamp anomaly: adjusted timestamp underflow (clock skew?), using zero"
                );
                Duration::ZERO
            }
        };

        Ok(Some(adjusted))
    }
}

struct SharedWallClockPauseInner {
    pause_started_at: Option<std::time::Instant>,
    total_pause_duration: Duration,
}

#[derive(Clone)]
pub struct SharedWallClockPause {
    flag: Arc<AtomicBool>,
    inner: Arc<std::sync::Mutex<SharedWallClockPauseInner>>,
}

impl SharedWallClockPause {
    pub fn new(flag: Arc<AtomicBool>) -> Self {
        Self {
            flag,
            inner: Arc::new(std::sync::Mutex::new(SharedWallClockPauseInner {
                pause_started_at: None,
                total_pause_duration: Duration::ZERO,
            })),
        }
    }

    pub fn check(&self) -> (bool, Duration) {
        let is_paused = self.flag.load(Ordering::Acquire);
        let mut inner = match self.inner.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        if is_paused {
            if inner.pause_started_at.is_none() {
                inner.pause_started_at = Some(std::time::Instant::now());
            }
        } else if let Some(started) = inner.pause_started_at.take() {
            let delta = started.elapsed();
            inner.total_pause_duration = inner.total_pause_duration.saturating_add(delta);
            debug!(
                pause_delta_ms = delta.as_millis(),
                total_pause_ms = inner.total_pause_duration.as_millis(),
                "Shared pause state: resumed"
            );
        }

        (is_paused, inner.total_pause_duration)
    }

    pub fn total_pause_duration(&self) -> Duration {
        match self.inner.lock() {
            Ok(guard) => guard.total_pause_duration,
            Err(poisoned) => poisoned.into_inner().total_pause_duration,
        }
    }
}

pub struct OnceSender<T>(Option<oneshot::Sender<T>>);

impl<T> OnceSender<T> {
    pub fn send(&mut self, v: T) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(v);
        }
    }
}

impl OutputPipeline {
    pub fn builder(path: PathBuf) -> OutputPipelineBuilder<NoVideo> {
        let timestamps = Timestamps::now();
        OutputPipelineBuilder::<NoVideo> {
            path,
            video: NoVideo,
            audio_sources: vec![],
            timestamps,
            master_clock: None,
            audio_anchor: AudioAnchor::FirstFrame,
        }
    }
}

/// Where the audio track's timeline zero (and therefore its persisted
/// `start_time`) is anchored.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AudioAnchor {
    /// Timeline zero is the capture timestamp of the first frame the muxer
    /// sees. Right for device-backed sources (microphone, camera audio):
    /// the device produces samples continuously once live, so the first
    /// frame marks "device ready" and downstream start-time alignment cuts
    /// all tracks to the latest-starting device.
    FirstFrame,
    /// Timeline zero is the pipeline epoch; silence is synthesized from the
    /// epoch up to the first captured frame. Right for intermittent sources
    /// (WASAPI loopback system audio) where the first packet marks "first
    /// sound played", not "source ready" — anchoring such a track at its
    /// first frame would let a late first sound become the cross-track
    /// alignment anchor and cut the head off every other track.
    PipelineEpoch,
}

pub struct SetupCtx {
    tasks: TaskPool,
    health_tx: HealthSender,
    master_clock: Arc<MasterClock>,
    stop_token: CancellationToken,
    stop_signal: PipelineStopSignal,
}

impl SetupCtx {
    fn new(
        health_tx: HealthSender,
        master_clock: Arc<MasterClock>,
        stop_token: CancellationToken,
        stop_signal: PipelineStopSignal,
    ) -> Self {
        Self {
            tasks: TaskPool::default(),
            health_tx,
            master_clock,
            stop_token,
            stop_signal,
        }
    }

    pub fn tasks(&mut self) -> &mut TaskPool {
        &mut self.tasks
    }

    pub fn health_tx(&self) -> &HealthSender {
        &self.health_tx
    }

    pub fn master_clock(&self) -> &Arc<MasterClock> {
        &self.master_clock
    }

    pub fn stop_token(&self) -> CancellationToken {
        self.stop_token.clone()
    }

    pub fn stop_signal(&self) -> PipelineStopSignal {
        self.stop_signal.clone()
    }
}

type AudioSourceSetupFn = Box<
    dyn FnOnce(
            mpsc::Sender<AudioFrame>,
            &mut SetupCtx,
        ) -> BoxFuture<'static, anyhow::Result<ErasedAudioSource>>
        + Send,
>;

pub struct OutputPipelineBuilder<TVideo> {
    path: PathBuf,
    video: TVideo,
    audio_sources: Vec<AudioSourceSetupFn>,
    timestamps: Timestamps,
    master_clock: Option<Arc<MasterClock>>,
    audio_anchor: AudioAnchor,
}

pub struct NoVideo;
pub struct HasVideo<TVideo: VideoSource> {
    config: TVideo::Config,
}

impl<THasVideo> OutputPipelineBuilder<THasVideo> {
    pub fn with_audio_source<TAudio: AudioSource>(
        mut self,
        config: TAudio::Config,
    ) -> OutputPipelineBuilder<THasVideo> {
        self.audio_sources.push(Box::new(move |tx, ctx| {
            TAudio::setup(config, tx, ctx)
                .map(|v| v.map(ErasedAudioSource::new))
                .boxed()
        }));

        self
    }

    pub fn set_timestamps(&mut self, timestamps: Timestamps) {
        self.timestamps = timestamps;
    }

    pub fn with_timestamps(mut self, timestamps: Timestamps) -> Self {
        self.timestamps = timestamps;
        self
    }

    pub fn with_master_clock(mut self, master_clock: Arc<MasterClock>) -> Self {
        self.master_clock = Some(master_clock);
        self
    }

    pub fn set_master_clock(&mut self, master_clock: Arc<MasterClock>) {
        self.master_clock = Some(master_clock);
    }

    /// Anchor the audio track at the pipeline epoch instead of the first
    /// captured frame. See [`AudioAnchor::PipelineEpoch`].
    pub fn with_audio_anchor(mut self, anchor: AudioAnchor) -> Self {
        self.audio_anchor = anchor;
        self
    }
}

impl OutputPipelineBuilder<NoVideo> {
    pub fn with_video<TVideo: VideoSource>(
        self,
        config: TVideo::Config,
    ) -> OutputPipelineBuilder<HasVideo<TVideo>> {
        OutputPipelineBuilder::<HasVideo<TVideo>> {
            video: HasVideo { config },
            path: self.path,
            audio_sources: self.audio_sources,
            timestamps: self.timestamps,
            master_clock: self.master_clock,
            audio_anchor: self.audio_anchor,
        }
    }
}

#[derive(Default)]
pub struct TaskPool(Vec<(&'static str, JoinHandle<anyhow::Result<()>>)>);

impl TaskPool {
    pub fn spawn<F>(&mut self, name: &'static str, future: F)
    where
        F: Future<Output = anyhow::Result<()>> + Send + 'static,
    {
        self.0.push((
            name,
            tokio::spawn(
                async {
                    trace!("Task started");
                    let res = future.await;
                    match &res {
                        Ok(_) => info!("Task finished successfully"),
                        Err(err) => error!("Task failed: {:#}", err),
                    }
                    res
                }
                .instrument(error_span!("", task = name))
                .in_current_span(),
            ),
        ));
    }

    pub fn spawn_thread(
        &mut self,
        name: &'static str,
        cb: impl FnOnce() -> anyhow::Result<()> + Send + 'static,
    ) {
        let span = error_span!("", task = name);
        let (done_tx, done_rx) = oneshot::channel();
        std::thread::spawn(move || {
            let _guard = span.enter();
            trace!("Task started");
            let _ = done_tx.send(cb());
            info!("Task finished");
        });
        self.0.push((
            name,
            tokio::spawn(
                done_rx
                    .map_err(|_| anyhow!("Cancelled"))
                    .map(|v| v.and_then(|v| v)),
            ),
        ));
    }
}

impl<TVideo: VideoSource> OutputPipelineBuilder<HasVideo<TVideo>> {
    pub async fn build<TMuxer: VideoMuxer<VideoFrame = TVideo::Frame> + AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            video,
            audio_sources,
            timestamps,
            path,
            master_clock,
            audio_anchor,
            ..
        } = self;

        let has_audio_sources = !audio_sources.is_empty();

        let build_ctx = BuildCtx::new();
        let master_clock = master_clock
            .unwrap_or_else(|| MasterClock::new(timestamps, AudioMixer::INFO.rate() as u32));
        let mut setup_ctx = SetupCtx::new(
            build_ctx.health_tx.clone(),
            master_clock.clone(),
            build_ctx.stop_token.clone(),
            build_ctx.stop_signal.clone(),
        );

        let (video_source, video_rx) =
            setup_video_source::<TVideo>(video.config, &mut setup_ctx).await?;

        let video_info = video_source.video_info();
        let (first_tx, first_rx) = oneshot::channel();

        let audio = setup_audio_sources(
            &mut setup_ctx,
            audio_sources,
            build_ctx.stop_token.clone(),
            timestamps,
        )
        .await
        .context("setup_audio_sources")?;

        let muxer = setup_muxer::<TMuxer>(
            muxer_config,
            &path,
            Some(video_info),
            audio.as_ref().map(|v| v.audio_info),
            &build_ctx.pause_flag,
            &mut setup_ctx,
        )
        .await?;

        let shared_pause = SharedWallClockPause::new(build_ctx.pause_flag.clone());
        let video_frame_count = Arc::new(AtomicU64::new(0));
        let video_timestamp_span = Arc::new(VideoTimestampSpan::default());

        let video_start_gate = has_audio_sources.then(VideoStartGate::new);

        spawn_video_encoder(
            &mut setup_ctx,
            video_source,
            video_rx,
            first_tx,
            build_ctx.stop_token.clone(),
            muxer.clone(),
            timestamps,
            shared_pause.clone(),
            video_frame_count.clone(),
            video_timestamp_span.clone(),
            master_clock.clone(),
            video_info,
            video_start_gate.clone(),
        );

        let audio_gap_summary = Arc::new(OnceLock::new());

        finish_build(
            setup_ctx,
            audio,
            build_ctx.stop_token.clone(),
            muxer,
            timestamps,
            build_ctx.done_tx,
            None,
            &path,
            shared_pause,
            true,
            video_start_gate,
            build_ctx.stop_signal,
            audio_gap_summary.clone(),
            audio_anchor,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            video_info: Some(video_info),
            stop_token: Some(build_ctx.stop_token.clone().drop_guard()),
            done_fut: build_ctx.done_rx,
            pause_flag: build_ctx.pause_flag,
            cancel_token: build_ctx.stop_token,
            video_frame_count,
            video_timestamp_span,
            health_rx: Some(build_ctx.health_rx),
            audio_gap_summary,
        })
    }
}

impl OutputPipelineBuilder<NoVideo> {
    pub async fn build<TMuxer: AudioMuxer>(
        self,
        muxer_config: TMuxer::Config,
    ) -> anyhow::Result<OutputPipeline> {
        let Self {
            audio_sources,
            timestamps,
            path,
            master_clock,
            audio_anchor,
            ..
        } = self;

        if audio_sources.is_empty() {
            return Err(anyhow!("Invariant: No audio sources"));
        }

        let build_ctx = BuildCtx::new();
        let master_clock = master_clock
            .unwrap_or_else(|| MasterClock::new(timestamps, AudioMixer::INFO.rate() as u32));
        let mut setup_ctx = SetupCtx::new(
            build_ctx.health_tx.clone(),
            master_clock.clone(),
            build_ctx.stop_token.clone(),
            build_ctx.stop_signal.clone(),
        );

        let (first_tx, first_rx) = oneshot::channel();

        let audio = setup_audio_sources(
            &mut setup_ctx,
            audio_sources,
            build_ctx.stop_token.clone(),
            timestamps,
        )
        .await
        .context("setup_audio_sources")?;

        let muxer = setup_muxer::<TMuxer>(
            muxer_config,
            &path,
            None,
            audio.as_ref().map(|v| v.audio_info),
            &build_ctx.pause_flag,
            &mut setup_ctx,
        )
        .await?;

        let shared_pause = SharedWallClockPause::new(build_ctx.pause_flag.clone());
        let audio_gap_summary = Arc::new(OnceLock::new());

        finish_build(
            setup_ctx,
            audio,
            build_ctx.stop_token.clone(),
            muxer,
            timestamps,
            build_ctx.done_tx,
            Some(first_tx),
            &path,
            shared_pause,
            false,
            None,
            build_ctx.stop_signal,
            audio_gap_summary.clone(),
            audio_anchor,
        )
        .await?;

        Ok(OutputPipeline {
            path,
            first_timestamp_rx: first_rx,
            stop_token: Some(build_ctx.stop_token.clone().drop_guard()),
            video_info: None,
            done_fut: build_ctx.done_rx,
            pause_flag: build_ctx.pause_flag,
            cancel_token: build_ctx.stop_token,
            video_frame_count: Arc::new(AtomicU64::new(0)),
            video_timestamp_span: Arc::new(VideoTimestampSpan::default()),
            health_rx: Some(build_ctx.health_rx),
            audio_gap_summary,
        })
    }
}

struct BuildCtx {
    stop_token: CancellationToken,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    done_rx: DoneFut,
    pause_flag: Arc<AtomicBool>,
    health_tx: HealthSender,
    health_rx: HealthReceiver,
    stop_signal: PipelineStopSignal,
}

impl BuildCtx {
    pub fn new() -> Self {
        let stop_token = CancellationToken::new();

        let (done_tx, done_rx) = oneshot::channel();
        let (health_tx, health_rx) = new_health_channel();
        let stop_signal = PipelineStopSignal::default();

        Self {
            stop_token,
            done_tx,
            done_rx: done_rx
                .map(|v| {
                    v.map_err(anyhow::Error::from)
                        .and_then(|v| v)
                        .map_err(|e| PipelineDoneError(Arc::new(e)))
                })
                .boxed()
                .shared(),
            pause_flag: Arc::new(AtomicBool::new(false)),
            health_tx,
            health_rx,
            stop_signal,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn finish_build(
    mut setup_ctx: SetupCtx,
    audio: Option<PreparedAudioSources>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<impl AudioMuxer>>,
    timestamps: Timestamps,
    done_tx: oneshot::Sender<anyhow::Result<()>>,
    first_tx: Option<oneshot::Sender<Timestamp>>,
    path: &Path,
    shared_pause: SharedWallClockPause,
    has_video: bool,
    video_start_gate: Option<VideoStartGate>,
    stop_signal: PipelineStopSignal,
    gap_summary_slot: Arc<OnceLock<AudioGapSummary>>,
    audio_anchor: AudioAnchor,
) -> anyhow::Result<()> {
    if let Some(audio) = audio {
        audio.configure(
            &mut setup_ctx,
            muxer.clone(),
            stop_token.clone(),
            timestamps,
            first_tx,
            shared_pause,
            has_video,
            video_start_gate,
            gap_summary_slot,
            audio_anchor,
        );
    }

    tokio::spawn(
        async move {
            let (task_names, task_handles): (Vec<_>, Vec<_>) =
                setup_ctx.tasks.0.into_iter().unzip();

            let mut futures = FuturesUnordered::from_iter(
                task_handles
                    .into_iter()
                    .zip(task_names)
                    .map(|(f, n)| f.map(move |r| (r, n))),
            );

            while let Some((result, name)) = futures.next().await {
                match result {
                    Err(_) => {
                        return Err(anyhow::anyhow!("Task {name} failed unexpectedly"));
                    }
                    Ok(Err(e)) => {
                        return Err(anyhow::anyhow!("Task {name} failed: {e}"));
                    }
                    _ => {}
                }
            }

            Ok(())
        }
        .then(async move |res| {
            let muxer_res = muxer.lock().await.finish(timestamps.instant().elapsed());

            let _ = done_tx.send(resolve_pipeline_completion(res, muxer_res, &stop_signal));
        }),
    );

    info!("Built pipeline for output {}", path.display());

    Ok(())
}

fn resolve_pipeline_completion(
    task_result: anyhow::Result<()>,
    muxer_result: anyhow::Result<anyhow::Result<()>>,
    stop_signal: &PipelineStopSignal,
) -> anyhow::Result<()> {
    match (task_result, muxer_result) {
        (Err(error), _) | (_, Err(error)) => Err(error),
        (_, Ok(Ok(()))) if stop_signal.user_stopped() => Ok(()),
        (_, Ok(Ok(()))) => Ok(()),
        (_, Ok(Err(error))) => Err(anyhow!("Muxer finish failed: {error:#}")),
    }
}

async fn setup_video_source<TVideo: VideoSource>(
    video_config: TVideo::Config,
    setup_ctx: &mut SetupCtx,
) -> anyhow::Result<(TVideo, mpsc::Receiver<TVideo::Frame>)> {
    let capacity = get_video_source_channel_capacity();
    let (video_tx, video_rx) = mpsc::channel(capacity);
    let video_source = TVideo::setup(video_config, video_tx, setup_ctx).await?;

    Ok((video_source, video_rx))
}

async fn setup_muxer<TMuxer: Muxer>(
    muxer_config: TMuxer::Config,
    path: &Path,
    video_info: Option<VideoInfo>,
    audio_info: Option<AudioInfo>,
    pause_flag: &Arc<AtomicBool>,
    setup_ctx: &mut SetupCtx,
) -> Result<Arc<Mutex<TMuxer>>, anyhow::Error> {
    let mut muxer = TMuxer::setup(
        muxer_config,
        path.to_path_buf(),
        video_info,
        audio_info,
        pause_flag.clone(),
        &mut setup_ctx.tasks,
    )
    .await?;

    muxer.set_health_sender(setup_ctx.health_tx().clone());

    Ok(Arc::new(Mutex::new(muxer)))
}

fn estimate_video_frame_duration_ns(video_info: &VideoInfo) -> u64 {
    let fps = video_info.fps();
    if fps == 0 {
        return 33_333_333;
    }
    1_000_000_000 / fps as u64
}

/// Span of the video timestamps actually sent to the muxer, used to report
/// the real encoded media duration. Capture is VFR (static screens, dropped
/// frames), so `frame_count / fps` under-reports the duration by the length
/// of every gap.
#[derive(Debug)]
pub struct VideoTimestampSpan {
    first_ns: AtomicU64,
    last_ns: AtomicU64,
}

impl Default for VideoTimestampSpan {
    fn default() -> Self {
        Self {
            first_ns: AtomicU64::new(u64::MAX),
            last_ns: AtomicU64::new(0),
        }
    }
}

impl VideoTimestampSpan {
    fn record(&self, timestamp: Duration) {
        let ns = timestamp.as_nanos().min(u64::MAX as u128) as u64;
        self.first_ns.fetch_min(ns, Ordering::AcqRel);
        self.last_ns.fetch_max(ns, Ordering::AcqRel);
    }

    pub fn get(&self) -> Option<(Duration, Duration)> {
        let first = self.first_ns.load(Ordering::Acquire);
        if first == u64::MAX {
            return None;
        }
        let last = self.last_ns.load(Ordering::Acquire).max(first);
        Some((Duration::from_nanos(first), Duration::from_nanos(last)))
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_video_encoder<TMutex: VideoMuxer<VideoFrame = TVideo::Frame>, TVideo: VideoSource>(
    setup_ctx: &mut SetupCtx,
    mut video_source: TVideo,
    mut video_rx: mpsc::Receiver<TVideo::Frame>,
    first_tx: oneshot::Sender<Timestamp>,
    stop_token: CancellationToken,
    muxer: Arc<Mutex<TMutex>>,
    timestamps: Timestamps,
    shared_pause: SharedWallClockPause,
    frame_counter: Arc<AtomicU64>,
    timestamp_span: Arc<VideoTimestampSpan>,
    master_clock: Arc<MasterClock>,
    video_info: VideoInfo,
    video_start_gate: Option<VideoStartGate>,
) {
    let frame_duration_ns = estimate_video_frame_duration_ns(&video_info);
    setup_ctx.tasks().spawn("capture-video", {
        let stop_token = stop_token.clone();
        async move {
            video_source.start().await?;

            stop_token.cancelled().await;

            match tokio::time::timeout(Duration::from_secs(5), video_source.stop()).await {
                Ok(Err(e)) => {
                    error!("Video source stop failed: {e:#}");
                }
                Err(_) => {
                    error!("Video source stop timed out after 5s, proceeding with shutdown");
                }
                Ok(Ok(())) => {}
            }

            Ok(())
        }
    });

    setup_ctx.tasks().spawn("mux-video", async move {
        use futures::StreamExt;

        let mut first_tx = Some(first_tx);
        let mut frame_count = 0u64;
        let mut anomaly_tracker = TimestampAnomalyTracker::new("video");
        let mut drift_tracker = VideoDriftTracker::new();
        let mut source_clock = SourceClockState::new("video");
        let mut dropped_during_pause: u64 = 0;

        let res = stop_token
            .run_until_cancelled(async {
                while let Some(frame) = video_rx.next().await {
                    let (is_paused, total_pause_duration) = shared_pause.check();

                    if is_paused {
                        dropped_during_pause += 1;
                        continue;
                    }

                    frame_count += 1;

                    let timestamp = frame.timestamp();

                    let is_first_frame = first_tx.is_some();
                    if let Some(first_tx) = first_tx.take() {
                        let _ = first_tx.send(timestamp);
                    }

                    let remap =
                        source_clock.remap(&master_clock, timestamp, frame_duration_ns);
                    if matches!(remap.outcome, SourceClockOutcome::HardReset) {
                        warn!(
                            source = "video",
                            hard_resets = source_clock.hard_reset_count(),
                            "Master clock hard reset for video source (>2s jump)"
                        );
                        anomaly_tracker = TimestampAnomalyTracker::new("video");
                    }

                    if is_first_frame && let Some(gate) = &video_start_gate {
                        gate.publish(remap.master_ns);
                        debug!(
                            video_start_ns = remap.master_ns,
                            "Published video start timestamp to encoder-pair gate"
                        );
                    }

                    // Excise accumulated pause time from the content timeline
                    // before anomaly tracking. Audio already excises pauses
                    // (paused frames are dropped and sample counting carries
                    // on), and wall_clock_elapsed below subtracts pauses too;
                    // leaving the pause in the video timestamps would make a
                    // resume look like a wall-clock-confirmed capture gap and
                    // poison the drift anchor with pause-inflated time.
                    let remapped_ts = Timestamp::Instant(
                        timestamps.instant()
                            + remap.duration().saturating_sub(total_pause_duration),
                    );

                    let wall_clock_elapsed = timestamps
                        .instant()
                        .elapsed()
                        .saturating_sub(total_pause_duration);

                    let raw_duration = match anomaly_tracker.process_timestamp(remapped_ts, timestamps, wall_clock_elapsed) {
                        Ok(d) => d,
                        Err(TimestampAnomalyError::TooManyConsecutiveAnomalies { count }) => {
                            return Err(anyhow!(
                                "Video stream timestamp anomaly: {} consecutive anomalies exceeded threshold",
                                count
                            ));
                        }
                    };

                    if anomaly_tracker.take_resync_flag() {
                        info!(
                            raw_duration_ms = raw_duration.as_millis(),
                            "Timeline resync detected (anomaly collapsed jump); wall-clock anchor covers the gap"
                        );
                    }
                    let duration = drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);
                    timestamp_span.record(duration);

                    if frame_count.is_multiple_of(300) {
                        let drift_ratio = if raw_duration.as_secs_f64() > 0.0 {
                            wall_clock_elapsed.as_secs_f64() / raw_duration.as_secs_f64()
                        } else {
                            1.0
                        };
                        debug!(
                            frame_count,
                            wall_clock_secs = wall_clock_elapsed.as_secs_f64(),
                            camera_secs = raw_duration.as_secs_f64(),
                            corrected_secs = duration.as_secs_f64(),
                            drift_ratio,
                            baseline_offset = drift_tracker.baseline_offset_secs(),
                            total_pause_ms = total_pause_duration.as_millis(),
                            "Video drift correction status"
                        );
                    }

                    if let Err(e) = muxer.lock().await.send_video_frame(frame, duration) {
                        return Err(video_mux_send_error(frame_count, e));
                    }
                }

                info!("mux-video stream ended (rx closed)");
                Ok::<(), anyhow::Error>(())
            })
            .await;

        let was_cancelled = res.is_none();

        if was_cancelled {
            info!("mux-video cancelled, draining remaining frames from channel");
            let drain_start = std::time::Instant::now();
            let drain_timeout = Duration::from_secs(2);
            let drain_deadline = tokio::time::Instant::now() + drain_timeout;
            let max_drain_frames = 500u64;
            let mut drained = 0u64;
            let mut skipped = 0u64;

            let mut hit_limit = false;
            loop {
                if drained >= max_drain_frames {
                    hit_limit = true;
                    break;
                }

                match tokio::time::timeout_at(drain_deadline, video_rx.next()).await {
                    Ok(Some(frame)) => {
                        frame_count += 1;
                        drained += 1;

                        let timestamp = frame.timestamp();

                        let is_first_frame = first_tx.is_some();
                        if let Some(first_tx) = first_tx.take() {
                            let _ = first_tx.send(timestamp);
                        }

                        let remap =
                            source_clock.remap(&master_clock, timestamp, frame_duration_ns);
                        if matches!(remap.outcome, SourceClockOutcome::HardReset) {
                            anomaly_tracker = TimestampAnomalyTracker::new("video");
                        }

                        if is_first_frame && let Some(gate) = &video_start_gate {
                            gate.publish(remap.master_ns);
                            debug!(
                                video_start_ns = remap.master_ns,
                                "Published video start timestamp to encoder-pair gate (drain path)"
                            );
                        }
                        // Excise pauses exactly like the main loop above, so
                        // drained tail frames stay on the same content timeline.
                        let remapped_ts = Timestamp::Instant(
                            timestamps.instant()
                                + remap
                                    .duration()
                                    .saturating_sub(shared_pause.total_pause_duration()),
                        );

                        let wall_clock_elapsed = timestamps
                            .instant()
                            .elapsed()
                            .saturating_sub(shared_pause.total_pause_duration());

                        let raw_duration = match anomaly_tracker.process_timestamp(
                            remapped_ts,
                            timestamps,
                            wall_clock_elapsed,
                        ) {
                            Ok(d) => d,
                            Err(_) => {
                                warn!("Timestamp anomaly during drain, skipping frame");
                                skipped += 1;
                                continue;
                            }
                        };

                        let _ = anomaly_tracker.take_resync_flag();
                        let duration =
                            drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);
                        timestamp_span.record(duration);

                        match muxer.lock().await.send_video_frame(frame, duration) {
                            Ok(()) => {}
                            Err(e) => {
                                warn!("Error processing drained frame: {e}");
                                skipped += 1;
                            }
                        }
                    }
                    Ok(None) => break,
                    Err(_) => {
                        hit_limit = true;
                        warn!(
                            "mux-video drain timed out after {:?}, closing channel",
                            drain_start.elapsed()
                        );
                        video_rx.close();
                        break;
                    }
                }
            }

            if drained > 0 || skipped > 0 || hit_limit {
                info!(
                    "mux-video drain complete: {} frames processed, {} errors (limit hit: {}) in {:?}",
                    drained,
                    skipped,
                    hit_limit,
                    drain_start.elapsed()
                );
            }
        }

        let final_pause_duration = shared_pause.total_pause_duration();

        if dropped_during_pause > 0 {
            debug!(
                dropped_during_pause,
                total_pause_ms = final_pause_duration.as_millis(),
                "Video frames dropped during pause"
            );
        }

        anomaly_tracker.log_stats_if_notable();
        if drift_tracker.capped_frame_count() > 0 {
            debug!(
                capped_frames = drift_tracker.capped_frame_count(),
                "Video frames capped to wall clock + tolerance"
            );
        }
        muxer.lock().await.stop();

        if let Some(Err(e)) = res {
            return Err(e);
        }

        if was_cancelled {
            info!(
                "mux-video finished after cancellation, total {} frames",
                frame_count
            );
        }

        frame_counter.store(frame_count, Ordering::Release);

        Ok(())
    });
}

struct PreparedAudioSources {
    audio_info: AudioInfo,
    audio_rx: mpsc::Receiver<AudioFrame>,
    erased_audio_sources: Vec<ErasedAudioSource>,
    has_wireless_source: bool,
}

impl PreparedAudioSources {
    #[allow(clippy::too_many_arguments)]
    pub fn configure<TMutex: AudioMuxer>(
        mut self,
        setup_ctx: &mut SetupCtx,
        muxer: Arc<Mutex<TMutex>>,
        stop_token: CancellationToken,
        timestamps: Timestamps,
        mut first_tx: Option<oneshot::Sender<Timestamp>>,
        shared_pause: SharedWallClockPause,
        has_video: bool,
        video_start_gate: Option<VideoStartGate>,
        gap_summary_slot: Arc<OnceLock<AudioGapSummary>>,
        audio_anchor: AudioAnchor,
    ) {
        let audio_info = self.audio_info;
        let has_wireless_source = self.has_wireless_source;
        let health_tx = setup_ctx.health_tx().clone();
        let master_clock = setup_ctx.master_clock().clone();

        if audio_anchor == AudioAnchor::PipelineEpoch && video_start_gate.is_some() {
            warn!(
                "PipelineEpoch audio anchor is ignored when a video start gate \
                 aligns audio to the video track"
            );
        }

        setup_ctx.tasks().spawn("mux-audio", {
            let stop_token = stop_token.child_token();
            let muxer = muxer.clone();
            async move {
                let mut timestamp_generator = AudioTimestampGenerator::from_master_clock_with_rate(
                    master_clock.clone(),
                    audio_info.sample_rate,
                );
                let sample_rate = audio_info.sample_rate;
                let mut dropped_during_pause: u64 = 0;
                let mut frame_count: u64 = 0;
                let mut gap_tracker = AudioGapTracker::new(has_wireless_source, timestamps);
                let mut gate_applied = video_start_gate.is_none();

                let mut audio_degraded = false;

                let res = stop_token
                    .run_until_cancelled(async {
                        while let Some(frame) = self.audio_rx.next().await {
                            match process_audio_frame(
                                AudioFrameProcessContext {
                                    audio_info: &audio_info,
                                    sample_rate,
                                    master_clock: &master_clock,
                                    muxer: &muxer,
                                    health_tx: &health_tx,
                                    shared_pause: &shared_pause,
                                    video_start_gate: video_start_gate.as_ref(),
                                    has_video,
                                    origin: FrameProcessOrigin::Live,
                                    observed_at: Instant::now(),
                                    timestamps,
                                    anchor: audio_anchor,
                                },
                                AudioFrameProcessState {
                                    timestamp_generator: &mut timestamp_generator,
                                    gap_tracker: &mut gap_tracker,
                                    gate_applied: &mut gate_applied,
                                    first_tx: &mut first_tx,
                                    frame_count: &mut frame_count,
                                    dropped_during_pause: &mut dropped_during_pause,
                                },
                                frame,
                            )
                            .await
                            {
                                Ok(AudioFrameOutcome::Sent)
                                | Ok(AudioFrameOutcome::DroppedPaused)
                                | Ok(AudioFrameOutcome::DropFrame) => {}
                                Ok(AudioFrameOutcome::AudioDegraded) => {
                                    audio_degraded = true;
                                    break;
                                }
                                Err(e) => return Err(e),
                            }
                        }
                        Ok::<(), anyhow::Error>(())
                    })
                    .await;

                let was_cancelled = res.is_none();
                let cancellation_target_elapsed = if was_cancelled && !audio_degraded {
                    Some(
                        timestamps
                            .instant()
                            .elapsed()
                            .saturating_sub(shared_pause.total_pause_duration()),
                    )
                } else {
                    None
                };

                if was_cancelled && !audio_degraded {
                    let drain_start = std::time::Instant::now();
                    let max_drain_frames = 500u64;
                    let mut drained = 0u64;
                    let mut skipped = 0u64;
                    let mut degraded_during_drain = false;

                    while drained < max_drain_frames {
                        match self.audio_rx.try_next() {
                            Ok(Some(frame)) => match process_audio_frame(
                                AudioFrameProcessContext {
                                    audio_info: &audio_info,
                                    sample_rate,
                                    master_clock: &master_clock,
                                    muxer: &muxer,
                                    health_tx: &health_tx,
                                    shared_pause: &shared_pause,
                                    video_start_gate: video_start_gate.as_ref(),
                                    has_video,
                                    origin: FrameProcessOrigin::Drain,
                                    observed_at: Instant::now(),
                                    timestamps,
                                    anchor: audio_anchor,
                                },
                                AudioFrameProcessState {
                                    timestamp_generator: &mut timestamp_generator,
                                    gap_tracker: &mut gap_tracker,
                                    gate_applied: &mut gate_applied,
                                    first_tx: &mut first_tx,
                                    frame_count: &mut frame_count,
                                    dropped_during_pause: &mut dropped_during_pause,
                                },
                                frame,
                            )
                            .await
                            {
                                Ok(AudioFrameOutcome::Sent) => drained += 1,
                                Ok(AudioFrameOutcome::DroppedPaused)
                                | Ok(AudioFrameOutcome::DropFrame) => {}
                                Ok(AudioFrameOutcome::AudioDegraded) => {
                                    degraded_during_drain = true;
                                    break;
                                }
                                Err(e) => {
                                    warn!(
                                        "mux-audio drain: error processing frame, skipping: {e:#}"
                                    );
                                    skipped += 1;
                                }
                            },
                            Ok(None) | Err(_) => break,
                        }
                    }

                    if drained > 0 || skipped > 0 || degraded_during_drain {
                        info!(
                            drained,
                            skipped,
                            degraded = degraded_during_drain,
                            elapsed_ms = drain_start.elapsed().as_millis() as u64,
                            "mux-audio drain complete"
                        );
                    }

                    if degraded_during_drain {
                        audio_degraded = true;
                    }
                }

                let final_pause_duration = shared_pause.total_pause_duration();

                if let Some(target_elapsed) = cancellation_target_elapsed
                    && !audio_degraded
                {
                    // An epoch-anchored track that never received a frame
                    // (e.g. WASAPI loopback with no sound played the whole
                    // recording) still spans the recording: anchor it now so
                    // the fill below covers the full duration and the track
                    // reports a valid start.
                    if audio_anchor == AudioAnchor::PipelineEpoch && !gap_tracker.started() {
                        let epoch_ts = Timestamp::Instant(timestamps.instant());
                        gap_tracker.mark_started(epoch_ts, timestamps.instant());
                        if let Some(first_tx) = first_tx.take() {
                            let _ = first_tx.send(epoch_ts);
                        }
                        info!("No audio frames arrived; anchoring silent track at epoch");
                    }

                    let audio_elapsed = timestamp_generator.next_timestamp(0);
                    // target_elapsed is epoch-relative; the audio timeline is
                    // track-local (zero = first muxed frame, or the epoch when
                    // head-anchored), so remove the track's start offset
                    // before comparing.
                    let track_target = gap_tracker
                        .track_start_offset()
                        .map(|offset| target_elapsed.saturating_sub(offset))
                        .unwrap_or(target_elapsed);
                    let tail_padding = audio_tail_padding_duration(audio_elapsed, track_target);
                    let start_samples = timestamp_generator.total_samples;
                    let tail_samples = timestamp_generator.advance_by_duration(tail_padding);

                    if tail_samples > 0 {
                        let frame_ts = Timestamp::Instant(timestamps.instant() + audio_elapsed);

                        if let Err(e) = send_silence_frames(
                            &muxer,
                            &audio_info,
                            frame_ts,
                            start_samples,
                            tail_samples,
                        )
                        .await
                        {
                            if has_video {
                                warn!(
                                    padding_ms = tail_padding.as_millis() as u64,
                                    samples = tail_samples,
                                    "Audio muxer rejected tail padding, \
                                     continuing video-only: {e}"
                                );
                                emit_health(
                                    &health_tx,
                                    PipelineHealthEvent::AudioDegradedToVideoOnly {
                                        reason: format!(
                                            "Tail padding rejected after frame {frame_count}: {e}"
                                        ),
                                    },
                                );
                            } else {
                                return Err(anyhow!(
                                    "Audio muxer stopped accepting tail padding \
                                     after frame {frame_count}: {e}"
                                ));
                            }
                        } else {
                            info!(
                                padding_ms = tail_padding.as_millis() as u64,
                                samples = tail_samples,
                                audio_end_ms = audio_elapsed.as_millis() as u64,
                                track_target_ms = track_target.as_millis() as u64,
                                target_ms = target_elapsed.as_millis() as u64,
                                "Padded audio tail with silence"
                            );
                        }
                    }
                }

                if dropped_during_pause > 0 {
                    debug!(
                        dropped_during_pause,
                        total_pause_ms = final_pause_duration.as_millis(),
                        "Audio frames dropped during pause (not counted in samples)"
                    );
                }

                if gap_tracker.silence_insertion_count > 0 || gap_tracker.overlap_event_count > 0 {
                    info!(
                        silence_insertions = gap_tracker.silence_insertion_count,
                        total_silence_ms = gap_tracker.total_silence_inserted.as_millis(),
                        overlap_events = gap_tracker.overlap_event_count,
                        overlap_dropped_frames = gap_tracker.overlap_dropped_frames,
                        total_overlap_trimmed_ms = gap_tracker.total_overlap_trimmed.as_millis(),
                        startup_overlap_trimmed_ms =
                            gap_tracker.startup_overlap_trimmed.as_millis(),
                        "Audio gap tracking summary at finish"
                    );
                }

                if gap_tracker.overlap_event_count > 0 {
                    let _ = gap_summary_slot.set(gap_tracker.gap_summary());
                }

                for source in &mut self.erased_audio_sources {
                    let _ = (source.stop_fn)(source.inner.as_mut()).await;
                }

                if !has_video {
                    muxer.lock().await.stop();
                }

                if let Some(Err(e)) = res {
                    if has_video {
                        error!("Audio stream ended with error (video continues): {e:#}");
                    } else {
                        return Err(e);
                    }
                }

                Ok(())
            }
        });
    }
}

#[derive(Copy, Clone)]
enum FrameProcessOrigin {
    Live,
    Drain,
}

enum AudioFrameOutcome {
    Sent,
    DroppedPaused,
    DropFrame,
    AudioDegraded,
}

struct AudioFrameProcessContext<'a, TMutex: AudioMuxer> {
    audio_info: &'a AudioInfo,
    sample_rate: u32,
    master_clock: &'a Arc<MasterClock>,
    muxer: &'a Arc<Mutex<TMutex>>,
    health_tx: &'a HealthSender,
    shared_pause: &'a SharedWallClockPause,
    video_start_gate: Option<&'a VideoStartGate>,
    has_video: bool,
    origin: FrameProcessOrigin,
    observed_at: Instant,
    timestamps: Timestamps,
    anchor: AudioAnchor,
}

struct AudioFrameProcessState<'a> {
    timestamp_generator: &'a mut AudioTimestampGenerator,
    gap_tracker: &'a mut AudioGapTracker,
    gate_applied: &'a mut bool,
    first_tx: &'a mut Option<oneshot::Sender<Timestamp>>,
    frame_count: &'a mut u64,
    dropped_during_pause: &'a mut u64,
}

async fn process_audio_frame<TMutex: AudioMuxer>(
    ctx: AudioFrameProcessContext<'_, TMutex>,
    state: AudioFrameProcessState<'_>,
    mut frame: AudioFrame,
) -> anyhow::Result<AudioFrameOutcome> {
    let (is_paused, total_pause_duration) = ctx.shared_pause.check();

    if is_paused {
        *state.dropped_during_pause += 1;
        return Ok(AudioFrameOutcome::DroppedPaused);
    }

    if !*state.gate_applied
        && let Some(gate) = ctx.video_start_gate
    {
        match apply_video_start_gate(
            gate,
            &frame,
            ctx.master_clock,
            state.timestamp_generator,
            ctx.sample_rate,
        )
        .await
        {
            VideoStartGateAction::UseFrame(adjusted) => {
                frame = adjusted;
                *state.gate_applied = true;
            }
            VideoStartGateAction::DropFrame => {
                trace!(
                    "First audio frame fully consumed by trim, \
                     awaiting next frame to re-apply gate"
                );
                return Ok(AudioFrameOutcome::DropFrame);
            }
            VideoStartGateAction::Passthrough => {
                *state.gate_applied = true;
            }
        }
    }

    let observed_at = ctx.observed_at;

    // Epoch-anchored tracks (intermittent sources like WASAPI loopback):
    // timeline zero is the pipeline epoch, so the stretch between the epoch
    // and the first captured frame is real recorded silence — synthesize it
    // and report the epoch as the track start. Pause time never reaches the
    // sample timeline, so it is excised from the head like everywhere else.
    if ctx.anchor == AudioAnchor::PipelineEpoch
        && ctx.video_start_gate.is_none()
        && !state.gap_tracker.started()
    {
        let epoch_ts = Timestamp::Instant(ctx.timestamps.instant());
        state
            .gap_tracker
            .mark_started(epoch_ts, ctx.timestamps.instant());

        let head_secs = frame.timestamp.signed_duration_since_secs(ctx.timestamps);
        let head = Duration::from_secs_f64(head_secs.max(0.0))
            .saturating_sub(total_pause_duration)
            // A capture timestamp can't credibly predate more wall time than
            // has actually elapsed since the epoch.
            .min(observed_at.saturating_duration_since(ctx.timestamps.instant()));

        if !head.is_zero() {
            let start_samples = state.timestamp_generator.total_samples;
            let head_samples = state.timestamp_generator.advance_by_duration(head);

            if head_samples > 0 {
                info!(
                    head_ms = head.as_millis() as u64,
                    samples = head_samples,
                    "Anchoring audio track at pipeline epoch; \
                     filling head with silence up to first captured frame"
                );

                if let Err(e) = send_silence_frames(
                    ctx.muxer,
                    ctx.audio_info,
                    epoch_ts,
                    start_samples,
                    head_samples,
                )
                .await
                {
                    if ctx.has_video {
                        warn!(
                            "Audio muxer rejected head silence, \
                             degrading to video-only: {e}"
                        );
                        emit_health(
                            ctx.health_tx,
                            PipelineHealthEvent::AudioDegradedToVideoOnly {
                                reason: format!("Head silence rejected: {e}"),
                            },
                        );
                        return Ok(AudioFrameOutcome::AudioDegraded);
                    }
                    return Err(anyhow!("Audio muxer stopped accepting head silence: {e}"));
                }
            }
        }
    }

    if let Some(first_tx) = state.first_tx.take() {
        let anchor_ts =
            if ctx.anchor == AudioAnchor::PipelineEpoch && ctx.video_start_gate.is_none() {
                Timestamp::Instant(ctx.timestamps.instant())
            } else {
                frame.timestamp
            };
        let _ = first_tx.send(anchor_ts);
    }

    state.gap_tracker.mark_started(frame.timestamp, observed_at);

    let sample_based_before = state.timestamp_generator.next_timestamp(0);

    if let Some(overlap_duration) = state.gap_tracker.detect_overlap(
        frame.timestamp,
        sample_based_before,
        total_pause_duration,
        observed_at,
    ) {
        let trim_samples = duration_to_sample_count(overlap_duration, ctx.sample_rate) as usize;
        let frame_samples = frame.inner.samples();

        if trim_samples >= frame_samples {
            state
                .gap_tracker
                .record_overlap(overlap_duration, true, *state.frame_count);
            debug!(
                frame_count = *state.frame_count,
                overlap_ms = overlap_duration.as_millis() as u64,
                frame_samples,
                trim_samples,
                "Dropping overlapping audio frame"
            );
            return Ok(AudioFrameOutcome::DropFrame);
        }

        if trim_samples > 0 {
            if let Some(trimmed) = trim_audio_frame_front(&frame.inner, trim_samples) {
                state
                    .gap_tracker
                    .record_overlap(overlap_duration, false, *state.frame_count);
                debug!(
                    frame_count = *state.frame_count,
                    overlap_ms = overlap_duration.as_millis() as u64,
                    frame_samples,
                    trim_samples,
                    kept_samples = trimmed.samples(),
                    "Trimmed overlapping audio frame"
                );
                frame = AudioFrame::new(trimmed, frame.timestamp);
            }
        }
    }

    if let Some(gap_duration) = state.gap_tracker.detect_gap(
        frame.timestamp,
        sample_based_before,
        total_pause_duration,
        observed_at,
    ) {
        let start_samples = state.timestamp_generator.total_samples;
        let silence_samples = state.timestamp_generator.advance_by_duration(gap_duration);

        if silence_samples > 0 {
            if gap_duration >= LONG_SILENCE_LOG_THRESHOLD {
                // Long gaps are expected for intermittent sources (loopback
                // system audio while nothing plays); the wall-clock clamp in
                // capture_elapsed already vouched that this much real time
                // passed.
                info!(
                    gap_ms = gap_duration.as_millis(),
                    "Long audio gap; filling with silence"
                );
            }

            state.gap_tracker.record_insertion(gap_duration);

            // For device-backed sources a delivery gap is a real anomaly
            // worth surfacing; for epoch-anchored intermittent sources
            // (loopback system audio) silent stretches are the normal shape
            // of the stream, not a health problem.
            if ctx.anchor == AudioAnchor::FirstFrame {
                emit_health(
                    ctx.health_tx,
                    PipelineHealthEvent::AudioGapDetected {
                        gap_ms: gap_duration.as_millis() as u64,
                    },
                );
            }

            if let Err(e) = send_silence_frames(
                ctx.muxer,
                ctx.audio_info,
                frame.timestamp,
                start_samples,
                silence_samples,
            )
            .await
            {
                if ctx.has_video {
                    warn!(
                        frame_count = *state.frame_count,
                        "Audio muxer rejected silence frame, \
                         degrading to video-only: {e}"
                    );
                    emit_health(
                        ctx.health_tx,
                        PipelineHealthEvent::AudioDegradedToVideoOnly {
                            reason: format!(
                                "Silence frame rejected at frame {}: {e}",
                                *state.frame_count
                            ),
                        },
                    );
                    return Ok(AudioFrameOutcome::AudioDegraded);
                }
                return Err(anyhow!(
                    "Audio muxer stopped accepting frames \
                     at frame {}: {e}",
                    *state.frame_count
                ));
            }
        }
    }

    let frame_samples = frame.inner.samples() as u64;
    *state.frame_count += 1;

    let sample_based_timestamp = state.timestamp_generator.next_timestamp(frame_samples);
    let timestamp = sample_based_timestamp;

    if matches!(ctx.origin, FrameProcessOrigin::Live) && state.frame_count.is_multiple_of(500) {
        debug!(
            frame_count = *state.frame_count,
            sample_based_secs = sample_based_timestamp.as_secs_f64(),
            corrected_secs = timestamp.as_secs_f64(),
            total_samples = state.timestamp_generator.total_samples,
            total_pause_ms = total_pause_duration.as_millis(),
            silence_insertions = state.gap_tracker.silence_insertion_count,
            total_silence_ms = state.gap_tracker.total_silence_inserted.as_millis(),
            "Audio timestamp status"
        );
    }

    if let Err(e) = ctx.muxer.lock().await.send_audio_frame(frame, timestamp) {
        if ctx.has_video {
            warn!(
                frame_count = *state.frame_count,
                "Audio muxer rejected frame, \
                 degrading to video-only: {e}"
            );
            emit_health(
                ctx.health_tx,
                PipelineHealthEvent::AudioDegradedToVideoOnly {
                    reason: format!("Frame rejected at frame {}: {e}", *state.frame_count),
                },
            );
            return Ok(AudioFrameOutcome::AudioDegraded);
        }
        return Err(anyhow!(
            "Audio muxer stopped accepting frames \
             at frame {}: {e}",
            *state.frame_count
        ));
    }

    Ok(AudioFrameOutcome::Sent)
}

async fn setup_audio_sources(
    setup_ctx: &mut SetupCtx,
    mut audio_sources: Vec<AudioSourceSetupFn>,
    stop_token: CancellationToken,
    timestamps: Timestamps,
) -> anyhow::Result<Option<PreparedAudioSources>> {
    if audio_sources.is_empty() {
        return Ok(None);
    }

    let mut erased_audio_sources = vec![];
    let (audio_tx, audio_rx) = mpsc::channel(128);

    let audio_info = if audio_sources.len() == 1 {
        let source = (audio_sources.swap_remove(0))(audio_tx, setup_ctx).await?;
        let info = source.audio_info;
        erased_audio_sources.push(source);
        info
    } else {
        let mut audio_mixer = AudioMixer::builder()
            .with_timestamps(timestamps)
            .with_master_clock(setup_ctx.master_clock().clone())
            .with_health_tx(setup_ctx.health_tx().clone());
        let stop_flag = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = oneshot::channel::<anyhow::Result<()>>();

        for audio_source_setup in audio_sources {
            let (tx, rx) = mpsc::channel(128);
            let source = (audio_source_setup)(tx, setup_ctx).await?;

            audio_mixer.add_source(source.audio_info, rx);
            erased_audio_sources.push(source);
        }

        setup_ctx.tasks().spawn_thread("audio-mixer", {
            let stop_flag = stop_flag.clone();
            move || {
                #[cfg(windows)]
                let _mmcss = cap_mediafoundation_utils::MmcssAudioHandle::register_audio();
                audio_mixer.run(audio_tx, ready_tx, stop_flag);
                Ok(())
            }
        });

        ready_rx
            .await
            .map_err(|_| anyhow::format_err!("Audio mixer crashed"))??;

        setup_ctx.tasks().spawn(
            "audio-mixer-stop",
            stop_token.child_token().cancelled_owned().map(move |_| {
                stop_flag.store(true, atomic::Ordering::Relaxed);
                Ok(())
            }),
        );

        AudioMixer::INFO
    };

    let has_wireless_source = erased_audio_sources
        .iter()
        .any(|s| s.audio_info.is_wireless_transport);

    for source in &mut erased_audio_sources {
        (source.start_fn)(source.inner.as_mut()).await?;
    }

    Ok(Some(PreparedAudioSources {
        audio_info,
        audio_rx,
        erased_audio_sources,
        has_wireless_source,
    }))
}

pub type DoneFut = Shared<BoxFuture<'static, Result<(), PipelineDoneError>>>;

pub struct OutputPipeline {
    path: PathBuf,
    pub first_timestamp_rx: oneshot::Receiver<Timestamp>,
    video_info: Option<VideoInfo>,
    stop_token: Option<DropGuard>,
    done_fut: DoneFut,
    pause_flag: Arc<AtomicBool>,
    cancel_token: CancellationToken,
    video_frame_count: Arc<AtomicU64>,
    video_timestamp_span: Arc<VideoTimestampSpan>,
    health_rx: Option<HealthReceiver>,
    audio_gap_summary: Arc<OnceLock<AudioGapSummary>>,
}

pub struct FinishedOutputPipeline {
    pub path: PathBuf,
    pub first_timestamp: Timestamp,
    pub video_info: Option<VideoInfo>,
    pub video_frame_count: u64,
    /// First and last video timestamps sent to the muxer; the real encoded
    /// media span for VFR content.
    pub video_timestamp_span: Option<(Duration, Duration)>,
    pub audio_gap_summary: Option<AudioGapSummary>,
}

#[derive(Clone, Default)]
pub struct PipelineStopSignal {
    user_stopped: Arc<AtomicBool>,
}

impl PipelineStopSignal {
    pub fn mark_user_stopped(&self) {
        self.user_stopped.store(true, Ordering::Release);
    }

    fn user_stopped(&self) -> bool {
        self.user_stopped.load(Ordering::Acquire)
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Screen capture stopped from macOS sharing controls")]
pub struct PipelineStoppedByUser;

#[derive(Clone, Debug)]
pub struct PipelineDoneError(Arc<anyhow::Error>);

impl std::fmt::Display for PipelineDoneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for PipelineDoneError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.0.as_ref().source()
    }
}

impl PipelineDoneError {
    pub fn is_caused_by<T>(&self) -> bool
    where
        T: std::error::Error + 'static,
    {
        self.0
            .chain()
            .any(|cause| cause.downcast_ref::<T>().is_some())
    }
}

impl OutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(mut self) -> anyhow::Result<FinishedOutputPipeline> {
        drop(self.stop_token.take());

        const PIPELINE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
        match tokio::time::timeout(PIPELINE_STOP_TIMEOUT, self.done_fut.clone()).await {
            Ok(Err(error)) if error.is_caused_by::<PipelineStoppedByUser>() => {}
            Ok(res) => res?,
            Err(_) => {
                return Err(anyhow!(
                    "Pipeline stop timed out after {}s — tasks may still be running",
                    PIPELINE_STOP_TIMEOUT.as_secs()
                ));
            }
        }

        let first_timestamp = match tokio::time::timeout(
            Duration::from_secs(1),
            self.first_timestamp_rx,
        )
        .await
        {
            Ok(Ok(ts)) => ts,
            Ok(Err(_)) => {
                warn!(
                    "first_timestamp channel was dropped without sending a value, defaulting to now"
                );
                Timestamp::Instant(Instant::now())
            }
            Err(_) => {
                warn!("first_timestamp receive timed out after 1s, defaulting to now");
                Timestamp::Instant(Instant::now())
            }
        };

        Ok(FinishedOutputPipeline {
            path: self.path,
            first_timestamp,
            video_info: self.video_info,
            video_frame_count: self.video_frame_count.load(Ordering::Acquire),
            video_timestamp_span: self.video_timestamp_span.get(),
            audio_gap_summary: self.audio_gap_summary.get().copied(),
        })
    }

    pub fn pause(&self) {
        self.pause_flag.store(true, atomic::Ordering::Release);
    }

    pub fn resume(&self) {
        self.pause_flag.store(false, atomic::Ordering::Release);
    }

    pub fn video_info(&self) -> Option<VideoInfo> {
        self.video_info
    }

    pub fn done_fut(&self) -> DoneFut {
        self.done_fut.clone()
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel_token.clone()
    }

    pub fn cancel(&self) {
        self.cancel_token.cancel();
    }

    pub fn take_health_rx(&mut self) -> Option<HealthReceiver> {
        self.health_rx.take()
    }
}

pub struct ChannelVideoSourceConfig<TVideoFrame> {
    info: VideoInfo,
    rx: flume::Receiver<TVideoFrame>,
}

impl<TVideoFrame> ChannelVideoSourceConfig<TVideoFrame> {
    pub fn new(info: VideoInfo, rx: flume::Receiver<TVideoFrame>) -> Self {
        Self { info, rx }
    }
}

pub struct ChannelVideoSource<TVideoFrame>(VideoInfo, PhantomData<TVideoFrame>);

impl<TVideoFrame: VideoFrame> VideoSource for ChannelVideoSource<TVideoFrame> {
    type Config = ChannelVideoSourceConfig<TVideoFrame>;
    type Frame = TVideoFrame;

    async fn setup(
        config: Self::Config,
        mut video_tx: mpsc::Sender<Self::Frame>,
        _: &mut SetupCtx,
    ) -> anyhow::Result<Self>
    where
        Self: Sized,
    {
        tokio::spawn(async move {
            while let Ok(frame) = config.rx.recv_async().await {
                let _ = video_tx.send(frame).await;
            }
        });

        Ok(Self(config.info, PhantomData))
    }

    fn video_info(&self) -> VideoInfo {
        self.0
    }
}

pub struct ChannelAudioSource {
    info: AudioInfo,
}

pub struct ChannelAudioSourceConfig {
    info: AudioInfo,
    rx: mpsc::Receiver<AudioFrame>,
}

impl ChannelAudioSourceConfig {
    pub fn new(info: AudioInfo, rx: mpsc::Receiver<AudioFrame>) -> Self {
        Self { info, rx }
    }
}

impl AudioSource for ChannelAudioSource {
    type Config = ChannelAudioSourceConfig;

    fn setup(
        mut config: Self::Config,
        mut tx: mpsc::Sender<AudioFrame>,
        _: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + 'static {
        tokio::spawn(async move {
            while let Some(frame) = config.rx.next().await {
                let _ = tx.send(frame).await;
            }
        });

        async move { Ok(ChannelAudioSource { info: config.info }) }
    }

    fn audio_info(&self) -> AudioInfo {
        self.info
    }
}

pub struct AudioFrame {
    pub inner: ::ffmpeg::frame::Audio,
    pub timestamp: Timestamp,
}

impl AudioFrame {
    pub fn new(inner: ::ffmpeg::frame::Audio, timestamp: Timestamp) -> Self {
        Self { inner, timestamp }
    }
}

impl Deref for AudioFrame {
    type Target = ffmpeg::frame::Audio;

    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

pub trait VideoSource: Send + 'static {
    type Config;
    type Frame: VideoFrame;

    fn setup(
        config: Self::Config,
        video_tx: mpsc::Sender<Self::Frame>,
        ctx: &mut SetupCtx,
    ) -> impl std::future::Future<Output = anyhow::Result<Self>> + Send
    where
        Self: Sized;

    fn video_info(&self) -> VideoInfo;

    fn start(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        future::ready(Ok(())).boxed()
    }

    fn stop(&mut self) -> BoxFuture<'_, anyhow::Result<()>> {
        future::ready(Ok(())).boxed()
    }
}

struct ErasedAudioSource {
    inner: Box<dyn Any + Send>,
    audio_info: AudioInfo,
    start_fn: fn(&mut dyn Any) -> BoxFuture<'_, anyhow::Result<()>>,
    stop_fn: fn(&mut dyn Any) -> BoxFuture<'_, anyhow::Result<()>>,
}

impl ErasedAudioSource {
    pub fn new<TAudio: AudioSource>(source: TAudio) -> Self {
        Self {
            audio_info: source.audio_info(),
            start_fn: |raw| {
                raw.downcast_mut::<TAudio>()
                    .expect("Wrong type")
                    .start()
                    .boxed()
            },
            stop_fn: |raw| {
                raw.downcast_mut::<TAudio>()
                    .expect("Wrong type")
                    .stop()
                    .boxed()
            },
            inner: Box::new(source),
        }
    }
}

pub trait AudioSource: Send + 'static {
    type Config: Send;

    fn setup(
        config: Self::Config,
        tx: mpsc::Sender<AudioFrame>,
        ctx: &mut SetupCtx,
    ) -> impl Future<Output = anyhow::Result<Self>> + Send + 'static
    where
        Self: Sized;

    fn audio_info(&self) -> AudioInfo;

    fn start(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        async { Ok(()) }
    }

    fn stop(&mut self) -> impl Future<Output = anyhow::Result<()>> + Send {
        async { Ok(()) }
    }
}

pub trait VideoFrame: Send + 'static {
    fn timestamp(&self) -> Timestamp;
}

pub trait Muxer: Send + 'static {
    type Config;

    fn setup(
        config: Self::Config,
        output_path: PathBuf,
        video_config: Option<VideoInfo>,
        audio_config: Option<AudioInfo>,
        pause_flag: Arc<AtomicBool>,
        tasks: &mut TaskPool,
    ) -> impl Future<Output = anyhow::Result<Self>> + Send
    where
        Self: Sized;

    fn stop(&mut self) {}

    fn finish(&mut self, timestamp: Duration) -> anyhow::Result<anyhow::Result<()>>;

    fn set_health_sender(&mut self, _tx: HealthSender) {}
}

pub trait AudioMuxer: Muxer {
    fn send_audio_frame(&mut self, frame: AudioFrame, timestamp: Duration) -> anyhow::Result<()>;
}

pub trait VideoMuxer: Muxer {
    type VideoFrame;

    fn send_video_frame(
        &mut self,
        frame: Self::VideoFrame,
        timestamp: Duration,
    ) -> anyhow::Result<()>;
}

#[cfg(test)]
mod tests {
    use super::*;

    mod audio_timestamp_generator {
        use super::*;

        #[test]
        fn first_timestamp_is_zero() {
            let mut generator = AudioTimestampGenerator::new(48000);
            let result = generator.next_timestamp(960);
            assert_eq!(
                result,
                Duration::ZERO,
                "First frame should have 0s timestamp"
            );
        }

        #[test]
        fn tracks_samples_correctly() {
            let mut generator = AudioTimestampGenerator::new(48000);
            generator.next_timestamp(960);
            assert_eq!(
                generator.total_samples, 960,
                "Should track samples after first call"
            );

            generator.next_timestamp(960);
            assert_eq!(generator.total_samples, 1920, "Should accumulate samples");
        }

        #[test]
        fn calculates_timestamp_from_samples() {
            let sample_rate = 48000;
            let mut generator = AudioTimestampGenerator::new(sample_rate);
            let samples_per_frame = 960;

            generator.next_timestamp(samples_per_frame);
            let second = generator.next_timestamp(samples_per_frame);

            let expected_secs = samples_per_frame as f64 / sample_rate as f64;
            assert!(
                (second.as_secs_f64() - expected_secs).abs() < 0.0001,
                "Expected {expected_secs:.6}s, got {:.6}s",
                second.as_secs_f64()
            );
        }

        #[test]
        fn continuous_timestamps_no_gaps() {
            let sample_rate = 48000;
            let mut generator = AudioTimestampGenerator::new(sample_rate);
            let samples_per_frame = 960;

            let mut last_timestamp = Duration::ZERO;
            for i in 0..100 {
                let result = generator.next_timestamp(samples_per_frame);
                if i > 0 {
                    let gap = result.as_secs_f64() - last_timestamp.as_secs_f64();
                    let expected_gap = samples_per_frame as f64 / sample_rate as f64;
                    assert!(
                        (gap - expected_gap).abs() < 0.0001,
                        "Gap between frames should be {expected_gap:.6}s, got {gap:.6}s at frame {i}"
                    );
                }
                last_timestamp = result;
            }
        }

        #[test]
        fn handles_variable_frame_sizes() {
            let sample_rate = 48000;
            let mut generator = AudioTimestampGenerator::new(sample_rate);

            generator.next_timestamp(480);
            let second = generator.next_timestamp(960);
            let third = generator.next_timestamp(1920);

            let expected_second = 480.0 / sample_rate as f64;
            let expected_third = (480.0 + 960.0) / sample_rate as f64;

            assert!(
                (second.as_secs_f64() - expected_second).abs() < 0.0001,
                "Second timestamp: expected {expected_second:.6}s, got {:.6}s",
                second.as_secs_f64()
            );
            assert!(
                (third.as_secs_f64() - expected_third).abs() < 0.0001,
                "Third timestamp: expected {expected_third:.6}s, got {:.6}s",
                third.as_secs_f64()
            );
        }

        #[test]
        fn simulates_long_recording() {
            let sample_rate = 48000;
            let mut generator = AudioTimestampGenerator::new(sample_rate);
            let samples_per_frame = 960u64;
            let frames_per_second = sample_rate as u64 / samples_per_frame;
            let duration_secs = 3600u64;
            let total_frames = frames_per_second * duration_secs;

            let mut last_timestamp = Duration::ZERO;
            for _ in 0..total_frames {
                last_timestamp = generator.next_timestamp(samples_per_frame);
            }

            let expected_secs =
                ((total_frames - 1) * samples_per_frame) as f64 / sample_rate as f64;
            assert!(
                (last_timestamp.as_secs_f64() - expected_secs).abs() < 0.001,
                "After 1 hour: expected {expected_secs:.3}s, got {:.3}s",
                last_timestamp.as_secs_f64()
            );
            assert_eq!(
                generator.total_samples,
                total_frames * samples_per_frame,
                "Total samples should equal total_frames * samples_per_frame"
            );
        }
    }

    mod audio_gap_tracker {
        use super::*;

        #[test]
        fn clamps_spurious_timestamp_jump_to_wall_clock_elapsed() {
            let timestamps = Timestamps::now();
            let first_ts = Timestamp::Instant(timestamps.instant());
            let first_wall_clock = Instant::now();
            let mut tracker = AudioGapTracker::new(false, timestamps);

            tracker.mark_started(first_ts, first_wall_clock);

            let gap = tracker
                .detect_gap(
                    Timestamp::Instant(timestamps.instant() + Duration::from_secs(2)),
                    Duration::from_millis(40),
                    Duration::ZERO,
                    first_wall_clock + Duration::from_millis(140),
                )
                .expect("wall-clock-bounded drift should still exceed wired gap threshold");

            assert!(
                gap < Duration::from_millis(250),
                "spurious 2s device timestamp jump should not insert a full capped gap"
            );
            assert!(gap >= Duration::from_millis(190));
        }

        #[test]
        fn wall_clock_confirmed_stall_inserts_full_gap() {
            let timestamps = Timestamps::now();
            let first_ts = Timestamp::Instant(timestamps.instant());
            let first_wall_clock = Instant::now();
            let mut tracker = AudioGapTracker::new(false, timestamps);

            tracker.mark_started(first_ts, first_wall_clock);

            let gap = tracker
                .detect_gap(
                    Timestamp::Instant(timestamps.instant() + Duration::from_millis(1500)),
                    Duration::from_millis(40),
                    Duration::ZERO,
                    first_wall_clock + Duration::from_millis(1500),
                )
                .expect("wall-clock-confirmed stall should insert silence");

            // The full wall-clock-validated gap is inserted; truncating it
            // would place post-gap audio too early.
            assert_eq!(gap, Duration::from_millis(1460));
        }

        #[test]
        fn long_dead_zone_inserts_full_gap_in_one_detection() {
            // WASAPI loopback delivers nothing while the system is silent; a
            // frame arriving after a long dead zone must account for the
            // whole stretch at once so its content lands at capture time.
            let timestamps = Timestamps::now();
            let first_ts = Timestamp::Instant(timestamps.instant());
            let first_wall_clock = Instant::now();
            let mut tracker = AudioGapTracker::new(false, timestamps);

            tracker.mark_started(first_ts, first_wall_clock);

            let gap = tracker
                .detect_gap(
                    Timestamp::Instant(timestamps.instant() + Duration::from_secs(30)),
                    Duration::from_secs(2),
                    Duration::ZERO,
                    first_wall_clock + Duration::from_secs(30),
                )
                .expect("dead zone should insert silence");

            assert_eq!(gap, Duration::from_secs(28));
        }

        #[test]
        fn gap_summary_counts_only_early_whole_frame_drops_as_startup() {
            let mut tracker = AudioGapTracker::new(false, Timestamps::now());

            tracker.record_overlap(Duration::from_millis(35), true, 0);
            tracker.record_overlap(Duration::from_millis(35), true, 1);
            tracker.record_overlap(Duration::from_millis(35), true, 2);
            tracker.record_overlap(
                Duration::from_millis(35),
                true,
                STARTUP_OVERLAP_DROP_FRAME_COUNT,
            );
            tracker.record_overlap(Duration::from_millis(35), true, 50);
            tracker.record_overlap(Duration::from_millis(10), false, 1);

            let summary = tracker.gap_summary();
            assert_eq!(summary.startup_overlap_drops, 3);
            assert_eq!(summary.startup_overlap_trimmed_ms, 35 * 3 + 10);
            assert_eq!(summary.overlap_dropped_frames, 5);
            assert_eq!(summary.total_overlap_trimmed_ms, 35 * 5 + 10);
        }
    }

    mod audio_tail_padding {
        use super::*;

        #[test]
        fn no_padding_when_audio_reaches_target() {
            assert_eq!(
                audio_tail_padding_duration(Duration::from_millis(500), Duration::from_millis(500)),
                Duration::ZERO
            );
            assert_eq!(
                audio_tail_padding_duration(Duration::from_millis(600), Duration::from_millis(500)),
                Duration::ZERO
            );
        }

        #[test]
        fn pads_short_tail_gap() {
            assert_eq!(
                audio_tail_padding_duration(
                    Duration::from_millis(20_621),
                    Duration::from_millis(20_758),
                ),
                Duration::from_millis(137)
            );
        }

        #[test]
        fn fills_long_tail_gap_completely() {
            // A track whose source stopped delivering long before the stop
            // point is padded to the full track-relative target so it spans
            // the recording (the old 300ms cap left such tracks short).
            assert_eq!(
                audio_tail_padding_duration(Duration::from_millis(100), Duration::from_secs(2)),
                Duration::from_millis(1900)
            );
        }
    }

    mod video_drift_tracker {
        use super::*;

        fn dur(secs: f64) -> Duration {
            Duration::from_secs_f64(secs)
        }

        #[test]
        fn no_correction_during_warmup() {
            let mut tracker = VideoDriftTracker::new();
            let camera_duration = dur(1.5);
            let wall_clock = dur(1.5);
            let result = tracker.calculate_timestamp(camera_duration, wall_clock);
            assert_eq!(
                result, camera_duration,
                "During warmup: should return unmodified camera duration"
            );
            assert!(
                tracker.baseline_offset_secs().is_none(),
                "Baseline should not be set during warmup"
            );
        }

        #[test]
        fn captures_baseline_after_warmup() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;
            let wall_clock = dur(2.0);
            let camera_duration = dur(2.0 + buffer_delay);

            tracker.calculate_timestamp(camera_duration, wall_clock);

            assert!(tracker.baseline_offset_secs().is_some());
            let baseline = tracker.baseline_offset_secs().unwrap();
            assert!(
                (baseline - buffer_delay).abs() < 0.001,
                "Baseline should be ~{buffer_delay:.3}s, got {baseline:.3}s"
            );
        }

        #[test]
        fn keeps_source_content_clock_after_anchor() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;

            let wall_clock_1 = dur(2.0);
            let camera_1 = dur(2.0 + buffer_delay);
            tracker.calculate_timestamp(camera_1, wall_clock_1);

            let wall_clock_2 = dur(10.0);
            let camera_2 = dur(10.0 + buffer_delay);
            let result = tracker.calculate_timestamp(camera_2, wall_clock_2);

            // Output stays continuous with the source content clock (anchored at
            // the warmup boundary) instead of rebasing onto the wall clock, so the
            // constant startup offset is preserved rather than injected as a step.
            assert!(
                (result.as_secs_f64() - camera_2.as_secs_f64()).abs() < 0.01,
                "expected ~{:.3}s (source content time), got {:.3}s",
                camera_2.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn corrects_drift_after_baseline() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;
            let drift_factor = 1.005;

            let wall_clock_1 = dur(2.0);
            let camera_1 = dur(2.0 * drift_factor + buffer_delay);
            tracker.calculate_timestamp(camera_1, wall_clock_1);

            let wall_clock_2 = dur(60.0);
            let camera_2 = dur(60.0 * drift_factor + buffer_delay);
            let result = tracker.calculate_timestamp(camera_2, wall_clock_2);

            let expected = wall_clock_2;
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.5,
                "With drift and baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
                result.as_secs_f64()
            );
        }

        #[test]
        fn bounds_runaway_source_to_wall_clock() {
            let mut tracker = VideoDriftTracker::new();

            tracker.calculate_timestamp(dur(2.0), dur(2.0));

            // Source content time races far ahead of real time; the output must
            // stay pinned to the wall clock, never follow the runaway source.
            let camera = dur(100.0);
            let wall_clock = dur(80.0);
            let result = tracker.calculate_timestamp(camera, wall_clock);
            let max_allowed = 80.0 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
            assert!(
                result.as_secs_f64() <= max_allowed + 0.001,
                "Expected output bounded to ~{:.3}s, got {:.3}s",
                max_allowed,
                result.as_secs_f64()
            );
            assert!(
                (result.as_secs_f64() - 80.0).abs() < 0.2,
                "Expected output to track wall clock 80.0s, got {:.3}s",
                result.as_secs_f64()
            );
        }

        #[test]
        fn clamps_output_to_wall_clock_bound() {
            let mut tracker = VideoDriftTracker::new();

            // Anchor with the source clock already ahead of the wall clock so a
            // later frame's anchored time would exceed the wall-clock bound.
            tracker.calculate_timestamp(dur(2.5), dur(2.0));

            let result = tracker.calculate_timestamp(dur(3.0), dur(2.2));
            let max_allowed = 2.2 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
            assert!(
                result.as_secs_f64() <= max_allowed + 0.001,
                "Expected clamp to ~{:.3}s, got {:.3}s",
                max_allowed,
                result.as_secs_f64()
            );
            assert!(
                tracker.capped_frame_count() > 0,
                "Should have capped at least one frame"
            );
        }

        /// Deterministic pseudo-random stream for jitter/fps sampling.
        struct ChainRng(u64);

        impl ChainRng {
            fn next_f64(&mut self) -> f64 {
                self.0 = self
                    .0
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (self.0 >> 11) as f64 / (1u64 << 53) as f64
            }
        }

        /// Runs a synthetic source delivering at `actual_fps` (with optional
        /// bounded timestamp jitter) through the full video timestamp chain —
        /// SourceClockState remap, anomaly tracking, drift correction — as
        /// configured for `nominal_fps`, and asserts the mux timestamps stay
        /// monotonic and track the wall clock. This is what keeps video in
        /// sync with the sample-counted audio leg regardless of what rate a
        /// device actually delivers.
        fn assert_chain_tracks_wall_clock(
            actual_fps: f64,
            nominal_fps: u32,
            jitter_frac: f64,
            seed: u64,
            span_secs: f64,
        ) {
            let timestamps = Timestamps::now();
            let master_clock = MasterClock::new(timestamps, 48_000);
            let mut source_clock = SourceClockState::new("video");
            let mut anomaly_tracker = TimestampAnomalyTracker::new("video");
            let mut drift_tracker = VideoDriftTracker::new();
            let mut rng = ChainRng(seed);

            let combo = format!(
                "actual={actual_fps}fps nominal={nominal_fps}fps jitter={jitter_frac} seed={seed}"
            );

            let nominal_frame_duration_ns = 1_000_000_000u64 / u64::from(nominal_fps.max(1));
            let real_delta_secs = 1.0 / actual_fps;

            let start = timestamps.instant();
            let frames = (span_secs * actual_fps) as u32;
            let mut last_duration = Duration::ZERO;
            let mut last_elapsed = Duration::ZERO;

            for i in 0..frames {
                let jitter_secs = (rng.next_f64() * 2.0 - 1.0) * jitter_frac * real_delta_secs;
                let elapsed =
                    Duration::from_secs_f64((i as f64 * real_delta_secs + jitter_secs).max(0.0));
                last_elapsed = elapsed;
                let frame_ts = Timestamp::Instant(start + elapsed);

                let remap = source_clock.remap(&master_clock, frame_ts, nominal_frame_duration_ns);
                let remapped_ts = Timestamp::Instant(timestamps.instant() + remap.duration());

                let raw_duration = anomaly_tracker
                    .process_timestamp(remapped_ts, timestamps, elapsed)
                    .unwrap_or_else(|e| {
                        panic!("[{combo}] anomaly error at frame {i}: {e:?}");
                    });
                let duration = drift_tracker.calculate_timestamp(raw_duration, elapsed);

                assert!(
                    duration >= last_duration,
                    "[{combo}] frame {i}: mux timestamp went backwards \
                     ({last_duration:?} -> {duration:?})"
                );
                last_duration = duration;
            }

            let error = last_duration.as_secs_f64() - last_elapsed.as_secs_f64();
            assert!(
                error.abs() < 0.2,
                "[{combo}] final mux timestamp {last_duration:?} should track the wall clock \
                 {last_elapsed:?} (off by {error:.3}s; re-timing to the nominal rate would be \
                 off by {:.1}s)",
                last_elapsed.as_secs_f64() * (nominal_fps as f64 / actual_fps - 1.0)
            );
        }

        /// Regression: a camera free-running at 60fps while the pipeline is
        /// configured for 30fps (AVFoundation format default vs the selected
        /// frame-rate range) must still produce wall-clock durations. The
        /// smoothing ladder previously re-timed such sources to the nominal
        /// rate in a non-monotonic sawtooth, which the encoder then locked
        /// into nominal CFR — recordings came out exactly 2x too long with
        /// the video at 0.5x speed.
        #[test]
        fn fps_mismatch_chain_keeps_wall_clock_durations() {
            // ~6.8s at 60fps into a 30fps config: the shape of the original
            // report (410 frames).
            assert_chain_tracks_wall_clock(60.0, 30, 0.0, 1, 6.83);
        }

        /// Whatever a device actually delivers — slow trickles, standard
        /// rates, or a 1000fps camera — the video timeline must track the
        /// wall clock so it stays in sync with audio.
        #[test]
        fn chain_tracks_wall_clock_across_fps_matrix() {
            for nominal_fps in [24u32, 30, 60] {
                for actual_fps in [
                    10.0, 15.0, 24.0, 25.0, 29.97, 30.0, 48.0, 60.0, 90.0, 120.0, 240.0, 500.0,
                    1000.0,
                ] {
                    assert_chain_tracks_wall_clock(actual_fps, nominal_fps, 0.0, 2, 5.0);
                }
            }
        }

        /// Randomized (seeded, deterministic) delivery rates with timestamp
        /// jitter: real capture cadences are never exact.
        #[test]
        fn chain_tracks_wall_clock_with_random_fps_and_jitter() {
            let mut rng = ChainRng(0xCA9_5EED);
            for round in 0..20 {
                let actual_fps = 5.0 + rng.next_f64() * 995.0;
                let nominal_fps = [24u32, 30, 60][(rng.next_f64() * 3.0) as usize % 3];
                assert_chain_tracks_wall_clock(actual_fps, nominal_fps, 0.3, 1000 + round, 4.0);
            }
        }

        #[test]
        fn simulates_real_world_camera_scenario() {
            let mut tracker = VideoDriftTracker::new();
            let initial_offset = 0.03;
            let drift_rate = 0.003;

            let mut camera_time = initial_offset;
            let mut wall_time = 0.0;
            let step = 0.5;

            while wall_time < 60.0 {
                wall_time += step;
                camera_time += step * (1.0 + drift_rate);

                let result = tracker.calculate_timestamp(dur(camera_time), dur(wall_time));

                if wall_time >= 2.0 {
                    let error = (result.as_secs_f64() - wall_time).abs();
                    assert!(
                        error < 0.5,
                        "At wall_time={:.1}s: corrected {:.3}s should be close to wall clock",
                        wall_time,
                        result.as_secs_f64()
                    );
                }
            }

            let final_result = tracker.calculate_timestamp(dur(camera_time), dur(wall_time));
            assert!(
                (final_result.as_secs_f64() - wall_time).abs() < 1.0,
                "Final timestamp {:.3}s should be close to wall clock {:.3}s",
                final_result.as_secs_f64(),
                wall_time
            );
        }

        #[test]
        fn preserves_baseline_across_multiple_calls() {
            let mut tracker = VideoDriftTracker::new();

            tracker.calculate_timestamp(dur(2.1), dur(2.0));
            let first_baseline = tracker.baseline_offset_secs();

            tracker.calculate_timestamp(dur(10.1), dur(10.0));

            assert_eq!(
                first_baseline,
                tracker.baseline_offset_secs(),
                "Baseline should not change after initial capture"
            );
        }

        #[test]
        fn caps_to_wall_clock_during_warmup() {
            let mut tracker = VideoDriftTracker::new();
            let wall_clock = dur(1.0);
            let camera_duration = dur(1.5);
            let result = tracker.calculate_timestamp(camera_duration, wall_clock);
            let max_allowed = 1.0 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
            assert!(
                result.as_secs_f64() <= max_allowed + 0.001,
                "During warmup: expected ~{:.3}s (capped), got {:.3}s",
                max_allowed,
                result.as_secs_f64()
            );
            assert_eq!(
                tracker.capped_frame_count(),
                1,
                "Should have capped one frame"
            );
        }

        #[test]
        fn tracks_wall_clock_when_source_runs_ahead_after_warmup() {
            let mut tracker = VideoDriftTracker::new();
            tracker.calculate_timestamp(dur(2.0), dur(2.0));

            // Source content time is ahead of the wall clock; anchored output
            // tracks the wall clock rather than the runaway source.
            let wall_clock = dur(5.0);
            let camera_duration = dur(5.5);
            let result = tracker.calculate_timestamp(camera_duration, wall_clock);
            assert!(
                (result.as_secs_f64() - 5.0).abs() < 0.001,
                "After warmup: expected output to track wall clock 5.0s, got {:.3}s",
                result.as_secs_f64()
            );
        }
    }

    // End-to-end A/V sync gate: the software equivalent of a beep+flash
    // clapperboard. It drives the real video timestamp logic (`VideoDriftTracker`)
    // and the real audio timestamp logic (`AudioTimestampGenerator`) over one
    // shared capture timeline and asserts that a flash and its co-timed beep
    // resolve to the same output PTS — the property that guarantees lip-sync.
    //
    // It reproduces the two historically dangerous conditions:
    //   1. a capture startup latency, where the source content clock lags the
    //      pipeline wall clock (this is what previously injected a ~0.6s step at
    //      the 2s warmup boundary and pushed video behind audio), and
    //   2. a mid-recording static-screen gap that the anomaly tracker collapses.
    // A regression in either leg surfaces here as a non-zero offset, exactly as
    // it would on a real beep/flash recording analysed by `av-sync-check`.
    mod av_sync_gate {
        use super::*;

        const FPS: u32 = 30;
        const SAMPLE_RATE: u32 = 48_000;
        // Lip-sync is imperceptible far below this; the bug we guard against was
        // ~600ms, so a 5ms gate keeps enormous margin while staying strict.
        const TOLERANCE_SECS: f64 = 0.005;

        fn frame_dt() -> f64 {
            1.0 / FPS as f64
        }

        // Output PTS the audio leg assigns to a beep captured `content_secs` after
        // the first audio sample, driven through the real generator.
        fn audio_beep_pts_secs(content_secs: f64) -> f64 {
            let mut generator = AudioTimestampGenerator::new(SAMPLE_RATE);
            let samples = (content_secs * SAMPLE_RATE as f64).round() as u64;
            if samples > 0 {
                generator.next_timestamp(samples);
            }
            generator.next_timestamp(0).as_secs_f64()
        }

        // Drives the real video timestamp logic over a capture timeline that
        // begins `startup_secs` after the pipeline clock, optionally with a
        // static-screen gap of `gap_len_secs` starting at real time `gap_at_secs`.
        // Returns (real_capture_secs, output_pts_secs) for every emitted frame.
        fn simulate_video(
            startup_secs: f64,
            gap: Option<(f64, f64)>,
            total_real_secs: f64,
        ) -> Vec<(f64, f64)> {
            let dt = frame_dt();
            let mut drift = VideoDriftTracker::new();
            let (gap_at_secs, gap_len_secs) = gap.unwrap_or((f64::INFINITY, 0.0));
            let mut frames = Vec::new();

            let mut k = 0u64;
            loop {
                let real = startup_secs + k as f64 * dt;
                if real > total_real_secs + 1e-9 {
                    break;
                }
                k += 1;

                // No frames are delivered while the screen is static.
                if real > gap_at_secs && real <= gap_at_secs + gap_len_secs {
                    continue;
                }

                // The wall clock advances in real time (including across the gap).
                let wall = real;
                // The anomaly tracker collapses a static-screen gap, so the raw
                // source content time skips it.
                let gap_removed = if real > gap_at_secs + gap_len_secs {
                    gap_len_secs
                } else {
                    0.0
                };
                let raw = (real - startup_secs - gap_removed).max(0.0);

                let pts = drift
                    .calculate_timestamp(
                        Duration::from_secs_f64(raw),
                        Duration::from_secs_f64(wall),
                    )
                    .as_secs_f64();
                frames.push((real, pts));
            }

            frames
        }

        fn video_pts_at_real(frames: &[(f64, f64)], real: f64) -> f64 {
            frames
                .iter()
                .min_by(|a, b| {
                    (a.0 - real)
                        .abs()
                        .partial_cmp(&(b.0 - real).abs())
                        .expect("finite frame times")
                })
                .map(|(_, pts)| *pts)
                .expect("at least one frame emitted")
        }

        // For a flash captured at real time `real`, its co-timed beep is at audio
        // content time `real - startup` (audio is zeroed at the first sample, which
        // arrives at the same instant as the first video frame). Asserts the video
        // output PTS matches the beep PTS within tolerance.
        fn assert_flash_beep_aligned(
            frames: &[(f64, f64)],
            startup_secs: f64,
            real_markers: &[f64],
        ) -> f64 {
            let mut max_off = 0.0_f64;
            for &real in real_markers {
                let video = video_pts_at_real(frames, real);
                let beep = audio_beep_pts_secs(real - startup_secs);
                let off = (video - beep).abs();
                max_off = max_off.max(off);
                assert!(
                    off < TOLERANCE_SECS,
                    "A/V offset {off:.5}s at real {real:.3}s (video_pts={video:.5} beep_pts={beep:.5})"
                );
            }
            max_off
        }

        #[test]
        fn flash_and_beep_align_with_startup_latency() {
            let startup = 0.5;
            let frames = simulate_video(startup, None, 6.0);

            // Markers on exact frame boundaries (1s..5s of content) so the
            // measurement is pure A/V offset, free of frame quantisation. These
            // straddle the 2s warmup boundary where the old bug appeared.
            let markers: Vec<f64> = (1..=5).map(|n| startup + n as f64).collect();
            let max_off = assert_flash_beep_aligned(&frames, startup, &markers);
            assert!(max_off < TOLERANCE_SECS, "max A/V offset {max_off:.5}s");
        }

        #[test]
        fn flash_and_beep_align_across_static_screen_gap() {
            let startup = 0.5;
            let gap_at = startup + 4.0;
            let gap_len = 2.0;
            let frames = simulate_video(startup, Some((gap_at, gap_len)), 10.0);

            // Markers before the gap and after it resumes, all on frame boundaries.
            let markers = [
                startup + 1.0,
                startup + 3.0,
                gap_at + gap_len + 1.0,
                gap_at + gap_len + 2.0,
            ];
            assert_flash_beep_aligned(&frames, startup, &markers);
        }

        #[test]
        fn flash_and_beep_stay_aligned_over_long_recording() {
            let startup = 0.5;
            let frames = simulate_video(startup, None, 61.0);

            let markers: Vec<f64> = (1..=60).map(|n| startup + n as f64).collect();
            let max_off = assert_flash_beep_aligned(&frames, startup, &markers);
            assert!(
                max_off < TOLERANCE_SECS,
                "A/V offset must not accumulate over a minute, got {max_off:.5}s"
            );
        }

        // Proves the gate is actually sensitive: a timeline that emits the old
        // wall-clock-rebased PTS (video pts == wall clock, ignoring that audio is
        // zeroed at the first sample) must be flagged as desynced.
        #[test]
        fn gate_detects_wall_clock_rebase_desync() {
            let startup = 0.5;
            let buggy_frames: Vec<(f64, f64)> = (0..200)
                .map(|k| {
                    let real = startup + k as f64 * frame_dt();
                    (real, real)
                })
                .collect();

            let video = video_pts_at_real(&buggy_frames, startup + 3.0);
            let beep = audio_beep_pts_secs(3.0);
            assert!(
                (video - beep).abs() > 0.1,
                "gate must flag the wall-clock-rebase desync (video={video:.4} beep={beep:.4})"
            );
        }
    }

    mod timestamp_anomaly_tracker {
        use super::*;

        fn make_timestamps() -> Timestamps {
            Timestamps::now()
        }

        fn make_timestamp(timestamps: Timestamps, offset: Duration) -> Timestamp {
            Timestamp::Instant(timestamps.instant() + offset)
        }

        #[test]
        fn normal_frames_produce_no_anomalies() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..10u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            assert_eq!(tracker.anomaly_count, 0);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 0);
            assert!(tracker.wall_clock_start.is_some());
            assert!(tracker.last_valid_wall_clock.is_some());
        }

        #[test]
        fn wall_clock_confirmed_forward_jump_not_counted_as_anomaly() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..5u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            assert_eq!(tracker.anomaly_count, 0);

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(4 * 33))
                .unwrap();

            assert_eq!(tracker.anomaly_count, 0);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 1);
            assert_eq!(tracker.consecutive_anomalies, 0);
        }

        #[test]
        fn spurious_forward_jump_counted_as_anomaly() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..5u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            assert_eq!(tracker.anomaly_count, 0);

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(4 * 33))
                .unwrap();

            assert_eq!(tracker.anomaly_count, 1);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 0);
            assert_eq!(tracker.consecutive_anomalies, 0);
        }

        #[test]
        fn resync_flag_set_on_both_confirmed_and_spurious_jumps() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..5u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            let accepted = tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(4 * 33))
                .unwrap();

            // A wall-clock-confirmed jump is a real gap in frame delivery and
            // passes through unmodified — it is not a resync.
            assert!(
                !tracker.take_resync_flag(),
                "Confirmed gap must not be treated as a timeline resync"
            );
            assert!(
                (accepted.as_secs_f64() - (4.0 * 0.033 + 3.0)).abs() < 0.05,
                "confirmed gap must pass through, got {accepted:?}"
            );

            let next_ts =
                make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000 + 33 + 3000));
            tracker
                .process_timestamp(
                    next_ts,
                    timestamps,
                    Duration::from_millis(4 * 33 + 3000 + 33),
                )
                .unwrap();

            assert!(
                tracker.take_resync_flag(),
                "Resync flag should be set after spurious jump"
            );
            assert_eq!(tracker.anomaly_count, 1);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 1);
        }

        #[test]
        fn multiple_confirmed_jumps_tracked_separately() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..3u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump1 = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000));
            tracker
                .process_timestamp(jump1, timestamps, Duration::from_millis(2 * 33))
                .unwrap();
            tracker.take_resync_flag();

            let normal = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000 + 33));
            tracker
                .process_timestamp(
                    normal,
                    timestamps,
                    Duration::from_millis(2 * 33 + 3000 + 33),
                )
                .unwrap();

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(5));

            let jump2 =
                make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000 + 66 + 5000));
            tracker
                .process_timestamp(jump2, timestamps, Duration::from_millis(2 * 33 + 3000 + 66))
                .unwrap();

            assert_eq!(tracker.anomaly_count, 0);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 2);
            assert_eq!(
                tracker.resync_count, 0,
                "confirmed gaps pass through; they are not timeline resyncs"
            );
        }

        // A loaded encoder can drain the pre-gap backlog and the post-gap
        // frame back-to-back, so the arrival-spacing heuristic sees no wall
        // gap even though the capture timestamps carry a real >2s delivery
        // gap. The timestamps staying at-or-behind the wall clock is what
        // proves the gap real; collapsing it here permanently desynced any
        // recording whose gap began before the drift anchor existed.
        #[test]
        fn bunched_real_gap_behind_wall_clock_is_accepted() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            // Frames 0..0.5s processed in a burst (arrival gaps ~0).
            for i in 0..15u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            // The post-gap frame arrives immediately after (bunched), but its
            // timestamp (4.9s) is behind the wall clock (5.0s): a real gap.
            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4900));
            let accepted = tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(5000))
                .unwrap();

            assert!(
                (accepted.as_secs_f64() - 4.9).abs() < 0.05,
                "real gap must pass through, got {accepted:?}"
            );
            assert_eq!(tracker.anomaly_count, 0);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 1);
        }

        // The inverse case: a timestamp landing ahead of the wall clock can
        // only be a source-clock glitch — no real frame is stamped in the
        // future — so it must still be collapsed, bunched arrival or not.
        #[test]
        fn future_stamped_jump_is_still_collapsed() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..15u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4900));
            let collapsed = tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(15 * 33))
                .unwrap();

            assert!(
                collapsed.as_secs_f64() < 1.0,
                "future-stamped glitch must be collapsed, got {collapsed:?}"
            );
            assert_eq!(tracker.anomaly_count, 1);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 0);
        }

        #[test]
        fn wall_clock_start_set_on_first_frame() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            assert!(tracker.wall_clock_start.is_none());

            let ts = make_timestamp(timestamps, Duration::ZERO);
            tracker
                .process_timestamp(ts, timestamps, Duration::ZERO)
                .unwrap();

            assert!(tracker.wall_clock_start.is_some());
        }

        #[test]
        fn confirmed_jump_still_tracks_forward_skew() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..3u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker
                    .process_timestamp(ts, timestamps, Duration::from_millis(i * 33))
                    .unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000));
            tracker
                .process_timestamp(jump_ts, timestamps, Duration::from_millis(2 * 33))
                .unwrap();

            assert_eq!(tracker.wall_clock_confirmed_jumps, 1);
            assert_eq!(tracker.anomaly_count, 0);
            assert!(tracker.total_forward_skew_secs > 2.0);
        }

        // Mirrors the mux-video task: a trusted/direct frame's remapped timestamp tracks real
        // source time, the anomaly tracker collapses large source-clock jumps, and the drift
        // tracker advances by the wall-clock delta from its boundary anchor. The two stages must
        // compose so that the muxed video PTS tracks the wall clock the audio leg is also
        // reconciled against, while keeping the boundary anchor stable.
        fn run_video_frame(
            anomaly: &mut TimestampAnomalyTracker,
            drift: &mut VideoDriftTracker,
            timestamps: Timestamps,
            source_secs: f64,
            wall_secs: f64,
        ) -> f64 {
            let remapped =
                Timestamp::Instant(timestamps.instant() + Duration::from_secs_f64(source_secs));
            let raw = anomaly
                .process_timestamp(remapped, timestamps, Duration::from_secs_f64(wall_secs))
                .unwrap();
            let _ = anomaly.take_resync_flag();
            drift
                .calculate_timestamp(raw, Duration::from_secs_f64(wall_secs))
                .as_secs_f64()
        }

        // WGC / ScreenCaptureKit deliver no frames while the screen is static, so an idle
        // period longer than LARGE_FORWARD_JUMP_SECS arrives as a single forward jump once the
        // screen changes again. The anomaly tracker collapses that jump; the drift tracker
        // advances by the wall-clock delta from its anchor, which already includes the gap.
        // Because audio keeps recording through the gap, the resumed video frame MUST land at
        // wall-clock time, not behind it — otherwise the held frame would under-cover the static
        // period and every subsequent action would appear ahead of its audio. Regression guard
        // against the wall-clock-delta anchoring being broken.
        #[test]
        fn static_screen_gap_keeps_video_pinned_to_wall_clock() {
            let mut anomaly = TimestampAnomalyTracker::new("video");
            let mut drift = VideoDriftTracker::new();
            let timestamps = make_timestamps();
            let frame = 1.0 / 30.0;

            let mut t = 0.0;
            while t < 3.0 {
                let out = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
                assert!(
                    (out - t).abs() < 0.15,
                    "active frame at {t:.3}s drifted to {out:.3}s"
                );
                t += frame;
            }

            anomaly.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(5));
            t += 5.0;
            let resume = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
            assert!(
                (resume - t).abs() < 0.15,
                "resume frame after a 5s static gap landed at {resume:.3}s but wall clock is \
                 {t:.3}s — a {:.3}s video-behind-audio desync",
                (resume - t).abs()
            );

            for _ in 0..90 {
                t += frame;
                let out = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
                assert!(
                    (out - t).abs() < 0.15,
                    "post-gap frame at {t:.3}s drifted to {out:.3}s (residual catch-up ramp)"
                );
            }
        }

        // A slideshow / tutorial with repeated static slides must not accumulate
        // video-vs-wall-clock skew cycle over cycle.
        #[test]
        fn repeated_static_gaps_do_not_accumulate_desync() {
            let mut anomaly = TimestampAnomalyTracker::new("video");
            let mut drift = VideoDriftTracker::new();
            let timestamps = make_timestamps();
            let frame = 1.0 / 30.0;
            let mut t = 0.0;
            let mut max_skew = 0.0f64;

            for _ in 0..90 {
                let out = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
                max_skew = max_skew.max((out - t).abs());
                t += frame;
            }

            for _ in 0..5 {
                anomaly.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(5));
                t += 5.0;
                let out = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
                max_skew = max_skew.max((out - t).abs());
                for _ in 0..60 {
                    t += frame;
                    let out = run_video_frame(&mut anomaly, &mut drift, timestamps, t, t);
                    max_skew = max_skew.max((out - t).abs());
                }
            }

            assert!(
                max_skew < 0.2,
                "repeated static gaps accumulated {max_skew:.3}s of video-vs-wall-clock skew"
            );
        }
    }

    mod finish_build {
        use super::*;

        #[test]
        fn treats_inner_muxer_finish_error_as_failure() {
            let result = resolve_pipeline_completion(
                Ok(()),
                Ok(Err(anyhow!("fragmented audio trailer write failed"))),
                &PipelineStopSignal::default(),
            );

            let error = result.expect_err("inner muxer failure should fail the pipeline");
            assert!(
                error
                    .to_string()
                    .contains("fragmented audio trailer write failed"),
                "error should include the muxer failure reason"
            );
        }

        #[test]
        fn preserves_task_failure_over_muxer_finish_success() {
            let result = resolve_pipeline_completion(
                Err(anyhow!("capture-video failed")),
                Ok(Ok(())),
                &PipelineStopSignal::default(),
            );

            let error = result.expect_err("task failure should fail the pipeline");
            assert!(
                error.to_string().contains("capture-video failed"),
                "error should include the task failure reason"
            );
        }

        #[test]
        fn succeeds_only_when_tasks_and_muxer_finish_succeed() {
            resolve_pipeline_completion(Ok(()), Ok(Ok(())), &PipelineStopSignal::default())
                .expect("pipeline should succeed when all work succeeds");
        }

        #[test]
        fn treats_user_stop_after_clean_finish_as_success() {
            let signal = PipelineStopSignal::default();
            signal.mark_user_stopped();

            resolve_pipeline_completion(Ok(()), Ok(Ok(())), &signal)
                .expect("user stop should complete cleanly after successful finish");
        }
    }

    mod pipeline_mux_send_failures {
        use super::*;

        #[derive(Clone, Copy)]
        struct TestVideoFrame {
            timestamp: Timestamp,
        }

        impl VideoFrame for TestVideoFrame {
            fn timestamp(&self) -> Timestamp {
                self.timestamp
            }
        }

        #[derive(Clone, Copy)]
        struct FailingVideoMuxerConfig {
            fail_after_frame: u64,
            fail_audio_after_frame: u64,
        }

        struct FailingVideoMuxer {
            fail_after_frame: u64,
            fail_audio_after_frame: u64,
            sent_video_frames: u64,
            sent_audio_frames: u64,
        }

        impl Muxer for FailingVideoMuxer {
            type Config = FailingVideoMuxerConfig;

            async fn setup(
                config: Self::Config,
                _output_path: PathBuf,
                _video_config: Option<VideoInfo>,
                _audio_config: Option<AudioInfo>,
                _pause_flag: Arc<AtomicBool>,
                _tasks: &mut TaskPool,
            ) -> anyhow::Result<Self>
            where
                Self: Sized,
            {
                Ok(Self {
                    fail_after_frame: config.fail_after_frame,
                    fail_audio_after_frame: config.fail_audio_after_frame,
                    sent_video_frames: 0,
                    sent_audio_frames: 0,
                })
            }

            fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
                Ok(Ok(()))
            }
        }

        impl AudioMuxer for FailingVideoMuxer {
            fn send_audio_frame(
                &mut self,
                _frame: AudioFrame,
                _timestamp: Duration,
            ) -> anyhow::Result<()> {
                self.sent_audio_frames += 1;
                if self.sent_audio_frames >= self.fail_audio_after_frame {
                    return Err(anyhow!("audio mux send failed"));
                }
                Ok(())
            }
        }

        impl VideoMuxer for FailingVideoMuxer {
            type VideoFrame = TestVideoFrame;

            fn send_video_frame(
                &mut self,
                _frame: Self::VideoFrame,
                _timestamp: Duration,
            ) -> anyhow::Result<()> {
                self.sent_video_frames += 1;
                if self.sent_video_frames >= self.fail_after_frame {
                    return Err(anyhow!("video mux send failed"));
                }
                Ok(())
            }
        }

        #[derive(Clone, Copy)]
        struct FailingAudioMuxerConfig {
            fail_after_frame: u64,
        }

        struct FailingAudioMuxer {
            fail_after_frame: u64,
            sent_frames: u64,
        }

        impl Muxer for FailingAudioMuxer {
            type Config = FailingAudioMuxerConfig;

            async fn setup(
                config: Self::Config,
                _output_path: PathBuf,
                _video_config: Option<VideoInfo>,
                _audio_config: Option<AudioInfo>,
                _pause_flag: Arc<AtomicBool>,
                _tasks: &mut TaskPool,
            ) -> anyhow::Result<Self>
            where
                Self: Sized,
            {
                Ok(Self {
                    fail_after_frame: config.fail_after_frame,
                    sent_frames: 0,
                })
            }

            fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
                Ok(Ok(()))
            }
        }

        impl AudioMuxer for FailingAudioMuxer {
            fn send_audio_frame(
                &mut self,
                _frame: AudioFrame,
                _timestamp: Duration,
            ) -> anyhow::Result<()> {
                self.sent_frames += 1;
                if self.sent_frames >= self.fail_after_frame {
                    return Err(anyhow!("audio mux send failed"));
                }
                Ok(())
            }
        }

        fn test_video_info() -> VideoInfo {
            VideoInfo::from_raw(cap_media_info::RawVideoFormat::Bgra, 16, 16, 30)
        }

        fn test_audio_info() -> AudioInfo {
            AudioInfo::new_raw(
                cap_media_info::Sample::F32(cap_media_info::Type::Packed),
                48_000,
                2,
            )
        }

        #[tokio::test]
        async fn pipeline_done_future_surfaces_video_mux_send_failure() {
            let temp_dir = tempfile::tempdir().expect("temp dir should be created");
            let timestamps = Timestamps::now();
            let (video_tx, video_rx) = flume::bounded(4);
            let pipeline = OutputPipeline::builder(temp_dir.path().join("video.mp4"))
                .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                    test_video_info(),
                    video_rx,
                ))
                .with_timestamps(timestamps)
                .build::<FailingVideoMuxer>(FailingVideoMuxerConfig {
                    fail_after_frame: 1,
                    fail_audio_after_frame: u64::MAX,
                })
                .await
                .expect("pipeline should build");
            let done_fut = pipeline.done_fut();

            video_tx
                .send_async(TestVideoFrame {
                    timestamp: Timestamp::Instant(timestamps.instant() + Duration::from_millis(33)),
                })
                .await
                .expect("video frame should send");
            drop(video_tx);

            let done_error = done_fut
                .await
                .expect_err("done future should fail when mux-video rejects a frame");
            assert!(
                done_error.to_string().contains("Task mux-video failed"),
                "done future should surface the mux-video task failure"
            );
            assert!(
                done_error
                    .to_string()
                    .contains("Video muxer stopped accepting frames at frame 1"),
                "done future should retain the send-failure context"
            );

            let stop_error = match pipeline.stop().await {
                Ok(_) => panic!("stop should fail when mux-video rejects a frame"),
                Err(error) => error,
            };
            assert!(
                stop_error
                    .to_string()
                    .contains("Video muxer stopped accepting frames at frame 1"),
                "stop should propagate the mux-video send failure"
            );
        }

        #[tokio::test]
        async fn audio_only_pipeline_surfaces_audio_mux_failure() {
            let temp_dir = tempfile::tempdir().expect("temp dir should be created");
            let timestamps = Timestamps::now();
            let (mut audio_tx, audio_rx) = mpsc::channel(4);
            let pipeline = OutputPipeline::builder(temp_dir.path().join("audio.ogg"))
                .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                    test_audio_info(),
                    audio_rx,
                ))
                .with_timestamps(timestamps)
                .build::<FailingAudioMuxer>(FailingAudioMuxerConfig {
                    fail_after_frame: 1,
                })
                .await
                .expect("pipeline should build");
            let done_fut = pipeline.done_fut();

            audio_tx
                .try_send(AudioFrame::new(
                    test_audio_info().empty_frame(960),
                    Timestamp::Instant(timestamps.instant() + Duration::from_millis(20)),
                ))
                .expect("audio frame should send");
            drop(audio_tx);

            let done_error = done_fut
                .await
                .expect_err("audio-only pipeline should fail when muxer rejects frame");
            assert!(
                done_error
                    .to_string()
                    .contains("Audio muxer stopped accepting frames"),
                "error should contain audio failure reason"
            );
        }

        #[tokio::test]
        async fn combined_pipeline_survives_audio_mux_failure() {
            let temp_dir = tempfile::tempdir().expect("temp dir should be created");
            let timestamps = Timestamps::now();
            let (video_tx, video_rx) = flume::bounded(4);
            let (mut audio_tx, audio_rx) = mpsc::channel(4);

            let pipeline = OutputPipeline::builder(temp_dir.path().join("combined.mp4"))
                .with_video::<ChannelVideoSource<TestVideoFrame>>(ChannelVideoSourceConfig::new(
                    test_video_info(),
                    video_rx,
                ))
                .with_audio_source::<ChannelAudioSource>(ChannelAudioSourceConfig::new(
                    test_audio_info(),
                    audio_rx,
                ))
                .with_timestamps(timestamps)
                .build::<FailingVideoMuxer>(FailingVideoMuxerConfig {
                    fail_after_frame: u64::MAX,
                    fail_audio_after_frame: 1,
                })
                .await
                .expect("pipeline should build");

            video_tx
                .send_async(TestVideoFrame {
                    timestamp: Timestamp::Instant(timestamps.instant() + Duration::from_millis(33)),
                })
                .await
                .expect("video frame should send");

            audio_tx
                .try_send(AudioFrame::new(
                    test_audio_info().empty_frame(960),
                    Timestamp::Instant(timestamps.instant() + Duration::from_millis(20)),
                ))
                .expect("audio frame should send");

            drop(video_tx);
            drop(audio_tx);

            pipeline
                .stop()
                .await
                .expect("combined pipeline should succeed despite audio muxer failure");
        }
    }

    mod blocking_thread_finish {
        use super::*;

        #[test]
        fn returns_clean_when_thread_exits_successfully() {
            let handle = std::thread::spawn(|| Ok(()));

            match wait_for_blocking_thread_finish(handle, Duration::from_millis(100), "test-worker")
            {
                BlockingThreadFinish::Clean => {}
                BlockingThreadFinish::Failed(error) => {
                    panic!("expected clean shutdown, got failure: {error:#}");
                }
                BlockingThreadFinish::TimedOut(error) => {
                    panic!("expected clean shutdown, got timeout: {error:#}");
                }
            }
        }

        #[test]
        fn returns_failure_when_thread_returns_error() {
            let handle = std::thread::spawn(|| Err(anyhow!("encoder worker failed")));

            match wait_for_blocking_thread_finish(handle, Duration::from_millis(100), "test-worker")
            {
                BlockingThreadFinish::Failed(error) => {
                    assert!(
                        error.to_string().contains("encoder worker failed"),
                        "error should include the worker failure reason"
                    );
                }
                BlockingThreadFinish::Clean => {
                    panic!("expected failure when worker returns an error");
                }
                BlockingThreadFinish::TimedOut(error) => {
                    panic!("expected failure, got timeout: {error:#}");
                }
            }
        }

        #[test]
        fn returns_timeout_when_thread_does_not_exit_in_time() {
            // The worker blocks until released, so it can never beat the
            // timeout however unfairly a loaded machine schedules threads.
            let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
            let handle = std::thread::spawn(move || {
                let _ = release_rx.recv();
                Ok(())
            });
            let _release_tx = release_tx;

            match wait_for_blocking_thread_finish(handle, Duration::from_millis(5), "test-worker") {
                BlockingThreadFinish::TimedOut(error) => {
                    assert!(
                        error
                            .to_string()
                            .contains("test-worker did not finish within"),
                        "error should include the timeout reason"
                    );
                }
                BlockingThreadFinish::Clean => {
                    panic!("expected timeout when worker exceeds deadline");
                }
                BlockingThreadFinish::Failed(error) => {
                    panic!("expected timeout, got failure: {error:#}");
                }
            }
        }

        #[test]
        fn timeout_cleanup_reports_late_success() {
            let handle = std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(25));
                Ok(())
            });

            let cleanup_rx = spawn_blocking_thread_timeout_cleanup(handle, "test-worker");
            let result = cleanup_rx
                .recv_timeout(Duration::from_millis(250))
                .expect("cleanup worker should report eventual completion");

            result.expect("cleanup worker should observe a clean exit");
        }

        #[test]
        fn timeout_cleanup_reports_late_failure() {
            let handle = std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(25));
                Err(anyhow!("late worker failure"))
            });

            let cleanup_rx = spawn_blocking_thread_timeout_cleanup(handle, "test-worker");
            let error = cleanup_rx
                .recv_timeout(Duration::from_millis(250))
                .expect("cleanup worker should report eventual completion")
                .expect_err("cleanup worker should surface a late failure");

            assert!(
                error.to_string().contains("late worker failure"),
                "error should include the late worker failure"
            );
        }
    }

    mod stall_send_budget {
        use super::*;

        fn drain_health_events(rx: &mut HealthReceiver) -> Vec<PipelineHealthEvent> {
            let mut events = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
            events
        }

        #[test]
        fn flume_send_succeeds_without_stall_when_channel_has_room() {
            let (tx, _rx) = flume::bounded::<u32>(4);
            let (health_tx, mut health_rx) = new_health_channel();

            let outcome = send_with_stall_budget_flume(&tx, 42, "test-source", &health_tx);

            assert_eq!(outcome, StallSendOutcome::Sent);
            assert!(drain_health_events(&mut health_rx).is_empty());
        }

        #[test]
        fn flume_send_recovers_before_budget_when_receiver_drains() {
            let (tx, rx) = flume::bounded::<u32>(1);
            tx.try_send(1).expect("priming send should succeed");
            let (health_tx, mut health_rx) = new_health_channel();

            let drain_handle = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(10));
                rx.recv().expect("receiver should drain priming value");
                rx
            });

            let outcome = send_with_stall_budget_flume(&tx, 2, "test-source", &health_tx);

            let _rx = drain_handle.join().unwrap();
            assert_eq!(outcome, StallSendOutcome::Sent);
            assert!(
                drain_health_events(&mut health_rx).is_empty(),
                "Stalled must not be emitted when send completes within budget"
            );
        }

        #[test]
        fn flume_send_stalls_and_drops_when_budget_expires() {
            let (tx, _rx) = flume::bounded::<u32>(1);
            tx.try_send(1).expect("priming send should succeed");
            let (health_tx, mut health_rx) = new_health_channel();

            let outcome = send_with_stall_budget_flume(&tx, 2, "screen-video", &health_tx);

            match outcome {
                StallSendOutcome::StalledAndDropped { waited_ms } => {
                    assert!(
                        waited_ms >= STALL_BUDGET_MS,
                        "expected waited_ms >= {STALL_BUDGET_MS}, got {waited_ms}"
                    );
                }
                other => panic!("expected StalledAndDropped, got {other:?}"),
            }

            let events = drain_health_events(&mut health_rx);
            assert_eq!(events.len(), 1, "exactly one Stalled event expected");
            match &events[0] {
                PipelineHealthEvent::Stalled { source, waited_ms } => {
                    assert_eq!(source, "screen-video");
                    assert!(
                        *waited_ms >= STALL_BUDGET_MS,
                        "event waited_ms must reflect budget ({waited_ms})"
                    );
                }
                other => panic!("expected Stalled event, got {other:?}"),
            }
        }

        #[test]
        fn flume_send_disconnected_returns_disconnected_without_stall() {
            let (tx, rx) = flume::bounded::<u32>(1);
            drop(rx);
            let (health_tx, mut health_rx) = new_health_channel();

            let outcome = send_with_stall_budget_flume(&tx, 1, "test-source", &health_tx);

            assert_eq!(outcome, StallSendOutcome::Disconnected);
            assert!(
                drain_health_events(&mut health_rx).is_empty(),
                "Disconnected must not emit Stalled"
            );
        }

        #[test]
        fn futures_mpsc_send_succeeds_without_stall_when_channel_has_room() {
            let (mut tx, _rx) = mpsc::channel::<u32>(4);
            let (health_tx, mut health_rx) = new_health_channel();

            let outcome = send_with_stall_budget_futures(&mut tx, 42, "test-source", &health_tx);

            assert_eq!(outcome, StallSendOutcome::Sent);
            assert!(drain_health_events(&mut health_rx).is_empty());
        }

        #[test]
        fn futures_mpsc_send_stalls_and_drops_when_budget_expires() {
            let (mut tx, _rx) = mpsc::channel::<u32>(0);
            tx.try_send(1)
                .expect("priming send should fill zero-buf channel");
            let (health_tx, mut health_rx) = new_health_channel();

            let outcome =
                send_with_stall_budget_futures(&mut tx, 2, "screen-system-audio", &health_tx);

            match outcome {
                StallSendOutcome::StalledAndDropped { waited_ms } => {
                    assert!(
                        waited_ms >= STALL_BUDGET_MS,
                        "expected waited_ms >= {STALL_BUDGET_MS}, got {waited_ms}"
                    );
                }
                other => panic!("expected StalledAndDropped, got {other:?}"),
            }

            let events = drain_health_events(&mut health_rx);
            assert_eq!(events.len(), 1);
            match &events[0] {
                PipelineHealthEvent::Stalled { source, .. } => {
                    assert_eq!(source, "screen-system-audio");
                }
                other => panic!("expected Stalled, got {other:?}"),
            }
        }

        const _STALL_BUDGET_BOUNDS_CHECK: () = {
            assert!(
                STALL_BUDGET_MS >= 10 && STALL_BUDGET_MS <= 500,
                "STALL_BUDGET_MS must be within a sane 10-500ms range"
            );
        };
    }

    mod video_start_gate {
        use super::*;
        use cap_media_info::AudioInfo;

        const TEST_SAMPLE_RATE: u32 = 48_000;
        const TEST_CHANNELS: usize = 2;

        fn test_audio_info() -> AudioInfo {
            AudioInfo {
                sample_format: ffmpeg::format::Sample::F32(ffmpeg::format::sample::Type::Packed),
                sample_rate: TEST_SAMPLE_RATE,
                channels: TEST_CHANNELS,
                time_base: ffmpeg::Rational::new(1, TEST_SAMPLE_RATE as i32),
                buffer_size: 1024,
                is_wireless_transport: false,
            }
        }

        fn make_test_frame(info: &AudioInfo, samples: usize, fill: f32) -> ffmpeg::frame::Audio {
            let mut frame =
                ffmpeg::frame::Audio::new(info.sample_format, samples, info.channel_layout());
            frame.set_rate(info.sample_rate);
            let plane = frame.data_mut(0);
            let bytes = fill.to_ne_bytes();
            for i in 0..(samples * info.channels) {
                let off = i * 4;
                plane[off..off + 4].copy_from_slice(&bytes);
            }
            frame
        }

        #[test]
        fn gate_publishes_exactly_once() {
            let gate = VideoStartGate::new();
            assert!(!gate.is_armed());
            gate.publish(12_345);
            assert!(gate.is_armed());
            assert_eq!(gate.start_ns_if_armed(), Some(12_345));

            gate.publish(99_999);
            assert_eq!(gate.start_ns_if_armed(), Some(12_345));
        }

        #[tokio::test(flavor = "current_thread")]
        async fn gate_wait_returns_immediately_when_already_armed() {
            let gate = VideoStartGate::new();
            gate.publish(7_777);
            let v = gate
                .wait_with_timeout(Duration::from_millis(10))
                .await
                .expect("armed gate returns value without waiting");
            assert_eq!(v, 7_777);
        }

        #[tokio::test(flavor = "current_thread")]
        async fn gate_wait_times_out_when_never_armed() {
            let gate = VideoStartGate::new();
            let r = gate.wait_with_timeout(Duration::from_millis(5)).await;
            assert!(r.is_none());
        }

        #[tokio::test(flavor = "current_thread")]
        async fn gate_wait_wakes_on_publish() {
            let gate = VideoStartGate::new();
            let gate_clone = gate.clone();

            let publisher = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(10)).await;
                gate_clone.publish(42);
            });

            let v = gate
                .wait_with_timeout(Duration::from_secs(5))
                .await
                .expect("wait should return once publisher runs");
            publisher.await.unwrap();
            assert_eq!(v, 42);
        }

        #[test]
        fn trim_audio_frame_front_basic_packed() {
            let info = test_audio_info();
            let frame = make_test_frame(&info, 1024, 1.0);
            let trimmed =
                trim_audio_frame_front(&frame, 256).expect("trim should succeed for 256/1024");
            assert_eq!(trimmed.samples(), 768);
            assert_eq!(trimmed.rate(), TEST_SAMPLE_RATE);
            assert_eq!(trimmed.channels() as usize, TEST_CHANNELS);
        }

        #[test]
        fn trim_audio_frame_front_full_drop_returns_none() {
            let info = test_audio_info();
            let frame = make_test_frame(&info, 64, 1.0);
            let trimmed = trim_audio_frame_front(&frame, 64);
            assert!(trimmed.is_none(), "trimming all samples must return None");
            let trimmed_all = trim_audio_frame_front(&frame, 100);
            assert!(trimmed_all.is_none());
        }

        #[test]
        fn trim_audio_frame_front_zero_is_clone() {
            let info = test_audio_info();
            let frame = make_test_frame(&info, 512, 1.0);
            let trimmed =
                trim_audio_frame_front(&frame, 0).expect("zero trim must clone and succeed");
            assert_eq!(trimmed.samples(), 512);
        }

        #[test]
        fn ns_to_sample_count_maps_correctly() {
            assert_eq!(ns_to_sample_count(0, 48_000), 0);
            assert_eq!(
                ns_to_sample_count(1_000_000_000, 48_000),
                48_000,
                "1s → sample_rate samples"
            );
            assert_eq!(
                ns_to_sample_count(1_000_000, 48_000),
                48,
                "1ms at 48kHz is 48 samples"
            );
            assert_eq!(ns_to_sample_count(500_000_000, 0), 0);
        }

        #[tokio::test(flavor = "current_thread")]
        async fn apply_gate_audio_leads_trims_front() {
            let info = test_audio_info();
            let master_clock = MasterClock::new(Timestamps::now(), TEST_SAMPLE_RATE);
            let start = master_clock.start_instant();
            let gate = VideoStartGate::new();

            let video_start_ns: u64 = 20_000_000;
            gate.publish(video_start_ns);

            let audio_ts = Timestamp::Instant(start);
            let frame = AudioFrame::new(make_test_frame(&info, 2048, 0.0), audio_ts);
            let mut generator = AudioTimestampGenerator::from_master_clock(master_clock.clone());

            let action = apply_video_start_gate(
                &gate,
                &frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;

            match action {
                VideoStartGateAction::UseFrame(new_frame) => {
                    let expected_trim =
                        ns_to_sample_count(video_start_ns, info.sample_rate) as usize;
                    assert_eq!(new_frame.inner.samples(), 2048 - expected_trim);
                    // Timestamp must be advanced by the trim so that mic_start_time in
                    // metadata reflects the first committed sample, preventing the editor
                    // from double-counting the same gap as a skip offset.
                    let trim_duration = Duration::from_nanos(
                        expected_trim as u64 * 1_000_000_000 / info.sample_rate as u64,
                    );
                    let expected_ts = Timestamp::Instant(start + trim_duration);
                    assert_eq!(
                        new_frame
                            .timestamp
                            .signed_duration_since_secs(master_clock.timestamps()),
                        expected_ts.signed_duration_since_secs(master_clock.timestamps()),
                        "gate UseFrame timestamp must be advanced past the trimmed samples"
                    );
                }
                other => panic!("expected UseFrame when audio leads, got {other:?}"),
            }
        }

        #[tokio::test(flavor = "current_thread")]
        async fn apply_gate_audio_leads_full_frame_drop() {
            let info = test_audio_info();
            let master_clock = MasterClock::new(Timestamps::now(), TEST_SAMPLE_RATE);
            let start = master_clock.start_instant();
            let gate = VideoStartGate::new();

            let video_start_ns: u64 = 200_000_000;
            gate.publish(video_start_ns);

            let audio_ts = Timestamp::Instant(start);
            let frame = AudioFrame::new(make_test_frame(&info, 512, 0.0), audio_ts);
            let mut generator = AudioTimestampGenerator::from_master_clock(master_clock.clone());

            let action = apply_video_start_gate(
                &gate,
                &frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;

            assert!(
                matches!(action, VideoStartGateAction::DropFrame),
                "a 200ms offset against 512-sample frame must drop the frame"
            );
        }

        #[tokio::test(flavor = "current_thread")]
        async fn apply_gate_video_leads_advances_timeline() {
            let info = test_audio_info();
            let master_clock = MasterClock::new(Timestamps::now(), TEST_SAMPLE_RATE);
            let start = master_clock.start_instant();
            let gate = VideoStartGate::new();

            gate.publish(0);

            let audio_offset_ms = 15u64;
            let audio_ts = Timestamp::Instant(start + Duration::from_millis(audio_offset_ms));
            let frame = AudioFrame::new(make_test_frame(&info, 1024, 0.0), audio_ts);
            let mut generator = AudioTimestampGenerator::from_master_clock(master_clock.clone());
            let before = generator.total_samples;

            let action = apply_video_start_gate(
                &gate,
                &frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;

            assert!(
                matches!(action, VideoStartGateAction::Passthrough),
                "video-leads should passthrough with generator advance, got {action:?}"
            );
            let expected_samples =
                ns_to_sample_count(audio_offset_ms * 1_000_000, info.sample_rate);
            assert_eq!(generator.total_samples - before, expected_samples);
        }

        #[tokio::test(flavor = "current_thread")]
        async fn apply_gate_offset_beyond_limit_passthrough() {
            let info = test_audio_info();
            let master_clock = MasterClock::new(Timestamps::now(), TEST_SAMPLE_RATE);
            let start = master_clock.start_instant();
            let gate = VideoStartGate::new();

            gate.publish(AV_START_ALIGNMENT_LIMIT_NS + 1_000_000);

            let audio_ts = Timestamp::Instant(start);
            let frame = AudioFrame::new(make_test_frame(&info, 2048, 0.0), audio_ts);
            let mut generator = AudioTimestampGenerator::from_master_clock(master_clock.clone());

            let action = apply_video_start_gate(
                &gate,
                &frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;

            assert!(
                matches!(action, VideoStartGateAction::Passthrough),
                "offset beyond AV_START_ALIGNMENT_LIMIT_NS must passthrough"
            );
        }

        const _AV_ALIGNMENT_LIMIT_BOUNDS: () = {
            assert!(
                AV_START_ALIGNMENT_LIMIT_NS >= 50_000_000
                    && AV_START_ALIGNMENT_LIMIT_NS <= 5_000_000_000,
                "AV_START_ALIGNMENT_LIMIT_NS must be within 50ms..5s"
            );
        };

        #[tokio::test(flavor = "current_thread")]
        async fn apply_gate_dropframe_retries_on_next_frame_not_consumed() {
            let info = test_audio_info();
            let master_clock = MasterClock::new(Timestamps::now(), TEST_SAMPLE_RATE);
            let start = master_clock.start_instant();
            let gate = VideoStartGate::new();

            let video_start_ns: u64 = 200_000_000;
            gate.publish(video_start_ns);

            let small_frame =
                AudioFrame::new(make_test_frame(&info, 512, 0.0), Timestamp::Instant(start));
            let mut generator = AudioTimestampGenerator::from_master_clock(master_clock.clone());

            let action = apply_video_start_gate(
                &gate,
                &small_frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;
            assert!(
                matches!(action, VideoStartGateAction::DropFrame),
                "sanity: 200ms offset on 512-sample frame must DropFrame"
            );

            let big_frame_offset_ms = 200u64;
            let next_ts = Timestamp::Instant(start + Duration::from_millis(big_frame_offset_ms));
            let big_frame = AudioFrame::new(make_test_frame(&info, 20_000, 0.0), next_ts);

            let action2 = apply_video_start_gate(
                &gate,
                &big_frame,
                &master_clock,
                &mut generator,
                info.sample_rate,
            )
            .await;
            match action2 {
                VideoStartGateAction::Passthrough | VideoStartGateAction::UseFrame(_) => {}
                VideoStartGateAction::DropFrame => panic!(
                    "gate must still be applicable on next frame after a DropFrame; \
                     this guards the 2026-04-20 gate_applied regression"
                ),
            }
        }

        #[derive(Clone, Debug, PartialEq, Eq)]
        struct SentAudioFrame {
            samples: usize,
            timestamp: Duration,
        }

        struct RecordingAudioMuxer {
            sent: Arc<std::sync::Mutex<Vec<SentAudioFrame>>>,
        }

        impl Muxer for RecordingAudioMuxer {
            type Config = Arc<std::sync::Mutex<Vec<SentAudioFrame>>>;

            async fn setup(
                config: Self::Config,
                _output_path: PathBuf,
                _video_config: Option<VideoInfo>,
                _audio_config: Option<AudioInfo>,
                _pause_flag: Arc<AtomicBool>,
                _tasks: &mut TaskPool,
            ) -> anyhow::Result<Self>
            where
                Self: Sized,
            {
                Ok(Self { sent: config })
            }

            fn finish(&mut self, _timestamp: Duration) -> anyhow::Result<anyhow::Result<()>> {
                Ok(Ok(()))
            }
        }

        impl AudioMuxer for RecordingAudioMuxer {
            fn send_audio_frame(
                &mut self,
                frame: AudioFrame,
                timestamp: Duration,
            ) -> anyhow::Result<()> {
                self.sent.lock().unwrap().push(SentAudioFrame {
                    samples: frame.inner.samples(),
                    timestamp,
                });
                Ok(())
            }
        }

        struct AudioTimelineHarness {
            info: AudioInfo,
            timestamps: Timestamps,
            master_clock: Arc<MasterClock>,
            muxer: Arc<Mutex<RecordingAudioMuxer>>,
            sent: Arc<std::sync::Mutex<Vec<SentAudioFrame>>>,
            health_tx: HealthSender,
            shared_pause: SharedWallClockPause,
            timestamp_generator: AudioTimestampGenerator,
            gap_tracker: AudioGapTracker,
            gate_applied: bool,
            first_tx: Option<oneshot::Sender<Timestamp>>,
            frame_count: u64,
            dropped_during_pause: u64,
            anchor: AudioAnchor,
        }

        impl AudioTimelineHarness {
            fn new() -> Self {
                let info = test_audio_info();
                let timestamps = Timestamps::now();
                let master_clock = MasterClock::new(timestamps, TEST_SAMPLE_RATE);
                let sent = Arc::new(std::sync::Mutex::new(Vec::new()));
                let muxer = Arc::new(Mutex::new(RecordingAudioMuxer { sent: sent.clone() }));
                let (health_tx, _) = new_health_channel();
                let shared_pause = SharedWallClockPause::new(Arc::new(AtomicBool::new(false)));

                Self {
                    info,
                    timestamps,
                    master_clock: master_clock.clone(),
                    muxer,
                    sent,
                    health_tx,
                    shared_pause,
                    timestamp_generator: AudioTimestampGenerator::from_master_clock(master_clock),
                    gap_tracker: AudioGapTracker::new(false, timestamps),
                    gate_applied: true,
                    first_tx: None,
                    frame_count: 0,
                    dropped_during_pause: 0,
                    anchor: AudioAnchor::FirstFrame,
                }
            }

            fn new_epoch_anchored() -> Self {
                Self {
                    anchor: AudioAnchor::PipelineEpoch,
                    ..Self::new()
                }
            }

            async fn process(
                &mut self,
                timestamp_offset: Duration,
                samples: usize,
            ) -> AudioFrameOutcome {
                self.process_at(timestamp_offset, timestamp_offset, samples)
                    .await
            }

            // `process_audio_frame` reads the wall clock (`observed_at`) which caps
            // `capture_elapsed` at wall + AUDIO_WALL_CLOCK_TOLERANCE. Driving a multi-minute
            // simulation synchronously would otherwise pin the cap near zero, so the harness
            // injects both the capture timestamp and the observed wall clock explicitly.
            async fn process_at(
                &mut self,
                capture_offset: Duration,
                wall_offset: Duration,
                samples: usize,
            ) -> AudioFrameOutcome {
                let timestamp = Timestamp::Instant(self.timestamps.instant() + capture_offset);
                let observed_at = self.timestamps.instant() + wall_offset;
                let frame = AudioFrame::new(make_test_frame(&self.info, samples, 0.0), timestamp);

                process_audio_frame(
                    AudioFrameProcessContext {
                        audio_info: &self.info,
                        sample_rate: self.info.sample_rate,
                        master_clock: &self.master_clock,
                        muxer: &self.muxer,
                        health_tx: &self.health_tx,
                        shared_pause: &self.shared_pause,
                        video_start_gate: None,
                        has_video: true,
                        origin: FrameProcessOrigin::Live,
                        observed_at,
                        timestamps: self.timestamps,
                        anchor: self.anchor,
                    },
                    AudioFrameProcessState {
                        timestamp_generator: &mut self.timestamp_generator,
                        gap_tracker: &mut self.gap_tracker,
                        gate_applied: &mut self.gate_applied,
                        first_tx: &mut self.first_tx,
                        frame_count: &mut self.frame_count,
                        dropped_during_pause: &mut self.dropped_during_pause,
                    },
                    frame,
                )
                .await
                .unwrap()
            }

            fn committed_audio(&mut self) -> Duration {
                self.timestamp_generator.next_timestamp(0)
            }

            fn total_silence(&self) -> Duration {
                self.gap_tracker.total_silence_inserted
            }

            fn overlap_dropped_frames(&self) -> u64 {
                self.gap_tracker.overlap_dropped_frames
            }

            fn sent(&self) -> Vec<SentAudioFrame> {
                self.sent.lock().unwrap().clone()
            }
        }

        #[tokio::test(flavor = "current_thread")]
        async fn overlapping_delayed_mic_frame_is_trimmed() {
            let mut harness = AudioTimelineHarness::new();

            assert!(matches!(
                harness.process(Duration::ZERO, 1_680).await,
                AudioFrameOutcome::Sent
            ));
            assert!(matches!(
                harness.process(Duration::from_millis(35), 960).await,
                AudioFrameOutcome::Sent
            ));
            assert!(matches!(
                harness.process(Duration::from_millis(35), 1_680).await,
                AudioFrameOutcome::Sent
            ));

            assert_eq!(
                harness.sent(),
                vec![
                    SentAudioFrame {
                        samples: 1_680,
                        timestamp: Duration::ZERO,
                    },
                    SentAudioFrame {
                        samples: 960,
                        timestamp: Duration::from_millis(35),
                    },
                    SentAudioFrame {
                        samples: 720,
                        timestamp: Duration::from_millis(55),
                    },
                ]
            );
        }

        #[tokio::test(flavor = "current_thread")]
        async fn fully_overlapping_delayed_mic_frame_is_dropped() {
            let mut harness = AudioTimelineHarness::new();

            assert!(matches!(
                harness.process(Duration::ZERO, 1_680).await,
                AudioFrameOutcome::Sent
            ));
            assert!(matches!(
                harness.process(Duration::from_millis(35), 960).await,
                AudioFrameOutcome::Sent
            ));
            assert!(matches!(
                harness.process(Duration::from_millis(55), 960).await,
                AudioFrameOutcome::Sent
            ));
            assert!(matches!(
                harness.process(Duration::from_millis(35), 1_680).await,
                AudioFrameOutcome::DropFrame
            ));

            assert_eq!(harness.sent().len(), 3);
        }

        #[test]
        fn real_capture_gap_still_requests_silence() {
            let timestamps = Timestamps::now();
            let mut tracker = AudioGapTracker::new(false, timestamps);
            let wall_clock_start = Instant::now();

            tracker.mark_started(Timestamp::Instant(timestamps.instant()), wall_clock_start);

            let gap = tracker
                .detect_gap(
                    Timestamp::Instant(timestamps.instant() + Duration::from_millis(300)),
                    Duration::from_millis(20),
                    Duration::ZERO,
                    wall_clock_start + Duration::from_millis(300),
                )
                .expect("300ms capture gap after 20ms of samples must insert silence");

            assert_eq!(gap, Duration::from_millis(280));
        }

        fn abs_skew(a: Duration, b: Duration) -> Duration {
            a.saturating_sub(b).max(b.saturating_sub(a))
        }

        // With the mic source no longer fabricating silence for transient stalls, a stall
        // where the device keeps capturing and later delivers its backlog in order (with the
        // true, continuous capture timestamps) must reconcile cleanly: the committed audio
        // timeline tracks the capture span, no silence is inserted, and no real frame is
        // dropped. This is the post-fix shape of the original 399ms-overrun repro.
        #[tokio::test(flavor = "current_thread")]
        async fn transient_stall_in_order_backlog_no_overrun_no_drop() {
            let mut harness = AudioTimelineHarness::new();
            let frame = Duration::from_millis(20);
            let samples = 960usize;

            for k in 0..5u64 {
                let t = frame * k as u32;
                assert!(matches!(
                    harness.process_at(t, t, samples).await,
                    AudioFrameOutcome::Sent
                ));
            }

            // Frames 5..=10 were captured during a ~120ms delivery stall and arrive together
            // at the resume wall clock, but keep their true continuous capture timestamps.
            let resume_wall = frame * 11;
            for k in 5..=10u64 {
                let capture = frame * k as u32;
                assert!(
                    matches!(
                        harness.process_at(capture, resume_wall, samples).await,
                        AudioFrameOutcome::Sent
                    ),
                    "backlog frame {k} must be kept, not dropped"
                );
            }

            for k in 11..16u64 {
                let t = frame * k as u32;
                assert!(matches!(
                    harness.process_at(t, t, samples).await,
                    AudioFrameOutcome::Sent
                ));
            }

            let committed = harness.committed_audio();
            let capture_span = frame * 16;
            assert!(
                abs_skew(committed, capture_span) <= Duration::from_millis(5),
                "committed audio {committed:?} drifted from capture span {capture_span:?}"
            );
            assert_eq!(
                harness.total_silence(),
                Duration::ZERO,
                "late-but-present audio must not trigger silence insertion"
            );
            assert_eq!(
                harness.overlap_dropped_frames(),
                0,
                "no real audio frame may be discarded for late-but-present delivery"
            );
        }

        // System audio (WASAPI loopback) may deliver its first packet long after
        // the recording starts — the first packet marks "first sound played",
        // not "source ready". An epoch-anchored track reports the pipeline
        // epoch as its start and synthesizes head silence, so a late first
        // sound can never become the cross-track alignment anchor and cut the
        // head off the display/mic tracks.
        #[tokio::test(flavor = "current_thread")]
        async fn epoch_anchor_fills_head_and_reports_epoch_start() {
            let mut harness = AudioTimelineHarness::new_epoch_anchored();
            let (tx, mut rx) = oneshot::channel();
            harness.first_tx = Some(tx);

            let first_frame_at = Duration::from_millis(2_500);
            assert!(matches!(
                harness
                    .process_at(first_frame_at, first_frame_at, 960)
                    .await,
                AudioFrameOutcome::Sent
            ));

            let start = rx
                .try_recv()
                .unwrap()
                .expect("first timestamp must be reported");
            assert!(
                start.signed_duration_since_secs(harness.timestamps).abs() < 1e-9,
                "track start must be the pipeline epoch, not the first frame"
            );

            let committed = harness.committed_audio();
            let expected =
                first_frame_at + Duration::from_secs_f64(960.0 / TEST_SAMPLE_RATE as f64);
            assert!(
                abs_skew(committed, expected) <= Duration::from_millis(1),
                "timeline must cover head silence + frame, got {committed:?}"
            );

            let sent = harness.sent();
            let head_samples: usize = sent[..sent.len() - 1].iter().map(|f| f.samples).sum();
            assert_eq!(
                head_samples,
                (TEST_SAMPLE_RATE as f64 * 2.5) as usize,
                "head silence must cover exactly epoch..first frame"
            );
            assert!(
                sent[..sent.len() - 1]
                    .iter()
                    .all(|f| f.samples <= TEST_SAMPLE_RATE as usize),
                "head silence must be chunked to at most 1s frames"
            );
            let real = sent.last().unwrap().clone();
            assert_eq!(real.samples, 960);
            assert!(
                abs_skew(real.timestamp, first_frame_at) <= Duration::from_millis(1),
                "first real frame must land at its capture offset from the epoch"
            );
            for pair in sent.windows(2) {
                assert!(pair[1].timestamp >= pair[0].timestamp);
            }
            assert_eq!(
                harness.total_silence(),
                Duration::ZERO,
                "head anchoring must not count as gap-repair silence"
            );
        }

        // While the system plays nothing, loopback delivers nothing; when
        // sound resumes after a long dead zone the resumed content must land
        // at its capture time in one detection, not smeared early by a
        // truncated insertion.
        #[tokio::test(flavor = "current_thread")]
        async fn epoch_anchor_dead_zone_resumes_at_capture_time() {
            let mut harness = AudioTimelineHarness::new_epoch_anchored();

            let frame_dur = Duration::from_secs_f64(960.0 / TEST_SAMPLE_RATE as f64);
            assert!(matches!(
                harness
                    .process_at(Duration::from_millis(50), Duration::from_millis(50), 960)
                    .await,
                AudioFrameOutcome::Sent
            ));

            let resume_at = Duration::from_secs(30);
            assert!(matches!(
                harness.process_at(resume_at, resume_at, 960).await,
                AudioFrameOutcome::Sent
            ));

            let committed = harness.committed_audio();
            assert!(
                abs_skew(committed, resume_at + frame_dur) <= Duration::from_millis(5),
                "post-dead-zone audio must land at capture time, got {committed:?}"
            );

            let sent = harness.sent();
            let last = sent.last().unwrap();
            assert_eq!(last.samples, 960);
            assert!(
                abs_skew(last.timestamp, resume_at) <= Duration::from_millis(5),
                "resumed frame must be muxed at its capture offset, got {:?}",
                last.timestamp
            );
            assert!(
                sent.iter().all(|f| f.samples <= TEST_SAMPLE_RATE as usize),
                "gap silence must be chunked to at most 1s frames"
            );
            for pair in sent.windows(2) {
                assert!(pair[1].timestamp >= pair[0].timestamp);
            }
        }

        // Device-backed tracks (microphone) keep the first-frame anchor: the
        // track starts when the device produces its first samples.
        #[tokio::test(flavor = "current_thread")]
        async fn first_frame_anchor_reports_first_frame_start() {
            let mut harness = AudioTimelineHarness::new();
            let (tx, mut rx) = oneshot::channel();
            harness.first_tx = Some(tx);

            let first_frame_at = Duration::from_millis(2_500);
            assert!(matches!(
                harness
                    .process_at(first_frame_at, first_frame_at, 960)
                    .await,
                AudioFrameOutcome::Sent
            ));

            let start = rx
                .try_recv()
                .unwrap()
                .expect("first timestamp must be reported");
            assert!(
                (start.signed_duration_since_secs(harness.timestamps) - 2.5).abs() < 1e-6,
                "mic-style tracks must still report the first frame as start"
            );

            let sent = harness.sent();
            assert_eq!(sent.len(), 1, "no head silence for first-frame anchoring");
            assert_eq!(sent[0].samples, 960);
            assert_eq!(sent[0].timestamp, Duration::ZERO);
        }

        // 5m30s simulated recording at 48kHz with a 0.1% slow mic clock and eight stalls
        // (5-293ms) that later fill. The sample-count audio timeline must keep tracking the
        // device capture clock within a bounded window (gap-corrected, never runaway), and
        // a slow-clock drift must be absorbed by bounded silence rather than by discarding
        // captured audio.
        #[tokio::test(flavor = "current_thread")]
        async fn five_minute_recording_audio_stays_bounded_under_drift_and_stalls() {
            let mut harness = AudioTimelineHarness::new();
            let rate = TEST_SAMPLE_RATE as f64;
            let samples = 960usize;
            let audio_content = samples as f64 / rate; // 20ms of audio per frame
            let mic_drift = 1.001; // 960 samples take 0.1% longer than 20ms of system time
            let total_frames = 16_500u64; // ~330s

            let stalls: [(u64, u64); 8] = [
                (1_000, 120),
                (3_000, 40),
                (5_000, 80),
                (7_000, 293),
                (9_000, 114),
                (11_000, 43),
                (13_000, 160),
                (15_000, 200),
            ];

            let mut backlog_lag = Duration::ZERO;
            let mut max_skew = Duration::ZERO;

            for k in 0..total_frames {
                if let Some((_, stall_ms)) = stalls.iter().find(|(idx, _)| *idx == k) {
                    backlog_lag = Duration::from_millis(*stall_ms);
                }

                let capture = Duration::from_secs_f64(k as f64 * audio_content * mic_drift);
                let wall = capture + backlog_lag;
                backlog_lag = backlog_lag.saturating_sub(Duration::from_secs_f64(audio_content));

                assert!(
                    matches!(
                        harness.process_at(capture, wall, samples).await,
                        AudioFrameOutcome::Sent
                    ),
                    "frame {k} unexpectedly not sent"
                );

                let committed = harness.committed_audio();
                max_skew = max_skew.max(abs_skew(committed, capture));
            }

            assert!(
                max_skew < Duration::from_millis(100),
                "audio drifted from the capture clock by {max_skew:?} over the recording"
            );
            assert_eq!(
                harness.overlap_dropped_frames(),
                0,
                "slow-clock drift must be corrected with silence, never by dropping real audio"
            );
            let silence = harness.total_silence();
            assert!(
                silence < Duration::from_secs(1),
                "drift correction silence {silence:?} is not bounded"
            );

            for pair in harness.sent().windows(2) {
                assert!(
                    pair[1].timestamp >= pair[0].timestamp,
                    "muxed audio timestamps must be monotonic"
                );
            }
        }

        // The video leg is wall-clock pinned via VideoDriftTracker. Over a long recording a
        // camera whose real rate differs from nominal (here ~26.44fps with 0.1% drift) must
        // stay within a bounded window of the wall clock, so it cannot accumulate unbounded
        // skew against the capture-clock-tracked audio leg.
        #[test]
        fn video_timeline_stays_bounded_to_wall_clock_over_long_recording() {
            let mut video = VideoDriftTracker::new();
            let fps = 26.44f64;
            let interval = 1.0 / fps;
            let total_frames = (330.0 * fps) as u64;

            let mut max_skew = Duration::ZERO;
            let mut last = Duration::ZERO;
            for v in 0..total_frames {
                let wall = Duration::from_secs_f64(v as f64 * interval * 1.001);
                let camera_dur = Duration::from_secs_f64(v as f64 * interval);
                let out = video.calculate_timestamp(camera_dur, wall);
                assert!(out >= last, "video timeline must be monotonic");
                last = out;
                max_skew = max_skew.max(abs_skew(out, wall));
            }

            assert!(
                max_skew < Duration::from_millis(250),
                "video drifted from the wall clock by {max_skew:?} (correction failed)"
            );
        }

        // A static screen (or a capture-stream restart) stops frame delivery
        // entirely. The gap must survive into the output timeline: collapsing
        // it compresses video relative to audio and desyncs the recording.
        #[test]
        fn video_timeline_preserves_capture_gaps() {
            let mut video = VideoDriftTracker::new();
            let interval = 1.0 / 30.0;

            let mut outs = Vec::new();
            for v in 0..150u64 {
                let t = Duration::from_secs_f64(v as f64 * interval);
                outs.push(video.calculate_timestamp(t, t));
            }
            // 4s with no frames delivered, then delivery resumes with
            // timestamps that include the gap.
            for v in 150..300u64 {
                let t = Duration::from_secs_f64(v as f64 * interval + 4.0);
                outs.push(video.calculate_timestamp(t, t));
            }

            let gap = outs[150].saturating_sub(outs[149]);
            assert!(
                gap >= Duration::from_secs_f64(3.5),
                "capture gap collapsed to {gap:?} in the output timeline"
            );

            let span = outs[299].saturating_sub(outs[0]);
            let real = 299.0 * interval + 4.0;
            assert!(
                (span.as_secs_f64() - real).abs() < 0.3,
                "output span {span:?} does not match real elapsed time {real:.2}s"
            );
        }

        #[test]
        fn video_timestamp_span_reports_first_and_last_sent() {
            let span = VideoTimestampSpan::default();
            assert!(span.get().is_none(), "unset span must be None");

            span.record(Duration::from_millis(100));
            span.record(Duration::from_millis(133));
            span.record(Duration::from_millis(4000)); // across a capture gap

            let (first, last) = span.get().expect("span should be set");
            assert_eq!(first, Duration::from_millis(100));
            assert_eq!(last, Duration::from_millis(4000));
        }
    }
}
