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

use std::{cell::Cell, rc::Rc};

use gpui::{
    Bounds, Context, FocusHandle, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    ParentElement, Pixels, Point, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    canvas, div, img, prelude::FluentBuilder, px, rgb, svg,
};
use serde_json::Value;

use crate::{
    devices::WindowOption,
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
/// mirror here.
pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(22.),
    y: px(22.),
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
    /// Where the click landed: `Menu.popup()` with no position argument opens
    /// at the pointer, so this is the faithful anchor.
    origin: Point<Pixels>,
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

/// Which text field has focus, so one key handler can serve both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    ProjectName,
    ServerUrl,
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
    project_name_focus: FocusHandle,
    server_url_focus: FocusHandle,
    /// `Collapsible` under the project-name input.
    placeholders_open: bool,
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
            project_name_focus: cx.focus_handle(),
            server_url_focus: cx.focus_handle(),
            placeholders_open: false,
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
    pub fn set_page(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        self.menu = None;
        // The store may have changed under us while the window was in the
        // background (the Tauri app writing, or a recording updating a
        // window position).
        self.settings = GeneralSettings::load();
        cx.notify();
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

    // -- Menus -------------------------------------------------------------

    fn open_menu(&mut self, kind: MenuKind, origin: Point<Pixels>, cx: &mut Context<Self>) {
        self.menu = Some(OpenMenu { kind, origin });
        cx.notify();
    }

    /// (label, checked) for each row of an open menu.
    fn menu_items(&self, kind: MenuKind) -> Vec<(SharedString, bool)> {
        match kind {
            MenuKind::Countdown => {
                let current = self.settings.recording_countdown.unwrap_or(0);
                COUNTDOWN_OPTIONS
                    .iter()
                    .map(|(value, label)| ((*label).into(), *value == current))
                    .collect()
            }
            MenuKind::MaxFps => MAX_FPS_OPTIONS
                .iter()
                .map(|(value, label)| ((*label).into(), *value == self.settings.max_fps))
                .collect(),
            MenuKind::MainWindowStart => {
                enum_items(self.settings.main_window_recording_start_behaviour)
            }
            MenuKind::PostStudio => enum_items(self.settings.post_studio_recording_behaviour),
            MenuKind::PostDeletion => enum_items(self.settings.post_deletion_behaviour),
            MenuKind::AddWindow => self
                .available_windows()
                .into_iter()
                .map(|window| (window_option_label(&window).into(), false))
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

fn enum_items<T: SettingsEnum>(current: T) -> Vec<(SharedString, bool)> {
    T::ALL
        .iter()
        .map(|value| (value.label().into(), *value == current))
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
            .on_key_down(cx.listener(|_, event: &gpui::KeyDownEvent, _window, cx| {
                let keystroke = &event.keystroke;
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
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.page = page;
                        this.menu = None;
                        cx.notify();
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
                    ButtonVariant::Dark,
                    None,
                    "Sign In",
                    false,
                    cx,
                    |_, _, _| {},
                )
                .w_full()
                .h(px(34.)),
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
                        .map(|(value, label, _)| (SharedString::from(*label), *value == effective))
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
                ButtonVariant::Gray,
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
            ButtonVariant::Dark,
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
    fn render_project_name(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
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
                ButtonVariant::Gray,
                None,
                "Reset",
                reset_disabled,
                cx,
                |this, _window, cx| {
                    this.settings.default_project_name_template = None;
                    this.project_name = DEFAULT_PROJECT_NAME_TEMPLATE.to_string();
                    this.write("defaultProjectNameTemplate", Value::Null, cx);
                },
            ))
            .child(self.button(
                "project-name-save",
                ButtonVariant::Dark,
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
                .child(self.text_field(
                    Field::ProjectName,
                    &self.project_name,
                    &self.project_name_focus,
                    window,
                    cx,
                ))
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
                            this.placeholders_open = !this.placeholders_open;
                            cx.notify();
                        })),
                )
                .when(self.placeholders_open, |this| {
                    this.child(
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
                    )
                });

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
                ButtonVariant::Gray,
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
                    ButtonVariant::Dark,
                    Some("icons/plus.svg"),
                    "Add",
                    self.windows.is_empty(),
                    cx,
                    |_, _, _| {},
                )
                .on_click(cx.listener(
                    |this, event: &gpui::ClickEvent, _window, cx| {
                        if !this.windows.is_empty() {
                            this.open_menu(MenuKind::AddWindow, event.position(), cx);
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
                        ButtonVariant::Gray,
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
    fn render_self_host(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
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
                    .child(self.text_field(
                        Field::ServerUrl,
                        &self.server_url,
                        &self.server_url_focus,
                        window,
                        cx,
                    )),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_end()
                    .gap(px(8.))
                    .child(self.button(
                        "server-url-reset",
                        ButtonVariant::Gray,
                        None,
                        "Reset to Default",
                        stored == DEFAULT_SERVER_URL && draft == DEFAULT_SERVER_URL,
                        cx,
                        |this, window, cx| {
                            if this.settings.server_url == DEFAULT_SERVER_URL {
                                this.server_url = DEFAULT_SERVER_URL.to_string();
                                cx.notify();
                                return;
                            }
                            this.confirm_server_url(DEFAULT_SERVER_URL.to_string(), window, cx);
                        },
                    ))
                    .child(self.button(
                        "server-url-update",
                        ButtonVariant::Dark,
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
    ) -> Section {
        Section {
            theme: self.theme,
            title,
            description,
            right,
            children,
            pro: false,
        }
    }

    /// `<SectionCard>`: `rounded-xl border border-gray-3 bg-gray-2`, whose
    /// radius the settings material takes down to 10px and whose border it
    /// makes transparent.
    fn card(&self, padded: bool) -> gpui::Div {
        div()
            .rounded(px(10.))
            .overflow_hidden()
            .bg(self.theme.settings_card_bg())
            .when(padded, |this| this.px(px(16.)).py(px(16.)))
    }

    /// `<SectionRows>`: the same card with `divide-y divide-gray-3`.
    fn rows(&self, children: Vec<gpui::AnyElement>) -> gpui::Div {
        let border = self.theme.settings_border();
        let last = children.len().saturating_sub(1);
        self.card(false)
            .flex()
            .flex_col()
            .children(children.into_iter().enumerate().map(|(index, child)| {
                div()
                    .when(index != last, |this| this.border_b_1().border_color(border))
                    .child(child)
            }))
    }

    /// `<SettingItem>` / `.cap-setting-row { min-height: 46px; padding: 12px }`
    /// over `flex flex-row gap-4 justify-between items-center`.
    fn setting_row(
        &self,
        label: &'static str,
        description: Option<&'static str>,
        control: gpui::AnyElement,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(16.))
            .min_h(px(46.))
            .p(px(12.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(2.))
                    .child(div().text_size(px(13.)).child(label))
                    .children(description.map(|description| {
                        div()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .text_color(theme.settings_muted())
                            .child(description)
                    })),
            )
            .child(div().flex().items_center().flex_shrink_0().child(control))
            .into_any_element()
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

    /// `<Toggle size="sm">`: `w-9 h-5 p-0.5` with a `size-4` thumb, on
    /// `--macos-settings-accent` when checked and
    /// `--macos-settings-control-fill` when not. The `inset 0 1px 2px` shadow
    /// the settings CSS puts on the track has no gpui equivalent.
    fn toggle(
        &self,
        id: &'static str,
        checked: bool,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(SharedString::from(id))
            .w(px(36.))
            .h(px(20.))
            .p(px(2.))
            .rounded_full()
            .flex()
            .flex_row()
            .when(checked, |this| this.justify_end())
            .bg(if checked {
                rgb(Theme::SETTINGS_ACCENT).into()
            } else {
                theme
                    .material
                    .map(|material| Hsla::from(material.control_fill))
                    .unwrap_or_else(|| Hsla::from(theme.gray_6))
            })
            .child(div().size(px(16.)).rounded_full().bg(gpui::white()))
            .on_click(cx.listener(move |this, _, _window, cx| on_change(this, cx)))
    }

    /// `SelectSettingItem`'s button: `flex flex-row gap-1.5 text-xs items-center
    /// px-2.5 py-1.5 rounded-lg border bg-gray-3 text-gray-12 border-gray-4`,
    /// radius 8 under the settings material.
    fn select(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        kind: MenuKind,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(SharedString::from(id))
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(6.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_fill())
            .text_size(px(12.))
            .child(label.into())
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(px(14.))
                    .flex_shrink_0()
                    .text_color(theme.settings_muted()),
            )
            .on_click(
                cx.listener(move |this, event: &gpui::ClickEvent, _window, cx| {
                    this.open_menu(kind, event.position(), cx);
                }),
            )
    }

    /// `SegmentedControl` over a [`SettingsEnum`].
    fn segmented<T: SettingsEnum>(
        &self,
        id: &'static str,
        current: T,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, T, &mut Context<Self>) + Clone + 'static,
    ) -> gpui::Div {
        self.segmented_raw(
            id,
            T::ALL
                .iter()
                .map(|value| (SharedString::from(value.label()), *value == current))
                .collect(),
            cx,
            move |this, index, cx| {
                if let Some(value) = T::ALL.get(index) {
                    on_change(this, *value, cx);
                }
            },
        )
    }

    /// `<div class="inline-flex p-0.5 rounded-lg border border-gray-3
    /// bg-gray-3">` with `px-3 py-1 text-xs font-medium rounded-md` items; the
    /// selected one is `bg-gray-1 text-gray-12 shadow-sm`, which the settings
    /// material leaves alone (`bg-gray-1` is not in its remap list).
    fn segmented_raw(
        &self,
        id: &'static str,
        options: Vec<(SharedString, bool)>,
        cx: &mut Context<Self>,
        on_change: impl Fn(&mut Self, usize, &mut Context<Self>) + Clone + 'static,
    ) -> gpui::Div {
        let theme = self.theme;
        div()
            .flex()
            .flex_row()
            .p(px(2.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.settings_border())
            .bg(theme.settings_fill())
            .children(
                options
                    .into_iter()
                    .enumerate()
                    .map(|(index, (label, selected))| {
                        let on_change = on_change.clone();
                        div()
                            .id(SharedString::from(format!("{id}-{index}")))
                            .px(px(12.))
                            .py(px(4.))
                            .rounded(px(6.))
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .when(selected, |this| {
                                this.bg(Hsla::from(theme.gray_1))
                                    .text_color(theme.settings_text())
                            })
                            .when(!selected, |this| this.text_color(theme.settings_muted()))
                            .child(label)
                            .on_click(
                                cx.listener(move |this, _, _window, cx| on_change(this, index, cx)),
                            )
                    }),
            )
    }

    /// `<Button size="sm">` under the settings material: radius 8, `h-7 px-3
    /// text-xs`, gray/white/outline on `--macos-settings-control-fill` with a
    /// `--macos-settings-border` hairline, primary/blue/dark on the accent.
    fn button(
        &self,
        id: &'static str,
        variant: ButtonVariant,
        icon: Option<&'static str>,
        label: &'static str,
        disabled: bool,
        cx: &mut Context<Self>,
        on_click: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        let control_fill = theme
            .material
            .map(|material| Hsla::from(material.control_fill))
            .unwrap_or_else(|| Hsla::from(theme.gray_5));

        div()
            .id(SharedString::from(id))
            .flex()
            .items_center()
            .justify_center()
            .h(px(28.))
            .px(px(12.))
            .rounded(px(8.))
            .text_size(px(12.))
            .flex_shrink_0()
            .map(|this| match (variant, disabled) {
                // `button[data-variant]:disabled { color:
                //  var(--macos-settings-muted); background:
                //  var(--macos-settings-fill) }`
                (_, true) => this
                    .bg(theme.settings_fill())
                    .text_color(theme.settings_muted()),
                (ButtonVariant::Gray, false) => this
                    .bg(control_fill)
                    .text_color(theme.settings_text())
                    .border_1()
                    .border_color(theme.settings_border()),
                (ButtonVariant::Dark, false) => this
                    .bg(rgb(Theme::SETTINGS_ACCENT))
                    .text_color(gpui::white()),
            })
            .flex_row()
            .gap(px(6.))
            .children(icon.map(|icon| {
                svg()
                    .path(icon)
                    .size(px(14.))
                    .flex_shrink_0()
                    .text_color(if disabled {
                        theme.settings_muted()
                    } else if variant == ButtonVariant::Dark {
                        gpui::white()
                    } else {
                        theme.settings_text()
                    })
            }))
            .child(label)
            .when(!disabled, |this| {
                this.on_click(cx.listener(move |this, _, window, cx| on_click(this, window, cx)))
            })
    }

    /// The hand-rolled text input, same shape as the main window's search
    /// field: focus tracking, `key_char` for the typed character, a static
    /// caret. `<Input>` in the editor's `ui.tsx` is `h-8 rounded-lg bg-gray-2
    /// px-2 text-xs`.
    fn text_field(
        &self,
        field: Field,
        value: &str,
        focus: &FocusHandle,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let theme = self.theme;
        let value = value.to_string();
        let empty = value.is_empty();
        // The caret is drawn only while the field has focus -- there are two
        // of them on the page and a pair of blinkless bars would read as two
        // active inputs.
        let focused = focus.is_focused(window);

        div()
            .track_focus(focus)
            .on_key_down(
                cx.listener(move |this, event: &gpui::KeyDownEvent, _window, cx| {
                    let keystroke = &event.keystroke;
                    // Cmd-anything is a shortcut (Cmd-W closes the window from
                    // the root handler), never text.
                    if keystroke.modifiers.platform || keystroke.modifiers.control {
                        return;
                    }
                    let draft = match field {
                        Field::ProjectName => &mut this.project_name,
                        Field::ServerUrl => &mut this.server_url,
                    };
                    match keystroke.key.as_str() {
                        "backspace" => {
                            draft.pop();
                        }
                        "escape" => {
                            // Revert to what is stored, the way leaving the
                            // field without saving does.
                            *draft = match field {
                                Field::ProjectName => this
                                    .settings
                                    .default_project_name_template
                                    .clone()
                                    .unwrap_or_else(|| DEFAULT_PROJECT_NAME_TEMPLATE.to_string()),
                                Field::ServerUrl => this.settings.server_url.clone(),
                            };
                        }
                        _ => {
                            if let Some(text) = keystroke.key_char.as_ref()
                                && !text.is_empty()
                                && !text.chars().any(char::is_control)
                            {
                                draft.push_str(text);
                            } else {
                                return;
                            }
                        }
                    }
                    cx.notify();
                }),
            )
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.))
            .h(px(32.))
            .px(px(8.))
            .rounded(px(8.))
            .bg(theme.settings_fill())
            .border_1()
            .border_color(theme.settings_border())
            .text_size(px(12.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .when(empty, |this| this.text_color(theme.settings_muted()))
                    .child(value),
            )
            .when(focused, |this| {
                this.child(
                    div()
                        .w(px(1.))
                        .h(px(14.))
                        .flex_shrink_0()
                        .bg(theme.settings_text()),
                )
            })
    }

    /// `<Slider minValue={1} maxValue={4.5} step={0.1}>`: a `h-[0.3rem]`
    /// `bg-gray-4` track with a `bg-blue-9` fill and a `size-4` thumb.
    fn render_zoom_slider(&self, value: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let fraction = ((value - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)).clamp(0., 1.);
        let track = self.slider_track.clone();

        div()
            .id("zoom-slider")
            .flex_1()
            .min_w_0()
            .h(px(16.))
            .flex()
            .flex_row()
            .items_center()
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(5.))
                    .rounded_full()
                    .bg(theme.settings_fill())
                    .child(
                        // Captures the track's rect for the drag maths: the
                        // row sits in a resizable pane, so its width is not
                        // known here.
                        canvas(
                            move |bounds, _window, _cx| track.set(Some(bounds)),
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .size_full(),
                    )
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .top_0()
                            .h_full()
                            .w(gpui::relative(fraction))
                            .rounded_full()
                            .bg(Hsla::from(theme.blue_9)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top(px(-6.))
                            .left(gpui::relative(fraction))
                            .ml(px(-8.))
                            .size(px(16.))
                            .rounded_full()
                            .bg(if theme.is_dark() {
                                Hsla::from(theme.gray_12)
                            } else {
                                Hsla::from(theme.gray_1)
                            })
                            .border_1()
                            .border_color(theme.settings_border()),
                    ),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, _window, cx| {
                    this.slider_dragging = true;
                    this.set_zoom_from(event.position, cx);
                }),
            )
    }

    /// While the button is held the whole window takes the mouse, so a drag
    /// that leaves the 164px track keeps updating -- what `KSlider` gets from
    /// pointer capture.
    fn render_slider_drag_layer(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        if !self.slider_dragging {
            return None;
        }
        Some(
            div()
                .id("zoom-slider-drag")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .on_mouse_move(
                    cx.listener(|this, event: &gpui::MouseMoveEvent, _window, cx| {
                        this.set_zoom_from(event.position, cx);
                    }),
                )
                .on_mouse_up(
                    MouseButton::Left,
                    cx.listener(|this, _, _window, cx| {
                        this.slider_dragging = false;
                        // `onChangeEnd` -- the store write happens once, at the
                        // end of the drag.
                        let value = this.settings.default_zoom_amount.unwrap_or(1.5);
                        this.write(
                            "defaultZoomAmount",
                            Value::from(f64::from((value * 10.).round() / 10.)),
                            cx,
                        );
                    }),
                )
                .into_any_element(),
        )
    }

    fn set_zoom_from(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let Some(track) = self.slider_track.get() else {
            return;
        };
        let width = f32::from(track.size.width);
        if width <= 0. {
            return;
        }
        let fraction = ((f32::from(position.x) - f32::from(track.origin.x)) / width).clamp(0., 1.);
        // `step={0.1}`
        let value = ((ZOOM_MIN + fraction * (ZOOM_MAX - ZOOM_MIN)) * 10.).round() / 10.;
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
        Some(self.render_menu_at(kind, items, menu.origin, cx))
    }

    fn render_menu_at(
        &self,
        kind: MenuKind,
        items: Vec<(SharedString, bool)>,
        origin: Point<Pixels>,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let theme = self.theme;
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .child(
                // Click-away dismiss, the way a native menu closes.
                div()
                    .id("menu-backdrop")
                    .absolute()
                    .top_0()
                    .left_0()
                    .size_full()
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.menu = None;
                        cx.notify();
                    })),
            )
            .child(
                div()
                    .id("menu")
                    .absolute()
                    .left(origin.x)
                    .top(origin.y)
                    .flex()
                    .flex_col()
                    .min_w(px(180.))
                    .max_h(px(320.))
                    .overflow_y_scroll()
                    .p(px(4.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(theme.settings_border())
                    .bg(theme.settings_card_bg())
                    .text_size(px(12.))
                    .children(
                        items
                            .into_iter()
                            .enumerate()
                            .map(|(index, (label, checked))| {
                                div()
                                    .id(SharedString::from(format!("menu-item-{index}")))
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(6.))
                                    .h(px(24.))
                                    .px(px(6.))
                                    .rounded(px(4.))
                                    .hover(|style| style.bg(theme.settings_hover()))
                                    .child(div().w(px(12.)).flex_shrink_0().children(checked.then(
                                        || {
                                            svg()
                                                .path("icons/check.svg")
                                                .size(px(12.))
                                                .text_color(theme.settings_text())
                                        },
                                    )))
                                    .child(div().flex_1().min_w_0().truncate().child(label))
                                    .on_click(cx.listener(move |this, _, _window, cx| {
                                        this.choose(kind, index, cx);
                                    }))
                            }),
                    ),
            )
            .into_any_element()
    }
}

/// `minValue={1} maxValue={4.5}` on the zoom slider.
const ZOOM_MIN: f32 = 1.;
const ZOOM_MAX: f32 = 4.5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ButtonVariant {
    /// `variant="gray"`.
    Gray,
    /// `variant="dark"` and `variant="primary"`, which the settings material
    /// paints identically (the accent).
    Dark,
}

/// The `<Section>` element, split out so `pro()` can be chained the way the
/// TSX passes `pro`.
struct Section {
    theme: Theme,
    title: &'static str,
    description: Option<&'static str>,
    right: Option<gpui::AnyElement>,
    children: Vec<gpui::AnyElement>,
    pro: bool,
}

impl Section {
    fn pro(mut self) -> Self {
        self.pro = true;
        self
    }
}

impl IntoElement for Section {
    type Element = gpui::Div;

    fn into_element(self) -> Self::Element {
        let theme = self.theme;
        div()
            .flex()
            .flex_col()
            // `space-y-2.5`
            .gap(px(10.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .items_end()
                    .gap(px(12.))
                    .px(px(4.))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .min_w_0()
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(14.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .child(self.title),
                                    )
                                    .when(self.pro, |this| {
                                        // `text-[10px] font-medium uppercase
                                        //  tracking-wide px-1.5 py-0.5
                                        //  rounded-md bg-blue-9 text-white`
                                        this.child(
                                            div()
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded(px(6.))
                                                .bg(Hsla::from(theme.blue_9))
                                                .text_size(px(10.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(gpui::white())
                                                .child("PRO"),
                                        )
                                    }),
                            )
                            .children(self.description.map(|description| {
                                div()
                                    .text_size(px(12.))
                                    .line_height(px(18.))
                                    .text_color(theme.settings_muted())
                                    .child(description)
                            })),
                    )
                    .children(self.right),
            )
            .children(self.children)
    }
}

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

    #[test]
    fn the_preview_substitutes_the_documented_placeholders() {
        let preview = format_project_name(DEFAULT_PROJECT_NAME_TEMPLATE);
        assert!(preview.starts_with("Safari (Window) "));
        assert!(preview.ends_with(" 09:41 AM"));
        // An unknown placeholder survives untouched.
        assert_eq!(format_project_name("{nope}"), "{nope}");
    }
}
