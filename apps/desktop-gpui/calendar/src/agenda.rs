use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;

use crate::model::{CalendarEvent, SourceKind};
use crate::text::normalize_title;

pub const DEFAULT_LEAD: Duration = Duration::seconds(60);
pub const MAX_LEAD: Duration = Duration::minutes(15);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filter {
    pub hide_declined: bool,
    pub hide_all_day: bool,
    pub hide_without_participants: bool,
    pub hidden_calendar_ids: HashSet<String>,
}

impl Default for Filter {
    fn default() -> Self {
        Self {
            hide_declined: true,
            hide_all_day: true,
            hide_without_participants: false,
            hidden_calendar_ids: HashSet::new(),
        }
    }
}

impl Filter {
    pub fn allows(&self, event: &CalendarEvent) -> bool {
        !event.is_cancelled()
            && !(self.hide_declined && event.is_declined())
            && !(self.hide_all_day && event.all_day)
            && !(self.hide_without_participants && !event.has_participants())
            && !self.hidden_calendar_ids.contains(&event.calendar_id)
    }
}

fn source_rank(source: SourceKind) -> u8 {
    match source {
        SourceKind::Google | SourceKind::Microsoft => 3,
        SourceKind::System => 2,
        SourceKind::Ics => 1,
    }
}

fn richness(e: &CalendarEvent) -> (u8, bool, usize, bool) {
    (
        source_rank(e.source),
        e.link.is_some(),
        e.attendees.len(),
        e.description.is_some(),
    )
}

fn fill_missing(keep: &mut CalendarEvent, other: CalendarEvent) {
    if keep.link.is_none() {
        keep.link = other.link;
    }
    if keep.location.is_none() {
        keep.location = other.location;
    }
    if keep.description.is_none() {
        keep.description = other.description;
    }
    if keep.web_url.is_none() {
        keep.web_url = other.web_url;
    }
    if keep.attendees.is_empty() {
        keep.attendees = other.attendees;
    }
    if keep.organizer.is_none() {
        keep.organizer = other.organizer;
    }
}

fn dedup_keys(e: &CalendarEvent) -> Vec<String> {
    let start = e.start.timestamp();
    let mut keys = Vec::with_capacity(2);
    if let Some(link) = &e.link
        && let Some(id) = &link.meeting_id
    {
        keys.push(format!(
            "m|{}|{}|{start}",
            link.provider.slug(),
            id.to_ascii_lowercase()
        ));
    }
    let title = normalize_title(&e.title);
    if !title.is_empty() {
        keys.push(format!("t|{title}|{start}|{}", e.all_day));
    }
    keys
}

pub fn dedupe(events: Vec<CalendarEvent>) -> Vec<CalendarEvent> {
    let mut unique: Vec<CalendarEvent> = Vec::with_capacity(events.len());
    let mut ids: HashMap<(SourceKind, String, String), usize> = HashMap::new();
    for event in events {
        let id_key = (event.source, event.calendar_id.clone(), event.id.clone());
        match ids.get(&id_key) {
            Some(&i) => unique[i] = event,
            None => {
                ids.insert(id_key, unique.len());
                unique.push(event);
            }
        }
    }
    let mut parent: Vec<usize> = (0..unique.len()).collect();
    let mut owner: HashMap<String, usize> = HashMap::new();
    for (i, event) in unique.iter().enumerate() {
        for key in dedup_keys(event) {
            match owner.get(&key) {
                Some(&j) => union(&mut parent, i, j),
                None => {
                    owner.insert(key, i);
                }
            }
        }
    }
    let mut groups: HashMap<usize, Vec<CalendarEvent>> = HashMap::new();
    for (i, event) in unique.into_iter().enumerate() {
        groups.entry(root(&mut parent, i)).or_default().push(event);
    }
    let mut out: Vec<CalendarEvent> = groups.into_values().filter_map(merge_group).collect();
    out.sort_by(compare_events);
    out
}

fn root(parent: &mut [usize], mut i: usize) -> usize {
    while parent[i] != i {
        parent[i] = parent[parent[i]];
        i = parent[i];
    }
    i
}

fn union(parent: &mut [usize], a: usize, b: usize) {
    let (a, b) = (root(parent, a), root(parent, b));
    if a != b {
        parent[a.max(b)] = a.min(b);
    }
}

fn source_order(source: SourceKind) -> u8 {
    match source {
        SourceKind::Google => 0,
        SourceKind::Microsoft => 1,
        SourceKind::System => 2,
        SourceKind::Ics => 3,
    }
}

fn merge_group(mut group: Vec<CalendarEvent>) -> Option<CalendarEvent> {
    group.sort_by(|a, b| {
        richness(b)
            .cmp(&richness(a))
            .then_with(|| source_order(a.source).cmp(&source_order(b.source)))
            .then_with(|| a.calendar_id.cmp(&b.calendar_id))
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut members = group.into_iter();
    let mut keep = members.next()?;
    for other in members {
        fill_missing(&mut keep, other);
    }
    Some(keep)
}

fn preference(e: &CalendarEvent) -> (bool, usize) {
    (e.link.is_some(), e.other_participants())
}

fn compare_events(a: &CalendarEvent, b: &CalendarEvent) -> Ordering {
    a.start
        .cmp(&b.start)
        .then_with(|| preference(b).cmp(&preference(a)))
        .then_with(|| a.end.cmp(&b.end))
        .then_with(|| a.title.cmp(&b.title))
        .then_with(|| a.id.cmp(&b.id))
        .then_with(|| a.calendar_id.cmp(&b.calendar_id))
        .then_with(|| source_order(a.source).cmp(&source_order(b.source)))
}

fn effective_end(e: &CalendarEvent) -> DateTime<Utc> {
    if e.end > e.start {
        e.end
    } else {
        e.start
            .checked_add_signed(Duration::minutes(1))
            .unwrap_or(e.start)
    }
}

fn fire_time(e: &CalendarEvent, lead: Duration) -> DateTime<Utc> {
    e.start.checked_sub_signed(lead).unwrap_or(e.start)
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Agenda {
    events: Vec<CalendarEvent>,
}

impl Agenda {
    /// `events` are every source's own copies, not yet deduped: a hidden
    /// calendar drops only its copy, so a meeting also on a shown calendar
    /// stays. The other filters judge the merged meeting, which knows the
    /// most about it (a decline, its guests).
    pub fn new(events: Vec<CalendarEvent>, filter: &Filter) -> Self {
        let shown = events
            .into_iter()
            .filter(|e| !filter.hidden_calendar_ids.contains(&e.calendar_id))
            .collect();
        let events = dedupe(shown)
            .into_iter()
            .filter(|e| filter.allows(e))
            .collect();
        Self { events }
    }

    pub fn events(&self) -> &[CalendarEvent] {
        &self.events
    }

    fn timed(&self) -> impl Iterator<Item = &CalendarEvent> {
        self.events.iter().filter(|e| !e.all_day)
    }

    pub fn current(&self, now: DateTime<Utc>) -> Vec<&CalendarEvent> {
        let mut out: Vec<&CalendarEvent> = self
            .timed()
            .filter(|e| e.start <= now && now < effective_end(e))
            .collect();
        out.sort_by(|a, b| {
            b.start
                .cmp(&a.start)
                .then_with(|| preference(b).cmp(&preference(a)))
        });
        out
    }

    pub fn next(&self, now: DateTime<Utc>) -> Option<&CalendarEvent> {
        self.timed().find(|e| e.start > now)
    }

    pub fn upcoming(&self, now: DateTime<Utc>, horizon: Duration) -> Vec<&CalendarEvent> {
        let until = now
            .checked_add_signed(horizon)
            .unwrap_or(DateTime::<Utc>::MAX_UTC);
        self.timed()
            .filter(|e| effective_end(e) > now && e.start < until)
            .collect()
    }

    pub fn for_day(&self, date: NaiveDate, tz: Tz) -> Vec<&CalendarEvent> {
        let day_start = local_midnight(date, tz);
        let day_end = date
            .succ_opt()
            .map_or(DateTime::<Utc>::MAX_UTC, |d| local_midnight(d, tz));
        self.events
            .iter()
            .filter(|e| {
                if e.all_day {
                    let first = e.start.date_naive();
                    let last = e.end.date_naive();
                    first <= date && (date < last || (first == last && first == date))
                } else {
                    e.start < day_end && effective_end(e) > day_start
                }
            })
            .collect()
    }
}

fn local_midnight(date: NaiveDate, tz: Tz) -> DateTime<Utc> {
    let naive = date.and_time(NaiveTime::MIN);
    tz.from_local_datetime(&naive)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(|| crate::tz::Zone::Named(tz).to_utc(naive))
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reminder {
    pub key: String,
    pub fire_at: DateTime<Utc>,
    pub event: CalendarEvent,
}

pub fn reminder_key(event: &CalendarEvent) -> String {
    format!(
        "{}|{}|{}",
        event.calendar_id,
        event.id,
        event.start.timestamp()
    )
}

fn remindable(e: &CalendarEvent) -> bool {
    !e.all_day && !e.is_cancelled() && !e.is_declined()
}

fn clamp_lead(lead: Duration) -> Duration {
    lead.clamp(Duration::zero(), MAX_LEAD)
}

pub fn due_reminders(
    events: &[CalendarEvent],
    now: DateTime<Utc>,
    lead: Duration,
    already_notified: &HashSet<String>,
) -> Vec<Reminder> {
    let lead = clamp_lead(lead);
    let mut out: Vec<Reminder> = events
        .iter()
        .filter(|e| remindable(e))
        .filter(|e| fire_time(e, lead) <= now && now < effective_end(e))
        .filter_map(|e| {
            let key = reminder_key(e);
            (!already_notified.contains(&key)).then(|| Reminder {
                key,
                fire_at: fire_time(e, lead),
                event: e.clone(),
            })
        })
        .collect();
    out.sort_by(|a, b| compare_events(&a.event, &b.event));
    out.dedup_by(|a, b| a.key == b.key);
    out
}

pub fn next_wake(
    events: &[CalendarEvent],
    now: DateTime<Utc>,
    lead: Duration,
) -> Option<DateTime<Utc>> {
    let lead = clamp_lead(lead);
    events
        .iter()
        .filter(|e| remindable(e))
        .map(|e| fire_time(e, lead))
        .filter(|fire| *fire > now)
        .min()
}
