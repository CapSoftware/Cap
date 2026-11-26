use std::ops::Range;

use crate::actions::*;
use crate::layout::body_font;
use crate::text::{
    next_grapheme, offset_from_utf16, offset_to_utf16, prev_grapheme, word_end, word_start,
};
use crate::theme::NotesTheme;
use gpui::{
    App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId, ElementInputHandler,
    Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable, GlobalElementId, Hsla,
    IntoElement, LayoutId, MouseButton, MouseDownEvent, Pixels, Point, Render, ShapedLine,
    SharedString, Style, TextRun, UTF16Selection, UnderlineStyle, Window, div, fill, point,
    prelude::*, px, relative, size,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FieldEvent {
    Changed,
    Confirm,
    ConfirmBack,
    Cancel,
}

pub(crate) struct LineField {
    focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    placeholder: SharedString,
    theme: NotesTheme,
    line: Option<(String, Option<Range<usize>>, ShapedLine)>,
    bounds: Option<Bounds<Pixels>>,
    scroll_x: f32,
}

impl EventEmitter<FieldEvent> for LineField {}

impl LineField {
    pub fn new(
        text: &str,
        placeholder: SharedString,
        theme: NotesTheme,
        cx: &mut Context<Self>,
    ) -> Self {
        Self {
            focus: cx.focus_handle(),
            text: text.to_string(),
            selection: 0..text.len(),
            reversed: false,
            marked: None,
            placeholder,
            theme,
            line: None,
            bounds: None,
            scroll_x: 0.,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn set_theme(&mut self, theme: NotesTheme) {
        self.theme = theme;
        self.line = None;
    }

    pub fn replace_all_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.text = text.replace(['\n', '\r'], " ");
        self.selection = 0..self.text.len();
        self.reversed = false;
        self.marked = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    pub fn select_all(&mut self, cx: &mut Context<Self>) {
        self.selection = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    fn head(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selection = offset..offset;
        self.reversed = false;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let anchor = if self.reversed {
            self.selection.end
        } else {
            self.selection.start
        };
        self.reversed = offset < anchor;
        self.selection = offset.min(anchor)..offset.max(anchor);
        cx.notify();
    }

    fn replace(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        let text = text.replace(['\n', '\r'], " ");
        let start = range.start.min(self.text.len());
        let end = range.end.clamp(start, self.text.len());
        self.text.replace_range(start..end, &text);
        let caret = start + text.len();
        self.selection = caret..caret;
        self.reversed = false;
        self.marked = None;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    fn delete_or(&mut self, range: Range<usize>, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            self.replace(self.selection.clone(), "", cx);
        } else if !range.is_empty() {
            self.replace(range, "", cx);
        }
    }

    fn on_backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        let head = self.head();
        self.delete_or(prev_grapheme(&self.text, head)..head, cx);
    }

    fn on_delete(&mut self, _: &DeleteForward, _: &mut Window, cx: &mut Context<Self>) {
        let head = self.head();
        self.delete_or(head..next_grapheme(&self.text, head), cx);
    }

    fn on_delete_word(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let head = self.head();
        self.delete_or(word_start(&self.text, head)..head, cx);
    }

    fn on_delete_line(&mut self, _: &DeleteToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        let head = self.head();
        self.delete_or(0..head, cx);
    }

    fn on_left(&mut self, _: &MoveLeft, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selection.is_empty() {
            prev_grapheme(&self.text, self.head())
        } else {
            self.selection.start
        };
        self.move_to(target, cx);
    }

    fn on_right(&mut self, _: &MoveRight, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.selection.is_empty() {
            next_grapheme(&self.text, self.head())
        } else {
            self.selection.end
        };
        self.move_to(target, cx);
    }

    fn on_word_left(&mut self, _: &MoveWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(word_start(&self.text, self.head()), cx);
    }

    fn on_word_right(&mut self, _: &MoveWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(word_end(&self.text, self.head()), cx);
    }

    fn on_home(&mut self, _: &MoveToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn on_end(&mut self, _: &MoveToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }

    fn on_select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(prev_grapheme(&self.text, self.head()), cx);
    }

    fn on_select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_grapheme(&self.text, self.head()), cx);
    }

    fn on_select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(word_start(&self.text, self.head()), cx);
    }

    fn on_select_word_right(
        &mut self,
        _: &SelectWordRight,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.select_to(word_end(&self.text, self.head()), cx);
    }

    fn on_select_home(&mut self, _: &SelectToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn on_select_end(&mut self, _: &SelectToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn on_select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_all(cx);
    }

    fn on_copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selection.clone()].to_string(),
            ));
        }
    }

    fn on_cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(
                self.text[self.selection.clone()].to_string(),
            ));
            self.replace(self.selection.clone(), "", cx);
        }
    }

    fn on_paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.replace(self.selection.clone(), text.trim(), cx);
        }
    }

    fn on_confirm(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Confirm);
    }

    fn on_next(&mut self, _: &FindNext, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Confirm);
    }

    fn on_previous(&mut self, _: &FindPrevious, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::ConfirmBack);
    }

    fn on_cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(FieldEvent::Cancel);
    }

    fn on_palette(&mut self, _: &ShowCharacterPalette, window: &mut Window, _: &mut Context<Self>) {
        window.show_character_palette();
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let offset = self.offset_at(event.position);
        if event.click_count >= 2 {
            self.selection = 0..self.text.len();
            self.reversed = false;
            cx.notify();
        } else if event.modifiers.shift {
            self.select_to(offset, cx);
        } else {
            self.move_to(offset, cx);
        }
    }

    fn offset_at(&self, position: Point<Pixels>) -> usize {
        let (Some(bounds), Some((_, _, line))) = (self.bounds, self.line.as_ref()) else {
            return self.text.len();
        };
        let x = f32::from(position.x - bounds.left()) + self.scroll_x;
        let virtual_offset = line.closest_index_for_x(px(x));
        self.to_real(virtual_offset)
    }

    fn to_real(&self, offset: usize) -> usize {
        offset.min(self.text.len())
    }
}

impl Focusable for LineField {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for LineField {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .key_context(FIELD_CONTEXT)
            .track_focus(&self.focus)
            .flex_1()
            .min_w_0()
            .h(px(20.))
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::on_backspace))
            .on_action(cx.listener(Self::on_delete))
            .on_action(cx.listener(Self::on_delete_word))
            .on_action(cx.listener(Self::on_delete_line))
            .on_action(cx.listener(Self::on_left))
            .on_action(cx.listener(Self::on_right))
            .on_action(cx.listener(Self::on_word_left))
            .on_action(cx.listener(Self::on_word_right))
            .on_action(cx.listener(Self::on_home))
            .on_action(cx.listener(Self::on_end))
            .on_action(cx.listener(Self::on_select_left))
            .on_action(cx.listener(Self::on_select_right))
            .on_action(cx.listener(Self::on_select_word_left))
            .on_action(cx.listener(Self::on_select_word_right))
            .on_action(cx.listener(Self::on_select_home))
            .on_action(cx.listener(Self::on_select_end))
            .on_action(cx.listener(Self::on_select_all))
            .on_action(cx.listener(Self::on_copy))
            .on_action(cx.listener(Self::on_cut))
            .on_action(cx.listener(Self::on_paste))
            .on_action(cx.listener(Self::on_confirm))
            .on_action(cx.listener(Self::on_next))
            .on_action(cx.listener(Self::on_previous))
            .on_action(cx.listener(Self::on_cancel))
            .on_action(cx.listener(Self::on_palette))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .child(FieldText { field: cx.entity() })
    }
}

struct FieldText {
    field: Entity<LineField>,
}

impl IntoElement for FieldText {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

struct FieldPrepaint {
    line: Option<ShapedLine>,
    placeholder: bool,
    selection: Option<Bounds<Pixels>>,
    caret: Option<Bounds<Pixels>>,
    caret_color: Hsla,
    selection_color: Hsla,
    line_height: Pixels,
}

impl Element for FieldText {
    type RequestLayoutState = ();
    type PrepaintState = FieldPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = relative(1.).into();
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> FieldPrepaint {
        let focused = self.field.read(cx).focus.is_focused(window);
        self.field.update(cx, |field, _| {
            field.bounds = Some(bounds);
            let theme = &field.theme;
            let font_size = theme.ui_size;
            let placeholder = field.text.is_empty() && field.marked.is_none();
            let shown: String = if placeholder {
                field.placeholder.to_string()
            } else {
                field.text.clone()
            };
            let stale = field
                .line
                .as_ref()
                .is_none_or(|(text, marked, _)| *text != shown || *marked != field.marked);
            if stale {
                let color = if placeholder {
                    theme.ink_tertiary
                } else {
                    theme.ink
                };
                let font = body_font(theme, gpui::FontWeight::NORMAL, false);
                let base = TextRun {
                    len: shown.len(),
                    font,
                    color,
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                let runs: Vec<TextRun> = match field.marked.clone() {
                    Some(marked) if !placeholder && marked.end <= shown.len() => [
                        TextRun {
                            len: marked.start,
                            ..base.clone()
                        },
                        TextRun {
                            len: marked.len(),
                            underline: Some(UnderlineStyle {
                                thickness: px(1.),
                                color: Some(color),
                                wavy: false,
                            }),
                            ..base.clone()
                        },
                        TextRun {
                            len: shown.len() - marked.end,
                            ..base
                        },
                    ]
                    .into_iter()
                    .filter(|run| run.len > 0)
                    .collect(),
                    _ => vec![base],
                };
                let line =
                    window
                        .text_system()
                        .shape_line(shown.clone().into(), font_size, &runs, None);
                field.line = Some((shown, field.marked.clone(), line));
            }
            let line_height = bounds.size.height;
            let Some((_, _, line)) = field.line.as_ref() else {
                return FieldPrepaint {
                    line: None,
                    placeholder,
                    selection: None,
                    caret: None,
                    caret_color: theme.accent,
                    selection_color: theme.selection,
                    line_height,
                };
            };
            let x_of = |offset: usize| f32::from(line.x_for_index(offset));
            let head = if placeholder { 0 } else { field.head() };
            let caret_x = x_of(head);
            let width = f32::from(bounds.size.width);
            let max_scroll = (f32::from(line.width()) - width + 2.).max(0.);
            let mut scroll = field.scroll_x.clamp(0., max_scroll);
            if caret_x - scroll < 0. {
                scroll = caret_x;
            } else if caret_x - scroll > width - 2. {
                scroll = caret_x - width + 2.;
            }
            field.scroll_x = scroll;
            let left = f32::from(bounds.left()) - scroll;
            let selection = (!field.selection.is_empty() && !placeholder).then(|| {
                Bounds::from_corners(
                    point(
                        px(left + x_of(field.selection.start)),
                        bounds.top() + px(1.),
                    ),
                    point(
                        px(left + x_of(field.selection.end)),
                        bounds.bottom() - px(1.),
                    ),
                )
            });
            let caret = (focused && field.selection.is_empty()).then(|| {
                Bounds::new(
                    point(px(left + caret_x), bounds.top() + px(2.)),
                    size(px(1.5), bounds.size.height - px(4.)),
                )
            });
            FieldPrepaint {
                line: Some(line.clone()),
                placeholder,
                selection,
                caret,
                caret_color: theme.accent,
                selection_color: theme.selection,
                line_height,
            }
        })
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut FieldPrepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.field.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.field.clone()),
            cx,
        );
        let scroll = self.field.read(cx).scroll_x;
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            if let Some(selection) = prepaint.selection {
                window.paint_quad(fill(selection, prepaint.selection_color));
            }
            if let Some(line) = prepaint.line.as_ref() {
                let x = if prepaint.placeholder {
                    bounds.left()
                } else {
                    bounds.left() - px(scroll)
                };
                line.paint(
                    point(x, bounds.top()),
                    prepaint.line_height,
                    gpui::TextAlign::Left,
                    None,
                    window,
                    cx,
                )
                .ok();
            }
            if let Some(caret) = prepaint.caret {
                window.paint_quad(fill(caret, prepaint.caret_color));
            }
        });
    }
}

impl EntityInputHandler for LineField {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let start = offset_from_utf16(&self.text, range.start);
        let end = offset_from_utf16(&self.text, range.end).max(start);
        adjusted.replace(offset_to_utf16(&self.text, start)..offset_to_utf16(&self.text, end));
        self.text.get(start..end).map(str::to_string)
    }

    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: offset_to_utf16(&self.text, self.selection.start)
                ..offset_to_utf16(&self.text, self.selection.end),
            reversed: self.reversed,
        })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| {
            offset_to_utf16(&self.text, range.start)..offset_to_utf16(&self.text, range.end)
        })
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| offset_from_utf16(&self.text, r.start)..offset_from_utf16(&self.text, r.end))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        self.replace(range, text, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range
            .map(|r| offset_from_utf16(&self.text, r.start)..offset_from_utf16(&self.text, r.end))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        let start = range.start.min(self.text.len());
        let end = range.end.clamp(start, self.text.len());
        self.text.replace_range(start..end, text);
        self.marked = (!text.is_empty()).then(|| start..start + text.len());
        let caret = selected
            .map(|r| start + offset_from_utf16(text, r.end))
            .unwrap_or(start + text.len());
        self.selection = caret..caret;
        self.reversed = false;
        cx.emit(FieldEvent::Changed);
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let (_, _, line) = self.line.as_ref()?;
        let start = offset_from_utf16(&self.text, range.start);
        let end = offset_from_utf16(&self.text, range.end);
        let left = element_bounds.left() - px(self.scroll_x);
        Some(Bounds::from_corners(
            point(left + line.x_for_index(start), element_bounds.top()),
            point(left + line.x_for_index(end), element_bounds.bottom()),
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        Some(offset_to_utf16(&self.text, self.offset_at(position)))
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(offset_to_utf16(&self.text, self.text.len()))
    }
}
