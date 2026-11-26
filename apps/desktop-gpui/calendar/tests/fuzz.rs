use cap_calendar::google::parse_google_events;
use cap_calendar::graph::parse_graph_events;
use cap_calendar::ics::{ParseOptions, expand, parse_calendar, parse_calendar_bytes};
use cap_calendar::oauth::{parse_redirect, parse_token_response};
use cap_calendar::{Agenda, Filter, Tz, due_reminders, find_meeting_link, next_wake};
use chrono::{DateTime, Duration, Utc};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next() % n as u64) as usize
    }
}

const NOISE: &[&[u8]] = &[
    b":",
    b";",
    b"\r\n",
    b"\n ",
    b"\"",
    b",",
    b"\\",
    b"Z",
    b"T",
    b"0",
    b"9",
    b"=",
    b"-",
    b"/",
    b"\xc3\xa9",
    b"\xff",
    b"\0",
    b"BEGIN:VEVENT\n",
    b"END:VEVENT\n",
    b"RRULE:FREQ=SECONDLY\n",
    b"RRULE:FREQ=DAILY;BYSETPOS=-1;BYDAY=MO\n",
    b"DTSTART:00000101T000000Z\n",
    b"DTSTART:99991231T235959Z\n",
    b"TZID=",
    b"%",
    b"&amp;",
    b"{",
    b"}",
    b"[",
    b"]",
    b"null",
    b"\"dateTime\":\"",
    b"https://",
    b"zoom.us/j/",
    b"meet.google.com/",
];

fn mutate(rng: &mut Rng, input: &[u8]) -> Vec<u8> {
    let mut data = input.to_vec();
    for _ in 0..=rng.below(6) {
        let len = data.len();
        match rng.below(6) {
            0 if len > 0 => {
                let at = rng.below(len);
                let span = rng.below(64).min(len - at);
                data.drain(at..at + span);
            }
            1 => {
                let at = rng.below(len + 1);
                let noise = NOISE[rng.below(NOISE.len())];
                data.splice(at..at, noise.iter().copied());
            }
            2 if len > 0 => {
                let at = rng.below(len);
                data[at] = (rng.next() & 0xff) as u8;
            }
            3 if len > 2 => {
                let a = rng.below(len);
                let b = rng.below(len);
                let (lo, hi) = (a.min(b), a.max(b));
                let chunk: Vec<u8> = data[lo..hi.min(lo + 200)].to_vec();
                let at = rng.below(data.len() + 1);
                data.splice(at..at, chunk);
            }
            4 if len > 0 => data.truncate(rng.below(len)),
            _ => {
                let at = rng.below(len + 1);
                let digit = b'0' + (rng.below(10) as u8);
                data.insert(at, digit);
            }
        }
    }
    data
}

fn fixture(name: &str) -> Vec<u8> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn utc(s: &str) -> DateTime<Utc> {
    s.parse().unwrap_or_else(|e| panic!("{s}: {e}"))
}

#[test]
fn mutated_feeds_never_panic() {
    let window = utc("2025-06-01T00:00:00Z")..utc("2027-06-01T00:00:00Z");
    let opts = ParseOptions {
        max_instances_per_series: 200,
        default_zone: Tz::Europe__Berlin,
        ..ParseOptions::default()
    };
    let started = std::time::Instant::now();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut produced = 0usize;
    for name in [
        "google_export.ics",
        "outlook_export.ics",
        "apple_export.ics",
        "malformed.ics",
    ] {
        let original = fixture(name);
        for _ in 0..150 {
            let bytes = mutate(&mut rng, &original);
            let cal = parse_calendar_bytes(&bytes, &opts);
            let events = expand(&cal, window.clone(), &["me@acme.example".to_string()]);
            for event in &events {
                assert!(event.end >= event.start, "{name}: {event:?}");
                assert!(event.start < window.end && event.end > window.start);
            }
            produced += events.len();
            let agenda = Agenda::new(events.clone(), &Filter::default());
            let now = utc("2026-03-10T09:00:00Z");
            let _ = agenda.current(now);
            let _ = agenda.next(now);
            let _ = due_reminders(&events, now, Duration::seconds(60), &Default::default());
            let _ = next_wake(&events, now, Duration::seconds(60));
            let text = String::from_utf8_lossy(&bytes);
            let _ = parse_calendar(&text, &opts);
            let _ = find_meeting_link(&text);
        }
    }
    assert!(produced > 0);
    assert!(started.elapsed() < std::time::Duration::from_secs(120));
}

#[test]
fn mutated_provider_json_never_panics() {
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    for name in ["google_events_page1.json", "google_calendar_list.json"] {
        let original = fixture(name);
        for _ in 0..300 {
            let text = String::from_utf8_lossy(&mutate(&mut rng, &original)).into_owned();
            let _ = parse_google_events(&text, "primary");
            let _ = cap_calendar::google::parse_google_calendar_list(&text);
        }
    }
    for name in ["graph_calendar_view.json", "graph_calendars.json"] {
        let original = fixture(name);
        for _ in 0..300 {
            let text = String::from_utf8_lossy(&mutate(&mut rng, &original)).into_owned();
            let _ = parse_graph_events(&text, "cal");
            let _ = cap_calendar::graph::parse_graph_calendars(&text);
        }
    }
}

#[test]
fn random_bytes_and_strings_never_panic() {
    let mut rng = Rng(0xdead_beef_cafe_f00d);
    let seeds: &[&[u8]] = &[
        b"code=abc&state=xyz",
        br#"{"access_token":"a","expires_in":"12","id_token":"a.eyJlbWFpbCI6ImFAYi5jIn0.c"}"#,
        b"https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fzoom.us%2Fj%2F1234567890",
        b"<a href=\"https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0\">Join</a>",
        b"https://urldefense.proofpoint.com/v2/url?u=https-3A__zoom.us_j_1234567890-",
    ];
    for _ in 0..400 {
        let seed = seeds[rng.below(seeds.len())];
        let text = String::from_utf8_lossy(&mutate(&mut rng, seed)).into_owned();
        let _ = parse_redirect(&text, "xyz");
        let _ = parse_token_response(&text);
        let _ = find_meeting_link(&text);
        let _ = cap_calendar::classify_url(&text);
    }
    for _ in 0..200 {
        let len = rng.below(400);
        let bytes: Vec<u8> = (0..len).map(|_| (rng.next() & 0xff) as u8).collect();
        let cal = parse_calendar_bytes(&bytes, &ParseOptions::default());
        let _ = expand(
            &cal,
            utc("2026-01-01T00:00:00Z")..utc("2027-01-01T00:00:00Z"),
            &[],
        );
        let _ = find_meeting_link(&String::from_utf8_lossy(&bytes));
    }
}
