//! Mask tracking against generated screen-recording scenarios.
//!
//! Each scenario draws a UI-like page (rows of word-shaped dashes, the
//! look-alikes a tracker meets in real recordings) with one "secret" card
//! whose box is known exactly every frame, at the editor's tracking
//! resolution. The tracked path is saved the way the editor saves it and
//! scored the way a sensitive mask fails: by how much of the *visible* card
//! falls outside the mask.
//!
//! Thresholds sit just under what the trackers achieve today, so a change
//! that loosens tracking shows up as a named scenario and a frame time.

use cap_gpui_kernels::motion_track::{LumaFrame, TrackPoint, TrackSession};
use cap_gpui_kernels::point_track::PointTrackSession;
use cap_project::{MaskKind, MaskSegment, XY};

const WIDTH: usize = 960;
const HEIGHT: usize = 540;
const FPS: f64 = 30.0;
const FRAMES: usize = 150;

type Rect = (f64, f64, f64, f64);

/// Deterministic noise so every run sees the same page.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as f64 / (1u64 << 31) as f64
    }

    fn range(&mut self, low: usize, high: usize) -> usize {
        low + (self.next() * (high - low) as f64) as usize
    }
}

#[derive(Clone)]
struct Image {
    width: usize,
    height: usize,
    pixels: Vec<f32>,
}

impl Image {
    fn filled(width: usize, height: usize, value: f32) -> Self {
        Self {
            width,
            height,
            pixels: vec![value; width * height],
        }
    }

    fn fill(&mut self, (x0, y0, x1, y1): (usize, usize, usize, usize), value: f32) {
        for y in y0..y1.min(self.height) {
            for x in x0..x1.min(self.width) {
                self.pixels[y * self.width + x] = value;
            }
        }
    }

    /// Rows of word-shaped dashes, like text in a document or a feed.
    fn text_page(width: usize, height: usize, ink: f32, paper: f32, rng: &mut Lcg) -> Self {
        let mut page = Self::filled(width, height, paper);
        let mut y = 5;
        while y + 14 < height {
            let mut x = 8 + rng.range(0, 20);
            while x + 30 < width {
                let word = rng.range(9, 52);
                page.fill((x, y + 3, x + word, y + 11), ink);
                x += word + rng.range(5, 11);
            }
            y += 21;
        }
        page
    }

    /// A dark card with a header bar, light text rows and a checker block.
    fn secret_card(width: usize, height: usize, rng: &mut Lcg) -> Self {
        let mut card = Self::filled(width, height, 38.0);
        let header = (height / 6).max(5);
        card.fill((0, 0, width, header), 215.0);
        let text = Self::text_page(width - 54, height - header - 6, 230.0, 38.0, rng);
        card.paste(&text, 6.0, (header + 3) as f64);
        let side = (height - header - 10).min(36);
        let cell = side / 6;
        for row in 0..6 {
            for column in 0..6 {
                let value = if rng.next() > 0.5 { 240.0 } else { 40.0 };
                let x = width - side - 6 + column * cell;
                let y = header + 5 + row * cell;
                card.fill((x, y, x + cell, y + cell), value);
            }
        }
        card
    }

    fn resized(&self, width: usize, height: usize) -> Self {
        let mut out = Self::filled(width, height, 0.0);
        for y in 0..height {
            for x in 0..width {
                out.pixels[y * width + x] =
                    self.pixels[(y * self.height / height) * self.width + x * self.width / width];
            }
        }
        out
    }

    /// Keeps only the pixels where `inside(x, y)` holds, with `x` and `y`
    /// from -1 to 1 across the sprite; the rest become transparent.
    fn cut(mut self, inside: impl Fn(f64, f64) -> bool) -> Self {
        for y in 0..self.height {
            for x in 0..self.width {
                let u = (x as f64 + 0.5) / self.width as f64 * 2.0 - 1.0;
                let v = (y as f64 + 0.5) / self.height as f64 * 2.0 - 1.0;
                if !inside(u, v) {
                    self.pixels[y * self.width + x] = f32::NAN;
                }
            }
        }
        self
    }

    /// A window at `width` by `height`: a dark title bar with its three
    /// buttons, a border, and a document whose text reflows (is cropped,
    /// not stretched) as the window resizes from its bottom-right corner.
    fn window(document: &Self, width: usize, height: usize) -> Self {
        let mut window = Self::filled(width, height, 250.0);
        window.paste(&document.crop(0, 0, width - 4, height - 26), 2.0, 24.0);
        window.fill((0, 0, width, 22), 58.0);
        for (index, value) in [200.0, 150.0, 110.0].into_iter().enumerate() {
            let x = 8 + index * 14;
            window.fill((x, 6, x + 9, 15), value);
        }
        window.fill((width / 2 - 30, 8, width / 2 + 30, 13), 170.0);
        window.fill((0, 0, 2, height), 120.0);
        window.fill((width - 2, 0, width, height), 120.0);
        window.fill((0, height - 2, width, height), 120.0);
        window
    }

    /// Pastes with clipping and returns the visible box. NaN pixels in the
    /// sprite are transparent, which is how the rounded shapes are cut out.
    fn paste(&mut self, sprite: &Self, x: f64, y: f64) -> Option<Rect> {
        let (x, y) = (x.round() as isize, y.round() as isize);
        let x0 = x.max(0) as usize;
        let y0 = y.max(0) as usize;
        let x1 = (x + sprite.width as isize).clamp(0, self.width as isize) as usize;
        let y1 = (y + sprite.height as isize).clamp(0, self.height as isize) as usize;
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        for row in y0..y1 {
            let source = (row as isize - y) as usize * sprite.width;
            for column in x0..x1 {
                let value = sprite.pixels[source + (column as isize - x) as usize];
                if !value.is_nan() {
                    self.pixels[row * self.width + column] = value;
                }
            }
        }
        Some((x0 as f64, y0 as f64, x1 as f64, y1 as f64))
    }

    fn crop(&self, x: usize, y: usize, width: usize, height: usize) -> Self {
        let mut out = Self::filled(width, height, 0.0);
        for row in 0..height {
            let from = (y + row) * self.width + x;
            out.pixels[row * width..(row + 1) * width]
                .copy_from_slice(&self.pixels[from..from + width]);
        }
        out
    }

    fn luma(&self, gain: f32, noise: Option<&mut Lcg>) -> LumaFrame {
        let mut rgba = Vec::with_capacity(self.pixels.len() * 4);
        let mut noise = noise;
        for &value in &self.pixels {
            let grain = noise
                .as_deref_mut()
                .map_or(0.0, |rng| (rng.next() as f32 - 0.5) * 36.0);
            let value = (value * gain + grain).clamp(0.0, 255.0) as u8;
            rgba.extend_from_slice(&[value, value, value, 255]);
        }
        LumaFrame::from_rgba(&rgba, self.width as u32, self.height as u32, self.width * 4)
    }
}

/// One generated frame: what the tracker sees, and where the card is.
struct Frame {
    luma: LumaFrame,
    full: Option<Rect>,
    visible: Option<Rect>,
}

fn ease(t: f64) -> f64 {
    0.5 - 0.5 * (std::f64::consts::PI * t.clamp(0.0, 1.0)).cos()
}

fn progress(index: usize) -> f64 {
    index as f64 / (FRAMES - 1) as f64
}

fn plain(page: &Image, card: &Image, x: f64, y: f64) -> Frame {
    let mut frame = page.clone();
    let full = frame.paste(card, x, y);
    Frame {
        luma: frame.luma(1.0, None),
        full,
        visible: full,
    }
}

fn pan() -> Vec<Frame> {
    let mut rng = Lcg(7);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(195, 90, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let t = ease(progress(i));
            let wobble = 30.0 * (i as f64 / 9.0).sin();
            plain(&page, &card, 90.0 + 570.0 * t, 90.0 + 315.0 * t + wobble)
        })
        .collect()
}

/// The card is one of a feed of same-styled cards that scrolls unevenly and
/// pauses, so every neighbour is a look-alike.
fn feed_scroll() -> Vec<Frame> {
    let mut rng = Lcg(11);
    let mut feed = Image::text_page(WIDTH, HEIGHT * 3, 70.0, 242.0, &mut rng);
    let mut tops = Vec::new();
    for index in 0..8 {
        let card = Image::secret_card(225, 82, &mut rng);
        let top = 135 + index * 195;
        feed.paste(&card, 360.0, top as f64);
        tops.push(top);
    }
    let top = tops[1] as f64;
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let offset = 300.0 * ease(u / 0.45) + 200.0 * ease((u - 0.6) / 0.4);
            let frame = feed.crop(0, offset as usize, WIDTH, HEIGHT);
            let y = top - offset.floor();
            let full = (y + 82.0 > 0.0).then(|| (360.0, y.max(0.0), 585.0, y + 82.0));
            Frame {
                luma: frame.luma(1.0, None),
                full,
                visible: full,
            }
        })
        .collect()
}

/// Cap's zoom: the whole frame scales about a focus point, so the card
/// grows and slides at once, then zooms back out.
fn zoom() -> Vec<Frame> {
    let mut rng = Lcg(13);
    let mut page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(165, 75, &mut rng);
    let (card_x, card_y) = (525.0, 225.0);
    page.paste(&card, card_x, card_y);
    let focus = (480.0, 270.0);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let scale = 1.0
                + 1.2
                    * if u < 0.65 {
                        ease(u / 0.35)
                    } else {
                        ease((1.0 - u) / 0.35)
                    };
            let mut frame = Image::filled(WIDTH, HEIGHT, 0.0);
            for y in 0..HEIGHT {
                let source_y =
                    ((y as f64 - focus.1) / scale + focus.1).clamp(0.0, HEIGHT as f64 - 1.0);
                for x in 0..WIDTH {
                    let source_x =
                        ((x as f64 - focus.0) / scale + focus.0).clamp(0.0, WIDTH as f64 - 1.0);
                    frame.pixels[y * WIDTH + x] =
                        page.pixels[source_y as usize * WIDTH + source_x as usize];
                }
            }
            let map = |x: f64, y: f64| {
                (
                    (x - focus.0) * scale + focus.0,
                    (y - focus.1) * scale + focus.1,
                )
            };
            let (x0, y0) = map(card_x, card_y);
            let (x1, y1) = map(card_x + 165.0, card_y + 75.0);
            let full = Some((
                x0.max(0.0),
                y0.max(0.0),
                x1.min(WIDTH as f64),
                y1.min(HEIGHT as f64),
            ));
            Frame {
                luma: frame.luma(1.0, None),
                full,
                visible: full,
            }
        })
        .collect()
}

/// A window slides across and hides most of the card for a moment. Only the
/// part still on screen can leak.
fn occlusion() -> Vec<Frame> {
    let mut rng = Lcg(17);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(195, 90, &mut rng);
    let panel = Image::text_page(315, 270, 120.0, 210.0, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let mut frame = page.clone();
            let full = frame.paste(&card, 150.0 + 375.0 * u, 225.0);
            let panel_x = (-345.0 + 1125.0 * ease((u - 0.25) / 0.5)).round();
            frame.paste(&panel, panel_x, 150.0);
            let visible = full.and_then(|(x0, y0, x1, y1)| {
                let (cover0, cover1) = (panel_x, panel_x + 315.0);
                if cover1 <= x0 || cover0 >= x1 {
                    Some((x0, y0, x1, y1))
                } else if cover0 <= x0 && cover1 >= x1 {
                    None
                } else if cover0 <= x0 {
                    Some((cover1, y0, x1, y1))
                } else {
                    Some((x0, y0, cover0, y1))
                }
            });
            Frame {
                luma: frame.luma(1.0, None),
                full,
                visible,
            }
        })
        .collect()
}

/// Brightness swings and sensor-like grain while the card wanders.
fn fade_and_noise() -> Vec<Frame> {
    let mut rng = Lcg(19);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(180, 82, &mut rng);
    let mut grain = Lcg(23);
    (0..FRAMES)
        .map(|i| {
            let step = i as f64;
            let mut frame = page.clone();
            let full = frame.paste(
                &card,
                390.0 + 270.0 * (step / 23.0).sin(),
                195.0 + 120.0 * (step / 17.0).sin(),
            );
            let gain = 0.75 + 0.35 * (step / 11.0).sin() as f32;
            Frame {
                luma: frame.luma(gain, Some(&mut grain)),
                full,
                visible: full,
            }
        })
        .collect()
}

/// The card slides off the right edge and comes back.
fn exit_and_return() -> Vec<Frame> {
    let mut rng = Lcg(29);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(180, 82, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let x = 525.0 + 675.0 * (std::f64::consts::PI * progress(i)).sin();
            plain(&page, &card, x, 240.0)
        })
        .collect()
}

/// A panel resized from its top-left corner: width grows the whole time
/// while height first shrinks then grows back, so its aspect ratio changes.
fn panel_resize() -> Vec<Frame> {
    let mut rng = Lcg(31);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(225, 105, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let width = (165.0 + 195.0 * ease(u)) as usize;
            let height = (105.0 - 38.0 * ease((u * 2.0).min(1.0))
                + 38.0 * ease((u * 2.0 - 1.0).max(0.0))) as usize;
            plain(&page, &card.resized(width, height), 285.0, 195.0)
        })
        .collect()
}

/// A window resized by its bottom-right corner, the way people resize
/// windows: chrome stays the same size and the document reflows.
fn window_resize() -> Vec<Frame> {
    let mut rng = Lcg(37);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let document = Image::text_page(480, 260, 60.0, 250.0, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let width = (240.0 + 180.0 * ease(u)) as usize;
            let height = (150.0 - 40.0 * ease((u * 2.0).min(1.0))
                + 80.0 * ease((u * 2.0 - 1.0).max(0.0))) as usize;
            plain(
                &page,
                &Image::window(&document, width, height),
                240.0,
                150.0,
            )
        })
        .collect()
}

/// A round avatar that drifts across the page and grows, as in a zoom.
fn round_badge() -> Vec<Frame> {
    let mut rng = Lcg(41);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let face = Image::secret_card(170, 170, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let side = (110.0 + 60.0 * ease(u)) as usize;
            let badge = face.resized(side, side).cut(|x, y| x * x + y * y <= 1.0);
            plain(&page, &badge, 200.0 + 420.0 * u, 120.0 + 180.0 * ease(u))
        })
        .collect()
}

/// A card with large rounded corners: points clicked on the curves sit
/// inside the box, not on its corners.
fn rounded_card() -> Vec<Frame> {
    let mut rng = Lcg(43);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let card = Image::secret_card(240, 120, &mut rng).cut(|x, y| {
        let (rx, ry) = (0.2, 0.4);
        let (dx, dy) = (
            (x.abs() - (1.0 - rx)).max(0.0) / rx,
            (y.abs() - (1.0 - ry)).max(0.0) / ry,
        );
        dx * dx + dy * dy <= 1.0
    });
    (0..FRAMES)
        .map(|i| {
            let t = ease(progress(i));
            plain(&page, &card, 120.0 + 500.0 * t, 330.0 - 220.0 * t)
        })
        .collect()
}

/// A hexagonal logo panning while the page zooms in on it: six points, one
/// on each vertex.
fn hexagon_logo() -> Vec<Frame> {
    let mut rng = Lcg(47);
    let page = Image::text_page(WIDTH, HEIGHT, 70.0, 242.0, &mut rng);
    let logo = Image::secret_card(200, 174, &mut rng);
    (0..FRAMES)
        .map(|i| {
            let u = progress(i);
            let scale = 1.0 + 0.6 * ease(u);
            let (width, height) = ((140.0 * scale) as usize, (122.0 * scale) as usize);
            let hexagon = logo
                .resized(width, height)
                .cut(|x, y| y.abs() <= 1.0 && x.abs() + y.abs() * 0.5 <= 1.0);
            plain(&page, &hexagon, 520.0 - 260.0 * u, 260.0 - 120.0 * u)
        })
        .collect()
}

fn area((x0, y0, x1, y1): Rect) -> f64 {
    (x1 - x0).max(0.0) * (y1 - y0).max(0.0)
}

fn overlap(a: Rect, b: Rect) -> f64 {
    area((a.0.max(b.0), a.1.max(b.1), a.2.min(b.2), a.3.min(b.3)))
}

fn time(index: usize) -> f64 {
    index as f64 / FPS
}

/// What the editor saves for a tracked path: a sensitive mask whose
/// keyframes are the path simplified with the editor's tolerance
/// (`MARKER_TOLERANCE` in `editor_mask_tracking.rs`), grown by the margin
/// that simplification needs. Scoring this rather than the raw path holds
/// the whole chain to account, not just the tracker.
fn saved_mask(path: &[TrackPoint]) -> MaskSegment {
    const MARKER_TOLERANCE: f64 = 0.003;
    let mut mask = MaskSegment {
        start: 0.0,
        end: time(FRAMES),
        track: 0,
        enabled: true,
        mask_type: MaskKind::Sensitive,
        center: XY::new(path[0].center.0, path[0].center.1),
        size: XY::new(path[0].size.0, path[0].size.1),
        feather: 0.0,
        opacity: 1.0,
        pixelation: 18.0,
        darkness: 0.0,
        fade_duration: 0.0,
        keyframes: Default::default(),
    };
    let path = path
        .iter()
        .map(|point| {
            (
                point.time,
                XY::new(point.center.0, point.center.1),
                XY::new(point.size.0, point.size.1),
            )
        })
        .collect::<Vec<_>>();
    mask.apply_tracked_path(&path, MARKER_TOLERANCE);
    mask
}

/// The saved mask's box at `at`, in tracking pixels.
fn box_at(mask: &MaskSegment, at: f64) -> Rect {
    let (center, size) = mask.rect_at(at);
    (
        (center.x - size.x / 2.0) * WIDTH as f64,
        (center.y - size.y / 2.0) * HEIGHT as f64,
        (center.x + size.x / 2.0) * WIDTH as f64,
        (center.y + size.y / 2.0) * HEIGHT as f64,
    )
}

struct Score {
    mean_coverage: f64,
    max_leak_px: f64,
    worst_at: f64,
    mean_iou: f64,
}

/// Coverage is the share of the visible card inside the tracked box; a leak
/// is the visible card area left outside it, in tracking-resolution pixels.
fn score(frames: &[Frame], path: &[TrackPoint]) -> Score {
    let (mut coverage, mut iou, mut counted) = (0.0, 0.0, 0.0);
    let (mut max_leak_px, mut worst_at) = (0.0, 0.0);
    let saved = saved_mask(path);
    for (index, frame) in frames.iter().enumerate() {
        let Some(full) = frame.full else { continue };
        let mask = box_at(&saved, time(index));
        let leak = frame
            .visible
            .map_or(0.0, |visible| area(visible) - overlap(mask, visible));
        if leak > max_leak_px {
            (max_leak_px, worst_at) = (leak, time(index));
        }
        coverage += frame.visible.map_or(1.0, |visible| {
            overlap(mask, visible) / area(visible).max(1.0)
        });
        iou += overlap(mask, full) / (area(mask) + area(full) - overlap(mask, full)).max(1.0);
        counted += 1.0;
    }
    Score {
        mean_coverage: coverage / counted,
        max_leak_px,
        worst_at,
        mean_iou: iou / counted,
    }
}

fn normalized((x0, y0, x1, y1): Rect) -> ((f64, f64), (f64, f64)) {
    (
        (
            (x0 + x1) / 2.0 / WIDTH as f64,
            (y0 + y1) / 2.0 / HEIGHT as f64,
        ),
        ((x1 - x0) / WIDTH as f64, (y1 - y0) / HEIGHT as f64),
    )
}

fn track_box(frames: Vec<Frame>) -> (Vec<Frame>, Vec<TrackPoint>) {
    let (center, size) = normalized(frames[0].full.unwrap());
    let mut session =
        TrackSession::new(&frames[0].luma, 0.0, center, size).expect("trackable card");
    let mut kept = Vec::with_capacity(frames.len());
    for (index, frame) in frames.into_iter().enumerate() {
        if index > 0 {
            session.push(time(index), frame.luma.clone());
        }
        kept.push(frame);
    }
    (kept, session.finish().0)
}

/// Corners of the first frame's box, the four points a user clicks on a
/// rectangle: on its outermost pixels (the box's right and bottom bounds
/// are exclusive).
fn box_corners(frames: &[Frame]) -> Vec<(f64, f64)> {
    let (x0, y0, x1, y1) = frames[0].full.unwrap();
    let (x1, y1) = (x1 - 1.0, y1 - 1.0);
    vec![(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
}

/// `count` points evenly around the ellipse inscribed in the first frame's
/// box, starting at the top: what a user clicks around a round object.
fn around_ellipse(frames: &[Frame], count: usize, inset: f64) -> Vec<(f64, f64)> {
    let (x0, y0, x1, y1) = frames[0].full.unwrap();
    let (cx, cy, rx, ry) = (
        (x0 + x1) / 2.0,
        (y0 + y1) / 2.0,
        (x1 - x0) / 2.0 - inset,
        (y1 - y0) / 2.0 - inset,
    );
    (0..count)
        .map(|k| {
            let angle =
                -std::f64::consts::FRAC_PI_2 + k as f64 * std::f64::consts::TAU / count as f64;
            (cx + rx * angle.cos(), cy + ry * angle.sin())
        })
        .collect()
}

/// The hexagon's six vertices.
fn hexagon_vertices(frames: &[Frame]) -> Vec<(f64, f64)> {
    let (x0, y0, x1, y1) = frames[0].full.unwrap();
    let (cx, w) = ((x0 + x1) / 2.0, x1 - x0);
    vec![
        (x0, (y0 + y1) / 2.0),
        (cx - w / 4.0, y0),
        (cx + w / 4.0, y0),
        (x1, (y0 + y1) / 2.0),
        (cx + w / 4.0, y1 - 1.0),
        (cx - w / 4.0, y1 - 1.0),
    ]
}

fn track_points(
    frames: Vec<Frame>,
    pick: impl Fn(&[Frame]) -> Vec<(f64, f64)>,
) -> (Vec<Frame>, Vec<TrackPoint>) {
    let points = pick(&frames)
        .into_iter()
        .map(|(x, y)| (x / WIDTH as f64, y / HEIGHT as f64))
        .collect::<Vec<_>>();
    let mut session =
        PointTrackSession::new(&frames[0].luma, 0.0, &points).expect("trackable points");
    let mut kept = Vec::with_capacity(frames.len());
    for (index, frame) in frames.into_iter().enumerate() {
        if index > 0 {
            session.push(time(index), frame.luma.clone());
        }
        kept.push(frame);
    }
    (kept, session.finish().0)
}

fn assert_tracks(
    name: &str,
    (frames, path): (Vec<Frame>, Vec<TrackPoint>),
    min_coverage: f64,
    max_leak_px: f64,
) {
    let score = score(&frames, &path);
    let summary = format!(
        "{name}: coverage {:.4}, IoU {:.3}, worst leak {:.0}px at {:.2}s",
        score.mean_coverage, score.mean_iou, score.max_leak_px, score.worst_at
    );
    eprintln!("{summary}");
    assert!(
        score.mean_coverage >= min_coverage && score.max_leak_px <= max_leak_px,
        "{summary}"
    );
}

#[test]
fn box_tracking_covers_a_panning_card() {
    assert_tracks("pan", track_box(pan()), 0.99, 400.0);
}

#[test]
fn box_tracking_stays_on_its_card_in_a_scrolling_feed_of_look_alikes() {
    assert_tracks("feed scroll", track_box(feed_scroll()), 0.98, 400.0);
}

/// The box lags a fast zoom-out by a few pixels per edge; the leak bound
/// pins today's lag rather than claiming there is none.
#[test]
fn box_tracking_grows_with_a_cap_zoom() {
    assert_tracks("zoom", track_box(zoom()), 0.985, 2500.0);
}

#[test]
fn box_tracking_covers_the_visible_part_of_an_occluded_card() {
    assert_tracks("occlusion", track_box(occlusion()), 0.98, 800.0);
}

#[test]
fn box_tracking_survives_brightness_swings_and_grain() {
    assert_tracks("fade and noise", track_box(fade_and_noise()), 0.98, 600.0);
}

/// Re-acquiring the card as it slides back in costs a few frames of its
/// leading edge.
#[test]
fn box_tracking_finds_a_card_that_leaves_and_returns() {
    assert_tracks(
        "exit and return",
        track_box(exit_and_return()),
        0.985,
        650.0,
    );
}

#[test]
fn point_tracking_follows_a_window_resized_from_its_corner() {
    assert_tracks(
        "window resize",
        track_points(window_resize(), box_corners),
        0.99,
        1100.0,
    );
}

/// Every pixel stretches, so no patch keeps its look; the box still has to
/// widen without growing taller.
#[test]
fn point_tracking_follows_a_panel_stretched_out_of_proportion() {
    assert_tracks(
        "panel stretch",
        track_points(panel_resize(), box_corners),
        0.97,
        1200.0,
    );
}

/// Four points on a curve are the least evidence a shape can give: the
/// worst frame still uncovers a few pixels along one side. Eight points
/// (below) cut that by two thirds.
#[test]
fn four_points_around_a_round_badge_cover_it_as_it_moves_and_grows() {
    assert_tracks(
        "badge, 4 points",
        track_points(round_badge(), |f| around_ellipse(f, 4, 1.0)),
        0.99,
        1800.0,
    );
}

#[test]
fn eight_points_around_a_round_badge_cover_it_as_it_moves_and_grows() {
    assert_tracks(
        "badge, 8 points",
        track_points(round_badge(), |f| around_ellipse(f, 8, 1.0)),
        0.98,
        600.0,
    );
}

#[test]
fn points_on_rounded_corners_cover_the_card() {
    assert_tracks(
        "rounded card",
        track_points(rounded_card(), |f| {
            around_ellipse(f, 8, 0.0)
                .into_iter()
                .chain(box_corners(f))
                .collect()
        }),
        0.98,
        600.0,
    );
}

#[test]
fn six_points_on_a_hexagon_follow_it_through_a_zoom() {
    assert_tracks(
        "hexagon, 6 points",
        track_points(hexagon_logo(), hexagon_vertices),
        0.98,
        800.0,
    );
}
