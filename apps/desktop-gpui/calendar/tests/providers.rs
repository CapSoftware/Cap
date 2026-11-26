use cap_calendar::google::{
    GoogleOptions, google_calendar_list_request, google_events_request, parse_google_calendar_list,
    parse_google_events, parse_google_events_with,
};
use cap_calendar::graph::{
    GraphOptions, graph_calendar_view_request, graph_calendars_request, parse_graph_calendars,
    parse_graph_events_with,
};
use cap_calendar::system::{SystemAttendee, SystemEvent, from_system_event};
use cap_calendar::{
    CalendarEvent, Error, EventStatus, HttpMethod, Provider, Response, SourceKind, Tz,
};
use chrono::{DateTime, Utc};

fn utc(s: &str) -> DateTime<Utc> {
    s.parse().unwrap_or_else(|e| panic!("{s}: {e}"))
}

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn by_id<'a>(events: &'a [CalendarEvent], id: &str) -> &'a CalendarEvent {
    events
        .iter()
        .find(|e| e.id == id)
        .unwrap_or_else(|| panic!("missing {id}"))
}

fn google_opts() -> GoogleOptions {
    GoogleOptions {
        self_emails: vec!["me@acme.example".to_string()],
        ..GoogleOptions::default()
    }
}

#[test]
fn google_events_request_shape() {
    let window = utc("2026-03-01T00:00:00Z")..utc("2026-04-01T00:00:00Z");
    let spec = google_events_request(
        "en.usa#holiday@group.v.calendar.google.com",
        &window,
        Some("tok123"),
    );
    assert_eq!(spec.method, HttpMethod::Get);
    assert_eq!(
        spec.url,
        "https://www.googleapis.com/calendar/v3/calendars/en.usa%23holiday@group.v.calendar.google.com/events"
    );
    let get = |k: &str| {
        spec.query
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("singleEvents"), Some("true"));
    assert_eq!(get("orderBy"), Some("startTime"));
    assert_eq!(get("timeMin"), Some("2026-03-01T00:00:00Z"));
    assert_eq!(get("timeMax"), Some("2026-04-01T00:00:00Z"));
    assert_eq!(get("maxResults"), Some("250"));
    assert_eq!(get("pageToken"), Some("tok123"));
    let fields = get("fields").unwrap();
    for needed in [
        "nextPageToken",
        "conferenceData",
        "hangoutLink",
        "attendees(",
        "recurringEventId",
        "eventType",
        "htmlLink",
    ] {
        assert!(fields.contains(needed), "{needed}");
    }
    let full = spec.url_with_query();
    assert!(full.contains("timeMin=2026-03-01T00%3A00%3A00Z"), "{full}");
    assert!(spec.form_body().is_none());

    let first = google_events_request("primary", &window, None);
    assert!(first.query.iter().all(|(k, _)| k != "pageToken"));
    let list = google_calendar_list_request(None);
    assert_eq!(
        list.url,
        "https://www.googleapis.com/calendar/v3/users/me/calendarList"
    );
}

#[test]
fn google_events_page() {
    let page = parse_google_events_with(
        &fixture("google_events_page1.json"),
        "primary",
        &google_opts(),
    )
    .unwrap();
    assert_eq!(
        page.next.as_deref(),
        Some("CigKGjdrdWt1cXJmZWRsbTJmOXQ2dm8ybWgxbG41GAEggICA2r")
    );
    assert_eq!(page.items.len(), 7);
    assert_eq!(page.skipped, 7);
    assert!(
        page.items
            .iter()
            .all(|e| e.source == SourceKind::Google && e.calendar_id == "primary")
    );

    let sync = by_id(&page.items, "7kukuqrfedlm2f9t6vo2mh1ln5_20260309T130000Z");
    assert_eq!(sync.start, utc("2026-03-09T13:00:00Z"));
    assert_eq!(sync.end, utc("2026-03-09T13:30:00Z"));
    assert_eq!(
        sync.series_id.as_deref(),
        Some("7kukuqrfedlm2f9t6vo2mh1ln5")
    );
    assert_eq!(sync.attendees.len(), 3);
    assert_eq!(sync.self_response, Response::Accepted);
    assert!(
        sync.web_url
            .as_deref()
            .unwrap()
            .starts_with("https://www.google.com/calendar/event?eid=")
    );
    let link = sync.link.as_ref().unwrap();
    assert_eq!(
        (link.provider, link.meeting_id.as_deref()),
        (Provider::GoogleMeet, Some("abc-defg-hij"))
    );

    let birthday = by_id(&page.items, "birthday_20260312");
    assert!(birthday.all_day && birthday.free);
    assert_eq!(birthday.start, utc("2026-03-12T00:00:00Z"));
    assert_eq!(birthday.end, utc("2026-03-13T00:00:00Z"));

    let zoom = by_id(&page.items, "zoomaddon1");
    let link = zoom.link.as_ref().unwrap();
    assert_eq!(link.provider, Provider::Zoom);
    assert_eq!(link.meeting_id.as_deref(), Some("84512345678"));
    assert_eq!(zoom.self_response, Response::Accepted);
    assert!(zoom.organizer.as_ref().unwrap().is_self);

    let declined = by_id(&page.items, "declined1");
    assert_eq!(declined.self_response, Response::Declined);
    assert_eq!(
        declined.link.as_ref().and_then(|l| l.meeting_id.as_deref()),
        Some("xyz-abcd-efg")
    );

    let teams = by_id(&page.items, "teamsdesc1");
    assert_eq!(teams.status, EventStatus::Tentative);
    assert_eq!(teams.self_response, Response::NeedsAction);
    assert_eq!(teams.location.as_deref(), Some("Room 4"));
    assert_eq!(
        teams.link.as_ref().and_then(|l| l.meeting_id.as_deref()),
        Some("19:meeting_ZDQ4YTI2@thread.v2")
    );

    let solo = by_id(&page.items, "solo1");
    assert_eq!(solo.self_response, Response::Accepted);
    assert!(!solo.has_participants());
    assert!(solo.link.is_none());

    let london = by_id(&page.items, "nooffset1");
    assert_eq!(london.start, utc("2026-03-13T10:00:00Z"));
}

#[test]
fn google_flags_include_status_events_and_cancellations() {
    let opts = GoogleOptions {
        include_status_events: true,
        include_cancelled: true,
        ..google_opts()
    };
    let page =
        parse_google_events_with(&fixture("google_events_page1.json"), "primary", &opts).unwrap();
    assert_eq!(page.items.len(), 11);
    let cancelled = by_id(&page.items, "7kukuqrfedlm2f9t6vo2mh1ln5_20260330T130000Z");
    assert_eq!(cancelled.status, EventStatus::Cancelled);
    assert_eq!(cancelled.start, utc("2026-03-30T13:00:00Z"));
    by_id(&page.items, "wl_20260310");
    by_id(&page.items, "ooo_1");
    by_id(&page.items, "focus_1");
}

#[test]
fn google_last_page_and_errors() {
    let page = parse_google_events(&fixture("google_events_page2.json"), "primary").unwrap();
    assert_eq!(page.next, None);
    assert_eq!(page.items.len(), 1);
    assert_eq!(
        page.items[0]
            .link
            .as_ref()
            .and_then(|l| l.meeting_id.as_deref()),
        Some("99887766554")
    );

    let err = parse_google_events(
        r#"{"error":{"code":401,"message":"Request had invalid authentication credentials.","errors":[{"reason":"authError"}],"status":"UNAUTHENTICATED"}}"#,
        "primary",
    )
    .unwrap_err();
    assert!(err.is_unauthorized());
    assert!(matches!(
        err,
        Error::Api {
            status: Some(401),
            ..
        }
    ));
    assert!(matches!(parse_google_events("{", "p"), Err(Error::Json(_))));
    assert!(matches!(
        parse_google_events("[]", "p"),
        Err(Error::InvalidResponse(_))
    ));
    assert!(matches!(
        parse_google_events(r#"{"items":5}"#, "p"),
        Err(Error::InvalidResponse(_))
    ));
    assert_eq!(
        parse_google_events(r#"{"kind":"calendar#events"}"#, "p")
            .unwrap()
            .items
            .len(),
        0
    );
}

#[test]
fn google_calendar_list() {
    let page = parse_google_calendar_list(&fixture("google_calendar_list.json")).unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.skipped, 2);
    let primary = &page.items[0];
    assert!(primary.primary && primary.selected);
    assert_eq!(primary.color.as_deref(), Some("#9fe1e7"));
    assert_eq!(primary.access_role.as_deref(), Some("owner"));
    assert_eq!(primary.owner_email.as_deref(), Some("me@acme.example"));
    assert_eq!(primary.time_zone.as_deref(), Some("America/New_York"));
    let holidays = &page.items[1];
    assert_eq!(holidays.name, "US holidays");
    assert!(!holidays.selected);
}

#[test]
fn graph_requests() {
    let window = utc("2026-03-01T00:00:00Z")..utc("2026-04-01T00:00:00Z");
    let spec = graph_calendar_view_request(None, &window, None).unwrap();
    assert_eq!(spec.url, "https://graph.microsoft.com/v1.0/me/calendarView");
    assert_eq!(spec.header("prefer"), Some("outlook.timezone=\"UTC\""));
    let get = |k: &str| {
        spec.query
            .iter()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(get("startDateTime"), Some("2026-03-01T00:00:00Z"));
    assert_eq!(get("endDateTime"), Some("2026-04-01T00:00:00Z"));
    assert_eq!(get("$orderby"), Some("start/dateTime"));
    for field in [
        "onlineMeeting",
        "onlineMeetingUrl",
        "isOnlineMeeting",
        "body",
        "responseStatus",
        "seriesMasterId",
        "webLink",
        "isAllDay",
        "isCancelled",
    ] {
        assert!(
            get("$select").unwrap().split(',').any(|f| f == field),
            "{field}"
        );
    }

    let spec = graph_calendar_view_request(Some("AAMk/abc="), &window, None).unwrap();
    assert_eq!(
        spec.url,
        "https://graph.microsoft.com/v1.0/me/calendars/AAMk%2Fabc=/calendarView"
    );

    let next = "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2026-03-01T00%3a00%3a00Z&%24skip=250";
    let spec = graph_calendar_view_request(None, &window, Some(next)).unwrap();
    assert!(spec.query.is_empty());
    assert!(
        spec.url
            .starts_with("https://graph.microsoft.com/v1.0/me/calendarView?")
    );
    assert!(spec.url.contains("%24skip=250"));
    assert_eq!(spec.header("Prefer"), Some("outlook.timezone=\"UTC\""));

    for bad in [
        "https://evil.example/v1.0/me/calendarView",
        "https://graph.microsoft.com.evil.example/v1.0",
        "http://graph.microsoft.com/v1.0/me/calendarView",
        "https://graph.microsoft.com:8443/v1.0/me",
        "https://user@graph.microsoft.com/v1.0/me",
        "not a url",
    ] {
        assert!(
            matches!(
                graph_calendar_view_request(None, &window, Some(bad)),
                Err(Error::UntrustedUrl(_))
            ),
            "{bad}"
        );
    }
    assert!(
        graph_calendars_request(None)
            .unwrap()
            .url
            .ends_with("/me/calendars")
    );
}

#[test]
fn graph_calendar_view_page() {
    let opts = GraphOptions {
        self_emails: vec!["me@contoso.example".to_string()],
        ..GraphOptions::default()
    };
    let page =
        parse_graph_events_with(&fixture("graph_calendar_view.json"), "cal-1", &opts).unwrap();
    assert!(page.next.as_deref().unwrap().contains("%24skip=250"));
    assert_eq!(page.items.len(), 5);
    assert_eq!(page.skipped, 2);
    assert!(page.items.iter().all(|e| e.source == SourceKind::Microsoft));

    let review = by_id(&page.items, "AAMkAGI2TG93AAA=");
    assert_eq!(review.start, utc("2026-03-10T17:00:00Z"));
    assert_eq!(review.end, utc("2026-03-10T18:00:00Z"));
    assert_eq!(review.self_response, Response::Accepted);
    assert_eq!(review.attendees.len(), 2);
    assert!(review.attendees[0].is_self);
    assert_eq!(review.series_id.as_deref(), Some("AAMkAGI2SERIES="));
    let link = review.link.as_ref().unwrap();
    assert_eq!(link.provider, Provider::Teams);
    assert_eq!(
        link.meeting_id.as_deref(),
        Some("19:meeting_NjE2ODk3@thread.v2")
    );
    let description = review.description.as_deref().unwrap();
    assert!(description.contains("Please review the mocks."));
    assert!(!description.contains('<') && !description.contains("margin"));
    assert!(
        review
            .web_url
            .as_deref()
            .unwrap()
            .starts_with("https://outlook.office365.com/")
    );

    let holiday = by_id(&page.items, "AAMkAGI2HOLIDAY=");
    assert!(holiday.all_day && holiday.free);
    assert_eq!(holiday.start, utc("2026-03-20T00:00:00Z"));
    assert_eq!(holiday.end, utc("2026-03-21T00:00:00Z"));
    assert_eq!(holiday.self_response, Response::Accepted);

    let west = by_id(&page.items, "AAMkAGI2PACIFIC=");
    assert_eq!(west.start, utc("2026-03-12T16:00:00Z"));
    assert_eq!(west.end, utc("2026-03-12T16:30:00Z"));
    assert_eq!(west.self_response, Response::Tentative);
    assert_eq!(
        west.link.as_ref().map(|l| l.provider),
        Some(Provider::GoogleMeet)
    );

    let vendor = by_id(&page.items, "AAMkAGI2ZOOMBODY=");
    let link = vendor.link.as_ref().unwrap();
    assert_eq!(
        link.url,
        "https://us02web.zoom.us/j/81234567890?pwd=ZmFrZQ.1"
    );
    assert_eq!(vendor.self_response, Response::NeedsAction);
    assert_eq!(vendor.location, None);

    let declined = by_id(&page.items, "AAMkAGI2DECLINED=");
    assert_eq!(declined.self_response, Response::Declined);
    assert_eq!(
        declined.link.as_ref().map(|l| l.provider),
        Some(Provider::Teams)
    );

    let with_cancelled = GraphOptions {
        include_cancelled: true,
        ..opts
    };
    let page = parse_graph_events_with(
        &fixture("graph_calendar_view.json"),
        "cal-1",
        &with_cancelled,
    )
    .unwrap();
    assert_eq!(
        by_id(&page.items, "AAMkAGI2CANCELLED=").status,
        EventStatus::Cancelled
    );

    let err = parse_graph_events_with(
        r#"{"error":{"code":"InvalidAuthenticationToken","message":"Access token has expired or is not yet valid."}}"#,
        "cal-1",
        &GraphOptions::default(),
    )
    .unwrap_err();
    assert!(err.is_unauthorized());
}

#[test]
fn graph_calendars() {
    let page = parse_graph_calendars(&fixture("graph_calendars.json")).unwrap();
    assert_eq!(page.items.len(), 2);
    assert_eq!(page.skipped, 1);
    assert!(page.items[0].primary);
    assert_eq!(page.items[0].access_role.as_deref(), Some("writer"));
    assert_eq!(page.items[0].color, None);
    assert_eq!(page.items[1].color.as_deref(), Some("#87d28e"));
    assert_eq!(
        page.items[1].owner_email.as_deref(),
        Some("me@contoso.example")
    );
}

#[test]
fn system_events() {
    let base = SystemEvent {
        event_id: "EK-123".to_string(),
        calendar_id: "work".to_string(),
        calendar_title: Some("Work".to_string()),
        title: " Weekly planning ".to_string(),
        start: utc("2026-03-10T16:00:00Z"),
        end: utc("2026-03-10T16:30:00Z"),
        notes: Some("Agenda\nhttps://acme.zoom.us/j/84512345678".to_string()),
        url: Some("https://whereby.com/acme".to_string()),
        attendees: vec![
            SystemAttendee {
                name: Some("Me".to_string()),
                email: Some("me@acme.example".to_string()),
                is_self: true,
                status: Response::Tentative,
            },
            SystemAttendee {
                name: Some("Ana".to_string()),
                email: None,
                is_self: false,
                status: Response::Accepted,
            },
        ],
        is_recurring: true,
        ..SystemEvent::default()
    };
    let event = from_system_event(&base, Tz::Europe__London);
    assert_eq!(event.id, "EK-123_20260310T160000Z");
    assert_eq!(event.series_id.as_deref(), Some("EK-123"));
    assert_eq!(event.title, "Weekly planning");
    assert_eq!(event.source, SourceKind::System);
    assert_eq!(event.self_response, Response::Tentative);
    assert_eq!(
        event.link.as_ref().map(|l| l.provider),
        Some(Provider::Zoom)
    );
    assert!(event.has_participants());

    let all_day = SystemEvent {
        all_day: true,
        is_recurring: false,
        start: utc("2026-03-09T15:00:00Z"),
        end: utc("2026-03-10T14:59:59Z"),
        notes: None,
        ..base.clone()
    };
    let event = from_system_event(&all_day, Tz::Asia__Tokyo);
    assert_eq!(event.id, "EK-123");
    assert!(event.all_day);
    assert_eq!(event.start, utc("2026-03-10T00:00:00Z"));
    assert_eq!(event.end, utc("2026-03-11T00:00:00Z"));
    assert_eq!(
        event.link.as_ref().map(|l| l.provider),
        Some(Provider::Whereby)
    );

    let json = serde_json::to_string(&base).unwrap();
    let back: SystemEvent = serde_json::from_str(&json).unwrap();
    assert_eq!(back, base);
}

#[test]
fn a_shared_calendars_self_flag_is_replaced_by_the_users_address() {
    use cap_calendar::{CalendarEvent, CalendarInfo, Person, Response};
    let owner = Person {
        email: Some("boss@example.com".into()),
        is_self: true,
        response: Response::Accepted,
        ..Person::default()
    };
    let mut alone = CalendarEvent {
        organizer: Some(owner.clone()),
        ..CalendarEvent::default()
    };
    assert!(!alone.mark_self_by_email(&["me@example.com".into()]));
    assert!(!alone.organizer.as_ref().unwrap().is_self);

    let mut invited = CalendarEvent {
        organizer: Some(owner),
        attendees: vec![Person {
            email: Some("me@EXAMPLE.com".into()),
            response: Response::Tentative,
            ..Person::default()
        }],
        ..CalendarEvent::default()
    };
    assert!(invited.mark_self_by_email(&["me@example.com".into()]));
    assert_eq!(invited.self_response, Response::Tentative);

    let shared = CalendarInfo {
        access_role: Some("reader".into()),
        owner_email: Some("boss@example.com".into()),
        ..CalendarInfo::default()
    };
    assert!(!shared.is_own(&["me@example.com".to_string()]));
    assert!(
        !CalendarInfo {
            owner_email: None,
            ..shared.clone()
        }
        .is_own(&[])
    );
    assert!(
        CalendarInfo {
            primary: true,
            ..shared.clone()
        }
        .is_own(&["me@example.com".to_string()])
    );
    assert!(
        CalendarInfo {
            access_role: Some("owner".into()),
            ..shared.clone()
        }
        .is_own(&[])
    );
    assert!(
        CalendarInfo {
            owner_email: Some("ME@example.com".into()),
            ..shared
        }
        .is_own(&["me@example.com".to_string()])
    );
}
