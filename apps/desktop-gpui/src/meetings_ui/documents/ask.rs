use std::{cell::Cell, collections::HashMap, rc::Rc, time::Duration};

use gpui::{
    Animation, AnimationExt, AnyElement, App, AppContext as _, Context, Entity, EventEmitter,
    FocusHandle, FontWeight, HighlightStyle, Hsla, InteractiveElement, InteractiveText,
    IntoElement, KeyDownEvent, ParentElement, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, StyledText, Subscription, Task, WeakEntity, Window, div,
    ease_out_quint, prelude::FluentBuilder, px, svg,
};

use super::{glass, style::Palette};
use crate::{
    i18n::tr,
    meetings::{AiAccess, AskTurn, MeetingEvent, Meetings, NotesError, generate::AskRole},
    theme::{Appearance, Theme},
    ui::{TextInput, TextInputEvent, TextInputState},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AskEvent {
    Error(NotesError),
    WriteNotes,
    Upgrade(String),
    SignIn,
    /// An answer finished; its sentences can now be linked to the lines.
    Answered(usize),
    /// Show these transcript lines (an answer's timestamp was clicked).
    Reveal(Vec<String>),
    /// A question was sent.
    Asked,
    CloseSheet,
    /// The suggestions above the field appeared, went or changed height.
    Room,
}

/// Where each sentence of an answer came from: its timestamp and lines.
pub type AnswerLinks = Rc<Vec<Option<(SharedString, Vec<String>)>>>;

/// The latest line of a live meeting, shown at the top of the Ask sheet.
#[derive(Clone, Debug, PartialEq)]
pub struct LiveLine {
    pub label: String,
    pub color: Hsla,
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lock {
    Upgrade,
    SignIn,
    /// A free meeting is asked about once its notes are written.
    NotesFirst,
}

pub fn lock_for(access: AiAccess, has_notes: bool, in_call: bool) -> Option<Lock> {
    match access {
        AiAccess::Trial { remaining } if remaining > 0 && (in_call || !has_notes) => {
            Some(Lock::NotesFirst)
        }
        _ if access.can_ask(has_notes) => None,
        AiAccess::NeedsSignIn => Some(Lock::SignIn),
        AiAccess::Unavailable => None,
        _ => Some(Lock::Upgrade),
    }
}

/// What a refused question shows: while free meetings remain and this one's
/// notes are not written yet, it waits for them rather than offering Cap Pro.
pub fn upgrade_refused(access: AiAccess, has_notes: bool, in_call: bool) -> Lock {
    match lock_for(access, has_notes, in_call) {
        Some(Lock::NotesFirst) => Lock::NotesFirst,
        _ => Lock::Upgrade,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskChip {
    WriteNotes,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Exchange {
    question: String,
    answer: String,
    error: Option<NotesError>,
    locked: Option<Lock>,
    done: bool,
    /// Which lines were left out of what the answer was given.
    left_out: String,
}

pub struct AskPanel {
    doc_id: Option<String>,
    palette: Palette,
    input: Entity<TextInputState>,
    thread: Vec<Exchange>,
    task: Option<Task<()>>,
    focused: bool,
    /// The suggested prompts, reachable from the field with Tab or Down.
    chip_focus: [FocusHandle; 3],
    /// Height the suggestions take above the field, gap included (0 while
    /// hidden), so the page can keep its text clear of them.
    chips_room: Rc<Cell<f32>>,
    serial: u64,
    scroll: ScrollHandle,
    chip: Option<AskChip>,
    access: AiAccess,
    has_notes: bool,
    in_call: bool,
    /// Shown as a side sheet with room for answers, mid-call.
    sheet: bool,
    live: Option<LiveLine>,
    links: HashMap<usize, AnswerLinks>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<AskEvent> for AskPanel {}

pub fn suggestions() -> [&'static str; 3] {
    [
        tr::documents::ask::suggest_decisions(),
        tr::documents::ask::suggest_actions(),
        tr::documents::ask::suggest_follow_up(),
    ]
}

impl AskPanel {
    pub fn new(palette: Palette, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::ask::placeholder());
            input
        });
        let focus = input.read(cx).focus_handle();
        let chip_focus: [FocusHandle; 3] = std::array::from_fn(|_| cx.focus_handle());
        let mut subscriptions = vec![
            cx.subscribe_in(
                &input,
                window,
                |this, _, event: &TextInputEvent, _, cx| match event {
                    TextInputEvent::Confirmed => this.submit(None, cx),
                    TextInputEvent::Cancelled => this.close(cx),
                    TextInputEvent::Blurred => {
                        this.focused = false;
                        cx.notify();
                    }
                    TextInputEvent::Changed => {}
                },
            ),
            cx.on_focus(&focus, window, |this, _, cx| {
                this.focused = true;
                cx.notify();
            }),
        ];
        for handle in &chip_focus {
            subscriptions.push(cx.on_blur(handle, window, |_, _, cx| cx.notify()));
        }
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(
                cx.subscribe(&meetings, |this, _, event: &MeetingEvent, cx| {
                    if let MeetingEvent::AskProgress { doc_id, answer } = event
                        && Some(doc_id) == this.doc_id.as_ref()
                        && let Some(last) = this.thread.last_mut()
                        && !last.done
                    {
                        last.answer.clone_from(answer);
                        this.scroll.scroll_to_bottom();
                        cx.notify();
                    }
                }),
            );
        }
        Self {
            doc_id: None,
            palette,
            input,
            thread: Vec::new(),
            task: None,
            focused: false,
            chip_focus,
            chips_room: Rc::new(Cell::new(0.)),
            serial: 0,
            scroll: ScrollHandle::new(),
            chip: None,
            access: AiAccess::Ready,
            has_notes: false,
            in_call: false,
            sheet: false,
            live: None,
            links: HashMap::new(),
            _subscriptions: subscriptions,
        }
    }

    pub fn chips_room(&self) -> f32 {
        self.chips_room.get()
    }

    fn set_chips_room(room: &Cell<f32>, height: f32, weak: WeakEntity<Self>, cx: &mut App) {
        if (room.replace(height) - height).abs() > 0.5 {
            cx.defer(move |cx| {
                weak.update(cx, |_, cx| cx.emit(AskEvent::Room)).ok();
            });
        }
    }

    fn chip_at(&self, window: &Window) -> Option<usize> {
        self.chip_focus.iter().position(|h| h.is_focused(window))
    }

    /// Tab or Down from the field steps onto the suggestions; arrows and Tab
    /// walk them; Escape, or stepping back past the first, returns to the
    /// field. Enter and Space press the focused one.
    fn chip_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let keystroke = &event.keystroke;
        let modifiers = keystroke.modifiers;
        if !self.thread.is_empty()
            || self.task.is_some()
            || modifiers.platform
            || modifiers.control
            || modifiers.alt
        {
            return;
        }
        let last = self.chip_focus.len() - 1;
        let field = self.input.read(cx).focus_handle();
        let target = match (
            self.chip_at(window),
            keystroke.key.as_str(),
            modifiers.shift,
        ) {
            (None, "tab", false) | (None, "down", _) if field.is_focused(window) => Some(Some(0)),
            (Some(i), "right" | "down", _) | (Some(i), "tab", false) => {
                Some(if i < last { Some(i + 1) } else { None })
            }
            (Some(0), "left" | "up", _) | (Some(0), "tab", true) => Some(None),
            (Some(i), "left" | "up", _) | (Some(i), "tab", true) => Some(Some(i - 1)),
            (Some(_), "escape", _) => Some(None),
            _ => None,
        };
        let Some(target) = target else {
            return;
        };
        match target {
            Some(i) => window.focus(&self.chip_focus[i], cx),
            None => window.focus(&field, cx),
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        cx.notify();
    }

    pub fn set_sheet(&mut self, sheet: bool, cx: &mut Context<Self>) {
        if self.sheet != sheet {
            self.sheet = sheet;
            cx.notify();
        }
    }

    pub fn set_live(&mut self, live: Option<LiveLine>, cx: &mut Context<Self>) {
        if self.live != live {
            self.live = live;
            if self.sheet {
                cx.notify();
            }
        }
    }

    pub fn input_focus(&self, cx: &App) -> gpui::FocusHandle {
        self.input.read(cx).focus_handle()
    }

    pub fn answer(&self, index: usize) -> Option<&str> {
        self.thread
            .get(index)
            .filter(|e| e.done && e.error.is_none() && e.locked.is_none())
            .map(|e| e.answer.as_str())
    }

    pub fn set_answer_links(&mut self, index: usize, links: AnswerLinks, cx: &mut Context<Self>) {
        self.links.insert(index, links);
        cx.notify();
    }

    pub fn set_doc(&mut self, doc_id: Option<String>, cx: &mut Context<Self>) {
        if self.doc_id != doc_id {
            self.doc_id = doc_id;
            self.links.clear();
            self.thread.clear();
            self.task = None;
            self.input.update(cx, |input, cx| input.set_text("", cx));
            cx.notify();
        }
    }

    pub fn set_chip(&mut self, chip: Option<AskChip>, cx: &mut Context<Self>) {
        if self.chip != chip {
            self.chip = chip;
            cx.notify();
        }
    }

    pub fn set_access(
        &mut self,
        access: AiAccess,
        has_notes: bool,
        in_call: bool,
        cx: &mut Context<Self>,
    ) {
        if (self.access, self.has_notes, self.in_call) != (access, has_notes, in_call) {
            self.access = access;
            self.has_notes = has_notes;
            self.in_call = in_call;
            if let Some(current) = self.lock() {
                for exchange in self.thread.iter_mut().filter(|e| e.locked.is_some()) {
                    exchange.locked = Some(current);
                }
            }
            cx.notify();
        }
    }

    fn lock(&self) -> Option<Lock> {
        lock_for(self.access, self.has_notes, self.in_call)
    }

    /// The Cap Pro tag by the suggestions, for an account Ask is locked for.
    pub(super) fn pro_tag(&self) -> bool {
        matches!(self.lock(), Some(Lock::Upgrade | Lock::SignIn))
    }

    pub fn send_after_upgrade(&mut self, question: String, cx: &mut Context<Self>) {
        self.thread
            .retain(|e| !(e.locked.is_some() && e.question == question));
        self.submit(Some(question), cx);
    }

    fn ask_now(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.thread.len() {
            let exchange = self.thread.remove(index);
            self.submit(Some(exchange.question), cx);
        }
    }

    pub fn is_open(&self) -> bool {
        !self.thread.is_empty()
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.sheet {
            cx.emit(AskEvent::CloseSheet);
            return;
        }
        self.thread.clear();
        self.links.clear();
        self.task = None;
        cx.notify();
    }

    pub fn retry(&mut self, cx: &mut Context<Self>) {
        if let Some(last) = self.thread.pop() {
            self.links.remove(&self.thread.len());
            self.submit(Some(last.question), cx);
        }
    }

    pub fn submit(&mut self, question: Option<String>, cx: &mut Context<Self>) {
        let question = question
            .unwrap_or_else(|| self.input.read(cx).text().to_string())
            .trim()
            .to_string();
        if question.is_empty() {
            return;
        }
        let Some(doc_id) = self.doc_id.clone() else {
            return;
        };
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        let history: Vec<AskTurn> = self
            .thread
            .iter()
            .filter(|e| e.done && e.error.is_none() && e.locked.is_none())
            .flat_map(|e| {
                [
                    AskTurn {
                        role: AskRole::User,
                        content: e.question.clone(),
                        left_out: e.left_out.clone(),
                    },
                    AskTurn {
                        role: AskRole::Assistant,
                        content: e.answer.clone(),
                        left_out: e.left_out.clone(),
                    },
                ]
            })
            .collect();
        self.input.update(cx, |input, cx| input.set_text("", cx));
        if self.thread.is_empty() {
            self.serial += 1;
        }
        if let Some(lock) = self.lock() {
            self.thread.push(Exchange {
                question,
                answer: String::new(),
                error: None,
                locked: Some(lock),
                done: true,
                left_out: String::new(),
            });
            self.scroll.scroll_to_bottom();
            cx.emit(AskEvent::Asked);
            cx.notify();
            return;
        }
        self.thread.push(Exchange {
            question: question.clone(),
            answer: String::new(),
            error: None,
            locked: None,
            done: false,
            left_out: String::new(),
        });
        let task = meetings.update(cx, |m, cx| m.ask(&doc_id, &question, &history, cx));
        self.task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            this.update(cx, |this, cx| {
                if this.doc_id.as_deref() != Some(doc_id.as_str()) {
                    return;
                }
                let index = this.thread.len().saturating_sub(1);
                if let Some(last) = this.thread.last_mut() {
                    last.done = true;
                    match result {
                        Ok(answer) => {
                            last.answer = answer.text;
                            last.left_out = answer.left_out;
                            cx.emit(AskEvent::Answered(index));
                        }
                        Err(NotesError::UpgradeRequired) => {
                            last.locked =
                                Some(upgrade_refused(this.access, this.has_notes, this.in_call));
                        }
                        Err(NotesError::NotSignedIn) => last.locked = Some(Lock::SignIn),
                        Err(error) => {
                            last.error = Some(error.clone());
                            cx.emit(AskEvent::Error(error));
                        }
                    }
                }
                this.task = None;
                this.scroll.scroll_to_bottom();
                cx.notify();
            })
            .ok();
        }));
        self.scroll.scroll_to_bottom();
        cx.emit(AskEvent::Asked);
        cx.notify();
    }
}

/// An answer's lines as they are shown: list markers and headings taken
/// off, bold markers dropped.
fn answer_lines(text: &str) -> Vec<(AnswerLine, String)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = (line.len() - line.trim_start().len()) / 2;
        let strip_bold = |s: &str| s.replace("**", "");
        if let Some(rest) = trimmed
            .strip_prefix("- [ ] ")
            .or_else(|| trimmed.strip_prefix("- "))
            .or_else(|| trimmed.strip_prefix("* "))
        {
            out.push((AnswerLine::Bullet(indent), strip_bold(rest)));
        } else if let Some(rest) = trimmed.strip_prefix('#') {
            out.push((
                AnswerLine::Heading,
                strip_bold(rest.trim_start_matches('#').trim()),
            ));
        } else {
            out.push((AnswerLine::Text, strip_bold(trimmed)));
        }
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AnswerLine {
    Text,
    Bullet(usize),
    Heading,
}

/// Split a line into sentences, each keeping its closing punctuation.
fn sentences(line: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = line.as_bytes();
    for (i, c) in line.char_indices() {
        if matches!(c, '.' | '?' | '!')
            && bytes.get(i + 1).is_none_or(|b| *b == b' ')
            && !line[start..i].trim().is_empty()
        {
            out.push(line[start..=i].trim());
            start = i + 1;
        }
    }
    if !line[start..].trim().is_empty() {
        out.push(line[start..].trim());
    }
    out
}

/// Every sentence of an answer, in order, as the linker sees them. Headings
/// are not claims and never link.
pub fn answer_sentences(text: &str) -> Vec<String> {
    answer_lines(text)
        .into_iter()
        .flat_map(|(kind, line)| {
            sentences(&line)
                .into_iter()
                .map(|s| {
                    if kind == AnswerLine::Heading {
                        String::new()
                    } else {
                        s.to_string()
                    }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// An answer with each sourced sentence followed by its time; clicking a
/// time asks the host to show those lines.
pub(super) fn render_linked(
    id: usize,
    text: &str,
    palette: &Palette,
    links: &AnswerLinks,
    on_reveal: Rc<dyn Fn(Vec<String>, &mut App)>,
) -> AnyElement {
    let mut blocks = div().flex().flex_col().gap(px(6.));
    let mut sentence_ix = 0;
    for (line_ix, (kind, line)) in answer_lines(text).into_iter().enumerate() {
        let mut shown = String::new();
        let mut stamps = Vec::new();
        let mut targets = Vec::new();
        for sentence in sentences(&line) {
            if !shown.is_empty() {
                shown.push(' ');
            }
            shown.push_str(sentence);
            if let Some(Some((label, ids))) = links.get(sentence_ix) {
                shown.push_str("\u{2002}");
                let start = shown.len();
                shown.push_str(label);
                stamps.push(start..shown.len());
                targets.push(ids.clone());
            }
            sentence_ix += 1;
        }
        let style = HighlightStyle {
            color: Some(palette.accent),
            font_weight: Some(FontWeight::MEDIUM),
            ..Default::default()
        };
        let styled = StyledText::new(shown).with_highlights(
            stamps
                .iter()
                .map(|r| (r.clone(), style))
                .collect::<Vec<_>>(),
        );
        let reveal = on_reveal.clone();
        let text = InteractiveText::new(("ask-answer-line", id * 1000 + line_ix), styled).on_click(
            stamps,
            move |ix, _, cx| {
                if let Some(ids) = targets.get(ix) {
                    reveal(ids.clone(), cx);
                }
            },
        );
        blocks = blocks.child(match kind {
            AnswerLine::Bullet(indent) => div()
                .pl(px(4. + indent as f32 * 14.))
                .flex()
                .gap(px(8.))
                .child(
                    div()
                        .mt(px(8.))
                        .size(px(4.))
                        .rounded_full()
                        .bg(palette.muted)
                        .flex_shrink_0(),
                )
                .child(div().flex_1().child(text)),
            AnswerLine::Heading => div()
                .pt(px(4.))
                .font_weight(FontWeight::SEMIBOLD)
                .child(text),
            AnswerLine::Text => div().child(text),
        });
    }
    blocks.into_any_element()
}

pub fn render_answer(text: &str, palette: &Palette) -> AnyElement {
    let mut blocks = div().flex().flex_col().gap(px(6.));
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = (line.len() - line.trim_start().len()) / 2;
        let strip_bold = |s: &str| s.replace("**", "");
        if let Some(rest) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("- [ ] "))
        {
            blocks = blocks.child(
                div()
                    .pl(px(4. + indent as f32 * 14.))
                    .flex()
                    .gap(px(8.))
                    .child(
                        div()
                            .mt(px(8.))
                            .size(px(4.))
                            .rounded_full()
                            .bg(palette.muted)
                            .flex_shrink_0(),
                    )
                    .child(div().flex_1().child(strip_bold(rest))),
            );
        } else if let Some(rest) = trimmed.strip_prefix('#') {
            blocks = blocks.child(
                div()
                    .pt(px(4.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(strip_bold(rest.trim_start_matches('#').trim())),
            );
        } else {
            blocks = blocks.child(div().child(strip_bold(trimmed)));
        }
    }
    blocks.into_any_element()
}

impl AskPanel {
    /// What a held question says, and its button. A refusal while this free
    /// meeting's notes are still to come waits for them, never offering Cap
    /// Pro.
    fn locked_copy(&self, locked: Option<Lock>) -> (Lock, &'static str, Option<&'static str>) {
        let current = self.lock();
        let lock = match locked {
            Some(Lock::SignIn) => Lock::SignIn,
            _ if current == Some(Lock::NotesFirst) => Lock::NotesFirst,
            Some(lock) => lock,
            None => Lock::Upgrade,
        };
        if current.is_none() {
            return (
                lock,
                tr::cap_ai::ask::ready(),
                Some(tr::cap_ai::ask::send_now()),
            );
        }
        match lock {
            Lock::SignIn => (
                lock,
                tr::cap_ai::ask::locked_sign_in(),
                Some(tr::cap_ai::card::sign_in()),
            ),
            Lock::NotesFirst => (lock, tr::cap_ai::ask::locked_notes_first(), None),
            Lock::Upgrade => (
                lock,
                tr::cap_ai::ask::locked_upgrade(),
                Some(tr::cap_ai::card::get_pro()),
            ),
        }
    }

    fn render_locked(
        &self,
        index: usize,
        exchange: &Exchange,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = self.palette;
        let now_open = self.lock().is_none();
        let (lock, text, label) = self.locked_copy(exchange.locked);
        let question = exchange.question.clone();
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(div().text_color(palette.muted).child(text))
            .children(label.map(|label| {
                div().flex().child(
                    super::style::ink_pill(&palette, ("ask-locked", index))
                        .h(px(28.))
                        .px(px(13.))
                        .text_size(px(12.5))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if now_open {
                                this.ask_now(index, cx);
                            } else if lock == Lock::SignIn {
                                cx.emit(AskEvent::SignIn);
                            } else {
                                cx.emit(AskEvent::Upgrade(question.clone()));
                            }
                        })),
                )
            }))
            .into_any_element()
    }
}

impl AskPanel {
    fn reveal_handler(cx: &mut Context<Self>) -> Rc<dyn Fn(Vec<String>, &mut App)> {
        let weak = cx.weak_entity();
        Rc::new(move |ids, cx| {
            weak.update(cx, |_, cx| cx.emit(AskEvent::Reveal(ids))).ok();
        })
    }

    fn render_exchange_answer(
        &self,
        i: usize,
        exchange: &Exchange,
        reveal: &Rc<dyn Fn(Vec<String>, &mut App)>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = self.palette;
        match (&exchange.error, exchange.answer.is_empty()) {
            _ if exchange.locked.is_some() => self.render_locked(i, exchange, cx),
            (Some(error), _) => div()
                .flex()
                .flex_col()
                .gap(px(8.))
                .child(
                    div()
                        .text_color(palette.muted)
                        .child(super::pane::notes_error_text(error)),
                )
                .child(
                    div()
                        .flex()
                        .gap(px(6.))
                        .children(super::pane::notes_error_action(error, &palette))
                        .child(
                            div()
                                .id(("ask-retry", i))
                                .h(px(26.))
                                .px(px(10.))
                                .flex()
                                .items_center()
                                .rounded_full()
                                .bg(palette.field)
                                .cursor_pointer()
                                .text_size(px(12.))
                                .child(tr::documents::notes::retry())
                                .on_click(cx.listener(|this, _, _, cx| this.retry(cx))),
                        ),
                )
                .into_any_element(),
            (None, true) => div()
                .text_color(palette.faint)
                .child(tr::documents::ask::thinking())
                .into_any_element(),
            (None, false) => match self.links.get(&i).filter(|_| exchange.done) {
                Some(links) => render_linked(i, &exchange.answer, &palette, links, reveal.clone()),
                None => render_answer(&exchange.answer, &palette),
            },
        }
    }

    /// Ask as a side sheet: the latest live line on top, the conversation
    /// with room to read, and the field at the bottom.
    fn render_sheet(&mut self, theme: &Theme, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let busy = self.task.is_some();
        let reveal = Self::reveal_handler(cx);
        let exchanges: Vec<AnyElement> = self
            .thread
            .iter()
            .enumerate()
            .map(|(i, exchange)| {
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div().flex().justify_end().child(
                            div()
                                .max_w(px(300.))
                                .px(px(12.))
                                .py(px(7.))
                                .rounded(px(12.))
                                .bg(palette.selected)
                                .child(exchange.question.clone()),
                        ),
                    )
                    .child(self.render_exchange_answer(i, exchange, &reveal, cx))
                    .into_any_element()
            })
            .collect();
        let empty = exchanges.is_empty();
        let live = self.live.clone().map(|live| {
            div()
                .mx(px(12.))
                .mb(px(4.))
                .px(px(12.))
                .py(px(10.))
                .flex()
                .items_start()
                .gap(px(8.))
                .rounded(px(10.))
                .bg(palette.content)
                .text_size(px(13.))
                .line_height(px(19.))
                .text_color(palette.muted)
                .child(
                    div()
                        .mt(px(6.))
                        .size(px(7.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(palette.live),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_color(live.color)
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(live.label),
                        )
                        .child(div().line_clamp(3).child(live.text)),
                )
        });
        let suggestions = empty.then(|| {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(8.))
                .children(suggestions().into_iter().enumerate().map(|(i, text)| {
                    glass::chip(&palette, ("ask-sheet-suggestion", i), &self.chip_focus[i])
                        .h(px(30.))
                        .px(px(14.))
                        .text_size(px(13.))
                        .child(text)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.submit(Some(text.to_string()), cx)
                        }))
                }))
        });
        div()
            .size_full()
            .flex()
            .flex_col()
            .on_key_down(cx.listener(Self::chip_key))
            .child(
                div()
                    .h(px(44.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .justify_end()
                    .child(
                        super::style::icon_button(&palette, "ask-sheet-close", "icons/x.svg", 28.)
                            .tooltip(|_, cx| {
                                crate::ui::Tooltip::new(
                                    &Theme::new(Appearance::Dark),
                                    tr::common::close(),
                                )
                                .view(cx)
                            })
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(AskEvent::CloseSheet))),
                    ),
            )
            .children(live)
            .children(suggestions)
            .when(!empty, |el| {
                el.child(
                    div()
                        .id("ask-sheet-thread")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .track_scroll(&self.scroll)
                        .px(px(18.))
                        .py(px(10.))
                        .flex()
                        .flex_col()
                        .gap(px(16.))
                        .text_size(px(13.5))
                        .line_height(px(21.))
                        .text_color(palette.text)
                        .children(exchanges),
                )
            })
            .child(
                div()
                    .flex_shrink_0()
                    .p(px(12.))
                    .border_t(px(1.))
                    .border_color(palette.hairline)
                    .child(
                        div()
                            .h(px(42.))
                            .pl(px(14.))
                            .pr(px(4.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .rounded_full()
                            .border(px(1.5))
                            .border_color(palette.track)
                            .bg(palette.content)
                            .child(
                                TextInput::bare(theme, "ask-sheet-input", &self.input)
                                    .text_size(px(14.))
                                    .text_color(palette.text)
                                    .placeholder_color(palette.muted)
                                    .height(px(28.)),
                            )
                            .child(
                                div()
                                    .id("ask-sheet-send")
                                    .size(px(34.))
                                    .flex()
                                    .flex_shrink_0()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .when(busy, |el| el.opacity(0.4))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(palette.hover))
                                    .child(
                                        svg()
                                            .path("icons/corner-down-left.svg")
                                            .size(px(14.))
                                            .text_color(palette.muted),
                                    )
                                    .on_click(cx.listener(|this, _, _, cx| this.submit(None, cx))),
                            ),
                    ),
            )
            .into_any_element()
    }
}

impl Render for AskPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette;
        let theme = Theme::new(if palette.dark {
            Appearance::Dark
        } else {
            Appearance::Light
        });
        if self.sheet {
            return self.render_sheet(&theme, cx);
        }
        let reveal = Self::reveal_handler(cx);
        let busy = self.task.is_some();
        let show_suggestions =
            self.thread.is_empty() && (self.focused || self.chip_at(window).is_some());
        let chip = self.chip.filter(|_| self.thread.is_empty() && !busy);
        let thread = (!self.thread.is_empty()).then(|| {
            let exchanges = self.thread.iter().enumerate().map(|(i, exchange)| {
                let answer = self.render_exchange_answer(i, exchange, &reveal, cx);
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .child(
                        div().flex().justify_end().child(
                            div()
                                .max_w(px(420.))
                                .px(px(11.))
                                .py(px(6.))
                                .rounded(px(12.))
                                .bg(palette.field)
                                .child(exchange.question.clone()),
                        ),
                    )
                    .child(answer)
            });
            let exchanges: Vec<_> = exchanges.collect();
            div()
                .w_full()
                .child(
                    super::menu::surface(&palette)
                        .rounded(px(20.))
                        .border(px(1.5))
                        .w_full()
                        .flex()
                        .flex_col()
                        .relative()
                        .child(
                            div().absolute().top(px(6.)).right(px(6.)).child(
                                div()
                                    .id("ask-close")
                                    .size(px(22.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(palette.hover))
                                    .child(
                                        svg()
                                            .path("icons/x.svg")
                                            .size(px(12.))
                                            .text_color(palette.muted),
                                    )
                                    .on_click(cx.listener(|this, _, _, cx| this.close(cx))),
                            ),
                        )
                        .child(
                            div()
                                .id("ask-thread")
                                .max_h(px(300.))
                                .overflow_y_scroll()
                                .track_scroll(&self.scroll)
                                .pl(px(14.))
                                .pr(px(34.))
                                .py(px(12.))
                                .flex()
                                .flex_col()
                                .gap(px(14.))
                                .text_size(px(13.5))
                                .line_height(px(20.))
                                .children(exchanges),
                        ),
                )
                .with_animation(
                    ("ask-thread-in", self.serial),
                    Animation::new(Duration::from_millis(160)).with_easing(ease_out_quint()),
                    |el, t| el.opacity(t).mt(px((1. - t) * 8.)),
                )
                .into_any_element()
        });
        let locked = self.pro_tag();
        if !show_suggestions {
            Self::set_chips_room(&self.chips_room, 0., cx.weak_entity(), cx);
        }
        let room = self.chips_room.clone();
        let weak = cx.weak_entity();
        let suggestions = show_suggestions.then(|| {
            let probe = gpui::canvas(
                move |bounds, _, cx| {
                    let height = f32::from(bounds.size.height) + 8.;
                    Self::set_chips_room(&room, height, weak, cx);
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full();
            div()
                .relative()
                .child(probe)
                .flex()
                .flex_wrap()
                .justify_center()
                .items_center()
                .gap(px(6.))
                .when(locked, |el| {
                    el.child(
                        div()
                            .h(px(20.))
                            .px(px(8.))
                            .mr(px(2.))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .bg(palette.accent_soft)
                            .text_size(px(11.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.accent)
                            .child(tr::cap_ai::ask::tag()),
                    )
                })
                .children(suggestions().into_iter().enumerate().map(|(i, text)| {
                    glass::chip(&palette, ("ask-suggestion", i), &self.chip_focus[i])
                        .child(text)
                        .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                            window.prevent_default()
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.submit(Some(text.to_string()), cx)
                        }))
                }))
        });
        div()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(8.))
            .on_key_down(cx.listener(Self::chip_key))
            .children(thread)
            .children(suggestions)
            .child(
                div()
                    .h(px(46.))
                    .w_full()
                    .pl(px(14.))
                    .pr(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        TextInput::bare(&theme, "ask-input", &self.input)
                            .text_size(px(14.))
                            .text_color(palette.text)
                            .placeholder_color(palette.muted)
                            .height(px(28.)),
                    )
                    .children(chip.map(|chip| {
                        match chip {
                            AskChip::WriteNotes => super::style::ink_pill(&palette, "ask-chip")
                                .flex_shrink_0()
                                .h(px(32.))
                                .px(px(14.))
                                .child(
                                    div()
                                        .whitespace_nowrap()
                                        .child(tr::documents::bar::write_notes()),
                                )
                                .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                                    window.prevent_default()
                                })
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(AskEvent::WriteNotes))),
                        }
                    }))
                    .child(
                        div()
                            .id("ask-send")
                            .size(px(34.))
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .justify_center()
                            .rounded_full()
                            .when(busy, |el| el.opacity(0.4))
                            .cursor_pointer()
                            .hover(move |s| s.bg(palette.hover))
                            .child(
                                svg()
                                    .path("icons/corner-down-left.svg")
                                    .size(px(14.))
                                    .text_color(palette.muted),
                            )
                            .on_click(cx.listener(|this, _, _, cx| this.submit(None, cx))),
                    ),
            )
            .into_any_element()
    }
}

#[cfg(test)]
impl AskPanel {
    /// The copy and button each held question shows.
    pub(super) fn held_copy(&self) -> Vec<(&'static str, Option<&'static str>)> {
        self.thread
            .iter()
            .filter(|e| e.locked.is_some())
            .map(|e| {
                let (_, text, label) = self.locked_copy(e.locked);
                (text, label)
            })
            .collect()
    }

    /// A question the server refused with an upgrade, as an answer that
    /// comes back with one leaves it.
    pub(super) fn refused_by_server(&mut self, question: &str) {
        self.thread.push(Exchange {
            question: question.to_string(),
            answer: String::new(),
            error: None,
            locked: Some(upgrade_refused(self.access, self.has_notes, self.in_call)),
            done: true,
            left_out: String::new(),
        });
    }
}

#[cfg(debug_assertions)]
impl AskPanel {
    pub fn debug_locked(&mut self, focus: bool, window: &mut Window, cx: &mut Context<Self>) {
        if focus {
            let handle = self.input.read(cx).focus_handle();
            window.focus(&handle, cx);
            self.focused = true;
        } else {
            self.submit(Some(suggestions()[1].to_string()), cx);
        }
        cx.notify();
    }

    pub fn debug_exchange(&mut self, question: &str, answer: &str, cx: &mut Context<Self>) {
        self.serial += 1;
        self.links.clear();
        self.thread = vec![Exchange {
            question: question.to_string(),
            answer: answer.to_string(),
            error: None,
            locked: None,
            done: true,
            left_out: String::new(),
        }];
        cx.notify();
    }

    pub fn debug_thread(&mut self, cx: &mut Context<Self>) {
        self.serial += 1;
        self.thread = vec![Exchange {
            question: suggestions()[1].to_string(),
            answer: "### Action items\n\n- Ana: share the onboarding designs by Thursday\n- Ben: follow up with legal about the contract\n- You: write down the pricing decision".into(),
            error: None,
            locked: None,
            done: true,
            left_out: String::new(),
        }];
        cx.notify();
    }
}
