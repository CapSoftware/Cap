use std::collections::HashSet;

use cap_calendar::agenda::{DEFAULT_LEAD, dedupe, reminder_key};
use cap_calendar::{
    Agenda, CalendarEvent, EventStatus, Filter, MeetingLink, Person, Provider, Response,
    SourceKind, Tz, due_reminders, next_wake,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};

fn utc(s: &str) -> DateTime<Utc> {
    s.parse().unwrap_or_else(|e| panic!("{s}: {e}"))
}

fn ev(id: &str, title: &str, start: &str, minutes: i64) -> CalendarEvent {
    let start = utc(start);
    CalendarEvent {
        id: id.to_string(),
        calendar_id: "cal".to_string(),
        source: SourceKind::Google,
        title: title.to_string(),
        start,
        end: start + Duration::minutes(minutes),
        ..CalendarEvent::default()
    }
}

fn zoom(id: &str) -> Option<MeetingLink> {
    Some(MeetingLink {
        provider: Provider::Zoom,
        url: format!("https://zoom.us/j/{id}"),
        meeting_id: Some(id.to_string()),
    })
}

fn guest(email: &str) -> Person {
    Person {
        email: Some(email.to_string()),
        ..Person::default()
    }
}

fn ids(events: &[&CalendarEvent]) -> Vec<String> {
    events.iter().map(|e| e.id.clone()).collect()
}

#[test]
fn dedupes_the_same_meeting_from_two_sources() {
    let google = CalendarEvent {
        link: zoom("84512345678"),
        attendees: vec![guest("a@x.example"), guest("b@x.example")],
        ..ev("g1", "Globex renewal", "2026-03-10T17:00:00Z", 45)
    };
    let ics = CalendarEvent {
        source: SourceKind::Ics,
        calendar_id: "feed".to_string(),
        link: zoom("84512345678"),
        description: Some("From the feed".to_string()),
        ..ev(
            "feed-1",
            "Renewal call (Globex)",
            "2026-03-10T17:00:00Z",
            45,
        )
    };
    let next_week = CalendarEvent {
        link: zoom("84512345678"),
        ..ev("g2", "Globex renewal", "2026-03-17T17:00:00Z", 45)
    };
    let merged = dedupe(vec![ics, google, next_week]);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "g1");
    assert_eq!(merged[0].description.as_deref(), Some("From the feed"));
    assert_eq!(merged[1].id, "g2");

    let system = CalendarEvent {
        source: SourceKind::System,
        location: Some("Room 4".to_string()),
        ..ev("s1", "Weekly  Sync", "2026-03-11T09:00:00Z", 30)
    };
    let outlook = CalendarEvent {
        source: SourceKind::Microsoft,
        ..ev("m1", "weekly sync!", "2026-03-11T09:00:00Z", 30)
    };
    let different_time = ev("m2", "Weekly sync", "2026-03-11T10:00:00Z", 30);
    let merged = dedupe(vec![system, outlook, different_time]);
    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "m1");
    assert_eq!(merged[0].location.as_deref(), Some("Room 4"));

    let page_overlap = vec![
        ev("same", "Old title", "2026-03-11T09:00:00Z", 30),
        ev("same", "New title", "2026-03-11T09:30:00Z", 30),
    ];
    let merged = dedupe(page_overlap);
    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0].title, "New title");
}

#[test]
fn filters() {
    let declined = CalendarEvent {
        self_response: Response::Declined,
        ..ev("declined", "Declined", "2026-03-10T10:00:00Z", 30)
    };
    let all_day = CalendarEvent {
        all_day: true,
        ..ev("allday", "Holiday", "2026-03-10T00:00:00Z", 24 * 60)
    };
    let cancelled = CalendarEvent {
        status: EventStatus::Cancelled,
        ..ev("cancelled", "Cancelled", "2026-03-10T11:00:00Z", 30)
    };
    let hidden = CalendarEvent {
        calendar_id: "hidden".to_string(),
        ..ev("hidden", "Hidden", "2026-03-10T12:00:00Z", 30)
    };
    let solo = ev("solo", "Solo", "2026-03-10T13:00:00Z", 30);
    let group = CalendarEvent {
        attendees: vec![guest("a@x.example")],
        ..ev("group", "Group", "2026-03-10T14:00:00Z", 30)
    };
    let all = vec![declined, all_day, cancelled, hidden, solo, group];

    let default = Agenda::new(all.clone(), &Filter::default());
    let visible: Vec<&str> = default.events().iter().map(|e| e.id.as_str()).collect();
    assert_eq!(visible, vec!["hidden", "solo", "group"]);

    let strict = Filter {
        hide_without_participants: true,
        hidden_calendar_ids: HashSet::from(["hidden".to_string()]),
        ..Filter::default()
    };
    let strict_agenda = Agenda::new(all.clone(), &strict);
    let visible: Vec<&str> = strict_agenda
        .events()
        .iter()
        .map(|e| e.id.as_str())
        .collect();
    assert_eq!(visible, vec!["group"]);

    let loose = Filter {
        hide_declined: false,
        hide_all_day: false,
        ..Filter::default()
    };
    assert_eq!(Agenda::new(all, &loose).events().len(), 5);
}

#[test]
fn hiding_one_calendar_keeps_a_meeting_another_shown_calendar_has() {
    let google = CalendarEvent {
        calendar_id: "work-google".to_string(),
        link: zoom("84512345678"),
        attendees: vec![guest("a@x.example")],
        ..ev("g1", "Globex renewal", "2026-03-10T17:00:00Z", 45)
    };
    let system = CalendarEvent {
        source: SourceKind::System,
        calendar_id: "work-mac".to_string(),
        link: zoom("84512345678"),
        ..ev("s1", "Globex renewal", "2026-03-10T17:00:00Z", 45)
    };
    let both = vec![google.clone(), system];
    let shown = Agenda::new(both.clone(), &Filter::default());
    assert_eq!(ids(&shown.events().iter().collect::<Vec<_>>()), vec!["g1"]);

    let hide_google = Filter {
        hidden_calendar_ids: HashSet::from(["work-google".to_string()]),
        ..Filter::default()
    };
    let agenda = Agenda::new(both.clone(), &hide_google);
    assert_eq!(
        ids(&agenda.events().iter().collect::<Vec<_>>()),
        vec!["s1"],
        "the copy on the shown calendar stays"
    );

    let hide_both = Filter {
        hidden_calendar_ids: HashSet::from(["work-google".to_string(), "work-mac".to_string()]),
        ..Filter::default()
    };
    assert!(Agenda::new(both, &hide_both).events().is_empty());

    // A decline on the richer copy still hides the meeting.
    let declined = CalendarEvent {
        self_response: Response::Declined,
        ..google
    };
    let system = CalendarEvent {
        source: SourceKind::System,
        calendar_id: "work-mac".to_string(),
        link: zoom("84512345678"),
        ..ev("s1", "Globex renewal", "2026-03-10T17:00:00Z", 45)
    };
    assert!(
        Agenda::new(vec![declined, system], &Filter::default())
            .events()
            .is_empty()
    );
}

#[test]
fn current_next_upcoming_and_days() {
    let events = vec![
        ev("a", "Standup", "2026-03-10T09:00:00Z", 15),
        ev("b", "Long workshop", "2026-03-10T08:00:00Z", 180),
        ev("c", "Lunch", "2026-03-10T12:00:00Z", 60),
        ev("d", "Late", "2026-03-10T23:30:00Z", 60),
        ev("zero", "Zero length", "2026-03-10T15:00:00Z", 0),
    ];
    let agenda = Agenda::new(events, &Filter::default());
    let now = utc("2026-03-10T09:05:00Z");
    assert_eq!(ids(&agenda.current(now)), vec!["a", "b"]);
    assert_eq!(agenda.next(now).map(|e| e.id.as_str()), Some("c"));
    assert_eq!(
        ids(&agenda.upcoming(now, Duration::hours(4))),
        vec!["b", "a", "c"]
    );
    assert_eq!(ids(&agenda.current(utc("2026-03-10T09:15:00Z"))), vec!["b"]);
    assert_eq!(
        ids(&agenda.current(utc("2026-03-10T15:00:30Z"))),
        vec!["zero"]
    );
    assert!(agenda.next(utc("2026-03-11T00:00:00Z")).is_none());

    let day = NaiveDate::from_ymd_opt(2026, 3, 10).unwrap();
    let next_day = NaiveDate::from_ymd_opt(2026, 3, 11).unwrap();
    assert_eq!(agenda.for_day(day, Tz::Europe__London).len(), 5);
    assert_eq!(
        ids(&agenda.for_day(next_day, Tz::Europe__London)),
        vec!["d"]
    );
    assert_eq!(
        ids(&agenda.for_day(day, Tz::Asia__Tokyo)),
        vec!["b", "a", "c"]
    );
    assert_eq!(
        ids(&agenda.for_day(next_day, Tz::Asia__Tokyo)),
        vec!["zero", "d"]
    );
    assert_eq!(agenda.for_day(day, Tz::America__Los_Angeles).len(), 5);
}

#[test]
fn reminder_timing_boundaries() {
    let meeting = ev("m", "Meeting", "2026-03-10T10:00:00Z", 30);
    let events = vec![meeting.clone()];
    let none = HashSet::new();
    let due = |now: &str, lead: Duration| due_reminders(&events, utc(now), lead, &none);

    assert!(due("2026-03-10T09:58:59Z", DEFAULT_LEAD).is_empty());
    let exactly = due("2026-03-10T09:59:00Z", DEFAULT_LEAD);
    assert_eq!(exactly.len(), 1);
    assert_eq!(exactly[0].fire_at, utc("2026-03-10T09:59:00Z"));
    assert_eq!(exactly[0].key, reminder_key(&meeting));
    assert_eq!(due("2026-03-10T10:05:00Z", DEFAULT_LEAD).len(), 1);
    assert_eq!(due("2026-03-10T10:29:59Z", DEFAULT_LEAD).len(), 1);
    assert!(due("2026-03-10T10:30:00Z", DEFAULT_LEAD).is_empty());
    assert!(due("2026-03-10T09:59:59Z", Duration::zero()).is_empty());
    assert_eq!(due("2026-03-10T10:00:00Z", Duration::zero()).len(), 1);
    assert_eq!(due("2026-03-10T09:45:00Z", Duration::minutes(15)).len(), 1);
    assert_eq!(due("2026-03-10T09:45:00Z", Duration::hours(2)).len(), 1);
    assert!(due("2026-03-10T09:44:59Z", Duration::hours(2)).is_empty());
    assert!(due("2026-03-10T09:59:30Z", Duration::seconds(-30)).is_empty());

    let notified = HashSet::from([reminder_key(&meeting)]);
    assert!(
        due_reminders(
            &events,
            utc("2026-03-10T09:59:30Z"),
            DEFAULT_LEAD,
            &notified
        )
        .is_empty()
    );

    let moved = CalendarEvent {
        start: utc("2026-03-10T11:00:00Z"),
        end: utc("2026-03-10T11:30:00Z"),
        ..meeting
    };
    let after_move = due_reminders(
        &[moved],
        utc("2026-03-10T10:59:00Z"),
        DEFAULT_LEAD,
        &notified,
    );
    assert_eq!(after_move.len(), 1);
}

#[test]
fn reminders_skip_noise_and_order_ties() {
    let plain = ev("plain", "Plain", "2026-03-10T10:00:00Z", 30);
    let linked = CalendarEvent {
        link: zoom("1234567890"),
        attendees: vec![guest("a@x.example")],
        ..ev("linked", "Linked", "2026-03-10T10:00:00Z", 30)
    };
    let crowded = CalendarEvent {
        link: zoom("1234567891"),
        attendees: vec![
            guest("a@x.example"),
            guest("b@x.example"),
            guest("c@x.example"),
        ],
        ..ev("crowded", "Crowded", "2026-03-10T10:00:00Z", 30)
    };
    let declined = CalendarEvent {
        self_response: Response::Declined,
        ..ev("declined", "Declined", "2026-03-10T10:00:00Z", 30)
    };
    let cancelled = CalendarEvent {
        status: EventStatus::Cancelled,
        ..ev("cancelled", "Cancelled", "2026-03-10T10:00:00Z", 30)
    };
    let all_day = CalendarEvent {
        all_day: true,
        ..ev("allday", "All day", "2026-03-10T00:00:00Z", 24 * 60)
    };
    let later = ev("later", "Later", "2026-03-10T10:20:00Z", 30);
    let events = vec![plain, linked, declined, cancelled, all_day, crowded, later];
    let due = due_reminders(
        &events,
        utc("2026-03-10T09:59:10Z"),
        DEFAULT_LEAD,
        &HashSet::new(),
    );
    let order: Vec<&str> = due.iter().map(|r| r.event.id.as_str()).collect();
    assert_eq!(order, vec!["crowded", "linked", "plain"]);

    assert_eq!(
        next_wake(&events, utc("2026-03-10T09:58:00Z"), DEFAULT_LEAD),
        Some(utc("2026-03-10T09:59:00Z"))
    );
    assert_eq!(
        next_wake(&events, utc("2026-03-10T09:59:00Z"), DEFAULT_LEAD),
        Some(utc("2026-03-10T10:19:00Z"))
    );
    assert_eq!(
        next_wake(&events, utc("2026-03-10T10:19:00Z"), DEFAULT_LEAD),
        None
    );
    assert_eq!(
        next_wake(&events, utc("2026-03-10T09:00:00Z"), Duration::hours(1)),
        Some(utc("2026-03-10T09:45:00Z"))
    );
    assert_eq!(
        next_wake(&[], utc("2026-03-10T09:00:00Z"), DEFAULT_LEAD),
        None
    );
}

fn permutations<T: Clone>(items: &[T]) -> Vec<Vec<T>> {
    if items.len() <= 1 {
        return vec![items.to_vec()];
    }
    let mut out = Vec::new();
    for i in 0..items.len() {
        let mut rest = items.to_vec();
        let first = rest.remove(i);
        for mut tail in permutations(&rest) {
            tail.insert(0, first.clone());
            out.push(tail);
        }
    }
    out
}

#[test]
fn dedupe_is_the_same_for_every_input_order() {
    let feed = CalendarEvent {
        source: SourceKind::Ics,
        calendar_id: "feed".to_string(),
        link: zoom("84512345678"),
        description: Some("From the feed".to_string()),
        ..ev("feed-1", "Design review", "2026-03-10T17:00:00Z", 45)
    };
    let provider = CalendarEvent {
        link: zoom("84512345678"),
        attendees: vec![guest("a@x.example"), guest("b@x.example")],
        ..ev("g1", "Design review (v2)", "2026-03-10T17:00:00Z", 45)
    };
    let system = CalendarEvent {
        source: SourceKind::System,
        calendar_id: "local".to_string(),
        location: Some("Room 4".to_string()),
        web_url: Some("https://calendar.example/e/1".to_string()),
        ..ev("s1", "design review!", "2026-03-10T17:00:00Z", 45)
    };
    let other = ev("g2", "Design review", "2026-03-10T18:00:00Z", 45);
    let inputs = [feed, provider, system, other];
    let reference = dedupe(inputs.to_vec());
    assert_eq!(reference.len(), 2, "{reference:#?}");
    let merged = &reference[0];
    assert_eq!(merged.id, "g1");
    assert_eq!(merged.attendees.len(), 2);
    assert_eq!(merged.description.as_deref(), Some("From the feed"));
    assert_eq!(merged.location.as_deref(), Some("Room 4"));
    assert_eq!(
        merged.web_url.as_deref(),
        Some("https://calendar.example/e/1")
    );
    assert_eq!(reference[1].id, "g2");
    for order in permutations(&inputs) {
        let ids: Vec<&str> = order.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(dedupe(order.clone()), reference, "order {ids:?}");
    }

    let refreshed = CalendarEvent {
        title: "Design review (final)".to_string(),
        ..inputs[1].clone()
    };
    let with_refresh = [
        inputs[0].clone(),
        inputs[1].clone(),
        inputs[2].clone(),
        refreshed,
    ];
    for order in permutations(&with_refresh[..3]) {
        let mut order = order;
        order.push(with_refresh[3].clone());
        let merged = dedupe(order);
        assert_eq!(merged.len(), 1, "{merged:#?}");
        assert_eq!(merged[0].title, "Design review (final)");
        assert_eq!(merged[0].location.as_deref(), Some("Room 4"));
        assert_eq!(merged[0].description.as_deref(), Some("From the feed"));
    }
}
