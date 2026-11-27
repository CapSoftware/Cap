pub mod chime;
#[cfg(debug_assertions)]
pub mod debug;
pub mod indicator;
pub mod model;
pub mod native;
pub mod prompt;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::time::Instant;

use cap_meetings::detect::ActiveCall;
use cap_meetings::prompt::Prompt;
use cap_meetings::settings::MeetingSettings;
use gpui::{App, AppContext as _, Context, Entity, EventEmitter, Global, Subscription};

use crate::meetings::{
    ActiveMeeting, ActiveState, AttentionReason, CalendarEvent, MeetingError, MeetingEvent,
    MeetingWarning, Meetings, SourceHealth, StartSource, StopReason,
};

#[derive(Clone, Debug, PartialEq)]
pub enum LiveEvent {
    Changed,
    Meter,
    Attention(AttentionReason),
    PromptShown,
}

#[derive(Clone, Debug, PartialEq)]
struct ActiveKey {
    doc_id: String,
    title: String,
    state: ActiveState,
    warning: Option<MeetingWarning>,
    resume_until: Option<Instant>,
    resumed_after_sleep: bool,
    mic: SourceHealth,
    system: SourceHealth,
    engine_issue: Option<String>,
}

impl ActiveKey {
    fn of(active: &ActiveMeeting) -> Self {
        Self {
            doc_id: active.doc_id.clone(),
            title: active.title.clone(),
            state: active.state,
            warning: active.warning,
            resume_until: active.resume_offer_until,
            resumed_after_sleep: active.resumed_after_sleep,
            mic: active.mic.health.clone(),
            system: active.system.health.clone(),
            engine_issue: active.engine.issue.clone(),
        }
    }
}

pub struct Live {
    meetings: Option<Entity<Meetings>>,
    calendar: Vec<CalendarEvent>,
    active_key: Option<ActiveKey>,
    meter: (u8, u8),
    titles: HashMap<String, String>,
    seen_prompts: Vec<u64>,
    #[cfg(debug_assertions)]
    pub(crate) seed: Option<debug::Seed>,
    _subscription: Option<Subscription>,
}

impl EventEmitter<LiveEvent> for Live {}

struct LiveGlobal(Entity<Live>);

impl Global for LiveGlobal {}

pub fn init(cx: &mut App) {
    let meetings = Meetings::try_global(cx);
    let live = cx.new(|cx| Live::new(meetings, cx));
    cx.set_global(LiveGlobal(live));
}

impl Live {
    fn new(meetings: Option<Entity<Meetings>>, cx: &mut Context<Self>) -> Self {
        let subscription = meetings
            .as_ref()
            .map(|meetings| cx.subscribe(meetings, Self::on_meeting_event));
        let mut this = Self {
            meetings,
            calendar: Vec::new(),
            active_key: None,
            meter: (0, 0),
            titles: HashMap::new(),
            seen_prompts: Vec::new(),
            #[cfg(debug_assertions)]
            seed: None,
            _subscription: subscription,
        };
        this.refresh_calendar(cx);
        this
    }

    pub fn global(cx: &App) -> Option<Entity<Self>> {
        cx.try_global::<LiveGlobal>().map(|global| global.0.clone())
    }

    fn refresh_calendar(&mut self, cx: &App) {
        let Some(meetings) = &self.meetings else {
            return;
        };
        let meetings = meetings.read(cx);
        if meetings.settings().enabled {
            self.calendar = meetings.agenda().events().to_vec();
        } else {
            self.calendar.clear();
        }
    }

    fn on_meeting_event(
        &mut self,
        _meetings: Entity<Meetings>,
        event: &MeetingEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            MeetingEvent::PromptsChanged => {
                self.prompts_changed(cx);
                cx.emit(LiveEvent::Changed);
            }
            MeetingEvent::SettingsChanged => {
                self.refresh_calendar(cx);
                self.prompts_changed(cx);
                self.active_changed(cx);
                cx.defer(indicator::sync);
                crate::tray::meetings::changed(cx);
                cx.emit(LiveEvent::Changed);
            }
            MeetingEvent::CalendarChanged => {
                self.refresh_calendar(cx);
                crate::tray::meetings::changed(cx);
                cx.emit(LiveEvent::Changed);
            }
            MeetingEvent::RecordingStarted { doc_id } => {
                tracing::info!(doc_id, "meeting recording started");
                if self.data_settings(cx).is_some_and(|s| s.recording.sounds) {
                    crate::app_sounds::AppSound::StartRecording.play();
                }
                self.active_changed(cx);
                cx.defer(indicator::sync);
                crate::tray::meetings::changed(cx);
                cx.emit(LiveEvent::Changed);
            }
            MeetingEvent::RecordingStopped { doc_id, reason } => {
                tracing::info!(doc_id, ?reason, "meeting recording stopped");
                if self.data_settings(cx).is_some_and(|s| s.recording.sounds)
                    && *reason != StopReason::Quit
                {
                    crate::app_sounds::AppSound::StopRecording.play();
                }
                self.active_changed(cx);
                cx.defer(indicator::sync);
                crate::tray::meetings::changed(cx);
                cx.emit(LiveEvent::Changed);
            }
            MeetingEvent::ActiveChanged => self.active_changed(cx),
            MeetingEvent::WantsAttention { reason } => {
                tracing::info!(?reason, "meeting wants attention");
                cx.emit(LiveEvent::Attention(reason.clone()));
                // A recording that started on its own or is about to stop may
                // come while the person types in the call: shown, not focused.
                let quietly = !matches!(reason, AttentionReason::ResumeOffered);
                cx.defer(move |cx| bring_note_forward(quietly, cx));
            }
            MeetingEvent::AutoStartFailed { error } => {
                let error = error.clone();
                cx.defer(move |cx| crate::meetings_ui::documents::auto_start_failed(error, cx));
            }
            MeetingEvent::NotesProgress { .. }
            | MeetingEvent::LibraryChanged
            | MeetingEvent::TranscriptChanged { .. }
            | MeetingEvent::AskProgress { .. }
            | MeetingEvent::SpeakerRenamed { .. } => {}
        }
    }

    fn prompts_changed(&mut self, cx: &mut Context<Self>) {
        let prompts = self.data_prompts(cx);
        let fresh: Vec<u64> = prompts
            .iter()
            .map(|prompt| prompt.id)
            .filter(|id| !self.seen_prompts.contains(id))
            .collect();
        self.seen_prompts = prompts.iter().map(|prompt| prompt.id).collect();
        if !fresh.is_empty() {
            if self
                .data_settings(cx)
                .is_some_and(|s| s.notifications.sound)
            {
                chime::play();
            }
            cx.emit(LiveEvent::PromptShown);
        }
        cx.defer(prompt::sync);
    }

    fn active_changed(&mut self, cx: &mut Context<Self>) {
        let active = self.data_active(cx);
        if let Some(active) = &active
            && !active.title.is_empty()
        {
            self.titles
                .insert(active.doc_id.clone(), active.title.clone());
        }
        let key = active.as_ref().map(ActiveKey::of);
        let meter = active.as_ref().map_or((0, 0), |active| {
            (
                model::meter_step(active.mic.level),
                model::meter_step(active.system.level),
            )
        });
        let presence_changed = key.is_some() != self.active_key.is_some();
        let changed = key != self.active_key;
        self.active_key = key;
        if changed {
            if presence_changed {
                cx.defer(indicator::sync);
            }
            cx.defer(indicator::refresh);
            crate::tray::meetings::changed(cx);
            cx.emit(LiveEvent::Changed);
        }
        if meter != self.meter {
            self.meter = meter;
            cx.defer(indicator::refresh_meter);
            cx.emit(LiveEvent::Meter);
        }
    }

    pub fn meter(&self) -> (u8, u8) {
        self.meter
    }

    pub fn calendar(&self) -> &[CalendarEvent] {
        #[cfg(debug_assertions)]
        if let Some(events) = self.seed.as_ref().and_then(|seed| seed.events.as_ref()) {
            return events;
        }
        &self.calendar
    }

    #[cfg(debug_assertions)]
    pub(crate) fn set_seed(&mut self, seed: Option<debug::Seed>, cx: &mut Context<Self>) {
        self.seed = seed;
        self.active_key = None;
        self.prompts_changed(cx);
        self.active_changed(cx);
        cx.defer(indicator::sync);
        crate::tray::meetings::changed(cx);
        cx.emit(LiveEvent::Changed);
    }
}

fn live(cx: &App) -> Option<&Live> {
    cx.try_global::<LiveGlobal>()
        .map(|global| global.0.read(cx))
}

fn meetings(cx: &App) -> Option<&Meetings> {
    Meetings::try_global(cx).map(|meetings| meetings.read(cx))
}

impl Live {
    fn data_settings(&self, cx: &App) -> Option<MeetingSettings> {
        #[cfg(debug_assertions)]
        if let Some(settings) = self.seed.as_ref().and_then(|seed| seed.settings.clone()) {
            return Some(settings);
        }
        meetings(cx).map(|meetings| meetings.settings().clone())
    }

    fn data_prompts(&self, cx: &App) -> Vec<Prompt> {
        #[cfg(debug_assertions)]
        if let Some(seed) = &self.seed {
            return seed.prompts.clone();
        }
        meetings(cx).map_or_else(Vec::new, |meetings| meetings.prompts().to_vec())
    }

    fn data_active(&self, cx: &App) -> Option<ActiveMeeting> {
        #[cfg(debug_assertions)]
        if let Some(seed) = &self.seed {
            return seed.active.clone();
        }
        meetings(cx).and_then(|meetings| meetings.active().cloned())
    }

    fn data_calls(&self, cx: &App) -> Vec<ActiveCall> {
        #[cfg(debug_assertions)]
        if let Some(seed) = &self.seed {
            return seed.calls.clone();
        }
        meetings(cx).map_or_else(Vec::new, |meetings| meetings.active_calls().to_vec())
    }
}

pub fn settings(cx: &App) -> Option<MeetingSettings> {
    match live(cx) {
        Some(live) => live.data_settings(cx),
        None => meetings(cx).map(|meetings| meetings.settings().clone()),
    }
}

/// Meeting detection, prompts and calendars are on. Notes themselves never
/// need this.
pub fn ready(cx: &App) -> bool {
    settings(cx).is_some_and(|settings| settings.enabled && settings.setup_completed)
}

/// Recording has been set up once (permissions, transcription), so a record
/// action can start straight away instead of opening setup.
pub fn can_record(cx: &App) -> bool {
    settings(cx).is_some_and(|settings| settings.setup_completed)
}

pub fn prompts(cx: &App) -> Vec<Prompt> {
    live(cx).map_or_else(Vec::new, |live| live.data_prompts(cx))
}

pub fn active(cx: &App) -> Option<ActiveMeeting> {
    live(cx).and_then(|live| live.data_active(cx))
}

pub fn calls(cx: &App) -> Vec<ActiveCall> {
    live(cx).map_or_else(Vec::new, |live| live.data_calls(cx))
}

pub fn events(cx: &App) -> Vec<CalendarEvent> {
    live(cx).map_or_else(Vec::new, |live| live.calendar().to_vec())
}

pub fn recording(cx: &App) -> bool {
    active(cx).is_some_and(|active| {
        matches!(active.state, ActiveState::Recording | ActiveState::Starting)
    })
}

fn update_meetings<R>(
    cx: &mut App,
    f: impl FnOnce(&mut Meetings, &mut Context<Meetings>) -> R,
) -> Option<R> {
    Meetings::try_global(cx).map(|meetings| meetings.update(cx, f))
}

#[cfg(debug_assertions)]
fn seeded(cx: &App) -> bool {
    live(cx).is_some_and(|live| live.seed.is_some())
}

#[cfg(not(debug_assertions))]
fn seeded(_cx: &App) -> bool {
    false
}

pub fn start(source: StartSource, cx: &mut App) -> Result<String, MeetingError> {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        return Ok(debug::start(source, cx));
    }
    update_meetings(cx, |meetings, cx| meetings.start_recording(source, cx))
        .unwrap_or(Err(MeetingError::Disabled))
}

pub fn start_or_set_up(source: StartSource, cx: &mut App) {
    if !can_record(cx) {
        crate::meetings_ui::setup::open(cx);
        return;
    }
    match start(source, cx) {
        Ok(doc_id) => crate::meetings_ui::documents::open_to_type(doc_id, cx),
        Err(error) => crate::meetings_ui::documents::start_failed(error, cx),
    }
}

pub fn stop(reason: StopReason, cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::stop(cx);
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.stop_recording(reason, cx));
}

pub fn keep_recording(cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::clear_warning(cx);
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.keep_recording(cx));
}

pub fn resume(cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::clear_warning(cx);
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.resume(cx));
}

pub fn toggle(cx: &mut App) {
    if recording(cx) {
        stop(StopReason::User, cx);
    } else {
        start_or_set_up(StartSource::Manual, cx);
    }
}

pub fn accept_prompt(id: u64, join: Option<String>, cx: &mut App) {
    let joining = join.is_some();
    if let Some(url) = join {
        cx.open_url(&url);
    }
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::remove_prompt(id, cx);
        debug::start(StartSource::Prompt(id), cx);
        return;
    }
    let accepted = update_meetings(cx, |meetings, cx| meetings.accept_prompt(id, joining, cx));
    let started = Meetings::try_global(cx).and_then(|meetings| {
        meetings
            .read(cx)
            .active()
            .map(|active| active.doc_id.clone())
    });
    if let Some(doc_id) = started {
        crate::meetings_ui::documents::open_to_type(doc_id, cx);
    } else if let Some(Err(error)) = accepted {
        crate::meetings_ui::documents::start_failed(error, cx);
    }
}

pub fn dismiss_prompt(id: u64, cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::remove_prompt(id, cx);
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.dismiss_prompt(id, cx));
}

pub fn cancel_prompt(id: u64, cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::remove_prompt(id, cx);
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.cancel_prompt(id, cx));
}

pub fn hover_prompt(id: u64, hovered: bool, cx: &mut App) {
    if seeded(cx) {
        return;
    }
    update_meetings(cx, |meetings, cx| meetings.hover_prompt(id, hovered, cx));
}

pub fn mute_app(id: u64, app_id: &str, cx: &mut App) {
    #[cfg(debug_assertions)]
    if seeded(cx) {
        debug::remove_prompt(id, cx);
        return;
    }
    let app_id = app_id.to_string();
    update_meetings(cx, |meetings, cx| {
        meetings.mute_app(&app_id, cx);
        meetings.dismiss_prompt(id, cx);
    });
}

/// "Bring Cap forward": a recording that needs the person (it started on its
/// own, or is about to stop) brings its note up, never over a video
/// recording in progress.
fn bring_note_forward(quietly: bool, cx: &mut App) {
    if !settings(cx).is_some_and(|settings| settings.automation.bring_up_window) {
        return;
    }
    if crate::session::RecordingSession::global(cx).read(cx).phase != crate::session::Phase::Idle {
        return;
    }
    if quietly {
        crate::meetings_ui::documents::open_quietly(cx);
    } else {
        crate::meetings_ui::documents::open(None, cx);
    }
}

pub fn open_document(doc_id: Option<String>, cx: &mut App) {
    crate::meetings_ui::documents::open(doc_id, cx);
}

/// The note an "open notes" action lands on: the one asked for, else the
/// note being taken right now, else none (the home list).
pub fn open_target(requested: Option<String>, active: Option<&ActiveMeeting>) -> Option<String> {
    requested.or_else(|| {
        active
            .filter(|active| active.state != ActiveState::ResumeOffered)
            .map(|active| active.doc_id.clone())
    })
}

#[cfg(debug_assertions)]
pub fn debug_hovered(id: u64, cx: &App) -> bool {
    debug::hovered_prompt(id, cx)
}

#[cfg(not(debug_assertions))]
pub fn debug_hovered(_id: u64, _cx: &App) -> bool {
    false
}

#[cfg(debug_assertions)]
pub fn debug_indicator_hover(cx: &App) -> bool {
    debug::hovered_indicator(cx)
}

#[cfg(not(debug_assertions))]
pub fn debug_indicator_hover(_cx: &App) -> bool {
    false
}

#[cfg(debug_assertions)]
pub fn debug_tour() -> bool {
    std::env::var_os("CAP_GPUI_MEETING_UI").is_some()
}

#[cfg(not(debug_assertions))]
pub fn debug_tour() -> bool {
    false
}
