use std::collections::{HashMap, HashSet};
use std::ops::Range;

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};

use super::budget::Budget;
use super::{Exclusion, ParsedCalendar, RawEvent, RawPerson};
use crate::link::{classify_url, event_meeting_link, find_meeting_link};
use crate::model::{
    CalendarEvent, EventStatus, Person, Response, SourceKind, derive_self_response, is_self_email,
};
use crate::text::html_to_text;

/// Most memory the events of one feed may hold once expanded. One series with
/// huge fields can otherwise repeat them on up to a thousand occurrences.
const EXPANDED_BYTES: usize = 64 * 1024 * 1024;

pub fn expand(
    cal: &ParsedCalendar,
    window: Range<DateTime<Utc>>,
    self_emails: &[String],
) -> Vec<CalendarEvent> {
    if window.start >= window.end {
        return Vec::new();
    }
    let opts = &cal.options;
    let mut budget = cal.budget;
    let mut overrides: HashMap<&str, Vec<&RawEvent>> = HashMap::new();
    let mut masters: Vec<&RawEvent> = Vec::new();
    for event in &cal.events {
        if event.recurrence_id.is_some() {
            overrides.entry(event.uid.as_str()).or_default().push(event);
        } else {
            masters.push(event);
        }
    }
    let builder = Builder {
        calendar_id: &opts.calendar_id,
        self_emails,
    };
    let keep = |status: EventStatus| status != EventStatus::Cancelled || opts.include_cancelled;
    let overlaps =
        |start: DateTime<Utc>, end: DateTime<Utc>| start < window.end && end > window.start;

    let mut out: Vec<CalendarEvent> = Vec::new();
    let mut memory_left = EXPANDED_BYTES;
    for master in masters {
        let room = opts.max_events.saturating_sub(out.len());
        if room == 0 {
            break;
        }
        if !keep(master.status) {
            continue;
        }
        let replaced: HashSet<i64> = overrides
            .get(master.uid.as_str())
            .map(|list| {
                list.iter()
                    .filter_map(|o| o.recurrence_id.map(|r| r.timestamp()))
                    .collect()
            })
            .unwrap_or_default();
        let recurring = master.is_recurring() || !replaced.is_empty();
        let excluded = Excluded::new(master);
        let skip = |wall: NaiveDateTime, start: DateTime<Utc>| {
            replaced.contains(&start.timestamp()) || excluded.contains(wall, start)
        };
        let template = builder.template(master);
        let weight = template.approx_bytes();
        let cap = opts
            .max_instances_per_series
            .min(room)
            .min(memory_left / weight);
        for (wall, start) in occurrences(master, &window, cap, &skip, &mut budget) {
            let end = master.end_for(wall, start);
            let original = recurring.then_some(start);
            out.push(builder.occurrence(&template, master, start, end, original));
            memory_left -= weight;
        }
    }
    let cancelled_series: HashSet<&str> = cal
        .events
        .iter()
        .filter(|e| e.recurrence_id.is_none() && !keep(e.status))
        .map(|e| e.uid.as_str())
        .collect();
    'overrides: for (uid, list) in overrides {
        if cancelled_series.contains(uid) {
            continue;
        }
        for event in list {
            if out.len() >= opts.max_events {
                break 'overrides;
            }
            if !keep(event.status) {
                continue;
            }
            let start = event.start_utc();
            let end = event.end_for(event.start_wall, start);
            if overlaps(start, end) {
                let template = builder.template(event);
                let weight = template.approx_bytes();
                if weight > memory_left {
                    continue;
                }
                memory_left -= weight;
                out.push(builder.occurrence(&template, event, start, end, event.recurrence_id));
            }
        }
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.id.cmp(&b.id)));
    out.truncate(opts.max_events);
    let mut seen: HashMap<String, usize> = HashMap::new();
    for event in &mut out {
        let count = seen.entry(event.id.clone()).or_insert(0);
        *count += 1;
        if *count > 1 {
            event.id = format!("{}#{}", event.id, count);
        }
    }
    out
}

struct Excluded {
    instants: HashSet<DateTime<Utc>>,
    days: HashSet<NaiveDate>,
}

impl Excluded {
    fn new(event: &RawEvent) -> Self {
        let mut instants = HashSet::new();
        let mut days = HashSet::new();
        for ex in &event.exdates {
            match ex {
                Exclusion::Instant(i) => {
                    instants.insert(*i);
                }
                Exclusion::Day(d) => {
                    days.insert(*d);
                }
            }
        }
        Self { instants, days }
    }

    fn contains(&self, wall: NaiveDateTime, start: DateTime<Utc>) -> bool {
        self.instants.contains(&start) || self.days.contains(&wall.date())
    }
}

fn occurrences(
    event: &RawEvent,
    window: &Range<DateTime<Utc>>,
    cap: usize,
    skip: &impl Fn(NaiveDateTime, DateTime<Utc>) -> bool,
    budget: &mut Budget,
) -> Vec<(NaiveDateTime, DateTime<Utc>)> {
    let wanted = |wall: NaiveDateTime, utc: DateTime<Utc>| {
        !skip(wall, utc) && utc < window.end && event.end_for(wall, utc) > window.start
    };
    let start = event.start_utc();
    let mut found = Vec::new();
    if wanted(event.start_wall, start) {
        found.push((event.start_wall, start));
    }
    if let Some(rule) = &event.rule {
        let margin = Duration::days(2);
        let wall_end = event
            .zone
            .from_utc(window.end)
            .checked_add_signed(margin)
            .unwrap_or(NaiveDateTime::MAX);
        let anchor = event
            .zone
            .from_utc(window.start)
            .checked_sub_signed(event.span.upper_bound())
            .and_then(|a| a.checked_sub_signed(margin))
            .unwrap_or(event.start_wall);
        let mut in_window = 0usize;
        for wall in rule.walls(event.start_wall, anchor, budget) {
            if wall > wall_end || in_window >= cap {
                break;
            }
            let utc = event.zone.to_utc(wall);
            if utc == start || !wanted(wall, utc) {
                continue;
            }
            in_window += 1;
            found.push((wall, utc));
        }
    }
    found.extend(
        event
            .rdates
            .iter()
            .map(|r| (event.zone.from_utc(*r), *r))
            .filter(|(wall, utc)| wanted(*wall, *utc)),
    );
    found.sort_by_key(|(_, utc)| *utc);
    found.dedup_by_key(|(_, utc)| *utc);
    found.truncate(cap);
    found
}

fn occurrence_key(start: DateTime<Utc>, all_day: bool) -> String {
    if all_day {
        start.format("%Y%m%d").to_string()
    } else {
        start.format("%Y%m%dT%H%M%SZ").to_string()
    }
}

struct Builder<'a> {
    calendar_id: &'a str,
    self_emails: &'a [String],
}

impl Builder<'_> {
    fn person(&self, raw: &RawPerson) -> Person {
        Person {
            name: raw.name.clone(),
            email: raw.email.clone(),
            is_self: is_self_email(raw.email.as_deref(), self.self_emails),
            response: raw.response,
        }
    }

    /// Everything about `raw` that every occurrence shares, held to the
    /// event limits, with the series uid as its id. Built once per series.
    fn template(&self, raw: &RawEvent) -> CalendarEvent {
        let organizer = raw.organizer.as_ref().map(|o| self.person(o));
        let mut attendees: Vec<Person> = Vec::with_capacity(raw.attendees.len());
        let mut emails: HashSet<String> = HashSet::with_capacity(raw.attendees.len());
        for person in raw.attendees.iter().map(|a| self.person(a)) {
            let duplicate = person
                .email
                .as_deref()
                .is_some_and(|email| !emails.insert(email.to_ascii_lowercase()));
            if !duplicate {
                attendees.push(person);
            }
        }
        let self_response = derive_self_response(organizer.as_ref(), &attendees, Response::Unknown);
        let link = event_meeting_link(
            &raw.conference,
            raw.location.as_deref(),
            raw.description.as_deref(),
            None,
        )
        .or_else(|| raw.alt_description.as_deref().and_then(find_meeting_link))
        .or_else(|| raw.url.as_deref().and_then(classify_url));
        let description = raw.description.clone().or_else(|| {
            raw.alt_description
                .as_deref()
                .map(html_to_text)
                .filter(|d| !d.trim().is_empty())
        });
        CalendarEvent {
            id: raw.uid.clone(),
            series_id: None,
            calendar_id: self.calendar_id.to_string(),
            source: SourceKind::Ics,
            title: raw.title.clone(),
            start: DateTime::<Utc>::MIN_UTC,
            end: DateTime::<Utc>::MIN_UTC,
            all_day: raw.all_day,
            location: raw.location.clone(),
            description,
            organizer,
            attendees,
            self_response,
            link,
            status: raw.status,
            web_url: raw
                .url
                .clone()
                .filter(|u| u.starts_with("https://") || u.starts_with("http://")),
            free: raw.free,
        }
        .bounded()
    }

    fn occurrence(
        &self,
        template: &CalendarEvent,
        raw: &RawEvent,
        start: DateTime<Utc>,
        end: DateTime<Utc>,
        original: Option<DateTime<Utc>>,
    ) -> CalendarEvent {
        // The template's id is the series uid, already held to the id limit.
        let uid = &template.id;
        let id = match original {
            Some(original) => format!("{uid}_{}", occurrence_key(original, raw.all_day)),
            None => uid.clone(),
        };
        CalendarEvent {
            id,
            series_id: original.map(|_| uid.clone()),
            start,
            end,
            ..template.clone()
        }
    }
}
