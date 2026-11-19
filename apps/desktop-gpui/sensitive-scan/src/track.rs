use crate::frame::{LumaFrame, Rect};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Motion {
    pub dx: f32,
    pub dy: f32,
    pub scale: f32,
}

impl Default for Motion {
    fn default() -> Self {
        Self {
            dx: 0.0,
            dy: 0.0,
            scale: 1.0,
        }
    }
}

impl Motion {
    pub fn reversed(self) -> Self {
        Self {
            dx: -self.dx,
            dy: -self.dy,
            scale: 1.0 / self.scale,
        }
    }
}

pub(crate) type CenterMove = ((f32, f32), (f32, f32), f32);

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Similarity {
    pub scale: f32,
    pub tx: f32,
    pub ty: f32,
}

impl Similarity {
    pub const IDENTITY: Self = Self {
        scale: 1.0,
        tx: 0.0,
        ty: 0.0,
    };

    pub fn fit(pairs: &[CenterMove]) -> Option<Self> {
        let median = |mut values: Vec<f32>| -> Option<f32> {
            values.sort_by(f32::total_cmp);
            values.get(values.len() / 2).copied()
        };
        let scale = median(pairs.iter().map(|pair| pair.2).collect())?;
        Some(Self {
            scale,
            tx: median(
                pairs
                    .iter()
                    .map(|(from, to, _)| to.0 - scale * from.0)
                    .collect(),
            )?,
            ty: median(
                pairs
                    .iter()
                    .map(|(from, to, _)| to.1 - scale * from.1)
                    .collect(),
            )?,
        })
    }

    pub fn inverse(self) -> Self {
        Self {
            scale: 1.0 / self.scale,
            tx: -self.tx / self.scale,
            ty: -self.ty / self.scale,
        }
    }

    pub fn motion_for(self, rect: Rect) -> Motion {
        let (cx, cy) = rect.center();
        Motion {
            dx: self.scale * cx + self.tx - cx,
            dy: self.scale * cy + self.ty - cy,
            scale: self.scale,
        }
    }
}

const MAX_SAMPLES: f32 = 1600.0;
const LOCAL_RADIUS: i32 = 16;
const MATCH_LIMIT: f32 = 0.4;
const MIN_VISIBLE: f32 = 0.3;
const QUICK_ACCEPT: f32 = 0.5;
const PLAUSIBLE_SLACK: f32 = 2.5;

struct Template {
    center: (f32, f32),
    points: Vec<(f32, f32, u8)>,
    contrast: f32,
}

impl Template {
    fn new(frame: &LumaFrame, rect: Rect) -> Option<Self> {
        let context = (rect.height() * 0.75 + 4.0).min(32.0);
        let wanted = rect.expanded(context, context);
        let visible = wanted.intersection(&frame.bounds());
        if visible.area() < wanted.area() * MIN_VISIBLE
            || rect.intersection(&frame.bounds()).area() < rect.area() * MIN_VISIBLE
        {
            return None;
        }
        let step = (visible.area() / MAX_SAMPLES).sqrt().max(1.0);
        let mut points = Vec::new();
        let mut y = visible.y0;
        while y < visible.y1 {
            let mut x = visible.x0;
            while x < visible.x1 {
                let (px, py) = (x.floor() as i32, y.floor() as i32);
                if let Some(value) = frame.at(px, py) {
                    points.push((px as f32, py as f32, value));
                }
                x += step;
            }
            y += step;
        }
        if points.len() < 16 {
            return None;
        }
        let mean = points.iter().map(|p| f32::from(p.2)).sum::<f32>() / points.len() as f32;
        let contrast = points
            .iter()
            .map(|p| (f32::from(p.2) - mean).abs())
            .sum::<f32>()
            / points.len() as f32;
        Some(Self {
            center: rect.center(),
            points,
            contrast,
        })
    }

    fn cost(&self, next: &LumaFrame, motion: Motion, stride: usize) -> f32 {
        let (cx, cy) = self.center;
        let mut total = 0u32;
        let mut counted = 0u32;
        for &(x, y, value) in self.points.iter().step_by(stride) {
            let tx = cx + motion.dx + (x - cx) * motion.scale;
            let ty = cy + motion.dy + (y - cy) * motion.scale;
            if let Some(other) = next.at(tx.round() as i32, ty.round() as i32) {
                total += u32::from(value.abs_diff(other));
                counted += 1;
            }
        }
        let expected = self.points.len().div_ceil(stride) as u32;
        if counted * 2 < expected {
            return f32::INFINITY;
        }
        total as f32 / counted as f32
    }

    fn best_in(
        &self,
        next: &LumaFrame,
        around: Motion,
        radius: (i32, i32),
        step: i32,
        stride: usize,
    ) -> (Motion, f32) {
        let mut best = (around, self.cost(next, around, stride));
        for oy in (-radius.1..=radius.1).step_by(step as usize) {
            for ox in (-radius.0..=radius.0).step_by(step as usize) {
                let candidate = Motion {
                    dx: around.dx + ox as f32,
                    dy: around.dy + oy as f32,
                    scale: around.scale,
                };
                let cost = self.cost(next, candidate, stride);
                if cost < best.1 {
                    best = (candidate, cost);
                }
            }
        }
        best
    }

    fn refine(&self, next: &LumaFrame, (motion, cost): (Motion, f32)) -> (Motion, f32) {
        let fine = self.best_in(next, motion, (2, 2), 1, 1);
        if fine.1 < cost { fine } else { (motion, cost) }
    }
}

pub(crate) fn plausible(prev: &LumaFrame, next: &LumaFrame, rect: Rect, motion: Motion) -> bool {
    Template::new(prev, rect).is_some_and(|template| {
        let limit = (template.contrast * MATCH_LIMIT).max(3.0);
        template.cost(next, motion, 1) <= limit * PLAUSIBLE_SLACK
    })
}

pub(crate) fn follow(
    prev: &LumaFrame,
    next: &LumaFrame,
    rect: Rect,
    guesses: &[Motion],
) -> Option<(Rect, Motion)> {
    let template = Template::new(prev, rect)?;
    let limit = (template.contrast * MATCH_LIMIT).max(3.0);
    let accept = |(motion, cost): (Motion, f32)| -> Option<(Rect, Motion)> {
        (cost <= limit).then(|| (rect.moved(motion.dx, motion.dy, motion.scale), motion))
    };
    let guess = guesses.first().copied().unwrap_or_default();

    let mut best = guesses
        .iter()
        .chain(std::iter::once(&Motion::default()))
        .map(|motion| (*motion, template.cost(next, *motion, 1)))
        .fold((guess, f32::INFINITY), |best, candidate| {
            if candidate.1 < best.1 {
                candidate
            } else {
                best
            }
        });
    if best.1 <= limit * QUICK_ACCEPT {
        return accept(template.refine(next, best));
    }
    let local = template.refine(
        next,
        template.best_in(next, guess, (LOCAL_RADIUS, LOCAL_RADIUS), 2, 2),
    );
    if local.1 < best.1 {
        best = local;
    }
    if best.1 <= limit {
        return accept(template.refine(next, best));
    }

    for factor in [0.97, 1.03, 0.94, 1.06] {
        let scaled = Motion {
            scale: guess.scale * factor,
            ..guess
        };
        let candidate = template.refine(
            next,
            template.best_in(next, scaled, (LOCAL_RADIUS, LOCAL_RADIUS), 2, 2),
        );
        if candidate.1 < best.1 {
            best = candidate;
        }
    }
    if best.1 <= limit {
        return accept(best);
    }

    let (half_prev, half_next) = (
        prev.downscaled(prev.width / 2),
        next.downscaled(next.width / 2),
    );
    let half_rect = rect.scaled(0.5, 0.5);
    if let Some(half) = Template::new(&half_prev, half_rect) {
        let wide = (half_next.width as i32 / 5, half_next.height as i32 / 3);
        let around = Motion {
            dx: guess.dx / 2.0,
            dy: guess.dy / 2.0,
            scale: 1.0,
        };
        let (coarse, _) = half.best_in(&half_next, around, wide, 1, 2);
        let lifted = Motion {
            dx: coarse.dx * 2.0,
            dy: coarse.dy * 2.0,
            scale: 1.0,
        };
        let candidate = template.refine(next, template.best_in(next, lifted, (2, 2), 1, 1));
        if candidate.1 < best.1 {
            best = candidate;
        }
    }
    accept(best)
}

const PATCH: i32 = 12;
const PATCH_RADIUS: i32 = 10;
const GRID: (u32, u32) = (8, 6);
const INLIER_ERROR: f32 = 1.5;
const MIN_INLIERS: usize = 6;

struct PatchMatch {
    from: (f32, f32),
    to: (f32, f32),
}

fn patch_cost(
    prev: &LumaFrame,
    next: &LumaFrame,
    from: (i32, i32),
    to: (i32, i32),
    limit: u32,
) -> u32 {
    let mut total = 0u32;
    for y in 0..PATCH {
        for x in 0..PATCH {
            let a = prev.at(from.0 + x, from.1 + y);
            let b = next.at(to.0 + x, to.1 + y);
            match (a, b) {
                (Some(a), Some(b)) => total += u32::from(a.abs_diff(b)),
                _ => return u32::MAX,
            }
            if total > limit {
                return total;
            }
        }
    }
    total
}

fn textured_patches(frame: &LumaFrame) -> Vec<((i32, i32), f32)> {
    let (cell_w, cell_h) = (frame.width / GRID.0, frame.height / GRID.1);
    let mut patches = Vec::new();
    for gy in 0..GRID.1 {
        for gx in 0..GRID.0 {
            let mut best = ((0, 0), 0.0f32);
            for y in (gy * cell_h..(gy + 1) * cell_h).step_by(4) {
                for x in (gx * cell_w..(gx + 1) * cell_w).step_by(4) {
                    let (x, y) = (x as i32, y as i32);
                    let mut energy = 0u32;
                    for py in (0..PATCH).step_by(2) {
                        for px in (0..PATCH).step_by(2) {
                            if let (Some(a), Some(r), Some(d)) = (
                                frame.at(x + px, y + py),
                                frame.at(x + px + 1, y + py),
                                frame.at(x + px, y + py + 1),
                            ) {
                                energy += u32::from(a.abs_diff(r)) + u32::from(a.abs_diff(d));
                            }
                        }
                    }
                    let energy = energy as f32 / 36.0;
                    if energy > best.1 {
                        best = ((x, y), energy);
                    }
                }
            }
            if best.1 >= 6.0 {
                patches.push(best);
            }
        }
    }
    patches
}

fn profile_shift(prev: &LumaFrame, next: &LumaFrame, vertical: bool) -> i32 {
    let (len, across) = if vertical {
        (prev.height as i32, prev.width as i32)
    } else {
        (prev.width as i32, prev.height as i32)
    };
    let profile = |frame: &LumaFrame| -> Vec<f32> {
        (0..len)
            .map(|i| {
                (0..across)
                    .step_by(3)
                    .filter_map(|j| {
                        if vertical {
                            frame.at(j, i)
                        } else {
                            frame.at(i, j)
                        }
                    })
                    .map(f32::from)
                    .sum::<f32>()
            })
            .collect()
    };
    let (a, b) = (profile(prev), profile(next));
    let max_shift = len / 3;
    let mut best = (0, f32::INFINITY);
    for shift in -max_shift..=max_shift {
        let overlap = (len - shift.abs()) as usize;
        let start_a = shift.max(0) as usize;
        let start_b = (-shift).max(0) as usize;
        let cost = a[start_a..start_a + overlap]
            .iter()
            .zip(&b[start_b..start_b + overlap])
            .map(|(x, y)| (x - y).abs())
            .sum::<f32>()
            / overlap as f32;
        if cost < best.1 {
            best = (shift, cost);
        }
    }
    -best.0
}

fn match_patches(
    prev: &LumaFrame,
    next: &LumaFrame,
    patches: &[((i32, i32), f32)],
    guess: Similarity,
) -> Vec<PatchMatch> {
    patches
        .iter()
        .filter_map(|&((x, y), energy)| {
            let center = (x as f32 + PATCH as f32 / 2.0, y as f32 + PATCH as f32 / 2.0);
            let predicted = (
                guess.scale * center.0 + guess.tx - PATCH as f32 / 2.0,
                guess.scale * center.1 + guess.ty - PATCH as f32 / 2.0,
            );
            let (px, py) = (predicted.0.round() as i32, predicted.1.round() as i32);
            let limit = (energy * 0.35 * (PATCH * PATCH) as f32) as u32;
            let mut best = ((0, 0), u32::MAX);
            for dy in -PATCH_RADIUS..=PATCH_RADIUS {
                for dx in -PATCH_RADIUS..=PATCH_RADIUS {
                    let cost =
                        patch_cost(prev, next, (x, y), (px + dx, py + dy), best.1.min(limit));
                    if cost < best.1 {
                        best = ((px + dx, py + dy), cost);
                    }
                }
            }
            (best.1 <= limit).then(|| PatchMatch {
                from: center,
                to: (
                    best.0.0 as f32 + PATCH as f32 / 2.0,
                    best.0.1 as f32 + PATCH as f32 / 2.0,
                ),
            })
        })
        .collect()
}

fn fit_matches(matches: &[PatchMatch]) -> Option<(Similarity, usize)> {
    let error = |model: &Similarity, m: &PatchMatch| {
        let x = model.scale * m.from.0 + model.tx;
        let y = model.scale * m.from.1 + model.ty;
        (x - m.to.0).abs().max((y - m.to.1).abs())
    };
    let mut best: Option<(Similarity, usize)> = None;
    for (i, a) in matches.iter().enumerate() {
        for b in matches.iter().skip(i + 1) {
            let from = ((a.from.0 - b.from.0).powi(2) + (a.from.1 - b.from.1).powi(2)).sqrt();
            let to = ((a.to.0 - b.to.0).powi(2) + (a.to.1 - b.to.1).powi(2)).sqrt();
            if from < 20.0 {
                continue;
            }
            let scale = to / from;
            if !(0.7..=1.43).contains(&scale) {
                continue;
            }
            let model = Similarity {
                scale,
                tx: a.to.0 - scale * a.from.0,
                ty: a.to.1 - scale * a.from.1,
            };
            let inliers = matches
                .iter()
                .filter(|m| error(&model, m) <= INLIER_ERROR)
                .count();
            if best.is_none_or(|(_, count)| inliers > count) {
                best = Some((model, inliers));
            }
        }
    }
    let (model, _) = best?;
    let inliers: Vec<&PatchMatch> = matches
        .iter()
        .filter(|m| error(&model, m) <= INLIER_ERROR * 2.0)
        .collect();
    let pairs: Vec<CenterMove> = inliers
        .iter()
        .map(|m| (m.from, m.to, model.scale))
        .collect();
    Some((Similarity::fit(&pairs)?, inliers.len()))
}

const TILE: u32 = 16;
const TILE_CHANGE: f32 = 12.0;
const TILE_CONTENT: u8 = 24;
const TILE_OFFSETS: [(f32, f32); 1] = [(0.0, 0.0)];

pub(crate) struct TileChange {
    pub changed: Vec<Rect>,
    pub content: usize,
}

pub(crate) fn changed_tiles(
    prev: &LumaFrame,
    next: &LumaFrame,
    motions: &[Similarity],
) -> TileChange {
    let backs: Vec<Similarity> = motions.iter().map(|motion| motion.inverse()).collect();
    let (max_x, max_y) = ((prev.width - 1) as f32, (prev.height - 1) as f32);
    let mut changed = Vec::new();
    let mut content = 0;
    for tile_y in 0..next.height / TILE {
        for tile_x in 0..next.width / TILE {
            let (x0, y0) = (tile_x * TILE, tile_y * TILE);
            let points: Vec<(f32, f32, u8)> = (y0..y0 + TILE)
                .step_by(2)
                .flat_map(|y| {
                    (x0..x0 + TILE).step_by(2).map(move |x| {
                        (
                            x as f32,
                            y as f32,
                            next.pixels[(y * next.width + x) as usize],
                        )
                    })
                })
                .collect();
            let low = points.iter().map(|point| point.2).min().unwrap_or(0);
            let high = points.iter().map(|point| point.2).max().unwrap_or(0);
            let mut best: Option<f32> = None;
            'search: for back in &backs {
                for (ox, oy) in TILE_OFFSETS {
                    let mut total = 0u32;
                    for &(x, y, target) in &points {
                        let sx = back.scale * x + back.tx + ox;
                        let sy = back.scale * y + back.ty + oy;
                        if !(0.0..=max_x).contains(&sx) || !(0.0..=max_y).contains(&sy) {
                            continue 'search;
                        }
                        total += u32::from(prev.sample(sx, sy).abs_diff(target));
                    }
                    let mean = total as f32 / points.len() as f32;
                    best = Some(best.map_or(mean, |best| best.min(mean)));
                    if mean <= TILE_CHANGE {
                        break 'search;
                    }
                }
            }
            let Some(best) = best else {
                continue;
            };
            if high - low < TILE_CONTENT {
                continue;
            }
            content += 1;
            if best > TILE_CHANGE {
                changed.push(Rect::new(
                    x0 as f32,
                    y0 as f32,
                    (x0 + TILE) as f32,
                    (y0 + TILE) as f32,
                ));
            }
        }
    }
    TileChange { changed, content }
}

pub(crate) fn global_motion(
    prev: &LumaFrame,
    next: &LumaFrame,
    guess: Option<Similarity>,
) -> Option<Similarity> {
    let patches = textured_patches(prev);
    if patches.len() < MIN_INLIERS {
        return None;
    }
    let mut best: Option<(Similarity, usize)> = None;
    let mut candidates = vec![guess.unwrap_or(Similarity::IDENTITY), Similarity::IDENTITY];
    for candidate in 0.. {
        let Some(&start) = candidates.get(candidate) else {
            break;
        };
        if let Some(fit) = fit_matches(&match_patches(prev, next, &patches, start))
            && best.is_none_or(|(_, count)| fit.1 > count)
        {
            best = Some(fit);
        }
        if best.is_some_and(|(_, count)| count * 2 >= patches.len()) {
            break;
        }
        if candidate == 1 {
            candidates.push(Similarity {
                scale: 1.0,
                tx: profile_shift(prev, next, false) as f32,
                ty: profile_shift(prev, next, true) as f32,
            });
        }
    }
    best.filter(|(_, count)| *count >= MIN_INLIERS && *count * 5 >= patches.len() * 2)
        .map(|(model, _)| model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::{Canvas, PROSE, sans, view_rect};

    fn page() -> (Canvas, Rect) {
        let font = sans();
        let mut canvas = Canvas::new(640, 1400, 245);
        let mut target = Rect::new(0.0, 0.0, 0.0, 0.0);
        for line in 0..60 {
            let text: Vec<&str> = (0..9)
                .map(|word| {
                    let words: Vec<&str> = PROSE[(line * 7 + word * 3) % PROSE.len()]
                        .split(' ')
                        .collect();
                    words[(line * 5 + word * 11) % words.len()]
                })
                .collect();
            let text = text.join(" ");
            let rect = canvas.text(
                &font,
                13.0,
                24.0 + (line % 3) as f32 * 9.0,
                20.0 + line as f32 * 22.0,
                &text,
                40,
            );
            if line == 20 {
                target = rect;
            }
        }
        (canvas, target)
    }

    #[test]
    fn follows_a_scroll_and_a_fast_jump() {
        let (canvas, target) = page();
        let first = canvas.view(0.0, 200.0, 640, 360, 1.0, 245);
        let rect = view_rect(target, 0.0, 200.0, 640, 360, 1.0);
        let scrolled = canvas.view(0.0, 214.0, 640, 360, 1.0, 245);
        let (moved, motion) = follow(&first, &scrolled, rect, &[]).unwrap();
        assert!((motion.dy + 14.0).abs() <= 1.0, "{motion:?}");
        assert!((moved.y0 - (rect.y0 - 14.0)).abs() <= 1.0);

        let jumped = canvas.view(0.0, 296.0, 640, 360, 1.0, 245);
        let (_, motion) = follow(&first, &jumped, rect, &[]).unwrap();
        assert!((motion.dy + 96.0).abs() <= 1.0, "{motion:?}");
    }

    #[test]
    fn follows_a_zoom() {
        let (canvas, target) = page();
        let first = canvas.view(0.0, 200.0, 640, 360, 1.0, 245);
        let rect = view_rect(target, 0.0, 200.0, 640, 360, 1.0);
        let zoomed = canvas.view(0.0, 200.0, 640, 360, 1.06, 245);
        let expected = view_rect(target, 0.0, 200.0, 640, 360, 1.06);
        let (moved, motion) = follow(&first, &zoomed, rect, &[]).unwrap();
        assert!((motion.scale - 1.06).abs() < 0.035, "{motion:?}");
        assert!(moved.iou(&expected) > 0.6, "{moved:?} vs {expected:?}");
    }

    #[test]
    fn global_motion_recovers_a_scroll_jump_and_a_zoom() {
        let (canvas, _) = page();
        let first = canvas.view(0.0, 200.0, 640, 360, 1.0, 245);
        let jumped = canvas.view(0.0, 260.0, 640, 360, 1.0, 245);
        let motion = global_motion(&first, &jumped, None).unwrap();
        assert!(
            (motion.ty + 60.0).abs() <= 1.0 && motion.tx.abs() <= 1.0,
            "{motion:?}"
        );
        let zoomed = canvas.view(0.0, 200.0, 640, 360, 1.08, 245);
        let motion = global_motion(&first, &zoomed, None).unwrap();
        assert!((motion.scale - 1.08).abs() < 0.02, "{motion:?}");
        let blank = LumaFrame::new(640, 360, vec![245; 640 * 360]);
        assert!(global_motion(&first, &blank, None).is_none());
    }

    #[test]
    fn tiles_change_where_content_is_replaced_but_not_where_it_scrolls() {
        let (canvas, _) = page();
        let first = canvas.view(0.0, 200.0, 640, 360, 1.0, 245);
        let scrolled = canvas.view(0.0, 260.0, 640, 360, 1.0, 245);
        let motion = global_motion(&first, &scrolled, None).unwrap();
        let scroll = changed_tiles(&first, &scrolled, &[motion]);
        assert!(scroll.content > 100, "{}", scroll.content);
        assert!(
            scroll.changed.len() * 20 <= scroll.content,
            "{}",
            scroll.changed.len()
        );
        let replaced = canvas.view(0.0, 900.0, 640, 360, 1.0, 245);
        let cut = changed_tiles(&first, &replaced, &[Similarity::IDENTITY]);
        assert!(
            cut.changed.len() * 2 >= cut.content,
            "{} of {}",
            cut.changed.len(),
            cut.content
        );
    }

    #[test]
    fn loses_content_that_is_replaced_or_scrolled_away() {
        let (canvas, target) = page();
        let first = canvas.view(0.0, 200.0, 640, 360, 1.0, 245);
        let rect = view_rect(target, 0.0, 200.0, 640, 360, 1.0);
        let blank = LumaFrame::new(640, 360, vec![245; 640 * 360]);
        assert!(follow(&first, &blank, rect, &[]).is_none());
        let gone = canvas.view(0.0, 900.0, 640, 360, 1.0, 245);
        assert!(
            follow(
                &first,
                &gone,
                rect,
                &[Motion {
                    dy: -40.0,
                    ..Default::default()
                }]
            )
            .is_none()
        );
    }
}
