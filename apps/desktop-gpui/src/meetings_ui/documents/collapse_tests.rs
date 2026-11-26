//! The page's transcript folding to its heading.

use cap_meetings::{
    library::{DocKind, Library, MeetingDetails},
    transcript::{LogLine, Source, Transcript, Utterance},
};
use cap_notes::Document;
use chrono::Utc;
use gpui::{AppContext as _, Entity, TestAppContext, VisualTestContext, px, size};

use super::{
    pane::{Pane, View},
    store::DocStore,
    style::Palette,
    transcript::{LeadRender, TranscriptView, saved_collapsed_for_test},
};
use crate::theme::Theme;

fn line(id: &str, source: Source, start_ms: u64, text: &str) -> LogLine {
    LogLine::Upsert {
        utterance: Utterance {
            id: id.into(),
            source,
            start_ms,
            end_ms: start_ms + 1_500,
            text: text.into(),
            is_final: true,
            ..Utterance::default()
        },
    }
}

fn lines(n: usize) -> Transcript {
    let mut t = Transcript::new();
    for i in 0..n {
        let source = if i % 2 == 0 {
            Source::Mic
        } else {
            Source::System
        };
        t.apply(line(
            &format!("u{i}"),
            source,
            i as u64 * 4_000,
            &format!("Line number {i}."),
        ));
    }
    t
}

fn standalone(cx: &mut VisualTestContext) -> Entity<TranscriptView> {
    let palette = Palette::new(&Theme::light());
    cx.update(|_, cx| {
        cx.new(|cx| TranscriptView::new(gpui::WeakEntity::new_invalid(), palette, cx))
    })
}

fn page(transcript: &Entity<TranscriptView>, cx: &mut VisualTestContext) {
    let render: LeadRender =
        std::rc::Rc::new(|_, _, _| gpui::IntoElement::into_any_element(gpui::div()));
    transcript.update(cx, |t, cx| t.set_lead(Some((3, render, 100.)), cx));
}

fn items(transcript: &Entity<TranscriptView>, cx: &mut VisualTestContext) -> usize {
    transcript.read_with(cx, |t, _| t.list_state().item_count())
}

/// Folded, the page holds its three items and the room after them; lines
/// that arrive meanwhile stay out until it opens, then all of them show.
#[gpui::test]
fn a_folded_page_keeps_its_items_and_takes_new_lines_when_opened(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();
    let transcript = standalone(cx);
    page(&transcript, cx);
    transcript.update(cx, |t, cx| t.load_for_test(&lines(4), cx));
    let four = items(&transcript, cx);
    assert!(
        four > 3 + 1,
        "the lines sit between the page items and the room after"
    );

    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    assert!(transcript.read_with(cx, |t, _| t.collapsed()));
    assert_eq!(
        items(&transcript, cx),
        3 + 1,
        "only the page items and the room after"
    );
    assert!(
        saved_collapsed_for_test(),
        "the heading's toggle is remembered"
    );

    transcript.update(cx, |t, cx| t.load_for_test(&lines(7), cx));
    assert_eq!(items(&transcript, cx), 3 + 1, "new lines wait while folded");

    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    assert!(
        items(&transcript, cx) > four,
        "opened, it holds every line, new ones too"
    );
    assert!(!saved_collapsed_for_test());

    let opened = items(&transcript, cx);
    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    assert_eq!(items(&transcript, cx), opened);
}

/// Taking the page away (the side panel) shows every line whatever was
/// saved, and putting it back folds it again.
#[gpui::test]
fn only_the_page_folds(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();
    let transcript = standalone(cx);
    page(&transcript, cx);
    transcript.update(cx, |t, cx| t.load_for_test(&lines(5), cx));
    let rows = items(&transcript, cx) - 4;
    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    assert_eq!(items(&transcript, cx), 4);

    transcript.update(cx, |t, cx| t.set_lead(None, cx));
    assert!(!transcript.read_with(cx, |t, _| t.collapsed()));
    assert_eq!(items(&transcript, cx), rows, "the panel shows every line");

    page(&transcript, cx);
    assert_eq!(items(&transcript, cx), 4, "the page folds again");
}

/// A source clicked in the notes, Find and Show Transcript open the lines,
/// but only for this page: the saved choice stays folded.
#[gpui::test]
fn showing_a_line_opens_the_page_without_changing_the_saved_choice(cx: &mut TestAppContext) {
    let cx = cx.add_empty_window();
    let transcript = standalone(cx);
    page(&transcript, cx);
    transcript.update(cx, |t, cx| t.load_for_test(&lines(30), cx));
    let full = items(&transcript, cx);
    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));

    transcript.update(cx, |t, cx| t.reveal_ids(&["u20".to_string()], cx));
    assert!(!transcript.read_with(cx, |t, _| t.collapsed()));
    assert_eq!(items(&transcript, cx), full);
    let top = transcript.read_with(cx, |t, _| t.list_state().logical_scroll_top().item_ix);
    assert!(top > 3 + 15, "scrolled down to the line ({top})");
    assert!(saved_collapsed_for_test(), "still folded for the next note");

    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    transcript.update_in(cx, |t, window, cx| t.open_find(window, cx));
    assert!(
        !transcript.read_with(cx, |t, _| t.collapsed()),
        "Find opens it"
    );

    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    transcript.update(cx, |t, cx| t.reveal_start(cx));
    assert!(
        !transcript.read_with(cx, |t, _| t.collapsed()),
        "Show Transcript opens it"
    );
    assert!(saved_collapsed_for_test());
}

struct Host {
    pane: Entity<Pane>,
    store: Entity<DocStore>,
}

impl gpui::Render for Host {
    fn render(
        &mut self,
        _: &mut gpui::Window,
        _: &mut gpui::Context<Self>,
    ) -> impl gpui::IntoElement {
        use gpui::{ParentElement as _, Styled as _, div};
        div().size_full().child(self.pane.clone())
    }
}

/// The real page, drawn: folding keeps the header and summary floating over
/// the list, and a linked point in the summary opens the lines at its source.
#[gpui::test]
fn the_real_page_folds_and_a_source_opens_it(cx: &mut TestAppContext) {
    let dir = tempfile::tempdir().unwrap();
    let library = Library::open(dir.path().join("documents")).unwrap();
    let now = Utc::now();
    let mut meta = library.create(DocKind::Meeting, now, 0).unwrap();
    meta.title = "Weekly sync".into();
    meta.title_is_auto = false;
    meta.meeting = Some(MeetingDetails {
        started_at: Some(now),
        duration_ms: 120_000,
        has_enhanced: true,
        ..MeetingDetails::default()
    });
    library.save(&meta).unwrap();
    let mut summary = Document::from_markdown(
        "### Summary\n\n- We agreed to ship the new pricing page on Friday.",
    );
    for block in &mut summary.blocks {
        block.origin = cap_notes::Origin::Generated;
    }
    library
        .write_enhanced(&meta.id, &summary.to_json())
        .unwrap();
    let mut transcript_lines = lines(20);
    transcript_lines.apply(line(
        "decide",
        Source::System,
        100_000,
        "So we agreed to ship the new pricing page on Friday.",
    ));
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
        Host { pane, store }
    });
    cx.simulate_resize(size(px(1000.), px(700.)));
    cx.run_until_parked();
    let (pane, store) = host.read_with(cx, |h, _| (h.pane.clone(), h.store.clone()));
    store.update(cx, |s, cx| s.open(Some(meta.id.clone()), cx));
    cx.run_until_parked();
    let transcript = pane.read_with(cx, |p, _| p.transcript.clone());
    transcript.update(cx, |t, cx| t.load_for_test(&transcript_lines, cx));
    pane.update_in(cx, |p, window, cx| p.show_view(View::Generated, window, cx));
    cx.run_until_parked();
    assert!(pane.read_with(cx, |p, _| p.page_mode()));
    let full = items(&transcript, cx);

    transcript.update_in(cx, |t, window, cx| t.toggle_collapsed(window, cx));
    cx.run_until_parked();
    let lead = transcript.read_with(cx, |t, _| t.lead_count());
    assert_eq!(items(&transcript, cx), lead + 1);
    let (header_h, summary_h) =
        transcript.read_with(cx, |t, _| (t.float_height(0), t.float_height(1)));
    assert!(
        header_h > px(0.) && summary_h > px(0.),
        "header and summary still float"
    );

    pane.update(cx, |p, cx| p.debug_lit_at(0, true, cx));
    cx.run_until_parked();
    assert!(
        !transcript.read_with(cx, |t, _| t.collapsed()),
        "a source clicked in the summary opens the lines"
    );
    assert_eq!(items(&transcript, cx), full);
    let top = transcript.read_with(cx, |t, _| t.list_state().logical_scroll_top().item_ix);
    assert!(
        top > lead + 10,
        "scrolled down to the source line, not left at the top ({top})"
    );
}
