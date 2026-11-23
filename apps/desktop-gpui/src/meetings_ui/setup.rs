#[cfg(debug_assertions)]
pub mod dev;
mod permissions;
#[cfg(test)]
mod tests;
mod view;

pub const TITLE: &str = "Cap Meeting Setup";

use cap_meetings::settings::{Engine, MeetingSettings};
use std::time::{Duration, Instant};

use gpui::{
    App, AppContext as _, Context, Entity, FocusHandle, KeyDownEvent, Subscription, Task, Window,
};

pub(crate) use permissions::{Mark, Perm, Stage};

use super::{
    MeetingWindows,
    settings::shared::{self, Access, CloudState},
};
use crate::{
    meetings::{CalendarError, MeetingEvent, Meetings, StartSource},
    permissions::OSPermission,
    theme::Theme,
    ui,
};

pub const SETUP_WIDTH: f32 = crate::onboarding_window::ONBOARDING_WIDTH;
pub const SETUP_HEIGHT: f32 = crate::onboarding_window::ONBOARDING_HEIGHT;
const PROGRESS_FILE: &str = "setup-progress.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Step {
    Welcome,
    Permissions,
    Transcription,
    Calendar,
    Behavior,
    Ready,
}

impl Step {
    pub const ALL: [Step; 6] = [
        Step::Welcome,
        Step::Permissions,
        Step::Transcription,
        Step::Calendar,
        Step::Behavior,
        Step::Ready,
    ];

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|s| *s == self).unwrap_or(0)
    }

    pub fn next(self) -> Option<Step> {
        Self::ALL.get(self.index() + 1).copied()
    }

    pub fn previous(self) -> Option<Step> {
        self.index().checked_sub(1).map(|i| Self::ALL[i])
    }

    pub fn slug(self) -> &'static str {
        match self {
            Step::Welcome => "welcome",
            Step::Permissions => "permissions",
            Step::Transcription => "transcription",
            Step::Calendar => "calendar",
            Step::Behavior => "behavior",
            Step::Ready => "ready",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Step> {
        Self::ALL.into_iter().find(|s| s.slug() == slug)
    }
}

fn progress_path() -> std::path::PathBuf {
    crate::store::app_data_dir()
        .join("meetings")
        .join(PROGRESS_FILE)
}

pub fn saved_step() -> Option<Step> {
    let text = std::fs::read_to_string(progress_path()).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    Step::from_slug(value.get("step")?.as_str()?)
}

fn save_step(step: Step) {
    if cfg!(test) {
        return;
    }
    let path = progress_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        serde_json::json!({ "step": step.slug() }).to_string(),
    );
}

fn clear_saved_step() {
    if cfg!(test) {
        return;
    }
    let _ = std::fs::remove_file(progress_path());
}

pub fn resume_step(settings: &MeetingSettings, saved: Option<Step>) -> Step {
    if settings.setup_completed {
        return Step::Welcome;
    }
    match saved {
        Some(Step::Ready) => Step::Behavior,
        Some(step) => step,
        None => Step::Welcome,
    }
}

pub fn open(cx: &mut App) {
    open_at(None, cx);
}

#[cfg(test)]
thread_local! {
    pub(crate) static OPEN_REQUESTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

pub fn open_at(step: Option<Step>, cx: &mut App) {
    if Meetings::try_global(cx).is_none() {
        return;
    }
    #[cfg(test)]
    {
        let _ = step;
        OPEN_REQUESTS.with(|count| count.set(count.get() + 1));
        return;
    }
    #[cfg(not(test))]
    open_window(step, cx);
}

#[cfg(not(test))]
fn open_window(step: Option<Step>, cx: &mut App) {
    use gpui::{Bounds, WindowBounds, WindowKind, WindowOptions, px, size};
    crate::app_windows::hide_main_for_meeting_window(cx);
    if let Some(handle) = MeetingWindows::get(cx).setup {
        let native = handle
            .update(cx, |view, window, cx| {
                if let (Some(step), Ok(view)) = (step, view.downcast::<SetupWindow>()) {
                    view.update(cx, |view, cx| view.go_to(step, window, cx));
                }
                window.activate_window();
                crate::platform::native_window(window)
            })
            .ok()
            .flatten();
        cx.spawn(async move |_| {
            if let Some(native) = &native {
                crate::platform::show_native(native);
            }
        })
        .detach();
        return;
    }
    let (width, height) = window_size(cx);
    let bounds = Bounds::centered(None, size(px(width), px(height)), cx);
    let handle = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: None,
            kind: WindowKind::Normal,
            focus: true,
            show: true,
            is_resizable: false,
            is_minimizable: true,
            window_min_size: Some(bounds.size),
            window_background: gpui::WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| {
            window.set_window_title(TITLE);
            cx.new(|cx| SetupWindow::new(step, window, cx))
        },
    );
    let handle = match handle {
        Ok(handle) => handle,
        Err(error) => {
            tracing::error!("meeting setup window failed to open: {error:#}");
            return;
        }
    };
    MeetingWindows::get(cx).setup = Some(handle.into());
    let native = handle
        .update(cx, |view, window, cx| {
            crate::platform::kick_display_link(window);
            view.focus_root(window, cx);
            view.step_shown(window, cx);
            crate::platform::native_window(window)
        })
        .ok()
        .flatten();
    cx.spawn(async move |cx| {
        if let Some(native) = &native {
            crate::platform::show_native(native);
        }
        handle
            .update(cx, |view, window, cx| {
                view.theme = Theme::for_window(window, cx, true);
                cx.notify();
                window.refresh();
            })
            .ok();
    })
    .detach();
}

/// The onboarding window's proportions: 58% of the display's width within
/// 860 to 1080 points, 0.72 of that tall within 690 to 780.
#[cfg(not(test))]
fn window_size(cx: &App) -> (f32, f32) {
    let Some(display) = cx.primary_display() else {
        return (SETUP_WIDTH, SETUP_HEIGHT);
    };
    let screen = display.bounds().size;
    let (screen_w, screen_h) = (f32::from(screen.width), f32::from(screen.height));
    let width = (screen_w * 0.58)
        .clamp(SETUP_WIDTH, 1080.)
        .min((screen_w - 32.).max(1.));
    let height = (width * 0.72)
        .clamp(SETUP_HEIGHT, 780.)
        .min((screen_h - 32.).max(1.));
    (width, height)
}

pub fn close(cx: &mut App) {
    if let Some(handle) = MeetingWindows::get(cx).setup.take() {
        handle
            .update(cx, |_, window, _| window.remove_window())
            .ok();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SetupMenu {
    Lead,
    AutoRecord,
}

pub(crate) struct OpenMenu {
    pub kind: SetupMenu,
    pub state: ui::MenuState,
}

/// Where a permission request stands, beyond what the OS reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ask {
    Idle,
    /// The macOS prompt is up and the request is blocked on it.
    Waiting,
    /// The request came back without an answer (the prompt timed out or
    /// never showed).
    NoAnswer,
    /// System Settings was opened for it; the poll picks up the change.
    InSettings,
}

pub struct SetupWindow {
    pub(crate) theme: Theme,
    pub(crate) step: Step,
    pub(crate) settings: MeetingSettings,
    pub(crate) mic: Access,
    pub(crate) audio: Access,
    pub(crate) accessibility: Access,
    pub(crate) calendar: Access,
    pub(crate) asks: [Ask; 3],
    pub(crate) ax_skipped: bool,
    pub(crate) focused: Option<Perm>,
    pub(crate) marks: [(Mark, Instant); 3],
    pub(crate) shown: Option<(Stage, bool)>,
    pub(crate) shown_at: Instant,
    pub(crate) calendar_requesting: bool,
    pub(crate) cloud: CloudState,
    pub(crate) preselected: bool,
    pub(crate) url_input: Entity<ui::TextInputState>,
    pub(crate) url_draft: String,
    pub(crate) add_error: Option<CalendarError>,
    pub(crate) link_open: bool,
    pub(crate) try_error: bool,
    pub(crate) visible_override: Option<bool>,
    pub(crate) menu: Option<OpenMenu>,
    pub(crate) poll: Option<Task<()>>,
    pub(crate) download_tick: Option<Task<()>>,
    pub(crate) step_at: Instant,
    pub(crate) step_revision: usize,
    pub(crate) direction: f32,
    pub(crate) active: bool,
    advance: Option<Task<()>>,
    recheck: Option<Task<()>>,
    request: Option<Task<()>>,
    focus: FocusHandle,
    _subscriptions: Vec<Subscription>,
}

pub(crate) fn surface_visible(window: &Window) -> bool {
    #[cfg(test)]
    {
        let _ = window;
        false
    }
    #[cfg(all(target_os = "macos", not(test)))]
    {
        crate::platform::window_is_visible(window)
    }
    #[cfg(all(not(target_os = "macos"), not(test)))]
    {
        window.is_window_active()
    }
}

/// How long a permission that was just allowed stays on the card, its tick
/// drawn, before the next one comes up.
const ADVANCE_AFTER: Duration = Duration::from_millis(1400);

impl SetupWindow {
    pub fn new(step: Option<Step>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        #[cfg(not(test))]
        crate::theme::bind_window(window, cx);
        window.on_window_should_close(cx, |_window, cx| {
            cx.defer(|cx| {
                MeetingWindows::get(cx).setup = None;
                // Back to the notes window when setup came from it.
                if MeetingWindows::get(cx).documents.is_some() {
                    super::documents::open(None, cx);
                }
            });
            true
        });
        let meetings = Meetings::global(cx);
        let settings = meetings.read(cx).settings().clone();
        let cloud = shared::cloud_state(meetings.read(cx));
        let url_input = cx.new(|cx| ui::TextInputState::single_line(window, cx));
        let mut subscriptions = vec![
            cx.subscribe(&url_input, |this, input, event, cx| match event {
                ui::TextInputEvent::Changed => {
                    this.url_draft = input.read(cx).text().to_string();
                    this.add_error = None;
                    cx.notify();
                }
                ui::TextInputEvent::Confirmed => this.add_link(cx),
                _ => {}
            }),
            cx.subscribe(&meetings, |this, meetings, event, cx| match event {
                MeetingEvent::SettingsChanged => {
                    this.settings = meetings.read(cx).settings().clone();
                    cx.notify();
                }
                MeetingEvent::CalendarChanged => cx.notify(),
                _ => {}
            }),
            cx.observe(&meetings, |this, meetings, cx| {
                let cloud = shared::cloud_state(meetings.read(cx));
                if cloud != this.cloud {
                    this.cloud = cloud;
                    cx.notify();
                }
            }),
            cx.observe(
                &crate::media_access::MediaAccess::global(cx),
                |this, _, cx| {
                    this.mic = shared::microphone_access(cx);
                    cx.notify();
                },
            ),
            cx.subscribe(&crate::sign_in::SignIn::global(cx), |this, _, event, cx| {
                if matches!(event, crate::sign_in::SignInEvent::AccountRefreshed) {
                    shared::retry_capabilities(cx);
                    if let Some(meetings) = Meetings::try_global(cx) {
                        this.cloud = shared::cloud_state(meetings.read(cx));
                    }
                    cx.notify();
                }
            }),
            cx.observe_window_activation(window, |this, window, cx| {
                this.active = window.is_window_active();
                if this.active {
                    this.recheck(window, cx);
                    this.step_shown(window, cx);
                } else if !this.visible(window) {
                    this.poll = None;
                    this.download_tick = None;
                }
                cx.notify();
            }),
        ];
        subscriptions.shrink_to_fit();
        let step = step.unwrap_or_else(|| resume_step(&settings, saved_step()));
        let (audio, accessibility, calendar) = shared::sweep_permissions();
        #[cfg(not(test))]
        let theme = Theme::for_window(window, cx, true);
        #[cfg(test)]
        let theme = Theme::light();
        let now = Instant::now();
        Self {
            theme,
            step,
            mic: shared::microphone_access(cx),
            audio,
            accessibility,
            calendar,
            settings,
            asks: [Ask::Idle; 3],
            ax_skipped: false,
            focused: None,
            marks: [(Mark::Pending, now); 3],
            shown: None,
            shown_at: now,
            calendar_requesting: false,
            cloud,
            preselected: false,
            url_input,
            url_draft: String::new(),
            add_error: None,
            link_open: false,
            try_error: false,
            visible_override: None,
            menu: None,
            poll: None,
            download_tick: None,
            step_at: now,
            step_revision: 0,
            direction: 1.,
            active: window.is_window_active(),
            advance: None,
            recheck: None,
            request: None,
            focus: cx.focus_handle(),
            _subscriptions: subscriptions,
        }
    }

    pub(crate) fn visible(&self, window: &Window) -> bool {
        self.visible_override
            .unwrap_or_else(|| surface_visible(window))
    }

    /// Doodles boil and entrances play only while the window is in front and
    /// the person has not asked for reduced motion.
    pub(crate) fn still(&self, cx: &App) -> bool {
        !self.active || cx.reduce_motion()
    }

    pub fn focus_root(&self, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
    }

    pub(crate) fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn step_shown(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        shared::ensure_capabilities(cx);
        crate::media_access::MediaAccess::refresh_global(cx);
        self.mic = shared::microphone_access(cx);
        if self.step == Step::Transcription {
            crate::transcription::refresh_downloaded_models();
            self.preselect_engine(cx);
        }
        if self.step == Step::Calendar {
            shared::sync_unsynced_calendars(cx);
        }
        self.arm_poll(window, cx);
        self.arm_download_tick(window, cx);
    }

    /// One sweep right away, for coming back from System Settings or the
    /// macOS prompt: the poll would otherwise take up to a second.
    pub(crate) fn recheck(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        crate::media_access::MediaAccess::refresh_global(cx);
        self.recheck = Some(cx.spawn_in(window, async move |this, cx| {
            let sweep = cx
                .background_executor()
                .spawn(async { shared::sweep_permissions() })
                .await;
            this.update(cx, |this, cx| {
                this.recheck = None;
                this.apply_sweep(sweep, cx);
            })
            .ok();
        }));
    }

    fn apply_sweep(&mut self, sweep: (Access, Access, Access), cx: &mut Context<Self>) {
        let (audio, accessibility, calendar) = sweep;
        let mic = shared::microphone_access(cx);
        if (audio, accessibility, calendar, mic)
            != (self.audio, self.accessibility, self.calendar, self.mic)
        {
            self.audio = audio;
            self.accessibility = accessibility;
            self.calendar = calendar;
            self.mic = mic;
            cx.notify();
        }
    }

    pub(crate) fn update_settings(
        &mut self,
        cx: &mut Context<Self>,
        change: impl FnOnce(&mut MeetingSettings),
    ) {
        let meetings = Meetings::global(cx);
        meetings.update(cx, |m, cx| m.update_settings(change, cx));
        self.settings = meetings.read(cx).settings().clone();
        cx.notify();
    }

    fn preselect_engine(&mut self, cx: &mut Context<Self>) {
        if self.preselected || self.settings.setup_completed {
            return;
        }
        self.preselected = true;
        let engine = if matches!(self.cloud, CloudState::Available | CloudState::Checking) {
            Engine::Cloud
        } else {
            Engine::Local
        };
        self.update_settings(cx, |s| s.transcription.engine = engine);
    }

    pub fn can_continue(&self) -> bool {
        self.step != Step::Permissions || self.mic.ready()
    }

    pub fn go_to(&mut self, step: Step, window: &mut Window, cx: &mut Context<Self>) {
        if self.step == step {
            return;
        }
        self.direction = if step > self.step { 1. } else { -1. };
        self.step = step;
        self.step_at = Instant::now();
        self.step_revision += 1;
        self.menu = None;
        self.poll = None;
        self.request = None;
        self.advance = None;
        self.focused = None;
        self.shown = None;
        for ask in &mut self.asks {
            if *ask == Ask::Waiting {
                *ask = Ask::Idle;
            }
        }
        self.try_error = false;
        save_step(step);
        self.focus_root(window, cx);
        self.step_shown(window, cx);
        cx.notify();
    }

    pub fn next(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_continue() {
            return;
        }
        match self.step.next() {
            Some(step) => self.go_to(step, window, cx),
            None => self.finish(cx),
        }
    }

    pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(step) = self.step.previous() {
            self.go_to(step, window, cx);
        }
    }

    pub fn finish(&mut self, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| {
            s.setup_completed = true;
            s.enabled = true;
        });
        clear_saved_step();
        self.poll = None;
        self.download_tick = None;
        cx.defer(|cx| {
            close(cx);
            // Back to the notes window when setup came from it.
                if MeetingWindows::get(cx).documents.is_some() {
                    super::documents::open(None, cx);
                }
        });
    }

    pub fn try_it(&mut self, cx: &mut Context<Self>) {
        self.update_settings(cx, |s| {
            s.setup_completed = true;
            s.enabled = true;
        });
        clear_saved_step();
        let result =
            Meetings::global(cx).update(cx, |m, cx| m.start_recording(StartSource::Manual, cx));
        match result {
            Ok(doc_id) => {
                self.poll = None;
                cx.defer(move |cx| {
                    close(cx);
                    super::documents::open(Some(doc_id), cx);
                });
            }
            Err(error) => {
                tracing::warn!(%error, "the first meeting recording did not start");
                self.try_error = true;
                cx.notify();
            }
        }
    }

    pub(crate) fn on_key(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = &event.keystroke;
        if self.menu.is_some() {
            let Some(menu) = self.menu.as_mut() else {
                return;
            };
            let kind = menu.kind;
            match menu.state.on_key(&key.key) {
                ui::MenuKey::Moved => cx.notify(),
                ui::MenuKey::Commit(index) => self.choose(kind, index, cx),
                ui::MenuKey::Dismiss => {
                    self.menu = None;
                    cx.notify();
                }
                ui::MenuKey::Ignored => return,
            }
            cx.stop_propagation();
            return;
        }
        let close_chord = if cfg!(target_os = "macos") {
            key.modifiers.platform
        } else {
            key.modifiers.control
        };
        if close_chord && key.key == "w" {
            cx.stop_propagation();
            cx.defer(close);
            return;
        }
        if key.modifiers.platform || key.modifiers.control || key.modifiers.alt {
            return;
        }
        if ui::text_input_has_focus(window, cx) {
            return;
        }
        match key.key.as_str() {
            "enter" | "right" => {
                if self.step == Step::Ready && key.key == "enter" {
                    self.finish(cx);
                } else if self.step != Step::Ready {
                    self.next(window, cx);
                }
            }
            "left" => self.back(window, cx),
            "escape" => cx.defer(close),
            _ => return,
        }
        cx.stop_propagation();
    }

    pub(crate) fn open_menu(
        &mut self,
        kind: SetupMenu,
        origin: gpui::Point<gpui::Pixels>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let items = self.menu_items(kind);
        self.focus_root(window, cx);
        self.menu = Some(OpenMenu {
            kind,
            state: ui::MenuState::new(origin, &items),
        });
        cx.notify();
    }

    pub(crate) fn menu_items(&self, kind: SetupMenu) -> Vec<ui::MenuItem> {
        match kind {
            SetupMenu::Lead => shared::LEAD_OPTIONS
                .iter()
                .map(|secs| {
                    ui::MenuItem::new(
                        super::settings::lead_label(*secs),
                        *secs == self.settings.notifications.lead_secs,
                    )
                })
                .collect(),
            SetupMenu::AutoRecord => super::settings::AUTO_RECORD
                .iter()
                .map(|v| {
                    ui::MenuItem::new(
                        super::settings::auto_record_label(*v),
                        *v == self.settings.automation.auto_record,
                    )
                })
                .collect(),
        }
    }

    pub(crate) fn choose(&mut self, kind: SetupMenu, index: usize, cx: &mut Context<Self>) {
        self.menu = None;
        match kind {
            SetupMenu::Lead => {
                if let Some(secs) = shared::LEAD_OPTIONS.get(index).copied() {
                    self.update_settings(cx, |s| s.notifications.lead_secs = secs);
                }
            }
            SetupMenu::AutoRecord => {
                if let Some(value) = super::settings::AUTO_RECORD.get(index).copied() {
                    self.update_settings(cx, |s| s.automation.auto_record = value);
                }
            }
        }
        cx.notify();
    }

    pub(crate) fn arm_poll(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.step != Step::Permissions || self.poll.is_some() || !self.visible(window) {
            return;
        }
        tracing::debug!("meeting setup permission poll started");
        self.poll = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                let sweep = cx
                    .background_executor()
                    .spawn(async { shared::sweep_permissions() })
                    .await;
                let keep = this
                    .update_in(cx, |this, window, cx| {
                        let visible = this.step == Step::Permissions && this.visible(window);
                        if !visible {
                            this.poll = None;
                            tracing::debug!("meeting setup permission poll stopped");
                            return false;
                        }
                        tracing::debug!("meeting setup permission poll tick");
                        crate::media_access::MediaAccess::refresh_global(cx);
                        this.apply_sweep(sweep, cx);
                        true
                    })
                    .unwrap_or(false);
                if !keep {
                    return;
                }
                cx.background_executor()
                    .timer(shared::PERMISSION_POLL)
                    .await;
            }
        }));
    }

    pub(crate) fn arm_download_tick(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.step != Step::Transcription
            || self.download_tick.is_some()
            || !shared::download_running()
        {
            return;
        }
        self.download_tick = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(shared::DOWNLOAD_REPAINT)
                    .await;
                let keep = this
                    .update_in(cx, |this, window, cx| {
                        cx.notify();
                        let keep = this.step == Step::Transcription
                            && this.visible(window)
                            && shared::download_running();
                        if !keep {
                            this.download_tick = None;
                        }
                        keep
                    })
                    .unwrap_or(false);
                if !keep {
                    return;
                }
            }
        }));
    }

    pub(crate) fn request_microphone(&mut self, cx: &mut Context<Self>) {
        if self.mic == Access::Denied {
            self.asks[Perm::Microphone.index()] = Ask::InSettings;
        }
        self.focused = Some(Perm::Microphone);
        crate::media_access::MediaAccess::global(cx)
            .update(cx, |m, cx| m.request(OSPermission::Microphone, cx));
        cx.notify();
    }

    /// The system audio request blocks until the person answers the macOS
    /// prompt (or it gives up after about 90 seconds), so it runs on the
    /// background executor and the card says where to look meanwhile.
    pub(crate) fn request_audio(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let slot = Perm::Audio.index();
        self.focused = Some(Perm::Audio);
        match self.audio {
            Access::Denied => {
                self.asks[slot] = Ask::InSettings;
                shared::open_audio_settings();
            }
            Access::NotDetermined if self.asks[slot] != Ask::Waiting => {
                self.asks[slot] = Ask::Waiting;
                self.request = Some(cx.spawn_in(window, async move |this, cx| {
                    let audio = cx
                        .background_executor()
                        .spawn(async {
                            #[cfg(target_os = "macos")]
                            cap_meeting_platform::request_audio_capture_permission();
                            shared::audio_access()
                        })
                        .await;
                    this.update(cx, |this, cx| {
                        this.audio_answered(audio, cx);
                    })
                    .ok();
                }));
            }
            _ => {}
        }
        cx.notify();
    }

    pub(crate) fn audio_answered(&mut self, audio: Access, cx: &mut Context<Self>) {
        let slot = Perm::Audio.index();
        self.request = None;
        self.audio = audio;
        self.asks[slot] = match audio {
            Access::NotDetermined => Ask::NoAnswer,
            _ => Ask::Idle,
        };
        cx.notify();
    }

    pub(crate) fn open_audio_settings(&mut self, cx: &mut Context<Self>) {
        self.asks[Perm::Audio.index()] = Ask::InSettings;
        shared::open_audio_settings();
        cx.notify();
    }

    pub(crate) fn request_accessibility(&mut self, cx: &mut Context<Self>) {
        let slot = Perm::Accessibility.index();
        self.focused = Some(Perm::Accessibility);
        self.ax_skipped = false;
        if self.asks[slot] == Ask::InSettings {
            shared::open_accessibility_settings();
        } else {
            self.asks[slot] = Ask::InSettings;
            shared::request_accessibility();
        }
        cx.notify();
    }

    pub(crate) fn skip_accessibility(&mut self, cx: &mut Context<Self>) {
        self.ax_skipped = true;
        self.asks[Perm::Accessibility.index()] = Ask::Idle;
        if self.focused == Some(Perm::Accessibility) {
            self.focused = None;
        }
        cx.notify();
    }

    pub(crate) fn focus_permission(&mut self, perm: Perm, cx: &mut Context<Self>) {
        self.advance = None;
        self.focused = Some(perm);
        if perm == Perm::Accessibility {
            self.ax_skipped = false;
        }
        cx.notify();
    }

    /// Hold a permission that was just allowed on the card for a moment, so
    /// the drawn tick is seen before the next one slides in.
    pub(crate) fn hold_granted(&mut self, perm: Perm, window: &mut Window, cx: &mut Context<Self>) {
        self.focused = Some(perm);
        self.advance = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(ADVANCE_AFTER).await;
            this.update(cx, |this, cx| {
                if this.focused == Some(perm) {
                    this.focused = None;
                    cx.notify();
                }
                this.advance = None;
            })
            .ok();
        }));
    }

    pub(crate) fn connect_system(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match self.calendar {
            Access::Granted => self.add_system(cx),
            Access::NotDetermined if !self.calendar_requesting => {
                self.calendar_requesting = true;
                let (tx, rx) = flume::bounded::<bool>(1);
                cap_meeting_platform::request_calendar_access(move |granted| {
                    let _ = tx.send(granted);
                });
                self.request = Some(cx.spawn_in(window, async move |this, cx| {
                    let granted = rx.recv_async().await.unwrap_or(false);
                    this.update(cx, |this, cx| {
                        this.calendar_requesting = false;
                        this.calendar = if granted {
                            Access::Granted
                        } else {
                            Access::Denied
                        };
                        if granted {
                            this.add_system(cx);
                        }
                        cx.notify();
                    })
                    .ok();
                }));
                cx.notify();
            }
            Access::Denied => shared::open_calendar_settings(),
            _ => {}
        }
    }

    fn add_system(&mut self, cx: &mut Context<Self>) {
        let result = Meetings::global(cx).update(cx, |m, cx| m.add_system_calendar(cx));
        match result {
            Ok(_) | Err(CalendarError::Duplicate) => self.add_error = None,
            Err(error) => self.add_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn add_link(&mut self, cx: &mut Context<Self>) {
        let url = self.url_draft.trim().to_string();
        if url.is_empty() {
            return;
        }
        let result = Meetings::global(cx).update(cx, |m, cx| m.add_calendar_feed(&url, None, cx));
        match result {
            Ok(_) => {
                self.add_error = None;
                self.url_draft.clear();
                let input = self.url_input.clone();
                input.update(cx, |i, cx| i.set_text("", cx));
            }
            Err(error) => self.add_error = Some(error),
        }
        cx.notify();
    }

    pub(crate) fn download(&mut self, model: &str, window: &mut Window, cx: &mut Context<Self>) {
        shared::start_download(model, cx);
        self.update_settings(cx, |s| s.transcription.engine = Engine::Local);
        self.arm_download_tick(window, cx);
        cx.notify();
    }
}
