use chrono::{DateTime, Local, Timelike, Utc};

use cap_meetings::apps::CallNoun;
use cap_meetings::detect::ActiveCall;
use cap_meetings::prompt::{Prompt, PromptKind, PromptSubtitle};
use cap_meetings::settings::PromptPosition;

use crate::meetings::calendar::event_key;
use crate::meetings::CalendarEvent;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.w / 2., self.y + self.h / 2.)
    }

    pub fn offset(self, dx: f64, dy: f64) -> Self {
        Self {
            x: self.x + dx,
            y: self.y + dy,
            ..self
        }
    }
}

pub const PROMPT_WIDTH: f64 = 380.;
pub const PROMPT_HEIGHT: f64 = 92.;
pub const PROMPT_GAP: f64 = 10.;
pub const PROMPT_MARGIN: f64 = 16.;
pub const PROMPT_SLIDE: f64 = 16.;
pub const PROMPT_RADIUS: f64 = 16.;

pub const INDICATOR_WIDTH: f64 = 160.;
pub const INDICATOR_HEIGHT: f64 = 48.;
pub const INDICATOR_EXPANDED_WIDTH: f64 = 340.;
pub const INDICATOR_MARGIN: f64 = 12.;
pub const INDICATOR_DEFAULT_Y: f64 = 0.62;
/// Dropped this close to a screen edge, the indicator settles against it
/// (two edges: into the corner).
pub const INDICATOR_SNAP: f64 = 28.;
pub const DRAG_THRESHOLD: f64 = 4.;

pub const CONTEXT_LEAD_SECS: i64 = 10 * 60;
pub const MENU_BAR_LEAD_SECS: i64 = 5 * 60;

pub fn uses_twelve_hour_clock() -> bool {
    crate::i18n::current() == crate::i18n::Locale::En
}

pub fn clock(at: DateTime<Utc>) -> String {
    let local = at.with_timezone(&Local);
    if uses_twelve_hour_clock() {
        let (pm, hour) = local.hour12();
        format!(
            "{hour}:{:02} {}",
            local.minute(),
            if pm { "PM" } else { "AM" }
        )
    } else {
        format!("{:02}:{:02}", local.hour(), local.minute())
    }
}

pub fn elapsed(secs: u64) -> String {
    let hours = secs / 3600;
    let minutes = secs % 3600 / 60;
    let seconds = secs % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Glyph {
    Calendar,
    Waveform,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptTitle {
    Event(String),
    Upcoming,
    Detected(CallNoun),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PromptLine {
    App(String),
    StartsIn(u64),
    Range(DateTime<Utc>, DateTime<Utc>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptPrimary {
    TakeNotes,
    JoinAndTakeNotes,
    RecordingIn(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptView {
    pub title: PromptTitle,
    pub line: PromptLine,
    pub primary: PromptPrimary,
    pub glyph: Glyph,
    pub join_url: Option<String>,
    pub mutable_app: Option<(String, String)>,
    pub auto: bool,
}

pub fn call_noun(app_id: Option<&str>, calls: &[ActiveCall]) -> CallNoun {
    app_id
        .and_then(|id| {
            calls
                .iter()
                .find(|call| call.app_id == id)
                .map(|call| call.call_noun)
                .or_else(|| cap_meetings::apps::app_by_id(id).map(|app| app.call_noun))
        })
        .unwrap_or(CallNoun::Meeting)
}

pub fn event_link(event_id: &str, events: &[CalendarEvent]) -> Option<String> {
    events
        .iter()
        .find(|event| event_key(event) == event_id)
        .and_then(|event| event.link.as_ref())
        .map(|link| link.url.clone())
}

pub fn prompt_view(
    prompt: &Prompt,
    calls: &[ActiveCall],
    events: &[CalendarEvent],
    show_join: bool,
    countdown_left: Option<u64>,
    now: DateTime<Utc>,
) -> PromptView {
    let event = prompt.event.as_ref();
    let title = match event {
        Some(event) if !event.title.trim().is_empty() => {
            PromptTitle::Event(event.title.trim().into())
        }
        Some(_) => PromptTitle::Upcoming,
        None => PromptTitle::Detected(call_noun(prompt.app_id.as_deref(), calls)),
    };
    let line = match (&prompt.subtitle, event) {
        (_, Some(event)) if prompt.kind == PromptKind::Scheduled && event.start > now => {
            PromptLine::StartsIn((event.start - now).num_seconds().max(0) as u64)
        }
        (PromptSubtitle::TimeRange { start, end }, _) => PromptLine::Range(*start, *end),
        (PromptSubtitle::App(name), _) => PromptLine::App(name.clone()),
    };
    let join_url = event
        .filter(|event| event.has_link && show_join && prompt.kind == PromptKind::Scheduled)
        .and_then(|event| event_link(&event.id, events));
    let primary = match (countdown_left, &join_url) {
        (Some(left), _) => PromptPrimary::RecordingIn(left),
        (None, Some(_)) => PromptPrimary::JoinAndTakeNotes,
        (None, None) => PromptPrimary::TakeNotes,
    };
    PromptView {
        title,
        line,
        primary,
        glyph: if prompt.kind == PromptKind::Scheduled && prompt.app_id.is_none() {
            Glyph::Calendar
        } else {
            Glyph::Waveform
        },
        join_url,
        mutable_app: prompt
            .app_id
            .clone()
            .zip(prompt.app_name.clone().filter(|name| !name.is_empty())),
        auto: countdown_left.is_some(),
    }
}

pub fn macos_bundle_id(app_id: &str) -> Option<&'static str> {
    cap_meetings::apps::app_by_id(app_id)
        .and_then(|app| app.macos_ids.iter().copied().find(|id| !id.contains('*')))
}

pub fn prompt_frame(visible: Rect, position: PromptPosition, offset: f64, height: f64) -> Rect {
    let x = match position {
        PromptPosition::TopRight | PromptPosition::BottomRight => {
            visible.x + visible.w - PROMPT_MARGIN - PROMPT_WIDTH
        }
        PromptPosition::TopLeft | PromptPosition::BottomLeft => visible.x + PROMPT_MARGIN,
    };
    let y = match position {
        PromptPosition::TopRight | PromptPosition::TopLeft => visible.y + PROMPT_MARGIN + offset,
        PromptPosition::BottomRight | PromptPosition::BottomLeft => {
            visible.y + visible.h - PROMPT_MARGIN - height - offset
        }
    };
    Rect::new(x, y, PROMPT_WIDTH, height)
}

pub fn prompt_frames(visible: Rect, position: PromptPosition, heights: &[f64]) -> Vec<Rect> {
    let mut offset = 0.;
    heights
        .iter()
        .map(|height| {
            let frame = prompt_frame(visible, position, offset, *height);
            offset += height + PROMPT_GAP;
            frame
        })
        .collect()
}

pub fn prompt_menu_height(items: usize) -> f64 {
    PROMPT_HEIGHT + 1. + 6. + 30. * items as f64 + 8.
}

pub fn prompt_entry(frame: Rect, position: PromptPosition) -> Rect {
    match position {
        PromptPosition::TopRight | PromptPosition::BottomRight => frame.offset(PROMPT_SLIDE, 0.),
        PromptPosition::TopLeft | PromptPosition::BottomLeft => frame.offset(-PROMPT_SLIDE, 0.),
    }
}

pub fn screen_for_point<'a>(
    screens: &'a [super::native::Screen],
    point: Option<(f64, f64)>,
) -> Option<&'a super::native::Screen> {
    point
        .and_then(|(x, y)| screens.iter().find(|screen| screen.frame.contains(x, y)))
        .or_else(|| {
            screens
                .iter()
                .find(|screen| screen.frame.x == 0. && screen.frame.y == 0.)
        })
        .or(screens.first())
}

/// Where the indicator sits on a screen, as fractions of the room it has
/// there: 0 is against the left (top) edge, 1 against the right (bottom).
/// Fractions keep it on screen whatever size the display is next time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Dock {
    pub x: f64,
    pub y: f64,
}

impl Default for Dock {
    fn default() -> Self {
        Self {
            x: 1.,
            y: INDICATOR_DEFAULT_Y,
        }
    }
}

impl Dock {
    /// On the right half: it grows to the left when it widens.
    pub fn right(&self) -> bool {
        self.x >= 0.5
    }
}

pub fn indicator_frame(visible: Rect, dock: Dock, width: f64) -> Rect {
    let travel_x = (visible.w - 2. * INDICATOR_MARGIN - width).max(0.);
    let travel_y = (visible.h - 2. * INDICATOR_MARGIN - INDICATOR_HEIGHT).max(0.);
    Rect::new(
        visible.x + INDICATOR_MARGIN + travel_x * dock.x.clamp(0., 1.),
        visible.y + INDICATOR_MARGIN + travel_y * dock.y.clamp(0., 1.),
        width,
        INDICATOR_HEIGHT,
    )
}

/// Where a dropped indicator rests: wherever it was let go, settled against
/// an edge (or into a corner) when it was dropped close to one.
pub fn snap(visible: Rect, frame: Rect) -> Dock {
    let travel_x = (visible.w - 2. * INDICATOR_MARGIN - frame.w).max(1.);
    let travel_y = (visible.h - 2. * INDICATOR_MARGIN - frame.h).max(1.);
    let settle = |offset: f64, travel: f64| {
        let offset = offset.clamp(0., travel);
        if offset <= INDICATOR_SNAP {
            0.
        } else if travel - offset <= INDICATOR_SNAP {
            1.
        } else {
            offset / travel
        }
    };
    Dock {
        x: settle(frame.x - visible.x - INDICATOR_MARGIN, travel_x),
        y: settle(frame.y - visible.y - INDICATOR_MARGIN, travel_y),
    }
}

pub fn dragged(from: (f64, f64), to: (f64, f64)) -> bool {
    let dx = to.0 - from.0;
    let dy = to.1 - from.1;
    dx * dx + dy * dy >= DRAG_THRESHOLD * DRAG_THRESHOLD
}

pub const METER_GATE: f32 = 0.34;
pub const METER_STEPS: u8 = 4;
const METER_SHAPE: [f32; 3] = [0.62, 1.0, 0.78];

pub fn meter_step(level: f32) -> u8 {
    if !level.is_finite() || level < METER_GATE {
        return 0;
    }
    let span = (level - METER_GATE) / (1. - METER_GATE);
    (1. + span.clamp(0., 1.) * f32::from(METER_STEPS - 1)).round() as u8
}

pub fn meter_bars(step: u8) -> [f32; 3] {
    if step == 0 {
        return [0.; 3];
    }
    let fill = f32::from(step.min(METER_STEPS)) / f32::from(METER_STEPS);
    METER_SHAPE.map(|shape| (shape * fill).clamp(0.18, 1.))
}

#[derive(Clone, Debug, PartialEq)]
pub struct EventSummary {
    pub id: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub provider: Option<cap_calendar::link::Provider>,
    pub url: Option<String>,
}

impl EventSummary {
    pub fn of(event: &CalendarEvent) -> Self {
        Self {
            id: event_key(event),
            title: event.title.trim().to_string(),
            start: event.start,
            end: event.end,
            provider: event.link.as_ref().map(|link| link.provider),
            url: event.link.as_ref().map(|link| link.url.clone()),
        }
    }

    pub fn starts_in_secs(&self, now: DateTime<Utc>) -> i64 {
        (self.start - now).num_seconds()
    }

    pub fn is_now(&self, now: DateTime<Utc>) -> bool {
        self.start <= now && now < self.end
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CallSummary {
    pub app_id: String,
    pub app_name: String,
    pub noun: CallNoun,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Context {
    pub call: Option<CallSummary>,
    pub event: Option<EventSummary>,
}

pub fn context(
    calls: &[ActiveCall],
    events: &[CalendarEvent],
    now: DateTime<Utc>,
) -> Option<Context> {
    let call = calls.last().map(|call| CallSummary {
        app_id: call.app_id.clone(),
        app_name: call.app_name.clone(),
        noun: call.call_noun,
    });
    let event = events
        .iter()
        .filter(|event| !event.all_day)
        .filter(|event| {
            let starts_in = (event.start - now).num_seconds();
            (event.start <= now && now < event.end) || (0..=CONTEXT_LEAD_SECS).contains(&starts_in)
        })
        .min_by_key(|event| ((event.start - now).num_seconds().abs(), event.start))
        .map(EventSummary::of);
    (call.is_some() || event.is_some()).then_some(Context { call, event })
}

pub fn coming_up(
    events: &[CalendarEvent],
    now: DateTime<Utc>,
    exclude: Option<&str>,
    limit: usize,
) -> Vec<EventSummary> {
    let local_now = now.with_timezone(&Local);
    let end_of_day = local_now
        .date_naive()
        .succ_opt()
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .and_then(|midnight| midnight.and_local_timezone(Local).earliest())
        .map(|midnight| midnight.with_timezone(&Utc))
        .unwrap_or(now + chrono::Duration::hours(24));
    let mut out: Vec<EventSummary> = events
        .iter()
        .filter(|event| !event.all_day && event.start > now && event.start < end_of_day)
        .filter(|event| exclude != Some(event_key(event).as_str()))
        .map(EventSummary::of)
        .collect();
    out.sort_by_key(|event| event.start);
    out.truncate(limit);
    out
}

pub fn next_event_today(events: &[CalendarEvent], now: DateTime<Utc>) -> Option<EventSummary> {
    let current = events
        .iter()
        .filter(|event| !event.all_day && event.start <= now && now < event.end)
        .max_by_key(|event| event.start)
        .map(EventSummary::of);
    current.or_else(|| coming_up(events, now, None, 1).into_iter().next())
}

pub fn imminent(event: &EventSummary, now: DateTime<Utc>, lead_secs: i64) -> bool {
    event.is_now(now) || (0..=lead_secs).contains(&event.starts_in_secs(now))
}

pub fn short_title(title: &str, max_chars: usize) -> String {
    let title = title.trim();
    if title.chars().count() <= max_chars {
        return title.to_string();
    }
    let kept: String = title.chars().take(max_chars.saturating_sub(1)).collect();
    format!("{}…", kept.trim_end())
}

pub fn minutes_until(start: DateTime<Utc>, now: DateTime<Utc>) -> i64 {
    let secs = (start - now).num_seconds();
    if secs <= 0 { 0 } else { (secs + 59) / 60 }
}

pub fn next_minute_boundary(now: DateTime<Utc>) -> std::time::Duration {
    let into = u64::from(now.second()) * 1000 + u64::from(now.timestamp_subsec_millis());
    std::time::Duration::from_millis(60_000 - into.min(59_999))
}

/// How early the main window offers to record a calendar meeting.
pub const ROW_LEAD_SECS: i64 = 5 * 60;

/// The main window's one meeting row. Absent in every other case, so the
/// window otherwise looks exactly as it does without meetings.
#[derive(Clone, Debug, PartialEq)]
pub enum MainRow {
    Recording {
        title: String,
        secs: u64,
    },
    Offer {
        title: String,
        /// Whole minutes until it starts; `None` when it is happening now.
        starts_in_minutes: Option<i64>,
        event_id: Option<String>,
    },
}

pub fn main_row(
    active: Option<&crate::meetings::ActiveMeeting>,
    calls: &[ActiveCall],
    events: &[CalendarEvent],
    detection_on: bool,
    now: DateTime<Utc>,
) -> Option<MainRow> {
    use crate::meetings::ActiveState;
    if let Some(active) = active {
        if matches!(active.state, ActiveState::Starting | ActiveState::Recording) {
            return Some(MainRow::Recording {
                title: active.title.trim().to_string(),
                secs: active.started.elapsed().as_secs(),
            });
        }
    }
    if !detection_on {
        return None;
    }
    let event = events
        .iter()
        .filter(|event| !event.all_day)
        .filter(|event| {
            let starts_in = (event.start - now).num_seconds();
            (event.start <= now && now < event.end) || (0..=ROW_LEAD_SECS).contains(&starts_in)
        })
        .min_by_key(|event| ((event.start - now).num_seconds().abs(), event.start));
    let call = calls.last();
    match (event, call) {
        (Some(event), call) => Some(MainRow::Offer {
            title: event.title.trim().to_string(),
            starts_in_minutes: (event.start > now && call.is_none())
                .then(|| minutes_until(event.start, now)),
            event_id: Some(event_key(event)),
        }),
        (None, Some(call)) => Some(MainRow::Offer {
            title: call.app_name.clone(),
            starts_in_minutes: None,
            event_id: None,
        }),
        (None, None) => None,
    }
}

/// When the row's text next changes on its own: every second while
/// recording, at the next minute while a meeting is close, and when the next
/// meeting comes within reach. `None` means nothing will change by itself.
pub fn main_row_wake(
    row: Option<&MainRow>,
    events: &[CalendarEvent],
    detection_on: bool,
    now: DateTime<Utc>,
) -> Option<std::time::Duration> {
    match row {
        Some(MainRow::Recording { .. }) => return Some(std::time::Duration::from_secs(1)),
        Some(MainRow::Offer { .. }) => return Some(next_minute_boundary(now)),
        None => {}
    }
    if !detection_on {
        return None;
    }
    events
        .iter()
        .filter(|event| !event.all_day)
        .map(|event| event.start - chrono::Duration::seconds(ROW_LEAD_SECS))
        .filter(|at| *at > now)
        .min()
        .and_then(|at| (at - now).to_std().ok())
        .map(|wait| wait + std::time::Duration::from_millis(50))
}
