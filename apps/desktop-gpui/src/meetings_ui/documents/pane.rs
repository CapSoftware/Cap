use std::{
    cell::Cell,
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    rc::Rc,
    time::{Duration, Instant},
};

use cap_meetings::{
    library::{DocKind, DocMeta},
    settings::{Language, Microphone},
    templates::{self, Template},
};
use cap_notes::{Document, Origin};
use cap_notes_ui::{NotesEditor, NotesEvent, NotesLabels, RevealHost, SlashItem, SourceMark};
use chrono::Local;
use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, Context, Div, Entity,
    Focusable, FontWeight, InteractiveElement, IntoElement, MouseButton, ParentElement, Pixels,
    Point, Render, SharedString, StatefulInteractiveElement, StyleRefinement, Styled, Subscription,
    Task, WeakEntity, Window, div, ease_out_quint, point, prelude::FluentBuilder, px, svg,
};

use super::{
    ask::{self as ask_panel, AnswerLinks, AskEvent, AskPanel, LiveLine},
    bar::{BarEvent, RecordingBar},
    cap_ai::{self as ai_note, CardKind, NoteState, Placeholder},
    commands, export, format,
    menu::{self, Entry, OpenMenu},
    store::{self, DocStore, StoreEvent},
    style::{self, COLUMN_WIDTH, DOCK_WIDTH, Palette, TOOLBAR_HEIGHT, column_padding},
    transcript::{LeadRender, TranscriptView},
    when,
    window::DocumentsWindow,
    writer,
};
use crate::{
    i18n::tr,
    meetings::{
        AiAccess, GenerateOptions, MeetingError, MeetingEvent, Meetings, NotesError, NotesStage,
        StartSource,
    },
    meetings_ui::cap_ai::{self, CapAi, CapAiEvent, Host, pitch::Pitch},
    theme::{Appearance, Theme},
    ui::{TextInput, TextInputEvent, TextInputState},
};

const SAVE_DEBOUNCE: Duration = Duration::from_millis(800);
const SAVE_MAX_WAIT: Duration = Duration::from_secs(3);
const TITLE_DEBOUNCE: Duration = Duration::from_millis(600);
const CONSENT_FOR: Duration = Duration::from_secs(8);
const SIDEBAR_SPAN: f32 = style::SIDEBAR_WIDTH + 1.;
/// The Ask sheet beside the page, and the page width below which the sheet
/// covers the page instead of sharing the window with it.
const SHEET_WIDTH: f32 = 384.;
const SHEET_GAP: f32 = 12.;
const SHEET_SIDE_BY_SIDE: f32 = 620.;
const SHEET_IN: Duration = Duration::from_millis(200);
const SHEET_OUT: Duration = Duration::from_millis(140);
const CAPTION_IN: Duration = Duration::from_millis(220);
const RELINK_AFTER: Duration = Duration::from_millis(700);
/// Items the page puts ahead of the transcript lines: the header, the note
/// and the transcript's heading.
const PAGE_LEAD: usize = 3;
const TYPED_RECENTLY: Duration = Duration::from_secs(20);
/// Room under inline content so its last line clears the bottom dock.
const DOCK_CLEARANCE: f32 = 78.;
/// The dock's geometry: its gap to the window's bottom, its bar, the gap
/// between its rows, and a stacked line (the trial line).
const DOCK_BOTTOM: f32 = 16.;
const DOCK_BAR: f32 = 46.;
const DOCK_GAP: f32 = 8.;
const DOCK_LINE: f32 = 30.;
/// Longest the page waits for notes that should be starting after Stop.
const AWAIT_NOTES_FOR: Duration = Duration::from_secs(8);
const QUIET_RETRY_AFTER: Duration = Duration::from_secs(3);

fn in_column(width: f32, child: AnyElement) -> AnyElement {
    div()
        .w_full()
        .flex()
        .justify_center()
        .px(px(column_padding(width)))
        .flex_shrink_0()
        .child(div().w_full().max_w(px(COLUMN_WIDTH)).child(child))
        .into_any_element()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View {
    Mine,
    Generated,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Notes,
    Enhanced,
}

#[derive(Default)]
struct SaveState {
    doc_id: Option<String>,
    dirty_since: Option<Instant>,
    task: Option<Task<()>>,
    suppress: u32,
    /// Counts the user's edits, so a load that started before one never
    /// replaces it.
    edits: u64,
    /// The open note's saved payload has loaded (or there was none). Until
    /// then the editor is read-only and nothing is written, so a page that
    /// has not loaded can never be saved over the file.
    loaded: bool,
}

#[derive(Clone, Debug, PartialEq)]
enum PaneAction {
    CopyNotes,
    CopyTranscript,
    Export,
    Reveal,
    OpenInEditor,
    DownloadAudio,
    Trash,
    Restore,
    DeleteForever,
    Folder(Option<String>),
    Template(String),
    Regenerate,
    RegenerateWith(String),
    Microphone(Option<String>),
    Language(String),
}

enum Popover {
    /// When it happened: the day, start and end, and the calendar event.
    Event(Point<Pixels>),
    Participants(Point<Pixels>),
    Regenerate(Point<Pixels>),
}

/// The open "when" popover: the month shown and the time fields.
struct WhenEdit {
    month: chrono::NaiveDate,
    start: Entity<TextInputState>,
    end: Option<Entity<TextInputState>>,
    _subscriptions: Vec<gpui::Subscription>,
}

pub fn notes_error_text(error: &NotesError) -> String {
    match error {
        NotesError::NotSignedIn => tr::documents::notes::error_sign_in().into(),
        NotesError::UpgradeRequired => tr::documents::notes::error_upgrade().into(),
        NotesError::RateLimited { retry_after_secs } => {
            if *retry_after_secs < 90 {
                tr::documents::notes::error_rate_limited_soon().into()
            } else {
                tr::documents::notes::error_rate_limited_minutes(
                    retry_after_secs.div_ceil(60) as usize
                )
            }
        }
        NotesError::NotConfigured => tr::documents::notes::error_not_configured().into(),
        NotesError::Offline(_) => tr::documents::notes::error_offline().into(),
        NotesError::Interrupted(_) => tr::documents::notes::error_interrupted().into(),
        NotesError::NothingToSummarize => tr::documents::notes::error_nothing().into(),
        NotesError::NotFound => tr::documents::notes::error_not_found().into(),
        NotesError::Busy => tr::documents::notes::error_busy().into(),
        NotesError::Failed(_) => tr::documents::notes::error_failed().into(),
    }
}

pub fn notes_error_action(error: &NotesError, palette: &Palette) -> Option<AnyElement> {
    let (label, upgrade) = match error {
        NotesError::NotSignedIn => (tr::documents::notes::sign_in(), false),
        NotesError::UpgradeRequired => (tr::documents::notes::upgrade(), true),
        _ => return None,
    };
    let palette = *palette;
    Some(
        div()
            .id(if upgrade {
                "notes-upgrade"
            } else {
                "notes-sign-in"
            })
            .role(gpui::Role::Button)
            .when(palette.keyboard, crate::ui::keyboard_nav::stop)
            .aria_label(label)
            .h(px(26.))
            .px(px(11.))
            .flex()
            .items_center()
            .rounded_full()
            .bg(palette.text)
            .text_color(palette.on_ink)
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .child(label)
            .on_click(move |_, _, cx| {
                if upgrade {
                    cx.open_url(crate::auth::PRICING_URL);
                } else {
                    let sign_in = crate::sign_in::SignIn::global(cx);
                    sign_in.update(cx, |sign_in, cx| {
                        sign_in.start(crate::sign_in::SignInOrigin::Settings, cx)
                    });
                }
            })
            .into_any_element(),
    )
}

pub fn labels(placeholder: &'static str) -> NotesLabels {
    NotesLabels {
        editor: tr::documents::editor::editor().into(),
        placeholder: placeholder.into(),
        heading_placeholder: tr::documents::editor::heading().into(),
        slash_text: tr::documents::editor::plain_text().into(),
        slash_heading_1: tr::documents::editor::heading_1().into(),
        slash_heading_2: tr::documents::editor::heading_2().into(),
        slash_heading_3: tr::documents::editor::heading_3().into(),
        slash_bullet_list: tr::documents::editor::bullet_list().into(),
        slash_numbered_list: tr::documents::editor::numbered_list().into(),
        slash_checkbox: tr::documents::editor::checkbox().into(),
        slash_quote: tr::documents::editor::quote().into(),
        slash_code_block: tr::documents::editor::code_block().into(),
        slash_divider: tr::documents::editor::divider().into(),
        bold: tr::documents::editor::bold().into(),
        italic: tr::documents::editor::italic().into(),
        underline: tr::documents::editor::underline().into(),
        strikethrough: tr::documents::editor::strikethrough().into(),
        code: tr::documents::editor::code().into(),
        highlight: tr::documents::editor::highlight().into(),
        link: tr::documents::editor::link().into(),
        link_placeholder: tr::documents::editor::link_placeholder().into(),
        cut: tr::documents::editor::cut().into(),
        copy: tr::documents::editor::copy().into(),
        paste: tr::documents::editor::paste().into(),
        select_all: tr::documents::editor::select_all().into(),
        open_link: tr::documents::editor::open_link().into(),
        copy_link: tr::documents::editor::copy_link().into(),
        remove_link: tr::documents::editor::remove_link().into(),
        find_placeholder: tr::documents::editor::find().into(),
        find_no_results: tr::documents::editor::no_results().into(),
        find_previous: tr::documents::editor::previous().into(),
        find_next: tr::documents::editor::next().into(),
        find_close: tr::documents::editor::close().into(),
    }
}

fn input_theme(palette: &Palette) -> Theme {
    Theme::new(if palette.dark {
        Appearance::Dark
    } else {
        Appearance::Light
    })
}

pub struct Pane {
    store: Entity<DocStore>,
    root: WeakEntity<DocumentsWindow>,
    theme: Theme,
    palette: Palette,
    leading_inset: bool,
    pub doc: Option<DocMeta>,
    pub view: View,
    pub panel_open: bool,
    load: Option<Task<()>>,
    pub switch_started: Option<Instant>,
    pub last_switch_ms: Option<f64>,
    auto_title: Option<String>,
    pub(super) title: Entity<TextInputState>,
    /// Done arrived while streamed words were still being shown.
    settle_after_drain: bool,
    title_task: Option<Task<()>>,
    /// The person typed in the title since it was last set or saved; only
    /// then does leaving the field save it.
    title_dirty: bool,
    pub notes: Entity<NotesEditor>,
    notes_save: SaveState,
    pub enhanced: Entity<NotesEditor>,
    enhanced_save: SaveState,
    enhanced_loaded: bool,
    pub(super) enhanced_edited: bool,
    streaming: bool,
    stream_offset: usize,
    /// The summary editor is showing the writing state.
    writing_shown: bool,
    /// Counts titles Cap wrote into this window, so each one fades in once.
    title_landed: u64,
    /// Summary changes that were speaker renames, not the person's edits.
    rename_echo: u32,
    /// Notes are about to be written for the meeting that just stopped:
    /// the page shows the writing state before the request even starts.
    /// The task clears it if nothing starts.
    awaiting: Option<Task<()>>,
    /// Failed notes are retried once, quietly, before saying so.
    auto_retried: bool,
    stopped: Option<String>,
    generation: Option<Task<Result<(), NotesError>>>,
    gen_error: Option<NotesError>,
    notes_focused: bool,
    pub transcript: Entity<TranscriptView>,
    bar: Entity<RecordingBar>,
    ask: Entity<AskPanel>,
    menu: Option<OpenMenu<PaneAction>>,
    popover: Option<Popover>,
    when_edit: Option<WhenEdit>,
    participant_input: Entity<TextInputState>,
    instruction_input: Entity<TextInputState>,
    mention: Option<String>,
    templates: Vec<Template>,
    loaded_id: Option<String>,
    focus_body_on_load: bool,
    consent: Option<Task<()>>,
    microphones: Vec<String>,
    mic_task: Option<Task<()>>,
    writing_at: Instant,
    access: AiAccess,
    trial_remaining: Option<u32>,
    /// Ask's answer is open over the dock bar: the dock's stacked line steps
    /// aside so it never rides up over the page.
    ask_open: bool,
    typed_at: Option<Instant>,
    write_after_sign_in: bool,
    too_short: bool,
    notes_placeholder: &'static str,
    /// The note and its transcript in one scroll (a finished meeting).
    page_mode: bool,
    /// Where each sourced point of the summary came from, by mark key.
    links: Rc<Vec<Vec<String>>>,
    links_key: u64,
    links_task: Option<Task<()>>,
    relink_task: Option<Task<()>>,
    answer_tasks: Vec<Task<()>>,
    /// Ask in a side sheet, and the moment it opened or began closing.
    ask_sheet: bool,
    sheet_moved: Option<Instant>,
    sheet_serial: u64,
    sheet_task: Option<Task<()>>,
    /// The page's width at the last render, for the items the transcript
    /// list draws for it.
    page_width: f32,
    /// The dock's banner height as last drawn (it wraps), so the page keeps
    /// room for it.
    banner_height: Rc<Cell<f32>>,
    /// The page's header as its own view, so a key typed in the summary
    /// below does not rebuild it (made when the page first shows).
    header_view: Option<Entity<HeaderView>>,
    #[cfg(debug_assertions)]
    debug_stream_text: String,
    _subscriptions: Vec<Subscription>,
}

/// Where a note keeps the first line of its summary, for home.
pub const PREVIEW_KEY: &str = "summaryPreview";
const PREVIEW_CHARS: usize = 180;

/// The first sentence-like line of a summary: its first paragraph, or its
/// first point when it has no paragraph; cut on a word near 180 characters.
pub(crate) fn summary_preview(doc: &Document) -> Option<String> {
    let generated = || {
        doc.blocks
            .iter()
            .filter(|b| b.origin == Origin::Generated && !b.text.trim().is_empty())
    };
    let block = generated()
        .find(|b| b.kind == cap_notes::BlockKind::Paragraph)
        .or_else(|| generated().find(|b| !matches!(b.kind, cap_notes::BlockKind::Heading(_))))?;
    let text = block.text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= PREVIEW_CHARS {
        return Some(text);
    }
    let cut: String = text.chars().take(PREVIEW_CHARS).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    Some(format!(
        "{}\u{2026}",
        cut.trim_end_matches([',', ';', ':', '.'])
    ))
}

/// A summary point linked to the lines it came from.
pub(super) struct PointLink {
    pub(super) block: usize,
    pub(super) text_len: usize,
    pub(super) start_ms: u64,
    pub(super) ids: Vec<String>,
}

/// Link each point of the summary to its transcript lines. Off the main
/// thread; pure.
pub(super) fn link_points(
    points: Vec<(usize, usize, String)>,
    turns: Vec<(String, String, u64, String)>,
) -> Vec<PointLink> {
    use cap_meetings::sources::{SourceTurn, Tuning, link};
    let source: Vec<SourceTurn<'_>> = turns
        .iter()
        .map(|(text, label, _, _)| SourceTurn {
            text,
            speaker: label,
        })
        .collect();
    let texts: Vec<&str> = points.iter().map(|(_, _, t)| t.as_str()).collect();
    link(&texts, &source, Tuning::default())
        .into_iter()
        .zip(points)
        .filter_map(|(found, (block, text_len, _))| {
            let found = found?;
            let ids = (found.turn..found.turn + found.span)
                .filter_map(|t| turns.get(t).map(|turn| turn.3.clone()))
                .collect();
            Some(PointLink {
                block,
                text_len,
                start_ms: turns[found.turn].2,
                ids,
            })
        })
        .collect()
}

impl Pane {
    pub fn new(
        store: Entity<DocStore>,
        root: WeakEntity<DocumentsWindow>,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let palette = Palette::new(theme);
        let notes_theme = style::notes_theme(theme);
        let notes = cx.new(|cx| {
            NotesEditor::new(
                Document::new(),
                notes_theme.clone(),
                labels(tr::documents::editor::placeholder()),
                window,
                cx,
            )
        });
        let enhanced = cx.new(|cx| {
            NotesEditor::new(
                Document::new(),
                notes_theme.clone(),
                labels(tr::documents::editor::generated_placeholder()),
                window,
                cx,
            )
        });
        let title = cx.new(|cx| TextInputState::single_line(window, cx));
        let participant_input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::header::add_email());
            input
        });
        let instruction_input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::notes::instruction_placeholder());
            input
        });
        let transcript = cx.new(|cx| TranscriptView::new(root.clone(), palette, cx));
        let bar = cx.new(|cx| RecordingBar::new(palette, cx));
        let ask = cx.new(|cx| AskPanel::new(palette, window, cx));
        let mut subscriptions = vec![
            cx.subscribe_in(&store, window, Self::on_store_event),
            cx.subscribe_in(&notes, window, |this, _, event: &NotesEvent, window, cx| {
                this.on_notes_event(Which::Notes, event, window, cx)
            }),
            cx.subscribe_in(
                &enhanced,
                window,
                |this, _, event: &NotesEvent, window, cx| {
                    this.on_notes_event(Which::Enhanced, event, window, cx)
                },
            ),
            cx.subscribe_in(&title, window, Self::on_title_event),
            // The summary shows everyone the transcript names as pills.
            cx.observe(&transcript, |this, transcript, cx| {
                let people = transcript.read(cx).people();
                this.enhanced.update(cx, |e, cx| e.set_people(people, cx));
                if this.page_mode {
                    this.sync_links(cx);
                }
            }),
            cx.subscribe_in(
                &participant_input,
                window,
                |this, input, event: &TextInputEvent, _, cx| {
                    if *event == TextInputEvent::Confirmed {
                        let email = input.read(cx).text().trim().to_string();
                        this.add_participant(email, cx);
                        input.update(cx, |input, cx| input.set_text("", cx));
                    }
                },
            ),
            cx.subscribe_in(
                &instruction_input,
                window,
                |this, input, event: &TextInputEvent, _, cx| {
                    if *event == TextInputEvent::Confirmed {
                        let text = input.read(cx).text().trim().to_string();
                        if !text.is_empty() {
                            input.update(cx, |input, cx| input.set_text("", cx));
                            this.popover = None;
                            this.write_notes(
                                Some(GenerateOptions {
                                    template_id: None,
                                    instruction: Some(text),
                                }),
                                cx,
                            );
                        }
                    }
                },
            ),
            cx.subscribe(&bar, |this, _, event: &BarEvent, cx| match event {
                BarEvent::Start(event_id) => {
                    if let Some(id) = this.doc.as_ref().map(|d| d.id.clone()) {
                        this.start_recording(
                            StartSource::Into {
                                doc_id: id,
                                event_id: event_id.clone(),
                            },
                            cx,
                        );
                    }
                }
                BarEvent::TogglePanel => this.set_panel(!this.panel_open, cx),
                BarEvent::StopWriting => this.stop_generation(cx),
                BarEvent::ShowDoc(id) => {
                    let id = id.clone();
                    this.store.update(cx, |store, cx| store.open(Some(id), cx));
                }
            }),
            cx.observe(&ask, |this, ask, cx| {
                let open = ask.read(cx).is_open();
                if open != this.ask_open {
                    this.ask_open = open;
                    cx.notify();
                }
            }),
            cx.subscribe(&ask, |this, _, event: &AskEvent, cx| match event {
                AskEvent::WriteNotes => this.write_notes(None, cx),
                AskEvent::Upgrade(question) => {
                    let doc = this.doc_id();
                    if let (Some(doc), Some(cap_ai)) = (doc.clone(), CapAi::global(cx)) {
                        let question = question.clone();
                        cap_ai.update(cx, |c, _| c.remember_question(doc, question));
                    }
                    cx.defer(move |cx| cap_ai::open_upgrade(doc, Host::Documents, cx));
                }
                AskEvent::SignIn => cx.defer(cap_ai::sign_in),
                AskEvent::Error(_) => {}
                AskEvent::Answered(index) => this.link_answer(*index, cx),
                // Mid-call, a question opens the sheet so its answer has room
                // beside the page.
                AskEvent::Asked => {
                    if this.bar.read(cx).recording(cx) {
                        this.set_ask_sheet(true, cx);
                    }
                }
                AskEvent::Reveal(ids) => this.reveal_lines(ids.clone(), cx),
                AskEvent::CloseSheet => this.set_ask_sheet(false, cx),
                AskEvent::Room => cx.notify(),
            }),
        ];
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(cx.subscribe_in(&meetings, window, Self::on_meeting_event));
            subscriptions.push(cx.observe(&meetings, |this, _, cx| {
                if this.refresh_access(cx) {
                    this.sync_bar(cx);
                    cx.notify();
                }
            }));
        }
        if let Some(cap_ai) = CapAi::global(cx) {
            subscriptions.push(cx.subscribe(&cap_ai, Self::on_cap_ai_event));
        }
        let mut this = Self {
            store,
            root,
            theme: *theme,
            palette,
            leading_inset: false,
            doc: None,
            view: View::Mine,
            panel_open: false,
            load: None,
            switch_started: None,
            last_switch_ms: None,
            auto_title: None,
            title,
            title_task: None,
            title_dirty: false,
            settle_after_drain: false,
            notes,
            notes_save: SaveState::default(),
            enhanced,
            enhanced_save: SaveState::default(),
            enhanced_loaded: false,
            enhanced_edited: false,
            streaming: false,
            stream_offset: 0,
            writing_shown: false,
            title_landed: 0,
            rename_echo: 0,
            awaiting: None,
            auto_retried: false,
            stopped: None,
            generation: None,
            gen_error: None,
            notes_focused: false,
            transcript,
            bar,
            ask,
            menu: None,
            popover: None,
            participant_input,
            when_edit: None,
            instruction_input,
            mention: None,
            templates: Vec::new(),
            loaded_id: None,
            focus_body_on_load: false,
            consent: None,
            microphones: Vec::new(),
            mic_task: None,
            writing_at: Instant::now(),
            access: AiAccess::Unavailable,
            trial_remaining: None,
            ask_open: false,
            typed_at: None,
            write_after_sign_in: false,
            too_short: false,
            notes_placeholder: tr::documents::editor::placeholder(),
            page_mode: false,
            links: Rc::new(Vec::new()),
            links_key: 0,
            links_task: None,
            relink_task: None,
            answer_tasks: Vec::new(),
            ask_sheet: false,
            sheet_moved: None,
            sheet_serial: 0,
            sheet_task: None,
            page_width: 800.,
            banner_height: Rc::new(Cell::new(0.)),
            header_view: None,
            #[cfg(debug_assertions)]
            debug_stream_text: String::new(),
            _subscriptions: subscriptions,
        };
        this.load_templates(cx);
        this.refresh_access(cx);
        this
    }

    fn load_templates(&mut self, cx: &mut Context<Self>) {
        self.templates = Meetings::try_global(cx)
            .map(|m| m.read(cx).templates())
            .unwrap_or_else(|| templates::all_templates(&[]));
        let items: Vec<SlashItem> = templates::templates_for(&self.templates, &DocKind::Meeting)
            .into_iter()
            .map(|t| {
                SlashItem::new(
                    format!("template:{}", t.id),
                    tr::documents::editor::template_item(format::template_name(&t)),
                )
            })
            .collect();
        self.notes
            .update(cx, |editor, _| editor.extra_slash_items(items));
    }

    pub fn set_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        self.theme = *theme;
        self.palette = Palette::new(theme);
        let notes_theme = style::notes_theme(theme);
        let palette = self.palette;
        self.notes
            .update(cx, |e, cx| e.set_theme(notes_theme.clone(), cx));
        self.enhanced
            .update(cx, |e, cx| e.set_theme(notes_theme.clone(), cx));
        self.transcript
            .update(cx, |t, cx| t.set_palette(palette, cx));
        self.bar.update(cx, |b, cx| b.set_palette(palette, cx));
        self.ask.update(cx, |a, cx| a.set_palette(palette, cx));
        cx.notify();
    }

    pub fn set_leading_inset(&mut self, inset: bool, cx: &mut Context<Self>) {
        if self.leading_inset != inset {
            self.leading_inset = inset;
            cx.notify();
        }
    }

    fn toast(&self, message: impl Into<SharedString>, cx: &mut Context<Self>) {
        let message = message.into();
        self.root
            .update(cx, |root, cx| root.show_toast(message, None, None, cx))
            .ok();
    }

    fn doc_id(&self) -> Option<String> {
        self.doc.as_ref().map(|d| d.id.clone())
    }

    fn is_meeting(&self) -> bool {
        self.doc
            .as_ref()
            .is_some_and(|d| d.kind == DocKind::Meeting)
    }

    fn is_trashed(&self) -> bool {
        self.doc.as_ref().is_some_and(DocMeta::is_trashed)
    }

    fn library(&self, cx: &App) -> Option<cap_meetings::library::Library> {
        self.store.read(cx).library().cloned()
    }

    fn on_store_event(
        &mut self,
        _: &Entity<DocStore>,
        event: &StoreEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            StoreEvent::Opened(id) => self.open(id.clone(), window, cx),
            StoreEvent::MetaChanged(id) if Some(id) == self.doc_id().as_ref() => {
                self.refresh_meta(window, cx)
            }
            StoreEvent::Listed => {
                if self.doc.is_some() {
                    self.refresh_meta(window, cx);
                } else {
                    cx.notify();
                }
            }
            _ => {}
        }
    }

    fn refresh_meta(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        let Some(mut meta) = self.store.read(cx).get(&id).cloned() else {
            return;
        };
        let had_enhanced = self
            .doc
            .as_ref()
            .and_then(|d| d.meeting.as_ref())
            .is_some_and(|m| m.has_enhanced);
        // A listing read before the summary was saved must not take the
        // notes away again (see `notes_landed`).
        if had_enhanced && let Some(meeting) = meta.meeting.as_mut() {
            meeting.has_enhanced = true;
        }
        let has_enhanced_now = meta.meeting.as_ref().is_some_and(|m| m.has_enhanced);
        self.sync_title(&meta, false, window, cx);
        let trashed_changed = self.doc.as_ref().map(DocMeta::is_trashed) != Some(meta.is_trashed());
        self.doc = Some(meta.clone());
        self.transcript
            .update(cx, |t, cx| t.update_meta(meta.clone(), cx));
        if trashed_changed {
            let read_only = meta.is_trashed();
            let (notes_ro, enhanced_ro) = (
                read_only || !self.notes_save.loaded,
                read_only || !self.enhanced_save.loaded,
            );
            self.notes.update(cx, |e, cx| e.set_read_only(notes_ro, cx));
            self.enhanced
                .update(cx, |e, cx| e.set_read_only(enhanced_ro, cx));
        }
        if has_enhanced_now && !had_enhanced && !self.streaming {
            self.settle_enhanced(cx);
        }
        self.sync_bar(cx);
        cx.notify();
    }

    fn sync_title(
        &mut self,
        meta: &DocMeta,
        force: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = !force && self.title.read(cx).is_focused(window);
        if meta.title_is_auto {
            self.auto_title = Some(meta.title.clone()).filter(|t| !t.trim().is_empty());
        }
        // The title Cap chose is the field's text, not a placeholder, so a
        // click puts the caret in it and typing edits it instead of
        // starting over from an empty field.
        if !focused {
            self.title_dirty = false;
            let text = meta.title.clone();
            self.title.update(cx, |title, cx| {
                title.set_placeholder(tr::documents::untitled());
                title.set_text(text, cx);
            });
        }
    }

    fn open(&mut self, id: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.switch_started = Some(Instant::now());
        self.loaded_id = None;
        self.flush_saves(cx);
        self.commit_title(cx);
        if self.doc.as_ref().map(|d| &d.id) != id.as_ref() {
            self.tidy_left_note(cx);
        }
        self.menu = None;
        self.popover = None;
        self.mention = None;
        self.generation = None;
        self.gen_error = None;
        self.streaming = false;
        self.settle_after_drain = false;
        self.stream_offset = 0;
        self.awaiting = None;
        self.auto_retried = false;
        self.stopped = None;
        self.enhanced_loaded = false;
        self.enhanced_edited = false;
        self.panel_open = false;
        let meta = id.and_then(|id| self.store.read(cx).get(&id).cloned());
        self.doc = meta.clone();
        let Some(meta) = meta else {
            self.transcript.update(cx, |t, cx| t.set_doc(None, cx));
            self.bar.update(cx, |b, cx| b.set_doc(None, false, cx));
            self.ask.update(cx, |a, cx| a.set_doc(None, cx));
            cx.notify();
            return;
        };
        let id = meta.id.clone();
        let meeting = meta.kind == DocKind::Meeting;
        self.notes_save.doc_id = Some(id.clone());
        self.enhanced_save.doc_id = Some(id.clone());
        self.sync_title(&meta, true, window, cx);
        let read_only = meta.is_trashed();
        // Both editors wait, read-only, for the saved text (a few ms).
        self.notes_save.loaded = false;
        self.enhanced_save.loaded = false;
        self.notes_save.suppress += 1;
        self.notes.update(cx, |e, cx| {
            e.set_document(Document::new(), cx);
            e.set_read_only(true, cx);
            e.set_placeholder(tr::documents::editor::placeholder(), cx);
        });
        self.notes_placeholder = tr::documents::editor::placeholder();
        self.enhanced_save.suppress += 1;
        self.enhanced.update(cx, |e, cx| {
            e.set_document(Document::new(), cx);
            e.set_read_only(true, cx);
        });
        let recording = Meetings::try_global(cx)
            .and_then(|m| m.read(cx).active().map(|a| a.doc_id == id))
            .unwrap_or(false);
        let has_enhanced = meta.meeting.as_ref().is_some_and(|m| m.has_enhanced);
        let notes_state =
            Meetings::try_global(cx).and_then(|m| m.read(cx).notes_state(&id).cloned());
        self.too_short = false;
        self.refresh_access(cx);
        let has_transcript = meta
            .meeting
            .as_ref()
            .is_some_and(|m| m.transcript_chars > 0);
        let running = notes_state.as_ref().is_some_and(|s| s.running);
        let captured = ai_note::shows_transcript(NoteState {
            meeting,
            trashed: meta.is_trashed(),
            recording,
            has_transcript,
            has_notes: has_enhanced,
            generating: running,
            ..NoteState::default()
        });
        // Their own notes come first once they load (see below); until then
        // an ended meeting opens on what Cap made of it.
        self.view = if !meeting || recording {
            View::Mine
        } else if has_enhanced || running || captured {
            View::Generated
        } else {
            View::Mine
        };
        if meeting {
            cx.defer(cap_ai::ensure_access);
        }
        self.transcript
            .update(cx, |t, cx| t.set_doc(Some(meta.clone()), cx));
        let linked = meta.meeting.as_ref().is_some_and(|m| m.event.is_some());
        self.bar.update(cx, |b, cx| {
            b.linked = linked;
            b.embedded = meeting && ai_note::ask_visible(self.access);
            b.set_doc(Some(id.clone()), meeting, cx)
        });
        self.ask.update(cx, |a, cx| a.set_doc(Some(id.clone()), cx));
        if let Some(state) = notes_state {
            if state.running {
                self.streaming = true;
                self.enhanced_loaded = true;
                self.append_stream(&state.markdown, cx);
            } else {
                self.gen_error = state.error;
            }
        }
        let Some(library) = self.library(cx) else {
            // Nothing on disk to protect.
            self.notes_save.loaded = true;
            self.enhanced_save.loaded = true;
            self.notes.update(cx, |e, cx| e.set_read_only(read_only, cx));
            self.enhanced.update(cx, |e, cx| e.set_read_only(read_only, cx));
            return;
        };
        let want_enhanced = has_enhanced && !self.streaming;
        if !want_enhanced {
            // No saved summary to read: Cap is writing it (the stream is the
            // page) or there is none yet.
            self.enhanced_save.loaded = true;
            self.enhanced.update(cx, |e, cx| e.set_read_only(read_only, cx));
        }
        let started = self.switch_started;
        // The saves just flushed may be this note's own edits (left and
        // opened again): read it back only once they have landed.
        let saved = writer::run(|| ());
        self.load = Some(cx.spawn(async move |this, cx| {
            saved.await;
            let doc_id = id.clone();
            let (notes, enhanced) = cx
                .background_executor()
                .spawn(async move {
                    let (notes, enhanced) = store::read_payloads(&library, &doc_id, want_enhanced);
                    (parse_payload(notes), parse_payload(enhanced))
                })
                .await;
            this.update(cx, |this, cx| {
                if this.doc_id().as_deref() != Some(id.as_str()) {
                    return;
                }
                let trashed = this.is_trashed();
                match notes {
                    Ok(document) => {
                        if let Some(document) = document {
                            this.notes_save.suppress += 1;
                            this.notes.update(cx, |e, cx| e.set_document(document, cx));
                        }
                        this.notes_save.loaded = true;
                        this.notes.update(cx, |e, cx| e.set_read_only(trashed, cx));
                    }
                    Err(error) => {
                        tracing::warn!(%error, "could not load the notes; kept read-only");
                        this.notes.update(cx, |e, cx| {
                            e.set_placeholder(tr::documents::editor::load_failed(), cx)
                        });
                    }
                }
                if want_enhanced {
                    match enhanced {
                        Ok(document) => {
                            if let Some(document) = document {
                                this.set_enhanced(document, cx);
                            }
                            this.enhanced_save.loaded = true;
                            this.enhanced.update(cx, |e, cx| e.set_read_only(trashed, cx));
                        }
                        Err(error) => {
                            tracing::warn!(%error, "could not load the summary; kept read-only");
                            this.enhanced.update(cx, |e, cx| {
                                e.set_placeholder(tr::documents::editor::load_failed(), cx)
                            });
                        }
                    }
                }
                if this.view == View::Generated
                    && !this.has_enhanced()
                    && !this.streaming
                    && this.notes_typed(cx)
                {
                    this.view = View::Mine;
                }
                this.loaded_id = Some(id.clone());
                if let Some(started) = started {
                    let ms = started.elapsed().as_secs_f64() * 1000.;
                    this.last_switch_ms = Some(ms);
                    tracing::info!(ms, "documents switch loaded");
                }
                this.sync_bar(cx);
                cx.notify();
            })
            .ok();
        }));
        if std::mem::take(&mut self.focus_body_on_load) {
            self.focus_body(window, cx);
        }
        self.sync_bar(cx);
        cx.notify();
    }

    fn set_enhanced(&mut self, document: Document, cx: &mut Context<Self>) {
        self.enhanced_edited = document
            .blocks
            .iter()
            .any(|b| b.origin == Origin::Author && !b.text.trim().is_empty());
        self.enhanced_save.suppress += 1;
        self.enhanced
            .update(cx, |e, cx| e.set_document(document, cx));
        self.enhanced_loaded = true;
    }

    fn load_enhanced(&mut self, cx: &mut Context<Self>) {
        let (Some(id), Some(library)) = (self.doc_id(), self.library(cx)) else {
            return;
        };
        // Read-only and never saved until the saved summary is back.
        self.enhanced_save.loaded = false;
        self.enhanced.update(cx, |e, cx| e.set_read_only(true, cx));
        self.load = Some(cx.spawn(async move |this, cx| {
            let doc_id = id.clone();
            let document = cx
                .background_executor()
                .spawn(async move {
                    parse_payload(library.read_enhanced(&doc_id).map_err(|e| e.to_string()))
                })
                .await;
            this.update(cx, |this, cx| {
                if this.doc_id().as_deref() != Some(id.as_str()) {
                    return;
                }
                let trashed = this.is_trashed();
                match document {
                    Ok(document) => {
                        if let Some(document) = document {
                            this.set_enhanced(document, cx);
                        }
                        this.enhanced_save.loaded = true;
                        this.enhanced.update(cx, |e, cx| e.set_read_only(trashed, cx));
                    }
                    Err(error) => {
                        tracing::warn!(%error, "could not load the summary; kept read-only");
                        this.enhanced.update(cx, |e, cx| {
                            e.set_placeholder(tr::documents::editor::load_failed(), cx)
                        });
                    }
                }
                this.sync_bar(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The summary names people by the transcript's labels, so a rename is
    /// the same exact swap there: whole names only, in one undoable step,
    /// saved like any change. It is not the person rewriting Cap's summary,
    /// so Regenerate does not ask before replacing it.
    pub(super) fn rename_in_summary(&mut self, from: &str, to: &str, cx: &mut Context<Self>) {
        if self.streaming || self.is_trashed() {
            return;
        }
        for token in summary_labels(from) {
            let names_it = self
                .enhanced
                .read(cx)
                .document()
                .blocks
                .iter()
                .any(|b| !cap_notes::token_ranges(&b.text, &token).is_empty());
            if names_it {
                self.rename_echo += 1;
                self.enhanced
                    .update(cx, |e, cx| e.apply(|ed| ed.rename_token(&token, to), cx));
            }
        }
    }

    /// After the last word: read the saved notes and only swap them in if
    /// they differ from what was streamed. Swapping rebuilds the page's
    /// layout and scroll, which is the flash people saw when notes landed.
    fn settle_enhanced(&mut self, cx: &mut Context<Self>) {
        // The last streamed words are still being shown: compare with the
        // saved page once they are, or the same page would look different.
        if self.enhanced.read(cx).is_pacing() {
            self.settle_after_drain = true;
            return;
        }
        let (Some(id), Some(library)) = (self.doc_id(), self.library(cx)) else {
            return;
        };
        let edits = self.enhanced_save.edits;
        self.load = Some(cx.spawn(async move |this, cx| {
            let doc_id = id.clone();
            let document = cx
                .background_executor()
                .spawn(async move {
                    library
                        .read_enhanced(&doc_id)
                        .ok()
                        .flatten()
                        .and_then(|json| Document::from_json(&json).ok())
                })
                .await;
            this.update(cx, |this, cx| {
                if this.doc_id().as_deref() != Some(id.as_str()) {
                    return;
                }
                let Some(document) = document else {
                    return;
                };
                if this.enhanced_save.edits != edits {
                    // Edited since: what is on screen is the page now.
                    this.enhanced_loaded = true;
                } else if same_page(this.enhanced.read(cx).document(), &document) {
                    this.enhanced_loaded = true;
                    this.enhanced_edited = false;
                } else {
                    this.set_enhanced(document, cx);
                }
                this.sync_preview(cx);
                this.sync_bar(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    /// The summary was written and saved: say so in this pane's copy of the
    /// note now. The store's copy follows a moment later; until then the
    /// note looked like a finished meeting without notes, and for one frame
    /// the page showed the transcript, its audio player and the write-notes
    /// card before flipping back to the summary.
    pub(super) fn notes_landed(&mut self) {
        if let Some(meeting) = self.doc.as_mut().and_then(|d| d.meeting.as_mut()) {
            meeting.has_enhanced = true;
        }
    }

    pub(super) fn has_enhanced(&self) -> bool {
        self.doc
            .as_ref()
            .and_then(|d| d.meeting.as_ref())
            .is_some_and(|m| m.has_enhanced)
    }

    fn generating(&self) -> bool {
        self.writing()
    }

    /// Notes are being written, or will be in a moment.
    fn writing(&self) -> bool {
        self.streaming || self.awaiting.is_some()
    }

    fn await_notes(&mut self, cx: &mut Context<Self>) {
        self.awaiting = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(AWAIT_NOTES_FOR).await;
            this.update(cx, |this, cx| {
                this.awaiting = None;
                this.sync_bar(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    fn shows_generated_tab(&self, cx: &App) -> bool {
        self.has_enhanced()
            || self.streaming
            || self.gen_error.is_some()
            || self.card_for(cx).is_some()
            || self.shows_transcript(cx)
    }

    /// No Cap AI notes yet: the first tab is the transcript.
    fn shows_transcript(&self, cx: &App) -> bool {
        ai_note::shows_transcript(self.note_state(cx))
    }

    fn notes_typed(&self, cx: &App) -> bool {
        self.notes
            .read(cx)
            .document()
            .blocks
            .iter()
            .any(|b| !b.text.trim().is_empty())
    }

    fn sync_placeholder(&mut self, cx: &mut Context<Self>) {
        // Loading, or kept read-only after a failed load (its own message).
        if !self.is_meeting() || !self.notes_save.loaded {
            return;
        }
        let text = match ai_note::placeholder(self.access, self.note_state(cx)) {
            Placeholder::WrittenAtEnd => tr::documents::editor::meeting_placeholder(),
            Placeholder::Own => tr::documents::editor::own_placeholder(),
        };
        if self.notes_placeholder != text {
            self.notes_placeholder = text;
            self.notes.update(cx, |e, cx| e.set_placeholder(text, cx));
        }
    }

    fn refresh_access(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(meetings) = Meetings::try_global(cx) else {
            return false;
        };
        let (access, trial) = {
            let m = meetings.read(cx);
            (m.ai_access(), m.trial_remaining())
        };
        if (access, trial) == (self.access, self.trial_remaining) {
            return false;
        }
        self.access = access;
        self.trial_remaining = trial;
        if access.writes_notes()
            && std::mem::take(&mut self.write_after_sign_in)
            && let Some(id) = self.doc_id()
        {
            meetings.update(cx, |m, cx| m.write_notes_now(&id, cx));
        }
        if access.locked()
            && matches!(
                self.gen_error,
                Some(NotesError::UpgradeRequired | NotesError::NotSignedIn)
            )
        {
            self.gen_error = None;
        }
        true
    }

    fn note_state(&self, cx: &App) -> NoteState {
        let recording = self.bar.read(cx).recording(cx);
        NoteState {
            meeting: self.is_meeting(),
            trashed: self.is_trashed(),
            recording,
            has_transcript: self.has_transcript(cx),
            has_notes: self.has_enhanced(),
            generating: self.generating(),
            dismissed: self.doc.as_ref().is_some_and(ai_note::is_dismissed),
            failed: self.gen_error.is_some(),
            too_short: self.too_short,
        }
    }

    fn card_for(&self, cx: &App) -> Option<CardKind> {
        ai_note::card_kind(self.access, self.trial_remaining, self.note_state(cx))
    }

    fn check_too_short(&mut self, meetings: &Entity<Meetings>, cx: &mut Context<Self>) {
        if self.too_short
            || !self.is_meeting()
            || self.has_enhanced()
            || self.streaming
            || self.gen_error.is_some()
            || !self.access.writes_notes()
        {
            return;
        }
        let (auto, min_chars, running) = {
            let m = meetings.read(cx);
            let id = self.doc_id().unwrap_or_default();
            (
                m.settings().notes.auto_generate,
                m.settings().session_config().min_transcript_chars as u64,
                m.notes_state(&id).is_some_and(|s| s.running)
                    || m.active().is_some_and(|a| a.doc_id == id),
            )
        };
        if !auto || running {
            return;
        }
        let (Some(id), Some(library)) = (self.doc_id(), self.library(cx)) else {
            return;
        };
        let Some(meeting) = library.load(&id).ok().and_then(|m| m.meeting) else {
            return;
        };
        let recent = meeting
            .ended_at
            .is_some_and(|at| chrono::Utc::now() - at < chrono::Duration::minutes(2));
        if recent && meeting.transcript_chars < min_chars {
            self.too_short = true;
            self.awaiting = None;
            self.sync_bar(cx);
            cx.notify();
        }
    }

    fn typed_recently(&self) -> bool {
        self.typed_at
            .is_some_and(|at| at.elapsed() < TYPED_RECENTLY)
    }

    fn on_cap_ai_event(&mut self, _: Entity<CapAi>, event: &CapAiEvent, cx: &mut Context<Self>) {
        let CapAiEvent::Upgraded { doc_id, question } = event else {
            return;
        };
        if doc_id.is_none() || *doc_id != self.doc_id() {
            return;
        }
        self.refresh_access(cx);
        if let Some(question) = question.clone() {
            self.ask
                .update(cx, |a, cx| a.send_after_upgrade(question, cx));
        }
        self.sync_bar(cx);
        cx.notify();
    }

    fn dismiss_card(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                |meta| {
                    meta.extra
                        .insert(ai_note::DISMISSED_KEY.into(), serde_json::Value::Bool(true));
                },
                cx,
            )
        });
        self.sync_bar(cx);
        cx.notify();
    }

    fn dismiss_live_line(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                |meta| {
                    meta.extra.insert(
                        ai_note::LIVE_DISMISSED_KEY.into(),
                        serde_json::Value::Bool(true),
                    );
                },
                cx,
            )
        });
        cx.notify();
    }

    fn card_primary(&mut self, kind: CardKind, cx: &mut Context<Self>) {
        match kind {
            CardKind::SignIn => {
                self.write_after_sign_in = true;
                cx.defer(cap_ai::sign_in);
            }
            CardKind::Upgrade | CardKind::Spent => {
                let doc = self.doc_id();
                cx.defer(move |cx| cap_ai::open_upgrade(doc, Host::Documents, cx));
            }
            CardKind::Write => self.write_notes(None, cx),
            CardKind::Unavailable => {}
        }
    }

    fn has_transcript(&self, cx: &App) -> bool {
        self.transcript.read(cx).has_transcript()
            || self
                .doc
                .as_ref()
                .and_then(|d| d.meeting.as_ref())
                .is_some_and(|m| m.transcript_chars > 0)
    }

    fn sync_bar(&mut self, cx: &mut Context<Self>) {
        let has_transcript = self.has_transcript(cx);
        let panel_open = self.panel_open;
        let writing = self.writing();
        let can_stop = self.generation.is_some() && self.streaming;
        self.bar.update(cx, |b, cx| {
            b.set_state(has_transcript, panel_open, cx);
            b.set_writing(writing, cx);
            if b.can_stop_writing != can_stop {
                b.can_stop_writing = can_stop;
                cx.notify();
            }
        });
        let note = self.note_state(cx);
        let chip = ai_note::chip(self.access, note);
        let access = self.access;
        self.ask.update(cx, |a, cx| {
            a.set_chip(chip, cx);
            a.set_access(access, note.has_notes, note.recording, cx);
        });
        let embedded = note.meeting && ai_note::ask_visible(access);
        self.bar.update(cx, |b, cx| {
            if b.embedded != embedded {
                b.embedded = embedded;
                cx.notify();
            }
        });
        self.sync_placeholder(cx);
        self.sync_writing(cx);
    }

    /// The summary page shows the writing itself: a faint "Writing the
    /// summary" line with a breathing caret until the first words, then the
    /// words fading in where they land. Nothing above the text comes and
    /// goes, so nothing jumps when it is done.
    fn sync_writing(&mut self, cx: &mut Context<Self>) {
        let writing = self.writing() && self.is_meeting();
        if self.enhanced.read(cx).is_writing() == writing && self.writing_shown == writing {
            return;
        }
        self.writing_shown = writing;
        let placeholder = if writing {
            tr::documents::notes::writing_yours()
        } else {
            tr::documents::editor::generated_placeholder()
        };
        self.enhanced.update(cx, |e, cx| {
            e.set_placeholder(placeholder, cx);
            e.set_writing(writing, cx);
        });
    }

    pub fn set_panel(&mut self, open: bool, cx: &mut Context<Self>) {
        if !self.is_meeting() || self.panel_open == open {
            return;
        }
        self.panel_open = open;
        self.menu = None;
        if open {
            self.transcript.update(cx, |t, cx| t.reveal(cx));
        }
        self.sync_bar(cx);
        cx.notify();
    }

    fn show_consent(&mut self, cx: &mut Context<Self>) {
        self.consent = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(CONSENT_FOR).await;
            this.update(cx, |this, cx| {
                this.consent = None;
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn on_title_event(
        &mut self,
        _: &Entity<TextInputState>,
        event: &TextInputEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            TextInputEvent::Changed => {
                self.title_dirty = true;
                self.title_task = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(TITLE_DEBOUNCE).await;
                    this.update(cx, |this, cx| this.commit_title(cx)).ok();
                }));
            }
            TextInputEvent::Confirmed => {
                self.commit_title(cx);
                self.focus_body(window, cx);
            }
            TextInputEvent::Blurred => self.commit_title(cx),
            TextInputEvent::Cancelled => {
                if let Some(meta) = self.doc.clone() {
                    self.sync_title_force(&meta, cx);
                }
                self.focus_body(window, cx);
            }
        }
    }

    fn sync_title_force(&mut self, meta: &DocMeta, cx: &mut Context<Self>) {
        self.title_dirty = false;
        let text = meta.title.clone();
        self.title.update(cx, |t, cx| t.set_text(text, cx));
    }

    /// Leaving a note that holds nothing: a plain note goes away, a meeting
    /// note that heard nothing goes to Trash (it can be restored).
    fn tidy_left_note(&mut self, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.clone() else {
            return;
        };
        // An empty-looking page whose saved text never loaded is not empty.
        if meta.is_trashed() || !self.notes_save.loaded {
            return;
        }
        let recording = Meetings::try_global(cx).is_some_and(|m| {
            m.read(cx).active().is_some_and(|a| a.doc_id == meta.id)
                || m.read(cx).is_finishing(&meta.id)
        });
        let typed_title = self.title.read(cx).text().trim().to_string();
        let typed =
            !typed_title.is_empty() && (!meta.title_is_auto || typed_title != meta.title.trim());
        let titled = typed || (!meta.title_is_auto && !meta.title.trim().is_empty());
        let body_empty = self
            .notes
            .read(cx)
            .document()
            .to_markdown()
            .trim()
            .is_empty();
        let action = leave_action(
            meta.kind == DocKind::Meeting,
            titled,
            body_empty,
            self.has_transcript(cx) || self.has_enhanced(),
            recording,
        );
        let id = meta.id.clone();
        match action {
            LeaveAction::Keep => {}
            LeaveAction::Delete => self
                .store
                .update(cx, |store, cx| store.delete_permanently(vec![id], cx)),
            LeaveAction::Trash => self.store.update(cx, |store, cx| store.trash(vec![id], cx)),
        }
    }

    fn commit_title(&mut self, cx: &mut Context<Self>) {
        self.title_task = None;
        if !std::mem::take(&mut self.title_dirty) {
            return;
        }
        let Some(meta) = self.doc.as_ref() else {
            return;
        };
        let text = self.title.read(cx).text().trim().to_string();
        // Unchanged text keeps a title Cap chose as Cap's (a later summary
        // may still name the meeting); any edit makes it the person's own.
        if text == meta.title.trim() {
            return;
        }
        let id = meta.id.clone();
        let auto = self.auto_title.clone();
        self.store
            .update(cx, |store, cx| store.rename(&id, &text, auto, cx));
    }

    pub fn focus_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.title.clone();
        title.update(cx, |t, cx| {
            window.focus(&t.focus_handle(), cx);
            t.move_to_end(cx);
        });
    }

    /// A meeting someone just started from outside this window (a shortcut,
    /// the call prompt, the tray) lands with the cursor in its notes, as the
    /// window's own Start button does: now if the note is already open, else
    /// once it loads.
    pub fn focus_body_when_open(
        &mut self,
        doc_id: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.doc_id().as_deref() == Some(doc_id) {
            self.show_view(View::Mine, window, cx);
            self.focus_body(window, cx);
        } else {
            self.focus_body_on_load = true;
            self.view = View::Mine;
        }
    }

    pub fn focus_body(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let handle = match self.view {
            View::Mine => self.notes.read(cx).focus_handle(cx),
            View::Generated => self.enhanced.read(cx).focus_handle(cx),
        };
        window.focus(&handle, cx);
    }

    pub fn show_view(&mut self, view: View, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_meeting() {
            return;
        }
        if view == View::Generated && !self.shows_generated_tab(cx) {
            return;
        }
        if self.view != view {
            self.view = view;
            self.menu = None;
            self.popover = None;
            cx.notify();
        }
        self.focus_body(window, cx);
    }

    pub(super) fn page_mode(&self) -> bool {
        self.page_mode
    }

    #[cfg(test)]
    pub(super) fn header_renders(&self, cx: &App) -> usize {
        self.header_view.as_ref().map_or(0, |h| h.read(cx).renders)
    }

    fn set_page_mode(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.page_mode == on {
            return;
        }
        self.page_mode = on;
        if on {
            let pane = cx.weak_entity();
            let render: LeadRender = Rc::new(move |index, window, cx| {
                pane.update(cx, |p, cx| p.render_lead(index, window, cx))
                    .unwrap_or_else(|_| div().into_any_element())
            });
            let list = self.transcript.read(cx).list_state();
            let transcript = self.transcript.downgrade();
            let reveal: RevealHost = Rc::new(move |dy, cx| {
                // A scroll the list cannot make (already at its top or end)
                // must not cost a frame.
                let at = |l: &gpui::ListState| {
                    let top = l.logical_scroll_top();
                    (top.item_ix, top.offset_in_item)
                };
                let before = at(&list);
                list.scroll_by(px(dy));
                let moved = at(&list) != before;
                if moved {
                    transcript.update(cx, |t, cx| t.changed(cx)).ok();
                }
            });
            self.transcript.update(cx, |t, cx| {
                t.set_lead(Some((PAGE_LEAD, render, DOCK_CLEARANCE + 32.)), cx);
                t.list_state().scroll_to(gpui::ListOffset {
                    item_ix: 0,
                    offset_in_item: px(0.),
                });
            });
            self.enhanced
                .update(cx, |e, cx| e.set_fit(true, Some(reveal), cx));
            self.sync_links(cx);
        } else {
            self.transcript.update(cx, |t, cx| {
                t.light(&[], cx);
                t.set_lead(None, cx);
            });
            self.enhanced.update(cx, |e, cx| e.set_fit(false, None, cx));
        }
    }

    fn render_toolbar(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        div()
            .id("pane-toolbar")
            .h(px(TOOLBAR_HEIGHT))
            .flex_shrink_0()
            .w_full()
            .px(px(12.))
            .flex()
            .items_center()
            .justify_end()
            .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
            .when(self.doc.is_some(), |el| {
                el.child(
                    style::icon_button(
                        &palette,
                        "toolbar-more",
                        "icons/more-horizontal.svg",
                        30.,
                        tr::meeting::prompt::more(),
                    )
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(
                        |this, e: &gpui::ClickEvent, _, cx| {
                            let at = e.position();
                            this.open_doc_menu(point(at.x - px(190.), at.y + px(14.)), cx)
                        },
                    )),
                )
            })
            .into_any_element()
    }

    /// The page's own items in its one scroll: the header, the note (both
    /// laid over the lines so typing in them leaves the lines alone), then
    /// the transcript's heading.
    fn render_lead(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let width = self.page_width;
        match index {
            0 => self.render_page_header(width, cx),
            1 => {
                // Cached at its measured height, so a key typed in the title
                // or Ask does not lay the summary out again.
                let page = self.transcript.read(cx).lead_width();
                let editor = self.has_enhanced().then(|| {
                    if page > px(0.) {
                        let height = self
                            .enhanced
                            .update(cx, |e, _| e.fit_height(page, window));
                        gpui::AnyView::from(self.enhanced.clone())
                            .cached(StyleRefinement::default().w_full().h(height))
                            .into_any_element()
                    } else {
                        self.enhanced.clone().into_any_element()
                    }
                });
                div()
                    .w_full()
                    .pt(px(6.))
                    .flex()
                    .flex_col()
                    .children(self.render_generated_status(width, cx))
                    .children(editor)
                    .into_any_element()
            }
            _ => self.render_transcript_head(width, cx),
        }
    }

    /// The header over the page's lines: drawn cached at its last height,
    /// and afresh (measuring its height again) whenever it changed, its width
    /// changed, or it has not been laid out yet.
    fn render_page_header(&mut self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let header = match &self.header_view {
            Some(header) => header.clone(),
            None => {
                let pane = cx.entity();
                let header = cx.new(|cx| HeaderView::new(pane, cx));
                self.header_view = Some(header.clone());
                header
            }
        };
        let known = self.transcript.read(cx).float_height(0);
        let fresh = {
            let view = header.read(cx);
            // Each check runs every frame (no short-circuit): the width must
            // be recorded even when another reason already draws it afresh,
            // or the next frame sees a resize that never happened.
            let stale = view.stale.replace(false);
            let resized = view.width.replace(width) != width;
            let unknown = known <= px(0.);
            let drifted = view.measured.get() != known;
            let fresh = stale || resized || unknown || drifted;
            // Drawn afresh, its height is measured by the page this frame;
            // only a cached draw at a fixed height can drift from it.
            view.known.set(if fresh { px(0.) } else { known });
            fresh
        };
        let view = gpui::AnyView::from(header);
        if fresh {
            view.into_any_element()
        } else {
            view.cached(StyleRefinement::default().w_full().h(known))
                .into_any_element()
        }
    }

    fn render_transcript_head(&mut self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let tool = |id: &'static str, icon: &'static str, label: &'static str| {
            style::icon_button(&palette, id, icon, 28., label).tooltip(move |_, cx| {
                crate::ui::Tooltip::new(&Theme::new(crate::theme::Appearance::Dark), label).view(cx)
            })
        };
        let length = self
            .doc
            .as_ref()
            .and_then(|m| m.meeting.as_ref())
            .filter(|m| m.duration_ms > 0)
            .map(|m| format::duration(m.duration_ms));
        let collapsed = self.transcript.read(cx).collapsed();
        let offer = (!collapsed)
            .then(|| self.transcript.update(cx, |t, cx| t.render_names_offer(cx)))
            .flatten();
        let toggle_label = if collapsed {
            tr::documents::transcript_toggle::show()
        } else {
            tr::documents::transcript_toggle::hide()
        };
        div()
            .w_full()
            .flex()
            .flex_col()
            .child(in_column(
                width,
                div()
                    .mt(px(28.))
                    .mb(px(6.))
                    .pt(px(18.))
                    .border_t(px(1.))
                    .border_color(palette.hairline)
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        div().flex_1().min_w_0().flex().child(
                            div()
                                .id("page-transcript-toggle")
                                .role(gpui::Role::Button)
                                .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                                .aria_label(toggle_label)
                                .ml(px(-8.))
                                .h(px(28.))
                                .pl(px(4.))
                                .pr(px(10.))
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .rounded_full()
                                .text_size(px(14.))
                                .cursor_pointer()
                                .hover(move |s| s.bg(palette.hover))
                                .active(move |s| s.bg(palette.selected))
                                .tooltip(move |_, cx| {
                                    crate::ui::Tooltip::new(
                                        &Theme::new(crate::theme::Appearance::Dark),
                                        toggle_label,
                                    )
                                    .view(cx)
                                })
                                .child(
                                    svg()
                                        .path(if collapsed {
                                            "icons/chevron-right.svg"
                                        } else {
                                            "icons/chevron-down.svg"
                                        })
                                        .size(px(14.))
                                        .text_color(palette.muted),
                                )
                                .child(
                                    div()
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(palette.text)
                                        .child(tr::documents::tabs::transcript()),
                                )
                                .children(length.map(|length| {
                                    div()
                                        .ml(px(2.))
                                        .text_color(palette.faint)
                                        .child(format!("\u{00b7} {length}"))
                                }))
                                .on_click(cx.listener(|this, _, window, cx| {
                                    this.transcript
                                        .update(cx, |t, cx| t.toggle_collapsed(window, cx))
                                })),
                        ),
                    )
                    .child(
                        tool(
                            "page-transcript-find",
                            "icons/search.svg",
                            tr::documents::transcript::find(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.transcript.update(cx, |t, cx| t.open_find(window, cx))
                        })),
                    )
                    .child(
                        tool(
                            "page-transcript-copy",
                            "icons/copy.svg",
                            tr::documents::menu::copy_transcript(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.run(PaneAction::CopyTranscript, window, cx)
                        })),
                    )
                    .into_any_element(),
            ))
            .children(offer)
            .into_any_element()
    }

    /// The latest lines while recording, just above the bar, so the call
    /// can be followed without opening the transcript. The newest line is
    /// full strength; the one before it steps back.
    fn render_captions(&self, width: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        let lines = self.transcript.read(cx).latest(2);
        if lines.is_empty() {
            return None;
        }
        let palette = self.palette;
        let pad = column_padding(width);
        let reduce = style::reduce_motion();
        let count = lines.len();
        let rows = lines
            .into_iter()
            .enumerate()
            .map(|(i, (label, color, text, partial, id))| {
                let base = if i + 1 < count { 0.5 } else { 1. };
                let row = div()
                    .max_w_full()
                    .pl(px(6.))
                    .pr(px(12.))
                    .py(px(5.))
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .rounded(px(14.))
                    .bg(gpui::Hsla {
                        a: 0.94,
                        ..palette.capsule
                    })
                    .border_1()
                    .border_color(palette.capsule_border)
                    .text_size(px(14.))
                    .line_height(px(21.))
                    .child(
                        div()
                            .mt(px(1.))
                            .h(px(20.))
                            .px(px(8.))
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .rounded_full()
                            .bg(gpui::Hsla { a: 0.13, ..color })
                            .text_size(px(11.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(color)
                            .child(label),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .line_clamp(2)
                            .text_color(if partial { palette.muted } else { palette.text })
                            .child(text),
                    );
                if reduce {
                    row.opacity(base).into_any_element()
                } else {
                    let mut hasher = DefaultHasher::new();
                    id.hash(&mut hasher);
                    row.with_animation(
                        ("caption", hasher.finish() as usize),
                        Animation::new(CAPTION_IN).with_easing(ease_out_quint()),
                        move |el, t| el.opacity(base * t).mt(px((1. - t) * 6.)),
                    )
                    .into_any_element()
                }
            });
        Some(
            div()
                .absolute()
                .left_0()
                .right_0()
                .bottom(px(16. + 46. + 14.))
                .px(px(pad))
                .flex()
                .justify_center()
                .child(
                    div()
                        .w_full()
                        .max_w(px(640.))
                        .flex()
                        .flex_col()
                        .items_center()
                        .gap(px(8.))
                        .children(rows),
                )
                .into_any_element(),
        )
    }

    /// Ask beside the page: it slides in from the right edge.
    fn render_sheet(&self, full: f32, _cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let width = SHEET_WIDTH.min(full - SHEET_GAP * 2.).max(280.);
        let sheet = div()
            .id("ask-sheet")
            .occlude()
            .absolute()
            .top(px(SHEET_GAP))
            .bottom(px(SHEET_GAP))
            .right(px(SHEET_GAP))
            .w(px(width))
            .rounded(px(14.))
            .bg(palette.capsule)
            .border_1()
            .border_color(palette.capsule_border)
            .shadow(palette.shadow())
            .overflow_hidden()
            .child(self.ask.clone());
        if self.sheet_moved.is_none() {
            return sheet.into_any_element();
        }
        let opening = self.ask_sheet;
        sheet
            .with_animation(
                ("ask-sheet-move", self.sheet_serial as usize),
                Animation::new(if opening { SHEET_IN } else { SHEET_OUT })
                    .with_easing(ease_out_quint()),
                move |el, t| {
                    let shown = if opening { t } else { 1. - t };
                    el.opacity(shown).right(px(SHEET_GAP - (1. - shown) * 24.))
                },
            )
            .into_any_element()
    }

    /// Keep the note's one-line preview (shown on home) in step with its
    /// summary. Written only when it changes.
    fn sync_preview(&mut self, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.as_ref() else {
            return;
        };
        let preview = summary_preview(self.enhanced.read(cx).document());
        let saved = meta.extra.get(PREVIEW_KEY).and_then(|v| v.as_str());
        if preview.as_deref() == saved {
            return;
        }
        let id = meta.id.clone();
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                move |m| match &preview {
                    Some(text) => {
                        m.extra
                            .insert(PREVIEW_KEY.into(), serde_json::Value::from(text.as_str()));
                    }
                    None => {
                        m.extra.remove(PREVIEW_KEY);
                    }
                },
                cx,
            )
        });
    }

    /// Show these transcript lines and light them: in the page when it holds
    /// the transcript, otherwise in the transcript panel.
    fn reveal_lines(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        if ids.is_empty() {
            return;
        }
        if !self.page_mode {
            self.set_panel(true, cx);
        }
        self.transcript.update(cx, |t, cx| {
            t.reveal_ids(&ids, cx);
            t.light(&ids, cx);
        });
    }

    pub fn toggle_ask_sheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.is_meeting() || !ai_note::ask_visible(self.access) {
            return;
        }
        let open = !self.ask_sheet;
        self.set_ask_sheet(open, cx);
        if open {
            let handle = self.ask.read(cx).input_focus(cx);
            window.focus(&handle, cx);
        }
    }

    fn set_ask_sheet(&mut self, open: bool, cx: &mut Context<Self>) {
        if self.ask_sheet == open {
            return;
        }
        self.ask_sheet = open;
        self.sheet_serial += 1;
        self.sheet_moved = (!style::reduce_motion()).then(Instant::now);
        self.sheet_task = None;
        if open {
            self.ask.update(cx, |a, cx| a.set_sheet(true, cx));
        } else if self.sheet_moved.is_some() {
            self.sheet_task = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(SHEET_OUT).await;
                this.update(cx, |this, cx| {
                    this.ask.update(cx, |a, cx| a.set_sheet(false, cx));
                    this.sheet_moved = None;
                    cx.notify();
                })
                .ok();
            }));
        } else {
            self.ask.update(cx, |a, cx| a.set_sheet(false, cx));
        }
        cx.notify();
    }

    /// The summary's points that can carry a source, as the linker sees them.
    fn summary_points(&self, cx: &App) -> Vec<(usize, usize, String)> {
        self.enhanced
            .read(cx)
            .document()
            .blocks
            .iter()
            .enumerate()
            .filter(|(_, b)| {
                b.origin == Origin::Generated
                    && !b.text.trim().is_empty()
                    && matches!(
                        b.kind,
                        cap_notes::BlockKind::Paragraph
                            | cap_notes::BlockKind::Bullet
                            | cap_notes::BlockKind::Ordered
                            | cap_notes::BlockKind::Task { .. }
                            | cap_notes::BlockKind::Quote
                    )
            })
            .map(|(i, b)| (i, b.text.len(), b.text.clone()))
            .collect()
    }

    /// Relink the summary when it or the transcript changed.
    fn sync_links(&mut self, cx: &mut Context<Self>) {
        let on = self.page_mode && self.view == View::Generated && self.has_enhanced();
        let points = if on {
            self.summary_points(cx)
        } else {
            Vec::new()
        };
        let revision = self.transcript.read(cx).rows_revision();
        let mut hasher = DefaultHasher::new();
        on.hash(&mut hasher);
        revision.hash(&mut hasher);
        points.hash(&mut hasher);
        let key = hasher.finish();
        if key == self.links_key {
            return;
        }
        self.links_key = key;
        if points.is_empty() {
            self.links = Rc::new(Vec::new());
            self.links_task = None;
            self.enhanced
                .update(cx, |e, cx| e.set_sources(Vec::new(), cx));
            return;
        }
        let turns = self.transcript.read(cx).turns();
        let task = cx.background_spawn(async move { link_points(points, turns) });
        self.links_task = Some(cx.spawn(async move |this, cx| {
            let found = task.await;
            this.update(cx, |this, cx| {
                if this.links_key != key {
                    return;
                }
                let marks = found
                    .iter()
                    .enumerate()
                    .map(|(i, l)| SourceMark {
                        block: l.block,
                        text_len: l.text_len,
                        label: cap_meetings::transcript::format_timestamp(l.start_ms).into(),
                        key: i as u64,
                    })
                    .collect();
                this.links = Rc::new(found.into_iter().map(|l| l.ids).collect());
                this.enhanced.update(cx, |e, cx| e.set_sources(marks, cx));
            })
            .ok();
        }));
    }

    /// Link an answer's sentences to the lines they came from.
    fn link_answer(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(answer) = self.ask.read(cx).answer(index).map(str::to_string) else {
            return;
        };
        let sentences = ask_panel::answer_sentences(&answer);
        let points: Vec<(usize, usize, String)> = sentences
            .into_iter()
            .enumerate()
            .map(|(i, s)| (i, s.len(), s))
            .collect();
        let count = points.len();
        let turns = self.transcript.read(cx).turns();
        let task = cx.background_spawn(async move { link_points(points, turns) });
        let ask = self.ask.downgrade();
        if self.answer_tasks.len() >= 4 {
            drop(self.answer_tasks.remove(0));
        }
        self.answer_tasks.push(cx.spawn(async move |_, cx| {
            let found = task.await;
            let mut links: Vec<Option<(SharedString, Vec<String>)>> = vec![None; count];
            for l in found {
                if let Some(slot) = links.get_mut(l.block) {
                    *slot = Some((
                        cap_meetings::transcript::format_timestamp(l.start_ms).into(),
                        l.ids,
                    ));
                }
            }
            let links: AnswerLinks = Rc::new(links);
            ask.update(cx, |a, cx| a.set_answer_links(index, links, cx))
                .ok();
        }));
    }

    pub fn toggle_transcript(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page_mode {
            self.transcript.update(cx, |t, cx| t.reveal_start(cx));
            let handle = self.transcript.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
            return;
        }
        let open = !self.panel_open;
        self.set_panel(open, cx);
        if open && self.panel_open {
            let handle = self.transcript.read(cx).focus_handle(cx);
            window.focus(&handle, cx);
        }
    }

    fn on_notes_event(
        &mut self,
        which: Which,
        event: &NotesEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            NotesEvent::Changed => {
                let state = match which {
                    Which::Notes => &mut self.notes_save,
                    Which::Enhanced => &mut self.enhanced_save,
                };
                if state.suppress > 0 {
                    state.suppress -= 1;
                    return;
                }
                if which == Which::Enhanced {
                    // Words Cap is still showing at its pace are not an edit.
                    if self.streaming || self.enhanced.read(cx).is_pacing() {
                        return;
                    }
                    self.enhanced_save.edits += 1;
                    if self.rename_echo > 0 {
                        self.rename_echo -= 1;
                    } else {
                        self.enhanced_edited = true;
                    }
                    // Relink once typing pauses, never per key: an edited
                    // point simply shows no time until then.
                    if self.page_mode {
                        self.relink_task = Some(cx.spawn(async move |this, cx| {
                            cx.background_executor().timer(RELINK_AFTER).await;
                            this.update(cx, |this, cx| this.sync_links(cx)).ok();
                        }));
                    }
                } else {
                    self.notes_save.edits += 1;
                    self.typed_at = Some(Instant::now());
                }
                if self.is_trashed() {
                    return;
                }
                self.schedule_save(which, cx);
            }
            NotesEvent::Blurred => {
                if which == Which::Notes {
                    self.notes_focused = false;
                }
                self.save_now(which, cx);
            }
            NotesEvent::Focused => {
                if which == Which::Notes {
                    self.notes_focused = true;
                }
            }
            NotesEvent::OpenLink(url) => commands::open_link(url, cx),
            NotesEvent::RequestMention { query } => {
                if which == Which::Notes {
                    self.mention = Some(query.clone());
                    cx.notify();
                }
            }
            NotesEvent::DismissMention => {
                if self.mention.take().is_some() {
                    cx.notify();
                }
            }
            NotesEvent::SlashCommand(id) => {
                if let Some(template_id) = id.strip_prefix("template:")
                    && let Some(template) = templates::find_template(&self.templates, template_id)
                {
                    let markdown = templates::scaffold_markdown(template);
                    let editor = match which {
                        Which::Notes => &self.notes,
                        Which::Enhanced => &self.enhanced,
                    };
                    editor.update(cx, |e, cx| e.apply(|ed| ed.paste_markdown(&markdown), cx));
                }
                let _ = window;
            }
            NotesEvent::SelectionChanged => {}
            NotesEvent::SourceHovered(key) => {
                let ids = key
                    .and_then(|k| self.links.get(k as usize).cloned())
                    .unwrap_or_default();
                self.transcript.update(cx, |t, cx| t.light(&ids, cx));
            }
            NotesEvent::SourceClicked(key) => {
                if let Some(ids) = self.links.get(*key as usize).cloned() {
                    self.reveal_lines(ids, cx);
                }
            }
            NotesEvent::PersonClicked { name, at } => {
                if which == Which::Enhanced && self.has_transcript(cx) {
                    if !self.page_mode {
                        self.set_panel(true, cx);
                    }
                    let (name, at) = (name.clone(), *at);
                    self.transcript
                        .update(cx, |t, cx| t.rename_label(&name, at, window, cx));
                }
            }
            NotesEvent::StreamDrained => {
                if which == Which::Enhanced && std::mem::take(&mut self.settle_after_drain) {
                    self.settle_enhanced(cx);
                }
            }
        }
    }

    fn schedule_save(&mut self, which: Which, cx: &mut Context<Self>) {
        let state = match which {
            Which::Notes => &mut self.notes_save,
            Which::Enhanced => &mut self.enhanced_save,
        };
        let now = Instant::now();
        let since = *state.dirty_since.get_or_insert(now);
        if now.saturating_duration_since(since) >= SAVE_MAX_WAIT {
            self.save_now(which, cx);
            return;
        }
        state.task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SAVE_DEBOUNCE).await;
            this.update(cx, |this, cx| this.save_now(which, cx)).ok();
        }));
    }

    fn save_now(&mut self, which: Which, cx: &mut Context<Self>) {
        let (state, editor) = match which {
            Which::Notes => (&mut self.notes_save, &self.notes),
            Which::Enhanced => (&mut self.enhanced_save, &self.enhanced),
        };
        state.task = None;
        if state.dirty_since.take().is_none() {
            return;
        }
        if !state.loaded {
            // Its saved text never loaded: writing now would replace it.
            return;
        }
        let Some(id) = state.doc_id.clone() else {
            return;
        };
        let Some(library) = self.store.read(cx).library().cloned() else {
            return;
        };
        let json = editor.read(cx).document().to_json();
        writer::submit(move || {
            let result = match which {
                Which::Notes => library.write_notes(&id, &json),
                Which::Enhanced => library.write_enhanced(&id, &json),
            };
            if let Err(error) = result {
                tracing::warn!(%error, "could not save the notes");
            }
        });
    }

    pub fn flush_saves(&mut self, cx: &mut Context<Self>) {
        // Quitting runs only this, inside the title's debounce.
        self.commit_title(cx);
        // Home's line follows an edited summary when the note is left, not
        // on every save while typing.
        if self.enhanced_edited {
            self.sync_preview(cx);
        }
        self.save_now(Which::Notes, cx);
        self.save_now(Which::Enhanced, cx);
    }

    pub fn closing(&mut self, cx: &mut Context<Self>) {
        self.commit_title(cx);
        self.flush_saves(cx);
        self.tidy_left_note(cx);
        self.transcript.update(cx, |t, cx| t.set_doc(None, cx));
    }

    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.menu.take().is_some() || self.popover.take().is_some() {
            cx.notify();
            return true;
        }
        if self.panel_open {
            if self.transcript.update(cx, |t, cx| t.dismiss(window, cx)) {
                return true;
            }
            self.set_panel(false, cx);
            return true;
        }
        if self.ask.read(cx).is_open() {
            self.ask.update(cx, |a, cx| a.close(cx));
            return true;
        }
        false
    }

    fn append_stream(&mut self, markdown: &str, cx: &mut Context<Self>) {
        let chunk = markdown.get(self.stream_offset..).unwrap_or("");
        if chunk.is_empty() {
            return;
        }
        let chunk = chunk.to_string();
        self.stream_offset = markdown.len();
        self.enhanced.update(cx, |e, cx| {
            e.append_markdown_streaming(&chunk, Origin::Generated, cx)
        });
    }

    fn on_meeting_event(
        &mut self,
        meetings: &Entity<Meetings>,
        event: &MeetingEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.doc_id() else {
            return;
        };
        match event {
            MeetingEvent::NotesProgress { doc_id, stage } if *doc_id == id => {
                if self.stopped.as_deref() == Some(id.as_str()) {
                    if matches!(stage, NotesStage::Started) {
                        self.stopped = None;
                    } else {
                        return;
                    }
                }
                if !matches!(stage, NotesStage::Title(_) | NotesStage::Delta) {
                    self.awaiting = None;
                }
                match stage {
                    NotesStage::Started => {
                        self.too_short = false;
                        if !self.typed_recently() {
                            self.view = View::Generated;
                        }
                        self.writing_at = Instant::now();
                        self.streaming = true;
                        self.stream_offset = 0;
                        self.gen_error = None;
                        self.enhanced_loaded = true;
                        self.enhanced_save.suppress += 1;
                        self.enhanced
                            .update(cx, |e, cx| e.set_document(Document::new(), cx));
                    }
                    NotesStage::Delta => {
                        let markdown = meetings
                            .read(cx)
                            .notes_state(&id)
                            .map(|s| s.markdown.clone())
                            .unwrap_or_default();
                        self.streaming = true;
                        self.append_stream(&markdown, cx);
                    }
                    NotesStage::Title(title) => self.land_title(title, window, cx),
                    NotesStage::Waiting(_) => {}
                    NotesStage::Done => {
                        self.notes_landed();
                        self.streaming = false;
                        self.generation = None;
                        self.settle_enhanced(cx);
                        if self.view == View::Mine {
                            let pane = cx.weak_entity();
                            let view: super::window::ToastAction = Rc::new(move |window, cx| {
                                pane.update(cx, |pane, cx| {
                                    pane.show_view(View::Generated, window, cx)
                                })
                                .ok();
                            });
                            self.root
                                .update(cx, |root, cx| {
                                    root.show_toast(
                                        tr::documents::notes::ready(),
                                        Some((tr::documents::notes::view_notes().into(), view)),
                                        None,
                                        cx,
                                    )
                                })
                                .ok();
                        }
                    }
                    NotesStage::Failed(error)
                        if !self.auto_retried
                            && !self.has_enhanced()
                            && matches!(
                                error,
                                NotesError::Offline(_)
                                    | NotesError::Interrupted(_)
                                    | NotesError::Failed(_)
                            ) =>
                    {
                        self.streaming = false;
                        self.generation = None;
                        self.auto_retried = true;
                        self.retry_quietly(cx);
                    }
                    NotesStage::Failed(error) => {
                        self.streaming = false;
                        self.generation = None;
                        self.gen_error = Some(error.clone());
                        self.unland_title(window, cx);
                        if *error == NotesError::UpgradeRequired {
                            self.refresh_access(cx);
                        }
                        if self.has_enhanced() {
                            self.load_enhanced(cx);
                        }
                    }
                }
                self.sync_bar(cx);
                cx.notify();
            }
            MeetingEvent::SpeakerRenamed { doc_id, from, to } if *doc_id == id => {
                self.rename_in_summary(from, to, cx);
            }
            MeetingEvent::RecordingStarted { doc_id } if *doc_id == id => {
                self.view = View::Mine;
                self.show_consent(cx);
                self.sync_bar(cx);
                cx.notify();
            }
            MeetingEvent::RecordingStopped { doc_id, .. } if *doc_id == id => {
                self.consent = None;
                self.refresh_access(cx);
                let (auto, min_chars) = {
                    let settings = meetings.read(cx).settings();
                    (
                        settings.notes.auto_generate,
                        settings.session_config().min_transcript_chars as u64,
                    )
                };
                let heard = self
                    .library(cx)
                    .and_then(|library| library.load(&id).ok())
                    .and_then(|meta| meta.meeting)
                    .map_or(0, |meeting| meeting.transcript_chars);
                if notes_follow_stop(self.access, auto, self.has_enhanced(), heard >= min_chars) {
                    // Straight into the notes being written: no offer to
                    // write them, no transcript dump, and the panel that
                    // showed live captions steps aside.
                    self.await_notes(cx);
                    self.auto_retried = false;
                    if !self.typed_recently() {
                        self.view = View::Generated;
                    }
                    if self.panel_open {
                        self.set_panel(false, cx);
                    }
                } else {
                    let captured = self.card_for(cx).is_some() || self.shows_transcript(cx);
                    if captured && !self.typed_recently() && !self.notes_typed(cx) {
                        self.view = View::Generated;
                    }
                }
                self.sync_bar(cx);
                cx.notify();
            }
            MeetingEvent::LibraryChanged => {
                self.check_too_short(meetings, cx);
            }
            MeetingEvent::ActiveChanged => self.sync_bar(cx),
            MeetingEvent::TranscriptChanged { doc_id } if *doc_id == id => {
                self.sync_bar(cx);
                // Captions and the Ask sheet's live line follow the words.
                if self.bar.read(cx).recording(cx) {
                    cx.notify();
                }
            }
            MeetingEvent::SettingsChanged => {
                self.load_templates(cx);
                cx.notify();
            }
            _ => {}
        }
        let _ = window;
    }

    pub fn start_recording(&mut self, source: StartSource, cx: &mut Context<Self>) {
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        if !crate::meetings_ui::live::can_record(cx) {
            cx.defer(crate::meetings_ui::setup::open);
            return;
        }
        let fresh = !matches!(source, StartSource::Resume(_) | StartSource::Into { .. });
        let result = meetings.update(cx, |m, cx| m.start_recording(source, cx));
        match result {
            Ok(doc_id) => {
                self.focus_body_on_load =
                    fresh && self.doc_id().as_deref() != Some(doc_id.as_str());
                self.view = View::Mine;
                self.store
                    .update(cx, |store, cx| store.open_when_listed(doc_id, cx));
                cx.notify();
            }
            Err(MeetingError::Disabled) => cx.defer(crate::meetings_ui::setup::open),
            Err(error) => {
                tracing::warn!(%error, "meeting recording did not start");
                let message = match error {
                    MeetingError::NotFound => tr::documents::bar::error_not_found(),
                    _ => tr::documents::bar::error_start(),
                };
                self.toast(message, cx);
            }
        }
    }

    pub fn toggle_recording(&mut self, cx: &mut Context<Self>) {
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        let Some(id) = self.doc_id() else {
            return;
        };
        if self.is_trashed() {
            return;
        }
        let ours = meetings
            .read(cx)
            .active()
            .is_some_and(|a| a.doc_id == id && a.state == crate::meetings::ActiveState::Recording);
        if ours {
            meetings.update(cx, |m, cx| {
                m.stop_recording(crate::meetings::StopReason::User, cx)
            });
        } else if !self.has_transcript(cx) {
            // A note that already has a meeting records more only from its
            // Record more button, so a second press of the shortcut after
            // Stop does not start again.
            self.start_recording(
                StartSource::Into {
                    doc_id: id,
                    event_id: None,
                },
                cx,
            );
        }
    }

    /// The title Cap AI chose shows the moment it arrives, not after the
    /// last word of the notes.
    pub(super) fn land_title(&mut self, title: &str, window: &mut Window, cx: &mut Context<Self>) {
        let title = title.trim();
        let auto = self.doc.as_ref().is_some_and(|d| d.title_is_auto);
        if !auto || title.is_empty() || self.title.read(cx).is_focused(window) {
            return;
        }
        if self.auto_title.as_deref() != Some(title) {
            self.title_landed += 1;
        }
        self.auto_title = Some(title.to_string());
        let title = title.to_string();
        self.title.update(cx, |input, cx| input.set_text(title, cx));
    }

    /// Notes that failed take back the title Cap AI sent with them: the
    /// field shows the saved title again, unless the person changed it.
    pub(super) fn unland_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.as_ref() else {
            return;
        };
        if !meta.title_is_auto || self.title.read(cx).is_focused(window) {
            return;
        }
        let shown = self.title.read(cx).text().trim().to_string();
        let saved = meta.title.clone();
        if self.auto_title.as_deref() != Some(shown.as_str()) || shown == saved.trim() {
            return;
        }
        self.auto_title = Some(saved.clone()).filter(|t| !t.trim().is_empty());
        self.title.update(cx, |input, cx| input.set_text(saved, cx));
    }

    /// One quiet retry a few seconds after a failed write; the writing
    /// state stays up meanwhile.
    fn retry_quietly(&mut self, cx: &mut Context<Self>) {
        let doc = self.doc_id();
        self.awaiting = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(QUIET_RETRY_AFTER).await;
            this.update(cx, |this, cx| {
                this.awaiting = None;
                if this.doc_id() == doc {
                    this.write_notes(None, cx);
                }
                this.sync_bar(cx);
                cx.notify();
            })
            .ok();
        }));
    }

    pub fn write_notes(&mut self, options: Option<GenerateOptions>, cx: &mut Context<Self>) {
        if !self.is_meeting() || self.streaming || self.is_trashed() {
            return;
        }
        if self.has_enhanced() && self.enhanced_edited {
            let Some(window) = cx
                .windows()
                .into_iter()
                .find(|w| Some(*w) == crate::meetings_ui::MeetingWindows::get(cx).documents)
            else {
                return;
            };
            let pane = cx.weak_entity();
            window
                .update(cx, |_, window, cx| {
                    let answer = window.prompt(
                        gpui::PromptLevel::Warning,
                        tr::documents::confirm::replace_notes(),
                        Some(tr::documents::confirm::replace_notes_detail()),
                        &[
                            gpui::PromptButton::ok(tr::documents::confirm::replace()),
                            gpui::PromptButton::cancel(tr::common::cancel()),
                        ],
                        cx,
                    );
                    cx.spawn(async move |cx| {
                        if answer.await.ok() == Some(0) {
                            pane.update(cx, |pane, cx| pane.generate(options, cx)).ok();
                        }
                    })
                    .detach();
                })
                .ok();
            return;
        }
        self.generate(options, cx);
    }

    fn generate(&mut self, options: Option<GenerateOptions>, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        let Some(meetings) = Meetings::try_global(cx) else {
            return;
        };
        self.flush_saves(cx);
        self.gen_error = None;
        self.stopped = None;
        self.view = View::Generated;
        let options = options.unwrap_or_default();
        let task = self.after_saves(cx, move |cx| {
            meetings.update(cx, |m, cx| m.generate_notes(&id, options, cx))
        });
        self.generation = Some(task);
        self.sync_bar(cx);
        cx.notify();
    }

    /// Starts `start` once every save queued so far has landed: writing
    /// notes reads the notes and the last summary back from disk, so it must
    /// not run ahead of the edits just flushed.
    pub(super) fn after_saves<T: 'static>(
        &mut self,
        cx: &mut Context<Self>,
        start: impl FnOnce(&mut App) -> Task<T> + 'static,
    ) -> Task<T> {
        let saved = writer::run(|| ());
        cx.spawn(async move |_, cx| {
            saved.await;
            let task = cx.update(start);
            task.await
        })
    }

    fn stop_generation(&mut self, cx: &mut Context<Self>) {
        if self.generation.take().is_none() {
            return;
        }
        self.stopped = self.doc_id();
        self.streaming = false;
        if self.has_enhanced() {
            self.load_enhanced(cx);
        } else {
            self.enhanced_save.suppress += 1;
            self.enhanced
                .update(cx, |e, cx| e.set_document(Document::new(), cx));
        }
        self.sync_bar(cx);
        cx.notify();
    }

    fn add_participant(&mut self, email: String, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        if !email.contains('@') || email.contains(char::is_whitespace) {
            return;
        }
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                move |meta| {
                    if let Some(meeting) = meta.meeting.as_mut()
                        && !meeting
                            .participants
                            .iter()
                            .any(|p| p.eq_ignore_ascii_case(&email))
                    {
                        meeting.participants.push(email.clone());
                    }
                },
                cx,
            )
        });
    }

    fn remove_participant(&mut self, name: String, cx: &mut Context<Self>) {
        let Some(id) = self.doc_id() else {
            return;
        };
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                move |meta| {
                    if let Some(meeting) = meta.meeting.as_mut() {
                        meeting.participants.retain(|p| *p != name);
                    }
                },
                cx,
            )
        });
    }

    fn insert_mention(&mut self, label: String, cx: &mut Context<Self>) {
        self.mention = None;
        let id = label.clone();
        self.notes
            .update(cx, |e, cx| e.insert_mention(id, &label, cx));
        cx.notify();
    }

    fn open_doc_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.as_ref() else {
            return;
        };
        let meeting = meta.kind == DocKind::Meeting;
        let has_audio = meta.meeting.as_ref().is_some_and(|m| !m.audio.is_empty());
        let mut entries = vec![Entry::new(
            tr::documents::menu::copy_notes(),
            PaneAction::CopyNotes,
        )];
        if meeting {
            entries.push(Entry::new(
                tr::documents::menu::copy_transcript(),
                PaneAction::CopyTranscript,
            ));
        }
        entries.push(Entry::new(
            tr::documents::menu::export(),
            PaneAction::Export,
        ));
        let live = Meetings::try_global(cx)
            .and_then(|m| m.read(cx).active().map(|a| a.doc_id == meta.id))
            .unwrap_or(false);
        if has_audio {
            entries.push(Entry::new(
                tr::documents::menu::reveal(),
                PaneAction::Reveal,
            ));
            if live {
                entries.push(Entry::disabled(tr::documents::menu::open_in_editor()));
                entries.push(Entry::disabled(tr::documents::menu::download_audio()));
            } else {
                entries.push(Entry::new(
                    tr::documents::menu::open_in_editor(),
                    PaneAction::OpenInEditor,
                ));
                entries.push(Entry::new(
                    tr::documents::menu::download_audio(),
                    PaneAction::DownloadAudio,
                ));
            }
        }
        entries.push(Entry::separator());
        if meta.is_trashed() {
            entries.push(Entry::new(
                tr::documents::menu::restore(),
                PaneAction::Restore,
            ));
            entries.push(
                Entry::new(
                    tr::documents::menu::delete_forever(),
                    PaneAction::DeleteForever,
                )
                .danger(),
            );
        } else {
            entries.push(if live {
                Entry::disabled(tr::documents::menu::trash())
            } else {
                Entry::new(tr::documents::menu::trash(), PaneAction::Trash).danger()
            });
        }
        self.menu = Some(OpenMenu {
            id: "documents-doc-menu",
            position,
            entries,
        });
        cx.notify();
    }

    fn open_folder_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.as_ref() else {
            return;
        };
        let store = self.store.read(cx);
        let mut entries = vec![
            Entry::new(tr::documents::menu::no_folder(), PaneAction::Folder(None))
                .checked(meta.folder_id.is_none()),
        ];
        for folder in &store.snapshot.folders {
            entries.push(
                Entry::new(
                    folder.name.clone(),
                    PaneAction::Folder(Some(folder.id.clone())),
                )
                .checked(meta.folder_id.as_ref() == Some(&folder.id)),
            );
        }
        self.menu = Some(OpenMenu {
            id: "documents-folder-chip-menu",
            position,
            entries,
        });
        cx.notify();
    }

    fn current_template_id(&self, cx: &App) -> String {
        self.doc
            .as_ref()
            .and_then(|d| d.template_id.clone())
            .or_else(|| {
                Meetings::try_global(cx)
                    .map(|m| m.read(cx).settings().notes.default_template_id.clone())
            })
            .unwrap_or_else(|| templates::DEFAULT_TEMPLATE_ID.to_string())
    }

    fn template_name(&self, cx: &App) -> String {
        let id = self.current_template_id(cx);
        templates::find_template(&self.templates, &id)
            .map(format::template_name)
            .unwrap_or_default()
    }

    fn open_template_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let current = self.current_template_id(cx);
        let entries = templates::templates_for(&self.templates, &DocKind::Meeting)
            .into_iter()
            .map(|t| {
                let checked = t.id == current;
                Entry::new(format::template_name(&t), PaneAction::Template(t.id)).checked(checked)
            })
            .collect();
        self.menu = Some(OpenMenu {
            id: "documents-template-menu",
            position,
            entries,
        });
        cx.notify();
    }

    fn run(&mut self, action: PaneAction, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let Some(id) = self.doc_id() else {
            return;
        };
        let root = self.root.clone();
        match action {
            PaneAction::CopyNotes => {
                self.flush_saves(cx);
                commands::copy_notes(&self.store, &id, root, cx)
            }
            PaneAction::CopyTranscript => commands::copy_transcript(&self.store, &id, root, cx),
            PaneAction::Export => {
                self.flush_saves(cx);
                commands::export_markdown(&self.store, &id, root, window, cx)
            }
            PaneAction::Reveal => commands::reveal_files(&self.store, &id, cx),
            PaneAction::OpenInEditor => {
                if let Some(meta) = self.doc.as_ref() {
                    super::audio::open_in_editor(&self.store, meta, cx);
                }
            }
            PaneAction::DownloadAudio => {
                if let Some(meta) = self.doc.as_ref() {
                    super::audio::download(&self.store, meta, window, cx);
                }
            }
            PaneAction::Trash => {
                let store = self.store.downgrade();
                let restore = id.clone();
                self.store
                    .update(cx, |store, cx| store.trash(vec![id.clone()], cx));
                let undo: super::window::ToastAction = Rc::new(move |_, cx| {
                    let restore = restore.clone();
                    store
                        .update(cx, |store, cx| {
                            store.restore(vec![restore.clone()], cx);
                            store.open(Some(restore), cx);
                        })
                        .ok();
                });
                self.root
                    .update(cx, |root, cx| {
                        root.show_toast(
                            tr::documents::toast::moved_to_trash(1),
                            Some((tr::documents::toast::undo().into(), undo)),
                            None,
                            cx,
                        )
                    })
                    .ok();
            }
            PaneAction::Restore => self
                .store
                .update(cx, |store, cx| store.restore(vec![id], cx)),
            PaneAction::DeleteForever => {
                let answer = window.prompt(
                    gpui::PromptLevel::Warning,
                    &tr::documents::confirm::delete_forever(1),
                    Some(tr::documents::confirm::cannot_undo()),
                    &[
                        gpui::PromptButton::ok(tr::documents::confirm::delete()),
                        gpui::PromptButton::cancel(tr::common::cancel()),
                    ],
                    cx,
                );
                let store = self.store.clone();
                cx.spawn(async move |_, cx| {
                    if answer.await.ok() == Some(0) {
                        store.update(cx, |store, cx| store.delete_permanently(vec![id], cx));
                    }
                })
                .detach();
            }
            PaneAction::Folder(folder) => self
                .store
                .update(cx, |store, cx| store.move_to_folder(vec![id], folder, cx)),
            PaneAction::Template(template) => {
                self.store.update(cx, |store, cx| {
                    store.update_meta(
                        &id,
                        move |meta| meta.template_id = Some(template.clone()),
                        cx,
                    )
                });
            }
            PaneAction::Regenerate => {
                self.popover = None;
                self.write_notes(None, cx);
            }
            PaneAction::Microphone(name) => {
                if let Some(meetings) = Meetings::try_global(cx) {
                    meetings.update(cx, |m, cx| {
                        m.update_settings(
                            |s| {
                                s.recording.microphone = match name {
                                    Some(name) => Microphone::Named(name),
                                    None => Microphone::Auto,
                                }
                            },
                            cx,
                        )
                    });
                }
            }
            PaneAction::Language(code) => {
                if let Some(meetings) = Meetings::try_global(cx) {
                    meetings.update(cx, |m, cx| {
                        m.update_settings(
                            |s| {
                                s.transcription.language = if code == "auto" {
                                    Language::Auto
                                } else {
                                    Language::Code(code)
                                }
                            },
                            cx,
                        )
                    });
                }
            }
            PaneAction::RegenerateWith(template) => {
                self.popover = None;
                self.write_notes(
                    Some(GenerateOptions {
                        template_id: Some(template),
                        instruction: None,
                    }),
                    cx,
                );
            }
        }
        cx.notify();
    }
}

impl Pane {
    fn open_mic_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let current = Meetings::try_global(cx)
            .map(|m| m.read(cx).settings().recording.microphone.clone())
            .unwrap_or_default();
        let mut entries = vec![
            Entry::new(
                tr::documents::panel::mic_auto(),
                PaneAction::Microphone(None),
            )
            .checked(current == Microphone::Auto),
        ];
        for name in &self.microphones {
            entries.push(
                Entry::new(name.clone(), PaneAction::Microphone(Some(name.clone())))
                    .checked(current == Microphone::Named(name.clone())),
            );
        }
        self.menu = Some(OpenMenu {
            id: "documents-mic-menu",
            position,
            entries,
        });
        if self.mic_task.is_none() {
            self.mic_task = Some(cx.spawn(async move |this, cx| {
                let names = cx
                    .background_executor()
                    .spawn(async { cap_recording::feeds::microphone::MicrophoneFeed::list_names() })
                    .await;
                this.update(cx, |this, cx| {
                    this.microphones = names;
                    if let Some(menu) = this.menu.as_ref()
                        && menu.id == "documents-mic-menu"
                    {
                        let at = menu.position;
                        this.open_mic_menu(at, cx);
                    }
                })
                .ok();
            }));
        }
        cx.notify();
    }

    fn open_language_menu(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let current = Meetings::try_global(cx)
            .map(|m| m.read(cx).settings().transcription.language.clone())
            .unwrap_or_default();
        let entries = crate::editor_tabs::CAPTION_LANGUAGES
            .iter()
            .map(|(code, label)| {
                let checked = match &current {
                    Language::Auto => *code == "auto",
                    Language::Code(c) => c == code,
                };
                Entry::new(label(), PaneAction::Language((*code).to_string())).checked(checked)
            })
            .collect();
        self.menu = Some(OpenMenu {
            id: "documents-language-menu",
            position,
            entries,
        });
        cx.notify();
    }

    fn mic_label(&self, cx: &App) -> SharedString {
        match Meetings::try_global(cx).map(|m| m.read(cx).settings().recording.microphone.clone()) {
            Some(Microphone::Named(name)) => name.into(),
            _ => tr::documents::panel::mic_auto().into(),
        }
    }

    fn language_label(&self, cx: &App) -> SharedString {
        let language = Meetings::try_global(cx)
            .map(|m| m.read(cx).settings().transcription.language.clone())
            .unwrap_or_default();
        let code = match &language {
            Language::Auto => "auto",
            Language::Code(code) => code.as_str(),
        };
        crate::editor_tabs::CAPTION_LANGUAGES
            .iter()
            .find(|(c, _)| *c == code)
            .map(|(_, label)| label())
            .unwrap_or(code)
            .to_string()
            .into()
    }

    /// One part of the note's meta line: plain text that shows it can be
    /// clicked only on hover.
    fn meta_part(&self, id: &'static str, label: SharedString) -> gpui::Stateful<gpui::Div> {
        let palette = self.palette;
        div()
            .id(id)
            .role(gpui::Role::Button)
            .when(palette.keyboard, crate::ui::keyboard_nav::stop)
            .aria_label(label.clone())
            .h(px(24.))
            .px(px(6.))
            .mx(px(-6.))
            .flex()
            .items_center()
            .rounded(px(6.))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(palette.muted)
            .hover(move |s| s.bg(palette.hover).text_color(palette.text))
            .child(div().max_w(px(260.)).truncate().child(label))
    }

    /// Start and end of the open note in local time.
    fn when_span(meta: &DocMeta) -> (chrono::NaiveDateTime, Option<chrono::NaiveDateTime>) {
        let start = format::local(meta.sort_time());
        let end = meta.meeting.as_ref().and_then(|m| {
            m.ended_at.map(format::local).or_else(|| {
                (m.duration_ms > 0)
                    .then(|| start + chrono::Duration::milliseconds(m.duration_ms as i64))
            })
        });
        (start, end)
    }

    fn open_when(&mut self, at: Point<Pixels>, window: &mut Window, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.clone() else {
            return;
        };
        let (start, end) = Self::when_span(&meta);
        let field = |text: String, window: &mut Window, cx: &mut Context<Self>| {
            cx.new(|cx| {
                let mut input = TextInputState::single_line(window, cx);
                input.set_text(text, cx);
                input
            })
        };
        let start_input = field(format::clock(start), window, cx);
        let meeting = meta.kind == DocKind::Meeting;
        let end_input =
            (meeting).then(|| field(end.map(format::clock).unwrap_or_default(), window, cx));
        let mut subscriptions = Vec::new();
        for (input, is_end) in std::iter::once((start_input.clone(), false))
            .chain(end_input.clone().map(|e| (e, true)))
        {
            subscriptions.push(cx.subscribe_in(
                &input,
                window,
                move |this, input, event: &TextInputEvent, window, cx| match event {
                    TextInputEvent::Confirmed | TextInputEvent::Blurred => {
                        let text = input.read(cx).text().to_string();
                        this.apply_when_time(&text, is_end, window, cx);
                    }
                    TextInputEvent::Cancelled => {
                        this.popover = None;
                        this.when_edit = None;
                        cx.notify();
                    }
                    TextInputEvent::Changed => {}
                },
            ));
        }
        start_input.update(cx, |i, cx| i.focus_and_select_all(window, cx));
        self.when_edit = Some(WhenEdit {
            month: chrono::Datelike::with_day(&start.date(), 1).unwrap_or(start.date()),
            start: start_input,
            end: end_input,
            _subscriptions: subscriptions,
        });
        self.popover = Some(Popover::Event(at));
        cx.notify();
    }

    /// Saves a new start (and end, for meetings), local time.
    fn set_when(
        &mut self,
        start: chrono::NaiveDateTime,
        end: Option<chrono::NaiveDateTime>,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.doc_id() else {
            return;
        };
        let Some(start) = when::to_utc(start) else {
            return;
        };
        let end = end.and_then(when::to_utc);
        self.store.update(cx, |store, cx| {
            store.update_meta(
                &id,
                move |meta| match meta.meeting.as_mut() {
                    Some(meeting) => {
                        meeting.started_at = Some(start);
                        if let Some(end) = end {
                            meeting.ended_at = Some(end);
                        }
                    }
                    None => meta.created_at = start,
                },
                cx,
            )
        });
    }

    pub(super) fn pick_when_day(&mut self, day: chrono::NaiveDate, cx: &mut Context<Self>) {
        let Some(meta) = self.doc.clone() else {
            return;
        };
        let (start, end) = Self::when_span(&meta);
        let moved = day.and_time(start.time());
        let shift = moved - start;
        self.set_when(moved, end.map(|e| e + shift), cx);
    }

    pub(super) fn apply_when_time(
        &mut self,
        text: &str,
        is_end: bool,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(meta) = self.doc.clone() else {
            return;
        };
        let (start, end) = Self::when_span(&meta);
        let (new_start, new_end) = match (when::parse_clock(text), is_end) {
            (Some(time), false) => {
                let moved = start.date().and_time(time);
                (moved, end.map(|e| e + (moved - start)))
            }
            (Some(time), true) => {
                let mut until = start.date().and_time(time);
                if until <= start {
                    until += chrono::Duration::days(1);
                }
                (start, Some(until))
            }
            (None, _) => (start, end),
        };
        if (new_start, new_end) != (start, end) {
            self.set_when(new_start, new_end, cx);
        }
        // Show what was saved, in the clock's own format (a time that could
        // not be read goes back to what it was).
        if let Some(edit) = self.when_edit.as_ref() {
            let start_text = format::clock(new_start);
            edit.start.update(cx, |i, cx| i.set_text(start_text, cx));
            if let (Some(end_input), Some(end)) = (edit.end.as_ref(), new_end) {
                let end_text = format::clock(end);
                end_input.update(cx, |i, cx| i.set_text(end_text, cx));
            }
        }
        cx.notify();
    }

    fn when_label(&self, meta: &DocMeta, cx: &App) -> String {
        let today = Local::now().date_naive();
        let start = format::local(meta.sort_time());
        let day = format::short_date(start.date(), today);
        let Some(meeting) = meta.meeting.as_ref() else {
            return format!("{day} · {}", format::clock(start));
        };
        let live = self.bar.read(cx).recording(cx);
        if live {
            return format!("{day} · {}", format::clock(start));
        }
        let end = meeting.ended_at.map(format::local).or_else(|| {
            (meeting.duration_ms > 0)
                .then(|| start + chrono::Duration::milliseconds(meeting.duration_ms as i64))
        });
        if end.is_some() && meeting.duration_ms > 0 {
            format!(
                "{day} · {} · {}",
                format::clock(start),
                format::duration(meeting.duration_ms)
            )
        } else {
            format!("{day} · {}", format::clock(start))
        }
    }

    fn render_header(&self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let Some(meta) = self.doc.as_ref() else {
            return div().into_any_element();
        };
        let palette = self.palette;
        let meeting = meta.kind == DocKind::Meeting;
        let pad = column_padding(width);
        let theme = input_theme(&palette);
        let people = export::participants(meta);
        let people_label: SharedString = if people.is_empty() {
            tr::documents::note::me().into()
        } else {
            let mut names = people
                .iter()
                .take(2)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            if people.len() > 2 {
                names.push_str(&format!(" +{}", people.len() - 2));
            }
            names.into()
        };
        let folder = meta
            .folder_id
            .as_deref()
            .and_then(|f| self.store.read(cx).folder_name(f))
            .map(str::to_string);
        let event = meta.meeting.as_ref().and_then(|m| m.event.clone());
        let trashed = meta.is_trashed();
        let palette_dot = palette;
        let dot = move || {
            div()
                .text_size(px(13.))
                .text_color(palette_dot.faint)
                .child("·")
        };
        let mut parts: Vec<AnyElement> = Vec::new();
        let when_label: SharedString = self.when_label(meta, cx).into();
        let when = if trashed || self.bar.read(cx).recording(cx) {
            // Not editable while recording or in the trash: plain text.
            div()
                .h(px(24.))
                .flex()
                .items_center()
                .text_size(px(13.))
                .text_color(palette.muted)
                .child(div().max_w(px(260.)).truncate().child(when_label))
                .into_any_element()
        } else {
            self.meta_part("meta-when", when_label)
                .on_click(cx.listener(|this, e: &gpui::ClickEvent, window, cx| {
                    this.open_when(chip_anchor(e), window, cx)
                }))
                .into_any_element()
        };
        let _ = &event;
        parts.push(when);
        if meeting {
            parts.push(
                self.meta_part("meta-people", people_label)
                    .on_click(cx.listener(|this, e: &gpui::ClickEvent, window, cx| {
                        this.popover = Some(Popover::Participants(chip_anchor(e)));
                        let input = this.participant_input.clone();
                        input.update(cx, |i, cx| i.focus_and_select_all(window, cx));
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            if let Some(app) = meta
                .meeting
                .as_ref()
                .and_then(|m| m.app_name.clone())
                .filter(|name| !name.trim().is_empty())
            {
                parts.push(
                    self.meta_part("meta-app", app.into())
                        .cursor_default()
                        .into_any_element(),
                );
            }
        }
        let add_folder = folder.is_none().then(|| {
            style::icon_button(
                &palette,
                "meta-add-folder",
                "icons/folder-plus.svg",
                24.,
                tr::documents::note::add_folder(),
            )
            .tooltip(move |_, cx| {
                crate::ui::Tooltip::new(
                    &Theme::new(crate::theme::Appearance::Dark),
                    tr::documents::note::add_folder(),
                )
                .view(cx)
            })
            .on_click(cx.listener(|this, e: &gpui::ClickEvent, _, cx| {
                this.open_folder_menu(chip_anchor(e), cx)
            }))
        });
        if let Some(name) = folder {
            parts.push(
                self.meta_part("meta-folder", name.into())
                    .on_click(cx.listener(|this, e: &gpui::ClickEvent, _, cx| {
                        this.open_folder_menu(chip_anchor(e), cx)
                    }))
                    .into_any_element(),
            );
        }
        if meeting {
            parts.push(
                self.meta_part("meta-template", self.template_name(cx).into())
                    .on_click(cx.listener(|this, e: &gpui::ClickEvent, _, cx| {
                        this.open_template_menu(chip_anchor(e), cx)
                    }))
                    .into_any_element(),
            );
        }
        let count = parts.len();
        let mut chips = div().flex().flex_wrap().items_center().gap(px(8.));
        for (index, part) in parts.into_iter().enumerate() {
            chips = chips.child(part);
            if index + 1 < count {
                chips = chips.child(dot());
            }
        }
        chips = chips.children(add_folder);
        let consent = (meeting && self.consent.is_some()).then(|| {
            div()
                .text_size(px(12.5))
                .text_color(palette.faint)
                .child(tr::documents::panel::consent())
        });
        let switch = (meeting && self.shows_generated_tab(cx)).then(|| self.render_switch(cx));
        // In a narrow page the tabs move under the title so it keeps its room.
        let tabs_below = (width - pad * 2.).min(COLUMN_WIDTH) < 600.;
        let (switch, switch_below) = if tabs_below {
            (None, switch)
        } else {
            (switch, None)
        };
        // Everyone the transcript heard, as the same badges its lines carry;
        // a click renames or merges them.
        let people_row =
            meeting
                .then(|| self.transcript.read(cx).people())
                .filter(|people| !people.is_empty())
                .map(|people| {
                    div().flex().flex_wrap().gap(px(6.)).children(
                        people.into_iter().enumerate().map(|(i, (name, color))| {
                            let clicked = name.clone();
                            super::transcript::speaker_badge(
                                SharedString::from(format!("page-person-{i}")),
                                name,
                                None,
                                color,
                                false,
                                &palette,
                            )
                            .on_click(cx.listener(
                                move |this, e: &gpui::ClickEvent, window, cx| {
                                    if !this.page_mode {
                                        this.set_panel(true, cx);
                                    }
                                    let at = e.position();
                                    let name = clicked.clone();
                                    this.transcript
                                        .update(cx, |t, cx| t.rename_label(&name, at, window, cx));
                                },
                            ))
                        }),
                    )
                });
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(pad))
            .flex_shrink_0()
            .child(
                div()
                    .w_full()
                    .max_w(px(COLUMN_WIDTH))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .when(trashed, |el| {
                        el.child(
                            div()
                                .mb(px(4.))
                                .h(px(40.))
                                .pl(px(16.))
                                .pr(px(6.))
                                .flex()
                                .items_center()
                                .justify_between()
                                .rounded_full()
                                .border(px(1.5))
                                .border_color(palette.track)
                                .text_size(px(13.))
                                .text_color(palette.muted)
                                .child(tr::documents::header::in_trash())
                                .child(
                                    style::ink_pill(&palette, "trash-restore")
                                        .h(px(30.))
                                        .child(tr::documents::menu::restore())
                                        .on_click(cx.listener(|this, _, window, cx| {
                                            this.run(PaneAction::Restore, window, cx)
                                        })),
                                ),
                        )
                    })
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child({
                                let title = div().flex_1().min_w_0().child(
                                    TextInput::bare(&theme, "document-title", &self.title)
                                        .text_size(px(30.))
                                        .line_height(px(38.))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(palette.text)
                                        .placeholder_color(palette.faint)
                                        .height(px(40.)),
                                );
                                // The title Cap writes fades in once, when it
                                // arrives; every other render is static.
                                if self.title_landed > 0 && !style::reduce_motion() {
                                    title
                                        .with_animation(
                                            ("title-landed", self.title_landed),
                                            Animation::new(Duration::from_millis(320))
                                                .with_easing(ease_out_quint()),
                                            |el, t| el.opacity(0.15 + 0.85 * t),
                                        )
                                        .into_any_element()
                                } else {
                                    title.into_any_element()
                                }
                            })
                            .children(switch),
                    )
                    .children(switch_below.map(|s| div().flex().child(s)))
                    .child(chips)
                    .children(people_row)
                    .children(consent),
            )
            .into_any_element()
    }

    fn render_switch(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let generating = self.streaming;
        let first_tab = if self.shows_transcript(cx) {
            tr::documents::tabs::transcript()
        } else {
            tr::documents::tabs::notes()
        };
        let regen = self.view == View::Generated
            && !self.streaming
            && self.has_enhanced()
            && !self.is_trashed();
        let option = |id: &'static str, label: &'static str, view: View| {
            let selected = self.view == view;
            div()
                .id(id)
                .role(gpui::Role::Tab)
                .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                .aria_label(label)
                .aria_selected(selected)
                .h(px(28.))
                .flex()
                .items_center()
                .gap(px(6.))
                .border_b(px(1.5))
                .text_size(px(13.))
                .cursor_pointer()
                .when(selected, |el| {
                    el.border_color(palette.text)
                        .text_color(palette.text)
                        .font_weight(FontWeight::MEDIUM)
                })
                .when(!selected, |el| {
                    el.border_color(gpui::transparent_black())
                        .text_color(palette.muted)
                        .hover(move |s| s.text_color(palette.text))
                })
                .child(label)
                .on_click(cx.listener(move |this, _, window, cx| this.show_view(view, window, cx)))
        };
        div()
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(4.))
            .when(regen, |el| {
                el.child(
                    style::icon_button(
                        &palette,
                        "notes-regenerate",
                        "icons/rotate-ccw.svg",
                        30.,
                        tr::documents::notes::regenerate(),
                    )
                    .tooltip(move |_, cx| {
                        crate::ui::Tooltip::new(
                            &Theme::new(crate::theme::Appearance::Dark),
                            tr::documents::notes::regenerate(),
                        )
                        .view(cx)
                    })
                    .on_click(cx.listener(
                        |this, e: &gpui::ClickEvent, _, cx| {
                            let at = e.position();
                            this.popover =
                                Some(Popover::Regenerate(point(at.x - px(230.), at.y + px(16.))));
                            cx.notify();
                        },
                    )),
                )
            })
            .child(
                div()
                    .h(px(30.))
                    .ml(px(6.))
                    .flex()
                    .items_center()
                    .gap(px(18.))
                    .child(
                        option("switch-generated", first_tab, View::Generated)
                            .when(generating, |el| {
                                el.child(div().size(px(5.)).rounded_full().bg(palette.accent))
                            }),
                    )
                    .child(option(
                        "switch-mine",
                        tr::documents::tabs::my_notes(),
                        View::Mine,
                    )),
            )
            .into_any_element()
    }

    fn render_access_card(&self, width: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        let kind = self.card_for(cx)?;
        let pitch = self
            .doc
            .as_ref()
            .map(|meta| Pitch::from_meta(meta, None))
            .unwrap_or_default();
        let title = ai_note::card_title(kind, pitch.people());
        let pane = cx.weak_entity();
        let dismiss = cx.weak_entity();
        Some(in_column(
            width,
            ai_note::render_card(
                &self.palette,
                kind,
                title,
                self.writing_at,
                Box::new(move |_, _, cx| {
                    pane.update(cx, |p, cx| p.card_primary(kind, cx)).ok();
                }),
                Box::new(move |_, _, cx| {
                    dismiss.update(cx, |p, cx| p.dismiss_card(cx)).ok();
                }),
            ),
        ))
    }

    /// Everything Cap captured, read in place: the transcript under the card.
    fn render_inline_transcript(&self, width: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let tool = |id: &'static str, icon: &'static str, label: &'static str| {
            style::icon_button(&palette, id, icon, 28., label).tooltip(move |_, cx| {
                crate::ui::Tooltip::new(&Theme::new(crate::theme::Appearance::Dark), label).view(cx)
            })
        };
        div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .child(in_column(
                width,
                div()
                    .mt(px(18.))
                    .mb(px(2.))
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .text_color(palette.muted)
                            .child(tr::documents::transcript::captured()),
                    )
                    .child(
                        tool(
                            "inline-transcript-copy",
                            "icons/copy.svg",
                            tr::documents::menu::copy_transcript(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.run(PaneAction::CopyTranscript, window, cx)
                        })),
                    )
                    .child(
                        tool(
                            "inline-transcript-export",
                            "icons/download.svg",
                            tr::documents::menu::export(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.run(PaneAction::Export, window, cx)
                        })),
                    )
                    .into_any_element(),
            ))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .pb(px(DOCK_CLEARANCE))
                    .child(
                        self.transcript
                            .clone()
                            .cached(StyleRefinement::default().size_full()),
                    ),
            )
            .into_any_element()
    }

    fn render_generated_status(&self, width: f32, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = self.palette;
        let column = |child: AnyElement| in_column(width, child);
        if let Some(card) = self.render_access_card(width, cx) {
            return Some(card);
        }
        let error = self
            .gen_error
            .as_ref()
            .filter(|e| **e != NotesError::NothingToSummarize || !self.too_short)?;
        let action = notes_error_action(error, &palette);
        let retry = !matches!(
            error,
            NotesError::NotSignedIn | NotesError::UpgradeRequired | NotesError::NotConfigured
        );
        Some(column(
            div()
                .mt(px(14.))
                .min_h(px(36.))
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(10.))
                .text_size(px(13.5))
                .text_color(palette.muted)
                .child(
                    div()
                        .size(px(7.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(palette.warning),
                )
                .child(div().child(notes_error_text(error)))
                .children(action)
                .when(retry, |el| {
                    el.child(
                        style::quiet_pill(&palette, "notes-retry")
                            .h(px(28.))
                            .child(tr::documents::notes::retry())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.gen_error = None;
                                this.write_notes(None, cx)
                            })),
                    )
                })
                .into_any_element(),
        ))
    }

    fn render_panel(&self, height: f32, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        // An ended note's bar says it is saved; the microphone and language
        // only matter before and during a recording.
        let pickers = {
            let bar = self.bar.read(cx);
            bar.recording(cx) || !bar.has_transcript
        };
        let tool = |id: &'static str, icon: &'static str, label: &'static str| {
            style::icon_button(&palette, id, icon, 30., label).tooltip(move |_, cx| {
                crate::ui::Tooltip::new(&Theme::new(crate::theme::Appearance::Dark), label).view(cx)
            })
        };
        let picker = |id: &'static str, icon: &'static str, label: SharedString| {
            div()
                .id(id)
                .role(gpui::Role::Button)
                .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                .aria_label(label.clone())
                .h(px(32.))
                .px(px(10.))
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded_full()
                .cursor_pointer()
                .text_size(px(13.))
                .text_color(palette.muted)
                .hover(move |s| s.bg(palette.hover).text_color(palette.text))
                .child(svg().path(icon).size(px(14.)).text_color(palette.muted))
                .child(div().max_w(px(170.)).truncate().child(label))
                .child(
                    svg()
                        .path("icons/chevron-down.svg")
                        .size(px(12.))
                        .text_color(palette.faint),
                )
        };
        div()
            .id("transcript-panel")
            .occlude()
            .w_full()
            .h(px(height))
            .flex()
            .flex_col()
            .rounded(px(22.))
            .border(px(1.5))
            .border_color(palette.capsule_border)
            .bg(palette.capsule)
            .shadow(palette.shadow())
            .overflow_hidden()
            .child(
                div()
                    .h(px(46.))
                    .px(px(10.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .child(
                        tool(
                            "panel-find",
                            "icons/search.svg",
                            tr::documents::transcript::find(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.transcript.update(cx, |t, cx| t.open_find(window, cx))
                        })),
                    )
                    .child(div().flex_1())
                    .child(
                        tool(
                            "panel-copy",
                            "icons/copy.svg",
                            tr::documents::menu::copy_transcript(),
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.run(PaneAction::CopyTranscript, window, cx)
                        })),
                    )
                    .child(
                        tool(
                            "panel-hide",
                            "icons/minus.svg",
                            tr::documents::panel::hide(),
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.set_panel(false, cx))),
                    ),
            )
            .child(
                self.transcript
                    .clone()
                    .cached(StyleRefinement::default().flex_1().min_h_0().w_full()),
            )
            .child(
                div()
                    .h(px(60.))
                    .flex_shrink_0()
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .border_t(px(1.5))
                    .border_color(palette.hairline)
                    .child(self.bar.clone())
                    .when(pickers, |row| row.child(div().flex_1()))
                    .when(pickers, |row| {
                        row.child(
                            picker("panel-mic", "icons/microphone.svg", self.mic_label(cx))
                                .on_click(cx.listener(|this, e: &gpui::ClickEvent, _, cx| {
                                    let at = e.position();
                                    this.open_mic_menu(point(at.x - px(120.), at.y - px(12.)), cx)
                                })),
                        )
                        .child(
                            picker(
                                "panel-language",
                                "icons/languages.svg",
                                self.language_label(cx),
                            )
                            .on_click(cx.listener(
                                |this, e: &gpui::ClickEvent, _, cx| {
                                    let at = e.position();
                                    this.open_language_menu(
                                        point(at.x - px(120.), at.y - px(12.)),
                                        cx,
                                    )
                                },
                            )),
                        )
                    }),
            )
            .into_any_element()
    }

    fn render_ai_line(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = self.palette;
        if self.writing() {
            return None;
        }
        let pane = cx.weak_entity();
        if let Some(line) = super::bar::health_line::recovered(self.doc.as_ref(), &palette, move |cx| {
            pane.update(cx, |p, cx| {
                if let Some(doc) = p.doc.as_mut() {
                    super::bar::health_line::forget(doc);
                }
                cx.notify();
            })
            .ok();
        }) {
            return Some(line);
        }
        if self.too_short && !self.has_enhanced() {
            return Some(ai_note::dock_line(
                &palette,
                tr::cap_ai::card::too_short().into(),
                None,
                None,
            ));
        }
        if let Some(line) = self.live_line(cx) {
            let (text, action) = ai_note::live_line_text(line);
            let action = action.map(|label| {
                let pane = cx.weak_entity();
                let run: ai_note::Handler = Box::new(move |_, _, cx| {
                    pane.update(cx, |p, cx| p.live_line_action(line, cx)).ok();
                });
                (label, run)
            });
            let pane = cx.weak_entity();
            let dismiss: ai_note::Handler = Box::new(move |_, _, cx| {
                pane.update(cx, |p, cx| p.dismiss_live_line(cx)).ok();
            });
            return Some(ai_note::dock_line(
                &palette,
                text.into(),
                action,
                Some(dismiss),
            ));
        }
        None
    }

    fn live_line(&self, cx: &App) -> Option<ai_note::LiveLine> {
        let doc = self.doc.as_ref()?;
        ai_note::live_line(
            self.access,
            self.bar.read(cx).recording(cx),
            ai_note::live_line_dismissed(doc),
        )
    }

    fn live_line_action(&mut self, line: ai_note::LiveLine, cx: &mut Context<Self>) {
        match line {
            ai_note::LiveLine::SignIn => cx.defer(cap_ai::sign_in),
            ai_note::LiveLine::Upgrade => {
                let doc = self.doc_id();
                cx.defer(move |cx| cap_ai::open_upgrade(doc, Host::Documents, cx));
            }
            ai_note::LiveLine::Unavailable => {}
        }
    }

    /// The day, start and end of the open note, editable.
    fn render_when_editor(&self, meta: &DocMeta, cx: &mut Context<Self>) -> Option<AnyElement> {
        let edit = self.when_edit.as_ref()?;
        let palette = self.palette;
        let (start, _) = Self::when_span(meta);
        let pane = cx.weak_entity();
        let month_pane = pane.clone();
        let grid = when::month_grid(
            &palette,
            edit.month,
            start.date(),
            move |day, _, cx| {
                pane.update(cx, |this, cx| this.pick_when_day(day, cx)).ok();
            },
            move |by, _, cx| {
                month_pane
                    .update(cx, |this, cx| {
                        if let Some(edit) = this.when_edit.as_mut() {
                            edit.month = when::shift_month(edit.month, by);
                            cx.notify();
                        }
                    })
                    .ok();
            },
        );
        let field = |id: &'static str, label: &'static str, input: &Entity<TextInputState>| {
            div()
                .flex_1()
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .text_size(px(11.5))
                        .text_color(palette.faint)
                        .child(label),
                )
                .child(
                    div()
                        .h(px(30.))
                        .px(px(9.))
                        .flex()
                        .items_center()
                        .rounded(px(8.))
                        .bg(palette.field)
                        .child(
                            TextInput::bare(&input_theme(&palette), id, input)
                                .text_size(px(13.))
                                .text_color(palette.text)
                                .height(px(26.)),
                        ),
                )
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(grid)
                .child(
                    div()
                        .flex()
                        .gap(px(10.))
                        .child(field(
                            "when-start",
                            tr::documents::header::starts(),
                            &edit.start,
                        ))
                        .children(
                            edit.end
                                .as_ref()
                                .map(|end| field("when-end", tr::documents::header::ends(), end)),
                        ),
                )
                .into_any_element(),
        )
    }

    fn render_popover(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = self.palette;
        let popover = self.popover.as_ref()?;
        let meta = self.doc.as_ref()?;
        let dismiss = cx.listener(|this, _, _, cx| {
            this.popover = None;
            cx.notify();
        });
        let (at, body): (Point<Pixels>, AnyElement) = match popover {
            Popover::Event(at) => {
                let editor = self.render_when_editor(meta, cx);
                let Some(event) = meta.meeting.as_ref().and_then(|m| m.event.clone()) else {
                    return Some(menu::float(
                        *at,
                        menu::surface(&palette)
                            .id("event-popover")
                            .w(px(292.))
                            .p(px(14.))
                            .children(editor)
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                this.popover = None;
                                this.when_edit = None;
                                cx.notify();
                            }))
                            .into_any_element(),
                    ));
                };
                let calendar = Meetings::try_global(cx)
                    .and_then(|m| m.read(cx).find_event(&event.id).cloned());
                let web_url = calendar.as_ref().and_then(|e| e.web_url.clone());
                let link = event.link.clone().or_else(|| {
                    calendar
                        .as_ref()
                        .and_then(|e| e.link.as_ref().map(|l| l.url.clone()))
                });
                let when = match (event.start, event.end) {
                    (Some(start), Some(end)) => format!(
                        "{} · {}–{}",
                        format::short_date(format::local(start).date(), Local::now().date_naive()),
                        format::clock(format::local(start)),
                        format::clock(format::local(end))
                    ),
                    _ => String::new(),
                };
                let button = |id: &'static str, label: &'static str, primary: bool| {
                    div()
                        .id(id)
                        .role(gpui::Role::Button)
                        .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                        .aria_label(label)
                        .h(px(26.))
                        .px(px(11.))
                        .flex()
                        .items_center()
                        .rounded_full()
                        .text_size(px(12.))
                        .font_weight(FontWeight::MEDIUM)
                        .cursor_pointer()
                        .when(primary, |el| el.bg(palette.text).text_color(palette.on_ink))
                        .when(!primary, |el| el.bg(palette.field).text_color(palette.text))
                        .child(label)
                };
                (
                    *at,
                    menu::surface(&palette)
                        .id("event-popover")
                        .w(px(292.))
                        .p(px(14.))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(
                            div()
                                .text_size(px(14.))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(event.title.clone()),
                        )
                        .when(!when.is_empty(), |el| {
                            el.child(
                                div()
                                    .text_size(px(12.5))
                                    .text_color(palette.muted)
                                    .child(when),
                            )
                        })
                        .children(event.calendar_name.clone().map(|name| {
                            div()
                                .text_size(px(12.5))
                                .text_color(palette.muted)
                                .child(name)
                        }))
                        .child(
                            div()
                                .mt(px(6.))
                                .flex()
                                .gap(px(6.))
                                .children(link.map(|url| {
                                    button("event-join", tr::documents::sidebar::join(), true)
                                        .on_click(move |_, _, cx| commands::open_link(&url, cx))
                                }))
                                .children(web_url.map(|url| {
                                    button(
                                        "event-open",
                                        tr::documents::header::open_in_calendar(),
                                        false,
                                    )
                                    .on_click(move |_, _, cx| commands::open_link(&url, cx))
                                })),
                        )
                        .when(editor.is_some(), |el| {
                            el.child(div().my(px(8.)).h(px(1.)).bg(palette.hairline))
                        })
                        .children(editor)
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.popover = None;
                            this.when_edit = None;
                            cx.notify();
                        }))
                        .into_any_element(),
                )
            }
            Popover::Participants(at) => {
                let manual: Vec<String> = meta
                    .meeting
                    .as_ref()
                    .map(|m| m.participants.clone())
                    .unwrap_or_default();
                let attendees = meta
                    .meeting
                    .as_ref()
                    .and_then(|m| m.event.as_ref())
                    .map(|e| e.attendees.clone())
                    .unwrap_or_default();
                let mut rows: Vec<AnyElement> = Vec::new();
                for attendee in attendees.iter().filter(|a| !a.is_self) {
                    let name = attendee.name.clone().filter(|n| !n.trim().is_empty());
                    let email = attendee.email.clone();
                    rows.push(
                        div()
                            .flex()
                            .flex_col()
                            .py(px(4.))
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .child(name.clone().or(email.clone()).unwrap_or_default()),
                            )
                            .when(name.is_some() && email.is_some(), |el| {
                                el.child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(palette.muted)
                                        .child(email.clone().unwrap_or_default()),
                                )
                            })
                            .into_any_element(),
                    );
                }
                for (i, person) in manual.iter().enumerate() {
                    if attendees.iter().any(|a| {
                        a.email
                            .as_deref()
                            .is_some_and(|e| e.eq_ignore_ascii_case(person))
                            || a.name.as_deref() == Some(person.as_str())
                    }) {
                        continue;
                    }
                    let remove = person.clone();
                    rows.push(
                        div()
                            .py(px(4.))
                            .flex()
                            .items_center()
                            .justify_between()
                            .child(div().text_size(px(13.)).child(person.clone()))
                            .child(
                                div()
                                    .id(("participant-remove", i))
                                    .role(gpui::Role::Button)
                                    .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                                    .aria_label(tr::settings::cli::remove())
                                    .aria_description(person.clone())
                                    .size(px(20.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(5.))
                                    .cursor_pointer()
                                    .hover(move |s| s.bg(palette.hover))
                                    .child(
                                        svg()
                                            .path("icons/x.svg")
                                            .size(px(11.))
                                            .text_color(palette.muted),
                                    )
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.remove_participant(remove.clone(), cx)
                                    })),
                            )
                            .into_any_element(),
                    );
                }
                if rows.is_empty() {
                    rows.push(
                        div()
                            .py(px(4.))
                            .text_size(px(13.))
                            .text_color(palette.muted)
                            .child(tr::documents::header::no_people())
                            .into_any_element(),
                    );
                }
                (
                    *at,
                    menu::surface(&palette)
                        .id("participants-popover")
                        .w(px(280.))
                        .p(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            div()
                                .id("participants-list")
                                .max_h(px(220.))
                                .overflow_y_scroll()
                                .flex()
                                .flex_col()
                                .children(rows),
                        )
                        .child(
                            div()
                                .mt(px(6.))
                                .h(px(30.))
                                .px(px(9.))
                                .flex()
                                .items_center()
                                .rounded(px(8.))
                                .bg(palette.field)
                                .child(
                                    TextInput::bare(
                                        &input_theme(&palette),
                                        "participant-input",
                                        &self.participant_input,
                                    )
                                    .text_size(px(13.))
                                    .text_color(palette.text)
                                    .placeholder_color(palette.faint)
                                    .height(px(26.)),
                                ),
                        )
                        .on_mouse_down_out(dismiss)
                        .into_any_element(),
                )
            }
            Popover::Regenerate(at) => {
                let current = self.current_template_id(cx);
                let templates = templates::templates_for(&self.templates, &DocKind::Meeting);
                let item = |id: SharedString, label: SharedString, checked: bool| {
                    div()
                        .id(id)
                        .role(gpui::Role::MenuItemCheckBox)
                        .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                        .aria_label(label.clone())
                        .aria_toggled(if checked {
                            gpui::Toggled::True
                        } else {
                            gpui::Toggled::False
                        })
                        .h(px(28.))
                        .px(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .rounded(px(6.))
                        .cursor_pointer()
                        .hover(move |s| s.bg(palette.accent_soft))
                        .child(div().w(px(14.)).when(checked, |el| {
                            el.child(
                                svg()
                                    .path("icons/check.svg")
                                    .size(px(12.))
                                    .text_color(palette.text),
                            )
                        }))
                        .child(div().flex_1().truncate().child(label))
                };
                let mut body = menu::surface(&palette)
                    .id("regenerate-popover")
                    .w(px(260.))
                    .p(px(5.))
                    .flex()
                    .flex_col()
                    .child(
                        item(
                            "regen-now".into(),
                            tr::documents::notes::regenerate().into(),
                            false,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.run(PaneAction::Regenerate, window, cx)
                        })),
                    )
                    .child(
                        div()
                            .h(px(9.))
                            .flex()
                            .items_center()
                            .px(px(8.))
                            .child(div().h(px(1.)).w_full().bg(palette.hairline)),
                    )
                    .child(
                        div()
                            .h(px(24.))
                            .px(px(8.))
                            .flex()
                            .items_center()
                            .text_size(px(12.))
                            .text_color(palette.muted)
                            .child(tr::documents::notes::with_template()),
                    );
                for template in templates {
                    let id = template.id.clone();
                    body = body.child(
                        item(
                            SharedString::from(format!("regen-{}", template.id)),
                            format::template_name(&template).into(),
                            template.id == current,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.run(PaneAction::RegenerateWith(id.clone()), window, cx)
                            },
                        )),
                    );
                }
                body = body
                    .child(
                        div()
                            .h(px(9.))
                            .flex()
                            .items_center()
                            .px(px(8.))
                            .child(div().h(px(1.)).w_full().bg(palette.hairline)),
                    )
                    .child(
                        div()
                            .m(px(3.))
                            .h(px(30.))
                            .px(px(9.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .rounded(px(8.))
                            .bg(palette.field)
                            .child(
                                TextInput::bare(
                                    &input_theme(&palette),
                                    "regen-instruction",
                                    &self.instruction_input,
                                )
                                .text_size(px(13.))
                                .text_color(palette.text)
                                .placeholder_color(palette.faint)
                                .height(px(26.)),
                            )
                            .child(
                                svg()
                                    .path("icons/corner-down-left.svg")
                                    .size(px(12.))
                                    .text_color(palette.faint),
                            ),
                    )
                    .on_mouse_down_out(dismiss);
                (*at, body.text_size(px(13.)).into_any_element())
            }
        };
        Some(menu::float(at, body))
    }

    fn render_mentions(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let query = self.mention.as_ref()?.to_lowercase();
        let meta = self.doc.as_ref()?;
        let palette = self.palette;
        let candidates: Vec<String> = export::participants(meta)
            .into_iter()
            .filter(|p| query.is_empty() || p.to_lowercase().contains(&query))
            .take(6)
            .collect();
        if candidates.is_empty() {
            return None;
        }
        let caret = self.notes.read(cx).caret_bounds()?;
        let rows = candidates.into_iter().enumerate().map(|(i, name)| {
            let label = name.clone();
            div()
                .id(("mention", i))
                .role(gpui::Role::MenuItem)
                .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                .aria_label(label.clone())
                .h(px(28.))
                .px(px(8.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |s| s.bg(palette.accent_soft))
                .child(
                    svg()
                        .path("icons/users.svg")
                        .size(px(12.))
                        .text_color(palette.faint),
                )
                .child(name)
                .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
                .on_click(cx.listener(move |this, _, _, cx| this.insert_mention(label.clone(), cx)))
        });
        Some(menu::float(
            point(caret.left(), caret.bottom() + px(6.)),
            menu::surface(&palette)
                .id("mention-popover")
                .w(px(220.))
                .p(px(5.))
                .flex()
                .flex_col()
                .children(rows)
                .into_any_element(),
        ))
    }
}

/// How a summary may name a transcript label: exactly, and for a numbered
/// voice also "Speaker n", which summaries written before the prompt said
/// otherwise used for "Person n".
pub(super) fn summary_labels(label: &str) -> Vec<String> {
    let mut out = vec![label.to_string()];
    if let Some(n) = label.strip_prefix("Person ")
        && !n.is_empty()
        && n.chars().all(|c| c.is_ascii_digit())
    {
        out.push(format!("Speaker {n}"));
    }
    out
}

/// The streamed page and the saved one hold the same blocks: same kinds,
/// text, marks and who wrote them. Block ids may differ and do not count.
pub(super) fn same_page(a: &Document, b: &Document) -> bool {
    a.blocks.len() == b.blocks.len()
        && a.blocks.iter().zip(&b.blocks).all(|(x, y)| {
            x.kind == y.kind
                && x.text == y.text
                && x.indent == y.indent
                && x.origin == y.origin
                && x.spans == y.spans
                && x.start == y.start
                && x.attrs == y.attrs
        })
}

/// Ask's capsule, with its suggestions and answers above it. It blocks the
/// mouse for the page beneath, scrolling included (its answers scroll), so a
/// click on the field focuses the field and never the notes under it.
pub(super) fn dock_ask() -> gpui::Stateful<Div> {
    div()
        .id("dock-ask")
        .debug_selector(|| "dock-ask".into())
        .occlude()
}

fn chip_anchor(event: &gpui::ClickEvent) -> Point<Pixels> {
    let at = event.position();
    point(at.x - px(16.), at.y + px(16.))
}

impl Render for Pane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.palette.keyboard = crate::ui::keyboard_nav::active(window, cx);
        let palette = self.palette;
        let viewport = window.viewport_size();
        let viewport_w = f32::from(viewport.width);
        let viewport_h = f32::from(viewport.height);
        let full = if self.leading_inset {
            viewport_w
        } else {
            (viewport_w - SIDEBAR_SPAN).max(320.)
        };
        let closing_sheet = !self.ask_sheet && self.sheet_moved.is_some();
        let side_by_side = full - SHEET_WIDTH - SHEET_GAP * 2. >= SHEET_SIDE_BY_SIDE;
        let width = if self.ask_sheet && side_by_side {
            full - SHEET_WIDTH - SHEET_GAP
        } else {
            full
        };
        self.page_width = width;
        let pad = column_padding(width);
        let panel_w = (width - pad * 2.).min(720.);
        let menu = self.menu.as_ref().map(|open| {
            let pick = cx.entity();
            let dismiss = cx.entity();
            let panel = menu::panel(
                &palette,
                open.id,
                &open.entries,
                200.,
                Rc::new(move |action: &PaneAction, window, cx| {
                    let action = action.clone();
                    pick.update(cx, |this, cx| this.run(action, window, cx));
                }),
                Rc::new(move |_, cx| {
                    dismiss.update(cx, |this, cx| {
                        this.menu = None;
                        cx.notify();
                    });
                }),
            );
            if matches!(open.id, "documents-mic-menu" | "documents-language-menu") {
                menu::float_above(open.position, panel)
            } else {
                menu::float(open.position, panel)
            }
        });
        let Some(meta) = self.doc.clone() else {
            return div()
                .size_full()
                .bg(palette.content)
                .children(menu)
                .into_any_element();
        };
        let meeting = meta.kind == DocKind::Meeting;
        let view = if meeting { self.view } else { View::Mine };
        let captured = meeting && self.shows_transcript(cx);
        let recording = self.bar.read(cx).recording(cx);
        let page_mode = meeting
            && view == View::Generated
            && !recording
            && !self.panel_open
            && !self.writing()
            && !self.streaming
            && self.transcript.read(cx).has_transcript();
        self.set_page_mode(page_mode, cx);
        let live_line = (recording && self.ask_sheet)
            .then(|| self.transcript.read(cx).latest(1).pop())
            .flatten()
            .map(|(label, color, text, _, _)| LiveLine { label, color, text });
        self.ask.update(cx, |a, cx| a.set_live(live_line, cx));
        let body: AnyElement = if page_mode {
            div()
                .flex_1()
                .min_h_0()
                .w_full()
                .child(self.transcript.clone())
                .into_any_element()
        } else {
            match view {
                View::Mine if captured => div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .flex_col()
                    .children(self.render_access_card(width, cx))
                    .child(
                        self.notes
                            .clone()
                            .cached(StyleRefinement::default().flex_1().min_h_0().w_full()),
                    )
                    .into_any_element(),
                View::Mine => self
                    .notes
                    .clone()
                    .cached(StyleRefinement::default().flex_1().min_h_0().w_full())
                    .into_any_element(),
                View::Generated => div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .flex()
                    .flex_col()
                    .children(self.render_generated_status(width, cx))
                    .when(captured && !self.panel_open, |el| {
                        el.child(self.render_inline_transcript(width, cx))
                    })
                    .when(
                        !captured
                            && (self.gen_error.is_none() || self.has_enhanced() || self.writing()),
                        |el| {
                            el.child(
                                self.enhanced
                                    .clone()
                                    .cached(StyleRefinement::default().flex_1().min_h_0().w_full()),
                            )
                        },
                    )
                    .into_any_element(),
            }
        };
        let inline = page_mode || (view == View::Generated && captured && !self.panel_open);
        self.transcript.update(cx, |t, cx| {
            t.set_width(if inline { width } else { panel_w }, cx);
            t.set_inline(inline, cx);
        });
        // Lines the dock stacks over its bar (the trial line, a banner) take
        // room of their own: the page fades out under them and its last line
        // can always scroll clear of them.
        let docked = !meta.is_trashed() && !self.panel_open;
        // Ask's answer opens above the bar in the same column: a line stacked
        // over it would be pushed up over the page, so it waits until the
        // answer closes.
        let answer_inline = self.ask_open && !self.ask_sheet && !closing_sheet;
        let ai_line = (docked && meeting && !answer_inline)
            .then(|| self.render_ai_line(cx))
            .flatten();
        let banner = (!meta.is_trashed())
            .then(|| self.bar.update(cx, |bar, cx| bar.banner(cx)))
            .flatten();
        // Ask's suggestions open above its field: they get the same room.
        let ask_room = if docked && meeting && !self.ask_sheet && !closing_sheet {
            self.ask.read(cx).chips_room()
        } else {
            0.
        };
        let stacked = ai_line.as_ref().map_or(0., |_| DOCK_LINE + DOCK_GAP)
            + banner
                .as_ref()
                .filter(|_| docked)
                .map_or(0., |_| self.banner_height.get() + DOCK_GAP)
            + ask_room;
        if page_mode {
            self.transcript
                .update(cx, |t, cx| t.set_tail(DOCK_CLEARANCE + 32. + stacked, cx));
        }
        let banner_height = self.banner_height.clone();
        let dock = (!meta.is_trashed()).then(|| {
            // Everything in the dock sits over the page's editor. GPUI hands a
            // click to every normal hitbox under the pointer, so without this
            // the editor beneath also takes the click (and the focus): a click
            // on Ask put the caret in the notes and typing edited them.
            let banner = banner.map(|b| {
                let probe = gpui::canvas(
                    move |bounds, window, _| {
                        let height = f32::from(bounds.size.height);
                        if (banner_height.replace(height) - height).abs() > 0.5 {
                            window.request_animation_frame();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full();
                div()
                    .relative()
                    .block_mouse_except_scroll()
                    .child(b)
                    .child(probe)
            });
            let inner = if self.panel_open {
                let height = (viewport_h * 0.58)
                    .max(280.)
                    .min(viewport_h - TOOLBAR_HEIGHT - 120.);
                div()
                    .w_full()
                    .max_w(px(720.))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children(banner)
                    .child(self.render_panel(height, cx))
            } else {
                div()
                    .w_full()
                    .max_w(px(DOCK_WIDTH))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .children(ai_line.map(|line| div().block_mouse_except_scroll().child(line)))
                    .children(banner)
                    .child(if meeting && ai_note::ask_visible(self.access) {
                        // With Ask in its sheet, the bar keeps its capsule
                        // and sits alone in the middle.
                        let ask_here = !self.ask_sheet && !closing_sheet;
                        // Two capsules in one row: the meeting's state on
                        // the left, sized to its content and never cut, and
                        // Ask taking the rest. Each capsule is drawn behind
                        // its own bottom row so Ask's suggestions and
                        // answers can open above it.
                        let shell = || {
                            div()
                                .absolute()
                                .bottom_0()
                                .left_0()
                                .right_0()
                                .h(px(46.))
                                .rounded_full()
                                .bg(palette.capsule)
                                .border(px(1.5))
                                .border_color(palette.capsule_border)
                                .shadow(palette.shadow())
                        };
                        div()
                            .w_full()
                            .flex()
                            .items_end()
                            .when(!ask_here, |el| el.justify_center())
                            .gap(px(8.))
                            .child(
                                div()
                                    .id("dock-state")
                                    .block_mouse_except_scroll()
                                    .relative()
                                    .flex_shrink_0()
                                    .px(px(6.))
                                    .child(shell())
                                    .child(self.bar.clone()),
                            )
                            .when(ask_here, |el| {
                                el.child(
                                    dock_ask()
                                        .relative()
                                        .flex_1()
                                        .min_w_0()
                                        .child(shell())
                                        .child(self.ask.clone()),
                                )
                            })
                    } else {
                        div().w_full().flex().justify_center().child(
                            div()
                                .id("dock-state")
                                .block_mouse_except_scroll()
                                .child(self.bar.clone()),
                        )
                    })
            };
            div()
                .absolute()
                .bottom(px(DOCK_BOTTOM))
                .left_0()
                .right_0()
                .px(px(pad))
                .flex()
                .justify_center()
                .child(inner)
        });
        let captions = (recording && !self.panel_open && !self.ask_sheet)
            .then(|| self.render_captions(width, cx))
            .flatten();
        let main = div()
            .h_full()
            .when(self.ask_sheet && side_by_side, |el| el.w(px(width)))
            .when(!(self.ask_sheet && side_by_side), |el| el.w_full())
            .relative()
            .flex()
            .flex_col()
            .when(!page_mode, |el| el.child(self.render_header(width, cx)))
            .child(body)
            .when(dock.is_some() && !self.panel_open, |el| {
                el.child(if stacked > 0. {
                    style::dock_backdrop(&palette, DOCK_BOTTOM + DOCK_BAR + stacked, 30.)
                } else {
                    style::dock_fade(&palette, 92.)
                })
            })
            .children(captions)
            .children(dock);
        let sheet = (self.ask_sheet || closing_sheet).then(|| self.render_sheet(full, cx));
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(palette.content)
            .child(self.render_toolbar(cx))
            .children(super::window::notice_bar(&self.root, &palette, cx))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .w_full()
                    .relative()
                    .flex()
                    .flex_row()
                    .child(main)
                    .children(sheet),
            )
            .children(menu)
            .children(self.render_popover(cx))
            .children(self.render_mentions(cx))
            .into_any_element()
    }
}

#[cfg(debug_assertions)]
impl Pane {
    pub fn debug_loaded(&self, id: &str) -> bool {
        self.loaded_id.as_deref() == Some(id)
    }

    pub fn debug_doc_menu(&mut self, cx: &mut Context<Self>) {
        self.open_doc_menu(point(px(900.), px(48.)), cx);
    }

    pub fn debug_popover(&mut self, kind: &str, cx: &mut Context<Self>) {
        let at = point(px(420.), px(150.));
        self.popover = match kind {
            "participants" => Some(Popover::Participants(at)),
            "event" => Some(Popover::Event(at)),
            "regenerate" => Some(Popover::Regenerate(point(px(640.), px(150.)))),
            _ => None,
        };
        cx.notify();
    }

    pub fn debug_error(&mut self, kind: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.gen_error = Some(match kind {
            "sign_in" => NotesError::NotSignedIn,
            "upgrade" => NotesError::UpgradeRequired,
            "rate" => NotesError::RateLimited {
                retry_after_secs: 240,
            },
            "offline" => NotesError::Offline("offline".into()),
            "config" => NotesError::NotConfigured,
            "nothing" => NotesError::NothingToSummarize,
            _ => NotesError::Failed("failed".into()),
        });
        self.show_view(View::Generated, window, cx);
        self.sync_bar(cx);
        cx.notify();
    }

    pub fn debug_stream(&mut self, cx: &mut Context<Self>) {
        self.streaming = true;
        self.writing_at = Instant::now();
        self.generation = Some(Task::ready(Ok(())));
        self.stream_offset = 0;
        self.debug_stream_text.clear();
        self.view = View::Generated;
        self.enhanced_save.suppress += 1;
        self.enhanced
            .update(cx, |e, cx| e.set_document(Document::new(), cx));
        self.sync_bar(cx);
        cx.notify();
    }

    pub fn debug_stream_step(&mut self, cx: &mut Context<Self>) {
        const TEXT: &str = "### Summary\n\nThe team agreed to ship the smaller onboarding flow first and measure activation before adding the import step.\n\n### Decisions\n\n- Keep one plan for teams\n- Move the launch video to the week after release\n\n### Action items\n\n- [ ] Ana: share the final designs by Thursday\n- [ ] Ben: follow up with legal about the contract\n";
        let next = (self.debug_stream_text.len() + 34).min(TEXT.len());
        let mut end = next;
        while !TEXT.is_char_boundary(end) {
            end += 1;
        }
        self.debug_stream_text = TEXT[..end].to_string();
        let text = self.debug_stream_text.clone();
        self.append_stream(&text, cx);
        cx.notify();
    }

    pub fn debug_ai_refresh(&mut self, cx: &mut Context<Self>) {
        self.access = AiAccess::Unavailable;
        self.trial_remaining = Some(u32::MAX);
        self.refresh_access(cx);
        if self.card_for(cx).is_some() {
            self.view = View::Generated;
        }
        self.sync_bar(cx);
        cx.notify();
    }

    pub fn debug_ask_locked(&mut self, focus: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.ask
            .update(cx, |a, cx| a.debug_locked(focus, window, cx));
    }

    pub fn debug_too_short(&mut self, cx: &mut Context<Self>) {
        self.too_short = true;
        self.view = View::Mine;
        cx.notify();
    }

    pub fn debug_when(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_when(point(px(330.), px(126.)), window, cx);
    }

    pub fn debug_ask(&mut self, cx: &mut Context<Self>) {
        self.ask.update(cx, |a, cx| a.debug_thread(cx));
        cx.notify();
    }

    pub fn debug_bar(&mut self, kind: &str, cx: &mut Context<Self>) {
        self.bar.update(cx, |b, cx| b.debug_active(kind, cx));
        if kind != "elsewhere" && kind != "resume" {
            self.view = View::Mine;
        }
        self.sync_bar(cx);
        cx.notify();
    }

    pub fn debug_close_sheet(&mut self, cx: &mut Context<Self>) {
        self.set_ask_sheet(false, cx);
    }

    pub fn debug_sheet(&mut self, cx: &mut Context<Self>) {
        // CAP_GPUI_ASK_DEMO="question|answer" puts a real exchange in it.
        let demo = std::env::var("CAP_GPUI_ASK_DEMO").ok();
        match demo.as_deref().and_then(|d| d.split_once('|')) {
            Some((q, a)) => self.ask.update(cx, |p, cx| p.debug_exchange(q, a, cx)),
            None => self.ask.update(cx, |a, cx| a.debug_thread(cx)),
        }
        self.set_ask_sheet(true, cx);
        self.link_answer(0, cx);
    }

    /// Light the summary's first linked point and its lines, as on hover.
    pub fn debug_lit(&mut self, reveal: bool, cx: &mut Context<Self>) {
        self.debug_lit_at(0, reveal, cx);
    }

    /// Light the summary's n-th linked point and its lines (None puts them
    /// out), revealing the lines when asked.
    pub fn debug_lit_at(&mut self, index: usize, reveal: bool, cx: &mut Context<Self>) {
        let Some(ids) = self.links.get(index).cloned() else {
            self.enhanced
                .update(cx, |e, cx| e.show_source_hover(None, cx));
            self.transcript.update(cx, |t, cx| t.light(&[], cx));
            return;
        };
        self.enhanced
            .update(cx, |e, cx| e.show_source_hover(Some(index), cx));
        if reveal {
            self.reveal_lines(ids, cx);
        } else {
            self.transcript.update(cx, |t, cx| t.light(&ids, cx));
        }
    }

    pub fn debug_live(&mut self, cx: &mut Context<Self>) {
        self.transcript.update(cx, |t, cx| t.debug_set_live(cx));
        self.show_consent(cx);
    }

    /// A live page following its newest line, as the listening cue shows it.
    pub fn debug_cue(&mut self, cx: &mut Context<Self>) {
        self.transcript.update(cx, |t, cx| {
            t.debug_set_live(cx);
            t.debug_follow(cx);
        });
    }

    pub fn debug_find(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.set_panel(true, cx);
        self.transcript
            .update(cx, |t, cx| t.debug_find(query, window, cx));
    }

    pub fn debug_select_turns(&mut self, cx: &mut Context<Self>) {
        self.transcript.update(cx, |t, cx| t.debug_select(cx));
    }

    pub fn debug_menu(&mut self, which: &str, cx: &mut Context<Self>) {
        let at = point(px(700.), px(640.));
        match which {
            "mic" => self.open_mic_menu(at, cx),
            _ => self.open_language_menu(at, cx),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaveAction {
    Keep,
    Delete,
    Trash,
}

/// What happens to a note when the person moves away from it. Nothing is
/// ever thrown away that holds a title, a word, a transcript or written
/// notes, and nothing while it is still recording.
pub fn leave_action(
    meeting: bool,
    titled: bool,
    body_empty: bool,
    heard_or_written: bool,
    recording: bool,
) -> LeaveAction {
    if recording || !body_empty || heard_or_written {
        return LeaveAction::Keep;
    }
    match (meeting, titled) {
        (false, false) => LeaveAction::Delete,
        (false, true) => LeaveAction::Keep,
        // A meeting note's title is usually the meeting's own; one that
        // heard nothing is a false start either way, kept in Trash.
        (true, _) => LeaveAction::Trash,
    }
}

/// Notes write themselves after Stop when Cap AI can write them, automatic
/// notes are on, the note has none yet and the meeting said enough.
pub fn notes_follow_stop(
    access: AiAccess,
    auto_generate: bool,
    has_notes: bool,
    long_enough: bool,
) -> bool {
    access.writes_notes() && auto_generate && !has_notes && long_enough
}

/// The page's header (title, details, speakers) as a view of its own. The
/// page draws it cached, so typing in the summary below leaves it alone; it
/// is drawn afresh when it changes: a key in the title (the field notifies
/// the view that drew it), or anything on the pane.
pub(super) struct HeaderView {
    pane: WeakEntity<Pane>,
    /// Set by any change, cleared when the page next draws it afresh.
    stale: Cell<bool>,
    width: Cell<f32>,
    /// The height the page drew it at when cached (zero when drawn afresh),
    /// and the height it last measured itself; when they differ the next
    /// frame draws it afresh.
    known: Rc<Cell<Pixels>>,
    measured: Rc<Cell<Pixels>>,
    #[cfg(test)]
    pub(super) renders: usize,
    _subscriptions: [Subscription; 2],
}

impl HeaderView {
    fn new(pane: Entity<Pane>, cx: &mut Context<Self>) -> Self {
        let on_pane = cx.observe(&pane, |this: &mut Self, _, cx| {
            this.stale.set(true);
            cx.notify();
        });
        let on_self = cx.observe_self(|this: &mut Self, _| this.stale.set(true));
        Self {
            pane: pane.downgrade(),
            stale: Cell::new(true),
            width: Cell::new(0.),
            known: Rc::new(Cell::new(px(0.))),
            measured: Rc::new(Cell::new(px(0.))),
            #[cfg(test)]
            renders: 0,
            _subscriptions: [on_pane, on_self],
        }
    }
}

impl Render for HeaderView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(test)]
        {
            self.renders += 1;
        }
        let header = self
            .pane
            .update(cx, |pane, cx| {
                let width = pane.page_width;
                pane.render_header(width, cx)
            })
            .ok();
        let (known, measured) = (self.known.clone(), self.measured.clone());
        // Measures the header's own height even when the page lays the view
        // out at its last one; a mismatch asks for a fresh draw next frame.
        let probe = gpui::canvas(
            move |bounds, window, _| {
                let height = bounds.size.height;
                measured.set(height);
                let fixed = known.get();
                if fixed > px(0.) && height != fixed {
                    window.request_animation_frame();
                }
            },
            |_, _, _, _| {},
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full();
        div().w_full().flex().flex_col().child(
            div()
                .w_full()
                .relative()
                .children(header)
                .child(probe),
        )
    }
}

/// A saved payload as a page: `Ok(None)` when there is none, `Err` when it
/// exists but cannot be read or understood (it must then be kept, not saved
/// over).
fn parse_payload(payload: Result<Option<String>, String>) -> Result<Option<Document>, String> {
    match payload? {
        None => Ok(None),
        Some(json) => Document::from_json(&json)
            .map(Some)
            .map_err(|e| format!("unreadable page: {e}")),
    }
}

