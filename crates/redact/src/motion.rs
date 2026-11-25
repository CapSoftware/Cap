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
                *count += a[x0..x1]
                    .iter()
                    .zip(&b[x0..x1])
                    .map(|(p, q)| u32::from(p.abs_diff(*q) > PIXEL_DELTA as u8))
                    .sum::<u32>();
            }
        }
        for (tx, count) in counts.iter().enumerate() {
            map.bits[ty * map.cols + tx] = *count >= CHANGED_PIXELS;
        }
    }
    map
}

/// Mean absolute difference over `area` (x0, y0, x1, y1) between `current`
/// and `previous` moved by `shift`.
pub fn mean_difference(
    previous: &GrayImage,
    current: &GrayImage,
    area: (usize, usize, usize, usize),
    shift: (i32, i32),
) -> u32 {
    let (x0, y0, x1, y1) = area;
    let width = current.width as usize;
    let mut sum = 0u32;
    for y in y0..y1 {
        let row = &current.data[y * width..(y + 1) * width];
        for (x, value) in row.iter().enumerate().take(x1).skip(x0) {
            let b = previous.get(x as i32 - shift.0, y as i32 - shift.1);
            sum += u32::from(value.abs_diff(b));
        }
    }
    sum / ((x1 - x0) * (y1 - y0)).max(1) as u32
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
    fn change_map_matches_the_pixel_rule() {
        let mut seed = 5u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            seed >> 16
        };
        for _ in 0..200 {
            let (w, h) = (1 + next() % 90, 1 + next() % 70);
            let a = GrayImage {
                width: w,
                height: h,
                data: (0..w * h).map(|_| next() as u8).collect(),
            };
            let mut b = a.clone();
            for _ in 0..next() % 40 {
                let i = next() as usize % b.data.len();
                b.data[i] = b.data[i].wrapping_add(10 + (next() % 30) as u8);
            }
            let mut expected = ChangeMap::new(w, h);
            // A tile changes when at least CHANGED_PIXELS of its pixels do.
            let mut counts = vec![0u32; expected.bits.len()];
            for y in 0..h as usize {
                for x in 0..w as usize {
                    let i = y * w as usize + x;
                    if (i16::from(a.data[i]) - i16::from(b.data[i])).abs() > PIXEL_DELTA {
                        counts[(y / TILE) * expected.cols + x / TILE] += 1;
                    }
                }
            }
            for (bit, count) in expected.bits.iter_mut().zip(counts) {
                *bit = count >= CHANGED_PIXELS;
            }
            assert_eq!(diff_tiles(&a, &b), expected);
        }
    }

    #[test]
    fn unchanged_frames_have_no_changed_tiles() {
        let a = textured(200, 120, 0, 0);
        assert!(diff_tiles(&a, &a).is_empty());
        let b = textured(200, 120, 0, 3);
        assert!(!diff_tiles(&a, &b).is_empty());
    }
}
