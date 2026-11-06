#[path = "../src/ux_walk_journal.rs"]
mod journal;
use journal::{Journal, Kind, Request};
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
        kind: Kind::Walk,
        project: None,
        external: None,
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

#[test]
fn a_diatribe_request_records_its_kind_and_no_browser() {
    let req = Request {
        url: String::new(),
        topic: "Diatribe".into(),
        kind: Kind::Diatribe,
        external: None,
        ..request()
    };
    assert!(req.is_diatribe());
    assert!(!req.uses_browser());
    let mut walk =
        Journal::begin(req.clone(), PathBuf::from("/recordings/talk.cap"), 100_000).unwrap();
    walk.add("note", "Ship the importer first", 2_000).unwrap();
    walk.complete(9_000).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(saved["request"]["kind"], "diatribe");
    assert_eq!(saved["request"]["url"], "");
    let reopened: Journal = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert!(reopened.request.is_diatribe());
    let next = req.for_restart("again");
    assert!(next.is_diatribe());
    assert_eq!(next.directory.file_name().unwrap(), "diatribe-again");
    fs::remove_dir_all(req.directory).unwrap();
}

#[test]
fn an_outside_callers_id_stays_out_of_the_journal_but_survives_a_restart() {
    let mut req = request();
    req.external = Some("z3-run-1".into());
    let value = serde_json::to_value(&req).unwrap();
    assert!(value.get("external").is_none());
    let reread: Request = serde_json::from_value(value).unwrap();
    assert_eq!(reread.external, None);
    assert_eq!(
        req.for_restart("again").external.as_deref(),
        Some("z3-run-1")
    );
}

#[test]
fn journals_written_before_diatribes_read_as_walks() {
    let mut value = serde_json::to_value(request()).unwrap();
    assert_eq!(value["kind"], "walk");
    value.as_object_mut().unwrap().remove("kind");
    let old: Request = serde_json::from_value(value).unwrap();
    assert_eq!(old.kind, Kind::Walk);
    assert!(old.uses_browser());
}

#[test]
fn journals_written_before_projects_load_without_one_and_a_project_survives_reopening() {
    let mut value = serde_json::to_value(request()).unwrap();
    assert!(value.get("project").is_none());
    value.as_object_mut().unwrap().remove("project");
    let old: Request = serde_json::from_value(value).unwrap();
    assert_eq!(old.project, None);
    let old_journal = r#"{"schemaVersion":1,"request":{"directory":"/tmp/walk","topic":"Old","url":"","speakers":[]},"sourceProject":"/tmp/walk.cap","startedAtMs":1,"state":"complete","durationMs":5,"events":[]}"#;
    let reopened: Journal = serde_json::from_str(old_journal).unwrap();
    assert_eq!(reopened.request.project, None);
    assert_eq!(reopened.request.kind, Kind::Walk);

    let req = Request {
        project: Some("acme".into()),
        kind: Kind::Diatribe,
        ..request()
    };
    let mut walk =
        Journal::begin(req.clone(), PathBuf::from("/recordings/talk.cap"), 100_000).unwrap();
    walk.complete(9_000).unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(saved["request"]["project"], "acme");
    let reopened: Journal = serde_json::from_slice(&fs::read(walk.file()).unwrap()).unwrap();
    assert_eq!(reopened.request.project.as_deref(), Some("acme"));
    assert_eq!(req.for_restart("again").project.as_deref(), Some("acme"));
    fs::remove_dir_all(req.directory).unwrap();
}

#[test]
fn notes_ride_on_an_ordinary_recording_without_browser_or_walk_window() {
    let req = Request {
        url: String::new(),
        topic: "Standup".into(),
        kind: Kind::Notes,
        external: None,
        ..request()
    };
    assert!(req.is_notes());
    assert!(!req.is_diatribe());
    assert!(!req.uses_browser());
    assert!(!req.opens_walk_window());
    assert!(request().opens_walk_window());
    assert!(!journal::opens_walk_window(Some(&req)));
    assert!(journal::opens_walk_window(Some(&request())));
    assert!(!journal::opens_walk_window(None));
    assert!(
        Request {
            kind: Kind::Diatribe,
            external: None,
            ..request()
        }
        .opens_walk_window()
    );
    let mut notes = Journal::begin(
        req.clone(),
        PathBuf::from("/recordings/standup.cap"),
        100_000,
    )
    .unwrap();
    notes.complete(9_000).unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(notes.file()).unwrap()).unwrap();
    assert_eq!(saved["request"]["kind"], "notes");
    let reopened: Journal = serde_json::from_slice(&fs::read(notes.file()).unwrap()).unwrap();
    assert!(reopened.request.is_notes());
    let next = req.for_restart("again");
    assert!(next.is_notes());
    assert_eq!(next.directory.file_name().unwrap(), "notes-again");
    fs::remove_dir_all(req.directory).unwrap();
}

#[test]
fn notes_for_an_earlier_recording_are_written_complete() {
    let req = Request {
        kind: Kind::Notes,
        external: None,
        ..request()
    };
    assert!(
        Journal::finished(
            req.clone(),
            PathBuf::from("/recordings/old.cap"),
            100_000,
            0
        )
        .is_err()
    );
    assert!(!req.directory.exists());
    let notes = Journal::finished(
        req.clone(),
        PathBuf::from("/recordings/old.cap"),
        100_000,
        42_000,
    )
    .unwrap();
    let saved: serde_json::Value =
        serde_json::from_slice(&fs::read(notes.file()).unwrap()).unwrap();
    assert_eq!(saved["state"], "complete");
    assert_eq!(saved["durationMs"], 42_000);
    assert_eq!(saved["sourceProject"], "/recordings/old.cap");
    assert_eq!(saved["request"]["kind"], "notes");
    assert!(Journal::finished(req.clone(), PathBuf::from("/recordings/old.cap"), 1, 1).is_err());
    fs::remove_dir_all(req.directory).unwrap();
}
