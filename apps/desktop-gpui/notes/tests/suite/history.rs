use cap_notes::{BlockKind, Editor, Mark, Pos, Selection};

use crate::support::{at, caret, editor, kinds, select, texts, type_text};

#[test]
fn consecutive_typing_coalesces_until_whitespace() {
    let mut editor = Editor::default();
    type_text(&mut editor, "hello world");
    assert_eq!(editor.undo_depth(), 2);
    editor.undo();
    assert_eq!(texts(&editor), vec!["hello "]);
    assert_eq!(caret(&editor), (0, 6));
    editor.undo();
    assert_eq!(texts(&editor), vec![""]);
    assert!(!editor.can_undo());
    editor.redo();
    assert_eq!(texts(&editor), vec!["hello "]);
    editor.redo();
    assert_eq!(texts(&editor), vec!["hello world"]);
    assert_eq!(caret(&editor), (0, 11));
    assert!(!editor.can_redo());
}

#[test]
fn moving_the_caret_or_breaking_the_group_starts_a_new_step() {
    let mut editor = Editor::default();
    type_text(&mut editor, "ab");
    editor.move_left(false);
    type_text(&mut editor, "X");
    assert_eq!(editor.undo_depth(), 2);
    editor.break_undo_group();
    type_text(&mut editor, "Y");
    assert_eq!(editor.undo_depth(), 3);
    editor.undo();
    assert_eq!(texts(&editor), vec!["aXb"]);
    editor.undo();
    assert_eq!(texts(&editor), vec!["ab"]);
    assert_eq!(caret(&editor), (0, 1));
}

#[test]
fn non_typing_commands_break_the_group() {
    let mut editor = Editor::default();
    type_text(&mut editor, "ab");
    editor.select_all();
    editor.toggle_mark(Mark::Bold);
    editor.move_to_doc_end(false);
    type_text(&mut editor, "cd");
    assert_eq!(editor.undo_depth(), 3);
    editor.undo();
    assert_eq!(texts(&editor), vec!["ab"]);
    assert!(!editor.document().blocks[0].spans.is_empty());
    editor.undo();
    assert!(editor.document().blocks[0].spans.is_empty());
}

#[test]
fn undo_restores_selection_including_reversed() {
    let mut editor = editor("one\n\ntwo\n\nthree");
    select(&mut editor, (2, 2), (0, 1));
    editor.backspace();
    assert_eq!(texts(&editor), vec!["oree"]);
    editor.undo();
    assert_eq!(texts(&editor), vec!["one", "two", "three"]);
    assert_eq!(
        editor.selection(),
        Selection::new(Pos::new(2, 2), Pos::new(0, 1))
    );
    editor.redo();
    assert_eq!(editor.selection(), Selection::caret(Pos::new(0, 1)));
}

#[test]
fn new_edit_clears_redo() {
    let mut editor = Editor::default();
    type_text(&mut editor, "a ");
    editor.undo();
    assert!(editor.can_redo());
    type_text(&mut editor, "b");
    assert!(!editor.can_redo());
}

#[test]
fn history_is_bounded() {
    let mut editor = Editor::default();
    for _ in 0..700 {
        editor.insert_text("a");
        editor.break_undo_group();
    }
    assert_eq!(editor.undo_depth(), 500);
    while editor.can_undo() {
        editor.undo();
    }
    assert_eq!(texts(&editor), vec!["a".repeat(200)]);
}

#[test]
fn undo_of_structural_commands() {
    let mut editor = editor("- a\n- b\n- c");
    let original = editor.document().clone();
    at(&mut editor, 1, 0);
    editor.indent();
    editor.move_block_down();
    editor.insert_rule();
    editor.toggle_kind(BlockKind::Quote);
    editor.set_kind(BlockKind::Code {
        language: String::new(),
    });
    editor.toggle_task_checked(0);
    for _ in 0..5 {
        editor.undo();
    }
    assert_eq!(editor.document(), &original);
    assert_eq!(kinds(&editor), vec![BlockKind::Bullet; 3]);
}

#[test]
fn undo_with_nothing_is_a_noop() {
    let mut editor = Editor::default();
    assert!(!editor.undo().changed());
    assert!(!editor.redo().changed());
}

#[test]
fn undo_and_redo_report_changes() {
    let mut editor = editor("a\n\nb");
    at(&mut editor, 0, 1);
    editor.insert_newline();
    let change = editor.undo();
    let blocks = change.blocks.unwrap();
    assert_eq!((blocks.start, blocks.removed, blocks.inserted), (0, 2, 1));
    let change = editor.redo();
    let blocks = change.blocks.unwrap();
    assert_eq!((blocks.start, blocks.removed, blocks.inserted), (0, 1, 2));
}

#[test]
fn paste_and_typing_are_separate_steps() {
    let mut editor = Editor::default();
    type_text(&mut editor, "ab");
    editor.paste_plain("XY");
    type_text(&mut editor, "c");
    assert_eq!(editor.undo_depth(), 3);
    editor.undo();
    editor.undo();
    assert_eq!(texts(&editor), vec!["ab"]);
}
