//! The Cursor tab's style picker and its click-ripple section.
//!
//! The picker is one row of four tiles, each showing a family's arrow drawn
//! from the **real** cursor art in `crates/cursor-info/assets` -- the same
//! SVGs the renderer composites -- so the choice is made by looking at the
//! cursor rather than by reading the word "Windows". The arrow alone is what
//! makes a family recognisable, so the tile shows nothing else. `svg()` keeps
//! only a glyph's alpha and tints it with the element's text colour, which
//! would flatten a two-tone cursor into a silhouette, so each arrow is
//! rasterised with `resvg` into a [`gpui::RenderImage`] and cached per
//! (shape, device-pixel box).
//!
//! The tiles are plain theme surfaces: the assets carry their own
//! black-on-white edge and a soft drop shadow, so they read on a light or a
//! dark tile the way a real cursor reads over a light or dark window.
//!
//! The fourth tile is `Circle`, whose art has no asset: it is the renderer's
//! own touch circle (`crates/rendering/src/layers/cursor.rs`
//! `create_circle_cursor`) restated with gpui primitives.

use cap_cursor_info::{CursorFamily, CursorShape};
use cap_project::CursorType;

use super::*;
use crate::editor_tabs::CursorSlider;

const CARD_GAP: f32 = 8.;
const TILE_HEIGHT: f32 = 60.;
const TILE_RADIUS: f32 = 10.;
/// The arrow's box. Square, and every arrow asset is taller than it is wide,
/// so the fit lands on the height and each family keeps its own width.
const ARROW_BOX: f32 = 34.;
const CIRCLE_DISC: f32 = 28.;
const CARD_GROUP: &str = "cursor-style-card";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CursorCard {
    Family(CursorFamily),
    Circle,
}

impl CursorCard {
    fn label(self) -> &'static str {
        match self {
            Self::Family(CursorFamily::MacOS) => "macOS",
            Self::Family(CursorFamily::MacOSTahoe) => "macOS Tahoe",
            Self::Family(CursorFamily::Windows) => "Windows",
            Self::Circle => "Circle",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Family(CursorFamily::MacOS) => "macos",
            Self::Family(CursorFamily::MacOSTahoe) => "tahoe",
            Self::Family(CursorFamily::Windows) => "windows",
            Self::Circle => "circle",
        }
    }

    /// What clicking the card writes. Always explicit -- the picker never
    /// writes `Auto` back, because a card is only ever shown selected on the
    /// strength of a family it can name.
    fn cursor_type(self) -> CursorType {
        match self {
            Self::Family(CursorFamily::MacOS) => CursorType::MacOS,
            Self::Family(CursorFamily::MacOSTahoe) => CursorType::MacOSTahoe,
            Self::Family(CursorFamily::Windows) => CursorType::Windows,
            Self::Circle => CursorType::Circle,
        }
    }
}

/// Host order: the platform's own cursors first, then the other two, then the
/// styled circle.
fn cursor_cards() -> [CursorCard; 4] {
    if cfg!(target_os = "windows") {
        [
            CursorCard::Family(CursorFamily::Windows),
            CursorCard::Family(CursorFamily::MacOS),
            CursorCard::Family(CursorFamily::MacOSTahoe),
            CursorCard::Circle,
        ]
    } else {
        [
            CursorCard::Family(CursorFamily::MacOS),
            CursorCard::Family(CursorFamily::MacOSTahoe),
            CursorCard::Family(CursorFamily::Windows),
            CursorCard::Circle,
        ]
    }
}

/// Which card reads as selected: the explicit type when there is one, and
/// otherwise the family the recording was made with -- or, failing that, this
/// host's -- because that is what `Auto` will actually draw.
fn selected_card(cursor_type: &CursorType, recorded: Option<CursorFamily>) -> CursorCard {
    if *cursor_type == CursorType::Circle {
        return CursorCard::Circle;
    }
    match cursor_type.family() {
        Some(family) => CursorCard::Family(family),
        None => CursorCard::Family(recorded.unwrap_or(host_cursor_family())),
    }
}

fn host_cursor_family() -> CursorFamily {
    if cfg!(target_os = "windows") {
        CursorFamily::Windows
    } else {
        CursorFamily::MacOS
    }
}

fn white(alpha: f32) -> Hsla {
    gpui::hsla(0., 0., 1., alpha)
}

fn black(alpha: f32) -> Hsla {
    gpui::hsla(0., 0., 0., alpha)
}

/// One cursor shape, rasterised to fit `width` x `height` device pixels.
fn rasterize_cursor(shape: CursorShape, width: u32, height: u32) -> Option<Arc<RenderImage>> {
    let raw = shape.resolve()?.raw;
    let tree = resvg::usvg::Tree::from_str(raw, &resvg::usvg::Options::default()).ok()?;
    let size = tree.size();
    let scale = (width as f32 / size.width()).min(height as f32 / size.height());
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height)?;
    let transform = resvg::tiny_skia::Transform::from_translate(
        (width as f32 - size.width() * scale) / 2.,
        (height as f32 - size.height() * scale) / 2.,
    )
    .pre_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    let mut buffer = image::RgbaImage::from_raw(width, height, pixmap.take())?;
    // tiny-skia hands back premultiplied RGBA and gpui's atlas takes straight
    // BGRA -- the same conversion `gpui::SvgRenderer::render_single_frame` does
    // on its own pixmap. Skipping it darkens every antialiased edge.
    for pixel in buffer.chunks_exact_mut(4) {
        gpui::swap_rgba_pa_to_bgra(pixel);
    }
    Some(Arc::new(RenderImage::new(smallvec::smallvec![
        image::Frame::new(buffer)
    ])))
}

/// The touch circle: a translucent disc with a dark outer ring, a light inner
/// ring and a faint shadow, as `create_circle_cursor` draws it.
fn circle_art() -> AnyElement {
    div()
        .size(px(CIRCLE_DISC))
        .rounded_full()
        .bg(white(0.15))
        .border_1()
        .border_color(black(0.38))
        .shadow(vec![gpui::BoxShadow {
            color: black(0.16),
            offset: gpui::point(px(0.), px(0.)),
            blur_radius: px(5.),
            spread_radius: px(0.),
            inset: false,
        }])
        .child(
            div()
                .size_full()
                .rounded_full()
                .border_1()
                .border_color(white(0.42)),
        )
        .into_any_element()
}

impl EditorWindow {
    /// The ripple colour's hex field, and the device scale the previews are
    /// rasterised for. Both need a `&mut Window`, which the sidebar's render
    /// chain does not carry, so they are settled once a frame from `render`.
    pub(crate) fn prepare_cursor_fields(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar.tab != SidebarTab::Cursor {
            return;
        }
        self.sidebar.cursor_scale = window.scale_factor();
        self.ensure_hex_input(ColorTarget::CursorRipple, window, cx);
    }

    fn selected_cursor_card(&self) -> CursorCard {
        selected_card(
            self.project.cursor.cursor_type(),
            self.recorded_cursor_family,
        )
    }

    fn cursor_preview(&self, shape: CursorShape, size: f32) -> Option<Arc<RenderImage>> {
        let scale = self.sidebar.cursor_scale.max(1.);
        let side = (size * scale).round() as u32;
        let key = (shape, side, side);
        if let Some(image) = self.sidebar.cursor_previews.borrow().get(&key) {
            return Some(image.clone());
        }
        let image = rasterize_cursor(shape, side, side)?;
        self.sidebar
            .cursor_previews
            .borrow_mut()
            .insert(key, image.clone());
        Some(image)
    }

    fn cursor_art(&self, shape: CursorShape, size: f32) -> AnyElement {
        div()
            .size(px(size))
            .flex()
            .items_center()
            .justify_center()
            .children(
                self.cursor_preview(shape, size)
                    .map(|image| img(image).size(px(size))),
            )
            .into_any_element()
    }

    /// The tile: the family's arrow (or the touch circle) centred on a plain
    /// surface. `RadioCards`' grammar for the states -- `border-gray-3
    /// bg-gray-2`, `hover:border-gray-5`, and `border-blue-8 bg-blue-3/40`
    /// plus a 1px ring (so a 2px edge) when checked.
    fn render_cursor_tile(&self, card: CursorCard, selected: bool, recorded: bool) -> AnyElement {
        let theme = self.theme;
        let art = match card {
            CursorCard::Family(family) => self.cursor_art(family.arrow(), ARROW_BOX),
            CursorCard::Circle => circle_art(),
        };

        div()
            .id(SharedString::from(format!("cursor-tile-{}", card.key())))
            .w_full()
            .h(px(TILE_HEIGHT))
            .rounded(px(TILE_RADIUS))
            .flex()
            .items_center()
            .justify_center()
            .map(|this| {
                if selected {
                    this.border_2()
                        .border_color(Hsla::from(theme.blue_8))
                        .bg(with_alpha(theme.blue_3, 0.4))
                } else {
                    this.border_1()
                        .border_color(Hsla::from(theme.gray_3))
                        .bg(Hsla::from(theme.gray_2))
                        .group_hover(CARD_GROUP, |this| {
                            this.border_color(Hsla::from(theme.gray_5))
                        })
                }
            })
            .when(recorded, |this| {
                this.tooltip(move |_window, cx| {
                    ui::Tooltip::new(&theme, "Recorded with this cursor").view(cx)
                })
            })
            .child(art)
            .into_any_element()
    }

    fn render_cursor_card(
        &self,
        card: CursorCard,
        selected: bool,
        recorded: Option<CursorFamily>,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let cursor_type = card.cursor_type();
        let is_recorded = matches!(card, CursorCard::Family(family) if recorded == Some(family));

        div()
            .id(SharedString::from(format!("cursor-card-{}", card.key())))
            .group(CARD_GROUP)
            .flex_1()
            .min_w_0()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(6.))
            .cursor_pointer()
            .child(self.render_cursor_tile(card, selected, is_recorded))
            .child(
                div()
                    .max_w_full()
                    .whitespace_nowrap()
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(px(11.))
                    .line_height(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(Hsla::from(if selected {
                        theme.gray_12
                    } else {
                        theme.gray_11
                    }))
                    .when(!selected, |this| {
                        this.group_hover(CARD_GROUP, |this| {
                            this.text_color(Hsla::from(theme.gray_12))
                        })
                    })
                    .child(card.label()),
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                // `CursorType` is not `Copy`, and the listener is an `Fn`.
                let cursor_type = cursor_type.clone();
                this.edit_project("cursor-type", window, cx, move |project| {
                    if *project.cursor.cursor_type() == cursor_type {
                        return false;
                    }
                    project.cursor.set_cursor_type(cursor_type);
                    true
                });
            }))
            .into_any_element()
    }

    /// `grid grid-cols-4 gap-2`: one row, the four cards sharing the width.
    pub(crate) fn render_cursor_style_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        let selected = self.selected_cursor_card();
        let recorded = self.recorded_cursor_family;

        div()
            .flex()
            .flex_row()
            .gap(px(CARD_GAP))
            .children(
                cursor_cards()
                    .into_iter()
                    .map(|card| self.render_cursor_card(card, selected == card, recorded, cx)),
            )
            .into_any_element()
    }

    /// "Click Ripple" and, once it is on, the ring's colour and its three
    /// shape sliders.
    pub(crate) fn render_cursor_ripple(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = self.theme;
        let ripple = &self.project.cursor.ripple;
        let enabled = ripple.enabled;
        let color = ripple.color;

        div()
            .flex()
            .flex_col()
            .child(
                ui::Field::plain(&theme, "Click Ripple")
                    .icon("icons/mouse-pointer-click.svg")
                    .value(
                        ui::Toggle::plain(&theme, "cursor-ripple", enabled)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let next = !this.project.cursor.ripple.enabled;
                                this.sidebar.cursor_ripple_open.set_open(next);
                                this.animate_collapsibles(window, cx);
                                this.edit_project("cursor-ripple", window, cx, move |project| {
                                    project.cursor.ripple.enabled = next;
                                    true
                                });
                            }))
                            .into_any_element(),
                    ),
            )
            .child(collapsible(
                &self.sidebar.cursor_ripple_open,
                div()
                    .flex()
                    .flex_col()
                    .gap(px(16.))
                    .pt(px(16.))
                    .pb(px(24.))
                    .child(
                        ui::Subfield::plain(&theme, "Color").child(self.render_rgb_input(
                            "cursor-ripple-color",
                            ColorTarget::CursorRipple,
                            color,
                            cx,
                        )),
                    )
                    .child(ui::Field::plain(&theme, "Strength").child(self.slider(
                        SliderKey::Cursor(CursorSlider::RippleStrength),
                        "%",
                        cx,
                    )))
                    .child(ui::Field::plain(&theme, "Size").child(self.slider(
                        SliderKey::Cursor(CursorSlider::RippleSize),
                        "%",
                        cx,
                    )))
                    .child(ui::Field::plain(&theme, "Duration").child(self.slider(
                        SliderKey::Cursor(CursorSlider::RippleDuration),
                        "secs",
                        cx,
                    )))
                    .into_any_element(),
            ))
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_lead_with_the_host_family() {
        let cards = cursor_cards();
        assert_eq!(cards[0], CursorCard::Family(host_cursor_family()));
        assert_eq!(cards[3], CursorCard::Circle);
        for family in [
            CursorFamily::MacOS,
            CursorFamily::MacOSTahoe,
            CursorFamily::Windows,
        ] {
            assert!(cards.contains(&CursorCard::Family(family)), "{family:?}");
        }
    }

    /// Every card writes a type that resolves back to the card it was drawn
    /// on, which is what keeps the selected ring on the card just clicked.
    #[test]
    fn every_card_round_trips_through_its_type() {
        for card in cursor_cards() {
            let written = card.cursor_type();
            assert_ne!(written, CursorType::Auto);
            assert_eq!(selected_card(&written, None), card, "{:?}", card.label());
        }
    }

    #[test]
    fn auto_follows_the_recording_then_the_host() {
        assert_eq!(
            selected_card(&CursorType::Auto, Some(CursorFamily::MacOSTahoe)),
            CursorCard::Family(CursorFamily::MacOSTahoe)
        );
        // The legacy value renders exactly as `Auto` does.
        assert_eq!(
            selected_card(&CursorType::Pointer, Some(CursorFamily::Windows)),
            CursorCard::Family(CursorFamily::Windows)
        );
        assert_eq!(
            selected_card(&CursorType::Auto, None),
            CursorCard::Family(host_cursor_family())
        );
    }

    /// Every family's arrow resolves and rasterises at the tile's box (at 1x
    /// and 2x) -- a card with a missing asset would silently draw an empty
    /// tile.
    #[test]
    fn every_arrow_rasterises() {
        for family in [
            CursorFamily::MacOS,
            CursorFamily::MacOSTahoe,
            CursorFamily::Windows,
        ] {
            let shape = family.arrow();
            for side in [ARROW_BOX as u32, (ARROW_BOX * 2.) as u32] {
                let image = rasterize_cursor(shape, side, side)
                    .unwrap_or_else(|| panic!("{shape} at {side}px"));
                let size = image.size(0);
                assert_eq!(size.width.0 as u32, side);
                assert_eq!(size.height.0 as u32, side);
                let bytes = image.as_bytes(0).expect("one frame");
                assert!(
                    bytes.chunks_exact(4).any(|pixel| pixel[3] > 0),
                    "{shape} rasterised to nothing"
                );
            }
        }
    }
}
