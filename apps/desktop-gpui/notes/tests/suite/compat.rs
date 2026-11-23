use cap_notes::{BlockKind, Document, Editor, Mark, OutlineItem, SCHEMA};
use serde_json::json;

use crate::support::{at, check, texts};

const SAVED_BY_NEWER_APP: &str = r#"{"schema":3,"kind":"plan","meta":{"fps":60,"owner":"team"},"blocks":[{"id":1,"kind":{"type":"scene","duration":3.5,"title":"Intro"},"text":"Open on desk","spans":[{"range":{"start":0,"end":4},"mark":{"type":"cue","at":2}},{"range":{"start":5,"end":7},"mark":{"type":"bold"}}],"attrs":{"camera":"wide"}},{"id":2,"kind":{"type":"heading","level":2},"text":"Step two"},{"id":3,"kind":{"type":"bullet"},"indent":0,"text":"x","origin":"generated"}]}"#;

fn load() -> Document {
    Document::from_json(SAVED_BY_NEWER_APP).unwrap()
}

#[test]
fn unknown_kinds_and_marks_load_and_save_byte_stable() {
    let doc = load();
    assert_eq!(doc.schema, 3);
    assert_eq!(doc.kind, "plan");
    assert_eq!(doc.meta["fps"], json!(60));
    let BlockKind::Unknown { kind, data } = &doc.blocks[0].kind else {
        panic!("expected unknown kind");
    };
    assert_eq!(kind, "scene");
    assert_eq!(data["duration"], json!(3.5));
    assert_eq!(
        doc.blocks[0].spans[0].mark,
        Mark::Unknown {
            kind: "cue".into(),
            data: json!({ "at": 2 })
        }
    );
    let saved = doc.to_json();
    let expected = SAVED_BY_NEWER_APP.replace(r#""indent":0,"#, "");
    assert_eq!(saved, expected);
    assert_eq!(Document::from_json(&saved).unwrap().to_json(), saved);
}

#[test]
fn unknown_values_survive_edits_around_them() {
    let mut editor = Editor::new(load());
    at(&mut editor, 0, 12);
    editor.insert_text("!");
    at(&mut editor, 0, 2);
    editor.insert_text("e");
    editor.move_to_doc_end(false);
    editor.insert_text("y");
    check(&editor).unwrap();
    let doc = editor.document();
    assert!(matches!(&doc.blocks[0].kind, BlockKind::Unknown { kind, .. } if kind == "scene"));
    assert_eq!(doc.blocks[0].text, "Opeen on desk!");
    let cue = doc.blocks[0]
        .spans
        .iter()
        .find(|span| matches!(&span.mark, Mark::Unknown { kind, .. } if kind == "cue"))
        .unwrap();
    assert_eq!(cue.range, 0..5);
    let saved = doc.to_json();
    let reloaded = Document::from_json(&saved).unwrap();
    assert_eq!(&reloaded, doc);
    assert_eq!(reloaded.to_json(), saved);
    assert_eq!(reloaded.meta, load().meta);
}

#[test]
fn unknown_blocks_edit_like_paragraphs() {
    let mut editor = Editor::new(load());
    at(&mut editor, 0, 4);
    editor.insert_newline();
    assert!(matches!(
        editor.document().blocks[0].kind,
        BlockKind::Unknown { .. }
    ));
    assert_eq!(editor.document().blocks[1].kind, BlockKind::Paragraph);
    assert!(editor.document().blocks[1].attrs.is_empty());
    editor.backspace();
    assert_eq!(texts(&editor)[0], "Open on desk");
    assert!(matches!(
        editor.document().blocks[0].kind,
        BlockKind::Unknown { .. }
    ));
    let markdown = editor.document().to_markdown();
    assert!(
        markdown.starts_with("Open **on** desk\n\n## Step two"),
        "{markdown}"
    );
}

#[test]
fn attrs_survive_split_merge_and_kind_change() {
    let mut editor = Editor::new(load());
    at(&mut editor, 1, 4);
    let mut doc = editor.document().clone();
    doc.blocks[1].attrs.insert("cue".into(), json!("lights"));
    editor.set_document(doc);
    at(&mut editor, 1, 4);
    editor.insert_newline();
    let blocks = &editor.document().blocks;
    assert_eq!(blocks[1].attrs["cue"], json!("lights"));
    assert!(blocks[2].attrs.is_empty());
    assert_eq!(blocks[2].kind, BlockKind::Heading(2));
    editor.backspace();
    editor.backspace();
    assert_eq!(texts(&editor)[1], "Step two");
    assert_eq!(editor.document().blocks[1].attrs["cue"], json!("lights"));
    editor.set_kind(BlockKind::Quote);
    assert_eq!(editor.document().blocks[1].kind, BlockKind::Quote);
    assert_eq!(editor.document().blocks[1].attrs["cue"], json!("lights"));
    editor.toggle_kind(BlockKind::Bullet);
    editor.indent();
    assert_eq!(editor.document().blocks[1].attrs["cue"], json!("lights"));
    assert_eq!(editor.document().blocks[0].attrs["camera"], json!("wide"));
    at(&mut editor, 1, 0);
    editor.backspace();
    editor.backspace();
    editor.backspace();
    assert_eq!(editor.document().blocks[0].attrs["camera"], json!("wide"));
    assert!(!editor.document().blocks[0].attrs.contains_key("cue"));
}

#[test]
fn header_defaults_when_missing_and_json_is_tolerant() {
    let doc =
        Document::from_json(r#"{"blocks":[{"text":"hi"},{"kind":{"type":"task"}},{}]}"#).unwrap();
    assert_eq!(doc.schema, SCHEMA);
    assert_eq!(doc.kind, "note");
    assert!(doc.meta.is_empty());
    assert_eq!(doc.blocks[1].kind, BlockKind::Task { checked: false });
    crate::support::check_document(&doc).unwrap();
    let empty = Document::from_json("{}").unwrap();
    assert_eq!(empty.blocks.len(), 1);
    let odd = Document::from_json(r#"{"blocks":[{"kind":"quote","text":"q"},{"kind":{"type":"heading","level":9},"text":"h"}]}"#).unwrap();
    assert_eq!(odd.blocks[0].kind, BlockKind::Quote);
    assert_eq!(odd.blocks[1].kind, BlockKind::Heading(3));
}

#[test]
fn json_roundtrip_of_every_known_kind_and_mark() {
    let doc = Document::from_markdown(
        "# h\n\n- [x] t **b** *i* ~~s~~ `c` ==h== <u>u</u> [l](https://x) [@n](mention:7)\n\n1. o\n\n> q\n\n```js\nx\n```\n\n---",
    );
    let json = doc.to_json();
    assert!(json.contains(r#"{"type":"task","checked":true}"#));
    assert!(json.contains(r#"{"type":"link","url":"https://x"}"#));
    assert!(json.contains(r#"{"type":"code","language":"js"}"#));
    assert_eq!(Document::from_json(&json).unwrap(), doc);
}

#[test]
fn outline_and_plain_blocks_walk_without_an_editor() {
    let doc = Document::from_markdown("# One\n\ntext\n\n## Two\n\n- item\n    - sub\n\n### Three");
    assert_eq!(
        doc.outline(),
        vec![
            OutlineItem {
                block: 0,
                level: 1,
                text: "One".into()
            },
            OutlineItem {
                block: 2,
                level: 2,
                text: "Two".into()
            },
            OutlineItem {
                block: 5,
                level: 3,
                text: "Three".into()
            },
        ]
    );
    let walked: Vec<(BlockKind, u8, String)> = doc
        .plain_blocks()
        .map(|(kind, indent, text)| (kind.clone(), indent, text.to_string()))
        .collect();
    assert_eq!(walked[4], (BlockKind::Bullet, 1, "sub".to_string()));
    assert_eq!(walked.len(), 6);
}
