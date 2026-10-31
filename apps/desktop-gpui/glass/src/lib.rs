//! Cap Glass: the glass material's math, shared by the GPU shaders (Metal,
//! HLSL, WGSL in the gpui patch) and the CPU reference renderer that the
//! comparison harness fits against Apple's own glass.

pub mod metrics;
pub mod model;
pub mod scenes;

use std::path::Path;

/// The fitted materials, keyed `regular-light`, `regular-dark`,
/// `clear-light` and `clear-dark` (see `glass-fit`).
pub const PRESETS_JSON: &str = include_str!("../presets.json");

/// An RGBA image with 0-255 float channels, non-premultiplied.
#[derive(Clone)]
pub struct Rgba {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<f32>,
}

impl Rgba {
    pub fn solid(width: usize, height: usize, color: [f32; 4]) -> Self {
        Self {
            width,
            height,
            pixels: color.repeat(width * height),
        }
    }

    pub fn load(path: &Path) -> image::ImageResult<Self> {
        let image = image::open(path)?.to_rgba8();
        Ok(Self {
            width: image.width() as usize,
            height: image.height() as usize,
            pixels: image.as_raw().iter().map(|value| *value as f32).collect(),
        })
    }

    pub fn save(&self, path: &Path) -> image::ImageResult<()> {
        let bytes: Vec<u8> = self
            .pixels
            .iter()
            .map(|value| value.round().clamp(0., 255.) as u8)
            .collect();
        image::RgbaImage::from_raw(self.width as u32, self.height as u32, bytes)
            .expect("pixel buffer matches its size")
            .save(path)
    }

    pub fn get(&self, x: usize, y: usize) -> [f32; 4] {
        let index = (y * self.width + x) * 4;
        [
            self.pixels[index],
            self.pixels[index + 1],
            self.pixels[index + 2],
            self.pixels[index + 3],
        ]
    }

    pub fn set(&mut self, x: usize, y: usize, color: [f32; 4]) {
        let index = (y * self.width + x) * 4;
        self.pixels[index..index + 4].copy_from_slice(&color);
    }

    /// Bilinear sample with clamped edges, in pixel coordinates (pixel
    /// centres at +0.5).
    pub fn sample(&self, x: f32, y: f32) -> [f32; 4] {
        let fx = (x - 0.5).clamp(0., (self.width - 1) as f32);
        let fy = (y - 0.5).clamp(0., (self.height - 1) as f32);
        let (x0, y0) = (fx.floor() as usize, fy.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(self.width - 1), (y0 + 1).min(self.height - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let (a, b, c, d) = (self.get(x0, y0), self.get(x1, y0), self.get(x0, y1), self.get(x1, y1));
        std::array::from_fn(|i| {
            let top = a[i] + (b[i] - a[i]) * tx;
            let bottom = c[i] + (d[i] - c[i]) * tx;
            top + (bottom - top) * ty
        })
    }

    pub fn blurred(&self, sigma: f32) -> Self {
        if sigma < 0.5 {
            return self.clone();
        }
        let radius = (sigma * 3.).ceil() as usize;
        let kernel = metrics::gaussian_kernel(sigma as f64, radius);
        let mut out = self.clone();
        for channel in 0..4 {
            let values: Vec<f64> = self
                .pixels
                .iter()
                .skip(channel)
                .step_by(4)
                .map(|value| *value as f64)
                .collect();
            let blurred = metrics::separable_blur(&values, self.width, self.height, &kernel);
            for (index, value) in blurred.into_iter().enumerate() {
                out.pixels[index * 4 + channel] = value as f32;
            }
        }
        out
    }
}

/// A rounded rectangle in pixels, top-left origin.
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct Shape {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub radius: f32,
}

impl Shape {
    /// Signed distance to the rounded rectangle's edge, negative inside.
    pub fn sdf(&self, px: f32, py: f32) -> f32 {
        let radius = self.radius.min(self.width / 2.).min(self.height / 2.);
        let cx = px - (self.x + self.width / 2.);
        let cy = py - (self.y + self.height / 2.);
        let qx = cx.abs() - (self.width / 2. - radius);
        let qy = cy.abs() - (self.height / 2. - radius);
        let outside = (qx.max(0.).powi(2) + qy.max(0.).powi(2)).sqrt();
        outside + qx.max(qy).min(0.) - radius
    }

    pub fn normal(&self, px: f32, py: f32) -> (f32, f32) {
        let e = 0.5;
        let dx = self.sdf(px + e, py) - self.sdf(px - e, py);
        let dy = self.sdf(px, py + e) - self.sdf(px, py - e);
        let length = (dx * dx + dy * dy).sqrt().max(1e-6);
        (dx / length, dy / length)
    }

    pub fn mask(&self, width: usize, height: usize, inset: f32) -> Vec<bool> {
        (0..width * height)
            .map(|index| {
                let (x, y) = ((index % width) as f32 + 0.5, (index / width) as f32 + 0.5);
                self.sdf(x, y) < -inset
            })
            .collect()
    }
}
