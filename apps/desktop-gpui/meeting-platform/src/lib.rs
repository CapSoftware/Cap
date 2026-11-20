pub mod resample;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(target_os = "macos")]
pub use macos::system_tap::{SystemAudioTap, TapChunk, TapError, TapStats, system_tap_supported};
#[cfg(target_os = "macos")]
pub use macos::tcc::{
    AudioCapturePermission, audio_capture_permission, request_audio_capture_permission,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserProbe {
    pub urls: Vec<String>,
    pub titles: Vec<String>,
    pub complete: bool,
    pub trusted: bool,
}

#[cfg(target_os = "macos")]
pub use macos::browser_probe::{accessibility_trusted, probe_browser};

/// Only macOS puts reading other apps behind a permission; elsewhere there is
/// nothing to grant, so no hint asks for one.
#[cfg(not(target_os = "macos"))]
pub fn accessibility_trusted() -> bool {
    true
}

#[cfg(not(target_os = "macos"))]
pub fn probe_browser(_pid: u32) -> BrowserProbe {
    BrowserProbe::default()
}

/// What a meeting app's windows say about who is speaking: raw labels that
/// mention speaking or mark the user's own tile. Empty where the platform
/// cannot read other apps' interfaces (or Cap is not allowed to).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeakerLabels {
    pub labels: Vec<String>,
    pub trusted: bool,
    pub complete: bool,
    pub visited: usize,
    pub took: std::time::Duration,
}

#[cfg(target_os = "macos")]
pub use macos::speaker_labels::speaker_labels;

/// Windows (UI Automation) and Linux read nothing yet; the meeting still gets
/// names from what was said and the calendar.
#[cfg(not(target_os = "macos"))]
pub fn speaker_labels(_pid: u32, _browser: bool, _pages: &'static [&'static str]) -> SpeakerLabels {
    SpeakerLabels::default()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalendarAccess {
    Granted,
    Denied,
    NotDetermined,
    Unsupported,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttendeeStatus {
    Accepted,
    Declined,
    Tentative,
    Pending,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemAttendee {
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_self: bool,
    pub status: AttendeeStatus,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemCalendar {
    pub id: String,
    pub title: String,
    pub subscribed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemCalendarEvent {
    pub id: String,
    pub recurring: bool,
    pub calendar_id: String,
    pub calendar_title: String,
    pub title: String,
    pub start_unix_ms: i64,
    pub end_unix_ms: i64,
    pub all_day: bool,
    pub location: Option<String>,
    pub notes: Option<String>,
    pub url: Option<String>,
    pub organizer: Option<SystemAttendee>,
    pub attendees: Vec<SystemAttendee>,
    pub cancelled: bool,
}

#[cfg(target_os = "macos")]
pub use macos::system_calendar::{
    calendar_access, request_calendar_access, system_calendars, system_events,
};

pub struct CalendarWatcher {
    #[cfg(target_os = "macos")]
    _inner: macos::system_calendar::StoreWatcher,
}

impl CalendarWatcher {
    #[cfg(target_os = "macos")]
    pub fn spawn(changes: flume::Sender<()>) -> Option<Self> {
        Some(Self {
            _inner: macos::system_calendar::StoreWatcher::spawn(changes),
        })
    }

    #[cfg(not(target_os = "macos"))]
    pub fn spawn(_changes: flume::Sender<()>) -> Option<Self> {
        None
    }
}

#[cfg(not(target_os = "macos"))]
pub fn calendar_access() -> CalendarAccess {
    CalendarAccess::Unsupported
}

#[cfg(not(target_os = "macos"))]
pub fn request_calendar_access(done: impl FnOnce(bool) + Send + 'static) {
    done(false);
}

#[cfg(not(target_os = "macos"))]
pub fn system_calendars() -> Result<Vec<SystemCalendar>, CalendarAccess> {
    Err(CalendarAccess::Unsupported)
}

#[cfg(not(target_os = "macos"))]
pub fn system_events(
    _start_unix_ms: i64,
    _end_unix_ms: i64,
) -> Result<Vec<SystemCalendarEvent>, CalendarAccess> {
    Err(CalendarAccess::Unsupported)
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct MicClient {
    pub id: String,
    pub raw_id: String,
    pub pid: u32,
    pub device_uid: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MicSnapshot {
    pub clients: Vec<MicClient>,
    pub mic_in_use: bool,
    pub attributed: bool,
    pub default_input: Option<String>,
    pub input_devices: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("microphone activity cannot be observed on this system: {0}")]
    Unsupported(String),
    #[error("failed to start the microphone activity watcher: {0}")]
    Start(String),
}

pub struct MicWatcher {
    _inner: platform::mic_clients::Watcher,
}

impl MicWatcher {
    pub fn spawn(updates: flume::Sender<MicSnapshot>) -> Result<Self, WatchError> {
        platform::mic_clients::Watcher::spawn(updates).map(|inner| Self { _inner: inner })
    }
}

pub fn snapshot_now() -> MicSnapshot {
    platform::mic_clients::snapshot_now()
}
