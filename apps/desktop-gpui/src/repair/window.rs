use std::{
    f32::consts::{FRAC_PI_2, TAU},
    time::{Duration, Instant},
};

use gpui::{
    AnyElement, Bounds, Context, FontWeight, HighlightStyle, Hsla, InteractiveElement, IntoElement,
    ParentElement, PathBuilder, Pixels, Point, Render, Rgba, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, StyledText, Subscription, Task, Window, canvas, div, point,
    prelude::FluentBuilder, px, svg,
};

use crate::i18n::tr;
use crate::theme::LocaleFont as _;
use crate::{
    repair::{
        RepairController, RepairOperation, RepairPhase, RepairRequest, RepairSnapshot, ToolVerb,
        TraceItem, TraceState,
    },
    sign_in::{SignIn, SignInEvent, SignInOrigin, SignInOutcome},
    theme::Theme,
    ui,
};

pub const REPAIR_WIDTH: f32 = 560.;
pub const REPAIR_HEIGHT: f32 = 640.;
pub const REPAIR_MIN_WIDTH: f32 = 480.;
pub const REPAIR_MIN_HEIGHT: f32 = 520.;

pub const TRAFFIC_LIGHTS: Point<Pixels> = Point {
    x: px(14.),
    y: px(14.),
};

const HEADER_HEIGHT: f32 = 44.;
const FRAME: Duration = Duration::from_millis(33);
const ROW_ENTER: Duration = Duration::from_millis(320);
const ROW_STAGGER: Duration = Duration::from_millis(120);
const VISIBLE_THOUGHTS: usize = 3;
const FOLLOW_SLACK: f32 = 48.;

const MONO_FONT: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(target_os = "windows") {
    "Consolas"
} else {
    "monospace"
};

pub struct RepairWindow {
    theme: Theme,
    request: RepairRequest,
    controller: Option<RepairController>,
    snapshot: RepairSnapshot,
    epoch: Instant,
    appeared: Vec<Instant>,
    trace_open: Option<bool>,
    thoughts_open: bool,
    scroll: ScrollHandle,
    announced_fix: bool,
    ticking: bool,
    _updates: Option<Task<()>>,
    _ticker: Option<Task<()>>,
    _sign_in: Subscription,
}

fn copy_request(request: &RepairRequest) -> RepairRequest {
    RepairRequest {
        project_path: request.project_path.clone(),
        operation: match request.operation {
            RepairOperation::Recover => RepairOperation::Recover,
            RepairOperation::Open => RepairOperation::Open,
        },
        error_message: request.error_message.clone(),
        display_name: request.display_name.clone(),
    }
}

impl RepairWindow {
    pub fn new(controller: RepairController, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let request = copy_request(controller.request());
        let snapshot = controller.snapshot();
        let mut this = Self::build(request, snapshot, window, cx);
        this._updates = Some(Self::watch(&controller, window, cx));
        this.controller = Some(controller);
        this.ensure_ticker(window, cx);
        this
    }

    fn build(
        request: RepairRequest,
        snapshot: RepairSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let this = cx.weak_entity();
        window.on_window_should_close(cx, move |window, cx| {
            this.update(cx, |this, _| this.cancel_if_running()).ok();
            let key = window.window_handle().window_id();
            cx.defer(move |cx| crate::app_windows::repair_closed(key, cx));
            true
        });
        crate::theme::bind_window(window, cx);

        let sign_in = SignIn::global(cx);
        let sign_in_events = cx.subscribe_in(&sign_in, window, |this, _, event, window, cx| {
            if let SignInEvent::Finished {
                outcome: SignInOutcome::SignedIn,
                ..
            } = event
                && matches!(this.snapshot.phase, RepairPhase::SignInRequired)
            {
                this.restart(window, cx);
            }
        });

        let now = Instant::now();
        Self {
            theme: Theme::for_window(window, cx, false),
            appeared: vec![now; snapshot.trace.len()],
            request,
            controller: None,
            snapshot,
            epoch: now,
            trace_open: None,
            thoughts_open: false,
            scroll: ScrollHandle::new(),
            announced_fix: false,
            ticking: false,
            _updates: None,
            _ticker: None,
            _sign_in: sign_in_events,
        }
    }

    #[cfg(debug_assertions)]
    pub fn preview(
        request: RepairRequest,
        snapshot: RepairSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut this = Self::build(request, snapshot, window, cx);
        let settled = this.epoch.checked_sub(ROW_ENTER).unwrap_or(this.epoch);
        this.appeared.fill(settled);
        this.scroll.scroll_to_bottom();
        this.ensure_ticker(window, cx);
        this
    }

    fn watch(
        controller: &RepairController,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Task<()> {
        let updates = controller.updates();
        cx.spawn_in(window, async move |this, cx| {
            while updates.recv_async().await.is_ok() {
                if this
                    .update_in(cx, |this, window, cx| this.sync(window, cx))
                    .is_err()
                {
                    break;
                }
            }
        })
    }

    fn restart(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.controller.is_none() {
            return;
        }
        let controller = crate::repair::start(copy_request(&self.request), cx);
        self._updates = Some(Self::watch(&controller, window, cx));
        self.snapshot = controller.snapshot();
        self.controller = Some(controller);
        self.appeared = vec![Instant::now(); self.snapshot.trace.len()];
        self.trace_open = None;
        self.thoughts_open = false;
        self.announced_fix = false;
        self.ensure_ticker(window, cx);
        cx.notify();
    }

    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(snapshot) = self.controller.as_ref().map(RepairController::snapshot) else {
            return;
        };
        if matches!(snapshot.phase, RepairPhase::Cancelled) {
            self.close(window, cx);
            return;
        }
        let now = Instant::now();
        let mut stagger = Duration::ZERO;
        self.appeared.truncate(snapshot.trace.len());
        while self.appeared.len() < snapshot.trace.len() {
            self.appeared.push(now + stagger);
            stagger += ROW_STAGGER;
        }
        let grew = snapshot.trace.len() > self.snapshot.trace.len();
        let settled = is_live(&self.snapshot.phase) && !is_live(&snapshot.phase);
        if settled || (grew && self.near_bottom()) {
            self.scroll.scroll_to_bottom();
        }
        if let RepairPhase::Fixed { project_path, .. } = &snapshot.phase
            && !self.announced_fix
        {
            self.announced_fix = true;
            if matches!(self.request.operation, RepairOperation::Recover) {
                let original = self.request.project_path.clone();
                let repaired = project_path.clone();
                cx.defer(move |cx| crate::app_windows::recording_repaired(original, repaired, cx));
            }
        }
        self.snapshot = snapshot;
        self.ensure_ticker(window, cx);
        cx.notify();
        window.refresh();
    }

    fn near_bottom(&self) -> bool {
        let offset = -f32::from(self.scroll.offset().y);
        let max = f32::from(self.scroll.max_offset().y);
        max - offset <= FOLLOW_SLACK
    }

    fn animating(&self, now: Instant) -> bool {
        is_live(&self.snapshot.phase)
            || matches!(self.snapshot.phase, RepairPhase::Sending { .. })
            || self
                .appeared
                .last()
                .is_some_and(|appeared| now < *appeared + ROW_ENTER)
    }

    fn ensure_ticker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.ticking || !self.animating(Instant::now()) {
            return;
        }
        self.ticking = true;
        self._ticker = Some(cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor().timer(FRAME).await;
                let keep = this
                    .update_in(cx, |this, window, cx| {
                        if this.animating(Instant::now()) {
                            cx.notify();
                            window.refresh();
                            true
                        } else {
                            this.ticking = false;
                            cx.notify();
                            false
                        }
                    })
                    .unwrap_or(false);
                if !keep {
                    break;
                }
            }
        }));
    }

    fn cancel_if_running(&self) {
        let running = is_live(&self.snapshot.phase)
            || matches!(self.snapshot.phase, RepairPhase::Sending { .. });
        if running && let Some(controller) = &self.controller {
            controller.cancel();
        }
    }

    fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let key = window.window_handle().window_id();
        window.remove_window();
        cx.defer(move |cx| crate::app_windows::repair_closed(key, cx));
    }

    fn cancel(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(controller) = &self.controller {
            controller.cancel();
        }
        self.close(window, cx);
    }

    fn open_recording(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let RepairPhase::Fixed { project_path, .. } = &self.snapshot.phase else {
            return;
        };
        let path = project_path.clone();
        let recover = matches!(self.request.operation, RepairOperation::Recover);
        self.close(window, cx);
        cx.defer(move |cx| {
            if recover {
                crate::app_windows::open_recovered_recording(path, cx);
            } else {
                crate::app_windows::reload_editor(&path, cx);
            }
        });
    }

    fn start_sign_in(&mut self, cx: &mut Context<Self>) {
        SignIn::global(cx).update(cx, |sign_in, cx| sign_in.start(SignInOrigin::Settings, cx));
        cx.notify();
    }

    fn elapsed(&self, now: Instant) -> Duration {
        self.snapshot
            .finished_at
            .unwrap_or(now)
            .saturating_duration_since(self.snapshot.started_at)
    }

    fn anim_ms(&self, now: Instant) -> f32 {
        now.saturating_duration_since(self.epoch).as_secs_f32() * 1000.
    }
}

impl Render for RepairWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let theme = self.theme;
        let now = Instant::now();

        div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(Hsla::from(theme.gray_1))
            .font_family(crate::theme::UI_FONT)
            .locale_font()
            .text_color(Hsla::from(theme.gray_12))
            .child(self.render_header(window))
            .child(
                div()
                    .id("repair-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(20.))
                            .px(px(24.))
                            .pt(px(8.))
                            .pb(px(24.))
                            .child(self.render_recording(&theme))
                            .when(show_trace(&self.snapshot), |this| {
                                this.child(self.render_trace(now, cx))
                            })
                            .children(self.render_result(now, cx)),
                    ),
            )
            .child(self.render_footer(cx))
    }
}

impl RepairWindow {
    fn render_header(&self, _window: &Window) -> impl IntoElement {
        let theme = self.theme;
        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .w_full()
            .h(px(HEADER_HEIGHT))
            .flex_shrink_0()
            .when(cfg!(target_os = "macos"), |this| this.pl(px(84.)))
            .when(!cfg!(target_os = "macos"), |this| this.pl(px(24.)))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(Hsla::from(theme.gray_12))
                    .child(tr::repair::window::title()),
            );

        #[cfg(target_os = "windows")]
        let header = header
            .window_control_area(gpui::WindowControlArea::Drag)
            .child(div().flex_1())
            .child(ui::windows_caption_controls(
                theme,
                _window.is_window_active(),
                _window.is_maximized(),
                true,
                true,
            ));

        header
    }

    fn render_recording(&self, theme: &Theme) -> impl IntoElement {
        let request = &self.request;
        let operation = match request.operation {
            RepairOperation::Recover => tr::repair::window::recover_failed(),
            RepairOperation::Open => tr::repair::window::open_failed(),
        };
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(12.))
            .p(px(12.))
            .rounded(px(10.))
            .bg(Hsla::from(theme.gray_2))
            .border_1()
            .border_color(Hsla::from(theme.gray_4))
            .child(
                div()
                    .size(px(32.))
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(8.))
                    .bg(Hsla::from(theme.gray_1))
                    .border_1()
                    .border_color(Hsla::from(theme.gray_5))
                    .child(pixel_grid(theme, 0., false)),
            )
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
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .child(SharedString::from(request.display_name.clone())),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(operation),
                    ),
            )
    }

    fn render_trace(&self, now: Instant, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let live = is_live(&self.snapshot.phase);
        let has_rows = !self.snapshot.trace.is_empty();
        let open = has_rows && self.trace_open.unwrap_or(live);
        let anim = self.anim_ms(now);

        let label: AnyElement = if live {
            shimmer_text(
                live_label(&self.snapshot.phase),
                theme.gray_9,
                theme.gray_12,
                anim,
            )
            .into_any_element()
        } else {
            div()
                .text_color(Hsla::from(theme.gray_11))
                .child(tr::repair::status::worked_for(duration_label(
                    self.elapsed(now),
                )))
                .into_any_element()
        };

        let header = div()
            .id("repair-trace-toggle")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(10.))
            .w_full()
            .px(px(6.))
            .py(px(4.))
            .ml(px(-6.))
            .rounded(px(8.))
            .cursor_pointer()
            .hover(|this| this.bg(Hsla::from(theme.gray_3)))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.trace_open = Some(!open);
                cx.notify();
            }))
            .child(pixel_grid(&theme, anim, live))
            .child(
                div()
                    .text_size(px(13.))
                    .font_weight(FontWeight::MEDIUM)
                    .whitespace_nowrap()
                    .child(label),
            )
            .when(live, |this| {
                this.child(
                    div()
                        .font_family(MONO_FONT)
                        .text_size(px(12.))
                        .text_color(Hsla::from(theme.gray_9))
                        .child(timer_label(self.elapsed(now))),
                )
            })
            .child(div().flex_1())
            .when(has_rows, |this| {
                this.child(
                    svg()
                        .path("icons/chevron-down.svg")
                        .size(px(14.))
                        .flex_shrink_0()
                        .text_color(Hsla::from(theme.gray_9))
                        .when(open, |this| {
                            this.with_transformation(gpui::Transformation::rotate(gpui::radians(
                                std::f32::consts::PI,
                            )))
                        }),
                )
            });

        div().flex().flex_col().child(header).when(open, |this| {
            this.child(self.render_trace_rows(now, live, cx))
        })
    }

    fn render_trace_rows(
        &self,
        now: Instant,
        live: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        let theme = self.theme;
        let anim = self.anim_ms(now);
        let trace = &self.snapshot.trace;
        let thought_indices: Vec<usize> = trace
            .iter()
            .enumerate()
            .filter(|(_, item)| matches!(item, TraceItem::Thought { .. }))
            .map(|(index, _)| index)
            .collect();
        let hidden_thoughts = if self.thoughts_open {
            0
        } else {
            thought_indices.len().saturating_sub(VISIBLE_THOUGHTS)
        };
        let hidden: &[usize] = &thought_indices[..hidden_thoughts];

        let rows = trace.iter().enumerate().filter_map(|(index, item)| {
            if hidden.contains(&index) {
                return None;
            }
            let enter = enter_progress(self.appeared.get(index).copied(), now);
            let row = match item {
                TraceItem::Thought { text } => thought_row(&theme, text),
                TraceItem::Step {
                    title,
                    detail,
                    state,
                    ..
                } => step_row(
                    &theme,
                    title,
                    detail.as_deref(),
                    effective_state(*state, live),
                    anim,
                ),
                TraceItem::Tool {
                    verb,
                    target,
                    meta,
                    state,
                } => tool_row(
                    &theme,
                    *verb,
                    target,
                    meta.as_deref(),
                    effective_state(*state, live),
                    anim,
                ),
            };
            Some(
                div()
                    .relative()
                    .top(px(8. * (1. - enter)))
                    .opacity(enter)
                    .child(row)
                    .into_any_element(),
            )
        });

        let toggle = (thought_indices.len() > VISIBLE_THOUGHTS).then(|| {
            let label = if self.thoughts_open {
                tr::repair::status::fewer_thoughts().to_string()
            } else {
                tr::repair::status::earlier_thoughts(hidden_thoughts)
            };
            div()
                .id("repair-thoughts-toggle")
                .px(px(6.))
                .py(px(2.))
                .rounded(px(6.))
                .cursor_pointer()
                .text_size(px(11.5))
                .text_color(Hsla::from(theme.gray_10))
                .hover(|this| this.bg(Hsla::from(theme.gray_3)))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.thoughts_open = !this.thoughts_open;
                    cx.notify();
                }))
                .child(label)
        });

        div()
            .relative()
            .mt(px(4.))
            .ml(px(5.))
            .pl(px(16.))
            .child(
                div()
                    .absolute()
                    .left(px(3.))
                    .top(px(0.))
                    .bottom(px(4.))
                    .w(px(1.))
                    .bg(Hsla::from(theme.gray_4)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .py(px(4.))
                    .children(toggle)
                    .children(rows),
            )
    }

    fn render_result(&self, now: Instant, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = self.theme;
        match &self.snapshot.phase {
            RepairPhase::Fixed { summary, .. } => Some(
                result_card(&theme, CardTone::Good)
                    .child(card_heading(
                        &theme,
                        badge(&theme, CardTone::Good, "icons/check.svg"),
                        tr::repair::fixed::title(),
                    ))
                    .when(!summary.is_empty(), |this| {
                        this.child(card_body(&theme, summary.clone()))
                    })
                    .child(
                        div().flex().flex_row().child(
                            ui::Button::plain(
                                &theme,
                                "repair-open-recording",
                                ui::ButtonVariant::Primary,
                                ui::ButtonSize::Sm,
                            )
                            .label(tr::repair::fixed::open())
                            .on_click(
                                cx.listener(|this, _, window, cx| this.open_recording(window, cx)),
                            ),
                        ),
                    )
                    .into_any_element(),
            ),
            RepairPhase::CantFix { summary } => {
                Some(self.help_card(tr::repair::help::cant_fix_title(), summary, cx))
            }
            RepairPhase::Failed { message } => {
                Some(self.help_card(tr::repair::help::failed_title(), message, cx))
            }
            RepairPhase::SendFailed { message } => {
                Some(self.help_card(tr::repair::help::send_failed_title(), message, cx))
            }
            RepairPhase::Sending {
                sent_bytes,
                total_bytes,
            } => {
                let progress = if *total_bytes == 0 {
                    0.
                } else {
                    (*sent_bytes as f64 / *total_bytes as f64).clamp(0., 1.) as f32
                };
                Some(
                    result_card(&theme, CardTone::Neutral)
                        .child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .gap(px(12.))
                                .child(progress_ring(&theme, progress, self.anim_ms(now)))
                                .child(
                                    div()
                                        .flex_1()
                                        .min_w_0()
                                        .flex()
                                        .flex_col()
                                        .gap(px(2.))
                                        .child(
                                            div()
                                                .text_size(px(13.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .child(tr::repair::status::sending()),
                                        )
                                        .child(
                                            div()
                                                .font_family(MONO_FONT)
                                                .text_size(px(11.5))
                                                .text_color(Hsla::from(theme.gray_10))
                                                .child(tr::repair::sending::progress(
                                                    size_label(*sent_bytes),
                                                    size_label(*total_bytes),
                                                )),
                                        ),
                                )
                                .child(pill(
                                    &theme,
                                    CardTone::Neutral,
                                    format!("{}%", (progress * 100.).floor() as u32),
                                )),
                        )
                        .into_any_element(),
                )
            }
            RepairPhase::Sent => Some(
                result_card(&theme, CardTone::Good)
                    .child(card_heading(
                        &theme,
                        badge(&theme, CardTone::Good, "icons/check.svg"),
                        tr::repair::sent::title(),
                    ))
                    .into_any_element(),
            ),
            RepairPhase::SignInRequired => {
                let pending = SignIn::global(cx).read(cx).is_pending();
                Some(
                    result_card(&theme, CardTone::Neutral)
                        .child(card_heading(
                            &theme,
                            badge(&theme, CardTone::Neutral, "icons/user-round.svg"),
                            tr::repair::sign_in::title(),
                        ))
                        .child(card_body(&theme, tr::repair::sign_in::body().to_string()))
                        .child(
                            div().flex().flex_row().child(
                                ui::Button::plain(
                                    &theme,
                                    "repair-sign-in",
                                    ui::ButtonVariant::Primary,
                                    ui::ButtonSize::Sm,
                                )
                                .label(if pending {
                                    tr::repair::sign_in::waiting()
                                } else {
                                    tr::repair::sign_in::button()
                                })
                                .disabled(pending)
                                .on_click(cx.listener(|this, _, _, cx| this.start_sign_in(cx))),
                            ),
                        )
                        .into_any_element(),
                )
            }
            RepairPhase::Connecting
            | RepairPhase::Working
            | RepairPhase::Verifying
            | RepairPhase::Cancelled => None,
        }
    }

    fn help_card(&self, title: &'static str, message: &str, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let can_send = crate::repair::availability::send_offered(
            &self.snapshot.phase,
            crate::repair::availability::current(),
        );
        result_card(&theme, CardTone::Neutral)
            .child(card_heading(
                &theme,
                badge(&theme, CardTone::Neutral, "icons/triangle-alert.svg"),
                title,
            ))
            .when(!message.is_empty(), |this| {
                this.child(card_body(&theme, message.to_string()))
            })
            .when(can_send, |this| {
                this.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .pt(px(10.))
                        .border_t_1()
                        .border_color(Hsla::from(theme.gray_4))
                        .child(
                            div()
                                .text_size(px(12.5))
                                .text_color(Hsla::from(theme.gray_11))
                                .child(tr::repair::help::explanation()),
                        )
                        .when(self.snapshot.recording_bytes > 0, |this| {
                            this.child(
                                div()
                                    .text_size(px(11.5))
                                    .text_color(Hsla::from(theme.gray_10))
                                    .child(tr::repair::help::size_line(size_label(
                                        self.snapshot.recording_bytes,
                                    ))),
                            )
                        }),
                )
                .child(
                    div().flex().flex_row().gap(px(8.)).child(
                        ui::Button::plain(
                            &theme,
                            "repair-send",
                            ui::ButtonVariant::Primary,
                            ui::ButtonSize::Sm,
                        )
                        .icon("icons/cloud-upload.svg")
                        .label(tr::repair::help::send())
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(controller) = &this.controller {
                                controller.send_to_cap();
                            }
                            cx.notify();
                        })),
                    ),
                )
            })
            .into_any_element()
    }

    fn render_footer(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let running = is_live(&self.snapshot.phase)
            || matches!(self.snapshot.phase, RepairPhase::Sending { .. });
        div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(16.))
            .flex_shrink_0()
            .px(px(24.))
            .py(px(12.))
            .border_t_1()
            .border_color(Hsla::from(theme.gray_4))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(11.5))
                    .text_color(Hsla::from(theme.gray_9))
                    .child(tr::repair::window::privacy()),
            )
            .when(running, |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "repair-cancel",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Sm,
                    )
                    .label(tr::repair::window::cancel())
                    .on_click(cx.listener(|this, _, window, cx| this.cancel(window, cx))),
                )
            })
            .when(!running, |this| {
                this.child(
                    ui::Button::plain(
                        &theme,
                        "repair-close",
                        ui::ButtonVariant::Gray,
                        ui::ButtonSize::Sm,
                    )
                    .label(tr::repair::window::close())
                    .on_click(cx.listener(|this, _, window, cx| this.close(window, cx))),
                )
            })
    }
}

pub fn is_live(phase: &RepairPhase) -> bool {
    matches!(
        phase,
        RepairPhase::Connecting | RepairPhase::Working | RepairPhase::Verifying
    )
}

fn show_trace(snapshot: &RepairSnapshot) -> bool {
    is_live(&snapshot.phase) || !snapshot.trace.is_empty()
}

fn live_label(phase: &RepairPhase) -> &'static str {
    match phase {
        RepairPhase::Connecting => tr::repair::status::connecting(),
        RepairPhase::Verifying => tr::repair::status::verifying(),
        _ => tr::repair::status::working(),
    }
}

fn effective_state(state: TraceState, live: bool) -> TraceState {
    if state == TraceState::Running && !live {
        TraceState::Done
    } else {
        state
    }
}

fn enter_progress(appeared: Option<Instant>, now: Instant) -> f32 {
    let Some(appeared) = appeared else {
        return 1.;
    };
    if now < appeared {
        return 0.;
    }
    let t = (now.saturating_duration_since(appeared).as_secs_f32() / ROW_ENTER.as_secs_f32())
        .clamp(0., 1.);
    1. - (1. - t).powi(4)
}

fn thought_row(theme: &Theme, text: &str) -> AnyElement {
    div()
        .px(px(6.))
        .py(px(2.))
        .text_size(px(12.5))
        .line_height(px(19.))
        .text_color(Hsla::from(theme.gray_11))
        .child(SharedString::from(text.to_string()))
        .into_any_element()
}

fn step_row(
    theme: &Theme,
    title: &str,
    detail: Option<&str>,
    state: TraceState,
    anim: f32,
) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_start()
        .gap(px(8.))
        .min_h(px(28.))
        .px(px(6.))
        .py(px(5.))
        .rounded(px(6.))
        .child(
            div()
                .h(px(18.))
                .flex()
                .items_center()
                .child(state_icon(theme, state, anim)),
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
                        .text_size(px(12.5))
                        .line_height(px(18.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(Hsla::from(if state == TraceState::Failed {
                            theme.red_11
                        } else {
                            theme.gray_12
                        }))
                        .child(SharedString::from(title.to_string())),
                )
                .when_some(detail, |this, detail| {
                    this.child(
                        div()
                            .text_size(px(11.5))
                            .line_height(px(16.))
                            .text_color(Hsla::from(theme.gray_10))
                            .child(SharedString::from(detail.to_string())),
                    )
                }),
        )
        .into_any_element()
}

fn tool_row(
    theme: &Theme,
    verb: ToolVerb,
    target: &str,
    meta: Option<&str>,
    state: TraceState,
    anim: f32,
) -> AnyElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(8.))
        .min_h(px(26.))
        .px(px(6.))
        .rounded(px(6.))
        .child(state_icon(theme, state, anim))
        .child(
            div()
                .flex_shrink_0()
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(Hsla::from(if state == TraceState::Failed {
                    theme.red_11
                } else {
                    theme.gray_12
                }))
                .child(verb_label(verb)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_family(MONO_FONT)
                .text_size(px(11.5))
                .text_color(Hsla::from(theme.gray_10))
                .child(SharedString::from(target.to_string())),
        )
        .when_some(meta, |this, meta| {
            this.child(
                div()
                    .flex_shrink_0()
                    .font_family(MONO_FONT)
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.gray_9))
                    .child(SharedString::from(meta.to_string())),
            )
        })
        .into_any_element()
}

fn verb_label(verb: ToolVerb) -> &'static str {
    match verb {
        ToolVerb::Describe => tr::repair::tool::describe(),
        ToolVerb::List => tr::repair::tool::list(),
        ToolVerb::Read => tr::repair::tool::read(),
        ToolVerb::Inspect => tr::repair::tool::inspect(),
        ToolVerb::Pull => tr::repair::tool::pull(),
        ToolVerb::Edit => tr::repair::tool::edit(),
        ToolVerb::Truncate => tr::repair::tool::truncate(),
        ToolVerb::Remove => tr::repair::tool::remove(),
        ToolVerb::Replace => tr::repair::tool::replace(),
        ToolVerb::Verify => tr::repair::tool::verify(),
        ToolVerb::SourceRead => tr::repair::tool::source_read(),
        ToolVerb::Search => tr::repair::tool::search(),
        ToolVerb::Run => tr::repair::tool::run(),
        ToolVerb::Write => tr::repair::tool::write(),
    }
}

fn state_icon(theme: &Theme, state: TraceState, anim: f32) -> AnyElement {
    match state {
        TraceState::Running => spinner(theme, 12., anim).into_any_element(),
        TraceState::Done => svg()
            .path("icons/check.svg")
            .size(px(14.))
            .flex_shrink_0()
            .text_color(Hsla::from(theme.gray_9))
            .into_any_element(),
        TraceState::Failed => svg()
            .path("icons/x.svg")
            .size(px(14.))
            .flex_shrink_0()
            .text_color(Hsla::from(theme.red_9))
            .into_any_element(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CardTone {
    Good,
    Neutral,
}

fn green(theme: &Theme) -> Rgba {
    gpui::rgb(if theme.is_dark() { 0x34c46e } else { 0x17994a })
}

fn result_card(theme: &Theme, tone: CardTone) -> gpui::Div {
    let (bg, border) = match tone {
        CardTone::Good => (
            Theme::with_alpha(green(theme), if theme.is_dark() { 0.12 } else { 0.07 }),
            Theme::with_alpha(green(theme), 0.25),
        ),
        CardTone::Neutral => (Hsla::from(theme.gray_2), Hsla::from(theme.gray_4)),
    };
    div()
        .flex()
        .flex_col()
        .gap(px(12.))
        .p(px(16.))
        .rounded(px(10.))
        .bg(bg)
        .border_1()
        .border_color(border)
}

fn badge(theme: &Theme, tone: CardTone, icon: &'static str) -> impl IntoElement {
    let (bg, fg) = match tone {
        CardTone::Good => (Hsla::from(green(theme)), Hsla::from(gpui::rgb(0xffffff))),
        CardTone::Neutral => (Hsla::from(theme.gray_4), Hsla::from(theme.gray_11)),
    };
    div()
        .size(px(22.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .bg(bg)
        .child(svg().path(icon).size(px(13.)).text_color(fg))
}

fn card_heading(theme: &Theme, badge: impl IntoElement, title: &str) -> impl IntoElement {
    div()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(10.))
        .child(badge)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(14.))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(Hsla::from(theme.gray_12))
                .child(SharedString::from(title.to_string())),
        )
}

fn card_body(theme: &Theme, text: String) -> impl IntoElement {
    div()
        .text_size(px(12.5))
        .line_height(px(19.))
        .text_color(Hsla::from(theme.gray_11))
        .child(SharedString::from(text))
}

fn pill(theme: &Theme, tone: CardTone, text: String) -> impl IntoElement {
    let (bg, fg) = match tone {
        CardTone::Good => (
            Theme::with_alpha(green(theme), 0.14),
            Hsla::from(green(theme)),
        ),
        CardTone::Neutral => (Hsla::from(theme.gray_3), Hsla::from(theme.gray_11)),
    };
    div()
        .flex_shrink_0()
        .h(px(22.))
        .px(px(8.))
        .flex()
        .items_center()
        .rounded_full()
        .bg(bg)
        .font_family(MONO_FONT)
        .text_size(px(11.5))
        .text_color(fg)
        .child(text)
}

fn pixel_opacity(time_ms: f32, delay_ms: f32, cycle_ms: f32) -> f32 {
    const DIM: f32 = 0.15;
    if time_ms < delay_ms {
        return DIM;
    }
    let u = ((time_ms - delay_ms) % cycle_ms) / cycle_ms;
    let ease = |t: f32| t * t * (3. - 2. * t);
    if u < 0.18 {
        DIM + (1. - DIM) * ease(u / 0.18)
    } else if u < 0.42 {
        1.
    } else if u < 0.62 {
        1. - (1. - DIM) * ease((u - 0.42) / 0.2)
    } else {
        DIM
    }
}

fn pixel_grid(theme: &Theme, time_ms: f32, animated: bool) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .flex_shrink_0()
        .gap(px(1.5))
        .children((0..3).map(|row: i32| {
            div()
                .flex()
                .flex_row()
                .gap(px(1.5))
                .children((0..3).map(move |column: i32| {
                    let delay = (column + (row - 1).abs()) as f32 * 90.;
                    let opacity = if animated {
                        pixel_opacity(time_ms, delay, 650.)
                    } else {
                        0.35
                    };
                    div()
                        .size(px(4.))
                        .rounded(px(1.))
                        .bg(Theme::with_alpha(theme.gray_12, opacity))
                }))
        }))
}

fn mix(from: Rgba, to: Rgba, t: f32) -> Hsla {
    Hsla::from(Rgba {
        r: from.r + (to.r - from.r) * t,
        g: from.g + (to.g - from.g) * t,
        b: from.b + (to.b - from.b) * t,
        a: from.a + (to.a - from.a) * t,
    })
}

fn shimmer_text(text: &'static str, base: Rgba, highlight: Rgba, time_ms: f32) -> StyledText {
    let count = text.chars().count().max(1) as f32;
    let center = -0.5 + 2. * ((time_ms % 1400.) / 1400.);
    let highlights = text.char_indices().enumerate().map(|(index, (start, ch))| {
        let x = (index as f32 + 0.5) / count;
        let weight = (1. - (x - center).abs() / 0.3).clamp(0., 1.);
        (
            start..start + ch.len_utf8(),
            HighlightStyle {
                color: Some(mix(base, highlight, weight)),
                ..Default::default()
            },
        )
    });
    StyledText::new(text).with_highlights(highlights.collect::<Vec<_>>())
}

#[derive(Clone, Copy)]
struct ArcStroke {
    radius: f32,
    start: f32,
    sweep: f32,
    width: f32,
    color: Hsla,
    segments: usize,
}

fn stroke_arc(window: &mut Window, center: Point<Pixels>, arc: ArcStroke) {
    let ArcStroke {
        radius,
        start,
        sweep,
        width,
        color,
        segments,
    } = arc;
    let mut builder = PathBuilder::stroke(px(width));
    for step in 0..=segments {
        let angle = start + sweep * step as f32 / segments as f32;
        let at = point(
            center.x + px(radius * angle.cos()),
            center.y + px(radius * angle.sin()),
        );
        if step == 0 {
            builder.move_to(at);
        } else {
            builder.line_to(at);
        }
    }
    if let Ok(path) = builder.build() {
        window.paint_path(path, color);
    }
}

fn spinner(theme: &Theme, size: f32, time_ms: f32) -> impl IntoElement {
    let track = Hsla::from(theme.gray_5);
    let head = Hsla::from(theme.gray_11);
    let angle = (time_ms % 700.) / 700. * TAU;
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, (), window, _| {
            let ring = ArcStroke {
                radius: size / 2. - 1.,
                start: 0.,
                sweep: TAU,
                width: 1.5,
                color: track,
                segments: 32,
            };
            stroke_arc(window, bounds.center(), ring);
            stroke_arc(
                window,
                bounds.center(),
                ArcStroke {
                    start: angle,
                    sweep: TAU * 0.28,
                    color: head,
                    segments: 12,
                    ..ring
                },
            );
        },
    )
    .size(px(size))
    .flex_shrink_0()
}

fn progress_ring(theme: &Theme, progress: f32, time_ms: f32) -> impl IntoElement {
    let track = Hsla::from(theme.gray_4);
    let head = Hsla::from(theme.blue_9);
    let pending = progress <= 0.;
    let spin = (time_ms % 1100.) / 1100. * TAU;
    canvas(
        |_, _, _| (),
        move |bounds: Bounds<Pixels>, (), window, _| {
            let ring = ArcStroke {
                radius: 11.,
                start: 0.,
                sweep: TAU,
                width: 2.,
                color: track,
                segments: 48,
            };
            stroke_arc(window, bounds.center(), ring);
            let (start, sweep) = if pending {
                (spin, TAU * 0.28)
            } else {
                (-FRAC_PI_2, TAU * progress.max(0.01))
            };
            stroke_arc(
                window,
                bounds.center(),
                ArcStroke {
                    start,
                    sweep,
                    color: head,
                    ..ring
                },
            );
        },
    )
    .size(px(24.))
    .flex_shrink_0()
}

fn timer_label(elapsed: Duration) -> String {
    let total = (elapsed.as_millis() / 100) as f64 / 10.;
    if total < 60. {
        tr::repair::status::timer_seconds(format!("{total:.1}"))
    } else {
        let minutes = (total / 60.).floor() as u64;
        tr::repair::status::timer_minutes(minutes, format!("{:.1}", total % 60.))
    }
}

fn duration_label(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds < 60 {
        tr::repair::status::duration_seconds(seconds.max(1))
    } else {
        tr::repair::status::duration_minutes(seconds / 60, seconds % 60)
    }
}

pub fn size_label(bytes: u64) -> String {
    const KB: f64 = 1024.;
    const MB: f64 = KB * 1024.;
    const GB: f64 = MB * 1024.;
    let value = bytes as f64;
    if value >= GB {
        tr::repair::bytes::gigabytes(format!("{:.1}", value / GB))
    } else if value >= MB {
        tr::repair::bytes::megabytes(format!("{:.0}", value / MB))
    } else {
        tr::repair::bytes::kilobytes(format!("{:.0}", (value / KB).max(1.)))
    }
}

#[cfg(debug_assertions)]
pub fn preview_from_env(cx: &mut gpui::App) {
    let Ok(kind) = std::env::var("CAP_GPUI_REPAIR_PREVIEW") else {
        return;
    };
    crate::repair::availability::pin_for_preview(crate::repair::availability::RepairConfig {
        enabled: true,
        submissions: !kind.contains("no-send"),
    });
    let operation = if kind.ends_with("-open") {
        RepairOperation::Open
    } else {
        RepairOperation::Recover
    };
    let request = RepairRequest {
        project_path: std::env::temp_dir().join("cap-repair-preview.cap"),
        operation,
        error_message: "Recovery validation failed; original recording preserved: Invalid declared complete fragment".into(),
        display_name: "Quarterly product walkthrough".into(),
    };
    let snapshot = preview_snapshot(kind.trim_end_matches("-open"));
    crate::app_windows::open_repair_preview(request, snapshot, cx);
}

#[cfg(debug_assertions)]
fn preview_snapshot(kind: &str) -> RepairSnapshot {
    let ago = |seconds: u64| {
        Instant::now()
            .checked_sub(Duration::from_secs(seconds))
            .unwrap_or_else(Instant::now)
    };
    let tool = |verb, target: &str, meta: Option<&str>, state| TraceItem::Tool {
        verb,
        target: target.into(),
        meta: meta.map(Into::into),
        state,
    };
    let step = |id: &str, title: &str, detail: Option<&str>, state| TraceItem::Step {
        id: id.into(),
        title: title.into(),
        detail: detail.map(Into::into),
        state,
    };
    let thought = |text: &str| TraceItem::Thought { text: text.into() };
    let mut trace = vec![
        step(
            "look",
            "Reading the recording layout",
            None,
            TraceState::Done,
        ),
        tool(ToolVerb::Describe, "recording", None, TraceState::Done),
        tool(
            ToolVerb::List,
            "content/segments",
            Some("214 files"),
            TraceState::Done,
        ),
        thought(
            "Segment 2 has a display manifest that declares 151 complete fragments, but the recovery error points at the last one.",
        ),
        tool(
            ToolVerb::Read,
            "content/segments/segment-2/display/manifest.json",
            Some("18 KB"),
            TraceState::Done,
        ),
        tool(
            ToolVerb::Inspect,
            "content/segments/segment-2/display/segment_150.m4s",
            Some("all zero"),
            TraceState::Done,
        ),
        tool(
            ToolVerb::SourceRead,
            "crates/recording/src/recovery.rs",
            None,
            TraceState::Done,
        ),
        thought(
            "The last fragment is the right size but contains only zeros, which is what a power cut leaves behind. Marking it incomplete lets recovery skip it.",
        ),
        step(
            "fix",
            "Marking the torn fragment incomplete",
            Some("segment 2, display track"),
            TraceState::Done,
        ),
        tool(
            ToolVerb::Edit,
            "content/segments/segment-2/display/manifest.json",
            Some("1 change"),
            TraceState::Done,
        ),
    ];
    let phase = match kind {
        "connecting" => {
            trace.clear();
            RepairPhase::Connecting
        }
        "verifying" => {
            trace.push(step("test", "Testing the fix", None, TraceState::Running));
            trace.push(tool(ToolVerb::Verify, "recording", Some("attempt 1"), TraceState::Running));
            RepairPhase::Verifying
        }
        "fixed" => {
            trace.push(tool(ToolVerb::Verify, "recording", Some("attempt 1"), TraceState::Done));
            RepairPhase::Fixed {
                project_path: std::env::temp_dir().join("cap-repair-preview.cap"),
                summary: "Your laptop shut down mid-recording, which left the last 2 seconds of the screen track empty. Cap set that piece aside and recovered the other 41 minutes 12 seconds.".into(),
            }
        }
        "cantfix" => {
            trace.push(tool(ToolVerb::Verify, "recording", Some("attempt 3"), TraceState::Failed));
            RepairPhase::CantFix {
                summary: "The camera track's header was overwritten, so none of its frames can be decoded on this computer. The screen and audio are intact.".into(),
            }
        }
        "sending" => {
            trace.push(tool(ToolVerb::Verify, "recording", Some("attempt 3"), TraceState::Failed));
            RepairPhase::Sending {
                sent_bytes: 642 * 1024 * 1024,
                total_bytes: 1_610_612_736,
            }
        }
        "sent" => RepairPhase::Sent,
        "failed" => RepairPhase::Failed {
            message: "Cap couldn't reach the repair service. Check your connection and try again, or send the recording to us.".into(),
        },
        "signin" => {
            trace.clear();
            RepairPhase::SignInRequired
        }
        _ => {
            trace.push(tool(ToolVerb::Inspect, "content/segments/segment-2/camera/segment_150.m4s", None, TraceState::Running));
            RepairPhase::Working
        }
    };
    let live = is_live(&phase) || matches!(phase, RepairPhase::Sending { .. });
    RepairSnapshot {
        phase,
        trace,
        started_at: ago(74),
        finished_at: (!live).then(|| ago(2)),
        recording_bytes: 1_610_612_736,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_wave_is_dim_before_delay_and_lit_mid_cycle() {
        assert_eq!(pixel_opacity(10., 90., 650.), 0.15);
        assert_eq!(pixel_opacity(90. + 0.3 * 650., 90., 650.), 1.);
        assert!((pixel_opacity(90. + 0.8 * 650., 90., 650.) - 0.15).abs() < 1e-6);
    }

    #[test]
    fn enter_progress_is_staggered_and_eases_out() {
        let now = Instant::now();
        assert_eq!(enter_progress(Some(now + ROW_STAGGER), now), 0.);
        assert_eq!(enter_progress(now.checked_sub(ROW_ENTER), now), 1.);
        let half = enter_progress(now.checked_sub(ROW_ENTER / 2), now);
        assert!(half > 0.9 && half < 1.);
    }

    #[test]
    fn running_rows_settle_once_the_session_ends() {
        assert!(effective_state(TraceState::Running, true) == TraceState::Running);
        assert!(effective_state(TraceState::Running, false) == TraceState::Done);
        assert!(effective_state(TraceState::Failed, false) == TraceState::Failed);
    }
}
