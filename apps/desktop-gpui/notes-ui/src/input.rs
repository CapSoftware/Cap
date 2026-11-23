use std::ops::Range;

use cap_notes::{Pos, Selection};
use gpui::{Bounds, Context, EntityInputHandler, Pixels, Point, UTF16Selection, Window, point, px};

use crate::editor::{Composition, NotesEditor};
use crate::text::{offset_from_utf16, offset_to_utf16};

impl NotesEditor {
    fn input_block(&self) -> usize {
        self.composition
            .as_ref()
            .map_or(self.editor.selection().head.block, |c| c.block)
    }

    /// The text the input method sees: the caret's block with any marked
    /// text spliced in, because composition never touches the document
    /// until it is committed.
    fn input_text(&self) -> String {
        let block = self.input_block();
        let text = self
            .editor
            .document()
            .blocks
            .get(block)
            .map_or("", |b| b.text.as_str());
        match &self.composition {
            Some(c) => {
                let at = crate::editor::floor_char_boundary(text, c.at);
                format!("{}{}{}", &text[..at], c.text, &text[at..])
            }
            None => text.to_string(),
        }
    }

    fn virtual_to_real(&self, offset: usize) -> usize {
        match &self.composition {
            Some(c) if offset >= c.at + c.text.len() => offset - c.text.len(),
            Some(c) if offset > c.at => c.at,
            _ => offset,
        }
    }
}

impl EntityInputHandler for NotesEditor {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let text = self.input_text();
        let start = offset_from_utf16(&text, range.start);
        let end = offset_from_utf16(&text, range.end).max(start);
        adjusted.replace(offset_to_utf16(&text, start)..offset_to_utf16(&text, end));
        text.get(start..end).map(str::to_string)
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        let text = self.input_text();
        if let Some(c) = &self.composition {
            let caret = offset_to_utf16(&text, c.at + c.caret);
            return Some(UTF16Selection {
                range: caret..caret,
                reversed: false,
            });
        }
        let selection = self.editor.selection();
        let block = selection.head.block;
        let start = if selection.start().block == block {
            selection.start().offset
        } else {
            0
        };
        let end = if selection.end().block == block {
            selection.end().offset
        } else {
            text.len()
        };
        Some(UTF16Selection {
            range: offset_to_utf16(&text, start)..offset_to_utf16(&text, end),
            reversed: selection.is_reversed(),
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        let c = self.composition.as_ref()?;
        let text = self.input_text();
        Some(offset_to_utf16(&text, c.at)..offset_to_utf16(&text, c.at + c.text.len()))
    }

    fn unmark_text(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.commit_composition(window, cx);
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.read_only {
            return;
        }
        let block = self.input_block();
        let virtual_text = self.input_text();
        let range = range.map(|r| {
            offset_from_utf16(&virtual_text, r.start)..offset_from_utf16(&virtual_text, r.end)
        });
        let composing = self.composition.take();
        if let Some(c) = &composing {
            let marked = c.at..c.at + c.text.len();
            let real = match range {
                Some(r) if r != marked => {
                    let start = if r.start < marked.start {
                        r.start
                    } else {
                        c.at
                    };
                    let end = if r.end > marked.end {
                        r.end - c.text.len()
                    } else {
                        c.at
                    };
                    Some(start..end.max(start))
                }
                _ => None,
            };
            if let Some(real) = real.filter(|r| !r.is_empty()) {
                self.editor.set_selection(Selection::new(
                    Pos::new(block, real.start),
                    Pos::new(block, real.end),
                ));
            }
        } else if let Some(r) = range {
            let start = self.virtual_to_real(r.start);
            let end = self.virtual_to_real(r.end).max(start);
            self.editor
                .set_selection(Selection::new(Pos::new(block, start), Pos::new(block, end)));
        }
        self.insert_typed(text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.read_only {
            return;
        }
        if text.is_empty() {
            if self.composition.take().is_some() {
                cx.notify();
            }
            return;
        }
        if self.composition.is_none() {
            let block = self.editor.selection().head.block;
            let replace = range.map(|r| {
                let block_text = &self.editor.document().blocks[block].text;
                offset_from_utf16(block_text, r.start)..offset_from_utf16(block_text, r.end)
            });
            let before = self.editor.selection();
            let change = match replace.filter(|r| !r.is_empty()) {
                Some(r) => self
                    .editor
                    .delete_range(Pos::new(block, r.start), Pos::new(block, r.end)),
                None if !before.is_collapsed() => self.editor.delete_selection(),
                None => cap_notes::Change::default(),
            };
            if change.changed() {
                self.after_edit(change, before, false, cx);
            }
            let head = self.editor.selection().head;
            self.composition = Some(Composition {
                block: head.block,
                at: head.offset,
                text: String::new(),
                caret: 0,
            });
        }
        if let Some(c) = self.composition.as_mut() {
            c.text = text.to_string();
            c.caret = selected
                .map(|r| offset_from_utf16(text, r.end))
                .unwrap_or(text.len())
                .min(text.len());
        }
        self.toolbar_visible = false;
        self.slash = None;
        self.caret_epoch = std::time::Instant::now();
        self.store.borrow_mut().autoscroll = Some(crate::store::Autoscroll::Caret);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        _: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let text = self.input_text();
        let block = self.input_block();
        let start = offset_from_utf16(&text, range.start);
        let end = offset_from_utf16(&text, range.end);
        let store = self.store.borrow();
        let painted = store.painted(block)?;
        let layout = store.slots.get(block)?.layout.as_ref()?;
        if layout.text.as_ref() != text {
            return None;
        }
        let a = layout.caret(start, false);
        let b = layout.caret(end, false);
        let right = if b.row == a.row { b.x.max(a.x) } else { a.x };
        Some(Bounds::from_corners(
            point(px(painted.text_left + a.x), px(painted.text_top + a.top)),
            point(
                px(painted.text_left + right),
                px(painted.text_top + a.top + a.height),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let text = self.input_text();
        let block = self.input_block();
        let store = self.store.borrow();
        let painted = store.painted(block)?;
        let layout = store.slots.get(block)?.layout.as_ref()?;
        let (offset, _) = layout.hit(
            f32::from(position.x) - painted.text_left,
            f32::from(position.y) - painted.text_top,
        );
        Some(offset_to_utf16(&text, offset))
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let text = self.input_text();
        Some(offset_to_utf16(&text, text.len()))
    }

    fn accepts_text_input(&self, _: &mut Window, _: &mut Context<Self>) -> bool {
        !self.read_only
    }
}
