//! Fits a `GlassMaterial` to Apple's reference captures.
//!
//!   glass-fit <reference dir> <out dir> [style-appearance ...]
//!
//! Reads `<reference dir>/manifest.json`, `scenes/*.png` and `apple/*.png`
//! (from scripts/glass-reference) and writes `<out dir>/params.json`,
//! `<out dir>/report.json` and side-by-side renders. The colour transform is
//! linear in its coefficients, so every evaluation solves it exactly by
//! least squares; Nelder-Mead only searches blur, lensing and lighting.
//! `GLASS_PARAMS=<params.json>` skips the search and renders those.

use std::path::{Path, PathBuf};

use cap_glass::{
    Rgba, Shape, metrics,
    model::{self, GlassMaterial, POLY_TERMS},
};

#[derive(serde::Deserialize)]
struct Manifest {
    shapes: Vec<ManifestShape>,
    cases: Vec<Case>,
    /// Image pixels per point: the captures are at the display's backing
    /// scale, the shapes in points.
    #[serde(default = "one")]
    scale: f32,
}

fn one() -> f32 {
    1.
}

static SCALE: std::sync::OnceLock<f32> = std::sync::OnceLock::new();

/// A shape's material in image pixels: the material's laws are in points.
fn style_for(material: &GlassMaterial, shape: &Shape) -> model::PaneStyle {
    let scale = *SCALE.get().unwrap_or(&1.);
    material
        .resolve(shape.width / scale, shape.height / scale)
        .scaled(scale)
}

#[derive(serde::Deserialize)]
struct ManifestShape {
    rect: [f32; 4],
    radius: f32,
}

#[derive(serde::Deserialize, Clone)]
struct Case {
    name: String,
    scene: String,
    style: String,
    appearance: String,
    tint: String,
}

struct Sample {
    name: String,
    backdrop: Rgba,
    apple: Rgba,
    /// One blurred crop per shape: (origin x, origin y, crop).
    crops: Vec<(usize, usize, Rgba)>,
}

const PAD: f32 = 110.;

/// How much more the black, grey and white scenes count in the colour fit.
const NEUTRAL_WEIGHT: f64 = 12.;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let reference = PathBuf::from(&args[1]);
    let out = PathBuf::from(&args[2]);
    std::fs::create_dir_all(out.join("renders")).unwrap();
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(reference.join("manifest.json")).unwrap()).unwrap();
    let scale = manifest.scale;
    SCALE.set(scale).unwrap();
    let shapes: Vec<Shape> = manifest
        .shapes
        .iter()
        .map(|shape| Shape {
            x: shape.rect[0] * scale,
            y: shape.rect[1] * scale,
            width: shape.rect[2] * scale,
            height: shape.rect[3] * scale,
            radius: shape.radius * scale,
        })
        .collect();
    let presets: Vec<String> = if args.len() > 3 {
        args[3..].to_vec()
    } else {
        ["regular-light", "regular-dark", "clear-light", "clear-dark"]
            .map(String::from)
            .to_vec()
    };
    let fixed: Option<serde_json::Value> = std::env::var("GLASS_PARAMS")
        .ok()
        .and_then(|path| serde_json::from_slice(&std::fs::read(path).ok()?).ok());

    let mut fitted = serde_json::Map::new();
    let mut report = serde_json::Map::new();
    for preset in presets {
        let mut samples: Vec<Sample> = manifest
            .cases
            .iter()
            .filter(|case| {
                format!("{}-{}", case.style, case.appearance) == preset
                    && case.tint == "none"
                    && case.scene != "uvfine"
            })
            .map(|case| Sample {
                name: case.name.clone(),
                backdrop: Rgba::load(&reference.join(format!("scenes/{}.png", case.scene))).unwrap(),
                apple: Rgba::load(&reference.join(format!("apple/{}.png", case.name))).unwrap(),
                crops: Vec::new(),
            })
            .collect();

        let material = match fixed
            .as_ref()
            .and_then(|all| serde_json::from_value::<GlassMaterial>(all.get(&preset)?.clone()).ok())
        {
            // `GLASS_RESOLVE=1`: keep the given blur, lensing and lighting but
            // solve the colour transform again.
            Some(material) if std::env::var_os("GLASS_RESOLVE").is_some() => {
                prepare(&mut samples, &shapes, &material);
                let (loss, material) = evaluate(&material, &shapes, &samples);
                eprintln!("{preset}: re-solved colour, loss {loss:.2}");
                material
            }
            Some(material) => material,
            None => fit(&preset, &mut samples, &shapes),
        };
        eprintln!("{preset}:\n{material:#?}");

        prepare(&mut samples, &shapes, &material);
        let mask = region_mask(&shapes, &samples[0].backdrop);
        let mut scores = serde_json::Map::new();
        for sample in &samples {
            let rendered = render_sample(&material, &shapes, sample);
            let ssim = metrics::ssim(&rendered, &sample.apple, &mask);
            let (mean, p95) = metrics::delta_e(&rendered, &sample.apple, &mask);
            scores.insert(
                sample.name.clone(),
                serde_json::json!({ "ssim": ssim, "deltaE": mean, "deltaE95": p95 }),
            );
            side_by_side(&rendered, &sample.apple, &out.join(format!("renders/{}.png", sample.name)));
        }
        fitted.insert(preset.clone(), serde_json::to_value(material).unwrap());
        report.insert(preset, serde_json::Value::Object(scores));
        std::fs::write(out.join("params.json"), serde_json::to_string_pretty(&fitted).unwrap()).unwrap();
        std::fs::write(out.join("report.json"), serde_json::to_string_pretty(&report).unwrap()).unwrap();
    }
}

fn fit(preset: &str, samples: &mut [Sample], shapes: &[Shape]) -> GlassMaterial {
    let start = GlassMaterial {
        blur_k: 0.19,
        blur_max: 21.,
        rim_k: 0.24,
        rim_max: 24.,
        bend: -2.,
        lens_curve: 0.4,
        poly: [0.; 3 * POLY_TERMS],
        opacity: 0.6,
        line: 0.,
        line_lit: 0.,
        line_width: 1.,
        light_angle: -2.3,
        glow: 0.,
        glow_width: 4.,
        hairline: [0.85, -0.12, 0.9, -0.08],
    };
    let mut best: Option<(f64, GlassMaterial)> = None;
    let mut try_law = |blur_k: f32, blur_max: f32, best: &mut Option<(f64, GlassMaterial)>| {
        let seed = GlassMaterial {
            blur_k,
            blur_max,
            ..best.map_or(start, |(_, material)| material)
        };
        let (loss, material) = fit_at_law(samples, shapes, seed);
        eprintln!("{preset}: blur {blur_k:.3} x side, max {blur_max:.1} -> loss {loss:.2}");
        if best.is_none_or(|(current, _)| loss < current) {
            *best = Some((loss, material));
        }
    };
    for blur_k in [0.06, 0.1, 0.14, 0.19, 0.25] {
        try_law(blur_k, 60., &mut best);
    }
    let k = best.unwrap().1.blur_k;
    for blur_max in [8., 12., 16., 20., 26., 34.] {
        try_law(k, blur_max, &mut best);
    }
    for _ in 0..2 {
        let law = best.unwrap().1;
        for (dk, dm) in [(-0.02, 0.), (0.02, 0.), (0., -2.), (0., 2.)] {
            try_law((law.blur_k + dk).max(0.01), (law.blur_max + dm).max(1.), &mut best);
        }
    }
    best.unwrap().1
}

fn crop(image: &Rgba, x0: usize, y0: usize, x1: usize, y1: usize) -> Rgba {
    let mut out = Rgba::solid(x1 - x0, y1 - y0, [0.; 4]);
    for y in y0..y1 {
        for x in x0..x1 {
            out.set(x - x0, y - y0, image.get(x, y));
        }
    }
    out
}

fn prepare(samples: &mut [Sample], shapes: &[Shape], material: &GlassMaterial) {
    std::thread::scope(|scope| {
        for sample in samples.iter_mut() {
            scope.spawn(move || {
                sample.crops = shapes
                    .iter()
                    .map(|shape| {
                        let blur = style_for(material, shape).blur;
                        let pad = PAD * SCALE.get().unwrap_or(&1.) + blur * 3.;
                        let x0 = (shape.x - pad).max(0.) as usize;
                        let y0 = (shape.y - pad).max(0.) as usize;
                        let x1 = ((shape.x + shape.width + pad) as usize).min(sample.backdrop.width);
                        let y1 = ((shape.y + shape.height + pad) as usize).min(sample.backdrop.height);
                        (x0, y0, crop(&sample.backdrop, x0, y0, x1, y1).blurred(blur))
                    })
                    .collect();
            });
        }
    });
}

/// Visit glass pixels with their global position and weight. With `sparse`,
/// pixels deeper than 12 px inside are visited on every other row and
/// column at four times the weight: they carry far less than the rim does.
fn for_each_glass_pixel(
    material: &GlassMaterial,
    shapes: &[Shape],
    sample: &Sample,
    sparse: bool,
    mut visit: impl FnMut(&model::GlassSample, &model::PaneStyle, usize, usize, f64),
) {
    for (shape, (ox, oy, blurred)) in shapes.iter().zip(&sample.crops) {
        let style = style_for(material, shape);
        let local = Shape {
            x: shape.x - *ox as f32,
            y: shape.y - *oy as f32,
            ..*shape
        };
        let x0 = (local.x - 3.).floor().max(0.) as usize;
        let y0 = (local.y - 3.).floor().max(0.) as usize;
        let x1 = ((local.x + local.width + 3.).ceil() as usize).min(blurred.width);
        let y1 = ((local.y + local.height + 3.).ceil() as usize).min(blurred.height);
        for y in y0..y1 {
            for x in x0..x1 {
                let (px, py) = (x as f32 + 0.5, y as f32 + 0.5);
                let weight = if sparse && local.sdf(px, py) < -12. {
                    if x % 2 != 0 || y % 2 != 0 {
                        continue;
                    }
                    4.
                } else {
                    1.
                };
                let glass = model::sample(&style, &local, blurred, px, py);
                if glass.coverage > 0. || glass.ring > 0. {
                    visit(&glass, &style, x + ox, y + oy, weight);
                }
            }
        }
    }
}

fn render_sample(material: &GlassMaterial, shapes: &[Shape], sample: &Sample) -> Rgba {
    let mut out = sample.backdrop.clone();
    for_each_glass_pixel(material, shapes, sample, false, |glass, style, x, y, _| {
        let under = sample.backdrop.get(x, y);
        let under =
            model::under_with_hairline(glass, [under[0] / 255., under[1] / 255., under[2] / 255.]);
        let color = if glass.coverage > 0. { model::finish(style, glass) } else { under };
        let mix = |i: usize| (under[i] + (color[i].clamp(0., 1.) - under[i]) * glass.coverage) * 255.;
        out.set(x, y, [mix(0), mix(1), mix(2), 255.]);
    });
    out
}

/// Normal equations of the colour transform over every covered pixel:
/// `coverage * scale * features . poly = target - (1 - coverage) * under -
/// coverage * glow`, per channel, plus what the residual needs.
struct Normal {
    ata: [[f64; POLY_TERMS]; POLY_TERMS],
    atb: [[f64; 3]; POLY_TERMS],
    btb: [f64; 3],
    count: usize,
    /// Squared error of hairline-only pixels, which the transform cannot
    /// change.
    fixed_sse: f64,
    fixed_count: usize,
}

impl Normal {
    fn new() -> Self {
        Self {
            ata: [[0.; POLY_TERMS]; POLY_TERMS],
            atb: [[0.; 3]; POLY_TERMS],
            btb: [0.; 3],
            count: 0,
            fixed_sse: 0.,
            fixed_count: 0,
        }
    }

    fn add(&mut self, other: &Self) {
        for i in 0..POLY_TERMS {
            for j in 0..POLY_TERMS {
                self.ata[i][j] += other.ata[i][j];
            }
            for c in 0..3 {
                self.atb[i][c] += other.atb[i][c];
            }
        }
        for c in 0..3 {
            self.btb[c] += other.btb[c];
        }
        self.count += other.count;
        self.fixed_sse += other.fixed_sse;
        self.fixed_count += other.fixed_count;
    }

    /// Least-squares coefficients and the mean squared error per channel
    /// value on the 0-255 scale.
    fn solve(&self) -> ([f32; 3 * POLY_TERMS], f64) {
        let mut a = self.ata;
        for (i, row) in a.iter_mut().enumerate() {
            row[i] += 1e-6;
        }
        let mut poly = [0f32; 3 * POLY_TERMS];
        let mut sse = 0.;
        for c in 0..3 {
            let b: [f64; POLY_TERMS] = std::array::from_fn(|i| self.atb[i][c]);
            let x = solve_linear(a, b);
            let mut xax = 0.;
            let mut xb = 0.;
            for i in 0..POLY_TERMS {
                poly[c * POLY_TERMS + i] = x[i] as f32;
                xb += x[i] * b[i];
                for j in 0..POLY_TERMS {
                    xax += x[i] * self.ata[i][j] * x[j];
                }
            }
            sse += self.btb[c] - 2. * xb + xax;
        }
        let total = sse.max(0.) + self.fixed_sse;
        let values = 3 * (self.count + self.fixed_count).max(1);
        (poly, total / values as f64 * 255. * 255.)
    }
}

fn solve_linear(
    mut m: [[f64; POLY_TERMS]; POLY_TERMS],
    mut v: [f64; POLY_TERMS],
) -> [f64; POLY_TERMS] {
    for col in 0..POLY_TERMS {
        let pivot = (col..POLY_TERMS)
            .max_by(|a, b| m[*a][col].abs().total_cmp(&m[*b][col].abs()))
            .unwrap();
        m.swap(col, pivot);
        v.swap(col, pivot);
        for row in 0..POLY_TERMS {
            if row != col && m[col][col] != 0. {
                let factor = m[row][col] / m[col][col];
                for k in 0..POLY_TERMS {
                    m[row][k] -= factor * m[col][k];
                }
                v[row] -= factor * v[col];
            }
        }
    }
    std::array::from_fn(|i| if m[i][i] == 0. { 0. } else { v[i] / m[i][i] })
}

fn normal_equations(material: &GlassMaterial, shapes: &[Shape], samples: &[Sample]) -> Normal {
    std::thread::scope(|scope| {
        let handles: Vec<_> = samples
            .iter()
            .map(|sample| {
                scope.spawn(move || {
                    let mut normal = Normal::new();
                    // Flat backdrops pin the grey axis, where any error shows
                    // most; a handful of colourful scenes would otherwise
                    // outvote them.
                    let neutral = ["white-", "black-", "gray-"]
                        .iter()
                        .any(|prefix| sample.name.starts_with(prefix));
                    let scene_weight = if neutral { NEUTRAL_WEIGHT } else { 1. };
                    for_each_glass_pixel(material, shapes, sample, true, |glass, _, x, y, weight| {
                        let weight = weight * scene_weight;
                        let under = sample.backdrop.get(x, y);
                        let under = model::under_with_hairline(
                            glass,
                            [under[0] / 255., under[1] / 255., under[2] / 255.],
                        );
                        let target = sample.apple.get(x, y);
                        if glass.coverage <= 0. {
                            for c in 0..3 {
                                let error = under[c] as f64 - target[c] as f64 / 255.;
                                normal.fixed_sse += weight * error * error;
                            }
                            normal.fixed_count += weight as usize;
                            return;
                        }
                        let features = model::poly_features(glass.source);
                        let scale = (glass.coverage * glass.scale) as f64;
                        let row: [f64; POLY_TERMS] =
                            std::array::from_fn(|i| features[i] as f64 * scale);
                        for i in 0..POLY_TERMS {
                            for j in i..POLY_TERMS {
                                normal.ata[i][j] += weight * row[i] * row[j];
                            }
                        }
                        let coverage = glass.coverage as f64;
                        for c in 0..3 {
                            let b = target[c] as f64 / 255.
                                - (1. - coverage) * under[c] as f64
                                - coverage * glass.glow as f64;
                            for i in 0..POLY_TERMS {
                                normal.atb[i][c] += weight * row[i] * b;
                            }
                            normal.btb[c] += weight * b * b;
                        }
                        normal.count += weight as usize;
                    });
                    for i in 0..POLY_TERMS {
                        for j in 0..i {
                            normal.ata[i][j] = normal.ata[j][i];
                        }
                    }
                    normal
                })
            })
            .collect();
        let mut total = Normal::new();
        for handle in handles {
            total.add(&handle.join().unwrap());
        }
        total
    })
}

fn evaluate(material: &GlassMaterial, shapes: &[Shape], samples: &[Sample]) -> (f64, GlassMaterial) {
    let (poly, loss) = normal_equations(material, shapes, samples).solve();
    (loss, GlassMaterial { poly, ..*material })
}

/// Fit everything but the blur law, which stays fixed so each backdrop is
/// blurred once.
fn fit_at_law(
    samples: &mut [Sample],
    shapes: &[Shape],
    start: GlassMaterial,
) -> (f64, GlassMaterial) {
    prepare(samples, shapes, &start);
    let samples: &[Sample] = samples;
    let objective = |values: &[f32]| evaluate(&start.with_shape(values), shapes, samples).0;
    let scales = [
        0., 0., 0.05, 6., 0.6, 0.2, 0.04, 0.04, 0.5, 0.8, 0.04, 3., 0.08, 0.05, 0.08, 0.05,
    ];
    let mut point = start.shape_vec().to_vec();
    let mut value = objective(&point);
    for _ in 0..4 {
        let (next_value, next) = nelder_mead(&objective, &point, &scales, 160);
        if next_value >= value - 1e-3 {
            break;
        }
        value = next_value;
        point = next;
    }
    evaluate(&start.with_shape(&point), shapes, samples)
}

fn region_mask(shapes: &[Shape], image: &Rgba) -> Vec<bool> {
    (0..image.width * image.height)
        .map(|index| {
            let (x, y) = ((index % image.width) as f32 + 0.5, (index / image.width) as f32 + 0.5);
            shapes.iter().any(|shape| shape.sdf(x, y) < 1.5)
        })
        .collect()
}

fn nelder_mead(
    objective: &impl Fn(&[f32]) -> f64,
    start: &[f32],
    scales: &[f32],
    iterations: usize,
) -> (f64, Vec<f32>) {
    let dims: Vec<usize> = (0..start.len()).filter(|i| scales[*i] != 0.).collect();
    let mut simplex: Vec<(f64, Vec<f32>)> = vec![(objective(start), start.to_vec())];
    for &dim in &dims {
        let mut vertex = start.to_vec();
        vertex[dim] += scales[dim];
        simplex.push((objective(&vertex), vertex));
    }
    for _ in 0..iterations {
        simplex.sort_by(|a, b| a.0.total_cmp(&b.0));
        let worst = simplex.len() - 1;
        let centroid: Vec<f32> = (0..start.len())
            .map(|i| simplex[..worst].iter().map(|(_, v)| v[i]).sum::<f32>() / worst as f32)
            .collect();
        let along = |t: f32| -> Vec<f32> {
            centroid
                .iter()
                .zip(&simplex[worst].1)
                .map(|(c, w)| c + t * (c - w))
                .collect()
        };
        let reflected = along(1.);
        let reflected_value = objective(&reflected);
        if reflected_value < simplex[0].0 {
            let expanded = along(2.);
            let expanded_value = objective(&expanded);
            simplex[worst] = if expanded_value < reflected_value {
                (expanded_value, expanded)
            } else {
                (reflected_value, reflected)
            };
        } else if reflected_value < simplex[worst - 1].0 {
            simplex[worst] = (reflected_value, reflected);
        } else {
            let contracted = along(-0.5);
            let contracted_value = objective(&contracted);
            if contracted_value < simplex[worst].0 {
                simplex[worst] = (contracted_value, contracted);
            } else {
                let best = simplex[0].1.clone();
                for vertex in simplex.iter_mut().skip(1) {
                    let shrunk: Vec<f32> =
                        best.iter().zip(&vertex.1).map(|(b, v)| b + 0.5 * (v - b)).collect();
                    *vertex = (objective(&shrunk), shrunk);
                }
            }
        }
    }
    simplex.sort_by(|a, b| a.0.total_cmp(&b.0));
    simplex.swap_remove(0)
}

fn side_by_side(ours: &Rgba, apple: &Rgba, path: &Path) {
    let mut sheet = Rgba::solid(ours.width * 2, ours.height, [255.; 4]);
    for y in 0..ours.height {
        for x in 0..ours.width {
            sheet.set(x, y, apple.get(x, y));
            sheet.set(x + ours.width, y, ours.get(x, y));
        }
    }
    sheet.save(path).unwrap();
}
