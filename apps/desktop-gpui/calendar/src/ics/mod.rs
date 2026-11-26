mod budget;
mod expand;
mod lexer;
mod rule;
mod time;
mod vtimezone;

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use chrono_tz::Tz;

use crate::link::{ConferenceEntry, ConferenceKind};
use crate::model::{EventStatus, Response, response_from_partstat};
use crate::text::non_empty;
use crate::tz::{Zone, resolve_tzid};

pub use expand::expand;
pub use vtimezone::ZoneResolution;

use budget::{Budget, FEED_BUDGET};
use lexer::{Component, Property, lex, unescape_text};
use time::{IcsTime, parse_duration_parts, parse_property};

const MAX_VTIMEZONES: usize = 64;

#[derive(Clone, Debug, PartialEq)]
pub struct ParseOptions {
    pub calendar_id: String,
    pub default_zone: Tz,
    pub default_duration: Duration,
    pub max_instances_per_series: usize,
    pub max_events: usize,
    pub include_cancelled: bool,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self {
            calendar_id: String::new(),
            default_zone: Tz::UTC,
            default_duration: Duration::minutes(30),
            max_instances_per_series: 1_000,
            max_events: 50_000,
            include_cancelled: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedZone {
    pub tzid: String,
    pub zone_name: String,
    pub how: ZoneResolution,
}

#[derive(Clone, Debug)]
pub struct ParsedCalendar {
    pub name: Option<String>,
    pub time_zone: Option<String>,
    pub warnings: usize,
    pub warning_messages: Vec<String>,
    pub zones: Vec<ResolvedZone>,
    pub(crate) events: Vec<RawEvent>,
    pub(crate) options: ParseOptions,
    pub(crate) budget: Budget,
}

impl ParsedCalendar {
    pub fn component_count(&self) -> usize {
        self.events.len()
    }

    fn warn(&mut self, message: impl Into<String>) {
        self.warnings += 1;
        if self.warning_messages.len() < 32 {
            self.warning_messages.push(message.into());
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Span {
    pub nominal_days: i64,
    pub exact: Duration,
}

impl Span {
    fn days(days: i64) -> Self {
        Self {
            nominal_days: days,
            exact: Duration::zero(),
        }
    }

    fn exact(exact: Duration) -> Self {
        Self {
            nominal_days: 0,
            exact,
        }
    }

    pub fn upper_bound(&self) -> Duration {
        Duration::try_days(self.nominal_days.saturating_add(1))
            .and_then(|d| d.checked_add(&self.exact))
            .unwrap_or(Duration::MAX)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Exclusion {
    Instant(DateTime<Utc>),
    Day(NaiveDate),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RawPerson {
    pub name: Option<String>,
    pub email: Option<String>,
    pub response: Response,
}

#[derive(Clone, Debug)]
pub(crate) struct RawEvent {
    pub uid: String,
    pub title: String,
    pub description: Option<String>,
    pub alt_description: Option<String>,
    pub location: Option<String>,
    pub url: Option<String>,
    pub status: EventStatus,
    pub free: bool,
    pub start_wall: NaiveDateTime,
    pub zone: Zone,
    pub all_day: bool,
    pub span: Span,
    pub organizer: Option<RawPerson>,
    pub attendees: Vec<RawPerson>,
    pub rule: Option<rule::Recurrence>,
    pub exdates: Vec<Exclusion>,
    pub rdates: Vec<DateTime<Utc>>,
    pub recurrence_id: Option<DateTime<Utc>>,
    pub conference: Vec<ConferenceEntry>,
}

impl RawEvent {
    pub fn start_utc(&self) -> DateTime<Utc> {
        self.zone.to_utc(self.start_wall)
    }

    pub fn end_for(&self, start_wall: NaiveDateTime, start_utc: DateTime<Utc>) -> DateTime<Utc> {
        let Span {
            nominal_days,
            exact,
        } = self.span;
        let nominal = if nominal_days == 0 {
            start_utc
        } else {
            Duration::try_days(nominal_days)
                .and_then(|d| start_wall.checked_add_signed(d))
                .map(|w| self.zone.to_utc(w))
                .unwrap_or(start_utc)
        };
        let end = nominal.checked_add_signed(exact).unwrap_or(nominal);
        if end > start_utc {
            end
        } else {
            Duration::try_days(nominal_days)
                .and_then(|d| d.checked_add(&exact))
                .and_then(|d| start_utc.checked_add_signed(d))
                .unwrap_or(start_utc)
                .max(start_utc)
        }
    }

    pub fn is_recurring(&self) -> bool {
        self.rule.is_some() || !self.rdates.is_empty() || self.recurrence_id.is_some()
    }
}

struct ZoneContext {
    zones: HashMap<String, Zone>,
    looked_up: HashMap<String, Option<Zone>>,
    floating: Zone,
}

impl ZoneContext {
    fn zone_for(&mut self, tzid: &str, cal: &mut ParsedCalendar) -> Zone {
        if let Some(zone) = self.zones.get(tzid) {
            return *zone;
        }
        let found = match self.looked_up.get(tzid) {
            Some(found) => *found,
            None => {
                let found = resolve_tzid(tzid);
                self.looked_up.insert(tzid.to_string(), found);
                found
            }
        };
        if let Some(zone) = found {
            return zone;
        }
        cal.warn(format!("unknown TZID {tzid}, using the default zone"));
        self.floating
    }

    fn wall_and_zone(&mut self, time: &IcsTime, cal: &mut ParsedCalendar) -> (NaiveDateTime, Zone) {
        match time {
            IcsTime::Date(d) => (d.and_time(NaiveTime::MIN), Zone::Utc),
            IcsTime::Utc(n) => (*n, Zone::Utc),
            IcsTime::Floating(n) => (*n, self.floating),
            IcsTime::Zoned(n, tzid) => (*n, self.zone_for(tzid, cal)),
        }
    }

    fn instant(&mut self, time: &IcsTime, cal: &mut ParsedCalendar) -> DateTime<Utc> {
        let (wall, zone) = self.wall_and_zone(time, cal);
        zone.to_utc(wall)
    }
}

pub fn parse_calendar(text: &str, opts: &ParseOptions) -> ParsedCalendar {
    let lexed = lex(text);
    let mut cal = ParsedCalendar {
        name: None,
        time_zone: None,
        warnings: 0,
        warning_messages: Vec::new(),
        zones: Vec::new(),
        events: Vec::new(),
        options: opts.clone(),
        budget: Budget::new(FEED_BUDGET),
    };
    for w in lexed.warnings {
        cal.warn(w);
    }
    let calendars: Vec<&Component> = if lexed.root.children.iter().any(|c| c.name == "VCALENDAR") {
        lexed
            .root
            .children
            .iter()
            .filter(|c| c.name == "VCALENDAR")
            .collect()
    } else {
        if !lexed.root.children.is_empty() {
            cal.warn("no VCALENDAR wrapper");
        }
        vec![&lexed.root]
    };
    for vcal in calendars {
        parse_vcalendar(vcal, &mut cal);
    }
    cal
}

pub fn parse_calendar_bytes(bytes: &[u8], opts: &ParseOptions) -> ParsedCalendar {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let mut joined = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let fold = match (bytes[i], bytes.get(i + 1), bytes.get(i + 2)) {
            (b'\r', Some(b'\n'), Some(b' ' | b'\t')) => 3,
            (b'\n', Some(b' ' | b'\t'), _) => 2,
            _ => 0,
        };
        if fold > 0 {
            i += fold;
            continue;
        }
        joined.push(bytes[i]);
        i += 1;
    }
    parse_calendar(&String::from_utf8_lossy(&joined), opts)
}

fn parse_vcalendar(vcal: &Component, cal: &mut ParsedCalendar) {
    if cal.name.is_none() {
        cal.name = vcal
            .text("X-WR-CALNAME")
            .or_else(|| vcal.text("NAME"))
            .and_then(|n| non_empty(Some(&n)));
    }
    let wr_tz = vcal
        .prop("X-WR-TIMEZONE")
        .map(|p| p.value.trim().to_string());
    if cal.time_zone.is_none() {
        cal.time_zone = wr_tz.clone().filter(|t| !t.is_empty());
    }
    let default_zone = Zone::Named(cal.options.default_zone);
    let floating = match wr_tz.as_deref().filter(|t| !t.is_empty()) {
        Some(tz) => resolve_tzid(tz).unwrap_or_else(|| {
            cal.warn(format!("unknown X-WR-TIMEZONE {tz}"));
            default_zone
        }),
        None => default_zone,
    };
    let mut ctx = ZoneContext {
        zones: HashMap::new(),
        looked_up: HashMap::new(),
        floating,
    };
    let mut seen_tzids: HashSet<String> = HashSet::new();
    for (index, comp) in vcal
        .children
        .iter()
        .filter(|c| c.name == "VTIMEZONE")
        .enumerate()
    {
        if index >= MAX_VTIMEZONES {
            cal.warn("too many VTIMEZONE blocks, ignoring the rest");
            break;
        }
        let tzid = comp
            .prop("TZID")
            .map(|p| p.value.trim().to_string())
            .unwrap_or_default();
        if !tzid.is_empty() && !seen_tzids.insert(tzid.clone()) {
            cal.warn(format!("duplicate VTIMEZONE {tzid}"));
            continue;
        }
        match vtimezone::resolve_vtimezone(comp, &mut cal.budget) {
            Some((tzid, zone, how)) => {
                let zone_name = match zone {
                    Zone::Utc => "UTC".to_string(),
                    Zone::Named(tz) => tz.name().to_string(),
                    Zone::Fixed(offset) => offset.to_string(),
                };
                cal.zones.push(ResolvedZone {
                    tzid: tzid.clone(),
                    zone_name,
                    how,
                });
                ctx.zones.insert(tzid, zone);
            }
            None => cal.warn("VTIMEZONE without usable TZID or offsets"),
        }
    }
    for comp in vcal.children.iter().filter(|c| c.name == "VEVENT") {
        if cal.events.len() >= cal.options.max_events {
            cal.warn("event limit reached, ignoring the rest of the feed");
            break;
        }
        match parse_event(comp, &mut ctx, cal) {
            Ok(event) => cal.events.push(event),
            Err(message) => cal.warn(message),
        }
    }
}

fn first_time(prop: &Property) -> Option<IcsTime> {
    parse_property(prop).into_iter().next()
}

fn parse_person(prop: &Property) -> RawPerson {
    let value = prop.value.trim();
    let email = prop
        .param("EMAIL")
        .map(str::to_string)
        .or_else(|| {
            let lower = value.to_ascii_lowercase();
            lower
                .starts_with("mailto:")
                .then(|| value["mailto:".len()..].to_string())
                .or_else(|| {
                    (value.contains('@') && !value.contains(':')).then(|| value.to_string())
                })
        })
        .map(|e| e.trim().to_string())
        .filter(|e| e.contains('@'));
    RawPerson {
        name: non_empty(prop.param("CN")),
        email,
        response: prop
            .param("PARTSTAT")
            .map_or(Response::Unknown, response_from_partstat),
    }
}

fn is_resource(prop: &Property) -> bool {
    prop.param("CUTYPE")
        .is_some_and(|c| c.eq_ignore_ascii_case("ROOM") || c.eq_ignore_ascii_case("RESOURCE"))
        || prop
            .param("ROLE")
            .is_some_and(|r| r.eq_ignore_ascii_case("NON-PARTICIPANT"))
}

fn conference_entries(comp: &Component) -> Vec<ConferenceEntry> {
    let mut out = Vec::new();
    for name in [
        "X-GOOGLE-CONFERENCE",
        "X-MICROSOFT-SKYPETEAMSMEETINGURL",
        "X-MICROSOFT-ONLINEMEETINGEXTERNALLINK",
        "X-MICROSOFT-ONLINEMEETINGCONFLINK",
        "CONFERENCE",
    ] {
        for prop in comp.props_named(name) {
            let uri = unescape_text(prop.value.trim());
            let lower = uri.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                continue;
            }
            let is_video = name != "CONFERENCE"
                || prop
                    .param("FEATURE")
                    .is_none_or(|f| f.to_ascii_uppercase().contains("VIDEO"));
            out.push(ConferenceEntry {
                kind: if is_video {
                    ConferenceKind::Video
                } else {
                    ConferenceKind::Other
                },
                uri,
                meeting_code: None,
            });
        }
    }
    out
}

fn parse_event(
    comp: &Component,
    ctx: &mut ZoneContext,
    cal: &mut ParsedCalendar,
) -> Result<RawEvent, String> {
    let start_time = comp
        .prop("DTSTART")
        .and_then(first_time)
        .ok_or_else(|| "VEVENT without a valid DTSTART".to_string())?;
    let alldayish = comp
        .prop("X-MICROSOFT-CDO-ALLDAYEVENT")
        .is_some_and(|p| p.value.trim().eq_ignore_ascii_case("TRUE"));
    let start_time = match start_time {
        IcsTime::Floating(n) | IcsTime::Zoned(n, _) if alldayish && n.time() == NaiveTime::MIN => {
            IcsTime::Date(n.date())
        }
        other => other,
    };
    let all_day = matches!(start_time, IcsTime::Date(_));
    let (start_wall, zone) = ctx.wall_and_zone(&start_time, cal);
    let start_utc = zone.to_utc(start_wall);
    let default_span = if all_day {
        Span::days(1)
    } else {
        Span::exact(cal.options.default_duration)
    };
    let span = if let Some(end_time) = comp.prop("DTEND").and_then(first_time) {
        let (end_wall, end_zone) = ctx.wall_and_zone(&end_time, cal);
        if all_day {
            let days = end_wall
                .date()
                .signed_duration_since(start_wall.date())
                .num_days();
            if days > 0 {
                Span::days(days)
            } else {
                default_span
            }
        } else {
            let mut exact = end_zone.to_utc(end_wall).signed_duration_since(start_utc);
            if exact <= Duration::zero() && end_zone == zone {
                exact = end_wall.signed_duration_since(start_wall);
            }
            if exact > Duration::zero() {
                Span::exact(exact)
            } else {
                default_span
            }
        }
    } else if let Some((days, seconds)) = comp
        .prop("DURATION")
        .and_then(|p| parse_duration_parts(&p.value))
    {
        if days.saturating_mul(86_400).saturating_add(seconds) <= 0 {
            default_span
        } else if all_day {
            Span::days(days.saturating_add(seconds / 86_400).max(1))
        } else {
            Span {
                nominal_days: days,
                exact: Duration::seconds(seconds),
            }
        }
    } else {
        default_span
    };

    let title = comp
        .text("SUMMARY")
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let uid = comp
        .text("UID")
        .map(|u| u.trim().to_string())
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| synthetic_uid(&title, start_utc));

    let status = match comp
        .prop("STATUS")
        .map(|p| p.value.trim().to_ascii_uppercase())
        .as_deref()
    {
        Some("CANCELLED") => EventStatus::Cancelled,
        Some("TENTATIVE") => EventStatus::Tentative,
        _ => EventStatus::Confirmed,
    };
    let free = comp
        .prop("TRANSP")
        .is_some_and(|p| p.value.trim().eq_ignore_ascii_case("TRANSPARENT"))
        || comp
            .prop("X-MICROSOFT-CDO-BUSYSTATUS")
            .is_some_and(|p| p.value.trim().eq_ignore_ascii_case("FREE"));

    let rule = match comp.prop("RRULE") {
        Some(prop) => match rule::build_rule(&prop.value, start_wall, zone) {
            Ok(rule) => Some(rule),
            Err(e) => {
                cal.warn(format!("{uid}: ignoring RRULE ({e})"));
                None
            }
        },
        None => None,
    };

    let mut exdates = Vec::new();
    for time in comp.props_named("EXDATE").flat_map(parse_property) {
        match time {
            IcsTime::Date(d) => exdates.push(Exclusion::Day(d)),
            other => exdates.push(Exclusion::Instant(ctx.instant(&other, cal))),
        }
    }
    let mut rdates = Vec::new();
    for time in comp.props_named("RDATE").flat_map(parse_property) {
        let instant = match time {
            IcsTime::Date(d) if !all_day => zone.to_utc(d.and_time(start_wall.time())),
            other => ctx.instant(&other, cal),
        };
        rdates.push(instant);
    }
    let recurrence_id = comp
        .prop("RECURRENCE-ID")
        .and_then(first_time)
        .map(|t| match t {
            IcsTime::Date(d) if !all_day => zone.to_utc(d.and_time(start_wall.time())),
            other => ctx.instant(&other, cal),
        });

    let organizer = comp.prop("ORGANIZER").map(parse_person);
    let attendees = comp
        .props_named("ATTENDEE")
        .filter(|p| !is_resource(p))
        .map(parse_person)
        .collect();

    Ok(RawEvent {
        uid,
        title,
        description: comp.text("DESCRIPTION").and_then(|d| non_empty(Some(&d))),
        alt_description: comp.prop("X-ALT-DESC").map(|p| unescape_text(&p.value)),
        location: comp.text("LOCATION").and_then(|l| non_empty(Some(&l))),
        url: comp.text("URL").and_then(|u| non_empty(Some(&u))),
        status,
        free,
        start_wall,
        zone,
        all_day,
        span,
        organizer,
        attendees,
        rule,
        exdates,
        rdates,
        recurrence_id,
        conference: conference_entries(comp),
    })
}

fn synthetic_uid(title: &str, start: DateTime<Utc>) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in title.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("generated-{hash:016x}-{}", start.timestamp())
}
