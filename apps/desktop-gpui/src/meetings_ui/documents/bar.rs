use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use gpui::{
    AnimationExt as _, AnyElement, App, Context, EventEmitter, FontWeight, Hsla,
    InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Task, Window, div, prelude::FluentBuilder,
    px, svg,
};

use super::{
    doodles, format,
    style::{self, Palette},
};
use crate::{
    i18n::tr,
    meetings::{
        ActiveMeeting, ActiveState, MeetingEvent, MeetingWarning, Meetings, StopReason,
        health::Concern,
    },
};

const METER_TWEEN: Duration = Duration::from_millis(130);
/// How often the meter steps while it eases. Levels change up to ten times
/// a second for as long as anyone talks, so a redraw every display frame
/// would repaint the window for the whole meeting; 20 steps a second look
/// the same on a meter this small.
const METER_FRAME: Duration = Duration::from_millis(50);
/// Record more ignores presses this long after a stop, so a second click on
/// Stop does not start recording again.
pub const RECORD_MORE_GUARD: Duration = Duration::from_millis(1500);
const DOTS: [f32; 3] = [0.7, 1.0, 0.8];

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BarEvent {
    /// Record into this note, linking the offered calendar meeting if any.
    Start(Option<String>),
    ShowDoc(String),
    TogglePanel,
    /// Stop the notes this window is writing.
    StopWriting,
}

pub mod health_line;

/// One thing the meeting's line can say (see `meetings::health`).
pub type Issue = Concern;

/// What the meeting's line may say now, most urgent first, already held
/// back until each has lasted.
pub fn issues(active: &ActiveMeeting) -> Vec<Issue> {
    active.health.clone()
}

/// What the line above the bottom bar says, most urgent first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Banner {
    Ending(u64),
    Inactive(u64),
    ResumeOffer { slept: bool },
    /// The call went on through a sleep and so did the meeting.
    ResumedAfterSleep,
    Issue(Issue),
    Permission(&'static str),
}

pub fn banner_for(
    active: Option<&ActiveMeeting>,
    dismissed: &HashSet<Issue>,
    permission: Option<&'static str>,
    now: Instant,
) -> Option<Banner> {
    let active = active?;
    if active.state == ActiveState::ResumeOffered {
        return Some(Banner::ResumeOffer {
            slept: active.slept,
        });
    }
    match active.warning {
        Some(MeetingWarning::Ending { stop_at, .. }) => {
            return Some(Banner::Ending(
                stop_at.saturating_duration_since(now).as_secs(),
            ));
        }
        Some(MeetingWarning::Inactivity { stop_at }) => {
            return Some(Banner::Inactive(
                stop_at.saturating_duration_since(now).as_secs(),
            ));
        }
        None => {}
    }
    if active.resumed_after_sleep && active.state == ActiveState::Recording {
        return Some(Banner::ResumedAfterSleep);
    }
    if let Some(line) = permission {
        return Some(Banner::Permission(line));
    }
    issues(active)
        .into_iter()
        .find(|issue| !dismissed.contains(issue))
        .map(Banner::Issue)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Meter {
    from: [f32; 2],
    to: [f32; 2],
    at: Option<Instant>,
}

impl Meter {
    fn current(&self, now: Instant) -> ([f32; 2], bool) {
        let Some(at) = self.at else {
            return (self.to, false);
        };
        let t = (now.saturating_duration_since(at).as_secs_f32() / METER_TWEEN.as_secs_f32())
            .clamp(0., 1.);
        let eased = 1. - (1. - t).powi(3);
        let value = [
            self.from[0] + (self.to[0] - self.from[0]) * eased,
            self.from[1] + (self.to[1] - self.from[1]) * eased,
        ];
        (value, t < 1.)
    }

    fn push(&mut self, levels: [f32; 2], now: Instant) {
        if levels == self.to {
            return;
        }
        let (current, _) = self.current(now);
        self.from = current;
        self.to = levels;
        self.at = Some(now);
    }
}

/// The meeting a Record press would join this note to: a calendar meeting in
/// progress or starting within ten minutes (its key is linked), else a call
/// Cap can hear (named after the app).
fn offer(cx: &App) -> Option<(String, Option<String>)> {
    use crate::meetings_ui::live::{self, model};
    let events = if live::ready(cx) {
        live::events(cx)
    } else {
        Vec::new()
    };
    let context = model::context(&live::calls(cx), &events, chrono::Utc::now())?;
    match (context.event, context.call) {
        (Some(event), _) if !event.title.trim().is_empty() => Some((event.title, Some(event.id))),
        (_, Some(call)) => Some((call.app_name, None)),
        _ => None,
    }
}

pub fn level_to_height(level: f32) -> f32 {
    let level = level.clamp(0., 1.);
    if level <= 0.002 {
        return 0.;
    }
    let db = 20. * level.log10();
    ((db + 54.) / 54.).clamp(0., 1.)
}

fn surface_visible(window: &Window) -> bool {
    #[cfg(target_os = "macos")]
    {
        crate::platform::window_is_visible(window)
    }
    #[cfg(not(target_os = "macos"))]
    {
        window.is_window_active()
    }
}

pub struct RecordingBar {
    pub doc_id: Option<String>,
    pub meeting: bool,
    /// The note already belongs to a calendar meeting, so Record never
    /// offers a different one.
    pub linked: bool,
    pub has_transcript: bool,
    pub panel_open: bool,
    /// Drawn inside the note's one bottom bar beside Ask, so it has no
    /// capsule of its own.
    pub embedded: bool,
    palette: Palette,
    meter: Meter,
    meter_frame: Option<Task<()>>,
    permission: Option<&'static str>,
    dismissed: HashSet<Issue>,
    banner_at: Instant,
    tick: Option<Task<()>>,
    /// Cap AI is writing this note's notes right now; the dot breathes on a
    /// slow timer rather than every frame.
    writing: bool,
    /// This window asked for the notes being written, so it can stop them.
    pub can_stop_writing: bool,
    breath: Option<Task<()>>,
    /// When this note's recording stopped in this window.
    stopped_at: Option<Instant>,
    guard: Option<Task<()>>,
    #[cfg(debug_assertions)]
    debug: Option<ActiveMeeting>,
    _subscriptions: Vec<Subscription>,
}

/// The one thing an ended note's bar shows beside the panel toggle: the
/// notes being written, or a way to record more. The page itself says the
/// meeting is saved and shows the notes, so the bar never repeats it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EndedItem {
    Writing,
    /// Dimmed and ignoring presses for a moment after Stop.
    RecordMore {
        open: bool,
    },
}

/// The bar's line while Cap AI writes: the connection is named only when
/// Cap can't be reached; a server in trouble says so instead.
pub(super) fn writing_line(waiting: Option<bool>) -> &'static str {
    match waiting {
        None => tr::documents::notes::writing(),
        Some(true) => tr::documents::notes::waiting(),
        Some(false) => tr::documents::notes::waiting_server(),
    }
}

pub fn ended_item(writing: bool, stopped_at: Option<Instant>, now: Instant) -> EndedItem {
    if writing {
        EndedItem::Writing
    } else {
        EndedItem::RecordMore {
            open: record_more_open(stopped_at, now),
        }
    }
}

pub fn record_more_open(stopped_at: Option<Instant>, now: Instant) -> bool {
    stopped_at.is_none_or(|at| now.saturating_duration_since(at) >= RECORD_MORE_GUARD)
}

impl EventEmitter<BarEvent> for RecordingBar {}

impl RecordingBar {
    pub fn new(palette: Palette, cx: &mut Context<Self>) -> Self {
        let mut subscriptions = Vec::new();
        if let Some(live) = crate::meetings_ui::live::Live::global(cx) {
            subscriptions.push(cx.subscribe(
                &live,
                |_, _, event: &crate::meetings_ui::live::LiveEvent, cx| {
                    if matches!(event, crate::meetings_ui::live::LiveEvent::Changed) {
                        cx.notify();
                    }
                },
            ));
        }
        if let Some(meetings) = Meetings::try_global(cx) {
            subscriptions.push(
                cx.subscribe(&meetings, |this, _, event: &MeetingEvent, cx| match event {
                    MeetingEvent::RecordingStopped { doc_id, .. } => {
                        this.stopped(doc_id, cx);
                        this.on_active(cx);
                    }
                    MeetingEvent::ActiveChanged
                    | MeetingEvent::RecordingStarted { .. }
                    | MeetingEvent::SettingsChanged => this.on_active(cx),
                    MeetingEvent::NotesProgress {
                        stage: crate::meetings::NotesStage::Waiting(_),
                        ..
                    } => cx.notify(),
                    _ => {}
                }),
            );
        }
        Self {
            doc_id: None,
            meeting: false,
            linked: false,
            has_transcript: false,
            panel_open: false,
            embedded: false,
            palette,
            meter: Meter::default(),
            meter_frame: None,
            permission: None,
            dismissed: HashSet::new(),
            banner_at: Instant::now(),
            tick: None,
            writing: false,
            can_stop_writing: false,
            breath: None,
            stopped_at: None,
            guard: None,
            #[cfg(debug_assertions)]
            debug: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn set_palette(&mut self, palette: Palette, cx: &mut Context<Self>) {
        self.palette = palette;
        cx.notify();
    }

    pub fn set_doc(&mut self, doc_id: Option<String>, meeting: bool, cx: &mut Context<Self>) {
        if self.doc_id != doc_id {
            self.permission = None;
            self.dismissed.clear();
            self.stopped_at = None;
            self.guard = None;
            #[cfg(debug_assertions)]
            {
                self.debug = None;
            }
        }
        self.doc_id = doc_id;
        self.meeting = meeting;
        self.on_active(cx);
    }

    pub fn set_state(&mut self, has_transcript: bool, panel_open: bool, cx: &mut Context<Self>) {
        if (self.has_transcript, self.panel_open) != (has_transcript, panel_open) {
            self.has_transcript = has_transcript;
            self.panel_open = panel_open;
            cx.notify();
        }
    }

    pub fn set_writing(&mut self, writing: bool, cx: &mut Context<Self>) {
        if self.writing != writing {
            self.writing = writing;
            self.breath = (writing && !style::reduce_motion()).then(|| {
                cx.spawn(async move |this, cx| {
                    loop {
                        cx.background_executor()
                            .timer(Duration::from_millis(90))
                            .await;
                        if this.update(cx, |_, cx| cx.notify()).is_err() {
                            break;
                        }
                    }
                })
            });
            cx.notify();
        }
    }

    fn stopped(&mut self, doc_id: &str, cx: &mut Context<Self>) {
        if self.doc_id.as_deref() != Some(doc_id) {
            return;
        }
        self.stopped_at = Some(Instant::now());
        self.guard = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(RECORD_MORE_GUARD).await;
            this.update(cx, |this, cx| {
                this.guard = None;
                cx.notify();
            })
            .ok();
        }));
    }

    /// The notes can't reach Cap yet and will try again by themselves.
    /// Some(offline) while the notes wait to try again.
    fn notes_waiting(&self, cx: &App) -> Option<bool> {
        let doc_id = self.doc_id.as_deref()?;
        Meetings::try_global(cx)
            .and_then(|m| m.read(cx).notes_state(doc_id).cloned())
            .filter(|s| s.waiting)
            .map(|s| s.offline)
    }

    fn record_more(&mut self, cx: &mut Context<Self>) {
        if record_more_open(self.stopped_at, Instant::now()) {
            cx.emit(BarEvent::Start(None));
        }
    }

    fn active(&self, cx: &App) -> Option<ActiveMeeting> {
        #[cfg(debug_assertions)]
        if let Some(active) = self.debug.clone() {
            return Some(active);
        }
        Meetings::try_global(cx).and_then(|m| m.read(cx).active().cloned())
    }

    /// The live session when it belongs to the open note.
    pub fn ours(&self, cx: &App) -> Option<ActiveMeeting> {
        self.active(cx)
            .filter(|a| Some(&a.doc_id) == self.doc_id.as_ref())
    }

    pub fn recording(&self, cx: &App) -> bool {
        self.ours(cx)
            .is_some_and(|a| matches!(a.state, ActiveState::Recording | ActiveState::Starting))
    }

    fn on_active(&mut self, cx: &mut Context<Self>) {
        match self.ours(cx) {
            Some(active) if active.state == ActiveState::Recording => {
                self.meter
                    .push([active.mic.level, active.system.level], Instant::now());
                if self.tick.is_none() {
                    self.tick = Some(cx.spawn(async move |this, cx| {
                        loop {
                            cx.background_executor().timer(Duration::from_secs(1)).await;
                            if this.update(cx, |_, cx| cx.notify()).is_err() {
                                break;
                            }
                        }
                    }));
                }
            }
            _ => {
                self.meter = Meter::default();
                self.tick = None;
            }
        }
        cx.notify();
    }

    fn request_permission(&mut self, cx: &mut Context<Self>) {
        #[cfg(target_os = "macos")]
        cx.spawn(async move |this, cx| {
            let result = cx
                .background_executor()
                .spawn(async { cap_meeting_platform::request_audio_capture_permission() })
                .await;
            let granted = result == cap_meeting_platform::AudioCapturePermission::Granted;
            this.update(cx, |this, cx| {
                this.permission = Some(if granted {
                    tr::documents::health::allowed()
                } else {
                    tr::documents::health::still_denied()
                });
                cx.notify();
            })
            .ok();
        })
        .detach();
        #[cfg(not(target_os = "macos"))]
        {
            self.permission = Some(tr::documents::health::still_denied());
            cx.notify();
        }
    }

    fn stop(&mut self, cx: &mut Context<Self>) {
        #[cfg(debug_assertions)]
        if self.debug.take().is_some() {
            cx.notify();
            return;
        }
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.stop_recording(StopReason::User, cx));
        }
    }

    fn keep(&mut self, cx: &mut Context<Self>) {
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.keep_recording(cx));
        }
    }

    fn resume_offer(&mut self, cx: &mut Context<Self>) {
        if let Some(meetings) = Meetings::try_global(cx) {
            meetings.update(cx, |m, cx| m.resume(cx));
        }
    }

    fn dismiss(&mut self, banner: &Banner, cx: &mut Context<Self>) {
        match banner {
            Banner::Issue(issue) => {
                self.dismissed.insert(issue.clone());
            }
            Banner::Permission(_) => self.permission = None,
            _ => {}
        }
        cx.notify();
    }

    /// The one-line banner directly above the bottom bar: one problem, one
    /// action, and a way to dismiss it.
    pub fn banner(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let palette = self.palette;
        let ours = self.ours(cx);
        let banner = banner_for(
            ours.as_ref(),
            &self.dismissed,
            self.permission,
            Instant::now(),
        )?;
        let (text, actions, dismissable): (String, Vec<(&'static str, bool, u8)>, bool) =
            match &banner {
                Banner::Ending(secs) => (
                    tr::documents::bar::call_ended(format::countdown(*secs)),
                    vec![(tr::documents::bar::keep_recording(), true, 0)],
                    false,
                ),
                Banner::Inactive(secs) => (
                    tr::documents::bar::inactive(format::countdown(*secs)),
                    vec![
                        (tr::documents::bar::stop(), false, 1),
                        (tr::documents::bar::keep_recording(), true, 0),
                    ],
                    false,
                ),
                Banner::ResumeOffer { slept } => (
                    if *slept {
                        tr::documents::bar::stopped_asleep().to_string()
                    } else {
                        tr::documents::bar::stopped_quiet().to_string()
                    },
                    Vec::new(),
                    false,
                ),
                Banner::ResumedAfterSleep => (
                    tr::documents::bar::resumed_asleep().to_string(),
                    vec![(tr::documents::bar::stop(), false, 1)],
                    false,
                ),
                Banner::Permission(line) => (line.to_string(), Vec::new(), true),
                Banner::Issue(issue) => (
                    issue.message(),
                    match issue {
                        Issue::SystemPermission => vec![(tr::documents::health::allow(), true, 3)],
                        Issue::NoModel => vec![(tr::documents::health::open_settings(), true, 4)],
                        _ => Vec::new(),
                    },
                    true,
                ),
            };
        let dismiss_banner = banner.clone();
        Some(
            div()
                .id("documents-banner")
                .w_full()
                .min_h(px(42.))
                .pl(px(10.))
                .pr(px(6.))
                .py(px(4.))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(21.))
                .bg(palette.warning_soft)
                .border(px(1.5))
                .border_color(Hsla {
                    a: 0.35,
                    ..palette.warning
                })
                .child(style::art(
                    &doodles::MARK_ALERT,
                    palette.warning_doodle(),
                    self.banner_at,
                    22.,
                    22.,
                ))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_size(px(13.))
                        .line_height(px(18.))
                        .text_color(palette.text)
                        .child(text),
                )
                .children(actions.into_iter().map(|(label, primary, kind)| {
                    let button = if primary {
                        style::ink_pill(&palette, SharedString::from(format!("banner-{kind}")))
                            .h(px(30.))
                            .px(px(13.))
                    } else {
                        style::quiet_pill(&palette, SharedString::from(format!("banner-{kind}")))
                    };
                    button
                        .flex_shrink_0()
                        .aria_label(label)
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| match kind {
                            0 => this.keep(cx),
                            1 => this.stop(cx),
                            3 => this.request_permission(cx),
                            _ => cx.defer(crate::meetings_ui::settings::open),
                        }))
                }))
                .when(dismissable, |el| {
                    el.child(
                        style::icon_button(
                            &palette,
                            "banner-dismiss",
                            "icons/x.svg",
                            28.,
                            tr::common::dismiss(),
                        )
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.dismiss(&dismiss_banner, cx)),
                        ),
                    )
                })
                .into_any_element(),
        )
    }
}

fn capsule(palette: &Palette) -> gpui::Div {
    div()
        .h(px(46.))
        .px(px(6.))
        .flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(2.))
        .rounded_full()
        .bg(palette.capsule)
        .border(px(1.5))
        .border_color(palette.capsule_border)
        .shadow(palette.shadow())
}

fn dots(level: f32, color: Hsla) -> AnyElement {
    let height = level_to_height(level);
    div()
        .h(px(18.))
        .flex()
        .items_center()
        .gap(px(3.))
        .children(DOTS.iter().map(|shape| {
            div()
                .w(px(4.5))
                .h(px(4.5 + height * shape * 9.))
                .rounded_full()
                .bg(color)
        }))
        .into_any_element()
}

fn glyph(color: Hsla) -> AnyElement {
    div()
        .h(px(18.))
        .flex()
        .items_center()
        .gap(px(2.5))
        .children(
            [7., 14., 9.]
                .into_iter()
                .map(move |h| div().w(px(2.5)).h(px(h)).rounded_full().bg(color)),
        )
        .into_any_element()
}

/// A small dot that slowly breathes while something is being written.
fn breathing_dot(color: Hsla, now: Instant) -> AnyElement {
    let t = if style::reduce_motion() {
        1.
    } else {
        static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        let since = now.saturating_duration_since(*EPOCH.get_or_init(Instant::now));
        let phase = (since.as_secs_f32() % 1.6) / 1.6;
        0.55 + 0.45 * (phase * std::f32::consts::TAU).cos().abs()
    };
    div()
        .size(px(7.))
        .flex_shrink_0()
        .rounded_full()
        .bg(Hsla {
            a: color.a * t,
            ..color
        })
        .into_any_element()
}

impl RecordingBar {
    fn capsule(&self) -> gpui::Div {
        if self.panel_open || self.embedded {
            div()
                .h(px(46.))
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(2.))
        } else {
            capsule(&self.palette)
        }
    }

    fn segment(&self, id: &'static str) -> gpui::Stateful<gpui::Div> {
        let palette = self.palette;
        div()
            .id(id)
            .role(gpui::Role::Button)
            .when(palette.keyboard, crate::ui::keyboard_nav::stop)
            .h(px(34.))
            .px(px(10.))
            .flex()
            .items_center()
            .gap(px(7.))
            .rounded_full()
            .cursor_pointer()
            .text_size(px(13.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(palette.text)
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .hover(move |s| s.bg(palette.hover))
    }

    fn chevron(&self) -> AnyElement {
        svg()
            .path(if self.panel_open {
                "icons/chevron-down.svg"
            } else {
                "icons/chevron-up.svg"
            })
            .size(px(13.))
            .text_color(self.palette.muted)
            .into_any_element()
    }
}

impl Render for RecordingBar {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.palette.keyboard = crate::ui::keyboard_nav::active(window, cx);
        let palette = self.palette;
        if Meetings::try_global(cx).is_none() || self.doc_id.is_none() {
            return div().into_any_element();
        }
        let active = self.active(cx);
        let ours = active
            .as_ref()
            .filter(|a| Some(&a.doc_id) == self.doc_id.as_ref())
            .cloned();
        if let Some(active) = ours {
            return self.render_ours(active, window, cx);
        }
        if let Some(other) = active.filter(|a| a.state != ActiveState::ResumeOffered) {
            let id = other.doc_id.clone();
            let title = if other.title.trim().is_empty() {
                tr::documents::untitled().to_string()
            } else {
                other.title.clone()
            };
            return self
                .capsule()
                .pl(px(14.))
                .gap(px(8.))
                .child(div().size(px(8.)).rounded_full().bg(palette.live))
                .child(
                    div()
                        .max_w(px(220.))
                        .truncate()
                        .text_size(px(13.))
                        .text_color(palette.muted)
                        .child(tr::documents::bar::recording_elsewhere(title)),
                )
                .child(
                    self.segment("bar-show")
                        .aria_label(tr::documents::bar::show())
                        .child(tr::documents::bar::show())
                        .on_click(
                            cx.listener(move |_, _, _, cx| cx.emit(BarEvent::ShowDoc(id.clone()))),
                        ),
                )
                .into_any_element();
        }
        if !self.has_transcript {
            let offer = if self.linked { None } else { offer(cx) };
            let (label, event_id) = match offer {
                Some((title, event_id)) => (
                    tr::documents::bar::record_meeting(
                        crate::meetings_ui::live::model::short_title(&title, 28),
                    ),
                    event_id,
                ),
                None => (tr::documents::bar::record().to_string(), None),
            };
            return self
                .capsule()
                .child(
                    style::ink_pill(&palette, "bar-start")
                        .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                        .child(div().size(px(8.)).rounded_full().bg(palette.live))
                        .aria_label(label.clone())
                        .child(label)
                        .on_click(cx.listener(move |_, _, _, cx| {
                            cx.emit(BarEvent::Start(event_id.clone()))
                        })),
                )
                .into_any_element();
        }
        self.render_ended(cx)
    }
}

impl RecordingBar {
    /// After the meeting: the panel toggle and one item, never truncated.
    /// Record more sits where Stop was, so it ignores presses for a moment
    /// after Stop.
    fn render_ended(&self, cx: &mut Context<Self>) -> AnyElement {
        let palette = self.palette;
        let now = Instant::now();
        let kind = ended_item(self.writing, self.stopped_at, now);
        let writing_item = matches!(kind, EndedItem::Writing);
        let item: AnyElement = match kind {
            EndedItem::Writing => div()
                .id("bar-writing")
                .h(px(34.))
                .pl(px(6.))
                .pr(px(14.))
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(9.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(palette.muted)
                .child(breathing_dot(palette.accent, now))
                .child(
                    div()
                        .whitespace_nowrap()
                        .child(writing_line(self.notes_waiting(cx))),
                )
                .when(self.can_stop_writing, |el| {
                    el.child(
                        div()
                            .id("bar-stop-writing")
                            .role(gpui::Role::Button)
                            .when(palette.keyboard, crate::ui::keyboard_nav::stop)
                            .aria_label(tr::documents::notes::stop())
                            .ml(px(2.))
                            .px(px(8.))
                            .py(px(3.))
                            .rounded_full()
                            .cursor_pointer()
                            .text_color(palette.faint)
                            .hover(move |s| s.bg(palette.hover).text_color(palette.text))
                            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                            .child(tr::documents::notes::stop())
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(BarEvent::StopWriting))),
                    )
                })
                .into_any_element(),
            EndedItem::RecordMore { open } => self
                .segment("bar-record-more")
                .aria_label(tr::documents::bar::record_more())
                .pr(px(14.))
                .flex_shrink_0()
                .when(!open, |this| this.opacity(0.45).cursor_default())
                .child(div().size(px(7.)).rounded_full().bg(palette.live))
                .child(
                    div()
                        .whitespace_nowrap()
                        .child(tr::documents::bar::record_more()),
                )
                .on_click(cx.listener(|this, _, _, cx| this.record_more(cx)))
                .into_any_element(),
        };
        self.capsule()
            .child(
                self.segment("bar-panel")
                    .aria_label(tr::documents::export::transcript())
                    .aria_description(if self.panel_open {
                        tr::documents::a11y::expanded()
                    } else {
                        tr::documents::a11y::collapsed()
                    })
                    .child(glyph(palette.muted))
                    .child(self.chevron())
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(BarEvent::TogglePanel))),
            )
            .child(if style::reduce_motion() {
                item
            } else {
                // The one thing in this capsule changes when the summary is
                // done: let it settle in rather than snap.
                div()
                    .child(item)
                    .with_animation(
                        ("bar-ended-item", usize::from(writing_item)),
                        gpui::Animation::new(Duration::from_millis(220))
                            .with_easing(gpui::ease_out_quint()),
                        |el, t| el.opacity(0.25 + 0.75 * t),
                    )
                    .into_any_element()
            })
            .into_any_element()
    }

    fn render_ours(
        &mut self,
        active: ActiveMeeting,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let palette = self.palette;
        let now = Instant::now();
        let chevron = self.chevron();
        if active.state == ActiveState::ResumeOffered {
            return self
                .capsule()
                .child(
                    self.segment("bar-panel")
                        .aria_label(tr::documents::export::transcript())
                        .aria_description(if self.panel_open {
                            tr::documents::a11y::expanded()
                        } else {
                            tr::documents::a11y::collapsed()
                        })
                        .child(glyph(palette.muted))
                        .child(chevron)
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(BarEvent::TogglePanel))),
                )
                .child(
                    self.segment("bar-offer-resume")
                        .aria_label(tr::documents::bar::resume())
                        .pr(px(14.))
                        .text_color(palette.green)
                        .child(tr::documents::bar::resume())
                        .on_click(cx.listener(|this, _, _, cx| this.resume_offer(cx))),
                )
                .into_any_element();
        }
        if matches!(active.state, ActiveState::Starting | ActiveState::Stopping) {
            let label = if active.state == ActiveState::Starting {
                tr::documents::bar::starting()
            } else {
                tr::documents::bar::finishing()
            };
            return self
                .capsule()
                .px(px(18.))
                .gap(px(10.))
                .child(dots(0., palette.faint))
                .child(
                    div()
                        .text_size(px(13.))
                        .text_color(palette.muted)
                        .child(label),
                )
                .into_any_element();
        }
        let (levels, animating) = self.meter.current(now);
        if animating && surface_visible(window) && self.meter_frame.is_none() {
            self.meter_frame = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(METER_FRAME).await;
                this.update(cx, |this, cx| {
                    this.meter_frame = None;
                    cx.notify();
                })
                .ok();
            }));
        }
        let trouble = !issues(&active).is_empty();
        let elapsed =
            format::elapsed(now.saturating_duration_since(active.started).as_millis() as u64);
        self.capsule()
            .child(
                self.segment("bar-panel")
                    .aria_label(tr::documents::export::transcript())
                    .aria_description(if self.panel_open {
                        tr::documents::a11y::expanded()
                    } else {
                        tr::documents::a11y::collapsed()
                    })
                    .pl(px(12.))
                    .child(dots(
                        levels[0].max(levels[1]),
                        if trouble {
                            palette.warning
                        } else {
                            palette.green
                        },
                    ))
                    .child(chevron)
                    .child(
                        div()
                            .min_w(px(38.))
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(palette.muted)
                            .child(elapsed),
                    )
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(BarEvent::TogglePanel))),
            )
            .child(
                style::ink_pill(&palette, "bar-stop")
                    .aria_label(tr::documents::bar::stop())
                    .ml(px(4.))
                    .pl(px(13.))
                    .pr(px(15.))
                    .flex_shrink_0()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(div().size(px(10.)).rounded(px(2.5)).bg(palette.live))
                    .child(tr::documents::bar::stop())
                    .on_click(cx.listener(|this, _, _, cx| this.stop(cx))),
            )
            .into_any_element()
    }
}

#[cfg(debug_assertions)]
impl RecordingBar {
    pub fn debug_active(&mut self, kind: &str, cx: &mut Context<Self>) {
        use crate::meetings::{EngineStatus, HealthIssue, SourceHealth, engine::EngineKind};
        let Some(doc_id) = self.doc_id.clone() else {
            return;
        };
        let now = Instant::now();
        let mut active = ActiveMeeting {
            doc_id: doc_id.clone(),
            title: String::new(),
            started_at: chrono::Utc::now(),
            started: now - Duration::from_secs(if kind == "new" { 4 } else { 754 }),
            state: ActiveState::Recording,
            mic: crate::meetings::SourceState {
                level: 0.32,
                health: SourceHealth::Ok,
                ..Default::default()
            },
            system: crate::meetings::SourceState {
                level: 0.12,
                health: SourceHealth::Ok,
                ..Default::default()
            },
            engine: EngineStatus::default(),
            warning: None,
            resume_offer_until: None,
            slept: false,
            resumed_after_sleep: false,
            app_name: Some("Zoom".into()),
            event_id: None,
            health: Vec::new(),
            not_hearing: false,
            audio_failed: false,
            low_disk: false,
        };
        match kind {
            "countdown" => {
                active.warning = Some(MeetingWarning::Ending {
                    stop_at: now + Duration::from_secs(12),
                    reason: StopReason::CallEnded,
                })
            }
            "inactivity" => {
                active.warning = Some(MeetingWarning::Inactivity {
                    stop_at: now + Duration::from_secs(45),
                })
            }
            "resume" => {
                active.state = ActiveState::ResumeOffered;
                active.resume_offer_until = Some(now + Duration::from_secs(60));
            }
            "starting" => active.state = ActiveState::Starting,
            "finishing" => active.state = ActiveState::Stopping,
            "health" => {
                active.system.health = SourceHealth::Error(HealthIssue::MissingPermission);
                active.mic.health = SourceHealth::Silent;
            }
            "model" => {
                active.engine = EngineStatus {
                    kind: EngineKind::None,
                    issue: Some("no model".into()),
                    ..EngineStatus::default()
                };
            }
            "offline" => {
                active.engine.cloud = crate::meetings::engine::CloudState::Down { local: false };
            }
            "not-hearing" => active.not_hearing = true,
            "disk" => active.low_disk = true,
            "elsewhere" => {
                active.doc_id = "someone-else".into();
                active.title = "Weekly product sync".into();
            }
            _ => {}
        }
        self.meter = Meter {
            from: [active.mic.level, active.system.level],
            to: [active.mic.level, active.system.level],
            at: None,
        };
        self.banner_at = now;
        active.health = crate::meetings::health::concerns(&active);
        self.debug = Some(active);
        cx.notify();
    }
}
