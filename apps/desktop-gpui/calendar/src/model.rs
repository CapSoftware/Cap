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

impl CalendarEvent {
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
