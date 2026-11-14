//! The in-progress recording bar -- `in-progress-recording.tsx`, natively.
//!
//! A 320x150 transparent panel whose visible content is a 40px card hugging the
//! bottom: stop button with the elapsed timer on the left, mic indicator and
//! action buttons on the right, a drag handle on the trailing edge. The window
//! itself is a non-activating panel at the maximum window level (see
//! `app_windows`), so the buttons work without pulling focus from whatever is
//! being recorded.

use std::time::Duration;

use gpui::{
    AppContext as _, Context, Entity, FontWeight, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled,
    Window, div, prelude::FluentBuilder as _, px, svg,
};

use crate::i18n::tr;
use crate::theme::LocaleFont as _;
use crate::{
    devices::CameraOption,
    feeds::{DeviceOrModelID, Feeds, SelectedCamera},
    recording::RecordingMode,
    session::{InputKind, InputRequest, Phase, RecordingSession},
    theme::Theme,
    ui,
};

pub struct ControlsWindow {
    session: Entity<RecordingSession>,
    theme: Theme,
    has_microphone: bool,
    #[cfg(target_os = "linux")]
    confirmation_pending: bool,
    /// Repaints the timer. An inactive window is repainted lazily by the
    /// platform, so the tick both notifies and asks for a frame explicitly.
    _tick: gpui::Task<()>,
    ticking_live: bool,
    level_bar: Entity<ui::MicrophoneLevel>,
    /// The window height last asked of the platform: the bar, plus the issue
    /// card and the settings panel when they are up.
    fitted_height: f32,
    settings_open: bool,
    settings_dismissed_at: Option<std::time::Instant>,
    microphones: Vec<String>,
    cameras: Vec<CameraOption>,
    _enumerate: gpui::Task<()>,
    /// Repaints the marker button once its acknowledgement has played out.
    _marker_settle: gpui::Task<()>,
    marker_seen: Option<std::time::Instant>,
}

/// How long the marker button stays lit after a marker goes in.
const MARKER_ACKNOWLEDGEMENT: Duration = Duration::from_millis(900);

const SETTINGS_ROW_HEIGHT: f32 = 30.;
const SETTINGS_HEADING_HEIGHT: f32 = 26.;
const SETTINGS_DIVIDER_MARGIN: f32 = 4.;
const SETTINGS_PANEL_PADDING: f32 = 4.;
const SETTINGS_PANEL_MAX_HEIGHT: f32 = 360.;
/// The card above the bar keeps this gap to it, like the issue card.
const SETTINGS_PANEL_GAP: f32 = 8.;

/// The panel's height for its rows: the camera preview switch, then each
/// heading with its rows, the dividers between them, padding and border.
/// Longer lists scroll inside the cap.
fn settings_panel_height(microphone_rows: usize, camera_rows: usize) -> f32 {
    let divider = 1. + 2. * SETTINGS_DIVIDER_MARGIN;
    let content = SETTINGS_ROW_HEIGHT
        + 2. * (divider + SETTINGS_HEADING_HEIGHT)
        + (microphone_rows + camera_rows) as f32 * SETTINGS_ROW_HEIGHT;
    (content + 2. * (SETTINGS_PANEL_PADDING + 1.)).min(SETTINGS_PANEL_MAX_HEIGHT)
}

/// The bar window's height: the bar, the issue card when one is up, and the
/// settings panel when it is open.
fn controls_height(issue: bool, settings_panel: Option<f32>) -> f32 {
    let mut height = crate::app_windows::CONTROLS_BAR_HEIGHT;
    if issue {
        height += crate::app_windows::CONTROLS_HEIGHT - crate::app_windows::CONTROLS_BAR_HEIGHT;
    }
    if let Some(panel) = settings_panel {
        height += panel + SETTINGS_PANEL_GAP;
    }
    height
}

#[derive(Clone, Copy)]
enum DestructiveAction {
    Restart,
    Delete,
}

#[cfg(target_os = "linux")]
fn controls_owner_is_current(owner: gpui::WindowId, window: &Window, cx: &gpui::App) -> bool {
    window.window_handle().window_id() == owner
        && cx
            .try_global::<crate::app_windows::AppWindows>()
            .and_then(|windows| windows.controls)
            .is_some_and(|controls| controls.window_id() == owner)
}

impl ControlsWindow {
    pub fn new(
        session: Entity<RecordingSession>,
        has_microphone: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::theme::bind_window(window, cx);
        let theme = Theme::for_window(window, cx, false);
        cx.observe_in(&session, window, |this, _, window, cx| {
            if this.settings_open && !matches!(this.session.read(cx).phase, Phase::Recording { .. })
            {
                this.settings_open = false;
            }
            this.fit_window(window, cx);
            this.settle_marker_acknowledgement(window, cx);
            let live = this.timer_is_live(cx);
            if live != this.ticking_live {
                this.ticking_live = live;
                this._tick = Self::spawn_tick(window, cx);
            }
            cx.notify();
        })
        .detach();
        cx.observe_in(&Feeds::global(cx), window, |this, _, window, cx| {
            this.fit_window(window, cx);
            cx.notify();
        })
        .detach();
        let mic_level = Feeds::global(cx).read(cx).mic_level().clone();
        let level_bar = cx.new(|cx| {
            ui::MicrophoneLevel::new(
                ui::MicrophoneLevelKind::RecordingBar,
                &mic_level,
                window,
                cx,
            )
        });

        let mut this = Self {
            session,
            theme,
            has_microphone,
            #[cfg(target_os = "linux")]
            confirmation_pending: false,
            _tick: gpui::Task::ready(()),
            ticking_live: false,
            level_bar,
            fitted_height: crate::app_windows::CONTROLS_BAR_HEIGHT,
            settings_open: false,
            settings_dismissed_at: None,
            microphones: Vec::new(),
            cameras: Vec::new(),
            _enumerate: gpui::Task::ready(()),
            _marker_settle: gpui::Task::ready(()),
            marker_seen: None,
        };
        this.ticking_live = this.timer_is_live(cx);
        this._tick = Self::spawn_tick(window, cx);
        // Once the platform window is finished: an issue may already be up.
        cx.defer_in(window, |this, window, cx| this.fit_window(window, cx));
        this
    }

    fn issue(&self, cx: &gpui::App) -> Option<String> {
        let session = self.session.read(cx);
        session
            .error
            .clone()
            .or_else(|| session.input_switch_error().map(str::to_owned))
            .or_else(|| {
                (session.paused_for_sleep && session.is_paused())
                    .then(|| tr::controls::paused_for_sleep().to_owned())
            })
            .or_else(|| {
                session
                    .storage_warning
                    .then(|| tr::controls::low_storage().to_owned())
            })
    }

    fn fit_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let panel = self.settings_open.then(|| {
            let (microphones, cameras) = self.settings_rows(cx);
            settings_panel_height(microphones, cameras)
        });
        let height = controls_height(self.issue(cx).is_some(), panel);
        if height == self.fitted_height {
            return;
        }
        self.fitted_height = height;
        let Some(native) = crate::platform::native_window(window) else {
            return;
        };
        let scale = window.scale_factor();
        cx.spawn(async move |_, _| {
            crate::app_windows::fit_controls(&native, height, scale);
        })
        .detach();
    }

    fn toggle_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The press that dismissed the open panel from outside lands here too.
        if !self.settings_open
            && self
                .settings_dismissed_at
                .is_some_and(|at| at.elapsed() < Duration::from_millis(400))
        {
            self.settings_dismissed_at = None;
            return;
        }
        self.settings_open = !self.settings_open;
        if self.settings_open {
            self.refresh_devices(window, cx);
        }
        self.fit_window(window, cx);
        cx.notify();
    }

    fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.settings_open {
            self.settings_open = false;
            self.fit_window(window, cx);
            cx.notify();
        }
    }

    /// `listAudioDevices` / `listCameras` when the menu opens, off the main
    /// thread. Until it lands the panel lists what the recording is using.
    fn refresh_devices(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let previous = self.cameras.clone();
        self._enumerate = cx.spawn_in(window, async move |this, cx| {
            let (microphones, cameras) = cx
                .background_executor()
                .spawn(async move {
                    let microphones = match crate::devices::InputSnapshot::microphones() {
                        crate::devices::InputSnapshot::Microphones(microphones) => microphones
                            .into_iter()
                            .map(|microphone| microphone.name)
                            .collect(),
                        crate::devices::InputSnapshot::Cameras(_) => Vec::new(),
                    };
                    let cameras = match crate::devices::InputSnapshot::cameras(&previous) {
                        crate::devices::InputSnapshot::Cameras(cameras) => cameras,
                        crate::devices::InputSnapshot::Microphones(_) => Vec::new(),
                    };
                    (microphones, cameras)
                })
                .await;
            this.update_in(cx, |this, window, cx| {
                this.microphones = microphones;
                this.cameras = cameras;
                this.fit_window(window, cx);
                cx.notify();
            })
            .ok();
        });
    }

    fn timer_is_live(&self, cx: &gpui::App) -> bool {
        matches!(
            self.session.read(cx).phase,
            Phase::Recording { paused: false }
        )
    }

    /// The timer shows whole seconds, so wake just after each one ticks over;
    /// `refresh` (not just `notify`) because this window is usually not the
    /// active one while a recording runs. Respawned whenever the timer starts
    /// or stops running, so a resume lines up with the next second.
    fn spawn_tick(window: &mut Window, cx: &mut Context<Self>) -> gpui::Task<()> {
        cx.spawn_in(window, async move |this, cx| {
            loop {
                let Ok(delay) = this.update_in(cx, |this, _, cx| {
                    let session = this.session.read(cx);
                    tick_delay(this.timer_is_live(cx), session.elapsed())
                }) else {
                    return;
                };
                cx.background_executor().timer(delay).await;
                if this
                    .update_in(cx, |_, window, cx| {
                        cx.notify();
                        window.refresh();
                    })
                    .is_err()
                {
                    return;
                }
            }
        })
    }

    /// `formatTime`, through the editor clock's formatter, so a recording past
    /// an hour reads `H:MM:SS` where the source folds the hours into minutes.
    fn format_elapsed(elapsed: Duration) -> String {
        crate::editor_timeline::format_time(elapsed.as_secs_f64())
    }

    fn action_button(
        &self,
        id: &'static str,
        icon: &'static str,
        disabled: bool,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .w(px(28.))
            .h(px(32.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .when(!disabled, |this| {
                this.hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.06)))
                    .active(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.10)))
            })
            .child(svg().path(icon).size(px(20.)).text_color(if disabled {
                Theme::with_alpha(theme.gray_11, 0.5)
            } else {
                theme.gray_11.into()
            }))
    }

    fn settle_marker_acknowledgement(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let added = self.session.read(cx).marker_added_at();
        if added.is_none() || added == self.marker_seen {
            return;
        }
        self.marker_seen = added;
        self._marker_settle = cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(MARKER_ACKNOWLEDGEMENT).await;
            this.update_in(cx, |_, window, cx| {
                cx.notify();
                window.refresh();
            })
            .ok();
        });
    }

    /// Studio only: Instant recordings have no editor timeline to mark. The
    /// flag fills and turns blue for a moment after each marker, and the
    /// running count sits on its corner.
    fn render_marker(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let available = session.markers_available();
        let count = session.marker_count();
        let lit = session
            .marker_added_at()
            .is_some_and(|added| added.elapsed() < MARKER_ACKNOWLEDGEMENT);
        let shortcut: Vec<String> = crate::store::hotkeys_raw()
            .get(crate::store::RECORDING_MARKER_HOTKEY)
            .and_then(crate::store::hotkey_from_value)
            .map(|hotkey| {
                crate::settings_pages::hotkey_display_keys(&hotkey)
                    .iter()
                    .map(|key| crate::settings_pages::hotkey_key_text(key).to_string())
                    .collect()
            })
            .unwrap_or_default();

        let icon_color: gpui::Hsla = if !available {
            Theme::with_alpha(theme.gray_11, 0.5)
        } else if lit {
            theme.blue_9.into()
        } else {
            theme.gray_11.into()
        };
        div()
            .id("marker")
            .relative()
            .w(px(28.))
            .h(px(32.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .when(lit, |this| this.bg(theme.blue_3))
            .when(available && !lit, |this| {
                this.hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.06)))
            })
            .child(
                svg()
                    .path(if lit {
                        "icons/flag-filled.svg"
                    } else {
                        "icons/flag.svg"
                    })
                    .size(px(20.))
                    .text_color(icon_color),
            )
            .when(count > 0, |this| {
                this.child(
                    div()
                        .absolute()
                        .top(px(1.))
                        .right(px(0.))
                        .min_w(px(13.))
                        .h(px(13.))
                        .px(px(3.))
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded_full()
                        .bg(if lit { theme.blue_9 } else { theme.gray_11 })
                        .text_size(px(9.))
                        .line_height(px(13.))
                        .font_weight(FontWeight::BOLD)
                        .text_color(theme.gray_1)
                        .child(SharedString::from(if count > 99 {
                            "99+".to_string()
                        } else {
                            count.to_string()
                        })),
                )
            })
            .tooltip(move |_, cx| {
                ui::Tooltip::new(&theme, tr::controls::marker::add())
                    .keys(shortcut.clone())
                    .view(cx)
            })
            .when(available, |this| {
                this.active(|style| style.bg(theme.blue_4))
                    .on_click(cx.listener(|this, _, _, cx| {
                        let at = std::time::Instant::now();
                        this.session
                            .update(cx, |session, cx| session.add_marker(at, cx));
                    }))
            })
            .into_any_element()
    }

    fn render_stop(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let starting = session.phase == Phase::Starting;
        let stopping = session.phase == Phase::Stopping;
        let countdown = session.countdown_remaining();
        let can_stop = (!starting && !stopping) || countdown.is_some();
        let label: SharedString = if let Some(countdown) = countdown.filter(|value| *value > 0) {
            countdown.to_string().into()
        } else if starting {
            tr::controls::stop::starting().into()
        } else if stopping {
            tr::controls::stop::saving().into()
        } else if session.pause_pending() {
            if session.is_paused() {
                tr::controls::stop::resuming()
            } else {
                tr::controls::stop::pausing()
            }
            .into()
        } else if session.is_paused() {
            tr::controls::stop::paused().into()
        } else if session.error.is_some() {
            tr::controls::stop::error().into()
        } else {
            Self::format_elapsed(session.elapsed()).into()
        };

        div()
            .id("stop")
            .min_w_0()
            .flex_1()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .rounded(px(8.))
            .py(px(4.))
            .px(px(6.))
            .text_color(theme.red_300)
            .when(can_stop, |this| {
                this.hover(|style| style.bg(Theme::with_alpha(theme.red_300, 0.08)))
                    .active(|style| style.bg(Theme::with_alpha(theme.red_300, 0.12)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session.update(cx, |session, cx| session.stop(cx));
                    }))
            })
            .when(!can_stop, |this| this.opacity(0.6))
            .child(
                svg()
                    .path("icons/stop-circle.svg")
                    .size(px(20.))
                    .flex_shrink_0()
                    .text_color(theme.red_300),
            )
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(14.))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(label),
            )
    }

    /// The mic indicator: icon plus the live level track underneath
    /// (`createAudioInputLevel` in the bar: -60..0 dB linear, blue-9 fill on a
    /// gray-10 track). In instant mode with a live mic it doubles as the mute
    /// button -- studio deliberately does not expose mute, since the mic is an
    /// editable track and muted spans would bake zeros in.
    fn render_microphone(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let muted = session.mic_muted;
        let can_mute = session.mode() == Some(RecordingMode::Instant)
            && session.has_microphone()
            && matches!(session.phase, Phase::Recording { .. });
        // A Studio recording switched to "No microphone" records no mic from
        // then on; Instant keeps the track and shows it muted instead.
        let has_microphone = self.has_microphone
            && (session.mode() == Some(RecordingMode::Instant)
                || Feeds::global(cx).read(cx).microphone.is_some());
        self.level_bar.update(cx, |bar, cx| {
            bar.configure(
                has_microphone && !muted,
                theme.blue_9.into(),
                theme.gray_10.into(),
                cx,
            );
        });

        let icon = if !has_microphone || muted {
            "icons/mic-off.svg"
        } else {
            "icons/microphone.svg"
        };
        let icon_color: gpui::Hsla = if muted {
            theme.red_9.into()
        } else if has_microphone {
            theme.gray_12.into()
        } else {
            // `IconLucideMicOff text-gray-7`.
            Theme::with_alpha(theme.gray_12, 0.35)
        };

        div()
            .id("microphone")
            .w(px(28.))
            .h(px(32.))
            .flex_shrink_0()
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .when(can_mute, |this| {
                this.rounded(px(8.))
                    .hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.06)))
                    .active(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.10)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session
                            .update(cx, |session, cx| session.toggle_mic_mute(cx));
                    }))
            })
            .child(svg().path(icon).size(px(20.)).text_color(icon_color))
            .when(has_microphone && !muted, |this| {
                this.child(self.level_bar.clone())
            })
    }

    fn confirm_action(
        &mut self,
        action: DestructiveAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (title, message, accept) = match action {
            DestructiveAction::Restart => (
                tr::controls::confirm::restart_title(),
                tr::controls::confirm::restart_message(),
                tr::controls::confirm::restart(),
            ),
            DestructiveAction::Delete => (
                tr::controls::confirm::delete_title(),
                tr::controls::confirm::delete_message(),
                tr::controls::confirm::delete(),
            ),
        };

        #[cfg(target_os = "linux")]
        {
            let owner = window.window_handle().window_id();
            if self.confirmation_pending
                || window.has_active_prompt()
                || !controls_owner_is_current(owner, window, cx)
            {
                return;
            }
            let session_id = self.session.entity_id();
            let Some(ticket) = self.session.read(cx).confirmation_ticket() else {
                return;
            };
            self.confirmation_pending = true;
            let response = crate::editor_modal::confirm_action(
                title,
                message,
                accept,
                tr::common::cancel(),
                window,
                cx,
            );
            cx.spawn_in(window, async move |this, cx| {
                let confirmed = response.await;
                let _ = this.update_in(cx, |this, window, cx| {
                    this.confirmation_pending = false;
                    if !confirmed
                        || !controls_owner_is_current(owner, window, cx)
                        || this.session.entity_id() != session_id
                    {
                        return;
                    }
                    this.session.update(cx, |session, cx| {
                        if !session.confirmation_is_current(&ticket) {
                            return;
                        }
                        match action {
                            DestructiveAction::Restart => session.restart(cx),
                            DestructiveAction::Delete => session.delete(cx),
                        }
                    });
                });
            })
            .detach();
        }

        #[cfg(not(target_os = "linux"))]
        cx.spawn_in(window, async move |this, cx| {
            if !crate::platform::confirm_dialog(title, message, accept, tr::common::cancel(), true)
            {
                return;
            }

            this.update_in(cx, |this, _, cx| {
                this.session.update(cx, |session, cx| match action {
                    DestructiveAction::Restart => session.restart(cx),
                    DestructiveAction::Delete => session.delete(cx),
                });
            })
            .ok();
        })
        .detach();
    }

    /// The microphones the menu offers: what was found, plus the one in use
    /// if enumeration has not caught up with it yet.
    fn microphone_choices(&self, cx: &gpui::App) -> Vec<String> {
        let mut choices = self.microphones.clone();
        if let Some(current) = &Feeds::global(cx).read(cx).microphone
            && !choices.contains(current)
        {
            choices.insert(0, current.clone());
        }
        choices
    }

    fn camera_choices(&self, cx: &gpui::App) -> Vec<SelectedCamera> {
        let mut choices: Vec<SelectedCamera> = self
            .cameras
            .iter()
            .map(|camera| SelectedCamera {
                id: camera
                    .model_id
                    .clone()
                    .map(DeviceOrModelID::ModelID)
                    .unwrap_or_else(|| DeviceOrModelID::DeviceID(camera.device_id.clone())),
                label: camera.label.clone(),
                device_id: camera.device_id.clone(),
                model_id: camera.model_id.clone(),
            })
            .collect();
        if let Some(current) = &Feeds::global(cx).read(cx).camera
            && !choices
                .iter()
                .any(|choice| choice.device_id == current.device_id)
        {
            choices.insert(0, current.clone());
        }
        choices
    }

    /// Rows under each heading, "None" included; a heading whose input this
    /// recording cannot change shows no rows.
    fn settings_rows(&self, cx: &gpui::App) -> (usize, usize) {
        let session = self.session.read(cx);
        let microphones = if session.microphone_switch_available() {
            self.microphone_choices(cx).len() + 1
        } else {
            0
        };
        let cameras = if session.camera_switch_available() {
            self.camera_choices(cx).len() + 1
        } else {
            0
        };
        (microphones, cameras)
    }

    fn pick_input(&mut self, request: InputRequest, window: &mut Window, cx: &mut Context<Self>) {
        self.session
            .update(cx, |session, cx| session.switch_input(request, cx));
        self.close_settings(window, cx);
    }

    fn render_settings_button(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let available = matches!(self.session.read(cx).phase, Phase::Recording { .. });
        let open = self.settings_open;
        self.action_button("settings", "icons/settings.svg", !available)
            .when(open, |this| this.bg(Theme::with_alpha(theme.gray_12, 0.08)))
            .when(!open, |this| {
                this.tooltip(move |_, cx| {
                    ui::Tooltip::new(&theme, tr::controls::settings::open()).view(cx)
                })
            })
            .when(available, |this| {
                this.on_click(cx.listener(|this, _, window, cx| {
                    this.toggle_settings(window, cx);
                }))
            })
            .into_any_element()
    }

    fn settings_row(
        &self,
        id: SharedString,
        icon: &'static str,
        label: SharedString,
        selected: bool,
        enabled: bool,
    ) -> gpui::Stateful<gpui::Div> {
        let theme = self.theme;
        div()
            .id(id)
            .h(px(SETTINGS_ROW_HEIGHT))
            .flex_shrink_0()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .rounded(px(8.))
            .when(enabled, |this| {
                this.cursor_pointer()
                    .hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.06)))
                    .active(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.10)))
            })
            .when(!enabled, |this| this.opacity(0.5))
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
                    .truncate()
                    .text_size(px(13.))
                    .text_color(theme.gray_12)
                    .child(label),
            )
            .when(selected, |this| {
                this.child(
                    svg()
                        .path("icons/check.svg")
                        .size(px(14.))
                        .flex_shrink_0()
                        .text_color(theme.blue_9),
                )
            })
    }

    fn settings_heading(
        &self,
        label: &'static str,
        note: Option<&'static str>,
    ) -> impl IntoElement {
        let theme = self.theme;
        div()
            .h(px(SETTINGS_HEADING_HEIGHT))
            .flex_shrink_0()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .px(px(8.))
            .child(
                div()
                    .flex_shrink_0()
                    .text_size(px(12.))
                    .text_color(theme.gray_11)
                    .child(label),
            )
            .children(note.map(|note| {
                div()
                    .min_w_0()
                    .truncate()
                    .text_size(px(12.))
                    .text_color(theme.gray_10)
                    .child(note)
            }))
    }

    fn settings_divider(&self) -> impl IntoElement {
        div()
            .h(px(1.))
            .my(px(SETTINGS_DIVIDER_MARGIN))
            .mx(px(4.))
            .flex_shrink_0()
            .bg(self.theme.gray_4)
    }

    fn render_settings_panel(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let instant = session.mode() == Some(RecordingMode::Instant);
        let pending = session.input_switch_pending();
        let microphone_available = session.microphone_switch_available();
        let camera_available = session.camera_switch_available();
        let microphone_muted = instant && session.mic_muted;
        let started_with_microphone = session.has_microphone();
        let started_with_camera = session.started_with_camera();
        let feeds = Feeds::global(cx).read(cx);
        let selected_microphone = feeds.microphone.clone().filter(|_| !microphone_muted);
        let selected_camera = feeds.camera.as_ref().map(|camera| camera.device_id.clone());
        let has_camera = feeds.camera.is_some();
        let preview_shown = crate::app_windows::camera_preview_shown(cx);
        let microphones = self.microphone_choices(cx);
        let cameras = self.camera_choices(cx);

        let note = |available: bool, started: bool, kind: InputKind| {
            if pending == Some(kind) {
                Some(tr::controls::settings::switching())
            } else if available {
                None
            } else if started {
                Some(tr::controls::settings::locked())
            } else {
                Some(tr::controls::settings::not_in_recording())
            }
        };

        let mut panel = div()
            .id("settings-panel")
            .w_full()
            .max_h(px(SETTINGS_PANEL_MAX_HEIGHT))
            .mb(px(8.))
            .flex()
            .flex_col()
            .p(px(SETTINGS_PANEL_PADDING))
            .rounded(px(12.))
            .border_1()
            .border_color(theme.gray_5)
            .bg(theme.gray_1)
            .shadow(vec![gpui::BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.1),
                offset: gpui::point(px(0.), px(1.)),
                blur_radius: px(3.),
                spread_radius: px(0.),
                inset: false,
            }])
            .overflow_y_scroll()
            .on_mouse_down_out(cx.listener(|this, _, window, cx| {
                if this.settings_open {
                    this.settings_dismissed_at = Some(std::time::Instant::now());
                    this.close_settings(window, cx);
                }
            }))
            .child(
                div()
                    .id("show-camera-preview")
                    .h(px(SETTINGS_ROW_HEIGHT))
                    .flex_shrink_0()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(8.))
                    .px(px(8.))
                    .when(!has_camera, |this| this.opacity(0.5))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(13.))
                            .text_color(theme.gray_12)
                            .child(tr::controls::settings::show_camera_preview()),
                    )
                    .child(
                        ui::Toggle::glass(&theme, "show-camera-preview-toggle", preview_shown)
                            .disabled(&theme, !has_camera)
                            .when(has_camera, |toggle| {
                                toggle.on_click(cx.listener(move |_, _, _, cx| {
                                    crate::app_windows::set_camera_preview_shown(
                                        !preview_shown,
                                        cx,
                                    );
                                    cx.notify();
                                }))
                            }),
                    ),
            )
            .child(self.settings_divider())
            .child(self.settings_heading(
                tr::main::device::microphone(),
                note(
                    microphone_available,
                    started_with_microphone,
                    InputKind::Microphone,
                ),
            ));

        if microphone_available {
            let enabled = pending != Some(InputKind::Microphone);
            panel = panel.child(
                self.settings_row(
                    "microphone-none".into(),
                    "icons/mic-off.svg",
                    tr::main::device::no_microphone().into(),
                    selected_microphone.is_none(),
                    enabled,
                )
                .when(enabled, |this| {
                    this.on_click(cx.listener(|this, _, window, cx| {
                        this.pick_input(InputRequest::Microphone(None), window, cx);
                    }))
                }),
            );
            for (index, name) in microphones.into_iter().enumerate() {
                let selected = selected_microphone.as_deref() == Some(name.as_str());
                let chosen = name.clone();
                panel = panel.child(
                    self.settings_row(
                        SharedString::from(format!("microphone-{index}")),
                        "icons/microphone.svg",
                        name.into(),
                        selected,
                        enabled,
                    )
                    .when(enabled, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.pick_input(
                                InputRequest::Microphone(Some(chosen.clone())),
                                window,
                                cx,
                            );
                        }))
                    }),
                );
            }
        }

        panel = panel
            .child(self.settings_divider())
            .child(self.settings_heading(
                tr::main::device::camera(),
                note(camera_available, started_with_camera, InputKind::Camera),
            ));

        if camera_available {
            let enabled = pending != Some(InputKind::Camera);
            panel = panel.child(
                self.settings_row(
                    "camera-none".into(),
                    "icons/circle-x.svg",
                    tr::main::device::no_camera().into(),
                    selected_camera.is_none(),
                    enabled,
                )
                .when(enabled, |this| {
                    this.on_click(cx.listener(|this, _, window, cx| {
                        this.pick_input(InputRequest::Camera(None), window, cx);
                    }))
                }),
            );
            for (index, camera) in cameras.into_iter().enumerate() {
                let selected = selected_camera.as_deref() == Some(camera.device_id.as_str());
                let label = SharedString::from(camera.label.clone());
                panel = panel.child(
                    self.settings_row(
                        SharedString::from(format!("camera-{index}")),
                        "icons/camera.svg",
                        label,
                        selected,
                        enabled,
                    )
                    .when(enabled, |this| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.pick_input(InputRequest::Camera(Some(camera.clone())), window, cx);
                        }))
                    }),
                );
            }
        }

        panel
    }

    fn render_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let studio = session.mode() == Some(RecordingMode::Studio);
        let paused = session.is_paused();
        let busy = !matches!(session.phase, Phase::Recording { .. }) || session.pause_unavailable();
        let pause_pending = session.pause_pending();
        let pause_tooltip = if session.pause_uncertain() {
            tr::controls::pause::unconfirmed()
        } else if pause_pending {
            if paused {
                tr::controls::pause::resuming()
            } else {
                tr::controls::pause::pausing()
            }
        } else if paused {
            tr::controls::pause::resume()
        } else {
            tr::controls::pause::pause()
        };

        div()
            .h(px(40.))
            .flex_shrink_0()
            .w_full()
            .flex()
            .flex_row()
            .items_stretch()
            .overflow_hidden()
            .rounded(px(16.))
            .bg(theme.gray_1)
            .border_1()
            .border_color(theme.gray_5)
            .when(paused, |this| this.border_color(theme.amber_6))
            .shadow(vec![gpui::BoxShadow {
                color: gpui::hsla(0., 0., 0., 0.1),
                offset: gpui::point(px(0.), px(1.)),
                blur_radius: px(3.),
                spread_radius: px(0.),
                inset: false,
            }])
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(4.))
                    .p(px(4.))
                    .child(self.render_stop(cx))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(2.))
                            .flex_shrink_0()
                            .child(self.render_microphone(cx))
                            .child(
                                self.action_button(
                                    "pause",
                                    if paused {
                                        "icons/play-circle.svg"
                                    } else {
                                        "icons/pause-circle.svg"
                                    },
                                    busy,
                                )
                                .when(paused, |this| {
                                    this.bg(theme.amber_3)
                                        .border_1()
                                        .border_color(theme.amber_6)
                                })
                                .when(pause_pending, |this| this.opacity(0.5))
                                .tooltip(move |_, cx| {
                                    ui::Tooltip::new(&theme, pause_tooltip).view(cx)
                                })
                                .when(!busy, |this| {
                                    this.active(|style| style.bg(theme.amber_6)).on_click(
                                        cx.listener(|this, _, _, cx| {
                                            this.session
                                                .update(cx, |session, cx| session.toggle_pause(cx));
                                        }),
                                    )
                                }),
                            )
                            .child(
                                self.action_button("restart", "icons/restart.svg", busy)
                                    .when(!busy, |this| {
                                        this.on_click(cx.listener(|this, _, window, cx| {
                                            this.confirm_action(
                                                DestructiveAction::Restart,
                                                window,
                                                cx,
                                            );
                                        }))
                                    }),
                            )
                            .child(self.action_button("delete", "icons/trash.svg", busy).when(
                                !busy,
                                |this| {
                                    this.on_click(cx.listener(|this, _, window, cx| {
                                        this.confirm_action(DestructiveAction::Delete, window, cx);
                                    }))
                                },
                            ))
                            .when(studio, |this| this.child(self.render_marker(cx)))
                            .child(self.render_settings_button(cx)),
                    ),
            )
            .child(
                div()
                    .id("drag")
                    .w(px(24.))
                    .flex_shrink_0()
                    .cursor_move()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_r(px(15.))
                    .border_l_1()
                    .border_color(theme.gray_5)
                    .p(px(4.))
                    .hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.04)))
                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    })
                    .child(
                        svg()
                            .path("icons/more-vertical.svg")
                            .size(px(16.))
                            .text_color(theme.gray_10),
                    ),
            )
    }
}

impl Render for ControlsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let issue = self.issue(cx);

        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            .p(px(12.))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            .when(self.settings_open, |this| {
                this.child(self.render_settings_panel(cx))
            })
            .when_some(issue, |this, issue| {
                this.child(
                    div()
                        .min_h_0()
                        .w_full()
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .mb(px(8.))
                        .rounded(px(12.))
                        .border_1()
                        .border_color(Theme::with_alpha(self.theme.red_9, 0.4))
                        .bg(self.theme.gray_1)
                        .p(px(8.))
                        .text_size(px(12.))
                        .text_color(self.theme.red_11)
                        .child(
                            svg()
                                .path("icons/triangle-alert.svg")
                                .size(px(20.))
                                .flex_shrink_0()
                                .text_color(self.theme.red_9),
                        )
                        .child(recording_issue_text(issue)),
                )
            })
            .child(self.render_bar(cx))
    }
}

fn recording_issue_text(error: String) -> impl IntoElement + Styled {
    div()
        .id("recording-issue-text")
        .min_w_0()
        .min_h_0()
        .flex_1()
        .max_h(px(56.))
        .overflow_x_scroll()
        .overflow_y_scroll()
        .child(
            if error.contains("Insufficient disk space")
                && error.contains("Your recording is still paused")
            {
                tr::controls::disk_full_resume().to_owned()
            } else {
                crate::i18n::messages::localize(&error)
            },
        )
}

fn tick_delay(live: bool, elapsed: Duration) -> Duration {
    if live {
        until_next_second(elapsed)
    } else {
        Duration::from_secs(1)
    }
}

fn until_next_second(elapsed: Duration) -> Duration {
    Duration::from_secs(1)
        .saturating_sub(Duration::from_nanos(u64::from(elapsed.subsec_nanos())))
        .max(Duration::from_millis(20))
}

#[cfg(test)]
mod repaint_tests {
    use super::*;

    #[test]
    fn the_window_grows_for_the_issue_and_the_settings_panel() {
        let bar = crate::app_windows::CONTROLS_BAR_HEIGHT;
        let with_issue = crate::app_windows::CONTROLS_HEIGHT;
        assert_eq!(controls_height(false, None), bar);
        assert_eq!(controls_height(true, None), with_issue);
        let panel = settings_panel_height(3, 2);
        assert_eq!(controls_height(false, Some(panel)), bar + panel + 8.);
        assert_eq!(controls_height(true, Some(panel)), with_issue + panel + 8.);
    }

    #[test]
    fn the_settings_panel_fits_its_rows_and_scrolls_past_the_cap() {
        let empty = settings_panel_height(0, 0);
        assert_eq!(empty, 30. + 2. * (9. + 26.) + 10.);
        assert_eq!(settings_panel_height(2, 1), empty + 3. * 30.);
        assert_eq!(settings_panel_height(40, 40), 360.);
    }

    #[test]
    fn the_timer_wakes_once_per_displayed_second() {
        assert_eq!(
            until_next_second(Duration::from_millis(3_250)),
            Duration::from_millis(750)
        );
        assert_eq!(
            until_next_second(Duration::from_millis(3_995)),
            Duration::from_millis(20)
        );
        assert_eq!(until_next_second(Duration::ZERO), Duration::from_secs(1));
    }

    #[test]
    fn the_timer_shows_hours_from_an_hour_on() {
        let label = |seconds| ControlsWindow::format_elapsed(Duration::from_secs_f64(seconds));
        assert_eq!(label(0.), "0:00");
        assert_eq!(label(95.7), "1:35");
        assert_eq!(label(3_599.9), "59:59");
        assert_eq!(label(3_600.), "1:00:00");
        assert_eq!(label(3_905.), "1:05:05");
    }

    #[test]
    fn a_resumed_timer_wakes_at_the_next_second_and_a_paused_one_idles() {
        assert_eq!(
            tick_delay(true, Duration::from_millis(3_900)),
            Duration::from_millis(100)
        );
        assert_eq!(
            tick_delay(false, Duration::from_millis(3_900)),
            Duration::from_secs(1)
        );
    }
}
