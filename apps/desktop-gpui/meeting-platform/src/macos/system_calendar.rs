use std::{ptr::NonNull, sync::Mutex};

use block2::RcBlock;
use objc2::{
    rc::Retained,
    runtime::{Bool, ProtocolObject},
    sel,
};
use objc2_event_kit::{
    EKAuthorizationStatus, EKEntityType, EKEvent, EKEventStatus, EKEventStore,
    EKEventStoreChangedNotification, EKParticipant, EKParticipantStatus,
};
use objc2_foundation::{NSDate, NSError, NSNotification, NSNotificationCenter, NSObjectProtocol};

use crate::{AttendeeStatus, CalendarAccess, SystemAttendee, SystemCalendar, SystemCalendarEvent};

const MAX_EVENTS: usize = 2_000;

pub fn calendar_access() -> CalendarAccess {
    let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
    if status == EKAuthorizationStatus::FullAccess {
        CalendarAccess::Granted
    } else if status == EKAuthorizationStatus::NotDetermined {
        CalendarAccess::NotDetermined
    } else {
        CalendarAccess::Denied
    }
}

pub fn request_calendar_access(done: impl FnOnce(bool) + Send + 'static) {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    let store = unsafe { EKEventStore::new() };
    let done = Mutex::new(Some(done));
    let keep_alive = Mutex::new(Some(store.clone()));
    let completion = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        if let Ok(mut done) = done.lock()
            && let Some(done) = done.take()
        {
            done(granted.as_bool());
        }
        if let Ok(mut store) = keep_alive.lock() {
            store.take();
        }
    });
    let handler = RcBlock::as_ptr(&completion);
    unsafe {
        if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
            store.requestFullAccessToEventsWithCompletion(handler);
        } else {
            // macOS 12 and 13 only have the older request, which the bindings
            // mark deprecated; it is the sole way to ask there.
            let _: () = objc2::msg_send![
                &*store,
                requestAccessToEntityType: EKEntityType::Event,
                completion: handler
            ];
        }
    }
}

fn unix_ms(date: &NSDate) -> i64 {
    (date.timeIntervalSince1970() * 1000.0).round() as i64
}

fn attendee(participant: &EKParticipant) -> SystemAttendee {
    let url = unsafe { participant.URL() };
    let email = url
        .resourceSpecifier()
        .map(|value| value.to_string())
        .filter(|value| value.contains('@'))
        .map(|value| value.trim_start_matches("//").to_owned());
    let status = match unsafe { participant.participantStatus() } {
        EKParticipantStatus::Accepted => AttendeeStatus::Accepted,
        EKParticipantStatus::Declined => AttendeeStatus::Declined,
        EKParticipantStatus::Tentative => AttendeeStatus::Tentative,
        EKParticipantStatus::Pending => AttendeeStatus::Pending,
        _ => AttendeeStatus::Unknown,
    };
    SystemAttendee {
        name: unsafe { participant.name() }.map(|name| name.to_string()),
        email,
        is_self: unsafe { participant.isCurrentUser() },
        status,
    }
}

fn event(item: &EKEvent) -> Option<SystemCalendarEvent> {
    let calendar = unsafe { item.calendar() }?;
    let start = unsafe { item.startDate() };
    let end = unsafe { item.endDate() };
    let identifier = unsafe { item.eventIdentifier() }
        .map(|id| id.to_string())
        .or_else(|| unsafe { item.calendarItemExternalIdentifier() }.map(|id| id.to_string()))
        .unwrap_or_else(|| unsafe { item.calendarItemIdentifier() }.to_string());
    let attendees = unsafe { item.attendees() }
        .map(|list| list.iter().map(|person| attendee(&person)).collect())
        .unwrap_or_default();

    Some(SystemCalendarEvent {
        id: identifier,
        recurring: unsafe { item.hasRecurrenceRules() },
        calendar_id: unsafe { calendar.calendarIdentifier() }.to_string(),
        calendar_title: unsafe { calendar.title() }.to_string(),
        title: unsafe { item.title() }.to_string(),
        start_unix_ms: unix_ms(&start),
        end_unix_ms: unix_ms(&end),
        all_day: unsafe { item.isAllDay() },
        location: unsafe { item.location() }.map(|value| value.to_string()),
        notes: unsafe { item.notes() }.map(|value| value.to_string()),
        url: unsafe { item.URL() }
            .and_then(|url| url.absoluteString())
            .map(|value| value.to_string()),
        organizer: unsafe { item.organizer() }.map(|person| attendee(&person)),
        attendees,
        cancelled: unsafe { item.status() } == EKEventStatus::Canceled,
    })
}

fn open_store() -> Result<Retained<EKEventStore>, CalendarAccess> {
    match calendar_access() {
        CalendarAccess::Granted => Ok(unsafe { EKEventStore::new() }),
        other => Err(other),
    }
}

pub fn system_calendars() -> Result<Vec<SystemCalendar>, CalendarAccess> {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    let store = open_store()?;
    let calendars = unsafe { store.calendarsForEntityType(EKEntityType::Event) };
    Ok(calendars
        .iter()
        .map(|calendar| SystemCalendar {
            id: unsafe { calendar.calendarIdentifier() }.to_string(),
            title: unsafe { calendar.title() }.to_string(),
            subscribed: unsafe { calendar.isSubscribed() },
        })
        .collect())
}

pub fn system_events(
    start_unix_ms: i64,
    end_unix_ms: i64,
) -> Result<Vec<SystemCalendarEvent>, CalendarAccess> {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    let store = open_store()?;
    if end_unix_ms <= start_unix_ms {
        return Ok(Vec::new());
    }
    let start = NSDate::dateWithTimeIntervalSince1970(start_unix_ms as f64 / 1000.0);
    let end = NSDate::dateWithTimeIntervalSince1970(end_unix_ms as f64 / 1000.0);
    let predicate =
        unsafe { store.predicateForEventsWithStartDate_endDate_calendars(&start, &end, None) };
    let events = unsafe { store.eventsMatchingPredicate(&predicate) };
    Ok(events
        .iter()
        .take(MAX_EVENTS)
        .filter_map(|item| event(&item))
        .collect())
}

pub struct StoreWatcher {
    _store: Retained<EKEventStore>,
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

impl StoreWatcher {
    pub fn spawn(changes: flume::Sender<()>) -> Self {
        let _pool = cidre::objc::AutoreleasePoolPage::push();
        let store = unsafe { EKEventStore::new() };
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            let _ = changes.send(());
        });
        let token = unsafe {
            NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
                Some(EKEventStoreChangedNotification),
                None,
                None,
                &block,
            )
        };
        Self {
            _store: store,
            token,
        }
    }
}

impl Drop for StoreWatcher {
    fn drop(&mut self) {
        let observer: &objc2::runtime::AnyObject = (*self.token).as_ref();
        unsafe { NSNotificationCenter::defaultCenter().removeObserver(observer) };
    }
}
