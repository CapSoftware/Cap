//! The main recording window.
//!
//! Every metric here is transcribed from the Tauri implementation
//! (`apps/desktop/src/routes/(window-chrome)/new-main/index.tsx` and its
//! siblings) so the two windows are pixel-comparable. Tailwind classes are
//! quoted next to the values they turn into, because `pl-3` and `gap-2.5` are
//! considerably easier to check against the original than `12.` and `10.`.

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    AppContext as _, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Window, div, img,
    prelude::FluentBuilder, px, rgb, svg,
};
use std::{cell::Cell, rc::Rc};

use crate::{
    MAIN_WINDOW_HEIGHT, MAIN_WINDOW_WIDTH, app_windows, devices,
    devices::{CameraOption, DeviceSnapshot, DisplayOption, MicrophoneOption, WindowOption},
    feeds::{self, Feeds},
    library::{self, MediaKind, RecentItem, RecordingItem, ScreenshotItem},
    recording,
    session::{Phase, RecordingSession},
    settings_window::Page,
    target_thumbnails,
    theme::Theme,
    ui,
};
use gpui::{Entity, Task};

const EXPANDED_WIDTH: f32 = 600.;
const EXPANDED_HEIGHT: f32 = 672.;

/// `duration: 180` in `resizeMainWindow`.
const RESIZE_DURATION_SECS: f32 = 0.18;

/// `h-9` on `.cap-window-header`.
const HEADER_HEIGHT: f32 = 36.;

/// `h-28 w-[196px]` on `RecentCard`.
const RECENT_CARD_WIDTH: f32 = 196.;
const RECENT_CARD_HEIGHT: f32 = 112.;
/// `h-[42px]` in deviceRowStyles.ts.
const DEVICE_ROW_HEIGHT: f32 = 42.;

fn remembered_camera(id: &recording::DeviceOrModelID, cameras: &[CameraOption]) -> CameraOption {
    cameras
        .iter()
        .find(|camera| match id {
            recording::DeviceOrModelID::DeviceID(id) => camera.device_id == *id,
            recording::DeviceOrModelID::ModelID(model) => camera.model_id.as_ref() == Some(model),
        })
        .cloned()
        .unwrap_or_else(|| CameraOption {
            device_id: match id {
                recording::DeviceOrModelID::DeviceID(id) => id.clone(),
                recording::DeviceOrModelID::ModelID(_) => String::new(),
            },
            model_id: match id {
                recording::DeviceOrModelID::ModelID(model) => Some(model.clone()),
                recording::DeviceOrModelID::DeviceID(_) => None,
            },
            label: "Camera".to_string(),
            best_format: None,
            formats: Vec::new(),
        })
}

fn remembered_microphone(name: &str, microphones: &[MicrophoneOption]) -> MicrophoneOption {
    microphones
        .iter()
        .find(|microphone| microphone.name == name)
        .cloned()
        .unwrap_or_else(|| MicrophoneOption {
            name: name.to_string(),
            sample_rate: None,
            channels: None,
        })
}

fn take_pending_recording_inputs(
    pending: &mut crate::store::RecordingInputSettings,
    enumerating: bool,
    suspended: bool,
) -> Option<crate::store::RecordingInputSettings> {
    if enumerating || suspended || pending.camera_id.is_none() && pending.microphone_name.is_none()
    {
        return None;
    }
    Some(std::mem::take(pending))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Instant,
    Studio,
    Screenshot,
}

fn effective_recording_mode(preferred: Mode, editor_recording: bool) -> Mode {
    if editor_recording {
        Mode::Studio
    } else {
        preferred
    }
}

impl Mode {
    /// `cap_recording::RecordingMode`'s serialized spelling -- the value the
    /// store's `recording_settings.mode` holds, shared with the Tauri app.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Instant => "instant",
            Self::Studio => "studio",
            Self::Screenshot => "screenshot",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Self> {
        match slug {
            "instant" => Some(Self::Instant),
            "studio" => Some(Self::Studio),
            "screenshot" => Some(Self::Screenshot),
            _ => None,
        }
    }

    /// `get_current_mode` (`src-tauri/src/tray.rs:355-361`): the stored mode,
    /// falling back to `RecordingMode::default()`, which is Instant.
    pub fn from_store() -> Self {
        crate::store::recording_mode_slug()
            .as_deref()
            .and_then(Self::from_slug)
            .unwrap_or(Self::Instant)
    }

    pub fn icon(self) -> &'static str {
        match self {
            Self::Instant => "icons/instant.svg",
            Self::Studio => "icons/film-cut.svg",
            Self::Screenshot => "icons/screenshot.svg",
        }
    }

    /// `size-4` for instant, `size-[0.9rem]` for the other two.
    fn icon_size(self) -> f32 {
        match self {
            Self::Instant => 16.,
            Self::Studio | Self::Screenshot => 14.4,
        }
    }

    /// `ModeInfoPanel`'s `modeOptions`, which is *not* `MODE_BUTTONS` -- the
    /// hover cards and the info panel describe the modes differently and the
    /// app carries both sets of strings.
    pub fn panel_title(self) -> &'static str {
        match self {
            Self::Instant => "Instant",
            Self::Studio => "Studio",
            Self::Screenshot => "Screenshot",
        }
    }

    fn panel_description(self) -> &'static str {
        match self {
            Self::Instant => {
                "Share instantly with a link. Your recording uploads as you record, so you \
                 can share it immediately when you're done."
            }
            Self::Studio => {
                "Record locally in the highest quality for editing later. Perfect for \
                 creating polished content with effects and transitions."
            }
            Self::Screenshot => {
                "Capture and annotate screenshots instantly. Great for quick captures, bug \
                 reports, and visual communication."
            }
        }
    }
}

fn capture_hover_fill(theme: Theme, selected: bool, chevron: bool) -> Hsla {
    if selected {
        if chevron {
            Theme::with_alpha(theme.blue_9, if theme.is_dark() { 0.30 } else { 0.22 })
        } else {
            theme.tile_selected_hover_bg()
        }
    } else {
        Theme::with_alpha(theme.blue_9, if chevron { 0.16 } else { 0.07 })
    }
}

#[derive(Default)]
struct ModeHoverState {
    trigger: Option<Mode>,
    card: Option<Mode>,
    visible: Option<Mode>,
}

impl ModeHoverState {
    fn target(&self) -> Option<Mode> {
        self.trigger.or(self.card)
    }

    fn update(&mut self, mode: Mode, card: bool, hovered: bool) {
        if !card && hovered && self.card != Some(mode) {
            self.card = None;
        }
        let current = if card {
            &mut self.card
        } else {
            &mut self.trigger
        };
        if hovered {
            *current = Some(mode);
        } else if *current == Some(mode) {
            *current = None;
        }
    }
}

#[derive(IntoElement)]
struct ModeHoverCard {
    mode: Mode,
    theme: Theme,
}

impl gpui::RenderOnce for ModeHoverCard {
    fn render(self, _window: &mut Window, _cx: &mut gpui::App) -> impl IntoElement {
        let theme = self.theme;
        let mode = self.mode;
        let description = match mode {
            Mode::Instant => {
                "No rendering required — uploads on the fly so you can share the link the moment you stop."
            }
            Mode::Studio => {
                "Records at the highest quality for local rendering later. Opens the Cap editor when you're done."
            }
            Mode::Screenshot => "Capture and annotate stills.",
        };
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .w(px(240.))
            .px(px(12.))
            .py(px(10.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.gray_3)
            .bg(theme.gray_12)
            .text_color(theme.gray_1)
            .shadow_lg()
            .child(
                div()
                    .text_size(px(12.))
                    .child(format!("{} mode", mode.panel_title())),
            )
            .child(
                div()
                    .text_size(px(10.))
                    .line_height(px(13.75))
                    .text_color(theme.gray_4)
                    .child(description),
            )
            .when(mode != Mode::Screenshot, |this| {
                this.child(
                    div()
                        .id("mode-quality-settings")
                        .group("mode-quality-settings")
                        .tab_index(0)
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .mx(px(-4.))
                        .px(px(8.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .text_size(px(11.))
                        .text_color(theme.gray_4)
                        .hover(|style| style.bg(theme.gray_11).text_color(theme.gray_1))
                        .child(
                            svg()
                                .path("icons/settings.svg")
                                .size(px(12.))
                                .text_color(theme.gray_4)
                                .group_hover("mode-quality-settings", |style| {
                                    style.text_color(theme.gray_1)
                                }),
                        )
                        .child("Quality settings")
                        .on_click(move |_, _, cx| {
                            cx.stop_propagation();
                            cx.defer(move |cx| app_windows::open_quality_settings(mode, cx));
                        }),
                )
            })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetType {
    Display,
    Window,
    Area,
    CameraOnly,
}

impl TargetType {
    fn label(self) -> &'static str {
        match self {
            Self::Display => "Display",
            Self::Window => "Window",
            Self::Area => "Area",
            Self::CameraOnly => "Camera Only",
        }
    }

    /// Shown only when expanded.
    fn description(self) -> &'static str {
        match self {
            Self::Display => "Entire screen",
            Self::Window => "One app",
            Self::Area => "Custom region",
            Self::CameraOnly => "No screen",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Display => "icons/screen.svg",
            Self::Window => "icons/window.svg",
            Self::Area => "icons/area.svg",
            Self::CameraOnly => "icons/camera.svg",
        }
    }
}

/// Which device picker has taken over the window body, if any.
///
/// Clicking a device row does not open a popup in the Tauri app either: it
/// swaps the whole body for a full-height panel and offers a Back button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceMenu {
    Camera,
    Microphone,
}

#[derive(Clone, Debug, PartialEq)]
enum DeviceFormatTarget {
    Camera(CameraOption),
    Microphone(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum DeviceFormat {
    Camera(cap_recording::feeds::camera::CameraDeviceSettings),
    Microphone(cap_recording::feeds::microphone::MicrophoneDeviceSettings),
}

impl DeviceFormat {
    fn label(self) -> String {
        match self {
            Self::Camera(settings) => {
                match (settings.width, settings.height, settings.frame_rate) {
                    (Some(width), Some(height), Some(rate)) => {
                        format!("{width}×{height} @ {rate:.0}fps")
                    }
                    _ => "Default".into(),
                }
            }
            Self::Microphone(settings) => match (settings.sample_rate, settings.channels) {
                (Some(rate), Some(channels)) => {
                    let channels = match channels {
                        1 => "Mono".into(),
                        2 => "Stereo".into(),
                        count => format!("{count} channels"),
                    };
                    format!("{}kHz {channels}", rate as f32 / 1000.)
                }
                _ => "Default".into(),
            },
        }
    }
}

struct PendingDeviceFormat {
    target: DeviceFormatTarget,
    format: DeviceFormat,
    epoch: u64,
}

fn complete_format_request(
    pending: &mut Option<PendingDeviceFormat>,
    result: Option<Result<(), String>>,
    still_owned: bool,
    save: impl FnOnce(&DeviceFormatTarget, DeviceFormat) -> bool,
) -> Option<Result<DeviceFormat, String>> {
    let result = result?;
    let pending = pending.take()?;
    if !still_owned {
        return None;
    }
    Some(result.and_then(|()| {
        if save(&pending.target, pending.format) {
            Ok(pending.format)
        } else {
            Err("Could not save the device format preference. Try again.".to_string())
        }
    }))
}

fn save_device_format(target: &DeviceFormatTarget, format: DeviceFormat) -> bool {
    match (target, format) {
        (DeviceFormatTarget::Camera(camera), DeviceFormat::Camera(settings)) => {
            crate::store::set_camera_device_settings(
                &camera.device_id,
                camera.model_id.as_ref(),
                settings,
            )
        }
        (DeviceFormatTarget::Microphone(name), DeviceFormat::Microphone(settings)) => {
            crate::store::set_microphone_device_settings(name, settings)
        }
        _ => false,
    }
}

impl DeviceMenu {
    fn title(self) -> &'static str {
        match self {
            Self::Camera => "Camera",
            Self::Microphone => "Microphone",
        }
    }

    fn none_label(self) -> &'static str {
        match self {
            Self::Camera => "No Camera",
            Self::Microphone => "No Microphone",
        }
    }

    fn icon(self) -> &'static str {
        match self {
            Self::Camera => "icons/camera.svg",
            Self::Microphone => "icons/microphone.svg",
        }
    }

    fn empty_message(self, searching: bool) -> &'static str {
        match (self, searching) {
            (Self::Camera, false) => "No cameras found",
            (Self::Camera, true) => "No matching cameras",
            (Self::Microphone, false) => "No microphones found",
            (Self::Microphone, true) => "No matching microphones",
        }
    }
}

/// Whatever has taken over the window body in place of the home screen.
///
/// The Tauri app opens some of these as separate windows (mode info is the
/// 580x340 ModeSelect window) and some as in-place panels. There is only one
/// window here, so they are all panels; the ones that differ are called out
/// in the README's deviations table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Panel {
    /// Pick a camera or a microphone.
    Device(DeviceMenu),
    /// Pick which display or which window to capture.
    Target(TargetType),
    /// What the three recording modes do.
    ModeInfo,
    /// The header recordings / screenshots library.
    Library(LibraryKind),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LibraryKind {
    Recordings,
    Screenshots,
}

impl LibraryKind {
    fn settings_page(self) -> Page {
        match self {
            Self::Recordings => Page::Recordings,
            Self::Screenshots => Page::Screenshots,
        }
    }

    fn import_label(self) -> &'static str {
        match self {
            Self::Recordings => "Import",
            Self::Screenshots => "Import image",
        }
    }

    fn empty_title(self) -> &'static str {
        match self {
            Self::Recordings => "No recordings yet",
            Self::Screenshots => "No screenshots yet",
        }
    }

    fn empty_description(self) -> &'static str {
        match self {
            Self::Recordings => {
                "Your screen recordings will appear here. Start recording to get started!"
            }
            Self::Screenshots => {
                "Your screenshots will appear here. Take a screenshot to get started!"
            }
        }
    }

    fn empty_icon(self) -> &'static str {
        match self {
            Self::Recordings => "icons/square-play.svg",
            Self::Screenshots => "icons/image.svg",
        }
    }

    fn view_all_label(self) -> &'static str {
        match self {
            Self::Recordings => "View All Recordings",
            Self::Screenshots => "View All Screenshots",
        }
    }

    fn no_match(self) -> &'static str {
        match self {
            Self::Recordings => "No matching recordings",
            Self::Screenshots => "No matching screenshots",
        }
    }
}

enum LibraryItems {
    Recordings(Vec<LibraryRow<RecordingItem>>),
    Screenshots(Vec<LibraryRow<ScreenshotItem>>),
}

struct LibraryRow<T> {
    item: T,
    thumbnail: Option<std::sync::Arc<gpui::RenderImage>>,
}

#[derive(Clone)]
pub(crate) struct RecordingStartPermit(std::rc::Rc<std::cell::Cell<bool>>);

impl RecordingStartPermit {
    fn prepare(phase: Phase, clean_capture_owned: bool, preparing: bool) -> Result<Self, String> {
        if phase != Phase::Idle || clean_capture_owned || preparing {
            return Err("Another recording or recording preparation owns the inputs".into());
        }
        Ok(Self(std::rc::Rc::new(std::cell::Cell::new(true))))
    }

    fn allows(&self, phase: Phase, clean_capture_owned: bool) -> bool {
        if phase != Phase::Idle || clean_capture_owned {
            self.cancel();
        }
        self.0.get()
    }

    pub(crate) fn is_current(&self, cx: &gpui::App) -> bool {
        self.allows(
            RecordingSession::global(cx).read(cx).phase,
            app_windows::clean_capture_owned(cx),
        )
    }

    pub(crate) fn cancel(&self) {
        self.0.set(false);
    }

    fn same(&self, other: &Self) -> bool {
        std::rc::Rc::ptr_eq(&self.0, &other.0)
    }

    fn cancel_current(current: &mut Option<Self>) -> bool {
        let Some(permit) = current.take() else {
            return false;
        };
        permit.cancel();
        true
    }
}

struct MicrophoneWarning {
    config: recording::StartConfig,
    permit: RecordingStartPermit,
    dont_show_again: bool,
    error: Option<String>,
}

pub struct MainWindow {
    theme: Theme,
    expanded: bool,
    mode: Mode,
    mode_hover: ModeHoverState,
    mode_hover_task: Option<Task<()>>,
    mode_hover_bounds: [Rc<Cell<Option<gpui::Bounds<gpui::Pixels>>>>; 3],
    target: Option<TargetType>,
    devices: DeviceSnapshot,
    camera: Option<CameraOption>,
    camera_id: Option<recording::DeviceOrModelID>,
    microphone: Option<MicrophoneOption>,
    microphone_level: Entity<ui::MicrophoneLevel>,
    pending_device_restore: crate::store::RecordingInputSettings,
    device_restore_suspended: bool,
    device_format_target: Option<DeviceFormatTarget>,
    device_formats: Option<Result<Vec<DeviceFormat>, String>>,
    device_format_value: Option<DeviceFormat>,
    device_format_generation: u64,
    device_format_pending: Option<PendingDeviceFormat>,
    device_format_notice: Option<String>,
    system_audio: bool,
    /// Which display/window is selected for each split target.
    selected_display: Option<DisplayOption>,
    selected_window: Option<WindowOption>,
    panel: Option<Panel>,
    /// Holds the in-flight expand/collapse animation. Dropping it cancels,
    /// which is how a second toggle mid-animation takes over cleanly.
    resize_task: Option<gpui::Task<()>>,
    /// Live filter text for the device and target panels -- a mirror of
    /// `search_input`'s value, kept as a plain `String` because every list in
    /// the panel filters against it from a `&self` method.
    search: String,
    /// The real field. `ui::TextInputState` owns the caret, the selection and
    /// the clipboard; this window owns what Escape means.
    search_input: Entity<ui::TextInputState>,
    _search_events: gpui::Subscription,
    /// True until the background enumeration has reported back, so the panel can
    /// say "Loading..." rather than "No cameras found".
    enumerating: bool,
    /// The app-wide recording session; the lifecycle itself lives there so the
    /// controls bar window can drive the same recording.
    session: Entity<RecordingSession>,
    checking_storage: bool,
    deep_link_start: Option<RecordingStartPermit>,
    microphone_warning: Option<MicrophoneWarning>,
    /// The Recents scan, or `None` while the first one is in flight -- which
    /// is the query's `isLoading`, and draws the same three skeleton cards.
    recents: Option<Vec<RecentEntry>>,
    /// Holds the in-flight scan-and-decode pass. Assigning over it drops the
    /// previous one, which cancels a refresh a newer one has superseded (the
    /// same idiom as `resize_task`).
    recents_task: Option<gpui::Task<()>>,
    /// Header recordings / screenshots panel. Scanned only while that panel
    /// is open so a large library is not walked on every home paint.
    library: Option<LibraryItems>,
    library_task: Option<gpui::Task<()>>,
    incomplete_recording: Option<library::IncompleteRecordingItem>,
    recovery_error: Option<String>,
    recovery_pending: bool,
    recovery_scan_task: Option<Task<()>>,
    recovery_action_task: Option<Task<()>>,
    /// `createLicenseQuery()`'s resolution, cached: reading the store file in
    /// `render_plan_badge` would be I/O per paint. Refreshed on every Recents
    /// rescan -- the same seam that already re-reads the library on reshow,
    /// so a sign-in or license activation in Settings lands here too.
    plan: PlanBadge,
    /// Display/window thumbnails and app icons for the target cards. See
    /// `target_thumbnails::ThumbnailCache` for why this is per-view rather
    /// than an app global.
    thumbnails: target_thumbnails::ThumbnailCache,
    /// The in-flight capture sweep for each kind. Assigning over one drops the
    /// previous, which aborts its tokio task; the `*_inflight` flags on the
    /// cache are what actually stop refreshes stacking.
    display_thumbnail_task: Option<gpui::Task<()>>,
    window_thumbnail_task: Option<gpui::Task<()>>,
    /// The `staleTime: 5_000` re-read of the cheap target list that runs while
    /// a target panel is open, and nothing else. Dropped by `close_panel`.
    target_poll_task: Option<gpui::Task<()>>,
    /// `scheduleTargetListPrewarm` (`new-main/index.tsx:1897-1965`).
    prewarm_task: Option<gpui::Task<()>>,
}

/// `createLicenseQuery` (`utils/queries.ts:257-273`): pro from the auth
/// plan first, then a commercial license, then personal.
#[derive(Clone, Copy, PartialEq, Eq)]
enum PlanBadge {
    Personal,
    Pro,
    Commercial,
}

impl PlanBadge {
    fn current() -> Self {
        if crate::store::auth_snapshot().is_upgraded() {
            Self::Pro
        } else if crate::store::commercial_license().is_some() {
            Self::Commercial
        } else {
            Self::Personal
        }
    }
}

/// One `RecentMediaItem` on screen: the scanned entry, plus its thumbnail once
/// the background pass has decoded one. Missing or undecodable thumbnails stay
/// `None` and the card draws the icon fallback, which is exactly what the
/// TSX's `onError` -> `setImageAvailable(false)` does.
struct RecentEntry {
    item: RecentItem,
    thumbnail: Option<std::sync::Arc<gpui::RenderImage>>,
}

impl MainWindow {
    pub fn new(
        session: Entity<RecordingSession>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::theme::bind_window(window, cx);
        window.on_window_should_close(cx, |_, cx| {
            cx.defer(app_windows::request_close_main);
            false
        });
        cx.observe_window_activation(window, |this, window, cx| {
            if !window.is_window_active() {
                this.clear_mode_hover();
            }
            #[cfg(target_os = "windows")]
            if window.is_window_active() && !this.devices.displays.is_empty() {
                this.schedule_target_prewarm(window, cx);
            }
            cx.notify();
        })
        .detach();
        let theme = Theme::for_window(window, cx, true);
        let mut previous_phase = Phase::Idle;
        cx.observe_in(&session, window, move |this, session, window, cx| {
            let phase = session.read(cx).phase;
            if phase != Phase::Idle {
                this.cancel_deep_link_start();
                this.clear_mode_hover();
            }
            if phase == Phase::Idle && previous_phase != Phase::Idle {
                this.scan_incomplete_recordings(window, cx, std::time::Duration::ZERO);
                if let Some(notice) = session.read(cx).storage_notice.clone() {
                    let main = cx.global::<app_windows::AppWindows>().main;
                    cx.spawn(async move |_, cx| {
                        let receiver = cx.update(|cx| {
                            app_windows::show_main_window(cx);
                            cx.activate(true);
                            main.update(cx, |_, window, cx| {
                                window.prompt(
                                    gpui::PromptLevel::Warning,
                                    "Low storage",
                                    Some(&notice),
                                    &[gpui::PromptButton::cancel("OK")],
                                    cx,
                                )
                            })
                        });
                        if let Ok(receiver) = receiver {
                            let _ = receiver.await;
                        }
                    })
                    .detach();
                }
            }
            previous_phase = phase;
            cx.notify();
        })
        .detach();

        // Track the app-scoped feeds: the camera bubble's close button
        // deselects the camera there, and this window's selection has to
        // follow. Repaints are gated to what is actually visible -- the mic
        // meter notifies at ~20Hz and would otherwise repaint the home view
        // for a level bar only the microphone picker shows.
        let feeds = Feeds::global(cx);
        let microphone_level = cx.new(|cx| ui::MicrophoneLevel::new(&feeds, window, cx));
        cx.observe(&feeds, |this: &mut Self, feeds, cx| {
            let feeds = feeds.read(cx);
            let camera_id = feeds.camera.as_ref().map(|camera| &camera.id);
            let camera_changed = this.camera_id.as_ref() != camera_id;
            if camera_changed {
                this.pending_device_restore.camera_id = None;
                this.camera_id = camera_id.cloned();
                this.camera = feeds.camera.as_ref().map(|selected| {
                    let mut camera = remembered_camera(&selected.id, &this.devices.cameras);
                    camera.label = selected.label.clone();
                    camera
                });
                if !crate::store::set_recording_camera_id(this.camera_id.as_ref()) {
                    tracing::warn!("Could not save the selected camera");
                }
            }
            let microphone_changed = this.microphone.as_ref().map(|microphone| &microphone.name)
                != feeds.microphone.as_ref();
            if microphone_changed {
                this.pending_device_restore.microphone_name = None;
                this.microphone = feeds
                    .microphone
                    .as_deref()
                    .map(|name| remembered_microphone(name, &this.devices.microphones));
                if !crate::store::set_recording_microphone_name(feeds.microphone.as_deref()) {
                    tracing::warn!("Could not save the selected microphone");
                }
            }
            let format_result =
                this.device_format_pending
                    .as_ref()
                    .and_then(|pending| match pending.format {
                        DeviceFormat::Camera(_) => feeds.camera_configuration_result(pending.epoch),
                        DeviceFormat::Microphone(_) => {
                            feeds.microphone_configuration_result(pending.epoch)
                        }
                    });
            if camera_changed || microphone_changed || matches!(this.panel, Some(Panel::Device(_)))
            {
                cx.notify();
            }
            this.finish_device_format_change(format_result, cx);
        })
        .detach();

        // Enumeration hits AVFoundation and the window server, so it must not
        // run on the main thread -- doing it inline here costs ~180ms of a
        // blank window on this machine, and more on a machine with more
        // capture devices.

        // The filter field. Constructing it here (rather than lazily, per
        // panel) is what lets one focus handle survive a panel change, and the
        // blur listener inside `TextInputState` needs a `&mut Window` anyway.
        let search_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let search_events = cx.subscribe(&search_input, Self::on_search_event);

        Self {
            theme,
            expanded: false,
            // `rawOptions.mode` -- the recording mode is a persisted setting,
            // and the tray's Select Mode submenu writes the same key, so the
            // window has to start where the store left it rather than at a
            // hardcoded Instant.
            mode: Mode::from_store(),
            mode_hover: ModeHoverState::default(),
            mode_hover_task: None,
            mode_hover_bounds: std::array::from_fn(|_| Rc::new(Cell::new(None))),
            target: None,
            devices: DeviceSnapshot::default(),
            camera: None,
            camera_id: None,
            microphone: None,
            microphone_level,
            pending_device_restore: crate::store::RecordingInputSettings::load(),
            device_restore_suspended: false,
            device_format_target: None,
            device_formats: None,
            device_format_value: None,
            device_format_generation: 0,
            device_format_pending: None,
            device_format_notice: None,
            system_audio: false,
            selected_display: None,
            selected_window: None,
            panel: None,
            resize_task: None,
            search: String::new(),
            search_input,
            _search_events: search_events,
            enumerating: true,
            session,
            checking_storage: false,
            deep_link_start: None,
            microphone_warning: None,
            recents: None,
            recents_task: None,
            library: None,
            library_task: None,
            incomplete_recording: None,
            recovery_error: None,
            recovery_pending: false,
            recovery_scan_task: None,
            recovery_action_task: None,
            plan: PlanBadge::current(),
            thumbnails: target_thumbnails::ThumbnailCache::default(),
            display_thumbnail_task: None,
            window_thumbnail_task: None,
            target_poll_task: None,
            prewarm_task: None,
        }
    }

    /// Kick off device enumeration.
    ///
    /// Deliberately *not* called from `new`. `new` runs inside `open_window`'s
    /// builder closure, before the window is fully constructed, and a task
    /// spawned there resolves against a window whose invalidator is not yet
    /// wired to the platform window -- the update runs, the model updates, and
    /// no frame is ever scheduled, so the panels stay on "Loading..." until
    /// some unrelated event forces a redraw. Calling this once the window
    /// handle exists is what makes the refresh land.
    pub fn start_enumeration(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.spawn_in(window, async move |this, cx| {
            let snapshot = cx
                .background_executor()
                .spawn(async { DeviceSnapshot::enumerate() })
                .await;

            this.update_in(cx, |this, window, cx| {
                tracing::info!(
                    cameras = snapshot.cameras.len(),
                    microphones = snapshot.microphones.len(),
                    displays = snapshot.displays.len(),
                    windows = snapshot.windows.len(),
                    "enumerated capture devices"
                );
                this.devices = snapshot;
                this.enumerating = false;

                this.restore_recording_inputs(cx);

                // `CAP_GPUI_AUTO_CAMERA=1`: select the first camera the way a
                // click would -- the automated check drives the preview window
                // this way because synthetic clicks are dropped.
                if std::env::var("CAP_GPUI_AUTO_CAMERA").is_ok_and(|v| v == "1")
                    && this.camera.is_none()
                    && let Some(first) = this.devices.cameras.first().cloned()
                {
                    tracing::info!(camera = %first.label, "auto-selecting camera");
                    this.set_camera_selection(Some(first), cx);
                }
                if std::env::var("CAP_GPUI_AUTO_MIC").is_ok_and(|value| value == "1")
                    && this.microphone.is_none()
                {
                    let selected =
                        cap_recording::feeds::microphone::MicrophoneFeed::default_device()
                            .and_then(|(name, _, _)| {
                                this.devices
                                    .microphones
                                    .iter()
                                    .find(|microphone| microphone.name == name)
                                    .cloned()
                            })
                            .or_else(|| this.devices.microphones.first().cloned());
                    if let Some(microphone) = selected {
                        tracing::info!(microphone = %microphone.name, "auto-selecting microphone");
                        this.set_microphone_selection(Some(microphone), cx);
                    }
                }
                // `CAP_GPUI_AUTO_PANEL=display|window`: open that target
                // picker panel the way the chevron click does. Same reason as
                // `CAP_GPUI_AUTO_CAMERA` above -- the chrome screenshots need
                // the card grid on screen and synthetic clicks are dropped.
                match std::env::var("CAP_GPUI_AUTO_PANEL").as_deref() {
                    Ok("display") => {
                        this.open_panel(Panel::Target(TargetType::Display), window, cx)
                    }
                    Ok("window") => this.open_panel(Panel::Target(TargetType::Window), window, cx),
                    _ => {}
                }
                // `if (!targetMode) scheduleTargetListPrewarm()` on
                // `main-window-ready` (`new-main/index.tsx:2528`) -- the point
                // where the window has its lists and can afford background
                // work. Here that point is enumeration landing.
                this.schedule_target_prewarm(window, cx);
                cx.notify();
            })
            .unwrap_or_else(|error| tracing::error!("device enumeration update failed: {error:#}"));
        })
        .detach();
    }

    // -- Target thumbnails (`thumbnails/mod.rs` + the queries around it) -----

    fn target_prewarm_allowed(&self, window: &Window, cx: &Context<Self>) -> bool {
        let visible = if cfg!(target_os = "macos") {
            crate::platform::window_is_visible(window)
        } else {
            window.is_window_active()
        };
        self.session.read(cx).phase == Phase::Idle
            && visible
            && !crate::app_windows::onboarding_is_open(cx)
            && crate::store::has_completed_startup()
            && crate::store::has_completed_onboarding()
    }

    fn schedule_target_prewarm(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.target_prewarm_allowed(window, cx) || !self.thumbnails.take_prewarm() {
            return;
        }

        self.prewarm_task = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor()
                .timer(target_thumbnails::PREWARM_DELAY)
                .await;

            // Displays first, then windows -- the source's two awaited
            // `prefetchQuery` calls, in that order. Each sweep re-lists, so the
            // separate cheap-list prefetch it opens with is already covered.
            for kind in [TargetType::Display, TargetType::Window] {
                let Ok(sweep) = this.update_in(cx, |this, window, cx| {
                    if this.target_prewarm_allowed(window, cx) {
                        this.start_capture(kind, window, cx)
                    } else {
                        None
                    }
                }) else {
                    return;
                };
                if let Some(sweep) = sweep {
                    sweep.await;
                }
            }
        }));
    }

    /// Install a fresh cheap list without disturbing the thumbnails already on
    /// screen: reconciliation is by id, so a target that is still there keeps
    /// its image and only targets that went away are evicted. Blanking the
    /// cache on every 5s tick would make the grid flicker once per poll.
    fn install_target_lists(
        &mut self,
        targets: devices::TargetSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.install_displays(targets.displays, window, cx);
        self.install_windows(targets.windows, window, cx);
    }

    fn install_displays(
        &mut self,
        displays: Vec<DisplayOption>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for image in self.thumbnails.retain_displays(&displays) {
            let _ = window.drop_image(image);
        }
        self.devices.displays = displays;
        cx.notify();
    }

    fn install_windows(
        &mut self,
        windows: Vec<WindowOption>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for image in self.thumbnails.retain_windows(&windows) {
            let _ = window.drop_image(image);
        }
        self.devices.windows = windows;
        cx.notify();
    }

    /// Start one capture sweep, or return `None` because one is already in
    /// flight -- the `fetchStatus !== "idle"` guard on the source's refetch
    /// effects (`new-main/index.tsx:2626, 2635`). Refreshes never stack.
    ///
    /// The returned task is handed to the caller rather than stored, because
    /// the prewarm has to *await* the display sweep before starting the window
    /// sweep (`prefetchQuery` displays, then `prefetchQuery` windows) while the
    /// panel poll just parks it in a field.
    ///
    /// Everything expensive happens off the main thread: the enumeration, the
    /// ScreenCaptureKit capture (tokio, because the cidre future needs a
    /// reactor) and the RGBA-to-`RenderImage` swap all run inside the spawned
    /// task; the entity update only swaps `Arc`s.
    fn start_capture(
        &mut self,
        kind: TargetType,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Task<()>> {
        match kind {
            TargetType::Display => {
                if self.thumbnails.display_inflight() {
                    return None;
                }
                self.thumbnails.set_display_inflight(true);

                let (events_tx, events) = flume::unbounded();
                // The tokio handle rides along in the returned task so that
                // dropping the task tears the sweep down: the `flume` receiver
                // goes with it and the sweep's next `send` fails, which is what
                // actually stops it (see `run_capture` -- the capture itself is
                // on a blocking thread and cannot be aborted mid-screenshot).
                let capture = gpui_tokio::Tokio::spawn(cx, async move {
                    target_thumbnails::capture_displays(events_tx).await;
                });

                Some(cx.spawn_in(window, async move |this, cx| {
                    let _capture = capture;
                    let mut swept = None;
                    while let Ok(first) = events.recv_async().await {
                        let mut batch = vec![first];
                        batch.extend(events.try_iter());
                        for event in &batch {
                            if let target_thumbnails::DisplayEvent::Listed(list) = event {
                                swept = Some(target_thumbnails::display_signature(list));
                            }
                        }
                        if this
                            .update_in(cx, |this, window, cx| {
                                this.apply_display_events(batch, window, cx)
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    // The channel closing is the sweep finishing, which is when
                    // the Tauri query resolves and
                    // `setDisplayThumbnailsSignature` runs
                    // (`new-main/index.tsx:2617-2620`). Committing the
                    // signature at `Listed` time instead would mark a sweep
                    // that never landed as up to date.
                    this.update(cx, |this, cx| {
                        if let Some(signature) = swept {
                            this.thumbnails.set_display_signature(signature);
                        }
                        this.thumbnails.set_display_inflight(false);
                        // In-process SCK screenshot sweeps can provoke the
                        // macOS 26 style-mask mutation on the main window
                        // while it is visible (prewarm at launch, panel-open
                        // refreshes) -- re-assert the borderless mask.
                        crate::app_windows::heal_main_window_style(cx);
                    })
                    .ok();
                }))
            }
            TargetType::Window => {
                if self.thumbnails.window_inflight() {
                    return None;
                }
                self.thumbnails.set_window_inflight(true);

                let (events_tx, events) = flume::unbounded();
                let capture = gpui_tokio::Tokio::spawn(cx, async move {
                    target_thumbnails::capture_windows(events_tx).await;
                });

                Some(cx.spawn_in(window, async move |this, cx| {
                    let _capture = capture;
                    let mut swept = None;
                    while let Ok(first) = events.recv_async().await {
                        let mut batch = vec![first];
                        batch.extend(events.try_iter());
                        for event in &batch {
                            if let target_thumbnails::WindowEvent::Listed(list) = event {
                                swept = Some(target_thumbnails::window_signature(list));
                            }
                        }
                        if this
                            .update_in(cx, |this, window, cx| {
                                this.apply_window_events(batch, window, cx)
                            })
                            .is_err()
                        {
                            return;
                        }
                    }
                    this.update(cx, |this, cx| {
                        if let Some(signature) = swept {
                            this.thumbnails.set_window_signature(signature);
                        }
                        this.thumbnails.set_window_inflight(false);
                        // Same macOS 26 style-mask heal as the display sweep.
                        crate::app_windows::heal_main_window_style(cx);
                    })
                    .ok();
                }))
            }
            // Area and Camera Only have no cards to fill.
            TargetType::Area | TargetType::CameraOnly => None,
        }
    }

    /// The while-a-picker-is-open loop.
    ///
    /// (a) an immediate cheap re-list, which is what makes opening the panel
    /// show windows opened since launch; (b) every `CAPTURE_LIST_STALE_TIME`,
    /// another cheap re-list plus the signature comparison from
    /// `new-main/index.tsx:2621-2639` -- refetch the thumbnails when the list
    /// they were captured from no longer matches the live one; (c) for
    /// displays only, a `CAPTURE_THUMBNAIL_STALE_TIME` floor as well, the
    /// `refetchInterval: 10_000` that `listDisplaysWithThumbnails`
    /// (`utils/queries.ts:75`) carries and the editor sidebar inherits.
    ///
    /// Nothing here runs while no target panel is open: `close_panel` drops the
    /// task, which is the `enabled:` on every one of those queries.
    fn start_target_poll(&mut self, kind: TargetType, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(kind, TargetType::Area | TargetType::CameraOnly) {
            self.target_poll_task = None;
            return;
        }

        self.target_poll_task = Some(cx.spawn_in(window, async move |this, cx| {
            let mut last_display_capture: Option<std::time::Instant> = None;
            loop {
                let list = cx
                    .background_executor()
                    .spawn(async { devices::TargetSnapshot::enumerate() })
                    .await;

                let Ok(()) = this.update_in(cx, |this, window, cx| {
                    this.install_target_lists(list, window, cx);

                    let stale = match kind {
                        TargetType::Display => {
                            this.thumbnails.displays_stale(&this.devices.displays)
                                || last_display_capture.is_none_or(|at| {
                                    at.elapsed() >= target_thumbnails::THUMBNAIL_STALE_TIME
                                })
                        }
                        _ => this.thumbnails.windows_stale(&this.devices.windows),
                    };
                    if !stale {
                        return;
                    }
                    if let Some(task) = this.start_capture(kind, window, cx) {
                        if kind == TargetType::Display {
                            last_display_capture = Some(std::time::Instant::now());
                            this.display_thumbnail_task = Some(task);
                        } else {
                            this.window_thumbnail_task = Some(task);
                        }
                    }
                }) else {
                    return;
                };

                cx.background_executor()
                    .timer(target_thumbnails::LIST_STALE_TIME)
                    .await;
            }
        }));
    }

    fn apply_display_events(
        &mut self,
        batch: Vec<target_thumbnails::DisplayEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for event in batch {
            match event {
                target_thumbnails::DisplayEvent::Listed(list) => {
                    self.install_displays(list, window, cx);
                }
                target_thumbnails::DisplayEvent::Captured(id, image) => {
                    if let Some(old) = self.thumbnails.insert_display(&id, image) {
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        cx.notify();
        // The main window is not necessarily active while a sweep lands (the
        // prewarm runs at launch, behind whatever the user was doing), and an
        // inactive window only repaints when asked.
        window.refresh();
    }

    fn apply_window_events(
        &mut self,
        batch: Vec<target_thumbnails::WindowEvent>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for event in batch {
            match event {
                target_thumbnails::WindowEvent::Listed(list) => {
                    self.install_windows(list, window, cx);
                }
                target_thumbnails::WindowEvent::Captured {
                    id,
                    image,
                    app_icon,
                } => {
                    let icon = app_icon.map(|bytes| {
                        std::sync::Arc::new(gpui::Image::from_bytes(gpui::ImageFormat::Png, bytes))
                    });
                    if let Some(old) = self.thumbnails.insert_window(&id, image, icon) {
                        let _ = window.drop_image(old);
                    }
                }
            }
        }
        cx.notify();
        window.refresh();
    }

    /// Re-run the Recents scan and re-decode its thumbnails.
    ///
    /// `shouldLoadRecents()` (index.tsx:2210-2215) gates the query on the
    /// window being expanded, focused, idle, and free of a target mode or an
    /// open menu. Expanded is the check that carries the weight here: the
    /// section is not rendered at all when it is false, so a scan then would
    /// be filesystem work nobody could see. The rest of the gate is the
    /// Tauri app avoiding a fetch it would immediately re-run; here the
    /// refresh points are explicit (expanding, and the main window coming
    /// back) rather than reactive.
    ///
    /// The scan and every decode run on the background executor -- a library
    /// with several hundred bundles is several hundred `read_dir` + JSON
    /// parses, and the thumbnails are native-resolution JPEGs. The list lands
    /// first so the cards can paint with their icon fallbacks, then the
    /// decodes fan out through `library::spawn_decode_pool` and land in
    /// batches: one entity update per drain of the result channel rather than
    /// one await-notify-repaint round trip per card.
    pub fn refresh_recents(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.expanded {
            return;
        }

        self.plan = PlanBadge::current();
        self.recents_task = Some(cx.spawn_in(window, async move |this, cx| {
            let items = cx
                .background_executor()
                .spawn(async { library::recent_media() })
                .await;
            tracing::info!(count = items.len(), "scanned the recordings library");

            let thumbnails: Vec<(usize, std::path::PathBuf)> = items
                .iter()
                .enumerate()
                .filter_map(|(index, item)| item.thumbnail.clone().map(|path| (index, path)))
                .collect();

            if this
                .update_in(cx, |this, window, cx| this.set_recents(items, window, cx))
                .is_err()
            {
                return;
            }

            let (_decodes, results) = library::spawn_decode_pool(
                cx.background_executor(),
                thumbnails,
                |(index, path)| library::decode_thumbnail(&path).map(|image| (index, image)),
            );
            while let Ok(first) = results.recv_async().await {
                let mut batch = vec![first];
                batch.extend(results.try_iter());
                if this
                    .update_in(cx, |this, window, cx| {
                        for (index, image) in batch {
                            let Some(entry) =
                                this.recents.as_mut().and_then(|items| items.get_mut(index))
                            else {
                                continue;
                            };
                            if let Some(old) = entry.thumbnail.replace(image) {
                                let _ = window.drop_image(old);
                            }
                        }
                        cx.notify();
                        // The main window is not necessarily the active one
                        // when a recording finishes into it, and an inactive
                        // window only repaints when asked (the unit-2 finding).
                        window.refresh();
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
    }

    pub fn start_recovery_check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.scan_incomplete_recordings(window, cx, std::time::Duration::from_secs(2));
    }

    fn scan_incomplete_recordings(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
        delay: std::time::Duration,
    ) {
        self.recovery_scan_task = Some(cx.spawn_in(window, async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }

            let idle = this
                .update_in(cx, |this, _, cx| this.session.read(cx).phase == Phase::Idle)
                .unwrap_or(false);
            if !idle {
                return;
            }

            let incomplete = cx
                .background_executor()
                .spawn(async { library::find_incomplete_recordings() })
                .await;

            this.update_in(cx, |this, window, cx| {
                if this.session.read(cx).phase != Phase::Idle {
                    return;
                }
                this.incomplete_recording = incomplete.into_iter().next();
                if this.incomplete_recording.is_none() {
                    this.recovery_error = None;
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        }));
    }

    fn process_incomplete_recording(
        &mut self,
        recover: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.recovery_pending || self.session.read(cx).phase != Phase::Idle {
            return;
        }
        let Some(recording) = self.incomplete_recording.clone() else {
            return;
        };
        if !recover
            && !crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this recording?",
                "Yes",
                "No",
                false,
            )
        {
            return;
        }

        self.recovery_pending = true;
        self.recovery_error = None;
        cx.notify();
        window.refresh();

        self.recovery_action_task = Some(cx.spawn_in(window, async move |this, cx| {
            let result = if recover {
                cx.background_executor().spawn(async move {
                    library::recover_incomplete_recording(&recording.project_path)
                }).await
            } else {
                let path = recording.project_path;
                let Ok(task) = cx.update(|_, cx| {
                    gpui_tokio::Tokio::spawn(
                        cx,
                        crate::upload::queue::delete_recording(path.clone()),
                    )
                }) else {
                    return;
                };
                task.await
                    .unwrap_or_else(|error| Err(error.to_string()))
                    .map(|()| path)
            };

            this.update_in(cx, |this, window, cx| {
                this.recovery_pending = false;
                match result {
                    Ok(project_path) => {
                        this.incomplete_recording = None;
                        this.recovery_error = None;
                        this.refresh_recents(window, cx);
                        this.refresh_open_library(window, cx);
                        this.scan_incomplete_recordings(window, cx, std::time::Duration::ZERO);
                        if recover {
                            if project_path.join("content/output.mp4").is_file() {
                                cx.reveal_path(&project_path.join("content/output.mp4"));
                            } else {
                                cx.defer(move |cx| app_windows::open_editor(project_path, cx));
                            }
                        }
                    }
                    Err(error) => {
                        tracing::warn!(%error, "incomplete recording action failed");
                        this.recovery_error = Some(error);
                    }
                }
                cx.notify();
                window.refresh();
            })
            .ok();
        }));
    }

    /// Install a fresh scan result, releasing the previous thumbnails from the
    /// sprite atlas -- the same explicit drop the camera preview does with
    /// every frame it replaces.
    fn set_recents(&mut self, items: Vec<RecentItem>, window: &mut Window, cx: &mut Context<Self>) {
        for entry in self.recents.take().into_iter().flatten() {
            if let Some(image) = entry.thumbnail {
                let _ = window.drop_image(image);
            }
        }
        self.recents = Some(
            items
                .into_iter()
                .map(|item| RecentEntry {
                    item,
                    thumbnail: None,
                })
                .collect(),
        );
        cx.notify();
        window.refresh();
    }

    fn toggle_expanded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let from = self.window_size();
        self.expanded = !self.expanded;
        let to = self.window_size();
        tracing::info!(expanded = self.expanded, "toggling main window size");

        #[cfg(target_os = "linux")]
        let uses_wayland = matches!(
            raw_window_handle::HasWindowHandle::window_handle(window),
            Ok(handle) if matches!(handle.as_raw(), raw_window_handle::RawWindowHandle::Wayland(_))
        );

        // Matches `resizeMainWindow`: 180ms, ease-out cubic.
        //
        // Assigning over the previous task drops it, which cancels a toggle
        // that is still in flight -- otherwise two animations would fight over
        // `resize` and the window could settle at an interpolated size.
        self.resize_task = Some(cx.spawn_in(window, async move |this, cx| {
            #[cfg(target_os = "linux")]
            if uses_wayland {
                // Intermediate sizes and half-pixel center shifts accumulate compositor rounding drift.
                let height = to.1 + (to.1 - MAIN_WINDOW_HEIGHT).rem_euclid(2.);
                let _ = this.update_in(cx, |_this, window, _cx| {
                    window.resize(gpui::size(px(to.0), px(height)));
                });
                return;
            }

            let start = std::time::Instant::now();

            loop {
                let elapsed = start.elapsed().as_secs_f32();
                let t = (elapsed / RESIZE_DURATION_SECS).clamp(0., 1.);
                // ease-out cubic
                let eased = 1. - (1. - t).powi(3);

                let size = gpui::size(
                    px(from.0 + (to.0 - from.0) * eased),
                    px(from.1 + (to.1 - from.1) * eased),
                );

                if this
                    .update_in(cx, |_this, window, _cx| window.resize(size))
                    .is_err()
                {
                    return;
                }

                if t >= 1. {
                    return;
                }

                cx.background_executor()
                    .timer(std::time::Duration::from_millis(8))
                    .await;
            }
        }));

        // `enabled: shouldLoadRecents()` -- expanding is what turns the query
        // on, and collapsing leaves the last result in place for the next one.
        self.refresh_recents(window, cx);

        cx.notify();
    }

    /// The window size the current state should be drawn at.
    fn window_size(&self) -> (f32, f32) {
        if self.expanded {
            (EXPANDED_WIDTH, EXPANDED_HEIGHT)
        } else {
            (MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT)
        }
    }

    /// Re-resolve the palette when the system appearance flips, or when the
    /// native material lands.
    ///
    /// The material is installed from a spawned task after the window exists
    /// (see `main`), so the first frames paint before it is known -- the
    /// global is polled here rather than pushed, and the install notifies the
    /// window once so this runs again.
    fn sync_appearance(&mut self, window: &Window, cx: &gpui::App) {
        self.theme.refresh(window, cx, true);
    }

    /// `CAP_GPUI_AUTO_EXPAND=1`: open expanded, the way clicking the zoom
    /// light does. Same reason as the other `CAP_GPUI_AUTO_*` hooks --
    /// unprivileged synthetic clicks are dropped, so the screenshot harness
    /// needs a way in.
    pub fn auto_expand(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if std::env::var("CAP_GPUI_AUTO_EXPAND").is_ok_and(|value| value == "1") {
            self.ensure_expanded(window, cx);
        }
    }

    pub fn is_expanded(&self) -> bool {
        self.expanded
    }

    /// Expand through `toggle_expanded` so the restore takes the exact path
    /// the zoom light takes (resize animation, section reveal, Recents scan).
    pub fn ensure_expanded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.expanded {
            self.toggle_expanded(window, cx);
        }
    }

    /// `CAP_GPUI_AUTO_RECENT=1`: click the first Recents card, once the
    /// library scan that only runs while expanded has landed. `=twice` clicks
    /// it a second time a moment later, which is what proves the editor
    /// registry reuses a window rather than opening a second one.
    ///
    /// Same reason as every other `CAP_GPUI_AUTO_*` hook: unprivileged
    /// synthetic clicks are dropped, and this goes through
    /// [`activate_recent`], the card's own handler.
    pub fn auto_open_recent(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Ok(mode) = std::env::var("CAP_GPUI_AUTO_RECENT") else {
            return;
        };
        if mode.is_empty() {
            return;
        }
        if !self.expanded {
            self.toggle_expanded(window, cx);
        }
        let twice = mode == "twice";

        cx.spawn(async move |this, cx| {
            // The scan and each thumbnail decode run on the background
            // executor; poll rather than guess how long that takes.
            for _ in 0..40 {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(250))
                    .await;
                let picked = this
                    .update(cx, |this: &mut MainWindow, cx| {
                        let entry = this.recents.as_ref()?.first()?;
                        let item = entry.item.clone();
                        activate_recent(&item, cx);
                        Some(item)
                    })
                    .ok()
                    .flatten();
                let Some(item) = picked else { continue };

                if twice {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(2500))
                        .await;
                    cx.update(|cx| {
                        tracing::info!("second Recents activation for the same project");
                        activate_recent(&item, cx);
                    });
                }
                return;
            }
            tracing::warn!("CAP_GPUI_AUTO_RECENT: the library scan produced nothing");
        })
        .detach();
    }

    /// Bring the target-select overlays in line with the armed target.
    ///
    /// Deferred, because opening a window inside an entity update paints it
    /// synchronously and double-leases this very view. This mirrors
    /// `toggleTargetMode` / `selectDisplayTarget` / `selectWindowTarget` in
    /// the Tauri main window, which each call `openTargetSelectOverlays` (or
    /// `closeTargetSelectOverlays`) right after setting the mode.
    fn sync_overlays(&mut self, cx: &mut Context<Self>) {
        self.cancel_deep_link_start();
        let Some(mode) = self.target else {
            // Toggling the armed tile off is a dismissal ("cancelled" in the
            // Tauri dismissal vocabulary), so it takes the same path Escape
            // does -- which also reveals the main window if the picker hid it.
            cx.defer(app_windows::dismiss_target_overlays);
            return;
        };
        let request = app_windows::OverlayRequest {
            mode,
            recording_mode: self.effective_mode(cx),
            // A display picked from the dropdown narrows the overlays to that
            // display; otherwise every display gets one.
            display: match mode {
                TargetType::Display => self
                    .selected_display
                    .as_ref()
                    .map(|display| display.id.clone()),
                _ => None,
            },
            pinned_window: match mode {
                TargetType::Window => self
                    .selected_window
                    .as_ref()
                    .map(|window| window.id.clone()),
                _ => None,
            },
        };
        let editor_target = self.session.read(cx).editor_recording_target();
        cx.defer(move |cx: &mut gpui::App| {
            if RecordingSession::global(cx)
                .read(cx)
                .editor_recording_target()
                != editor_target
            {
                return;
            }
            if let Some(path) = editor_target {
                app_windows::open_editor_target_overlays(path, request, cx);
            } else {
                app_windows::open_target_overlays(request, cx);
            }
        });
    }

    /// Called when the overlays are dismissed (Escape, their close button) so
    /// the armed tile stops looking armed.
    pub fn clear_target(&mut self, cx: &mut Context<Self>) {
        if self.target.take().is_some() {
            cx.notify();
        }
    }

    /// The recording mode, for whoever is showing it -- the mode select window
    /// seeds its cards from here, the way that route reads `rawOptions.mode`.
    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub(crate) fn effective_mode(&self, cx: &gpui::App) -> Mode {
        effective_recording_mode(
            self.mode(),
            self.session.read(cx).editor_recording_target().is_some(),
        )
    }

    /// `handleModeChange`: `setOptions({ mode })` plus
    /// `commands.setRecordingMode(mode)`. The pill, the info panel and the mode
    /// select window all land here, so there is one place a mode change
    /// happens.
    pub fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        self.clear_mode_hover();
        cx.notify();
        if self.mode == mode
            || self.is_preparing_recording()
            || self.session.read(cx).editor_recording_target().is_some()
        {
            return;
        }
        self.mode = mode;
        // Open overlays label their start button with the mode.
        let select = crate::target_overlay::TargetSelect::global(cx);
        select.update(cx, |select, cx| select.set_recording_mode(mode, cx));
        tracing::info!(
            mode = mode.panel_title(),
            target_select = select.read(cx).recording_mode.panel_title(),
            "recording mode changed"
        );
        // `commands.setRecordingMode(mode)`, which is
        // `RecordingSettingsStore::set_mode` plus the two tray refreshes it
        // triggers (`handle_mode_selection`). Every mode affordance -- the
        // pill, the info panel, the mode select window and the tray's own
        // Select Mode submenu -- reaches this method, so this is the one place
        // the setting is written.
        // Written inline, like every other store write in this app (and like
        // `RecordingSettingsStore::set_mode` itself): a background write would
        // land *after* the tray re-read the setting, and the tick would stay on
        // the old mode.
        crate::store::set_recording_mode_slug(mode.slug());
        cx.defer(move |cx: &mut gpui::App| crate::tray::mode_changed(mode, cx));
        cx.notify();
    }

    /// The concrete capture target the current UI state describes, or `None`
    /// when starting makes no sense yet (no target mode, Window mode with no
    /// window picked, Area mode -- which is drawn on the overlay).
    fn armed_target(&self) -> Option<ScreenCaptureTarget> {
        match self.target? {
            TargetType::Display => {
                // The Tauri flow preselects the primary display the moment the
                // Display tile is clicked; mirror that when nothing specific
                // was picked from the dropdown.
                let id = self
                    .selected_display
                    .as_ref()
                    .map(|display| display.id.clone())
                    .unwrap_or_else(|| scap_targets::Display::primary().id());
                Some(ScreenCaptureTarget::Display { id })
            }
            TargetType::Window => {
                self.selected_window
                    .as_ref()
                    .map(|window| ScreenCaptureTarget::Window {
                        id: window.id.clone(),
                    })
            }
            TargetType::Area => None,
            TargetType::CameraOnly => Some(ScreenCaptureTarget::CameraOnly),
        }
    }

    /// The recording mode the Mode pill maps to, `None` for Screenshot (that
    /// path does not go through the recording actors at all).
    fn recording_mode(&self, cx: &gpui::App) -> Option<recording::RecordingMode> {
        match self.effective_mode(cx) {
            Mode::Instant => Some(recording::RecordingMode::Instant),
            Mode::Studio => Some(recording::RecordingMode::Studio),
            Mode::Screenshot => None,
        }
    }

    /// Dev-only end-to-end driver (`CAP_GPUI_AUTO_RECORD=studio:5`): synthetic
    /// clicks are dropped without Accessibility permission, so the automated
    /// check arms a target and drives start/stop through the same methods the
    /// buttons call.
    ///
    /// `CAP_GPUI_AUTO_OVERLAY=display|window|area` routes the start through the
    /// target-select overlay instead of straight off this window --
    /// `CAP_GPUI_AUTO_AREA=x,y,w,h` seeds the crop the drag would have drawn,
    /// and the window variant pins the first enumerated window the way picking
    /// one from the dropdown does.
    pub fn auto_record(
        &mut self,
        mode: Mode,
        record_secs: u64,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let overlay = auto_overlay_kind();
        let area = auto_area_rect();

        self.mode = mode;
        self.target = Some(overlay.unwrap_or(TargetType::Display));
        self.system_audio =
            std::env::var("CAP_GPUI_AUTO_SYSTEM_AUDIO").is_ok_and(|value| value == "1");
        cx.notify();

        // `CAP_GPUI_AUTO_PAUSE=1`: wiggle pause/resume in the middle third, so
        // ffprobe duration < wall time proves the pause reached the engine.
        let pause_wiggle = std::env::var("CAP_GPUI_AUTO_PAUSE").is_ok_and(|v| v == "1");

        let skip_mic = std::env::var("CAP_GPUI_AUTO_NO_MIC").is_ok_and(|v| v == "1")
            || mode == Mode::Screenshot;
        if skip_mic {
            self.set_microphone_selection(None, cx);
        }
        let required_window = auto_window_title();

        cx.spawn_in(window, async move |this, cx| {
            // Give enumeration and the first paint a moment; the recorder
            // itself does not depend on it, but the screenshots should show
            // real device rows.
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            if !skip_mic {
                // Exercise the microphone path too: record with the system default
                // input. "First in the list" is wrong on a machine with a
                // Continuity iPhone mic -- it enumerates but dies on stream start,
                // which kills the whole recording.
                let default_mic = cx
                    .background_executor()
                    .spawn(async {
                        cap_recording::feeds::microphone::MicrophoneFeed::default_device()
                            .map(|(name, _, _)| name)
                    })
                    .await;
                if this
                    .update_in(cx, |this, _window, cx| {
                        let microphone = default_mic
                            .and_then(|name| {
                                this.devices
                                    .microphones
                                    .iter()
                                    .find(|mic| mic.name == name)
                                    .cloned()
                            })
                            .or_else(|| this.devices.microphones.first().cloned());
                        if let Some(mic) = &microphone {
                            tracing::info!(mic = %mic.name, "auto-record microphone");
                        }
                        this.set_microphone_selection(microphone, cx);
                    })
                    .is_err()
                {
                    return;
                }
                // Give the app-scoped feed a moment to connect its input; locking
                // an input-less feed would fall back to a per-recording one and
                // dodge the path this harness exists to exercise.
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(1500))
                    .await;
            }

            if overlay == Some(TargetType::Window)
                && let Some(wanted) = required_window.clone()
            {
                let mut found = false;
                for _ in 0..20 {
                    found = this
                        .update_in(cx, |this, _window, cx| {
                            this.arm_overlay(TargetType::Window, cx);
                            this.selected_window
                                .as_ref()
                                .is_some_and(|window| window_matches(window, &wanted))
                        })
                        .unwrap_or(false);
                    if found {
                        break;
                    }
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(250))
                        .await;
                }
                if !found {
                    tracing::error!(
                        title = %wanted,
                        "CAP_GPUI_AUTO_WINDOW: no matching window"
                    );
                    return;
                }
            }

            let started = match overlay {
                None => {
                    tracing::info!("auto-record start requested");
                    this.update_in(cx, |this, window, cx| this.start_recording(window, cx))
                        .is_ok()
                }
                Some(kind) => {
                    // The overlay route: arm the mode (which opens the
                    // overlays), let them come up, seed what a drag or a hover
                    // would have produced, then press their Start button.
                    let wanted = required_window.clone();
                    let armed = this
                        .update_in(cx, |this, _window, cx| {
                            this.arm_overlay(kind, cx);
                            kind != TargetType::Window
                                || wanted.as_ref().is_none_or(|wanted| {
                                    this.selected_window
                                        .as_ref()
                                        .is_some_and(|selected| window_matches(selected, wanted))
                                })
                        })
                        .unwrap_or(false);
                    if !armed {
                        tracing::error!("auto-record selected window is no longer available");
                        return;
                    }
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(1500))
                        .await;
                    if let Some(area) = area {
                        tracing::info!(?area, "seeding area selection");
                        cx.update(|_, cx| app_windows::seed_area_selection(None, area, cx))
                            .ok();
                        cx.background_executor()
                            .timer(std::time::Duration::from_millis(300))
                            .await;
                    }
                    tracing::info!("auto-record start requested");
                    cx.update(|_, cx| app_windows::start_from_overlay(None, cx))
                        .unwrap_or(false)
                }
            };
            if !started {
                tracing::error!("auto-record could not start");
                return;
            }

            let third = std::time::Duration::from_secs(record_secs.div_ceil(3));
            let toggle = |this: &gpui::WeakEntity<Self>, cx: &mut gpui::AsyncWindowContext| {
                this.update_in(cx, |this, _, cx| {
                    this.session
                        .update(cx, |session, cx| session.toggle_pause(cx));
                })
                .ok();
            };
            if pause_wiggle {
                cx.background_executor().timer(third).await;
                toggle(&this, cx);
                cx.background_executor().timer(third).await;
                toggle(&this, cx);
                cx.background_executor().timer(third).await;
            } else {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(record_secs))
                    .await;
            }
            tracing::info!("auto-record stop requested");
            this.update_in(cx, |this, _, cx| {
                this.session.update(cx, |session, cx| session.stop(cx));
            })
            .ok();
        })
        .detach();
    }

    /// Arm a target mode the way clicking its tile does, picking a concrete
    /// window for the window variant since the harness cannot hover one.
    ///
    /// Also the tray's Record Display/Window/Area path: those items are
    /// `crate::open_target_picker(&app, RecordingTargetMode::*)` over there,
    /// which is the same "set the target mode, open the overlays" pair.
    pub fn arm_overlay(&mut self, kind: TargetType, cx: &mut Context<Self>) {
        if kind == TargetType::Window {
            self.selected_window = match auto_window_title() {
                Some(title) => self
                    .devices
                    .windows
                    .iter()
                    .find(|window| window_matches(window, &title))
                    .cloned(),
                None => self.devices.windows.first().cloned(),
            };
            if let Some(window) = &self.selected_window {
                tracing::info!(app = %window.app, title = %window.label, "auto window target");
            }
        }
        self.target = Some(kind);
        self.sync_overlays(cx);
        cx.notify();
    }

    /// `CAP_GPUI_AUTO_OVERLAY` on its own (no `CAP_GPUI_AUTO_RECORD`): open the
    /// overlays and leave them up, which is how the screenshots are taken.
    pub fn auto_open_overlay(
        &mut self,
        kind: TargetType,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let crop = auto_area_rect();
        cx.spawn_in(window, async move |this, cx| {
            // Enumeration first: the window variant pins a real window.
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            if this
                .update_in(cx, |this, _window, cx| this.arm_overlay(kind, cx))
                .is_err()
            {
                return;
            }
            if let Some(crop) = crop {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(1500))
                    .await;
                cx.update(|_, cx| app_windows::seed_area_selection(None, crop, cx))
                    .ok();
            }
        })
        .detach();
    }

    /// Start with the target the UI state describes. The overlays own the real
    /// start affordance now; this is the harness path
    /// (`CAP_GPUI_AUTO_RECORD` without `CAP_GPUI_AUTO_OVERLAY`).
    pub fn start_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.armed_target() else {
            return;
        };
        if self.effective_mode(cx) == Mode::Screenshot {
            // Screenshot mode never reaches the recording actors -- the
            // target goes straight to the capture path (`take_screenshot`).
            cx.defer(move |cx: &mut gpui::App| crate::screenshot::take_screenshot(target, cx));
            return;
        }
        self.start_recording_with_target(target, Vec::new(), window, cx);
    }

    /// Collect the UI state into a start config and hand it to the
    /// orchestrator, which opens the controls bar, hides this window, and
    /// starts the engine. Deferred because the orchestrator updates this very
    /// window (hide), which would re-enter the update we are inside of.
    ///
    /// The target comes in rather than being read off this view: it is the
    /// overlay that knows which display was clicked, which window is under the
    /// cursor, or what area was drawn.
    pub fn start_recording_with_target(
        &mut self,
        target: ScreenCaptureTarget,
        excluded_windows: Vec<scap_targets::WindowId>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.read(cx).phase != Phase::Idle || self.checking_storage {
            return;
        }
        // An armed editor recording target forces Studio before this window's
        // own mode is consulted -- the front half of the same rule
        // `start_recording` applies (`src-tauri/src/recording.rs:1492-1494`),
        // needed here because a Screenshot-mode pill maps to no recording
        // mode at all and would otherwise bail out of an editor-flow start.
        let editor_flow = self.session.read(cx).editor_recording_target().is_some();
        let mode = if editor_flow {
            recording::RecordingMode::Studio
        } else {
            match self.recording_mode(cx) {
                Some(mode) => mode,
                None => return,
            }
        };
        if matches!(target, ScreenCaptureTarget::CameraOnly) && self.camera.is_none() {
            self.session.update(cx, |session, cx| {
                session.error = Some("Camera-only recording requires a selected camera.".into());
                cx.notify();
            });
            if editor_flow {
                // No session phase transition is coming; restore the hidden
                // editor the way a cancelled picker would.
                cx.defer(app_windows::abort_editor_recording_flow);
            }
            return;
        }

        let (camera_feed, mic_feed, input_readiness, device_settings) = {
            let feeds = Feeds::global(cx);
            feeds.update(cx, |feeds, cx| feeds.resume_camera_preview(cx));
            let feeds = feeds.read(cx);
            (
                feeds.camera_actor(),
                feeds.mic_actor(),
                feeds.input_readiness(),
                feeds.requested_device_settings(),
            )
        };
        let config = recording::StartConfig {
            mode,
            target,
            device_settings,
            input_readiness,
            microphone: self.microphone.as_ref().map(|mic| mic.name.clone()),
            camera: self.camera_id.clone(),
            system_audio: self.system_audio,
            excluded_windows,
            camera_feed,
            mic_feed,
            #[cfg(target_os = "linux")]
            linux_instant_camera: None,
        };

        self.start_recording_config(config, cx);
    }

    pub(crate) fn start_recording_config(
        &mut self,
        config: recording::StartConfig,
        cx: &mut Context<Self>,
    ) {
        if self.enumerating
            || self.device_format_pending.is_some()
            || self.pending_device_restore.camera_id.is_some()
            || self.pending_device_restore.microphone_name.is_some()
        {
            self.session.update(cx, |session, cx| {
                session.error = Some(
                    "Recording devices are not ready. Open the recorder and try again.".into(),
                );
                cx.notify();
            });
            return;
        }
        let Ok(permit) = self.prepare_deep_link_start(cx) else {
            return;
        };
        let microphone_available = config.microphone.as_ref().is_some_and(|name| {
            self.devices
                .microphones
                .iter()
                .any(|device| &device.name == name)
        });
        if !microphone_available && crate::store::GeneralSettings::load().confirm_without_microphone
        {
            self.microphone_warning = Some(MicrophoneWarning {
                config,
                permit,
                dont_show_again: false,
                error: None,
            });
            cx.defer(app_windows::show_main_window);
            cx.notify();
            return;
        }
        self.check_storage_before_start(config, false, permit, cx);
    }

    pub(crate) fn prepare_deep_link_start(
        &mut self,
        cx: &mut Context<Self>,
    ) -> Result<RecordingStartPermit, String> {
        if self.device_format_pending.is_some() {
            return Err("Wait for the device format change to finish before recording".into());
        }
        let permit = RecordingStartPermit::prepare(
            self.session.read(cx).phase,
            app_windows::clean_capture_owned(cx),
            self.checking_storage,
        )?;
        self.pending_device_restore = crate::store::RecordingInputSettings::default();
        self.checking_storage = true;
        self.deep_link_start = Some(permit.clone());
        Ok(permit)
    }

    pub(crate) fn cancel_deep_link_start(&mut self) {
        self.microphone_warning = None;
        if RecordingStartPermit::cancel_current(&mut self.deep_link_start) {
            self.checking_storage = false;
        }
    }

    pub(crate) fn is_preparing_recording(&self) -> bool {
        self.checking_storage
            || self.deep_link_start.is_some()
            || self.device_format_pending.is_some()
    }

    fn device_changes_allowed(&self, cx: &gpui::App) -> bool {
        self.session.read(cx).phase == Phase::Idle
            && !self.is_preparing_recording()
            && !self.device_restore_suspended
            && !app_windows::clean_capture_owned(cx)
    }

    pub(crate) fn finish_deep_link_start(&mut self, permit: &RecordingStartPermit) {
        if self
            .deep_link_start
            .as_ref()
            .is_some_and(|current| current.same(permit))
        {
            self.cancel_deep_link_start();
        }
    }

    pub(crate) fn start_recording_config_with_permit(
        &mut self,
        config: recording::StartConfig,
        permit: RecordingStartPermit,
        cx: &mut Context<Self>,
    ) {
        self.check_storage_before_start(config, false, permit, cx);
    }

    fn recording_start_is_current(&self, permit: &RecordingStartPermit, cx: &gpui::App) -> bool {
        self.session.read(cx).phase == Phase::Idle
            && self
                .deep_link_start
                .as_ref()
                .is_some_and(|current| current.same(permit))
            && permit.is_current(cx)
    }

    fn finish_recording_start(&mut self, permit: &RecordingStartPermit) {
        self.finish_deep_link_start(permit);
    }

    fn confirm_microphone_warning(&mut self, cx: &mut Context<Self>) {
        let Some(mut warning) = self.microphone_warning.take() else {
            return;
        };
        if !self.recording_start_is_current(&warning.permit, cx) {
            self.finish_recording_start(&warning.permit);
            cx.notify();
            return;
        }
        if warning.dont_show_again
            && !crate::store::set_store_setting(
                crate::store::RECORDING_START_SAFETY,
                "confirmBeforeRecordingWithoutMicrophone",
                serde_json::Value::Bool(false),
            )
        {
            warning.error = Some(
                "Could not save your preference. Try again or leave the box unchecked.".into(),
            );
            self.microphone_warning = Some(warning);
            cx.notify();
            return;
        }
        warning.config.microphone = None;
        warning.config.mic_feed = None;
        self.check_storage_before_start(warning.config, false, warning.permit, cx);
        cx.notify();
    }

    fn dismiss_microphone_warning(&mut self, cx: &mut Context<Self>) {
        self.cancel_deep_link_start();
        cx.notify();
    }

    fn check_storage_before_start(
        &mut self,
        mut config: recording::StartConfig,
        acknowledged: bool,
        permit: RecordingStartPermit,
        cx: &mut Context<Self>,
    ) {
        if !self.recording_start_is_current(&permit, cx) {
            self.finish_recording_start(&permit);
            return;
        }
        if matches!(config.target, ScreenCaptureTarget::CameraOnly) {
            config.system_audio = false;
        }
        self.checking_storage = true;
        let main = cx.global::<app_windows::AppWindows>().main;
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async {
                recording::available_recording_storage()
            }).await;
            if !this.update(cx, |this, cx| {
                if !this.recording_start_is_current(&permit, cx) {
                    this.finish_recording_start(&permit);
                    return false;
                }
                true
            }).unwrap_or(false) {
                return;
            }
            let storage = match result {
                Ok(storage) => storage,
                Err(error) => {
                    this.update(cx, |this, cx| {
                        if !this.recording_start_is_current(&permit, cx) {
                            this.finish_recording_start(&permit);
                            return;
                        }
                        this.finish_recording_start(&permit);
                        this.session.update(cx, |session, cx| {
                            session.error = Some(format!("Could not check recording storage: {error}"));
                            cx.notify();
                        });
                        cx.defer(app_windows::show_main_window);
                        if this.session.read(cx).editor_recording_target().is_some() {
                            cx.defer(app_windows::abort_editor_recording_flow);
                        }
                    }).ok();
                    return;
                }
            };
            let can_start = storage.status() != cap_utils::disk_space::DiskSpaceStatus::Exhausted;
            if storage.status() == cap_utils::disk_space::DiskSpaceStatus::Ok || acknowledged && can_start {
                this.update(cx, |this, cx| {
                    if !this.recording_start_is_current(&permit, cx) {
                        this.finish_recording_start(&permit);
                        return;
                    }
                    cx.defer(move |cx| {
                        let allowed = main.update(cx, |this, _, cx| {
                            let allowed = this.recording_start_is_current(&permit, cx);
                            this.finish_deep_link_start(&permit);
                            allowed
                        }).unwrap_or(false);
                        if !allowed {
                            return;
                        }
                        app_windows::begin_recording(config, cx);
                    });
                }).ok();
                return;
            }
            let available = storage.available_bytes as f64 / 1_073_741_824.0;
            let detail = if can_start {
                format!("Only {available:.2} GB is available on your recording drive. Cap will stop automatically if storage gets too low, preserving your recording.")
            } else {
                format!("Only {available:.2} GB is available on your recording drive. Free up space so at least 512 MB is available before recording.")
            };
            let buttons = if can_start {
                vec![gpui::PromptButton::ok("Record anyway"), gpui::PromptButton::cancel("Go back")]
            } else {
                vec![gpui::PromptButton::cancel("OK")]
            };
            let receiver = cx.update(|cx| {
                if RecordingSession::global(cx).read(cx).phase != Phase::Idle
                    || !permit.is_current(cx)
                {
                    return Err(anyhow::anyhow!("Recording preparation is no longer current."));
                }
                app_windows::show_main_window(cx);
                cx.activate(true);
                main.update(cx, |_, window, cx| {
                    window.prompt(gpui::PromptLevel::Warning, "Low storage", Some(&detail), &buttons, cx)
                })
            });
            let confirmed = match receiver {
                Ok(receiver) => receiver.await == Ok(0) && can_start,
                Err(_) => false,
            };
            this.update(cx, |this, cx| {
                if !this.recording_start_is_current(&permit, cx) {
                    this.finish_recording_start(&permit);
                    return;
                }
                if confirmed {
                    this.check_storage_before_start(config, true, permit, cx);
                } else {
                    this.finish_recording_start(&permit);
                    if this.session.read(cx).editor_recording_target().is_some() {
                        cx.defer(app_windows::abort_editor_recording_flow);
                    }
                }
                cx.notify();
            }).ok();
        }).detach();
    }

    /// `await commands.focusWindow(target.id)` at the end of
    /// `selectWindowTarget` (`new-main/index.tsx:2431-2450`): picking a
    /// *window* from the list brings that window's application forward, so the
    /// thing about to be recorded is the thing on screen behind the overlay.
    /// `selectDisplayTarget` (`:2416-2429`) has no such call, and neither has a
    /// click on the overlay itself -- so this is wired to the window rows only.
    ///
    /// Deferred (so the overlays this selection opens go up first, the order
    /// the source awaits its calls in) and then run on the background executor:
    /// the Tauri command is an async command, and an AppKit activation inside
    /// this update would re-enter gpui's window callbacks.
    fn focus_selected_window(&self, cx: &mut Context<Self>) {
        let Some(window) = self.selected_window.as_ref() else {
            return;
        };
        let id = window.id.clone();
        cx.defer(move |cx: &mut gpui::App| {
            cx.background_executor()
                .spawn(async move {
                    crate::platform::focus_capture_target_window(&id);
                })
                .detach();
        });
    }

    // -- The editor record modal's device seams ------------------------------
    //
    // The Tauri editor modal reads and writes the *same* recording-options
    // store the main window uses (`useRecordingOptions` + `createCameraMutation`
    // + `setMicInput`, `ClipsSidebar.tsx:1084-1123`); in this app that store is
    // this window's state, so the modal reaches it through these.

    /// The camera the next recording will use, for whoever else renders it.
    pub fn camera_selection(&self) -> Option<&CameraOption> {
        self.camera.as_ref()
    }

    /// The microphone the next recording will use.
    pub fn microphone_selection(&self) -> Option<&MicrophoneOption> {
        self.microphone.as_ref()
    }

    pub(crate) fn device_snapshot(&self) -> &DeviceSnapshot {
        &self.devices
    }

    pub(crate) fn is_enumerating_devices(&self) -> bool {
        self.enumerating
    }

    pub(crate) fn suspend_device_restore(&mut self) {
        self.clear_mode_hover();
        self.device_restore_suspended = true;
        self.device_format_pending = None;
    }

    pub(crate) fn resume_device_restore(&mut self, cx: &mut Context<Self>) {
        self.device_restore_suspended = false;
        self.restore_recording_inputs(cx);
        if let Some(microphone) = &self.microphone {
            let name = microphone.name.clone();
            Feeds::global(cx).update(cx, |feeds, cx| feeds.set_microphone(Some(name), cx));
        }
    }

    fn restore_recording_inputs(&mut self, cx: &mut Context<Self>) {
        let Some(settings) = take_pending_recording_inputs(
            &mut self.pending_device_restore,
            self.enumerating,
            self.device_restore_suspended,
        ) else {
            return;
        };
        if let Some(id) = settings.camera_id {
            let camera = remembered_camera(&id, &self.devices.cameras);
            self.apply_camera_selection(Some(camera), Some(id), cx);
        }
        if let Some(name) = settings.microphone_name {
            let microphone = remembered_microphone(&name, &self.devices.microphones);
            self.apply_microphone_selection(Some(microphone), cx);
        }
    }

    /// Select (or clear) the camera -- the same wiring as the camera panel's
    /// rows: this window's state plus the app-scoped feed, which opens or
    /// closes the preview bubble.
    pub fn set_camera_selection(&mut self, camera: Option<CameraOption>, cx: &mut Context<Self>) {
        let id = camera.as_ref().map(|camera| {
            camera
                .model_id
                .clone()
                .map(recording::DeviceOrModelID::ModelID)
                .unwrap_or_else(|| recording::DeviceOrModelID::DeviceID(camera.device_id.clone()))
        });
        self.pending_device_restore.camera_id = None;
        if !crate::store::set_recording_camera_id(id.as_ref()) {
            tracing::warn!("Could not save the selected camera");
        }
        self.apply_camera_selection(camera, id, cx);
    }

    fn apply_camera_selection(
        &mut self,
        camera: Option<CameraOption>,
        id: Option<recording::DeviceOrModelID>,
        cx: &mut Context<Self>,
    ) {
        let selection =
            camera
                .as_ref()
                .zip(id.as_ref())
                .map(|(camera, id)| feeds::SelectedCamera {
                    id: id.clone(),
                    label: camera.label.clone(),
                    device_id: camera.device_id.clone(),
                    model_id: camera.model_id.clone(),
                });
        self.camera_id = id;
        self.camera = camera;
        Feeds::global(cx).update(cx, |feeds, cx| {
            let selected = selection.is_some();
            feeds.set_camera(selection, cx);
            if selected {
                feeds.resume_camera_preview(cx);
            }
        });
        cx.notify();
    }

    /// Select (or clear) the microphone -- state plus the app-scoped feed, the
    /// mic panel rows' wiring.
    pub fn set_microphone_selection(
        &mut self,
        microphone: Option<MicrophoneOption>,
        cx: &mut Context<Self>,
    ) {
        self.pending_device_restore.microphone_name = None;
        if !crate::store::set_recording_microphone_name(
            microphone.as_ref().map(|mic| mic.name.as_str()),
        ) {
            tracing::warn!("Could not save the selected microphone");
        }
        self.apply_microphone_selection(microphone, cx);
    }

    fn apply_microphone_selection(
        &mut self,
        microphone: Option<MicrophoneOption>,
        cx: &mut Context<Self>,
    ) {
        let label = microphone.as_ref().map(|mic| mic.name.clone());
        self.microphone = microphone;
        Feeds::global(cx).update(cx, |feeds, cx| feeds.set_microphone(label, cx));
        cx.notify();
    }

    /// Toggle system audio capture -- the system-audio row is a plain flag.
    pub fn set_system_audio(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.system_audio != enabled {
            self.system_audio = enabled;
            cx.notify();
        }
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let theme = self.theme;
        let meter_active = self.panel.is_none()
            && self.microphone.is_some()
            && self.session.read(cx).phase == Phase::Idle;
        self.microphone_level.update(cx, |meter, cx| {
            meter.configure(meter_active, theme.blue_9.into(), cx);
        });

        div()
            .size_full()
            .relative()
            .flex()
            .flex_col()
            .overflow_hidden()
            // `rounded-[16px]` on `.cap-window-shell`, matched natively by
            // `apply_squircle_corners(&window, 16.0)` in the Tauri app -- and,
            // when a material is installed, by the content-view squircle clip
            // in `platform::install_window_material`.
            .rounded(px(16.))
            // Opaque `bg-gray-1` with no material; a translucent tint over the
            // live `NSGlassEffectView`/`NSVisualEffectView` backdrop with one.
            .bg(theme.shell_bg())
            // Only the vibrancy path draws a shell border -- Liquid Glass sets
            // `border: 0`.
            .when_some(theme.shell_border(), |this, color| {
                this.border_1().border_color(color)
            })
            .font_family("Geist")
            // `body { font-family: "Geist Sans"; font-weight: 500 }`
            // (`ui-solid/src/main.css:189-192`). The shipping app renders
            // *everything* Medium unless a `font-*` class says otherwise, so
            // Medium -- not Regular -- is the inherited default at every root.
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.text_primary)
            .child(self.render_header(window, cx))
            .child(self.render_body(cx))
            .children(self.render_mode_hover(cx))
            .when(
                // The controls bar owns the live-recording UI; this overlay is
                // the fallback for when the bar window failed to open.
                {
                    let session = self.session.read(cx);
                    session.phase != Phase::Idle && !session.controls_open
                },
                |this| this.child(self.render_recording_overlay(cx)),
            )
            .when_some(
                self.incomplete_recording
                    .clone()
                    .filter(|_| self.session.read(cx).phase == Phase::Idle),
                |this, recording| this.child(self.render_recovery_toast(recording, cx)),
            )
            .when(app_windows::clean_capture_pending(cx), |this| {
                this.child(self.render_clean_capture_preflight(cx))
            })
            .when(self.microphone_warning.is_some(), |this| {
                this.child(self.render_microphone_warning(cx))
            })
            .on_key_down(cx.listener(|this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" && this.dismiss_main(cx) {
                    cx.stop_propagation();
                }
            }))
    }
}

impl MainWindow {
    fn render_microphone_warning(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let checked = self
            .microphone_warning
            .as_ref()
            .is_some_and(|warning| warning.dont_show_again);
        let error = self
            .microphone_warning
            .as_ref()
            .and_then(|warning| warning.error.clone());
        div()
            .id("microphone-warning")
            .absolute()
            .inset_0()
            .rounded(px(16.))
            .occlude()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.))
            .bg(theme.shell_bg())
            .on_mouse_down(gpui::MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(
                div()
                    .w_full()
                    .max_w(px(360.))
                    .rounded(px(12.))
                    .border_1()
                    .border_color(theme.body_border(6))
                    .bg(theme.gray_1)
                    .p(px(16.))
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(div().text_size(px(15.)).text_color(theme.gray_12).child("No microphone detected"))
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(theme.gray_11)
                            .child("This recording will not include your voice. Select a microphone, or continue without one."),
                    )
                    .child(
                        div()
                            .id("microphone-warning-dont-show-again")
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .py(px(4.))
                            .cursor_pointer()
                            .child(
                                div()
                                    .size(px(16.))
                                    .rounded(px(4.))
                                    .border_1()
                                    .border_color(if checked { theme.blue_9 } else { theme.gray_7 })
                                    .bg(if checked { theme.blue_9 } else { theme.gray_2 })
                                    .when(checked, |this| this.child(svg().path("icons/check.svg").size(px(14.)).text_color(rgb(0xffffff)))),
                            )
                            .child(div().text_size(px(12.)).text_color(theme.gray_11).child("Don't show again"))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if let Some(warning) = &mut this.microphone_warning {
                                    warning.dont_show_again = !warning.dont_show_again;
                                    warning.error = None;
                                }
                                cx.notify();
                            })),
                    )
                    .when_some(error, |this, error| this.child(div().text_size(px(11.)).text_color(theme.red_9).child(error)))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(8.))
                            .child(
                                ui::Button::plain(&theme, "confirm-without-microphone", ui::ButtonVariant::Blue, ui::ButtonSize::Lg)
                                    .label("Record without microphone")
                                    .on_click(cx.listener(|this, _, _, cx| this.confirm_microphone_warning(cx))),
                            )
                            .child(
                                ui::Button::plain(&theme, "cancel-without-microphone", ui::ButtonVariant::Gray, ui::ButtonSize::Lg)
                                    .label("Go back")
                                    .on_click(cx.listener(|this, _, _, cx| this.dismiss_microphone_warning(cx))),
                            ),
                    ),
            )
    }

    fn render_clean_capture_preflight(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        div()
            .absolute()
            .inset_0()
            .bg(theme.gray_1)
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(16.))
            .p(px(24.))
            .child(div().text_size(px(18.)).child("Keep your capture clean"))
            .child(
                div()
                    .text_size(px(14.))
                    .child(app_windows::clean_capture_camera_message(cx)),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .child(app_windows::clean_capture_shortcut_message(cx)),
            )
            .child(
                div()
                    .id("cancel-clean-capture")
                    .rounded(px(8.))
                    .p(px(12.))
                    .bg(theme.gray_3)
                    .cursor_pointer()
                    .child("Cancel")
                    .on_click(
                        cx.listener(|_, _, _, cx| cx.defer(app_windows::cancel_clean_capture)),
                    ),
            )
    }

    fn render_recovery_toast(
        &self,
        recording: library::IncompleteRecordingItem,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let pending = self.recovery_pending;
        let duration = recording.estimated_duration_secs.round() as u64;
        let duration_label = if duration == 0 {
            String::new()
        } else if duration < 60 {
            format!(" · ~{duration}s")
        } else if duration.is_multiple_of(60) {
            format!(" · ~{}m", duration / 60)
        } else {
            format!(" · ~{}m {}s", duration / 60, duration % 60)
        };
        let segments = format!(
            "{} segment{}{}",
            recording.segment_count,
            if recording.segment_count == 1 {
                ""
            } else {
                "s"
            },
            duration_label
        );

        div()
            .absolute()
            .bottom(px(12.))
            .left(px(12.))
            .right(px(12.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.red_4)
            .bg(theme.red_2)
            .p(px(10.))
            .shadow_md()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .child(
                                div()
                                    .text_size(px(10.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.red_11)
                                    .child("Incomplete Recording"),
                            )
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(12.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.gray_12)
                                    .child(recording.pretty_name),
                            )
                            .child(
                                div()
                                    .text_size(px(10.))
                                    .text_color(theme.gray_11)
                                    .child(segments),
                            )
                            .when_some(self.recovery_error.clone(), |this, error| {
                                this.child(
                                    div()
                                        .mt(px(4.))
                                        .text_size(px(10.))
                                        .text_color(theme.red_11)
                                        .child(error),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .flex_shrink_0()
                            .gap(px(6.))
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "recover-incomplete-recording",
                                    ui::ButtonVariant::Primary,
                                    ui::ButtonSize::Xs,
                                )
                                .label(if pending { "..." } else { "Recover" })
                                .disabled(pending)
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.process_incomplete_recording(true, window, cx);
                                    },
                                )),
                            )
                            .child(
                                ui::Button::plain(
                                    &theme,
                                    "discard-incomplete-recording",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Xs,
                                )
                                .label("Discard")
                                .disabled(pending)
                                .on_click(cx.listener(
                                    |this, _, window, cx| {
                                        this.process_incomplete_recording(false, window, cx);
                                    },
                                )),
                            ),
                    ),
            )
    }

    fn render_header(&self, _window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;

        let header = div()
            .when(cfg!(target_os = "windows"), |header| {
                header.window_control_area(gpui::WindowControlArea::Drag)
            })
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_shrink_0()
            .bg(theme.header_bg())
            // `divide-y divide-gray-5` between header and body.
            .border_b_1()
            .border_color(theme.header_border())
            .when(!cfg!(target_os = "windows"), |header| {
                header.child(self.render_traffic_lights(cx))
            })
            .child(self.render_header_actions(cx));

        #[cfg(target_os = "windows")]
        let header = header.child(self.render_windows_caption_controls(_window, cx));

        header
    }

    #[cfg(target_os = "windows")]
    fn render_windows_caption_controls(
        &self,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let dark = self.theme.is_dark();
        let foreground = Theme::with_alpha(
            rgb(if dark { 0xffffff } else { 0x12161f }),
            if window.is_window_active() { 0.8 } else { 0.4 },
        );
        let hover = gpui::rgba(if dark { 0xffffff0d } else { 0x0000000d });
        let pressed = gpui::rgba(if dark { 0xe9e9e908 } else { 0x00000008 });
        let button = |id: &'static str, icon: &'static str, height: f32| {
            div()
                .id(id)
                .group(id)
                .tab_index(0)
                .w(px(46.))
                .h_full()
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .cursor_default()
                .hover(move |style| {
                    style.bg(if id == "caption-close" {
                        rgb(0xc42b1c)
                    } else {
                        hover
                    })
                })
                .active(move |style| {
                    style.bg(if id == "caption-close" {
                        gpui::rgba(0xc42b1ce6)
                    } else {
                        pressed
                    })
                })
                .child(
                    svg()
                        .path(icon)
                        .id("caption-glyph")
                        .w(px(10.))
                        .h(px(height))
                        .text_color(foreground)
                        .when(id == "caption-close", |icon| {
                            icon.group_hover("caption-close", |style| {
                                style.text_color(gpui::white())
                            })
                            .group_active("caption-close", |style| style.text_color(gpui::white()))
                        }),
                )
        };

        div()
            .occlude()
            .flex()
            .h_full()
            .flex_shrink_0()
            .child(
                button("caption-minimize", "icons/caption-minimize-windows.svg", 1.)
                    .on_click(|_, window, _| window.minimize_window()),
            )
            .child(
                button(
                    "caption-maximize",
                    if self.expanded {
                        "icons/caption-restore-windows.svg"
                    } else {
                        "icons/caption-maximize-windows.svg"
                    },
                    if self.expanded { 11. } else { 10. },
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_expanded(window, cx);
                })),
            )
            .child(
                button("caption-close", "icons/caption-close-windows.svg", 10.).on_click(
                    cx.listener(|_, _, _, cx| {
                        cx.defer(app_windows::request_close_main);
                    }),
                ),
            )
    }

    /// `CaptionControlsMacOS`: 14px circles (`size-3.5`), 10px apart
    /// (`gap-2.5`), 12px from the left edge (`ml-3`). Minimize is not drawn --
    /// the main window passes `showMinimize={false}` -- and zoom is bound to
    /// expand/collapse rather than a real window zoom.
    ///
    /// Always colored, never the TSX's `#DCDCDC` inactive gray: that branch
    /// runs off `onFocusChanged`, and the shipping main window is a
    /// non-activating NSPanel whose webview never receives the event --
    /// measured on the real app, the lights stay colored while the app is
    /// inactive, so the gray state is dead code in practice. Hovering
    /// anywhere over the pair reveals both glyphs (`hovered` lives on the
    /// group container), and each button darkens itself on hover/press
    /// (`hover:brightness-95 active:brightness-90`).
    fn render_traffic_lights(&self, cx: &mut Context<Self>) -> impl IntoElement {
        // base, brightness(0.95), brightness(0.90) -- precomputed per light.
        let light = |base: u32,
                     hover: u32,
                     press: u32,
                     icon: &'static str,
                     icon_px: f32,
                     id: &'static str| {
            div()
                .id(id)
                .size(px(14.))
                .rounded_full()
                .flex()
                .items_center()
                .justify_center()
                .bg(rgb(base))
                .hover(move |style| style.bg(rgb(hover)))
                .active(move |style| style.bg(rgb(press)))
                .cursor_default()
                .child(
                    // `rgba(0, 0, 0, 0.5)` glyphs, close at 10px and zoom at
                    // 8px -- the inline SVG sizes in the TSX.
                    svg()
                        .path(icon)
                        .size(px(icon_px))
                        .text_color(gpui::rgba(0x0000_0080))
                        .invisible()
                        .group_hover("traffic-lights", |style| style.visible()),
                )
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .h_full()
            .ml(px(12.))
            .flex_shrink_0()
            .group("traffic-lights")
            .child(
                light(
                    Theme::TRAFFIC_CLOSE,
                    0xf25a53,
                    0xe6564e,
                    "icons/traffic-close.svg",
                    10.,
                    "traffic-close",
                )
                // `getCurrentWindow().close()` in `CaptionControlsMacOS`, which
                // reaches `CapWindowId::Main`'s `CloseRequested` arm -- and
                // that arm *prevents* the close and hides the window
                // (`lib.rs:5644-5697`). With the tray present, closing the main
                // window must not quit Cap. Deferred out of the listener: the
                // hide path touches the window registry and orders the NSWindow
                // out, neither of which may happen inside this update.
                .on_click(cx.listener(|_, _, _window, cx| {
                    cx.defer(crate::app_windows::request_close_main);
                })),
            )
            .child(
                light(
                    Theme::TRAFFIC_ZOOM,
                    0x26be3d,
                    0x24b43a,
                    "icons/traffic-zoom.svg",
                    8.,
                    "traffic-zoom",
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_expanded(window, cx);
                })),
            )
    }

    /// The teleported header content: a help button, a drag spacer, then the
    /// right-hand cluster. 20px hit targets (`size-5`) 4px apart (`gap-1`),
    /// 8px from the window edges (`mx-2`).
    fn render_header_actions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.expanded;

        // `IconButton::header`: a 20px hit box with no fill, `text-gray-11`
        // going to `text-gray-12` on hover.
        let icon_button = |id: &'static str, path: &'static str, size: f32| {
            let label = match id {
                "help" => "Help & Tour",
                "expand" if expanded => "Collapse",
                "expand" => "Expand",
                "settings" => "Settings",
                "screenshots" => "Screenshots",
                "recordings" => "Recordings",
                "teleprompter" => "Teleprompter",
                "changelog" => "Changelog",
                _ => unreachable!(),
            };
            div()
                .id(id)
                .group(id)
                .when(cfg!(target_os = "windows"), |this| this.occlude())
                .tab_index(0)
                .flex()
                .items_center()
                .justify_center()
                .size(px(20.))
                .flex_shrink_0()
                .rounded_full()
                .text_color(theme.gray_11)
                .hover(|style| style.text_color(theme.gray_12))
                .tooltip(move |_, cx| ui::Tooltip::new(&theme, label).view(cx))
                .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                .child(
                    svg()
                        .path(path)
                        .size(px(size))
                        .text_color(theme.gray_11)
                        .group_hover(id, |style| style.text_color(theme.gray_12)),
                )
        };

        let actions = div()
            .flex()
            .flex_1()
            .items_center()
            .gap(px(4.))
            .mx(px(8.))
            .min_w_0()
            .child(
                icon_button("help", "icons/circle-help.svg", 16.).on_click(cx.listener(
                    |_, _, _window, cx| {
                        cx.defer(app_windows::open_onboarding);
                    },
                )),
            )
            // Keep drag handlers off the header root: starting native dragging
            // on a button's mouse-down consumes its later click.
            .child(div().id("drag-region").flex_1().min_w_0().h_full().when(
                !cfg!(target_os = "windows"),
                |region| {
                    region.on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    })
                },
            ))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .flex_shrink_0()
                    .child(
                        icon_button(
                            "expand",
                            if expanded {
                                "icons/minimize.svg"
                            } else {
                                "icons/enlarge.svg"
                            },
                            14.,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.toggle_expanded(window, cx);
                        })),
                    )
                    .child(icon_button("settings", "icons/settings.svg", 16.).on_click(
                        cx.listener(|_, _, _window, cx| {
                            // `await commands.showWindow({ Settings: {
                            //  page: "general" } }); getCurrentWindow()
                            //  .hide()` -- both halves live in
                            // `open_settings`. Deferred because opening a
                            // window inside this update would double-lease
                            // the view (the `sync_overlays` rule).
                            cx.defer(|cx: &mut gpui::App| {
                                app_windows::open_settings(
                                    crate::settings_window::Page::General,
                                    cx,
                                )
                            });
                        }),
                    ))
                    .child(icon_button("screenshots", "icons/image.svg", 16.).on_click(
                        cx.listener(|this, _, window, cx| {
                            this.open_panel(Panel::Library(LibraryKind::Screenshots), window, cx);
                        }),
                    ))
                    .child(
                        icon_button("recordings", "icons/play-circle.svg", 16.).on_click(
                            cx.listener(|this, _, window, cx| {
                                this.open_panel(
                                    Panel::Library(LibraryKind::Recordings),
                                    window,
                                    cx,
                                );
                            }),
                        ),
                    )
                    .child(
                        icon_button("teleprompter", "icons/scan-text.svg", 16.).on_click(
                            cx.listener(|_, _, _window, cx| {
                                // `onClick={() => void openTeleprompter()}` on
                                // the header's `IconLucideScanText` button.
                                // Deferred for the same reason the gear is.
                                cx.defer(app_windows::open_teleprompter);
                            }),
                        ),
                    )
                    .child(
                        icon_button("changelog", "icons/bell.svg", 16.).on_click(cx.listener(
                            |_, _, _window, cx| {
                                cx.defer(|cx: &mut gpui::App| {
                                    app_windows::open_settings(Page::Changelog, cx)
                                });
                            },
                        )),
                    ),
            );

        #[cfg(target_os = "windows")]
        let actions = actions.h_full();

        actions
    }

    fn render_idle_error(&self, error: String, cx: &mut Context<Self>) -> impl IntoElement {
        let copy_error = error.clone();
        let shown_error = error.clone();

        div()
            .id("recording-error-panel")
            .flex()
            .flex_col()
            .flex_shrink_0()
            .min_w_0()
            .max_h(px(72.))
            .gap(px(4.))
            .overflow_hidden()
            .child(recording_error_text(error).text_color(self.theme.red_9))
            .child(
                div()
                    .flex()
                    .flex_shrink_0()
                    .justify_end()
                    .gap(px(6.))
                    .child(
                        ui::Button::body(
                            &self.theme,
                            "copy-recording-error",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Xs,
                        )
                        .label("Copy error")
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.write_to_clipboard(gpui::ClipboardItem::new_string(
                                copy_error.clone(),
                            ));
                        })),
                    )
                    .child(
                        ui::Button::body(
                            &self.theme,
                            "dismiss-recording-error",
                            ui::ButtonVariant::Gray,
                            ui::ButtonSize::Xs,
                        )
                        .label("Dismiss")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.session.update(cx, |session, cx| {
                                if clear_shown_idle_error(
                                    session.phase,
                                    &mut session.error,
                                    &shown_error,
                                ) {
                                    cx.notify();
                                }
                            });
                        })),
                    ),
            )
    }

    /// Page root: `px-[13px] gap-2 pb-[8px]`.
    fn render_body(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let root = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .px(px(13.))
            .pb(px(8.))
            .gap(px(8.))
            // `.cap-window-body { color: var(--macos-settings-text) }` under
            // panel glass; `--text-primary` otherwise.
            .text_color(self.theme.body_text());

        // The logo/mode row is hidden while a picker is open -- the panel takes
        // the full body, exactly as `!activeMenu() && ...` does in index.tsx.
        match self.panel {
            Some(panel) => root.child(self.render_panel(panel, cx)),
            None => root
                .child(self.render_logo_row(cx))
                .child(
                    // `flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-1
                    // w-full` -- expanded can overflow once Recents is in, so
                    // this column has to scroll.
                    div()
                        .id("home-scroll")
                        .flex()
                        .flex_col()
                        .flex_1()
                        .min_h_0()
                        .w_full()
                        .pb(px(4.))
                        .gap(px(8.))
                        .overflow_y_scroll()
                        .child(self.render_targets(cx))
                        .child(self.render_base_controls(cx))
                        .when(self.expanded, |this| this.child(self.render_recents())),
                )
                // A failed start has nowhere else to surface: the overlays are
                // gone by then and the bar closed itself.
                .when_some(
                    self.session
                        .read(cx)
                        .error
                        .clone()
                        .filter(|_| self.session.read(cx).phase == Phase::Idle),
                    |this, error| this.child(self.render_idle_error(error, cx)),
                ),
        }
    }

    /// The recording takeover, from index.tsx 3510-3529: an absolute overlay
    /// (`bg-gray-1/80 backdrop-blur-xs` -- the blur is skipped here, this gpui
    /// rev has no per-element backdrop blur hook) with the Stop button pinned
    /// to the bottom (`px-6 pb-8`, `h-11 rounded-xl bg-red-9`).
    fn render_recording_overlay(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let phase = self.session.read(cx).phase;
        let stopping = phase == Phase::Stopping;
        let starting = phase == Phase::Starting;
        #[cfg(target_os = "linux")]
        let can_resume = clean_capture_resume_available(
            phase,
            app_windows::clean_capture_active(cx),
            self.session.read(cx).clean_capture_controls_safe(),
        );
        #[cfg(not(target_os = "linux"))]
        let can_resume = false;

        let mut wash: Hsla = theme.gray_1.into();
        wash.a = 0.8;

        div()
            .absolute()
            .inset_0()
            .rounded(px(16.))
            .flex()
            .flex_col()
            .justify_end()
            .px(px(24.))
            .pb(px(32.))
            .bg(wash)
            .when_some(self.session.read(cx).error.clone(), |this, error| {
                this.child(
                    div()
                        .flex_shrink_0()
                        .mb(px(8.))
                        .text_size(px(11.))
                        .text_color(theme.red_9)
                        .text_center()
                        .child(error),
                )
            })
            .when(can_resume, |this| {
                this.child(
                    div()
                        .mb(px(12.))
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .text_size(px(12.))
                        .child("Recording paused. Cap will hide before resuming.")
                        .child(
                            div()
                                .id("resume-clean-recording")
                                .h(px(36.))
                                .w_full()
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(8.))
                                .border_1()
                                .border_color(theme.gray_5)
                                .bg(theme.gray_3)
                                .child("Resume")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    #[cfg(target_os = "linux")]
                                    {
                                        let session = this.session.clone();
                                        cx.defer(move |cx| {
                                            if clean_capture_resume_available(
                                                session.read(cx).phase,
                                                app_windows::clean_capture_active(cx),
                                                session.read(cx).clean_capture_controls_safe(),
                                            ) {
                                                session.update(cx, |session, cx| {
                                                    session.toggle_pause(cx)
                                                });
                                            }
                                        });
                                    }
                                    #[cfg(not(target_os = "linux"))]
                                    let _ = (this, cx);
                                })),
                        ),
                )
            })
            .child(
                div()
                    .id("stop-recording")
                    .h(px(44.))
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .rounded(px(12.))
                    .bg(theme.red_9)
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(gpui::white())
                    // `disabled:opacity-60` while pending.
                    .when(stopping || starting, |this| this.opacity(0.6))
                    .when(!stopping && !starting, |this| {
                        this.hover(|style| style.bg(theme.red_10))
                            .on_click(cx.listener(|this, _, _window, cx| {
                                this.session.update(cx, |session, cx| session.stop(cx));
                            }))
                    })
                    .child(
                        svg()
                            .path("icons/stop-circle.svg")
                            .size(px(16.))
                            .text_color(gpui::white()),
                    )
                    .child(match phase {
                        Phase::Starting => "Starting...",
                        Phase::Stopping => "Stopping...",
                        _ => "Stop Recording",
                    }),
            )
    }

    /// Shared panel chrome: a Back button, then either a title or a search
    /// field, then a scrolling body. `TargetMenuPanel` and `ModeInfoPanel` in
    /// the Tauri app are the same shape, so they share one implementation here.
    fn render_panel(&self, panel: Panel, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;

        // Mode info has a static title where the target and device panels put a
        // search field.
        let header_trailing = match panel {
            Panel::ModeInfo => div()
                .flex_1()
                .min_w_0()
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.gray_11)
                .child("Recording Modes")
                .into_any_element(),
            Panel::Library(kind) => self.render_library_header(kind, cx).into_any_element(),
            Panel::Device(_) if self.device_format_target.is_some() => div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_size(px(12.))
                .text_color(theme.gray_11)
                .child(match self.device_format_target.as_ref().unwrap() {
                    DeviceFormatTarget::Camera(camera) => camera.label.clone(),
                    DeviceFormatTarget::Microphone(name) => name.clone(),
                })
                .into_any_element(),
            Panel::Device(_) | Panel::Target(_) => self.render_search_field(cx).into_any_element(),
        };

        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .mt(px(12.))
                    // `min-h-[36px]`.
                    .h(px(36.))
                    .flex_shrink_0()
                    .child(
                        div()
                            .id("panel-back")
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .h(px(36.))
                            .px(px(8.))
                            .flex_shrink_0()
                            .rounded(px(6.))
                            .text_size(px(12.))
                            .text_color(theme.gray_11)
                            .child(
                                svg()
                                    .path("icons/move-left.svg")
                                    .size(px(12.))
                                    .text_color(theme.gray_11),
                            )
                            .child(
                                div()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.gray_12)
                                    .child("Back"),
                            )
                            .hover(|style| style.bg(theme.body_hover_fill(4)))
                            .on_click(cx.listener(|this, _, _window, cx| this.back_panel(cx))),
                    )
                    .child(header_trailing),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .pt(px(16.))
                    .overflow_hidden()
                    .child(
                        div()
                            .id("panel-body")
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_h_0()
                            .px(px(8.))
                            .gap(px(8.))
                            .overflow_y_scroll()
                            .child(match panel {
                                Panel::Device(menu) => {
                                    self.render_device_list(menu, cx).into_any_element()
                                }
                                Panel::Target(target) => {
                                    self.render_target_grid(target, cx).into_any_element()
                                }
                                Panel::ModeInfo => self.render_mode_info(cx).into_any_element(),
                                Panel::Library(kind) => {
                                    self.render_library_grid(kind, cx).into_any_element()
                                }
                            }),
                    ),
            )
    }

    fn close_panel(&mut self, cx: &mut Context<Self>) {
        self.device_format_target = None;
        self.device_formats = None;
        self.device_format_generation += 1;
        self.panel = None;
        self.search.clear();
        self.search_input
            .update(cx, |input, cx| input.set_text("", cx));
        self.library_task = None;
        // `enabled: displayMenuOpen()` / `windowMenuOpen()` -- nothing polls
        // and nothing captures while no picker is on screen. A sweep already in
        // flight is left to land, the way a TanStack refetch is.
        self.target_poll_task = None;
        cx.notify();
    }

    fn back_panel(&mut self, cx: &mut Context<Self>) {
        if self.device_format_target.take().is_some() {
            self.device_formats = None;
            self.device_format_generation += 1;
            cx.notify();
        } else {
            self.close_panel(cx);
        }
    }

    pub(crate) fn show_recorder(&mut self, cx: &mut Context<Self>) {
        if self.panel.is_some() {
            self.close_panel(cx);
        }
    }

    fn dismiss_main(&mut self, cx: &mut Context<Self>) -> bool {
        if self.microphone_warning.is_some() {
            self.dismiss_microphone_warning(cx);
        } else if self.mode_hover.visible.is_some() {
            self.clear_mode_hover();
            cx.notify();
        } else if self.panel.is_some() {
            if self.search.is_empty() {
                self.back_panel(cx);
            } else {
                self.clear_search(cx);
            }
        } else if self.session.read(cx).editor_recording_target().is_some() {
            self.cancel_deep_link_start();
            cx.defer(app_windows::abort_editor_recording_flow);
        } else {
            return false;
        }
        true
    }

    pub fn open_panel(&mut self, panel: Panel, window: &mut Window, cx: &mut Context<Self>) {
        self.clear_mode_hover();
        self.device_format_target = None;
        self.device_formats = None;
        self.device_format_generation += 1;
        self.panel = Some(panel);
        self.search.clear();
        self.search_input
            .update(cx, |input, cx| input.set_text("", cx));
        if matches!(
            panel,
            Panel::Device(_) | Panel::Target(_) | Panel::Library(_)
        ) {
            let focus = self.search_input.read(cx).focus_handle();
            window.focus(&focus, cx);
        }
        if let Panel::Library(kind) = panel {
            self.refresh_library(kind, window, cx);
        } else {
            self.library_task = None;
        }
        // Opening a target picker re-reads the list immediately and then keeps
        // it fresh -- until this, the grid showed whatever `start_enumeration`
        // found at launch, so a window opened since was simply missing.
        match panel {
            Panel::Target(kind) => self.start_target_poll(kind, window, cx),
            _ => self.target_poll_task = None,
        }
        cx.notify();
    }

    /// The panel filter -- `ui::TextInput::search`.
    ///
    /// A real field now: caret movement, selection, click-to-position,
    /// double-click-a-word, the clipboard and undo all come from
    /// `TextInputState`. What stays here is the only part the component cannot
    /// know, which is that Escape clears the filter before it closes the panel.
    fn render_search_field(&self, cx: &mut Context<Self>) -> gpui::Div {
        self.search_input
            .update(cx, |input, _| input.set_placeholder("Search"));

        div().flex().flex_1().min_w_0().child(ui::TextInput::search(
            &self.theme,
            "panel-search",
            &self.search_input,
        ))
    }

    fn render_library_header(&self, kind: LibraryKind, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        div()
            .flex()
            .flex_1()
            .min_w_0()
            .gap(px(8.))
            .items_center()
            .child(self.render_search_field(cx))
            .child(
                ui::Button::plain(
                    &theme,
                    "library-import",
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Sm,
                )
                .label(kind.import_label())
                .icon("icons/import.svg")
                .height(px(36.))
                .on_click(cx.listener(move |_, _, _window, cx| {
                    // `importVideoFromPicker` / `importImageFromPicker`
                    // (`utils/importMedia.ts:58-86`). Deferred out of the
                    // listener because the picker task must start with a
                    // clean App borrow, like every other panel opener.
                    cx.defer(move |cx| match kind {
                        LibraryKind::Recordings => crate::import::pick_and_import_video(cx),
                        LibraryKind::Screenshots => crate::import::pick_and_import_image(cx),
                    });
                })),
            )
    }

    /// Re-scan whichever library panel is open -- the import pipeline's
    /// refresh seam: a finished import has to land in the panel the user is
    /// probably watching it from.
    pub fn refresh_open_library(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(Panel::Library(kind)) = self.panel {
            self.refresh_library(kind, window, cx);
        }
        cx.notify();
    }

    fn refresh_library(&mut self, kind: LibraryKind, window: &mut Window, cx: &mut Context<Self>) {
        self.library_task = Some(cx.spawn_in(window, async move |this, cx| {
            let (recordings, screenshots) = cx
                .background_executor()
                .spawn(async move {
                    match kind {
                        LibraryKind::Recordings => {
                            let mut items = library::list_recordings();
                            items.truncate(library::LIBRARY_PANEL_LIMIT);
                            (Some(items), None)
                        }
                        LibraryKind::Screenshots => {
                            let mut items = library::list_screenshots();
                            items.truncate(library::LIBRARY_PANEL_LIMIT);
                            (None, Some(items))
                        }
                    }
                })
                .await;

            let thumbnails = match this.update_in(cx, |this, window, cx| {
                this.set_library(kind, recordings, screenshots, window, cx)
            }) {
                Ok(thumbnails) => thumbnails,
                Err(_) => return,
            };

            let (_decodes, results) = library::spawn_decode_pool(
                cx.background_executor(),
                thumbnails,
                |(index, path)| library::decode_thumbnail(&path).map(|image| (index, path, image)),
            );
            while let Ok(first) = results.recv_async().await {
                let mut batch = vec![first];
                batch.extend(results.try_iter());
                if this
                    .update_in(cx, |this, window, cx| {
                        for (index, path, image) in batch {
                            this.set_library_thumbnail(kind, index, path, image, window, cx);
                        }
                    })
                    .is_err()
                {
                    return;
                }
            }
        }));
    }

    fn set_library(
        &mut self,
        kind: LibraryKind,
        recordings: Option<Vec<RecordingItem>>,
        screenshots: Option<Vec<ScreenshotItem>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<(usize, std::path::PathBuf)> {
        self.drop_library_images(window);
        let mut pending = Vec::new();
        self.library = Some(match kind {
            LibraryKind::Recordings => LibraryItems::Recordings(
                recordings
                    .unwrap_or_default()
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| {
                        if let Some(path) = item.thumbnail.clone() {
                            pending.push((index, path));
                        }
                        LibraryRow {
                            item,
                            thumbnail: None,
                        }
                    })
                    .collect(),
            ),
            LibraryKind::Screenshots => LibraryItems::Screenshots(
                screenshots
                    .unwrap_or_default()
                    .into_iter()
                    .enumerate()
                    .map(|(index, item)| {
                        if let Some(path) = item.thumbnail.clone() {
                            pending.push((index, path));
                        }
                        LibraryRow {
                            item,
                            thumbnail: None,
                        }
                    })
                    .collect(),
            ),
        });
        cx.notify();
        window.refresh();
        pending
    }

    fn set_library_thumbnail(
        &mut self,
        kind: LibraryKind,
        index: usize,
        path: std::path::PathBuf,
        image: std::sync::Arc<gpui::RenderImage>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let replaced = match (&mut self.library, kind) {
            (Some(LibraryItems::Recordings(rows)), LibraryKind::Recordings) => rows
                .get_mut(index)
                .filter(|row| row.item.thumbnail.as_deref() == Some(path.as_path()))
                .and_then(|row| row.thumbnail.replace(image)),
            (Some(LibraryItems::Screenshots(rows)), LibraryKind::Screenshots) => rows
                .get_mut(index)
                .filter(|row| row.item.thumbnail.as_deref() == Some(path.as_path()))
                .and_then(|row| row.thumbnail.replace(image)),
            _ => None,
        };
        if let Some(old) = replaced {
            let _ = window.drop_image(old);
        }
        cx.notify();
        window.refresh();
    }

    fn drop_library_images(&mut self, window: &mut Window) {
        match self.library.take() {
            Some(LibraryItems::Recordings(rows)) => {
                for row in rows {
                    if let Some(image) = row.thumbnail {
                        let _ = window.drop_image(image);
                    }
                }
            }
            Some(LibraryItems::Screenshots(rows)) => {
                for row in rows {
                    if let Some(image) = row.thumbnail {
                        let _ = window.drop_image(image);
                    }
                }
            }
            None => {}
        }
    }

    fn render_library_grid(&self, kind: LibraryKind, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let grid = div().flex().flex_col().gap(px(8.)).w_full();

        if self.library.is_none() {
            let mut skeletons = Vec::new();
            for _ in 0..4 {
                skeletons.push(
                    div()
                        .flex_1()
                        .min_w_0()
                        .h(px(128.))
                        .rounded(px(8.))
                        .bg(theme.body_fill(3))
                        .into_any_element(),
                );
            }
            return grid.children(skeletons.chunks_mut(2).map(|pair| {
                let mut row = div().flex().flex_row().gap(px(8.)).w_full();
                for card in pair.iter_mut() {
                    row = row.child(std::mem::replace(card, div().into_any_element()));
                }
                if pair.len() == 1 {
                    row = row.child(div().flex_1());
                }
                row
            }));
        }

        let mut cards: Vec<gpui::AnyElement> = Vec::new();
        // Running imports lead the grid they will land in, the way an
        // in-progress recording leads the Tauri recordings list.
        for (index, entry) in crate::import::imports_snapshot(cx).iter().enumerate() {
            let wanted = match kind {
                LibraryKind::Recordings => entry.kind == crate::import::ImportKind::Video,
                LibraryKind::Screenshots => entry.kind == crate::import::ImportKind::Image,
            };
            if wanted {
                cards.push(self.render_import_card(index, entry).into_any_element());
            }
        }
        match (kind, &self.library) {
            (LibraryKind::Recordings, Some(LibraryItems::Recordings(rows))) => {
                for (index, row) in rows.iter().enumerate() {
                    if !self.matches_search(&row.item.pretty_name) {
                        continue;
                    }
                    cards.push(
                        self.render_recording_card(index, row, cx)
                            .into_any_element(),
                    );
                }
            }
            (LibraryKind::Screenshots, Some(LibraryItems::Screenshots(rows))) => {
                for (index, row) in rows.iter().enumerate() {
                    if !self.matches_search(&row.item.pretty_name) {
                        continue;
                    }
                    cards.push(
                        self.render_screenshot_card(index, row, cx)
                            .into_any_element(),
                    );
                }
            }
            _ => {}
        }

        if cards.is_empty() {
            return grid.child(self.render_library_empty(kind, cx));
        }

        let view_all = kind.view_all_label();
        let page = kind.settings_page();
        cards.push(
            div()
                .id("library-view-all")
                .flex()
                .flex_1()
                .min_w_0()
                .h(px(76.))
                .items_center()
                .justify_center()
                .rounded(px(8.))
                .border_1()
                .border_color(theme.body_border(5))
                .bg(theme.body_fill(3))
                .text_size(px(12.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(theme.gray_12)
                .cursor_pointer()
                .hover(|style| style.bg(theme.body_hover_fill(4)))
                .child(view_all)
                .on_click(cx.listener(move |_, _, _window, cx| {
                    cx.defer(move |cx| app_windows::open_settings(page, cx));
                }))
                .into_any_element(),
        );

        grid.children(cards.chunks_mut(2).map(|pair| {
            let mut row = div().flex().flex_row().gap(px(8.)).w_full().items_stretch();
            for card in pair.iter_mut() {
                row = row.child(std::mem::replace(card, div().into_any_element()));
            }
            if pair.len() == 1 {
                row = row.child(div().flex_1());
            }
            row
        }))
    }

    fn render_library_empty(&self, kind: LibraryKind, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let searching = !self.search.is_empty();
        let page = kind.settings_page();
        div()
            .flex()
            .flex_col()
            .w_full()
            .items_center()
            .justify_center()
            .gap(px(8.))
            .py(px(32.))
            .child(
                svg()
                    .path(kind.empty_icon())
                    .size(px(20.))
                    .text_color(theme.gray_10),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_12)
                    .child(if searching {
                        kind.no_match()
                    } else {
                        kind.empty_title()
                    }),
            )
            .when(!searching, |this| {
                this.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.gray_11)
                        .text_center()
                        .child(kind.empty_description()),
                )
                .child(
                    ui::Button::plain(
                        &theme,
                        "library-view-all-empty",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Sm,
                    )
                    .label(kind.view_all_label())
                    .on_click(cx.listener(move |_, _, _window, cx| {
                        cx.defer(move |cx| app_windows::open_settings(page, cx));
                    })),
                )
            })
    }

    /// The importing card: `ImportProgress.tsx`'s ring drawn in the library
    /// card's shell, with the clips-badge pill relabelled "Importing" -- the
    /// same look the library's in-progress recordings wear.
    fn render_import_card(
        &self,
        index: usize,
        entry: &crate::import::ImportProgress,
    ) -> impl IntoElement {
        let theme = self.theme;
        let converting = entry.stage == crate::import::ImportStage::Converting;
        let ring = {
            let ring =
                ui::CircularProgress::new(px(36.), px(3.), theme.gray(4), theme.blue_9.into());
            if converting {
                ring.progress(entry.progress as f32)
                    .label(theme.gray_12.into(), px(9.))
            } else {
                ring.indeterminate()
            }
        };

        div()
            .id(("library-importing", index))
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .rounded(px(8.))
            .bg(theme.body_fill(3))
            .child(
                div()
                    .relative()
                    .w_full()
                    .h(px(76.))
                    .rounded_t(px(8.))
                    .overflow_hidden()
                    .bg(theme.body_fill(4))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(ring)
                    .child(
                        div()
                            .absolute()
                            .left(px(4.))
                            .top(px(4.))
                            .rounded_full()
                            .bg(black_alpha(0.55))
                            .px(px(6.))
                            .py(px(2.))
                            .text_size(px(10.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui::white())
                            .child("Importing"),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .min_w_0()
                    .px(px(8.))
                    .py(px(6.))
                    .pb(px(10.))
                    .text_size(px(11.))
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_12)
                            .child(entry.pretty_name.clone()),
                    )
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .text_color(theme.gray_11)
                            .child(entry.message.clone()),
                    ),
            )
    }

    fn render_recording_card(
        &self,
        index: usize,
        row: &LibraryRow<RecordingItem>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let item = &row.item;
        let path = item.path.clone();
        let studio = item.mode == library::RecordingMode::Studio;
        let sharing = item.sharing.clone();
        let mode = item.mode;
        let opens_editor = item.opens_editor();
        let subtitle = item.upload.as_ref().map_or_else(
            || item.mode.label().to_string(),
            |upload| {
                upload
                    .last_error
                    .clone()
                    .unwrap_or_else(|| upload.label().to_string())
            },
        );
        let actions = self.render_recording_card_actions(index, item, cx);

        self.library_card(
            ("library-recording", index),
            row.thumbnail.clone(),
            "icons/square-play.svg",
            item.pretty_name.clone(),
            Some(subtitle),
            item.clip_count,
            cx.listener(move |_, _, _window, cx| {
                if studio && opens_editor {
                    let path = path.clone();
                    cx.defer(move |cx| app_windows::open_editor(path, cx));
                } else if !studio && let Some(url) = &sharing {
                    cx.open_url(url);
                } else if !studio {
                    library::open_recording_folder(&path, mode);
                }
            }),
            actions,
            theme,
        )
    }

    fn render_recording_card_actions(
        &self,
        index: usize,
        item: &RecordingItem,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let path = item.path.clone();
        let mode = item.mode;
        let sharing = item.sharing.clone();
        let mut row = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(8.))
            .pb(px(6.))
            .gap(px(4.));
        if item.opens_editor() {
            let editor = path.clone();
            row = row.child(self.library_action(
                ("lib-rec-edit", index),
                "icons/edit.svg",
                cx.listener(move |_, _, _window, cx| {
                    let editor = editor.clone();
                    cx.defer(move |cx| app_windows::open_editor(editor, cx));
                }),
            ));
        }
        if let Some(url) = sharing {
            row = row.child(self.library_action(
                ("lib-rec-link", index),
                "icons/link.svg",
                move |_, _, cx| cx.open_url(&url),
            ));
        }
        if item
            .upload
            .as_ref()
            .is_some_and(crate::upload::queue::UploadState::can_retry)
        {
            let retry_path = path.clone();
            row = row.child(self.library_action(
                ("lib-rec-retry", index),
                "icons/rotate-ccw.svg",
                cx.listener(move |_, _, window, cx| {
                    let path = retry_path.clone();
                    cx.spawn_in(window, async move |this, cx| {
                        let Ok(task) = cx.update(|_, cx| {
                            gpui_tokio::Tokio::spawn(cx, crate::upload::queue::retry(path))
                        }) else {
                            return;
                        };
                        if let Err(error) =
                            task.await.unwrap_or_else(|error| Err(error.to_string()))
                        {
                            tracing::warn!(%error, "Upload retry deferred");
                        }
                        let _ = this.update_in(cx, |this, window, cx| {
                            this.refresh_open_library(window, cx)
                        });
                    })
                    .detach();
                }),
            ));
        }
        let folder = path.clone();
        row = row.child(self.library_action(
            ("lib-rec-folder", index),
            "icons/folder.svg",
            move |_, _, _| library::open_recording_folder(&folder, mode),
        ));
        row.child(self.library_action(
            ("lib-rec-delete", index),
            "icons/trash.svg",
            cx.listener(move |this, _, window, cx| {
                this.delete_library_recording(path.clone(), window, cx);
            }),
        ))
    }

    fn render_screenshot_card(
        &self,
        index: usize,
        row: &LibraryRow<ScreenshotItem>,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let item = &row.item;
        let png = item.path.clone();
        let actions = self.render_screenshot_card_actions(index, item, cx);
        self.library_card(
            ("library-screenshot", index),
            row.thumbnail.clone(),
            "icons/image.svg",
            item.pretty_name.clone(),
            None,
            0,
            move |_, _, cx| {
                let png = png.clone();
                cx.defer(move |cx| app_windows::open_screenshot_editor(png, cx));
            },
            actions,
            theme,
        )
    }

    fn render_screenshot_card_actions(
        &self,
        index: usize,
        item: &ScreenshotItem,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let png = item.path.clone();
        let name = item.pretty_name.clone();
        let bundle = item.bundle.clone();
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .px(px(8.))
            .pb(px(6.))
            .gap(px(4.))
            .child(
                self.library_action(("lib-ss-copy", index), "icons/copy.svg", {
                    let png = png.clone();
                    move |_, _, _| {
                        if let Err(error) = crate::platform::copy_image_to_clipboard(&png) {
                            tracing::warn!("copying screenshot failed: {error}");
                        }
                    }
                }),
            )
            .child(self.library_action(
                ("lib-ss-save", index),
                "icons/download.svg",
                cx.listener(move |this, _, window, cx| {
                    this.save_screenshot(png.clone(), name.clone(), window, cx);
                }),
            ))
            .child(
                self.library_action(("lib-ss-open", index), "icons/folder.svg", {
                    let bundle = bundle.clone();
                    move |_, _, _| library::reveal_in_folder(&bundle)
                }),
            )
            .child(self.library_action(
                ("lib-ss-delete", index),
                "icons/trash.svg",
                cx.listener(move |this, _, window, cx| {
                    this.delete_library_screenshot(bundle.clone(), window, cx);
                }),
            ))
    }

    fn library_action(
        &self,
        id: impl Into<gpui::ElementId>,
        icon: &'static str,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .id(id)
            .flex_1()
            .flex()
            .items_center()
            .justify_center()
            .p(px(4.))
            .rounded(px(4.))
            .text_color(theme.gray_11)
            .cursor_pointer()
            .hover(|style| style.bg(theme.body_hover_fill(5)).text_color(theme.gray_12))
            .child(svg().path(icon).size(px(14.)).text_color(theme.gray_11))
            .on_click(on_click)
    }

    #[allow(clippy::too_many_arguments)]
    fn library_card(
        &self,
        id: impl Into<gpui::ElementId>,
        thumbnail: Option<std::sync::Arc<gpui::RenderImage>>,
        fallback: &'static str,
        label: String,
        subtitle: Option<String>,
        clip_count: u32,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
        actions: impl IntoElement,
        theme: Theme,
    ) -> impl IntoElement {
        let thumb = match thumbnail {
            Some(image) => {
                use gpui::StyledImage as _;
                img(image)
                    .size_full()
                    .rounded_t(px(8.))
                    .object_fit(gpui::ObjectFit::Cover)
                    .into_any_element()
            }
            None => div()
                .rounded_t(px(8.))
                .flex()
                .size_full()
                .items_center()
                .justify_center()
                .bg(theme.body_fill(4))
                .child(svg().path(fallback).size(px(24.)).text_color(theme.gray_9))
                .into_any_element(),
        };

        div()
            .id(id)
            .flex()
            .flex_col()
            .flex_1()
            .min_w_0()
            .overflow_hidden()
            .rounded(px(8.))
            .bg(theme.body_fill(3))
            .hover(|style| style.bg(theme.body_hover_fill(4)))
            .child(
                div()
                    .id("library-card-open")
                    .cursor_pointer()
                    .child(
                        div()
                            .relative()
                            .w_full()
                            .h(px(76.))
                            .rounded_t(px(8.))
                            .overflow_hidden()
                            .bg(theme.body_fill(4))
                            .child(thumb)
                            .when(clip_count > 1, |this| {
                                this.child(
                                    div()
                                        .absolute()
                                        .left(px(4.))
                                        .top(px(4.))
                                        .rounded_full()
                                        .bg(black_alpha(0.55))
                                        .px(px(6.))
                                        .py(px(2.))
                                        .text_size(px(10.))
                                        .font_weight(FontWeight::MEDIUM)
                                        .text_color(gpui::white())
                                        .child(format!("{clip_count} clips")),
                                )
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .w_full()
                            .min_w_0()
                            .px(px(8.))
                            .py(px(6.))
                            .text_size(px(11.))
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(theme.gray_12)
                                    .child(label),
                            )
                            .children(subtitle.map(|subtitle| {
                                div()
                                    .w_full()
                                    .truncate()
                                    .text_color(theme.gray_11)
                                    .child(subtitle)
                            })),
                    )
                    .on_click(on_click),
            )
            .child(actions)
    }

    fn delete_library_recording(
        &mut self,
        path: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.spawn_in(window, async move |this, cx| {
            if !crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this recording?",
                "Yes",
                "No",
                false,
            ) {
                return;
            }
            let Ok(task) = cx.update(|_, cx| {
                gpui_tokio::Tokio::spawn(cx, crate::upload::queue::delete_recording(path.clone()))
            }) else {
                return;
            };
            let deleted = task.await.unwrap_or_else(|error| Err(error.to_string()));
            if let Err(error) = deleted {
                tracing::error!(path = %path.display(), "deleting the recording failed: {error}");
                return;
            }
            this.update_in(cx, |this, window, cx| {
                this.refresh_library(LibraryKind::Recordings, window, cx);
                this.refresh_recents(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn delete_library_screenshot(
        &mut self,
        bundle: std::path::PathBuf,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.spawn_in(window, async move |this, cx| {
            if !crate::platform::confirm_dialog(
                "Cap",
                "Are you sure you want to delete this screenshot?",
                "Yes",
                "No",
                false,
            ) {
                return;
            }
            let deleted = cx
                .background_executor()
                .spawn({
                    let bundle = bundle.clone();
                    async move { library::delete_screenshot(&bundle) }
                })
                .await;
            if let Err(error) = deleted {
                tracing::error!(path = %bundle.display(), "deleting the screenshot failed: {error}");
                return;
            }
            this.update_in(cx, |this, window, cx| {
                this.refresh_library(LibraryKind::Screenshots, window, cx);
                this.refresh_recents(window, cx);
            })
            .ok();
        })
        .detach();
    }

    fn save_screenshot(
        &mut self,
        src: std::path::PathBuf,
        name: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        cx.spawn_in(window, async move |_this, _cx| {
            let dest = crate::platform::save_file_panel(&format!("{name}.png"), &["png"]);
            let Some(dest) = dest else {
                return;
            };
            if let Err(error) = library::copy_file_to_path(&src, &dest) {
                tracing::error!("saving screenshot failed: {error}");
            }
        })
        .detach();
    }

    /// Case-insensitive substring match, the same test the Tauri panels filter
    /// on before they highlight the matched run.
    fn matches_search(&self, haystack: &str) -> bool {
        if self.search.is_empty() {
            return true;
        }
        haystack
            .to_lowercase()
            .contains(&self.search.to_lowercase())
    }

    /// The filter field's own events. Escape is the panel's, not the field's:
    /// the first one clears the filter, a second one leaves -- which is why
    /// `TextInputState` emits `Cancelled` instead of deciding.
    fn on_search_event(
        &mut self,
        input: Entity<ui::TextInputState>,
        event: &ui::TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            ui::TextInputEvent::Changed => {
                self.search = input.read(cx).text().to_string();
                cx.notify();
            }
            ui::TextInputEvent::Cancelled => {
                self.dismiss_main(cx);
            }
            _ => {}
        }
    }

    fn clear_search(&mut self, cx: &mut Context<Self>) {
        self.search.clear();
        self.search_input
            .update(cx, |input, cx| input.set_text("", cx));
        cx.notify();
    }

    fn render_device_list(&self, menu: DeviceMenu, cx: &mut Context<Self>) -> gpui::Div {
        if self.device_format_target.is_some() {
            return self.render_device_formats(menu, cx);
        }
        let theme = self.theme;
        let list = div().flex().flex_col().gap(px(4.)).w_full();

        if self.enumerating {
            return list.child(
                div()
                    .py(px(24.))
                    .w_full()
                    .text_size(px(14.))
                    .text_color(theme.gray_11)
                    .child("Loading..."),
            );
        }

        // The "none" row is always offered and is never filtered out -- it is
        // how you turn the device off, not a search result.
        let mut rows = vec![
            self.render_device_list_row(
                SharedString::from(format!("{}-none", menu.title())),
                "icons/circle-x.svg",
                menu.none_label().to_string(),
                None,
                match menu {
                    DeviceMenu::Camera => self.camera.is_none(),
                    DeviceMenu::Microphone => self.microphone.is_none(),
                },
                None,
                cx.listener(move |this, _, _window, cx| {
                    if !this.device_changes_allowed(cx) {
                        return;
                    }
                    match menu {
                        DeviceMenu::Camera => {
                            this.set_camera_selection(None, cx);
                        }
                        DeviceMenu::Microphone => {
                            this.set_microphone_selection(None, cx);
                        }
                    }
                    this.close_panel(cx);
                }),
            )
            .into_any_element(),
        ];

        let mut matched = 0usize;
        match menu {
            DeviceMenu::Camera => {
                for camera in self
                    .devices
                    .cameras
                    .iter()
                    .filter(|camera| self.matches_search(&camera.label))
                {
                    matched += 1;
                    let selected = self
                        .camera
                        .as_ref()
                        .is_some_and(|selected| selected.device_id == camera.device_id);
                    let chosen = camera.clone();

                    rows.push(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(4.))
                            .w_full()
                            .child(
                                self.render_device_list_row(
                                    SharedString::from(format!("camera-{}", camera.device_id)),
                                    menu.icon(),
                                    camera.label.clone(),
                                    if selected {
                                        Feeds::global(cx)
                                            .read(cx)
                                            .applied_device_settings()
                                            .camera
                                            .map(|settings| DeviceFormat::Camera(settings).label())
                                    } else {
                                        camera.best_format.map(|format| {
                                            format!("Available: {}", format.describe())
                                        })
                                    },
                                    selected,
                                    None,
                                    cx.listener(move |this, _, _window, cx| {
                                        if !this.device_changes_allowed(cx) {
                                            return;
                                        }
                                        this.set_camera_selection(Some(chosen.clone()), cx);
                                        this.close_panel(cx);
                                    }),
                                )
                                .flex_1()
                                .min_w_0(),
                            )
                            .child(self.render_device_format_button(
                                DeviceFormatTarget::Camera(camera.clone()),
                                cx,
                            ))
                            .into_any_element(),
                    );
                }
            }
            DeviceMenu::Microphone => {
                for mic in self
                    .devices
                    .microphones
                    .iter()
                    .filter(|mic| self.matches_search(&mic.name))
                {
                    matched += 1;
                    let selected = self
                        .microphone
                        .as_ref()
                        .is_some_and(|selected| selected.name == mic.name);
                    let chosen = mic.clone();

                    rows.push(
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(4.))
                            .w_full()
                            .child(
                                self.render_device_list_row(
                                    SharedString::from(format!("mic-{}", mic.name)),
                                    menu.icon(),
                                    mic.name.clone(),
                                    if selected {
                                        Feeds::global(cx)
                                            .read(cx)
                                            .applied_device_settings()
                                            .microphone
                                            .map(|settings| {
                                                DeviceFormat::Microphone(settings).label()
                                            })
                                    } else {
                                        mic.describe()
                                            .map(|description| format!("Available: {description}"))
                                    },
                                    selected,
                                    selected.then(|| {
                                        feeds::picker_level(Feeds::global(cx).read(cx).mic_level_db)
                                    }),
                                    cx.listener(move |this, _, _window, cx| {
                                        if !this.device_changes_allowed(cx) {
                                            return;
                                        }
                                        this.set_microphone_selection(Some(chosen.clone()), cx);
                                        this.close_panel(cx);
                                    }),
                                )
                                .flex_1()
                                .min_w_0(),
                            )
                            .child(self.render_device_format_button(
                                DeviceFormatTarget::Microphone(mic.name.clone()),
                                cx,
                            ))
                            .into_any_element(),
                    );
                }
            }
        }

        if matched == 0 {
            rows.push(self.render_empty_state(menu.empty_message(!self.search.is_empty())));
        }

        list.children(rows)
    }

    fn open_device_formats(&mut self, target: DeviceFormatTarget, cx: &mut Context<Self>) {
        if !self.device_changes_allowed(cx) {
            return;
        }
        self.device_format_generation += 1;
        let generation = self.device_format_generation;
        self.device_format_value = Some(match &target {
            DeviceFormatTarget::Camera(camera) => DeviceFormat::Camera(
                crate::store::RecordingDeviceSettings::for_camera(
                    &camera.device_id,
                    camera.model_id.as_ref(),
                )
                .unwrap_or_default(),
            ),
            DeviceFormatTarget::Microphone(name) => DeviceFormat::Microphone(
                crate::store::RecordingDeviceSettings::for_microphone(name).unwrap_or_default(),
            ),
        });
        self.device_format_target = Some(target.clone());
        self.device_format_notice = None;
        self.device_formats = match &target {
            DeviceFormatTarget::Camera(camera) => Some(Ok(std::iter::once(DeviceFormat::Camera(
                Default::default(),
            ))
            .chain(
                camera
                    .formats
                    .iter()
                    .map(|format| DeviceFormat::Camera(format.settings())),
            )
            .collect())),
            DeviceFormatTarget::Microphone(_) => None,
        };
        if let DeviceFormatTarget::Microphone(name) = target {
            cx.spawn(async move |this, cx| {
                let formats = cx
                    .background_executor()
                    .spawn(async move {
                        devices::microphone_formats(&name).map(|formats| {
                            std::iter::once(DeviceFormat::Microphone(Default::default()))
                                .chain(formats.into_iter().map(DeviceFormat::Microphone))
                                .collect()
                        })
                    })
                    .await;
                this.update(cx, |this, cx| {
                    if this.device_format_generation != generation
                        || this.device_format_target.is_none()
                    {
                        return;
                    }
                    this.device_formats = Some(formats);
                    cx.notify();
                })
                .ok();
            })
            .detach();
        }
        cx.notify();
    }

    fn device_format_target_selected(&self, target: &DeviceFormatTarget) -> bool {
        match target {
            DeviceFormatTarget::Camera(camera) => self
                .camera
                .as_ref()
                .is_some_and(|selected| selected.device_id == camera.device_id),
            DeviceFormatTarget::Microphone(name) => self
                .microphone
                .as_ref()
                .is_some_and(|selected| selected.name == *name),
        }
    }

    fn choose_device_format(&mut self, format: DeviceFormat, cx: &mut Context<Self>) {
        if !self.device_changes_allowed(cx) {
            return;
        }
        let Some(target) = self.device_format_target.clone() else {
            return;
        };
        if !self
            .device_formats
            .as_ref()
            .and_then(|formats| formats.as_ref().ok())
            .is_some_and(|formats| formats.contains(&format))
        {
            return;
        }
        self.device_format_notice = None;
        if !self.device_format_target_selected(&target) {
            self.complete_device_format_save(&target, format, cx);
            return;
        }
        let feeds = Feeds::global(cx);
        let epoch = feeds.update(cx, |feeds, cx| match format {
            DeviceFormat::Camera(settings) => {
                feeds.set_camera_with_settings(feeds.camera.clone(), Some(settings), cx)
            }
            DeviceFormat::Microphone(settings) => {
                feeds.set_microphone_with_settings(feeds.microphone.clone(), Some(settings), cx)
            }
        });
        self.device_format_pending = Some(PendingDeviceFormat {
            target,
            format,
            epoch,
        });
        let result = match format {
            DeviceFormat::Camera(_) => feeds.read(cx).camera_configuration_result(epoch),
            DeviceFormat::Microphone(_) => feeds.read(cx).microphone_configuration_result(epoch),
        };
        self.finish_device_format_change(result, cx);
        cx.notify();
    }

    fn finish_device_format_change(
        &mut self,
        result: Option<Result<(), String>>,
        cx: &mut Context<Self>,
    ) {
        let still_owned = !self.device_restore_suspended
            && self.session.read(cx).phase == Phase::Idle
            && self
                .device_format_pending
                .as_ref()
                .is_some_and(|pending| self.device_format_target_selected(&pending.target));
        let Some(result) = complete_format_request(
            &mut self.device_format_pending,
            result,
            still_owned,
            save_device_format,
        ) else {
            return;
        };
        match result {
            Ok(format) => {
                self.device_format_value = Some(format);
                self.device_format_notice = None;
            }
            Err(error) => {
                self.device_format_notice = Some(error.clone());
                self.session.update(cx, |session, cx| {
                    session.error = Some(format!("Could not apply device format: {error}"));
                    cx.notify();
                });
            }
        }
        cx.notify();
    }

    fn complete_device_format_save(
        &mut self,
        target: &DeviceFormatTarget,
        format: DeviceFormat,
        cx: &mut Context<Self>,
    ) {
        if save_device_format(target, format) {
            self.device_format_value = Some(format);
            self.device_format_notice = None;
        } else {
            let error = "Could not save the device format preference. Try again.".to_string();
            self.device_format_notice = Some(error.clone());
            self.session.update(cx, |session, cx| {
                session.error = Some(error);
                cx.notify();
            });
        }
        cx.notify();
    }

    fn render_device_formats(&self, menu: DeviceMenu, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let applied = self
            .device_format_target
            .as_ref()
            .filter(|target| self.device_format_target_selected(target))
            .and_then(|target| {
                let settings = Feeds::global(cx).read(cx).applied_device_settings();
                match target {
                    DeviceFormatTarget::Camera(_) => settings.camera.map(DeviceFormat::Camera),
                    DeviceFormatTarget::Microphone(_) => {
                        settings.microphone.map(DeviceFormat::Microphone)
                    }
                }
            });
        let list = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .w_full()
            .child(
                div()
                    .text_size(px(12.))
                    .text_color(theme.gray_11)
                    .pb(px(8.))
                    .child("Preferred format"),
            )
            .when_some(applied, |list, format| {
                list.child(
                    div()
                        .text_size(px(12.))
                        .text_color(theme.gray_11)
                        .pb(px(8.))
                        .child(format!("Current: {}", format.label())),
                )
            });
        let list = match &self.device_formats {
            None => list.child(self.render_empty_state("Loading formats...")),
            Some(Err(error)) => list.child(self.render_empty_state(error.clone())),
            Some(Ok(formats)) => {
                list.children(formats.iter().enumerate().map(|(index, format)| {
                    let format = *format;
                    self.render_device_list_row(
                        SharedString::from(format!("device-format-{index}")),
                        menu.icon(),
                        format.label(),
                        None,
                        self.device_format_value == Some(format),
                        None,
                        cx.listener(move |this, _, _, cx| this.choose_device_format(format, cx)),
                    )
                }))
            }
        };
        list.when(self.device_format_pending.is_some(), |list| {
            list.child(self.render_empty_state("Applying format..."))
        })
        .when_some(self.device_format_notice.as_ref(), |list, notice| {
            list.child(self.render_empty_state(notice.clone()))
        })
    }

    fn render_device_format_button(
        &self,
        target: DeviceFormatTarget,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let enabled = self.device_changes_allowed(cx);
        let name = match &target {
            DeviceFormatTarget::Camera(camera) => format!("camera-format-{}", camera.device_id),
            DeviceFormatTarget::Microphone(name) => format!("mic-format-{name}"),
        };
        div()
            .id(SharedString::from(name))
            .flex()
            .items_center()
            .justify_center()
            .w(px(32.))
            .flex_shrink_0()
            .rounded(px(6.))
            .when(enabled, |button| {
                button
                    .cursor_pointer()
                    .hover(|style| style.bg(self.theme.body_hover_fill(4)))
            })
            .when(!enabled, |button| button.opacity(0.45))
            .child(
                svg()
                    .path("icons/settings-2.svg")
                    .size(px(16.))
                    .text_color(self.theme.gray_11),
            )
            .on_click(
                cx.listener(move |this, _, _, cx| this.open_device_formats(target.clone(), cx)),
            )
    }

    /// The width one target card gets, computed rather than flexed.
    ///
    /// Two columns inside `render_body`'s `px-[13px]` and the panel body's
    /// `px-2`, with an 8px gutter: `(W - 26 - 16 - 8) / 2`. A `flex_1` card
    /// carrying three lines of text re-measures its children every layout pass,
    /// which is fine for four cards and catastrophic for the forty a window
    /// picker routinely holds, so the grid states the width and the cards take
    /// it with `flex_none`.
    fn target_card_width(&self) -> f32 {
        let (window_width, _) = self.window_size();
        (window_width - 50.) / 2.
    }

    /// `TargetMenuGrid`: two columns of cards.
    ///
    /// Each card leads with a live 320x180 capture of the display or window
    /// (`target_thumbnails`), falling back to the target's icon on `gray-4` --
    /// which is exactly what the Tauri card does before its thumbnail arrives
    /// or when the `<img>` errors (`TargetCard.tsx:367-374`).
    fn render_target_grid(&self, target: TargetType, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let grid = div().flex().flex_col().gap(px(8.)).w_full();

        if self.enumerating {
            return grid.child(
                div()
                    .py(px(24.))
                    .w_full()
                    .text_size(px(14.))
                    .text_color(theme.gray_11)
                    .child("Loading..."),
            );
        }

        let mut cards: Vec<gpui::AnyElement> = Vec::new();

        match target {
            TargetType::Display => {
                for display in self
                    .devices
                    .displays
                    .iter()
                    .filter(|display| self.matches_search(&display.label))
                {
                    let selected = self
                        .selected_display
                        .as_ref()
                        .is_some_and(|current| current.id == display.id);
                    let chosen = display.clone();

                    cards.push(
                        self.render_target_card(
                            SharedString::from(format!("display-{}", display.id)),
                            self.thumbnails.display(&display.id),
                            "icons/screen.svg",
                            display.label.clone(),
                            None,
                            display.describe_refresh_rate(),
                            selected,
                            cx.listener(move |this, _, _window, cx| {
                                this.selected_display = Some(chosen.clone());
                                this.target = Some(TargetType::Display);
                                this.close_panel(cx);
                                this.sync_overlays(cx);
                            }),
                        )
                        .into_any_element(),
                    );
                }
            }
            TargetType::Window => {
                for window in self
                    .devices
                    .windows
                    .iter()
                    .filter(|w| self.matches_search(&w.label) || self.matches_search(&w.app))
                {
                    let selected = self
                        .selected_window
                        .as_ref()
                        .is_some_and(|current| current.id == window.id);
                    let chosen = window.clone();

                    cards.push(
                        self.render_target_card(
                            SharedString::from(format!("window-{}", window.id)),
                            self.thumbnails.window(&window.id),
                            "icons/window.svg",
                            window.label.clone(),
                            Some(window.app.clone()),
                            window.describe_metadata(),
                            selected,
                            cx.listener(move |this, _, _window, cx| {
                                this.selected_window = Some(chosen.clone());
                                this.target = Some(TargetType::Window);
                                this.close_panel(cx);
                                this.sync_overlays(cx);
                                this.focus_selected_window(cx);
                            }),
                        )
                        .into_any_element(),
                    );
                }
            }
            // Area and Camera Only have nothing to pick between.
            TargetType::Area | TargetType::CameraOnly => {}
        }

        if cards.is_empty() {
            return grid.child(
                self.render_empty_state(match (target, self.search.is_empty()) {
                    (TargetType::Display, true) => "No displays found",
                    (TargetType::Display, false) => "No matching displays",
                    (_, true) => "No windows found",
                    (_, false) => "No matching windows",
                }),
            );
        }

        // Two columns, laid out as rows of two. The cards carry their own
        // width (`target_card_width`), so a lone trailing card keeps half the
        // row without needing a spacer to hold the other half open.
        grid.children(
            cards
                .into_iter()
                .collect::<Vec<_>>()
                .chunks_mut(2)
                .map(|pair| {
                    let mut row = div().flex().flex_row().gap(px(8.)).w_full().items_stretch();
                    for card in pair.iter_mut() {
                        row = row.child(std::mem::replace(card, div().into_any_element()));
                    }
                    row
                })
                .collect::<Vec<_>>(),
        )
    }

    /// `TargetCard`: a 76px (`h-19`) thumbnail area over three 11px lines.
    #[allow(clippy::too_many_arguments)]
    fn render_target_card(
        &self,
        id: SharedString,
        thumb: target_thumbnails::TargetThumb,
        icon: &'static str,
        label: String,
        subtitle: Option<String>,
        metadata: Option<String>,
        selected: bool,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        div()
            .id(id)
            .flex()
            .flex_col()
            .w(px(self.target_card_width()))
            .flex_none()
            .min_w_0()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(if selected {
                Hsla::from(theme.blue_8)
            } else {
                gpui::transparent_black()
            })
            .bg(theme.body_fill(3))
            .child(target_thumbnails::render_thumbnail_slot(thumb, icon, theme))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .w_full()
                    .min_w_0()
                    .px(px(8.))
                    .py(px(6.))
                    .text_size(px(11.))
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_12)
                            .child(label),
                    )
                    .children(subtitle.map(|subtitle| {
                        div()
                            .w_full()
                            .truncate()
                            .text_color(theme.gray_11)
                            .child(subtitle)
                    }))
                    .children(metadata.map(|metadata| {
                        div()
                            .w_full()
                            .truncate()
                            .text_color(theme.gray_10)
                            .child(metadata)
                    })),
            )
            .hover(|style| style.bg(theme.body_hover_fill(4)))
            .on_click(on_click)
    }

    /// `ModeInfoPanel`. Its copy is deliberately not the copy in `MODE_BUTTONS`
    /// -- the hover cards and this panel describe the modes differently, so
    /// both sets of strings are carried.
    fn render_mode_info(&self, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let effective_mode = self.effective_mode(cx);
        let locked = self.session.read(cx).editor_recording_target().is_some();

        div().flex().flex_col().gap(px(8.)).w_full().children(
            [Mode::Instant, Mode::Studio, Mode::Screenshot].map(|mode| {
                let selected = mode == effective_mode;

                div()
                    .id(SharedString::from(mode.panel_title()))
                    .when(locked && !selected, |this| this.opacity(0.5))
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .p(px(12.))
                    .w_full()
                    .rounded(px(12.))
                    .border_2()
                    .border_color(if selected {
                        Hsla::from(theme.blue_9)
                    } else if theme.is_dark() {
                        theme.body_border(5)
                    } else {
                        theme.body_border(4)
                    })
                    .bg(if selected {
                        theme.tile_selected_bg()
                    } else if theme.is_dark() {
                        theme.body_fill(3)
                    } else {
                        theme.body_fill(2)
                    })
                    .child(
                        svg()
                            .path(mode.icon())
                            .size(px(20.))
                            .flex_shrink_0()
                            .text_color(if selected {
                                theme.blue_11
                            } else {
                                theme.gray_12
                            }),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .flex_1()
                            .min_w_0()
                            .child(
                                div()
                                    .text_size(px(14.))
                                    // `text-sm font-semibold`
                                    // (`ModeInfoPanel.tsx:106`). `font-semibold`
                                    // renders 700: no 600 face is loaded over
                                    // there (`ui-solid/vite.js:31-33`).
                                    .font_weight(FontWeight::BOLD)
                                    .text_color(if selected {
                                        theme.blue_11
                                    } else {
                                        theme.gray_12
                                    })
                                    .child(mode.panel_title()),
                            )
                            .child(
                                div()
                                    .text_size(px(12.))
                                    .text_color(theme.gray_11)
                                    .child(mode.panel_description()),
                            ),
                    )
                    .hover(|style| style.bg(theme.body_hover_fill(4)))
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        this.set_mode(mode, cx);
                        this.close_panel(cx);
                    }))
            }),
        )
    }

    fn render_empty_state(&self, message: impl Into<SharedString>) -> gpui::AnyElement {
        div()
            .py(px(24.))
            .w_full()
            .text_size(px(14.))
            .text_color(self.theme.gray_11)
            .child(message.into())
            .into_any_element()
    }

    /// `CameraListItem` / `MicrophoneListItem`: `px-3 py-2.5`, `rounded-lg`,
    /// 14px label over an optional 11px detail line indented `pl-7`.
    ///
    /// Selection is `bg-blue-500` with white text -- note that is the custom
    /// `--blue-500`, not `blue-9` used by the pills; the two are different
    /// colours.
    // Mirrors the web list-item's prop list; a struct would rename, not reduce.
    #[allow(clippy::too_many_arguments)]
    fn render_device_list_row(
        &self,
        id: SharedString,
        icon: &'static str,
        label: String,
        detail: Option<String>,
        selected: bool,
        // `MicrophoneListItem`'s live level wash: a white 25% overlay whose
        // right edge sits at `level * 100%` (1 = silence, the web app's
        // orientation). Only the selected microphone row gets one.
        audio_level: Option<f64>,
        on_click: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        let foreground = if selected {
            gpui::white()
        } else {
            Hsla::from(theme.gray_12)
        };
        let detail_color = if selected {
            let mut color = gpui::white();
            color.a = 0.7;
            color
        } else {
            Hsla::from(theme.gray_10)
        };

        div()
            .id(id)
            .relative()
            .overflow_hidden()
            .flex()
            .flex_col()
            .gap(px(2.))
            .px(px(12.))
            .py(px(10.))
            .w_full()
            .rounded(px(8.))
            .text_size(px(14.))
            .text_color(foreground)
            .when(selected, |this| this.bg(theme.blue_500))
            .when(!selected, |this| {
                this.hover(|style| style.bg(theme.body_hover_fill(4)))
            })
            .when_some(audio_level.filter(|_| selected), |this, level| {
                this.child(
                    div()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left_0()
                        .right(gpui::relative(level.clamp(0., 1.) as f32))
                        .rounded(px(8.))
                        .bg(gpui::hsla(0., 0., 1., 0.25)),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(12.))
                    .w_full()
                    .child(
                        svg()
                            .path(icon)
                            .size(px(16.))
                            .flex_shrink_0()
                            .text_color(foreground),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(label))
                    .when(selected, |this| {
                        this.child(
                            svg()
                                .path("icons/check.svg")
                                .size(px(16.))
                                .flex_shrink_0()
                                .text_color(foreground),
                        )
                    }),
            )
            .children(detail.map(|detail| {
                div()
                    // `pl-7` = 16px icon + 12px gap.
                    .pl(px(28.))
                    .text_size(px(11.))
                    .text_color(detail_color)
                    .truncate()
                    .child(detail)
            }))
            .on_click(on_click)
    }

    fn render_logo_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let recording_clip = self.session.read(cx).editor_recording_target().is_some();
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .mt(px(4.))
            .flex_shrink_0()
            .child(
                // `flex items-center space-x-1` around the logo and its badge.
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .when(!recording_clip, |this| {
                        this.child(self.render_logo())
                            .child(self.render_plan_badge())
                    })
                    .when(recording_clip, |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.))
                                .child(div().text_size(px(13.)).child("Record a new clip"))
                                .child(
                                    div()
                                        .text_size(px(10.))
                                        .text_color(self.theme.gray_11)
                                        .child("Add to your current project"),
                                ),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap(px(4.))
                    .child(self.render_mode_pill(cx))
                    .child(
                        div()
                            .text_size(px(9.))
                            .line_height(px(11.))
                            .text_color(self.theme.gray_11)
                            .child(format!("{} Mode", self.effective_mode(cx).panel_title())),
                    ),
            )
    }

    /// The plan badge: Personal is `text-[0.6rem] ml-2 rounded-lg border
    /// border-gray-5 px-1 py-0.5 bg-gray-3 hover:bg-gray-5`, a button; Pro and
    /// Commercial are a non-interactive span on `--blue-400`. Which one
    /// applies is [`PlanBadge::current`], the license query's resolution.
    ///
    /// Personal opens the pricing page -- the Tauri button opens the Upgrade
    /// window (950x850), which has no gpui twin yet, and the integrations
    /// page's upgrade affordance already goes to `/pricing` for the same
    /// reason.
    fn render_plan_badge(&self) -> impl IntoElement {
        let theme = self.theme;

        let badge = div()
            .id("plan-badge")
            .flex()
            .items_center()
            .flex_shrink_0()
            .ml(px(8.))
            .px(px(4.))
            .py(px(2.))
            .rounded(px(8.))
            .text_size(px(9.6));

        match self.plan {
            PlanBadge::Personal => badge
                .border_1()
                .border_color(theme.body_border(5))
                .bg(theme.body_fill(3))
                .text_color(theme.gray_12)
                .child("Personal")
                .hover(|style| style.bg(theme.body_hover_fill(5)))
                .on_click(|_, _, cx| {
                    let url = format!("{}/pricing", crate::auth::server_url());
                    cx.open_url(&url);
                }),
            PlanBadge::Pro | PlanBadge::Commercial => badge
                .bg(theme.blue_9)
                .text_color(gpui::white())
                .child(if self.plan == PlanBadge::Commercial {
                    "Commercial"
                } else {
                    "Pro"
                }),
        }
    }

    /// This goes through `img()`, not `svg()`. The two take different paths in
    /// gpui: `svg()` keeps only the alpha and tints it with one colour, which
    /// would flatten the badge, the three blue rings and the wordmark into a
    /// single silhouette, whereas `img()` rasterises through resvg and keeps
    /// the colour. `img()` also renders at `SMOOTH_SVG_SCALE_FACTOR` (2x), so
    /// the 103px-wide source becomes a 206px raster -- more than the 168 device
    /// pixels an 84px lockup needs on a 2x display.
    ///
    /// The app ships two files rather than recolouring one, so this picks the
    /// same way it does.
    fn render_logo(&self) -> impl IntoElement {
        img(if self.theme.is_dark() {
            "icons/logo-full-dark.svg"
        } else {
            "icons/logo-full.svg"
        })
        .w(px(84.))
        .h(px(84. * 40. / 103.))
        .flex_shrink_0()
    }

    fn clear_mode_hover(&mut self) {
        self.mode_hover_task = None;
        self.mode_hover = ModeHoverState::default();
    }

    fn update_mode_hover(&mut self, mode: Mode, card: bool, hovered: bool, cx: &mut Context<Self>) {
        let previous = self.mode_hover.target();
        self.mode_hover.update(mode, card, hovered);
        let target = self.mode_hover.target();
        if target == previous {
            return;
        }
        self.mode_hover_task = None;
        if target == self.mode_hover.visible {
            return;
        }
        if target.is_some() {
            self.mode_hover.visible = None;
            cx.notify();
        }
        let delay = std::time::Duration::from_millis(if target.is_some() { 120 } else { 80 });
        self.mode_hover_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |this, cx| {
                if this.mode_hover.target() == target {
                    this.mode_hover.visible = target;
                    cx.notify();
                }
            });
        }));
    }

    fn render_mode_hover(&self, cx: &mut Context<Self>) -> Option<impl IntoElement> {
        let mode = self.mode_hover.visible?;
        if self.panel.is_some() || self.session.read(cx).phase != Phase::Idle {
            return None;
        }
        let index = match mode {
            Mode::Instant => 0,
            Mode::Studio => 1,
            Mode::Screenshot => 2,
        };
        let bounds = self.mode_hover_bounds[index].get()?;
        Some(
            gpui::anchored()
                .anchor(gpui::Anchor::TopRight)
                .position(gpui::point(bounds.right(), bounds.bottom() + px(12.)))
                .snap_to_window_with_margin(px(12.))
                .child(
                    div()
                        .id("mode-hover-card")
                        .occlude()
                        .on_hover(cx.listener(move |this, hovered, _, cx| {
                            this.update_mode_hover(mode, true, *hovered, cx);
                        }))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.clear_mode_hover();
                            cx.notify();
                        }))
                        .child(ModeHoverCard {
                            mode,
                            theme: self.theme,
                        }),
                ),
        )
    }

    /// `Mode.tsx`: `p-1.5 gap-2 rounded-full border border-gray-5 bg-gray-3`,
    /// 28px round buttons (`size-7`). Selected gets `bg-gray-7` plus a 2px
    /// `blue-500` ring offset 1px against `gray-1`.
    fn render_mode_pill(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected_mode = self.effective_mode(cx);
        let locked = self.session.read(cx).editor_recording_target().is_some();

        let button = |mode: Mode, id: &'static str, index: usize| {
            let selected = mode == selected_mode;
            let bounds = self.mode_hover_bounds[index].clone();
            div()
                .id(SharedString::from(id))
                .tab_index(0)
                .relative()
                .on_hover(cx.listener(move |this, hovered, _, cx| {
                    this.update_mode_hover(mode, false, *hovered, cx);
                }))
                .when(locked && !selected, |this| this.opacity(0.5))
                .flex()
                .items_center()
                .justify_center()
                .size(px(28.))
                .rounded_full()
                .bg(if selected {
                    Hsla::from(theme.gray_7)
                } else {
                    theme.body_fill(3)
                })
                .when(selected, |this| {
                    // `ring-2 ring-blue-500 ring-offset-1 ring-offset-gray-1`.
                    this.border_2()
                        .border_color(theme.blue_500)
                        .shadow(vec![gpui::BoxShadow {
                            color: theme.ring_offset(),
                            offset: gpui::point(px(0.), px(0.)),
                            blur_radius: px(0.),
                            spread_radius: px(1.),
                            inset: false,
                        }])
                })
                .child(
                    gpui::canvas(move |value, _, _| bounds.set(Some(value)), |_, _, _, _| {})
                        .absolute()
                        .size_full(),
                )
                .child(
                    svg()
                        .path(mode.icon())
                        .size(px(mode.icon_size()))
                        .text_color(theme.gray_12),
                )
                .hover(|style| style.bg(theme.body_hover_fill(7)))
                .on_click(cx.listener(move |this, _, _window, cx| {
                    if this.session.read(cx).editor_recording_target().is_some() {
                        return;
                    }
                    this.set_mode(mode, cx);
                    cx.defer(app_windows::refresh_target_overlays);
                }))
        };

        div()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .p(px(6.))
            .rounded_full()
            .border_1()
            .border_color(theme.body_border(5))
            .bg(theme.body_fill(3))
            .child(button(Mode::Instant, "mode-instant", 0))
            .child(button(Mode::Studio, "mode-studio", 1))
            .child(button(Mode::Screenshot, "mode-screenshot", 2))
            // `absolute -left-1.5 -top-2 p-1 rounded-full bg-gray-5`, hanging
            // off the pill's top-left corner.
            .child(
                div()
                    .id("mode-info")
                    .tab_index(0)
                    .tooltip(move |_, cx| ui::Tooltip::new(&theme, "Recording mode info").view(cx))
                    .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                    .absolute()
                    .left(px(-6.))
                    .top(px(-8.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .p(px(4.))
                    .rounded_full()
                    .bg(theme.body_fill(5))
                    .child(
                        svg()
                            .path("icons/info.svg")
                            .size(px(10.))
                            .text_color(theme.gray_12),
                    )
                    .hover(|style| style.opacity(0.5))
                    .on_click(cx.listener(|this, _, window, cx| {
                        // What shipping new-main actually does: it passes
                        // `onInfoClick` into `Mode.tsx`, so the dot opens the
                        // in-window info panel -- `showWindow("ModeSelect")` is
                        // `Mode.tsx`'s *fallback*, and nothing in the shipping
                        // frontend reaches it. The standalone window exists
                        // here for parity (`CAP_GPUI_AUTO_MODE_SELECT` opens
                        // it), but the dot mirrors the observed behavior.
                        this.open_panel(Panel::ModeInfo, window, cx);
                    })),
            )
    }

    fn render_targets(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .w_full()
            .flex_shrink_0()
            .child(
                div()
                    .px(px(4.))
                    .text_size(px(10.))
                    .line_height(px(14.))
                    .text_color(self.theme.gray_11)
                    .child("Choose a capture source"),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .items_stretch()
                    .w_full()
                    .child(self.render_split_target(TargetType::Display, cx))
                    .child(self.render_split_target(TargetType::Window, cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .gap(px(8.))
                    .items_stretch()
                    .w_full()
                    .child(self.render_target_tile(TargetType::Area, cx))
                    .child(self.render_target_tile(TargetType::CameraOnly, cx)),
            )
    }

    /// Display and Window are split controls: the tile plus a 28px
    /// (`w-7`) chevron button, sharing one rounded border.
    fn render_split_target(&self, target: TargetType, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);
        let hover_fill = capture_hover_fill(theme, selected, false);
        let dropdown_id = SharedString::from(format!("{}-dropdown", target.label()));

        div()
            .group(target.label())
            .flex()
            .flex_1()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(if selected {
                Hsla::from(theme.blue_8)
            } else {
                theme.body_border(6)
            })
            .bg(if selected {
                theme.tile_selected_bg()
            } else {
                theme.body_fill(2)
            })
            .child(self.target_button_inner(target, true, cx))
            .child(
                div()
                    .id(dropdown_id.clone())
                    .group(dropdown_id.clone())
                    .flex()
                    .w(px(28.))
                    .rounded_r(px(7.))
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme.body_border(6))
                    .bg(if selected {
                        theme.tile_selected_bg()
                    } else {
                        theme.body_fill(2)
                    })
                    .text_color(theme.gray_11)
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(16.))
                            .text_color(theme.gray_11)
                            .group_hover(dropdown_id, move |style| style.text_color(theme.blue_11)),
                    )
                    .group_hover(target.label(), move |style| style.bg(hover_fill))
                    .hover(move |style| {
                        style
                            .bg(capture_hover_fill(theme, selected, true))
                            .text_color(theme.blue_11)
                    })
                    .active(move |style| style.bg(theme.tile_selected_hover_bg()))
                    .tooltip(move |_, cx| {
                        ui::Tooltip::new(
                            &theme,
                            match target {
                                TargetType::Display => "Choose a display",
                                TargetType::Window => "Choose a window",
                                _ => unreachable!(),
                            },
                        )
                        .view(cx)
                    })
                    .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_panel(Panel::Target(target), window, cx);
                    })),
            )
    }

    /// Area and Camera Only are plain tiles with their own border.
    fn render_target_tile(&self, target: TargetType, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);

        div()
            .flex()
            .flex_1()
            .overflow_hidden()
            .rounded(px(8.))
            .border_1()
            .border_color(if selected {
                Hsla::from(theme.blue_8)
            } else {
                theme.body_border(6)
            })
            .bg(if selected {
                theme.tile_selected_bg()
            } else {
                theme.body_fill(2)
            })
            .child(self.target_button_inner(target, false, cx))
    }

    /// `TargetTypeButton`. Compact stacks the icon over the label
    /// (`flex-col items-center gap-1 py-2 justify-end`); expanded lays them out
    /// horizontally with a description (`min-h-14 flex-row gap-2.5 px-3`).
    fn target_button_inner(
        &self,
        target: TargetType,
        split: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let selected = self.target == Some(target);
        let expanded = self.expanded;
        let hover_fill = capture_hover_fill(theme, selected, false);

        let icon_color = if selected {
            theme.blue_10
        } else {
            theme.gray_10
        };
        let label_color = if selected {
            theme.blue_11
        } else {
            theme.gray_12
        };
        let description_color = icon_color;

        let icon = svg()
            .path(target.icon())
            .size(px(20.))
            .flex_shrink_0()
            .text_color(icon_color);

        let base = div()
            .id(SharedString::from(target.label()))
            .flex()
            .flex_1()
            .py(px(8.))
            .when(split, |this| this.rounded_l(px(7.)))
            .when(!split, |this| this.rounded(px(7.)))
            .when(split, |this| {
                this.group_hover(target.label(), move |style| style.bg(hover_fill))
            })
            .when(!split, |this| this.hover(move |style| style.bg(hover_fill)))
            .active(move |style| style.bg(theme.tile_selected_hover_bg()))
            .on_click(cx.listener(move |this, _, _window, cx| {
                // `toggleTargetMode`: clicking the armed tile again is a
                // cancel, which takes the overlays down with it.
                this.target = if this.target == Some(target) {
                    None
                } else {
                    Some(target)
                };
                this.sync_overlays(cx);
                cx.notify();
            }));

        if expanded {
            base.flex_row()
                .items_center()
                .justify_start()
                .gap(px(10.))
                .min_h(px(56.))
                // `pl-3` when expanded for the split controls, `px-3` otherwise.
                .px(px(12.))
                .child(icon)
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(12.))
                                // `text-xs` / `leading-4` (`TargetTypeButton.tsx:47`).
                                .line_height(px(16.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(label_color)
                                .child(target.label()),
                        )
                        .child(
                            div()
                                .text_size(px(10.))
                                // `text-[10px] leading-3`.
                                .line_height(px(12.))
                                .text_color(description_color)
                                .child(target.description()),
                        ),
                )
        } else {
            base.flex_col()
                .items_center()
                .justify_end()
                .gap(px(4.))
                // `pl-5` on the split controls when compact, to keep the icon
                // optically centred against the chevron on the right.
                .when(split, |this| this.pl(px(20.)))
                .child(icon)
                .child(
                    div()
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(label_color)
                        .child(target.label()),
                )
        }
    }

    /// `BaseControls`: camera, microphone, system audio.
    fn render_base_controls(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let gap = if self.expanded { 10. } else { 6. };

        div()
            .flex()
            .flex_col()
            .gap(px(gap))
            .w_full()
            .child(
                div()
                    .px(px(4.))
                    .text_size(px(10.))
                    .line_height(px(14.))
                    .text_color(self.theme.gray_11)
                    .child("Choose your camera and microphone"),
            )
            .child(
                self.labelled(
                    "Camera",
                    self.render_device_row(
                        "camera-row",
                        "icons/camera.svg",
                        self.camera
                            .as_ref()
                            .map(|camera| camera.label.clone())
                            .unwrap_or_else(|| "No Camera".into()),
                        if self.camera.is_some() {
                            if self.devices.cameras.iter().any(|camera| {
                                Some(&camera.device_id)
                                    == self.camera.as_ref().map(|selected| &selected.device_id)
                            }) {
                                PillState::On
                            } else {
                                PillState::Disconnected
                            }
                        } else {
                            PillState::Off
                        },
                        Some(DeviceMenu::Camera),
                        cx,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        // Through `open_panel`, so the filter field takes focus
                        // the way it already does for the display and window
                        // panels -- before the field was real there was nothing
                        // to focus into.
                        if !this.enumerating && this.device_changes_allowed(cx) {
                            this.open_panel(Panel::Device(DeviceMenu::Camera), window, cx);
                        }
                    })),
                ),
            )
            .child(
                self.labelled(
                    "Microphone",
                    self.render_device_row(
                        "microphone-row",
                        "icons/microphone.svg",
                        self.microphone
                            .as_ref()
                            .map(|mic| mic.name.clone())
                            .unwrap_or_else(|| "No Microphone".into()),
                        if self.microphone.is_some() {
                            if self.devices.microphones.iter().any(|microphone| {
                                Some(&microphone.name)
                                    == self.microphone.as_ref().map(|selected| &selected.name)
                            }) {
                                PillState::On
                            } else {
                                PillState::Disconnected
                            }
                        } else {
                            PillState::Off
                        },
                        Some(DeviceMenu::Microphone),
                        cx,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        // Through `open_panel`, so the filter field takes focus
                        // the way it already does for the display and window
                        // panels -- before the field was real there was nothing
                        // to focus into.
                        if !this.enumerating && this.device_changes_allowed(cx) {
                            this.open_panel(Panel::Device(DeviceMenu::Microphone), window, cx);
                        }
                    })),
                ),
            )
            .child(
                self.labelled(
                    "System audio",
                    self.render_device_row(
                        "system-audio-row",
                        "icons/screen.svg",
                        if self.system_audio {
                            "Record System Audio".into()
                        } else {
                            "No System Audio".into()
                        },
                        if self.system_audio {
                            PillState::On
                        } else {
                            PillState::Off
                        },
                        None,
                        cx,
                    )
                    // System audio has no device to choose, so the row is a
                    // plain toggle rather than a picker.
                    .on_click(cx.listener(|this, _, _window, cx| {
                        if this.device_changes_allowed(cx) {
                            this.set_system_audio(!this.system_audio, cx);
                        }
                    })),
                ),
            )
    }

    /// `Recents.tsx`, expanded only.
    ///
    /// Three states, the same three the section has: the loading skeletons
    /// while the first scan is in flight, the dashed empty box when the
    /// library is empty, and the card carousel otherwise.
    fn render_recents(&self) -> impl IntoElement {
        let theme = self.theme;

        let section = div()
            // `<div class="pt-2">` around the section in index.tsx.
            .pt(px(8.))
            .w_full()
            .flex_shrink_0()
            .child(
                // `mb-2 flex items-center px-0.5`.
                div().flex().items_center().mb(px(8.)).px(px(2.)).child(
                    div()
                        .text_size(px(12.))
                        // `font-semibold` (`new-main/Recents.tsx:203`) renders
                        // 700: no 600 face is loaded over there.
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme.gray_12)
                        .child("Recents"),
                ),
            );

        match self.recents.as_deref() {
            // `<Show when={isLoading}>`: three skeleton cards. Theirs pulse
            // (`animate-pulse`); this gpui rev has no keyframe hook, so these
            // are the same three slabs, static.
            None => section.child(
                self.recent_carousel()
                    .children((0..3usize).map(|index| {
                        div()
                            .id(("recent-skeleton", index))
                            .flex_shrink_0()
                            .w(px(RECENT_CARD_WIDTH))
                            .h(px(RECENT_CARD_HEIGHT))
                            .rounded(px(12.))
                            .bg(theme.body_fill(3))
                    }))
                    .into_any_element(),
            ),
            // `flex h-28 flex-col items-center justify-center gap-2 rounded-xl
            //  border border-dashed border-gray-5 bg-gray-2 text-center`.
            Some([]) => section.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .w_full()
                    .h(px(RECENT_CARD_HEIGHT))
                    .rounded(px(12.))
                    .border_dashed()
                    .border_1()
                    .border_color(theme.body_border(5))
                    .bg(theme.body_fill(2))
                    .child(
                        svg()
                            .path("icons/history.svg")
                            .size(px(20.))
                            .text_color(theme.gray_9),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(theme.gray_10)
                            .child("Your latest captures will appear here."),
                    )
                    .into_any_element(),
            ),
            Some(entries) => section.child(
                self.recent_carousel()
                    .children(
                        entries
                            .iter()
                            .enumerate()
                            .map(|(index, entry)| self.render_recent_card(index, entry)),
                    )
                    .into_any_element(),
            ),
        }
    }

    /// `RecentCarousel`: `flex snap-x snap-proximity gap-2 overflow-x-auto
    /// overscroll-x-contain scroll-smooth pb-1 pr-8`.
    ///
    /// Snap points and the scroll-position-driven edge-fade mask have no hook
    /// in this gpui rev (the same `mask-image` gap as the teleprompter's
    /// vignette); the scroller, the gap and the trailing gutter are real.
    fn recent_carousel(&self) -> gpui::Stateful<gpui::Div> {
        div()
            .id("recents-carousel")
            .flex()
            .flex_row()
            .items_start()
            .gap(px(8.))
            .pb(px(4.))
            .pr(px(32.))
            .w_full()
            .overflow_x_scroll()
    }

    /// `RecentCard`: `group relative h-28 w-[196px] shrink-0 snap-start
    /// overflow-hidden rounded-xl border border-gray-5 bg-gray-3 text-left
    /// shadow-sm ... hover:-translate-y-0.5 hover:border-gray-7
    /// hover:shadow-md`.
    ///
    /// The whole card is the button. A studio recording opens the editor, as
    /// `openRecentMedia` -> `openRecording` does; an instant recording or a
    /// screenshot still reveals its bundle in Finder (see the README's
    /// deviation -- neither the share link nor the screenshot editor exists
    /// here). `hover:-translate-y-0.5` and the thumbnail's
    /// `group-hover:scale-[1.025]` are transforms, which this gpui rev has
    /// none of.
    fn render_recent_card(&self, index: usize, entry: &RecentEntry) -> impl IntoElement {
        let theme = self.theme;
        let item = &entry.item;
        let item_for_click = item.clone();

        div()
            .id(("recent-card", index))
            .relative()
            .flex_shrink_0()
            .w(px(RECENT_CARD_WIDTH))
            .h(px(RECENT_CARD_HEIGHT))
            .overflow_hidden()
            .rounded(px(12.))
            .border_1()
            .border_color(theme.body_border(5))
            .bg(theme.body_fill(3))
            .shadow_sm()
            .cursor_pointer()
            // `hover:border-gray-7` is not one of the steps theme.css remaps,
            // so it keeps its Radix value under the material.
            .hover(|style| style.border_color(theme.body_border(7)).shadow_md())
            .child(match entry.thumbnail.clone() {
                Some(image) => {
                    use gpui::StyledImage as _;
                    // `h-full w-full object-cover`, and the image carries the
                    // card's radius itself: cover crops through the atlas
                    // tile's UVs on this fork, so the rounding lands on the
                    // real corners rather than being clipped off with the
                    // overflow -- the same shape the camera bubble's circular
                    // preview relies on. A flow child rather than an absolute
                    // one, matching both the TSX and the camera window.
                    gpui::img(image)
                        .size_full()
                        .object_fit(gpui::ObjectFit::Cover)
                        .rounded(px(12.))
                        .into_any_element()
                }
                // `flex h-full w-full items-center justify-center
                //  bg-linear-to-br from-gray-3 to-gray-5 text-gray-9`, with the
                //  `size-7` glyph for the media kind.
                None => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .bg(gpui::linear_gradient(
                        135.,
                        gpui::linear_color_stop(theme.body_fill(3), 0.),
                        gpui::linear_color_stop(theme.body_fill(5), 1.),
                    ))
                    .child(
                        svg()
                            .path(item.kind.fallback_icon())
                            .size(px(28.))
                            .text_color(theme.gray_9),
                    )
                    .into_any_element(),
            })
            // `absolute inset-0 bg-linear-to-t from-black/80 via-black/10
            //  to-black/5`. gpui's `linear_gradient` takes two stops, so the
            //  three-stop ramp is two stacked halves that meet at `via`'s 50%
            //  -- which is the same piecewise-linear curve CSS draws.
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(RECENT_CARD_HEIGHT / 2.))
                    .bg(gpui::linear_gradient(
                        0.,
                        gpui::linear_color_stop(black_alpha(0.10), 0.),
                        gpui::linear_color_stop(black_alpha(0.05), 1.),
                    )),
            )
            .child(
                div()
                    .absolute()
                    .bottom_0()
                    .left_0()
                    .right_0()
                    .h(px(RECENT_CARD_HEIGHT / 2.))
                    .bg(gpui::linear_gradient(
                        0.,
                        gpui::linear_color_stop(black_alpha(0.80), 0.),
                        gpui::linear_color_stop(black_alpha(0.10), 1.),
                    )),
            )
            // `absolute left-2 top-2 flex items-center gap-1 rounded-full
            //  border border-white/15 bg-black/45 px-2 py-0.5 text-[9px]
            //  font-medium text-white/90 backdrop-blur-sm` -- no backdrop blur
            //  hook, same as everywhere else in this app.
            .child(
                div()
                    .absolute()
                    .left(px(8.))
                    .top(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded_full()
                    .border_1()
                    .border_color(white_alpha(0.15))
                    .bg(black_alpha(0.45))
                    .px(px(8.))
                    .py(px(2.))
                    .text_size(px(9.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(white_alpha(0.90))
                    .child(
                        svg()
                            .path(item.kind.pill_icon())
                            // `size-2.5`.
                            .size(px(10.))
                            .flex_shrink_0()
                            .text_color(white_alpha(0.90)),
                    )
                    .child(item.kind.label()),
            )
            // `absolute inset-x-0 bottom-0 px-2.5 pb-2 pt-5`.
            .child(
                div()
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .px(px(10.))
                    .pb(px(8.))
                    .pt(px(20.))
                    .child(
                        // `truncate text-[11px] font-medium text-white`.
                        div()
                            .w_full()
                            .text_size(px(11.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(gpui::white())
                            .truncate()
                            .child(item.pretty_name.clone()),
                    )
                    .when(
                        // `props.item.kind === "recording" && clip_count > 1`.
                        item.kind != MediaKind::Screenshot && item.clip_count > 1,
                        |this| {
                            this.child(
                                // `mt-0.5 text-[9px] text-white/65`.
                                div()
                                    .mt(px(2.))
                                    .text_size(px(9.))
                                    .text_color(white_alpha(0.65))
                                    .child(format!("{} clips", item.clip_count)),
                            )
                        },
                    ),
            )
            .on_click(move |_, _window, cx| activate_recent(&item_for_click, cx))
    }

    /// `ExpandedControlLabel`: `mb-1 px-1`, `text-xs font-semibold text-gray-12`.
    /// Only rendered when expanded.
    fn labelled(&self, title: &'static str, row: impl IntoElement) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.expanded;

        div()
            .flex()
            .flex_col()
            .when(expanded, |this| {
                this.child(
                    div().mb(px(4.)).px(px(4.)).child(
                        div()
                            .text_size(px(12.))
                            // `font-semibold` (`new-main/index.tsx:2945`)
                            // renders 700: no 600 face is loaded over there.
                            .font_weight(FontWeight::BOLD)
                            .text_color(theme.gray_12)
                            .child(title),
                    ),
                )
            })
            .child(row)
    }

    /// `DEVICE_ROW_CLASS`: 42px tall, `rounded-lg`, `border-gray-6`, `bg-gray-2`,
    /// `pl-3 pr-1.5 gap-2.5`.
    fn render_device_row(
        &self,
        id: &'static str,
        icon: &'static str,
        label: String,
        pill: PillState,
        menu: Option<DeviceMenu>,
        cx: &mut Context<Self>,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        div()
            .id(SharedString::from(id))
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .pl(px(12.))
            .pr(px(6.))
            .w_full()
            .h(px(DEVICE_ROW_HEIGHT))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.body_border(6))
            .bg(theme.body_fill(2))
            .cursor_default()
            .overflow_hidden()
            .when(menu == Some(DeviceMenu::Microphone), |this| {
                this.child(
                    self.microphone_level.clone().cached(
                        gpui::StyleRefinement::default()
                            .absolute()
                            .top_0()
                            .left_0()
                            .size_full(),
                    ),
                )
            })
            .child(
                svg()
                    .path(icon)
                    .size(px(16.))
                    .flex_shrink_0()
                    .text_color(theme.gray_11),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(theme.gray_12)
                    .truncate()
                    .child(label),
            )
            .child(
                div()
                    .id(SharedString::from(format!("{id}-toggle")))
                    .child(pill.render(theme))
                    .on_click(cx.listener(move |this, _, _window, cx| {
                        let Some(menu) = menu else {
                            return;
                        };
                        if this.enumerating || !this.device_changes_allowed(cx) {
                            cx.stop_propagation();
                            return;
                        }
                        match menu {
                            DeviceMenu::Camera if this.camera.is_some() => {
                                cx.stop_propagation();
                                this.set_camera_selection(None, cx);
                            }
                            DeviceMenu::Microphone if this.microphone.is_some() => {
                                cx.stop_propagation();
                                this.set_microphone_selection(None, cx);
                            }
                            _ => {}
                        }
                    })),
            )
            // `hover:border-gray-8` is not one of the classes theme.css remaps, so
            // the border keeps its Radix step under the material.
            .hover(|style| {
                style
                    .bg(theme.body_hover_fill(4))
                    .border_color(theme.gray_8)
            })
    }
}

/// What a click on a Recents card does -- `openRecentMedia`.
///
/// Studio recordings open the editor, screenshots the screenshot editor.
/// Instant recordings open the share link when one exists, otherwise the
/// bundle is revealed.
pub fn activate_recent(item: &RecentItem, cx: &mut gpui::App) {
    match item.kind {
        MediaKind::Studio => {
            tracing::info!(path = %item.bundle.display(), "opening recent capture in the editor");
            let bundle = item.bundle.clone();
            cx.defer(move |cx| app_windows::open_editor(bundle, cx));
        }
        MediaKind::Instant => {
            if let Some(url) = &item.sharing {
                cx.open_url(url);
            } else {
                library::reveal_in_folder(&item.bundle);
            }
        }
        MediaKind::Screenshot => {
            let bundle = item.bundle.clone();
            cx.defer(move |cx| app_windows::open_screenshot_editor(bundle, cx));
        }
    }
}

/// `black/N` -- Tailwind's slash-alpha over the two absolute colours, which
/// come from neither the Radix palette nor the material tokens.
fn black_alpha(alpha: f32) -> Hsla {
    let mut color = gpui::black();
    color.a = alpha;
    color
}

/// `white/N`; see [`black_alpha`].
fn white_alpha(alpha: f32) -> Hsla {
    let mut color = gpui::white();
    color.a = alpha;
    color
}

/// `CAP_GPUI_AUTO_OVERLAY=display|window|area|camera`, the harness's stand-in
/// for clicking a target tile.
pub fn auto_overlay_kind() -> Option<TargetType> {
    match std::env::var("CAP_GPUI_AUTO_OVERLAY").ok()?.as_str() {
        "display" => Some(TargetType::Display),
        "window" => Some(TargetType::Window),
        "area" => Some(TargetType::Area),
        "camera" => Some(TargetType::CameraOnly),
        _ => None,
    }
}

pub(crate) fn auto_window_title() -> Option<String> {
    std::env::var("CAP_GPUI_AUTO_WINDOW")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn window_matches(window: &crate::devices::WindowOption, title: &str) -> bool {
    window.label == title
}

/// `CAP_GPUI_AUTO_AREA=x,y,width,height`, the harness's stand-in for drawing a
/// crop with the mouse.
fn auto_area_rect() -> Option<crate::target_overlay::AreaRect> {
    crate::target_overlay::AreaRect::parse(&std::env::var("CAP_GPUI_AUTO_AREA").ok()?)
}

/// `InfoPill` + `TargetSelectInfoPill`: 24px tall, min 40px wide, `px-2.5`,
/// `rounded-full`, 11px medium text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PillState {
    On,
    Off,
    Disconnected,
}

impl PillState {
    fn render(self, theme: Theme) -> impl IntoElement {
        let (bg, fg, text) = match self {
            Self::On => (Hsla::from(theme.blue_9), gpui::white(), "On"),
            Self::Off => (theme.body_fill(5), Hsla::from(theme.gray_11), "Off"),
            Self::Disconnected => (
                theme.body_fill(5),
                Hsla::from(theme.gray_11),
                "Not connected",
            ),
        };

        div()
            .flex()
            .items_center()
            .justify_center()
            .h(px(24.))
            .min_w(px(40.))
            .px(px(10.))
            .flex_shrink_0()
            .rounded_full()
            .bg(bg)
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .child(text)
    }
}

fn recording_error_text(error: String) -> impl IntoElement + Styled {
    div()
        .id("recording-error-text")
        .w_full()
        .min_w_0()
        .min_h_0()
        .max_h(px(48.))
        .text_size(px(12.))
        .line_height(px(16.))
        .whitespace_normal()
        .overflow_scroll()
        .child(error)
}

#[cfg(any(target_os = "linux", test))]
fn clean_capture_resume_available(phase: Phase, active: bool, paused_acknowledged: bool) -> bool {
    active && phase == (Phase::Recording { paused: true }) && paused_acknowledged
}

fn clear_shown_idle_error(phase: Phase, current: &mut Option<String>, shown: &str) -> bool {
    if phase != Phase::Idle || current.as_deref() != Some(shown) {
        return false;
    }
    *current = None;
    true
}

#[cfg(test)]
mod remembered_device_tests {
    use super::*;

    fn camera(device: &str, model: Option<&str>) -> CameraOption {
        CameraOption {
            device_id: device.to_string(),
            model_id: model.map(|model| cap_camera::ModelID::try_from(model.to_string()).unwrap()),
            label: format!("Camera {device}"),
            best_format: None,
            formats: Vec::new(),
        }
    }

    #[test]
    fn restores_model_identity_after_device_id_changes() {
        let candidates = [
            camera("other", Some("other:model")),
            camera("new-id", Some("same:model")),
        ];
        let model = cap_camera::ModelID::try_from("same:model".to_string()).unwrap();
        let restored = remembered_camera(&recording::DeviceOrModelID::ModelID(model), &candidates);
        assert_eq!(restored, candidates[1]);
        assert_eq!(
            remembered_camera(
                &recording::DeviceOrModelID::DeviceID("other".into()),
                &candidates
            ),
            candidates[0]
        );
    }

    #[test]
    fn missing_camera_and_microphone_never_select_another_device() {
        let cameras = [camera("unrequested", None)];
        let missing = recording::DeviceOrModelID::DeviceID("remembered".into());
        let restored = remembered_camera(&missing, &cameras);
        assert_eq!(restored.device_id, "remembered");
        assert_ne!(restored, cameras[0]);

        let microphones = [MicrophoneOption {
            name: "Unrequested microphone".into(),
            sample_rate: Some(48000),
            channels: Some(2),
        }];
        let restored = remembered_microphone("Remembered microphone", &microphones);
        assert_eq!(restored.name, "Remembered microphone");
        assert_eq!(restored.sample_rate, None);
        assert_eq!(
            remembered_microphone("Unrequested microphone", &microphones),
            microphones[0]
        );
    }

    #[test]
    fn closing_before_enumeration_defers_saved_inputs_until_reopen_once() {
        let saved = crate::store::RecordingInputSettings {
            camera_id: Some(recording::DeviceOrModelID::DeviceID(
                "remembered-camera".into(),
            )),
            microphone_name: Some("Remembered microphone".into()),
        };
        let mut pending = saved.clone();
        assert!(take_pending_recording_inputs(&mut pending, true, false).is_none());
        assert!(take_pending_recording_inputs(&mut pending, false, true).is_none());
        assert_eq!(pending, saved);
        let reopened = take_pending_recording_inputs(&mut pending, false, false).unwrap();
        assert_eq!(reopened, saved);
        assert!(take_pending_recording_inputs(&mut pending, false, false).is_none());
    }

    #[test]
    fn explicit_off_during_suspended_restore_is_not_reversed_on_reopen() {
        let mut pending = crate::store::RecordingInputSettings {
            camera_id: Some(recording::DeviceOrModelID::DeviceID("old-camera".into())),
            microphone_name: Some("Remembered microphone".into()),
        };
        assert!(take_pending_recording_inputs(&mut pending, false, true).is_none());
        pending.camera_id = None;
        assert!(take_pending_recording_inputs(&mut pending, true, false).is_none());
        let reopened = take_pending_recording_inputs(&mut pending, false, false).unwrap();
        assert!(reopened.camera_id.is_none());
        assert_eq!(
            reopened.microphone_name.as_deref(),
            Some("Remembered microphone")
        );
        assert!(take_pending_recording_inputs(&mut pending, false, false).is_none());
    }
}

#[cfg(test)]
mod device_format_tests {
    use super::*;

    fn pending() -> Option<PendingDeviceFormat> {
        Some(PendingDeviceFormat {
            target: DeviceFormatTarget::Microphone("Desk".into()),
            format: DeviceFormat::Microphone(
                cap_recording::feeds::microphone::MicrophoneDeviceSettings {
                    sample_rate: Some(48_000),
                    channels: Some(1),
                },
            ),
            epoch: 7,
        })
    }

    #[test]
    fn format_preference_is_saved_once_after_readiness_not_while_pending() {
        let mut request = pending();
        let mut writes = Vec::new();
        assert!(
            complete_format_request(&mut request, None, true, |_, _| panic!(
                "pending input cannot save"
            ))
            .is_none()
        );
        assert!(request.is_some());
        let result = complete_format_request(&mut request, Some(Ok(())), true, |target, format| {
            writes.push((target.clone(), format));
            true
        })
        .unwrap()
        .unwrap();
        assert!(request.is_none());
        assert_eq!(
            writes,
            vec![(DeviceFormatTarget::Microphone("Desk".into()), result)]
        );
        assert!(
            complete_format_request(&mut request, Some(Ok(())), true, |_, _| panic!(
                "duplicate acknowledgement cannot save"
            ))
            .is_none()
        );
    }

    #[test]
    fn failed_or_unowned_format_acknowledgements_do_not_save() {
        for (result, owned) in [
            (Err("input disconnected".into()), true),
            (Ok(()), false),
            (Err("selection changed".into()), false),
        ] {
            let mut request = pending();
            let completion = complete_format_request(&mut request, Some(result), owned, |_, _| {
                panic!("failed or stale input cannot save")
            });
            assert!(request.is_none());
            if owned {
                assert!(completion.unwrap().is_err());
            } else {
                assert!(completion.is_none());
            }
        }
    }

    #[test]
    fn format_save_error_does_not_report_success() {
        let mut request = pending();
        let error = complete_format_request(&mut request, Some(Ok(())), true, |_, _| false)
            .unwrap()
            .unwrap_err();
        assert!(error.contains("Could not save"));
        assert!(request.is_none());
    }
}

#[cfg(test)]
mod recording_start_permit_tests {
    use super::*;

    #[test]
    fn start_dispatch_rejects_owned_inputs_before_any_side_effect() {
        for phase in [
            Phase::Idle,
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            for owned in [false, true] {
                for preparing in [false, true] {
                    let mut inputs = ("original camera", "original microphone");
                    let result = RecordingStartPermit::prepare(phase, owned, preparing).map(|_| {
                        inputs = ("requested camera", "requested microphone");
                    });
                    let allowed = phase == Phase::Idle && !owned && !preparing;
                    assert_eq!(result.is_ok(), allowed);
                    assert_eq!(
                        inputs,
                        if allowed {
                            ("requested camera", "requested microphone")
                        } else {
                            ("original camera", "original microphone")
                        }
                    );
                }
            }
        }
    }

    #[test]
    fn rejected_start_does_not_revoke_the_request_that_owns_preparation() {
        let current = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
        assert!(RecordingStartPermit::prepare(Phase::Idle, false, true).is_err());
        assert!(current.allows(Phase::Idle, false));
    }

    #[test]
    fn cancelled_permit_blocks_preview_storage_prompt_and_final_handoff_callbacks() {
        for stop_before in 0..5 {
            let permit = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
            let callbacks: [_; 5] = std::array::from_fn(|_| permit.clone());
            let mut started = false;
            for (step, callback) in callbacks.iter().enumerate() {
                if step == stop_before {
                    permit.cancel();
                }
                if !callback.allows(Phase::Idle, false) {
                    continue;
                }
                if step == callbacks.len() - 1 {
                    started = true;
                }
            }
            assert!(!started);
        }
    }

    #[test]
    fn observing_transition_or_clean_ownership_permanently_revokes_a_request() {
        for (phase, owned) in [
            (Phase::Starting, false),
            (Phase::Recording { paused: false }, false),
            (Phase::Stopping, false),
            (Phase::Idle, true),
        ] {
            let permit = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
            assert!(!permit.allows(phase, owned));
            assert!(!permit.allows(Phase::Idle, false));
        }
    }

    #[test]
    fn stale_completion_cannot_revoke_a_later_start_permit() {
        let previous = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
        let completion = previous.clone();
        assert!(completion.same(&previous));
        previous.cancel();
        let current = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
        assert!(!completion.same(&current));
        completion.cancel();
        assert!(current.allows(Phase::Idle, false));
    }

    #[test]
    fn cancel_current_rejects_queued_callbacks_after_rearm() {
        let first = RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap();
        let callbacks: [_; 3] = std::array::from_fn(|_| first.clone());
        let mut retained = Some(first);
        assert!(RecordingStartPermit::cancel_current(&mut retained));
        assert!(retained.is_none());
        retained = Some(RecordingStartPermit::prepare(Phase::Idle, false, false).unwrap());

        for callback in callbacks {
            assert!(!callback.allows(Phase::Idle, false));
            assert!(!retained.as_ref().unwrap().same(&callback));
            callback.cancel();
            assert!(retained.as_ref().unwrap().allows(Phase::Idle, false));
        }
        assert!(RecordingStartPermit::cancel_current(&mut retained));
        assert!(!RecordingStartPermit::cancel_current(&mut retained));
    }

    #[test]
    fn editor_recording_mode_does_not_change_the_normal_preference() {
        for preferred in [Mode::Instant, Mode::Studio, Mode::Screenshot] {
            assert_eq!(effective_recording_mode(preferred, true), Mode::Studio);
            assert_eq!(effective_recording_mode(preferred, false), preferred);
        }
    }
}

#[cfg(test)]
mod mode_hover_tests {
    use super::{Mode, ModeHoverState};

    #[test]
    fn moving_between_trigger_and_card_keeps_the_card_open_in_either_event_order() {
        for enter_first in [false, true] {
            let mut hover = ModeHoverState::default();
            hover.update(Mode::Studio, false, true);
            hover.visible = Some(Mode::Studio);
            if enter_first {
                hover.update(Mode::Studio, true, true);
                hover.update(Mode::Studio, false, false);
            } else {
                hover.update(Mode::Studio, false, false);
                hover.update(Mode::Studio, true, true);
            }
            assert_eq!(hover.target(), Some(Mode::Studio));
            hover.update(Mode::Studio, true, false);
            assert_eq!(hover.target(), None);
        }
    }

    #[test]
    fn late_leave_from_previous_trigger_does_not_dismiss_the_new_mode() {
        let mut hover = ModeHoverState::default();
        hover.update(Mode::Instant, false, true);
        hover.update(Mode::Studio, false, true);
        hover.update(Mode::Instant, false, false);
        assert_eq!(hover.target(), Some(Mode::Studio));
        hover.update(Mode::Studio, false, false);
        assert_eq!(hover.target(), None);
    }

    #[test]
    fn switching_from_a_card_to_another_mode_does_not_restore_the_removed_card() {
        let mut hover = ModeHoverState::default();
        hover.update(Mode::Instant, true, true);
        hover.visible = Some(Mode::Instant);
        hover.update(Mode::Studio, false, true);
        assert_eq!(hover.target(), Some(Mode::Studio));
        hover.update(Mode::Studio, false, false);
        assert_eq!(hover.target(), None);
        hover.update(Mode::Instant, true, false);
        assert_eq!(hover.target(), None);
    }
}

#[cfg(test)]
mod recording_error_panel_tests {
    use super::*;

    #[test]
    fn clean_capture_resume_requires_the_acknowledged_active_paused_session() {
        for phase in [
            Phase::Idle,
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            for active in [false, true] {
                for acknowledged in [false, true] {
                    assert_eq!(
                        clean_capture_resume_available(phase, active, acknowledged),
                        active && acknowledged && phase == (Phase::Recording { paused: true }),
                    );
                }
            }
        }
    }

    #[test]
    fn long_error_keeps_bounded_scrollable_text() {
        let mut element = recording_error_text("Requested microphone unavailable. ".repeat(200));
        let style = element.style();
        assert_eq!(style.max_size.height, Some(px(48.).into()));
        assert_eq!(style.min_size.height, Some(px(0.).into()));
        assert_eq!(style.overflow.x, Some(gpui::Overflow::Scroll));
        assert_eq!(style.overflow.y, Some(gpui::Overflow::Scroll));
    }

    #[test]
    fn unbroken_error_keeps_both_scroll_axes() {
        let mut element = recording_error_text("x".repeat(8192));
        let style = element.style();
        assert_eq!(style.max_size.height, Some(px(48.).into()));
        assert_eq!(style.overflow.x, Some(gpui::Overflow::Scroll));
        assert_eq!(style.overflow.y, Some(gpui::Overflow::Scroll));
    }

    #[test]
    fn dismiss_clears_only_matching_idle_error() {
        let shown = "Requested microphone unavailable. ".repeat(200);
        let mut current = Some(shown.clone());
        assert!(clear_shown_idle_error(Phase::Idle, &mut current, &shown));
        assert!(current.is_none());
        assert!(!clear_shown_idle_error(Phase::Idle, &mut current, &shown));
    }

    #[test]
    fn stale_dismiss_retains_new_error() {
        let mut current = Some("A different failure".to_owned());
        assert!(!clear_shown_idle_error(
            Phase::Idle,
            &mut current,
            "Old failure"
        ));
        assert_eq!(current.as_deref(), Some("A different failure"));
    }

    #[test]
    fn dismiss_never_clears_active_or_unconfirmed_cleanup_error() {
        for phase in [
            Phase::Starting,
            Phase::Recording { paused: false },
            Phase::Recording { paused: true },
            Phase::Stopping,
        ] {
            let mut current = Some("Capture cleanup is unconfirmed".to_owned());
            assert!(!clear_shown_idle_error(
                phase,
                &mut current,
                "Capture cleanup is unconfirmed",
            ));
            assert_eq!(current.as_deref(), Some("Capture cleanup is unconfirmed"));
        }
    }
}
