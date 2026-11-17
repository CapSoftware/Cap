use crate::{Rgba, Shape};

/// Terms of the colour transform, per output channel: the full cubic in
/// `r, g, b` of the blurred backdrop (0-1 sRGB), constant last. The cubes
/// follow Apple's tone curve along the grey axis; the mixed cubic terms let
/// that curve act on brightness without bending hue, which Apple's Regular
/// glass needs over saturated content (it lifts a light blue's blue channel
/// past what white comes out as).
pub const POLY_TERMS: usize = 20;

pub fn poly_features(c: [f32; 3]) -> [f32; POLY_TERMS] {
    let [r, g, b] = c;
    [
        r,
        g,
        b,
        r * r,
        g * g,
        b * b,
        r * g,
        g * b,
        r * b,
        r * r * r,
        g * g * g,
        b * b * b,
        r * r * g,
        r * r * b,
        g * g * r,
        g * g * b,
        b * b * r,
        b * b * g,
        r * g * b,
        1.,
    ]
}

/// A glass material, fitted against Apple's glass. Blur and lensing scale
/// with the pane's shorter side, the way Apple's do; [`GlassMaterial::resolve`]
/// turns them into the absolute [`PaneStyle`] the renderers draw with.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct GlassMaterial {
    /// Blur sigma: `min(blur_max, blur_k * shorter side)`.
    pub blur_k: f32,
    pub blur_max: f32,
    /// Decay length of the lensing rim:
    /// `min(rim_max, rim_base + rim_k * shorter side)`.
    pub rim_base: f32,
    pub rim_k: f32,
    pub rim_max: f32,
    /// How far the edge pulls light in from inside the pane:
    /// `min(bend_max, bend_base + bend_k * shorter side)`. Apple's grows with
    /// the pane up to a cap, independently of the decay length.
    pub bend_base: f32,
    pub bend_k: f32,
    pub bend_max: f32,
    /// Shape of the falloff: the bend at depth `d` is
    /// `exp(-(d / decay)^lens_curve)` of the edge's, so 1 is the
    /// exponential falloff Apple's captures follow.
    pub lens_curve: f32,
    /// Second-order colour transform of the blurred backdrop: for each output
    /// channel, coefficients of [`poly_features`]. It carries the frost, the
    /// saturation, the hue shift and the brightness compression Apple's
    /// materials apply.
    #[serde(with = "serde_poly")]
    pub poly: [f32; 3 * POLY_TERMS],
    /// How opaque the glass is over a transparent backdrop.
    pub opacity: f32,
    /// Edge line: scales the colour by `1 + line + line_lit * facing` at the
    /// edge, decaying inwards over `line_width`; `facing` is how much the
    /// edge faces `light_angle` (radians, y down).
    pub line: f32,
    pub line_lit: f32,
    pub line_width: f32,
    pub light_angle: f32,
    /// A soft inner glow from the edge.
    pub glow: f32,
    pub glow_width: f32,
    /// The hairline Apple draws in the pixel just outside the edge:
    /// `clamp(min(under, a * under + b), 0, 1)`, with `a` and `b` blended
    /// between vertical edges (`[a, b]` first) and horizontal ones by the
    /// edge normal.
    pub hairline: [f32; 4],
    /// Size adaptation: Regular glass in dark mode lifts small panes over
    /// bright content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapt: Option<Adapt>,
    /// How a tint colours this material.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tint: Option<TintLaw>,
}

/// Rec. 709 luma of a gamma-encoded colour: the weights Apple's tint mixes
/// with, which fit its captures better than Rec. 601 or linear light.
pub const LUMA: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// How a tint (an sRGB colour and an alpha) changes the finished glass
/// colour `u`, measured from Apple's tinted glass (`sweep tints` and
/// `sweep levels`). Either way it comes down to a colour matrix,
/// `u * scale + luma(u) * luma + offset` per channel: see [`TintMatrix`].
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TintLaw {
    /// Regular glass ignores the tint's colour: it mixes `desaturate *
    /// alpha` of the way towards the luma and shifts by `shift * alpha`.
    Grey { desaturate: f32, shift: f32 },
    /// Clear glass alpha-blends a tint layer in sRGB. The layer is the tint
    /// itself over white and a darker, more saturated colour of the same hue
    /// over black, following the luma in between. Over black, the tint's
    /// brightest and darkest channels land on `high` and `low`, looked up by
    /// the tint's HSL lightness (rows, [`TINT_LIGHTNESS`]) and saturation
    /// (columns, [`TINT_SATURATION`]); the other channel keeps its place
    /// between them. Values below 0 are kept: they clamp per channel.
    Layer {
        high: [[f32; 5]; 12],
        low: [[f32; 5]; 12],
    },
}

/// The HSL grid Clear's tint table is measured on (`sweep hsl`).
pub const TINT_LIGHTNESS: [f32; 12] = [0., 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.];
pub const TINT_SATURATION: [f32; 5] = [0., 0.25, 0.5, 0.75, 1.];

/// Bilinear lookup in a table over [`TINT_LIGHTNESS`] x [`TINT_SATURATION`].
fn tint_lookup(table: &[[f32; 5]; 12], lightness: f32, saturation: f32) -> f32 {
    fn cell(axis: &[f32], value: f32) -> (usize, f32) {
        let value = value.clamp(axis[0], axis[axis.len() - 1]);
        let index = axis
            .windows(2)
            .position(|pair| value <= pair[1])
            .unwrap_or(axis.len() - 2);
        (
            index,
            (value - axis[index]) / (axis[index + 1] - axis[index]),
        )
    }
    let (row, along_l) = cell(&TINT_LIGHTNESS, lightness);
    let (column, along_s) = cell(&TINT_SATURATION, saturation);
    let mix = |a: f32, b: f32, t: f32| a + (b - a) * t;
    mix(
        mix(table[row][column], table[row][column + 1], along_s),
        mix(table[row + 1][column], table[row + 1][column + 1], along_s),
        along_l,
    )
}

/// A tint resolved to what the renderers apply to the finished colour.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TintMatrix {
    pub scale: [f32; 3],
    pub luma: [f32; 3],
    pub offset: [f32; 3],
}

impl TintMatrix {
    pub const NONE: Self = Self {
        scale: [1.; 3],
        luma: [0.; 3],
        offset: [0.; 3],
    };

    pub fn apply(&self, u: [f32; 3]) -> [f32; 3] {
        let y = u[0] * LUMA[0] + u[1] * LUMA[1] + u[2] * LUMA[2];
        std::array::from_fn(|c| u[c] * self.scale[c] + y * self.luma[c] + self.offset[c])
    }
}

impl TintLaw {
    /// `color` is sRGB 0-1, `alpha` 0-1.
    pub fn matrix(&self, color: [f32; 3], alpha: f32) -> TintMatrix {
        let alpha = alpha.clamp(0., 1.);
        match *self {
            TintLaw::Grey { desaturate, shift } => {
                let mix = desaturate * alpha;
                TintMatrix {
                    scale: [1. - mix; 3],
                    luma: [mix; 3],
                    offset: [shift * alpha; 3],
                }
            }
            TintLaw::Layer { high, low } => {
                let t = color.map(|c| c.clamp(0., 1.));
                let (brightest, darkest) = (t[0].max(t[1]).max(t[2]), t[0].min(t[1]).min(t[2]));
                let lightness = (brightest + darkest) / 2.;
                let spread = 1. - (2. * lightness - 1.).abs();
                let saturation = if spread > 1e-6 {
                    (brightest - darkest) / spread
                } else {
                    0.
                };
                let (to_high, to_low) = (
                    tint_lookup(&high, lightness, saturation),
                    tint_lookup(&low, lightness, saturation),
                );
                let over_black = t.map(|c| {
                    let place = if brightest - darkest > 1e-6 {
                        (c - darkest) / (brightest - darkest)
                    } else {
                        0.5
                    };
                    (to_low + (to_high - to_low) * place).clamp(0., 1.)
                });
                TintMatrix {
                    scale: [1. - alpha; 3],
                    luma: std::array::from_fn(|c| alpha * (t[c] - over_black[c])),
                    offset: over_black.map(|n| alpha * n),
                }
            }
        }
    }
}

/// A second colour transform for small panes. Below `small` points on the
/// shorter side a pane uses `poly`, above `large` the material's own, and
/// in between a linear blend of the two. Apple's captures show no
/// dependence on the backdrop beyond the transform itself, and no
/// hysteresis, so the blend is fixed per pane size.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Adapt {
    pub small: f32,
    pub large: f32,
    #[serde(with = "serde_poly")]
    pub poly: [f32; 3 * POLY_TERMS],
}

impl Adapt {
    /// How much of the small-pane transform a pane uses.
    pub fn weight(&self, shorter: f32) -> f32 {
        ((self.large - shorter) / (self.large - self.small).max(1e-3)).clamp(0., 1.)
    }
}

mod serde_poly {
    use super::POLY_TERMS;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(poly: &[f32; 3 * POLY_TERMS], s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(poly.iter())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[f32; 3 * POLY_TERMS], D::Error> {
        let values = Vec::<f32>::deserialize(d)?;
        values
            .try_into()
            .map_err(|_| serde::de::Error::custom("poly needs 3 x POLY_TERMS coefficients"))
    }
}

/// One pane's resolved style, in logical pixels. Mirrored field for field by
/// `GlassStyle` in the gpui patch's shaders (which take device pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneStyle {
    pub blur: f32,
    pub lens_rim: f32,
    pub lens_curve: f32,
    pub rim_bend: f32,
    pub poly: [f32; 3 * POLY_TERMS],
    pub opacity: f32,
    pub line: f32,
    pub line_lit: f32,
    pub line_width: f32,
    pub light: [f32; 2],
    pub glow: f32,
    pub glow_width: f32,
    pub hairline: [f32; 4],
    /// Tint on the finished colour; [`TintMatrix::NONE`] when untinted.
    pub tint: TintMatrix,
}

impl PaneStyle {
    /// The same style for a window drawing `scale` device pixels per
    /// logical pixel.
    pub fn scaled(&self, scale: f32) -> Self {
        Self {
            blur: self.blur * scale,
            lens_rim: self.lens_rim * scale,
            rim_bend: self.rim_bend * scale,
            line_width: self.line_width * scale,
            glow_width: self.glow_width * scale,
            ..*self
        }
    }
}

impl GlassMaterial {
    /// Parameters the optimiser searches; the colour transform is solved.
    pub const SHAPE_FIELDS: usize = 19;

    /// The colour transform a pane of this shorter side uses.
    pub fn poly_for(&self, shorter: f32) -> [f32; 3 * POLY_TERMS] {
        match &self.adapt {
            Some(adapt) => {
                let weight = adapt.weight(shorter);
                std::array::from_fn(|i| self.poly[i] + (adapt.poly[i] - self.poly[i]) * weight)
            }
            None => self.poly,
        }
    }

    pub fn resolve(&self, width: f32, height: f32) -> PaneStyle {
        let shorter = width.min(height).max(1.);
        let lens_rim = (self.rim_base + self.rim_k * shorter).clamp(0.5, self.rim_max.max(0.5));
        let bend = (self.bend_base + self.bend_k * shorter).clamp(0., self.bend_max.max(0.));
        PaneStyle {
            blur: (self.blur_k * shorter).clamp(0., self.blur_max.max(0.)),
            lens_rim,
            lens_curve: self.lens_curve,
            rim_bend: -bend,
            poly: self.poly_for(shorter),
            opacity: self.opacity,
            line: self.line,
            line_lit: self.line_lit,
            line_width: self.line_width,
            light: [self.light_angle.cos(), self.light_angle.sin()],
            glow: self.glow,
            glow_width: self.glow_width,
            hairline: self.hairline,
            tint: TintMatrix::NONE,
        }
    }

    /// The tint `color` (sRGB 0-1) at `alpha` on this material, or no tint
    /// for a material without a measured tint law.
    pub fn tint_matrix(&self, color: [f32; 3], alpha: f32) -> TintMatrix {
        self.tint
            .map_or(TintMatrix::NONE, |law| law.matrix(color, alpha))
    }

    pub fn shape_vec(&self) -> [f32; Self::SHAPE_FIELDS] {
        [
            self.blur_k,
            self.blur_max,
            self.rim_base,
            self.rim_k,
            self.rim_max,
            self.bend_base,
            self.bend_k,
            self.bend_max,
            self.lens_curve,
            self.line,
            self.line_lit,
            self.line_width,
            self.light_angle,
            self.glow,
            self.glow_width,
            self.hairline[0],
            self.hairline[1],
            self.hairline[2],
            self.hairline[3],
        ]
    }

    pub fn with_shape(&self, values: &[f32]) -> Self {
        Self {
            blur_k: values[0].max(0.),
            blur_max: values[1].max(0.),
            rim_base: values[2].max(0.),
            rim_k: values[3].max(0.),
            rim_max: values[4].max(0.5),
            bend_base: values[5],
            bend_k: values[6],
            bend_max: values[7].max(0.),
            lens_curve: values[8].clamp(0.2, 6.),
            line: values[9],
            line_lit: values[10],
            line_width: values[11].max(0.3),
            light_angle: values[12],
            glow: values[13],
            glow_width: values[14].max(0.5),
            hairline: [values[15], values[16], values[17], values[18]],
            ..*self
        }
    }
}

/// The blurred backdrop colour a glass pixel samples (0-1), before the
/// colour transform, plus everything applied around it.
pub struct GlassSample {
    pub source: [f32; 3],
    /// How much of the pixel the glass covers.
    pub coverage: f32,
    /// How much of the pixel the hairline ring outside the edge covers.
    pub ring: f32,
    /// The hairline's `a` and `b` at this point of the edge.
    pub hairline: [f32; 2],
    /// `1 + line term`.
    pub scale: f32,
    pub glow: f32,
}

pub fn sample(style: &PaneStyle, shape: &Shape, blurred: &Rgba, px: f32, py: f32) -> GlassSample {
    let d = shape.sdf(px, py);
    let coverage = (0.5 - d).clamp(0., 1.);
    let ring = (1.5 - d).clamp(0., 1.) - coverage;
    let (nx, ny) = shape.normal(px, py);
    let vertical = nx * nx;
    let hairline = [
        style.hairline[0] * vertical + style.hairline[2] * (1. - vertical),
        style.hairline[1] * vertical + style.hairline[3] * (1. - vertical),
    ];
    if coverage <= 0. {
        return GlassSample {
            source: [0.; 3],
            coverage: 0.,
            ring,
            hairline,
            scale: 1.,
            glow: 0.,
        };
    }
    let edge = (-d).max(0.);
    let rim = (-(edge / style.lens_rim).powf(style.lens_curve)).exp();
    let value = blurred.sample(
        px + nx * style.rim_bend * rim,
        py + ny * style.rim_bend * rim,
    );
    let facing = nx * style.light[0] + ny * style.light[1];
    GlassSample {
        source: [value[0] / 255., value[1] / 255., value[2] / 255.],
        coverage,
        ring,
        hairline,
        scale: 1. + (-edge / style.line_width).exp() * (style.line + style.line_lit * facing),
        glow: (-edge / style.glow_width).exp() * style.glow,
    }
}

/// The backdrop under a glass pixel once the hairline is drawn on it (0-1).
pub fn under_with_hairline(sample: &GlassSample, under: [f32; 3]) -> [f32; 3] {
    std::array::from_fn(|i| {
        let line = under[i]
            .min(sample.hairline[0] * under[i] + sample.hairline[1])
            .clamp(0., 1.);
        under[i] + (line - under[i]) * sample.ring
    })
}

/// Apply the colour transform, lighting and tint: 0-1 sRGB out, unclamped.
pub fn finish(style: &PaneStyle, sample: &GlassSample) -> [f32; 3] {
    let features = poly_features(sample.source);
    let untinted: [f32; 3] = std::array::from_fn(|channel| {
        let coefficients = &style.poly[channel * POLY_TERMS..(channel + 1) * POLY_TERMS];
        let value: f32 = coefficients.iter().zip(features).map(|(c, f)| c * f).sum();
        (value * sample.scale + sample.glow).clamp(0., 1.)
    });
    style.tint.apply(untinted)
}

/// Composite one pane over `out`, sampling `blurred` (the backdrop blurred
/// by the pane's own blur).
pub fn composite(style: &PaneStyle, shape: &Shape, blurred: &Rgba, out: &mut Rgba) {
    let x0 = (shape.x - 3.).floor().max(0.) as usize;
    let y0 = (shape.y - 3.).floor().max(0.) as usize;
    let x1 = ((shape.x + shape.width + 3.).ceil() as usize).min(out.width);
    let y1 = ((shape.y + shape.height + 3.).ceil() as usize).min(out.height);
    for y in y0..y1 {
        for x in x0..x1 {
            let glass = sample(style, shape, blurred, x as f32 + 0.5, y as f32 + 0.5);
            if glass.coverage <= 0. && glass.ring <= 0. {
                continue;
            }
            let under = out.get(x, y);
            let under =
                under_with_hairline(&glass, [under[0] / 255., under[1] / 255., under[2] / 255.]);
            let color = if glass.coverage > 0. {
                finish(style, &glass)
            } else {
                under
            };
            let mix =
                |i: usize| (under[i] + (color[i].clamp(0., 1.) - under[i]) * glass.coverage) * 255.;
            out.set(x, y, [mix(0), mix(1), mix(2), 255.]);
        }
    }
}

/// Composite every pane of `material` over `backdrop`.
pub fn render(material: &GlassMaterial, shapes: &[Shape], backdrop: &Rgba) -> Rgba {
    let mut out = backdrop.clone();
    for shape in shapes {
        let style = material.resolve(shape.width, shape.height);
        composite(&style, shape, &backdrop.blurred(style.blur), &mut out);
    }
    out
}
