//! The Library: everything Cap keeps on this computer in one window, with a
//! source-list sidebar, a home made of the latest things, and folders that
//! are either filled by hand or by rules.

#[doc(hidden)]
pub mod bench;
pub mod index;
pub mod items;
pub mod load;
pub mod people;
pub mod rules;
pub mod sidebar;
pub mod store;
pub mod style;
pub mod text;
pub mod thumbs;

use std::{collections::HashMap, path::PathBuf, rc::Rc, time::Instant};

use chrono::{Local, NaiveDate, Utc};
use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, FontWeight,
    Global, Hsla, InteractiveElement, IntoElement, ObjectFit, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, StyledImage as _, Subscription, Task, Window,
    WindowBackgroundAppearance, WindowBounds, WindowKind, WindowOptions, div, img,
    prelude::FluentBuilder, px, size, svg,
};

use self::items::{Item, ItemKind};
use self::load::Scan;
use self::rules::{
    Content, DateRange, EvalContext, IsOp, LengthOp, Matching, Rule, SmartFolder, TextOp,
};
use self::style::Palette;
use crate::{
    i18n::tr,
    meetings_ui::documents::format,
    platform,
    theme::{LocaleFont as _, Theme},
    ui::{TextInput, TextInputEvent, TextInputState},
};

pub const TITLE: &str = "Cap Library";

#[derive(Default)]
struct LibraryWindowSlot(Option<AnyWindowHandle>);
impl Global for LibraryWindowSlot {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    /// Edge-to-edge glass sidebar, a gallery home.
    Gallery,
    /// The page floats on the glass, a calm list home.
    Calm,
}

impl Direction {
    fn from_env() -> Self {
        match std::env::var("CAP_GPUI_LIBRARY_DIRECTION").as_deref() {
            Ok("b") | Ok("calm") => Self::Calm,
            _ => Self::Gallery,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KindView {
    Recordings,
    Screenshots,
    Notes,
}

impl KindView {
    fn holds(self, kind: ItemKind) -> bool {
        match self {
            Self::Recordings => kind == ItemKind::Recording,
            Self::Screenshots => kind == ItemKind::Screenshot,
            Self::Notes => kind.is_doc(),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Recordings => tr::library::recordings(),
            Self::Screenshots => tr::library::screenshots(),
            Self::Notes => tr::library::notes(),
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Recordings => "icons/video.svg",
            Self::Screenshots => "icons/screenshot.svg",
            Self::Notes => "icons/notebook.svg",
        }
    }

    fn tint(self) -> ItemKind {
        match self {
            Self::Recordings => ItemKind::Recording,
            Self::Screenshots => ItemKind::Screenshot,
            Self::Notes => ItemKind::Meeting,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Section {
    Home,
    Kind(KindView),
    Pinned,
    Folder(String),
    Smart(String),
    Trash,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layout {
    /// Magazine: big pictures, a lead story, a balanced grid.
    Grid,
    /// Calm rows grouped by day.
    List,
}

const LAYOUT_SECTION: &str = "libraryWindow";
const LAYOUT_KEY: &str = "layout";

impl Layout {
    fn slug(self) -> &'static str {
        match self {
            Self::Grid => "magazine",
            Self::List => "list",
        }
    }

    /// The person's saved choice; list until they pick, because a calm list
    /// is the least cluttered first view.
    fn saved() -> Self {
        let from_env = std::env::var("CAP_GPUI_LIBRARY_LAYOUT").ok();
        let saved = from_env.or_else(|| {
            crate::store::store_section(LAYOUT_SECTION)
                .get(LAYOUT_KEY)
                .and_then(|v| v.as_str().map(str::to_string))
        });
        match saved.as_deref() {
            Some("magazine") => Self::Grid,
            _ => Self::List,
        }
    }
}

struct UpNext {
    title: String,
    start: chrono::DateTime<Utc>,
    people: Vec<String>,
}

struct RuleRow {
    rule: Rule,
    value: Option<Entity<TextInputState>>,
}

struct RuleEditor {
    editing: Option<String>,
    name: Entity<TextInputState>,
    matching: Matching,
    rows: Vec<RuleRow>,
    count: usize,
    preview: Vec<u32>,
    /// Set while a save is being written; the sheet stays until it lands.
    saving: bool,
    /// Why the last save did not land, shown in the sheet.
    error: Option<SaveError>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SaveError {
    ReadOnly,
    Failed,
}

impl SaveError {
    fn from_update(error: &store::UpdateError) -> Self {
        match error {
            store::UpdateError::ReadOnly => Self::ReadOnly,
            store::UpdateError::Io(_) => Self::Failed,
        }
    }

    fn message(self) -> &'static str {
        match self {
            Self::ReadOnly => tr::library::save_read_only(),
            Self::Failed => tr::library::save_failed(),
        }
    }
}

/// The section to show once the smart folders changed: a smart folder that
/// is no longer in the file (deleted elsewhere, or a save that did not land)
/// falls back to Home instead of an empty page with no name.
pub(crate) fn section_after(section: &Section, file: &store::LibraryFile) -> Section {
    match section {
        Section::Smart(id) if !file.smart_folders.iter().any(|f| &f.id == id) => Section::Home,
        other => other.clone(),
    }
}

pub struct LibraryWindow {
    focus: FocusHandle,
    theme: Theme,
    palette: Palette,
    direction: Direction,
    section: Section,
    layout: Layout,
    scan: Rc<Scan>,
    file: store::LibraryFile,
    outcome: store::LoadOutcome,
    smart_members: HashMap<String, Vec<u32>>,
    membership: index::Membership,
    sidebar: Entity<sidebar::SidebarView>,
    counts: HashMap<Section, usize>,
    visible: Rc<Vec<u32>>,
    search: Entity<TextInputState>,
    query: String,
    editor: Option<RuleEditor>,
    up_next: Option<UpNext>,
    opened_at: Instant,
    first_paint: bool,
    load_task: Option<Task<()>>,
    dir: PathBuf,
    /// One scroll position per layout and kind of page, so switching layouts
    /// is instant and comes back to where each one was.
    home_scroll: [gpui::ScrollHandle; 2],
    reload_again: bool,
    last_scan: Option<Instant>,
    people_task: Option<Task<()>>,
    thumbs: thumbs::Thumbs,
    list_scroll: gpui::UniformListScrollHandle,
    grid_scroll: gpui::UniformListScrollHandle,
    _subscriptions: Vec<Subscription>,
}

/// The Experimental setting, or `CAP_GPUI_LIBRARY_WINDOW=1` for tests.
pub fn enabled() -> bool {
    std::env::var_os("CAP_GPUI_LIBRARY_WINDOW").is_some()
        || std::env::var_os("CAP_GPUI_LIBRARY_DIRECTION").is_some()
        || crate::store::GeneralSettings::load().library_window
}

pub fn open(cx: &mut App) {
    crate::app_windows::hide_main_for_meeting_window(cx);
    if let Some(handle) = cx.try_global::<LibraryWindowSlot>().and_then(|s| s.0)
        && handle
            .update(cx, |_, window, _| window.activate_window())
            .is_ok()
    {
        return;
    }
    open_new(cx);
}

/// `CAP_GPUI_AUTO_LIBRARY=home|recordings|screenshots|notes|smart|editor`:
/// open the library on that page, for the screenshot harness.
pub fn auto_open_from_env(cx: &mut App) {
    let Ok(page) = std::env::var("CAP_GPUI_AUTO_LIBRARY") else {
        return;
    };
    if let Some(kind) = page.strip_prefix("panel-") {
        // The header library panel as it is today, for before/after shots.
        use crate::main_window::{LibraryKind, Panel};
        let kind = match kind {
            "screenshots" => LibraryKind::Screenshots,
            "notes" => LibraryKind::Notes,
            _ => LibraryKind::Recordings,
        };
        crate::app_windows::show_main_window(cx);
        let main = cx.global::<crate::app_windows::AppWindows>().main;
        main.update(cx, |view, window, cx| {
            view.open_panel(Panel::Library(kind), window, cx)
        })
        .ok();
        return;
    }
    open(cx);
    let Some(handle) = cx.try_global::<LibraryWindowSlot>().and_then(|s| s.0) else {
        return;
    };
    handle
        .update(cx, move |root, window, cx| {
            if let Ok(view) = root.downcast::<LibraryWindow>() {
                view.update(cx, |view, cx| view.auto_page(&page, window, cx));
            }
        })
        .ok();
}

fn open_new(cx: &mut App) {
    let opened_at = Instant::now();
    let preferred = size(px(style::DEFAULT_WIDTH), px(style::DEFAULT_HEIGHT));
    let bounds = gpui::Bounds::centered(None, preferred, cx);
    let handle = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(gpui::TitlebarOptions {
                title: Some(TITLE.into()),
                appears_transparent: true,
                traffic_light_position: Some(crate::meetings_ui::documents::TRAFFIC_LIGHTS),
            }),
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: true,
            is_minimizable: true,
            window_min_size: Some(size(px(style::MIN_WIDTH), px(style::MIN_HEIGHT))),
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| LibraryWindow::new(opened_at, window, cx)),
    );
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("library window failed to open: {error:#}");
            return;
        }
    };
    cx.set_global(LibraryWindowSlot(Some(handle.into())));
    let native = handle
        .update(cx, |_, window, _| {
            platform::kick_display_link(window);
            platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            let kind = platform::install_window_material(native, style::MATERIAL_RADIUS);
            cx.update(|cx| {
                if platform::active_material(cx).is_none() {
                    cx.set_global(platform::WindowMaterial(kind));
                }
            });
        }
        handle
            .update(cx, |root, window, cx| {
                platform::kick_display_link(window);
                root.sync_theme(window, cx);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();
}

fn today() -> NaiveDate {
    Local::now().date_naive()
}

impl LibraryWindow {
    fn new(opened_at: Instant, window: &mut Window, cx: &mut Context<Self>) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, true);
        let palette = Palette::new(&theme);
        let search = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(tr::library::search());
            input
        });
        let dir = crate::store::app_data_dir();
        let loaded = store::load(&dir);
        let sidebar = cx.new(|_| {
            sidebar::SidebarView::new(sidebar::Model {
                rows: Vec::new(),
                selected: Section::Home,
                palette,
                background: None,
            })
        });
        let subscriptions = vec![
            cx.subscribe(&search, |this, input, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Changed) {
                    this.query = text::fold(input.read(cx).text());
                    this.refilter(cx);
                }
            }),
            cx.on_release(|_, cx| {
                cx.set_global(LibraryWindowSlot(None));
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                // Recordings and screenshots have no change events: look again
                // when the person comes back, unless we just did.
                if window.is_window_active()
                    && this
                        .last_scan
                        .is_some_and(|at| at.elapsed() > std::time::Duration::from_secs(2))
                {
                    this.reload(cx);
                }
            }),
        ];
        let mut subscriptions = subscriptions;
        subscriptions.push(cx.subscribe_in(
            &sidebar,
            window,
            |this, _, event: &sidebar::SidebarEvent, window, cx| match event {
                sidebar::SidebarEvent::Show(section) => this.show(section.clone(), cx),
                sidebar::SidebarEvent::NewSmartFolder => this.open_editor(None, window, cx),
            },
        ));
        if let Some(meetings) = crate::meetings::Meetings::try_global(cx) {
            subscriptions.push(cx.subscribe(
                &meetings,
                |this, _, event: &crate::meetings::MeetingEvent, cx| {
                    if matches!(
                        event,
                        crate::meetings::MeetingEvent::LibraryChanged
                            | crate::meetings::MeetingEvent::SpeakerRenamed { .. }
                    ) {
                        this.reload(cx);
                    }
                },
            ));
        }
        let mut this = Self {
            focus: cx.focus_handle(),
            theme,
            palette,
            direction: Direction::from_env(),
            section: Section::Home,
            layout: Layout::saved(),
            scan: Rc::new(Scan::default()),
            file: loaded.file,
            outcome: loaded.outcome,
            smart_members: HashMap::new(),
            membership: index::Membership::default(),
            sidebar: sidebar.clone(),
            counts: HashMap::new(),
            visible: Rc::new(Vec::new()),
            search,
            query: String::new(),
            editor: None,
            up_next: None,
            opened_at,
            first_paint: false,
            load_task: None,
            dir,
            home_scroll: [gpui::ScrollHandle::new(), gpui::ScrollHandle::new()],
            reload_again: false,
            last_scan: None,
            people_task: None,
            thumbs: thumbs::Thumbs::default(),
            list_scroll: gpui::UniformListScrollHandle::new(),
            grid_scroll: gpui::UniformListScrollHandle::new(),
            _subscriptions: subscriptions,
        };
        this.reload(cx);
        this.ensure_demo_smart_folders(cx);
        this
    }

    fn sync_theme(&mut self, window: &Window, cx: &mut Context<Self>) {
        if self.theme.refresh(window, cx, true) {
            self.palette = Palette::new(&self.theme);
        }
    }

    /// Rescans everything off the main thread. Calls while a scan runs fold
    /// into one more scan after it, so a burst of changes costs two scans.
    fn reload(&mut self, cx: &mut Context<Self>) {
        if self.load_task.is_some() {
            self.reload_again = true;
            return;
        }
        let library = crate::meetings_ui::documents::store::library(cx);
        self.load_up_next(cx);
        let first = self.last_scan.is_none();
        self.load_task = Some(cx.spawn(async move |this, cx| {
            if !first {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(150))
                    .await;
            }
            let started = Instant::now();
            let for_scan = library.clone();
            let scan = cx
                .background_executor()
                .spawn(async move { load::scan(for_scan) })
                .await;
            tracing::info!(
                items = scan.items.len(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library scanned"
            );
            this.update(cx, |this, cx| {
                this.load_task = None;
                this.last_scan = Some(Instant::now());
                this.scan = Rc::new(scan);
                this.thumbs.forget_failures();
                this.reevaluate(cx);
                this.check_members(cx);
                this.index_people(library, cx);
                if std::mem::take(&mut this.reload_again) {
                    this.reload(cx);
                }
            })
            .ok();
        }));
    }

    /// After a scan, off the main thread and after the list is on screen:
    /// which folder members are confirmed gone on disk. A slow or missing
    /// volume delays only this, never the first paint.
    fn check_members(&mut self, cx: &mut Context<Self>) {
        let paths = store::member_paths(&self.file);
        if paths.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let count = paths.len();
            let gone = cx
                .background_spawn(async move { store::confirmed_gone_all(&paths) })
                .await;
            tracing::info!(
                members = count,
                gone = gone.len(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library members checked"
            );
            if gone.is_empty() {
                return;
            }
            this.update(cx, |this, cx| {
                this.prune_members(&gone);
                this.reevaluate(cx);
            })
            .ok();
        })
        .detach();
    }

    /// Second pass after a scan: speaker names from transcripts, cached.
    /// The list is already on screen; names arrive a moment later.
    fn index_people(
        &mut self,
        library: Option<cap_meetings::library::Library>,
        cx: &mut Context<Self>,
    ) {
        let Some(library) = library else {
            return;
        };
        let docs: Vec<(String, PathBuf)> = self
            .scan
            .items
            .iter()
            .filter(|i| i.kind == ItemKind::Meeting)
            .filter_map(|i| match &i.key {
                items::ItemKey::Doc(id) => {
                    library.transcript_path(id).ok().map(|p| (id.clone(), p))
                }
                _ => None,
            })
            .collect();
        if docs.is_empty() {
            return;
        }
        let cache = self.dir.join(people::CACHE_FILE);
        let scan = Rc::downgrade(&self.scan);
        self.people_task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let names = cx
                .background_executor()
                .spawn(async move { people::index(&docs, &cache) })
                .await;
            tracing::info!(
                meetings = names.len(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library people indexed"
            );
            this.update(cx, |this, cx| {
                // A newer scan replaced the items: its own pass will follow.
                let Some(current) = scan.upgrade() else {
                    return;
                };
                if !Rc::ptr_eq(&current, &this.scan) {
                    return;
                }
                drop(current);
                let mut next = (*this.scan).clone();
                let mut changed = false;
                for item in &mut next.items {
                    if let items::ItemKey::Doc(id) = &item.key
                        && let Some(found) = names.get(id)
                        && !found.is_empty()
                    {
                        let before = item.people.len();
                        item.add_people(found);
                        changed |= item.people.len() != before;
                    }
                }
                if changed {
                    this.scan = Rc::new(next);
                    this.reevaluate(cx);
                }
            })
            .ok();
        }));
    }

    fn load_up_next(&mut self, cx: &mut Context<Self>) {
        if std::env::var_os("CAP_GPUI_LIBRARY_SEED").is_some() {
            self.up_next = Some(UpNext {
                title: "Design review: library".into(),
                start: Utc::now() + chrono::Duration::minutes(18),
                people: vec!["Ana Pérez".into(), "Bo Chen".into(), "Mia Novak".into()],
            });
            return;
        }
        let Some(meetings) = crate::meetings::Meetings::try_global(cx) else {
            return;
        };
        let m = meetings.read(cx);
        if !m.settings().enabled {
            return;
        }
        self.up_next = m
            .upcoming_events(Utc::now(), chrono::Duration::hours(12))
            .into_iter()
            .find(|e| !e.all_day && !e.is_cancelled() && !e.is_declined())
            .map(|e| UpNext {
                title: e.title.clone(),
                start: e.start,
                people: e
                    .attendees
                    .iter()
                    .filter(|p| !p.is_self)
                    .filter_map(|p| p.name.clone().or(p.email.clone()))
                    .collect(),
            });
    }

    /// Forgets folder entries that are known to be stale: files confirmed
    /// gone on disk, and folders the notes library no longer has (only when
    /// it loaded). Never when the file is read-only.
    fn prune_members(&mut self, gone: &std::collections::BTreeSet<PathBuf>) {
        if self.file.members.is_empty() || self.outcome == store::LoadOutcome::ReadOnly {
            return;
        }
        let folders: Option<std::collections::BTreeSet<String>> = self
            .scan
            .folders_loaded
            .then(|| self.scan.folders.iter().map(|f| f.id.clone()).collect());
        let mut probe = self.file.clone();
        if store::prune_members(&mut probe, folders.as_ref(), |p| gone.contains(p))
            && let Ok(file) = store::update(&self.dir, |file| {
                store::prune_members(file, folders.as_ref(), |p| gone.contains(p));
            })
        {
            self.file = file;
        }
    }

    /// Decodes the thumbnails the last render asked for, off the main thread,
    /// and draws again as they land (in batches, not one frame per picture).
    fn load_thumbs(&mut self, cx: &mut Context<Self>) {
        let jobs = self.thumbs.take_wanted();
        if jobs.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let (_workers, results) = crate::library::spawn_decode_pool(
                cx.background_executor(),
                jobs,
                |path: PathBuf| {
                    let image = crate::library::decode_thumbnail(&path);
                    Some((path, image))
                },
            );
            while let Ok(first) = results.recv_async().await {
                let mut batch = vec![first];
                batch.extend(results.try_iter());
                let alive = this
                    .update(cx, |this, cx| {
                        for (path, image) in batch {
                            match image {
                                Some(image) => this.thumbs.insert(path, image),
                                None => this.thumbs.fail(path),
                            }
                        }
                        cx.notify();
                    })
                    .is_ok();
                if !alive {
                    return;
                }
            }
        })
        .detach();
    }

    fn in_folder(&self, id: &str, item: &Item) -> bool {
        self.membership.holds(id, item)
    }

    /// Smart folder counts, then the visible list. Runs on the main thread:
    /// 10k items x 20 folders measures in single milliseconds (see the rules
    /// benchmark test), well under a frame.
    fn reevaluate(&mut self, cx: &mut Context<Self>) {
        self.membership = index::Membership::from_file(&self.file);
        let folders = self.file.smart_folders.clone();
        let members = {
            let holds = |id: &str, item: &Item| self.in_folder(id, item);
            let ctx = EvalContext {
                today: today(),
                tz_offset_minutes: crate::meetings_ui::documents::store::tz_offset_minutes(),
                in_folder: &holds,
            };
            rules::evaluate_all(&folders, &self.scan.items, &ctx)
        };
        self.smart_members = members;
        self.counts = index::counts(
            &self.scan.items,
            &self.scan.folders,
            &self.smart_members,
            &self.membership,
        );
        self.section = section_after(&self.section, &self.file);
        if let Some(editor) = self.editor.as_mut() {
            editor.count = 0;
        }
        self.refresh_editor_count(cx);
        self.refilter(cx);
    }

    fn section_indexes(&self) -> Vec<u32> {
        let items = &self.scan.items;
        let all = || (0..items.len() as u32).filter(|i| !items[*i as usize].trashed);
        match &self.section {
            Section::Home => all().collect(),
            Section::Kind(kind) => all()
                .filter(|i| kind.holds(items[*i as usize].kind))
                .collect(),
            Section::Pinned => all().filter(|i| items[*i as usize].pinned).collect(),
            Section::Folder(id) => all()
                .filter(|i| self.in_folder(id, &items[*i as usize]))
                .collect(),
            Section::Smart(id) => self.smart_members.get(id).cloned().unwrap_or_default(),
            Section::Trash => (0..items.len() as u32)
                .filter(|i| items[*i as usize].trashed)
                .collect(),
        }
    }

    fn refilter(&mut self, cx: &mut Context<Self>) {
        let query = self.query.clone();
        let items = &self.scan.items;
        let visible: Vec<u32> = self
            .section_indexes()
            .into_iter()
            .filter(|i| items[*i as usize].matches_query(&query))
            .collect();
        self.visible = Rc::new(visible);
        cx.notify();
    }

    fn set_layout(&mut self, layout: Layout, cx: &mut Context<Self>) {
        if self.layout == layout {
            return;
        }
        self.layout = layout;
        // The store write syncs to disk: never on the frame that switches.
        cx.background_spawn(async move {
            crate::store::set_store_setting(
                LAYOUT_SECTION,
                LAYOUT_KEY,
                serde_json::json!(layout.slug()),
            );
        })
        .detach();
        cx.notify();
    }

    fn show(&mut self, section: Section, cx: &mut Context<Self>) {
        if self.section != section {
            self.section = section;
            for handle in &self.home_scroll {
                handle.set_offset(gpui::point(px(0.), px(0.)));
            }
            self.list_scroll
                .scroll_to_item(0, gpui::ScrollStrategy::Top);
            self.grid_scroll
                .scroll_to_item(0, gpui::ScrollStrategy::Top);
            self.refilter(cx);
        }
    }

    /// Sidebar counts, computed once per change in `reevaluate`.
    fn count_for(&self, section: &Section) -> usize {
        match section {
            Section::Home => self.scan.items.len(),
            other => self.counts.get(other).copied().unwrap_or(0),
        }
    }

    fn open_item(&self, index: u32, cx: &mut Context<Self>) {
        let Some(item) = self.scan.items.get(index as usize).cloned() else {
            return;
        };
        // Made-up demo items have nothing behind them to open.
        if matches!(&item.key, items::ItemKey::Doc(id) if id.starts_with("seed-")) {
            return;
        }
        cx.defer(move |cx| match (&item.key, item.kind) {
            (items::ItemKey::Doc(id), _) => {
                crate::meetings_ui::documents::open(Some(id.clone()), cx)
            }
            (items::ItemKey::Path(path), ItemKind::Recording) => {
                if path.exists() {
                    crate::app_windows::open_editor(path.clone(), cx)
                }
            }
            (items::ItemKey::Path(path), _) => {
                if path.exists() {
                    crate::app_windows::open_screenshot_editor(path.clone(), cx)
                }
            }
        });
    }

    // ---- smart folder editor ------------------------------------------

    fn text_input(
        text: &str,
        placeholder: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextInputState> {
        let input = cx.new(|cx| {
            let mut input = TextInputState::single_line(window, cx);
            input.set_placeholder(placeholder.to_string());
            input.set_text(text.to_string(), cx);
            input
        });
        cx.subscribe(&input, |this, _, event: &TextInputEvent, cx| {
            if matches!(event, TextInputEvent::Changed) {
                this.sync_editor_values(cx);
            }
        })
        .detach();
        input
    }

    fn row_for(rule: Rule, window: &mut Window, cx: &mut Context<Self>) -> RuleRow {
        let value = match &rule {
            Rule::Title { value, .. } | Rule::Person { value, .. } | Rule::App { value, .. } => {
                Some(Self::text_input(
                    value,
                    tr::library::value_placeholder(),
                    window,
                    cx,
                ))
            }
            _ => None,
        };
        RuleRow { rule, value }
    }

    fn open_editor(
        &mut self,
        folder: Option<SmartFolder>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let folder = folder.unwrap_or_else(|| SmartFolder {
            id: String::new(),
            name: String::new(),
            matching: Matching::All,
            rules: vec![Rule::Title {
                op: TextOp::Contains,
                value: String::new(),
            }],
            extra: Default::default(),
        });
        let name = Self::text_input(&folder.name, tr::library::name_placeholder(), window, cx);
        let rows = folder
            .rules
            .iter()
            .cloned()
            .map(|rule| Self::row_for(rule, window, cx))
            .collect();
        self.editor = Some(RuleEditor {
            editing: (!folder.id.is_empty()).then(|| folder.id.clone()),
            name,
            matching: folder.matching,
            rows,
            count: 0,
            preview: Vec::new(),
            saving: false,
            error: None,
        });
        self.refresh_editor_count(cx);
        cx.notify();
    }

    fn sync_editor_values(&mut self, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.as_mut() else {
            return;
        };
        for row in &mut editor.rows {
            if let Some(input) = &row.value {
                let text = input.read(cx).text().to_string();
                if let Rule::Title { value, .. }
                | Rule::Person { value, .. }
                | Rule::App { value, .. } = &mut row.rule
                {
                    *value = text;
                }
            }
        }
        self.refresh_editor_count(cx);
    }

    fn editor_folder(&self, cx: &App) -> Option<SmartFolder> {
        let editor = self.editor.as_ref()?;
        Some(SmartFolder {
            id: editor.editing.clone().unwrap_or_default(),
            name: editor.name.read(cx).text().trim().to_string(),
            matching: editor.matching,
            rules: editor.rows.iter().map(|r| r.rule.clone()).collect(),
            extra: Default::default(),
        })
    }

    fn refresh_editor_count(&mut self, cx: &mut Context<Self>) {
        let Some(folder) = self.editor_folder(cx) else {
            return;
        };
        let compiled = folder.compile(today());
        let holds = |id: &str, item: &Item| self.in_folder(id, item);
        let ctx = EvalContext {
            today: today(),
            tz_offset_minutes: crate::meetings_ui::documents::store::tz_offset_minutes(),
            in_folder: &holds,
        };
        let mut count = 0;
        let mut preview = Vec::new();
        for (i, item) in self.scan.items.iter().enumerate() {
            if compiled.matches(item, &ctx) {
                count += 1;
                if preview.len() < 4 {
                    preview.push(i as u32);
                }
            }
        }
        if let Some(editor) = self.editor.as_mut() {
            editor.count = count;
            editor.preview = preview;
        }
        cx.notify();
    }

    fn save_editor(&mut self, cx: &mut Context<Self>) {
        let Some(mut folder) = self.editor_folder(cx) else {
            return;
        };
        if folder.name.is_empty() {
            folder.name = tr::library::smart_folder().into();
        }
        if folder.id.is_empty() {
            folder.id = format!(
                "s-{}",
                cap_meetings::library::new_id(
                    Utc::now(),
                    crate::meetings_ui::documents::store::crate_entropy()
                )
            );
        }
        self.commit_smart_folder(folder, true, cx);
    }

    /// Writes a smart folder in the background (the write syncs to disk) and
    /// shows it only once it is saved: on success the written file, which
    /// merges anything another window saved meanwhile, replaces ours and the
    /// sheet closes; on failure the sheet stays open with the typed rule and
    /// says why. Nothing is shown that is not on disk.
    fn commit_smart_folder(
        &mut self,
        folder: SmartFolder,
        close_sheet: bool,
        cx: &mut Context<Self>,
    ) {
        if self.outcome == store::LoadOutcome::ReadOnly {
            if let Some(editor) = self.editor.as_mut() {
                editor.error = Some(SaveError::ReadOnly);
            }
            cx.notify();
            return;
        }
        if let Some(editor) = self.editor.as_mut() {
            if editor.saving {
                return;
            }
            editor.saving = true;
            editor.error = None;
        }
        let dir = self.dir.clone();
        let id = folder.id.clone();
        cx.spawn(async move |this, cx| {
            let written = cx
                .background_spawn(async move {
                    store::update(&dir, |file| {
                        match file.smart_folders.iter_mut().find(|f| f.id == folder.id) {
                            Some(existing) => {
                                existing.name = folder.name.clone();
                                existing.matching = folder.matching;
                                existing.rules = folder.rules.clone();
                            }
                            None => file.smart_folders.push(folder.clone()),
                        }
                    })
                })
                .await;
            this.update(cx, |this, cx| {
                match written {
                    Ok(file) => {
                        this.file = file;
                        this.section = Section::Smart(id);
                        if close_sheet {
                            this.editor = None;
                        }
                    }
                    Err(error) => {
                        tracing::warn!("smart folder not saved: {error:?}");
                        if let Some(editor) = this.editor.as_mut() {
                            editor.saving = false;
                            editor.error = Some(SaveError::from_update(&error));
                        }
                        if error == store::UpdateError::ReadOnly {
                            this.outcome = store::LoadOutcome::ReadOnly;
                        }
                    }
                }
                this.reevaluate(cx);
            })
            .ok();
        })
        .detach();
    }

    /// The perf bench's "save a rule": the same path the sheet's Create
    /// button takes, without the sheet.
    fn bench_save_rule(&mut self, name: &str, cx: &mut Context<Self>) {
        let id = format!("s-bench-{}", name.replace(' ', "-"));
        let folder = SmartFolder {
            id: id.clone(),
            name: name.to_string(),
            matching: Matching::All,
            rules: vec![
                Rule::Title {
                    op: TextOp::Contains,
                    value: "settings".into(),
                },
                Rule::Kind {
                    op: IsOp::Is,
                    value: ItemKind::Screenshot,
                },
            ],
            extra: Default::default(),
        };
        let _ = id;
        self.commit_smart_folder(folder, false, cx);
    }

    fn auto_page(&mut self, page: &str, window: &mut Window, cx: &mut Context<Self>) {
        match page {
            "recordings" => self.section = Section::Kind(KindView::Recordings),
            "screenshots" => self.section = Section::Kind(KindView::Screenshots),
            "notes" => self.section = Section::Kind(KindView::Notes),
            "trash" => self.section = Section::Trash,
            "list" => self.section = Section::Kind(KindView::Notes),
            "editor" => self.open_editor(
                Some(SmartFolder {
                    id: String::new(),
                    name: "Calls with Ana".into(),
                    matching: Matching::All,
                    rules: vec![
                        Rule::Person {
                            op: TextOp::Is,
                            value: "Ana Pérez".into(),
                        },
                        Rule::Kind {
                            op: IsOp::Is,
                            value: ItemKind::Meeting,
                        },
                        Rule::Date {
                            range: DateRange::LastDays { days: 30 },
                        },
                        Rule::Length {
                            op: LengthOp::LongerThan,
                            minutes: 15,
                        },
                    ],
                    extra: Default::default(),
                }),
                window,
                cx,
            ),
            "editor-empty" => self.open_editor(
                Some(SmartFolder {
                    id: String::new(),
                    name: "Quarterly reviews".into(),
                    matching: Matching::All,
                    rules: vec![Rule::Title {
                        op: TextOp::Contains,
                        value: "quarterly".into(),
                    }],
                    extra: Default::default(),
                }),
                window,
                cx,
            ),
            _ => {}
        }
        if let Ok(query) = std::env::var("CAP_GPUI_LIBRARY_QUERY") {
            self.search
                .update(cx, |input, cx| input.set_text(query.clone(), cx));
            self.query = text::fold(&query);
        }
        self.ensure_demo_smart_folders(cx);
        self.refilter(cx);
    }

    /// Seeded screenshots show a sidebar with smart folders in it; the real
    /// library starts with none.
    fn ensure_demo_smart_folders(&mut self, cx: &mut Context<Self>) {
        if std::env::var_os("CAP_GPUI_LIBRARY_SEED").is_none()
            || !self.file.smart_folders.is_empty()
        {
            return;
        }
        let demo = |id: &str, name: &str, rules: Vec<Rule>| SmartFolder {
            id: id.into(),
            name: name.into(),
            matching: Matching::All,
            rules,
            extra: Default::default(),
        };
        self.file.smart_folders = vec![
            demo(
                "s-demo-standups",
                "Standups",
                vec![Rule::Title {
                    op: TextOp::Contains,
                    value: "standup".into(),
                }],
            ),
            demo(
                "s-demo-ana",
                "With Ana",
                vec![Rule::Person {
                    op: TextOp::Is,
                    value: "Ana Pérez".into(),
                }],
            ),
            demo(
                "s-demo-long",
                "Long calls",
                vec![
                    Rule::Kind {
                        op: IsOp::Is,
                        value: ItemKind::Meeting,
                    },
                    Rule::Length {
                        op: LengthOp::LongerThan,
                        minutes: 45,
                    },
                ],
            ),
        ];
        self.reevaluate(cx);
    }
}

// ---- rendering ----------------------------------------------------------

fn kind_glyph(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Recording => "icons/video.svg",
        ItemKind::Screenshot => "icons/screenshot.svg",
        ItemKind::Meeting => "icons/users.svg",
        ItemKind::Note => "icons/notebook.svg",
    }
}

fn kind_word(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Recording => tr::library::kind_recording(),
        ItemKind::Screenshot => tr::library::kind_screenshot(),
        ItemKind::Meeting => tr::library::kind_meeting(),
        ItemKind::Note => tr::library::kind_note(),
    }
}

fn when_line(item: &Item, today: NaiveDate) -> String {
    let local = format::local(item.at);
    if local.date() == today {
        format::clock(local)
    } else {
        format!(
            "{}, {}",
            format::short_date(local.date(), today),
            format::clock(local)
        )
    }
}

fn meta_line(item: &Item) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(ms) = item.duration_ms {
        parts.push(format::duration(ms));
    }
    if !item.people.is_empty() {
        let mut names = item
            .people
            .iter()
            .take(2)
            .map(|p| p.split(' ').next().unwrap_or(p).to_string())
            .collect::<Vec<_>>()
            .join(", ");
        if item.people.len() > 2 {
            names.push_str(&format!(" +{}", item.people.len() - 2));
        }
        parts.push(names);
    } else if let Some(app) = &item.app {
        parts.push(app.clone());
    }
    if parts.is_empty() {
        kind_word(item.kind).to_string()
    } else {
        parts.join("  ·  ")
    }
}

fn section_title(section: &Section, file: &store::LibraryFile, scan: &Scan) -> String {
    match section {
        Section::Home => tr::library::title().into(),
        Section::Kind(kind) => kind.label().into(),
        Section::Pinned => tr::library::pinned().into(),
        Section::Folder(id) => scan
            .folders
            .iter()
            .find(|f| &f.id == id)
            .map(|f| f.name.clone())
            .unwrap_or_else(|| tr::library::folder().into()),
        Section::Smart(id) => file
            .smart_folders
            .iter()
            .find(|f| &f.id == id)
            .map(|f| f.name.clone())
            .unwrap_or_else(|| tr::library::smart_folder().into()),
        Section::Trash => tr::library::trash().into(),
    }
}

impl LibraryWindow {
    fn glass(&self) -> bool {
        self.theme.material.is_some()
    }

    /// What the sidebar shows: built every render (a few small rows, counts
    /// already computed) and handed to the cached sidebar view, which redraws
    /// only when it differs.
    fn sidebar_model(&self) -> sidebar::Model {
        use sidebar::Row;
        let p = self.palette;
        let dark = p.dark;
        let nav = |id: SharedString,
                   icon: &'static str,
                   tint: Option<Hsla>,
                   label: SharedString,
                   count: Option<usize>,
                   section: Section| Row::Nav {
            id,
            icon,
            tint,
            label,
            count,
            section,
        };
        let mut rows = vec![nav(
            "nav-home".into(),
            "icons/layers.svg",
            None,
            tr::library::title().into(),
            None,
            Section::Home,
        )];
        for kind in [KindView::Recordings, KindView::Screenshots, KindView::Notes] {
            let section = Section::Kind(kind);
            rows.push(nav(
                SharedString::from(format!("nav-{}", kind.label())),
                kind.icon(),
                Some(style::kind_tint(kind.tint(), dark)),
                kind.label().into(),
                Some(self.count_for(&section)),
                section,
            ));
        }
        let pinned = self.count_for(&Section::Pinned);
        if pinned > 0 {
            rows.push(nav(
                "nav-pinned".into(),
                "icons/pin.svg",
                Some(style::kind_tint(ItemKind::Note, dark)),
                tr::library::pinned().into(),
                Some(pinned),
                Section::Pinned,
            ));
        }
        rows.push(Row::FoldersLabel);
        for folder in &self.scan.folders {
            let section = Section::Folder(folder.id.clone());
            rows.push(nav(
                SharedString::from(format!("nav-folder-{}", folder.id)),
                "icons/folder.svg",
                None,
                folder.name.clone().into(),
                Some(self.count_for(&section)),
                section,
            ));
        }
        for folder in &self.file.smart_folders {
            let section = Section::Smart(folder.id.clone());
            rows.push(nav(
                SharedString::from(format!("nav-smart-{}", folder.id)),
                "icons/sliders-horizontal.svg",
                Some(p.accent),
                folder.name.clone().into(),
                Some(self.count_for(&section)),
                section,
            ));
        }
        rows.push(Row::Spacer);
        match &self.outcome {
            store::LoadOutcome::MovedAside(_) => {
                rows.push(Row::Notice(tr::library::file_unreadable()))
            }
            store::LoadOutcome::ReadOnly => rows.push(Row::Notice(tr::library::file_read_only())),
            _ => {}
        }
        rows.push(nav(
            "nav-trash".into(),
            "icons/trash.svg",
            None,
            tr::library::trash().into(),
            Some(self.count_for(&Section::Trash)),
            Section::Trash,
        ));
        let background = if !self.glass() || self.direction == Direction::Gallery {
            Some(if self.glass() {
                style::sidebar_wash(dark)
            } else {
                p.sidebar
            })
        } else {
            None
        };
        sidebar::Model {
            rows,
            selected: self.section.clone(),
            palette: p,
            background,
        }
    }

    fn render_toolbar(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let dark = p.dark;
        let title = section_title(&self.section, &self.file, &self.scan);
        let width = f32::from(window.viewport_size().width) - style::SIDEBAR_WIDTH;
        let search_w = (width * 0.34).clamp(style::SEARCH_MIN_WIDTH, style::SEARCH_WIDTH);
        let show_layout = true;
        let theme = self.theme;
        let seg = |id: &'static str,
                   icon: &'static str,
                   on: bool,
                   layout: Layout,
                   cx: &mut Context<Self>| {
            let label = if layout == Layout::Grid {
                tr::library::layout_magazine()
            } else {
                tr::library::layout_list()
            };
            div()
                .id(id)
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded_full()
                .cursor_pointer()
                .role(gpui::Role::Button)
                .aria_label(label)
                .aria_selected(on)
                .tooltip(move |_, cx| crate::ui::Tooltip::new(&theme, label).view(cx))
                .when(on, |el| {
                    el.bg(if dark {
                        gpui::hsla(0., 0., 1., 0.16)
                    } else {
                        gpui::white()
                    })
                    .shadow(vec![gpui::BoxShadow {
                        color: gpui::hsla(0., 0., 0., if dark { 0.3 } else { 0.10 }),
                        offset: gpui::point(px(0.), px(1.)),
                        blur_radius: px(2.),
                        spread_radius: px(0.),
                        inset: false,
                    }])
                })
                .when(!on, |el| el.hover(move |s| s.bg(p.hover)))
                .child(
                    svg()
                        .path(icon)
                        .size(px(14.))
                        .text_color(if on { p.text } else { p.muted }),
                )
                .on_click(cx.listener(move |this, _, _, cx| this.set_layout(layout, cx)))
        };
        div()
            .h(px(style::TOOLBAR_HEIGHT))
            .flex_shrink_0()
            .w_full()
            .px(px(style::CONTENT_PAD - 6.))
            .flex()
            .items_center()
            .gap(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(17.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .child(title),
            )
            .when(show_layout, |el| {
                el.child(
                    div()
                        .flex_shrink_0()
                        .flex()
                        .gap(px(2.))
                        .p(px(2.))
                        .rounded_full()
                        .bg(p.field)
                        .id("layout-switch")
                        .role(gpui::Role::Group)
                        .aria_label(tr::library::layout())
                        .child(seg(
                            "layout-list",
                            "icons/align-left.svg",
                            self.layout == Layout::List,
                            Layout::List,
                            cx,
                        ))
                        .child(seg(
                            "layout-grid",
                            "icons/layout.svg",
                            self.layout == Layout::Grid,
                            Layout::Grid,
                            cx,
                        )),
                )
            })
            .child(
                div().flex_shrink_0().w(px(search_w)).child(
                    TextInput::search(&self.theme, "library-search", &self.search)
                        .text_color(p.text)
                        .placeholder_color(p.faint),
                ),
            )
            .child(
                div()
                    .id("library-new")
                    .flex_shrink_0()
                    .h(px(32.))
                    .px(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .rounded_full()
                    .bg(style::capsule_fill(dark))
                    .border_1()
                    .border_color(style::capsule_border(dark))
                    .shadow(style::capsule_shadow(dark))
                    .cursor_pointer()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.text)
                    .role(gpui::Role::Button)
                    .aria_label(tr::library::new_note())
                    .child(
                        svg()
                            .path("icons/plus.svg")
                            .size(px(13.))
                            .text_color(p.text),
                    )
                    .child(tr::library::new())
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.defer(crate::meetings_ui::documents::new_note);
                    })),
            )
            .into_any_element()
    }

    fn thumb(&self, item: &Item, height: f32, radius: f32) -> AnyElement {
        let p = self.palette;
        let dark = p.dark;
        let tint = style::kind_tint(item.kind, dark);
        let base = div()
            .relative()
            .w_full()
            .h(px(height))
            .rounded(px(radius))
            .overflow_hidden()
            .bg(style::thumb_well(dark));
        match &item.thumbnail {
            Some(path) => base
                .children(self.thumbs.get(path).map(|image| {
                    img(image)
                        .absolute()
                        .inset_0()
                        .size_full()
                        .object_fit(ObjectFit::Cover)
                }))
                .when_some(
                    item.duration_ms
                        .filter(|_| item.kind == ItemKind::Recording),
                    |el, ms| {
                        el.child(
                            div()
                                .absolute()
                                .right(px(8.))
                                .bottom(px(8.))
                                .px(px(6.))
                                .py(px(1.))
                                .rounded(px(6.))
                                .bg(gpui::hsla(0., 0., 0., 0.55))
                                .text_size(px(11.))
                                .text_color(gpui::white())
                                .child(format::duration(ms)),
                        )
                    },
                )
                .into_any_element(),
            None => {
                // No picture: a quiet paper card that still says what the
                // meeting was. Who was there, how long, and its first line.
                let people: Vec<String> = item.people.iter().take(4).cloned().collect();
                let extra = item.people.len().saturating_sub(people.len());
                let avatars = div()
                    .flex()
                    .items_center()
                    .children(people.iter().enumerate().map(|(i, name)| {
                        let initial: String = name
                            .chars()
                            .next()
                            .map(|c| c.to_uppercase().collect())
                            .unwrap_or_default();
                        div()
                            .size(px(24.))
                            .when(i > 0, |el| el.ml(px(-6.)))
                            .rounded_full()
                            .border_2()
                            .border_color(style::paper(dark))
                            .bg(p.speaker(i))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(10.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(gpui::white())
                            .child(initial)
                    }));
                let footer = (!people.is_empty()).then(|| {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .child(avatars)
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .text_color(p.muted)
                                .child(if extra > 0 {
                                    format!("{} +{extra}", people.join(", "))
                                } else {
                                    people.join(", ")
                                }),
                        )
                });
                base.bg(style::paper(dark))
                    .border_1()
                    .border_color(style::capsule_border(dark))
                    .shadow(style::capsule_shadow(dark))
                    .p(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(10.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(11.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(tint)
                            .child(
                                svg()
                                    .path(kind_glyph(item.kind))
                                    .size(px(13.))
                                    .text_color(tint),
                            )
                            .child(kind_word(item.kind))
                            .child(div().flex_1())
                            .children(item.app.clone().map(|app| {
                                div()
                                    .text_color(p.faint)
                                    .font_weight(FontWeight::NORMAL)
                                    .child(app)
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h_0()
                            .overflow_hidden()
                            .text_size(px(if height > 220. { 17. } else { 13.5 }))
                            .line_height(px(if height > 220. { 25. } else { 19.5 }))
                            .line_clamp(if height > 220. { 4 } else { 2 })
                            .text_color(p.text)
                            .child(item.excerpt.clone().unwrap_or_else(|| item.title.clone())),
                    )
                    .children(footer)
                    .into_any_element()
            }
        }
    }

    fn card(&self, index: u32, thumb_h: f32, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let item = &self.scan.items[index as usize];
        let today = today();
        div()
            .id(SharedString::from(format!("card-{index}")))
            .flex()
            .flex_col()
            .gap(px(8.))
            .p(px(6.))
            .rounded(px(style::CARD_RADIUS + 4.))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(item.title.clone()))
            .hover(move |s| s.bg(p.hover))
            .child(self.thumb(item, thumb_h, style::CARD_RADIUS))
            .child(
                div()
                    .px(px(4.))
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(13.5))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(p.text)
                                    .child(item.title.clone()),
                            )
                            .when(item.pinned, |el| {
                                el.child(
                                    svg()
                                        .path("icons/pin.svg")
                                        .size(px(11.))
                                        .text_color(p.faint),
                                )
                            }),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(p.muted)
                            .child(format!(
                                "{}  ·  {}",
                                when_line(item, today),
                                meta_line(item)
                            )),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.open_item(index, cx)))
            .into_any_element()
    }

    fn list_row(&self, index: u32, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let dark = p.dark;
        let item = &self.scan.items[index as usize];
        let tint = style::kind_tint(item.kind, dark);
        let today = today();
        let leading = match &item.thumbnail {
            Some(path) => div()
                .w(px(64.))
                .h(px(40.))
                .flex_shrink_0()
                .rounded(px(7.))
                .overflow_hidden()
                .bg(style::thumb_well(dark))
                .children(
                    self.thumbs
                        .get(path)
                        .map(|image| img(image).size_full().object_fit(ObjectFit::Cover)),
                )
                .into_any_element(),
            None => div()
                .w(px(64.))
                .h(px(40.))
                .flex_shrink_0()
                .rounded(px(7.))
                .bg(style::soft(tint, dark))
                .flex()
                .items_center()
                .justify_center()
                .child(
                    svg()
                        .path(kind_glyph(item.kind))
                        .size(px(16.))
                        .text_color(tint),
                )
                .into_any_element(),
        };
        div()
            .id(SharedString::from(format!("row-{index}")))
            .h(px(style::LIST_ROW_HEIGHT))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(14.))
            .rounded(px(10.))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(item.title.clone()))
            .hover(move |s| s.bg(p.hover))
            .child(leading)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(13.5))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.text)
                            .child(item.title.clone()),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(p.muted)
                            .child(meta_line(item)),
                    ),
            )
            .when(item.pinned, |el| {
                el.child(
                    svg()
                        .path("icons/pin.svg")
                        .size(px(12.))
                        .text_color(p.faint),
                )
            })
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(12.))
                    .text_color(p.faint)
                    .child(when_line(item, today)),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.open_item(index, cx)))
            .into_any_element()
    }

    fn heading(&self, text: impl Into<SharedString>) -> gpui::Div {
        div()
            .mt(px(26.))
            .mb(px(10.))
            .px(px(4.))
            .text_size(px(15.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(self.palette.text)
            .child(text.into())
    }

    fn render_up_next(&self) -> Option<AnyElement> {
        let p = self.palette;
        let dark = p.dark;
        let next = self.up_next.as_ref()?;
        let minutes = (next.start - Utc::now()).num_minutes().max(0);
        let when = if minutes < 60 {
            tr::library::up_next_in(minutes).to_string()
        } else {
            format::clock(format::local(next.start))
        };
        let tint = style::kind_tint(ItemKind::Meeting, dark);
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(14.))
                .px(px(16.))
                .py(px(12.))
                .rounded(px(style::CARD_RADIUS + 2.))
                .bg(style::capsule_fill(dark))
                .border_1()
                .border_color(style::capsule_border(dark))
                .shadow(style::capsule_shadow(dark))
                .child(
                    div()
                        .size(px(34.))
                        .flex_shrink_0()
                        .rounded(px(9.))
                        .bg(tint)
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            svg()
                                .path("icons/calendar.svg")
                                .size(px(16.))
                                .text_color(gpui::white()),
                        ),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(1.))
                        .child(
                            div()
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(tint)
                                .child(when),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(14.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.text)
                                .child(next.title.clone()),
                        )
                        .when(!next.people.is_empty(), |el| {
                            el.child(
                                div()
                                    .truncate()
                                    .text_size(px(12.))
                                    .text_color(p.muted)
                                    .child(next.people.join(", ")),
                            )
                        }),
                )
                .child(
                    div()
                        .flex_shrink_0()
                        .h(px(30.))
                        .px(px(14.))
                        .flex()
                        .items_center()
                        .rounded_full()
                        .bg(tint)
                        .text_size(px(13.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(gpui::white())
                        .child(tr::library::take_notes()),
                )
                .into_any_element(),
        )
    }

    fn content_width(&self, window: &Window) -> f32 {
        let inset = if self.direction == Direction::Calm {
            style::PAGE_INSET * 2.
        } else {
            0.
        };
        (f32::from(window.viewport_size().width)
            - style::SIDEBAR_WIDTH
            - inset
            - style::CONTENT_PAD * 2.)
            .max(320.)
    }

    fn render_home_gallery(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let width = self.content_width(window);
        let visible = self.visible.clone();
        let mut page = div().flex().flex_col();
        if let Some(up) = self.render_up_next() {
            page = page.child(up);
        }
        let mut rest: Vec<u32> = visible.iter().copied().collect();
        if !rest.is_empty() {
            // The big card wants a picture: the newest recording or
            // screenshot from the last few items, else the newest item.
            let hero_at = rest
                .iter()
                .take(8)
                .position(|i| self.scan.items[*i as usize].thumbnail.is_some())
                .unwrap_or(0);
            let hero = rest.remove(hero_at);
            let has_picture = self.scan.items[hero as usize].thumbnail.is_some();
            let side: Vec<u32> = rest.iter().copied().take(5).collect();
            rest.drain(..side.len());
            let stacked = width < 720.;
            let hero_w = if stacked {
                width
            } else {
                (width * 0.58).floor()
            };
            let hero_h = if has_picture { hero_w * 0.5625 } else { 200. };
            page = page.child(self.heading(tr::library::latest())).child(
                div()
                    .flex()
                    .when(stacked, |el| el.flex_col())
                    .gap(px(style::GRID_GAP))
                    .child(
                        div()
                            .w(px(hero_w))
                            .flex_shrink_0()
                            .child(self.card(hero, hero_h, cx)),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pt(px(2.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .children(side.into_iter().map(|i| self.list_row(i, cx))),
                    ),
            );
        }
        let pinned: Vec<u32> = rest
            .iter()
            .copied()
            .filter(|i| self.scan.items[*i as usize].pinned)
            .take(4)
            .collect();
        if !pinned.is_empty() {
            rest.retain(|i| !pinned.contains(i));
            page = page
                .child(self.heading(tr::library::pinned()))
                .child(self.grid_rows(&pinned, width, cx));
        }
        let earlier: Vec<u32> = rest.into_iter().take(12).collect();
        if !earlier.is_empty() {
            page = page
                .child(self.heading(tr::library::earlier()))
                .child(self.grid_rows(&earlier, width, cx));
        }
        if visible.is_empty() {
            page = page.child(self.render_empty());
        }
        div()
            .id("home-magazine")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.home_scroll[0])
            .px(px(style::CONTENT_PAD))
            .pb(px(28.))
            .child(page.text_color(p.text))
            .into_any_element()
    }

    fn render_home_calm(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let today = today();
        let mut page = div().flex().flex_col();
        if let Some(up) = self.render_up_next() {
            page = page.child(up);
        }
        let pinned: Vec<u32> = self
            .visible
            .iter()
            .copied()
            .filter(|i| self.scan.items[*i as usize].pinned)
            .take(6)
            .collect();
        if !pinned.is_empty() {
            page = page.child(self.heading(tr::library::pinned())).child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(px(8.))
                    .children(pinned.iter().map(|&i| {
                        let item = &self.scan.items[i as usize];
                        let tint = style::kind_tint(item.kind, p.dark);
                        div()
                            .id(SharedString::from(format!("pin-{i}")))
                            .h(px(32.))
                            .px(px(12.))
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .rounded_full()
                            .bg(style::capsule_fill(p.dark))
                            .border_1()
                            .border_color(style::capsule_border(p.dark))
                            .shadow(style::capsule_shadow(p.dark))
                            .cursor_pointer()
                            .text_size(px(13.))
                            .child(
                                svg()
                                    .path(kind_glyph(item.kind))
                                    .size(px(13.))
                                    .text_color(tint),
                            )
                            .child(item.title.clone())
                            .on_click(cx.listener(move |this, _, _, cx| this.open_item(i, cx)))
                    })),
            );
        }
        let mut current: Option<NaiveDate> = None;
        for &i in self.visible.iter().filter(|i| !pinned.contains(i)).take(24) {
            let date = format::local(self.scan.items[i as usize].at).date();
            if current != Some(date) {
                current = Some(date);
                page = page.child(self.heading(format::day_label(date, today)));
            }
            page = page.child(self.list_row(i, cx));
        }
        if self.visible.is_empty() {
            page = page.child(self.render_empty());
        }
        div()
            .id("home-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.home_scroll[1])
            .px(px(style::CONTENT_PAD))
            .pb(px(28.))
            .child(page)
            .into_any_element()
    }

    fn columns(&self, width: f32) -> usize {
        (((width + style::GRID_GAP) / (style::GRID_MIN_TILE + style::GRID_GAP)).floor() as usize)
            .clamp(1, 6)
    }

    fn grid_rows(&self, indexes: &[u32], width: f32, cx: &mut Context<Self>) -> AnyElement {
        let cols = self.columns(width);
        let tile = (width - style::GRID_GAP * (cols as f32 - 1.)) / cols as f32;
        div()
            .flex()
            .flex_col()
            .gap(px(style::GRID_GAP))
            .children(indexes.chunks(cols).map(|row| {
                div()
                    .flex()
                    .gap(px(style::GRID_GAP))
                    .children(row.iter().map(|&i| {
                        div()
                            .w(px(tile))
                            .flex_shrink_0()
                            .child(self.card(i, tile * 0.6, cx))
                    }))
            }))
            .into_any_element()
    }

    fn render_collection(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        if self.visible.is_empty() {
            return div()
                .flex_1()
                .px(px(style::CONTENT_PAD))
                .child(self.render_empty())
                .into_any_element();
        }
        let width = self.content_width(window);
        match self.layout {
            Layout::List => {
                let visible = self.visible.clone();
                gpui::uniform_list(
                    "library-list",
                    visible.len(),
                    cx.processor(move |this, range: std::ops::Range<usize>, _, cx| {
                        let rows = range.map(|r| this.list_row(visible[r], cx)).collect();
                        // Rows render during layout, after render(): start
                        // their pictures here.
                        this.load_thumbs(cx);
                        rows
                    }),
                )
                .track_scroll(&self.list_scroll)
                .flex_1()
                .min_h_0()
                .px(px(style::CONTENT_PAD - 10.))
                .into_any_element()
            }
            Layout::Grid => {
                let cols = self.columns(width);
                let visible = self.visible.clone();
                let rows = visible.len().div_ceil(cols);
                gpui::uniform_list(
                    "library-grid",
                    rows,
                    cx.processor(move |this, range: std::ops::Range<usize>, window, cx| {
                        let width = this.content_width(window);
                        let rows = range
                            .map(|r| {
                                let start = r * cols;
                                let end = (start + cols).min(visible.len());
                                div()
                                    .pb(px(style::GRID_GAP))
                                    .child(this.grid_rows(&visible[start..end], width, cx))
                                    .into_any_element()
                            })
                            .collect::<Vec<_>>();
                        this.load_thumbs(cx);
                        rows
                    }),
                )
                .track_scroll(&self.grid_scroll)
                .flex_1()
                .min_h_0()
                .px(px(style::CONTENT_PAD))
                .into_any_element()
            }
        }
    }

    fn render_empty(&self) -> AnyElement {
        let p = self.palette;
        let (title, body) = if !self.query.is_empty() {
            (tr::library::no_matches(), tr::library::no_matches_body())
        } else {
            match &self.section {
                Section::Smart(_) => (tr::library::smart_empty(), tr::library::smart_empty_body()),
                Section::Trash => (tr::library::trash_empty(), tr::library::trash_empty_body()),
                _ => (tr::library::nothing_yet(), tr::library::nothing_yet_body()),
            }
        };
        div()
            .pt(px(80.))
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(15.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(p.text)
                    .child(title),
            )
            .child(div().text_size(px(13.)).text_color(p.muted).child(body))
            .into_any_element()
    }

    fn pill(
        &self,
        id: impl Into<SharedString>,
        label: impl Into<SharedString>,
        cx: &mut Context<Self>,
        on: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> AnyElement {
        let p = self.palette;
        let dark = p.dark;
        div()
            .id(id.into())
            .h(px(30.))
            .px(px(10.))
            .flex()
            .flex_shrink_0()
            .items_center()
            .gap(px(6.))
            .rounded(px(8.))
            .bg(style::capsule_fill(dark))
            .border_1()
            .border_color(style::capsule_border(dark))
            .shadow(style::capsule_shadow(dark))
            .cursor_pointer()
            .text_size(px(13.))
            .text_color(p.text)
            .child(label.into())
            .child(
                svg()
                    .path("icons/chevrons-up-down.svg")
                    .size(px(11.))
                    .text_color(p.muted),
            )
            .on_click(cx.listener(move |this, _, window, cx| on(this, window, cx)))
            .into_any_element()
    }

    fn render_rule_row(&self, index: usize, row: &RuleRow, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let (field, op, value): (&str, String, AnyElement) = match &row.rule {
            Rule::Title { op, .. } | Rule::Person { op, .. } | Rule::App { op, .. } => {
                let field = match row.rule {
                    Rule::Title { .. } => tr::library::field_title(),
                    Rule::Person { .. } => tr::library::field_person(),
                    _ => tr::library::field_app(),
                };
                let op = match op {
                    TextOp::Contains => tr::library::op_contains(),
                    TextOp::DoesNotContain => tr::library::op_not_contains(),
                    TextOp::Is => tr::library::op_is(),
                    TextOp::StartsWith => tr::library::op_starts_with(),
                };
                let value = match &row.value {
                    Some(input) => div()
                        .flex_1()
                        .min_w(px(140.))
                        .child(
                            TextInput::search(
                                &self.theme,
                                SharedString::from(format!("rule-value-{index}")),
                                input,
                            )
                            .without_icon()
                            .height(px(30.))
                            .text_color(p.text)
                            .placeholder_color(p.faint),
                        )
                        .into_any_element(),
                    None => div().into_any_element(),
                };
                (field, op.to_string(), value)
            }
            Rule::Kind { op, value } => (
                tr::library::field_kind(),
                if *op == IsOp::Is {
                    tr::library::op_is()
                } else {
                    tr::library::op_is_not()
                }
                .to_string(),
                self.pill(
                    format!("rule-kind-{index}"),
                    kind_word(*value),
                    cx,
                    move |this, _window, cx| {
                        if let Some(row) = this.editor.as_mut().and_then(|e| e.rows.get_mut(index))
                            && let Rule::Kind { value, .. } = &mut row.rule
                        {
                            let at = ItemKind::ALL.iter().position(|k| k == value).unwrap_or(0);
                            *value = ItemKind::ALL[(at + 1) % ItemKind::ALL.len()];
                        }
                        this.refresh_editor_count(cx);
                    },
                ),
            ),
            Rule::Date { range } => (
                tr::library::field_date(),
                tr::library::op_is().into(),
                self.pill(
                    format!("rule-date-{index}"),
                    match range {
                        DateRange::Today => tr::library::date_today().to_string(),
                        DateRange::LastDays { days } => {
                            tr::library::date_last_days(*days as usize).to_string()
                        }
                        DateRange::After { date } => tr::library::date_after(date).to_string(),
                        DateRange::Before { date } => tr::library::date_before(date).to_string(),
                        DateRange::Between { from, to } => {
                            tr::library::date_between(from, to).to_string()
                        }
                    },
                    cx,
                    move |this, _window, cx| {
                        if let Some(row) = this.editor.as_mut().and_then(|e| e.rows.get_mut(index))
                            && let Rule::Date { range } = &mut row.rule
                        {
                            *range = match range {
                                DateRange::Today => DateRange::LastDays { days: 7 },
                                DateRange::LastDays { days: 7 } => DateRange::LastDays { days: 30 },
                                DateRange::LastDays { days: 30 } => {
                                    DateRange::LastDays { days: 90 }
                                }
                                _ => DateRange::Today,
                            };
                        }
                        this.refresh_editor_count(cx);
                    },
                ),
            ),
            Rule::Length { op, minutes } => (
                tr::library::field_length(),
                if *op == LengthOp::LongerThan {
                    tr::library::op_longer()
                } else {
                    tr::library::op_shorter()
                }
                .to_string(),
                self.pill(
                    format!("rule-len-{index}"),
                    tr::library::minutes(minutes).to_string(),
                    cx,
                    move |this, _window, cx| {
                        if let Some(row) = this.editor.as_mut().and_then(|e| e.rows.get_mut(index))
                            && let Rule::Length { minutes, .. } = &mut row.rule
                        {
                            *minutes = match *minutes {
                                0..=4 => 5,
                                5..=14 => 15,
                                15..=29 => 30,
                                30..=59 => 60,
                                _ => 5,
                            };
                        }
                        this.refresh_editor_count(cx);
                    },
                ),
            ),
            Rule::Has { what, value } => (
                match what {
                    Content::Transcript => tr::library::field_transcript(),
                    Content::Summary => tr::library::field_summary(),
                    Content::Notes => tr::library::field_notes(),
                },
                if *value {
                    tr::library::op_exists()
                } else {
                    tr::library::op_missing()
                }
                .to_string(),
                div().into_any_element(),
            ),
            Rule::Folder { op, id } => (
                tr::library::folder(),
                if *op == IsOp::Is {
                    tr::library::op_is()
                } else {
                    tr::library::op_is_not()
                }
                .to_string(),
                div()
                    .text_size(px(13.))
                    .child(
                        self.scan
                            .folders
                            .iter()
                            .find(|f| &f.id == id)
                            .map(|f| f.name.clone())
                            .unwrap_or_else(|| tr::library::deleted_folder().into()),
                    )
                    .into_any_element(),
            ),
            Rule::Pinned { value } => (
                tr::library::field_pinned(),
                if *value {
                    tr::library::yes()
                } else {
                    tr::library::no()
                }
                .to_string(),
                div().into_any_element(),
            ),
            Rule::Unknown(_) => (
                tr::library::field_unknown(),
                String::new(),
                div().into_any_element(),
            ),
        };
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(self.pill(
                format!("rule-field-{index}"),
                field,
                cx,
                move |this, window, cx| this.cycle_field(index, window, cx),
            ))
            .when(!op.is_empty(), |el| {
                el.child(self.pill(
                    format!("rule-op-{index}"),
                    op,
                    cx,
                    move |this, _window, cx| this.cycle_op(index, cx),
                ))
            })
            .child(div().flex_1().min_w_0().flex().child(value))
            .child(
                div()
                    .id(SharedString::from(format!("rule-remove-{index}")))
                    .size(px(26.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_full()
                    .cursor_pointer()
                    .role(gpui::Role::Button)
                    .aria_label(tr::library::remove_rule())
                    .hover(move |s| s.bg(p.hover))
                    .child(
                        svg()
                            .path("icons/minus.svg")
                            .size(px(13.))
                            .text_color(p.muted),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(editor) = this.editor.as_mut()
                            && index < editor.rows.len()
                        {
                            editor.rows.remove(index);
                        }
                        this.refresh_editor_count(cx);
                    })),
            )
            .into_any_element()
    }

    /// The field pill: next field, and a text box whenever the new field
    /// takes text (one is made if the row had none, as after Length or Has).
    fn cycle_field(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(row) = self.editor.as_ref().and_then(|e| e.rows.get(index)) else {
            return;
        };
        let text = row
            .value
            .as_ref()
            .map(|v| v.read(cx).text().to_string())
            .unwrap_or_default();
        let next = row.rule.next_field(text);
        let needs_input = next.takes_text() && row.value.is_none();
        let input =
            needs_input.then(|| Self::text_input("", tr::library::value_placeholder(), window, cx));
        if let Some(row) = self.editor.as_mut().and_then(|e| e.rows.get_mut(index)) {
            if !next.takes_text() {
                row.value = None;
            }
            if let Some(input) = input {
                row.value = Some(input);
            }
            row.rule = next;
        }
        self.refresh_editor_count(cx);
    }

    fn cycle_op(&mut self, index: usize, cx: &mut Context<Self>) {
        if let Some(row) = self.editor.as_mut().and_then(|e| e.rows.get_mut(index)) {
            match &mut row.rule {
                Rule::Title { op, .. } | Rule::Person { op, .. } | Rule::App { op, .. } => {
                    *op = match op {
                        TextOp::Contains => TextOp::Is,
                        TextOp::Is => TextOp::StartsWith,
                        TextOp::StartsWith => TextOp::DoesNotContain,
                        TextOp::DoesNotContain => TextOp::Contains,
                    }
                }
                Rule::Kind { op, .. } | Rule::Folder { op, .. } => {
                    *op = if *op == IsOp::Is {
                        IsOp::IsNot
                    } else {
                        IsOp::Is
                    }
                }
                Rule::Length { op, .. } => {
                    *op = if *op == LengthOp::LongerThan {
                        LengthOp::ShorterThan
                    } else {
                        LengthOp::LongerThan
                    }
                }
                Rule::Has { value, .. } | Rule::Pinned { value } => *value = !*value,
                _ => {}
            }
        }
        self.refresh_editor_count(cx);
    }

    fn render_editor(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let editor = self.editor.as_ref()?;
        let p = self.palette;
        let dark = p.dark;
        let today = today();
        let rows: Vec<AnyElement> = editor
            .rows
            .iter()
            .enumerate()
            .map(|(i, row)| self.render_rule_row(i, row, cx))
            .collect();
        let count = editor.count;
        let preview: Vec<AnyElement> = editor
            .preview
            .iter()
            .map(|&i| {
                let item = &self.scan.items[i as usize];
                let tint = style::kind_tint(item.kind, dark);
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(26.))
                    .text_size(px(12.5))
                    .child(
                        svg()
                            .path(kind_glyph(item.kind))
                            .size(px(13.))
                            .text_color(tint),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_color(p.text)
                            .child(item.title.clone()),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_color(p.faint)
                            .child(when_line(item, today)),
                    )
                    .into_any_element()
            })
            .collect();
        let matching = editor.matching;
        let sheet = div()
            .w(px(600.))
            .max_w_full()
            .flex()
            .flex_col()
            .gap(px(14.))
            .p(px(22.))
            .rounded(px(18.))
            .bg(p.popover)
            .border_1()
            .border_color(p.popover_border)
            .shadow(p.shadow())
            .child(
                div()
                    .text_size(px(17.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(if editor.editing.is_some() {
                        tr::library::edit_smart_folder()
                    } else {
                        tr::library::new_smart_folder()
                    }),
            )
            .child(
                TextInput::search(&self.theme, "smart-name", &editor.name)
                    .without_icon()
                    .text_color(p.text)
                    .placeholder_color(p.faint),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .text_color(p.muted)
                    .child(tr::library::match_prefix())
                    .child(self.pill(
                        "smart-matching",
                        if matching == Matching::All {
                            tr::library::match_all()
                        } else {
                            tr::library::match_any()
                        },
                        cx,
                        |this, _window, cx| {
                            if let Some(editor) = this.editor.as_mut() {
                                editor.matching = if editor.matching == Matching::All {
                                    Matching::Any
                                } else {
                                    Matching::All
                                };
                            }
                            this.refresh_editor_count(cx);
                        },
                    ))
                    .child(tr::library::match_suffix()),
            )
            .child(div().flex().flex_col().gap(px(8.)).children(rows))
            .child(
                div()
                    .id("rule-add")
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .h(px(28.))
                    .w_auto()
                    .cursor_pointer()
                    .text_size(px(13.))
                    .text_color(p.accent)
                    .child(
                        svg()
                            .path("icons/plus.svg")
                            .size(px(12.))
                            .text_color(p.accent),
                    )
                    .child(tr::library::add_rule())
                    .on_click(cx.listener(|this, _, window, cx| {
                        let row = Self::row_for(
                            Rule::Title {
                                op: TextOp::Contains,
                                value: String::new(),
                            },
                            window,
                            cx,
                        );
                        if let Some(editor) = this.editor.as_mut() {
                            editor.rows.push(row);
                        }
                        cx.notify();
                    })),
            )
            .child(div().h(px(1.)).bg(p.hairline))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(p.text)
                            .child(match count {
                                0 => tr::library::match_none().to_string(),
                                n => tr::library::match_count(n).to_string(),
                            }),
                    )
                    .children(preview),
            )
            .children(editor.error.map(|error| {
                div()
                    .text_size(px(12.5))
                    .text_color(p.danger)
                    .child(error.message())
            }))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .id("smart-cancel")
                            .h(px(32.))
                            .px(px(14.))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .bg(p.field)
                            .cursor_pointer()
                            .text_size(px(13.))
                            .child(tr::common::cancel())
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.editor = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .id("smart-save")
                            .h(px(32.))
                            .px(px(16.))
                            .flex()
                            .items_center()
                            .rounded_full()
                            .bg(p.accent)
                            .cursor_pointer()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui::white())
                            .child(if editor.editing.is_some() {
                                tr::common::save()
                            } else {
                                tr::library::create()
                            })
                            .on_click(cx.listener(|this, _, _, cx| this.save_editor(cx))),
                    ),
            );
        Some(
            div()
                .id("smart-editor-scrim")
                .absolute()
                .inset_0()
                .flex()
                .items_center()
                .justify_center()
                .bg(gpui::hsla(0., 0., 0., if dark { 0.45 } else { 0.18 }))
                .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
                .child(sheet)
                .into_any_element(),
        )
    }
}

impl Render for LibraryWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_theme(window, cx);
        if !self.first_paint {
            self.first_paint = true;
            let opened_at = self.opened_at;
            window.on_next_frame(move |_, _| {
                tracing::info!(
                    ms = opened_at.elapsed().as_secs_f64() * 1000.,
                    "library window first paint"
                );
            });
        }
        let model = self.sidebar_model();
        self.sidebar
            .update(cx, |sidebar, cx| sidebar.set_model(model, cx));
        let p = self.palette;
        let glass = self.glass();
        let radius = if glass {
            style::MATERIAL_RADIUS as f32
        } else {
            style::PLAIN_WINDOW_RADIUS
        };
        let body = match (&self.section, self.layout) {
            (Section::Home, Layout::Grid) if self.query.is_empty() => {
                self.render_home_gallery(window, cx)
            }
            (Section::Home, Layout::List) if self.query.is_empty() => self.render_home_calm(cx),
            _ => self.render_collection(window, cx),
        };
        let main = div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .flex_col()
            .child(self.render_toolbar(window, cx))
            .child(body);
        let main = match self.direction {
            Direction::Gallery => main.bg(p.content).into_any_element(),
            Direction::Calm => div()
                .flex_1()
                .min_w_0()
                .h_full()
                .py(px(style::PAGE_INSET))
                .pr(px(style::PAGE_INSET))
                .child(
                    main.rounded(px(style::PAGE_RADIUS))
                        .overflow_hidden()
                        .bg(p.content)
                        .shadow(style::card_shadow(p.dark)),
                )
                .into_any_element(),
        };
        let editor = self.render_editor(cx);
        // Pictures this frame asked for start decoding now; pictures that
        // left the cache leave the GPU atlas too.
        self.load_thumbs(cx);
        for image in self.thumbs.take_evicted() {
            window.drop_image(image).ok();
        }
        div()
            .id("library-window")
            .track_focus(&self.focus)
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .overflow_hidden()
            .rounded(px(radius))
            .when(!glass, |el| el.bg(p.sidebar))
            .when(glass && self.direction == Direction::Calm, |el| {
                el.bg(style::sidebar_wash(p.dark))
            })
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .text_color(p.text)
            .child(
                self.sidebar.clone().cached(
                    gpui::StyleRefinement::default()
                        .w(px(style::SIDEBAR_WIDTH))
                        .h_full()
                        .flex_shrink_0(),
                ),
            )
            .when(self.direction == Direction::Gallery, |el| {
                el.child(div().w(px(1.)).h_full().bg(p.hairline))
            })
            .child(main)
            .children(editor)
    }
}

#[cfg(test)]
mod save_tests {
    use super::*;

    fn folder(id: &str) -> SmartFolder {
        SmartFolder {
            id: id.into(),
            name: id.into(),
            matching: Matching::All,
            rules: vec![],
            extra: Default::default(),
        }
    }

    #[test]
    fn a_smart_folder_that_is_gone_sends_the_view_home() {
        let mut file = store::LibraryFile::default();
        file.smart_folders.push(folder("kept"));
        assert_eq!(
            section_after(&Section::Smart("kept".into()), &file),
            Section::Smart("kept".into())
        );
        assert_eq!(
            section_after(&Section::Smart("gone".into()), &file),
            Section::Home
        );
        assert_eq!(section_after(&Section::Trash, &file), Section::Trash);
    }

    #[test]
    fn read_only_and_failed_saves_say_different_things() {
        assert_eq!(
            SaveError::from_update(&store::UpdateError::ReadOnly),
            SaveError::ReadOnly
        );
        assert_eq!(
            SaveError::from_update(&store::UpdateError::Io("disk full".into())),
            SaveError::Failed
        );
        assert_ne!(SaveError::ReadOnly.message(), SaveError::Failed.message());
    }
}
