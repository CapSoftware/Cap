// This service is the API the meeting UI is written against, and that UI lands
// separately; until it does, much of the surface has no caller in this crate.
#![allow(dead_code)]

pub mod access;
pub mod accounts;
pub(crate) mod audio_file;
pub mod calendar;
pub mod capture;
pub mod cloud;
#[cfg(debug_assertions)]
pub mod dev;
pub mod device;
mod echo_periods;
pub mod engine;
pub mod generate;
pub mod health;
mod mic_watch;
pub(crate) mod persist;
pub mod speakers;
#[cfg(test)]
pub(crate) mod tests;
pub(crate) mod timeline;
pub mod voices;

use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    path::PathBuf,
    time::{Duration, Instant},
};

use cap_meeting_platform::{MicSnapshot, MicWatcher};
use cap_meetings::{
    Millis, Now,
    apps::{self, Platform},
    browser::{BrowserEvidence, judge_browser},
    detect::{DetectConfig, DetectEvent, Detector, MicClient},
    library::{DocKind, DocMeta, Library, MeetingDetails, TitleHint, auto_title_from, lock_meta},
    prompt::{Prompt, PromptAction, PromptPlanner, RecordSource, RecordingState},
    session::{Session, SessionAction, SessionState, Warning},
    settings::{Engine, Language, MeetingSettings, Microphone},
    templates::{self, Template},
    transcript::{EchoConfig, LogLine, Transcript, Utterance, append_jsonl},
};
use cap_recording::feeds::microphone::{
    AddSender, MicrophoneFeed, MicrophoneSamples, RemoveSender,
};
use chrono::{DateTime, Utc};
use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global, Subscription, Task};
use serde_json::json;

pub use access::AiAccess;
pub use calendar::{CalendarError, CalendarSource, SourceConfig, SyncErrorKind};
pub use cap_calendar::{Agenda, CalendarEvent};
pub use cap_meetings::{session::StopReason, transcript::Source};
pub use capture::{CaptureStats, HealthIssue, SourceHealth};
pub use cloud::Capabilities;
pub use engine::EngineStatus;
pub use generate::{AskAnswer, AskTurn, GenerateOptions, NotesError};

use capture::{CaptureConfig, CaptureEvent, MeetingCapture, MicInput};
use engine::{
    AudioPart, EngineCommand, EngineConfig, EngineEvent, EngineHandle, EngineMode, LocalModel,
};

const NOTIFY_INTERVAL_MS: u64 = 125;

/// Speech this recent counts as someone speaking now.
const CUE_VOICE_HOLD: Duration = Duration::from_millis(1_500);
/// Nothing new in the live view for this long, while someone speaks, is
/// worth saying why.
const CUE_AFTER: Duration = Duration::from_secs(4);

/// Whether the live view says that lines come after each sentence on this
/// computer: only a slow computer (where captions often wait for finished
/// lines), only while someone is speaking, and only once the view has shown
/// nothing new for `CUE_AFTER` (counted from the start when nothing has
/// shown yet). The next words take it away.
pub fn listening_cue(
    slow: bool,
    now: Instant,
    started: Instant,
    voice_at: Option<Instant>,
    line_at: Option<Instant>,
) -> bool {
    slow && voice_at.is_some_and(|at| now.saturating_duration_since(at) <= CUE_VOICE_HOLD)
        && now.saturating_duration_since(line_at.unwrap_or(started)) >= CUE_AFTER
}
const RESUME_GAP_MS: u64 = 1_000;
/// After a wake that offers Resume, when to look whether the meeting's call
/// app is still on the microphone (each wait after the last look), all
/// inside the session's `WAKE_CALL_WINDOW_MS`.
const WAKE_LOOKS: [Duration; 6] = [
    Duration::from_millis(250),
    Duration::from_millis(750),
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(2),
    Duration::from_secs(2),
];
/// How long "Resumed after the computer slept" shows.
const RESUMED_LINE: Duration = Duration::from_secs(20);
/// Quitting waits this long for a stopped meeting's last words; what is left
/// stays in its ledger and is finished at the next launch.
const QUIT_DRAIN: Duration = Duration::from_secs(10);
const HEALTH_TICK: Duration = Duration::from_secs(1);
const DISK_CHECK_EVERY: Duration = Duration::from_secs(30);
const NO_TAP_CALLBACKS_AFTER: Duration = Duration::from_secs(3);
const LOCAL_MODELS: [&str; 4] = ["best", "best-max", "medium", "small"];
/// Cap Notes is tuned for one speech model and asks for that one.
pub const NOTES_MODEL: &str = "best";
/// Where that model cannot run (a Mac without Apple silicon) or cannot write
/// the meeting's language, the model that can.
pub const NOTES_FALLBACK_MODEL: &str = "small";
/// On a computer too slow for those (`device::slow`), the most compatible
/// model that keeps up: Whisper base.
pub const SLOW_NOTES_MODEL: &str = "base";
const NOTES_PATH: &str = "/api/desktop/meetings/notes";
const ASK_PATH: &str = "/api/desktop/meetings/ask";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StartSource {
    Manual,
    Prompt(u64),
    Event(String),
    Resume(String),
    /// Record into a note that already exists, plain or meeting. An event
    /// key links that calendar meeting when the note has none yet.
    Into {
        doc_id: String,
        event_id: Option<String>,
    },
}

/// Why a start was refused while an earlier one is still under way (not a
/// problem with the audio).
pub const STILL_STARTING: &str = "a recording is still starting";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MeetingError {
    Disabled,
    NotFound,
    PromptGone,
    NoAudioSource(String),
    Library(String),
}

impl std::fmt::Display for MeetingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeetingError::Disabled => f.write_str("Meeting notes are turned off"),
            MeetingError::NotFound => f.write_str("That meeting no longer exists"),
            MeetingError::PromptGone => f.write_str("That prompt is no longer showing"),
            MeetingError::NoAudioSource(reason) => write!(f, "Nothing can be recorded: {reason}"),
            MeetingError::Library(reason) => write!(f, "The meeting could not be saved: {reason}"),
        }
    }
}

impl std::error::Error for MeetingError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActiveState {
    Starting,
    Recording,
    Stopping,
    ResumeOffered,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MeetingWarning {
    Ending {
        stop_at: Instant,
        reason: StopReason,
    },
    Inactivity {
        stop_at: Instant,
    },
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceState {
    pub level: f32,
    pub health: SourceHealth,
    pub speech_ms: u64,
    pub dropped_batches: u64,
    pub dropped_segments: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ActiveMeeting {
    pub doc_id: String,
    pub title: String,
    pub started_at: DateTime<Utc>,
    pub started: Instant,
    pub state: ActiveState,
    pub mic: SourceState,
    pub system: SourceState,
    pub engine: EngineStatus,
    pub warning: Option<MeetingWarning>,
    pub resume_offer_until: Option<Instant>,
    /// The Resume offer follows a system sleep (not a quiet spell).
    pub slept: bool,
    /// The call went on through a sleep and the meeting resumed by itself
    /// (said for a moment once it records again).
    pub resumed_after_sleep: bool,
    pub app_name: Option<String>,
    pub event_id: Option<String>,
    /// What is worth saying about this meeting's health now, most urgent
    /// first; the line shows the first one not dismissed.
    pub health: Vec<health::Concern>,
    /// A call is on but its audio is not arriving.
    pub not_hearing: bool,
    /// An audio file could not be written.
    pub audio_failed: bool,
    /// The disk is almost full.
    pub low_disk: bool,
}

impl ActiveMeeting {
    pub fn source(&self, source: Source) -> &SourceState {
        match source {
            Source::Mic => &self.mic,
            Source::System => &self.system,
        }
    }

    fn source_mut(&mut self, source: Source) -> &mut SourceState {
        match source {
            Source::Mic => &mut self.mic,
            Source::System => &mut self.system,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AttentionReason {
    RecordingStarted { doc_id: String },
    EndingCountdown,
    InactivityWarning,
    ResumeOffered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesStage {
    Started,
    /// No connection yet; Cap tries again by itself (true), or tries now.
    Waiting(bool),
    Title(String),
    Delta,
    Done,
    Failed(NotesError),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NotesState {
    pub running: bool,
    /// Cap tries again shortly: it couldn't reach the server, or (when
    /// `offline` is false) the server answered with trouble.
    pub waiting: bool,
    pub offline: bool,
    pub markdown: String,
    pub title: Option<String>,
    pub error: Option<NotesError>,
}

/// Seconds between tries when the notes can't reach the server, then a
/// minute apart until [`NOTES_RETRY_FOR`] has passed.
const NOTES_RETRY_SECS: [u64; 5] = [2, 5, 10, 30, 60];
const NOTES_RETRY_FOR: Duration = Duration::from_secs(30 * 60);

/// Failures worth trying again: the network or the server, never a
/// refusal that would only repeat.
pub fn notes_retryable(error: &NotesError) -> bool {
    matches!(
        error,
        NotesError::Offline(_)
            | NotesError::Interrupted(_)
            | NotesError::Failed(_)
            | NotesError::RateLimited { .. }
    )
}

/// A wait on the network, not on Cap: only then is it the connection.
pub fn waits_on_connection(error: &NotesError) -> bool {
    matches!(error, NotesError::Offline(_))
}

pub fn notes_retry_wait(attempt: usize, error: &NotesError) -> Duration {
    let wait = Duration::from_secs(NOTES_RETRY_SECS.get(attempt).copied().unwrap_or(60));
    match error {
        NotesError::RateLimited { retry_after_secs } => {
            wait.max(Duration::from_secs(*retry_after_secs))
        }
        _ => wait,
    }
}

/// What puts one speaker rename back exactly.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenameUndo {
    back: RenameBack,
    pub from: String,
    pub to: String,
}

/// How a rename is taken back: a line for a name or a track, or only the
/// change it made to the voice names, so later edits stay.
#[derive(Clone, Debug, PartialEq, Eq)]
enum RenameBack {
    Line(LogLine),
    Names(ChoiceUndo),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpeakerRef {
    Source(Source),
    Named(String),
    /// A voice the meeting told apart; the name holds for all its lines.
    Id(u32),
}

/// A choice the person makes on a voice in the speaker popover.
#[derive(Clone, Debug)]
enum VoiceChoice {
    /// Leave a told-apart voice out of the notes, or put it back in.
    LeaveOutId(u32, bool),
    /// "That's not me" (true) or "That's me" (false).
    NotMe(u32, bool),
    /// Leave a voice without a told-apart id out, or put it back in.
    LeaveOut(cap_meetings::transcript::Voice, bool),
}

/// What a choice changed, so its undo takes back exactly that.
#[derive(Clone, Debug, PartialEq)]
enum ChoiceMade {
    Names {
        before: cap_diarize::SpeakerNames,
        after: cap_diarize::SpeakerNames,
    },
    Voice {
        voice: cap_meetings::transcript::Voice,
        before: Option<bool>,
    },
}

impl VoiceChoice {
    /// The line that makes this choice on `transcript`, and what it changed;
    /// None when it changes nothing.
    fn apply(
        &self,
        transcript: &Transcript,
        attendee: Option<String>,
    ) -> Option<(LogLine, ChoiceMade)> {
        let (id, flag) = match self {
            VoiceChoice::LeaveOut(voice, out) => {
                let before = transcript.voice_choice(voice);
                return (before != Some(*out)).then(|| {
                    (
                        LogLine::leave_out(voice.clone(), Some(*out)),
                        ChoiceMade::Voice {
                            voice: voice.clone(),
                            before,
                        },
                    )
                });
            }
            VoiceChoice::LeaveOutId(id, flag) | VoiceChoice::NotMe(id, flag) => {
                (cap_diarize::SpeakerId(*id), *flag)
            }
        };
        let before = transcript
            .names()
            .cloned()
            .unwrap_or_else(|| cap_diarize::SpeakerNames::new(attendee));
        let mut after = before.clone();
        match self {
            VoiceChoice::LeaveOutId(..) => after.set_left_out(id, flag),
            VoiceChoice::NotMe(..) if flag => after.not_user(id),
            _ => after.claim_user(id),
        }
        (after != before).then(|| {
            (
                LogLine::SpeakerNames {
                    names: after.clone(),
                },
                ChoiceMade::Names { before, after },
            )
        })
    }
}

impl ChoiceMade {
    /// The line that takes this change back on `transcript` as it is now.
    fn undo(self, transcript: &Transcript) -> Option<LogLine> {
        match self {
            ChoiceMade::Voice { voice, before } => (transcript.voice_choice(&voice) != before)
                .then(|| LogLine::leave_out(voice, before)),
            ChoiceMade::Names { before, after } => {
                let now = transcript.names().cloned().unwrap_or_else(|| after.clone());
                let mut names = now.clone();
                names.revert(&before, &after);
                (names != now).then_some(LogLine::SpeakerNames { names })
            }
        }
    }
}

/// The undo of a speaker choice. Filled in where the choice met the latest
/// transcript (on the documents writer for a finished meeting), which is
/// always before its undo runs there.
#[derive(Clone, Debug, Default)]
pub struct ChoiceUndo(std::sync::Arc<std::sync::Mutex<Option<ChoiceMade>>>);

/// The same undo, not an equal one.
impl PartialEq for ChoiceUndo {
    fn eq(&self, other: &Self) -> bool {
        std::sync::Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ChoiceUndo {}

impl ChoiceUndo {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<ChoiceMade>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum MeetingEvent {
    SettingsChanged,
    PromptsChanged,
    RecordingStarted {
        doc_id: String,
    },
    RecordingStopped {
        doc_id: String,
        reason: StopReason,
    },
    ActiveChanged,
    TranscriptChanged {
        doc_id: String,
    },
    CalendarChanged,
    LibraryChanged,
    NotesProgress {
        doc_id: String,
        stage: NotesStage,
    },
    AskProgress {
        doc_id: String,
        answer: String,
    },
    /// A speaker took a new name in this meeting's transcript. `from` is the
    /// label the summary was written with ("Person 2"), `to` the new name.
    SpeakerRenamed {
        doc_id: String,
        from: String,
        to: String,
    },
    WantsAttention {
        reason: AttentionReason,
    },
    /// A recording Cap started by itself (a detected call, a scheduled
    /// meeting, a prompt's countdown) could not start, so nobody pressed
    /// anything that could say so.
    AutoStartFailed {
        error: MeetingError,
    },
}

#[derive(Clone, Debug, Default)]
struct Origin {
    app_id: Option<String>,
    app_name: Option<String>,
    event_id: Option<String>,
    resume_doc: Option<String>,
    automatic: bool,
}

struct Watch {
    _watcher: MicWatcher,
    _pump: Task<()>,
}

struct Recording {
    doc_id: String,
    started: Instant,
    timeline_offset_ms: u64,
    capture: Option<MeetingCapture>,
    engine: EngineHandle,
    engine_pump: Task<()>,
    _capture_pump: Task<()>,
    transcript: Transcript,
    /// Where this meeting's microphone has been heard repeating the call (a
    /// full sentence of it removed as echo), stretch by stretch between
    /// device changes: short echoes are judged there too.
    echo: echo_periods::EchoPeriods,
    /// The outputs the computer played through at the last look.
    output_watch: OutputWatch,
    mic_sender: Option<flume::Sender<MicrophoneSamples>>,
    /// The feed the sender is on, the meeting's own microphone, and the one
    /// the meeting moved to while its own was gone.
    mic_actor: Option<kameo::actor::ActorID>,
    mic_own: Option<String>,
    mic_moved: Option<String>,
    mic_watch: mic_watch::MicWatch,
    /// Whether the meeting may go back to its own microphone.
    mic_return: mic_watch::OwnReturn,
    restore_mic: Option<(Option<String>, Option<String>)>,
    awaiting_mode: bool,
    voices: LiveVoices,
    audio_dir: Option<PathBuf>,
    health: health::Hysteresis,
    watchdog: health::Watchdog,
    disk_checked: Instant,
    /// No idle sleep while the meeting records.
    _awake: crate::power::StayAwake,
    /// Filled-in silence per track at the last tick (ms), and until when the
    /// line says words may be missing after a jump in it.
    padded_ms: [u64; 2],
    missed_until: Option<Instant>,
    /// Audio missed per track this recording (the jumps above), kept on the
    /// note at Stop.
    missed_ms: [u64; 2],
    /// When either side last sounded like someone speaking, and when the
    /// transcript last took words (a caption or a line), for
    /// [`Meetings::listening_cue`].
    voice_at: Option<Instant>,
    line_at: Option<Instant>,
    _health_tick: Task<()>,
}

/// The meeting's microphone as `acquire_mic` found it.
struct AcquiredMic {
    input: Result<MicInput, HealthIssue>,
    sender: Option<flume::Sender<MicrophoneSamples>>,
    actor: Option<kameo::actor::ActorID>,
    own: Option<String>,
}

/// The voices the engine has told apart so far, and the one calendar
/// attendee whose name the call's voice may take.
#[derive(Clone, Debug, Default)]
struct LiveVoices {
    speakers: Vec<cap_diarize::SpeakerInfo>,
    attendee: Option<String>,
    /// Who the meeting app showed as speaking, when Cap may read it.
    active: Vec<cap_meetings::active::ActiveSample>,
    /// The user's own name as the meeting app shows it.
    app_self: Option<String>,
}

/// How often a meeting looks at which outputs the computer plays through.
const OUTPUT_CHECK_EVERY: Duration = Duration::from_secs(2);

#[derive(Default)]
struct OutputWatch {
    last: Option<String>,
    busy: bool,
    next_at: Option<Instant>,
}

struct Finishing {
    doc_id: String,
    engine: EngineHandle,
    _engine_pump: Task<()>,
    transcript: Transcript,
    echo: echo_periods::EchoPeriods,
    generate_notes: bool,
    voices: LiveVoices,
    /// Ledger gaps still open, from the engine's status, and how many of
    /// them have no saved audio to fill them from.
    open_gaps: u32,
    unrepairable: u32,
    /// Finishing a meeting from an earlier run, not one just stopped.
    repair: bool,
    /// The transcript's size before the repair, to tell if it grew.
    chars_before: usize,
}

pub struct Meetings {
    settings: MeetingSettings,
    persist_settings: bool,
    library: Option<Library>,
    origin: Instant,
    detector: Detector,
    planner: PromptPlanner,
    session: Session,
    prompts: Vec<Prompt>,
    watch: Option<Watch>,
    watch_error: Option<String>,
    latest_snapshot: Option<MicSnapshot>,
    probing: HashSet<String>,
    /// Reads who the meeting app shows as speaking while a call records.
    speaking_watch: Option<Task<()>>,
    /// Looks for the meeting's call app on the microphone just after a wake.
    wake_look: Option<Task<()>>,
    /// The next capture is the meeting resuming by itself after a sleep.
    resuming_after_sleep: bool,
    resumed_line: Option<Task<()>>,
    /// A note a sleep stopped before anything was heard, kept out of Trash
    /// as long as its Resume may still come.
    sleep_kept: Option<String>,
    calendar: calendar::CalendarState,
    calendar_active: bool,
    calendar_next: Option<Millis>,
    calendar_task: Option<Task<()>>,
    calendar_connect: accounts::ConnectState,
    calendar_connect_task: Option<Task<()>>,
    calendar_connect_cancel: Option<accounts::Cancel>,
    calendar_dirty: bool,
    calendar_watch: Option<(cap_meeting_platform::CalendarWatcher, Task<()>)>,
    #[cfg(test)]
    calendar_offline: bool,
    active: Option<ActiveMeeting>,
    recording: Option<Recording>,
    finishing: Vec<Finishing>,
    pending_start: Option<Origin>,
    session_doc: Option<String>,
    resume_doc: Option<String>,
    notes_doc: Option<String>,
    timer: Option<(Millis, Task<()>)>,
    notify_due: Option<Millis>,
    dirty_active: bool,
    dirty_transcripts: BTreeSet<String>,
    capabilities: Option<(String, Capabilities)>,
    capabilities_task: Option<Task<()>>,
    capabilities_error: Option<(String, cloud::CloudError)>,
    /// A fetch scheduled after a passing error while meetings wait on it.
    capabilities_retry: Option<Task<()>>,
    capabilities_backoff: Duration,
    notes: HashMap<String, NotesState>,
    auto_notes: HashMap<String, Task<Result<(), NotesError>>>,
    /// Summary renames a late speaker correction asked for while that
    /// summary was still being written, by document.
    late_summary_renames: HashMap<String, Vec<(String, String)>>,
    ai: access::AiState,
    quit_subscription: Option<Subscription>,
    ignored_devices: Option<Vec<String>>,
    recovery: Option<Task<()>>,
    opened_here: persist::OpenedHere,
    library_cleanup: Option<Task<()>>,
    /// Meetings whose saved audio still needs transcribing, finished one at
    /// a time while nothing records.
    repair_queue: VecDeque<String>,
    last_start_error: Option<MeetingError>,
    /// Why a start the prompt planner asked for failed, for the accept that
    /// asked (`start_internal` consumes `last_start_error` itself).
    prompt_start_error: Option<MeetingError>,
    /// An accept is starting the prompt's recording: its failure goes back
    /// to the accept, not to a system notification.
    accepting: bool,
    pending_restore_mic: Option<(Option<String>, Option<String>)>,
    #[cfg(debug_assertions)]
    pub(crate) dev_mic: Option<flume::Receiver<capture::RawBatch>>,
}

const CAPABILITIES_RETRY_FIRST: Duration = Duration::from_secs(30);
const CAPABILITIES_RETRY_MAX: Duration = Duration::from_secs(5 * 60);
const CLEANUP_FIRST: Duration = Duration::from_secs(120);
const CLEANUP_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, PartialEq)]
enum CleanupPlan {
    /// Recovery may still close or queue meetings for repair.
    Later,
    Run {
        audio_days: Option<u32>,
        /// Documents in use (recording, finishing, repairing, waiting for
        /// notes, open), which keep their audio and stay in the trash.
        busy: Vec<String>,
    },
}

struct MeetingsGlobal(Entity<Meetings>);

impl Global for MeetingsGlobal {}

impl EventEmitter<MeetingEvent> for Meetings {}

// What macOS says about recording the call's audio, read at most every
// 5 s. `health::system_audio_missing` decides what it means.
#[cfg(target_os = "macos")]
fn system_audio_grant() -> health::AudioGrant {
    use cap_meeting_platform::{AudioCapturePermission, audio_capture_permission};
    static CHECKED: std::sync::Mutex<Option<(Instant, health::AudioGrant)>> =
        std::sync::Mutex::new(None);
    let mut checked = CHECKED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    match *checked {
        Some((at, grant)) if at.elapsed() < Duration::from_secs(5) => grant,
        _ => {
            let grant = match audio_capture_permission() {
                AudioCapturePermission::Granted | AudioCapturePermission::NotNeeded => {
                    health::AudioGrant::Granted
                }
                AudioCapturePermission::Denied => health::AudioGrant::Denied,
                AudioCapturePermission::NotDetermined => health::AudioGrant::NotDetermined,
                AudioCapturePermission::Unknown => health::AudioGrant::Unknown,
            };
            *checked = Some((Instant::now(), grant));
            grant
        }
    }
}

/// Another app is playing sound right now (macOS: Core Audio's per-process
/// output state). Walking every audio process takes a millisecond or more,
/// and now and then far longer, so it never runs here on the UI thread: a
/// short-lived thread refreshes the answer at most every 5 s while the
/// watchdog asks, and the watchdog reads the last one. Elsewhere a capture
/// going quiet is normal, so never.
#[cfg(target_os = "macos")]
fn others_playing() -> bool {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    static PLAYING: AtomicBool = AtomicBool::new(false);
    static ASKING: AtomicBool = AtomicBool::new(false);
    // Milliseconds since the first ask, plus one; 0 is "never asked".
    static ASKED: AtomicU64 = AtomicU64::new(0);
    static ORIGIN: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let now = ORIGIN.get_or_init(Instant::now).elapsed().as_millis() as u64;
    let asked = ASKED.load(Ordering::Relaxed);
    let stale = asked == 0 || now.saturating_sub(asked - 1) >= 5_000;
    if stale && !ASKING.swap(true, Ordering::AcqRel) {
        ASKED.store(now + 1, Ordering::Relaxed);
        let spawned = std::thread::Builder::new()
            .name("cap-others-playing".into())
            .spawn(|| {
                let playing = cap_meeting_platform::others_playing().unwrap_or(false);
                PLAYING.store(playing, Ordering::Relaxed);
                ASKING.store(false, Ordering::Release);
            });
        if spawned.is_err() {
            ASKING.store(false, Ordering::Release);
        }
    }
    PLAYING.load(Ordering::Relaxed)
}

#[cfg(not(target_os = "macos"))]
fn others_playing() -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
fn system_audio_grant() -> health::AudioGrant {
    health::AudioGrant::Granted
}

/// Windows refuses to open a microphone with E_ACCESSDENIED while
/// microphone access is off in Privacy settings (an open stream ends as if
/// the device were unplugged).
fn mic_access_denied(error: &str) -> bool {
    error.contains("0x80070005")
}

/// Linux records the speakers through `parec`; without it there is nothing
/// to record them with.
fn linux_monitor_missing() -> bool {
    #[cfg(target_os = "linux")]
    {
        !capture::system_audio_available()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

fn platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOS
    } else if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// The one speech model Cap Notes needs on this computer for `language`.
pub fn notes_model(language: &Language) -> &'static str {
    notes_model_for(
        device::class(),
        crate::transcription::supports_parakeet(),
        &language_code(language),
    )
}

/// The rule behind `notes_model`: Parakeet where it runs and writes the
/// language, otherwise Whisper small, and on a slow computer Whisper base
/// in place of small (an Intel Mac always: small falls minutes behind
/// there).
pub fn notes_model_for(class: device::Class, parakeet: bool, language: &str) -> &'static str {
    let parakeet = parakeet && crate::transcription::parakeet_writes(language);
    match class {
        device::Class::IntelMac => SLOW_NOTES_MODEL,
        _ if parakeet => NOTES_MODEL,
        device::Class::FewCores => SLOW_NOTES_MODEL,
        device::Class::Capable => NOTES_FALLBACK_MODEL,
    }
}

fn language_code(language: &Language) -> String {
    match language {
        Language::Auto => "auto".into(),
        Language::Code(code) => code.clone(),
    }
}

fn local_mode(local: Option<&LocalModel>) -> EngineMode {
    match local {
        Some(local) => EngineMode::Local(local.clone()),
        None => EngineMode::Unavailable(
            "Download a transcription model in Settings to get a live transcript".into(),
        ),
    }
}

/// Which account (server, sign-in and plan) cached answers belong to. The
/// sign-in enters as a hash, never as itself.
fn auth_key() -> String {
    use std::hash::{Hash, Hasher};

    let auth = crate::store::auth_snapshot();
    let token = auth.token.as_deref().map(|token| {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        token.hash(&mut hasher);
        hasher.finish()
    });
    format!("{}|{:?}|{}", auth.server_url, token, auth.is_upgraded())
}

impl Meetings {
    pub fn init(cx: &mut App) {
        #[cfg(debug_assertions)]
        if std::env::var("CAP_GPUI_MEETINGS_SKIP_INIT").is_ok_and(|v| v == "1") {
            return;
        }
        let settings = persist::load_settings();
        // The meeting's tap looks for a running screen reader before it
        // starts; the first such look in a process is slow, so it is made
        // here, off the main thread.
        #[cfg(target_os = "macos")]
        if settings.enabled {
            cx.background_executor()
                .spawn(async { cap_meeting_platform::warm_screen_reader_lookup() })
                .detach();
        }
        let entity = cx.new(|cx| {
            let mut this = Self::new(settings);
            this.start_recovery(cx);
            this.start_library_cleanup(cx);
            cx.background_executor()
                .spawn(async {
                    let removed = cap_diarize::nemotron::clear_stale_spools(persist::process_alive);
                    if removed > 0 {
                        tracing::info!(removed, "deleted speech files a quit left behind");
                    }
                })
                .detach();
            this.resume_unwritten(cx);
            // Notes another account left unwritten wait for that account's
            // sign-in, not for the next launch.
            if let Some(sign_in) = crate::sign_in::SignIn::try_global(cx) {
                cx.subscribe(&sign_in, |this, _, event, cx| {
                    if *event == crate::sign_in::SignInEvent::AccountRefreshed {
                        this.resume_unwritten(cx);
                    }
                })
                .detach();
            }
            this.apply_lifecycle(cx);
            this
        });
        cx.set_global(MeetingsGlobal(entity));
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<MeetingsGlobal>().0.clone()
    }

    pub fn try_global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<MeetingsGlobal>().map(|g| g.0.clone())
    }

    fn new(settings: MeetingSettings) -> Self {
        let ignored_devices = if cfg!(debug_assertions) {
            std::env::var("CAP_GPUI_MEETING_IGNORED_DEVICES")
                .ok()
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
        } else {
            None
        };
        let mut this = Self {
            detector: Detector::new(platform(), DetectConfig::default()),
            planner: PromptPlanner::new(settings.prompt_config()),
            session: Session::new(settings.session_config()),
            settings,
            persist_settings: true,
            library: None,
            origin: Instant::now(),
            prompts: Vec::new(),
            watch: None,
            watch_error: None,
            latest_snapshot: None,
            probing: HashSet::new(),
            speaking_watch: None,
            wake_look: None,
            resuming_after_sleep: false,
            resumed_line: None,
            sleep_kept: None,
            calendar: calendar::CalendarState::default(),
            calendar_active: false,
            calendar_next: None,
            calendar_task: None,
            calendar_connect: accounts::ConnectState::Idle,
            calendar_connect_task: None,
            calendar_connect_cancel: None,
            calendar_dirty: false,
            calendar_watch: None,
            #[cfg(test)]
            calendar_offline: false,
            active: None,
            recording: None,
            finishing: Vec::new(),
            pending_start: None,
            session_doc: None,
            resume_doc: None,
            notes_doc: None,
            timer: None,
            notify_due: None,
            dirty_active: false,
            dirty_transcripts: BTreeSet::new(),
            capabilities: None,
            capabilities_task: None,
            capabilities_error: None,
            capabilities_retry: None,
            capabilities_backoff: CAPABILITIES_RETRY_FIRST,
            notes: HashMap::new(),
            auto_notes: HashMap::new(),
            late_summary_renames: HashMap::new(),
            ai: access::AiState::default(),
            quit_subscription: None,
            ignored_devices,
            recovery: None,
            opened_here: persist::OpenedHere::default(),
            library_cleanup: None,
            repair_queue: VecDeque::new(),
            last_start_error: None,
            prompt_start_error: None,
            accepting: false,
            pending_restore_mic: None,
            #[cfg(debug_assertions)]
            dev_mic: None,
        };
        this.detector.set_config(this.detect_config());
        this
    }

    fn now(&self) -> Millis {
        Millis(self.origin.elapsed().as_millis() as u64)
    }

    fn now_pair(&self) -> Now {
        Now::new(self.now(), Utc::now())
    }

    fn instant_at(&self, at: Millis) -> Instant {
        self.origin + Duration::from_millis(at.0)
    }

    /// A wall-clock time on the session's clock, as of now. That clock does
    /// not count time asleep on every platform, so after a sleep this is
    /// worked out again.
    fn millis_at(&self, at: DateTime<Utc>) -> Millis {
        let delta = (at - Utc::now()).num_milliseconds();
        if delta > 0 {
            self.now().plus(delta as u64)
        } else {
            Millis(self.now().0.saturating_sub(delta.unsigned_abs()))
        }
    }

    fn detect_config(&self) -> DetectConfig {
        let mut config = self.settings.detect_config();
        config.own_pids = vec![std::process::id()];
        if let Some(ignored) = &self.ignored_devices {
            config.ignored_device_substrings.clone_from(ignored);
        }
        config
    }

    pub fn settings(&self) -> &MeetingSettings {
        &self.settings
    }

    pub fn update_settings(
        &mut self,
        change: impl FnOnce(&mut MeetingSettings),
        cx: &mut Context<Self>,
    ) {
        let mut next = self.settings.clone();
        change(&mut next);
        next.validate();
        if next == self.settings {
            return;
        }
        self.settings = next;
        if self.persist_settings
            && let Err(error) = persist::save_settings(&self.settings)
        {
            tracing::warn!(%error, "could not save meeting settings");
        }
        self.apply_lifecycle(cx);
        cx.emit(MeetingEvent::SettingsChanged);
        cx.notify();
    }

    pub fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.update_settings(|s| s.enabled = enabled, cx);
    }

    pub fn library(&mut self) -> Option<&Library> {
        if self.library.is_none() {
            match Library::open(persist::documents_dir()) {
                Ok(library) => self.library = Some(library),
                Err(error) => tracing::warn!(%error, "could not open the meeting library"),
            }
        }
        self.library.as_ref()
    }

    pub fn prompts(&self) -> &[Prompt] {
        &self.prompts
    }

    pub fn active(&self) -> Option<&ActiveMeeting> {
        self.active.as_ref()
    }

    pub fn is_recording(&self) -> bool {
        self.recording.is_some()
    }

    pub fn active_calls(&self) -> &[cap_meetings::detect::ActiveCall] {
        self.detector.active_calls()
    }

    pub fn watcher_error(&self) -> Option<&str> {
        self.watch_error.as_deref()
    }

    pub fn capture_stats(&self) -> Option<CaptureStats> {
        self.recording
            .as_ref()
            .and_then(|r| r.capture.as_ref())
            .map(MeetingCapture::stats)
    }

    pub fn is_finishing(&self, doc_id: &str) -> bool {
        self.finishing.iter().any(|f| f.doc_id == doc_id)
            || self.recording.as_ref().is_some_and(|r| r.doc_id == doc_id)
    }

    pub fn notes_state(&self, doc_id: &str) -> Option<&NotesState> {
        self.notes.get(doc_id)
    }

    pub fn templates(&self) -> Vec<Template> {
        let user =
            templates::load_user_templates(&persist::meetings_dir().join(persist::TEMPLATES_FILE))
                .unwrap_or_default();
        templates::all_templates(&user)
    }

    #[cfg(test)]
    pub(crate) fn install_for_tests(
        settings: MeetingSettings,
        calendar_dir: std::path::PathBuf,
        cx: &mut App,
    ) -> Entity<Self> {
        let entity = cx.new(|_| {
            let mut this = Self::new(settings);
            this.persist_settings = false;
            this.calendar = calendar::CalendarState::in_dir(calendar_dir);
            this.calendar_offline = true;
            this
        });
        cx.set_global(MeetingsGlobal(entity.clone()));
        entity
    }

    #[cfg(test)]
    pub(crate) fn add_calendar_account_for_tests(
        &mut self,
        provider: accounts::Provider,
        email: &str,
    ) -> String {
        self.calendar.ensure_loaded();
        self.calendar
            .add_account(provider, email, "refresh-for-tests")
            .unwrap()
    }

    #[cfg(debug_assertions)]
    pub(crate) fn enable_in_memory(&mut self, cx: &mut Context<Self>) {
        self.persist_settings = false;
        self.update_settings(|s| s.enabled = true, cx);
    }

    fn apply_lifecycle(&mut self, cx: &mut Context<Self>) {
        let now = self.now_pair();
        self.detector.set_config(self.detect_config());
        self.session.set_config(self.settings.session_config());
        let actions = self.planner.set_config(now, self.settings.prompt_config());
        self.apply_prompt_actions(actions, cx);

        let enabled = self.settings.enabled;
        let want_watch = self.recording.is_some()
            || (enabled
                && (self.settings.notifications.detected
                    || self.settings.automation.auto_record.for_detected()));
        if want_watch && self.watch.is_none() {
            self.start_watch(cx);
        } else if !want_watch && self.watch.is_some() {
            self.watch = None;
            self.latest_snapshot = None;
            let events = self.detector.on_mic_clients(self.now(), &[]);
            self.handle_detect_events(events, cx);
        }

        let want_quit = enabled || self.recording.is_some() || !self.finishing.is_empty();
        if want_quit && self.quit_subscription.is_none() {
            self.quit_subscription = Some(cx.on_app_quit(|this, cx| {
                this.on_quit(cx);
                async {}
            }));
        } else if !want_quit {
            self.quit_subscription = None;
        }

        if enabled && !self.calendar_active {
            speakers::ensure_model(&gpui_tokio::Tokio::handle(cx));
            crate::transcription::split_installed_in_background();
            self.calendar_active = true;
            self.calendar.ensure_loaded();
            self.push_calendar_to_planner(cx);
            self.refresh_calendar(cx);
            self.sync_calendar_watch(cx);
        } else if !enabled && self.calendar_active {
            self.calendar_active = false;
            self.calendar_next = None;
            self.calendar_task = None;
            self.calendar_watch = None;
            let actions = self.planner.set_events(self.now_pair(), Vec::new());
            self.apply_prompt_actions(actions, cx);
        }
        self.rearm(cx);
    }

    fn start_watch(&mut self, cx: &mut Context<Self>) {
        let (tx, rx) = flume::unbounded::<MicSnapshot>();
        match MicWatcher::spawn(tx) {
            Ok(watcher) => {
                self.watch_error = None;
                let pump = cx.spawn(async move |this, cx| {
                    while let Ok(mut snapshot) = rx.recv_async().await {
                        while let Ok(newer) = rx.try_recv() {
                            snapshot = newer;
                        }
                        if this
                            .update(cx, |this, cx| this.on_mic_snapshot(snapshot, cx))
                            .is_err()
                        {
                            return;
                        }
                    }
                });
                self.watch = Some(Watch {
                    _watcher: watcher,
                    _pump: pump,
                });
            }
            Err(error) => {
                tracing::warn!(%error, "meeting detection is unavailable");
                self.watch_error = Some(error.to_string());
            }
        }
    }

    fn on_mic_snapshot(&mut self, snapshot: MicSnapshot, cx: &mut Context<Self>) {
        if !snapshot.attributed {
            self.latest_snapshot = Some(snapshot);
            return;
        }
        let clients: Vec<MicClient> = snapshot
            .clients
            .iter()
            .map(|c| MicClient {
                platform_id: c.id.clone(),
                pid: c.pid,
                device_uid: c.device_uid.clone(),
                device_uids: c.device_uids.clone(),
            })
            .collect();
        self.latest_snapshot = Some(snapshot);
        let events = self.detector.on_mic_clients(self.now(), &clients);
        self.handle_detect_events(events, cx);
        self.rearm(cx);
    }

    fn handle_detect_events(&mut self, events: Vec<DetectEvent>, cx: &mut Context<Self>) {
        for event in events {
            if let DetectEvent::NeedBrowserEvidence { app_id } = &event {
                self.probe_browser(app_id.clone(), cx);
                continue;
            }
            let prompt_actions = self.planner.on_detect(self.now_pair(), &event);
            self.apply_prompt_actions(prompt_actions, cx);
            let session_actions = self.session.on_detect(self.now(), &event);
            self.apply_session_actions(session_actions, cx);
        }
    }

    /// The meeting apps on the microphone right now: their processes, and
    /// whether each is a browser (only its call tab is read).
    fn meeting_app_pids(&self) -> Vec<(u32, bool)> {
        self.latest_snapshot
            .as_ref()
            .map(|s| {
                s.clients
                    .iter()
                    .filter_map(|c| {
                        let app = apps::classify(platform(), &c.id)?;
                        match app.kind {
                            apps::AppKind::Meeting => Some((c.pid, false)),
                            apps::AppKind::Browser => Some((c.pid, true)),
                            _ => None,
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// While this recording runs, and only if Cap may already read other
    /// apps' windows (Accessibility, never asked for here), look twice a
    /// second at which participant the meeting app shows as speaking. Each
    /// look is a bounded walk off the main thread; no meeting app on the
    /// microphone means no walk at all.
    fn watch_speaking(&mut self, doc_id: String, cx: &mut Context<Self>) {
        self.speaking_watch = None;
        if !cap_meeting_platform::READS_MEETING_APPS
            || !self.settings.transcription.name_speakers_from_apps
            || !cap_meeting_platform::accessibility_trusted()
        {
            return;
        }
        const CALL_PAGES: &[&str] = &[
            "meet.google.com",
            "teams.microsoft.com",
            "teams.live.com",
            "app.zoom.us",
            "zoom.us/wc",
        ];
        self.speaking_watch = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(500))
                    .await;
                let Ok(Some((pids, at_ms))) = this.update(cx, |this, _| {
                    let r = this.recording.as_ref().filter(|r| r.doc_id == doc_id)?;
                    let at = r.timeline_offset_ms + r.started.elapsed().as_millis() as u64;
                    Some((this.meeting_app_pids(), at))
                }) else {
                    break;
                };
                if pids.is_empty() {
                    continue;
                }
                let labels = cx
                    .background_executor()
                    .spawn(async move {
                        let mut labels = Vec::new();
                        for (pid, browser) in pids {
                            labels.extend(
                                cap_meeting_platform::speaker_labels(pid, browser, CALL_PAGES)
                                    .labels,
                            );
                        }
                        labels
                    })
                    .await;
                let (speaking, me) = cap_meetings::active::read_labels(&labels);
                let alive = this.update(cx, |this, _| {
                    let Some(r) = this.recording.as_mut().filter(|r| r.doc_id == doc_id) else {
                        return false;
                    };
                    if me.is_some() {
                        r.voices.app_self = me;
                    }
                    r.voices
                        .active
                        .push(cap_meetings::active::ActiveSample { at_ms, speaking });
                    true
                });
                if !matches!(alive, Ok(true)) {
                    break;
                }
            }
        }));
    }

    fn probe_browser(&mut self, app_id: String, cx: &mut Context<Self>) {
        if !self.probing.insert(app_id.clone()) {
            return;
        }
        let pids: Vec<u32> = self
            .latest_snapshot
            .as_ref()
            .map(|s| {
                s.clients
                    .iter()
                    .filter(|c| {
                        apps::classify(platform(), &c.id).is_some_and(|app| app.id == app_id)
                    })
                    .map(|c| c.pid)
                    .collect()
            })
            .unwrap_or_default();
        cx.spawn(async move |this, cx| {
            let verdict = cx
                .background_executor()
                .spawn(async move {
                    let mut evidence = BrowserEvidence {
                        complete: !pids.is_empty(),
                        ..BrowserEvidence::default()
                    };
                    for pid in pids {
                        let probe = cap_meeting_platform::probe_browser(pid);
                        evidence.urls.extend(probe.urls);
                        evidence.titles.extend(probe.titles);
                        evidence.complete &= probe.complete && probe.trusted;
                    }
                    judge_browser(&evidence)
                })
                .await;
            this.update(cx, |this, cx| {
                this.probing.remove(&app_id);
                let events = this
                    .detector
                    .on_browser_verdict(this.now(), &app_id, verdict);
                this.handle_detect_events(events, cx);
                this.rearm(cx);
            })
            .ok();
        })
        .detach();
    }

    fn apply_prompt_actions(&mut self, actions: Vec<PromptAction>, cx: &mut Context<Self>) {
        let mut changed = false;
        for action in actions {
            match action {
                PromptAction::Show(prompt) => {
                    self.prompts.retain(|p| p.id != prompt.id);
                    self.prompts.insert(0, prompt);
                    changed = true;
                }
                PromptAction::Update(prompt) => {
                    if let Some(slot) = self.prompts.iter_mut().find(|p| p.id == prompt.id) {
                        *slot = prompt;
                        changed = true;
                    }
                }
                PromptAction::Dismiss { id, .. } => {
                    let before = self.prompts.len();
                    self.prompts.retain(|p| p.id != id);
                    changed |= before != self.prompts.len();
                }
                PromptAction::StartRecording { source } => {
                    let origin = self.origin_for(&source);
                    if let Err(error) = self.start_internal(origin, cx) {
                        tracing::warn!(%error, "could not start the meeting recording");
                        if !self.accepting {
                            cx.emit(MeetingEvent::AutoStartFailed {
                                error: error.clone(),
                            });
                        }
                        self.prompt_start_error = Some(error);
                        let actions = self
                            .planner
                            .set_recording(self.now_pair(), RecordingState::Idle);
                        self.apply_prompt_actions(actions, cx);
                    }
                }
            }
        }
        if changed {
            cx.emit(MeetingEvent::PromptsChanged);
            cx.notify();
        }
    }

    fn origin_for(&self, source: &RecordSource) -> Origin {
        match source {
            RecordSource::DetectedCall { app_id, event_id } => Origin {
                app_name: apps::app_by_id(app_id)
                    .map(|a| a.name.to_string())
                    .or_else(|| {
                        self.detector
                            .active_calls()
                            .iter()
                            .find(|c| &c.app_id == app_id)
                            .map(|c| c.app_name.clone())
                    }),
                app_id: Some(app_id.clone()),
                event_id: event_id.clone(),
                resume_doc: None,
                automatic: true,
            },
            RecordSource::Scheduled { event_id } => {
                let call = self.detector.active_calls().last();
                Origin {
                    app_id: call.map(|c| c.app_id.clone()),
                    app_name: call.map(|c| c.app_name.clone()),
                    event_id: Some(event_id.clone()),
                    resume_doc: None,
                    automatic: true,
                }
            }
        }
    }

    /// Accepts a prompt. `Err` when the meeting it started could not start,
    /// so the person can be told; an earlier failure (an automatic start)
    /// never counts for this accept.
    pub fn accept_prompt(&mut self, id: u64, cx: &mut Context<Self>) -> Result<(), MeetingError> {
        self.prompt_start_error = None;
        let actions = self.planner.accept(self.now_pair(), id);
        self.accepting = true;
        self.apply_prompt_actions(actions, cx);
        self.accepting = false;
        self.rearm(cx);
        match self.prompt_start_error.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn dismiss_prompt(&mut self, id: u64, cx: &mut Context<Self>) {
        let actions = self.planner.dismiss(self.now_pair(), id);
        self.apply_prompt_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn cancel_prompt(&mut self, id: u64, cx: &mut Context<Self>) {
        let actions = self.planner.cancel(self.now_pair(), id);
        self.apply_prompt_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn hover_prompt(&mut self, id: u64, hovered: bool, cx: &mut Context<Self>) {
        let actions = self.planner.hover(self.now_pair(), id, hovered);
        self.apply_prompt_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn mute_app(&mut self, app_id: &str, cx: &mut Context<Self>) {
        let app_id = app_id.to_string();
        self.update_settings(
            move |s| {
                if !s.notifications.muted_app_ids.contains(&app_id) {
                    s.notifications.muted_app_ids.push(app_id);
                }
            },
            cx,
        );
    }

    pub fn start_recording(
        &mut self,
        source: StartSource,
        cx: &mut Context<Self>,
    ) -> Result<String, MeetingError> {
        let result = match source {
            StartSource::Prompt(id) => {
                if !self.prompts.iter().any(|p| p.id == id) {
                    return Err(MeetingError::PromptGone);
                }
                let before = self.recording.as_ref().map(|r| r.doc_id.clone());
                if self.recording.is_some() {
                    self.stop_recording(StopReason::Replaced, cx);
                }
                let actions = self.planner.accept(self.now_pair(), id);
                self.apply_prompt_actions(actions, cx);
                match self.recording.as_ref().map(|r| r.doc_id.clone()) {
                    Some(doc) if Some(&doc) != before.as_ref() => Ok(doc),
                    _ => Err(MeetingError::PromptGone),
                }
            }
            StartSource::Manual => {
                let call = self.detector.active_calls().last();
                let origin = Origin {
                    app_id: call.map(|c| c.app_id.clone()),
                    app_name: call.map(|c| c.app_name.clone()),
                    ..Origin::default()
                };
                self.start_internal(origin, cx)
            }
            StartSource::Event(event_id) => {
                let call = self.detector.active_calls().last();
                let origin = Origin {
                    app_id: call.map(|c| c.app_id.clone()),
                    app_name: call.map(|c| c.app_name.clone()),
                    event_id: Some(event_id),
                    ..Origin::default()
                };
                self.start_internal(origin, cx)
            }
            StartSource::Resume(doc_id) => {
                let origin = Origin {
                    resume_doc: Some(doc_id),
                    ..Origin::default()
                };
                self.start_internal(origin, cx)
            }
            StartSource::Into { doc_id, event_id } => {
                let call = self.detector.active_calls().last();
                let origin = Origin {
                    app_id: call.map(|c| c.app_id.clone()),
                    app_name: call.map(|c| c.app_name.clone()),
                    event_id,
                    resume_doc: Some(doc_id),
                    ..Origin::default()
                };
                self.start_internal(origin, cx)
            }
        };
        self.rearm(cx);
        result
    }

    fn start_internal(
        &mut self,
        origin: Origin,
        cx: &mut Context<Self>,
    ) -> Result<String, MeetingError> {
        if self.recording.is_some() {
            self.stop_recording(StopReason::Replaced, cx);
        }
        if self.session.state() == SessionState::Stopping {
            let chars = self.finishing_chars(self.session_doc.as_deref());
            self.session_doc = None;
            let actions = self.session.on_capture_stopped(self.now(), chars);
            self.apply_session_actions(actions, cx);
        }
        if self.session.state() != SessionState::Idle {
            return Err(MeetingError::NoAudioSource(STILL_STARTING.into()));
        }
        if let Some(active) = &self.active
            && active.state == ActiveState::ResumeOffered
        {
            let actions = self.session.decline_resume(self.now());
            self.active = None;
            self.apply_session_actions(actions, cx);
        }
        let mut origin = origin;
        let linked = match &origin.resume_doc {
            Some(doc_id) => self
                .library()
                .and_then(|library| library.load(doc_id).ok())
                .and_then(|meta| meta.meeting)
                .and_then(|meeting| meeting.event)
                .map(|event| event.id),
            None => None,
        };
        if linked.is_some() {
            // A note that already belongs to a meeting keeps it.
            origin.event_id = linked;
        } else if origin.event_id.is_none() {
            let agenda = self.agenda();
            origin.event_id =
                calendar::auto_link(agenda.events(), Utc::now()).map(calendar::event_key);
        }
        let event_end = origin
            .event_id
            .as_ref()
            .and_then(|id| self.calendar.find(id))
            .map(|e| e.end);
        self.pending_start = Some(origin.clone());
        let actions = self.session.start(self.now(), origin.app_id.clone());
        if let Some(end) = event_end {
            self.session.set_linked_event_end(Some(self.millis_at(end)));
        }
        self.apply_session_actions(actions, cx);
        self.pending_start = None;
        match &self.recording {
            Some(recording) => Ok(recording.doc_id.clone()),
            None => Err(self
                .last_start_error
                .take()
                .unwrap_or(MeetingError::NoAudioSource("capture did not start".into()))),
        }
    }

    pub fn stop_recording(&mut self, reason: StopReason, cx: &mut Context<Self>) {
        let actions = self.session.stop(self.now(), reason);
        self.apply_session_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn keep_recording(&mut self, cx: &mut Context<Self>) {
        let actions = self.session.keep_recording(self.now());
        self.apply_session_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn resume(&mut self, cx: &mut Context<Self>) {
        let actions = self.session.resume(self.now());
        self.apply_session_actions(actions, cx);
        self.rearm(cx);
    }

    pub fn decline_resume(&mut self, cx: &mut Context<Self>) {
        let actions = self.session.decline_resume(self.now());
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.state == ActiveState::ResumeOffered)
        {
            self.active = None;
            self.mark_active(cx);
        }
        self.apply_session_actions(actions, cx);
        self.settle_sleep_kept(cx);
        self.rearm(cx);
    }

    fn apply_session_actions(&mut self, actions: Vec<SessionAction>, cx: &mut Context<Self>) {
        for action in actions {
            match action {
                SessionAction::StartCapture { resume } => self.begin_capture(resume, cx),
                SessionAction::StopCapture { reason } => self.end_capture(reason, cx),
                SessionAction::ShowEndingCountdown { stop_at } => {
                    let stop_at = self.instant_at(stop_at);
                    let reason = match self.session.warning() {
                        Some(Warning::Ending { reason, .. }) => reason,
                        _ => StopReason::CallEnded,
                    };
                    if let Some(active) = self.active.as_mut() {
                        active.warning = Some(MeetingWarning::Ending { stop_at, reason });
                    }
                    self.mark_active(cx);
                    cx.emit(MeetingEvent::WantsAttention {
                        reason: AttentionReason::EndingCountdown,
                    });
                }
                SessionAction::ShowInactivityWarning { stop_at } => {
                    let stop_at = self.instant_at(stop_at);
                    if let Some(active) = self.active.as_mut() {
                        active.warning = Some(MeetingWarning::Inactivity { stop_at });
                    }
                    self.mark_active(cx);
                    cx.emit(MeetingEvent::WantsAttention {
                        reason: AttentionReason::InactivityWarning,
                    });
                }
                SessionAction::ClearWarning => {
                    if let Some(active) = self.active.as_mut() {
                        active.warning = None;
                    }
                    self.mark_active(cx);
                }
                SessionAction::OfferResume { until } => {
                    let until = self.instant_at(until);
                    let slept = self.session.last_stop_reason() == Some(StopReason::Sleep);
                    if let Some(active) = self.active.as_mut() {
                        active.state = ActiveState::ResumeOffered;
                        active.resume_offer_until = Some(until);
                        active.slept = slept;
                    }
                    self.mark_active(cx);
                    cx.emit(MeetingEvent::WantsAttention {
                        reason: AttentionReason::ResumeOffered,
                    });
                }
                SessionAction::GenerateNotes => {
                    if let Some(doc_id) = self.notes_doc.clone() {
                        self.request_auto_notes(doc_id, cx);
                    }
                }
                SessionAction::JoinedCall { app_id } => self.set_meeting_app(Some(app_id), cx),
                SessionAction::LeftCall => self.set_meeting_app(None, cx),
            }
        }
    }

    /// The call the meeting being recorded belongs to changed (joined after
    /// Start notes, or left again): its note shows that app, and an automatic
    /// title follows it ("Zoom at 9:30 AM").
    fn set_meeting_app(&mut self, app_id: Option<String>, cx: &mut Context<Self>) {
        let app_name = app_id.as_ref().and_then(|id| {
            apps::app_by_id(id).map(|a| a.name.to_string()).or_else(|| {
                self.detector
                    .active_calls()
                    .iter()
                    .find(|c| &c.app_id == id)
                    .map(|c| c.app_name.clone())
            })
        });
        let Some(doc_id) = self.recording.as_ref().map(|r| r.doc_id.clone()) else {
            return;
        };
        tracing::info!(doc_id, app = ?app_name, "the meeting's call changed");
        let Some(library) = self.library().cloned() else {
            return;
        };
        let Some(meta) = save_meeting_app(&library, &doc_id, app_id, app_name.clone()) else {
            return;
        };
        if let Some(active) = self.active.as_mut().filter(|a| a.doc_id == doc_id) {
            active.app_name = app_name;
            active.title = meta.title.clone();
        }
        self.mark_active(cx);
        cx.emit(MeetingEvent::LibraryChanged);
    }

    /// The notes model first; then, so nobody is left without a transcript
    /// while it downloads, any other model already on this computer.
    fn resolve_local_model(&self, language: &str) -> Option<LocalModel> {
        let requested = self.settings.transcription.local_model.trim().to_string();
        let mut candidates: Vec<String> =
            vec![notes_model(&self.settings.transcription.language).to_string()];
        if requested != cap_meetings::settings::DEFAULT_LOCAL_MODEL {
            candidates.push(requested);
        } else {
            if let Some(saved) =
                crate::store::store_section(crate::transcription::GPUI_STORE_SECTION)
                    .get(crate::transcription::SELECTED_MODEL_KEY)
                    .and_then(serde_json::Value::as_str)
            {
                candidates.push(saved.to_string());
            }
            candidates.extend(LOCAL_MODELS.iter().map(|m| m.to_string()));
        }
        candidates
            .into_iter()
            .filter(|m| {
                crate::transcription::supports_parakeet()
                    || !crate::transcription::is_parakeet_model(m)
            })
            .find(|m| crate::transcription::live_model_ready(m, language).is_ok())
            .map(|model| LocalModel {
                model,
                language: language.to_string(),
            })
    }

    fn engine_plan(&mut self, cx: &mut Context<Self>) -> (EngineMode, Option<LocalModel>, bool) {
        let language = language_code(&self.settings.transcription.language);
        let local = self.resolve_local_model(&language);
        let local_mode = local_mode(local.as_ref());
        if self.settings.transcription.engine == Engine::Local {
            return (local_mode, None, false);
        }
        if cfg!(debug_assertions)
            && local.is_some()
            && std::env::var_os("CAP_GPUI_MEETING_CLOUD_STUB").is_some()
        {
            // CAP_GPUI_MEETING_NO_FALLBACK: a cloud meeting with no local
            // words to stand in (CAP_GPUI_MEETING_STUB_MODEL answers clips).
            let fallback = local.filter(|_| std::env::var_os("CAP_GPUI_MEETING_NO_FALLBACK").is_none());
            return (EngineMode::Cloud { language }, fallback, false);
        }
        let auth = crate::store::auth_snapshot();
        if !auth.signed_in() || !auth.is_upgraded() {
            return (local_mode, None, false);
        }
        let key = auth_key();
        match &self.capabilities {
            Some((cached, caps)) if *cached == key => {
                if caps.transcription {
                    (EngineMode::Cloud { language }, local, false)
                } else {
                    (local_mode, None, false)
                }
            }
            _ => {
                self.fetch_capabilities(cx);
                (EngineMode::Pending, local, true)
            }
        }
    }

    pub fn capabilities(&self) -> Option<&Capabilities> {
        let key = auth_key();
        self.capabilities
            .as_ref()
            .filter(|(cached, _)| *cached == key)
            .map(|(_, caps)| caps)
    }

    pub fn capabilities_pending(&self) -> bool {
        self.capabilities_task.is_some()
    }

    pub fn capabilities_error(&self) -> Option<&cloud::CloudError> {
        let key = auth_key();
        self.capabilities_error
            .as_ref()
            .filter(|(cached, _)| *cached == key)
            .map(|(_, error)| error)
    }

    pub fn refresh_capabilities(&mut self, cx: &mut Context<Self>) {
        self.capabilities = None;
        self.fetch_capabilities(cx);
    }

    fn fetch_capabilities(&mut self, cx: &mut Context<Self>) {
        if self.capabilities_task.is_some() {
            return;
        }
        let key = auth_key();
        self.capabilities_retry = None;
        self.capabilities_task = Some(cx.spawn(async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(cx, cloud::capabilities()).await;
            this.update(cx, |this, cx| {
                this.capabilities_task = None;
                let mut retry_after = None;
                let caps = match result {
                    Ok(Ok(caps)) => Some(caps),
                    Ok(Err(error)) => {
                        tracing::info!(?error, "meeting capabilities unavailable");
                        if !error.is_final() {
                            retry_after = Some(match &error {
                                cloud::CloudError::RateLimited { retry_after_secs } => {
                                    Duration::from_secs(*retry_after_secs)
                                }
                                _ => Duration::ZERO,
                            });
                        }
                        this.capabilities_error = Some((key.clone(), error));
                        None
                    }
                    Err(_) => {
                        retry_after = Some(Duration::ZERO);
                        None
                    }
                };
                if let Some(caps) = &caps {
                    this.capabilities_error = None;
                    this.capabilities = Some((key, caps.clone()));
                }
                this.resolve_pending_engine(caps.as_ref(), cx);
                match retry_after {
                    // Meetings waiting on a free account's trial are asked again
                    // later; deciding them now would skip their notes.
                    Some(at_least) if this.ai.has_waiting() => {
                        this.retry_capabilities(at_least, cx)
                    }
                    _ => {
                        if retry_after.is_none() {
                            this.capabilities_backoff = CAPABILITIES_RETRY_FIRST;
                        }
                        this.capabilities_settled(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        }));
    }

    fn retry_capabilities(&mut self, at_least: Duration, cx: &mut Context<Self>) {
        let wait = self.capabilities_backoff.max(at_least);
        self.capabilities_backoff = (self.capabilities_backoff * 2).min(CAPABILITIES_RETRY_MAX);
        self.capabilities_retry = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(wait).await;
            this.update(cx, |this, cx| {
                this.capabilities_retry = None;
                this.fetch_capabilities(cx);
            })
            .ok();
        }));
    }

    fn resolve_pending_engine(&mut self, caps: Option<&Capabilities>, cx: &mut Context<Self>) {
        let language = language_code(&self.settings.transcription.language);
        let local = self.resolve_local_model(&language);
        let Some(recording) = self.recording.as_mut().filter(|r| r.awaiting_mode) else {
            return;
        };
        recording.awaiting_mode = false;
        let mode = if caps.is_some_and(|c| c.transcription) {
            EngineMode::Cloud { language }
        } else {
            match local {
                Some(local) => EngineMode::Local(local),
                None => EngineMode::Unavailable(
                    "Cloud transcription is unavailable and no local model is downloaded".into(),
                ),
            }
        };
        let _ = recording.engine.send(EngineCommand::SetMode(mode));
        self.mark_active(cx);
    }

    fn acquire_mic(&mut self, doc_id: &str, cx: &mut Context<Self>) -> AcquiredMic {
        let access = crate::media_access::MediaAccess::global(cx)
            .read(cx)
            .status(crate::permissions::OSPermission::Microphone);
        if access == crate::permissions::OSPermissionStatus::Denied {
            return AcquiredMic {
                input: Err(HealthIssue::MissingPermission),
                sender: None,
                actor: None,
                own: None,
            };
        }
        let (tx, rx) = flume::bounded::<MicrophoneSamples>(256);
        let current = crate::feeds::Feeds::global(cx).read(cx).microphone.clone();
        let named = match &self.settings.recording.microphone {
            Microphone::Named(name) => Some(name.clone()),
            Microphone::Auto => current,
        };
        let actor = match named.clone() {
            Some(name) => self.attach_mic(name, tx.clone(), cx),
            None => {
                let doc_id = doc_id.to_string();
                let sender = tx.clone();
                cx.spawn(async move |this, cx| {
                    let name = cx
                        .background_executor()
                        .spawn(async { MicrophoneFeed::default_device().map(|(name, _, _)| name) })
                        .await;
                    this.update(cx, |this, cx| {
                        if this.recording.as_ref().is_none_or(|r| r.doc_id != doc_id) {
                            return;
                        }
                        match name {
                            Some(name) => {
                                let actor = this.attach_mic(name.clone(), sender, cx);
                                if let Some(recording) = this.recording.as_mut() {
                                    recording.mic_actor = actor;
                                    recording.mic_own.get_or_insert(name);
                                }
                            }
                            None => {
                                if let Some(active) = this.active.as_mut() {
                                    active.mic.health =
                                        SourceHealth::Error(HealthIssue::NoInputDevice);
                                }
                                this.mark_active(cx);
                            }
                        }
                    })
                    .ok();
                })
                .detach();
                None
            }
        };
        AcquiredMic {
            input: Ok(MicInput::Feed(rx)),
            sender: Some(tx),
            actor,
            own: named,
        }
    }

    /// Hands the meeting's sender to the microphone feed, on `name` unless a
    /// screen recording holds the feed. The feed it went to, if any.
    fn attach_mic(
        &mut self,
        name: String,
        sender: flume::Sender<MicrophoneSamples>,
        cx: &mut Context<Self>,
    ) -> Option<kameo::actor::ActorID> {
        self.point_feed_at(&name, cx);
        let Some(actor) = crate::feeds::Feeds::global(cx).read(cx).mic_actor() else {
            if let Some(active) = self.active.as_mut() {
                active.mic.health = SourceHealth::Error(HealthIssue::Failed(
                    "The microphone could not be opened".into(),
                ));
            }
            return None;
        };
        let id = actor.id();
        gpui_tokio::Tokio::spawn(cx, async move {
            if let Err(error) = actor.ask(AddSender(sender)).await {
                tracing::warn!(%error, "could not attach the meeting microphone tap");
            }
        })
        .detach();
        Some(id)
    }

    /// Puts the app's microphone feed on `name` for the meeting, unless a
    /// screen recording holds it. Stop gives the feed back to whatever it was
    /// on before the meeting first moved it.
    fn point_feed_at(&mut self, name: &str, cx: &mut Context<Self>) {
        let feeds = crate::feeds::Feeds::global(cx);
        let current = feeds.read(cx).microphone.clone();
        let screen_idle = crate::session::RecordingSession::global(cx).read(cx).phase
            == crate::session::Phase::Idle;
        if current.as_deref() != Some(name) && (screen_idle || current.is_none()) {
            feeds.update(cx, |feeds, cx| {
                feeds.set_microphone(Some(name.to_string()), cx)
            });
            let slot = match self.recording.as_mut() {
                Some(recording) => &mut recording.restore_mic,
                None => &mut self.pending_restore_mic,
            };
            let previous = slot.take().map_or(current, |(previous, _)| previous);
            *slot = Some((previous, Some(name.to_string())));
        }
    }

    /// Once a second: when the meeting's microphone has stopped delivering
    /// (unplugged, a device reset) or the meeting is away from its own one,
    /// looks at the computer's inputs off the main thread and moves.
    fn watch_mic(&mut self, cx: &mut Context<Self>) {
        let stalled = self.active.as_ref().is_some_and(|active| {
            matches!(
                active.mic.health,
                SourceHealth::Error(
                    HealthIssue::NoCallbacks
                        | HealthIssue::NoInputDevice
                        | HealthIssue::MissingPermission
                )
            )
        });
        let current = crate::feeds::Feeds::global(cx).read(cx).microphone.clone();
        let Some(recording) = self.recording.as_mut() else {
            return;
        };
        if recording.mic_sender.is_none() {
            return;
        }
        if recording.mic_moved.is_some() && recording.mic_moved != current {
            // Someone else put the feed elsewhere since: theirs to keep.
            recording.mic_moved = None;
        }
        let away = recording.mic_moved.is_some();
        let Some(tries) = recording.mic_watch.due(Instant::now(), stalled, away) else {
            return;
        };
        let doc_id = recording.doc_id.clone();
        // The first try on the meeting's own microphone reopens it at once,
        // with no look at the device list: after a sample rate change or a
        // device reset it is still there, and the audio system can be slow to
        // list devices while one reconfigures. Opening it again takes its
        // new rate; the timeline carries on from its timestamps.
        if tries == 1
            && let Some(own) = recording.mic_own.clone()
            && current.as_deref() == Some(own.as_str())
        {
            self.move_mic(&doc_id, Some(tries), std::slice::from_ref(&own), None, cx);
            if let Some(recording) = self.recording.as_mut() {
                recording.mic_watch.done();
            }
            return;
        }
        let candidates: Vec<String> = [recording.mic_own.clone(), current]
            .into_iter()
            .flatten()
            .collect();
        // Its own thread: the audio system can take seconds to answer while
        // a device changes, and the shared pool is busy transcribing.
        let (found_tx, found_rx) = flume::bounded(1);
        let looked = std::thread::Builder::new()
            .name("cap-meeting-mic-watch".into())
            .spawn(move || {
                let asked = Instant::now();
                if tries > 0 {
                    tracing::info!(tries, "looking at the microphones for a meeting");
                }
                let mut listed = MicrophoneFeed::list_names();
                let listed_ms = asked.elapsed().as_millis() as u64;
                for name in candidates {
                    if !listed.contains(&name) && MicrophoneFeed::is_connected(&name) {
                        listed.push(name);
                    }
                }
                // The default's name only: probing its formats can take the
                // audio system a long time while a device changes.
                let default = {
                    use cpal::traits::{DeviceTrait, HostTrait};
                    cpal::default_host()
                        .default_input_device()
                        .and_then(|device| device.name().ok())
                };
                let ms = asked.elapsed().as_millis() as u64;
                if tries > 0 {
                    tracing::info!(
                        ms,
                        listed_ms,
                        tries,
                        inputs = listed.len(),
                        ?default,
                        "looked at the microphones for a meeting"
                    );
                } else {
                    tracing::debug!(
                        ms,
                        inputs = listed.len(),
                        "looked for the meeting's own microphone"
                    );
                }
                let _ = found_tx.send((listed, default));
            });
        if looked.is_err() {
            recording.mic_watch.done();
            return;
        }
        cx.spawn(async move |this, cx| {
            let found = found_rx.recv_async().await.ok();
            this.update(cx, |this, cx| {
                if let Some((listed, default)) = found {
                    this.move_mic(&doc_id, (tries > 0).then_some(tries), &listed, default, cx);
                }
                if let Some(recording) = this.recording.as_mut().filter(|r| r.doc_id == doc_id) {
                    recording.mic_watch.done();
                }
            })
            .ok();
        })
        .detach();
    }

    /// Every couple of seconds: which outputs the computer plays through
    /// (what the capture already tracks; on Windows a look off this
    /// thread). A change (speakers to a headset, a call followed to another
    /// output) starts a new echo stretch, which has to hear the call again
    /// before its short lines are judged as echoes.
    fn watch_output(&mut self, cx: &mut Context<Self>) {
        let Some(recording) = self.recording.as_mut() else {
            return;
        };
        let now = Instant::now();
        let watch = &mut recording.output_watch;
        if watch.busy || watch.next_at.is_some_and(|at| now < at) {
            return;
        }
        watch.next_at = Some(now + OUTPUT_CHECK_EVERY);
        let seen = recording.capture.as_ref().and_then(|c| c.outputs_seen());
        if !capture::OUTPUT_IDENTITY_ASKS {
            let identity = capture::output_identity(seen);
            Self::outputs_now(recording, identity);
            return;
        }
        recording.output_watch.busy = true;
        let doc_id = recording.doc_id.clone();
        let (found_tx, found_rx) = flume::bounded(1);
        let looked = std::thread::Builder::new()
            .name("cap-meeting-output-watch".into())
            .spawn(move || {
                let _ = found_tx.send(capture::output_identity(seen));
            });
        if looked.is_err() {
            recording.output_watch.busy = false;
            return;
        }
        cx.spawn(async move |this, cx| {
            let identity = found_rx.recv_async().await.ok().flatten();
            this.update(cx, |this, _| {
                let Some(recording) = this.recording.as_mut().filter(|r| r.doc_id == doc_id) else {
                    return;
                };
                recording.output_watch.busy = false;
                Self::outputs_now(recording, identity);
            })
            .ok();
        })
        .detach();
    }

    fn outputs_now(recording: &mut Recording, identity: Option<String>) {
        let Some(identity) = identity else {
            return;
        };
        let previous = recording.output_watch.last.replace(identity.clone());
        if previous.is_some_and(|previous| previous != identity) {
            tracing::info!(
                to = %identity,
                "the meeting's output changed; short echoes wait for the call to be heard again"
            );
            let at_ms =
                recording.timeline_offset_ms + recording.started.elapsed().as_millis() as u64;
            recording.echo.devices_changed(at_ms);
            let _ = recording.engine.send(EngineCommand::EchoStretches(
                recording.echo.stretches().to_vec(),
            ));
        }
    }

    fn move_mic(
        &mut self,
        doc_id: &str,
        stalled: Option<u32>,
        listed: &[String],
        default: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let feeds = crate::feeds::Feeds::global(cx);
        let current = feeds.read(cx).microphone.clone();
        let screen_idle = crate::session::RecordingSession::global(cx).read(cx).phase
            == crate::session::Phase::Idle;
        let Some(recording) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) else {
            return;
        };
        if !screen_idle {
            // The screen recording's own watch keeps its feed.
            return;
        }
        let Some(step) = mic_watch::decide(
            &mut recording.mic_return,
            recording.mic_own.as_deref(),
            current.as_deref(),
            listed,
            default.as_deref(),
            stalled,
        ) else {
            if stalled == Some(1) {
                tracing::warn!("the meeting microphone stopped and no other input is there");
            }
            return;
        };
        let attached = recording.mic_actor.is_some()
            && feeds.read(cx).mic_actor().map(|actor| actor.id()) == recording.mic_actor;
        let own = recording.mic_own.clone();
        let sender = recording.mic_sender.clone();
        match step {
            mic_watch::MicMove::Reopen(name) if attached => {
                tracing::info!(stalled, "reopening the meeting microphone");
                let Some(actor) = feeds.read(cx).mic_actor() else {
                    return;
                };
                let settings = crate::store::RecordingDeviceSettings::for_microphone(&name);
                let reopen = gpui_tokio::Tokio::spawn(cx, async move {
                    let error = match actor
                        .ask(cap_recording::feeds::microphone::SetInput {
                            label: name,
                            settings,
                        })
                        .await
                    {
                        Ok(ready) => ready.await.err().map(|error| error.to_string()),
                        Err(error) => Some(error.to_string()),
                    };
                    if let Some(error) = &error {
                        tracing::warn!(%error, "the meeting microphone did not reopen");
                    }
                    error
                });
                let doc_id = doc_id.to_string();
                cx.spawn(async move |this, cx| {
                    let Ok(Some(error)) = reopen.await else {
                        return;
                    };
                    if !(cfg!(windows) && mic_access_denied(&error)) {
                        return;
                    }
                    this.update(cx, |this, cx| {
                        if this.recording.as_ref().is_none_or(|r| r.doc_id != doc_id) {
                            return;
                        }
                        let denied = SourceHealth::Error(HealthIssue::MissingPermission);
                        if let Some(active) = this.active.as_mut()
                            && active.mic.health != denied
                        {
                            tracing::info!("microphone access is off for the meeting");
                            active.mic.health = denied;
                            this.mark_active(cx);
                        }
                    })
                    .ok();
                })
                .detach();
            }
            mic_watch::MicMove::Reopen(name) | mic_watch::MicMove::Switch(name) => {
                tracing::info!(stalled, to = %name, "the meeting microphone moves");
                if attached {
                    self.point_feed_at(&name, cx);
                } else if let Some(sender) = sender {
                    let actor = self.attach_mic(name.clone(), sender, cx);
                    if let Some(recording) = self.recording.as_mut() {
                        recording.mic_actor = actor;
                        recording.mic_own.get_or_insert(name.clone());
                    }
                }
                if let Some(recording) = self.recording.as_mut() {
                    if current.as_deref() != Some(name.as_str()) {
                        // Another microphone hears the room its own way.
                        let at_ms = recording.timeline_offset_ms
                            + recording.started.elapsed().as_millis() as u64;
                        recording.echo.devices_changed(at_ms);
                        let _ = recording.engine.send(EngineCommand::EchoStretches(
                            recording.echo.stretches().to_vec(),
                        ));
                    }
                    recording.mic_moved = (own.as_deref() != Some(name.as_str())).then_some(name);
                }
            }
        }
    }

    fn open_doc(
        &mut self,
        origin: &Origin,
    ) -> Result<(DocMeta, Transcript, u64, String), MeetingError> {
        let event = origin
            .event_id
            .as_ref()
            .and_then(|id| self.calendar.find(id))
            .cloned();
        let language = language_code(&self.settings.transcription.language);
        let engine_label = match self.settings.transcription.engine {
            Engine::Local => "local",
            Engine::Cloud => "cloud",
        };
        let calendar_name = event
            .as_ref()
            .and_then(|e| self.calendar.source_name(&e.calendar_id));
        let default_template = self.settings.notes.default_template_id.clone();
        let library = self
            .library()
            .cloned()
            .ok_or_else(|| MeetingError::Library("the library is unavailable".into()))?;
        if let Some(doc_id) = &origin.resume_doc {
            self.opened_here.mark(doc_id);
            let lock = lock_meta();
            let mut meta = library.load(doc_id).map_err(|_| MeetingError::NotFound)?;
            if meta.is_trashed() {
                return Err(MeetingError::NotFound);
            }
            if meta.kind != DocKind::Meeting {
                // A plain note being recorded into becomes a meeting note;
                // what was typed stays as the person's own notes.
                meta.kind = DocKind::Meeting;
                if meta.template_id.is_none() {
                    meta.template_id = Some(default_template.clone());
                }
            }
            if meta.meeting.as_ref().is_none_or(|m| m.event.is_none())
                && let Some(event) = event.as_ref()
            {
                let meeting = meta.meeting.get_or_insert_with(MeetingDetails::default);
                meeting.event = Some(calendar::snapshot(event, calendar_name.clone()));
                if meeting.participants.is_empty() {
                    meeting.participants = calendar::participants(event);
                }
                if (meta.title.trim().is_empty() || meta.title_is_auto)
                    && !event.title.trim().is_empty()
                {
                    // The calendar's name is the meeting's real name, not a
                    // placeholder: show it as a title and never rename it.
                    meta.title = event.title.trim().to_string();
                    meta.title_is_auto = false;
                }
            }
            {
                let meeting = meta.meeting.get_or_insert_with(MeetingDetails::default);
                if meeting.app_name.is_none() {
                    meeting.app_id = origin.app_id.clone();
                    meeting.app_name = origin.app_name.clone();
                }
                if meeting.engine.is_none() {
                    meeting.engine = Some(engine_label.into());
                    meeting.language = Some(language.clone());
                }
            }
            let transcript = library
                .transcript_path(doc_id)
                .ok()
                .and_then(|p| Transcript::load_jsonl(&p).ok())
                .map(|(t, _)| t)
                .unwrap_or_default();
            let meeting = meta.meeting.get_or_insert_with(MeetingDetails::default);
            let previous_ms = meeting
                .duration_ms
                .max(transcript.stats().last_speech_end_ms.unwrap_or(0));
            let suffix = persist::resume_suffix(meeting);
            meeting.ended_at = None;
            meeting.stop_reason = None;
            if meeting.started_at.is_none() {
                meeting.started_at = Some(Utc::now());
            }
            meta.updated_at = Utc::now();
            library
                .save(&meta)
                .map_err(|e| MeetingError::Library(e.to_string()))?;
            drop(lock);
            let offset = previous_ms + RESUME_GAP_MS;
            return Ok((meta, transcript, offset, suffix));
        }
        let now = Utc::now();
        let mut meta = library
            .create(DocKind::Meeting, now, persist::entropy())
            .map_err(|e| MeetingError::Library(e.to_string()))?;
        self.opened_here.mark(&meta.id);
        let event_title = event
            .as_ref()
            .map(|e| e.title.as_str())
            .filter(|title| !title.trim().is_empty());
        meta.title = match event_title {
            Some(title) => auto_title_from(&TitleHint {
                event_title: Some(title),
                ..TitleHint::default()
            }),
            None => crate::meetings_ui::documents::format::meeting_title(
                origin.app_name.as_deref(),
                chrono::Local::now().naive_local(),
            ),
        };
        meta.title_is_auto = event.as_ref().is_none_or(|e| e.title.trim().is_empty());
        meta.template_id = Some(default_template);
        meta.meeting = Some(MeetingDetails {
            started_at: Some(now),
            app_id: origin.app_id.clone(),
            app_name: origin.app_name.clone(),
            participants: event
                .as_ref()
                .map(calendar::participants)
                .unwrap_or_default(),
            event: event.as_ref().map(|e| calendar::snapshot(e, calendar_name)),
            engine: Some(engine_label.into()),
            language: Some(language),
            ..MeetingDetails::default()
        });
        if let Some(name) = speakers::resolve_user_name(&meta)
            && let Some(meeting) = meta.meeting.as_mut()
        {
            meeting
                .extra
                .insert(speakers::USER_NAME_KEY.into(), json!(name));
        }
        library
            .save(&meta)
            .map_err(|e| MeetingError::Library(e.to_string()))?;
        Ok((meta, Transcript::new(), 0, String::new()))
    }

    fn begin_capture(&mut self, resume: bool, cx: &mut Context<Self>) {
        let after_sleep = std::mem::take(&mut self.resuming_after_sleep) && resume;
        self.resumed_line = None;
        let mut origin = self.pending_start.take().unwrap_or_default();
        if resume && origin.resume_doc.is_none() {
            origin.resume_doc = self.resume_doc.clone();
        }
        let opened = self.open_doc(&origin).and_then(|opened| {
            let library = self
                .library()
                .cloned()
                .ok_or_else(|| MeetingError::Library("the library is unavailable".into()))?;
            let path = library
                .transcript_path(&opened.0.id)
                .map_err(|e| MeetingError::Library(e.to_string()))?;
            Ok((opened, library, path))
        });
        let ((mut meta, transcript, offset_ms, suffix), library, transcript_path) = match opened {
            Ok(opened) => opened,
            Err(error) => {
                self.fail_start(error, cx);
                return;
            }
        };
        let doc_id = meta.id.clone();

        let (mode, fallback, awaiting_mode) = self.engine_plan(cx);
        let live = self.settings.transcription.live;
        // Cap Cloud on a computer too slow for live local captions: off
        // unless the user turned them on (the cloud's lines come instead).
        let slow_cloud_live =
            device::slow().then(|| self.settings.transcription.live_for(Engine::Cloud, true));
        let voices_config = self.voices_config(&transcript, cx);
        let live_voices = LiveVoices {
            speakers: Vec::new(),
            attendee: speakers::other_attendee(&meta),
            ..LiveVoices::default()
        };
        let (engine_tx, engine_rx) = flume::unbounded::<EngineEvent>();
        let engine = EngineHandle::spawn(EngineConfig {
            doc_id: doc_id.clone(),
            transcript_path,
            mode: mode.clone(),
            fallback,
            vocabulary: self.settings.transcription.vocabulary.clone(),
            dictionary: std::sync::Arc::new(cap_meetings::dictionary::Corrector::new(
                self.settings.transcription.entries(),
            )),
            live,
            slow_cloud_live,
            voices: voices_config,
            audio: persist::audio_parts(&library, &meta),
            gaps: transcript.gaps().to_vec(),
            runtime: gpui_tokio::Tokio::handle(cx),
            events: engine_tx,
        });
        let engine_pump = cx.spawn(async move |this, cx| {
            while let Ok(event) = engine_rx.recv_async().await {
                let mut batch = vec![event];
                while let Ok(more) = engine_rx.try_recv() {
                    batch.push(more);
                }
                if this
                    .update(cx, |this, cx| {
                        for event in batch {
                            this.on_engine_event(event, cx);
                        }
                    })
                    .is_err()
                {
                    return;
                }
            }
        });

        #[cfg(debug_assertions)]
        let dev_mic = self.dev_mic.take();
        #[cfg(not(debug_assertions))]
        let dev_mic: Option<flume::Receiver<capture::RawBatch>> = None;
        let acquired = match dev_mic {
            Some(rx) => AcquiredMic {
                input: Ok(MicInput::Raw(rx)),
                sender: None,
                actor: None,
                own: None,
            },
            None => self.acquire_mic(&doc_id, cx),
        };
        let AcquiredMic {
            input: mic,
            sender: mic_sender,
            actor: mic_actor,
            own: mic_own,
        } = acquired;
        let restore_mic = self.pending_restore_mic.take();
        // Audio the person doesn't keep is still saved as a scratch copy
        // outside the note, so lost words can be repaired; it goes once the
        // meeting is complete.
        let scratch = !self.settings.recording.keep_audio;
        let audio_dir = if scratch {
            Some(persist::scratch_dir(&doc_id))
        } else {
            library.audio_dir(&doc_id).ok()
        };
        let (capture_tx, capture_rx) = flume::unbounded::<CaptureEvent>();
        let capture_pump = cx.spawn(async move |this, cx| {
            while let Ok(event) = capture_rx.recv_async().await {
                let mut batch = vec![event];
                while let Ok(more) = capture_rx.try_recv() {
                    batch.push(more);
                }
                if this
                    .update(cx, |this, cx| {
                        for event in batch {
                            this.on_capture_event(event, cx);
                        }
                    })
                    .is_err()
                {
                    return;
                }
            }
        });
        let mic_issue = mic.as_ref().err().cloned();
        let capture = MeetingCapture::start(CaptureConfig {
            audio_dir: audio_dir.clone(),
            file_suffix: suffix.clone(),
            timeline_offset_samples: timeline::ms_to_samples(offset_ms),
            mic,
            system: true,
            live_partials: live,
            segments: engine.segments.clone(),
            partials: engine.partials.clone(),
            missed: engine.missed.clone(),
            engine_busy: engine.busy.clone(),
            events: capture_tx,
        });
        if !capture.has_source(Source::Mic) && !capture.has_source(Source::System) {
            let reason = mic_issue
                .map(|i| i.describe())
                .unwrap_or_else(|| "no audio source is available".into());
            drop(capture);
            drop(engine);
            if let Some((previous, ours)) = restore_mic {
                self.restore_microphone(previous, ours, cx);
            }
            self.fail_start(MeetingError::NoAudioSource(reason), cx);
            return;
        }

        let lock = lock_meta();
        // open_doc saved everything it changed; an edit made since is kept
        if let Ok(saved) = library.load(&doc_id) {
            meta = saved;
        }
        if let Some(meeting) = meta.meeting.as_mut() {
            if offset_ms == 0 {
                meeting.started_at = Some(capture.origin_wall());
            }
            if audio_dir.is_some() {
                let key = if scratch {
                    persist::SCRATCH_PARTS_KEY
                } else {
                    persist::AUDIO_PARTS_KEY
                };
                let mut parts = meeting
                    .extra
                    .get(key)
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default();
                for source in [Source::Mic, Source::System] {
                    if capture.has_source(source) {
                        let name = capture::audio_file_name(source, &suffix);
                        parts.push(json!({
                            "file": if scratch { name } else { format!("{}/{name}", cap_meetings::library::AUDIO_DIR) },
                            "source": source,
                            "offsetMs": offset_ms,
                        }));
                    }
                }
                meeting.extra.insert(key.into(), serde_json::Value::Array(parts));
                if scratch {
                    meeting.extra.insert(persist::SCRATCH_KEY.into(), serde_json::Value::Bool(true));
                }
            }
            meeting.engine = Some(match &mode {
                EngineMode::Local(local) => format!("local:{}", local.model),
                EngineMode::Cloud { .. } | EngineMode::Pending => "cloud".into(),
                EngineMode::Unavailable(_) => "none".into(),
            });
        }
        if let Err(error) = library.save(&meta) {
            tracing::warn!(%error, "could not save the meeting before recording");
        }
        drop(lock);
        for part in persist::audio_parts(&library, &meta) {
            let _ = engine.send(EngineCommand::AudioPart(part));
        }
        let low_disk = health::free_bytes(&persist::documents_dir())
            .is_some_and(|free| free < health::LOW_DISK_BYTES);
        if low_disk {
            tracing::warn!("starting a meeting with the disk almost full");
        }
        let health_tick = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(HEALTH_TICK).await;
                if this.update(cx, |this, cx| this.health_tick(cx)).is_err() {
                    break;
                }
            }
        });

        let started = Instant::now();
        let started_at = meta
            .meeting
            .as_ref()
            .and_then(|m| m.started_at)
            .unwrap_or_else(Utc::now);
        let mut active = ActiveMeeting {
            doc_id: doc_id.clone(),
            title: meta.title.clone(),
            started_at,
            started,
            state: ActiveState::Recording,
            mic: SourceState::default(),
            system: SourceState::default(),
            engine: EngineStatus::default(),
            warning: None,
            resume_offer_until: None,
            slept: false,
            resumed_after_sleep: after_sleep,
            app_name: origin.app_name.clone(),
            event_id: origin.event_id.clone(),
            health: Vec::new(),
            not_hearing: false,
            audio_failed: false,
            low_disk,
        };
        for source in [Source::Mic, Source::System] {
            active.source_mut(source).health = if capture.has_source(source) {
                SourceHealth::Starting
            } else {
                match (source, &mic_issue) {
                    (Source::Mic, Some(issue)) => SourceHealth::Error(issue.clone()),
                    (Source::System, _) if linux_monitor_missing() => {
                        SourceHealth::Error(HealthIssue::TapUnsupported)
                    }
                    _ => SourceHealth::Error(HealthIssue::Failed("Could not start".into())),
                }
            };
        }
        self.active = Some(active);
        self.recording = Some(Recording {
            doc_id: doc_id.clone(),
            started,
            timeline_offset_ms: offset_ms,
            capture: Some(capture),
            engine,
            engine_pump,
            _capture_pump: capture_pump,
            transcript,
            echo: echo_periods::EchoPeriods::from(offset_ms),
            output_watch: OutputWatch::default(),
            mic_sender,
            mic_actor,
            mic_own,
            mic_moved: None,
            mic_watch: mic_watch::MicWatch::default(),
            mic_return: mic_watch::OwnReturn::default(),
            restore_mic,
            awaiting_mode,
            voices: live_voices,
            audio_dir,
            health: health::Hysteresis::default(),
            watchdog: health::Watchdog::default(),
            disk_checked: Instant::now(),
            _awake: crate::power::StayAwake::hold("Cap is recording a meeting", cx),
            padded_ms: [0, 0],
            missed_ms: [0, 0],
            missed_until: None,
            voice_at: None,
            line_at: None,
            _health_tick: health_tick,
        });
        self.resume_doc = Some(doc_id.clone());
        self.session_doc = Some(doc_id.clone());
        if self.sleep_kept.as_deref() == Some(doc_id.as_str()) {
            self.sleep_kept = None;
        }
        if after_sleep {
            tracing::info!(doc_id, "the meeting resumed by itself after the sleep");
            let shown = doc_id.clone();
            self.resumed_line = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(RESUMED_LINE).await;
                this.update(cx, |this, cx| {
                    if let Some(active) = this.active.as_mut().filter(|a| a.doc_id == shown) {
                        active.resumed_after_sleep = false;
                        this.mark_active(cx);
                    }
                })
                .ok();
            }));
        }
        let actions = self.session.on_capture_started(self.now());
        self.apply_session_actions(actions, cx);
        let actions = self.planner.set_recording(
            self.now_pair(),
            RecordingState::Recording {
                event_id: origin.event_id.clone(),
            },
        );
        self.apply_prompt_actions(actions, cx);
        self.apply_lifecycle(cx);
        self.watch_speaking(doc_id.clone(), cx);
        cx.emit(MeetingEvent::RecordingStarted {
            doc_id: doc_id.clone(),
        });
        cx.emit(MeetingEvent::LibraryChanged);
        if origin.automatic && self.settings.automation.bring_up_window {
            cx.emit(MeetingEvent::WantsAttention {
                reason: AttentionReason::RecordingStarted { doc_id },
            });
        }
        self.mark_active(cx);
    }

    fn fail_start(&mut self, error: MeetingError, cx: &mut Context<Self>) {
        tracing::warn!(%error, "meeting recording did not start");
        self.last_start_error = Some(error);
        let actions = self.session.on_capture_error(self.now());
        self.apply_session_actions(actions, cx);
        if self.session.state() == SessionState::Stopping {
            let actions = self.session.on_capture_stopped(self.now(), 0);
            self.apply_session_actions(actions, cx);
        }
    }

    fn restore_microphone(
        &mut self,
        previous: Option<String>,
        ours: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let feeds = crate::feeds::Feeds::global(cx);
        if feeds.read(cx).microphone == ours {
            feeds.update(cx, |feeds, cx| feeds.set_microphone(previous, cx));
        }
    }

    fn end_capture(&mut self, reason: StopReason, cx: &mut Context<Self>) {
        let Some(mut recording) = self.recording.take() else {
            return;
        };
        let summary = recording
            .capture
            .take()
            .map(MeetingCapture::stop)
            .unwrap_or_default();
        if let Some(sender) = recording.mic_sender.take()
            && let Some(actor) = crate::feeds::Feeds::global(cx).read(cx).mic_actor()
        {
            gpui_tokio::Tokio::spawn(cx, async move {
                let _ = actor.ask(RemoveSender(sender)).await;
            })
            .detach();
        }
        if let Some((previous, ours)) = recording.restore_mic.take() {
            self.restore_microphone(previous, ours, cx);
        }
        let _ = recording.engine.send(EngineCommand::EchoStretches(
            recording.echo.stretches().to_vec(),
        ));
        let _ = recording.engine.send(EngineCommand::Finish);

        let duration_ms = recording.timeline_offset_ms
            + [summary.mic.as_ref(), summary.system.as_ref()]
                .into_iter()
                .flatten()
                .map(|s| s.duration_ms)
                .max()
                .unwrap_or_else(|| recording.started.elapsed().as_millis() as u64);
        let doc_id = recording.doc_id.clone();
        let chars = recording.transcript.stats().total_chars as u64;
        if let Some(library) = self.library().cloned()
            && let (_lock, Ok(mut meta)) = (lock_meta(), library.load(&doc_id))
        {
            let tracks = persist::audio_tracks(&library, &doc_id);
            if let Some(meeting) = meta.meeting.as_mut() {
                meeting.ended_at = Some(Utc::now());
                meeting.duration_ms = meeting.duration_ms.max(duration_ms);
                meeting.stop_reason = Some(reason);
                meeting.transcript_chars = chars;
                meeting.audio = tracks;
            }
            // One hold-up stops both tracks, so the longer track's total is
            // what the meeting missed.
            let missed = recording.missed_ms.into_iter().max().unwrap_or(0);
            if persist::add_missed_audio(&mut meta, missed) {
                tracing::info!(
                    doc_id,
                    missed_ms = missed,
                    "the meeting missed audio while it recorded"
                );
            }
            meta.updated_at = Utc::now();
            if let Err(error) = library.save(&meta) {
                tracing::warn!(%error, "could not save the stopped meeting");
            }
        }

        let Recording {
            engine,
            engine_pump,
            transcript,
            echo,
            voices,
            ..
        } = recording;
        self.finishing.push(Finishing {
            doc_id: doc_id.clone(),
            engine,
            _engine_pump: engine_pump,
            transcript,
            echo,
            generate_notes: false,
            voices,
            open_gaps: 0,
            unrepairable: 0,
            repair: false,
            chars_before: 0,
        });
        self.notes_doc = Some(doc_id.clone());
        // Both offer Resume (sleep once the computer wakes): the indicator
        // stays for it.
        if matches!(reason, StopReason::Inactivity | StopReason::Sleep) {
            if let Some(active) = self.active.as_mut() {
                active.state = ActiveState::Stopping;
                active.warning = None;
            }
        } else {
            self.active = None;
        }
        let actions = self
            .planner
            .set_recording(self.now_pair(), RecordingState::Idle);
        self.apply_prompt_actions(actions, cx);
        cx.emit(MeetingEvent::RecordingStopped { doc_id, reason });
        cx.emit(MeetingEvent::LibraryChanged);
        self.mark_active(cx);
        self.apply_lifecycle(cx);
    }

    fn finishing_chars(&self, doc_id: Option<&str>) -> usize {
        doc_id
            .and_then(|id| self.finishing.iter().find(|f| f.doc_id == id))
            .map_or(0, |f| f.transcript.stats().total_chars)
    }

    fn on_capture_event(&mut self, event: CaptureEvent, cx: &mut Context<Self>) {
        match event {
            CaptureEvent::Level { source, level } => {
                if let Some(active) = self.active.as_mut() {
                    active.source_mut(source).level = level;
                }
                if level >= crate::meetings_ui::live::model::METER_GATE
                    && let Some(recording) = self.recording.as_mut()
                {
                    recording.voice_at = Some(Instant::now());
                }
            }
            CaptureEvent::Health { source, health } => {
                if let Some(active) = self.active.as_mut() {
                    active.source_mut(source).health = health;
                }
            }
            CaptureEvent::Speech { source, ms } => {
                if let Some(active) = self.active.as_mut() {
                    let state = active.source_mut(source);
                    state.speech_ms = state.speech_ms.saturating_add(ms);
                }
                let actions = self.session.on_speech(self.now(), source, ms);
                self.apply_session_actions(actions, cx);
            }
            CaptureEvent::AudioFailed { source } => {
                tracing::warn!(?source, "meeting audio could not be saved");
                if let Some(active) = self.active.as_mut() {
                    active.audio_failed = true;
                }
            }
            CaptureEvent::AudioPart {
                source,
                path,
                offset_samples,
            } => self.add_audio_part(source, path, offset_samples),
        }
        self.refresh_counters();
        self.mark_active(cx);
    }

    fn refresh_counters(&mut self) {
        let Some(recording) = self.recording.as_ref() else {
            return;
        };
        let Some(capture) = recording.capture.as_ref() else {
            return;
        };
        let stats = capture.stats();
        // What the tap has delivered, once it has run long enough to judge.
        let heard = stats
            .tap
            .filter(|_| recording.started.elapsed() > NO_TAP_CALLBACKS_AFTER)
            .map(|tap| health::TapHeard {
                callbacks: tap.callbacks > 0,
                sound: stats.system.is_some_and(|s| s.sound_at_ms > 0),
            });
        let Some(active) = self.active.as_mut() else {
            return;
        };
        for (source, stats) in [(Source::Mic, stats.mic), (Source::System, stats.system)] {
            if let Some(stats) = stats {
                let state = active.source_mut(source);
                state.dropped_batches = stats.dropped_batches;
                state.dropped_segments = stats.dropped_segments;
            }
        }
        if let Some(tap) = stats.tap {
            active.system.dropped_batches += tap.dropped;
        }
        if let Some(health) = heard.and_then(|heard| {
            health::system_permission_health(
                &active.system.health,
                system_audio_grant(),
                crate::permissions::grants_are_settings_only(),
                Some(heard),
            )
        }) {
            active.system.health = health;
        }
    }

    /// Once a second while recording: the watchdog over the computer audio,
    /// a look at the disk now and then, and the one health line.
    fn health_tick(&mut self, cx: &mut Context<Self>) {
        self.watch_mic(cx);
        self.watch_output(cx);
        // Debug builds: CAP_GPUI_MEETING_FAKE_CALL=1 acts as if a meeting app
        // held the microphone.
        let call = !self.active_calls().is_empty()
            || (cfg!(debug_assertions) && std::env::var_os("CAP_GPUI_MEETING_FAKE_CALL").is_some());
        let Some(recording) = self.recording.as_mut() else {
            return;
        };
        let Some(capture) = recording.capture.as_ref() else {
            return;
        };
        let now = Instant::now();
        let stats = capture.stats();
        let elapsed = recording.started.elapsed().as_millis() as u64;
        // Debug builds: CAP_GPUI_MEETING_HANG_UI=<start_s>:<secs> blocks this
        // (the UI) thread once, as a hung window would.
        if cfg!(debug_assertions) {
            static HUNG: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
            if let Some((start, secs)) = std::env::var("CAP_GPUI_MEETING_HANG_UI").ok().and_then(|v| {
                let (start, secs) = v.split_once(':')?;
                Some((start.parse::<u64>().ok()?, secs.parse::<u64>().ok()?))
            }) && elapsed >= start * 1000
                && !HUNG.swap(true, std::sync::atomic::Ordering::Relaxed)
            {
                tracing::warn!(secs, "debug: blocking the UI thread");
                std::thread::sleep(Duration::from_secs(secs));
                tracing::warn!("debug: the UI thread runs again");
            }
        }
        // Stamps are ms since capture began plus one; 0 is "never".
        let since = |at: u64| Duration::from_millis(elapsed.saturating_sub(at.saturating_sub(1)));
        let at_ms = recording.timeline_offset_ms + elapsed;
        let me = recording.voices.app_self.as_deref();
        let remote_speaking = recording
            .voices
            .active
            .iter()
            .rev()
            .take_while(|s| s.at_ms + 30_000 >= at_ms)
            .filter(|s| s.speaking.iter().any(|name| Some(name.as_str()) != me))
            .count()
            >= 2;
        let view = health::TapView {
            call,
            since_real: stats.system.map(|s| since(s.real_at_ms)),
            since_sound: stats.system.map(|s| since(s.sound_at_ms)),
            remote_speaking,
            gave_up: stats.tap.is_some_and(|t| t.gave_up),
            playing_elsewhere: stats.system.is_some_and(|s| {
                since(s.real_at_ms) >= health::NO_AUDIO_RESTART
            }) && system_audio_grant() == health::AudioGrant::Granted
                && others_playing(),
        };
        let verdict = recording.watchdog.check(now, view);
        if verdict.restart {
            tracing::warn!(
                restarts = recording.watchdog.restarts,
                ?view,
                "the call's audio stopped arriving, restarting its capture"
            );
            capture.restart_system();
        }
        // Silence the timeline had to fill in: audio the app never received.
        for (slot, track) in [stats.mic, stats.system].into_iter().enumerate() {
            let Some(track) = track else { continue };
            let jump = track.padded_ms.saturating_sub(recording.padded_ms[slot]);
            recording.padded_ms[slot] = track.padded_ms;
            if jump >= health::MISSED_AUDIO.as_millis() as u64 {
                tracing::warn!(slot, jump_ms = jump, "meeting audio went missing (the app was held up)");
                recording.missed_until = Some(now + health::MISSED_SHOWN);
                recording.missed_ms[slot] += jump;
            }
        }
        let audio_missed = recording.missed_until.is_some_and(|until| now < until);
        let low_disk = if recording.disk_checked.elapsed() >= DISK_CHECK_EVERY {
            recording.disk_checked = now;
            let dir = recording
                .audio_dir
                .clone()
                .unwrap_or_else(persist::documents_dir);
            Some(health::free_bytes(&dir).is_some_and(|free| free < health::LOW_DISK_BYTES))
        } else {
            None
        };
        let Some(active) = self.active.as_mut().filter(|a| a.doc_id == recording.doc_id) else {
            return;
        };
        active.not_hearing = verdict.not_hearing;
        if let Some(low) = low_disk {
            active.low_disk = low;
        }
        let line = recording
            .health
            .update(now, &health::concerns_with(active, audio_missed));
        if active.health != line {
            tracing::info!(health = ?line, "meeting health line");
            active.health = line;
            self.mark_active(cx);
        }
    }

    /// A track went on in a new file after a failed write: the meeting's
    /// list of files learns it, and so does the engine's repair.
    fn add_audio_part(&mut self, source: Source, path: PathBuf, offset_samples: u64) {
        if let Some(active) = self.active.as_mut() {
            active.audio_failed = false;
        }
        let Some(recording) = self.recording.as_ref() else {
            return;
        };
        let doc_id = recording.doc_id.clone();
        let _ = recording.engine.send(EngineCommand::AudioPart(AudioPart {
            source,
            path: path.clone(),
            offset_samples,
        }));
        let Some(library) = self.library().cloned() else {
            return;
        };
        let _lock = lock_meta();
        let Ok(mut meta) = library.load(&doc_id) else {
            return;
        };
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let scratch = path.starts_with(persist::scratch_root());
        if let Some(meeting) = meta.meeting.as_mut() {
            let key = if scratch {
                persist::SCRATCH_PARTS_KEY
            } else {
                persist::AUDIO_PARTS_KEY
            };
            let mut parts = meeting
                .extra
                .get(key)
                .and_then(|v| v.as_array().cloned())
                .unwrap_or_default();
            parts.push(json!({
                "file": if scratch { name.to_string() } else { format!("{}/{name}", cap_meetings::library::AUDIO_DIR) },
                "source": source,
                "offsetMs": timeline::samples_to_ms(offset_samples),
            }));
            meeting
                .extra
                .insert(key.into(), serde_json::Value::Array(parts));
        }
        if let Err(error) = library.save(&meta) {
            tracing::warn!(%error, "could not record the meeting's new audio file");
        }
    }

    fn on_engine_event(&mut self, event: EngineEvent, cx: &mut Context<Self>) {
        match event {
            EngineEvent::Utterance { doc_id, utterance } => {
                let is_final = utterance.is_final;
                let source = utterance.source;
                let end_ms = utterance.end_ms;
                let id = utterance.id.clone();
                let (transcript, engine, echo) =
                    if let Some(r) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
                        (&mut r.transcript, Some(&r.engine), &mut r.echo)
                    } else if let Some(f) = self.finishing.iter_mut().find(|f| f.doc_id == doc_id) {
                        (&mut f.transcript, Some(&f.engine), &mut f.echo)
                    } else {
                        return;
                    };
                let speaker_id = utterance.speaker_id;
                if !transcript.upsert(utterance) {
                    return;
                }
                let unknown = speaker_id.is_some_and(|id| {
                    transcript
                        .names()
                        .is_none_or(|n| n.label(cap_diarize::SpeakerId(id)).is_none())
                });
                if is_final {
                    let stale: Vec<String> = transcript
                        .utterances()
                        .iter()
                        .filter(|u| {
                            !u.is_final && u.source == source && u.start_ms < end_ms && u.id != id
                        })
                        .map(|u| u.id.clone())
                        .collect();
                    transcript.remove(&stale);
                    let stretches = echo.stretches().to_vec();
                    let echoes = remove_echoes(transcript, echo);
                    if echo.stretches() != stretches.as_slice()
                        && let Some(engine) = engine
                    {
                        // The diarizer judges echoes on the microphone by
                        // the same stretches as it goes.
                        let _ =
                            engine.send(EngineCommand::EchoStretches(echo.stretches().to_vec()));
                    }
                    if !echoes.is_empty() {
                        let line = vec![LogLine::Delete { ids: echoes }];
                        if let Some(engine) = engine
                            && let Err(EngineCommand::Append(lines)) =
                                engine.send(EngineCommand::Append(line))
                        {
                            self.append_direct(&doc_id, lines);
                        }
                    }
                }
                if unknown && is_final {
                    self.observe_voices(&doc_id, cx);
                }
                if let Some(recording) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
                    recording.line_at = Some(Instant::now());
                }
                self.dirty_transcripts.insert(doc_id);
                self.schedule_notify(cx);
            }
            EngineEvent::Removed { doc_id, ids } => {
                let transcript =
                    if let Some(r) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
                        &mut r.transcript
                    } else if let Some(f) = self.finishing.iter_mut().find(|f| f.doc_id == doc_id) {
                        &mut f.transcript
                    } else {
                        return;
                    };
                if transcript.remove(&ids) > 0 {
                    self.dirty_transcripts.insert(doc_id);
                    self.schedule_notify(cx);
                }
            }
            EngineEvent::Speakers { doc_id, speakers } => {
                if let Some(voices) = self.live_voices_mut(&doc_id) {
                    voices.speakers = speakers;
                    self.observe_voices(&doc_id, cx);
                }
            }
            EngineEvent::FinalSpeakers { doc_id, voices } => {
                self.apply_final_voices(&doc_id, *voices, cx);
            }
            EngineEvent::LateSpeakers { doc_id, late } => {
                self.apply_late_voices(&doc_id, *late, cx);
            }
            EngineEvent::Status { doc_id, status } => {
                if let Some(finishing) = self.finishing.iter_mut().find(|f| f.doc_id == doc_id) {
                    finishing.open_gaps = status.gaps;
                    finishing.unrepairable = status.unrepairable;
                }
                if let Some(active) = self.active.as_mut().filter(|a| a.doc_id == doc_id) {
                    active.engine = status;
                    self.mark_active(cx);
                }
            }
            EngineEvent::Drained { doc_id } => self.on_drained(doc_id, cx),
        }
    }

    fn on_drained(&mut self, doc_id: String, cx: &mut Context<Self>) {
        let Some(index) = self.finishing.iter().position(|f| f.doc_id == doc_id) else {
            return;
        };
        let mut finishing = self.finishing.remove(index);
        finishing.transcript.retract_partials(Source::Mic);
        finishing.transcript.retract_partials(Source::System);
        let chars = finishing.transcript.stats().total_chars;
        let engine = finishing.engine;
        cx.background_executor()
            .spawn(async move {
                engine.join();
                // the speaker model and the engine's buffers are gone now
                crate::transcription::return_freed_memory();
            })
            .detach();
        // Nemotron's after-Stop labels come through this pump after the drain;
        // it ends by itself once the engine and that pass have let go
        finishing._engine_pump.detach();
        let mut heard_nothing = false;
        if let Some(library) = self.library().cloned()
            && let (lock, Ok(mut meta)) = (lock_meta(), library.load(&doc_id))
            && let Some(meeting) = meta.meeting.as_mut()
        {
            meeting.transcript_chars = chars as u64;
            // Audio still waiting for its words is tried again next launch;
            // gaps with no saved audio can't be, so they don't keep it waiting.
            let open = finishing.open_gaps > finishing.unrepairable;
            if finishing.unrepairable > 0 {
                tracing::warn!(doc_id, gaps = finishing.unrepairable, "meeting words missing with no saved audio to repair them");
            }
            if finishing.repair
                && meeting.has_enhanced
                && chars >= finishing.chars_before + persist::NOTES_STALE_CHARS
            {
                tracing::info!(doc_id, added = chars - finishing.chars_before, "a repair added words after the notes were written");
                persist::set_flag(&mut meta, persist::NOTES_STALE_KEY, true);
            }
            match persist::after_repair(&mut meta, open) {
                (true, _) => {
                    tracing::warn!(doc_id, gaps = finishing.open_gaps, "meeting audio left to repair at the next launch");
                }
                (false, true) => tracing::warn!(
                    doc_id,
                    gaps = finishing.open_gaps,
                    tries = persist::REPAIR_TRIES_MAX,
                    "meeting audio could not be repaired, giving up"
                ),
                (false, false) => {}
            }
            if let Err(error) = library.save(&meta) {
                tracing::warn!(%error, "could not save the meeting transcript size");
            }
            drop(lock);
            let again = self.recording.as_ref().is_some_and(|r| r.doc_id == doc_id);
            // A sleep's note waits for its Resume: one the call went on
            // through resumes into it even if nobody had spoken yet.
            let resumable = self.session.last_stop_reason() == Some(StopReason::Sleep)
                && self.session.resume_may_follow();
            if resumable && !again && false_start(&library, &meta, chars) {
                self.sleep_kept = Some(doc_id.clone());
            } else if !again && false_start(&library, &meta, chars) {
                // A false start: nothing heard, nothing typed. Trash keeps it
                // restorable while home stays clean.
                heard_nothing = true;
                match library.trash(&doc_id, Utc::now()) {
                    Ok(_) => {
                        tracing::info!(doc_id, "a meeting note that heard nothing went to Trash")
                    }
                    Err(error) => tracing::warn!(%error, "could not trash an empty meeting note"),
                }
            }
        }
        if self.recording.is_none() && self.finishing.is_empty() {
            cx.background_executor()
                .spawn(async { crate::transcription::release_live_models() })
                .detach();
        }
        if self.session.state() == SessionState::Stopping
            && self.session_doc.as_deref() == Some(doc_id.as_str())
        {
            self.session_doc = None;
            let actions = self.session.on_capture_stopped(self.now(), chars);
            self.apply_session_actions(actions, cx);
        }
        if finishing.generate_notes && !heard_nothing {
            self.start_auto_notes(doc_id.clone(), cx);
        }
        if finishing.repair && !heard_nothing && !finishing.generate_notes {
            self.notes_after_repair(&doc_id, cx);
        }
        self.drop_scratch_when_done(&doc_id);
        // A meeting sleep stopped keeps its indicator for the Resume that
        // wake offers.
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.doc_id == doc_id && a.state == ActiveState::Stopping)
            && !self.session.offers_resume_on_wake()
        {
            self.active = None;
        }
        self.dirty_transcripts.insert(doc_id);
        cx.emit(MeetingEvent::LibraryChanged);
        self.mark_active(cx);
        self.apply_lifecycle(cx);
        self.next_repair(cx);
    }

    /// Finishes a meeting from an earlier run: its saved audio goes through
    /// an engine that transcribes the ledger's gaps, then its notes.
    fn repair_meeting(&mut self, doc_id: &str, cx: &mut Context<Self>) -> bool {
        let Some(library) = self.library().cloned() else {
            return false;
        };
        let Ok(meta) = library.load(doc_id) else {
            return false;
        };
        let Ok(path) = library.transcript_path(doc_id) else {
            return false;
        };
        let transcript = Transcript::load_jsonl(&path).map(|(t, _)| t).unwrap_or_default();
        let language = meta
            .meeting
            .as_ref()
            .and_then(|m| m.language.clone())
            .unwrap_or_else(|| language_code(&self.settings.transcription.language));
        let local = self.resolve_local_model(&language);
        let auth = crate::store::auth_snapshot();
        let cloud = self.settings.transcription.engine == Engine::Cloud
            && auth.signed_in()
            && auth.is_upgraded()
            && self.capabilities().is_none_or(|c| c.transcription);
        let (mode, fallback) = match (cloud, local) {
            (true, local) => (EngineMode::Cloud { language }, local),
            (false, Some(local)) => (EngineMode::Local(local), None),
            (false, None) if persist::repairable(transcript.gaps(), &persist::audio_parts(&library, &meta)).is_empty() => {
                (EngineMode::Unavailable("nothing to repair".into()), None)
            }
            (false, None) => {
                tracing::info!(doc_id, "no way to transcribe this meeting's saved audio yet");
                return false;
            }
        };
        // Gaps whose audio was never kept stay in the ledger as a record;
        // only the rest can be filled.
        let parts = persist::audio_parts(&library, &meta);
        let repairable = persist::repairable(transcript.gaps(), &parts);
        let gaps = repairable.len();
        tracing::info!(doc_id, gaps, ledger = transcript.gaps().len(), ?mode, "finishing a meeting from its saved audio");
        // Repaired lines get voices like live ones: new voices numbered after
        // the note's, the user keeping theirs (as when a meeting resumes).
        let voices = if gaps > 0 { self.voices_config(&transcript, cx) } else { None };
        let (engine_tx, engine_rx) = flume::unbounded::<EngineEvent>();
        let engine = EngineHandle::spawn(EngineConfig {
            doc_id: doc_id.to_string(),
            transcript_path: path,
            mode,
            fallback,
            vocabulary: self.settings.transcription.vocabulary.clone(),
            dictionary: std::sync::Arc::new(cap_meetings::dictionary::Corrector::new(
                self.settings.transcription.entries(),
            )),
            live: false,
            slow_cloud_live: None,
            voices,
            audio: parts.clone(),
            gaps: repairable,
            runtime: gpui_tokio::Tokio::handle(cx),
            events: engine_tx,
        });
        let _ = engine.send(EngineCommand::Finish);
        let engine_pump = cx.spawn(async move |this, cx| {
            while let Ok(event) = engine_rx.recv_async().await {
                if this.update(cx, |this, cx| this.on_engine_event(event, cx)).is_err() {
                    return;
                }
            }
        });
        let open_gaps = gaps as u32;
        let chars_before = transcript.stats().total_chars;
        self.finishing.push(Finishing {
            doc_id: doc_id.to_string(),
            engine,
            _engine_pump: engine_pump,
            transcript,
            echo: echo_periods::EchoPeriods::default(),
            generate_notes: false,
            voices: LiveVoices::default(),
            open_gaps,
            unrepairable: 0,
            repair: true,
            chars_before,
        });
        self.apply_lifecycle(cx);
        true
    }

    /// Writes the notes again from the repaired transcript.
    pub fn update_notes(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        if self.notes_state(doc_id).is_some_and(|s| s.running) {
            return;
        }
        let task = self.generate_notes(doc_id, GenerateOptions::default(), cx);
        self.auto_notes.insert(doc_id.to_string(), task);
    }

    /// The person saw the note's one-time line ("recovered", or "transcript
    /// updated"): it does not come back.
    pub fn clear_recovered(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let Some(library) = self.library().cloned() else {
            return;
        };
        if let (lock, Ok(mut meta)) = (lock_meta(), library.load(doc_id))
            && (persist::set_flag(&mut meta, persist::RECOVERED_KEY, false)
                | persist::set_flag(&mut meta, persist::NOTES_STALE_KEY, false)
                | persist::clear_missed_audio(&mut meta))
        {
            if let Err(error) = library.save(&meta) {
                tracing::warn!(%error, "could not clear a recovered meeting's line");
            }
            drop(lock);
            cx.emit(MeetingEvent::LibraryChanged);
        }
    }

    /// A meeting that doesn't keep its audio loses its scratch copy once
    /// nothing needs it: recorded, drained, repaired, and its notes written
    /// (or no longer coming).
    fn drop_scratch_when_done(&mut self, doc_id: &str) {
        let busy = self.recording.as_ref().is_some_and(|r| r.doc_id == doc_id)
            || self.finishing.iter().any(|f| f.doc_id == doc_id)
            || self.auto_notes.contains_key(doc_id)
            || self.notes.get(doc_id).is_some_and(|s| s.running);
        if busy {
            return;
        }
        let Some(library) = self.library().cloned() else {
            return;
        };
        let _lock = lock_meta();
        let Ok(mut meta) = library.load(doc_id) else {
            return;
        };
        if !persist::flag(&meta, persist::SCRATCH_KEY) || persist::flag(&meta, persist::REPAIR_KEY) {
            return;
        }
        persist::drop_scratch_in(&persist::scratch_root(), &mut meta);
        tracing::info!(doc_id, "the meeting's scratch audio was deleted");
        if let Err(error) = library.save(&meta) {
            tracing::warn!(%error, "could not record that the scratch audio is gone");
        }
    }

    /// One repair at a time, and none while a meeting records.
    fn next_repair(&mut self, cx: &mut Context<Self>) {
        if self.recording.is_some() || self.finishing.iter().any(|f| f.repair) {
            return;
        }
        while let Some(doc_id) = self.repair_queue.pop_front() {
            if self.finishing.iter().any(|f| f.doc_id == doc_id) {
                continue;
            }
            if self.repair_meeting(&doc_id, cx) {
                return;
            }
        }
    }

    /// A repaired meeting gets the notes it missed: written if it has none,
    /// and marked for an update if it has some from before the repair.
    fn notes_after_repair(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let has_notes = self
            .library()
            .and_then(|l| l.load(doc_id).ok())
            .and_then(|m| m.meeting)
            .is_some_and(|m| m.has_enhanced);
        if !has_notes {
            self.request_auto_notes(doc_id.to_string(), cx);
        }
    }

    fn append_direct(&mut self, doc_id: &str, lines: Vec<LogLine>) {
        let Some(path) = self.library().and_then(|l| l.transcript_path(doc_id).ok()) else {
            return;
        };
        persist::append_edits(path, lines);
    }

    pub fn transcript(&mut self, doc_id: &str) -> Option<Cow<'_, Transcript>> {
        if self.recording.as_ref().is_some_and(|r| r.doc_id == doc_id) {
            return self
                .recording
                .as_ref()
                .map(|r| Cow::Borrowed(&r.transcript));
        }
        if let Some(index) = self.finishing.iter().position(|f| f.doc_id == doc_id) {
            return Some(Cow::Borrowed(&self.finishing[index].transcript));
        }
        let path = self.library()?.transcript_path(doc_id).ok()?;
        Transcript::load_jsonl(&path)
            .ok()
            .map(|(t, _)| Cow::Owned(t))
    }

    fn edit_transcript(&mut self, doc_id: &str, line: LogLine, cx: &mut Context<Self>) {
        let target = if let Some(r) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
            Some((&mut r.transcript, &r.engine))
        } else {
            self.finishing
                .iter_mut()
                .find(|f| f.doc_id == doc_id)
                .map(|f| (&mut f.transcript, &f.engine))
        };
        match target {
            Some((transcript, engine)) => {
                transcript.apply(line.clone());
                if let Err(EngineCommand::Append(lines)) =
                    engine.send(EngineCommand::Append(vec![line]))
                {
                    self.append_direct(doc_id, lines);
                }
            }
            None => self.append_direct(doc_id, vec![line]),
        }
        cx.emit(MeetingEvent::TranscriptChanged {
            doc_id: doc_id.to_string(),
        });
    }

    /// "Always spell as": the dictionary learns `wrong` as a sounds-like form
    /// of `right`, and this meeting's transcript is fixed in place. Returns
    /// how many lines changed.
    pub fn always_spell(
        &mut self,
        doc_id: &str,
        wrong: &str,
        right: &str,
        cx: &mut Context<Self>,
    ) -> usize {
        let (wrong, right) = (wrong.trim(), right.trim());
        if wrong.is_empty() || right.is_empty() || wrong == right {
            return 0;
        }
        self.update_settings(
            |s| {
                let mut entries = s.transcription.entries().to_vec();
                cap_meetings::dictionary::learn(&mut entries, right, wrong);
                s.transcription.dictionary = Some(entries);
            },
            cx,
        );
        crate::store::mirror_transcription_hints(&self.settings.transcription.vocabulary);
        let corrector =
            cap_meetings::dictionary::Corrector::new(&[cap_meetings::dictionary::Entry::new(
                right,
            )
            .with_sounds_like(&[wrong])]);
        let fixed: Vec<cap_meetings::transcript::Utterance> = self
            .transcript(doc_id)
            .map(|t| {
                t.utterances()
                    .iter()
                    .filter_map(|line| respell(&corrector, line))
                    .collect()
            })
            .unwrap_or_default();
        let count = fixed.len();
        for utterance in fixed {
            self.edit_transcript(doc_id, LogLine::Upsert { utterance }, cx);
        }
        count
    }

    pub fn delete_utterances(&mut self, doc_id: &str, ids: Vec<String>, cx: &mut Context<Self>) {
        if !ids.is_empty() {
            self.edit_transcript(doc_id, LogLine::Delete { ids }, cx);
        }
    }

    /// Rename a speaker in this meeting. Returns what undoes it exactly.
    pub fn rename_speaker(
        &mut self,
        doc_id: &str,
        speaker: SpeakerRef,
        to: &str,
        cx: &mut Context<Self>,
    ) -> Option<RenameUndo> {
        let from = self.speaker_label(doc_id, &speaker);
        let to = to.trim().to_string();
        if let SpeakerRef::Id(id) = speaker {
            // Renamed on the latest names, like a voice choice, so it never
            // undoes another edit or the after-Stop labels still queued.
            let attendee = self
                .library()
                .and_then(|l| l.load(doc_id).ok())
                .and_then(|meta| speakers::other_attendee(&meta));
            let undo = ChoiceUndo::default();
            let taken = undo.clone();
            let name = to.clone();
            self.rewrite_transcript(
                doc_id,
                move |transcript| {
                    let before = transcript
                        .names()
                        .cloned()
                        .unwrap_or_else(|| cap_diarize::SpeakerNames::new(attendee));
                    let mut after = before.clone();
                    after.rename(cap_diarize::SpeakerId(id), &name);
                    if after == before {
                        return None;
                    }
                    *taken.lock() = Some(ChoiceMade::Names {
                        before,
                        after: after.clone(),
                    });
                    Some(LogLine::SpeakerNames { names: after })
                },
                cx,
            );
            return self.renamed(doc_id, from, to, RenameBack::Names(undo), cx);
        }
        let (line, undo_line) = match speaker {
            SpeakerRef::Source(source) => {
                let before = self
                    .transcript(doc_id)
                    .and_then(|t| t.speaker_label_for_source(source).map(str::to_string));
                (
                    LogLine::SourceLabel {
                        source,
                        label: Some(to.clone()).filter(|l| !l.is_empty()),
                    },
                    LogLine::SourceLabel {
                        source,
                        label: before,
                    },
                )
            }
            SpeakerRef::Named(from) => (
                LogLine::RenameSpeaker {
                    from: from.clone(),
                    to: to.clone(),
                },
                LogLine::RenameSpeaker {
                    from: to.clone(),
                    to: from,
                },
            ),
            SpeakerRef::Id(_) => return None,
        };
        self.edit_transcript(doc_id, line, cx);
        self.renamed(doc_id, from, to, RenameBack::Line(undo_line), cx)
    }

    fn renamed(
        &mut self,
        doc_id: &str,
        from: Option<String>,
        to: String,
        back: RenameBack,
        cx: &mut Context<Self>,
    ) -> Option<RenameUndo> {
        let from = from.filter(|f| !f.is_empty() && *f != to && !to.is_empty())?;
        cx.emit(MeetingEvent::SpeakerRenamed {
            doc_id: doc_id.to_string(),
            from: from.clone(),
            to: to.clone(),
        });
        Some(RenameUndo { back, from, to })
    }

    /// "Just this line": these lines were said by `to`, without renaming the
    /// voice they were heard as. Returns the lines as they were, for undo.
    pub fn reassign_lines(
        &mut self,
        doc_id: &str,
        ids: &[String],
        to: &str,
        cx: &mut Context<Self>,
    ) -> Option<Vec<LogLine>> {
        let to = to.trim().to_string();
        if to.is_empty() {
            return None;
        }
        let before: Vec<Utterance> = {
            let transcript = self.transcript(doc_id)?;
            ids.iter()
                .filter_map(|id| transcript.get(id).cloned())
                .filter(|u| u.speaker.as_deref() != Some(to.as_str()))
                .collect()
        };
        if before.is_empty() {
            return None;
        }
        for utterance in &before {
            let mut moved = utterance.clone();
            moved.speaker = Some(to.clone());
            self.edit_transcript(doc_id, LogLine::Upsert { utterance: moved }, cx);
        }
        Some(
            before
                .into_iter()
                .map(|utterance| LogLine::Upsert { utterance })
                .collect(),
        )
    }

    /// Puts back lines [`Self::reassign_lines`] moved.
    pub fn restore_lines(&mut self, doc_id: &str, lines: Vec<LogLine>, cx: &mut Context<Self>) {
        for line in lines {
            self.edit_transcript(doc_id, line, cx);
        }
    }

    /// Applies a change to the meeting's latest transcript and keeps the line
    /// it makes: in memory while the meeting records or finishes, else on
    /// the documents writer after every edit already queued, so two quick
    /// changes never undo each other. A summary written under other choices
    /// on who is left out is then offered for an update.
    fn rewrite_transcript(
        &mut self,
        doc_id: &str,
        change: impl FnOnce(&Transcript) -> Option<LogLine> + Send + 'static,
        cx: &mut Context<Self>,
    ) {
        let library = self.library().cloned();
        let live = self
            .recording
            .as_ref()
            .filter(|r| r.doc_id == doc_id)
            .map(|r| &r.transcript)
            .or_else(|| {
                self.finishing
                    .iter()
                    .find(|f| f.doc_id == doc_id)
                    .map(|f| &f.transcript)
            });
        if let Some(transcript) = live {
            let Some(line) = change(transcript) else {
                return;
            };
            self.edit_transcript(doc_id, line, cx);
            if let (Some(library), Some(transcript)) = (library, self.transcript(doc_id))
                && persist::follow_left_out(&library, doc_id, &transcript)
            {
                cx.emit(MeetingEvent::LibraryChanged);
            }
            return;
        }
        let Some(library) = library else {
            return;
        };
        let Ok(path) = library.transcript_path(doc_id) else {
            return;
        };
        let doc = doc_id.to_string();
        let (written, done) = flume::bounded(1);
        crate::meetings_ui::documents::queue_after_saves(move || {
            let notes_changed = (|| {
                let mut transcript = Transcript::load_jsonl(&path)
                    .map(|(t, _)| t)
                    .unwrap_or_default();
                let line = change(&transcript)?;
                if let Err(error) = append_jsonl(&path, std::slice::from_ref(&line)) {
                    tracing::warn!(%error, "could not edit the meeting transcript");
                    return None;
                }
                transcript.apply(line);
                Some(persist::follow_left_out(&library, &doc, &transcript))
            })();
            let _ = written.send(notes_changed.unwrap_or(false));
        });
        // Announced once the queued write is on disk, so a view that reloads
        // the file sees the change.
        let doc_id = doc_id.to_string();
        cx.spawn(async move |this, cx| {
            let notes_changed = done.recv_async().await.unwrap_or(false);
            this.update(cx, |_, cx| {
                cx.emit(MeetingEvent::TranscriptChanged { doc_id });
                if notes_changed {
                    cx.emit(MeetingEvent::LibraryChanged);
                }
            })
            .ok();
        })
        .detach();
    }

    /// Tells the windows a note changed once a job on the documents writer
    /// says it did.
    fn library_changed_when(changed: flume::Receiver<bool>, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            if changed.recv_async().await.unwrap_or(false) {
                this.update(cx, |_, cx| cx.emit(MeetingEvent::LibraryChanged))
                    .ok();
            }
        })
        .detach();
    }

    /// Notes were just written with the lines left out when they started. A
    /// choice made while they were written (already saved, or still queued on
    /// the documents writer) leaves them offered for an update, and Ask stops
    /// using them.
    fn notes_follow_left_out(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let Some(library) = self.library().cloned() else {
            return;
        };
        if let Some((transcript, _)) = self.live_transcript(doc_id) {
            if persist::follow_left_out(&library, doc_id, transcript) {
                cx.emit(MeetingEvent::LibraryChanged);
            }
            return;
        }
        let Ok(path) = library.transcript_path(doc_id) else {
            return;
        };
        let doc = doc_id.to_string();
        let (changed, note) = flume::bounded(1);
        crate::meetings_ui::documents::queue_after_saves(move || {
            let transcript = Transcript::load_jsonl(&path)
                .map(|(t, _)| t)
                .unwrap_or_default();
            let _ = changed.send(persist::follow_left_out(&library, &doc, &transcript));
        });
        Self::library_changed_when(note, cx);
    }

    /// Makes a choice on a voice, if it changes anything in what is known
    /// now, and returns its undo.
    fn choose_for_voice(
        &mut self,
        doc_id: &str,
        choice: VoiceChoice,
        cx: &mut Context<Self>,
    ) -> Option<ChoiceUndo> {
        let attendee = self
            .library()
            .and_then(|l| l.load(doc_id).ok())
            .and_then(|meta| speakers::other_attendee(&meta));
        choice.apply(&*self.transcript(doc_id)?, attendee.clone())?;
        let undo = ChoiceUndo::default();
        let taken = undo.clone();
        self.rewrite_transcript(
            doc_id,
            move |transcript| {
                let (line, change) = choice.apply(transcript, attendee)?;
                *taken.lock() = Some(change);
                Some(line)
            },
            cx,
        );
        Some(undo)
    }

    /// "Leave this voice out of the notes" (or back in): the lines stay in
    /// the transcript; the next summary and Ask leave them out. Returns its
    /// undo.
    pub fn leave_out_speaker(
        &mut self,
        doc_id: &str,
        speaker: SpeakerRef,
        out: bool,
        cx: &mut Context<Self>,
    ) -> Option<ChoiceUndo> {
        use cap_meetings::transcript::Voice;
        let choice = match speaker {
            SpeakerRef::Id(id) => VoiceChoice::LeaveOutId(id, out),
            SpeakerRef::Named(name) => VoiceChoice::LeaveOut(Voice::Named(name), out),
            SpeakerRef::Source(source) => VoiceChoice::LeaveOut(Voice::Source(source), out),
        };
        self.choose_for_voice(doc_id, choice, cx)
    }

    /// "That's not me" on the voice shown as the user: it becomes someone
    /// else (the next "Person n"), here only. The saved voice profile is
    /// never changed, and this meeting never teaches it this voice.
    /// `not_me == false` is "That's me", which takes it back. Returns its
    /// undo.
    pub fn set_not_me(
        &mut self,
        doc_id: &str,
        id: u32,
        not_me: bool,
        cx: &mut Context<Self>,
    ) -> Option<ChoiceUndo> {
        self.choose_for_voice(doc_id, VoiceChoice::NotMe(id, not_me), cx)
    }

    /// Takes back a choice `leave_out_speaker` or `set_not_me` made, and
    /// only that: a choice made since on another voice stays.
    pub fn undo_speaker_choice(&mut self, doc_id: &str, undo: ChoiceUndo, cx: &mut Context<Self>) {
        self.rewrite_transcript(
            doc_id,
            move |transcript| undo.lock().take()?.undo(transcript),
            cx,
        );
    }

    /// Put a rename back: the transcript's names as they were, and the
    /// summary's name back to the label it had.
    pub fn undo_rename(&mut self, doc_id: &str, undo: RenameUndo, cx: &mut Context<Self>) {
        match undo.back {
            RenameBack::Line(line) => self.edit_transcript(doc_id, line, cx),
            RenameBack::Names(names) => self.undo_speaker_choice(doc_id, names, cx),
        }
        cx.emit(MeetingEvent::SpeakerRenamed {
            doc_id: doc_id.to_string(),
            from: undo.to,
            to: undo.from,
        });
    }

    /// The label a speaker has in prompts, exports and the summary today.
    pub fn speaker_label(&mut self, doc_id: &str, speaker: &SpeakerRef) -> Option<String> {
        let self_name = self
            .library()
            .and_then(|l| l.load(doc_id).ok())
            .and_then(|meta| Self::self_name(&meta));
        let transcript = self.transcript(doc_id)?;
        let label = match speaker {
            SpeakerRef::Named(name) => return Some(name.clone()),
            SpeakerRef::Id(id) => transcript.speaker(Source::System, None, Some(*id)),
            SpeakerRef::Source(source) => transcript.speaker(*source, None, None),
        };
        Some(label.english(self_name.as_deref()))
    }

    fn voices_config(
        &mut self,
        transcript: &Transcript,
        cx: &mut Context<Self>,
    ) -> Option<voices::VoicesConfig> {
        if !speakers::supported() {
            return None;
        }
        if !speakers::ensure_model(&gpui_tokio::Tokio::handle(cx)) {
            tracing::info!("the speaker model is not here yet, voices stay together this time");
            return None;
        }
        let path = speakers::model_path();
        Some(voices::VoicesConfig {
            load: Box::new(move || speakers::load_embedder(&path)),
            profile: speakers::load_profile(),
            id_offset: transcript.max_speaker_id(),
            prior_user: transcript.names().and_then(|n| n.user()).map(|id| id.0),
        })
    }

    fn live_voices_mut(&mut self, doc_id: &str) -> Option<&mut LiveVoices> {
        if let Some(r) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
            return Some(&mut r.voices);
        }
        self.finishing
            .iter_mut()
            .find(|f| f.doc_id == doc_id)
            .map(|f| &mut f.voices)
    }

    fn live_transcript(&self, doc_id: &str) -> Option<(&Transcript, &LiveVoices)> {
        if let Some(r) = self.recording.as_ref().filter(|r| r.doc_id == doc_id) {
            return Some((&r.transcript, &r.voices));
        }
        self.finishing
            .iter()
            .find(|f| f.doc_id == doc_id)
            .map(|f| (&f.transcript, &f.voices))
    }

    /// Numbers the voices that have said something, in order of their first
    /// words, so a voice made only of music or noise never takes a number.
    fn observe_voices(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        let Some((transcript, voices)) = self.live_transcript(doc_id) else {
            return;
        };
        let speaking = transcript.speaking_ids();
        let heard: Vec<cap_diarize::SpeakerInfo> = voices
            .speakers
            .iter()
            .filter(|s| speaking.contains(&s.id.0))
            .cloned()
            .collect();
        let before = transcript.names().cloned();
        let mut names = before
            .clone()
            .unwrap_or_else(|| cap_diarize::SpeakerNames::new(voices.attendee.clone()));
        names.observe_speaking_keeping(&heard, &speaking);
        if before.as_ref() != Some(&names) {
            self.edit_voices(doc_id, vec![LogLine::SpeakerNames { names }], cx);
        }
    }

    fn apply_final_voices(
        &mut self,
        doc_id: &str,
        final_voices: voices::FinalVoices,
        cx: &mut Context<Self>,
    ) {
        let voices::FinalVoices { assign, mut pass } = final_voices;
        // A voice the person said was not them is never learnt as theirs.
        let disowned = pass.user.is_some_and(|user| {
            self.live_transcript(doc_id)
                .and_then(|(t, _)| t.names().map(|n| n.disowns(user, &pass.merged)))
                .unwrap_or(false)
        });
        if disowned {
            tracing::info!("not learning the voice: the person said it was not them");
        }
        if let Some(enrolment) = pass.enrolment.take()
            && self.settings.transcription.learn_voice
            && !disowned
        {
            cx.background_executor()
                .spawn(async move {
                    match speakers::save_enrolment(&enrolment) {
                        Ok(profile) => tracing::info!(
                            meetings = profile.meetings,
                            "learnt the user's voice from this meeting"
                        ),
                        Err(error) => tracing::warn!(%error, "could not save the voice profile"),
                    }
                })
                .detach();
        }
        let Some((transcript, voices)) = self.live_transcript(doc_id) else {
            return;
        };
        let mut relabelled = transcript.clone();
        relabelled.assign_speakers(&assign);
        pass.speakers = speakers_with_lines(&pass.speakers, &relabelled);
        if pass.user.is_none() {
            pass.user = transcript.names().and_then(|n| n.user());
        }
        let mut names = transcript
            .names()
            .cloned()
            .unwrap_or_else(|| cap_diarize::SpeakerNames::new(voices.attendee.clone()));
        let changes = names.apply_final(&pass);
        let active = voices.active.clone();
        let app_self = voices.app_self.clone();
        let library = self.library().cloned();
        // Names people said ("I'm Kristen") or the calendar makes certain go
        // in now, before the summary is written, so it uses them.
        let mut named = 0;
        let mut offered: Vec<(u32, String)> = Vec::new();
        // The meeting app's own speaker highlight, lined up with the voices
        // from the computer's audio, comes first.
        let spans: Vec<cap_meetings::active::VoiceSpan> = relabelled
            .utterances()
            .iter()
            .filter(|u| u.source == Source::System && u.is_final)
            .filter_map(|u| {
                Some(cap_meetings::active::VoiceSpan {
                    speaker: u.speaker_id?,
                    start_ms: u.start_ms,
                    end_ms: u.end_ms,
                })
            })
            .collect();
        let from_app = cap_meetings::active::align(
            &active,
            &spans,
            app_self.as_deref(),
            &cap_meetings::active::Gates::default(),
        );
        let numbered = |names: &cap_diarize::SpeakerNames, id: u32| {
            matches!(
                names.label(cap_diarize::SpeakerId(id)),
                Some(cap_diarize::Label::Person(_))
            )
        };
        for m in &from_app {
            if !numbered(&names, m.speaker) {
                continue;
            }
            if m.certainty == cap_meetings::names::Certainty::Confident {
                names.rename(cap_diarize::SpeakerId(m.speaker), &m.name);
                named += 1;
            } else {
                offered.push((m.speaker, m.name.clone()));
            }
        }
        // Then names said in the meeting and the calendar, for voices the
        // app did not name and never against what the app showed.
        if let Some(meta) = library.as_ref().and_then(|l| l.load(doc_id).ok()) {
            let mut finished = relabelled.clone();
            finished.set_names(names.clone());
            for (id, name, certainty) in speakers::name_guesses(&finished, &meta) {
                let app_says = from_app.iter().find(|m| m.speaker == id).map(|m| &m.name);
                if app_says.is_some_and(|n| !n.eq_ignore_ascii_case(&name)) {
                    continue;
                }
                if certainty == cap_meetings::names::Certainty::Confident && numbered(&names, id) {
                    names.rename(cap_diarize::SpeakerId(id), &name);
                    named += 1;
                }
            }
            if !offered.is_empty() {
                speakers::remember_suggestions(doc_id, &offered, library.as_ref());
            }
        }
        tracing::info!(
            relabelled = assign.len(),
            voices = pass.speakers.len(),
            renamed = changes.len(),
            named,
            from_app = from_app.len(),
            app_samples = active.len(),
            "final pass over the meeting's voices"
        );
        let mut lines = Vec::new();
        if !assign.is_empty() {
            lines.push(LogLine::Speakers { assign });
        }
        lines.push(LogLine::SpeakerNames { names });
        self.edit_voices(doc_id, lines, cx);
    }

    /// Nemotron's after-Stop correction. The meeting is finished (and maybe summarised) by now, so only
    /// lines still on the voice the final pass gave them move, renames stay,
    /// and nobody is renumbered.
    fn apply_late_voices(&mut self, doc_id: &str, late: voices::LateResult, cx: &mut Context<Self>) {
        // a meeting resumed in the meantime: its own final pass decides
        if self.live_transcript(doc_id).is_some() {
            tracing::info!(doc_id, "Nemotron after Stop: the meeting resumed, its own final pass decides");
            return;
        }
        let Some(library) = self.library().cloned() else {
            return;
        };
        // On the documents writer after every edit already queued: the labels
        // land on the latest names, so a rename or voice choice made while
        // Nemotron ran stays, and edits queued after build on them.
        let doc = doc_id.to_string();
        let (done, labelled) = flume::bounded(1);
        {
            let doc = doc.clone();
            crate::meetings_ui::documents::queue_after_saves(move || {
                let _ = done.send(late_labels(&library, &doc, late));
            });
        }
        cx.spawn(async move |this, cx| {
            let Ok(Some(renames)) = labelled.recv_async().await else {
                return;
            };
            this.update(cx, |this, cx| {
                this.dirty_transcripts.insert(doc.clone());
                this.schedule_notify(cx);
                this.follow_late_renames(&doc, renames, cx);
            })
            .ok();
        })
        .detach();
    }

    /// A summary written before a late speaker correction names the voices
    /// it merged away: only those labels change, in the saved summary and in
    /// an open notes pane (the rename-follow path); the summary is never
    /// written again. A summary still being written takes them when it is
    /// done.
    fn follow_late_renames(
        &mut self,
        doc_id: &str,
        renames: Vec<(String, String)>,
        cx: &mut Context<Self>,
    ) {
        if renames.is_empty() {
            return;
        }
        if self.notes.get(doc_id).is_some_and(|notes| notes.running) {
            self.late_summary_renames
                .entry(doc_id.to_string())
                .or_default()
                .extend(renames);
            return;
        }
        if let Some(library) = self.library().cloned() {
            // Read, renamed and written on the documents writer, after any
            // edit to the summary still queued there, so that edit is kept.
            let doc = doc_id.to_string();
            let summary_renames = renames.clone();
            crate::meetings_ui::documents::queue_after_saves(move || {
                if let Ok(Some(json)) = library.read_enhanced(&doc)
                    && let Some(renamed) = rename_in_saved_summary(&json, &summary_renames)
                    && let Err(error) = library.write_enhanced(&doc, &renamed)
                {
                    tracing::warn!(%error, doc_id = doc, "could not follow the late speaker labels in the summary");
                }
            });
        }
        if !renames.is_empty() {
            tracing::info!(
                doc_id,
                count = renames.len(),
                "the summary follows Nemotron's after-Stop labels"
            );
        }
        for (from, to) in renames {
            cx.emit(MeetingEvent::SpeakerRenamed {
                doc_id: doc_id.to_string(),
                from,
                to,
            });
        }
    }

    fn edit_voices(&mut self, doc_id: &str, lines: Vec<LogLine>, cx: &mut Context<Self>) {
        let target = if let Some(r) = self.recording.as_mut().filter(|r| r.doc_id == doc_id) {
            Some((&mut r.transcript, &r.engine))
        } else {
            self.finishing
                .iter_mut()
                .find(|f| f.doc_id == doc_id)
                .map(|f| (&mut f.transcript, &f.engine))
        };
        let Some((transcript, engine)) = target else {
            return;
        };
        for line in &lines {
            transcript.apply(line.clone());
        }
        if let Err(EngineCommand::Append(lines)) = engine.send(EngineCommand::Append(lines)) {
            self.append_direct(doc_id, lines);
        }
        self.dirty_transcripts.insert(doc_id.to_string());
        self.schedule_notify(cx);
    }

    /// A computer too slow for live captions: someone is speaking and the
    /// live view has shown nothing new for a while, so it says lines come
    /// after each sentence here (see [`listening_cue`]).
    pub fn listening_cue(&self) -> bool {
        self.recording.as_ref().is_some_and(|r| {
            listening_cue(
                device::slow(),
                Instant::now(),
                r.started,
                r.voice_at,
                r.line_at,
            )
        })
    }

    fn mark_active(&mut self, cx: &mut Context<Self>) {
        self.dirty_active = true;
        self.schedule_notify(cx);
    }

    fn schedule_notify(&mut self, cx: &mut Context<Self>) {
        if self.notify_due.is_none() {
            self.notify_due = Some(self.now().plus(NOTIFY_INTERVAL_MS));
            self.rearm(cx);
        }
    }

    fn flush_notify(&mut self, cx: &mut Context<Self>) {
        self.notify_due = None;
        if std::mem::take(&mut self.dirty_active) {
            cx.emit(MeetingEvent::ActiveChanged);
        }
        for doc_id in std::mem::take(&mut self.dirty_transcripts) {
            cx.emit(MeetingEvent::TranscriptChanged { doc_id });
        }
        cx.notify();
    }

    fn rearm(&mut self, cx: &mut Context<Self>) {
        let deadline = [
            self.detector.next_deadline(),
            self.planner.next_deadline(),
            self.session.next_deadline(),
            self.calendar_next,
            self.notify_due,
        ]
        .into_iter()
        .flatten()
        .min();
        let Some(at) = deadline else {
            self.timer = None;
            return;
        };
        if self.timer.as_ref().is_some_and(|(armed, _)| *armed == at) {
            return;
        }
        let delay = Duration::from_millis(at.since(self.now()));
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| this.on_timer(cx)).ok();
        });
        self.timer = Some((at, task));
    }

    fn on_timer(&mut self, cx: &mut Context<Self>) {
        self.timer = None;
        let now = self.now();
        let events = self.detector.tick(now);
        self.handle_detect_events(events, cx);
        let actions = self.planner.tick(self.now_pair());
        self.apply_prompt_actions(actions, cx);
        let actions = self.session.tick(now);
        self.apply_session_actions(actions, cx);
        if self
            .active
            .as_ref()
            .is_some_and(|a| a.state == ActiveState::ResumeOffered)
            && self.session.resume_offer_until().is_none()
        {
            self.active = None;
            self.mark_active(cx);
        }
        self.settle_sleep_kept(cx);
        if self.calendar_next.is_some_and(|at| at <= now) {
            self.calendar_next = None;
            self.refresh_calendar(cx);
        }
        if self.notify_due.is_some_and(|at| at <= self.now()) {
            self.flush_notify(cx);
        }
        self.rearm(cx);
    }

    pub fn system_will_sleep(cx: &mut App) {
        if let Some(this) = Self::try_global(cx) {
            this.update(cx, |this, cx| {
                this.wake_look = None;
                this.resuming_after_sleep = false;
                let actions = this.session.on_sleep(this.now());
                this.apply_session_actions(actions, cx);
                this.rearm(cx);
            });
        }
    }

    pub fn system_did_wake(cx: &mut App) {
        if let Some(this) = Self::try_global(cx) {
            this.update(cx, |this, cx| {
                if this.session.offers_resume_on_wake()
                    && let Some(end) = this.offered_event_end()
                {
                    this.session.set_linked_event_end(Some(this.millis_at(end)));
                }
                let actions = this.session.on_wake(this.now());
                this.apply_session_actions(actions, cx);
                this.look_for_call_after_wake(cx);
                if this.settings.enabled {
                    this.refresh_calendar(cx);
                }
                this.rearm(cx);
            });
        }
    }

    /// A note kept for a sleep's Resume that did not come goes to Trash as
    /// any note that heard nothing does.
    fn settle_sleep_kept(&mut self, cx: &mut Context<Self>) {
        if self.session.resume_may_follow() || self.recording.is_some() {
            return;
        }
        let Some(doc_id) = self.sleep_kept.take() else {
            return;
        };
        let Some(library) = self.library().cloned() else {
            return;
        };
        let (lock, meta) = (lock_meta(), library.load(&doc_id));
        drop(lock);
        let Ok(meta) = meta else {
            return;
        };
        let chars = meta
            .meeting
            .as_ref()
            .map_or(0, |m| m.transcript_chars as usize);
        if false_start(&library, &meta, chars) {
            match library.trash(&doc_id, Utc::now()) {
                Ok(_) => tracing::info!(doc_id, "a meeting note that heard nothing went to Trash"),
                Err(error) => tracing::warn!(%error, "could not trash an empty meeting note"),
            }
            cx.emit(MeetingEvent::LibraryChanged);
        }
    }

    /// When the calendar event of the meeting a sleep stopped ends.
    fn offered_event_end(&mut self) -> Option<DateTime<Utc>> {
        let (doc_id, event_id) = self
            .active
            .as_ref()
            .map(|a| (a.doc_id.clone(), a.event_id.clone()))?;
        let id = event_id.or_else(|| {
            let meta = self.library()?.load(&doc_id).ok()?;
            meta.meeting?.event.map(|event| event.id)
        })?;
        self.calendar.find(&id).map(|event| event.end)
    }

    /// A sleep stopped the meeting while its call was on: a few looks at
    /// the microphone just after the wake tell whether the call went on.
    fn look_for_call_after_wake(&mut self, cx: &mut Context<Self>) {
        self.wake_look = None;
        let Some(app_id) = self
            .session
            .call_to_look_for_after_wake(self.now())
            .map(str::to_owned)
        else {
            return;
        };
        self.wake_look = Some(cx.spawn(async move |this, cx| {
            for wait in WAKE_LOOKS {
                cx.background_executor().timer(wait).await;
                let snapshot = cx
                    .background_executor()
                    .spawn(async { cap_meeting_platform::snapshot_now() })
                    .await;
                match this.update(cx, |this, cx| this.on_wake_look(&app_id, &snapshot, cx)) {
                    Ok(false) => {}
                    _ => return,
                }
            }
            tracing::info!(app_id, "the meeting's call was not on the microphone after the wake");
        }));
    }

    /// One look after a wake; true once there is nothing left to look for.
    fn on_wake_look(
        &mut self,
        app_id: &str,
        snapshot: &MicSnapshot,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.session.call_to_look_for_after_wake(self.now()) != Some(app_id) {
            return true;
        }
        let clients: Vec<MicClient> = snapshot
            .clients
            .iter()
            .map(|c| MicClient {
                platform_id: c.id.clone(),
                pid: c.pid,
                device_uid: c.device_uid.clone(),
                device_uids: c.device_uids.clone(),
            })
            .collect();
        if !snapshot.attributed || !self.detector.holds_mic(app_id, &clients) {
            return false;
        }
        tracing::info!(app_id, "the call went on through the sleep: resuming the meeting");
        self.resuming_after_sleep = true;
        let actions = self.session.call_still_on_after_wake(self.now());
        self.apply_session_actions(actions, cx);
        self.rearm(cx);
        true
    }

    fn on_quit(&mut self, cx: &mut Context<Self>) {
        if self.recording.is_some() {
            let actions = self.session.stop(self.now(), StopReason::Quit);
            self.apply_session_actions(actions, cx);
        }
        let deadline = Instant::now() + QUIT_DRAIN;
        let library = self.library().cloned();
        let min_chars = self.settings.session_config().min_transcript_chars;
        let mut unwritten = Vec::new();
        for finishing in self.finishing.drain(..) {
            let wait = deadline.saturating_duration_since(Instant::now());
            let finished = finishing.engine.join_timeout(wait);
            if let Some(library) = library.as_ref()
                && let Ok(path) = library.transcript_path(&finishing.doc_id)
                && let Ok((transcript, _)) = Transcript::load_jsonl(&path)
                && let (_lock, Ok(mut meta)) = (lock_meta(), library.load(&finishing.doc_id))
            {
                // Whatever the drain did not reach is finished next launch.
                let open = !finished
                    || !persist::repairable(transcript.gaps(), &persist::audio_parts(library, &meta))
                        .is_empty();
                if open {
                    tracing::warn!(doc_id = finishing.doc_id, finished, "quitting before a meeting's transcript was finished");
                }
                persist::set_flag(&mut meta, persist::REPAIR_KEY, open);
                let Some(meeting) = meta.meeting.as_mut() else {
                    continue;
                };
                let chars = transcript.stats().total_chars;
                meeting.transcript_chars = chars as u64;
                if self.settings.notes.auto_generate
                    && !meeting.has_enhanced
                    && (finishing.generate_notes || chars >= min_chars)
                {
                    unwritten.push(finishing.doc_id.clone());
                }
                let _ = library.save(&meta);
            }
        }
        unwritten.extend(self.auto_notes.keys().cloned());
        self.remember_unwritten(unwritten);
    }

    /// Empties trash older than 30 days and applies "Keep audio for", at
    /// launch once recovery is done and every few hours after.
    fn start_library_cleanup(&mut self, cx: &mut Context<Self>) {
        let opened = self.opened_here.clone();
        self.library_cleanup = Some(cx.spawn(async move |this, cx| {
            let mut wait = CLEANUP_FIRST;
            loop {
                cx.background_executor().timer(wait).await;
                let Ok(plan) = this.update(cx, |this, cx| {
                    let open = crate::meetings_ui::documents::open_doc_ids(cx);
                    this.cleanup_plan(open)
                }) else {
                    return;
                };
                wait = match plan {
                    CleanupPlan::Later => CLEANUP_FIRST,
                    CleanupPlan::Run { audio_days, busy } => {
                        let dir = persist::documents_dir();
                        let opened = opened.clone();
                        let changed = crate::meetings_ui::documents::after_queued_saves(move || {
                            if !dir.is_dir() {
                                return (Vec::new(), Vec::new());
                            }
                            let Ok(library) = Library::open(dir) else {
                                return (Vec::new(), Vec::new());
                            };
                            let now = Utc::now();
                            let mut busy = busy;
                            busy.extend(access::unwritten_ids());
                            let purged = persist::purge_old_trash(&library, now, &busy, &opened);
                            let swept = audio_days
                                .map(|days| persist::sweep_old_audio(&library, now, days, &busy, &opened))
                                .unwrap_or_default();
                            (purged, swept)
                        })
                        .await;
                        let (purged, swept) = changed.unwrap_or_default();
                        if !purged.is_empty() {
                            tracing::info!(
                                count = purged.len(),
                                "emptied trash older than 30 days"
                            );
                        }
                        if !swept.is_empty() {
                            tracing::info!(
                                count = swept.len(),
                                "deleted meeting audio older than the keep setting"
                            );
                        }
                        if (!purged.is_empty() || !swept.is_empty())
                            && this
                                .update(cx, |_, cx| cx.emit(MeetingEvent::LibraryChanged))
                                .is_err()
                        {
                            return;
                        }
                        CLEANUP_EVERY
                    }
                };
            }
        }));
    }

    fn cleanup_plan(&self, open: Vec<String>) -> CleanupPlan {
        if self.recovery.is_some() {
            return CleanupPlan::Later;
        }
        let busy = self
            .recording
            .iter()
            .map(|r| r.doc_id.clone())
            .chain(self.finishing.iter().map(|f| f.doc_id.clone()))
            .chain(self.repair_queue.iter().cloned())
            .chain(self.session_doc.iter().cloned())
            .chain(self.resume_doc.iter().cloned())
            .chain(
                self.notes
                    .iter()
                    .filter(|(_, state)| state.running || state.waiting)
                    .map(|(id, _)| id.clone()),
            )
            .chain(self.auto_notes.keys().cloned())
            .chain(self.ai.waiting_ids().iter().cloned())
            .chain(open)
            .collect();
        CleanupPlan::Run {
            audio_days: self.settings.recording.audio_retention_days,
            busy,
        }
    }

    fn start_recovery(&mut self, cx: &mut Context<Self>) {
        let dir = persist::documents_dir();
        if !dir.is_dir() {
            return;
        }
        let opened = self.opened_here.clone();
        self.recovery = Some(cx.spawn(async move |this, cx| {
            let recovered = cx
                .background_executor()
                .spawn(async move {
                    Library::open(dir)
                        .map(|library| {
                            let recovered = persist::recover_unfinished(&library, &opened);
                            let pending = persist::pending_repairs(&library);
                            // Scratch copies only a pending repair still needs.
                            let removed = persist::drop_stale_scratch_in(&persist::scratch_root(), |id| {
                                pending.iter().any(|p| persist::scratch_dir_in(std::path::Path::new(""), p).as_os_str() == id)
                            });
                            if !removed.is_empty() {
                                tracing::info!(count = removed.len(), "deleted scratch audio nothing needs any more");
                            }
                            (recovered, pending)
                        })
                        .unwrap_or_default()
                })
                .await;
            let (recovered, pending) = recovered;
            this.update(cx, |this, cx| {
                this.recovery = None;
                if !recovered.is_empty() {
                    tracing::info!(count = recovered.len(), "recovered unfinished meetings");
                    cx.emit(MeetingEvent::LibraryChanged);
                }
                for doc_id in pending {
                    if !this.repair_queue.contains(&doc_id) {
                        this.repair_queue.push_back(doc_id);
                    }
                }
                this.next_repair(cx);
            })
            .ok();
        }));
    }

    fn push_calendar_to_planner(&mut self, cx: &mut Context<Self>) {
        let events = self.calendar.planner_events(&self.settings.calendar);
        let actions = self.planner.set_events(self.now_pair(), events);
        self.apply_prompt_actions(actions, cx);
    }

    pub fn calendar_sources(&self) -> &[CalendarSource] {
        &self.calendar.sources
    }

    pub fn events(&self) -> &[CalendarEvent] {
        self.calendar.events()
    }

    pub fn find_event(&self, key: &str) -> Option<&CalendarEvent> {
        self.calendar.find(key)
    }

    pub fn agenda(&self) -> Agenda {
        self.calendar
            .agenda(&calendar::filter_for(&self.settings.calendar))
    }

    pub fn current_events(&self, now: DateTime<Utc>) -> Vec<CalendarEvent> {
        self.agenda().current(now).into_iter().cloned().collect()
    }

    pub fn next_event(&self, now: DateTime<Utc>) -> Option<CalendarEvent> {
        self.agenda().next(now).cloned()
    }

    pub fn upcoming_events(
        &self,
        now: DateTime<Utc>,
        horizon: chrono::Duration,
    ) -> Vec<CalendarEvent> {
        self.agenda()
            .upcoming(now, horizon)
            .into_iter()
            .cloned()
            .collect()
    }

    pub fn add_calendar_feed(
        &mut self,
        url: &str,
        name: Option<String>,
        cx: &mut Context<Self>,
    ) -> Result<String, CalendarError> {
        self.calendar.ensure_loaded();
        let id = self.calendar.add_ics(url, name)?;
        cx.emit(MeetingEvent::CalendarChanged);
        self.calendar_task = None;
        self.sync_calendars(cx);
        Ok(id)
    }

    pub fn add_system_calendar(&mut self, cx: &mut Context<Self>) -> Result<String, CalendarError> {
        self.calendar.ensure_loaded();
        let id = self.calendar.add_system()?;
        cx.emit(MeetingEvent::CalendarChanged);
        self.calendar_task = None;
        self.sync_calendars(cx);
        self.sync_calendar_watch(cx);
        Ok(id)
    }

    pub fn calendar_connect_state(&self) -> accounts::ConnectState {
        self.calendar_connect
    }

    pub fn connect_calendar_account(
        &mut self,
        provider: accounts::Provider,
        cx: &mut Context<Self>,
    ) {
        if self.calendar_connect.busy().is_some() {
            return;
        }
        let pending = match accounts::Pending::new(provider) {
            Ok(pending) => pending,
            Err(error) => {
                self.calendar_connect = accounts::ConnectState::Failed(provider, error);
                cx.emit(MeetingEvent::CalendarChanged);
                return;
            }
        };
        cx.open_url(&pending.authorize_url);
        self.calendar_connect = accounts::ConnectState::WaitingForBrowser(provider);
        self.calendar_connect_cancel = Some(pending.cancel.clone());
        self.calendar_connect_task = Some(cx.spawn(async move |this, cx| {
            let result = gpui_tokio::Tokio::spawn(cx, pending.finish()).await;
            this.update(cx, |this, cx| {
                this.calendar_connect_task = None;
                this.calendar_connect_cancel = None;
                let outcome = match result {
                    Ok(outcome) => outcome,
                    Err(_) => Err(accounts::ConnectError::Rejected),
                };
                this.calendar_connect = match outcome {
                    Ok(connected) => {
                        this.calendar.ensure_loaded();
                        match this.calendar.add_account(
                            connected.provider,
                            &connected.email,
                            &connected.refresh_token,
                        ) {
                            Ok(_) => {
                                this.calendar_task = None;
                                this.sync_calendars(cx);
                                accounts::ConnectState::Idle
                            }
                            Err(error) => {
                                tracing::warn!(%error, "could not save the calendar account");
                                accounts::ConnectState::Failed(
                                    provider,
                                    accounts::ConnectError::Rejected,
                                )
                            }
                        }
                    }
                    Err(accounts::ConnectError::Cancelled) => accounts::ConnectState::Idle,
                    Err(error) => accounts::ConnectState::Failed(provider, error),
                };
                cx.emit(MeetingEvent::CalendarChanged);
            })
            .ok();
        }));
        cx.emit(MeetingEvent::CalendarChanged);
    }

    pub fn cancel_calendar_connect(&mut self, cx: &mut Context<Self>) {
        if let Some(cancel) = self.calendar_connect_cancel.take() {
            cancel.cancel();
        }
        self.calendar_connect_task = None;
        if self.calendar_connect != accounts::ConnectState::Idle {
            self.calendar_connect = accounts::ConnectState::Idle;
            cx.emit(MeetingEvent::CalendarChanged);
        }
    }

    pub fn calendar_access_changed(&mut self, cx: &mut Context<Self>) {
        self.calendar.ensure_loaded();
        if self.calendar.has_system() {
            self.sync_calendar_watch(cx);
            self.sync_calendars(cx);
        }
    }

    pub fn load_calendars(&mut self, cx: &mut Context<Self>) {
        if self.calendar.sources.is_empty() {
            self.calendar.ensure_loaded();
            if !self.calendar.sources.is_empty() {
                cx.emit(MeetingEvent::CalendarChanged);
            }
        }
    }

    pub fn calendar_syncing(&self) -> bool {
        self.calendar_task.is_some()
    }

    pub fn upcoming_count(&self, source_id: &str) -> usize {
        self.calendar.upcoming_count(
            source_id,
            &calendar::filter_for(&self.settings.calendar),
            Utc::now(),
        )
    }

    fn sync_calendar_watch(&mut self, cx: &mut Context<Self>) {
        let want = self.calendar_active
            && self.calendar.has_system()
            && cap_meeting_platform::calendar_access()
                == cap_meeting_platform::CalendarAccess::Granted;
        if want == self.calendar_watch.is_some() {
            return;
        }
        if !want {
            self.calendar_watch = None;
            return;
        }
        let (tx, rx) = flume::unbounded::<()>();
        let Some(watcher) = cap_meeting_platform::CalendarWatcher::spawn(tx) else {
            return;
        };
        let pump = cx.spawn(async move |this, cx| {
            while rx.recv_async().await.is_ok() {
                while rx.try_recv().is_ok() {}
                if this
                    .update(cx, |this, cx| this.refresh_calendar(cx))
                    .is_err()
                {
                    return;
                }
            }
        });
        self.calendar_watch = Some((watcher, pump));
    }

    pub fn remove_calendar(
        &mut self,
        id: &str,
        cx: &mut Context<Self>,
    ) -> Result<(), CalendarError> {
        self.calendar.ensure_loaded();
        self.calendar.remove(id)?;
        if self.calendar_active {
            self.push_calendar_to_planner(cx);
        }
        if self.calendar.sources.is_empty() {
            self.calendar_next = None;
        }
        self.sync_calendar_watch(cx);
        cx.emit(MeetingEvent::CalendarChanged);
        self.rearm(cx);
        Ok(())
    }

    pub fn refresh_calendar(&mut self, cx: &mut Context<Self>) {
        if !self.settings.enabled {
            return;
        }
        self.sync_calendars(cx);
    }

    pub fn sync_calendars(&mut self, cx: &mut Context<Self>) {
        self.calendar.ensure_loaded();
        if self.calendar.sources.is_empty() {
            self.calendar_next = None;
            self.rearm(cx);
            return;
        }
        if self.settings.enabled {
            self.calendar_next = Some(self.now().plus(calendar::REFRESH_EVERY.as_millis() as u64));
        }
        if self.calendar_task.is_some() {
            self.calendar_dirty = true;
            self.rearm(cx);
            return;
        }
        #[cfg(test)]
        if self.calendar_offline {
            return;
        }
        self.calendar_dirty = false;
        let sources = self.calendar.sources.clone();
        self.calendar_task = Some(cx.spawn(async move |this, cx| {
            let results = gpui_tokio::Tokio::spawn(cx, calendar::refresh(sources)).await;
            this.update(cx, |this, cx| {
                this.calendar_task = None;
                if let Ok(results) = results {
                    this.calendar.apply(results);
                }
                if this.calendar_active {
                    this.push_calendar_to_planner(cx);
                }
                cx.emit(MeetingEvent::CalendarChanged);
                if std::mem::take(&mut this.calendar_dirty) {
                    this.sync_calendars(cx);
                }
                this.rearm(cx);
            })
            .ok();
        }));
        cx.emit(MeetingEvent::CalendarChanged);
        self.rearm(cx);
    }

    fn request_auto_notes(&mut self, doc_id: String, cx: &mut Context<Self>) {
        if !self.settings.notes.auto_generate {
            return;
        }
        if let Some(finishing) = self.finishing.iter_mut().find(|f| f.doc_id == doc_id) {
            finishing.generate_notes = true;
            return;
        }
        self.start_auto_notes(doc_id, cx);
    }

    fn start_auto_notes(&mut self, doc_id: String, cx: &mut Context<Self>) {
        self.auto_notes_for(doc_id, cx);
    }

    fn self_name(meta: &DocMeta) -> Option<String> {
        speakers::user_name(meta)
    }

    pub fn generate_notes(
        &mut self,
        doc_id: &str,
        options: GenerateOptions,
        cx: &mut Context<Self>,
    ) -> Task<Result<(), NotesError>> {
        let prepared = self.prepare_notes(doc_id, &options);
        let (body, title_requested, template_id, left_out) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.notes.insert(
                    doc_id.to_string(),
                    NotesState {
                        error: Some(error.clone()),
                        ..NotesState::default()
                    },
                );
                cx.emit(MeetingEvent::NotesProgress {
                    doc_id: doc_id.to_string(),
                    stage: NotesStage::Failed(error.clone()),
                });
                return Task::ready(Err(error));
            }
        };
        self.notes.insert(
            doc_id.to_string(),
            NotesState {
                running: true,
                ..NotesState::default()
            },
        );
        cx.emit(MeetingEvent::NotesProgress {
            doc_id: doc_id.to_string(),
            stage: NotesStage::Started,
        });
        let doc = doc_id.to_string();
        self.remember_unwritten(vec![doc.clone()]);
        cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let mut attempt = 0usize;
            let result = loop {
                let (tx, rx) = flume::unbounded();
                let request =
                    gpui_tokio::Tokio::spawn(cx, generate::stream(NOTES_PATH, body.clone(), tx));
                let mut heard = false;
                while let Ok(event) = rx.recv_async().await {
                    heard |= matches!(
                        event,
                        generate::SseEvent::Title(_) | generate::SseEvent::Delta(_)
                    );
                    this.update(cx, |this, cx| this.on_notes_event(&doc, event, cx))
                        .ok();
                }
                let result = match request.await {
                    Ok(result) => result,
                    Err(error) => Err(NotesError::Failed(error.to_string())),
                };
                // Nothing arrived, so trying again repeats nothing: the
                // network or the server gets a few more chances.
                let retry = match &result {
                    Err(error) if !heard && notes_retryable(error) => {
                        Some(notes_retry_wait(attempt, error))
                    }
                    _ => None,
                };
                match retry {
                    Some(wait) if started.elapsed() + wait < NOTES_RETRY_FOR => {
                        tracing::info!(attempt, ?result, wait_secs = wait.as_secs(), "notes could not reach Cap, trying again");
                        attempt += 1;
                        let offline = result.as_ref().err().is_some_and(waits_on_connection);
                        this.update(cx, |this, cx| this.notes_waiting(&doc, true, offline, cx))
                            .ok();
                        cx.background_executor().timer(wait).await;
                        let still = this
                            .update(cx, |this, cx| {
                                this.notes_waiting(&doc, false, false, cx);
                                this.notes.get(&doc).is_some_and(|s| s.running)
                            })
                            .unwrap_or(false);
                        if !still {
                            break result;
                        }
                    }
                    _ => break result,
                }
            };
            this.update(cx, |this, cx| {
                this.finish_notes(&doc, result, title_requested, template_id, left_out, cx)
            })
            .unwrap_or(Err(NotesError::Failed("the app is closing".into())))
        })
    }

    fn prepare_notes(
        &mut self,
        doc_id: &str,
        options: &GenerateOptions,
    ) -> Result<(serde_json::Value, bool, String, String), NotesError> {
        let auth = crate::store::auth_snapshot();
        if !auth.signed_in() {
            return Err(NotesError::NotSignedIn);
        }
        if !auth.is_upgraded() {
            self.trial_gate_for(doc_id)?;
            self.ai.mark_trial(doc_id);
        }
        let library = self.library().cloned().ok_or(NotesError::NotFound)?;
        let meta = library.load(doc_id).map_err(|_| NotesError::NotFound)?;
        let transcript = self
            .transcript(doc_id)
            .map(Cow::into_owned)
            .unwrap_or_default();
        let user_notes = library
            .read_notes(doc_id)
            .ok()
            .flatten()
            .and_then(|json| cap_notes::Document::from_json(&json).ok())
            .map(|d| d.to_markdown())
            .unwrap_or_default();
        let templates = self.templates();
        let template_id = options
            .template_id
            .clone()
            .or_else(|| meta.template_id.clone())
            .unwrap_or_else(|| self.settings.notes.default_template_id.clone());
        let template = templates::find_template(&templates, &template_id)
            .or_else(|| templates::find_template(&templates, templates::DEFAULT_TEMPLATE_ID))
            .cloned()
            .unwrap_or_default();
        // A summary written under other choices on who is left out can hold
        // their words: it is never rewritten, only written again.
        let left_out = transcript.left_out_basis();
        let follows = persist::notes_left_out(&meta) == left_out;
        let previous = options
            .instruction
            .as_ref()
            .filter(|_| follows)
            .and_then(|_| {
                library
                    .read_enhanced(doc_id)
                    .ok()
                    .flatten()
                    .and_then(|json| cap_notes::Document::from_json(&json).ok())
                    .map(|d| d.to_markdown())
            });
        let self_name = Self::self_name(&meta);
        let body = generate::notes_body(generate::NotesInput {
            meta: &meta,
            transcript: &transcript,
            user_notes_markdown: user_notes,
            template: &template,
            vocabulary: &self.settings.transcription.vocabulary,
            summary_language: self.settings.notes.summary_language.as_deref(),
            previous_markdown: previous,
            instruction: options.instruction.clone(),
            time_zone: iana_time_zone::get_timezone().ok(),
            self_name: self_name.as_deref(),
        })?;
        Ok((body.body, body.title_requested, template.id, left_out))
    }

    fn notes_waiting(
        &mut self,
        doc_id: &str,
        waiting: bool,
        offline: bool,
        cx: &mut Context<Self>,
    ) {
        if let Some(state) = self.notes.get_mut(doc_id)
            && (state.waiting, state.offline) != (waiting, offline)
        {
            state.waiting = waiting;
            state.offline = offline;
            cx.emit(MeetingEvent::NotesProgress {
                doc_id: doc_id.to_string(),
                stage: NotesStage::Waiting(waiting),
            });
        }
    }

    fn on_notes_event(&mut self, doc_id: &str, event: generate::SseEvent, cx: &mut Context<Self>) {
        let state = self.notes.entry(doc_id.to_string()).or_default();
        let stage = match event {
            generate::SseEvent::Title(title) => {
                state.title = Some(title.clone());
                NotesStage::Title(title)
            }
            generate::SseEvent::Delta(text) => {
                state.markdown.push_str(&text);
                NotesStage::Delta
            }
            generate::SseEvent::Done | generate::SseEvent::Error(_) => return,
        };
        cx.emit(MeetingEvent::NotesProgress {
            doc_id: doc_id.to_string(),
            stage,
        });
    }

    fn finish_notes(
        &mut self,
        doc_id: &str,
        result: Result<(), NotesError>,
        title_requested: bool,
        template_id: String,
        left_out: String,
        cx: &mut Context<Self>,
    ) -> Result<(), NotesError> {
        self.auto_notes.remove(doc_id);
        let state = self.notes.entry(doc_id.to_string()).or_default();
        state.running = false;
        let outcome = result.and_then(|()| {
            if state.markdown.trim().is_empty() {
                return Err(NotesError::Failed("the summary was empty".into()));
            }
            Ok((state.markdown.clone(), state.title.clone()))
        });
        let outcome = outcome.and_then(|(markdown, title)| {
            let library = self.library().cloned().ok_or(NotesError::NotFound)?;
            let mut document = cap_notes::Document::from_markdown(&markdown);
            for block in &mut document.blocks {
                block.origin = cap_notes::Origin::Generated;
            }
            library
                .write_enhanced(doc_id, &document.to_json())
                .map_err(|e| NotesError::Failed(e.to_string()))?;
            let _lock = lock_meta();
            let mut meta = library.load(doc_id).map_err(|_| NotesError::NotFound)?;
            if let Some(meeting) = meta.meeting.as_mut() {
                meeting.has_enhanced = true;
            }
            persist::set_flag(&mut meta, persist::NOTES_STALE_KEY, false);
            persist::set_notes_left_out(&mut meta, &left_out);
            meta.template_id = Some(template_id);
            if title_requested
                && meta.title_is_auto
                && let Some(title) = title
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
            {
                meta.title = title;
            }
            meta.updated_at = Utc::now();
            library
                .save(&meta)
                .map_err(|e| NotesError::Failed(e.to_string()))?;
            Ok(())
        });
        if outcome.is_ok() {
            self.notes_follow_left_out(doc_id, cx);
        }
        let state = self.notes.entry(doc_id.to_string()).or_default();
        let stage = match &outcome {
            Ok(()) => {
                state.error = None;
                NotesStage::Done
            }
            Err(error) => {
                state.error = Some(error.clone());
                NotesStage::Failed(error.clone())
            }
        };
        cx.emit(MeetingEvent::NotesProgress {
            doc_id: doc_id.to_string(),
            stage,
        });
        if outcome.is_ok() {
            cx.emit(MeetingEvent::LibraryChanged);
        }
        // Written, or refused for good: nothing to resume at the next launch.
        if outcome.as_ref().is_err_and(notes_retryable) {
            tracing::warn!(doc_id, ?outcome, "notes not written yet; they resume at the next launch");
        } else {
            self.forget_unwritten(doc_id);
        }
        self.notes_finished(doc_id, &outcome, cx);
        self.drop_scratch_when_done(doc_id);
        if let Some(renames) = self.late_summary_renames.remove(doc_id) {
            self.follow_late_renames(doc_id, renames, cx);
        }
        cx.notify();
        outcome
    }

    /// What Ask is sent for `question`, and which lines were left out of it.
    fn ask_request(
        &mut self,
        doc_id: &str,
        question: &str,
        history: &[AskTurn],
    ) -> Result<(serde_json::Value, String), NotesError> {
        let Some(library) = self.library().cloned() else {
            return Err(NotesError::NotFound);
        };
        let Ok(meta) = library.load(doc_id) else {
            return Err(NotesError::NotFound);
        };
        let transcript = self
            .transcript(doc_id)
            .map(Cow::into_owned)
            .unwrap_or_default();
        // A summary or answer made before the person changed who is left
        // out of the notes can hold words now left out: Ask gets neither
        // until the notes are written again.
        let left_out = transcript.left_out_basis();
        let summary =
            (persist::notes_left_out(&meta) == left_out).then(|| library.read_enhanced(doc_id));
        let history: Vec<AskTurn> = history
            .iter()
            .filter(|turn| turn.left_out == left_out)
            .cloned()
            .collect();
        let notes = [summary.unwrap_or(Ok(None)), library.read_notes(doc_id)]
            .into_iter()
            .filter_map(|r| r.ok().flatten())
            .filter_map(|json| cap_notes::Document::from_json(&json).ok())
            .map(|d| d.to_markdown())
            .collect::<Vec<_>>()
            .join("\n\n");
        let self_name = Self::self_name(&meta);
        let body = generate::ask_body(
            doc_id,
            &meta.title,
            &transcript,
            &notes,
            question,
            &history,
            self_name.as_deref(),
            &self.settings.transcription.vocabulary,
        )?;
        Ok((body, left_out))
    }

    pub fn ask(
        &mut self,
        doc_id: &str,
        question: &str,
        history: &[AskTurn],
        cx: &mut Context<Self>,
    ) -> Task<Result<AskAnswer, NotesError>> {
        let auth = crate::store::auth_snapshot();
        if !auth.signed_in() {
            return Task::ready(Err(NotesError::NotSignedIn));
        }
        let (body, left_out) = match self.ask_request(doc_id, question, history) {
            Ok(request) => request,
            Err(error) => return Task::ready(Err(error)),
        };
        let doc = doc_id.to_string();
        cx.spawn(async move |this, cx| {
            let (tx, rx) = flume::unbounded();
            let request = gpui_tokio::Tokio::spawn(cx, generate::stream(ASK_PATH, body, tx));
            let mut answer = String::new();
            while let Ok(event) = rx.recv_async().await {
                if let generate::SseEvent::Delta(text) = event {
                    answer.push_str(&text);
                    let snapshot = answer.clone();
                    let doc = doc.clone();
                    this.update(cx, |_, cx| {
                        cx.emit(MeetingEvent::AskProgress {
                            doc_id: doc,
                            answer: snapshot,
                        })
                    })
                    .ok();
                }
            }
            match request.await {
                Ok(Ok(())) => Ok(AskAnswer {
                    text: answer,
                    left_out,
                }),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(NotesError::Failed(error.to_string())),
            }
        })
    }
}

/// A meeting note that heard nothing and holds nothing typed: no transcript,
/// no notes, no title the person gave it. It goes to Trash when its
/// recording finishes, so tests and false starts do not pile up on home.
pub(crate) fn false_start(library: &Library, meta: &DocMeta, transcript_chars: usize) -> bool {
    if transcript_chars > 0 || meta.is_trashed() {
        return false;
    }
    let event_title = meta
        .meeting
        .as_ref()
        .and_then(|m| m.event.as_ref())
        .map(|e| e.title.trim());
    if !meta.title_is_auto
        && !meta.title.trim().is_empty()
        && event_title != Some(meta.title.trim())
    {
        return false;
    }
    let typed = library
        .read_notes(&meta.id)
        .ok()
        .flatten()
        .and_then(|json| cap_notes::Document::from_json(&json).ok())
        .is_some_and(|document| !document.to_markdown().trim().is_empty());
    !typed
}

/// One line spelled with `corrector`, when anything in it changes.
pub(crate) fn respell(
    corrector: &cap_meetings::dictionary::Corrector,
    line: &cap_meetings::transcript::Utterance,
) -> Option<cap_meetings::transcript::Utterance> {
    let mut words: Vec<String> = line.text.split(' ').map(str::to_string).collect();
    if corrector.apply_strings(&mut words) == 0 {
        return None;
    }
    let mut line = line.clone();
    line.text = words.join(" ");
    corrector.apply_timed(
        &mut line.words,
        |w| w.text.as_str(),
        |_, text, start_ms, end_ms| cap_meetings::transcript::Word {
            text,
            start_ms,
            end_ms,
        },
        |w| (w.start_ms, w.end_ms),
    );
    Some(line)
}

/// The pass's speakers that still say something in `transcript`, plus any
/// voice holding lines the pass did not list (a line someone moved by hand).
/// Removes the lines that are only the call heard through the speakers and
/// returns the ones the saved transcript has to drop. A live caption is never
/// saved, and its id becomes its segment's final line: a Delete for the
/// caption that reaches the file after that line would take the person's
/// words with it.
///
/// Short lines ("Merci.", "Soft heart,") are judged only where this meeting's
/// microphone has repeated a sentence of the call while the call was still
/// saying it, on the devices of that stretch (`echo`): on a headset nothing
/// comes back, and a quick "Yes." over the other side's "Yes" is the
/// person's own.
fn remove_echoes(transcript: &mut Transcript, echo: &mut echo_periods::EchoPeriods) -> Vec<String> {
    let live: HashSet<String> = transcript
        .utterances()
        .iter()
        .filter(|u| !u.is_final)
        .map(|u| u.id.clone())
        .collect();
    let config = EchoConfig::default();
    let report = transcript.suppress_echo_in(&config, &echo.heard_spans());
    let mut removed = report.removed;
    let mut newly = false;
    for at_ms in report.heard_at_ms {
        newly |= echo.heard_at(at_ms);
    }
    if newly {
        // A sentence of the call just came back through the speakers: the
        // short pieces of it already on the microphone in that stretch go
        // too.
        removed.extend(
            transcript
                .suppress_echo_in(&config, &echo.heard_spans())
                .removed,
        );
    }
    removed.retain(|id| !live.contains(id));
    removed
}

fn speakers_with_lines(
    pass_speakers: &[cap_diarize::SpeakerInfo],
    transcript: &Transcript,
) -> Vec<cap_diarize::SpeakerInfo> {
    let speaking = transcript.speaking_ids();
    let mut speakers: Vec<cap_diarize::SpeakerInfo> = pass_speakers
        .iter()
        .filter(|s| speaking.contains(&s.id.0))
        .cloned()
        .collect();
    for id in &speaking {
        if speakers.iter().any(|s| s.id.0 == *id) {
            continue;
        }
        let lines: Vec<_> = transcript
            .utterances()
            .iter()
            .filter(|u| u.speaker_id == Some(*id))
            .collect();
        let Some(first) = lines.first() else {
            continue;
        };
        speakers.push(cap_diarize::SpeakerInfo {
            id: cap_diarize::SpeakerId(*id),
            track: match first.source {
                Source::Mic => cap_diarize::Track::Mic,
                Source::System => cap_diarize::Track::System,
            },
            first_ms: first.start_ms,
            speech_ms: lines
                .iter()
                .map(|u| u.end_ms.saturating_sub(u.start_ms))
                .sum(),
            is_user: false,
        });
    }
    speakers
}

/// Nemotron's after-Stop labels applied to the meeting's transcript as it
/// is on disk now: only lines still on the voice the final pass gave them
/// move, the person's renames and voice choices stay, and nobody is
/// renumbered. Returns the labels a summary written before should follow;
/// None when nothing moved.
fn late_labels(
    library: &Library,
    doc_id: &str,
    late: voices::LateResult,
) -> Option<Vec<(String, String)>> {
    let Ok(path) = library.transcript_path(doc_id) else {
        return None;
    };
    let (transcript, _) = match Transcript::load_jsonl(&path) {
        Ok(loaded) => loaded,
        Err(error) => {
            tracing::warn!(%error, doc_id, "Nemotron after Stop: could not read the transcript");
            return None;
        }
    };
    let voices::LateResult { voices, expect } = late;
    let voices::FinalVoices { mut assign, mut pass } = voices;
    let now: HashMap<&str, Option<u32>> = transcript
        .utterances()
        .iter()
        .map(|u| (u.id.as_str(), u.speaker_id))
        .collect();
    let expected: HashMap<&str, Option<u32>> =
        expect.iter().map(|(id, was)| (id.as_str(), *was)).collect();
    let offered = assign.len();
    assign.retain(|(id, _)| {
        expected
            .get(id.as_str())
            .is_some_and(|was| now.get(id.as_str()) == Some(was))
    });
    if assign.is_empty() {
        tracing::info!(offered, "Nemotron after Stop: nothing left to move");
        return None;
    }
    let mut relabelled = transcript.clone();
    relabelled.assign_speakers(&assign);
    pass.speakers = speakers_with_lines(&pass.speakers, &relabelled);
    if pass.user.is_none() {
        pass.user = transcript.names().and_then(|n| n.user());
    }
    let mut names = transcript.names().cloned().unwrap_or_else(|| {
        cap_diarize::SpeakerNames::new(
            library
                .load(doc_id)
                .ok()
                .and_then(|meta| speakers::other_attendee(&meta)),
        )
    });
    let changes = names.apply_late(&pass);
    tracing::info!(
        relabelled = assign.len(),
        skipped = offered - assign.len(),
        voices = pass.speakers.len(),
        renamed = changes.len(),
        "Nemotron after Stop moved lines"
    );
    let mut after = relabelled;
    after.set_names(names.clone());
    let self_name = library
        .load(doc_id)
        .ok()
        .and_then(|meta| Meetings::self_name(&meta));
    let renames =
        late_summary_renames(&transcript, &after, &pass.merged, self_name.as_deref());
    let lines = vec![LogLine::Speakers { assign }, LogLine::SpeakerNames { names }];
    if let Err(error) = append_jsonl(&path, &lines) {
        tracing::warn!(%error, "could not add Nemotron's labels to the meeting transcript");
        return None;
    }
    Some(renames)
}

/// What a late speaker correction renames in a summary already written: each
/// voice it merged away, once none of its lines are left, now goes by the
/// label of the voice that absorbed it. Labels are the ones prompts and the
/// summary use. A split cannot be followed this way and is left alone.
fn late_summary_renames(
    before: &Transcript,
    after: &Transcript,
    merged: &[(cap_diarize::SpeakerId, cap_diarize::SpeakerId)],
    self_name: Option<&str>,
) -> Vec<(String, String)> {
    let had = before.speaking_ids();
    let has = after.speaking_ids();
    let mut out: Vec<(String, String)> = Vec::new();
    for (from, to) in merged {
        if !had.contains(&from.0) || has.contains(&from.0) {
            continue;
        }
        let mut target = *to;
        for _ in 0..merged.len() {
            match merged.iter().find(|(f, _)| *f == target) {
                Some((_, next)) => target = *next,
                None => break,
            }
        }
        let was = before.speaker(Source::System, None, Some(from.0)).english(self_name);
        let now = after.speaker(Source::System, None, Some(target.0)).english(self_name);
        if was != now && !out.iter().any(|(w, _)| *w == was) {
            out.push((was, now));
        }
    }
    out
}

/// The spellings of a label a summary may use: "Person 2" is also written
/// "Speaker 2" (as the notes pane renames them).
fn summary_tokens(label: &str) -> Vec<String> {
    let mut out = vec![label.to_string()];
    if let Some(n) = label.strip_prefix("Person ")
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
    {
        out.push(format!("Speaker {n}"));
    }
    out
}

/// The saved summary with whole-name labels renamed (`from` -> `to`), or None
/// when it names none of them.
fn rename_in_saved_summary(json: &str, renames: &[(String, String)]) -> Option<String> {
    let document = cap_notes::Document::from_json(json).ok()?;
    let mut editor = cap_notes::Editor::new(document);
    let before = editor.document().to_json();
    for (from, to) in renames {
        for token in summary_tokens(from) {
            editor.rename_token(&token, to);
        }
    }
    let after = editor.into_document().to_json();
    (after != before).then_some(after)
}

/// Writes the meeting's call app (and the automatic title that follows it)
/// under the meta lock, so a rename, folder or trash queued at that moment is
/// kept.
fn save_meeting_app(
    library: &Library,
    doc_id: &str,
    app_id: Option<String>,
    app_name: Option<String>,
) -> Option<DocMeta> {
    let _lock = lock_meta();
    let mut meta = library.load(doc_id).ok()?;
    let meeting = meta.meeting.get_or_insert_with(MeetingDetails::default);
    meeting.app_id = app_id;
    meeting.app_name = app_name;
    if meta.title_is_auto && meeting.event.is_none() {
        let started = meeting
            .started_at
            .unwrap_or_else(Utc::now)
            .with_timezone(&chrono::Local)
            .naive_local();
        meta.title = crate::meetings_ui::documents::format::meeting_title(
            meeting.app_name.as_deref(),
            started,
        );
    }
    if let Err(error) = library.save(&meta) {
        tracing::warn!(%error, "could not save the meeting's call");
    }
    Some(meta)
}
