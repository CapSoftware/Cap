use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

use cap_notes::{
    BlockId, BlockKind, Change, Document, Editor, LinkAt, Mark, Match, Origin, Pos, Selection,
};
use gpui::{
    App, AppContext, Bounds, Context, Entity, EventEmitter, FocusHandle, Focusable, Hsla, Pixels,
    Point, SharedString, Subscription, Task, Window, point, px, size,
};

use crate::field::{FieldEvent, LineField};
use crate::layout::{BlockLayout, Marked};
use crate::menu::{self, Builtin, Entry, SlashAction, SlashItem};
use crate::store::{Autoscroll, FrameStats, LayoutRequest, Store};
use crate::stream;
use crate::theme::{NotesLabels, NotesTheme};

const UNDO_IDLE: Duration = Duration::from_secs(1);
const TOOLBAR_SETTLE: Duration = Duration::from_millis(150);
const TOOLTIP_DELAY: Duration = Duration::from_millis(600);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NotesEvent {
    Changed,
    SelectionChanged,
    Focused,
    Blurred,
    OpenLink(String),
    RequestMention {
        query: String,
    },
    DismissMention,
    SlashCommand(String),
    /// Every word someone else wrote into the page is now shown.
    StreamDrained,
    /// A person's name (see [`NotesEditor::set_people`]) was clicked, at
    /// this window position.
    PersonClicked {
        name: String,
        at: gpui::Point<gpui::Pixels>,
    },
    /// The pointer moved onto (or off) a point whose source is known; the
    /// key is the one given in its [`SourceMark`].
    SourceHovered(Option<u64>),
    /// A point's timestamp was clicked.
    SourceClicked(u64),
}

/// A point in text someone else wrote that came from a known place: its
/// block, the block's text length when the link was made (a stale mark is
/// never drawn), the timestamp shown after it and the host's key for it.
#[derive(Clone, Debug, PartialEq)]
pub struct SourceMark {
    pub block: usize,
    pub text_len: usize,
    pub label: SharedString,
    pub key: u64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct SourceHover {
    pub mark: usize,
    pub on_label: bool,
    pub since: Instant,
}

/// Asked to scroll the host by this many pixels (positive is down) so the
/// caret stays in view, for an editor laid out at its full height.
pub type RevealHost = Rc<dyn Fn(f32, &mut App)>;

/// The nearest char boundary at or before `at`, so a stale offset can never
/// split a character.
pub(crate) fn floor_char_boundary(text: &str, at: usize) -> usize {
    let mut at = at.min(text.len());
    while !text.is_char_boundary(at) {
        at -= 1;
    }
    at
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Composition {
    pub block: usize,
    pub at: usize,
    pub text: String,
    pub caret: usize,
}

impl Composition {
    pub fn marked(&self) -> Marked {
        Marked {
            at: self.at,
            text: self.text.clone(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DragUnit {
    Char,
    Word,
    Block,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Drag {
    pub unit: DragUnit,
    pub anchor: (Pos, Pos),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Slash {
    pub block: usize,
    pub start: usize,
    pub query: String,
    pub selected: usize,
    pub serial: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mention {
    pub block: usize,
    pub start: usize,
    pub query: String,
}

pub(crate) struct LinkEdit {
    pub field: Entity<LineField>,
    pub selection: Selection,
    pub serial: u64,
    _subscription: Subscription,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ContextMenu {
    pub position: Point<Pixels>,
    pub link: Option<LinkAt>,
    pub selected: Option<usize>,
    pub serial: u64,
}

pub(crate) struct FindState {
    pub field: Entity<LineField>,
    pub query: String,
    pub matches: Vec<Match>,
    pub current: Option<usize>,
    _subscription: Subscription,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Hover {
    pub link: Option<LinkAt>,
    pub checkbox: Option<usize>,
    pub tooltip: bool,
    pub scrollbar: bool,
}

pub(crate) struct StreamTail {
    pub start: usize,
    pub count: usize,
    pub markdown: String,
    pub origin: Origin,
    pub len_after: usize,
}

impl StreamTail {
    /// The tail after the person edited the page. An edit before it shifts
    /// it; an edit inside it becomes part of the writer's unsettled markdown,
    /// so the next chunk re-parses the writer's text and theirs as one (an
    /// open bold closes around their words, a list item goes on, nothing is
    /// left over as stray markers). An edit across its start ends it.
    fn after_edit(mut self, change: cap_notes::BlockChange, doc: &Document) -> Option<Self> {
        let len = doc.blocks.len();
        let old_len = (len + change.removed).checked_sub(change.inserted)?;
        if self.len_after != old_len {
            return None;
        }
        let edit_end = change.start + change.removed;
        let tail_end = self.start + self.count;
        if edit_end <= self.start && (change.start < self.start || change.removed == 0) {
            self.start = (self.start + change.inserted).checked_sub(change.removed)?;
        } else if change.start >= self.start && edit_end <= tail_end {
            self.count = (self.count + change.inserted).checked_sub(change.removed)?;
            let edited = Document::from_blocks(
                doc.blocks
                    .get(self.start..self.start + self.count)?
                    .to_vec(),
            );
            let ending = self.markdown.len() - self.markdown.trim_end_matches('\n').len();
            let mut markdown = writer_markers(edited.to_markdown().trim_end_matches('\n'));
            markdown.push_str(&self.markdown[self.markdown.len() - ending..]);
            self.markdown = markdown;
        } else if change.start < tail_end {
            return None;
        }
        self.len_after = len;
        Some(self)
    }
}

/// The tail written back as the writer would go on from it: the export
/// escapes a literal `*` (an unclosed bold is literal text until its closer
/// arrives), which would keep the writer's closer from pairing with it.
/// Escaped backslashes and brackets stay as they are.
pub(crate) fn writer_markers(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut chars = markdown.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('*' | '_' | '~' | '=' | '`') => continue,
                Some('\\') => {
                    out.push('\\');
                    out.push(chars.next().unwrap_or('\\'));
                    continue;
                }
                _ => {}
            }
        }
        out.push(c);
    }
    out
}

/// Text someone else writes arrives in bursts; the page shows it at a steady
/// pace instead, a few whole words at a time, so it reads like ink rather
/// than a terminal. The backlog is never more than about half a second.
#[derive(Default)]
pub(crate) struct Pacer {
    pending: String,
    origin: Option<Origin>,
    /// The writer is done: what is left is shown, then the page settles.
    finishing: bool,
    /// The last released text ended a line, so the next word starts a block.
    at_line_start: bool,
    task: Option<Task<()>>,
}

/// One release every this long.
pub(crate) const PACE_TICK: Duration = Duration::from_millis(33);
/// The backlog is shown within about this long.
const PACE_DRAIN: f32 = 0.5;
/// Never faster than this many words a tick (about 180 words a second).
const PACE_MAX_WORDS: usize = 6;

impl Pacer {
    pub fn is_active(&self) -> bool {
        !self.pending.is_empty() || self.task.is_some()
    }
}

/// The block marker a line of markdown starts with ("### ", "- [ ] ", "1. "),
/// released with the line's first word so a bullet never shows half made.
fn line_marker(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i] == b' ' {
        i += 1;
    }
    let start = i;
    let rest = &text[start..];
    let hashes = rest.bytes().take_while(|b| *b == b'#').count();
    if (1..=6).contains(&hashes) && rest[hashes..].starts_with(' ') {
        return start + hashes + 1;
    }
    for task in ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] "] {
        if rest.starts_with(task) {
            return start + task.len();
        }
    }
    for bullet in ["- ", "* ", "+ ", "> "] {
        if rest.starts_with(bullet) {
            return start + bullet.len();
        }
    }
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && (rest[digits..].starts_with(". ") || rest[digits..].starts_with(") ")) {
        return start + digits + 2;
    }
    0
}

/// The end of the next `count` whole words of `text` (each with the spaces
/// and newlines after it), or None when not even one word is complete yet.
/// `last` releases an unfinished final word too.
pub(crate) fn release_end(text: &str, count: usize, line_start: bool, last: bool) -> Option<usize> {
    let mut at = 0;
    let mut released = 0;
    let mut start_of_line = line_start;
    while released < count && at < text.len() {
        let from = if start_of_line {
            at + line_marker(&text[at..])
        } else {
            at
        };
        let rest = &text[from..];
        let word = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let after = &rest[word..];
        let space = after.len() - after.trim_start().len();
        if (space == 0 && !last) || (word == 0 && space == 0) {
            // The word may still be growing.
            break;
        }
        start_of_line = after[..space].contains('\n');
        at = from + word + space;
        released += 1;
    }
    (at > 0 && released > 0).then_some(at)
}

#[derive(Default)]
pub(crate) struct Tasks {
    pub undo: Option<Task<()>>,
    pub blink: Option<(Instant, Task<()>)>,
    pub toolbar: Option<Task<()>>,
    pub tooltip: Option<Task<()>>,
    pub scrollbar: Option<Task<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct CheckAnim {
    pub id: BlockId,
    pub started: Instant,
}

pub struct NotesEditor {
    pub(crate) editor: Editor,
    pub(crate) focus: FocusHandle,
    pub(crate) theme: NotesTheme,
    pub(crate) labels: NotesLabels,
    pub(crate) store: Rc<RefCell<Store>>,
    pub(crate) read_only: bool,
    pub(crate) placeholder: SharedString,
    pub(crate) goal_x: Option<f32>,
    pub(crate) upstream: bool,
    pub(crate) composition: Option<Composition>,
    pub(crate) drag: Option<Drag>,
    pub(crate) slash: Option<Slash>,
    pub(crate) mention: Option<Mention>,
    pub(crate) link_edit: Option<LinkEdit>,
    pub(crate) menu: Option<ContextMenu>,
    pub(crate) find: Option<FindState>,
    pub(crate) toolbar_visible: bool,
    pub(crate) toolbar_serial: u64,
    pub(crate) hover: Hover,
    pub(crate) caret_epoch: Instant,
    pub(crate) checks: Vec<CheckAnim>,
    pub(crate) extra_slash: Vec<SlashItem>,
    pub(crate) stream: Option<StreamTail>,
    pub(crate) pacer: Pacer,
    /// Names shown as soft pills in text someone else wrote, each in its own
    /// colour; clicking one asks the host to rename that person.
    pub(crate) people: Vec<(String, Hsla)>,
    /// Laid out at its full height inside a host that scrolls it.
    pub(crate) fit: bool,
    pub(crate) reveal_host: Option<RevealHost>,
    pub(crate) sources: Vec<SourceMark>,
    pub(crate) source_hover: Option<SourceHover>,
    pub(crate) serial: u64,
    pub(crate) tasks: Tasks,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<NotesEvent> for NotesEditor {}

impl Focusable for NotesEditor {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct DebugStats {
    pub frame: FrameStats,
    pub blocks: usize,
}

impl NotesEditor {
    pub fn new(
        document: Document,
        theme: NotesTheme,
        labels: NotesLabels,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        let editor = Editor::new(document);
        let store = Rc::new(RefCell::new(Store::default()));
        store.borrow_mut().reset(editor.document(), &theme);
        let subscriptions = vec![
            cx.on_focus(&focus, window, |this: &mut Self, _, cx| {
                this.caret_epoch = Instant::now();
                cx.emit(NotesEvent::Focused);
                cx.notify();
            }),
            cx.on_blur(&focus, window, |this: &mut Self, window, cx| {
                this.drag = None;
                this.toolbar_visible = false;
                this.slash = None;
                if this.composition.is_some() {
                    this.commit_composition(window, cx);
                }
                cx.emit(NotesEvent::Blurred);
                cx.notify();
            }),
            cx.observe_window_activation(window, |this: &mut Self, _, cx| {
                this.caret_epoch = Instant::now();
                cx.notify();
            }),
        ];
        let placeholder = labels.placeholder.clone();
        Self {
            editor,
            focus,
            theme,
            labels,
            store,
            read_only: false,
            placeholder,
            goal_x: None,
            upstream: false,
            composition: None,
            drag: None,
            slash: None,
            mention: None,
            link_edit: None,
            menu: None,
            find: None,
            toolbar_visible: false,
            toolbar_serial: 0,
            hover: Hover::default(),
            caret_epoch: Instant::now(),
            checks: Vec::new(),
            extra_slash: Vec::new(),
            stream: None,
            pacer: Pacer::default(),
            people: Vec::new(),
            fit: false,
            reveal_host: None,
            sources: Vec::new(),
            source_hover: None,
            serial: 0,
            tasks: Tasks::default(),
            _subscriptions: subscriptions,
        }
    }

    pub fn document(&self) -> &Document {
        self.editor.document()
    }

    pub fn editor(&self) -> &Editor {
        &self.editor
    }

    pub fn set_document(&mut self, document: Document, cx: &mut Context<Self>) {
        self.editor.set_document(document);
        self.composition = None;
        self.slash = None;
        self.mention = None;
        self.menu = None;
        self.link_edit = None;
        self.stream = None;
        self.pacer = Pacer::default();
        self.drag = None;
        self.hover = Hover::default();
        self.toolbar_visible = false;
        {
            let mut store = self.store.borrow_mut();
            store.reset(self.editor.document(), &self.theme);
            // A new document is not the text that was being written in.
            store.reveal = None;
        }
        self.refresh_find();
        cx.emit(NotesEvent::Changed);
        cx.emit(NotesEvent::SelectionChanged);
        cx.notify();
    }

    /// Someone else is writing into this page (`append_markdown_streaming`):
    /// new words fade in where they land and a soft caret breathes after the
    /// last one. `false` lets the caret fade out; nothing moves.
    pub fn set_writing(&mut self, writing: bool, cx: &mut Context<Self>) {
        let now = Instant::now();
        let mut store = self.store.borrow_mut();
        if writing {
            if store.reveal.as_ref().is_none_or(|r| !r.writing) {
                store.reveal = Some(crate::reveal::Reveal::new(self.editor.document()));
                store.reveal_epoch = Some(now);
            }
        } else if self.pacer.is_active() {
            // The writer is done but words are still on their way: the page
            // settles once the last of them is shown.
            self.pacer.finishing = true;
            drop(store);
            if self.pacer.task.is_none() {
                self.release_words(cx);
            }
            cx.notify();
            return;
        } else if let Some(reveal) = store.reveal.as_mut() {
            reveal.end(now);
        }
        drop(store);
        cx.notify();
    }

    pub fn is_writing(&self) -> bool {
        self.store
            .borrow()
            .reveal
            .as_ref()
            .is_some_and(|r| r.writing)
    }

    pub fn set_theme(&mut self, theme: NotesTheme, cx: &mut Context<Self>) {
        if theme == self.theme {
            return;
        }
        self.theme = theme;
        {
            let mut store = self.store.borrow_mut();
            store.epoch += 1;
            store.invalidate_all();
            store.rebuild_heights(self.editor.document(), &self.theme);
        }
        if let Some(find) = &self.find {
            let theme = self.theme.clone();
            find.field.update(cx, |field, _| field.set_theme(theme));
        }
        if let Some(edit) = &self.link_edit {
            let theme = self.theme.clone();
            edit.field.update(cx, |field, _| field.set_theme(theme));
        }
        cx.notify();
    }

    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    pub fn set_read_only(&mut self, read_only: bool, cx: &mut Context<Self>) {
        if self.read_only == read_only {
            return;
        }
        self.read_only = read_only;
        self.composition = None;
        self.slash = None;
        self.mention = None;
        self.link_edit = None;
        cx.notify();
    }

    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.placeholder = placeholder.into();
        cx.notify();
    }

    pub fn set_max_content_width(&mut self, width: Pixels, cx: &mut Context<Self>) {
        self.theme.max_content_width = width;
        cx.notify();
    }

    pub fn extra_slash_items(&mut self, items: Vec<SlashItem>) {
        self.extra_slash = items;
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus, cx);
    }

    pub fn scroll_to_block(&mut self, index: usize, cx: &mut Context<Self>) {
        let index = index.min(self.editor.document().blocks.len().saturating_sub(1));
        self.store.borrow_mut().autoscroll = Some(Autoscroll::Block(index));
        cx.notify();
    }

    pub fn apply(&mut self, f: impl FnOnce(&mut Editor) -> Change, cx: &mut Context<Self>) {
        let before = self.editor.selection();
        self.composition = None;
        let change = f(&mut self.editor);
        self.after_edit(change, before, false, cx);
    }

    pub fn insert_mention(&mut self, id: impl Into<String>, label: &str, cx: &mut Context<Self>) {
        let Some(mention) = self.mention.take() else {
            return;
        };
        if self.read_only {
            return;
        }
        let head = self.editor.selection().head;
        let end = if head.block == mention.block {
            head.offset
        } else {
            mention.start + 1 + mention.query.len()
        };
        let before = self.editor.selection();
        let id = id.into();
        let mut change = self.editor.delete_range(
            Pos::new(mention.block, mention.start),
            Pos::new(mention.block, end),
        );
        change = change.merge(self.editor.toggle_mark(Mark::Mention { id }));
        change = change.merge(self.editor.insert_text(label));
        change = change.merge(self.editor.insert_text(" "));
        cx.emit(NotesEvent::DismissMention);
        self.after_edit(change, before, false, cx);
    }

    pub fn dismiss_mention(&mut self, cx: &mut Context<Self>) {
        if self.mention.take().is_some() {
            cx.emit(NotesEvent::DismissMention);
            cx.notify();
        }
    }

    pub fn caret_bounds(&self) -> Option<Bounds<Pixels>> {
        let store = self.store.borrow();
        let head = self.editor.selection().head;
        let painted = store.painted(head.block)?;
        let layout = store.slots.get(head.block)?.layout.as_ref()?;
        let caret = layout.caret(layout.to_virtual(head.offset), self.upstream);
        Some(Bounds::new(
            point(
                px(painted.text_left + caret.x),
                px(painted.text_top + caret.top),
            ),
            size(px(1.), px(caret.height)),
        ))
    }

    /// The engine has no public way to insert blocks that keep
    /// `Origin::Generated`, so the tail is spliced by rebuilding the document,
    /// which also clears the undo history.
    pub fn append_markdown_streaming(
        &mut self,
        chunk: &str,
        origin: Origin,
        cx: &mut Context<Self>,
    ) {
        if chunk.is_empty() {
            return;
        }
        // Pacing is part of showing someone write; without that (or with
        // reduced motion) the text lands as it comes, unless it would rewrite
        // the block holding an IME composition: then it waits in the pacer
        // until the composition is committed or cancelled.
        if (cx.reduce_motion() || (!self.is_writing() && !self.pacer.is_active()))
            && !self.composing_in_stream(origin)
        {
            self.apply_stream_chunk(chunk, origin, cx);
            return;
        }
        if self.pacer.pending.is_empty() && self.pacer.task.is_none() {
            self.pacer.at_line_start = self
                .stream
                .as_ref()
                .is_none_or(|tail| tail.markdown.is_empty() || tail.markdown.ends_with('\n'));
        }
        self.pacer.pending.push_str(chunk);
        self.pacer.origin = Some(origin);
        if self.pacer.task.is_none() {
            // The first words show at once; the rest follow at the pace.
            self.release_words(cx);
            self.tick_pacer(cx);
        }
    }

    fn tick_pacer(&mut self, cx: &mut Context<Self>) {
        self.pacer.task = Some(cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(PACE_TICK).await;
                let more = this
                    .update(cx, |this, cx| this.release_words(cx))
                    .unwrap_or(false);
                if !more {
                    break;
                }
            }
        }));
    }

    /// The first block a chunk of `origin` would re-parse.
    fn stream_start(&self, origin: Origin) -> usize {
        let doc = self.editor.document();
        let len = doc.blocks.len();
        match self.stream.as_ref() {
            Some(tail) if tail.len_after == len && tail.origin == origin => tail.start,
            _ if len == 1
                && doc.blocks[0].kind.is_paragraph_like()
                && doc.blocks[0].text.is_empty() =>
            {
                0
            }
            _ => len,
        }
    }

    /// An IME composition sits in the blocks the next chunk re-parses, where
    /// applying it would throw the composed text away.
    fn composing_in_stream(&self, origin: Origin) -> bool {
        self.composition
            .as_ref()
            .is_some_and(|c| c.block >= self.stream_start(origin))
    }

    /// Lay the page out at its full height so a host can scroll it with
    /// other content; `reveal` scrolls the host to keep the caret in view.
    pub fn set_fit(&mut self, fit: bool, reveal: Option<RevealHost>, cx: &mut Context<Self>) {
        self.reveal_host = reveal;
        if self.fit != fit {
            self.fit = fit;
            {
                let mut store = self.store.borrow_mut();
                store.set_scroll_y(0.);
                store.autoscroll = None;
            }
            cx.notify();
        }
    }

    pub fn is_fit(&self) -> bool {
        self.fit
    }

    /// The page's full height at this width, laying out only the blocks
    /// that changed. Lets a host size a cached page before it is drawn.
    pub fn fit_height(&mut self, width: Pixels, window: &mut Window) -> Pixels {
        gpui::px(self.measure_fit(width, window))
    }

    /// Points whose source is known, each with its timestamp.
    pub fn set_sources(&mut self, sources: Vec<SourceMark>, cx: &mut Context<Self>) {
        if self.sources != sources {
            self.sources = sources;
            self.source_hover = None;
            cx.notify();
        }
    }

    /// Show a point as hovered, as if the pointer were on it (for scripted
    /// checks and screenshots).
    pub fn show_source_hover(&mut self, mark: Option<usize>, cx: &mut Context<Self>) {
        self.source_hover = mark.map(|mark| SourceHover {
            mark,
            on_label: false,
            since: Instant::now(),
        });
        cx.notify();
    }

    /// The people named in this page, as pills in Cap's text.
    pub fn set_people(&mut self, people: Vec<(String, Hsla)>, cx: &mut Context<Self>) {
        if self.people != people {
            self.people = people;
            cx.notify();
        }
    }

    /// Words still waiting to be shown, or a pace still running.
    pub fn is_pacing(&self) -> bool {
        self.pacer.is_active()
    }

    /// One tick of the pacer. False once everything is shown.
    fn release_words(&mut self, cx: &mut Context<Self>) -> bool {
        let origin = self.pacer.origin.unwrap_or(Origin::Generated);
        if !self.pacer.pending.is_empty() && self.composing_in_stream(origin) {
            // Held for the composition; the next tick after it ends shows it.
            if self.pacer.task.is_none() {
                self.tick_pacer(cx);
            }
            return true;
        }
        let pending = &self.pacer.pending;
        let words = pending.split_whitespace().count();
        let finishing = self.pacer.finishing || !self.is_writing();
        let count = ((words as f32) * PACE_TICK.as_secs_f32() / PACE_DRAIN)
            .ceil()
            .clamp(1., PACE_MAX_WORDS as f32) as usize;
        // Reduced motion never paces; text held for a composition lands whole.
        let end = if cx.reduce_motion() {
            pending.len()
        } else {
            release_end(pending, count, self.pacer.at_line_start, finishing)
                .unwrap_or(if finishing { pending.len() } else { 0 })
        };
        if end > 0 {
            let chunk: String = self.pacer.pending.drain(..end).collect();
            self.pacer.at_line_start = chunk.ends_with('\n');
            self.apply_stream_chunk(&chunk, origin, cx);
        }
        if self.pacer.pending.is_empty() && (finishing || end == 0) {
            self.pacer.task = None;
            if finishing {
                self.pacer.finishing = false;
                if let Some(reveal) = self.store.borrow_mut().reveal.as_mut() {
                    reveal.end(Instant::now());
                }
                cx.emit(NotesEvent::StreamDrained);
                cx.notify();
            }
            return false;
        }
        true
    }

    fn apply_stream_chunk(&mut self, chunk: &str, origin: Origin, cx: &mut Context<Self>) {
        if chunk.is_empty() {
            return;
        }
        let selection = self.editor.selection();
        let doc = self.editor.document();
        let len = doc.blocks.len();
        let reusable = self
            .stream
            .as_ref()
            .is_some_and(|tail| tail.len_after == len && tail.origin == origin);
        if !reusable {
            let blank =
                len == 1 && doc.blocks[0].kind.is_paragraph_like() && doc.blocks[0].text.is_empty();
            self.stream = Some(StreamTail {
                start: if blank { 0 } else { len },
                count: if blank { 1 } else { 0 },
                markdown: String::new(),
                origin,
                len_after: len,
            });
        }
        let Some(mut tail) = self.stream.take() else {
            return;
        };
        tail.markdown.push_str(chunk);
        let settled = stream::settled_prefix(&tail.markdown);
        let mut next_id = doc.max_id() + 1;
        let mut fresh = |markdown: &str| -> Vec<cap_notes::Block> {
            let parsed = Document::from_markdown(markdown);
            let empty = parsed.blocks.len() == 1
                && parsed.blocks[0].kind.is_paragraph_like()
                && parsed.blocks[0].text.is_empty();
            if empty {
                return Vec::new();
            }
            parsed
                .blocks
                .into_iter()
                .map(|mut block| {
                    block.id = BlockId(next_id);
                    next_id += 1;
                    block.origin = origin;
                    block
                })
                .collect()
        };
        let mut blocks = Vec::new();
        let mut settled_count = 0;
        if settled > 0 {
            let done = fresh(&tail.markdown[..settled]);
            settled_count = done.len();
            blocks.extend(done);
            tail.markdown.drain(..settled);
        }
        blocks.extend(fresh(&tail.markdown));
        let start = tail.start.min(len);
        let end = (tail.start + tail.count).min(len);
        let mut next_doc = doc.clone();
        let inserted = blocks.len();
        next_doc.blocks.splice(start..end, blocks);
        if next_doc.blocks.is_empty() {
            next_doc = Document::new();
        }
        let new_len = next_doc.blocks.len();
        self.editor.set_document(next_doc);
        self.editor
            .set_selection(self.editor.clamp_selection(selection));
        // Marked text is not in the document, so its offset into a re-parsed
        // block no longer means anything.
        if self.composition.as_ref().is_some_and(|c| c.block >= start) {
            self.composition = None;
        }
        {
            let mut store = self.store.borrow_mut();
            if store.slots.len() == len {
                let real_inserted = new_len + (end - start) - len;
                store.splice(
                    start,
                    end - start,
                    real_inserted,
                    self.editor.document(),
                    &self.theme,
                );
            } else {
                store.reset(self.editor.document(), &self.theme);
            }
        }
        if let Some(reveal) = self.store.borrow_mut().reveal.as_mut() {
            reveal.grew(self.editor.document(), Instant::now());
        }
        tail.start = start + settled_count;
        tail.count = inserted.saturating_sub(settled_count);
        tail.len_after = new_len;
        self.stream = Some(tail);
        self.refresh_find();
        cx.emit(NotesEvent::Changed);
        cx.notify();
    }

    #[doc(hidden)]
    pub fn debug_stats(&self) -> DebugStats {
        let store = self.store.borrow();
        let mut frame = store.stats;
        frame.live_layouts = store.live_layouts;
        frame.painted_blocks = store.painted.len();
        DebugStats {
            frame,
            blocks: self.editor.document().blocks.len(),
        }
    }

    #[doc(hidden)]
    pub fn debug_scroll_by(&mut self, delta: f32, cx: &mut Context<Self>) -> bool {
        let at_end = {
            let mut store = self.store.borrow_mut();
            let y = store.scroll_y() + delta;
            store.set_scroll_y(y);
            store.autoscroll = None;
            store.scroll_y() >= store.max_scroll() - 0.5
        };
        self.note_scroll(cx);
        at_end
    }

    #[doc(hidden)]
    pub fn debug_mark_render_start(&self) {
        self.store.borrow_mut().stats.render_started = Some(Instant::now());
    }

    pub(crate) fn next_serial(&mut self) -> u64 {
        self.serial += 1;
        self.serial
    }

    pub(crate) fn with_layout<R>(
        &self,
        index: usize,
        window: &mut Window,
        f: impl FnOnce(&BlockLayout) -> R,
    ) -> Option<R> {
        let marked = self
            .composition
            .as_ref()
            .map(|composition| (composition.block, composition.marked()));
        let hover = self
            .hover
            .link
            .as_ref()
            .map(|link| (link.block, link.range.clone()));
        let request = LayoutRequest {
            doc: self.editor.document(),
            theme: &self.theme,
            marked: marked.as_ref().map(|(block, marked)| (*block, marked)),
            hover,
        };
        let mut store = self.store.borrow_mut();
        store.ensure(index, &request, window);
        store.slots.get(index)?.layout.as_ref().map(f)
    }

    pub(crate) fn edit(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut Editor) -> Change,
    ) -> Change {
        if self.read_only {
            return Change::default();
        }
        self.composition = None;
        let before = self.editor.selection();
        let change = f(&mut self.editor);
        self.after_edit(change, before, false, cx);
        change
    }

    pub(crate) fn after_edit(
        &mut self,
        change: Change,
        before: Selection,
        typed: bool,
        cx: &mut Context<Self>,
    ) {
        if let Some(blocks) = change.blocks {
            let mut store = self.store.borrow_mut();
            if (store.slots.len() + blocks.inserted).checked_sub(blocks.removed)
                == Some(self.editor.document().blocks.len())
            {
                store.splice(
                    blocks.start,
                    blocks.removed,
                    blocks.inserted,
                    self.editor.document(),
                    &self.theme,
                );
            } else {
                store.reset(self.editor.document(), &self.theme);
            }
            drop(store);
            self.stream = self
                .stream
                .take()
                .and_then(|tail| tail.after_edit(blocks, self.editor.document()));
            self.refresh_find();
            cx.emit(NotesEvent::Changed);
        }
        self.goal_x = None;
        self.upstream = false;
        self.toolbar_visible = false;
        self.tasks.toolbar = None;
        self.menu = None;
        if !typed {
            self.slash = None;
        }
        self.refresh_menus(cx);
        if self.editor.selection() != before {
            cx.emit(NotesEvent::SelectionChanged);
        }
        self.caret_epoch = Instant::now();
        self.store.borrow_mut().autoscroll = Some(Autoscroll::Caret);
        if change.changed() {
            self.schedule_undo_break(cx);
        }
        cx.notify();
    }

    pub(crate) fn after_motion(
        &mut self,
        before: Selection,
        keyboard: bool,
        cx: &mut Context<Self>,
    ) {
        let after = self.editor.selection();
        if after != before {
            cx.emit(NotesEvent::SelectionChanged);
        }
        self.caret_epoch = Instant::now();
        self.store.borrow_mut().autoscroll = Some(Autoscroll::Caret);
        self.menu = None;
        self.refresh_menus(cx);
        self.toolbar_visible = false;
        self.tasks.toolbar = None;
        if keyboard && !after.is_collapsed() && self.drag.is_none() {
            self.tasks.toolbar = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(TOOLBAR_SETTLE).await;
                this.update(cx, |this, cx| {
                    if !this.editor.selection().is_collapsed() && this.drag.is_none() {
                        this.show_toolbar(cx);
                    }
                })
                .ok();
            }));
        }
        cx.notify();
    }

    pub(crate) fn show_toolbar(&mut self, cx: &mut Context<Self>) {
        if !self.toolbar_visible {
            self.toolbar_visible = true;
            self.toolbar_serial = self.next_serial();
        }
        cx.notify();
    }

    fn schedule_undo_break(&mut self, cx: &mut Context<Self>) {
        self.tasks.undo = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(UNDO_IDLE).await;
            this.update(cx, |this, _| {
                this.editor.break_undo_group();
                this.tasks.undo = None;
            })
            .ok();
        }));
    }

    pub(crate) fn schedule_wake(&mut self, at: Instant, cx: &mut Context<Self>) {
        if let Some((pending, _)) = &self.tasks.blink
            && *pending <= at
            && *pending > Instant::now()
        {
            return;
        }
        let delay = at.saturating_duration_since(Instant::now());
        let task = cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| {
                this.tasks.blink = None;
                cx.notify();
            })
            .ok();
        });
        self.tasks.blink = Some((at, task));
    }

    pub(crate) fn schedule_tooltip(&mut self, cx: &mut Context<Self>) {
        self.hover.tooltip = false;
        if self.hover.link.is_none() {
            self.tasks.tooltip = None;
            return;
        }
        self.tasks.tooltip = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(TOOLTIP_DELAY).await;
            this.update(cx, |this, cx| {
                if this.hover.link.is_some() {
                    this.hover.tooltip = true;
                    cx.notify();
                }
            })
            .ok();
        }));
    }

    pub(crate) fn note_scroll(&mut self, cx: &mut Context<Self>) {
        self.store.borrow_mut().scrollbar_activity = Some(Instant::now());
        self.tasks.scrollbar = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(820))
                .await;
            this.update(cx, |_, cx| cx.notify()).ok();
        }));
        cx.notify();
    }

    pub(crate) fn refresh_find(&mut self) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        find.matches = self.editor.find(&find.query, false);
        find.current = match find.current {
            _ if find.matches.is_empty() => None,
            Some(current) => Some(current.min(find.matches.len() - 1)),
            None => None,
        };
    }

    pub(crate) fn refresh_menus(&mut self, cx: &mut Context<Self>) {
        let selection = self.editor.selection();
        let doc = self.editor.document();
        if let Some(slash) = self.slash.as_mut() {
            let valid = selection.is_collapsed()
                && selection.head.block == slash.block
                && doc.blocks.get(slash.block).is_some_and(|block| {
                    block.kind.is_paragraph_like()
                        && block
                            .text
                            .get(slash.start..)
                            .is_some_and(|rest| rest.starts_with('/'))
                        && selection.head.offset > slash.start
                });
            let query = valid
                .then(|| {
                    doc.blocks[slash.block]
                        .text
                        .get(slash.start + 1..selection.head.offset)
                        .map(str::to_string)
                })
                .flatten();
            match query {
                Some(query)
                    if !query.starts_with(char::is_whitespace)
                        && !query.contains("  ")
                        && query.chars().count() <= 40 =>
                {
                    if query != slash.query {
                        slash.query = query;
                        slash.selected = 0;
                    }
                }
                _ => self.slash = None,
            }
        }
        if let Some(mention) = self.mention.as_mut() {
            let query = (selection.is_collapsed() && selection.head.block == mention.block)
                .then(|| doc.blocks.get(mention.block))
                .flatten()
                .filter(|block| {
                    block
                        .text
                        .get(mention.start..)
                        .is_some_and(|rest| rest.starts_with('@'))
                        && selection.head.offset > mention.start
                })
                .and_then(|block| block.text.get(mention.start + 1..selection.head.offset))
                .map(str::to_string);
            match query {
                Some(query) if !query.contains(char::is_whitespace) => {
                    if query != mention.query {
                        mention.query = query.clone();
                        cx.emit(NotesEvent::RequestMention { query });
                    }
                }
                _ => {
                    self.mention = None;
                    cx.emit(NotesEvent::DismissMention);
                }
            }
        }
    }

    pub(crate) fn typed(&mut self, text: &str, cx: &mut Context<Self>) {
        let selection = self.editor.selection();
        if !selection.is_collapsed() || self.read_only || (text != "/" && text != "@") {
            return;
        }
        let head = selection.head;
        let Some(block) = self.editor.document().blocks.get(head.block) else {
            return;
        };
        let at = head.offset.saturating_sub(text.len());
        if block.text.get(at..head.offset) != Some(text) {
            return;
        }
        let after_space = match block.text[..at].chars().next_back() {
            Some(previous) => previous.is_whitespace(),
            None => block.text.len() == text.len(),
        };
        if text == "/" && block.kind.is_paragraph_like() && after_space {
            let serial = self.next_serial();
            self.slash = Some(Slash {
                block: head.block,
                start: at,
                query: String::new(),
                selected: 0,
                serial,
            });
        } else if text == "@" && block.kind.takes_marks() && after_space {
            self.mention = Some(Mention {
                block: head.block,
                start: at,
                query: String::new(),
            });
            cx.emit(NotesEvent::RequestMention {
                query: String::new(),
            });
        }
    }

    pub(crate) fn insert_typed(&mut self, text: &str, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        let before = self.editor.selection();
        let change = self.editor.insert_text(text);
        self.typed(text, cx);
        self.after_edit(change, before, true, cx);
    }

    pub(crate) fn slash_entries(&self) -> Vec<Entry> {
        let Some(slash) = &self.slash else {
            return Vec::new();
        };
        menu::filter(&slash.query, &self.labels, &self.extra_slash)
    }

    pub(crate) fn apply_slash(&mut self, index: usize, cx: &mut Context<Self>) {
        let entries = self.slash_entries();
        let Some(slash) = self.slash.take() else {
            return;
        };
        let Some(entry) = entries.get(index) else {
            return;
        };
        let head = self.editor.selection().head;
        let end = if head.block == slash.block {
            head.offset
        } else {
            slash.start + 1 + slash.query.len()
        };
        let before = self.editor.selection();
        let mut change = self.editor.delete_range(
            Pos::new(slash.block, slash.start),
            Pos::new(slash.block, end),
        );
        let kind = match entry.action {
            SlashAction::Builtin(builtin) => Some(match builtin {
                Builtin::Text => BlockKind::Paragraph,
                Builtin::Heading1 => BlockKind::Heading(1),
                Builtin::Heading2 => BlockKind::Heading(2),
                Builtin::Heading3 => BlockKind::Heading(3),
                Builtin::Bullet => BlockKind::Bullet,
                Builtin::Numbered => BlockKind::Ordered,
                Builtin::Checkbox => BlockKind::Task { checked: false },
                Builtin::Quote => BlockKind::Quote,
                Builtin::Code => BlockKind::Code {
                    language: String::new(),
                },
                Builtin::Divider => BlockKind::Rule,
            }),
            SlashAction::Host(index) => {
                if let Some(item) = self.extra_slash.get(index) {
                    cx.emit(NotesEvent::SlashCommand(item.id.to_string()));
                }
                None
            }
        };
        if let Some(kind) = kind {
            change = change.merge(self.editor.set_kind(kind));
        }
        self.after_edit(change, before, false, cx);
    }

    pub(crate) fn commit_composition(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(composition) = self.composition.take() else {
            return;
        };
        if composition.text.is_empty() {
            cx.notify();
            return;
        }
        let before = self.editor.selection();
        let change = self.editor.insert_text(&composition.text);
        self.after_edit(change, before, false, cx);
    }

    pub(crate) fn toggle_checkbox_at(&mut self, index: usize, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        let Some(block) = self.editor.document().blocks.get(index) else {
            return;
        };
        let id = block.id;
        let before = self.editor.selection();
        let change = self.editor.toggle_task_checked(index);
        if change.changed() {
            self.checks.retain(|anim| anim.id != id);
            self.checks.push(CheckAnim {
                id,
                started: Instant::now(),
            });
        }
        self.after_edit(change, before, false, cx);
        self.store.borrow_mut().autoscroll = None;
    }

    pub(crate) fn open_link_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.read_only {
            return;
        }
        let selection = self.editor.selection();
        let existing = self.editor.link_at(selection.head).map(|link| link.url);
        let url = existing.unwrap_or_default();
        let theme = self.theme.clone();
        let placeholder = self.labels.link_placeholder.clone();
        let field = cx.new(|cx| LineField::new(&url, placeholder, theme, cx));
        let subscription =
            cx.subscribe_in(
                &field,
                window,
                |this, field, event, window, cx| match event {
                    FieldEvent::Confirm => {
                        let url = field.read(cx).text().trim().to_string();
                        this.finish_link(Some(url), window, cx);
                    }
                    FieldEvent::Cancel => this.finish_link(None, window, cx),
                    FieldEvent::Changed | FieldEvent::ConfirmBack => {}
                },
            );
        let serial = self.next_serial();
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.link_edit = Some(LinkEdit {
            field,
            selection,
            serial,
            _subscription: subscription,
        });
        self.toolbar_visible = false;
        cx.notify();
    }

    fn finish_link(&mut self, url: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(edit) = self.link_edit.take() else {
            return;
        };
        window.focus(&self.focus, cx);
        if let Some(url) = url {
            let before = self.editor.selection();
            self.editor.set_selection(edit.selection);
            let change = self.editor.set_link((!url.is_empty()).then_some(url));
            self.after_edit(change, before, false, cx);
        }
        cx.notify();
    }

    pub(crate) fn show_find_bar(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let selection = self.editor.selection();
        let seed = (!selection.is_collapsed() && selection.anchor.block == selection.head.block)
            .then(|| self.editor.selected_plain_text())
            .filter(|text| text.chars().count() <= 64);
        if let Some(find) = &self.find {
            if let Some(seed) = seed {
                find.field.update(cx, |field, cx| {
                    field.replace_all_text(&seed, cx);
                });
            }
            let handle = find.field.read(cx).focus_handle(cx);
            find.field.update(cx, |field, cx| field.select_all(cx));
            window.focus(&handle, cx);
            return;
        }
        let theme = self.theme.clone();
        let placeholder = self.labels.find_placeholder.clone();
        let initial = seed.unwrap_or_default();
        let field = cx.new(|cx| LineField::new(&initial, placeholder, theme, cx));
        let subscription =
            cx.subscribe_in(
                &field,
                window,
                |this, field, event, window, cx| match event {
                    FieldEvent::Changed => {
                        let query = field.read(cx).text().to_string();
                        this.set_find_query(query, cx);
                    }
                    FieldEvent::Confirm => this.find_step(true, cx),
                    FieldEvent::ConfirmBack => this.find_step(false, cx),
                    FieldEvent::Cancel => this.close_find(window, cx),
                },
            );
        let handle = field.read(cx).focus_handle(cx);
        window.focus(&handle, cx);
        self.find = Some(FindState {
            field,
            query: String::new(),
            matches: Vec::new(),
            current: None,
            _subscription: subscription,
        });
        self.set_find_query(initial, cx);
    }

    pub fn show_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.show_find_bar(window, cx);
    }

    pub(crate) fn set_find_query(&mut self, query: String, cx: &mut Context<Self>) {
        let caret = self.editor.selection().start();
        let Some(find) = self.find.as_mut() else {
            return;
        };
        find.query = query;
        find.matches = self.editor.find(&find.query, false);
        find.current = find
            .matches
            .iter()
            .position(|found| Pos::new(found.block, found.range.start) >= caret)
            .or((!find.matches.is_empty()).then_some(0));
        self.reveal_current_match(cx);
    }

    pub(crate) fn find_step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.matches.is_empty() {
            return;
        }
        let len = find.matches.len();
        find.current = Some(match find.current {
            None => 0,
            Some(current) if forward => (current + 1) % len,
            Some(current) => (current + len - 1) % len,
        });
        self.reveal_current_match(cx);
    }

    fn reveal_current_match(&mut self, cx: &mut Context<Self>) {
        let Some(found) = self
            .find
            .as_ref()
            .and_then(|find| find.current.and_then(|i| find.matches.get(i)).cloned())
        else {
            cx.notify();
            return;
        };
        let before = self.editor.selection();
        self.editor.set_selection(Selection::new(
            Pos::new(found.block, found.range.start),
            Pos::new(found.block, found.range.end),
        ));
        if self.editor.selection() != before {
            cx.emit(NotesEvent::SelectionChanged);
        }
        self.store.borrow_mut().autoscroll =
            Some(Autoscroll::Center(found.block, found.range.start));
        cx.notify();
    }

    pub(crate) fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
        }
    }
}
