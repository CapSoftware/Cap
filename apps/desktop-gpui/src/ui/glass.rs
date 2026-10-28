//! Cap Glass: panes that blur, lens and tint whatever is painted beneath
//! them, with materials fitted against Apple's own glass (`glass/`, and the
//! `glass-reference` capture that feeds it).
//!
//! A pane paints itself first and its children over it, so content sits on
//! the glass, never under it. The glass samples what is already in the
//! window: on a transparent window, paint the backdrop it should show (the
//! picker paints the captured desktop) before the pane.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{Arc, OnceLock},
};

use cap_glass::model::{GlassMaterial, PaneStyle};
use gpui::{
    Bounds, ContentMask, Corners, Div, Hsla, IntoElement, ParentElement, Pixels, RenderImage,
    Styled, Window, canvas, div, fill, px,
};

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
        let all: serde_json::Value =
            serde_json::from_str(cap_glass::PRESETS_JSON).expect("glass presets are valid JSON");
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
        tint_scale: style.tint.scale,
        tint_luma: style.tint.luma,
        tint_offset: style.tint.offset,
        pad: 0.,
    }
}

/// A tint for a pane, sRGB with alpha, as SwiftUI's `.tint` takes it:
/// Regular glass reads only its alpha, Clear glass its colour too.
pub type Tint = gpui::Rgba;

pub fn paint(
    window: &mut Window,
    bounds: Bounds<Pixels>,
    radius: f32,
    material: &GlassMaterial,
    tint: Option<Tint>,
) {
    let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    if width <= 0. || height <= 0. {
        return;
    }
    let mut style = material.resolve(width, height);
    if let Some(tint) = tint {
        style.tint = material.tint_matrix([tint.r, tint.g, tint.b], tint.a);
    }
    let radius = radius.min(width / 2.).min(height / 2.);
    window.paint_glass(
        bounds,
        Corners::all(px(radius)),
        px(style.blur),
        gpui_style(&style),
    );
}

/// How far past its bounds a pane's glass reads what lies beneath it: the
/// blur's reach (three sigma), the rim's lensing, and a pixel of slack.
fn sample_reach(style: &PaneStyle) -> f32 {
    style.blur * 3. + style.rim_bend.abs() + style.lens_rim + 4.
}

/// A rounded glass pane: a `Div` whose first child is the glass layer, so
/// everything added after it paints on the glass. `radius` is clamped to the
/// pane like CSS clamps `border-radius`.
pub fn pane(kind: GlassKind, dark: bool, radius: f32) -> Div {
    pane_with(kind, dark, radius, None, None, false)
}

/// [`pane`] with a tint.
pub fn pane_tinted(kind: GlassKind, dark: bool, radius: f32, tint: Tint) -> Div {
    pane_with(kind, dark, radius, None, Some(tint), false)
}

/// [`pane`] on a transparent window, reading `backdrop` instead of the
/// window's own (mostly empty) pixels, with an edge so a control holds its
/// shape over whatever the desktop shows. [`pane`] alone stays exactly the
/// system material, which the glass probe measures against.
pub fn pane_over(kind: GlassKind, dark: bool, radius: f32, backdrop: &Backdrop) -> Div {
    pane_with(kind, dark, radius, Some(backdrop.clone()), None, true)
}

fn pane_with(
    kind: GlassKind,
    dark: bool,
    radius: f32,
    backdrop: Option<Backdrop>,
    tint: Option<Tint>,
    edge: bool,
) -> Div {
    let material = *material(kind, dark);
    let (outer, inner) = edge_lines(dark);
    let pane = div().relative().rounded(px(radius)).child(
        canvas(
            |_, _, _| {},
            move |bounds, _, window, _| {
                if let Some(backdrop) = &backdrop {
                    backdrop.prepare(window, bounds, radius, &material);
                }
                paint(window, bounds, radius, &material, tint);
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full(),
    );
    if !edge {
        return pane;
    }
    // The pane's edge, so it holds its shape on any backdrop: a faint dark
    // line that shows on light content and a faint light one just inside it
    // that shows on dark. Drawn over the glass rather than as a border so the
    // glass still reaches the pane's edge.
    pane.child(
        div()
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .rounded(px(radius))
            .border_1()
            .border_color(outer),
    )
    .child(
        div()
            .absolute()
            .top(px(1.))
            .left(px(1.))
            .right(px(1.))
            .bottom(px(1.))
            .rounded(px((radius - 1.).max(0.)))
            .border_1()
            .border_color(inner),
    )
}

/// The two hairlines around a pane's edge: dark outside, light inside.
fn edge_lines(dark: bool) -> (Hsla, Hsla) {
    if dark {
        (gpui::hsla(0., 0., 0., 0.28), gpui::hsla(0., 0., 1., 0.14))
    } else {
        (gpui::hsla(0., 0., 0., 0.1), gpui::hsla(0., 0., 1., 0.45))
    }
}

/// What a transparent window's glass panes show through them: a capture of
/// the desktop beneath the window, painted under the panes before anything
/// else the window draws, so whatever the window paints over the desktop
/// (dimming, highlights) lands on it exactly as it lands on the real one.
///
/// The window cannot know where its panes go until layout, and the capture
/// has to be painted before everything else, so [`Backdrop::layer`] paints
/// under the panes where the previous frame put them, a little wider so a
/// moving pane stays covered, and asks for another frame when one moved
/// outside that.
///
/// Without a capture (none yet, or none possible) panes sit on `fallback`.
#[derive(Clone)]
pub struct Backdrop(Rc<RefCell<BackdropState>>);

struct BackdropState {
    image: Option<Arc<RenderImage>>,
    /// Where `image` goes, in window coordinates.
    image_bounds: Bounds<Pixels>,
    fallback: Hsla,
    /// What the panes asked for while painting this frame.
    asked: Vec<Bounds<Pixels>>,
    /// What the layer painted at the start of this frame.
    painted: Vec<Bounds<Pixels>>,
    /// Images replaced or dropped, for the window's atlas to free.
    retired: Vec<Arc<RenderImage>>,
}

/// Extra room around each pane's sampled region, so a pane that moves a
/// little between frames (a dragged area's controls) stays on the capture.
/// Kept small: outside a pane the capture stands in for the live desktop.
const SLACK: f32 = 24.;

impl Backdrop {
    pub fn new(fallback: Hsla) -> Self {
        Self(Rc::new(RefCell::new(BackdropState {
            image: None,
            image_bounds: Bounds::default(),
            fallback,
            asked: Vec::new(),
            painted: Vec::new(),
            retired: Vec::new(),
        })))
    }

    pub fn set_fallback(&self, fallback: Hsla) {
        self.0.borrow_mut().fallback = fallback;
    }

    pub fn has_image(&self) -> bool {
        self.0.borrow().image.is_some()
    }

    pub fn image(&self) -> Option<Arc<RenderImage>> {
        self.0.borrow().image.clone()
    }

    pub fn set_image(&self, image: Option<Arc<RenderImage>>, bounds: Bounds<Pixels>) {
        let mut state = self.0.borrow_mut();
        if let Some(old) = std::mem::replace(&mut state.image, image) {
            state.retired.push(old);
        }
        state.image_bounds = bounds;
    }

    /// The window's first child: paints the capture under last frame's panes.
    pub fn layer(&self) -> impl IntoElement {
        let backdrop = self.clone();
        canvas(
            |_, _, _| {},
            move |_, _, window, _| {
                let mut state = backdrop.0.borrow_mut();
                for image in state.retired.drain(..) {
                    let _ = window.drop_image(image);
                }
                let asked = std::mem::take(&mut state.asked);
                state.painted = asked;
                let Some(image) = state.image.clone() else {
                    return;
                };
                let image_bounds = state.image_bounds;
                for region in &state.painted {
                    let Some(visible) = clip(region.dilate(px(SLACK)), image_bounds) else {
                        continue;
                    };
                    window.with_content_mask(Some(ContentMask { bounds: visible }), |window| {
                        let _ = window.paint_image_fitted(
                            visible,
                            image_bounds,
                            Corners::default(),
                            image.clone(),
                            0,
                            false,
                        );
                    });
                }
            },
        )
        .absolute()
        .top_0()
        .left_0()
        .size_full()
    }

    /// A pane at `bounds` is about to paint its glass: record what it reads,
    /// and give it something to read if the capture is not under it.
    fn prepare(
        &self,
        window: &mut Window,
        bounds: Bounds<Pixels>,
        radius: f32,
        material: &GlassMaterial,
    ) {
        let (width, height) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
        if width <= 0. || height <= 0. {
            return;
        }
        let reach = sample_reach(&material.resolve(width, height));
        let region = bounds.dilate(px(reach));
        let mut state = self.0.borrow_mut();
        state.asked.push(region);
        let covered = state.image.is_some()
            && state
                .painted
                .iter()
                .any(|painted| contains(painted.dilate(px(SLACK)), region));
        if covered {
            return;
        }
        if state.image.is_some() {
            // Moved off last frame's capture: correct on the next one.
            window.request_animation_frame();
        }
        let radius = radius.min(width / 2.).min(height / 2.);
        window.paint_quad(fill(bounds, state.fallback).corner_radii(px(radius)));
    }
}

fn contains(outer: Bounds<Pixels>, inner: Bounds<Pixels>) -> bool {
    outer.origin.x <= inner.origin.x
        && outer.origin.y <= inner.origin.y
        && outer.bottom_right().x >= inner.bottom_right().x
        && outer.bottom_right().y >= inner.bottom_right().y
}

fn clip(region: Bounds<Pixels>, to: Bounds<Pixels>) -> Option<Bounds<Pixels>> {
    let clipped = region.intersect(&to);
    (clipped.size.width > px(0.) && clipped.size.height > px(0.)).then_some(clipped)
}
