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
    Both,
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
        step: 0.01,
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
        step: 0.02,
        get: |c| c.momentum_carry,
        set: |c, v| c.momentum_carry = v,
    },
    TuningSpec {
        label: "Max overscroll",
        unit: "×",
        min: 0.10,
        max: 0.80,
        step: 0.02,
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
    tracks: [ui::SliderTrack; 5],
    drag: ui::SliderDrag<usize>,
}

impl ScrollRubberBandingTestView {
    fn new() -> Self {
        Self {
            behavior: OverscrollBehavior::Auto,
            axis: ScrollAxis::Vertical,
            config: gpui::rubber_band_config(),
            outer_scroll: ScrollHandle::new(),
            inner_scroll: ScrollHandle::new(),
            tracks: std::array::from_fn(|_| ui::SliderTrack::default()),
            drag: ui::SliderDrag::new(),
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

    fn apply_slider_position(
        &mut self,
        index: usize,
        position: gpui::Point<gpui::Pixels>,
        cx: &mut Context<Self>,
    ) {
        let spec = &TUNING_SPECS[index];
        let Some(track) = self.tracks[index].get() else {
            return;
        };
        let width = f32::from(track.size.width);
        if width <= 0.0 {
            return;
        }
        let fraction = ((f32::from(position.x) - f32::from(track.origin.x)) / width).clamp(0., 1.);
        let raw = spec.min + fraction * (spec.max - spec.min);
        let steps = ((raw - spec.min) / spec.step).round();
        let value = (spec.min + steps * spec.step).clamp(spec.min, spec.max);
        (spec.set)(&mut self.config, value);
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

        // Taffy computes horizontal scroll overflow from a flex-row direct child whose
        // shrink-disabled items exceed the scroll container's width.
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
            .flex()
            .flex_row()
            .items_start()
            .gap(px(12.))
            .children((1..=2).map(|i| {
                div()
                    .w(px(140.))
                    .h(px(230.))
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
                    .w(px(300.))
                    .h(px(230.))
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
                            .min_w_0()
                            .overflow_x_scroll()
                            .overscroll_behavior(selected)
                            .track_scroll(&self.inner_scroll)
                            .flex()
                            .flex_row()
                            .gap(px(8.))
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
            )
            .children((3..=8).map(|i| {
                div()
                    .w(px(140.))
                    .h(px(230.))
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
    }
    fn render_both_demo(&self, theme: &Theme) -> impl IntoElement {
        let accent: Hsla = rgb(Theme::SETTINGS_ACCENT).into();
        let card_bg = theme.settings_card_bg();
        let card_border = theme.settings_border();
        let muted = theme.settings_muted();
        let text = theme.settings_text();
        let selected = self.behavior;

        div()
            .id("overscroll-demo-outer-2d")
            .flex_1()
            .min_w_0()
            .h_full()
            .overflow_scroll()
            .overscroll_behavior(OverscrollBehavior::Auto)
            .track_scroll(&self.outer_scroll)
            .rounded(px(12.))
            .bg(card_bg)
            .border_1()
            .border_color(card_border)
            .p(px(16.))
            .child(
                div()
                    .w(px(1200.))
                    .flex()
                    .flex_col()
                    .gap(px(14.))
                    .child(
                        div()
                            .text_size(px(12.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(muted)
                            .child("OUTER 2D SCROLL CANVAS (AUTO · CONCURRENT X & Y)"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_row()
                            .items_start()
                            .gap(px(14.))
                            .child(
                                div()
                                    .w(px(280.))
                                    .h(px(260.))
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
                                            .child("INNER 2D SCROLL CANVAS"),
                                    )
                                    .child(
                                        div()
                                            .id("overscroll-demo-inner-2d")
                                            .flex_1()
                                            .w_full()
                                            .min_w_0()
                                            .min_h_0()
                                            .overflow_scroll()
                                            .overscroll_behavior(selected)
                                            .track_scroll(&self.inner_scroll)
                                            .child(
                                                div()
                                                    .w(px(620.))
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(8.))
                                                    .children((1..=6).map(|row| {
                                                        div()
                                                            .flex()
                                                            .flex_row()
                                                            .gap(px(8.))
                                                            .children((1..=5).map(|col| {
                                                                div()
                                                                    .w(px(112.))
                                                                    .h(px(64.))
                                                                    .flex_shrink_0()
                                                                    .p(px(8.))
                                                                    .rounded(px(7.))
                                                                    .bg(card_bg)
                                                                    .border_1()
                                                                    .border_color(card_border)
                                                                    .flex()
                                                                    .flex_col()
                                                                    .justify_between()
                                                                    .child(
                                                                        div()
                                                                            .text_size(px(12.))
                                                                            .font_weight(
                                                                                FontWeight::MEDIUM,
                                                                            )
                                                                            .text_color(text)
                                                                            .child(format!(
                                                                                "Cell {row},{col}"
                                                                            )),
                                                                    )
                                                                    .child(
                                                                        div()
                                                                            .text_size(px(10.))
                                                                            .text_color(muted)
                                                                            .child("2D inner"),
                                                                    )
                                                            }))
                                                    })),
                                            ),
                                    ),
                            )
                            .children((1..=5).map(|col| {
                                div()
                                    .w(px(160.))
                                    .h(px(260.))
                                    .flex_shrink_0()
                                    .p(px(12.))
                                    .rounded(px(10.))
                                    .bg(theme.settings_content_bg())
                                    .border_1()
                                    .border_color(card_border)
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(text)
                                            .child(format!("Outer Col {col}")),
                                    )
                            })),
                    )
                    .children((2..=5).map(|row| {
                        div()
                            .flex()
                            .flex_row()
                            .gap(px(12.))
                            .children((1..=6).map(|col| {
                                div()
                                    .w(px(180.))
                                    .h(px(110.))
                                    .flex_shrink_0()
                                    .p(px(12.))
                                    .rounded(px(10.))
                                    .bg(theme.settings_content_bg())
                                    .border_1()
                                    .border_color(card_border)
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(text)
                                            .child(format!("Outer {row},{col}")),
                                    )
                            }))
                    })),
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
        let thumb_fill: Hsla = rgb(0xffffff).into();

        let selected = self.behavior;
        let axis = self.axis;
        let outer_offset = self.outer_scroll.offset();
        let inner_offset = self.inner_scroll.offset();
        let offset_readout = match axis {
            ScrollAxis::Vertical => format!(
                "Outer y: {:.1}px   ·   Inner y: {:.1}px",
                f32::from(outer_offset.y),
                f32::from(inner_offset.y)
            ),
            ScrollAxis::Horizontal => format!(
                "Outer x: {:.1}px   ·   Inner x: {:.1}px",
                f32::from(outer_offset.x),
                f32::from(inner_offset.x)
            ),
            ScrollAxis::Both => format!(
                "Outer ({:.1}, {:.1})   ·   Inner ({:.1}, {:.1})",
                f32::from(outer_offset.x),
                f32::from(outer_offset.y),
                f32::from(inner_offset.x),
                f32::from(inner_offset.y)
            ),
        };

        div()
            .relative()
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
                                    .child(offset_readout),
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
                                        ui::SegmentOption::new("Both", axis == ScrollAxis::Both),
                                    ],
                                )
                                .on_select(cx.listener(
                                    |this, index, _, cx| {
                                        let next = match *index {
                                            0 => ScrollAxis::Vertical,
                                            1 => ScrollAxis::Horizontal,
                                            _ => ScrollAxis::Both,
                                        };
                                        this.set_axis(next, cx);
                                    },
                                )),
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
                    .w_full()
                    .min_w_0()
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
                                            let formatted = if spec.unit.is_empty() {
                                                format!("{value:.2}")
                                            } else {
                                                format!("{value:.2}{}", spec.unit)
                                            };
                                            div()
                                                .flex()
                                                .flex_col()
                                                .gap(px(4.))
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
                                                                .text_size(px(11.))
                                                                .text_color(muted)
                                                                .child(formatted),
                                                        ),
                                                )
                                                .child(
                                                    ui::Slider::new(
                                                        ("overscroll-tuning-slider", index),
                                                        fraction,
                                                        self.tracks[index].clone(),
                                                    )
                                                    .flex()
                                                    .track(px(4.), muted.opacity(0.22))
                                                    .fill(accent)
                                                    .thumb(
                                                        px(14.),
                                                        thumb_fill,
                                                        Some(card_border),
                                                    )
                                                    .thumb_shadow()
                                                    .on_drag_start(cx.listener(
                                                        move |this,
                                                              event: &gpui::MouseDownEvent,
                                                              _,
                                                              cx| {
                                                            this.drag.begin(index, || {});
                                                            this.apply_slider_position(
                                                                index,
                                                                event.position,
                                                                cx,
                                                            );
                                                        },
                                                    )),
                                                )
                                        },
                                    )),
                            ),
                    )
                    .child(match axis {
                        ScrollAxis::Vertical => {
                            self.render_vertical_demo(&theme).into_any_element()
                        }
                        ScrollAxis::Horizontal => {
                            self.render_horizontal_demo(&theme).into_any_element()
                        }
                        ScrollAxis::Both => self.render_both_demo(&theme).into_any_element(),
                    }),
            )
            .when_some(self.drag.active(), |this, active_index| {
                this.child(ui::Slider::drag_layer(
                    "overscroll-tuning-drag-layer",
                    cx.listener(move |this, event: &gpui::MouseMoveEvent, _, cx| {
                        this.apply_slider_position(active_index, event.position, cx);
                    }),
                    cx.listener(|this, _, _, cx| {
                        this.drag.end(|| {});
                        cx.notify();
                    }),
                ))
            })
    }
}

pub fn open(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(940.), px(640.)), cx);
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

#[cfg(test)]
mod tests {
    use gpui::{
        Modifiers, ScrollDelta, ScrollPhase, ScrollWheelEvent, TestAppContext, TouchPhase,
        VisualTestContext,
    };

    use super::*;

    fn trackpad_scroll(
        position: gpui::Point<gpui::Pixels>,
        delta: gpui::Point<gpui::Pixels>,
        scroll_phase: ScrollPhase,
        momentum_phase: ScrollPhase,
    ) -> ScrollWheelEvent {
        let touch_phase = match scroll_phase {
            ScrollPhase::Began | ScrollPhase::MayBegin => TouchPhase::Started,
            ScrollPhase::Ended | ScrollPhase::Cancelled => TouchPhase::Ended,
            _ => TouchPhase::Moved,
        };
        ScrollWheelEvent {
            position,
            delta: ScrollDelta::Pixels(delta),
            modifiers: Modifiers::none(),
            touch_phase,
            scroll_phase,
            momentum_phase,
        }
    }

    #[gpui::test]
    fn vertical_and_horizontal_nested_scrolling_end_to_end(cx: &mut TestAppContext) {
        let (view, cx) = cx.add_window_view(|_, _| ScrollRubberBandingTestView::new());
        let cx: &mut VisualTestContext = cx;
        cx.run_until_parked();

        // 1. Vertical Auto: verify inner actually scrolls, rubber-bands at bottom, and does NOT move outer.
        let (inner_v_pt, inner_max_y) = view.read_with(cx, |v, _| {
            (
                v.inner_scroll.bounds().center(),
                f32::from(v.inner_scroll.max_offset().y),
            )
        });
        assert!(
            inner_max_y > 50.0,
            "vertical inner must have vertical overflow, got max_y={inner_max_y}"
        );

        cx.simulate_event(trackpad_scroll(
            inner_v_pt,
            point(px(0.), px(-80.)),
            ScrollPhase::Began,
            ScrollPhase::None,
        ));
        cx.simulate_event(trackpad_scroll(
            inner_v_pt,
            point(px(0.), px(-400.)),
            ScrollPhase::Changed,
            ScrollPhase::None,
        ));
        cx.simulate_event(trackpad_scroll(
            inner_v_pt,
            point(px(0.), px(-200.)),
            ScrollPhase::Changed,
            ScrollPhase::None,
        ));
        cx.run_until_parked();

        let (outer_y, inner_y) = view.read_with(cx, |v, _| {
            (
                f32::from(v.outer_scroll.offset().y),
                f32::from(v.inner_scroll.offset().y),
            )
        });
        assert!(
            inner_y < -inner_max_y,
            "vertical inner should rubber-band past -{inner_max_y}, got {inner_y}"
        );
        assert_eq!(
            outer_y, 0.0,
            "vertical outer must not move during owned inner gesture"
        );

        // 2. Switch to Horizontal mode and verify BOTH outer and inner actually have horizontal overflow & scroll.
        view.update(cx, |v, cx| v.set_axis(ScrollAxis::Horizontal, cx));
        cx.refresh();
        cx.run_until_parked();

        let (inner_h_pt, inner_max_x, outer_max_x) = view.read_with(cx, |v, _| {
            (
                v.inner_scroll.bounds().center(),
                f32::from(v.inner_scroll.max_offset().x),
                f32::from(v.outer_scroll.max_offset().x),
            )
        });
        assert!(
            outer_max_x > 100.0,
            "horizontal outer must have real horizontal overflow, got max_x={outer_max_x}"
        );
        assert!(
            inner_max_x > 100.0,
            "horizontal inner must have real horizontal overflow, got max_x={inner_max_x}"
        );

        cx.simulate_event(trackpad_scroll(
            inner_h_pt,
            point(px(-120.), px(0.)),
            ScrollPhase::Began,
            ScrollPhase::None,
        ));
        cx.simulate_event(trackpad_scroll(
            inner_h_pt,
            point(px(-120.), px(0.)),
            ScrollPhase::Changed,
            ScrollPhase::None,
        ));
        cx.simulate_event(trackpad_scroll(
            inner_h_pt,
            point(px(0.), px(0.)),
            ScrollPhase::Ended,
            ScrollPhase::None,
        ));
        cx.run_until_parked();

        let (outer_x, inner_x) = view.read_with(cx, |v, _| {
            (
                f32::from(v.outer_scroll.offset().x),
                f32::from(v.inner_scroll.offset().x),
            )
        });
        assert!(
            inner_x < -100.0,
            "horizontal inner must actually scroll left, got inner_x={inner_x}"
        );
        assert_eq!(
            outer_x, 0.0,
            "horizontal outer must not move during owned inner gesture"
        );

        // Scroll inner to right edge, then start a NEW gesture to verify Auto chains to outer X.
        view.update(cx, |v, cx| {
            let max_x = v.inner_scroll.max_offset().x;
            v.inner_scroll.set_offset(point(-max_x, px(0.)));
            cx.notify();
        });
        cx.refresh();
        cx.run_until_parked();

        cx.simulate_event(trackpad_scroll(
            inner_h_pt,
            point(px(-100.), px(0.)),
            ScrollPhase::Began,
            ScrollPhase::None,
        ));
        cx.run_until_parked();

        let outer_x_after = view.read_with(cx, |v, _| f32::from(v.outer_scroll.offset().x));
        assert!(
            outer_x_after < -50.0,
            "new horizontal gesture at inner edge must chain to outer, got outer_x={outer_x_after}"
        );

        // Verify Contain blocks chaining to outer X even on a new gesture at the edge.
        view.update(cx, |v, cx| {
            v.behavior = OverscrollBehavior::Contain;
            v.outer_scroll.set_offset(point(px(0.), px(0.)));
            let max_x = v.inner_scroll.max_offset().x;
            v.inner_scroll.set_offset(point(-max_x, px(0.)));
            cx.notify();
        });
        cx.refresh();
        cx.run_until_parked();

        cx.simulate_event(trackpad_scroll(
            inner_h_pt,
            point(px(-100.), px(0.)),
            ScrollPhase::Began,
            ScrollPhase::None,
        ));
        cx.run_until_parked();

        let (outer_x_contain, inner_x_contain) = view.read_with(cx, |v, _| {
            (
                f32::from(v.outer_scroll.offset().x),
                f32::from(v.inner_scroll.offset().x),
            )
        });
        assert_eq!(
            outer_x_contain, 0.0,
            "Contain must never chain horizontal scroll to outer"
        );
        assert!(
            inner_x_contain < -inner_max_x,
            "Contain should rubber-band inner horizontally past -{inner_max_x}, got {inner_x_contain}"
        );
    }
}
