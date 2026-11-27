use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use cap_meetings::{
    segment::{Segmenter, SegmenterConfig},
    transcript::{Gap, LogLine, Source, Utterance, Word, append_jsonl},
};

use super::{
    audio_file::TrackReader,
    capture::{SegmentJob, utterance_id},
    cloud::{self, Batcher, Clip, CloudError},
    timeline,
    voices::{FinalVoices, LateResult, Voices, VoicesConfig},
};

const SEGMENT_QUEUE: usize = 128;
/// Transcript lines held while the file can't be written (a full disk), so
/// they reach it once it can.
const UNWRITTEN_MAX: usize = 20_000;
/// A gap grows to take the next missed segment of its track when they are
/// this close, so a long outage is one ledger entry, not hundreds.
const GAP_JOIN_SAMPLES: u64 = timeline::RATE as u64 * 60;
const GAP_SEGMENTS_MAX: usize = 64;
/// Gaps sent for repair at a time while the meeting runs.
const LIVE_REPAIRS: usize = 4;
const LIVE_REPAIR_EVERY: Duration = Duration::from_secs(15);

pub mod reason {
    /// The transcriber was behind and the segment queue was full.
    pub const BUSY: &str = "busy";
    /// The cloud did not answer and no local words stood in.
    pub const CLOUD: &str = "cloud";
    /// Nothing could transcribe it when it was heard.
    pub const UNAVAILABLE: &str = "unavailable";
    /// Recorded but never transcribed: the app stopped first.
    pub const TAIL: &str = "tail";
    /// Speech in the saved audio that no line covers, found after Stop.
    pub const SWEEP: &str = "sweep";
}

/// The after-Stop sweep's speech detector: 30 ms frames this far above the
/// track's own quiet (and above an absolute floor) are speech.
const SWEEP_FRAME: usize = 480;
const SWEEP_ABOVE_QUIET_DB: f32 = 10.0;
const SWEEP_MIN_DB: f32 = -65.0;
const SWEEP_MAX_DB: f32 = -40.0;
/// Speech frames this close together are one stretch.
const SWEEP_JOIN_FRAMES: usize = 10;
/// A stretch shorter than this, or with less speech than this, is noise.
const SWEEP_MIN_MS: u64 = 800;
const SWEEP_MIN_SPEECH_FRAMES: usize = 14;
/// A microphone stretch the call's lines cover this much of is the call
/// heard in the room.
const SWEEP_COVERED: f64 = 0.3;
/// A word's span counts this far either side: the pauses between words
/// of one line are heard too.
const SWEEP_HEARD_SLACK_MS: u64 = 400;
const SWEEP_PAD_SAMPLES: u64 = timeline::RATE as u64 / 4;
/// Audio before a repaired segment the local model hears with it. None: given
/// context, the local model can go silent for a whole long segment it
/// transcribes fully on its own, which loses far more words than the short
/// mid-word tails context recovers.
const REPAIR_CONTEXT_SAMPLES: u64 = 0;
const SWEEP_MAX_SAMPLES: u64 = timeline::RATE as u64 * 25;
const SWEEP_READ_SAMPLES: u64 = timeline::RATE as u64 * 30;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalModel {
    pub model: String,
    pub language: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineMode {
    Pending,
    Local(LocalModel),
    Cloud { language: String },
    Unavailable(String),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum EngineKind {
    #[default]
    Pending,
    Local {
        model: String,
    },
    Cloud,
    None,
}

/// How the cloud is answering this meeting.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CloudState {
    #[default]
    Ok,
    /// Not answering: this computer's words stand in (`local`), or the audio
    /// waits on disk until the cloud is back.
    Down { local: bool },
    /// The sign-in was refused; the audio waits for a new one.
    SignIn { local: bool },
    /// The day's cloud audio is used up: this computer's words stand in
    /// (`local`), or the audio waits until the reset.
    DailyLimit { local: bool },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EngineStatus {
    pub kind: EngineKind,
    pub issue: Option<String>,
    /// Stretches of saved audio still waiting for their words.
    pub gaps: u32,
    /// Of those, the ones with no saved audio to transcribe again (the
    /// meeting does not keep its audio): their words are missing for good.
    pub unrepairable: u32,
    pub cloud: CloudState,
    /// The transcript file could not be written; lines wait in memory.
    pub disk_failed: bool,
}

/// A saved track the engine can read again to repair a gap.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AudioPart {
    pub source: Source,
    pub path: PathBuf,
    /// Where the file's first sample sits on the meeting timeline.
    pub offset_samples: u64,
}

/// A closed segment the transcriber never received.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Missed {
    pub source: Source,
    pub start_sample: u64,
    pub len: u64,
}

pub enum EngineCommand {
    SetMode(EngineMode),
    Append(Vec<LogLine>),
    /// Capture opened another file for a track (after a failed write).
    AudioPart(AudioPart),
    /// The meeting's echo stretches (start ms, call heard on the microphone),
    /// sent whenever they change and before `Finish`.
    EchoStretches(Vec<(u64, bool)>),
    Finish,
}

#[derive(Clone, Debug)]
pub enum EngineEvent {
    Utterance {
        doc_id: String,
        utterance: Utterance,
    },
    /// Lines the cloud's words replaced (Cloud shows local words first).
    Removed {
        doc_id: String,
        ids: Vec<String>,
    },
    Status {
        doc_id: String,
        status: EngineStatus,
    },
    /// The voices told apart so far changed: someone new was confirmed, or
    /// the user was recognised.
    Speakers {
        doc_id: String,
        speakers: Vec<cap_diarize::SpeakerInfo>,
    },
    /// The end-of-meeting pass over every voice, sent before `Drained`.
    FinalSpeakers {
        doc_id: String,
        voices: Box<FinalVoices>,
    },
    /// Nemotron's after-Stop correction of a finished meeting
    /// (never waited for: it comes after `Drained`, often after the summary).
    LateSpeakers {
        doc_id: String,
        late: Box<LateResult>,
    },
    Drained {
        doc_id: String,
    },
}

pub struct EngineConfig {
    pub doc_id: String,
    pub transcript_path: PathBuf,
    pub mode: EngineMode,
    pub fallback: Option<LocalModel>,
    pub vocabulary: Vec<String>,
    /// The user's dictionary: finished and live words are spelled with it,
    /// so a name never changes between a caption and its final line.
    pub dictionary: Arc<cap_meetings::dictionary::Corrector>,
    pub live: bool,
    /// Cloud mode on a computer too slow for live local captions
    /// (`super::device::slow`): whether the user turned them on there.
    /// Off, the local model runs nothing while the cloud answers (no
    /// captions, no local lines before the cloud's) and only stands in when
    /// the cloud cannot. `None` everywhere else: Cloud is as it was.
    pub slow_cloud_live: Option<bool>,
    pub voices: Option<VoicesConfig>,
    /// The meeting's saved tracks, read again to repair gaps.
    pub audio: Vec<AudioPart>,
    /// Gaps already in the transcript (a resumed or recovered meeting).
    pub gaps: Vec<Gap>,
    pub runtime: tokio::runtime::Handle,
    pub events: flume::Sender<EngineEvent>,
}

pub struct EngineHandle {
    pub segments: flume::Sender<SegmentJob>,
    pub partials: flume::Sender<SegmentJob>,
    /// Segments capture could not queue: they go in the ledger.
    pub missed: flume::Sender<Missed>,
    pub busy: Arc<AtomicBool>,
    commands: Option<flume::Sender<EngineCommand>>,
    thread: Option<JoinHandle<()>>,
    done: flume::Receiver<()>,
}

/// Debug builds: when the first meeting of this run started, for the fault
/// windows below.
static DEBUG_EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Debug builds only: `CAP_GPUI_MEETING_CLOUD_FAULT=<from>-<to>` makes the
/// stubbed cloud fail between those seconds of the first meeting.
fn debug_cloud_down() -> bool {
    if !cfg!(debug_assertions) {
        return false;
    }
    let Some(window) = std::env::var("CAP_GPUI_MEETING_CLOUD_FAULT").ok() else {
        return false;
    };
    let Some((from, to)) = window.split_once('-') else {
        return false;
    };
    let (Ok(from), Ok(to)) = (from.trim().parse::<u64>(), to.trim().parse::<u64>()) else {
        return false;
    };
    let at = DEBUG_EPOCH.get().map_or(0, |e| e.elapsed().as_secs());
    (from..to).contains(&at)
}

impl EngineHandle {
    pub fn spawn(config: EngineConfig) -> Self {
        if cfg!(debug_assertions) {
            DEBUG_EPOCH.get_or_init(Instant::now);
        }
        let (segments_tx, segments) = flume::bounded(SEGMENT_QUEUE);
        let (partials_tx, partials) = flume::bounded(1);
        let (missed_tx, missed) = flume::unbounded();
        let (commands_tx, commands) = flume::unbounded();
        let busy = Arc::new(AtomicBool::new(false));
        let (done_tx, done) = flume::bounded::<()>(1);
        let thread = std::thread::Builder::new()
            .name("cap-meeting-transcribe".into())
            .stack_size(crate::MEDIA_THREAD_STACK_SIZE)
            .spawn({
                let busy = busy.clone();
                move || {
                    crate::transcription::lower_thread_priority();
                    Worker::new(config, segments, partials, missed, commands, busy).run();
                    let _ = done_tx.send(());
                }
            })
            .ok();
        Self {
            segments: segments_tx,
            partials: partials_tx,
            missed: missed_tx,
            busy,
            commands: Some(commands_tx),
            thread,
            done,
        }
    }

    pub fn join_timeout(mut self, timeout: Duration) -> bool {
        self.close();
        let finished = self.thread.is_none() || self.done.recv_timeout(timeout).is_ok();
        if finished && let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        finished
    }

    pub fn send(&self, command: EngineCommand) -> Result<(), EngineCommand> {
        match &self.commands {
            Some(tx) => tx.send(command).map_err(|e| e.into_inner()),
            None => Err(command),
        }
    }

    pub fn queued(&self) -> usize {
        self.segments.len()
    }

    pub fn close(&mut self) {
        drop(self.commands.take());
    }

    pub fn join(mut self) {
        self.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        drop(self.commands.take());
    }
}

/// How hard a clip is tried before the meeting stops waiting for the cloud.
#[derive(Clone, Copy, Debug)]
struct RetryPolicy {
    first: Duration,
    max: Duration,
    /// Time spent on one clip before its words come from elsewhere.
    budget: Duration,
    /// After Stop: what a repair clip may take.
    stop_budget: Duration,
    probe_first: Duration,
    probe_jitter: Duration,
    probe_max: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            first: Duration::from_secs(1),
            max: Duration::from_secs(30),
            budget: Duration::from_secs(20),
            stop_budget: Duration::from_secs(8),
            probe_first: Duration::from_secs(60),
            probe_jitter: Duration::from_secs(60),
            probe_max: Duration::from_secs(600),
        }
    }
}

/// A number in [0, 1) that differs between calls, for jitter.
fn jitter() -> f64 {
    let mut bytes = [0u8; 4];
    if getrandom::getrandom(&mut bytes).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        bytes = nanos.to_le_bytes();
    }
    f64::from(u32::from_le_bytes(bytes)) / (f64::from(u32::MAX) + 1.0)
}

impl RetryPolicy {
    /// 1 s, then doubling to 30 s, each within 20% either way; a rate limit
    /// waits as long as the server asked.
    fn backoff(&self, attempt: u32, error: &CloudError) -> Duration {
        let base = self
            .first
            .saturating_mul(1u32 << attempt.saturating_sub(1).min(16))
            .min(self.max);
        let spread = base.mul_f64(0.8 + 0.4 * jitter());
        match error {
            CloudError::RateLimited { retry_after_secs } => {
                spread.max(Duration::from_secs(*retry_after_secs))
            }
            _ => spread,
        }
    }

    fn next_probe(&self, interval: Duration) -> Duration {
        interval + self.probe_jitter.mul_f64(jitter())
    }
}

/// The server gives a clip up to this long; the app waits a little longer so
/// it never abandons a request the server is still finishing.
const SERVER_DEADLINE: Duration = Duration::from_secs(90);

/// The request's own limit: room to upload and for the farm to hear the
/// clip, and never less than the server's own deadline.
pub fn request_timeout(clip_ms: u64) -> Duration {
    (Duration::from_secs(15) + Duration::from_millis(clip_ms.saturating_mul(3) / 2))
        .max(SERVER_DEADLINE + Duration::from_secs(5))
}

struct Worker {
    config: EngineConfig,
    segments: flume::Receiver<SegmentJob>,
    partials: flume::Receiver<SegmentJob>,
    missed: flume::Receiver<Missed>,
    commands: flume::Receiver<EngineCommand>,
    busy: Arc<AtomicBool>,
    mode: EngineMode,
    status: EngineStatus,
    pending: Vec<SegmentJob>,
    batchers: [Batcher; 2],
    last_segment: [Option<Instant>; 2],
    voices: Option<Voices>,
    finishing: bool,
    drained: bool,
    /// Cloud: the local lines shown for a closed segment until its clip
    /// returns, by (track, start sample).
    provisional: HashMap<(usize, u64), Provisional>,
    lanes: [Option<CloudLane>; 2],
    results: (flume::Sender<CloudMsg>, flume::Receiver<CloudMsg>),
    cloud_in_flight: usize,
    seq: [u64; 2],
    /// The cloud stopped answering: clips are finished locally (or kept as
    /// gaps) and a probe now and then finds out when it is back.
    bridge: Option<Bridge>,
    /// The cloud refused this account for good (no Pro).
    cloud_refused: bool,
    /// The ledger: saved audio whose words did not land yet.
    gaps: Vec<Gap>,
    /// Repair clips still out, by gap.
    repairs: HashMap<String, usize>,
    /// Segments whose words come from a repair: they skip the live voices.
    repairing: HashSet<(usize, u64)>,
    /// When to send gaps to the cloud again while the meeting runs.
    repair_at: Option<Instant>,
    /// Clips with the cloud now, by (track, first sample): what they cover,
    /// so a lost answer still leaves the audio in the ledger.
    inflight: HashMap<(usize, u64), Vec<(u64, u64)>>,
    readers: [Option<(PathBuf, TrackReader)>; 2],
    /// The saved audio just before each repair segment, by (track, start).
    repair_context: HashMap<(usize, u64), Vec<f32>>,
    /// What the transcript already says, per track (ms spans of words),
    /// so a repair never writes the same words twice.
    heard: [Vec<(u64, u64)>; 2],
    unwritten: Vec<LogLine>,
    policy: RetryPolicy,
    /// Live captions per track.
    live: [Option<LiveSegment>; 2],
    /// Segments with a live caption on screen, by (track, start sample),
    /// until their final words come back.
    captioned: HashSet<(usize, u64)>,
    /// Counts this meeting among those using the live model.
    live_meeting: crate::transcription::LiveMeeting,
    #[cfg(test)]
    hooks: TestHooks,
}

/// Answers a clip in place of the server (tests).
type CloudAnswer = Arc<dyn Fn(&Clip) -> Result<cloud::CloudTranscript, CloudError> + Send + Sync>;

#[cfg(test)]
#[derive(Default)]
struct TestHooks {
    local:
        Option<Arc<dyn Fn(&[f32]) -> Result<Vec<cap_project::CaptionWord>, String> + Send + Sync>>,
    cloud: Option<CloudAnswer>,
    /// Reads a track in place of the saved file: (source, start, len).
    audio: Option<Arc<dyn Fn(Source, u64, u64) -> Option<Vec<f32>> + Send + Sync>>,
    /// The transcript file fails to write while this is set.
    disk_full: Option<Arc<AtomicBool>>,
}

struct Provisional {
    ids: Vec<String>,
    words: Vec<Word>,
}

/// Live captions of one open segment. Words two passes in a row heard the
/// same way, and that are not the last second of the audio, are kept as
/// shown; the next pass hears only the audio after them. A caption then
/// costs about the same 2 s and 18 s into a segment, so captions can come
/// every second for what re-hearing the whole segment every 2 s cost. The
/// segment's final line is still one pass over all of it.
struct LiveSegment {
    start_sample: u64,
    kept: Vec<Word>,
    /// Where the next pass starts, in samples from the segment's start.
    from: usize,
    /// The last pass's words after `kept`.
    last: Vec<Word>,
}

/// Words ending this close to the newest audio are never kept yet: the
/// model may still change them once it hears what follows.
const LIVE_HOLD_MS: u64 = 1_000;
/// A pass this long keeps its words up to `LIVE_FORCE_MS` before the end
/// even when they changed, so a pass never grows without bound.
const LIVE_MAX_WINDOW_MS: u64 = 8_000;
const LIVE_FORCE_MS: u64 = 4_000;

/// Debug builds: `CAP_GPUI_MEETING_LIVE_WINDOW=0` hears the whole open
/// segment on every caption pass, as before (measurements).
fn live_window() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        !(cfg!(debug_assertions)
            && std::env::var("CAP_GPUI_MEETING_LIVE_WINDOW").is_ok_and(|v| v.trim() == "0"))
    })
}

fn same_word(a: &Word, b: &Word) -> bool {
    let key = |w: &Word| {
        w.text
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect::<String>()
    };
    key(a) == key(b)
}

impl LiveSegment {
    fn new(start_sample: u64) -> Self {
        Self {
            start_sample,
            kept: Vec::new(),
            from: 0,
            last: Vec::new(),
        }
    }

    /// Takes a pass's words (from `from` to `end_ms`) and returns what the
    /// caption shows.
    fn heard(&mut self, words: Vec<Word>, segment_start_ms: u64, end_ms: u64) -> Vec<Word> {
        let window_ms =
            end_ms.saturating_sub(segment_start_ms + timeline::samples_to_ms(self.from as u64));
        let agreed = self
            .last
            .iter()
            .zip(&words)
            .take_while(|(a, b)| same_word(a, b))
            .count();
        let mut keep = 0;
        while keep < agreed && words[keep].end_ms + LIVE_HOLD_MS <= end_ms {
            keep += 1;
        }
        if window_ms > LIVE_MAX_WINDOW_MS {
            while keep < words.len() && words[keep].end_ms + LIVE_FORCE_MS <= end_ms {
                keep += 1;
            }
        }
        // The next pass starts between two words, never inside one.
        keep = keep.min(words.len().saturating_sub(1));
        if keep > 0 {
            let boundary_ms =
                (words[keep - 1].end_ms + words[keep].start_ms.max(words[keep - 1].end_ms)) / 2;
            let from =
                timeline::ms_to_samples(boundary_ms.saturating_sub(segment_start_ms)) as usize;
            self.from = from.max(self.from);
        }
        let mut words = words;
        let rest = words.split_off(keep);
        self.kept.extend(words);
        self.last = rest.clone();
        let mut shown = self.kept.clone();
        shown.extend(rest);
        shown
    }
}

struct Bridge {
    next_probe: Instant,
    interval: Duration,
    sign_in: bool,
    /// The token the cloud refused; a different one is worth a try at once.
    token: Option<String>,
    probing: bool,
    /// The day is used up until then: another clip's ordinary failure
    /// keeps that wait.
    daily_until: Option<Instant>,
}

/// One track's cloud requests run here so an upload, a retry wait or a slow
/// server never holds up the live captions on the worker, and the two
/// tracks never wait on each other.
struct CloudLane {
    jobs: flume::Sender<LaneJob>,
}

struct LaneJob {
    clip: Clip,
    language: String,
    speakers: Option<cloud::SpeakerSession>,
    /// Time this clip may spend in retries.
    budget: Duration,
    probe: bool,
}

enum CloudMsg {
    /// A request failed and will be retried; the worker shows why.
    Retrying(String),
    Done {
        clip: Clip,
        result: Result<cloud::CloudTranscript, CloudError>,
        probe: bool,
    },
}

fn current_token() -> Option<String> {
    if cfg!(test) {
        return None;
    }
    crate::store::auth_snapshot().token
}

impl CloudLane {
    fn spawn(
        source: Source,
        vocabulary: Vec<String>,
        runtime: tokio::runtime::Handle,
        stub: Option<LocalModel>,
        answer: Option<CloudAnswer>,
        policy: RetryPolicy,
        results: flume::Sender<CloudMsg>,
    ) -> Option<Self> {
        let (jobs_tx, jobs) = flume::unbounded::<LaneJob>();
        std::thread::Builder::new()
            .name(match source {
                Source::Mic => "cap-meeting-cloud-mic".into(),
                Source::System => "cap-meeting-cloud-system".into(),
            })
            .spawn(move || {
                while let Ok(job) = jobs.recv() {
                    let started = Instant::now();
                    let mut attempt = 0u32;
                    let mut token = current_token();
                    let result = loop {
                        attempt += 1;
                        let result = match answer.as_ref() {
                            Some(answer) => answer(&job.clip),
                            None => match cloud_stub(stub.as_ref(), &job.clip, &vocabulary) {
                                Some(result) => result,
                                None => runtime.block_on(cloud::transcribe(
                                    cloud::wav_bytes(&job.clip.samples),
                                    &job.language,
                                    &vocabulary,
                                    job.speakers.as_ref(),
                                    request_timeout(job.clip.duration_ms()),
                                )),
                            },
                        };
                        let Err(error) = &result else {
                            break result;
                        };
                        tracing::warn!(?error, attempt, probe = job.probe, "cloud meeting transcription failed");
                        match error {
                            // Neither clears within a clip's retries.
                            CloudError::UpgradeRequired | CloudError::DailyLimit { .. } => {
                                break result;
                            }
                            // A sign-in that changed since is tried at once.
                            CloudError::NotSignedIn => {
                                let now = current_token();
                                if now.is_some() && now != token {
                                    token = now;
                                    continue;
                                }
                                break result;
                            }
                            error => {
                                let wait = policy.backoff(attempt, error);
                                if started.elapsed() + wait > job.budget {
                                    break result;
                                }
                                let _ = results.send(CloudMsg::Retrying(error.describe()));
                                std::thread::sleep(wait);
                            }
                        }
                    };
                    if results
                        .send(CloudMsg::Done {
                            clip: job.clip,
                            result,
                            probe: job.probe,
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            })
            .ok()?;
        Some(Self { jobs: jobs_tx })
    }
}

fn source_index(source: Source) -> usize {
    match source {
        Source::Mic => 0,
        Source::System => 1,
    }
}

fn source_of(index: usize) -> Source {
    if index == 0 { Source::Mic } else { Source::System }
}

enum Wake {
    Segment(SegmentJob),
    Partial(SegmentJob),
    Missed(Missed),
    Command(EngineCommand),
    Cloud(CloudMsg),
    Closed,
    Timeout,
}

impl Worker {
    fn new(
        config: EngineConfig,
        segments: flume::Receiver<SegmentJob>,
        partials: flume::Receiver<SegmentJob>,
        missed: flume::Receiver<Missed>,
        commands: flume::Receiver<EngineCommand>,
        busy: Arc<AtomicBool>,
    ) -> Self {
        let mode = config.mode.clone();
        let mut config = config;
        let voices = config.voices.take().map(Voices::new);
        let gaps = std::mem::take(&mut config.gaps);
        let mut worker = Self {
            config,
            segments,
            partials,
            missed,
            commands,
            busy,
            mode: EngineMode::Pending,
            status: EngineStatus::default(),
            pending: Vec::new(),
            batchers: [Batcher::default(), Batcher::default()],
            last_segment: [None, None],
            voices,
            finishing: false,
            drained: false,
            provisional: HashMap::new(),
            lanes: [None, None],
            results: flume::unbounded(),
            cloud_in_flight: 0,
            seq: [0, 0],
            bridge: None,
            cloud_refused: false,
            repair_at: None,
            inflight: HashMap::new(),
            gaps,
            repairs: HashMap::new(),
            repairing: HashSet::new(),
            readers: [None, None],
            repair_context: HashMap::new(),
            heard: [Vec::new(), Vec::new()],
            unwritten: Vec::new(),
            policy: RetryPolicy::default(),
            live: [None, None],
            captioned: HashSet::new(),
            live_meeting: crate::transcription::LiveMeeting::start(),
            #[cfg(test)]
            hooks: TestHooks::default(),
        };
        worker.status.gaps = worker.gaps.len() as u32;
        worker.set_mode(mode, None);
        worker
    }

    fn run(&mut self) {
        self.preload_live_model();
        loop {
            while let Ok(command) = self.commands.try_recv() {
                self.command(command);
            }
            while let Ok(missed) = self.missed.try_recv() {
                self.on_missed(missed);
            }
            if !matches!(self.mode, EngineMode::Pending)
                && let Some(job) = self.pending.pop()
            {
                self.final_segment(job);
                continue;
            }
            if let Ok(msg) = self.results.1.try_recv() {
                self.on_cloud(msg);
                continue;
            }
            if let Ok(job) = self.segments.try_recv() {
                self.final_segment(job);
                continue;
            }
            if self.finishing && !self.drained && self.segments.is_empty() {
                self.drain();
            }
            if !self.finishing
                && self.segments.is_empty()
                && self.repair_at.is_some_and(|at| at <= Instant::now())
            {
                self.repair_live();
            }
            if !self.finishing
                && self.captions()
                && self.live_model().is_some()
                && let Ok(job) = self.partials.try_recv()
            {
                if self.segments.is_empty() {
                    self.partial_segment(job);
                }
                continue;
            }
            match self.wait() {
                Wake::Segment(job) => self.final_segment(job),
                Wake::Partial(job) => {
                    if !self.finishing
                        && self.captions()
                        && self.live_model().is_some()
                        && self.segments.is_empty()
                    {
                        self.partial_segment(job);
                    }
                }
                Wake::Missed(missed) => self.on_missed(missed),
                Wake::Command(command) => self.command(command),
                Wake::Cloud(msg) => self.on_cloud(msg),
                Wake::Closed => {
                    if !self.drained {
                        self.finishing = true;
                        continue;
                    }
                    break;
                }
                Wake::Timeout => {
                    self.flush_batches(false);
                    self.flush_unwritten();
                }
            }
        }
    }

    /// The end of the meeting: every clip back, every gap the saved audio
    /// can fill filled, then the final pass over the voices.
    fn drain(&mut self) {
        while let Ok(missed) = self.missed.try_recv() {
            self.on_missed(missed);
        }
        if matches!(self.mode, EngineMode::Pending) {
            let left = std::mem::take(&mut self.pending);
            self.set_mode(
                EngineMode::Unavailable("No transcription engine was ready".into()),
                None,
            );
            for job in left.into_iter().rev() {
                self.open_gap_for(job.source, job.start_sample, job.samples.len() as u64, reason::UNAVAILABLE);
            }
        }
        self.flush_batches(true);
        self.await_cloud();
        self.repair_after_stop();
        if self.coverage_sweep() {
            self.repair_after_stop();
        }
        // The last meeting lets the live model go before the speaker pass
        // after Stop starts, so the two never overlap
        if self.live_meeting.finish() {
            crate::transcription::release_live_models_if_idle();
        }
        self.finish_voices();
        self.flush_unwritten();
        self.drained = true;
        let _ = self.config.events.send(EngineEvent::Drained {
            doc_id: self.config.doc_id.clone(),
        });
    }

    fn wait(&self) -> Wake {
        let timeout = [
            self.flush_deadline(),
            (!self.unwritten.is_empty()).then(|| Instant::now() + Duration::from_secs(10)),
            self.repair_at.filter(|_| !self.finishing),
        ]
        .into_iter()
        .flatten()
        .min()
        .map(|at| at.saturating_duration_since(Instant::now()));
        let selector =
            flume::Selector::new().recv(&self.commands, |r| r.map_or(Wake::Closed, Wake::Command));
        let selector = if self.drained {
            selector
        } else {
            let selector = selector
                .recv(&self.segments, |r| r.map_or(Wake::Closed, Wake::Segment))
                .recv(&self.partials, |r| r.map_or(Wake::Closed, Wake::Partial));
            let selector = if self.missed.is_disconnected() {
                selector
            } else {
                selector.recv(&self.missed, |r| r.map_or(Wake::Timeout, Wake::Missed))
            };
            if self.cloud_in_flight > 0 {
                selector.recv(&self.results.1, |r| r.map_or(Wake::Timeout, Wake::Cloud))
            } else {
                selector
            }
        };
        match timeout {
            Some(timeout) => selector.wait_timeout(timeout).unwrap_or(Wake::Timeout),
            None => selector.wait(),
        }
    }

    fn flush_deadline(&self) -> Option<Instant> {
        if !matches!(self.mode, EngineMode::Cloud { .. }) {
            return None;
        }
        self.last_segment
            .iter()
            .zip(&self.batchers)
            .filter(|(_, b)| !b.is_empty())
            .filter_map(|(at, _)| at.map(|at| at + cloud::IDLE_FLUSH))
            .min()
    }

    fn command(&mut self, command: EngineCommand) {
        match command {
            EngineCommand::SetMode(mode) => self.set_mode(mode, None),
            EngineCommand::Append(lines) => self.append(&lines),
            EngineCommand::AudioPart(part) => {
                if !self.config.audio.contains(&part) {
                    self.config.audio.push(part);
                    self.publish_status();
                }
            }
            EngineCommand::EchoStretches(stretches) => {
                if let Some(voices) = self.voices.as_mut() {
                    voices.set_echo_stretches(stretches);
                }
            }
            EngineCommand::Finish => self.finishing = true,
        }
    }

    fn set_mode(&mut self, mode: EngineMode, issue: Option<String>) {
        self.status.kind = match &mode {
            EngineMode::Pending => EngineKind::Pending,
            EngineMode::Local(local) => EngineKind::Local {
                model: local.model.clone(),
            },
            EngineMode::Cloud { .. } => EngineKind::Cloud,
            EngineMode::Unavailable(reason) => {
                self.status.issue = Some(reason.clone());
                EngineKind::None
            }
        };
        if matches!(mode, EngineMode::Cloud { .. }) {
            if !self.gaps.is_empty() {
                self.repair_at = Some(Instant::now());
            }
        } else {
            self.bridge = None;
            self.status.cloud = CloudState::Ok;
        }
        if issue.is_some() {
            self.status.issue = issue;
        }
        self.mode = mode;
        self.publish_status();
    }

    fn publish_status(&mut self) {
        self.status.gaps = self.gaps.len() as u32;
        self.status.unrepairable = self
            .gaps
            .iter()
            .filter(|g| !self.config.audio.iter().any(|p| p.source == g.source))
            .count() as u32;
        let _ = self.config.events.send(EngineEvent::Status {
            doc_id: self.config.doc_id.clone(),
            status: self.status.clone(),
        });
    }

    fn write_lines(&self, lines: &[LogLine]) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .hooks
            .disk_full
            .as_ref()
            .is_some_and(|full| full.load(Ordering::Acquire))
        {
            return Err(std::io::Error::other("no space left on device"));
        }
        append_jsonl(&self.config.transcript_path, lines)
    }

    /// Every line reaches the file: what could not be written waits and
    /// goes first next time.
    fn append(&mut self, lines: &[LogLine]) {
        self.unwritten.extend_from_slice(lines);
        self.flush_unwritten();
    }

    fn flush_unwritten(&mut self) {
        if self.unwritten.is_empty() {
            return;
        }
        match self.write_lines(&self.unwritten) {
            Ok(()) => {
                self.unwritten.clear();
                if self.status.disk_failed {
                    tracing::info!("the meeting transcript can be written again");
                    self.status.disk_failed = false;
                    self.publish_status();
                }
            }
            Err(error) => {
                if self.unwritten.len() > UNWRITTEN_MAX {
                    let over = self.unwritten.len() - UNWRITTEN_MAX;
                    self.unwritten.drain(..over);
                }
                if !self.status.disk_failed {
                    tracing::warn!(%error, "could not append to the meeting transcript");
                    self.status.disk_failed = true;
                    self.publish_status();
                }
            }
        }
    }

    // The ledger

    fn on_missed(&mut self, missed: Missed) {
        self.open_gap_for(missed.source, missed.start_sample, missed.len, reason::BUSY);
    }

    fn open_gap_for(&mut self, source: Source, start_sample: u64, len: u64, why: &str) {
        self.open_gap(source, vec![(start_sample, len)], why);
    }

    /// Writes down audio whose words did not land, joining the track's last
    /// gap when it is close and the same kind.
    fn open_gap(&mut self, source: Source, segments: Vec<(u64, u64)>, why: &str) {
        let Some(start) = segments.iter().map(|s| s.0).min() else {
            return;
        };
        let end = segments.iter().map(|s| s.0 + s.1).max().unwrap_or(start);
        if end <= start {
            return;
        }
        let joinable = self.gaps.iter().rposition(|g| {
            g.source == source
                && g.reason == why
                && !self.repairs.contains_key(&g.id)
                && start >= g.start_sample
                && start.saturating_sub(g.end_sample) <= GAP_JOIN_SAMPLES
                && g.segments.len() + segments.len() <= GAP_SEGMENTS_MAX
                && !g.segments.is_empty()
        });
        let gap = match joinable {
            Some(index) => {
                let gap = &mut self.gaps[index];
                gap.end_sample = gap.end_sample.max(end);
                gap.segments.extend(segments);
                gap.clone()
            }
            None => {
                let gap = Gap {
                    id: Gap::id_for(source, start),
                    source,
                    start_sample: start,
                    end_sample: end,
                    segments,
                    reason: why.to_string(),
                };
                self.gaps.retain(|g| g.id != gap.id);
                self.gaps.push(gap.clone());
                gap
            }
        };
        tracing::info!(id = gap.id, reason = why, ms = timeline::samples_to_ms(gap.end_sample - gap.start_sample), "meeting audio kept for repair");
        self.append(&[LogLine::Gap { gap }]);
        self.publish_status();
    }

    fn close_gap(&mut self, id: &str) {
        let before = self.gaps.len();
        self.gaps.retain(|g| g.id != id);
        self.repairs.remove(id);
        if self.gaps.len() != before {
            tracing::info!(id, "meeting gap repaired");
            self.append(&[LogLine::GapClosed {
                ids: vec![id.to_string()],
            }]);
            self.publish_status();
        }
    }

    fn finish_voices(&mut self) {
        let Some(voices) = self.voices.as_mut().and_then(Voices::finish) else {
            return;
        };
        // Lines that were only the call coming out of the speakers repeat
        // the call's own lines: they go.
        let echoes = self
            .voices
            .as_mut()
            .map(Voices::take_echoes)
            .unwrap_or_default();
        if !echoes.is_empty() {
            self.append(&[LogLine::Delete {
                ids: echoes.clone(),
            }]);
            let _ = self.config.events.send(EngineEvent::Removed {
                doc_id: self.config.doc_id.clone(),
                ids: echoes,
            });
        }
        let _ = self.config.events.send(EngineEvent::FinalSpeakers {
            doc_id: self.config.doc_id.clone(),
            voices: Box::new(voices),
        });
        // Nemotron hears the meeting now; the transcript and summary go
        // ahead without it
        if let Some(late) = self.voices.as_mut().and_then(Voices::take_late) {
            let events = self.config.events.clone();
            let doc_id = self.config.doc_id.clone();
            let spawned = std::thread::Builder::new()
                .name("cap-meeting-late-voices".into())
                .spawn(move || {
                    let late = late.resolve();
                    // Nemotron is gone once it has answered
                    crate::transcription::return_freed_memory();
                    if let Some(late) = late {
                        let _ = events.send(EngineEvent::LateSpeakers {
                            doc_id,
                            late: Box::new(late),
                        });
                    }
                });
            if let Err(error) = spawned {
                tracing::warn!(%error, "could not start Nemotron after Stop");
            }
        }
    }

    /// Tells this segment's voices apart before its words come back, so
    /// local and cloud transcription share one numbering.
    fn diarize(&mut self, job: &SegmentJob) {
        if matches!(self.mode, EngineMode::Unavailable(_)) {
            return;
        }
        let Some(voices) = self.voices.as_mut() else {
            return;
        };
        if let Some(speakers) = voices.push(job.source, job.start_sample, &job.samples) {
            let _ = self.config.events.send(EngineEvent::Speakers {
                doc_id: self.config.doc_id.clone(),
                speakers,
            });
        }
    }

    fn utterances(
        &mut self,
        source: Source,
        start_sample: u64,
        words: Vec<Word>,
        is_final: bool,
    ) -> Vec<Utterance> {
        if is_final {
            self.repairing.remove(&(source_index(source), start_sample));
        }
        match self.voices.as_mut() {
            Some(voices) => voices.split(source, start_sample, words, is_final),
            None => utterance(source, start_sample, words, is_final)
                .into_iter()
                .collect(),
        }
    }

    fn final_segment(&mut self, job: SegmentJob) {
        let index = source_index(job.source);
        if self.live[index]
            .as_ref()
            .is_some_and(|live| live.start_sample == job.start_sample)
        {
            self.live[index] = None;
        }
        self.diarize(&job);
        match self.mode.clone() {
            EngineMode::Pending => {
                self.pending.insert(0, job);
                if self.pending.len() > SEGMENT_QUEUE
                    && let Some(oldest) = self.pending.pop()
                {
                    self.open_gap_for(
                        oldest.source,
                        oldest.start_sample,
                        oldest.samples.len() as u64,
                        reason::UNAVAILABLE,
                    );
                }
            }
            EngineMode::Local(local) => self.local_final(&local, job),
            EngineMode::Cloud { .. } => {
                self.provisional_final(&job);
                let index = source_index(job.source);
                self.last_segment[index] = Some(Instant::now());
                if let Some(clip) = self.batchers[index].push(job) {
                    self.send_clip(clip);
                }
            }
            EngineMode::Unavailable(_) => {
                self.open_gap_for(
                    job.source,
                    job.start_sample,
                    job.samples.len() as u64,
                    reason::UNAVAILABLE,
                );
            }
        }
    }

    /// The local model that gives live captions: the meeting's own in Local,
    /// the downloaded one in Cloud (the cloud only sends final words).
    /// Live captions load their model as the meeting starts, while capture
    /// gathers the first speech, rather than on the first caption.
    fn preload_live_model(&self) {
        if !self.captions() {
            return;
        }
        #[cfg(test)]
        if self.hooks.local.is_some() {
            return;
        }
        if let Some(local) = self.live_model() {
            crate::transcription::preload_live_model(&local.model, &local.language);
        }
    }

    fn live_model(&self) -> Option<LocalModel> {
        match &self.mode {
            EngineMode::Local(local) => Some(local.clone()),
            EngineMode::Cloud { .. } if self.local_with_cloud() => self.config.fallback.clone(),
            EngineMode::Cloud { .. } | EngineMode::Pending | EngineMode::Unavailable(_) => None,
        }
    }

    /// Live captions in this mode. A slow computer's Cloud meeting keeps
    /// its choice when the cloud refuses it and this computer takes over.
    fn captions(&self) -> bool {
        match self.config.slow_cloud_live {
            Some(on) if self.cloud_refused || matches!(self.mode, EngineMode::Cloud { .. }) => on,
            _ => self.config.live,
        }
    }

    /// Cloud: the local model also runs on the meeting as it happens.
    fn local_with_cloud(&self) -> bool {
        self.config.slow_cloud_live != Some(false)
    }

    /// Whatever can transcribe on this computer now.
    fn local_model(&self) -> Option<LocalModel> {
        self.config.fallback.clone().or_else(|| match &self.mode {
            EngineMode::Local(local) => Some(local.clone()),
            _ => None,
        })
    }

    #[cfg(test)]
    fn cloud_answer(&self) -> Option<CloudAnswer> {
        self.hooks.cloud.clone()
    }

    #[cfg(not(test))]
    fn cloud_answer(&self) -> Option<CloudAnswer> {
        None
    }

    fn local_words(
        &self,
        local: &LocalModel,
        samples: &[f32],
    ) -> Result<Vec<cap_project::CaptionWord>, String> {
        #[cfg(test)]
        if let Some(words) = &self.hooks.local {
            return words(samples);
        }
        crate::transcription::transcribe_samples_blocking(
            &local.model,
            &local.language,
            samples,
            &self.config.vocabulary,
        )
    }

    fn transcribe(&self, local: &LocalModel, job: &SegmentJob) -> Result<Vec<Word>, String> {
        self.busy.store(true, Ordering::Release);
        let result = self.local_words(local, &job.samples);
        self.busy.store(false, Ordering::Release);
        let base = job.start_ms();
        result.map(|words| {
            let mut words = words
                .iter()
                .filter(|w| !w.text.trim().is_empty())
                .map(|w| Word {
                    text: w.text.trim().to_string(),
                    start_ms: base + (f64::from(w.start.max(0.0)) * 1000.0) as u64,
                    end_ms: base + (f64::from(w.end.max(w.start).max(0.0)) * 1000.0) as u64,
                })
                .collect();
            self.spell(&mut words);
            words
        })
    }

    fn spell(&self, words: &mut Vec<Word>) {
        if self.config.dictionary.is_empty() {
            return;
        }
        self.config.dictionary.apply_timed(
            words,
            |w| w.text.as_str(),
            |_, text, start_ms, end_ms| Word {
                text,
                start_ms,
                end_ms,
            },
            |w| (w.start_ms, w.end_ms),
        );
    }

    fn local_final(&mut self, local: &LocalModel, job: SegmentJob) {
        match self.transcribe(local, &job) {
            Ok(words) => {
                let lines = self.utterances(job.source, job.start_sample, words, true);
                self.caption_answered(job.source, job.start_sample, lines.is_empty());
                for utterance in lines {
                    self.emit_final(utterance);
                }
                if self.status.issue.is_some()
                    && matches!(self.status.kind, EngineKind::Local { .. })
                {
                    self.status.issue = None;
                    self.publish_status();
                }
            }
            Err(error) => {
                tracing::warn!(%error, "meeting segment transcription failed");
                self.status.issue = Some(error);
                self.open_gap_for(
                    job.source,
                    job.start_sample,
                    job.samples.len() as u64,
                    reason::UNAVAILABLE,
                );
            }
        }
    }

    /// Cloud: show the closed segment's local words now, written like any
    /// final line so nothing is lost if the cloud never answers; the clip's
    /// words replace them when it returns.
    fn provisional_final(&mut self, job: &SegmentJob) {
        if !self.local_with_cloud() {
            return;
        }
        let Some(local) = self.config.fallback.clone() else {
            return;
        };
        let Ok(words) = self.transcribe(&local, job) else {
            return;
        };
        let lines = match self.voices.as_mut() {
            Some(voices) => voices.split_provisional(job.source, job.start_sample, words.clone()),
            None => utterance(job.source, job.start_sample, words.clone(), true)
                .into_iter()
                .collect(),
        };
        let ids = lines.iter().map(|u| u.id.clone()).collect();
        for line in lines {
            self.emit_final(line);
        }
        self.provisional.insert(
            (source_index(job.source), job.start_sample),
            Provisional { ids, words },
        );
    }

    /// The segment's final lines. Lines shown for it earlier that the final
    /// split no longer has are removed; the rest are replaced in place.
    fn commit(&mut self, source: Source, start_sample: u64, mut words: Vec<Word>) {
        let index = source_index(source);
        if self.repairing.contains(&(index, start_sample)) && !self.heard[index].is_empty() {
            let heard = &self.heard[index];
            words.retain(|w| {
                let mid = (w.start_ms + w.end_ms.max(w.start_ms)) / 2;
                !heard.iter().any(|(a, b)| mid + 100 >= *a && mid <= b + 100)
            });
        }
        let shown = self
            .provisional
            .remove(&(source_index(source), start_sample))
            .map(|p| p.ids)
            .unwrap_or_default();
        let lines = self.utterances(source, start_sample, words, true);
        self.caption_answered(source, start_sample, lines.is_empty());
        let kept: HashSet<&str> = lines.iter().map(|u| u.id.as_str()).collect();
        let stale: Vec<String> = shown
            .into_iter()
            .filter(|id| !kept.contains(id.as_str()))
            .collect();
        if !stale.is_empty() {
            self.append(&[LogLine::Delete { ids: stale.clone() }]);
            let _ = self.config.events.send(EngineEvent::Removed {
                doc_id: self.config.doc_id.clone(),
                ids: stale,
            });
        }
        for line in lines {
            self.emit_final(line);
        }
    }

    /// Finals for segments the cloud will not answer: the local words
    /// already shown when there are some, otherwise a local pass now, and
    /// failing both the audio goes in the ledger.
    fn finalize_locally(&mut self, jobs: Vec<SegmentJob>) {
        let mut kept = Vec::new();
        for job in jobs {
            let key = (source_index(job.source), job.start_sample);
            if let Some(words) = self.provisional.get(&key).map(|p| p.words.clone()) {
                self.commit(job.source, job.start_sample, words);
            } else if let Some(local) = self.local_model() {
                self.local_final(&local, job);
            } else {
                kept.push(job);
            }
        }
        if let Some(source) = kept.first().map(|j| j.source) {
            let segments = kept
                .iter()
                .map(|j| (j.start_sample, j.samples.len() as u64))
                .collect();
            self.open_gap(source, segments, reason::CLOUD);
        }
    }

    fn partial_segment(&mut self, job: SegmentJob) {
        let Some(local) = self.live_model() else {
            return;
        };
        self.busy.store(true, Ordering::Release);
        if let Some(voices) = self.voices.as_mut() {
            voices.peek(job.source, job.start_sample, &job.samples);
        }
        let words = if live_window() {
            let index = source_index(job.source);
            let mut live = match self.live[index].take() {
                Some(live)
                    if live.start_sample == job.start_sample && live.from < job.samples.len() =>
                {
                    live
                }
                _ => LiveSegment::new(job.start_sample),
            };
            let window = SegmentJob {
                source: job.source,
                start_sample: job.start_sample + live.from as u64,
                samples: job.samples[live.from..].to_vec(),
                speech_ms: 0,
            };
            let Ok(words) = self.transcribe(&local, &window) else {
                self.live[index] = Some(live);
                return;
            };
            let end_ms = job.start_ms() + timeline::samples_to_ms(job.samples.len() as u64);
            let shown = live.heard(words, job.start_ms(), end_ms);
            self.live[index] = Some(live);
            shown
        } else {
            let Ok(words) = self.transcribe(&local, &job) else {
                return;
            };
            words
        };
        for utterance in self.utterances(job.source, job.start_sample, words, false) {
            self.captioned
                .insert((source_index(job.source), job.start_sample));
            let _ = self.config.events.send(EngineEvent::Utterance {
                doc_id: self.config.doc_id.clone(),
                utterance,
            });
        }
    }

    /// A segment's final words are in. When they are none (a cough or a
    /// door the live pass took for "Yeah."), its live caption goes: a final
    /// line would have replaced it, and nothing else on that track may come
    /// for the rest of a quiet meeting. A caption is never saved, so nothing
    /// is written.
    fn caption_answered(&mut self, source: Source, start_sample: u64, empty: bool) {
        if self.captioned.remove(&(source_index(source), start_sample)) && empty {
            let _ = self.config.events.send(EngineEvent::Removed {
                doc_id: self.config.doc_id.clone(),
                ids: vec![utterance_id(source, start_sample)],
            });
        }
    }

    fn emit_final(&mut self, utterance: Utterance) {
        self.append(&[LogLine::Upsert {
            utterance: utterance.clone(),
        }]);
        let _ = self.config.events.send(EngineEvent::Utterance {
            doc_id: self.config.doc_id.clone(),
            utterance,
        });
    }

    fn flush_batches(&mut self, all: bool) {
        let now = Instant::now();
        for index in 0..2 {
            let due = all
                || self.last_segment[index]
                    .is_some_and(|at| now.saturating_duration_since(at) >= cloud::IDLE_FLUSH);
            if due && let Some(clip) = self.batchers[index].take() {
                self.send_clip(clip);
            }
        }
    }

    fn lane(&mut self, source: Source) -> Option<&CloudLane> {
        let index = source_index(source);
        if self.lanes[index].is_none() {
            self.lanes[index] = CloudLane::spawn(
                source,
                self.config.vocabulary.clone(),
                self.config.runtime.clone(),
                if cfg!(debug_assertions) {
                    // CAP_GPUI_MEETING_STUB_MODEL answers stub clips when the
                    // meeting has no local words of its own.
                    self.config.fallback.clone().or_else(|| {
                        std::env::var("CAP_GPUI_MEETING_STUB_MODEL").ok().map(|model| {
                            LocalModel {
                                model,
                                language: "en".into(),
                            }
                        })
                    })
                } else {
                    None
                },
                self.cloud_answer(),
                self.policy,
                self.results.0.clone(),
            );
        }
        self.lanes[index].as_ref()
    }

    /// Hands a clip to its track's lane. Live clips carry the track's
    /// speaker session; repair clips come after the fact and do not.
    fn dispatch(&mut self, clip: Clip, budget: Duration, probe: bool) -> Result<(), Clip> {
        let EngineMode::Cloud { language } = self.mode.clone() else {
            return Err(clip);
        };
        let source = clip.jobs.first().map(|j| j.source).unwrap_or_default();
        let index = source_index(source);
        let speakers = match (&clip.repair, &self.voices) {
            (None, Some(_)) => {
                let track = if index == 0 { "mic" } else { "system" };
                self.seq[index] += 1;
                Some(cloud::SpeakerSession {
                    session: cloud::SpeakerSession::name(&self.config.doc_id, track),
                    seq: self.seq[index] - 1,
                })
            }
            _ => None,
        };
        let key = (index, clip.parts.first().map_or(0, |p| p.source_start_sample));
        let covers: Vec<(u64, u64)> = clip
            .parts
            .iter()
            .map(|p| (p.source_start_sample, p.len))
            .collect();
        let live = clip.repair.is_none();
        let Some(lane) = self.lane(source) else {
            return Err(clip);
        };
        let job = LaneJob {
            clip,
            language,
            speakers,
            budget,
            probe,
        };
        match lane.jobs.send(job) {
            Ok(()) => {
                self.cloud_in_flight += 1;
                if live {
                    self.inflight.insert(key, covers);
                }
                Ok(())
            }
            Err(flume::SendError(job)) => {
                self.lanes[index] = None;
                Err(job.clip)
            }
        }
    }

    /// Whether a clip may go to the cloud now: always, unless it stopped
    /// answering; then only as the next due probe.
    fn cloud_turn(&mut self) -> Option<bool> {
        if self.cloud_refused || !matches!(self.mode, EngineMode::Cloud { .. }) {
            return None;
        }
        let Some(bridge) = self.bridge.as_mut() else {
            return Some(false);
        };
        // A refused sign-in is tried again at once with a new token, and
        // otherwise on the same slow schedule: the same key may work again.
        let token_changed = bridge.sign_in && current_token().is_some_and(|t| Some(&t) != bridge.token.as_ref());
        let due = Instant::now() >= bridge.next_probe;
        if bridge.probing || !(due || token_changed) {
            return None;
        }
        bridge.probing = true;
        Some(true)
    }

    fn send_clip(&mut self, clip: Clip) {
        match self.cloud_turn() {
            Some(probe) => {
                let budget = if probe { Duration::ZERO } else { self.policy.budget };
                if let Err(clip) = self.dispatch(clip, budget, probe) {
                    if probe && let Some(bridge) = self.bridge.as_mut() {
                        bridge.probing = false;
                    }
                    self.finalize_locally(clip.jobs);
                }
            }
            None => self.finalize_locally(clip.jobs),
        }
    }

    fn on_cloud(&mut self, msg: CloudMsg) {
        let (clip, result, probe) = match msg {
            CloudMsg::Retrying(issue) => {
                if !self.used_up() {
                    self.status.issue = Some(issue);
                    self.publish_status();
                }
                return;
            }
            CloudMsg::Done {
                clip,
                result,
                probe,
            } => (clip, result, probe),
        };
        self.cloud_in_flight = self.cloud_in_flight.saturating_sub(1);
        if let Some((source, first)) = clip
            .jobs
            .first()
            .map(|j| (source_index(j.source), j.start_sample))
        {
            self.inflight.remove(&(source, first));
        }
        if !matches!(result, Ok(_)) {
            for job in &clip.jobs {
                self.repairing.remove(&(source_index(job.source), job.start_sample));
            }
        }
        if probe && let Some(bridge) = self.bridge.as_mut() {
            bridge.probing = false;
        }
        match result {
            Ok(transcript) => {
                if self.bridge.take().is_some() || self.status.cloud != CloudState::Ok {
                    tracing::info!("cloud meeting transcription is answering again");
                    self.status.cloud = CloudState::Ok;
                    if !self.gaps.is_empty() {
                        self.repair_at = Some(Instant::now());
                    }
                }
                if matches!(self.status.kind, EngineKind::Cloud) {
                    self.status.issue = None;
                }
                self.publish_status();
                let source = clip.jobs.first().map(|j| j.source).unwrap_or_default();
                if clip.repair.is_none()
                    && let Some(voices) = self.voices.as_mut()
                {
                    // One clip's letters at a time: a letter is one person
                    // only within its clip (see `Voices::farm_clip`).
                    let words: Vec<(u64, u64, usize)> = transcript
                        .words
                        .iter()
                        .filter_map(|w| {
                            let (v, a, b) =
                                (w.voice()?, clip.source_ms(w.start_ms)?, clip.source_ms(w.end_ms)?);
                            Some((a, b.max(a + 1), v))
                        })
                        .collect();
                    voices.farm_clip(source, &words);
                }
                let parts: Vec<u64> = clip.parts.iter().map(|p| p.source_start_sample).collect();
                for (start_sample, mut words) in
                    parts.into_iter().zip(clip.words_by_part(&transcript.words))
                {
                    self.spell(&mut words);
                    self.commit(source, start_sample, words);
                }
                if let Some(gap) = clip.repair.as_ref() {
                    self.repair_clip_done(gap.clone(), true);
                }
            }
            Err(CloudError::UpgradeRequired) => {
                // Cloud transcription is not this account's: the meeting
                // goes on with what this computer has.
                self.cloud_refused = true;
                let error = CloudError::UpgradeRequired;
                if let Some(gap) = clip.repair.clone() {
                    self.repair_clip_done(gap, false);
                }
                match self.config.fallback.clone() {
                    Some(fallback) => {
                        if !matches!(self.mode, EngineMode::Local(_)) {
                            self.set_mode(EngineMode::Local(fallback), Some(error.describe()));
                        }
                    }
                    None => self.set_mode(
                        EngineMode::Unavailable(error.describe()),
                        Some(error.describe()),
                    ),
                }
                if clip.repair.is_none() {
                    self.finalize_locally(clip.jobs);
                }
                self.drain_batches_locally();
            }
            Err(error) => {
                self.cloud_down(&error);
                match clip.repair.clone() {
                    Some(gap) => self.repair_clip_done(gap, false),
                    None => self.finalize_locally(clip.jobs),
                }
            }
        }
    }

    /// The day's cloud audio is used up and its reset has not come yet.
    fn used_up(&self) -> bool {
        self.bridge
            .as_ref()
            .and_then(|bridge| bridge.daily_until)
            .is_some_and(|until| Instant::now() < until)
    }

    /// The cloud is not answering: local words stand in where there are
    /// any, the rest of the audio waits in the ledger, and a probe every
    /// minute or so (doubling to ten) finds out when the cloud is back.
    fn cloud_down(&mut self, error: &CloudError) {
        let sign_in = matches!(error, CloudError::NotSignedIn);
        let daily = match error {
            CloudError::DailyLimit { retry_after_secs } => {
                Some(Duration::from_secs(*retry_after_secs))
            }
            _ => None,
        };
        if self.used_up() && daily.is_none() && !sign_in {
            return;
        }
        let now = Instant::now();
        match self.bridge.as_mut() {
            Some(bridge) => {
                bridge.daily_until = None;
                bridge.interval = (bridge.interval * 2).min(self.policy.probe_max);
                bridge.next_probe = now + self.policy.next_probe(bridge.interval);
                bridge.sign_in = sign_in;
                bridge.token = current_token();
            }
            None => {
                tracing::warn!(?error, "cloud meeting transcription is down, bridging");
                let interval = self.policy.probe_first;
                self.bridge = Some(Bridge {
                    next_probe: now + self.policy.next_probe(interval),
                    interval,
                    sign_in,
                    token: current_token(),
                    probing: false,
                    daily_until: None,
                });
            }
        }
        // Used up for the day: ask again only once the day resets.
        if let (Some(reset), Some(bridge)) = (daily, self.bridge.as_mut()) {
            bridge.interval = reset;
            bridge.next_probe = now + reset + self.policy.probe_jitter.mul_f64(jitter());
            bridge.daily_until = Some(bridge.next_probe);
        }
        let local = self.config.fallback.is_some();
        self.status.cloud = if sign_in {
            CloudState::SignIn { local }
        } else if daily.is_some() {
            CloudState::DailyLimit { local }
        } else {
            CloudState::Down { local }
        };
        self.status.issue = Some(error.describe());
        self.publish_status();
    }

    // Repair

    /// The saved file a moment of a track is in: the last one starting at
    /// or before it.
    fn part_at(&self, source: Source, at: u64) -> Option<AudioPart> {
        self.config
            .audio
            .iter()
            .filter(|p| p.source == source && p.offset_samples <= at)
            .max_by_key(|p| p.offset_samples)
            .cloned()
    }

    /// The saved audio of one stretch of a track, across the files it spans.
    /// A writer that failed left a stretch between its file and the next one
    /// unsaved: silence stands in for it. None when no file covers the start
    /// (audio not kept, or gone); short only where the saved audio ends.
    fn read_audio(&mut self, source: Source, start: u64, len: u64) -> Option<Vec<f32>> {
        #[cfg(test)]
        if let Some(audio) = &self.hooks.audio {
            return audio(source, start, len);
        }
        let end = start + len;
        let mut part = self.part_at(source, start)?;
        let mut out = Vec::new();
        let mut at = start;
        loop {
            let got = self.read_part(&part, at, end - at)?;
            at += got.len() as u64;
            out.extend(got);
            if at >= end {
                break;
            }
            let Some(next) = self
                .config
                .audio
                .iter()
                .filter(|p| {
                    p.source == source
                        && p.offset_samples > part.offset_samples
                        && p.offset_samples < end
                })
                .min_by_key(|p| p.offset_samples)
                .cloned()
            else {
                break;
            };
            if next.offset_samples > at {
                out.resize(out.len() + (next.offset_samples - at) as usize, 0.0);
                at = next.offset_samples;
            }
            part = next;
        }
        Some(out)
    }

    fn read_part(&mut self, part: &AudioPart, at: u64, len: u64) -> Option<Vec<f32>> {
        let source = part.source;
        let start = at.max(part.offset_samples);
        let index = source_index(source);
        if self.readers[index].as_ref().is_none_or(|(path, _)| *path != part.path) {
            match TrackReader::open(&part.path) {
                Ok(reader) => self.readers[index] = Some((part.path.clone(), reader)),
                Err(error) => {
                    tracing::warn!(%error, path = %part.path.display(), "could not open meeting audio for repair");
                    return None;
                }
            }
        }
        let (_, reader) = self.readers[index].as_mut()?;
        match reader.read(start - part.offset_samples, len) {
            Ok(samples) => Some(samples),
            Err(error) => {
                tracing::warn!(%error, "could not read meeting audio for repair");
                self.readers[index] = None;
                None
            }
        }
    }

    /// Where the first of the track's files starting in `(after, before)`
    /// begins.
    fn next_part_start(&self, source: Source, after: u64, before: u64) -> Option<u64> {
        self.config
            .audio
            .iter()
            .filter(|p| p.source == source && p.offset_samples > after && p.offset_samples < before)
            .map(|p| p.offset_samples)
            .min()
    }

    /// A gap's audio as segments: the exact ones when known, else the
    /// speech found again in the span. None when the audio can't be read.
    fn gap_jobs(&mut self, gap: &Gap) -> Option<Vec<SegmentJob>> {
        let mut jobs = Vec::new();
        if gap.segments.is_empty() {
            let mut segmenter = Segmenter::new(match gap.source {
                Source::Mic => SegmenterConfig::microphone(),
                Source::System => SegmenterConfig::default(),
            });
            // In fixed reads: a long tail is hours of silence at most, and
            // only the speech found in it is kept.
            let mut found = Vec::new();
            let mut at = gap.start_sample;
            while at < gap.end_sample {
                let want = SWEEP_READ_SAMPLES.min(gap.end_sample - at);
                let samples = self.read_audio(gap.source, at, want)?;
                found.extend(segmenter.push(at, &samples));
                at += samples.len() as u64;
                if (samples.len() as u64) < want {
                    // This file ends here. After a clock jump the track goes
                    // on in a later file, past a hole; otherwise this is
                    // where the saved audio ends.
                    let Some(next) = self.next_part_start(gap.source, at, gap.end_sample) else {
                        break;
                    };
                    at = next;
                }
            }
            found.extend(segmenter.flush());
            for segment in found {
                jobs.push(SegmentJob {
                    source: gap.source,
                    start_sample: segment.start_sample,
                    samples: segment.samples,
                    speech_ms: segment.speech_ms,
                });
            }
        } else {
            let mut segments = gap.segments.clone();
            segments.sort_unstable();
            // Never before the previous read's start: the reader only goes
            // forward, and an earlier start decodes the file from the top.
            let mut floor = 0u64;
            for (start, len) in segments {
                // Context only from the file that holds the segment: before
                // it lies another file's end and an unsaved stretch.
                let owner = self.part_at(gap.source, start).map_or(0, |p| p.offset_samples);
                let from = start
                    .saturating_sub(REPAIR_CONTEXT_SAMPLES)
                    .max(floor)
                    .max(owner)
                    .min(start);
                floor = from;
                let mut samples = self.read_audio(gap.source, from, start + len - from)?;
                let context: Vec<f32> = samples.drain(..((start - from) as usize).min(samples.len())).collect();
                let short = len.saturating_sub(samples.len() as u64);
                if short > 0 {
                    // While the meeting records, a short read is a file still
                    // being written: wait for it. After Stop nothing more is
                    // written, so what is there is all there will be.
                    if !self.finishing || samples.is_empty() {
                        for job in &jobs {
                            self.repairing.remove(&(source_index(job.source), job.start_sample));
                        }
                        return None;
                    }
                    tracing::info!(
                        id = gap.id,
                        short_ms = timeline::samples_to_ms(short),
                        "meeting repair used the saved audio up to its end"
                    );
                }
                let speech_ms = timeline::samples_to_ms(samples.len() as u64);
                if !context.is_empty() {
                    self.repair_context.insert((source_index(gap.source), start), context);
                }
                jobs.push(SegmentJob {
                    source: gap.source,
                    start_sample: start,
                    samples,
                    speech_ms,
                });
            }
        }
        for job in &jobs {
            self.repairing.insert((source_index(job.source), job.start_sample));
        }
        Some(jobs)
    }

    /// Sends one gap to the cloud as repair clips. False when it could not
    /// go (no audio, no lane).
    fn repair_by_cloud(&mut self, gap: &Gap, budget: Duration) -> bool {
        let Some(jobs) = self.gap_jobs(gap) else {
            return false;
        };
        for job in &jobs {
            self.repair_context.remove(&(source_index(job.source), job.start_sample));
        }
        if jobs.is_empty() {
            self.close_gap(&gap.id);
            return true;
        }
        let mut batcher = Batcher::default();
        let mut clips = Vec::new();
        for job in jobs {
            // Its voices are told apart now, like a live segment's.
            self.diarize(&job);
            clips.extend(batcher.push(job));
        }
        clips.extend(batcher.take());
        let mut sent = 0;
        for mut clip in clips {
            clip.repair = Some(gap.id.clone());
            match self.dispatch(clip, budget, false) {
                Ok(()) => sent += 1,
                Err(clip) => {
                    for job in &clip.jobs {
                        self.repairing.remove(&(source_index(job.source), job.start_sample));
                    }
                }
            }
        }
        if sent > 0 {
            self.repairs.insert(gap.id.clone(), sent);
        }
        sent > 0
    }

    fn repair_clip_done(&mut self, gap: String, ok: bool) {
        if !ok {
            // The gap stays; the next repair sends it whole again.
            self.repairs.remove(&gap);
            return;
        }
        let left = self.repairs.get_mut(&gap).map(|n| {
            *n = n.saturating_sub(1);
            *n
        });
        if left == Some(0) {
            self.close_gap(&gap);
        }
    }

    fn repair_locally(&mut self, gap: &Gap, local: &LocalModel) -> bool {
        let Some(jobs) = self.gap_jobs(gap) else {
            return false;
        };
        for job in jobs {
            self.diarize(&job);
            let context = self.repair_context.remove(&(source_index(job.source), job.start_sample));
            let heard = match &context {
                Some(context) => {
                    let mut samples = context.clone();
                    samples.extend_from_slice(&job.samples);
                    let with_context = SegmentJob {
                        start_sample: job.start_sample - context.len() as u64,
                        samples,
                        ..job.clone()
                    };
                    let from = job.start_ms();
                    self.transcribe(local, &with_context)
                        .map(|words| words.into_iter().filter(|w| w.end_ms > from).collect())
                }
                None => self.transcribe(local, &job),
            };
            match heard {
                Ok(words) => self.commit(job.source, job.start_sample, words),
                Err(error) => {
                    tracing::warn!(%error, "meeting repair transcription failed");
                    self.repairing.remove(&(source_index(job.source), job.start_sample));
                    return false;
                }
            }
        }
        self.close_gap(&gap.id);
        true
    }

    /// While the meeting runs, gaps go to the cloud again once it answers,
    /// a few at a time; anything that needs this computer's model waits for
    /// Stop so the live captions keep up.
    fn repair_live(&mut self) {
        self.repair_at = None;
        if self.bridge.is_some()
            || self.cloud_refused
            || !matches!(self.mode, EngineMode::Cloud { .. })
        {
            return;
        }
        let waiting: Vec<Gap> = self
            .gaps
            .iter()
            .filter(|g| !self.repairs.contains_key(&g.id))
            .take(LIVE_REPAIRS.saturating_sub(self.repairs.len()))
            .cloned()
            .collect();
        for gap in waiting {
            self.repair_by_cloud(&gap, self.policy.budget);
        }
        if self.gaps.iter().any(|g| !self.repairs.contains_key(&g.id)) {
            self.repair_at = Some(Instant::now() + LIVE_REPAIR_EVERY);
        }
    }

    /// After Stop every gap is tried: by the cloud when this meeting uses
    /// it, then by this computer's model; what neither can fill stays in the
    /// ledger for the next launch.
    fn repair_after_stop(&mut self) {
        if self.gaps.is_empty() {
            return;
        }
        tracing::info!(gaps = self.gaps.len(), "repairing the meeting from its saved audio");
        // A reader opened while the meeting ran stopped at the end of the
        // file as it was then; after Stop the files are complete.
        self.readers = [None, None];
        self.heard = self.heard_spans();
        if matches!(self.mode, EngineMode::Cloud { .. }) && !self.cloud_refused {
            self.bridge = None;
            let open: Vec<Gap> = self
                .gaps
                .iter()
                .filter(|g| !self.repairs.contains_key(&g.id))
                .cloned()
                .collect();
            // The first gap finds out whether the cloud answers; only then
            // do the rest go, so an outage costs one wait, not one per gap.
            let mut open = open.into_iter();
            for gap in open.by_ref() {
                if self.repair_by_cloud(&gap, self.policy.stop_budget) {
                    break;
                }
            }
            self.await_cloud();
            if self.bridge.is_none() {
                for gap in open {
                    self.repair_by_cloud(&gap, self.policy.stop_budget);
                }
                self.await_cloud();
            }
        }
        if let Some(local) = self.local_model() {
            let open: Vec<Gap> = self.gaps.clone();
            for gap in open {
                self.repair_locally(&gap, &local);
            }
        }
        self.repairing.clear();
        self.repair_context.clear();
        self.readers = [None, None];
    }

    /// The ms spans each track's final lines cover (their words when known).
    fn heard_spans(&self) -> [Vec<(u64, u64)>; 2] {
        let mut heard = [Vec::new(), Vec::new()];
        let Ok((transcript, _)) =
            cap_meetings::transcript::Transcript::load_jsonl(&self.config.transcript_path)
        else {
            return heard;
        };
        for u in transcript.utterances().iter().filter(|u| u.is_final) {
            let spans = &mut heard[source_index(u.source)];
            if u.words.is_empty() {
                spans.push((u.start_ms, u.end_ms.max(u.start_ms)));
            } else {
                spans.extend(u.words.iter().map(|w| (w.start_ms, w.end_ms.max(w.start_ms))));
            }
        }
        for spans in &mut heard {
            spans.sort_unstable();
        }
        heard
    }

    /// Every 30 ms frame of a track's saved audio as (timeline sample, dB),
    /// and the timeline sample where its saved audio really ends (the last
    /// frame is usually partial, so it is not the last frame's start + 480).
    fn track_levels(&self, source: Source) -> (Vec<(u64, f32)>, u64) {
        let mut parts: Vec<&AudioPart> =
            self.config.audio.iter().filter(|p| p.source == source).collect();
        parts.sort_by_key(|p| p.offset_samples);
        let mut levels = Vec::new();
        let mut end = 0u64;
        for part in parts {
            let mut reader = match TrackReader::open(&part.path) {
                Ok(reader) => reader,
                Err(error) => {
                    tracing::warn!(%error, "could not read meeting audio for the sweep");
                    continue;
                }
            };
            let mut at = 0u64;
            loop {
                let Ok(samples) = reader.read(at, SWEEP_READ_SAMPLES) else {
                    break;
                };
                for (n, frame) in samples.chunks(SWEEP_FRAME).enumerate() {
                    if frame.len() < SWEEP_FRAME / 2 {
                        continue;
                    }
                    let power = frame.iter().map(|x| x * x).sum::<f32>() / frame.len() as f32;
                    let db = 10.0 * power.max(1e-12).log10();
                    levels.push((part.offset_samples + at + (n * SWEEP_FRAME) as u64, db));
                }
                end = end.max(part.offset_samples + at + samples.len() as u64);
                if (samples.len() as u64) < SWEEP_READ_SAMPLES {
                    break;
                }
                at += SWEEP_READ_SAMPLES;
            }
        }
        (levels, end)
    }

    /// After Stop: speech in the saved audio that no line covers is
    /// transcribed again, whatever kept it out (the live segmenter missing
    /// a quiet voice, a word the model dropped, a stretch lost some other
    /// way). Microphone stretches during the call's own speech are left
    /// alone: that is the call heard in the room. True when it found any.
    fn coverage_sweep(&mut self) -> bool {
        if self.config.audio.is_empty() {
            return false;
        }
        let cloud = matches!(self.mode, EngineMode::Cloud { .. }) && !self.cloud_refused && self.bridge.is_none();
        if !cloud && self.local_model().is_none() {
            return false;
        }
        let started = Instant::now();
        let heard = self.heard_spans();
        let mut found = false;
        for source in [Source::Mic, Source::System] {
            let (levels, end) = self.track_levels(source);
            let missing = within_track(sweep_missing(
                &levels,
                &heard[source_index(source)],
                if source == Source::Mic { &heard[1] } else { &[] },
                &self
                    .gaps
                    .iter()
                    .filter(|g| g.source == source)
                    .map(|g| (timeline::samples_to_ms(g.start_sample), timeline::samples_to_ms(g.end_sample)))
                    .collect::<Vec<_>>(),
            ), end);
            tracing::info!(
                ?source,
                frames = levels.len(),
                stretches = missing.len(),
                ms = missing.iter().map(|(_, len)| timeline::samples_to_ms(*len)).sum::<u64>(),
                "coverage sweep"
            );
            if !missing.is_empty() {
                found = true;
                for chunk in missing.chunks(GAP_SEGMENTS_MAX) {
                    self.open_gap(source, chunk.to_vec(), reason::SWEEP);
                }
            }
        }
        tracing::info!(elapsed_ms = started.elapsed().as_millis() as u64, found, "coverage sweep done");
        found
    }

    /// At the end of the meeting: every clip sent comes back before the
    /// final pass over the voices.
    fn await_cloud(&mut self) {
        let patience = self.policy.budget + request_timeout(cloud::CLIP_MAX_SECONDS * 1000) + Duration::from_secs(30);
        while self.cloud_in_flight > 0 {
            match self.results.1.recv_timeout(patience) {
                Ok(msg) => self.on_cloud(msg),
                Err(_) => {
                    self.cloud_lost();
                    break;
                }
            }
        }
    }

    /// A lane never answered: its clips keep their local words, or their
    /// audio goes in the ledger.
    fn cloud_lost(&mut self) {
        tracing::warn!(clips = self.cloud_in_flight, "cloud meeting transcription stopped answering");
        self.cloud_in_flight = 0;
        self.lanes = [None, None];
        for ((index, _), covers) in std::mem::take(&mut self.inflight) {
            let source = source_of(index);
            let mut missing = Vec::new();
            for (start, len) in covers {
                match self.provisional.get(&(index, start)).map(|p| p.words.clone()) {
                    Some(words) => self.commit(source, start, words),
                    None => missing.push((start, len)),
                }
            }
            if !missing.is_empty() {
                self.open_gap(source, missing, reason::CLOUD);
            }
        }
    }

    fn drain_batches_locally(&mut self) {
        for index in 0..2 {
            if let Some(clip) = self.batchers[index].take() {
                self.finalize_locally(clip.jobs);
            }
        }
    }
}

/// The parts of [start, end) the spans leave open.
fn uncovered(start: u64, end: u64, spans: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut spans: Vec<(u64, u64)> = spans
        .iter()
        .filter(|(a, b)| *b > start && *a < end)
        .copied()
        .collect();
    spans.sort_unstable();
    let mut out = Vec::new();
    let mut at = start;
    for (a, b) in spans {
        if a > at {
            out.push((at, a.min(end)));
        }
        at = at.max(b);
        if at >= end {
            break;
        }
    }
    if at < end {
        out.push((at, end));
    }
    out
}

fn overlap_ms(start: u64, end: u64, spans: &[(u64, u64)]) -> u64 {
    spans
        .iter()
        .map(|(a, b)| end.min(*b).saturating_sub(start.max(*a)))
        .sum()
}

/// Sweep stretches cut to where the saved track ends. The sweep's 30 ms
/// frames round the track's last partial frame up to a whole one, and a
/// stretch reaching past the audio would wait for samples that never come.
pub(crate) fn within_track(missing: Vec<(u64, u64)>, end: u64) -> Vec<(u64, u64)> {
    missing
        .into_iter()
        .filter(|(start, _)| *start < end)
        .map(|(start, len)| (start, len.min(end - start)))
        .collect()
}

/// The stretches (start, length in samples) of a track's speech that the
/// heard spans don't cover: the sweep's decision, apart from reading audio.
pub(crate) fn sweep_missing(
    levels: &[(u64, f32)],
    heard: &[(u64, u64)],
    call: &[(u64, u64)],
    waiting: &[(u64, u64)],
) -> Vec<(u64, u64)> {
    let mut sounding: Vec<f32> = levels.iter().map(|(_, db)| *db).filter(|db| *db > -100.0).collect();
    if sounding.is_empty() {
        return Vec::new();
    }
    sounding.sort_by(f32::total_cmp);
    let track_end = levels.iter().map(|(at, _)| at + SWEEP_FRAME as u64).max().unwrap_or(0);
    // The track's quiet: its pauses. A track that is nearly all speech has
    // few, so the bar never rises above plain speaking level.
    let quiet = sounding[sounding.len() / 20];
    let threshold = (quiet + SWEEP_ABOVE_QUIET_DB).clamp(SWEEP_MIN_DB, SWEEP_MAX_DB);
    // Runs of loud frames, joined across short pauses.
    let mut stretches: Vec<(u64, u64, usize)> = Vec::new();
    let mut last_loud: Option<usize> = None;
    for (i, (at, db)) in levels.iter().enumerate() {
        if *db < threshold {
            continue;
        }
        let end = at + SWEEP_FRAME as u64;
        match (stretches.last_mut(), last_loud) {
            (Some(s), Some(prev)) if i - prev <= SWEEP_JOIN_FRAMES && *at <= s.1 + (SWEEP_JOIN_FRAMES * SWEEP_FRAME) as u64 => {
                s.1 = end;
                s.2 += 1;
            }
            _ => stretches.push((*at, end, 1)),
        }
        last_loud = Some(i);
    }
    // Inside each stretch, what no line covers: a lost segment in the
    // middle of continuous speech still shows, with its neighbours heard.
    let covered: Vec<(u64, u64)> = heard
        .iter()
        .map(|(a, b)| (a.saturating_sub(SWEEP_HEARD_SLACK_MS), b + SWEEP_HEARD_SLACK_MS))
        .collect();
    let loud_frames = |a_ms: u64, b_ms: u64| {
        let (from, to) = (timeline::ms_to_samples(a_ms), timeline::ms_to_samples(b_ms));
        levels
            .iter()
            .filter(|(at, db)| *at >= from && *at < to && *db >= threshold)
            .count()
    };
    let mut missing: Vec<(u64, u64)> = Vec::new();
    for (start, end, frames) in stretches {
        if frames < SWEEP_MIN_SPEECH_FRAMES {
            continue;
        }
        let (a, b) = (timeline::samples_to_ms(start), timeline::samples_to_ms(end));
        for (pa, pb) in uncovered(a, b, &covered) {
            let len = pb - pa;
            if len < SWEEP_MIN_MS || loud_frames(pa, pb) < SWEEP_MIN_SPEECH_FRAMES {
                continue;
            }
            let share = |spans: &[(u64, u64)]| overlap_ms(pa, pb, spans) as f64 / len as f64;
            if share(call) >= SWEEP_COVERED || share(waiting) > 0.0 {
                continue;
            }
            let (ps, pe) = (timeline::ms_to_samples(pa), timeline::ms_to_samples(pb));
            let from = ps.saturating_sub(SWEEP_PAD_SAMPLES);
            let to = (pe + SWEEP_PAD_SAMPLES).min(track_end).max(pe.min(track_end));
            match missing.last_mut() {
                Some((s, l)) if from <= *s + *l + timeline::RATE as u64 && to - *s <= SWEEP_MAX_SAMPLES => {
                    *l = (*l).max(to - *s);
                }
                _ => missing.push((from, to - from)),
            }
        }
    }
    // Long stretches go as several segments the model can take.
    missing
        .into_iter()
        .flat_map(|(s, l)| {
            (0..l.div_ceil(SWEEP_MAX_SAMPLES)).map(move |n| {
                let at = s + n * SWEEP_MAX_SAMPLES;
                (at, SWEEP_MAX_SAMPLES.min(s + l - at))
            })
        })
        .collect()
}

/// Debug builds only: `CAP_GPUI_MEETING_CLOUD_STUB=1` answers cloud clips
/// with the local model, so the batching path can be exercised without the
/// server.
fn cloud_stub(
    local: Option<&LocalModel>,
    clip: &Clip,
    vocabulary: &[String],
) -> Option<Result<cloud::CloudTranscript, CloudError>> {
    if !cfg!(debug_assertions) || std::env::var_os("CAP_GPUI_MEETING_CLOUD_STUB").is_none() {
        return None;
    }
    if debug_cloud_down() {
        // CAP_GPUI_MEETING_CLOUD_FAULT_KIND=auth: the sign-in is refused instead.
        return Some(Err(match std::env::var("CAP_GPUI_MEETING_CLOUD_FAULT_KIND").as_deref() {
            Ok("auth") => CloudError::NotSignedIn,
            _ => CloudError::Offline("debug cloud fault".into()),
        }));
    }
    let local = local?;
    let words = crate::transcription::transcribe_samples_blocking(
        &local.model,
        &local.language,
        &clip.samples,
        vocabulary,
    );
    Some(
        words
            .map(|words| cloud::CloudTranscript {
                text: words
                    .iter()
                    .map(|w| w.text.trim())
                    .collect::<Vec<_>>()
                    .join(" "),
                words: words
                    .iter()
                    .map(|w| cloud::CloudWord {
                        text: w.text.trim().to_string(),
                        start_ms: f64::from(w.start.max(0.0)) * 1000.0,
                        end_ms: f64::from(w.end.max(w.start).max(0.0)) * 1000.0,
                        speaker: None,
                    })
                    .collect(),
            })
            .map_err(CloudError::Failed),
    )
}

pub fn utterance(
    source: Source,
    start_sample: u64,
    words: Vec<Word>,
    is_final: bool,
) -> Option<Utterance> {
    let text = words
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let start = timeline::samples_to_ms(start_sample);
    let start_ms = words.first().map_or(start, |w| w.start_ms);
    let end_ms = words
        .iter()
        .map(|w| w.end_ms)
        .max()
        .unwrap_or(start_ms)
        .max(start_ms);
    Some(Utterance {
        id: utterance_id(source, start_sample),
        source,
        speaker: None,
        speaker_id: None,
        start_ms,
        end_ms,
        text: text.to_string(),
        is_final,
        words,
    })
}

#[cfg(test)]
mod tests;
