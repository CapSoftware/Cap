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
