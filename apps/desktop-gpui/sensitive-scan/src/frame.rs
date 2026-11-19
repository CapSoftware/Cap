#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    pub fn new(x0: f32, y0: f32, x1: f32, y1: f32) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub fn width(&self) -> f32 {
        (self.x1 - self.x0).max(0.0)
    }

    pub fn height(&self) -> f32 {
        (self.y1 - self.y0).max(0.0)
    }

    pub fn area(&self) -> f32 {
        self.width() * self.height()
    }

    pub fn center(&self) -> (f32, f32) {
        ((self.x0 + self.x1) / 2.0, (self.y0 + self.y1) / 2.0)
    }

    pub fn union(&self, other: &Rect) -> Rect {
        Rect::new(
            self.x0.min(other.x0),
            self.y0.min(other.y0),
            self.x1.max(other.x1),
            self.y1.max(other.y1),
        )
    }

    pub fn intersection(&self, other: &Rect) -> Rect {
        Rect::new(
            self.x0.max(other.x0),
            self.y0.max(other.y0),
            self.x1.min(other.x1),
            self.y1.min(other.y1),
        )
    }

    pub fn iou(&self, other: &Rect) -> f32 {
        let shared = self.intersection(other).area();
        let total = self.area() + other.area() - shared;
        if total <= 0.0 { 0.0 } else { shared / total }
    }

    pub fn expanded(&self, x: f32, y: f32) -> Rect {
        Rect::new(self.x0 - x, self.y0 - y, self.x1 + x, self.y1 + y)
    }

    pub fn scaled(&self, sx: f32, sy: f32) -> Rect {
        Rect::new(self.x0 * sx, self.y0 * sy, self.x1 * sx, self.y1 * sy)
    }

    pub(crate) fn moved(&self, dx: f32, dy: f32, scale: f32) -> Rect {
        let (cx, cy) = self.center();
        let half_w = self.width() * scale / 2.0;
        let half_h = self.height() * scale / 2.0;
        Rect::new(
            cx + dx - half_w,
            cy + dy - half_h,
            cx + dx + half_w,
            cy + dy + half_h,
        )
    }
}

#[derive(Clone)]
pub struct LumaFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

impl LumaFrame {
    pub fn new(width: u32, height: u32, pixels: Vec<u8>) -> Self {
        assert_eq!(pixels.len(), width as usize * height as usize);
        Self {
            width,
            height,
            pixels,
        }
    }

    pub fn from_rgba(width: u32, height: u32, stride: usize, rgba: &[u8]) -> Self {
        let mut pixels = Vec::with_capacity(width as usize * height as usize);
        for row in rgba.chunks(stride).take(height as usize) {
            let (rgba, _) = row[..width as usize * 4].as_chunks::<4>();
            pixels.extend(rgba.iter().map(|&[r, g, b, _]| {
                ((u32::from(r) * 77 + u32::from(g) * 150 + u32::from(b) * 29) >> 8) as u8
            }));
        }
        Self::new(width, height, pixels)
    }

    pub fn downscaled(&self, max_width: u32) -> LumaFrame {
        let factor = self.width.div_ceil(max_width.max(1)).max(1);
        if factor == 1 {
            return self.clone();
        }
        let width = self.width / factor;
        let height = self.height / factor;
        let area = factor * factor;
        let mut pixels = Vec::with_capacity(width as usize * height as usize);
        for y in 0..height {
            for x in 0..width {
                let mut sum = 0u32;
                for sy in 0..factor {
                    let row = ((y * factor + sy) * self.width + x * factor) as usize;
                    sum += self.pixels[row..row + factor as usize]
                        .iter()
                        .map(|value| u32::from(*value))
                        .sum::<u32>();
                }
                pixels.push((sum / area) as u8);
            }
        }
        LumaFrame::new(width, height, pixels)
    }

    pub(crate) fn at(&self, x: i32, y: i32) -> Option<u8> {
        (x >= 0 && y >= 0 && (x as u32) < self.width && (y as u32) < self.height)
            .then(|| self.pixels[y as usize * self.width as usize + x as usize])
    }

    pub(crate) fn sample(&self, x: f32, y: f32) -> u8 {
        let x = x.clamp(0.0, (self.width - 1) as f32);
        let y = y.clamp(0.0, (self.height - 1) as f32);
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = (
            (x0 + 1).min(self.width as usize - 1),
            (y0 + 1).min(self.height as usize - 1),
        );
        let (fx, fy) = (x - x0 as f32, y - y0 as f32);
        let width = self.width as usize;
        let at = |x: usize, y: usize| f32::from(self.pixels[y * width + x]);
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
        let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
        (top + (bottom - top) * fy).round() as u8
    }

    pub(crate) fn bounds(&self) -> Rect {
        Rect::new(0.0, 0.0, self.width as f32, self.height as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rgba_converts_to_luma_and_downscales_by_box_filter() {
        let rgba = [
            255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255,
        ];
        let frame = LumaFrame::from_rgba(2, 2, 8, &rgba);
        assert_eq!(frame.pixels, vec![255, 0, 76, 28]);
        let small = frame.downscaled(1);
        assert_eq!((small.width, small.height), (1, 1));
        assert_eq!(small.pixels, vec![89]);
    }

    #[test]
    fn rect_geometry() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 0.0, 15.0, 10.0);
        assert!((a.iou(&b) - 1.0 / 3.0).abs() < 1e-6);
        assert_eq!(a.moved(2.0, 3.0, 2.0), Rect::new(-3.0, -2.0, 17.0, 18.0));
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 15.0, 10.0));
    }
}
