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
    Context, Entity, FontWeight, InteractiveElement as _, IntoElement, MouseButton,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px, svg,
};

use crate::{
    feeds::{self, Feeds},
    recording::RecordingMode,
    session::{Phase, RecordingSession},
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
        cx.observe(&session, |_, _, cx| cx.notify()).detach();

        // 4 ticks a second keeps the seconds display honest without burning a
        // frame budget; `refresh` (not just `notify`) because this window is
        // usually not the active one while a recording runs.
        let tick = cx.spawn_in(window, async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(250))
                    .await;
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
        });

        Self {
            session,
            theme,
            has_microphone,
            #[cfg(target_os = "linux")]
            confirmation_pending: false,
            _tick: tick,
        }
    }

    /// `formatTime`: `M:SS`, hours folded into minutes the same way.
    fn format_elapsed(elapsed: Duration) -> String {
        let total = elapsed.as_secs();
        format!("{}:{:02}", total / 60, total % 60)
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
            .rounded(crate::theme::radius(crate::theme::RadiusToken::Default))
            .when(!disabled, |this| {
                this.hover(|style| style.bg(theme.hover_bg))
            })
            .child(svg().path(icon).size(px(20.)).text_color(if disabled {
                theme.text_muted
            } else {
                theme.icon
            }))
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
            "Starting".into()
        } else if stopping {
            "Saving…".into()
        } else if session.pause_pending() {
            if session.is_paused() {
                "Resuming…"
            } else {
                "Pausing…"
            }
            .into()
        } else if session.is_paused() {
            "Paused".into()
        } else if session.error.is_some() {
            "Error".into()
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
            .rounded(crate::theme::radius(crate::theme::RadiusToken::Default))
            .py(px(4.))
            .px(px(6.))
            .text_color(theme.danger)
            .when(can_stop, |this| {
                this.hover(|style| style.bg(theme.hover_bg))
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
                    .text_color(theme.danger),
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
        let level = feeds::bar_level(Feeds::global(cx).read(cx).mic_level_db);

        let icon = if !self.has_microphone || muted {
            "icons/mic-off.svg"
        } else {
            "icons/microphone.svg"
        };
        let icon_color: gpui::Hsla = if muted {
            theme.danger.into()
        } else if self.has_microphone {
            theme.text_primary.into()
        } else {
            theme.text_muted.into()
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
                this.rounded(crate::theme::radius(crate::theme::RadiusToken::Default))
                    .hover(|style| style.bg(theme.hover_bg))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session
                            .update(cx, |session, cx| session.toggle_mic_mute(cx));
                    }))
            })
            .child(svg().path(icon).size(px(20.)).text_color(icon_color))
            .when(self.has_microphone && !muted, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(4.))
                        .left(px(4.))
                        .right(px(4.))
                        .h(px(2.))
                        .rounded(crate::theme::radius(crate::theme::RadiusToken::Large))
                        .overflow_hidden()
                        .bg(theme.text_secondary)
                        .child(
                            div()
                                .absolute()
                                .left_0()
                                .top_0()
                                .bottom_0()
                                .w(gpui::relative(level as f32))
                                .bg(theme.primary),
                        ),
                )
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
                "Confirm Restart",
                "Are you sure you want to restart the recording? The current recording will be discarded.",
                "Restart",
            ),
            DestructiveAction::Delete => (
                "Confirm Delete",
                "Are you sure you want to delete the recording?",
                "Delete",
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
            let response =
                crate::editor_modal::confirm_action(title, message, accept, "Cancel", window, cx);
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
            if !crate::platform::confirm_dialog(title, message, accept, "Cancel", true) {
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

    fn render_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let paused = session.is_paused();
        let busy = !matches!(session.phase, Phase::Recording { .. }) || session.pause_unavailable();
        let pause_pending = session.pause_pending();
        let pause_tooltip = if session.pause_uncertain() {
            "Capture state is unconfirmed. Use Stop."
        } else if pause_pending {
            if paused {
                "Resuming recording…"
            } else {
                "Pausing recording…"
            }
        } else if paused {
            "Resume recording"
        } else {
            "Pause recording"
        };

        div()
            .h(px(40.))
            .flex_shrink_0()
            .w_full()
            .flex()
            .flex_row()
            .items_stretch()
            .overflow_hidden()
            .rounded(crate::theme::radius(crate::theme::RadiusToken::Medium))
            .bg(theme.surface)
            .border_1()
            .border_color(theme.border_strong)
            .when(paused, |this| this.border_color(theme.warning))
            .shadow(crate::theme::shadow(crate::theme::ShadowToken::Two))
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
                                    this.bg(theme.warning_subtle)
                                        .border_1()
                                        .border_color(theme.warning)
                                })
                                .when(pause_pending, |this| this.opacity(0.5))
                                .tooltip_show_delay(ui::TOOLTIP_SHOW_DELAY)
                                .tooltip(move |_, cx| {
                                    ui::Tooltip::new(&theme, pause_tooltip).view(cx)
                                })
                                .when(!busy, |this| {
                                    this.on_click(cx.listener(|this, _, _, cx| {
                                        this.session
                                            .update(cx, |session, cx| session.toggle_pause(cx));
                                    }))
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
                            // TODO: the recording settings popover menu.
                            .child(self.action_button("settings", "icons/settings.svg", true)),
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
                    .rounded_r(crate::theme::radius(crate::theme::RadiusToken::Medium))
                    .border_l_1()
                    .border_color(theme.border)
                    .p(px(4.))
                    .hover(|style| style.bg(theme.hover_bg))
                    .on_mouse_down(MouseButton::Left, |_, window, _| {
                        window.start_window_move();
                    })
                    .child(
                        svg()
                            .path("icons/more-vertical.svg")
                            .size(px(16.))
                            .text_color(theme.text_secondary),
                    ),
            )
    }
}

impl Render for ControlsWindow {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.theme.refresh(window, cx, false);
        let session = self.session.read(cx);
        let issue = session.error.clone().or_else(|| {
            session
                .storage_warning
                .then(|| "Low storage. Cap will stop soon to save your recording.".to_owned())
        });

        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            .p(px(12.))
            .font_family(crate::theme::ui_font())
            // `body { font-weight: 500 }` (`ui-solid/src/main.css:189-192`).
            .font_weight(FontWeight::MEDIUM)
            .when_some(issue, |this, issue| {
                this.child(
                    div()
                        .min_h_0()
                        .w_full()
                        .flex()
                        .items_start()
                        .gap(px(8.))
                        .mb(px(8.))
                        .rounded(crate::theme::radius(crate::theme::RadiusToken::Medium))
                        .border_1()
                        .border_color(Theme::with_alpha(self.theme.danger, 0.4))
                        .bg(self.theme.surface)
                        .p(px(8.))
                        .text_size(px(12.))
                        .text_color(self.theme.text_danger)
                        .child(
                            svg()
                                .path("icons/triangle-alert.svg")
                                .size(px(20.))
                                .flex_shrink_0()
                                .text_color(self.theme.danger),
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
        .child(if error.contains("Insufficient disk space")
            && error.contains("Your recording is still paused")
        {
            "Not enough disk space to resume. Free up space and try again, or press Stop to save."
                .to_owned()
        } else {
            error
        })
}
