//! The Library: everything Cap keeps on this computer in one window, with a
//! source-list sidebar, a home made of the latest things, and folders that
//! are either filled by hand or by rules.

#[doc(hidden)]
pub mod app_icons;
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
pub mod visuals;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    rc::Rc,
    time::Instant,
};

use chrono::{Local, NaiveDate, Utc};
use gpui::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Entity, FocusHandle, FontWeight,
    Global, Hsla, InteractiveElement, IntoElement, ObjectFit, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, StyledImage as _, Subscription, Task, Window,
    WindowBackgroundAppearance, WindowBounds, WindowKind, WindowOptions, div, img,
    prelude::FluentBuilder, px, size, svg,
};

use self::items::{Item, ItemKey, ItemKind};
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
    ui::{
        KeptText, SharedTextCache, TextCache, TextInput, TextInputEvent, TextInputState, kept_text,
    },
};
use cap_meetings::apps::AppInfo;

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
    /// The meeting service its join link points at.
    app: Option<&'static AppInfo>,
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
    /// [`load::fingerprint`] of the scan on screen, before visuals and
    /// speaker names were added to it.
    scan_print: Option<u64>,
    /// The day smart folders were last evaluated for.
    evaluated_on: Option<NaiveDate>,
    /// Main-thread time spent taking in scans and their visuals, for the
    /// `rescan` bench.
    bench_main_us: f64,
    people_task: Option<Task<()>>,
    thumbs: thumbs::Thumbs,
    app_icons: app_icons::AppIcons,
    texts: SharedTextCache,
    list_scroll: gpui::UniformListScrollHandle,
    grid_scroll: gpui::UniformListScrollHandle,
    /// Kept across scans so a rescan puts them straight back on the new
    /// items instead of flashing the bare tiles.
    visuals: HashMap<ItemKey, visuals::Visual>,
    visuals_task: Option<Task<()>>,
    wave_images: std::cell::RefCell<visuals::WaveImages>,
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

/// What a rescan redoes besides taking the new items.
#[derive(Debug, PartialEq, Eq)]
struct Rescan {
    take_scan: bool,
    /// Date rules ("Today", "Last 7 days") move with the clock, not the disk.
    reevaluate: bool,
    /// A folder's members can vanish from places no scan lists, so they are
    /// checked every time; the check runs off the main thread.
    check_members: bool,
}

fn rescan_plan(same_scan: bool, evaluated_on: Option<NaiveDate>, today: NaiveDate) -> Rescan {
    Rescan {
        take_scan: !same_scan,
        reevaluate: !same_scan || evaluated_on != Some(today),
        check_members: true,
    }
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
            scan_print: None,
            evaluated_on: None,
            bench_main_us: 0.,
            people_task: None,
            thumbs: thumbs::Thumbs::default(),
            app_icons: app_icons::AppIcons::default(),
            texts: TextCache::shared(),
            list_scroll: gpui::UniformListScrollHandle::new(),
            grid_scroll: gpui::UniformListScrollHandle::new(),
            visuals: HashMap::new(),
            visuals_task: None,
            wave_images: Default::default(),
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
            let (scan, print) = cx
                .background_executor()
                .spawn(async move {
                    let scan = load::scan(for_scan);
                    let print = load::fingerprint(&scan);
                    (scan, print)
                })
                .await;
            tracing::info!(
                items = scan.items.len(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library scanned"
            );
            this.update(cx, |this, cx| {
                let applying = Instant::now();
                let mut scan = scan;
                let jobs = std::mem::take(&mut scan.visual_jobs);
                this.load_task = None;
                this.last_scan = Some(Instant::now());
                this.thumbs.forget_failures();
                let plan = rescan_plan(this.scan_print == Some(print), this.evaluated_on, today());
                // Nothing changed on disk (the window came back, or a meeting
                // event touched nothing listed here): keep what is on screen,
                // with its visuals and speaker names.
                if plan.take_scan {
                    this.scan_print = Some(print);
                    this.visuals.extend(std::mem::take(&mut scan.seed_visuals));
                    visuals::apply(&mut scan.items, &this.visuals, &HashMap::new());
                    this.scan = Rc::new(scan);
                }
                this.load_visuals(jobs, cx);
                if plan.reevaluate {
                    this.reevaluate(cx);
                }
                if plan.check_members {
                    this.check_members(cx);
                }
                this.index_people(library, cx);
                this.bench_main_us += applying.elapsed().as_secs_f64() * 1e6;
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
                let merging = Instant::now();
                this.merge_people(&scan, &names, cx);
                this.bench_main_us += merging.elapsed().as_secs_f64() * 1e6;
            })
            .ok();
        }));
    }

    fn merge_people(
        &mut self,
        scan: &std::rc::Weak<load::Scan>,
        names: &HashMap<String, Vec<String>>,
        cx: &mut Context<Self>,
    ) {
        // A newer scan replaced the items: its own pass will follow.
        let Some(current) = scan.upgrade() else {
            return;
        };
        if !Rc::ptr_eq(&current, &self.scan) {
            return;
        }
        drop(current);
        let Some(items) = with_people(&self.scan.items, names) else {
            return;
        };
        let mut next = (*self.scan).clone();
        next.items = items;
        self.scan = Rc::new(next);
        self.reevaluate(cx);
    }

    fn load_up_next(&mut self, cx: &mut Context<Self>) {
        if std::env::var_os("CAP_GPUI_LIBRARY_SEED").is_some() {
            self.up_next = Some(UpNext {
                title: "Design review: library".into(),
                start: Utc::now() + chrono::Duration::minutes(18),
                people: vec!["Ana Pérez".into(), "Bo Chen".into(), "Mia Novak".into()],
                app: cap_meetings::apps::app_by_id("zoom"),
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
                app: e.link.as_ref().and_then(|l| load::app_for_link(&l.url)),
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

    /// Two workers only: audio decodes are long and the window must stay
    /// responsive while a first open works through a big library.
    fn load_visuals(&mut self, jobs: Vec<visuals::Job>, cx: &mut Context<Self>) {
        if jobs.is_empty() {
            return;
        }
        let keep: Vec<ItemKey> = jobs.iter().map(|j| j.key.clone()).collect();
        let dir = visuals::cache_dir();
        self.visuals_task = Some(cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let cache = dir.clone();
            let (known, todo) = cx
                .background_spawn(async move { visuals::cached(jobs, &cache) })
                .await;
            let hits = known.len();
            if this
                .update(cx, |this, cx| this.merge_visuals(known, cx))
                .is_err()
            {
                return;
            }
            let misses = todo.len();
            if !todo.is_empty() {
                let frames = dir.join("library-frames");
                let (_workers, results) = crate::library::spawn_decode_pool_limited(
                    cx.background_executor(),
                    todo,
                    2,
                    move |(job, stamp): (visuals::Job, String)| {
                        let visual = visuals::work(&job, &frames);
                        Some((job.key, stamp, visual))
                    },
                );
                let mut done = Vec::new();
                while let Ok(first) = results.recv_async().await {
                    let mut batch = vec![first];
                    batch.extend(results.try_iter());
                    let found: HashMap<ItemKey, visuals::Visual> = batch
                        .iter()
                        .map(|(k, _, v)| (k.clone(), v.clone()))
                        .collect();
                    done.extend(batch);
                    if this
                        .update(cx, |this, cx| this.merge_visuals(found, cx))
                        .is_err()
                    {
                        return;
                    }
                }
                cx.background_spawn(async move { visuals::remember(&dir, &done, &keep) })
                    .await;
            }
            tracing::info!(
                hits,
                misses,
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library visuals ready"
            );
        }));
    }

    fn merge_visuals(&mut self, found: HashMap<ItemKey, visuals::Visual>, cx: &mut Context<Self>) {
        let merging = Instant::now();
        self.merge_visuals_timed(found, cx);
        self.bench_main_us += merging.elapsed().as_secs_f64() * 1e6;
    }

    fn merge_visuals_timed(
        &mut self,
        mut found: HashMap<ItemKey, visuals::Visual>,
        cx: &mut Context<Self>,
    ) {
        // Visuals already known were applied to the items when they were.
        found.retain(|key, visual| self.visuals.get(key) != Some(visual));
        if found.is_empty() {
            return;
        }
        let mut next = (*self.scan).clone();
        let changed = visuals::apply(&mut next.items, &found, &self.visuals);
        self.visuals.extend(found);
        if changed {
            self.scan = Rc::new(next);
            self.reevaluate(cx);
        }
        cx.notify();
    }

    /// Decodes the thumbnails the last render asked for, off the main thread,
    /// and draws again as they land (in batches, not one frame per picture).
    fn load_thumbs(&mut self, cx: &mut Context<Self>) {
        self.load_app_icons(cx);
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

    /// Reads the meeting apps' icons the last render asked for, off the main
    /// thread, once per app.
    fn load_app_icons(&mut self, cx: &mut Context<Self>) {
        let apps = self.app_icons.take_wanted();
        if apps.is_empty() {
            return;
        }
        cx.spawn(async move |this, cx| {
            let started = Instant::now();
            let found = cx
                .background_spawn(async move {
                    apps.into_iter()
                        .map(|app| {
                            let image = app_icons::lookup(app, app_icons::ICON_PX)
                                .map(crate::library::rgba_to_render_image);
                            (app, image)
                        })
                        .collect::<Vec<_>>()
                })
                .await;
            tracing::info!(
                apps = found.len(),
                found = found.iter().filter(|(_, i)| i.is_some()).count(),
                ms = started.elapsed().as_secs_f64() * 1000.,
                "library app icons read"
            );
            this.update(cx, |this, cx| {
                for (app, image) in found {
                    this.app_icons.insert(app, image);
                }
                cx.notify();
            })
            .ok();
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
        self.evaluated_on = Some(today());
        self.membership = index::Membership::from_file(&self.file);
        let folders = self.file.smart_folders.clone();
        let members = {
            let holds = |id: &str, item: &Item| self.in_folder(id, item);
            let ctx = EvalContext {
                today: today(),
                local_day: &crate::meetings_ui::documents::store::local_day,
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
            local_day: &crate::meetings_ui::documents::store::local_day,
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

/// Where a list row says when.
#[derive(Clone, Copy, PartialEq, Eq)]
enum When {
    /// Its own column, with the date: rows with no day heading over them.
    Full,
    /// Its own column, time only: the day heading above already says which day.
    Time,
    /// Folded into the meta line, so a narrow row's title gets the width.
    Inline,
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
    // A meeting rebuilt from its folder has no details worth listing; say so
    // once instead of a bare "Meeting".
    if item.damaged {
        return tr::library::damaged().to_string();
    }
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
    fn text(&self, text: impl Into<SharedString>) -> KeptText {
        kept_text(&self.texts, text)
    }

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
                   label: SharedString,
                   count: Option<usize>,
                   section: Section| Row::Nav {
            id,
            icon,
            label,
            count,
            section,
        };
        let mut rows = vec![nav(
            "nav-home".into(),
            "icons/layers.svg",
            tr::library::title().into(),
            None,
            Section::Home,
        )];
        for kind in [KindView::Recordings, KindView::Screenshots, KindView::Notes] {
            let section = Section::Kind(kind);
            rows.push(nav(
                SharedString::from(format!("nav-{}", kind.label())),
                kind.icon(),
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
                    .child(self.text(title)),
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
                    .child(self.text(tr::library::new()))
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.defer(crate::meetings_ui::documents::new_note);
                    })),
            )
            .into_any_element()
    }

    /// An installed app's icon at `size` points, nothing for the moment it
    /// is looked up or when the app is not on this computer.
    fn app_icon(&self, app: &'static AppInfo, size: f32) -> Option<AnyElement> {
        match self.app_icons.get(app) {
            app_icons::Icon::Image(image) => {
                Some(img(image).size(px(size)).flex_shrink_0().into_any_element())
            }
            app_icons::Icon::Pending => {
                Some(div().size(px(size)).flex_shrink_0().into_any_element())
            }
            app_icons::Icon::Missing => None,
        }
    }

    fn kind_mark(&self, kind: ItemKind, size: f32) -> AnyElement {
        let p = self.palette;
        svg()
            .path(kind_glyph(kind))
            .size(px(size))
            .flex_shrink_0()
            .text_color(p.muted)
            .into_any_element()
    }

    /// A calendar leaf: the month on a red band over the day, with the
    /// meeting app's icon tucked in its corner when this computer has it.
    fn date_leaf(
        &self,
        start: chrono::DateTime<Utc>,
        w: f32,
        app: Option<&'static AppInfo>,
    ) -> AnyElement {
        use chrono::Datelike as _;
        let p = self.palette;
        let dark = p.dark;
        let local = format::local(start);
        let h = (w * 1.12).round();
        let band = (w * 0.3).round();
        let radius = (w * 0.22).round();
        // Big enough to read the app at list size (20 pt on a 32 pt leaf).
        let badge = (w * 0.62).round();
        let icon = app.and_then(|app| match self.app_icons.get(app) {
            app_icons::Icon::Image(image) => Some(image),
            _ => None,
        });
        div()
            .relative()
            .flex_shrink_0()
            .w(px(w))
            .h(px(h))
            .flex()
            .flex_col()
            .rounded(px(radius))
            .bg(style::leaf_face(dark))
            .border_1()
            .border_color(style::capsule_border(dark))
            .child(
                div()
                    .h(px(band))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_t(px(radius - 1.))
                    .bg(style::calendar_red(dark))
                    .text_size(px((band * 0.66).max(8.)))
                    .line_height(px(band))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(gpui::white())
                    .child(self.text(format::month_short(local.month()))),
            )
            .child(
                div()
                    .flex_1()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px((w * 0.44).round()))
                    .line_height(px((w * 0.5).round()))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(p.text)
                    .child(self.text(local.day().to_string())),
            )
            .children(icon.map(|image| {
                img(image)
                    .absolute()
                    .right(px(-badge * 0.55))
                    .bottom(px(-badge * 0.4))
                    .size(px(badge))
            }))
            .into_any_element()
    }

    /// No extra elements and no fade: a fade repainted the window for every
    /// batch of pictures that landed. `None` when the file is missing or
    /// unreadable, so the caller draws something else.
    fn picture(&self, item: &Item, path: &Path, height: f32, radius: f32) -> Option<gpui::Div> {
        let dark = self.palette.dark;
        let image = match self.thumbs.picture(path) {
            thumbs::Picture::Failed => return None,
            thumbs::Picture::Loading => None,
            thumbs::Picture::Ready(image) => Some(image),
        };
        Some(
            div()
                .relative()
                .w_full()
                .h(px(height))
                .rounded(px(radius))
                .overflow_hidden()
                .bg(if image.is_none() {
                    style::well(dark)
                } else {
                    style::thumb_well(dark)
                })
                .children(image.map(|image| {
                    img(image)
                        .absolute()
                        .inset_0()
                        .size_full()
                        .object_fit(ObjectFit::Cover)
                })),
        )
    }

    fn wave(&self, item: &Item) -> Option<visuals::Wave> {
        self.visuals.get(&item.key)?.wave.clone()
    }

    /// One element painting quads: a div per bar cost a layout node each.
    fn wave_bars(&self, wave: visuals::Wave, height: f32, bar: f32) -> gpui::Canvas<()> {
        let color = style::wave_ink(&self.palette);
        gpui::canvas(
            |_, _, _| (),
            move |bounds, (), window, _| {
                let w = f32::from(bounds.size.width);
                let h = f32::from(bounds.size.height);
                let gap = bar;
                let n = (((w + gap) / (bar + gap)).floor() as usize).clamp(1, visuals::BARS);
                let total = n as f32 * (bar + gap) - gap;
                let x0 = f32::from(bounds.origin.x) + ((w - total) / 2.).max(0.);
                let mid = f32::from(bounds.origin.y) + f32::from(bounds.size.height) / 2.;
                for i in 0..n {
                    let from = i * visuals::BARS / n;
                    let to = ((i + 1) * visuals::BARS / n).max(from + 1);
                    let v = wave[from..to].iter().copied().max().unwrap_or(0);
                    let bh = (h * (0.08 + 0.92 * f32::from(v) / 255.)).max(bar);
                    window.paint_quad(
                        gpui::fill(
                            gpui::Bounds::new(
                                gpui::point(px(x0 + i as f32 * (bar + gap)), px(mid - bh / 2.)),
                                gpui::size(px(bar), px(bh)),
                            ),
                            color,
                        )
                        .corner_radii(gpui::Corners::all(px(bar / 2.))),
                    );
                }
            },
        )
        .w_full()
        .h(px(height))
        .flex_shrink_0()
    }

    fn thumb(&self, item: &Item, height: f32, radius: f32) -> AnyElement {
        if let Some(well) = item
            .thumbnail
            .as_deref()
            .and_then(|path| self.picture(item, path, height, radius))
        {
            return well
                .when_some(
                    item.duration_ms
                        .filter(|_| item.kind == ItemKind::Recording),
                    |el, ms| el.child(self.length_badge(ms, true)),
                )
                .into_any_element();
        }
        self.media(item, height, radius)
    }

    fn length_badge(&self, ms: u64, on_picture: bool) -> AnyElement {
        let p = self.palette;
        div()
            .absolute()
            .right(px(8.))
            .bottom(px(8.))
            .px(px(5.))
            .py(px(1.))
            .rounded(px(5.))
            .when(on_picture, |el| el.bg(gpui::hsla(0., 0., 0., 0.5)))
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(if on_picture { gpui::white() } else { p.muted })
            .child(self.text(format::duration(ms)))
            .into_any_element()
    }

    fn media(&self, item: &Item, height: f32, radius: f32) -> AnyElement {
        let p = self.palette;
        let dark = p.dark;
        let big = height > 220.;
        let pad = if big { 20. } else { 14. };
        let wave = self.wave(item);
        let surface = div()
            .relative()
            .w_full()
            .h(px(height))
            .rounded(px(radius))
            .overflow_hidden()
            .bg(style::well(dark))
            .border_1()
            .border_color(p.hairline)
            .p(px(pad))
            .flex()
            .flex_col();
        let title_first = |surface: gpui::Div| {
            surface
                .child(
                    div()
                        .text_size(px(if big { 22. } else { 16. }))
                        .line_height(px(if big { 28. } else { 21. }))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(p.text)
                        .line_clamp(3)
                        .text_ellipsis()
                        .child(self.text(item.title.clone())),
                )
                .into_any_element()
        };
        match item.kind {
            ItemKind::Note => match &item.excerpt {
                Some(text) => {
                    let line_h = if big { 26. } else { 20. };
                    let lines = (((height - pad * 2.) / line_h).floor() as usize).clamp(1, 8);
                    surface
                        .child(
                            div()
                                .w_full()
                                .text_size(px(if big { 17. } else { 13.5 }))
                                .line_height(px(line_h))
                                .text_color(p.text)
                                .line_clamp(lines)
                                .text_ellipsis()
                                .child(self.text(text.clone())),
                        )
                        .into_any_element()
                }
                None => title_first(surface),
            },
            ItemKind::Meeting => {
                let app = item
                    .meeting_app
                    .and_then(|app| self.app_icon(app, if big { 20. } else { 16. }));
                let who = if item.people.is_empty() {
                    item.meeting_app.map(|app| app.name.to_string())
                } else if item.people.len() == 1 {
                    Some(item.people[0].clone())
                } else {
                    let names: Vec<&str> = item
                        .people
                        .iter()
                        .take(3)
                        .map(|n| n.split(' ').next().unwrap_or(n))
                        .collect();
                    let extra = item.people.len().saturating_sub(names.len());
                    Some(if extra > 0 {
                        format!("{} +{extra}", names.join(", "))
                    } else {
                        names.join(", ")
                    })
                };
                let who = who.map(|who| {
                    div()
                        .truncate()
                        .text_size(px(12.))
                        .line_height(px(20.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(p.muted)
                        .child(self.text(who))
                });
                let header: Option<AnyElement> = match (app, who) {
                    (Some(app), Some(who)) => Some(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .h(px(20.))
                            .flex_shrink_0()
                            .child(app)
                            .child(who.flex_1().min_w_0())
                            .into_any_element(),
                    ),
                    (Some(app), None) => Some(app),
                    (None, Some(who)) => Some(who.flex_shrink_0().into_any_element()),
                    (None, None) => None,
                };
                let wave_h = if big { 40. } else { 26. };
                let has_header = header.is_some();
                let mut surface = surface.children(header);
                match (&item.excerpt, wave) {
                    (Some(text), wave) => {
                        let line_h = if big { 24. } else { 19. };
                        let room = height
                            - pad * 2.
                            - if has_header { 28. } else { 0. }
                            - if wave.is_some() { wave_h + 10. } else { 0. };
                        let lines = ((room / line_h).floor() as usize).clamp(1, 5);
                        surface = surface.child(
                            div()
                                .w_full()
                                .when(has_header, |el| el.mt(px(8.)))
                                .text_size(px(if big { 16. } else { 13. }))
                                .line_height(px(line_h))
                                .text_color(p.text)
                                .line_clamp(lines)
                                .text_ellipsis()
                                .child(self.text(text.clone())),
                        );
                        if let Some(wave) = wave {
                            surface = surface.child(
                                self.wave_bars(wave, wave_h, if big { 3. } else { 2. })
                                    .mt_auto(),
                            );
                        }
                        surface.into_any_element()
                    }
                    (None, Some(wave)) => surface
                        .child(
                            self.wave_bars(
                                wave,
                                (height * 0.42).round(),
                                if big { 4. } else { 3. },
                            )
                            .my_auto(),
                        )
                        .when_some(item.duration_ms, |el, ms| {
                            el.child(self.length_badge(ms, false))
                        })
                        .into_any_element(),
                    (None, None) => title_first(surface),
                }
            }
            ItemKind::Recording | ItemKind::Screenshot => match wave {
                Some(wave) => surface
                    .items_center()
                    .justify_center()
                    .child(self.wave_bars(wave, (height * 0.42).round(), if big { 4. } else { 3. }))
                    .when_some(item.duration_ms, |el, ms| {
                        el.child(self.length_badge(ms, false))
                    })
                    .into_any_element(),
                None => title_first(surface),
            },
        }
    }

    /// One size for every row so titles line up.
    fn lead(&self, item: &Item) -> AnyElement {
        let p = self.palette;
        let (w, h, radius) = (style::LEAD_WIDTH, style::LEAD_HEIGHT, style::LEAD_RADIUS);
        if let Some(well) = item
            .thumbnail
            .as_deref()
            .and_then(|path| self.picture(item, path, h, radius))
        {
            return well.w(px(w)).flex_shrink_0().into_any_element();
        }
        let well = div()
            .w(px(w))
            .h(px(h))
            .flex_shrink_0()
            .rounded(px(radius))
            .overflow_hidden()
            .bg(style::well(p.dark))
            .border_1()
            .border_color(p.hairline);
        if let Some(wave) = self.wave(item) {
            let (iw, ih) = (w - 12., (h * 0.7).round());
            let image =
                self.wave_images
                    .borrow_mut()
                    .get(&wave, p.dark, (iw, ih), style::wave_ink(&p));
            return well
                .flex()
                .items_center()
                .justify_center()
                .child(img(image).w(px(iw)).h(px(ih)))
                .into_any_element();
        }
        let (text, weight) = match (&item.excerpt, item.kind) {
            (Some(text), ItemKind::Note) => (text.clone(), FontWeight::NORMAL),
            _ => (item.title.clone(), FontWeight::SEMIBOLD),
        };
        well.px(px(6.))
            .py(px(5.))
            .text_size(px(7.))
            .line_height(px(9.))
            .font_weight(weight)
            .text_color(Hsla { a: 0.72, ..p.text })
            .line_clamp(3)
            .text_ellipsis()
            .child(self.text(text))
            .into_any_element()
    }

    /// Flat on purpose: half of a magazine page's first frame is Taffy
    /// layout, so each card is its media, its title and its meta line.
    fn card(&self, index: u32, width: f32, thumb_h: f32, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let item = &self.scan.items[index as usize];
        let today = today();
        let title = div()
            .truncate()
            .text_size(px(13.5))
            .font_weight(FontWeight::MEDIUM)
            .text_color(p.text)
            .child(self.text(item.title.clone()));
        let title = if item.pinned {
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(title.flex_1().min_w_0())
                .child(
                    svg()
                        .path("icons/pin.svg")
                        .size(px(11.))
                        .text_color(p.faint),
                )
        } else {
            title
        };
        div()
            .id(SharedString::from(format!("card-{index}")))
            .w(px(width))
            .flex_shrink_0()
            .flex()
            .flex_col()
            .p(px(6.))
            .rounded(px(style::CARD_RADIUS + 4.))
            .cursor_pointer()
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(item.title.clone()))
            .hover(move |s| s.bg(p.hover))
            .child(self.thumb(item, thumb_h, style::MEDIA_RADIUS))
            .child(title.mt(px(8.)).px(px(4.)))
            .child(
                div()
                    .mt(px(2.))
                    .px(px(4.))
                    .truncate()
                    .text_size(px(12.))
                    .text_color(p.muted)
                    .child(self.text(format!(
                        "{}  ·  {}",
                        when_line(item, today),
                        meta_line(item)
                    ))),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.open_item(index, cx)))
            .into_any_element()
    }

    fn list_row(&self, index: u32, when: When, cx: &mut Context<Self>) -> AnyElement {
        let p = self.palette;
        let item = &self.scan.items[index as usize];
        let today = today();
        let leading = self.lead(item);
        div()
            .id(SharedString::from(format!("row-{index}")))
            .w_full()
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
                            .child(self.text(item.title.clone())),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(12.))
                            .text_color(p.muted)
                            .child(self.text(match when {
                                When::Inline => {
                                    let local = format::local(item.at);
                                    let day = if local.date() == today {
                                        format::clock(local)
                                    } else {
                                        format::short_date(local.date(), today)
                                    };
                                    format!("{day}  ·  {}", meta_line(item))
                                }
                                When::Full | When::Time => meta_line(item),
                            })),
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
            .when(when != When::Inline, |el| {
                el.child(
                    div()
                        .flex_shrink_0()
                        .text_size(px(12.))
                        .text_color(p.faint)
                        .child(self.text(if when == When::Time {
                            format::clock(format::local(item.at))
                        } else {
                            when_line(item, today)
                        })),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.open_item(index, cx)))
            .into_any_element()
    }

    fn heading(&self, text: impl Into<SharedString>) -> gpui::Div {
        div()
            .mt(px(24.))
            .mb(px(8.))
            .px(px(4.))
            .text_size(px(13.))
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(self.palette.muted)
            .child(self.text(text))
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
        let tint = p.accent;
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
                .child(self.date_leaf(next.start, 34., next.app))
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
                                .child(self.text(when)),
                        )
                        .child(
                            div()
                                .truncate()
                                .text_size(px(14.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(p.text)
                                .child(self.text(next.title.clone())),
                        )
                        .when(!next.people.is_empty(), |el| {
                            el.child(
                                div()
                                    .truncate()
                                    .text_size(px(12.))
                                    .text_color(p.muted)
                                    .child(self.text(next.people.join(", "))),
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
                        .child(self.text(tr::library::take_notes())),
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
                    .child(self.card(hero, hero_w, hero_h, cx))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .pt(px(2.))
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .children(side.into_iter().map(|i| self.list_row(i, When::Inline, cx))),
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
                        div()
                            .id(SharedString::from(format!("pin-{i}")))
                            .role(gpui::Role::Button)
                            .aria_label(SharedString::from(item.title.clone()))
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
                                item.meeting_app
                                    .and_then(|app| self.app_icon(app, 16.))
                                    .unwrap_or_else(|| self.kind_mark(item.kind, 13.)),
                            )
                            .child(self.text(item.title.clone()))
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
            page = page.child(self.list_row(i, When::Time, cx));
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
        div()
            .flex()
            .flex_col()
            .gap(px(style::GRID_GAP))
            .children(
                indexes
                    .chunks(cols)
                    .map(|row| self.grid_row(row, width, cx)),
            )
            .into_any_element()
    }

    fn grid_row(&self, row: &[u32], width: f32, cx: &mut Context<Self>) -> gpui::Div {
        let cols = self.columns(width);
        let tile = (width - style::GRID_GAP * (cols as f32 - 1.)) / cols as f32;
        div()
            .flex()
            .gap(px(style::GRID_GAP))
            .children(row.iter().map(|&i| self.card(i, tile, tile * 0.6, cx)))
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
                        let rows = range
                            .map(|r| this.list_row(visible[r], When::Full, cx))
                            .collect();
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
                                this.grid_row(&visible[start..end], width, cx)
                                    .pb(px(style::GRID_GAP))
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
        let label: SharedString = label.into();
        div()
            .id(id.into())
            // Each press moves the rule to its next value, so a screen
            // reader hears the new value as the button's name.
            .role(gpui::Role::Button)
            .aria_label(label.clone())
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
            .child(label)
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
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .h(px(26.))
                    .text_size(px(12.5))
                    .child(self.kind_mark(item.kind, 13.))
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
                    .role(gpui::Role::Button)
                    .aria_label(tr::library::add_rule())
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
                            .role(gpui::Role::Button)
                            .aria_label(tr::common::cancel())
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
                            .role(gpui::Role::Button)
                            .aria_label(if editor.editing.is_some() {
                                tr::common::save()
                            } else {
                                tr::library::create()
                            })
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
        self.texts.borrow_mut().next_frame();
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
        let waves = self.wave_images.get_mut().take_evicted();
        for image in self.thumbs.take_evicted().into_iter().chain(waves) {
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

/// The items with the speaker names their transcripts give now: names an
/// earlier read gave are replaced, so a renamed speaker leaves search and
/// smart folders under the old name, and names from a meeting's saved guests
/// and attendees stay. `None` when nothing changes: after a rescan that
/// found nothing new, nothing is copied.
fn with_people(items: &[Item], names: &HashMap<String, Vec<String>>) -> Option<Vec<Item>> {
    let heard = |item: &Item| match &item.key {
        items::ItemKey::Doc(id) => names.get(id),
        _ => None,
    };
    if !items
        .iter()
        .any(|item| heard(item).is_some_and(|found| item.heard_differs(found)))
    {
        return None;
    }
    let mut next = items.to_vec();
    for item in &mut next {
        if let Some(found) = heard(item) {
            item.set_heard(found);
        }
    }
    Some(next)
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
    fn an_unchanged_rescan_after_midnight_moves_today_items_out() {
        let monday = NaiveDate::from_ymd_opt(2026, 11, 23).unwrap();
        let tuesday = monday.succ_opt().unwrap();
        // Nothing on disk changed and the folders were evaluated today: only
        // the members are checked.
        assert_eq!(
            rescan_plan(true, Some(monday), monday),
            Rescan {
                take_scan: false,
                reevaluate: false,
                check_members: true
            }
        );
        // The day turned: evaluated again, with nothing on disk changed.
        assert!(rescan_plan(true, Some(monday), tuesday).reevaluate);
        assert!(rescan_plan(true, None, monday).reevaluate);
        assert!(rescan_plan(false, Some(monday), monday).take_scan);

        let mut today_folder = folder("today");
        today_folder.rules = vec![Rule::Date {
            range: DateRange::Today,
        }];
        let item = Item::new(
            items::ItemKey::Doc("standup".into()),
            ItemKind::Meeting,
            "Standup",
            chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 11, 23, 9, 0, 0).unwrap(),
            items::ItemFacts::default(),
        );
        let utc_day = |at: chrono::DateTime<Utc>| at.date_naive();
        let none = |_: &str, _: &Item| false;
        let members = |today| {
            rules::evaluate_all(
                std::slice::from_ref(&today_folder),
                std::slice::from_ref(&item),
                &EvalContext {
                    today,
                    local_day: &utc_day,
                    in_folder: &none,
                },
            )
            .remove("today")
            .unwrap_or_default()
        };
        assert_eq!(members(monday), vec![0]);
        assert!(members(tuesday).is_empty());
    }

    /// Renaming a speaker who is not a guest ("Alex" to "Sam") changes only
    /// the transcript. The next rescan replaces the name the transcript gave
    /// before: the old name leaves search and speaker smart folders, the
    /// meeting's saved guest stays, and an unchanged rescan copies nothing.
    #[test]
    fn a_renamed_speaker_leaves_search_and_smart_folders() {
        use cap_meetings::transcript::{LogLine, Source, Utterance, append_jsonl};
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("transcript.jsonl");
        let cache = dir.path().join(people::CACHE_FILE);
        let named = |name: &str| {
            let mut names = cap_diarize::SpeakerNames::new(None);
            names.observe(&[cap_diarize::SpeakerInfo {
                id: cap_diarize::SpeakerId(2),
                track: cap_diarize::Track::System,
                first_ms: 0,
                speech_ms: 1_000,
                is_user: false,
            }]);
            names.rename(cap_diarize::SpeakerId(2), name);
            LogLine::SpeakerNames { names }
        };
        append_jsonl(
            &transcript,
            &[
                named("Alex"),
                LogLine::Upsert {
                    utterance: Utterance {
                        id: "s1".into(),
                        source: Source::System,
                        speaker_id: Some(2),
                        end_ms: 1_000,
                        text: "Shipping Friday.".into(),
                        is_final: true,
                        ..Utterance::default()
                    },
                },
            ],
        )
        .unwrap();
        let docs = vec![("sync".to_string(), transcript.clone())];
        let item = Item::new(
            items::ItemKey::Doc("sync".into()),
            ItemKind::Meeting,
            "Sync",
            Utc::now(),
            items::ItemFacts {
                people: vec!["Ana Ruiz".into()],
                ..Default::default()
            },
        );
        let first = with_people(&[item], &people::index(&docs, &cache)).unwrap();
        assert_eq!(first[0].people, ["Ana Ruiz", "Alex"]);

        append_jsonl(&transcript, &[named("Sam")]).unwrap();
        let names = people::index(&docs, &cache);
        let renamed = with_people(&first, &names).unwrap();
        assert_eq!(renamed[0].people, ["Ana Ruiz", "Sam"]);
        assert!(!renamed[0].matches_query("alex"));
        assert!(renamed[0].matches_query("sam") && renamed[0].matches_query("ana"));
        let speaker = |value: &str| {
            let mut folder = folder("speaker");
            folder.rules = vec![Rule::Person {
                op: rules::TextOp::Contains,
                value: value.into(),
            }];
            let utc_day = |at: chrono::DateTime<Utc>| at.date_naive();
            let none = |_: &str, _: &Item| false;
            rules::evaluate_all(
                std::slice::from_ref(&folder),
                &renamed,
                &EvalContext {
                    today: Utc::now().date_naive(),
                    local_day: &utc_day,
                    in_folder: &none,
                },
            )
            .remove("speaker")
            .unwrap_or_default()
        };
        assert!(speaker("alex").is_empty());
        assert_eq!(speaker("sam"), vec![0]);
        assert_eq!(speaker("ana"), vec![0]);
        assert!(with_people(&renamed, &names).is_none(), "nothing changed");
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
