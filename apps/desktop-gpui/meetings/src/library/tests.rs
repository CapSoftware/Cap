use chrono::{Duration, NaiveDate, TimeZone};

use super::*;
use crate::transcript::{LogLine, Utterance, append_jsonl};

fn t(day: u32, hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, day, hour, 0, 0).unwrap()
}

fn lib() -> (tempfile::TempDir, Library) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("docs")).unwrap();
    (dir, library)
}

#[test]
fn ids_are_time_sortable_and_validated() {
    let a = new_id(t(1, 9), 0);
    let b = new_id(t(1, 9) + Duration::milliseconds(1), u64::MAX);
    let c = new_id(t(2, 0), 12345);
    assert!(a < b && b < c, "{a} {b} {c}");
    assert!(is_valid_id(&a));
    assert!(a.starts_with("20261101T090000000Z-"));
    for bad in ["", "..", "../etc", "a/b", ".hidden", "a b", &"x".repeat(81)] {
        assert!(!is_valid_id(bad), "{bad:?}");
    }
}

#[test]
fn create_load_save_and_kind_defaults() {
    let (_dir, library) = lib();
    let meeting = library.create(DocKind::Meeting, t(3, 10), 1).unwrap();
    assert!(meeting.meeting.is_some());
    let note = library.create(DocKind::Note, t(3, 10), 1).unwrap();
    assert_ne!(meeting.id, note.id);
    assert!(note.meeting.is_none());
    let mut loaded = library.load(&meeting.id).unwrap();
    assert_eq!(loaded, meeting);
    loaded.title = "Planning".into();
    loaded.title_is_auto = false;
    loaded.meeting.as_mut().unwrap().stop_reason = Some(StopReason::CallEnded);
    library.save(&loaded).unwrap();
    assert_eq!(library.load(&meeting.id).unwrap(), loaded);
    assert!(matches!(
        library.load("missing"),
        Err(LibraryError::NotFound(_))
    ));
    assert!(matches!(
        library.load("../x"),
        Err(LibraryError::InvalidId(_))
    ));
    let json =
        std::fs::read_to_string(library.doc_dir(&meeting.id).unwrap().join(DOC_FILE)).unwrap();
    assert!(json.contains("\"kind\": \"meeting\""));
    assert!(json.contains("\"titleIsAuto\": false"));
    assert!(json.contains("\"stopReason\": \"callEnded\""));
}

#[test]
fn kind_inference_and_unknown_round_trips() {
    let (_dir, library) = lib();
    let write = |id: &str, json: &str| {
        let dir = library.root().join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DOC_FILE), json).unwrap();
    };
    write(
        "legacy-meeting",
        r#"{"title":"Old","meeting":{"appId":"zoom"}}"#,
    );
    write("legacy-note", r#"{"title":"Plain"}"#);
    write(
        "future",
        r#"{"kind":"whiteboard","title":"New","shinyField":{"a":[1,2]},"meeting":{"appId":"zoom","stopReason":"alienAbduction","newMeetingField":7,"audio":[{"source":"satellite","file":"a.ogg"}]}}"#,
    );
    write("badkind", r#"{"kind":42,"title":"Number kind"}"#);
    assert_eq!(
        library.load("legacy-meeting").unwrap().kind,
        DocKind::Meeting
    );
    assert_eq!(library.load("legacy-note").unwrap().kind, DocKind::Note);
    assert_eq!(library.load("badkind").unwrap().kind, DocKind::Note);
    let future = library.load("future").unwrap();
    assert_eq!(future.kind, DocKind::Other("whiteboard".into()));
    assert_eq!(
        future.extra.get("shinyField"),
        Some(&serde_json::json!({"a": [1, 2]}))
    );
    let meeting = future.meeting.as_ref().unwrap();
    assert_eq!(meeting.stop_reason, None);
    assert_eq!(
        meeting.extra.get("newMeetingField"),
        Some(&serde_json::json!(7))
    );
    assert_eq!(meeting.audio[0].source, Source::Mic);
    library.save(&future).unwrap();
    let raw: Value = serde_json::from_slice(
        &std::fs::read(library.root().join("future").join(DOC_FILE)).unwrap(),
    )
    .unwrap();
    assert_eq!(raw["kind"], "whiteboard");
    assert_eq!(raw["shinyField"]["a"][1], 2);
    assert_eq!(raw["meeting"]["newMeetingField"], 7);
    assert_eq!(library.load("future").unwrap(), future);
    for kind in ["meeting", "note", "plan", "script"] {
        assert_eq!(DocKind::parse(kind).as_str(), kind);
    }
}

#[test]
fn atomic_save_survives_leftover_temp_files() {
    let (_dir, library) = lib();
    let mut doc = library.create(DocKind::Note, t(4, 9), 7).unwrap();
    let dir = library.doc_dir(&doc.id).unwrap();
    std::fs::write(dir.join(".doc.json.999.0.tmp"), "{ half written").unwrap();
    std::fs::write(dir.join("doc.json.tmp"), "garbage").unwrap();
    assert_eq!(library.load(&doc.id).unwrap(), doc);
    doc.title = "After crash".into();
    library.save(&doc).unwrap();
    assert_eq!(library.load(&doc.id).unwrap().title, "After crash");
    let listing = library.list(&ListFilter::default()).unwrap();
    assert_eq!(listing.docs.len(), 1);
    assert!(listing.broken.is_empty());
    let temps: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| {
            n.ends_with(".tmp") && n.starts_with(".doc.json.") && n != ".doc.json.999.0.tmp"
        })
        .collect();
    assert!(temps.is_empty(), "{temps:?}");
}

#[test]
fn listing_skips_broken_folders_and_filters() {
    let (_dir, library) = lib();
    let m1 = library.create(DocKind::Meeting, t(5, 9), 1).unwrap();
    let m2 = library.create(DocKind::Meeting, t(6, 9), 2).unwrap();
    let n1 = library.create(DocKind::Note, t(7, 9), 3).unwrap();
    let p1 = library.create(DocKind::Plan, t(8, 9), 4).unwrap();
    library.trash(&m1.id, t(9, 9)).unwrap();
    std::fs::create_dir_all(library.root().join("broken-json")).unwrap();
    std::fs::write(library.root().join("broken-json").join(DOC_FILE), "{ nope").unwrap();
    std::fs::create_dir_all(library.root().join("empty-folder")).unwrap();
    std::fs::create_dir_all(library.root().join(".hidden")).unwrap();
    std::fs::write(library.root().join("stray-file.txt"), "x").unwrap();
    std::fs::write(library.root().join(FOLDERS_FILE), "{}").unwrap();

    let all = library.list(&ListFilter::default()).unwrap();
    let ids: Vec<&str> = all.docs.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, vec![p1.id.as_str(), n1.id.as_str(), m2.id.as_str()]);
    let mut broken: Vec<&str> = all.broken.iter().map(|b| b.name.as_str()).collect();
    broken.sort();
    assert_eq!(broken, vec!["broken-json", "empty-folder"]);

    let meetings = library
        .list(&ListFilter {
            kind: Some(DocKind::Meeting),
            trash: TrashFilter::Include,
            ..ListFilter::default()
        })
        .unwrap();
    assert_eq!(meetings.docs.len(), 2);
    let trashed = library
        .list(&ListFilter {
            trash: TrashFilter::Only,
            ..ListFilter::default()
        })
        .unwrap();
    assert_eq!(trashed.docs.len(), 1);
    assert_eq!(trashed.docs[0].id, m1.id);
    let plans = library
        .list(&ListFilter {
            kind: Some(DocKind::Plan),
            ..ListFilter::default()
        })
        .unwrap();
    assert_eq!(plans.docs.len(), 1);
}

#[test]
fn trash_lifecycle_and_purge() {
    let (_dir, library) = lib();
    let a = library.create(DocKind::Meeting, t(1, 9), 1).unwrap();
    let b = library.create(DocKind::Note, t(1, 9), 2).unwrap();
    library.trash(&a.id, t(1, 10)).unwrap();
    library.trash(&a.id, t(5, 10)).unwrap();
    assert_eq!(library.load(&a.id).unwrap().trashed_at, Some(t(1, 10)));
    library.trash(&b.id, t(20, 10)).unwrap();
    library.restore(&b.id).unwrap();
    assert!(library.load(&b.id).unwrap().trashed_at.is_none());
    library.trash(&b.id, t(20, 10)).unwrap();
    assert!(
        library
            .purge_trash(t(30, 9), |_| false)
            .unwrap()
            .done
            .is_empty()
    );
    assert!(
        library
            .purge_trash(t(1, 10) + Duration::days(30), |_| true)
            .unwrap()
            .done
            .is_empty(),
        "an item the caller keeps stays in the trash"
    );
    let purged = library
        .purge_trash(t(1, 10) + Duration::days(30), |_| false)
        .unwrap();
    assert_eq!(purged.done, vec![a.id.clone()]);
    assert!(!library.doc_dir(&a.id).unwrap().exists());
    assert!(library.load(&b.id).is_ok());
    library.delete_permanently(&b.id).unwrap();
    library.delete_permanently(&b.id).unwrap();
    assert!(matches!(
        library.load(&b.id),
        Err(LibraryError::NotFound(_))
    ));
}

#[test]
fn folders_and_moves() {
    let (_dir, library) = lib();
    assert!(library.folders().unwrap().is_empty());
    let work = library.create_folder("  Work  ", None, t(1, 9), 1).unwrap();
    assert_eq!(work.name, "Work");
    let clients = library
        .create_folder("Clients", Some(&work.id), t(1, 9), 1)
        .unwrap();
    assert_ne!(clients.id, work.id);
    assert!(matches!(
        library.create_folder("x", Some("nope"), t(1, 9), 2),
        Err(LibraryError::NotFound(_))
    ));
    library.rename_folder(&clients.id, "Customers").unwrap();
    library.set_folder_pinned(&work.id, true).unwrap();
    assert!(matches!(
        library.move_folder(&work.id, Some(&clients.id)),
        Err(LibraryError::NotAllowed(_))
    ));
    assert!(matches!(
        library.move_folder(&work.id, Some(&work.id)),
        Err(LibraryError::NotAllowed(_))
    ));
    let doc = library.create(DocKind::Meeting, t(2, 9), 1).unwrap();
    assert!(matches!(
        library.move_doc(&doc.id, Some("missing")),
        Err(LibraryError::NotFound(_))
    ));
    library.move_doc(&doc.id, Some(&clients.id)).unwrap();
    let in_clients = library
        .list(&ListFilter {
            folder_id: Some(clients.id.clone()),
            ..ListFilter::default()
        })
        .unwrap();
    assert_eq!(in_clients.docs.len(), 1);
    let moved = library.delete_folder(&clients.id).unwrap();
    assert_eq!(moved, vec![doc.id.clone()]);
    assert_eq!(
        library.load(&doc.id).unwrap().folder_id.as_deref(),
        Some(work.id.as_str())
    );
    let folders = library.folders().unwrap();
    assert_eq!(folders.len(), 1);
    assert!(folders[0].pinned);

    std::fs::write(
        library.root().join(FOLDERS_FILE),
        r#"{"folders":[{"id":"f1","name":"Kept","colour":"red"}],"version":3}"#,
    )
    .unwrap();
    library.rename_folder("f1", "Renamed").unwrap();
    let raw = std::fs::read_to_string(library.root().join(FOLDERS_FILE)).unwrap();
    assert!(
        raw.contains("\"colour\": \"red\"") && raw.contains("\"version\": 3"),
        "{raw}"
    );
}

#[test]
fn notes_enhanced_and_attachments() {
    let (_dir, library) = lib();
    let meeting = library.create(DocKind::Meeting, t(2, 9), 1).unwrap();
    let note = library.create(DocKind::Note, t(2, 9), 2).unwrap();
    assert_eq!(library.read_notes(&meeting.id).unwrap(), None);
    library
        .write_notes(&meeting.id, r#"{"type":"doc","content":[]}"#)
        .unwrap();
    assert!(
        library
            .read_notes(&meeting.id)
            .unwrap()
            .unwrap()
            .contains("doc")
    );
    assert!(matches!(
        library.write_notes(&meeting.id, "{ broken"),
        Err(LibraryError::Json(_))
    ));
    assert!(matches!(
        library.write_notes("missing", "{}"),
        Err(LibraryError::NotFound(_))
    ));
    library.write_enhanced(&meeting.id, "{}").unwrap();
    assert!(matches!(
        library.write_enhanced(&note.id, "{}"),
        Err(LibraryError::NotAllowed(_))
    ));

    let name = library
        .add_attachment(&note.id, "../../Screen Shot.PNG", b"png")
        .unwrap();
    assert_eq!(name, "Screen Shot.png");
    let second = library
        .add_attachment(&note.id, "Screen Shot.png", b"png")
        .unwrap();
    assert_eq!(second, "Screen Shot-1.png");
    assert!(matches!(
        library.add_attachment(&note.id, "script.sh", b"x"),
        Err(LibraryError::NotAllowed(_))
    ));
    assert!(matches!(
        library.add_attachment(&note.id, "noext", b"x"),
        Err(LibraryError::NotAllowed(_))
    ));
    assert!(matches!(
        library.add_attachment(&note.id, "big.jpg", &vec![0u8; MAX_ATTACHMENT_BYTES + 1]),
        Err(LibraryError::Limit(_))
    ));
    assert_eq!(
        library.list_attachments(&note.id).unwrap(),
        vec![second.clone(), name.clone()]
    );
    assert!(library.remove_attachment(&note.id, &name).unwrap());
    assert!(!library.remove_attachment(&note.id, &name).unwrap());
    assert!(library.remove_attachment(&note.id, "../doc.json").is_err());
    for i in 0..MAX_ATTACHMENTS - 1 {
        library
            .add_attachment(&note.id, &format!("i{i}.webp"), b"w")
            .unwrap();
    }
    assert!(matches!(
        library.add_attachment(&note.id, "one-too-many.gif", b"g"),
        Err(LibraryError::Limit(_))
    ));
}

#[test]
fn audio_retention_sweep() {
    let (_dir, library) = lib();
    let mut old = library.create(DocKind::Meeting, t(1, 9), 1).unwrap();
    old.meeting.as_mut().unwrap().ended_at = Some(t(1, 10));
    old.meeting.as_mut().unwrap().audio = vec![AudioTrack {
        source: Source::System,
        file: "audio/system.ogg".into(),
        codec: "opus".into(),
        duration_ms: 1_000,
    }];
    library.save(&old).unwrap();
    let audio = library.audio_dir(&old.id).unwrap();
    std::fs::create_dir_all(&audio).unwrap();
    std::fs::write(audio.join("system.ogg"), b"ogg").unwrap();
    let mut recent = library.create(DocKind::Meeting, t(20, 9), 2).unwrap();
    recent.meeting.as_mut().unwrap().ended_at = Some(t(20, 10));
    library.save(&recent).unwrap();
    std::fs::create_dir_all(library.audio_dir(&recent.id).unwrap()).unwrap();
    library.create(DocKind::Note, t(1, 9), 3).unwrap();
    let unfinished = library.create(DocKind::Meeting, t(1, 9), 4).unwrap();
    let unfinished_audio = library.audio_dir(&unfinished.id).unwrap();
    std::fs::create_dir_all(&unfinished_audio).unwrap();
    let mut held = library.create(DocKind::Meeting, t(1, 9), 5).unwrap();
    held.meeting.as_mut().unwrap().ended_at = Some(t(1, 10));
    library.save(&held).unwrap();
    let held_audio = library.audio_dir(&held.id).unwrap();
    std::fs::create_dir_all(&held_audio).unwrap();

    let swept = library
        .sweep_audio(t(10, 9), 7, |m| m.id == held.id)
        .unwrap();
    assert_eq!(swept.done, vec![old.id.clone()]);
    assert!(
        unfinished_audio.exists(),
        "a meeting that never ended keeps its audio"
    );
    assert!(
        held_audio.exists(),
        "a meeting the caller still needs keeps its audio"
    );
    assert!(!audio.exists());
    assert!(
        library
            .load(&old.id)
            .unwrap()
            .meeting
            .unwrap()
            .audio
            .is_empty()
    );
    assert!(library.audio_dir(&recent.id).unwrap().exists());
    assert!(
        library
            .sweep_audio(t(10, 9), 7, |m| m.id == held.id)
            .unwrap()
            .done
            .is_empty()
    );
}

/// Makes `dir` read-only so nothing in it can be deleted. False when the
/// test runs as a user that permissions do not stop (root).
#[cfg(unix)]
fn lock(dir: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    std::fs::write(dir.join("probe"), b"").is_err()
}

#[cfg(unix)]
fn unlock(dir: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[cfg(unix)]
#[test]
fn one_document_that_cannot_be_cleaned_never_stops_the_rest() {
    let (_dir, library) = lib();
    let ended = |entropy: u64| {
        let mut meta = library.create(DocKind::Meeting, t(1, 9), entropy).unwrap();
        meta.meeting.as_mut().unwrap().ended_at = Some(t(1, 10));
        library.save(&meta).unwrap();
        let audio = library.audio_dir(&meta.id).unwrap();
        std::fs::create_dir_all(&audio).unwrap();
        std::fs::write(audio.join("you.ogg"), b"ogg").unwrap();
        (meta.id, audio)
    };
    let (stuck, stuck_audio) = ended(1);
    let (free, free_audio) = ended(2);
    if !lock(&stuck_audio) {
        unlock(&stuck_audio);
        return;
    }

    let swept = library.sweep_audio(t(20, 9), 7, |_| false).unwrap();
    assert_eq!(swept.done, vec![free.clone()]);
    assert_eq!(swept.failed.len(), 1);
    assert_eq!(swept.failed[0].0, stuck);
    assert!(!free_audio.exists());
    assert!(stuck_audio.join("you.ogg").exists());

    library.trash(&stuck, t(1, 11)).unwrap();
    library.trash(&free, t(1, 11)).unwrap();
    let purged = library
        .purge_trash(t(1, 11) + Duration::days(31), |_| false)
        .unwrap();
    assert_eq!(purged.done, vec![free.clone()]);
    assert_eq!(purged.failed.len(), 1);
    assert_eq!(purged.failed[0].0, stuck);
    assert!(library.load(&free).is_err());
    unlock(&stuck_audio);
}

#[test]
fn group_by_day_respects_timezone() {
    let mk = |id: &str, at: DateTime<Utc>| DocMeta::new(id.into(), DocKind::Note, at);
    let mut meeting = mk("m", t(3, 1));
    meeting.kind = DocKind::Meeting;
    meeting.meeting = Some(MeetingDetails {
        started_at: Some(t(4, 23)),
        ..MeetingDetails::default()
    });
    let docs = vec![
        mk("a", t(3, 23)),
        mk("b", t(4, 2)),
        meeting,
        mk("c", t(1, 12)),
    ];
    let utc = group_by_day(&docs, 0);
    let shape: Vec<(NaiveDate, Vec<&str>)> = utc
        .iter()
        .map(|g| (g.date, g.ids.iter().map(String::as_str).collect()))
        .collect();
    assert_eq!(
        shape,
        vec![
            (
                NaiveDate::from_ymd_opt(2026, 11, 4).unwrap(),
                vec!["m", "b"]
            ),
            (NaiveDate::from_ymd_opt(2026, 11, 3).unwrap(), vec!["a"]),
            (NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(), vec!["c"]),
        ]
    );
    let tokyo = group_by_day(&docs, 9 * 60);
    assert_eq!(tokyo[0].date, NaiveDate::from_ymd_opt(2026, 11, 5).unwrap());
    assert_eq!(tokyo[0].ids, vec!["m"]);
    assert_eq!(tokyo[1].ids, vec!["b", "a"]);
    assert_eq!(
        group_by_day(&docs, i32::MAX).len(),
        group_by_day(&docs, 14 * 60).len()
    );
    assert!(group_by_day(&[], 0).is_empty());
}

#[test]
fn search_ranks_titles_notes_and_transcripts() {
    let (_dir, library) = lib();
    let mut titled = library.create(DocKind::Meeting, t(1, 9), 1).unwrap();
    titled.title = "Roadmap planning".into();
    library.save(&titled).unwrap();
    let noted = library.create(DocKind::Note, t(2, 9), 2).unwrap();
    library
        .write_notes(&noted.id, r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Discuss the ROADMAP for Q1"}]}]}"#)
        .unwrap();
    let spoken = library.create(DocKind::Meeting, t(3, 9), 3).unwrap();
    append_jsonl(
        &library.transcript_path(&spoken.id).unwrap(),
        &[LogLine::Upsert {
            utterance: Utterance {
                id: "u1".into(),
                text: "we need a roadmap before launch".into(),
                is_final: true,
                ..Utterance::default()
            },
        }],
    )
    .unwrap();
    let mut trashed = library.create(DocKind::Note, t(4, 9), 4).unwrap();
    trashed.title = "Roadmap draft".into();
    library.save(&trashed).unwrap();
    library.trash(&trashed.id, t(5, 9)).unwrap();
    let mut tagged = library.create(DocKind::Script, t(4, 9), 5).unwrap();
    tagged.tags = vec!["roadmap".into()];
    library.save(&tagged).unwrap();

    let hits = library
        .search("roadmap", &SearchOptions::default())
        .unwrap();
    let order: Vec<(&str, SearchField)> = hits.iter().map(|h| (h.id.as_str(), h.field)).collect();
    assert_eq!(
        order,
        vec![
            (titled.id.as_str(), SearchField::Title),
            (tagged.id.as_str(), SearchField::Title),
            (noted.id.as_str(), SearchField::Notes),
            (spoken.id.as_str(), SearchField::Transcript),
        ]
    );
    assert!(hits[2].snippet.contains("ROADMAP"));
    assert!(hits[3].snippet.contains("roadmap before launch"));

    let meetings = library
        .search(
            "ROADMAP",
            &SearchOptions {
                kind: Some(DocKind::Meeting),
                ..SearchOptions::default()
            },
        )
        .unwrap();
    assert_eq!(meetings.len(), 2);
    let with_trash = library
        .search(
            "roadmap",
            &SearchOptions {
                include_trashed: true,
                limit: 2,
                ..SearchOptions::default()
            },
        )
        .unwrap();
    assert_eq!(with_trash.len(), 2);
    assert!(
        library
            .search("  ", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
    assert!(
        library
            .search("absent", &SearchOptions::default())
            .unwrap()
            .is_empty()
    );
}

#[test]
fn search_stays_fast_over_thousands() {
    let (_dir, library) = lib();
    for i in 0..2_000u64 {
        let mut doc = DocMeta::new(
            new_id(t(1, 0) + Duration::minutes(i as i64), i),
            if i % 2 == 0 {
                DocKind::Meeting
            } else {
                DocKind::Note
            },
            t(1, 0) + Duration::minutes(i as i64),
        );
        doc.title = format!("Meeting {i}");
        let dir = library.doc_dir(&doc.id).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(DOC_FILE), serde_json::to_vec(&doc).unwrap()).unwrap();
    }
    let started = std::time::Instant::now();
    let hits = library
        .search(
            "meeting 1",
            &SearchOptions {
                limit: 20,
                ..SearchOptions::default()
            },
        )
        .unwrap();
    assert_eq!(hits.len(), 20);
    assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
}

#[test]
fn caller_supplied_names_are_single_safe_components() {
    let (_dir, library) = lib();
    let note = library.create(DocKind::Note, t(2, 9), 2).unwrap();
    std::fs::create_dir_all(library.attachments_dir(&note.id).unwrap()).unwrap();
    let hostile = [
        "",
        ".",
        "..",
        "../doc.json",
        "..\\doc.json",
        "a/b.png",
        "a\\b.png",
        "/etc/passwd",
        "C:evil.txt",
        "C:\\evil.txt",
        "\\\\server\\share\\x.png",
        "x.png:stream",
        "x.png::$DATA",
        "CON",
        "con.png",
        "Nul.txt",
        "aux",
        "COM1",
        "com9.jpg",
        "LPT1.tar.gz",
        "COM\u{b9}.png",
        "CONIN$",
        "con .png",
        "trailing.",
        "trailing ",
        "pipe|name.png",
        "quote\".png",
        "star*.png",
        "question?.png",
        "angle<.png",
        "tab\t.png",
        "nul\0byte.png",
        ".hidden.png",
    ];
    for name in hostile {
        assert!(
            matches!(
                library.attachment_path(&note.id, name),
                Err(LibraryError::InvalidId(_))
            ),
            "attachment_path accepted {name:?}"
        );
        assert!(
            library.remove_attachment(&note.id, name).is_err(),
            "remove_attachment accepted {name:?}"
        );
        assert!(
            library.audio_file_path(&note.id, name).is_err(),
            "audio_file_path accepted {name:?}"
        );
        assert!(
            library
                .audio_file_path(&note.id, &format!("audio/{name}"))
                .is_err(),
            "audio_file_path accepted audio/{name:?}"
        );
    }
    for name in [
        "photo.png",
        "Screen Shot 2.png",
        "console.png",
        "com10.png",
        "lpt.png",
        "a.b.c.jpg",
    ] {
        let path = library.attachment_path(&note.id, name).unwrap();
        assert_eq!(path, library.attachments_dir(&note.id).unwrap().join(name));
    }
    assert_eq!(
        library
            .audio_file_path(&note.id, "audio/mic-1.wav")
            .unwrap(),
        library.audio_dir(&note.id).unwrap().join("mic-1.wav")
    );
    assert_eq!(
        library
            .audio_file_path(&note.id, "audio\\system.wav")
            .unwrap(),
        library.audio_dir(&note.id).unwrap().join("system.wav")
    );
    assert!(
        library
            .audio_file_path(&note.id, "audio/../doc.json")
            .is_err()
    );
    assert!(library.audio_file_path(&note.id, "other/mic.wav").is_err());

    for id in ["CON", "nul", "com1", "LPT9", "..", "a:b", "C:x"] {
        assert!(!is_valid_id(id), "{id:?}");
        assert!(matches!(
            library.doc_dir(id),
            Err(LibraryError::InvalidId(_))
        ));
        assert!(matches!(library.load(id), Err(LibraryError::InvalidId(_))));
        assert!(library.delete_permanently(id).is_err());
    }

    let reserved = library.add_attachment(&note.id, "CON.png", b"p").unwrap();
    assert_eq!(reserved, "CON_.png");
    let streamed = library
        .add_attachment(&note.id, "C:\\Users\\me\\x.png:stream.png", b"p")
        .unwrap();
    assert_eq!(streamed, "x_png_stream.png");
    let dotted = library.add_attachment(&note.id, "...png", b"p").unwrap();
    assert_eq!(dotted, "image.png");
    for name in library.list_attachments(&note.id).unwrap() {
        assert!(is_plain_file_name(&name), "{name:?}");
    }
}

#[test]
fn search_ranks_every_hit_before_truncating() {
    let (_dir, library) = lib();
    let mut titled = library.create(DocKind::Note, t(1, 9), 1).unwrap();
    titled.title = "Budget review".into();
    library.save(&titled).unwrap();
    let mut newer = Vec::new();
    for i in 0..5u32 {
        let doc = library
            .create(DocKind::Note, t(2 + i, 9), 10 + u64::from(i))
            .unwrap();
        library
            .write_notes(&doc.id, r#"{"type":"text","text":"the budget is tight"}"#)
            .unwrap();
        newer.push(doc.id);
    }
    let hits = library
        .search(
            "budget",
            &SearchOptions {
                limit: 2,
                ..SearchOptions::default()
            },
        )
        .unwrap();
    let got: Vec<(&str, SearchField)> = hits.iter().map(|h| (h.id.as_str(), h.field)).collect();
    assert_eq!(
        got,
        vec![
            (titled.id.as_str(), SearchField::Title),
            (newer[4].as_str(), SearchField::Notes),
        ]
    );

    for limit in 1..=7 {
        let all = library
            .search(
                "budget",
                &SearchOptions {
                    limit: 100,
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        let cut = library
            .search(
                "budget",
                &SearchOptions {
                    limit,
                    ..SearchOptions::default()
                },
            )
            .unwrap();
        assert_eq!(cut, all[..limit.min(all.len())].to_vec(), "limit {limit}");
    }
}

#[test]
fn auto_titles() {
    assert_eq!(
        auto_title_from(&TitleHint {
            event_title: Some("  Weekly   sync "),
            app_name: Some("Zoom"),
            ..TitleHint::default()
        }),
        "Weekly sync"
    );
    assert_eq!(
        auto_title_from(&TitleHint {
            event_title: Some("  "),
            notes_markdown: Some("some text\n\n## Launch plan ##\n# Later"),
            ..TitleHint::default()
        }),
        "Launch plan"
    );
    let start = NaiveDate::from_ymd_opt(2026, 11, 12)
        .unwrap()
        .and_hms_opt(14, 5, 0)
        .unwrap();
    assert_eq!(
        auto_title_from(&TitleHint {
            notes_markdown: Some("#no space\nplain"),
            app_name: Some("Zoom"),
            local_start: Some(start),
            ..TitleHint::default()
        }),
        "Zoom at 14:05"
    );
    assert_eq!(
        auto_title_from(&TitleHint {
            local_start: Some(start),
            ..TitleHint::default()
        }),
        "Meeting at 14:05"
    );
    assert_eq!(auto_title_from(&TitleHint::default()), "Untitled");
    assert_eq!(first_markdown_heading("####### too deep"), None);
}

#[cfg(unix)]
#[test]
fn the_library_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("docs");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    Library::open(&root).unwrap();
    let mode = std::fs::metadata(&root).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o700,
        "an existing library folder is closed to other users"
    );
}

#[test]
fn a_trash_waits_for_a_meta_update_in_progress_and_both_changes_stay() {
    let (_dir, library) = lib();
    let id = library.create(DocKind::Meeting, t(3, 9), 1).unwrap().id;

    let engine = lock_meta();
    let mut meta = library.load(&id).unwrap();
    let (done_tx, done) = std::sync::mpsc::channel();
    let trash = std::thread::spawn({
        let (library, id) = (library.clone(), id.clone());
        move || {
            library.trash(&id, t(3, 10)).unwrap();
            done_tx.send(()).unwrap();
        }
    });
    assert!(
        done.recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "the trash landed inside another writer's load and save"
    );
    meta.title = "Weekly sync".into();
    library.save(&meta).unwrap();
    drop(engine);
    trash.join().unwrap();

    let meta = library.load(&id).unwrap();
    assert_eq!(meta.title, "Weekly sync");
    assert_eq!(meta.trashed_at, Some(t(3, 10)));
}

/// Records, when the cleanup lets go of its claim on a note, whether that
/// note's audio was already gone and saved as gone.
struct Claim<'a> {
    library: &'a Library,
    id: String,
    seen: &'a std::cell::RefCell<Vec<bool>>,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        let gone = !self.library.audio_dir(&self.id).unwrap().exists()
            && self
                .library
                .load(&self.id)
                .unwrap()
                .meeting
                .unwrap()
                .audio
                .is_empty();
        self.seen.borrow_mut().push(gone);
    }
}

#[test]
fn a_cleanup_claim_is_held_until_the_audio_is_gone_and_saved() {
    let (_dir, library) = lib();
    let mut old = library.create(DocKind::Meeting, t(1, 9), 1).unwrap();
    old.meeting.as_mut().unwrap().ended_at = Some(t(1, 10));
    old.meeting.as_mut().unwrap().audio = vec![AudioTrack {
        source: Source::System,
        file: "audio/system.ogg".into(),
        codec: "opus".into(),
        duration_ms: 1_000,
    }];
    library.save(&old).unwrap();
    let audio = library.audio_dir(&old.id).unwrap();
    std::fs::create_dir_all(&audio).unwrap();
    std::fs::write(audio.join("system.ogg"), b"ogg").unwrap();

    let seen = std::cell::RefCell::new(Vec::new());
    let swept = library
        .sweep_audio_claimed(t(10, 9), 7, |meta| {
            Some(Claim {
                library: &library,
                id: meta.id.clone(),
                seen: &seen,
            })
        })
        .unwrap();
    assert_eq!(swept.done, vec![old.id.clone()]);
    assert_eq!(*seen.borrow(), vec![true]);
}

#[test]
fn local_days_follow_each_dates_own_offset() {
    // A zone at UTC+1 in summer and UTC+0 in winter: 23:30 UTC on 9 July is
    // 00:30 on 10 July there, whatever the offset is today.
    let summer_start = Utc.with_ymd_and_hms(2026, 3, 29, 1, 0, 0).unwrap();
    let summer_end = Utc.with_ymd_and_hms(2026, 10, 25, 1, 0, 0).unwrap();
    let day_of = |at: DateTime<Utc>| {
        let offset = if at >= summer_start && at < summer_end {
            60
        } else {
            0
        };
        (at + chrono::Duration::minutes(offset)).date_naive()
    };
    let mk = |id: &str, at: DateTime<Utc>| DocMeta::new(id.into(), DocKind::Note, at);
    let docs = vec![
        mk("july", Utc.with_ymd_and_hms(2026, 7, 9, 23, 30, 0).unwrap()),
        mk("nov", Utc.with_ymd_and_hms(2026, 11, 9, 23, 30, 0).unwrap()),
    ];
    let groups = group_by_local_day(&docs, day_of);
    let shape: Vec<(NaiveDate, Vec<&str>)> = groups
        .iter()
        .map(|g| (g.date, g.ids.iter().map(String::as_str).collect()))
        .collect();
    assert_eq!(
        shape,
        vec![
            (NaiveDate::from_ymd_opt(2026, 11, 9).unwrap(), vec!["nov"]),
            (NaiveDate::from_ymd_opt(2026, 7, 10).unwrap(), vec!["july"]),
        ]
    );
}

#[test]
fn an_unreadable_doc_json_is_recovered_from_its_folder_and_kept_on_save() {
    let (_dir, lib) = lib();
    let made = Utc.with_ymd_and_hms(2026, 11, 18, 21, 54, 2).unwrap() + Duration::milliseconds(519);
    let id = "20261118T215402519Z-0y136b";
    let mut meta = DocMeta::new(id.into(), DocKind::Meeting, made);
    meta.title = "Weekly sync".into();
    lib.save(&meta).unwrap();
    let dir = lib.doc_dir(id).unwrap();
    fs::write(lib.transcript_path(id).unwrap(), "{\"op\":\"upsert\"}\n").unwrap();
    fs::create_dir_all(dir.join(AUDIO_DIR)).unwrap();
    fs::write(dir.join(AUDIO_DIR).join("you.ogg"), b"x").unwrap();
    fs::write(dir.join(AUDIO_DIR).join("others.ogg"), b"x").unwrap();

    for damage in [
        b"{\"id\": \"2026".to_vec(),
        Vec::new(),
        vec![0xff, 0xfe, 0x00, 0x13],
    ] {
        fs::write(dir.join(DOC_FILE), &damage).unwrap();
        assert!(matches!(lib.load(id), Err(LibraryError::Json(_))));
        let recovered = lib.load_or_recover(id).unwrap();
        assert_eq!(recovered.kind, DocKind::Meeting);
        assert_eq!(recovered.created_at, made);
        assert_eq!(recovered.extra.get(DAMAGED_KEY), Some(&Value::Bool(true)));
        let meeting = recovered.meeting.as_ref().unwrap();
        assert_eq!(meeting.started_at, Some(made));
        assert!(meeting.transcript_chars > 0);
        let files: Vec<(&str, Source)> = meeting
            .audio
            .iter()
            .map(|a| (a.file.as_str(), a.source))
            .collect();
        assert_eq!(
            files,
            vec![
                ("audio/others.ogg", Source::System),
                ("audio/you.ogg", Source::Mic)
            ]
        );
    }

    // The first save keeps what could not be read and writes clean details.
    let mut recovered = lib.load_or_recover(id).unwrap();
    recovered.title = "Renamed".into();
    lib.save(&recovered).unwrap();
    assert_eq!(
        fs::read(dir.join(DAMAGED_DOC_FILE)).unwrap(),
        vec![0xff, 0xfe, 0x00, 0x13]
    );
    let saved = lib.load(id).unwrap();
    assert_eq!(saved.title, "Renamed");
    assert!(!saved.extra.contains_key(DAMAGED_KEY));
}

#[test]
fn a_missing_or_unrecoverable_doc_is_still_not_found() {
    let (_dir, lib) = lib();
    let id = "20261118T215402519Z-0y136b";
    fs::create_dir_all(lib.doc_dir(id).unwrap()).unwrap();
    assert!(matches!(
        lib.load_or_recover(id),
        Err(LibraryError::NotFound(_))
    ));
    // A folder without a time in its name still recovers, as a note.
    let odd = "imported-note";
    let dir = lib.doc_dir(odd).unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(DOC_FILE), "nope").unwrap();
    let recovered = lib.load_or_recover(odd).unwrap();
    assert_eq!(recovered.kind, DocKind::Note);
    assert!(recovered.meeting.is_none());
}
