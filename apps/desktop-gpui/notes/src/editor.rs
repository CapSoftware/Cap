use std::ops::Range;

use crate::history::{History, Op, Step};
use crate::model::{Block, BlockId, Document, Pos, Selection, clamp_indent};
use crate::spans::MarkSet;
use crate::unicode::{
    clamp_to_grapheme, next_grapheme, next_word, prev_grapheme, prev_word, word_range_at,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputRules {
    pub markdown: bool,
    pub typography: bool,
}

impl Default for InputRules {
    fn default() -> Self {
        Self {
            markdown: true,
            typography: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlockChange {
    pub start: usize,
    pub removed: usize,
    pub inserted: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Change {
    pub blocks: Option<BlockChange>,
}

impl Change {
    pub fn changed(&self) -> bool {
        self.blocks.is_some()
    }

    pub fn dirty(&self) -> Range<usize> {
        self.blocks
            .map_or(0..0, |change| change.start..change.start + change.inserted)
    }

    pub(crate) fn record(&mut self, start: usize, removed: usize, inserted: usize) {
        self.blocks = Some(match self.blocks {
            None => BlockChange {
                start,
                removed,
                inserted,
            },
            Some(prev) => {
                let lo = prev.start.min(start);
                let hi = (prev.start + prev.inserted).max(start + removed);
                let original_hi = hi - prev.inserted + prev.removed;
                BlockChange {
                    start: lo,
                    removed: original_hi - lo,
                    inserted: hi - removed + inserted - lo,
                }
            }
        });
    }

    pub fn merge(mut self, later: Change) -> Change {
        if let Some(next) = later.blocks {
            self.record(next.start, next.removed, next.inserted);
        }
        self
    }
}

#[derive(Clone)]
struct Tx {
    ops: Vec<Op>,
    before: Selection,
    change: Change,
}

#[derive(Clone)]
pub struct Editor {
    pub(crate) doc: Document,
    pub(crate) selection: Selection,
    pub(crate) pending: Option<MarkSet>,
    pub(crate) history: History,
    pub rules: InputRules,
    next_id: u64,
    tx: Option<Tx>,
}

impl Default for Editor {
    fn default() -> Self {
        Self::new(Document::new())
    }
}

impl Editor {
    pub fn new(mut doc: Document) -> Self {
        doc.normalize();
        let next_id = doc.max_id() + 1;
        Self {
            doc,
            selection: Selection::default(),
            pending: None,
            history: History::default(),
            rules: InputRules::default(),
            next_id,
            tx: None,
        }
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn into_document(self) -> Document {
        self.doc
    }

    pub fn set_document(&mut self, mut doc: Document) {
        doc.normalize();
        self.next_id = self.next_id.max(doc.max_id() + 1);
        self.doc = doc;
        self.selection = Selection::default();
        self.pending = None;
        self.history.clear();
        self.tx = None;
    }

    pub fn selection(&self) -> Selection {
        self.selection
    }

    pub fn pending_marks(&self) -> Option<&MarkSet> {
        self.pending.as_ref()
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn undo_depth(&self) -> usize {
        self.history.len()
    }

    pub fn break_undo_group(&mut self) {
        self.history.break_group();
    }

    pub(crate) fn fresh_id(&mut self) -> BlockId {
        let id = BlockId(self.next_id);
        self.next_id += 1;
        id
    }

    pub(crate) fn block(&self, index: usize) -> &Block {
        let last = self.doc.blocks.len().saturating_sub(1);
        &self.doc.blocks[index.min(last)]
    }

    pub(crate) fn empty_paragraph(&mut self) -> Block {
        Block::paragraph(self.fresh_id(), "")
    }

    pub fn clamp_pos(&self, pos: Pos) -> Pos {
        let block = pos.block.min(self.doc.blocks.len().saturating_sub(1));
        let text = &self.doc.blocks[block].text;
        Pos::new(block, clamp_to_grapheme(text, pos.offset))
    }

    pub fn clamp_selection(&self, selection: Selection) -> Selection {
        Selection::new(
            self.clamp_pos(selection.anchor),
            self.clamp_pos(selection.head),
        )
    }

    pub(crate) fn begin(&mut self) {
        self.tx = Some(Tx {
            ops: Vec::new(),
            before: self.selection,
            change: Change::default(),
        });
    }

    pub(crate) fn splice(&mut self, range: Range<usize>, mut new: Vec<Block>) {
        let len = self.doc.blocks.len();
        let start = range.start.min(len);
        let mut end = range.end.clamp(start, len);
        if start == 0 && end == len && new.is_empty() {
            new.push(self.empty_paragraph());
        }
        for block in &mut new {
            block.normalize();
        }
        let mut prev = start.checked_sub(1).map(|i| self.doc.blocks[i].clone());
        for block in &mut new {
            clamp_indent(prev.as_ref(), block);
            prev = Some(block.clone());
        }
        while end < len {
            let mut next = self.doc.blocks[end].clone();
            if !clamp_indent(prev.as_ref(), &mut next) {
                break;
            }
            prev = Some(next.clone());
            new.push(next);
            end += 1;
        }
        let inserted = new.len();
        let removed: Vec<Block> = self.doc.blocks.splice(start..end, new).collect();
        let removed_len = removed.len();
        if let Some(tx) = &mut self.tx {
            tx.change.record(start, removed_len, inserted);
            tx.ops.push(Op {
                at: start,
                remove: inserted,
                insert: removed,
            });
        }
    }

    pub(crate) fn replace_block(&mut self, index: usize, block: Block) {
        self.splice(index..index + 1, vec![block]);
    }

    pub(crate) fn commit(&mut self, typing: bool, keep_open: bool) -> Change {
        let Some(mut tx) = self.tx.take() else {
            return Change::default();
        };
        self.selection = self.clamp_selection(self.selection);
        if !typing {
            self.pending = None;
        }
        if tx.ops.is_empty() {
            if !typing {
                self.history.break_group();
            }
            return tx.change;
        }
        tx.ops.reverse();
        self.history.push(
            Step {
                ops: tx.ops,
                before: tx.before,
                after: self.selection,
                typing,
            },
            keep_open,
        );
        tx.change
    }

    fn apply_ops(&mut self, ops: Vec<Op>) -> (Change, Vec<Op>) {
        let mut change = Change::default();
        let mut inverse = Vec::with_capacity(ops.len());
        for op in ops {
            let len = self.doc.blocks.len();
            let at = op.at.min(len);
            let end = (at + op.remove).min(len);
            let inserted = op.insert.len();
            let removed: Vec<Block> = self.doc.blocks.splice(at..end, op.insert).collect();
            change.record(at, removed.len(), inserted);
            inverse.push(Op {
                at,
                remove: inserted,
                insert: removed,
            });
        }
        if self.doc.blocks.is_empty() {
            let block = self.empty_paragraph();
            self.doc.blocks.push(block);
        }
        inverse.reverse();
        (change, inverse)
    }

    pub fn undo(&mut self) -> Change {
        let Some(step) = self.history.pop_undo() else {
            return Change::default();
        };
        let (change, ops) = self.apply_ops(step.ops);
        self.selection = self.clamp_selection(step.before);
        self.pending = None;
        self.history.push_redo(Step {
            ops,
            before: step.before,
            after: step.after,
            typing: step.typing,
        });
        change
    }

    pub fn redo(&mut self) -> Change {
        let Some(step) = self.history.pop_redo() else {
            return Change::default();
        };
        let (change, ops) = self.apply_ops(step.ops);
        self.selection = self.clamp_selection(step.after);
        self.pending = None;
        self.history.push_undo_after_redo(Step {
            ops,
            before: step.before,
            after: step.after,
            typing: step.typing,
        });
        change
    }

    pub(crate) fn ordered(&self) -> (Pos, Pos) {
        let selection = self.clamp_selection(self.selection);
        (selection.start(), selection.end())
    }

    pub fn set_selection(&mut self, selection: Selection) {
        let selection = self.clamp_selection(selection);
        if selection != self.selection {
            self.pending = None;
            self.history.break_group();
        }
        self.selection = selection;
    }

    pub fn extend_to(&mut self, pos: Pos) {
        self.set_selection(Selection::new(self.selection.anchor, pos));
    }

    fn move_to(&mut self, head: Pos, extend: bool) {
        let anchor = if extend { self.selection.anchor } else { head };
        self.set_selection(Selection::new(anchor, head));
    }

    pub fn pos_before(&self, pos: Pos) -> Pos {
        let pos = self.clamp_pos(pos);
        if pos.offset > 0 {
            Pos::new(
                pos.block,
                prev_grapheme(&self.block(pos.block).text, pos.offset),
            )
        } else if pos.block > 0 {
            Pos::new(pos.block - 1, self.block(pos.block - 1).len())
        } else {
            pos
        }
    }

    pub fn pos_after(&self, pos: Pos) -> Pos {
        let pos = self.clamp_pos(pos);
        let len = self.block(pos.block).len();
        if pos.offset < len {
            Pos::new(
                pos.block,
                next_grapheme(&self.block(pos.block).text, pos.offset),
            )
        } else if pos.block + 1 < self.doc.blocks.len() {
            Pos::new(pos.block + 1, 0)
        } else {
            pos
        }
    }

    pub fn move_left(&mut self, extend: bool) {
        let (start, _) = self.ordered();
        if !extend && !self.selection.is_collapsed() {
            self.move_to(start, false);
        } else {
            self.move_to(self.pos_before(self.selection.head), extend);
        }
    }

    pub fn move_right(&mut self, extend: bool) {
        let (_, end) = self.ordered();
        if !extend && !self.selection.is_collapsed() {
            self.move_to(end, false);
        } else {
            self.move_to(self.pos_after(self.selection.head), extend);
        }
    }

    pub fn move_word_left(&mut self, extend: bool) {
        let head = self.clamp_pos(self.selection.head);
        let target = if head.offset == 0 {
            self.pos_before(head)
        } else {
            Pos::new(
                head.block,
                prev_word(&self.block(head.block).text, head.offset),
            )
        };
        self.move_to(target, extend);
    }

    pub fn move_word_right(&mut self, extend: bool) {
        let head = self.clamp_pos(self.selection.head);
        let block = self.block(head.block);
        let target = if head.offset >= block.len() {
            self.pos_after(head)
        } else {
            Pos::new(head.block, next_word(&block.text, head.offset))
        };
        self.move_to(target, extend);
    }

    pub fn move_to_block_start(&mut self, extend: bool) {
        let head = self.clamp_pos(self.selection.head);
        self.move_to(Pos::new(head.block, 0), extend);
    }

    pub fn move_to_block_end(&mut self, extend: bool) {
        let head = self.clamp_pos(self.selection.head);
        self.move_to(Pos::new(head.block, self.block(head.block).len()), extend);
    }

    pub fn move_to_doc_start(&mut self, extend: bool) {
        self.move_to(Pos::new(0, 0), extend);
    }

    pub fn move_to_doc_end(&mut self, extend: bool) {
        self.move_to(self.doc_end(), extend);
    }

    pub fn doc_end(&self) -> Pos {
        let last = self.doc.blocks.len().saturating_sub(1);
        Pos::new(last, self.block(last).len())
    }

    pub fn select_all(&mut self) {
        self.set_selection(Selection::new(Pos::new(0, 0), self.doc_end()));
    }

    pub fn select_word_at(&mut self, pos: Pos) {
        let pos = self.clamp_pos(pos);
        let range = word_range_at(&self.block(pos.block).text, pos.offset);
        self.set_selection(Selection::new(
            Pos::new(pos.block, range.start),
            Pos::new(pos.block, range.end),
        ));
    }

    pub fn select_block_at(&mut self, pos: Pos) {
        let pos = self.clamp_pos(pos);
        self.set_selection(Selection::new(
            Pos::new(pos.block, 0),
            Pos::new(pos.block, self.block(pos.block).len()),
        ));
    }

    pub(crate) fn block_range(&self) -> Range<usize> {
        let (start, end) = self.ordered();
        start.block..end.block + 1
    }
}
