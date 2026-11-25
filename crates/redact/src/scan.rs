//! Per-frame analysis of one display segment. Every frame's changed tiles go
//! through the detector. Each distinct line is read once and found again by
//! its pixels. Lines keep an identity
//! across frames, so a string found sensitive in any frame is hidden over the
//! line's whole life, including frames where only part of it was readable.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
    time::Instant,
};

use cap_project::{
    RedactCategory,
    redaction::{RedactionKey, RedactionRegion},
};

use crate::{
    analyze::{Stats, join_same_masks, merge_overlapping, region_id, simplify_keys},
    classify::{
        Finding, LineContext, classify_frame_with, classify_line, classify_line_with_alternatives,
    },
    frames::{self, FrameSource},
    image::{GrayImage, Rect, RgbImage},
    model::{OcrModel, PendingDetect},
    motion::{ChangeMap, TILE, diff_tiles, mean_difference},
};

/// The scan's mechanisms. All are on in every normal build; a build with the
/// `ablation` feature reads `CAP_REDACT_OFF=name,...` to turn some off and
/// measure what each one is worth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Switches {
    /// Reuse the reading of a line whose pixels were read before.
    pub cache: bool,
    /// Detect only changed tiles (off: the whole frame on any change).
    pub tiles: bool,
    /// Hide a line over its whole life once any reading of it is sensitive.
    pub propagate: bool,
    /// Pad each sensitive span by about a character on both sides.
    pub pad: bool,
    /// Hide readings that share a long run of characters with a sensitive
    /// string found anywhere in the recording.
    pub known: bool,
    /// Join boxes on one row separated by less than half a line height (a
    /// detector splitting a large monospace line inside a token).
    pub rowmerge: bool,
    /// Detect a line again along its row when it runs out of the changed
    /// region it was found in.
    pub strips: bool,
    /// Also match strict patterns in the reading the recogniser's runner-up
    /// characters make.
    pub alternatives: bool,
}

impl Switches {
    #[cfg(not(feature = "ablation"))]
    pub fn all_on() -> Self {
        Self::with_off("")
    }

    #[cfg(feature = "ablation")]
    pub fn from_env() -> Self {
        Self::with_off(&std::env::var("CAP_REDACT_OFF").unwrap_or_default())
    }

    #[cfg(not(feature = "ablation"))]
    pub fn from_env() -> Self {
        Self::all_on()
    }

    fn with_off(off: &str) -> Self {
        let on = |name: &str| !off.split(',').any(|item| item.trim() == name);
        Self {
            cache: on("cache"),
            tiles: on("tiles"),
            propagate: on("propagate"),
            pad: on("pad"),
            strips: on("strips"),
            rowmerge: on("rowmerge"),
            known: on("known"),
            alternatives: on("alternatives"),
        }
    }
}

const THUMB_BLOCK: usize = 8;
/// Mean and per-block luma differences under which two crops are the same
/// line re-encoded.
const THUMB_MEAN: u32 = 7;
const THUMB_BLOCK_MAX: u32 = 16;
const CACHE_LIMIT: usize = 6000;
const LINE_BLOCK: usize = 16;
/// How far, in line heights, a line cut by its region's edge is detected
/// again on either side.
const STRIP_REACH: f32 = 20.0;
/// Sensitive strings remembered for matching other readings: categories
/// without shared boilerplate (unlike links and names), at least this long.
const KNOWN_CATEGORIES: [RedactCategory; 5] = [
    RedactCategory::Secret,
    RedactCategory::Card,
    RedactCategory::Phone,
    RedactCategory::Ip,
    RedactCategory::Email,
];
const KNOWN_MIN_LEN: usize = 8;
/// Line height, in detector pixels, that the adaptive scale aims the
/// smaller quarter of on-screen text at, its floor, and how many recent
/// lines it looks at.
const TEXT_HEIGHT: f32 = 24.0;
const MIN_DETECT_SCALE: f32 = 0.35;
const HEIGHT_SAMPLES: usize = 200;
/// How long before the next frame a held mask lets go (keys need distinct
/// times).
const HOLD: f64 = 1e-4;
/// Lines of at most this many characters are hidden whole once any part of
/// them is sensitive.
const SHORT_LINE: usize = 32;
/// Box height in frame pixels from which the row merge accepts uneven boxes.
const LARGE_TEXT: f32 = 28.0;
const KNOWN_MIN_SHARED: usize = 10;
/// Share of a known string a run from its middle must cover to match.
const KNOWN_MOST: f32 = 0.6;
/// Frame pixels from the left or right edge within which a line is cut by it.
const EDGE: f32 = 3.0;
/// Characters of a known string that a line cut by the frame's edge must show
/// on its cut side.
const EDGE_MIN_SHARED: usize = 4;
/// Mean luma difference under which a block of a line is unchanged
/// (re-encoding noise), well under one changed character's.
const LINE_BLOCK_MEAN: u32 = 8;

struct Reading {
    text: String,
    /// Each character's x-span as a fraction of the line's width.
    spans: Vec<(f32, f32)>,
    own: Vec<Finding>,
    /// The line ran into the frame's left or right edge when it was read, so
    /// its text may be the end or the start of a longer string.
    cut_left: bool,
    cut_right: bool,
}

/// A line's full-resolution luma crop.
struct Thumb {
    width: usize,
    height: usize,
    pixels: Vec<u8>,
}

struct CacheEntry {
    thumb: Thumb,
    reading: u32,
}

#[derive(Default)]
struct ReadCache {
    entries: VecDeque<CacheEntry>,
}

impl ReadCache {
    fn find(&self, thumb: &Thumb) -> Option<u32> {
        self.entries
            .iter()
            .rev()
            .find(|entry| {
                entry.thumb.width.abs_diff(thumb.width) <= 4
                    && entry.thumb.height.abs_diff(thumb.height) <= 3
                    && thumbs_match(&entry.thumb, thumb)
            })
            .map(|entry| entry.reading)
    }

    fn insert(&mut self, thumb: Thumb, reading: u32) {
        self.entries.push_back(CacheEntry { thumb, reading });
        if self.entries.len() > CACHE_LIMIT {
            self.entries.pop_front();
        }
    }
}

/// Whether two crops show the same pixels, allowing the detector's box to
/// sit up to two pixels differently.
fn thumbs_match(a: &Thumb, b: &Thumb) -> bool {
    (-2..=2).any(|dy| (-2..=2).any(|dx| aligned_match(a, b, dx, dy)))
}

/// Whether `b` matches `a` with `b`'s pixel (x, y) at `a`'s (x + dx, y + dy).
fn aligned_match(a: &Thumb, b: &Thumb, dx: i32, dy: i32) -> bool {
    let x_start = (-dx).max(0) as usize;
    let x_end = (a.width as i32 - dx).min(b.width as i32);
    let y_start = (-dy).max(0) as usize;
    let y_end = (a.height as i32 - dy).min(b.height as i32);
    if x_end <= x_start as i32 || y_end <= y_start as i32 {
        return false;
    }
    let (x_end, y_end) = (x_end as usize, y_end as usize);
    if x_end - x_start + 4 < a.width.max(b.width) || y_end - y_start + 3 < a.height.max(b.height) {
        return false;
    }
    let mut total = 0u64;
    let mut count = 0u64;
    let mut column = x_start;
    while column < x_end {
        let block_end = (column + THUMB_BLOCK).min(x_end);
        let mut sum = 0u32;
        for y in y_start..y_end {
            let ya = (y as i32 + dy) as usize;
            let row_a = &a.pixels[ya * a.width..(ya + 1) * a.width];
            let row_b = &b.pixels[y * b.width..(y + 1) * b.width];
            for x in column..block_end {
                sum += u32::from(row_a[(x as i32 + dx) as usize].abs_diff(row_b[x]));
            }
        }
        let pixels = ((block_end - column) * (y_end - y_start)) as u32;
        if sum / pixels > THUMB_BLOCK_MAX {
            return false;
        }
        total += u64::from(sum);
        count += u64::from(pixels);
        column = block_end;
    }
    total / count.max(1) <= u64::from(THUMB_MEAN)
}

/// The line's full-resolution luma, the read cache's key.
fn thumbnail(luma: &GrayImage, rect: Rect) -> Option<Thumb> {
    let rect = rect.clamp_to(luma.width, luma.height);
    let (x0, y0) = (rect.x.round() as usize, rect.y.round() as usize);
    let width = (rect.w.round() as usize).min(luma.width as usize - x0);
    let height = (rect.h.round() as usize).min(luma.height as usize - y0);
    if width < 2 || height < 2 {
        return None;
    }
    let stride = luma.width as usize;
    let mut pixels = Vec::with_capacity(width * height);
    for y in y0..y0 + height {
        pixels.extend_from_slice(&luma.data[y * stride + x0..y * stride + x0 + width]);
    }
    Some(Thumb {
        width,
        height,
        pixels,
    })
}

struct Run {
    t0: f64,
    t1: f64,
    rect: Rect,
    reading: u32,
}

#[derive(Default)]
struct Identity {
    runs: Vec<Run>,
    /// Findings per reading of the line, from the line itself and from the
    /// lines around it when it was read.
    findings: HashMap<u32, Vec<Finding>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum LineState {
    Same,
    Touched,
}

struct Live {
    identity: usize,
    rect: Rect,
    reading: u32,
    state: LineState,
}

/// A frame after [`Scan::prepare`], waiting for [`Scan::finish`].
pub struct Prepared {
    time: f64,
    video: ffmpeg::frame::Video,
    luma: Arc<GrayImage>,
    previous_luma: Option<Arc<GrayImage>>,
    changed: ChangeMap,
    duplicate: bool,
    rois: Vec<Rect>,
    rgb: Option<(RgbImage, bool)>,
    pending: Option<PendingDetect>,
    /// The same regions at the frame's scale while [`Scan::detect_scale`] is
    /// lower, for text too small to be found there.
    fine: Option<PendingDetect>,
}

pub struct Scan {
    segment: u32,
    width: u32,
    height: u32,
    to_track: f32,
    det_scale: f32,
    /// Heights of the lines detected lately, which set the detector scale.
    heights: VecDeque<f32>,
    switches: Switches,
    previous: Option<Arc<GrayImage>>,
    previous_luma: Option<Arc<GrayImage>>,
    /// Sensitive strings found so far, and per reading how many of them it
    /// was checked against and what they matched there.
    known: Vec<(RedactCategory, Vec<char>)>,
    by_known: HashMap<u32, (usize, Vec<Finding>)>,
    readings: Vec<Reading>,
    cache: ReadCache,
    identities: Vec<Identity>,
    live: Vec<Live>,
    pub frame_count: u64,
    pub fps_estimate: f64,
    pub first_time: Option<f64>,
    pub last_time: f64,
    /// When the segment's last frame stops showing (its duration), if known.
    pub end_time: Option<f64>,
    /// Every frame's time, in order: a frame shows until the next one.
    frame_times: Vec<f64>,
}

impl Scan {
    pub fn new(segment: u32, width: u32, height: u32, track_width: u32) -> Self {
        Self {
            segment,
            width,
            height,
            to_track: track_width as f32 / width as f32,
            det_scale: (2048.0 / width.max(height) as f32).min(1.0),
            heights: VecDeque::new(),
            switches: Switches::from_env(),
            previous: None,
            previous_luma: None,
            known: Vec::new(),
            by_known: HashMap::new(),
            readings: Vec::new(),
            cache: ReadCache::default(),
            identities: Vec::new(),
            live: Vec::new(),
            frame_count: 0,
            fps_estimate: 30.0,
            first_time: None,
            last_time: 0.0,
            end_time: None,
            frame_times: Vec::new(),
        }
    }

    /// The part of a frame's analysis that does not depend on the lines
    /// found so far: what changed, the regions with new content,
    /// and the start of their detection (on the GPU it runs while the next
    /// frames are prepared). [`Self::finish`] completes the frame.
    pub fn prepare(
        &mut self,
        model: &mut OcrModel,
        frames: &mut FrameSource,
        frame: frames::Frame,
        gray: Arc<GrayImage>,
        stats: &mut Stats,
    ) -> anyhow::Result<Prepared> {
        let time = frame.time;
        if let Some(first) = self.first_time {
            if self.frame_count >= 1 {
                self.fps_estimate =
                    (self.frame_count as f64 / (time - first).max(1e-3)).clamp(1.0, 240.0);
            }
        } else {
            self.first_time = Some(time);
        }
        self.last_time = time;
        self.frame_times.push(time);
        self.frame_count += 1;

        let started = Instant::now();
        let previous = self.previous.replace(gray.clone());
        let (tw, th) = (gray.width, gray.height);
        let mut first_changed = previous.as_ref().map(|p| diff_tiles(p, &gray));
        if let (Some(changed), Some(previous_luma)) = (&first_changed, &self.previous_luma)
            && changed.is_empty()
        {
            stats.duplicates += 1;
            stats.track += started.elapsed();
            return Ok(Prepared {
                time,
                video: frame.video,
                luma: previous_luma.clone(),
                previous_luma: Some(previous_luma.clone()),
                changed: ChangeMap::new(tw, th),
                duplicate: true,
                rois: Vec::new(),
                rgb: None,
                pending: None,
                fine: None,
            });
        }
        let luma_started = Instant::now();
        let luma = Arc::new(frames.luma(&frame.video)?);
        stats.gray += luma_started.elapsed();
        let previous_luma = self.previous_luma.replace(luma.clone());
        let (changed, novel) = match (&previous, &previous_luma) {
            (None, _) | (_, None) => {
                let full = ChangeMap::full(tw, th);
                (full.clone(), full)
            }
            (Some(previous), Some(_)) => {
                let changed = first_changed
                    .take()
                    .unwrap_or_else(|| diff_tiles(previous, &gray));
                let novel = if self.switches.tiles {
                    changed.clone()
                } else {
                    ChangeMap::full(tw, th)
                };
                (changed, novel)
            }
        };

        let from_track = 1.0 / self.to_track;
        let rois = tile_blocks(&novel)
            .into_iter()
            .map(|r| {
                r.expand(TILE as f32, TILE as f32)
                    .scale(from_track)
                    .clamp_to(self.width, self.height)
            })
            .filter(|r| r.area() > 0.0)
            .collect::<Vec<_>>();
        let mut rois = merge_overlapping(rois);
        if coverage(&rois, &changed, self.to_track) > 0.55 {
            rois = vec![Rect::new(0.0, 0.0, self.width as f32, self.height as f32)];
        }
        stats.track += started.elapsed();
        let (rgb, pending, fine) = if rois.is_empty() {
            (None, None, None)
        } else {
            let rgb_started = Instant::now();
            let rgb = frames.rgb_regions(&frame.video, &rois)?;
            stats.rgb += rgb_started.elapsed();
            let detect_started = Instant::now();
            let scale = self.detect_scale();
            let pending = model.detect_begin(&rgb.0, &rois, scale)?;
            let fine = if scale < self.det_scale {
                Some(model.detect_begin(&rgb.0, &rois, self.det_scale)?)
            } else {
                None
            };
            stats.detect += detect_started.elapsed();
            (Some(rgb), Some(pending), fine)
        };
        Ok(Prepared {
            time,
            video: frame.video,
            luma,
            previous_luma,
            changed,
            duplicate: false,
            rois,
            rgb,
            pending,
            fine,
        })
    }

    /// Completes a [`Self::prepare`]d frame, in frame order: follows the
    /// lines, detects what else changed, reads, classifies.
    pub fn finish(
        &mut self,
        model: &mut OcrModel,
        frames: &mut FrameSource,
        prepared: Prepared,
        stats: &mut Stats,
    ) -> anyhow::Result<()> {
        let Prepared {
            time,
            video,
            luma,
            previous_luma,
            changed,
            duplicate,
            rois: prepared_rois,
            rgb,
            pending,
            fine,
        } = prepared;
        if duplicate {
            self.extend_runs(time);
            return Ok(());
        }
        let started = Instant::now();
        for live in &mut self.live {
            let track_rect = live.rect.scale(self.to_track);
            if !changed.intersects(track_rect.expand(2.0, 2.0)) {
                live.state = LineState::Same;
                continue;
            }
            live.state = LineState::Touched;
            let Some(previous_luma) = previous_luma.as_deref() else {
                continue;
            };
            if line_unchanged(previous_luma, &luma, live.rect) {
                live.state = LineState::Same;
            }
        }
        stats.track += started.elapsed();

        stats.track += started.elapsed();

        let full = Rect::new(0.0, 0.0, self.width as f32, self.height as f32);
        let extra = merge_overlapping(
            self.live
                .iter()
                .filter(|l| l.state == LineState::Touched)
                .map(|l| {
                    l.rect
                        .expand(l.rect.h, l.rect.h * 0.5)
                        .clamp_to(self.width, self.height)
                })
                .filter(|r| {
                    r.area() > 0.0
                        && !prepared_rois
                            .iter()
                            .any(|roi| roi.intersection(r) >= 0.95 * r.area())
                })
                .collect(),
        );
        let rois = prepared_rois
            .iter()
            .chain(&extra)
            .copied()
            .collect::<Vec<_>>();

        let mut claimed = vec![false; self.live.len()];
        let mut read_now = Vec::new();
        if !rois.is_empty() {
            let rgb_started = Instant::now();
            let (mut rgb, partial) = match rgb {
                Some(rgb) => rgb,
                None => frames.rgb_regions(&video, &extra)?,
            };
            if partial && !extra.is_empty() {
                frames::fill_rgb(&video, &mut rgb, &extra);
            }
            stats.rgb += rgb_started.elapsed();
            let scale = self.detect_scale();
            let detect_started = Instant::now();
            let mut found = match pending {
                Some(pending) => model.detect_end(pending)?,
                None => Vec::new(),
            };
            if !extra.is_empty() {
                found.extend(model.detect_all(&rgb, &extra, scale)?);
            }
            let mut lines: Vec<Rect> = Vec::new();
            let mut cut = Vec::new();
            for (roi, found) in rois.iter().zip(found) {
                stats.det_pixels += f64::from(roi.area() * scale * scale);
                for line in found {
                    let r = line.rect;
                    if (r.x - roi.x < 3.0 && roi.x > 0.5)
                        || (roi.right() - r.right() < 3.0 && roi.right() < full.w - 0.5)
                    {
                        cut.push(r);
                    }
                    if !lines.iter().any(|other| other.iou(&r) > 0.6) {
                        lines.push(r);
                    }
                }
            }
            // A line running out of its region (text typed or uncovered a
            // few characters at a time) is detected again along its row, so
            // it is read whole and keeps one identity.
            if self.switches.strips && !cut.is_empty() {
                let strips = merge_overlapping(
                    cut.iter()
                        .map(|l| {
                            let reach = l.h * STRIP_REACH;
                            Rect::new(l.x - reach, l.y - l.h * 0.5, l.w + 2.0 * reach, l.h * 2.0)
                                .clamp_to(self.width, self.height)
                        })
                        .collect(),
                );
                if partial {
                    frames::fill_rgb(&video, &mut rgb, &strips);
                }
                let found = model.detect_all(&rgb, &strips, scale)?;
                for (strip, found) in strips.iter().zip(found) {
                    stats.det_pixels += f64::from(strip.area() * scale * scale);
                    for line in found {
                        let r = line.rect;
                        lines.retain(|other| other.intersection(&r) < 0.8 * other.area());
                        if !lines.iter().any(|other| other.iou(&r) > 0.6) {
                            lines.push(r);
                        }
                    }
                }
            }
            // Text too small for the lowered scale is found at the frame's
            // scale, so it is never missed and its height brings the scale
            // back up.
            if let Some(fine) = fine {
                let mut found = model.detect_end(fine)?;
                if !extra.is_empty() {
                    found.extend(model.detect_all(&rgb, &extra, self.det_scale)?);
                }
                for (roi, found) in rois.iter().zip(found) {
                    stats.det_pixels += f64::from(roi.area() * self.det_scale * self.det_scale);
                    lines = add_unseen_lines(lines, found.into_iter().map(|line| line.rect));
                }
            }
            stats.detect += detect_started.elapsed();
            stats.detections += 1;

            for line in &lines {
                self.heights.push_back(line.h);
            }
            while self.heights.len() > HEIGHT_SAMPLES {
                self.heights.pop_front();
            }
            if self.switches.rowmerge {
                lines = merge_row_boxes(lines);
            }
            let mut targets: Vec<(Rect, Option<usize>)> = Vec::new();
            for line in lines {
                let best = self
                    .live
                    .iter()
                    .enumerate()
                    .filter(|(index, _)| !claimed[*index])
                    .map(|(index, live)| (index, overlap(&live.rect, &line)))
                    .filter(|(_, score)| *score > 0.3)
                    .max_by(|a, b| a.1.total_cmp(&b.1))
                    .map(|(index, _)| index);
                match best {
                    Some(index) if self.live[index].state == LineState::Touched => {
                        claimed[index] = true;
                        targets.push((line, Some(index)));
                    }
                    Some(index) => {
                        let known = self.live[index].rect;
                        // A line that reaches past either end of its known box,
                        // by more than about half a character, has text added
                        // there (typed at its end) even if its old box did
                        // not change.
                        let grew = line.right() > known.right() + known.h * 0.4
                            || line.x < known.x - known.h * 0.4;
                        if grew {
                            claimed[index] = true;
                            targets.push((line, Some(index)));
                        }
                    }
                    None => targets.push((line, None)),
                }
            }

            if partial {
                let rgb_started = Instant::now();
                let boxes = targets.iter().map(|(rect, _)| *rect).collect::<Vec<_>>();
                frames::fill_rgb(&video, &mut rgb, &boxes);
                stats.rgb += rgb_started.elapsed();
            }
            let recognize_started = Instant::now();
            let thumbs = targets
                .iter()
                .map(|(rect, _)| thumbnail(&luma, *rect))
                .collect::<Vec<_>>();
            let mut readings = vec![None; targets.len()];
            if self.switches.cache {
                for (slot, thumb) in readings.iter_mut().zip(&thumbs) {
                    if let Some(thumb) = thumb {
                        *slot = self.cache.find(thumb);
                    }
                }
            }
            let unread = readings
                .iter()
                .zip(&targets)
                .filter(|(reading, _)| reading.is_none())
                .map(|(_, (rect, _))| *rect)
                .collect::<Vec<_>>();
            stats.lines += targets.len() as u64;
            stats.reused += (targets.len() - unread.len()) as u64;
            let mut fresh = if unread.is_empty() {
                Vec::new()
            } else {
                model.recognize(&rgb, &unread)?
            }
            .into_iter();
            for ((slot, thumb), (rect, _)) in readings.iter_mut().zip(thumbs).zip(&targets) {
                if slot.is_some() {
                    continue;
                }
                let read = fresh.next().unwrap_or_default();
                let width = rect.w.max(1.0);
                let index = self.readings.len() as u32;
                let own = if self.switches.alternatives {
                    classify_line_with_alternatives(&read.text, &read.alternatives)
                } else {
                    classify_line(&read.text)
                };
                self.readings.push(Reading {
                    own,
                    spans: read
                        .spans
                        .iter()
                        .map(|(a, b)| ((a - rect.x) / width, (b - rect.x) / width))
                        .collect(),
                    text: read.text,
                    cut_left: rect.x <= EDGE,
                    cut_right: rect.right() >= self.width as f32 - EDGE,
                });
                if let Some(thumb) = thumb {
                    self.cache.insert(thumb, index);
                }
                *slot = Some(index);
            }
            stats.recognize += recognize_started.elapsed();

            for ((rect, target), reading) in targets.into_iter().zip(readings) {
                let reading = reading.unwrap_or_default();
                match target {
                    Some(index) => {
                        let live = &mut self.live[index];
                        live.rect = rect;
                        live.reading = reading;
                        read_now.push(index);
                    }
                    None => {
                        self.identities.push(Identity::default());
                        self.live.push(Live {
                            identity: self.identities.len() - 1,
                            rect,
                            reading,
                            state: LineState::Touched,
                        });
                        claimed.push(true);
                        read_now.push(self.live.len() - 1);
                    }
                }
            }
        }

        if !read_now.is_empty() {
            let classify_started = Instant::now();
            self.classify_around(&read_now);
            stats.classify += classify_started.elapsed();
        }

        let mut index = 0;
        self.live.retain(|live| {
            let was_claimed = claimed.get(index).copied().unwrap_or(true);
            index += 1;
            live.state != LineState::Touched || was_claimed
        });
        self.extend_runs(time);
        Ok(())
    }

    /// Classifies the lines just read together with the lines around them, so
    /// a label on one line marks the value on another, and records each
    /// line's findings against its current reading.
    fn classify_around(&mut self, read_now: &[usize]) {
        let near = (0..self.live.len())
            .filter(|&index| {
                read_now.iter().any(|&read| {
                    let anchor = self.live[read].rect;
                    let reach = anchor.expand(anchor.h * 12.0, anchor.h * 4.0);
                    self.live[index].rect.intersection(&reach) > 0.0
                })
            })
            .collect::<Vec<_>>();
        let (w, h) = (self.width as f32, self.height as f32);
        let contexts = near
            .iter()
            .map(|&index| {
                let live = &self.live[index];
                LineContext {
                    text: self.readings[live.reading as usize].text.as_str(),
                    x: live.rect.x / w,
                    y: live.rect.y / h,
                    w: live.rect.w / w,
                    h: live.rect.h / h,
                }
            })
            .collect::<Vec<_>>();
        let own = near
            .iter()
            .map(|&index| self.readings[self.live[index].reading as usize].own.clone())
            .collect::<Vec<_>>();
        let found = classify_frame_with(&contexts, own);
        for (&index, findings) in near.iter().zip(found) {
            if findings.is_empty() {
                continue;
            }
            let live = &self.live[index];
            let text = self.readings[live.reading as usize]
                .text
                .chars()
                .collect::<Vec<_>>();
            let entry = self.identities[live.identity]
                .findings
                .entry(live.reading)
                .or_default();
            for finding in findings {
                if finding.end <= text.len() {
                    record_known(
                        &mut self.known,
                        finding.category,
                        &text[finding.start..finding.end],
                    );
                }
                if !entry.contains(&finding) {
                    entry.push(finding);
                }
            }
        }
    }

    /// Matches every reading against the sensitive strings found since it
    /// was last checked: a reading sharing a long enough run of characters
    /// with one (the part of a key still in view after a page jumped, the
    /// same address in another pane) is sensitive there too, whichever line
    /// it belongs to and whenever it was read.
    fn refresh_known(&mut self) {
        if !self.switches.known {
            return;
        }
        for (index, reading) in self.readings.iter().enumerate() {
            let entry = self.by_known.entry(index as u32).or_default();
            if entry.0 == self.known.len() {
                continue;
            }
            let text = reading.text.chars().collect::<Vec<_>>();
            for (category, known) in &self.known[entry.0..] {
                let span = if *category == RedactCategory::Name {
                    whole_words(&text, known)
                } else {
                    shared_span(&text, known)
                        .or_else(|| edge_span(&text, known, reading.cut_left, reading.cut_right))
                };
                if let Some((start, end)) = span
                    && !entry.1.iter().any(|f: &Finding| {
                        f.category == *category && f.start <= start && f.end >= end
                    })
                {
                    entry.1.push(Finding {
                        category: *category,
                        start,
                        end,
                    });
                }
            }
            entry.0 = self.known.len();
        }
    }

    fn findings_of<'a>(
        &'a self,
        identity: &'a Identity,
        reading: u32,
    ) -> impl Iterator<Item = &'a Finding> {
        identity
            .findings
            .get(&reading)
            .into_iter()
            .flatten()
            .chain(self.by_known.get(&reading).into_iter().flat_map(|(_, f)| f))
    }

    fn extend_runs(&mut self, time: f64) {
        for live in &self.live {
            let identity = &mut self.identities[live.identity];
            match identity.runs.last_mut() {
                Some(run) if run.rect == live.rect && run.reading == live.reading => {
                    run.t1 = time;
                }
                _ => identity.runs.push(Run {
                    t0: time,
                    t1: time,
                    rect: live.rect,
                    reading: live.reading,
                }),
            }
        }
    }

    /// Where `category` is hidden on `run`: the sensitive spans of its
    /// reading padded by about a character, or the whole line when this
    /// reading of a sensitive line shows no span of its own (typing,
    /// scrolled half into view, behind another window).
    fn mask_rect(&self, identity: &Identity, run: &Run, category: RedactCategory) -> Option<Rect> {
        let r = run.rect;
        let reading = &self.readings[run.reading as usize];
        let len = reading.spans.len();
        let own = self
            .findings_of(identity, run.reading)
            .filter(|f| f.category == category)
            .filter_map(|f| {
                let end = f.end.min(len);
                (end > f.start).then_some((f.start, end))
            })
            .collect::<Vec<_>>();
        if !own.is_empty() {
            return Some(self.span_rect(r, reading, &own));
        }
        self.switches
            .propagate
            .then(|| r.expand(r.h * 0.5, r.h * 0.15))
    }

    /// The box over character ranges of `reading` on line `r`, padded by
    /// about a character on both sides (within a pad of the line). A short
    /// line (a table cell, a list row) is covered whole.
    fn span_rect(&self, r: Rect, reading: &Reading, ranges: &[(usize, usize)]) -> Rect {
        let spans = &reading.spans;
        let mut x0 = f32::MAX;
        let mut x1 = f32::MIN;
        let mut chars = 0usize;
        for (start, end) in ranges {
            x0 = x0.min(spans[*start].0);
            x1 = x1.max(spans[end - 1].1);
            chars += end - start;
        }
        let left = r.x + x0 * r.w;
        let right = r.x + x1 * r.w;
        let pad = if self.switches.pad {
            ((right - left) / chars.max(1) as f32).max(r.h * 0.5)
        } else {
            0.0
        };
        let (left, right) = if reading.spans.len() <= SHORT_LINE {
            (r.x - pad, r.right() + pad)
        } else {
            (
                (left - pad).max(r.x - pad),
                (right + pad).min(r.right() + pad),
            )
        };
        Rect::new(left, r.y - r.h * 0.15, right - left, r.h * 1.3)
    }

    pub fn regions(&mut self) -> Vec<RedactionRegion> {
        self.refresh_known();
        let frame = 1.0 / self.fps_estimate.max(1.0);
        let (w, h) = (self.width as f32, self.height as f32);
        let mut regions = Vec::new();
        for identity in &self.identities {
            let mut categories = identity
                .runs
                .iter()
                .map(|run| run.reading)
                .collect::<HashSet<_>>()
                .into_iter()
                .flat_map(|reading| self.findings_of(identity, reading).map(|f| f.category))
                .collect::<Vec<_>>();
            if categories.is_empty() {
                continue;
            }
            categories.sort_by_key(|c| c.as_str());
            categories.dedup();
            for category in categories {
                let mut keys: Vec<RedactionKey> = Vec::new();
                let mut flush = |keys: &mut Vec<RedactionKey>| {
                    let (Some(first), Some(last)) = (keys.first().copied(), keys.last().copied())
                    else {
                        return;
                    };
                    let start = (first.t - frame).max(0.0);
                    let end = self.shown_until(last.t, frame);
                    regions.push(RedactionRegion {
                        id: region_id(self.segment, category, start, &first),
                        segment: self.segment,
                        category,
                        start,
                        end,
                        keys: simplify_keys(keys, 0.5 / w, 0.5 / h),
                    });
                    keys.clear();
                };
                let mut last_end: Option<f64> = None;
                for run in &identity.runs {
                    let Some(rect) = self.mask_rect(identity, run, category) else {
                        flush(&mut keys);
                        last_end = None;
                        continue;
                    };
                    // A gap splits the region only when frames came without
                    // the line: a held frame (a still screen in a variable
                    // frame rate recording) keeps it.
                    if last_end.is_some_and(|end| {
                        run.t0 - end > frame * 1.5 && self.shown_until(end, frame) < run.t0 - 1e-6
                    }) {
                        flush(&mut keys);
                    }
                    let key = |t: f64| RedactionKey {
                        t,
                        x: rect.x / w,
                        y: rect.y / h,
                        w: rect.w / w,
                        h: rect.h / h,
                    };
                    keys.push(key(run.t0));
                    // The run's last frame shows until the next frame: the
                    // mask stays where it is until then.
                    let until = self.shown_until(run.t1, frame) - HOLD;
                    if until > run.t0 {
                        keys.push(key(until));
                    }
                    last_end = Some(run.t1);
                }
                flush(&mut keys);
            }
        }
        regions.sort_by(|a, b| a.start.total_cmp(&b.start));
        let mut regions = join_same_masks(regions);
        let mut seen = std::collections::HashSet::new();
        for region in &mut regions {
            let mut id = region.id.clone();
            let mut n = 1;
            while !seen.insert(id.clone()) {
                n += 1;
                id = format!("{}-{n}", region.id);
            }
            region.id = id;
        }
        regions
    }

    /// The detector's scale: the frame's (at most 2048 px on its long side),
    /// lowered while most text on screen is large, so a line reaches the
    /// detector at about [`TEXT_HEIGHT`] px and large text is found whole.
    /// The regions are then also detected at the frame's scale for small
    /// text.
    fn detect_scale(&self) -> f32 {
        if self.heights.len() < HEIGHT_SAMPLES / 10 {
            return self.det_scale;
        }
        let mut heights = self.heights.iter().copied().collect::<Vec<_>>();
        heights.sort_by(f32::total_cmp);
        let small = heights[heights.len() / 4].max(1.0);
        (TEXT_HEIGHT / small)
            .min(self.det_scale)
            .max(MIN_DETECT_SCALE.min(self.det_scale))
    }

    /// When the frame shown at `t` is replaced: the next frame's time, or the
    /// segment's end after its last frame.
    fn shown_until(&self, t: f64, frame: f64) -> f64 {
        let next = self.frame_times.partition_point(|&time| time <= t + 1e-6);
        match self.frame_times.get(next) {
            Some(&time) => time,
            None => self.end_time.filter(|&end| end > t).unwrap_or(t + frame),
        }
    }

    pub fn cache_entries(&self) -> usize {
        self.cache.entries.len()
    }
}

/// Whether every 16 px column block of the line at `rect` is unchanged
/// from `previous`: the tile maps are too coarse to tell a line beside a
/// moving window's edge from one that changed, and a single typed character
/// fails its block.
fn line_unchanged(previous: &GrayImage, current: &GrayImage, rect: Rect) -> bool {
    let rect = rect.clamp_to(current.width, current.height);
    let (x0, y0) = (rect.x.round() as usize, rect.y.round() as usize);
    let (x1, y1) = (
        (rect.right().round() as usize).min(current.width as usize),
        (rect.bottom().round() as usize).min(current.height as usize),
    );
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return false;
    }
    (x0..x1).step_by(LINE_BLOCK).all(|bx| {
        let area = (bx, y0, (bx + LINE_BLOCK).min(x1), y1);
        mean_difference(previous, current, area, (0, 0)) <= LINE_BLOCK_MEAN
    })
}

/// Share of the frame the regions cover (on the tile grid, overlaps once).
fn coverage(rois: &[Rect], map: &ChangeMap, to_track: f32) -> f32 {
    let mut grid = ChangeMap {
        cols: map.cols,
        rows: map.rows,
        bits: vec![false; map.bits.len()],
    };
    for roi in rois {
        grid.mark_rect(roi.scale(to_track));
    }
    grid.fraction()
}

/// The set tiles of `map` as rectangles (tracking pixels): runs along each
/// tile row, stacked with the runs below them that span about the same
/// columns. Unlike connected clusters, the L-shaped band a diagonally
/// dragged window uncovers stays two thin rectangles, not the window's
/// bounding box.
fn tile_blocks(map: &ChangeMap) -> Vec<Rect> {
    let mut blocks: Vec<(usize, usize, usize, usize)> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    for ty in 0..map.rows {
        let mut next_open = Vec::new();
        let mut tx = 0;
        while tx < map.cols {
            if !map.bits[ty * map.cols + tx] {
                tx += 1;
                continue;
            }
            let x0 = tx;
            while tx < map.cols && map.bits[ty * map.cols + tx] {
                tx += 1;
            }
            let x1 = tx;
            let above = open.iter().copied().find(|&index| {
                let (bx0, bx1, _, _) = blocks[index];
                bx0.abs_diff(x0) <= 1 && bx1.abs_diff(x1) <= 1
            });
            match above {
                Some(index) => {
                    let block = &mut blocks[index];
                    block.0 = block.0.min(x0);
                    block.1 = block.1.max(x1);
                    block.3 = ty + 1;
                    open.retain(|&i| i != index);
                    next_open.push(index);
                }
                None => {
                    blocks.push((x0, x1, ty, ty + 1));
                    next_open.push(blocks.len() - 1);
                }
            }
        }
        open = next_open;
    }
    blocks
        .into_iter()
        .map(|(x0, x1, y0, y1)| {
            Rect::new(
                (x0 * TILE) as f32,
                (y0 * TILE) as f32,
                ((x1 - x0) * TILE) as f32,
                ((y1 - y0) * TILE) as f32,
            )
        })
        .collect()
}

/// Remembers a sensitive string for matching other readings: long strings
/// of the categories without shared boilerplate, names of two or more
/// words (matched as whole words), and the name an address's local part
/// spells ("jane_roe@" -> "jane roe").
fn record_known(
    known: &mut Vec<(RedactCategory, Vec<char>)>,
    category: RedactCategory,
    text: &[char],
) {
    let mut add = |category: RedactCategory, value: Vec<char>| {
        if !known.iter().any(|(c, k)| *c == category && *k == value) {
            known.push((category, value));
        }
    };
    let digits_are_dates = matches!(category, RedactCategory::Phone | RedactCategory::Card)
        && crate::classify::date_not_number(&text.iter().collect::<String>());
    if KNOWN_CATEGORIES.contains(&category) && text.len() >= KNOWN_MIN_LEN && !digits_are_dates {
        add(category, text.to_vec());
    }
    if category == RedactCategory::Name {
        let words = text.iter().collect::<String>();
        let words = words.split_whitespace().collect::<Vec<_>>();
        if words.len() >= 2
            && words
                .iter()
                .all(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 2)
        {
            add(
                RedactCategory::Name,
                words.join(" ").to_lowercase().chars().collect(),
            );
        }
    }
    if category == RedactCategory::Email {
        let address = text.iter().collect::<String>();
        let local = address.split('@').next().unwrap_or("");
        let parts = local
            .split(['.', '_', '-', '+'])
            .map(|part| part.trim_end_matches(|c: char| c.is_ascii_digit()))
            .collect::<Vec<_>>();
        if parts.len() == 2
            && parts
                .iter()
                .all(|p| p.len() >= 3 && p.chars().all(|c| c.is_alphabetic()))
        {
            add(
                RedactCategory::Name,
                parts.join(" ").to_lowercase().chars().collect(),
            );
        }
    }
}

/// Where the words of `known` (lower case) appear in `text` as whole words,
/// ignoring case.
fn whole_words(text: &[char], known: &[char]) -> Option<(usize, usize)> {
    if known.is_empty() || text.len() < known.len() {
        return None;
    }
    let lower = text
        .iter()
        .flat_map(|c| c.to_lowercase())
        .collect::<Vec<_>>();
    if lower.len() != text.len() {
        return None;
    }
    (0..=lower.len() - known.len()).find_map(|start| {
        let end = start + known.len();
        let boundary = |i: Option<&char>| i.is_none_or(|c| !c.is_alphanumeric());
        (lower[start..end] == *known
            && boundary(start.checked_sub(1).and_then(|i| lower.get(i)))
            && boundary(lower.get(end)))
        .then_some((start, end))
    })
}

/// The part of a line cut by the frame's edge that is the start of `known`
/// (cut on the right: the line ends with it) or its end (cut on the left: the
/// line starts with it), at least [`EDGE_MIN_SHARED`] characters, grown to
/// whole words.
fn edge_span(
    text: &[char],
    known: &[char],
    cut_left: bool,
    cut_right: bool,
) -> Option<(usize, usize)> {
    let longest = text.len().min(known.len());
    if longest < EDGE_MIN_SHARED {
        return None;
    }
    if cut_right
        && let Some(k) = (EDGE_MIN_SHARED..=longest)
            .rev()
            .find(|&k| text[text.len() - k..] == known[..k])
    {
        let mut start = text.len() - k;
        while start > 0 && !text[start - 1].is_whitespace() {
            start -= 1;
        }
        return Some((start, text.len()));
    }
    if cut_left
        && let Some(k) = (EDGE_MIN_SHARED..=longest)
            .rev()
            .find(|&k| text[..k] == known[known.len() - k..])
    {
        let mut end = k;
        while end < text.len() && !text[end].is_whitespace() {
            end += 1;
        }
        return Some((0, end));
    }
    None
}

/// The span of `text` around its longest run of characters shared with
/// `known`, widened to whole tokens, when that run is long enough (the whole
/// of a short known string, or [`KNOWN_MIN_SHARED`] characters of a long one)
/// and is one of the string's ends (the rest cut off or hidden) or most of it
/// ([`KNOWN_MOST`]), not a run from its middle.
fn shared_span(text: &[char], known: &[char]) -> Option<(usize, usize)> {
    if text.is_empty() || known.is_empty() {
        return None;
    }
    let mut best = (0usize, 0usize, 0usize);
    let mut previous = vec![0usize; known.len() + 1];
    let mut current = vec![0usize; known.len() + 1];
    for (i, a) in text.iter().enumerate() {
        for (j, b) in known.iter().enumerate() {
            current[j + 1] = if a == b { previous[j] + 1 } else { 0 };
            if current[j + 1] > best.0 {
                best = (current[j + 1], i + 1, j + 1);
            }
        }
        std::mem::swap(&mut previous, &mut current);
    }
    let (length, end, known_end) = best;
    if length < KNOWN_MIN_SHARED.min(known.len()) {
        return None;
    }
    let one_end = known_end == length || known_end == known.len();
    if !one_end && (length as f32) < known.len() as f32 * KNOWN_MOST {
        return None;
    }
    let mut start = end - length;
    let mut end = end;
    while start > 0 && !text[start - 1].is_whitespace() {
        start -= 1;
    }
    while end < text.len() && !text[end].is_whitespace() {
        end += 1;
    }
    Some((start, end))
}

/// Adds the lines of a detection at the frame's scale that no line found
/// at the lowered scale overlaps (small text the lowered scale cannot see).
fn add_unseen_lines(mut lines: Vec<Rect>, fine: impl Iterator<Item = Rect>) -> Vec<Rect> {
    let coarse = lines.len();
    for r in fine {
        if !lines[..coarse].iter().any(|l| l.intersection(&r) > 0.0)
            && !lines[coarse..].iter().any(|l| l.iou(&r) > 0.6)
        {
            lines.push(r);
        }
    }
    lines
}

/// Joins boxes on one row whose horizontal gap is under half a line height
/// (one line split inside a token): of the same text height on the same
/// baseline, or, for large text, where the detector splits most, boxes that
/// overlap vertically and differ in height by up to 40%.
fn merge_row_boxes(mut lines: Vec<Rect>) -> Vec<Rect> {
    let joinable = |a: &Rect, b: &Rect| {
        let height = a.h.min(b.h);
        let gap = b.x - a.right();
        let aligned = if height >= LARGE_TEXT {
            let vertical = a.bottom().min(b.bottom()) - a.y.max(b.y);
            (a.h - b.h).abs() <= height * 0.4 && vertical > height * 0.6
        } else {
            let centre = (a.y + a.h * 0.5 - (b.y + b.h * 0.5)).abs();
            (a.h - b.h).abs() <= height * 0.15 && centre <= height * 0.2
        };
        b.x >= a.x && aligned && gap < height * 0.5 && gap > -(height * 0.3).max(2.0)
    };
    loop {
        let n = lines.len();
        let pair = (0..n)
            .flat_map(|i| (0..n).map(move |j| (i, j)))
            .find(|&(i, j)| i != j && joinable(&lines[i], &lines[j]));
        let Some((i, j)) = pair else {
            return lines;
        };
        lines[i] = lines[i].union(&lines[j]);
        lines.remove(j);
    }
}

/// How much of the smaller of two boxes on the same row the other covers.
fn overlap(a: &Rect, b: &Rect) -> f32 {
    let vertical = a.bottom().min(b.bottom()) - a.y.max(b.y);
    if vertical < 0.5 * a.h.min(b.h) {
        return 0.0;
    }
    let horizontal = a.right().min(b.right()) - a.x.max(b.x);
    if horizontal <= 0.0 {
        return 0.0;
    }
    horizontal / a.w.min(b.w).max(1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame with a pseudo-random "line of text" of `glyphs` 10 px glyphs
    /// drawn at (x, y), 20 px tall, with `noise` added to every pixel.
    fn frame_with_line(x: usize, y: usize, glyphs: &[u8], noise: u8) -> RgbImage {
        let mut image = RgbImage::new(640, 120);
        image.data.fill(240);
        let mut seed = 7u32;
        for (index, glyph) in glyphs.iter().enumerate() {
            for gy in 0..20 {
                for gx in 0..10 {
                    let bits = u32::from(*glyph);
                    let on = (bits & 1 != 0 && (2..4).contains(&gx))
                        || (bits & 2 != 0 && (6..8).contains(&gx))
                        || (bits & 4 != 0 && (3..5).contains(&gy))
                        || (bits & 8 != 0 && (9..11).contains(&gy))
                        || (bits & 16 != 0 && (15..17).contains(&gy))
                        || (bits & 32 != 0 && gx + 1 == gy / 2);
                    let px = ((y + gy) * 640 + x + index * 10 + gx) * 3;
                    let value = if on { 30u8 } else { 240 };
                    image.data[px..px + 3].fill(value);
                }
            }
        }
        for value in &mut image.data {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let n = (seed >> 16) as u8 % (noise + 1);
            *value = value.saturating_add(n).saturating_sub(noise / 2);
        }
        image
    }

    #[test]
    fn a_line_cut_by_the_frame_edge_matches_the_start_or_end_of_a_known_string() {
        let chars = |s: &str| s.chars().collect::<Vec<_>>();
        let known = chars("sk_live_51Hq7x2Ab");
        assert_eq!(
            edge_span(&chars("key: sk_li"), &known, false, true),
            Some((5, 10))
        );
        assert_eq!(edge_span(&chars("key: sk_li"), &known, true, false), None);
        assert_eq!(
            edge_span(&chars("7x2Ab rotated"), &known, true, false),
            Some((0, 5))
        );
        assert_eq!(edge_span(&chars("key: sk"), &known, false, true), None);
    }

    fn held_frame_scan() -> Scan {
        let mut scan = Scan::new(0, 1000, 500, 960);
        scan.fps_estimate = 30.0;
        scan.end_time = Some(5.0);
        scan.frame_times = vec![0.0, 0.03, 2.0, 2.03];
        scan.readings.push(Reading {
            text: "jo@example.net".into(),
            spans: (0..14)
                .map(|i| (i as f32 / 14.0, (i + 1) as f32 / 14.0))
                .collect(),
            own: Vec::new(),
            cut_left: false,
            cut_right: false,
        });
        let mut identity = Identity::default();
        identity.findings.insert(
            0,
            vec![Finding {
                category: RedactCategory::Email,
                start: 0,
                end: 14,
            }],
        );
        let run = |t0, t1, y| Run {
            t0,
            t1,
            rect: Rect::new(100.0, y, 200.0, 20.0),
            reading: 0,
        };
        identity.runs = vec![run(0.0, 0.03, 100.0), run(2.0, 2.03, 300.0)];
        scan.identities.push(identity);
        scan
    }

    #[cfg(not(feature = "ablation"))]
    #[test]
    fn environment_variables_change_nothing_in_a_normal_build() {
        let before = held_frame_scan().regions();
        // SAFETY: only this test writes this variable, and a normal build
        // never reads it.
        unsafe {
            std::env::set_var(
                "CAP_REDACT_OFF",
                "cache,tiles,propagate,pad,strips,rowmerge,known,alternatives",
            );
        }
        let scan = held_frame_scan();
        assert_eq!(scan.switches, Switches::all_on());
        assert_eq!(Switches::from_env(), Switches::all_on());
        let after = held_frame_scan().regions();
        assert_eq!(
            serde_json::to_string(&before).unwrap(),
            serde_json::to_string(&after).unwrap()
        );
    }

    #[test]
    fn a_held_frame_keeps_its_mask_until_the_next_frame() {
        let mut scan = held_frame_scan();
        let regions = scan.regions();
        assert_eq!(regions.len(), 1, "{regions:?}");
        let region = &regions[0];
        assert!(region.rect_at(1.99).unwrap().y < 0.25, "{region:?}");
        assert!(region.rect_at(2.0).unwrap().y > 0.5, "{region:?}");
        assert!(region.rect_at(4.9).is_some(), "{region:?}");
    }

    #[test]
    fn small_lines_the_lowered_scale_missed_are_added() {
        let coarse = vec![Rect::new(100.0, 100.0, 500.0, 60.0)];
        let fine = [
            Rect::new(100.0, 100.0, 300.0, 60.0),
            Rect::new(100.0, 300.0, 400.0, 12.0),
            Rect::new(101.0, 300.0, 400.0, 12.0),
            Rect::new(100.0, 318.0, 400.0, 12.0),
        ];
        let lines = add_unseen_lines(coarse.clone(), fine.into_iter());
        assert_eq!(lines, vec![coarse[0], fine[1], fine[3]], "{lines:?}");
    }

    #[test]
    fn same_line_matches_at_another_place_and_after_reencoding() {
        let glyphs = b"jess@example.net";
        let a = frame_with_line(20, 10, glyphs, 0);
        let b = frame_with_line(117, 63, glyphs, 6);
        let ta = thumbnail(&a.luma(), Rect::new(20.0, 10.0, 160.0, 20.0)).unwrap();
        let tb = thumbnail(&b.luma(), Rect::new(117.0, 63.0, 160.0, 20.0)).unwrap();
        assert!(thumbs_match(&ta, &tb));
        let jittered = thumbnail(&b.luma(), Rect::new(116.0, 62.0, 162.0, 21.0)).unwrap();
        assert!(thumbs_match(&ta, &jittered));
    }

    #[test]
    fn one_changed_character_is_read_again() {
        let a = frame_with_line(20, 10, b"4111 1111 1111 1111", 0);
        let b = frame_with_line(20, 10, b"4111 1111 1171 1111", 0);
        let rect = Rect::new(20.0, 10.0, 190.0, 20.0);
        let ta = thumbnail(&a.luma(), rect).unwrap();
        let tb = thumbnail(&b.luma(), rect).unwrap();
        assert!(!thumbs_match(&ta, &tb));
    }

    #[test]
    fn an_l_shaped_band_stays_two_thin_blocks() {
        let mut map = ChangeMap::new(320, 320);
        for ty in 0..map.rows {
            for tx in 0..map.cols {
                map.bits[ty * map.cols + tx] = ty < 2 || tx < 2;
            }
        }
        let blocks = tile_blocks(&map);
        let area: f32 = blocks.iter().map(Rect::area).sum();
        let tiles = map.bits.iter().filter(|b| **b).count() as f32;
        assert!(area <= tiles * (TILE * TILE) as f32 * 1.01, "{blocks:?}");
        assert!(blocks.len() <= 3, "{blocks:?}");
    }

    #[test]
    fn a_token_split_on_one_row_is_joined_but_columns_stay_apart() {
        let lines = vec![
            Rect::new(300.0, 100.0, 150.0, 40.0),
            Rect::new(100.0, 101.0, 190.0, 40.0),
            Rect::new(600.0, 100.0, 120.0, 40.0),
            Rect::new(100.0, 160.0, 200.0, 40.0),
            Rect::new(100.0, 300.0, 100.0, 20.0),
            Rect::new(205.0, 295.0, 100.0, 30.0),
        ];
        let merged = merge_row_boxes(lines);
        assert_eq!(merged.len(), 5, "{merged:?}");
        assert!(merged.iter().any(|r| r.x == 100.0 && r.right() == 450.0));
    }

    #[test]
    fn known_names_match_whole_words_and_addresses_seed_them() {
        let mut known = Vec::new();
        let chars = |s: &str| s.chars().collect::<Vec<_>>();
        record_known(&mut known, RedactCategory::Name, &chars("Jane Roe"));
        record_known(
            &mut known,
            RedactCategory::Email,
            &chars("rosa_testa@example.org"),
        );
        record_known(
            &mut known,
            RedactCategory::Email,
            &chars("juno+test99@example.org"),
        );
        let names = known
            .iter()
            .filter(|(c, _)| *c == RedactCategory::Name)
            .map(|(_, k)| k.iter().collect::<String>())
            .collect::<Vec<_>>();
        assert_eq!(names, vec!["jane roe", "rosa testa", "juno test"]);
        assert_eq!(
            whole_words(&chars("Best, Jane Roe"), &chars("jane roe")),
            Some((6, 14))
        );
        assert_eq!(
            whole_words(&chars("Rosa Testa joined"), &chars("rosa testa")),
            Some((0, 10))
        );
        assert_eq!(
            whole_words(&chars("Jane Roebuck"), &chars("jane roe")),
            None
        );
    }

    #[test]
    fn the_visible_tail_of_a_known_key_is_found() {
        let known = "pypi-AgEIcHlwaS5vcmcEHDxIQCpcjVXDKwS7Xt0"
            .chars()
            .collect::<Vec<_>>();
        let tail = "token: CpcjVXDKwS7Xt0eiHw".chars().collect::<Vec<_>>();
        assert_eq!(shared_span(&tail, &known), Some((7, 25)));
        let other = "https://example.com/settings".chars().collect::<Vec<_>>();
        assert_eq!(shared_span(&other, &known), None);
        let middle = "ref AgEIcHlwaS5vcm ok".chars().collect::<Vec<_>>();
        assert_eq!(shared_span(&middle, &known), None);
    }

    #[test]
    fn overlap_pairs_a_growing_line_with_its_prefix() {
        let prefix = Rect::new(100.0, 50.0, 30.0, 20.0);
        let grown = Rect::new(99.0, 51.0, 120.0, 20.0);
        assert!(overlap(&prefix, &grown) > 0.9);
        let other_row = Rect::new(100.0, 80.0, 120.0, 20.0);
        assert_eq!(overlap(&prefix, &other_row), 0.0);
        let beside = Rect::new(200.0, 50.0, 60.0, 20.0);
        assert_eq!(overlap(&prefix, &beside), 0.0);
    }
}
