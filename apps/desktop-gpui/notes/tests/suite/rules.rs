use cap_notes::{BlockKind, Editor, Mark};

use crate::support::{caret, check, editor, kinds, md, texts, type_text};

fn typed(text: &str) -> Editor {
    let mut editor = Editor::default();
    type_text(&mut editor, text);
    check(&editor).unwrap();
    editor
}

#[test]
fn block_rules_fire_at_paragraph_start() {
    let cases: Vec<(&str, BlockKind)> = vec![
        ("# ", BlockKind::Heading(1)),
        ("## ", BlockKind::Heading(2)),
        ("### ", BlockKind::Heading(3)),
        ("- ", BlockKind::Bullet),
        ("* ", BlockKind::Bullet),
        ("+ ", BlockKind::Bullet),
        ("1. ", BlockKind::Ordered),
        ("1) ", BlockKind::Ordered),
        ("[] ", BlockKind::Task { checked: false }),
        ("[ ] ", BlockKind::Task { checked: false }),
        ("[x] ", BlockKind::Task { checked: true }),
        ("> ", BlockKind::Quote),
    ];
    for (pattern, kind) in cases {
        let editor = typed(pattern);
        assert_eq!(kinds(&editor), vec![kind], "{pattern}");
        assert_eq!(texts(&editor), vec![""], "{pattern}");
        assert_eq!(caret(&editor), (0, 0));
    }
}

#[test]
fn ordered_rule_remembers_start_number() {
    let editor = typed("12. a\nb");
    assert_eq!(editor.document().ordinals(), vec![Some(12), Some(13)]);
}

#[test]
fn block_rule_keeps_text_after_caret() {
    let mut editor = editor("title");
    crate::support::at(&mut editor, 0, 0);
    type_text(&mut editor, "## ");
    assert_eq!(kinds(&editor), vec![BlockKind::Heading(2)]);
    assert_eq!(texts(&editor), vec!["title"]);
}

#[test]
fn task_rule_converts_bullet_items() {
    let editor = typed("- [x] done");
    assert_eq!(kinds(&editor), vec![BlockKind::Task { checked: true }]);
    assert_eq!(texts(&editor), vec!["done"]);
}

#[test]
fn block_rules_do_not_fire_mid_text_in_headings_or_code() {
    let editor = typed("a # b - c");
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
    let editor = typed("# ## x");
    assert_eq!(texts(&editor), vec!["## x"]);
    let mut code = crate::support::editor("```\n\n```");
    type_text(&mut code, "# - **a** -- ... `x`");
    assert_eq!(texts(&code), vec!["# - **a** -- ... `x`"]);
    assert!(code.document().blocks[0].spans.is_empty());
}

#[test]
fn horizontal_rule_by_third_char_or_enter() {
    for pattern in ["---", "***", "___"] {
        let editor = typed(pattern);
        assert_eq!(
            kinds(&editor),
            vec![BlockKind::Rule, BlockKind::Paragraph],
            "{pattern}"
        );
        assert_eq!(caret(&editor), (1, 0));
    }
    let mut editor = typed("---");
    editor.undo();
    assert_eq!(texts(&editor), vec!["---"]);
    editor.insert_newline();
    assert_eq!(kinds(&editor), vec![BlockKind::Rule, BlockKind::Paragraph]);
    let editor = typed("x---");
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
}

#[test]
fn code_fence_by_enter_with_language() {
    let editor = typed("```rust\nfn x");
    assert_eq!(
        kinds(&editor),
        vec![BlockKind::Code {
            language: "rust".into()
        }]
    );
    assert_eq!(texts(&editor), vec!["fn x"]);
    let mut plain = typed("```");
    plain.insert_newline();
    assert_eq!(
        kinds(&plain),
        vec![BlockKind::Code {
            language: String::new()
        }]
    );
    plain.undo();
    assert_eq!(texts(&plain), vec!["```"]);
    assert_eq!(kinds(&plain), vec![BlockKind::Paragraph]);
}

#[test]
fn inline_rules_fire_on_closing_delimiter() {
    let cases: Vec<(&str, Mark, &str)> = vec![
        ("**bold**", Mark::Bold, "bold"),
        ("__bold__", Mark::Bold, "bold"),
        ("*it*", Mark::Italic, "it"),
        ("_it_", Mark::Italic, "it"),
        ("~~gone~~", Mark::Strike, "gone"),
        ("`code`", Mark::Code, "code"),
        ("==hi==", Mark::Highlight, "hi"),
    ];
    for (input, mark, inner) in cases {
        let editor = typed(&format!("say {input}"));
        let block = &editor.document().blocks[0];
        assert_eq!(block.text, format!("say {inner}"), "{input}");
        assert_eq!(block.spans.len(), 1, "{input}");
        assert_eq!(block.spans[0].mark, mark, "{input}");
        assert_eq!(&block.text[block.spans[0].range.clone()], inner);
    }
}

#[test]
fn typing_after_inline_rule_is_unmarked() {
    let editor = typed("**b** after");
    assert_eq!(md(&editor), "**b** after\n");
    let editor = typed("`c` after");
    assert_eq!(md(&editor), "`c` after\n");
}

#[test]
fn link_rule_on_closing_paren() {
    let editor = typed("see [docs](https://d.example) now");
    assert_eq!(md(&editor), "see [docs](https://d.example) now\n");
    assert_eq!(texts(&editor), vec!["see docs now"]);
}

#[test]
fn bare_url_becomes_link_on_space_or_enter() {
    let editor = typed("go https://a.example/x. next");
    let block = &editor.document().blocks[0];
    assert_eq!(block.text, "go https://a.example/x. next");
    assert_eq!(block.spans[0].range, 3..22);
    assert_eq!(
        block.spans[0].mark,
        Mark::Link {
            url: "https://a.example/x".into()
        }
    );
    let editor = typed("mailto:me@x.y\nz");
    assert_eq!(editor.document().blocks[0].spans.len(), 1);
    assert_eq!(caret(&editor), (1, 1));
    let editor = typed("xhttps://no.link ");
    assert!(editor.document().blocks[0].spans.is_empty());
}

#[test]
fn inline_rules_do_not_fire_when_they_should_not() {
    for input in [
        "snake_case_name ",
        "a_b_",
        "** spaced**",
        "**spaced **",
        "****",
        "``",
        "2 * 3 * 4",
        "[](x)",
        "[a]( )",
    ] {
        let editor = typed(input);
        assert!(
            editor.document().blocks[0].spans.is_empty(),
            "{input} => {:?}",
            editor.document().blocks[0]
        );
    }
    let editor = typed("snake_case_name");
    assert_eq!(texts(&editor), vec!["snake_case_name"]);
}

#[test]
fn rules_do_not_fire_inside_code_marks() {
    let mut editor = Editor::default();
    editor.toggle_mark(Mark::Code);
    type_text(&mut editor, "**a** -- # ");
    assert_eq!(texts(&editor), vec!["**a** -- # "]);
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
}

#[test]
fn typography_replacements() {
    let cases = [
        ("a--b", "a\u{2014}b"),
        ("wait...", "wait\u{2026}"),
        ("a->b", "a\u{2192}b"),
        ("a<-b", "a\u{2190}b"),
        ("(c) (r) (tm) (C)", "\u{a9} \u{ae} \u{2122} \u{a9}"),
        ("1/2 1/4 3/4 ", "\u{bd} \u{bc} \u{be} "),
        ("+/-", "\u{b1}"),
        ("a!=b", "a\u{2260}b"),
        ("<<q>>", "\u{ab}q\u{bb}"),
        ("m^2 2^2 3^3", "m^2 2\u{b2} 3\u{b3}"),
        ("2x3", "2\u{d7}3"),
    ];
    for (input, expected) in cases {
        let editor = typed(input);
        assert_eq!(texts(&editor), vec![expected], "{input}");
    }
}

#[test]
fn typography_skips_digit_neighbours_urls_and_can_be_disabled() {
    for (input, expected) in [
        ("11/2 ", "11/2 "),
        ("1/25", "1/25"),
        ("1/2/3", "1/2/3"),
        ("x https://a.b/c--d...e ", "x https://a.b/c--d...e "),
        ("ax3", "ax3"),
    ] {
        let editor = typed(input);
        assert_eq!(texts(&editor), vec![expected], "{input}");
    }
    let mut editor = Editor::default();
    editor.rules.typography = false;
    type_text(&mut editor, "a--b... (c)");
    assert_eq!(texts(&editor), vec!["a--b... (c)"]);
    let mut editor = Editor::default();
    editor.rules.markdown = false;
    type_text(&mut editor, "# **x** ");
    assert_eq!(texts(&editor), vec!["# **x** "]);
}

#[test]
fn smart_quotes_are_not_applied() {
    let editor = typed("\"quoted\" 'single'");
    assert_eq!(texts(&editor), vec!["\"quoted\" 'single'"]);
}

#[test]
fn each_rule_is_its_own_undo_step() {
    let mut editor = typed("# ");
    editor.undo();
    assert_eq!(texts(&editor), vec!["# "]);
    assert_eq!(kinds(&editor), vec![BlockKind::Paragraph]);
    assert_eq!(caret(&editor), (0, 2));
    editor.undo();
    assert_eq!(texts(&editor), vec![""]);
    editor.redo();
    editor.redo();
    assert_eq!(kinds(&editor), vec![BlockKind::Heading(1)]);
    let mut editor = typed("x **b**");
    editor.undo();
    assert_eq!(texts(&editor), vec!["x **b**"]);
    assert!(editor.document().blocks[0].spans.is_empty());
    let mut editor = typed("a--");
    editor.undo();
    assert_eq!(texts(&editor), vec!["a--"]);
    let mut editor = typed("see https://u.example ");
    editor.undo();
    assert!(editor.document().blocks[0].spans.is_empty());
    assert_eq!(texts(&editor), vec!["see https://u.example "]);
}
