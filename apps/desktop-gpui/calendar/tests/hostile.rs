use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use cap_calendar::Tz;
use cap_calendar::ics::{ParseOptions, expand, parse_calendar};
use chrono::{DateTime, Utc};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static SERIAL: Mutex<()> = Mutex::new(());

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(live, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const MB: usize = 1024 * 1024;

fn utc(s: &str) -> DateTime<Utc> {
    s.parse().unwrap()
}

fn feed(n: usize, body: impl Fn(usize) -> String) -> String {
    let mut s = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n");
    for i in 0..n {
        s.push_str(&body(i));
    }
    s.push_str("END:VCALENDAR\r\n");
    s
}

fn vevent(i: usize, lines: &str) -> String {
    format!("BEGIN:VEVENT\r\nUID:e{i}\r\nSUMMARY:Event {i}\r\n{lines}END:VEVENT\r\n")
}

struct Run {
    events: usize,
    elapsed: Duration,
    peak_bytes: usize,
}

fn run(text: &str) -> Run {
    let opts = ParseOptions {
        default_zone: Tz::UTC,
        ..ParseOptions::default()
    };
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let started = Instant::now();
    let cal = parse_calendar(text, &opts);
    let events = expand(
        &cal,
        utc("2026-01-01T00:00:00Z")..utc("2026-03-01T00:00:00Z"),
        &[],
    );
    let elapsed = started.elapsed();
    let peak_bytes = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    Run {
        events: events.len(),
        elapsed,
        peak_bytes,
    }
}

fn check(name: &str, text: &str, max_events: usize, max_peak: usize, max_time: Duration) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = run(text);
    eprintln!(
        "{name}: {} KB feed, {} events, {:?}, peak {} MB",
        text.len() / 1024,
        r.events,
        r.elapsed,
        r.peak_bytes / MB
    );
    assert!(r.events <= max_events, "{name}: {} events", r.events);
    assert!(
        r.peak_bytes <= max_peak,
        "{name}: peak {} MB",
        r.peak_bytes / MB
    );
    assert!(r.elapsed <= max_time, "{name}: took {:?}", r.elapsed);
}

#[test]
fn feed_wide_event_cap_bounds_memory() {
    let text = feed(2_000, |i| {
        vevent(i, "DTSTART:20260101T000000Z\r\nRRULE:FREQ=HOURLY\r\n")
    });
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let r = run(&text);
    eprintln!(
        "hourly x2000: {} KB feed, {} events, {:?}, peak {} MB",
        text.len() / 1024,
        r.events,
        r.elapsed,
        r.peak_bytes / MB
    );
    assert_eq!(r.events, ParseOptions::default().max_events);
    assert!(r.peak_bytes < 160 * MB, "peak {} MB", r.peak_bytes / MB);
}

#[test]
fn sub_hourly_rules_far_before_the_window_are_cheap() {
    let secondly = feed(2_000, |i| {
        vevent(i, "DTSTART:20000101T000000Z\r\nRRULE:FREQ=SECONDLY\r\n")
    });
    check(
        "secondly x2000",
        &secondly,
        2_000,
        32 * MB,
        Duration::from_millis(1_500),
    );
    let minutely = feed(2_000, |i| {
        vevent(i, "DTSTART:20260101T000000Z\r\nRRULE:FREQ=MINUTELY\r\n")
    });
    check(
        "minutely x2000",
        &minutely,
        2_000,
        32 * MB,
        Duration::from_millis(1_500),
    );
}

#[test]
fn hostile_vtimezones_are_bounded() {
    let secondly = feed(2_000, |i| {
        format!(
            "BEGIN:VTIMEZONE\r\nTZID:Zone {i}\r\nBEGIN:STANDARD\r\nDTSTART:20000101T000000\r\nTZOFFSETFROM:+0317\r\nTZOFFSETTO:+0217\r\nRRULE:FREQ=SECONDLY\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:20000101T000000\r\nTZOFFSETFROM:+0217\r\nTZOFFSETTO:+0317\r\nRRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n{}",
            vevent(i, &format!("DTSTART;TZID=Zone {i}:20260110T090000\r\n"))
        )
    });
    check(
        "vtimezone x2000",
        &secondly,
        2_000,
        64 * MB,
        Duration::from_millis(1_500),
    );
    let rules = feed(2_000, |i| {
        format!(
            "BEGIN:VTIMEZONE\r\nTZID:Custom {i}\r\nBEGIN:STANDARD\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:-0400\r\nTZOFFSETTO:-0500\r\nRRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:16010101T020000\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nRRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n"
        )
    });
    check(
        "rule vtimezone x2000",
        &rules,
        0,
        64 * MB,
        Duration::from_millis(1_500),
    );
}

#[test]
fn rules_that_never_match_share_one_budget() {
    for freq in ["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY"] {
        let text = feed(2_000, |i| {
            vevent(
                i,
                &format!(
                    "DTSTART:20250101T090000Z\r\nRRULE:FREQ={freq};BYMONTH=2;BYMONTHDAY=30\r\n"
                ),
            )
        });
        check(
            &format!("impossible {freq} x2000"),
            &text,
            2_000,
            64 * MB,
            Duration::from_millis(1_500),
        );
    }
    let counted = feed(2_000, |i| {
        vevent(
            i,
            "DTSTART:10000101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=4000000000\r\n",
        )
    });
    check(
        "counted from year 1000 x2000",
        &counted,
        2_000,
        64 * MB,
        Duration::from_millis(1_500),
    );
}

#[test]
fn megabytes_of_mixed_hostile_input_finish_quickly() {
    let shapes = [
        "DTSTART:20000101T000000Z\r\nRRULE:FREQ=SECONDLY\r\n",
        "DTSTART:20250101T090000Z\r\nRRULE:FREQ=MONTHLY;BYMONTH=4;BYMONTHDAY=31\r\n",
        "DTSTART:20250101T090000Z\r\nRRULE:FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30\r\n",
        "DTSTART:10000101T090000Z\r\nRRULE:FREQ=DAILY;COUNT=4000000000\r\n",
        "DTSTART:20260101T000000Z\r\nRRULE:FREQ=HOURLY\r\n",
        "DTSTART;TZID=Nowhere/Unknown:20260105T090000\r\nRRULE:FREQ=WEEKLY\r\n",
        "DTSTART:20260105T090000Z\r\nRRULE:FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28;BYHOUR=0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23;BYMINUTE=0,15,30,45\r\n",
    ];
    let text = feed(30_000, |i| vevent(i, shapes[i % shapes.len()]));
    assert!(text.len() > 2 * MB, "{}", text.len());
    check(
        "mixed",
        &text,
        ParseOptions::default().max_events,
        256 * MB,
        Duration::from_millis(3_000),
    );
}

fn expand_all(text: &str) -> (Vec<cap_calendar::CalendarEvent>, Duration, usize) {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let opts = ParseOptions {
        default_zone: Tz::UTC,
        ..ParseOptions::default()
    };
    let baseline = LIVE.load(Ordering::Relaxed);
    PEAK.store(baseline, Ordering::Relaxed);
    let started = Instant::now();
    let cal = parse_calendar(text, &opts);
    let events = expand(
        &cal,
        utc("2026-01-01T00:00:00Z")..utc("2026-03-01T00:00:00Z"),
        &[],
    );
    let elapsed = started.elapsed();
    let peak = PEAK.load(Ordering::Relaxed).saturating_sub(baseline);
    (events, elapsed, peak)
}

#[test]
fn a_huge_description_is_not_copied_to_every_occurrence() {
    let filler = "agenda ".repeat(MB / 7);
    let text = feed(1, |i| {
        vevent(
            i,
            &format!(
                "DTSTART:20260101T000000Z\r\nRRULE:FREQ=HOURLY\r\nDESCRIPTION:{filler}https://zoom.us/j/123456789\r\n"
            ),
        )
    });
    let (events, elapsed, peak) = expand_all(&text);
    eprintln!(
        "1 MB description hourly: {} events, {elapsed:?}, peak {} MB",
        events.len(),
        peak / MB
    );
    assert_eq!(events.len(), 1_000);
    assert!(peak < 128 * MB, "peak {} MB", peak / MB);
    assert!(elapsed < Duration::from_millis(1_500), "took {elapsed:?}");
    for event in &events {
        let link = event
            .link
            .as_ref()
            .expect("the link at the end of the description");
        assert_eq!(link.url, "https://zoom.us/j/123456789");
        assert!(event.description.as_ref().unwrap().len() <= cap_calendar::MAX_TEXT_BYTES);
    }
}

#[test]
fn thousands_of_attendees_on_a_series_are_cheap() {
    let people: String = (0..3_000)
        .map(|n| format!("ATTENDEE;CN=Person {n}:mailto:p{n}@example.com\r\n"))
        .collect();
    let text = feed(1, |i| {
        vevent(
            i,
            &format!("DTSTART:20260101T000000Z\r\nRRULE:FREQ=HOURLY\r\n{people}"),
        )
    });
    let (events, elapsed, peak) = expand_all(&text);
    eprintln!(
        "3000 attendees hourly: {} events, {elapsed:?}, peak {} MB",
        events.len(),
        peak / MB
    );
    assert!(!events.is_empty());
    assert!(peak < 96 * MB, "peak {} MB", peak / MB);
    assert!(elapsed < Duration::from_millis(1_500), "took {elapsed:?}");
    assert!(
        events
            .iter()
            .all(|e| e.attendees.len() == cap_calendar::MAX_ATTENDEES)
    );
}

#[test]
fn a_huge_uid_gives_short_stable_ids() {
    let uid = "u".repeat(MB);
    let text = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:Standup\r\nDTSTART:20260101T090000Z\r\nRRULE:FREQ=DAILY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    );
    let (first, elapsed, peak) = expand_all(&text);
    let (second, _, _) = expand_all(&text);
    eprintln!(
        "1 MB uid daily: {} events, {elapsed:?}, peak {} MB",
        first.len(),
        peak / MB
    );
    assert_eq!(first.len(), 59);
    assert!(peak < 64 * MB, "peak {} MB", peak / MB);
    let ids: Vec<&str> = first.iter().map(|e| e.id.as_str()).collect();
    assert_eq!(
        ids,
        second.iter().map(|e| e.id.as_str()).collect::<Vec<_>>()
    );
    assert!(ids.iter().all(|id| id.len() < 128));
    let unique: std::collections::HashSet<&&str> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len());
    assert!(first.iter().all(|e| e.series_id == first[0].series_id));
}

#[test]
fn bounding_keeps_the_user_among_many_people() {
    use cap_calendar::{CalendarEvent, MAX_ATTENDEES, MAX_TITLE_BYTES, Person, Response};
    let mut attendees: Vec<Person> = (0..MAX_ATTENDEES + 500)
        .map(|n| Person {
            name: Some(format!("Person {n}")),
            email: Some(format!("p{n}@example.com")),
            ..Person::default()
        })
        .collect();
    attendees.push(Person {
        email: Some("me@example.com".into()),
        is_self: true,
        response: Response::Declined,
        ..Person::default()
    });
    let event = CalendarEvent {
        id: "e1".into(),
        title: "é".repeat(MAX_TITLE_BYTES),
        attendees,
        ..CalendarEvent::default()
    }
    .bounded();
    assert_eq!(event.id, "e1");
    assert!(event.title.len() <= MAX_TITLE_BYTES);
    assert!(event.title.chars().all(|c| c == 'é'));
    assert_eq!(event.attendees.len(), MAX_ATTENDEES + 1);
    assert!(
        event
            .attendees
            .iter()
            .any(|p| p.is_self && p.response == Response::Declined)
    );
}

#[test]
fn titles_and_names_lose_control_and_override_characters() {
    let text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:t1\r\nDTSTART:20260105T090000Z\r\n\
        SUMMARY:\u{202e}exe.txt\u{202c} Q3\u{7}\u{1b}[31m review\\nnext \u{200b}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} مرحبا\r\n\
        LOCATION:Room\u{7} 4\r\n\
        ATTENDEE;CN=\"\u{202e}LAHS\u{202c} Mallory\":mailto:m@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    let (events, _, _) = expand_all(text);
    let event = &events[0];
    assert_eq!(
        event.title,
        "exe.txt\u{202c} Q3[31m review next \u{200b}\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} مرحبا"
    );
    assert_eq!(event.location.as_deref(), Some("Room 4"));
    assert_eq!(
        event.attendees[0].name.as_deref(),
        Some("LAHS\u{202c} Mallory")
    );
}

/// Folds a content line at 75 octets, as calendar servers write them.
fn folded(line: &str) -> String {
    let mut out = String::new();
    let mut width = 0;
    for c in line.chars() {
        if width + c.len_utf8() > 74 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += c.len_utf8();
    }
    out + "\r\n"
}

#[test]
fn real_world_invites_keep_everything_people_see() {
    let teams_link = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ZDk3YzE0NzEtMzg1Mi00YjY2LWE0NTItNWQ3ZmE5NmM2ZTgy%40thread.v2/0?context=%7b%22Tid%22%3a%2272f988bf-86f1-41af-91ab-2d7cd011db47%22%2c%22Oid%22%3a%22a1b2c3d4-0000-4000-8000-000000000001%22%7d";
    let dial_in: String = (0..120)
        .map(|n| {
            format!(
                "+1 555-01{:02} {:03},,{:09}# United States, City {n} (Toll)\\n",
                n % 100,
                n,
                400_000_000 + n * 7919
            )
        })
        .collect();
    let teams_body = format!(
        "________________________________________________________________________________\\nMicrosoft Teams meeting\\nJoin on your computer, mobile app or room device\\nClick here to join the meeting<{teams_link}>\\nMeeting ID: 123 456 789 012\\nPasscode: aB3cD4\\nDownload Teams | Join on the web\\nOr call in (audio only)\\n{dial_in}Phone Conference ID: 123 456 789#\\nFind a local number | Reset PIN\\nLearn More | Meeting options\\n{}\\n{teams_link}\\n________________________________________________________________________________",
        "Please read the pre-read before the session. ".repeat(40)
    );
    let zoom_numbers: String = (0..90)
        .map(|n| {
            format!(
                "        +{} {} {} {:04} Country {n}\\n",
                1 + n % 60,
                200 + n,
                555,
                n * 37 % 10_000
            )
        })
        .collect();
    let zoom_body = format!(
        "Hi there,\\n\\nYou are invited to a Zoom meeting.\\n\\nJoin Zoom Meeting\\nhttps://us02web.zoom.us/j/81234567890?pwd=bXlwYXNzd29yZGlzdmVyeWxvbmdhbmRzZWN1cmUx\\n\\nMeeting ID: 812 3456 7890\\nPasscode: 123456\\n\\n---\\n\\nOne tap mobile\\n+16465588656,,81234567890#,,,,*123456# US\\n\\nDial by your location\\n{zoom_numbers}\\nFind your local number: https://us02web.zoom.us/u/kdEFghIJk\\n"
    );
    let people: String = (0..200)
        .map(|n| {
            folded(&format!(
                "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=\"Lastname{n}, Firstname{n} (Platform Engineering)\":mailto:firstname.lastname{n}@example-company.com"
            ))
        })
        .collect();
    let title =
        "Q4 All-hands: product roadmap, hiring plan and Q&A (please join on time) \u{1F680}";
    let text = format!(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n\
         BEGIN:VEVENT\r\nUID:040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5000000000000000010000000F1E2D3C4B5A69788\r\n{}DTSTART:20260105T170000Z\r\nDTEND:20260105T180000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO\r\n{}{}ORGANIZER;CN=\"Organizer, Pat\":mailto:pat.organizer@example-company.com\r\n{people}END:VEVENT\r\n\
         BEGIN:VEVENT\r\nUID:zoom-1\r\nSUMMARY:Customer call\r\nDTSTART:20260106T150000Z\r\nDTEND:20260106T153000Z\r\n{}END:VEVENT\r\n\
         END:VCALENDAR\r\n",
        folded(&format!("SUMMARY:{title}")),
        folded("LOCATION:Microsoft Teams Meeting; Conference Room 4B (Building 2, Floor 3)"),
        folded(&format!("DESCRIPTION:{teams_body}")),
        folded(&format!("DESCRIPTION:{zoom_body}")),
    );
    assert!(teams_body.len() > cap_calendar::MAX_TEXT_BYTES * 2);
    let (events, _, _) = expand_all(&text);
    let all_hands: Vec<_> = events.iter().filter(|e| e.title == title).collect();
    assert_eq!(all_hands.len(), 8);
    for event in &all_hands {
        assert_eq!(event.link.as_ref().unwrap().url, teams_link);
        assert_eq!(
            event.location.as_deref(),
            Some("Microsoft Teams Meeting; Conference Room 4B (Building 2, Floor 3)")
        );
        assert_eq!(event.attendees.len(), 200);
        for (n, person) in event.attendees.iter().enumerate() {
            assert_eq!(
                person.name.as_deref(),
                Some(format!("Lastname{n}, Firstname{n} (Platform Engineering)").as_str())
            );
            assert_eq!(
                person.email.as_deref(),
                Some(format!("firstname.lastname{n}@example-company.com").as_str())
            );
        }
        assert_eq!(
            event.organizer.as_ref().unwrap().name.as_deref(),
            Some("Organizer, Pat")
        );
        assert!(event.id.starts_with("040000008200E00074C5B7101A82E008"));
    }
    let zoom = events.iter().find(|e| e.title == "Customer call").unwrap();
    assert_eq!(
        zoom.link.as_ref().unwrap().url,
        "https://us02web.zoom.us/j/81234567890?pwd=bXlwYXNzd29yZGlzdmVyeWxvbmdhbmRzZWN1cmUx"
    );
}
