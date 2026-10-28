use crate::{Rgba, Shape};

/// Logical size of every scene; the probe window and the reference capture
/// share it.
pub const CANVAS: (f32, f32) = (960., 600.);

/// The panes the probe and the reference capture lay over each scene, in
/// logical pixels with a top-left origin.
pub const SHAPES: [Shape; 5] = [
    Shape {
        x: 60.,
        y: 60.,
        width: 320.,
        height: 120.,
        radius: 60.,
    },
    Shape {
        x: 460.,
        y: 60.,
        width: 420.,
        height: 240.,
        radius: 24.,
    },
    Shape {
        x: 60.,
        y: 260.,
        width: 300.,
        height: 48.,
        radius: 24.,
    },
    Shape {
        x: 120.,
        y: 380.,
        width: 96.,
        height: 96.,
        radius: 48.,
    },
    Shape {
        x: 460.,
        y: 380.,
        width: 360.,
        height: 160.,
        radius: 16.,
    },
];

/// Backdrops that render identically everywhere (no text, so no fonts).
pub const NAMES: [&str; 9] = [
    "white", "black", "gray", "stripes", "grid", "checker", "hues", "blobs", "split",
];

/// Render `name` at `scale` device pixels per logical pixel.
pub fn render(name: &str, scale: f32) -> Option<Rgba> {
    let (width, height) = ((CANVAS.0 * scale).round() as usize, (CANVAS.1 * scale).round() as usize);
    let mut image = Rgba::solid(width, height, [255.; 4]);
    for y in 0..height {
        for x in 0..width {
            let (lx, ly) = ((x as f32 + 0.5) / scale, (y as f32 + 0.5) / scale);
            image.set(x, y, pixel(name, lx, ly)?);
        }
    }
    Some(image)
}

fn pixel(name: &str, x: f32, y: f32) -> Option<[f32; 4]> {
    let gray = |value: f32| [value, value, value, 255.];
    Some(match name {
        "white" => gray(255.),
        "black" => gray(0.),
        "gray" => gray(128.),
        "stripes" => gray(if (x / 8.).floor() as i64 % 2 == 0 { 0. } else { 255. }),
        "grid" => {
            let on_line = |v: f32| (v + 1.).rem_euclid(24.) < 2.;
            if on_line(x) || on_line(y) {
                [26., 77., 230., 255.]
            } else {
                [245., 245., 247., 255.]
            }
        }
        "checker" => {
            if ((x / 32.).floor() as i64 + (y / 32.).floor() as i64) % 2 == 0 {
                [242., 82., 51., 255.]
            } else {
                [31., 140., 242., 255.]
            }
        }
        "hues" => {
            let hue = (x / CANVAS.0).clamp(0., 1.) * 6.;
            let f = |n: f32| {
                let k = (n + hue) % 6.;
                242. * (1. - 0.85 * (k.min(4. - k).clamp(0., 1.)))
            };
            [f(5.), f(3.), f(1.), 255.]
        }
        "blobs" => {
            let mut color = [250., 240., 224.];
            for (fx, fy, radius, blob) in [
                (0.2, 0.7, 260., [255., 89., 115.]),
                (0.7, 0.75, 300., [64., 140., 255.]),
                (0.5, 0.2, 280., [51., 217., 140.]),
                (0.9, 0.2, 220., [255., 204., 51.]),
            ] {
                let d = ((x - fx * CANVAS.0).powi(2) + (y - fy * CANVAS.1).powi(2)).sqrt();
                let t = (1. - d / radius).clamp(0., 1.);
                for i in 0..3 {
                    color[i] += (blob[i] - color[i]) * t;
                }
            }
            [color[0], color[1], color[2], 255.]
        }
        "split" => {
            let white = y < CANVAS.1 / 2. || x < 170. || x >= 670.;
            gray(if white { 255. } else { 0. })
        }
        _ => return None,
    })
}
