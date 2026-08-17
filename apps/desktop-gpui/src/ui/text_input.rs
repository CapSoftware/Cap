//! A real text input.
//!
//! Every field in this app used to be the same append-only stand-in: focus
//! tracking, `key_char` for the typed character, a static caret drawn at the
//! end of the string, and `Backspace` popping the last one. No caret movement,
//! no selection, no clipboard, no click-to-position. That was the single
//! blocker in front of the editor's text/caption panels, the project rename and
//! the sidebar's hex fields, and it made every field the app already had worse
//! than the `<input>` it was transcribed from.
//!
//! ## The architecture: gpui's own input-handler protocol
//!
//! gpui *does* ship the seam a text editor needs -- it is just not a widget.
//! [`gpui::EntityInputHandler`] is the trait the platform's IME talks to, and
//! [`gpui::ElementInputHandler`] adapts an `Entity<V>` implementing it into the
//! `PlatformInputHandler` that `Window::handle_input` installs during paint
//! (`gpui/src/input.rs:10-96`). On macOS that is `NSTextInputClient`: marked
//! text, dead keys, dictation and the character palette all arrive through
//! `replace_and_mark_text_in_range` / `replace_text_in_range` rather than
//! through `key_char`. gpui's own `examples/input.rs` is the reference
//! implementation and this component is built on the same three pieces
//! (`EntityInputHandler` + a custom `Element` + `window.handle_input`), with
//! wrapping, word/line motion, undo and the app's theming added.
//!
//! **The dispatch order on macOS is the thing to understand before touching
//! any of this** (`gpui_macos/src/window.rs:2143-2250`):
//!
//! 1. A key press runs gpui's own dispatch first -- key *bindings* are matched
//!    against the focused node's context stack, and a matching action is
//!    dispatched and consumes the event (`gpui/src/window.rs:5280-5296`
//!    returns before `finish_dispatch_key_event`, so no `on_key_down` listener
//!    anywhere on the path ever sees it).
//! 2. Only if nothing handled the event does AppKit hand it to the input
//!    context, which composes it and calls back into
//!    `replace_text_in_range` -- the text actually being typed.
//!
//! Two consequences shape the whole design:
//!
//! - **Every chord is a bound action in the `TextInput` key context.**
//!   Backspace, the arrows, `cmd-a`, `cmd-c/x/v`, `cmd-z` and the rest are
//!   [`bind_keys`]'s bindings, scoped to `TextInput`. Because a matched binding
//!   consumes the keystroke, a focused field *structurally* prevents the
//!   editor's Backspace-deletes-the-selection and Cmd-Z-undoes-the-project
//!   handlers from firing. That is the key-context discipline, and it is a
//!   mechanism rather than a check.
//! - **A bare printable key can never be bound**, because a binding would
//!   consume it at step 1 and the IME at step 2 would never run -- the field
//!   would type nothing. So `s`, `c` and `space` still reach an ancestor's
//!   `on_key_down`, and the ancestor has to ask whether a field has focus.
//!   That is exactly what the Tauri app does: `useEditorShortcuts`' scope gate
//!   is `document.activeElement` being an `input`/`textarea`/contenteditable
//!   (`apps/desktop/src/routes/editor/Player.tsx:236-245`), and the timeline's
//!   own listener repeats it (`Timeline/index.tsx:960-966`).
//!   [`text_input_has_focus`] is that gate, transcribed.
//!
//! ## One state machine, one element, two shapes
//!
//! [`TextInputState`] is the whole editing model and is window-agnostic; it
//! emits [`TextInputEvent`]s and the owning window decides what a commit means.
//! [`TextInput`] is the element, with the same per-surface constructors the
//! rest of `ui/` uses. `multi_line` switches three things and nothing else:
//! Return inserts a newline instead of committing, the text wraps to the
//! element's width, and the element measures its own height.

use std::{cell::RefCell, ops::Range, rc::Rc};

use gpui::{
    App, Bounds, ClipboardItem, Context, Element, ElementId,
    ElementInputHandler, Entity, EntityInputHandler, EventEmitter, FocusHandle, Focusable,
    FontWeight, GlobalElementId, Hsla, InteractiveElement, IntoElement, KeyBinding, LayoutId,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Pixels, Point,
    RenderOnce, SharedString, Size, Style, Styled, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, WeakEntity, Window, WrappedLine, actions, div, fill, point, prelude::*, px,
    relative, size, svg,
};
use smallvec::SmallVec;
use unicode_segmentation::UnicodeSegmentation;

use crate::theme::Theme;

// -- Actions and key bindings -------------------------------------------------

actions!(
    cap_text_input,
    [
        /// Delete backwards one grapheme, or the selection.
        Backspace,
        /// Delete forwards one grapheme, or the selection.
        DeleteForward,
        /// `alt-backspace`.
        DeleteWordLeft,
        /// `alt-delete`.
        DeleteWordRight,
        /// `cmd-backspace`.
        DeleteToLineStart,
        /// `cmd-delete`.
        DeleteToLineEnd,
        MoveLeft,
        MoveRight,
        MoveUp,
        MoveDown,
        MoveWordLeft,
        MoveWordRight,
        MoveToLineStart,
        MoveToLineEnd,
        MoveToStart,
        MoveToEnd,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectWordLeft,
        SelectWordRight,
        SelectToLineStart,
        SelectToLineEnd,
        SelectToStart,
        SelectToEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        /// Return: a newline in a multi-line field, a commit in a single-line one.
        Confirm,
        /// Escape: the owner decides what reverting means.
        Cancel,
        ShowCharacterPalette,
    ]
);

/// The key context every text input carries. Bindings scoped to it are matched
/// at the field's own node, which is deeper than any window root, so they win
/// and consume the keystroke before an ancestor's `on_key_down` runs.
pub const KEY_CONTEXT: &str = "TextInput";

/// Register the field's bindings. Called once from `main`.
///
/// Nothing here is a bare printable key -- see the module docs: a binding is
/// matched *before* the IME composes the character, so binding `a` would mean
/// the letter `a` could never be typed.
pub fn bind_keys(cx: &mut App) {
    let ctx = Some(KEY_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("backspace", Backspace, ctx),
        KeyBinding::new("delete", DeleteForward, ctx),
        KeyBinding::new("alt-backspace", DeleteWordLeft, ctx),
        KeyBinding::new("alt-delete", DeleteWordRight, ctx),
        KeyBinding::new("cmd-backspace", DeleteToLineStart, ctx),
        KeyBinding::new("cmd-delete", DeleteToLineEnd, ctx),
        KeyBinding::new("left", MoveLeft, ctx),
        KeyBinding::new("right", MoveRight, ctx),
        KeyBinding::new("up", MoveUp, ctx),
        KeyBinding::new("down", MoveDown, ctx),
        KeyBinding::new("alt-left", MoveWordLeft, ctx),
        KeyBinding::new("alt-right", MoveWordRight, ctx),
        KeyBinding::new("cmd-left", MoveToLineStart, ctx),
        KeyBinding::new("cmd-right", MoveToLineEnd, ctx),
        KeyBinding::new("home", MoveToLineStart, ctx),
        KeyBinding::new("end", MoveToLineEnd, ctx),
        KeyBinding::new("cmd-up", MoveToStart, ctx),
        KeyBinding::new("cmd-down", MoveToEnd, ctx),
        KeyBinding::new("shift-left", SelectLeft, ctx),
        KeyBinding::new("shift-right", SelectRight, ctx),
        KeyBinding::new("shift-up", SelectUp, ctx),
        KeyBinding::new("shift-down", SelectDown, ctx),
        KeyBinding::new("alt-shift-left", SelectWordLeft, ctx),
        KeyBinding::new("alt-shift-right", SelectWordRight, ctx),
        KeyBinding::new("cmd-shift-left", SelectToLineStart, ctx),
        KeyBinding::new("cmd-shift-right", SelectToLineEnd, ctx),
        KeyBinding::new("shift-home", SelectToLineStart, ctx),
        KeyBinding::new("shift-end", SelectToLineEnd, ctx),
        KeyBinding::new("cmd-shift-up", SelectToStart, ctx),
        KeyBinding::new("cmd-shift-down", SelectToEnd, ctx),
        KeyBinding::new("cmd-a", SelectAll, ctx),
        KeyBinding::new("cmd-c", Copy, ctx),
        KeyBinding::new("cmd-x", Cut, ctx),
        KeyBinding::new("cmd-v", Paste, ctx),
        KeyBinding::new("cmd-z", Undo, ctx),
        KeyBinding::new("cmd-shift-z", Redo, ctx),
        KeyBinding::new("cmd-y", Redo, ctx),
        KeyBinding::new("enter", Confirm, ctx),
        KeyBinding::new("escape", Cancel, ctx),
        KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, ctx),
    ]);
}

// -- The focus gate for bare printable keys -----------------------------------

/// Every live [`TextInputState`], weakly. Registered on construction and
/// pruned when the entity goes.
#[derive(Default)]
struct LiveInputs(RefCell<Vec<WeakEntity<TextInputState>>>);

impl gpui::Global for LiveInputs {}

/// Does any text input in this window currently hold focus?
///
/// This is `getScopeActive()` inverted (`Player.tsx:236-245`): the shipping app
/// suppresses its editor shortcuts while `document.activeElement` is an
/// `input`, a `textarea` or a contenteditable, and so does every window here
/// that handles bare printable keys in an `on_key_down` listener. Chords do not
/// need it -- their bindings are scoped to the [`KEY_CONTEXT`] and consume the
/// keystroke outright -- but a bare `s` cannot be bound at all without breaking
/// typing, so it is checked instead.
pub fn text_input_has_focus(window: &Window, cx: &App) -> bool {
    let Some(live) = cx.try_global::<LiveInputs>() else {
        return false;
    };
    let inputs = live.0.borrow();
    inputs.iter().any(|weak| {
        weak.upgrade()
            .is_some_and(|entity| entity.read(cx).focus.is_focused(window))
    })
}

fn register_live_input(weak: WeakEntity<TextInputState>, cx: &mut App) {
    if !cx.has_global::<LiveInputs>() {
        cx.set_global(LiveInputs::default());
    }
    let live = cx.global::<LiveInputs>();
    let mut inputs = live.0.borrow_mut();
    inputs.retain(|weak| weak.upgrade().is_some());
    inputs.push(weak);
}

// -- Events -------------------------------------------------------------------

/// What the field tells its owner. The owner keeps the meaning: `Cancel` is
/// "clear the filter, then close the panel" in the main window and "revert to
/// the stored value" in settings, and neither belongs in a component.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TextInputEvent {
    /// The text changed -- a keystroke, a paste, a delete, an undo.
    Changed,
    /// Return in a single-line field.
    Confirmed,
    /// Escape.
    Cancelled,
    /// Focus left the field. Commit-on-blur lives here.
    Blurred,
}

impl EventEmitter<TextInputEvent> for TextInputState {}

// -- Layout -------------------------------------------------------------------

/// One visual row: a soft-wrapped slice of a paragraph, or a whole short one.
#[derive(Debug, Clone, PartialEq)]
struct Row {
    /// Byte range within the whole content.
    range: Range<usize>,
    /// Index of the paragraph (hard line) this row belongs to.
    paragraph: usize,
    /// Byte offset of the row's start within its paragraph.
    local_start: usize,
    /// The row's laid-out width, which is what the aligner centres on
    /// (`aligned_origin_x`, `gpui/src/text_system/line.rs`).
    width: Pixels,
}

/// The shaped picture of the content, rebuilt only when its key changes.
struct InputLayout {
    lines: SmallVec<[WrappedLine; 1]>,
    /// Byte offset of each paragraph's first character in the whole content.
    paragraph_starts: Vec<usize>,
    /// Index of each paragraph's first visual row.
    paragraph_rows: Vec<usize>,
    rows: Vec<Row>,
    key: LayoutKey,
}

/// What makes a cached layout stale.
#[derive(Debug, Clone, PartialEq)]
struct LayoutKey {
    text: SharedString,
    wrap_width: Option<Pixels>,
    font_size: Pixels,
    line_height: Pixels,
    weight: FontWeight,
    marked: Option<Range<usize>>,
}

impl InputLayout {
    fn row_count(&self) -> usize {
        self.rows.len()
    }

    /// The row a caret at `offset` paints on.
    ///
    /// The later row wins at a soft-wrap boundary, which is where a caret
    /// belongs after moving right onto it. gpui's own `position_for_index`
    /// resolves such an index onto the *previous* row, so the x inside that row
    /// is taken as zero rather than asked for.
    fn row_for_offset(&self, offset: usize) -> usize {
        match self
            .rows
            .binary_search_by(|row| row.range.start.cmp(&offset))
        {
            Ok(index) => index,
            Err(0) => 0,
            Err(index) => index - 1,
        }
    }

    /// The x of a caret at `offset`, relative to its row's start.
    fn x_for_offset(&self, offset: usize, line_height: Pixels) -> Pixels {
        let row_index = self.row_for_offset(offset);
        let Some(row) = self.rows.get(row_index) else {
            return px(0.);
        };
        if offset <= row.range.start {
            return px(0.);
        }
        let Some(line) = self.lines.get(row.paragraph) else {
            return px(0.);
        };
        let paragraph_start = self.paragraph_starts[row.paragraph];
        let local = offset.saturating_sub(paragraph_start).min(line.len());
        line.position_for_index(local, line_height)
            .map(|position| position.x)
            .unwrap_or(px(0.))
    }

    /// The offset closest to a point given in *text-local* coordinates: x is
    /// already un-aligned and un-scrolled, y is measured from the first row's
    /// top.
    fn offset_for_point(&self, position: Point<Pixels>, line_height: Pixels) -> usize {
        if self.rows.is_empty() {
            return 0;
        }
        let row_index = if position.y < px(0.) {
            0
        } else {
            ((f32::from(position.y) / f32::from(line_height)) as usize).min(self.rows.len() - 1)
        };
        let row = &self.rows[row_index];
        let Some(line) = self.lines.get(row.paragraph) else {
            return row.range.start;
        };
        let local_row = row_index - self.paragraph_rows[row.paragraph];
        let local_point = point(position.x, line_height * local_row as f32);
        let local = match line.closest_index_for_position(local_point, line_height) {
            Ok(index) => index,
            Err(index) => index,
        };
        self.paragraph_starts[row.paragraph] + local.min(line.len())
    }
}

/// The byte offset each visual row of a wrapped paragraph starts at.
///
/// `WrappedLineLayout::position_for_index` maps an index onto the row it
/// *ends* -- the loop returns as soon as `index <= line_end_ix`, so a wrap
/// boundary resolves onto the row before it. Row `k`'s start is therefore the
/// greatest character boundary whose y is still below `k * line_height`, which
/// is what this binary search looks for.
///
/// Split out from the shaping so it can be exercised without a window:
/// `y_of` is the only thing the text system contributes.
pub(crate) fn row_starts(
    boundaries: &[usize],
    row_count: usize,
    line_height: f32,
    y_of: impl Fn(usize) -> f32,
) -> Vec<usize> {
    let mut starts = Vec::with_capacity(row_count);
    starts.push(0usize);
    if boundaries.is_empty() {
        return starts;
    }
    for row in 1..row_count {
        let target = line_height * row as f32;
        let mut low = 0usize;
        let mut high = boundaries.len() - 1;
        while low < high {
            let mid = low.midpoint(high + 1);
            if y_of(boundaries[mid]) < target {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        starts.push(boundaries[low]);
    }
    starts
}

/// Build the flat row table for one shaped paragraph.
fn rows_for_paragraph(
    line: &WrappedLine,
    line_height: Pixels,
    paragraph: usize,
    paragraph_start: usize,
    rows: &mut Vec<Row>,
) {
    let boundaries: Vec<usize> = line
        .text
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(line.text.len()))
        .collect();
    let row_count = line.wrap_boundaries().len() + 1;
    let starts = row_starts(&boundaries, row_count, f32::from(line_height), |index| {
        line.position_for_index(index, line_height)
            .map(|position| f32::from(position.y))
            .unwrap_or(0.)
    });

    for row in 0..row_count {
        let local_start = starts[row];
        let local_end = starts.get(row + 1).copied().unwrap_or(line.text.len());
        // The aligner centres on the row's laid-out width, which is the x of
        // its end index -- `aligned_origin_x` measures exactly the same span
        // (`gpui/src/text_system/line.rs`).
        let width = line
            .position_for_index(local_end, line_height)
            .map(|position| position.x)
            .unwrap_or(px(0.));
        rows.push(Row {
            range: paragraph_start + local_start..paragraph_start + local_end,
            paragraph,
            local_start,
            width,
        });
    }
}

// -- Undo ---------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Snapshot {
    content: SharedString,
    selection: Range<usize>,
    reversed: bool,
}

/// Whether `next` joins the step `previous` opened rather than starting a new
/// one. A webview `<input>` groups a run of typed characters into one undo
/// step and breaks the group on anything else.
pub(crate) fn undo_coalesces(previous: Option<UndoGroup>, next: UndoGroup) -> bool {
    next != UndoGroup::Discrete && previous == Some(next)
}

/// How a mutation coalesces into the undo stack.
///
/// A webview `<input>` groups a run of typed characters into one undo step and
/// breaks the group on anything else, which is what these three arms are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UndoGroup {
    /// A single typed character. Coalesces with the previous one.
    Typing,
    /// Deleting. Coalesces with previous deletes.
    Deleting,
    /// A paste, a cut, a replaced selection -- always its own step.
    Discrete,
}

// -- The state machine --------------------------------------------------------

/// How far a drag extends the selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DragGranularity {
    Character,
    Word,
    Line,
}

pub struct TextInputState {
    focus: FocusHandle,
    content: SharedString,
    placeholder: SharedString,
    /// utf-8 byte range. `selection_reversed` says which end the caret is on.
    selected_range: Range<usize>,
    selection_reversed: bool,
    /// The IME's composition range, drawn underlined.
    marked_range: Option<Range<usize>>,
    multi_line: bool,
    disabled: bool,

    /// Shared with the element, for the reason gpui's own `TextLayout` is an
    /// `Rc<RefCell<..>>`: `WrappedLine::paint` needs `&mut App`, and a layout
    /// living inside the entity could not be read while the entity is being
    /// updated through that same `App`.
    layout: Rc<RefCell<Option<InputLayout>>>,
    /// Bounds of the *text* (inside the field's padding), in window space.
    text_bounds: Option<Bounds<Pixels>>,
    line_height: Pixels,
    /// Single-line fields scroll horizontally to keep the caret visible.
    scroll_x: Pixels,

    drag: Option<(DragGranularity, Range<usize>)>,
    /// The x an Up/Down run walks along, so a short line does not shorten it.
    goal_x: Option<Pixels>,
    /// Written back by the element: `offset_for_position` has to undo whatever
    /// shift the aligner applied before it can ask the layout for an index.
    align: TextAlign,

    undo_stack: Vec<Snapshot>,
    redo_stack: Vec<Snapshot>,
    last_group: Option<UndoGroup>,

    /// Fires `Blurred` so commit-on-blur has somewhere to live.
    _blur: gpui::Subscription,
}

impl TextInputState {
    fn new(multi_line: bool, window: &mut Window, cx: &mut Context<Self>) -> Self {
        register_live_input(cx.weak_entity(), cx);
        let focus = cx.focus_handle();
        let blur = cx.on_blur(&focus, window, |this: &mut Self, _window, cx| {
            this.drag = None;
            cx.emit(TextInputEvent::Blurred);
        });
        Self {
            focus,
            content: SharedString::default(),
            placeholder: SharedString::default(),
            selected_range: 0..0,
            selection_reversed: false,
            marked_range: None,
            multi_line,
            disabled: false,
            layout: Rc::new(RefCell::new(None)),
            text_bounds: None,
            line_height: px(16.),
            scroll_x: px(0.),
            drag: None,
            goal_x: None,
            align: TextAlign::Left,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            last_group: None,
            _blur: blur,
        }
    }

    /// A one-line field: Return commits, no wrapping, horizontal scroll.
    pub fn single_line(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::new(false, window, cx)
    }

    /// A wrapping field: Return inserts a newline and the element measures its
    /// own height from the row count.
    pub fn multi_line(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::new(true, window, cx)
    }

    pub fn focus_handle(&self) -> FocusHandle {
        self.focus.clone()
    }

    fn invalidate_layout(&self) {
        *self.layout.borrow_mut() = None;
    }

    fn shared_layout(&self) -> Rc<RefCell<Option<InputLayout>>> {
        self.layout.clone()
    }

    pub fn text(&self) -> &str {
        &self.content
    }

    pub fn shared_text(&self) -> SharedString {
        self.content.clone()
    }

    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
    }

    pub fn set_placeholder(&mut self, placeholder: impl Into<SharedString>) {
        self.placeholder = placeholder.into();
    }

    pub fn set_disabled(&mut self, disabled: bool, cx: &mut Context<Self>) {
        if self.disabled != disabled {
            self.disabled = disabled;
            cx.notify();
        }
    }

    pub fn is_disabled(&self) -> bool {
        self.disabled
    }

    /// Replace the whole value from outside -- a Reset button, a store value
    /// arriving, a project reload. Emits nothing: the owner already knows.
    pub fn set_text(&mut self, text: impl Into<SharedString>, cx: &mut Context<Self>) {
        let text: SharedString = text.into();
        if text == self.content {
            return;
        }
        self.content = text;
        let end = self.content.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        self.marked_range = None;
        self.invalidate_layout();
        self.undo_stack.clear();
        self.redo_stack.clear();
        self.last_group = None;
        cx.notify();
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.selected_range = 0..self.content.len();
        self.selection_reversed = false;
        cx.notify();
    }

    pub fn move_to_end(&mut self, cx: &mut Context<Self>) {
        let end = self.content.len();
        self.selected_range = end..end;
        self.selection_reversed = false;
        cx.notify();
    }

    pub fn has_selection(&self) -> bool {
        !self.selected_range.is_empty()
    }

    pub fn selection(&self) -> Range<usize> {
        self.selected_range.clone()
    }

    /// Focus this field and select everything, the way tabbing into an
    /// `<input>` does.
    pub fn focus_and_select_all(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.select_all_text(cx);
    }

    fn cursor_offset(&self) -> usize {
        if self.selection_reversed {
            self.selected_range.start
        } else {
            self.selected_range.end
        }
    }

    // -- Motion primitives ----------------------------------------------------

    fn snapshot(&self) -> Snapshot {
        Snapshot {
            content: self.content.clone(),
            selection: self.selected_range.clone(),
            reversed: self.selection_reversed,
        }
    }

    /// Push an undo step unless it coalesces with the previous one.
    fn push_undo(&mut self, group: UndoGroup) {
        let coalesces = undo_coalesces(self.last_group, group);
        if !coalesces {
            self.undo_stack.push(self.snapshot());
            // A stack this long is a field someone has been typing in for a
            // very long time; the browser's own history is bounded too.
            if self.undo_stack.len() > 256 {
                self.undo_stack.remove(0);
            }
        }
        self.redo_stack.clear();
        self.last_group = Some(group);
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = self.clamp_to_boundary(offset);
        self.selected_range = offset..offset;
        self.selection_reversed = false;
        self.last_group = None;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = self.clamp_to_boundary(offset);
        let (range, reversed) =
            extend_selection(self.selected_range.clone(), self.selection_reversed, offset);
        self.selected_range = range;
        self.selection_reversed = reversed;
        self.last_group = None;
        cx.notify();
    }

    fn clamp_to_boundary(&self, offset: usize) -> usize {
        let offset = offset.min(self.content.len());
        if self.content.is_char_boundary(offset) {
            offset
        } else {
            previous_grapheme(&self.content, offset)
        }
    }

    fn previous_boundary(&self, offset: usize) -> usize {
        previous_grapheme(&self.content, offset)
    }

    fn next_boundary(&self, offset: usize) -> usize {
        next_grapheme(&self.content, offset)
    }

    /// The offset one visual row up or down, keeping the goal x.
    fn vertical(&mut self, delta: isize) -> Option<usize> {
        let layout = self.layout.clone();
        let layout = layout.borrow();
        let layout = layout.as_ref()?;
        let offset = self.cursor_offset();
        let row = layout.row_for_offset(offset);
        let target = row as isize + delta;
        if target < 0 || target as usize >= layout.row_count() {
            return None;
        }
        let goal = self
            .goal_x
            .unwrap_or_else(|| layout.x_for_offset(offset, self.line_height));
        let position = point(goal, self.line_height * target as f32);
        let next = layout.offset_for_point(position, self.line_height);
        self.goal_x = Some(goal);
        Some(next)
    }

    // -- Editing --------------------------------------------------------------

    /// The single place text is replaced. `range` is a byte range in the
    /// content; `None` means the marked range, then the selection.
    fn replace(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        group: UndoGroup,
        cx: &mut Context<Self>,
    ) {
        if self.disabled {
            return;
        }
        let range = range
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());
        let range = self.clamp_to_boundary(range.start)..self.clamp_to_boundary(range.end);
        let range = range.start..range.end.max(range.start);

        // A single-line field never holds a newline: the same flattening the
        // reference implementation does on paste.
        let text = if self.multi_line {
            text.to_string()
        } else {
            flatten_single_line(text)
        };

        self.push_undo(group);
        let mut next = String::with_capacity(self.content.len() + text.len());
        next.push_str(&self.content[..range.start]);
        next.push_str(&text);
        next.push_str(&self.content[range.end..]);
        self.content = next.into();

        let caret = range.start + text.len();
        self.selected_range = caret..caret;
        self.selection_reversed = false;
        self.marked_range = None;
        self.invalidate_layout();
        self.goal_x = None;
        cx.emit(TextInputEvent::Changed);
        cx.notify();
    }

    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.content = snapshot.content;
        self.selected_range = snapshot.selection.start.min(self.content.len())
            ..snapshot.selection.end.min(self.content.len());
        self.selection_reversed = snapshot.reversed;
        self.marked_range = None;
        self.invalidate_layout();
        self.goal_x = None;
        self.last_group = None;
        cx.emit(TextInputEvent::Changed);
        cx.notify();
    }

    // -- Action handlers ------------------------------------------------------

    fn on_backspace(&mut self, _: &Backspace, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let previous = self.previous_boundary(self.cursor_offset());
            if previous == self.cursor_offset() {
                return;
            }
            let range = previous..self.cursor_offset();
            self.replace(Some(range), "", UndoGroup::Deleting, cx);
        } else {
            self.replace(None, "", UndoGroup::Discrete, cx);
        }
    }

    fn on_delete_forward(&mut self, _: &DeleteForward, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            if next == self.cursor_offset() {
                return;
            }
            let range = self.cursor_offset()..next;
            self.replace(Some(range), "", UndoGroup::Deleting, cx);
        } else {
            self.replace(None, "", UndoGroup::Discrete, cx);
        }
    }

    fn on_delete_word_left(&mut self, _: &DeleteWordLeft, _w: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            return self.replace(None, "", UndoGroup::Discrete, cx);
        }
        let caret = self.cursor_offset();
        let start = word_start_before(&self.content, caret);
        if start < caret {
            self.replace(Some(start..caret), "", UndoGroup::Discrete, cx);
        }
    }

    fn on_delete_word_right(&mut self, _: &DeleteWordRight, _w: &mut Window, cx: &mut Context<Self>) {
        if !self.selected_range.is_empty() {
            return self.replace(None, "", UndoGroup::Discrete, cx);
        }
        let caret = self.cursor_offset();
        let end = word_end_after(&self.content, caret);
        if end > caret {
            self.replace(Some(caret..end), "", UndoGroup::Discrete, cx);
        }
    }

    fn on_delete_to_line_start(
        &mut self,
        _: &DeleteToLineStart,
        _w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let caret = self.cursor_offset();
        let start = paragraph_start(&self.content, caret);
        if start < caret {
            self.replace(Some(start..caret), "", UndoGroup::Discrete, cx);
        }
    }

    fn on_delete_to_line_end(
        &mut self,
        _: &DeleteToLineEnd,
        _w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let caret = self.cursor_offset();
        let end = paragraph_end(&self.content, caret);
        if end > caret {
            self.replace(Some(caret..end), "", UndoGroup::Discrete, cx);
        }
    }

    fn on_move_left(&mut self, _: &MoveLeft, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        if self.selected_range.is_empty() {
            let previous = self.previous_boundary(self.cursor_offset());
            self.move_to(previous, cx);
        } else {
            let start = self.selected_range.start;
            self.move_to(start, cx);
        }
    }

    fn on_move_right(&mut self, _: &MoveRight, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        if self.selected_range.is_empty() {
            let next = self.next_boundary(self.cursor_offset());
            self.move_to(next, cx);
        } else {
            let end = self.selected_range.end;
            self.move_to(end, cx);
        }
    }

    fn on_move_up(&mut self, _: &MoveUp, _window: &mut Window, cx: &mut Context<Self>) {
        match self.vertical(-1) {
            Some(offset) => {
                let goal = self.goal_x;
                self.move_to(offset, cx);
                self.goal_x = goal;
            }
            None => self.move_to(0, cx),
        }
    }

    fn on_move_down(&mut self, _: &MoveDown, _window: &mut Window, cx: &mut Context<Self>) {
        match self.vertical(1) {
            Some(offset) => {
                let goal = self.goal_x;
                self.move_to(offset, cx);
                self.goal_x = goal;
            }
            None => {
                let end = self.content.len();
                self.move_to(end, cx);
            }
        }
    }

    fn on_move_word_left(&mut self, _: &MoveWordLeft, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = word_start_before(&self.content, self.cursor_offset());
        self.move_to(offset, cx);
    }

    fn on_move_word_right(&mut self, _: &MoveWordRight, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = word_end_after(&self.content, self.cursor_offset());
        self.move_to(offset, cx);
    }

    fn on_move_to_line_start(&mut self, _: &MoveToLineStart, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = paragraph_start(&self.content, self.cursor_offset());
        self.move_to(offset, cx);
    }

    fn on_move_to_line_end(&mut self, _: &MoveToLineEnd, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = paragraph_end(&self.content, self.cursor_offset());
        self.move_to(offset, cx);
    }

    fn on_move_to_start(&mut self, _: &MoveToStart, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.move_to(0, cx);
    }

    fn on_move_to_end(&mut self, _: &MoveToEnd, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let end = self.content.len();
        self.move_to(end, cx);
    }

    fn on_select_left(&mut self, _: &SelectLeft, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = self.previous_boundary(self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_right(&mut self, _: &SelectRight, _window: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = self.next_boundary(self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_up(&mut self, _: &SelectUp, _window: &mut Window, cx: &mut Context<Self>) {
        let offset = self.vertical(-1).unwrap_or(0);
        let goal = self.goal_x;
        self.select_to(offset, cx);
        self.goal_x = goal;
    }

    fn on_select_down(&mut self, _: &SelectDown, _window: &mut Window, cx: &mut Context<Self>) {
        let offset = self.vertical(1).unwrap_or(self.content.len());
        let goal = self.goal_x;
        self.select_to(offset, cx);
        self.goal_x = goal;
    }

    fn on_select_word_left(&mut self, _: &SelectWordLeft, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = word_start_before(&self.content, self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_word_right(&mut self, _: &SelectWordRight, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let offset = word_end_after(&self.content, self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_to_line_start(
        &mut self,
        _: &SelectToLineStart,
        _w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.goal_x = None;
        let offset = paragraph_start(&self.content, self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_to_line_end(
        &mut self,
        _: &SelectToLineEnd,
        _w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.goal_x = None;
        let offset = paragraph_end(&self.content, self.cursor_offset());
        self.select_to(offset, cx);
    }

    fn on_select_to_start(&mut self, _: &SelectToStart, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        self.select_to(0, cx);
    }

    fn on_select_to_end(&mut self, _: &SelectToEnd, _w: &mut Window, cx: &mut Context<Self>) {
        self.goal_x = None;
        let end = self.content.len();
        self.select_to(end, cx);
    }

    fn on_select_all(&mut self, _: &SelectAll, _window: &mut Window, cx: &mut Context<Self>) {
        self.select_all_text(cx);
    }

    fn on_copy(&mut self, _: &Copy, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() {
            return;
        }
        let text = self.content[self.selected_range.clone()].to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(text));
    }

    fn on_cut(&mut self, _: &Cut, _window: &mut Window, cx: &mut Context<Self>) {
        if self.selected_range.is_empty() || self.disabled {
            return;
        }
        let text = self.content[self.selected_range.clone()].to_string();
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.replace(None, "", UndoGroup::Discrete, cx);
    }

    fn on_paste(&mut self, _: &Paste, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
            return;
        };
        self.replace(None, &text, UndoGroup::Discrete, cx);
    }

    fn on_undo(&mut self, _: &Undo, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.undo_stack.pop() else {
            return;
        };
        self.redo_stack.push(self.snapshot());
        self.restore(snapshot, cx);
    }

    fn on_redo(&mut self, _: &Redo, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.redo_stack.pop() else {
            return;
        };
        self.undo_stack.push(self.snapshot());
        self.restore(snapshot, cx);
    }

    fn on_confirm(&mut self, _: &Confirm, _window: &mut Window, cx: &mut Context<Self>) {
        if self.multi_line {
            self.replace(None, "\n", UndoGroup::Discrete, cx);
        } else {
            cx.emit(TextInputEvent::Confirmed);
        }
    }

    fn on_cancel(&mut self, _: &Cancel, _window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(TextInputEvent::Cancelled);
    }

    fn on_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _cx: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    // -- Pointer --------------------------------------------------------------

    fn offset_for_position(&self, position: Point<Pixels>) -> usize {
        let Some(bounds) = self.text_bounds else {
            return 0;
        };
        let layout = self.layout.borrow();
        let Some(layout) = layout.as_ref() else {
            return 0;
        };
        let row_index = if position.y <= bounds.top() {
            0
        } else {
            ((f32::from(position.y - bounds.top()) / f32::from(self.line_height)) as usize)
                .min(layout.row_count().saturating_sub(1))
        };
        let align_offset = self.align_offset(layout, row_index, bounds.size.width);
        let local = point(
            position.x - bounds.left() - align_offset + self.scroll_x,
            self.line_height * row_index as f32,
        );
        layout.offset_for_point(local, self.line_height)
    }

    fn align_offset(&self, layout: &InputLayout, row: usize, width: Pixels) -> Pixels {
        let Some(row) = layout.rows.get(row) else {
            return px(0.);
        };
        match self.align {
            TextAlign::Left => px(0.),
            TextAlign::Center => (width - row.width) / 2.,
            TextAlign::Right => width - row.width,
        }
    }

    fn on_mouse_down(&mut self, event: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if self.disabled {
            return;
        }
        if !self.focus.is_focused(window) {
            window.focus(&self.focus, cx);
        }
        let offset = self.offset_for_position(event.position);
        self.goal_x = None;

        // `click_count` is gpui's own, so double- and triple-click come free
        // and use the platform's interval.
        match event.click_count {
            0 | 1 => {
                if event.modifiers.shift {
                    self.select_to(offset, cx);
                    let anchor = self.selected_range.clone();
                    self.drag = Some((DragGranularity::Character, anchor));
                } else {
                    self.move_to(offset, cx);
                    self.drag = Some((DragGranularity::Character, offset..offset));
                }
            }
            2 => {
                let range = word_at(&self.content, offset);
                self.selected_range = range.clone();
                self.selection_reversed = false;
                self.drag = Some((DragGranularity::Word, range));
                        cx.notify();
            }
            _ => {
                let range = paragraph_start(&self.content, offset)..paragraph_end(&self.content, offset);
                self.selected_range = range.clone();
                self.selection_reversed = false;
                self.drag = Some((DragGranularity::Line, range));
                        cx.notify();
            }
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        let Some((granularity, anchor)) = self.drag.clone() else {
            return;
        };
        let offset = self.offset_for_position(event.position);
        let extent = match granularity {
            DragGranularity::Character => offset..offset,
            DragGranularity::Word => word_at(&self.content, offset),
            DragGranularity::Line => {
                paragraph_start(&self.content, offset)..paragraph_end(&self.content, offset)
            }
        };
        let start = anchor.start.min(extent.start);
        let end = anchor.end.max(extent.end);
        self.selection_reversed = extent.start < anchor.start;
        self.selected_range = start..end;
        cx.notify();
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _window: &mut Window, _cx: &mut Context<Self>) {
        self.drag = None;
    }

    // -- utf-16 conversion, which is the protocol's unit ----------------------

    fn offset_from_utf16(&self, offset: usize) -> usize {
        offset_from_utf16(&self.content, offset)
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        offset_to_utf16(&self.content, offset)
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }
}

// `align` is a render-time property, but `offset_for_position` needs it to
// undo the aligner's shift, so the element writes it back with the layout.
impl TextInputState {
    fn set_align(&mut self, align: TextAlign) {
        self.align = align;
    }
}

impl Focusable for TextInputState {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus.clone()
    }
}

// -- The IME seam -------------------------------------------------------------

impl EntityInputHandler for TextInputState {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        let range = self.clamp_to_boundary(range.start)..self.clamp_to_boundary(range.end);
        if range.start > range.end {
            return None;
        }
        actual_range.replace(self.range_to_utf16(&range));
        Some(self.content[range].to_string())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selected_range),
            reversed: self.selection_reversed,
        })
    }

    fn marked_text_range(&self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked_range
            .as_ref()
            .map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _window: &mut Window, _cx: &mut Context<Self>) {
        self.marked_range = None;
    }

    /// The composed result -- and every ordinary typed character, because on
    /// macOS a printable key that no binding matched is handed to the input
    /// context and comes back here rather than through `key_char`.
    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16.map(|range| self.range_from_utf16(&range));
        // One character typed coalesces into the previous undo step; anything
        // longer (a paste, a composed run, dictation) is its own.
        let group = if new_text.chars().count() == 1 && self.selected_range.is_empty() {
            UndoGroup::Typing
        } else {
            UndoGroup::Discrete
        };
        self.replace(range, new_text, group, cx);
    }

    /// Marked (composing) text: `Option+e` then `e` arrives here twice, first
    /// as the marked `´`, then as the committed `é`.
    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.disabled {
            return;
        }
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked_range.clone())
            .unwrap_or_else(|| self.selected_range.clone());
        let range = self.clamp_to_boundary(range.start)..self.clamp_to_boundary(range.end);
        let range = range.start..range.end.max(range.start);

        // A composition is one undo step, however many keystrokes build it.
        if self.marked_range.is_none() {
            self.push_undo(UndoGroup::Discrete);
        }

        let mut next = String::with_capacity(self.content.len() + new_text.len());
        next.push_str(&self.content[..range.start]);
        next.push_str(new_text);
        next.push_str(&self.content[range.end..]);
        self.content = next.into();

        self.marked_range = (!new_text.is_empty()).then(|| range.start..range.start + new_text.len());
        self.selected_range = new_selected_range_utf16
            .as_ref()
            .map(|utf16| self.range_from_utf16(utf16))
            .map(|selected| range.start + selected.start..range.start + selected.end)
            .unwrap_or_else(|| {
                let caret = range.start + new_text.len();
                caret..caret
            });
        self.selection_reversed = false;
        self.invalidate_layout();
        self.goal_x = None;
        cx.emit(TextInputEvent::Changed);
        cx.notify();
    }

    /// Where the IME's candidate window should sit.
    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        element_bounds: Bounds<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        let layout = self.layout.clone();
        let layout = layout.borrow();
        let layout = layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        let bounds = self.text_bounds.unwrap_or(element_bounds);
        let row = layout.row_for_offset(range.start);
        let align = self.align_offset(layout, row, bounds.size.width);
        let start_x = bounds.left() + align + layout.x_for_offset(range.start, self.line_height)
            - self.scroll_x;
        let end_x = bounds.left()
            + align
            + layout.x_for_offset(range.end, self.line_height)
            - self.scroll_x;
        let top = bounds.top() + self.line_height * row as f32;
        Some(Bounds::from_corners(
            point(start_x, top),
            point(end_x.max(start_x), top + self.line_height),
        ))
    }

    fn character_index_for_point(
        &mut self,
        position: Point<Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let offset = self.offset_for_position(position);
        Some(self.offset_to_utf16(offset))
    }

    fn text_length_utf16(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> Option<usize> {
        Some(self.offset_to_utf16(self.content.len()))
    }

    fn accepts_text_input(&self, _window: &mut Window, _cx: &mut Context<Self>) -> bool {
        !self.disabled
    }
}

// -- Pure text helpers, unit-tested -------------------------------------------

fn previous_grapheme(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .rev()
        .find_map(|(index, _)| (index < offset).then_some(index))
        .unwrap_or(0)
}

fn next_grapheme(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .find_map(|(index, _)| (index > offset).then_some(index))
        .unwrap_or(text.len())
}

fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// `alt-left`: skip any run of non-word characters, then the word itself.
pub(crate) fn word_start_before(text: &str, offset: usize) -> usize {
    let mut index = offset.min(text.len());
    while let Some((start, ch)) = text[..index].char_indices().next_back() {
        if is_word_char(ch) {
            break;
        }
        index = start;
    }
    while let Some((start, ch)) = text[..index].char_indices().next_back() {
        if !is_word_char(ch) {
            break;
        }
        index = start;
    }
    index
}

/// `alt-right`: skip any run of non-word characters, then the word itself.
pub(crate) fn word_end_after(text: &str, offset: usize) -> usize {
    let mut index = offset.min(text.len());
    while let Some(ch) = text[index..].chars().next() {
        if is_word_char(ch) {
            break;
        }
        index += ch.len_utf8();
    }
    while let Some(ch) = text[index..].chars().next() {
        if !is_word_char(ch) {
            break;
        }
        index += ch.len_utf8();
    }
    index
}

/// The word a double-click selects. An offset inside whitespace selects that
/// run of whitespace, which is what `NSTextView` does.
pub(crate) fn word_at(text: &str, offset: usize) -> Range<usize> {
    if text.is_empty() {
        return 0..0;
    }
    let offset = offset.min(text.len());
    // Sitting at the very end selects the last word rather than nothing.
    let probe = if offset == text.len() {
        previous_grapheme(text, offset)
    } else {
        offset
    };
    let Some(ch) = text[probe..].chars().next() else {
        return offset..offset;
    };
    let word = is_word_char(ch);
    let mut start = probe;
    while let Some((index, ch)) = text[..start].char_indices().next_back() {
        if is_word_char(ch) != word {
            break;
        }
        start = index;
    }
    let mut end = probe;
    while let Some(ch) = text[end..].chars().next() {
        if is_word_char(ch) != word {
            break;
        }
        end += ch.len_utf8();
    }
    start..end
}

/// The start of the hard line (paragraph) containing `offset`.
///
/// `cmd-left`, `cmd-backspace` and a triple-click work on the *paragraph*, not
/// on the soft-wrapped visual row: the two agree in every single-line field,
/// and in the teleprompter the paragraph is the unit a script is written in.
pub(crate) fn paragraph_start(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    text[..offset]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0)
}

/// The end of the hard line containing `offset`, excluding the newline.
pub(crate) fn paragraph_end(text: &str, offset: usize) -> usize {
    let offset = offset.min(text.len());
    text[offset..]
        .find('\n')
        .map(|index| offset + index)
        .unwrap_or(text.len())
}

/// Shift-extend: move whichever end of the selection the caret is on, and flip
/// the direction when it crosses the anchor.
pub(crate) fn extend_selection(
    range: Range<usize>,
    reversed: bool,
    to: usize,
) -> (Range<usize>, bool) {
    let mut range = range;
    let mut reversed = reversed;
    if reversed {
        range.start = to;
    } else {
        range.end = to;
    }
    if range.end < range.start {
        reversed = !reversed;
        range = range.end..range.start;
    }
    (range, reversed)
}

/// A single-line field never holds a newline, the way an `<input>` never does:
/// a pasted line break becomes a space.
pub(crate) fn flatten_single_line(text: &str) -> String {
    text.replace(['\n', '\r'], " ")
}

/// utf-16 is the input protocol's unit; the content is utf-8.
pub(crate) fn offset_from_utf16(text: &str, offset: usize) -> usize {
    let mut utf8 = 0;
    let mut utf16 = 0;
    for ch in text.chars() {
        if utf16 >= offset {
            break;
        }
        utf16 += ch.len_utf16();
        utf8 += ch.len_utf8();
    }
    utf8
}

pub(crate) fn offset_to_utf16(text: &str, offset: usize) -> usize {
    let mut utf16 = 0;
    let mut utf8 = 0;
    for ch in text.chars() {
        if utf8 >= offset {
            break;
        }
        utf8 += ch.len_utf8();
        utf16 += ch.len_utf16();
    }
    utf16
}

// -- The element --------------------------------------------------------------

/// The chrome around the text: fill, border, radius, icon, padding.
#[derive(IntoElement)]
pub struct TextInput {
    state: Entity<TextInputState>,
    id: ElementId,
    icon: Option<SharedString>,
    height: Option<Pixels>,
    padding_x: Pixels,
    padding_y: Pixels,
    radius: Pixels,
    gap: Pixels,
    text_size: Pixels,
    line_height: Option<Pixels>,
    weight: FontWeight,
    align: TextAlign,
    bg: Option<Hsla>,
    border: Option<Hsla>,
    focus_border: Option<Hsla>,
    text: Hsla,
    muted: Hsla,
    icon_color: Hsla,
    caret_color: Hsla,
    selection_color: Hsla,
    flex: bool,
    full_width: bool,
    fixed_width: Option<Pixels>,
    fit_content: bool,
}

impl TextInput {
    fn base(theme: &Theme, id: impl Into<ElementId>, state: &Entity<TextInputState>) -> Self {
        Self {
            state: state.clone(),
            id: id.into(),
            icon: None,
            height: Some(px(32.)),
            padding_x: px(8.),
            padding_y: px(0.),
            radius: px(8.),
            gap: px(2.),
            text_size: px(12.),
            line_height: None,
            weight: FontWeight::NORMAL,
            align: TextAlign::Left,
            bg: None,
            border: None,
            focus_border: None,
            text: theme.gray(12),
            muted: theme.gray(10),
            icon_color: theme.gray(10),
            caret_color: theme.gray(12),
            selection_color: selection_tint(),
            flex: false,
            full_width: false,
            fixed_width: None,
            fit_content: false,
        }
    }

    /// The settings window's inputs: `<Input>` is `h-8 rounded-lg bg-gray-2
    /// px-2 text-xs` in `editor/ui.tsx`, re-filled from the settings material's
    /// `--macos-settings-fill` / `-border` / `-text` / `-muted`.
    pub fn settings(theme: &Theme, id: impl Into<ElementId>, state: &Entity<TextInputState>) -> Self {
        Self {
            bg: Some(theme.settings_fill()),
            border: Some(theme.settings_border()),
            focus_border: Some(Theme::with_alpha(
                gpui::rgb(Theme::SETTINGS_ACCENT).into(),
                0.8,
            )),
            text: theme.settings_text(),
            muted: theme.settings_muted(),
            caret_color: theme.settings_text(),
            full_width: true,
            ..Self::base(theme, id, state)
        }
    }

    /// The main window's search field: `h-9 px-2 rounded-md border-gray-5
    /// bg-gray-2` with a leading magnifier, over the panel material's body
    /// remaps.
    pub fn search(theme: &Theme, id: impl Into<ElementId>, state: &Entity<TextInputState>) -> Self {
        Self {
            height: Some(px(36.)),
            radius: px(6.),
            gap: px(4.),
            bg: Some(theme.body_fill(2)),
            border: Some(theme.body_border(5)),
            icon: Some(SharedString::from("icons/search.svg")),
            text: theme.gray(12),
            muted: theme.gray(10),
            caret_color: theme.gray(12),
            flex: true,
            ..Self::base(theme, id, state)
        }
    }

    /// The editor's Radix-on-nothing surface: the header's name field and the
    /// sidebar's hex inputs.
    pub fn plain(theme: &Theme, id: impl Into<ElementId>, state: &Entity<TextInputState>) -> Self {
        Self {
            bg: Some(theme.gray(1)),
            border: Some(theme.gray(4)),
            focus_border: Some(theme.gray(7)),
            ..Self::base(theme, id, state)
        }
    }

    /// No chrome at all: the caller draws the container. The teleprompter's
    /// script area is this.
    pub fn bare(theme: &Theme, id: impl Into<ElementId>, state: &Entity<TextInputState>) -> Self {
        Self {
            height: None,
            padding_x: px(0.),
            radius: px(0.),
            bg: None,
            border: None,
            full_width: true,
            ..Self::base(theme, id, state)
        }
    }

    pub fn placeholder_color(mut self, color: Hsla) -> Self {
        self.muted = color;
        self
    }

    pub fn text_color(mut self, color: Hsla) -> Self {
        self.text = color;
        self.caret_color = color;
        self
    }

    pub fn caret_color(mut self, color: Hsla) -> Self {
        self.caret_color = color;
        self
    }

    pub fn selection_color(mut self, color: Hsla) -> Self {
        self.selection_color = color;
        self
    }

    pub fn text_size(mut self, size: Pixels) -> Self {
        self.text_size = size;
        self
    }

    pub fn line_height(mut self, height: Pixels) -> Self {
        self.line_height = Some(height);
        self
    }

    pub fn font_weight(mut self, weight: FontWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn align(mut self, align: TextAlign) -> Self {
        self.align = align;
        self
    }

    pub fn height(mut self, height: Pixels) -> Self {
        self.height = Some(height);
        self
    }

    pub fn padding_x(mut self, padding: Pixels) -> Self {
        self.padding_x = padding;
        self
    }

    pub fn padding_y(mut self, padding: Pixels) -> Self {
        self.padding_y = padding;
        self
    }

    pub fn radius(mut self, radius: Pixels) -> Self {
        self.radius = radius;
        self
    }

    pub fn width(mut self, width: Pixels) -> Self {
        self.fixed_width = Some(width);
        self
    }

    pub fn bg(mut self, bg: Hsla) -> Self {
        self.bg = Some(bg);
        self
    }

    pub fn border(mut self, border: Hsla) -> Self {
        self.border = Some(border);
        self
    }

    pub fn flex(mut self, flex: bool) -> Self {
        self.flex = flex;
        self
    }

    /// Size to the text rather than to the parent.
    ///
    /// `NameEditor` is an `<input>` laid over a hidden `<span>` whose only job
    /// is to measure the value (`Header.tsx:284-290, 325-329`), so the field is
    /// exactly as wide as its text and the literal `.cap` hugs it. The field
    /// here paints its own glyphs, so it can measure itself and the span is not
    /// needed -- but the *sizing* has to be the span's, not the parent's.
    pub fn fit_content(mut self) -> Self {
        self.fit_content = true;
        self.full_width = false;
        self
    }
}

/// The selection wash. `--macos-settings-accent` resolves to the user's system
/// accent in the shipping app and gpui exposes no query for it, so this is the
/// same macOS blue the toggles already deviate to, at the 30 % a focused
/// `<input>`'s selection paints at.
fn selection_tint() -> Hsla {
    Theme::with_alpha(gpui::rgb(Theme::SETTINGS_ACCENT).into(), 0.30)
}

// -- Rendering ----------------------------------------------------------------

/// Bind one action to a method on the state entity.
///
/// `RenderOnce::render` is handed an `&mut App` rather than a `Context<V>`, so
/// `cx.listener(..)` is not available here; the handler closes over the state
/// entity instead, which is what makes the component window-agnostic.
macro_rules! input_actions {
    ($element:expr, $state:expr, $( $action:ty => $method:ident ),* $(,)?) => {{
        let element = $element;
        $(
            let element = element.on_action({
                let state = $state.clone();
                move |action: &$action, window: &mut Window, cx: &mut App| {
                    state.update(cx, |this, cx| this.$method(action, window, cx));
                }
            });
        )*
        element
    }};
}

impl RenderOnce for TextInput {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let state = self.state.clone();
        let (focus, multi_line, disabled) = {
            let read = state.read(cx);
            (read.focus.clone(), read.multi_line, read.disabled)
        };
        let focused = focus.is_focused(window);
        // `leading-normal` on a `text-xs` input is 1.35 in this font stack;
        // the callers that care (the teleprompter) pass their own.
        let line_height = self
            .line_height
            .unwrap_or(px((f32::from(self.text_size) * 1.35).round()));

        let body = TextBody {
            layout: state.read(cx).shared_layout(),
            state: state.clone(),
            fit_content: self.fit_content,
            text_size: self.text_size,
            line_height,
            weight: self.weight,
            align: self.align,
            color: self.text,
            placeholder_color: self.muted,
            caret_color: self.caret_color,
            selection_color: self.selection_color,
            multi_line,
            focused,
        };

        let border = if focused {
            self.focus_border.or(self.border)
        } else {
            self.border
        };

        let element = div()
            .id(self.id.clone())
            .key_context(KEY_CONTEXT)
            .track_focus(&focus)
            .relative()
            .flex()
            .flex_row()
            .when(multi_line, |this| this.items_start())
            .when(!multi_line, |this| this.items_center())
            .gap(self.gap)
            .when(self.flex, |this| this.flex_1().min_w_0())
            .when(self.full_width, |this| this.w_full())
            .when(self.fit_content, |this| this.min_w_0())
            .when_some(self.fixed_width, |this, width| this.w(width))
            .when_some(self.height, |this, height| this.h(height))
            .px(self.padding_x)
            .py(self.padding_y)
            .rounded(self.radius)
            .overflow_hidden()
            .when_some(self.bg, |this, bg| this.bg(bg))
            .when_some(border, |this, border| {
                this.border_1().border_color(border)
            })
            .when(!disabled, |this| this.cursor(gpui::CursorStyle::IBeam))
            .text_size(self.text_size)
            .text_color(self.text)
            .children(self.icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(px(12.))
                    .flex_shrink_0()
                    .text_color(self.icon_color)
            }))
            .on_mouse_down(MouseButton::Left, {
                let state = state.clone();
                move |event: &MouseDownEvent, window: &mut Window, cx: &mut App| {
                    state.update(cx, |this, cx| this.on_mouse_down(event, window, cx));
                }
            });

        let element = input_actions!(
            element,
            state,
            Backspace => on_backspace,
            DeleteForward => on_delete_forward,
            DeleteWordLeft => on_delete_word_left,
            DeleteWordRight => on_delete_word_right,
            DeleteToLineStart => on_delete_to_line_start,
            DeleteToLineEnd => on_delete_to_line_end,
            MoveLeft => on_move_left,
            MoveRight => on_move_right,
            MoveUp => on_move_up,
            MoveDown => on_move_down,
            MoveWordLeft => on_move_word_left,
            MoveWordRight => on_move_word_right,
            MoveToLineStart => on_move_to_line_start,
            MoveToLineEnd => on_move_to_line_end,
            MoveToStart => on_move_to_start,
            MoveToEnd => on_move_to_end,
            SelectLeft => on_select_left,
            SelectRight => on_select_right,
            SelectUp => on_select_up,
            SelectDown => on_select_down,
            SelectWordLeft => on_select_word_left,
            SelectWordRight => on_select_word_right,
            SelectToLineStart => on_select_to_line_start,
            SelectToLineEnd => on_select_to_line_end,
            SelectToStart => on_select_to_start,
            SelectToEnd => on_select_to_end,
            SelectAll => on_select_all,
            Copy => on_copy,
            Cut => on_cut,
            Paste => on_paste,
            Undo => on_undo,
            Redo => on_redo,
            Confirm => on_confirm,
            Cancel => on_cancel,
            ShowCharacterPalette => on_character_palette,
        );

        element.child(div().flex_1().min_w_0().child(body))
    }
}

#[derive(Clone)]
struct TextBody {
    state: Entity<TextInputState>,
    layout: Rc<RefCell<Option<InputLayout>>>,
    fit_content: bool,
    text_size: Pixels,
    line_height: Pixels,
    weight: FontWeight,
    align: TextAlign,
    color: Hsla,
    placeholder_color: Hsla,
    caret_color: Hsla,
    selection_color: Hsla,
    multi_line: bool,
    focused: bool,
}

struct BodyPrepaint {
    placeholder: Option<gpui::ShapedLine>,
    selection: Vec<gpui::PaintQuad>,
    caret: Option<gpui::PaintQuad>,
    scroll_x: Pixels,
}

impl IntoElement for TextBody {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl TextBody {
    /// Shape the content if the cached layout is stale, and hand back the size
    /// it occupies. The only place `shape_text` is called.
    fn ensure_layout(
        &self,
        wrap_width: Option<Pixels>,
        window: &mut Window,
        cx: &mut App,
    ) -> Size<Pixels> {
        let mut font = window.text_style().font();
        font.weight = self.weight;

        let (text, marked) = {
            let read = self.state.read(cx);
            (read.content.clone(), read.marked_range.clone())
        };
        let key = LayoutKey {
            text: text.clone(),
            wrap_width,
            font_size: self.text_size,
            line_height: self.line_height,
            weight: self.weight,
            marked: marked.clone(),
        };

        if let Some(layout) = self.layout.borrow().as_ref()
            && layout.key == key
        {
            return layout_size(layout, self.line_height);
        }

        // The composing run is underlined, which is the whole visual contract
        // of marked text.
        let base = TextRun {
            len: text.len(),
            font: font.clone(),
            color: self.color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs: Vec<TextRun> = match marked.as_ref() {
            Some(marked) if marked.end <= text.len() && marked.start <= marked.end => vec![
                TextRun {
                    len: marked.start,
                    ..base.clone()
                },
                TextRun {
                    len: marked.end - marked.start,
                    underline: Some(UnderlineStyle {
                        color: Some(self.color),
                        thickness: px(1.),
                        wavy: false,
                    }),
                    ..base.clone()
                },
                TextRun {
                    len: text.len() - marked.end,
                    ..base
                },
            ]
            .into_iter()
            .filter(|run| run.len > 0)
            .collect(),
            _ => vec![base],
        };

        let lines = window
            .text_system()
            .shape_text(text, self.text_size, &runs, wrap_width, None)
            .unwrap_or_default();

        let mut paragraph_starts = Vec::with_capacity(lines.len());
        let mut paragraph_rows = Vec::with_capacity(lines.len());
        let mut rows = Vec::new();
        let mut offset = 0usize;
        for (index, line) in lines.iter().enumerate() {
            paragraph_starts.push(offset);
            paragraph_rows.push(rows.len());
            rows_for_paragraph(line, self.line_height, index, offset, &mut rows);
            // +1 for the `\n` that split this paragraph from the next.
            offset += line.text.len() + 1;
        }
        if rows.is_empty() {
            paragraph_starts.push(0);
            paragraph_rows.push(0);
            rows.push(Row {
                range: 0..0,
                paragraph: 0,
                local_start: 0,
                width: px(0.),
            });
        }

        let layout = InputLayout {
            lines,
            paragraph_starts,
            paragraph_rows,
            rows,
            key,
        };
        let size = layout_size(&layout, self.line_height);
        *self.layout.borrow_mut() = Some(layout);
        self.state.update(cx, |state, _| {
            state.line_height = self.line_height;
            state.align = self.align;
        });
        size
    }
}

fn layout_size(layout: &InputLayout, line_height: Pixels) -> Size<Pixels> {
    let width = layout
        .rows
        .iter()
        .map(|row| row.width)
        .fold(px(0.), |a: Pixels, b| if b > a { b } else { a });
    size(width, line_height * layout.rows.len() as f32)
}

impl Element for TextBody {
    type RequestLayoutState = ();
    type PrepaintState = BodyPrepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();

        if !self.multi_line && !self.fit_content {
            // One row, always: the height is the line box and the width is
            // whatever the flex parent gives.
            style.size.width = relative(1.).into();
            style.size.height = self.line_height.into();
            return (window.request_layout(style, [], cx), ());
        }

        // Both remaining shapes have to measure. A wrapping field's *height* is
        // a function of its width, and a fit-to-content field's *width* is a
        // function of its text -- and taffy only offers either during
        // measurement, which is the shape gpui's own text element uses
        // (`elements/text.rs:647`).
        if !self.fit_content {
            style.size.width = relative(1.).into();
        }
        let body = self.clone();
        let fit_content = self.fit_content;
        let line_height = self.line_height;
        let layout_id = window.request_measured_layout(
            style,
            move |known_dimensions, available_space, window, cx| {
                if fit_content {
                    let size = body.ensure_layout(None, window, cx);
                    // One pixel of slack so the caret at the very end is inside
                    // the element rather than on its edge.
                    return gpui::size(size.width + px(1.), line_height);
                }
                let wrap_width = known_dimensions.width.or(match available_space.width {
                    gpui::AvailableSpace::Definite(width) => Some(width),
                    _ => None,
                });
                let size = body.ensure_layout(wrap_width, window, cx);
                gpui::size(wrap_width.unwrap_or(size.width), size.height)
            },
        );
        (layout_id, ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let wrap_width = (self.multi_line && !self.fit_content).then_some(bounds.size.width);
        self.ensure_layout(wrap_width, window, cx);

        let placeholder = {
            let read = self.state.read(cx);
            read.content.is_empty().then(|| read.placeholder.clone())
        }
        .filter(|placeholder| !placeholder.is_empty())
        .map(|placeholder| {
            let mut font = window.text_style().font();
            font.weight = self.weight;
            let run = TextRun {
                len: placeholder.len(),
                font,
                color: self.placeholder_color,
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            window
                .text_system()
                .shape_line(placeholder, self.text_size, &[run], None)
        });

        self.state.update(cx, |state, _| {
            state.text_bounds = Some(bounds);
            state.line_height = self.line_height;
            state.align = self.align;
        });

        let layout = self.layout.borrow();
        let state = self.state.read(cx);
        let Some(layout) = layout.as_ref() else {
            return BodyPrepaint {
                placeholder,
                selection: Vec::new(),
                caret: None,
                scroll_x: px(0.),
            };
        };

        // A single-line field scrolls horizontally to keep the caret in view;
        // a wrapping one never scrolls sideways at all.
        let caret_offset = state.cursor_offset();
        let caret_row = layout.row_for_offset(caret_offset);
        let caret_x = state.align_offset(layout, caret_row, bounds.size.width)
            + layout.x_for_offset(caret_offset, self.line_height);
        // An unfocused single-line field shows its start, the way an `<input>`
        // that has lost focus does -- otherwise a long value that was last
        // edited at its end reads as a fragment of itself.
        let scroll_x = if self.multi_line || !self.focused {
            px(0.)
        } else {
            let content_width = layout.rows.first().map(|row| row.width).unwrap_or(px(0.));
            let max_scroll = (content_width - bounds.size.width).max(px(0.));
            let mut scroll = state.scroll_x.min(max_scroll).max(px(0.));
            if caret_x - scroll < px(0.) {
                scroll = caret_x;
            } else if caret_x - scroll > bounds.size.width - px(1.) {
                scroll = caret_x - bounds.size.width + px(1.);
            }
            scroll.min(max_scroll).max(px(0.))
        };

        // The selection wash, one quad per visual row it crosses.
        let selected = state.selected_range.clone();
        let mut selection = Vec::new();
        if !selected.is_empty() {
            for (index, row) in layout.rows.iter().enumerate() {
                let start = selected.start.max(row.range.start);
                let end = selected.end.min(row.range.end);
                if start > end {
                    continue;
                }
                if start == end && !(selected.start <= row.range.start && selected.end > row.range.end)
                {
                    continue;
                }
                let align = state.align_offset(layout, index, bounds.size.width);
                let left = bounds.left() + align + layout.x_for_offset(start, self.line_height)
                    - scroll_x;
                // A selection that runs past this row's end paints to the row's
                // full width, which is what shows a selected newline.
                let right = if selected.end > row.range.end {
                    bounds.left() + align + row.width - scroll_x
                } else {
                    bounds.left() + align + layout.x_for_offset(end, self.line_height) - scroll_x
                };
                let top = bounds.top() + self.line_height * index as f32;
                selection.push(fill(
                    Bounds::from_corners(
                        point(left, top),
                        point(right.max(left + px(1.)), top + self.line_height),
                    ),
                    self.selection_color,
                ));
            }
        }

        let caret = (self.focused && selected.is_empty()).then(|| {
            let top = bounds.top() + self.line_height * caret_row as f32;
            fill(
                Bounds::new(
                    point(bounds.left() + caret_x - scroll_x, top),
                    gpui::size(px(1.), self.line_height),
                ),
                self.caret_color,
            )
        });

        BodyPrepaint {
            placeholder,
            selection,
            caret,
            scroll_x,
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.state.read(cx).focus.clone();
        // The IME seam. Only installed for the focused field --
        // `Window::handle_input` checks that itself (`window.rs:4769`), so every
        // field can call it unconditionally.
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.state.clone()),
            cx,
        );
        self.state.update(cx, |state, _| {
            state.scroll_x = prepaint.scroll_x;
        });

        for quad in prepaint.selection.drain(..) {
            window.paint_quad(quad);
        }

        if let Some(placeholder) = prepaint.placeholder.take() {
            let x = match self.align {
                TextAlign::Left => bounds.left(),
                TextAlign::Center => bounds.left() + (bounds.size.width - placeholder.width()) / 2.,
                TextAlign::Right => bounds.left() + bounds.size.width - placeholder.width(),
            };
            placeholder
                .paint(
                    point(x, bounds.top()),
                    self.line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                )
                .ok();
        } else {
            let mut origin = point(bounds.left() - prepaint.scroll_x, bounds.top());
            // `WrappedLine` is not `Clone`, so the layout is borrowed for the
            // whole paint rather than lifted out of the cell one line at a
            // time -- which is exactly why it lives in an `Rc<RefCell<..>>`
            // and not inside the entity.
            let layout = self.layout.borrow();
            if let Some(layout) = layout.as_ref() {
                for line in layout.lines.iter() {
                    let height = line.size(self.line_height).height;
                    line.paint(origin, self.line_height, self.align, Some(bounds), window, cx)
                        .ok();
                    origin.y += height;
                }
            }
        }

        if let Some(caret) = prepaint.caret.take() {
            window.paint_quad(caret);
        }

        // Drag-select keeps tracking outside the field's own bounds, which a
        // listener on the element cannot do -- the same reason `ui::Slider`
        // needs its drag layer.
        if self.state.read(cx).drag.is_some() {
            let state = self.state.clone();
            window.on_mouse_event({
                let state = state.clone();
                move |event: &MouseMoveEvent, phase, window: &mut Window, cx: &mut App| {
                    if phase == gpui::DispatchPhase::Bubble {
                        state.update(cx, |this, cx| this.on_mouse_move(event, window, cx));
                    }
                }
            });
            window.on_mouse_event(move |event: &MouseUpEvent, phase, window: &mut Window, cx: &mut App| {
                if phase == gpui::DispatchPhase::Bubble {
                    state.update(cx, |this, cx| this.on_mouse_up(event, window, cx));
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- Word navigation ------------------------------------------------------

    /// `alt-left` skips the run of separators first, then the word, which is
    /// what makes it land on the *start* of the previous word rather than on
    /// the space in front of it.
    #[test]
    fn alt_left_lands_on_the_start_of_the_previous_word() {
        let text = "the quick brown fox";
        assert_eq!(word_start_before(text, text.len()), 16); // "fox"
        assert_eq!(word_start_before(text, 16), 10); // "brown"
        assert_eq!(word_start_before(text, 12), 10); // mid-word -> its start
        assert_eq!(word_start_before(text, 0), 0);
    }

    #[test]
    fn alt_right_lands_on_the_end_of_the_next_word() {
        let text = "the quick brown fox";
        assert_eq!(word_end_after(text, 0), 3);
        assert_eq!(word_end_after(text, 3), 9);
        assert_eq!(word_end_after(text, 5), 9); // mid-word -> its end
        assert_eq!(word_end_after(text, text.len()), text.len());
    }

    /// Punctuation is a separator, not a word character, so `{target_name}`
    /// walks in three steps -- which is the behaviour the settings window's
    /// project-name template needs.
    #[test]
    fn punctuation_separates_words() {
        let text = "{target_name} ({date})";
        assert_eq!(word_end_after(text, 0), 12); // "target_name"
        assert_eq!(word_start_before(text, 12), 1);
        assert_eq!(word_end_after(text, 12), 20); // "date"
    }

    #[test]
    fn word_navigation_is_utf8_safe() {
        let text = "héllo wörld";
        assert_eq!(word_end_after(text, 0), "héllo".len());
        assert_eq!(word_start_before(text, text.len()), "héllo ".len());
        // Never lands inside a multi-byte scalar.
        for offset in 0..=text.len() {
            if !text.is_char_boundary(offset) {
                continue;
            }
            assert!(text.is_char_boundary(word_start_before(text, offset)));
            assert!(text.is_char_boundary(word_end_after(text, offset)));
        }
    }

    // -- Double- and triple-click ---------------------------------------------

    #[test]
    fn double_click_selects_the_word_under_the_caret() {
        let text = "the quick brown fox";
        assert_eq!(word_at(text, 12), 10..15); // inside "brown"
        assert_eq!(word_at(text, 10), 10..15); // on its first character
        assert_eq!(word_at(text, 15), 15..16); // on the space after it
        // At the very end, the last word rather than an empty range.
        assert_eq!(word_at(text, text.len()), 16..19);
        assert_eq!(word_at("", 0), 0..0);
    }

    #[test]
    fn triple_click_selects_the_paragraph() {
        let text = "first line\nsecond line\nthird";
        assert_eq!(paragraph_start(text, 0), 0);
        assert_eq!(paragraph_end(text, 0), 10);
        assert_eq!(paragraph_start(text, 15), 11);
        assert_eq!(paragraph_end(text, 15), 22);
        // The newline itself belongs to the line it terminates.
        assert_eq!(paragraph_start(text, 10), 0);
        assert_eq!(paragraph_start(text, 11), 11);
        assert_eq!(paragraph_end(text, 23), text.len());
    }

    /// A field with no newlines has exactly one paragraph, so `cmd-left` and
    /// `cmd-right` are Home and End -- which is why the two share an action.
    #[test]
    fn a_single_line_field_has_one_paragraph() {
        let text = "just one line";
        assert_eq!(paragraph_start(text, 7), 0);
        assert_eq!(paragraph_end(text, 7), text.len());
    }

    // -- Selection ------------------------------------------------------------

    #[test]
    fn shift_arrow_extends_and_flips_across_the_anchor() {
        // Extending forwards from a caret at 5.
        let (range, reversed) = extend_selection(5..5, false, 8);
        assert_eq!((range.clone(), reversed), (5..8, false));
        // Extending further forwards.
        let (range, reversed) = extend_selection(range, reversed, 11);
        assert_eq!((range.clone(), reversed), (5..11, false));
        // Back past the anchor: the direction flips and the anchor is kept.
        let (range, reversed) = extend_selection(range, reversed, 2);
        assert_eq!((range.clone(), reversed), (2..5, true));
        // ...and extending again now moves the *start*.
        let (range, reversed) = extend_selection(range, reversed, 0);
        assert_eq!((range, reversed), (0..5, true));
    }

    #[test]
    fn extending_back_onto_the_anchor_empties_the_selection() {
        let (range, reversed) = extend_selection(5..9, false, 5);
        assert_eq!((range, reversed), (5..5, false));
    }

    // -- Graphemes ------------------------------------------------------------

    /// Backspace deletes a user-perceived character. A flag is two scalars and
    /// eight bytes; one press has to take all of it.
    #[test]
    fn backspace_walks_graphemes_not_bytes() {
        let text = "a🇬🇧b";
        let flag_len = "🇬🇧".len();
        assert_eq!(previous_grapheme(text, text.len()), 1 + flag_len);
        assert_eq!(previous_grapheme(text, 1 + flag_len), 1);
        assert_eq!(next_grapheme(text, 1), 1 + flag_len);
        assert_eq!(next_grapheme(text, text.len()), text.len());
    }

    #[test]
    fn a_combining_accent_is_one_grapheme() {
        let text = "e\u{301}"; // e + combining acute
        assert_eq!(previous_grapheme(text, text.len()), 0);
    }

    // -- utf-16, the input protocol's unit ------------------------------------

    #[test]
    fn utf16_offsets_round_trip_through_astral_characters() {
        let text = "a😀b"; // 'a' + 4-byte emoji (2 utf-16 units) + 'b'
        assert_eq!(offset_to_utf16(text, 0), 0);
        assert_eq!(offset_to_utf16(text, 1), 1);
        assert_eq!(offset_to_utf16(text, 5), 3);
        assert_eq!(offset_to_utf16(text, 6), 4);
        assert_eq!(offset_from_utf16(text, 0), 0);
        assert_eq!(offset_from_utf16(text, 1), 1);
        assert_eq!(offset_from_utf16(text, 3), 5);
        assert_eq!(offset_from_utf16(text, 4), 6);
    }

    // -- Single-line flattening ------------------------------------------------

    #[test]
    fn a_pasted_newline_becomes_a_space_in_a_single_line_field() {
        assert_eq!(flatten_single_line("one\ntwo"), "one two");
        assert_eq!(flatten_single_line("one\r\ntwo"), "one  two");
        assert_eq!(flatten_single_line("no breaks"), "no breaks");
    }

    // -- Undo grouping ---------------------------------------------------------

    #[test]
    fn typed_characters_coalesce_into_one_undo_step() {
        assert!(!undo_coalesces(None, UndoGroup::Typing));
        assert!(undo_coalesces(Some(UndoGroup::Typing), UndoGroup::Typing));
        assert!(undo_coalesces(Some(UndoGroup::Deleting), UndoGroup::Deleting));
        // Typing then deleting is two steps, and back again is a third.
        assert!(!undo_coalesces(Some(UndoGroup::Typing), UndoGroup::Deleting));
        assert!(!undo_coalesces(Some(UndoGroup::Deleting), UndoGroup::Typing));
        // A paste is always its own step, even after another paste.
        assert!(!undo_coalesces(Some(UndoGroup::Discrete), UndoGroup::Discrete));
    }

    // -- Caret maths across wrapped rows ---------------------------------------

    /// A stand-in text system: every row holds exactly `per_row` characters and
    /// every character is `advance` wide. That is enough to exercise the row
    /// table, which is the only part of the wrapping that is ours.
    fn wrapped(text: &str, per_row: usize, line_height: f32) -> (Vec<usize>, usize, Vec<usize>) {
        let boundaries: Vec<usize> = text
            .char_indices()
            .map(|(index, _)| index)
            .chain(std::iter::once(text.len()))
            .collect();
        let row_count = boundaries.len().div_ceil(per_row).max(1);
        let y_of = |index: usize| {
            // Mirrors gpui: an index that lands on a boundary reports the row
            // it *ends*, so the row index is `ceil(index / per_row) - 1`.
            let row = if index == 0 {
                0
            } else {
                index.div_ceil(per_row).saturating_sub(1)
            };
            row as f32 * line_height
        };
        let starts = row_starts(&boundaries, row_count, line_height, y_of);
        (boundaries, row_count, starts)
    }

    #[test]
    fn row_starts_follow_the_wrap_boundaries() {
        // 12 ASCII characters, 4 per row -> rows start at 0, 4, 8.
        let (_, row_count, starts) = wrapped("abcdefghijkl", 4, 20.);
        assert_eq!(row_count, 4); // 13 boundaries / 4, rounded up
        assert_eq!(&starts[..3], &[0, 4, 8]);
    }

    #[test]
    fn a_paragraph_that_does_not_wrap_has_one_row() {
        let (_, row_count, starts) = wrapped("short", 40, 20.);
        assert_eq!(row_count, 1);
        assert_eq!(starts, vec![0]);
    }

    #[test]
    fn row_starts_of_an_empty_paragraph_is_just_zero() {
        let (_, row_count, starts) = wrapped("", 4, 20.);
        assert_eq!(row_count, 1);
        assert_eq!(starts, vec![0]);
    }

    fn layout_of(rows: &[Range<usize>], widths: &[f32]) -> InputLayout {
        InputLayout {
            lines: SmallVec::new(),
            paragraph_starts: vec![0],
            paragraph_rows: vec![0],
            rows: rows
                .iter()
                .enumerate()
                .map(|(index, range)| Row {
                    range: range.clone(),
                    paragraph: 0,
                    local_start: range.start,
                    width: px(widths[index]),
                })
                .collect(),
            key: LayoutKey {
                text: SharedString::default(),
                wrap_width: None,
                font_size: px(12.),
                line_height: px(20.),
                weight: FontWeight::NORMAL,
                marked: None,
            },
        }
    }

    /// The caret at a soft-wrap boundary belongs to the row it *starts*, which
    /// is where it has to be after moving right onto it -- gpui's own
    /// `position_for_index` would put it at the end of the previous row.
    #[test]
    fn a_caret_on_a_wrap_boundary_takes_the_later_row() {
        let layout = layout_of(&[0..4, 4..8, 8..12], &[40., 40., 40.]);
        assert_eq!(layout.row_for_offset(0), 0);
        assert_eq!(layout.row_for_offset(3), 0);
        assert_eq!(layout.row_for_offset(4), 1);
        assert_eq!(layout.row_for_offset(7), 1);
        assert_eq!(layout.row_for_offset(8), 2);
        assert_eq!(layout.row_for_offset(12), 2);
        // Past the end still resolves to the last row rather than panicking.
        assert_eq!(layout.row_for_offset(99), 2);
    }

    #[test]
    fn the_caret_row_is_the_start_of_the_row_it_opens() {
        let layout = layout_of(&[0..4, 4..8], &[40., 40.]);
        // Offset 4 opens row 1, so its x inside that row is zero.
        assert_eq!(layout.x_for_offset(4, px(20.)), px(0.));
    }

    // -- Hex commit ------------------------------------------------------------

    /// `onInput` only commits once the text holds a complete colour
    /// (`color-utils.tsx:79-88`), which is what stops `#4` from being read as
    /// a colour halfway through typing `#4785FF`.
    #[test]
    fn a_hex_field_commits_only_at_six_or_eight_digits() {
        use crate::editor_sidebar::{hex_digit_count, hex_to_rgb};
        let commits = |value: &str| {
            let digits = hex_digit_count(value);
            (digits == 6 || digits == 8) && hex_to_rgb(value.trim()).is_some()
        };
        assert!(!commits("#4"));
        assert!(!commits("#47"));
        assert!(!commits("#478")); // a valid 3-digit colour, but not committed live
        assert!(!commits("#4785F"));
        assert!(commits("#4785FF"));
        assert!(commits("4785ff"));
        assert!(commits("#4785FF80"));
        assert!(!commits("#4785FFF"));
        assert!(!commits("nonsense"));
    }
}
