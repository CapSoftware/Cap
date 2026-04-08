use crate::sources::audio_mixer::AudioMixer;
use anyhow::{Context, anyhow};
use cap_media_info::{AudioInfo, VideoInfo};
use cap_timestamp::{Timestamp, Timestamps};
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
        Arc,
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

const HEALTH_CHANNEL_CAPACITY: usize = 32;

pub(crate) enum BlockingThreadFinish {
    Clean,
    Failed(anyhow::Error),
    TimedOut(anyhow::Error),
}

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
    FrameDropRateHigh { rate_pct: f64 },
    AudioGapDetected { gap_ms: u64 },
    AudioDegradedToVideoOnly { reason: String },
    SourceRestarting,
    SourceRestarted,
}

pub type HealthSender = tokio::sync::mpsc::Sender<PipelineHealthEvent>;
pub type HealthReceiver = tokio::sync::mpsc::Receiver<PipelineHealthEvent>;

fn new_health_channel() -> (HealthSender, HealthReceiver) {
    tokio::sync::mpsc::channel(HEALTH_CHANNEL_CAPACITY)
}

pub fn emit_health(tx: &HealthSender, event: PipelineHealthEvent) {
    let _ = tx.try_send(event);
}

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

pub(crate) fn combine_finish_errors(
    primary: anyhow::Error,
    secondary: anyhow::Error,
) -> anyhow::Error {
    anyhow!("{primary:#}; {secondary:#}")
}

fn video_mux_send_error(frame_count: u64, error: anyhow::Error) -> anyhow::Error {
    anyhow!("Video muxer stopped accepting frames at frame {frame_count}: {error}")
}

struct AudioTimestampGenerator {
    sample_rate: u32,
    total_samples: u64,
}

const VIDEO_WALL_CLOCK_TOLERANCE_SECS: f64 = 0.1;

impl AudioTimestampGenerator {
    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            total_samples: 0,
        }
    }

    fn next_timestamp(&mut self, frame_samples: u64) -> Duration {
        let timestamp_nanos = if self.sample_rate == 0 {
            0u128
        } else {
            (self.total_samples as u128 * 1_000_000_000u128) / self.sample_rate as u128
        };
        self.total_samples += frame_samples;
        Duration::from_nanos(timestamp_nanos.min(u64::MAX as u128) as u64)
    }

    fn advance_by_duration(&mut self, duration: Duration) -> u64 {
        let samples = (duration.as_secs_f64() * self.sample_rate as f64).round() as u64;
        self.total_samples += samples;
        samples
    }
}

const WIRED_GAP_THRESHOLD: Duration = Duration::from_millis(70);
const WIRELESS_GAP_THRESHOLD: Duration = Duration::from_millis(160);
const MAX_SILENCE_INSERTION: Duration = Duration::from_secs(1);

struct AudioGapTracker {
    wall_clock_start: Option<Instant>,
    gap_threshold: Duration,
    total_silence_inserted: Duration,
    silence_insertion_count: u64,
    last_silence_log: Option<Instant>,
}

impl AudioGapTracker {
    fn new(has_wireless_source: bool) -> Self {
        Self {
            wall_clock_start: None,
            gap_threshold: if has_wireless_source {
                WIRELESS_GAP_THRESHOLD
            } else {
                WIRED_GAP_THRESHOLD
            },
            total_silence_inserted: Duration::ZERO,
            silence_insertion_count: 0,
            last_silence_log: None,
        }
    }

    fn mark_started(&mut self) {
        if self.wall_clock_start.is_none() {
            self.wall_clock_start = Some(Instant::now());
        }
    }

    fn detect_gap(
        &self,
        sample_based_elapsed: Duration,
        total_pause_duration: Duration,
    ) -> Option<Duration> {
        let wall_start = self.wall_clock_start?;
        let wall_elapsed = wall_start.elapsed().saturating_sub(total_pause_duration);

        if wall_elapsed <= sample_based_elapsed {
            return None;
        }

        let gap = wall_elapsed.saturating_sub(sample_based_elapsed);
        if gap > self.gap_threshold {
            Some(gap.min(MAX_SILENCE_INSERTION))
        } else {
            None
        }
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

struct VideoDriftTracker {
    baseline_offset_secs: Option<f64>,
    capped_frame_count: u64,
    drift_warning_logged: bool,
}

impl VideoDriftTracker {
    fn new() -> Self {
        Self {
            baseline_offset_secs: None,
            capped_frame_count: 0,
            drift_warning_logged: false,
        }
    }

    fn calculate_timestamp(
        &mut self,
        camera_duration: Duration,
        wall_clock_elapsed: Duration,
    ) -> Duration {
        let camera_secs = camera_duration.as_secs_f64();
        let wall_clock_secs = wall_clock_elapsed.as_secs_f64();
        let max_allowed_secs = wall_clock_secs + VIDEO_WALL_CLOCK_TOLERANCE_SECS;

        if wall_clock_secs < 2.0 || camera_secs < 2.0 {
            let result_secs = camera_secs.min(max_allowed_secs);
            if result_secs < camera_secs {
                self.capped_frame_count += 1;
            }
            return Duration::from_secs_f64(result_secs);
        }

        if self.baseline_offset_secs.is_none() {
            let offset = camera_secs - wall_clock_secs;
            debug!(
                wall_clock_secs,
                camera_secs,
                baseline_offset_secs = offset,
                "Capturing video baseline offset after warmup"
            );
            self.baseline_offset_secs = Some(offset);
        }

        let baseline = self.baseline_offset_secs.unwrap_or(0.0);
        let adjusted_camera_secs = (camera_secs - baseline).max(0.0);

        let drift_ratio = if adjusted_camera_secs > 0.0 {
            wall_clock_secs / adjusted_camera_secs
        } else {
            1.0
        };

        let corrected_secs = if !(0.95..=1.05).contains(&drift_ratio) {
            if !self.drift_warning_logged {
                warn!(
                    drift_ratio,
                    wall_clock_secs,
                    adjusted_camera_secs,
                    baseline,
                    "Extreme video clock drift detected after baseline correction, clamping"
                );
                self.drift_warning_logged = true;
            }
            let clamped_ratio = drift_ratio.clamp(0.95, 1.05);
            adjusted_camera_secs * clamped_ratio
        } else {
            adjusted_camera_secs * drift_ratio
        };

        let final_secs = corrected_secs.min(max_allowed_secs);
        if final_secs < corrected_secs {
            self.capped_frame_count += 1;
        }

        Duration::from_secs_f64(final_secs)
    }

    fn reset_baseline(&mut self) {
        self.baseline_offset_secs = None;
        self.drift_warning_logged = false;
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
                let result = self.handle_forward_jump(last, adjusted, jump_secs, now);
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
    ) -> Result<Duration, TimestampAnomalyError> {
        let wall_clock_confirmed = self.last_valid_wall_clock.is_some_and(|last_wc| {
            let wall_clock_gap_secs = now.duration_since(last_wc).as_secs_f64();
            wall_clock_gap_secs >= jump_secs * 0.5
        });

        self.total_forward_skew_secs += jump_secs;
        if jump_secs > self.max_forward_skew_secs {
            self.max_forward_skew_secs = jump_secs;
        }

        let expected_increment = Duration::from_millis(33);
        let adjusted = last.saturating_add(expected_increment);

        let compensation_secs = current.as_secs_f64() - adjusted.as_secs_f64();
        self.accumulated_compensation_secs -= compensation_secs;
        self.resync_count += 1;
        self.did_resync = true;

        if wall_clock_confirmed {
            let wall_clock_gap_secs = self
                .last_valid_wall_clock
                .map(|wc| now.duration_since(wc).as_secs_f64())
                .unwrap_or(0.0);

            self.wall_clock_confirmed_jumps += 1;

            info!(
                stream = self.stream_name,
                forward_secs = jump_secs,
                wall_clock_gap_secs = format!("{:.3}", wall_clock_gap_secs),
                last_valid_ms = last.as_millis(),
                current_ms = current.as_millis(),
                resync_count = self.resync_count,
                confirmed_jumps = self.wall_clock_confirmed_jumps,
                "Wall-clock-confirmed forward jump (system sleep/wake), accepting new baseline"
            );
        } else {
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
        OutputPipelineBuilder::<NoVideo> {
            path,
            video: NoVideo,
            audio_sources: vec![],
            timestamps: Timestamps::now(),
        }
    }
}

pub struct SetupCtx {
    tasks: TaskPool,
    health_tx: HealthSender,
}

impl SetupCtx {
    fn new(health_tx: HealthSender) -> Self {
        Self {
            tasks: TaskPool::default(),
            health_tx,
        }
    }

    pub fn tasks(&mut self) -> &mut TaskPool {
        &mut self.tasks
    }

    pub fn health_tx(&self) -> &HealthSender {
        &self.health_tx
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
            ..
        } = self;

        let build_ctx = BuildCtx::new();
        let mut setup_ctx = SetupCtx::new(build_ctx.health_tx.clone());

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
        );

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
            health_rx: Some(build_ctx.health_rx),
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
            ..
        } = self;

        if audio_sources.is_empty() {
            return Err(anyhow!("Invariant: No audio sources"));
        }

        let build_ctx = BuildCtx::new();
        let mut setup_ctx = SetupCtx::new(build_ctx.health_tx.clone());

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
            health_rx: Some(build_ctx.health_rx),
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
}

impl BuildCtx {
    pub fn new() -> Self {
        let stop_token = CancellationToken::new();

        let (done_tx, done_rx) = oneshot::channel();
        let (health_tx, health_rx) = new_health_channel();

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

            let _ = done_tx.send(resolve_pipeline_completion(res, muxer_res));
        }),
    );

    info!("Built pipeline for output {}", path.display());

    Ok(())
}

fn resolve_pipeline_completion(
    task_result: anyhow::Result<()>,
    muxer_result: anyhow::Result<anyhow::Result<()>>,
) -> anyhow::Result<()> {
    match (task_result, muxer_result) {
        (Err(error), _) | (_, Err(error)) => Err(error),
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
) {
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

                    if let Some(first_tx) = first_tx.take() {
                        let _ = first_tx.send(timestamp);
                    }

                    let raw_duration = match anomaly_tracker.process_timestamp(timestamp, timestamps) {
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
                            "Timeline resync detected, re-baselining drift tracker"
                        );
                        drift_tracker.reset_baseline();
                    }

                    let raw_wall_clock = timestamps.instant().elapsed();
                    let wall_clock_elapsed = raw_wall_clock.saturating_sub(total_pause_duration);
                    let duration = drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);

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
                            baseline_offset = drift_tracker.baseline_offset_secs,
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

                        if let Some(first_tx) = first_tx.take() {
                            let _ = first_tx.send(timestamp);
                        }

                        let raw_duration =
                            match anomaly_tracker.process_timestamp(timestamp, timestamps) {
                                Ok(d) => d,
                                Err(_) => {
                                    warn!("Timestamp anomaly during drain, skipping frame");
                                    skipped += 1;
                                    continue;
                                }
                            };

                        if anomaly_tracker.take_resync_flag() {
                            drift_tracker.reset_baseline();
                        }

                        let raw_wall_clock = timestamps.instant().elapsed();
                        let total_pause = shared_pause.total_pause_duration();
                        let wall_clock_elapsed = raw_wall_clock.saturating_sub(total_pause);
                        let duration =
                            drift_tracker.calculate_timestamp(raw_duration, wall_clock_elapsed);

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
        _timestamps: Timestamps,
        mut first_tx: Option<oneshot::Sender<Timestamp>>,
        shared_pause: SharedWallClockPause,
        has_video: bool,
    ) {
        let sample_rate = self.audio_info.sample_rate;
        let audio_info = self.audio_info;
        let has_wireless_source = self.has_wireless_source;
        let health_tx = setup_ctx.health_tx().clone();

        setup_ctx.tasks().spawn("mux-audio", {
            let stop_token = stop_token.child_token();
            let muxer = muxer.clone();
            async move {
                let mut timestamp_generator = AudioTimestampGenerator::new(sample_rate);
                let mut dropped_during_pause: u64 = 0;
                let mut frame_count: u64 = 0;
                let mut gap_tracker = AudioGapTracker::new(has_wireless_source);

                let res = stop_token
                    .run_until_cancelled(async {
                        while let Some(frame) = self.audio_rx.next().await {
                            let (is_paused, total_pause_duration) = shared_pause.check();

                            if is_paused {
                                dropped_during_pause += 1;
                                continue;
                            }

                            if let Some(first_tx) = first_tx.take() {
                                let _ = first_tx.send(frame.timestamp);
                            }

                            gap_tracker.mark_started();

                            let sample_based_before = timestamp_generator.next_timestamp(0);

                            if let Some(gap_duration) =
                                gap_tracker.detect_gap(sample_based_before, total_pause_duration)
                            {
                                let silence_samples =
                                    timestamp_generator.advance_by_duration(gap_duration);

                                if silence_samples > 0 {
                                    let silence =
                                        create_silence_frame(&audio_info, silence_samples as usize);

                                    let silence_frame = AudioFrame::new(silence, frame.timestamp);

                                    if gap_duration >= MAX_SILENCE_INSERTION {
                                        error!(
                                            gap_ms = gap_duration.as_millis(),
                                            "Audio gap exceeded 1s cap, \
                                             something may be seriously wrong"
                                        );
                                    }

                                    gap_tracker.record_insertion(gap_duration);

                                    emit_health(
                                        &health_tx,
                                        PipelineHealthEvent::AudioGapDetected {
                                            gap_ms: gap_duration.as_millis() as u64,
                                        },
                                    );

                                    if let Err(e) = muxer
                                        .lock()
                                        .await
                                        .send_audio_frame(silence_frame, sample_based_before)
                                    {
                                        if has_video {
                                            warn!(
                                                frame_count,
                                                "Audio muxer rejected silence frame, \
                                                 degrading to video-only: {e}"
                                            );
                                            emit_health(
                                                &health_tx,
                                                PipelineHealthEvent::AudioDegradedToVideoOnly {
                                                    reason: format!("Silence frame rejected at frame {frame_count}: {e}"),
                                                },
                                            );
                                            break;
                                        }
                                        return Err(anyhow!(
                                            "Audio muxer stopped accepting frames \
                                             at frame {frame_count}: {e}"
                                        ));
                                    }
                                }
                            }

                            let frame_samples = frame.inner.samples() as u64;
                            frame_count += 1;

                            let sample_based_timestamp =
                                timestamp_generator.next_timestamp(frame_samples);
                            let timestamp = sample_based_timestamp;

                            if frame_count.is_multiple_of(500) {
                                debug!(
                                    frame_count,
                                    sample_based_secs = sample_based_timestamp.as_secs_f64(),
                                    corrected_secs = timestamp.as_secs_f64(),
                                    total_samples = timestamp_generator.total_samples,
                                    total_pause_ms = total_pause_duration.as_millis(),
                                    silence_insertions = gap_tracker.silence_insertion_count,
                                    total_silence_ms =
                                        gap_tracker.total_silence_inserted.as_millis(),
                                    "Audio timestamp status"
                                );
                            }

                            if let Err(e) = muxer.lock().await.send_audio_frame(frame, timestamp) {
                                if has_video {
                                    warn!(
                                        frame_count,
                                        "Audio muxer rejected frame, \
                                         degrading to video-only: {e}"
                                    );
                                    emit_health(
                                        &health_tx,
                                        PipelineHealthEvent::AudioDegradedToVideoOnly {
                                            reason: format!("Frame rejected at frame {frame_count}: {e}"),
                                        },
                                    );
                                    break;
                                }
                                return Err(anyhow!(
                                    "Audio muxer stopped accepting frames \
                                     at frame {frame_count}: {e}"
                                ));
                            }
                        }
                        Ok::<(), anyhow::Error>(())
                    })
                    .await;

                let final_pause_duration = shared_pause.total_pause_duration();

                if dropped_during_pause > 0 {
                    debug!(
                        dropped_during_pause,
                        total_pause_ms = final_pause_duration.as_millis(),
                        "Audio frames dropped during pause (not counted in samples)"
                    );
                }

                if gap_tracker.silence_insertion_count > 0 {
                    info!(
                        silence_insertions = gap_tracker.silence_insertion_count,
                        total_silence_ms = gap_tracker.total_silence_inserted.as_millis(),
                        "Audio gap tracking summary at finish"
                    );
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
        let mut audio_mixer = AudioMixer::builder().with_timestamps(timestamps);
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
    health_rx: Option<HealthReceiver>,
}

pub struct FinishedOutputPipeline {
    pub path: PathBuf,
    pub first_timestamp: Timestamp,
    pub video_info: Option<VideoInfo>,
    pub video_frame_count: u64,
}

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

impl OutputPipeline {
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    pub async fn stop(mut self) -> anyhow::Result<FinishedOutputPipeline> {
        drop(self.stop_token.take());

        const PIPELINE_STOP_TIMEOUT: Duration = Duration::from_secs(10);
        match tokio::time::timeout(PIPELINE_STOP_TIMEOUT, self.done_fut.clone()).await {
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
                tracker.baseline_offset_secs.is_none(),
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

            assert!(tracker.baseline_offset_secs.is_some());
            let baseline = tracker.baseline_offset_secs.unwrap();
            assert!(
                (baseline - buffer_delay).abs() < 0.001,
                "Baseline should be ~{buffer_delay:.3}s, got {baseline:.3}s"
            );
        }

        #[test]
        fn baseline_removes_initial_offset() {
            let mut tracker = VideoDriftTracker::new();
            let buffer_delay = 0.05;

            let wall_clock_1 = dur(2.0);
            let camera_1 = dur(2.0 + buffer_delay);
            tracker.calculate_timestamp(camera_1, wall_clock_1);

            let wall_clock_2 = dur(10.0);
            let camera_2 = dur(10.0 + buffer_delay);
            let result = tracker.calculate_timestamp(camera_2, wall_clock_2);

            let expected = wall_clock_2;
            assert!(
                (result.as_secs_f64() - expected.as_secs_f64()).abs() < 0.1,
                "With baseline correction: expected ~{:.3}s, got {:.3}s",
                expected.as_secs_f64(),
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
        fn clamps_extreme_drift() {
            let mut tracker = VideoDriftTracker::new();

            tracker.calculate_timestamp(dur(2.0), dur(2.0));

            let camera = dur(100.0);
            let wall_clock = dur(80.0);
            let result = tracker.calculate_timestamp(camera, wall_clock);
            let max_allowed = 80.0 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
            assert!(
                result.as_secs_f64() <= max_allowed + 0.001,
                "Expected result to be capped at ~{:.3}s, got {:.3}s",
                max_allowed,
                result.as_secs_f64()
            );
            assert!(
                tracker.capped_frame_count() > 0,
                "Should have capped at least one frame"
            );
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
            let first_baseline = tracker.baseline_offset_secs;

            tracker.calculate_timestamp(dur(10.1), dur(10.0));

            assert_eq!(
                first_baseline, tracker.baseline_offset_secs,
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
        fn caps_to_wall_clock_after_warmup() {
            let mut tracker = VideoDriftTracker::new();
            tracker.calculate_timestamp(dur(2.0), dur(2.0));

            let wall_clock = dur(5.0);
            let camera_duration = dur(5.5);
            let result = tracker.calculate_timestamp(camera_duration, wall_clock);
            let max_allowed = 5.0 + VIDEO_WALL_CLOCK_TOLERANCE_SECS;
            assert!(
                result.as_secs_f64() <= max_allowed + 0.001,
                "After warmup: expected ~{:.3}s (capped), got {:.3}s",
                max_allowed,
                result.as_secs_f64()
            );
            assert!(
                tracker.capped_frame_count() > 0,
                "Should have capped at least one frame"
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
                tracker.process_timestamp(ts, timestamps).unwrap();
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
                tracker.process_timestamp(ts, timestamps).unwrap();
            }

            assert_eq!(tracker.anomaly_count, 0);

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            tracker.process_timestamp(jump_ts, timestamps).unwrap();

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
                tracker.process_timestamp(ts, timestamps).unwrap();
            }

            assert_eq!(tracker.anomaly_count, 0);

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            tracker.process_timestamp(jump_ts, timestamps).unwrap();

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
                tracker.process_timestamp(ts, timestamps).unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000));
            tracker.process_timestamp(jump_ts, timestamps).unwrap();

            assert!(
                tracker.take_resync_flag(),
                "Resync flag should be set after wall-clock-confirmed jump"
            );

            let next_ts =
                make_timestamp(timestamps, Duration::from_millis(4 * 33 + 3000 + 33 + 3000));
            tracker.process_timestamp(next_ts, timestamps).unwrap();

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
                tracker.process_timestamp(ts, timestamps).unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump1 = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000));
            tracker.process_timestamp(jump1, timestamps).unwrap();
            tracker.take_resync_flag();

            let normal = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000 + 33));
            tracker.process_timestamp(normal, timestamps).unwrap();

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(5));

            let jump2 =
                make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000 + 66 + 5000));
            tracker.process_timestamp(jump2, timestamps).unwrap();

            assert_eq!(tracker.anomaly_count, 0);
            assert_eq!(tracker.wall_clock_confirmed_jumps, 2);
            assert_eq!(tracker.resync_count, 2);
        }

        #[test]
        fn wall_clock_start_set_on_first_frame() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            assert!(tracker.wall_clock_start.is_none());

            let ts = make_timestamp(timestamps, Duration::ZERO);
            tracker.process_timestamp(ts, timestamps).unwrap();

            assert!(tracker.wall_clock_start.is_some());
        }

        #[test]
        fn confirmed_jump_still_tracks_forward_skew() {
            let mut tracker = TimestampAnomalyTracker::new("test");
            let timestamps = make_timestamps();

            for i in 0..3u64 {
                let ts = make_timestamp(timestamps, Duration::from_millis(i * 33));
                tracker.process_timestamp(ts, timestamps).unwrap();
            }

            tracker.last_valid_wall_clock = Instant::now().checked_sub(Duration::from_secs(3));

            let jump_ts = make_timestamp(timestamps, Duration::from_millis(2 * 33 + 3000));
            tracker.process_timestamp(jump_ts, timestamps).unwrap();

            assert_eq!(tracker.wall_clock_confirmed_jumps, 1);
            assert_eq!(tracker.anomaly_count, 0);
            assert!(tracker.total_forward_skew_secs > 2.0);
        }
    }

    mod finish_build {
        use super::*;

        #[test]
        fn treats_inner_muxer_finish_error_as_failure() {
            let result = resolve_pipeline_completion(
                Ok(()),
                Ok(Err(anyhow!("fragmented audio trailer write failed"))),
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
            let result =
                resolve_pipeline_completion(Err(anyhow!("capture-video failed")), Ok(Ok(())));

            let error = result.expect_err("task failure should fail the pipeline");
            assert!(
                error.to_string().contains("capture-video failed"),
                "error should include the task failure reason"
            );
        }

        #[test]
        fn succeeds_only_when_tasks_and_muxer_finish_succeed() {
            resolve_pipeline_completion(Ok(()), Ok(Ok(())))
                .expect("pipeline should succeed when all work succeeds");
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
            let handle = std::thread::spawn(|| {
                std::thread::sleep(Duration::from_millis(100));
                Ok(())
            });

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
}
