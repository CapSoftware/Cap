use std::collections::{HashMap, HashSet};

use cap_meetings::{
    library::{DocKind, DocMeta, Library, MeetingDetails},
    transcript::{LogLine, Source, Transcript, Utterance},
};
use cap_notes::Document;
use chrono::{Duration as ChronoDuration, NaiveDate, TimeZone, Utc};
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext};

use super::{
    bar::{
        Banner, EndedItem, Issue, RECORD_MORE_GUARD, banner_for, ended_item, level_to_height,
        record_more_open,
    },
    pane::{Pane, View},
    store::{DocStore, Row, Scope, Snapshot, build_rows},
    style::Palette,
    transcript::{TRow, TurnRow, build_rows as transcript_rows, common_prefix, word_at},
};
use crate::theme::Theme;

fn meta(id: &str, kind: DocKind, at: chrono::DateTime<Utc>) -> DocMeta {
    let mut meta = DocMeta::new(id.to_string(), kind, at);
    meta.title = id.to_string();
    meta
}

#[test]
fn rows_put_pinned_first_then_group_by_day() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
    let noon = |d: NaiveDate| Utc.from_utc_datetime(&d.and_hms_opt(12, 0, 0).unwrap());
    let yesterday = today.pred_opt().unwrap();
    let mut pinned = meta("p", DocKind::Note, noon(yesterday));
    pinned.pinned = true;
    let snapshot = Snapshot {
        docs: vec![
            meta("a", DocKind::Meeting, noon(today)),
            pinned,
            meta("b", DocKind::Note, noon(yesterday)),
        ],
        trashed: Vec::new(),
        folders: Vec::new(),
    };
    let rows = build_rows(&snapshot, &Scope::All, today, 0);
    assert_eq!(
        rows,
        vec![
            Row::Head,
            Row::Header("Pinned".into()),
            Row::Doc(1),
            Row::Header("Today".into()),
            Row::Doc(0),
            Row::Header("Yesterday".into()),
            Row::Doc(2),
            Row::Foot,
        ]
    );
    let pinned = build_rows(&snapshot, &Scope::Pinned, today, 0);
    assert_eq!(
        pinned,
        vec![
            Row::Head,
            Row::Header("Yesterday".into()),
            Row::Doc(1),
            Row::Foot
        ]
    );
}

#[test]
fn an_empty_library_still_has_a_home_page() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
    let rows = build_rows(&Snapshot::default(), &Scope::All, today, 0);
    assert_eq!(rows, vec![Row::Head, Row::Empty, Row::Foot]);
}

#[test]
fn folder_scope_hides_coming_up_and_other_folders() {
    let today = NaiveDate::from_ymd_opt(2026, 11, 12).unwrap();
    let at = Utc.from_utc_datetime(&today.and_hms_opt(9, 0, 0).unwrap());
    let mut inside = meta("in", DocKind::Note, at);
    inside.folder_id = Some("f-1".into());
    let snapshot = Snapshot {
        docs: vec![inside, meta("out", DocKind::Note, at)],
        trashed: vec![meta("gone", DocKind::Note, at)],
        folders: Vec::new(),
    };
    let rows = build_rows(&snapshot, &Scope::Folder("f-1".into()), today, 0);
    assert_eq!(
        rows,
        vec![
            Row::Head,
            Row::Header("Today".into()),
            Row::Doc(0),
            Row::Foot
        ]
    );
    let trash = build_rows(&snapshot, &Scope::Trash, today, 0);
    assert_eq!(trash, vec![Row::Head, Row::Trashed(0), Row::Foot]);
}

fn utterance(id: &str, source: Source, start_ms: u64, text: &str, is_final: bool) -> LogLine {
    LogLine::Upsert {
        utterance: Utterance {
            id: id.into(),
            source,
            start_ms,
            end_ms: start_ms + 1_500,
            text: text.into(),
            is_final,
            ..Utterance::default()
        },
    }
}

#[test]
fn transcript_rows_mark_you_partial_lines_and_stable_colours() {
    let mut t = Transcript::new();
    t.apply(utterance("a", Source::Mic, 0, "Hello", true));
    t.apply(utterance("b", Source::System, 5_000, "Hi there", true));
    t.apply(utterance("c", Source::System, 65_000, "Next minute", false));
    let mut colors = HashMap::new();
    let rows = transcript_rows(&t, None, None, &HashSet::new(), &mut colors);
    assert!(matches!(&rows[0], TRow::Minute { minute: 0, .. }));
    let TRow::Turn(you) = &rows[1] else {
        panic!("expected a turn")
    };
    assert_eq!(you.label, "You");
    assert_eq!(you.color, None);
    assert!(
        you.placeholder,
        "no name yet: renaming starts with it selected"
    );
    let TRow::Turn(others) = &rows[2] else {
        panic!("expected a turn")
    };
    assert_eq!(others.label, "Others");
    assert_eq!(others.color, Some(0));
    assert!(others.placeholder);
    assert!(matches!(&rows[3], TRow::Minute { minute: 1, .. }));
    let TRow::Turn(partial) = &rows[4] else {
        panic!("expected a turn")
    };
    assert!(partial.partial);
    assert_eq!(partial.color, Some(0));

    let mut hidden = HashSet::new();
    hidden.insert("b".to_string());
    let rows = transcript_rows(&t, None, None, &hidden, &mut colors);
    assert!(
        !rows
            .iter()
            .any(|r| matches!(r, TRow::Turn(turn) if turn.text == "Hi there"))
    );
}

#[test]
fn transcript_updates_keep_the_unchanged_prefix() {
    let mut t = Transcript::new();
    t.apply(utterance("a", Source::Mic, 0, "One", true));
    t.apply(utterance("b", Source::System, 5_000, "Two", false));
    let mut colors = HashMap::new();
    let before = transcript_rows(&t, None, None, &HashSet::new(), &mut colors);
    t.apply(utterance("b", Source::System, 5_000, "Two words", true));
    t.apply(utterance("c", Source::Mic, 9_000, "Three", true));
    let after = transcript_rows(&t, None, None, &HashSet::new(), &mut colors);
    assert_eq!(common_prefix(&before, &after), 2);
    assert_eq!(after.len(), 4);
}

#[test]
fn meter_draws_nothing_for_silence() {
    assert_eq!(level_to_height(0.), 0.);
    assert!(level_to_height(0.01) > 0.);
    assert!((level_to_height(1.) - 1.).abs() < f32::EPSILON);
    assert!(level_to_height(0.1) < level_to_height(0.5));
}

#[test]
fn search_emphasis_is_case_insensitive() {
    let ranges = super::home::char_ranges_ci("Roadmap and ROADS", "road");
    assert_eq!(ranges, vec![0..4, 12..16]);
    assert!(super::home::char_ranges_ci("abc", "  ").is_empty());
}

struct Fixture {
    _dir: tempfile::TempDir,
    library: Library,
    store: Entity<DocStore>,
    pane: Entity<Pane>,
}

fn fixture(cx: &mut TestAppContext) -> (Fixture, &mut VisualTestContext) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let now = Utc::now();
    for (i, kind) in [DocKind::Note, DocKind::Meeting, DocKind::Note]
        .into_iter()
        .enumerate()
    {
        let mut meta = library
            .create(
                kind.clone(),
                now - ChronoDuration::hours(i as i64),
                i as u64,
            )
            .unwrap();
        meta.title = format!("Doc {i}");
        meta.title_is_auto = false;
        if kind == DocKind::Meeting {
            meta.meeting = Some(MeetingDetails {
                started_at: Some(now - ChronoDuration::hours(i as i64)),
                duration_ms: 30 * 60_000,
                ..MeetingDetails::default()
            });
        }
        library.save(&meta).unwrap();
        library
            .write_notes(
                &meta.id,
                &Document::from_markdown(&format!("Note body {i}")).to_json(),
            )
            .unwrap();
    }
    let cx = cx.add_empty_window();
    let lib = library.clone();
    let store = cx.update(|_, cx| cx.new(|cx| DocStore::with_library(Some(lib), cx)));
    let theme = Theme::light();
    let pane = cx.update(|window, cx| {
        cx.new(|cx| {
            Pane::new(
                store.clone(),
                gpui::WeakEntity::new_invalid(),
                &theme,
                window,
                cx,
            )
        })
    });
    cx.run_until_parked();
    let first = store.read_with(cx, |s, _| s.snapshot.docs.first().map(|d| d.id.clone()));
    store.update(cx, |s, cx| s.open(first, cx));
    cx.run_until_parked();
    (
        Fixture {
            _dir: dir,
            library,
            store,
            pane,
        },
        cx,
    )
}

fn notes_markdown(library: &Library, id: &str) -> String {
    library
        .read_notes(id)
        .unwrap()
        .and_then(|json| Document::from_json(&json).ok())
        .map(|d| d.to_markdown())
        .unwrap_or_default()
}

#[gpui::test]
fn listing_lands_on_home_and_never_opens_a_note_by_itself(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    library.create(DocKind::Note, Utc::now(), 1).unwrap();
    let cx = cx.add_empty_window();
    let store = cx.update(|_, cx| cx.new(|cx| DocStore::with_library(Some(library), cx)));
    cx.run_until_parked();
    store.read_with(cx, |store, _| {
        assert!(store.listed);
        assert_eq!(store.snapshot.docs.len(), 1);
        assert_eq!(store.open, None);
    });
}

#[gpui::test]
fn opening_a_note_loads_its_body(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let (open, first) = f.store.read_with(cx, |store, _| {
        (
            store.open.clone(),
            store.snapshot.docs.first().map(|d| d.id.clone()),
        )
    });
    assert!(open.is_some());
    assert_eq!(open, first);
    f.pane.read_with(cx, |pane, cx| {
        assert_eq!(
            pane.notes.read(cx).document().to_markdown().trim(),
            "Note body 0"
        );
    });
}

#[gpui::test]
fn edits_save_after_the_debounce_and_on_switch(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let first = f.store.read_with(cx, |s, _| s.open.clone().unwrap());
    f.pane.update_in(cx, |pane, _, cx| {
        pane.notes.update(cx, |e, cx| {
            e.apply(
                |ed| {
                    ed.select_all();
                    ed.insert_text("Rewritten")
                },
                cx,
            )
        });
    });
    cx.run_until_parked();
    assert_eq!(notes_markdown(&f.library, &first).trim(), "Note body 0");
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(900));
    cx.run_until_parked();
    assert_eq!(notes_markdown(&f.library, &first).trim(), "Rewritten");

    f.pane.update_in(cx, |pane, _, cx| {
        pane.notes
            .update(cx, |e, cx| e.apply(|ed| ed.insert_text(" again"), cx));
    });
    let second = f.store.read_with(cx, |s, _| s.snapshot.docs[1].id.clone());
    f.store.update(cx, |s, cx| s.open(Some(second.clone()), cx));
    cx.run_until_parked();
    assert_eq!(notes_markdown(&f.library, &first).trim(), "Rewritten again");
    f.pane.read_with(cx, |pane, cx| {
        assert_eq!(
            pane.notes.read(cx).document().to_markdown().trim(),
            "Note body 1"
        );
    });
    assert_eq!(notes_markdown(&f.library, &second).trim(), "Note body 1");
}

#[gpui::test]
fn renaming_trashing_and_restoring_update_the_library(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let id = f.store.read_with(cx, |s, _| s.open.clone().unwrap());
    f.store
        .update(cx, |s, cx| s.rename(&id, "  Planning  ", None, cx));
    assert_eq!(f.library.load(&id).unwrap().title, "Planning");
    f.store.update(cx, |s, cx| s.trash(vec![id.clone()], cx));
    cx.run_until_parked();
    assert!(f.library.load(&id).unwrap().is_trashed());
    f.store.read_with(cx, |s, _| {
        assert!(s.snapshot.trashed.iter().any(|d| d.id == id));
        assert_eq!(s.open, None, "trashing the open note goes back home");
    });
    f.store.update(cx, |s, cx| s.restore(vec![id.clone()], cx));
    assert!(!f.library.load(&id).unwrap().is_trashed());
    f.store
        .update(cx, |s, cx| s.delete_permanently(vec![id.clone()], cx));
    assert!(f.library.load(&id).is_err());
}

#[gpui::test]
fn folders_and_new_notes(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let id = f.store.read_with(cx, |s, _| s.open.clone().unwrap());
    f.store.update(cx, |s, cx| {
        s.create_folder("Work".into(), vec![id.clone()], cx)
    });
    cx.run_until_parked();
    let folder = f.library.folders().unwrap()[0].id.clone();
    assert_eq!(
        f.library.load(&id).unwrap().folder_id.as_deref(),
        Some(folder.as_str())
    );
    f.store.update(cx, |s, cx| s.delete_folder(&folder, cx));
    assert!(f.library.load(&id).unwrap().folder_id.is_none());

    f.store
        .update(cx, |s, cx| s.create(DocKind::Note, None, cx));
    cx.run_until_parked();
    let (open, count) = f
        .store
        .read_with(cx, |s, _| (s.open.clone().unwrap(), s.snapshot.docs.len()));
    assert_eq!(count, 4);
    assert_eq!(f.library.load(&open).unwrap().kind, DocKind::Note);
}

#[gpui::test]
fn transcript_is_a_panel_only_meetings_have(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    f.pane.update_in(cx, |pane, window, cx| {
        pane.set_panel(true, cx);
        assert!(!pane.panel_open, "a plain note has no transcript");
        pane.show_view(View::Generated, window, cx);
        assert_eq!(pane.view, View::Mine);
    });
    let meeting = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .map(|d| d.id.clone())
            .unwrap()
    });
    f.store.update(cx, |s, cx| s.open(Some(meeting), cx));
    cx.run_until_parked();
    f.pane.update_in(cx, |pane, window, cx| {
        pane.show_view(View::Generated, window, cx);
        assert_eq!(pane.view, View::Mine, "no switch until notes exist");
        pane.toggle_transcript(window, cx);
        assert!(pane.panel_open);
        assert!(pane.dismiss(window, cx));
        assert!(
            !pane.panel_open,
            "escape folds the panel back into the pill"
        );
    });
    let other = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Note)
            .map(|d| d.id.clone())
            .unwrap()
    });
    f.pane.update(cx, |pane, cx| pane.set_panel(true, cx));
    f.store.update(cx, |s, cx| s.open(Some(other), cx));
    cx.run_until_parked();
    f.pane.read_with(cx, |pane, _| {
        assert!(!pane.panel_open, "switching notes closes it")
    });
}

fn active(state: crate::meetings::ActiveState) -> crate::meetings::ActiveMeeting {
    crate::meetings::ActiveMeeting {
        doc_id: "d".into(),
        title: String::new(),
        started_at: Utc::now(),
        started: std::time::Instant::now(),
        state,
        mic: crate::meetings::SourceState::default(),
        system: crate::meetings::SourceState::default(),
        engine: crate::meetings::EngineStatus::default(),
        warning: None,
        resume_offer_until: None,
        app_name: None,
        event_id: None,
        health: Vec::new(),
        not_hearing: false,
        audio_failed: false,
        low_disk: false,
    }
}

#[test]
fn the_banner_raises_one_problem_at_a_time_most_urgent_first() {
    use crate::meetings::{ActiveState, HealthIssue, MeetingWarning, SourceHealth};
    let now = std::time::Instant::now();
    let none = HashSet::new();
    assert_eq!(banner_for(None, &none, None, now), None);
    let mut live = active(ActiveState::Recording);
    assert_eq!(banner_for(Some(&live), &none, None, now), None);
    live.mic.health = SourceHealth::Silent;
    live.system.health = SourceHealth::Error(HealthIssue::MissingPermission);
    live.health = crate::meetings::health::concerns(&live);
    assert_eq!(
        banner_for(Some(&live), &none, None, now),
        Some(Banner::Issue(Issue::SystemPermission))
    );
    let mut dismissed = HashSet::new();
    dismissed.insert(Issue::SystemPermission);
    assert_eq!(
        banner_for(Some(&live), &dismissed, None, now),
        Some(Banner::Issue(Issue::MicSilent))
    );
    live.warning = Some(MeetingWarning::Inactivity {
        stop_at: now + std::time::Duration::from_secs(30),
    });
    assert!(matches!(
        banner_for(Some(&live), &none, None, now),
        Some(Banner::Inactive(29 | 30))
    ));
    let offered = active(ActiveState::ResumeOffered);
    assert_eq!(
        banner_for(Some(&offered), &none, None, now),
        Some(Banner::ResumeOffer)
    );
}

#[test]
fn palette_speakers_are_distinct() {
    let palette = Palette::new(&Theme::light());
    assert_ne!(palette.speaker(0), palette.speaker(1));
    assert_eq!(palette.speaker(0), palette.speaker(6));
}

#[test]
fn leaving_an_empty_note_removes_it_and_keeps_everything_else() {
    use super::pane::{LeaveAction, leave_action};
    // (meeting, titled, body_empty, heard_or_written, recording)
    assert_eq!(
        leave_action(false, false, true, false, false),
        LeaveAction::Delete
    );
    assert_eq!(
        leave_action(false, true, true, false, false),
        LeaveAction::Keep
    );
    assert_eq!(
        leave_action(false, false, false, false, false),
        LeaveAction::Keep
    );
    assert_eq!(
        leave_action(true, true, true, false, false),
        LeaveAction::Trash
    );
    assert_eq!(
        leave_action(true, false, true, false, false),
        LeaveAction::Trash
    );
    assert_eq!(
        leave_action(true, true, true, true, false),
        LeaveAction::Keep
    );
    assert_eq!(
        leave_action(true, true, false, false, false),
        LeaveAction::Keep
    );
    assert_eq!(
        leave_action(true, false, true, false, true),
        LeaveAction::Keep
    );
    assert_eq!(
        leave_action(false, false, true, false, true),
        LeaveAction::Keep
    );
}

#[test]
fn the_sidebar_is_shown_until_the_person_hides_it() {
    use super::window::sidebar_default;
    assert!(sidebar_default(None), "a new person sees the sidebar");
    assert!(!sidebar_default(Some(false)), "a hidden sidebar stays hidden");
    assert!(sidebar_default(Some(true)));
}

#[test]
fn an_ended_bar_shows_one_thing_never_a_status_line() {
    let now = std::time::Instant::now();
    assert_eq!(ended_item(true, Some(now), now), EndedItem::Writing);
    assert_eq!(
        ended_item(false, Some(now), now),
        EndedItem::RecordMore { open: false },
        "right after Stop, Record more waits out a double click"
    );
    assert_eq!(
        ended_item(false, Some(now), now + RECORD_MORE_GUARD),
        EndedItem::RecordMore { open: true }
    );
    assert_eq!(
        ended_item(false, None, now),
        EndedItem::RecordMore { open: true }
    );
}

#[test]
fn notes_follow_stop_only_when_they_will_really_be_written() {
    use super::pane::notes_follow_stop;
    use crate::meetings::AiAccess;
    assert!(notes_follow_stop(AiAccess::Ready, true, false, true));
    assert!(notes_follow_stop(
        AiAccess::Trial { remaining: 2 },
        true,
        false,
        true
    ));
    assert!(
        !notes_follow_stop(AiAccess::Ready, false, false, true),
        "automatic notes off"
    );
    assert!(
        !notes_follow_stop(AiAccess::Ready, true, true, true),
        "notes already there"
    );
    assert!(
        !notes_follow_stop(AiAccess::Ready, true, false, false),
        "too short"
    );
    for access in [
        AiAccess::NeedsSignIn,
        AiAccess::NeedsUpgrade,
        AiAccess::Unavailable,
    ] {
        assert!(!notes_follow_stop(access, true, false, true));
    }
}

#[test]
fn record_more_ignores_a_second_click_on_stop() {
    let now = std::time::Instant::now();
    assert!(
        record_more_open(None, now),
        "a note opened later records more at once"
    );
    assert!(!record_more_open(Some(now), now));
    assert!(!record_more_open(
        Some(now),
        now + RECORD_MORE_GUARD - std::time::Duration::from_millis(1)
    ));
    assert!(record_more_open(Some(now), now + RECORD_MORE_GUARD));
}

#[test]
fn right_click_picks_the_whole_word_without_punctuation() {
    let line = "I think Kap's great, really (Kap) and co-op.";
    assert_eq!(word_at(line, 9).as_deref(), Some("Kap"));
    assert_eq!(word_at(line, 8).as_deref(), Some("Kap"));
    assert_eq!(word_at(line, 30).as_deref(), Some("Kap"));
    assert_eq!(word_at(line, line.len() - 3).as_deref(), Some("co-op"));
    assert_eq!(word_at(line, 7), Some("think".into()));
    assert_eq!(word_at("a , b", 2), None);
    assert_eq!(word_at("", 0), None);
}

struct AskOverNotes {
    notes: Entity<cap_notes_ui::NotesEditor>,
    input: Entity<crate::ui::TextInputState>,
}

impl gpui::Render for AskOverNotes {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _, div, px};
        // The pane's layout: the page's editor fills the window, the dock
        // floats over its bottom edge.
        div()
            .size_full()
            .relative()
            .child(self.notes.clone())
            .child(
                div()
                    .absolute()
                    .bottom(px(16.))
                    .left(px(100.))
                    .right(px(100.))
                    .child(
                        super::pane::dock_ask().h(px(46.)).child(
                            crate::ui::TextInput::bare(&Theme::light(), "ask-input", &self.input)
                                .height(px(28.)),
                        ),
                    ),
            )
    }
}

#[gpui::test]
fn a_click_on_ask_focuses_ask_and_leaves_the_notes_alone(cx: &mut TestAppContext) {
    let markdown = (0..40)
        .map(|i| format!("Line {i} of the notes"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let (host, cx) = cx.add_window_view(|window, cx| {
        let notes = cx.new(|cx| {
            cap_notes_ui::NotesEditor::new(
                Document::from_markdown(&markdown),
                cap_notes_ui::NotesTheme::light(),
                cap_notes_ui::NotesLabels::default(),
                window,
                cx,
            )
        });
        let input = cx.new(|cx| crate::ui::TextInputState::single_line(window, cx));
        AskOverNotes { notes, input }
    });
    cx.simulate_resize(gpui::size(gpui::px(800.), gpui::px(600.)));
    cx.run_until_parked();
    let bounds = cx.debug_bounds("dock-ask").expect("the dock is drawn");
    let (notes, input) = host.read_with(cx, |h, _| (h.notes.clone(), h.input.clone()));
    let before = notes.read_with(cx, |n, _| n.document().to_markdown());
    cx.simulate_click(bounds.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    let (ask_focused, notes_focused) = cx.update(|window, cx| {
        (
            input.read(cx).focus_handle().is_focused(window),
            gpui::Focusable::focus_handle(notes.read(cx), cx).is_focused(window),
        )
    });
    assert!(ask_focused, "the click focuses Ask");
    assert!(!notes_focused, "the notes beneath do not take the click");
    cx.simulate_input("ab");
    cx.run_until_parked();
    assert_eq!(input.read_with(cx, |i, _| i.text().to_string()), "ab");
    assert_eq!(
        notes.read_with(cx, |n, _| n.document().to_markdown()),
        before,
        "typing after the click never edits the notes"
    );
}

#[gpui::test]
fn renaming_a_speaker_renames_the_summary_and_saves_it(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let meeting = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .map(|d| d.id.clone())
            .unwrap()
    });
    let mut summary = Document::from_markdown(
        "### Action items\n\n- Person 2: send the deck\n- Person 20 owns pricing\n",
    );
    for block in &mut summary.blocks {
        block.origin = cap_notes::Origin::Generated;
    }
    f.library
        .write_enhanced(&meeting, &summary.to_json())
        .unwrap();
    f.store.update(cx, |s, cx| {
        s.update_meta(
            &meeting,
            |meta| {
                if let Some(m) = meta.meeting.as_mut() {
                    m.has_enhanced = true;
                }
            },
            cx,
        )
    });
    f.store
        .update(cx, |s, cx| s.open(Some(meeting.clone()), cx));
    cx.run_until_parked();
    f.pane.update(cx, |pane, cx| {
        pane.rename_in_summary("Person 2", "Kristen", cx)
    });
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(900));
    cx.run_until_parked();
    let saved = f
        .library
        .read_enhanced(&meeting)
        .unwrap()
        .and_then(|json| Document::from_json(&json).ok())
        .unwrap();
    let md = saved.to_markdown();
    assert!(md.contains("Kristen: send the deck"), "{md}");
    assert!(md.contains("Person 20 owns pricing"), "{md}");
    assert!(
        saved
            .blocks
            .iter()
            .all(|b| b.origin == cap_notes::Origin::Generated),
        "still Cap's summary"
    );
    f.pane.read_with(cx, |pane, _| {
        assert!(
            !pane.enhanced_edited,
            "a rename is not an edit of the summary"
        )
    });
}

#[test]
fn streamed_and_saved_pages_match_whatever_their_block_ids() {
    let a = Document::from_markdown("### Summary\n\nShip it\n");
    let mut b = Document::from_markdown("### Summary\n\nShip it\n");
    for (i, block) in b.blocks.iter_mut().enumerate() {
        block.id = cap_notes::BlockId(100 + i as u64);
    }
    assert!(super::pane::same_page(&a, &b));
    let c = Document::from_markdown("### Summary\n\nShip it now\n");
    assert!(!super::pane::same_page(&a, &c));
}

#[test]
fn a_numbered_voice_is_found_however_the_summary_wrote_it() {
    assert_eq!(
        super::pane::summary_labels("Person 2"),
        vec!["Person 2", "Speaker 2"]
    );
    assert_eq!(super::pane::summary_labels("Ana"), vec!["Ana"]);
    assert_eq!(super::pane::summary_labels("Person"), vec!["Person"]);
}

#[test]
fn the_sidebar_keeps_recent_notes_at_hand_even_with_thousands() {
    let now = Utc::now();
    let docs: Vec<DocMeta> = (0..2_000)
        .map(|i| {
            let mut m = meta(
                &format!("d{i}"),
                DocKind::Note,
                now - ChronoDuration::minutes(i),
            );
            m.title = if i == 3 {
                "  ".into()
            } else {
                format!("Note {i}")
            };
            m
        })
        .collect();
    let today = chrono::Local::now().date_naive();
    let started = std::time::Instant::now();
    let rows = super::sidebar::recent_rows(&docs, today);
    let took = started.elapsed();
    assert_eq!(rows.len(), super::sidebar::RECENT);
    assert_eq!(rows[0].id, "d0", "newest first, as home lists them");
    assert_eq!(rows[3].title, crate::i18n::tr::documents::untitled());
    assert!(took < std::time::Duration::from_millis(5), "{took:?}");
}

#[gpui::test]
fn a_title_cap_chose_is_text_you_edit_and_typing_keeps_it(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler as _;
    let (f, cx) = fixture(cx);
    let id = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .unwrap()
            .id
            .clone()
    });
    // Cap named this meeting: the title is auto.
    f.store.update(cx, |s, cx| {
        s.rename(&id, "", Some("Budget review".into()), cx)
    });
    f.store.update(cx, |s, cx| s.open(Some(id.clone()), cx));
    cx.run_until_parked();
    assert!(f.library.load(&id).unwrap().title_is_auto);
    let title = f.pane.read_with(cx, |p, _| p.title.clone());
    assert_eq!(
        title.read_with(cx, |t, _| t.text().to_string()),
        "Budget review",
        "the title is the field's text, so typing edits it rather than replacing it"
    );

    // Focus and leave without typing: still Cap's title.
    f.pane
        .update_in(cx, |p, window, cx| p.focus_title(window, cx));
    f.pane
        .update_in(cx, |p, window, cx| p.focus_body(window, cx));
    cx.run_until_parked();
    assert!(f.library.load(&id).unwrap().title_is_auto);

    // Type at the end: the title grows and becomes the person's own.
    f.pane
        .update_in(cx, |p, window, cx| p.focus_title(window, cx));
    cx.update(|window, cx| {
        title.update(cx, |t, cx| {
            t.replace_text_in_range(None, " 2027", window, cx)
        })
    });
    assert_eq!(
        title.read_with(cx, |t, _| t.text().to_string()),
        "Budget review 2027"
    );
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(700));
    cx.run_until_parked();
    let meta = f.library.load(&id).unwrap();
    assert_eq!(meta.title, "Budget review 2027");
    assert!(
        !meta.title_is_auto,
        "an edited title is never renamed by a summary"
    );

    // Esc puts back the saved title.
    cx.update(|window, cx| {
        title.update(cx, |t, cx| t.replace_text_in_range(None, "!!", window, cx))
    });
    title.update(cx, |_, cx| cx.emit(crate::ui::TextInputEvent::Cancelled));
    cx.run_until_parked();
    assert_eq!(
        title.read_with(cx, |t, _| t.text().to_string()),
        "Budget review 2027"
    );
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(700));
    cx.run_until_parked();
    assert_eq!(f.library.load(&id).unwrap().title, "Budget review 2027");
}

#[test]
fn a_named_speaker_is_not_a_stand_in() {
    let mut t = Transcript::new();
    let mut named = utterance("a", Source::System, 0, "Morning", true);
    if let LogLine::Upsert { utterance } = &mut named {
        utterance.speaker = Some("Kristen".into());
    }
    t.apply(named);
    t.apply(utterance("b", Source::Mic, 3_000, "Hi", true));
    let mut colors = HashMap::new();
    let rows = transcript_rows(&t, None, Some("Richie"), &HashSet::new(), &mut colors);
    let turns: Vec<&TurnRow> = rows
        .iter()
        .filter_map(|r| match r {
            TRow::Turn(t) => Some(t),
            _ => None,
        })
        .collect();
    assert_eq!(turns[0].label, "Kristen");
    assert!(
        !turns[0].placeholder,
        "a real name keeps the caret at its end"
    );
    assert_eq!(turns[1].label, "Richie");
    assert!(!turns[1].placeholder, "the user's own name is a name");
}

#[gpui::test]
fn editing_when_a_meeting_happened_saves_it_and_moves_it_in_the_list(cx: &mut TestAppContext) {
    use chrono::{Datelike as _, Local, Timelike as _};
    let (f, cx) = fixture(cx);
    let meeting = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .map(|d| d.id.clone())
            .unwrap()
    });
    f.store
        .update(cx, |s, cx| s.open(Some(meeting.clone()), cx));
    cx.run_until_parked();
    let before = f.library.load(&meeting).unwrap();
    let start = before.meeting.as_ref().unwrap().started_at.unwrap();
    // A week earlier: last in the list now.
    let day = start.with_timezone(&Local).date_naive() - ChronoDuration::days(7);
    f.pane.update(cx, |p, cx| p.pick_when_day(day, cx));
    cx.run_until_parked();
    let after = f.library.load(&meeting).unwrap();
    let moved = after.meeting.as_ref().unwrap().started_at.unwrap();
    assert_eq!(moved.with_timezone(&Local).date_naive(), day);
    assert_eq!(
        moved - start,
        ChronoDuration::days(7) * -1,
        "same time of day"
    );
    f.store.read_with(cx, |s, _| {
        assert_eq!(
            s.snapshot.docs.last().map(|d| d.id.clone()),
            Some(meeting.clone()),
            "the list follows the new date"
        )
    });
    // A typed start time keeps the length; a bad one changes nothing.
    f.pane.update_in(cx, |p, window, cx| {
        p.apply_when_time("9:05 am", false, window, cx)
    });
    cx.run_until_parked();
    let timed = f.library.load(&meeting).unwrap();
    let local = timed
        .meeting
        .as_ref()
        .unwrap()
        .started_at
        .unwrap()
        .with_timezone(&Local);
    assert_eq!((local.hour(), local.minute()), (9, 5));
    assert_eq!(local.day(), day.day());
    f.pane.update_in(cx, |p, window, cx| {
        p.apply_when_time("soon", false, window, cx)
    });
    cx.run_until_parked();
    assert_eq!(
        f.library
            .load(&meeting)
            .unwrap()
            .meeting
            .unwrap()
            .started_at,
        timed.meeting.unwrap().started_at
    );
}

#[gpui::test]
fn a_finished_summary_counts_as_notes_before_the_store_catches_up(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let meeting = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .map(|d| d.id.clone())
            .unwrap()
    });
    f.store
        .update(cx, |s, cx| s.open(Some(meeting.clone()), cx));
    cx.run_until_parked();
    // Notes Done arrives before the store re-reads the note: the page must
    // not fall back to "no notes yet" (transcript, player, card) for a frame.
    f.pane.update(cx, |p, _| {
        assert!(!p.has_enhanced());
        p.notes_landed();
        assert!(p.has_enhanced());
    });
}

#[test]
fn an_answer_splits_into_the_sentences_that_can_carry_a_time() {
    let answer = "### Decisions\n\n- Ana wants import to be optional. Dev suggested the empty state.\nNot yet?";
    assert_eq!(
        super::ask::answer_sentences(answer),
        vec![
            String::new(),
            "Ana wants import to be optional.".to_string(),
            "Dev suggested the empty state.".to_string(),
            "Not yet?".to_string(),
        ],
        "headings never link; each sentence keeps its own place"
    );
    assert_eq!(
        super::ask::answer_sentences("Version 2.5 ships."),
        vec!["Version 2.5 ships.".to_string()],
        "a decimal point does not end a sentence"
    );
}

#[test]
fn summary_points_link_to_the_lines_they_came_from() {
    let turns: Vec<(String, String, u64, String)> = [
        (
            "Let's start with last week's numbers, we came in under.",
            "You",
            1_000,
            "u1",
        ),
        (
            "Events is the big one, so I'd move that budget into the launch video.",
            "Farah",
            14_000,
            "u2",
        ),
        (
            "The migration still needs an owner, nobody has six free weeks.",
            "Gus",
            31_000,
            "u3",
        ),
        (
            "Then let's bring in a contractor. Gus, can you check the terms with legal?",
            "You",
            44_000,
            "u4",
        ),
    ]
    .into_iter()
    .map(|(t, l, s, i)| (t.to_string(), l.to_string(), s, i.to_string()))
    .collect();
    let points = vec![
        (
            2,
            42,
            "Move the events budget to the launch video".to_string(),
        ),
        (5, 40, "Quarterly churn rose sharply in Europe".to_string()),
    ];
    let links = super::pane::link_points(points, turns);
    assert_eq!(links.len(), 1, "only the point that was said gets a link");
    assert_eq!(links[0].block, 2);
    assert_eq!(links[0].text_len, 42);
    assert_eq!(links[0].start_ms, 14_000);
    assert_eq!(links[0].ids, vec!["u2".to_string()]);
}

#[gpui::test]
fn the_page_items_sit_ahead_of_the_lines_and_room_after_them(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();
    let palette = super::style::Palette::new(&Theme::light());
    let transcript = cx.update(|_, cx| {
        cx.new(|cx| {
            super::transcript::TranscriptView::new(gpui::WeakEntity::new_invalid(), palette, cx)
        })
    });
    let count =
        |cx: &mut VisualTestContext| transcript.read_with(cx, |t, _| t.list_state().item_count());
    assert_eq!(count(cx), 0);
    let render: super::transcript::LeadRender =
        std::rc::Rc::new(|_, _, _| gpui::IntoElement::into_any_element(gpui::div()));
    transcript.update(cx, |t, cx| t.set_lead(Some((3, render, 100.)), cx));
    assert_eq!(
        count(cx),
        4,
        "three page items and the room after the lines"
    );
    transcript.update(cx, |t, cx| t.set_lead(None, cx));
    assert_eq!(count(cx), 0, "taking the page away leaves only the lines");
}

#[test]
fn a_summary_preview_is_its_first_paragraph_cut_on_a_word() {
    let mut doc = Document::from_markdown(
        "### Summary\n\nQ3 spend came in under plan.\n\n- Move the events budget",
    );
    for block in &mut doc.blocks {
        block.origin = cap_notes::Origin::Generated;
    }
    assert_eq!(
        super::pane::summary_preview(&doc).as_deref(),
        Some("Q3 spend came in under plan.")
    );
    let long = format!("{} end", "word ".repeat(60));
    let mut doc = Document::from_markdown(&long);
    doc.blocks[0].origin = cap_notes::Origin::Generated;
    let preview = super::pane::summary_preview(&doc).unwrap();
    assert!(preview.ends_with('\u{2026}') && preview.chars().count() <= 181);
    assert!(!preview.contains("wor\u{2026}"), "cut on a word: {preview}");
    let typed = Document::from_markdown("My own words");
    assert_eq!(
        super::pane::summary_preview(&typed),
        None,
        "only Cap's text"
    );
}

#[test]
fn a_trial_asks_mid_call_like_a_paid_plan_and_signed_out_still_cannot() {
    use super::ask::{Lock, lock_for};
    use crate::meetings::AiAccess;
    let trial = AiAccess::Trial { remaining: 2 };
    assert_eq!(
        lock_for(trial, false, true),
        None,
        "mid-call, before any notes"
    );
    assert_eq!(
        lock_for(trial, false, false),
        Some(Lock::Upgrade),
        "after the call a trial still needs its notes first"
    );
    assert_eq!(lock_for(trial, true, false), None);
    assert_eq!(lock_for(AiAccess::Ready, false, true), None);
    assert_eq!(
        lock_for(AiAccess::NeedsSignIn, false, true),
        Some(Lock::SignIn),
        "signed out stays locked mid-call"
    );
    assert_eq!(
        lock_for(AiAccess::NeedsUpgrade, false, true),
        Some(Lock::Upgrade),
        "a used-up trial stays locked mid-call"
    );
    assert_eq!(lock_for(AiAccess::Unavailable, false, true), None);
}

struct PageHost {
    transcript: Entity<super::transcript::TranscriptView>,
}

impl gpui::Render for PageHost {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _, div};
        div().size_full().child(self.transcript.clone())
    }
}

struct PageSummary {
    tall: bool,
    renders: usize,
    selector: &'static str,
    height: f32,
}

impl gpui::Render for PageSummary {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{InteractiveElement as _, Styled as _, div, px};
        self.renders += 1;
        let selector = self.selector;
        div()
            .debug_selector(move || selector.into())
            .w_full()
            .h(px(if self.tall { self.height * 3. } else { self.height }))
    }
}

#[gpui::test]
fn typing_in_the_page_summary_leaves_the_lines_alone(cx: &mut TestAppContext) {
    use gpui::{IntoElement as _, ParentElement as _, Styled as _, div, px};
    let palette = super::style::Palette::new(&Theme::light());
    let (host, cx) = cx.add_window_view(|_, cx| PageHost {
        transcript: cx.new(|cx| {
            super::transcript::TranscriptView::new(gpui::WeakEntity::new_invalid(), palette, cx)
        }),
    });
    let transcript = host.read_with(cx, |h, _| h.transcript.clone());
    let view = |selector: &'static str, height: f32, cx: &mut VisualTestContext| {
        cx.update(|_, cx| {
            cx.new(|_| PageSummary {
                tall: false,
                renders: 0,
                selector,
                height,
            })
        })
    };
    let header = view("page-header", 50., cx);
    let summary = view("page-summary", 40., cx);
    let (h, s) = (header.clone(), summary.clone());
    let render: super::transcript::LeadRender = std::rc::Rc::new(move |index, _, _| match index {
        0 => div().w_full().child(h.clone()).into_any_element(),
        1 => div().w_full().child(s.clone()).into_any_element(),
        _ => div().w_full().h(px(30.)).into_any_element(),
    });
    // Room after the lines so the page is taller than the window and can
    // scroll past its header.
    transcript.update(cx, |t, cx| t.set_lead(Some((3, render, 1000.)), cx));
    cx.simulate_resize(gpui::size(px(800.), px(600.)));
    cx.run_until_parked();
    let lines = |cx: &mut VisualTestContext| transcript.read_with(cx, |t, cx| t.lines_renders(cx));
    let heading = |cx: &mut VisualTestContext| {
        transcript
            .read_with(cx, |t, _| t.list_state().bounds_for_item(2))
            .expect("the heading is laid out")
    };
    let placed = |cx: &mut VisualTestContext| cx.debug_bounds("page-summary").expect("drawn");
    let drawn = lines(cx);
    assert!(drawn > 0);
    assert_eq!(
        cx.debug_bounds("page-header").expect("drawn").bottom(),
        placed(cx).top(),
        "the summary follows the header"
    );
    assert_eq!(
        heading(cx).top(),
        placed(cx).bottom(),
        "the heading follows the summary"
    );

    let before = summary.read_with(cx, |s, _| s.renders);
    summary.update(cx, |_, cx| cx.notify());
    cx.run_until_parked();
    assert!(
        summary.read_with(cx, |s, _| s.renders) > before,
        "the summary repaints"
    );
    assert_eq!(
        lines(cx),
        drawn,
        "a key in the summary leaves the lines alone"
    );

    summary.update(cx, |s, cx| {
        s.tall = true;
        cx.notify();
    });
    cx.run_until_parked();
    assert_eq!(placed(cx).size.height, px(120.));
    assert_eq!(
        heading(cx).top(),
        placed(cx).bottom(),
        "a taller summary moves the lines down with it"
    );
    assert!(lines(cx) > drawn);

    let drawn = lines(cx);
    transcript.update(cx, |t, cx| t.set_width(500., cx));
    cx.run_until_parked();
    assert!(lines(cx) > drawn, "a change to the lines repaints them");

    // Scrolled past the header: like the list's own items, it is no longer
    // built, while the summary still shows.
    transcript.update(cx, |t, cx| {
        t.list_state().scroll_to(gpui::ListOffset {
            item_ix: 1,
            offset_in_item: px(0.),
        });
        t.changed(cx);
    });
    cx.run_until_parked();
    let header_renders = header.read_with(cx, |h, _| h.renders);
    summary.update(cx, |_, cx| cx.notify());
    header.update(cx, |_, cx| cx.notify());
    cx.run_until_parked();
    assert_eq!(
        header.read_with(cx, |h, _| h.renders),
        header_renders,
        "a header scrolled out of view is not drawn"
    );
    assert_eq!(placed(cx).top(), px(0.), "the summary sits at the top");
}

#[test]
fn the_writing_line_names_the_connection_only_when_offline() {
    use super::bar::writing_line;
    assert_eq!(
        writing_line(None),
        crate::i18n::tr::documents::notes::writing()
    );
    assert_eq!(writing_line(Some(true)), "Waiting for a connection…");
    assert_eq!(
        writing_line(Some(false)),
        "Cap AI is having trouble. Trying again…"
    );
}

#[test]
fn an_answer_that_stops_partway_does_not_blame_the_connection() {
    use crate::meetings::NotesError;
    let text = super::pane::notes_error_text(&NotesError::Interrupted("cut".into()));
    assert_eq!(text, "Cap AI stopped partway.");
    assert_ne!(
        text,
        super::pane::notes_error_text(&NotesError::Offline("cut".into()))
    );
}

#[gpui::test]
fn a_title_sent_with_notes_that_failed_goes_back_to_the_saved_one(cx: &mut TestAppContext) {
    use gpui::EntityInputHandler as _;
    let (f, cx) = fixture(cx);
    let id = f.store.read_with(cx, |s, _| {
        s.snapshot
            .docs
            .iter()
            .find(|d| d.kind == DocKind::Meeting)
            .unwrap()
            .id
            .clone()
    });
    f.store.update(cx, |s, cx| {
        s.rename(&id, "", Some("Meeting at 5:46 PM".into()), cx)
    });
    f.store.update(cx, |s, cx| s.open(Some(id.clone()), cx));
    cx.run_until_parked();
    let title = f.pane.read_with(cx, |p, _| p.title.clone());
    let shown = |cx: &mut VisualTestContext| title.read_with(cx, |t, _| t.text().to_string());

    // Cap AI's title lands with the first words, then the notes fail.
    f.pane.update_in(cx, |p, window, cx| {
        p.land_title("Roadmap review", window, cx)
    });
    assert_eq!(shown(cx), "Roadmap review");
    f.pane
        .update_in(cx, |p, window, cx| p.unland_title(window, cx));
    assert_eq!(
        shown(cx),
        "Meeting at 5:46 PM",
        "the page shows what is saved"
    );
    assert_eq!(f.library.load(&id).unwrap().title, "Meeting at 5:46 PM");

    // A title the person changed stays theirs.
    f.pane.update_in(cx, |p, window, cx| {
        p.land_title("Roadmap review", window, cx)
    });
    cx.update(|window, cx| {
        title.update(cx, |t, cx| t.replace_text_in_range(None, " v2", window, cx))
    });
    f.pane
        .update_in(cx, |p, window, cx| p.unland_title(window, cx));
    let kept = shown(cx);
    assert!(kept.contains("v2"), "{kept}");
    assert_ne!(kept, "Meeting at 5:46 PM");
}

/// A library of notes on disk, open in a window that draws the pane, so keys
/// go through the editors' real input path.
fn drawn_pane<'a>(
    cx: &'a mut TestAppContext,
    docs: &[(DocKind, &str, Option<&str>)],
) -> (
    tempfile::TempDir,
    Library,
    Vec<String>,
    Entity<Pane>,
    Entity<DocStore>,
    &'a mut VisualTestContext,
) {
    use gpui::{px, size};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let now = Utc::now();
    let mut ids = Vec::new();
    for (i, (kind, notes, summary)) in docs.iter().enumerate() {
        let mut meta = library
            .create(kind.clone(), now - ChronoDuration::minutes(i as i64), i as u64)
            .unwrap();
        // A note written "untitled: ..." is left without a title.
        let (title, notes) = match notes.strip_prefix("untitled: ") {
            Some(body) => (String::new(), body),
            None => (format!("Doc {i}"), *notes),
        };
        meta.title_is_auto = title.is_empty();
        meta.title = title;
        if *kind == DocKind::Meeting {
            meta.meeting = Some(MeetingDetails {
                started_at: Some(now),
                duration_ms: 60_000,
                has_enhanced: summary.is_some(),
                ..MeetingDetails::default()
            });
        }
        library.save(&meta).unwrap();
        library
            .write_notes(&meta.id, &Document::from_markdown(notes).to_json())
            .unwrap();
        if let Some(summary) = summary {
            let mut page = Document::from_markdown(summary);
            for block in &mut page.blocks {
                block.origin = cap_notes::Origin::Generated;
            }
            library.write_enhanced(&meta.id, &page.to_json()).unwrap();
        }
        ids.push(meta.id.clone());
    }
    let lib = library.clone();
    let (host, cx) = cx.add_window_view(|window, cx| {
        let store = cx.new(|cx| DocStore::with_library(Some(lib), cx));
        let pane = cx.new(|cx| {
            Pane::new(
                store.clone(),
                gpui::WeakEntity::new_invalid(),
                &Theme::light(),
                window,
                cx,
            )
        });
        PaneHost { pane, store }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.run_until_parked();
    let (pane, store) = host.read_with(cx, |h, _| (h.pane.clone(), h.store.clone()));
    (dir, library, ids, pane, store, cx)
}

fn summary_markdown(library: &Library, id: &str) -> String {
    library
        .read_enhanced(id)
        .unwrap()
        .and_then(|json| Document::from_json(&json).ok())
        .map(|d| d.to_markdown())
        .unwrap_or_default()
}

/// Each way the open note gets saved: the typing pause, leaving the field,
/// switching notes, closing the window.
fn every_save_trigger(
    pane: &Entity<Pane>,
    store: &Entity<DocStore>,
    other: &str,
    cx: &mut VisualTestContext,
    check: &dyn Fn(&mut VisualTestContext, &str),
) {
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(900));
    cx.run_until_parked();
    check(cx, "after the typing pause");
    pane.update_in(cx, |p, window, cx| p.focus_title(window, cx));
    cx.run_until_parked();
    check(cx, "after leaving the field");
    store.update(cx, |s, cx| s.open(Some(other.to_string()), cx));
    cx.run_until_parked();
    check(cx, "after switching notes");
    pane.update(cx, |p, cx| p.closing(cx));
    cx.run_until_parked();
    check(cx, "after closing");
}

#[gpui::test]
fn a_key_typed_before_the_saved_note_loads_never_costs_the_saved_text(cx: &mut TestAppContext) {
    let (_dir, library, ids, pane, store, cx) = drawn_pane(
        cx,
        &[
            (DocKind::Note, "First note", None),
            (DocKind::Note, "The saved second note", None),
        ],
    );
    store.update(cx, |s, cx| s.open(Some(ids[0].clone()), cx));
    cx.run_until_parked();
    pane.update_in(cx, |p, window, cx| p.focus_body(window, cx));
    cx.run_until_parked();
    // Switch, and type one key before the saved text has loaded.
    store.update(cx, |s, cx| s.open(Some(ids[1].clone()), cx));
    cx.simulate_input("x");
    cx.run_until_parked();
    let notes = pane.read_with(cx, |p, _| p.notes.clone());
    assert_eq!(
        notes.read_with(cx, |e, _| e.document().to_markdown().trim().to_string()),
        "The saved second note",
        "the page shows the saved text"
    );
    let (lib, id) = (library.clone(), ids[1].clone());
    every_save_trigger(&pane, &store, &ids[0], cx, &|_, when| {
        assert_eq!(
            notes_markdown(&lib, &id).trim(),
            "The saved second note",
            "the saved text is still on disk {when}"
        );
    });
}

#[gpui::test]
fn a_key_typed_before_the_saved_summary_loads_never_costs_the_saved_summary(
    cx: &mut TestAppContext,
) {
    let (_dir, library, ids, pane, store, cx) = drawn_pane(
        cx,
        &[
            (DocKind::Meeting, "", Some("The first summary.")),
            (DocKind::Meeting, "", Some("The saved second summary.")),
        ],
    );
    store.update(cx, |s, cx| s.open(Some(ids[0].clone()), cx));
    cx.run_until_parked();
    pane.update_in(cx, |p, window, cx| {
        p.show_view(View::Generated, window, cx);
        p.focus_body(window, cx);
    });
    cx.run_until_parked();
    store.update(cx, |s, cx| s.open(Some(ids[1].clone()), cx));
    cx.simulate_input("x");
    cx.run_until_parked();
    let enhanced = pane.read_with(cx, |p, _| p.enhanced.clone());
    assert_eq!(
        enhanced.read_with(cx, |e, _| e.document().to_markdown().trim().to_string()),
        "The saved second summary.",
        "the page shows the saved summary"
    );
    let (lib, id) = (library.clone(), ids[1].clone());
    every_save_trigger(&pane, &store, &ids[0], cx, &|_, when| {
        assert_eq!(
            summary_markdown(&lib, &id).trim(),
            "The saved second summary.",
            "the saved summary is still on disk {when}"
        );
    });
}

#[gpui::test]
fn a_note_that_fails_to_load_stays_read_only_and_is_never_saved_over(cx: &mut TestAppContext) {
    let (_dir, library, ids, pane, store, cx) = drawn_pane(
        cx,
        &[
            (DocKind::Note, "First note", None),
            (DocKind::Note, "Second note", None),
        ],
    );
    // Its saved notes exist but cannot be understood.
    let path = library
        .doc_dir(&ids[1])
        .unwrap()
        .join(cap_meetings::library::NOTES_FILE);
    std::fs::write(&path, "{ not a page").unwrap();
    store.update(cx, |s, cx| s.open(Some(ids[0].clone()), cx));
    cx.run_until_parked();
    pane.update_in(cx, |p, window, cx| p.focus_body(window, cx));
    cx.run_until_parked();
    store.update(cx, |s, cx| s.open(Some(ids[1].clone()), cx));
    cx.run_until_parked();
    cx.simulate_input("typed");
    cx.run_until_parked();
    let notes = pane.read_with(cx, |p, _| p.notes.clone());
    assert!(
        notes.read_with(cx, |e, _| e.is_read_only()),
        "a page that did not load is read-only"
    );
    assert_eq!(
        notes.read_with(cx, |e, _| e.document().to_markdown().trim().to_string()),
        "",
        "nothing typed lands on it"
    );
    every_save_trigger(&pane, &store, &ids[0], cx, &|_, when| {
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{ not a page",
            "the unreadable file is untouched {when}"
        );
    });
}

#[gpui::test]
fn leaving_an_untitled_note_before_it_loads_never_deletes_it(cx: &mut TestAppContext) {
    let (_dir, library, ids, pane, store, cx) = drawn_pane(
        cx,
        &[
            (DocKind::Note, "Titled note", None),
            (DocKind::Note, "untitled: Untitled but written", None),
        ],
    );
    store.update(cx, |s, cx| s.open(Some(ids[0].clone()), cx));
    cx.run_until_parked();
    // Open it and leave again before its text has loaded.
    store.update(cx, |s, cx| s.open(Some(ids[1].clone()), cx));
    pane.read_with(cx, |p, cx| {
        let doc = p.doc.as_ref().expect("open");
        assert!(doc.title.is_empty() && doc.title_is_auto, "untitled");
        assert!(p.title.read(cx).text().is_empty());
    });
    store.update(cx, |s, cx| s.open(Some(ids[0].clone()), cx));
    cx.run_until_parked();
    assert_eq!(
        notes_markdown(&library, &ids[1]).trim(),
        "Untitled but written",
        "a note left before it loaded is kept, not tidied away"
    );
}

#[gpui::test]
fn notes_are_written_from_what_was_typed_not_a_save_still_queued(cx: &mut TestAppContext) {
    let (f, cx) = fixture(cx);
    let first = f.store.read_with(cx, |s, _| s.open.clone().unwrap());
    f.pane.update_in(cx, |pane, _, cx| {
        pane.notes.update(cx, |e, cx| {
            e.apply(
                |ed| {
                    ed.select_all();
                    ed.insert_text("Typed just now")
                },
                cx,
            )
        });
    });
    cx.run_until_parked();
    // Write is clicked while the flushed save is still queued on the writer.
    super::writer::hold();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(None));
    f.pane.update_in(cx, |pane, _, cx| {
        pane.flush_saves(cx);
        let (seen, library, id) = (seen.clone(), f.library.clone(), first.clone());
        pane.after_saves(cx, move |_| {
            *seen.borrow_mut() = Some(notes_markdown(&library, &id));
            gpui::Task::ready(())
        })
        .detach();
    });
    super::writer::release();
    cx.run_until_parked();
    assert_eq!(
        seen.borrow().as_deref().map(str::trim),
        Some("Typed just now"),
        "writing starts from the notes as typed"
    );
}

struct PaneHost {
    pane: Entity<Pane>,
    store: Entity<DocStore>,
}

impl gpui::Render for PaneHost {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _, div};
        div().size_full().child(self.pane.clone())
    }
}

/// The real page: a finished meeting with Cap's notes and its lines, drawn in
/// a window. Its header and summary float over the lines; a key in the
/// summary redraws neither the lines nor the header, a key in the title
/// redraws the header.
#[gpui::test]
fn the_real_page_header_and_summary_float_over_the_lines(cx: &mut TestAppContext) {
    use gpui::{px, size};
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let now = Utc::now();
    let mut meta = library.create(DocKind::Meeting, now, 0).unwrap();
    meta.title = "Weekly sync".into();
    meta.title_is_auto = false;
    meta.meeting = Some(MeetingDetails {
        started_at: Some(now),
        duration_ms: 60_000,
        has_enhanced: true,
        ..MeetingDetails::default()
    });
    library.save(&meta).unwrap();
    let mut summary = Document::from_markdown("### Summary\n\nWe shipped the page.");
    for block in &mut summary.blocks {
        block.origin = cap_notes::Origin::Generated;
    }
    library.write_enhanced(&meta.id, &summary.to_json()).unwrap();
    let mut lines = Transcript::new();
    lines.apply(utterance("u1", Source::Mic, 0, "We shipped the page today.", true));
    lines.apply(utterance("u2", Source::System, 4_000, "Great work, everyone.", true));
    let lib = library.clone();
    let (host, cx) = cx.add_window_view(|window, cx| {
        let store = cx.new(|cx| DocStore::with_library(Some(lib), cx));
        let pane = cx.new(|cx| {
            Pane::new(
                store.clone(),
                gpui::WeakEntity::new_invalid(),
                &Theme::light(),
                window,
                cx,
            )
        });
        PaneHost { pane, store }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.run_until_parked();
    let (pane, store) = host.read_with(cx, |h, _| (h.pane.clone(), h.store.clone()));
    store.update(cx, |s, cx| s.open(Some(meta.id.clone()), cx));
    cx.run_until_parked();
    let transcript = pane.read_with(cx, |p, _| p.transcript.clone());
    transcript.update(cx, |t, cx| t.load_for_test(&lines, cx));
    pane.update_in(cx, |p, window, cx| p.show_view(View::Generated, window, cx));
    cx.run_until_parked();
    assert!(
        pane.read_with(cx, |p, _| p.page_mode()),
        "a finished meeting with notes and lines shows as one page"
    );
    let (header_h, summary_h) =
        transcript.read_with(cx, |t, _| (t.float_height(0), t.float_height(1)));
    assert!(header_h > px(0.) && summary_h > px(0.), "both float over the lines");

    let lines = |cx: &mut VisualTestContext| transcript.read_with(cx, |t, cx| t.lines_renders(cx));
    let headers = |cx: &mut VisualTestContext| pane.read_with(cx, |p, cx| p.header_renders(cx));
    let (lines_before, headers_before) = (lines(cx), headers(cx));
    let enhanced = pane.read_with(cx, |p, _| p.enhanced.clone());
    enhanced.update(cx, |e, cx| e.apply(|ed| ed.insert_text("Also "), cx));
    cx.run_until_parked();
    assert_eq!(lines(cx), lines_before, "a summary key leaves the lines alone");
    assert_eq!(headers(cx), headers_before, "and the header");

    pane.update_in(cx, |p, window, cx| p.focus_title(window, cx));
    cx.run_until_parked();
    let headers_before = headers(cx);
    cx.simulate_input("!");
    cx.run_until_parked();
    assert!(headers(cx) > headers_before, "a title key redraws the header");
    assert_eq!(
        pane.read_with(cx, |p, cx| p.title.read(cx).text().to_string()),
        "Weekly sync!"
    );
}

#[test]
fn the_missed_audio_line_rounds_to_what_a_person_would_say() {
    use super::bar::health_line::missed_line;
    assert_eq!(
        missed_line(20_141),
        "About 20 seconds of this meeting weren’t recorded."
    );
    assert_eq!(
        missed_line(35_143),
        "About 35 seconds of this meeting weren’t recorded."
    );
    assert_eq!(
        missed_line(5_000),
        "About 5 seconds of this meeting weren’t recorded."
    );
    assert_eq!(
        missed_line(58_000),
        "About 1 minute of this meeting wasn’t recorded."
    );
    assert_eq!(
        missed_line(125_000),
        "About 2 minutes of this meeting weren’t recorded."
    );
}
