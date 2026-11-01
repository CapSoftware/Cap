#[path = "../src/ux_walk_journal.rs"]
mod journal;
use journal::{Journal, Request};
use std::{
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

fn request() -> Request {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let unique = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    Request {
        directory: std::env::temp_dir().join(format!(
            "ux-walk-journal-{id}-{}-{unique}",
            std::process::id()
        )),
        topic: "Checkout walk".into(),
        url: "https://example.com".into(),
        speakers: vec!["Tester".into()],
    }
}

#[test]
fn native_notes_use_capture_elapsed_time_and_survive_reopening() {
    let req = request();
    let mut walk =
        Journal::begin(req.clone(), PathBuf::from("/recordings/test.cap"), 100_000).unwrap();
    walk.add("note", "Button is clipped", 1_500).unwrap();
    walk.add("chapter", "Payment", 4_000).unwrap();
    assert!(walk.add("note", "Stale timestamp", 3_999).is_err());
    assert!(walk.add("note", "  ", 5_000).is_err());
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(saved["events"][0]["offsetMs"], 1_500);
    assert_eq!(saved["events"][1]["offsetMs"], 4_000);
    assert_eq!(saved["state"], "recording");
    assert!(Journal::begin(req.clone(), PathBuf::from("other.cap"), 100_000).is_err());
    assert_eq!(saved["events"].as_array().unwrap().len(), 2);
    fs::remove_dir_all(req.directory).unwrap();
}

#[test]
fn completion_requires_a_confirmed_end_and_preserves_notes_after_abort() {
    let req = request();
    let mut walk = Journal::begin(req.clone(), PathBuf::from("source.cap"), 100_000).unwrap();
    walk.add("note", "Keep this evidence", 2_000).unwrap();
    assert!(walk.complete(1_000).is_err());
    walk.complete(3_000).unwrap();
    assert!(walk.add("note", "Too late", 3_000).is_err());
    assert!(walk.complete(4_000).is_err());
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(saved["state"], "complete");
    assert_eq!(saved["durationMs"], 3_000);
    fs::remove_dir_all(req.directory).unwrap();
    let req = request();
    let mut walk = Journal::begin(req.clone(), PathBuf::from("discarded.cap"), 100_000).unwrap();
    walk.add("note", "Recover me", 500).unwrap();
    walk.abort().unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(saved["state"], "aborted");
    assert_eq!(saved["events"][0]["text"], "Recover me");
    fs::remove_dir_all(req.directory).unwrap();
}

#[test]
fn restart_creates_a_new_walk_without_overwriting_the_previous_notes() {
    let first = request();
    let mut journal = Journal::begin(first.clone(), PathBuf::from("first.cap"), 100_000).unwrap();
    journal
        .add("note", "Retain the discarded attempt", 500)
        .unwrap();
    journal.abort().unwrap();
    let next = first.for_restart(&format!(
        "{}-restart",
        first.directory.file_name().unwrap().to_string_lossy()
    ));
    assert_ne!(next.directory, first.directory);
    let restarted = Journal::begin(next.clone(), PathBuf::from("second.cap"), 200_000).unwrap();
    assert_eq!(restarted.events.len(), 0);
    let old: serde_json::Value =
        serde_json::from_slice(&fs::read(journal.file()).unwrap()).unwrap();
    assert_eq!(old["state"], "aborted");
    assert_eq!(old["events"][0]["text"], "Retain the discarded attempt");
    fs::remove_dir_all(first.directory).unwrap();
    fs::remove_dir_all(next.directory).unwrap();
}
