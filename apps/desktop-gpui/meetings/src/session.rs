use serde::{Deserialize, Serialize};

use crate::Millis;
use crate::detect::DetectEvent;
use crate::transcript::Source;

#[cfg(test)]
mod tests;

const START_TIMEOUT_MS: u64 = 30_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    User,
    UserFromIndicator,
    CallEnded,
    CallEndedNearEventEnd,
    Inactivity,
    Sleep,
    Quit,
    Replaced,
    Error,
    Deleted,
}

impl StopReason {
    fn allows_notes(self) -> bool {
        !matches!(self, StopReason::Quit | StopReason::Deleted)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Idle,
    Starting,
    Recording,
    Stopping,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Warning {
    Ending { stop_at: Millis, reason: StopReason },
    Inactivity { stop_at: Millis },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionAction {
    StartCapture {
        resume: bool,
    },
    StopCapture {
        reason: StopReason,
    },
    ShowEndingCountdown {
        stop_at: Millis,
    },
    ShowInactivityWarning {
        stop_at: Millis,
    },
    ClearWarning,
    OfferResume {
        until: Millis,
    },
    GenerateNotes,
    /// A call began early in a meeting started without one: the meeting is
    /// that call's now, and ends with it.
    JoinedCall {
        app_id: String,
    },
    /// That call ended before the meeting had a minute of speech: it was not
    /// what these notes are for, and the meeting goes on without it.
    LeftCall,
}

/// Which call that begins in a meeting started without one, within the join
/// window, is that meeting's own (and ends it however short) rather than a
/// call joined late.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OwnCall {
    /// Cap opened the meeting's link as its notes started.
    pub joining: bool,
    /// The call app the linked calendar event's link opens in.
    pub link_app: Option<String>,
}

impl OwnCall {
    /// The link's own app always is. After Cap opened the link, so is a
    /// browser (any link can open there) or, for a link without an app of
    /// its own, whichever app takes the call; another call app is not.
    fn is(&self, app_id: &str) -> bool {
        if self.link_app.as_deref() == Some(app_id) {
            return true;
        }
        self.joining
            && (self.link_app.is_none()
                || crate::apps::app_by_id(app_id)
                    .is_some_and(|app| app.kind == crate::apps::AppKind::Browser))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionConfig {
    pub stop_when_call_ends: bool,
    pub near_event_end_ms: u64,
    pub ending_countdown_ms: u64,
    pub ending_countdown_far_ms: u64,
    pub inactivity_warn_ms: Option<u64>,
    pub inactivity_stop_after_ms: u64,
    pub resume_offer_ms: u64,
    pub min_transcript_chars: usize,
    pub auto_generate_notes: bool,
    /// How long after a start without a call one that begins is taken as
    /// the meeting's (Start notes first, then join).
    pub join_window_ms: u64,
    /// The speech a meeting needs before a call it joined can end it.
    pub joined_call_min_speech_ms: u64,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            stop_when_call_ends: true,
            near_event_end_ms: 300_000,
            ending_countdown_ms: 10_000,
            ending_countdown_far_ms: 20_000,
            inactivity_warn_ms: Some(600_000),
            inactivity_stop_after_ms: 120_000,
            resume_offer_ms: 30_000,
            min_transcript_chars: 400,
            auto_generate_notes: true,
            join_window_ms: 300_000,
            joined_call_min_speech_ms: 60_000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PendingNotes {
    reason: StopReason,
    chars: Option<usize>,
}

#[derive(Debug)]
pub struct Session {
    config: SessionConfig,
    state: SessionState,
    now: Millis,
    app_id: Option<String>,
    event_end: Option<Millis>,
    segment_started_at: Option<Millis>,
    recorded_before_ms: u64,
    mic_speech_ms: u64,
    system_speech_ms: u64,
    last_activity: Millis,
    warning: Option<Warning>,
    call_end_suppressed: bool,
    /// The call was joined after the meeting started without one.
    joined_late: bool,
    own_call: OwnCall,
    resume_offer_until: Option<Millis>,
    resume_queued: bool,
    has_meeting: bool,
    asleep: bool,
    /// Sleep stopped a meeting (or came while its Resume was offered): wake
    /// offers Resume, as inactivity does, before the notes are written.
    offer_on_wake: bool,
    pending_notes: Option<PendingNotes>,
    last_stop: Option<StopReason>,
    starting_since: Option<Millis>,
    resuming: bool,
    last_chars: usize,
}

impl Session {
    pub fn new(config: SessionConfig) -> Self {
        Self {
            config,
            state: SessionState::Idle,
            now: Millis::ZERO,
            app_id: None,
            event_end: None,
            segment_started_at: None,
            recorded_before_ms: 0,
            mic_speech_ms: 0,
            system_speech_ms: 0,
            last_activity: Millis::ZERO,
            warning: None,
            call_end_suppressed: false,
            joined_late: false,
            own_call: OwnCall::default(),
            resume_offer_until: None,
            resume_queued: false,
            has_meeting: false,
            asleep: false,
            offer_on_wake: false,
            pending_notes: None,
            last_stop: None,
            starting_since: None,
            resuming: false,
            last_chars: 0,
        }
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: SessionConfig) {
        self.config = config;
    }

    pub fn state(&self) -> SessionState {
        self.state
    }

    pub fn warning(&self) -> Option<Warning> {
        self.warning
    }

    pub fn attached_app(&self) -> Option<&str> {
        self.app_id.as_deref()
    }

    pub fn last_stop_reason(&self) -> Option<StopReason> {
        self.last_stop
    }

    pub fn resume_offer_until(&self) -> Option<Millis> {
        self.resume_offer_until
    }

    /// Sleep stopped the meeting and wake will offer to resume it.
    pub fn offers_resume_on_wake(&self) -> bool {
        self.offer_on_wake
    }

    pub fn speech_ms(&self, source: Source) -> u64 {
        match source {
            Source::Mic => self.mic_speech_ms,
            Source::System => self.system_speech_ms,
        }
    }

    pub fn recorded_ms(&self) -> u64 {
        let current = match (self.state, self.segment_started_at) {
            (SessionState::Recording, Some(started)) => self.now.since(started),
            _ => 0,
        };
        self.recorded_before_ms.saturating_add(current)
    }

    pub fn set_attached_app(&mut self, app_id: Option<String>) {
        if self.app_id != app_id {
            self.call_end_suppressed = false;
        }
        self.app_id = app_id;
    }

    pub fn set_linked_event_end(&mut self, end: Option<Millis>) {
        self.event_end = end;
    }

    pub fn set_own_call(&mut self, own_call: OwnCall) {
        self.own_call = own_call;
    }

    pub fn start(&mut self, now: Millis, app_id: Option<String>) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.state != SessionState::Idle {
            return out;
        }
        self.resume_offer_until = None;
        self.offer_on_wake = false;
        self.flush_notes(&mut out);
        self.pending_notes = None;
        self.app_id = app_id;
        self.joined_late = false;
        self.own_call = OwnCall::default();
        self.event_end = None;
        self.recorded_before_ms = 0;
        self.mic_speech_ms = 0;
        self.system_speech_ms = 0;
        self.call_end_suppressed = false;
        self.has_meeting = true;
        self.begin(now, false, &mut out);
        out
    }

    pub fn resume(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if !self.has_meeting || self.asleep {
            return out;
        }
        match self.state {
            SessionState::Idle => {
                self.resume_offer_until = None;
                self.pending_notes = None;
                self.begin(now, true, &mut out);
            }
            SessionState::Stopping => {
                self.resume_offer_until = None;
                self.resume_queued = true;
            }
            SessionState::Starting | SessionState::Recording => {}
        }
        out
    }

    pub fn decline_resume(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.resume_offer_until.take().is_some() {
            self.resume_queued = false;
            self.flush_notes(&mut out);
        }
        out
    }

    pub fn stop(&mut self, now: Millis, reason: StopReason) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if reason == StopReason::Deleted {
            self.resume_offer_until = None;
            self.offer_on_wake = false;
            self.resume_queued = false;
            self.pending_notes = None;
            self.has_meeting = false;
        }
        self.halt(now, reason, &mut out);
        out
    }

    pub fn on_capture_started(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.state == SessionState::Starting {
            self.state = SessionState::Recording;
            self.starting_since = None;
            self.segment_started_at = Some(now);
            self.last_activity = now;
        }
        out.extend(self.advance(now));
        out
    }

    pub fn on_capture_stopped(
        &mut self,
        now: Millis,
        transcript_chars: usize,
    ) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        match self.state {
            SessionState::Idle => return out,
            SessionState::Starting => {
                self.fail_start(Some(transcript_chars), &mut out);
                return out;
            }
            SessionState::Recording => self.halt(now, StopReason::Error, &mut out),
            SessionState::Stopping => {}
        }
        self.state = SessionState::Idle;
        self.last_chars = transcript_chars;
        if let Some(pending) = &mut self.pending_notes {
            pending.chars = Some(transcript_chars);
        }
        if std::mem::take(&mut self.resume_queued) && !self.asleep {
            self.pending_notes = None;
            self.begin(now, true, &mut out);
        } else {
            self.flush_notes(&mut out);
        }
        out
    }

    pub fn on_capture_error(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.state == SessionState::Starting {
            self.fail_start(None, &mut out);
        } else {
            self.halt(now, StopReason::Error, &mut out);
        }
        out
    }

    pub fn on_speech(
        &mut self,
        now: Millis,
        source: Source,
        duration_ms: u64,
    ) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if !matches!(self.state, SessionState::Recording | SessionState::Starting) {
            return out;
        }
        match source {
            Source::Mic => self.mic_speech_ms = self.mic_speech_ms.saturating_add(duration_ms),
            Source::System => {
                self.system_speech_ms = self.system_speech_ms.saturating_add(duration_ms)
            }
        }
        if duration_ms > 0 {
            self.last_activity = now;
            if let Some(Warning::Inactivity { .. }) = self.warning {
                self.warning = None;
                out.push(SessionAction::ClearWarning);
            }
        }
        out
    }

    pub fn on_detect(&mut self, now: Millis, event: &DetectEvent) -> Vec<SessionAction> {
        match event {
            DetectEvent::CallStarted(call) => self.on_call_started(now, &call.app_id),
            DetectEvent::CallEnded { app_id, .. } => self.on_call_ended(now, app_id),
            _ => {
                let now = self.clamp(now);
                self.advance(now)
            }
        }
    }

    pub fn on_call_started(&mut self, now: Millis, app_id: &str) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.app_id.as_deref() != Some(app_id) {
            if self.app_id.is_none()
                && matches!(self.state, SessionState::Starting | SessionState::Recording)
                && self.recorded_ms() < self.config.join_window_ms
            {
                self.app_id = Some(app_id.to_string());
                self.joined_late = !self.own_call.is(app_id);
                self.call_end_suppressed = false;
                out.push(SessionAction::JoinedCall {
                    app_id: app_id.to_string(),
                });
            } else if self.hands_over_to(app_id) {
                // A browser held the meeting's call (a pre-join page, the web
                // client) and the linked event's own app now takes it: the
                // meeting is that app's call, and the browser letting go
                // does not end it.
                self.app_id = Some(app_id.to_string());
                self.joined_late = false;
                self.call_end_suppressed = false;
                if let Some(Warning::Ending { .. }) = self.warning {
                    self.warning = None;
                    out.push(SessionAction::ClearWarning);
                }
                out.push(SessionAction::JoinedCall {
                    app_id: app_id.to_string(),
                });
            }
            return out;
        }
        self.call_end_suppressed = false;
        if let Some(Warning::Ending { .. }) = self.warning {
            self.warning = None;
            out.push(SessionAction::ClearWarning);
        }
        out
    }

    /// The linked event's own call app takes over a meeting whose call a
    /// browser holds.
    fn hands_over_to(&self, app_id: &str) -> bool {
        matches!(self.state, SessionState::Starting | SessionState::Recording)
            && self.own_call.link_app.as_deref() == Some(app_id)
            && self
                .app_id
                .as_deref()
                .and_then(crate::apps::app_by_id)
                .is_some_and(|app| app.kind == crate::apps::AppKind::Browser)
    }

    pub fn on_call_ended(&mut self, now: Millis, app_id: &str) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.state != SessionState::Recording
            || self.app_id.as_deref() != Some(app_id)
            || !self.config.stop_when_call_ends
            || self.call_end_suppressed
            || matches!(self.warning, Some(Warning::Ending { .. }))
        {
            return out;
        }
        if self.joined_late
            && self.mic_speech_ms.saturating_add(self.system_speech_ms)
                < self.config.joined_call_min_speech_ms
        {
            self.app_id = None;
            self.joined_late = false;
            out.push(SessionAction::LeftCall);
            return out;
        }
        // Every call that ends gets the countdown, however short: a three
        // minute standup that ended is over too. A call app that drops the
        // microphone for a moment takes it back within the countdown (which
        // clears it), and "Keep recording" covers a false end.
        let near_end = self.event_end.is_some_and(|end| {
            let distance = if now >= end {
                now.since(end)
            } else {
                end.since(now)
            };
            distance <= self.config.near_event_end_ms
        });
        let (countdown, reason) = if near_end {
            (
                self.config.ending_countdown_ms,
                StopReason::CallEndedNearEventEnd,
            )
        } else {
            (self.config.ending_countdown_far_ms, StopReason::CallEnded)
        };
        let stop_at = now.plus(countdown);
        self.warning = Some(Warning::Ending { stop_at, reason });
        out.push(SessionAction::ShowEndingCountdown { stop_at });
        out
    }

    pub fn keep_recording(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        match self.warning.take() {
            Some(Warning::Ending { .. }) => {
                // Asking to keep recording is the person being there, as
                // for the inactivity warning: an ended call can replace that
                // warning, and its deadline must not come back already due.
                self.call_end_suppressed = true;
                self.last_activity = now;
                out.push(SessionAction::ClearWarning);
            }
            Some(Warning::Inactivity { .. }) => {
                self.last_activity = now;
                out.push(SessionAction::ClearWarning);
            }
            None => {}
        }
        out
    }

    pub fn on_sleep(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if self.asleep {
            return out;
        }
        self.asleep = true;
        let recording = matches!(self.state, SessionState::Starting | SessionState::Recording);
        let offered = self.resume_offer_until.is_some() || self.resume_queued;
        self.offer_on_wake = self.has_meeting && (recording || offered || self.offer_on_wake);
        self.resume_queued = false;
        self.resume_offer_until = None;
        self.halt(now, StopReason::Sleep, &mut out);
        out
    }

    pub fn on_wake(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        let mut out = self.advance(now);
        if !self.asleep {
            return out;
        }
        self.asleep = false;
        self.last_activity = now;
        if std::mem::take(&mut self.offer_on_wake) {
            let until = now.plus(self.config.resume_offer_ms);
            self.resume_offer_until = Some(until);
            out.push(SessionAction::OfferResume { until });
        }
        self.flush_notes(&mut out);
        out
    }

    pub fn tick(&mut self, now: Millis) -> Vec<SessionAction> {
        let now = self.clamp(now);
        self.advance(now)
    }

    pub fn next_deadline(&self) -> Option<Millis> {
        let warning = match self.warning {
            Some(Warning::Ending { stop_at, .. } | Warning::Inactivity { stop_at }) => {
                Some(stop_at)
            }
            None => self.inactivity_due(),
        };
        let start_timeout = match (self.state, self.starting_since) {
            (SessionState::Starting, Some(since)) => Some(since.plus(START_TIMEOUT_MS)),
            _ => None,
        };
        [warning, self.resume_offer_until, start_timeout]
            .into_iter()
            .flatten()
            .min()
    }

    fn clamp(&mut self, now: Millis) -> Millis {
        self.now = self.now.max(now);
        self.now
    }

    fn inactivity_due(&self) -> Option<Millis> {
        if self.state != SessionState::Recording || self.asleep || self.warning.is_some() {
            return None;
        }
        self.config
            .inactivity_warn_ms
            .map(|warn| self.last_activity.plus(warn))
    }

    fn begin(&mut self, now: Millis, resume: bool, out: &mut Vec<SessionAction>) {
        self.state = SessionState::Starting;
        self.starting_since = Some(now);
        self.resuming = resume;
        self.warning = None;
        self.last_activity = now;
        self.segment_started_at = None;
        out.push(SessionAction::StartCapture { resume });
    }

    fn halt(&mut self, now: Millis, reason: StopReason, out: &mut Vec<SessionAction>) {
        if !matches!(self.state, SessionState::Starting | SessionState::Recording) {
            return;
        }
        if self.warning.take().is_some() {
            out.push(SessionAction::ClearWarning);
        }
        if let (SessionState::Recording, Some(started)) = (self.state, self.segment_started_at) {
            self.recorded_before_ms = self.recorded_before_ms.saturating_add(now.since(started));
        }
        self.segment_started_at = None;
        self.starting_since = None;
        self.state = SessionState::Stopping;
        self.last_stop = Some(reason);
        self.pending_notes = (reason != StopReason::Deleted).then_some(PendingNotes {
            reason,
            chars: None,
        });
        out.push(SessionAction::StopCapture { reason });
        if reason == StopReason::Inactivity {
            let until = now.plus(self.config.resume_offer_ms);
            self.resume_offer_until = Some(until);
            out.push(SessionAction::OfferResume { until });
        }
    }

    fn fail_start(&mut self, transcript_chars: Option<usize>, out: &mut Vec<SessionAction>) {
        self.state = SessionState::Idle;
        self.starting_since = None;
        self.segment_started_at = None;
        self.last_stop = Some(StopReason::Error);
        self.resume_queued = false;
        out.push(SessionAction::StopCapture {
            reason: StopReason::Error,
        });
        self.pending_notes = std::mem::take(&mut self.resuming).then(|| PendingNotes {
            reason: StopReason::Error,
            chars: Some(
                transcript_chars
                    .unwrap_or(self.last_chars)
                    .max(self.last_chars),
            ),
        });
        self.flush_notes(out);
    }

    fn flush_notes(&mut self, out: &mut Vec<SessionAction>) {
        let Some(pending) = self.pending_notes else {
            return;
        };
        let Some(chars) = pending.chars else {
            return;
        };
        if self.asleep || self.resume_offer_until.is_some() || self.resume_queued {
            return;
        }
        self.pending_notes = None;
        if pending.reason.allows_notes()
            && self.config.auto_generate_notes
            && chars >= self.config.min_transcript_chars
        {
            out.push(SessionAction::GenerateNotes);
        }
    }

    fn advance(&mut self, now: Millis) -> Vec<SessionAction> {
        let mut out = Vec::new();
        if self.state == SessionState::Starting
            && self
                .starting_since
                .is_some_and(|since| since.plus(START_TIMEOUT_MS) <= now)
        {
            self.fail_start(None, &mut out);
        }
        if let Some(Warning::Ending { stop_at, reason }) = self.warning
            && stop_at <= now
        {
            self.halt(now, reason, &mut out);
        }
        if let Some(Warning::Inactivity { stop_at }) = self.warning
            && stop_at <= now
        {
            self.halt(now, StopReason::Inactivity, &mut out);
        }
        if let Some(due) = self.inactivity_due()
            && due <= now
        {
            let stop_at = now.plus(self.config.inactivity_stop_after_ms);
            self.warning = Some(Warning::Inactivity { stop_at });
            out.push(SessionAction::ShowInactivityWarning { stop_at });
        }
        if let Some(until) = self.resume_offer_until
            && until <= now
        {
            self.resume_offer_until = None;
            self.resume_queued = false;
            self.flush_notes(&mut out);
        }
        out
    }
}
