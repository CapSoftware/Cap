//! Template tracking by weighted zero-mean normalized cross-correlation (the
//! method OpenCV calls `TM_CCOEFF_NORMED` with a mask), searched coarse to
//! fine over a 2x pyramid. The weights taper towards the box edges, so a box
//! drawn loosely around a target follows the target rather than the
//! background around it. Each frame also tries a few nearby scales, so a box
//! follows content that zooms; partial matches at the frame edge keep a
//! target that is leaving the frame covered until it is gone.

const MAX_LEVELS: usize = 4;
const MIN_COARSE_SIDE: usize = 12;
const MIN_REACQUIRE_SIDE: usize = 6;
const REACQUIRE_EVERY: u32 = 3;
const MIN_TEMPLATE_SIDE: usize = 8;
const COARSE_CANDIDATES: usize = 6;
const REFINE_RADIUS: isize = 2;
const LOCAL_RADIUS: f64 = 40.0;
const MIN_TEMPLATE_DEVIATION: f64 = 2.0;
const MIN_VISIBLE: f64 = 0.35;
const REACQUIRE_VISIBLE: f64 = 0.6;
const LOST_SCORE: f32 = 0.5;
const REACQUIRE_SCORE: f32 = 0.8;
const EXACT_SCORE: f32 = 0.93;
const EDGE_MARGIN: f64 = 0.25;
const REFRESH_SCORE: f32 = 0.85;
const SCALE_STEPS: [f64; 5] = [0.93, 0.965, 1.0, 1.035, 1.07];
const REACQUIRE_SCALES: [f64; 7] = [0.5, 0.63, 0.8, 1.0, 1.25, 1.6, 2.0];
const SCALE_GAIN: f32 = 0.004;
const MAX_BUFFERED_FRAMES: usize = 90;
pub(crate) const HOLD_LEAD: f64 = 0.01;
pub(crate) const BRIDGED_GAP: f64 = 0.4;

#[derive(Clone)]
pub struct LumaFrame {
    width: usize,
    height: usize,
    pixels: std::sync::Arc<[f32]>,
}

impl LumaFrame {
    pub fn from_rgba(data: &[u8], width: u32, height: u32, stride: usize) -> Self {
        let (width, height) = (width as usize, height as usize);
        let mut pixels = Vec::with_capacity(width * height);
        for row in data.chunks(stride).take(height) {
            pixels.extend(row[..width * 4].chunks_exact(4).map(|pixel| {
                0.299 * f32::from(pixel[0])
                    + 0.587 * f32::from(pixel[1])
                    + 0.114 * f32::from(pixel[2])
            }));
        }
        Self {
            width,
            height,
            pixels: pixels.into(),
        }
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    fn crop(&self, x: usize, y: usize, width: usize, height: usize) -> Self {
        let mut pixels = Vec::with_capacity(width * height);
        for row in y..y + height {
            let start = row * self.width + x;
            pixels.extend_from_slice(&self.pixels[start..start + width]);
        }
        Self {
            width,
            height,
            pixels: pixels.into(),
        }
    }

    fn half(&self) -> Self {
        let (width, height) = (self.width / 2, self.height / 2);
        let mut pixels = Vec::with_capacity(width * height);
        for y in 0..height {
            let top = &self.pixels[2 * y * self.width..];
            let bottom = &self.pixels[(2 * y + 1) * self.width..];
            pixels.extend(
                (0..width).map(|x| {
                    (top[2 * x] + top[2 * x + 1] + bottom[2 * x] + bottom[2 * x + 1]) * 0.25
                }),
            );
        }
        Self {
            width,
            height,
            pixels: pixels.into(),
        }
    }

    fn resized(&self, width: usize, height: usize) -> Self {
        let mut source = std::borrow::Cow::Borrowed(self);
        while source.width >= width * 2 && source.height >= height * 2 {
            source = std::borrow::Cow::Owned(source.half());
        }
        let scale_x = source.width as f32 / width as f32;
        let scale_y = source.height as f32 / height as f32;
        let mut pixels = Vec::with_capacity(width * height);
        for y in 0..height {
            let fy = ((y as f32 + 0.5) * scale_y - 0.5).clamp(0.0, (source.height - 1) as f32);
            let (y0, ty) = (fy as usize, fy.fract());
            let y1 = (y0 + 1).min(source.height - 1);
            for x in 0..width {
                let fx = ((x as f32 + 0.5) * scale_x - 0.5).clamp(0.0, (source.width - 1) as f32);
                let (x0, tx) = (fx as usize, fx.fract());
                let x1 = (x0 + 1).min(source.width - 1);
                let at = |x: usize, y: usize| source.pixels[y * source.width + x];
                let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * tx;
                let bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * tx;
                pixels.push(top + (bottom - top) * ty);
            }
        }
        Self {
            width,
            height,
            pixels: pixels.into(),
        }
    }
}

fn taper(position: usize, length: usize) -> f32 {
    let u = (position as f32 + 0.5) / length as f32;
    let edge = u.min(1.0 - u) / 0.2;
    if edge >= 1.0 {
        1.0
    } else {
        0.25 + 0.75 * (0.5 - 0.5 * (std::f32::consts::PI * edge).cos())
    }
}

struct Template {
    width: usize,
    height: usize,
    values: std::sync::Arc<[f32]>,
    weights: Vec<f32>,
    total_weight: f64,
}

impl Template {
    fn new(image: LumaFrame) -> Self {
        let mut weights = Vec::with_capacity(image.pixels.len());
        for y in 0..image.height {
            let wy = taper(y, image.height);
            weights.extend((0..image.width).map(|x| wy * taper(x, image.width)));
        }
        let total_weight = weights.iter().map(|&w| f64::from(w)).sum();
        Self {
            width: image.width,
            height: image.height,
            values: image.pixels,
            weights,
            total_weight,
        }
    }

    fn deviation(&self) -> f64 {
        let (mut sw, mut st, mut stt) = (0.0f64, 0.0f64, 0.0f64);
        for (&t, &w) in self.values.iter().zip(&self.weights) {
            let (t, w) = (f64::from(t), f64::from(w));
            sw += w;
            st += w * t;
            stt += w * t * t;
        }
        ((stt - st * st / sw) / sw).max(0.0).sqrt()
    }

    fn score(&self, frame: &LumaFrame, x: isize, y: isize, min_visible: f64) -> Option<f32> {
        let x0 = x.max(0);
        let y0 = y.max(0);
        let x1 = (x + self.width as isize).min(frame.width as isize);
        let y1 = (y + self.height as isize).min(frame.height as isize);
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let (mut sw, mut st, mut si, mut stt, mut sii, mut sti) = (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0);
        let mut weight = 0.0f64;
        for fy in y0..y1 {
            let ty = (fy - y) as usize;
            let row = &frame.pixels[fy as usize * frame.width..];
            let offset = ty * self.width + (x0 - x) as usize;
            let count = (x1 - x0) as usize;
            let image = &row[x0 as usize..x0 as usize + count];
            let values = &self.values[offset..offset + count];
            let weights = &self.weights[offset..offset + count];
            let (mut rw, mut rt, mut ri, mut rtt, mut rii, mut rti) =
                (0.0f32, 0.0, 0.0, 0.0, 0.0, 0.0);
            for ((&i, &t), &w) in image.iter().zip(values).zip(weights) {
                let (wt, wi) = (w * t, w * i);
                rw += w;
                rt += wt;
                ri += wi;
                rtt += wt * t;
                rii += wi * i;
                rti += wt * i;
            }
            sw += rw;
            st += rt;
            si += ri;
            stt += rtt;
            sii += rii;
            sti += rti;
            weight += f64::from(rw);
        }
        if weight < min_visible * self.total_weight {
            return None;
        }
        let (sw, st, si, stt, sii, sti) = (
            f64::from(sw),
            f64::from(st),
            f64::from(si),
            f64::from(stt),
            f64::from(sii),
            f64::from(sti),
        );
        let template_variance = stt - st * st / sw;
        let image_variance = sii - si * si / sw;
        if template_variance <= sw || image_variance <= sw {
            return Some(0.0);
        }
        Some(((sti - st * si / sw) / (template_variance * image_variance).sqrt()) as f32)
    }
}

pub(crate) struct Pyramid(Vec<LumaFrame>);

impl Pyramid {
    pub(crate) fn new(frame: &LumaFrame) -> Self {
        let mut levels = vec![frame.clone()];
        while levels.len() < MAX_LEVELS {
            let next = levels[levels.len() - 1].half();
            levels.push(next);
        }
        Self(levels)
    }
}

/// A target's look at one capture, rescaled on demand to the box size the
/// tracker is searching for.
#[derive(Clone)]
struct Appearance {
    reference: LumaFrame,
}

impl Appearance {
    fn templates(&self, width: usize, height: usize, min_side: usize) -> Vec<Template> {
        let mut levels = Vec::new();
        for level in 0..MAX_LEVELS {
            let (w, h) = (width >> level, height >> level);
            if level > 0 && w.min(h) < min_side {
                break;
            }
            levels.push(Template::new(self.reference.resized(w.max(1), h.max(1))));
        }
        levels
    }

    fn agrees_in_parts(&self, frame: &LumaFrame, found: Match, size: (usize, usize)) -> bool {
        let image = self.reference.resized(size.0, size.1);
        let mut informative = 0;
        let mut matched = 0;
        for row in 0..3 {
            for column in 0..3 {
                let (x, y) = (column * size.0 / 3, row * size.1 / 3);
                let (w, h) = ((column + 1) * size.0 / 3 - x, (row + 1) * size.1 / 3 - y);
                let part = Template::new(image.crop(x, y, w, h));
                if part.deviation() < MIN_TEMPLATE_DEVIATION {
                    continue;
                }
                let Some(score) = part.score(
                    frame,
                    found.x + x as isize,
                    found.y + y as isize,
                    REACQUIRE_VISIBLE,
                ) else {
                    continue;
                };
                informative += 1;
                matched += usize::from(score >= REACQUIRE_SCORE);
            }
        }
        informative >= 2 && matched * 3 >= informative * 2
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackedBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub score: f32,
}

#[derive(Clone, Copy)]
struct Match {
    x: isize,
    y: isize,
    score: f32,
}

fn best_in(
    frame: &LumaFrame,
    template: &Template,
    center: (isize, isize),
    radius: (isize, isize),
    min_visible: f64,
    count: usize,
) -> Vec<Match> {
    let min_x = -(template.width as isize);
    let min_y = -(template.height as isize);
    let max_x = frame.width as isize;
    let max_y = frame.height as isize;
    let mut scored = Vec::new();
    for y in (center.1 - radius.1).max(min_y)..=(center.1 + radius.1).min(max_y) {
        for x in (center.0 - radius.0).max(min_x)..=(center.0 + radius.0).min(max_x) {
            if let Some(score) = template.score(frame, x, y, min_visible) {
                scored.push(Match { x, y, score });
            }
        }
    }
    scored.sort_by(|a, b| b.score.total_cmp(&a.score));
    let apart = (
        (template.width / 4).max(1) as isize,
        (template.height / 4).max(1) as isize,
    );
    let mut best: Vec<Match> = Vec::with_capacity(count);
    for candidate in scored {
        if best.len() == count {
            break;
        }
        if best.iter().all(|kept| {
            (kept.x - candidate.x).abs() >= apart.0 || (kept.y - candidate.y).abs() >= apart.1
        }) {
            best.push(candidate);
        }
    }
    best
}

/// Coarse-to-fine search for `templates` (one per pyramid level) with its
/// top-left corner near `center`, in level-0 pixels.
fn search(
    pyramid: &Pyramid,
    templates: &[Template],
    center: (f64, f64),
    radius: (f64, f64),
    min_visible: f64,
) -> Option<Match> {
    candidates(pyramid, templates, center, radius, min_visible)
        .into_iter()
        .max_by(|a, b| a.score.total_cmp(&b.score))
}

fn candidates(
    pyramid: &Pyramid,
    templates: &[Template],
    center: (f64, f64),
    radius: (f64, f64),
    min_visible: f64,
) -> Vec<Match> {
    let top = templates.len().min(pyramid.0.len()) - 1;
    let scale = (1usize << top) as f64;
    best_in(
        &pyramid.0[top],
        &templates[top],
        (
            (center.0 / scale).round() as isize,
            (center.1 / scale).round() as isize,
        ),
        (
            (radius.0 / scale).ceil() as isize + 1,
            (radius.1 / scale).ceil() as isize + 1,
        ),
        min_visible,
        COARSE_CANDIDATES,
    )
    .into_iter()
    .filter_map(|mut found| {
        for level in (0..top).rev() {
            found = *best_in(
                &pyramid.0[level],
                &templates[level],
                (found.x * 2, found.y * 2),
                (REFINE_RADIUS, REFINE_RADIUS),
                min_visible,
                1,
            )
            .first()?;
        }
        Some(found)
    })
    .collect()
}

#[derive(Clone)]
pub struct MotionTracker {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    velocity: (f64, f64),
    original: Appearance,
    recent: Appearance,
    lost: bool,
    frames_lost: u32,
}

impl MotionTracker {
    /// `x`, `y`, `width` and `height` are the target's box in `frame` pixels.
    /// `None` when the box is too small, not fully inside the frame, or flat
    /// enough that any patch would match it.
    pub fn new(frame: &LumaFrame, x: usize, y: usize, width: usize, height: usize) -> Option<Self> {
        if width < MIN_TEMPLATE_SIDE
            || height < MIN_TEMPLATE_SIDE
            || x + width > frame.width
            || y + height > frame.height
        {
            return None;
        }
        let reference = frame.crop(x, y, width, height);
        if Template::new(reference.clone()).deviation() < MIN_TEMPLATE_DEVIATION {
            return None;
        }
        let appearance = Appearance { reference };
        Some(Self {
            width: width as f64,
            height: height as f64,
            x: x as f64,
            y: y as f64,
            velocity: (0.0, 0.0),
            original: appearance.clone(),
            recent: appearance,
            lost: false,
            frames_lost: 0,
        })
    }

    pub fn is_lost(&self) -> bool {
        self.lost
    }

    fn size_at(&self, scale: f64) -> (usize, usize) {
        let width = ((self.width * scale).round() as usize).max(MIN_TEMPLATE_SIDE);
        let aspect = self.original.reference.height as f64 / self.original.reference.width as f64;
        let height = ((width as f64 * aspect).round() as usize).max(MIN_TEMPLATE_SIDE);
        (width, height)
    }

    /// The target in `frame`, or `None` while nothing matches it well enough
    /// to follow. A lost tracker keeps searching the whole frame on later
    /// calls and picks the target up again when it reappears.
    pub fn track(&mut self, frame: &LumaFrame) -> Option<TrackedBox> {
        self.track_pyramid(&Pyramid::new(frame))
    }

    fn track_pyramid(&mut self, pyramid: &Pyramid) -> Option<TrackedBox> {
        if !self.lost
            && let Some(found) = self.follow(pyramid).or_else(|| self.follow_parts(pyramid))
        {
            return Some(found);
        }
        self.lost = true;
        self.frames_lost += 1;
        if self.frames_lost % REACQUIRE_EVERY != 1 {
            return None;
        }
        let found = self.reacquire(pyramid)?;
        self.lost = false;
        self.frames_lost = 0;
        self.velocity = (0.0, 0.0);
        Some(found)
    }

    /// Like [`Self::track`], without the whole-frame search: for walking
    /// back through frames where the target must stay near where it was.
    pub(crate) fn follow_only(&mut self, pyramid: &Pyramid) -> Option<TrackedBox> {
        self.follow(pyramid).or_else(|| self.follow_parts(pyramid))
    }

    pub(crate) fn track_near(
        &mut self,
        pyramid: &Pyramid,
        center: (f64, f64),
    ) -> Option<TrackedBox> {
        let mut candidate = self.clone();
        candidate.x = center.0 - candidate.width / 2.0;
        candidate.y = center.1 - candidate.height / 2.0;
        candidate.velocity = (0.0, 0.0);
        let found = candidate.follow(pyramid)?;
        if found.score < REFRESH_SCORE
            || (found.x + found.width / 2.0 - center.0)
                .hypot(found.y + found.height / 2.0 - center.1)
                > 8.0
        {
            return None;
        }
        *self = candidate;
        Some(found)
    }

    fn follow_parts(&mut self, pyramid: &Pyramid) -> Option<TrackedBox> {
        let (width, height) = self.size_at(1.0);
        let image = self.original.reference.resized(width, height);
        let mut votes = Vec::new();
        for row in 0..3 {
            for column in 0..3 {
                let (x, y) = (column * width / 3, row * height / 3);
                let (w, h) = ((column + 1) * width / 3 - x, (row + 1) * height / 3 - y);
                if w < MIN_TEMPLATE_SIDE || h < MIN_TEMPLATE_SIDE {
                    continue;
                }
                let reference = image.crop(x, y, w, h);
                if Template::new(reference.clone()).deviation() < MIN_TEMPLATE_DEVIATION {
                    continue;
                }
                let appearance = Appearance { reference };
                if let Some(found) = search(
                    pyramid,
                    &appearance.templates(w, h, MIN_COARSE_SIDE),
                    (
                        self.x + self.velocity.0 + x as f64,
                        self.y + self.velocity.1 + y as f64,
                    ),
                    (LOCAL_RADIUS, LOCAL_RADIUS),
                    REACQUIRE_VISIBLE,
                )
                .filter(|found| found.score >= REACQUIRE_SCORE)
                {
                    votes.push(Match {
                        x: found.x - x as isize,
                        y: found.y - y as isize,
                        score: found.score,
                    });
                }
            }
        }
        let best = votes.iter().max_by_key(|candidate| {
            votes
                .iter()
                .filter(|other| {
                    (candidate.x - other.x).abs() <= 3 && (candidate.y - other.y).abs() <= 3
                })
                .count()
        })?;
        let agreeing = votes
            .iter()
            .filter(|other| (best.x - other.x).abs() <= 3 && (best.y - other.y).abs() <= 3)
            .collect::<Vec<_>>();
        if agreeing.len() < 2 {
            return None;
        }
        let count = agreeing.len() as isize;
        let found = Match {
            x: agreeing.iter().map(|point| point.x).sum::<isize>() / count,
            y: agreeing.iter().map(|point| point.y).sum::<isize>() / count,
            score: LOST_SCORE,
        };
        Some(self.accept(pyramid, found, 1.0))
    }

    fn follow(&mut self, pyramid: &Pyramid) -> Option<TrackedBox> {
        let predicted = (self.x + self.velocity.0, self.y + self.velocity.1);
        let radius = (
            LOCAL_RADIUS.max(self.velocity.0.abs() * 1.5 + 12.0),
            LOCAL_RADIUS.max(self.velocity.1.abs() * 1.5 + 12.0),
        );
        let (width, height) = self.size_at(1.0);
        let best = [&self.original, &self.recent]
            .into_iter()
            .filter_map(|appearance| {
                search(
                    pyramid,
                    &appearance.templates(width, height, MIN_COARSE_SIDE),
                    predicted,
                    radius,
                    MIN_VISIBLE,
                )
            })
            .max_by(|a, b| a.score.total_cmp(&b.score))
            .filter(|found| found.score >= LOST_SCORE)?;

        let center = (
            best.x as f64 + width as f64 / 2.0,
            best.y as f64 + height as f64 / 2.0,
        );
        let sized = SCALE_STEPS
            .into_iter()
            .filter_map(|step| {
                let (w, h) = self.size_at(step);
                search(
                    pyramid,
                    &self.original.templates(w, h, MIN_COARSE_SIDE),
                    (center.0 - w as f64 / 2.0, center.1 - h as f64 / 2.0),
                    (
                        REFINE_RADIUS as f64 * 2.0 + (w as f64 - self.width).abs() / 2.0,
                        REFINE_RADIUS as f64 * 2.0 + (h as f64 - self.height).abs() / 2.0,
                    ),
                    MIN_VISIBLE,
                )
                .map(|found| (step, found))
            })
            .collect::<Vec<_>>();
        let unscaled = sized
            .iter()
            .find(|(step, _)| *step == 1.0)
            .map_or(LOST_SCORE, |(_, found)| found.score.max(LOST_SCORE));
        let (scale, chosen) = sized
            .into_iter()
            .filter(|(step, found)| *step != 1.0 && found.score > unscaled + SCALE_GAIN)
            .max_by(|a, b| a.1.score.total_cmp(&b.1.score))
            .unwrap_or((1.0, best));
        Some(self.accept(pyramid, chosen, scale))
    }

    fn reacquire(&mut self, pyramid: &Pyramid) -> Option<TrackedBox> {
        let whole = (pyramid.0[0].width as f64, pyramid.0[0].height as f64);
        let mut best: Option<(Match, f64)> = None;
        for scale in REACQUIRE_SCALES {
            let (w, h) = self.size_at(scale);
            for appearance in [&self.original, &self.recent] {
                for found in candidates(
                    pyramid,
                    &appearance.templates(w, h, MIN_REACQUIRE_SIDE),
                    (whole.0 / 2.0, whole.1 / 2.0),
                    whole,
                    REACQUIRE_VISIBLE,
                ) {
                    if self.plausible(found, (w as f64, h as f64), whole)
                        && best.is_none_or(|(kept, _)| found.score > kept.score)
                        && self.original.agrees_in_parts(&pyramid.0[0], found, (w, h))
                    {
                        best = Some((found, scale));
                    }
                }
            }
        }
        let (found, scale) = best?;
        Some(self.accept(pyramid, found, scale))
    }

    /// Things on screen do not teleport: a lost target comes back near
    /// where it was last seen or in from a frame edge. Anywhere else, only a
    /// near-exact match counts, so a look-alike elsewhere is not picked up.
    fn plausible(&self, found: Match, size: (f64, f64), frame: (f64, f64)) -> bool {
        if found.score >= EXACT_SCORE {
            return true;
        }
        if found.score < REACQUIRE_SCORE {
            return false;
        }
        let (x, y) = (found.x as f64, found.y as f64);
        let near_last = (x + size.0 / 2.0 - self.x - self.width / 2.0).abs() <= size.0 * 1.5
            && (y + size.1 / 2.0 - self.y - self.height / 2.0).abs() <= size.1 * 1.5;
        let margin = (size.0 * EDGE_MARGIN, size.1 * EDGE_MARGIN);
        let near_edge = x < margin.0
            || y < margin.1
            || x + size.0 + margin.0 > frame.0
            || y + size.1 + margin.1 > frame.1;
        near_last || near_edge
    }

    fn accept(&mut self, pyramid: &Pyramid, found: Match, scale: f64) -> TrackedBox {
        let (old_cx, old_cy) = (self.x + self.width / 2.0, self.y + self.height / 2.0);
        let (width, height) = self.size_at(scale);
        self.width = width as f64;
        self.height = height as f64;
        self.x = found.x as f64;
        self.y = found.y as f64;
        let (cx, cy) = (self.x + self.width / 2.0, self.y + self.height / 2.0);
        self.velocity = (cx - old_cx, cy - old_cy);
        let frame = &pyramid.0[0];
        if found.score >= REFRESH_SCORE
            && found.x >= 0
            && found.y >= 0
            && found.x as usize + width <= frame.width
            && found.y as usize + height <= frame.height
        {
            self.recent = Appearance {
                reference: frame.crop(found.x as usize, found.y as usize, width, height),
            };
        }
        TrackedBox {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            score: found.score,
        }
    }

    fn reversed(&self) -> Self {
        Self {
            velocity: (-self.velocity.0, -self.velocity.1),
            ..self.clone()
        }
    }
}

/// One tracked box in normalized frame coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrackPoint {
    pub time: f64,
    pub center: (f64, f64),
    pub size: (f64, f64),
}

/// Feeds a tracker frame by frame and keeps the path it produces, including
/// what to do while the target is lost: the box holds where the target was
/// last seen, and when the target is found again the frames since it was
/// lost are walked backwards, so the box is already on it as it comes back
/// into view rather than only once it is fully visible again.
pub struct TrackSession {
    tracker: MotionTracker,
    width: f64,
    height: f64,
    points: Vec<TrackPoint>,
    confidence: f32,
    lost_frames: Vec<(f64, LumaFrame)>,
    lost_since: Option<f64>,
    lost_spans: Vec<(f64, f64)>,
}

impl TrackSession {
    pub fn latest(&self) -> (TrackPoint, f32) {
        (*self.points.last().unwrap(), self.confidence)
    }

    /// `center` and `size` are the box at `time`, normalized to the frame.
    pub fn new(frame: &LumaFrame, time: f64, center: (f64, f64), size: (f64, f64)) -> Option<Self> {
        if !time.is_finite()
            || !center.0.is_finite()
            || !center.1.is_finite()
            || !size.0.is_finite()
            || !size.1.is_finite()
            || size.0 <= 0.0
            || size.1 <= 0.0
            || size.0 > 1.0
            || size.1 > 1.0
        {
            return None;
        }
        let (width, height) = (frame.width as f64, frame.height as f64);
        let box_w = (size.0 * width).round().max(1.0);
        let box_h = (size.1 * height).round().max(1.0);
        let x = ((center.0 * width) - box_w / 2.0)
            .round()
            .clamp(0.0, width - box_w);
        let y = ((center.1 * height) - box_h / 2.0)
            .round()
            .clamp(0.0, height - box_h);
        let tracker = MotionTracker::new(
            frame,
            x as usize,
            y as usize,
            box_w as usize,
            box_h as usize,
        )?;
        Some(Self {
            tracker,
            width,
            height,
            points: vec![TrackPoint { time, center, size }],
            confidence: 1.0,
            lost_frames: Vec::new(),
            lost_since: None,
            lost_spans: Vec::new(),
        })
    }

    fn point(&self, time: f64, found: TrackedBox) -> TrackPoint {
        TrackPoint {
            time,
            center: (
                (found.x + found.width / 2.0) / self.width,
                (found.y + found.height / 2.0) / self.height,
            ),
            size: (found.width / self.width, found.height / self.height),
        }
    }

    fn overlaps_frame(&self, found: TrackedBox) -> bool {
        found.x < self.width
            && found.y < self.height
            && found.x + found.width > 0.0
            && found.y + found.height > 0.0
    }

    fn touches_edge(&self, found: TrackedBox) -> bool {
        found.x <= 1.0
            || found.y <= 1.0
            || found.x + found.width >= self.width - 1.0
            || found.y + found.height >= self.height - 1.0
    }

    pub fn push(&mut self, time: f64, frame: LumaFrame) {
        self.push_pyramid(time, &Pyramid::new(&frame));
    }

    pub(crate) fn push_pyramid(&mut self, time: f64, pyramid: &Pyramid) {
        let Some(found) = self.tracker.track_pyramid(pyramid) else {
            self.confidence = 0.0;
            self.lost_since.get_or_insert(time);
            if self.lost_frames.len() == MAX_BUFFERED_FRAMES {
                self.lost_frames.remove(0);
            }
            self.lost_frames.push((time, pyramid.0[0].clone()));
            return;
        };
        self.confidence = found.score;
        let current = self.point(time, found);
        if let Some(since) = self.lost_since.take() {
            let mut back = self.tracker.reversed();
            let mut recovered = Vec::new();
            let mut entering: Option<TrackedBox> = None;
            for (time, frame) in std::mem::take(&mut self.lost_frames).into_iter().rev() {
                let found = match entering {
                    None => back.follow_only(&Pyramid::new(&frame)),
                    Some(_) => None,
                };
                let found = match found {
                    Some(found) => found,
                    None => {
                        let last = *entering.get_or_insert(TrackedBox {
                            x: back.x,
                            y: back.y,
                            width: back.width,
                            height: back.height,
                            score: 0.0,
                        });
                        let slid = TrackedBox {
                            x: last.x + back.velocity.0,
                            y: last.y + back.velocity.1,
                            ..last
                        };
                        if back.velocity.0.hypot(back.velocity.1) < 1.0
                            || !self.overlaps_frame(slid)
                            || !self.touches_edge(last)
                        {
                            break;
                        }
                        entering = Some(slid);
                        slid
                    }
                };
                recovered.push(self.point(time, found));
            }
            recovered.reverse();
            let first = recovered.first().map_or(time, |point| point.time);
            self.lost_spans.push((since, first));
            if let Some(&last) = self.points.last()
                && first - last.time > BRIDGED_GAP
            {
                self.points.push(TrackPoint {
                    time: first - HOLD_LEAD,
                    ..last
                });
            }
            self.points.extend(recovered);
        }
        self.points.push(current);
    }

    /// The path, and the spans in which the target could not be found.
    pub fn finish(mut self) -> (Vec<TrackPoint>, Vec<(f64, f64)>) {
        if let Some(since) = self.lost_since
            && let Some((end, _)) = self.lost_frames.last()
        {
            self.lost_spans.push((since, *end));
        }
        (self.points, self.lost_spans)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDTH: usize = 320;
    const HEIGHT: usize = 180;

    fn background() -> Vec<f32> {
        (0..WIDTH * HEIGHT)
            .map(|index| {
                let (x, y) = (index % WIDTH, index / WIDTH);
                40.0 + ((x * 7 + y * 13) % 23) as f32 * 2.0
            })
            .collect()
    }

    fn card(pixels: &mut [f32], x: isize, y: isize, scale: f64, label: &[u8]) {
        let (w, h) = ((64.0 * scale) as isize, (24.0 * scale) as isize);
        for row in y.max(0)..(y + h).min(HEIGHT as isize) {
            for column in x.max(0)..(x + w).min(WIDTH as isize) {
                let (u, v) = (
                    ((column - x) as f64 / scale) as usize,
                    ((row - y) as f64 / scale) as usize,
                );
                let glyph = (u.saturating_sub(6)) / 7;
                let ink = (8..16).contains(&v)
                    && u >= 6
                    && glyph < label.len()
                    && (u - 6) % 7 < label[glyph] as usize % 3 + 2;
                pixels[row as usize * WIDTH + column as usize] = if ink {
                    30.0 + f32::from(label[glyph] % 5) * 15.0
                } else {
                    220.0
                };
            }
        }
    }

    const SECRET: &[u8] = &[2, 7, 1, 8, 2, 8, 1, 8];
    const DECOY: &[u8] = &[3, 1, 4, 1, 5, 9, 2, 6];

    fn frame(
        card_at: (isize, isize),
        scale: f64,
        decoy_at: Option<(isize, isize)>,
        brightness: f32,
    ) -> LumaFrame {
        let mut pixels = background();
        if let Some((x, y)) = decoy_at {
            card(&mut pixels, x, y, 1.0, DECOY);
        }
        card(&mut pixels, card_at.0, card_at.1, scale, SECRET);
        for pixel in &mut pixels {
            *pixel = (*pixel + brightness).clamp(0.0, 255.0);
        }
        LumaFrame {
            width: WIDTH,
            height: HEIGHT,
            pixels: pixels.into(),
        }
    }

    fn path(step: usize) -> (isize, isize) {
        if step < 20 {
            (20 + step as isize * 6, 30)
        } else {
            (134, 30 + (step as isize - 19) * 4)
        }
    }

    #[test]
    fn follows_a_moving_card_past_a_look_alike_and_a_brightness_change() {
        let decoy = Some((200, 20));
        let start = path(0);
        let mut tracker = MotionTracker::new(
            &frame(start, 1.0, decoy, 0.0),
            start.0 as usize,
            start.1 as usize,
            64,
            24,
        )
        .expect("textured card is trackable");
        for step in 1..40 {
            let brightness = if step > 25 { 18.0 } else { 0.0 };
            let expected = path(step);
            let found = tracker
                .track(&frame(expected, 1.0, decoy, brightness))
                .unwrap_or_else(|| panic!("lost the card at step {step}"));
            assert_eq!(
                (found.x as isize, found.y as isize),
                expected,
                "step {step}"
            );
            assert!(found.score > 0.9, "step {step}: {}", found.score);
        }
    }

    #[test]
    fn grows_with_content_that_zooms() {
        let mut tracker =
            MotionTracker::new(&frame((100, 60), 1.0, None, 0.0), 100, 60, 64, 24).unwrap();
        let mut scale = 1.0;
        for _ in 0..36 {
            scale *= 1.012;
            let w = 64.0 * scale;
            let corner = ((132.0 - w / 2.0) as isize, (72.0 - 12.0 * scale) as isize);
            let found = tracker
                .track(&frame(corner, scale, None, 0.0))
                .expect("still tracked");
            assert!(
                (found.x + found.width / 2.0 - 132.0).abs() <= 2.0,
                "{found:?}"
            );
        }
        let found = tracker
            .track(&frame(
                (
                    (132.0 - 32.0 * scale * 1.03) as isize,
                    (72.0 - 12.0 * scale * 1.03) as isize,
                ),
                scale * 1.03,
                None,
                0.0,
            ))
            .unwrap();
        let expected = 64.0 * scale * 1.03;
        assert!(
            (found.width - expected).abs() / expected < 0.08,
            "{} vs {expected}",
            found.width
        );
    }

    fn box_at(points: &[TrackPoint], time: f64) -> (f64, f64, f64, f64) {
        let after = points
            .iter()
            .position(|point| point.time >= time)
            .unwrap_or(points.len() - 1);
        let (a, b) = (points[after.saturating_sub(1)], points[after]);
        let t = if b.time > a.time {
            ((time - a.time) / (b.time - a.time)).clamp(0.0, 1.0)
        } else {
            1.0
        };
        let lerp = |p: f64, q: f64| p + (q - p) * t;
        let (cx, cy) = (
            lerp(a.center.0, b.center.0) * WIDTH as f64,
            lerp(a.center.1, b.center.1) * HEIGHT as f64,
        );
        let (w, h) = (
            lerp(a.size.0, b.size.0) * WIDTH as f64,
            lerp(a.size.1, b.size.1) * HEIGHT as f64,
        );
        (cx - w / 2.0, cy - h / 2.0, cx + w / 2.0, cy + h / 2.0)
    }

    #[test]
    fn covers_a_card_leaving_the_frame_and_finds_it_when_it_returns() {
        let start = (200, 80);
        let mut session = TrackSession::new(
            &frame(start, 1.0, Some((20, 20)), 0.0),
            0.0,
            ((200.0 + 32.0) / WIDTH as f64, (80.0 + 12.0) / HEIGHT as f64),
            (64.0 / WIDTH as f64, 24.0 / HEIGHT as f64),
        )
        .unwrap();
        let mut truth = Vec::new();
        for step in 1..=40 {
            let x = if step <= 12 {
                200 + step * 10
            } else if step <= 24 {
                1000
            } else {
                330 - (step - 24) * 12
            };
            let y = if step <= 24 { 80 } else { 120 };
            truth.push((step as f64, x, y as f64));
            session.push(step as f64, frame((x, y), 1.0, Some((20, 20)), 0.0));
        }
        let (points, lost) = session.finish();
        assert_eq!(lost.len(), 1, "{lost:?}");
        for (time, x, y) in truth {
            let visible = (x as f64, (x as f64 + 64.0).min(WIDTH as f64));
            if visible.1 <= visible.0 {
                continue;
            }
            let (left, top, right, bottom) = box_at(&points, time);
            assert!(
                left <= visible.0 + 2.0
                    && right >= visible.1 - 2.0
                    && top <= y + 2.0
                    && bottom >= y + 22.0,
                "{time}: card {visible:?} box {left:.0}..{right:.0}"
            );
        }
        let (left, ..) = box_at(&points, 20.0);
        assert!(left > 100.0, "never jumps to the look-alike: {left}");
    }

    #[test]
    fn reports_the_target_lost_when_it_leaves_the_frame() {
        let start = (40, 40);
        let mut tracker =
            MotionTracker::new(&frame(start, 1.0, None, 0.0), 40, 40, 64, 24).unwrap();
        let empty = LumaFrame {
            width: WIDTH,
            height: HEIGHT,
            pixels: background().into(),
        };
        assert_eq!(tracker.track(&empty), None);
        assert!(tracker.is_lost());
    }

    #[test]
    fn keeps_the_visible_part_of_a_partially_occluded_target() {
        let mut tracker =
            MotionTracker::new(&frame((40, 60), 1.0, None, 0.0), 40, 60, 64, 24).unwrap();
        for step in 1..=24 {
            let x = 40 + step * 3;
            let mut current = frame((x, 60), 1.0, Some((200, 100)), 0.0);
            if (8..=18).contains(&step) {
                let pixels = std::sync::Arc::make_mut(&mut current.pixels);
                for row in 60..84 {
                    pixels[row * WIDTH + x as usize..row * WIDTH + x as usize + 35].fill(90.0);
                }
            }
            let found = tracker
                .track(&current)
                .expect("the visible text remains trackable");
            assert!(
                (found.x - x as f64).abs() <= 2.0 && (found.y - 60.0).abs() <= 2.0,
                "{step}: {found:?}"
            );
        }
    }

    #[test]
    fn refuses_a_flat_box() {
        let flat = LumaFrame {
            width: WIDTH,
            height: HEIGHT,
            pixels: vec![40.0; WIDTH * HEIGHT].into(),
        };
        assert!(MotionTracker::new(&flat, 10, 10, 40, 40).is_none());
    }

    #[test]
    fn luma_skips_row_padding() {
        let stride = 3 * 4 + 4;
        let mut data = vec![255u8; stride * 2];
        for row in 0..2 {
            for column in 0..3 {
                let offset = row * stride + column * 4;
                data[offset..offset + 4].copy_from_slice(&[10, 10, 10, 255]);
            }
        }
        let luma = LumaFrame::from_rgba(&data, 3, 2, stride);
        assert_eq!((luma.width(), luma.height()), (3, 2));
        assert!(luma.pixels.iter().all(|&p| (p - 10.0).abs() < 1e-3));
    }
}
