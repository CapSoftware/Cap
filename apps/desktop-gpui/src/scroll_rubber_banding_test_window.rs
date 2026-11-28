use gpui::{
    App, Bounds, Context, FontWeight, Hsla, IntoElement, OverscrollBehavior, ParentElement, Render,
    RubberBandConfig, ScrollHandle, Styled, TitlebarOptions, Window, WindowBounds, WindowOptions,
    div, point, prelude::*, px, rgb, size,
};

use crate::{theme::Theme, ui};

#[derive(Clone, Copy, PartialEq, Eq)]
enum ScrollAxis {
    Vertical,
    Horizontal,
}

const BEHAVIORS: [(OverscrollBehavior, &str, &str); 4] = [
    (
        OverscrollBehavior::Auto,
        "Auto",
        "Inner bounces during an owned gesture; a new gesture at the edge chains to outer.",
    ),
    (
        OverscrollBehavior::Contain,
        "Contain",
        "Inner bounces at its edges and never chains scroll to outer.",
    ),
    (
        OverscrollBehavior::Chain,
        "Chain",
        "Excess scroll chains immediately to outer once inner hits an edge.",
    ),
    (
        OverscrollBehavior::None,
        "None",
        "Disables both rubber-band bounce and scroll chaining to outer.",
    ),
];

struct TuningSpec {
    label: &'static str,
    unit: &'static str,
    min: f32,
    max: f32,
    step: f32,
    get: fn(&RubberBandConfig) -> f32,
    set: fn(&mut RubberBandConfig, f32),
}

const TUNING_SPECS: [TuningSpec; 5] = [
    TuningSpec {
        label: "Resistance",
        unit: "",
        min: 0.02,
        max: 0.50,
        step: 0.02,
        get: |c| c.resistance,
        set: |c, v| c.resistance = v,
    },
    TuningSpec {
        label: "Spring response",
        unit: "s",
        min: 0.15,
        max: 1.00,
        step: 0.025,
        get: |c| c.response,
        set: |c, v| c.response = v,
    },
    TuningSpec {
        label: "Momentum carry",
        unit: "",
        min: 0.0,
        max: 0.80,
        step: 0.05,
        get: |c| c.momentum_carry,
        set: |c, v| c.momentum_carry = v,
    },
    TuningSpec {
        label: "Max overscroll",
        unit: "×",
        min: 0.10,
        max: 0.80,
        step: 0.05,
        get: |c| c.max_overscroll_ratio,
        set: |c, v| c.max_overscroll_ratio = v,
    },
    TuningSpec {
        label: "Settle epsilon",
        unit: "px",
        min: 0.05,
        max: 1.00,
        step: 0.05,
        get: |c| c.settle_epsilon,
        set: |c, v| c.settle_epsilon = v,
    },
];

struct ScrollRubberBandingTestView {
    behavior: OverscrollBehavior,
    axis: ScrollAxis,
    config: RubberBandConfig,
    outer_scroll: ScrollHandle,
    inner_scroll: ScrollHandle,
}

impl ScrollRubberBandingTestView {
    fn new() -> Self {
        Self {
            behavior: OverscrollBehavior::Auto,
            axis: ScrollAxis::Vertical,
            config: gpui::rubber_band_config(),
            outer_scroll: ScrollHandle::new(),
            inner_scroll: ScrollHandle::new(),
        }
    }

    fn reset_scroll(&mut self, cx: &mut Context<Self>) {
        self.outer_scroll.set_offset(point(px(0.), px(0.)));
        self.inner_scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }

    fn set_axis(&mut self, axis: ScrollAxis, cx: &mut Context<Self>) {
        if self.axis != axis {
            self.axis = axis;
            self.reset_scroll(cx);
        }
    }

    fn adjust_tuning(&mut self, index: usize, delta: f32, cx: &mut Context<Self>) {
        let spec = &TUNING_SPECS[index];
        let next = ((spec.get)(&self.config) + delta).clamp(spec.min, spec.max);
        (spec.set)(&mut self.config, next);
        gpui::set_rubber_band_config(self.config);
        cx.notify();
    }

    fn reset_tuning(&mut self, cx: &mut Context<Self>) {
        self.config = RubberBandConfig::DEFAULT;
        gpui::set_rubber_band_config(self.config);
        cx.notify();
    }

    fn render_vertical_demo(&self, theme: &Theme) -> impl IntoElement {
        let accent: Hsla = rgb(Theme::SETTINGS_ACCENT).into();
        let card_bg = theme.settings_card_bg();
        let card_border = theme.settings_border();
        let muted = theme.settings_muted();
        let text = theme.settings_text();
        let selected = self.behavior;

        div()
            .id("overscroll-demo-outer-v")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_y_scroll()
            .overscroll_behavior(OverscrollBehavior::Auto)
            .track_scroll(&self.outer_scroll)
            .rounded(px(12.))
            .bg(card_bg)
            .border_1()
            .border_color(card_border)
            .p(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(12.))
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(14.))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(muted)
                                            .child("OUTER SCROLL VIEW (AUTO)"),
                                    )
                                    .children((1..=6).map(|i| {
                                        div()
                                            .p(px(12.))
                                            .rounded(px(8.))
                                            .bg(theme.settings_content_bg())
                                            .border_1()
                                            .border_color(card_border)
                                            .flex()
                                            .flex_col()
                                            .gap(px(3.))
                                            .child(
                                                div()
                                                    .text_size(px(13.))
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(text)
                                                    .child(format!("Outer Card {i}")),
                                            )
                                            .child(
                                                div()
                                                    .text_size(px(12.))
                                                    .text_color(muted)
                                                    .child("Scroll inside the inner panel to verify edge bounce and chaining."),
                                            )
                                    })),
                            )
                            .child(
                                div()
                                    .w(px(230.))
                                    .flex_shrink_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(accent)
                                            .child("INNER SCROLL VIEW"),
                                    )
                                    .child(
                                        div()
                                            .id("overscroll-demo-inner-v")
                                            .w_full()
                                            .h(px(250.))
                                            .overflow_y_scroll()
                                            .overscroll_behavior(selected)
                                            .track_scroll(&self.inner_scroll)
                                            .rounded(px(10.))
                                            .bg(theme.settings_content_bg())
                                            .border_2()
                                            .border_color(accent.opacity(0.55))
                                            .p(px(10.))
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(8.))
                                                    .children((1..=10).map(|i| {
                                                        div()
                                                            .px(px(10.))
                                                            .py(px(8.))
                                                            .rounded(px(7.))
                                                            .bg(card_bg)
                                                            .border_1()
                                                            .border_color(card_border)
                                                            .flex()
                                                            .items_center()
                                                            .justify_between()
                                                            .child(
                                                                div()
                                                                    .text_size(px(12.))
                                                                    .font_weight(FontWeight::MEDIUM)
                                                                    .text_color(text)
                                                                    .child(format!("Inner Row {i}")),
                                                            )
                                                            .child(
                                                                div()
                                                                    .text_size(px(11.))
                                                                    .text_color(muted)
                                                                    .child(format!("#{i:02}")),
                                                            )
                                                    })),
                                            ),
                                    ),
                            ),
                    )
                    .children((7..=12).map(|i| {
                        div()
                            .p(px(12.))
                            .rounded(px(8.))
                            .bg(theme.settings_content_bg())
                            .border_1()
                            .border_color(card_border)
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .text_color(text)
                                    .child(format!("Outer Card {i}")),
                            )
                    })),
            )
    }

    fn render_horizontal_demo(&self, theme: &Theme) -> impl IntoElement {
        let accent: Hsla = rgb(Theme::SETTINGS_ACCENT).into();
        let card_bg = theme.settings_card_bg();
        let card_border = theme.settings_border();
        let muted = theme.settings_muted();
        let text = theme.settings_text();
        let selected = self.behavior;

        div()
            .id("overscroll-demo-outer-h")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_x_scroll()
            .overscroll_behavior(OverscrollBehavior::Auto)
            .track_scroll(&self.outer_scroll)
            .rounded(px(12.))
            .bg(card_bg)
            .border_1()
            .border_color(card_border)
            .p(px(16.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(muted)
                            .child("OUTER HORIZONTAL SCROLL VIEW (AUTO)"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_stretch()
                            .gap(px(12.))
                            .children((1..=3).map(|i| {
                                div()
                                    .w(px(140.))
                                    .h(px(210.))
                                    .flex_shrink_0()
                                    .p(px(12.))
                                    .rounded(px(10.))
                                    .bg(theme.settings_content_bg())
                                    .border_1()
                                    .border_color(card_border)
                                    .flex()
                                    .flex_col()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(text)
                                            .child(format!("Outer Tile {i}")),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(muted)
                                            .child("Scroll horizontally"),
                                    )
                            }))
                            .child(
                                div()
                                    .w(px(290.))
                                    .h(px(210.))
                                    .flex_shrink_0()
                                    .flex()
                                    .flex_col()
                                    .gap(px(8.))
                                    .p(px(10.))
                                    .rounded(px(10.))
                                    .bg(theme.settings_content_bg())
                                    .border_2()
                                    .border_color(accent.opacity(0.55))
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(accent)
                                            .child("INNER HORIZONTAL SCROLL VIEW"),
                                    )
                                    .child(
                                        div()
                                            .id("overscroll-demo-inner-h")
                                            .flex_1()
                                            .w_full()
                                            .overflow_x_scroll()
                                            .overscroll_behavior(selected)
                                            .track_scroll(&self.inner_scroll)
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_row()
                                                    .gap(px(8.))
                                                    .h_full()
                                                    .children((1..=8).map(|i| {
                                                        div()
                                                            .w(px(105.))
                                                            .h_full()
                                                            .flex_shrink_0()
                                                            .p(px(10.))
                                                            .rounded(px(8.))
                                                            .bg(card_bg)
                                                            .border_1()
                                                            .border_color(card_border)
                                                            .flex()
                                                            .flex_col()
                                                            .justify_between()
                                                            .child(
                                                                div()
                                                                    .text_size(px(12.))
                                                                    .font_weight(FontWeight::MEDIUM)
                                                                    .text_color(text)
                                                                    .child(format!("Item {i}")),
                                                            )
                                                            .child(
                                                                div()
                                                                    .text_size(px(11.))
                                                                    .text_color(muted)
                                                                    .child(format!("#{i:02}")),
                                                            )
                                                    })),
                                            ),
                                    ),
                            )
                            .children((4..=8).map(|i| {
                                div()
                                    .w(px(140.))
                                    .h(px(210.))
                                    .flex_shrink_0()
                                    .p(px(12.))
                                    .rounded(px(10.))
                                    .bg(theme.settings_content_bg())
                                    .border_1()
                                    .border_color(card_border)
                                    .flex()
                                    .flex_col()
                                    .justify_between()
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(text)
                                            .child(format!("Outer Tile {i}")),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(muted)
                                            .child("Scroll horizontally"),
                                    )
                            })),
                    ),
            )
    }
}

impl Render for ScrollRubberBandingTestView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::for_window(window, cx, true);
        let accent: Hsla = rgb(Theme::SETTINGS_ACCENT).into();
        let bg = theme.settings_content_bg();
        let card_bg = theme.settings_card_bg();
        let card_border = theme.settings_border();
        let text = theme.settings_text();
        let muted = theme.settings_muted();

        let selected = self.behavior;
        let axis = self.axis;
        let outer_offset = self.outer_scroll.offset();
        let inner_offset = self.inner_scroll.offset();
        let (axis_label, outer_val, inner_val) = match axis {
            ScrollAxis::Vertical => ("y", f32::from(outer_offset.y), f32::from(inner_offset.y)),
            ScrollAxis::Horizontal => ("x", f32::from(outer_offset.x), f32::from(inner_offset.x)),
        };

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(bg)
            .text_color(text)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(20.))
                    .py(px(12.))
                    .border_b_1()
                    .border_color(card_border)
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .text_size(px(14.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Scroll Rubber-Banding"),
                            )
                            .child(
                                div()
                                    .text_size(px(11.))
                                    .text_color(muted)
                                    .child(format!(
                                        "Outer {axis_label}: {outer_val:.1}px   ·   Inner {axis_label}: {inner_val:.1}px"
                                    )),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(10.))
                            .child(
                                ui::SegmentedControl::settings(
                                    &theme,
                                    "overscroll-axis-toggle",
                                    vec![
                                        ui::SegmentOption::new(
                                            "Vertical",
                                            axis == ScrollAxis::Vertical,
                                        ),
                                        ui::SegmentOption::new(
                                            "Horizontal",
                                            axis == ScrollAxis::Horizontal,
                                        ),
                                    ],
                                )
                                .on_select(cx.listener(|this, index, _, cx| {
                                    let next = if *index == 0 {
                                        ScrollAxis::Vertical
                                    } else {
                                        ScrollAxis::Horizontal
                                    };
                                    this.set_axis(next, cx);
                                })),
                            )
                            .child(
                                ui::Button::settings(
                                    &theme,
                                    "overscroll-reset-scroll",
                                    ui::ButtonVariant::Gray,
                                    ui::ButtonSize::Sm,
                                )
                                .label("Reset Scroll")
                                .on_click(cx.listener(|this, _, _, cx| this.reset_scroll(cx))),
                            ),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .gap(px(16.))
                    .p(px(16.))
                    .child(
                        div()
                            .id("overscroll-controls-sidebar")
                            .w(px(300.))
                            .flex_shrink_0()
                            .h_full()
                            .overflow_y_scroll()
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .child(
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(muted)
                                            .child("INNER OVERSCROLL BEHAVIOR"),
                                    )
                                    .children(BEHAVIORS.iter().enumerate().map(
                                        |(index, (behavior, title, desc))| {
                                            let is_selected = *behavior == selected;
                                            let behavior = *behavior;
                                            div()
                                                .id(("overscroll-behavior-opt", index))
                                                .p(px(10.))
                                                .rounded(px(9.))
                                                .bg(if is_selected {
                                                    accent.opacity(0.14)
                                                } else {
                                                    card_bg
                                                })
                                                .border_1()
                                                .border_color(if is_selected {
                                                    accent
                                                } else {
                                                    card_border
                                                })
                                                .cursor_pointer()
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.behavior = behavior;
                                                    cx.notify();
                                                }))
                                                .flex()
                                                .flex_col()
                                                .gap(px(3.))
                                                .child(
                                                    div()
                                                        .text_size(px(13.))
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .text_color(if is_selected {
                                                            accent
                                                        } else {
                                                            text
                                                        })
                                                        .child(*title),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(11.))
                                                        .text_color(muted)
                                                        .child(*desc),
                                                )
                                        },
                                    )),
                            )
                            .child(
                                div()
                                    .p(px(12.))
                                    .rounded(px(10.))
                                    .bg(card_bg)
                                    .border_1()
                                    .border_color(card_border)
                                    .flex()
                                    .flex_col()
                                    .gap(px(10.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .justify_between()
                                            .child(
                                                div()
                                                    .text_size(px(11.))
                                                    .font_weight(FontWeight::SEMIBOLD)
                                                    .text_color(muted)
                                                    .child("PHYSICS TUNING"),
                                            )
                                            .child(
                                                ui::Button::settings(
                                                    &theme,
                                                    "overscroll-reset-tuning",
                                                    ui::ButtonVariant::Gray,
                                                    ui::ButtonSize::Sm,
                                                )
                                                .label("Defaults")
                                                .on_click(cx.listener(|this, _, _, cx| {
                                                    this.reset_tuning(cx);
                                                })),
                                            ),
                                    )
                                    .children(TUNING_SPECS.iter().enumerate().map(
                                        |(index, spec)| {
                                            let value = (spec.get)(&self.config);
                                            let fraction = ((value - spec.min)
                                                / (spec.max - spec.min))
                                                .clamp(0.0, 1.0);
                                            let step = spec.step;
                                            let formatted = if spec.unit.is_empty() {
                                                format!("{value:.2}")
                                            } else {
                                                format!("{value:.2}{}", spec.unit)
                                            };
                                            div()
                                                .flex()
                                                .flex_col()
                                                .gap(px(5.))
                                                .child(
                                                    div()
                                                        .flex()
                                                        .items_center()
                                                        .justify_between()
                                                        .child(
                                                            div()
                                                                .text_size(px(12.))
                                                                .text_color(text)
                                                                .child(spec.label),
                                                        )
                                                        .child(
                                                            div()
                                                                .flex()
                                                                .items_center()
                                                                .gap(px(4.))
                                                                .child(
                                                                    div()
                                                                        .id((
                                                                            "tuning-dec",
                                                                            index,
                                                                        ))
                                                                        .w(px(20.))
                                                                        .h(px(20.))
                                                                        .rounded(px(5.))
                                                                        .bg(bg)
                                                                        .border_1()
                                                                        .border_color(card_border)
                                                                        .flex()
                                                                        .items_center()
                                                                        .justify_center()
                                                                        .text_size(px(12.))
                                                                        .cursor_pointer()
                                                                        .on_click(cx.listener(
                                                                            move |this, _, _, cx| {
                                                                                this.adjust_tuning(
                                                                                    index, -step,
                                                                                    cx,
                                                                                );
                                                                            },
                                                                        ))
                                                                        .child("−"),
                                                                )
                                                                .child(
                                                                    div()
                                                                        .w(px(44.))
                                                                        .text_size(px(11.))
                                                                        .text_color(muted)
                                                                        .flex()
                                                                        .justify_center()
                                                                        .child(formatted),
                                                                )
                                                                .child(
                                                                    div()
                                                                        .id((
                                                                            "tuning-inc",
                                                                            index,
                                                                        ))
                                                                        .w(px(20.))
                                                                        .h(px(20.))
                                                                        .rounded(px(5.))
                                                                        .bg(bg)
                                                                        .border_1()
                                                                        .border_color(card_border)
                                                                        .flex()
                                                                        .items_center()
                                                                        .justify_center()
                                                                        .text_size(px(12.))
                                                                        .cursor_pointer()
                                                                        .on_click(cx.listener(
                                                                            move |this, _, _, cx| {
                                                                                this.adjust_tuning(
                                                                                    index, step,
                                                                                    cx,
                                                                                );
                                                                            },
                                                                        ))
                                                                        .child("+"),
                                                                ),
                                                        ),
                                                )
                                                .child(
                                                    div()
                                                        .w_full()
                                                        .h(px(4.))
                                                        .rounded_full()
                                                        .bg(muted.opacity(0.22))
                                                        .overflow_hidden()
                                                        .child(
                                                            div()
                                                                .h_full()
                                                                .w(gpui::relative(fraction))
                                                                .rounded_full()
                                                                .bg(accent),
                                                        ),
                                                )
                                        },
                                    )),
                            ),
                    )
                    .child(match axis {
                        ScrollAxis::Vertical => self.render_vertical_demo(&theme).into_any_element(),
                        ScrollAxis::Horizontal => {
                            self.render_horizontal_demo(&theme).into_any_element()
                        }
                    }),
            )
    }
}

pub fn open(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(940.), px(620.)), cx);
    let _ = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Scroll Rubber-Banding".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        |_window, cx| cx.new(|_| ScrollRubberBandingTestView::new()),
    );
}
