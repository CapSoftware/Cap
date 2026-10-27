//! Cap Glass: panes that blur, lens and tint whatever is painted beneath
//! them, with materials fitted against Apple's own glass (`glass/`, and the
//! `glass-reference` capture that feeds it).
//!
//! A pane paints itself first and its children over it, so content sits on
//! the glass, never under it. The glass samples what is already in the
//! window: on a transparent window, paint the backdrop it should show (the
//! picker paints the captured desktop) before the pane.

use std::sync::OnceLock;

use cap_glass::model::{GlassMaterial, PaneStyle};
use gpui::{Bounds, Corners, Div, ParentElement, Pixels, Styled, Window, canvas, div, px};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlassKind {
    /// Frosted: reads as a surface, for panels and toolbars.
    Regular,
    /// Barely frosted: for controls floating over busy content.
    Clear,
}

struct Presets {
    regular_light: GlassMaterial,
    regular_dark: GlassMaterial,
    clear_light: GlassMaterial,
    clear_dark: GlassMaterial,
}

fn presets() -> &'static Presets {
    static PRESETS: OnceLock<Presets> = OnceLock::new();
    PRESETS.get_or_init(|| {
        let all: serde_json::Value = serde_json::from_str(cap_glass::PRESETS_JSON)
            .expect("glass presets are valid JSON");
        let get = |name: &str| -> GlassMaterial {
            serde_json::from_value(all[name].clone()).expect("glass preset is complete")
        };
        Presets {
            regular_light: get("regular-light"),
            regular_dark: get("regular-dark"),
            clear_light: get("clear-light"),
            clear_dark: get("clear-dark"),
        }
    })
}

pub fn material(kind: GlassKind, dark: bool) -> &'static GlassMaterial {
    let presets = presets();
    match (kind, dark) {
        (GlassKind::Regular, false) => &presets.regular_light,
        (GlassKind::Regular, true) => &presets.regular_dark,
        (GlassKind::Clear, false) => &presets.clear_light,
        (GlassKind::Clear, true) => &presets.clear_dark,
    }
}

pub fn gpui_style(style: &PaneStyle) -> gpui::GlassStyle {
    gpui::GlassStyle {
        enabled: 1,
        lens_rim: style.lens_rim,
        lens_curve: style.lens_curve,
        rim_bend: style.rim_bend,
        poly: style.poly,
        opacity: style.opacity,
        line: style.line,
        line_lit: style.line_lit,
        line_width: style.line_width,
        light_x: style.light[0],
        light_y: style.light[1],
        glow: style.glow,
        glow_width: style.glow_width,
        hairline: style.hairline,
        pad: 0.,
    }
}

pub fn paint(window: &mut Window, bounds: Bounds<Pixels>, radius: f32, material: &GlassMaterial) {
    let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if width <= 0. || height <= 0. {
        return;
    }
    let style = material.resolve(width, height);
    let radius = radius.min(width / 2.).min(height / 2.);
    window.paint_glass(
        bounds,
        Corners::all(px(radius)),
        px(style.blur),
        gpui_style(&style),
    );
}

/// A rounded glass pane: a `Div` whose first child is the glass layer, so
/// everything added after it paints on the glass. `radius` is clamped to the
/// pane like CSS clamps `border-radius`.
pub fn pane(kind: GlassKind, dark: bool, radius: f32) -> Div {
    let material = *material(kind, dark);
    div().relative().rounded(px(radius)).child(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| paint(window, bounds, radius, &material),
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full(),
    )
}
