//! The main recording window.
//!
//! Every metric here is transcribed from the Tauri implementation
//! (`apps/desktop/src/routes/(window-chrome)/new-main/index.tsx` and its
//! siblings) so the two windows are pixel-comparable. Tailwind classes are
//! quoted next to the values they turn into, because `pl-3` and `gap-2.5` are
//! considerably easier to check against the original than `12.` and `10.`.

use cap_recording::sources::screen_capture::ScreenCaptureTarget;
use gpui::{
    Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Render,
    SharedString, StatefulInteractiveElement, Styled, Window, div, img, prelude::FluentBuilder, px,
    rgb, svg,
};

use crate::{
    MAIN_WINDOW_HEIGHT, MAIN_WINDOW_WIDTH, app_windows,
    devices::{CameraOption, DeviceSnapshot, DisplayOption, MicrophoneOption, WindowOption},
    feeds::{self, Feeds},
    recording,
    session::{Phase, RecordingSession},
    theme::{Appearance, Theme},
};
use gpui::Entity;

/// `MAIN_WINDOW_SIZE.expanded` in index.tsx.
const EXPANDED_WIDTH: f32 = 600.;
const EXPANDED_HEIGHT: f32 = 660.;

/// `duration: 180` in `resizeMainWindow`.
const RESIZE_DURATION_SECS: f32 = 0.18;

/// `h-9` on `.cap-window-header`.
const HEADER_HEIGHT: f32 = 36.;
/// `h-[42px]` in deviceRowStyles.ts.
const DEVICE_ROW_HEIGHT: f32 = 42.;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Instant,
    Studio,
    Screenshot,
}

impl Mode {
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
}

pub struct MainWindow {
    theme: Theme,
    expanded: bool,
    mode: Mode,
    target: Option<TargetType>,
    devices: DeviceSnapshot,
    camera: Option<CameraOption>,
    microphone: Option<MicrophoneOption>,
    system_audio: bool,
    /// Which display/window is selected for each split target.
    selected_display: Option<DisplayOption>,
    selected_window: Option<WindowOption>,
    panel: Option<Panel>,
    /// Holds the in-flight expand/collapse animation. Dropping it cancels,
    /// which is how a second toggle mid-animation takes over cleanly.
    resize_task: Option<gpui::Task<()>>,
    /// Live filter text for the device and target panels.
    search: String,
    search_focus: gpui::FocusHandle,
    /// True until the background enumeration has reported back, so the panel can
    /// say "Loading..." rather than "No cameras found".
    enumerating: bool,
    /// The app-wide recording session; the lifecycle itself lives there so the
    /// controls bar window can drive the same recording.
    session: Entity<RecordingSession>,
}

impl MainWindow {
    pub fn new(
        session: Entity<RecordingSession>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let theme = Theme::new(Appearance::from_window(window.appearance()));
        cx.observe(&session, |_, _, cx| cx.notify()).detach();

        // Track the app-scoped feeds: the camera bubble's close button
        // deselects the camera there, and this window's selection has to
        // follow. Repaints are gated to what is actually visible -- the mic
        // meter notifies at ~20Hz and would otherwise repaint the home view
        // for a level bar only the microphone picker shows.
        let feeds = Feeds::global(cx);
        cx.observe(&feeds, |this: &mut Self, feeds, cx| {
            let feeds = feeds.read(cx);
            if this.camera.is_some() && feeds.camera.is_none() {
                this.camera = None;
                cx.notify();
            } else if matches!(this.panel, Some(Panel::Device(_))) {
                cx.notify();
            }
        })
        .detach();

        // Enumeration hits AVFoundation and the window server, so it must not
        // run on the main thread -- doing it inline here costs ~180ms of a
        // blank window on this machine, and more on a machine with more
        // capture devices.

        Self {
            theme,
            expanded: false,
            mode: Mode::Instant,
            target: None,
            devices: DeviceSnapshot::default(),
            camera: None,
            microphone: None,
            system_audio: false,
            selected_display: None,
            selected_window: None,
            panel: None,
            resize_task: None,
            search: String::new(),
            search_focus: cx.focus_handle(),
            enumerating: true,
            session,
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

            this.update_in(cx, |this, _window, cx| {
                tracing::info!(
                    cameras = snapshot.cameras.len(),
                    microphones = snapshot.microphones.len(),
                    displays = snapshot.displays.len(),
                    windows = snapshot.windows.len(),
                    "enumerated capture devices"
                );
                this.devices = snapshot;
                this.enumerating = false;

                // `CAP_GPUI_AUTO_CAMERA=1`: select the first camera the way a
                // click would -- the automated check drives the preview window
                // this way because synthetic clicks are dropped.
                if std::env::var("CAP_GPUI_AUTO_CAMERA").is_ok_and(|v| v == "1")
                    && this.camera.is_none()
                    && let Some(first) = this.devices.cameras.first().cloned()
                {
                    tracing::info!(camera = %first.label, "auto-selecting camera");
                    this.camera = Some(first.clone());
                    Feeds::global(cx).update(cx, |feeds, cx| {
                        feeds.set_camera(
                            Some(feeds::SelectedCamera {
                                id: recording::DeviceOrModelID::DeviceID(first.device_id.clone()),
                                label: first.label,
                            }),
                            cx,
                        )
                    });
                }
                cx.notify();
            })
            .unwrap_or_else(|error| tracing::error!("device enumeration update failed: {error:#}"));
        })
        .detach();
    }

    fn toggle_expanded(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let from = self.window_size();
        self.expanded = !self.expanded;
        let to = self.window_size();
        tracing::info!(expanded = self.expanded, "toggling main window size");

        // Matches `resizeMainWindow`: 180ms, ease-out cubic.
        //
        // Assigning over the previous task drops it, which cancels a toggle
        // that is still in flight -- otherwise two animations would fight over
        // `resize` and the window could settle at an interpolated size.
        self.resize_task = Some(cx.spawn_in(window, async move |this, cx| {
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
        let appearance = Appearance::from_window(window.appearance());
        let material = crate::platform::active_material(cx);
        if appearance != self.theme.appearance || material != self.theme.material_kind() {
            self.theme = Theme::new(appearance).with_material(material);
        }
    }

    /// `CAP_GPUI_AUTO_EXPAND=1`: open expanded, the way clicking the zoom
    /// light does. Same reason as the other `CAP_GPUI_AUTO_*` hooks --
    /// unprivileged synthetic clicks are dropped, so the screenshot harness
    /// needs a way in.
    pub fn auto_expand(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if std::env::var("CAP_GPUI_AUTO_EXPAND").is_ok_and(|value| value == "1") && !self.expanded {
            self.toggle_expanded(window, cx);
        }
    }

    /// Bring the target-select overlays in line with the armed target.
    ///
    /// Deferred, because opening a window inside an entity update paints it
    /// synchronously and double-leases this very view. This mirrors
    /// `toggleTargetMode` / `selectDisplayTarget` / `selectWindowTarget` in
    /// the Tauri main window, which each call `openTargetSelectOverlays` (or
    /// `closeTargetSelectOverlays`) right after setting the mode.
    fn sync_overlays(&self, cx: &mut Context<Self>) {
        let Some(mode) = self.target else {
            cx.defer(app_windows::close_target_overlays);
            return;
        };
        let request = app_windows::OverlayRequest {
            mode,
            recording_mode: self.mode,
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
                TargetType::Window => self.selected_window.as_ref().map(|window| window.id.clone()),
                _ => None,
            },
        };
        cx.defer(move |cx: &mut gpui::App| app_windows::open_target_overlays(request, cx));
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

    /// `handleModeChange`: `setOptions({ mode })` plus
    /// `commands.setRecordingMode(mode)`. The pill, the info panel and the mode
    /// select window all land here, so there is one place a mode change
    /// happens.
    pub fn set_mode(&mut self, mode: Mode, cx: &mut Context<Self>) {
        if self.mode == mode {
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
            TargetType::Window => self
                .selected_window
                .as_ref()
                .map(|window| ScreenCaptureTarget::Window {
                    id: window.id.clone(),
                }),
            TargetType::Area => None,
            TargetType::CameraOnly => Some(ScreenCaptureTarget::CameraOnly),
        }
    }

    /// The recording mode the Mode pill maps to, `None` for Screenshot (that
    /// path does not go through the recording actors at all).
    fn recording_mode(&self) -> Option<recording::RecordingMode> {
        match self.mode {
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
        cx.notify();

        // `CAP_GPUI_AUTO_PAUSE=1`: wiggle pause/resume in the middle third, so
        // ffprobe duration < wall time proves the pause reached the engine.
        let pause_wiggle = std::env::var("CAP_GPUI_AUTO_PAUSE").is_ok_and(|v| v == "1");

        cx.spawn_in(window, async move |this, cx| {
            // Give enumeration and the first paint a moment; the recorder
            // itself does not depend on it, but the screenshots should show
            // real device rows.
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
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
                    this.microphone = default_mic
                        .and_then(|name| {
                            this.devices
                                .microphones
                                .iter()
                                .find(|mic| mic.name == name)
                                .cloned()
                        })
                        .or_else(|| this.devices.microphones.first().cloned());
                    if let Some(mic) = &this.microphone {
                        tracing::info!(mic = %mic.name, "auto-record microphone");
                        // Through the app-scoped feed, so the automated run
                        // exercises the same lock path a clicked selection uses.
                        let name = mic.name.clone();
                        Feeds::global(cx)
                            .update(cx, |feeds, cx| feeds.set_microphone(Some(name), cx));
                    }
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

            let started = match overlay {
                None => this
                    .update_in(cx, |this, window, cx| this.start_recording(window, cx))
                    .is_ok(),
                Some(kind) => {
                    // The overlay route: arm the mode (which opens the
                    // overlays), let them come up, seed what a drag or a hover
                    // would have produced, then press their Start button.
                    if this
                        .update_in(cx, |this, _window, cx| this.arm_overlay(kind, cx))
                        .is_err()
                    {
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
                    cx.update(|_, cx| app_windows::start_from_overlay(None, cx))
                        .unwrap_or(false)
                }
            };
            if !started {
                tracing::error!("auto-record could not start");
                return;
            }

            let third = std::time::Duration::from_secs(record_secs.div_ceil(3));
            let toggle = |this: &gpui::WeakEntity<Self>,
                          cx: &mut gpui::AsyncWindowContext| {
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
            this.update_in(cx, |this, _, cx| {
                this.session.update(cx, |session, cx| session.stop(cx));
            })
            .ok();
        })
        .detach();
    }

    /// Arm a target mode the way clicking its tile does, picking a concrete
    /// window for the window variant since the harness cannot hover one.
    fn arm_overlay(&mut self, kind: TargetType, cx: &mut Context<Self>) {
        if kind == TargetType::Window {
            self.selected_window = self.devices.windows.first().cloned();
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
        if self.session.read(cx).phase != Phase::Idle {
            return;
        }
        let Some(mode) = self.recording_mode() else {
            return;
        };
        if matches!(target, ScreenCaptureTarget::CameraOnly) && self.camera.is_none() {
            self.session.update(cx, |session, cx| {
                session.error = Some("Camera-only recording requires a selected camera.".into());
                cx.notify();
            });
            return;
        }

        let (camera_feed, mic_feed) = {
            let feeds = Feeds::global(cx);
            let feeds = feeds.read(cx);
            (feeds.camera_actor(), feeds.mic_actor())
        };
        let config = recording::StartConfig {
            mode,
            target,
            microphone: self.microphone.as_ref().map(|mic| mic.name.clone()),
            camera: self
                .camera
                .as_ref()
                .map(|camera| recording::DeviceOrModelID::DeviceID(camera.device_id.clone())),
            system_audio: self.system_audio,
            excluded_windows,
            camera_feed,
            mic_feed,
        };

        cx.defer(move |cx: &mut gpui::App| app_windows::begin_recording(config, cx));
    }
}

impl Render for MainWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_appearance(window, cx);
        let theme = self.theme;

        div()
            .size_full()
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
            .text_color(theme.text_primary)
            .child(self.render_header(window, cx))
            .child(self.render_body(cx))
            .when(
                // The controls bar owns the live-recording UI; this overlay is
                // the fallback for when the bar window failed to open.
                {
                    let session = self.session.read(cx);
                    session.phase != Phase::Idle && !session.controls_open
                },
                |this| this.child(self.render_recording_overlay(cx)),
            )
    }
}

impl MainWindow {
    fn render_header(&self, window: &Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let focused = window.is_window_active();

        div()
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
            .child(self.render_traffic_lights(focused, cx))
            .child(self.render_header_actions(cx))
    }

    /// `CaptionControlsMacOS`: 14px circles (`size-3.5`), 10px apart
    /// (`gap-2.5`), 12px from the left edge (`ml-3`). Minimize is not drawn --
    /// the main window passes `showMinimize={false}` -- and zoom is bound to
    /// expand/collapse rather than a real window zoom.
    fn render_traffic_lights(&self, focused: bool, cx: &mut Context<Self>) -> impl IntoElement {
        let light = |color: u32, id: &'static str| {
            div()
                .id(id)
                .size(px(14.))
                .rounded_full()
                .bg(if focused {
                    rgb(color)
                } else {
                    rgb(Theme::TRAFFIC_INACTIVE)
                })
                .cursor_default()
        };

        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .h_full()
            .ml(px(12.))
            .flex_shrink_0()
            .child(
                light(Theme::TRAFFIC_CLOSE, "traffic-close").on_click(cx.listener(
                    |_, _, _window, cx| {
                        cx.quit();
                    },
                )),
            )
            .child(
                light(Theme::TRAFFIC_ZOOM, "traffic-zoom").on_click(cx.listener(
                    |this, _, window, cx| {
                        this.toggle_expanded(window, cx);
                    },
                )),
            )
    }

    /// The teleported header content: a help button, a drag spacer, then the
    /// right-hand cluster. 20px hit targets (`size-5`) 4px apart (`gap-1`),
    /// 8px from the window edges (`mx-2`).
    fn render_header_actions(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let expanded = self.expanded;

        let icon_button = |id: &'static str, path: &'static str, size: f32| {
            div()
                .id(SharedString::from(id))
                .flex()
                .items_center()
                .justify_center()
                .size(px(20.))
                .flex_shrink_0()
                .child(svg().path(path).size(px(size)).text_color(theme.gray_11))
                .hover(|style| style.text_color(theme.gray_12))
        };

        div()
            .flex()
            .flex_1()
            .items_center()
            .gap(px(4.))
            .mx(px(8.))
            .min_w_0()
            .child(icon_button("help", "icons/circle-help.svg", 16.))
            // The drag handle, and *only* this. The Tauri header puts
            // `data-tauri-drag-region` on the header and this spacer but not on
            // the buttons; putting the handler on the header root instead makes
            // every mouse-down in the header start a window drag, which eats
            // the button clicks before they are delivered.
            .child(
                div()
                    .id("drag-region")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .on_mouse_down(gpui::MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    }),
            )
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
                    .child(icon_button("screenshots", "icons/image.svg", 16.))
                    .child(icon_button("recordings", "icons/play-circle.svg", 16.))
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
                    .child(icon_button("changelog", "icons/bell.svg", 16.)),
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
                    // w-full` -- expanded overflows 660px once Recents is in, so
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
                    |this, error| {
                        this.child(
                            div()
                                .flex_shrink_0()
                                .text_size(px(11.))
                                .text_color(self.theme.red_9)
                                .text_center()
                                .child(error),
                        )
                    },
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
                        this.hover(|style| style.bg(theme.red_10)).on_click(cx.listener(
                            |this, _, _window, cx| {
                                this.session.update(cx, |session, cx| session.stop(cx));
                            },
                        ))
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
            Panel::Device(_) | Panel::Target(_) => {
                self.render_search_field(panel, cx).into_any_element()
            }
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
                            .on_click(cx.listener(|this, _, _window, cx| this.close_panel(cx))),
                    )
                    .child(header_trailing),
            )
            .child(
                div()
                    .id("panel-body")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .pt(px(16.))
                    .px(px(8.))
                    .gap(px(8.))
                    .overflow_y_scroll()
                    .child(match panel {
                        Panel::Device(menu) => self.render_device_list(menu, cx).into_any_element(),
                        Panel::Target(target) => {
                            self.render_target_grid(target, cx).into_any_element()
                        }
                        Panel::ModeInfo => self.render_mode_info(cx).into_any_element(),
                    }),
            )
    }

    fn close_panel(&mut self, cx: &mut Context<Self>) {
        self.panel = None;
        self.search.clear();
        cx.notify();
    }

    pub fn open_panel(&mut self, panel: Panel, window: &mut Window, cx: &mut Context<Self>) {
        self.panel = Some(panel);
        self.search.clear();
        if matches!(panel, Panel::Device(_) | Panel::Target(_)) {
            window.focus(&self.search_focus, cx);
        }
        cx.notify();
    }

    /// A single-line text input, hand-rolled: gpui ships no stock one.
    ///
    /// Focus is tracked so the panel keeps receiving keys, `key_char` supplies
    /// the typed character (which is what handles dead keys and option-layouts,
    /// rather than reading `key` directly), and the caret is a plain 1px div --
    /// it does not blink, and there is no selection or cursor movement. That is
    /// enough for a filter field and nothing more.
    fn render_search_field(&self, panel: Panel, cx: &mut Context<Self>) -> gpui::Div {
        let theme = self.theme;
        let placeholder = match panel {
            Panel::Target(TargetType::Display) => "Search displays",
            Panel::Target(TargetType::Window) => "Search windows",
            Panel::Device(DeviceMenu::Camera) => "Search cameras",
            Panel::Device(DeviceMenu::Microphone) => "Search microphones",
            _ => "Search",
        };
        let empty = self.search.is_empty();

        div()
            .track_focus(&self.search_focus)
            .on_key_down(
                cx.listener(|this, event: &gpui::KeyDownEvent, _window, cx| {
                    let keystroke = &event.keystroke;

                    match keystroke.key.as_str() {
                        // First Escape clears the filter, a second one leaves.
                        "escape" => {
                            if this.search.is_empty() {
                                this.close_panel(cx);
                            } else {
                                this.search.clear();
                                cx.notify();
                            }
                            return;
                        }
                        "backspace" => {
                            this.search.pop();
                            cx.notify();
                            return;
                        }
                        _ => {}
                    }

                    // Command/control chords are shortcuts, not text.
                    if keystroke.modifiers.platform || keystroke.modifiers.control {
                        return;
                    }

                    if let Some(text) = keystroke.key_char.as_ref()
                        && !text.is_empty()
                        && !text.chars().any(char::is_control)
                    {
                        this.search.push_str(text);
                        cx.notify();
                    }
                }),
            )
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .flex_1()
            .min_w_0()
            .h(px(36.))
            .px(px(8.))
            .rounded(px(6.))
            .border_1()
            .border_color(theme.body_border(5))
            .bg(theme.body_fill(2))
            .text_size(px(12.))
            .child(
                svg()
                    .path("icons/search.svg")
                    .size(px(12.))
                    .flex_shrink_0()
                    .text_color(theme.gray_10),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(if empty { theme.gray_10 } else { theme.gray_12 })
                    .child(if empty {
                        placeholder.to_string()
                    } else {
                        self.search.clone()
                    }),
            )
            .when(!empty, |this| {
                this.child(div().w(px(1.)).h(px(14.)).flex_shrink_0().bg(theme.gray_12))
            })
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

    fn render_device_list(&self, menu: DeviceMenu, cx: &mut Context<Self>) -> gpui::Div {
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
                    match menu {
                        DeviceMenu::Camera => {
                            this.camera = None;
                            Feeds::global(cx).update(cx, |feeds, cx| feeds.set_camera(None, cx));
                        }
                        DeviceMenu::Microphone => {
                            this.microphone = None;
                            Feeds::global(cx)
                                .update(cx, |feeds, cx| feeds.set_microphone(None, cx));
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
                        self.render_device_list_row(
                            SharedString::from(format!("camera-{}", camera.device_id)),
                            menu.icon(),
                            camera.label.clone(),
                            camera.best_format.map(|format| format.describe()),
                            selected,
                            None,
                            cx.listener(move |this, _, _window, cx| {
                                this.camera = Some(chosen.clone());
                                Feeds::global(cx).update(cx, |feeds, cx| {
                                    feeds.set_camera(
                                        Some(feeds::SelectedCamera {
                                            id: recording::DeviceOrModelID::DeviceID(
                                                chosen.device_id.clone(),
                                            ),
                                            label: chosen.label.clone(),
                                        }),
                                        cx,
                                    )
                                });
                                this.close_panel(cx);
                            }),
                        )
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
                        self.render_device_list_row(
                            SharedString::from(format!("mic-{}", mic.name)),
                            menu.icon(),
                            mic.name.clone(),
                            mic.describe(),
                            selected,
                            selected.then(|| {
                                feeds::picker_level(Feeds::global(cx).read(cx).mic_level_db)
                            }),
                            cx.listener(move |this, _, _window, cx| {
                                this.microphone = Some(chosen.clone());
                                Feeds::global(cx).update(cx, |feeds, cx| {
                                    feeds.set_microphone(Some(chosen.name.clone()), cx)
                                });
                                this.close_panel(cx);
                            }),
                        )
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

    /// `TargetMenuGrid`: two columns of cards.
    ///
    /// The real cards lead with a live thumbnail of the display or window; that
    /// needs the capture pipeline, so these render the same fallback the Tauri
    /// card falls back to when no thumbnail has arrived -- the target's icon on
    /// `gray-4`.
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

        // Two columns, laid out as rows of two so the cards stretch evenly.
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
                    // Keep a lone trailing card at half width rather than
                    // letting it span the grid.
                    if pair.len() == 1 {
                        row = row.child(div().flex_1());
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
            .flex_1()
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
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .w_full()
                    .h(px(76.))
                    .bg(theme.body_fill(4))
                    .child(svg().path(icon).size(px(24.)).text_color(theme.gray_9)),
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

        div().flex().flex_col().gap(px(8.)).w_full().children(
            [Mode::Instant, Mode::Studio, Mode::Screenshot].map(|mode| {
                let selected = mode == self.mode;

                div()
                    .id(SharedString::from(mode.panel_title()))
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
                                    .font_weight(FontWeight::SEMIBOLD)
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

    fn render_empty_state(&self, message: &'static str) -> gpui::AnyElement {
        div()
            .py(px(24.))
            .w_full()
            .text_size(px(14.))
            .text_color(self.theme.gray_11)
            .child(message)
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

    /// `mt-[16px] mb-[6px]`, logo `w-[92px]`, Mode pill on the right.
    fn render_logo_row(&self, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .mt(px(16.))
            .mb(px(6.))
            .flex_shrink_0()
            .child(
                // `flex items-center space-x-1` around the logo and its badge.
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(4.))
                    .child(self.render_logo())
                    .child(self.render_plan_badge()),
            )
            .child(self.render_mode_pill(cx))
    }

    /// The plan badge: `text-[0.6rem] ml-2 rounded-lg border border-gray-5
    /// px-1 py-0.5 bg-gray-3 hover:bg-gray-5`.
    ///
    /// Only the free variant is drawn. The Pro and Commercial badges are a
    /// non-interactive span on `--blue-400`, and which one applies comes from
    /// the license query -- there is no auth or license plumbing here yet, so
    /// claiming a plan would be worse than showing the free one.
    fn render_plan_badge(&self) -> impl IntoElement {
        let theme = self.theme;

        div()
            .id("plan-badge")
            .flex()
            .items_center()
            .flex_shrink_0()
            .ml(px(8.))
            .px(px(4.))
            .py(px(2.))
            .rounded(px(8.))
            .border_1()
            .border_color(theme.body_border(5))
            .bg(theme.body_fill(3))
            .text_size(px(9.6))
            .text_color(theme.gray_12)
            .child("Personal")
            .hover(|style| style.bg(theme.body_hover_fill(5)))
        // TODO: opens the Upgrade window (950x850) once that window exists.
    }

    /// `*:w-[92px]` on the logo link, against a 103x40 viewBox, so the lockup
    /// is 92x35.7.
    ///
    /// This goes through `img()`, not `svg()`. The two take different paths in
    /// gpui: `svg()` keeps only the alpha and tints it with one colour, which
    /// would flatten the badge, the three blue rings and the wordmark into a
    /// single silhouette, whereas `img()` rasterises through resvg and keeps
    /// the colour. `img()` also renders at `SMOOTH_SVG_SCALE_FACTOR` (2x), so
    /// the 103px-wide source becomes a 206px raster -- more than the 184 device
    /// pixels a 92px lockup needs on a 2x display.
    ///
    /// The app ships two files rather than recolouring one, so this picks the
    /// same way it does.
    fn render_logo(&self) -> impl IntoElement {
        img(if self.theme.is_dark() {
            "icons/logo-full-dark.svg"
        } else {
            "icons/logo-full.svg"
        })
        .w(px(92.))
        .h(px(92. * 40. / 103.))
        .flex_shrink_0()
    }

    /// `Mode.tsx`: `p-1.5 gap-2 rounded-full border border-gray-5 bg-gray-3`,
    /// 28px round buttons (`size-7`). Selected gets `bg-gray-7` plus a 2px
    /// `blue-500` ring offset 1px against `gray-1`.
    fn render_mode_pill(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let selected_mode = self.mode;

        let button = |mode: Mode, id: &'static str| {
            let selected = mode == selected_mode;
            div()
                .id(SharedString::from(id))
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
                    svg()
                        .path(mode.icon())
                        .size(px(mode.icon_size()))
                        .text_color(theme.gray_12),
                )
                .hover(|style| style.bg(theme.body_hover_fill(7)))
                .on_click(cx.listener(move |this, _, _window, cx| {
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
            .child(button(Mode::Instant, "mode-instant"))
            .child(button(Mode::Studio, "mode-studio"))
            .child(button(Mode::Screenshot, "mode-screenshot"))
            // `absolute -left-1.5 -top-2 p-1 rounded-full bg-gray-5`, hanging
            // off the pill's top-left corner.
            .child(
                div()
                    .id("mode-info")
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
            .when(self.expanded, |this| {
                this.child(
                    // `px-1 pb-0.5` + `text-xs font-semibold text-gray-12`.
                    div().px(px(4.)).pb(px(2.)).child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(self.theme.gray_12)
                            .child("Capture"),
                    ),
                )
            })
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
            .child(self.target_button_inner(target, true, cx))
            .child(
                div()
                    .id(SharedString::from(format!("{}-dropdown", target.label())))
                    .flex()
                    .w(px(28.))
                    .flex_shrink_0()
                    .items_center()
                    .justify_center()
                    .border_l_1()
                    .border_color(theme.body_border(6))
                    .bg(theme.body_fill(4))
                    .child(
                        svg()
                            .path("icons/chevron-down.svg")
                            .size(px(16.))
                            .text_color(theme.gray_11),
                    )
                    .hover(|style| style.bg(theme.body_hover_fill(6)))
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
            // `hover:bg-blue-4` / `dark:hover:bg-blue-4/40` when selected,
            // `hover:bg-gray-4` otherwise.
            .hover(move |style| {
                style.bg(if selected {
                    theme.tile_selected_hover_bg()
                } else {
                    theme.body_hover_fill(4)
                })
            })
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
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(label_color)
                                .child(target.label()),
                        )
                        .child(
                            div()
                                .text_size(px(10.))
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
                        .text_color(label_color)
                        .child(target.label()),
                )
        }
    }

    /// `BaseControls`: camera, microphone, system audio.
    fn render_base_controls(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let gap = if self.expanded { 10. } else { 8. };

        div()
            .flex()
            .flex_col()
            .gap(px(gap))
            .w_full()
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
                            PillState::On
                        } else {
                            PillState::Off
                        },
                    )
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.panel = Some(Panel::Device(DeviceMenu::Camera));
                        cx.notify();
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
                            PillState::On
                        } else {
                            PillState::Off
                        },
                    )
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.panel = Some(Panel::Device(DeviceMenu::Microphone));
                        cx.notify();
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
                    )
                    // System audio has no device to choose, so the row is a
                    // plain toggle rather than a picker.
                    .on_click(cx.listener(|this, _, _window, cx| {
                        this.system_audio = !this.system_audio;
                        cx.notify();
                    })),
                ),
            )
    }

    /// `Recents.tsx`, expanded only.
    ///
    /// Thumbnails need the recordings library, so only the header and the empty
    /// state are here -- which is what the real section shows on a machine with
    /// no captures yet anyway.
    fn render_recents(&self) -> impl IntoElement {
        let theme = self.theme;

        div()
            // `<div class="pt-2">` around the section in index.tsx.
            .pt(px(8.))
            .w_full()
            .flex_shrink_0()
            .child(
                // `mb-2 flex items-center px-0.5`.
                div().flex().items_center().mb(px(8.)).px(px(2.)).child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.gray_12)
                        .child("Recents"),
                ),
            )
            .child(
                // `h-28 ... rounded-xl border border-dashed border-gray-5 bg-gray-2`.
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .w_full()
                    .h(px(112.))
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
                    ),
            )
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
                            .font_weight(FontWeight::SEMIBOLD)
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
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;

        div()
            .id(SharedString::from(id))
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
            .child(pill.render(theme))
            // `hover:border-gray-8` is not one of the classes theme.css remaps, so
        // the border keeps its Radix step under the material.
        .hover(|style| {
            style
                .bg(theme.body_hover_fill(4))
                .border_color(theme.gray_8)
        })
    }
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
}

impl PillState {
    fn render(self, theme: Theme) -> impl IntoElement {
        let (bg, fg, text) = match self {
            Self::On => (Hsla::from(theme.blue_9), gpui::white(), "On"),
            Self::Off => (theme.body_fill(5), Hsla::from(theme.gray_11), "Off"),
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
