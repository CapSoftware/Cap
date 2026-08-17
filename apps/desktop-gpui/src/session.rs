//! The app-wide recording session.
//!
//! Unit 1 kept the recording lifecycle on `MainWindow`; the controls bar makes
//! that untenable -- two windows now read and drive the same state. The session
//! is a plain gpui entity installed as a global, observed by both windows; all
//! engine work runs on tokio via `gpui_tokio` and lands back here with
//! `cx.notify()`.

use std::time::{Duration, Instant};

use gpui::{App, AppContext as _, Context, Entity, Global};

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

pub struct RecordingSession {
    pub phase: Phase,
    active: Option<ActiveRecording>,
    /// Why the last start attempt failed, for the main window to surface.
    pub error: Option<String>,
    /// The config of the live (or last) recording, kept for restart.
    last_config: Option<StartConfig>,
    /// True while the controls bar window is open, so the main window knows to
    /// fall back to its in-window overlay when the bar failed to open.
    pub controls_open: bool,
    /// Mirror of the recording-scoped mic mute flag (the engine zeroes the
    /// payloads; the flag itself lives on the live recording's mic lock and
    /// resets with every new session).
    pub mic_muted: bool,
    started_at: Option<Instant>,
    paused_accum: Duration,
    paused_since: Option<Instant>,
}

struct SessionGlobal(Entity<RecordingSession>);
impl Global for SessionGlobal {}

impl RecordingSession {
    pub fn init(cx: &mut App) -> Entity<Self> {
        let session = cx.new(|_| Self {
            phase: Phase::Idle,
            active: None,
            error: None,
            last_config: None,
            controls_open: false,
            mic_muted: false,
            started_at: None,
            paused_accum: Duration::ZERO,
            paused_since: None,
        });
        cx.set_global(SessionGlobal(session.clone()));
        session
    }

    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<SessionGlobal>().0.clone()
    }

    /// Elapsed recording time, excluding paused stretches -- what the bar's
    /// timer shows.
    pub fn elapsed(&self) -> Duration {
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
        self.phase = Phase::Starting;
        self.error = None;
        self.last_config = Some(config.clone());
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, recording::start(config));
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(active)) => {
                        tracing::info!(dir = %active.project_dir.display(), "recording started");
                        this.active = Some(active);
                        this.phase = Phase::Recording { paused: false };
                        // A fresh mic lock always starts unmuted.
                        this.mic_muted = false;
                        this.started_at = Some(Instant::now());
                        this.paused_accum = Duration::ZERO;
                        this.paused_since = None;
                    }
                    Ok(Err(error)) => {
                        tracing::error!("recording failed to start: {error:#}");
                        this.error = Some(format!("{error:#}"));
                        this.phase = Phase::Idle;
                    }
                    Err(join_error) => {
                        tracing::error!("recording start task died: {join_error}");
                        this.error = Some("Recording task failed.".into());
                        this.phase = Phase::Idle;
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
        let Some(active) = self.active.take() else {
            return;
        };
        self.phase = Phase::Stopping;
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, active.stop());
        cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                match result {
                    Ok(Ok(project_dir)) => {
                        // The completion affordance is Recents now: the main
                        // window comes back with this recording at the head of
                        // the carousel, thumbnail and all. Stop used to reveal
                        // the bundle in Finder as a stand-in; the Tauri app
                        // never does that, so it goes with the placeholder it
                        // was standing in for.
                        tracing::info!(dir = %project_dir.display(), "recording finished");
                    }
                    Ok(Err(error)) => {
                        tracing::error!("recording failed to stop cleanly: {error:#}");
                        this.error = Some(format!("{error:#}"));
                    }
                    Err(join_error) => {
                        tracing::error!("recording stop task died: {join_error}");
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

    /// Cancel the live recording and delete its project directory (the bar's
    /// trash button).
    pub fn delete(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
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
        if !matches!(self.phase, Phase::Recording { .. }) {
            return;
        }
        let Some(active) = self.active.take() else {
            return;
        };
        let Some(config) = self.last_config.clone() else {
            return;
        };
        self.phase = Phase::Starting;
        self.started_at = None;
        cx.notify();

        let task = gpui_tokio::Tokio::spawn(cx, active.cancel_and_delete());
        cx.spawn(async move |this, cx| {
            if let Ok(Err(error)) = task.await {
                tracing::error!("restart: discarding old recording: {error:#}");
            }
            this.update(cx, |this, cx| {
                // Restart bypasses the Idle guard in `start` by construction:
                // we are in `Starting` and `start` would bail, so inline the
                // same transition.
                this.phase = Phase::Idle;
                this.start(config, cx);
            })
            .ok();
        })
        .detach();
    }

    fn finish(&mut self, cx: &mut Context<Self>) {
        self.phase = Phase::Idle;
        self.mic_muted = false;
        self.started_at = None;
        self.paused_accum = Duration::ZERO;
        self.paused_since = None;
        cx.notify();
    }
}
