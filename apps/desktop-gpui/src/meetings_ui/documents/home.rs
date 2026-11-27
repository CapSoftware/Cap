use std::{ops::Range, rc::Rc, time::Duration, time::Instant};

use cap_meetings::library::{DocKind, DocMeta, SearchField, SearchHit, SearchOptions};
use chrono::{Datelike, Local, NaiveDate, Utc};
use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, FontWeight,
    HighlightStyle, InteractiveElement, IntoElement, ListAlignment, ListState, MouseButton,
    MouseDownEvent, ParentElement, Pixels, Point, Render, SharedString, StatefulInteractiveElement,
    Styled, StyledText, Subscription, Task, WeakEntity, Window, div, prelude::FluentBuilder, px,
    svg,
};

use super::start::{StartButton, StartEvent, StartSize};
use super::{
    SEARCH_CONTEXT, SearchNext, SearchPrevious, commands, doodles, export, format,
    menu::{self, Entry, OpenMenu},
    store::{self, DocStore, Row, Scope, StoreEvent},
    style::{self, COLUMN_WIDTH, DOCK_WIDTH, Palette, TOOLBAR_HEIGHT, column_padding},
    window::DocumentsWindow,
};
use crate::{
    i18n::tr,
    meetings::{CalendarEvent, MeetingEvent, Meetings},
    theme::Theme,
    ui::{TextInput, TextInputEvent, TextInputState},
};

const SEARCH_DEBOUNCE: Duration = Duration::from_millis(140);
const IMMINENT_MINUTES: i64 = 5;
const MAX_EVENTS: usize = 3;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HomeEvent {
    FocusTitle,
    FocusDocument,
    StartEvent(String),
    NewFolderWith(Vec<String>),
    /// The start button: record now, or a blank note.
    Start(super::start::StartChoice),
}

#[derive(Clone, Debug, PartialEq)]
enum Action {
    Pin(bool),
    Rename,
    MoveTo(Option<String>),
    NewFolderWith,
    Duplicate,
    CopyNotes,
    CopyTranscript,
    Export,
    Trash,
    Restore,
    DeleteForever,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Calendar {
    Off,
    NotConnected,
    Connected,
}

pub struct Home {
    store: Entity<DocStore>,
    root: WeakEntity<DocumentsWindow>,
    palette: Palette,
    list: ListState,
    rows: Rc<Vec<Row>>,
    pub scope: Scope,
    events: Rc<Vec<CalendarEvent>>,
    calendar: Calendar,
    live_doc: Option<String>,
    search: Entity<TextInputState>,
    query: String,
    hits: Rc<Vec<SearchHit>>,
    search_task: Option<Task<()>>,
    search_cursor: usize,
    /// Searches whose hits have landed, for the dev bench.
    #[cfg(debug_assertions)]
    searches_landed: u64,
    menu: Option<OpenMenu<Action>>,
    menu_target: Vec<String>,
    list_focus: FocusHandle,
    tick: Option<Task<()>>,
    today: NaiveDate,
    width: f32,
    shown_at: Instant,
    start: Entity<StartButton>,
    start_hero: Entity<StartButton>,
    #[cfg(debug_assertions)]
    debug_events: Option<(Calendar, Vec<CalendarEvent>)>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<HomeEvent> for Home {}

impl Home {
    pub fn new(
        store: Entity<DocStore>,
        root: WeakEntity<DocumentsWindow>,
        theme: &Theme,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::documents::home::search());
            input
        });
        let mut subscriptions = vec![
            cx.subscribe(&store, |this, _, event: &StoreEvent, cx| match event {
                StoreEvent::Listed | StoreEvent::MetaChanged(_) | StoreEvent::Created(_) => {
                    this.rebuild(cx)
                }
                StoreEvent::Opened(None) => {
                    this.shown_at = Instant::now();
                    cx.notify()
                }
                StoreEvent::Opened(_) => cx.notify(),
            }),
            cx.subscribe_in(
                &search,
                window,
                |this, _, event: &TextInputEvent, window, cx| match event {
                    TextInputEvent::Changed => this.query_changed(cx),
                    TextInputEvent::Confirmed => this.open_search_cursor(window, cx),
                    TextInputEvent::Cancelled => this.clear_search(window, cx),
                    TextInputEvent::Blurred => {}
                },
            ),
        ];
        let start = cx.new(|cx| StartButton::new("home-start", StartSize::Toolbar, theme, cx));
        let start_hero =
            cx.new(|cx| StartButton::new("home-start-hero", StartSize::Hero, theme, cx));
        for button in [&start, &start_hero] {
            subscriptions.push(cx.subscribe(button, |_, _, event: &StartEvent, cx| {
                let StartEvent::Start(choice) = *event;
                cx.emit(HomeEvent::Start(choice));
            }));
        }
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(
                cx.subscribe(&meetings, |this, _, event: &MeetingEvent, cx| match event {
                    MeetingEvent::CalendarChanged | MeetingEvent::SettingsChanged => {
                        this.rebuild(cx)
                    }
                    MeetingEvent::RecordingStarted { .. }
                    | MeetingEvent::RecordingStopped { .. }
                    | MeetingEvent::ActiveChanged => this.sync_live(cx),
                    _ => {}
                }),
            );
        }
        let mut this = Self {
            store,
            root,
            palette: Palette::new(theme),
            list: ListState::new(0, ListAlignment::Top, px(600.)),
            rows: Rc::new(Vec::new()),
            scope: Scope::All,
            events: Rc::new(Vec::new()),
            calendar: Calendar::Off,
            live_doc: None,
            search,
            query: String::new(),
            hits: Rc::new(Vec::new()),
            search_task: None,
            search_cursor: 0,
            #[cfg(debug_assertions)]
            searches_landed: 0,
            menu: None,
            menu_target: Vec::new(),
            list_focus: cx.focus_handle(),
            tick: None,
            today: Local::now().date_naive(),
            width: 800.,
            shown_at: Instant::now(),
            start,
            start_hero,
            #[cfg(debug_assertions)]
            debug_events: None,
            _subscriptions: subscriptions,
        };
        this.sync_live(cx);
        this.rebuild(cx);
        this
    }

    pub fn set_theme(&mut self, theme: &Theme, cx: &mut Context<Self>) {
        self.palette = Palette::new(theme);
        for button in [&self.start, &self.start_hero] {
            button.update(cx, |b, cx| b.set_theme(theme, cx));
        }
        self.list.remeasure();
        cx.notify();
    }

    fn sync_live(&mut self, cx: &mut Context<Self>) {
        let live =
            Meetings::try_global(cx).and_then(|m| m.read(cx).active().map(|a| a.doc_id.clone()));
        if live != self.live_doc {
            self.live_doc = live;
            self.list.remeasure();
            cx.notify();
        }
    }

    fn load_events(&mut self, cx: &mut Context<Self>) {
        #[cfg(debug_assertions)]
        if let Some((calendar, events)) = self.debug_events.clone() {
            self.calendar = calendar;
            self.events = Rc::new(events);
            return;
        }
        let Some(meetings) = Meetings::try_global(cx) else {
            self.calendar = Calendar::Off;
            self.events = Rc::new(Vec::new());
            return;
        };
        let m = meetings.read(cx);
        self.calendar = if !m.settings().enabled || !m.settings().setup_completed {
            Calendar::Off
        } else if m.calendar_sources().is_empty() {
            Calendar::NotConnected
        } else {
            Calendar::Connected
        };
        if self.calendar != Calendar::Connected {
            self.events = Rc::new(Vec::new());
            return;
        }
        let now = Utc::now();
        let tomorrow_end = Local::now()
            .date_naive()
            .succ_opt()
            .and_then(|d| d.succ_opt())
            .and_then(|d| d.and_hms_opt(0, 0, 0))
            .and_then(|d| d.and_local_timezone(Local).single())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or(now + chrono::Duration::days(2));
        let events = m
            .upcoming_events(now, tomorrow_end - now)
            .into_iter()
            .filter(|e| !e.all_day && !e.is_cancelled() && !e.is_declined())
            .take(MAX_EVENTS)
            .collect();
        self.events = Rc::new(events);
    }

    pub fn rebuild(&mut self, cx: &mut Context<Self>) {
        self.today = Local::now().date_naive();
        self.load_events(cx);
        let rows = if !self.query.trim().is_empty() {
            let mut rows = vec![Row::Head];
            if self.hits.is_empty() {
                rows.push(Row::Empty);
            } else {
                rows.extend((0..self.hits.len()).map(Row::Hit));
            }
            rows.push(Row::Foot);
            rows
        } else {
            let store = self.store.read(cx);
            if let Scope::Folder(id) = &self.scope
                && !store.snapshot.folders.iter().any(|f| &f.id == id)
            {
                self.scope = Scope::All;
            }
            store::build_rows(&store.snapshot, &self.scope, self.today, &store::local_day)
        };
        if *self.rows != rows {
            let top = self.list.logical_scroll_top();
            let same_len = self.rows.len() == rows.len();
            self.rows = Rc::new(rows);
            if same_len {
                self.list.remeasure();
            } else {
                self.list.reset(self.rows.len());
                self.list.scroll_to(top);
            }
        } else {
            self.list.remeasure_items(0..1);
        }
        self.arm_tick(cx);
        cx.notify();
    }

    fn arm_tick(&mut self, cx: &mut Context<Self>) {
        let now = Utc::now();
        let midnight = self
            .today
            .succ_opt()
            .and_then(|d| d.and_hms_opt(0, 0, 5))
            .and_then(|d| d.and_local_timezone(Local).single())
            .map(|d| d.with_timezone(&Utc));
        let boundaries = self.events.iter().flat_map(|e| {
            [
                e.start - chrono::Duration::minutes(IMMINENT_MINUTES),
                e.start,
                e.end,
            ]
        });
        let next = midnight
            .into_iter()
            .chain(boundaries)
            .filter(|at| *at > now)
            .min();
        let Some(next) = next else {
            self.tick = None;
            return;
        };
        let delay = (next - now)
            .to_std()
            .unwrap_or(Duration::from_secs(60))
            .max(Duration::from_secs(1));
        self.tick = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            this.update(cx, |this, cx| this.rebuild(cx)).ok();
        }));
    }

    pub fn set_scope(&mut self, scope: Scope, window: &mut Window, cx: &mut Context<Self>) {
        if !self.query.is_empty() {
            self.search.update(cx, |search, cx| search.set_text("", cx));
            self.query.clear();
            self.hits = Rc::new(Vec::new());
            self.search_task = None;
        }
        if self.scope != scope {
            self.scope = scope;
            self.shown_at = Instant::now();
            self.list.reset(0);
            self.rows = Rc::new(Vec::new());
        }
        self.rebuild(cx);
        self.list.scroll_to(gpui::ListOffset::default());
        window.focus(&self.list_focus, cx);
    }

    pub fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search
            .update(cx, |search, cx| search.focus_and_select_all(window, cx));
    }

    pub fn focus_handle(&self) -> FocusHandle {
        self.list_focus.clone()
    }

    pub fn new_plain_note(&mut self, cx: &mut Context<Self>) {
        let folder = match &self.scope {
            Scope::Folder(id) => Some(id.clone()),
            _ => None,
        };
        self.store
            .update(cx, |store, cx| store.create(DocKind::Note, folder, cx));
        cx.emit(HomeEvent::FocusTitle);
    }

    pub fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.menu.take().is_some() {
            cx.notify();
            return true;
        }
        if self.start.update(cx, |b, cx| b.dismiss(cx))
            || self.start_hero.update(cx, |b, cx| b.dismiss(cx))
        {
            return true;
        }
        if !self.query.is_empty() {
            self.clear_search(window, cx);
            return true;
        }
        let had = !self.store.read(cx).selection.is_empty();
        if had {
            self.store.update(cx, |store, cx| {
                store.selection.clear();
                cx.notify();
            });
            cx.notify();
        }
        had
    }

    fn clear_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |search, cx| search.set_text("", cx));
        self.query.clear();
        self.hits = Rc::new(Vec::new());
        self.search_task = None;
        self.rebuild(cx);
        window.focus(&self.list_focus, cx);
    }

    fn query_changed(&mut self, cx: &mut Context<Self>) {
        let query = self.search.read(cx).text().to_string();
        if query == self.query {
            return;
        }
        self.query = query.clone();
        self.search_cursor = 0;
        if query.trim().is_empty() {
            self.search_task = None;
            self.hits = Rc::new(Vec::new());
            self.rebuild(cx);
            return;
        }
        let Some(library) = self.store.read(cx).library().cloned() else {
            return;
        };
        self.search_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(SEARCH_DEBOUNCE).await;
            let started = Instant::now();
            let needle = query.clone();
            let hits = cx
                .background_executor()
                .spawn(async move {
                    library
                        .search(
                            &needle,
                            &SearchOptions {
                                limit: 60,
                                ..SearchOptions::default()
                            },
                        )
                        .unwrap_or_default()
                })
                .await;
            tracing::info!(
                hits = hits.len(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "documents search"
            );
            this.update(cx, |this, cx| {
                if this.query != query {
                    return;
                }
                this.hits = Rc::new(hits);
                #[cfg(debug_assertions)]
                {
                    this.searches_landed += 1;
                }
                this.search_cursor = 0;
                this.rebuild(cx);
            })
            .ok();
        }));
    }

    fn step_search(&mut self, delta: isize, cx: &mut Context<Self>) {
        if self.hits.is_empty() {
            return;
        }
        let len = self.hits.len() as isize;
        self.search_cursor = (self.search_cursor as isize + delta).rem_euclid(len) as usize;
        self.list.scroll_to_reveal_item(self.search_cursor + 1);
        cx.notify();
    }

    fn open_search_cursor(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(hit) = self.hits.get(self.search_cursor) {
            let id = hit.id.clone();
            self.store.update(cx, |store, cx| store.open(Some(id), cx));
            cx.emit(HomeEvent::FocusDocument);
        }
    }

    fn click_doc(&mut self, id: String, event: &gpui::ClickEvent, cx: &mut Context<Self>) {
        let modifiers = event.modifiers();
        let rows = self.rows.clone();
        let order: Vec<String> = {
            let store = self.store.read(cx);
            rows.iter()
                .filter_map(|row| match row {
                    Row::Doc(i) => store.snapshot.docs.get(*i).map(|d| d.id.clone()),
                    Row::Trashed(i) => store.snapshot.trashed.get(*i).map(|d| d.id.clone()),
                    _ => None,
                })
                .collect()
        };
        let mut opened = false;
        self.store.update(cx, |store, cx| {
            if modifiers.shift {
                let anchor = store.selection_anchor.clone().unwrap_or_else(|| id.clone());
                let a = order.iter().position(|x| *x == anchor);
                let b = order.iter().position(|x| *x == id);
                if let (Some(a), Some(b)) = (a, b) {
                    let range = a.min(b)..=a.max(b);
                    store.selection = order[range].iter().cloned().collect();
                }
                cx.notify();
            } else if modifiers.secondary() {
                if !store.selection.remove(&id) {
                    store.selection.insert(id.clone());
                }
                store.selection_anchor = Some(id.clone());
                cx.notify();
            } else {
                store.open(Some(id), cx);
                opened = true;
            }
        });
        if opened {
            cx.emit(HomeEvent::FocusDocument);
        }
        self.list.remeasure();
        cx.notify();
    }

    fn open_row_menu(&mut self, id: String, position: Point<Pixels>, cx: &mut Context<Self>) {
        let store = self.store.read(cx);
        let ids = store.ids_for_action(&id);
        let Some(meta) = store.get(&id).cloned() else {
            return;
        };
        let multiple = ids.len() > 1;
        let mut entries = Vec::new();
        if meta.is_trashed() {
            entries.push(Entry::new(tr::documents::menu::restore(), Action::Restore));
            entries.push(
                Entry::new(tr::documents::menu::delete_forever(), Action::DeleteForever).danger(),
            );
        } else {
            let live = self
                .live_doc
                .as_deref()
                .is_some_and(|l| ids.iter().any(|i| i == l));
            entries.push(if meta.pinned {
                Entry::new(tr::documents::menu::unpin(), Action::Pin(false))
            } else {
                Entry::new(tr::documents::menu::pin(), Action::Pin(true))
            });
            if !multiple {
                entries.push(Entry::new(tr::documents::menu::rename(), Action::Rename));
            }
            entries.push(Entry::separator());
            entries.push(Entry::disabled(tr::documents::menu::move_to()));
            entries.push(
                Entry::new(tr::documents::menu::no_folder(), Action::MoveTo(None))
                    .checked(!multiple && meta.folder_id.is_none()),
            );
            for folder in &store.snapshot.folders {
                entries.push(
                    Entry::new(folder.name.clone(), Action::MoveTo(Some(folder.id.clone())))
                        .checked(!multiple && meta.folder_id.as_ref() == Some(&folder.id)),
                );
            }
            entries.push(Entry::new(
                tr::documents::menu::new_folder_with(),
                Action::NewFolderWith,
            ));
            if !multiple {
                entries.push(Entry::separator());
                if meta.kind == DocKind::Note {
                    entries.push(Entry::new(
                        tr::documents::menu::duplicate(),
                        Action::Duplicate,
                    ));
                }
                entries.push(Entry::new(
                    tr::documents::menu::copy_notes(),
                    Action::CopyNotes,
                ));
                if meta.kind == DocKind::Meeting {
                    entries.push(Entry::new(
                        tr::documents::menu::copy_transcript(),
                        Action::CopyTranscript,
                    ));
                }
                entries.push(Entry::new(tr::documents::menu::export(), Action::Export));
            }
            entries.push(Entry::separator());
            entries.push(if live {
                Entry::disabled(tr::documents::menu::trash())
            } else {
                Entry::new(tr::documents::menu::trash(), Action::Trash).danger()
            });
        }
        self.menu_target = ids;
        self.menu = Some(OpenMenu {
            id: "documents-row-menu",
            position,
            entries,
        });
        cx.notify();
    }

    fn run(&mut self, action: Action, window: &mut Window, cx: &mut Context<Self>) {
        self.menu = None;
        let ids = std::mem::take(&mut self.menu_target);
        let first = ids.first().cloned();
        let root = self.root.clone();
        match action {
            Action::Pin(pinned) => self
                .store
                .update(cx, |store, cx| store.set_pinned(ids, pinned, cx)),
            Action::Rename => {
                if let Some(id) = first {
                    self.store.update(cx, |store, cx| store.open(Some(id), cx));
                    cx.emit(HomeEvent::FocusTitle);
                }
            }
            Action::MoveTo(folder) => self
                .store
                .update(cx, |store, cx| store.move_to_folder(ids, folder, cx)),
            Action::NewFolderWith => cx.emit(HomeEvent::NewFolderWith(ids)),
            Action::Duplicate => {
                if let Some(id) = first {
                    self.store.update(cx, |store, cx| store.duplicate(&id, cx));
                }
            }
            Action::CopyNotes => {
                if let Some(id) = first {
                    commands::copy_notes(&self.store, &id, root, cx);
                }
            }
            Action::CopyTranscript => {
                if let Some(id) = first {
                    commands::copy_transcript(&self.store, &id, root, cx);
                }
            }
            Action::Export => {
                if let Some(id) = first {
                    commands::export_markdown(&self.store, &id, root, window, cx);
                }
            }
            Action::Trash => self.trash(ids, cx),
            Action::Restore => self.store.update(cx, |store, cx| store.restore(ids, cx)),
            Action::DeleteForever => self.confirm_delete(ids, window, cx),
        }
        cx.notify();
    }

    fn trash(&mut self, ids: Vec<String>, cx: &mut Context<Self>) {
        let count = ids.len();
        let restore = ids.clone();
        self.store.update(cx, |store, cx| store.trash(ids, cx));
        let store = self.store.downgrade();
        let undo: super::window::ToastAction = Rc::new(move |_, cx| {
            let restore = restore.clone();
            store
                .update(cx, |store, cx| store.restore(restore, cx))
                .ok();
        });
        self.root
            .update(cx, |root, cx| {
                root.show_toast(
                    tr::documents::toast::moved_to_trash(count),
                    Some((tr::documents::toast::undo().into(), undo)),
                    None,
                    cx,
                )
            })
            .ok();
    }

    fn confirm_delete(&mut self, ids: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &tr::documents::confirm::delete_forever(ids.len()),
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
                store.update(cx, |store, cx| store.delete_permanently(ids, cx));
            }
        })
        .detach();
    }

    fn confirm_empty_trash(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let count = self.store.read(cx).snapshot.trashed.len();
        if count == 0 {
            return;
        }
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &tr::documents::confirm::empty_trash(count),
            Some(tr::documents::confirm::cannot_undo()),
            &[
                gpui::PromptButton::ok(tr::documents::confirm::empty()),
                gpui::PromptButton::cancel(tr::common::cancel()),
            ],
            cx,
        );
        let store = self.store.clone();
        cx.spawn(async move |_, cx| {
            if answer.await.ok() == Some(0) {
                store.update(cx, |store, cx| store.empty_trash(cx));
            }
        })
        .detach();
    }

    fn start_event(&mut self, event: &CalendarEvent, join: bool, cx: &mut Context<Self>) {
        if join && let Some(link) = event.link.as_ref() {
            commands::open_link(&link.url, cx);
        }
        cx.emit(HomeEvent::StartEvent(crate::meetings::calendar::event_key(
            event,
        )));
    }
}

pub(super) fn char_ranges_ci(text: &str, needle: &str) -> Vec<Range<usize>> {
    let needle: Vec<char> = needle.trim().chars().flat_map(char::to_lowercase).collect();
    if needle.is_empty() {
        return Vec::new();
    }
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let lowered: Vec<char> = chars
        .iter()
        .map(|(_, c)| c.to_lowercase().next().unwrap_or(*c))
        .collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= lowered.len() {
        if lowered[i..i + needle.len()] == needle[..] {
            let start = chars[i].0;
            let end = chars
                .get(i + needle.len())
                .map(|(b, _)| *b)
                .unwrap_or(text.len());
            out.push(start..end);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

pub fn emphasised(text: SharedString, query: &str, palette: &Palette) -> StyledText {
    let ranges = char_ranges_ci(&text, query);
    let style = HighlightStyle {
        color: Some(palette.text),
        font_weight: Some(FontWeight::SEMIBOLD),
        background_color: Some(palette.highlight),
        ..HighlightStyle::default()
    };
    StyledText::new(text).with_highlights(ranges.into_iter().map(move |r| (r, style)))
}

pub fn people_line(meta: &DocMeta) -> Option<String> {
    let meeting = meta.meeting.as_ref()?;
    let people = export::participants(meta);
    if !people.is_empty() {
        let mut names = people
            .iter()
            .take(2)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        if people.len() > 2 {
            names.push_str(&format!(" +{}", people.len() - 2));
        }
        return Some(names);
    }
    if let Some(app) = meeting.app_name.as_deref().filter(|a| !a.trim().is_empty()) {
        return Some(app.to_string());
    }
    // No call app and no names: the voices the transcript heard.
    meeting
        .speaker_count()
        .filter(|count| *count > 1)
        .map(|count| tr::documents::home::people(count as usize).to_string())
}

impl Home {
    fn column(&self, child: impl IntoElement) -> gpui::Div {
        let pad = column_padding(self.width);
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(pad))
            .child(div().w_full().max_w(px(COLUMN_WIDTH)).child(child))
    }

    fn render_row(&self, index: usize, entity: &Entity<Self>, cx: &App) -> AnyElement {
        let Some(row) = self.rows.get(index) else {
            return div().into_any_element();
        };
        let palette = self.palette;
        let store = self.store.read(cx);
        match row {
            Row::Head => self.render_head(entity, cx),
            Row::Header(label) => self
                .column(
                    div()
                        .pt(px(22.))
                        .pb(px(4.))
                        .px(px(10.))
                        .text_size(px(12.5))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(palette.muted)
                        .child(label.clone()),
                )
                .into_any_element(),
            Row::Empty => self.render_empty(),
            Row::Foot => self.render_foot(entity, cx),
            Row::Doc(i) => match store.snapshot.docs.get(*i) {
                Some(meta) => self.render_doc(meta, entity, store),
                None => div().into_any_element(),
            },
            Row::Trashed(i) => match store.snapshot.trashed.get(*i) {
                Some(meta) => self.render_doc(meta, entity, store),
                None => div().into_any_element(),
            },
            Row::Hit(i) => match self.hits.get(*i) {
                Some(hit) => self.render_hit(*i, hit, entity),
                None => div().into_any_element(),
            },
        }
    }

    /// The end of home. With the sidebar usually hidden, Trash lives here,
    /// quietly, once something is in it.
    fn render_foot(&self, entity: &Entity<Self>, cx: &App) -> AnyElement {
        let trashed = self.store.read(cx).snapshot.trashed.len();
        let show = self.scope == Scope::All && self.query.trim().is_empty() && trashed > 0;
        let entity = entity.clone();
        self.column(div().h(px(96.)).pt(px(12.)).when(show, |el| {
            el.child(
                style::quiet_pill(&self.palette, "home-trash")
                    .child(tr::documents::home::trash_count(trashed))
                    .on_click(move |_, window, cx| {
                        entity.update(cx, |this, cx| this.set_scope(Scope::Trash, window, cx))
                    }),
            )
        }))
        .into_any_element()
    }

    fn render_head(&self, entity: &Entity<Self>, cx: &App) -> AnyElement {
        let palette = self.palette;
        if !self.query.trim().is_empty() {
            let line = if self.hits.is_empty() {
                String::new()
            } else {
                tr::documents::home::results(self.hits.len())
            };
            return self
                .column(
                    div()
                        .pt(px(8.))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .child(style::heading(
                            &palette,
                            tr::documents::home::search_title(),
                            self.shown_at,
                        ))
                        .child(
                            div()
                                .text_size(px(14.))
                                .text_color(palette.muted)
                                .child(line),
                        ),
                )
                .into_any_element();
        }
        let store = self.store.read(cx);
        let (title, trash): (SharedString, bool) = match &self.scope {
            Scope::All => {
                // Now (while recording), then Coming up when a calendar is
                // connected, then every note by day below.
                let now_card = self.render_now(store, entity);
                let calendars = self.calendar == Calendar::Connected;
                return self
                    .column(
                        div()
                            .pt(px(8.))
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .children(now_card)
                            .child(style::heading(
                                &palette,
                                if calendars {
                                    tr::documents::sidebar::coming_up()
                                } else {
                                    tr::documents::home::notes()
                                },
                                self.shown_at,
                            ))
                            .when(calendars, |el| el.child(self.render_coming_up(entity))),
                    )
                    .into_any_element();
            }
            Scope::Pinned => (tr::documents::sidebar::pinned().into(), false),
            Scope::Folder(id) => (
                store.folder_name(id).unwrap_or("").to_string().into(),
                false,
            ),
            Scope::Trash => (tr::documents::sidebar::trash().into(), true),
        };
        let count = store.snapshot.trashed.len();
        let empty_entity = entity.clone();
        self.column(
            div()
                .pt(px(8.))
                .flex()
                .items_start()
                .justify_between()
                .child(style::heading(&palette, title, self.shown_at))
                .when(trash && count > 0, |el| {
                    el.child(
                        style::quiet_pill(&palette, "documents-empty-trash")
                            .mt(px(2.))
                            .text_color(palette.danger)
                            .child(tr::documents::sidebar::empty_trash())
                            .on_click(move |_, window, cx| {
                                empty_entity
                                    .update(cx, |this, cx| this.confirm_empty_trash(window, cx))
                            }),
                    )
                }),
        )
        .into_any_element()
    }

    /// The note being recorded, on top of home so it is one click away.
    fn render_now(&self, store: &DocStore, entity: &Entity<Self>) -> Option<AnyElement> {
        let palette = self.palette;
        let id = self.live_doc.clone()?;
        let meta = store.get(&id)?;
        let title = if meta.title.trim().is_empty() {
            tr::documents::untitled().to_string()
        } else {
            meta.title.clone()
        };
        let entity = entity.clone();
        Some(
            palette
                .paper_card()
                .id("home-now")
                .cursor_pointer()
                .px(px(16.))
                .py(px(12.))
                .flex()
                .items_center()
                .gap(px(10.))
                .child(div().size(px(8.)).rounded_full().bg(palette.live))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(palette.text)
                        .child(title),
                )
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(palette.muted)
                        .child(tr::documents::home::recording_now()),
                )
                .on_click(move |_, _, cx| {
                    let id = id.clone();
                    entity.update(cx, |this, cx| {
                        this.store.update(cx, |store, cx| store.open(Some(id), cx))
                    });
                })
                .into_any_element(),
        )
    }

    fn render_coming_up(&self, entity: &Entity<Self>) -> AnyElement {
        let palette = self.palette;
        let today = Local::now();
        let date = div()
            .w(px(104.))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .text_size(px(34.))
                    .line_height(px(38.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(palette.text)
                    .child(today.day().to_string()),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(palette.text)
                    .child(format::month_short(today.month()))
                    .child(div().size(px(5.)).rounded_full().bg(palette.danger)),
            )
            .child(
                div()
                    .text_size(px(13.))
                    .text_color(palette.muted)
                    .child(format::weekday_short(today.date_naive())),
            );
        let body: AnyElement = if self.events.is_empty() {
            let (line, button): (&'static str, Option<(&'static str, bool)>) = match self.calendar {
                Calendar::Off => (
                    tr::documents::home::meeting_mode_off(),
                    Some((tr::documents::bar::set_up(), true)),
                ),
                Calendar::NotConnected => (
                    tr::documents::home::no_calendar(),
                    Some((tr::documents::home::calendar_settings(), false)),
                ),
                Calendar::Connected => (tr::documents::home::no_events(), None),
            };
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(16.))
                .child(style::art(
                    &doodles::CALENDAR,
                    palette.doodle(),
                    self.shown_at,
                    64.,
                    56.,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .items_start()
                        .gap(px(10.))
                        .child(
                            div()
                                .text_size(px(14.))
                                .line_height(px(20.))
                                .text_color(palette.muted)
                                .child(line),
                        )
                        .children(button.map(|(label, setup)| {
                            style::quiet_pill(&palette, "coming-up-settings")
                                .child(label)
                                .on_click(move |_, _, cx| {
                                    if setup {
                                        cx.defer(crate::meetings_ui::setup::open);
                                    } else {
                                        cx.defer(crate::meetings_ui::settings::open);
                                    }
                                })
                        })),
                )
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .flex_col()
                .gap(px(2.))
                .children(
                    self.events
                        .iter()
                        .map(|event| self.render_event(event, entity)),
                )
                .into_any_element()
        };
        palette
            .paper_card()
            .w_full()
            .p(px(20.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(date)
            .child(div().w(px(1.5)).self_stretch().bg(palette.track))
            .child(div().pl(px(8.)).flex_1().min_w_0().flex().child(body))
            .into_any_element()
    }

    fn render_event(&self, event: &CalendarEvent, entity: &Entity<Self>) -> AnyElement {
        let palette = self.palette;
        let now = Utc::now();
        let imminent =
            event.start - chrono::Duration::minutes(IMMINENT_MINUTES) <= now && event.end > now;
        let start = format::local(event.start);
        let when = if event.start <= now {
            tr::documents::sidebar::now().to_string()
        } else if start.date() != self.today {
            format!(
                "{} {}",
                format::short_date(start.date(), self.today),
                format::clock(start)
            )
        } else {
            format::clock(start)
        };
        let provider = event
            .link
            .as_ref()
            .map(|l| l.provider.display_name().to_string());
        let recording = self.live_doc.is_some();
        let has_link = event.link.is_some();
        let join_entity = entity.clone();
        let start_entity = entity.clone();
        let join_event = event.clone();
        let start_event = event.clone();
        div()
            .id(SharedString::from(format!("event-{}", event.id)))
            .w_full()
            .min_h(px(40.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .w(px(3.))
                    .h(px(28.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(if imminent {
                        palette.accent
                    } else {
                        palette.track
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.text)
                            .child(event.title.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.5))
                            .text_color(if imminent {
                                palette.accent
                            } else {
                                palette.muted
                            })
                            .child(match provider {
                                Some(p) => format!("{when} · {p}"),
                                None => when,
                            }),
                    ),
            )
            .when(imminent && !recording, |el| {
                el.when(has_link, |el| {
                    el.child(
                        style::quiet_pill(
                            &palette,
                            SharedString::from(format!("join-{}", event.id)),
                        )
                        .child(tr::documents::sidebar::join())
                        .on_click(move |_, _, cx| {
                            let event = join_event.clone();
                            join_entity.update(cx, |this, cx| this.start_event(&event, true, cx));
                        }),
                    )
                })
                .child(
                    style::ink_pill(&palette, SharedString::from(format!("start-{}", event.id)))
                        .h(px(30.))
                        .px(px(14.))
                        .child(tr::documents::sidebar::start())
                        .on_click(move |_, _, cx| {
                            let event = start_event.clone();
                            start_entity.update(cx, |this, cx| this.start_event(&event, false, cx));
                        }),
                )
            })
            .into_any_element()
    }

    fn render_empty(&self) -> AnyElement {
        let palette = self.palette;
        let (title, body, new): (&'static str, Option<&'static str>, bool) =
            if !self.query.trim().is_empty() {
                (tr::documents::sidebar::no_results(), None, false)
            } else {
                match &self.scope {
                    Scope::All => (
                        tr::documents::home::empty_title(),
                        Some(tr::documents::home::empty_body()),
                        true,
                    ),
                    Scope::Trash => (tr::documents::sidebar::trash_empty(), None, false),
                    _ => (tr::documents::sidebar::folder_empty(), None, false),
                }
            };
        if !new {
            return self
                .column(
                    div()
                        .pt(px(24.))
                        .px(px(10.))
                        .text_size(px(14.))
                        .text_color(palette.muted)
                        .child(title),
                )
                .into_any_element();
        }
        self.column(
            div()
                .pt(px(28.))
                .flex()
                .flex_col()
                .items_center()
                .gap(px(10.))
                .child(style::art(
                    &doodles::PAGE,
                    palette.doodle(),
                    self.shown_at + Duration::from_millis(250),
                    112.,
                    96.,
                ))
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(17.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(palette.text)
                        .child(title),
                )
                .children(body.map(|body| {
                    div()
                        .max_w(px(380.))
                        .text_center()
                        .text_size(px(14.))
                        .line_height(px(21.))
                        .text_color(palette.muted)
                        .child(body)
                }))
                .child(div().mt(px(8.)).child(self.start_hero.clone())),
        )
        .into_any_element()
    }

    fn render_doc(&self, meta: &DocMeta, entity: &Entity<Self>, store: &DocStore) -> AnyElement {
        let palette = self.palette;
        let selected = store.selection.contains(&meta.id);
        let live = self.live_doc.as_deref() == Some(meta.id.as_str());
        let title = meta.title.trim();
        let (title, untitled): (SharedString, bool) = if title.is_empty() {
            (tr::documents::untitled().into(), true)
        } else {
            (title.to_string().into(), false)
        };
        let meeting = meta.kind == DocKind::Meeting;
        let line = people_line(meta).unwrap_or_else(|| {
            if meeting {
                tr::documents::home::just_you().to_string()
            } else {
                tr::documents::home::note().to_string()
            }
        });
        let start = format::local(meta.sort_time());
        let time = if matches!(self.scope, Scope::Trash) || self.scope == Scope::Pinned {
            format::short_date(start.date(), self.today)
        } else {
            format::clock(start)
        };
        let length = meta
            .meeting
            .as_ref()
            .filter(|m| m.duration_ms > 0)
            .map(|m| format::duration(m.duration_ms));
        let preview = meta
            .extra
            .get(super::pane::PREVIEW_KEY)
            .and_then(|v| v.as_str())
            .filter(|p| !p.is_empty())
            .map(|p| SharedString::from(p.to_string()));
        let line = [Some(time.clone()), length, Some(line)]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" \u{00b7} ");
        let id = meta.id.clone();
        let menu_id = meta.id.clone();
        let click_entity = entity.clone();
        let menu_entity = entity.clone();
        self.column(
            div()
                .id(SharedString::from(format!("doc-{}", meta.id)))
                .h(px(if preview.is_some() { 86. } else { 64. }))
                .px(px(12.))
                .flex()
                .items_center()
                .gap(px(14.))
                .rounded(px(10.))
                .cursor_pointer()
                .when(selected, |el| el.bg(palette.selected))
                .when(!selected, |el| el.hover(move |s| s.bg(palette.hover)))
                .on_click(move |event, _, cx| {
                    let id = id.clone();
                    click_entity.update(cx, |this, cx| this.click_doc(id, event, cx));
                })
                .on_mouse_down(MouseButton::Right, move |event: &MouseDownEvent, _, cx| {
                    let id = menu_id.clone();
                    let position = event.position;
                    menu_entity.update(cx, |this, cx| this.open_row_menu(id, position, cx));
                    cx.stop_propagation();
                })
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(3.))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(15.5))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(if untitled {
                                            palette.faint
                                        } else {
                                            palette.text
                                        })
                                        .child(title),
                                )
                                .when(meta.pinned && self.scope == Scope::All, |el| {
                                    el.child(
                                        svg()
                                            .path("icons/pin.svg")
                                            .size(px(11.))
                                            .flex_shrink_0()
                                            .text_color(palette.faint),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(12.5))
                                .text_color(palette.muted)
                                .child(line),
                        )
                        .children(preview.map(|preview| {
                            div()
                                .mt(px(1.))
                                .truncate()
                                .text_size(px(13.5))
                                .text_color(palette.muted)
                                .child(preview)
                        })),
                )
                .when(live, |el| {
                    el.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(4.))
                            .text_size(px(12.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.live)
                            .child(style::art(
                                &doodles::MARK_RECORDING,
                                palette.doodle(),
                                self.shown_at,
                                18.,
                                18.,
                            ))
                            .child(tr::documents::sidebar::recording()),
                    )
                }),
        )
        .into_any_element()
    }

    fn render_hit(&self, index: usize, hit: &SearchHit, entity: &Entity<Self>) -> AnyElement {
        let palette = self.palette;
        let cursor = index == self.search_cursor;
        let title = hit.title.trim();
        let title: SharedString = if title.is_empty() {
            tr::documents::untitled().into()
        } else {
            title.to_string().into()
        };
        let field = match hit.field {
            SearchField::Title => tr::documents::sidebar::in_title(),
            SearchField::Notes => tr::documents::sidebar::in_notes(),
            SearchField::Transcript => tr::documents::sidebar::in_transcript(),
        };
        let when = format::short_date(format::local(hit.sort_time).date(), self.today);
        let id = hit.id.clone();
        let click = entity.clone();
        let query = self.query.clone();
        self.column(
            div()
                .id(SharedString::from(format!("hit-{}", hit.id)))
                .px(px(10.))
                .py(px(10.))
                .rounded(px(12.))
                .cursor_pointer()
                .when(cursor, |el| el.bg(palette.selected))
                .when(!cursor, |el| el.hover(move |s| s.bg(palette.hover)))
                .flex()
                .flex_col()
                .gap(px(3.))
                .on_click(move |_, _, cx| {
                    let id = id.clone();
                    click.update(cx, |this, cx| {
                        this.store.update(cx, |store, cx| store.open(Some(id), cx));
                        cx.emit(HomeEvent::FocusDocument);
                    });
                })
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(14.5))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(palette.text)
                                .child(if hit.field == SearchField::Title {
                                    emphasised(title, &query, &palette).into_any_element()
                                } else {
                                    title.into_any_element()
                                }),
                        )
                        .child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(12.))
                                .text_color(palette.muted)
                                .child(format!("{field} · {when}")),
                        ),
                )
                .when(hit.field != SearchField::Title, |el| {
                    el.child(
                        div()
                            .text_size(px(13.))
                            .line_height(px(19.))
                            .text_color(palette.muted)
                            .max_h(px(38.))
                            .overflow_hidden()
                            .child(emphasised(hit.snippet.clone().into(), &query, &palette)),
                    )
                }),
        )
        .into_any_element()
    }

    fn render_search_bar(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let theme = Theme::new(if palette.dark {
            crate::theme::Appearance::Dark
        } else {
            crate::theme::Appearance::Light
        });
        let pad = column_padding(self.width);
        let searching = !self.query.is_empty();
        div()
            .absolute()
            .bottom(px(18.))
            .left_0()
            .right_0()
            .px(px(pad))
            .flex()
            .justify_center()
            .child(
                div()
                    .key_context(SEARCH_CONTEXT)
                    .on_action(cx.listener(|this, _: &SearchNext, _, cx| this.step_search(1, cx)))
                    .on_action(
                        cx.listener(|this, _: &SearchPrevious, _, cx| this.step_search(-1, cx)),
                    )
                    .w_full()
                    .max_w(px(DOCK_WIDTH))
                    .h(px(46.))
                    .pl(px(18.))
                    .pr(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .rounded_full()
                    .bg(palette.capsule)
                    .border(px(1.5))
                    .border_color(palette.capsule_border)
                    .shadow(palette.shadow())
                    .child(
                        svg()
                            .path("icons/search.svg")
                            .size(px(15.))
                            .text_color(palette.muted),
                    )
                    .child(
                        TextInput::bare(&theme, "documents-search", &self.search)
                            .text_size(px(14.))
                            .text_color(palette.text)
                            .placeholder_color(palette.muted)
                            .height(px(28.)),
                    )
                    .when(searching, |el| {
                        el.child(
                            style::icon_button(
                                &palette,
                                "documents-search-clear",
                                "icons/x.svg",
                                28.,
                            )
                            .on_click(
                                cx.listener(|this, _, window, cx| this.clear_search(window, cx)),
                            ),
                        )
                    }),
            )
            .into_any_element()
    }
}

impl Render for Home {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let sidebar_open = self
            .root
            .upgrade()
            .is_some_and(|root| root.read(cx).sidebar_open());
        let palette = self.palette;
        let entity = cx.entity();
        let width = f32::from(window.viewport_size().width);
        let sidebar = self
            .root
            .upgrade()
            .is_some_and(|root| root.read(cx).sidebar_open());
        let width = if sidebar {
            width - style::SIDEBAR_WIDTH - 1.
        } else {
            width
        };
        if (self.width - width).abs() > 0.5 {
            self.width = width;
            self.list.remeasure();
        }
        let selection = self.store.read(cx).selection.len();
        let list_entity = entity.clone();
        let menu = self.menu.as_ref().map(|open| {
            let pick_entity = entity.clone();
            let dismiss_entity = entity.clone();
            menu::float(
                open.position,
                menu::panel(
                    &palette,
                    open.id,
                    &open.entries,
                    200.,
                    Rc::new(move |action: &Action, window, cx| {
                        let action = action.clone();
                        pick_entity.update(cx, |this, cx| this.run(action, window, cx));
                    }),
                    Rc::new(move |_, cx| {
                        dismiss_entity.update(cx, |this, cx| {
                            this.menu = None;
                            cx.notify();
                        });
                    }),
                ),
            )
        });
        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .bg(palette.content)
            .child(
                div()
                    .id("home-toolbar")
                    .h(px(TOOLBAR_HEIGHT))
                    .flex_shrink_0()
                    .w_full()
                    .px(px(14.))
                    .flex()
                    .items_center()
                    .justify_end()
                    .gap(px(10.))
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move())
                    .when(selection > 1, |el| {
                        el.child(
                            div()
                                .text_size(px(13.))
                                .text_color(palette.accent)
                                .child(tr::documents::sidebar::selected(selection)),
                        )
                    })
                    // The sidebar carries the same button; the toolbar's is
                    // for when the sidebar is closed.
                    .when(!sidebar_open, |el| el.child(self.start.clone())),
            )
            .child(
                div()
                    .id("documents-list")
                    .track_focus(&self.list_focus)
                    .flex_1()
                    .min_h_0()
                    .child(
                        gpui::list(self.list.clone(), move |index, _, cx| {
                            list_entity.read(cx).render_row(index, &list_entity, cx)
                        })
                        .size_full(),
                    ),
            )
            .child(style::dock_fade(&palette, 96.))
            .child(self.render_search_bar(cx))
            .children(menu)
    }
}

#[cfg(debug_assertions)]
impl Home {
    pub fn debug_start_menu(&mut self, cx: &mut Context<Self>) {
        let at = gpui::point(px(self.width - 290.), px(52.));
        self.start.update(cx, |b, cx| b.debug_open_menu(at, cx));
    }

    pub fn debug_search(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_search(window, cx);
        let query = query.to_string();
        self.search.update(cx, |s, cx| s.set_text(query, cx));
        self.query_changed(cx);
    }

    pub fn debug_searches_landed(&self) -> u64 {
        self.searches_landed
    }

    pub fn debug_menu(&mut self, cx: &mut Context<Self>) {
        let id = self.rows.iter().find_map(|row| match row {
            Row::Doc(i) => self
                .store
                .read(cx)
                .snapshot
                .docs
                .get(*i)
                .map(|d| d.id.clone()),
            _ => None,
        });
        if let Some(id) = id {
            self.open_row_menu(id, gpui::point(px(520.), px(330.)), cx);
        }
    }

    pub fn debug_multi(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = self
            .rows
            .iter()
            .filter_map(|row| match row {
                Row::Doc(i) => self
                    .store
                    .read(cx)
                    .snapshot
                    .docs
                    .get(*i)
                    .map(|d| d.id.clone()),
                _ => None,
            })
            .skip(1)
            .take(3)
            .collect();
        self.store.update(cx, |store, cx| {
            store.selection = ids.into_iter().collect();
            cx.notify();
        });
        self.list.remeasure();
        cx.notify();
    }

    pub fn debug_scroll(&mut self, delta: f32, cx: &mut Context<Self>) {
        self.list.scroll_by(px(delta));
        cx.notify();
    }

    pub fn debug_events(&mut self, kind: &str, cx: &mut Context<Self>) {
        use cap_calendar::{EventStatus, Response, SourceKind};
        let now = Utc::now();
        let event =
            |i: usize, title: &str, start_min: i64, minutes: i64, link: bool| CalendarEvent {
                id: format!("debug-event-{i}"),
                series_id: None,
                calendar_id: "debug".into(),
                source: SourceKind::Ics,
                title: title.into(),
                start: now + chrono::Duration::minutes(start_min),
                end: now + chrono::Duration::minutes(start_min + minutes),
                all_day: false,
                location: None,
                description: None,
                organizer: None,
                attendees: Vec::new(),
                self_response: Response::Accepted,
                link: link
                    .then(|| {
                        cap_calendar::link::classify_url("https://meet.google.com/abc-defg-hij")
                    })
                    .flatten(),
                status: EventStatus::Confirmed,
                web_url: None,
                free: false,
            };
        self.debug_events = Some(match kind {
            "off" => (Calendar::Off, Vec::new()),
            "none" => (Calendar::NotConnected, Vec::new()),
            "empty" => (Calendar::Connected, Vec::new()),
            _ => (
                Calendar::Connected,
                vec![
                    event(0, "Design review: onboarding", 3, 30, true),
                    event(1, "1:1 with Kofi", 95, 30, true),
                    event(
                        2,
                        "Quarterly planning with the whole product team",
                        240,
                        60,
                        false,
                    ),
                ],
            ),
        });
        self.rebuild(cx);
    }
}
