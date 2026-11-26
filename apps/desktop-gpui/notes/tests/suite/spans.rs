use cap_notes::{
    Block, BlockId, BlockKind, Document, Editor, MAX_INDENT, Mark, MarkSet, Pos, Span,
};

use crate::support::{at, check, editor, md, select, texts};

fn marked(text: &str, spans: &[(std::ops::Range<usize>, Mark)]) -> Block {
    Block::paragraph(BlockId(1), text).with_spans(
        spans
            .iter()
            .map(|(range, mark)| Span {
                range: range.clone(),
                mark: mark.clone(),
            })
            .collect(),
    )
}

#[test]
fn spans_are_normalised_on_construction() {
    let block = marked(
        "héllo world",
        &[
            (0..3, Mark::Bold),
            (2..6, Mark::Bold),
            (8..8, Mark::Italic),
            (9..99, Mark::Italic),
            (2..3, Mark::Code),
        ],
    );
    assert_eq!(
        block.spans,
        vec![
            Span {
                range: 0..6,
                mark: Mark::Bold
            },
            Span {
                range: 1..3,
                mark: Mark::Code
            },
            Span {
                range: 9..12,
                mark: Mark::Italic
            },
        ]
    );
    let code = Block::new(
        BlockId(1),
        BlockKind::Code {
            language: String::new(),
        },
        "x",
    )
    .with_spans(vec![Span {
        range: 0..1,
        mark: Mark::Bold,
    }]);
    assert!(code.spans.is_empty());
}

#[test]
fn links_never_overlap_each_other() {
    let block = marked(
        "abcdef",
        &[
            (0..4, Mark::Link { url: "a".into() }),
            (2..6, Mark::Link { url: "b".into() }),
        ],
    );
    let ranges: Vec<_> = block.spans.iter().map(|s| s.range.clone()).collect();
    assert_eq!(ranges, vec![0..4, 4..6]);
}

#[test]
fn runs_cover_text_with_mark_sets() {
    let block = marked("abcdef", &[(1..4, Mark::Bold), (3..5, Mark::Italic)]);
    let runs = block.runs();
    let summary: Vec<(std::ops::Range<usize>, usize)> = runs
        .iter()
        .map(|run| (run.range.clone(), run.marks.len()))
        .collect();
    assert_eq!(
        summary,
        vec![(0..1, 0), (1..3, 1), (3..4, 2), (4..5, 1), (5..6, 0)]
    );
    assert!(Block::paragraph(BlockId(1), "").runs().is_empty());
    let set: MarkSet = [Mark::Italic, Mark::Bold, Mark::Bold].into_iter().collect();
    assert_eq!(set.len(), 2);
}

#[test]
fn spans_shift_through_inserts_and_deletes() {
    let mut editor = editor("ab **cd** ef");
    at(&mut editor, 0, 0);
    editor.insert_text("X");
    assert_eq!(md(&editor), "Xab **cd** ef\n");
    at(&mut editor, 0, 5);
    editor.insert_text("Y");
    assert_eq!(md(&editor), "Xab **cYd** ef\n");
    editor.delete_range(Pos::new(0, 2), Pos::new(0, 6));
    assert_eq!(md(&editor), "Xa**d** ef\n");
    editor.delete_range(Pos::new(0, 2), Pos::new(0, 3));
    assert_eq!(md(&editor), "Xa ef\n");
    check(&editor).unwrap();
}

#[test]
fn spans_survive_merge_of_blocks() {
    let mut editor = editor("a *b*\n\n**c** d");
    at(&mut editor, 1, 0);
    editor.backspace();
    assert_eq!(texts(&editor), vec!["a bc d"]);
    let spans = &editor.document().blocks[0].spans;
    assert_eq!(
        spans[0],
        Span {
            range: 2..3,
            mark: Mark::Italic
        }
    );
    assert_eq!(
        spans[1],
        Span {
            range: 3..4,
            mark: Mark::Bold
        }
    );
    assert_eq!(
        Document::from_markdown(&md(&editor)).blocks[0].spans,
        *spans
    );
}

#[test]
fn adjacent_equal_marks_merge_after_join() {
    let mut editor = editor("**a**\n\n**b**");
    at(&mut editor, 1, 0);
    editor.backspace();
    assert_eq!(
        editor.document().blocks[0].spans,
        vec![Span {
            range: 0..2,
            mark: Mark::Bold
        }]
    );
}

#[test]
fn marks_at_selection_is_intersection() {
    let mut editor = editor("**a *b***\n\n**c**");
    select(&mut editor, (0, 0), (1, 1));
    let marks = editor.marks_at_selection();
    assert!(marks.contains(&Mark::Bold));
    assert!(!marks.contains(&Mark::Italic));
    select(&mut editor, (0, 2), (0, 3));
    assert!(editor.marks_at_selection().contains(&Mark::Italic));
}

#[test]
fn indent_never_exceeds_max_depth() {
    let source: String = (0..=MAX_INDENT)
        .map(|depth| format!("{}- item\n", "    ".repeat(depth as usize)))
        .collect();
    let mut editor = Editor::new(Document::from_markdown(&format!("{source}- last")));
    let last = editor.document().blocks.len() - 1;
    for _ in 0..20 {
        at(&mut editor, last, 0);
        editor.indent();
        let indents: Vec<u8> = editor.document().blocks.iter().map(|b| b.indent).collect();
        assert!(indents.iter().all(|d| *d <= MAX_INDENT));
        check(&editor).unwrap();
    }
    assert_eq!(editor.document().blocks[last].indent, MAX_INDENT);
}
