use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton,
    ParentElement, SharedString, StatefulInteractiveElement, Styled, Window, div,
    prelude::FluentBuilder, px, relative, svg,
};

use crate::{
    clean_up::{
        CleanUpSummary, SilenceParameter, SilencePreset, SilenceSettings, TimelineSilence,
        cut_silences, format_duration,
    },
    editor_sidebar::{SliderKey, collapsible, disclosure_row, section_action},
    editor_timeline::TrackKind,
    editor_window::EditorWindow,
    theme::Theme,
    ui,
};

const SILENCE_RED: u32 = 0xef4444;

impl EditorWindow {
    pub(crate) fn render_clean_up_tab(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let state = &self.clean_up;
        let summary = state.summary(self.total_duration());
        let current_preset = state.settings.preset();
        let open = state.advanced_open.is_open();
        let ready = self.project_ready() && state.has_audio();

        let status = if !state.loaded() {
            self.render_clean_up_notice("Analyzing audio…")
        } else if !state.has_audio() {
            self.render_clean_up_notice("This recording has no audio to analyze.")
        } else {
            self.render_clean_up_summary(summary)
        };

        let count_line = match (summary.count, summary.kept) {
            (0, 0) => "No silences match these settings".to_string(),
            (count, 0) => format!("{count} {} to cut", plural(count, "silence", "silences")),
            (count, kept) => format!(
                "{count} {} to cut · {kept} kept",
                plural(count, "silence", "silences")
            ),
        };

        let presets = ui::SegmentedControl::editor(
            &theme,
            "clean-up-presets",
            SilencePreset::ALL
                .iter()
                .map(|preset| {
                    ui::SegmentOption::new(preset.label(), current_preset == Some(*preset))
                })
                .collect(),
        )
        .stretch()
        .on_select(cx.listener(|this, index: &usize, window, cx| {
            if let Some(preset) = SilencePreset::ALL.get(*index) {
                this.apply_clean_up_settings(preset.settings(), window, cx);
            }
        }));

        let advanced = div()
            .flex()
            .flex_col()
            .gap(px(14.))
            .pt(px(6.))
            .children(
                SilenceParameter::ALL
                    .into_iter()
                    .map(|parameter| self.render_clean_up_parameter(parameter, cx)),
            )
            .into_any_element();

        let cut_label = match summary.count {
            0 => "No silences to cut".to_string(),
            count => format!("Cut {count} {}", plural(count, "silence", "silences")),
        };

        let actions = div()
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                ui::Button::plain(
                    &theme,
                    "clean-up-cut",
                    ui::ButtonVariant::Primary,
                    ui::ButtonSize::Md,
                )
                .icon("icons/scissors.svg")
                .label(cut_label)
                .full_width()
                .disabled(!ready || summary.count == 0)
                .on_click(cx.listener(|this, _, window, cx| {
                    this.cut_all_silences(window, cx);
                })),
            )
            .child(
                ui::Button::plain(
                    &theme,
                    "clean-up-review",
                    ui::ButtonVariant::Gray,
                    ui::ButtonSize::Md,
                )
                .label(if state.reviewing {
                    "Stop reviewing"
                } else {
                    "Review silences"
                })
                .full_width()
                .disabled(!ready || state.silences.is_empty())
                .on_click(cx.listener(|this, _, window, cx| {
                    if this.clean_up.reviewing {
                        this.stop_silence_review(window, cx);
                    } else {
                        this.start_silence_review(window, cx);
                    }
                })),
            );

        ui::Field::section(&theme, "Silence")
            .icon("icons/scissors.svg")
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(status)
                    .when(ready, |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_row()
                                .items_center()
                                .justify_between()
                                .gap(px(8.))
                                .child(
                                    div()
                                        .text_size(px(12.))
                                        .text_color(Hsla::from(theme.editor.text_2))
                                        .child(count_line),
                                )
                                .when(summary.kept > 0, |this| {
                                    this.child(section_action(
                                        &theme,
                                        "clean-up-restore-kept",
                                        "Cut kept too",
                                        None,
                                        false,
                                        cx.listener(|this, _, window, cx| {
                                            this.clean_up.kept.clear();
                                            this.refresh_clean_up(window, cx);
                                        }),
                                    ))
                                }),
                        )
                    })
                    .child(presets)
                    .child(disclosure_row(
                        &theme,
                        "clean-up-advanced",
                        "Advanced",
                        open,
                        cx.listener(|this, _, window, cx| {
                            this.clean_up.advanced_open.toggle();
                            this.animate_collapsibles(window, cx);
                        }),
                    ))
                    .child(collapsible(&self.clean_up.advanced_open, advanced))
                    .child(actions)
                    .children(self.clean_up.message.as_ref().map(|message| {
                        div()
                            .text_size(px(12.))
                            .text_color(Hsla::from(theme.editor.text_2))
                            .child(message.clone())
                    }))
                    .child(
                        div()
                            .text_size(px(11.5))
                            .line_height(px(16.))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(
                                "Silences are cut from the timeline in one step, so undo brings \
                                 them back. Captions and exports follow the edited timeline.",
                            ),
                    ),
            )
            .into_any_element()
    }

    fn render_clean_up_notice(&self, message: &'static str) -> AnyElement {
        let theme = self.theme;
        div()
            .p(px(14.))
            .rounded(px(10.))
            .bg(Hsla::from(theme.editor.card_2))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .text_size(px(12.))
            .text_color(Hsla::from(theme.editor.text_2))
            .child(message)
            .into_any_element()
    }

    fn render_clean_up_summary(&self, summary: CleanUpSummary) -> AnyElement {
        let theme = self.theme;
        let (saved, before, after, fraction) = (
            summary.saved,
            summary.before,
            summary.after(),
            summary.fraction(),
        );
        let muted = Hsla::from(theme.editor.text_3);
        div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .p(px(14.))
            .rounded(px(10.))
            .bg(Hsla::from(theme.editor.card_2))
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_end()
                    .gap(px(8.))
                    .child(
                        div()
                            .pb(px(3.))
                            .text_size(px(10.5))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(muted)
                            .child("SAVED"),
                    )
                    .child(
                        div()
                            .text_size(px(20.))
                            .line_height(px(24.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(format_duration(saved)),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .pb(px(2.))
                            .text_size(px(14.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(Hsla::from(theme.editor.accent))
                            .child(format!("{}%", (fraction * 100.).round() as i32)),
                    ),
            )
            .child(
                div()
                    .w_full()
                    .h(px(6.))
                    .rounded_full()
                    .overflow_hidden()
                    .bg(Hsla::from(theme.editor.ctl_active))
                    .child(
                        div()
                            .h_full()
                            .rounded_full()
                            .bg(Hsla::from(theme.editor.accent))
                            .w(relative(fraction as f32)),
                    ),
            )
            .child(
                div()
                    .flex()
                    .flex_row()
                    .justify_between()
                    .gap(px(8.))
                    .text_size(px(11.5))
                    .text_color(muted)
                    .child(format!("From {}", format_duration(before)))
                    .child(format!(
                        "→ {} ({} cut)",
                        format_duration(after),
                        format_duration(saved)
                    )),
            )
            .into_any_element()
    }

    fn render_clean_up_parameter(
        &self,
        parameter: SilenceParameter,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let value = parameter.read(&self.clean_up.settings);
        let (min, max, _) = parameter.limits();
        let description = parameter.description();

        let step_button = |direction: f32, icon: &'static str, enabled: bool| {
            div()
                .id(SharedString::from(format!(
                    "clean-up-step-{parameter:?}-{direction}"
                )))
                .size(px(24.))
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .border_1()
                .border_color(Hsla::from(theme.editor.line))
                .bg(Hsla::from(theme.editor.ctl))
                .child(
                    svg()
                        .path(icon)
                        .size(px(12.))
                        .text_color(Hsla::from(theme.editor.text_2)),
                )
                .when(!enabled, |this| this.opacity(0.4))
                .when(enabled, |this| {
                    this.cursor_pointer()
                        .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.step_clean_up_parameter(parameter, direction, window, cx);
                        }))
                })
        };

        let stepper = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.))
            .child(step_button(-1., "icons/minus.svg", value > min))
            .child(
                div()
                    .min_w(px(64.))
                    .h(px(24.))
                    .px(px(8.))
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_center()
                    .gap(px(4.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(Hsla::from(theme.editor.line))
                    .bg(Hsla::from(theme.editor.ctl))
                    .text_size(px(11.5))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(theme.editor.accent))
                    .child(parameter.value_label(value))
                    .children(parameter.unit().map(|unit| {
                        div()
                            .text_size(px(9.5))
                            .text_color(Hsla::from(theme.editor.text_3))
                            .child(unit)
                    })),
            )
            .child(step_button(1., "icons/plus.svg", value < max));

        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.editor.text_1))
                            .child(parameter.label()),
                    )
                    .child(
                        div()
                            .id(SharedString::from(format!("clean-up-info-{parameter:?}")))
                            .flex()
                            .items_center()
                            .child(
                                svg()
                                    .path("icons/info.svg")
                                    .size(px(12.))
                                    .text_color(Hsla::from(theme.editor.text_3)),
                            )
                            .tooltip(move |_window, cx| {
                                ui::Tooltip::new(&theme, description).view(cx)
                            }),
                    )
                    .child(div().flex_1())
                    .child(stepper),
            )
            .child(self.slider(SliderKey::CleanUp(parameter), "int", cx))
            .into_any_element()
    }

    pub(crate) fn render_silence_review_pill(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.clean_up.reviewing || !self.project_ready() {
            return None;
        }
        let theme = self.theme;
        let state = &self.clean_up;
        let focused = state.focused_silence().copied();
        let position = state.focused_position();
        let total = state.silences.len();
        let kept = focused.is_some_and(|silence| state.is_kept(&silence));
        let red = Hsla::from(gpui::rgb(SILENCE_RED));
        let idle = Hsla::from(theme.editor.text_2);
        let separator = || div().w(px(1.)).h(px(16.)).bg(Hsla::from(theme.editor.line));

        let detail = match focused {
            Some(silence) => format!("{:.3}s · {:.2}s", silence.start, silence.duration()),
            None => format!("{total} {}", plural(total, "silence", "silences")),
        };

        let pill = div()
            .id("silence-review-pill")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(8.))
            .h(px(32.))
            .pl(px(12.))
            .pr(px(6.))
            .rounded_full()
            .border_1()
            .border_color(Hsla::from(theme.editor.line))
            .bg(Hsla::from(theme.editor.card))
            .shadow(theme.editor.pop_shadow())
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|_, _, _, cx| cx.stop_propagation()),
            )
            .child(div().size(px(7.)).rounded_full().bg(red))
            .child(
                div()
                    .text_size(px(12.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(Hsla::from(theme.editor.text_1))
                    .child("Silence"),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .child(detail),
            )
            .children(position.map(|position| {
                div()
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.editor.text_3))
                    .child(format!("{}/{total}", position + 1))
            }))
            .child(
                pill_button(
                    &theme,
                    "silence-previous",
                    "icons/chevron-left.svg",
                    idle,
                    "Previous silence",
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.step_silence(false, window, cx);
                })),
            )
            .child(
                pill_button(
                    &theme,
                    "silence-next",
                    "icons/chevron-right.svg",
                    idle,
                    "Next silence",
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.step_silence(true, window, cx);
                })),
            )
            .child(separator())
            .when_some(focused, |this, silence| {
                this.child(
                    pill_button(
                        &theme,
                        "silence-keep",
                        "icons/audio-on.svg",
                        if kept {
                            Hsla::from(theme.editor.accent)
                        } else {
                            idle
                        },
                        if kept {
                            "Kept. Click to cut it with the rest"
                        } else {
                            "Keep this silence"
                        },
                    )
                    .when(kept, |this| this.bg(Hsla::from(theme.editor.ctl_active)))
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.clean_up.toggle_kept(silence.key);
                        this.refresh_clean_up(window, cx);
                    })),
                )
                .child(
                    pill_button(
                        &theme,
                        "silence-cut",
                        "icons/scissors.svg",
                        red,
                        "Cut this silence",
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.cut_focused_silence(window, cx);
                    })),
                )
                .child(separator())
            })
            .child(
                div()
                    .id("silence-review-close")
                    .h(px(22.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(Hsla::from(theme.editor.line))
                    .text_size(px(11.))
                    .text_color(Hsla::from(theme.editor.text_2))
                    .cursor_pointer()
                    .hover(|this| this.bg(Hsla::from(theme.editor.ctl_hover)))
                    .child("Esc")
                    .tooltip(move |_window, cx| ui::Tooltip::new(&theme, "Stop reviewing").view(cx))
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.stop_silence_review(window, cx);
                    })),
            );

        Some(
            div()
                .absolute()
                .top(px(4.))
                .left_0()
                .right_0()
                .flex()
                .flex_row()
                .justify_center()
                .child(pill)
                .into_any_element(),
        )
    }

    pub(crate) fn set_clean_up_parameter(
        &mut self,
        parameter: SilenceParameter,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut settings = self.clean_up.settings;
        parameter.write(&mut settings, value);
        self.apply_clean_up_settings(settings, window, cx);
    }

    fn step_clean_up_parameter(
        &mut self,
        parameter: SilenceParameter,
        direction: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (_, _, step) = parameter.limits();
        let value = parameter.read(&self.clean_up.settings) + direction * step;
        self.set_clean_up_parameter(parameter, value, window, cx);
    }

    fn apply_clean_up_settings(
        &mut self,
        settings: SilenceSettings,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.clean_up.set_settings(settings) {
            self.refresh_clean_up(window, cx);
        }
    }

    fn refresh_clean_up(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_silence_marks();
        cx.notify();
        window.refresh();
    }

    fn cut_all_silences(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let pending: Vec<TimelineSilence> = self.clean_up.pending().copied().collect();
        self.apply_silence_cuts(&pending, window, cx);
    }

    fn cut_focused_silence(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(focused) = self.clean_up.focused_silence().copied() else {
            return;
        };
        let targets: Vec<TimelineSilence> = self
            .clean_up
            .silences
            .iter()
            .filter(|silence| silence.key == focused.key)
            .copied()
            .collect();
        self.clean_up.kept.remove(&focused.key);
        if self.apply_silence_cuts(&targets, window, cx) > 0
            && let Some(next) = self.clean_up.focus_at_or_after(focused.start)
        {
            self.focus_silence(next, window, cx);
        }
    }

    fn apply_silence_cuts(
        &mut self,
        silences: &[TimelineSilence],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> usize {
        if silences.is_empty() {
            return 0;
        }
        let saved: f64 = silences.iter().map(TimelineSilence::duration).sum();
        let mut cut = 0;
        self.edit(
            |timeline| {
                cut = cut_silences(timeline, silences);
                cut > 0
            },
            window,
            cx,
        );
        if cut == 0 {
            self.clean_up.message = Some("Nothing could be cut here.".to_string());
        } else {
            self.note_edit("clean-up-cut", Some(TrackKind::Clip));
            tracing::info!(cut, saved = format!("{saved:.3}"), "clean up cut silences");
            self.clean_up.message = Some(format!(
                "Cut {cut} {}, saved {}. Undo brings them back.",
                plural(cut, "silence", "silences"),
                format_duration(saved)
            ));
        }
        self.refresh_clean_up(window, cx);
        cut
    }

    fn start_silence_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clean_up.reviewing = true;
        match self.clean_up.focus_at_or_after(self.playhead_time()) {
            Some(silence) => self.focus_silence(silence, window, cx),
            None => {
                self.clean_up.reviewing = false;
                self.refresh_clean_up(window, cx);
            }
        }
    }

    pub(crate) fn stop_silence_review(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.clean_up.reviewing = false;
        self.clean_up.focused = None;
        self.refresh_clean_up(window, cx);
    }

    fn step_silence(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(silence) = self.clean_up.step_focus(forward) {
            self.focus_silence(silence, window, cx);
        }
    }

    fn focus_silence(
        &mut self,
        silence: TimelineSilence,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.reveal_time_range(silence.start, silence.end);
        self.seek_to_time(silence.start, cx);
        self.refresh_clean_up(window, cx);
    }
}

fn pill_button(
    theme: &Theme,
    id: &'static str,
    icon: &'static str,
    color: Hsla,
    tooltip: &'static str,
) -> gpui::Stateful<gpui::Div> {
    let theme = *theme;
    div()
        .id(id)
        .size(px(24.))
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(px(6.))
        .cursor_pointer()
        .hover(move |this| this.bg(Hsla::from(theme.editor.ctl_hover)))
        .child(svg().path(icon).size(px(14.)).text_color(color))
        .tooltip(move |_window, cx| ui::Tooltip::new(&theme, tooltip).view(cx))
}

fn plural(count: usize, one: &'static str, many: &'static str) -> &'static str {
    if count == 1 { one } else { many }
}
