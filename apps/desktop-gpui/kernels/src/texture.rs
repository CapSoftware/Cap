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

#[derive(Debug, Clone, Copy)]
pub struct GradientPlan {
    sin: f32,
    cos: f32,
    length: f32,
    half_width: f32,
    half_height: f32,
}

impl GradientPlan {
    #[inline]
    pub fn new(width: f32, height: f32, angle: f32) -> Self {
        let radians = angle.to_radians();
        let (sin, cos) = (radians.sin(), radians.cos());
        let length = (width * sin).abs() + (height * cos).abs();
        Self {
            sin,
            cos,
            length,
            half_width: width / 2.,
            half_height: height / 2.,
        }
    }

    #[inline(always)]
    pub fn position(&self, x: f32, y: f32) -> f32 {
        if self.length <= 0. {
            return 0.;
        }
        let (dx, dy) = (x - self.half_width, y - self.half_height);
        (0.5 + (dx * self.sin - dy * self.cos) / self.length).clamp(0., 1.)
    }

    #[inline(always)]
    pub fn position_with_dy_cos(&self, x: f32, dy_cos: f32) -> f32 {
        if self.length <= 0. {
            return 0.;
        }
        let dx = x - self.half_width;
        (0.5 + (dx * self.sin - dy_cos) / self.length).clamp(0., 1.)
    }

    #[inline(always)]
    pub fn row_dy_cos(&self, y: f32) -> f32 {
        (y - self.half_height) * self.cos
    }
}

pub fn gradient_position(x: f32, y: f32, width: f32, height: f32, angle: f32) -> f32 {
    GradientPlan::new(width, height, angle).position(x, y)
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
    let inv_alpha = 1. - alpha;
    [
        alpha * overlay_blend(backdrop[0], source[0]) + inv_alpha * backdrop[0],
        alpha * overlay_blend(backdrop[1], source[1]) + inv_alpha * backdrop[1],
        alpha * overlay_blend(backdrop[2], source[2]) + inv_alpha * backdrop[2],
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

#[derive(Debug, Clone, Copy)]
enum PreparedFilter {
    Brightness(f32),
    Contrast(f32),
    Matrix([[f32; 3]; 3]),
}

impl PreparedFilter {
    #[inline]
    fn from_filter(filter: Filter) -> Self {
        match filter {
            Filter::Brightness(amount) => PreparedFilter::Brightness(amount),
            Filter::Contrast(amount) => PreparedFilter::Contrast(amount),
            Filter::Saturate(amount) | Filter::Grayscale(amount) => {
                let amount = if matches!(filter, Filter::Grayscale(_)) {
                    1. - amount
                } else {
                    amount
                };
                PreparedFilter::Matrix([
                    [
                        0.213 + 0.787 * amount,
                        0.715 - 0.715 * amount,
                        0.072 - 0.072 * amount,
                    ],
                    [
                        0.213 - 0.213 * amount,
                        0.715 + 0.285 * amount,
                        0.072 - 0.072 * amount,
                    ],
                    [
                        0.213 - 0.213 * amount,
                        0.715 - 0.715 * amount,
                        0.072 + 0.928 * amount,
                    ],
                ])
            }
            Filter::Sepia(amount) => {
                let lerp = |identity: f32, sepia: f32| identity + amount * (sepia - identity);
                PreparedFilter::Matrix([
                    [lerp(1., 0.393), lerp(0., 0.769), lerp(0., 0.189)],
                    [lerp(0., 0.349), lerp(1., 0.686), lerp(0., 0.168)],
                    [lerp(0., 0.272), lerp(0., 0.534), lerp(1., 0.131)],
                ])
            }
            Filter::HueRotate(degrees) => {
                let radians = degrees.to_radians();
                let (sin, cos) = (radians.sin(), radians.cos());
                PreparedFilter::Matrix([
                    [
                        0.213 + cos * 0.787 - sin * 0.213,
                        0.715 - cos * 0.715 - sin * 0.715,
                        0.072 - cos * 0.072 + sin * 0.928,
                    ],
                    [
                        0.213 - cos * 0.213 + sin * 0.143,
                        0.715 + cos * 0.285 + sin * 0.140,
                        0.072 - cos * 0.072 - sin * 0.283,
                    ],
                    [
                        0.213 - cos * 0.213 - sin * 0.787,
                        0.715 - cos * 0.715 + sin * 0.715,
                        0.072 + cos * 0.928 + sin * 0.072,
                    ],
                ])
            }
        }
    }

    #[inline(always)]
    fn apply(&self, color: [f32; 3]) -> [f32; 3] {
        let clamp = |value: f32| value.clamp(0., 1.);
        let [r, g, b] = color;
        let out = match self {
            PreparedFilter::Brightness(amount) => [r * amount, g * amount, b * amount],
            PreparedFilter::Contrast(amount) => [
                (r - 0.5) * amount + 0.5,
                (g - 0.5) * amount + 0.5,
                (b - 0.5) * amount + 0.5,
            ],
            PreparedFilter::Matrix(m) => [
                m[0][0] * r + m[0][1] * g + m[0][2] * b,
                m[1][0] * r + m[1][1] * g + m[1][2] * b,
                m[2][0] * r + m[2][1] * g + m[2][2] * b,
            ],
        };
        [clamp(out[0]), clamp(out[1]), clamp(out[2])]
    }
}

#[derive(Debug, Clone, Copy)]
struct OverlayPlan {
    gradient: GradientPlan,
    from: [f32; 4],
    delta: [f32; 4],
}

impl OverlayPlan {
    #[inline]
    fn new(width: f32, height: f32, overlay: Overlay) -> Self {
        Self {
            gradient: GradientPlan::new(width, height, overlay.angle),
            from: overlay.from,
            delta: [
                overlay.to[0] - overlay.from[0],
                overlay.to[1] - overlay.from[1],
                overlay.to[2] - overlay.from[2],
                overlay.to[3] - overlay.from[3],
            ],
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct VignettePlan {
    half_width: f32,
    half_height: f32,
    rx: f32,
    ry: f32,
    peak: f32,
}

impl VignettePlan {
    #[inline]
    fn new(width: f32, height: f32, vignette: f32) -> Option<Self> {
        if vignette <= 0. {
            return None;
        }
        let half_width = width / 2.;
        let half_height = height / 2.;
        let rx = half_width * std::f32::consts::SQRT_2;
        let ry = half_height * std::f32::consts::SQRT_2;
        let peak = ((vignette * 0.75) * 1000.).round() / 1000.;
        Some(Self {
            half_width,
            half_height,
            rx,
            ry,
            peak,
        })
    }

    #[inline(always)]
    fn row_dy(&self, yf: f32) -> f32 {
        (yf - self.half_height) / self.ry
    }
}

#[derive(Debug, Clone, Copy)]
struct GrainOctavePlan {
    sy: f32,
    y_hash0: u32,
    y_hash1: u32,
}

#[derive(Debug, Clone, Copy)]
struct GrainRowPlan {
    oct0: GrainOctavePlan,
    oct1: GrainOctavePlan,
}

#[inline(always)]
fn lattice_precalc(x: i32, y_hash: u32) -> f32 {
    let mut hash = (x as u32).wrapping_mul(374_761_393).wrapping_add(y_hash);
    hash = (hash ^ (hash >> 13)).wrapping_mul(1_274_126_177);
    f32::from((hash ^ (hash >> 16)) as u16) / 65_535.
}

#[inline(always)]
fn value_noise_precalc(x: f32, oct: &GrainOctavePlan) -> f32 {
    let x0 = x.floor();
    let fx = x - x0;
    let sx = fx * fx * (3. - 2. * fx);
    let x0 = x0 as i32;
    let corner00 = lattice_precalc(x0, oct.y_hash0);
    let corner10 = lattice_precalc(x0 + 1, oct.y_hash0);
    let corner01 = lattice_precalc(x0, oct.y_hash1);
    let corner11 = lattice_precalc(x0 + 1, oct.y_hash1);
    let top = corner00 + sx * (corner10 - corner00);
    let bottom = corner01 + sx * (corner11 - corner01);
    top + oct.sy * (bottom - top)
}

#[inline(always)]
fn grain_octave_row(yf: f32, freq: f32, seed: u32) -> GrainOctavePlan {
    let y = yf * freq;
    let y0 = y.floor();
    let fy = y - y0;
    let sy = fy * fy * (3. - 2. * fy);
    let y0 = y0 as i32;
    let seed_term = seed.wrapping_mul(2_246_822_519);
    let y_hash0 = (y0 as u32).wrapping_mul(668_265_263).wrapping_add(seed_term);
    let y_hash1 = ((y0 + 1) as u32).wrapping_mul(668_265_263).wrapping_add(seed_term);
    GrainOctavePlan {
        sy,
        y_hash0,
        y_hash1,
    }
}

#[inline(always)]
fn grain_row_plan(yf: f32) -> GrainRowPlan {
    let base_y = yf * 0.45;
    GrainRowPlan {
        oct0: grain_octave_row(base_y, 1.0, 11),
        oct1: grain_octave_row(base_y, 2.0, 12),
    }
}

#[inline(always)]
fn grain_level(xf: f32, row: &GrainRowPlan) -> f32 {
    let base_x = xf * 0.45;
    let v0 = value_noise_precalc(base_x, &row.oct0);
    let v1 = value_noise_precalc(base_x * 2., &row.oct1);
    ((v0 + 0.5 * v1) / 1.5).clamp(0., 1.)
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

    let scene_plan = GradientPlan::new(wf, hf, SCENE_ANGLE);
    let overlay_plan = overlay.map(|o| OverlayPlan::new(wf, hf, o));
    let vignette_plan = VignettePlan::new(wf, hf, vignette);

    let prepared_filters: Vec<PreparedFilter> =
        filter.iter().copied().map(PreparedFilter::from_filter).collect();

    let mut scene_dx_sin = Vec::with_capacity(w as usize);
    for x in 0..w {
        let xf = x as f32 + 0.5;
        scene_dx_sin.push((xf - scene_plan.half_width) * scene_plan.sin);
    }

    let overlay_dx_sin = overlay_plan.as_ref().map(|o| {
        let mut v = Vec::with_capacity(w as usize);
        for x in 0..w {
            let xf = x as f32 + 0.5;
            v.push((xf - o.gradient.half_width) * o.gradient.sin);
        }
        v
    });

    let vignette_dx_sq = vignette_plan.as_ref().map(|v| {
        let mut v_dx = Vec::with_capacity(w as usize);
        for x in 0..w {
            let xf = x as f32 + 0.5;
            let dx = (xf - v.half_width) / v.rx;
            v_dx.push(dx * dx);
        }
        v_dx
    });

    for (y, row) in rgba.chunks_exact_mut((w * 4) as usize).enumerate() {
        let yf = y as f32 + 0.5;
        let scene_dy_cos = scene_plan.row_dy_cos(yf);
        let overlay_dy_cos = overlay_plan.as_ref().map(|o| o.gradient.row_dy_cos(yf));
        let vignette_dy_sq = vignette_plan.as_ref().map(|v| {
            let dy = v.row_dy(yf);
            dy * dy
        });
        let grain_row = if grain_opacity > 0. {
            Some(grain_row_plan(yf))
        } else {
            None
        };

        for (x, pixel) in row.chunks_exact_mut(4).enumerate() {
            let scene_pos = if scene_plan.length <= 0. {
                0.
            } else {
                (0.5 + (scene_dx_sin[x] - scene_dy_cos) / scene_plan.length).clamp(0., 1.)
            };
            let scene = gradient_color(scene_pos, &SCENE_STOPS);

            let mut color = scene;
            for f in &prepared_filters {
                color = f.apply(color);
            }

            if let (Some(overlay), Some(overlay_dx), Some(overlay_dy_cos)) =
                (&overlay_plan, &overlay_dx_sin, overlay_dy_cos)
            {
                let position = if overlay.gradient.length <= 0. {
                    0.
                } else {
                    (0.5 + (overlay_dx[x] - overlay_dy_cos) / overlay.gradient.length).clamp(0., 1.)
                };
                let source = [
                    overlay.from[0] + position * overlay.delta[0],
                    overlay.from[1] + position * overlay.delta[1],
                    overlay.from[2] + position * overlay.delta[2],
                    overlay.from[3] + position * overlay.delta[3],
                ];
                color = composite_overlay(color, source);
            }

            if let (Some(vignette), Some(vignette_dx_sq), Some(dy_sq)) =
                (&vignette_plan, &vignette_dx_sq, vignette_dy_sq)
            {
                let distance = (vignette_dx_sq[x] + dy_sq).sqrt();
                let shade = 1. - (((distance - 0.4) / 0.6).clamp(0., 1.)) * vignette.peak;
                color = [color[0] * shade, color[1] * shade, color[2] * shade];
            }

            if let Some(grain_row) = &grain_row {
                let xf = x as f32 + 0.5;
                let level = grain_level(xf, grain_row);
                color = composite_overlay(color, [level, level, level, grain_opacity]);
            }

            let byte = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
            pixel[0] = byte(color[2]);
            pixel[1] = byte(color[1]);
            pixel[2] = byte(color[0]);
            pixel[3] = 255;
        }
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

    fn reference_preset_preview_bgra(
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
            let scene =
                gradient_color(gradient_position(xf, yf, wf, hf, SCENE_ANGLE), &SCENE_STOPS);
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
                let level =
                    fractal_noise_octaves(xf * 0.9 / 2., yf * 0.9 / 2., 11, 2).clamp(0., 1.);
                color = composite_overlay(color, [level, level, level, grain_opacity]);
            }

            let byte = |value: f32| (value.clamp(0., 1.) * 255.).round() as u8;
            *pixel = image::Rgba([byte(color[2]), byte(color[1]), byte(color[0]), 255]);
        }

        rgba
    }

    #[test]
    fn preset_preview_renders_filter_and_overlay_combinations() {
        let filters = [
            Filter::Contrast(1.12),
            Filter::Saturate(1.12),
            Filter::HueRotate(45.),
            Filter::Sepia(0.3),
            Filter::Brightness(1.05),
        ];
        let overlay = Overlay {
            angle: 135.,
            from: [0., 0.5, 0.6, 0.15],
            to: [1., 0.5, 0., 0.15],
        };
        let preview = preset_preview_bgra(&filters, Some(overlay), 0.25, 0.15, 32, 18);
        assert_eq!(preview.dimensions(), (32, 18));
        let reference = reference_preset_preview_bgra(&filters, Some(overlay), 0.25, 0.15, 32, 18);
        assert_eq!(preview.as_raw(), reference.as_raw());
    }
}
