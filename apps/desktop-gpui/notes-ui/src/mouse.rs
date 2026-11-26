use cap_notes::{BlockKind, LinkAt, Pos, Selection, word_range_at};
use gpui::{
    Context, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point,
    ScrollWheelEvent, Window, px,
};

use crate::editor::{ContextMenu, Drag, DragUnit, NotesEditor, NotesEvent};
use crate::layout;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Hit {
    pub pos: Pos,
    pub upstream: bool,
    pub checkbox: Option<usize>,
    pub link: Option<LinkAt>,
}

pub(crate) const SCROLLBAR_HIT: f32 = 12.;

impl NotesEditor {
    pub(crate) fn hit_test(&mut self, position: Point<Pixels>, window: &mut Window) -> Hit {
        let Some(geometry) = self.store.borrow().geometry else {
            return Hit::default();
        };
        let blocks = self.editor.document().blocks.len();
        if blocks == 0 {
            return Hit::default();
        }
        let (scroll, top_padding, total) = {
            let store = self.store.borrow();
            (store.scroll_y(), store.top_padding(), store.heights.total())
        };
        let y = f32::from(position.y - geometry.bounds.top()) + scroll;
        let (index, local_y) = if y < top_padding {
            (0, f32::MIN)
        } else if y - top_padding >= total {
            (blocks - 1, f32::MAX)
        } else {
            let (index, offset) = self.store.borrow().heights.find(y - top_padding);
            let gap = self
                .store
                .borrow()
                .gap_of(self.editor.document(), index, &self.theme);
            if offset < gap {
                if index > 0 && offset < gap / 2. {
                    (index - 1, f32::MAX)
                } else {
                    (index, f32::MIN)
                }
            } else {
                (index, offset - gap)
            }
        };
        let block = &self.editor.document().blocks[index];
        let m = layout::metrics(block, &self.theme);
        let text_left = geometry.column_left + m.inset;
        let x = f32::from(position.x) - text_left;
        let is_task = matches!(block.kind, BlockKind::Task { .. });
        let theme_checkbox = f32::from(self.theme.checkbox_size);
        let result = self.with_layout(index, window, |layout| {
            let text_y = local_y - m.pad_top;
            let (virtual_offset, upstream) =
                layout.hit(x, text_y.clamp(-1., layout.text_height() + 1.));
            let real = layout.to_real(virtual_offset);
            let row_index = if text_y <= 0. {
                0
            } else {
                ((text_y / m.line_height) as usize).min(layout.rows.len().saturating_sub(1))
            };
            let on_row = layout
                .rows
                .get(row_index)
                .is_some_and(|row| x >= -2. && x <= row.width + 2.)
                && text_y >= 0.
                && text_y <= layout.text_height();
            let checkbox = is_task.then(|| {
                let baseline = layout.baseline(0);
                let center = baseline - layout.cap_height / 2.;
                let left = -f32::from(self.theme.list_indent);
                let slop = 4.;
                x >= left - slop
                    && x <= left + theme_checkbox + slop
                    && (text_y - center).abs() <= theme_checkbox / 2. + slop
            });
            (real, upstream, on_row, checkbox.unwrap_or(false))
        });
        let Some((offset, upstream, on_row, on_checkbox)) = result else {
            return Hit::default();
        };
        let pos = Pos::new(index, offset);
        let link = on_row.then(|| self.editor.link_at(pos)).flatten();
        Hit {
            pos,
            upstream,
            checkbox: on_checkbox.then_some(index),
            link,
        }
    }

    pub(crate) fn mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
        if self.composition.is_some() {
            self.commit_composition(window, cx);
        }
        self.menu = None;
        self.link_edit = None;
        if self.on_scrollbar(event.position) && event.button == MouseButton::Left {
            self.start_scrollbar_drag(event.position, cx);
            return;
        }
        if event.button == MouseButton::Left
            && event.click_count <= 1
            && !event.modifiers.shift
            && !event.modifiers.secondary()
        {
            let source = self
                .store
                .borrow()
                .source_hits
                .iter()
                .find(|(bounds, _, label)| *label && bounds.contains(&event.position))
                .and_then(|(_, mark, _)| self.sources.get(*mark))
                .map(|mark| mark.key);
            if let Some(key) = source {
                cx.emit(NotesEvent::SourceClicked(key));
                return;
            }
            let person = self
                .store
                .borrow()
                .pills
                .iter()
                .find(|(bounds, _)| bounds.contains(&event.position))
                .map(|(_, name)| name.clone());
            if let Some(name) = person {
                cx.emit(NotesEvent::PersonClicked {
                    name,
                    at: event.position,
                });
                return;
            }
        }
        let hit = self.hit_test(event.position, window);
        let before = self.editor.selection();
        match event.button {
            MouseButton::Left => {
                if let Some(index) = hit.checkbox {
                    if !self.read_only {
                        self.toggle_checkbox_at(index, cx);
                    }
                    return;
                }
                if let Some(link) = &hit.link
                    && (self.read_only || event.modifiers.secondary())
                {
                    cx.emit(NotesEvent::OpenLink(link.url.clone()));
                    return;
                }
                self.goal_x = None;
                let drag = match event.click_count {
                    0 | 1 => {
                        if event.modifiers.shift {
                            self.editor.extend_to(hit.pos);
                            let anchor = self.editor.selection().anchor;
                            Drag {
                                unit: DragUnit::Char,
                                anchor: (anchor, anchor),
                            }
                        } else {
                            self.editor.set_selection(Selection::caret(hit.pos));
                            self.upstream = hit.upstream;
                            Drag {
                                unit: DragUnit::Char,
                                anchor: (hit.pos, hit.pos),
                            }
                        }
                    }
                    2 => {
                        self.editor.select_word_at(hit.pos);
                        let selection = self.editor.selection();
                        Drag {
                            unit: DragUnit::Word,
                            anchor: (selection.start(), selection.end()),
                        }
                    }
                    _ => {
                        self.editor.select_block_at(hit.pos);
                        let selection = self.editor.selection();
                        Drag {
                            unit: DragUnit::Block,
                            anchor: (selection.start(), selection.end()),
                        }
                    }
                };
                self.drag = Some(drag);
                self.store.borrow_mut().drag_point = Some(event.position);
                self.after_motion(before, false, cx);
                self.store.borrow_mut().autoscroll = None;
            }
            MouseButton::Right => {
                let selection = self.editor.selection();
                let inside = !selection.is_collapsed()
                    && selection.start() <= hit.pos
                    && hit.pos <= selection.end();
                if !inside {
                    self.editor.set_selection(Selection::caret(hit.pos));
                    self.after_motion(before, false, cx);
                    self.store.borrow_mut().autoscroll = None;
                }
                let serial = self.next_serial();
                self.toolbar_visible = false;
                self.menu = Some(ContextMenu {
                    position: event.position,
                    link: hit.link,
                    selected: None,
                    serial,
                });
                cx.notify();
            }
            _ => {}
        }
    }

    pub(crate) fn extend_drag(&mut self, position: Point<Pixels>, window: &mut Window) -> bool {
        let Some(drag) = self.drag else {
            return false;
        };
        let bounds = match self.store.borrow().geometry {
            Some(geometry) => geometry.bounds,
            None => return false,
        };
        let clamped = Point {
            x: position.x,
            y: position
                .y
                .clamp(bounds.top() + px(1.), bounds.bottom() - px(1.)),
        };
        let hit = self.hit_test(clamped, window);
        let doc = self.editor.document();
        let selection = match drag.unit {
            DragUnit::Char => Selection::new(drag.anchor.0, hit.pos),
            DragUnit::Word | DragUnit::Block => {
                let text = &doc.blocks[hit.pos.block].text;
                let range = if drag.unit == DragUnit::Word {
                    word_range_at(text, hit.pos.offset)
                } else {
                    0..text.len()
                };
                let (start, end) = (
                    Pos::new(hit.pos.block, range.start),
                    Pos::new(hit.pos.block, range.end),
                );
                if start < drag.anchor.0 {
                    Selection::new(drag.anchor.1, start)
                } else {
                    Selection::new(drag.anchor.0, end.max(drag.anchor.1))
                }
            }
        };
        let changed = selection != self.editor.selection();
        self.editor.set_selection(selection);
        if drag.unit == DragUnit::Char && selection.is_collapsed() {
            self.upstream = hit.upstream;
        }
        changed
    }

    pub(crate) fn mouse_move(
        &mut self,
        event: &MouseMoveEvent,
        hovered: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.store.borrow().scrollbar_drag.is_some() {
            if event.pressed_button == Some(MouseButton::Left) {
                self.drag_scrollbar(event.position, cx);
            } else {
                self.store.borrow_mut().scrollbar_drag = None;
            }
            return;
        }
        if self.drag.is_some() {
            if event.pressed_button != Some(MouseButton::Left) {
                self.finish_drag(cx);
                return;
            }
            self.store.borrow_mut().drag_point = Some(event.position);
            let before = self.editor.selection();
            if self.extend_drag(event.position, window) {
                if self.editor.selection() != before {
                    cx.emit(NotesEvent::SelectionChanged);
                }
                self.caret_epoch = std::time::Instant::now();
                cx.notify();
            } else {
                cx.notify();
            }
            return;
        }
        let over_scrollbar = hovered && self.on_scrollbar(event.position);
        self.hover_source(
            (hovered && !over_scrollbar).then_some(event.position),
            cx,
        );
        let (link, checkbox) = if hovered && !over_scrollbar {
            let hit = self.hit_test(event.position, window);
            (hit.link, hit.checkbox)
        } else {
            (None, None)
        };
        let link_changed = link != self.hover.link;
        if link_changed || checkbox != self.hover.checkbox || over_scrollbar != self.hover.scrollbar
        {
            self.hover.link = link;
            self.hover.checkbox = checkbox;
            self.hover.scrollbar = over_scrollbar;
            if link_changed {
                self.schedule_tooltip(cx);
            }
            cx.notify();
        }
    }

    /// Keep track of the sourced point under the pointer and tell the host
    /// when it changes.
    fn hover_source(&mut self, at: Option<Point<Pixels>>, cx: &mut Context<Self>) {
        let found = at.and_then(|at| {
            let store = self.store.borrow();
            let label = store
                .source_hits
                .iter()
                .find(|(bounds, _, label)| *label && bounds.contains(&at));
            label
                .or_else(|| store.source_hits.iter().find(|(b, _, _)| b.contains(&at)))
                .map(|(_, mark, label)| (*mark, *label))
        });
        let before = self.source_hover.map(|h| (h.mark, h.on_label));
        if found == before {
            return;
        }
        let key = |mark: Option<usize>| mark.and_then(|m| self.sources.get(m)).map(|s| s.key);
        let old_key = key(before.map(|(m, _)| m));
        let new_key = key(found.map(|(m, _)| m));
        let since = match (self.source_hover, found) {
            (Some(h), Some((mark, _))) if h.mark == mark => h.since,
            _ => std::time::Instant::now(),
        };
        self.source_hover = found.map(|(mark, on_label)| crate::editor::SourceHover {
            mark,
            on_label,
            since,
        });
        if old_key != new_key {
            cx.emit(NotesEvent::SourceHovered(new_key));
        }
        cx.notify();
    }

    fn finish_drag(&mut self, cx: &mut Context<Self>) {
        self.drag = None;
        self.store.borrow_mut().drag_point = None;
        if !self.editor.selection().is_collapsed() && !self.read_only {
            self.show_toolbar(cx);
        }
        cx.notify();
    }

    pub(crate) fn mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.store.borrow_mut().scrollbar_drag.take().is_some() {
            cx.notify();
            return;
        }
        if self.drag.is_some() {
            self.finish_drag(cx);
        }
    }

    pub(crate) fn scroll_wheel(
        &mut self,
        event: &ScrollWheelEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let line = px(f32::from(self.theme.body_size) * self.theme.body_line_height);
        let delta = event.delta.pixel_delta(line);
        {
            let mut store = self.store.borrow_mut();
            let y = store.scroll_y() - f32::from(delta.y);
            store.set_scroll_y(y);
            store.autoscroll = None;
        }
        let point = self.store.borrow().drag_point;
        if self.drag.is_some()
            && let Some(point) = point
        {
            self.extend_drag(point, window);
        }
        self.hover.tooltip = false;
        self.note_scroll(cx);
    }

    pub(crate) fn scrollbar_metrics(&self) -> Option<(f32, f32, f32, f32)> {
        let store = self.store.borrow();
        let geometry = store.geometry?;
        let viewport = f32::from(geometry.bounds.size.height);
        let content = store.content_height();
        if content <= viewport + 1. {
            return None;
        }
        let track_top = f32::from(geometry.bounds.top()) + 3.;
        let track = viewport - 6.;
        let thumb = (viewport / content * track).max(28.).min(track);
        let max = store.max_scroll().max(1.);
        let top = track_top + (store.scroll_y() / max).clamp(0., 1.) * (track - thumb);
        let x = f32::from(geometry.bounds.right()) - 9.;
        Some((x, top, thumb, track))
    }

    pub(crate) fn on_scrollbar(&self, position: Point<Pixels>) -> bool {
        let Some(geometry) = self.store.borrow().geometry else {
            return false;
        };
        self.scrollbar_metrics().is_some()
            && f32::from(geometry.bounds.right() - position.x) <= SCROLLBAR_HIT
    }

    fn start_scrollbar_drag(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some((_, top, thumb, _)) = self.scrollbar_metrics() else {
            return;
        };
        let y = f32::from(position.y);
        let grab = if y >= top && y <= top + thumb {
            y - top
        } else {
            thumb / 2.
        };
        self.store.borrow_mut().scrollbar_drag = Some(grab);
        self.drag_scrollbar(position, cx);
    }

    fn drag_scrollbar(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some((_, _, thumb, track)) = self.scrollbar_metrics() else {
            return;
        };
        {
            let mut store = self.store.borrow_mut();
            let Some(grab) = store.scrollbar_drag else {
                return;
            };
            let Some(geometry) = store.geometry else {
                return;
            };
            let track_top = f32::from(geometry.bounds.top()) + 3.;
            let fraction = ((f32::from(position.y) - grab - track_top) / (track - thumb).max(1.))
                .clamp(0., 1.);
            let max = store.max_scroll();
            store.set_scroll_y(fraction * max);
            store.autoscroll = None;
        }
        self.note_scroll(cx);
    }
}
