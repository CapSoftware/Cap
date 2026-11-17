use anyhow::Context as _;
use cap_media_info::AudioInfo;
use cap_timestamp::{MasterClock, SourceClockOutcome, SourceClockState, Timestamp, Timestamps};
use futures::StreamExt as _;
use futures::channel::{mpsc, oneshot};
use std::time::Instant;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use tracing::{debug, info, warn};

use crate::output_pipeline::{
    AudioFrame, HealthSender, PipelineHealthEvent, emit_health, trim_audio_frame_front,
};

const DEFAULT_BUFFER_TIMEOUT: Duration = Duration::from_millis(100);
const MIN_BUFFER_TIMEOUT_WIRED: Duration = Duration::from_millis(20);
const MIN_BUFFER_TIMEOUT_WIRELESS: Duration = Duration::from_millis(90);
const MAX_BUFFER_TIMEOUT: Duration = Duration::from_millis(250);
const BUFFER_TIMEOUT_HEADROOM: f64 = 2.5;
const STARTUP_GRACE: Duration = Duration::from_secs(1);
pub(crate) const MIXER_STOP_TIMEOUT: Duration = Duration::from_secs(2);

pub const MAX_BUFFERING_TICKS: u32 = 45;
pub const AUDIO_OUTPUT_FRAMES: u32 = cap_timestamp::AUDIO_OUTPUT_FRAMES as u32;
pub const DEFAULT_SAMPLE_RATE: u32 = cap_timestamp::DEFAULT_SAMPLE_RATE;
pub const MAX_BUFFERING_MS: u64 =
    (MAX_BUFFERING_TICKS as u64 * AUDIO_OUTPUT_FRAMES as u64 * 1000) / DEFAULT_SAMPLE_RATE as u64;
pub const FORCED_RESET_MS: u64 = MAX_BUFFERING_MS * 2;
const STALL_RECOVER_LOG_INTERVAL: Duration = Duration::from_secs(5);

struct MixerSource {
    rx: mpsc::Receiver<AudioFrame>,
    info: AudioInfo,
    buffer_timeout: Duration,
    buffer: VecDeque<AudioFrame>,
    buffer_last: Option<(Timestamp, Duration)>,
    last_input_timestamp: Option<Timestamp>,
    clock_state: SourceClockState,
    samples_supplied: usize,
    late_samples_dropped: u64,
    ended: bool,
}

pub struct AudioMixerBuilder {
    sources: Vec<MixerSource>,
    timestamps: Option<Timestamps>,
    master_clock: Option<Arc<MasterClock>>,
    health_tx: Option<HealthSender>,
    required_stop: Option<CancellationToken>,
}

impl Default for AudioMixerBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioMixerBuilder {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
            timestamps: None,
            master_clock: None,
            health_tx: None,
            required_stop: None,
        }
    }

    pub fn with_timestamps(mut self, timestamps: Timestamps) -> Self {
        self.timestamps = Some(timestamps);
        self
    }

    pub fn with_master_clock(mut self, master_clock: Arc<MasterClock>) -> Self {
        self.master_clock = Some(master_clock);
        self
    }

    pub fn with_health_tx(mut self, health_tx: HealthSender) -> Self {
        self.health_tx = Some(health_tx);
        self
    }

    pub(crate) fn with_required_inputs(mut self, stop: CancellationToken) -> Self {
        self.required_stop = Some(stop);
        self
    }

    pub fn has_sources(&self) -> bool {
        !self.sources.is_empty()
    }

    pub fn add_source(&mut self, info: AudioInfo, rx: mpsc::Receiver<AudioFrame>) {
        let buffer_timeout = buffer_timeout_for(&info);
        let clock_label = mixer_source_label(self.sources.len());

        self.sources.push(MixerSource {
            info,
            rx,
            buffer_timeout,
            buffer: VecDeque::new(),
            buffer_last: None,
            last_input_timestamp: None,
            clock_state: SourceClockState::new(clock_label),
            samples_supplied: 0,
            late_samples_dropped: 0,
            ended: false,
        });
    }

    pub fn build(self, output: mpsc::Sender<AudioFrame>) -> Result<AudioMixer, ffmpeg::Error> {
        let infos: Vec<AudioInfo> = self.sources.iter().map(|s| s.info).collect();
        let graph = construct_filter_graph(&infos)?;

        let max_buffer_timeout = self
            .sources
            .iter()
            .map(|source| source.buffer_timeout)
            .max()
            .unwrap_or(DEFAULT_BUFFER_TIMEOUT);

        let timestamps = self.timestamps.unwrap_or_else(Timestamps::now);
        let master_clock = self
            .master_clock
            .unwrap_or_else(|| MasterClock::new(timestamps, AudioMixer::INFO.rate() as u32));

        Ok(AudioMixer {
            sources: self.sources,
            samples_out: 0,
            last_tick: None,
            abuffers: graph.abuffers,
            abuffersink: graph.abuffersink,
            output,
            _resamplers: graph.resamplers,
            _filter_graph: graph.filter_graph,
            _amix: graph.amix,
            _aformat: graph.aformat,
            start_timestamp: None,
            timestamps,
            max_buffer_timeout,
            wall_clock_start: None,
            master_clock,
            buffering: MixerBufferingTracker::new(),
            health_tx: self.health_tx,
            required_stop: self.required_stop,
            drain_deadline: None,
            finishing: false,
            input_waker: std::task::Waker::noop().clone(),
        })
    }

    pub fn run(
        self,
        output: mpsc::Sender<AudioFrame>,
        ready_tx: oneshot::Sender<anyhow::Result<()>>,
        stop_flag: Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        let start = Timestamps::now();

        let mut mixer = match self.build(output) {
            Ok(mixer) => mixer,
            Err(e) => {
                tracing::error!("Failed to build audio mixer: {}", e);
                let message = format!("Failed to build audio mixer: {e}");
                let _ = ready_tx.send(Err(anyhow::anyhow!(message.clone())));
                return Err(anyhow::anyhow!(message));
            }
        };

        let _ = ready_tx.send(Ok(()));
        mixer.input_waker = std::task::Waker::from(Arc::new(ThreadUnpark(std::thread::current())));

        loop {
            if stop_flag.load(Ordering::Relaxed)
                || mixer
                    .required_stop
                    .as_ref()
                    .is_some_and(CancellationToken::is_cancelled)
            {
                info!("Mixer stop flag triggered");
                mixer.finish()?;
                break;
            }

            let now = mixer_now();

            if !mixer.tick(start, now)? {
                info!("Mixer output closed");
                break;
            }

            std::thread::park_timeout(mixer.idle_wait());
        }
        for source in &mixer.sources {
            if source.late_samples_dropped > 0 {
                info!(
                    source = source.clock_state.name(),
                    late_samples_dropped = source.late_samples_dropped,
                    "AudioMixer: late input sample count"
                );
            }
        }
        Ok(())
    }
}

pub struct AudioMixer {
    sources: Vec<MixerSource>,
    samples_out: usize,
    output: mpsc::Sender<AudioFrame>,
    last_tick: Option<Timestamp>,
    abuffers: Vec<ffmpeg::filter::Context>,
    abuffersink: ffmpeg::filter::Context,
    _resamplers: Vec<ffmpeg::filter::Context>,
    _filter_graph: ffmpeg::filter::Graph,
    _amix: ffmpeg::filter::Context,
    _aformat: ffmpeg::filter::Context,
    timestamps: Timestamps,
    start_timestamp: Option<Timestamp>,
    max_buffer_timeout: Duration,
    wall_clock_start: Option<Timestamp>,
    master_clock: Arc<MasterClock>,
    buffering: MixerBufferingTracker,
    health_tx: Option<HealthSender>,
    required_stop: Option<CancellationToken>,
    drain_deadline: Option<Instant>,
    finishing: bool,
    input_waker: std::task::Waker,
}

#[derive(Debug, Clone)]
pub enum MixerBufferingAction {
    ForceReset {
        source: &'static str,
        starvation_ms: u64,
    },
}

#[derive(Debug)]
pub struct MixerBufferingTracker {
    stall_started_at: Option<Instant>,
    last_stall_emit_at: Option<Instant>,
    emitted_for_current_stall: bool,
    forced_reset_fired_for_current_stall: bool,
    total_stall_events: u64,
    total_ignored_tick_events: u64,
    laggard_source: Option<&'static str>,
}

impl MixerBufferingTracker {
    pub fn new() -> Self {
        Self {
            stall_started_at: None,
            last_stall_emit_at: None,
            emitted_for_current_stall: false,
            forced_reset_fired_for_current_stall: false,
            total_stall_events: 0,
            total_ignored_tick_events: 0,
            laggard_source: None,
        }
    }

    pub fn observe(
        &mut self,
        now: Instant,
        laggard: Option<&'static str>,
        health_tx: Option<&HealthSender>,
    ) -> Option<MixerBufferingAction> {
        match laggard {
            Some(source) => {
                if self.stall_started_at.is_none() {
                    self.stall_started_at = Some(now);
                    self.emitted_for_current_stall = false;
                    self.forced_reset_fired_for_current_stall = false;
                }
                self.laggard_source = Some(source);

                let waited = now
                    .checked_duration_since(self.stall_started_at.unwrap_or(now))
                    .unwrap_or_default();

                if !self.emitted_for_current_stall
                    && waited >= Duration::from_millis(MAX_BUFFERING_MS)
                {
                    self.emitted_for_current_stall = true;
                    self.total_stall_events += 1;
                    self.last_stall_emit_at = Some(now);
                    warn!(
                        source = source,
                        waited_ms = waited.as_millis() as u64,
                        total_stalls = self.total_stall_events,
                        "AudioMixer: laggard source exceeded max buffering window, stalling mixer"
                    );
                    if let Some(tx) = health_tx {
                        emit_health(
                            tx,
                            PipelineHealthEvent::Stalled {
                                source: format!("mixer:{source}"),
                                waited_ms: waited.as_millis() as u64,
                            },
                        );
                    }
                }

                if !self.forced_reset_fired_for_current_stall
                    && waited >= Duration::from_millis(FORCED_RESET_MS)
                {
                    self.forced_reset_fired_for_current_stall = true;
                    return Some(MixerBufferingAction::ForceReset {
                        source,
                        starvation_ms: waited.as_millis() as u64,
                    });
                }
                None
            }
            None => {
                if let (Some(started), Some(source)) =
                    (self.stall_started_at.take(), self.laggard_source.take())
                {
                    let waited = now.checked_duration_since(started).unwrap_or_default();
                    if self.emitted_for_current_stall {
                        info!(
                            source = source,
                            waited_ms = waited.as_millis() as u64,
                            "AudioMixer: laggard source caught up"
                        );
                    } else {
                        let should_log = self
                            .last_stall_emit_at
                            .map(|t| now.duration_since(t) > STALL_RECOVER_LOG_INTERVAL)
                            .unwrap_or(true);
                        if should_log {
                            debug!(
                                source = source,
                                waited_ms = waited.as_millis() as u64,
                                "AudioMixer: brief source buffering below threshold"
                            );
                        }
                    }
                    self.emitted_for_current_stall = false;
                    self.forced_reset_fired_for_current_stall = false;
                }
                None
            }
        }
    }

    pub fn record_forced_ignore(&mut self, source: &'static str) {
        self.total_ignored_tick_events += 1;
        warn!(
            source = source,
            total_ignored = self.total_ignored_tick_events,
            "AudioMixer: laggard source exceeded hard ceiling, forcibly inserting silence"
        );
    }

    pub fn total_stall_events(&self) -> u64 {
        self.total_stall_events
    }

    pub fn total_ignored_tick_events(&self) -> u64 {
        self.total_ignored_tick_events
    }
}

impl Default for MixerBufferingTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioMixer {
    pub const INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::F32(cap_media_info::Type::Packed),
        48_000,
        2,
    );

    fn detect_laggard_source(&self, now: Timestamp) -> Option<&'static str> {
        let start_timestamp = self.start_timestamp?;
        let elapsed = now
            .duration_since(self.timestamps)
            .checked_sub(start_timestamp.duration_since(self.timestamps))?;
        if elapsed < self.max_buffer_timeout {
            return None;
        }

        for source in &self.sources {
            if source.buffer_last.is_none() && source.last_input_timestamp.is_none() {
                return Some(source.clock_state.name());
            }

            if let Some((buffer_last_ts, buffer_last_dur)) = source.buffer_last {
                let last_elapsed = buffer_last_ts.duration_since(self.timestamps);
                let start_elapsed = start_timestamp.duration_since(self.timestamps);
                let from_start = last_elapsed.saturating_sub(start_elapsed);
                let projected = from_start.saturating_add(buffer_last_dur);
                if let Some(gap) = elapsed.checked_sub(projected)
                    && gap > source.buffer_timeout.saturating_mul(2)
                {
                    return Some(source.clock_state.name());
                }
            }
        }
        None
    }

    fn handle_source_format_change(
        &mut self,
        index: usize,
        old_info: AudioInfo,
        new_info: AudioInfo,
    ) -> anyhow::Result<()> {
        let label = self
            .sources
            .get(index)
            .map(|s| s.clock_state.name())
            .unwrap_or("<missing>");

        warn!(
            source = label,
            index = index,
            old_rate = old_info.rate(),
            old_channels = old_info.channels,
            old_fmt = %old_info.sample_format.name(),
            new_rate = new_info.rate(),
            new_channels = new_info.channels,
            new_fmt = %new_info.sample_format.name(),
            "AudioMixer: source audio format changed mid-recording; rebuilding filter graph"
        );

        let infos: Vec<AudioInfo> = self.sources.iter().map(|s| s.info).collect();
        match construct_filter_graph(&infos) {
            Ok(graph) => {
                self.abuffers = graph.abuffers;
                self._resamplers = graph.resamplers;
                self._amix = graph.amix;
                self._aformat = graph.aformat;
                self.abuffersink = graph.abuffersink;
                self._filter_graph = graph.filter_graph;
                for source in &mut self.sources {
                    source.samples_supplied =
                        (self.samples_out as u128 * source.info.sample_rate as u128
                            / Self::INFO.sample_rate as u128) as usize;
                }
                self.max_buffer_timeout = self
                    .sources
                    .iter()
                    .map(|s| s.buffer_timeout)
                    .max()
                    .unwrap_or(DEFAULT_BUFFER_TIMEOUT);

                if let Some(tx) = &self.health_tx {
                    emit_health(
                        tx,
                        PipelineHealthEvent::SourceAudioReset {
                            source: label.to_string(),
                            starvation_ms: 0,
                        },
                    );
                }
            }
            Err(e) => {
                tracing::error!(
                    source = label,
                    error = %e,
                    "AudioMixer: failed to rebuild filter graph after source format change"
                );
                if self.required_stop.is_some() {
                    return Err(e).with_context(|| {
                        format!("Audio mixer source {index} filter rebuild failed")
                    });
                }
            }
        }
        Ok(())
    }

    fn force_reset_source(&mut self, source_label: &'static str, starvation_ms: u64) {
        let mut reset_any = false;
        for source in &mut self.sources {
            if source.clock_state.name() == source_label {
                source.clock_state.reset();
                source.buffer.clear();
                source.buffer_last = None;
                source.last_input_timestamp = None;
                reset_any = true;
                break;
            }
        }

        if reset_any {
            self.buffering.record_forced_ignore(source_label);
            if let Some(tx) = &self.health_tx {
                emit_health(
                    tx,
                    PipelineHealthEvent::SourceAudioReset {
                        source: source_label.to_string(),
                        starvation_ms,
                    },
                );
            }
        }
    }

    fn sample_based_output_timestamp(&self, start_timestamp: Timestamp) -> Timestamp {
        let rate = self.master_clock.sample_rate().max(1) as u64;
        let nanos = (self.samples_out as u128 * 1_000_000_000u128) / rate as u128;
        let clamped = if nanos > u64::MAX as u128 {
            u64::MAX
        } else {
            nanos as u64
        };
        start_timestamp + Duration::from_nanos(clamped)
    }

    fn buffer_sources(&mut self, now: Timestamp) -> anyhow::Result<()> {
        let mut format_change: Option<(usize, AudioInfo, AudioInfo)> = None;
        let clock_anchor = self.master_clock.timestamps().instant();
        let waker = self.input_waker.clone();
        let mut input_context = std::task::Context::from_waker(&waker);
        for (index, source) in self.sources.iter_mut().enumerate() {
            let rate = source.info.rate();

            loop {
                if self
                    .drain_deadline
                    .is_some_and(|deadline| Instant::now() >= deadline)
                {
                    source.rx.close();
                }
                let AudioFrame {
                    inner: frame,
                    timestamp: raw_timestamp,
                } = match source.rx.poll_next_unpin(&mut input_context) {
                    std::task::Poll::Ready(Some(frame)) => frame,
                    std::task::Poll::Ready(None) => {
                        source.ended = true;
                        anyhow::ensure!(
                            self.required_stop
                                .as_ref()
                                .is_none_or(|stop| stop.is_cancelled()),
                            "Required audio mixer source {index} closed while capture was active"
                        );
                        break;
                    }
                    std::task::Poll::Pending => break,
                };
                source.last_input_timestamp = Some(raw_timestamp);

                if format_change.is_none()
                    && let Some(new_info) = detect_format_mismatch(&source.info, &frame)
                {
                    let old_info = source.info;
                    format_change = Some((index, old_info, new_info));
                    source.info = new_info;
                    source.buffer_timeout = buffer_timeout_for(&new_info);
                    source.buffer.clear();
                    source.buffer_last = None;
                    source.last_input_timestamp = Some(raw_timestamp);
                    source
                        .buffer
                        .push_back(AudioFrame::new(frame, raw_timestamp));
                    break;
                }

                let frame_samples = frame.samples() as u64;
                let frame_duration_ns = if rate > 0 {
                    (frame_samples as u128 * 1_000_000_000u128 / rate as u128).min(u64::MAX as u128)
                        as u64
                } else {
                    0
                };

                let remap = source.clock_state.remap_preserving_cadence(
                    &self.master_clock,
                    raw_timestamp,
                    frame_duration_ns,
                );

                if matches!(remap.outcome, SourceClockOutcome::HardReset) {
                    let flushed = source.buffer.len();
                    warn!(
                        source = source.clock_state.name(),
                        hard_resets = source.clock_state.hard_reset_count(),
                        flushed_frames = flushed,
                        "AudioMixer: source clock hard-reset (>2s jump), flushing queued frames"
                    );
                    source.buffer_last = None;
                    source.buffer.clear();
                    source.last_input_timestamp = None;
                }

                // The remap clamps a packet captured before the master clock's
                // origin to the origin. Drop only the samples that precede it,
                // so the rest of the packet keeps its capture time instead of
                // overlapping the next packet.
                let (frame, master_ns, frame_duration_ns) = if remap.master_ns == 0
                    && remap.raw_ns < 0
                    && rate > 0
                {
                    let before_ns = u128::from(remap.raw_ns.unsigned_abs());
                    let before = (before_ns * rate as u128).div_ceil(1_000_000_000) as usize;
                    let Some(kept) = trim_audio_frame_front(&frame, before) else {
                        continue;
                    };
                    let first_ns = (before as u128 * 1_000_000_000 / rate as u128)
                        .saturating_sub(before_ns) as u64;
                    let kept_ns = (kept.samples() as u128 * 1_000_000_000 / rate as u128) as u64;
                    (kept, first_ns, kept_ns)
                } else {
                    (frame, remap.master_ns, frame_duration_ns)
                };

                let timestamp = Timestamp::Instant(clock_anchor + Duration::from_nanos(master_ns));

                source.buffer_last = Some((timestamp, Duration::from_nanos(frame_duration_ns)));
                source.buffer.push_back(AudioFrame::new(frame, timestamp));
            }
        }

        if let Some((index, old_info, new_info)) = format_change {
            self.handle_source_format_change(index, old_info, new_info)?;
        }

        if self.samples_out == 0
            && self
                .sources
                .iter()
                .all(|source| source.samples_supplied == 0)
        {
            let earliest = self
                .sources
                .iter()
                .filter_map(|s| s.buffer.front())
                .min_by(|a, b| {
                    a.timestamp
                        .duration_since(self.timestamps)
                        .cmp(&b.timestamp.duration_since(self.timestamps))
                })
                .map(|v| v.timestamp);

            if let Some(earliest) = earliest {
                self.start_timestamp = Some(earliest);
                self.wall_clock_start = Some(now);
            }
        }

        Ok(())
    }

    fn tick(&mut self, _start: Timestamps, now: Timestamp) -> anyhow::Result<bool> {
        self.tick_with_output(now, |sink, frame| sink.sink().frame(frame))
    }

    #[cfg(test)]
    pub(crate) fn tick_for_capture_pause(&mut self, now: Instant) -> anyhow::Result<bool> {
        self.tick(self.timestamps, Timestamp::Instant(now))
    }

    #[cfg(test)]
    pub(crate) fn finish_for_capture_pause(&mut self) -> anyhow::Result<()> {
        self.finish()
    }

    fn finish(&mut self) -> anyhow::Result<()> {
        if let Some(stop) = &self.required_stop {
            stop.cancel();
        }
        self.drain_deadline = Some(Instant::now() + STARTUP_GRACE);
        loop {
            self.buffer_sources(mixer_now())?;
            if self.sources.iter().all(|source| source.ended) {
                break;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        self.finishing = true;
        self.drain_deadline = Some(Instant::now() + STARTUP_GRACE);
        if !self.tick(self.timestamps, mixer_now())? {
            return Ok(());
        }
        for input in &mut self.abuffers {
            input.source().flush().context("Audio mixer flush failed")?;
        }
        self.tick(self.timestamps, mixer_now())?;
        Ok(())
    }

    fn tick_with_output(
        &mut self,
        now: Timestamp,
        mut read: impl FnMut(
            &mut ffmpeg::filter::Context,
            &mut ffmpeg::frame::Audio,
        ) -> Result<(), ffmpeg::Error>,
    ) -> anyhow::Result<bool> {
        self.buffer_sources(now)?;

        let Some(start_timestamp) = self.start_timestamp else {
            return Ok(true);
        };

        let wall_now = Instant::now();
        let laggard = if self.finishing {
            None
        } else {
            self.detect_laggard_source(now)
        };
        let action = self
            .buffering
            .observe(wall_now, laggard, self.health_tx.as_ref());

        if let Some(MixerBufferingAction::ForceReset {
            source,
            starvation_ms,
        }) = action
        {
            self.force_reset_source(source, starvation_ms);
        }

        let grace_elapsed = now
            .duration_since(self.timestamps)
            .saturating_sub(start_timestamp.duration_since(self.timestamps))
            >= STARTUP_GRACE;
        let mut watermark = None;
        let mut waiting_for_input = false;
        for source in &self.sources {
            if let Some((timestamp, duration)) = source.buffer_last {
                let end = timestamp + duration;
                if watermark.is_none_or(|previous: Timestamp| {
                    let end = end.duration_since(self.timestamps);
                    let previous = previous.duration_since(self.timestamps);
                    if self.finishing {
                        end > previous
                    } else {
                        end < previous
                    }
                }) {
                    watermark = Some(end);
                }
            } else if !grace_elapsed && !self.finishing {
                waiting_for_input = true;
            }
        }

        if let Some(watermark) = watermark.filter(|_| !waiting_for_input) {
            for (i, source) in self.sources.iter_mut().enumerate() {
                let rate = source.info.rate();
                let limit = sample_position(watermark, start_timestamp, self.timestamps, rate)
                    .max(0) as usize;
                while let Some(mut buffer) = source.buffer.pop_front() {
                    let position =
                        sample_position(buffer.timestamp, start_timestamp, self.timestamps, rate);
                    let correction = placement_correction(
                        position - source.samples_supplied as i128,
                        source.info.sample_rate,
                        buffer.inner.samples(),
                    );
                    let overlap = (-correction).max(0) as usize;
                    if overlap > 0 {
                        let dropped = overlap.min(buffer.inner.samples());
                        if source.late_samples_dropped == 0 {
                            warn!(
                                source = source.clock_state.name(),
                                dropped_samples = dropped,
                                "AudioMixer: dropping input samples that arrived after their time was committed"
                            );
                        }
                        source.late_samples_dropped =
                            source.late_samples_dropped.saturating_add(dropped as u64);
                        if dropped == buffer.inner.samples() {
                            continue;
                        }
                        buffer.inner = trim_audio_frame_front(&buffer.inner, dropped)
                            .context("Audio mixer input overlap trim failed")?;
                        buffer.timestamp = start_timestamp
                            + samples_duration(source.samples_supplied, source.info.sample_rate);
                    }
                    let gap_end = (source.samples_supplied + correction.max(0) as usize).min(limit);
                    supply_silence(source, &mut self.abuffers[i], i, gap_end)?;
                    if source.samples_supplied >= limit {
                        source.buffer.push_front(buffer);
                        break;
                    }
                    let samples = buffer.inner.samples().min(limit - source.samples_supplied);
                    if samples < buffer.inner.samples() {
                        let remaining = trim_audio_frame_front(&buffer.inner, samples)
                            .context("Audio mixer watermark split failed")?;
                        source.buffer.push_front(AudioFrame::new(
                            remaining,
                            start_timestamp
                                + samples_duration(
                                    source.samples_supplied + samples,
                                    source.info.sample_rate,
                                ),
                        ));
                        buffer.inner.set_samples(samples);
                    }
                    let result = self.abuffers[i].source().add(&buffer.inner);
                    if self.required_stop.is_some() {
                        result.with_context(|| {
                            format!("Audio mixer source {i} filter input failed")
                        })?;
                    }
                    source.samples_supplied += samples;
                }
                if source.buffer_last.is_none() || self.finishing {
                    supply_silence(source, &mut self.abuffers[i], i, limit)?;
                }
            }
        }

        let mut filtered = ffmpeg::frame::Audio::empty();
        loop {
            match read(&mut self.abuffersink, &mut filtered) {
                Ok(()) => {}
                Err(ffmpeg::Error::Eof) => {
                    anyhow::ensure!(
                        self.required_stop
                            .as_ref()
                            .is_none_or(|stop| stop.is_cancelled()),
                        "Required audio mixer filter ended while capture was active"
                    );
                    break;
                }
                Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN => break,
                Err(error) if self.required_stop.is_some() => {
                    return Err(error).context("Audio mixer filter output failed");
                }
                Err(_) => break,
            }
            let output_rate_i32 = Self::INFO.rate();

            filtered.set_rate(output_rate_i32 as u32);

            let output_timestamp = self.sample_based_output_timestamp(start_timestamp);

            let frame_samples = filtered.samples();
            let mut frame = AudioFrame::new(filtered, output_timestamp);

            loop {
                match self.output.try_send(frame) {
                    Ok(()) => break,
                    Err(err) if err.is_full() => {
                        // At stop, a consumer that stopped draining costs the
                        // audio not yet delivered, never the recording.
                        if self
                            .drain_deadline
                            .is_some_and(|deadline| Instant::now() >= deadline)
                        {
                            warn!(
                                "Audio mixer output did not drain before the stop deadline; dropping the rest"
                            );
                            return Ok(false);
                        }
                        frame = err.into_inner();
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => return Ok(false),
                }
            }

            self.samples_out += frame_samples;
            filtered = ffmpeg::frame::Audio::empty();
        }

        self.last_tick = Some(now);

        Ok(true)
    }

    pub fn builder() -> AudioMixerBuilder {
        AudioMixerBuilder::new()
    }

    /// How long the run loop sleeps when no input arrives first: half the
    /// shortest source buffer timeout, so a source that went quiet is still
    /// filled with silence on time, while arriving input wakes it at once.
    fn idle_wait(&self) -> Duration {
        idle_wait_for(self.sources.iter().map(|source| source.buffer_timeout))
    }
}

fn mixer_now() -> Timestamp {
    #[cfg(target_os = "macos")]
    {
        Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::now())
    }
    #[cfg(windows)]
    {
        Timestamp::PerformanceCounter(cap_timestamp::PerformanceCounterTimestamp::now())
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Timestamp::Instant(Instant::now())
    }
}

/// Input timestamps jitter around their sample clock (Linux stamps samples
/// with their receipt time) and drift from the host clock by a few parts per
/// million. Within this tolerance a packet continues the source's samples
/// untouched.
const PLACEMENT_JITTER_TOLERANCE: Duration = Duration::from_millis(2);
/// A packet this far from where the source's samples have reached starts at
/// its capture time: a real gap is filled with silence, input that arrived
/// after its time was committed is dropped.
const PLACEMENT_REALIGN_THRESHOLD: Duration = Duration::from_millis(10);

/// Samples to add (silence, positive) or drop (negative) before a packet
/// of `packet` samples whose capture time lies `drift` samples after the
/// source's supplied samples. Between the tolerance and the realign
/// threshold the source moves by at most one sample per 256 (a 0.4% rate
/// change), so clock drift never causes an audible jump.
fn placement_correction(drift: i128, rate: u32, packet: usize) -> i128 {
    let samples =
        |duration: Duration| duration.as_nanos() as i128 * i128::from(rate) / 1_000_000_000;
    let tolerance = samples(PLACEMENT_JITTER_TOLERANCE);
    if drift.abs() >= samples(PLACEMENT_REALIGN_THRESHOLD) {
        drift
    } else if drift.abs() > tolerance {
        let step = (packet as i128 / 256).max(1);
        drift.signum() * (drift.abs() - tolerance).min(step)
    } else {
        0
    }
}

fn samples_duration(samples: usize, rate: u32) -> Duration {
    Duration::from_nanos((samples as u128 * 1_000_000_000 / u128::from(rate)) as u64)
}

fn supply_silence(
    source: &mut MixerSource,
    input: &mut ffmpeg::filter::Context,
    index: usize,
    limit: usize,
) -> anyhow::Result<()> {
    while source.samples_supplied < limit {
        let samples = (limit - source.samples_supplied).min(samples_for_timeout(
            source.info.rate(),
            source.buffer_timeout,
        ));
        input
            .source()
            .add(&silence_frame(source.info, samples))
            .with_context(|| format!("Audio mixer source {index} silence input failed"))?;
        source.samples_supplied += samples;
    }
    Ok(())
}

fn sample_position(
    timestamp: Timestamp,
    start: Timestamp,
    timestamps: Timestamps,
    rate: i32,
) -> i128 {
    let nanos = timestamp.duration_since(timestamps).as_nanos() as i128
        - start.duration_since(timestamps).as_nanos() as i128;
    (nanos * rate as i128 + 500_000_000).div_euclid(1_000_000_000)
}

fn silence_frame(info: AudioInfo, samples: usize) -> ffmpeg::frame::Audio {
    let mut frame = ffmpeg::frame::Audio::new(info.sample_format, samples, info.channel_layout());
    let silence = if matches!(info.sample_format, cap_media_info::Sample::U8(_)) {
        128
    } else {
        0
    };
    for plane in 0..frame.planes() {
        frame.data_mut(plane).fill(silence);
    }
    frame.set_rate(info.sample_rate);
    frame
}

fn detect_format_mismatch(current: &AudioInfo, frame: &ffmpeg::frame::Audio) -> Option<AudioInfo> {
    let frame_rate: u32 = frame.rate();
    let frame_channels: usize = frame.channels() as usize;
    let frame_fmt = frame.format();

    if frame_rate == 0 || frame_channels == 0 {
        return None;
    }

    let rate_changed = frame_rate != current.sample_rate;
    let channels_changed = frame_channels != current.channels;
    let fmt_changed = frame_fmt != current.sample_format;

    if !rate_changed && !channels_changed && !fmt_changed {
        return None;
    }

    let mut updated = *current;
    updated.sample_rate = frame_rate;
    updated.channels = frame_channels;
    updated.sample_format = frame_fmt;
    Some(updated)
}

struct FilterGraphParts {
    filter_graph: ffmpeg::filter::Graph,
    abuffers: Vec<ffmpeg::filter::Context>,
    resamplers: Vec<ffmpeg::filter::Context>,
    amix: ffmpeg::filter::Context,
    aformat: ffmpeg::filter::Context,
    abuffersink: ffmpeg::filter::Context,
}

fn construct_filter_graph(infos: &[AudioInfo]) -> Result<FilterGraphParts, ffmpeg::Error> {
    let mut filter_graph = ffmpeg::filter::Graph::new();

    let mut abuffers = Vec::new();
    let mut resamplers = Vec::new();

    let target_info = AudioMixer::INFO;
    let target_rate = target_info.rate();
    let target_sample_fmt = target_info.sample_format.name();
    let target_channel_layout_bits = target_info.channel_layout().bits();

    for (i, info) in infos.iter().enumerate() {
        let args = format!(
            "time_base={}:sample_rate={}:sample_fmt={}:channel_layout=0x{:x}",
            info.time_base,
            info.rate(),
            info.sample_format.name(),
            info.channel_layout().bits()
        );

        debug!("audio mixer input {i}: {args}");

        let mut abuffer = filter_graph.add(
            &ffmpeg::filter::find("abuffer").expect("Failed to find abuffer filter"),
            &format!("src{i}"),
            &args,
        )?;

        let mut resample = filter_graph.add(
            &ffmpeg::filter::find("aresample").expect("Failed to find aresample filter"),
            &format!("resample{i}"),
            &format!(
                "out_sample_rate={target_rate}:out_sample_fmt={target_sample_fmt}:out_chlayout=0x{target_channel_layout_bits:x}"
            ),
        )?;

        abuffer.link(0, &mut resample, 0);

        abuffers.push(abuffer);
        resamplers.push(resample);
    }

    let mut amix = filter_graph.add(
        &ffmpeg::filter::find("amix").expect("Failed to find amix filter"),
        "amix",
        &format!("inputs={}:duration=longest", abuffers.len()),
    )?;

    let aformat_args = format!(
        "sample_fmts={target_sample_fmt}:sample_rates={target_rate}:channel_layouts=0x{target_channel_layout_bits:x}"
    );

    let mut aformat = filter_graph.add(
        &ffmpeg::filter::find("aformat").expect("Failed to find aformat filter"),
        "aformat",
        &aformat_args,
    )?;

    let mut abuffersink = filter_graph.add(
        &ffmpeg::filter::find("abuffersink").expect("Failed to find abuffersink filter"),
        "sink",
        "",
    )?;

    for (i, resample) in resamplers.iter_mut().enumerate() {
        resample.link(0, &mut amix, i as u32);
    }

    amix.link(0, &mut aformat, 0);
    aformat.link(0, &mut abuffersink, 0);

    filter_graph.validate()?;

    Ok(FilterGraphParts {
        filter_graph,
        abuffers,
        resamplers,
        amix,
        aformat,
        abuffersink,
    })
}

fn mixer_source_label(index: usize) -> &'static str {
    const LABELS: [&str; 8] = [
        "mixer-src-0",
        "mixer-src-1",
        "mixer-src-2",
        "mixer-src-3",
        "mixer-src-4",
        "mixer-src-5",
        "mixer-src-6",
        "mixer-src-7",
    ];
    LABELS.get(index).copied().unwrap_or("mixer-src-overflow")
}

const MIN_IDLE_WAIT: Duration = Duration::from_millis(5);
const MAX_IDLE_WAIT: Duration = Duration::from_millis(25);

fn idle_wait_for(timeouts: impl IntoIterator<Item = Duration>) -> Duration {
    timeouts
        .into_iter()
        .map(|timeout| timeout / 2)
        .min()
        .unwrap_or(MIN_IDLE_WAIT)
        .clamp(MIN_IDLE_WAIT, MAX_IDLE_WAIT)
}

struct ThreadUnpark(std::thread::Thread);

impl std::task::Wake for ThreadUnpark {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.0.unpark();
    }
}

fn buffer_timeout_for(info: &AudioInfo) -> Duration {
    if info.sample_rate == 0 || info.buffer_size == 0 {
        return DEFAULT_BUFFER_TIMEOUT;
    }

    let base = Duration::from_secs_f64(info.buffer_size as f64 / info.sample_rate as f64);

    if base.is_zero() {
        return DEFAULT_BUFFER_TIMEOUT;
    }

    let with_headroom = base.mul_f64(BUFFER_TIMEOUT_HEADROOM);

    let min_timeout = if info.is_wireless_transport {
        MIN_BUFFER_TIMEOUT_WIRELESS
    } else {
        MIN_BUFFER_TIMEOUT_WIRED
    };

    clamp_duration(with_headroom, min_timeout, MAX_BUFFER_TIMEOUT)
}

fn clamp_duration(value: Duration, min: Duration, max: Duration) -> Duration {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn samples_for_timeout(rate: i32, timeout: Duration) -> usize {
    if rate <= 0 {
        return 1;
    }

    let samples = (timeout.as_secs_f64() * rate as f64).round();
    samples.max(1.0) as usize
}

#[cfg(test)]
mod test {
    use futures::{SinkExt, StreamExt};

    use super::*;

    const SAMPLE_RATE: u32 = 48_000;
    const SOURCE_INFO: AudioInfo = AudioInfo::new_raw(
        cap_media_info::Sample::U8(cap_media_info::Type::Packed),
        SAMPLE_RATE,
        1,
    );
    const ONE_SECOND: Duration = Duration::from_secs(1);
    const SAMPLES_SECOND: usize = SOURCE_INFO.rate() as usize;

    struct PcmProbe {
        mixer: AudioMixer,
        inputs: Vec<mpsc::Sender<AudioFrame>>,
        output: mpsc::Receiver<AudioFrame>,
        pcm: Vec<[f32; 2]>,
        deliveries: Vec<(usize, u64)>,
    }

    impl PcmProbe {
        fn new(sources: usize) -> Self {
            let (sender, output) = mpsc::channel(128);
            let mut builder = AudioMixerBuilder::new();
            let inputs = (0..sources)
                .map(|_| {
                    let (sender, receiver) = mpsc::channel(32);
                    builder.add_source(AudioMixer::INFO, receiver);
                    sender
                })
                .collect();
            Self {
                mixer: builder.build(sender).unwrap(),
                inputs,
                output,
                pcm: Vec::new(),
                deliveries: Vec::new(),
            }
        }

        fn at(&self, millis: u64) -> Timestamp {
            Timestamp::Instant(self.mixer.timestamps.instant() + Duration::from_millis(millis))
        }

        fn send(&mut self, source: usize, millis: u64, samples: usize, peak: Option<usize>) {
            self.send_at(source, self.at(millis), samples, peak);
        }

        fn send_at(
            &mut self,
            source: usize,
            timestamp: Timestamp,
            samples: usize,
            peak: Option<usize>,
        ) {
            let mut bytes = vec![0; samples * 8];
            if let Some(peak) = peak {
                let offset = peak * 8 + source * 4;
                bytes[offset..offset + 4].copy_from_slice(&0.5_f32.to_le_bytes());
            }
            self.inputs[source]
                .try_send(AudioFrame::new(
                    AudioMixer::INFO.wrap_frame(&bytes),
                    timestamp,
                ))
                .unwrap();
        }

        fn tick(&mut self, millis: u64) {
            assert!(
                self.mixer
                    .tick(self.mixer.timestamps, self.at(millis))
                    .unwrap()
            );
            self.collect(millis);
        }

        fn collect(&mut self, millis: u64) {
            while let Ok(Some(frame)) = self.output.try_next() {
                self.deliveries.push((self.pcm.len(), millis));
                for pair in frame.inner.data(0)[..frame.inner.samples() * 8].chunks_exact(8) {
                    self.pcm.push([
                        f32::from_le_bytes(pair[..4].try_into().unwrap()),
                        f32::from_le_bytes(pair[4..].try_into().unwrap()),
                    ]);
                }
            }
        }

        fn peaks(&self, channel: usize) -> Vec<usize> {
            self.pcm
                .iter()
                .enumerate()
                .filter_map(|(index, sample)| (sample[channel].abs() > 0.01).then_some(index))
                .collect()
        }
    }

    #[test]
    fn pcm_arrival_schedules_preserve_sixty_ms_source_offset() {
        for early_poll in [false, true] {
            let mut probe = PcmProbe::new(2);
            probe.send(1, 200, 24_000, Some(9_600));
            if early_poll {
                probe.tick(200);
                probe.tick(254);
            }
            probe.send(0, 260, 24_000, Some(9_600));
            probe.send(1, 700, 2_880, None);
            probe.tick(300);
            assert_eq!(probe.peaks(1), [9_600]);
            assert_eq!(probe.peaks(0), [12_480]);
            assert_eq!(probe.peaks(0)[0] - probe.peaks(1)[0], 2_880);
        }
    }

    #[test]
    fn pcm_arrival_schedules_align_simultaneous_capture_events() {
        for early_poll in [false, true] {
            let mut probe = PcmProbe::new(2);
            probe.send(1, 200, 24_000, Some(9_600));
            if early_poll {
                probe.tick(200);
                probe.tick(254);
            }
            probe.send(0, 260, 24_000, Some(6_720));
            probe.send(1, 700, 2_880, None);
            probe.tick(300);
            assert_eq!(probe.peaks(0), [9_600]);
            assert_eq!(probe.peaks(1), [9_600]);
        }
    }

    #[test]
    fn pcm_continuous_system_and_late_mic_follow_capture_time() {
        for early_poll in [false, true] {
            let mut probe = PcmProbe::new(2);
            probe.send(0, 0, 24_000, Some(14_400));
            if early_poll {
                probe.tick(0);
                probe.tick(254);
            }
            probe.send(1, 200, 14_400, Some(4_800));
            probe.tick(300);
            assert_eq!(probe.peaks(0), [14_400]);
            assert_eq!(probe.peaks(1), [14_400]);
        }
    }

    #[test]
    fn pcm_sparse_system_and_pause_resume_preserve_later_gaps() {
        let mut probe = PcmProbe::new(2);
        probe.send(1, 0, 48_000, Some(14_400));
        probe.send(0, 0, 960, None);
        probe.send(0, 300, 960, Some(0));
        probe.send(0, 600, 960, Some(0));
        probe.send(0, 900, 4_800, Some(0));
        probe.send(0, 1_000, 4_800, None);
        probe.send(1, 1_000, 4_800, None);
        probe.tick(1_100);
        assert_eq!(
            probe.peaks(0),
            [14_400, 28_800, 43_200],
            "{} output samples",
            probe.pcm.len()
        );
        assert_eq!(probe.peaks(1), [14_400]);
        probe.send(0, 1_500, 4_800, Some(0));
        probe.send(1, 1_500, 4_800, Some(0));
        probe.send(0, 1_600, 4_800, None);
        probe.send(1, 1_600, 4_800, None);
        probe.tick(1_700);
        assert_eq!(probe.peaks(0), [14_400, 28_800, 43_200, 72_000]);
        assert_eq!(probe.peaks(1), [14_400, 72_000]);
    }

    #[test]
    fn pcm_thousand_sparse_packets_preserve_samples_without_rounding_drift() {
        for spacing_ns in [300_000_000, 300_006_944] {
            let mut probe = PcmProbe::new(2);
            let mut expected = Vec::new();
            for packet in 0..=1_001_u64 {
                let timestamp = Timestamp::Instant(
                    probe.mixer.timestamps.instant() + Duration::from_nanos(packet * spacing_ns),
                );
                probe.send_at(0, timestamp, 960, (packet < 1_001).then_some(0));
                probe.send_at(1, timestamp, 960, None);
                probe.tick(packet * spacing_ns / 1_000_000 + 20);
                if packet < 1_001 {
                    let fractional_samples = if spacing_ns == 300_000_000 {
                        0
                    } else {
                        (packet + 1) / 3
                    };
                    expected.push((packet * 14_400 + fractional_samples) as usize);
                }
            }
            assert_eq!(probe.peaks(0), expected);
            assert!(probe.peaks(1).is_empty());
        }
    }

    #[test]
    fn pcm_delayed_first_delivery_retains_captured_samples() {
        for delivery_ms in [400, 800, 1_000] {
            let mut probe = PcmProbe::new(2);
            for chunk in 0..delivery_ms / 20 {
                probe.send(0, chunk * 20, 960, None);
                if (chunk + 1) * 20 < delivery_ms {
                    probe.tick((chunk + 1) * 20);
                }
            }
            probe.send(1, 200, 48_000, Some(2_400));
            probe.send(0, delivery_ms, 57_600 - delivery_ms as usize * 48, None);
            probe.tick(delivery_ms);
            eprintln!(
                "DELAYED delivery_ms={delivery_ms} peaks={:?}",
                probe.peaks(1)
            );
            assert_eq!(probe.peaks(1), [12_000]);
        }
    }

    #[test]
    fn pcm_first_input_can_precede_the_uncommitted_mixer_origin() {
        let mut probe = PcmProbe::new(2);
        probe.send(0, 200, 24_000, Some(4_800));
        probe.tick(300);
        assert!(probe.pcm.is_empty());
        probe.send(1, 0, 33_600, Some(14_400));
        probe.tick(400);
        assert_eq!(probe.peaks(0), [14_400]);
        assert_eq!(probe.peaks(1), [14_400]);
    }

    #[test]
    fn pcm_first_input_after_grace_drops_and_counts_only_committed_samples() {
        let mut probe = PcmProbe::new(2);
        probe.send(0, 0, 48_000, None);
        probe.tick(999);
        assert!(probe.pcm.is_empty());
        probe.tick(1_000);
        assert_eq!(probe.pcm.len(), 48_000);
        assert_eq!(probe.deliveries[0].1, 1_000);
        probe.send(1, 200, 48_000, Some(2_400));
        probe.send(0, 1_000, 9_600, Some(0));
        probe.tick(1_200);
        assert!(probe.peaks(1).is_empty());
        assert_eq!(probe.mixer.sources[1].late_samples_dropped, 38_400);
        assert_eq!(probe.peaks(0), [48_000]);
        probe.send(1, 1_200, 960, Some(0));
        probe.send(0, 1_200, 960, None);
        probe.tick(1_220);
        assert_eq!(probe.peaks(1), [57_600]);
        assert_eq!(probe.mixer.sources[1].late_samples_dropped, 38_400);
    }

    #[test]
    fn pcm_watermark_limits_commitment_to_the_shortest_input() {
        let mut probe = PcmProbe::new(2);
        probe.send(0, 0, 4_800, Some(4_000));
        probe.send(1, 0, 960, None);
        probe.tick(20);
        assert_eq!(probe.pcm.len(), 960);
        assert_eq!(probe.mixer.sources[0].samples_supplied, 960);
        assert_eq!(probe.mixer.sources[1].samples_supplied, 960);
        probe.send(1, 20, 3_840, Some(3_040));
        probe.tick(100);
        assert_eq!(probe.pcm.len(), 4_800);
        assert_eq!(probe.peaks(0), [4_000]);
        assert_eq!(probe.peaks(1), [4_000]);
    }

    #[test]
    fn pcm_continuous_input_watermarks_add_at_most_one_buffer() {
        let mut probe = PcmProbe::new(2);
        for chunk in 0..10 {
            probe.send(0, chunk * 20, 960, None);
            probe.tick(chunk * 20 + 20);
            assert!(probe.pcm.len() >= chunk as usize * 960);
            probe.send(1, chunk * 20, 960, None);
            probe.tick(chunk * 20 + 20);
            assert_eq!(probe.pcm.len(), (chunk as usize + 1) * 960);
        }
        assert_eq!(probe.deliveries[0].1, 20);
    }

    #[test]
    fn pcm_watermark_splits_do_not_accumulate_timestamp_rounding() {
        let mut probe = PcmProbe::new(2);
        probe.send(0, 0, 50_001, Some(49_999));
        for sample in 0..50_001 {
            let timestamp = Timestamp::Instant(
                probe.mixer.timestamps.instant()
                    + Duration::from_nanos(sample * 1_000_000_000 / 48_000),
            );
            probe.send_at(1, timestamp, 1, None);
            probe.tick(sample / 48);
        }
        assert_eq!(probe.peaks(0), [49_999]);
        assert_eq!(probe.mixer.sources[0].late_samples_dropped, 0);
        assert_eq!(probe.pcm.len(), 50_001);
    }

    #[test]
    fn pcm_sub_timeout_gap_is_not_smoothed_away() {
        let mut probe = PcmProbe::new(2);
        probe.send(1, 0, 4_800, None);
        probe.send(0, 0, 960, Some(0));
        probe.send(0, 30, 960, Some(0));
        probe.send(0, 50, 2_400, Some(0));
        probe.tick(100);
        assert_eq!(probe.peaks(0), [0, 1_440, 2_400]);
    }

    #[test]
    fn pcm_stop_before_startup_grace_preserves_captured_audio() {
        let mut probe = PcmProbe::new(2);
        probe.send(1, 0, 4_800, Some(960));
        probe.tick(100);
        assert!(probe.pcm.is_empty());
        probe.inputs.clear();
        probe.mixer.finish().unwrap();
        probe.collect(100);
        assert_eq!(probe.peaks(1), [960]);
        assert_eq!(probe.pcm.len(), 4_800);
    }

    #[test]
    fn pcm_stop_drains_the_longest_input_and_pads_closed_sources() {
        for millis in [100, 1_500] {
            let mut probe = PcmProbe::new(2);
            probe.send(0, 0, 960, None);
            probe.send(1, 0, 4_800, Some(4_799));
            probe.tick(millis);
            probe.inputs.clear();
            probe.mixer.finish().unwrap();
            probe.collect(millis);
            assert_eq!(probe.peaks(1), [4_799]);
            assert_eq!(probe.pcm.len(), 4_800);
        }
    }

    #[test]
    fn pcm_stop_waits_for_queued_capture_before_closing_inputs() {
        let mut probe = PcmProbe::new(2);
        probe.send(1, 0, 960, None);
        let mut input = probe.inputs.pop().unwrap();
        probe.inputs.clear();
        let timestamp = probe.at(20);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            let mut bytes = vec![0; 3_840 * 8];
            bytes[3_000 * 8 + 4..3_000 * 8 + 8].copy_from_slice(&0.5_f32.to_le_bytes());
            input
                .try_send(AudioFrame::new(
                    AudioMixer::INFO.wrap_frame(&bytes),
                    timestamp,
                ))
                .unwrap();
        });
        probe.mixer.finish().unwrap();
        worker.join().unwrap();
        probe.collect(100);
        assert_eq!(probe.peaks(1), [3_960]);
        assert_eq!(probe.pcm.len(), 4_800);
    }

    #[test]
    fn pcm_stop_bounds_a_producer_that_never_closes() {
        let mut probe = PcmProbe::new(2);
        probe.send(1, 0, 4_800, Some(960));
        let start = Instant::now();
        probe.mixer.finish().unwrap();
        assert!(start.elapsed() < MIXER_STOP_TIMEOUT);
        probe.collect(100);
        assert_eq!(probe.peaks(1), [960]);
        assert_eq!(probe.pcm.len(), 4_800);
        assert!(probe.inputs.iter_mut().all(|input| input.is_closed()));
    }

    #[test]
    fn pcm_input_captured_before_the_clock_origin_keeps_its_capture_time() {
        let mut probe = PcmProbe::new(1);
        let origin = probe.mixer.timestamps.instant();
        // 480 samples from 4 ms before the origin: 192 precede it, and the
        // marker at sample 300 was captured 2.25 ms after it.
        probe.send_at(
            0,
            Timestamp::Instant(origin.checked_sub(Duration::from_millis(4)).unwrap()),
            480,
            Some(300),
        );
        probe.send_at(
            0,
            Timestamp::Instant(origin + Duration::from_millis(6)),
            480,
            Some(0),
        );
        probe.tick(100);
        assert_eq!(probe.peaks(0), [108, 288]);
        assert_eq!(probe.mixer.sources[0].late_samples_dropped, 0);
    }

    #[test]
    fn pcm_timestamp_jitter_within_tolerance_keeps_samples_contiguous() {
        let mut probe = PcmProbe::new(1);
        let base = probe.mixer.timestamps.instant() + Duration::from_millis(100);
        let jitter_us = [
            0_i64, 1_500, -800, 1_900, 300, -1_900, 1_200, 0, 700, -1_500,
        ];
        for (packet, jitter) in jitter_us.into_iter().enumerate() {
            let micros = 20_000 * packet as i64 + jitter;
            let timestamp = base + Duration::from_micros(micros.max(0) as u64);
            probe.send_at(0, Timestamp::Instant(timestamp), 960, Some(0));
            probe.tick(20 * packet as u64 + 125);
        }
        assert_eq!(
            probe.peaks(0),
            (0..jitter_us.len())
                .map(|packet| packet * 960)
                .collect::<Vec<_>>()
        );
        assert_eq!(probe.mixer.sources[0].late_samples_dropped, 0);
    }

    #[test]
    fn pcm_clock_drift_is_corrected_one_sample_at_a_time() {
        let mut probe = PcmProbe::new(1);
        let base = probe.mixer.timestamps.instant() + Duration::from_millis(100);
        // 2,000 ppm: each 960-sample packet's capture time runs 1.92
        // samples ahead of its sample count.
        let spacing = Duration::from_nanos(20_040_000);
        let packets = 200;
        for packet in 0..packets {
            probe.send_at(
                0,
                Timestamp::Instant(base + spacing * packet as u32),
                960,
                Some(0),
            );
            probe.tick(20 * packet as u64 + 125);
        }
        let peaks = probe.peaks(0);
        assert_eq!(peaks.len(), packets);
        for pair in peaks.windows(2) {
            assert!(
                (960..=963).contains(&(pair[1] - pair[0])),
                "a drift correction jumped: {pair:?}"
            );
        }
        let last_position =
            (spacing.as_nanos() * (packets as u128 - 1) * 48_000 / 1_000_000_000) as usize;
        assert!(
            last_position.abs_diff(*peaks.last().unwrap()) <= 96 + 2,
            "drift not followed: {} vs {last_position}",
            peaks.last().unwrap()
        );
    }

    #[test]
    fn pcm_single_input_is_unchanged_and_reset_keeps_the_supplied_cursor() {
        let mut probe = PcmProbe::new(1);
        probe.send(0, 200, 4_800, Some(2_400));
        probe.tick(300);
        assert_eq!(probe.pcm.len(), 4_800);
        assert_eq!(probe.peaks(0), [2_400]);
        for (index, sample) in probe.pcm.iter().enumerate() {
            assert_eq!(
                *sample,
                if index == 2_400 {
                    [0.5, 0.0]
                } else {
                    [0.0, 0.0]
                }
            );
        }
        probe.mixer.force_reset_source(mixer_source_label(0), 2_000);
        probe.send(0, 400, 4_800, Some(0));
        probe.tick(500);
        assert_eq!(probe.peaks(0), [2_400, 9_600]);
    }

    #[tokio::test]
    async fn mix_sources() {
        let (tx, mut output_rx) = mpsc::channel(4);
        let mut mixer = AudioMixerBuilder::new();

        let (mut tx1, rx) = mpsc::channel(4);
        mixer.add_source(SOURCE_INFO, rx);

        let (mut tx2, rx) = mpsc::channel(4);
        mixer.add_source(SOURCE_INFO, rx);

        let mut mixer = mixer.build(tx).unwrap();
        let start = mixer.timestamps;

        tx1.send(AudioFrame::new(
            SOURCE_INFO.wrap_frame(&[128, 255, 255, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .await
        .unwrap();
        tx2.send(AudioFrame::new(
            SOURCE_INFO.wrap_frame(&[128, 128, 1, 255]),
            Timestamp::Instant(start.instant()),
        ))
        .await
        .unwrap();

        let _ = mixer.tick(
            start,
            Timestamp::Instant(start.instant() + Duration::from_secs_f64(4.0 / SAMPLE_RATE as f64)),
        );

        let frame = output_rx.next().await.expect("No output frame");

        let byte_count = frame.samples() * frame.channels() as usize;
        let samples: &[f32] = unsafe { std::mem::transmute(&frame.data(0)[0..byte_count]) };

        assert_eq!(samples[0], 0.0);
        assert_eq!(samples[0], samples[1]);

        assert_eq!(samples[4], 0.0);
        assert_eq!(samples[4], samples[5]);
    }

    fn mixer_fixture(
        strict: bool,
    ) -> (
        AudioMixer,
        Vec<mpsc::Sender<AudioFrame>>,
        mpsc::Receiver<AudioFrame>,
    ) {
        let (output, receiver) = mpsc::channel(4);
        let mut builder = AudioMixerBuilder::new();
        if strict {
            builder = builder.with_required_inputs(CancellationToken::new());
        }
        let mut senders = Vec::new();
        for _ in 0..2 {
            let (sender, receiver) = mpsc::channel(4);
            builder.add_source(SOURCE_INFO, receiver);
            senders.push(sender);
        }
        (builder.build(output).unwrap(), senders, receiver)
    }

    fn mixer_frame(now: Timestamp) -> AudioFrame {
        AudioFrame::new(SOURCE_INFO.wrap_frame(&[128, 255, 128, 1]), now)
    }

    #[test]
    fn strict_mixer_input_error_is_not_silent_but_legacy_still_degrades() {
        for strict in [false, true] {
            let (mut mixer, mut sources, _output) = mixer_fixture(strict);
            let now = Timestamp::Instant(mixer.timestamps.instant());
            let mut invalid = mixer_frame(now);
            invalid.inner.set_rate(0);
            sources[0].try_send(invalid).unwrap();
            sources[1].try_send(mixer_frame(now)).unwrap();
            let result = mixer.tick(mixer.timestamps, now);
            if strict {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("source 0 filter input failed")
                );
            } else {
                assert!(result.unwrap());
            }
        }
    }

    #[test]
    fn strict_mixer_rebuild_error_propagates_from_actual_graph() {
        for strict in [false, true] {
            let (mut mixer, mut sources, _output) = mixer_fixture(strict);
            let now = Timestamp::Instant(mixer.timestamps.instant());
            let mut invalid = mixer_frame(now);
            invalid.inner.set_rate(u32::MAX);
            sources[0].try_send(invalid).unwrap();
            sources[1].try_send(mixer_frame(now)).unwrap();
            let result = mixer.tick(mixer.timestamps, now);
            if strict {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("source 0 filter rebuild failed")
                );
            } else {
                assert!(result.unwrap());
            }
        }
    }

    #[test]
    fn strict_mixer_real_empty_and_eof_reads_are_not_errors() {
        let (mut mixer, _sources, _output) = mixer_fixture(true);
        let now = Timestamp::Instant(mixer.timestamps.instant());
        mixer.start_timestamp = Some(now);
        let mut observed_empty = false;
        assert!(mixer.tick_with_output(now, |sink, frame| {
            let result = sink.sink().frame(frame);
            observed_empty = matches!(result, Err(ffmpeg::Error::Other { errno }) if errno == ffmpeg::error::EAGAIN);
            result
        }).unwrap());
        assert!(observed_empty);
        for source in &mut mixer.abuffers {
            source.source().flush().unwrap();
        }
        assert!(
            mixer
                .tick(mixer.timestamps, now)
                .unwrap_err()
                .to_string()
                .contains("filter ended")
        );
        mixer.required_stop.as_ref().unwrap().cancel();
        let mut observed_eof = false;
        assert!(
            mixer
                .tick_with_output(now, |sink, frame| {
                    let result = sink.sink().frame(frame);
                    observed_eof = matches!(result, Err(ffmpeg::Error::Eof));
                    result
                })
                .unwrap()
        );
        assert!(observed_eof);
    }

    #[test]
    fn strict_mixer_output_failure_uses_the_real_drain_loop() {
        for strict in [false, true] {
            let (mut mixer, mut sources, _output) = mixer_fixture(strict);
            let now = Timestamp::Instant(mixer.timestamps.instant());
            for source in &mut sources {
                source.try_send(mixer_frame(now)).unwrap();
            }
            let mut decoded = false;
            let result = mixer.tick_with_output(now, |sink, frame| {
                sink.sink().frame(frame)?;
                decoded = true;
                Err(ffmpeg::Error::InvalidData)
            });
            assert!(decoded);
            if strict {
                assert!(
                    result
                        .unwrap_err()
                        .to_string()
                        .contains("filter output failed")
                );
            } else {
                assert!(result.unwrap());
            }
        }
    }

    #[test]
    fn strict_mixer_distinguishes_open_empty_and_closed_requested_inputs() {
        for strict in [false, true] {
            let (mut mixer, mut sources, _output) = mixer_fixture(strict);
            let now = Timestamp::Instant(mixer.timestamps.instant());
            assert!(mixer.tick(mixer.timestamps, now).unwrap());
            drop(sources.remove(0));
            let result = mixer.tick(mixer.timestamps, now);
            if strict {
                assert!(result.unwrap_err().to_string().contains("source 0 closed"));
            } else {
                assert!(result.unwrap());
            }
        }
    }

    #[test]
    fn required_mixer_stop_token_precedes_async_stop_flag_and_input_close() {
        let (mut mixer, sources, _output) = mixer_fixture(true);
        let now = Timestamp::Instant(mixer.timestamps.instant());
        mixer.required_stop.as_ref().unwrap().cancel();
        drop(sources);
        assert!(mixer.tick(mixer.timestamps, now).unwrap());
        let stop = CancellationToken::new();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let mut builder = AudioMixerBuilder::new().with_required_inputs(stop.clone());
        for _ in 0..2 {
            let (sender, receiver) = mpsc::channel(4);
            builder.add_source(SOURCE_INFO, receiver);
            drop(sender);
        }
        let (output, _receiver) = mpsc::channel(4);
        let (ready, _ready_rx) = oneshot::channel();
        stop.cancel();
        let flag = stop_flag.clone();
        let (complete, completed) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let _ = complete.send(builder.run(output, ready, flag));
        });
        let result = completed.recv_timeout(Duration::from_secs(1));
        if result.is_err() {
            stop_flag.store(true, Ordering::Release);
        }
        worker.join().unwrap();
        result.unwrap().unwrap();
        assert!(!stop_flag.load(Ordering::Acquire));
    }

    #[test]
    fn strict_mixer_valid_output_and_closed_consumer_remain_clean() {
        for close_output in [false, true] {
            let (mut mixer, mut sources, mut output) = mixer_fixture(true);
            let now = Timestamp::Instant(mixer.timestamps.instant());
            for source in &mut sources {
                source.try_send(mixer_frame(now)).unwrap();
            }
            if close_output {
                output.close();
            }
            assert_eq!(mixer.tick(mixer.timestamps, now).unwrap(), !close_output);
            if !close_output {
                assert!(output.try_next().unwrap().is_some());
            }
        }
    }

    mod buffering_tracker {
        use super::*;
        use crate::output_pipeline::{HealthReceiver, HealthSender};

        fn new_health_pair() -> (HealthSender, HealthReceiver) {
            tokio::sync::mpsc::channel(32)
        }

        #[test]
        fn no_emit_when_no_laggard() {
            let mut tracker = MixerBufferingTracker::new();
            let (tx, mut rx) = new_health_pair();
            let t0 = Instant::now();
            tracker.observe(t0, None, Some(&tx));
            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 100),
                None,
                Some(&tx),
            );
            assert_eq!(tracker.total_stall_events(), 0);
            assert!(rx.try_recv().is_err());
        }

        #[test]
        fn no_emit_for_brief_stall_under_budget() {
            let mut tracker = MixerBufferingTracker::new();
            let (tx, mut rx) = new_health_pair();
            let t0 = Instant::now();
            tracker.observe(t0, Some("mic"), Some(&tx));
            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS / 2),
                Some("mic"),
                Some(&tx),
            );
            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS / 2 + 10),
                None,
                Some(&tx),
            );
            assert_eq!(tracker.total_stall_events(), 0);
            assert!(rx.try_recv().is_err());
        }

        #[test]
        fn emits_once_per_sustained_stall_and_recovers() {
            let mut tracker = MixerBufferingTracker::new();
            let (tx, mut rx) = new_health_pair();
            let t0 = Instant::now();
            tracker.observe(t0, Some("mic"), Some(&tx));
            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 10),
                Some("mic"),
                Some(&tx),
            );
            let first = rx.try_recv().expect("first stall must emit");
            match first {
                PipelineHealthEvent::Stalled { source, waited_ms } => {
                    assert_eq!(source, "mixer:mic");
                    assert!(waited_ms >= MAX_BUFFERING_MS);
                }
                other => panic!("unexpected event {other:?}"),
            }

            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 200),
                Some("mic"),
                Some(&tx),
            );
            assert!(
                rx.try_recv().is_err(),
                "only one emit per sustained-stall window"
            );
            assert_eq!(tracker.total_stall_events(), 1);

            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 300),
                None,
                Some(&tx),
            );
            assert!(rx.try_recv().is_err());

            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 400),
                Some("mic"),
                Some(&tx),
            );
            tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS * 2 + 500),
                Some("mic"),
                Some(&tx),
            );
            let second = rx
                .try_recv()
                .expect("second sustained stall must emit again");
            match second {
                PipelineHealthEvent::Stalled { source, .. } => {
                    assert_eq!(source, "mixer:mic")
                }
                other => panic!("unexpected event {other:?}"),
            }
            assert_eq!(tracker.total_stall_events(), 2);
        }

        const _MAX_BUFFERING_WINDOW_MATCHES_OBS_DEFAULT: () = {
            assert!(MAX_BUFFERING_TICKS == 45);
            assert!(
                MAX_BUFFERING_MS
                    == (MAX_BUFFERING_TICKS as u64 * AUDIO_OUTPUT_FRAMES as u64 * 1000)
                        / DEFAULT_SAMPLE_RATE as u64
            );
            assert!(
                MAX_BUFFERING_MS == 960,
                "MAX_BUFFERING_MS must equal OBS default of 960ms (45 * 1024 / 48)"
            );
            assert!(FORCED_RESET_MS == MAX_BUFFERING_MS * 2);
        };

        #[test]
        fn force_reset_action_emitted_after_forced_reset_threshold() {
            let mut tracker = MixerBufferingTracker::new();
            let (tx, mut rx) = new_health_pair();
            let t0 = Instant::now();
            tracker.observe(t0, Some("mic"), Some(&tx));

            let action_stall = tracker.observe(
                t0 + Duration::from_millis(MAX_BUFFERING_MS + 10),
                Some("mic"),
                Some(&tx),
            );
            assert!(action_stall.is_none());
            rx.try_recv().expect("stall event emitted");

            let action = tracker.observe(
                t0 + Duration::from_millis(FORCED_RESET_MS + 10),
                Some("mic"),
                Some(&tx),
            );
            match action {
                Some(MixerBufferingAction::ForceReset {
                    source,
                    starvation_ms,
                }) => {
                    assert_eq!(source, "mic");
                    assert!(starvation_ms >= FORCED_RESET_MS);
                }
                other => panic!("expected ForceReset, got {other:?}"),
            }

            let action_followup = tracker.observe(
                t0 + Duration::from_millis(FORCED_RESET_MS + 100),
                Some("mic"),
                Some(&tx),
            );
            assert!(
                action_followup.is_none(),
                "force reset must only fire once per sustained stall"
            );
        }
    }

    mod input_wake {
        use super::*;

        struct CountingWaker(std::sync::atomic::AtomicUsize);

        impl std::task::Wake for CountingWaker {
            fn wake(self: Arc<Self>) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        #[tokio::test]
        async fn a_frame_arriving_after_a_drain_wakes_the_mixer() {
            let (output_tx, _) = mpsc::channel::<AudioFrame>(4);
            let mut builder = AudioMixerBuilder::new();
            let (mut tx, rx) = mpsc::channel(4);
            builder.add_source(SOURCE_INFO, rx);
            let mut mixer = builder.build(output_tx).unwrap();
            let wakes = Arc::new(CountingWaker(std::sync::atomic::AtomicUsize::new(0)));
            mixer.input_waker = std::task::Waker::from(wakes.clone());

            let now = Timestamp::Instant(mixer.timestamps.instant());
            mixer.buffer_sources(now).unwrap();
            assert_eq!(wakes.0.load(Ordering::SeqCst), 0);

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 10]),
                now,
            ))
            .await
            .unwrap();
            assert_eq!(wakes.0.load(Ordering::SeqCst), 1);

            mixer.buffer_sources(now).unwrap();
            assert_eq!(mixer.sources[0].buffer.len(), 1);
        }

        #[test]
        fn idle_wait_is_half_the_shortest_buffer_timeout_within_bounds() {
            assert_eq!(
                idle_wait_for([Duration::from_millis(40), Duration::from_millis(100)]),
                Duration::from_millis(20)
            );
            assert_eq!(
                idle_wait_for([MIN_BUFFER_TIMEOUT_WIRED]),
                Duration::from_millis(10)
            );
            assert_eq!(idle_wait_for([MAX_BUFFER_TIMEOUT]), MAX_IDLE_WAIT);
            assert_eq!(idle_wait_for([Duration::from_millis(4)]), MIN_IDLE_WAIT);
            assert_eq!(idle_wait_for([]), MIN_IDLE_WAIT);
        }
    }

    mod source_buffer {
        use super::*;

        #[tokio::test]
        async fn single_frame() {
            let (output_tx, _) = mpsc::channel::<AudioFrame>(4);
            let mut mixer = AudioMixerBuilder::new();
            let start = Timestamps::now();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .await
            .unwrap();

            mixer
                .buffer_sources(Timestamp::Instant(start.instant()))
                .unwrap();

            assert_eq!(mixer.sources[0].buffer.len(), 1);
            assert!(mixer.sources[0].rx.try_next().is_err());
        }

        #[tokio::test]
        async fn frame_gap() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant()),
            ))
            .await
            .unwrap();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(mixer.timestamps.instant() + ONE_SECOND),
            ))
            .await
            .unwrap();

            mixer
                .buffer_sources(Timestamp::Instant(mixer.timestamps.instant()))
                .unwrap();

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 2);
            assert!(source.rx.try_next().is_err());

            assert_eq!(
                source.buffer[1].timestamp.duration_since(mixer.timestamps),
                ONE_SECOND
            );
            assert_eq!(source.buffer[1].samples(), SOURCE_INFO.rate() as usize / 2);
        }

        #[tokio::test]
        async fn start_gap() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();
            let start = mixer.timestamps;

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND / 2),
            ))
            .await
            .unwrap();

            mixer
                .buffer_sources(Timestamp::Instant(start.instant()))
                .unwrap();

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 1);
            assert!(source.rx.try_next().is_err());

            assert_eq!(
                source.buffer[0].timestamp.duration_since(start),
                ONE_SECOND / 2
            );
            assert_eq!(source.buffer[0].samples(), SOURCE_INFO.rate() as usize / 2);
        }

        #[tokio::test]
        async fn after_draining() {
            let (output_tx, _) = mpsc::channel(4);
            let mut mixer = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(4);
            mixer.add_source(SOURCE_INFO, rx);

            let mut mixer = mixer.build(output_tx).unwrap();
            let start = mixer.timestamps;

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant()),
            ))
            .await
            .unwrap();

            mixer
                .buffer_sources(Timestamp::Instant(start.instant()))
                .unwrap();

            mixer.sources[0].buffer.clear();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .await
            .unwrap();

            mixer
                .buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND))
                .unwrap();

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 1);
            assert!(source.rx.try_next().is_err());

            let item = &source.buffer[0];
            assert_eq!(item.timestamp.duration_since(start), ONE_SECOND);
            assert_eq!(item.inner.samples(), SOURCE_INFO.rate() as usize / 2);
        }

        #[tokio::test]
        async fn hard_reset_flushes_queued_frames_obs_parity() {
            let (output_tx, _) = mpsc::channel(4);
            let mut builder = AudioMixerBuilder::new();

            let (mut tx, rx) = mpsc::channel(16);
            builder.add_source(SOURCE_INFO, rx);

            let mut mixer = builder.build(output_tx).unwrap();
            let start = mixer.timestamps;

            for i in 0..4 {
                tx.send(AudioFrame::new(
                    SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 4]),
                    Timestamp::Instant(start.instant() + ONE_SECOND / 4 * i),
                ))
                .await
                .unwrap();
            }
            mixer
                .buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND))
                .unwrap();
            let initial_len = mixer.sources[0].buffer.len();
            assert!(
                initial_len >= 4,
                "expected pre-reset queue to hold ≥4 frames, got {initial_len}"
            );

            let far_future =
                Timestamp::Instant(start.instant() + Duration::from_secs(5) + ONE_SECOND);
            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 4]),
                far_future,
            ))
            .await
            .unwrap();
            mixer.buffer_sources(far_future).unwrap();

            let post_reset_len = mixer.sources[0].buffer.len();
            assert_eq!(
                post_reset_len, 1,
                "after hard-reset mixer buffer must be flushed \
                 (OBS reset_audio_data parity); post-reset contained {post_reset_len} frames"
            );
            assert!(mixer.sources[0].clock_state.hard_reset_count() >= 1);
        }
    }
}
