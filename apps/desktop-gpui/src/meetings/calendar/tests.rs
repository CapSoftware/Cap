use std::{
    io::{Read, Write},
    net::TcpListener,
};

use cap_calendar::{Filter, Response, SourceKind};
use cap_meeting_platform::{
    AttendeeStatus, CalendarAccess, SystemAttendee as PlatformAttendee, SystemCalendar,
    SystemCalendarEvent,
};
use chrono::{Duration, Utc};

use super::*;

fn person(name: &str, is_self: bool, status: AttendeeStatus) -> PlatformAttendee {
    PlatformAttendee {
        name: Some(name.to_string()),
        email: Some(format!("{}@example.com", name.to_ascii_lowercase())),
        is_self,
        status,
    }
}

fn system_event(id: &str, title: &str, start: DateTime<Utc>) -> SystemCalendarEvent {
    SystemCalendarEvent {
        id: id.to_string(),
        recurring: false,
        calendar_id: "cal-work".into(),
        calendar_title: "Work".into(),
        title: title.to_string(),
        start_unix_ms: start.timestamp_millis(),
        end_unix_ms: (start + Duration::minutes(30)).timestamp_millis(),
        all_day: false,
        location: Some("https://meet.google.com/abc-defg-hij".into()),
        notes: None,
        url: None,
        organizer: Some(person("Ana", false, AttendeeStatus::Accepted)),
        attendees: vec![
            person("Ana", false, AttendeeStatus::Accepted),
            person("Me", true, AttendeeStatus::Declined),
            person("Bo", false, AttendeeStatus::Pending),
        ],
        cancelled: false,
    }
}

fn calendars() -> Vec<SystemCalendar> {
    vec![
        SystemCalendar {
            id: "cal-work".into(),
            title: "Work".into(),
            subscribed: false,
        },
        SystemCalendar {
            id: "cal-holidays".into(),
            title: "Holidays".into(),
            subscribed: true,
        },
    ]
}

#[test]
fn a_system_event_maps_people_status_and_link() {
    let start = Utc::now() + Duration::hours(1);
    let mut raw = system_event("E1", "  Weekly sync ", start);
    let mapped = map_system_event(&raw).unwrap();
    assert_eq!(mapped.calendar_title.as_deref(), Some("Work"));
    assert_eq!(mapped.attendees[1].status, Response::Declined);
    assert_eq!(mapped.attendees[2].status, Response::NeedsAction);
    assert_eq!(mapped.status, EventStatus::Confirmed);

    let event = from_system_event(&mapped, Tz::UTC);
    assert_eq!(event.source, SourceKind::System);
    assert_eq!(event.calendar_id, "cal-work");
    assert_eq!(event.title, "Weekly sync");
    assert_eq!(event.id, "E1");
    assert!(event.is_declined());
    assert_eq!(event.other_participants(), 2);
    assert!(event.link.is_some());

    raw.cancelled = true;
    raw.recurring = true;
    let recurring = from_system_event(&map_system_event(&raw).unwrap(), Tz::UTC);
    assert!(recurring.is_cancelled());
    assert_eq!(recurring.series_id.as_deref(), Some("E1"));
    assert_ne!(recurring.id, "E1");

    raw.start_unix_ms = i64::MAX;
    assert!(map_system_event(&raw).is_none());
}

#[test]
fn a_system_fetch_reads_the_two_week_window_and_lists_calendars() {
    let now = Utc::now();
    let mut window = None;
    let fetched = system_fetch(now, |start, end| {
        window = Some((start, end));
        Ok((
            calendars(),
            vec![
                system_event("E1", "Planning", now + Duration::hours(2)),
                system_event("E2", "Retro", now + Duration::days(3)),
            ],
        ))
    })
    .unwrap();
    let (start, end) = window.unwrap();
    assert_eq!(start, (now - Duration::days(1)).timestamp_millis());
    assert_eq!(end, (now + Duration::days(14)).timestamp_millis());
    assert_eq!(fetched.events.len(), 2);
    let listed = fetched.calendars.unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[1].title, "Holidays");
    assert!(listed[1].subscribed);
}

#[test]
fn a_denied_or_unsupported_store_reports_its_kind() {
    for (access, kind) in [
        (CalendarAccess::Denied, SyncErrorKind::AccessDenied),
        (CalendarAccess::NotDetermined, SyncErrorKind::AccessDenied),
        (CalendarAccess::Unsupported, SyncErrorKind::Unsupported),
    ] {
        let error = system_fetch(Utc::now(), |_, _| Err(access)).err().unwrap();
        assert_eq!(error.kind, kind);
    }
}

fn ics(uid: &str, title: &str, start: DateTime<Utc>) -> String {
    format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Team\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTART:{}\r\nDTEND:{}\r\nSUMMARY:{title}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        start.format("%Y%m%dT%H%M%SZ"),
        (start + Duration::minutes(30)).format("%Y%m%dT%H%M%SZ"),
    )
}

#[test]
fn system_and_feed_copies_of_one_meeting_merge_and_the_status_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = CalendarState::in_dir(dir.path().to_path_buf());
    state.ensure_loaded();
    let feed = state
        .add_ics("https://calendar.example.com/team.ics", None)
        .unwrap();
    let system = state.add_system().unwrap();
    assert_eq!(system, SYSTEM_SOURCE_ID);
    assert_eq!(state.add_system(), Err(CalendarError::Duplicate));

    let start = Utc
        .timestamp_opt((Utc::now() + Duration::hours(3)).timestamp(), 0)
        .unwrap();
    let (feed_events, name) = parse(&feed, ics("u1", "Planning", start).as_bytes()).unwrap();
    let system_fetched = system_fetch(Utc::now(), |_, _| {
        Ok((calendars(), vec![system_event("E1", "Planning", start)]))
    })
    .unwrap();
    let now = Utc::now();
    state.apply(vec![
        RefreshResult {
            id: feed.clone(),
            at: now,
            outcome: Ok(Fetched {
                events: feed_events,
                name,
                ..Fetched::default()
            }),
        },
        RefreshResult {
            id: system.clone(),
            at: now,
            outcome: Ok(system_fetched),
        },
    ]);

    assert_eq!(state.events().len(), 1, "one meeting, two copies");
    let merged = &state.events()[0];
    assert_eq!(merged.source, SourceKind::System);
    assert_eq!(
        state.source_name(&merged.calendar_id).as_deref(),
        Some("Work")
    );
    let feed_source = state.sources.iter().find(|s| s.id == feed).unwrap();
    assert_eq!(feed_source.name, "Team");
    assert_eq!(feed_source.status.event_count, 1);
    let system_source = state.sources.iter().find(|s| s.id == system).unwrap();
    assert_eq!(system_source.status.calendars.len(), 2);
    let everything = Filter {
        hide_declined: false,
        ..Filter::default()
    };
    assert_eq!(state.upcoming_count(&system, &everything, now), 1);
    assert_eq!(state.upcoming_count(&system, &Filter::default(), now), 0);

    state.apply(vec![RefreshResult {
        id: system.clone(),
        at: now,
        outcome: Err(SyncError::new(SyncErrorKind::AccessDenied, "denied")),
    }]);
    let system_source = state.sources.iter().find(|s| s.id == system).unwrap();
    assert_eq!(
        system_source.status.error_kind,
        Some(SyncErrorKind::AccessDenied)
    );
    assert_eq!(system_source.status.last_sync, Some(now));
    assert_eq!(state.events().len(), 1, "an error keeps the last good copy");

    let mut reloaded = CalendarState::in_dir(dir.path().to_path_buf());
    reloaded.ensure_loaded();
    assert_eq!(reloaded.sources.len(), 2);
    assert!(reloaded.has_system());
    assert_eq!(reloaded.events().len(), 1);

    reloaded.remove(&system).unwrap();
    assert_eq!(reloaded.remove(&system), Err(CalendarError::NotFound));
    assert!(!reloaded.has_system());
    assert_eq!(reloaded.events().len(), 1);
    assert_eq!(reloaded.events()[0].source, SourceKind::Ics);
}

#[test]
fn feed_links_are_validated_before_they_are_added() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = CalendarState::in_dir(dir.path().to_path_buf());
    state.ensure_loaded();
    assert!(matches!(
        state.add_ics("not a link", None),
        Err(CalendarError::InvalidUrl(_))
    ));
    state
        .add_ics("webcal://calendar.example.com/a.ics", Some(" Home ".into()))
        .unwrap();
    assert_eq!(state.sources[0].name, "Home");
    assert_eq!(
        state.add_ics("https://calendar.example.com/a.ics", None),
        Err(CalendarError::Duplicate)
    );
}

fn serve(responses: Vec<(u16, &'static str, String)>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for (status, kind, body) in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut buffer = [0u8; 4096];
            let _ = stream.read(&mut buffer);
            let reply = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
        }
    });
    format!("http://{address}/feed.ics")
}

fn source(id: &str, url: String) -> CalendarSource {
    CalendarSource {
        id: id.to_string(),
        name: String::new(),
        config: SourceConfig::Ics { url },
        status: SourceStatus::default(),
    }
}

#[test]
fn a_feed_refresh_reports_success_and_each_failure_in_its_own_kind() {
    let dir = tempfile::tempdir().unwrap();
    let start = Utc::now() + Duration::hours(5);
    let ok = serve(vec![(200, "text/calendar", ics("u9", "Review", start))]);
    let missing = serve(vec![(404, "text/plain", "gone".into())]);
    let broken = serve(vec![(500, "text/plain", "oops".into())]);
    let html = serve(vec![(200, "text/html", "<html>no</html>".into())]);
    let closed = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        format!("http://{address}/feed.ics")
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let results = runtime.block_on(refresh_in(
        dir.path().to_path_buf(),
        vec![
            source("ok", ok),
            source("missing", missing),
            source("broken", broken),
            source("html", html),
            source("closed", closed),
        ],
    ));
    let kinds: Vec<Option<SyncErrorKind>> = results
        .iter()
        .map(|r| r.outcome.as_ref().err().map(|e| e.kind))
        .collect();
    assert_eq!(
        kinds,
        vec![
            None,
            Some(SyncErrorKind::Rejected),
            Some(SyncErrorKind::Server),
            Some(SyncErrorKind::NotCalendar),
            Some(SyncErrorKind::Offline),
        ]
    );
    let fetched = results[0].outcome.as_ref().unwrap();
    assert_eq!(fetched.events.len(), 1);
    assert_eq!(fetched.name.as_deref(), Some("Team"));
}

#[test]
fn connecting_the_same_account_twice_keeps_one_source_and_the_newest_token() {
    use super::accounts::Provider;

    let dir = tempfile::tempdir().unwrap();
    let mut state = CalendarState::in_dir(dir.path().to_path_buf());
    let first = state
        .add_account(Provider::Google, "Ada@Example.com", "token-1")
        .unwrap();
    let second = state
        .add_account(Provider::Google, "ada@example.com ", "token-2")
        .unwrap();
    let other = state
        .add_account(Provider::Microsoft, "ada@example.com", "token-3")
        .unwrap();
    assert_eq!(first, second);
    assert_ne!(first, other);
    assert_eq!(state.sources.len(), 2);
    assert_eq!(
        state.sources[0].config.kind(),
        cap_calendar::SourceKind::Google
    );
    assert_eq!(
        state.sources[1].config.kind(),
        cap_calendar::SourceKind::Microsoft
    );
    let stored = std::fs::read_to_string(dir.path().join("calendar-accounts.json")).unwrap();
    assert!(stored.contains("token-2") && !stored.contains("token-1"));
    let sources = std::fs::read_to_string(dir.path().join(CALENDARS_FILE)).unwrap();
    assert!(!sources.contains("token-"));

    let mut reloaded = CalendarState::in_dir(dir.path().to_path_buf());
    reloaded.ensure_loaded();
    assert_eq!(reloaded.sources, state.sources);

    state.remove(&first).unwrap();
    let stored = std::fs::read_to_string(dir.path().join("calendar-accounts.json")).unwrap();
    assert!(!stored.contains("token-2") && stored.contains("token-3"));
}

fn timed(id: &str, calendar: &str, minutes: i64, length: i64) -> CalendarEvent {
    let start = Utc::now() + Duration::minutes(minutes);
    CalendarEvent {
        id: id.into(),
        calendar_id: calendar.into(),
        title: format!("Meeting {id}"),
        start,
        end: start + Duration::minutes(length),
        ..CalendarEvent::default()
    }
}

#[test]
fn every_entry_point_id_finds_its_calendar_event() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = CalendarState::in_dir(dir.path().to_path_buf());
    state.ensure_loaded();
    let feed = state
        .add_ics("https://calendar.example.com/team.ics", None)
        .unwrap();
    let start = Utc
        .timestamp_opt((Utc::now() + Duration::minutes(3)).timestamp(), 0)
        .unwrap();
    let (events, name) = parse(&feed, ics("u1", "Design review", start).as_bytes()).unwrap();
    state.apply(vec![RefreshResult {
        id: feed.clone(),
        at: Utc::now(),
        outcome: Ok(Fetched {
            events,
            name,
            ..Fetched::default()
        }),
    }]);
    let event = state.events()[0].clone();
    assert!(!event.calendar_id.is_empty());

    let summary = crate::meetings_ui::live::model::EventSummary::of(&event);
    assert_eq!(state.find(&summary.id).map(|e| &e.title), Some(&event.title));
    let tray = crate::tray::meetings::next_row(&summary, Utc::now(), false);
    let tray_id = tray.event_id.expect("an imminent meeting is clickable");
    assert_eq!(state.find(&tray_id).map(|e| &e.title), Some(&event.title));
    let planner = &state.planner_events(&CalendarSettings::default())[0];
    assert_eq!(state.find(&planner.id).map(|e| &e.title), Some(&event.title));
    let snapshot = snapshot(&event, None);
    assert_eq!(state.find(&snapshot.id).map(|e| &e.title), Some(&event.title));
    assert!(state.find(&event.id).is_none(), "a bare provider id is not a key");
}

#[test]
fn a_manual_start_links_the_meeting_in_progress_or_starting_soon() {
    let now = Utc::now();
    assert!(auto_link(&[], now).is_none());

    let later = timed("later", "c", 11, 30);
    let ended = timed("ended", "c", -40, 30);
    let mut all_day = timed("day", "c", -60, 24 * 60);
    all_day.all_day = true;
    assert!(auto_link(&[later.clone(), ended.clone(), all_day.clone()], now).is_none());

    let soon = timed("soon", "c", 9, 30);
    assert_eq!(
        auto_link(&[later.clone(), soon.clone()], now).map(|e| e.id.as_str()),
        Some("soon")
    );

    let running = timed("running", "c", -2, 30);
    let events = [later, ended, all_day, soon, running];
    assert_eq!(
        auto_link(&events, now).map(|e| e.id.as_str()),
        Some("running"),
        "the start closest to now wins"
    );
    assert_eq!(
        auto_link(&events, now).map(event_key).as_deref(),
        Some("c|running")
    );
}
