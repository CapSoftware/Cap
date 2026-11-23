use crate::editor::{Change, Editor};
use crate::model::{Block, BlockKind, MAX_INDENT, Pos, Selection, max_indent_after};

impl Editor {
    pub fn set_kind(&mut self, kind: BlockKind) -> Change {
        if kind.is_rule() {
            return self.insert_rule();
        }
        let range = self.block_range();
        let selection = self.clamp_selection(self.selection);
        let originals: Vec<Block> = self.doc.blocks[range.clone()].to_vec();
        if let BlockKind::Code { language } = &kind {
            if originals.iter().all(|block| block.kind.is_code()) {
                let updated: Vec<Block> = originals
                    .iter()
                    .map(|block| {
                        let mut block = block.clone();
                        block.kind = BlockKind::Code {
                            language: language.clone(),
                        };
                        block
                    })
                    .collect();
                return self.replace_range_keeping_selection(range, updated, selection);
            }
            let textual: Vec<(usize, &Block)> = originals
                .iter()
                .enumerate()
                .filter(|(_, block)| !block.kind.is_rule())
                .collect();
            let Some((_, first)) = textual.first() else {
                return Change::default();
            };
            let mut code = (*first).clone();
            code.kind = kind.clone();
            code.indent = 0;
            code.start = None;
            code.spans.clear();
            code.text.clear();
            let mut starts = vec![None; originals.len()];
            for (position, (index, block)) in textual.iter().enumerate() {
                if position > 0 {
                    code.text.push('\n');
                }
                starts[*index] = Some(code.text.len());
                code.text.push_str(&block.text);
            }
            let map = |pos: Pos| {
                let local = pos.block - range.start;
                let offset = starts
                    .get(local)
                    .copied()
                    .flatten()
                    .map_or(0, |s| s + pos.offset);
                Pos::new(range.start, offset)
            };
            let new_selection = Selection::new(map(selection.anchor), map(selection.head));
            let kept: Vec<Block> = originals
                .iter()
                .filter(|block| block.kind.is_rule())
                .cloned()
                .collect();
            let mut blocks = vec![code];
            blocks.extend(kept);
            self.begin();
            self.splice(range, blocks);
            self.selection = new_selection;
            return self.commit(false, false);
        }
        let mut blocks: Vec<Block> = Vec::with_capacity(originals.len());
        let mut index_map: Vec<(usize, Vec<usize>)> = Vec::with_capacity(originals.len());
        for block in &originals {
            let first_index = blocks.len();
            if block.kind.is_rule() {
                blocks.push(block.clone());
                index_map.push((first_index, vec![0]));
                continue;
            }
            let pieces = if block.kind.is_code() {
                self.code_to_paragraphs(block)
            } else {
                vec![block.clone()]
            };
            let mut line_starts = Vec::with_capacity(pieces.len());
            let mut offset = 0;
            for mut piece in pieces {
                line_starts.push(offset);
                offset += piece.text.len() + 1;
                let was_list = piece.kind.is_list();
                piece.kind = kind.clone();
                piece.start = None;
                if !kind.is_list() || !was_list {
                    piece.indent = 0;
                }
                piece.normalize();
                blocks.push(piece);
            }
            index_map.push((first_index, line_starts));
        }
        let map = |pos: Pos| {
            let local = pos.block - range.start;
            let Some((first, starts)) = index_map.get(local) else {
                return pos;
            };
            let line = starts
                .iter()
                .rposition(|start| *start <= pos.offset)
                .unwrap_or(0);
            let start = starts.get(line).copied().unwrap_or(0);
            Pos::new(range.start + first + line, pos.offset - start)
        };
        let new_selection = Selection::new(map(selection.anchor), map(selection.head));
        if blocks == originals {
            return self.commit_noop();
        }
        self.begin();
        self.splice(range, blocks);
        self.selection = new_selection;
        self.commit(false, false)
    }

    fn replace_range_keeping_selection(
        &mut self,
        range: std::ops::Range<usize>,
        blocks: Vec<Block>,
        selection: Selection,
    ) -> Change {
        if blocks.as_slice() == &self.doc.blocks[range.clone()] {
            return self.commit_noop();
        }
        self.begin();
        self.splice(range, blocks);
        self.selection = selection;
        self.commit(false, false)
    }

    pub fn toggle_kind(&mut self, kind: BlockKind) -> Change {
        let range = self.block_range();
        let all = self.doc.blocks[range]
            .iter()
            .filter(|block| !block.kind.is_rule())
            .all(|block| block.kind.same_type(&kind));
        if all && !kind.is_paragraph_like() {
            self.set_kind(BlockKind::Paragraph)
        } else {
            self.set_kind(kind)
        }
    }

    pub fn toggle_task_checked(&mut self, index: usize) -> Change {
        let Some(block) = self.doc.blocks.get(index) else {
            return Change::default();
        };
        let BlockKind::Task { checked } = block.kind else {
            return Change::default();
        };
        let mut block = block.clone();
        block.kind = BlockKind::Task { checked: !checked };
        let selection = self.selection;
        self.replace_range_keeping_selection(index..index + 1, vec![block], selection)
    }

    pub fn indent(&mut self) -> Change {
        self.shift_indent(true)
    }

    pub fn outdent(&mut self) -> Change {
        self.shift_indent(false)
    }

    fn shift_indent(&mut self, deeper: bool) -> Change {
        let range = self.block_range();
        let has_list = self.doc.blocks[range.clone()]
            .iter()
            .any(|block| block.kind.is_list());
        if !has_list {
            return self.shift_text_indent(deeper);
        }
        let selected: Vec<usize> = range
            .clone()
            .filter(|index| self.doc.blocks[*index].kind.is_list())
            .collect();
        let Some(&first) = selected.first() else {
            return Change::default();
        };
        let min_indent = selected
            .iter()
            .map(|index| self.doc.blocks[*index].indent)
            .min()
            .unwrap_or(0);
        let mut end = range.end;
        while end < self.doc.blocks.len()
            && self.doc.blocks[end].kind.is_list()
            && self.doc.blocks[end].indent > min_indent
        {
            end += 1;
        }
        let first_block = &self.doc.blocks[first];
        if deeper {
            let limit = max_indent_after(first.checked_sub(1).map(|i| &self.doc.blocks[i]));
            if first_block.indent >= limit || first_block.indent >= MAX_INDENT {
                return self.commit_noop();
            }
        } else if selected
            .iter()
            .all(|index| self.doc.blocks[*index].indent == 0)
        {
            return self.commit_noop();
        }
        let blocks: Vec<Block> = (range.start..end)
            .map(|index| {
                let mut block = self.doc.blocks[index].clone();
                if block.kind.is_list() {
                    block.indent = if deeper {
                        block.indent.saturating_add(1).min(MAX_INDENT)
                    } else {
                        block.indent.saturating_sub(1)
                    };
                }
                block
            })
            .collect();
        let selection = self.clamp_selection(self.selection);
        self.replace_range_keeping_selection(range.start..end, blocks, selection)
    }

    fn shift_text_indent(&mut self, deeper: bool) -> Change {
        let (start, end) = self.ordered();
        if start.block != end.block {
            return self.commit_noop();
        }
        let block = self.block(start.block).clone();
        if block.kind.is_rule() {
            return self.commit_noop();
        }
        if block.kind.is_code() && block.text[start.offset..end.offset].contains('\n') {
            return self.shift_code_lines(start, end, deeper);
        }
        if deeper {
            self.begin();
            let at = self.delete_between(start, end);
            let marks = self.block(at.block).insertion_marks(at.offset);
            let caret = self.insert_inline(at, "\t", &marks);
            self.selection = Selection::caret(caret);
            return self.commit(false, false);
        }
        let caret = self.clamp_pos(self.selection.head);
        let target = if block.text[..caret.offset].ends_with('\t') {
            Some(caret.offset - 1)
        } else if block.kind.is_code() {
            let line_start = block.text[..caret.offset].rfind('\n').map_or(0, |i| i + 1);
            block.text[line_start..]
                .starts_with('\t')
                .then_some(line_start)
        } else {
            block.text.starts_with('\t').then_some(0)
        };
        let Some(offset) = target else {
            return self.commit_noop();
        };
        let mut updated = block;
        updated.delete_text(offset..offset + 1);
        let shift = |pos: Pos| {
            if pos.block == caret.block && pos.offset > offset {
                Pos::new(pos.block, pos.offset - 1)
            } else {
                pos
            }
        };
        let selection = Selection::new(shift(self.selection.anchor), shift(self.selection.head));
        self.replace_range_keeping_selection(caret.block..caret.block + 1, vec![updated], selection)
    }

    fn shift_code_lines(&mut self, start: Pos, end: Pos, deeper: bool) -> Change {
        let block = self.block(start.block).clone();
        let first_line = block.text[..start.offset].rfind('\n').map_or(0, |i| i + 1);
        let mut line_starts: Vec<usize> = vec![first_line];
        for (i, c) in block.text[first_line..end.offset].char_indices() {
            if c == '\n' {
                line_starts.push(first_line + i + 1);
            }
        }
        let mut text = block.text.clone();
        let mut deltas: Vec<(usize, isize)> = Vec::new();
        for &line in line_starts.iter().rev() {
            if deeper {
                text.insert(line, '\t');
                deltas.push((line, 1));
            } else {
                let rest = &text[line..];
                let remove = if rest.starts_with('\t') {
                    1
                } else {
                    rest.bytes().take(4).take_while(|b| *b == b' ').count()
                };
                if remove > 0 {
                    text.replace_range(line..line + remove, "");
                    deltas.push((line, -(remove as isize)));
                }
            }
        }
        if deltas.is_empty() {
            return self.commit_noop();
        }
        let map = |pos: Pos| {
            let p = pos.offset;
            let mut offset = p as isize;
            for &(line, delta) in &deltas {
                if delta > 0 && line <= p {
                    offset += delta;
                } else if delta < 0 {
                    let removed = delta.unsigned_abs();
                    if p >= line + removed {
                        offset += delta;
                    } else if p > line {
                        offset -= (p - line) as isize;
                    }
                }
            }
            Pos::new(pos.block, offset.max(0) as usize)
        };
        let selection = Selection::new(map(self.selection.anchor), map(self.selection.head));
        let mut updated = block;
        updated.text = text;
        self.replace_range_keeping_selection(start.block..start.block + 1, vec![updated], selection)
    }

    pub fn insert_rule(&mut self) -> Change {
        self.begin();
        let (start, end) = self.ordered();
        let at = self.delete_between(start, end);
        let block = self.block(at.block).clone();
        let mut rule = self.new_block(BlockKind::Rule, 0);
        if block.text.is_empty() && !block.kind.is_code() && !block.kind.is_rule() {
            rule.id = block.id;
            rule.attrs = block.attrs.clone();
            let paragraph = self.empty_paragraph();
            self.splice(at.block..at.block + 1, vec![rule, paragraph]);
            self.selection = Selection::caret(Pos::new(at.block + 1, 0));
        } else if at.offset == 0 && !block.kind.is_rule() {
            self.splice(at.block..at.block, vec![rule]);
            self.selection = Selection::caret(Pos::new(at.block + 1, 0));
        } else if at.offset >= block.len() {
            let paragraph = self.empty_paragraph();
            self.splice(at.block + 1..at.block + 1, vec![rule, paragraph]);
            self.selection = Selection::caret(Pos::new(at.block + 2, 0));
        } else {
            let mut first = block;
            let (tail, spans) = first.split_off_at(at.offset);
            let mut second = self.new_block(first.kind.clone(), first.indent);
            if second.kind.is_code() {
                second.text = tail;
            } else {
                second.append(&tail, &spans);
            }
            self.splice(at.block..at.block + 1, vec![first, rule, second]);
            self.selection = Selection::caret(Pos::new(at.block + 2, 0));
        }
        self.commit(false, false)
    }

    pub fn move_block_up(&mut self) -> Change {
        let range = self.block_range();
        if range.start == 0 {
            return self.commit_noop();
        }
        let mut blocks: Vec<Block> = self.doc.blocks[range.clone()].to_vec();
        blocks.push(self.doc.blocks[range.start - 1].clone());
        let selection = self.clamp_selection(self.selection);
        let shift = |pos: Pos| Pos::new(pos.block - 1, pos.offset);
        self.begin();
        self.splice(range.start - 1..range.end, blocks);
        self.selection = Selection::new(shift(selection.anchor), shift(selection.head));
        self.commit(false, false)
    }

    pub fn move_block_down(&mut self) -> Change {
        let range = self.block_range();
        if range.end >= self.doc.blocks.len() {
            return self.commit_noop();
        }
        let mut blocks = vec![self.doc.blocks[range.end].clone()];
        blocks.extend(self.doc.blocks[range.clone()].iter().cloned());
        let selection = self.clamp_selection(self.selection);
        let shift = |pos: Pos| Pos::new(pos.block + 1, pos.offset);
        self.begin();
        self.splice(range.start..range.end + 1, blocks);
        self.selection = Selection::new(shift(selection.anchor), shift(selection.head));
        self.commit(false, false)
    }
}
