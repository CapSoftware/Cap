use std::time::Duration;

use cap_notes::{BlockKind, Document, Mark, Pos, Selection};
use gpui::{
    ClipboardItem, Context, Entity, EntityInputHandler, IntoElement, Modifiers, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, Render, TestAppContext, VisualTestContext, Window, div,
    prelude::*, px, size,
};

use crate::editor::{NotesEditor, NotesEvent, SourceMark};
use crate::script::{checkbox_point, point_for};
use crate::theme::{NotesLabels, NotesTheme};

struct Host {
    editor: Entity<NotesEditor>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.editor.clone())
    }
}

fn setup<'a>(
    cx: &'a mut TestAppContext,
    markdown: &str,
) -> (Entity<NotesEditor>, &'a mut VisualTestContext) {
    cx.update(crate::bind_keys);
    let doc = Document::from_markdown(markdown);
    let (host, cx) = cx.add_window_view(|window, cx| {
        let editor = cx.new(|cx| {
            NotesEditor::new(doc, NotesTheme::light(), NotesLabels::default(), window, cx)
        });
        Host { editor }
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    let editor = host.read_with(cx, |host, _| host.editor.clone());
    cx.update(|window, cx| {
        let handle = editor.read(cx).focus.clone();
        window.focus(&handle, cx);
    });
    cx.run_until_parked();
    (editor, cx)
}

fn texts(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext) -> Vec<String> {
    editor.read_with(cx, |editor, _| {
        editor
            .document()
            .blocks
            .iter()
            .map(|block| block.text.clone())
            .collect()
    })
}

fn kinds(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext) -> Vec<BlockKind> {
    editor.read_with(cx, |editor, _| {
        editor
            .document()
            .blocks
            .iter()
            .map(|block| block.kind.clone())
            .collect()
    })
}

fn selection(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext) -> Selection {
    editor.read_with(cx, |editor, _| editor.editor().selection())
}

fn select(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext, a: Pos, b: Pos) {
    editor.update(cx, |editor, cx| {
        editor.apply(
            |e| {
                e.set_selection(Selection::new(a, b));
                cap_notes::Change::default()
            },
            cx,
        )
    });
    cx.run_until_parked();
}

fn caret(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext, pos: Pos) {
    select(editor, cx, pos, pos);
}

fn shaped(editor: &Entity<NotesEditor>, cx: &mut VisualTestContext) -> u64 {
    editor.read_with(cx, |editor, _| editor.debug_stats().frame.shaped_blocks)
}

fn point_of(
    editor: &Entity<NotesEditor>,
    cx: &mut VisualTestContext,
    pos: Pos,
) -> gpui::Point<gpui::Pixels> {
    editor
        .read_with(cx, |editor, _| point_for(editor, pos))
        .expect("position on screen")
}

fn click(
    cx: &mut VisualTestContext,
    at: gpui::Point<gpui::Pixels>,
    count: usize,
    modifiers: Modifiers,
) {
    cx.simulate_event(MouseDownEvent {
        button: MouseButton::Left,
        position: at,
        modifiers,
        click_count: count,
        first_mouse: false,
    });
    cx.simulate_event(MouseUpEvent {
        button: MouseButton::Left,
        position: at,
        modifiers,
        click_count: count,
    });
}

fn chord(mac: &'static str, other: &'static str) -> &'static str {
    if cfg!(target_os = "macos") {
        mac
    } else {
        other
    }
}

fn has_mark(
    editor: &Entity<NotesEditor>,
    cx: &mut VisualTestContext,
    block: usize,
    range: std::ops::Range<usize>,
    mark: &Mark,
) -> bool {
    editor.read_with(cx, |editor, _| {
        editor.document().blocks[block].spans.iter().any(|span| {
            &span.mark == mark && span.range.start <= range.start && span.range.end >= range.end
        })
    })
}

#[gpui::test]
fn typing_goes_through_the_input_handler(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    cx.simulate_input("Hello notes");
    assert_eq!(texts(&editor, cx), vec!["Hello notes"]);
    cx.simulate_keystrokes("enter");
    cx.simulate_input("second");
    assert_eq!(texts(&editor, cx), vec!["Hello notes", "second"]);
    cx.simulate_keystrokes("backspace backspace");
    assert_eq!(texts(&editor, cx), vec!["Hello notes", "seco"]);
}

#[gpui::test]
fn formatting_chords_toggle_marks(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "hello world");
    let cases: [(&str, Mark); 6] = [
        ("secondary-b", Mark::Bold),
        ("secondary-i", Mark::Italic),
        ("secondary-u", Mark::Underline),
        ("secondary-shift-s", Mark::Strike),
        ("secondary-e", Mark::Code),
        ("secondary-shift-h", Mark::Highlight),
    ];
    for (keys, mark) in cases {
        select(&editor, cx, Pos::new(0, 6), Pos::new(0, 11));
        cx.simulate_keystrokes(keys);
        assert!(
            has_mark(&editor, cx, 0, 6..11, &mark),
            "{keys} should add {mark:?}"
        );
        cx.simulate_keystrokes(keys);
        assert!(
            !has_mark(&editor, cx, 0, 6..11, &mark),
            "{keys} should remove {mark:?}"
        );
    }
}

#[gpui::test]
fn block_chords_change_the_block_kind(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "line");
    let cases: [(&str, BlockKind); 8] = [
        ("secondary-alt-1", BlockKind::Heading(1)),
        ("secondary-alt-2", BlockKind::Heading(2)),
        ("secondary-alt-3", BlockKind::Heading(3)),
        ("secondary-alt-0", BlockKind::Paragraph),
        ("secondary-shift-7", BlockKind::Ordered),
        ("secondary-shift-8", BlockKind::Bullet),
        ("secondary-shift-9", BlockKind::Task { checked: false }),
        ("secondary-shift-.", BlockKind::Quote),
    ];
    for (keys, kind) in cases {
        caret(&editor, cx, Pos::new(0, 2));
        cx.simulate_keystrokes(keys);
        assert_eq!(kinds(&editor, cx)[0], kind, "{keys}");
    }
    cx.simulate_keystrokes("secondary-alt-c");
    assert!(kinds(&editor, cx)[0].is_code());
    cx.simulate_keystrokes("secondary-alt-c");
    assert_eq!(kinds(&editor, cx)[0], BlockKind::Paragraph);
}

#[gpui::test]
fn lists_indent_toggle_and_move(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "- [ ] one\n- [ ] two\n- [ ] three");
    caret(&editor, cx, Pos::new(1, 1));
    cx.simulate_keystrokes("tab");
    assert_eq!(
        editor.read_with(cx, |e, _| e.document().blocks[1].indent),
        1
    );
    cx.simulate_keystrokes("shift-tab");
    assert_eq!(
        editor.read_with(cx, |e, _| e.document().blocks[1].indent),
        0
    );
    cx.simulate_keystrokes("secondary-enter");
    assert_eq!(kinds(&editor, cx)[1], BlockKind::Task { checked: true });
    cx.simulate_keystrokes(chord("ctrl-cmd-up", "alt-up"));
    assert_eq!(texts(&editor, cx), vec!["two", "one", "three"]);
    cx.simulate_keystrokes(chord("ctrl-cmd-down", "alt-down"));
    assert_eq!(texts(&editor, cx), vec!["one", "two", "three"]);
}

#[gpui::test]
fn undo_redo_and_idle_grouping(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    cx.simulate_input("abc");
    cx.executor().advance_clock(Duration::from_millis(1100));
    cx.run_until_parked();
    cx.simulate_input("def");
    assert_eq!(texts(&editor, cx), vec!["abcdef"]);
    cx.simulate_keystrokes("secondary-z");
    assert_eq!(texts(&editor, cx), vec!["abc"]);
    cx.simulate_keystrokes("secondary-z");
    assert_eq!(texts(&editor, cx), vec![""]);
    cx.simulate_keystrokes("secondary-shift-z");
    assert_eq!(texts(&editor, cx), vec!["abc"]);
    let redo = chord("cmd-shift-z", "ctrl-y");
    cx.simulate_keystrokes(redo);
    assert_eq!(texts(&editor, cx), vec!["abcdef"]);
}

#[gpui::test]
fn clipboard_round_trips_markdown(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "# Title\n\nSome **bold** text");
    cx.simulate_keystrokes("secondary-a secondary-c");
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert_eq!(
        copied.as_deref().map(str::trim_end),
        Some("# Title\n\nSome **bold** text")
    );
    cx.simulate_keystrokes("secondary-x");
    assert_eq!(texts(&editor, cx), vec![""]);
    cx.simulate_keystrokes("secondary-v");
    assert_eq!(kinds(&editor, cx)[0], BlockKind::Heading(1));
    assert!(has_mark(&editor, cx, 1, 5..9, &Mark::Bold));
    cx.update(|_, cx| cx.write_to_clipboard(ClipboardItem::new_string("# not a heading".into())));
    cx.simulate_keystrokes("enter secondary-shift-v");
    let blocks = texts(&editor, cx);
    assert_eq!(blocks.last().map(String::as_str), Some("# not a heading"));
    assert_eq!(kinds(&editor, cx).last(), Some(&BlockKind::Paragraph));
}

#[gpui::test]
fn horizontal_motion_and_deletion_chords(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "alpha beta gamma");
    caret(&editor, cx, Pos::new(0, 16));
    cx.simulate_keystrokes(chord("alt-left", "ctrl-left"));
    assert_eq!(selection(&editor, cx).head, Pos::new(0, 11));
    cx.simulate_keystrokes(chord("alt-shift-left", "ctrl-shift-left"));
    assert_eq!(
        selection(&editor, cx),
        Selection::new(Pos::new(0, 11), Pos::new(0, 6))
    );
    cx.simulate_keystrokes("left");
    assert_eq!(selection(&editor, cx), Selection::caret(Pos::new(0, 6)));
    cx.simulate_keystrokes(chord("cmd-right", "end"));
    assert_eq!(selection(&editor, cx).head, Pos::new(0, 16));
    cx.simulate_keystrokes(chord("alt-backspace", "ctrl-backspace"));
    assert_eq!(texts(&editor, cx), vec!["alpha beta "]);
    cx.simulate_keystrokes(chord("cmd-left", "home"));
    assert_eq!(selection(&editor, cx).head, Pos::new(0, 0));
    cx.simulate_keystrokes(chord("alt-delete", "ctrl-delete"));
    assert_eq!(texts(&editor, cx), vec![" beta "]);
    cx.simulate_keystrokes(chord("cmd-right", "end"));
    cx.simulate_keystrokes(chord("cmd-backspace", "ctrl-shift-backspace"));
    assert_eq!(texts(&editor, cx), vec![""]);
}

#[gpui::test]
fn up_and_down_keep_the_preferred_column(cx: &mut TestAppContext) {
    let long = "word ".repeat(40);
    let markdown = format!("{long}\n\nshort\n\n{long}");
    let (editor, cx) = setup(cx, &markdown);
    let first_row_end = editor.read_with(cx, |editor, _| {
        let store = editor.store.borrow();
        store.slots[0].layout.as_ref().unwrap().rows[0].end
    });
    assert!(first_row_end < long.trim_end().len(), "the paragraph wraps");
    caret(&editor, cx, Pos::new(0, 30));
    let start_x = point_of(&editor, cx, Pos::new(0, 30)).x;
    cx.simulate_keystrokes("down");
    let head = selection(&editor, cx).head;
    assert_eq!(head.block, 0);
    assert!(head.offset > first_row_end);
    assert!((point_of(&editor, cx, head).x - start_x).abs() < px(10.));
    cx.simulate_keystrokes("down down");
    let head = selection(&editor, cx).head;
    assert_eq!(
        head,
        Pos::new(1, 5),
        "a short line takes the caret to its end"
    );
    cx.simulate_keystrokes("down");
    let head = selection(&editor, cx).head;
    assert_eq!(head.block, 2);
    assert!(
        (point_of(&editor, cx, head).x - start_x).abs() < px(10.),
        "the goal column survives the short line"
    );
    cx.simulate_keystrokes("up up");
    let head = selection(&editor, cx).head;
    assert_eq!(head.block, 0);
    assert!((point_of(&editor, cx, head).x - start_x).abs() < px(10.));
    cx.simulate_keystrokes("shift-down");
    let sel = selection(&editor, cx);
    assert!(!sel.is_collapsed());
    assert_eq!(sel.anchor, head);
}

#[gpui::test]
fn clicks_drags_and_multi_clicks_hit_test(cx: &mut TestAppContext) {
    let long = "lorem ipsum dolor sit amet ".repeat(8);
    let markdown = format!("first paragraph here\n\n{long}");
    let (editor, cx) = setup(cx, &markdown);
    let target = Pos::new(0, 6);
    let at = point_of(&editor, cx, target);
    click(cx, at, 1, Modifiers::default());
    assert_eq!(selection(&editor, cx), Selection::caret(target));

    let second_row_start = editor.read_with(cx, |editor, _| {
        let store = editor.store.borrow();
        store.slots[1].layout.as_ref().unwrap().rows[1].start
    });
    let wrapped = Pos::new(1, second_row_start + 6);
    let at = point_of(&editor, cx, wrapped);
    click(cx, at, 1, Modifiers::default());
    assert_eq!(selection(&editor, cx).head, wrapped);

    let shift = Modifiers {
        shift: true,
        ..Modifiers::default()
    };
    let at = point_of(&editor, cx, Pos::new(0, 5));
    click(cx, at, 1, shift);
    assert_eq!(
        selection(&editor, cx),
        Selection::new(wrapped, Pos::new(0, 5))
    );

    let at = point_of(&editor, cx, Pos::new(0, 8));
    click(cx, at, 2, Modifiers::default());
    assert_eq!(
        selection(&editor, cx),
        Selection::new(Pos::new(0, 6), Pos::new(0, 15))
    );
    click(cx, at, 3, Modifiers::default());
    assert_eq!(
        selection(&editor, cx),
        Selection::new(Pos::new(0, 0), Pos::new(0, 20))
    );

    let from = point_of(&editor, cx, Pos::new(0, 2));
    let to = point_of(&editor, cx, Pos::new(1, 4));
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
    cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
    assert_eq!(
        selection(&editor, cx),
        Selection::new(Pos::new(0, 2), Pos::new(1, 4))
    );
}

#[gpui::test]
fn clicking_a_checkbox_toggles_it_without_moving_the_caret(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "intro\n\n- [ ] task");
    caret(&editor, cx, Pos::new(0, 2));
    let at = editor
        .read_with(cx, |editor, _| checkbox_point(editor, 1))
        .unwrap();
    click(cx, at, 1, Modifiers::default());
    assert_eq!(kinds(&editor, cx)[1], BlockKind::Task { checked: true });
    assert_eq!(selection(&editor, cx), Selection::caret(Pos::new(0, 2)));
    click(cx, at, 1, Modifiers::default());
    assert_eq!(kinds(&editor, cx)[1], BlockKind::Task { checked: false });
}

#[gpui::test]
fn marked_text_commits_and_cancels(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "ab");
    caret(&editor, cx, Pos::new(0, 1));
    cx.update(|window, cx| {
        editor.update(cx, |editor, cx| {
            editor.replace_and_mark_text_in_range(None, "に", Some(1..1), window, cx);
            assert_eq!(editor.marked_text_range(window, cx), Some(1..2));
            assert_eq!(editor.document().blocks[0].text, "ab");
            editor.replace_and_mark_text_in_range(None, "にほ", Some(2..2), window, cx);
            assert_eq!(
                editor
                    .text_for_range(0..4, &mut None, window, cx)
                    .as_deref(),
                Some("aにほb")
            );
            editor.replace_text_in_range(None, "日本", window, cx);
            assert_eq!(editor.marked_text_range(window, cx), None);
        })
    });
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["a日本b"]);
    assert_eq!(
        selection(&editor, cx),
        Selection::caret(Pos::new(0, 1 + "日本".len()))
    );

    cx.update(|window, cx| {
        editor.update(cx, |editor, cx| {
            editor.replace_and_mark_text_in_range(None, "x", None, window, cx);
            editor.replace_and_mark_text_in_range(None, "", None, window, cx);
            assert_eq!(editor.marked_text_range(window, cx), None);
        })
    });
    assert_eq!(texts(&editor, cx), vec!["a日本b"]);

    cx.update(|window, cx| {
        editor.update(cx, |editor, cx| {
            editor.replace_and_mark_text_in_range(None, "é", None, window, cx);
            editor.unmark_text(window, cx);
        })
    });
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["a日本éb"]);
    cx.simulate_keystrokes("secondary-z");
    assert_eq!(texts(&editor, cx), vec!["a日本b"]);
}

#[gpui::test]
fn slash_menu_filters_and_applies(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    cx.simulate_input("/");
    assert!(editor.read_with(cx, |e, _| e.slash.is_some()));
    cx.simulate_input("he");
    let labels: Vec<String> = editor.read_with(cx, |e, _| {
        e.slash_entries()
            .iter()
            .map(|entry| entry.label.to_string())
            .collect()
    });
    assert_eq!(labels[0], "Heading 1");
    cx.simulate_keystrokes("down enter");
    assert_eq!(kinds(&editor, cx)[0], BlockKind::Heading(2));
    assert_eq!(texts(&editor, cx), vec![""]);
    assert!(editor.read_with(cx, |e, _| e.slash.is_none()));

    cx.simulate_keystrokes("secondary-alt-0");
    cx.simulate_input("/qu");
    cx.simulate_keystrokes("tab");
    assert_eq!(kinds(&editor, cx)[0], BlockKind::Quote);

    cx.simulate_keystrokes("secondary-shift-.");
    cx.simulate_input("x /");
    assert!(editor.read_with(cx, |e, _| e.slash.is_some()));
    cx.simulate_keystrokes("escape");
    assert!(editor.read_with(cx, |e, _| e.slash.is_none()));
    assert_eq!(texts(&editor, cx), vec!["x /"]);

    cx.simulate_input(" /");
    cx.simulate_keystrokes("backspace");
    assert!(editor.read_with(cx, |e, _| e.slash.is_none()));

    editor.update(cx, |e, _| {
        e.extra_slash_items(vec![crate::SlashItem::new("standup", "Standup template")])
    });
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let events = events.clone();
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            events.borrow_mut().push(event.clone());
        })
        .detach();
    });
    cx.simulate_input(" /standup");
    cx.simulate_keystrokes("enter");
    assert!(
        events
            .borrow()
            .contains(&NotesEvent::SlashCommand("standup".into()))
    );
    assert_eq!(texts(&editor, cx), vec!["x /  "]);
}

#[gpui::test]
fn find_bar_counts_navigates_and_closes(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "one fish\n\ntwo fish\n\nred fish");
    caret(&editor, cx, Pos::new(0, 0));
    cx.simulate_keystrokes("secondary-f");
    cx.simulate_input("fish");
    let (count, current) = editor.read_with(cx, |e, _| {
        let find = e.find.as_ref().unwrap();
        (find.matches.len(), find.current)
    });
    assert_eq!((count, current), (3, Some(0)));
    cx.simulate_keystrokes("enter");
    assert_eq!(
        editor.read_with(cx, |e, _| e.find.as_ref().unwrap().current),
        Some(1)
    );
    cx.simulate_keystrokes("secondary-g");
    assert_eq!(
        editor.read_with(cx, |e, _| e.find.as_ref().unwrap().current),
        Some(2)
    );
    cx.simulate_keystrokes("shift-enter");
    assert_eq!(
        editor.read_with(cx, |e, _| e.find.as_ref().unwrap().current),
        Some(1)
    );
    assert_eq!(
        selection(&editor, cx),
        Selection::new(Pos::new(1, 4), Pos::new(1, 8))
    );
    cx.simulate_keystrokes("escape");
    assert!(editor.read_with(cx, |e, _| e.find.is_none()));
    let focused = cx.update(|window, cx| editor.read(cx).focus.is_focused(window));
    assert!(focused);
    cx.simulate_input("X");
    assert_eq!(texts(&editor, cx)[1], "two X");
}

#[gpui::test]
fn read_only_keeps_selection_and_opens_links(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "see [the docs](https://cap.so) now");
    editor.update(cx, |e, cx| e.set_read_only(true, cx));
    cx.run_until_parked();
    cx.simulate_input("typed");
    cx.simulate_keystrokes("backspace enter secondary-b");
    assert_eq!(texts(&editor, cx), vec!["see the docs now"]);
    cx.simulate_keystrokes("secondary-a secondary-c");
    let copied = cx.update(|_, cx| cx.read_from_clipboard().and_then(|item| item.text()));
    assert!(copied.unwrap().contains("[the docs](https://cap.so)"));
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let events = events.clone();
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            events.borrow_mut().push(event.clone());
        })
        .detach();
    });
    let at = point_of(&editor, cx, Pos::new(0, 6));
    click(cx, at, 1, Modifiers::default());
    assert!(
        events
            .borrow()
            .contains(&NotesEvent::OpenLink("https://cap.so".into()))
    );
}

#[gpui::test]
fn secondary_click_opens_links_while_editing(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "see [docs](https://cap.so)");
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let events = events.clone();
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            events.borrow_mut().push(event.clone());
        })
        .detach();
    });
    let at = point_of(&editor, cx, Pos::new(0, 6));
    click(cx, at, 1, Modifiers::default());
    assert!(
        !events
            .borrow()
            .iter()
            .any(|event| matches!(event, NotesEvent::OpenLink(_)))
    );
    assert_eq!(selection(&editor, cx).head, Pos::new(0, 6));
    click(cx, at, 1, Modifiers::secondary_key());
    assert!(
        events
            .borrow()
            .contains(&NotesEvent::OpenLink("https://cap.so".into()))
    );
}

#[gpui::test]
fn streaming_append_keeps_the_scroll_anchor(cx: &mut TestAppContext) {
    let markdown = (0..200)
        .map(|i| format!("Paragraph number {i} with a little text"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let (editor, cx) = setup(cx, &markdown);
    editor.update(cx, |e, cx| e.scroll_to_block(80, cx));
    cx.run_until_parked();
    let (anchor, top) = editor.read_with(cx, |e, _| {
        let store = e.store.borrow();
        (store.anchor, store.painted(store.anchor.0).map(|p| p.top))
    });
    for chunk in [
        "## Summ",
        "ary\n\nThe meeting ",
        "covered **three** things.\n\n- one\n- tw",
        "o\n",
    ] {
        editor.update(cx, |e, cx| {
            e.append_markdown_streaming(chunk, cap_notes::Origin::Generated, cx)
        });
        cx.run_until_parked();
        let (now, now_top) = editor.read_with(cx, |e, _| {
            let store = e.store.borrow();
            (store.anchor, store.painted(store.anchor.0).map(|p| p.top))
        });
        assert_eq!(now, anchor);
        assert_eq!(now_top, top);
    }
    let blocks = editor.read_with(cx, |e, _| e.document().blocks.clone());
    let tail: Vec<(&str, &BlockKind, cap_notes::Origin)> = blocks[200..]
        .iter()
        .map(|b| (b.text.as_str(), &b.kind, b.origin))
        .collect();
    assert_eq!(
        tail,
        vec![
            (
                "Summary",
                &BlockKind::Heading(2),
                cap_notes::Origin::Generated
            ),
            (
                "The meeting covered three things.",
                &BlockKind::Paragraph,
                cap_notes::Origin::Generated
            ),
            ("one", &BlockKind::Bullet, cap_notes::Origin::Generated),
            ("two", &BlockKind::Bullet, cap_notes::Origin::Generated),
        ]
    );
}

#[gpui::test]
fn typing_reshapes_only_the_dirty_block(cx: &mut TestAppContext) {
    let markdown = (0..3000)
        .map(|i| match i % 7 {
            0 => format!("## Heading {i}"),
            1 => format!("- list item {i}"),
            2 => format!("1. ordered {i}"),
            _ => format!("Paragraph {i} with enough words to wrap across a line or two when the column is narrow enough"),
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let (editor, cx) = setup(cx, &markdown);
    caret(&editor, cx, Pos::new(1500, 3));
    cx.run_until_parked();
    let before = shaped(&editor, cx);
    cx.simulate_input("x");
    let after = shaped(&editor, cx);
    assert!(
        after - before <= 1,
        "typing shaped {} blocks",
        after - before
    );

    let before = shaped(&editor, cx);
    cx.simulate_keystrokes("right right left");
    assert_eq!(shaped(&editor, cx), before, "caret motion never shapes");

    let before = shaped(&editor, cx);
    cx.simulate_keystrokes("enter");
    let after = shaped(&editor, cx);
    assert!(
        after - before <= 3,
        "enter shaped {} blocks",
        after - before
    );

    let live = editor.read_with(cx, |e, _| e.debug_stats().frame.live_layouts);
    assert!(
        live < 200,
        "only blocks near the viewport are shaped, found {live}"
    );
}

#[gpui::test]
fn ordered_numbers_follow_edits(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "1. a\n2. b\n3. c");
    let ordinals = |editor: &Entity<NotesEditor>, cx: &mut VisualTestContext| {
        editor.read_with(cx, |e, _| {
            e.store
                .borrow()
                .slots
                .iter()
                .map(|slot| slot.ordinal)
                .collect::<Vec<_>>()
        })
    };
    assert_eq!(ordinals(&editor, cx), vec![Some(1), Some(2), Some(3)]);
    caret(&editor, cx, Pos::new(0, 1));
    cx.simulate_keystrokes("enter");
    cx.simulate_input("new");
    assert_eq!(
        ordinals(&editor, cx),
        vec![Some(1), Some(2), Some(3), Some(4)]
    );
    editor.read_with(cx, |e, _| {
        assert_eq!(
            e.store
                .borrow()
                .slots
                .iter()
                .map(|s| s.ordinal)
                .collect::<Vec<_>>(),
            e.document().ordinals()
        );
    });
}

#[gpui::test]
fn link_field_applies_and_removes(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "visit our site");
    select(&editor, cx, Pos::new(0, 10), Pos::new(0, 14));
    cx.simulate_keystrokes("secondary-k");
    assert!(editor.read_with(cx, |e, _| e.link_edit.is_some()));
    cx.simulate_input("https://cap.so");
    cx.simulate_keystrokes("enter");
    assert!(has_mark(
        &editor,
        cx,
        0,
        10..14,
        &Mark::Link {
            url: "https://cap.so".into()
        }
    ));
    caret(&editor, cx, Pos::new(0, 12));
    cx.simulate_keystrokes("secondary-k");
    cx.simulate_keystrokes("secondary-a backspace enter");
    let spans = editor.read_with(cx, |e, _| e.document().blocks[0].spans.clone());
    assert!(spans.is_empty());
    cx.simulate_keystrokes("secondary-k escape");
    assert!(editor.read_with(cx, |e, _| e.link_edit.is_none()));
}

#[gpui::test]
fn mentions_ask_the_host_and_insert(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    cx.update(|_, cx| {
        let events = events.clone();
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            events.borrow_mut().push(event.clone());
        })
        .detach();
    });
    cx.simulate_input("hi @an");
    assert!(
        events
            .borrow()
            .contains(&NotesEvent::RequestMention { query: "an".into() })
    );
    editor.update(cx, |e, cx| e.insert_mention("ana", "Ana", cx));
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["hi Ana "]);
    assert!(has_mark(
        &editor,
        cx,
        0,
        3..6,
        &Mark::Mention { id: "ana".into() }
    ));
}

#[gpui::test]
fn random_actions_never_break_invariants(cx: &mut TestAppContext) {
    let markdown = "# Title\n\nSome **bold** and [a link](https://x.y) here\n\n- one\n  - two\n\n1. first\n2. second\n\n- [ ] task\n\n> quote\n\n```\ncode\nlines\n```\n\n---\n\nend";
    let (editor, cx) = setup(cx, markdown);
    let keys = [
        "left",
        "right",
        "up",
        "down",
        "shift-left",
        "shift-right",
        "shift-up",
        "shift-down",
        "backspace",
        "delete",
        "enter",
        "tab",
        "shift-tab",
        "secondary-b",
        "secondary-i",
        "secondary-e",
        "secondary-alt-1",
        "secondary-alt-0",
        "secondary-shift-8",
        "secondary-shift-9",
        "secondary-enter",
        "secondary-z",
        "secondary-shift-z",
        "secondary-a",
        "escape",
        "pageup",
        "pagedown",
        "secondary-alt-c",
        "secondary-shift-.",
        chord("alt-left", "ctrl-left"),
        chord("alt-backspace", "ctrl-backspace"),
        chord("cmd-right", "end"),
        chord("cmd-left", "home"),
        chord("ctrl-cmd-up", "alt-up"),
        chord("ctrl-cmd-down", "alt-down"),
    ];
    let inputs = [
        "a",
        " ",
        "/",
        "@",
        "**",
        "- ",
        "é",
        "日",
        "👩‍💻",
        "1. ",
        "`",
        "x",
    ];
    let mut seed: u64 = 0x5eed_1234_abcd;
    let mut next = |bound: usize| {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed % bound as u64) as usize
    };
    let initial = texts(&editor, cx);
    let mut changed_steps = 0;
    let mut previous = initial.clone();
    for step in 0..2500 {
        match next(10) {
            0..=4 => {
                let key = keys[next(keys.len())];
                cx.simulate_keystrokes(key);
            }
            5..=7 => {
                let text = inputs[next(inputs.len())];
                cx.simulate_input(text);
            }
            8 => {
                let x = 40. + next(700) as f32;
                let y = 10. + next(580) as f32;
                let count = 1 + next(3);
                click(cx, gpui::point(px(x), px(y)), count, Modifiers::default());
            }
            _ => {
                let x = 40. + next(700) as f32;
                let y = 10. + next(580) as f32;
                let to = gpui::point(px(x), px(y));
                let from = gpui::point(px(40. + next(700) as f32), px(10. + next(580) as f32));
                cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
                cx.simulate_mouse_move(to, MouseButton::Left, Modifiers::default());
                cx.simulate_mouse_up(to, MouseButton::Left, Modifiers::default());
            }
        }
        if step % 50 == 0 {
            cx.update(|window, cx| {
                editor.update(cx, |e, cx| {
                    e.replace_and_mark_text_in_range(None, "ka", None, window, cx);
                    e.replace_text_in_range(None, "か", window, cx);
                })
            });
        }
        let now = texts(&editor, cx);
        if now != previous {
            changed_steps += 1;
            previous = now;
        }
        editor.read_with(cx, |e, _| {
            let doc = e.document();
            let store = e.store.borrow();
            assert_eq!(store.slots.len(), doc.blocks.len(), "step {step}");
            let selection = e.editor().selection();
            assert_eq!(
                e.editor().clamp_selection(selection),
                selection,
                "step {step}"
            );
            for block in &doc.blocks {
                assert!(cap_notes::spans_are_normalized(&block.text, &block.spans));
            }
            let ordinals: Vec<_> = store.slots.iter().map(|s| s.ordinal).collect();
            assert_eq!(ordinals, doc.ordinals(), "step {step}");
            let expected: f32 = (0..doc.blocks.len())
                .map(|i| store.gap_of(doc, i, &e.theme) + store.slots[i].content)
                .sum();
            assert!((store.heights.total() - expected).abs() < 1., "step {step}");
        });
    }
    assert!(
        changed_steps > 500,
        "only {changed_steps} steps changed the document"
    );
}

#[gpui::test]
fn hovering_a_link_shows_its_url_after_a_delay(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "see [docs](https://cap.so) here");
    let at = point_of(&editor, cx, Pos::new(0, 6));
    cx.simulate_mouse_move(at, None, Modifiers::default());
    let hovered = editor.read_with(cx, |e, _| e.hover.link.as_ref().map(|l| l.url.clone()));
    assert_eq!(hovered.as_deref(), Some("https://cap.so"));
    assert!(!editor.read_with(cx, |e, _| e.hover.tooltip));
    cx.executor().advance_clock(Duration::from_millis(700));
    cx.run_until_parked();
    assert!(editor.read_with(cx, |e, _| e.hover.tooltip));
    let away = point_of(&editor, cx, Pos::new(0, 1));
    cx.simulate_mouse_move(away, None, Modifiers::default());
    assert!(editor.read_with(cx, |e, _| e.hover.link.is_none() && !e.hover.tooltip));
}

fn single_keystroke(binding: &gpui::KeyBinding) -> &gpui::Keystroke {
    assert_eq!(binding.keystrokes().len(), 1, "{binding:?}");
    binding.keystrokes()[0].inner()
}

#[test]
fn bindings_are_single_modified_chords_scoped_to_our_contexts() {
    use std::collections::HashSet;
    let bindings = crate::actions::bindings();
    let mut seen = HashSet::new();
    for binding in &bindings {
        let keystroke = single_keystroke(binding);
        let context = binding
            .predicate()
            .map(|predicate| predicate.to_string())
            .unwrap_or_default();
        assert!(
            context == crate::KEY_CONTEXT || context == crate::FIELD_CONTEXT,
            "{binding:?}"
        );
        assert!(
            seen.insert((context, keystroke.unparse())),
            "{binding:?} is bound twice in one context"
        );
        let modified = keystroke.modifiers.control
            || keystroke.modifiers.alt
            || keystroke.modifiers.platform
            || keystroke.modifiers.function;
        assert!(
            modified || keystroke.key.chars().count() > 1,
            "{binding:?} would swallow a typed character"
        );
    }
}

#[test]
fn the_platform_chords_reach_the_right_actions() {
    use crate::actions::*;
    let bindings = crate::actions::bindings();
    let action_for = |source: &str| {
        let keystroke = gpui::Keystroke::parse(source).unwrap();
        bindings
            .iter()
            .find(|binding| {
                single_keystroke(binding) == &keystroke
                    && binding.predicate().map(|p| p.to_string()).as_deref()
                        == Some(crate::KEY_CONTEXT)
            })
            .map(|binding| binding.action().name())
    };
    let common: &[(&str, &dyn gpui::Action)] = &[
        ("secondary-b", &ToggleBold),
        ("secondary-i", &ToggleItalic),
        ("secondary-u", &ToggleUnderline),
        ("secondary-shift-s", &ToggleStrikethrough),
        ("secondary-e", &ToggleCode),
        ("secondary-shift-h", &ToggleHighlight),
        ("secondary-alt-1", &Heading1),
        ("secondary-alt-2", &Heading2),
        ("secondary-alt-3", &Heading3),
        ("secondary-alt-0", &Paragraph),
        ("secondary-shift-7", &OrderedList),
        ("secondary-shift-8", &BulletList),
        ("secondary-shift-9", &TaskList),
        ("secondary-shift-.", &Quote),
        ("secondary-alt-c", &CodeBlock),
        ("secondary-k", &EditLink),
        ("tab", &Indent),
        ("shift-tab", &Outdent),
        ("secondary-enter", &ToggleCheckbox),
        ("secondary-z", &Undo),
        ("secondary-shift-z", &Redo),
        ("secondary-x", &Cut),
        ("secondary-c", &Copy),
        ("secondary-v", &Paste),
        ("secondary-shift-v", &PastePlain),
        ("secondary-a", &SelectAll),
        ("secondary-f", &Find),
        ("secondary-g", &FindNext),
        ("secondary-shift-g", &FindPrevious),
        ("pageup", &PageUp),
        ("shift-pagedown", &SelectPageDown),
    ];
    let platform: &[(&str, &dyn gpui::Action)] = if cfg!(target_os = "macos") {
        &[
            ("alt-left", &MoveWordLeft),
            ("alt-shift-right", &SelectWordRight),
            ("cmd-left", &MoveToLineStart),
            ("cmd-shift-right", &SelectToLineEnd),
            ("cmd-up", &MoveToStart),
            ("cmd-shift-down", &SelectToEnd),
            ("alt-backspace", &DeleteWordLeft),
            ("cmd-backspace", &DeleteToLineStart),
            ("ctrl-cmd-up", &MoveBlockUp),
            ("ctrl-cmd-down", &MoveBlockDown),
        ]
    } else {
        &[
            ("ctrl-left", &MoveWordLeft),
            ("ctrl-shift-right", &SelectWordRight),
            ("home", &MoveToLineStart),
            ("shift-end", &SelectToLineEnd),
            ("ctrl-home", &MoveToStart),
            ("ctrl-shift-end", &SelectToEnd),
            ("ctrl-backspace", &DeleteWordLeft),
            ("alt-up", &MoveBlockUp),
            ("alt-down", &MoveBlockDown),
            ("ctrl-y", &Redo),
        ]
    };
    for (source, action) in common.iter().chain(platform) {
        assert_eq!(action_for(source), Some(action.name()), "{source}");
    }
}

#[gpui::test]
fn dragging_past_the_bottom_edge_scrolls(cx: &mut TestAppContext) {
    let markdown = (0..120)
        .map(|i| format!("Line {i}"))
        .collect::<Vec<_>>()
        .join("\n\n");
    let (editor, cx) = setup(cx, &markdown);
    let from = point_of(&editor, cx, Pos::new(2, 1));
    cx.simulate_mouse_down(from, MouseButton::Left, Modifiers::default());
    let below = gpui::point(from.x, px(640.));
    for _ in 0..10 {
        cx.simulate_mouse_move(below, MouseButton::Left, Modifiers::default());
    }
    let (scroll, head) = editor.read_with(cx, |e, _| {
        (e.store.borrow().scroll_y(), e.editor().selection().head)
    });
    assert!(scroll > 0., "dragging below the view scrolls it");
    assert!(
        head.block > 15,
        "the selection follows the scroll, reached {head:?}"
    );
    cx.simulate_mouse_up(below, MouseButton::Left, Modifiers::default());
    assert!(editor.read_with(cx, |e, _| e.drag.is_none()));
}

#[gpui::test]
fn typing_paints_at_once_and_asks_for_no_animation_frames(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "Hello world");
    cx.update(|window, _| window.activate_window());
    caret(&editor, cx, Pos::new(0, 11));
    cx.run_until_parked();
    for ch in ["a", "b", " ", "c"] {
        cx.simulate_input(ch);
        cx.run_until_parked();
        let frame = editor.read_with(cx, |e, _| e.debug_stats().frame);
        assert!(frame.caret, "the caret is drawn after a keystroke");
        // A keystroke that starts animation frames (the caret used to glide
        // to its new place) keeps the window redrawing on the display's
        // clock, so the next key waits for a refresh instead of painting.
        assert!(!frame.animating, "typing {ch:?} started animation frames");
    }
    assert_eq!(texts(&editor, cx), vec!["Hello worldab c".to_string()]);
}

#[gpui::test]
fn streamed_words_arrive_at_a_steady_pace_and_settle_when_done(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            seen.borrow_mut().push(event.clone())
        })
        .detach()
    });
    editor.update(cx, |e, cx| e.set_writing(true, cx));
    let burst = "### Summary\n\nThe team agreed to ship the smaller onboarding flow first and measure activation before adding the import step.\n\n- [ ] Ana: share the final designs\n";
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming(burst, cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    let words =
        |cx: &mut VisualTestContext| texts(&editor, cx).join(" ").split_whitespace().count();
    let first = words(cx);
    assert!(
        first >= 1 && first < 8,
        "a burst is not shown at once: {first} words"
    );
    let mut last = first;
    let mut steps = 0;
    while editor.read_with(cx, |e, _| e.is_pacing()) && steps < 200 {
        cx.executor().advance_clock(Duration::from_millis(33));
        cx.run_until_parked();
        let now = words(cx);
        assert!(now >= last, "words never go away");
        assert!(
            now - last <= 6,
            "at most a few words a tick, got {}",
            now - last
        );
        // A list item never shows as a bare marker.
        let kinds = kinds(&editor, cx);
        let texts = texts(&editor, cx);
        for (kind, text) in kinds.iter().zip(&texts) {
            if matches!(kind, BlockKind::Task { .. } | BlockKind::Bullet) {
                assert!(!text.is_empty(), "an empty list item was shown");
            }
        }
        last = now;
        steps += 1;
        if steps == 3 {
            // The writer finishes while words are still on their way.
            editor.update(cx, |e, cx| e.set_writing(false, cx));
        }
    }
    assert!(
        steps < 200 && steps >= 3,
        "drains within a few seconds ({steps} ticks)"
    );
    assert_eq!(
        texts(&editor, cx),
        vec![
            "Summary".to_string(),
            "The team agreed to ship the smaller onboarding flow first and measure activation before adding the import step.".to_string(),
            "Ana: share the final designs".to_string(),
        ]
    );
    assert!(
        events.borrow().contains(&NotesEvent::StreamDrained),
        "the page says when the last word is shown"
    );
}

#[gpui::test]
fn names_in_caps_text_are_pills_that_ask_to_rename(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "Person 2 owns the deck\n\nPerson 2 typed by me");
    editor.update(cx, |e, cx| {
        let mut doc = e.document().clone();
        doc.blocks[0].origin = cap_notes::Origin::Generated;
        e.set_document(doc, cx);
        e.set_people(vec![("Person 2".into(), gpui::Hsla::default())], cx);
    });
    cx.run_until_parked();
    let pills = editor.read_with(cx, |e, _| e.store.borrow().pills.clone());
    assert_eq!(
        pills.len(),
        1,
        "only Cap's text gets pills, not what you typed"
    );
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&editor, move |_, event: &NotesEvent, _| {
            seen.borrow_mut().push(event.clone())
        })
        .detach()
    });
    let at = pills[0].0.center();
    click(cx, at, 1, Modifiers::default());
    cx.run_until_parked();
    assert!(events.borrow().iter().any(|e| matches!(
        e,
        NotesEvent::PersonClicked { name, .. } if name == "Person 2"
    )));
}

fn record_events(
    editor: &Entity<NotesEditor>,
    cx: &mut VisualTestContext,
) -> std::rc::Rc<std::cell::RefCell<Vec<NotesEvent>>> {
    let events = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let seen = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(editor, move |_, event: &NotesEvent, _| {
            seen.borrow_mut().push(event.clone())
        })
        .detach()
    });
    events
}

#[gpui::test]
fn a_sourced_point_shows_its_time_and_says_when_it_is_hovered_or_clicked(
    cx: &mut TestAppContext,
) {
    let point = "Move the events budget to the launch video";
    let (editor, cx) = setup(cx, &format!("{point}\n\nTyped by me"));
    editor.update(cx, |e, cx| {
        let mut doc = e.document().clone();
        doc.blocks[0].origin = cap_notes::Origin::Generated;
        e.set_document(doc, cx);
        e.set_sources(
            vec![SourceMark {
                block: 0,
                text_len: point.len(),
                label: "00:14".into(),
                key: 7,
            }],
            cx,
        );
    });
    cx.run_until_parked();
    let hits = editor.read_with(cx, |e, _| e.store.borrow().source_hits.clone());
    let label = hits.iter().find(|h| h.2).expect("the time is drawn").0;
    let text = hits.iter().find(|h| !h.2).expect("the point is a hover area").0;
    let events = record_events(&editor, cx);
    let before = selection(&editor, cx);
    cx.simulate_event(MouseMoveEvent {
        position: text.center(),
        pressed_button: None,
        modifiers: Modifiers::default(),
    });
    cx.run_until_parked();
    assert!(events.borrow().contains(&NotesEvent::SourceHovered(Some(7))));
    click(cx, label.center(), 1, Modifiers::default());
    cx.run_until_parked();
    assert!(events.borrow().contains(&NotesEvent::SourceClicked(7)));
    assert_eq!(selection(&editor, cx), before, "a time click leaves the caret");
    cx.simulate_event(MouseMoveEvent {
        position: gpui::point(px(4.), px(590.)),
        pressed_button: None,
        modifiers: Modifiers::default(),
    });
    cx.run_until_parked();
    assert_eq!(
        events.borrow().last(),
        Some(&NotesEvent::SourceHovered(None))
    );
}

#[gpui::test]
fn a_stale_source_is_never_drawn(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "Move the events budget to the launch video");
    editor.update(cx, |e, cx| {
        let mut doc = e.document().clone();
        doc.blocks[0].origin = cap_notes::Origin::Generated;
        e.set_document(doc, cx);
        e.set_sources(
            vec![SourceMark {
                block: 0,
                text_len: 3,
                label: "00:14".into(),
                key: 1,
            }],
            cx,
        );
    });
    cx.run_until_parked();
    let hits = editor.read_with(cx, |e, _| e.store.borrow().source_hits.len());
    assert_eq!(hits, 0, "a point edited since it was linked shows no time");
}

#[gpui::test]
fn a_fit_page_is_as_tall_as_its_text_and_asks_its_host_to_scroll(cx: &mut TestAppContext) {
    let long: Vec<String> = (0..60).map(|i| format!("Paragraph number {i}")).collect();
    let (editor, cx) = setup(cx, &long.join("\n\n"));
    let asked = std::rc::Rc::new(std::cell::Cell::new(0f32));
    let seen = asked.clone();
    editor.update(cx, |e, cx| {
        e.set_fit(true, Some(std::rc::Rc::new(move |dy, _| seen.set(dy))), cx)
    });
    cx.run_until_parked();
    let (height, content) = editor.read_with(cx, |e, _| {
        let store = e.store.borrow();
        (
            f32::from(store.geometry.expect("laid out").bounds.size.height),
            store.content_height(),
        )
    });
    assert!(height > 600., "the page is taller than the window: {height}");
    assert!((height - content).abs() < 1., "{height} vs {content}");
    let last = Pos::new(59, 4);
    caret(&editor, cx, last);
    editor.update(cx, |e, cx| {
        e.store.borrow_mut().autoscroll = Some(crate::store::Autoscroll::Caret);
        cx.notify();
    });
    cx.run_until_parked();
    assert!(asked.get() > 0., "the host is asked to scroll down to the caret");
    let scroll = editor.read_with(cx, |e, _| e.store.borrow().scroll_y());
    assert_eq!(scroll, 0., "a fit page never scrolls itself");
}

#[gpui::test]
fn marked_text_survives_a_summary_streaming_into_its_block(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("x **日本語", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["x **日本語"]);
    // Composing after 日 while the bold is still open.
    caret(&editor, cx, Pos::new(0, "x **日".len()));
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            e.replace_and_mark_text_in_range(None, "に", None, window, cx)
        })
    });
    // Closing the bold drops two bytes ahead of the composition, which then
    // pointed inside 本. The chunk now waits for the composition.
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("**", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["x **日本語"]);
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            let len = e.document().blocks[0].text.encode_utf16().count() + 4;
            let _ = e.text_for_range(0..len, &mut None, window, cx);
            let _ = e.marked_text_range(window, cx);
        })
    });
    cx.run_until_parked();
    // Ending the composition commits it and lets the held chunk land.
    cx.update(|window, cx| editor.update(cx, |e, cx| e.unmark_text(window, cx)));
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["x 日に本語"]);
}

#[gpui::test]
fn a_word_being_composed_survives_the_summary_streaming_into_its_block(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "");
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("x **日本語", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    caret(&editor, cx, Pos::new(0, "x **日".len()));
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            e.replace_and_mark_text_in_range(None, "に", None, window, cx)
        })
    });
    // The next chunk would re-parse the block being composed in: it waits.
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("**", cap_notes::Origin::Generated, cx)
    });
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["x **日本語"]);
    let marked = cx.update(|window, cx| editor.update(cx, |e, cx| e.marked_text_range(window, cx)));
    assert!(marked.is_some(), "the composition is still open");
    // Committing keeps the composed word, and the held text follows it.
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| e.replace_text_in_range(None, "に", window, cx))
    });
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    // The held "**" closes the bold around the committed word.
    assert_eq!(texts(&editor, cx), vec!["x 日に本語"]);
    assert!(has_mark(&editor, cx, 0, 2.."x 日に本語".len(), &Mark::Bold));
    assert!(!editor.read_with(cx, |e, _| e.is_pacing()));
}

#[gpui::test]
fn a_composition_before_the_streamed_tail_does_not_hold_it(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "Notes from me");
    caret(&editor, cx, Pos::new(0, "Notes".len()));
    cx.update(|window, cx| {
        editor.update(cx, |e, cx| {
            e.replace_and_mark_text_in_range(None, "に", None, window, cx)
        })
    });
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("Summary line", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    assert_eq!(texts(&editor, cx), vec!["Notes from me", "Summary line"]);
    let marked = cx.update(|window, cx| editor.update(cx, |e, cx| e.marked_text_range(window, cx)));
    assert!(marked.is_some());
}

/// A page the writer has started, the caret after `at` in its last block,
/// the person typing `typed` there, then the writer going on with `rest`.
fn type_into_the_stream<'a>(
    cx: &'a mut TestAppContext,
    start: &str,
    at: &str,
    typed: &str,
    rest: &str,
) -> (Entity<NotesEditor>, &'a mut VisualTestContext) {
    let (editor, cx) = setup(cx, "");
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming(start, cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    let last = editor.read_with(cx, |e, _| e.document().blocks.len() - 1);
    let offset = editor.read_with(cx, |e, _| {
        let text = &e.document().blocks[last].text;
        text.find(at)
            .map(|i| i + at.len())
            .expect("the caret mark is in the text")
    });
    caret(&editor, cx, Pos::new(last, offset));
    cx.simulate_input(typed);
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming(rest, cap_notes::Origin::Generated, cx)
    });
    cx.executor().advance_clock(Duration::from_millis(100));
    cx.run_until_parked();
    (editor, cx)
}

#[gpui::test]
fn typing_inside_an_open_bold_keeps_the_words_and_leaves_no_stray_markers(cx: &mut TestAppContext) {
    let (editor, cx) = type_into_the_stream(cx, "We **agreed", "agreed", " today", "** to ship.");
    assert_eq!(texts(&editor, cx), vec!["We agreed today to ship."]);
    assert!(has_mark(
        &editor,
        cx,
        0,
        3.."We agreed today".len(),
        &Mark::Bold
    ));
}

#[gpui::test]
fn typing_inside_an_open_italic_keeps_the_words(cx: &mut TestAppContext) {
    let (editor, cx) = type_into_the_stream(cx, "Ana *mostly", "Ana ", "and Ben ", "* agreed.");
    assert_eq!(texts(&editor, cx), vec!["Ana and Ben mostly agreed."]);
    assert!(has_mark(
        &editor,
        cx,
        0,
        12.."Ana and Ben mostly".len(),
        &Mark::Italic
    ));
}

#[gpui::test]
fn typing_in_a_list_item_being_written_keeps_the_list(cx: &mut TestAppContext) {
    let (editor, cx) = type_into_the_stream(
        cx,
        "- Ship the",
        "Ship the",
        " small",
        " flow\n- Measure it\n",
    );
    assert_eq!(
        texts(&editor, cx),
        vec!["Ship the small flow", "Measure it"]
    );
    assert!(
        kinds(&editor, cx).iter().all(BlockKind::is_list),
        "{:?}",
        kinds(&editor, cx)
    );
}

#[gpui::test]
fn typing_in_a_heading_being_written_keeps_the_heading(cx: &mut TestAppContext) {
    let (editor, cx) = type_into_the_stream(cx, "### Next", "Next", " up", " steps\n\nShip it.");
    assert_eq!(texts(&editor, cx), vec!["Next up steps", "Ship it."]);
    assert_eq!(kinds(&editor, cx)[0], BlockKind::Heading(3));
}

#[gpui::test]
fn an_edit_above_the_streamed_tail_keeps_the_writer_going(cx: &mut TestAppContext) {
    let (editor, cx) = setup(cx, "My notes");
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("The **plan", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    caret(&editor, cx, Pos::new(0, "My notes".len()));
    cx.simulate_keystrokes("enter");
    cx.simulate_input("more");
    editor.update(cx, |e, cx| {
        e.append_markdown_streaming("** is set.", cap_notes::Origin::Generated, cx)
    });
    cx.run_until_parked();
    assert_eq!(
        texts(&editor, cx),
        vec!["My notes", "more", "The plan is set."]
    );
    assert!(has_mark(&editor, cx, 2, 4.."The plan".len(), &Mark::Bold));
}

#[gpui::test]
fn typing_into_the_stream_with_reduced_motion(cx: &mut TestAppContext) {
    cx.update(|cx| cx.set_reduce_motion(true));
    let (editor, cx) = type_into_the_stream(cx, "We **agreed", "agreed", " today", "** to ship.");
    assert_eq!(texts(&editor, cx), vec!["We agreed today to ship."]);
    assert!(!editor.read_with(cx, |e, _| e.is_pacing()));
}

#[test]
fn the_writers_markers_are_not_escaped_when_the_tail_is_written_back() {
    use crate::editor::writer_markers;
    assert_eq!(writer_markers("We \\*\\*agreed today"), "We **agreed today");
    assert_eq!(writer_markers("a \\_b\\_ \\~\\~c \\`d"), "a _b_ ~~c `d");
    assert_eq!(
        writer_markers("keep \\\\ and \\[link\\]"),
        "keep \\\\ and \\[link\\]"
    );
}

#[test]
fn floor_char_boundary_never_splits_a_character() {
    use crate::editor::floor_char_boundary;
    let text = "x 日本";
    assert_eq!(floor_char_boundary(text, 2), 2);
    assert_eq!(floor_char_boundary(text, 3), 2);
    assert_eq!(floor_char_boundary(text, 4), 2);
    assert_eq!(floor_char_boundary(text, 5), 5);
    assert_eq!(floor_char_boundary(text, 99), text.len());
}
