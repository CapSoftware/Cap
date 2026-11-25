use std::time::{Duration, Instant};

use gpui::{
    AnyWindowHandle, App, AppContext as _, Bounds, Context, FontWeight, Global, Hsla,
    InteractiveElement, IntoElement, MouseButton, MouseMoveEvent, MouseUpEvent, ParentElement,
    Render, SharedString, StatefulInteractiveElement, Styled, Task, Window,
    WindowBackgroundAppearance, WindowBounds, WindowHandle, WindowKind, WindowOptions, div, point,
    prelude::FluentBuilder, px, size,
};

use super::model::{self, Dock, Rect};
use super::native::{self, Panel};
use crate::i18n::tr;
use crate::meetings::{ActiveMeeting, ActiveState, MeetingWarning, StopReason};
use crate::theme::{LocaleFont as _, Theme};

pub const TITLE: &str = "Cap Meeting Indicator";
const RADIUS: f32 = 24.;
const COLLAPSE_AFTER: Duration = Duration::from_millis(650);
const RESIZE: Duration = Duration::from_millis(200);
/// How long the "still recording" line shows after the indicator is hidden.
const HIDDEN_NOTE: Duration = Duration::from_millis(1800);
/// A countdown up to this long drains ten times a second; a longer one (a
/// Resume kept up after a sleep) moves too slowly to need it.
const FAST_COUNTDOWN: Duration = Duration::from_secs(120);

/// A press on the body. macOS moves the panel itself (screen points);
/// elsewhere the window manager does, once the press has moved (window px).
struct Drag {
    cursor: (f64, f64),
    frame: Rect,
    moved: bool,
}

pub struct Indicator {
    theme: Theme,
    hovered: bool,
    expanded: bool,
    collapse: Option<Task<()>>,
    tick: Option<Task<()>>,
    drag: Option<Drag>,
    button_pressed: bool,
    dock: Dock,
    screen: Option<String>,
    panel: Option<Panel>,
    active: Option<ActiveMeeting>,
    meter: (u8, u8),
    material: bool,
    /// The countdown being shown and how long it was when it appeared.
    countdown: Option<(Instant, Duration)>,
    tick_fast: bool,
    /// Hidden for good: a short line says recording goes on, then it fades.
    hiding: Option<Task<()>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Banner {
    Ending,
    Inactivity,
    Resume,
    Stopping,
    /// The call went on through a sleep and so did the meeting.
    Resumed,
}

pub fn banner(active: &ActiveMeeting) -> Option<Banner> {
    match (active.state, active.warning) {
        (ActiveState::ResumeOffered, _) => Some(Banner::Resume),
        (ActiveState::Stopping, _) => Some(Banner::Stopping),
        (_, Some(MeetingWarning::Ending { .. })) => Some(Banner::Ending),
        (_, Some(MeetingWarning::Inactivity { .. })) => Some(Banner::Inactivity),
        (ActiveState::Recording, None) if active.resumed_after_sleep => Some(Banner::Resumed),
        _ => None,
    }
}

/// When the banner's countdown runs out, if it has one.
pub fn countdown_until(active: &ActiveMeeting) -> Option<Instant> {
    match (active.state, active.warning) {
        (ActiveState::ResumeOffered, _) => active.resume_offer_until,
        (_, Some(MeetingWarning::Ending { stop_at, .. }))
        | (_, Some(MeetingWarning::Inactivity { stop_at })) => Some(stop_at),
        _ => None,
    }
}

pub fn countdown_secs(active: &ActiveMeeting) -> Option<u64> {
    countdown_until(active).map(|until| {
        until
            .saturating_duration_since(Instant::now())
            .as_millis()
            .div_ceil(1000) as u64
    })
}

/// How much of the countdown is left, 1 at the start and 0 at the end.
pub fn countdown_left(until: Instant, total: Duration, now: Instant) -> f32 {
    if total.is_zero() {
        return 0.;
    }
    (until.saturating_duration_since(now).as_secs_f32() / total.as_secs_f32()).clamp(0., 1.)
}

/// The indicator's short form of the meeting's health line.
pub fn health_text(active: &ActiveMeeting) -> Option<String> {
    use crate::meetings::health::Concern;
    let concern = active.health.first()?;
    Some(match concern {
        Concern::MicPermission => tr::meeting::health::mic_permission().into(),
        Concern::NoMicrophone => tr::meeting::health::mic_no_device().into(),
        Concern::MicNotWorking => tr::meeting::health::mic_failed().into(),
        Concern::MicSilent => tr::meeting::health::mic_no_audio().into(),
        Concern::SystemPermission => tr::meeting::health::system_permission().into(),
        Concern::NotHearingApp(Some(app)) => tr::meeting::health::not_hearing(app),
        Concern::NotHearingApp(None) => tr::meeting::health::system_no_audio().into(),
        Concern::SystemFailed(_) => tr::meeting::health::system_failed().into(),
        Concern::TapUnsupported => tr::meeting::health::system_unsupported().into(),
        Concern::DiskFull => tr::meeting::health::disk_full().into(),
        Concern::SignIn => tr::meeting::health::sign_in().into(),
        Concern::CloudCatchingUp => tr::meeting::health::offline().into(),
        Concern::CloudLocal => tr::meeting::health::cloud_local().into(),
        Concern::CloudLimitWaiting | Concern::CloudLimitLocal => {
            tr::meeting::health::cloud_limit().into()
        }
        Concern::WordsMissing => tr::meeting::health::words_missing().into(),
        Concern::NoModel => return None,
    })
}

/// The banner's short title; the time left sits beside it on its own.
pub fn banner_title(banner: Banner) -> &'static str {
    match banner {
        Banner::Ending => tr::meeting::live::call_ended(),
        Banner::Inactivity => tr::meeting::live::still_there(),
        Banner::Resume | Banner::Stopping => tr::meeting::live::stopped(),
        Banner::Resumed => tr::meeting::live::resumed(),
    }
}

/// A hairline around the floating surfaces, the same for the indicator and
/// the meeting prompt.
pub fn hairline(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        gpui::hsla(0., 0., 1., 0.12)
    } else {
        gpui::hsla(0., 0., 0., 0.08)
    }
}

impl Indicator {
    fn new(
        dock: Dock,
        screen: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        crate::theme::bind_window(window, cx);
        let mut this = Self {
            theme: Theme::for_window(window, cx, cfg!(target_os = "macos")),
            hovered: false,
            expanded: false,
            collapse: None,
            tick: None,
            drag: None,
            button_pressed: false,
            dock,
            screen,
            panel: None,
            active: None,
            meter: (0, 0),
            material: false,
            countdown: None,
            tick_fast: false,
            hiding: None,
        };
        if !native::can_move_windows() {
            cx.observe_window_bounds(window, |this, window, cx| this.window_moved(window, cx))
                .detach();
        }
        this.reload(cx);
        this
    }

    fn reload(&mut self, cx: &mut Context<Self>) {
        let active = super::active(cx);
        let meter = super::Live::global(cx).map_or((0, 0), |live| live.read(cx).meter());
        let until = active.as_ref().and_then(countdown_until);
        if until != self.countdown.map(|(at, _)| at) {
            self.countdown = until.map(|at| (at, at.saturating_duration_since(Instant::now())));
        }
        if active != self.active || meter != self.meter {
            self.active = active;
            self.meter = meter;
            cx.notify();
        }
        self.update_expansion(cx);
    }

    fn reload_meter(&mut self, cx: &mut Context<Self>) {
        let meter = super::Live::global(cx).map_or((0, 0), |live| live.read(cx).meter());
        if meter != self.meter {
            self.meter = meter;
            if let Some(active) = &mut self.active {
                active.mic.level = 0.;
                active.system.level = 0.;
            }
            cx.notify();
        }
    }

    fn wants_expanded(&self) -> bool {
        if self.drag.as_ref().is_some_and(|drag| drag.moved) {
            return false;
        }
        self.hiding.is_some() || self.active.as_ref().and_then(banner).is_some()
    }

    fn update_expansion(&mut self, cx: &mut Context<Self>) {
        let want = self.wants_expanded();
        if want {
            self.collapse = None;
            if !self.expanded {
                self.set_expanded(true, cx);
            }
        } else if self.expanded && self.collapse.is_none() {
            let delay = if self.hovered {
                Duration::ZERO
            } else {
                COLLAPSE_AFTER
            };
            self.collapse = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(delay).await;
                this.update(cx, |this, cx| {
                    this.collapse = None;
                    if !this.wants_expanded() {
                        this.set_expanded(false, cx);
                    }
                })
                .ok();
            }));
        }
        // The elapsed time is always on show, so it ticks once a second while
        // recording (ten times while a countdown line drains).
        let ticking = self.hiding.is_none()
            && self.active.as_ref().is_some_and(|active| {
                matches!(active.state, ActiveState::Recording | ActiveState::Starting)
                    || countdown_secs(active).is_some()
            });
        let fast = self
            .countdown
            .is_some_and(|(_, total)| total <= FAST_COUNTDOWN);
        if !ticking {
            self.tick = None;
        } else if self.tick.is_none() || self.tick_fast != fast {
            // The countdown line drains smoothly; everything else is a clock.
            self.tick_fast = fast;
            let every = Duration::from_millis(if fast { 100 } else { 1000 });
            self.tick = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(every).await;
                    if this.update(cx, |_, cx| cx.notify()).is_err() {
                        return;
                    }
                }
            }));
        }
    }

    fn width(&self) -> f64 {
        // Off macOS a window can only grow to the right, so the hidden line
        // stays inside the pill there instead of running off a screen edge.
        let wide_note = self.hiding.is_none() || native::can_move_windows();
        if self.expanded && wide_note {
            model::INDICATOR_EXPANDED_WIDTH
        } else {
            model::INDICATOR_WIDTH
        }
    }

    fn set_expanded(&mut self, expanded: bool, cx: &mut Context<Self>) {
        let Some(panel) = self.panel.clone() else {
            self.expanded = expanded;
            cx.notify();
            return;
        };
        let duration = native::motion(cx, RESIZE);
        let frame = panel.frame();
        let width = if expanded {
            model::INDICATOR_EXPANDED_WIDTH
        } else {
            model::INDICATOR_WIDTH
        };
        let x = if self.dock.right() {
            frame.x + frame.w - width
        } else {
            frame.x
        };
        let target = Rect::new(x, frame.y, width, model::INDICATOR_HEIGHT);
        if expanded {
            self.expanded = true;
            cx.notify();
            cx.spawn(async move |_, _| panel.animate(target, 1., duration))
                .detach();
        } else {
            cx.spawn(async move |this, cx| {
                panel.animate(target, 1., duration);
                cx.background_executor().timer(duration).await;
                this.update(cx, |this, cx| {
                    if !this.wants_expanded() {
                        this.expanded = false;
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    fn start_drag(&mut self, cx: &mut Context<Self>) {
        if self.button_pressed {
            return;
        }
        let (Some(cursor), Some(panel)) = (native::cursor(cx), &self.panel) else {
            return;
        };
        self.drag = Some(Drag {
            cursor,
            frame: panel.frame(),
            moved: false,
        });
        cx.notify();
    }

    fn drag_move(&mut self, cx: &mut Context<Self>) {
        let Some(cursor) = native::cursor(cx) else {
            return;
        };
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        if !drag.moved && !model::dragged(drag.cursor, cursor) {
            return;
        }
        let first = !drag.moved;
        drag.moved = true;
        let mut target = drag
            .frame
            .offset(cursor.0 - drag.cursor.0, cursor.1 - drag.cursor.1);
        if self.expanded {
            target.w = model::INDICATOR_WIDTH;
            if self.dock.right() {
                target.x += model::INDICATOR_EXPANDED_WIDTH - model::INDICATOR_WIDTH;
            }
            target.x = cursor.0 - target.w / 2.;
            if first {
                self.expanded = false;
                self.collapse = None;
                cx.notify();
            }
        }
        if let Some(panel) = self.panel.clone() {
            cx.spawn(async move |_, _| panel.place(target, 1.)).detach();
        }
    }

    fn end_drag(&mut self, cx: &mut Context<Self>) {
        let pressed = std::mem::take(&mut self.button_pressed);
        let Some(drag) = self.drag.take() else {
            return;
        };
        cx.notify();
        if drag.moved {
            self.snap(cx);
        } else if !pressed {
            let doc = self.active.as_ref().map(|active| active.doc_id.clone());
            cx.defer(move |cx| super::open_document(doc, cx));
        }
    }

    fn snap(&mut self, cx: &mut Context<Self>) {
        let Some(panel) = self.panel.clone() else {
            return;
        };
        let frame = panel.frame();
        let screens = native::screens(cx);
        let Some(screen) = model::screen_for_point(&screens, Some(frame.center())).cloned() else {
            return;
        };
        self.dock = model::snap(screen.visible, frame);
        self.screen = Some(screen.id.clone());
        remember(&screen.id, self.dock, cx);
        let target = model::indicator_frame(screen.visible, self.dock, self.width());
        let duration = native::motion(cx, Duration::from_millis(240));
        cx.spawn(async move |_, _| panel.animate(target, 1., duration))
            .detach();
        self.update_expansion(cx);
    }

    fn surface(&self) -> (Hsla, Option<Hsla>) {
        let theme = &self.theme;
        if self.material {
            return (theme.shell_bg(), theme.shell_border());
        }
        if theme.is_dark() {
            (theme.gray_2.into(), Some(hairline(theme)))
        } else {
            (gpui::white(), Some(hairline(theme)))
        }
    }

    fn small_button(
        &self,
        id: &'static str,
        label: &'static str,
        destructive: bool,
        on_click: impl Fn(&mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let paper = crate::onboarding_window::Paper::new(&theme);
        let quiet = |alpha: f32| {
            if theme.is_dark() {
                gpui::hsla(0., 0., 1., alpha + 0.04)
            } else {
                gpui::hsla(0., 0., 0., alpha)
            }
        };
        let (bg, hover, fg) = if destructive {
            (quiet(0.06), quiet(0.1), Hsla::from(theme.gray_12))
        } else {
            (paper.ink, paper.ink.opacity(0.88), surface_ink(&theme))
        };
        div()
            .id(id)
            .role(gpui::Role::Button)
            .aria_label(label)
            .flex()
            .items_center()
            .h(px(24.))
            .px(px(9.))
            .flex_shrink_0()
            .rounded_full()
            .bg(bg)
            .hover(move |style| style.bg(hover))
            .text_size(px(11.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .whitespace_nowrap()
            .child(label)
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.button_pressed = true),
            )
            .on_click(move |_, _, cx| {
                cx.stop_propagation();
                on_click(cx);
            })
    }

    /// The live level: three soft bars, both voices together, steady while
    /// nobody speaks. It only changes when the level's step does (at most a
    /// few times a second), so it never asks for frames of its own.
    fn render_level(&self, active: Option<&ActiveMeeting>) -> impl IntoElement {
        let theme = self.theme;
        let trouble = active.and_then(health_text).is_some();
        let color = if trouble {
            Hsla::from(theme.amber_11)
        } else {
            Hsla::from(theme.blue_9)
        };
        let step = self.meter.0.max(self.meter.1);
        let silent = step == 0;
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(2.5))
            .h(px(18.))
            .flex_shrink_0()
            .children(model::meter_bars(step).into_iter().map(move |fill| {
                let (height, color) = if silent {
                    (4., color.opacity(0.35))
                } else {
                    ((18. * fill).max(4.), color)
                };
                div().w(px(3.)).h(px(height)).rounded_full().bg(color)
            }))
    }

    /// Recording at a glance: Stop, the time, the level, and a quiet x that
    /// shows on hover and hides the indicator for good.
    fn render_row(&self, active: &ActiveMeeting, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let recording = matches!(active.state, ActiveState::Recording | ActiveState::Starting);
        let trouble = health_text(active).is_some();
        let quiet = |alpha: f32| {
            if theme.is_dark() {
                gpui::hsla(0., 0., 1., alpha + 0.04)
            } else {
                gpui::hsla(0., 0., 0., alpha)
            }
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .size_full()
            .pl(px(9.))
            .pr(px(10.))
            .gap(px(10.))
            .child(if recording {
                self.render_stop(30., cx).into_any_element()
            } else {
                div()
                    .size(px(8.))
                    .mx(px(11.))
                    .rounded_full()
                    .bg(Hsla::from(theme.gray_9))
                    .into_any_element()
            })
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .flex_1()
                    .min_w_0()
                    .when(trouble, |this| {
                        this.child(
                            div()
                                .size(px(6.))
                                .flex_shrink_0()
                                .rounded_full()
                                .bg(Hsla::from(theme.amber_11)),
                        )
                    })
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(px(18.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(theme.gray_12)
                            .child(model::elapsed(active.started.elapsed().as_secs())),
                    ),
            )
            .child(self.render_level(Some(active)))
            .child(
                div()
                    .id("indicator-hide")
                    .role(gpui::Role::Button)
                    .aria_label(tr::meeting::live::hide())
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.))
                    .flex_shrink_0()
                    .rounded_full()
                    .cursor_pointer()
                    .bg(quiet(0.06))
                    .hover(move |style| style.bg(quiet(0.12)))
                    .child(
                        gpui::svg()
                            .path("icons/x.svg")
                            .size(px(10.))
                            .text_color(theme.gray_11),
                    )
                    .when(!self.hovered && !super::debug_indicator_hover(cx), |this| {
                        this.invisible()
                    })
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, _| this.button_pressed = true),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        cx.stop_propagation();
                        this.hide_for_good(cx);
                    })),
            )
            .into_any_element()
    }

    /// The x: hidden for good. A short line says the recording goes on,
    /// then the setting turns off and the indicator fades away.
    fn hide_for_good(&mut self, cx: &mut Context<Self>) {
        if self.hiding.is_some() {
            return;
        }
        self.hiding = Some(cx.spawn(async move |_, cx| {
            cx.background_executor().timer(HIDDEN_NOTE).await;
            cx.update(|cx| {
                if let Some(meetings) = crate::meetings::Meetings::try_global(cx) {
                    meetings.update(cx, |meetings, cx| {
                        meetings.update_settings(|s| s.recording.show_indicator = false, cx)
                    });
                }
            });
        }));
        tracing::info!("meeting indicator hidden for good");
        self.update_expansion(cx);
        cx.notify();
    }

    /// A press on the body: a drag moves the indicator, a click opens the
    /// notes. macOS moves the panel itself; elsewhere the press is handed to
    /// the window manager once it has moved far enough to be a drag.
    fn press(&mut self, position: gpui::Point<gpui::Pixels>, cx: &mut Context<Self>) {
        if native::can_move_windows() {
            self.start_drag(cx);
            return;
        }
        if self.button_pressed {
            return;
        }
        self.drag = Some(Drag {
            cursor: (f64::from(position.x), f64::from(position.y)),
            frame: Rect::default(),
            moved: false,
        });
        cx.notify();
    }

    fn os_drag_move(&mut self, position: gpui::Point<gpui::Pixels>, window: &mut Window) {
        let Some(drag) = self.drag.as_mut() else {
            return;
        };
        if drag.moved
            || !model::dragged(drag.cursor, (f64::from(position.x), f64::from(position.y)))
        {
            return;
        }
        drag.moved = true;
        window.start_window_move();
    }

    /// Off macOS the window manager moved it: remember where, per display.
    fn window_moved(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bounds = window.bounds();
        // A banner widened a right-side indicator leftward: where it rests is
        // still its collapsed spot at the same right edge.
        let width = f64::from(bounds.size.width);
        let x = if self.dock.right() && width > model::INDICATOR_WIDTH {
            f64::from(bounds.origin.x) + width - model::INDICATOR_WIDTH
        } else {
            f64::from(bounds.origin.x)
        };
        let frame = Rect::new(
            x,
            f64::from(bounds.origin.y),
            model::INDICATOR_WIDTH,
            model::INDICATOR_HEIGHT,
        );
        let screens = native::screens(cx);
        let Some(screen) = model::screen_for_point(&screens, Some(frame.center())).cloned() else {
            return;
        };
        let dock = model::snap(screen.visible, frame);
        if dock != self.dock || self.screen.as_deref() != Some(screen.id.as_str()) {
            self.dock = dock;
            self.screen = Some(screen.id.clone());
            remember(&screen.id, dock, cx);
        }
    }

    fn render_details(&self, active: &ActiveMeeting, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = self.theme;
        let line1 = div()
            .truncate()
            .text_size(px(13.))
            .line_height(px(17.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.gray_12);
        let line2 = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(6.))
            .text_size(px(11.5))
            .line_height(px(15.))
            .font_weight(FontWeight::NORMAL)
            .text_color(theme.gray_11);
        let column = div()
            .flex()
            .flex_col()
            .justify_center()
            .gap(px(4.))
            .flex_1()
            .min_w_0();
        match banner(active) {
            Some(banner_kind) => {
                let left = countdown_secs(active).map(model::elapsed);
                let buttons: Vec<gpui::AnyElement> = match banner_kind {
                    Banner::Ending => vec![
                        self.small_button(
                            "indicator-keep",
                            tr::meeting::live::keep_recording(),
                            false,
                            super::keep_recording,
                            cx,
                        )
                        .into_any_element(),
                    ],
                    Banner::Inactivity => vec![
                        self.small_button(
                            "indicator-keep",
                            tr::meeting::live::keep_recording(),
                            false,
                            super::keep_recording,
                            cx,
                        )
                        .into_any_element(),
                        self.small_button(
                            "indicator-stop",
                            tr::meeting::live::stop(),
                            true,
                            |cx| super::stop(StopReason::UserFromIndicator, cx),
                            cx,
                        )
                        .into_any_element(),
                    ],
                    Banner::Resume => vec![
                        self.small_button(
                            "indicator-resume",
                            tr::meeting::live::resume(),
                            false,
                            super::resume,
                            cx,
                        )
                        .into_any_element(),
                    ],
                    Banner::Stopping => Vec::new(),
                    Banner::Resumed => vec![
                        self.small_button(
                            "indicator-stop",
                            tr::meeting::live::stop(),
                            true,
                            |cx| super::stop(StopReason::UserFromIndicator, cx),
                            cx,
                        )
                        .into_any_element(),
                    ],
                };
                // One calm row: what happened, the time left, the way out.
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(8.))
                    .flex_1()
                    .min_w_0()
                    .child(line1.min_w_0().child(banner_title(banner_kind)))
                    .children(left.map(|left| {
                        div()
                            .flex_shrink_0()
                            .text_size(px(12.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(theme.gray_11)
                            .child(left)
                    }))
                    .child(div().flex_1())
                    .children(buttons)
                    .into_any_element()
            }
            None => {
                let title = if active.title.trim().is_empty() {
                    tr::meeting::live::untitled().to_string()
                } else {
                    active.title.clone()
                };
                let problem = health_text(active);
                column
                    .child(line1.child(title))
                    .child(match problem {
                        Some(problem) => line2
                            .text_color(theme.amber_11)
                            .child(div().truncate().child(problem)),
                        None => line2
                            .child(div().child(model::elapsed(active.started.elapsed().as_secs()))),
                    })
                    .into_any_element()
            }
        }
    }

    fn render_stop(&self, size: f32, cx: &mut Context<Self>) -> impl IntoElement {
        let paper = crate::onboarding_window::Paper::new(&self.theme);
        div()
            .id("indicator-stop-circle")
            .role(gpui::Role::Button)
            .aria_label(tr::meeting::live::stop())
            .flex()
            .items_center()
            .justify_center()
            .flex_shrink_0()
            .size(px(size))
            .rounded_full()
            .cursor_pointer()
            .bg(paper.red)
            .hover(|style| style.opacity(0.88))
            .child(
                div()
                    .size(px((size / 3.).round()))
                    .rounded(px(3.))
                    .bg(gpui::white()),
            )
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, _| this.button_pressed = true),
            )
            .on_click(|_, _, cx| {
                cx.stop_propagation();
                cx.defer(|cx| super::stop(StopReason::UserFromIndicator, cx));
            })
    }
}

#[cfg(debug_assertions)]
static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Render for Indicator {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(debug_assertions)]
        RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.theme.refresh(window, cx, self.material);
        let theme = self.theme;
        let (bg, border) = self.surface();
        let active = self.active.clone();
        let expanded = self.expanded;
        let dragging = self.drag.is_some();

        // Off macOS the window keeps the size it opened with; a banner (or
        // the hidden line) widens it, toward the free side of the screen.
        if !native::can_move_windows() {
            let want = px(self.width() as f32);
            if window.bounds().size.width != want {
                let keep_right = self.dock.right();
                window.defer(cx, move |window, _| {
                    let height = model::INDICATOR_HEIGHT;
                    if !(keep_right
                        && native::resize_keeping_right_edge(window, f64::from(want), height))
                    {
                        window.resize(size(want, px(height as f32)))
                    }
                });
            }
        }
        let banner_kind = active.as_ref().and_then(banner);
        let hiding = self.hiding.is_some();

        div()
            .id("meeting-indicator")
            .size_full()
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .rounded(px(RADIUS))
            .bg(bg)
            .when_some(border, |this, border| this.border_1().border_color(border))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .font_weight(FontWeight::MEDIUM)
            .text_color(theme.gray_12)
            .role(gpui::Role::Button)
            .aria_label(SharedString::from(tr::meeting::live::open_notes()))
            // Grab it anywhere to move it.
            .cursor(if dragging {
                gpui::CursorStyle::ClosedHand
            } else {
                gpui::CursorStyle::OpenHand
            })
            .on_hover(cx.listener(|this, hovered: &bool, _, cx| {
                if this.hovered != *hovered {
                    this.hovered = *hovered;
                    this.update_expansion(cx);
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &gpui::MouseDownEvent, _, cx| {
                    this.press(event.position, cx)
                }),
            )
            .when(dragging, |this| {
                let mover = cx.entity().downgrade();
                let upper = cx.entity().downgrade();
                this.child(
                    gpui::canvas(
                        |_, _, _| (),
                        move |_, (), window, _| {
                            let mover = mover.clone();
                            window.on_mouse_event(
                                move |event: &MouseMoveEvent, phase, window, cx| {
                                    if phase != gpui::DispatchPhase::Bubble {
                                        return;
                                    }
                                    mover
                                        .update(cx, |this, cx| {
                                            if !event.dragging() {
                                                this.end_drag(cx);
                                            } else if native::can_move_windows() {
                                                this.drag_move(cx);
                                            } else {
                                                this.os_drag_move(event.position, window);
                                            }
                                        })
                                        .ok();
                                },
                            );
                            let upper = upper.clone();
                            window.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                                if phase != gpui::DispatchPhase::Bubble
                                    || event.button != MouseButton::Left
                                {
                                    return;
                                }
                                upper.update(cx, |this, cx| this.end_drag(cx)).ok();
                            });
                        },
                    )
                    .absolute()
                    .size_full(),
                )
            })
            .map(|this| match &active {
                _ if hiding && native::can_move_windows() => this.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .px(px(18.))
                        .truncate()
                        .text_size(px(13.))
                        .text_color(theme.gray_12)
                        .child(tr::meeting::live::hidden()),
                ),
                _ if hiding => this.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .px(px(14.))
                        .text_size(px(10.5))
                        .line_height(px(13.))
                        .text_color(theme.gray_12)
                        .child(tr::meeting::live::hidden()),
                ),
                Some(active) if banner_kind.is_some() || expanded => this.child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(10.))
                        .size_full()
                        .pl(px(9.))
                        .pr(px(14.))
                        .child(
                            if matches!(
                                active.state,
                                ActiveState::Recording | ActiveState::Starting
                            ) {
                                self.render_stop(30., cx).into_any_element()
                            } else {
                                div().size(px(8.)).mx(px(11.)).into_any_element()
                            },
                        )
                        .child(self.render_details(active, cx)),
                ),
                Some(active) => this.child(self.render_row(active, cx)),
                None => this,
            })
            .when_some(
                self.countdown.filter(|_| expanded && !hiding),
                |this, (until, total)| {
                    let left = countdown_left(until, total, Instant::now());
                    this.child(countdown_line(&theme, left))
                },
            )
    }
}

/// The calm countdown both floating surfaces use: a 2 px line along the
/// bottom edge that drains as the time runs out.
pub fn countdown_line(theme: &Theme, left: f32) -> gpui::AnyElement {
    let track = if theme.is_dark() {
        gpui::hsla(0., 0., 1., 0.1)
    } else {
        gpui::hsla(0., 0., 0., 0.06)
    };
    div()
        .absolute()
        .bottom(px(0.))
        .left(px(RADIUS))
        .right(px(RADIUS))
        .h(px(2.))
        .rounded_full()
        .bg(track)
        .child(
            div()
                .h_full()
                .w(gpui::relative(left.clamp(0., 1.)))
                .rounded_full()
                .bg(Hsla::from(theme.gray_11)),
        )
        .into_any_element()
}

#[derive(Default)]
struct IndicatorSlot {
    handle: Option<WindowHandle<Indicator>>,
    observer: Option<native::Observer>,
    observer_task: Option<Task<()>>,
    hidden_for_app: bool,
}

impl Global for IndicatorSlot {}

fn remembered(cx: &App) -> (Option<String>, Dock) {
    let memory = crate::store::load().meeting_indicator.unwrap_or_default();
    let screens = native::screens(cx);
    let primary = model::screen_for_point(&screens, None).map(|screen| screen.id.clone());
    let display = memory
        .last_display
        .filter(|id| screens.iter().any(|screen| &screen.id == id))
        .or(primary);
    let dock = display
        .as_ref()
        .and_then(|id| memory.docks.iter().find(|dock| &dock.display == id))
        .map(dock_of)
        .unwrap_or_default();
    (display, dock)
}

/// A remembered spot; files from before free placement only knew the edge.
pub(super) fn dock_of(remembered: &crate::store::RememberedIndicatorDock) -> Dock {
    Dock {
        x: remembered
            .x
            .unwrap_or(if remembered.right { 1. } else { 0. }),
        y: remembered.y,
    }
}

fn remember(display: &str, dock: Dock, cx: &mut App) {
    let display = display.to_string();
    cx.background_executor()
        .spawn(async move {
            crate::store::update(|state| {
                let memory = state.meeting_indicator.get_or_insert_default();
                memory.last_display = Some(display.clone());
                memory
                    .docks
                    .retain(|remembered| remembered.display != display);
                memory.docks.push(crate::store::RememberedIndicatorDock {
                    display,
                    right: dock.right(),
                    y: dock.y,
                    x: Some(dock.x),
                });
            });
        })
        .detach();
}

fn wanted(cx: &App) -> bool {
    shows(super::active(cx).is_some(), super::settings(cx).as_ref())
}

/// Shown while a meeting records, unless it was hidden (the x, or Settings).
pub(super) fn shows(
    recording: bool,
    settings: Option<&cap_meetings::settings::MeetingSettings>,
) -> bool {
    recording && settings.is_some_and(|settings| settings.recording.show_indicator)
}

pub fn sync(cx: &mut App) {
    let want = wanted(cx);
    let open = cx
        .try_global::<IndicatorSlot>()
        .and_then(|slot| slot.handle)
        .is_some();
    if want && !open {
        open_window(cx);
    } else if !want && open {
        close(cx);
    } else if want {
        refresh(cx);
    }
}

pub fn refresh(cx: &mut App) {
    if let Some(handle) = cx
        .try_global::<IndicatorSlot>()
        .and_then(|slot| slot.handle)
    {
        handle
            .update(cx, |indicator, _, cx| indicator.reload(cx))
            .ok();
    }
}

pub fn refresh_meter(cx: &mut App) {
    if let Some(handle) = cx
        .try_global::<IndicatorSlot>()
        .and_then(|slot| slot.handle)
    {
        handle
            .update(cx, |indicator, _, cx| indicator.reload_meter(cx))
            .ok();
    }
}

pub fn handle(cx: &App) -> Option<AnyWindowHandle> {
    cx.try_global::<IndicatorSlot>()
        .and_then(|slot| slot.handle)
        .map(Into::into)
}

fn open_window(cx: &mut App) {
    let (display, dock) = remembered(cx);
    let screens = native::screens(cx);
    let screen = display
        .as_ref()
        .and_then(|id| screens.iter().find(|screen| &screen.id == id))
        .or_else(|| model::screen_for_point(&screens, None))
        .cloned();
    let frame = screen
        .as_ref()
        .map(|screen| model::indicator_frame(screen.visible, dock, model::INDICATOR_WIDTH))
        .unwrap_or(Rect::new(
            0.,
            0.,
            model::INDICATOR_WIDTH,
            model::INDICATOR_HEIGHT,
        ));
    let screen_id = screen.map(|screen| screen.id);
    let opened = cx.open_window(
        WindowOptions {
            #[cfg(target_os = "linux")]
            app_id: Some(crate::app_windows::app_id().into()),
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin: point(px(frame.x as f32), px(frame.y as f32)),
                size: size(px(frame.w as f32), px(frame.h as f32)),
            })),
            titlebar: None,
            kind: WindowKind::PopUp,
            focus: false,
            show: !native::can_move_windows(),
            is_movable: !native::can_move_windows(),
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Transparent,
            ..Default::default()
        },
        move |window, cx| {
            native::window_title(window, TITLE);
            cx.new(|cx| Indicator::new(dock, screen_id, window, cx))
        },
    );
    let handle = match opened {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!("meeting indicator failed to open: {error:#}");
            return;
        }
    };
    let native_window = handle
        .update(cx, |indicator, window, cx| {
            crate::platform::apply_panel_behavior(
                window,
                crate::platform::PanelBehavior {
                    level: crate::platform::recording_controls_level(),
                    join_all_spaces: true,
                    shadow: true,
                },
            );
            indicator.panel = Panel::of(window);
            indicator.material = indicator.panel.is_some();
            cx.notify();
            crate::platform::native_window(window)
        })
        .ok()
        .flatten();
    let slot = cx.default_global::<IndicatorSlot>();
    slot.handle = Some(handle);
    slot.hidden_for_app = native::app_is_active() && !super::debug_tour();
    crate::meetings_ui::MeetingWindows::get(cx).indicator = Some(handle.into());
    watch_app(cx);
    let hidden = cx.global::<IndicatorSlot>().hidden_for_app;
    let panel = handle
        .update(cx, |indicator, _, _| indicator.panel.clone())
        .ok()
        .flatten();
    let fade = native::motion(cx, native::FADE_OUT);
    cx.spawn(async move |cx| {
        if let Some(native_window) = &native_window {
            crate::platform::remove_popup_window_chrome(native_window);
            native::install_glass(native_window, f64::from(RADIUS));
        }
        if let Some(panel) = panel {
            panel.place(frame, 0.);
            if !hidden {
                panel.show();
                panel.animate(frame, 1., fade);
            }
        }
        cx.update(|cx| {
            handle
                .update(cx, |_, window, cx| {
                    crate::platform::kick_display_link(window);
                    cx.notify();
                })
                .ok();
        });
    })
    .detach();
    tracing::info!("meeting indicator opened");
}

fn close(cx: &mut App) {
    let slot = cx.default_global::<IndicatorSlot>();
    let Some(handle) = slot.handle.take() else {
        return;
    };
    slot.observer = None;
    slot.observer_task = None;
    crate::meetings_ui::MeetingWindows::get(cx).indicator = None;
    #[cfg(debug_assertions)]
    tracing::info!(
        renders = RENDERS.load(std::sync::atomic::Ordering::Relaxed),
        "meeting indicator closed"
    );
    let panel = handle
        .update(cx, |indicator, _, _| indicator.panel.clone())
        .ok()
        .flatten();
    let fade = native::motion(cx, native::FADE_OUT);
    cx.spawn(async move |cx| {
        if let Some(panel) = &panel {
            panel.animate(panel.frame(), 0., fade);
            cx.background_executor()
                .timer(fade + Duration::from_millis(30))
                .await;
            panel.hide();
        }
        cx.update(|cx| {
            handle
                .update(cx, |_, window, _| window.remove_window())
                .ok();
        });
    })
    .detach();
}

fn watch_app(cx: &mut App) {
    if !native::can_move_windows() {
        return;
    }
    let (tx, rx) = flume::unbounded::<()>();
    let observer = native::observe(
        &[
            native::APP_ACTIVE,
            native::APP_INACTIVE,
            native::SCREENS_CHANGED,
        ],
        tx,
    );
    let task = cx.spawn(async move |cx| {
        while rx.recv_async().await.is_ok() {
            while rx.try_recv().is_ok() {}
            cx.update(app_or_screens_changed);
        }
    });
    let slot = cx.global_mut::<IndicatorSlot>();
    slot.observer = Some(observer);
    slot.observer_task = Some(task);
}

fn app_or_screens_changed(cx: &mut App) {
    let Some(handle) = cx
        .try_global::<IndicatorSlot>()
        .and_then(|slot| slot.handle)
    else {
        return;
    };
    let hide = native::app_is_active() && !super::debug_tour();
    let was_hidden = std::mem::replace(&mut cx.global_mut::<IndicatorSlot>().hidden_for_app, hide);
    let Some((panel, dock, screen, width)) = handle
        .update(cx, |indicator, _, _| {
            Some((
                indicator.panel.clone()?,
                indicator.dock,
                indicator.screen.clone(),
                indicator.width(),
            ))
        })
        .ok()
        .flatten()
    else {
        return;
    };
    let screens = native::screens(cx);
    let target = screen
        .as_ref()
        .and_then(|id| screens.iter().find(|screen| &screen.id == id))
        .or_else(|| model::screen_for_point(&screens, None))
        .map(|screen| model::indicator_frame(screen.visible, dock, width));
    let fade = native::motion(cx, native::FADE_OUT);
    cx.spawn(async move |cx| {
        if let Some(target) = target {
            panel.place(target, if was_hidden { 0. } else { 1. });
        }
        if hide && !was_hidden {
            panel.animate(panel.frame(), 0., fade);
            cx.background_executor()
                .timer(fade + Duration::from_millis(30))
                .await;
            let still_hidden = cx.update(|cx| {
                cx.try_global::<IndicatorSlot>()
                    .is_some_and(|slot| slot.hidden_for_app)
            });
            if still_hidden {
                panel.hide();
            }
        } else if !hide && was_hidden {
            panel.show();
            panel.animate(panel.frame(), 1., fade);
            cx.update(|cx| {
                handle
                    .update(cx, |_, window, cx| {
                        crate::platform::kick_display_link(window);
                        cx.notify();
                    })
                    .ok();
            });
        }
    })
    .detach();
}

pub(super) fn surface_ink(theme: &Theme) -> Hsla {
    if theme.is_dark() {
        gpui::hsla(240. / 360., 0.06, 0.1, 1.)
    } else {
        gpui::white()
    }
}
