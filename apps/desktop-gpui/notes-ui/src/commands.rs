use cap_notes::{BlockKind, Mark, Pos, Selection};
use gpui::{ClipboardItem, Context, Window};

use crate::actions::*;
use crate::editor::NotesEditor;
use crate::layout;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Vertical {
    Up,
    Down,
}

impl NotesEditor {
    fn toggle(&mut self, mark: Mark, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        self.edit(cx, |editor| editor.toggle_mark(mark));
        if !self.editor.selection().is_collapsed() {
            self.show_toolbar(cx);
        }
    }

    fn kind(&mut self, kind: BlockKind, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.toggle_kind(kind));
    }

    pub(crate) fn on_toggle_bold(
        &mut self,
        _: &ToggleBold,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Bold, cx);
    }

    pub(crate) fn on_toggle_italic(
        &mut self,
        _: &ToggleItalic,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Italic, cx);
    }

    pub(crate) fn on_toggle_underline(
        &mut self,
        _: &ToggleUnderline,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Underline, cx);
    }

    pub(crate) fn on_toggle_strike(
        &mut self,
        _: &ToggleStrikethrough,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Strike, cx);
    }

    pub(crate) fn on_toggle_code(
        &mut self,
        _: &ToggleCode,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Code, cx);
    }

    pub(crate) fn on_toggle_highlight(
        &mut self,
        _: &ToggleHighlight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle(Mark::Highlight, cx);
    }

    pub(crate) fn on_heading_1(&mut self, _: &Heading1, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Heading(1), cx);
    }

    pub(crate) fn on_heading_2(&mut self, _: &Heading2, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Heading(2), cx);
    }

    pub(crate) fn on_heading_3(&mut self, _: &Heading3, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Heading(3), cx);
    }

    pub(crate) fn on_paragraph(&mut self, _: &Paragraph, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.set_kind(BlockKind::Paragraph));
    }

    pub(crate) fn on_ordered(&mut self, _: &OrderedList, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Ordered, cx);
    }

    pub(crate) fn on_bullet(&mut self, _: &BulletList, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Bullet, cx);
    }

    pub(crate) fn on_task(&mut self, _: &TaskList, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Task { checked: false }, cx);
    }

    pub(crate) fn on_quote(&mut self, _: &Quote, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(BlockKind::Quote, cx);
    }

    pub(crate) fn on_code_block(&mut self, _: &CodeBlock, _: &mut Window, cx: &mut Context<Self>) {
        self.kind(
            BlockKind::Code {
                language: String::new(),
            },
            cx,
        );
    }

    pub(crate) fn on_edit_link(
        &mut self,
        _: &EditLink,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.open_link_editor(window, cx);
    }

    pub(crate) fn on_toggle_checkbox(
        &mut self,
        _: &ToggleCheckbox,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = self.editor.selection();
        let (start, end) = (selection.start().block, selection.end().block);
        let tasks: Vec<usize> = (start..=end)
            .filter(|index| {
                matches!(
                    self.editor.document().blocks.get(*index).map(|b| &b.kind),
                    Some(BlockKind::Task { .. })
                )
            })
            .collect();
        for index in tasks {
            self.toggle_checkbox_at(index, cx);
        }
    }

    pub(crate) fn on_indent(&mut self, _: &Indent, _: &mut Window, cx: &mut Context<Self>) {
        if self.slash.is_some() && !self.slash_entries().is_empty() {
            let selected = self.slash.as_ref().map_or(0, |slash| slash.selected);
            self.apply_slash(selected, cx);
            return;
        }
        self.edit(cx, |editor| editor.indent());
    }

    pub(crate) fn on_outdent(&mut self, _: &Outdent, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.outdent());
    }

    pub(crate) fn on_move_block_up(
        &mut self,
        _: &MoveBlockUp,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit(cx, |editor| editor.move_block_up());
    }

    pub(crate) fn on_move_block_down(
        &mut self,
        _: &MoveBlockDown,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit(cx, |editor| editor.move_block_down());
    }

    pub(crate) fn on_undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.undo());
    }

    pub(crate) fn on_redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.redo());
    }

    pub(crate) fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        if self.editor.selection().is_collapsed() {
            return false;
        }
        let markdown = self.editor.selected_markdown();
        cx.write_to_clipboard(ClipboardItem::new_string(markdown));
        true
    }

    pub(crate) fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        self.copy_selection(cx);
    }

    pub(crate) fn on_cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            self.copy_selection(cx);
            return;
        }
        if self.copy_selection(cx) {
            self.edit(cx, |editor| editor.delete_selection());
        }
    }

    pub(crate) fn paste_clipboard(&mut self, plain: bool, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        if plain {
            self.edit(cx, |editor| editor.paste_plain(&text));
        } else {
            self.edit(cx, |editor| editor.paste_markdown(&text));
        }
    }

    pub(crate) fn on_paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        self.paste_clipboard(false, cx);
    }

    pub(crate) fn on_paste_plain(
        &mut self,
        _: &PastePlain,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.paste_clipboard(true, cx);
    }

    pub(crate) fn on_select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        let before = self.editor.selection();
        self.editor.select_all();
        self.after_motion(before, true, cx);
        self.store.borrow_mut().autoscroll = None;
    }

    pub(crate) fn on_backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        let typing_slash = self.slash.is_some() || self.mention.is_some();
        let before = self.editor.selection();
        if self.read_only {
            return;
        }
        self.composition = None;
        let change = self.editor.backspace();
        self.after_edit(change, before, typing_slash, cx);
    }

    pub(crate) fn on_delete(&mut self, _: &DeleteForward, _: &mut Window, cx: &mut Context<Self>) {
        self.edit(cx, |editor| editor.delete_forward());
    }

    pub(crate) fn on_delete_word_left(
        &mut self,
        _: &DeleteWordLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = self.editor.selection();
        if !selection.is_collapsed() {
            self.edit(cx, |editor| editor.delete_selection());
            return;
        }
        let head = selection.head;
        let target = if head.offset == 0 {
            self.editor.pos_before(head)
        } else {
            let text = &self.editor.document().blocks[head.block].text;
            Pos::new(head.block, cap_notes::prev_word(text, head.offset))
        };
        self.edit(cx, |editor| editor.delete_range(target, head));
    }

    pub(crate) fn on_delete_word_right(
        &mut self,
        _: &DeleteWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = self.editor.selection();
        if !selection.is_collapsed() {
            self.edit(cx, |editor| editor.delete_selection());
            return;
        }
        let head = selection.head;
        let text = &self.editor.document().blocks[head.block].text;
        let target = if head.offset >= text.len() {
            self.editor.pos_after(head)
        } else {
            Pos::new(head.block, cap_notes::next_word(text, head.offset))
        };
        self.edit(cx, |editor| editor.delete_range(head, target));
    }

    pub(crate) fn on_delete_to_line_start(
        &mut self,
        _: &DeleteToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = self.editor.selection();
        if !selection.is_collapsed() {
            self.edit(cx, |editor| editor.delete_selection());
            return;
        }
        let head = selection.head;
        let (start, _) = self.line_bounds(head, window);
        if start.offset >= head.offset {
            self.edit(cx, |editor| editor.backspace());
        } else {
            self.edit(cx, |editor| editor.delete_range(start, head));
        }
    }

    pub(crate) fn on_delete_to_line_end(
        &mut self,
        _: &DeleteToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let selection = self.editor.selection();
        if !selection.is_collapsed() {
            self.edit(cx, |editor| editor.delete_selection());
            return;
        }
        let head = selection.head;
        let (_, (end, _)) = self.line_bounds(head, window);
        if end.offset <= head.offset {
            self.edit(cx, |editor| editor.delete_forward());
        } else {
            self.edit(cx, |editor| editor.delete_range(head, end));
        }
    }

    pub(crate) fn on_newline(&mut self, _: &Newline, window: &mut Window, cx: &mut Context<Self>) {
        if self.slash.is_some() {
            let selected = self.slash.as_ref().map_or(0, |slash| slash.selected);
            if !self.slash_entries().is_empty() {
                self.apply_slash(selected, cx);
                return;
            }
        }
        if let Some(menu) = self.menu.clone() {
            if let Some(index) = menu.selected {
                self.run_menu_item(index, window, cx);
            }
            return;
        }
        self.edit(cx, |editor| editor.insert_newline());
    }

    pub(crate) fn on_cancel(&mut self, _: &Cancel, window: &mut Window, cx: &mut Context<Self>) {
        if self.slash.take().is_some() || self.menu.take().is_some() {
            cx.notify();
            return;
        }
        if self.mention.is_some() {
            self.dismiss_mention(cx);
            return;
        }
        if self.find.is_some() {
            self.close_find(window, cx);
            return;
        }
        if self.toolbar_visible {
            self.toolbar_visible = false;
            cx.notify();
        }
    }

    pub(crate) fn on_find(&mut self, _: &Find, window: &mut Window, cx: &mut Context<Self>) {
        self.show_find_bar(window, cx);
    }

    pub(crate) fn on_find_next(&mut self, _: &FindNext, _: &mut Window, cx: &mut Context<Self>) {
        self.find_step(true, cx);
    }

    pub(crate) fn on_find_previous(
        &mut self,
        _: &FindPrevious,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.find_step(false, cx);
    }

    pub(crate) fn on_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn motion(
        &mut self,
        cx: &mut Context<Self>,
        keep_goal: bool,
        f: impl FnOnce(&mut Self) -> Option<bool>,
    ) {
        let before = self.editor.selection();
        let goal = self.goal_x;
        let upstream = f(self);
        self.upstream = upstream.unwrap_or(false);
        if keep_goal {
            self.goal_x = goal.or(self.goal_x);
        } else {
            self.goal_x = None;
        }
        self.after_motion(before, true, cx);
    }

    pub(crate) fn on_move_left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.motion(cx, false, |this| {
            this.editor.move_left(false);
            None
        });
    }

    pub(crate) fn on_move_right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        self.motion(cx, false, |this| {
            this.editor.move_right(false);
            None
        });
    }

    pub(crate) fn on_select_left(
        &mut self,
        _: &SelectLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_left(true);
            None
        });
    }

    pub(crate) fn on_select_right(
        &mut self,
        _: &SelectRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_right(true);
            None
        });
    }

    pub(crate) fn on_move_word_left(
        &mut self,
        _: &MoveWordLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_word_left(false);
            None
        });
    }

    pub(crate) fn on_move_word_right(
        &mut self,
        _: &MoveWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_word_right(false);
            None
        });
    }

    pub(crate) fn on_select_word_left(
        &mut self,
        _: &SelectWordLeft,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_word_left(true);
            None
        });
    }

    pub(crate) fn on_select_word_right(
        &mut self,
        _: &SelectWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_word_right(true);
            None
        });
    }

    pub(crate) fn on_move_to_start(
        &mut self,
        _: &MoveToStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_to_doc_start(false);
            None
        });
    }

    pub(crate) fn on_move_to_end(&mut self, _: &MoveToEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.motion(cx, false, |this| {
            this.editor.move_to_doc_end(false);
            None
        });
    }

    pub(crate) fn on_select_to_start(
        &mut self,
        _: &SelectToStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_to_doc_start(true);
            None
        });
    }

    pub(crate) fn on_select_to_end(
        &mut self,
        _: &SelectToEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.motion(cx, false, |this| {
            this.editor.move_to_doc_end(true);
            None
        });
    }

    pub(crate) fn line_bounds(&mut self, pos: Pos, window: &mut Window) -> (Pos, (Pos, bool)) {
        let upstream = self.upstream && pos == self.editor.selection().head;
        self.with_layout(pos.block, window, |layout| {
            let row_index = layout.row_of(layout.to_virtual(pos.offset), upstream);
            let row = layout.rows[row_index];
            let continues = layout
                .rows
                .get(row_index + 1)
                .is_some_and(|next| next.line == row.line);
            (
                Pos::new(pos.block, layout.to_real(row.start)),
                (Pos::new(pos.block, layout.to_real(row.end)), continues),
            )
        })
        .unwrap_or((pos, (pos, false)))
    }

    fn line_move(&mut self, end: bool, extend: bool, window: &mut Window, cx: &mut Context<Self>) {
        let head = self.editor.selection().head;
        let (start, (stop, upstream)) = self.line_bounds(head, window);
        self.motion(cx, false, |this| {
            if end {
                this.editor.extend_or_move(stop, extend);
                Some(upstream)
            } else {
                this.editor.extend_or_move(start, extend);
                None
            }
        });
    }

    pub(crate) fn on_move_to_line_start(
        &mut self,
        _: &MoveToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.line_move(false, false, window, cx);
    }

    pub(crate) fn on_move_to_line_end(
        &mut self,
        _: &MoveToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.line_move(true, false, window, cx);
    }

    pub(crate) fn on_select_to_line_start(
        &mut self,
        _: &SelectToLineStart,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.line_move(false, true, window, cx);
    }

    pub(crate) fn on_select_to_line_end(
        &mut self,
        _: &SelectToLineEnd,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.line_move(true, true, window, cx);
    }

    pub(crate) fn vertical_target(
        &mut self,
        from: Pos,
        upstream: bool,
        rows: isize,
        window: &mut Window,
    ) -> (Pos, bool, f32) {
        let theme = self.theme.clone();
        let inset_of = |editor: &Self, index: usize| {
            layout::metrics(&editor.editor.document().blocks[index], &theme).inset
        };
        let caret = self
            .with_layout(from.block, window, |layout| {
                let c = layout.caret(layout.to_virtual(from.offset), upstream);
                (c.row, c.x, layout.rows.len())
            })
            .unwrap_or((0, 0., 1));
        let goal = self
            .goal_x
            .unwrap_or_else(|| inset_of(self, from.block) + caret.1);
        let mut block = from.block;
        let mut row = caret.0 as isize + rows;
        let mut row_count = caret.2;
        let blocks = self.editor.document().blocks.len();
        loop {
            if row < 0 {
                if block == 0 {
                    return (Pos::new(0, 0), false, goal);
                }
                block -= 1;
                row_count = self
                    .with_layout(block, window, |layout| layout.rows.len())
                    .unwrap_or(1);
                row += row_count as isize;
            } else if row as usize >= row_count {
                if block + 1 >= blocks {
                    let end = self.editor.doc_end();
                    return (end, false, goal);
                }
                row -= row_count as isize;
                block += 1;
                row_count = self
                    .with_layout(block, window, |layout| layout.rows.len())
                    .unwrap_or(1);
            } else {
                break;
            }
        }
        let x = goal - inset_of(self, block);
        let (offset, up) = self
            .with_layout(block, window, |layout| {
                let (virtual_offset, up) = layout.hit_row(row as usize, x);
                (layout.to_real(virtual_offset), up)
            })
            .unwrap_or((0, false));
        (Pos::new(block, offset), up, goal)
    }

    fn vertical(
        &mut self,
        direction: Vertical,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.slash.is_some() && !extend {
            let count = self.slash_entries().len();
            if let Some(slash) = self.slash.as_mut()
                && count > 0
            {
                slash.selected = match direction {
                    Vertical::Up => (slash.selected + count - 1) % count,
                    Vertical::Down => (slash.selected + 1) % count,
                };
                cx.notify();
                return;
            }
        }
        let count = self.menu_items().len();
        if let Some(menu) = self.menu.as_mut() {
            if count > 0 {
                menu.selected = Some(match (menu.selected, direction) {
                    (None, Vertical::Down) => 0,
                    (None, Vertical::Up) => count - 1,
                    (Some(i), Vertical::Up) => (i + count - 1) % count,
                    (Some(i), Vertical::Down) => (i + 1) % count,
                });
                cx.notify();
            }
            return;
        }
        let selection = self.editor.selection();
        let from = if extend || selection.is_collapsed() {
            selection.head
        } else if direction == Vertical::Up {
            selection.start()
        } else {
            selection.end()
        };
        let delta = if direction == Vertical::Up { -1 } else { 1 };
        let (target, upstream, goal) = self.vertical_target(from, self.upstream, delta, window);
        self.motion(cx, true, |this| {
            this.editor.extend_or_move(target, extend);
            this.goal_x = Some(goal);
            Some(upstream)
        });
    }

    pub(crate) fn on_move_up(&mut self, _: &MoveUp, window: &mut Window, cx: &mut Context<Self>) {
        self.vertical(Vertical::Up, false, window, cx);
    }

    pub(crate) fn on_move_down(
        &mut self,
        _: &MoveDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.vertical(Vertical::Down, false, window, cx);
    }

    pub(crate) fn on_select_up(
        &mut self,
        _: &SelectUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.vertical(Vertical::Up, true, window, cx);
    }

    pub(crate) fn on_select_down(
        &mut self,
        _: &SelectDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.vertical(Vertical::Down, true, window, cx);
    }

    fn page(
        &mut self,
        direction: Vertical,
        extend: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (viewport, line) = {
            let store = self.store.borrow();
            let viewport = store
                .geometry
                .map_or(600., |g| f32::from(g.bounds.size.height));
            (
                viewport,
                f32::from(self.theme.body_size) * self.theme.body_line_height,
            )
        };
        let rows = ((viewport - line * 2.) / line).max(1.) as isize;
        let delta = if direction == Vertical::Up {
            -rows
        } else {
            rows
        };
        let from = self.editor.selection().head;
        let (target, upstream, goal) = self.vertical_target(from, self.upstream, delta, window);
        {
            let mut store = self.store.borrow_mut();
            let shift = if direction == Vertical::Up {
                -(viewport - line * 2.)
            } else {
                viewport - line * 2.
            };
            let y = store.scroll_y() + shift;
            store.set_scroll_y(y);
        }
        self.motion(cx, true, |this| {
            this.editor.extend_or_move(target, extend);
            this.goal_x = Some(goal);
            Some(upstream)
        });
    }

    pub(crate) fn on_page_up(&mut self, _: &PageUp, window: &mut Window, cx: &mut Context<Self>) {
        self.page(Vertical::Up, false, window, cx);
    }

    pub(crate) fn on_page_down(
        &mut self,
        _: &PageDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.page(Vertical::Down, false, window, cx);
    }

    pub(crate) fn on_select_page_up(
        &mut self,
        _: &SelectPageUp,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.page(Vertical::Up, true, window, cx);
    }

    pub(crate) fn on_select_page_down(
        &mut self,
        _: &SelectPageDown,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.page(Vertical::Down, true, window, cx);
    }

    pub(crate) fn on_scroll_to_start(
        &mut self,
        _: &ScrollToStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.store.borrow_mut().set_scroll_y(0.);
        self.note_scroll(cx);
    }

    pub(crate) fn on_scroll_to_end(
        &mut self,
        _: &ScrollToEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        {
            let mut store = self.store.borrow_mut();
            let max = store.max_scroll();
            store.set_scroll_y(max);
            store.autoscroll = None;
        }
        self.note_scroll(cx);
    }

    pub(crate) fn menu_items(&self) -> Vec<MenuItem> {
        let Some(menu) = &self.menu else {
            return Vec::new();
        };
        let collapsed = self.editor.selection().is_collapsed();
        let mut items = Vec::new();
        if !self.read_only {
            items.push(MenuItem::Cut {
                enabled: !collapsed,
            });
        }
        items.push(MenuItem::Copy {
            enabled: !collapsed,
        });
        if !self.read_only {
            items.push(MenuItem::Paste);
        }
        items.push(MenuItem::SelectAll);
        if menu.link.is_some() {
            items.push(MenuItem::OpenLink);
            items.push(MenuItem::CopyLink);
            if !self.read_only {
                items.push(MenuItem::RemoveLink);
            }
        }
        items
    }

    pub(crate) fn run_menu_item(&mut self, index: usize, _: &mut Window, cx: &mut Context<Self>) {
        let items = self.menu_items();
        let link = self.menu.as_ref().and_then(|menu| menu.link.clone());
        self.menu = None;
        let Some(item) = items.get(index).copied() else {
            cx.notify();
            return;
        };
        match item {
            MenuItem::Cut { enabled: true } => {
                if self.copy_selection(cx) {
                    self.edit(cx, |editor| editor.delete_selection());
                }
            }
            MenuItem::Copy { enabled: true } => {
                self.copy_selection(cx);
            }
            MenuItem::Cut { .. } | MenuItem::Copy { .. } => {}
            MenuItem::Paste => self.paste_clipboard(false, cx),
            MenuItem::SelectAll => {
                let before = self.editor.selection();
                self.editor.select_all();
                self.after_motion(before, false, cx);
                self.store.borrow_mut().autoscroll = None;
            }
            MenuItem::OpenLink => {
                if let Some(link) = link {
                    cx.emit(crate::NotesEvent::OpenLink(link.url));
                }
            }
            MenuItem::CopyLink => {
                if let Some(link) = link {
                    cx.write_to_clipboard(ClipboardItem::new_string(link.url));
                }
            }
            MenuItem::RemoveLink => {
                if let Some(link) = link {
                    self.edit(cx, |editor| {
                        editor.set_selection(Selection::new(
                            Pos::new(link.block, link.range.start),
                            Pos::new(link.block, link.range.end),
                        ));
                        editor.set_link(None)
                    });
                }
            }
        }
        cx.notify();
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MenuItem {
    Cut { enabled: bool },
    Copy { enabled: bool },
    Paste,
    SelectAll,
    OpenLink,
    CopyLink,
    RemoveLink,
}

pub(crate) trait ExtendOrMove {
    fn extend_or_move(&mut self, pos: Pos, extend: bool);
}

impl ExtendOrMove for cap_notes::Editor {
    fn extend_or_move(&mut self, pos: Pos, extend: bool) {
        if extend {
            self.extend_to(pos);
        } else {
            self.set_selection(Selection::caret(pos));
        }
    }
}
