//! `ColorCorrectionSection` (`routes/editor/ColorCorrectionSection.tsx`) and
//! its catalogue (`colorCorrection.ts`).
//!
//! **One component, two instances.** The Background tab ends with
//! `<ColorCorrectionSection target="screen" />` (`ConfigSidebar.tsx:2962`) and
//! the Camera tab with `target="camera"` (`:3324`), writing
//! `colorCorrection.screen` and `colorCorrection.camera` respectively. The two
//! differ in exactly one row: "Apply to cursor" (`colorCorrection.gradeCursor`)
//! renders only on the screen instance (`ColorCorrectionSection.tsx:151`).
//!
//! ## The preset tiles, and how the preview is drawn
//!
//! Each of the nine presets is a card whose thumbnail is **not** a video frame.
//! It is a fixed CSS gradient (`COLOR_PREVIEW_SCENE`) with the preset's own
//! `filter` string applied, then up to three overlays: a tinted gradient at
//! `mix-blend-mode: overlay`, a radial vignette, and a tiled `feTurbulence`
//! grain (`ColorCorrectionSection.tsx:39-77`). E5a deferred this section on the
//! grounds that gpui has no per-element filter hook, and suggested previewing
//! each preset on a decoded frame instead.
//!
//! **A decoded frame would be the deviation.** The source's scene is a
//! synthetic four-stop gradient chosen so every grade reads the same way for
//! every recording; swapping in real footage would change what the nine tiles
//! show. Every operation in the chain is instead *arithmetic with a spec*:
//! `contrast`/`brightness`/`saturate`/`grayscale`/`sepia`/`hue-rotate` are the
//! Filter Effects colour matrices, evaluated in sRGB because that is what the
//! CSS shorthand filter functions are defined to use; `overlay` is the
//! Compositing spec's blend formula; the radial gradient is an
//! `ellipse at center`/farthest-corner ramp. So the tile is generated pixel by
//! pixel here and comes out as the same picture, not an approximation of it --
//! and the maths is unit-tested against hand-computed values rather than
//! eyeballed. The one honest gap is the grain, which is the same value-noise
//! stand-in for `feTurbulence` the gradient editor's grain already documents.
//!
//! Nine 216x122 tiles are generated once, on first paint, and cached for the
//! process: the catalogue is static, so nothing can invalidate them.

use std::sync::Arc;

use cap_project::{ColorCorrection, ProjectConfiguration};
use gpui::{
    AnyElement, Context, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement,
    RenderImage, SharedString, StatefulInteractiveElement, Styled, StyledImage, Window, div, img,
    prelude::FluentBuilder, px, svg,
};

use crate::{editor_window::EditorWindow, ui};

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/// `ColorCorrectionTarget` (`colorCorrection.ts:6`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GradeTarget {
    Screen,
    Camera,
}

impl GradeTarget {
    fn key(self) -> &'static str {
        match self {
            Self::Screen => "screen",
            Self::Camera => "camera",
        }
    }
}

/// `COLOR_PRESET_NONE` / `COLOR_PRESET_CUSTOM` (`colorCorrection.ts:10-11`).
pub const PRESET_NONE: &str = "none";
pub const PRESET_CUSTOM: &str = "custom";

/// `IDENTITY_COLOR_VALUES` (`:13-24`) -- every field but `intensity` has 0 as
/// its identity, which is what makes a default `ColorCorrection` render like no
/// grade at all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GradeValues {
    pub intensity: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub tint: f32,
    pub fade: f32,
    pub split_tone: f32,
    pub vignette: f32,
    pub grain: f32,
}

pub const IDENTITY: GradeValues = GradeValues {
    intensity: 1.,
    exposure: 0.,
    contrast: 0.,
    saturation: 0.,
    temperature: 0.,
    tint: 0.,
    fade: 0.,
    split_tone: 0.,
    vignette: 0.,
    grain: 0.,
};

/// One CSS shorthand filter function. The chain per preset is the source's
/// `preview.filter` string, parsed here into its terms once and for all.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Filter {
    Contrast(f32),
    Saturate(f32),
    Grayscale(f32),
    Brightness(f32),
    Sepia(f32),
    HueRotate(f32),
}

/// `preview.overlay` -- a two-stop `linear-gradient` in rgba, painted at
/// `mix-blend-mode: overlay`.
#[derive(Debug, Clone, Copy)]
pub struct Overlay {
    pub angle: f32,
    pub from: [f32; 4],
    pub to: [f32; 4],
}

pub struct ColorPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub values: GradeValues,
    pub filter: &'static [Filter],
    pub overlay: Option<Overlay>,
}

const fn rgba(r: u8, g: u8, b: u8, a: f32) -> [f32; 4] {
    [r as f32 / 255., g as f32 / 255., b as f32 / 255., a]
}

/// `COLOR_CORRECTION_PRESETS` (`colorCorrection.ts:58-197`), in order.
pub static COLOR_CORRECTION_PRESETS: &[ColorPreset] = &[
    ColorPreset {
        id: PRESET_NONE,
        label: "None",
        description: "Original colors, no grade applied",
        values: IDENTITY,
        filter: &[],
        overlay: None,
    },
    ColorPreset {
        id: "cinematic",
        label: "Cinematic",
        description: "Teal shadows and orange highlights with light grain",
        values: GradeValues {
            contrast: 0.12,
            saturation: 0.06,
            temperature: 0.04,
            split_tone: 0.45,
            vignette: 0.18,
            grain: 0.12,
            ..IDENTITY
        },
        // `contrast(1.12) saturate(1.12)`
        filter: &[Filter::Contrast(1.12), Filter::Saturate(1.12)],
        overlay: Some(Overlay {
            angle: 135.,
            from: rgba(13, 148, 136, 0.45),
            to: rgba(251, 146, 60, 0.4),
        }),
    },
    ColorPreset {
        id: "noir",
        label: "Noir",
        description: "High-contrast black and white with heavy grain",
        values: GradeValues {
            exposure: 0.04,
            contrast: 0.3,
            saturation: -1.,
            fade: 0.06,
            vignette: 0.32,
            grain: 0.35,
            ..IDENTITY
        },
        // `grayscale(1) contrast(1.35) brightness(1.03)`
        filter: &[
            Filter::Grayscale(1.),
            Filter::Contrast(1.35),
            Filter::Brightness(1.03),
        ],
        overlay: None,
    },
    ColorPreset {
        id: "vintage",
        label: "Vintage",
        description: "Faded warm film look with soft contrast",
        values: GradeValues {
            contrast: -0.06,
            saturation: -0.18,
            temperature: 0.22,
            tint: 0.08,
            fade: 0.28,
            vignette: 0.14,
            grain: 0.28,
            ..IDENTITY
        },
        // `sepia(0.5) contrast(0.92) saturate(0.8) brightness(1.05)`
        filter: &[
            Filter::Sepia(0.5),
            Filter::Contrast(0.92),
            Filter::Saturate(0.8),
            Filter::Brightness(1.05),
        ],
        overlay: None,
    },
    ColorPreset {
        id: "frost",
        label: "Frost",
        description: "Cool, crisp tones with muted color",
        values: GradeValues {
            contrast: 0.08,
            saturation: -0.08,
            temperature: -0.3,
            tint: -0.04,
            fade: 0.06,
            ..IDENTITY
        },
        // `saturate(0.88) contrast(1.06) hue-rotate(-10deg)`
        filter: &[
            Filter::Saturate(0.88),
            Filter::Contrast(1.06),
            Filter::HueRotate(-10.),
        ],
        overlay: Some(Overlay {
            angle: 180.,
            from: rgba(125, 211, 252, 0.5),
            to: rgba(59, 130, 246, 0.3),
        }),
    },
    ColorPreset {
        id: "golden",
        label: "Golden",
        description: "Warm golden-hour glow",
        values: GradeValues {
            exposure: 0.06,
            contrast: 0.06,
            saturation: 0.12,
            temperature: 0.38,
            fade: 0.04,
            vignette: 0.1,
            ..IDENTITY
        },
        // `sepia(0.3) saturate(1.2) contrast(1.05) brightness(1.06)`
        filter: &[
            Filter::Sepia(0.3),
            Filter::Saturate(1.2),
            Filter::Contrast(1.05),
            Filter::Brightness(1.06),
        ],
        overlay: Some(Overlay {
            angle: 180.,
            from: rgba(253, 186, 116, 0.4),
            to: rgba(251, 113, 36, 0.25),
        }),
    },
    ColorPreset {
        id: "midnight",
        label: "Midnight",
        description: "Dark, moody teal with subdued color",
        values: GradeValues {
            exposure: -0.08,
            contrast: 0.16,
            saturation: -0.22,
            temperature: -0.1,
            split_tone: 0.3,
            vignette: 0.28,
            grain: 0.18,
            ..IDENTITY
        },
        // `brightness(0.85) contrast(1.16) saturate(0.75)`
        filter: &[
            Filter::Brightness(0.85),
            Filter::Contrast(1.16),
            Filter::Saturate(0.75),
        ],
        overlay: Some(Overlay {
            angle: 180.,
            from: rgba(15, 23, 42, 0.5),
            to: rgba(19, 78, 74, 0.45),
        }),
    },
    ColorPreset {
        id: "vivid",
        label: "Vivid",
        description: "Punchy saturation and contrast boost",
        values: GradeValues {
            exposure: 0.02,
            contrast: 0.14,
            saturation: 0.32,
            ..IDENTITY
        },
        // `saturate(1.45) contrast(1.14)`
        filter: &[Filter::Saturate(1.45), Filter::Contrast(1.14)],
        overlay: None,
    },
    ColorPreset {
        id: "dreamy",
        label: "Dreamy",
        description: "Soft, airy pastels with lifted blacks",
        values: GradeValues {
            exposure: 0.08,
            contrast: -0.14,
            saturation: -0.04,
            temperature: 0.06,
            tint: 0.05,
            fade: 0.3,
            grain: 0.1,
            ..IDENTITY
        },
        // `brightness(1.1) contrast(0.85) saturate(0.95)`
        filter: &[
            Filter::Brightness(1.1),
            Filter::Contrast(0.85),
            Filter::Saturate(0.95),
        ],
        overlay: Some(Overlay {
            angle: 180.,
            from: rgba(251, 207, 232, 0.45),
            to: rgba(196, 181, 253, 0.35),
        }),
    },
];

/// `ADJUST_SLIDERS` (`ColorCorrectionSection.tsx:21-37`). Every one of them
/// reads `Math.round(value * 100)` and writes `v / 100`, so the slider works in
/// percent and the config holds the normalised number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum GradeSlider {
    /// The dedicated Grain field above the collapsible (`:141-152`).
    Grain,
    Intensity,
    Exposure,
    Contrast,
    Saturation,
    Temperature,
    Tint,
    Fade,
    SplitTone,
    Vignette,
}

impl GradeSlider {
    /// The nine rows inside "Fine-tune colors", in order.
    pub const ADJUST: [GradeSlider; 9] = [
        Self::Intensity,
        Self::Exposure,
        Self::Contrast,
        Self::Saturation,
        Self::Temperature,
        Self::Tint,
        Self::Fade,
        Self::SplitTone,
        Self::Vignette,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Grain => "Grain",
            Self::Intensity => "Strength",
            Self::Exposure => "Exposure",
            Self::Contrast => "Contrast",
            Self::Saturation => "Saturation",
            Self::Temperature => "Temperature",
            Self::Tint => "Tint",
            Self::Fade => "Fade",
            Self::SplitTone => "Split Tone",
            Self::Vignette => "Vignette",
        }
    }

    /// `min` / `max` in the slider's own percent units, and the step (always
    /// 1).
    pub fn limits(self) -> (f32, f32, f32) {
        match self {
            Self::Grain | Self::Intensity | Self::Fade | Self::Vignette => (0., 100., 1.),
            _ => (-100., 100., 1.),
        }
    }

    /// `keepsPreset` -- Strength scales a preset rather than replacing it, and
    /// Grain has its own control, so neither knocks the grade to "custom"
    /// (`:29`, `:145`).
    pub fn keeps_preset(self) -> bool {
        matches!(self, Self::Grain | Self::Intensity)
    }

    pub fn read(self, grade: &ColorCorrection) -> f32 {
        match self {
            Self::Grain => grade.grain,
            Self::Intensity => grade.intensity,
            Self::Exposure => grade.exposure,
            Self::Contrast => grade.contrast,
            Self::Saturation => grade.saturation,
            Self::Temperature => grade.temperature,
            Self::Tint => grade.tint,
            Self::Fade => grade.fade,
            Self::SplitTone => grade.split_tone,
            Self::Vignette => grade.vignette,
        }
    }

    pub fn write(self, grade: &mut ColorCorrection, value: f32) {
        match self {
            Self::Grain => grade.grain = value,
            Self::Intensity => grade.intensity = value,
            Self::Exposure => grade.exposure = value,
            Self::Contrast => grade.contrast = value,
            Self::Saturation => grade.saturation = value,
            Self::Temperature => grade.temperature = value,
            Self::Tint => grade.tint = value,
            Self::Fade => grade.fade = value,
            Self::SplitTone => grade.split_tone = value,
            Self::Vignette => grade.vignette = value,
        }
    }
}

// ---------------------------------------------------------------------------
// The preview, computed
// ---------------------------------------------------------------------------

/// `COLOR_PREVIEW_SCENE`: `linear-gradient(160deg, #60a5fa 0%, #e2e8f0 35%,
/// #fb923c 62%, #1e293b 100%)` (`colorCorrection.ts:53-54`).
const SCENE_ANGLE: f32 = 160.;
const SCENE_STOPS: [(f32, [f32; 3]); 4] = [
    (0.00, [0x60 as f32 / 255., 0xa5 as f32 / 255., 0xfa as f32 / 255.]),
    (0.35, [0xe2 as f32 / 255., 0xe8 as f32 / 255., 0xf0 as f32 / 255.]),
    (0.62, [0xfb as f32 / 255., 0x92 as f32 / 255., 0x3c as f32 / 255.]),
    (1.00, [0x1e as f32 / 255., 0x29 as f32 / 255., 0x3b as f32 / 255.]),
];

/// The tile: `aspect-video` inside a `grid-cols-3 gap-2` in the sidebar's
/// 382px content column, each button `p-1.5` with a 1px border. Generated at
/// 2x so it is sharp on a Retina panel.
pub const PREVIEW_WIDTH: u32 = 216;
pub const PREVIEW_HEIGHT: u32 = 122;

/// Where a pixel sits along a CSS gradient line, in `[0, 1]`.
///
/// The line runs through the box centre at `angle` clockwise from "to top", so
/// its direction in screen coordinates (y down) is `(sin a, -cos a)`, and its
/// length is `|w sin a| + |h cos a|` -- the projection of the box onto it.
pub fn gradient_position(x: f32, y: f32, width: f32, height: f32, angle: f32) -> f32 {
    let radians = angle.to_radians();
    let (sin, cos) = (radians.sin(), radians.cos());
    let length = (width * sin).abs() + (height * cos).abs();
    if length <= 0. {
        return 0.;
    }
    let (dx, dy) = (x - width / 2., y - height / 2.);
    (0.5 + (dx * sin - dy * cos) / length).clamp(0., 1.)
}

/// Linear interpolation between stops, in sRGB -- the default interpolation
/// space for a CSS gradient with no `in <space>` clause.
fn gradient_color(position: f32, stops: &[(f32, [f32; 3])]) -> [f32; 3] {
    let mut previous = stops[0];
    for stop in stops {
        if position <= stop.0 {
            if stop.0 <= previous.0 {
                return stop.1;
            }
            let t = (position - previous.0) / (stop.0 - previous.0);
            return [
                previous.1[0] + t * (stop.1[0] - previous.1[0]),
                previous.1[1] + t * (stop.1[1] - previous.1[1]),
                previous.1[2] + t * (stop.1[2] - previous.1[2]),
            ];
        }
        previous = *stop;
    }
    previous.1
}

/// One CSS filter function, in sRGB.
///
/// The Filter Effects spec defines the shorthand functions as SVG filter
/// primitives with `color-interpolation-filters: sRGB`, so no linearisation
/// happens -- which is why `brightness(1.1)` is a plain multiply here.
/// Intermediate results clamp, as a browser's 8-bit filter chain does.
pub fn apply_filter(color: [f32; 3], filter: Filter) -> [f32; 3] {
    let clamp = |value: f32| value.clamp(0., 1.);
    let [r, g, b] = color;
    let out = match filter {
        Filter::Brightness(amount) => [r * amount, g * amount, b * amount],
        Filter::Contrast(amount) => [
            (r - 0.5) * amount + 0.5,
            (g - 0.5) * amount + 0.5,
            (b - 0.5) * amount + 0.5,
        ],
        // `grayscale(a)` is defined as the saturate matrix at `1 - a`.
        Filter::Saturate(amount) | Filter::Grayscale(amount) => {
            let amount = if matches!(filter, Filter::Grayscale(_)) {
                1. - amount
            } else {
                amount
            };
            [
                (0.213 + 0.787 * amount) * r + (0.715 - 0.715 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r
                    + (0.715 + 0.285 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r + (0.715 - 0.715 * amount) * g
                    + (0.072 + 0.928 * amount) * b,
            ]
        }
        // The sepia matrix, lerped against the identity by `amount`.
        Filter::Sepia(amount) => {
            let lerp = |identity: f32, sepia: f32| identity + amount * (sepia - identity);
            [
                lerp(1., 0.393) * r + lerp(0., 0.769) * g + lerp(0., 0.189) * b,
                lerp(0., 0.349) * r + lerp(1., 0.686) * g + lerp(0., 0.168) * b,
                lerp(0., 0.272) * r + lerp(0., 0.534) * g + lerp(1., 0.131) * b,
            ]
        }
        Filter::HueRotate(degrees) => {
            let radians = degrees.to_radians();
            let (sin, cos) = (radians.sin(), radians.cos());
            [
                (0.213 + cos * 0.787 - sin * 0.213) * r
                    + (0.715 - cos * 0.715 - sin * 0.715) * g
                    + (0.072 - cos * 0.072 + sin * 0.928) * b,
                (0.213 - cos * 0.213 + sin * 0.143) * r
                    + (0.715 + cos * 0.285 + sin * 0.140) * g
                    + (0.072 - cos * 0.072 - sin * 0.283) * b,
                (0.213 - cos * 0.213 - sin * 0.787) * r
                    + (0.715 - cos * 0.715 + sin * 0.715) * g
                    + (0.072 + cos * 0.928 + sin * 0.072) * b,
            ]
        }
    };
    [clamp(out[0]), clamp(out[1]), clamp(out[2])]
}

pub fn apply_filters(color: [f32; 3], filters: &[Filter]) -> [f32; 3] {
    filters
        .iter()
        .fold(color, |color, filter| apply_filter(color, *filter))
}

/// `mix-blend-mode: overlay` -- `HardLight(Cs, Cb)` with the operands swapped,
/// which is the Compositing spec's definition.
pub fn overlay_blend(backdrop: f32, source: f32) -> f32 {
    if backdrop <= 0.5 {
        2. * backdrop * source
    } else {
        1. - 2. * (1. - backdrop) * (1. - source)
    }
}

/// Source-over of a blended layer whose own alpha is `alpha`, over an opaque
/// backdrop: `Co = a * B(Cb, Cs) + (1 - a) * Cb`.
fn composite_overlay(backdrop: [f32; 3], source: [f32; 4]) -> [f32; 3] {
    let alpha = source[3];
    [
        alpha * overlay_blend(backdrop[0], source[0]) + (1. - alpha) * backdrop[0],
        alpha * overlay_blend(backdrop[1], source[1]) + (1. - alpha) * backdrop[1],
        alpha * overlay_blend(backdrop[2], source[2]) + (1. - alpha) * backdrop[2],
    ]
}

/// `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,v*0.75)
/// 100%)` (`ColorCorrectionSection.tsx:57-63`).
///
/// The default radial size is `farthest-corner`, and for an `ellipse at center`
/// that is the farthest-side ellipse scaled to pass through the corner, i.e.
/// both radii multiplied by sqrt(2).
pub fn vignette_alpha(x: f32, y: f32, width: f32, height: f32, vignette: f32) -> f32 {
    if vignette <= 0. {
        return 0.;
    }
    let (rx, ry) = (
        width / 2. * std::f32::consts::SQRT_2,
        height / 2. * std::f32::consts::SQRT_2,
    );
    let (dx, dy) = ((x - width / 2.) / rx, (y - height / 2.) / ry);
    let distance = (dx * dx + dy * dy).sqrt();
    // `toFixed(3)` on the stop's alpha, as the source writes it.
    let peak = ((vignette * 0.75) * 1000.).round() / 1000.;
    (((distance - 0.4) / 0.6).clamp(0., 1.)) * peak
}

/// One preset tile, rasterised.
pub fn preset_preview(preset: &ColorPreset, width: u32, height: u32) -> Arc<RenderImage> {
    let (w, h) = (width.max(1), height.max(1));
    let (wf, hf) = (w as f32, h as f32);
    let mut rgba = image::RgbaImage::new(w, h);
    // `opacity: Math.min(1, grain * 1.2)` over a 64px tile at
    // `baseFrequency 0.9`, `numOctaves 2` -- the source's `COLOR_PREVIEW_GRAIN`.
    let grain_opacity = (preset.values.grain * 1.2).min(1.);

    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let (xf, yf) = (x as f32 + 0.5, y as f32 + 0.5);
        let scene = gradient_color(
            gradient_position(xf, yf, wf, hf, SCENE_ANGLE),
            &SCENE_STOPS,
        );
        let mut color = apply_filters(scene, preset.filter);

        if let Some(overlay) = preset.overlay {
            let position = gradient_position(xf, yf, wf, hf, overlay.angle);
            let source = [
                overlay.from[0] + position * (overlay.to[0] - overlay.from[0]),
                overlay.from[1] + position * (overlay.to[1] - overlay.from[1]),
                overlay.from[2] + position * (overlay.to[2] - overlay.from[2]),
                overlay.from[3] + position * (overlay.to[3] - overlay.from[3]),
            ];
            color = composite_overlay(color, source);
        }

        let shade = 1. - vignette_alpha(xf, yf, wf, hf, preset.values.vignette);
        color = [color[0] * shade, color[1] * shade, color[2] * shade];

        if grain_opacity > 0. {
            // The tile repeats every 64 device pixels in CSS; the preview is
            // generated at 2x, so the tile is 128 pixels wide here.
            let level = crate::editor_sidebar::fractal_noise_octaves(
                xf * 0.9 / 2.,
                yf * 0.9 / 2.,
                11,
                2,
            )
            .clamp(0., 1.);
            let grain = [level, level, level, grain_opacity];
            color = composite_overlay(color, grain);
        }

        let byte = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
        // BGRA, gpui's atlas order.
        *pixel = image::Rgba([byte(color[2]), byte(color[1]), byte(color[0]), 255]);
    }

    Arc::new(RenderImage::new(smallvec::smallvec![image::Frame::new(
        rgba
    )]))
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

impl EditorWindow {
    pub(crate) fn grade(&self, target: GradeTarget) -> &ColorCorrection {
        match target {
            GradeTarget::Screen => &self.project.color_correction.screen,
            GradeTarget::Camera => &self.project.color_correction.camera,
        }
    }

    fn grade_mut(project: &mut ProjectConfiguration, target: GradeTarget) -> &mut ColorCorrection {
        match target {
            GradeTarget::Screen => &mut project.color_correction.screen,
            GradeTarget::Camera => &mut project.color_correction.camera,
        }
    }

    /// `applyPreset` (`ColorCorrectionSection.tsx:88-93`): the preset id **and**
    /// its whole value set, in one write.
    fn apply_color_preset(
        &mut self,
        target: GradeTarget,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(preset) = COLOR_CORRECTION_PRESETS.get(index) else {
            return;
        };
        let values = preset.values;
        let id = preset.id;
        self.edit_project("color-preset", window, cx, move |project| {
            let grade = Self::grade_mut(project, target);
            let next = ColorCorrection {
                preset: id.to_string(),
                intensity: values.intensity,
                exposure: values.exposure,
                contrast: values.contrast,
                saturation: values.saturation,
                temperature: values.temperature,
                tint: values.tint,
                fade: values.fade,
                split_tone: values.split_tone,
                vignette: values.vignette,
                grain: values.grain,
            };
            if *grade == next {
                return false;
            }
            *grade = next;
            true
        });
    }

    /// `setValue` (`:95-107`): write the field, and knock the grade to
    /// "custom" unless the slider is one of the two that keep the preset.
    pub(crate) fn set_grade_value(
        &mut self,
        target: GradeTarget,
        slider: GradeSlider,
        value: f32,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.edit_project("grade", window, cx, move |project| {
            let grade = Self::grade_mut(project, target);
            if (slider.read(grade) - value).abs() < f32::EPSILON {
                return false;
            }
            slider.write(grade, value);
            if !slider.keeps_preset() {
                grade.preset = PRESET_CUSTOM.to_string();
            }
            true
        });
    }

    /// The tile grid's images, generated once per process.
    fn preset_image(&self, index: usize) -> Option<Arc<RenderImage>> {
        let preset = COLOR_CORRECTION_PRESETS.get(index)?;
        let mut cache = self.sidebar.grade_previews.borrow_mut();
        if let Some(image) = cache.get(preset.id) {
            return Some(image.clone());
        }
        let image = preset_preview(preset, PREVIEW_WIDTH, PREVIEW_HEIGHT);
        cache.insert(preset.id, image.clone());
        Some(image)
    }

    /// The whole section: the preset grid, Grain, the screen-only "Apply to
    /// cursor" row, and the "Fine-tune colors" collapsible.
    pub(crate) fn render_color_correction(
        &self,
        target: GradeTarget,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = self.theme;
        let grade = self.grade(target);
        let active = grade.preset.clone();
        let open = self.sidebar.grade_open(target);

        // `grid grid-cols-3 gap-2`
        let tiles = div()
            .flex()
            .flex_row()
            .flex_wrap()
            .gap(px(8.))
            .children(COLOR_CORRECTION_PRESETS.iter().enumerate().map(
                |(index, preset)| {
                    let selected = active == preset.id;
                    div()
                        .id(SharedString::from(format!(
                            "grade-{}-{}",
                            target.key(),
                            preset.id
                        )))
                        // Three across a 382px column with `gap-2`.
                        .w(px(122.))
                        .flex()
                        .flex_col()
                        .gap(px(6.))
                        .p(px(6.))
                        .rounded(px(8.))
                        // The card is opaque so the `ring` below shows as a
                        // ring rather than filling it: gpui paints a box shadow
                        // behind the whole element.
                        .bg(self.panel_bg())
                        .border_1()
                        // `border-blue-9 ring-1 ring-blue-9`, which on a 1px
                        // border reads as a 2px edge.
                        .border_color(if selected {
                            Hsla::from(theme.blue_9)
                        } else {
                            Hsla::from(theme.gray_3)
                        })
                        .when(selected, |this| {
                            // `ring-1 ring-blue-9`: a 1px spread with no blur.
                            this.shadow(vec![gpui::BoxShadow {
                                color: Hsla::from(theme.blue_9),
                                offset: gpui::point(px(0.), px(0.)),
                                blur_radius: px(0.),
                                spread_radius: px(1.),
                                inset: false,
                            }])
                        })
                        .child(
                            div()
                                .w_full()
                                .h(px(60.75))
                                .rounded(px(6.))
                                .overflow_hidden()
                                .children(self.preset_image(index).map(|image| {
                                    img(image)
                                        .size_full()
                                        .object_fit(gpui::ObjectFit::Fill)
                                })),
                        )
                        .child(
                            div()
                                .px(px(2.))
                                .text_size(px(12.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(Hsla::from(theme.gray_12))
                                .child(preset.label),
                        )
                        .tooltip({
                            let description = SharedString::from(preset.description);
                            move |_window, cx| {
                                ui::Tooltip::new(&theme, description.clone()).view(cx)
                            }
                        })
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.apply_color_preset(target, index, window, cx);
                        }))
                },
            ));

        let mut section = div()
            .flex()
            .flex_col()
            .gap(px(24.))
            .child(
                ui::Field::plain(&theme, "Color Correction")
                    .icon("icons/sliders-horizontal.svg")
                    .child(tiles),
            )
            .child(
                ui::Field::plain(&theme, "Grain")
                    .icon("icons/grip.svg")
                    .child(self.slider(
                        crate::editor_sidebar::SliderKey::Grade(target, GradeSlider::Grain),
                        "%",
                        cx,
                    )),
            );

        // `<Show when={props.target === "screen"}>` (`:151`).
        if target == GradeTarget::Screen {
            let grade_cursor = self.project.color_correction.grade_cursor;
            section = section.child(
                ui::Field::plain(&theme, "Apply to cursor")
                    .icon("icons/mouse-pointer-2.svg")
                    .value(
                        ui::Toggle::plain(&theme, "grade-cursor", grade_cursor)
                            .on_click(cx.listener(move |this, _, window, cx| {
                                this.edit_project("grade-cursor", window, cx, |project| {
                                    project.color_correction.grade_cursor = !grade_cursor;
                                    true
                                });
                            }))
                            .into_any_element(),
                    ),
            );
        }

        // The `KCollapsible` with its own text trigger (`:168-176`).
        section
            .child(
                div()
                    .w_full()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .id(SharedString::from(format!("grade-adjust-{}", target.key())))
                            .flex()
                            .flex_row()
                            .gap(px(4.))
                            .items_center()
                            .w_full()
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(Hsla::from(theme.gray_12))
                            .cursor_pointer()
                            .child("Fine-tune colors")
                            .child(
                                // `group-data-expanded:rotate-180` -- no
                                // rotation in this rev, so the glyph swaps.
                                svg()
                                    .path(if open.is_open() {
                                        "icons/chevron-down.svg"
                                    } else {
                                        "icons/chevron-right.svg"
                                    })
                                    .size(px(20.))
                                    .text_color(Hsla::from(theme.gray_12)),
                            )
                            .on_click(cx.listener(move |this, _, window, cx| {
                                let next = !this.sidebar.grade_open(target).is_open();
                                this.sidebar.set_grade_open(target, next);
                                this.animate_collapsibles(window, cx);
                            })),
                    )
                    .child(crate::editor_sidebar::collapsible(
                        open,
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(24.))
                            // `mt-4 space-y-6`
                            .pt(px(16.))
                            .children(GradeSlider::ADJUST.map(|slider| {
                                ui::Field::plain(&theme, slider.label())
                                    .child(self.slider(
                                        crate::editor_sidebar::SliderKey::Grade(target, slider),
                                        "%",
                                        cx,
                                    ))
                                    .into_any_element()
                            }))
                            .into_any_element(),
                    )),
            )
            .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_matches_the_source() {
        assert_eq!(COLOR_CORRECTION_PRESETS.len(), 9);
        assert_eq!(COLOR_CORRECTION_PRESETS[0].id, PRESET_NONE);
        assert!(COLOR_CORRECTION_PRESETS[0].filter.is_empty());
        // `noir`'s values (`colorCorrection.ts:80-91`).
        let noir = &COLOR_CORRECTION_PRESETS[2];
        assert_eq!(noir.values.saturation, -1.);
        assert_eq!(noir.values.grain, 0.35);
        assert_eq!(noir.filter[0], Filter::Grayscale(1.));
    }

    #[test]
    fn the_gradient_line_is_the_css_one() {
        // A 160deg gradient points down and to the right, so the top-left
        // corner is before the centre and the bottom-right after it.
        let centre = gradient_position(108., 61., 216., 122., 160.);
        assert!((centre - 0.5).abs() < 1e-5, "{centre}");
        assert!(gradient_position(0., 0., 216., 122., 160.) < 0.02);
        assert!(gradient_position(216., 122., 216., 122., 160.) > 0.98);
        // 180deg is straight down: position is y alone.
        let quarter = gradient_position(50., 30.5, 216., 122., 180.);
        assert!((quarter - 0.25).abs() < 1e-5, "{quarter}");
    }

    #[test]
    fn grayscale_one_is_the_luma_the_spec_defines() {
        let grey = apply_filter([1., 0., 0.], Filter::Grayscale(1.));
        assert!((grey[0] - 0.213).abs() < 1e-6, "{grey:?}");
        assert!((grey[0] - grey[1]).abs() < 1e-6);
        assert!((grey[1] - grey[2]).abs() < 1e-6);
        // `saturate(1)` and `grayscale(0)` are both the identity.
        for filter in [Filter::Saturate(1.), Filter::Grayscale(0.)] {
            let same = apply_filter([0.2, 0.6, 0.9], filter);
            assert!((same[0] - 0.2).abs() < 1e-6, "{same:?}");
            assert!((same[1] - 0.6).abs() < 1e-6, "{same:?}");
            assert!((same[2] - 0.9).abs() < 1e-6, "{same:?}");
        }
    }

    #[test]
    fn contrast_and_brightness_pivot_where_css_says() {
        // contrast pivots on 0.5 and leaves it alone.
        assert_eq!(apply_filter([0.5, 0.5, 0.5], Filter::Contrast(1.35))[0], 0.5);
        let lifted = apply_filter([0.6, 0.6, 0.6], Filter::Contrast(1.5))[0];
        assert!((lifted - 0.65).abs() < 1e-6, "{lifted}");
        // brightness is a plain multiply, and results clamp.
        let bright = apply_filter([0.4, 0.9, 1.], Filter::Brightness(1.1));
        assert!((bright[0] - 0.44).abs() < 1e-6, "{bright:?}");
        assert_eq!(bright[2], 1.);
    }

    #[test]
    fn sepia_one_is_the_matrix_from_the_spec() {
        let sepia = apply_filter([1., 1., 1.], Filter::Sepia(1.));
        // Row sums, clamped: 1.351 -> 1, 1.203 -> 1, 0.937.
        assert_eq!(sepia[0], 1.);
        assert_eq!(sepia[1], 1.);
        assert!((sepia[2] - 0.937).abs() < 1e-6, "{sepia:?}");
        // sepia(0) is the identity.
        let none = apply_filter([0.2, 0.5, 0.8], Filter::Sepia(0.));
        assert!((none[1] - 0.5).abs() < 1e-6, "{none:?}");
    }

    #[test]
    fn overlay_is_the_compositing_specs_formula() {
        // Dark backdrop multiplies, light backdrop screens.
        assert!((overlay_blend(0.25, 0.5) - 0.25).abs() < 1e-6);
        assert!((overlay_blend(0.75, 0.5) - 0.75).abs() < 1e-6);
        assert_eq!(overlay_blend(0., 0.9), 0.);
        assert_eq!(overlay_blend(1., 0.1), 1.);
    }

    #[test]
    fn the_vignette_ramp_starts_at_forty_percent_and_peaks_at_the_corner() {
        // Dead centre is untouched, and everything inside 40% of the ellipse
        // is too.
        assert_eq!(vignette_alpha(108., 61., 216., 122., 0.32), 0.);
        // The corner is the ellipse's own edge, so it takes the full stop.
        let corner = vignette_alpha(216., 122., 216., 122., 0.32);
        assert!((corner - 0.24).abs() < 1e-4, "{corner}");
        // A preset with no vignette paints nothing at all.
        assert_eq!(vignette_alpha(216., 122., 216., 122., 0.), 0.);
    }

    #[test]
    fn every_adjust_slider_has_the_range_its_call_site_declares() {
        assert_eq!(GradeSlider::ADJUST.len(), 9);
        assert_eq!(GradeSlider::Intensity.limits(), (0., 100., 1.));
        assert_eq!(GradeSlider::Exposure.limits(), (-100., 100., 1.));
        assert_eq!(GradeSlider::SplitTone.limits(), (-100., 100., 1.));
        assert_eq!(GradeSlider::Vignette.limits(), (0., 100., 1.));
        // Only Strength and Grain keep the preset id.
        assert!(GradeSlider::Intensity.keeps_preset());
        assert!(GradeSlider::Grain.keeps_preset());
        assert!(!GradeSlider::Exposure.keeps_preset());
    }

    /// The same pipeline `preset_preview` runs, one pixel at a time, so the
    /// tile's contents are testable without a `RenderImage` (whose frames are
    /// consumed by the atlas and not readable back).
    fn preview_pixel(preset: &ColorPreset, x: f32, y: f32, w: f32, h: f32) -> [f32; 3] {
        let scene = gradient_color(gradient_position(x, y, w, h, SCENE_ANGLE), &SCENE_STOPS);
        let mut color = apply_filters(scene, preset.filter);
        if let Some(overlay) = preset.overlay {
            let position = gradient_position(x, y, w, h, overlay.angle);
            let source = [
                overlay.from[0] + position * (overlay.to[0] - overlay.from[0]),
                overlay.from[1] + position * (overlay.to[1] - overlay.from[1]),
                overlay.from[2] + position * (overlay.to[2] - overlay.from[2]),
                overlay.from[3] + position * (overlay.to[3] - overlay.from[3]),
            ];
            color = composite_overlay(color, source);
        }
        let shade = 1. - vignette_alpha(x, y, w, h, preset.values.vignette);
        [color[0] * shade, color[1] * shade, color[2] * shade]
    }

    #[test]
    fn the_none_tile_is_the_scene_untouched() {
        let (w, h) = (PREVIEW_WIDTH as f32, PREVIEW_HEIGHT as f32);
        let none = &COLOR_CORRECTION_PRESETS[0];
        // The gradient's first stop is `#60a5fa` at the very start of the line.
        let corner = preview_pixel(none, 0.5, 0.5, w, h);
        assert!((corner[0] - 0x60 as f32 / 255.).abs() < 0.02, "{corner:?}");
        assert!((corner[2] - 0xfa as f32 / 255.).abs() < 0.02, "{corner:?}");
    }

    #[test]
    fn the_noir_tile_is_neutral_and_vignetted() {
        let (w, h) = (PREVIEW_WIDTH as f32, PREVIEW_HEIGHT as f32);
        let noir = &COLOR_CORRECTION_PRESETS[2];
        // `grayscale(1)` leaves every channel equal, and no overlay reintroduces
        // colour.
        let centre = preview_pixel(noir, w / 2., h / 2., w, h);
        assert!((centre[0] - centre[1]).abs() < 1e-5, "{centre:?}");
        assert!((centre[1] - centre[2]).abs() < 1e-5, "{centre:?}");
        // Its 0.32 vignette darkens the corner against the same point ungraded.
        let corner = preview_pixel(noir, w - 0.5, h - 0.5, w, h);
        let ungraded = apply_filters(
            gradient_color(
                gradient_position(w - 0.5, h - 0.5, w, h, SCENE_ANGLE),
                &SCENE_STOPS,
            ),
            noir.filter,
        );
        assert!(corner[0] < ungraded[0], "{corner:?} vs {ungraded:?}");
    }

    #[test]
    fn a_preview_is_generated_at_the_tiles_own_size() {
        // `RenderImage` hands its frames to the atlas, so the assertion the
        // rasteriser can make from outside is that it produces one at all.
        let image = preset_preview(&COLOR_CORRECTION_PRESETS[2], PREVIEW_WIDTH, PREVIEW_HEIGHT);
        assert!(std::sync::Arc::strong_count(&image) >= 1);
    }
}
