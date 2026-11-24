use cap_notes::{
    Block, BlockId, Document, Editor, Pos, Selection, clamp_to_grapheme, is_grapheme_boundary,
    next_grapheme, next_word, prev_grapheme, prev_word, word_range_at,
};

use crate::support::{caret, check, texts, type_text};

const FAMILY: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}";
const FLAG: &str = "\u{1F1EF}\u{1F1F5}";
const ACCENT: &str = "e\u{301}";

#[test]
fn grapheme_steps_over_clusters() {
    let text = format!("a{FAMILY}{FLAG}{ACCENT}中");
    let mut offsets = vec![0];
    while *offsets.last().unwrap() < text.len() {
        let next = next_grapheme(&text, *offsets.last().unwrap());
        offsets.push(next);
    }
    assert_eq!(
        offsets,
        vec![
            0,
            1,
            1 + FAMILY.len(),
            1 + FAMILY.len() + 8,
            1 + FAMILY.len() + 11,
            text.len()
        ]
    );
    let mut back = vec![text.len()];
    while *back.last().unwrap() > 0 {
        let prev = prev_grapheme(&text, *back.last().unwrap());
        back.push(prev);
    }
    back.reverse();
    assert_eq!(back, offsets);
    assert_eq!(next_grapheme(&text, text.len()), text.len());
    assert_eq!(prev_grapheme(&text, 0), 0);
}

#[test]
fn clamping_handles_every_byte_offset() {
    let text = format!("x{FAMILY}y{ACCENT}{FLAG}");
    for offset in 0..text.len() + 5 {
        let clamped = clamp_to_grapheme(&text, offset);
        assert!(is_grapheme_boundary(&text, clamped), "{offset}");
        assert!(clamped <= offset.min(text.len()));
        let next = next_grapheme(&text, offset);
        let prev = prev_grapheme(&text, offset);
        assert!(is_grapheme_boundary(&text, next) && is_grapheme_boundary(&text, prev));
    }
    assert!(!is_grapheme_boundary(&text, 2));
    assert!(!is_grapheme_boundary(&text, 999));
}

#[test]
fn words_in_latin_cjk_and_rtl() {
    let text = "hello, wörld  中文 שלום";
    assert_eq!(next_word(text, 0), 5);
    assert_eq!(next_word(text, 5), 13);
    assert_eq!(prev_word(text, 13), 7);
    assert_eq!(prev_word(text, 7), 0);
    assert_eq!(word_range_at(text, 8), 7..13);
    let hebrew = text.find('ש').unwrap();
    assert_eq!(next_word(text, hebrew), text.len());
    assert_eq!(prev_word(text, text.len()), hebrew);
    assert_eq!(word_range_at("", 3), 0..0);
}

#[test]
fn editing_around_emoji_and_combining_marks() {
    let mut editor = Editor::default();
    type_text(&mut editor, &format!("{FAMILY}{ACCENT}"));
    assert_eq!(texts(&editor), vec![format!("{FAMILY}{ACCENT}")]);
    editor.move_left(false);
    assert_eq!(caret(&editor), (0, FAMILY.len()));
    editor.move_left(false);
    assert_eq!(caret(&editor), (0, 0));
    editor.delete_forward();
    assert_eq!(texts(&editor), vec![ACCENT.to_string()]);
    editor.move_right(true);
    assert_eq!(editor.selected_plain_text(), ACCENT);
    type_text(&mut editor, FLAG);
    assert_eq!(texts(&editor), vec![FLAG.to_string()]);
    check(&editor).unwrap();
}

#[test]
fn offsets_inside_clusters_are_clamped_by_every_entry_point() {
    let text = format!("{FAMILY}x");
    let mut editor = Editor::new(Document::from_blocks(vec![Block::paragraph(
        BlockId(1),
        text.clone(),
    )]));
    editor.set_selection(Selection::new(Pos::new(0, 3), Pos::new(0, 6)));
    check(&editor).unwrap();
    assert_eq!(editor.selection().anchor.offset, 0);
    editor.delete_range(Pos::new(0, 5), Pos::new(0, 9));
    check(&editor).unwrap();
    assert_eq!(texts(&editor), vec![text.clone()]);
    editor.select_word_at(Pos::new(0, 13));
    check(&editor).unwrap();
    editor.select_block_at(Pos::new(4, 4));
    assert_eq!(editor.selected_plain_text(), text);
    assert!(editor.link_at(Pos::new(0, 1)).is_none());
}

#[test]
fn rtl_and_cjk_round_trip_through_markdown_and_edits() {
    let mut editor = Editor::default();
    type_text(&mut editor, "## עברית **מודגש** 中文 *斜体*");
    assert_eq!(
        editor.document().to_markdown(),
        "## עברית **מודגש** 中文 *斜体*\n"
    );
    editor.move_word_left(false);
    editor.move_word_left(true);
    check(&editor).unwrap();
}
