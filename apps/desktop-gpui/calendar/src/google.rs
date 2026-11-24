use std::ops::Range;

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{Error, parse_json};
use crate::http::{HttpRequestSpec, api_url};
use crate::link::{ConferenceEntry, ConferenceKind, event_meeting_link};
use crate::model::{
    CalendarEvent, CalendarInfo, EventStatus, Page, Person, Response, SourceKind,
    derive_self_response, is_self_email,
};
use crate::text::non_empty;
use crate::tz::resolve_tzid;

const API: &str = "https://www.googleapis.com/calendar/v3";

const EVENT_FIELDS: &str = "nextPageToken,timeZone,items(id,status,htmlLink,summary,description,location,start,end,organizer(email,displayName,self),attendees(email,displayName,self,responseStatus,resource),hangoutLink,conferenceData(entryPoints(entryPointType,uri,meetingCode),conferenceSolution(name,key(type)),conferenceId),recurringEventId,originalStartTime,eventType,transparency,iCalUID)";

const CALENDAR_FIELDS: &str = "nextPageToken,items(id,summary,summaryOverride,primary,backgroundColor,selected,accessRole,timeZone,hidden,deleted)";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GoogleOptions {
    pub include_status_events: bool,
    pub include_cancelled: bool,
    pub self_emails: Vec<String>,
}

fn rfc3339(dt: DateTime<Utc>) -> String {
    dt.to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn calendar_url(path: &[&str]) -> String {
    api_url(API, path)
}

pub fn google_events_request(
    calendar_id: &str,
    window: &Range<DateTime<Utc>>,
    page_token: Option<&str>,
) -> HttpRequestSpec {
    let mut spec = HttpRequestSpec::get(calendar_url(&["calendars", calendar_id, "events"]))
        .with_query("singleEvents", "true")
        .with_query("orderBy", "startTime")
        .with_query("timeMin", rfc3339(window.start))
        .with_query("timeMax", rfc3339(window.end))
        .with_query("maxResults", "250")
        .with_query("fields", EVENT_FIELDS);
    if let Some(token) = page_token.filter(|t| !t.is_empty()) {
        spec = spec.with_query("pageToken", token);
    }
    spec
}

pub fn google_calendar_list_request(page_token: Option<&str>) -> HttpRequestSpec {
    let mut spec = HttpRequestSpec::get(calendar_url(&["users", "me", "calendarList"]))
        .with_query("maxResults", "250")
        .with_query("fields", CALENDAR_FIELDS);
    if let Some(token) = page_token.filter(|t| !t.is_empty()) {
        spec = spec.with_query("pageToken", token);
    }
    spec
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GTime {
    date: Option<String>,
    date_time: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GPerson {
    email: Option<String>,
    display_name: Option<String>,
    #[serde(rename = "self")]
    is_self: bool,
    response_status: Option<String>,
    resource: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GEntryPoint {
    entry_point_type: Option<String>,
    uri: Option<String>,
    meeting_code: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GConference {
    entry_points: Vec<GEntryPoint>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GEvent {
    id: Option<String>,
    status: Option<String>,
    html_link: Option<String>,
    summary: Option<String>,
    description: Option<String>,
    location: Option<String>,
    start: Option<GTime>,
    end: Option<GTime>,
    original_start_time: Option<GTime>,
    organizer: Option<GPerson>,
    attendees: Vec<GPerson>,
    hangout_link: Option<String>,
    conference_data: Option<GConference>,
    recurring_event_id: Option<String>,
    event_type: Option<String>,
    transparency: Option<String>,
}

enum Resolved {
    Timed(DateTime<Utc>),
    Day(NaiveDate),
}

fn resolve_time(t: &GTime, fallback_zone: Option<&str>) -> Option<Resolved> {
    if let Some(dt) = t.date_time.as_deref() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(dt.trim()) {
            return Some(Resolved::Timed(parsed.with_timezone(&Utc)));
        }
        let naive = NaiveDateTime::parse_from_str(dt.trim(), "%Y-%m-%dT%H:%M:%S%.f").ok()?;
        let zone = t
            .time_zone
            .as_deref()
            .or(fallback_zone)
            .and_then(resolve_tzid)?;
        return Some(Resolved::Timed(zone.to_utc(naive)));
    }
    let date = NaiveDate::parse_from_str(t.date.as_deref()?.trim(), "%Y-%m-%d").ok()?;
    Some(Resolved::Day(date))
}

fn google_response(value: Option<&str>) -> Response {
    match value.unwrap_or_default() {
        "accepted" => Response::Accepted,
        "declined" => Response::Declined,
        "tentative" => Response::Tentative,
        "needsAction" => Response::NeedsAction,
        _ => Response::Unknown,
    }
}

fn person(p: &GPerson, self_emails: &[String]) -> Person {
    Person {
        name: non_empty(p.display_name.as_deref()),
        email: non_empty(p.email.as_deref()),
        is_self: p.is_self || is_self_email(p.email.as_deref(), self_emails),
        response: google_response(p.response_status.as_deref()),
    }
}

const STATUS_EVENT_TYPES: [&str; 3] = ["workingLocation", "outOfOffice", "focusTime"];

fn map_event(
    e: GEvent,
    calendar_id: &str,
    zone: Option<&str>,
    opts: &GoogleOptions,
) -> Option<CalendarEvent> {
    let status = match e.status.as_deref() {
        Some("cancelled") => EventStatus::Cancelled,
        Some("tentative") => EventStatus::Tentative,
        _ => EventStatus::Confirmed,
    };
    if status == EventStatus::Cancelled && !opts.include_cancelled {
        return None;
    }
    if !opts.include_status_events
        && e.event_type
            .as_deref()
            .is_some_and(|t| STATUS_EVENT_TYPES.contains(&t))
    {
        return None;
    }
    let id = non_empty(e.id.as_deref())?;
    let start = e
        .start
        .as_ref()
        .or(e.original_start_time.as_ref())
        .and_then(|t| resolve_time(t, zone))?;
    let end = e.end.as_ref().and_then(|t| resolve_time(t, zone));
    let midnight = NaiveTime::MIN;
    let (start, end, all_day) = match (start, end) {
        (Resolved::Day(s), end) => {
            let e_date = match end {
                Some(Resolved::Day(d)) if d > s => d,
                _ => s.succ_opt().unwrap_or(s),
            };
            (
                s.and_time(midnight).and_utc(),
                e_date.and_time(midnight).and_utc(),
                true,
            )
        }
        (Resolved::Timed(s), Some(Resolved::Timed(end))) if end >= s => (s, end, false),
        (Resolved::Timed(s), _) => (s, s, false),
    };
    let organizer = e.organizer.as_ref().map(|o| person(o, &opts.self_emails));
    let attendees: Vec<Person> = e
        .attendees
        .iter()
        .filter(|a| !a.resource)
        .map(|a| person(a, &opts.self_emails))
        .collect();
    let mut conference: Vec<ConferenceEntry> = e
        .conference_data
        .as_ref()
        .map(|c| {
            c.entry_points
                .iter()
                .filter_map(|ep| {
                    Some(ConferenceEntry {
                        kind: ConferenceKind::from_entry_point_type(
                            ep.entry_point_type.as_deref().unwrap_or_default(),
                        ),
                        uri: non_empty(ep.uri.as_deref())?,
                        meeting_code: non_empty(ep.meeting_code.as_deref()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if let Some(hangout) = non_empty(e.hangout_link.as_deref())
        && !conference.iter().any(|c| c.kind == ConferenceKind::Video)
    {
        conference.push(ConferenceEntry::video(hangout));
    }
    let link = event_meeting_link(
        &conference,
        e.location.as_deref(),
        e.description.as_deref(),
        None,
    );
    let self_response = derive_self_response(organizer.as_ref(), &attendees, Response::Unknown);
    let event = CalendarEvent {
        id,
        series_id: non_empty(e.recurring_event_id.as_deref()),
        calendar_id: calendar_id.to_string(),
        source: SourceKind::Google,
        title: e.summary.map(|s| s.trim().to_string()).unwrap_or_default(),
        start,
        end,
        all_day,
        location: non_empty(e.location.as_deref()),
        description: non_empty(e.description.as_deref()),
        organizer,
        attendees,
        self_response,
        link,
        status,
        web_url: non_empty(e.html_link.as_deref()),
        free: e.transparency.as_deref() == Some("transparent"),
    };
    Some(event.bounded())
}

pub(crate) fn array_field<'a>(value: &'a Value, name: &str) -> Result<&'a [Value], Error> {
    match value.get(name) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(Error::InvalidResponse(format!("{name} is not an array"))),
    }
}

fn items(value: &Value) -> Result<&[Value], Error> {
    array_field(value, "items")
}

fn next_token(value: &Value) -> Option<String> {
    non_empty(value.get("nextPageToken").and_then(Value::as_str))
}

pub fn parse_google_events(json: &str, calendar_id: &str) -> Result<Page<CalendarEvent>, Error> {
    parse_google_events_with(json, calendar_id, &GoogleOptions::default())
}

pub fn parse_google_events_with(
    json: &str,
    calendar_id: &str,
    opts: &GoogleOptions,
) -> Result<Page<CalendarEvent>, Error> {
    let value = parse_json(json)?;
    if !value.is_object() {
        return Err(Error::InvalidResponse("expected an object".to_string()));
    }
    let zone = value.get("timeZone").and_then(Value::as_str);
    let mut page = Page {
        items: Vec::new(),
        next: next_token(&value),
        skipped: 0,
    };
    for item in items(&value)? {
        let mapped = serde_json::from_value::<GEvent>(item.clone())
            .ok()
            .and_then(|e| map_event(e, calendar_id, zone, opts));
        match mapped {
            Some(event) => page.items.push(event),
            None => page.skipped += 1,
        }
    }
    Ok(page)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct GCalendar {
    id: Option<String>,
    summary: Option<String>,
    summary_override: Option<String>,
    primary: bool,
    background_color: Option<String>,
    selected: bool,
    access_role: Option<String>,
    time_zone: Option<String>,
    deleted: bool,
}

pub fn parse_google_calendar_list(json: &str) -> Result<Page<CalendarInfo>, Error> {
    let value = parse_json(json)?;
    let mut page = Page {
        items: Vec::new(),
        next: next_token(&value),
        skipped: 0,
    };
    for item in items(&value)? {
        let Some(cal) = serde_json::from_value::<GCalendar>(item.clone())
            .ok()
            .filter(|c| !c.deleted)
        else {
            page.skipped += 1;
            continue;
        };
        let Some(id) = non_empty(cal.id.as_deref()) else {
            page.skipped += 1;
            continue;
        };
        let name = non_empty(cal.summary_override.as_deref())
            .or_else(|| non_empty(cal.summary.as_deref()))
            .unwrap_or_else(|| id.clone());
        page.items.push(CalendarInfo {
            owner_email: (cal.primary && id.contains('@')).then(|| id.clone()),
            id,
            name,
            source: SourceKind::Google,
            primary: cal.primary,
            color: non_empty(cal.background_color.as_deref()),
            selected: cal.selected || cal.primary,
            access_role: non_empty(cal.access_role.as_deref()),
            time_zone: non_empty(cal.time_zone.as_deref()),
        });
    }
    Ok(page)
}
