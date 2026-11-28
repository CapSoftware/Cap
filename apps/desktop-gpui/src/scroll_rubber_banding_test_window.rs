use gpui::{
    App, Bounds, Context, IntoElement, OverscrollBehavior, ParentElement, Render, ScrollHandle,
    Styled, TitlebarOptions, Window, WindowBounds, WindowOptions, div, point, prelude::*, px, rgb,
    rgba, size,
};

const OPTIONS: [(OverscrollBehavior, &str, &str); 4] = [
    (
        OverscrollBehavior::Auto,
        "overscroll-behavior: auto;",
        "Inner bounces during an owned gesture; a new gesture at the edge chains to outer.",
    ),
    (
        OverscrollBehavior::Contain,
        "overscroll-behavior: contain;",
        "Inner bounces at its edges and never chains scroll to outer.",
    ),
    (
        OverscrollBehavior::Chain,
        "overscroll-behavior: chain;",
        "Excess scroll chains immediately to outer when inner reaches an edge.",
    ),
    (
        OverscrollBehavior::None,
        "overscroll-behavior: none;",
        "Disables both rubber-band bounce and scroll chaining to outer.",
    ),
];

const OUTER_PARAGRAPHS: &[&str] = &[
    "This is a scrollable container. Michaelmas term lately over, and the Lord Chancellor sitting in Lincoln's Inn Hall. Implacable November weather. As much mud in the streets as if the waters had but newly retired from the face of the earth, and it would not be wonderful to meet a Megalosaurus, forty feet long or so, waddling like an elephantine lizard up Holborn Hill.",
    "Smoke lowering down from chimney-pots, making a soft black drizzle, with flakes of soot in it as big as full-grown snowflakes — gone into mourning, one might imagine, for the death of the sun.",
    "Dogs, undistinguishable in mire. Horses, scarcely better; splashed to their very blinkers. Foot passengers, jostling one another's umbrellas in a general infection of ill temper, and losing their foot-hold at street-corners, where tens of thousands of other foot passengers have been slipping and sliding since the day broke.",
    "Fog everywhere. Fog up the river, where it flows among green aits and meadows; fog down the river, where it rolls defiled among the tiers of shipping and the waterside pollutions of a great and dirty city.",
    "Fog on the Essex marshes, fog on the Kentish heights. Fog creeping into the cabooses of collier-brigs; fog lying out on the yards and hovering in the rigging of great ships; fog drooping on the gunwales of barges and small boats.",
    "Chance people on the bridges peeping over the parapets into a nether sky of fog, with fog all round them, as if they were up in a balloon and hanging in the misty clouds.",
];

const INNER_PARAGRAPHS: &[&str] = &[
    "This is the inner container. Focus on this container, scroll to the bottom and when you reach the bottom keep scrolling.",
    "If you have auto selected, the inner container should rubber-band while you stay in the same gesture without moving the outer container. Lift your fingers and scroll again at the boundary to move the outer container.",
    "With contain selected, the inner container rubber-bands at both edges and the outer container never moves, even when you start a new scroll gesture at the bottom.",
    "With chain selected, reaching the bottom immediately chains the remaining scroll into the outer container without waiting for a new gesture.",
    "With none selected, the inner container clamps cleanly at the boundary with no bounce and never scrolls the outer container.",
    "Keep scrolling past this line to verify momentum flicks do not leak across containers when the inner container owns the gesture.",
];

struct ScrollRubberBandingTestView {
    behavior: OverscrollBehavior,
    outer_scroll: ScrollHandle,
    inner_scroll: ScrollHandle,
}

impl ScrollRubberBandingTestView {
    fn new() -> Self {
        Self {
            behavior: OverscrollBehavior::Auto,
            outer_scroll: ScrollHandle::new(),
            inner_scroll: ScrollHandle::new(),
        }
    }

    fn reset(&mut self, cx: &mut Context<Self>) {
        self.outer_scroll.set_offset(point(px(0.), px(0.)));
        self.inner_scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
}

impl Render for ScrollRubberBandingTestView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let selected = self.behavior;
        let active_desc = OPTIONS
            .iter()
            .find(|(b, _, _)| *b == selected)
            .map(|(_, _, desc)| *desc)
            .unwrap_or("");
        let outer_y = f32::from(self.outer_scroll.offset().y);
        let inner_y = f32::from(self.inner_scroll.offset().y);

        div()
            .size_full()
            .flex()
            .flex_col()
            .bg(rgb(0x16161a))
            .text_color(rgb(0xf4f4f5))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .px(px(20.))
                    .py(px(14.))
                    .border_b_1()
                    .border_color(rgba(0xffffff1a))
                    .child(
                        div()
                            .text_size(px(15.))
                            .font_weight(gpui::FontWeight::SEMIBOLD)
                            .child("CSS Demo: overscroll-behavior"),
                    )
                    .child(
                        div()
                            .id("overscroll-demo-reset")
                            .px(px(12.))
                            .py(px(5.))
                            .rounded(px(6.))
                            .bg(rgba(0xffffff18))
                            .border_1()
                            .border_color(rgba(0xffffff22))
                            .text_size(px(12.))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, _, cx| this.reset(cx)))
                            .child("Reset"),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_row()
                    .gap(px(20.))
                    .p(px(20.))
                    .child(
                        div()
                            .w(px(310.))
                            .flex_shrink_0()
                            .flex()
                            .flex_col()
                            .gap(px(10.))
                            .children(OPTIONS.iter().enumerate().map(|(index, (behavior, label, _))| {
                                let is_selected = *behavior == selected;
                                let behavior = *behavior;
                                div()
                                    .id(("overscroll-opt", index))
                                    .flex()
                                    .items_center()
                                    .justify_between()
                                    .px(px(14.))
                                    .py(px(14.))
                                    .rounded(px(8.))
                                    .bg(if is_selected {
                                        rgb(0x1e2533)
                                    } else {
                                        rgb(0x202228)
                                    })
                                    .border_2()
                                    .border_color(if is_selected {
                                        rgb(0x5b9dff)
                                    } else {
                                        rgba(0xffffff18)
                                    })
                                    .cursor_pointer()
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.behavior = behavior;
                                        cx.notify();
                                    }))
                                    .child(
                                        div()
                                            .text_size(px(13.))
                                            .text_color(rgb(0xe8b059))
                                            .child(*label),
                                    )
                                    .when(is_selected, |this| {
                                        this.child(
                                            div()
                                                .text_size(px(14.))
                                                .text_color(rgb(0x5b9dff))
                                                .child(">"),
                                        )
                                    })
                            }))
                            .child(
                                div()
                                    .mt(px(8.))
                                    .p(px(12.))
                                    .rounded(px(8.))
                                    .bg(rgba(0xffffff08))
                                    .border_1()
                                    .border_color(rgba(0xffffff14))
                                    .flex()
                                    .flex_col()
                                    .gap(px(6.))
                                    .child(
                                        div()
                                            .text_size(px(12.))
                                            .text_color(rgba(0xffffffb8))
                                            .child(active_desc),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .text_color(rgba(0xffffff78))
                                            .child(format!(
                                                "outer y: {outer_y:.1}px   |   inner y: {inner_y:.1}px"
                                            )),
                                    ),
                            ),
                    )
                    .child(
                        div()
                            .id("overscroll-demo-outer")
                            .flex_1()
                            .min_w_0()
                            .h_full()
                            .overflow_y_scroll()
                            .overscroll_behavior(OverscrollBehavior::Auto)
                            .track_scroll(&self.outer_scroll)
                            .border_2()
                            .border_dashed()
                            .border_color(rgba(0xffffffcc))
                            .p(px(16.))
                            .child(
                                div()
                                    .flex()
                                    .flex_row()
                                    .items_start()
                                    .gap(px(16.))
                                    .child(
                                        div()
                                            .flex_1()
                                            .min_w_0()
                                            .flex()
                                            .flex_col()
                                            .gap(px(14.))
                                            .text_size(px(15.))
                                            .line_height(px(22.))
                                            .children(OUTER_PARAGRAPHS.iter().map(|p| div().child(*p))),
                                    )
                                    .child(
                                        div()
                                            .id("overscroll-demo-inner")
                                            .w(px(210.))
                                            .h(px(230.))
                                            .flex_shrink_0()
                                            .overflow_y_scroll()
                                            .overscroll_behavior(selected)
                                            .track_scroll(&self.inner_scroll)
                                            .border_2()
                                            .border_dashed()
                                            .border_color(rgb(0x3b82f6))
                                            .p(px(10.))
                                            .child(
                                                div()
                                                    .flex()
                                                    .flex_col()
                                                    .gap(px(12.))
                                                    .text_size(px(14.))
                                                    .line_height(px(20.))
                                                    .children(
                                                        INNER_PARAGRAPHS
                                                            .iter()
                                                            .map(|p| div().child(*p)),
                                                    ),
                                            ),
                                    ),
                            ),
                    ),
            )
    }
}

pub fn open(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(860.), px(520.)), cx);
    let _ = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some("Overscroll Behavior Test".into()),
                ..Default::default()
            }),
            ..Default::default()
        },
        |_window, cx| cx.new(|_| ScrollRubberBandingTestView::new()),
    );
}
