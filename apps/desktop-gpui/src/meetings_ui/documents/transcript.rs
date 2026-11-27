use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::atomic::Ordering,
    time::Duration,
};

use cap_diarize::SpeakerId;
use cap_meetings::{
    library::DocMeta,
    transcript::{Source, SpeakerLabel, Transcript, format_timestamp},
};
use chrono::{DateTime, Utc};
use gpui::{
    AnimationExt as _, AnyElement, AnyView, App, AppContext as _, AvailableSpace, Bounds,
    ClickEvent, ContentMask, Context, Element, ElementId, Entity, FocusHandle, Focusable,
    FontWeight, GlobalElementId, InteractiveElement, IntoElement, LayoutId, ListAlignment,
    ListState, MouseButton, ParentElement, Pixels, Render, SharedString,
    StatefulInteractiveElement, Style, StyleRefinement, Styled, Subscription, Task, WeakEntity,
    Window, canvas, div, prelude::FluentBuilder, px, relative, size, svg,
};

use super::{
    CopySelection, DeleteSelection, ExtendSelectionDown, ExtendSelectionUp, FindInTranscript,
    SelectionDown, SelectionUp, TRANSCRIPT_CONTEXT, commands, doodles, export, format,
    home::emphasised,
    player::{self, Player},
    style::{self, COLUMN_WIDTH, Palette, column_padding},
    window::DocumentsWindow,
};
use crate::{
    i18n::tr,
    meetings::{MeetingEvent, Meetings, SpeakerRef},
    theme::{Appearance, Theme},
    ui::{TextInput, TextInputEvent, TextInputState},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnRow {
    pub source: Source,
    pub speaker: Option<String>,
    pub speaker_id: Option<u32>,
    pub label: String,
    /// The label is a stand-in ("Person 2", "You"), not someone's name, so
    /// renaming starts with it selected and typing replaces it.
    pub placeholder: bool,
    pub color: Option<usize>,
    pub start_ms: u64,
    pub text: String,
    pub partial: bool,
    pub ids: Vec<String>,
    /// The voice is shown as the user's, so "That's not me" can be offered.
    pub you: bool,
    /// The person said this voice was not them ("That's me" takes it back).
    pub disowned: bool,
    /// Left out of the notes: shown dimmed, never in a summary or Ask.
    pub left_out: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TRow {
    Minute { minute: u64, label: String },
    Turn(TurnRow),
}

pub fn minute_label(started_at: Option<DateTime<Utc>>, minute: u64) -> String {
    match started_at {
        Some(at) => format::clock(format::local(at + chrono::Duration::minutes(minute as i64))),
        None => format_timestamp(minute * 60_000),
    }
}

pub fn build_rows(
    transcript: &Transcript,
    started_at: Option<DateTime<Utc>>,
    self_name: Option<&str>,
    hidden: &HashSet<String>,
) -> Vec<TRow> {
    let colours = SpeakerColours::new(transcript, self_name);
    let filtered;
    let transcript = if hidden.is_empty() {
        transcript
    } else {
        let mut copy = transcript.clone();
        let ids: Vec<&String> = hidden.iter().collect();
        copy.remove(&ids);
        filtered = copy;
        &filtered
    };
    let partial: HashSet<&str> = transcript
        .utterances()
        .iter()
        .filter(|u| !u.is_final)
        .map(|u| u.id.as_str())
        .collect();
    let mut rows = Vec::new();
    for group in transcript.minute_groups() {
        rows.push(TRow::Minute {
            minute: group.minute,
            label: minute_label(started_at, group.minute),
        });
        for turn in group.turns {
            let who = transcript.turn_speaker(&turn);
            let label = export::word_speaker(&who, self_name);
            let placeholder = match &who {
                SpeakerLabel::Named(_) => false,
                SpeakerLabel::User => self_name.is_none_or(|n| n.trim().is_empty()),
                SpeakerLabel::Person(_) | SpeakerLabel::Others => true,
            };
            let color = colours.of(&turn, &who);
            let voice = turn
                .speaker
                .as_deref()
                .is_none_or(|n| n.trim().is_empty())
                .then_some(turn.speaker_id)
                .flatten()
                .map(SpeakerId);
            let names = transcript.names();
            let you = voice.is_some_and(|id| {
                names.and_then(|n| n.label(id)) == Some(cap_diarize::Label::User)
            });
            let disowned = voice.is_some_and(|id| names.is_some_and(|n| n.is_not_user(id)));
            let left_out = transcript.turn_left_out(&turn);
            rows.push(TRow::Turn(TurnRow {
                source: turn.source,
                speaker: turn.speaker.clone(),
                speaker_id: turn.speaker_id,
                label,
                placeholder,
                color,
                start_ms: turn.start_ms,
                partial: turn
                    .utterance_ids
                    .iter()
                    .any(|id| partial.contains(id.as_str())),
                text: turn.text,
                ids: turn.utterance_ids,
                you,
                disowned,
                left_out,
            }));
        }
    }
    rows
}

/// Which colour each speaker in one meeting gets. It is worked out from what
/// the meeting saved (its voices' numbers, their names, the lines' names),
/// never from the order lines arrived in, so a speaker has the same colour
/// live, after Stop and after a relaunch, in the transcript, the name chips
/// and the Ask sheet.
///
/// Slot 0 is "them": the computer's audio before voices are told apart, and
/// the one calendar attendee's voice. Told-apart voices take 1, 2, 3... in
/// the order they were numbered, without gaps; a line moved to a name takes
/// the colour of the voice or person with that name, and a name nobody else
/// has takes the slots from the top down. So no two speakers share a colour
/// until there are more speakers than colours. The user is never coloured.
pub struct SpeakerColours {
    voices: HashMap<u32, Option<usize>>,
    names: HashMap<String, Option<usize>>,
}

impl SpeakerColours {
    pub fn new(transcript: &Transcript, self_name: Option<&str>) -> Self {
        let key = |name: &str| name.trim().to_lowercase();
        let mut voices: HashMap<u32, Option<usize>> = HashMap::new();
        let mut names: HashMap<String, Option<usize>> = HashMap::new();
        for name in [self_name, transcript.speaker_label_for_source(Source::Mic)]
            .into_iter()
            .flatten()
            .filter(|name| !name.trim().is_empty())
        {
            names.insert(key(name), None);
        }
        if let Some(known) = transcript.names() {
            if let Some(user) = known.user() {
                voices.insert(user.0, None);
            }
            let mut numbered: Vec<(u32, SpeakerId)> =
                known.numbers().iter().map(|(id, n)| (*n, *id)).collect();
            numbered.sort();
            for (rank, (_, id)) in numbered.into_iter().enumerate() {
                voices.entry(id.0).or_insert(Some(rank + 1));
            }
            for (id, name) in known.renames() {
                if let Some(slot) = voices.get(&id.0) {
                    names.entry(key(name)).or_insert(*slot);
                }
            }
            for id in transcript.utterances().iter().filter_map(|u| u.speaker_id) {
                if !voices.contains_key(&id)
                    && let Some(cap_diarize::Label::Named(name)) = known.label(SpeakerId(id))
                {
                    names.entry(key(&name)).or_insert(Some(0));
                }
            }
        }
        let mut alone = 0;
        for utterance in transcript.utterances() {
            let Some(name) = utterance.speaker.as_deref().filter(|n| !n.trim().is_empty()) else {
                continue;
            };
            names.entry(key(name)).or_insert_with(|| {
                let slot = style::SPEAKER_COLOURS - 1 - alone % style::SPEAKER_COLOURS;
                alone += 1;
                Some(slot)
            });
        }
        Self { voices, names }
    }

    pub fn of(&self, turn: &cap_meetings::transcript::Turn, who: &SpeakerLabel) -> Option<usize> {
        if *who == SpeakerLabel::User {
            return None;
        }
        if let Some(name) = turn.speaker.as_deref().filter(|n| !n.trim().is_empty()) {
            return self
                .names
                .get(&name.trim().to_lowercase())
                .copied()
                .unwrap_or(Some(0));
        }
        match turn.speaker_id {
            Some(id) => self.voices.get(&id).copied().unwrap_or(Some(0)),
            None if turn.source == Source::Mic => None,
            None => Some(0),
        }
    }
}

/// What a rename of this line's speaker renames.
pub fn rename_target(turn: &TurnRow) -> SpeakerRef {
    match (turn.speaker.clone(), turn.speaker_id) {
        (Some(named), _) => SpeakerRef::Named(named),
        (None, Some(id)) => SpeakerRef::Id(id),
        (None, None) => SpeakerRef::Source(turn.source),
    }
}

pub fn common_prefix(old: &[TRow], new: &[TRow]) -> usize {
    old.iter().zip(new).take_while(|(a, b)| a == b).count()
}

struct Find {
    input: Entity<TextInputState>,
    matches: Vec<usize>,
    current: usize,
    _subscription: Subscription,
}

pub struct TranscriptView {
    root: WeakEntity<DocumentsWindow>,
    palette: Palette,
    doc_id: Option<String>,
    meta: Option<DocMeta>,
    focus: FocusHandle,
    list: ListState,
    rows: Rc<Vec<TRow>>,
    live: bool,
    loaded: bool,
    hidden: HashSet<String>,
    pending_delete: Vec<String>,
    selection: Option<(usize, usize)>,
    renaming: Option<Rename>,
    /// Names the meeting's words suggest for its numbered voices ("I'm
    /// Kristen"), offered beside "Person n" for one click.
    suggestions: Rc<HashMap<u32, String>>,
    names_offer_hidden: bool,
    find: Option<Find>,
    load: Option<Task<()>>,
    player: Option<Player>,
    player_tick: Option<Task<()>>,
    scrubber: Rc<Cell<Bounds<Pixels>>>,
    width: f32,
    inline: bool,
    shown_at: std::time::Instant,
    /// The row and byte under the pointer in a line's text, for "Always
    /// spell as" on right-click.
    hover: Rc<Cell<Option<(usize, usize)>>>,
    spell: Option<Spell>,
    /// Items the page puts ahead of the lines (its title, the summary), so
    /// the note and its transcript share one scroll. All but the last are
    /// laid over spacers by [`PageScroll`] rather than drawn by the list.
    lead: Option<Lead>,
    /// The lines of the page's one scroll as a view of their own, so a key
    /// typed in the summary above them does not repaint them.
    lines: Option<Entity<LinesView>>,
    /// Heights of the page's items that float over the lines (all but the
    /// last), each over a spacer of its height at the top of the list.
    lead_height: Spacers,
    /// Width the page's first item is laid out at.
    lead_width: Rc<Cell<Pixels>>,
    /// Bumped on every change, so the lines know when to repaint.
    revision: u64,
    lines_drawn: Rc<Cell<Option<u64>>>,
    #[cfg(any(test, debug_assertions))]
    lead_resizes: Rc<Cell<usize>>,
    /// The page shows only the transcript's heading. Saved per user when
    /// toggled; a source clicked, Find or Show Transcript opens it for the
    /// page in view without changing what is saved.
    collapsed: bool,
    /// Lines a point in the notes came from, lit while it is hovered.
    lit: Option<Lit>,
    lit_serial: u64,
    #[cfg(debug_assertions)]
    debug_live: bool,
    /// Under a live transcript on a computer too slow for live captions.
    cue: Entity<ListeningCue>,
    _subscriptions: Vec<Subscription>,
}

/// One calm line under a live transcript on a computer too slow for live
/// captions, while someone speaks and nothing new has shown for a few
/// seconds (`Meetings::listening_cue`). It repaints only when it shows,
/// hides or its level step changes, never with every level reading, and
/// the next words take it away.
pub struct ListeningCue {
    palette: Palette,
    on: bool,
    step: u8,
    _subscription: Option<Subscription>,
}

impl ListeningCue {
    fn new(palette: Palette, cx: &mut Context<Self>) -> Self {
        let subscription = Meetings::try_global(cx).map(|meetings| {
            cx.subscribe(&meetings, |this, meetings, event: &MeetingEvent, cx| {
                if matches!(
                    event,
                    MeetingEvent::ActiveChanged
                        | MeetingEvent::TranscriptChanged { .. }
                        | MeetingEvent::RecordingStopped { .. }
                ) {
                    this.update(&meetings, cx);
                }
            })
        });
        let forced = Self::forced();
        Self {
            palette,
            on: forced,
            step: if forced { 2 } else { 0 },
            _subscription: subscription,
        }
    }

    /// Debug builds: `CAP_GPUI_DEBUG_LISTENING_CUE=1` shows it (screenshots).
    fn forced() -> bool {
        cfg!(debug_assertions)
            && std::env::var("CAP_GPUI_DEBUG_LISTENING_CUE").is_ok_and(|v| v.trim() == "1")
    }

    fn update(&mut self, meetings: &Entity<Meetings>, cx: &mut Context<Self>) {
        if Self::forced() {
            return;
        }
        let meetings = meetings.read(cx);
        let on = meetings.listening_cue();
        let step = match (on, meetings.active()) {
            (true, Some(active)) => crate::meetings_ui::live::model::meter_step(
                active.mic.level.max(active.system.level),
            ),
            _ => 0,
        };
        if (on, step) != (self.on, self.step) {
            self.on = on;
            self.step = step;
            cx.notify();
        }
    }

    fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        if self.on {
            cx.notify();
        }
    }
}

impl Render for ListeningCue {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        if !self.on {
            return div().into_any_element();
        }
        let palette = self.palette;
        let bars = crate::meetings_ui::live::model::meter_bars(self.step.max(1));
        let pill = div()
            .id("listening-cue")
            .h(px(28.))
            .px(px(12.))
            .flex()
            .items_center()
            .gap(px(8.))
            .rounded_full()
            .bg(palette.capsule)
            .border_1()
            .border_color(palette.capsule_border)
            .text_size(px(12.))
            .text_color(palette.muted)
            .child(
                div()
                    .h(px(10.))
                    .flex()
                    .items_end()
                    .gap(px(2.))
                    .children(bars.map(|bar| {
                        div()
                            .w(px(2.))
                            .h(px(10. * bar))
                            .rounded_full()
                            .bg(palette.faint)
                    })),
            )
            .child(tr::documents::transcript::listening_slow());
        div()
            .w_full()
            .flex_none()
            .flex()
            .justify_center()
            .pt(px(4.))
            .pb(px(10.))
            .child(pill)
            .into_any_element()
    }
}

pub type LeadRender = Rc<dyn Fn(usize, &mut Window, &mut App) -> AnyElement>;

/// Heights of the page's floating items, by index.
type Spacers = Rc<std::cell::RefCell<Vec<Pixels>>>;

struct Lead {
    count: usize,
    render: LeadRender,
    /// Room after the last line so it clears the page's bottom bar.
    tail: f32,
}

struct Lit {
    ids: HashSet<String>,
    serial: u64,
}

const LIT_FADE: Duration = Duration::from_millis(160);

/// The small "Always spell as" popover over a transcript word.
/// A speaker's name as a small pill in their colour: the place to click to
/// rename them. `hint` is a name the meeting suggests, shown softly inside.
pub fn speaker_badge(
    id: SharedString,
    label: String,
    hint: Option<String>,
    color: gpui::Hsla,
    active: bool,
    palette: &Palette,
) -> gpui::Stateful<gpui::Div> {
    let tint = |a: f32| gpui::Hsla { a, ..color };
    let muted = palette.muted;
    let tip = tr::documents::transcript::rename_hint();
    div()
        .id(id)
        .h(px(22.))
        .px(px(9.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(6.))
        .rounded_full()
        .bg(tint(if active { 0.24 } else { 0.12 }))
        .text_size(px(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(color)
        .cursor_pointer()
        .hover(move |s| s.bg(tint(0.2)))
        .tooltip(move |_, cx| crate::ui::Tooltip::new(&Theme::new(Appearance::Dark), tip).view(cx))
        .child(label)
        .children(hint.map(|hint| {
            div()
                .font_weight(FontWeight::NORMAL)
                .text_color(muted)
                .child(hint)
        }))
}

/// The popover a speaker's name badge opens: the name, names the meeting
/// suggests, "Same person as" and "Just this line".
struct Rename {
    turn: TurnRow,
    input: Entity<TextInputState>,
    /// Where the badge was clicked, in window coordinates.
    at: gpui::Point<Pixels>,
    /// Only the clicked line moves to the typed name; the voice keeps its own.
    line_only: bool,
    /// "That's not me" and "Leave this voice out of the notes", reached
    /// with Tab from the name field.
    choices: [FocusHandle; 2],
    _subscription: Subscription,
}

struct Spell {
    wrong: String,
    at: gpui::Point<Pixels>,
    input: Entity<TextInputState>,
    _subscription: Subscription,
}

/// The word (letters, digits and inner apostrophes or hyphens) around a byte
/// of a line, without punctuation or a possessive.
pub fn word_at(text: &str, at: usize) -> Option<String> {
    let at = at.min(text.len());
    let is_word = |c: char| c.is_alphanumeric() || c == '\'' || c == '\u{2019}' || c == '-';
    let start = text[..at]
        .char_indices()
        .rev()
        .take_while(|(_, c)| is_word(*c))
        .last()
        .map_or(at, |(i, _)| i);
    let end = text[at..]
        .char_indices()
        .find(|(_, c)| !is_word(*c))
        .map_or(text.len(), |(i, _)| at + i);
    let word = text[start..end].trim_matches(|c: char| !c.is_alphanumeric());
    // "Kap's" is the word Kap: the dictionary keeps possessives itself.
    let word = ["'s", "\u{2019}s"]
        .iter()
        .find_map(|tail| word.strip_suffix(tail).filter(|w| !w.is_empty()))
        .unwrap_or(word);
    (!word.is_empty()).then(|| word.to_string())
}

impl TranscriptView {
    pub fn new(
        root: WeakEntity<DocumentsWindow>,
        palette: Palette,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut subscriptions = Vec::new();
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(
                cx.subscribe(&meetings, |this, _, event: &MeetingEvent, cx| match event {
                    MeetingEvent::TranscriptChanged { doc_id }
                        if Some(doc_id) == this.doc_id.as_ref() =>
                    {
                        this.refresh(cx)
                    }
                    MeetingEvent::RecordingStarted { doc_id }
                    | MeetingEvent::RecordingStopped { doc_id, .. }
                        if Some(doc_id) == this.doc_id.as_ref() =>
                    {
                        this.refresh(cx)
                    }
                    _ => {}
                }),
            );
        }
        let cue = cx.new(|cx| ListeningCue::new(palette, cx));
        let list = ListState::new(0, ListAlignment::Top, px(600.));
        let weak = cx.weak_entity();
        list.set_scroll_handler(move |_, _, cx| {
            weak.update(cx, |this, cx| this.changed(cx)).ok();
        });
        Self {
            root,
            palette,
            doc_id: None,
            meta: None,
            focus: cx.focus_handle(),
            list,
            rows: Rc::new(Vec::new()),
            live: false,
            loaded: false,
            hidden: HashSet::new(),
            pending_delete: Vec::new(),
            selection: None,
            renaming: None,
            suggestions: Rc::new(HashMap::new()),
            names_offer_hidden: crate::store::store_section("meetings")
                .get(NAMES_OFFER_KEY)
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            find: None,
            load: None,
            player: None,
            player_tick: None,
            scrubber: Rc::new(Cell::new(Bounds::default())),
            width: 800.,
            inline: false,
            shown_at: std::time::Instant::now(),
            hover: Rc::new(Cell::new(None)),
            spell: None,
            lead: None,
            lines: None,
            lead_height: Rc::new(std::cell::RefCell::new(Vec::new())),
            lead_width: Rc::new(Cell::new(px(0.))),
            revision: 0,
            lines_drawn: Rc::new(Cell::new(None)),
            #[cfg(any(test, debug_assertions))]
            lead_resizes: Rc::new(Cell::new(0)),
            collapsed: saved_collapsed(),
            lit: None,
            lit_serial: 0,
            #[cfg(debug_assertions)]
            debug_live: false,
            cue,
            _subscriptions: subscriptions,
        }
    }

    /// Every change goes through here rather than a bare notify, so the
    /// page's lines repaint exactly when something they show changed.
    pub fn changed(&mut self, cx: &mut Context<Self>) {
        self.revision = self.revision.wrapping_add(1);
        cx.notify();
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        self.cue.update(cx, |cue, cx| cue.set_palette(palette, cx));
        self.changed(cx);
    }

    pub fn set_width(&mut self, width: f32, cx: &mut Context<Self>) {
        if (self.width - width).abs() > 0.5 {
            self.width = width;
            self.changed(cx);
        }
    }

    /// Shown in the page itself rather than the bottom panel, so the sticky
    /// minute label takes the page colour.
    pub fn set_inline(&mut self, inline: bool, cx: &mut Context<Self>) {
        if self.inline != inline {
            self.inline = inline;
            self.changed(cx);
        }
    }

    pub fn set_doc(&mut self, meta: Option<DocMeta>, cx: &mut Context<Self>) {
        let id = meta.as_ref().map(|m| m.id.clone());
        let changed = id != self.doc_id;
        self.meta = meta;
        if !changed {
            return;
        }
        self.commit_hidden(cx);
        self.hidden.clear();
        self.doc_id = id;
        self.rows = Rc::new(Vec::new());
        self.selection = None;
        self.renaming = None;
        self.find = None;
        self.loaded = false;
        self.player = None;
        self.player_tick = None;
        self.shown_at = std::time::Instant::now();
        #[cfg(debug_assertions)]
        {
            self.debug_live = false;
        }
        self.lit = None;
        self.collapsed = saved_collapsed();
        self.list
            .reset(self.lead_count() + usize::from(self.lead.is_some()));
        self.load_player(cx);
        self.refresh(cx);
    }

    pub fn update_meta(&mut self, meta: DocMeta, cx: &mut Context<Self>) {
        let audio_changed = self
            .meta
            .as_ref()
            .and_then(|m| m.meeting.as_ref())
            .map(|m| m.audio.len())
            != meta.meeting.as_ref().map(|m| m.audio.len());
        self.meta = Some(meta);
        if audio_changed {
            self.load_player(cx);
        }
        self.changed(cx);
    }

    fn load_player(&mut self, cx: &mut Context<Self>) {
        let Some(meta) = self.meta.as_ref() else {
            return;
        };
        let Some(meeting) = meta.meeting.as_ref().filter(|m| !m.audio.is_empty()) else {
            self.player = None;
            return;
        };
        if self.player.is_some() {
            return;
        }
        let Some(library) = super::store::library(cx) else {
            return;
        };
        let parts = player::parts(&library, &meta.id, meeting);
        if parts.is_empty() {
            return;
        }
        self.player = Some(Player::new(parts, meeting.duration_ms));
    }

    fn started_at(&self) -> Option<DateTime<Utc>> {
        self.meta
            .as_ref()
            .and_then(|m| m.meeting.as_ref())
            .and_then(|m| m.started_at)
    }

    fn self_name(&self) -> Option<String> {
        self.meta.as_ref().and_then(export::self_name)
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id.clone() else {
            return;
        };
        let started_at = self.started_at();
        let self_name = self.self_name();
        let live_rows = Meetings::try_global(cx).and_then(|meetings| {
            meetings.update(cx, |m, _| {
                if !m.is_finishing(&id) {
                    return None;
                }
                let transcript = m.transcript(&id)?;
                let rows = build_rows(
                    &transcript,
                    started_at,
                    self_name.as_deref(),
                    &self.hidden,
                );
                Some(rows)
            })
        });
        let recording = Meetings::try_global(cx)
            .and_then(|m| m.read(cx).active().map(|a| a.doc_id == id))
            .unwrap_or(false);
        if let Some(rows) = live_rows {
            if recording != self.live {
                self.live = recording;
                self.list
                    .set_follow_mode(if recording && !self.collapsed() {
                        gpui::FollowMode::Tail
                    } else {
                        gpui::FollowMode::Normal
                    });
            }
            self.loaded = true;
            self.apply(rows, cx);
            return;
        }
        if self.live {
            self.live = false;
            self.list.set_follow_mode(gpui::FollowMode::Normal);
        }
        let task = commands::load_transcript(&id, cx);
        self.load = Some(cx.spawn(async move |this, cx| {
            let transcript = task.await.unwrap_or_default();
            this.update(cx, |this, cx| {
                if this.doc_id.as_deref() != Some(id.as_str()) {
                    return;
                }
                let rows = build_rows(
                    &transcript,
                    started_at,
                    self_name.as_deref(),
                    &this.hidden,
                );
                this.loaded = true;
                let suggestions: HashMap<u32, String> = this
                    .meta
                    .as_ref()
                    .map(|meta| {
                        crate::meetings::speakers::name_guesses(&transcript, meta)
                            .into_iter()
                            .map(|(id, name, _)| (id, name))
                            .collect()
                    })
                    .unwrap_or_default();
                if *this.suggestions != suggestions {
                    this.suggestions = Rc::new(suggestions);
                    this.changed(cx);
                }
                this.apply(rows, cx);
            })
            .ok();
        }));
    }

    fn apply(&mut self, rows: Vec<TRow>, cx: &mut Context<Self>) {
        let prefix = common_prefix(&self.rows, &rows);
        let old_len = self.rows.len();
        if prefix == old_len && prefix == rows.len() {
            return;
        }
        let lead = self.lead_count();
        if !self.collapsed() {
            self.list
                .splice(lead + prefix..lead + old_len, rows.len() - prefix);
        }
        self.rows = Rc::new(rows);
        if let Some((a, b)) = self.selection
            && (a.max(b) >= self.rows.len())
        {
            self.selection = None;
        }
        self.refresh_find(cx);
        self.changed(cx);
    }

    pub fn reveal(&mut self, cx: &mut Context<Self>) {
        self.shown_at = std::time::Instant::now();
        if self.live && !self.collapsed() {
            self.list.set_follow_mode(gpui::FollowMode::Tail);
            self.list.scroll_to_end();
        }
        self.changed(cx);
    }

    fn is_live(&self) -> bool {
        #[cfg(debug_assertions)]
        if self.debug_live {
            return true;
        }
        self.live
    }

    /// The last few lines, newest last: who (and their colour), what, and
    /// whether the words may still change.
    pub fn latest(&self, n: usize) -> Vec<(String, gpui::Hsla, String, bool, String)> {
        let mut out: Vec<_> = self
            .rows
            .iter()
            .rev()
            .filter_map(|row| match row {
                TRow::Turn(turn) if !turn.text.trim().is_empty() => Some((
                    turn.label.clone(),
                    match turn.color {
                        None => self.palette.accent,
                        Some(i) => self.palette.speaker(i),
                    },
                    turn.text.clone(),
                    turn.partial,
                    turn.ids.first().cloned().unwrap_or_default(),
                )),
                _ => None,
            })
            .take(n)
            .collect();
        out.reverse();
        out
    }

    /// Tests: show these lines as if loaded from the library.
    #[cfg(test)]
    pub(super) fn load_for_test(&mut self, transcript: &Transcript, cx: &mut Context<Self>) {
        let rows = build_rows(transcript, self.started_at(), None, &self.hidden);
        self.loaded = true;
        self.apply(rows, cx);
    }

    /// Tests: the first line of each turn left out of the notes, and of
    /// each turn the user said was not them.
    #[cfg(test)]
    pub(super) fn voice_choices_shown(&self) -> (Vec<String>, Vec<String>) {
        let first = |pick: fn(&TurnRow) -> bool| {
            self.rows
                .iter()
                .filter_map(|row| match row {
                    TRow::Turn(turn) if pick(turn) => turn.ids.first().cloned(),
                    _ => None,
                })
                .collect()
        };
        (first(|t| t.left_out), first(|t| t.disowned))
    }

    /// Changes whenever the lines do.
    pub fn rows_revision(&self) -> usize {
        Rc::as_ptr(&self.rows) as usize
    }

    pub fn lead_count(&self) -> usize {
        self.lead.as_ref().map_or(0, |l| l.count)
    }

    /// Put the page's own items ahead of the lines (and room after them),
    /// or take them away.
    pub fn set_lead(&mut self, lead: Option<(usize, LeadRender, f32)>, cx: &mut Context<Self>) {
        let old = self.lead_count();
        let old_tail = usize::from(self.lead.is_some());
        let old_shown = self.listed_rows();
        let new = lead.as_ref().map_or(0, |(count, _, _)| *count);
        let new_tail = usize::from(lead.is_some());
        if lead.is_some() && self.lines.is_none() {
            let transcript = cx.weak_entity();
            self.lines = Some(cx.new(|_| LinesView {
                transcript,
                #[cfg(any(test, debug_assertions))]
                renders: 0,
            }));
        }
        self.lead = lead.map(|(count, render, tail)| Lead {
            count,
            render,
            tail,
        });
        let new_shown = self.listed_rows();
        if old_tail != new_tail {
            self.list
                .splice(old + old_shown..old + old_shown + old_tail, new_tail);
        }
        if old_shown != new_shown {
            self.list.splice(old..old + old_shown, new_shown);
        }
        if old != new {
            self.list.splice(0..old, new);
        }
        self.changed(cx);
    }

    /// Width the page's first item is laid out at, as of the frame being
    /// drawn (set before it is built).
    pub fn lead_width(&self) -> Pixels {
        self.lead_width.get()
    }

    /// The last measured height of the page's n-th floating item (zero
    /// until it has been laid out).
    pub fn float_height(&self, index: usize) -> Pixels {
        self.lead_height.borrow().get(index).copied().unwrap_or_default()
    }

    /// Room after the page's last line, so it clears whatever floats over
    /// the bottom of the page (the bar, and any line above it).
    pub fn set_tail(&mut self, tail: f32, cx: &mut Context<Self>) {
        if let Some(lead) = self.lead.as_mut()
            && (lead.tail - tail).abs() > 0.5
        {
            lead.tail = tail;
            self.changed(cx);
        }
    }

    pub fn list_state(&self) -> ListState {
        self.list.clone()
    }

    /// The lines as the notes see them: each turn's words, who said it,
    /// when, and the utterance it starts with.
    pub fn turns(&self) -> Vec<(String, String, u64, String)> {
        self.rows
            .iter()
            .filter_map(|row| match row {
                TRow::Turn(turn) if !turn.partial => Some((
                    turn.text.clone(),
                    turn.label.clone(),
                    turn.start_ms,
                    turn.ids.first().cloned().unwrap_or_default(),
                )),
                _ => None,
            })
            .collect()
    }

    fn row_of(&self, id: &str) -> Option<usize> {
        self.rows.iter().position(|row| match row {
            TRow::Turn(turn) => turn.ids.iter().any(|i| i == id),
            TRow::Minute { .. } => false,
        })
    }

    /// Light the lines a point came from (none to put them out).
    pub fn light(&mut self, ids: &[String], cx: &mut Context<Self>) {
        let ids: HashSet<String> = ids.iter().cloned().collect();
        if self.lit.as_ref().map(|l| &l.ids) == Some(&ids) || (ids.is_empty() && self.lit.is_none())
        {
            return;
        }
        if ids.is_empty() {
            self.lit = None;
        } else {
            self.lit_serial += 1;
            self.lit = Some(Lit {
                ids,
                serial: self.lit_serial,
            });
        }
        self.changed(cx);
    }

    /// Bring the first of these lines into view, two lines of context above.
    pub fn reveal_ids(&mut self, ids: &[String], cx: &mut Context<Self>) {
        let Some(row) = ids.iter().find_map(|id| self.row_of(id)) else {
            return;
        };
        self.set_collapsed(false, false, cx);
        self.list.scroll_to(gpui::ListOffset {
            item_ix: self.lead_count() + row.saturating_sub(2),
            offset_in_item: px(0.),
        });
        self.changed(cx);
    }

    /// Scroll the page so the transcript's first line sits at the top.
    pub fn reveal_start(&mut self, cx: &mut Context<Self>) {
        self.set_collapsed(false, false, cx);
        let lead = self.lead_count();
        self.list.scroll_to(gpui::ListOffset {
            item_ix: lead.saturating_sub(1),
            offset_in_item: px(0.),
        });
        self.changed(cx);
    }

    /// Whether the page shows only the heading. Only the page collapses;
    /// the side panel shows its lines whatever was saved.
    pub fn collapsed(&self) -> bool {
        self.collapsed && self.lead.is_some()
    }

    /// How many lines the list holds after the page's items.
    fn listed_rows(&self) -> usize {
        if self.collapsed() { 0 } else { self.rows.len() }
    }

    /// The heading's toggle: the choice is saved for every note.
    pub fn toggle_collapsed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let collapsed = !self.collapsed();
        if collapsed && self.find.is_some() {
            self.close_find(window, cx);
        }
        self.set_collapsed(collapsed, true, cx);
    }

    pub fn set_collapsed(&mut self, collapsed: bool, remember: bool, cx: &mut Context<Self>) {
        if remember {
            save_collapsed(collapsed);
        }
        if self.collapsed == collapsed {
            return;
        }
        let old_shown = self.listed_rows();
        self.collapsed = collapsed;
        let new_shown = self.listed_rows();
        if old_shown != new_shown {
            let lead = self.lead_count();
            self.list.splice(lead..lead + old_shown, new_shown);
        }
        if collapsed {
            self.selection = None;
            self.list.set_follow_mode(gpui::FollowMode::Normal);
        }
        self.changed(cx);
    }

    pub fn has_transcript(&self) -> bool {
        self.rows.iter().any(|r| matches!(r, TRow::Turn(_)))
    }

    fn turn(&self, index: usize) -> Option<&TurnRow> {
        match self.rows.get(index) {
            Some(TRow::Turn(turn)) => Some(turn),
            _ => None,
        }
    }

    fn selected_range(&self) -> Option<(usize, usize)> {
        self.selection.map(|(a, b)| (a.min(b), a.max(b)))
    }

    fn selected_turns(&self) -> Vec<&TurnRow> {
        let Some((a, b)) = self.selected_range() else {
            return Vec::new();
        };
        (a..=b).filter_map(|i| self.turn(i)).collect()
    }

    fn click_turn(
        &mut self,
        index: usize,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        if event.modifiers().shift
            && let Some((anchor, _)) = self.selection
        {
            self.selection = Some((anchor, index));
        } else if self.selection == Some((index, index)) {
            self.selection = None;
        } else {
            self.selection = Some((index, index));
        }
        self.changed(cx);
    }

    fn step(&mut self, delta: isize, extend: bool, cx: &mut Context<Self>) {
        if self.collapsed() {
            return;
        }
        let turns: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| matches!(r, TRow::Turn(_)))
            .map(|(i, _)| i)
            .collect();
        if turns.is_empty() {
            return;
        }
        let head = self.selection.map(|(_, b)| b);
        let position = head
            .and_then(|h| turns.iter().position(|t| *t == h))
            .map(|p| (p as isize + delta).clamp(0, turns.len() as isize - 1) as usize)
            .unwrap_or(if delta > 0 { 0 } else { turns.len() - 1 });
        let next = turns[position];
        self.selection = match (self.selection, extend) {
            (Some((anchor, _)), true) => Some((anchor, next)),
            _ => Some((next, next)),
        };
        self.list.scroll_to_reveal_item(self.lead_count() + next);
        self.changed(cx);
    }

    fn open_spell(
        &mut self,
        row: usize,
        at: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some((hovered, byte)) = self.hover.get().filter(|(r, _)| *r == row) else {
            return;
        };
        let Some(TRow::Turn(turn)) = self.rows.get(hovered) else {
            return;
        };
        let Some(wrong) = word_at(&turn.text, byte) else {
            return;
        };
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_text(wrong.clone(), cx);
            input
        });
        let subscription =
            cx.subscribe(
                &input,
                |this, input, event: &TextInputEvent, cx| match event {
                    TextInputEvent::Confirmed => {
                        let right = input.read(cx).text().trim().to_string();
                        this.apply_spell(right, cx);
                    }
                    TextInputEvent::Cancelled => {
                        this.spell = None;
                        this.changed(cx);
                    }
                    _ => {}
                },
            );
        input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
        self.spell = Some(Spell {
            wrong,
            at,
            input,
            _subscription: subscription,
        });
        self.changed(cx);
    }

    fn apply_spell(&mut self, right: String, cx: &mut Context<Self>) {
        let Some(spell) = self.spell.take() else {
            return;
        };
        self.changed(cx);
        let (Some(doc_id), Some(meetings)) = (self.doc_id.clone(), Meetings::try_global(cx)) else {
            return;
        };
        if right.is_empty() || right == spell.wrong {
            return;
        }
        meetings.update(cx, |m, cx| {
            m.always_spell(&doc_id, &spell.wrong, &right, cx)
        });
        self.root
            .update(cx, |root, cx| {
                root.show_toast(tr::documents::transcript::spelled(right), None, None, cx)
            })
            .ok();
    }

    /// A name chip in the rename popover: "Same person as" names apply at
    /// once; a suggestion fills the field (or moves the line in "Just this
    /// line"), so it can still be adjusted before Return.
    fn pick_name(
        name: String,
        merge: bool,
        cx: &mut Context<Self>,
    ) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
        cx.listener(move |this: &mut Self, _: &ClickEvent, _, cx| {
            if merge || this.renaming.as_ref().is_some_and(|r| r.line_only) {
                this.finish_rename(Some(name.clone()), cx);
            } else if let Some(rename) = this.renaming.as_ref() {
                let name = name.clone();
                rename
                    .input
                    .update(cx, |input, cx| input.set_text(name, cx));
            }
            cx.stop_propagation();
        })
    }

    fn render_rename(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let rename = self.renaming.as_ref()?;
        let palette = self.palette;
        let theme = input_theme(&palette);
        let turn = &rename.turn;
        let color = match turn.color {
            None => palette.accent,
            Some(i) => palette.speaker(i),
        };
        let chip = move |id: (&'static str, usize), name: String| {
            div()
                .id(id)
                .h(px(24.))
                .px(px(9.))
                .flex()
                .items_center()
                .rounded_full()
                .border_1()
                .border_color(palette.hairline)
                .text_size(px(12.))
                .text_color(palette.muted)
                .cursor_pointer()
                .hover(move |s| s.bg(palette.hover).text_color(palette.text))
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                .child(name)
        };
        let caption = |text: &'static str| {
            div()
                .text_size(px(11.5))
                .text_color(palette.faint)
                .child(text)
        };
        let suggested = self.suggested_names(turn);
        let others = if rename.line_only {
            self.other_speakers("")
                .into_iter()
                .filter(|n| *n != turn.label)
                .collect::<Vec<_>>()
        } else {
            self.other_speakers(&turn.label)
        };
        let line_only = rename.line_only;
        let pick = Self::pick_name;
        let suggested_row = (!suggested.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(caption(tr::documents::transcript::suggested()))
                .child(div().flex().flex_wrap().gap(px(6.)).children(
                    suggested.into_iter().enumerate().map(|(i, name)| {
                        chip(("speaker-suggest", i), name.clone()).on_click(pick(name, false, cx))
                    }),
                ))
        });
        let others_row = (!others.is_empty()).then(|| {
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(caption(tr::documents::transcript::same_as()))
                .child(div().flex().flex_wrap().gap(px(6.)).children(
                    others.into_iter().enumerate().map(|(i, name)| {
                        chip(("speaker-merge", i), name.clone()).on_click(pick(name, true, cx))
                    }),
                ))
        });
        let check = div()
            .id("speaker-line-only")
            .flex()
            .items_center()
            .gap(px(7.))
            .text_size(px(12.5))
            .text_color(if line_only {
                palette.text
            } else {
                palette.muted
            })
            .cursor_pointer()
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .child(
                div()
                    .size(px(14.))
                    .rounded(px(4.))
                    .border(px(1.5))
                    .border_color(if line_only {
                        palette.accent
                    } else {
                        palette.faint
                    })
                    .when(line_only, |el| el.bg(palette.accent))
                    .flex()
                    .items_center()
                    .justify_center()
                    .when(line_only, |el| {
                        el.child(
                            svg()
                                .path("icons/check.svg")
                                .size(px(10.))
                                .text_color(palette.content),
                        )
                    }),
            )
            .child(tr::documents::transcript::just_this_line())
            .on_click(cx.listener(|this, _, _, cx| {
                if let Some(rename) = this.renaming.as_mut() {
                    rename.line_only = !rename.line_only;
                    this.changed(cx);
                }
            }));
        let choice = |id: &'static str, focus: &FocusHandle, text: &'static str| {
            let ring = super::glass::focus_ring(&palette);
            div()
                .id(id)
                .track_focus(focus)
                .h(px(30.))
                .px(px(8.))
                .mx(px(-4.))
                .flex()
                .items_center()
                .rounded(px(7.))
                .text_size(px(13.))
                .text_color(palette.muted)
                .cursor_pointer()
                .hover(move |s| s.bg(palette.hover).text_color(palette.text))
                .focus_visible(move |s| s.shadow(ring).text_color(palette.text))
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                .child(text)
        };
        let me_choice = (!line_only && (turn.you || turn.disowned)).then(|| {
            let disowned = turn.disowned;
            choice(
                "speaker-not-me",
                &rename.choices[0],
                if disowned {
                    tr::documents::transcript::is_me()
                } else {
                    tr::documents::transcript::not_me()
                },
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.choose_not_me(!disowned, cx);
                cx.stop_propagation();
            }))
        });
        let out_choice = (!line_only).then(|| {
            let left_out = turn.left_out;
            choice(
                "speaker-leave-out",
                &rename.choices[1],
                if left_out {
                    tr::documents::transcript::include()
                } else {
                    tr::documents::transcript::leave_out()
                },
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                this.choose_left_out(!left_out, cx);
                cx.stop_propagation();
            }))
        });
        let choices = (me_choice.is_some() || out_choice.is_some()).then(|| {
            div()
                .flex()
                .flex_col()
                .pt(px(6.))
                .border_t_1()
                .border_color(palette.hairline)
                .children(me_choice)
                .children(out_choice)
        });
        let apply = style::ink_pill(&palette, "speaker-apply")
            .h(px(28.))
            .px(px(12.))
            .child(if line_only {
                tr::documents::transcript::move_line()
            } else {
                tr::documents::transcript::rename_all()
            })
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_click(cx.listener(|this, _, _, cx| {
                let name = this
                    .renaming
                    .as_ref()
                    .map(|r| r.input.read(cx).text().trim().to_string());
                this.finish_rename(name, cx);
            }));
        Some(super::menu::float(
            gpui::point(rename.at.x - px(18.), rename.at.y + px(16.)),
            super::menu::surface(&palette)
                .id("speaker-popover")
                .w(px(288.))
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(12.))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close_rename(cx)))
                .on_key_down(cx.listener(Self::rename_key))
                .child(
                    div()
                        .h(px(34.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .rounded(px(8.))
                        .bg(palette.field)
                        .child(div().size(px(8.)).rounded_full().bg(color).flex_shrink_0())
                        .child(
                            TextInput::bare(&theme, "speaker-rename", &rename.input)
                                .text_size(px(14.))
                                .text_color(palette.text)
                                .height(px(22.)),
                        ),
                )
                .children(suggested_row)
                .children(others_row)
                .children(choices)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.))
                        .child(check)
                        .child(apply),
                )
                .into_any_element(),
        ))
    }

    fn render_spell(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let spell = self.spell.as_ref()?;
        let palette = self.palette;
        let theme = input_theme(&palette);
        Some(super::menu::float(
            gpui::point(spell.at.x - px(12.), spell.at.y + px(10.)),
            super::menu::surface(&palette)
                .id("spell-popover")
                .w(px(260.))
                .p(px(12.))
                .flex()
                .flex_col()
                .gap(px(8.))
                .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                    this.spell = None;
                    this.changed(cx);
                }))
                .child(
                    div()
                        .text_size(px(12.5))
                        .text_color(palette.muted)
                        .child(tr::documents::transcript::always_spell(spell.wrong.clone())),
                )
                .child(
                    div()
                        .h(px(32.))
                        .px(px(10.))
                        .flex()
                        .items_center()
                        .rounded(px(8.))
                        .bg(palette.field)
                        .child(
                            TextInput::bare(&theme, "spell-input", &spell.input)
                                .text_size(px(14.))
                                .text_color(palette.text)
                                .height(px(22.)),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .gap(px(8.))
                        .child(
                            div()
                                .text_size(px(11.5))
                                .text_color(palette.faint)
                                .child(tr::documents::transcript::spell_note()),
                        )
                        .child(
                            style::ink_pill(&palette, "spell-save")
                                .h(px(28.))
                                .px(px(12.))
                                .child(tr::documents::transcript::spell_save())
                                .on_click(cx.listener(|this, _, _, cx| {
                                    let right = this
                                        .spell
                                        .as_ref()
                                        .map(|s| s.input.read(cx).text().trim().to_string())
                                        .unwrap_or_default();
                                    this.apply_spell(right, cx);
                                })),
                        ),
                )
                .into_any_element(),
        ))
    }

    fn copy_selection(&mut self, cx: &mut Context<Self>) {
        let turns = self.selected_turns();
        if turns.is_empty() {
            return;
        }
        let text = turns
            .iter()
            .map(|t| format!("[{}] {}: {}", format_timestamp(t.start_ms), t.label, t.text))
            .collect::<Vec<_>>()
            .join("\n");
        cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        self.root
            .update(cx, |root, cx| {
                root.show_toast(tr::documents::toast::copied(), None, None, cx)
            })
            .ok();
    }

    fn delete_selection(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .selected_turns()
            .iter()
            .flat_map(|t| t.ids.iter().cloned())
            .collect();
        if ids.is_empty() {
            return;
        }
        let turns = self.selected_turns().len();
        self.commit_hidden(cx);
        self.hidden.extend(ids.iter().cloned());
        self.pending_delete = ids.clone();
        self.selection = None;
        self.rebuild_from_scratch(cx);
        let entity = cx.weak_entity();
        let undo_entity = entity.clone();
        let undo_ids = ids.clone();
        let undo: super::window::ToastAction = Rc::new(move |_, cx| {
            let ids = undo_ids.clone();
            undo_entity
                .update(cx, |this, cx| {
                    if this.pending_delete != ids {
                        return;
                    }
                    this.pending_delete.clear();
                    for id in &ids {
                        this.hidden.remove(id);
                    }
                    this.rebuild_from_scratch(cx);
                })
                .ok();
        });
        let expire: super::window::ToastExpire = Rc::new(move |cx| {
            entity.update(cx, |this, cx| this.commit_hidden(cx)).ok();
        });
        self.root
            .update(cx, |root, cx| {
                root.show_toast(
                    tr::documents::toast::deleted_lines(turns),
                    Some((tr::documents::toast::undo().into(), undo)),
                    Some(expire),
                    cx,
                )
            })
            .ok();
    }

    fn commit_hidden(&mut self, cx: &mut Context<Self>) {
        if self.pending_delete.is_empty() {
            return;
        }
        let ids = std::mem::take(&mut self.pending_delete);
        if let (Some(doc), Some(meetings)) = (self.doc_id.clone(), Meetings::try_global(cx)) {
            meetings.update(cx, |m, cx| m.delete_utterances(&doc, ids, cx));
        }
    }

    fn rebuild_from_scratch(&mut self, cx: &mut Context<Self>) {
        self.refresh(cx);
    }

    fn start_rename(
        &mut self,
        turn: TurnRow,
        at: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_text(turn.label.clone(), cx);
            input
        });
        let subscription =
            cx.subscribe(
                &input,
                |this, input, event: &TextInputEvent, cx| match event {
                    TextInputEvent::Confirmed => {
                        let name = input.read(cx).text().trim().to_string();
                        this.finish_rename(Some(name), cx)
                    }
                    TextInputEvent::Cancelled => this.finish_rename(None, cx),
                    TextInputEvent::Changed | TextInputEvent::Blurred => {}
                },
            );
        // A stand-in like "Person 2" is selected so typing replaces it; a
        // real name keeps the caret at its end so it can be corrected.
        let placeholder = turn.placeholder;
        input.update(cx, |input, cx| {
            if placeholder {
                input.focus_and_select_all(window, cx);
            } else {
                window.focus(&input.focus_handle(), cx);
                input.move_to_end(cx);
            }
        });
        self.renaming = Some(Rename {
            turn,
            input,
            at,
            line_only: false,
            choices: [cx.focus_handle(), cx.focus_handle()],
            _subscription: subscription,
        });
        self.changed(cx);
    }

    /// Tab from the name field steps onto the popover's choices ("That's not
    /// me", "Leave this voice out of the notes") and back; Shift+Tab walks
    /// back. Enter or Space presses the focused choice.
    fn rename_key(
        &mut self,
        event: &gpui::KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(rename) = self.renaming.as_ref() else {
            return;
        };
        let keystroke = &event.keystroke;
        if keystroke.modifiers.platform || keystroke.modifiers.control {
            return;
        }
        let focused = rename.choices.iter().position(|h| h.is_focused(window));
        if let Some(at) = focused {
            let turn = &rename.turn;
            match keystroke.key.as_str() {
                "enter" | "space" => {
                    window.prevent_default();
                    cx.stop_propagation();
                    if at == 0 {
                        let not_me = !turn.disowned;
                        self.choose_not_me(not_me, cx);
                    } else {
                        let out = !turn.left_out;
                        self.choose_left_out(out, cx);
                    }
                    return;
                }
                "escape" => {
                    window.prevent_default();
                    cx.stop_propagation();
                    self.finish_rename(None, cx);
                    return;
                }
                _ => {}
            }
        }
        if keystroke.key != "tab" {
            return;
        }
        let turn = &rename.turn;
        let shown: Vec<FocusHandle> = [
            (!rename.line_only && (turn.you || turn.disowned)).then(|| rename.choices[0].clone()),
            (!rename.line_only).then(|| rename.choices[1].clone()),
        ]
        .into_iter()
        .flatten()
        .collect();
        if shown.is_empty() {
            return;
        }
        let field = rename.input.read(cx).focus_handle();
        let mut ring = vec![field];
        ring.extend(shown);
        let at = ring.iter().position(|h| h.is_focused(window)).unwrap_or(0);
        let next = if keystroke.modifiers.shift {
            (at + ring.len() - 1) % ring.len()
        } else {
            (at + 1) % ring.len()
        };
        window.focus(&ring[next], cx);
        window.prevent_default();
        cx.stop_propagation();
        self.changed(cx);
    }

    /// "That's not me" on the voice shown as the user (or "That's me" to take
    /// it back): this meeting only, with an undo.
    fn choose_not_me(&mut self, not_me: bool, cx: &mut Context<Self>) {
        let Some(rename) = self.renaming.take() else {
            return;
        };
        self.changed(cx);
        let (Some(doc), Some(meetings), Some(id)) = (
            self.doc_id.clone(),
            Meetings::try_global(cx),
            rename.turn.speaker_id,
        ) else {
            return;
        };
        let Some(undo) = meetings.update(cx, |m, cx| m.set_not_me(&doc, id, not_me, cx)) else {
            return;
        };
        let message = not_me_message(doc.clone(), id, not_me, cx);
        let root = self.root.clone();
        cx.spawn(async move |_, cx| {
            let message = message.await;
            cx.update(|cx| {
                let action: super::window::ToastAction = Rc::new(move |_, cx| {
                    let undo = undo.clone();
                    if let Some(meetings) = Meetings::try_global(cx) {
                        meetings.update(cx, |m, cx| m.undo_speaker_choice(&doc, undo, cx));
                    }
                });
                root.update(cx, |root, cx| {
                    root.show_toast(
                        message,
                        Some((tr::documents::toast::undo().into(), action)),
                        None,
                        cx,
                    )
                })
                .ok();
            });
        })
        .detach();
    }

    /// "Leave this voice out of the notes" (or back in). The lines stay
    /// here, dimmed; the next summary and Ask leave them out. When the note
    /// already has a summary, the toast offers to write it again.
    fn choose_left_out(&mut self, out: bool, cx: &mut Context<Self>) {
        let Some(rename) = self.renaming.take() else {
            return;
        };
        self.changed(cx);
        let (Some(doc), Some(meetings)) = (self.doc_id.clone(), Meetings::try_global(cx)) else {
            return;
        };
        let speaker = rename_target(&rename.turn);
        let Some(undo) = meetings.update(cx, |m, cx| m.leave_out_speaker(&doc, speaker, out, cx))
        else {
            return;
        };
        let root = self.root.clone();
        let has_summary = root
            .upgrade()
            .is_some_and(|root| root.read(cx).pane.read(cx).has_enhanced());
        let message = if out {
            tr::documents::toast::left_out()
        } else {
            tr::documents::toast::back_in()
        };
        let action: (SharedString, super::window::ToastAction) = if has_summary {
            let root = root.clone();
            let update: super::window::ToastAction = Rc::new(move |_, cx| {
                if let Some(root) = root.upgrade() {
                    let pane = root.read(cx).pane.clone();
                    pane.update(cx, |pane, cx| pane.write_notes(None, cx));
                }
            });
            (tr::documents::notes::update_notes().into(), update)
        } else {
            let undo: super::window::ToastAction = Rc::new(move |_, cx| {
                let undo = undo.clone();
                if let Some(meetings) = Meetings::try_global(cx) {
                    meetings.update(cx, |m, cx| m.undo_speaker_choice(&doc, undo, cx));
                }
            });
            (tr::documents::toast::undo().into(), undo)
        };
        root.update(cx, |root, cx| {
            root.show_toast(message, Some(action), None, cx)
        })
        .ok();
    }

    fn finish_rename(&mut self, name: Option<String>, cx: &mut Context<Self>) {
        let Some(rename) = self.renaming.take() else {
            return;
        };
        if rename.line_only {
            self.move_line(rename.turn, name, cx);
        } else {
            self.rename_to(rename.turn, name, cx);
        }
        self.changed(cx);
    }

    /// A click outside the popover keeps what was typed, the way leaving a
    /// field does; an untouched popover just closes.
    fn close_rename(&mut self, cx: &mut Context<Self>) {
        let Some(rename) = self.renaming.as_ref() else {
            return;
        };
        let name = rename.input.read(cx).text().trim().to_string();
        let changed = !name.is_empty() && name != rename.turn.label;
        self.finish_rename(changed.then_some(name), cx);
    }

    /// "Just this line": the clicked line was someone else; the voice keeps
    /// its name everywhere else.
    fn move_line(&mut self, turn: TurnRow, name: Option<String>, cx: &mut Context<Self>) {
        let Some(name) = name.filter(|n| !n.is_empty() && *n != turn.label) else {
            return;
        };
        let (Some(doc), Some(meetings)) = (self.doc_id.clone(), Meetings::try_global(cx)) else {
            return;
        };
        let undo = meetings.update(cx, |m, cx| m.reassign_lines(&doc, &turn.ids, &name, cx));
        if let Some(lines) = undo {
            let action: super::window::ToastAction = Rc::new(move |_, cx| {
                let lines = lines.clone();
                let doc = doc.clone();
                if let Some(meetings) = Meetings::try_global(cx) {
                    meetings.update(cx, |m, cx| m.restore_lines(&doc, lines, cx));
                }
            });
            self.root
                .update(cx, |root, cx| {
                    root.show_toast(
                        tr::documents::toast::moved_line(&name),
                        Some((tr::documents::toast::undo().into(), action)),
                        None,
                        cx,
                    )
                })
                .ok();
        }
    }

    /// Names worth offering for this voice: what the meeting's words or the
    /// meeting app suggested, then calendar attendees, without the names
    /// already on screen.
    fn suggested_names(&self, turn: &TurnRow) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if turn.speaker.is_none()
            && let Some(name) = turn.speaker_id.and_then(|id| self.suggestions.get(&id))
        {
            out.push(name.clone());
        }
        if let Some(meta) = self.meta.as_ref() {
            for name in export::participants(meta) {
                if !out.contains(&name) {
                    out.push(name);
                }
            }
        }
        let shown: HashSet<&str> = self
            .rows
            .iter()
            .filter_map(|row| match row {
                TRow::Turn(t) => Some(t.label.as_str()),
                _ => None,
            })
            .collect();
        out.retain(|name| !shown.contains(name.as_str()));
        out.truncate(4);
        out
    }

    fn rename_to(&mut self, turn: TurnRow, name: Option<String>, cx: &mut Context<Self>) {
        if let Some(name) = name.filter(|n| !n.is_empty() && *n != turn.label)
            && let (Some(doc), Some(meetings)) = (self.doc_id.clone(), Meetings::try_global(cx))
        {
            let speaker = rename_target(&turn);
            let undo = meetings.update(cx, |m, cx| m.rename_speaker(&doc, speaker, &name, cx));
            if let Some(undo) = undo {
                let action: super::window::ToastAction = Rc::new(move |_, cx| {
                    let undo = undo.clone();
                    let doc = doc.clone();
                    if let Some(meetings) = Meetings::try_global(cx) {
                        meetings.update(cx, |m, cx| m.undo_rename(&doc, undo, cx));
                    }
                });
                self.root
                    .update(cx, |root, cx| {
                        root.show_toast(
                            tr::documents::toast::renamed(&name),
                            Some((tr::documents::toast::undo().into(), action)),
                            None,
                            cx,
                        )
                    })
                    .ok();
            }
        }
        self.changed(cx);
    }

    /// Everyone heard, by the label the transcript shows and their colour,
    /// for the name pills in the summary.
    pub fn people(&self) -> Vec<(String, gpui::Hsla)> {
        let mut out: Vec<(String, gpui::Hsla)> = Vec::new();
        for row in self.rows.iter() {
            if let TRow::Turn(turn) = row
                && !turn.partial
                && !out.iter().any(|(name, _)| *name == turn.label)
            {
                let color = match turn.color {
                    None => self.palette.accent,
                    Some(i) => self.palette.speaker(i),
                };
                out.push((turn.label.clone(), color));
            }
        }
        out
    }

    /// Opens the rename popover for whoever the transcript labels `label`
    /// (a name clicked in the summary).
    pub fn rename_label(
        &mut self,
        label: &str,
        at: gpui::Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let turn = self.rows.iter().find_map(|row| match row {
            TRow::Turn(turn) if turn.label == label => Some(turn.clone()),
            _ => None,
        });
        if let Some(turn) = turn {
            self.start_rename(turn, at, window, cx);
        }
    }

    /// The other names in this meeting, for "Same person as": picking one
    /// gives this voice that name, so both read as one person everywhere.
    fn other_speakers(&self, label: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for row in self.rows.iter() {
            if let TRow::Turn(turn) = row
                && turn.label != label
                && !out.contains(&turn.label)
            {
                out.push(turn.label.clone());
            }
        }
        out.truncate(4);
        out
    }

    /// For the screenshot harness: opens the rename field on the first line
    /// labelled `label` with `text` typed, and commits it when `commit` is set.
    pub fn debug_rename(
        &mut self,
        label: &str,
        text: &str,
        commit: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(turn) = self.rows.iter().find_map(|row| match row {
            TRow::Turn(turn) if turn.label == label => Some(turn.clone()),
            _ => None,
        }) else {
            tracing::warn!(label, "no transcript line with that speaker");
            return;
        };
        self.start_rename(turn, gpui::point(px(360.), px(260.)), window, cx);
        if commit {
            self.finish_rename(Some(text.to_string()), cx);
        } else if let Some(rename) = self.renaming.as_ref() {
            rename
                .input
                .update(cx, |input, cx| input.set_text(text.to_string(), cx));
        }
    }

    pub fn open_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_collapsed(false, false, cx);
        if let Some(find) = self.find.as_ref() {
            let input = find.input.clone();
            input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
            return;
        }
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::transcript::find());
            input
        });
        let subscription = cx.subscribe_in(
            &input,
            window,
            |this, _, event: &TextInputEvent, window, cx| match event {
                TextInputEvent::Changed => this.refresh_find(cx),
                TextInputEvent::Confirmed => this.find_step(1, cx),
                TextInputEvent::Cancelled => this.close_find(window, cx),
                TextInputEvent::Blurred => {}
            },
        );
        input.update(cx, |input, cx| input.focus_and_select_all(window, cx));
        self.find = Some(Find {
            input,
            matches: Vec::new(),
            current: 0,
            _subscription: subscription,
        });
        self.changed(cx);
    }

    fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find = None;
        window.focus(&self.focus, cx);
        self.changed(cx);
    }

    fn find_query(&self, cx: &App) -> String {
        self.find
            .as_ref()
            .map(|f| f.input.read(cx).text().trim().to_string())
            .unwrap_or_default()
    }

    fn refresh_find(&mut self, cx: &mut Context<Self>) {
        let query = self.find_query(cx).to_lowercase();
        let Some(find) = self.find.as_mut() else {
            return;
        };
        find.matches = if query.is_empty() {
            Vec::new()
        } else {
            self.rows
                .iter()
                .enumerate()
                .filter(|(_, row)| match row {
                    TRow::Turn(turn) => turn.text.to_lowercase().contains(&query),
                    TRow::Minute { .. } => false,
                })
                .map(|(i, _)| i)
                .collect()
        };
        find.current = find.current.min(find.matches.len().saturating_sub(1));
        if let Some(index) = find.matches.get(find.current).copied() {
            self.list.scroll_to_reveal_item(self.lead_count() + index);
        }
        self.changed(cx);
    }

    fn find_step(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(find) = self.find.as_mut() else {
            return;
        };
        if find.matches.is_empty() {
            return;
        }
        let len = find.matches.len() as isize;
        find.current = (find.current as isize + delta).rem_euclid(len) as usize;
        let index = find.matches[find.current];
        let lead = self.lead_count();
        self.list.scroll_to_reveal_item(lead + index);
        self.changed(cx);
    }

    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.renaming.is_some() {
            self.finish_rename(None, cx);
            return true;
        }
        if self.find.is_some() {
            self.close_find(window, cx);
            return true;
        }
        if self.selection.take().is_some() {
            self.changed(cx);
            return true;
        }
        false
    }

    fn jump_to_latest(&mut self, cx: &mut Context<Self>) {
        self.list.set_follow_mode(gpui::FollowMode::Tail);
        self.list.scroll_to_end();
        self.changed(cx);
    }

    fn play_from(&mut self, ms: u64, cx: &mut Context<Self>) {
        let Some(player) = self.player.as_ref() else {
            return;
        };
        player.play_from(ms.saturating_sub(300));
        self.ensure_player_tick(cx);
        self.changed(cx);
    }

    fn toggle_play(&mut self, cx: &mut Context<Self>) {
        let Some(player) = self.player.as_ref() else {
            return;
        };
        if player.is_playing() {
            player.pause();
        } else if player.position_ms() == 0 && player.shared.emitted.load(Ordering::Relaxed) == 0 {
            player.play_from(0);
        } else {
            player.resume();
        }
        self.ensure_player_tick(cx);
        self.changed(cx);
    }

    fn ensure_player_tick(&mut self, cx: &mut Context<Self>) {
        if self.player_tick.is_some() {
            return;
        }
        self.player_tick = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(150))
                .await;
            loop {
                let keep = this
                    .update(cx, |this, cx| {
                        this.changed(cx);
                        this.player.as_ref().is_some_and(Player::is_playing)
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
            }
            this.update(cx, |this, _| this.player_tick = None).ok();
        }));
    }

    fn seek_to(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let bounds = self.scrubber.get();
        let Some(player) = self.player.as_ref() else {
            return;
        };
        if bounds.size.width <= px(1.) {
            return;
        }
        let fraction = ((x - bounds.left()) / bounds.size.width).clamp(0., 1.);
        player.play_from((player.duration_ms as f32 * fraction) as u64);
        self.ensure_player_tick(cx);
        self.changed(cx);
    }
}

impl Focusable for TranscriptView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TranscriptView {
    fn render_row(&self, index: usize, entity: &Entity<Self>, cx: &App) -> AnyElement {
        let palette = self.palette;
        let pad = column_padding(self.width);
        let column = |child: AnyElement| {
            div()
                .w_full()
                .flex()
                .justify_center()
                .px(px(pad))
                .child(div().w_full().max_w(px(COLUMN_WIDTH)).child(child))
                .into_any_element()
        };
        match self.rows.get(index) {
            Some(TRow::Minute { label, .. }) => column(
                div()
                    .pt(px(if index == 0 { 4. } else { 14. }))
                    .pb(px(2.))
                    .text_size(px(11.5))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(palette.faint)
                    .child(label.clone())
                    .into_any_element(),
            ),
            Some(TRow::Turn(turn)) => {
                let selected = self
                    .selected_range()
                    .is_some_and(|(a, b)| (a..=b).contains(&index));
                let find = self.find.as_ref();
                let current_match = find
                    .and_then(|f| f.matches.get(f.current))
                    .is_some_and(|m| *m == index);
                let query = if find.is_some_and(|f| f.matches.contains(&index)) {
                    self.find_query(cx)
                } else {
                    String::new()
                };
                let color = match turn.color {
                    None => palette.accent,
                    Some(i) => palette.speaker(i),
                };
                let editing = self
                    .renaming
                    .as_ref()
                    .is_some_and(|r| r.turn.ids.first() == turn.ids.first());
                let has_audio = self.player.is_some();
                let click_entity = entity.clone();
                let rename_entity = entity.clone();
                let play_entity = entity.clone();
                let rename_turn = turn.clone();
                let start_ms = turn.start_ms;
                // A gentle hint, never applied by itself: the name the
                // meeting suggests for this voice, inside its badge.
                let hint = turn
                    .speaker
                    .is_none()
                    .then(|| turn.speaker_id.and_then(|id| self.suggestions.get(&id)))
                    .flatten()
                    .map(|name| tr::documents::transcript::maybe(name));
                let label = speaker_badge(
                    SharedString::from(format!("speaker-{index}")),
                    turn.label.clone(),
                    hint,
                    color,
                    editing,
                    &palette,
                )
                .on_click(move |event, window, cx| {
                    let turn = rename_turn.clone();
                    let at = event.position();
                    rename_entity.update(cx, |this, cx| this.start_rename(turn, at, window, cx));
                    cx.stop_propagation();
                })
                .into_any_element();
                let stamp = div()
                    .id(SharedString::from(format!("stamp-{index}")))
                    .text_size(px(11.5))
                    .text_color(palette.faint)
                    .child(format_timestamp(turn.start_ms))
                    .when(has_audio, |el| {
                        el.cursor_pointer()
                            .hover(move |s| s.text_color(palette.accent))
                            .on_click(move |_, _, cx| {
                                play_entity.update(cx, |this, cx| this.play_from(start_ms, cx));
                                cx.stop_propagation();
                            })
                    });
                let text: AnyElement = if query.is_empty() && !turn.partial {
                    let hover = self.hover.clone();
                    gpui::InteractiveText::new(
                        SharedString::from(format!("turn-text-{index}")),
                        gpui::StyledText::new(turn.text.clone()),
                    )
                    .on_hover(move |at, _, _, _| hover.set(at.map(|at| (index, at))))
                    .into_any_element()
                } else if query.is_empty() {
                    div().child(turn.text.clone()).into_any_element()
                } else {
                    div()
                        .child(emphasised(turn.text.clone().into(), &query, &palette))
                        .into_any_element()
                };
                let lit = self
                    .lit
                    .as_ref()
                    .filter(|lit| turn.ids.iter().any(|id| lit.ids.contains(id)))
                    .map(|lit| lit.serial);
                let row = div()
                        .id(SharedString::from(format!("turn-{index}")))
                        .mx(px(-10.))
                        .my(px(2.))
                        .px(px(10.))
                        .py(px(6.))
                        .rounded(px(8.))
                        .when(selected, |el| el.bg(palette.accent_soft))
                        .when(current_match && !selected, |el| el.bg(palette.hover))
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .on_click(move |event, window, cx| {
                            click_entity
                                .update(cx, |this, cx| this.click_turn(index, event, window, cx));
                        })
                        .on_mouse_down(MouseButton::Right, {
                            let entity = entity.clone();
                            move |event, window, cx| {
                                let at = event.position;
                                entity
                                    .update(cx, |this, cx| this.open_spell(index, at, window, cx));
                            }
                        })
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .child(label)
                                .child(stamp)
                                .when(turn.left_out, |el| {
                                    el.child(
                                        div()
                                            .text_size(px(11.5))
                                            .text_color(palette.faint)
                                            .child(tr::documents::transcript::left_out()),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .text_size(px(14.))
                                .line_height(px(22.))
                                .text_color(if turn.left_out {
                                    palette.muted
                                } else {
                                    palette.text
                                })
                                .when(turn.partial, |el| el.opacity(0.5))
                                .when(turn.left_out && !turn.partial, |el| el.opacity(0.7))
                                .child(text),
                        );
                let row = match lit {
                    Some(serial) if !selected => {
                        let wash = palette.accent_soft;
                        if style::reduce_motion() {
                            row.bg(wash).into_any_element()
                        } else {
                            row.with_animation(
                                ("turn-lit", serial),
                                gpui::Animation::new(LIT_FADE).with_easing(gpui::ease_out_quint()),
                                move |el, t| el.bg(gpui::Hsla { a: wash.a * t, ..wash }),
                            )
                            .into_any_element()
                        }
                    }
                    _ => row.into_any_element(),
                };
                column(row)
            }
            None => div().into_any_element(),
        }
    }

    fn sticky_label(&self) -> Option<String> {
        let top = self.list.logical_scroll_top();
        let lead = self.lead_count();
        if self.collapsed()
            || top.item_ix < lead
            || (top.item_ix == 0 && top.offset_in_item <= px(0.5))
        {
            return None;
        }
        let top_row = top.item_ix - lead;
        if self.rows.is_empty() {
            return None;
        }
        self.rows[..=top_row.min(self.rows.len() - 1)]
            .iter()
            .rev()
            .find_map(|row| match row {
                TRow::Minute { label, .. } => Some(label.clone()),
                TRow::Turn(_) => None,
            })
    }

    fn render_player(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let player = self.player.as_ref()?;
        let palette = self.palette;
        let playing = player.is_playing();
        let position = player.position_ms();
        let duration = player.duration_ms.max(1);
        let fraction = position as f32 / duration as f32;
        let scrubber = self.scrubber.clone();
        let pad = column_padding(self.width);
        Some(
            div()
                .w_full()
                .flex()
                .justify_center()
                .px(px(pad))
                .pb(px(6.))
                .child(
                    div()
                        .w_full()
                        .max_w(px(COLUMN_WIDTH))
                        .h(px(34.))
                        .px(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .rounded(px(10.))
                        .bg(palette.field)
                        .child(
                            div()
                                .id("player-toggle")
                                .size(px(26.))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded_full()
                                .cursor_pointer()
                                .hover(move |s| s.bg(palette.hover))
                                .child(
                                    svg()
                                        .path(if playing {
                                            "icons/pause.svg"
                                        } else {
                                            "icons/play.svg"
                                        })
                                        .size(px(12.))
                                        .text_color(palette.text),
                                )
                                .on_click(cx.listener(|this, _, _, cx| this.toggle_play(cx))),
                        )
                        .child(
                            div()
                                .id("player-scrubber")
                                .flex_1()
                                .h(px(20.))
                                .flex()
                                .items_center()
                                .cursor_pointer()
                                .relative()
                                .child(
                                    canvas(
                                        move |bounds, _, _| scrubber.set(bounds),
                                        |_, _, _, _| {},
                                    )
                                    .absolute()
                                    .size_full(),
                                )
                                .child(
                                    div()
                                        .w_full()
                                        .h(px(4.))
                                        .rounded_full()
                                        .bg(palette.hairline)
                                        .child(
                                            div()
                                                .h_full()
                                                .rounded_full()
                                                .bg(palette.accent)
                                                .w(gpui::relative(fraction.clamp(0., 1.))),
                                        ),
                                )
                                .on_mouse_down(
                                    MouseButton::Left,
                                    cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                                        this.seek_to(event.position.x, cx)
                                    }),
                                ),
                        )
                        .child(
                            div()
                                .pr(px(8.))
                                .text_size(px(12.))
                                .text_color(palette.muted)
                                .child(format!(
                                    "{} / {}",
                                    format::elapsed(position),
                                    format::elapsed(duration)
                                )),
                        ),
                )
                .into_any_element(),
        )
    }

    fn render_find(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let find = self.find.as_ref()?;
        let palette = self.palette;
        let count = if find.matches.is_empty() {
            if self.find_query(cx).is_empty() {
                String::new()
            } else {
                tr::documents::transcript::no_matches().to_string()
            }
        } else {
            format!("{}/{}", find.current + 1, find.matches.len())
        };
        let button = |id: &'static str, icon: &'static str| {
            div()
                .id(id)
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |s| s.bg(palette.hover))
                .child(svg().path(icon).size(px(13.)).text_color(palette.muted))
        };
        Some(
            div()
                .absolute()
                .top(px(6.))
                .right(px(16.))
                .child(
                    super::menu::surface(&palette)
                        .w(px(300.))
                        .h(px(36.))
                        .pl(px(10.))
                        .pr(px(4.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .child(
                            svg()
                                .path("icons/search.svg")
                                .size(px(13.))
                                .text_color(palette.faint),
                        )
                        .child(
                            TextInput::bare(&input_theme(&palette), "transcript-find", &find.input)
                                .text_size(px(13.))
                                .text_color(palette.text)
                                .placeholder_color(palette.faint)
                                .height(px(24.)),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.))
                                .text_color(palette.muted)
                                .child(count),
                        )
                        .child(
                            button("find-prev", "icons/chevron-up.svg")
                                .on_click(cx.listener(|this, _, _, cx| this.find_step(-1, cx))),
                        )
                        .child(
                            button("find-next", "icons/chevron-down.svg")
                                .on_click(cx.listener(|this, _, _, cx| this.find_step(1, cx))),
                        )
                        .child(button("find-close", "icons/x.svg").on_click(
                            cx.listener(|this, _, window, cx| this.close_find(window, cx)),
                        )),
                )
                .into_any_element(),
        )
    }

    fn render_selection_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let count = self.selected_turns().len();
        if count == 0 {
            return None;
        }
        let palette = self.palette;
        let action = |id: &'static str, label: &'static str, danger: bool| {
            div()
                .id(id)
                .h(px(26.))
                .px(px(10.))
                .flex()
                .items_center()
                .rounded_full()
                .cursor_pointer()
                .text_color(if danger { palette.danger } else { palette.text })
                .hover(move |s| s.bg(palette.hover))
                .child(label)
        };
        Some(
            div()
                .absolute()
                .top(px(6.))
                .left_0()
                .right_0()
                .flex()
                .justify_center()
                .child(
                    super::menu::surface(&palette)
                        .rounded_full()
                        .h(px(36.))
                        .pl(px(14.))
                        .pr(px(5.))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .child(
                            div()
                                .mr(px(6.))
                                .text_color(palette.muted)
                                .child(tr::documents::transcript::selected(count)),
                        )
                        .child(
                            action("sel-copy", tr::documents::transcript::copy(), false)
                                .on_click(cx.listener(|this, _, _, cx| this.copy_selection(cx))),
                        )
                        .child(
                            action("sel-delete", tr::documents::transcript::delete(), true)
                                .on_click(cx.listener(|this, _, _, cx| this.delete_selection(cx))),
                        ),
                )
                .into_any_element(),
        )
    }
}

fn input_theme(palette: &Palette) -> Theme {
    Theme::new(if palette.dark {
        Appearance::Dark
    } else {
        Appearance::Light
    })
}

impl TranscriptView {
    /// The lines (after the page's own items, if any) in one list. With a
    /// page, all but its last item are only spacers: [`PageScroll`] lays the
    /// title and the summary over them.
    fn render_list(
        entity: Entity<Self>,
        list: ListState,
        lead: Option<(usize, LeadRender, f32)>,
        spacers: Spacers,
    ) -> gpui::List {
        gpui::list(list, move |index, window, cx| {
            if let Some((count, render, tail)) = &lead {
                if index + 1 < *count {
                    let height = spacers.borrow().get(index).copied().unwrap_or_default();
                    return div().h(height).into_any_element();
                }
                if index < *count {
                    return render(index, window, cx);
                }
                if index - count >= entity.read(cx).listed_rows() {
                    return div().h(px(*tail)).into_any_element();
                }
            }
            let row = index - lead.as_ref().map_or(0, |l| l.0);
            entity.read(cx).render_row(row, &entity, cx)
        })
        .size_full()
    }

    /// How often the page's lines were drawn afresh (dev builds; 0 in
    /// release).
    pub(crate) fn lines_renders(&self, cx: &App) -> usize {
        #[cfg(any(test, debug_assertions))]
        {
            self.lines.as_ref().map_or(0, |l| l.read(cx).renders)
        }
        #[cfg(not(any(test, debug_assertions)))]
        {
            let _ = cx;
            0
        }
    }

    /// How often the page's first item changed height, each one repainting
    /// the lines (dev builds; 0 in release).
    pub(crate) fn lead_resizes(&self) -> usize {
        #[cfg(any(test, debug_assertions))]
        {
            self.lead_resizes.get()
        }
        #[cfg(not(any(test, debug_assertions)))]
        {
            0
        }
    }
}

/// The page's lines, which [`PageScroll`] draws as a cached view.
pub struct LinesView {
    transcript: WeakEntity<TranscriptView>,
    #[cfg(any(test, debug_assertions))]
    renders: usize,
}

impl Render for LinesView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(any(test, debug_assertions))]
        {
            self.renders += 1;
        }
        let Some(entity) = self.transcript.upgrade() else {
            return div().into_any_element();
        };
        let t = entity.read(cx);
        let (list, spacer) = (t.list.clone(), t.lead_height.clone());
        let lead = t.lead.as_ref().map(|l| (l.count, l.render.clone(), l.tail));
        TranscriptView::render_list(entity, list, lead, spacer).into_any_element()
    }
}

/// The page's one scroll: the lines as a cached view, with the title and the
/// summary laid over the spacers at their top. A key typed in the summary
/// repaints the summary only; the lines repaint when they change, scroll,
/// or a floating item grows or shrinks.
struct PageScroll {
    lines: Entity<LinesView>,
    lead: LeadRender,
    /// How many of the page's items float (all but the last).
    floats: usize,
    list: ListState,
    heights: Spacers,
    width: Rc<Cell<Pixels>>,
    revision: u64,
    drawn: Rc<Cell<Option<u64>>>,
    #[cfg(any(test, debug_assertions))]
    resizes: Rc<Cell<usize>>,
}

impl IntoElement for PageScroll {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl Element for PageScroll {
    type RequestLayoutState = ();
    type PrepaintState = (AnyElement, Vec<AnyElement>);

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
    ) -> Self::PrepaintState {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            self.width.set(bounds.size.width);
            let mut fresh = self.drawn.get() != Some(self.revision);
            // Each floating item is built only while some of it shows, as the
            // list does with its own items, and laid out before the lines so
            // a new height reaches its spacer this frame.
            let top = self.list.logical_scroll_top();
            // Never borrowed across building an item: the page reads these
            // heights while it builds them (its header's last height).
            self.heights.borrow_mut().resize(self.floats, px(0.));
            let mut y = -top.offset_in_item;
            let mut built: Vec<(usize, AnyElement)> = Vec::new();
            for index in top.item_ix..self.floats {
                let known = self.heights.borrow()[index];
                if y >= bounds.size.height {
                    break;
                }
                let shows = known == px(0.) || y + known > px(0.);
                if shows {
                    let mut item = (self.lead)(index, window, cx);
                    let space = size(
                        AvailableSpace::Definite(bounds.size.width),
                        AvailableSpace::MinContent,
                    );
                    let height = item.layout_as_root(space, window, cx).height;
                    if height != known {
                        #[cfg(any(test, debug_assertions))]
                        self.resizes.set(self.resizes.get() + 1);
                        self.heights.borrow_mut()[index] = height;
                        self.list.remeasure_items(index..index + 1);
                        fresh = true;
                    }
                    built.push((index, item));
                }
                y += self.heights.borrow()[index];
            }
            self.drawn.set(Some(self.revision));
            let view = AnyView::from(self.lines.clone());
            let mut lines = if fresh {
                view.into_any_element()
            } else {
                view.cached(StyleRefinement::default().size_full())
                    .into_any_element()
            };
            lines.layout_as_root(bounds.size.into(), window, cx);
            lines.prepaint_at(bounds.origin, window, cx);
            // Placed after the lines, where the list put their spacers, and
            // above them so their clicks and hovers come first, as before.
            let mut placed = Vec::with_capacity(built.len());
            let mut shown = Vec::with_capacity(built.len());
            for (index, mut item) in built {
                if let Some(at) = self.list.bounds_for_item(index) {
                    item.prepaint_at(at.origin, window, cx);
                    placed.push(item);
                    shown.push(index);
                }
            }
            let missed = (0..self.floats).any(|index| {
                !shown.contains(&index)
                    && self
                        .list
                        .bounds_for_item(index)
                        .is_some_and(|at| at.intersects(&bounds))
            });
            if missed {
                // The list scrolled back to the items while laying out.
                window.request_animation_frame();
            }
            (lines, placed)
        })
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        (lines, placed): &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            lines.paint(window, cx);
            for item in placed {
                item.paint(window, cx);
            }
        });
    }
}

impl Render for TranscriptView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let palette = self.palette;
        let entity = cx.entity();
        let empty = self.loaded && !self.has_transcript();
        let following = self.list.is_following_tail();
        let sticky = self.sticky_label();
        let sticky_bg = if self.inline || self.lead.is_some() {
            palette.content
        } else {
            palette.capsule
        };
        let pad = column_padding(self.width);
        let body: AnyElement = if self.lead.is_none() && (empty || !self.loaded) {
            let live = self.is_live();
            div()
                .flex_1()
                .flex()
                .flex_col()
                .items_center()
                .justify_center()
                .gap(px(6.))
                .when(self.loaded, |el| {
                    el.child(style::art(
                        &doodles::TALK,
                        palette.doodle(),
                        self.shown_at,
                        96.,
                        84.,
                    ))
                    .child(
                        div()
                            .mt(px(6.))
                            .text_size(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.text)
                            .child(if live {
                                tr::documents::transcript::listening()
                            } else {
                                tr::documents::transcript::empty()
                            }),
                    )
                    .child(
                        div()
                            .max_w(px(320.))
                            .text_center()
                            .text_size(px(13.5))
                            .line_height(px(20.))
                            .text_color(palette.muted)
                            .child(if live {
                                tr::documents::panel::listening_hint()
                            } else {
                                tr::documents::panel::empty_hint()
                            }),
                    )
                })
                .into_any_element()
        } else {
            let scroll = match (&self.lead, &self.lines) {
                (Some(lead), Some(lines)) => PageScroll {
                    lines: lines.clone(),
                    lead: lead.render.clone(),
                    floats: lead.count.saturating_sub(1),
                    list: self.list.clone(),
                    heights: self.lead_height.clone(),
                    width: self.lead_width.clone(),
                    revision: self.revision,
                    drawn: self.lines_drawn.clone(),
                    #[cfg(any(test, debug_assertions))]
                    resizes: self.lead_resizes.clone(),
                }
                .into_any_element(),
                _ => Self::render_list(
                    entity.clone(),
                    self.list.clone(),
                    None,
                    self.lead_height.clone(),
                )
                .into_any_element(),
            };
            div()
                .flex_1()
                .min_h_0()
                .relative()
                .child(scroll)
                .children(sticky.map(|label| {
                    div()
                        .absolute()
                        .top_0()
                        .left_0()
                        .right_0()
                        .h(px(26.))
                        .bg(sticky_bg)
                        .flex()
                        .justify_center()
                        .px(px(pad))
                        .child(
                            div()
                                .w_full()
                                .max_w(px(COLUMN_WIDTH))
                                .pt(px(6.))
                                .text_size(px(11.5))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(palette.faint)
                                .child(label),
                        )
                }))
                .when(self.is_live() && !following && !self.collapsed(), |el| {
                    el.child(
                        div()
                            .absolute()
                            .bottom(px(12.))
                            .left_0()
                            .right_0()
                            .flex()
                            .justify_center()
                            .child(
                                div()
                                    .id("jump-latest")
                                    .h(px(28.))
                                    .px(px(12.))
                                    .flex()
                                    .items_center()
                                    .gap(px(6.))
                                    .rounded_full()
                                    .bg(palette.capsule)
                                    .border_1()
                                    .border_color(palette.capsule_border)
                                    .shadow(palette.shadow())
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .cursor_pointer()
                                    .child(
                                        svg()
                                            .path("icons/arrow-down.svg")
                                            .size(px(12.))
                                            .text_color(palette.text),
                                    )
                                    .child(tr::documents::transcript::jump_to_latest())
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.jump_to_latest(cx)),
                                    ),
                            ),
                    )
                })
                .into_any_element()
        };
        div()
            .id("transcript-view")
            .key_context(TRANSCRIPT_CONTEXT)
            .track_focus(&self.focus)
            .on_action(
                cx.listener(|this, _: &FindInTranscript, window, cx| this.open_find(window, cx)),
            )
            .on_action(cx.listener(|this, _: &SelectionUp, _, cx| this.step(-1, false, cx)))
            .on_action(cx.listener(|this, _: &SelectionDown, _, cx| this.step(1, false, cx)))
            .on_action(cx.listener(|this, _: &ExtendSelectionUp, _, cx| this.step(-1, true, cx)))
            .on_action(cx.listener(|this, _: &ExtendSelectionDown, _, cx| this.step(1, true, cx)))
            .on_action(cx.listener(|this, _: &CopySelection, _, cx| this.copy_selection(cx)))
            .on_action(cx.listener(|this, _: &DeleteSelection, _, cx| this.delete_selection(cx)))
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .children(
                self.lead
                    .is_none()
                    .then(|| self.render_names_offer(cx))
                    .flatten(),
            )
            .child(body)
            .when(self.is_live() && following && !self.collapsed(), |el| {
                el.child(self.cue.clone())
            })
            .children(self.render_player(cx))
            .children(self.render_selection_bar(cx))
            .children(self.render_find(cx))
            .children(self.render_spell(cx))
            .children(self.render_rename(cx))
    }
}

const NAMES_OFFER_KEY: &str = "meetingsSpeakerNamesOfferDismissed";
#[cfg_attr(test, allow(dead_code))]
const COLLAPSED_SECTION: &str = "documentsWindow";
#[cfg_attr(test, allow(dead_code))]
const COLLAPSED_KEY: &str = "transcriptCollapsed";

#[cfg(test)]
thread_local! {
    // Tests share one store file per process; each keeps its own choice.
    static SAVED_COLLAPSED: Cell<bool> = const { Cell::new(false) };
}

fn saved_collapsed() -> bool {
    #[cfg(test)]
    {
        SAVED_COLLAPSED.get()
    }
    #[cfg(not(test))]
    {
        crate::store::store_section(COLLAPSED_SECTION)
            .get(COLLAPSED_KEY)
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false)
    }
}

fn save_collapsed(collapsed: bool) {
    #[cfg(test)]
    SAVED_COLLAPSED.set(collapsed);
    #[cfg(not(test))]
    crate::store::set_store_setting(
        COLLAPSED_SECTION,
        COLLAPSED_KEY,
        serde_json::json!(collapsed),
    );
}

#[cfg(test)]
pub(super) fn saved_collapsed_for_test() -> bool {
    saved_collapsed()
}

/// What the toast says after "That's not me" (or "That's me"), read once the
/// choice is saved, so it names the voice as it is now and never the one it
/// replaced.
pub(super) fn not_me_message(
    doc: String,
    id: u32,
    not_me: bool,
    cx: &mut App,
) -> Task<SharedString> {
    let saved = super::writer::run(|| ());
    cx.spawn(async move |cx| {
        saved.await;
        if !not_me {
            return tr::documents::toast::now_you().into();
        }
        let name = cx.update(|cx| {
            Meetings::try_global(cx).and_then(|meetings| {
                meetings.update(cx, |m, _| {
                    m.transcript(&doc).map(|t| {
                        export::word_speaker(&t.speaker(Source::System, None, Some(id)), None)
                    })
                })
            })
        });
        tr::documents::toast::moved_line(&name.unwrap_or_default()).into()
    })
}

impl TranscriptView {
    /// After a call in a meeting app, while voices are still "Person n" and
    /// Cap may not read the meeting app's window: one calm line offering to
    /// let it, so the next call's speakers get their names. Shown only here,
    /// never while starting or recording, and gone for good once dismissed.
    pub fn render_names_offer(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !cfg!(target_os = "macos")
            || !cap_meeting_platform::NAMES_FROM_MEETING_APPS
            || crate::permissions::grants_are_settings_only()
            || self.is_live()
            || self.names_offer_hidden
        {
            return None;
        }
        let from_app = self
            .meta
            .as_ref()
            .and_then(|m| m.meeting.as_ref())
            .is_some_and(|m| m.app_id.is_some());
        let numbered = self.rows.iter().any(|row| {
            matches!(row, TRow::Turn(t) if t.speaker.is_none() && t.speaker_id.is_some()
                && t.label.chars().last().is_some_and(|c| c.is_ascii_digit()))
        });
        if !from_app || !numbered || cap_meeting_platform::accessibility_trusted() {
            return None;
        }
        let palette = self.palette;
        let pad = column_padding(self.width);
        Some(
            div()
                .px(px(pad))
                .pt(px(10.))
                .flex()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(COLUMN_WIDTH))
                        .min_h(px(32.))
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(13.))
                        .text_color(palette.muted)
                        .child(
                            div()
                                .flex_1()
                                .min_w(px(200.))
                                .child(tr::documents::transcript::names_offer()),
                        )
                        .child(
                            style::quiet_pill(&palette, "names-offer-allow")
                                .h(px(26.))
                                .child(tr::documents::transcript::names_offer_allow())
                                .on_click(cx.listener(|this, _, _, cx| {
                                    crate::meetings_ui::settings::shared::request_accessibility();
                                    this.names_offer_hidden = true;
                                    this.changed(cx);
                                })),
                        )
                        .child(
                            div()
                                .id("names-offer-dismiss")
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
                                        .size(px(11.))
                                        .text_color(palette.faint),
                                )
                                .on_click(cx.listener(|this, _, _, cx| {
                                    crate::store::set_store_setting(
                                        "meetings",
                                        NAMES_OFFER_KEY,
                                        serde_json::json!(true),
                                    );
                                    this.names_offer_hidden = true;
                                    this.changed(cx);
                                })),
                        ),
                )
                .into_any_element(),
        )
    }
}

#[cfg(debug_assertions)]
impl TranscriptView {
    pub fn debug_loaded(&self) -> bool {
        self.loaded
    }

    pub fn debug_set_live(&mut self, cx: &mut Context<Self>) {
        self.debug_live = true;
        self.shown_at = std::time::Instant::now();
        self.changed(cx);
    }

    pub fn debug_follow(&mut self, cx: &mut Context<Self>) {
        self.jump_to_latest(cx);
    }

    pub fn debug_find(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.open_find(window, cx);
        if let Some(find) = self.find.as_ref() {
            let input = find.input.clone();
            let query = query.to_string();
            input.update(cx, |i, cx| i.set_text(query, cx));
        }
        self.refresh_find(cx);
    }

    pub fn debug_select(&mut self, cx: &mut Context<Self>) {
        let turns: Vec<usize> = self
            .rows
            .iter()
            .enumerate()
            .filter(|(_, r)| matches!(r, TRow::Turn(_)))
            .map(|(i, _)| i)
            .skip(1)
            .take(3)
            .collect();
        if let (Some(a), Some(b)) = (turns.first(), turns.last()) {
            self.selection = Some((*a, *b));
            self.changed(cx);
        }
    }
}
