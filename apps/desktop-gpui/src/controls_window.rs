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
    Context, Entity, InteractiveElement as _, IntoElement, MouseButton, ParentElement as _, Render,
    SharedString, StatefulInteractiveElement as _, Styled, Window, div,
    prelude::FluentBuilder as _, px, svg,
};

use crate::{
    session::{Phase, RecordingSession},
    theme::{Appearance, Theme},
};

pub struct ControlsWindow {
    session: Entity<RecordingSession>,
    theme: Theme,
    has_microphone: bool,
    /// Repaints the timer. An inactive window is repainted lazily by the
    /// platform, so the tick both notifies and asks for a frame explicitly.
    _tick: gpui::Task<()>,
}

impl ControlsWindow {
    pub fn new(
        session: Entity<RecordingSession>,
        has_microphone: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let theme = Theme::new(Appearance::from_window(window.appearance()));
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
            .size(px(32.))
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(8.))
            .when(!disabled, |this| {
                this.hover(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.06)))
                    .active(|style| style.bg(Theme::with_alpha(theme.gray_12, 0.10)))
            })
            .child(
                svg()
                    .path(icon)
                    .size(px(20.))
                    .text_color(if disabled {
                        Theme::with_alpha(theme.gray_11, 0.5)
                    } else {
                        theme.gray_11.into()
                    }),
            )
    }

    fn render_stop(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let starting = session.phase == Phase::Starting;
        let stopping = session.phase == Phase::Stopping;
        let label: SharedString = if starting {
            "Starting".into()
        } else {
            Self::format_elapsed(session.elapsed()).into()
        };

        div()
            .id("stop")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .rounded(px(8.))
            .py(px(4.))
            .px(px(8.))
            .text_color(theme.red_300)
            .when(!starting && !stopping, |this| {
                this.hover(|style| style.bg(Theme::with_alpha(theme.red_300, 0.08)))
                    .active(|style| style.bg(Theme::with_alpha(theme.red_300, 0.12)))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.session.update(cx, |session, cx| session.stop(cx));
                    }))
            })
            .when(stopping, |this| this.opacity(0.6))
            .child(
                svg()
                    .path("icons/stop-circle.svg")
                    .size(px(16.))
                    .text_color(theme.red_300),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .font_weight(gpui::FontWeight::MEDIUM)
                    .child(label),
            )
    }

    /// The mic presence indicator: icon plus the level track underneath. The
    /// track is static for now -- the live level channel comes with the
    /// app-scoped feeds.
    fn render_microphone(&self) -> impl IntoElement {
        let theme = self.theme;
        div()
            .size(px(32.))
            .relative()
            .flex()
            .items_center()
            .justify_center()
            .child(
                svg()
                    .path("icons/microphone.svg")
                    .size(px(20.))
                    .text_color(if self.has_microphone {
                        theme.gray_12.into()
                    } else {
                        // `IconLucideMicOff text-gray-7` in the bar; same
                        // glyph dimmed until a mic-off asset exists.
                        Theme::with_alpha(theme.gray_12, 0.35)
                    }),
            )
            .when(self.has_microphone, |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(px(4.))
                        .left(px(4.))
                        .right(px(4.))
                        .h(px(2.))
                        .rounded_full()
                        .bg(theme.gray_10),
                )
            })
    }

    fn render_bar(&mut self, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self.theme;
        let session = self.session.read(cx);
        let paused = session.is_paused();
        let busy = !matches!(session.phase, Phase::Recording { .. });

        div()
            .h(px(40.))
            .w_full()
            .flex()
            .flex_row()
            .items_stretch()
            .overflow_hidden()
            .rounded(px(16.))
            .bg(theme.gray_1)
            .border_1()
            .border_color(theme.gray_5)
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
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .p(px(4.))
                    .child(self.render_stop(cx))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.))
                            .child(self.render_microphone())
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
                                .when(!busy, |this| {
                                    this.on_click(cx.listener(|this, _, _, cx| {
                                        this.session
                                            .update(cx, |session, cx| session.toggle_pause(cx));
                                    }))
                                }),
                            )
                            .child(self.action_button("restart", "icons/restart.svg", busy).when(
                                !busy,
                                |this| {
                                    this.on_click(cx.listener(|this, _, _, cx| {
                                        this.session
                                            .update(cx, |session, cx| session.restart(cx));
                                    }))
                                },
                            ))
                            .child(self.action_button("delete", "icons/trash.svg", busy).when(
                                !busy,
                                |this| {
                                    this.on_click(cx.listener(|this, _, _, cx| {
                                        this.session.update(cx, |session, cx| session.delete(cx));
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
                    .flex()
                    .items_center()
                    .justify_center()
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
        let appearance = Appearance::from_window(window.appearance());
        if appearance != self.theme.appearance {
            self.theme = Theme::new(appearance);
        }

        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            .px(px(12.))
            .pb(px(12.))
            .font_family("Geist")
            .child(self.render_bar(cx))
    }
}
