//! Hand-drawn doodles: the ink language of Cap's Chrome extension pages and
//! the web recorder, drawn natively.
//!
//! The web version is inline SVG with round-capped strokes, a "boil" filter
//! (`feTurbulence` -> `feDisplacementMap`, seed stepping through four values
//! every 150ms) and `stroke-dashoffset` draw-on. Here the same path data is
//! flattened once, displaced by four seeded noise fields up front, and each
//! paint picks the variant for the current 150ms slot and trims every stroke
//! by arc length for its draw-on progress.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use gpui::{
    App, Bounds, Hsla, IntoElement, PathBuilder, PathStyle, Pixels, Styled, Window, canvas, point,
    px,
};
use lyon_tessellation::{LineCap, LineJoin, StrokeOptions};

const BOIL_FRAME_MS: u128 = 150;
const BOIL_VARIANTS: usize = 4;
const BOIL_AMPLITUDE: f32 = 1.25;
const BOIL_WAVELENGTH: f32 = 20.;
const FLATTEN_STEP: f32 = 1.5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ink {
    Line,
    Soft,
    Accent,
    Red,
    Green,
    Track,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    /// Always fully drawn.
    Still,
    /// `stroke-dashoffset` 1 -> 0.
    Draw { delay: u32, duration: u32 },
    /// Opacity 0 -> 1.
    Fade { delay: u32, duration: u32 },
    /// Scale 0.2 -> 1.2 -> 1 around the stroke's centre, fading in.
    Pop { delay: u32, duration: u32 },
}

#[derive(Clone, Copy, Debug)]
pub struct Stroke {
    pub d: &'static str,
    pub ink: Ink,
    pub width: f32,
    pub motion: Motion,
    /// Filled rather than stroked (dots, lens).
    pub fill: bool,
    /// Marching dashes: dash 2, gap 4.2, a full cycle every 1.1s.
    pub march: bool,
    /// Bob 0 -> -4 -> 0 units every 1.9s.
    pub bob: bool,
    /// Opacity breathing 1 -> 0.3 -> 1 every 1.2s once shown.
    pub pulse: bool,
}

impl Stroke {
    pub const fn ink(d: &'static str) -> Self {
        Self {
            d,
            ink: Ink::Line,
            width: 4.,
            motion: Motion::Still,
            fill: false,
            march: false,
            bob: false,
            pulse: false,
        }
    }

    pub const fn with_ink(mut self, ink: Ink) -> Self {
        self.ink = ink;
        self
    }

    pub const fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    pub const fn draw(mut self, delay: u32, duration: u32) -> Self {
        self.motion = Motion::Draw { delay, duration };
        self
    }

    pub const fn fade(mut self, delay: u32, duration: u32) -> Self {
        self.motion = Motion::Fade { delay, duration };
        self
    }

    pub const fn pop(mut self, delay: u32, duration: u32) -> Self {
        self.motion = Motion::Pop { delay, duration };
        self
    }

    pub const fn filled(mut self) -> Self {
        self.fill = true;
        self
    }

    pub const fn marching(mut self) -> Self {
        self.march = true;
        self
    }

    pub const fn bobbing(mut self) -> Self {
        self.bob = true;
        self
    }

    pub const fn pulsing(mut self) -> Self {
        self.pulse = true;
        self
    }

    fn settled_at(&self) -> u32 {
        match self.motion {
            Motion::Still => 0,
            Motion::Draw { delay, duration }
            | Motion::Fade { delay, duration }
            | Motion::Pop { delay, duration } => delay + duration,
        }
    }
}

pub struct Doodle {
    pub view: (f32, f32),
    pub strokes: &'static [Stroke],
}

impl Doodle {
    /// When every entrance has finished, in ms after the doodle appeared.
    pub fn settled_at(&self) -> u32 {
        self.strokes
            .iter()
            .map(Stroke::settled_at)
            .max()
            .unwrap_or(0)
    }

    fn perpetual(&self) -> bool {
        self.strokes
            .iter()
            .any(|stroke| stroke.march || stroke.bob || stroke.pulse)
    }
}

#[derive(Clone, Copy)]
pub struct Palette {
    pub ink: Hsla,
    pub soft: Hsla,
    pub accent: Hsla,
    pub red: Hsla,
    pub green: Hsla,
    pub track: Hsla,
}

impl Palette {
    fn color(&self, ink: Ink) -> Hsla {
        match ink {
            Ink::Line => self.ink,
            Ink::Soft => self.soft,
            Ink::Accent => self.accent,
            Ink::Red => self.red,
            Ink::Green => self.green,
            Ink::Track => self.track,
        }
    }
}

type Polyline = Vec<(f32, f32)>;

struct Prepared {
    /// Per stroke, per subpath: the un-boiled points and cumulative lengths.
    strokes: Vec<PreparedStroke>,
}

struct PreparedStroke {
    subpaths: Vec<PreparedSubpath>,
    length: f32,
    centre: (f32, f32),
}

struct PreparedSubpath {
    variants: [Polyline; BOIL_VARIANTS],
    cumulative: Vec<f32>,
    closed: bool,
}

/// Every doodle's flattening and boil variants, built on first paint. A
/// doodle is a `&'static`, so its address is a stable key.
fn prepared(doodle: &'static Doodle) -> &'static Prepared {
    static CACHE: OnceLock<Mutex<HashMap<usize, &'static Prepared>>> = OnceLock::new();
    let key = doodle as *const Doodle as usize;
    let mut cache = CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache
        .entry(key)
        .or_insert_with(|| Box::leak(Box::new(prepare(doodle))))
}

fn prepare(doodle: &Doodle) -> Prepared {
    Prepared {
        strokes: doodle
            .strokes
            .iter()
            .enumerate()
            .map(|(index, stroke)| {
                let subpaths: Vec<PreparedSubpath> = parse(stroke.d)
                    .into_iter()
                    .map(|(points, closed)| {
                        let mut cumulative = Vec::with_capacity(points.len());
                        let mut total = 0.;
                        for (i, point) in points.iter().enumerate() {
                            if i > 0 {
                                total += distance(points[i - 1], *point);
                            }
                            cumulative.push(total);
                        }
                        let variants = std::array::from_fn(|variant| {
                            boil(&points, (index * BOIL_VARIANTS + variant) as u32 + 1)
                        });
                        PreparedSubpath {
                            variants,
                            cumulative,
                            closed,
                        }
                    })
                    .collect();
                let length = subpaths
                    .iter()
                    .map(|subpath| subpath.cumulative.last().copied().unwrap_or(0.))
                    .sum();
                let (mut sx, mut sy, mut count) = (0., 0., 0.);
                for subpath in &subpaths {
                    for &(x, y) in &subpath.variants[0] {
                        sx += x;
                        sy += y;
                        count += 1.;
                    }
                }
                PreparedStroke {
                    subpaths,
                    length,
                    centre: if count > 0. {
                        (sx / count, sy / count)
                    } else {
                        (0., 0.)
                    },
                }
            })
            .collect(),
    }
}

fn distance(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt()
}

fn hash(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32)
        .wrapping_mul(374_761_393)
        .wrapping_add((y as u32).wrapping_mul(668_265_263))
        .wrapping_add(seed.wrapping_mul(2_246_822_519));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    (h & 0x00ff_ffff) as f32 / 0x00ff_ffff as f32
}

fn value_noise(x: f32, y: f32, seed: u32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let (sx, sy) = (fx * fx * (3. - 2. * fx), fy * fy * (3. - 2. * fy));
    let (ix, iy) = (x0 as i32, y0 as i32);
    let top = hash(ix, iy, seed) * (1. - sx) + hash(ix + 1, iy, seed) * sx;
    let bottom = hash(ix, iy + 1, seed) * (1. - sx) + hash(ix + 1, iy + 1, seed) * sx;
    top * (1. - sy) + bottom * sy
}

fn boil(points: &[(f32, f32)], seed: u32) -> Polyline {
    points
        .iter()
        .map(|&(x, y)| {
            let (nx, ny) = (x / BOIL_WAVELENGTH, y / BOIL_WAVELENGTH);
            let dx = (value_noise(nx, ny, seed) - 0.5) * 2. * BOIL_AMPLITUDE;
            let dy = (value_noise(nx + 31.7, ny + 17.3, seed ^ 0x9e37) - 0.5) * 2. * BOIL_AMPLITUDE;
            (x + dx, y + dy)
        })
        .collect()
}

/// A tiny SVG path parser: `M L H V C Q T Z`, absolute or relative, with
/// implicit repeats. No arcs; circles are written as four cubics. Curves are
/// flattened to [`FLATTEN_STEP`]-unit segments.
fn parse(d: &str) -> Vec<(Polyline, bool)> {
    let mut tokens = Tokens::new(d);
    let mut subpaths = Vec::new();
    let mut current: Polyline = Vec::new();
    let mut pen = (0., 0.);
    let mut start = (0., 0.);
    let mut last_quad: Option<(f32, f32)> = None;
    let mut command = 'M';
    while let Some(next) = tokens.command_or_number() {
        if let Some(letter) = next {
            command = letter;
        }
        let relative = command.is_ascii_lowercase();
        let base = if relative { pen } else { (0., 0.) };
        match command.to_ascii_uppercase() {
            'M' => {
                let Some(to) = tokens.pair() else { break };
                if current.len() > 1 {
                    subpaths.push((std::mem::take(&mut current), false));
                }
                current.clear();
                pen = (base.0 + to.0, base.1 + to.1);
                start = pen;
                current.push(pen);
                command = if relative { 'l' } else { 'L' };
                last_quad = None;
            }
            'L' => {
                let Some(to) = tokens.pair() else { break };
                pen = (base.0 + to.0, base.1 + to.1);
                push_line(&mut current, pen);
                last_quad = None;
            }
            'H' => {
                let Some(x) = tokens.number() else { break };
                pen = (if relative { pen.0 + x } else { x }, pen.1);
                push_line(&mut current, pen);
                last_quad = None;
            }
            'V' => {
                let Some(y) = tokens.number() else { break };
                pen = (pen.0, if relative { pen.1 + y } else { y });
                push_line(&mut current, pen);
                last_quad = None;
            }
            'C' => {
                let (Some(c1), Some(c2), Some(to)) = (tokens.pair(), tokens.pair(), tokens.pair())
                else {
                    break;
                };
                let c1 = (base.0 + c1.0, base.1 + c1.1);
                let c2 = (base.0 + c2.0, base.1 + c2.1);
                let to = (base.0 + to.0, base.1 + to.1);
                flatten_cubic(&mut current, pen, c1, c2, to);
                pen = to;
                last_quad = None;
            }
            'Q' => {
                let (Some(c), Some(to)) = (tokens.pair(), tokens.pair()) else {
                    break;
                };
                let c = (base.0 + c.0, base.1 + c.1);
                let to = (base.0 + to.0, base.1 + to.1);
                flatten_quad(&mut current, pen, c, to);
                pen = to;
                last_quad = Some(c);
            }
            'T' => {
                let Some(to) = tokens.pair() else { break };
                let c = match last_quad {
                    Some(c) => (2. * pen.0 - c.0, 2. * pen.1 - c.1),
                    None => pen,
                };
                let to = (base.0 + to.0, base.1 + to.1);
                flatten_quad(&mut current, pen, c, to);
                pen = to;
                last_quad = Some(c);
            }
            'Z' => {
                push_line(&mut current, start);
                pen = start;
                if current.len() > 1 {
                    subpaths.push((std::mem::take(&mut current), true));
                }
                last_quad = None;
            }
            _ => break,
        }
    }
    if !current.is_empty() {
        if current.len() == 1 {
            let only = current[0];
            current.push((only.0 + 0.01, only.1));
        }
        subpaths.push((current, false));
    }
    subpaths
}

fn push_line(points: &mut Polyline, to: (f32, f32)) {
    let Some(&from) = points.last() else {
        points.push(to);
        return;
    };
    let steps = (distance(from, to) / FLATTEN_STEP).ceil().max(1.) as usize;
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        points.push((from.0 + (to.0 - from.0) * t, from.1 + (to.1 - from.1) * t));
    }
}

fn flatten_quad(points: &mut Polyline, from: (f32, f32), c: (f32, f32), to: (f32, f32)) {
    let estimate = distance(from, c) + distance(c, to);
    let steps = (estimate / FLATTEN_STEP).ceil().max(2.) as usize;
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        let u = 1. - t;
        points.push((
            u * u * from.0 + 2. * u * t * c.0 + t * t * to.0,
            u * u * from.1 + 2. * u * t * c.1 + t * t * to.1,
        ));
    }
}

fn flatten_cubic(
    points: &mut Polyline,
    from: (f32, f32),
    c1: (f32, f32),
    c2: (f32, f32),
    to: (f32, f32),
) {
    let estimate = distance(from, c1) + distance(c1, c2) + distance(c2, to);
    let steps = (estimate / FLATTEN_STEP).ceil().max(2.) as usize;
    for step in 1..=steps {
        let t = step as f32 / steps as f32;
        let u = 1. - t;
        let (a, b, c, d) = (u * u * u, 3. * u * u * t, 3. * u * t * t, t * t * t);
        points.push((
            a * from.0 + b * c1.0 + c * c2.0 + d * to.0,
            a * from.1 + b * c1.1 + c * c2.1 + d * to.1,
        ));
    }
}

struct Tokens<'a> {
    rest: &'a str,
}

impl<'a> Tokens<'a> {
    fn new(d: &'a str) -> Self {
        Self { rest: d }
    }

    fn skip_separators(&mut self) {
        self.rest = self
            .rest
            .trim_start_matches(|c: char| c.is_whitespace() || c == ',');
    }

    /// `Some(Some(letter))` for a command, `Some(None)` when a number follows
    /// (an implicit repeat of the previous command), `None` at the end.
    fn command_or_number(&mut self) -> Option<Option<char>> {
        self.skip_separators();
        let first = self.rest.chars().next()?;
        if first.is_ascii_alphabetic() {
            self.rest = &self.rest[1..];
            Some(Some(first))
        } else {
            Some(None)
        }
    }

    fn number(&mut self) -> Option<f32> {
        self.skip_separators();
        let bytes = self.rest.as_bytes();
        let mut end = 0;
        let mut seen_dot = false;
        while end < bytes.len() {
            let c = bytes[end] as char;
            let sign = (c == '-' || c == '+') && end == 0;
            let dot = c == '.' && !seen_dot;
            if !(c.is_ascii_digit() || sign || dot) {
                break;
            }
            seen_dot |= dot;
            end += 1;
        }
        if end == 0 {
            return None;
        }
        let value = self.rest[..end].parse().ok();
        self.rest = &self.rest[end..];
        value
    }

    fn pair(&mut self) -> Option<(f32, f32)> {
        Some((self.number()?, self.number()?))
    }
}

fn ease(t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    1. - (1. - t).powi(3)
}

fn progress(motion: Motion, elapsed: f32) -> f32 {
    match motion {
        Motion::Still => 1.,
        Motion::Draw { delay, duration }
        | Motion::Fade { delay, duration }
        | Motion::Pop { delay, duration } => {
            ((elapsed - delay as f32) / duration.max(1) as f32).clamp(0., 1.)
        }
    }
}

/// The variant every doodle on screen shows right now: one shared clock so
/// all of them boil in step, like the single SVG filter does.
fn boil_frame() -> usize {
    static CLOCK: OnceLock<Instant> = OnceLock::new();
    let start = CLOCK.get_or_init(Instant::now);
    ((start.elapsed().as_millis() / BOIL_FRAME_MS) as usize) % BOIL_VARIANTS
}

/// A settled, boil-only doodle needs a repaint every 150ms, not every frame:
/// one refresh per window per boil slot, however many doodles it shows.
fn schedule_boil_frame(window: &mut Window, cx: &mut App) {
    static SCHEDULED: OnceLock<Mutex<HashMap<gpui::WindowId, u128>>> = OnceLock::new();
    static CLOCK: OnceLock<Instant> = OnceLock::new();
    let now = CLOCK.get_or_init(Instant::now).elapsed().as_millis();
    let slot = now / BOIL_FRAME_MS + 1;
    let id = window.window_handle().window_id();
    {
        let mut scheduled = SCHEDULED
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if scheduled.get(&id).is_some_and(|&pending| pending >= slot) {
            return;
        }
        scheduled.insert(id, slot);
    }
    let wait = (slot * BOIL_FRAME_MS).saturating_sub(now) as u64;
    window
        .spawn(cx, async move |cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_millis(wait))
                .await;
            cx.update(|window, _| window.refresh()).ok();
        })
        .detach();
}

/// Paint a doodle into a `width x height` box, its entrance timed from
/// `shown_at`. `still` freezes the boil and skips the entrance (reduced
/// motion, or a window in the background).
pub fn doodle(
    doodle: &'static Doodle,
    palette: Palette,
    shown_at: Instant,
    still: bool,
    width: f32,
    height: f32,
) -> impl IntoElement {
    canvas(
        |_, _, _| {},
        move |bounds: Bounds<Pixels>, _, window: &mut Window, cx: &mut App| {
            let elapsed = if still {
                f32::MAX
            } else {
                shown_at.elapsed().as_secs_f32() * 1000.
            };
            let frame = if still { 0 } else { boil_frame() };
            paint(doodle, palette, bounds, elapsed, frame, window);
            if still {
                return;
            }
            if elapsed < doodle.settled_at() as f32 + 50. || doodle.perpetual() {
                window.request_animation_frame();
            } else {
                schedule_boil_frame(window, cx);
            }
        },
    )
    .w(px(width))
    .h(px(height))
}

fn paint(
    doodle: &'static Doodle,
    palette: Palette,
    bounds: Bounds<Pixels>,
    elapsed: f32,
    frame: usize,
    window: &mut Window,
) {
    let prepared = prepared(doodle);
    let (view_w, view_h) = doodle.view;
    let scale = (f32::from(bounds.size.width) / view_w).min(f32::from(bounds.size.height) / view_h);
    let origin_x =
        f32::from(bounds.origin.x) + (f32::from(bounds.size.width) - view_w * scale) / 2.;
    let origin_y =
        f32::from(bounds.origin.y) + (f32::from(bounds.size.height) - view_h * scale) / 2.;
    let seconds = elapsed / 1000.;

    for (stroke, shape) in doodle.strokes.iter().zip(&prepared.strokes) {
        let t = progress(stroke.motion, elapsed);
        if t <= 0. {
            continue;
        }
        let mut alpha = 1.;
        let mut grow = 1.;
        let mut drawn = 1.;
        match stroke.motion {
            Motion::Draw { .. } => drawn = ease(t),
            Motion::Fade { .. } => alpha = ease(t),
            Motion::Pop { .. } => {
                alpha = ease(t);
                grow = if t < 0.6 {
                    0.2 + 1.0 * (t / 0.6)
                } else {
                    1.2 - 0.2 * ((t - 0.6) / 0.4)
                };
            }
            Motion::Still => {}
        }
        if stroke.pulse && elapsed.is_finite() && elapsed < f32::MAX / 2. {
            let cycle = (seconds / 1.2).fract();
            alpha *= 0.65 + 0.35 * (std::f32::consts::TAU * cycle).cos();
        }
        let bob = if stroke.bob && elapsed < f32::MAX / 2. {
            let cycle = (seconds / 1.9).fract();
            -4. * (0.5 - 0.5 * (std::f32::consts::TAU * cycle).cos())
        } else {
            0.
        };
        let mut color = palette.color(stroke.ink);
        color.a *= alpha;
        if color.a <= 0.001 {
            continue;
        }

        let map = |(x, y): (f32, f32)| {
            let (cx, cy) = shape.centre;
            let x = cx + (x - cx) * grow;
            let y = cy + (y - cy) * grow + bob;
            point(px(origin_x + x * scale), px(origin_y + y * scale))
        };

        let budget = shape.length * drawn;
        let mut spent = 0.;
        let mut builder = if stroke.fill {
            PathBuilder::fill()
        } else {
            PathBuilder::stroke(px(stroke.width * scale)).with_style(PathStyle::Stroke(
                StrokeOptions::default()
                    .with_line_width(stroke.width * scale)
                    .with_line_cap(LineCap::Round)
                    .with_line_join(LineJoin::Round),
            ))
        };
        let mut any = false;
        for subpath in &shape.subpaths {
            if spent >= budget {
                break;
            }
            let points = &subpath.variants[frame];
            let length = subpath.cumulative.last().copied().unwrap_or(0.);
            let allowed = (budget - spent).min(length);
            spent += length;
            let segments: Vec<Polyline> = if stroke.march && !stroke.fill {
                let phase = (seconds / 1.1).fract() * 6.2;
                dashes(points, &subpath.cumulative, allowed, 2., 4.2, phase)
            } else {
                vec![trim(points, &subpath.cumulative, allowed)]
            };
            for segment in segments {
                if segment.len() < 2 {
                    continue;
                }
                builder.move_to(map(segment[0]));
                for &p in &segment[1..] {
                    builder.line_to(map(p));
                }
                if stroke.fill || (subpath.closed && allowed >= length && !stroke.march) {
                    builder.close();
                }
                any = true;
            }
        }
        if any && let Ok(path) = builder.build() {
            window.paint_path(path, color);
        }
    }
}

fn trim(points: &[(f32, f32)], cumulative: &[f32], allowed: f32) -> Polyline {
    let mut out = Vec::with_capacity(points.len());
    for (i, &point) in points.iter().enumerate() {
        if cumulative[i] <= allowed {
            out.push(point);
            continue;
        }
        if i > 0 {
            let span = cumulative[i] - cumulative[i - 1];
            let t = if span > 0. {
                (allowed - cumulative[i - 1]) / span
            } else {
                0.
            };
            let a = points[i - 1];
            out.push((a.0 + (point.0 - a.0) * t, a.1 + (point.1 - a.1) * t));
        }
        break;
    }
    out
}

fn dashes(
    points: &[(f32, f32)],
    cumulative: &[f32],
    allowed: f32,
    on: f32,
    off: f32,
    phase: f32,
) -> Vec<Polyline> {
    let period = on + off;
    let mut out = Vec::new();
    let mut start = -phase.rem_euclid(period);
    while start < allowed {
        let (a, b) = (start.max(0.), (start + on).min(allowed));
        if b > a {
            out.push(slice(points, cumulative, a, b));
        }
        start += period;
    }
    out
}

fn slice(points: &[(f32, f32)], cumulative: &[f32], from: f32, to: f32) -> Polyline {
    let at = |distance: f32| -> (f32, f32) {
        let index = cumulative
            .partition_point(|&c| c < distance)
            .min(points.len() - 1);
        if index == 0 {
            return points[0];
        }
        let span = cumulative[index] - cumulative[index - 1];
        let t = if span > 0. {
            (distance - cumulative[index - 1]) / span
        } else {
            0.
        };
        let (a, b) = (points[index - 1], points[index]);
        (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
    };
    let mut out = vec![at(from)];
    for (i, &c) in cumulative.iter().enumerate() {
        if c > from && c < to {
            out.push(points[i]);
        }
    }
    out.push(at(to));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lines_curves_and_implicit_repeats() {
        let subpaths = parse("M 0 0 L 10 0 10 10 Z M 0 20 q 6 -7 12 0 t 12 0");
        assert_eq!(subpaths.len(), 2);
        assert!(subpaths[0].1);
        let first = &subpaths[0].0;
        assert_eq!(first.first(), Some(&(0., 0.)));
        assert_eq!(first.last(), Some(&(0., 0.)));
        let wave = &subpaths[1].0;
        let end = wave.last().unwrap();
        assert!((end.0 - 24.).abs() < 0.01 && (end.1 - 20.).abs() < 0.01);
    }

    #[test]
    fn a_lone_point_becomes_a_dot() {
        let subpaths = parse("M 60 75 L 60 75");
        assert_eq!(subpaths.len(), 1);
        assert!(subpaths[0].0.len() >= 2);
    }

    #[test]
    fn trim_and_dashes_respect_arc_length() {
        let points: Polyline = (0..=10).map(|i| (i as f32, 0.)).collect();
        let cumulative: Vec<f32> = (0..=10).map(|i| i as f32).collect();
        let half = trim(&points, &cumulative, 5.5);
        assert!((half.last().unwrap().0 - 5.5).abs() < 0.001);
        let dashes = dashes(&points, &cumulative, 10., 2., 3., 0.);
        assert_eq!(dashes.len(), 2);
        assert!((dashes[1][0].0 - 5.).abs() < 0.001);
    }

    #[test]
    fn boil_stays_within_amplitude_and_variants_differ() {
        let points: Polyline = (0..50).map(|i| (i as f32 * 2., 10.)).collect();
        let a = boil(&points, 1);
        let b = boil(&points, 2);
        for (original, moved) in points.iter().zip(&a) {
            assert!(distance(*original, *moved) <= BOIL_AMPLITUDE * 1.5);
        }
        assert_ne!(a, b);
    }
}
