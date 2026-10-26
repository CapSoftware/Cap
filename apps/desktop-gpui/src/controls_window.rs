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
    feeds::Feeds,
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
    ticking_live: bool,
    level_bar: Entity<ui::MicrophoneLevel>,
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
            let live = this.timer_is_live(cx);
            if live != this.ticking_live {
                this.ticking_live = live;
                this._tick = Self::spawn_tick(window, cx);
            }
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
        };
        this.ticking_live = this.timer_is_live(cx);
        this._tick = Self::spawn_tick(window, cx);
        this
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
        self.level_bar.update(cx, |bar, cx| {
            bar.configure(
                self.has_microphone && !muted,
                theme.blue_9.into(),
                theme.gray_10.into(),
                cx,
            );
        });

        let icon = if !self.has_microphone || muted {
            "icons/mic-off.svg"
        } else {
            "icons/microphone.svg"
        };
        let icon_color: gpui::Hsla = if muted {
            theme.red_9.into()
        } else if self.has_microphone {
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
            .when(self.has_microphone && !muted, |this| {
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

    fn render_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
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
        let session = self.session.read(cx);
        let issue = session.error.clone().or_else(|| {
            session
                .storage_warning
                .then(|| tr::controls::low_storage().to_owned())
        });

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
                error
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
