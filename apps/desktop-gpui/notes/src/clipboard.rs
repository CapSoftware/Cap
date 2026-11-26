use std::ops::Range;

use crate::edit::normalize_newlines;
use crate::editor::{Change, Editor};
use crate::model::{Block, BlockKind, Document, Origin, Pos, Selection};
use crate::unicode::is_grapheme_boundary;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Match {
    pub block: usize,
    pub range: Range<usize>,
}

fn single_url(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    let lower = trimmed.to_ascii_lowercase();
    let scheme = ["https://", "http://", "mailto:"]
        .iter()
        .find(|scheme| lower.starts_with(*scheme))?;
    (trimmed.len() > scheme.len() && !trimmed.contains(char::is_whitespace)).then_some(trimmed)
}

fn slice_block(block: &Block, range: Range<usize>) -> Block {
    let mut copy = block.clone();
    copy.split_off_at(range.end);
    let (text, spans) = copy.split_off_at(range.start);
    copy.text = text;
    copy.spans = spans;
    copy.normalize();
    copy
}

fn fold(text: &str) -> (String, Vec<usize>) {
    let mut folded = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    for (index, c) in text.char_indices() {
        let start = folded.len();
        folded.extend(c.to_lowercase());
        map.extend(std::iter::repeat_n(index, folded.len() - start));
    }
    map.push(text.len());
    (folded, map)
}

impl Editor {
    pub fn selected_fragment(&self) -> Document {
        let (start, end) = self.ordered();
        if start == end {
            return Document::new();
        }
        let mut blocks = Vec::new();
        if start.block == end.block {
            let block = self.block(start.block);
            let whole = start.offset == 0 && end.offset == block.len();
            let mut piece = slice_block(block, start.offset..end.offset);
            if !whole && !piece.kind.is_code() {
                piece.kind = BlockKind::Paragraph;
                piece.indent = 0;
                piece.start = None;
            }
            blocks.push(piece);
        } else {
            for (index, range) in self.selected_ranges() {
                if index == end.block && range.is_empty() {
                    continue;
                }
                blocks.push(slice_block(self.block(index), range));
            }
        }
        let min_indent = blocks
            .iter()
            .filter(|block| block.kind.is_list())
            .map(|block| block.indent)
            .min()
            .unwrap_or(0);
        for block in &mut blocks {
            if block.kind.is_list() {
                block.indent -= min_indent;
            }
        }
        let mut doc = Document::from_blocks(blocks);
        doc.schema = self.doc.schema;
        doc.kind = self.doc.kind.clone();
        doc
    }

    pub fn selected_markdown(&self) -> String {
        let fragment = self.selected_fragment();
        match fragment.blocks.as_slice() {
            [only] if only.kind.is_code() && !self.selection_covers_block() => only.text.clone(),
            _ => fragment.to_markdown(),
        }
    }

    fn selection_covers_block(&self) -> bool {
        let (start, end) = self.ordered();
        start.block == end.block && start.offset == 0 && end.offset == self.block(end.block).len()
    }

    pub fn selected_plain_text(&self) -> String {
        let (start, end) = self.ordered();
        if start.block == end.block {
            let block = self.block(start.block);
            return block
                .text
                .get(start.offset..end.offset)
                .unwrap_or_default()
                .to_string();
        }
        self.selected_fragment().to_plain_text()
    }

    pub fn selected_html(&self) -> String {
        self.selected_fragment().to_html()
    }

    pub fn paste_markdown(&mut self, markdown: &str) -> Change {
        if let Some(url) = single_url(markdown)
            && !self.selection.is_collapsed()
        {
            return self.set_link(Some(url.to_string()));
        }
        let (start, end) = self.ordered();
        if self.block(start.block).kind.is_code() && start.block == end.block {
            return self.paste_plain(markdown);
        }
        let parsed = Document::from_markdown(markdown);
        let mut blocks = parsed.blocks;
        if blocks.len() == 1 && blocks[0].kind.is_paragraph_like() && blocks[0].text.is_empty() {
            return self.delete_selection();
        }
        for block in &mut blocks {
            block.id = self.fresh_id();
            block.origin = Origin::Author;
        }
        self.pending = None;
        self.begin();
        let at = self.delete_between(start, end);
        let caret = self.insert_fragment(at, blocks, true);
        self.selection = Selection::caret(caret);
        self.commit(false, false)
    }

    pub fn paste_plain(&mut self, text: &str) -> Change {
        if let Some(url) = single_url(text)
            && !self.selection.is_collapsed()
        {
            return self.set_link(Some(url.to_string()));
        }
        let text = normalize_newlines(text);
        if text.is_empty() {
            return self.delete_selection();
        }
        let (start, end) = self.ordered();
        self.begin();
        let at = self.delete_between(start, end);
        let pending = self.pending.take();
        let marks = pending.unwrap_or_else(|| self.block(at.block).insertion_marks(at.offset));
        let caret = self.insert_lines(at, &text, &marks);
        self.selection = Selection::caret(caret);
        self.commit(false, false)
    }

    pub fn find(&self, query: &str, case_sensitive: bool) -> Vec<Match> {
        if query.is_empty() {
            return Vec::new();
        }
        let folded_query = if case_sensitive {
            query.to_string()
        } else {
            query.to_lowercase()
        };
        let mut matches = Vec::new();
        for (index, block) in self.doc.blocks.iter().enumerate() {
            let (haystack, map) = if case_sensitive {
                (block.text.clone(), Vec::new())
            } else {
                fold(&block.text)
            };
            let to_original = |folded: usize| -> Option<usize> {
                if case_sensitive {
                    return Some(folded);
                }
                let original = *map.get(folded)?;
                let starts_char = folded == 0 || map.get(folded - 1) != Some(&original);
                starts_char.then_some(original)
            };
            let mut from = 0;
            while let Some(found) = haystack
                .get(from..)
                .and_then(|rest| rest.find(&folded_query))
            {
                let start = from + found;
                let end = start + folded_query.len();
                from = end;
                let (Some(original_start), Some(original_end)) =
                    (to_original(start), to_original(end))
                else {
                    continue;
                };
                if original_end > original_start
                    && is_grapheme_boundary(&block.text, original_start)
                    && is_grapheme_boundary(&block.text, original_end)
                {
                    matches.push(Match {
                        block: index,
                        range: original_start..original_end,
                    });
                }
            }
        }
        matches
    }

    fn valid_match(&self, found: &Match) -> bool {
        self.doc.blocks.get(found.block).is_some_and(|block| {
            found.range.start < found.range.end
                && found.range.end <= block.len()
                && is_grapheme_boundary(&block.text, found.range.start)
                && is_grapheme_boundary(&block.text, found.range.end)
        })
    }

    fn replace_in_block(block: &mut Block, range: Range<usize>, replacement: &str) {
        let marks = block.marks_at(range.start);
        let start = range.start;
        block.delete_text(range);
        block.insert_text_at(start, replacement, &marks);
        block.origin = Origin::Author;
    }

    pub fn replace_match(&mut self, found: &Match, replacement: &str) -> Change {
        if !self.valid_match(found) || self.block(found.block).kind.is_rule() {
            return Change::default();
        }
        let mut block = self.block(found.block).clone();
        let replacement = normalize_newlines(replacement);
        Self::replace_in_block(&mut block, found.range.clone(), &replacement);
        let end = (found.range.start + replacement.len()).min(block.len());
        self.begin();
        self.replace_block(found.block, block);
        self.selection = Selection::new(
            Pos::new(found.block, found.range.start),
            Pos::new(found.block, end),
        );
        self.commit(false, false)
    }

    /// Rename a name everywhere it stands as a whole word: "Person 2"
    /// becomes "Kristen" in "Person 2's plan" but not in "Person 20". The
    /// blocks keep who wrote them and their marks, so a renamed summary is
    /// still Cap's summary. One undoable step; None when nothing matched.
    pub fn rename_token(&mut self, from: &str, to: &str) -> Change {
        let to = normalize_newlines(to);
        if from.is_empty() || from == to {
            return Change::default();
        }
        let hits: Vec<(usize, Vec<Range<usize>>)> = self
            .doc
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, b)| !b.kind.is_rule())
            .map(|(i, b)| (i, token_ranges(&b.text, from)))
            .filter(|(_, ranges)| !ranges.is_empty())
            .collect();
        if hits.is_empty() {
            return Change::default();
        }
        self.begin();
        for (index, ranges) in hits {
            let mut block = self.block(index).clone();
            for range in ranges.into_iter().rev() {
                let marks = block.marks_at(range.start);
                let start = range.start;
                block.delete_text(range);
                block.insert_text_at(start, &to, &marks);
            }
            self.replace_block(index, block);
        }
        self.selection = self.clamp_selection(self.selection);
        self.commit(false, false)
    }

    pub fn replace_all(&mut self, query: &str, case_sensitive: bool, replacement: &str) -> Change {
        let found = self.find(query, case_sensitive);
        if found.is_empty() {
            return Change::default();
        }
        let replacement = normalize_newlines(replacement);
        self.begin();
        let mut index = found.len();
        while index > 0 {
            let block_index = found[index - 1].block;
            let mut block = self.block(block_index).clone();
            while index > 0 && found[index - 1].block == block_index {
                Self::replace_in_block(&mut block, found[index - 1].range.clone(), &replacement);
                index -= 1;
            }
            self.replace_block(block_index, block);
        }
        self.selection = self.clamp_selection(self.selection);
        self.commit(false, false)
    }
}

/// Where `token` stands as a whole word in `text`: not inside a longer word
/// or number on either side.
pub fn token_ranges(text: &str, token: &str) -> Vec<Range<usize>> {
    let mut out = Vec::new();
    if token.is_empty() {
        return out;
    }
    let word = |c: char| c.is_alphanumeric() || c == '_';
    let mut from = 0;
    while let Some(found) = text[from..].find(token) {
        let start = from + found;
        let end = start + token.len();
        let before = text[..start].chars().next_back();
        let after = text[end..].chars().next();
        let edge_ok = |edge: Option<char>, inner: Option<char>| match (edge, inner) {
            (Some(e), Some(i)) => !(word(e) && word(i)),
            _ => true,
        };
        if edge_ok(before, token.chars().next()) && edge_ok(after, token.chars().next_back()) {
            out.push(start..end);
            from = end;
        } else {
            from = start + token.chars().next().map_or(1, char::len_utf8);
        }
    }
    out
}

#[cfg(test)]
mod rename_tests {

    #[test]
    fn rename_token_renames_whole_names_keeps_origin_and_undoes_in_one_step() {
        let mut doc = crate::Document::from_markdown(
            "### Action items\n\n- Person 2: send the deck\n- Person 20 owns pricing\n- Ask **Person 2** about Person 2's plan\n",
        );
        for block in &mut doc.blocks {
            block.origin = crate::Origin::Generated;
        }
        let mut editor = crate::Editor::new(doc);
        let change = editor.rename_token("Person 2", "Kristen");
        assert!(change.changed());
        let md = editor.document().to_markdown();
        assert!(md.contains("Kristen: send the deck"), "{md}");
        assert!(md.contains("Person 20 owns pricing"), "{md}");
        assert!(md.contains("Ask **Kristen** about Kristen's plan"), "{md}");
        assert!(
            editor
                .document()
                .blocks
                .iter()
                .all(|b| b.origin == crate::Origin::Generated),
            "the summary is still Cap's"
        );
        editor.undo();
        assert!(
            editor
                .document()
                .to_markdown()
                .contains("Person 2: send the deck")
        );
        assert!(!editor.rename_token("Nobody", "X").changed());
    }

    #[test]
    fn token_ranges_respect_word_edges() {
        assert_eq!(crate::token_ranges("You and Youssef", "You"), vec![0..3]);
        assert_eq!(
            crate::token_ranges("ask Ana, then Ana.", "Ana"),
            vec![4..7, 14..17]
        );
        assert!(crate::token_ranges("Banana", "Ana").is_empty());
        assert_eq!(crate::token_ranges("(Person 1)", "Person 1"), vec![1..9]);
    }
}
