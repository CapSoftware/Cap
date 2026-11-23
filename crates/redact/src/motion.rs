use crate::image::{GrayImage, Rect};

pub const TILE: usize = 16;
const PIXEL_DELTA: i16 = 22;
const CHANGED_PIXELS: u32 = 3;

/// Which 16x16 tiles of a track-resolution frame changed.
#[derive(Clone, Debug, PartialEq)]
pub struct ChangeMap {
    pub cols: usize,
    pub rows: usize,
    pub bits: Vec<bool>,
}

impl ChangeMap {
    pub fn new(width: u32, height: u32) -> Self {
        let cols = (width as usize).div_ceil(TILE);
        let rows = (height as usize).div_ceil(TILE);
        Self {
            cols,
            rows,
            bits: vec![false; cols * rows],
        }
    }

    pub fn full(width: u32, height: u32) -> Self {
        let mut map = Self::new(width, height);
        map.bits.fill(true);
        map
    }

    pub fn is_empty(&self) -> bool {
        !self.bits.iter().any(|b| *b)
    }

    pub fn count(&self) -> usize {
        self.bits.iter().filter(|b| **b).count()
    }

    pub fn fraction(&self) -> f32 {
        self.count() as f32 / self.bits.len().max(1) as f32
    }

    pub fn clear(&mut self) {
        self.bits.fill(false);
    }

    pub fn merge(&mut self, other: &Self) {
        for (a, b) in self.bits.iter_mut().zip(&other.bits) {
            *a |= *b;
        }
    }

    pub fn mark_rect(&mut self, rect: Rect) {
        let x0 = (rect.x.max(0.0) as usize / TILE).min(self.cols.saturating_sub(1));
        let y0 = (rect.y.max(0.0) as usize / TILE).min(self.rows.saturating_sub(1));
        let x1 = ((rect.right().max(0.0) as usize) / TILE).min(self.cols.saturating_sub(1));
        let y1 = ((rect.bottom().max(0.0) as usize) / TILE).min(self.rows.saturating_sub(1));
        for y in y0..=y1 {
            for x in x0..=x1 {
                self.bits[y * self.cols + x] = true;
            }
        }
    }

    pub fn intersects(&self, rect: Rect) -> bool {
        if rect.right() < 0.0 || rect.bottom() < 0.0 {
            return false;
        }
        let x0 = (rect.x.max(0.0) as usize / TILE).min(self.cols.saturating_sub(1));
        let y0 = (rect.y.max(0.0) as usize / TILE).min(self.rows.saturating_sub(1));
        let x1 = ((rect.right() as usize) / TILE).min(self.cols.saturating_sub(1));
        let y1 = ((rect.bottom() as usize) / TILE).min(self.rows.saturating_sub(1));
        (y0..=y1).any(|y| (x0..=x1).any(|x| self.bits[y * self.cols + x]))
    }

    pub fn bounds(&self) -> Option<Rect> {
        let mut found = None::<(usize, usize, usize, usize)>;
        for y in 0..self.rows {
            for x in 0..self.cols {
                if self.bits[y * self.cols + x] {
                    found = Some(match found {
                        None => (x, y, x, y),
                        Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x), y1.max(y)),
                    });
                }
            }
        }
        found.map(|(x0, y0, x1, y1)| {
            Rect::new(
                (x0 * TILE) as f32,
                (y0 * TILE) as f32,
                ((x1 - x0 + 1) * TILE) as f32,
                ((y1 - y0 + 1) * TILE) as f32,
            )
        })
    }

    /// Bounding boxes of groups of changed tiles, grouping tiles within
    /// `gap` tiles of each other, so two edits far apart are detected as two
    /// small areas instead of one large one.
    pub fn clusters(&self, gap: usize) -> Vec<Rect> {
        let mut seen = vec![false; self.bits.len()];
        let mut clusters = Vec::new();
        let mut stack = Vec::new();
        for start in 0..self.bits.len() {
            if !self.bits[start] || seen[start] {
                continue;
            }
            seen[start] = true;
            stack.push(start);
            let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
            while let Some(index) = stack.pop() {
                let (x, y) = (index % self.cols, index / self.cols);
                x0 = x0.min(x);
                y0 = y0.min(y);
                x1 = x1.max(x);
                y1 = y1.max(y);
                let ny0 = y.saturating_sub(gap);
                let ny1 = (y + gap).min(self.rows - 1);
                let nx0 = x.saturating_sub(gap);
                let nx1 = (x + gap).min(self.cols - 1);
                for ny in ny0..=ny1 {
                    for nx in nx0..=nx1 {
                        let n = ny * self.cols + nx;
                        if self.bits[n] && !seen[n] {
                            seen[n] = true;
                            stack.push(n);
                        }
                    }
                }
            }
            clusters.push(Rect::new(
                (x0 * TILE) as f32,
                (y0 * TILE) as f32,
                ((x1 - x0 + 1) * TILE) as f32,
                ((y1 - y0 + 1) * TILE) as f32,
            ));
        }
        clusters
    }
}

pub fn diff_tiles(previous: &GrayImage, current: &GrayImage) -> ChangeMap {
    let mut map = ChangeMap::new(current.width, current.height);
    if previous.width != current.width || previous.height != current.height {
        map.bits.fill(true);
        return map;
    }
    let width = current.width as usize;
    let height = current.height as usize;
    let mut counts = vec![0u32; map.cols];
    for ty in 0..map.rows {
        counts.fill(0);
        let y_end = ((ty + 1) * TILE).min(height);
        for y in ty * TILE..y_end {
            let a = &previous.data[y * width..(y + 1) * width];
            let b = &current.data[y * width..(y + 1) * width];
            for (tx, count) in counts.iter_mut().enumerate() {
                if *count >= CHANGED_PIXELS {
                    continue;
                }
                let x0 = tx * TILE;
                let x1 = (x0 + TILE).min(width);
                for x in x0..x1 {
                    if (i16::from(a[x]) - i16::from(b[x])).abs() > PIXEL_DELTA {
                        *count += 1;
                    }
                }
            }
        }
        for (tx, count) in counts.iter().enumerate() {
            map.bits[ty * map.cols + tx] = *count >= CHANGED_PIXELS;
        }
    }
    map
}

/// The dominant translation of `area` from `previous` to `current`, from
/// row and column intensity profiles (scrolling, dragged windows). `None`
/// when no shift explains the change better than no motion.
pub fn estimate_shift(
    previous: &GrayImage,
    current: &GrayImage,
    area: Rect,
    radius: i32,
) -> Option<(f32, f32)> {
    let area = area.clamp_to(current.width, current.height);
    let (x0, y0) = (area.x as usize, area.y as usize);
    let (x1, y1) = (area.right() as usize, area.bottom() as usize);
    if x1 <= x0 + 8 || y1 <= y0 + 8 {
        return None;
    }
    let row_profile = |image: &GrayImage| -> Vec<i32> {
        (0..image.height as usize)
            .map(|y| {
                let row = image.row(y);
                row[x0..x1].iter().map(|v| i32::from(*v)).sum::<i32>() / (x1 - x0) as i32
            })
            .collect()
    };
    let col_profile = |image: &GrayImage| -> Vec<i32> {
        let mut sums = vec![0i32; image.width as usize];
        for y in y0..y1 {
            for (x, v) in image.row(y).iter().enumerate() {
                sums[x] += i32::from(*v);
            }
        }
        sums.iter().map(|s| s / (y1 - y0) as i32).collect()
    };
    let dy = best_offset(
        &row_profile(previous),
        &row_profile(current),
        y0,
        y1,
        radius,
    );
    let dx = best_offset(
        &col_profile(previous),
        &col_profile(current),
        x0,
        x1,
        radius,
    );
    let (dx, dy) = (dx.unwrap_or(0), dy.unwrap_or(0));
    if dx == 0 && dy == 0 {
        return None;
    }
    let still = region_sad(previous, current, area, 0, 0);
    let moved = region_sad(previous, current, area, dx, dy);
    (moved * 2 < still).then_some((dx as f32, dy as f32))
}

fn best_offset(a: &[i32], b: &[i32], start: usize, end: usize, radius: i32) -> Option<i32> {
    let mut best = None::<(i32, f64)>;
    for offset in -radius..=radius {
        let mut sad = 0i64;
        let mut count = 0i64;
        for (i, value) in b.iter().enumerate().take(end).skip(start) {
            let j = i as i32 - offset;
            if j < 0 || j as usize >= a.len() {
                continue;
            }
            sad += i64::from((value - a[j as usize]).abs());
            count += 1;
        }
        if count < ((end - start) / 2) as i64 {
            continue;
        }
        let cost = sad as f64 / count as f64 + f64::from(offset.abs()) * 0.01;
        if best.is_none_or(|(_, c)| cost < c) {
            best = Some((offset, cost));
        }
    }
    best.map(|(offset, _)| offset)
}

/// The translation within `radius` of `guess` that best maps `previous` onto
/// `current` over `area`, by direct comparison. Used to correct a shift
/// summed from frame-to-frame estimates, which drifts by a pixel or two.
pub fn refine_shift(
    previous: &GrayImage,
    current: &GrayImage,
    area: Rect,
    guess: (i32, i32),
    radius: i32,
) -> (i32, i32) {
    let area = area.clamp_to(current.width, current.height);
    let mut best = (guess, u64::MAX);
    for dy in guess.1 - radius..=guess.1 + radius {
        for dx in guess.0 - radius..=guess.0 + radius {
            let sad = region_sad(previous, current, area, dx, dy);
            if sad < best.1 {
                best = ((dx, dy), sad);
            }
        }
    }
    best.0
}

fn region_sad(previous: &GrayImage, current: &GrayImage, area: Rect, dx: i32, dy: i32) -> u64 {
    let mut sad = 0u64;
    let step = 2;
    let mut y = area.y as i32;
    while y < area.bottom() as i32 {
        let mut x = area.x as i32;
        while x < area.right() as i32 {
            let a = previous.get(x - dx, y - dy);
            let b = current.get(x, y);
            sad += u64::from(a.abs_diff(b));
            x += step;
        }
        y += step;
    }
    sad
}

/// A patch cut from a track-resolution frame, matched by zero-mean
/// normalised cross-correlation.
#[derive(Clone, Debug)]
pub struct Patch {
    pub w: usize,
    pub h: usize,
    pixels: Vec<f32>,
    norm: f32,
}

impl Patch {
    pub fn cut(image: &GrayImage, rect: Rect) -> Option<Self> {
        let rect = rect.clamp_to(image.width, image.height);
        let w = rect.w.round() as usize;
        let h = rect.h.round() as usize;
        if w < 3 || h < 3 {
            return None;
        }
        let (x0, y0) = (rect.x.round() as i32, rect.y.round() as i32);
        let mut pixels = Vec::with_capacity(w * h);
        for y in 0..h as i32 {
            for x in 0..w as i32 {
                pixels.push(f32::from(image.get(x0 + x, y0 + y)));
            }
        }
        let mean = pixels.iter().sum::<f32>() / pixels.len() as f32;
        for p in &mut pixels {
            *p -= mean;
        }
        let norm = pixels.iter().map(|p| p * p).sum::<f32>().sqrt();
        Some(Self { w, h, pixels, norm })
    }

    /// Variation inside the patch; flat patches cannot be tracked.
    pub fn contrast(&self) -> f32 {
        self.norm / (self.pixels.len() as f32).sqrt()
    }

    /// Prefix of the patch (left `fraction` of its width).
    pub fn prefix(image: &GrayImage, rect: Rect, fraction: f32) -> Option<Self> {
        Self::cut(image, Rect::new(rect.x, rect.y, rect.w * fraction, rect.h))
    }

    pub fn score_at(&self, image: &GrayImage, x0: i32, y0: i32) -> f32 {
        if self.norm <= 1e-3 {
            return 0.0;
        }
        let inside = x0 >= 0
            && y0 >= 0
            && x0 as usize + self.w <= image.width as usize
            && y0 as usize + self.h <= image.height as usize;
        if !inside {
            return self.score_clipped(image, x0, y0);
        }
        let n = (self.w * self.h) as f32;
        let mut sum = 0.0f32;
        let mut sum_sq = 0.0f32;
        let mut cross = 0.0f32;
        let width = image.width as usize;
        for y in 0..self.h {
            let row = &image.data[(y0 as usize + y) * width + x0 as usize..][..self.w];
            let template = &self.pixels[y * self.w..(y + 1) * self.w];
            for (v, t) in row.iter().zip(template) {
                let v = f32::from(*v);
                sum += v;
                sum_sq += v * v;
                cross += v * t;
            }
        }
        let variance = sum_sq - sum * sum / n;
        if variance <= 1e-3 {
            return 0.0;
        }
        cross / (variance.sqrt() * self.norm)
    }

    /// The score over the part of the patch inside the frame, so text
    /// sliding off an edge keeps being followed while a third of it shows.
    fn score_clipped(&self, image: &GrayImage, x0: i32, y0: i32) -> f32 {
        let (mut n, mut sv, mut svv, mut st, mut stt, mut svt) = (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0);
        let width = image.width as i32;
        let height = image.height as i32;
        for y in 0..self.h as i32 {
            let iy = y0 + y;
            if iy < 0 || iy >= height {
                continue;
            }
            for x in 0..self.w as i32 {
                let ix = x0 + x;
                if ix < 0 || ix >= width {
                    continue;
                }
                let v = f32::from(image.data[(iy * width + ix) as usize]);
                let t = self.pixels[y as usize * self.w + x as usize];
                n += 1.0;
                sv += v;
                svv += v * v;
                st += t;
                stt += t * t;
                svt += v * t;
            }
        }
        if n < (self.w * self.h) as f32 * 0.3 {
            return 0.0;
        }
        let var_v = svv - sv * sv / n;
        let var_t = stt - st * st / n;
        if var_v <= 1e-3 || var_t <= 1e-3 {
            return 0.0;
        }
        (svt - sv * st / n) / (var_v * var_t).sqrt()
    }

    /// Best position near `(cx, cy)` (top-left) within `radius` pixels. Every
    /// offset is tried: thin glyph strokes at tracking resolution decorrelate
    /// within one pixel, so a coarse grid misses the peak.
    pub fn search(&self, image: &GrayImage, cx: f32, cy: f32, radius: i32) -> (f32, f32, f32) {
        let (cx, cy) = (cx.round() as i32, cy.round() as i32);
        let mut best = (cx, cy, self.score_at(image, cx, cy));
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                let score = self.score_at(image, cx + dx, cy + dy);
                if score > best.2 {
                    best = (cx + dx, cy + dy, score);
                }
            }
        }
        (best.0 as f32, best.1 as f32, best.2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn textured(width: u32, height: u32, shift_x: i32, shift_y: i32) -> GrayImage {
        let mut image = GrayImage::new(width, height);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let (sx, sy) = ((x - shift_x) as u32, (y - shift_y) as u32);
                let mut h = sx.wrapping_mul(0x9E37_79B1) ^ sy.wrapping_mul(0x85EB_CA77);
                h ^= h >> 15;
                h = h.wrapping_mul(0x2C1B_3C6D);
                h ^= h >> 12;
                let line = (sy / 3) % 5 < 3;
                image.data[(y as usize) * width as usize + x as usize] =
                    if line && h % 3 == 0 { 30 } else { 230 };
            }
        }
        image
    }

    #[test]
    fn unchanged_frames_have_no_changed_tiles() {
        let a = textured(200, 120, 0, 0);
        assert!(diff_tiles(&a, &a).is_empty());
        let b = textured(200, 120, 0, 3);
        assert!(!diff_tiles(&a, &b).is_empty());
    }

    #[test]
    fn scroll_shift_is_found() {
        let a = textured(320, 240, 0, 0);
        let b = textured(320, 240, 0, -9);
        let shift = estimate_shift(&a, &b, Rect::new(0.0, 0.0, 320.0, 240.0), 32).unwrap();
        assert_eq!(shift, (0.0, -9.0));
    }

    #[test]
    fn template_follows_motion() {
        let a = textured(320, 240, 0, 0);
        let b = textured(320, 240, 6, -11);
        let patch = Patch::cut(&a, Rect::new(100.0, 80.0, 60.0, 12.0)).unwrap();
        let (x, y, score) = patch.search(&b, 100.0, 80.0, 16);
        assert_eq!((x, y), (106.0, 69.0));
        assert!(score > 0.99);
    }

    #[test]
    fn template_follows_text_off_the_edge() {
        let a = textured(320, 240, 0, 0);
        let b = textured(320, 240, 40, 0);
        let patch = Patch::cut(&a, Rect::new(220.0, 80.0, 90.0, 12.0)).unwrap();
        let (x, y, score) = patch.search(&b, 255.0, 80.0, 8);
        assert_eq!((x, y), (260.0, 80.0));
        assert!(score > 0.99, "{score}");
    }

    #[test]
    fn clusters_split_far_apart_edits() {
        let mut map = ChangeMap::new(320, 320);
        map.mark_rect(Rect::new(0.0, 0.0, 20.0, 20.0));
        map.mark_rect(Rect::new(280.0, 280.0, 20.0, 20.0));
        assert_eq!(map.clusters(1).len(), 2);
        assert_eq!(map.clusters(30).len(), 1);
    }
}
