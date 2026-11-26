use std::ops::Range;

use chrono::{DateTime, NaiveDateTime, NaiveTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::Value;

use crate::error::{Error, parse_json};
use crate::google::array_field;
use crate::http::{HttpRequestSpec, api_url};
use crate::link::{ConferenceEntry, event_meeting_link};
use crate::model::{
    CalendarEvent, CalendarInfo, EventStatus, Page, Person, Response, SourceKind,
    derive_self_response, is_self_email,
};
use crate::text::{html_to_text, looks_like_html, non_empty};
use crate::tz::{Zone, resolve_tzid};

const API: &str = "https://graph.microsoft.com/v1.0";
const TRUSTED_PREFIX: &str = "https://graph.microsoft.com/";

const EVENT_SELECT: &str = "id,subject,body,bodyPreview,start,end,isAllDay,isCancelled,location,locations,organizer,attendees,responseStatus,onlineMeeting,onlineMeetingUrl,isOnlineMeeting,onlineMeetingProvider,seriesMasterId,type,webLink,showAs";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GraphOptions {
    pub include_cancelled: bool,
    pub self_emails: Vec<String>,
}

fn with_common_headers(spec: HttpRequestSpec) -> HttpRequestSpec {
    spec.with_header("Prefer", "outlook.timezone=\"UTC\"")
        .with_header("Accept", "application/json")
}

fn trusted_next_link(next_link: &str) -> Result<HttpRequestSpec, Error> {
    let trimmed = next_link.trim();
    let parsed = url::Url::parse(trimmed).map_err(|_| Error::UntrustedUrl(trimmed.to_string()))?;
    if !trimmed.starts_with(TRUSTED_PREFIX)
        || parsed.host_str() != Some("graph.microsoft.com")
        || parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.port().is_some()
    {
        return Err(Error::UntrustedUrl(trimmed.to_string()));
    }
    Ok(with_common_headers(HttpRequestSpec::get(
        parsed.to_string(),
    )))
}

pub fn graph_calendar_view_request(
    calendar_id: Option<&str>,
    window: &Range<DateTime<Utc>>,
    next_link: Option<&str>,
) -> Result<HttpRequestSpec, Error> {
    if let Some(next) = next_link.filter(|n| !n.trim().is_empty()) {
        return trusted_next_link(next);
    }
    let url = match calendar_id.filter(|c| !c.is_empty()) {
        Some(id) => api_url(API, &["me", "calendars", id, "calendarView"]),
        None => api_url(API, &["me", "calendarView"]),
    };
    let spec = HttpRequestSpec::get(url)
        .with_query(
            "startDateTime",
            window.start.to_rfc3339_opts(SecondsFormat::Secs, true),
        )
        .with_query(
            "endDateTime",
            window.end.to_rfc3339_opts(SecondsFormat::Secs, true),
        )
        .with_query("$select", EVENT_SELECT)
        .with_query("$orderby", "start/dateTime")
        .with_query("$top", "250");
    Ok(with_common_headers(spec))
}

pub fn graph_calendars_request(next_link: Option<&str>) -> Result<HttpRequestSpec, Error> {
    if let Some(next) = next_link.filter(|n| !n.trim().is_empty()) {
        return trusted_next_link(next);
    }
    Ok(with_common_headers(
        HttpRequestSpec::get(api_url(API, &["me", "calendars"]))
            .with_query(
                "$select",
                "id,name,color,hexColor,isDefaultCalendar,canEdit,owner",
            )
            .with_query("$top", "100"),
    ))
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MTime {
    date_time: Option<String>,
    time_zone: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MEmail {
    name: Option<String>,
    address: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MStatus {
    response: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MAttendee {
    #[serde(rename = "type")]
    kind: Option<String>,
    status: Option<MStatus>,
    email_address: Option<MEmail>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MOrganizer {
    email_address: Option<MEmail>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MBody {
    content_type: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MLocation {
    display_name: Option<String>,
    location_uri: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MOnlineMeeting {
    join_url: Option<String>,
    conference_id: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MEvent {
    id: Option<String>,
    subject: Option<String>,
    body: Option<MBody>,
    body_preview: Option<String>,
    start: Option<MTime>,
    end: Option<MTime>,
    is_all_day: bool,
    is_cancelled: bool,
    location: Option<MLocation>,
    locations: Vec<MLocation>,
    organizer: Option<MOrganizer>,
    attendees: Vec<MAttendee>,
    response_status: Option<MStatus>,
    online_meeting: Option<MOnlineMeeting>,
    online_meeting_url: Option<String>,
    series_master_id: Option<String>,
    web_link: Option<String>,
    show_as: Option<String>,
}

fn graph_response(value: Option<&str>) -> Response {
    match value.unwrap_or_default() {
        "accepted" | "organizer" => Response::Accepted,
        "declined" => Response::Declined,
        "tentativelyAccepted" => Response::Tentative,
        "notResponded" => Response::NeedsAction,
        _ => Response::Unknown,
    }
}

fn parse_graph_time(t: &MTime) -> Option<(NaiveDateTime, Zone)> {
    let raw = t.date_time.as_deref()?.trim();
    let naive = NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M"))
        .ok()
        .or_else(|| {
            DateTime::parse_from_rfc3339(raw)
                .ok()
                .map(|d| d.with_timezone(&Utc).naive_utc())
        })?;
    let zone = t
        .time_zone
        .as_deref()
        .and_then(resolve_tzid)
        .unwrap_or(Zone::Utc);
    Some((naive, zone))
}

fn email_person(email: &MEmail, self_emails: &[String], response: Response) -> Person {
    Person {
        name: non_empty(email.name.as_deref()),
        email: non_empty(email.address.as_deref()),
        is_self: is_self_email(email.address.as_deref(), self_emails),
        response,
    }
}

fn map_event(e: MEvent, calendar_id: &str, opts: &GraphOptions) -> Option<CalendarEvent> {
    let status = if e.is_cancelled {
        EventStatus::Cancelled
    } else {
        EventStatus::Confirmed
    };
    if status == EventStatus::Cancelled && !opts.include_cancelled {
        return None;
    }
    let id = non_empty(e.id.as_deref())?;
    let (start_naive, start_zone) = e.start.as_ref().and_then(parse_graph_time)?;
    let end = e.end.as_ref().and_then(parse_graph_time);
    let (start, end) = if e.is_all_day {
        let start_date = start_naive.date();
        let end_date = end
            .map(|(n, _)| n.date())
            .filter(|d| *d > start_date)
            .or_else(|| start_date.succ_opt())
            .unwrap_or(start_date);
        (
            start_date.and_time(NaiveTime::MIN).and_utc(),
            end_date.and_time(NaiveTime::MIN).and_utc(),
        )
    } else {
        let start = start_zone.to_utc(start_naive);
        let end = end
            .map(|(n, z)| z.to_utc(n))
            .filter(|e| *e >= start)
            .unwrap_or(start);
        (start, end)
    };
    let organizer = e
        .organizer
        .as_ref()
        .and_then(|o| o.email_address.as_ref())
        .map(|em| email_person(em, &opts.self_emails, Response::Accepted));
    let attendees: Vec<Person> = e
        .attendees
        .iter()
        .filter(|a| {
            !a.kind
                .as_deref()
                .is_some_and(|k| k.eq_ignore_ascii_case("resource"))
        })
        .filter_map(|a| {
            let response = graph_response(a.status.as_ref().and_then(|s| s.response.as_deref()));
            a.email_address
                .as_ref()
                .map(|em| email_person(em, &opts.self_emails, response))
        })
        .collect();
    let fallback = graph_response(
        e.response_status
            .as_ref()
            .and_then(|s| s.response.as_deref()),
    );
    let mut organizer = organizer;
    if e.response_status
        .as_ref()
        .and_then(|s| s.response.as_deref())
        == Some("organizer")
        && let Some(org) = organizer.as_mut()
    {
        org.is_self = true;
    }
    let self_response = derive_self_response(organizer.as_ref(), &attendees, fallback);

    let mut conference = Vec::new();
    if let Some(join) = e
        .online_meeting
        .as_ref()
        .and_then(|m| non_empty(m.join_url.as_deref()))
    {
        conference.push(ConferenceEntry {
            meeting_code: e
                .online_meeting
                .as_ref()
                .and_then(|m| non_empty(m.conference_id.as_deref())),
            ..ConferenceEntry::video(join)
        });
    }
    if let Some(url) = non_empty(e.online_meeting_url.as_deref()) {
        conference.push(ConferenceEntry::video(url));
    }
    let location = e
        .location
        .as_ref()
        .and_then(|l| non_empty(l.display_name.as_deref()));
    let location_uris: Vec<&str> = e
        .location
        .iter()
        .chain(e.locations.iter())
        .filter_map(|l| l.location_uri.as_deref())
        .collect();
    let body = e.body.as_ref().and_then(|b| b.content.as_deref());
    let link = event_meeting_link(&conference, location.as_deref(), body, None).or_else(|| {
        location_uris
            .iter()
            .find_map(|u| crate::link::classify_url(u))
    });
    let is_html = e
        .body
        .as_ref()
        .and_then(|b| b.content_type.as_deref())
        .is_some_and(|t| t.eq_ignore_ascii_case("html"))
        || body.is_some_and(looks_like_html);
    let description = body
        .map(|b| {
            if is_html {
                html_to_text(b)
            } else {
                b.to_string()
            }
        })
        .and_then(|d| non_empty(Some(&d)))
        .or_else(|| non_empty(e.body_preview.as_deref()));

    Some(CalendarEvent {
        id,
        series_id: non_empty(e.series_master_id.as_deref()),
        calendar_id: calendar_id.to_string(),
        source: SourceKind::Microsoft,
        title: e.subject.map(|s| s.trim().to_string()).unwrap_or_default(),
        start,
        end,
        all_day: e.is_all_day,
        location,
        description,
        organizer,
        attendees,
        self_response,
        link,
        status,
        web_url: non_empty(e.web_link.as_deref()),
        free: e.show_as.as_deref() == Some("free"),
    })
}

fn next_link(value: &Value) -> Option<String> {
    non_empty(value.get("@odata.nextLink").and_then(Value::as_str))
}

pub fn parse_graph_events(json: &str, calendar_id: &str) -> Result<Page<CalendarEvent>, Error> {
    parse_graph_events_with(json, calendar_id, &GraphOptions::default())
}

pub fn parse_graph_events_with(
    json: &str,
    calendar_id: &str,
    opts: &GraphOptions,
) -> Result<Page<CalendarEvent>, Error> {
    let value = parse_json(json)?;
    if !value.is_object() {
        return Err(Error::InvalidResponse("expected an object".to_string()));
    }
    let mut page = Page {
        items: Vec::new(),
        next: next_link(&value),
        skipped: 0,
    };
    for item in array_field(&value, "value")? {
        let mapped = serde_json::from_value::<MEvent>(item.clone())
            .ok()
            .and_then(|e| map_event(e, calendar_id, opts));
        match mapped {
            Some(event) => page.items.push(event),
            None => page.skipped += 1,
        }
    }
    Ok(page)
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MCalendar {
    id: Option<String>,
    name: Option<String>,
    hex_color: Option<String>,
    is_default_calendar: bool,
    can_edit: bool,
    owner: Option<MEmail>,
}

pub fn parse_graph_calendars(json: &str) -> Result<Page<CalendarInfo>, Error> {
    let value = parse_json(json)?;
    let mut page = Page {
        items: Vec::new(),
        next: next_link(&value),
        skipped: 0,
    };
    for item in array_field(&value, "value")? {
        let Some(cal) = serde_json::from_value::<MCalendar>(item.clone()).ok() else {
            page.skipped += 1;
            continue;
        };
        let Some(id) = non_empty(cal.id.as_deref()) else {
            page.skipped += 1;
            continue;
        };
        page.items.push(CalendarInfo {
            name: non_empty(cal.name.as_deref()).unwrap_or_else(|| id.clone()),
            id,
            source: SourceKind::Microsoft,
            primary: cal.is_default_calendar,
            color: non_empty(cal.hex_color.as_deref()),
            selected: true,
            access_role: Some(if cal.can_edit { "writer" } else { "reader" }.to_string()),
            owner_email: cal.owner.and_then(|o| non_empty(o.address.as_deref())),
            time_zone: None,
        });
    }
    Ok(page)
}
