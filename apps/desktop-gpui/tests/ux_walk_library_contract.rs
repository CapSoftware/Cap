#[path = "../src/ux_walk_journal.rs"]
mod ux_walk_journal;
#[path = "../src/ux_walk_library.rs"]
mod ux_walk_library;

mod store {
    pub const RECORDING_SETTINGS: &str = "recording_settings";
    fn values() -> &'static std::sync::Mutex<serde_json::Map<String, serde_json::Value>> {
        static VALUES: std::sync::OnceLock<
            std::sync::Mutex<serde_json::Map<String, serde_json::Value>>,
        > = std::sync::OnceLock::new();
        VALUES.get_or_init(|| std::sync::Mutex::new(serde_json::Map::new()))
    }
    pub fn store_section(_: &str) -> serde_json::Map<String, serde_json::Value> {
        values().lock().unwrap().clone()
    }
    pub fn update_store_section(
        _: &str,
        mutate: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
    ) -> bool {
        mutate(&mut values().lock().unwrap())
    }
}

mod ux_walk {
    pub fn load() -> Result<serde_json::Map<String, serde_json::Value>, String> {
        Ok(serde_json::Map::new())
    }
    pub fn text<'a>(_: &'a serde_json::Map<String, serde_json::Value>, _: &str) -> &'a str {
        "~/Movies/ux-walk"
    }
}

use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};
use ux_walk_library::{WalkSelection, WalkStatus, index_in, read_summary};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "ux-walk-library-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn source(&self, name: &str) -> PathBuf {
        let path = self.0.join(format!("{name}.cap"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn journal(&self, folder: &str, source: &std::path::Path, started: u64) -> PathBuf {
        let directory = self.0.join(folder);
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join("native-walk.json");
        let value = serde_json::json!({"schemaVersion":1,"request":{"directory":directory,"topic":folder,"url":"https://example.com","speakers":[]},"sourceProject":source,"startedAtMs":started,"state":"complete","durationMs":1000,"events":[{"kind":"note","text":"Saved observation","offsetMs":100}]});
        fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        file
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn saved_walks_only_attach_to_their_exact_source_not_edited_copies() {
    let f = Fixture::new();
    let source = f.source("original");
    let copy = f.source("original-edited");
    let older = f.journal("old-root/first", &source, 100);
    let newest = f.journal("new-root/second", &source, 200);
    let other = f.source("other");
    let third = f.journal("new-root/third", &other, 300);
    let index = index_in(&[f.0.join("new-root")], &[older.clone(), newest.clone()]);
    assert_eq!(
        index[&source.canonicalize().unwrap()].file,
        newest.canonicalize().unwrap()
    );
    assert_eq!(
        index[&other.canonicalize().unwrap()].file,
        third.canonicalize().unwrap()
    );
    assert!(!index.contains_key(&copy.canonicalize().unwrap()));
    let retained = index_in(&[], &[older.clone()]);
    assert_eq!(
        retained[&source.canonicalize().unwrap()].file,
        older.canonicalize().unwrap()
    );
}

#[test]
fn copied_or_malformed_journals_cannot_borrow_another_walks_identity() {
    let f = Fixture::new();
    let source = f.source("source");
    let good = f.journal("good", &source, 100);
    let impostor = f.0.join("impostor");
    fs::create_dir(&impostor).unwrap();
    fs::copy(&good, impostor.join("native-walk.json")).unwrap();
    assert!(read_summary(&impostor.join("native-walk.json")).is_err());
    fs::write(&good, b"{broken").unwrap();
    assert!(index_in(&[f.0.clone()], &[]).is_empty());
}

#[cfg(unix)]
#[test]
fn stale_reports_do_not_hide_processing_or_failure_and_notes_remain_readable() {
    let f = Fixture::new();
    let source = f.source("source");
    let file = f.journal("walk", &source, 100);
    let folder = file.parent().unwrap();
    fs::write(folder.join("report.html"), "old report").unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"processing"}"#).unwrap();
    fs::create_dir(folder.join(".processing-lock")).unwrap();
    fs::write(
        folder.join(".processing-lock/owner.json"),
        serde_json::to_vec(&serde_json::json!({"pid":std::process::id()})).unwrap(),
    )
    .unwrap();
    let summary = read_summary(&file).unwrap();
    assert_eq!(summary.status, WalkStatus::Processing);
    assert!(!summary.report_ready());
    assert!(summary.is_active());
    fs::remove_dir_all(folder.join(".processing-lock")).unwrap();
    fs::write(
        folder.join("processing.json"),
        r#"{"state":"failed","error":"Provider unavailable"}"#,
    )
    .unwrap();
    assert_eq!(
        read_summary(&file).unwrap().status,
        WalkStatus::Failed("Provider unavailable".into())
    );
    assert_eq!(
        ux_walk_library::read_walk(&file).unwrap().1.events[0].text,
        "Saved observation"
    );
    fs::write(folder.join("processing.json"), r#"{"state":"ready"}"#).unwrap();
    assert!(read_summary(&file).unwrap().report_ready());
}

#[test]
fn choosing_another_walk_or_live_recording_rejects_stale_background_loads() {
    let mut selection = WalkSelection::default();
    let a = PathBuf::from("A/native-walk.json");
    let b = PathBuf::from("B/native-walk.json");
    let first = selection.choose(Some(a.clone()));
    let second = selection.choose(Some(b.clone()));
    assert!(!selection.accepts(&a, first));
    assert!(selection.accepts(&b, second));
    selection.choose(None);
    assert!(!selection.accepts(&b, second));
}

#[test]
fn notes_shortcut_keeps_the_recent_walk_when_the_current_session_has_no_journal() {
    use ux_walk_library::{NotesSource, notes_source};
    let last = "/saved-walk/native-walk.json";
    assert_eq!(notes_source(true, Some(last)), NotesSource::Current);
    assert_eq!(
        notes_source(false, Some(last)),
        NotesSource::Saved(last.into())
    );
    assert_eq!(notes_source(false, None), NotesSource::Current);
    assert_eq!(notes_source(false, Some("  ")), NotesSource::Current);
}

#[test]
fn remembering_walks_and_output_roots_preserves_previous_history_and_other_settings() {
    let f = Fixture::new();
    let source = f.source("source");
    let first = f.journal("old-root/first", &source, 100);
    let second = f.journal("new-root/second", &source, 200);
    store::update_store_section(store::RECORDING_SETTINGS, |section| {
        section.insert("lastNativeWalk".into(), serde_json::json!(first));
        section.insert("unrelated".into(), serde_json::json!({"keep":true}));
        true
    });
    ux_walk_library::remember_journal(&first).unwrap();
    ux_walk_library::remember_journal(&second).unwrap();
    ux_walk_library::remember_journal(&first).unwrap();
    ux_walk_library::remember_root(f.0.join("old-root").to_str().unwrap()).unwrap();
    let section = store::store_section(store::RECORDING_SETTINGS);
    assert_eq!(section["nativeWalks"].as_array().unwrap().len(), 2);
    assert_eq!(section["lastNativeWalk"], serde_json::json!(first));
    assert_eq!(section["unrelated"]["keep"], true);
    let root = PathBuf::from(section["nativeWalkRoots"][0].as_str().unwrap());
    assert_eq!(
        index_in(&[root], &[])[&source.canonicalize().unwrap()].file,
        first.canonicalize().unwrap()
    );
}

#[test]
fn saved_evidence_description_uses_the_selected_walks_recorded_coverage() {
    let f = Fixture::new();
    let source = f.source("source");
    let a = f.journal("a", &source, 100);
    let b = f.journal("b", &source, 200);
    fs::write(a.parent().unwrap().join("session.json"),r#"{"coverage":{"dom":"captured from the owned browser window","network":"partial: browser closed","console":"captured from the owned browser window"}}"#).unwrap();
    fs::write(
        b.parent().unwrap().join("session.json"),
        r#"{"coverage":{"dom":"not captured","network":"not captured","console":"not captured"}}"#,
    )
    .unwrap();
    let captured = ux_walk_library::evidence_notice(a.parent().unwrap());
    assert!(captured.contains("Requests: partial: browser closed"));
    assert!(captured.contains("Clicks and page details: captured"));
    assert!(!ux_walk_library::evidence_notice(b.parent().unwrap()).contains("owned browser"));
}

#[cfg(unix)]
#[test]
fn dead_processor_is_retryable_without_removing_the_engines_lock() {
    let f = Fixture::new();
    let source = f.source("source");
    let file = f.journal("walk", &source, 100);
    let folder = file.parent().unwrap();
    fs::create_dir(folder.join(".processing-lock")).unwrap();
    let owner = serde_json::json!({"pid":i32::MAX});
    fs::write(
        folder.join(".processing-lock/owner.json"),
        serde_json::to_vec(&owner).unwrap(),
    )
    .unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"processing"}"#).unwrap();
    let summary = read_summary(&file).unwrap();
    assert!(matches!(summary.status, WalkStatus::Failed(_)));
    assert!(!summary.is_active());
    assert!(ux_walk_library::reprocess_allowed(&file).is_ok());
    assert!(folder.join(".processing-lock/owner.json").is_file());
}

#[test]
fn advisory_unknown_processor_metadata_allows_the_exclusive_backend_attempt() {
    let f = Fixture::new();
    let source = f.source("source");
    let file = f.journal("walk", &source, 100);
    let folder = file.parent().unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"processing"}"#).unwrap();
    assert!(matches!(
        read_summary(&file).unwrap().status,
        WalkStatus::OwnerUnknown(_)
    ));
    assert!(ux_walk_library::reprocess_allowed(&file).is_ok());
    fs::create_dir(folder.join(".processing-lock")).unwrap();
    assert!(matches!(
        read_summary(&file).unwrap().status,
        WalkStatus::OwnerUnknown(_)
    ));
    assert!(ux_walk_library::reprocess_allowed(&file).is_ok());
    fs::write(folder.join(".processing-lock/owner.json"), r#"{"pid":0}"#).unwrap();
    assert!(ux_walk_library::reprocess_allowed(&file).is_ok());
}

#[cfg(unix)]
#[test]
fn metadata_pid_does_not_replace_the_exclusive_backend_guard() {
    let f = Fixture::new();
    let source = f.source("source");
    let file = f.journal("walk", &source, 100);
    let folder = file.parent().unwrap();
    fs::write(folder.join("report.html"), "old report").unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"ready"}"#).unwrap();
    fs::create_dir(folder.join(".processing-lock")).unwrap();
    fs::write(
        folder.join(".processing-lock/owner.json"),
        serde_json::to_vec(&serde_json::json!({"pid":std::process::id()})).unwrap(),
    )
    .unwrap();
    assert_eq!(read_summary(&file).unwrap().status, WalkStatus::Processing);
    assert!(ux_walk_library::reprocess_allowed(&file).is_ok());
}

#[test]
fn processed_browser_notes_join_native_notes_and_chapters_without_duplicates() {
    let f = Fixture::new();
    let source = f.source("source");
    let file = f.journal("walk", &source, 100);
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    value["events"]
        .as_array_mut()
        .unwrap()
        .push(serde_json::json!({"kind":"chapter","text":"Checkout","offsetMs":500}));
    fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
    let folder = file.parent().unwrap();
    let artifact = serde_json::json!({"schemaVersion":1,"journal":file,"sourceProject":source,"notes":[
        {"kind":"note","text":"Saved observation","offsetMs":100},
        {"ev":"note","id":"browser-note","text":"Button does not respond","offsetMs":300}
    ]});
    fs::write(
        folder.join("walk-notes.json"),
        serde_json::to_vec(&artifact).unwrap(),
    )
    .unwrap();
    fs::write(
        folder.join("processing.json"),
        r#"{"state":"failed","error":"not finished"}"#,
    )
    .unwrap();
    let (summary, journal) = ux_walk_library::read_walk(&file).unwrap();
    assert_eq!(ux_walk_library::view_events(&summary, &journal).len(), 2);
    fs::write(folder.join("report.html"), "report").unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"ready"}"#).unwrap();
    let (summary, journal) = ux_walk_library::read_walk(&file).unwrap();
    let original = fs::read(&file).unwrap();
    let events = ux_walk_library::view_events(&summary, &journal);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].text, "Saved observation");
    assert_eq!(events[1].text, "Button does not respond");
    assert_eq!(events[1].offset_ms, 300);
    assert_eq!(events[2].kind, "chapter");
    assert_eq!(events[2].text, "Checkout");
    assert_eq!(fs::read(&file).unwrap(), original);
}

#[test]
fn foreign_or_malformed_processed_notes_fall_back_to_the_selected_journal() {
    let f = Fixture::new();
    let source = f.source("source");
    let foreign = f.source("foreign");
    let file = f.journal("walk", &source, 100);
    let other = f.journal("other", &foreign, 200);
    let folder = file.parent().unwrap();
    fs::write(folder.join("report.html"), "report").unwrap();
    fs::write(folder.join("processing.json"), r#"{"state":"ready"}"#).unwrap();
    let (summary, journal) = ux_walk_library::read_walk(&file).unwrap();
    let valid = serde_json::json!({"schemaVersion":1,"journal":file,"sourceProject":source,"notes":[{"ev":"note","id":"browser-note","text":"Browser observation","offsetMs":300}]});
    let mut cases = Vec::new();
    let mut wrong_file = valid.clone();
    wrong_file["journal"] = serde_json::json!(other);
    cases.push(wrong_file);
    let mut wrong_source = valid.clone();
    wrong_source["sourceProject"] = serde_json::json!(foreign);
    cases.push(wrong_source);
    let mut wrong_schema = valid.clone();
    wrong_schema["schemaVersion"] = serde_json::json!(2);
    cases.push(wrong_schema);
    let mut wrong_clock = valid.clone();
    wrong_clock["notes"][0]["offsetMs"] = serde_json::json!(1001);
    cases.push(wrong_clock);
    let mut wrong_text = valid.clone();
    wrong_text["notes"][0]["text"] = serde_json::json!({"not":"text"});
    cases.push(wrong_text);
    for artifact in cases {
        fs::write(
            folder.join("walk-notes.json"),
            serde_json::to_vec(&artifact).unwrap(),
        )
        .unwrap();
        let events = ux_walk_library::view_events(&summary, &journal);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].text, "Saved observation");
    }
}
