//! The app-wide recording session.
//!
//! Unit 1 kept the recording lifecycle on `MainWindow`; the controls bar makes
//! that untenable -- two windows now read and drive the same state. The session
//! is a plain gpui entity installed as a global, observed by both windows; all
//! engine work runs on tokio via `gpui_tokio` and lands back here with
//! `cx.notify()`.

use std::time::{Duration, Instant};

use cap_utils::disk_space::{DiskSpaceStatus, RecordingStorageMonitor};
use gpui::{App, AppContext as _, Context, Entity, Global, Task};

use crate::recording::{self, ActiveRecording, StartConfig};

/// `Idle -> Starting -> Recording -> Stopping -> Idle`; pause is a flag on
/// `Recording`, matching the `recording`/`paused` variants of the Tauri bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Starting,
    Recording { paused: bool },
    Stopping,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct RecordingOwner {
    generation: u64,
    project_dir: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
#[derive(Clone)]
struct TerminalTicket {
    owner: RecordingOwner,
    operation: u64,
}

#[cfg(target_os = "linux")]
impl TerminalTicket {
    fn is_current(
        &self,
        phase: Phase,
        generation: u64,
        operation: u64,
        owner: Option<&RecordingOwner>,
        retains_active: bool,
    ) -> bool {
        phase == Phase::Stopping
            && generation == self.owner.generation
            && operation == self.operation
            && (!retains_active || owner == Some(&self.owner))
    }
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CleanControlKind {
    Pause,
    Resume,
    VerifyPaused,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct CleanControlTicket {
    owner: RecordingOwner,
    sequence: u64,
    kind: CleanControlKind,
}

#[cfg(target_os = "linux")]
struct PendingCleanControl {
    ticket: CleanControlTicket,
    abort: futures_util::future::AbortHandle,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct CleanControlState {
    pending: Option<PendingCleanControl>,
    sequence: u64,
    paused_owner: Option<RecordingOwner>,
    uncertain: bool,
}

#[cfg(target_os = "linux")]
impl CleanControlState {
    fn begin(
        &mut self,
        owner: RecordingOwner,
        kind: CleanControlKind,
    ) -> (CleanControlTicket, futures_util::future::AbortRegistration) {
        self.invalidate();
        self.sequence = self.sequence.wrapping_add(1);
        let ticket = CleanControlTicket {
            owner,
            sequence: self.sequence,
            kind,
        };
        let (abort, registration) = futures_util::future::AbortHandle::new_pair();
        self.pending = Some(PendingCleanControl {
            ticket: ticket.clone(),
            abort,
        });
        (ticket, registration)
    }

    fn invalidate(&mut self) {
        if let Some(pending) = self.pending.take() {
            pending.abort.abort();
        }
        self.paused_owner = None;
    }

    fn pending_kind(&self) -> Option<CleanControlKind> {
        self.pending.as_ref().map(|pending| pending.ticket.kind)
    }

    fn complete(
        &mut self,
        ticket: &CleanControlTicket,
        owner: Option<&RecordingOwner>,
        phase: Phase,
        outcome: &CleanControlOutcome,
    ) -> bool {
        if owner != Some(&ticket.owner)
            || !matches!(phase, Phase::Recording { .. })
            || self
                .pending
                .as_ref()
                .is_none_or(|pending| pending.ticket != *ticket)
        {
            return false;
        }
        self.pending = None;
        self.uncertain = outcome.paused.is_none();
        self.paused_owner = (outcome.paused == Some(true)).then(|| ticket.owner.clone());
        true
    }

    fn paused_for(&self, owner: Option<&RecordingOwner>) -> bool {
        !self.uncertain
            && self.pending.is_none()
            && owner.is_some()
            && self.paused_owner.as_ref() == owner
    }
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct CleanControlOutcome {
    paused: Option<bool>,
    error: Option<String>,
}

#[cfg(target_os = "linux")]
async fn after_clean_visibility(
    visibility: Option<crate::app_windows::CleanVisibility>,
    control: impl Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    if let Some(visibility) = visibility {
        visibility.await?;
    }
    control.await
}

#[cfg(target_os = "linux")]
async fn run_clean_control(
    kind: CleanControlKind,
    control: impl Future<Output = anyhow::Result<()>>,
    query_paused: impl Future<Output = anyhow::Result<bool>>,
    settle: impl Future<Output = ()>,
) -> CleanControlOutcome {
    if kind == CleanControlKind::Resume {
        settle.await;
    }
    let result = control.await;
    let control_succeeded = result.is_ok();
    let state = tokio::time::timeout(Duration::from_secs(2), query_paused).await;
    let (paused, state_error) = match state {
        Ok(Ok(paused)) => (Some(paused), None),
        Ok(Err(error)) => (
            None,
            Some(format!("Could not confirm capture state: {error:#}")),
        ),
        Err(_) => (None, Some("Timed out confirming capture state".into())),
    };
    let paused = match paused {
        Some(true) => Some(true),
        Some(false) if control_succeeded && kind == CleanControlKind::Resume => Some(false),
        _ => None,
    };
    let error = result
        .err()
        .map(|error| format!("{error:#}"))
        .or(state_error)
        .or_else(|| {
            let expected = kind != CleanControlKind::Resume;
            (paused != Some(expected))
                .then(|| "Capture did not acknowledge the requested pause state".into())
        });
    CleanControlOutcome { paused, error }
}

pub struct RecordingSession {
    pub phase: Phase,
    active: Option<ActiveRecording>,
    /// Why the last start attempt failed, for the main window to surface.
    pub error: Option<String>,
    pub storage_warning: bool,
    pub storage_notice: Option<String>,
    stopped_for_low_storage: bool,
    stopped_elapsed: Option<Duration>,
    /// The config of the live (or last) recording, kept for restart.
    last_config: Option<StartConfig>,
    /// True while the controls bar window is open, so the main window knows to
    /// fall back to its in-window overlay when the bar failed to open.
    pub controls_open: bool,
    /// Mirror of the recording-scoped mic mute flag (the engine zeroes the
    /// payloads; the flag itself lives on the live recording's mic lock and
    /// resets with every new session).
    pub mic_muted: bool,
    /// The project dir of the studio recording that just stopped cleanly.
    /// Taken by the phase observer to honour `postStudioRecordingBehaviour`
    /// (`openEditor` by default) the way the Tauri app does.
    pub finished_studio: Option<std::path::PathBuf>,
    /// `EditorRecordingTarget` (`src-tauri/src/windows.rs:3679-3697`): the
    /// open editor project a "Record a new clip" capture must land back in.
    /// Set by the editor's record modal (`setEditorRecordingTarget`,
    /// `ClipsSidebar.tsx:444`), cleared when its picker is cancelled, and
    /// *taken* -- never merely read -- by the phase observer when the session
    /// comes back to rest, exactly the way `apply_post_studio_editor_behaviour`
    /// and the stop-cleanup fallback both `take()` it
    /// (`src-tauri/src/recording.rs:3231-3287`) so a stale target can never
    /// leak into the next recording.
    editor_recording_target: Option<std::path::PathBuf>,
    started_at: Option<Instant>,
    paused_accum: Duration,
    paused_since: Option<Instant>,
    storage_monitor: Option<Task<()>>,
    failure_monitor: Option<Task<()>>,
    recording_generation: u64,
    #[cfg(target_os = "linux")]
    instant_attempt: Option<recording::InstantAttempt>,
    #[cfg(target_os = "linux")]
    terminal_operation: u64,
    pipeline_failed: bool,
    #[cfg(target_os = "linux")]
    stop_requested: bool,
    #[cfg(target_os = "linux")]
    clean_control: CleanControlState,
    #[cfg(target_os = "linux")]
    show_controls_after_pause: bool,
}

struct SessionGlobal(Entity<RecordingSession>);
impl Global for SessionGlobal {}

impl RecordingSession {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let session = cx.new(|_| Self {
            phase: Phase::Idle,
            active: None,
            error: None,
            storage_warning: false,
            storage_notice: None,
            stopped_for_low_storage: false,
            stopped_elapsed: None,
            last_config: None,
            controls_open: false,
            mic_muted: false,
            finished_studio: None,
            editor_recording_target: None,
            started_at: None,
            paused_accum: Duration::ZERO,
            paused_since: None,
            storage_monitor: None,
            failure_monitor: None,
            recording_generation: 0,
            #[cfg(target_os = "linux")]
            instant_attempt: None,
            #[cfg(target_os = "linux")]
            terminal_operation: 0,
            pipeline_failed: false,
            #[cfg(target_os = "linux")]
            stop_requested: false,
            #[cfg(target_os = "linux")]
            clean_control: CleanControlState::default(),
            #[cfg(target_os = "linux")]
            show_controls_after_pause: false,
        });
        cx.set_global(SessionGlobal(session.clone()));
        session
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<SessionGlobal>().0.clone()
    }

    /// True while a recording is in flight. Tolerates the global not being
    /// installed yet (reporting idle) so callers can gate on it from windows
    /// that may open before the session exists.
    pub fn recording_in_flight(cx: &App) -> bool {
        cx.has_global::<SessionGlobal>()
            && cx.global::<SessionGlobal>().0.read(cx).phase != Phase::Idle
    }

    /// Elapsed recording time, excluding paused stretches -- what the bar's
    /// timer shows.
    pub fn elapsed(&self) -> Duration {
        if let Some(elapsed) = self.stopped_elapsed {
            return elapsed;
        }
        let Some(started_at) = self.started_at else {
            return Duration::ZERO;
        };
        let paused = self.paused_accum
            + self
                .paused_since
                .map(|since| since.elapsed())
                .unwrap_or_default();
        started_at.elapsed().saturating_sub(paused)
    }

    pub fn is_paused(&self) -> bool {
        matches!(self.phase, Phase::Recording { paused: true })
    }

    /// The live (or last) recording's mode -- the bar exposes mic mute for
    /// instant recordings only (studio records the mic as an editable track,
    /// where muted spans would silently bake zeros in).
    pub fn mode(&self) -> Option<crate::recording::RecordingMode> {
        self.last_config.as_ref().map(|config| config.mode)
    }

    /// Whether the live recording actually has a microphone attached.
    pub fn has_microphone(&self) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.mic_mute.is_some())
    }

    /// Flip the recording-scoped mic mute. No-op without a live mic.
    pub fn toggle_mic_mute(&mut self, cx: &mut Context<Self>) {
        let Some(mute) = self
            .active
            .as_ref()
            .and_then(|active| active.mic_mute.clone())
        else {
            return;
        };
        self.mic_muted = !self.mic_muted;
        mute.store(self.mic_muted, std::sync::atomic::Ordering::Relaxed);
        cx.notify();
    }

    /// `set_editor_recording_target` (`src-tauri/src/lib.rs:3166-3172`):
    /// arm (or disarm) the editor project the next studio recording appends
    /// into. No phase guard here -- the guard lives at the call sites, the way
    /// the Tauri command is a bare state write.
    pub fn set_editor_recording_target(&mut self, target: Option<std::path::PathBuf>) {
        self.editor_recording_target = target;
    }

    /// `EditorRecordingTarget::current`.
    pub fn editor_recording_target(&self) -> Option<std::path::PathBuf> {
        self.editor_recording_target.clone()
    }

    /// `EditorRecordingTarget::take` -- the consuming read both finish paths
    /// use, so the target clears no matter how the recording ended.
    pub fn take_editor_recording_target(&mut self) -> Option<std::path::PathBuf> {
        self.editor_recording_target.take()
    }

    pub fn set_controls_open(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.controls_open != open {
            self.controls_open = open;
            cx.notify();
        }
    }

    pub fn start(&mut self, config: StartConfig, cx: &mut Context<Self>) {
        if self.phase != Phase::Idle {
            return;
        }
        self.storage_monitor = None;
        self.failure_monitor = None;
        self.recording_generation = self.recording_generation.wrapping_add(1);
        self.pipeline_failed = false;
        #[cfg(target_os = "linux")]
        {
            self.instant_attempt = (config.mode == recording::RecordingMode::Instant)
                .then(recording::InstantAttempt::new);
            self.clean_control.invalidate();
            self.clean_control.uncertain = false;
        }
        self.phase = Phase::Starting;
        self.error = None;
        self.storage_warning = false;
        self.storage_notice = None;
        self.stopped_for_low_storage = false;
        self.stopped_elapsed = None;
        self.last_config = Some(config.clone());
        cx.notify();

        #[cfg(target_os = "linux")]
        let generation = self.recording_generation;
        #[cfg(target_os = "linux")]
        let attempt = self.instant_attempt.clone();
        #[cfg(target_os = "linux")]
        let start: std::pin::Pin<
            Box<dyn Future<Output = anyhow::Result<ActiveRecording>> + Send>,
        > = match attempt.clone() {
            Some(attempt) => Box::pin(recording::start_tracked(config, attempt)),
            None => Box::pin(recording::start(config)),
        };
        #[cfg(not(target_os = "linux"))]
        let start = recording::start(config);
        let task = gpui_tokio::Tokio::spawn(cx, start);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            #[cfg(target_os = "linux")]
            let startup_failed = !matches!(&result, Ok(Ok(_)));
            #[cfg(target_os = "linux")]
            let startup_joined = if startup_failed {
                match &attempt {
                    Some(attempt) => {
                        attempt.cancel();
                        attempt.wait_for_quiescence().await
                            == cap_recording::instant_recording::InstantQuiescence::Joined
                    }
                    None => true,
                }
            } else {
                false
            };
            this.update(cx, |this, cx| {
                #[cfg(target_os = "linux")]
                if this.recording_generation != generation || this.phase != Phase::Starting {
                    if let Ok(Ok(active)) = result {
                        gpui_tokio::Tokio::spawn(cx, active.cancel_preserving()).detach();
                    }
                    return;
                }
                match result {
                    Ok(Ok(active)) => {
                        tracing::info!(dir = %active.project_dir.display(), "recording started");
                        let project_dir = active.project_dir.clone();
                        let done = active.done_fut();
                        this.active = Some(active);
                        this.phase = Phase::Recording { paused: false };
                        // A fresh mic lock always starts unmuted.
                        this.mic_muted = false;
                        this.started_at = Some(Instant::now());
                        this.paused_accum = Duration::ZERO;
                        this.paused_since = None;
                        this.monitor_storage(project_dir, cx);
                        this.monitor_recording_failure(done, cx);
                        #[cfg(target_os = "linux")]
                        if this.stop_requested {
                            this.stop(cx);
                        } else if this.show_controls_after_pause {
                            this.show_clean_capture_controls(cx);
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::error!("recording failed to start: {error:#}");
                        this.error = Some(format!("{error:#}"));
                        #[cfg(target_os = "linux")]
                        {
                            this.phase = if startup_joined {
                                Phase::Idle
                            } else {
                                Phase::Starting
                            };
                        }
                        #[cfg(not(target_os = "linux"))]
                        {
                            this.phase = Phase::Idle;
                        }
                    }
                    Err(join_error) => {
                        tracing::error!("recording start task died: {join_error}");
                        this.error = Some("Recording task failed.".into());
                        #[cfg(target_os = "linux")]
                        {
                            this.phase = if startup_joined {
                                Phase::Idle
                            } else {
                                Phase::Starting
                            };
                        }
                        #[cfg(not(target_os = "linux"))]
                        {
                            this.phase = Phase::Idle;
                        }
                    }
                }
                #[cfg(target_os = "linux")]
                if startup_failed && !startup_joined {
                    this.stop_requested = false;
                    this.clean_control.uncertain = true;
                    this.error = Some(format!(
                        "{}. Capture cleanup is unconfirmed. Use Ctrl+Shift+F9 to retry Stop.",
                        this.error.as_deref().unwrap_or("Recording startup failed")
                    ));
                }
                #[cfg(target_os = "linux")]
                if this.phase == Phase::Idle {
                    this.stop_requested = false;
                    this.clean_control = CleanControlState::default();
                    this.show_controls_after_pause = false;
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn monitor_recording_failure(&mut self, done: cap_recording::DoneFut, cx: &mut Context<Self>) {
        let generation = self.recording_generation;
        let task = gpui_tokio::Tokio::spawn(cx, done);
        self.failure_monitor = Some(cx.spawn(async move |this, cx| {
            let error = match task.await {
                Ok(Ok(())) => "Recording ended unexpectedly.".to_string(),
                Ok(Err(error)) => error.to_string(),
                Err(error) => format!("Recording completion task failed: {error}"),
            };
            this.update(cx, |this, cx| {
                if !recording_failure_is_current(this.phase, this.recording_generation, generation)
                    || this.active.is_none()
                {
                    return;
                }
                tracing::error!(%error, "recording pipeline failed");
                this.pipeline_failed = true;
                this.error = Some(error);
                this.stop(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    fn monitor_storage(&mut self, project_dir: std::path::PathBuf, cx: &mut Context<Self>) {
        self.storage_monitor = None;
        let task = cx.spawn(async move |this, cx| {
            let mut check_failed = false;
            let mut storage_monitor = RecordingStorageMonitor::default();
            loop {
                cx.background_executor().timer(Duration::from_secs(2)).await;
                let is_current = |session: &Self| {
                    matches!(session.phase, Phase::Recording { .. })
                        && session
                            .active
                            .as_ref()
                            .is_some_and(|active| active.project_dir == project_dir)
                };
                if !this.update(cx, |this, _| is_current(this)).unwrap_or(false) {
                    return;
                }
                let path = project_dir.clone();
                let (next_monitor, result) = cx
                    .background_executor()
                    .spawn(async move {
                        let result = storage_monitor.sample(&path);
                        (storage_monitor, result)
                    })
                    .await;
                storage_monitor = next_monitor;
                let storage = match result {
                    Ok(storage) => {
                        check_failed = false;
                        storage
                    }
                    Err(error) => {
                        if !check_failed {
                            tracing::warn!(%error, "Could not check recording storage");
                            check_failed = true;
                        }
                        continue;
                    }
                };
                if !this
                    .update(cx, |this, cx| {
                        if !is_current(this) {
                            return false;
                        }
                        match storage.status() {
                            DiskSpaceStatus::Exhausted => {
                                this.storage_warning = true;
                                this.stopped_for_low_storage = true;
                                this.storage_notice =
                                    Some("Low storage. Stopping and saving your recording…".into());
                                this.stop(cx);
                                false
                            }
                            status => {
                                let warning = status == DiskSpaceStatus::Low;
                                if warning != this.storage_warning {
                                    this.storage_warning = warning;
                                    cx.notify();
                                }
                                true
                            }
                        }
                    })
                    .unwrap_or(false)
                {
                    return;
                }
            }
        });
        self.storage_monitor = Some(task);
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if matches!(self.phase, Phase::Starting | Phase::Stopping)
            && let Some(attempt) = self.instant_attempt.clone()
        {
            attempt.cancel();
            if self.phase == Phase::Stopping || self.stop_requested {
                self.stop_requested = true;
                cx.notify();
                return;
            }
            self.stop_requested = true;
            let generation = self.recording_generation;
            let task =
                gpui_tokio::Tokio::spawn(cx, async move { attempt.wait_for_quiescence().await });
            cx.spawn(async move |this, cx| {
                let result = task.await;
                this.update(cx, |this, cx| {
                    if this.recording_generation != generation || this.phase != Phase::Starting || this.active.is_some() { return; }
                    if matches!(result, Ok(cap_recording::instant_recording::InstantQuiescence::Joined)) {
                        this.finish(cx);
                    } else {
                        this.stop_requested = false;
                        this.clean_control.uncertain = true;
                        this.error = Some("Capture cleanup is unconfirmed. Local files are preserved; use Ctrl+Shift+F9 to retry Stop.".into());
                        cx.notify();
                    }
                }).ok();
            }).detach();
            cx.notify();
            return;
        }
        #[cfg(target_os = "linux")]
        if crate::app_windows::clean_capture_active(cx)
            && clean_capture_stop_must_wait(self.phase, self.clean_control.pending_kind())
        {
            self.stop_requested = true;
            cx.notify();
            return;
        }
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
        self.storage_monitor = None;
        #[cfg(not(windows))]
        {
            self.failure_monitor = None;
        }
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let instant_share_url = active.instant_share_url().map(ToString::to_string);
        #[cfg(target_os = "linux")]
        let stop_owner = RecordingOwner {
            generation: self.recording_generation,
            project_dir: active.project_dir.clone(),
        };
        #[cfg(target_os = "linux")]
        let operation = {
            self.terminal_operation = self.terminal_operation.wrapping_add(1);
            self.terminal_operation
        };
        #[cfg(target_os = "linux")]
        let stop_ticket = TerminalTicket {
            owner: stop_owner.clone(),
            operation,
        };
        #[cfg(not(target_os = "linux"))]
        let stop_generation = self.recording_generation;
        let phase_before_stop = self.phase;
        let low_storage = self.stopped_for_low_storage;
        let recording_failed = self.pipeline_failed;
        #[cfg(any(target_os = "macos", windows))]
        let original_failure = recording_failed.then(|| self.error.clone()).flatten();
        #[cfg(target_os = "linux")]
        let defer_share_until_success =
            crate::app_windows::clean_capture_active(cx) || active.instant_lifecycle().is_some();
        #[cfg(not(target_os = "linux"))]
        let defer_share_until_success = true;
        if let Some(link) = &instant_share_url
            && !low_storage
            && !recording_failed
            && !defer_share_until_success
            && !crate::store::GeneralSettings::load().disable_auto_open_links
        {
            let separator = if link.contains('?') { '&' } else { '?' };
            cx.open_url(&format!("{link}{separator}recordingStopped=1"));
        }
        #[cfg(target_os = "linux")]
        let retained_stop = active
            .instant_stop_handle(low_storage || recording_failed, recording_failed)
            .or_else(|| active.clean_studio_stop_handle());
        #[cfg(windows)]
        let retained_stop = recording_failed
            .then(|| active.failed_stop_handle())
            .or_else(|| active.clean_windows_studio_stop_handle());
        #[cfg(target_os = "macos")]
        let retained_stop = recording_failed.then(|| active.failed_stop_handle());
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let retained_stop: Option<recording::CaptureStopFuture> = None;
        let retains_active = retained_stop.is_some();
        let stop_future: recording::CaptureStopFuture = match retained_stop {
            Some(future) => future,
            None => {
                let active = self.active.take().unwrap();
                Box::pin(async move { (true, active.stop(low_storage || recording_failed).await) })
            }
        };
        #[cfg(target_os = "linux")]
        {
            self.clean_control.invalidate();
            self.stop_requested = false;
        }
        self.stopped_elapsed = Some(self.elapsed());
        self.phase = Phase::Stopping;
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, stop_future);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                #[cfg(target_os = "linux")]
                if !stop_ticket.is_current(this.phase, this.recording_generation, this.terminal_operation, this.recording_owner().as_ref(), retains_active) { return; }
                #[cfg(not(target_os = "linux"))]
                if this.recording_generation != stop_generation || this.phase != Phase::Stopping { return; }
                let capture_stopped = match &result {
                    Ok((stopped, _)) => *stopped,
                    Err(_) => !retains_active,
                };
                if !capture_stopped {
                    let error = match result {
                        Ok((_, Err(error))) => format!("{error:#}"),
                        Err(error) => format!("Stop task failed: {error}"),
                        Ok((_, Ok(_))) => "Capture stop was not acknowledged".into(),
                    };
                    #[cfg(any(target_os = "macos", windows))]
                    let error = match &original_failure {
                        Some(first) => format!("{first}; cleanup: {error}"),
                        None => error,
                    };
                    tracing::error!(%error, "Capture cleanup is unconfirmed; retaining Stop control");
                    this.phase = phase_before_stop;
                    this.stopped_elapsed = None;
                    #[cfg(windows)]
                    let message = if this.mode() == Some(recording::RecordingMode::Studio) {
                        format!("{error}. Studio shutdown remains unconfirmed; recording and files retained.")
                    } else {
                        format!("{error}. Capture cleanup is unconfirmed. Use Ctrl+Shift+F9 to retry Stop.")
                    };
                    #[cfg(target_os = "macos")]
                    let message = format!("{error}. Capture cleanup is unconfirmed. Use your recording Stop control to retry.");
                    #[cfg(not(any(target_os = "macos", windows)))]
                    let message = format!("{error}. Capture cleanup is unconfirmed. Use Ctrl+Shift+F9 to retry Stop.");
                    this.error = Some(message);
                    #[cfg(target_os = "linux")]
                    { this.clean_control.uncertain = true; }
                    cx.notify();
                    return;
                }
                let result = result.map(|(_, result)| result);
                #[cfg(any(target_os = "macos", windows))]
                let result = result.map(|result| result.map_err(|error| match &original_failure {
                    Some(first) => error.context(first.clone()),
                    None => error,
                }));
                if retains_active { this.active = None; }
                match result {
                    Ok(Ok(project_dir)) if recording_failed => {
                        tracing::warn!(dir = %project_dir.display(), "failed recording files preserved");
                    }
                    Ok(Ok(project_dir)) => {
                        // The completion affordance is Recents now: the main
                        // window comes back with this recording at the head of
                        // the carousel, thumbnail and all. Stop used to reveal
                        // the bundle in Finder as a stand-in; the Tauri app
                        // never does that, so it goes with the placeholder it
                        // was standing in for.
                        tracing::info!(dir = %project_dir.display(), "recording finished");
                        if low_storage {
                            this.storage_notice = Some("Recording stopped because storage is low. Your recording was saved.".into());
                        }
                        if this.mode() == Some(crate::recording::RecordingMode::Studio) && !low_storage {
                            this.finished_studio = Some(project_dir);
                        } else if let Some(link) = instant_share_url {
                            if defer_share_until_success
                                && !low_storage
                                && !crate::store::GeneralSettings::load().disable_auto_open_links
                            {
                                let separator = if link.contains('?') { '&' } else { '?' };
                                cx.open_url(&format!("{link}{separator}recordingStopped=1"));
                            }
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(link));
                        }
                    }
                    Ok(Err(error)) => {
                        tracing::error!("recording failed to stop cleanly: {error:#}");
                        this.storage_notice = low_storage.then(|| "Recording stopped because storage is low. Your recording files were kept. Free up space, then recover the recording below.".into());
                        this.error = Some(format!("{error:#}"));
                    }
                    Err(join_error) => {
                        tracing::error!("recording stop task died: {join_error}");
                        this.storage_notice = low_storage.then(|| "Recording stopped because storage is low. Your recording files were kept. Free up space, then recover the recording below.".into());
                        this.error = Some("Stop task failed.".into());
                    }
                }
                this.finish(cx);
            })
            .ok();
        })
        .detach();
    }

    pub fn toggle_pause(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if crate::app_windows::clean_capture_active(cx) {
            self.toggle_clean_capture_pause(cx);
            return;
        }
        let Phase::Recording { paused } = self.phase else {
            return;
        };
        let Some(active) = self.active.as_ref() else {
            return;
        };

        // Optimistic flip; the actor call is fire-and-logged. The Tauri app
        // does the same through its mutation -- there is no rollback UI.
        self.phase = Phase::Recording { paused: !paused };
        if paused {
            if let Some(since) = self.paused_since.take() {
                self.paused_accum += since.elapsed();
            }
        } else {
            self.paused_since = Some(Instant::now());
        }
        cx.notify();

        let control = if paused {
            active.resume_handle()
        } else {
            active.pause_handle()
        };
        gpui_tokio::Tokio::spawn(cx, async move {
            if let Err(error) = control.await {
                tracing::error!("pause/resume failed: {error:#}");
            }
        })
        .detach();
    }

    #[cfg(target_os = "linux")]
    fn recording_owner(&self) -> Option<RecordingOwner> {
        self.active.as_ref().map(|active| RecordingOwner {
            generation: self.recording_generation,
            project_dir: active.project_dir.clone(),
        })
    }

    #[cfg(target_os = "linux")]
    pub fn instant_cleanup_safe(&self) -> bool {
        self.instant_attempt.as_ref().is_none_or(|attempt| {
            attempt.quiescence() == cap_recording::instant_recording::InstantQuiescence::Joined
        })
    }

    #[cfg(target_os = "linux")]
    pub fn clean_capture_controls_safe(&self) -> bool {
        clean_capture_controls_can_reveal(
            self.mode(),
            self.phase,
            self.clean_control
                .paused_for(self.recording_owner().as_ref()),
        )
    }

    #[cfg(target_os = "linux")]
    pub fn show_clean_capture_controls(&mut self, cx: &mut Context<Self>) {
        if self.mode() == Some(crate::recording::RecordingMode::Instant) {
            self.stop(cx);
            return;
        }
        self.show_controls_after_pause = true;
        if self.clean_capture_controls_safe() {
            cx.defer(crate::app_windows::show_main_window_after_capture_pause);
        } else if self.clean_control.pending.is_none() && !self.clean_control.uncertain {
            match self.phase {
                Phase::Recording { paused: true } => {
                    self.begin_clean_control(CleanControlKind::VerifyPaused, cx)
                }
                Phase::Recording { paused: false } => {
                    self.begin_clean_control(CleanControlKind::Pause, cx)
                }
                _ => {}
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn toggle_clean_capture_pause(&mut self, cx: &mut Context<Self>) {
        if self.clean_control.pending.is_some() || self.clean_control.uncertain {
            return;
        }
        let Phase::Recording { paused } = self.phase else {
            return;
        };
        self.begin_clean_control(
            if paused {
                CleanControlKind::Resume
            } else {
                CleanControlKind::Pause
            },
            cx,
        );
    }

    #[cfg(target_os = "linux")]
    fn begin_clean_control(&mut self, kind: CleanControlKind, cx: &mut Context<Self>) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let owner = RecordingOwner {
            generation: self.recording_generation,
            project_dir: active.project_dir.clone(),
        };
        let control = match kind {
            CleanControlKind::Resume => active.resume_handle(),
            CleanControlKind::Pause => active.pause_handle(),
            CleanControlKind::VerifyPaused => Box::pin(async { Ok(()) }),
        };
        let query_paused = active.is_paused_handle();
        let visibility = if kind == CleanControlKind::Resume {
            match crate::app_windows::hide_clean_capture_main(cx) {
                Ok(visibility) => Some(visibility),
                Err(error) => {
                    self.error = Some(error.to_string());
                    cx.notify();
                    return;
                }
            }
        } else {
            None
        };
        if kind == CleanControlKind::Resume {
            self.show_controls_after_pause = false;
        }
        let control = after_clean_visibility(visibility, control);
        let (ticket, registration) = self.clean_control.begin(owner, kind);
        cx.notify();
        let task = gpui_tokio::Tokio::spawn(
            cx,
            futures_util::future::Abortable::new(
                run_clean_control(kind, control, query_paused, async {
                    tokio::time::sleep(Duration::from_millis(150)).await
                }),
                registration,
            ),
        );
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let outcome = match result {
                Ok(Ok(outcome)) => outcome,
                Ok(Err(_)) => return,
                Err(error) => CleanControlOutcome {
                    paused: None,
                    error: Some(format!("Capture control task failed: {error}")),
                },
            };
            this.update(cx, |this, cx| {
                let owner = this.recording_owner();
                if !this
                    .clean_control
                    .complete(&ticket, owner.as_ref(), this.phase, &outcome)
                {
                    return;
                }
                if let Some(paused) = outcome.paused {
                    let was_paused = this.is_paused();
                    this.phase = Phase::Recording { paused };
                    if was_paused && !paused {
                        if let Some(since) = this.paused_since.take() {
                            this.paused_accum += since.elapsed();
                        }
                    } else if !was_paused && paused {
                        this.paused_since = Some(Instant::now());
                    }
                }
                if let Some(error) = outcome.error {
                    tracing::error!(%error, "clean capture pause/resume failed");
                    this.error = Some(format!(
                        "{error}. Use your recording Stop control to stop recording."
                    ));
                    if outcome.paused == Some(true) {
                        this.show_controls_after_pause = true;
                    }
                }
                if this.stop_requested {
                    this.stop(cx);
                } else if this.show_controls_after_pause && this.clean_capture_controls_safe() {
                    cx.defer(crate::app_windows::show_main_window_after_capture_pause);
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Cancel the live recording and delete its project directory (the bar's
    /// trash button).
    pub fn delete(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if self.clean_control.pending.is_some() || self.clean_control.uncertain {
            return;
        }
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
        #[cfg(target_os = "linux")]
        if self.mode() == Some(recording::RecordingMode::Instant) {
            self.discard_instant(None, cx);
            return;
        }
        #[cfg(windows)]
        if self.mode() == Some(recording::RecordingMode::Studio) {
            self.discard_windows_studio(None, cx);
            return;
        }
        self.storage_monitor = None;
        let Some(active) = self.active.take() else {
            return;
        };
        self.phase = Phase::Stopping;
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, active.cancel_and_delete());
        cx.spawn(async move |this, cx| {
            if let Ok(Err(error)) = task.await {
                tracing::error!("delete recording: {error:#}");
            }
            this.update(cx, |this, cx| this.finish(cx)).ok();
        })
        .detach();
    }

    /// The bar's restart button: throw away the live recording and immediately
    /// start a new one with the same config.
    pub fn restart(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if self.clean_control.pending.is_some() || self.clean_control.uncertain {
            return;
        }
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
        let Some(config) = self.last_config.clone() else {
            return;
        };
        #[cfg(target_os = "linux")]
        let config = {
            let mut config = config;
            if let Err(error) = crate::app_windows::refresh_linux_instant_camera(&mut config, cx) {
                self.error = Some(error.to_string());
                cx.notify();
                return;
            }
            config
        };
        #[cfg(target_os = "linux")]
        let clean_capture = crate::app_windows::clean_capture_active(cx);
        #[cfg(target_os = "linux")]
        if clean_capture {
            self.show_controls_after_pause = false;
        }
        #[cfg(target_os = "linux")]
        if self.mode() == Some(recording::RecordingMode::Instant) {
            self.discard_instant(Some(config), cx);
            return;
        }
        #[cfg(windows)]
        if self.mode() == Some(recording::RecordingMode::Studio) {
            self.discard_windows_studio(Some(config), cx);
            return;
        }
        #[cfg(target_os = "linux")]
        let restart_generation = self.recording_generation;
        self.storage_monitor = None;
        let Some(active) = self.active.take() else {
            return;
        };
        #[cfg(not(windows))]
        {
            self.failure_monitor = None;
        }
        self.phase = Phase::Starting;
        self.started_at = None;
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, active.cancel_and_delete());
        cx.spawn(async move |this, cx| {
            if let Ok(Err(error)) = task.await {
                tracing::error!("restart: discarding old recording: {error:#}");
            }
            #[cfg(target_os = "linux")]
            if !this
                .update(cx, |this, _| {
                    this.recording_generation == restart_generation && this.phase == Phase::Starting
                })
                .unwrap_or(false)
            {
                return;
            }
            #[cfg(target_os = "linux")]
            if clean_capture {
                let visibility = cx.update(|cx| {
                    crate::app_windows::hide_clean_capture_main(cx)
                        .map(|visibility| gpui_tokio::Tokio::spawn(cx, visibility))
                });
                let result = match visibility {
                    Ok(task) => task
                        .await
                        .map_err(anyhow::Error::from)
                        .and_then(|result| result),
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    this.update(cx, |this, cx| {
                        if this.recording_generation != restart_generation
                            || this.phase != Phase::Starting
                        {
                            return;
                        }
                        this.error = Some(format!("Restart could not hide Cap windows: {error}"));
                        this.finish(cx);
                    })
                    .ok();
                    return;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(150))
                    .await;
            }
            this.update(cx, |this, cx| {
                // Restart bypasses the Idle guard in `start` by construction:
                // we are in `Starting` and `start` would bail, so inline the
                // same transition.
                #[cfg(target_os = "linux")]
                if this.recording_generation != restart_generation || this.phase != Phase::Starting
                {
                    return;
                }
                #[cfg(target_os = "linux")]
                if this.stop_requested {
                    this.finish(cx);
                    return;
                }
                this.phase = Phase::Idle;
                this.start(config, cx);
            })
            .ok();
        })
        .detach();
    }

    #[cfg(windows)]
    fn discard_windows_studio(&mut self, restart: Option<StartConfig>, cx: &mut Context<Self>) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let Some(future) = active.windows_studio_delete_handle() else {
            return;
        };
        let directory = active.project_dir.clone();
        let generation = self.recording_generation;
        let phase = self.phase;
        self.storage_monitor = None;
        self.phase = Phase::Stopping;
        cx.notify();
        let task = gpui_tokio::Tokio::spawn(cx, future);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.recording_generation != generation
                    || this.phase != Phase::Stopping
                    || this
                        .active
                        .as_ref()
                        .is_none_or(|active| active.project_dir != directory)
                {
                    return;
                }
                match result {
                    Ok((true, Ok(_))) => {
                        this.active = None;
                        this.finish(cx);
                        if let Some(config) = restart {
                            this.start(config, cx);
                        }
                    }
                    result => {
                        this.phase = phase;
                        this.error = Some(match result {
                            Ok((_, Err(error))) => format!(
                                "{error:#}; discard/restart stopped, local recording retained"
                            ),
                            Err(error) => format!(
                                "Studio discard task failed: {error}; cleanup is unconfirmed"
                            ),
                            _ => {
                                "Studio discard stop was not acknowledged; local recording retained"
                                    .into()
                            }
                        });
                        cx.notify();
                    }
                }
            })
            .ok();
        })
        .detach();
    }

    #[cfg(target_os = "linux")]
    fn discard_instant(&mut self, restart: Option<StartConfig>, cx: &mut Context<Self>) {
        let Some(active) = self.active.as_ref() else {
            return;
        };
        let Some(future) = active.instant_delete_handle() else {
            return;
        };
        let owner = self.recording_owner().unwrap();
        self.terminal_operation = self.terminal_operation.wrapping_add(1);
        let operation = self.terminal_operation;
        let ticket = TerminalTicket {
            owner: owner.clone(),
            operation,
        };
        self.storage_monitor = None;
        self.failure_monitor = None;
        self.clean_control.invalidate();
        self.phase = Phase::Stopping;
        self.stop_requested = false;
        let settle = restart.is_some() && crate::app_windows::clean_capture_active(cx);
        cx.notify();
        let task = gpui_tokio::Tokio::spawn(cx, future);
        cx.spawn(async move |this, cx| {
            let result = task.await;
            let continue_restart = this.update(cx, |this, cx| {
                if !ticket.is_current(this.phase, this.recording_generation, this.terminal_operation, this.recording_owner().as_ref(), true) { return false; }
                match result {
                    Ok((true, Ok(_))) => {
                        this.active = None;
                        if restart.is_some() && !this.stop_requested { true } else { this.finish(cx); false }
                    }
                    Ok((true, Err(error))) => {
                        this.active = None;
                        this.error = Some(format!("{error:#}. Failed recording files were preserved."));
                        this.finish(cx);
                        false
                    }
                    result => {
                        this.phase = Phase::Recording { paused: false };
                        this.clean_control.uncertain = true;
                        this.error = Some(match result {
                            Ok((_, Err(error))) => format!("{error:#}. Cleanup is unconfirmed; retry Stop."),
                            Err(error) => format!("Cancel task failed: {error}. Cleanup is unconfirmed; retry Stop."),
                            _ => "Capture cleanup is unconfirmed; retry Stop.".into(),
                        });
                        cx.notify();
                        false
                    }
                }
            }).unwrap_or(false);
            if !continue_restart { return; }
            if settle {
                let visibility = cx.update(|cx| crate::app_windows::hide_clean_capture_main(cx)
                    .map(|visibility| gpui_tokio::Tokio::spawn(cx, visibility)));
                let result = match visibility {
                    Ok(task) => task.await.map_err(anyhow::Error::from).and_then(|result| result),
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    this.update(cx, |this, cx| {
                        if ticket.is_current(this.phase, this.recording_generation, this.terminal_operation, None, false) && this.active.is_none() {
                            this.error = Some(format!("Restart could not hide Cap windows: {error}"));
                            this.finish(cx);
                        }
                    }).ok();
                    return;
                }
                cx.background_executor().timer(Duration::from_millis(150)).await;
            }
            this.update(cx, |this, cx| {
                if !ticket.is_current(this.phase, this.recording_generation, this.terminal_operation, None, false) || this.active.is_some() { return; }
                if this.stop_requested { this.finish(cx); return; }
                if !this.instant_cleanup_safe() { this.finish(cx); return; }
                this.phase = Phase::Idle;
                this.start(restart.unwrap(), cx);
            }).ok();
        }).detach();
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "linux")]
        if !self.instant_cleanup_safe() {
            self.clean_control.uncertain = true;
            self.error = Some("Capture cleanup is unconfirmed. Local files are preserved; use Ctrl+Shift+F9 to retry Stop.".into());
            self.phase = if self.active.is_some() {
                Phase::Recording { paused: false }
            } else {
                Phase::Starting
            };
            cx.notify();
            return;
        }
        #[cfg(target_os = "linux")]
        {
            self.stop_requested = false;
            self.clean_control.invalidate();
            self.clean_control.uncertain = false;
            self.show_controls_after_pause = false;
        }
        self.failure_monitor = None;
        self.pipeline_failed = false;
        self.storage_monitor = None;
        self.phase = Phase::Idle;
        self.mic_muted = false;
        self.storage_warning = false;
        self.stopped_elapsed = None;
        self.started_at = None;
        self.paused_accum = Duration::ZERO;
        self.paused_since = None;
        cx.notify();
    }
}

fn recording_failure_is_current(phase: Phase, current: u64, completed: u64) -> bool {
    current == completed && matches!(phase, Phase::Recording { .. })
}

#[cfg(target_os = "linux")]
fn clean_capture_stop_must_wait(phase: Phase, transition: Option<CleanControlKind>) -> bool {
    phase == Phase::Starting || transition == Some(CleanControlKind::Pause)
}

#[cfg(target_os = "linux")]
fn clean_capture_controls_can_reveal(
    mode: Option<crate::recording::RecordingMode>,
    phase: Phase,
    paused_acknowledged: bool,
) -> bool {
    mode == Some(crate::recording::RecordingMode::Studio)
        && phase == (Phase::Recording { paused: true })
        && paused_acknowledged
}

#[cfg(all(test, target_os = "linux"))]
mod clean_capture_tests {
    use super::*;

    #[tokio::test]
    async fn resume_waits_for_visibility_before_polling_capture_control() {
        let (send, receive) = flume::bounded::<()>(1);
        let polled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = polled.clone();
        let visibility = Box::pin(async move {
            receive.recv_async().await?;
            Ok(())
        });
        let control = async move {
            observed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        };
        let mut pending = Box::pin(after_clean_visibility(Some(visibility), control));
        assert!(futures_util::poll!(&mut pending).is_pending());
        assert!(!polled.load(std::sync::atomic::Ordering::SeqCst));
        send.send(()).unwrap();
        pending.await.unwrap();
        assert!(polled.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn failed_visibility_never_resumes_capture() {
        let visibility = Box::pin(async { anyhow::bail!("unmap not acknowledged") });
        let control = async { Err(anyhow::anyhow!("capture control must not be polled")) };
        assert_eq!(
            after_clean_visibility(Some(visibility), control)
                .await
                .unwrap_err()
                .to_string(),
            "unmap not acknowledged"
        );
    }

    #[test]
    fn instant_pause_never_authorizes_mapping_recording_controls() {
        for paused_acknowledged in [false, true] {
            for phase in [
                Phase::Idle,
                Phase::Starting,
                Phase::Recording { paused: false },
                Phase::Recording { paused: true },
                Phase::Stopping,
            ] {
                assert!(!clean_capture_controls_can_reveal(
                    Some(crate::recording::RecordingMode::Instant),
                    phase,
                    paused_acknowledged,
                ));
                assert_eq!(
                    clean_capture_controls_can_reveal(
                        Some(crate::recording::RecordingMode::Studio),
                        phase,
                        paused_acknowledged,
                    ),
                    phase == (Phase::Recording { paused: true }) && paused_acknowledged,
                );
            }
        }
    }

    #[test]
    fn recording_failure_targets_only_the_current_recording() {
        for paused in [false, true] {
            assert!(recording_failure_is_current(
                Phase::Recording { paused },
                2,
                2
            ));
            assert!(!recording_failure_is_current(
                Phase::Recording { paused },
                2,
                1
            ));
        }
    }

    #[test]
    fn recording_failure_does_not_repeat_stop_or_interrupt_restart() {
        for phase in [Phase::Idle, Phase::Starting, Phase::Stopping] {
            assert!(!recording_failure_is_current(phase, 2, 2));
        }
    }

    #[test]
    fn stop_waits_only_for_start_and_pause_acknowledgement() {
        assert!(clean_capture_stop_must_wait(Phase::Starting, None));
        for paused in [true, false] {
            let phase = Phase::Recording { paused };
            assert!(clean_capture_stop_must_wait(
                phase,
                Some(CleanControlKind::Pause)
            ));
            for kind in [
                None,
                Some(CleanControlKind::Resume),
                Some(CleanControlKind::VerifyPaused),
            ] {
                assert!(!clean_capture_stop_must_wait(phase, kind));
            }
        }
    }
    fn owner(generation: u64, project: &str) -> RecordingOwner {
        RecordingOwner {
            generation,
            project_dir: project.into(),
        }
    }

    #[tokio::test]
    async fn pause_only_reveals_after_the_same_actor_acknowledges_paused() {
        let owner = owner(1, "recording-a");
        let mut state = CleanControlState::default();
        let (ticket, registration) = state.begin(owner.clone(), CleanControlKind::Pause);
        let (queried_tx, queried_rx) = tokio::sync::oneshot::channel();
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
        let mut task = tokio::spawn(futures_util::future::Abortable::new(
            run_clean_control(
                CleanControlKind::Pause,
                async { Ok(()) },
                async {
                    queried_tx.send(()).unwrap();
                    Ok(ack_rx.await.unwrap())
                },
                async {},
            ),
            registration,
        ));
        queried_rx.await.unwrap();
        assert!(!state.paused_for(Some(&owner)));
        assert!(clean_capture_stop_must_wait(
            Phase::Recording { paused: false },
            state.pending_kind()
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut task)
                .await
                .is_err()
        );
        ack_tx.send(true).unwrap();
        let outcome = task.await.unwrap().unwrap();
        assert!(outcome.error.is_none());
        assert!(state.complete(
            &ticket,
            Some(&owner),
            Phase::Recording { paused: false },
            &outcome
        ));
        assert!(state.paused_for(Some(&owner)));
    }

    #[tokio::test]
    async fn failed_resume_or_pause_requires_true_paused_acknowledgement() {
        for kind in [CleanControlKind::Resume, CleanControlKind::Pause] {
            for acknowledged in [true, false] {
                let outcome = run_clean_control(
                    kind,
                    async { anyhow::bail!("setup or teardown failed") },
                    async { Ok(acknowledged) },
                    async {},
                )
                .await;
                assert!(outcome.error.is_some());
                assert_eq!(outcome.paused, acknowledged.then_some(true));
                let owner = owner(1, "recording-a");
                let mut state = CleanControlState::default();
                let (ticket, _) = state.begin(owner.clone(), kind);
                assert!(state.complete(
                    &ticket,
                    Some(&owner),
                    Phase::Recording { paused: true },
                    &outcome
                ));
                assert_eq!(state.paused_for(Some(&owner)), acknowledged);
                assert_eq!(state.uncertain, !acknowledged);
            }
        }
    }

    #[tokio::test]
    async fn actor_transport_error_never_confirms_a_safe_pause() {
        let outcome = run_clean_control(
            CleanControlKind::Pause,
            async { Ok(()) },
            async { anyhow::bail!("actor stopped") },
            async {},
        )
        .await;
        assert_eq!(outcome.paused, None);
        assert!(outcome.error.unwrap().contains("actor stopped"));
    }

    #[tokio::test]
    async fn stop_interrupts_a_blocked_resume_without_waiting_for_control_completion() {
        struct Dropped(std::sync::Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::Release);
            }
        }
        let owner = owner(2, "recording-b");
        let mut state = CleanControlState::default();
        let (ticket, registration) = state.begin(owner.clone(), CleanControlKind::Resume);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let control_dropped = dropped.clone();
        let task = tokio::spawn(futures_util::future::Abortable::new(
            run_clean_control(
                CleanControlKind::Resume,
                async move {
                    let _guard = Dropped(control_dropped);
                    started_tx.send(()).unwrap();
                    std::future::pending::<anyhow::Result<()>>().await
                },
                async { panic!("A cancelled resume must not query state") },
                async {},
            ),
            registration,
        ));
        started_rx.await.unwrap();
        assert!(!clean_capture_stop_must_wait(
            Phase::Recording { paused: true },
            state.pending_kind()
        ));
        state.invalidate();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        let stopping = tokio::spawn(async move {
            stop_tx.send(()).unwrap();
        });
        tokio::time::timeout(Duration::from_secs(1), stop_rx)
            .await
            .unwrap()
            .unwrap();
        stopping.await.unwrap();
        assert!(task.await.unwrap().is_err());
        assert!(dropped.load(std::sync::atomic::Ordering::Acquire));
        assert!(!state.complete(
            &ticket,
            Some(&owner),
            Phase::Stopping,
            &CleanControlOutcome {
                paused: Some(true),
                error: None
            }
        ));
    }

    #[tokio::test]
    async fn stop_during_hidden_window_settle_never_dispatches_resume() {
        let owner = owner(1, "recording-a");
        let mut state = CleanControlState::default();
        let (_, registration) = state.begin(owner, CleanControlKind::Resume);
        let (settled_tx, settled_rx) = tokio::sync::oneshot::channel();
        let dispatched = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let called = dispatched.clone();
        let task = tokio::spawn(futures_util::future::Abortable::new(
            run_clean_control(
                CleanControlKind::Resume,
                async move {
                    called.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                },
                async { Ok(false) },
                async {
                    settled_tx.send(()).unwrap();
                    std::future::pending::<()>().await;
                },
            ),
            registration,
        ));
        settled_rx.await.unwrap();
        state.invalidate();
        assert!(task.await.unwrap().is_err());
        assert!(!dispatched.load(std::sync::atomic::Ordering::Acquire));
    }

    #[tokio::test]
    async fn queued_control_completion_cannot_clear_a_newer_recording_or_operation() {
        for next_owner in [
            owner(1, "recording-a"),
            owner(2, "recording-a"),
            owner(1, "recording-b"),
        ] {
            let prior = owner(1, "recording-a");
            let mut state = CleanControlState::default();
            let (ticket, _) = state.begin(prior, CleanControlKind::Pause);
            let outcome = run_clean_control(
                CleanControlKind::Pause,
                async { Ok(()) },
                async { Ok(true) },
                async {},
            )
            .await;
            let (next_ticket, _) = state.begin(next_owner.clone(), CleanControlKind::Resume);
            assert!(!state.complete(
                &ticket,
                Some(&next_owner),
                Phase::Recording { paused: true },
                &outcome
            ));
            assert_eq!(state.pending.as_ref().unwrap().ticket, next_ticket);
            assert!(!state.paused_for(Some(&next_owner)));
        }
    }

    #[tokio::test]
    async fn successful_resume_requires_nonpaused_ack_and_never_authorizes_main() {
        let outcome = run_clean_control(
            CleanControlKind::Resume,
            async { Ok(()) },
            async { Ok(false) },
            async {},
        )
        .await;
        assert_eq!(outcome.paused, Some(false));
        assert!(outcome.error.is_none());
        let owner = owner(1, "recording-a");
        let mut state = CleanControlState::default();
        let (ticket, _) = state.begin(owner.clone(), CleanControlKind::Resume);
        assert!(state.complete(
            &ticket,
            Some(&owner),
            Phase::Recording { paused: true },
            &outcome
        ));
        assert!(!state.paused_for(Some(&owner)));
        assert!(!state.uncertain);
    }
    #[tokio::test]
    async fn missing_paused_acknowledgement_times_out_without_authorizing_main() {
        let outcome = run_clean_control(
            CleanControlKind::Pause,
            async { Ok(()) },
            std::future::pending::<anyhow::Result<bool>>(),
            async {},
        )
        .await;
        assert_eq!(outcome.paused, None);
        assert!(outcome.error.unwrap().contains("Timed out"));
    }
}

#[cfg(all(test, target_os = "linux"))]
mod instant_terminal_tests {
    use super::*;

    fn owner(generation: u64, directory: &str) -> RecordingOwner {
        RecordingOwner {
            generation,
            project_dir: directory.into(),
        }
    }

    #[tokio::test]
    async fn late_stop_completion_cannot_release_a_retry_or_new_recording() {
        let original = owner(3, "original.cap");
        let ticket = TerminalTicket {
            owner: original.clone(),
            operation: 1,
        };
        let (complete, completed) = tokio::sync::oneshot::channel();
        let operation = async {
            completed.await.unwrap();
            ticket
        };
        tokio::pin!(operation);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut operation)
                .await
                .is_err()
        );
        complete.send(()).unwrap();
        let ticket = operation.await;
        assert!(!ticket.is_current(Phase::Stopping, 3, 2, Some(&original), true));
        assert!(!ticket.is_current(Phase::Stopping, 4, 1, Some(&owner(4, "next.cap")), true));
        assert!(!ticket.is_current(
            Phase::Stopping,
            3,
            1,
            Some(&owner(3, "different.cap")),
            true
        ));
        assert!(ticket.is_current(Phase::Stopping, 3, 1, Some(&original), true));
    }

    #[tokio::test]
    async fn restart_settle_completion_cannot_override_stop_or_later_generation() {
        let ticket = TerminalTicket {
            owner: owner(8, "prior.cap"),
            operation: 5,
        };
        let (release, wait) = tokio::sync::oneshot::channel();
        let settle = async {
            wait.await.unwrap();
            ticket
        };
        tokio::pin!(settle);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), &mut settle)
                .await
                .is_err()
        );
        release.send(()).unwrap();
        let ticket = settle.await;
        assert!(!ticket.is_current(Phase::Idle, 8, 5, None, false));
        assert!(!ticket.is_current(Phase::Starting, 9, 5, None, false));
        assert!(ticket.is_current(Phase::Stopping, 8, 5, None, false));
    }
}

#[cfg(test)]
mod recording_failure_tests {
    use super::*;

    #[test]
    fn only_current_recording_failure_can_request_stop() {
        for paused in [false, true] {
            assert!(recording_failure_is_current(
                Phase::Recording { paused },
                4,
                4
            ));
            assert!(!recording_failure_is_current(
                Phase::Recording { paused },
                5,
                4
            ));
        }
    }

    #[test]
    fn late_failure_does_not_interrupt_start_stop_or_idle() {
        for phase in [Phase::Idle, Phase::Starting, Phase::Stopping] {
            assert!(!recording_failure_is_current(phase, 4, 4));
        }
    }
}
