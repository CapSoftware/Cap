use cap_notes::{BlockKind, Document, Editor, Mark, Pos, Selection};

use crate::support::{at, caret, check, editor, kinds, md, select, texts, type_text};

fn plain(text: &str) -> Editor {
    let mut editor = Editor::new(Document::from_markdown(text));
    editor.rules.markdown = false;
    editor.rules.typography = false;
    editor
}

#[test]
fn typing_into_an_empty_document() {
    let mut editor = Editor::default();
    type_text(&mut editor, "Hello");
    assert_eq!(texts(&editor), vec!["Hello"]);
    assert_eq!(caret(&editor), (0, 5));
    check(&editor).unwrap();
}

#[test]
fn insert_replaces_reversed_multi_block_selection() {
    let mut editor = editor("# Head\n\n- one\n- two\n\npara end");
    select(&mut editor, (3, 4), (0, 2));
    editor.insert_text("X");
    assert_eq!(texts(&editor), vec!["HeX end"]);
    assert_eq!(kinds(&editor), vec![BlockKind::Heading(1)]);
    assert_eq!(caret(&editor), (0, 3));
    check(&editor).unwrap();
}

#[test]
fn multi_line_insert_splits_blocks_but_stays_inside_code() {
    let mut editor = plain("- ab");
    at(&mut editor, 0, 1);
    editor.insert_text("1\n2\n3");
    assert_eq!(texts(&editor), vec!["a1", "2", "3b"]);
    assert_eq!(kinds(&editor), vec![BlockKind::Bullet; 3]);
    assert_eq!(caret(&editor), (2, 1));
    let mut code = plain("```\nab\n```");
    at(&mut code, 0, 1);
    code.insert_text("x\ny");
    assert_eq!(texts(&code), vec!["ax\nyb"]);
    assert_eq!(caret(&code), (0, 4));
}

#[test]
fn newline_splits_spans_and_continues_lists() {
    let mut editor = editor("- [x] ab**cd**ef");
    at(&mut editor, 0, 3);
    editor.insert_newline();
    let doc = editor.document();
    assert_eq!(texts(&editor), vec!["abc", "def"]);
    assert_eq!(doc.blocks[1].kind, BlockKind::Task { checked: false });
    assert_eq!(doc.blocks[0].spans[0].range, 2..3);
    assert_eq!(doc.blocks[1].spans[0].range, 0..1);
    assert_eq!(doc.blocks[1].spans[0].mark, Mark::Bold);
    assert_eq!(caret(&editor), (1, 0));
    check(&editor).unwrap();
}

#[test]
fn newline_keeps_id_on_first_half() {
    let mut editor = editor("hello world");
    let id = editor.document().blocks[0].id;
    at(&mut editor, 0, 5);
    editor.insert_newline();
    assert_eq!(editor.document().blocks[0].id, id);
    assert_ne!(editor.document().blocks[1].id, id);
}

#[test]
fn newline_at_heading_or_quote_end_makes_paragraph() {
    for source in ["# Title", "> quoted"] {
        let mut editor = editor(source);
        editor.move_to_doc_end(false);
        editor.insert_newline();
        assert_eq!(
            editor.document().blocks[1].kind,
            BlockKind::Paragraph,
            "{source}"
        );
    }
    let mut editor = editor("# Title");
    at(&mut editor, 0, 2);
    editor.insert_newline();
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Heading(1), BlockKind::Heading(1)]
    );
}

#[test]
fn newline_at_start_inserts_empty_block_above() {
    let mut editor = editor("# Title");
    let id = editor.document().blocks[0].id;
    at(&mut editor, 0, 0);
    editor.insert_newline();
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Paragraph, BlockKind::Heading(1)]
    );
    assert_eq!(editor.document().blocks[1].id, id);
    assert_eq!(caret(&editor), (1, 0));
    let mut list = editor_with_start();
    at(&mut list, 0, 0);
    list.insert_newline();
    assert_eq!(list.document().ordinals(), vec![Some(5), Some(6), Some(7)]);
}

fn editor_with_start() -> Editor {
    editor("5. a\n6. b")
}

#[test]
fn enter_on_empty_list_item_outdents_then_exits() {
    let mut editor = editor("- a\n    - b");
    editor.move_to_doc_end(false);
    editor.insert_newline();
    assert_eq!(editor.document().blocks[2].indent, 1);
    editor.insert_newline();
    assert_eq!(editor.document().blocks[2].indent, 0);
    assert_eq!(editor.document().blocks[2].kind, BlockKind::Bullet);
    editor.insert_newline();
    assert_eq!(editor.document().blocks[2].kind, BlockKind::Paragraph);
    assert_eq!(editor.document().blocks.len(), 3);
    let mut quote = crate::support::editor("> q");
    quote.move_to_doc_end(false);
    quote.insert_newline();
    assert_eq!(quote.document().blocks[1].kind, BlockKind::Paragraph);
}

#[test]
fn enter_in_code_keeps_indentation_and_exits_after_two_blank_lines() {
    let mut editor = editor("```\n    let x = 1;\n```");
    editor.move_to_doc_end(false);
    editor.insert_newline();
    assert_eq!(texts(&editor), vec!["    let x = 1;\n    "]);
    let mut editor = crate::support::editor("```\ncode\n```");
    editor.move_to_doc_end(false);
    editor.insert_newline();
    editor.insert_newline();
    assert_eq!(editor.document().blocks.len(), 1);
    assert_eq!(texts(&editor), vec!["code\n\n"]);
    editor.insert_newline();
    assert_eq!(texts(&editor), vec!["code", ""]);
    assert_eq!(kinds(&editor)[1], BlockKind::Paragraph);
    assert_eq!(caret(&editor), (1, 0));
}

#[test]
fn backspace_at_start_converts_then_merges() {
    let mut editor = editor("para\n\n# Head");
    at(&mut editor, 1, 0);
    editor.backspace();
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Paragraph, BlockKind::Paragraph]
    );
    editor.backspace();
    assert_eq!(texts(&editor), vec!["paraHead"]);
    assert_eq!(caret(&editor), (0, 4));
    let mut list = crate::support::editor("- a\n    - b");
    at(&mut list, 1, 0);
    list.backspace();
    assert_eq!(list.document().blocks[1].indent, 0);
    assert_eq!(list.document().blocks[1].kind, BlockKind::Bullet);
    list.backspace();
    assert_eq!(list.document().blocks[1].kind, BlockKind::Paragraph);
    list.backspace();
    assert_eq!(texts(&list), vec!["ab"]);
}

#[test]
fn backspace_after_rule_deletes_rule_and_at_doc_start_is_noop() {
    let mut editor = editor("a\n\n---\n\nb");
    at(&mut editor, 2, 0);
    editor.backspace();
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Paragraph, BlockKind::Paragraph]
    );
    assert_eq!(caret(&editor), (1, 0));
    at(&mut editor, 0, 0);
    let change = editor.backspace();
    assert!(!change.changed());
    assert_eq!(texts(&editor), vec!["a", "b"]);
}

#[test]
fn backspace_deletes_whole_graphemes() {
    let family = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
    let text = format!("a{family}e\u{301}\u{1F1EF}\u{1F1F5}");
    let mut editor = Editor::new(Document::from_blocks(vec![cap_notes::Block::paragraph(
        cap_notes::BlockId(1),
        text,
    )]));
    editor.move_to_doc_end(false);
    editor.backspace();
    assert_eq!(texts(&editor), vec![format!("a{family}e\u{301}")]);
    editor.backspace();
    assert_eq!(texts(&editor), vec![format!("a{family}")]);
    editor.backspace();
    assert_eq!(texts(&editor), vec!["a"]);
}

#[test]
fn delete_forward_merges_next_block_and_removes_rules() {
    let mut editor = editor("a\n\n---\n\n# b");
    at(&mut editor, 0, 1);
    editor.delete_forward();
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Paragraph, BlockKind::Heading(1)]
    );
    editor.delete_forward();
    assert_eq!(texts(&editor), vec!["ab"]);
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
    editor.move_to_doc_end(false);
    assert!(!editor.delete_forward().changed());
    let mut empty_first = crate::support::editor("x\n\n# keep");
    at(&mut empty_first, 0, 0);
    empty_first.delete_forward();
    empty_first.backspace();
    at(&mut empty_first, 0, 0);
    empty_first.delete_forward();
    assert_eq!(kinds(&empty_first), vec![BlockKind::Heading(1)]);
}

#[test]
fn delete_range_across_mixed_kinds_in_either_direction() {
    for (from, to) in [((0, 2), (3, 1)), ((3, 1), (0, 2))] {
        let mut editor = editor("# Head\n\n- [ ] task\n\n```\nco\nde\n```\n\n> quote");
        editor.delete_range(Pos::new(from.0, from.1), Pos::new(to.0, to.1));
        assert_eq!(texts(&editor), vec!["Heuote"]);
        assert_eq!(kinds(&editor), vec![BlockKind::Heading(1)]);
        check(&editor).unwrap();
    }
}

#[test]
fn deleting_into_code_keeps_code_lines_separate() {
    let mut editor = editor("para\n\n```\none\ntwo\n```");
    editor.delete_range(Pos::new(0, 2), Pos::new(1, 1));
    assert_eq!(texts(&editor), vec!["pa", "ne\ntwo"]);
    assert!(kinds(&editor)[1].is_code());
}

#[test]
fn select_all_then_delete_leaves_one_empty_paragraph() {
    let mut editor = editor("# a\n\n- b\n\n---");
    editor.select_all();
    editor.backspace();
    assert_eq!(editor.document().blocks.len(), 1);
    check(&editor).unwrap();
    editor.select_all();
    editor.delete_forward();
    assert_eq!(editor.document().blocks.len(), 1);
    check(&editor).unwrap();
}

#[test]
fn toggle_mark_over_reversed_selection_adds_then_removes() {
    let mut editor = editor("one two\n\nthree");
    select(&mut editor, (1, 3), (0, 4));
    editor.toggle_mark(Mark::Bold);
    assert_eq!(md(&editor), "one **two**\n\n**thr**ee\n");
    assert!(editor.marks_at_selection().contains(&Mark::Bold));
    editor.toggle_mark(Mark::Bold);
    assert_eq!(md(&editor), "one two\n\nthree\n");
    select(&mut editor, (0, 0), (0, 7));
    editor.toggle_mark(Mark::Italic);
    select(&mut editor, (0, 2), (1, 2));
    editor.toggle_mark(Mark::Italic);
    assert_eq!(md(&editor), "*one two*\n\n*th*ree\n");
}

#[test]
fn collapsed_toggle_sets_pending_marks_for_next_typing() {
    let mut editor = editor("ab");
    at(&mut editor, 0, 1);
    editor.toggle_mark(Mark::Bold);
    assert!(editor.marks_at_selection().contains(&Mark::Bold));
    editor.insert_text("X");
    editor.insert_text("Y");
    assert_eq!(md(&editor), "a**XY**b\n");
    editor.toggle_mark(Mark::Bold);
    editor.insert_text("z");
    assert_eq!(md(&editor), "a**XY**zb\n");
    editor.toggle_mark(Mark::Italic);
    editor.move_left(false);
    assert!(editor.pending_marks().is_none());
}

#[test]
fn typing_extends_inclusive_marks_but_not_links_or_code() {
    let mut editor = editor("**b** `c` [l](u)");
    at(&mut editor, 0, 1);
    editor.insert_text("x");
    at(&mut editor, 0, 4);
    editor.insert_text("y");
    editor.move_to_block_end(false);
    editor.insert_text("z");
    assert_eq!(md(&editor), "**bx** `c`y [l](u)z\n");
}

#[test]
fn links_set_edit_and_remove() {
    let mut editor = editor("visit site now");
    select(&mut editor, (0, 6), (0, 10));
    editor.set_link(Some("https://a.example".into()));
    assert_eq!(md(&editor), "visit [site](https://a.example) now\n");
    let link = editor.link_at(Pos::new(0, 8)).unwrap();
    assert_eq!(link.range, 6..10);
    at(&mut editor, 0, 8);
    editor.set_link(Some("https://b.example".into()));
    assert_eq!(md(&editor), "visit [site](https://b.example) now\n");
    editor.set_link(None);
    assert_eq!(md(&editor), "visit site now\n");
    assert!(editor.link_at(Pos::new(0, 8)).is_none());
    at(&mut editor, 0, 0);
    editor.set_link(Some("https://c.example".into()));
    assert_eq!(texts(&editor), vec!["https://c.examplevisit site now"]);
    editor.insert_text(" ");
    assert_eq!(md(&editor), "<https://c.example> visit site now\n");
}

#[test]
fn set_kind_and_toggle_kind_over_selection() {
    let mut editor = editor("a\n\nb\n\nc");
    select(&mut editor, (2, 0), (0, 0));
    editor.toggle_kind(BlockKind::Bullet);
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Bullet, BlockKind::Bullet, BlockKind::Bullet]
    );
    editor.toggle_kind(BlockKind::Bullet);
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph; 3]);
    editor.set_kind(BlockKind::Code {
        language: "rs".into(),
    });
    assert_eq!(texts(&editor), vec!["a\nb\nc"]);
    assert_eq!(
        editor.selection(),
        Selection::new(Pos::new(0, 4), Pos::new(0, 0))
    );
    editor.select_all();
    editor.set_kind(BlockKind::Heading(2));
    assert_eq!(texts(&editor), vec!["a", "b", "c"]);
    assert_eq!(kinds(&editor), vec![BlockKind::Heading(2); 3]);
    check(&editor).unwrap();
}

#[test]
fn toggle_task_checked_flips_only_tasks() {
    let mut editor = editor("- [ ] a\n- b");
    editor.toggle_task_checked(0);
    assert_eq!(kinds(&editor)[0], BlockKind::Task { checked: true });
    assert!(!editor.toggle_task_checked(1).changed());
    assert!(!editor.toggle_task_checked(9).changed());
}

#[test]
fn indent_respects_parent_depth_and_moves_children() {
    let mut editor = editor("- a\n- b\n    - c\n- d");
    at(&mut editor, 0, 0);
    assert!(!editor.indent().changed());
    at(&mut editor, 1, 0);
    editor.indent();
    let indents: Vec<u8> = editor.document().blocks.iter().map(|b| b.indent).collect();
    assert_eq!(indents, vec![0, 1, 2, 0]);
    assert!(!editor.indent().changed());
    editor.outdent();
    editor.outdent();
    let indents: Vec<u8> = editor.document().blocks.iter().map(|b| b.indent).collect();
    assert_eq!(indents, vec![0, 0, 1, 0]);
    assert!(!editor.outdent().changed());
}

#[test]
fn tab_in_paragraph_inserts_and_removes_literal_tab() {
    let mut editor = editor("ab");
    at(&mut editor, 0, 1);
    editor.indent();
    assert_eq!(texts(&editor), vec!["a\tb"]);
    assert_eq!(caret(&editor), (0, 2));
    editor.outdent();
    assert_eq!(texts(&editor), vec!["ab"]);
    assert_eq!(caret(&editor), (0, 1));
    let mut code = crate::support::editor("```\none\ntwo\n```");
    select(&mut code, (0, 1), (0, 5));
    code.indent();
    assert_eq!(texts(&code), vec!["\tone\n\ttwo"]);
    code.outdent();
    assert_eq!(texts(&code), vec!["one\ntwo"]);
}

#[test]
fn insert_rule_in_every_position() {
    let mut editor = editor("");
    editor.insert_rule();
    assert_eq!(kinds(&editor), vec![BlockKind::Rule, BlockKind::Paragraph]);
    assert_eq!(caret(&editor), (1, 0));
    let mut middle = crate::support::editor("abcd");
    at(&mut middle, 0, 2);
    middle.insert_rule();
    assert_eq!(texts(&middle), vec!["ab", "", "cd"]);
    assert_eq!(kinds(&middle)[1], BlockKind::Rule);
    assert_eq!(caret(&middle), (2, 0));
    let mut end = crate::support::editor("ab");
    end.move_to_doc_end(false);
    end.insert_rule();
    assert_eq!(
        kinds(&end),
        vec![BlockKind::Paragraph, BlockKind::Rule, BlockKind::Paragraph]
    );
}

#[test]
fn move_blocks_up_and_down_with_selection() {
    let mut editor = editor("a\n\nb\n\nc");
    select(&mut editor, (1, 0), (2, 1));
    editor.move_block_up();
    assert_eq!(texts(&editor), vec!["b", "c", "a"]);
    assert_eq!(
        editor.selection(),
        Selection::new(Pos::new(0, 0), Pos::new(1, 1))
    );
    assert!(!editor.move_block_up().changed());
    editor.move_block_down();
    assert_eq!(texts(&editor), vec!["a", "b", "c"]);
    editor.move_block_down();
    assert!(!editor.move_block_down().changed());
}

#[test]
fn moving_list_items_clamps_indent() {
    let mut editor = editor("- a\n    - b");
    at(&mut editor, 1, 0);
    editor.move_block_up();
    let indents: Vec<u8> = editor.document().blocks.iter().map(|b| b.indent).collect();
    assert_eq!(indents, vec![0, 0]);
    check(&editor).unwrap();
}

#[test]
fn selection_movement_by_grapheme_word_block_and_document() {
    let mut editor = editor("hello brave\u{1F1EF}\u{1F1F5} world\n\nnext");
    at(&mut editor, 0, 0);
    editor.move_word_right(false);
    assert_eq!(caret(&editor), (0, 5));
    editor.move_word_right(false);
    assert_eq!(caret(&editor), (0, 11));
    editor.move_right(false);
    assert_eq!(caret(&editor), (0, 19));
    editor.move_left(true);
    assert_eq!(editor.selection().anchor, Pos::new(0, 19));
    assert_eq!(caret(&editor), (0, 11));
    editor.move_left(false);
    assert_eq!(caret(&editor), (0, 11));
    editor.move_to_block_end(false);
    editor.move_right(false);
    assert_eq!(caret(&editor), (1, 0));
    editor.move_word_left(false);
    assert_eq!(caret(&editor), (0, 25));
    editor.move_to_doc_end(true);
    assert_eq!(caret(&editor), (1, 4));
    editor.move_to_doc_start(false);
    assert_eq!(caret(&editor), (0, 0));
    editor.move_left(false);
    assert_eq!(caret(&editor), (0, 0));
    editor.move_to_doc_end(false);
    editor.move_right(false);
    assert_eq!(caret(&editor), (1, 4));
}

#[test]
fn word_and_block_selection() {
    let mut editor = editor("foo bar-baz");
    editor.select_word_at(Pos::new(0, 5));
    assert_eq!(editor.selected_plain_text(), "bar");
    editor.select_word_at(Pos::new(0, 7));
    assert_eq!(editor.selected_plain_text(), "bar");
    editor.select_block_at(Pos::new(0, 2));
    assert_eq!(editor.selected_plain_text(), "foo bar-baz");
}

#[test]
fn set_selection_clamps_out_of_range_and_mid_grapheme_offsets() {
    let mut editor = editor("e\u{301}x");
    editor.set_selection(Selection::new(Pos::new(9, 99), Pos::new(0, 2)));
    assert_eq!(
        editor.selection(),
        Selection::new(Pos::new(0, 4), Pos::new(0, 0))
    );
    editor.delete_range(Pos::new(0, 1), Pos::new(7, 7));
    check(&editor).unwrap();
}

#[test]
fn copy_produces_markdown_plain_and_html() {
    let mut editor = editor("# Title\n\n- **one**\n- two\n\npara");
    select(&mut editor, (0, 2), (2, 2));
    assert_eq!(editor.selected_markdown(), "# tle\n\n- **one**\n- tw\n");
    assert_eq!(editor.selected_plain_text(), "tle\n- one\n- tw");
    assert_eq!(
        editor.selected_html(),
        "<h1>tle</h1><ul><li><strong>one</strong></li><li>tw</li></ul>"
    );
    select(&mut editor, (1, 1), (1, 3));
    assert_eq!(editor.selected_markdown(), "**ne**\n");
    let mut code = crate::support::editor("```\na*b\n```");
    select(&mut code, (0, 0), (0, 2));
    assert_eq!(code.selected_markdown(), "a*");
}

#[test]
fn cut_is_copy_then_delete() {
    let mut editor = editor("one two");
    select(&mut editor, (0, 3), (0, 7));
    let copied = editor.selected_markdown();
    editor.delete_selection();
    assert_eq!(copied, "&#32;two\n");
    assert_eq!(texts(&editor), vec!["one"]);
}

#[test]
fn paste_markdown_merges_first_and_last_fragments() {
    let mut editor = editor("start end");
    at(&mut editor, 0, 6);
    editor.paste_markdown("**bold** one\n\n- item\n\nlast *it*");
    assert_eq!(texts(&editor), vec!["start bold one", "item", "last itend"]);
    assert_eq!(
        kinds(&editor),
        vec![
            BlockKind::Paragraph,
            BlockKind::Bullet,
            BlockKind::Paragraph
        ]
    );
    assert_eq!(caret(&editor), (2, 7));
    assert_eq!(
        md(&editor),
        "start **bold** one\n\n- item\n\nlast *it*end\n"
    );
    check(&editor).unwrap();
}

#[test]
fn paste_markdown_into_empty_paragraph_adopts_kind() {
    let mut editor = Editor::default();
    editor.paste_markdown("## Heading");
    assert_eq!(kinds(&editor), vec![BlockKind::Heading(2)]);
    let mut list = crate::support::editor("- a\n    - b");
    list.move_to_doc_end(false);
    list.paste_markdown("- x\n    - y");
    let indents: Vec<u8> = list.document().blocks.iter().map(|b| b.indent).collect();
    assert_eq!(texts(&list), vec!["a", "bx", "y"]);
    assert_eq!(indents, vec![0, 1, 2]);
}

#[test]
fn paste_rule_and_code_fragments() {
    let mut editor = editor("ab");
    at(&mut editor, 0, 1);
    editor.paste_markdown("---");
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Paragraph, BlockKind::Rule, BlockKind::Paragraph]
    );
    assert_eq!(texts(&editor), vec!["a", "", "b"]);
    assert_eq!(caret(&editor), (2, 0));
    let mut code = crate::support::editor("ab");
    code.move_to_doc_end(false);
    code.paste_markdown("```\nx\n```");
    assert_eq!(texts(&code), vec!["ab", "x"]);
    assert_eq!(caret(&code), (1, 1));
}

#[test]
fn paste_into_code_block_is_literal() {
    let mut editor = editor("```\n\n```");
    editor.paste_markdown("# not a heading\n**raw**");
    assert_eq!(texts(&editor), vec!["# not a heading\n**raw**"]);
}

#[test]
fn paste_never_triggers_input_rules() {
    let mut editor = Editor::default();
    editor.paste_plain("# ");
    editor.paste_plain("--");
    editor.paste_plain("**x**");
    assert_eq!(texts(&editor), vec!["# --**x**"]);
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
}

#[test]
fn pasting_a_url_over_a_selection_links_it() {
    for paste in [
        |e: &mut Editor| e.paste_plain(" https://x.example "),
        |e: &mut Editor| e.paste_markdown("https://x.example"),
    ] {
        let mut editor = editor("click here");
        select(&mut editor, (0, 6), (0, 10));
        paste(&mut editor);
        assert_eq!(md(&editor), "click [here](https://x.example)\n");
    }
    let mut collapsed = editor("go");
    collapsed.move_to_doc_end(false);
    collapsed.paste_plain("https://x.example");
    assert_eq!(texts(&collapsed), vec!["gohttps://x.example"]);
}

#[test]
fn find_is_unicode_aware_and_case_folding() {
    let editor = editor("Straße STRASSE\n\nİstanbul istanbul\n\ncafe\u{301} café ÉCOLE école");
    let found = editor.find("strasse", false);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].block, 0);
    let found = editor.find("ÉCOLE", false);
    assert_eq!(found.len(), 2);
    let found = editor.find("istanbul", false);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].range, 10..18);
    let found = editor.find("cafe", false);
    assert!(
        found.is_empty(),
        "combining accent must not split: {found:?}"
    );
    assert_eq!(editor.find("École", true).len(), 0);
    assert_eq!(editor.find("école", true).len(), 1);
    assert!(editor.find("", false).is_empty());
}

#[test]
fn find_spans_cjk_rtl_and_emoji() {
    let editor = editor("中文测试 שלום עולם \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}x");
    assert_eq!(editor.find("测试", true)[0].range, 6..12);
    assert_eq!(editor.find("עולם", true).len(), 1);
    assert_eq!(editor.find("\u{1F469}", true).len(), 0);
    assert_eq!(
        editor
            .find("\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}", true)
            .len(),
        1
    );
}

#[test]
fn replace_match_and_replace_all_keep_marks() {
    let mut editor = editor("a **cat** and a cat");
    let found = editor.find("cat", true);
    editor.replace_match(&found[0], "dog");
    assert_eq!(md(&editor), "a **dog** and a cat\n");
    assert_eq!(editor.selected_plain_text(), "dog");
    editor.replace_all("A", false, "the");
    assert_eq!(md(&editor), "the **dog** thend the cthet\n");
    editor.undo();
    assert_eq!(md(&editor), "a **dog** and a cat\n");
    let stale = cap_notes::Match {
        block: 0,
        range: 90..95,
    };
    assert!(!editor.replace_match(&stale, "x").changed());
}

#[test]
fn change_reports_dirty_blocks() {
    let mut editor = editor("a\n\nb\n\nc");
    at(&mut editor, 1, 1);
    let change = editor.insert_text("x");
    assert_eq!(change.dirty(), 1..2);
    let change = editor.insert_newline();
    let blocks = change.blocks.unwrap();
    assert_eq!((blocks.start, blocks.removed, blocks.inserted), (1, 1, 2));
    editor.select_all();
    let change = editor.delete_selection();
    let blocks = change.blocks.unwrap();
    assert_eq!((blocks.start, blocks.removed, blocks.inserted), (0, 4, 1));
    assert!(!editor.toggle_mark(Mark::Bold).changed());
}

#[test]
fn origin_turns_author_when_user_types_into_generated_line() {
    let mut doc = Document::from_markdown("machine line\n\nother");
    doc.blocks[0].origin = cap_notes::Origin::Generated;
    doc.blocks[1].origin = cap_notes::Origin::Generated;
    let mut editor = Editor::new(doc);
    at(&mut editor, 0, 7);
    editor.insert_text("!");
    assert_eq!(
        editor.document().blocks[0].origin,
        cap_notes::Origin::Author
    );
    assert_eq!(
        editor.document().blocks[1].origin,
        cap_notes::Origin::Generated
    );
}
