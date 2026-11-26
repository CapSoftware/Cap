use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::apps::{AppKind, CallNoun};
use crate::detect::{ActiveCall, DetectEvent};
use crate::{Millis, Now};

#[cfg(test)]
mod tests;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EventInfo {
    pub id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub has_link: bool,
    pub link_provider_name: Option<String>,
    pub attendee_count: u32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutoRecord {
    #[default]
    Off,
    Detected,
    Scheduled,
    Both,
}

impl AutoRecord {
    pub fn for_detected(self) -> bool {
        matches!(self, AutoRecord::Detected | AutoRecord::Both)
    }

    pub fn for_scheduled(self) -> bool {
        matches!(self, AutoRecord::Scheduled | AutoRecord::Both)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptConfig {
    pub detected_enabled: bool,
    pub scheduled_enabled: bool,
    pub muted_app_ids: Vec<String>,
    pub cooldown_ms: u64,
    pub visible_ms: u64,
    pub max_visible_ms: u64,
    pub auto_record: AutoRecord,
    pub auto_record_countdown_ms: u64,
    pub lead_ms: u64,
    pub reminder_tail_ms: u64,
    pub event_match_window_ms: u64,
    pub max_prompts: usize,
}

impl Default for PromptConfig {
    fn default() -> Self {
        Self {
            detected_enabled: true,
            scheduled_enabled: true,
            muted_app_ids: Vec::new(),
            cooldown_ms: 120_000,
            visible_ms: 20_000,
            max_visible_ms: 120_000,
            auto_record: AutoRecord::Off,
            auto_record_countdown_ms: 5_000,
            lead_ms: 60_000,
            reminder_tail_ms: 240_000,
            event_match_window_ms: 90_000,
            max_prompts: 3,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordingState {
    Idle,
    Starting { event_id: Option<String> },
    Recording { event_id: Option<String> },
}

impl RecordingState {
    pub fn is_active(&self) -> bool {
        !matches!(self, RecordingState::Idle)
    }

    pub fn event_id(&self) -> Option<&str> {
        match self {
            RecordingState::Idle => None,
            RecordingState::Starting { event_id } | RecordingState::Recording { event_id } => {
                event_id.as_deref()
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptKind {
    Detected,
    Scheduled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PromptSubtitle {
    App(String),
    TimeRange {
        start: DateTime<Utc>,
        end: DateTime<Utc>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Countdown {
    pub started_at: Millis,
    pub ends_at: Millis,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub id: u64,
    pub kind: PromptKind,
    pub title: String,
    pub subtitle: PromptSubtitle,
    pub detail: Option<String>,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    pub event: Option<EventInfo>,
    pub countdown: Option<Countdown>,
    pub shown_at: Millis,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DismissReason {
    TimedOut,
    CallEnded,
    RecordingStarted,
    User,
    Cancelled,
    Evicted,
    EventRemoved,
    EventRescheduled,
    EventOver,
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordSource {
    DetectedCall {
        app_id: String,
        event_id: Option<String>,
    },
    Scheduled {
        event_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptAction {
    Show(Prompt),
    Update(Prompt),
    Dismiss { id: u64, reason: DismissReason },
    StartRecording { source: RecordSource },
}

type CallKey = (String, Millis);
type EventKey = (String, i64);

fn event_key(event: &EventInfo) -> EventKey {
    (event.id.clone(), event.start.timestamp_millis())
}

#[derive(Debug)]
struct CallInfo {
    key: CallKey,
    app_name: String,
    noun: CallNoun,
    web_title: Option<String>,
}

#[derive(Debug)]
struct Slot {
    prompt: Prompt,
    shown_wall: DateTime<Utc>,
    call: Option<CallKey>,
    hovered: bool,
    unhovered_since: Millis,
    unhovered_used: u64,
}

#[derive(Debug)]
pub struct PromptPlanner {
    config: PromptConfig,
    clock: Option<Now>,
    slots: Vec<Slot>,
    next_id: u64,
    events: Vec<EventInfo>,
    calls: Vec<CallInfo>,
    prompted_calls: HashSet<CallKey>,
    last_detected: HashMap<String, Millis>,
    seen_events: HashSet<EventKey>,
    recording: RecordingState,
}

impl PromptPlanner {
    pub fn new(config: PromptConfig) -> Self {
        Self {
            config,
            clock: None,
            slots: Vec::new(),
            next_id: 1,
            events: Vec::new(),
            calls: Vec::new(),
            prompted_calls: HashSet::new(),
            last_detected: HashMap::new(),
            seen_events: HashSet::new(),
            recording: RecordingState::Idle,
        }
    }

    pub fn config(&self) -> &PromptConfig {
        &self.config
    }

    pub fn visible(&self) -> impl Iterator<Item = &Prompt> {
        self.slots.iter().map(|s| &s.prompt)
    }

    pub fn recording(&self) -> &RecordingState {
        &self.recording
    }

    pub fn set_config(&mut self, now: Now, config: PromptConfig) -> Vec<PromptAction> {
        let now = self.sync(now);
        self.config = config;
        let mut out = Vec::new();
        let config = &self.config;
        let auto = config.auto_record;
        let mut stale: Vec<u64> = Vec::new();
        let mut updated: Vec<u64> = Vec::new();
        for slot in &mut self.slots {
            let muted = slot
                .prompt
                .app_id
                .as_ref()
                .is_some_and(|a| config.muted_app_ids.contains(a));
            let (enabled, countdown_allowed) = match slot.prompt.kind {
                PromptKind::Detected => (
                    config.detected_enabled,
                    auto.for_detected() || auto.for_scheduled(),
                ),
                PromptKind::Scheduled => (config.scheduled_enabled, auto.for_scheduled()),
            };
            let drops_countdown = slot.prompt.countdown.is_some() && !countdown_allowed;
            if muted || (!enabled && (slot.prompt.countdown.is_none() || drops_countdown)) {
                stale.push(slot.prompt.id);
            } else if drops_countdown {
                slot.prompt.countdown = None;
                slot.unhovered_since = now.mono;
                updated.push(slot.prompt.id);
            }
        }
        for id in stale {
            self.remove(id, DismissReason::Disabled, &mut out);
        }
        for id in updated {
            if let Some(slot) = self.slots.iter().find(|s| s.prompt.id == id) {
                out.push(PromptAction::Update(slot.prompt.clone()));
            }
        }
        out.extend(self.advance(now));
        out
    }

    pub fn set_events(&mut self, now: Now, events: Vec<EventInfo>) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = self.advance(now);
        let mut unique: Vec<EventInfo> = Vec::with_capacity(events.len());
        for event in events {
            if !unique.iter().any(|e| e.id == event.id) {
                unique.push(event);
            }
        }
        self.events = unique;
        let ids: HashSet<String> = self.events.iter().map(|e| e.id.clone()).collect();
        self.seen_events.retain(|(id, _)| ids.contains(id));

        let mut actions: Vec<(u64, Option<DismissReason>)> = Vec::new();
        for slot in &mut self.slots {
            let Some(current) = slot.prompt.event.clone() else {
                continue;
            };
            let fresh = self.events.iter().find(|e| e.id == current.id).cloned();
            match (slot.prompt.kind, fresh) {
                (PromptKind::Scheduled, None) => {
                    actions.push((slot.prompt.id, Some(DismissReason::EventRemoved)));
                }
                (PromptKind::Scheduled, Some(fresh)) if fresh != current => {
                    let lead = ms_i64(self.config.lead_ms);
                    let in_window = now.wall >= shift(fresh.start, -lead)
                        && now.wall < shift(fresh.start, ms_i64(self.config.reminder_tail_ms));
                    let small_shift = (fresh.start - current.start)
                        .num_milliseconds()
                        .unsigned_abs()
                        <= lead.unsigned_abs()
                        && now.wall < shift(fresh.start, ms_i64(self.config.reminder_tail_ms));
                    if fresh.start != current.start && !in_window && !small_shift {
                        actions.push((slot.prompt.id, Some(DismissReason::EventRescheduled)));
                    } else {
                        self.seen_events.insert(event_key(&fresh));
                        apply_event(&mut slot.prompt, fresh);
                        actions.push((slot.prompt.id, None));
                    }
                }
                (PromptKind::Detected, None) => {}
                (PromptKind::Detected, Some(fresh)) if fresh != current => {
                    apply_event(&mut slot.prompt, fresh);
                    actions.push((slot.prompt.id, None));
                }
                _ => {}
            }
        }
        for (id, reason) in actions {
            match reason {
                Some(reason) => self.remove(id, reason, &mut out),
                None => {
                    if let Some(slot) = self.slots.iter().find(|s| s.prompt.id == id) {
                        out.push(PromptAction::Update(slot.prompt.clone()));
                    }
                }
            }
        }
        out.extend(self.advance(now));
        out
    }

    pub fn on_detect(&mut self, now: Now, event: &DetectEvent) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = self.advance(now);
        match event {
            DetectEvent::CallStarted(call) => self.call_started(now, call, &mut out),
            DetectEvent::CallUpdated(call) => self.call_updated(now, call, &mut out),
            DetectEvent::CallEnded { app_id, .. } => {
                self.calls.retain(|c| &c.key.0 != app_id);
                self.prompted_calls.retain(|k| &k.0 != app_id);
                let ids: Vec<u64> = self
                    .slots
                    .iter()
                    .filter(|s| s.call.as_ref().is_some_and(|k| &k.0 == app_id))
                    .map(|s| s.prompt.id)
                    .collect();
                for id in ids {
                    self.remove(id, DismissReason::CallEnded, &mut out);
                }
            }
            DetectEvent::NeedBrowserEvidence { .. } => {}
        }
        out.extend(self.advance(now));
        out
    }

    pub fn set_recording(&mut self, now: Now, state: RecordingState) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = Vec::new();
        if self.recording != state {
            self.recording = state;
            if self.recording.is_active() {
                self.clear_for_recording(&mut out);
            }
        }
        out.extend(self.advance(now));
        out
    }

    pub fn hover(&mut self, now: Now, id: u64, hovered: bool) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = self.advance(now);
        if let Some(slot) = self.slots.iter_mut().find(|s| s.prompt.id == id)
            && slot.hovered != hovered
        {
            if hovered {
                slot.unhovered_used = slot
                    .unhovered_used
                    .saturating_add(now.mono.since(slot.unhovered_since));
            } else {
                slot.unhovered_since = now.mono;
            }
            slot.hovered = hovered;
        }
        out.extend(self.advance(now));
        out
    }

    pub fn dismiss(&mut self, now: Now, id: u64) -> Vec<PromptAction> {
        self.user_close(now, id, DismissReason::User)
    }

    pub fn cancel(&mut self, now: Now, id: u64) -> Vec<PromptAction> {
        self.user_close(now, id, DismissReason::Cancelled)
    }

    pub fn accept(&mut self, now: Now, id: u64) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = self.advance(now);
        if let Some(index) = self.slots.iter().position(|s| s.prompt.id == id) {
            // While a meeting records, the prompts left are for other meetings
            // (the next one on the calendar): taking notes for one switches to
            // it, and the app ends the meeting it was recording first, as it
            // does for any start. One that is still starting is waited for.
            if matches!(self.recording, RecordingState::Starting { .. }) {
                self.remove(id, DismissReason::RecordingStarted, &mut out);
            } else {
                self.start_from(index, &mut out);
            }
        }
        out.extend(self.advance(now));
        out
    }

    pub fn tick(&mut self, now: Now) -> Vec<PromptAction> {
        let now = self.sync(now);
        self.advance(now)
    }

    pub fn next_deadline(&self) -> Option<Millis> {
        let clock = self.clock?;
        let mut best: Option<Millis> = None;
        let mut consider = |m: Millis| {
            if best.is_none_or(|b| m < b) {
                best = Some(m);
            }
        };
        for slot in &self.slots {
            if let Some(countdown) = slot.prompt.countdown {
                consider(countdown.ends_at);
            }
            match slot.prompt.kind {
                PromptKind::Detected => {
                    consider(self.timeout_at(slot));
                    consider(self.mono_at(clock, self.wall_timeout_at(slot)));
                }
                PromptKind::Scheduled => {
                    if let Some(over) = self.over_at(slot) {
                        consider(self.mono_at(clock, over));
                    }
                    if let Some(event) = &slot.prompt.event
                        && slot.prompt.countdown.is_none()
                        && let Some(from) = self.auto_start_from(clock.wall)
                    {
                        let at = event.start.max(from);
                        if at > clock.wall
                            && at < event.end
                            && self.over_at(slot).is_some_and(|over| at < over)
                        {
                            consider(self.mono_at(clock, at));
                        }
                    }
                }
            }
        }
        let auto_from = if self.config.scheduled_enabled {
            None
        } else {
            self.auto_start_from(clock.wall)
        };
        if self.config.scheduled_enabled || auto_from.is_some() {
            for event in &self.events {
                let show_at = match auto_from {
                    Some(from) => event.start.max(from),
                    None => shift(event.start, -self.lead()),
                };
                let in_time = auto_from.is_none() || show_at < shift(event.start, self.tail());
                if show_at > clock.wall
                    && in_time
                    && self.recording.event_id() != Some(event.id.as_str())
                    && !self.seen_events.contains(&event_key(event))
                {
                    consider(self.mono_at(clock, show_at));
                }
            }
        }
        best
    }

    fn sync(&mut self, now: Now) -> Now {
        match self.clock {
            Some(previous) if previous.mono > now.mono => previous,
            _ => {
                self.clock = Some(now);
                now
            }
        }
    }

    fn lead(&self) -> i64 {
        ms_i64(self.config.lead_ms)
    }

    fn auto_only_scheduled(&self, now: DateTime<Utc>) -> bool {
        !self.config.scheduled_enabled && self.may_auto_start(now)
    }

    /// From when a scheduled meeting may start recording on its own: now
    /// while nothing records; once the calendar says the meeting being
    /// recorded is over, so a meeting that ran over hands over to the next
    /// one (after the usual countdown, which the person can cancel to keep
    /// recording). `None` while a recording is starting, or records
    /// something the calendar does not end.
    fn auto_start_from(&self, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
        if !self.config.auto_record.for_scheduled() {
            return None;
        }
        match &self.recording {
            RecordingState::Idle => Some(now),
            RecordingState::Starting { .. } | RecordingState::Recording { event_id: None } => None,
            RecordingState::Recording { event_id: Some(id) } => {
                let instances = self.events.iter().filter(|e| &e.id == id);
                let ongoing = instances
                    .clone()
                    .filter(|e| e.start <= now && now < e.end)
                    .map(|e| e.end)
                    .max();
                ongoing.or_else(|| instances.filter(|e| e.end <= now).map(|e| e.end).max())
            }
        }
    }

    fn may_auto_start(&self, now: DateTime<Utc>) -> bool {
        self.auto_start_from(now).is_some_and(|from| from <= now)
    }

    fn tail(&self) -> i64 {
        ms_i64(self.config.reminder_tail_ms)
    }

    fn mono_at(&self, clock: Now, wall: DateTime<Utc>) -> Millis {
        let delta = (wall - clock.wall).num_milliseconds();
        if delta <= 0 {
            clock.mono
        } else {
            clock.mono.plus(delta as u64)
        }
    }

    fn timeout_at(&self, slot: &Slot) -> Millis {
        let cap = slot.prompt.shown_at.plus(self.config.max_visible_ms);
        // A call app often shows its own card in the same corner when a call
        // starts and outlasts a short prompt, so the prompt for a call that is
        // still on stays until it is answered, the call ends, or the cap.
        let live_call = slot.prompt.kind == PromptKind::Detected
            && slot
                .call
                .as_ref()
                .is_some_and(|key| self.calls.iter().any(|c| &c.key == key));
        if slot.prompt.countdown.is_some() || slot.hovered || live_call {
            return cap;
        }
        let remaining = self.config.visible_ms.saturating_sub(slot.unhovered_used);
        cap.min(slot.unhovered_since.plus(remaining))
    }

    fn wall_timeout_at(&self, slot: &Slot) -> DateTime<Utc> {
        shift(slot.shown_wall, ms_i64(self.config.max_visible_ms))
    }

    fn over_at(&self, slot: &Slot) -> Option<DateTime<Utc>> {
        let grace = match slot.prompt.countdown {
            Some(_) => self
                .tail()
                .saturating_add(ms_i64(self.config.auto_record_countdown_ms)),
            None => self.tail(),
        };
        slot.prompt.event.as_ref().map(|e| shift(e.start, grace))
    }

    fn user_close(&mut self, now: Now, id: u64, reason: DismissReason) -> Vec<PromptAction> {
        let now = self.sync(now);
        let mut out = self.advance(now);
        self.remove(id, reason, &mut out);
        out.extend(self.advance(now));
        out
    }

    fn remove(&mut self, id: u64, reason: DismissReason, out: &mut Vec<PromptAction>) {
        if let Some(index) = self.slots.iter().position(|s| s.prompt.id == id) {
            let slot = self.slots.remove(index);
            if let Some(event) = &slot.prompt.event {
                self.seen_events.insert(event_key(event));
            }
            out.push(PromptAction::Dismiss { id, reason });
        }
    }

    fn push_slot(&mut self, slot: Slot, out: &mut Vec<PromptAction>) {
        let max = self.config.max_prompts.max(1);
        while self.slots.len() >= max {
            if let Some(oldest) = self.slots.last().map(|s| s.prompt.id) {
                self.remove(oldest, DismissReason::Evicted, out);
            }
        }
        out.push(PromptAction::Show(slot.prompt.clone()));
        self.slots.insert(0, slot);
    }

    fn new_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn countdown(&self, now: Now) -> Countdown {
        Countdown {
            started_at: now.mono,
            ends_at: now.mono.plus(self.config.auto_record_countdown_ms),
        }
    }

    fn match_event(&self, now: Now) -> Option<EventInfo> {
        let window = ms_i64(self.config.event_match_window_ms);
        let on_screen = |e: &EventInfo| {
            self.slots.iter().any(|s| {
                s.prompt.kind == PromptKind::Scheduled
                    && s.prompt.event.as_ref().is_some_and(|x| x.id == e.id)
            })
        };
        self.events
            .iter()
            .filter(|e| {
                let ongoing = e.start <= now.wall && now.wall < e.end;
                let soon = e.start > now.wall && (e.start - now.wall).num_milliseconds() <= window;
                ongoing || soon
            })
            .min_by_key(|e| {
                (
                    !on_screen(e),
                    !e.has_link,
                    (e.start - now.wall).num_milliseconds().unsigned_abs(),
                )
            })
            .cloned()
    }

    fn call_started(&mut self, now: Now, call: &ActiveCall, out: &mut Vec<PromptAction>) {
        let key = (call.app_id.clone(), call.started_at);
        if !self.calls.iter().any(|c| c.key == key) {
            self.calls.retain(|c| c.key.0 != call.app_id);
            self.calls.push(CallInfo {
                key: key.clone(),
                app_name: call.app_name.clone(),
                noun: call.call_noun,
                web_title: call.web.as_ref().and_then(|w| w.title.clone()),
            });
        }
        if self.prompted_calls.contains(&key)
            || self.config.muted_app_ids.contains(&call.app_id)
            || self.recording.is_active()
        {
            return;
        }
        let event = self.match_event(now);
        // A browser using the microphone on a page Cap can't tell is a meeting
        // (tabs unreadable, or no meeting page among them) may be voice typing
        // or a voice note: it can be offered, but it only records on its own
        // when the calendar has a meeting now.
        let recognised = call.kind != AppKind::Browser || call.web.is_some();
        let auto = (self.config.auto_record.for_detected() && (recognised || event.is_some()))
            || (self.config.auto_record.for_scheduled() && event.is_some());
        if !self.config.detected_enabled && !auto {
            return;
        }
        if self
            .last_detected
            .get(&call.app_id)
            .is_some_and(|last| now.mono.since(*last) < self.config.cooldown_ms)
        {
            return;
        }
        self.prompted_calls.insert(key.clone());
        self.last_detected.insert(call.app_id.clone(), now.mono);
        if let Some(event) = &event {
            self.seen_events.insert(event_key(event));
        }
        let countdown = auto.then(|| self.countdown(now));
        let Some(info) = self.calls.iter().find(|c| c.key == key) else {
            return;
        };
        let mut prompt = Prompt {
            id: 0,
            kind: PromptKind::Detected,
            title: format!("{} detected", info.noun.word()),
            subtitle: PromptSubtitle::App(info.app_name.clone()),
            detail: info.web_title.clone(),
            app_id: Some(call.app_id.clone()),
            app_name: Some(info.app_name.clone()),
            event: None,
            countdown,
            shown_at: now.mono,
        };
        if let Some(event) = event.clone() {
            apply_event(&mut prompt, event);
        }
        let upgrade = event.as_ref().and_then(|e| {
            self.slots.iter().position(|s| {
                s.prompt.kind == PromptKind::Scheduled
                    && s.prompt.event.as_ref().is_some_and(|x| x.id == e.id)
            })
        });
        match upgrade {
            Some(index) => {
                let slot = &mut self.slots[index];
                prompt.id = slot.prompt.id;
                slot.prompt = prompt;
                slot.shown_wall = now.wall;
                slot.call = Some(key);
                slot.hovered = false;
                slot.unhovered_since = now.mono;
                slot.unhovered_used = 0;
                out.push(PromptAction::Update(slot.prompt.clone()));
            }
            None => {
                prompt.id = self.new_id();
                let slot = Slot {
                    prompt,
                    shown_wall: now.wall,
                    call: Some(key),
                    hovered: false,
                    unhovered_since: now.mono,
                    unhovered_used: 0,
                };
                self.push_slot(slot, out);
            }
        }
    }

    fn call_updated(&mut self, now: Now, call: &ActiveCall, out: &mut Vec<PromptAction>) {
        let key = (call.app_id.clone(), call.started_at);
        let title = call.web.as_ref().and_then(|w| w.title.clone());
        if let Some(info) = self.calls.iter_mut().find(|c| c.key == key) {
            info.web_title.clone_from(&title);
        }
        // A browser call whose meeting page was recognised only after it
        // started records on its own as a recognised one would have.
        let late_auto = call.web.is_some()
            && self.config.auto_record.for_detected()
            && !self.recording.is_active();
        if late_auto && !self.prompted_calls.contains(&key) {
            self.call_started(now, call, out);
            return;
        }
        let countdown = self.countdown(now);
        for slot in &mut self.slots {
            if slot.call.as_ref() != Some(&key) {
                continue;
            }
            let start = late_auto
                && slot.prompt.kind == PromptKind::Detected
                && slot.prompt.countdown.is_none()
                && slot.prompt.event.is_none();
            if slot.prompt.detail != title || start {
                slot.prompt.detail.clone_from(&title);
                if start {
                    slot.prompt.countdown = Some(countdown);
                }
                out.push(PromptAction::Update(slot.prompt.clone()));
            }
        }
    }

    fn clear_for_recording(&mut self, out: &mut Vec<PromptAction>) {
        let recorded = self.recording.event_id().map(str::to_string);
        let ids: Vec<u64> = self
            .slots
            .iter()
            .filter(|s| {
                s.prompt.kind == PromptKind::Detected
                    || s.prompt.countdown.is_some()
                    || s.prompt
                        .event
                        .as_ref()
                        .is_some_and(|e| Some(&e.id) == recorded.as_ref())
            })
            .map(|s| s.prompt.id)
            .collect();
        for id in ids {
            self.remove(id, DismissReason::RecordingStarted, out);
        }
    }

    fn start_from(&mut self, index: usize, out: &mut Vec<PromptAction>) {
        let slot = &self.slots[index];
        let event_id = slot.prompt.event.as_ref().map(|e| e.id.clone());
        let source = match (&slot.call, &event_id) {
            (Some((app_id, _)), _) => RecordSource::DetectedCall {
                app_id: app_id.clone(),
                event_id: event_id.clone(),
            },
            (None, Some(event_id)) => RecordSource::Scheduled {
                event_id: event_id.clone(),
            },
            (None, None) => {
                let id = slot.prompt.id;
                self.remove(id, DismissReason::User, out);
                return;
            }
        };
        out.push(PromptAction::StartRecording { source });
        self.recording = RecordingState::Starting { event_id };
        self.clear_for_recording(out);
    }

    fn advance(&mut self, now: Now) -> Vec<PromptAction> {
        let mut out = Vec::new();

        // Expiry runs before countdowns: after a system sleep both clocks can be far past a
        // countdown that started before the sleep, and it must not record a meeting that is over.
        let expired: Vec<(u64, DismissReason)> = self
            .slots
            .iter()
            .filter_map(|s| match s.prompt.kind {
                PromptKind::Detected => (self.timeout_at(s) <= now.mono
                    || self.wall_timeout_at(s) <= now.wall)
                    .then_some((s.prompt.id, DismissReason::TimedOut)),
                PromptKind::Scheduled => {
                    let over = self.over_at(s).is_none_or(|over| over <= now.wall);
                    over.then_some((s.prompt.id, DismissReason::EventOver))
                }
            })
            .collect();
        for (id, reason) in expired {
            self.remove(id, reason, &mut out);
        }

        while let Some(index) = self
            .slots
            .iter()
            .position(|s| s.prompt.countdown.is_some_and(|c| c.ends_at <= now.mono))
        {
            let slot = &self.slots[index];
            let over = slot.prompt.kind == PromptKind::Scheduled
                && slot
                    .prompt
                    .event
                    .as_ref()
                    .is_some_and(|e| e.end <= now.wall);
            if over {
                let id = slot.prompt.id;
                self.remove(id, DismissReason::EventOver, &mut out);
            } else if self.recording.is_active() && !self.may_auto_start(now.wall) {
                let id = self.slots[index].prompt.id;
                self.remove(id, DismissReason::RecordingStarted, &mut out);
            } else {
                self.start_from(index, &mut out);
            }
        }

        let tail = self.tail();

        if self.may_auto_start(now.wall) {
            let countdown = self.countdown(now);
            let recorded = self.recording.event_id().map(str::to_string);
            for slot in &mut self.slots {
                let started = slot.prompt.event.as_ref().is_some_and(|e| {
                    e.start <= now.wall && now.wall < e.end && Some(&e.id) != recorded.as_ref()
                });
                if slot.prompt.kind == PromptKind::Scheduled
                    && slot.prompt.countdown.is_none()
                    && started
                {
                    slot.prompt.countdown = Some(countdown);
                    out.push(PromptAction::Update(slot.prompt.clone()));
                }
            }
        }

        let auto_only = self.auto_only_scheduled(now.wall);
        if self.config.scheduled_enabled || auto_only {
            let lead = if auto_only { 0 } else { self.lead() };
            let mut due: Vec<EventInfo> = self
                .events
                .iter()
                .filter(|e| {
                    now.wall >= shift(e.start, -lead)
                        && now.wall < shift(e.start, tail)
                        && !self.seen_events.contains(&event_key(e))
                        && self.recording.event_id() != Some(e.id.as_str())
                })
                .cloned()
                .collect();
            due.sort_by_key(|e| e.start);
            for event in due {
                self.seen_events.insert(event_key(&event));
                let attached = self
                    .slots
                    .iter()
                    .any(|s| s.prompt.event.as_ref().is_some_and(|x| x.id == event.id));
                if attached {
                    continue;
                }
                let countdown = (self.may_auto_start(now.wall)
                    && event.start <= now.wall
                    && now.wall < event.end)
                    .then(|| self.countdown(now));
                let mut prompt = Prompt {
                    id: self.new_id(),
                    kind: PromptKind::Scheduled,
                    title: String::new(),
                    subtitle: PromptSubtitle::App(String::new()),
                    detail: event.link_provider_name.clone(),
                    app_id: None,
                    app_name: None,
                    event: None,
                    countdown,
                    shown_at: now.mono,
                };
                apply_event(&mut prompt, event);
                let slot = Slot {
                    prompt,
                    shown_wall: now.wall,
                    call: None,
                    hovered: false,
                    unhovered_since: now.mono,
                    unhovered_used: 0,
                };
                self.push_slot(slot, &mut out);
            }
        }

        out
    }
}

fn apply_event(prompt: &mut Prompt, event: EventInfo) {
    let title = event.title.trim();
    if !title.is_empty() {
        prompt.title = title.to_string();
    } else if prompt.title.is_empty() {
        prompt.title = "Upcoming meeting".to_string();
    }
    prompt.subtitle = PromptSubtitle::TimeRange {
        start: event.start,
        end: event.end,
    };
    prompt.event = Some(event);
}

fn shift(t: DateTime<Utc>, ms: i64) -> DateTime<Utc> {
    let delta = Duration::milliseconds(ms);
    let shifted = if ms >= 0 {
        t.checked_add_signed(delta)
    } else {
        t.checked_sub_signed(-delta)
    };
    shifted.unwrap_or(if ms >= 0 {
        DateTime::<Utc>::MAX_UTC
    } else {
        DateTime::<Utc>::MIN_UTC
    })
}

fn ms_i64(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX / 2).min(i64::MAX / 4)
}
