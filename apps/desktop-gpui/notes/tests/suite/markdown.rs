use cap_notes::{BlockKind, Document, Mark, Span};

use crate::support::{check_document, strip};

const FIXTURE: &str = "# Title

Some **bold** and *italic* and ~~strike~~ and `code` and ==mark== and <u>under</u> with a [link](https://example.com) and <https://auto.example/x> and [@Ana](mention:u1).

- one
- two
    - nested
        - deeper
- [ ] todo
- [x] done

3. three
4. four

> quote one
>
> quote two

```rust
fn main() {
    println!(\"hi\");
}
```

---

Escaped \\*stars\\* and 1\\. not a list and snake_case_name
";

fn spans_of(doc: &Document, index: usize) -> Vec<(String, Mark)> {
    let block = &doc.blocks[index];
    block
        .spans
        .iter()
        .map(|span| {
            (
                block.text[span.range.clone()].to_string(),
                span.mark.clone(),
            )
        })
        .collect()
}

fn roundtrip(doc: &Document) -> Document {
    Document::from_markdown(&doc.to_markdown())
}

#[test]
fn fixture_parses_every_construct() {
    let doc = Document::from_markdown(FIXTURE);
    check_document(&doc).unwrap();
    let kinds: Vec<BlockKind> = doc.blocks.iter().map(|b| b.kind.clone()).collect();
    assert_eq!(
        kinds,
        vec![
            BlockKind::Heading(1),
            BlockKind::Paragraph,
            BlockKind::Bullet,
            BlockKind::Bullet,
            BlockKind::Bullet,
            BlockKind::Bullet,
            BlockKind::Task { checked: false },
            BlockKind::Task { checked: true },
            BlockKind::Ordered,
            BlockKind::Ordered,
            BlockKind::Quote,
            BlockKind::Quote,
            BlockKind::Code {
                language: "rust".into()
            },
            BlockKind::Rule,
            BlockKind::Paragraph,
        ]
    );
    let indents: Vec<u8> = doc.blocks[2..8].iter().map(|b| b.indent).collect();
    assert_eq!(indents, vec![0, 0, 1, 2, 0, 0]);
    assert_eq!(doc.ordinal(8), Some(3));
    assert_eq!(doc.ordinal(9), Some(4));
    assert_eq!(
        doc.blocks[1].text,
        "Some bold and italic and strike and code and mark and under with a link and https://auto.example/x and @Ana."
    );
    assert_eq!(
        spans_of(&doc, 1),
        vec![
            ("bold".into(), Mark::Bold),
            ("italic".into(), Mark::Italic),
            ("strike".into(), Mark::Strike),
            ("code".into(), Mark::Code),
            ("mark".into(), Mark::Highlight),
            ("under".into(), Mark::Underline),
            (
                "link".into(),
                Mark::Link {
                    url: "https://example.com".into()
                }
            ),
            (
                "https://auto.example/x".into(),
                Mark::Link {
                    url: "https://auto.example/x".into()
                }
            ),
            ("@Ana".into(), Mark::Mention { id: "u1".into() }),
        ]
    );
    assert_eq!(doc.blocks[12].text, "fn main() {\n    println!(\"hi\");\n}");
    assert_eq!(
        doc.blocks[14].text,
        "Escaped *stars* and 1. not a list and snake_case_name"
    );
    assert!(doc.blocks[14].spans.is_empty());
}

#[test]
fn fixture_roundtrips_and_is_idempotent() {
    let doc = Document::from_markdown(FIXTURE);
    let exported = doc.to_markdown();
    let again = Document::from_markdown(&exported);
    assert_eq!(strip(&again), strip(&doc));
    assert_eq!(again.to_markdown(), exported);
    assert!(
        exported.contains("- one\n- two\n    - nested\n        - deeper\n- [ ] todo\n- [x] done")
    );
    assert!(exported.contains("> quote one\n>\n> quote two"));
    assert!(exported.contains("3. three\n4. four"));
    assert!(exported.contains("```rust\nfn main() {"));
    assert!(exported.contains("snake_case_name"));
}

#[test]
fn headings_four_to_six_map_to_three_and_closing_hashes_strip() {
    let doc = Document::from_markdown("#### four\n\n###### six ##\n\n# a #b #");
    assert_eq!(doc.blocks[0].kind, BlockKind::Heading(3));
    assert_eq!(doc.blocks[1].kind, BlockKind::Heading(3));
    assert_eq!(doc.blocks[1].text, "six");
    assert_eq!(doc.blocks[2].text, "a #b");
}

#[test]
fn soft_breaks_join_with_space_and_lazy_lines_continue() {
    let doc = Document::from_markdown("one\ntwo  \n   three\n\n- item\ncontinued");
    assert_eq!(doc.blocks[0].text, "one two three");
    assert_eq!(doc.blocks[1].text, "item continued");
}

#[test]
fn nesting_accepts_two_spaces_four_spaces_and_tabs() {
    for source in [
        "- a\n  - b\n    - c\n- d",
        "- a\n    - b\n        - c\n- d",
        "- a\n\t- b\n\t\t- c\n- d",
    ] {
        let doc = Document::from_markdown(source);
        let indents: Vec<u8> = doc.blocks.iter().map(|b| b.indent).collect();
        assert_eq!(indents, vec![0, 1, 2, 0], "{source}");
    }
    let doc = Document::from_markdown("Para\n\n        - too deep");
    assert_eq!(doc.blocks[1].indent, 0);
}

#[test]
fn ordered_lists_keep_explicit_start_and_restart_per_run() {
    let doc = Document::from_markdown("7. a\n8. b\n    1. x\n    2. y\n9. c\n\npara\n\n1. again");
    assert_eq!(
        doc.ordinals(),
        vec![Some(7), Some(8), Some(1), Some(2), Some(9), None, Some(1)]
    );
    assert_eq!(doc.blocks[0].start, Some(7));
    assert_eq!(doc.blocks[1].start, None);
    let exported = doc.to_markdown();
    assert!(exported.starts_with("7. a\n8. b\n    1. x\n    2. y\n9. c"));
    let doc = Document::from_markdown("1. a\n1. b\n1. c");
    assert_eq!(doc.ordinals(), vec![Some(1), Some(1), Some(1)]);
    assert_eq!(strip(&roundtrip(&doc)), strip(&doc));
}

#[test]
fn ordinal_matches_ordinals_everywhere() {
    let doc = Document::from_markdown(
        "1. a\n- b\n2. c\n    5. d\n    - e\n    6. f\n3. g\n\n> q\n\n4. h",
    );
    let all = doc.ordinals();
    for (index, expected) in all.iter().enumerate() {
        assert_eq!(doc.ordinal(index), *expected, "index {index}");
    }
}

#[test]
fn quotes_split_paragraphs_into_consecutive_blocks() {
    let doc = Document::from_markdown("> a\n> b\n>\n> c\n\n> d");
    let texts: Vec<&str> = doc.blocks.iter().map(|b| b.text.as_str()).collect();
    assert_eq!(texts, vec!["a b", "c", "d"]);
    assert!(doc.blocks.iter().all(|b| b.kind == BlockKind::Quote));
}

#[test]
fn fenced_code_keeps_content_and_picks_safe_fence() {
    let doc = Document::from_markdown("~~~\n```\ninside\n```\n~~~");
    assert_eq!(doc.blocks[0].text, "```\ninside\n```");
    let exported = doc.to_markdown();
    assert!(exported.starts_with("````\n"));
    assert_eq!(strip(&roundtrip(&doc)), strip(&doc));
    let unclosed = Document::from_markdown("```py\nprint(1)");
    assert_eq!(
        unclosed.blocks[0].kind,
        BlockKind::Code {
            language: "py".into()
        }
    );
    assert_eq!(unclosed.blocks[0].text, "print(1)");
}

#[test]
fn thematic_breaks_in_every_spelling() {
    let doc = Document::from_markdown("***\n\n- - -\n\n___\n\n---");
    assert!(doc.blocks.iter().all(|b| b.kind == BlockKind::Rule));
    assert_eq!(doc.blocks.len(), 4);
}

#[test]
fn unknown_html_and_unmatched_delimiters_stay_literal() {
    let doc = Document::from_markdown("<div>x</div> **open and `tick and [bracket and a_b_c");
    assert_eq!(
        doc.blocks[0].text,
        "<div>x</div> **open and `tick and [bracket and a_b_c"
    );
    assert!(doc.blocks[0].spans.is_empty());
    let again = roundtrip(&doc);
    assert_eq!(strip(&again), strip(&doc));
}

#[test]
fn bare_urls_become_links_with_trailing_punctuation_left_out() {
    let doc = Document::from_markdown("see https://a.example/path_(x). and mailto:me@x.y, ok");
    let spans = &doc.blocks[0].spans;
    let block = &doc.blocks[0];
    let linked: Vec<&str> = spans.iter().map(|s| &block.text[s.range.clone()]).collect();
    assert_eq!(linked, vec!["https://a.example/path_(x)", "mailto:me@x.y"]);
    let plain = Document::from_blocks(vec![cap_notes::Block::paragraph(
        cap_notes::BlockId(1),
        "visit https://not.linked now",
    )]);
    let exported = plain.to_markdown();
    assert_eq!(strip(&Document::from_markdown(&exported)), strip(&plain));
}

#[test]
fn escapes_protect_block_starts() {
    for text in [
        "# not heading",
        "- not bullet",
        "+ not bullet",
        "* not bullet",
        "1. not ordered",
        "12) not ordered",
        "> not quote",
        "---",
        "- - -",
        "___",
        "```",
        "~~~",
        "    indented",
        "trailing  ",
        "&amp; &#32; literal",
        "a\\b\\",
        "<u>not underline</u>",
        "==not== ~~not~~",
        "[x] not task",
    ] {
        let doc = Document::from_blocks(vec![cap_notes::Block::paragraph(
            cap_notes::BlockId(1),
            text,
        )]);
        let exported = doc.to_markdown();
        let back = Document::from_markdown(&exported);
        assert_eq!(
            strip(&back),
            strip(&doc),
            "text {text:?} exported as {exported:?}"
        );
    }
    let doc = Document::from_blocks(vec![cap_notes::Block::new(
        cap_notes::BlockId(1),
        BlockKind::Bullet,
        "[ ] literal brackets",
    )]);
    assert_eq!(strip(&roundtrip(&doc)), strip(&doc));
}

#[test]
fn marks_that_markdown_delimiters_cannot_express_fall_back_to_tags() {
    let mut block = cap_notes::Block::paragraph(cap_notes::BlockId(1), "a bold. b");
    block.spans = vec![Span {
        range: 1..7,
        mark: Mark::Bold,
    }];
    let doc = Document::from_blocks(vec![block]);
    let exported = doc.to_markdown();
    assert!(exported.contains("<strong>"), "{exported}");
    assert_eq!(strip(&roundtrip(&doc)), strip(&doc));
}

#[test]
fn mentions_serialise_as_links_with_mention_scheme() {
    let mut block = cap_notes::Block::paragraph(cap_notes::BlockId(1), "hi @Sam");
    block.spans = vec![Span {
        range: 3..7,
        mark: Mark::Mention { id: "42".into() },
    }];
    let doc = Document::from_blocks(vec![block]);
    assert_eq!(doc.to_markdown(), "hi [@Sam](mention:42)\n");
    assert_eq!(strip(&roundtrip(&doc)), strip(&doc));
}

#[test]
fn list_items_are_tight_and_other_blocks_are_spaced() {
    let doc = Document::from_markdown("# h\n- a\n- b\npara\n\n> q");
    assert_eq!(doc.to_markdown(), "# h\n\n- a\n- b para\n\n> q\n");
}

#[test]
fn plain_text_and_html_exports() {
    let doc = Document::from_markdown(
        "# T\n\n- a **b**\n    1. c\n- [x] d\n\n> q\n\n```\n<x>\n```\n\n---",
    );
    assert_eq!(doc.to_plain_text(), "T\n- a b\n  1. c\n[x] d\nq\n<x>\n---");
    let html = doc.to_html();
    assert_eq!(
        html,
        "<h1>T</h1><ul><li>a <strong>b</strong><ol><li>c</li></ol></li><li><input type=\"checkbox\" checked disabled> d</li></ul><blockquote><p>q</p></blockquote><pre><code>&lt;x&gt;</code></pre><hr>"
    );
}

#[test]
fn empty_document_exports_empty_string() {
    assert_eq!(Document::new().to_markdown(), "");
    let doc = Document::from_markdown("");
    assert_eq!(doc.blocks.len(), 1);
    assert_eq!(doc.blocks[0].kind, BlockKind::Paragraph);
}

#[test]
fn crlf_input_is_normalised() {
    let doc = Document::from_markdown("# a\r\n\r\nb\r\n");
    assert_eq!(doc.blocks.len(), 2);
    assert_eq!(doc.blocks[1].text, "b");
}

#[test]
fn entities_decode() {
    let doc = Document::from_markdown("&#x1F600; &#65; &lt;b&gt; &bogus;");
    assert_eq!(doc.blocks[0].text, "\u{1F600} A <b> &bogus;");
}
