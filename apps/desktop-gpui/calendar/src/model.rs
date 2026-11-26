use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::link::MeetingLink;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceKind {
    #[default]
    Ics,
    Google,
    Microsoft,
    System,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Response {
    Accepted,
    Declined,
    Tentative,
    NeedsAction,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventStatus {
    #[default]
    Confirmed,
    Tentative,
    Cancelled,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Person {
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_self: bool,
    pub response: Response,
}

impl Person {
    fn bound(&mut self) {
        if let Some(name) = self.name.as_mut() {
            clean_line(name);
        }
        clip_opt(&mut self.name, MAX_PERSON_BYTES);
        clip_opt(&mut self.email, MAX_PERSON_BYTES);
    }

    pub fn display_name(&self) -> Option<&str> {
        self.name
            .as_deref()
            .filter(|n| !n.trim().is_empty())
            .or(self.email.as_deref())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarEvent {
    pub id: String,
    pub series_id: Option<String>,
    pub calendar_id: String,
    pub source: SourceKind,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub location: Option<String>,
    pub description: Option<String>,
    pub organizer: Option<Person>,
    pub attendees: Vec<Person>,
    pub self_response: Response,
    pub link: Option<MeetingLink>,
    pub status: EventStatus,
    pub web_url: Option<String>,
    pub free: bool,
}

/// Most a title keeps, in bytes.
pub const MAX_TITLE_BYTES: usize = 1024;
/// Most a place or description keeps, in bytes. Descriptions are only read for
/// a meeting link, which is found before they are cut.
pub const MAX_TEXT_BYTES: usize = 4096;
/// Most a person's name or email keeps, in bytes.
pub const MAX_PERSON_BYTES: usize = 320;
/// Most people kept on one event, besides the user.
pub const MAX_ATTENDEES: usize = 1000;
/// Longer event ids are replaced by a hash of themselves.
pub const MAX_ID_BYTES: usize = 512;

impl CalendarEvent {
    /// The event with every field held to the limits above, and its title,
    /// place and names on one line without control or direction-override
    /// characters. A feed can repeat one huge field on every occurrence of a
    /// series.
    pub fn bounded(mut self) -> Self {
        clean_line(&mut self.title);
        clip(&mut self.title, MAX_TITLE_BYTES);
        if let Some(location) = self.location.as_mut() {
            clean_line(location);
        }
        clip_opt(&mut self.location, MAX_TEXT_BYTES);
        clip_opt(&mut self.description, MAX_TEXT_BYTES);
        clip_opt(&mut self.web_url, MAX_TEXT_BYTES);
        if let Some(organizer) = self.organizer.as_mut() {
            organizer.bound();
        }
        if self.attendees.len() > MAX_ATTENDEES {
            let mut others = 0;
            self.attendees.retain(|person| {
                others += usize::from(!person.is_self);
                person.is_self || others <= MAX_ATTENDEES
            });
        }
        for person in &mut self.attendees {
            person.bound();
        }
        self.id = bound_id(std::mem::take(&mut self.id));
        self.series_id = self.series_id.take().map(bound_id);
        self
    }

    pub fn approx_bytes(&self) -> usize {
        let text = |s: &Option<String>| s.as_ref().map_or(0, String::len);
        let person = |p: &Person| text(&p.name) + text(&p.email) + 48;
        256 + self.id.len()
            + text(&self.series_id)
            + self.calendar_id.len()
            + self.title.len()
            + text(&self.location)
            + text(&self.description)
            + text(&self.web_url)
            + self
                .link
                .as_ref()
                .map_or(0, |l| l.url.len() + text(&l.meeting_id))
            + self.organizer.as_ref().map_or(0, person)
            + self.attendees.iter().map(person).sum::<usize>()
    }

    pub fn is_cancelled(&self) -> bool {
        self.status == EventStatus::Cancelled
    }

    pub fn is_declined(&self) -> bool {
        self.self_response == Response::Declined
    }

    pub fn other_participants(&self) -> usize {
        let attendees = self.attendees.iter().filter(|p| !p.is_self).count();
        if attendees > 0 {
            return attendees;
        }
        usize::from(self.organizer.as_ref().is_some_and(|o| !o.is_self))
    }

    pub fn has_participants(&self) -> bool {
        self.other_participants() > 0
    }

    /// On a calendar that is not the user's own, the provider's `self` flag
    /// marks that calendar's owner, not the user. Marks the user by
    /// `self_emails` alone and says whether they are the organizer or an
    /// attendee.
    pub fn mark_self_by_email(&mut self, self_emails: &[String]) -> bool {
        for person in self.organizer.iter_mut().chain(self.attendees.iter_mut()) {
            person.is_self = is_self_email(person.email.as_deref(), self_emails);
        }
        self.self_response =
            derive_self_response(self.organizer.as_ref(), &self.attendees, Response::Unknown);
        self.organizer
            .iter()
            .chain(&self.attendees)
            .any(|person| person.is_self)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CalendarInfo {
    pub id: String,
    pub name: String,
    pub source: SourceKind,
    pub primary: bool,
    pub color: Option<String>,
    pub selected: bool,
    pub access_role: Option<String>,
    pub owner_email: Option<String>,
    pub time_zone: Option<String>,
}

impl CalendarInfo {
    /// The account's own calendar: its main one, one it owns, or one whose
    /// owner is one of the account's addresses. Anything else was shared by
    /// someone else.
    pub fn is_own(&self, self_emails: &[String]) -> bool {
        self.primary
            || self.access_role.as_deref() == Some("owner")
            || is_self_email(self.owner_email.as_deref(), self_emails)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
    pub skipped: usize,
}

pub(crate) fn response_from_partstat(value: &str) -> Response {
    match value.trim().to_ascii_uppercase().as_str() {
        "ACCEPTED" => Response::Accepted,
        "DECLINED" => Response::Declined,
        "TENTATIVE" => Response::Tentative,
        "NEEDS-ACTION" => Response::NeedsAction,
        _ => Response::Unknown,
    }
}

pub(crate) fn email_eq(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

pub(crate) fn is_self_email(email: Option<&str>, self_emails: &[String]) -> bool {
    email.is_some_and(|e| self_emails.iter().any(|s| email_eq(s, e)))
}

pub(crate) fn derive_self_response(
    organizer: Option<&Person>,
    attendees: &[Person],
    fallback: Response,
) -> Response {
    if let Some(me) = attendees.iter().find(|p| p.is_self)
        && me.response != Response::Unknown
    {
        return me.response;
    }
    if fallback != Response::Unknown {
        return fallback;
    }
    if organizer.is_some_and(|o| o.is_self) {
        return Response::Accepted;
    }
    attendees
        .iter()
        .find(|p| p.is_self)
        .map_or(Response::Unknown, |p| p.response)
}

/// Line breaks and tabs become spaces; other control characters and the
/// left-to-right and right-to-left override marks, which show as boxes or
/// reverse what follows them, are dropped.
fn clean_line(text: &mut String) {
    let unwanted = |c: char| c.is_control() || matches!(c, '\u{202D}' | '\u{202E}');
    if text.chars().any(unwanted) {
        *text = text
            .chars()
            .filter_map(|c| match c {
                '\t' | '\n' | '\r' => Some(' '),
                c if unwanted(c) => None,
                c => Some(c),
            })
            .collect();
    }
}

fn clip(text: &mut String, max: usize) {
    if text.len() > max {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
}

fn clip_opt(text: &mut Option<String>, max: usize) {
    if let Some(text) = text.as_mut() {
        clip(text, max);
    }
}

fn bound_id(id: String) -> String {
    use sha2::{Digest, Sha256};
    if id.len() <= MAX_ID_BYTES {
        return id;
    }
    let digest = Sha256::digest(id.as_bytes());
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256-{hex}")
}
