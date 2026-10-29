use crate::screenshot::mask_filter;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MaskEffect {
    Blur,
    Pixelate,
    Solid,
}

/// Every float is stored as its bit pattern so a style can be compared for
/// cache reuse without tripping over `f64`'s missing `Eq`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MaskStyle {
    pub effect: MaskEffect,
    pub level: u64,
    pub ellipse: bool,
    pub corner_radius: u64,
    pub feather: u64,
    pub invert: bool,
    pub color: [u8; 3],
    pub tint: u64,
    pub opacity: u64,
}

impl MaskStyle {
    pub fn plain(pixelate: bool, level: f64) -> Self {
        Self {
            effect: if pixelate {
                MaskEffect::Pixelate
            } else {
                MaskEffect::Blur
            },
            level: level.to_bits(),
            ellipse: false,
            corner_radius: 0_f64.to_bits(),
            feather: 0_f64.to_bits(),
            invert: false,
            color: [0, 0, 0],
            tint: 0_f64.to_bits(),
            opacity: 1_f64.to_bits(),
        }
    }

    fn get(bits: u64, fallback: f64) -> f64 {
        let value = f64::from_bits(bits);
        if value.is_finite() { value } else { fallback }
    }

    pub fn level(&self) -> f64 {
        Self::get(self.level, 1.).max(1.)
    }

    pub fn corner_radius(&self) -> f64 {
        Self::get(self.corner_radius, 0.).max(0.)
    }

    pub fn feather(&self) -> f64 {
        Self::get(self.feather, 0.).max(0.)
    }

    pub fn tint(&self) -> f64 {
        Self::get(self.tint, 0.).clamp(0., 1.)
    }

    /// A corrupt opacity falls back to fully opaque: a mask that silently
    /// vanished would leak exactly what it was drawn to hide.
    pub fn opacity(&self) -> f64 {
        Self::get(self.opacity, 1.).clamp(0., 1.)
    }

    fn shaped(&self) -> bool {
        self.ellipse
            || self.invert
            || self.corner_radius() > 0.
            || self.feather() > 0.
            || self.opacity() < 1.
    }
}

/// Signed distance from `point` to the shape's edge, negative inside.
fn shape_distance(point: (f64, f64), shape: [f64; 4], ellipse: bool, radius: f64) -> f64 {
    let [x, y, width, height] = shape;
    let half = (width / 2., height / 2.);
    if half.0 <= 0. || half.1 <= 0. {
        return f64::INFINITY;
    }
    let local = (
        (point.0 - (x + half.0)).abs(),
        (point.1 - (y + half.1)).abs(),
    );
    if ellipse {
        // Scaling the normalized radius by the short semi-axis keeps the
        // distance in pixels along that axis, which is what a feather of N
        // pixels has to mean on a circle.
        let k = ((local.0 / half.0).powi(2) + (local.1 / half.1).powi(2)).sqrt();
        return (k - 1.) * half.0.min(half.1);
    }
    let radius = radius.min(half.0).min(half.1);
    let q = (local.0 - (half.0 - radius), local.1 - (half.1 - radius));
    let outside = (q.0.max(0.).powi(2) + q.1.max(0.).powi(2)).sqrt();
    outside + q.0.max(q.1).min(0.) - radius
}

/// How much of the pixel at `point` the mask covers, in `0..=1`. Without a
/// feather the edge is a one-pixel antialiased step that still covers every
/// pixel whose centre sits inside an axis-aligned rect; with one, coverage
/// eases in over `feather` pixels inward so the mask never bleeds past its
/// own rect.
pub fn shape_coverage(
    point: (f64, f64),
    shape: [f64; 4],
    ellipse: bool,
    radius: f64,
    feather: f64,
) -> f64 {
    let distance = shape_distance(point, shape, ellipse, radius);
    if feather < 1. {
        return (0.5 - distance).clamp(0., 1.);
    }
    let t = (-distance / feather).clamp(0., 1.);
    t * t * (3. - 2. * t)
}

fn mix(channel: u8, target: u8, amount: f64) -> u8 {
    (f64::from(channel) + (f64::from(target) - f64::from(channel)) * amount).round() as u8
}

/// One mask's pixels for `region` of the frame, with the style baked in:
/// the effect, the tint, then the shape's coverage folded into alpha so the
/// result composites straight over the untouched frame. `shape` is the
/// mask's own rect in frame pixels -- equal to `region` for a normal mask,
/// and the hole cut out of `region` for an inverted one.
pub fn styled_mask(
    rgba: &[u8],
    frame_width: u32,
    frame_height: u32,
    region: (u32, u32, u32, u32),
    shape: (u32, u32, u32, u32),
    style: &MaskStyle,
) -> Option<image::RgbaImage> {
    let mut image = match style.effect {
        MaskEffect::Solid => {
            if frame_width == 0
                || frame_height == 0
                || rgba.len() < frame_width as usize * 4 * frame_height as usize
            {
                return None;
            }
            let [r, g, b] = style.color;
            image::RgbaImage::from_pixel(region.2, region.3, image::Rgba([r, g, b, 255]))
        }
        MaskEffect::Blur | MaskEffect::Pixelate => mask_filter(
            rgba,
            frame_width,
            frame_height,
            region,
            style.effect == MaskEffect::Pixelate,
            style.level(),
        )?,
    };

    let tint = style.tint();
    if style.effect != MaskEffect::Solid && tint > 0. {
        let [r, g, b] = style.color;
        for pixel in image.pixels_mut() {
            pixel.0[0] = mix(pixel.0[0], r, tint);
            pixel.0[1] = mix(pixel.0[1], g, tint);
            pixel.0[2] = mix(pixel.0[2], b, tint);
        }
    }

    if !style.shaped() {
        return Some(image);
    }

    let shape = [
        f64::from(shape.0) - f64::from(region.0),
        f64::from(shape.1) - f64::from(region.1),
        f64::from(shape.2),
        f64::from(shape.3),
    ];
    let ellipse = style.ellipse;
    let radius = style.corner_radius();
    let feather = style.feather();
    let opacity = style.opacity();
    let invert = style.invert;
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let point = (f64::from(x) + 0.5, f64::from(y) + 0.5);
        let mut coverage = shape_coverage(point, shape, ellipse, radius, feather);
        if invert {
            coverage = 1. - coverage;
        }
        let alpha = f64::from(pixel.0[3]) * coverage * opacity;
        pixel.0[3] = alpha.round().clamp(0., 255.) as u8;
    }
    Some(image)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(width: u32, height: u32) -> Vec<u8> {
        (0..width * height)
            .flat_map(|index| {
                [
                    (index * 7) as u8,
                    (index * 13) as u8,
                    (index * 3) as u8,
                    255,
                ]
            })
            .collect()
    }

    fn style(effect: MaskEffect) -> MaskStyle {
        MaskStyle {
            effect,
            ..MaskStyle::plain(false, 8.)
        }
    }

    #[test]
    fn plain_styles_match_the_unstyled_filter_byte_for_byte() {
        let rgba = frame(32, 24);
        for pixelate in [false, true] {
            let region = (3, 2, 20, 15);
            let styled = styled_mask(
                &rgba,
                32,
                24,
                region,
                region,
                &MaskStyle::plain(pixelate, 8.),
            )
            .unwrap();
            let plain = mask_filter(&rgba, 32, 24, region, pixelate, 8.).unwrap();
            assert_eq!(styled, plain);
        }
    }

    #[test]
    fn solid_redaction_ignores_the_source_pixels() {
        let rgba = frame(16, 16);
        let mut solid = style(MaskEffect::Solid);
        solid.color = [12, 34, 56];
        let image = styled_mask(&rgba, 16, 16, (2, 2, 8, 8), (2, 2, 8, 8), &solid).unwrap();
        assert!(image.pixels().all(|pixel| pixel.0 == [12, 34, 56, 255]));
        assert!(styled_mask(&rgba[..8], 16, 16, (0, 0, 4, 4), (0, 0, 4, 4), &solid).is_none());
    }

    #[test]
    fn tint_pulls_every_pixel_toward_the_colour() {
        let rgba = vec![0u8; 8 * 8 * 4]
            .chunks(4)
            .flat_map(|_| [0, 100, 200, 255])
            .collect::<Vec<_>>();
        let mut tinted = style(MaskEffect::Pixelate);
        tinted.color = [255, 255, 255];
        tinted.tint = 0.5_f64.to_bits();
        let image = styled_mask(&rgba, 8, 8, (0, 0, 8, 8), (0, 0, 8, 8), &tinted).unwrap();
        assert!(image.pixels().all(|pixel| pixel.0 == [128, 178, 228, 255]));
    }

    #[test]
    fn an_ellipse_clears_its_corners_and_keeps_its_centre() {
        let rgba = frame(40, 40);
        let mut ellipse = style(MaskEffect::Solid);
        ellipse.ellipse = true;
        let image = styled_mask(&rgba, 40, 40, (0, 0, 40, 40), (0, 0, 40, 40), &ellipse).unwrap();
        assert_eq!(image.get_pixel(0, 0).0[3], 0);
        assert_eq!(image.get_pixel(39, 39).0[3], 0);
        assert_eq!(image.get_pixel(20, 20).0[3], 255);
        assert!(image.get_pixel(20, 0).0[3] > 240);
    }

    #[test]
    fn rounded_corners_cut_only_the_corners() {
        let rgba = frame(40, 40);
        let mut rounded = style(MaskEffect::Solid);
        rounded.corner_radius = 12_f64.to_bits();
        let image = styled_mask(&rgba, 40, 40, (0, 0, 40, 40), (0, 0, 40, 40), &rounded).unwrap();
        assert_eq!(image.get_pixel(0, 0).0[3], 0);
        assert_eq!(image.get_pixel(20, 0).0[3], 255);
        assert_eq!(image.get_pixel(0, 20).0[3], 255);
        assert_eq!(image.get_pixel(20, 20).0[3], 255);
    }

    #[test]
    fn feather_fades_inward_from_the_edge() {
        let rgba = frame(40, 40);
        let mut feathered = style(MaskEffect::Solid);
        feathered.feather = 10_f64.to_bits();
        let image = styled_mask(&rgba, 40, 40, (0, 0, 40, 40), (0, 0, 40, 40), &feathered).unwrap();
        let edge = image.get_pixel(0, 20).0[3];
        let mid = image.get_pixel(5, 20).0[3];
        let inner = image.get_pixel(20, 20).0[3];
        assert!(edge < mid, "{edge} < {mid}");
        assert!(mid < inner, "{mid} < {inner}");
        assert_eq!(inner, 255);
    }

    #[test]
    fn invert_covers_everything_but_the_hole() {
        let rgba = frame(40, 40);
        let mut inverted = style(MaskEffect::Solid);
        inverted.invert = true;
        let image =
            styled_mask(&rgba, 40, 40, (0, 0, 40, 40), (10, 10, 20, 20), &inverted).unwrap();
        assert_eq!(image.dimensions(), (40, 40));
        assert_eq!(image.get_pixel(2, 2).0[3], 255);
        assert_eq!(image.get_pixel(20, 20).0[3], 0);
        assert_eq!(image.get_pixel(35, 20).0[3], 255);
    }

    #[test]
    fn opacity_scales_alpha() {
        let rgba = frame(8, 8);
        let mut faded = style(MaskEffect::Solid);
        faded.opacity = 0.5_f64.to_bits();
        let image = styled_mask(&rgba, 8, 8, (0, 0, 8, 8), (0, 0, 8, 8), &faded).unwrap();
        assert!(image.pixels().all(|pixel| pixel.0[3] == 128));
    }

    #[test]
    fn non_finite_style_values_fall_back_to_safe_defaults() {
        let mut broken = style(MaskEffect::Blur);
        broken.level = f64::NAN.to_bits();
        broken.feather = f64::INFINITY.to_bits();
        broken.opacity = f64::NAN.to_bits();
        assert_eq!(broken.level(), 1.);
        assert_eq!(broken.feather(), 0.);
        assert_eq!(broken.opacity(), 1.);
    }
}
