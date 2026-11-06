use super::*;
use gpui::{AnyElement, Hsla, linear_color_stop, linear_gradient, svg};

const REFERENCE_WIDTH: f32 = 1080.;
const MAX_REEL_ASPECT: f32 = 0.7;

const EDGE: f32 = 42.;
const TOP_BAR_Y: f32 = 120.;
const TOP_LABEL_SIZE: f32 = 54.;
const ICON_SIZE: f32 = 78.;
const RAIL_SLOT: f32 = 152.;
const RAIL_LABEL_WIDTH: f32 = 54.;
const BAR_HEIGHT: f32 = 22.;
const AVATAR_SIZE: f32 = 84.;
const CAPTION_LINE_GAP: f32 = 22.;
const TOP_SCRIM: f32 = 300.;
const BOTTOM_SCRIM: f32 = 760.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReelPlatform {
    Instagram,
    TikTok,
    Shorts,
}

struct ReelChrome {
    label: &'static str,
    top_icons: &'static [&'static str],
    rail: &'static [&'static str],
    rail_bottom: f32,
    caption_bottom: f32,
    caption_width: f32,
    tabs: &'static [&'static str],
}

impl ReelPlatform {
    pub(crate) const ALL: [Self; 3] = [Self::Instagram, Self::TikTok, Self::Shorts];

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Instagram => "Instagram",
            Self::TikTok => "TikTok",
            Self::Shorts => "YouTube Shorts",
        }
    }

    fn chrome(self) -> ReelChrome {
        match self {
            Self::Instagram => ReelChrome {
                label: "Reels",
                top_icons: &["icons/camera.svg"],
                rail: &[
                    "icons/heart.svg",
                    "icons/message-bubble.svg",
                    "icons/send.svg",
                    "icons/more-horizontal.svg",
                ],
                rail_bottom: 330.,
                caption_bottom: 300.,
                caption_width: 700.,
                tabs: &[
                    "icons/search.svg",
                    "icons/square-play.svg",
                    "icons/send.svg",
                    "icons/user-round.svg",
                ],
            },
            Self::TikTok => ReelChrome {
                label: "For You",
                top_icons: &["icons/search.svg"],
                rail: &[
                    "icons/user-round.svg",
                    "icons/heart.svg",
                    "icons/message-bubble.svg",
                    "icons/bookmark.svg",
                    "icons/send.svg",
                ],
                rail_bottom: 300.,
                caption_bottom: 280.,
                caption_width: 760.,
                tabs: &[
                    "icons/search.svg",
                    "icons/square-play.svg",
                    "icons/message-bubble.svg",
                    "icons/user-round.svg",
                ],
            },
            Self::Shorts => ReelChrome {
                label: "Shorts",
                top_icons: &["icons/search.svg", "icons/more-horizontal.svg"],
                rail: &[
                    "icons/thumbs-up.svg",
                    "icons/thumbs-down.svg",
                    "icons/message-bubble.svg",
                    "icons/send.svg",
                    "icons/more-horizontal.svg",
                ],
                rail_bottom: 290.,
                caption_bottom: 270.,
                caption_width: 780.,
                tabs: &[
                    "icons/square-play.svg",
                    "icons/search.svg",
                    "icons/user-round.svg",
                ],
            },
        }
    }
}

/// Whether the output is close enough to 9:16 for an app to play it full
/// screen.
pub(crate) fn is_reel_output(output: [u32; 2]) -> bool {
    output[1] > 0 && output[0] as f32 / output[1] as f32 <= MAX_REEL_ASPECT
}

fn rail_slot_bottom(chrome: &ReelChrome, index: usize) -> f32 {
    let from_end = (chrome.rail.len() - 1 - index) as f32;
    chrome.rail_bottom + RAIL_SLOT * from_end
}

fn reel_interface(platform: ReelPlatform, size: gpui::Size<Pixels>) -> AnyElement {
    let chrome = platform.chrome();
    let scale = f32::from(size.width) / REFERENCE_WIDTH;
    let at = |value: f32| px(value * scale);
    let ink = gpui::hsla(0., 0., 1., 0.94);
    let quiet = gpui::hsla(0., 0., 1., 0.72);
    let shade = |alpha: f32| gpui::hsla(0., 0., 0., alpha);
    let icon = |path: &'static str, side: f32, color: Hsla| {
        svg().path(path).size(at(side)).text_color(color)
    };
    let bar = |width: f32, height: f32, color: Hsla| {
        div()
            .w(at(width))
            .h(at(height))
            .rounded(at(height / 2.))
            .bg(color)
    };

    let scrims = [
        div()
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(at(TOP_SCRIM))
            .bg(linear_gradient(
                180.,
                linear_color_stop(shade(0.42), 0.),
                linear_color_stop(shade(0.), 1.),
            )),
        div()
            .absolute()
            .bottom_0()
            .left_0()
            .right_0()
            .h(at(BOTTOM_SCRIM))
            .bg(linear_gradient(
                0.,
                linear_color_stop(shade(0.62), 0.),
                linear_color_stop(shade(0.), 1.),
            )),
    ];

    let top_bar = div()
        .absolute()
        .top(at(TOP_BAR_Y))
        .left(at(EDGE))
        .right(at(EDGE))
        .flex()
        .items_center()
        .justify_between()
        .child(
            div()
                .text_size(at(TOP_LABEL_SIZE))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(ink)
                .child(chrome.label),
        )
        .child(
            div().flex().items_center().gap(at(36.)).children(
                chrome
                    .top_icons
                    .iter()
                    .map(|path| icon(path, ICON_SIZE * 0.8, ink)),
            ),
        );

    let rail = chrome.rail.iter().enumerate().map(|(index, path)| {
        div()
            .absolute()
            .bottom(at(rail_slot_bottom(&chrome, index)))
            .right(at(EDGE))
            .flex()
            .flex_col()
            .items_center()
            .gap(at(14.))
            .child(icon(path, ICON_SIZE, ink))
            .child(bar(RAIL_LABEL_WIDTH, BAR_HEIGHT * 0.6, quiet))
    });

    let caption = div()
        .absolute()
        .left(at(EDGE))
        .bottom(at(chrome.caption_bottom))
        .flex()
        .flex_col()
        .gap(at(CAPTION_LINE_GAP))
        .child(
            div()
                .flex()
                .items_center()
                .gap(at(20.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .size(at(AVATAR_SIZE))
                        .rounded_full()
                        .bg(shade(0.34))
                        .child(icon("icons/user-round.svg", AVATAR_SIZE * 0.6, ink)),
                )
                .child(bar(chrome.caption_width * 0.42, BAR_HEIGHT * 1.3, ink)),
        )
        .child(bar(chrome.caption_width, BAR_HEIGHT, quiet))
        .child(bar(chrome.caption_width * 0.68, BAR_HEIGHT, quiet))
        .child(
            div()
                .flex()
                .items_center()
                .gap(at(14.))
                .child(icon("icons/music.svg", ICON_SIZE * 0.5, ink))
                .child(bar(chrome.caption_width * 0.5, BAR_HEIGHT * 0.8, quiet)),
        );

    let tabs = div()
        .absolute()
        .bottom(at(EDGE * 2.))
        .left(at(EDGE))
        .right(at(EDGE))
        .flex()
        .items_center()
        .justify_around()
        .children(chrome.tabs.iter().map(|path| icon(path, ICON_SIZE, ink)));

    div()
        .relative()
        .w(size.width)
        .h(size.height)
        .rounded(px(PREVIEW_RADIUS))
        .overflow_hidden()
        .children(scrims)
        .child(top_bar)
        .children(rail)
        .child(caption)
        .child(tabs)
        .into_any_element()
}

impl EditorWindow {
    pub(super) fn reel_available(&self) -> bool {
        self.frame_layout
            .is_some_and(|layout| is_reel_output(layout.output_size))
    }

    pub(super) fn render_reel_button(
        &self,
        narrow: bool,
        cx: &mut Context<Self>,
    ) -> Option<impl IntoElement> {
        if !self.reel_available() {
            return None;
        }
        let theme = self.theme;
        let label = self
            .reel_platform
            .map_or(tr::editor::window::reel::title(), ReelPlatform::label);
        Some(
            ui::EditorButton::plain(&theme, "reel-mode")
                .text(&theme)
                .left_icon("icons/smartphone.svg")
                .when(!narrow, |button| button.label(label))
                .tooltip(&theme, tr::editor::window::reel::tooltip())
                .pressed(
                    self.reel_platform.is_some()
                        || self
                            .toolbar_menu
                            .as_ref()
                            .is_some_and(|menu| menu.kind == ToolbarMenu::Reel),
                )
                .on_open(cx.listener(|this, bounds: &Bounds<Pixels>, window, cx| {
                    this.open_toolbar_menu(ToolbarMenu::Reel, *bounds, window, cx);
                })),
        )
    }

    pub(super) fn reel_menu_items(&self) -> Vec<ui::MenuItem> {
        std::iter::once(ui::MenuItem::new(
            tr::editor::window::reel::off(),
            self.reel_platform.is_none(),
        ))
        .chain(ReelPlatform::ALL.iter().map(|platform| {
            ui::MenuItem::new(platform.label(), self.reel_platform == Some(*platform))
        }))
        .collect()
    }

    pub(super) fn select_reel_platform(&mut self, index: usize) {
        self.reel_platform = index
            .checked_sub(1)
            .and_then(|index| ReelPlatform::ALL.get(index).copied());
    }

    /// Laid out while painting, from this element's own bounds, because
    /// `player_frame_rect` is written by the paint after this render and
    /// would leave the interface a step behind a resize.
    pub(super) fn render_reel_overlay(&self) -> Option<AnyElement> {
        let platform = self.reel_platform?;
        let output = self.frame_layout?.output_size;
        if !is_reel_output(output) {
            return None;
        }
        let frame_size = (output[0] as f32, output[1] as f32);
        Some(
            gpui::canvas(
                move |bounds, window, cx| {
                    let frame = preview_frame_bounds(bounds, frame_size);
                    let mut interface = reel_interface(platform, frame.size);
                    interface.prepaint_as_root(
                        frame.origin,
                        frame.size.map(gpui::AvailableSpace::Definite),
                        window,
                        cx,
                    );
                    interface
                },
                |_, mut interface, window, cx| interface.paint(window, cx),
            )
            .absolute()
            .inset_0()
            .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_portrait_output_gets_reel_mode() {
        assert!(is_reel_output([1080, 1920]));
        assert!(is_reel_output([540, 960]));
        assert!(!is_reel_output([1080, 1440]));
        assert!(!is_reel_output([1080, 1080]));
        assert!(!is_reel_output([1920, 1080]));
        assert!(!is_reel_output([0, 0]));
    }

    #[test]
    fn every_platform_fits_the_shortest_reel_output() {
        let shortest_height = REFERENCE_WIDTH / MAX_REEL_ASPECT;
        for platform in ReelPlatform::ALL {
            let chrome = platform.chrome();
            assert_eq!(
                rail_slot_bottom(&chrome, chrome.rail.len() - 1),
                chrome.rail_bottom
            );
            let rail_top = shortest_height - rail_slot_bottom(&chrome, 0) - RAIL_SLOT;
            assert!(rail_top > TOP_BAR_Y + TOP_LABEL_SIZE);
            assert!(EDGE + chrome.caption_width < REFERENCE_WIDTH - EDGE - ICON_SIZE);
        }
    }
}
