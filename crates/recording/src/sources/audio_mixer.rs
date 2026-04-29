use cap_media_info::AudioInfo;
use cap_timestamp::{MasterClock, SourceClockOutcome, SourceClockState, Timestamp, Timestamps};
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
use tracing::{debug, info, warn};

use crate::output_pipeline::{AudioFrame, HealthSender, PipelineHealthEvent, emit_health};

const DEFAULT_BUFFER_TIMEOUT: Duration = Duration::from_millis(100);
const MIN_BUFFER_TIMEOUT_WIRED: Duration = Duration::from_millis(20);
const MIN_BUFFER_TIMEOUT_WIRELESS: Duration = Duration::from_millis(90);
const MAX_BUFFER_TIMEOUT: Duration = Duration::from_millis(250);
const BUFFER_TIMEOUT_HEADROOM: f64 = 2.5;

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
}

pub struct AudioMixerBuilder {
    sources: Vec<MixerSource>,
    timestamps: Option<Timestamps>,
    master_clock: Option<Arc<MasterClock>>,
    health_tx: Option<HealthSender>,
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
        })
    }

    pub fn run(
        self,
        output: mpsc::Sender<AudioFrame>,
        ready_tx: oneshot::Sender<anyhow::Result<()>>,
        stop_flag: Arc<AtomicBool>,
    ) {
        let start = Timestamps::now();

        let mut mixer = match self.build(output) {
            Ok(mixer) => mixer,
            Err(e) => {
                tracing::error!("Failed to build audio mixer: {}", e);
                let _ = ready_tx.send(Err(e.into()));
                return;
            }
        };

        let _ = ready_tx.send(Ok(()));

        loop {
            if stop_flag.load(Ordering::Relaxed) {
                info!("Mixer stop flag triggered");
                break;
            }

            #[cfg(target_os = "macos")]
            let now = Timestamp::MachAbsoluteTime(cap_timestamp::MachAbsoluteTimestamp::now());
            #[cfg(windows)]
            let now =
                Timestamp::PerformanceCounter(cap_timestamp::PerformanceCounterTimestamp::now());
            #[cfg(not(any(target_os = "macos", windows)))]
            let now = Timestamp::Instant(Instant::now());

            if let Err(()) = mixer.tick(start, now) {
                info!("Mixer tick errored");
                break;
            }

            std::thread::sleep(Duration::from_millis(5));
        }
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
    ) {
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
            }
        }
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

    fn buffer_sources(&mut self, now: Timestamp) {
        let mut format_change: Option<(usize, AudioInfo, AudioInfo)> = None;
        let clock_anchor = self.master_clock.timestamps().instant();
        for (index, source) in self.sources.iter_mut().enumerate() {
            let rate = source.info.rate();
            let buffer_timeout = source.buffer_timeout;

            while let Ok(Some(AudioFrame {
                inner: frame,
                timestamp: raw_timestamp,
            })) = source.rx.try_next()
            {
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

                let remap =
                    source
                        .clock_state
                        .remap(&self.master_clock, raw_timestamp, frame_duration_ns);

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

                let timestamp = Timestamp::Instant(clock_anchor + remap.duration());

                if let Some((buffer_last_timestamp, buffer_last_duration)) = source.buffer_last {
                    let timestamp_elapsed = timestamp.duration_since(self.timestamps);
                    let buffer_last_elapsed = buffer_last_timestamp.duration_since(self.timestamps);

                    if timestamp_elapsed > buffer_last_elapsed {
                        let elapsed_since_last_frame =
                            timestamp_elapsed.saturating_sub(buffer_last_elapsed);

                        if let Some(gap) = elapsed_since_last_frame
                            .checked_sub(buffer_last_duration)
                            .filter(|&diff| diff >= buffer_timeout)
                        {
                            debug!(?gap, "Gap between last buffer frame, inserting silence");

                            let silence_samples_needed = (gap.as_secs_f64()) * rate as f64;
                            let silence_samples_count = silence_samples_needed.ceil() as usize;

                            let mut frame = ffmpeg::frame::Audio::new(
                                source.info.sample_format,
                                silence_samples_count,
                                source.info.channel_layout(),
                            );

                            for i in 0..frame.planes() {
                                frame.data_mut(i).fill(0);
                            }

                            frame.set_rate(source.info.rate() as u32);

                            let silence_duration =
                                Duration::from_secs_f64(silence_samples_count as f64 / rate as f64);
                            let timestamp = buffer_last_timestamp + buffer_last_duration;
                            source.buffer_last = Some((timestamp, silence_duration));
                            source.buffer.push_back(AudioFrame::new(frame, timestamp));
                        }
                    }
                }

                source.buffer_last = Some((
                    timestamp,
                    Duration::from_secs_f64(frame.samples() as f64 / rate as f64),
                ));
                source.buffer.push_back(AudioFrame::new(frame, timestamp));
            }
        }

        if let Some((index, old_info, new_info)) = format_change {
            self.handle_source_format_change(index, old_info, new_info);
        }

        if self.start_timestamp.is_none() {
            self.start_timestamp = self
                .sources
                .iter()
                .filter_map(|s| s.buffer.front())
                .min_by(|a, b| {
                    a.timestamp
                        .duration_since(self.timestamps)
                        .cmp(&b.timestamp.duration_since(self.timestamps))
                })
                .map(|v| v.timestamp);

            if self.start_timestamp.is_some() {
                self.wall_clock_start = Some(now);
            }
        }

        if let Some(start_timestamp) = self.start_timestamp
            && let Some(elapsed_since_start) = now
                .duration_since(self.timestamps)
                .checked_sub(start_timestamp.duration_since(self.timestamps))
            && elapsed_since_start > self.max_buffer_timeout
        {
            for source in &mut self.sources {
                if source.buffer_last.is_none() {
                    let rate = source.info.rate();
                    let buffer_timeout = source.buffer_timeout;

                    let mut remaining = elapsed_since_start;
                    while remaining > buffer_timeout {
                        let chunk_samples = samples_for_timeout(rate, buffer_timeout);
                        let frame_duration = duration_from_samples(chunk_samples, rate);

                        let mut frame = ffmpeg::frame::Audio::new(
                            source.info.sample_format,
                            chunk_samples,
                            source.info.channel_layout(),
                        );

                        for i in 0..frame.planes() {
                            frame.data_mut(i).fill(0);
                        }

                        frame.set_rate(source.info.rate() as u32);

                        let timestamp =
                            start_timestamp + elapsed_since_start.saturating_sub(remaining);
                        source.buffer_last = Some((timestamp, frame_duration));
                        source.buffer.push_front(AudioFrame::new(frame, timestamp));

                        if frame_duration.is_zero() {
                            break;
                        }

                        remaining = remaining.saturating_sub(frame_duration);
                    }
                }
            }
        }
    }

    fn tick(&mut self, _start: Timestamps, now: Timestamp) -> Result<(), ()> {
        self.buffer_sources(now);

        let Some(start_timestamp) = self.start_timestamp else {
            return Ok(());
        };

        let wall_now = Instant::now();
        let laggard = self.detect_laggard_source(now);
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

        for (i, source) in self.sources.iter_mut().enumerate() {
            for buffer in source.buffer.drain(..) {
                let _ = self.abuffers[i].source().add(&buffer.inner);
            }
        }

        let mut filtered = ffmpeg::frame::Audio::empty();
        while self.abuffersink.sink().frame(&mut filtered).is_ok() {
            let output_rate_i32 = Self::INFO.rate();

            filtered.set_rate(output_rate_i32 as u32);

            let output_timestamp = self.sample_based_output_timestamp(start_timestamp);

            let frame_samples = filtered.samples();
            let mut frame = AudioFrame::new(filtered, output_timestamp);

            loop {
                match self.output.try_send(frame) {
                    Ok(()) => break,
                    Err(err) if err.is_full() => {
                        frame = err.into_inner();
                        std::thread::sleep(Duration::from_millis(1));
                    }
                    Err(_) => return Err(()),
                }
            }

            self.samples_out += frame_samples;
            filtered = ffmpeg::frame::Audio::empty();
        }

        self.last_tick = Some(now);

        Ok(())
    }

    pub fn builder() -> AudioMixerBuilder {
        AudioMixerBuilder::new()
    }
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

fn duration_from_samples(samples: usize, rate: i32) -> Duration {
    if rate <= 0 {
        return Duration::ZERO;
    }

    Duration::from_secs_f64(samples as f64 / rate as f64)
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

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

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

            mixer.buffer_sources(Timestamp::Instant(mixer.timestamps.instant()));

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 3);
            assert!(source.rx.try_next().is_err());

            assert_eq!(
                source.buffer[1].timestamp.duration_since(mixer.timestamps),
                ONE_SECOND / 2
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

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

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

            mixer.buffer_sources(Timestamp::Instant(start.instant()));

            mixer.sources[0].buffer.clear();

            tx.send(AudioFrame::new(
                SOURCE_INFO.wrap_frame(&vec![0; SAMPLES_SECOND / 2]),
                Timestamp::Instant(start.instant() + ONE_SECOND),
            ))
            .await
            .unwrap();

            mixer.buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND));

            let source = &mut mixer.sources[0];

            assert_eq!(source.buffer.len(), 2);
            assert!(source.rx.try_next().is_err());

            let item = &source.buffer[0];
            assert_eq!(item.timestamp.duration_since(start), ONE_SECOND / 2);
            assert_eq!(item.inner.samples(), SOURCE_INFO.rate() as usize / 2);

            let item = &source.buffer[1];
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
            mixer.buffer_sources(Timestamp::Instant(start.instant() + ONE_SECOND));
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
            mixer.buffer_sources(far_future);

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
