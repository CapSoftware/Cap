use std::ops::Range;

use cap_calendar::ics::{ParseOptions, ParsedCalendar, ZoneResolution, expand, parse_calendar};
use cap_calendar::{Agenda, CalendarEvent, EventStatus, Filter, Provider, Response, Tz};
use chrono::{DateTime, Duration, NaiveDate, Utc};

fn utc(s: &str) -> DateTime<Utc> {
    s.parse().unwrap_or_else(|e| panic!("{s}: {e}"))
}

fn fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn window(start: &str, end: &str) -> Range<DateTime<Utc>> {
    utc(start)..utc(end)
}

fn opts(zone: Tz) -> ParseOptions {
    ParseOptions {
        calendar_id: "feed".to_string(),
        default_zone: zone,
        ..ParseOptions::default()
    }
}

fn run(
    text: &str,
    zone: Tz,
    w: Range<DateTime<Utc>>,
    me: &str,
) -> (ParsedCalendar, Vec<CalendarEvent>) {
    let cal = parse_calendar(text, &opts(zone));
    let events = expand(&cal, w, &[me.to_string()]);
    (cal, events)
}

fn starts(events: &[CalendarEvent], title_prefix: &str) -> Vec<DateTime<Utc>> {
    events
        .iter()
        .filter(|e| e.title.starts_with(title_prefix))
        .map(|e| e.start)
        .collect()
}

fn one<'a>(events: &'a [CalendarEvent], title: &str) -> &'a CalendarEvent {
    let found: Vec<&CalendarEvent> = events.iter().filter(|e| e.title == title).collect();
    assert_eq!(found.len(), 1, "{title}");
    found[0]
}

fn wrap(body: &str) -> String {
    format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}END:VCALENDAR\r\n")
}

fn event(lines: &str) -> String {
    wrap(&format!("BEGIN:VEVENT\r\n{lines}END:VEVENT\r\n"))
}

#[test]
fn google_export() {
    let (cal, events) = run(
        &fixture("google_export.ics"),
        Tz::UTC,
        window("2026-02-20T00:00:00Z", "2026-04-10T00:00:00Z"),
        "me@acme.example",
    );
    assert_eq!(cal.name.as_deref(), Some("Acme Work"));
    assert_eq!(cal.time_zone.as_deref(), Some("America/New_York"));
    assert_eq!(cal.warnings, 0, "{:?}", cal.warning_messages);
    assert_eq!(events.len(), 14);

    let sync = starts(&events, "Product sync");
    assert_eq!(
        sync,
        vec![
            utc("2026-02-23T14:00:00Z"),
            utc("2026-03-02T14:00:00Z"),
            utc("2026-03-09T13:00:00Z"),
            utc("2026-03-23T15:00:00Z"),
            utc("2026-04-06T13:00:00Z"),
        ]
    );
    let first = &events[0];
    assert_eq!(
        first.id,
        "7kukuqrfedlm2f9t6vo2mh1ln5@google.com_20260223T140000Z"
    );
    assert_eq!(
        first.series_id.as_deref(),
        Some("7kukuqrfedlm2f9t6vo2mh1ln5@google.com")
    );
    assert_eq!(first.end - first.start, Duration::minutes(30));
    assert_eq!(first.calendar_id, "feed");
    assert_eq!(first.self_response, Response::Accepted);
    assert_eq!(first.attendees.len(), 2);
    assert_eq!(
        first.organizer.as_ref().and_then(|o| o.name.as_deref()),
        Some("Alice Chen")
    );
    assert_eq!(first.location.as_deref(), Some("NYC-4-Hudson (8)"));
    let description = first.description.as_deref().unwrap();
    assert!(description.starts_with("Weekly product sync, bring updates; demos welcome.\n\n"));
    assert!(description.contains("More phone numbers: https://tel.meet/"));
    let link = first.link.as_ref().unwrap();
    assert_eq!(link.provider, Provider::GoogleMeet);
    assert_eq!(link.meeting_id.as_deref(), Some("abc-defg-hij"));

    let moved = one(&events, "Product sync (moved)");
    assert_eq!(
        moved.id,
        "7kukuqrfedlm2f9t6vo2mh1ln5@google.com_20260323T130000Z"
    );
    assert_eq!(moved.self_response, Response::Tentative);
    assert!(events.iter().all(|e| !e.id.ends_with("20260316T130000Z")));
    assert!(events.iter().all(|e| !e.id.ends_with("20260330T130000Z")));

    let offsite = one(&events, "Team offsite");
    assert!(offsite.all_day && offsite.free);
    assert_eq!(offsite.start, utc("2026-03-10T00:00:00Z"));
    assert_eq!(offsite.end, utc("2026-03-12T00:00:00Z"));

    let call = one(&events, "Customer call: Globex");
    let link = call.link.as_ref().unwrap();
    assert_eq!(link.url, "https://acme.zoom.us/j/84512345678?pwd=aBcDeF");
    assert_eq!(link.meeting_id.as_deref(), Some("84512345678"));
    assert_eq!(call.self_response, Response::Accepted);
    assert_eq!(call.location, None);
    assert_eq!(call.end - call.start, Duration::minutes(45));

    let declined = one(&events, "All hands");
    assert_eq!(declined.self_response, Response::Declined);
    assert_eq!(declined.start, utc("2026-03-05T20:00:00Z"));
    assert_eq!(
        declined.link.as_ref().and_then(|l| l.meeting_id.as_deref()),
        Some("19:meeting_YmFkZ2Vy@thread.v2")
    );

    let focus = starts(&events, "Focus block");
    assert_eq!(focus.len(), 5);
    assert_eq!(focus[0], utc("2026-03-09T12:00:00Z"));
    assert_eq!(focus[4], utc("2026-03-13T12:00:00Z"));

    let chat = one(&events, "Quick chat");
    assert_eq!(chat.start, utc("2026-03-06T17:00:00Z"));
    assert_eq!(chat.end, utc("2026-03-06T17:30:00Z"));
    assert_eq!(
        chat.link.as_ref().map(|l| l.provider),
        Some(Provider::Whereby)
    );
    assert_eq!(
        chat.web_url.as_deref(),
        Some("https://whereby.com/acme-standup")
    );

    let mut sorted = events.clone();
    sorted.sort_by_key(|e| e.start);
    assert_eq!(
        sorted.iter().map(|e| &e.id).collect::<Vec<_>>(),
        events.iter().map(|e| &e.id).collect::<Vec<_>>()
    );
}

#[test]
fn cancelled_instances_can_be_kept_on_request() {
    let cal = parse_calendar(
        &fixture("google_export.ics"),
        &ParseOptions {
            include_cancelled: true,
            ..opts(Tz::UTC)
        },
    );
    let events = expand(
        &cal,
        window("2026-03-29T00:00:00Z", "2026-03-31T00:00:00Z"),
        &[],
    );
    let cancelled: Vec<_> = events
        .iter()
        .filter(|e| e.status == EventStatus::Cancelled)
        .collect();
    assert_eq!(cancelled.len(), 1);
    assert_eq!(
        cancelled[0].id,
        "7kukuqrfedlm2f9t6vo2mh1ln5@google.com_20260330T130000Z"
    );
}

#[test]
fn outlook_export() {
    let (cal, events) = run(
        &fixture("outlook_export.ics"),
        Tz::UTC,
        window("2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"),
        "me@contoso.example",
    );
    assert_eq!(cal.warnings, 0, "{:?}", cal.warning_messages);
    let custom = cal
        .zones
        .iter()
        .find(|z| z.tzid == "Customized Time Zone")
        .unwrap();
    assert_eq!(custom.how, ZoneResolution::MatchedRules);
    assert_eq!(custom.zone_name, "Europe/London");
    let pacific = cal
        .zones
        .iter()
        .find(|z| z.tzid == "Pacific Standard Time")
        .unwrap();
    assert_eq!(pacific.how, ZoneResolution::Named);
    assert_eq!(pacific.zone_name, "America/Los_Angeles");

    let review = one(&events, "Design review");
    assert_eq!(review.start, utc("2026-03-10T17:00:00Z"));
    assert_eq!(review.end, utc("2026-03-10T18:00:00Z"));
    assert_eq!(review.self_response, Response::Tentative);
    assert_eq!(review.location.as_deref(), Some("Microsoft Teams Meeting"));
    let link = review.link.as_ref().unwrap();
    assert_eq!(link.provider, Provider::Teams);
    assert_eq!(
        link.meeting_id.as_deref(),
        Some("19:meeting_NjE2ODk3@thread.v2")
    );
    assert!(
        review
            .description
            .as_deref()
            .unwrap()
            .contains("Passcode: Xy7pQ2")
    );
    assert_eq!(review.attendees.len(), 2);
    assert_eq!(review.attendees[1].name.as_deref(), Some("Ruiz, Dana"));

    assert_eq!(
        starts(&events, "Board review"),
        vec![
            utc("2026-01-13T14:00:00Z"),
            utc("2026-02-10T14:00:00Z"),
            utc("2026-03-10T14:00:00Z"),
            utc("2026-04-14T13:00:00Z"),
            utc("2026-05-12T13:00:00Z"),
            utc("2026-06-09T13:00:00Z"),
        ]
    );
    let board = events.iter().find(|e| e.title == "Board review").unwrap();
    assert_eq!(board.end - board.start, Duration::minutes(90));
    let link = board.link.as_ref().unwrap();
    assert_eq!(link.url, "https://us06web.zoom.us/j/87654321098?pwd=QwErTy");

    let holiday = one(&events, "Company holiday");
    assert!(holiday.all_day && holiday.free);
    assert_eq!(holiday.start, utc("2026-03-20T00:00:00Z"));
    let sick = one(&events, "Out sick");
    assert!(sick.all_day);
    assert_eq!(sick.start, utc("2026-03-25T00:00:00Z"));
    assert_eq!(sick.end, utc("2026-03-26T00:00:00Z"));

    assert_eq!(
        starts(&events, "1:1 Priya"),
        vec![
            utc("2026-03-19T09:30:00Z"),
            utc("2026-04-02T08:30:00Z"),
            utc("2026-04-16T08:30:00Z"),
            utc("2026-04-30T08:30:00Z"),
        ]
    );
    let one_on_one = events.iter().find(|e| e.title.starts_with("1:1")).unwrap();
    assert_eq!(
        one_on_one.link.as_ref().map(|l| l.provider),
        Some(Provider::Webex)
    );

    assert_eq!(
        starts(&events, "Annual planning"),
        vec![utc("2026-06-15T17:00:00Z")]
    );
}

#[test]
fn os_export_with_southern_hemisphere_dst() {
    let (cal, events) = run(
        &fixture("apple_export.ics"),
        Tz::UTC,
        window("2026-01-01T00:00:00Z", "2027-01-01T08:00:00Z"),
        "",
    );
    assert_eq!(cal.name.as_deref(), Some("Home"));
    assert_eq!(cal.warnings, 0, "{:?}", cal.warning_messages);
    let custom = cal
        .zones
        .iter()
        .find(|z| z.tzid == "Sydney Custom")
        .unwrap();
    assert_eq!(custom.how, ZoneResolution::MatchedRules);
    assert_eq!(custom.zone_name, "Australia/Sydney");

    assert_eq!(
        starts(&events, "Sydney standup"),
        vec![
            utc("2026-03-26T22:00:00Z"),
            utc("2026-04-02T22:00:00Z"),
            utc("2026-04-09T23:00:00Z"),
            utc("2026-04-16T23:00:00Z"),
        ]
    );
    assert_eq!(
        starts(&events, "Spring check-in"),
        vec![
            utc("2026-09-28T00:00:00Z"),
            utc("2026-10-04T23:00:00Z"),
            utc("2026-10-11T23:00:00Z"),
        ]
    );
    let checkin = events
        .iter()
        .find(|e| e.title == "Spring check-in")
        .unwrap();
    assert_eq!(
        checkin.link.as_ref().map(|l| l.provider),
        Some(Provider::Zoom)
    );

    assert_eq!(
        starts(&events, "Family call"),
        vec![
            utc("2026-04-01T18:00:00Z"),
            utc("2026-04-03T18:00:00Z"),
            utc("2026-04-15T18:00:00Z"),
            utc("2026-04-29T18:00:00Z"),
        ]
    );
    let call = events.iter().find(|e| e.title == "Family call").unwrap();
    assert_eq!(
        call.link.as_ref().map(|l| l.url.as_str()),
        Some("https://facetime.apple.com/join#v=1&p=AbCdEfGh123&k=XyZ987")
    );

    let thanksgiving = one(&events, "Thanksgiving");
    assert!(thanksgiving.all_day);
    assert_eq!(thanksgiving.start, utc("2026-11-26T00:00:00Z"));
    assert_eq!(thanksgiving.id, "THANKSGIVING-US_20261126");

    assert_eq!(
        starts(&events, "Month end close"),
        vec![
            utc("2026-01-31T20:00:00Z"),
            utc("2026-03-31T19:00:00Z"),
            utc("2026-05-31T19:00:00Z"),
            utc("2026-07-31T19:00:00Z"),
            utc("2026-08-31T19:00:00Z"),
            utc("2026-10-31T19:00:00Z"),
            utc("2026-12-31T20:00:00Z"),
        ]
    );
    let last_workdays: Vec<NaiveDate> = events
        .iter()
        .filter(|e| e.title == "Last workday drinks")
        .map(|e| {
            e.start
                .with_timezone(&Tz::America__Los_Angeles)
                .date_naive()
        })
        .collect();
    let expected: Vec<NaiveDate> = [
        (1, 30),
        (2, 27),
        (3, 31),
        (4, 30),
        (5, 29),
        (6, 30),
        (7, 31),
        (8, 31),
        (9, 30),
        (10, 30),
        (11, 30),
        (12, 31),
    ]
    .iter()
    .map(|(m, d)| NaiveDate::from_ymd_opt(2026, *m, *d).unwrap())
    .collect();
    assert_eq!(last_workdays, expected);
}

#[test]
fn malformed_feed_never_panics_and_keeps_good_events() {
    let (cal, events) = run(
        &fixture("malformed.ics"),
        Tz::Europe__Paris,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(cal.name.as_deref(), Some("Broken, but alive"));
    assert!(
        cal.warnings >= 10,
        "{} {:?}",
        cal.warnings,
        cal.warning_messages
    );
    let ids: Vec<&str> = events.iter().map(|e| e.id.as_str()).collect();
    for (index, uid) in [
        "bad-rule",
        "unknown-tz",
        "negative",
        "backwards",
        "until-before",
        "dupe",
        "dupe#2",
        "quoted",
        "unclosed",
    ]
    .into_iter()
    .enumerate()
    {
        assert!(ids.contains(&uid), "missing expected event {index}");
    }
    assert!(!ids.contains(&"no-start"));
    assert!(!ids.contains(&"bad-date"));
    let seconds: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| e.title == "Runaway rule")
        .collect();
    assert_eq!(seconds.len(), 1);
    assert_eq!(seconds[0].start, utc("2026-03-16T00:00:00Z"));
    assert!(
        cal.warning_messages
            .iter()
            .any(|w| w.contains("FREQ=SECONDLY")),
        "{:?}",
        cal.warning_messages
    );

    let unknown = events.iter().find(|e| e.id == "unknown-tz").unwrap();
    assert_eq!(unknown.start, utc("2026-03-11T08:00:00Z"));
    let negative = events.iter().find(|e| e.id == "negative").unwrap();
    assert_eq!(negative.end - negative.start, Duration::minutes(30));
    let backwards = events.iter().find(|e| e.id == "backwards").unwrap();
    assert_eq!(backwards.end - backwards.start, Duration::minutes(30));
    let quoted = events.iter().find(|e| e.id == "quoted").unwrap();
    assert!(quoted.attendees.is_empty());
    assert_eq!(
        quoted.organizer.as_ref().and_then(|o| o.email.as_deref()),
        Some("fine@example.com")
    );
}

#[test]
fn recurrence_shapes() {
    let w = window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z");
    let cases: &[(&str, &str, &[&str])] = &[
        (
            "daily interval",
            "DTSTART:20260105T100000Z\r\nRRULE:FREQ=DAILY;INTERVAL=3;COUNT=4\r\n",
            &[
                "2026-01-05T10:00:00Z",
                "2026-01-08T10:00:00Z",
                "2026-01-11T10:00:00Z",
                "2026-01-14T10:00:00Z",
            ],
        ),
        (
            "weekly byday until date",
            "DTSTART;VALUE=DATE:20260106\r\nRRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20260115\r\n",
            &[
                "2026-01-06T00:00:00Z",
                "2026-01-08T00:00:00Z",
                "2026-01-13T00:00:00Z",
                "2026-01-15T00:00:00Z",
            ],
        ),
        (
            "monthly last day",
            "DTSTART:20260131T090000Z\r\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3\r\n",
            &[
                "2026-01-31T09:00:00Z",
                "2026-02-28T09:00:00Z",
                "2026-03-31T09:00:00Z",
            ],
        ),
        (
            "monthly by day of month",
            "DTSTART:20260115T090000Z\r\nRRULE:FREQ=MONTHLY;COUNT=3\r\n",
            &[
                "2026-01-15T09:00:00Z",
                "2026-02-15T09:00:00Z",
                "2026-03-15T09:00:00Z",
            ],
        ),
        (
            "monthly nth weekday from the end",
            "DTSTART:20260126T170000Z\r\nRRULE:FREQ=MONTHLY;BYDAY=-1MO;COUNT=3\r\n",
            &[
                "2026-01-26T17:00:00Z",
                "2026-02-23T17:00:00Z",
                "2026-03-30T17:00:00Z",
            ],
        ),
        (
            "yearly leap day",
            "DTSTART:20240229T120000Z\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29\r\n",
            &[],
        ),
        (
            "yearly",
            "DTSTART:20200704T160000Z\r\nRRULE:FREQ=YEARLY\r\n",
            &["2026-07-04T16:00:00Z"],
        ),
        (
            "exdate as date on timed series",
            "DTSTART:20260105T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;VALUE=DATE:20260106\r\n",
            &["2026-01-05T10:00:00Z", "2026-01-07T10:00:00Z"],
        ),
        (
            "exdate list with utc instants on zoned series",
            "DTSTART;TZID=Europe/Berlin:20260105T100000\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE:20260106T090000Z,20260107T090000Z\r\n",
            &["2026-01-05T09:00:00Z", "2026-01-08T09:00:00Z"],
        ),
        (
            "rdate period",
            "DTSTART:20260105T100000Z\r\nRDATE;VALUE=PERIOD:20260110T150000Z/20260110T160000Z\r\n",
            &["2026-01-05T10:00:00Z", "2026-01-10T15:00:00Z"],
        ),
        (
            "all day exdate",
            "DTSTART;VALUE=DATE:20260105\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;VALUE=DATE:20260106\r\n",
            &["2026-01-05T00:00:00Z", "2026-01-07T00:00:00Z"],
        ),
        (
            "dtstart off pattern still counts",
            "DTSTART:20260105T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=2\r\n",
            &[
                "2026-01-05T10:00:00Z",
                "2026-01-07T10:00:00Z",
                "2026-01-14T10:00:00Z",
            ],
        ),
    ];
    for (name, lines, expected) in cases {
        let text = event(&format!("UID:{name}\r\nSUMMARY:{name}\r\n{lines}"));
        let (cal, events) = run(&text, Tz::UTC, w.clone(), "");
        assert_eq!(cal.warnings, 0, "{name}: {:?}", cal.warning_messages);
        let expected: Vec<DateTime<Utc>> = expected.iter().map(|s| utc(s)).collect();
        assert_eq!(starts(&events, name), expected, "{name}");
    }

    let leap = event(
        "UID:leap\r\nSUMMARY:leap\r\nDTSTART:20240229T120000Z\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29\r\n",
    );
    let (_, events) = run(
        &leap,
        Tz::UTC,
        window("2024-01-01T00:00:00Z", "2033-01-01T00:00:00Z"),
        "",
    );
    assert_eq!(
        starts(&events, "leap"),
        vec![
            utc("2024-02-29T12:00:00Z"),
            utc("2028-02-29T12:00:00Z"),
            utc("2032-02-29T12:00:00Z")
        ]
    );
}

#[test]
fn overrides_move_instances_across_the_window_edge() {
    let text = wrap(
        "BEGIN:VEVENT\r\nUID:s1\r\nSUMMARY:Series\r\nDTSTART:20260105T100000Z\r\nDTEND:20260105T110000Z\r\nRRULE:FREQ=DAILY;COUNT=10\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s1\r\nSUMMARY:Pulled in\r\nRECURRENCE-ID:20260112T100000Z\r\nDTSTART:20260107T150000Z\r\nDTEND:20260107T160000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:s1\r\nSUMMARY:Pushed out\r\nRECURRENCE-ID:20260106T100000Z\r\nDTSTART:20260120T100000Z\r\nDTEND:20260120T110000Z\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:orphan\r\nSUMMARY:Only instance\r\nRECURRENCE-ID;TZID=America/New_York:20260108T090000\r\nDTSTART;TZID=America/New_York:20260108T093000\r\nEND:VEVENT\r\n",
    );
    let (_, events) = run(
        &text,
        Tz::UTC,
        window("2026-01-05T00:00:00Z", "2026-01-09T00:00:00Z"),
        "",
    );
    let titles: Vec<(&str, &str)> = events
        .iter()
        .map(|e| (e.title.as_str(), e.id.as_str()))
        .collect();
    assert_eq!(
        titles,
        vec![
            ("Series", "s1_20260105T100000Z"),
            ("Series", "s1_20260107T100000Z"),
            ("Pulled in", "s1_20260112T100000Z"),
            ("Series", "s1_20260108T100000Z"),
            ("Only instance", "orphan_20260108T140000Z"),
        ]
    );
    let cancelled_series = wrap(
        "BEGIN:VEVENT\r\nUID:gone\r\nSUMMARY:Gone\r\nSTATUS:CANCELLED\r\nDTSTART:20260105T100000Z\r\nRRULE:FREQ=DAILY;COUNT=5\r\nEND:VEVENT\r\n\
BEGIN:VEVENT\r\nUID:gone\r\nSUMMARY:Gone moved\r\nRECURRENCE-ID:20260106T100000Z\r\nDTSTART:20260106T120000Z\r\nEND:VEVENT\r\n",
    );
    let (_, gone) = run(
        &cancelled_series,
        Tz::UTC,
        window("2026-01-05T00:00:00Z", "2026-01-09T00:00:00Z"),
        "",
    );
    assert!(gone.is_empty(), "{gone:?}");
    let orphan = events.iter().find(|e| e.id.starts_with("orphan")).unwrap();
    assert_eq!(orphan.series_id.as_deref(), Some("orphan"));
    assert_eq!(orphan.start, utc("2026-01-08T14:30:00Z"));
}

#[test]
fn dst_in_both_hemispheres_keeps_local_time() {
    let cases: &[(&str, &str, &[&str])] = &[
        (
            "America/New_York",
            "20260302T090000",
            &[
                "2026-03-02T14:00:00Z",
                "2026-03-09T13:00:00Z",
                "2026-10-26T13:00:00Z",
                "2026-11-02T14:00:00Z",
            ],
        ),
        (
            "Europe/London",
            "20260323T090000",
            &[
                "2026-03-23T09:00:00Z",
                "2026-03-30T08:00:00Z",
                "2026-10-19T08:00:00Z",
                "2026-10-26T09:00:00Z",
            ],
        ),
        (
            "Pacific/Auckland",
            "20260330T080000",
            &[
                "2026-03-29T19:00:00Z",
                "2026-04-05T20:00:00Z",
                "2026-09-20T20:00:00Z",
                "2026-09-27T19:00:00Z",
            ],
        ),
        (
            "America/Sao_Paulo",
            "20260302T090000",
            &["2026-03-02T12:00:00Z", "2026-03-09T12:00:00Z"],
        ),
    ];
    for (zone, start, expected) in cases {
        let text = event(&format!(
            "UID:w\r\nSUMMARY:Weekly\r\nDTSTART;TZID={zone}:{start}\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY\r\n"
        ));
        let (_, events) = run(
            &text,
            Tz::UTC,
            window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
            "",
        );
        let tz: Tz = zone.parse().unwrap();
        for e in &events {
            let local = e.start.with_timezone(&tz);
            assert_eq!(
                local.format("%H:%M").to_string(),
                format!("{}:{}", &start[9..11], &start[11..13]),
                "{zone}"
            );
            assert_eq!(e.end - e.start, Duration::hours(1), "{zone}");
        }
        for want in *expected {
            assert!(
                events.iter().any(|e| e.start == utc(want)),
                "{zone} missing {want}"
            );
        }
    }
}

#[test]
fn floating_times_use_the_caller_zone_and_gaps_move_forward() {
    let text = event("UID:f\r\nSUMMARY:Floating\r\nDTSTART:20260310T090000\r\n");
    let (_, events) = run(
        &text,
        Tz::Asia__Tokyo,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(events[0].start, utc("2026-03-10T00:00:00Z"));
    assert_eq!(events[0].end, utc("2026-03-10T00:30:00Z"));

    let gap = event(
        "UID:g\r\nSUMMARY:Gap\r\nDTSTART;TZID=America/New_York:20260308T023000\r\nDTEND;TZID=America/New_York:20260308T033000\r\n",
    );
    let (_, events) = run(
        &gap,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(events[0].start, utc("2026-03-08T07:30:00Z"));
    assert_eq!(events[0].end, utc("2026-03-08T08:30:00Z"));
}

#[test]
fn all_day_events_are_zone_independent() {
    let text = event(
        "UID:a\r\nSUMMARY:Conference\r\nDTSTART;VALUE=DATE:20260415\r\nDTEND;VALUE=DATE:20260417\r\n",
    );
    let w = window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z");
    let (_, la) = run(&text, Tz::America__Los_Angeles, w.clone(), "");
    let (_, tokyo) = run(&text, Tz::Asia__Tokyo, w, "");
    assert_eq!(la, tokyo);
    assert_eq!(la[0].start, utc("2026-04-15T00:00:00Z"));

    let filter = Filter {
        hide_all_day: false,
        ..Filter::default()
    };
    let agenda = Agenda::new(la, &filter);
    for tz in [
        Tz::America__Los_Angeles,
        Tz::Asia__Tokyo,
        Tz::Pacific__Kiritimati,
        Tz::Pacific__Pago_Pago,
    ] {
        let on = |d: u32| {
            agenda
                .for_day(NaiveDate::from_ymd_opt(2026, 4, d).unwrap(), tz)
                .len()
        };
        assert_eq!((on(14), on(15), on(16), on(17)), (0, 1, 1, 0), "{tz}");
    }

    let no_end = event("UID:b\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260415\r\n");
    let (_, events) = run(
        &no_end,
        Tz::UTC,
        window("2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"),
        "",
    );
    assert_eq!(events[0].end - events[0].start, Duration::days(1));
}

#[test]
fn folded_and_escaped_lines() {
    let text = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20260310T090000Z\nSUMMARY:Caf\u{e9} \\, r\u{e9}sum\u{e9}\\; plan\n\t ning \\\\ notes\nDESCRIPTION;LANGUAGE=en:Line one\\nLine two\\NLine three\nLOCATION:Room \"A\"\\, floor 2\nEND:VEVENT\nEND:VCALENDAR";
    let (_, events) = run(
        text,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(
        events[0].title,
        "Caf\u{e9} , r\u{e9}sum\u{e9}; plan ning \\ notes"
    );
    assert_eq!(
        events[0].description.as_deref(),
        Some("Line one\nLine two\nLine three")
    );
    assert_eq!(events[0].location.as_deref(), Some("Room \"A\", floor 2"));
}

#[test]
fn folds_inside_multibyte_characters_are_repaired_from_bytes() {
    let mut bytes =
        b"BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTART:20260310T090000Z\r\nSUMMARY:Caf"
            .to_vec();
    bytes.push(0xc3);
    bytes.extend_from_slice(b"\r\n ");
    bytes.push(0xa9);
    bytes.extend_from_slice(b" chat\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
    let cal = cap_calendar::ics::parse_calendar_bytes(&bytes, &opts(Tz::UTC));
    let events = expand(
        &cal,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        &[],
    );
    assert_eq!(events[0].title, "Caf\u{e9} chat");
}

#[test]
fn expansion_is_bounded() {
    let daily = event("UID:d\r\nSUMMARY:Daily\r\nDTSTART:19900101T090000Z\r\nRRULE:FREQ=DAILY\r\n");
    let (_, events) = run(
        &daily,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(events.len(), 31);

    let cal = parse_calendar(
        &daily,
        &ParseOptions {
            max_instances_per_series: 10,
            ..opts(Tz::UTC)
        },
    );
    let events = expand(
        &cal,
        window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
        &[],
    );
    assert_eq!(events.len(), 10);

    let started = std::time::Instant::now();
    let (_, far) = run(
        &daily,
        Tz::UTC,
        window("2900-01-01T00:00:00Z", "2900-02-01T00:00:00Z"),
        "",
    );
    assert!(far.len() <= 31);
    assert!(started.elapsed() < std::time::Duration::from_secs(10));

    let (_, empty) = run(
        &daily,
        Tz::UTC,
        utc("2026-03-02T00:00:00Z")..utc("2026-03-01T00:00:00Z"),
        "",
    );
    assert!(empty.is_empty());
}

#[test]
fn self_detection_and_conference_properties() {
    let text = event(
        "UID:c\r\nSUMMARY:Teams via property\r\nDTSTART:20260310T090000Z\r\nORGANIZER;CN=Me:mailto:Me@Example.com\r\nATTENDEE;PARTSTAT=ACCEPTED;CN=Other:mailto:other@example.com\r\nX-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_PROP%40thread.v2/0\r\nDESCRIPTION:Backup https://zoom.us/j/1234567890\r\n",
    );
    let (_, events) = run(
        &text,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "me@example.com",
    );
    let e = &events[0];
    assert!(e.organizer.as_ref().unwrap().is_self);
    assert_eq!(e.self_response, Response::Accepted);
    assert_eq!(e.link.as_ref().map(|l| l.provider), Some(Provider::Teams));
    assert!(e.has_participants());
}

#[test]
fn events_survive_a_json_round_trip() {
    let (_, events) = run(
        &fixture("google_export.ics"),
        Tz::UTC,
        window("2026-02-20T00:00:00Z", "2026-04-10T00:00:00Z"),
        "me@acme.example",
    );
    let json = serde_json::to_string(&events).unwrap();
    assert!(json.contains("\"selfResponse\":\"accepted\""));
    assert!(json.contains("\"meetingId\":\"abc-defg-hij\""));
    assert!(json.contains("\"provider\":\"google-meet\""));
    let back: Vec<CalendarEvent> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, events);
    let partial: CalendarEvent =
        serde_json::from_str("{\"id\":\"x\",\"title\":\"Old cache\"}").unwrap();
    assert_eq!(partial.id, "x");
    assert_eq!(partial.self_response, Response::Unknown);
}

#[test]
fn hourly_series_started_years_ago_has_instances_in_the_window() {
    let text =
        event("UID:h\r\nSUMMARY:Hourly\r\nDTSTART:20150101T090000Z\r\nRRULE:FREQ=HOURLY\r\n");
    let (_, events) = run(
        &text,
        Tz::UTC,
        window("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"),
        "",
    );
    assert_eq!(events.len(), 24);
    assert_eq!(events[0].start, utc("2026-09-01T00:00:00Z"));
    assert_eq!(events[0].id, "h_20260901T000000Z");
}

#[test]
fn durations_follow_rfc_5545_across_dst() {
    let ny = |s: &str| {
        NaiveDate::parse_from_str(&s[..8], "%Y%m%d")
            .unwrap()
            .and_hms_opt(s[9..11].parse().unwrap(), s[11..13].parse().unwrap(), 0)
            .unwrap()
            .and_local_timezone(Tz::America__New_York)
            .unwrap()
            .with_timezone(&Utc)
    };
    let cases: &[(&str, &str, &str)] = &[
        ("spring nominal day", "20260307T120000", "DURATION:P1D"),
        ("spring exact day", "20260307T120000", "DURATION:PT24H"),
        ("fall nominal day", "20261031T120000", "DURATION:P1D"),
        ("fall exact day", "20261031T120000", "DURATION:PT24H"),
        ("fall mixed", "20261031T120000", "DURATION:P1DT1H"),
    ];
    let expected_end = [
        ny("20260308T120000"),
        ny("20260308T130000"),
        ny("20261101T120000"),
        ny("20261101T110000"),
        ny("20261101T130000"),
    ];
    for ((name, start, duration), want) in cases.iter().zip(expected_end) {
        let text = event(&format!(
            "UID:{name}\r\nSUMMARY:{name}\r\nDTSTART;TZID=America/New_York:{start}\r\n{duration}\r\n"
        ));
        let (_, events) = run(
            &text,
            Tz::UTC,
            window("2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"),
            "",
        );
        let e = one(&events, name);
        assert_eq!(e.start, ny(start), "{name}");
        assert_eq!(e.end, want, "{name}");
    }

    let spring = event(
        "UID:s\r\nSUMMARY:Late show\r\nDTSTART;TZID=America/New_York:20260307T230000\r\nDTEND;TZID=America/New_York:20260308T040000\r\nRRULE:FREQ=DAILY;COUNT=3\r\n",
    );
    let (_, events) = run(
        &spring,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-03-31T00:00:00Z"),
        "",
    );
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].end, ny("20260308T040000"));
    for e in &events {
        assert_eq!(e.end - e.start, Duration::hours(4), "{}", e.id);
    }
    assert_eq!(events[1].end, ny("20260309T030000"));

    let fall = event(
        "UID:f\r\nSUMMARY:Night shift\r\nDTSTART;TZID=America/New_York:20261031T220000\r\nDTEND;TZID=America/New_York:20261101T060000\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\n",
    );
    let (_, events) = run(
        &fall,
        Tz::UTC,
        window("2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"),
        "",
    );
    assert_eq!(events.len(), 2);
    for e in &events {
        assert_eq!(e.end - e.start, Duration::hours(9), "{}", e.id);
    }
    assert_eq!(events[1].end, ny("20261108T070000"));

    let all_day = event(
        "UID:a\r\nSUMMARY:Offsite\r\nDTSTART;VALUE=DATE:20260307\r\nDTEND;VALUE=DATE:20260309\r\nRRULE:FREQ=WEEKLY;COUNT=2\r\n",
    );
    let (_, events) = run(
        &all_day,
        Tz::UTC,
        window("2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z"),
        "",
    );
    assert_eq!(events.len(), 2);
    for e in &events {
        assert_eq!(e.end - e.start, Duration::days(2), "{}", e.id);
    }
}
