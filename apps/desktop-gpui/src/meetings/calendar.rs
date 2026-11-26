use std::{collections::BTreeMap, fs, path::PathBuf, time::Duration};

use cap_calendar::{
    Agenda, CalendarEvent, EventStatus, Filter, Response, Tz,
    agenda::dedupe,
    ics::{ParseOptions, expand, parse_calendar_bytes},
    system::{SystemAttendee, SystemEvent, from_system_event},
};
use cap_meeting_platform::{AttendeeStatus, CalendarAccess, SystemCalendar, SystemCalendarEvent};
use cap_meetings::{
    library::{Attendee, EventSnapshot},
    prompt::EventInfo,
    settings::CalendarSettings,
};
use chrono::{DateTime, TimeZone, Utc};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use super::{
    accounts,
    persist::{self, CALENDAR_CACHE_FILE, CALENDARS_FILE},
};

pub const REFRESH_EVERY: Duration = Duration::from_secs(600);
const MAX_FEED_BYTES: usize = 20 * 1024 * 1024;
const WINDOW_BEFORE: chrono::Duration = chrono::Duration::days(1);
const WINDOW_AFTER: chrono::Duration = chrono::Duration::days(14);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SourceConfig {
    Ics {
        url: String,
    },
    System,
    Account {
        provider: accounts::Provider,
        #[serde(default)]
        email: String,
    },
}

impl SourceConfig {
    pub fn kind(&self) -> cap_calendar::SourceKind {
        match self {
            SourceConfig::Ics { .. } => cap_calendar::SourceKind::Ics,
            SourceConfig::System => cap_calendar::SourceKind::System,
            SourceConfig::Account {
                provider: accounts::Provider::Google,
                ..
            } => cap_calendar::SourceKind::Google,
            SourceConfig::Account {
                provider: accounts::Provider::Microsoft,
                ..
            } => cap_calendar::SourceKind::Microsoft,
        }
    }
}

pub const SYSTEM_SOURCE_ID: &str = "system";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncErrorKind {
    Offline,
    Rejected,
    Server,
    NotCalendar,
    TooLarge,
    AccessDenied,
    Unsupported,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyncError {
    pub kind: SyncErrorKind,
    pub detail: String,
}

impl SyncError {
    fn new(kind: SyncErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubCalendar {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub subscribed: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SourceStatus {
    pub last_sync: Option<DateTime<Utc>>,
    pub last_attempt: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub event_count: usize,
    pub error_kind: Option<SyncErrorKind>,
    pub calendars: Vec<SubCalendar>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSource {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub config: SourceConfig,
    #[serde(default)]
    pub status: SourceStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CalendarError {
    InvalidUrl(String),
    Duplicate,
    NotFound,
}

impl std::error::Error for CalendarError {}

impl std::fmt::Display for CalendarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CalendarError::InvalidUrl(reason) => {
                write!(f, "That calendar link is not valid: {reason}")
            }
            CalendarError::Duplicate => f.write_str("That calendar is already added"),
            CalendarError::NotFound => f.write_str("That calendar is not connected"),
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SourcesFile {
    sources: Vec<CalendarSource>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct CacheFile {
    sources: BTreeMap<String, Vec<CalendarEvent>>,
}

pub fn normalize_feed_url(input: &str) -> Result<String, CalendarError> {
    let trimmed = input.trim();
    let lower = trimmed.to_ascii_lowercase();
    let mut rewritten = trimmed.to_string();
    for scheme in ["webcals://", "webcal://"] {
        if lower.starts_with(scheme) {
            rewritten = format!("https://{}", &trimmed[scheme.len()..]);
            break;
        }
    }
    let mut url =
        reqwest::Url::parse(&rewritten).map_err(|e| CalendarError::InvalidUrl(e.to_string()))?;
    // A feed over plain http could be rewritten on the way, planting fake
    // events and join links, so it is fetched over https. Only a feed on this
    // machine stays on http.
    if url.scheme() == "http" && !is_loopback_host(&url) {
        url.set_scheme("https")
            .map_err(|()| CalendarError::InvalidUrl("the link can't use https".into()))?;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CalendarError::InvalidUrl(
            "only http, https and webcal links are supported".into(),
        ));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(CalendarError::InvalidUrl("the link has no host".into()));
    }
    Ok(url.to_string())
}

fn is_loopback_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

pub fn event_key(event: &CalendarEvent) -> String {
    format!("{}|{}", event.calendar_id, event.id)
}

pub const AUTO_LINK_LEAD_SECS: i64 = 10 * 60;

/// The calendar meeting a note started without a chosen event belongs to:
/// one in progress, or one starting within ten minutes. When several fit,
/// the one whose start is closest to now wins.
pub fn auto_link<'a>(events: &'a [CalendarEvent], now: DateTime<Utc>) -> Option<&'a CalendarEvent> {
    events
        .iter()
        .filter(|e| !e.all_day)
        .filter(|e| {
            let starts_in = (e.start - now).num_seconds();
            (e.start <= now && now < e.end) || (0..=AUTO_LINK_LEAD_SECS).contains(&starts_in)
        })
        .min_by_key(|e| ((e.start - now).num_seconds().abs(), e.start))
}

pub fn filter_for(settings: &CalendarSettings) -> Filter {
    Filter {
        hide_declined: settings.hide_declined,
        hide_all_day: settings.hide_all_day,
        hide_without_participants: settings.hide_without_participants,
        hidden_calendar_ids: settings.hidden_calendar_ids.iter().cloned().collect(),
    }
}

pub fn event_info(event: &CalendarEvent) -> EventInfo {
    EventInfo {
        id: event_key(event),
        title: event.title.clone(),
        start: event.start,
        end: event.end,
        has_link: event.link.is_some(),
        link_provider_name: event
            .link
            .as_ref()
            .map(|l| l.provider.display_name().to_string()),
        attendee_count: event.other_participants() as u32,
    }
}

pub fn snapshot(event: &CalendarEvent, calendar_name: Option<String>) -> EventSnapshot {
    EventSnapshot {
        id: event_key(event),
        title: event.title.clone(),
        start: Some(event.start),
        end: Some(event.end),
        link: event.link.as_ref().map(|l| l.url.clone()),
        attendees: event
            .attendees
            .iter()
            .map(|p| Attendee {
                name: p.name.clone(),
                email: p.email.clone(),
                is_self: p.is_self,
            })
            .collect(),
        calendar_name,
    }
}

pub fn participants(event: &CalendarEvent) -> Vec<String> {
    let mut names: Vec<String> = event
        .attendees
        .iter()
        .filter(|p| !p.is_self)
        .filter_map(|p| p.display_name().map(str::to_string))
        .collect();
    if names.is_empty()
        && let Some(organizer) = event.organizer.as_ref().filter(|o| !o.is_self)
        && let Some(name) = organizer.display_name()
    {
        names.push(name.to_string());
    }
    names
}

pub fn local_zone() -> Tz {
    iana_time_zone::get_timezone()
        .ok()
        .and_then(|name| name.parse::<Tz>().ok())
        .unwrap_or(Tz::UTC)
}

#[derive(Debug, Default)]
pub struct CalendarState {
    pub sources: Vec<CalendarSource>,
    per_source: BTreeMap<String, Vec<CalendarEvent>>,
    merged: Vec<CalendarEvent>,
    loaded: bool,
    dir: Option<PathBuf>,
}

impl CalendarState {
    #[cfg(test)]
    pub fn in_dir(dir: PathBuf) -> Self {
        Self {
            dir: Some(dir),
            ..Self::default()
        }
    }

    fn dir(&self) -> PathBuf {
        self.dir.clone().unwrap_or_else(persist::meetings_dir)
    }

    pub fn ensure_loaded(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        let dir = self.dir();
        if let Some(file) = persist::read_store::<SourcesFile>(&dir.join(CALENDARS_FILE)) {
            self.sources = file.sources;
        }
        if let Ok(bytes) = fs::read(dir.join(CALENDAR_CACHE_FILE))
            && let Ok(cache) = serde_json::from_slice::<CacheFile>(&bytes)
        {
            self.per_source = cache.sources;
        }
        self.per_source
            .retain(|id, _| self.sources.iter().any(|s| &s.id == id));
        self.merge();
    }

    pub fn events(&self) -> &[CalendarEvent] {
        &self.merged
    }

    /// The meeting behind `key`. Keys come from the agenda, where a hidden
    /// calendar's copy is dropped before merging, so a key can name a copy
    /// that lost the merge: those are found among the sources' own copies.
    pub fn find(&self, key: &str) -> Option<&CalendarEvent> {
        self.merged
            .iter()
            .find(|e| event_key(e) == key)
            .or_else(|| {
                self.per_source
                    .values()
                    .flatten()
                    .find(|e| event_key(e) == key)
            })
    }

    pub fn source_name(&self, calendar_id: &str) -> Option<String> {
        self.sources
            .iter()
            .find(|s| s.id == calendar_id)
            .map(|s| s.name.clone())
            .or_else(|| {
                self.sources
                    .iter()
                    .flat_map(|s| &s.status.calendars)
                    .find(|c| c.id == calendar_id)
                    .map(|c| c.title.clone())
            })
            .filter(|n| !n.is_empty())
    }

    pub fn has_system(&self) -> bool {
        self.sources
            .iter()
            .any(|s| matches!(s.config, SourceConfig::System))
    }

    pub fn upcoming_count(&self, id: &str, filter: &Filter, now: DateTime<Utc>) -> usize {
        self.per_source.get(id).map_or(0, |events| {
            events
                .iter()
                .filter(|e| e.end > now && filter.allows(e))
                .count()
        })
    }

    pub fn agenda(&self, filter: &Filter) -> Agenda {
        Agenda::new(
            self.per_source.values().flatten().cloned().collect(),
            filter,
        )
    }

    pub fn planner_events(&self, settings: &CalendarSettings) -> Vec<EventInfo> {
        self.agenda(&filter_for(settings))
            .events()
            .iter()
            .filter(|e| !e.all_day)
            .map(event_info)
            .collect()
    }

    pub fn add_ics(&mut self, url: &str, name: Option<String>) -> Result<String, CalendarError> {
        let url = normalize_feed_url(url)?;
        if self
            .sources
            .iter()
            .any(|s| matches!(&s.config, SourceConfig::Ics { url: u } if *u == url))
        {
            return Err(CalendarError::Duplicate);
        }
        let id = format!("ics-{:x}", persist::entropy() & 0xffff_ffff_ffff);
        self.sources.push(CalendarSource {
            id: id.clone(),
            name: name.map(|n| n.trim().to_string()).unwrap_or_default(),
            config: SourceConfig::Ics { url },
            status: SourceStatus::default(),
        });
        self.save_sources();
        Ok(id)
    }

    pub fn add_system(&mut self) -> Result<String, CalendarError> {
        if self.has_system() {
            return Err(CalendarError::Duplicate);
        }
        self.sources.push(CalendarSource {
            id: SYSTEM_SOURCE_ID.to_string(),
            name: String::new(),
            config: SourceConfig::System,
            status: SourceStatus::default(),
        });
        self.save_sources();
        Ok(SYSTEM_SOURCE_ID.to_string())
    }

    pub fn add_account(
        &mut self,
        provider: accounts::Provider,
        email: &str,
        refresh_token: &str,
    ) -> std::io::Result<String> {
        let email = email.trim().to_ascii_lowercase();
        let existing = self.sources.iter().find(|s| {
            matches!(&s.config, SourceConfig::Account { provider: p, email: e }
                if *p == provider && *e == email)
        });
        let id = match existing {
            Some(source) => source.id.clone(),
            None => format!("account-{:x}", persist::entropy() & 0xffff_ffff_ffff),
        };
        accounts::store_refresh_token(&self.dir(), &id, refresh_token)?;
        match self.sources.iter_mut().find(|s| s.id == id) {
            Some(source) => {
                source.status.error = None;
                source.status.error_kind = None;
            }
            None => self.sources.push(CalendarSource {
                id: id.clone(),
                name: email.clone(),
                config: SourceConfig::Account { provider, email },
                status: SourceStatus::default(),
            }),
        }
        self.save_sources();
        Ok(id)
    }

    pub fn remove(&mut self, id: &str) -> Result<(), CalendarError> {
        let before = self.sources.len();
        self.sources.retain(|s| s.id != id);
        if self.sources.len() == before {
            return Err(CalendarError::NotFound);
        }
        accounts::forget(&self.dir(), id);
        self.per_source.remove(id);
        let _ = fs::remove_file(raw_path(&self.dir(), id));
        self.merge();
        self.save_sources();
        self.save_cache();
        Ok(())
    }

    pub fn apply(&mut self, results: Vec<RefreshResult>) {
        for result in results {
            let Some(source) = self.sources.iter_mut().find(|s| s.id == result.id) else {
                continue;
            };
            source.status.last_attempt = Some(result.at);
            match result.outcome {
                Ok(fetched) => {
                    source.status.error = None;
                    source.status.error_kind = None;
                    source.status.last_sync = Some(result.at);
                    if let Some(calendars) = fetched.calendars {
                        source.status.calendars = calendars;
                    }
                    if fetched.etag.is_some() || fetched.last_modified.is_some() {
                        source.status.etag = fetched.etag;
                        source.status.last_modified = fetched.last_modified;
                    }
                    if source.name.is_empty()
                        && let Some(name) = fetched.name
                    {
                        source.name = name;
                    }
                    let mut events = fetched.events;
                    if !fetched.unread_calendars.is_empty()
                        && let Some(previous) = self.per_source.get(&result.id)
                    {
                        events.extend(
                            previous
                                .iter()
                                .filter(|event| {
                                    fetched.unread_calendars.contains(&event.calendar_id)
                                })
                                .cloned(),
                        );
                    }
                    source.status.event_count = events.len();
                    self.per_source.insert(result.id, events);
                }
                Err(error) => {
                    source.status.error = Some(error.detail);
                    source.status.error_kind = Some(error.kind);
                }
            }
        }
        self.merge();
        self.save_sources();
        self.save_cache();
    }

    fn merge(&mut self) {
        self.merged = dedupe(self.per_source.values().flatten().cloned().collect());
    }

    fn save_sources(&self) {
        let file = SourcesFile {
            sources: self.sources.clone(),
        };
        if let Ok(bytes) = serde_json::to_vec_pretty(&file)
            && let Err(error) =
                persist::atomic_write_private(&self.dir().join(CALENDARS_FILE), &bytes)
        {
            tracing::warn!(%error, "could not save calendar sources");
        }
    }

    fn save_cache(&self) {
        let file = CacheFile {
            sources: self.per_source.clone(),
        };
        if let Ok(bytes) = serde_json::to_vec(&file)
            && let Err(error) = persist::atomic_write(&self.dir().join(CALENDAR_CACHE_FILE), &bytes)
        {
            tracing::warn!(%error, "could not save the calendar cache");
        }
    }
}

fn raw_path(dir: &std::path::Path, id: &str) -> PathBuf {
    dir.join("calendar")
        .join(format!("{}.ics", sanitize_filename::sanitize(id)))
}

#[derive(Default)]
pub struct Fetched {
    pub events: Vec<CalendarEvent>,
    pub name: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub calendars: Option<Vec<SubCalendar>>,
    /// Calendars of the source that failed this time: their last events
    /// are kept instead of dropped.
    pub unread_calendars: Vec<String>,
}

pub struct RefreshResult {
    pub id: String,
    pub at: DateTime<Utc>,
    pub outcome: Result<Fetched, SyncError>,
}

pub async fn refresh(sources: Vec<CalendarSource>) -> Vec<RefreshResult> {
    refresh_in(persist::meetings_dir(), sources).await
}

pub async fn refresh_in(dir: PathBuf, sources: Vec<CalendarSource>) -> Vec<RefreshResult> {
    let mut results = Vec::with_capacity(sources.len());
    for source in sources {
        let at = Utc::now();
        let outcome = match &source.config {
            SourceConfig::Ics { url } => refresh_ics(&dir, &source, url).await,
            SourceConfig::Account { provider, email } => {
                refresh_account(&dir, &source.id, *provider, email).await
            }
            SourceConfig::System => {
                tokio::task::spawn_blocking(|| system_fetch(Utc::now(), read_system_store))
                    .await
                    .map_err(|e| SyncError::new(SyncErrorKind::Other, e.to_string()))
                    .and_then(|outcome| outcome)
            }
        };
        results.push(RefreshResult {
            id: source.id.clone(),
            at,
            outcome,
        });
    }
    results
}

async fn refresh_account(
    dir: &std::path::Path,
    id: &str,
    provider: accounts::Provider,
    email: &str,
) -> Result<Fetched, SyncError> {
    let now = Utc::now();
    let window = (now - WINDOW_BEFORE)..(now + WINDOW_AFTER);
    let fetched = accounts::fetch(dir, id, provider, email, window)
        .await
        .map_err(|error| match error {
            accounts::FetchError::SignInAgain => SyncError::new(
                SyncErrorKind::AccessDenied,
                "Sign in to this calendar again",
            ),
            accounts::FetchError::NotConfigured => SyncError::new(
                SyncErrorKind::Unsupported,
                "This calendar provider is not available in this build",
            ),
            accounts::FetchError::Offline => SyncError::new(
                SyncErrorKind::Offline,
                "The calendar service is unreachable",
            ),
            accounts::FetchError::RateLimited => SyncError::new(
                SyncErrorKind::Server,
                "The calendar service asked Cap to slow down",
            ),
            accounts::FetchError::Forbidden(detail) | accounts::FetchError::Server(detail) => {
                SyncError::new(SyncErrorKind::Server, detail)
            }
        })?;
    Ok(Fetched {
        events: fetched.events,
        calendars: Some(
            fetched
                .calendars
                .into_iter()
                .map(|(calendar, subscribed)| SubCalendar {
                    id: calendar.id,
                    title: calendar.name,
                    subscribed,
                })
                .collect(),
        ),
        unread_calendars: fetched.unread,
        ..Fetched::default()
    })
}

/// The most redirects a calendar feed may take before it is given up.
pub(crate) const MAX_FEED_REDIRECTS: usize = 5;

/// Whether a feed may follow a redirect to `next`, `hops` being the number of
/// redirects taken including this one. Every hop is held to https on a
/// public host: a feed may move, but never to plain http or to this machine
/// or its local network.
pub(crate) fn follow_feed_redirect(next: &reqwest::Url, hops: usize) -> Result<(), &'static str> {
    if hops > MAX_FEED_REDIRECTS {
        return Err("the calendar link redirected too many times");
    }
    if next.scheme() != "https" {
        return Err("the calendar link redirected away from https");
    }
    if !is_public_host(next) {
        return Err("the calendar link redirected to a local address");
    }
    Ok(())
}

fn is_public_host(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str().filter(|h| !h.is_empty()) else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => is_public_v4(ip),
        Ok(std::net::IpAddr::V6(ip)) => match ip.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => {
                !(ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_unique_local()
                    || ip.is_unicast_link_local())
            }
        },
        Err(_) => {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            name != "localhost" && !name.ends_with(".localhost")
        }
    }
}

fn is_public_v4(ip: std::net::Ipv4Addr) -> bool {
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.octets()[0] == 0)
}

fn feed_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        match follow_feed_redirect(attempt.url(), attempt.previous().len()) {
            Ok(()) => attempt.follow(),
            Err(reason) => attempt.error(reason),
        }
    })
}

fn request_error(error: reqwest::Error) -> SyncError {
    if error.is_redirect() {
        return SyncError::new(SyncErrorKind::NotCalendar, error.to_string());
    }
    let kind = if error.is_timeout() || error.is_connect() || error.is_request() {
        SyncErrorKind::Offline
    } else {
        SyncErrorKind::Other
    };
    SyncError::new(kind, error.to_string())
}

async fn refresh_ics(
    dir: &std::path::Path,
    source: &CalendarSource,
    url: &str,
) -> Result<Fetched, SyncError> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(45))
        .redirect(feed_redirect_policy())
        .build()
        .map_err(|e| SyncError::new(SyncErrorKind::Other, e.to_string()))?;
    let raw = raw_path(dir, &source.id);
    let have_raw = raw.is_file();
    let mut request = client
        .get(url)
        .header("Accept", "text/calendar, */*;q=0.5")
        .header("User-Agent", concat!("Cap/", env!("CARGO_PKG_VERSION")));
    if have_raw {
        if let Some(etag) = &source.status.etag {
            request = request.header("If-None-Match", etag);
        }
        if let Some(modified) = &source.status.last_modified {
            request = request.header("If-Modified-Since", modified);
        }
    }
    let response = request.send().await.map_err(request_error)?;
    let status = response.status();
    let header = |name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let etag = header("etag");
    let last_modified = header("last-modified");
    let cached = status == reqwest::StatusCode::NOT_MODIFIED && have_raw;
    let bytes = if cached {
        fs::read(&raw).map_err(|e| SyncError::new(SyncErrorKind::Other, e.to_string()))?
    } else if status.is_success() {
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(request_error)?;
            if body.len() + chunk.len() > MAX_FEED_BYTES {
                return Err(SyncError::new(
                    SyncErrorKind::TooLarge,
                    "The calendar feed is too large",
                ));
            }
            body.extend_from_slice(&chunk);
        }
        body
    } else {
        let kind = match status.as_u16() {
            401 | 403 | 404 | 410 => SyncErrorKind::Rejected,
            _ => SyncErrorKind::Server,
        };
        return Err(SyncError::new(
            kind,
            format!("The calendar server answered {status}"),
        ));
    };
    let id = source.id.clone();
    let (parsed, bytes) = tokio::task::spawn_blocking(move || (parse(&id, &bytes), bytes))
        .await
        .map_err(|e| SyncError::new(SyncErrorKind::Other, e.to_string()))?;
    // Only a calendar is kept for the next "not modified": a web page or a
    // broken answer cached here would be read back until the feed changed.
    let (events, name) = match parsed {
        Ok(parsed) => {
            if !cached && let Err(error) = persist::atomic_write(&raw, &bytes) {
                tracing::warn!(%error, "could not cache the calendar feed");
            }
            parsed
        }
        Err(error) => {
            if cached {
                let _ = fs::remove_file(&raw);
            }
            return Err(SyncError::new(SyncErrorKind::NotCalendar, error));
        }
    };
    Ok(Fetched {
        events,
        name,
        etag,
        last_modified,
        calendars: None,
        unread_calendars: Vec::new(),
    })
}

pub type SystemRead = Result<(Vec<SystemCalendar>, Vec<SystemCalendarEvent>), CalendarAccess>;

pub fn read_system_store(start_unix_ms: i64, end_unix_ms: i64) -> SystemRead {
    let calendars = cap_meeting_platform::system_calendars()?;
    let events = cap_meeting_platform::system_events(start_unix_ms, end_unix_ms)?;
    Ok((calendars, events))
}

pub fn system_fetch(
    now: DateTime<Utc>,
    read: impl FnOnce(i64, i64) -> SystemRead,
) -> Result<Fetched, SyncError> {
    let start = (now - WINDOW_BEFORE).timestamp_millis();
    let end = (now + WINDOW_AFTER).timestamp_millis();
    let (calendars, events) = read(start, end).map_err(|access| match access {
        CalendarAccess::Unsupported => SyncError::new(
            SyncErrorKind::Unsupported,
            "System calendars are not available",
        ),
        CalendarAccess::Denied | CalendarAccess::NotDetermined | CalendarAccess::Granted => {
            SyncError::new(
                SyncErrorKind::AccessDenied,
                "Calendar access was not granted",
            )
        }
    })?;
    let zone = local_zone();
    let events = events
        .iter()
        .filter_map(map_system_event)
        .map(|event| from_system_event(&event, zone))
        .collect();
    Ok(Fetched {
        events,
        calendars: Some(
            calendars
                .into_iter()
                .map(|c| SubCalendar {
                    id: c.id,
                    title: c.title,
                    subscribed: c.subscribed,
                })
                .collect(),
        ),
        ..Fetched::default()
    })
}

fn response(status: AttendeeStatus) -> Response {
    match status {
        AttendeeStatus::Accepted => Response::Accepted,
        AttendeeStatus::Declined => Response::Declined,
        AttendeeStatus::Tentative => Response::Tentative,
        AttendeeStatus::Pending => Response::NeedsAction,
        AttendeeStatus::Unknown => Response::Unknown,
    }
}

fn system_attendee(person: &cap_meeting_platform::SystemAttendee) -> SystemAttendee {
    SystemAttendee {
        name: person.name.clone(),
        email: person.email.clone(),
        is_self: person.is_self,
        status: response(person.status),
    }
}

pub fn map_system_event(event: &SystemCalendarEvent) -> Option<SystemEvent> {
    let start = Utc.timestamp_millis_opt(event.start_unix_ms).single()?;
    let end = Utc.timestamp_millis_opt(event.end_unix_ms).single()?;
    Some(SystemEvent {
        event_id: event.id.clone(),
        calendar_id: event.calendar_id.clone(),
        calendar_title: Some(event.calendar_title.clone()).filter(|t| !t.trim().is_empty()),
        title: event.title.clone(),
        start,
        end,
        all_day: event.all_day,
        location: event.location.clone(),
        notes: event.notes.clone(),
        url: event.url.clone(),
        organizer: event.organizer.as_ref().map(system_attendee),
        attendees: event.attendees.iter().map(system_attendee).collect(),
        is_recurring: event.recurring,
        status: if event.cancelled {
            EventStatus::Cancelled
        } else {
            EventStatus::Confirmed
        },
        free: false,
    })
}

pub fn parse(id: &str, bytes: &[u8]) -> Result<(Vec<CalendarEvent>, Option<String>), String> {
    let options = ParseOptions {
        calendar_id: id.to_string(),
        default_zone: local_zone(),
        ..ParseOptions::default()
    };
    let parsed = parse_calendar_bytes(bytes, &options);
    if parsed.component_count() == 0 && !String::from_utf8_lossy(bytes).contains("BEGIN:VCALENDAR")
    {
        return Err("That link did not return a calendar".into());
    }
    let now = Utc::now();
    let events = expand(&parsed, (now - WINDOW_BEFORE)..(now + WINDOW_AFTER), &[]);
    Ok((events, parsed.name.clone()))
}

#[cfg(test)]
mod tests;
