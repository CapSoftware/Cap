use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use gpui::{App, Global, Task};

use super::{Entry, TrayItem};
use crate::i18n::tr;
use crate::meetings_ui::live::{self, model};

#[derive(Clone, Debug, PartialEq)]
pub struct NextRow {
    pub label: String,
    pub event_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeetingMenu {
    pub enabled: bool,
    pub recording_secs: Option<u64>,
    pub next: Option<NextRow>,
    /// The start button's remembered choice is a blank note, so it comes
    /// first here too.
    pub blank_first: bool,
}

pub fn stop_title(recording_secs: u64) -> String {
    tr::meeting::tray::stop(model::elapsed(recording_secs))
}

pub fn entries(menu: &MeetingMenu) -> Vec<Entry> {
    if !menu.enabled {
        return Vec::new();
    }
    // Start (or Stop) first: it is the one thing people open this menu for.
    let toggle = match menu.recording_secs {
        Some(secs) => Entry::item(stop_title(secs), TrayItem::MeetingToggle),
        None => Entry::item(tr::meeting::tray::start(), TrayItem::MeetingToggle),
    };
    let new_note = Entry::item(tr::meeting::tray::new_note(), TrayItem::MeetingNewNote);
    let mut entries = if menu.blank_first && menu.recording_secs.is_none() {
        vec![new_note, toggle]
    } else {
        vec![toggle, new_note]
    };
    entries.push(Entry::item(
        tr::meeting::tray::open_notes(),
        TrayItem::MeetingOpenNotes,
    ));
    if let Some(next) = &menu.next {
        entries.push(match &next.event_id {
            Some(id) => Entry::item(next.label.clone(), TrayItem::MeetingEvent(id.clone())),
            None => Entry::disabled(next.label.clone()),
        });
    }
    entries
}

pub fn insert(entries: &mut Vec<Entry>, meeting: Vec<Entry>) {
    if meeting.is_empty() {
        return;
    }
    // Off macOS the mode picker is a submenu too, above the capture rows, so
    // the block goes before the "Previous" submenu by name.
    let previous = tr::tray::previous();
    let at = entries
        .iter()
        .position(|entry| matches!(entry, Entry::Submenu { title, .. } if title == previous))
        .unwrap_or(entries.len());
    let mut block = meeting;
    block.push(Entry::Separator);
    entries.splice(at..at, block);
}

pub fn next_row(event: &model::EventSummary, now: DateTime<Utc>, recording: bool) -> NextRow {
    let title = if event.title.is_empty() {
        tr::meeting::prompt::upcoming().to_string()
    } else {
        model::short_title(&event.title, 40)
    };
    NextRow {
        label: tr::meeting::tray::next(model::clock(event.start), title),
        event_id: (!recording && model::imminent(event, now, model::CONTEXT_LEAD_SECS))
            .then(|| event.id.clone()),
    }
}

pub fn menu_bar_title(event: &model::EventSummary, now: DateTime<Utc>) -> Option<String> {
    if !model::imminent(event, now, model::MENU_BAR_LEAD_SECS) {
        return None;
    }
    let title = if event.title.is_empty() {
        tr::meeting::prompt::upcoming().to_string()
    } else {
        model::short_title(&event.title, 12)
    };
    Some(if event.is_now(now) {
        tr::meeting::tray::title_now(title)
    } else {
        tr::meeting::tray::title_in(title, model::minutes_until(event.start, now))
    })
}

pub fn state(cx: &App) -> MeetingMenu {
    // Notes are always there; the next-meeting row only when meeting
    // detection and calendars are on.
    let Some(settings) = live::settings(cx) else {
        return MeetingMenu::default();
    };
    let now = Utc::now();
    let active = live::active(cx);
    let recording = live::recording(cx);
    let next = settings
        .enabled
        .then(|| model::next_event_today(&live::events(cx), now))
        .flatten()
        .map(|event| next_row(&event, now, recording));
    MeetingMenu {
        enabled: true,
        recording_secs: active
            .filter(|_| recording)
            .map(|active| active.started.elapsed().as_secs()),
        next,
        blank_first: settings.notes.start == cap_meetings::settings::StartChoice::Blank,
    }
}

thread_local! {
    static STARTED: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

pub fn remember_started(menu: &MeetingMenu) {
    let started = menu
        .recording_secs
        .and_then(|secs| Instant::now().checked_sub(Duration::from_secs(secs)));
    STARTED.with(|cell| cell.set(started));
}

pub fn live_stop_title() -> Option<String> {
    STARTED
        .with(std::cell::Cell::get)
        .map(|started| stop_title(started.elapsed().as_secs()))
}

#[derive(Default)]
struct Clock {
    task: Option<Task<()>>,
    title: Option<String>,
}

impl Global for Clock {}

pub fn changed(cx: &mut App) {
    cx.defer(|cx| {
        super::refresh_menu(cx);
        tick(cx);
    });
}

fn tick(cx: &mut App) {
    let now = Utc::now();
    let settings = live::settings(cx);
    let enabled = settings.as_ref().is_some_and(|settings| settings.enabled);
    let show = settings
        .as_ref()
        .is_some_and(|settings| settings.calendar.show_next_in_menu_bar);
    let event = enabled
        .then(|| model::next_event_today(&live::events(cx), now))
        .flatten();
    let title = event
        .as_ref()
        .filter(|_| show && !live::recording(cx))
        .and_then(|event| menu_bar_title(event, now));
    let wake = event.as_ref().and_then(|event| {
        if model::imminent(event, now, model::CONTEXT_LEAD_SECS) {
            let to_end = (event.end - now).to_std().unwrap_or_default();
            Some(model::next_minute_boundary(now).min(to_end + Duration::from_millis(50)))
        } else {
            (event.start - chrono::Duration::seconds(model::CONTEXT_LEAD_SECS) - now)
                .to_std()
                .ok()
        }
    });
    let clock = cx.default_global::<Clock>();
    let title_changed = clock.title != title;
    clock.title = title.clone();
    clock.task = None;
    if title_changed {
        set_title(title.as_deref(), cx);
    }
    if let Some(wake) = wake {
        let task = cx.spawn(async move |cx| {
            cx.background_executor().timer(wake).await;
            cx.update(|cx| {
                super::refresh_menu(cx);
                tick(cx);
            });
        });
        cx.default_global::<Clock>().task = Some(task);
    }
}

pub fn current_title(cx: &App) -> Option<String> {
    cx.try_global::<Clock>()
        .and_then(|clock| clock.title.clone())
}

#[cfg(target_os = "macos")]
fn set_title(title: Option<&str>, cx: &mut App) {
    super::mac::set_meeting_title(title, cx);
}

#[cfg(target_os = "windows")]
fn set_title(title: Option<&str>, cx: &mut App) {
    super::windows::set_meeting_title(title, cx);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_title(_title: Option<&str>, _cx: &mut App) {}
