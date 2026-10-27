use crate::{Rgba, Shape};

/// Terms of the colour transform, per output channel:
/// `r, g, b, r², g², b², rg, gb, rb, 1` of the blurred backdrop (0-1 sRGB).
pub const POLY_TERMS: usize = 10;

pub fn poly_features(c: [f32; 3]) -> [f32; POLY_TERMS] {
    let [r, g, b] = c;
    [r, g, b, r * r, g * g, b * b, r * g, g * b, r * b, 1.]
}

/// A glass material, fitted against Apple's glass. Blur and lensing scale
/// with the pane's shorter side, the way Apple's do; [`GlassMaterial::resolve`]
/// turns them into the absolute [`PaneStyle`] the renderers draw with.
#[derive(Clone, Copy, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct GlassMaterial {
    /// Blur sigma: `min(blur_max, blur_k * shorter side)`.
    pub blur_k: f32,
    pub blur_max: f32,
    /// Width of the lensing rim: `min(rim_max, rim_k * shorter side)`.
    pub rim_k: f32,
    pub rim_max: f32,
    /// How far the rim bends light along the normal, in rim widths
    /// (negative pulls from inside the pane).
    pub bend: f32,
    /// Exponent of the bend's falloff across the rim.
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
            .map_err(|_| serde::de::Error::custom("poly needs 30 coefficients"))
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
    pub const SHAPE_FIELDS: usize = 16;

    pub fn resolve(&self, width: f32, height: f32) -> PaneStyle {
        let shorter = width.min(height).max(1.);
        let lens_rim = (self.rim_k * shorter).min(self.rim_max).max(0.5);
        PaneStyle {
            blur: (self.blur_k * shorter).min(self.blur_max).max(0.),
            lens_rim,
            lens_curve: self.lens_curve,
            rim_bend: self.bend * lens_rim,
            poly: self.poly,
            opacity: self.opacity,
            line: self.line,
            line_lit: self.line_lit,
            line_width: self.line_width,
            light: [self.light_angle.cos(), self.light_angle.sin()],
            glow: self.glow,
            glow_width: self.glow_width,
            hairline: self.hairline,
        }
    }

    pub fn shape_vec(&self) -> [f32; Self::SHAPE_FIELDS] {
        [
            self.blur_k,
            self.blur_max,
            self.rim_k,
            self.rim_max,
            self.bend,
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
            rim_k: values[2].max(0.),
            rim_max: values[3].max(0.5),
            bend: values[4],
            lens_curve: values[5].clamp(0.2, 6.),
            line: values[6],
            line_lit: values[7],
            line_width: values[8].max(0.3),
            light_angle: values[9],
            glow: values[10],
            glow_width: values[11].max(0.5),
            hairline: [values[12], values[13], values[14], values[15]],
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
    let rim = 1. - (edge / style.lens_rim).clamp(0., 1.).powf(style.lens_curve);
    let value = blurred.sample(px + nx * style.rim_bend * rim, py + ny * style.rim_bend * rim);
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
        let line = under[i].min(sample.hairline[0] * under[i] + sample.hairline[1]).clamp(0., 1.);
        under[i] + (line - under[i]) * sample.ring
    })
}

/// Apply the colour transform and lighting: 0-1 sRGB out, unclamped.
pub fn finish(style: &PaneStyle, sample: &GlassSample) -> [f32; 3] {
    let features = poly_features(sample.source);
    std::array::from_fn(|channel| {
        let coefficients = &style.poly[channel * POLY_TERMS..(channel + 1) * POLY_TERMS];
        let value: f32 = coefficients.iter().zip(features).map(|(c, f)| c * f).sum();
        value * sample.scale + sample.glow
    })
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
            let under = under_with_hairline(&glass, [under[0] / 255., under[1] / 255., under[2] / 255.]);
            let color = if glass.coverage > 0. { finish(style, &glass) } else { under };
            let mix = |i: usize| (under[i] + (color[i].clamp(0., 1.) - under[i]) * glass.coverage) * 255.;
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
