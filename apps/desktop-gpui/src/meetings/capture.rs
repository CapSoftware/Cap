use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use cap_meeting_platform::resample::{SpeechResampler, downmix_interleaved};
use cap_meetings::{
    segment::{Segmenter, SegmenterConfig},
    transcript::Source,
};
use cap_recording::feeds::microphone::MicrophoneSamples;
use cap_timestamp::Timestamps;

use super::{
    audio_file::OpusOggWriter,
    timeline::{self, Aligner, Level, RATE, decode_interleaved},
};

const SOURCE_CHANNEL: usize = 256;
/// A capture clock that jumps further than this (a sleep the app was not
/// told about, a device that stalled) leaves a hole between two files rather
/// than that much silence written and encoded at once.
const MAX_PAD_SAMPLES: u64 = RATE as u64 * 30;
const STALL_AFTER: Duration = Duration::from_secs(3);
/// A microphone sending nothing but digital silence this long is muted or
/// broken; a quiet room is never this quiet.
const SILENT_AFTER: Duration = Duration::from_secs(120);
const LEVEL_INTERVAL: Duration = Duration::from_millis(100);
/// A caption pass hears only the audio after the words it already agreed
/// on (engine.rs `LiveSegment`), so it costs about the same early and late
/// in a segment and can run every second.
const PARTIAL_EVERY_SAMPLES: u64 = RATE as u64 / 2;
const PARTIAL_MIN_SAMPLES: usize = RATE as usize;
const PARTIAL_GROWTH_SAMPLES: usize = RATE as usize;

/// Debug builds: `CAP_GPUI_MEETING_PARTIAL=<every_ms>,<min_ms>,<growth_ms>`
/// overrides the caption cadence (measurements).
fn partial_cadence() -> (u64, usize, usize) {
    static CADENCE: std::sync::OnceLock<(u64, usize, usize)> = std::sync::OnceLock::new();
    *CADENCE.get_or_init(|| {
        let default = (
            PARTIAL_EVERY_SAMPLES,
            PARTIAL_MIN_SAMPLES,
            PARTIAL_GROWTH_SAMPLES,
        );
        if !cfg!(debug_assertions) {
            return default;
        }
        let Ok(value) = std::env::var("CAP_GPUI_MEETING_PARTIAL") else {
            return default;
        };
        let ms: Vec<u64> = value
            .split(',')
            .filter_map(|v| v.trim().parse().ok())
            .collect();
        let samples = |ms: u64| ms * u64::from(RATE) / 1000;
        match ms.as_slice() {
            [every, min, growth] => (
                samples(*every),
                samples(*min) as usize,
                samples(*growth) as usize,
            ),
            _ => default,
        }
    })
}

/// About -80 dBFS: below any real microphone's noise floor.
const SOUND_PEAK: f32 = 1e-4;
/// A failed audio file is tried again as a new part this often.
const WRITER_RETRY: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HealthIssue {
    MissingPermission,
    NoInputDevice,
    TapUnsupported,
    NoCallbacks,
    Failed(String),
}

impl HealthIssue {
    pub fn describe(&self) -> String {
        match self {
            HealthIssue::MissingPermission => {
                "Permission to capture this audio was not granted".into()
            }
            HealthIssue::NoInputDevice => "No microphone is connected".into(),
            HealthIssue::TapUnsupported => {
                "Capturing computer audio is not supported on this system".into()
            }
            HealthIssue::NoCallbacks => "No audio is arriving from this source".into(),
            HealthIssue::Failed(reason) => reason.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum SourceHealth {
    #[default]
    Off,
    Starting,
    Ok,
    Silent,
    Error(HealthIssue),
}

impl SourceHealth {
    pub fn is_error(&self) -> bool {
        matches!(self, SourceHealth::Error(_))
    }
}

#[derive(Clone, Debug)]
pub struct SegmentJob {
    pub source: Source,
    pub start_sample: u64,
    pub samples: Vec<f32>,
    pub speech_ms: u64,
}

impl SegmentJob {
    pub fn start_ms(&self) -> u64 {
        timeline::samples_to_ms(self.start_sample)
    }

    pub fn utterance_id(&self) -> String {
        utterance_id(self.source, self.start_sample)
    }
}

pub fn utterance_id(source: Source, start_sample: u64) -> String {
    let tag = match source {
        Source::Mic => 'm',
        Source::System => 's',
    };
    format!("{tag}{start_sample}")
}

#[derive(Clone, Debug)]
pub enum CaptureEvent {
    Level {
        source: Source,
        level: f32,
    },
    Health {
        source: Source,
        health: SourceHealth,
    },
    Speech {
        source: Source,
        ms: u64,
    },
    /// The track's audio file could not be written (a full disk, usually).
    AudioFailed {
        source: Source,
    },
    /// After a failure, the track goes on in a new file from this point.
    AudioPart {
        source: Source,
        path: PathBuf,
        offset_samples: u64,
    },
}

#[derive(Debug, Default)]
pub struct SourceCounters {
    pub batches: AtomicU64,
    pub dropped_batches: AtomicU64,
    pub dropped_segments: AtomicU64,
    pub real_chunks: AtomicU64,
    pub written_samples: AtomicU64,
    pub padded_samples: AtomicU64,
    pub skipped_samples: AtomicU64,
    pub gaps: AtomicU64,
    pub drift_corrections: AtomicU64,
    pub offset_samples: AtomicI64,
    pub speech_ms: AtomicU64,
    /// When real audio last arrived, in ms since capture began plus one
    /// (0: never). Filled-in silence does not count.
    pub real_at_ms: AtomicU64,
    /// When the track last carried any sound at all (same clock).
    pub sound_at_ms: AtomicU64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStats {
    pub batches: u64,
    pub dropped_batches: u64,
    pub dropped_segments: u64,
    pub written_ms: u64,
    pub padded_ms: u64,
    pub skipped_ms: u64,
    pub gaps: u64,
    pub drift_corrections: u64,
    pub offset_ms: i64,
    pub speech_ms: u64,
    pub real_at_ms: u64,
    pub sound_at_ms: u64,
}

impl SourceCounters {
    pub fn snapshot(&self) -> SourceStats {
        let ms = |a: &AtomicU64| timeline::samples_to_ms(a.load(Ordering::Relaxed));
        SourceStats {
            batches: self.batches.load(Ordering::Relaxed),
            dropped_batches: self.dropped_batches.load(Ordering::Relaxed),
            dropped_segments: self.dropped_segments.load(Ordering::Relaxed),
            written_ms: ms(&self.written_samples),
            padded_ms: ms(&self.padded_samples),
            skipped_ms: ms(&self.skipped_samples),
            gaps: self.gaps.load(Ordering::Relaxed),
            drift_corrections: self.drift_corrections.load(Ordering::Relaxed),
            offset_ms: self.offset_samples.load(Ordering::Relaxed) * 1000 / i64::from(RATE),
            speech_ms: self.speech_ms.load(Ordering::Relaxed),
            real_at_ms: self.real_at_ms.load(Ordering::Relaxed),
            sound_at_ms: self.sound_at_ms.load(Ordering::Relaxed),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapCounters {
    pub callbacks: u64,
    pub empty_callbacks: u64,
    pub frames: u64,
    pub dropped: u64,
    pub restarts: u64,
    /// Rebuilding stopped after every attempt failed.
    pub gave_up: bool,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub mic: Option<SourceStats>,
    pub system: Option<SourceStats>,
    pub tap: Option<TapCounters>,
}

#[derive(Clone, Debug, Default)]
pub struct SourceSummary {
    pub duration_ms: u64,
    pub speech_ms: u64,
    pub file: Option<PathBuf>,
    pub stats: SourceStats,
}

#[derive(Clone, Debug, Default)]
pub struct CaptureSummary {
    pub mic: Option<SourceSummary>,
    pub system: Option<SourceSummary>,
    pub tap: Option<TapCounters>,
}

pub struct RawBatch {
    pub data: Vec<u8>,
    pub format: cpal::SampleFormat,
    pub sample_rate: u32,
    pub channels: u16,
    pub captured: Instant,
}

pub enum MicInput {
    Feed(flume::Receiver<MicrophoneSamples>),
    Raw(flume::Receiver<RawBatch>),
}

pub struct CaptureConfig {
    pub audio_dir: Option<PathBuf>,
    pub file_suffix: String,
    pub timeline_offset_samples: u64,
    pub mic: Result<MicInput, HealthIssue>,
    pub system: bool,
    pub live_partials: bool,
    pub segments: flume::Sender<SegmentJob>,
    pub partials: flume::Sender<SegmentJob>,
    pub missed: flume::Sender<super::engine::Missed>,
    pub engine_busy: Arc<AtomicBool>,
    pub events: flume::Sender<CaptureEvent>,
}

pub fn audio_stem(source: Source) -> &'static str {
    match source {
        Source::Mic => "you",
        Source::System => "others",
    }
}

pub fn audio_file_name(source: Source, suffix: &str) -> String {
    format!("{}{suffix}.ogg", audio_stem(source))
}

struct SourceThread {
    stop: Option<flume::Sender<()>>,
    thread: Option<JoinHandle<SourceSummary>>,
    counters: Arc<SourceCounters>,
}

impl SourceThread {
    fn finish(mut self) -> Option<SourceSummary> {
        drop(self.stop.take());
        self.thread.take().and_then(|t| t.join().ok())
    }
}

pub struct MeetingCapture {
    mic: Option<SourceThread>,
    system: Option<SourceThread>,
    platform: Option<SystemPlatform>,
    origin_wall: chrono::DateTime<chrono::Utc>,
}

enum SystemChunk {
    Samples {
        samples: Vec<f32>,
        sample_rate: u32,
        synthetic: bool,
        received: Instant,
    },
}

impl MeetingCapture {
    pub fn start(config: CaptureConfig) -> Self {
        let origin = Timestamps::now();
        let origin_wall = chrono::Utc::now();
        let shared = Shared {
            origin,
            audio_dir: config.audio_dir.clone(),
            suffix: config.file_suffix.clone(),
            offset: config.timeline_offset_samples,
            live_partials: config.live_partials,
            segments: config.segments.clone(),
            partials: config.partials.clone(),
            missed: config.missed.clone(),
            engine_busy: config.engine_busy.clone(),
            events: config.events.clone(),
        };

        let mic = match config.mic {
            Ok(input) => Some(spawn_source(
                Source::Mic,
                shared.clone(),
                match input {
                    MicInput::Feed(rx) => SourceInput::Mic(rx),
                    MicInput::Raw(rx) => SourceInput::Raw(rx),
                },
            )),
            Err(issue) => {
                let _ = shared.events.send(CaptureEvent::Health {
                    source: Source::Mic,
                    health: SourceHealth::Error(issue),
                });
                None
            }
        };

        let (system, platform) = if config.system {
            match SystemPlatform::start() {
                Ok((platform, chunks)) => (
                    Some(spawn_source(
                        Source::System,
                        shared.clone(),
                        SourceInput::System(chunks),
                    )),
                    Some(platform),
                ),
                Err(issue) => {
                    let _ = shared.events.send(CaptureEvent::Health {
                        source: Source::System,
                        health: SourceHealth::Error(issue),
                    });
                    (None, None)
                }
            }
        } else {
            (None, None)
        };

        Self {
            mic,
            system,
            platform,
            origin_wall,
        }
    }

    pub fn origin_wall(&self) -> chrono::DateTime<chrono::Utc> {
        self.origin_wall
    }

    pub fn has_source(&self, source: Source) -> bool {
        match source {
            Source::Mic => self.mic.is_some(),
            Source::System => self.system.is_some(),
        }
    }

    /// What the capture itself knows of the outputs the computer plays
    /// through, as a value to compare between looks. Linux: the default
    /// and the output a call was followed to, as the sink watch last saw
    /// them. macOS: how many times the audio system said the default output
    /// changed (the tap listens for it). Windows: the output a call was
    /// followed to, if any (the default is added by [`output_identity`]).
    /// Cheap: no audio system call.
    pub fn outputs_seen(&self) -> Option<String> {
        #[cfg(target_os = "linux")]
        {
            self.platform
                .as_ref()
                .and_then(|platform| platform.outputs.lock().ok()?.clone())
        }
        #[cfg(target_os = "macos")]
        {
            let platform = self.platform.as_ref()?;
            let changes = platform.tap.lock().ok()?.stats().output_changes;
            let replaced = platform.replaced.load(Ordering::Relaxed);
            Some(format!("{replaced}:{changes}"))
        }
        #[cfg(windows)]
        {
            self.platform
                .as_ref()
                .and_then(|platform| platform.followed.lock().ok()?.clone())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        {
            None
        }
    }

    /// Starts the computer-audio capture again (it stopped delivering).
    pub fn restart_system(&self) {
        if let Some(platform) = self.platform.as_ref() {
            platform.restart();
        }
    }

    pub fn stats(&self) -> CaptureStats {
        CaptureStats {
            mic: self.mic.as_ref().map(|s| s.counters.snapshot()),
            system: self.system.as_ref().map(|s| s.counters.snapshot()),
            tap: self.platform.as_ref().and_then(SystemPlatform::counters),
        }
    }

    pub fn stop(mut self) -> CaptureSummary {
        let tap = self.platform.as_ref().and_then(SystemPlatform::counters);
        drop(self.platform.take());
        CaptureSummary {
            mic: self.mic.take().and_then(SourceThread::finish),
            system: self.system.take().and_then(SourceThread::finish),
            tap,
        }
    }
}

impl Drop for MeetingCapture {
    fn drop(&mut self) {
        drop(self.platform.take());
        if let Some(mic) = self.mic.take() {
            mic.finish();
        }
        if let Some(system) = self.system.take() {
            system.finish();
        }
    }
}

#[derive(Clone)]
struct Shared {
    origin: Timestamps,
    audio_dir: Option<PathBuf>,
    suffix: String,
    offset: u64,
    live_partials: bool,
    segments: flume::Sender<SegmentJob>,
    partials: flume::Sender<SegmentJob>,
    missed: flume::Sender<super::engine::Missed>,
    engine_busy: Arc<AtomicBool>,
    events: flume::Sender<CaptureEvent>,
}

enum SourceInput {
    Mic(flume::Receiver<MicrophoneSamples>),
    Raw(flume::Receiver<RawBatch>),
    System(flume::Receiver<SystemChunk>),
}

enum Message {
    Mic(MicrophoneSamples),
    Raw(RawBatch),
    System(SystemChunk),
    Stop,
}

fn spawn_source(source: Source, shared: Shared, input: SourceInput) -> SourceThread {
    let (stop_tx, stop_rx) = flume::bounded::<()>(1);
    let counters = Arc::new(SourceCounters::default());
    let thread = std::thread::Builder::new()
        .name(match source {
            Source::Mic => "cap-meeting-mic".into(),
            Source::System => "cap-meeting-system".into(),
        })
        .spawn({
            let counters = counters.clone();
            move || {
                crate::transcription::lower_thread_priority();
                let mut worker = SourceWorker::new(source, shared, counters);
                worker.run(input, stop_rx);
                worker.finish()
            }
        })
        .ok();
    SourceThread {
        stop: Some(stop_tx),
        thread,
        counters,
    }
}

struct SourceWorker {
    source: Source,
    shared: Shared,
    counters: Arc<SourceCounters>,
    aligner: Aligner,
    segmenter: Segmenter,
    resampler: Option<SpeechResampler>,
    writer: Option<OpusOggWriter>,
    /// When the file last failed, so a new part is tried a while later.
    writer_failed: Option<Instant>,
    writer_parts: u32,
    level: Level,
    decoded: Vec<f32>,
    mono: Vec<f32>,
    out: Vec<f32>,
    health: SourceHealth,
    started: Instant,
    last_data: Option<Instant>,
    last_sound: Instant,
    last_level_sent: Option<(Instant, f32)>,
    since_partial: u64,
    last_partial: Option<(u64, usize)>,
    debug_segments: u64,
}

impl SourceWorker {
    fn new(source: Source, shared: Shared, counters: Arc<SourceCounters>) -> Self {
        let now = Instant::now();
        Self {
            source,
            shared,
            counters,
            aligner: Aligner::default(),
            segmenter: Segmenter::new(match source {
                Source::Mic => SegmenterConfig::microphone(),
                Source::System => SegmenterConfig::default(),
            }),
            resampler: None,
            writer: None,
            writer_failed: None,
            writer_parts: 0,
            level: Level::default(),
            decoded: Vec::new(),
            mono: Vec::new(),
            out: Vec::new(),
            health: SourceHealth::Off,
            started: now,
            last_data: None,
            last_sound: now,
            last_level_sent: None,
            since_partial: 0,
            last_partial: None,
            debug_segments: 0,
        }
    }

    fn run(&mut self, input: SourceInput, stop: flume::Receiver<()>) {
        self.set_health(SourceHealth::Starting);
        loop {
            let wait = flume::Selector::new().recv(&stop, |_| Message::Stop);
            let wait = match &input {
                SourceInput::Mic(rx) => wait.recv(rx, |r| r.map_or(Message::Stop, Message::Mic)),
                SourceInput::Raw(rx) => wait.recv(rx, |r| r.map_or(Message::Stop, Message::Raw)),
                SourceInput::System(rx) => {
                    wait.recv(rx, |r| r.map_or(Message::Stop, Message::System))
                }
            };
            match wait.wait_timeout(Duration::from_secs(1)) {
                Ok(Message::Stop) => break,
                Ok(Message::Mic(batch)) => {
                    let start_secs = batch
                        .timestamp
                        .signed_duration_since_secs(self.shared.origin);
                    self.on_interleaved(
                        &batch.data,
                        batch.format,
                        batch.channels,
                        batch.sample_rate,
                        start_secs,
                    );
                }
                Ok(Message::Raw(batch)) => {
                    let start_secs = match batch
                        .captured
                        .checked_duration_since(self.shared.origin.instant())
                    {
                        Some(after) => after.as_secs_f64(),
                        None => -self
                            .shared
                            .origin
                            .instant()
                            .saturating_duration_since(batch.captured)
                            .as_secs_f64(),
                    };
                    self.on_interleaved(
                        &batch.data,
                        batch.format,
                        batch.channels,
                        batch.sample_rate,
                        start_secs,
                    );
                }
                Ok(Message::System(chunk)) => self.on_system(chunk),
                Err(_) => {}
            }
            self.check_health();
        }
    }

    fn check_health(&mut self) {
        let now = Instant::now();
        let stalled = match self.last_data {
            Some(at) => now.duration_since(at) > STALL_AFTER,
            None => now.duration_since(self.started) > STALL_AFTER,
        };
        let next = if stalled {
            SourceHealth::Error(HealthIssue::NoCallbacks)
        } else if self.last_data.is_none() {
            SourceHealth::Starting
        } else if self.source == Source::Mic && now.duration_since(self.last_sound) > SILENT_AFTER {
            SourceHealth::Silent
        } else {
            SourceHealth::Ok
        };
        if matches!(self.health, SourceHealth::Error(HealthIssue::Failed(_))) {
            return;
        }
        self.set_health(next);
    }

    fn set_health(&mut self, health: SourceHealth) {
        if self.health != health {
            self.health = health.clone();
            let _ = self.shared.events.send(CaptureEvent::Health {
                source: self.source,
                health,
            });
        }
    }

    fn on_interleaved(
        &mut self,
        data: &[u8],
        format: cpal::SampleFormat,
        channels: u16,
        sample_rate: u32,
        start_secs: f64,
    ) {
        self.counters.batches.fetch_add(1, Ordering::Relaxed);
        self.decoded.clear();
        if !decode_interleaved(data, format, &mut self.decoded) {
            return;
        }
        self.mono.clear();
        downmix_interleaved(&self.decoded, usize::from(channels.max(1)), &mut self.mono);
        let frames = self.mono.len();
        self.ingest(sample_rate.max(1), start_secs, frames);
    }

    fn on_system(&mut self, chunk: SystemChunk) {
        let SystemChunk::Samples {
            samples,
            sample_rate,
            synthetic,
            received,
        } = chunk;
        self.counters.batches.fetch_add(1, Ordering::Relaxed);
        if !synthetic {
            self.counters.real_chunks.fetch_add(1, Ordering::Relaxed);
        }
        if !synthetic {
            self.mark(&self.counters.real_at_ms);
        }
        let rate = sample_rate.max(1);
        let duration = samples.len() as f64 / f64::from(rate);
        let received_secs = received
            .checked_duration_since(self.shared.origin.instant())
            .map_or(0.0, |d| d.as_secs_f64());
        self.mono = samples;
        let frames = self.mono.len();
        self.ingest(rate, received_secs - duration, frames);
    }

    /// Stamps a counter with the time since capture began (plus one, so 0
    /// stays "never").
    fn mark(&self, at: &AtomicU64) {
        let ms = self.shared.origin.instant().elapsed().as_millis() as u64;
        at.store(ms + 1, Ordering::Relaxed);
    }

    fn ingest(&mut self, rate: u32, start_secs: f64, frames: usize) {
        if frames == 0 {
            return;
        }
        let now = Instant::now();
        self.last_data = Some(now);
        if self.source == Source::Mic {
            self.mark(&self.counters.real_at_ms);
        }
        if self.mono.iter().any(|x| x.abs() > SOUND_PEAK) {
            self.last_sound = now;
            self.mark(&self.counters.sound_at_ms);
        }
        if self
            .resampler
            .as_ref()
            .is_none_or(|r| r.input_rate() != rate)
        {
            self.out.clear();
            if let Some(mut previous) = self.resampler.take() {
                previous.flush(&mut self.out);
            }
            self.resampler = Some(SpeechResampler::new(rate));
        } else {
            self.out.clear();
        }
        if let Some(resampler) = self.resampler.as_mut() {
            resampler.process(&self.mono, &mut self.out);
        }
        if self.out.is_empty() {
            return;
        }
        let observed = timeline::seconds_to_samples(start_secs);
        self.place(observed);
        self.publish_stats();

        let level = self.level.push(&self.out);
        let due = self.last_level_sent.is_none_or(|(at, value)| {
            now.duration_since(at) >= LEVEL_INTERVAL && (value - level).abs() > 0.005
        });
        if due {
            self.last_level_sent = Some((now, level));
            let _ = self.shared.events.send(CaptureEvent::Level {
                source: self.source,
                level,
            });
        }
    }

    fn place(&mut self, observed: i64) {
        let out = std::mem::take(&mut self.out);
        let base = self.aligner.written();
        let placement = self.aligner.place(observed, out.len());
        if placement.pad > MAX_PAD_SAMPLES {
            self.jump();
        } else if placement.pad > 0 {
            self.push_silence(base, placement.pad);
        }
        let kept = &out[placement.skip.min(out.len())..];
        self.push_samples(base + placement.pad, kept);
        self.out = out;
    }

    /// Ends the track's file; the next audio starts a new part where it
    /// lands, and the segmenter closes what was open at the jump.
    fn jump(&mut self) {
        if let Some(mut writer) = self.writer.take() {
            if let Err(error) = writer.finish() {
                tracing::warn!(%error, "meeting audio did not finish cleanly");
            }
            self.writer_parts += 1;
        }
        tracing::info!(source = ?self.source, "meeting audio jumped ahead, continuing in a new file");
    }

    fn push_silence(&mut self, start: u64, samples: u64) {
        let block = vec![0.0f32; RATE as usize];
        let mut done = 0u64;
        while done < samples {
            let n = (samples - done).min(block.len() as u64) as usize;
            self.push_samples(start + done, &block[..n]);
            done += n as u64;
        }
    }

    fn push_samples(&mut self, position: u64, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        self.write_audio(position, samples);
        for segment in self.segmenter.push(position, samples) {
            self.emit_segment(segment);
        }
        self.since_partial += samples.len() as u64;
        if self.since_partial >= partial_cadence().0 {
            self.since_partial = 0;
            self.offer_partial();
        }
    }

    /// Saves the track. A failed file stops; a while later the track goes
    /// on in a new part that starts where it stands now, so the meeting's
    /// audio has a hole rather than an end.
    fn write_audio(&mut self, position: u64, samples: &[f32]) {
        if self
            .writer_failed
            .is_some_and(|at| at.elapsed() < WRITER_RETRY)
        {
            return;
        }
        let Some(dir) = self.shared.audio_dir.clone() else {
            return;
        };
        if self.writer.is_none() {
            let suffix = match self.writer_parts {
                0 => self.shared.suffix.clone(),
                n => format!("{}.r{n}", self.shared.suffix),
            };
            let path = dir.join(audio_file_name(self.source, &suffix));
            match OpusOggWriter::create(&path) {
                Ok(writer) => {
                    if self.writer_parts > 0 {
                        tracing::info!(path = %path.display(), "meeting audio continues in a new file");
                        let _ = self.shared.events.send(CaptureEvent::AudioPart {
                            source: self.source,
                            path: path.clone(),
                            offset_samples: self.shared.offset + position,
                        });
                    }
                    self.writer_failed = None;
                    self.writer = Some(writer);
                }
                Err(error) => {
                    tracing::warn!(%error, "could not create the meeting audio file");
                    self.audio_failed();
                    return;
                }
            }
        }
        if let Some(writer) = self.writer.as_mut()
            && let Err(error) = writer.write(samples)
        {
            tracing::warn!(%error, "meeting audio write failed");
            // Its pages up to here stay readable; the next part starts fresh.
            if let Some(mut broken) = self.writer.take() {
                let _ = broken.finish();
            }
            self.audio_failed();
        }
    }

    fn audio_failed(&mut self) {
        if self.writer_failed.is_none() {
            let _ = self.shared.events.send(CaptureEvent::AudioFailed {
                source: self.source,
            });
        }
        self.writer_failed = Some(Instant::now());
        self.writer_parts += 1;
    }

    fn emit_segment(&mut self, segment: cap_meetings::segment::SpeechSegment) {
        self.counters
            .speech_ms
            .fetch_add(segment.speech_ms, Ordering::Relaxed);
        let _ = self.shared.events.send(CaptureEvent::Speech {
            source: self.source,
            ms: segment.speech_ms,
        });
        let job = SegmentJob {
            source: self.source,
            start_sample: self.shared.offset + segment.start_sample,
            samples: segment.samples,
            speech_ms: segment.speech_ms,
        };
        // Debug builds: CAP_GPUI_MEETING_DROP_EVERY=n treats every n-th
        // segment as if the queue were full.
        if cfg!(debug_assertions)
            && let Some(every) = std::env::var("CAP_GPUI_MEETING_DROP_EVERY")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|n| *n > 0)
        {
            self.debug_segments += 1;
            if self.debug_segments % every == 0 {
                tracing::info!(start = job.start_sample, "debug: dropping a segment");
                self.missed(&job);
                return;
            }
        }
        // Debug builds: CAP_GPUI_MEETING_LOSE_EVERY=n loses every n-th segment
        // outright, as if the segmenter never saw that speech: only the
        // after-Stop sweep can find it again.
        if cfg!(debug_assertions)
            && let Some(every) = std::env::var("CAP_GPUI_MEETING_LOSE_EVERY")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|n| *n > 0)
        {
            self.debug_segments += 1;
            if self.debug_segments % every == 0 {
                tracing::info!(start = job.start_sample, "debug: losing a segment");
                return;
            }
        }
        if let Err(flume::TrySendError::Full(job) | flume::TrySendError::Disconnected(job)) =
            self.shared.segments.try_send(job)
        {
            self.missed(&job);
        }
    }

    /// The transcriber is behind: the segment's audio is on disk, so it goes
    /// in the ledger to be transcribed again rather than being lost.
    fn missed(&self, job: &SegmentJob) {
        self.counters
            .dropped_segments
            .fetch_add(1, Ordering::Relaxed);
        let _ = self.shared.missed.send(super::engine::Missed {
            source: job.source,
            start_sample: job.start_sample,
            len: job.samples.len() as u64,
        });
    }

    fn offer_partial(&mut self) {
        if !self.shared.live_partials
            || self.shared.engine_busy.load(Ordering::Acquire)
            || !self.shared.segments.is_empty()
            || self.shared.partials.is_full()
        {
            return;
        }
        let Some((start, samples)) = self.segmenter.open_snapshot() else {
            return;
        };
        let (_, min, growth) = partial_cadence();
        if samples.len() < min {
            return;
        }
        if let Some((previous_start, previous_len)) = self.last_partial
            && previous_start == start
            && samples.len() < previous_len + growth
        {
            return;
        }
        let len = samples.len();
        let job = SegmentJob {
            source: self.source,
            start_sample: self.shared.offset + start,
            samples: samples.to_vec(),
            speech_ms: 0,
        };
        if self.shared.partials.try_send(job).is_ok() {
            self.last_partial = Some((start, len));
        }
    }

    fn publish_stats(&self) {
        let stats = self.aligner.stats();
        let c = &self.counters;
        c.written_samples
            .store(self.aligner.written(), Ordering::Relaxed);
        c.padded_samples
            .store(stats.padded_samples, Ordering::Relaxed);
        c.skipped_samples
            .store(stats.skipped_samples, Ordering::Relaxed);
        c.gaps.store(stats.gaps, Ordering::Relaxed);
        c.drift_corrections
            .store(stats.drift_corrections, Ordering::Relaxed);
        c.offset_samples
            .store(stats.offset_samples, Ordering::Relaxed);
    }

    fn finish(mut self) -> SourceSummary {
        if let Some(mut resampler) = self.resampler.take() {
            self.out.clear();
            resampler.flush(&mut self.out);
            if !self.out.is_empty() {
                let observed = self.aligner.written() as i64;
                self.place(observed);
            }
        }
        if let Some(segment) = self.segmenter.flush() {
            let job = SegmentJob {
                source: self.source,
                start_sample: self.shared.offset + segment.start_sample,
                samples: segment.samples,
                speech_ms: segment.speech_ms,
            };
            self.counters
                .speech_ms
                .fetch_add(job.speech_ms, Ordering::Relaxed);
            let _ = self.shared.events.send(CaptureEvent::Speech {
                source: self.source,
                ms: job.speech_ms,
            });
            // Never waits: Stop joins this thread on the UI thread, and the
            // ledger gets the segment transcribed from disk after Stop.
            if let Err(flume::TrySendError::Full(job) | flume::TrySendError::Disconnected(job)) =
                self.shared.segments.try_send(job)
            {
                self.missed(&job);
            }
        }
        self.publish_stats();
        let file = self.writer.take().map(|mut writer| {
            if let Err(error) = writer.finish() {
                tracing::warn!(%error, "meeting audio did not finish cleanly");
            }
            writer.path().to_path_buf()
        });
        let _ = self.shared.events.send(CaptureEvent::Level {
            source: self.source,
            level: 0.0,
        });
        SourceSummary {
            duration_ms: timeline::samples_to_ms(self.aligner.written()),
            speech_ms: self.segmenter.speech_ms_total(),
            file,
            stats: self.counters.snapshot(),
        }
    }
}

#[cfg(target_os = "macos")]
struct SystemPlatform {
    tap: std::sync::Mutex<cap_meeting_platform::SystemAudioTap>,
    sink: TapSink,
    /// Whole new taps started because the old one's thread had ended.
    replaced: AtomicU64,
}

/// What a tap's callback writes to: kept so a tap whose thread ended can be
/// replaced by a new one feeding the same track.
#[cfg(target_os = "macos")]
#[derive(Clone)]
struct TapSink {
    tx: flume::Sender<SystemChunk>,
    dropped: Arc<AtomicU64>,
    /// Debug builds: a simulated dead tap that a restart brings back.
    revived: Arc<AtomicBool>,
    dead_after: Option<Duration>,
    started: Instant,
}

#[cfg(target_os = "macos")]
impl TapSink {
    fn open(&self) -> Result<cap_meeting_platform::SystemAudioTap, cap_meeting_platform::TapError> {
        let sink = self.clone();
        cap_meeting_platform::SystemAudioTap::start(true, move |chunk| {
            if sink.dead_after.is_some_and(|after| sink.started.elapsed() >= after)
                && !sink.revived.load(Ordering::Relaxed)
            {
                return;
            }
            let message = SystemChunk::Samples {
                samples: chunk.samples.to_vec(),
                sample_rate: chunk.sample_rate,
                synthetic: chunk.synthetic,
                received: Instant::now(),
            };
            if sink.tx.try_send(message).is_err() {
                sink.dropped.fetch_add(1, Ordering::Relaxed);
            }
        })
    }
}

#[cfg(target_os = "macos")]
impl SystemPlatform {
    fn start() -> Result<(Self, flume::Receiver<SystemChunk>), HealthIssue> {
        use cap_meeting_platform::{AudioCapturePermission, audio_capture_permission};
        if !cap_meeting_platform::system_tap_supported() {
            return Err(HealthIssue::TapUnsupported);
        }
        if audio_capture_permission() == AudioCapturePermission::Denied {
            return Err(HealthIssue::MissingPermission);
        }
        let (tx, rx) = flume::bounded::<SystemChunk>(SOURCE_CHANNEL);
        let sink = TapSink {
            tx,
            dropped: Arc::new(AtomicU64::new(0)),
            revived: Arc::new(AtomicBool::new(false)),
            // Debug builds: CAP_GPUI_MEETING_TAP_DEAD=<s> stops all computer
            // audio (real and filled-in) that many seconds in, until a restart.
            dead_after: cfg!(debug_assertions)
                .then(|| std::env::var("CAP_GPUI_MEETING_TAP_DEAD").ok())
                .flatten()
                .and_then(|v| v.parse::<u64>().ok())
                .map(Duration::from_secs),
            started: Instant::now(),
        };
        let tap = sink.open().map_err(|error| match error {
            cap_meeting_platform::TapError::Unsupported => HealthIssue::TapUnsupported,
            other => HealthIssue::Failed(format!("Computer audio capture failed: {other}")),
        })?;
        Ok((
            Self {
                tap: std::sync::Mutex::new(tap),
                sink,
                replaced: AtomicU64::new(0),
            },
            rx,
        ))
    }

    fn counters(&self) -> Option<TapCounters> {
        let tap = self.tap.lock().ok()?;
        let stats = tap.stats();
        Some(TapCounters {
            callbacks: stats.callbacks,
            empty_callbacks: stats.empty_callbacks,
            frames: stats.frames,
            dropped: stats.dropped + self.sink.dropped.load(Ordering::Relaxed),
            restarts: stats.restarts + self.replaced.load(Ordering::Relaxed),
            gave_up: stats.gave_up || !tap.alive(),
        })
    }

    /// Builds the tap again; if its thread has ended (the audio service
    /// went away under it), a whole new tap takes its place.
    fn restart(&self) {
        self.sink.revived.store(true, Ordering::Relaxed);
        let Ok(mut tap) = self.tap.lock() else {
            return;
        };
        if tap.alive() {
            tap.rebuild();
            return;
        }
        match self.sink.open() {
            Ok(fresh) => {
                tracing::warn!("computer audio capture had stopped; started a new one");
                self.replaced.fetch_add(1, Ordering::Relaxed);
                *tap = fresh;
            }
            Err(error) => tracing::warn!(%error, "computer audio capture could not start again"),
        }
    }
}

/// Windows: what the default output plays (scap_cpal), or, while a call
/// plays only to another output (Teams, Zoom and browser calls play to the
/// default communications device, often a headset), that output alone. See
/// `cap_meeting_platform::CallOutputWatch` for which output a call is on.
#[cfg(windows)]
struct SystemPlatform {
    stop: Option<flume::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    /// Looks for the output a call plays to.
    watch: Option<cap_meeting_platform::CallOutputWatch>,
    /// The output a call was followed to; `None` while the default is read.
    followed: Arc<std::sync::Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
    callbacks: Arc<AtomicU64>,
    restarts: Arc<AtomicU64>,
    /// Set by a stream error or a restart request: the loop opens the
    /// loopback again.
    failed: Arc<AtomicBool>,
}

#[cfg(windows)]
enum WindowsLoopback {
    Default(scap_cpal::Capturer),
    /// The output a call was followed to, by endpoint id.
    Call(cap_meeting_platform::EndpointLoopback, String),
    /// While a screen reader runs: what the computer plays, without the
    /// reader's speech.
    ReaderFree(cap_meeting_platform::ReaderFreeLoopback),
    /// Only the call's processes, by endpoint id: on a followed output a
    /// screen reader plays to as well (true), or on the default output while
    /// a reader runs and other outputs play (false).
    CallOnly(cap_meeting_platform::ReaderFreeLoopback, String, bool),
}

#[cfg(windows)]
impl WindowsLoopback {
    fn stop(self) {
        match self {
            Self::Default(capturer) => {
                let _ = capturer.pause();
            }
            Self::Call(loopback, _) => drop(loopback),
            Self::ReaderFree(loopback) | Self::CallOnly(loopback, _, _) => drop(loopback),
        }
    }

    fn followed(&self) -> Option<String> {
        match self {
            Self::Default(_) | Self::ReaderFree(_) | Self::CallOnly(_, _, false) => None,
            Self::Call(_, id) | Self::CallOnly(_, id, true) => Some(id.clone()),
        }
    }
}

/// How long an output that would not open is left alone while the call
/// stays on it (the default output is read meanwhile).
#[cfg(windows)]
const REFUSED_RETRY: Duration = Duration::from_secs(30);

/// A process loopback (reader-free or call-only) that delivers only exact
/// digital silence, or nothing at all, for this long...
#[cfg_attr(not(windows), allow(dead_code))]
const SILENCE_NET_AFTER_MS: u64 = 8_000;
/// ...while what it reads was heard (its audio session's meter) at this many
/// looks of the call output watch, is not hearing the meeting.
#[cfg_attr(not(windows), allow(dead_code))]
const SILENCE_NET_LOOKS: u64 = 2;

/// Whether a running process loopback has gone silent while what it reads
/// plays (see [`SILENCE_NET_AFTER_MS`]). A quiet meeting never trips it:
/// nothing it reads is heard then.
#[derive(Debug, Default)]
#[cfg_attr(not(windows), allow(dead_code))]
struct SilenceNet {
    sound_ms: u64,
    base: u64,
}

#[cfg_attr(not(windows), allow(dead_code))]
impl SilenceNet {
    /// `sound_ms`: when the capture last delivered a sample that was not
    /// silence, or opened; `audible_looks`: a running count of looks that
    /// heard what it reads.
    fn observe(&mut self, now_ms: u64, sound_ms: u64, audible_looks: u64) -> bool {
        if sound_ms != self.sound_ms {
            self.sound_ms = sound_ms;
            self.base = audible_looks;
        }
        now_ms.saturating_sub(sound_ms) >= SILENCE_NET_AFTER_MS
            && audible_looks.saturating_sub(self.base) >= SILENCE_NET_LOOKS
    }
}

/// Windows: only the default output's capture, exactly as before (no
/// followed output, no screen reader left out): in a remote desktop session,
/// whose audio is redirected; without the call output watch, which the
/// silence net needs (`netted`); and for the rest of a meeting once a process
/// loopback went silent while what it reads played.
#[cfg_attr(not(windows), allow(dead_code))]
fn plain_only(remote: bool, netted: bool, gone_silent: bool) -> bool {
    remote || !netted || gone_silent
}

/// The meeting runs in a remote desktop session. Test builds:
/// `CAP_GPUI_TEST_REMOTE_SESSION=<path>` makes it one while that file exists.
#[cfg(windows)]
fn remote_session() -> bool {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("CAP_GPUI_TEST_REMOTE_SESSION") {
        return std::path::Path::new(&path).exists();
    }
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTESESSION};
    unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
}

/// When a process loopback last delivered a sample that was not digital
/// silence (or opened), in ms since `epoch`.
#[cfg(windows)]
struct LastSound {
    epoch: Instant,
    at_ms: AtomicU64,
}

#[cfg(windows)]
impl LastSound {
    fn new() -> Self {
        Self {
            epoch: Instant::now(),
            at_ms: AtomicU64::new(0),
        }
    }

    fn now_ms(&self) -> u64 {
        self.epoch.elapsed().as_millis() as u64
    }

    fn mark(&self) {
        self.at_ms.store(self.now_ms(), Ordering::Relaxed);
    }

    fn at_ms(&self) -> u64 {
        self.at_ms.load(Ordering::Relaxed)
    }
}

#[cfg(windows)]
impl SystemPlatform {
    fn start() -> Result<(Self, flume::Receiver<SystemChunk>), HealthIssue> {
        use cpal::traits::{DeviceTrait, HostTrait};

        fn device_name() -> String {
            cpal::default_host()
                .default_output_device()
                .and_then(|d| d.name().ok())
                .unwrap_or_default()
        }

        fn capturer(
            tx: flume::Sender<SystemChunk>,
            dropped: Arc<AtomicU64>,
            callbacks: Arc<AtomicU64>,
            failed: Arc<AtomicBool>,
        ) -> Result<scap_cpal::Capturer, scap_cpal::CapturerError> {
            let mut decoded = Vec::new();
            scap_cpal::create_capturer(
                move |data, _info, config| {
                    callbacks.fetch_add(1, Ordering::Relaxed);
                    decoded.clear();
                    if !decode_interleaved(data.bytes(), data.sample_format(), &mut decoded) {
                        return;
                    }
                    let mut mono = Vec::with_capacity(decoded.len());
                    downmix_interleaved(&decoded, usize::from(config.channels.max(1)), &mut mono);
                    let message = SystemChunk::Samples {
                        samples: mono,
                        sample_rate: config.sample_rate.0,
                        synthetic: false,
                        received: Instant::now(),
                    };
                    if tx.try_send(message).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
                move |error| {
                    tracing::warn!("meeting loopback stream error: {error}");
                    failed.store(true, Ordering::Relaxed);
                },
            )
        }

        fn follower(
            id: &str,
            tx: flume::Sender<SystemChunk>,
            dropped: Arc<AtomicU64>,
            callbacks: Arc<AtomicU64>,
            failed: Arc<AtomicBool>,
        ) -> Result<cap_meeting_platform::EndpointLoopback, String> {
            cap_meeting_platform::EndpointLoopback::start(
                id.to_string(),
                move |samples, sample_rate| {
                    callbacks.fetch_add(1, Ordering::Relaxed);
                    let message = SystemChunk::Samples {
                        samples: samples.to_vec(),
                        sample_rate,
                        synthetic: false,
                        received: Instant::now(),
                    };
                    if tx.try_send(message).is_err() {
                        dropped.fetch_add(1, Ordering::Relaxed);
                    }
                },
                failed,
            )
        }

        fn reader_free(
            reader: u32,
            call: Option<u32>,
            tx: flume::Sender<SystemChunk>,
            dropped: Arc<AtomicU64>,
            callbacks: Arc<AtomicU64>,
            failed: Arc<AtomicBool>,
            sound: Arc<LastSound>,
        ) -> Result<cap_meeting_platform::ReaderFreeLoopback, String> {
            // Test builds: `CAP_GPUI_TEST_READER_FREE_ZEROS` makes the capture
            // deliver silence, to prove the silence net.
            #[cfg(debug_assertions)]
            let zeroed = std::env::var_os("CAP_GPUI_TEST_READER_FREE_ZEROS").is_some();
            #[cfg(not(debug_assertions))]
            let zeroed = false;
            sound.mark();
            let sink = move |samples: &[f32], sample_rate: u32| {
                callbacks.fetch_add(1, Ordering::Relaxed);
                let samples = if zeroed {
                    vec![0.0; samples.len()]
                } else {
                    samples.to_vec()
                };
                if samples.iter().any(|sample| *sample != 0.0) {
                    sound.mark();
                }
                let message = SystemChunk::Samples {
                    samples,
                    sample_rate,
                    synthetic: false,
                    received: Instant::now(),
                };
                if tx.try_send(message).is_err() {
                    dropped.fetch_add(1, Ordering::Relaxed);
                }
            };
            match call {
                Some(call) => cap_meeting_platform::ReaderFreeLoopback::start_call_only(
                    call, reader, sink, failed,
                ),
                None => cap_meeting_platform::ReaderFreeLoopback::start(reader, sink, failed),
            }
        }

        let (tx, rx) = flume::bounded::<SystemChunk>(SOURCE_CHANNEL);
        let dropped = Arc::new(AtomicU64::new(0));
        let callbacks = Arc::new(AtomicU64::new(0));
        let restarts = Arc::new(AtomicU64::new(0));
        let failed = Arc::new(AtomicBool::new(false));
        let followed = Arc::new(std::sync::Mutex::new(None));

        let (target_tx, target_rx) = flume::unbounded::<Option<String>>();
        let watch = cap_meeting_platform::CallOutputWatch::start(Duration::from_secs(2), target_tx)
            .inspect_err(|error| tracing::warn!(%error, "could not look for a call's output; computer audio is read from the default output as before"))
            .ok();
        // The first look decides where a meeting that starts mid-call reads
        // from; it takes a few milliseconds.
        let mut target = if watch.is_some() {
            target_rx
                .recv_timeout(Duration::from_millis(1500))
                .ok()
                .flatten()
        } else {
            None
        };
        let mut refused: Option<(String, Instant)> = None;
        let mut first = None;
        let remote = remote_session();
        if remote {
            tracing::info!(
                "a remote desktop session: computer audio is read from the default output as before"
            );
        }
        let sound = Arc::new(LastSound::new());
        if !remote && let Some(id) = target.as_deref() {
            match follower(
                id,
                tx.clone(),
                dropped.clone(),
                callbacks.clone(),
                failed.clone(),
            ) {
                Ok(loopback) => {
                    tracing::info!(output = %id, "meeting computer audio follows the call to another output");
                    first = Some(WindowsLoopback::Call(loopback, id.to_string()));
                }
                Err(error) => {
                    tracing::warn!(%error, output = %id, "could not read the call's output; reading the default output");
                    refused = Some((id.to_string(), Instant::now()));
                }
            }
        }
        // A screen reader running as the meeting starts: read everything
        // but its speech; if that cannot open, read the default as before.
        let mut reader_refused: Option<(u32, Instant)> = None;
        // A refusal is logged once per meeting; retries after it stay quiet.
        let mut reader_told = false;
        // The same for a reader on a followed call's output, by (call, reader).
        let mut call_only_refused: Option<((u32, u32), Instant)> = None;
        let mut call_only_told = false;
        if first.is_none()
            && !plain_only(remote, watch.is_some(), false)
            && let Some(reader) = cap_meeting_platform::running_reader()
        {
            match reader_free(
                reader,
                None,
                tx.clone(),
                dropped.clone(),
                callbacks.clone(),
                failed.clone(),
                sound.clone(),
            ) {
                Ok(loopback) => {
                    tracing::info!(
                        "a screen reader is running; its speech is left out of computer audio"
                    );
                    first = Some(WindowsLoopback::ReaderFree(loopback));
                }
                Err(error) => {
                    tracing::warn!(%error, "could not leave the screen reader's speech out of computer audio; recording as before");
                    reader_told = true;
                    reader_refused = Some((reader, Instant::now()));
                }
            }
        }
        let first = match first {
            Some(first) => first,
            None => {
                let first = capturer(
                    tx.clone(),
                    dropped.clone(),
                    callbacks.clone(),
                    failed.clone(),
                )
                .map_err(|error| match error {
                    scap_cpal::CapturerError::NoDevice => HealthIssue::NoInputDevice,
                    other => HealthIssue::Failed(format!("Computer audio capture failed: {other}")),
                })?;
                first.play().map_err(|e| {
                    HealthIssue::Failed(format!("Computer audio capture failed: {e}"))
                })?;
                WindowsLoopback::Default(first)
            }
        };
        if let Ok(mut slot) = followed.lock() {
            *slot = first.followed();
        }
        let watching = watch.is_some();
        let call_info = watch
            .as_ref()
            .map(cap_meeting_platform::CallOutputWatch::followed);
        let meter = watch
            .as_ref()
            .map(cap_meeting_platform::CallOutputWatch::meter);
        let audible_looks = watch
            .as_ref()
            .map(cap_meeting_platform::CallOutputWatch::audible_looks);
        let (stop_tx, stop_rx) = flume::bounded::<()>(1);
        let thread = std::thread::Builder::new()
            .name("cap-meeting-loopback".into())
            .spawn({
                let dropped = dropped.clone();
                let callbacks = callbacks.clone();
                let restarts = restarts.clone();
                let failed = failed.clone();
                let followed = followed.clone();
                move || {
                    enum Woke {
                        Stop,
                        Target(Option<String>),
                        WatchGone,
                    }
                    let mut targets = watching.then_some(target_rx);
                    let mut current = Some(first);
                    let mut name = device_name();
                    let mut was_remote = remote;
                    let mut net = SilenceNet::default();
                    let mut gone_silent = false;
                    loop {
                        let selector = flume::Selector::new().recv(&stop_rx, |_| Woke::Stop);
                        let selector = match targets.as_ref() {
                            Some(targets) => selector.recv(targets, |message| match message {
                                Ok(target) => Woke::Target(target),
                                Err(_) => Woke::WatchGone,
                            }),
                            None => selector,
                        };
                        match selector.wait_timeout(Duration::from_secs(2)) {
                            Ok(Woke::Stop) => break,
                            Ok(Woke::Target(next)) => target = next,
                            Ok(Woke::WatchGone) => {
                                targets = None;
                                target = None;
                            }
                            Err(_) => {}
                        }
                        let errored = failed.swap(false, Ordering::Relaxed);
                        let remote = remote_session();
                        if remote != was_remote {
                            was_remote = remote;
                            if remote {
                                tracing::info!("a remote desktop session: computer audio is read from the default output as before");
                            } else {
                                tracing::info!("the remote desktop session ended");
                            }
                        }
                        // A process loopback that stays silent while what it
                        // reads plays: the default output for the rest of the
                        // meeting.
                        let meant = match &current {
                            Some(WindowsLoopback::ReaderFree(free)) => {
                                Some(cap_meeting_platform::Meant::AllBut(free.reader()))
                            }
                            Some(WindowsLoopback::CallOnly(only, _, _)) => {
                                only.call().map(cap_meeting_platform::Meant::Tree)
                            }
                            _ => None,
                        };
                        if let Some(meter) = &meter
                            && let Ok(mut slot) = meter.lock()
                        {
                            *slot = meant;
                        }
                        if meant.is_some()
                            && !gone_silent
                            && let Some(audible) = &audible_looks
                            && net.observe(
                                sound.now_ms(),
                                sound.at_ms(),
                                audible.load(Ordering::Relaxed),
                            )
                        {
                            gone_silent = true;
                            tracing::warn!("computer audio stayed silent while the meeting played; the default output is read as before for the rest of the meeting");
                        }
                        let plain = plain_only(remote, watching, gone_silent);
                        if refused
                            .as_ref()
                            .is_some_and(|(id, at)| Some(id) != target.as_ref() || at.elapsed() >= REFUSED_RETRY)
                        {
                            refused = None;
                        }
                        let wanted = target.clone().filter(|_| refused.is_none() && !plain);
                        // A screen reader matters only while the default
                        // output is read: a followed call's output does not
                        // carry the reader's speech.
                        if reader_refused
                            .as_ref()
                            .is_some_and(|(_, at)| at.elapsed() >= REFUSED_RETRY)
                        {
                            reader_refused = None;
                        }
                        let reader = if wanted.is_none() && !plain {
                            cap_meeting_platform::running_reader().filter(|pid| {
                                reader_refused.as_ref().is_none_or(|(refused, _)| refused != pid)
                            })
                        } else {
                            None
                        };
                        // A followed output a screen reader plays to as well:
                        // only the call is read there. Otherwise following is
                        // as before.
                        if call_only_refused
                            .as_ref()
                            .is_some_and(|(_, at)| at.elapsed() >= REFUSED_RETRY)
                        {
                            call_only_refused = None;
                        }
                        let there = call_info
                            .as_ref()
                            .filter(|_| !plain)
                            .and_then(|info| info.lock().ok()?.clone());
                        // The default output read while a reader runs and
                        // another output plays: leaving out only the reader
                        // would take that output in too. The call alone is
                        // read when it is known; otherwise the default output
                        // as before.
                        let others = wanted.is_none()
                            && reader.zip(there.as_ref()).is_some_and(|(pid, there)| {
                                there.elsewhere.iter().any(|other| *other != pid)
                            });
                        // Never when the call's process tree also plays on
                        // another output: reading the tree would take that
                        // output in too.
                        let call_only = match wanted.as_deref() {
                            Some(id) => there.as_ref().and_then(|there| {
                                let call = there
                                    .call
                                    .filter(|_| there.endpoint == id && !there.call_elsewhere)?;
                                let reader = cap_meeting_platform::running_reader()?;
                                there
                                    .on_output
                                    .contains(&reader)
                                    .then(|| (call, reader, id.to_string(), true))
                            }),
                            None if others => there.as_ref().and_then(|there| {
                                let call = there.call.filter(|_| !there.call_elsewhere)?;
                                Some((call, reader?, there.endpoint.clone(), false))
                            }),
                            None => None,
                        }
                        .filter(|(call, pid, _, _)| {
                            call_only_refused
                                .as_ref()
                                .is_none_or(|(refused, _)| *refused != (*call, *pid))
                        });
                        let reader = if others && call_only.is_none() { None } else { reader };
                        if let Some((call, pid, id, follows)) = call_only {
                            if let Some(WindowsLoopback::CallOnly(only, at, was)) = &current
                                && only.call() == Some(call)
                                && only.reader() == pid
                                && *at == id
                                && *was == follows
                                && !errored
                            {
                                continue;
                            }
                            match reader_free(
                                pid,
                                Some(call),
                                tx.clone(),
                                dropped.clone(),
                                callbacks.clone(),
                                failed.clone(),
                                sound.clone(),
                            ) {
                                Ok(loopback) => {
                                    if let Some(old) = current.take() {
                                        old.stop();
                                    }
                                    restarts.fetch_add(1, Ordering::Relaxed);
                                    if follows {
                                        tracing::info!(output = %id, "a screen reader plays to the call's output; only the call is read there");
                                    } else {
                                        tracing::info!(output = %id, "a screen reader runs and another output plays; only the call is read");
                                    }
                                    if let Ok(mut slot) = followed.lock() {
                                        *slot = follows.then(|| id.clone());
                                    }
                                    current = Some(WindowsLoopback::CallOnly(loopback, id, follows));
                                    continue;
                                }
                                Err(error) => {
                                    if call_only_told {
                                        tracing::debug!(%error, "the call-only loopback was refused again");
                                    } else {
                                        tracing::warn!(%error, "could not leave the screen reader's speech out of the call's output; recording as before");
                                        call_only_told = true;
                                    }
                                    call_only_refused = Some(((call, pid), Instant::now()));
                                }
                            }
                        }
                        match (&current, &wanted, reader) {
                            (Some(WindowsLoopback::ReaderFree(free)), None, Some(pid))
                                if free.reader() == pid && !errored =>
                            {
                                continue;
                            }
                            (Some(WindowsLoopback::ReaderFree(_)), None, None)
                                if !errored && !plain =>
                            {
                                // The reader quit: the default output opens
                                // before the reader-free loopback stops. (Main's
                                // capture only: the loopback stops first, below.)
                                if let Ok(next) = capturer(
                                    tx.clone(),
                                    dropped.clone(),
                                    callbacks.clone(),
                                    failed.clone(),
                                ) && next.play().is_ok()
                                {
                                    if let Some(old) = current.take() {
                                        old.stop();
                                    }
                                    name = device_name();
                                    restarts.fetch_add(1, Ordering::Relaxed);
                                    current = Some(WindowsLoopback::Default(next));
                                    if others {
                                        tracing::info!("another output plays and the call alone cannot be read; the default output is read as before");
                                    } else {
                                        tracing::info!("the screen reader quit; computer audio is read as before");
                                    }
                                }
                                continue;
                            }
                            (_, None, Some(pid)) => {
                                // A reader runs: the reader-free loopback
                                // opens before what runs now stops; if it
                                // cannot open, what runs now goes on.
                                match reader_free(
                                    pid,
                                    None,
                                    tx.clone(),
                                    dropped.clone(),
                                    callbacks.clone(),
                                    failed.clone(),
                                    sound.clone(),
                                ) {
                                    Ok(loopback) => {
                                        if let Some(old) = current.take() {
                                            old.stop();
                                        }
                                        restarts.fetch_add(1, Ordering::Relaxed);
                                        current = Some(WindowsLoopback::ReaderFree(loopback));
                                        tracing::info!("a screen reader is running; its speech is left out of computer audio");
                                        if let Ok(mut slot) = followed.lock() {
                                            *slot = None;
                                        }
                                        continue;
                                    }
                                    Err(error) => {
                                        if reader_told {
                                            tracing::debug!(%error, "the reader-free loopback was refused again");
                                        } else {
                                            tracing::warn!(%error, "could not leave the screen reader's speech out of computer audio; recording as before");
                                            reader_told = true;
                                        }
                                        reader_refused = Some((pid, Instant::now()));
                                        if matches!(current, Some(WindowsLoopback::Default(_)))
                                            && !errored
                                        {
                                            continue;
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                        match (&current, &wanted) {
                            (Some(WindowsLoopback::Default(_)) | None, None) => {
                                let now_name = device_name();
                                if now_name == name && !errored && current.is_some() {
                                    continue;
                                }
                                name = now_name;
                            }
                            (Some(WindowsLoopback::Call(_, id)), Some(want))
                                if id == want && !errored =>
                            {
                                continue;
                            }
                            _ => {}
                        }
                        let was_following = current.as_ref().and_then(WindowsLoopback::followed);
                        if let Some(old) = current.take() {
                            old.stop();
                        }
                        if let Some(id) = wanted.as_deref() {
                            match follower(
                                id,
                                tx.clone(),
                                dropped.clone(),
                                callbacks.clone(),
                                failed.clone(),
                            ) {
                                Ok(loopback) => {
                                    tracing::info!(output = %id, "meeting computer audio follows the call to another output");
                                    restarts.fetch_add(1, Ordering::Relaxed);
                                    current = Some(WindowsLoopback::Call(loopback, id.to_string()));
                                }
                                Err(error) => {
                                    tracing::warn!(%error, output = %id, "could not read the call's output; reading the default output");
                                    refused = Some((id.to_string(), Instant::now()));
                                }
                            }
                        }
                        if current.is_none() {
                            if was_following.is_some() {
                                name = device_name();
                                tracing::info!("meeting computer audio is back on the default output");
                            }
                            match capturer(
                                tx.clone(),
                                dropped.clone(),
                                callbacks.clone(),
                                failed.clone(),
                            ) {
                                Ok(next) => {
                                    if next.play().is_ok() {
                                        restarts.fetch_add(1, Ordering::Relaxed);
                                        current = Some(WindowsLoopback::Default(next));
                                    }
                                }
                                Err(error) => {
                                    tracing::warn!(%error, "meeting loopback restart failed");
                                }
                            }
                        }
                        if let Ok(mut slot) = followed.lock() {
                            *slot = current.as_ref().and_then(WindowsLoopback::followed);
                        }
                    }
                    if let Some(old) = current.take() {
                        old.stop();
                    }
                }
            })
            .map_err(|e| HealthIssue::Failed(e.to_string()))?;
        Ok((
            Self {
                stop: Some(stop_tx),
                thread: Some(thread),
                watch,
                followed,
                dropped,
                callbacks,
                restarts,
                failed,
            },
            rx,
        ))
    }

    fn counters(&self) -> Option<TapCounters> {
        Some(TapCounters {
            callbacks: self.callbacks.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            restarts: self.restarts.load(Ordering::Relaxed),
            ..TapCounters::default()
        })
    }

    fn restart(&self) {
        self.failed.store(true, Ordering::Relaxed);
    }
}

#[cfg(windows)]
impl Drop for SystemPlatform {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        drop(self.watch.take());
    }
}

/// Linux: what the speakers play, read from the default output's monitor
/// through `parec` (PulseAudio or PipeWire's Pulse server; the same tools
/// meeting detection already uses). Mono float at 48 kHz, 20 ms reads. If
/// the stream ends (server restart, device gone) it is opened again.
#[cfg(target_os = "linux")]
struct SystemPlatform {
    stop: Arc<AtomicBool>,
    child: Arc<std::sync::Mutex<Option<std::process::Child>>>,
    thread: Option<JoinHandle<()>>,
    /// Picks the output to read (`sink.rs`) and restarts the reader on a change.
    watch: Option<JoinHandle<()>>,
    /// The default output and the one followed, as the watch last saw them.
    outputs: Arc<std::sync::Mutex<Option<String>>>,
    dropped: Arc<AtomicU64>,
    callbacks: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
    restarts: Arc<AtomicU64>,
}

#[cfg(target_os = "linux")]
const MONITOR_RATE: u32 = 48_000;

#[cfg(any(target_os = "linux", test))]
mod reader_free;
#[cfg(any(target_os = "linux", test))]
mod sink;

/// The output a meeting's computer audio is read from: `None` is the default.
#[cfg(target_os = "linux")]
type SinkTarget = Arc<std::sync::Mutex<Option<String>>>;

#[cfg(target_os = "linux")]
const SINK_CHECK_EVERY: Duration = Duration::from_secs(2);

#[cfg(target_os = "linux")]
fn pactl(args: &[&str]) -> String {
    std::process::Command::new("pactl")
        .args(args)
        .env("LC_ALL", "C")
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .map(|out| String::from_utf8_lossy(&out.stdout).into_owned())
        .unwrap_or_default()
}

#[cfg(target_os = "linux")]
/// One look at the sound server: the output to read (`None`: the default),
/// whether the reader `reader` (a `parec` pid) sits on that output's
/// monitor (`None` when pactl does not say), the default output, and
/// whether a screen reader's speech stream exists.
fn look_at_outputs(reader: Option<u32>) -> (Option<String>, Option<bool>, Option<String>, bool) {
    let default = sink::parse_default_sink(&pactl(&["info"]));
    let recording = sink::parse_streams(&pactl(&["list", "source-outputs"]), "Source");
    let playing = sink::parse_streams(&pactl(&["list", "sink-inputs"]), "Sink");
    // A screen reader's speech stream, and a screen reader running: the
    // process scan only happens when such a stream exists.
    let reading_aloud = playing
        .iter()
        .any(|stream| reader_free::is_reader_stream(&stream.app))
        && reader_free::screen_reader_running();
    let target = sink::choose(
        &sink::parse_sinks(&pactl(&["list", "short", "sinks"])),
        default.as_deref(),
        &playing,
        &recording,
        std::process::id(),
    );
    let placed = reader
        .zip(target.clone().or(default.clone()))
        .and_then(|(pid, output)| {
            let sources = sink::parse_sinks(&pactl(&["list", "short", "sources"]));
            sink::reader_on_monitor(&sources, &recording, pid, &output)
        });
    (target, placed, default, reading_aloud)
}

#[cfg(target_os = "linux")]
fn spawn_monitor_reader(sink: Option<&str>) -> std::io::Result<std::process::Child> {
    let default = match sink {
        Some(_) => None,
        None => sink::parse_default_sink(&pactl(&["info"])),
    };
    let device = format!(
        "--device={}",
        sink::monitor_device(sink, default.as_deref())
    );
    std::process::Command::new("parec")
        .args([
            device.as_str(),
            "--raw",
            "--format=float32le",
            "--rate=48000",
            "--channels=1",
            "--latency-msec=20",
            "--client-name=Cap",
            "--stream-name=Cap meeting audio",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
}

/// Whether [`output_identity`] has to ask the audio system (Windows), which
/// can take a while while devices change: then it runs off the UI thread.
pub const OUTPUT_IDENTITY_ASKS: bool = cfg!(windows);

/// Which outputs the computer plays through, as a value to compare between
/// looks: a change means the speakers may have given way to a headset.
/// `seen` is [`MeetingCapture::outputs_seen`]. `None` when nothing says.
pub fn output_identity(seen: Option<String>) -> Option<String> {
    #[cfg(windows)]
    {
        use cpal::traits::{DeviceTrait, HostTrait};
        let default = cpal::default_host()
            .default_output_device()
            .and_then(|device| device.name().ok());
        match seen {
            Some(followed) => Some(format!("{} > {followed}", default.unwrap_or_default())),
            None => default,
        }
    }
    #[cfg(not(windows))]
    {
        seen
    }
}

/// Whether this Linux session can give Cap what the speakers play.
#[cfg(target_os = "linux")]
pub fn system_audio_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        std::process::Command::new("parec")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

#[cfg(target_os = "linux")]
impl SystemPlatform {
    fn start() -> Result<(Self, flume::Receiver<SystemChunk>), HealthIssue> {
        if !system_audio_available() {
            return Err(HealthIssue::TapUnsupported);
        }
        let (tx, rx) = flume::bounded::<SystemChunk>(SOURCE_CHANNEL);
        let counters = MonitorCounters::default();
        // A screen reader already speaking (PipeWire): Cap's reader-free
        // capture comes first, so its speech never reaches the meeting even
        // for a moment. Otherwise the default; the watch looks at once, off
        // this thread.
        let info = pactl(&["info"]);
        let pipewire = reader_free::on_pipewire(&info);
        let mut free = None;
        let mut told = false;
        if pipewire
            && sink::parse_streams(&pactl(&["list", "sink-inputs"]), "Sink")
                .iter()
                .any(|stream| reader_free::is_reader_stream(&stream.app))
            && reader_free::screen_reader_running()
            && let Some(default) = sink::parse_default_sink(&info)
        {
            match reader_free::ReaderFree::start(&default, reader_free_sink(&tx, &counters)) {
                Ok(made) => {
                    tracing::info!(
                        "a screen reader is speaking; its speech is left out of computer audio"
                    );
                    made.go_live();
                    free = Some(made);
                }
                Err(error) => {
                    tracing::warn!(%error, "could not leave the screen reader's speech out of computer audio; recording as before");
                    told = true;
                }
            }
        }
        let target: SinkTarget = Arc::new(std::sync::Mutex::new(
            free.as_ref().map(|_| reader_free::NODE.to_string()),
        ));
        let first = if free.is_some() {
            None
        } else {
            let first = spawn_monitor_reader(None)
                .map_err(|e| HealthIssue::Failed(format!("Computer audio capture failed: {e}")))?;
            Some(first)
        };
        let stop = Arc::new(AtomicBool::new(false));
        let child = Arc::new(std::sync::Mutex::new(first));
        let thread = std::thread::Builder::new()
            .name("cap-meeting-monitor".into())
            .spawn({
                let (stop, child, counters, target) = (
                    stop.clone(),
                    child.clone(),
                    counters.clone(),
                    target.clone(),
                );
                let tx = tx.clone();
                move || run_monitor(&stop, &child, &tx, &counters, &target)
            })
            .map_err(|e| HealthIssue::Failed(e.to_string()))?;
        let outputs = Arc::new(std::sync::Mutex::new(None));
        let watch = std::thread::Builder::new()
            .name("cap-meeting-sink-watch".into())
            .spawn({
                let (stop, child, target) = (stop.clone(), child.clone(), target.clone());
                let outputs = outputs.clone();
                let monitor = thread.thread().clone();
                let reader = ReaderState {
                    pipewire,
                    free,
                    told,
                    tx,
                    counters: counters.clone(),
                };
                move || watch_sink(&stop, &child, &target, &outputs, &monitor, reader)
            })
            .ok();
        Ok((
            Self {
                stop,
                child,
                thread: Some(thread),
                watch,
                outputs,
                dropped: counters.dropped,
                callbacks: counters.callbacks,
                frames: counters.frames,
                restarts: counters.restarts,
            },
            rx,
        ))
    }

    fn counters(&self) -> Option<TapCounters> {
        Some(TapCounters {
            callbacks: self.callbacks.load(Ordering::Relaxed),
            frames: self.frames.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            restarts: self.restarts.load(Ordering::Relaxed),
            ..TapCounters::default()
        })
    }

    /// Ends the reader; the monitor loop opens a new one a second later.
    fn restart(&self) {
        if let Ok(mut slot) = self.child.lock()
            && let Some(child) = slot.as_mut()
        {
            let _ = child.kill();
        }
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Default)]
struct MonitorCounters {
    dropped: Arc<AtomicU64>,
    /// The monitor reader's deliveries.
    callbacks: Arc<AtomicU64>,
    frames: Arc<AtomicU64>,
    restarts: Arc<AtomicU64>,
    /// The reader-free capture's deliveries.
    reader_free: Arc<AtomicU64>,
}

/// Where Cap's reader-free capture delivers: the meeting's channel, as the
/// monitor reader does.
#[cfg(target_os = "linux")]
fn reader_free_sink(
    tx: &flume::Sender<SystemChunk>,
    counters: &MonitorCounters,
) -> impl FnMut(&[f32]) + Send + 'static {
    let (tx, counters) = (tx.clone(), counters.clone());
    move |samples| {
        counters.reader_free.fetch_add(1, Ordering::Relaxed);
        counters
            .frames
            .fetch_add(samples.len() as u64, Ordering::Relaxed);
        let message = SystemChunk::Samples {
            samples: samples.to_vec(),
            sample_rate: MONITOR_RATE,
            synthetic: false,
            received: Instant::now(),
        };
        if tx.try_send(message).is_err() {
            counters.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// What the meeting's start learned about a screen reader (Linux).
#[cfg(target_os = "linux")]
struct ReaderState {
    /// The sound server is PipeWire's.
    pipewire: bool,
    /// The reader-free capture, when a reader was speaking at the start.
    free: Option<reader_free::ReaderFree>,
    /// A refusal was already logged.
    told: bool,
    /// The meeting's channel and counters, for a reader-free capture made
    /// later.
    tx: flume::Sender<SystemChunk>,
    counters: MonitorCounters,
}

/// Every couple of seconds: when the call moved to another output (or
/// started on one), the reader is ended so the monitor loop opens that one.
#[cfg(target_os = "linux")]
fn watch_sink(
    stop: &AtomicBool,
    child: &std::sync::Mutex<Option<std::process::Child>>,
    target: &SinkTarget,
    outputs: &std::sync::Mutex<Option<String>>,
    monitor: &std::thread::Thread,
    reader: ReaderState,
) {
    let ReaderState {
        pipewire,
        mut free,
        mut told,
        tx,
        counters,
    } = reader;
    // While a screen reader speaks (PipeWire only), the meeting reads a sink
    // that has everything but the reader's speech. Built before the monitor
    // moves to it, so a failure leaves today's reading untouched. A refusal
    // is logged once per meeting.
    let mut refused: Option<Instant> = told.then(Instant::now);
    let mut told_pulse = false;
    loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        // Our capture stream died with the sound server: the monitor reader
        // takes over again, and a new capture is tried after the usual wait.
        if free.as_ref().is_some_and(|free| free.failed()) {
            tracing::warn!("the reader-free capture stopped; computer audio is read as before");
            free = None;
            refused = Some(Instant::now());
        }
        let reader = child
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|c| c.id()));
        let (next, placed, default, reading_aloud) = look_at_outputs(reader);
        let reading = next.clone().or(default.clone());
        if reading_aloud && !pipewire && !told_pulse {
            told_pulse = true;
            tracing::info!(
                "a screen reader is speaking; on PulseAudio its speech stays in computer audio"
            );
        }
        if reading_aloud && pipewire {
            match (&free, reading.as_deref()) {
                (Some(free), Some(output)) => free.follow(output),
                (None, Some(output))
                    if refused.is_none_or(|at| at.elapsed() >= Duration::from_secs(30)) =>
                {
                    match reader_free::ReaderFree::start(output, reader_free_sink(&tx, &counters)) {
                        Ok(made) => {
                            tracing::info!(
                                "a screen reader is speaking; its speech is left out of computer audio"
                            );
                            free = Some(made);
                        }
                        Err(error) => {
                            if told {
                                tracing::debug!(%error, "the reader-free sink was refused again");
                            } else {
                                tracing::warn!(%error, "could not leave the screen reader's speech out of computer audio; recording as before");
                                told = true;
                            }
                            refused = Some(Instant::now());
                        }
                    }
                }
                _ => {}
            }
        }
        let leaving = !reading_aloud && free.is_some();
        let reader_free_now = reading_aloud && free.is_some();
        // The reader sits on our sink's monitor then, not the output's.
        let placed = if reader_free_now { None } else { placed };
        let next = if reader_free_now {
            Some(reader_free::NODE.to_string())
        } else {
            next
        };
        if let Ok(mut seen) = outputs.lock() {
            *seen = default.map(|default| match &next {
                Some(followed) => format!("{default} > {followed}"),
                None => default,
            });
        }
        let Ok(mut current) = target.lock() else {
            return;
        };
        if *current != next {
            if next.as_deref() == Some(reader_free::NODE) {
                tracing::info!(from = ?*current, "the meeting's computer audio moves to the reader-free capture");
            } else if leaving {
                tracing::info!(to = ?next, "the screen reader's stream ended; computer audio is read as before");
            } else {
                tracing::info!(from = ?*current, to = ?next, "the meeting's computer audio follows the call to another output");
            }
            *current = next;
        } else if placed == Some(false) {
            // PulseAudio moves a recording off a monitor when the default
            // input changes (a headset's microphone gone and back).
            tracing::warn!(
                "meeting computer audio was moved off the output's monitor; reopening it"
            );
        } else {
            drop(current);
            std::thread::park_timeout(SINK_CHECK_EVERY);
            continue;
        }
        drop(current);
        if let Ok(mut slot) = child.lock()
            && let Some(child) = slot.as_mut()
        {
            let _ = child.kill();
        }
        // Our capture takes over as the monitor reader stops.
        if reader_free_now && let Some(free) = &free {
            free.go_live();
        }
        // The monitor loop opens the new output now, not a second later.
        monitor.unpark();
        if leaving {
            // Our capture goes once the monitor reader delivers again (or
            // after a second).
            let delivered = counters.callbacks.load(Ordering::Relaxed);
            let waited = Instant::now();
            loop {
                if counters.callbacks.load(Ordering::Relaxed) != delivered
                    || waited.elapsed() >= Duration::from_secs(1)
                {
                    break;
                }
                std::thread::park_timeout(Duration::from_millis(10));
            }
            free = None;
        }
        std::thread::park_timeout(SINK_CHECK_EVERY);
    }
}

/// Reads the monitor until stopped; a stream that ends on its own is opened
/// again a second later.
#[cfg(target_os = "linux")]
fn run_monitor(
    stop: &AtomicBool,
    child: &std::sync::Mutex<Option<std::process::Child>>,
    tx: &flume::Sender<SystemChunk>,
    counters: &MonitorCounters,
    target: &SinkTarget,
) {
    use std::io::Read;
    const READ: usize = (MONITOR_RATE as usize / 50) * 4;
    let mut bytes = vec![0u8; READ];
    for _ in 0.. {
        if stop.load(Ordering::Acquire) {
            return;
        }
        let stdout = child
            .lock()
            .ok()
            .and_then(|mut c| c.as_mut().and_then(|c| c.stdout.take()));
        if let Some(mut stdout) = stdout {
            while stdout.read_exact(&mut bytes).is_ok() {
                counters.callbacks.fetch_add(1, Ordering::Relaxed);
                let samples: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .collect();
                counters
                    .frames
                    .fetch_add(samples.len() as u64, Ordering::Relaxed);
                let message = SystemChunk::Samples {
                    samples,
                    sample_rate: MONITOR_RATE,
                    synthetic: false,
                    received: Instant::now(),
                };
                if tx.try_send(message).is_err() {
                    counters.dropped.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        if let Ok(mut slot) = child.lock()
            && let Some(mut old) = slot.take()
        {
            let _ = old.kill();
            let _ = old.wait();
        }
        if stop.load(Ordering::Acquire) {
            return;
        }
        std::thread::park_timeout(Duration::from_secs(1));
        if stop.load(Ordering::Acquire) {
            return;
        }
        let sink = target.lock().ok().and_then(|t| t.clone());
        if sink.as_deref() == Some(reader_free::NODE) {
            // Cap's reader-free capture delivers meanwhile.
            continue;
        }
        match spawn_monitor_reader(sink.as_deref()) {
            Ok(mut next) => {
                counters.restarts.fetch_add(1, Ordering::Relaxed);
                // Checked under the lock Drop takes, so a reader started while
                // stopping is never left behind.
                let Ok(mut slot) = child.lock() else { return };
                if stop.load(Ordering::Acquire) {
                    let _ = next.kill();
                    let _ = next.wait();
                    return;
                }
                *slot = Some(next);
            }
            Err(error) => tracing::warn!(%error, "meeting monitor restart failed"),
        }
    }
}

#[cfg(target_os = "linux")]
impl Drop for SystemPlatform {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Killing the reader ends its stdout, which ends the read loop.
        if let Ok(mut slot) = self.child.lock()
            && let Some(mut child) = slot.take()
        {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(thread) = self.thread.take() {
            thread.thread().unpark();
            let _ = thread.join();
        }
        if let Some(watch) = self.watch.take() {
            watch.thread().unpark();
            let _ = watch.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_loopback_silent_while_its_audio_plays_falls_back() {
        // Opened at 1 s; what it reads is heard at two looks; it delivers
        // nothing that is not silence: at 9 s, not before, it falls back.
        let mut net = SilenceNet::default();
        assert!(!net.observe(1_000, 1_000, 10));
        assert!(!net.observe(3_000, 1_000, 11));
        assert!(!net.observe(5_000, 1_000, 12));
        assert!(!net.observe(8_999, 1_000, 12));
        assert!(net.observe(9_000, 1_000, 12));
        // The same silence while nothing it reads is heard (a quiet
        // meeting): never.
        let mut quiet = SilenceNet::default();
        for at in (1_000..120_000).step_by(2_000) {
            assert!(!quiet.observe(at, 1_000, 10));
        }
        // Heard once only: not enough.
        let mut once = SilenceNet::default();
        assert!(!once.observe(1_000, 1_000, 10));
        assert!(!once.observe(20_000, 1_000, 11));
        // Sound delivered meanwhile starts the count again.
        let mut working = SilenceNet::default();
        assert!(!working.observe(1_000, 1_000, 10));
        assert!(!working.observe(7_000, 6_500, 13));
        assert!(!working.observe(14_000, 6_500, 14));
        assert!(working.observe(14_500, 6_500, 15));
    }

    #[test]
    fn a_remote_session_no_watch_or_a_silent_loopback_reads_only_the_default_output() {
        // (remote, the call output watch runs, gone silent)
        assert!(!plain_only(false, true, false));
        assert!(plain_only(true, true, false));
        assert!(plain_only(false, false, false));
        assert!(plain_only(false, true, true));
        assert!(plain_only(true, false, true));
    }

    fn shared(
        segments: flume::Sender<SegmentJob>,
        missed: flume::Sender<super::super::engine::Missed>,
    ) -> Shared {
        Shared {
            origin: Timestamps::now(),
            audio_dir: None,
            suffix: String::new(),
            offset: 0,
            live_partials: false,
            segments,
            partials: flume::bounded(1).0,
            missed,
            engine_busy: Arc::new(AtomicBool::new(false)),
            events: flume::unbounded().0,
        }
    }

    /// Quiet noise, then loud noise: speech the segmenter keeps open.
    fn open_speech() -> Vec<f32> {
        let mut seed = 0x2545_f491_u32;
        (0..RATE as usize * 3)
            .map(|i| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5;
                noise * if i < RATE as usize { 0.002 } else { 0.5 }
            })
            .collect()
    }

    #[test]
    fn a_clock_jump_starts_a_new_file_instead_of_writing_the_silence() {
        let dir = tempfile::tempdir().unwrap();
        let (events_tx, events) = flume::unbounded();
        let mut shared = shared(flume::unbounded().0, flume::unbounded().0);
        shared.audio_dir = Some(dir.path().to_path_buf());
        shared.events = events_tx;
        let mut worker =
            SourceWorker::new(Source::System, shared, Arc::new(SourceCounters::default()));
        let second = RATE as usize;
        worker.out = vec![0.1; second];
        worker.place(0);
        worker.out = vec![0.1; second];
        worker.place(second as i64);
        // The clock comes back ten minutes later.
        let back = 2 * second as i64 + 600 * RATE as i64;
        worker.out = vec![0.1; second];
        worker.place(back);
        let summary = worker.finish();

        let parts: Vec<_> = events
            .try_iter()
            .filter_map(|e| match e {
                CaptureEvent::AudioPart {
                    path,
                    offset_samples,
                    ..
                } => Some((path, offset_samples)),
                _ => None,
            })
            .collect();
        assert_eq!(parts.len(), 1, "one new file after the jump");
        assert_eq!(parts[0].1, back as u64);
        let first = dir.path().join(audio_file_name(Source::System, ""));
        let first_ms = super::super::audio_file::probe_duration_ms(&first).unwrap();
        assert!(first_ms < 2_500, "the first file holds no padding: {first_ms} ms");
        let second_ms = super::super::audio_file::probe_duration_ms(&parts[0].0).unwrap();
        assert!(second_ms < 1_500, "{second_ms} ms");
        assert_eq!(summary.duration_ms, timeline::samples_to_ms(back as u64) + 1_000);
    }

    #[test]
    fn stop_with_a_full_queue_hands_the_last_segment_to_the_ledger_without_waiting() {
        let (segments, queued) = flume::bounded(1);
        segments
            .try_send(SegmentJob {
                source: Source::Mic,
                start_sample: 0,
                samples: vec![0.0; 16],
                speech_ms: 0,
            })
            .unwrap();
        let (missed_tx, missed) = flume::unbounded();
        let mut worker = SourceWorker::new(
            Source::Mic,
            shared(segments, missed_tx),
            Arc::new(SourceCounters::default()),
        );
        let closed = worker.segmenter.push(0, &open_speech());
        assert!(closed.is_empty(), "the speech should still be open");

        let started = Instant::now();
        let summary = worker.finish();

        assert!(
            started.elapsed() < Duration::from_millis(500),
            "finish waited {:?} for a full queue",
            started.elapsed()
        );
        let ledger: Vec<_> = missed.try_iter().collect();
        assert_eq!(ledger.len(), 1);
        assert!(ledger[0].len > 0);
        assert_eq!(summary.stats.dropped_segments, 1);
        assert_eq!(queued.len(), 1);
    }
}
