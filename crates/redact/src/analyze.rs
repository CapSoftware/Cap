use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::Context;
use cap_project::{
    RecordingMeta, RedactCategory,
    redaction::{REDACTIONS_VERSION, RedactionKey, RedactionRegion, RedactionSegment, Redactions},
};

use crate::{
    classify::{LineContext, classify_frame},
    frames::{self, FrameSource},
    image::{GrayImage, Rect, RgbImage},
    model::OcrModel,
    motion::{ChangeMap, Patch, TILE, diff_tiles, estimate_shift},
};

#[derive(Debug, Clone)]
pub struct SegmentSource {
    pub index: u32,
    pub path: PathBuf,
}

/// The display videos of a Cap project, or a single video as segment 0.
pub fn segment_sources(path: &Path) -> anyhow::Result<Vec<SegmentSource>> {
    if path.is_dir() && path.join("recording-meta.json").exists() {
        let meta = RecordingMeta::load_for_project(path)
            .map_err(|error| anyhow::anyhow!("load recording meta: {error}"))?;
        let studio = meta
            .studio_meta()
            .context("only studio recordings have display segments")?;
        let sources = match studio {
            cap_project::StudioRecordingMeta::SingleSegment { segment } => vec![SegmentSource {
                index: 0,
                path: meta.path(&segment.display.path),
            }],
            cap_project::StudioRecordingMeta::MultipleSegments { inner } => inner
                .segments
                .iter()
                .enumerate()
                .map(|(index, segment)| SegmentSource {
                    index: index as u32,
                    path: meta.path(&segment.display.path),
                })
                .collect(),
        };
        Ok(sources)
    } else {
        Ok(vec![SegmentSource {
            index: 0,
            path: path.to_path_buf(),
        }])
    }
}

#[derive(Debug, Clone, Default)]
pub struct Stats {
    pub frames: u64,
    pub detections: u64,
    pub det_pixels: f64,
    pub lines: u64,
    pub reused: u64,
    pub decode: Duration,
    pub gray: Duration,
    pub rgb: Duration,
    pub detect: Duration,
    pub recognize: Duration,
    pub track: Duration,
    pub total: Duration,
    pub source_seconds: f64,
    pub hardware_decode: bool,
}

pub struct Progress<'a> {
    pub segment: u32,
    pub source_time: f64,
    /// Every region found so far, including ones still being tracked.
    pub snapshot: &'a Redactions,
}

pub struct Analyzer<'a> {
    pub model: &'a mut OcrModel,
    pub cancel: Arc<AtomicBool>,
    pub progress_interval: Duration,
}

const SEARCH_NEAR: i32 = 3;
const SEARCH_FAR: i32 = 28;
const MATCH_SCORE: f32 = 0.78;
const BACKTRACK_SCORE: f32 = 0.82;
const MIN_CONTRAST: f32 = 6.0;
/// Mean luma difference over a tile above which it holds new content.
const NOVELTY_MEAN: u32 = 3;

struct RingFrame {
    time: f64,
    gray: Arc<GrayImage>,
    /// Motion from the previous frame to this one, and where it happened.
    shift: Option<(f32, f32)>,
    changed: ChangeMap,
}

struct Track {
    category: RedactCategory,
    rect: Rect,
    patch: Patch,
    velocity: (f32, f32),
    keys: VecDeque<(f64, Rect)>,
    lost: bool,
    /// Frames followed by extrapolation since the last match.
    coasted: u32,
}

impl Track {
    fn push(&mut self, time: f64, rect: Rect) {
        if let Some(last) = self.keys.back()
            && last.0 >= time
        {
            return;
        }
        self.keys.push_back((time, rect));
    }
}

impl<'a> Analyzer<'a> {
    pub fn new(model: &'a mut OcrModel) -> Self {
        Self {
            model,
            cancel: Arc::new(AtomicBool::new(false)),
            progress_interval: Duration::from_millis(500),
        }
    }

    /// Analyses every segment, reusing the regions of segments whose
    /// fingerprint and model match `previous`.
    pub fn analyze(
        &mut self,
        sources: &[SegmentSource],
        previous: Option<&Redactions>,
        mut progress: impl FnMut(Progress<'_>),
        stats: &mut Stats,
    ) -> anyhow::Result<Redactions> {
        let mut result = Redactions {
            version: REDACTIONS_VERSION,
            model: self.model.version().to_string(),
            segments: Vec::new(),
            regions: Vec::new(),
        };
        for source in sources {
            if self.cancel.load(Ordering::Relaxed) {
                anyhow::bail!("cancelled");
            }
            let fingerprint = first_frame_fingerprint(&source.path)?;
            if let Some(previous) = previous
                && previous.model == result.model
                && let Some(segment) = previous.segment(source.index)
                && segment.complete
                && segment.fingerprint == fingerprint
            {
                result.segments.push(segment.clone());
                result.regions.extend(
                    previous
                        .regions
                        .iter()
                        .filter(|r| r.segment == source.index)
                        .cloned(),
                );
                continue;
            }
            let done = result.clone();
            let (segment, regions) =
                self.analyze_segment(source, fingerprint, stats, |time, partial, segment| {
                    let mut snapshot = done.clone();
                    snapshot.segments.push(segment.clone());
                    snapshot.regions.extend_from_slice(partial);
                    progress(Progress {
                        segment: source.index,
                        source_time: time,
                        snapshot: &snapshot,
                    });
                })?;
            result.segments.push(segment);
            result.regions.extend(regions);
        }
        Ok(result)
    }

    fn analyze_segment(
        &mut self,
        source: &SegmentSource,
        fingerprint: String,
        stats: &mut Stats,
        mut progress: impl FnMut(f64, &[RedactionRegion], &RedactionSegment),
    ) -> anyhow::Result<(RedactionSegment, Vec<RedactionRegion>)> {
        let started = Instant::now();
        let mut frames = FrameSource::open(&source.path)?;
        let (width, height) = (frames.width, frames.height);
        let (tw, th) = (frames.track_width, frames.track_height);
        let to_track = tw as f32 / width as f32;
        let det_scale = (2048.0 / width.max(height) as f32).min(1.0);
        let mut state = SegmentState {
            segment: source.index,
            width,
            height,
            tw,
            th,
            to_track,
            det_scale,
            ring: VecDeque::new(),
            ring_capacity: 90,
            tracks: Vec::new(),
            finished: Vec::new(),
            pending: ChangeMap::new(tw, th),
            frames_since_detection: 0,
            frame_count: 0,
            fps_estimate: 30.0,
            first_time: None,
            last_time: 0.0,
            shift_total: (0.0, 0.0),
            detection_gray: None,
            detection_shift: (0.0, 0.0),
            memory: Vec::new(),
            dump: std::env::var_os("CAP_REDACT_DUMP").is_some(),
        };
        let mut last_progress = Instant::now();
        let mut decode_mark = Instant::now();
        let mut last_frame: Option<(f64, ffmpeg::frame::Video, Arc<GrayImage>)> = None;
        let cancel = self.cancel.clone();
        let model = &mut *self.model;
        let mut segment_info = RedactionSegment {
            index: source.index,
            source_frames: 0,
            fps: 0.0,
            width,
            height,
            fingerprint: fingerprint.clone(),
            complete: false,
        };
        stats.hardware_decode = frames.is_hardware_accelerated();
        frames.for_each(|frames, frame| {
            stats.decode += decode_mark.elapsed();
            if cancel.load(Ordering::Relaxed) {
                anyhow::bail!("cancelled");
            }
            let gray_started = Instant::now();
            let gray = Arc::new(frames.gray(&frame.video)?);
            stats.gray += gray_started.elapsed();
            state.step(model, frames, &frame, gray.clone(), stats)?;
            stats.frames += 1;
            // Changed content still waiting for a settled frame is read on
            // the last frame if the recording ends first.
            last_frame =
                (!state.pending.is_empty()).then(|| (frame.time, frame.video.clone(), gray));
            if last_progress.elapsed() >= Duration::from_millis(500) {
                last_progress = Instant::now();
                segment_info.source_frames = state.frame_count;
                segment_info.fps = state.fps_estimate;
                let partial = state.snapshot_regions();
                progress(frame.time, &partial, &segment_info);
            }
            decode_mark = Instant::now();
            Ok(true)
        })?;
        stats.hardware_decode |= frames.is_hardware_accelerated();
        if let Some((time, video, gray)) = last_frame.take()
            && !state.pending.is_empty()
        {
            let rgb = frames.rgb(&video)?;
            state.detect(model, &rgb, &gray, time, false, stats)?;
            state.pending.clear();
        }
        state.finish_all();
        let fps = state.fps_estimate;
        stats.source_seconds += state.last_time - state.first_time.unwrap_or(0.0) + 1.0 / fps;
        stats.total += started.elapsed();
        let regions = state.regions();
        segment_info.source_frames = state.frame_count;
        segment_info.fps = fps;
        segment_info.complete = true;
        Ok((segment_info, regions))
    }
}

fn first_frame_fingerprint(path: &Path) -> anyhow::Result<String> {
    let mut frames = FrameSource::open(path)?;
    let mut first = None;
    frames.for_each(|frames, frame| {
        first = Some(frames.gray(&frame.video)?);
        Ok(false)
    })?;
    let first = first.context("video has no frames")?;
    Ok(frames::fingerprint(path, &first))
}

struct SegmentState {
    segment: u32,
    width: u32,
    height: u32,
    tw: u32,
    th: u32,
    to_track: f32,
    det_scale: f32,
    ring: VecDeque<RingFrame>,
    ring_capacity: usize,
    tracks: Vec<Track>,
    finished: Vec<Track>,
    pending: ChangeMap,
    frames_since_detection: u32,
    frame_count: u64,
    fps_estimate: f64,
    first_time: Option<f64>,
    last_time: f64,
    /// Sum of every estimated frame-to-frame shift, so content seen at one
    /// detection can be found again at the next after scrolling.
    shift_total: (f32, f32),
    detection_gray: Option<Arc<GrayImage>>,
    detection_shift: (f32, f32),
    memory: Vec<KnownLine>,
    dump: bool,
}

/// A line read at an earlier detection; reused when the same pixels show up
/// again where the motion since then puts them.
struct KnownLine {
    /// Zero-mean, unit-length column means of the line, a cheap first test
    /// before the full patch comparison.
    profile: Vec<f32>,
    patch: Patch,
    shift_total: (f32, f32),
    time: f64,
    text: String,
    spans: Vec<(f32, f32)>,
    full: Rect,
}

struct Found {
    category: RedactCategory,
    rect: Rect,
}

impl SegmentState {
    fn step(
        &mut self,
        model: &mut OcrModel,
        frames: &mut FrameSource,
        frame: &frames::Frame,
        gray: Arc<GrayImage>,
        stats: &mut Stats,
    ) -> anyhow::Result<()> {
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
        self.frame_count += 1;
        self.ring_capacity = ((self.fps_estimate * 3.0) as usize).clamp(30, 240);
        let track_started = Instant::now();

        let previous = self.ring.back().map(|r| r.gray.clone());
        let (changed, mut shift) = match &previous {
            None => (ChangeMap::full(self.tw, self.th), None),
            Some(previous) => {
                let changed = diff_tiles(previous, &gray);
                let shift = changed
                    .bounds()
                    .filter(|_| changed.count() >= 4)
                    .and_then(|area| estimate_shift(previous, &gray, area, 48));
                (changed, shift)
            }
        };
        self.pending.merge(&changed);

        let mut moves = Vec::new();
        for track in &mut self.tracks {
            if !changed.intersects(track.rect.expand(4.0, 4.0)) {
                track.push(time, track.rect);
                continue;
            }
            let predicted = match shift {
                Some((dx, dy)) => track.rect.translate(dx, dy),
                None => track.rect.translate(track.velocity.0, track.velocity.1),
            };
            let (mut x, mut y, mut score) =
                track
                    .patch
                    .search(&gray, predicted.x, predicted.y, SEARCH_NEAR);
            if score < MATCH_SCORE {
                (x, y, score) = track
                    .patch
                    .search(&gray, track.rect.x, track.rect.y, SEARCH_FAR);
            }
            if score >= MATCH_SCORE {
                let next = Rect::new(x, y, track.rect.w, track.rect.h);
                track.velocity = (next.x - track.rect.x, next.y - track.rect.y);
                track.rect = next;
                track.coasted = 0;
                track.lost = false;
                track.push(time, next);
                moves.push(track.velocity);
            } else {
                // Keep hiding where the string was heading until it is read
                // again or the coasting budget runs out.
                track.lost = true;
                track.coasted += 1;
                let ahead = track.rect.translate(track.velocity.0, track.velocity.1);
                if leaving_frame(&track.rect, self.tw, self.th) {
                    // Off the edge it cannot be matched or read; it keeps
                    // moving the way it was going.
                    track.rect = ahead;
                    track.push(time, ahead);
                } else {
                    track.push(time, track.rect.union(&ahead));
                }
            }
        }
        if shift.is_none() {
            shift = consensus_shift(&moves);
        }
        if let Some((dx, dy)) = shift {
            self.shift_total.0 += dx;
            self.shift_total.1 += dy;
        }
        stats.track += track_started.elapsed();

        // A lost string coasts on its last place for a few frames, so a
        // detection for it can wait a moment and serve several at once.
        let lost = self.tracks.iter().any(|t| t.lost)
            && self.frames_since_detection + 1 >= self.lost_gap();
        let settled = changed.is_empty();
        let due_frames = ((self.fps_estimate / 5.0).round() as u32).max(2);
        let first = previous.is_none();
        let detect = first
            || lost
            || (!self.pending.is_empty()
                && (settled || self.frames_since_detection + 1 >= due_frames));

        self.ring.push_back(RingFrame {
            time,
            gray: gray.clone(),
            shift,
            changed,
        });
        while self.ring.len() > self.ring_capacity {
            self.ring.pop_front();
        }

        if detect && self.dump {
            let reason = if first {
                "first"
            } else if lost {
                "lost"
            } else if settled {
                "settled"
            } else {
                "due"
            };
            eprintln!("{time:8.3} trigger {reason}");
        }
        if detect {
            let rgb_started = Instant::now();
            let rgb = frames.rgb(&frame.video)?;
            stats.rgb += rgb_started.elapsed();
            self.detect(model, &rgb, &gray, time, first, stats)?;
            self.detection_gray = Some(gray.clone());
            self.detection_shift = self.shift_total;
            self.pending.clear();
            self.frames_since_detection = 0;
        } else {
            self.frames_since_detection += 1;
        }
        Ok(())
    }

    fn rois(&self, first: bool) -> Vec<Rect> {
        let full = Rect::new(0.0, 0.0, self.width as f32, self.height as f32);
        if first {
            return vec![full];
        }
        let from_track = 1.0 / self.to_track;
        let margin = TILE as f32 * 2.0;
        let novel = self.novelty();
        let mut rois = novel
            .clusters(2)
            .into_iter()
            .map(|r| r.expand(margin, margin).scale(from_track))
            .collect::<Vec<_>>();
        for track in self.tracks.iter().filter(|t| t.lost) {
            rois.push(track.rect.expand(margin * 3.0, margin).scale(from_track));
        }
        let rois = rois
            .into_iter()
            .map(|r| r.clamp_to(self.width, self.height))
            .filter(|r| r.area() > 0.0)
            .collect::<Vec<_>>();
        let merged = merge_overlapping(rois);
        let area: f32 = merged.iter().map(Rect::area).sum();
        if area > full.area() * 0.55 {
            vec![full]
        } else {
            merged
        }
    }

    /// How many frames a lost string keeps its mask by extrapolation: a few,
    /// or up to two seconds while it is sliding out of the frame, where it
    /// can no longer be read but part of it still shows.
    fn coast_budget(&self, track: &Track) -> u32 {
        let r = track.rect;
        let inside =
            r.right() > 0.0 && r.bottom() > 0.0 && r.x < self.tw as f32 && r.y < self.th as f32;
        if !inside {
            0
        } else if leaving_frame(&r, self.tw, self.th) {
            (self.fps_estimate * 2.0) as u32
        } else {
            self.lost_gap() + 2
        }
    }

    /// Frames between detections that a lost string triggers.
    fn lost_gap(&self) -> u32 {
        ((self.fps_estimate / 15.0).round() as u32).max(2)
    }

    /// Changed tiles whose content is not the last detection's content moved
    /// by the motion since then: while a page scrolls, only the strip that
    /// scrolled into view.
    fn novelty(&self) -> ChangeMap {
        let (Some(before), Some(now)) = (&self.detection_gray, self.ring.back()) else {
            return self.pending.clone();
        };
        let now = &now.gray;
        let accumulated = (
            (self.shift_total.0 - self.detection_shift.0).round() as i32,
            (self.shift_total.1 - self.detection_shift.1).round() as i32,
        );
        let (dx, dy) = match self.pending.bounds() {
            Some(area) if accumulated != (0, 0) => {
                crate::motion::refine_shift(before, now, area, accumulated, 3)
            }
            _ => accumulated,
        };
        let mut novel = self.pending.clone();
        let width = now.width as usize;
        let height = now.height as usize;
        for ty in 0..novel.rows {
            for tx in 0..novel.cols {
                let index = ty * novel.cols + tx;
                if !novel.bits[index] {
                    continue;
                }
                let (x0, x1) = (tx * TILE, ((tx + 1) * TILE).min(width));
                let (y0, y1) = (ty * TILE, ((ty + 1) * TILE).min(height));
                let pixels = ((x1 - x0) * (y1 - y0)).max(1) as u32;
                // Mean difference, so compression noise on text edges (large
                // but sparse) does not read as new content.
                let difference = |ox: i32, oy: i32| {
                    let mut sum = 0u32;
                    for y in y0..y1 {
                        for x in x0..x1 {
                            let a = now.data[y * width + x];
                            let b = before.get(x as i32 - ox, y as i32 - oy);
                            sum += u32::from(a.abs_diff(b));
                        }
                    }
                    sum / pixels
                };
                let explained = |cx: i32, cy: i32| {
                    (-1..=1).any(|j| (-1..=1).any(|i| difference(cx + i, cy + j) <= NOVELTY_MEAN))
                };
                novel.bits[index] =
                    difference(0, 0) > NOVELTY_MEAN && ((dx == 0 && dy == 0) || !explained(dx, dy));
            }
        }
        novel
    }

    fn detect(
        &mut self,
        model: &mut OcrModel,
        rgb: &RgbImage,
        gray: &Arc<GrayImage>,
        time: f64,
        first: bool,
        stats: &mut Stats,
    ) -> anyhow::Result<()> {
        let rois = self.rois(first);
        if self.dump {
            let area: f32 = rois.iter().map(Rect::area).sum();
            eprintln!(
                "{time:8.3} detect: {} rois, {:.0}% of frame, shift since last ({:.1}, {:.1}), pending {} novel {}",
                rois.len(),
                100.0 * area / (self.width as f32 * self.height as f32),
                self.shift_total.0 - self.detection_shift.0,
                self.shift_total.1 - self.detection_shift.1,
                self.pending.count(),
                self.novelty().count(),
            );
        }
        let detect_started = Instant::now();
        let mut lines = Vec::new();
        for roi in &rois {
            stats.det_pixels += f64::from(roi.area() * self.det_scale * self.det_scale);
            for line in model.detect(rgb, *roi, self.det_scale)? {
                if !lines.iter().any(|other: &Rect| other.iou(&line.rect) > 0.6) {
                    lines.push(line.rect);
                }
            }
        }
        stats.detect += detect_started.elapsed();
        stats.detections += 1;
        stats.lines += lines.len() as u64;
        let recognize_started = Instant::now();
        let luma = rgb.luma();
        let mut recognized = vec![None; lines.len()];
        for (line, slot) in lines.iter().zip(recognized.iter_mut()) {
            *slot = self.recall(&luma, line);
        }
        let unread = recognized
            .iter()
            .zip(&lines)
            .filter(|(known, _)| known.is_none())
            .map(|(_, line)| *line)
            .collect::<Vec<_>>();
        stats.reused += (lines.len() - unread.len()) as u64;
        let mut fresh = if unread.is_empty() {
            Vec::new()
        } else {
            model.recognize(rgb, &unread)?
        }
        .into_iter();
        let recognized = recognized
            .into_iter()
            .map(|known| known.unwrap_or_else(|| fresh.next().unwrap_or_default()))
            .collect::<Vec<_>>();
        self.remember(&luma, time, &lines, &recognized);
        stats.recognize += recognize_started.elapsed();
        if self.dump {
            for (line, rec) in lines.iter().zip(&recognized) {
                eprintln!(
                    "{time:8.3} [{:5.0},{:5.0} {:4.0}x{:3.0}] {:.2} {}",
                    line.x, line.y, line.w, line.h, rec.confidence, rec.text
                );
            }
        }

        let (w, h) = (self.width as f32, self.height as f32);
        let mut contexts = lines
            .iter()
            .zip(&recognized)
            .map(|(rect, rec)| LineContext {
                text: rec.text.as_str(),
                x: rect.x / w,
                y: rect.y / h,
                w: rect.w / w,
                h: rect.h / h,
            })
            .collect::<Vec<_>>();
        // Lines read earlier and not changed since (a "Password" label above
        // a field whose value just appeared) give the new lines their
        // context; their own findings come from when they were read.
        let neighbours = self.remembered_near(&lines);
        contexts.extend(neighbours.iter().map(|(rect, text)| LineContext {
            text: text.as_str(),
            x: rect.x / w,
            y: rect.y / h,
            w: rect.w / w,
            h: rect.h / h,
        }));
        let mut findings = classify_frame(&contexts);
        findings.truncate(lines.len());
        let mut boxes = Vec::new();
        for ((line, rec), found) in lines.iter().zip(&recognized).zip(findings) {
            for finding in found {
                if finding.end == 0 || finding.start >= rec.spans.len() {
                    continue;
                }
                let end = finding.end.min(rec.spans.len());
                let x0 = rec.spans[finding.start].0;
                let x1 = rec.spans[end - 1].1;
                let pad_x = line.h * 0.6;
                let pad_y = line.h * 0.15;
                let rect = Rect::new(
                    (x0 - pad_x).max(line.x - pad_x),
                    line.y - pad_y,
                    (x1 - x0) + 2.0 * pad_x,
                    line.h + 2.0 * pad_y,
                );
                let rect = Rect::new(
                    rect.x,
                    rect.y,
                    rect.w.min(line.right() + pad_x - rect.x),
                    rect.h,
                )
                .clamp_to(self.width, self.height);
                if rect.area() > 0.0 {
                    boxes.push(Found {
                        category: finding.category,
                        rect: rect.scale(self.to_track),
                    });
                }
            }
        }

        let track_started = Instant::now();
        let mut matched = vec![false; self.tracks.len()];
        for found in boxes {
            let existing = self.tracks.iter().enumerate().position(|(index, track)| {
                track.category == found.category
                    && !matched[index]
                    && (track.rect.iou(&found.rect) > 0.25 || same_line(&track.rect, &found.rect))
            });
            match existing {
                Some(index) => {
                    matched[index] = true;
                    let track = &mut self.tracks[index];
                    if let Some(patch) = Patch::cut(gray, found.rect) {
                        track.patch = patch;
                    }
                    track.rect = found.rect;
                    track.lost = false;
                    track.coasted = 0;
                    if let Some(last) = track.keys.back_mut()
                        && last.0 >= time
                    {
                        last.1 = last.1.union(&found.rect);
                    } else {
                        track.push(time, found.rect);
                    }
                }
                None => {
                    let Some(patch) = Patch::cut(gray, found.rect) else {
                        continue;
                    };
                    let mut track = Track {
                        category: found.category,
                        rect: found.rect,
                        patch,
                        velocity: (0.0, 0.0),
                        keys: VecDeque::from([(time, found.rect)]),
                        lost: false,
                        coasted: 0,
                    };
                    self.backtrack(&mut track, gray);
                    self.tracks.push(track);
                    matched.push(true);
                }
            }
        }

        let mut index = 0;
        while index < self.tracks.len() {
            let track = &self.tracks[index];
            // Forward tracking checks every string whose area changed on every
            // frame, so one not read again here is still there unless
            // tracking lost it.
            let keep = matched[index] || !track.lost || track.coasted <= self.coast_budget(track);
            if keep {
                index += 1;
            } else {
                let track = self.tracks.remove(index);
                matched.remove(index);
                if self.dump {
                    eprintln!(
                        "{time:8.3} end {:?} at ({:.0},{:.0} {:.0}x{:.0}) lost {} coasted {}",
                        track.category,
                        track.rect.x / self.to_track,
                        track.rect.y / self.to_track,
                        track.rect.w / self.to_track,
                        track.rect.h / self.to_track,
                        track.lost,
                        track.coasted
                    );
                }
                self.finish(track);
            }
        }
        stats.track += track_started.elapsed();
        Ok(())
    }

    /// The text of `line` when an earlier detection read the same pixels at
    /// the place the motion since then moved them to. Compared at full
    /// resolution: a scroll of one source pixel is half a pixel at tracking
    /// resolution, which thin text does not survive.
    fn recall(&self, luma: &GrayImage, line: &Rect) -> Option<crate::model::Recognized> {
        let profile = column_profile(luma, *line)?;
        let mut best: Option<(&KnownLine, f32)> = None;
        for known in &self.memory {
            if (known.full.w - line.w).abs() > 4.0 || (known.full.h - line.h).abs() > 4.0 {
                continue;
            }
            let score = profile_match(&known.profile, &profile, 4);
            if score >= 0.95 && best.is_none_or(|(_, s)| score > s) {
                best = Some((known, score));
            }
        }
        let (known, _) = best?;
        let (x, _, score) = known.patch.search(luma, line.x, line.y, 3);
        if score < 0.97 {
            return None;
        }
        let shift_x = x - known.full.x;
        Some(crate::model::Recognized {
            text: known.text.clone(),
            spans: known
                .spans
                .iter()
                .map(|(a, b)| (a + shift_x, b + shift_x))
                .collect(),
            confidence: 1.0,
        })
    }

    /// Remembered lines, where the motion since puts them now, within a few
    /// line heights of `lines` and not overlapping any of them.
    fn remembered_near(&self, lines: &[Rect]) -> Vec<(Rect, String)> {
        let from_track = 1.0 / self.to_track;
        self.memory
            .iter()
            .filter_map(|known| {
                let dx = (self.shift_total.0 - known.shift_total.0) * from_track;
                let dy = (self.shift_total.1 - known.shift_total.1) * from_track;
                let rect = known.full.translate(dx, dy);
                let near = lines.iter().any(|line| {
                    let reach = line.h * 4.0;
                    rect.intersection(&line.expand(reach * 3.0, reach)) > 0.0
                });
                let overlaps = lines.iter().any(|line| line.iou(&rect) > 0.3);
                (near && !overlaps).then(|| (rect, known.text.clone()))
            })
            .collect()
    }

    fn remember(
        &mut self,
        luma: &GrayImage,
        time: f64,
        lines: &[Rect],
        recognized: &[crate::model::Recognized],
    ) {
        let horizon = time - 6.0;
        self.memory.retain(|known| known.time >= horizon);
        let from_track = 1.0 / self.to_track;
        for (line, rec) in lines.iter().zip(recognized) {
            let Some(patch) = Patch::cut(luma, *line) else {
                continue;
            };
            if patch.contrast() < MIN_CONTRAST {
                continue;
            }
            let shift_total = self.shift_total;
            self.memory.retain(|known| {
                let dx = (shift_total.0 - known.shift_total.0) * from_track;
                let dy = (shift_total.1 - known.shift_total.1) * from_track;
                known.full.translate(dx, dy).iou(line) < 0.5
            });
            let Some(profile) = column_profile(luma, *line) else {
                continue;
            };
            self.memory.push(KnownLine {
                profile,
                patch,
                shift_total,
                time,
                text: rec.text.clone(),
                spans: rec.spans.clone(),
                full: *line,
            });
        }
        if self.memory.len() > 300 {
            let excess = self.memory.len() - 300;
            self.memory.drain(..excess);
        }
    }

    /// Follows a newly found string back through recent frames, so it is
    /// hidden from the frame it appeared on, not only from the frame it was
    /// read on. While text is being typed, earlier frames match a prefix of it.
    fn backtrack(&self, track: &mut Track, source: &GrayImage) {
        let Some(newest) = self.ring.back() else {
            return;
        };
        let mut rect = track.rect;
        let full_rect = track.rect;
        let mut fraction = 1.0f32;
        let mut patch = track.patch.clone();
        let mut later_shift = newest.shift;
        let mut later_changed = &newest.changed;
        for frame in self.ring.iter().rev().skip(1) {
            let moved = later_changed.intersects(rect.expand(4.0, 4.0));
            if moved {
                let predicted = match later_shift {
                    Some((dx, dy)) => rect.translate(-dx, -dy),
                    None => rect,
                };
                let (mut x, mut y, mut score) =
                    patch.search(&frame.gray, predicted.x, predicted.y, SEARCH_NEAR);
                if score < BACKTRACK_SCORE {
                    (x, y, score) = patch.search(&frame.gray, rect.x, rect.y, SEARCH_FAR / 2);
                }
                if score < BACKTRACK_SCORE
                    && matches!(
                        track.category,
                        RedactCategory::Email
                            | RedactCategory::Secret
                            | RedactCategory::Phone
                            | RedactCategory::Card
                            | RedactCategory::Url
                    )
                {
                    let mut found = None;
                    for next_fraction in [0.8f32, 0.6, 0.45, 0.3] {
                        if next_fraction >= fraction {
                            continue;
                        }
                        let Some(prefix) = Patch::prefix(source, full_rect, next_fraction) else {
                            continue;
                        };
                        if prefix.contrast() < MIN_CONTRAST {
                            continue;
                        }
                        let (px, py, ps) =
                            prefix.search(&frame.gray, predicted.x, predicted.y, SEARCH_NEAR);
                        if ps >= BACKTRACK_SCORE + 0.05 {
                            found = Some((px, py, ps, prefix, next_fraction));
                            break;
                        }
                    }
                    if let Some((px, py, ps, prefix, next_fraction)) = found {
                        fraction = next_fraction;
                        patch = prefix;
                        x = px;
                        y = py;
                        score = ps;
                        rect = Rect::new(
                            px,
                            py,
                            full_rect.w * fraction + full_rect.h * 0.6,
                            full_rect.h,
                        );
                    }
                }
                if score < BACKTRACK_SCORE {
                    break;
                }
                rect = Rect::new(x, y, rect.w, rect.h);
            }
            track.keys.push_front((frame.time, rect));
            later_shift = frame.shift;
            later_changed = &frame.changed;
        }
    }

    fn finish(&mut self, track: Track) {
        self.finished.push(track);
    }

    fn finish_all(&mut self) {
        for track in std::mem::take(&mut self.tracks) {
            self.finish(track);
        }
    }

    fn region_for(&self, track: &Track) -> Option<RedactionRegion> {
        let frame = 1.0 / self.fps_estimate.max(1.0);
        let (tw, th) = (self.tw as f32, self.th as f32);
        let mut keys = track
            .keys
            .iter()
            .map(|(t, r)| RedactionKey {
                t: *t,
                x: r.x / tw,
                y: r.y / th,
                w: r.w / tw,
                h: r.h / th,
            })
            .collect::<Vec<_>>();
        let first = *keys.first()?;
        let last = *keys.last()?;
        keys = simplify_keys(&keys, 0.6 / tw, 0.6 / th);
        let pad_x = 1.0 / tw;
        let pad_y = 1.0 / th;
        for key in &mut keys {
            key.x -= pad_x;
            key.y -= pad_y;
            key.w += 2.0 * pad_x;
            key.h += 2.0 * pad_y;
        }
        let start = (first.t - frame).max(0.0);
        let end = last.t + frame;
        let id = region_id(self.segment, track.category, start, &first);
        Some(RedactionRegion {
            id,
            segment: self.segment,
            category: track.category,
            start,
            end,
            keys,
        })
    }

    fn snapshot_regions(&self) -> Vec<RedactionRegion> {
        self.finished
            .iter()
            .chain(&self.tracks)
            .filter_map(|track| self.region_for(track))
            .collect()
    }

    fn regions(&self) -> Vec<RedactionRegion> {
        let mut regions = self
            .finished
            .iter()
            .filter_map(|track| self.region_for(track))
            .collect::<Vec<_>>();
        regions.sort_by(|a, b| a.start.total_cmp(&b.start));
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
}

/// The motion most followed strings share this frame, when the frame-wide
/// estimate found none (a window dragged over a changing background).
fn consensus_shift(moves: &[(f32, f32)]) -> Option<(f32, f32)> {
    let moving = moves
        .iter()
        .filter(|(dx, dy)| *dx != 0.0 || *dy != 0.0)
        .collect::<Vec<_>>();
    if moving.len() < 2 {
        return None;
    }
    moving
        .iter()
        .map(|candidate| {
            let agree = moving
                .iter()
                .filter(|other| {
                    (other.0 - candidate.0).abs() <= 1.0 && (other.1 - candidate.1).abs() <= 1.0
                })
                .count();
            (**candidate, agree)
        })
        .max_by_key(|(_, agree)| *agree)
        .filter(|(_, agree)| *agree * 2 > moving.len())
        .map(|(shift, _)| shift)
}

fn leaving_frame(rect: &Rect, width: u32, height: u32) -> bool {
    rect.x < 0.0 || rect.y < 0.0 || rect.right() > width as f32 || rect.bottom() > height as f32
}

fn column_profile(luma: &GrayImage, rect: Rect) -> Option<Vec<f32>> {
    let rect = rect.clamp_to(luma.width, luma.height);
    let (x0, y0) = (rect.x as usize, rect.y as usize);
    let (w, h) = (rect.w as usize, rect.h as usize);
    if w < 4 || h < 2 {
        return None;
    }
    let width = luma.width as usize;
    let mut profile = vec![0.0f32; w];
    for y in y0..y0 + h {
        let row = &luma.data[y * width + x0..y * width + x0 + w];
        for (slot, value) in profile.iter_mut().zip(row) {
            *slot += f32::from(*value);
        }
    }
    let mean = profile.iter().sum::<f32>() / w as f32;
    for value in &mut profile {
        *value -= mean;
    }
    let norm = profile.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm < 1e-3 {
        return None;
    }
    for value in &mut profile {
        *value /= norm;
    }
    Some(profile)
}

/// Best normalised correlation of two column profiles over shifts up to
/// `radius` columns.
fn profile_match(a: &[f32], b: &[f32], radius: i32) -> f32 {
    let mut best = f32::MIN;
    for shift in -radius..=radius {
        let mut dot = 0.0;
        for (i, value) in a.iter().enumerate() {
            let j = i as i32 + shift;
            if j >= 0 && (j as usize) < b.len() {
                dot += value * b[j as usize];
            }
        }
        best = best.max(dot);
    }
    best
}

fn same_line(a: &Rect, b: &Rect) -> bool {
    let vertical = a.bottom().min(b.bottom()) - a.y.max(b.y);
    let horizontal = a.right().min(b.right()) - a.x.max(b.x);
    vertical > 0.6 * a.h.min(b.h) && horizontal > -a.h * 0.5
}

fn merge_overlapping(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let union = rects[i].union(&rects[j]);
                if rects[i].intersection(&rects[j]) > 0.0
                    || union.area() < (rects[i].area() + rects[j].area()) * 1.3
                {
                    rects[i] = union;
                    rects.remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
    }
    rects
}

/// Drops keys that linear interpolation between their neighbours already
/// reproduces within `tol_x` / `tol_y` (normalized), then widens every key
/// by the tolerance so the simplified path never uncovers the original.
pub fn simplify_keys(keys: &[RedactionKey], tol_x: f32, tol_y: f32) -> Vec<RedactionKey> {
    if keys.len() <= 2 {
        return keys.to_vec();
    }
    let mut kept = vec![0usize];
    let mut anchor = 0usize;
    let mut candidate = 2usize;
    while candidate < keys.len() {
        let a = keys[anchor];
        let b = keys[candidate];
        let span = b.t - a.t;
        let fits = (anchor + 1..candidate).all(|i| {
            let k = keys[i];
            let f = if span > 0.0 {
                ((k.t - a.t) / span) as f32
            } else {
                0.0
            };
            let lerp = |p: f32, q: f32| p + (q - p) * f;
            (lerp(a.x, b.x) - k.x).abs() <= tol_x
                && (lerp(a.y, b.y) - k.y).abs() <= tol_y
                && (lerp(a.x + a.w, b.x + b.w) - (k.x + k.w)).abs() <= tol_x
                && (lerp(a.y + a.h, b.y + b.h) - (k.y + k.h)).abs() <= tol_y
        });
        if !fits {
            anchor = candidate - 1;
            kept.push(anchor);
        }
        candidate += 1;
    }
    kept.push(keys.len() - 1);
    kept.dedup();
    kept.into_iter()
        .map(|i| {
            let mut key = keys[i];
            key.x -= tol_x;
            key.y -= tol_y;
            key.w += 2.0 * tol_x;
            key.h += 2.0 * tol_y;
            key
        })
        .collect()
}

fn region_id(segment: u32, category: RedactCategory, start: f64, first: &RedactionKey) -> String {
    let text = format!(
        "{segment}:{}:{}:{}:{}",
        category.as_str(),
        (start * 10.0).round() as i64,
        (first.x * 200.0).round() as i64,
        (first.y * 200.0).round() as i64
    );
    format!(
        "r_{:012x}",
        frames::fnv1a(text.as_bytes()) & 0xffff_ffff_ffff
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(t: f64, x: f32) -> RedactionKey {
        RedactionKey {
            t,
            x,
            y: 0.5,
            w: 0.1,
            h: 0.02,
        }
    }

    #[test]
    fn simplified_keys_cover_the_original_path() {
        let keys = (0..60)
            .map(|i| {
                key(
                    f64::from(i) / 30.0,
                    if i < 30 {
                        0.1
                    } else {
                        0.1 + (i - 30) as f32 * 0.01
                    },
                )
            })
            .collect::<Vec<_>>();
        let simplified = simplify_keys(&keys, 0.001, 0.001);
        assert!(simplified.len() < 10, "{}", simplified.len());
        let region = RedactionRegion {
            id: "a".into(),
            segment: 0,
            category: RedactCategory::Email,
            start: 0.0,
            end: 2.0,
            keys: simplified,
        };
        for original in &keys {
            let rect = region.rect_at(original.t).unwrap();
            assert!(rect.x <= original.x + 1e-6, "{rect:?} {original:?}");
            assert!(rect.x + rect.w >= original.x + original.w - 1e-6);
        }
    }

    #[test]
    fn region_ids_are_stable() {
        let first = key(1.0, 0.25);
        assert_eq!(
            region_id(0, RedactCategory::Email, 1.0, &first),
            region_id(0, RedactCategory::Email, 1.0, &first)
        );
        assert_ne!(
            region_id(0, RedactCategory::Email, 1.0, &first),
            region_id(1, RedactCategory::Email, 1.0, &first)
        );
    }
}
