#[path = "../../../src/texture.rs"]
pub mod texture;

pub mod reference;

use texture::{Filter, Overlay};

pub struct Preset<'a> {
    pub name: &'static str,
    pub filters: &'a [Filter],
    pub overlay: Option<Overlay>,
    pub vignette: f32,
    pub grain: f32,
}

const fn overlay(
    angle: f32,
    from: [u8; 3],
    from_alpha: f32,
    to: [u8; 3],
    to_alpha: f32,
) -> Option<Overlay> {
    Some(Overlay {
        angle,
        from: [
            from[0] as f32 / 255.,
            from[1] as f32 / 255.,
            from[2] as f32 / 255.,
            from_alpha,
        ],
        to: [
            to[0] as f32 / 255.,
            to[1] as f32 / 255.,
            to[2] as f32 / 255.,
            to_alpha,
        ],
    })
}

pub const PRESETS: &[Preset<'static>] = &[
    Preset {
        name: "none",
        filters: &[],
        overlay: None,
        vignette: 0.,
        grain: 0.,
    },
    Preset {
        name: "cinematic",
        filters: &[Filter::Contrast(1.12), Filter::Saturate(1.12)],
        overlay: overlay(135., [13, 148, 136], 0.45, [251, 146, 60], 0.4),
        vignette: 0.18,
        grain: 0.12,
    },
    Preset {
        name: "noir",
        filters: &[
            Filter::Grayscale(1.),
            Filter::Contrast(1.35),
            Filter::Brightness(1.03),
        ],
        overlay: None,
        vignette: 0.32,
        grain: 0.35,
    },
    Preset {
        name: "vintage",
        filters: &[
            Filter::Sepia(0.5),
            Filter::Contrast(0.92),
            Filter::Saturate(0.8),
            Filter::Brightness(1.05),
        ],
        overlay: None,
        vignette: 0.14,
        grain: 0.28,
    },
    Preset {
        name: "frost",
        filters: &[
            Filter::Saturate(0.88),
            Filter::Contrast(1.06),
            Filter::HueRotate(-10.),
        ],
        overlay: overlay(180., [125, 211, 252], 0.5, [59, 130, 246], 0.3),
        vignette: 0.,
        grain: 0.,
    },
    Preset {
        name: "golden",
        filters: &[
            Filter::Sepia(0.3),
            Filter::Saturate(1.2),
            Filter::Contrast(1.05),
            Filter::Brightness(1.06),
        ],
        overlay: overlay(180., [253, 186, 116], 0.4, [251, 113, 36], 0.25),
        vignette: 0.1,
        grain: 0.,
    },
    Preset {
        name: "midnight",
        filters: &[
            Filter::Brightness(0.85),
            Filter::Contrast(1.16),
            Filter::Saturate(0.75),
        ],
        overlay: overlay(180., [15, 23, 42], 0.5, [19, 78, 74], 0.45),
        vignette: 0.28,
        grain: 0.18,
    },
    Preset {
        name: "vivid",
        filters: &[Filter::Saturate(1.45), Filter::Contrast(1.14)],
        overlay: None,
        vignette: 0.,
        grain: 0.,
    },
    Preset {
        name: "dreamy",
        filters: &[
            Filter::Brightness(1.1),
            Filter::Contrast(0.85),
            Filter::Saturate(0.95),
        ],
        overlay: overlay(180., [251, 207, 232], 0.45, [196, 181, 253], 0.35),
        vignette: 0.,
        grain: 0.1,
    },
];

pub fn reference_preview(preset: &Preset<'_>, width: u32, height: u32) -> image::RgbaImage {
    use reference::apply_filters;
    use texture::*;

    let (w, h) = (width.max(1), height.max(1));
    let (wf, hf) = (w as f32, h as f32);
    let mut rgba = image::RgbaImage::new(w, h);
    let grain_opacity = (preset.grain * 1.2).min(1.);

    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let (xf, yf) = (x as f32 + 0.5, y as f32 + 0.5);
        let scene = gradient_color(gradient_position(xf, yf, wf, hf, SCENE_ANGLE), &SCENE_STOPS);
        let mut color = apply_filters(scene, preset.filters);

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

        let shade = 1. - vignette_alpha(xf, yf, wf, hf, preset.vignette);
        color = [color[0] * shade, color[1] * shade, color[2] * shade];

        if grain_opacity > 0. {
            let level = fractal_noise_octaves(xf * 0.9 / 2., yf * 0.9 / 2., 11, 2).clamp(0., 1.);
            color = composite_overlay(color, [level, level, level, grain_opacity]);
        }

        let byte = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
        *pixel = image::Rgba([byte(color[2]), byte(color[1]), byte(color[0]), 255]);
    }

    rgba
}

pub fn candidate_preview(preset: &Preset<'_>, width: u32, height: u32) -> image::RgbaImage {
    texture::preset_preview_bgra(
        preset.filters,
        preset.overlay,
        preset.vignette,
        preset.grain,
        width,
        height,
    )
}
