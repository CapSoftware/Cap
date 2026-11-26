use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

use crate::editor::{Change, Editor};
use crate::model::{Block, BlockKind, Mark, Origin, Pos, Selection};
use crate::rules::{self, RuleEdit};
use crate::spans::MarkSet;
use crate::unicode::{next_grapheme, prev_grapheme};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkAt {
    pub block: usize,
    pub range: Range<usize>,
    pub url: String,
}

pub(crate) fn normalize_newlines(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.to_string()
    }
}

fn continuation_kind(kind: &BlockKind, at_end: bool) -> BlockKind {
    match kind {
        BlockKind::Heading(_) if at_end => BlockKind::Paragraph,
        BlockKind::Quote if at_end => BlockKind::Paragraph,
        BlockKind::Heading(level) => BlockKind::Heading(*level),
        BlockKind::Quote => BlockKind::Quote,
        BlockKind::Bullet => BlockKind::Bullet,
        BlockKind::Ordered => BlockKind::Ordered,
        BlockKind::Task { .. } => BlockKind::Task { checked: false },
        _ => BlockKind::Paragraph,
    }
}

impl Editor {
    pub(crate) fn new_block(&mut self, kind: BlockKind, indent: u8) -> Block {
        let mut block = self.empty_paragraph();
        block.kind = kind;
        block.indent = indent;
        block
    }

    pub(crate) fn delete_between(&mut self, start: Pos, end: Pos) -> Pos {
        let start = self.clamp_pos(start);
        let end = self.clamp_pos(end);
        let (start, end) = (start.min(end), start.max(end));
        if start == end {
            return start;
        }
        if start.block == end.block {
            let mut block = self.block(start.block).clone();
            block.delete_text(start.offset..end.offset);
            self.replace_block(start.block, block);
            return start;
        }
        let range = start.block..end.block + 1;
        let first = self.block(start.block).clone();
        let last = self.block(end.block).clone();
        if first.kind.is_rule() {
            let mut tail = last;
            tail.delete_text(0..end.offset);
            if tail.kind.is_rule() {
                tail.kind = BlockKind::Paragraph;
            }
            self.splice(range, vec![tail]);
            return Pos::new(start.block, 0);
        }
        let mut head = first;
        head.split_off_at(start.offset);
        let mut rest = last.clone();
        let (tail_text, tail_spans) = rest.split_off_at(end.offset);
        if last.kind.is_rule() || tail_text.is_empty() {
            self.splice(range, vec![head]);
        } else if !head.kind.is_code() && tail_text.contains('\n') {
            let mut tail = last;
            tail.delete_text(0..end.offset);
            self.splice(range, vec![head, tail]);
        } else {
            head.append(&tail_text, &tail_spans);
            self.splice(range, vec![head]);
        }
        start
    }

    pub(crate) fn insert_inline(&mut self, at: Pos, text: &str, marks: &MarkSet) -> Pos {
        let at = self.clamp_pos(at);
        let mut block = self.block(at.block).clone();
        if block.kind.is_rule() {
            let mut paragraph = self.empty_paragraph();
            paragraph.insert_text_at(0, text, marks);
            self.splice(at.block + 1..at.block + 1, vec![paragraph]);
            return Pos::new(at.block + 1, text.len());
        }
        block.insert_text_at(at.offset, text, marks);
        block.origin = Origin::Author;
        self.replace_block(at.block, block);
        Pos::new(at.block, at.offset + text.len())
    }

    pub(crate) fn insert_lines(&mut self, at: Pos, text: &str, marks: &MarkSet) -> Pos {
        let at = self.clamp_pos(at);
        let target = self.block(at.block).clone();
        if target.kind.is_code() || !text.contains('\n') {
            return self.insert_inline(at, text, marks);
        }
        let kind = continuation_kind(&target.kind, false);
        let indent = target.indent;
        let fragment: Vec<Block> = text
            .split('\n')
            .enumerate()
            .map(|(index, line)| {
                let mut block = self.new_block(
                    if index == 0 {
                        BlockKind::Paragraph
                    } else {
                        kind.clone()
                    },
                    0,
                );
                block.insert_text_at(0, line, marks);
                block
            })
            .collect();
        let shifted: Vec<Block> = fragment
            .into_iter()
            .enumerate()
            .map(|(index, mut block)| {
                if index > 0 && block.kind.is_list() {
                    block.indent = indent;
                }
                block
            })
            .collect();
        self.insert_fragment(at, shifted, false)
    }

    pub(crate) fn insert_fragment(
        &mut self,
        at: Pos,
        mut fragment: Vec<Block>,
        shift_lists: bool,
    ) -> Pos {
        let at = self.clamp_pos(at);
        if fragment.is_empty() {
            return at;
        }
        let target = self.block(at.block).clone();
        if target.kind.is_code() {
            let text = fragment
                .iter()
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            return self.insert_inline(at, &text, &MarkSet::new());
        }
        if shift_lists && target.kind.is_list() {
            for block in &mut fragment {
                if block.kind.is_list() {
                    block.indent = block.indent.saturating_add(target.indent);
                }
            }
        }
        if target.kind.is_rule() {
            let caret_block = at.block + fragment.len();
            let caret_offset = fragment.last().map_or(0, Block::len);
            self.splice(at.block + 1..at.block + 1, fragment);
            return Pos::new(caret_block, caret_offset);
        }
        let textual = |block: &Block| !block.kind.is_rule() && !block.kind.is_code();
        let mut left = target.clone();
        let (tail_text, tail_spans) = left.split_off_at(at.offset);
        left.origin = Origin::Author;
        let mut pieces = fragment.into_iter();
        let mut out: Vec<Block> = Vec::new();
        if let Some(first) = pieces.next() {
            if textual(&first) {
                if left.text.is_empty() && left.kind.is_paragraph_like() {
                    left.kind = first.kind.clone();
                    left.indent = first.indent;
                    left.start = first.start;
                    if left.attrs.is_empty() {
                        left.attrs = first.attrs.clone();
                    }
                }
                left.append(&first.text, &first.spans);
                out.push(left);
            } else {
                if !left.text.is_empty() {
                    out.push(left);
                }
                out.push(first);
            }
        }
        out.extend(pieces);
        let last_index = out.len() - 1;
        let mut caret = Pos::new(at.block + last_index, out[last_index].len());
        if textual(&out[last_index]) {
            out[last_index].append(&tail_text, &tail_spans);
        } else {
            let last_is_rule = out[last_index].kind.is_rule();
            if !tail_text.is_empty() || last_is_rule {
                let kind = if tail_text.is_empty() {
                    BlockKind::Paragraph
                } else {
                    target.kind.clone()
                };
                let mut rest = self.new_block(kind, target.indent);
                rest.append(&tail_text, &tail_spans);
                out.push(rest);
                if last_is_rule {
                    caret = Pos::new(at.block + out.len() - 1, 0);
                }
            }
        }
        self.splice(at.block..at.block + 1, out);
        caret
    }

    fn typed_marks(&mut self, at: Pos) -> MarkSet {
        let pending = self.pending.take();
        let block = self.block(at.block);
        let marks = pending.unwrap_or_else(|| block.insertion_marks(at.offset));
        if block.kind.takes_marks() {
            marks
        } else {
            MarkSet::new()
        }
    }

    pub fn insert_text(&mut self, text: &str) -> Change {
        let text = normalize_newlines(text);
        if text.is_empty() {
            return Change::default();
        }
        if text == "\n" {
            return self.insert_newline();
        }
        let typed = text.graphemes(true).count() == 1 && !text.contains('\n');
        let collapsed = self.selection.is_collapsed();
        self.begin();
        let (start, end) = self.ordered();
        let at = if collapsed {
            start
        } else {
            self.delete_between(start, end)
        };
        let explicit = self.pending.is_some();
        let marks = self.typed_marks(at);
        let caret = self.insert_lines(at, &text, &marks);
        self.selection = Selection::caret(caret);
        if explicit && typed {
            self.pending = Some(marks);
        }
        let whitespace = text.chars().all(char::is_whitespace);
        let change = self.commit(typed, typed && !whitespace);
        if typed {
            change.merge(self.apply_typed_rules(caret, &text))
        } else {
            change
        }
    }

    pub(crate) fn apply_typed_rules(&mut self, caret: Pos, typed: &str) -> Change {
        let block = self.block(caret.block);
        let Some(edit) = rules::detect(block, caret.offset, typed, &self.rules) else {
            return Change::default();
        };
        self.apply_rule(caret, edit)
    }

    pub(crate) fn apply_rule(&mut self, caret: Pos, edit: RuleEdit) -> Change {
        self.begin();
        let mut block = self.block(caret.block).clone();
        match edit {
            RuleEdit::Kind { kind, start, strip } => {
                block.delete_text(0..strip);
                let indent = block.indent;
                block.kind = kind;
                block.indent = if block.kind.is_list() { indent } else { 0 };
                block.start = start;
                self.replace_block(caret.block, block);
                self.selection =
                    Selection::caret(Pos::new(caret.block, caret.offset.saturating_sub(strip)));
            }
            RuleEdit::Rule => {
                block.kind = BlockKind::Rule;
                block.text.clear();
                block.spans.clear();
                let paragraph = self.empty_paragraph();
                self.splice(caret.block..caret.block + 1, vec![block, paragraph]);
                self.selection = Selection::caret(Pos::new(caret.block + 1, 0));
            }
            RuleEdit::Code { language } => {
                block.kind = BlockKind::Code { language };
                block.text.clear();
                block.spans.clear();
                self.replace_block(caret.block, block);
                self.selection = Selection::caret(Pos::new(caret.block, 0));
            }
            RuleEdit::Inline {
                open,
                close,
                inner,
                mark,
            } => {
                block.add_mark(inner, mark.clone());
                let removed = open.len() + close.len();
                block.delete_text(close);
                block.delete_text(open);
                let offset = caret.offset.saturating_sub(removed);
                let mut pending = block.insertion_marks(offset);
                pending.remove_kind(&mark);
                self.replace_block(caret.block, block);
                self.selection = Selection::caret(Pos::new(caret.block, offset));
                let change = self.commit(false, false);
                self.pending = Some(pending);
                return change;
            }
            RuleEdit::Replace { range, with } => {
                let marks = block.marks_at(range.start);
                let removed = range.len();
                let start = range.start;
                block.delete_text(range);
                block.insert_text_at(start, &with, &marks);
                self.replace_block(caret.block, block);
                let offset = caret.offset.saturating_sub(removed) + with.len();
                self.selection = Selection::caret(Pos::new(caret.block, offset));
            }
            RuleEdit::Link { range, url } => {
                block.add_mark(range, Mark::Link { url });
                self.replace_block(caret.block, block);
                self.selection = Selection::caret(caret);
            }
        }
        self.commit(false, false)
    }

    pub fn insert_newline(&mut self) -> Change {
        self.begin();
        let (start, end) = self.ordered();
        let collapsed = start == end;
        let at = self.delete_between(start, end);
        let block = self.block(at.block).clone();
        let markdown = self.rules.markdown;
        if block.kind.is_code() {
            let text = &block.text;
            let exits = at.offset == text.len() && (text.ends_with("\n\n") || text == "\n");
            if exits {
                let mut code = block.clone();
                let keep = if text == "\n" { 0 } else { text.len() - 2 };
                code.text.truncate(keep);
                let paragraph = self.empty_paragraph();
                self.splice(at.block..at.block + 1, vec![code, paragraph]);
                self.selection = Selection::caret(Pos::new(at.block + 1, 0));
            } else {
                let line_start = text[..at.offset].rfind('\n').map_or(0, |i| i + 1);
                let indentation: String = text[line_start..at.offset]
                    .chars()
                    .take_while(|c| *c == ' ' || *c == '\t')
                    .collect();
                let insert = format!("\n{indentation}");
                let caret = self.insert_inline(at, &insert, &MarkSet::new());
                self.selection = Selection::caret(caret);
            }
            return self.commit(false, false);
        }
        if block.kind.is_rule() {
            let paragraph = self.empty_paragraph();
            self.splice(at.block + 1..at.block + 1, vec![paragraph]);
            self.selection = Selection::caret(Pos::new(at.block + 1, 0));
            return self.commit(false, false);
        }
        if block.text.is_empty() && (block.kind.is_list() || block.kind == BlockKind::Quote) {
            let mut item = block;
            if item.kind.is_list() && item.indent > 0 {
                item.indent -= 1;
            } else {
                item.kind = BlockKind::Paragraph;
                item.indent = 0;
                item.start = None;
            }
            self.replace_block(at.block, item);
            self.selection = Selection::caret(Pos::new(at.block, 0));
            return self.commit(false, false);
        }
        if collapsed && markdown && block.kind == BlockKind::Paragraph && at.offset == block.len() {
            if let Some(language) = rules::code_fence(&block.text) {
                return self.apply_rule(at, RuleEdit::Code { language });
            }
            if rules::is_rule_text(&block.text) {
                return self.apply_rule(at, RuleEdit::Rule);
            }
        }
        let caret = self.split_block(at);
        self.selection = Selection::caret(caret);
        let change = self.commit(false, false);
        if markdown && caret.block > 0 {
            let left = self.block(caret.block - 1);
            let end = left.len();
            if let Some((range, url)) = rules::trailing_url(left, end) {
                let rule = self.apply_rule(
                    Pos::new(caret.block - 1, end),
                    RuleEdit::Link { range, url },
                );
                self.selection = Selection::caret(caret);
                if let Some(step) = self.history.last_mut() {
                    step.after = self.selection;
                }
                return change.merge(rule);
            }
        }
        change
    }

    pub(crate) fn split_block(&mut self, at: Pos) -> Pos {
        let mut block = self.block(at.block).clone();
        if at.offset == 0 && !block.text.is_empty() {
            let kind = match &block.kind {
                BlockKind::Heading(_) => BlockKind::Paragraph,
                other => continuation_kind(other, false),
            };
            let mut above = self.new_block(kind, block.indent);
            if block.kind == BlockKind::Ordered {
                above.start = block.start.take();
            }
            self.splice(at.block..at.block + 1, vec![above, block]);
            return Pos::new(at.block + 1, 0);
        }
        let (tail, spans) = block.split_off_at(at.offset);
        let kind = continuation_kind(&block.kind, tail.is_empty());
        let mut second = self.new_block(kind, block.indent);
        second.append(&tail, &spans);
        self.splice(at.block..at.block + 1, vec![block, second]);
        Pos::new(at.block + 1, 0)
    }

    pub fn delete_range(&mut self, from: Pos, to: Pos) -> Change {
        self.begin();
        let at = self.delete_between(from, to);
        self.selection = Selection::caret(at);
        self.commit(false, false)
    }

    pub fn delete_selection(&mut self) -> Change {
        let (start, end) = self.ordered();
        if start == end {
            return Change::default();
        }
        self.delete_range(start, end)
    }

    pub fn backspace(&mut self) -> Change {
        let (start, end) = self.ordered();
        if start != end {
            return self.delete_range(start, end);
        }
        let at = start;
        let block = self.block(at.block).clone();
        if at.offset > 0 {
            let from = Pos::new(at.block, prev_grapheme(&block.text, at.offset));
            self.begin();
            let caret = self.delete_between(from, at);
            self.selection = Selection::caret(caret);
            return self.commit(false, false);
        }
        self.begin();
        match &block.kind {
            BlockKind::Rule => {
                self.splice(at.block..at.block + 1, Vec::new());
                let caret = if at.block > 0 {
                    Pos::new(at.block - 1, self.block(at.block - 1).len())
                } else {
                    Pos::new(0, 0)
                };
                self.selection = Selection::caret(caret);
            }
            kind if kind.is_list() && block.indent > 0 => {
                let mut item = block;
                item.indent -= 1;
                self.replace_block(at.block, item);
            }
            BlockKind::Heading(_)
            | BlockKind::Quote
            | BlockKind::Bullet
            | BlockKind::Ordered
            | BlockKind::Task { .. } => {
                let mut item = block;
                item.kind = BlockKind::Paragraph;
                item.indent = 0;
                item.start = None;
                self.replace_block(at.block, item);
            }
            BlockKind::Code { .. } => {
                let lines = self.code_to_paragraphs(&block);
                self.splice(at.block..at.block + 1, lines);
                self.selection = Selection::caret(Pos::new(at.block, 0));
            }
            BlockKind::Paragraph | BlockKind::Unknown { .. } => {
                if at.block > 0 {
                    let prev = self.block(at.block - 1).clone();
                    if prev.kind.is_rule() {
                        self.splice(at.block - 1..at.block, Vec::new());
                        self.selection = Selection::caret(Pos::new(at.block - 1, 0));
                    } else if block.text.is_empty() {
                        self.splice(at.block..at.block + 1, Vec::new());
                        self.selection = Selection::caret(Pos::new(at.block - 1, prev.len()));
                    } else {
                        let caret = self.delete_between(
                            Pos::new(at.block - 1, prev.len()),
                            Pos::new(at.block, 0),
                        );
                        self.selection = Selection::caret(caret);
                    }
                }
            }
        }
        self.commit(false, false)
    }

    pub(crate) fn code_to_paragraphs(&mut self, block: &Block) -> Vec<Block> {
        block
            .text
            .split('\n')
            .enumerate()
            .map(|(index, line)| {
                let mut paragraph = if index == 0 {
                    let mut first = block.clone();
                    first.kind = BlockKind::Paragraph;
                    first.text.clear();
                    first
                } else {
                    self.empty_paragraph()
                };
                paragraph.text = line.to_string();
                paragraph
            })
            .collect()
    }

    pub fn delete_forward(&mut self) -> Change {
        let (start, end) = self.ordered();
        if start != end {
            return self.delete_range(start, end);
        }
        let at = start;
        let block = self.block(at.block).clone();
        if at.offset < block.len() {
            let to = Pos::new(at.block, next_grapheme(&block.text, at.offset));
            self.begin();
            let caret = self.delete_between(at, to);
            self.selection = Selection::caret(caret);
            return self.commit(false, false);
        }
        if at.block + 1 >= self.doc.blocks.len() {
            return self.commit_noop();
        }
        let next = self.block(at.block + 1).clone();
        self.begin();
        if block.kind.is_rule() {
            self.splice(at.block..at.block + 1, Vec::new());
            self.selection = Selection::caret(Pos::new(at.block, 0));
        } else if next.kind.is_rule() {
            self.splice(at.block + 1..at.block + 2, Vec::new());
        } else if block.text.is_empty() && !block.kind.is_code() {
            self.splice(at.block..at.block + 1, Vec::new());
            self.selection = Selection::caret(Pos::new(at.block, 0));
        } else if !block.kind.is_code() && next.kind.is_code() && next.text.contains('\n') {
        } else {
            let caret = self.delete_between(at, Pos::new(at.block + 1, 0));
            self.selection = Selection::caret(caret);
        }
        self.commit(false, false)
    }

    pub(crate) fn commit_noop(&mut self) -> Change {
        self.history.break_group();
        Change::default()
    }

    pub fn marks_at_selection(&self) -> MarkSet {
        let (start, end) = self.ordered();
        if start == end {
            if let Some(pending) = &self.pending {
                return pending.clone();
            }
            return self.block(start.block).insertion_marks(start.offset);
        }
        let mut result: Option<MarkSet> = None;
        for (index, range) in self.selected_ranges() {
            let block = self.block(index);
            if range.is_empty() || !block.kind.takes_marks() {
                continue;
            }
            let runs = block.runs();
            for run in runs {
                if run.range.end <= range.start || run.range.start >= range.end {
                    continue;
                }
                match &mut result {
                    None => result = Some(run.marks.clone()),
                    Some(set) => set.intersect(&run.marks),
                }
            }
        }
        result.unwrap_or_default()
    }

    pub(crate) fn selected_ranges(&self) -> Vec<(usize, Range<usize>)> {
        let (start, end) = self.ordered();
        (start.block..=end.block)
            .map(|index| {
                let len = self.block(index).len();
                let from = if index == start.block {
                    start.offset
                } else {
                    0
                };
                let to = if index == end.block { end.offset } else { len };
                (index, from..to.max(from))
            })
            .collect()
    }

    pub fn toggle_mark(&mut self, mark: Mark) -> Change {
        let (start, end) = self.ordered();
        if start == end {
            let mut marks = self.marks_at_selection();
            marks.toggle(mark);
            self.pending = Some(marks);
            return Change::default();
        }
        let ranges = self.selected_ranges();
        let all = ranges.iter().all(|(index, range)| {
            let block = self.block(*index);
            range.is_empty()
                || !block.kind.takes_marks()
                || block.has_mark_over(range.clone(), &mark)
        });
        let any_textual = ranges
            .iter()
            .any(|(index, range)| !range.is_empty() && self.block(*index).kind.takes_marks());
        if !any_textual {
            return Change::default();
        }
        self.apply_to_ranges(&ranges, |block, range| {
            if all {
                block.remove_mark(range, |m| m == &mark);
            } else {
                block.add_mark(range, mark.clone());
            }
        })
    }

    fn apply_to_ranges(
        &mut self,
        ranges: &[(usize, Range<usize>)],
        apply: impl Fn(&mut Block, Range<usize>),
    ) -> Change {
        let (Some(first), Some(last)) = (ranges.first(), ranges.last()) else {
            return Change::default();
        };
        let span = first.0..last.0 + 1;
        let blocks: Vec<Block> = ranges
            .iter()
            .map(|(index, range)| {
                let mut block = self.block(*index).clone();
                if !range.is_empty() {
                    apply(&mut block, range.clone());
                }
                block
            })
            .collect();
        if blocks
            .iter()
            .zip(&self.doc.blocks[span.clone()])
            .all(|(a, b)| a == b)
        {
            return self.commit_noop();
        }
        self.begin();
        self.splice(span, blocks);
        self.commit(false, false)
    }

    pub fn link_at(&self, pos: Pos) -> Option<LinkAt> {
        let pos = self.clamp_pos(pos);
        let block = self.block(pos.block);
        block.spans.iter().find_map(|span| match &span.mark {
            Mark::Link { url }
                if span.range.start <= pos.offset && pos.offset <= span.range.end =>
            {
                Some(LinkAt {
                    block: pos.block,
                    range: span.range.clone(),
                    url: url.clone(),
                })
            }
            _ => None,
        })
    }

    pub fn set_link(&mut self, url: Option<String>) -> Change {
        let url = url.filter(|url| !url.trim().is_empty());
        let (start, end) = self.ordered();
        let link_mark = Mark::Link { url: String::new() };
        if start == end {
            let existing = self.link_at(start);
            return match (url, existing) {
                (None, Some(link)) => {
                    self.apply_to_ranges(&[(link.block, link.range)], |block, range| {
                        block.remove_mark(range, |m| m.kind_eq(&link_mark));
                    })
                }
                (Some(url), Some(link)) => {
                    self.apply_to_ranges(&[(link.block, link.range)], |block, range| {
                        block.add_mark(range, Mark::Link { url: url.clone() });
                    })
                }
                (Some(url), None) => {
                    if !self.block(start.block).kind.takes_marks() {
                        return self.insert_text(&url);
                    }
                    let mut marks = self.block(start.block).insertion_marks(start.offset);
                    marks.insert(Mark::Link { url: url.clone() });
                    self.begin();
                    let caret = self.insert_inline(start, &url, &marks);
                    self.selection = Selection::caret(caret);
                    let change = self.commit(false, false);
                    let mut pending = marks;
                    pending.remove_kind(&link_mark);
                    self.pending = Some(pending);
                    change
                }
                (None, None) => Change::default(),
            };
        }
        let ranges = self.selected_ranges();
        match url {
            None => self.apply_to_ranges(&ranges, |block, range| {
                block.remove_mark(range, |m| m.kind_eq(&link_mark));
            }),
            Some(url) => self.apply_to_ranges(&ranges, |block, range| {
                block.add_mark(range, Mark::Link { url: url.clone() });
            }),
        }
    }
}
