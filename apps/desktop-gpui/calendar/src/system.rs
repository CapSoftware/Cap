use chrono::{DateTime, NaiveTime, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::link::event_meeting_link;
use crate::model::{
    CalendarEvent, EventStatus, Person, Response, SourceKind, derive_self_response,
};
use crate::text::non_empty;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemAttendee {
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_self: bool,
    pub status: Response,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemEvent {
    pub event_id: String,
    pub calendar_id: String,
    pub calendar_title: Option<String>,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub organizer: Option<SystemAttendee>,
    pub attendees: Vec<SystemAttendee>,
    pub is_recurring: bool,
    pub status: EventStatus,
    pub free: bool,
}

fn person(a: &SystemAttendee) -> Person {
    Person {
        name: non_empty(a.name.as_deref()),
        email: non_empty(a.email.as_deref()),
        is_self: a.is_self,
        response: a.status,
    }
}

pub fn from_system_event(event: &SystemEvent, local_zone: Tz) -> CalendarEvent {
    let (start, end) = if event.all_day {
        let start_date = event.start.with_timezone(&local_zone).date_naive();
        let last = event
            .end
            .checked_sub_signed(chrono::Duration::seconds(1))
            .unwrap_or(event.end)
            .max(event.start)
            .with_timezone(&local_zone)
            .date_naive();
        let end_date = last.succ_opt().unwrap_or(last);
        (
            start_date.and_time(NaiveTime::MIN).and_utc(),
            end_date.and_time(NaiveTime::MIN).and_utc(),
        )
    } else {
        (event.start, event.end.max(event.start))
    };
    let organizer = event.organizer.as_ref().map(person);
    let attendees: Vec<Person> = event.attendees.iter().map(person).collect();
    let self_response = derive_self_response(organizer.as_ref(), &attendees, Response::Unknown);
    let id = if event.is_recurring {
        format!(
            "{}_{}",
            event.event_id,
            event.start.format("%Y%m%dT%H%M%SZ")
        )
    } else {
        event.event_id.clone()
    };
    CalendarEvent {
        id,
        series_id: event.is_recurring.then(|| event.event_id.clone()),
        calendar_id: event.calendar_id.clone(),
        source: SourceKind::System,
        title: event.title.trim().to_string(),
        start,
        end,
        all_day: event.all_day,
        location: non_empty(event.location.as_deref()),
        description: non_empty(event.notes.as_deref()),
        organizer,
        attendees,
        self_response,
        link: event_meeting_link(
            &[],
            event.location.as_deref(),
            event.notes.as_deref(),
            event.url.as_deref(),
        ),
        status: event.status,
        web_url: None,
        free: event.free,
    }
}
