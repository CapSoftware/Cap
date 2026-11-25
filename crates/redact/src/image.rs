#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    pub fn area(&self) -> f32 {
        self.w.max(0.0) * self.h.max(0.0)
    }

    pub fn clamp_to(&self, width: u32, height: u32) -> Self {
        let x0 = self.x.clamp(0.0, width as f32);
        let y0 = self.y.clamp(0.0, height as f32);
        let x1 = self.right().clamp(0.0, width as f32);
        let y1 = self.bottom().clamp(0.0, height as f32);
        Self::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
    }

    pub fn union(&self, other: &Self) -> Self {
        if self.area() <= 0.0 {
            return *other;
        }
        if other.area() <= 0.0 {
            return *self;
        }
        let x0 = self.x.min(other.x);
        let y0 = self.y.min(other.y);
        let x1 = self.right().max(other.right());
        let y1 = self.bottom().max(other.bottom());
        Self::new(x0, y0, x1 - x0, y1 - y0)
    }

    pub fn intersection(&self, other: &Self) -> f32 {
        let w = self.right().min(other.right()) - self.x.max(other.x);
        let h = self.bottom().min(other.bottom()) - self.y.max(other.y);
        w.max(0.0) * h.max(0.0)
    }

    pub fn iou(&self, other: &Self) -> f32 {
        let inter = self.intersection(other);
        let union = self.area() + other.area() - inter;
        if union <= 0.0 { 0.0 } else { inter / union }
    }

    pub fn expand(&self, dx: f32, dy: f32) -> Self {
        Self::new(
            self.x - dx,
            self.y - dy,
            self.w + 2.0 * dx,
            self.h + 2.0 * dy,
        )
    }

    pub fn scale(&self, factor: f32) -> Self {
        Self::new(
            self.x * factor,
            self.y * factor,
            self.w * factor,
            self.h * factor,
        )
    }

    pub fn translate(&self, dx: f32, dy: f32) -> Self {
        Self::new(self.x + dx, self.y + dy, self.w, self.h)
    }
}

/// Packed 8-bit RGB.
pub struct RgbImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    /// Pixel boxes (x0, y0, x1, y1) already converted by
    /// [`crate::frames::fill_rgb`], which it skips when asked again.
    pub(crate) filled: Vec<[usize; 4]>,
}

/// 8-bit luma.
#[derive(Clone)]
pub struct GrayImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl GrayImage {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; width as usize * height as usize],
        }
    }

    #[inline]
    pub fn get(&self, x: i32, y: i32) -> u8 {
        let x = x.clamp(0, self.width as i32 - 1) as usize;
        let y = y.clamp(0, self.height as i32 - 1) as usize;
        self.data[y * self.width as usize + x]
    }

    pub fn row(&self, y: usize) -> &[u8] {
        let w = self.width as usize;
        &self.data[y * w..(y + 1) * w]
    }
}

impl RgbImage {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; width as usize * height as usize * 3],
            filled: Vec::new(),
        }
    }

    /// BT.601 luma of the whole image.
    pub fn luma(&self) -> GrayImage {
        let mut out = GrayImage::new(self.width, self.height);
        for (pixel, value) in self.data.chunks_exact(3).zip(out.data.iter_mut()) {
            let y = 77 * u32::from(pixel[0]) + 150 * u32::from(pixel[1]) + 29 * u32::from(pixel[2]);
            *value = (y >> 8) as u8;
        }
        out
    }

    #[inline]
    fn pixel(&self, x: usize, y: usize) -> [f32; 3] {
        let index = (y * self.width as usize + x) * 3;
        [
            f32::from(self.data[index]),
            f32::from(self.data[index + 1]),
            f32::from(self.data[index + 2]),
        ]
    }

    /// Resamples `src` to `out_w` x `out_h` and writes planar channels into
    /// `planes` (row stride `stride`, plane size `plane`). Downscales with a
    /// box filter, upscales bilinearly.
    #[allow(clippy::too_many_arguments)]
    pub fn resize_into_planes(
        &self,
        src: Rect,
        out_w: usize,
        out_h: usize,
        stride: usize,
        plane: usize,
        planes: &mut [f32],
        map: impl Fn(usize, f32) -> f32,
    ) {
        self.resample(src, out_w, out_h, |ox, oy, value| {
            let index = oy * stride + ox;
            for (c, v) in value.iter().enumerate() {
                planes[c * plane + index] = map(c, *v);
            }
        });
    }

    /// [`Self::resize_into_planes`] into interleaved RGBA8 (row stride
    /// `stride` pixels), alpha opaque.
    pub fn resize_into_rgba(
        &self,
        src: Rect,
        out_w: usize,
        out_h: usize,
        stride: usize,
        rgba: &mut [u8],
    ) {
        let whole = |v: f32| v >= 0.0 && v.fract() == 0.0;
        if whole(src.x)
            && whole(src.y)
            && src.w as usize == out_w
            && src.h as usize == out_h
            && src.x as usize + out_w <= self.width as usize
            && src.y as usize + out_h <= self.height as usize
        {
            let (x0, y0) = (src.x as usize, src.y as usize);
            let width = self.width as usize;
            for oy in 0..out_h {
                let row =
                    &self.data[((y0 + oy) * width + x0) * 3..((y0 + oy) * width + x0 + out_w) * 3];
                let out = &mut rgba[oy * stride * 4..(oy * stride + out_w) * 4];
                for (pixel, dst) in row.chunks_exact(3).zip(out.chunks_exact_mut(4)) {
                    dst[..3].copy_from_slice(pixel);
                    dst[3] = 255;
                }
            }
            return;
        }
        self.resample(src, out_w, out_h, |ox, oy, value| {
            let index = (oy * stride + ox) * 4;
            for (c, v) in value.iter().enumerate() {
                rgba[index + c] = v.round().clamp(0.0, 255.0) as u8;
            }
            rgba[index + 3] = 255;
        });
    }

    fn resample(
        &self,
        src: Rect,
        out_w: usize,
        out_h: usize,
        mut put: impl FnMut(usize, usize, [f32; 3]),
    ) {
        if out_w == 0 || out_h == 0 || self.width == 0 || self.height == 0 {
            return;
        }
        let max_x = self.width as usize - 1;
        let max_y = self.height as usize - 1;
        let sx = src.w / out_w as f32;
        let sy = src.h / out_h as f32;
        for oy in 0..out_h {
            let y0 = src.y + oy as f32 * sy;
            let y1 = y0 + sy;
            for ox in 0..out_w {
                let x0 = src.x + ox as f32 * sx;
                let x1 = x0 + sx;
                let value = if sx > 1.0 || sy > 1.0 {
                    let xa = (x0.floor() as usize).min(max_x);
                    let xb = ((x1.ceil() as usize).max(xa + 1)).min(max_x + 1);
                    let ya = (y0.floor() as usize).min(max_y);
                    let yb = ((y1.ceil() as usize).max(ya + 1)).min(max_y + 1);
                    let step_x = ((xb - xa) / 4).max(1);
                    let step_y = ((yb - ya) / 4).max(1);
                    let mut sum = [0.0f32; 3];
                    let mut count = 0.0;
                    let mut y = ya;
                    while y < yb {
                        let mut x = xa;
                        while x < xb {
                            let p = self.pixel(x, y);
                            sum[0] += p[0];
                            sum[1] += p[1];
                            sum[2] += p[2];
                            count += 1.0;
                            x += step_x;
                        }
                        y += step_y;
                    }
                    [sum[0] / count, sum[1] / count, sum[2] / count]
                } else {
                    let fx = (x0 + sx * 0.5 - 0.5).clamp(0.0, max_x as f32);
                    let fy = (y0 + sy * 0.5 - 0.5).clamp(0.0, max_y as f32);
                    let ix = fx as usize;
                    let iy = fy as usize;
                    let ax = fx - ix as f32;
                    let ay = fy - iy as f32;
                    let ix1 = (ix + 1).min(max_x);
                    let iy1 = (iy + 1).min(max_y);
                    let p00 = self.pixel(ix, iy);
                    let p10 = self.pixel(ix1, iy);
                    let p01 = self.pixel(ix, iy1);
                    let p11 = self.pixel(ix1, iy1);
                    let mut out = [0.0f32; 3];
                    for c in 0..3 {
                        let top = p00[c] + (p10[c] - p00[c]) * ax;
                        let bottom = p01[c] + (p11[c] - p01[c]) * ax;
                        out[c] = top + (bottom - top) * ay;
                    }
                    out
                };
                put(ox, oy, value);
            }
        }
    }

    /// Splits a line rect into pieces no wider than `max_w`, cutting at the
    /// emptiest column near each limit so words stay whole where possible.
    pub fn split_for_width(&self, rect: Rect, max_w: f32) -> Vec<Rect> {
        if rect.w <= max_w {
            return vec![rect];
        }
        let mut pieces = Vec::new();
        let mut start = rect.x;
        let end = rect.right();
        let y0 = rect.y.max(0.0) as usize;
        let y1 = (rect.bottom() as usize).min(self.height as usize);
        while end - start > max_w {
            let lo = (start + max_w * 0.7) as usize;
            let hi = ((start + max_w) as usize).min(self.width as usize - 1);
            let mut best = hi;
            let mut best_ink = f32::MAX;
            for x in lo..=hi {
                let mut min = 255.0f32;
                let mut max = 0.0f32;
                for y in y0..y1 {
                    let p = self.pixel(x, y);
                    let l = 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];
                    min = min.min(l);
                    max = max.max(l);
                }
                let ink = max - min;
                if ink < best_ink {
                    best_ink = ink;
                    best = x;
                }
            }
            let cut = (best as f32).max(start + 8.0);
            pieces.push(Rect::new(start, rect.y, cut - start, rect.h));
            start = cut;
        }
        pieces.push(Rect::new(start, rect.y, end - start, rect.h));
        pieces
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unscaled_regions_copy_exactly_what_resampling_gives() {
        let mut image = RgbImage::new(37, 21);
        for (i, value) in image.data.iter_mut().enumerate() {
            *value = (i * 7 % 251) as u8;
        }
        let rect = Rect::new(5.0, 3.0, 20.0, 11.0);
        let mut fast = vec![0u8; 24 * 11 * 4];
        image.resize_into_rgba(rect, 20, 11, 24, &mut fast);
        let mut slow = vec![0u8; 24 * 11 * 4];
        image.resample(rect, 20, 11, |ox, oy, value| {
            let index = (oy * 24 + ox) * 4;
            for (c, v) in value.iter().enumerate() {
                slow[index + c] = v.round().clamp(0.0, 255.0) as u8;
            }
            slow[index + 3] = 255;
        });
        assert_eq!(fast, slow);
    }

    #[test]
    fn rect_math() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 5.0, 10.0, 10.0);
        assert_eq!(a.intersection(&b), 25.0);
        assert!((a.iou(&b) - 25.0 / 175.0).abs() < 1e-6);
        assert_eq!(a.union(&b), Rect::new(0.0, 0.0, 15.0, 15.0));
        assert_eq!(
            Rect::new(-5.0, 2.0, 20.0, 4.0).clamp_to(10, 10),
            Rect::new(0.0, 2.0, 10.0, 4.0)
        );
    }

    #[test]
    fn long_lines_split_at_gaps() {
        let mut image = RgbImage::new(200, 10);
        image.data.fill(255);
        for x in (0..200).filter(|x| x % 20 < 15) {
            for y in 2..8 {
                let i = (y * 200 + x) * 3;
                image.data[i..i + 3].fill(0);
            }
        }
        let pieces = image.split_for_width(Rect::new(0.0, 0.0, 200.0, 10.0), 70.0);
        assert!(pieces.len() >= 3);
        for piece in &pieces {
            assert!(piece.w <= 70.0 + 1e-3);
        }
        for piece in &pieces[1..] {
            assert!(piece.x as usize % 20 >= 15, "{piece:?}");
        }
    }
}
