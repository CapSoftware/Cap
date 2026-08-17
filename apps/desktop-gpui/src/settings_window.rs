//! The settings window: sidebar, General page, Tauri-compatible store.
//!
//! Transcribed from `apps/desktop/src/routes/(window-chrome)/settings.tsx`
//! (the shell), `settings/general.tsx` (the page), `settings/Setting.tsx` (the
//! section/card/row primitives) and the `[data-macos-native-material="settings"]`
//! block of `apps/desktop/src/styles/theme.css`, which is what actually sizes
//! this window's chrome -- most of the Tailwind on the elements is overridden
//! there, so the CSS wins wherever the two disagree and the quoted rule next to
//! each metric says which one it is.
//!
//! Every value the General page writes goes into the same tauri-plugin-store
//! file the shipping app uses, one key at a time, through
//! [`crate::store::set_store_setting`].

use std::{cell::Cell, path::PathBuf, rc::Rc, sync::Arc, time::Duration};

use gpui::{
    AppContext as _, Bounds, Context, Entity, FocusHandle, FontWeight, Hsla, InteractiveElement,
    IntoElement, MouseButton,
    ParentElement, Pixels, Point, Render, RenderImage, SharedString, StatefulInteractiveElement,
    Styled, Window, div, img, prelude::FluentBuilder, px, rgb, svg,
};
use serde_json::Value;

use crate::{
    devices::WindowOption,
    library::{self, RecordingItem, RecordingMode},
    ui,
    store::{
        self, AppTheme, DEFAULT_PROJECT_NAME_TEMPLATE, DEFAULT_SERVER_URL, GENERAL_SETTINGS,
        GeneralSettings, MainWindowStartBehaviour, PostDeletionBehaviour, PostStudioBehaviour,
        RECORDING_START_SAFETY, SettingsEnum, StudioQuality, UpdateChannel, WindowExclusion,
    },
    theme::{Appearance, Theme},
};

/// `.inner_size(782.0, 775.0)` / `.min_inner_size(780.0, 560.0)` on the
/// `ShowCapWindow::Settings` builder in `windows.rs`.
pub const SETTINGS_WIDTH: f32 = 782.;
pub const SETTINGS_HEIGHT: f32 = 775.;
pub const SETTINGS_MIN_WIDTH: f32 = 780.;
pub const SETTINGS_MIN_HEIGHT: f32 = 560.;

/// `CapWindowId::Settings::traffic_lights_position` -- `Some(Some(
/// LogicalPosition::new(22.0, 22.0)))`. Unlike the main window these are the
/// *real* AppKit buttons, repositioned; `(window-chrome).tsx` returns `null`
/// for its own header on the settings route, so there is nothing hand-drawn to
/// mirror here. The Tauri inset resolves to a top-left of
/// `(inset.x, inset.y / 2 + 4)` (see `editor_window::TRAFFIC_LIGHTS` for the
/// `position_window_controls` derivation), and gpui takes the literal
/// top-left: (22, 22) -> (22, 15).
pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(22.),
    y: px(15.),
};

/// `applyMacOSWindowMaterial("settings")` -> `radius = 26` under liquid glass.
/// The vibrancy fallback uses 16, which is also `--macos-settings-window-radius`
/// in the `:root` block; the material install is told 26 either way because
/// `install_window_material` only uses it for the glass view's own corner and
/// the content-view clip, and the vibrancy path re-clips to the same rect.
pub const SETTINGS_MATERIAL_RADIUS: f64 = 26.;

// -- Sidebar/content metrics, all `:root` custom properties -----------------

/// `--macos-settings-sidebar-width: 227px`.
const SIDEBAR_WIDTH: f32 = 227.;
/// `--macos-settings-sidebar-padding-x: 10px`.
const SIDEBAR_PADDING_X: f32 = 10.;
/// `--macos-settings-content-padding-x: 16px`.
const CONTENT_PADDING_X: f32 = 16.;
/// `.cap-settings-window-spacer { height: calc(
///  var(--macos-settings-window-header-height) -
///  var(--macos-settings-sidebar-wrapper-padding)) }` -- 52 - 8. The strip the
/// repositioned traffic lights sit in.
const SIDEBAR_SPACER: f32 = 44.;

/// The sidebar list, in `settingsItems` order. `href` is the route segment,
/// which is also what `showWindow({ Settings: { page } })` takes.
///
/// Nothing in the list is gated: `settingsItems` is a plain array with no
/// `Show`, no platform check and no plan check, so a free user on Windows sees
/// the same twelve rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    General,
    Shortcuts,
    Cli,
    Recordings,
    Screenshots,
    Automations,
    Transcription,
    Integrations,
    License,
    Experimental,
    Feedback,
    Changelog,
}

impl Page {
    pub const ALL: &'static [Page] = &[
        Page::General,
        Page::Shortcuts,
        Page::Cli,
        Page::Recordings,
        Page::Screenshots,
        Page::Automations,
        Page::Transcription,
        Page::Integrations,
        Page::License,
        Page::Experimental,
        Page::Feedback,
        Page::Changelog,
    ];

    /// The `name` field. Note "Shortcuts" for the `hotkeys` route -- the label
    /// and the route disagree in the shipping app.
    fn label(self) -> &'static str {
        match self {
            Self::General => "General",
            Self::Shortcuts => "Shortcuts",
            Self::Cli => "CLI",
            Self::Recordings => "Recordings",
            Self::Screenshots => "Screenshots",
            Self::Automations => "Automations",
            Self::Transcription => "Transcription",
            Self::Integrations => "Integrations",
            Self::License => "License",
            Self::Experimental => "Experimental",
            Self::Feedback => "Feedback",
            Self::Changelog => "Changelog",
        }
    }

    /// The `href`, i.e. the `page` argument of `showWindow`.
    pub fn slug(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Shortcuts => "hotkeys",
            Self::Cli => "cli",
            Self::Recordings => "recordings",
            Self::Screenshots => "screenshots",
            Self::Automations => "automations",
            Self::Transcription => "transcription",
            Self::Integrations => "integrations",
            Self::License => "license",
            Self::Experimental => "experimental",
            Self::Feedback => "feedback",
            Self::Changelog => "changelog",
        }
    }

    /// The `icon` field. Cap's own icon set where the TSX uses `IconCap*`,
    /// Lucide's where it uses `IconLucide*` -- except Screenshots, whose
    /// `IconLucideImage` is served by the Cap picture glyph already embedded
    /// for the main window's screenshots button.
    fn icon(self) -> &'static str {
        match self {
            Self::General | Self::Experimental => "icons/settings.svg",
            Self::Shortcuts => "icons/hotkeys.svg",
            Self::Cli => "icons/terminal.svg",
            Self::Recordings => "icons/square-play.svg",
            Self::Screenshots => "icons/image.svg",
            Self::Automations => "icons/zap.svg",
            Self::Transcription => "icons/captions.svg",
            Self::Integrations => "icons/unplug.svg",
            Self::License => "icons/gift.svg",
            Self::Feedback => "icons/message-square-plus.svg",
            Self::Changelog => "icons/bell.svg",
        }
    }

    /// What the page is for, for the placeholder body. Not a string from the
    /// TSX -- those pages are whole routes, not one description -- so it is
    /// written here rather than quoted.
    fn blurb(self) -> &'static str {
        match self {
            Self::General => "",
            Self::Shortcuts => {
                "Global shortcuts for starting, stopping and restarting a recording."
            }
            Self::Cli => "Install the `cap` command and mint API keys for it.",
            Self::Recordings => "Your recordings library.",
            Self::Screenshots => "Your screenshots library.",
            Self::Automations => "Run an action when a recording finishes.",
            Self::Transcription => "The transcription model, language and custom vocabulary.",
            Self::Integrations => "Connect Cap to the other tools you use.",
            Self::License => "Your commercial license key.",
            Self::Experimental => "Features that are still being tried out.",
            Self::Feedback => "Tell us what is broken or missing.",
            Self::Changelog => "What changed in each release.",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|page| page.slug() == slug)
    }
}

/// A popup list standing in for the native `Menu.popup()` the selects use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MenuKind {
    Countdown,
    MainWindowStart,
    PostStudio,
    PostDeletion,
    MaxFps,
    /// The excluded-windows card's Add button, whose menu is the live window
    /// list rather than a fixed option set.
    AddWindow,
}

struct OpenMenu {
    kind: MenuKind,
    /// Anchor, row count and keyboard highlight. `Menu.popup()` with no
    /// position argument opens at the pointer, so the origin is the faithful
    /// anchor; the highlight is what makes arrows and Enter work.
    state: ui::MenuState,
}

/// `MAX_FPS_OPTIONS` in general.tsx.
const MAX_FPS_OPTIONS: &[(u32, &str)] = &[
    (24, "24 FPS"),
    (25, "25 FPS"),
    (30, "30 FPS"),
    (60, "60 FPS (Recommended)"),
    (120, "120 FPS"),
];

/// The Countdown select's options.
const COUNTDOWN_OPTIONS: &[(u32, &str)] = &[
    (0, "Off"),
    (3, "3 seconds"),
    (5, "5 seconds"),
    (10, "10 seconds"),
];

/// `STUDIO_QUALITY_TIERS`: label, summary, "Best for".
const STUDIO_QUALITY_TIERS: &[(StudioQuality, &str, &str)] = &[
    (
        StudioQuality::Compatibility,
        "Lower bitrate to keep older or low-power machines smooth.",
        "Older Intel Macs, 8GB MacBook Air, weaker laptops.",
    ),
    (
        StudioQuality::Balanced,
        "Sharp footage with sensible CPU and disk usage.",
        "Most modern Macs and PCs with 16GB+ RAM.",
    ),
    (
        StudioQuality::Ultra,
        "Maximum detail for color-graded, large-display edits.",
        "M-series Pro/Max, discrete GPUs, 32GB+ RAM, NVMe.",
    ),
];

/// `INSTANT_RESOLUTION_TIERS`.
const INSTANT_RESOLUTION_TIERS: &[(u32, &str, &str)] = &[
    (1280, "720p", "Smallest size, low bandwidth."),
    (1920, "1080p", "Recommended. Sharp on most networks."),
    (2560, "1440p", "More detail for desktop content."),
    (3840, "4K", "Max clarity. Needs fast upload."),
];

/// `FREE_INSTANT_MODE_MAX_RESOLUTION`.
const FREE_INSTANT_MODE_MAX_RESOLUTION: u32 = 1280;

/// `UPDATE_CHANNEL_OPTIONS`.
const UPDATE_CHANNEL_DESCRIPTIONS: &[(UpdateChannel, &str)] = &[
    (UpdateChannel::Stable, "Versioned releases (recommended)"),
    (
        UpdateChannel::Nightly,
        "The newest builds, updated automatically in the background when you're \
         not recording or exporting. May be unstable.",
    ),
];

/// The three theme previews (`~/assets/theme-previews/*.jpg`), keyed the way
/// `AppearanceSection`'s `previews` map is.
fn theme_preview(theme: AppTheme) -> &'static str {
    match theme {
        AppTheme::System => "images/auto.jpg",
        AppTheme::Light => "images/light.jpg",
        AppTheme::Dark => "images/dark.jpg",
    }
}

/// Which text field an event came from, so one handler can serve all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    ProjectName,
    ServerUrl,
    /// The Recordings page's filter.
    RecordingsSearch,
}

// ---------------------------------------------------------------------------
// The Recordings page (`settings/recordings.tsx`)
// ---------------------------------------------------------------------------

/// `PAGE_SIZE` (`recordings.tsx:64`).
const RECORDINGS_PAGE_SIZE: usize = 20;

/// `hasActiveRecording`'s poll: `refetchInterval` returns 2000 while anything
/// in the list is still being written.
const RECORDINGS_POLL: Duration = Duration::from_millis(2000);

/// `Tabs` (`recordings.tsx:47-62`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecordingsTab {
    All,
    Instant,
    Studio,
}

impl RecordingsTab {
    const ALL: &'static [RecordingsTab] = &[Self::All, Self::Instant, Self::Studio];

    /// The tab's `id`, which for the two mode tabs is the mode's own
    /// serialized name -- `emptyMessage()` interpolates it directly.
    fn id(self) -> &'static str {
        match self.mode() {
            Some(mode) => mode.slug(),
            None => "all",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::All => "Show all",
            Self::Instant => "Instant",
            Self::Studio => "Studio",
        }
    }

    /// `Show all` has no glyph; the other two carry the mode's own.
    fn icon(self) -> Option<&'static str> {
        self.mode().map(RecordingMode::icon)
    }

    /// What `data.filter(r => r.meta.mode === activeTab())` compares against;
    /// `None` for the tab that filters nothing.
    fn mode(self) -> Option<RecordingMode> {
        match self {
            Self::All => None,
            Self::Instant => Some(RecordingMode::Instant),
            Self::Studio => Some(RecordingMode::Studio),
        }
    }
}

/// One row: the scanned recording, plus its thumbnail once the background
/// decode lands -- the Recents shape, for the same reason (the bundle's
/// `display.jpg` is a native-resolution JPEG and must not be decoded on the UI
/// thread).
struct RecordingRow {
    item: RecordingItem,
    thumbnail: Option<Arc<RenderImage>>,
}

/// Everything the page owns. The Solid route keeps this in a `createQuery` plus
/// three signals; the lifetimes are the same, they just live on the window here.
struct Recordings {
    /// The scan. `None` until the first one lands -- which the page draws the
    /// same as an empty library, because `recordings.data && length > 0` is
    /// false for both and the route has no loading branch.
    items: Option<Vec<RecordingRow>>,
    tab: RecordingsTab,
    /// The filter field. `search()` is mirrored here so the filter math reads a
    /// plain `String`.
    search_input: Entity<ui::TextInputState>,
    search: String,
    /// `visibleCount`, reset to `PAGE_SIZE` by a tab or search change.
    visible_count: usize,
    /// The scan + thumbnail decode task. Dropping it cancels, so a refresh that
    /// arrives mid-scan replaces the old one rather than racing it.
    scan: Option<gpui::Task<()>>,
    /// The 2s poll, armed only while something in the list is still being
    /// written (`refetchInterval`).
    tick: Option<gpui::Task<()>>,
}

impl Recordings {
    fn new(search_input: Entity<ui::TextInputState>) -> Self {
        Self {
            items: None,
            tab: RecordingsTab::All,
            search_input,
            search: String::new(),
            visible_count: RECORDINGS_PAGE_SIZE,
            scan: None,
            tick: None,
        }
    }

    /// `trimmedSearch()`.
    fn trimmed_search(&self) -> &str {
        self.search.trim()
    }

    /// `filteredRecordings()`: the tab, then the case-insensitive substring.
    fn filtered(&self) -> Vec<&RecordingRow> {
        let query = self.trimmed_search().to_lowercase();
        self.items
            .iter()
            .flatten()
            .filter(|row| matches_recording_filters(&row.item, self.tab, &query))
            .collect()
    }
}

/// One row against the tab and the already-lowercased, already-trimmed query.
fn matches_recording_filters(item: &RecordingItem, tab: RecordingsTab, query: &str) -> bool {
    if let Some(mode) = tab.mode()
        && item.mode != mode
    {
        return false;
    }
    query.is_empty() || item.pretty_name.to_lowercase().contains(query)
}

/// `visibleRecordings()`: an active search shows every match, unpaginated.
fn visible_recordings_len(total: usize, has_search: bool, visible_count: usize) -> usize {
    if has_search {
        total
    } else {
        total.min(visible_count)
    }
}

/// `hasMoreRecordings()`.
fn has_more_recordings(total: usize, has_search: bool, visible_count: usize) -> bool {
    !has_search && total > visible_count
}

/// `setVisibleCount(count => Math.min(count + PAGE_SIZE, filtered.length))`.
fn load_more_count(visible_count: usize, total: usize) -> usize {
    (visible_count + RECORDINGS_PAGE_SIZE).min(total)
}

/// `emptyMessage()`.
fn recordings_empty_message(tab: RecordingsTab, trimmed_search: &str) -> String {
    let tab_label = match tab {
        RecordingsTab::All => "recordings".to_string(),
        tab => format!("{} recordings", tab.id()),
    };
    let prefix = if trimmed_search.is_empty() {
        "No"
    } else {
        "No matching"
    };
    format!("{prefix} {tab_label}")
}

pub struct SettingsWindow {
    theme: Theme,
    page: Page,
    settings: GeneralSettings,
    menu: Option<OpenMenu>,
    /// Drafts for the two text fields. Both are Save/Update-committed in the
    /// shipping page too, so the store only sees them on the button.
    project_name: String,
    server_url: String,
    /// The real fields. `ui::TextInputState` owns the caret, the selection,
    /// the clipboard and the field-scoped undo; the drafts above stay because
    /// Save/Update are the commit, not Return.
    project_name_input: Entity<ui::TextInputState>,
    server_url_input: Entity<ui::TextInputState>,
    _field_events: [gpui::Subscription; 3],
    /// The Recordings page.
    recordings: Recordings,
    /// `Collapsible` under the project-name input, with the content's measured
    /// height so the reveal animates a real layout property.
    placeholders: ui::CollapsibleState,
    /// Keeps the collapsible repainting while its height animates. Dropping it
    /// cancels, so a re-toggle mid-flight replaces the ticker rather than
    /// racing it -- the main window's resize rule.
    placeholders_task: Option<gpui::Task<()>>,
    /// The zoom slider's track rect, captured during prepaint -- the row is
    /// inside a resizable pane, so it cannot be computed.
    slider_track: Rc<Cell<Option<Bounds<Pixels>>>>,
    slider_dragging: bool,
    /// `commands.listCaptureWindows()`, for the excluded-windows menu.
    windows: Vec<WindowOption>,
    /// Key handling for Cmd-W lives on the root, which needs a focus handle of
    /// its own so the window has something focused when nothing else does.
    focus: FocusHandle,
}

impl SettingsWindow {
    pub fn new(page: Page, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let theme = Theme::new(Appearance::from_window(window.appearance()));
        let settings = GeneralSettings::load();

        // The Tauri app's close button and Cmd-W both go through the window's
        // own close, and `CapWindowId::Settings`'s `Destroyed` arm calls
        // `restore_main_and_target_select_windows`. Same here: whichever way
        // the window goes away, the main window comes back.
        window.on_window_should_close(cx, |_window, cx| {
            cx.defer(crate::app_windows::settings_closed);
            true
        });

        // Both fields are built up front so their focus handles outlive a page
        // change, and because `TextInputState`'s blur listener needs a window.
        let project_name_input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_text(
                settings
                    .default_project_name_template
                    .clone()
                    .unwrap_or_else(|| DEFAULT_PROJECT_NAME_TEMPLATE.to_string()),
                cx,
            );
            input
        });
        let server_url_input = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            input.set_text(settings.server_url.clone(), cx);
            input
        });
        let recordings_search = cx.new(|cx| {
            let mut input = ui::TextInputState::single_line(window, cx);
            // `placeholder="Search"`.
            input.set_placeholder("Search");
            input
        });
        let field_events = [
            cx.subscribe(&project_name_input, |this, input, event, cx| {
                this.on_field_event(Field::ProjectName, input, event, cx)
            }),
            cx.subscribe(&server_url_input, |this, input, event, cx| {
                this.on_field_event(Field::ServerUrl, input, event, cx)
            }),
            cx.subscribe(&recordings_search, |this, input, event, cx| {
                this.on_field_event(Field::RecordingsSearch, input, event, cx)
            }),
        ];

        Self {
            theme,
            page,
            project_name: settings
                .default_project_name_template
                .clone()
                .unwrap_or_else(|| DEFAULT_PROJECT_NAME_TEMPLATE.to_string()),
            server_url: settings.server_url.clone(),
            settings,
            menu: None,
            project_name_input,
            server_url_input,
            _field_events: field_events,
            recordings: Recordings::new(recordings_search),
            placeholders: ui::CollapsibleState::new(false),
            placeholders_task: None,
            slider_track: Rc::new(Cell::new(None)),
            slider_dragging: false,
            windows: Vec::new(),
            focus: cx.focus_handle(),
        }
    }

    /// Enumerate capture windows for the excluded-windows menu.
    ///
    /// Same reason `MainWindow::start_enumeration` is not called from `new`:
    /// a task spawned inside `open_window`'s builder closure updates the model
    /// without ever scheduling a frame.
    pub fn start_enumeration(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let windows = cx
                .background_executor()
                .spawn(async { crate::devices::DeviceSnapshot::enumerate().windows })
                .await;
            this.update(cx, |this, cx| {
                this.windows = windows;
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    /// Re-target an already-open window, the way `showWindow({ Settings: {
    /// page } })` navigates a live one.
    pub fn set_page(&mut self, page: Page, window: &mut Window, cx: &mut Context<Self>) {
        self.page = page;
        self.menu = None;
        // The store may have changed under us while the window was in the
        // background (the Tauri app writing, or a recording updating a
        // window position).
        self.settings = GeneralSettings::load();
        self.page_shown(window, cx);
        cx.notify();
    }

    /// Whatever the newly shown page has to fetch.
    ///
    /// The Recordings page's `createQuery` runs on mount and again on every
    /// remount, which is what navigating to it is. Leaving the page drops the
    /// scan and the poll -- `@tanstack/solid-query` stops refetching for an
    /// unmounted observer, and a poll running behind a page nobody is looking
    /// at is filesystem work for nothing.
    ///
    /// Called from the window's own open path rather than from `new` for the
    /// [`Self::start_enumeration`] reason: a task spawned inside
    /// `open_window`'s builder closure updates the model without ever
    /// scheduling a frame.
    pub fn page_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page == Page::Recordings {
            self.refresh_recordings(window, cx);
            return;
        }
        // Safe to drop here and nowhere else: both tasks are asleep whenever a
        // page change can be observed (a click, or `showWindow`), never
        // executing. Dropping a task from inside its own body would cancel a
        // running future.
        self.recordings.scan = None;
        self.recordings.tick = None;
    }

    /// The `recordings` query: scan the library on the background executor,
    /// then decode each thumbnail there too.
    ///
    /// Same two-stage shape as the main window's Recents (`refresh_recents`):
    /// the list lands first so the rows can paint with their grey placeholder,
    /// and each thumbnail replaces its own row's as it arrives. A library with
    /// several hundred bundles is several hundred `read_dir` + JSON parses and
    /// as many native-resolution JPEG decodes; none of it may happen on the UI
    /// thread.
    pub fn refresh_recordings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.page != Page::Recordings {
            return;
        }

        self.recordings.scan = Some(cx.spawn_in(window, async move |this, cx| {
            let items = cx
                .background_executor()
                .spawn(async { library::list_recordings() })
                .await;
            tracing::info!(count = items.len(), "scanned the recordings library");

            let Ok(thumbnails) =
                this.update_in(cx, |this, window, cx| this.set_recordings(items, window, cx))
            else {
                return;
            };

            for (index, path) in thumbnails {
                let image = cx
                    .background_executor()
                    .spawn({
                        let path = path.clone();
                        async move { library::decode_thumbnail(&path) }
                    })
                    .await;
                let Some(image) = image else { continue };

                if this
                    .update_in(cx, |this, window, cx| {
                        let Some(row) = this
                            .recordings
                            .items
                            .as_mut()
                            .and_then(|rows| rows.get_mut(index))
                        else {
                            return;
                        };
                        // A refresh may have landed while this decode was in
                        // flight, and the row at this index may now be a
                        // different recording.
                        if row.item.thumbnail.as_deref() != Some(path.as_path()) {
                            return;
                        }
                        if let Some(old) = row.thumbnail.replace(image) {
                            let _ = window.drop_image(old);
                        }
                        cx.notify();
                        // An unfocused window only repaints when asked.
                        window.refresh();
                    })
                    .is_err()
                {
                    return;
                }
            }

            this.update_in(cx, |this, window, cx| this.arm_recordings_poll(window, cx))
                .ok();
        }));
    }

    /// Install a scan result, and hand back the thumbnails that still have to
    /// be decoded.
    ///
    /// `reconcile: "path"` on the query is doing real work here: the 2s poll
    /// re-runs the whole scan, and a row that is still in the library must keep
    /// the image it already has. Without that every tick blanked all five
    /// thumbnails and re-decoded them one by one, which is visible as a flicker
    /// (found on the first fixture run). A row that has gone away releases its
    /// image from the sprite atlas, the same explicit drop `set_recents` does.
    ///
    /// A bundle's `display.jpg` is written once, when the recording finishes,
    /// so keying the cache on the bundle path cannot serve a stale image: the
    /// row that gains a thumbnail mid-poll has none cached and decodes.
    fn set_recordings(
        &mut self,
        items: Vec<RecordingItem>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<(usize, PathBuf)> {
        let mut cached: std::collections::HashMap<PathBuf, Arc<RenderImage>> = self
            .recordings
            .items
            .take()
            .into_iter()
            .flatten()
            .filter_map(|row| row.thumbnail.map(|image| (row.item.path, image)))
            .collect();

        let mut pending = Vec::new();
        let rows: Vec<RecordingRow> = items
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let thumbnail = cached.remove(&item.path);
                if thumbnail.is_none()
                    && let Some(path) = item.thumbnail.clone()
                {
                    pending.push((index, path));
                }
                RecordingRow { item, thumbnail }
            })
            .collect();

        for (_, image) in cached {
            let _ = window.drop_image(image);
        }

        self.recordings.items = Some(rows);
        cx.notify();
        // The settings window is not necessarily the active one while a
        // recording is being written into the library, and an inactive gpui
        // window does not repaint from a background-driven model update.
        window.refresh();
        pending
    }

    /// `refetchInterval: data.some(hasActiveRecording) ? 2000 : false` -- armed
    /// at the end of a scan, so a recording that finishes stops the poll and a
    /// recording that starts restarts it.
    fn arm_recordings_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let active = self
            .recordings
            .items
            .iter()
            .flatten()
            .any(|row| row.item.is_active());
        if !active || self.page != Page::Recordings {
            self.recordings.tick = None;
            return;
        }
        self.recordings.tick = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(RECORDINGS_POLL).await;
            this.update_in(cx, |this, window, cx| this.refresh_recordings(window, cx))
                .ok();
        }));
    }

    /// The row's own delete: `ask(..)`, then the guarded recursive delete, then
    /// a refetch.
    ///
    /// The alert runs in a spawned task rather than in the click handler: it
    /// spins AppKit's modal run loop, which re-enters gpui's window callbacks
    /// for as long as it is up, and doing that with the App RefCell held is the
    /// `place_overlay_panel` failure. gpui's foreground executor is the main
    /// thread, which is where `NSAlert` has to run, so the task is both the
    /// right thread and the right borrow state.
    fn delete_recording(&mut self, path: PathBuf, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let confirmed = crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this recording?",
                "Yes",
                "No",
                false,
            );
            if !confirmed {
                return;
            }

            let deleted = cx
                .background_executor()
                .spawn({
                    let path = path.clone();
                    async move { library::delete_recording_directory(&path) }
                })
                .await;
            if let Err(error) = deleted {
                tracing::error!(path = %path.display(), "deleting the recording failed: {error}");
                return;
            }
            tracing::info!(path = %path.display(), "deleted a recording");

            this.update_in(cx, |this, window, cx| this.refresh_recordings(window, cx))
                .ok();
        })
        .detach();
    }

    /// The Edit button on a `Failed` studio recording, which asks first.
    fn open_editor_confirmed(
        &mut self,
        path: PathBuf,
        confirm: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !confirm {
            // Deferred: opening a window paints it synchronously, which would
            // double-lease the app from inside this update.
            cx.defer(move |cx| crate::app_windows::open_editor(path, cx));
            return;
        }
        cx.spawn_in(window, async move |_this, cx| {
            let confirmed = crate::platform::confirm_dialog(
                "Recording is potentially corrupted",
                "The recording failed so this file may have issues in the editor! If your \
                 having issues recovering the file please reach out to support!",
                "Ok",
                "Cancel",
                true,
            );
            if !confirmed {
                return;
            }
            // Deferred inside the update for the same reason the direct arm
            // defers: `open_window` paints synchronously.
            cx.update(|_window, cx| {
                cx.defer(move |cx| crate::app_windows::open_editor(path, cx))
            })
            .ok();
        })
        .detach();
    }

    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        let appearance = Appearance::from_window(window.appearance());
        let material = crate::platform::active_material(cx);
        if appearance != self.theme.appearance || material != self.theme.material_kind() {
            self.theme = Theme::new(appearance).with_material(material);
        }
    }

    // -- Writes ------------------------------------------------------------

    /// `handleChange` in general.tsx: update the in-memory copy, then the
    /// store. Written synchronously on the main thread -- the store is a few
    /// kilobytes and the write is a read-modify-write, so pushing it to the
    /// background executor would let two quick toggles interleave and lose
    /// one.
    fn write(&mut self, key: &'static str, value: Value, cx: &mut Context<Self>) {
        if !store::set_store_setting(GENERAL_SETTINGS, key, value) {
            // The store refused (unparseable file); reload so the UI shows
            // what is actually on disk rather than the change that did not
            // land.
            self.settings = GeneralSettings::load();
        }
        cx.notify();
    }

    fn write_bool(&mut self, key: &'static str, value: bool, cx: &mut Context<Self>) {
        self.write(key, Value::Bool(value), cx);
    }

    fn write_u32(&mut self, key: &'static str, value: u32, cx: &mut Context<Self>) {
        self.write(key, Value::from(value), cx);
    }

    fn write_enum<T: SettingsEnum>(&mut self, key: &'static str, value: T, cx: &mut Context<Self>) {
        self.write(key, Value::String(value.as_json().to_string()), cx);
    }

    fn write_excluded(&mut self, windows: Vec<WindowExclusion>, cx: &mut Context<Self>) {
        self.settings.excluded_windows = windows;
        let json = store::excluded_windows_to_json(&self.settings.excluded_windows);
        self.write("excludedWindows", json, cx);
    }

    /// The `Collapsible` under the project-name input.
    ///
    /// The height animates over the content's *measured* height, which is what
    /// Kobalte's `--kb-collapsible-content-height` is, so a ticker has to keep
    /// the window repainting for the 200ms the keyframe runs -- gpui only
    /// renders on invalidation. Assigning over the previous task drops it,
    /// cancelling a toggle still in flight.
    fn toggle_placeholders(&mut self, cx: &mut Context<Self>) {
        self.placeholders.toggle();
        self.placeholders_task = Some(cx.spawn(async move |this, cx| {
            loop {
                let more = this
                    .update(cx, |this, cx| {
                        cx.notify();
                        this.placeholders.is_animating()
                    })
                    .unwrap_or(false);
                if !more {
                    return;
                }
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(8))
                    .await;
            }
        }));
        cx.notify();
    }

    // -- Menus -------------------------------------------------------------

    fn open_menu(
        &mut self,
        kind: MenuKind,
        origin: Point<Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        // The menu's arrows / Home / End / Enter / Escape are handled by the
        // root's `on_key_down`, and a focused text field would consume all of
        // them first -- its bindings sit deeper in the dispatch path. Opening
        // a menu therefore takes focus back, which is also what clicking a
        // `<button>` does to a focused `<input>` in the webview.
        let focus = self.focus.clone();
        window.focus(&focus, cx);
        let items = self.menu_items(kind);
        self.menu = Some(OpenMenu {
            kind,
            state: ui::MenuState::new(origin, &items),
        });
        cx.notify();
    }

    /// Arrows / Home / End / Enter / Escape on an open menu -- the Kobalte
    /// `Select` contract. Returns whether the key was consumed.
    fn menu_key(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let Some(menu) = self.menu.as_mut() else {
            return false;
        };
        let kind = menu.kind;
        match menu.state.on_key(key) {
            ui::MenuKey::Moved => {
                cx.notify();
                true
            }
            ui::MenuKey::Commit(index) => {
                self.choose(kind, index, cx);
                true
            }
            ui::MenuKey::Dismiss => {
                self.menu = None;
                cx.notify();
                true
            }
            ui::MenuKey::Ignored => false,
        }
    }

    /// One row per option, check-marked when it is the value in force.
    fn menu_items(&self, kind: MenuKind) -> Vec<ui::MenuItem> {
        match kind {
            MenuKind::Countdown => {
                let current = self.settings.recording_countdown.unwrap_or(0);
                COUNTDOWN_OPTIONS
                    .iter()
                    .map(|(value, label)| ui::MenuItem::new(*label, *value == current))
                    .collect()
            }
            MenuKind::MaxFps => MAX_FPS_OPTIONS
                .iter()
                .map(|(value, label)| ui::MenuItem::new(*label, *value == self.settings.max_fps))
                .collect(),
            MenuKind::MainWindowStart => {
                enum_items(self.settings.main_window_recording_start_behaviour)
            }
            MenuKind::PostStudio => enum_items(self.settings.post_studio_recording_behaviour),
            MenuKind::PostDeletion => enum_items(self.settings.post_deletion_behaviour),
            MenuKind::AddWindow => self
                .available_windows()
                .into_iter()
                .map(|window| ui::MenuItem::new(window_option_label(&window), false))
                .collect(),
        }
    }

    fn choose(&mut self, kind: MenuKind, index: usize, cx: &mut Context<Self>) {
        self.menu = None;
        match kind {
            MenuKind::Countdown => {
                if let Some((value, _)) = COUNTDOWN_OPTIONS.get(index) {
                    self.settings.recording_countdown = Some(*value);
                    self.write_u32("recordingCountdown", *value, cx);
                }
            }
            MenuKind::MaxFps => {
                if let Some((value, _)) = MAX_FPS_OPTIONS.get(index) {
                    self.settings.max_fps = *value;
                    self.write_u32("maxFps", *value, cx);
                }
            }
            MenuKind::MainWindowStart => {
                if let Some(value) = MainWindowStartBehaviour::ALL.get(index) {
                    self.settings.main_window_recording_start_behaviour = *value;
                    self.write_enum("mainWindowRecordingStartBehaviour", *value, cx);
                }
            }
            MenuKind::PostStudio => {
                if let Some(value) = PostStudioBehaviour::ALL.get(index) {
                    self.settings.post_studio_recording_behaviour = *value;
                    self.write_enum("postStudioRecordingBehaviour", *value, cx);
                }
            }
            MenuKind::PostDeletion => {
                if let Some(value) = PostDeletionBehaviour::ALL.get(index) {
                    self.settings.post_deletion_behaviour = *value;
                    self.write_enum("postDeletionBehaviour", *value, cx);
                }
            }
            MenuKind::AddWindow => {
                let Some(window) = self.available_windows().get(index).cloned() else {
                    return;
                };
                // `handleAddWindow`: the title is only recorded when there is
                // no bundle id to match on.
                let mut next = self.settings.excluded_windows.clone();
                next.push(WindowExclusion {
                    bundle_identifier: None,
                    owner_name: Some(window.app.clone()),
                    window_title: Some(window.label.clone()),
                });
                self.write_excluded(next, cx);
            }
        }
        cx.notify();
    }

    /// `availableWindows`: everything not already covered by an exclusion.
    /// The `ostype === "windows"` narrowing is not reproduced -- this app is
    /// macOS-only so far.
    fn available_windows(&self) -> Vec<WindowOption> {
        self.windows
            .iter()
            .filter(|window| {
                !self
                    .settings
                    .excluded_windows
                    .iter()
                    .any(|exclusion| matches_exclusion(exclusion, window))
            })
            .cloned()
            .collect()
    }

    /// `missingDefaultExclusions`, which drives the amber warning.
    fn missing_default_exclusions(&self) -> Vec<WindowExclusion> {
        store::default_excluded_windows()
            .into_iter()
            .filter(|default| {
                !self
                    .settings
                    .excluded_windows
                    .iter()
                    .any(|entry| covers_default_exclusion(entry, default))
            })
            .collect()
    }
}

fn enum_items<T: SettingsEnum>(current: T) -> Vec<ui::MenuItem> {
    T::ALL
        .iter()
        .map(|value| ui::MenuItem::new(value.label(), *value == current))
        .collect()
}

/// `getWindowOptionLabel`: `owner • title`, title dropped when it repeats the
/// owner.
fn window_option_label(window: &WindowOption) -> String {
    if window.label.is_empty() || window.label == window.app {
        window.app.clone()
    } else {
        format!("{} • {}", window.app, window.label)
    }
}

/// `matchesExclusion` in general.tsx.
fn matches_exclusion(exclusion: &WindowExclusion, window: &WindowOption) -> bool {
    // Nothing here carries a bundle identifier yet (`scap-targets` reports the
    // owning app's name), so the bundle branch can only ever miss.
    let owner_match = exclusion
        .owner_name
        .as_ref()
        .is_some_and(|owner| *owner == window.app);

    if let (Some(_), Some(title)) = (&exclusion.owner_name, &exclusion.window_title) {
        return owner_match && *title == window.label;
    }
    if owner_match {
        return true;
    }
    exclusion
        .window_title
        .as_ref()
        .is_some_and(|title| *title == window.label)
}

/// `coversDefaultExclusion`.
fn covers_default_exclusion(entry: &WindowExclusion, default: &WindowExclusion) -> bool {
    if entry == default {
        return true;
    }
    if default.window_title.is_some() && entry.window_title == default.window_title {
        return true;
    }
    if default.bundle_identifier.is_some() && entry.bundle_identifier == default.bundle_identifier {
        return true;
    }
    if default.owner_name.is_some() && entry.owner_name == default.owner_name {
        return entry.window_title.is_none() || entry.window_title == default.window_title;
    }
    false
}

impl Render for SettingsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let theme = self.theme;

        div()
            .track_focus(&self.focus)
            // `(window-chrome).tsx` binds Cmd-W to `getCurrentWindow().close()`
            // for every chrome window. Escape is not bound there and is not
            // bound here.
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _window, cx| {
                let keystroke = &event.keystroke;
                // An open menu takes arrows, Home/End, Enter and Escape first
                // -- the Kobalte `Select` contract. Everything else, and every
                // key at all when no menu is open, falls through.
                if this.menu_key(&keystroke.key, cx) {
                    return;
                }
                if keystroke.modifiers.platform && keystroke.key == "w" {
                    cx.defer(crate::app_windows::close_settings);
                }
            }))
            .size_full()
            .flex()
            .flex_row()
            .overflow_hidden()
            // `.cap-settings-shell { background: transparent }` under the
            // settings material; the panes paint. The radius is
            // `--macos-settings-window-radius`, 26 under Liquid Glass, and
            // the content view's layer is clipped to the same curve by
            // `platform::install_window_material`.
            .rounded(px(theme.settings_window_radius()))
            .font_family("Geist")
            .text_color(theme.settings_text())
            .child(self.render_sidebar(cx))
            .child(self.render_content(window, cx))
            // Painted last so it lands over the page: the select menus, and
            // the drag layer the zoom slider needs while the button is held.
            .children(self.render_menu(cx))
            .children(self.render_slider_drag_layer(cx))
    }
}

impl SettingsWindow {
    // -- Sidebar -----------------------------------------------------------

    fn render_sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        div()
            .flex()
            .flex_col()
            .h_full()
            // `width/min-width/max-width: var(--macos-settings-sidebar-width)`.
            .w(px(SIDEBAR_WIDTH))
            .flex_shrink_0()
            .bg(theme.settings_sidebar_bg())
            .child(
                // `.cap-settings-window-spacer`, the strip the traffic lights
                // sit in. `data-tauri-drag-region` on the sidebar makes it a
                // drag handle; AppKit already drags the top ~28pt of a
                // transparent titlebar, this covers the rest of the strip.
                div()
                    .id("settings-drag")
                    .h(px(SIDEBAR_SPACER))
                    .flex_shrink_0()
                    .w_full()
                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    }),
            )
            .child(self.render_profile())
            .child(self.render_nav(cx))
            .child(self.render_account(cx))
    }

    /// The account button. There is no auth here (same gap as the main
    /// window's plan badge), so it renders the signed-out state and does
    /// nothing when clicked -- see the README.
    fn render_profile(&self) -> impl IntoElement {
        let theme = self.theme;

        div()
            .flex()
            .flex_row()
            .items_center()
            // `.cap-settings-profile { gap: 8px; min-height: 44px; margin: 0
            //  var(--macos-settings-sidebar-padding-x) 16px; padding: 6px 4px;
            //  border-radius: 8px }`
            .gap(px(8.))
            .min_h(px(44.))
            .mx(px(SIDEBAR_PADDING_X))
            .mb(px(16.))
            .px(px(4.))
            .py(px(6.))
            .rounded(px(8.))
            .child(
                // `.cap-settings-profile-icon { width/height: 32px; color:
                //  var(--macos-settings-muted); background:
                //  var(--macos-settings-fill); border-radius: 999px }`
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(32.))
                    .flex_shrink_0()
                    .rounded_full()
                    .bg(theme.settings_fill())
                    .child(
                        svg()
                            .path("icons/user-round.svg")
                            .size(px(16.))
                            .text_color(theme.settings_muted()),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .justify_center()
                    // `.cap-settings-profile-copy { gap: 2px }`
                    .gap(px(2.))
                    .child(
                        // `text-[13px] leading-[15px] text-gray-12`, and
                        // `accountName()` with no auth.
                        div()
                            .truncate()
                            .text_size(px(13.))
                            .line_height(px(15.))
                            .child("Click to sign in"),
                    )
                    .child(
                        // `text-[11px] leading-[13px] text-gray-10`
                        div()
                            .truncate()
                            .text_size(px(11.))
                            .line_height(px(13.))
                            .text_color(theme.settings_muted())
                            .child("Account"),
                    ),
            )
    }

    fn render_nav(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        div()
            .id("settings-nav")
            .flex()
            .flex_col()
            // `.cap-settings-nav { padding: 0 var(--sidebar-padding-x)
            //  var(--sidebar-padding-x); overflow-y: auto }`, `space-y-1`.
            .px(px(SIDEBAR_PADDING_X))
            .pb(px(SIDEBAR_PADDING_X))
            .gap(px(4.))
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .children(Page::ALL.iter().copied().map(|page| {
                let selected = page == self.page;
                div()
                    .id(SharedString::from(page.slug()))
                    .flex()
                    .flex_row()
                    .items_center()
                    // `.cap-settings-nav-item { height: 32px; padding: 6px;
                    //  border-radius: 8px }`, `gap-1.5 text-[13px]`.
                    .h(px(32.))
                    .px(px(6.))
                    .gap(px(6.))
                    .rounded(px(8.))
                    .text_size(px(13.))
                    .when(selected, |this| {
                        // `.cap-settings-nav-item.bg-gray-5 { background:
                        //  var(--macos-settings-selection) }`, and the
                        //  `activeClass` also carries `pointer-events-none`.
                        this.bg(theme.settings_selection())
                    })
                    .when(!selected, |this| {
                        this.hover(|style| style.bg(theme.settings_hover()))
                    })
                    .child(
                        svg()
                            .path(page.icon())
                            .size(px(16.))
                            .flex_shrink_0()
                            .text_color(if selected {
                                // `.cap-settings-nav-item.bg-gray-5 svg
                                //  { color: var(--macos-settings-accent) }`
                                rgb(Theme::SETTINGS_ACCENT).into()
                            } else {
                                theme.settings_muted()
                            }),
                    )
                    .child(page.label())
                    .on_click(cx.listener(move |this, _, window, cx| {
                        // Navigating *is* a remount in the Solid router, so the
                        // new page's query runs -- `set_page` carries that.
                        this.set_page(page, window, cx);
                    }))
            }))
    }

    fn render_account(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        div()
            .flex()
            .flex_col()
            // `.cap-settings-account { padding: 8px var(--sidebar-padding-x)
            //  var(--sidebar-padding-x); border-top: 1px solid
            //  var(--macos-settings-border) }`
            .pt(px(8.))
            .px(px(SIDEBAR_PADDING_X))
            .pb(px(SIDEBAR_PADDING_X))
            .border_t_1()
            .border_color(theme.settings_border())
            .child(
                // `mb-2 text-xs text-gray-11 flex flex-col items-start gap-1.5`
                div()
                    .flex()
                    .flex_col()
                    .items_start()
                    .gap(px(6.))
                    .mb(px(8.))
                    .text_size(px(12.))
                    .text_color(theme.settings_muted())
                    .child(
                        // The version button copies to the clipboard in the
                        // Tauri app; the string is this crate's version, not
                        // the shipping app's (there is no `getVersion()`
                        // here).
                        div()
                            .id("settings-version")
                            .px(px(4.))
                            .py(px(2.))
                            .rounded(px(4.))
                            .child(format!("v{}", env!("CARGO_PKG_VERSION"))),
                    )
                    .child(
                        div()
                            .id("settings-previous-versions")
                            .child("View previous versions")
                            .hover(|style| style.text_color(theme.settings_text()))
                            .on_click(|_, _, cx| cx.open_url("https://cap.so/download/versions")),
                    )
                    .child(
                        // Inert: there is no updater in this app. Drawn in the
                        // disabled state the shipping button uses while a
                        // check is in flight (`disabled:opacity-50`).
                        div().opacity(0.5).child("Check for updates"),
                    ),
            )
            .child(
                // `<SignInButton>`: `size="md"`, `variant="primary"`, which
                // the settings material paints as the accent button.
                self.button(
                    "settings-sign-in",
                    ui::ButtonVariant::Dark,
                    None,
                    "Sign In",
                    false,
                    cx,
                    |_, _, _| {},
                )
                .full_width()
                .height(px(34.)),
            )
    }

    // -- Content pane ------------------------------------------------------

    fn render_content(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_hidden()
            .bg(theme.settings_content_bg())
            // `divide-x divide-gray-3` on the shell, remapped to
            // `var(--macos-settings-border)` under Liquid Glass.
            .border_l_1()
            .border_color(theme.settings_divider())
            .child(
                div()
                    .id("settings-page")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    // `.cap-settings-page > .px-6 { max-width: none; padding:
                    //  18px var(--macos-settings-content-padding-x) 28px }`,
                    //  and `space-y-7` between sections.
                    .pt(px(18.))
                    .px(px(CONTENT_PADDING_X))
                    .pb(px(28.))
                    .gap(px(28.))
                    .children(match self.page {
                        Page::General => self.render_general(window, cx),
                        Page::Recordings => self.render_recordings(cx),
                        page => self.render_placeholder(page),
                    }),
            )
    }

    /// Honest stand-in for the eleven pages that are not built.
    fn render_placeholder(&self, page: Page) -> Vec<gpui::AnyElement> {
        let theme = self.theme;
        vec![
            self.section(
                page.label(),
                Some(page.blurb()),
                None,
                vec![
                    self.card(true)
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(6.))
                                .child(
                                    div()
                                        .text_size(px(13.))
                                        .child("Not part of the gpui rewrite yet"),
                                )
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .line_height(px(16.))
                                        .text_color(theme.settings_muted())
                                        .child(
                                            "This page exists in the shipping app. Only \
                                             General is implemented here so far -- \
                                             everything it writes goes into the same \
                                             settings file, so the two stay in step.",
                                        ),
                                ),
                        )
                        .into_any_element(),
                ],
            )
            .into_any_element(),
        ]
    }

    // -- The Recordings page -----------------------------------------------

    /// `settings/recordings.tsx`.
    ///
    /// The header is a `<Section>` with an Import button; below it a filter bar
    /// (three tab pills and the search field) and the bordered list, which is
    /// replaced wholesale by "No recordings found" when the library is empty.
    fn render_recordings(&self, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        // `variant="gray" size="sm" class="h-[36px] px-3 gap-1.5"`. Disabled:
        // `importVideoFromPicker` remuxes the picked file through
        // `commands.importVideoToProject`, which is Tauri-side work this app
        // does not have (see the README's deviation).
        let import = self
            .button(
                "recordings-import",
                ui::ButtonVariant::Gray,
                Some("icons/import.svg"),
                "Import",
                true,
                cx,
                |_, _, _| {},
            )
            .height(px(36.))
            .into_any_element();

        // `when={recordings.data && recordings.data.length > 0}`: an empty
        // library and a scan still in flight take the same branch, because the
        // route has no loading state of its own.
        let empty_library = self
            .recordings
            .items
            .as_ref()
            .is_none_or(|items| items.is_empty());

        let children = if empty_library {
            vec![self.recordings_message("No recordings found").into_any_element()]
        } else {
            vec![
                self.render_recordings_filters(cx).into_any_element(),
                self.render_recordings_list(cx).into_any_element(),
            ]
        };

        vec![
            self.section(
                "Recordings",
                Some("Manage your recordings and perform actions."),
                Some(import),
                children,
            )
            .into_any_element(),
        ]
    }

    /// Both empty states: `text-center text-(--text-tertiary) absolute flex
    /// items-center justify-center w-full h-full`. Absolute over the page in
    /// the TSX; here it is a flow child that fills the space the list would
    /// have taken, which is what that absolute box resolves to.
    fn recordings_message(&self, message: impl Into<SharedString>) -> gpui::Div {
        div()
            .flex()
            .flex_1()
            .min_h(px(200.))
            .w_full()
            .items_center()
            .justify_center()
            .text_color(self.theme.settings_muted())
            .child(message.into())
    }

    /// The filter bar: `flex flex-col gap-3 pb-4 w-full border-b border-gray-2`.
    fn render_recordings_filters(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let active = self.recordings.tab;

        let tabs = div()
            // `flex flex-wrap gap-3 items-center`
            .flex()
            .flex_row()
            .flex_wrap()
            .items_center()
            .gap(px(12.))
            .children(RecordingsTab::ALL.iter().copied().map(|tab| {
                let selected = tab == active;
                div()
                    .id(SharedString::from(tab.id()))
                    // `flex gap-1.5 items-center p-2 px-3 border rounded-full`
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .py(px(8.))
                    .px(px(12.))
                    .rounded_full()
                    .border_1()
                    // `border-gray-5` on both states, remapped to the settings
                    // border by the material.
                    .border_color(theme.settings_border())
                    .map(|this| {
                        if selected {
                            // `bg-gray-5 cursor-default`
                            this.bg(theme.settings_fill()).cursor_default()
                        } else {
                            // `bg-transparent hover:bg-gray-3`
                            this.cursor_pointer()
                                .hover(|style| style.bg(theme.settings_fill()))
                        }
                    })
                    // `size-3`, and `invert dark:invert-0` -- a dark glyph on
                    // the light theme and a light one on the dark, which is
                    // what the page's own text colour already is.
                    .children(tab.icon().map(|icon| {
                        svg()
                            .path(icon)
                            .size(px(12.))
                            .flex_shrink_0()
                            .text_color(theme.settings_text())
                    }))
                    // `text-xs text-gray-12`
                    .child(div().text_size(px(12.)).child(tab.label()))
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.recordings.tab = tab;
                        // `createEffect(() => { activeTab(); ...
                        //  setVisibleCount(PAGE_SIZE) })`
                        this.recordings.visible_count = RECORDINGS_PAGE_SIZE;
                        cx.notify();
                    }))
            }));

        // `relative w-full max-w-[260px] h-[36px] flex items-center` with the
        // magnifier absolutely placed at `left-2` and the input padded past it.
        // `ui::TextInput::search` draws the same glyph as a flow child at the
        // same offset, so the overlay is not reproduced -- there is nothing for
        // it to overlay.
        let search = div().flex().flex_row().items_center().w(px(260.)).child(
            ui::TextInput::search(&theme, "recordings-search", &self.recordings.search_input)
                .height(px(36.))
                // `<Input>` is `rounded-lg bg-gray-2`, and the settings
                // material paints `.bg-gray-2` as the card surface.
                .radius(px(8.))
                .bg(theme.settings_card_bg())
                .border(theme.settings_border())
                .text_color(theme.settings_text())
                .placeholder_color(theme.settings_muted()),
        );

        div()
            .flex()
            .flex_col()
            .w_full()
            .gap(px(12.))
            .pb(px(16.))
            .border_b_1()
            .border_color(theme.settings_border())
            .child(tabs)
            .child(search)
    }

    /// The list: `flex relative flex-col flex-1 rounded-xl border bg-gray-2
    /// border-gray-3`, with the "Load more" footer under it.
    fn render_recordings_list(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let rows = self.recordings.filtered();
        let total = rows.len();
        let has_search = !self.recordings.trimmed_search().is_empty();
        let visible = visible_recordings_len(total, has_search, self.recordings.visible_count);
        let more = has_more_recordings(total, has_search, self.recordings.visible_count);

        // Built up front rather than in a `.children(map(..))`: the closure
        // would have to hold `cx` across every row, which it cannot.
        let mut items = Vec::with_capacity(visible);
        for (index, row) in rows.iter().take(visible).enumerate() {
            // `not-last:border-b` counts the *rendered* rows, so the border
            // stops at the last visible one rather than the last matching one.
            items.push(
                self.render_recording_row(index, row, index + 1 == visible, cx)
                    .into_any_element(),
            );
        }

        div()
            .flex()
            .flex_col()
            .relative()
            // `rounded-xl`, which the settings material takes to 10px.
            .rounded(px(10.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_card_bg())
            .overflow_hidden()
            .when(total == 0, |this| {
                this.child(self.recordings_message(recordings_empty_message(
                    self.recordings.tab,
                    self.recordings.trimmed_search(),
                )))
            })
            .child(div().flex().flex_col().w_full().children(items))
            .when(more, |this| {
                this.child(
                    // `flex justify-center p-3 border-t border-gray-3`
                    div()
                        .flex()
                        .flex_row()
                        .justify_center()
                        .p(px(12.))
                        .border_t_1()
                        .border_color(theme.settings_border())
                        .child(self.button(
                            "recordings-load-more",
                            ui::ButtonVariant::Gray,
                            None,
                            "Load more",
                            false,
                            cx,
                            |this, _window, cx| {
                                let total = this.recordings.filtered().len();
                                this.recordings.visible_count =
                                    load_more_count(this.recordings.visible_count, total);
                                cx.notify();
                            },
                        )),
                )
            })
    }

    /// One `<RecordingItem>`: `flex flex-row justify-between p-3 items-center
    /// w-full`, bordered from every row but the last.
    fn render_recording_row(
        &self,
        index: usize,
        row: &RecordingRow,
        last: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let item = &row.item;
        // `studioCompleteCheck()`: the only rows whose body is a button.
        let opens_editor = item.opens_editor();
        let path = item.path.clone();

        let thumbnail = match row.thumbnail.clone() {
            // `object-cover rounded-sm size-12`
            Some(image) => {
                use gpui::StyledImage as _;
                img(image)
                    .size(px(48.))
                    .flex_shrink_0()
                    .object_fit(gpui::ObjectFit::Cover)
                    .rounded(px(4.))
                    .into_any_element()
            }
            // `<img onError>`'s fallback: `mr-4 rounded-sm bg-gray-10 size-11`.
            // `bg-gray-10` is not one of the steps the settings material
            // remaps, so it keeps its Radix value.
            None => div()
                .size(px(44.))
                .mr(px(16.))
                .flex_shrink_0()
                .rounded(px(4.))
                .bg(theme.gray_10)
                .into_any_element(),
        };

        let left = div()
            // `flex gap-5 items-center`
            .flex()
            .flex_row()
            .items_center()
            .gap(px(20.))
            .flex_1()
            .min_w_0()
            .child(thumbnail)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .min_w_0()
                    .child(
                        // A bare `<span>`: no text class, so the 16px document
                        // default. Truncated rather than allowed to push the
                        // buttons off a window that cannot be widened past its
                        // own content.
                        div()
                            .w_full()
                            .truncate()
                            .text_size(px(16.))
                            .child(item.pretty_name.clone()),
                    )
                    .child(self.render_recording_badges(item)),
            );

        div()
            .id(("recording-row", index))
            .flex()
            .flex_row()
            .justify_between()
            .items_center()
            .w_full()
            .p(px(12.))
            .when(!last, |this| {
                this.border_b_1().border_color(theme.settings_border())
            })
            .map(|this| {
                if opens_editor {
                    this.cursor_pointer()
                        .hover(|style| style.bg(theme.settings_fill()))
                } else {
                    this.cursor_default()
                }
            })
            .child(left)
            .child(self.render_recording_actions(index, item, cx))
            .when(opens_editor, |this| {
                this.on_click(cx.listener(move |_this, _, _window, cx| {
                    let path = path.clone();
                    tracing::info!(path = %path.display(), "opening a recording in the editor");
                    // Deferred: opening a window paints it synchronously, and
                    // doing that inside a click handler would double-lease the
                    // app.
                    cx.defer(move |cx| crate::app_windows::open_editor(path, cx));
                }))
            })
    }

    /// The badge row: `flex space-x-1`, each pill `px-2 py-0.5 gap-1.5
    /// font-medium text-[11px] text-gray-12 rounded-full w-fit`.
    fn render_recording_badges(&self, item: &RecordingItem) -> impl IntoElement {
        let theme = self.theme;

        let pill = |bg: Hsla| {
            div()
                .flex()
                .flex_row()
                .items_center()
                .flex_none()
                .gap(px(6.))
                .px(px(8.))
                .py(px(2.))
                .rounded_full()
                .bg(bg)
                .text_size(px(11.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.settings_text())
        };
        // `size-2.5` on every badge glyph.
        let glyph = |icon: &'static str| {
            svg()
                .path(icon)
                .size(px(10.))
                .flex_shrink_0()
                .text_color(theme.settings_text())
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .child(
                // `bg-blue-100` for instant, `bg-gray-4` for studio.
                pill(match item.mode {
                    RecordingMode::Instant => Hsla::from(theme.blue_100),
                    RecordingMode::Studio => theme.settings_fill(),
                })
                .child(glyph(item.mode.icon()))
                .child(item.mode.label()),
            )
            .when(item.clip_count > 1, |this| {
                this.child(pill(theme.settings_fill()).child(format!("{} clips", item.clip_count)))
            })
            .when(item.status.is_in_progress(), |this| {
                this.child(
                    pill(Hsla::from(theme.blue_500))
                        .child(glyph("icons/record-fill.svg"))
                        .child("Recording in progress"),
                )
            })
            .when_some(item.status.error().map(str::to_string), |this, error| {
                this.child(
                    // The badge is wrapped in a `<CapTooltip>` whose content is
                    // the error string.
                    pill(Hsla::from(theme.red_9))
                        .id("recording-failed")
                        .child(glyph("icons/warning-bold.svg"))
                        .child("Recording failed")
                        .tooltip(move |_window, cx| {
                            ui::Tooltip::new(&theme, error.clone())
                                .style(ui::TooltipStyle::Light)
                                .view(cx)
                        }),
                )
            })
    }

    /// The row's right-hand button group: `flex gap-2 items-center`.
    ///
    /// Studio rows get Open link (when shared) and Edit; instant rows get
    /// Reupload and Open link; both get Open recording bundle and Delete.
    fn render_recording_actions(
        &self,
        index: usize,
        item: &RecordingItem,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let mode = item.mode;
        let path = item.path.clone();
        let sharing = item.sharing.clone();
        let failed = item.status.error().is_some();
        let in_progress = item.status.is_in_progress();

        let mut actions = div().flex().flex_row().items_center().gap(px(8.));

        if mode == RecordingMode::Studio {
            if let Some(link) = sharing.clone() {
                actions = actions.child(self.row_button(
                    ("recording-link", index),
                    "icons/link.svg",
                    "Open link",
                    false,
                    cx,
                    move |_this, _window, cx| cx.open_url(&link),
                ));
            }
            let editor_path = path.clone();
            actions = actions.child(self.row_button(
                ("recording-edit", index),
                "icons/edit.svg",
                "Edit",
                // `disabled={status === "InProgress"}`
                in_progress,
                cx,
                move |this, window, cx| {
                    this.open_editor_confirmed(editor_path.clone(), failed, window, cx)
                },
            ));
        }

        if mode == RecordingMode::Instant {
            // `uploadExportedVideo(path, "Reupload", ..)`: there is no upload
            // infrastructure here, so the button is drawn disabled (README).
            actions = actions.child(self.row_button(
                ("recording-reupload", index),
                "icons/rotate-ccw.svg",
                "Reupload",
                true,
                cx,
                |_, _, _| {},
            ));
            if let Some(link) = sharing {
                actions = actions.child(self.row_button(
                    ("recording-instant-link", index),
                    "icons/link.svg",
                    "Open link",
                    false,
                    cx,
                    move |_this, _window, cx| cx.open_url(&link),
                ));
            }
        }

        let folder_path = path.clone();
        actions = actions.child(self.row_button(
            ("recording-folder", index),
            "icons/folder.svg",
            "Open recording bundle",
            false,
            cx,
            move |_this, _window, _cx| library::open_recording_folder(&folder_path, mode),
        ));
        actions.child(self.row_button(
            ("recording-delete", index),
            "icons/trash.svg",
            "Delete",
            false,
            cx,
            move |this, window, cx| this.delete_recording(path.clone(), window, cx),
        ))
    }

    /// `TooltipIconButton`: `p-2.5 opacity-70 hover:opacity-100 rounded-full
    /// hover:bg-gray-3 dark:hover:bg-gray-5 disabled:pointer-events-none
    /// disabled:opacity-45`, around a `size-4` glyph -- 36px of hit area.
    ///
    /// `onClick` calls `e.stopPropagation()` before the handler, because the
    /// row around it is itself a button. gpui's equivalent is to stop the
    /// *mouse-down* propagating: a click listener only fires for an element
    /// that saw the press, so blocking the press at this element leaves the
    /// row's click unarmed while this button's own still fires (its
    /// click-tracking listener is registered after the custom one and therefore
    /// runs first in the bubble phase).
    fn row_button(
        &self,
        id: impl Into<gpui::ElementId>,
        icon: &'static str,
        tooltip: &'static str,
        disabled: bool,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> impl IntoElement {
        let theme = self.theme;

        div()
            .id(id.into())
            .flex()
            .items_center()
            .justify_center()
            .size(px(36.))
            .flex_shrink_0()
            .rounded_full()
            .opacity(if disabled { 0.45 } else { 0.7 })
            .child(svg().path(icon).size(px(16.)).text_color(theme.settings_text()))
            .when(!disabled, |this| {
                this.cursor_pointer()
                    .hover(|style| style.opacity(1.).bg(theme.settings_fill()))
                    .tooltip(move |_window, cx| {
                        ui::Tooltip::new(&theme, tooltip)
                            .style(ui::TooltipStyle::Light)
                            .view(cx)
                    })
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            })
    }

    // -- The General page --------------------------------------------------

    fn render_general(&self, window: &Window, cx: &mut Context<Self>) -> Vec<gpui::AnyElement> {
        vec![
            self.render_appearance(cx).into_any_element(),
            self.render_app_section(cx).into_any_element(),
            self.render_cap_pro(cx).into_any_element(),
            self.render_quality(cx).into_any_element(),
            self.render_recording(cx).into_any_element(),
            self.render_storage(cx).into_any_element(),
            self.render_project_name(window, cx).into_any_element(),
            self.render_excluded_windows(cx).into_any_element(),
            self.render_updates(cx).into_any_element(),
            self.render_self_host(window, cx).into_any_element(),
            self.render_privacy(cx).into_any_element(),
        ]
    }

    /// `AppearanceSection` -- `theme`.
    fn render_appearance(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.settings.theme;

        let tiles = div()
            // `grid grid-cols-3 gap-3`
            .flex()
            .flex_row()
            .gap(px(12.))
            .children(AppTheme::ALL.iter().copied().map(|option| {
                let selected = option == current;
                div()
                    .id(SharedString::from(option.as_json()))
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .w_full()
                            // `aspect-[5/3]`, which gpui cannot express: this
                            // is the height the tile has at the window's
                            // default 782 width (see the README).
                            .h(px(93.))
                            .rounded(px(8.))
                            .overflow_hidden()
                            .border_2()
                            .border_color(if selected {
                                theme.blue_9.into()
                            } else {
                                Hsla::from(theme.gray_4)
                            })
                            .child(img(theme_preview(option)).size_full()),
                    )
                    .child(
                        // `text-xs font-medium`, gray-12 when selected and
                        // gray-10 -- i.e. muted -- when not.
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(if selected {
                                theme.settings_text()
                            } else {
                                theme.settings_muted()
                            })
                            .child(option.label()),
                    )
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.settings.theme = option;
                        this.write_enum("theme", option, cx);
                    }))
            }));

        self.section(
            "Appearance",
            Some("Match Cap to your system theme or pick a fixed look."),
            None,
            vec![self.card(true).child(tiles).into_any_element()],
        )
    }

    /// The macOS-only App section: `hideDockIcon`, `enableNotifications`.
    fn render_app_section(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.section(
            "App",
            Some("Choose how Cap shows up on your system."),
            None,
            vec![
                self.rows(vec![
                    self.setting_row(
                        "Always show dock icon",
                        Some("Keep Cap in the dock even when no windows are open."),
                        // The row is the *inverse* of the stored key.
                        self.toggle(
                            "hide-dock-icon",
                            !self.settings.hide_dock_icon,
                            cx,
                            |this, cx| {
                                this.settings.hide_dock_icon = !this.settings.hide_dock_icon;
                                let value = this.settings.hide_dock_icon;
                                this.write_bool("hideDockIcon", value, cx);
                                // `GeneralSettingsStore::set` -> the store
                                // listener -> `schedule_macos_dock_visibility_sync`.
                                // Deferred past the debounced write, which is
                                // what the sync then reads back.
                                cx.defer(|cx: &mut gpui::App| {
                                    crate::menus::schedule_dock_sync(cx)
                                });
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "System notifications",
                        Some(
                            "Show notifications for clipboard copies, saved files, and more. \
                             You may need to allow Cap in your system's notification settings.",
                        ),
                        self.toggle(
                            "enable-notifications",
                            self.settings.enable_notifications,
                            cx,
                            |this, cx| {
                                // The Tauri handler asks for the notification
                                // permission before enabling; nothing here
                                // posts notifications yet, so there is nothing
                                // to ask for.
                                this.settings.enable_notifications =
                                    !this.settings.enable_notifications;
                                let value = this.settings.enable_notifications;
                                this.write_bool("enableNotifications", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                ])
                .into_any_element(),
            ],
        )
    }

    /// `CapProSection` -- `instantModeMaxResolution`, `disableAutoOpenLinks`.
    ///
    /// `hasCapPro` comes from the auth store's plan, which this app does not
    /// read, so the section renders its free-plan variant: the resolution is
    /// pinned to 720p and the other tiers are inert (the Tauri app answers a
    /// click on them with an upgrade toast).
    fn render_cap_pro(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let effective = FREE_INSTANT_MODE_MAX_RESOLUTION;
        let summary = INSTANT_RESOLUTION_TIERS
            .iter()
            .find(|(value, _, _)| *value == effective)
            .map(|(_, _, summary)| *summary)
            .unwrap_or_default();

        let resolution = div()
            .flex()
            .flex_col()
            .items_end()
            .gap(px(6.))
            .child(
                self.segmented_raw(
                    "instant-resolution",
                    INSTANT_RESOLUTION_TIERS
                        .iter()
                        .map(|(value, label, _)| ui::SegmentOption::new(*label, *value == effective))
                        .collect(),
                    cx,
                    |_, _, _| {},
                ),
            )
            .child(
                div()
                    .text_size(px(11.))
                    .line_height(px(15.))
                    .text_color(theme.settings_muted())
                    .child(summary),
            );

        self.section(
            "Cap Pro",
            Some("Settings available with a Cap Pro license."),
            None,
            vec![
                self.rows(vec![
                    self.setting_row(
                        "Instant Mode quality",
                        Some(
                            "Instant recordings are locked to 720p. Cap Pro unlocks higher \
                             resolutions.",
                        ),
                        resolution.into_any_element(),
                    ),
                    self.setting_row(
                        "Auto-open shareable links",
                        Some("Open the share link in your browser as soon as the upload finishes."),
                        self.toggle(
                            "auto-open-links",
                            !self.settings.disable_auto_open_links,
                            cx,
                            |this, cx| {
                                this.settings.disable_auto_open_links =
                                    !this.settings.disable_auto_open_links;
                                let value = this.settings.disable_auto_open_links;
                                this.write_bool("disableAutoOpenLinks", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                ])
                .into_any_element(),
            ],
        )
        .pro()
    }

    /// `QualitySection` / `StudioQualitySubsection` -- `studioRecordingQuality`.
    fn render_quality(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.settings.studio_recording_quality;
        let (_, summary, best_for) = STUDIO_QUALITY_TIERS
            .iter()
            .find(|(value, _, _)| *value == current)
            .copied()
            .unwrap_or(STUDIO_QUALITY_TIERS[1]);

        let body = div()
            // `flex flex-col gap-3 px-4 py-4`
            .flex()
            .flex_col()
            .gap(px(12.))
            .px(px(16.))
            .py(px(16.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_start()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(div().text_size(px(13.)).child("Studio mode"))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(theme.settings_muted())
                                    .child("Encoder profile for local Studio recordings."),
                            ),
                    )
                    .child(self.segmented::<StudioQuality>(
                        "studio-quality",
                        current,
                        cx,
                        |this, value, cx| {
                            this.settings.studio_recording_quality = value;
                            this.write_enum("studioRecordingQuality", value, cx);
                        },
                    )),
            )
            .child(
                self.note_box()
                    .child(div().text_size(px(12.)).child(summary))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(4.))
                            .text_size(px(11.))
                            .line_height(px(15.))
                            .text_color(theme.settings_muted())
                            .child(div().child("Best for:"))
                            .child(div().child(best_for)),
                    ),
            );

        self.section(
            "Quality",
            Some("Pick the right profile for local Studio recordings."),
            None,
            vec![self.card(false).child(body).into_any_element()],
        )
    }

    /// The Recording card: thirteen rows, in TSX order.
    fn render_recording(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let settings = &self.settings;

        let countdown_label = COUNTDOWN_OPTIONS
            .iter()
            .find(|(value, _)| *value == settings.recording_countdown.unwrap_or(0))
            .map(|(_, label)| (*label).to_string())
            .unwrap_or_else(|| settings.recording_countdown.unwrap_or(0).to_string());
        let fps_label = MAX_FPS_OPTIONS
            .iter()
            .find(|(value, _)| *value == settings.max_fps)
            .map(|(_, label)| (*label).to_string())
            .unwrap_or_else(|| settings.max_fps.to_string());
        let zoom = settings.default_zoom_amount.unwrap_or(1.5);

        self.section(
            "Recording",
            Some("Behaviour while you record and after you stop."),
            None,
            vec![
                self.rows(vec![
                    self.setting_row(
                        "Countdown",
                        Some("Wait before the recording starts."),
                        self.select("countdown", countdown_label, MenuKind::Countdown, cx)
                            .into_any_element(),
                    ),
                    self.setting_row(
                        "Confirm before recording without a microphone",
                        Some(
                            "Require confirmation when no microphone is selected or the \
                             selected microphone is unavailable.",
                        ),
                        self.toggle(
                            "confirm-without-mic",
                            settings.confirm_without_microphone,
                            cx,
                            |this, cx| {
                                // The one row on this page that is not a
                                // `general_settings` key.
                                this.settings.confirm_without_microphone =
                                    !this.settings.confirm_without_microphone;
                                let value = this.settings.confirm_without_microphone;
                                store::set_store_setting(
                                    RECORDING_START_SAFETY,
                                    "confirmBeforeRecordingWithoutMicrophone",
                                    Value::Bool(value),
                                );
                                cx.notify();
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Main window when recording starts",
                        Some("What happens to the main window once a recording begins."),
                        self.select(
                            "main-window-start",
                            settings.main_window_recording_start_behaviour.label(),
                            MenuKind::MainWindowStart,
                            cx,
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "After a Studio recording",
                        Some("What happens once you stop a Studio recording."),
                        self.select(
                            "post-studio",
                            settings.post_studio_recording_behaviour.label(),
                            MenuKind::PostStudio,
                            cx,
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "After deleting a recording",
                        Some("Whether the recording window should reopen."),
                        self.select(
                            "post-deletion",
                            settings.post_deletion_behaviour.label(),
                            MenuKind::PostDeletion,
                            cx,
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Delete Instant recordings after upload",
                        Some("Cap removes the local file once it has uploaded successfully."),
                        self.toggle(
                            "delete-after-upload",
                            settings.delete_instant_recordings_after_upload,
                            cx,
                            |this, cx| {
                                this.settings.delete_instant_recordings_after_upload =
                                    !this.settings.delete_instant_recordings_after_upload;
                                let value = this.settings.delete_instant_recordings_after_upload;
                                this.write_bool("deleteInstantRecordingsAfterUpload", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Crash-recoverable recording",
                        Some(
                            "Record in fragments that can be recovered after a crash or power \
                             loss. Slightly larger files during capture.",
                        ),
                        self.toggle(
                            "crash-recovery",
                            settings.crash_recovery_recording,
                            cx,
                            |this, cx| {
                                this.settings.crash_recovery_recording =
                                    !this.settings.crash_recovery_recording;
                                let value = this.settings.crash_recovery_recording;
                                this.write_bool("crashRecoveryRecording", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Custom cursor capture (Studio)",
                        Some(
                            "Capture cursor state separately so you can adjust size and \
                             smoothing in the editor.",
                        ),
                        self.toggle(
                            "custom-cursor",
                            settings.custom_cursor_capture,
                            cx,
                            |this, cx| {
                                this.settings.custom_cursor_capture =
                                    !this.settings.custom_cursor_capture;
                                let value = this.settings.custom_cursor_capture;
                                this.write_bool("custom_cursor_capture2", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Auto zoom on clicks",
                        Some(
                            "Automatically add zoom segments around mouse clicks in Studio \
                             recordings.",
                        ),
                        self.toggle("auto-zoom", settings.auto_zoom_on_clicks, cx, |this, cx| {
                            this.settings.auto_zoom_on_clicks = !this.settings.auto_zoom_on_clicks;
                            let value = this.settings.auto_zoom_on_clicks;
                            this.write_bool("autoZoomOnClicks", value, cx);
                        })
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Default zoom amount",
                        Some("Zoom level for newly created and auto-generated zoom segments."),
                        div()
                            // `flex gap-2 items-center w-52`
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .w(px(208.))
                            .child(self.render_zoom_slider(zoom, cx))
                            .child(
                                // `w-9 text-xs text-right text-gray-11 tabular-nums`
                                div()
                                    .w(px(36.))
                                    .text_size(px(12.))
                                    .text_color(theme.settings_muted())
                                    .child(format!("{zoom:.1}x")),
                            )
                            .into_any_element(),
                    ),
                    self.setting_row(
                        "Capture keyboard presses",
                        Some("Record key presses so you can add keyboard overlays in the editor."),
                        self.toggle(
                            "capture-keyboard",
                            settings.capture_keyboard_events,
                            cx,
                            |this, cx| {
                                this.settings.capture_keyboard_events =
                                    !this.settings.capture_keyboard_events;
                                let value = this.settings.capture_keyboard_events;
                                this.write_bool("captureKeyboardEvents", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Draw the MacBook notch on screen recordings",
                        Some(
                            "Automatically restores the notch for new screen and area \
                             recordings when the selected region contains the complete notch. \
                             External displays, partial areas, and window recordings are left \
                             alone. Each recording can override it in the editor.",
                        ),
                        self.toggle(
                            "notch-overlay",
                            settings.macbook_notch_overlay,
                            cx,
                            |this, cx| {
                                this.settings.macbook_notch_overlay =
                                    !this.settings.macbook_notch_overlay;
                                let value = this.settings.macbook_notch_overlay;
                                this.write_bool("macbookNotchOverlay", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                    self.setting_row(
                        "Max capture framerate",
                        Some(if settings.max_fps > 60 {
                            "Maximum framerate for screen capture. Higher values may cause \
                             drops or increased CPU usage on some systems."
                        } else {
                            "Maximum framerate for screen capture."
                        }),
                        self.select("max-fps", fps_label, MenuKind::MaxFps, cx)
                            .into_any_element(),
                    ),
                ])
                .into_any_element(),
            ],
        )
    }

    /// `StorageSection` -- `recordingsPath`.
    fn render_storage(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let path = self.settings.recordings_path.clone();
        let is_custom = path.is_some();
        // `Default (Application Support)`
        let display = path.unwrap_or_else(|| "Default (Application Support)".to_string());

        let mut actions = div().flex().flex_row().justify_end().gap(px(8.));
        if is_custom {
            actions = actions.child(self.button(
                "recordings-reset",
                ui::ButtonVariant::Gray,
                None,
                "Reset to Default",
                false,
                cx,
                |this, _window, cx| {
                    this.settings.recordings_path = None;
                    this.write("recordingsPath", Value::Null, cx);
                },
            ));
        }
        actions = actions.child(self.button(
            "recordings-pick",
            ui::ButtonVariant::Dark,
            None,
            "Choose Folder",
            false,
            cx,
            |_, window, cx| {
                // `commands.pickRecordingsFolder()` opens an NSOpenPanel in
                // directory mode; gpui wraps the same panel.
                let paths = cx.prompt_for_paths(gpui::PathPromptOptions {
                    files: false,
                    directories: true,
                    multiple: false,
                    prompt: None,
                });
                cx.spawn_in(window, async move |this, cx| {
                    let Ok(Ok(Some(paths))) = paths.await else {
                        return;
                    };
                    let Some(path) = paths.into_iter().next() else {
                        return;
                    };
                    this.update(cx, |this, cx| {
                        let path = path.to_string_lossy().to_string();
                        this.settings.recordings_path = Some(path.clone());
                        this.write("recordingsPath", Value::String(path), cx);
                    })
                    .ok();
                })
                .detach();
            },
        ));

        self.section(
            "Storage",
            Some("Where Cap saves your recordings."),
            None,
            vec![
                self.card(true)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(12.))
                            .child(
                                // `flex items-center gap-2 px-3 py-2 rounded-lg
                                //  bg-gray-3 border border-gray-4 min-w-0`
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.))
                                    .px(px(12.))
                                    .py(px(8.))
                                    .min_w_0()
                                    .rounded(px(8.))
                                    .bg(theme.settings_fill())
                                    .border_1()
                                    .border_color(theme.settings_border())
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .truncate()
                                            .text_size(px(12.))
                                            .child(display),
                                    ),
                            )
                            .child(actions),
                    )
                    .into_any_element(),
            ],
        )
    }

    /// `DefaultProjectNameCard` -- `defaultProjectNameTemplate`.
    fn render_project_name(&self, _window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let stored = self
            .settings
            .default_project_name_template
            .clone()
            .unwrap_or_else(|| DEFAULT_PROJECT_NAME_TEMPLATE.to_string());
        let draft = self.project_name.clone();
        let save_disabled = draft.is_empty() || draft == stored || draft.chars().count() <= 3;
        let reset_disabled = draft == DEFAULT_PROJECT_NAME_TEMPLATE
            && self.settings.default_project_name_template.is_none();

        let right = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(self.button(
                "project-name-reset",
                ui::ButtonVariant::Gray,
                None,
                "Reset",
                reset_disabled,
                cx,
                |this, _window, cx| {
                    this.settings.default_project_name_template = None;
                    this.project_name = DEFAULT_PROJECT_NAME_TEMPLATE.to_string();
                    let input = this.project_name_input.clone();
                    input.update(cx, |input, cx| {
                        input.set_text(DEFAULT_PROJECT_NAME_TEMPLATE, cx)
                    });
                    this.write("defaultProjectNameTemplate", Value::Null, cx);
                },
            ))
            .child(self.button(
                "project-name-save",
                ui::ButtonVariant::Dark,
                None,
                "Save",
                save_disabled,
                cx,
                |this, _window, cx| {
                    let template = this.project_name.clone();
                    this.settings.default_project_name_template = Some(template.clone());
                    this.write("defaultProjectNameTemplate", Value::String(template), cx);
                },
            ))
            .into_any_element();

        let placeholder_rows: Vec<(&str, &str, &str)> = vec![
            (
                "Recording mode",
                "{recording_mode}",
                "\"Studio\", \"Instant\", or \"Screenshot\"",
            ),
            ("", "{mode}", "\"studio\", \"instant\", or \"screenshot\""),
            (
                "Target",
                "{target_kind}",
                "\"Display\", \"Window\", or \"Area\"",
            ),
            ("", "{target_name}", "Monitor name or window title."),
            ("Date & time", "{date}", "the recording's date"),
            ("", "{time}", "the recording's time"),
        ];

        let body =
            div()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(self.text_field(Field::ProjectName, cx))
                .child(
                    // The live preview box. The Tauri card renders
                    // `commands.formatProjectName(...)`; ours formats the six
                    // literal placeholders (see `format_project_name`).
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(8.))
                        .px(px(12.))
                        .py(px(8.))
                        .rounded(px(8.))
                        .bg(theme.settings_fill())
                        .border_dashed()
                        .border_1()
                        .border_color(theme.settings_border())
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .truncate()
                                .text_size(px(12.))
                                .child(format_project_name(&draft)),
                        ),
                )
                .child(
                    div()
                        .id("placeholders-trigger")
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(4.))
                        .text_size(px(12.))
                        .text_color(theme.settings_muted())
                        .child(
                            svg()
                                .path("icons/chevron-down.svg")
                                .size(px(14.))
                                .text_color(theme.settings_muted()),
                        )
                        .child("Available placeholders")
                        .on_click(cx.listener(|this, _, _window, cx| {
                            this.toggle_placeholders(cx);
                        })),
                )
                // Mounted while open *and* while animating shut, so the reveal
                // has something to collapse; unmounted once settled closed, or
                // the parent's `gap-3` would leave a 12px hole under the
                // trigger.
                .when(
                    self.placeholders.is_open() || self.placeholders.is_animating(),
                    |this| {
                        let (height, _) = self.placeholders.height_for(std::time::Instant::now());
                        this.child(ui::Collapsible::new(height, self.placeholders.measure_cell()).content(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.))
                            .text_size(px(12.))
                            .children(placeholder_rows.into_iter().map(
                                |(heading, code, meaning)| {
                                    div()
                                        .flex()
                                        .flex_col()
                                        .gap(px(4.))
                                        .when(!heading.is_empty(), |this| {
                                            this.child(
                                                div()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .child(heading.to_string()),
                                            )
                                        })
                                        .child(
                                            div()
                                                .flex()
                                                .flex_row()
                                                .items_center()
                                                .gap(px(6.))
                                                .child(
                                                    div()
                                                        .px(px(6.))
                                                        .py(px(2.))
                                                        .rounded(px(6.))
                                                        .bg(theme.settings_fill())
                                                        .text_size(px(11.))
                                                        .child(code.to_string()),
                                                )
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .min_w_0()
                                                        .truncate()
                                                        .text_color(theme.settings_muted())
                                                        .child(format!("-> {meaning}")),
                                                ),
                                        )
                                },
                            )),
                        ))
                    },
                );

        self.section(
            "Default project name",
            Some("Template used for new recordings and exported files."),
            Some(right),
            vec![self.card(true).child(body).into_any_element()],
        )
    }

    /// `ExcludedWindowsCard` -- `excludedWindows`.
    fn render_excluded_windows(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let missing = self.missing_default_exclusions();

        let right = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .child(self.button(
                "exclusions-reset",
                ui::ButtonVariant::Gray,
                None,
                "Reset",
                false,
                cx,
                |this, _window, cx| {
                    this.write_excluded(store::default_excluded_windows(), cx);
                },
            ))
            .child(
                self.button(
                    "exclusions-add",
                    ui::ButtonVariant::Dark,
                    Some("icons/plus.svg"),
                    "Add",
                    self.windows.is_empty(),
                    cx,
                    |_, _, _| {},
                )
                .on_click(cx.listener(
                    |this, event: &gpui::ClickEvent, window, cx| {
                        if !this.windows.is_empty() {
                            this.open_menu(MenuKind::AddWindow, event.position(), window, cx);
                        }
                    },
                )),
            )
            .into_any_element();

        let chips = if self.settings.excluded_windows.is_empty() {
            div()
                .text_size(px(12.))
                .text_color(theme.settings_muted())
                .child("No windows are currently excluded.")
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_row()
                .flex_wrap()
                .gap(px(8.))
                .children(self.settings.excluded_windows.iter().enumerate().map(
                    |(index, entry)| {
                        let secondary = entry.secondary_label().map(str::to_string);
                        div()
                            // `flex gap-2 items-center pr-1 pl-3 py-1.5
                            //  rounded-full border bg-gray-3 border-gray-4`
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(8.))
                            .pl(px(12.))
                            .pr(px(4.))
                            .py(px(6.))
                            .rounded_full()
                            .bg(theme.settings_fill())
                            .border_1()
                            .border_color(theme.settings_border())
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .child(entry.primary_label().to_string()),
                                    )
                                    .children(secondary.map(|label| {
                                        div()
                                            .text_size(px(10.))
                                            .text_color(theme.settings_muted())
                                            .child(label)
                                    })),
                            )
                            .child(
                                div()
                                    .id(SharedString::from(format!("exclusion-{index}")))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .size(px(20.))
                                    .rounded_full()
                                    .child(
                                        svg()
                                            .path("icons/x.svg")
                                            .size(px(12.))
                                            .text_color(theme.settings_muted()),
                                    )
                                    .hover(|style| style.bg(theme.settings_selection()))
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        let mut next = this.settings.excluded_windows.clone();
                                        if index < next.len() {
                                            next.remove(index);
                                        }
                                        this.write_excluded(next, cx);
                                    })),
                            )
                    },
                ))
                .into_any_element()
        };

        let mut card = self.card(true).flex().flex_col();
        if !missing.is_empty() {
            let names = missing
                .iter()
                .map(|entry| entry.primary_label().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            card = card.child(
                // `mb-3 rounded-lg border border-amber-6 bg-amber-3/30 px-3 py-2.5`
                div()
                    .flex()
                    .flex_row()
                    .items_start()
                    .gap(px(8.))
                    .mb(px(12.))
                    .px(px(12.))
                    .py(px(10.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(Hsla::from(theme.amber_6))
                    .bg(Theme::with_alpha(theme.amber_3, 0.3))
                    .child(
                        svg()
                            .path("icons/triangle-alert.svg")
                            .size(px(16.))
                            .flex_shrink_0()
                            .mt(px(2.))
                            .text_color(Hsla::from(theme.amber_11)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .gap(px(4.))
                            .text_color(Hsla::from(theme.amber_11))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("Recommended Cap windows are not excluded"),
                            )
                            .child(div().text_size(px(10.)).line_height(px(14.)).child(format!(
                                "Camera, settings, or recording windows can appear as black \
                                 boxes in screen recordings. Missing: {names}."
                            ))),
                    )
                    .child(self.button(
                        "exclusions-restore",
                        ui::ButtonVariant::Gray,
                        None,
                        "Restore",
                        false,
                        cx,
                        |this, _window, cx| {
                            this.write_excluded(store::default_excluded_windows(), cx);
                        },
                    )),
            );
        }

        self.section(
            "Excluded windows",
            Some("Hide windows from recordings."),
            Some(right),
            vec![card.child(chips).into_any_element()],
        )
    }

    /// `UpdatesSection` -- `updateChannel`.
    fn render_updates(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let current = self.settings.update_channel;
        let description = UPDATE_CHANNEL_DESCRIPTIONS
            .iter()
            .find(|(channel, _)| *channel == current)
            .map(|(_, description)| *description)
            .unwrap_or_default();

        let body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .px(px(16.))
            .py(px(16.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_start()
                    .gap(px(16.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(div().text_size(px(13.)).child("Update channel"))
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(16.))
                                    .text_color(theme.settings_muted())
                                    .child("Which release channel Cap updates from."),
                            ),
                    )
                    .child(self.segmented::<UpdateChannel>(
                        "update-channel",
                        current,
                        cx,
                        |this, value, cx| {
                            this.settings.update_channel = value;
                            this.write_enum("updateChannel", value, cx);
                        },
                    )),
            )
            .child(
                self.note_box()
                    .child(div().text_size(px(12.)).child(description))
                    .when(current == UpdateChannel::Nightly, |this| {
                        this.child(
                            div()
                                .text_size(px(11.))
                                .line_height(px(15.))
                                .text_color(theme.settings_muted())
                                .child(
                                    "Switching back to Stable will return you to the latest \
                                     stable version, which may be older than your current build.",
                                ),
                        )
                    }),
            );

        self.section(
            "Updates",
            Some("Choose which Cap builds you receive."),
            None,
            vec![self.card(false).child(body).into_any_element()],
        )
    }

    /// `ServerURLSetting` -- `serverUrl`.
    fn render_self_host(&self, _window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let stored = self.settings.server_url.clone();
        let draft = self.server_url.clone();

        let body = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(6.))
                    .child(div().text_size(px(13.)).child("Cap Server URL"))
                    .child(self.text_field(Field::ServerUrl, cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.))
                    .child(self.button(
                        "server-url-reset",
                        ui::ButtonVariant::Gray,
                        None,
                        "Reset to Default",
                        stored == DEFAULT_SERVER_URL && draft == DEFAULT_SERVER_URL,
                        cx,
                        |this, window, cx| {
                            if this.settings.server_url == DEFAULT_SERVER_URL {
                                this.server_url = DEFAULT_SERVER_URL.to_string();
                                let input = this.server_url_input.clone();
                                input.update(cx, |input, cx| {
                                    input.set_text(DEFAULT_SERVER_URL, cx)
                                });
                                cx.notify();
                                return;
                            }
                            this.confirm_server_url(DEFAULT_SERVER_URL.to_string(), window, cx);
                        },
                    ))
                    .child(self.button(
                        "server-url-update",
                        ui::ButtonVariant::Dark,
                        None,
                        "Update",
                        stored == draft,
                        cx,
                        |this, window, cx| {
                            let value = this.server_url.clone();
                            this.confirm_server_url(value, window, cx);
                        },
                    )),
            );

        self.section(
            "Self-host",
            Some("Only change this if you are running your own instance of Cap Web."),
            None,
            vec![self.card(true).child(body).into_any_element()],
        )
    }

    /// The `confirm()` the Tauri handler puts in front of a server change. It
    /// also signs the user out; there is no auth store here to clear.
    fn confirm_server_url(&mut self, value: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(origin) = origin_of(&value) else {
            return;
        };
        let answer = window.prompt(
            gpui::PromptLevel::Warning,
            &format!(
                "Are you sure you want to change the server URL to '{origin}'? You will need \
                 to sign in again."
            ),
            None,
            &["Ok", "Cancel"],
            cx,
        );
        cx.spawn(async move |this, cx| {
            if answer.await.ok() != Some(0) {
                return;
            }
            this.update(cx, |this, cx| {
                this.settings.server_url = origin.clone();
                this.server_url = origin.clone();
                let input = this.server_url_input.clone();
                input.update(cx, |input, cx| input.set_text(origin.clone(), cx));
                this.write("serverUrl", Value::String(origin), cx);
            })
            .ok();
        })
        .detach();
    }

    /// `TelemetryCard` -- `enableTelemetry`.
    fn render_privacy(&self, cx: &mut Context<Self>) -> impl IntoElement {
        self.section(
            "Privacy",
            None,
            None,
            vec![
                self.rows(vec![
                    self.setting_row(
                        "Share anonymous telemetry",
                        Some(
                            "Cap uses anonymous telemetry to improve reliability and fix bugs. We \
                         never collect recording contents, window titles, file paths, or \
                         personal information.",
                        ),
                        self.toggle(
                            "telemetry",
                            self.settings.enable_telemetry,
                            cx,
                            |this, cx| {
                                this.settings.enable_telemetry = !this.settings.enable_telemetry;
                                let value = this.settings.enable_telemetry;
                                this.write_bool("enableTelemetry", value, cx);
                            },
                        )
                        .into_any_element(),
                    ),
                ])
                .into_any_element(),
            ],
        )
    }

    // -- Primitives (Setting.tsx) -----------------------------------------

    /// `<Section>`: `space-y-2.5`, header `flex justify-between items-end
    /// gap-3 px-1`, title `text-sm font-semibold tracking-tight`, description
    /// `text-xs leading-relaxed text-gray-10`.
    fn section(
        &self,
        title: &'static str,
        description: Option<&'static str>,
        right: Option<gpui::AnyElement>,
        children: Vec<gpui::AnyElement>,
    ) -> ui::Section {
        ui::Section::settings(&self.theme, title, description, right, children)
    }

    /// `<SectionCard>` -- [`ui::Card::settings`].
    fn card(&self, padded: bool) -> gpui::Div {
        ui::Card::settings(&self.theme, padded)
    }

    /// `<SectionRows>`: the same card with `divide-y divide-gray-3`.
    fn rows(&self, children: Vec<gpui::AnyElement>) -> gpui::Div {
        ui::Card::settings_rows(&self.theme, children)
    }

    /// `<SettingItem>` -- [`ui::SettingRow`].
    fn setting_row(
        &self,
        label: &'static str,
        description: Option<&'static str>,
        control: gpui::AnyElement,
    ) -> gpui::AnyElement {
        ui::SettingRow::settings(&self.theme, label, description, control).into_any_element()
    }

    /// The grey explanation box under the two segmented controls:
    /// `flex flex-col gap-1.5 px-3 py-2.5 rounded-lg bg-gray-3`.
    fn note_box(&self) -> gpui::Div {
        div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .px(px(12.))
            .py(px(10.))
            .rounded(px(8.))
            .bg(self.theme.settings_fill())
    }

    /// `<Toggle size="sm">` on the settings material -- [`ui::Toggle::settings`].
    fn toggle(
        &self,
        id: &'static str,
        checked: bool,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> ui::Toggle {
        ui::Toggle::settings(&self.theme, id, checked)
            .on_click(cx.listener(move |this, _, _window, cx| on_change(this, cx)))
    }

    /// `SelectSettingItem`'s button -- [`ui::Select::settings`], opening the
    /// in-window stand-in for `Menu.popup()`.
    fn select(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        kind: MenuKind,
        cx: &mut Context<Self>,
    ) -> ui::Select {
        ui::Select::settings(&self.theme, id, label).on_click(cx.listener(
            move |this, event: &gpui::ClickEvent, window, cx| {
                this.open_menu(kind, event.position(), window, cx);
            },
        ))
    }

    /// `SegmentedControl` over a [`SettingsEnum`].
    fn segmented<T: SettingsEnum>(
        &self,
        id: &'static str,
        current: T,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, T, &mut Context<Self>) + Clone + 'static,
    ) -> ui::SegmentedControl {
        self.segmented_raw(
            id,
            T::ALL
                .iter()
                .map(|value| ui::SegmentOption::new(value.label(), *value == current))
                .collect(),
            cx,
            move |this, index, cx| {
                if let Some(value) = ui::option_at(T::ALL, index) {
                    on_change(this, value, cx);
                }
            },
        )
    }

    /// [`ui::SegmentedControl::settings`].
    fn segmented_raw(
        &self,
        id: &'static str,
        options: Vec<ui::SegmentOption>,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, usize, &mut Context<Self>) + Clone + 'static,
    ) -> ui::SegmentedControl {
        ui::SegmentedControl::settings(&self.theme, id, options).on_select(cx.listener(
            move |this, index: &usize, _window, cx| on_change(this, *index, cx),
        ))
    }

    /// `<Button size="sm">` under the settings material -- [`ui::Button::settings`].
    fn button(
        &self,
        id: &'static str,
        variant: ui::ButtonVariant,
        icon: Option<&'static str>,
        label: &'static str,
        disabled: bool,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> ui::Button {
        let mut button = ui::Button::settings(&self.theme, id, variant, ui::ButtonSize::Sm)
            .label(label)
            .disabled_settings(&self.theme, disabled);
        if let Some(icon) = icon {
            button = button.icon(icon);
        }
        button.on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
    }

    /// The General page's two inputs -- [`ui::TextInput::settings`], `<Input>`'s
    /// `h-8 rounded-lg bg-gray-2 px-2 text-xs` re-filled from the settings
    /// material.
    ///
    /// The drafts stay on this window because the *commit* is the Save /
    /// Update button, exactly as it is in the Tauri card -- neither `<input>`
    /// there binds `onKeyDown`, so Return does nothing in either app. What the
    /// window still owns is what Escape means, which is "revert to what is
    /// stored".
    fn text_field(&self, field: Field, cx: &mut Context<Self>) -> gpui::Div {
        let (id, input) = match field {
            Field::ProjectName => ("project-name-input", &self.project_name_input),
            Field::ServerUrl => ("server-url-input", &self.server_url_input),
            // Drawn by the Recordings page itself, as a search field.
            Field::RecordingsSearch => {
                ("recordings-search", &self.recordings.search_input)
            }
        };
        let _ = cx;
        div().child(ui::TextInput::settings(&self.theme, id, input))
    }

    /// Both fields' events. The draft mirrors the field so the Save/Update
    /// buttons' enablement keeps reading a plain `String`.
    fn on_field_event(
        &mut self,
        field: Field,
        input: Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                let value = input.read(cx).text().to_string();
                match field {
                    Field::ProjectName => self.project_name = value,
                    Field::ServerUrl => self.server_url = value,
                    Field::RecordingsSearch => {
                        self.recordings.search = value;
                        // `createEffect(() => { activeTab(); trimmedSearch();
                        //  setVisibleCount(PAGE_SIZE) })`.
                        self.recordings.visible_count = RECORDINGS_PAGE_SIZE;
                    }
                }
                cx.notify();
            }
            // `onKeyDown`: Escape clears the field, and *only* when there is
            // something in it -- `if (event.key === "Escape" && search())`.
            // With the field empty the key is not even preventDefault'd.
            ui::TextInputEvent::Cancelled if field == Field::RecordingsSearch => {
                if !self.recordings.search.is_empty() {
                    self.recordings.search.clear();
                    self.recordings.visible_count = RECORDINGS_PAGE_SIZE;
                    input.update(cx, |input, cx| input.set_text("", cx));
                    cx.notify();
                }
            }
            ui::TextInputEvent::Cancelled => {
                // Revert to what is stored, the way leaving the field without
                // saving does.
                let stored = match field {
                    Field::ProjectName => self
                        .settings
                        .default_project_name_template
                        .clone()
                        .unwrap_or_else(|| DEFAULT_PROJECT_NAME_TEMPLATE.to_string()),
                    Field::ServerUrl => self.settings.server_url.clone(),
                    // Taken by the guarded arm above; nothing is "stored" for
                    // the search field.
                    Field::RecordingsSearch => return,
                };
                match field {
                    Field::ProjectName => self.project_name = stored.clone(),
                    Field::ServerUrl => self.server_url = stored.clone(),
                    Field::RecordingsSearch => return,
                }
                input.update(cx, |input, cx| input.set_text(stored, cx));
                cx.notify();
            }
            _ => {}
        }
    }

    /// `<Slider minValue={1} maxValue={4.5} step={0.1}>`: a `h-[0.3rem]`
    /// `bg-gray-4` track with a `bg-blue-9` fill and a `size-4` thumb.
    fn render_zoom_slider(&self, value: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let fraction = ((value - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)).clamp(0., 1.);

        ui::Slider::new("zoom-slider", fraction, self.slider_track.clone())
            .flex()
            .track(px(5.), theme.settings_fill())
            .fill(Hsla::from(theme.blue_9))
            .thumb(
                px(16.),
                if theme.is_dark() {
                    Hsla::from(theme.gray_12)
                } else {
                    Hsla::from(theme.gray_1)
                },
                Some(theme.settings_border()),
            )
            // Transcribed, not corrected: the thumb sits half a pixel high of
            // centre over the 5px track.
            .thumb_top(px(-6.))
            .on_drag_start(cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                this.slider_dragging = true;
                this.set_zoom_from(event.position, cx);
            }))
    }

    /// While the button is held the whole window takes the mouse, so a drag
    /// that leaves the 164px track keeps updating -- what `KSlider` gets from
    /// pointer capture.
    fn render_slider_drag_layer(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.slider_dragging {
            return None;
        }
        Some(
            ui::Slider::drag_layer(
                "zoom-slider-drag",
                cx.listener(|this, event: &gpui::MouseMoveEvent, _window, cx| {
                    this.set_zoom_from(event.position, cx);
                }),
                cx.listener(|this, _, _window, cx| {
                    this.slider_dragging = false;
                    // `onChangeEnd` -- the store write happens once, at the
                    // end of the drag.
                    let value = this.settings.default_zoom_amount.unwrap_or(1.5);
                    this.write(
                        "defaultZoomAmount",
                        Value::from(f64::from(ui::snap_to_step(value, ZOOM_MIN, ZOOM_MAX, 0.1))),
                        cx,
                    );
                }),
            )
            .into_any_element(),
        )
    }

    fn set_zoom_from(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        // `step={0.1}`
        let Some(value) = ui::slider_value_at(&self.slider_track, position, ZOOM_MIN, ZOOM_MAX, 0.1)
        else {
            return;
        };
        if self.settings.default_zoom_amount != Some(value) {
            self.settings.default_zoom_amount = Some(value);
            cx.notify();
        }
    }

    // -- The stand-in for `Menu.popup()` -----------------------------------

    fn render_menu(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let menu = self.menu.as_ref()?;
        let kind = menu.kind;
        let items = self.menu_items(kind);

        Some(
            ui::Menu::settings(&self.theme, "settings-menu", items, &menu.state)
                .on_select(cx.listener(move |this, index: &usize, _window, cx| {
                    this.choose(kind, *index, cx);
                }))
                .on_dismiss(cx.listener(|this, _, _window, cx| {
                    this.menu = None;
                    cx.notify();
                }))
                .into_any_element(),
        )
    }
}

/// `minValue={1} maxValue={4.5}` on the zoom slider.
const ZOOM_MIN: f32 = 1.;
const ZOOM_MAX: f32 = 4.5;

/// `new URL(v).origin` -- the Tauri handler normalises the typed URL to its
/// origin before storing it, and throws (leaving the setting alone) when it
/// does not parse.
fn origin_of(value: &str) -> Option<String> {
    let value = value.trim();
    let (scheme, rest) = value.split_once("://")?;
    if !matches!(scheme, "http" | "https") || rest.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    (!authority.is_empty()).then(|| format!("{scheme}://{authority}"))
}

/// The preview under the project-name template.
///
/// `commands.formatProjectName` is `recording::format_project_name`, which
/// also understands `{moment:<format>}` and custom `{date:...}` / `{time:...}`
/// formats through a moment-to-chrono translation. Only the six literal
/// placeholders the card documents are substituted here (README deviation);
/// anything else is left in the string, which is what an unknown placeholder
/// does there too.
fn format_project_name(template: &str) -> String {
    // The card previews a Safari window recorded in Instant mode, at 09:41 on
    // today's date -- `DefaultProjectNameCard`'s `datetime`.
    let now = chrono::Local::now();
    let date = now.format("%Y-%m-%d").to_string();
    template
        .replace("{recording_mode}", "Instant")
        .replace("{mode}", "instant")
        .replace("{target_kind}", "Window")
        .replace("{target_name}", "Safari")
        .replace("{date}", &date)
        .replace("{time}", "09:41 AM")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sidebar list and its routes, which `showWindow({ Settings: { page } })`
    /// addresses by slug.
    #[test]
    fn every_page_round_trips_through_its_slug() {
        assert_eq!(Page::ALL.len(), 12);
        for page in Page::ALL {
            assert_eq!(Page::from_slug(page.slug()), Some(*page));
        }
        // The label and the route disagree for exactly one entry.
        assert_eq!(Page::Shortcuts.slug(), "hotkeys");
        assert_eq!(Page::from_slug("nope"), None);
    }

    #[test]
    fn server_url_is_normalised_to_its_origin() {
        assert_eq!(
            origin_of("https://cap.example.com/dashboard?x=1"),
            Some("https://cap.example.com".to_string())
        );
        assert_eq!(
            origin_of("http://localhost:3000"),
            Some("http://localhost:3000".to_string())
        );
        // `new URL()` throws on these, and the handler never runs.
        assert_eq!(origin_of("cap.so"), None);
        assert_eq!(origin_of("ftp://cap.so"), None);
        assert_eq!(origin_of(""), None);
    }

    /// `coversDefaultExclusion`: the Reset button's "is this default already
    /// covered" test, which decides whether the amber warning shows.
    #[test]
    fn default_exclusions_are_covered_by_title() {
        let default = WindowExclusion {
            window_title: Some("Cap Camera".into()),
            ..Default::default()
        };
        assert!(covers_default_exclusion(&default, &default));
        assert!(covers_default_exclusion(
            &WindowExclusion {
                owner_name: Some("Cap".into()),
                window_title: Some("Cap Camera".into()),
                ..Default::default()
            },
            &default
        ));
        assert!(!covers_default_exclusion(
            &WindowExclusion {
                window_title: Some("Cap Settings".into()),
                ..Default::default()
            },
            &default
        ));
    }

    // -- The Recordings page ------------------------------------------------

    fn recording(name: &str, mode: RecordingMode) -> RecordingItem {
        RecordingItem {
            path: std::path::PathBuf::from(format!("/tmp/{name}.cap")),
            mode,
            status: crate::library::RecordingStatus::Complete,
            clip_count: 1,
            pretty_name: name.to_string(),
            sharing: None,
            sort_time_millis: 0.,
            thumbnail: None,
        }
    }

    /// `filteredRecordings()`: the tab first, then a case-insensitive substring
    /// of the *trimmed* query against `prettyName`.
    #[test]
    fn tabs_and_search_filter_the_list() {
        let items = [
            recording("Team standup", RecordingMode::Studio),
            recording("Bug repro", RecordingMode::Instant),
            recording("STANDUP notes", RecordingMode::Instant),
        ];
        let matching = |tab, query: &str| {
            items
                .iter()
                .filter(|item| matches_recording_filters(item, tab, &query.trim().to_lowercase()))
                .map(|item| item.pretty_name.as_str())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            matching(RecordingsTab::All, ""),
            ["Team standup", "Bug repro", "STANDUP notes"]
        );
        assert_eq!(matching(RecordingsTab::Studio, ""), ["Team standup"]);
        assert_eq!(
            matching(RecordingsTab::Instant, ""),
            ["Bug repro", "STANDUP notes"]
        );
        // Case-insensitive, and whitespace-only is no filter at all.
        assert_eq!(
            matching(RecordingsTab::All, "standup"),
            ["Team standup", "STANDUP notes"]
        );
        assert_eq!(matching(RecordingsTab::All, "  "), [
            "Team standup",
            "Bug repro",
            "STANDUP notes"
        ]);
        // The two filters compose.
        assert_eq!(matching(RecordingsTab::Instant, " STAND "), ["STANDUP notes"]);
        assert!(matching(RecordingsTab::Studio, "repro").is_empty());
    }

    /// `visibleRecordings()` / `hasMoreRecordings()` / the Load more step.
    #[test]
    fn pagination_pages_by_twenty_and_a_search_shows_everything() {
        assert_eq!(RECORDINGS_PAGE_SIZE, 20);

        // No search: capped at the visible count, with more to load.
        assert_eq!(visible_recordings_len(53, false, 20), 20);
        assert!(has_more_recordings(53, false, 20));
        assert_eq!(load_more_count(20, 53), 40);
        assert_eq!(visible_recordings_len(53, false, 40), 40);
        // The last page is short, and the button goes away with it.
        assert_eq!(load_more_count(40, 53), 53);
        assert_eq!(visible_recordings_len(53, false, 53), 53);
        assert!(!has_more_recordings(53, false, 53));
        // Fewer matches than a page.
        assert_eq!(visible_recordings_len(7, false, 20), 7);
        assert!(!has_more_recordings(7, false, 20));

        // An active search is never paginated.
        assert_eq!(visible_recordings_len(53, true, 20), 53);
        assert!(!has_more_recordings(53, true, 20));
    }

    /// `emptyMessage()`.
    #[test]
    fn the_empty_message_names_the_tab_and_the_search() {
        assert_eq!(
            recordings_empty_message(RecordingsTab::All, ""),
            "No recordings"
        );
        assert_eq!(
            recordings_empty_message(RecordingsTab::Studio, ""),
            "No studio recordings"
        );
        assert_eq!(
            recordings_empty_message(RecordingsTab::Instant, ""),
            "No instant recordings"
        );
        assert_eq!(
            recordings_empty_message(RecordingsTab::Instant, "demo"),
            "No matching instant recordings"
        );
        assert_eq!(
            recordings_empty_message(RecordingsTab::All, "demo"),
            "No matching recordings"
        );
    }

    /// The tab strip, and the ids `emptyMessage()` interpolates.
    #[test]
    fn the_three_tabs_are_all_instant_studio() {
        let ids: Vec<&str> = RecordingsTab::ALL.iter().map(|tab| tab.id()).collect();
        assert_eq!(ids, ["all", "instant", "studio"]);
        let labels: Vec<&str> = RecordingsTab::ALL.iter().map(|tab| tab.label()).collect();
        assert_eq!(labels, ["Show all", "Instant", "Studio"]);
        assert_eq!(RecordingsTab::All.icon(), None, "Show all has no glyph");
        assert_eq!(RecordingsTab::Studio.icon(), Some("icons/film-cut.svg"));
        assert_eq!(RecordingsTab::Instant.icon(), Some("icons/instant.svg"));
    }

    #[test]
    fn the_preview_substitutes_the_documented_placeholders() {
        let preview = format_project_name(DEFAULT_PROJECT_NAME_TEMPLATE);
        assert!(preview.starts_with("Safari (Window) "));
        assert!(preview.ends_with(" 09:41 AM"));
        // An unknown placeholder survives untouched.
        assert_eq!(format_project_name("{nope}"), "{nope}");
    }
}
