pub fn noise_texture_bgra(width: u32, height: u32, base_frequency: f32) -> image::RgbaImage {
    let mut rgba = image::RgbaImage::new(width.max(1), height.max(1));
    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let value = fractal_noise(x as f32 * base_frequency, y as f32 * base_frequency, 0);
        let alpha = fractal_noise(x as f32 * base_frequency, y as f32 * base_frequency, 7);
        let level = (value.clamp(0., 1.) * 255.) as u8;
        *pixel = image::Rgba([level, level, level, (alpha.clamp(0., 1.) * 255.) as u8]);
    }
    rgba
}

fn fractal_noise(x: f32, y: f32, seed: u32) -> f32 {
    fractal_noise_octaves(x, y, seed, 4)
}

pub fn fractal_noise_octaves(x: f32, y: f32, seed: u32, octaves: u32) -> f32 {
    let (mut value, mut amplitude, mut total, mut frequency) = (0., 1., 0., 1.);
    for octave in 0..octaves {
        value += amplitude * value_noise(x * frequency, y * frequency, seed + octave);
        total += amplitude;
        amplitude *= 0.5;
        frequency *= 2.;
    }
    value / total
}

fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let (sx, sy) = (fx * fx * (3. - 2. * fx), fy * fy * (3. - 2. * fy));
    let (x0, y0) = (x0 as i32, y0 as i32);
    let corner = |dx: i32, dy: i32| lattice(x0 + dx, y0 + dy, seed);
    let top = corner(0, 0) + sx * (corner(1, 0) - corner(0, 0));
    let bottom = corner(0, 1) + sx * (corner(1, 1) - corner(0, 1));
    top + sy * (bottom - top)
}

fn lattice(x: i32, y: i32, seed: u32) -> f32 {
    let mut hash = (x as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((y as u32).wrapping_mul(668_265_263))
        .wrapping_add(seed.wrapping_mul(2_246_822_519));
    hash = (hash ^ (hash >> 13)).wrapping_mul(1_274_126_177);
    f32::from((hash ^ (hash >> 16)) as u16) / 65_535.
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Filter {
    Contrast(f32),
    Saturate(f32),
    Grayscale(f32),
    Brightness(f32),
    Sepia(f32),
    HueRotate(f32),
}

#[derive(Debug, Clone, Copy)]
pub struct Overlay {
    pub angle: f32,
    pub from: [f32; 4],
    pub to: [f32; 4],
}

pub const SCENE_ANGLE: f32 = 160.;
pub const SCENE_STOPS: [(f32, [f32; 3]); 4] = [
    (
        0.00,
        [0x60 as f32 / 255., 0xa5 as f32 / 255., 0xfa as f32 / 255.],
    ),
    (
        0.35,
        [0xe2 as f32 / 255., 0xe8 as f32 / 255., 0xf0 as f32 / 255.],
    ),
    (
        0.62,
        [0xfb as f32 / 255., 0x92 as f32 / 255., 0x3c as f32 / 255.],
    ),
    (
        1.00,
        [0x1e as f32 / 255., 0x29 as f32 / 255., 0x3b as f32 / 255.],
    ),
];

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

pub fn gradient_color(position: f32, stops: &[(f32, [f32; 3])]) -> [f32; 3] {
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
        Filter::Saturate(amount) | Filter::Grayscale(amount) => {
            let amount = if matches!(filter, Filter::Grayscale(_)) {
                1. - amount
            } else {
                amount
            };
            [
                (0.213 + 0.787 * amount) * r
                    + (0.715 - 0.715 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r
                    + (0.715 + 0.285 * amount) * g
                    + (0.072 - 0.072 * amount) * b,
                (0.213 - 0.213 * amount) * r
                    + (0.715 - 0.715 * amount) * g
                    + (0.072 + 0.928 * amount) * b,
            ]
        }
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

pub fn overlay_blend(backdrop: f32, source: f32) -> f32 {
    if backdrop <= 0.5 {
        2. * backdrop * source
    } else {
        1. - 2. * (1. - backdrop) * (1. - source)
    }
}

pub fn composite_overlay(backdrop: [f32; 3], source: [f32; 4]) -> [f32; 3] {
    let alpha = source[3];
    [
        alpha * overlay_blend(backdrop[0], source[0]) + (1. - alpha) * backdrop[0],
        alpha * overlay_blend(backdrop[1], source[1]) + (1. - alpha) * backdrop[1],
        alpha * overlay_blend(backdrop[2], source[2]) + (1. - alpha) * backdrop[2],
    ]
}

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
    let peak = ((vignette * 0.75) * 1000.).round() / 1000.;
    (((distance - 0.4) / 0.6).clamp(0., 1.)) * peak
}

pub fn preset_preview_bgra(
    filter: &[Filter],
    overlay: Option<Overlay>,
    vignette: f32,
    grain: f32,
    width: u32,
    height: u32,
) -> image::RgbaImage {
    let (w, h) = (width.max(1), height.max(1));
    let (wf, hf) = (w as f32, h as f32);
    let mut rgba = image::RgbaImage::new(w, h);
    let grain_opacity = (grain * 1.2).min(1.);

    for (x, y, pixel) in rgba.enumerate_pixels_mut() {
        let (xf, yf) = (x as f32 + 0.5, y as f32 + 0.5);
        let scene = gradient_color(gradient_position(xf, yf, wf, hf, SCENE_ANGLE), &SCENE_STOPS);
        let mut color = apply_filters(scene, filter);

        if let Some(overlay) = overlay {
            let position = gradient_position(xf, yf, wf, hf, overlay.angle);
            let source = [
                overlay.from[0] + position * (overlay.to[0] - overlay.from[0]),
                overlay.from[1] + position * (overlay.to[1] - overlay.from[1]),
                overlay.from[2] + position * (overlay.to[2] - overlay.from[2]),
                overlay.from[3] + position * (overlay.to[3] - overlay.from[3]),
            ];
            color = composite_overlay(color, source);
        }

        let shade = 1. - vignette_alpha(xf, yf, wf, hf, vignette);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn noise_texture_has_the_requested_size_and_grey_channels() {
        let texture = noise_texture_bgra(13, 0, 0.9);
        assert_eq!(texture.dimensions(), (13, 1));
        for pixel in texture.pixels() {
            assert_eq!(pixel.0[0], pixel.0[1]);
            assert_eq!(pixel.0[1], pixel.0[2]);
        }
    }

    #[test]
    fn preset_preview_is_opaque_bgra_at_the_requested_size() {
        let preview = preset_preview_bgra(&[Filter::Grayscale(1.)], None, 0.32, 0.35, 21, 9);
        assert_eq!(preview.dimensions(), (21, 9));
        for pixel in preview.pixels() {
            assert_eq!(pixel.0[3], 255);
        }
    }
}
