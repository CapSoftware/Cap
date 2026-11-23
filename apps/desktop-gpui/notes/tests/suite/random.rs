use cap_notes::{
    Block, BlockId, BlockKind, Document, Editor, Mark, Pos, Selection, Span, next_grapheme,
};

use crate::support::{Rng, check, check_document, strip};

const PIECES: &[&str] = &[
    "a",
    "b",
    "word",
    " ",
    " ",
    "  ",
    "\t",
    "*",
    "**",
    "_",
    "__",
    "~",
    "~~",
    "=",
    "==",
    "`",
    "``",
    "[",
    "]",
    "(",
    ")",
    "<",
    ">",
    "#",
    "-",
    "+",
    ".",
    "1",
    "2.",
    "3)",
    "&",
    "&amp;",
    "&#32;",
    "\\",
    ":",
    "/",
    "!",
    "x",
    "http",
    "https://e.x/p_q",
    "mailto:",
    "<u>",
    "</b>",
    "é",
    "e\u{301}",
    "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}",
    "\u{1F1EF}\u{1F1F5}",
    "中文",
    "שלום",
    "snake_case",
    "[ ]",
    "---",
    "\u{a0}",
];

const URLS: &[&str] = &[
    "https://example.com",
    "https://e.x/a_(b)",
    "mailto:a@b.c",
    "rel/path",
    "has space",
    "https://x.y/*a*",
    "",
];

fn random_text(rng: &mut Rng, max_pieces: usize) -> String {
    let count = 1 + rng.below(max_pieces);
    let mut text = String::new();
    for _ in 0..count {
        text.push_str(rng.pick::<&str>(PIECES));
    }
    text
}

fn char_boundaries(text: &str) -> Vec<usize> {
    let mut out: Vec<usize> = text.char_indices().map(|(i, _)| i).collect();
    out.push(text.len());
    out
}

fn random_mark(rng: &mut Rng) -> Mark {
    match rng.below(8) {
        0 => Mark::Bold,
        1 => Mark::Italic,
        2 => Mark::Underline,
        3 => Mark::Strike,
        4 => Mark::Code,
        5 => Mark::Highlight,
        6 => Mark::Link {
            url: rng.pick(URLS).to_string(),
        },
        _ => Mark::Mention {
            id: format!("u{}", rng.below(9)),
        },
    }
}

fn random_block(rng: &mut Rng) -> Block {
    let kind = match rng.below(10) {
        0 => BlockKind::Heading(1 + rng.below(3) as u8),
        1 | 2 => BlockKind::Bullet,
        3 => BlockKind::Ordered,
        4 => BlockKind::Task {
            checked: rng.chance(50),
        },
        5 => BlockKind::Quote,
        6 => BlockKind::Code {
            language: rng.pick(&["", "rust", "js"]).to_string(),
        },
        7 => BlockKind::Rule,
        _ => BlockKind::Paragraph,
    };
    let mut text = if kind.is_code() {
        let lines = rng.below(4);
        (0..lines)
            .map(|_| random_text(rng, 4))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        random_text(rng, 8)
    };
    if matches!(kind, BlockKind::Paragraph | BlockKind::Quote) && text.is_empty() {
        text.push('x');
    }
    let mut block = Block::new(BlockId(0), kind, text);
    block.indent = rng.below(4) as u8;
    if block.kind == BlockKind::Ordered && rng.chance(30) {
        block.start = Some(rng.below(20) as u32);
    }
    if block.kind.takes_marks() && !block.text.is_empty() {
        let bounds = char_boundaries(&block.text);
        for _ in 0..rng.below(4) {
            let a = *rng.pick(&bounds);
            let b = *rng.pick(&bounds);
            block.spans.push(Span {
                range: a.min(b)..a.max(b),
                mark: random_mark(rng),
            });
        }
    }
    block
}

fn markdown_safe(doc: &Document) -> bool {
    doc.blocks.iter().all(|block| {
        !(block.kind.is_paragraph_like() && block.text.is_empty())
            && !(block.kind == BlockKind::Quote && block.text.trim_matches([' ', '\t']).is_empty())
    })
}

#[test]
fn random_documents_roundtrip_through_markdown() {
    let mut rng = Rng::new(7);
    let mut tested = 0;
    for _ in 0..3000 {
        let count = 1 + rng.below(6);
        let blocks: Vec<Block> = (0..count).map(|_| random_block(&mut rng)).collect();
        let doc = Document::from_blocks(blocks);
        if !markdown_safe(&doc) {
            continue;
        }
        tested += 1;
        let exported = doc.to_markdown();
        let back = Document::from_markdown(&exported);
        check_document(&back).unwrap();
        assert_eq!(
            strip(&back),
            strip(&doc),
            "markdown was:\n{exported}\n---\n{:#?}",
            doc.blocks
        );
        assert_eq!(back.to_markdown(), exported);
    }
    assert!(tested > 2000);
}

#[test]
fn random_markdown_reaches_a_fixed_point_after_one_pass() {
    let mut rng = Rng::new(99);
    let fragments = [
        "# ",
        "## ",
        "- ",
        "* ",
        "1. ",
        "2) ",
        "> ",
        "    ",
        "  ",
        "\t",
        "- [ ] ",
        "- [x] ",
        "```",
        "~~~",
        "---",
        "\n",
        "\n\n",
        "**",
        "*",
        "_",
        "__",
        "~~",
        "==",
        "`",
        "[a](b)",
        "[",
        "](",
        ")",
        "<u>",
        "</u>",
        "<https://x.y>",
        "https://q.r/s",
        "\\",
        "&#33;",
        "&amp;",
        "text",
        "a b",
        "\u{1F600}",
        "中",
        "#",
        ">",
        "<",
        "|",
        "!",
    ];
    for _ in 0..3000 {
        let mut source = String::new();
        for _ in 0..rng.below(16) {
            source.push_str(rng.pick::<&str>(&fragments));
        }
        let first = Document::from_markdown(&source);
        check_document(&first).unwrap();
        let once = first.to_markdown();
        let second = Document::from_markdown(&once);
        let twice = second.to_markdown();
        assert_eq!(twice, once, "source {source:?}");
    }
}

fn random_pos(rng: &mut Rng, editor: &Editor) -> Pos {
    let doc = editor.document();
    let block = rng.below(doc.blocks.len());
    let len = doc.blocks[block].text.len();
    Pos::new(block, rng.below(len + 2))
}

fn random_command(rng: &mut Rng, editor: &mut Editor) {
    let typed = [
        "a",
        " ",
        "*",
        "_",
        "`",
        "~",
        "=",
        "#",
        "-",
        ">",
        "[",
        "]",
        "(",
        ")",
        "1",
        ".",
        "x",
        "/",
        "2",
        "<",
        "!",
        "\u{1F600}",
        "e\u{301}",
        "\u{1F1EF}\u{1F1F5}",
        "中",
        "\t",
    ];
    match rng.below(40) {
        0..=11 => {
            editor.insert_text(rng.pick::<&str>(&typed));
        }
        12 => {
            editor.insert_text("multi\nline\ntext");
        }
        13 | 14 => {
            editor.insert_newline();
        }
        15 | 16 => {
            editor.backspace();
        }
        17 => {
            editor.delete_forward();
        }
        18 => {
            let a = random_pos(rng, editor);
            let b = random_pos(rng, editor);
            editor.delete_range(a, b);
        }
        19 | 20 => {
            let a = random_pos(rng, editor);
            let b = if rng.chance(50) {
                a
            } else {
                random_pos(rng, editor)
            };
            editor.set_selection(Selection::new(a, b));
        }
        21 => {
            let mark = match rng.below(4) {
                0 => Mark::Bold,
                1 => Mark::Code,
                2 => Mark::Link {
                    url: "https://l.example".into(),
                },
                _ => Mark::Italic,
            };
            editor.toggle_mark(mark);
        }
        22 => {
            let kind = match rng.below(7) {
                0 => BlockKind::Heading(2),
                1 => BlockKind::Bullet,
                2 => BlockKind::Task { checked: false },
                3 => BlockKind::Code {
                    language: String::new(),
                },
                4 => BlockKind::Quote,
                5 => BlockKind::Ordered,
                _ => BlockKind::Paragraph,
            };
            editor.toggle_kind(kind);
        }
        23 => {
            editor.indent();
        }
        24 => {
            editor.outdent();
        }
        25 => {
            editor.insert_rule();
        }
        26 => {
            if rng.chance(50) {
                editor.move_block_up();
            } else {
                editor.move_block_down();
            }
        }
        27 => {
            editor.undo();
        }
        28 => {
            editor.redo();
        }
        29 => {
            let md = editor.selected_markdown();
            editor.paste_markdown(&md);
        }
        30 => {
            editor.paste_markdown("- pasted **item**\n- second\n\ntail para");
        }
        31 => {
            editor.paste_plain("plain\npaste");
        }
        32 => match rng.below(6) {
            0 => editor.move_left(rng.chance(50)),
            1 => editor.move_right(rng.chance(50)),
            2 => editor.move_word_left(rng.chance(50)),
            3 => editor.move_word_right(rng.chance(50)),
            4 => editor.move_to_block_end(rng.chance(50)),
            _ => editor.move_to_doc_start(rng.chance(50)),
        },
        33 => {
            editor.set_link(if rng.chance(50) {
                Some("https://s.example".into())
            } else {
                None
            });
        }
        34 => {
            let index = rng.below(editor.document().blocks.len());
            editor.toggle_task_checked(index);
        }
        35 => {
            let found = editor.find("a", rng.chance(50));
            if let Some(first) = found.first() {
                editor.replace_match(&first.clone(), "Z\u{1F600}");
            }
        }
        36 => {
            editor.break_undo_group();
        }
        37 => {
            let pos = random_pos(rng, editor);
            if rng.chance(50) {
                editor.select_word_at(pos);
            } else {
                editor.select_block_at(pos);
            }
        }
        38 => {
            editor.replace_all("b", false, "bb");
        }
        _ => {
            editor.select_all();
        }
    }
}

#[test]
fn monkey_commands_keep_invariants_and_undo_restores_everything() {
    let mut rng = Rng::new(2024);
    for round in 0..60 {
        let source = match round % 3 {
            0 => "",
            1 => {
                "# Title\n\n- a\n    - b\n- [ ] c\n\n```\ncode\n```\n\n---\n\npara **bold** [l](u)"
            }
            _ => {
                "1. x\n2. y\n\n> q\n\ntext with \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} and e\u{301}"
            }
        };
        let mut editor = Editor::new(Document::from_markdown(source));
        let initial = editor.document().clone();
        let mut steps = 0;
        for _ in 0..150 {
            random_command(&mut rng, &mut editor);
            steps += 1;
            if let Err(error) = check(&editor) {
                panic!(
                    "round {round} step {steps}: {error}\n{:#?}",
                    editor.document().blocks
                );
            }
        }
        let markdown = editor.document().to_markdown();
        let reparsed = Document::from_markdown(&markdown);
        let normal = reparsed.to_markdown();
        assert_eq!(Document::from_markdown(&normal).to_markdown(), normal);
        while editor.can_redo() {
            editor.redo();
        }
        let fin = editor.document().clone();
        while editor.can_undo() {
            editor.undo();
            check(&editor).unwrap();
        }
        if editor.undo_depth() == 0 && !history_was_truncated(steps) {
            assert_eq!(
                editor.document(),
                &initial,
                "round {round} did not undo to the start"
            );
        }
        while editor.can_redo() {
            editor.redo();
            check(&editor).unwrap();
        }
        assert_eq!(
            editor.document(),
            &fin,
            "round {round} did not redo to the end"
        );
    }
}

fn history_was_truncated(steps: usize) -> bool {
    steps > 500
}

#[test]
fn random_offsets_never_panic_and_clamp_to_graphemes() {
    let text = "a\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}e\u{301}\u{1F1EF}\u{1F1F5}中";
    let mut editor = Editor::new(Document::from_blocks(vec![Block::paragraph(
        BlockId(1),
        text,
    )]));
    let mut rng = Rng::new(5);
    for _ in 0..2000 {
        let offset = rng.below(text.len() + 4);
        editor.set_selection(Selection::caret(Pos::new(rng.below(3), offset)));
        check(&editor).unwrap();
        let head = editor.selection().head;
        let mut boundary = 0;
        while boundary < head.offset {
            boundary = next_grapheme(text, boundary);
        }
        assert_eq!(boundary, head.offset);
    }
}
