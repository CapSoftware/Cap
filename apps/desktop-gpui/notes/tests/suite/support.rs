use std::collections::HashSet;

use cap_notes::{
    BlockId, BlockKind, Document, Editor, MAX_INDENT, Origin, Pos, Selection, is_grapheme_boundary,
    spans_are_normalized,
};

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1)
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next() % n as u64) as usize
        }
    }

    pub fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

pub fn editor(markdown: &str) -> Editor {
    Editor::new(Document::from_markdown(markdown))
}

pub fn at(editor: &mut Editor, block: usize, offset: usize) {
    editor.set_selection(Selection::caret(Pos::new(block, offset)));
}

pub fn select(editor: &mut Editor, anchor: (usize, usize), head: (usize, usize)) {
    editor.set_selection(Selection::new(
        Pos::new(anchor.0, anchor.1),
        Pos::new(head.0, head.1),
    ));
}

pub fn caret(editor: &Editor) -> (usize, usize) {
    let head = editor.selection().head;
    (head.block, head.offset)
}

pub fn type_text(editor: &mut Editor, text: &str) {
    use unicode_segmentation::UnicodeSegmentation;
    for grapheme in text.graphemes(true) {
        if grapheme == "\n" {
            editor.insert_newline();
        } else {
            editor.insert_text(grapheme);
        }
    }
}

pub fn texts(editor: &Editor) -> Vec<String> {
    editor
        .document()
        .blocks
        .iter()
        .map(|block| block.text.clone())
        .collect()
}

pub fn kinds(editor: &Editor) -> Vec<BlockKind> {
    editor
        .document()
        .blocks
        .iter()
        .map(|block| block.kind.clone())
        .collect()
}

pub fn md(editor: &Editor) -> String {
    editor.document().to_markdown()
}

pub fn strip(doc: &Document) -> Document {
    let mut doc = doc.clone();
    for block in &mut doc.blocks {
        block.id = BlockId(0);
        block.origin = Origin::Author;
    }
    doc
}

pub fn check_document(doc: &Document) -> Result<(), String> {
    if doc.blocks.is_empty() {
        return Err("empty document".into());
    }
    let mut ids = HashSet::new();
    for (index, block) in doc.blocks.iter().enumerate() {
        if !ids.insert(block.id) {
            return Err(format!("duplicate id {:?}", block.id));
        }
        let mut normalized = block.clone();
        normalized.normalize();
        if &normalized != block {
            return Err(format!("block {index} not normalized: {block:?}"));
        }
        if !spans_are_normalized(&block.text, &block.spans) {
            return Err(format!(
                "block {index} spans not normalized: {:?}",
                block.spans
            ));
        }
        if !block.kind.is_code() && block.text.contains('\n') {
            return Err(format!("newline in block {index}"));
        }
        if block.kind.is_rule() && !block.text.is_empty() {
            return Err(format!("rule with text at {index}"));
        }
        if block.indent > MAX_INDENT {
            return Err(format!("indent too deep at {index}"));
        }
        let max = match index.checked_sub(1).map(|i| &doc.blocks[i]) {
            Some(prev) if prev.kind.is_list() => prev.indent + 1,
            _ => 0,
        };
        if block.kind.is_list() && block.indent > max {
            return Err(format!("indent jump at {index}: {} > {max}", block.indent));
        }
        if !block.kind.is_list() && block.indent != 0 {
            return Err(format!("non-list indent at {index}"));
        }
    }
    Ok(())
}

pub fn check(editor: &Editor) -> Result<(), String> {
    check_document(editor.document())?;
    let doc = editor.document();
    let selection = editor.selection();
    for pos in [selection.anchor, selection.head] {
        let Some(block) = doc.blocks.get(pos.block) else {
            return Err(format!("selection block out of range {pos:?}"));
        };
        if !is_grapheme_boundary(&block.text, pos.offset) {
            return Err(format!(
                "selection not on boundary {pos:?} in {:?}",
                block.text
            ));
        }
    }
    Ok(())
}
