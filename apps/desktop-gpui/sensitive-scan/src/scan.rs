use crate::classify::{SensitiveKind, find_sensitive};
use crate::frame::{LumaFrame, Rect};
use crate::ocr::{ReadLine, TextReader};
use crate::track::{Motion, Similarity, changed_tiles, follow, global_motion, plausible};

pub trait ReadText {
    fn read_text(&self, frame: &LumaFrame) -> anyhow::Result<Vec<ReadLine>>;
}

impl ReadText for TextReader {
    fn read_text(&self, frame: &LumaFrame) -> anyhow::Result<Vec<ReadLine>> {
        self.read(frame)
    }
}

#[derive(Clone, Debug)]
pub struct ScanSettings {
    pub sample_fps: f64,
    pub max_ocr_interval: f64,
    pub tracking_width: u32,
    pub phrases: Vec<String>,
}

impl Default for ScanSettings {
    fn default() -> Self {
        Self {
            sample_fps: 15.0,
            max_ocr_interval: 1.0,
            tracking_width: 960,
            phrases: Vec::new(),
        }
    }
}

impl ScanSettings {
    pub fn sample_times(&self, duration: f64) -> Vec<f64> {
        let step = 1.0 / self.sample_fps;
        let count = (duration * self.sample_fps).ceil().max(1.0) as usize;
        (0..count)
            .map(|index| index as f64 * step)
            .filter(|time| *time < duration)
            .collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrackSample {
    pub time: f64,
    pub rect: Rect,
}

#[derive(Clone, Debug)]
pub struct SensitiveTrack {
    pub kind: SensitiveKind,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub samples: Vec<TrackSample>,
}

#[derive(Clone, Debug)]
pub struct Detection {
    pub kind: SensitiveKind,
    pub text: String,
    pub rect: Rect,
}

fn rows(lines: &[ReadLine]) -> Vec<ReadLine> {
    let mut sorted: Vec<&ReadLine> = lines.iter().filter(|line| !line.boxes.is_empty()).collect();
    sorted.sort_by(|a, b| a.boxes[0].x0.total_cmp(&b.boxes[0].x0));
    let mut rows: Vec<ReadLine> = Vec::new();
    for line in sorted {
        let first = line.boxes[0];
        let joined = rows.iter_mut().find(|row| {
            let Some(last) = row.boxes.last() else {
                return false;
            };
            let overlap = last.y1.min(first.y1) - last.y0.max(first.y0);
            let height = last.height().min(first.height());
            overlap >= height * 0.5
                && first.x0 >= last.x1 - 1.0
                && first.x0 - last.x1 <= height * ROW_GAP
        });
        match joined {
            Some(row) => {
                let last = row.boxes[row.boxes.len() - 1];
                row.text.push(' ');
                row.boxes.push(Rect::new(
                    last.x1,
                    last.y0.min(first.y0),
                    first.x0.max(last.x1),
                    last.y1.max(first.y1),
                ));
                row.text.push_str(&line.text);
                row.boxes.extend_from_slice(&line.boxes);
            }
            None => rows.push(line.clone()),
        }
    }
    rows
}

pub fn detect(lines: &[ReadLine], phrases: &[String]) -> Vec<Detection> {
    rows(lines)
        .iter()
        .flat_map(|line| {
            let chars: Vec<char> = line.text.chars().collect();
            find_sensitive(&line.text, phrases)
                .into_iter()
                .filter_map(move |m| {
                    Some(Detection {
                        kind: m.kind,
                        text: chars[m.start..m.end].iter().collect(),
                        rect: line.span_rect(m.start, m.end)?,
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

struct ActiveTrack {
    kind: SensitiveKind,
    text: String,
    samples: Vec<(f64, Rect)>,
    motion: Motion,
    first_motion: Motion,
    seen_before: Option<f64>,
    missed_reads: u32,
    coasting: u32,
    replaced: bool,
}

struct WindowFrame {
    first: f64,
    last: f64,
    frame: LumaFrame,
    arrival: Option<Similarity>,
    after_cut: bool,
}

const MATCH_IOU: f32 = 0.3;
const MAX_MISSED_READS: u32 = 2;
const CHANGE_LEVEL: f32 = 1.5;
const SHARED_MOTIONS: usize = 4;
const SETTLE_TIME: f64 = 0.3;
const EDGE_VISIBLE: f32 = 0.95;
const MAX_COASTING: u32 = 2;
const ROW_GAP: f32 = 10.0;
const MIN_CHANGED_TILES: usize = 4;
const CUT_SHARE: f32 = 0.2;
const REPLACED_SHARE: f32 = 0.3;
const MIN_CUT_GAP: f64 = 0.25;
const TRAVEL_SHARE: f32 = 0.5;
const MARGIN: f32 = 0.3;
const GLOBAL_SNAP: f32 = 3.0;
const MOTION_WIDTH: u32 = 240;
const EDGE_SNAP: f32 = 4.0;
const ALTERED_LEVEL: u8 = 24;
const ALTERED_PIXELS: usize = 4;

fn difference(a: &LumaFrame, b: &LumaFrame) -> f32 {
    if (a.width, a.height) != (b.width, b.height) {
        return f32::INFINITY;
    }
    let total: u64 = a
        .pixels
        .iter()
        .zip(&b.pixels)
        .step_by(7)
        .map(|(x, y)| u64::from(x.abs_diff(*y)))
        .sum();
    total as f32 / (a.pixels.len() / 7).max(1) as f32
}

pub fn in_motion(prev: &LumaFrame, next: &LumaFrame) -> bool {
    changed(
        &prev.downscaled(MOTION_WIDTH),
        &next.downscaled(MOTION_WIDTH),
    )
}

fn changed(a: &LumaFrame, b: &LumaFrame) -> bool {
    (a.width, a.height) != (b.width, b.height)
        || changed_tiles(a, b, &[Similarity::IDENTITY]).changed.len() >= MIN_CHANGED_TILES
}

fn altered(a: &LumaFrame, b: &LumaFrame) -> bool {
    (a.width, a.height) != (b.width, b.height)
        || a.pixels
            .iter()
            .zip(&b.pixels)
            .filter(|(x, y)| x.abs_diff(**y) >= ALTERED_LEVEL)
            .take(ALTERED_PIXELS)
            .count()
            >= ALTERED_PIXELS
        || changed(a, b)
}

fn covered_share(rect: Rect, tiles: &[Rect]) -> f32 {
    let area = rect.area();
    if area <= 0.0 {
        return 0.0;
    }
    tiles
        .iter()
        .map(|tile| tile.intersection(&rect).area())
        .sum::<f32>()
        / area
}

fn agrees(motion: Motion, expected: Motion, tolerance: f32) -> bool {
    (motion.dx - expected.dx).abs() <= tolerance
        && (motion.dy - expected.dy).abs() <= tolerance
        && (motion.scale - expected.scale).abs() < 0.01
}

fn leaving_view(rect: Rect, bounds: Rect) -> bool {
    let visible = rect.intersection(&bounds).area();
    visible > 0.0 && visible < rect.area() * EDGE_VISIBLE
}

pub struct Scanner<'a, R: ReadText = TextReader> {
    reader: &'a R,
    settings: ScanSettings,
    scale: Option<(f32, f32, f32, f32)>,
    last_read: Option<(f64, LumaFrame)>,
    still_since: f64,
    travel: f32,
    force_read: Option<f64>,
    ocr_frames: usize,
    window: Vec<WindowFrame>,
    arrival: Option<Similarity>,
    unread: Option<(f64, LumaFrame)>,
    active: Vec<ActiveTrack>,
    finished: Vec<SensitiveTrack>,
}

impl<'a, R: ReadText> Scanner<'a, R> {
    pub fn new(reader: &'a R, settings: ScanSettings) -> Self {
        Self {
            reader,
            settings,
            scale: None,
            last_read: None,
            still_since: 0.0,
            travel: 0.0,
            force_read: None,
            ocr_frames: 0,
            window: Vec::new(),
            arrival: None,
            unread: None,
            active: Vec::new(),
            finished: Vec::new(),
        }
    }

    pub fn ocr_frames(&self) -> usize {
        self.ocr_frames
    }

    fn follow_tracks(
        &mut self,
        time: f64,
        prev: &LumaFrame,
        small: &LumaFrame,
        global: Option<Similarity>,
    ) -> bool {
        let had_tracks = !self.active.is_empty();
        let mut shared: Vec<Motion> = Vec::new();
        let mut pairs = Vec::new();
        let mut kept = Vec::new();
        let mut lost = Vec::new();
        for mut track in std::mem::take(&mut self.active) {
            let Some(&(_, rect)) = track.samples.last() else {
                continue;
            };
            let guesses: Vec<Motion> = std::iter::once(track.motion)
                .chain(global.map(|global| global.motion_for(rect)))
                .chain(shared.iter().copied())
                .collect();
            let expected = global.map(|global| global.motion_for(rect));
            let followed = follow(prev, small, rect, &guesses)
                .map(|(moved, motion)| match expected {
                    Some(expected) if agrees(motion, expected, GLOBAL_SNAP) => (
                        rect.moved(expected.dx, expected.dy, expected.scale),
                        expected,
                    ),
                    _ => (moved, motion),
                })
                .filter(|(_, motion)| {
                    expected.is_none_or(|expected| {
                        agrees(*motion, expected, rect.height())
                            || agrees(*motion, Motion::default(), rect.height())
                    })
                });
            match followed {
                Some((moved, motion)) => {
                    if shared.len() < SHARED_MOTIONS
                        && !shared.iter().any(|known| {
                            (known.dx - motion.dx).abs() < 1.0
                                && (known.dy - motion.dy).abs() < 1.0
                                && (known.scale - motion.scale).abs() < 0.01
                        })
                    {
                        shared.push(motion);
                    }
                    pairs.push((rect.center(), moved.center(), motion.scale));
                    track.samples.push((time, moved));
                    track.motion = motion;
                    track.coasting = 0;
                    kept.push(track);
                }
                None => lost.push((track, rect)),
            }
        }
        let arrival = global.or_else(|| Similarity::fit(&pairs));
        let bounds = small.bounds();
        let mut confirmed_any = !kept.is_empty();
        for (mut track, rect) in lost {
            let predicted = arrival.map_or(track.motion, |arrival| arrival.motion_for(rect));
            let moved = rect.moved(predicted.dx, predicted.dy, predicted.scale);
            let confirmed = arrival.is_some()
                && (leaving_view(moved, bounds) || plausible(prev, small, rect, predicted));
            if confirmed {
                track.coasting = 0;
                confirmed_any = true;
            } else {
                track.coasting += 1;
            }
            let carried = (track.coasting <= MAX_COASTING
                && moved.intersection(&bounds).area() > 0.0)
                .then_some(predicted);
            match carried {
                Some(motion) => {
                    track
                        .samples
                        .push((time, rect.moved(motion.dx, motion.dy, motion.scale)));
                    track.motion = motion;
                    kept.push(track);
                }
                None => self.end_track(track, Some(time)),
            }
        }
        self.active = kept;
        self.arrival = arrival;
        had_tracks && !confirmed_any
    }

    fn read_unread(&mut self, until: f64) -> anyhow::Result<()> {
        let Some((time, frame)) = self.unread.take() else {
            return Ok(());
        };
        let Some(entry) = self.window.last() else {
            return Ok(());
        };
        if self
            .last_read
            .as_ref()
            .is_some_and(|(_, read)| !altered(read, &entry.frame))
        {
            return Ok(());
        }
        let (sx, sy, _, _) = self.scale.unwrap_or((1.0, 1.0, 1.0, 1.0));
        let detections = detect(&self.reader.read_text(&frame)?, &self.settings.phrases);
        self.ocr_frames += 1;
        let current = entry.frame.clone();
        let arrival = entry.arrival;
        let before = self.active.len();
        self.window.pop();
        self.apply_detections(time, &current, arrival, detections, sx, sy);
        let created: Vec<ActiveTrack> =
            self.active.drain(before.min(self.active.len())..).collect();
        for track in created {
            self.end_track(track, Some(until));
        }
        Ok(())
    }

    pub fn push_frame(&mut self, time: f64, frame: &LumaFrame) -> anyhow::Result<()> {
        let small = frame.downscaled(self.settings.tracking_width);
        let (sx, sy, _, _) = *self.scale.get_or_insert((
            small.width as f32 / frame.width as f32,
            small.height as f32 / frame.height as f32,
            small.width as f32,
            small.height as f32,
        ));

        let previous = self.window.last().map(|entry| entry.frame.clone());
        let moving = previous
            .as_ref()
            .is_none_or(|previous| difference(previous, &small) > CHANGE_LEVEL);
        let changed_now = previous
            .as_ref()
            .is_none_or(|previous| changed(previous, &small));
        let altered_now = previous
            .as_ref()
            .is_none_or(|previous| altered(previous, &small));
        let mut after_cut = false;

        match previous.as_ref() {
            Some(prev) if moving => {
                let global = global_motion(prev, &small, self.arrival);
                let tiles = changed_tiles(
                    prev,
                    &small,
                    &[global.unwrap_or(Similarity::IDENTITY), Similarity::IDENTITY],
                );
                after_cut = global.is_none()
                    || tiles.changed.len() as f32 >= tiles.content as f32 * CUT_SHARE;
                if after_cut {
                    let read_recently = self
                        .last_read
                        .as_ref()
                        .is_some_and(|(read_at, _)| time - read_at < MIN_CUT_GAP);
                    if !read_recently {
                        self.read_unread(time)?;
                    }
                    let motion = global.unwrap_or(Similarity::IDENTITY);
                    for track in &mut self.active {
                        track.replaced = track.samples.last().is_some_and(|(_, rect)| {
                            let step = motion.motion_for(*rect);
                            let moved = rect.moved(step.dx, step.dy, step.scale);
                            covered_share(moved, &tiles.changed) >= REPLACED_SHARE
                        });
                    }
                    let in_place = global.is_some_and(|global| {
                        agrees(global.motion_for(small.bounds()), Motion::default(), 1.0)
                    });
                    let earliest = self
                        .last_read
                        .as_ref()
                        .filter(|_| in_place)
                        .map_or(time, |(read_at, _)| read_at + MIN_CUT_GAP);
                    self.force_read = Some(self.force_read.map_or(earliest, |at| at.min(earliest)));
                }
                if let Some(global) = global {
                    let motion = global.motion_for(small.bounds());
                    self.travel += motion.dx.abs()
                        + motion.dy.abs()
                        + (motion.scale - 1.0).abs() * small.height as f32;
                }
                if self.follow_tracks(time, prev, &small, global) {
                    self.read_unread(time)?;
                }
            }
            _ => {
                self.arrival = None;
                for track in &mut self.active {
                    if let Some(&(_, rect)) = track.samples.last() {
                        track.samples.push((time, rect));
                    }
                    track.motion = Motion::default();
                }
            }
        }

        if changed_now {
            self.still_since = time;
        }
        let due = match &self.last_read {
            None => true,
            Some((read_at, read_frame)) => {
                self.force_read.is_some_and(|at| time >= at)
                    || (time - read_at >= self.settings.max_ocr_interval
                        && altered(read_frame, &small))
                    || (changed(read_frame, &small)
                        && (time - self.still_since >= SETTLE_TIME
                            || self.travel >= small.height as f32 * TRAVEL_SHARE))
            }
        };
        let arrival = self.arrival;
        if due {
            self.ocr_frames += 1;
            let detections = detect(&self.reader.read_text(frame)?, &self.settings.phrases);
            self.apply_detections(time, &small, arrival, detections, sx, sy);
            self.window.clear();
            self.last_read = Some((time, small.clone()));
            self.travel = 0.0;
            self.force_read = None;
            self.unread = None;
        } else {
            self.unread = Some((time, frame.clone()));
        }

        match self.window.last_mut() {
            Some(previous) if !altered_now && !due => previous.last = time,
            _ => self.window.push(WindowFrame {
                first: time,
                last: time,
                frame: small,
                arrival: if due { None } else { arrival },
                after_cut,
            }),
        }
        Ok(())
    }

    fn apply_detections(
        &mut self,
        time: f64,
        small: &LumaFrame,
        arrival: Option<Similarity>,
        detections: Vec<Detection>,
        sx: f32,
        sy: f32,
    ) {
        let mut matched = vec![false; self.active.len()];
        for detection in detections {
            let rect = detection.rect.scaled(sx, sy);
            let best = self
                .active
                .iter()
                .enumerate()
                .filter(|(index, track)| !matched[*index] && track.kind == detection.kind)
                .map(|(index, track)| (index, track.samples.last().map_or(0.0, |s| s.1.iou(&rect))))
                .filter(|(_, iou)| *iou >= MATCH_IOU)
                .max_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((index, _)) = best {
                matched[index] = true;
                let track = &mut self.active[index];
                if let Some(last) = track.samples.last_mut() {
                    last.1 = Rect::new(
                        last.1.x0.min(rect.x0),
                        rect.y0,
                        last.1.x1.max(rect.x1),
                        rect.y1,
                    );
                }
                track.missed_reads = 0;
                continue;
            }
            if self.active.iter().any(|track| {
                track.kind == detection.kind
                    && track
                        .samples
                        .last()
                        .is_some_and(|s| s.1.iou(&rect) >= MATCH_IOU)
            }) {
                continue;
            }
            let mut track = ActiveTrack {
                kind: detection.kind,
                text: detection.text,
                samples: vec![(time, rect)],
                motion: Motion::default(),
                first_motion: Motion::default(),
                seen_before: None,
                missed_reads: 0,
                coasting: 0,
                replaced: false,
            };
            self.backtrack(&mut track, small, arrival);
            matched.push(true);
            self.active.push(track);
        }

        let mut still_active = Vec::with_capacity(self.active.len());
        for (index, mut track) in std::mem::take(&mut self.active).into_iter().enumerate() {
            if std::mem::take(&mut track.replaced) && !matched[index] {
                self.end_track(track, Some(time));
                continue;
            }
            if !matched[index] {
                track.missed_reads += 1;
                if track.missed_reads > MAX_MISSED_READS {
                    self.end_track(track, Some(time));
                    continue;
                }
            }
            still_active.push(track);
        }
        self.active = still_active;
    }

    fn backtrack(&self, track: &mut ActiveTrack, current: &LumaFrame, arrival: Option<Similarity>) {
        let mut later = current;
        let mut later_arrival = arrival;
        let mut rect = track.samples[0].1;
        let mut motion = Motion::default();
        let mut earlier_samples = Vec::new();
        let bounds = current.bounds();
        for entry in self.window.iter().rev() {
            let back = later_arrival.map(|arrival| arrival.inverse().motion_for(rect));
            let guesses: Vec<Motion> = std::iter::once(motion).chain(back).collect();
            let step = follow(later, &entry.frame, rect, &guesses).or_else(|| {
                back.map(|back| (rect.moved(back.dx, back.dy, back.scale), back))
                    .filter(|(moved, back)| {
                        leaving_view(*moved, bounds) || plausible(later, &entry.frame, rect, *back)
                    })
            });
            let Some((moved, step)) = step else {
                track.seen_before = Some(entry.last);
                break;
            };
            earlier_samples.push((entry.last, moved));
            if entry.first < entry.last {
                earlier_samples.push((entry.first, moved));
            }
            rect = moved;
            motion = step;
            later = &entry.frame;
            later_arrival = entry.arrival;
            if entry.after_cut {
                break;
            }
        }
        track.first_motion = motion.reversed();
        earlier_samples.reverse();
        earlier_samples.append(&mut track.samples);
        track.samples = earlier_samples;
    }

    fn end_track(&mut self, track: ActiveTrack, lost_at: Option<f64>) {
        let Some((_, _, frame_width, frame_height)) = self.scale else {
            return;
        };
        let step = 1.0 / self.settings.sample_fps;
        let (first_time, first_rect) = track.samples[0];
        let (last_time, last_rect) = *track.samples.last().unwrap_or(&track.samples[0]);
        let start = track.seen_before.unwrap_or((first_time - step).max(0.0));
        let end = lost_at.unwrap_or(last_time + step);
        let before = first_rect.moved(-track.first_motion.dx, -track.first_motion.dy, 1.0);
        let after = last_rect.moved(track.motion.dx, track.motion.dy, 1.0);

        let mut samples: Vec<(f64, Rect)> = Vec::with_capacity(track.samples.len() + 2);
        if start < first_time {
            samples.push((start, before.union(&first_rect)));
        }
        samples.extend(track.samples);
        if end > last_time {
            samples.push((end, after.union(&last_rect)));
        }
        let pad = |rect: Rect| {
            let height = rect.height();
            let padded = rect.expanded(height * MARGIN + 2.0, height * MARGIN + 2.0);
            Rect::new(
                if padded.x0 <= EDGE_SNAP {
                    -1.0
                } else {
                    padded.x0
                },
                if padded.y0 <= EDGE_SNAP {
                    -1.0
                } else {
                    padded.y0
                },
                if padded.x1 >= frame_width - EDGE_SNAP {
                    frame_width + 1.0
                } else {
                    padded.x1
                },
                if padded.y1 >= frame_height - EDGE_SNAP {
                    frame_height + 1.0
                } else {
                    padded.y1
                },
            )
        };
        let swept: Vec<(f64, Rect)> = samples
            .iter()
            .enumerate()
            .map(|(index, &(time, own))| {
                let near = &samples[index.saturating_sub(1)..(index + 2).min(samples.len())];
                (
                    time,
                    pad(near.iter().fold(own, |rect, (_, other)| rect.union(other))),
                )
            })
            .collect();

        self.finished.push(SensitiveTrack {
            kind: track.kind,
            text: track.text,
            start,
            end,
            samples: swept
                .into_iter()
                .map(|(time, rect)| TrackSample {
                    time,
                    rect: rect
                        .scaled(1.0 / frame_width, 1.0 / frame_height)
                        .intersection(&Rect::new(0.0, 0.0, 1.0, 1.0)),
                })
                .collect(),
        });
    }

    pub fn finish(mut self) -> anyhow::Result<Vec<SensitiveTrack>> {
        if let Some((time, _)) = self.unread {
            let step = 1.0 / self.settings.sample_fps;
            self.read_unread(time + step)?;
        }
        for track in std::mem::take(&mut self.active) {
            self.end_track(track, None);
        }
        let mut finished = self.finished;
        finished.sort_by(|a, b| a.start.total_cmp(&b.start));
        Ok(finished)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synthetic::{Canvas, PROSE, sans};
    use std::cell::Cell;

    const EMAIL: &str = "al@ab.io";
    const PAGE: u8 = 245;

    struct PageReader {
        email: Rect,
        reads: Cell<usize>,
    }

    impl ReadText for PageReader {
        fn read_text(&self, frame: &LumaFrame) -> anyhow::Result<Vec<ReadLine>> {
            self.reads.set(self.reads.get() + 1);
            let (_, y) = self.email.center();
            let row = y as usize * frame.width as usize;
            let inked = frame.pixels[row + self.email.x0 as usize..row + self.email.x1 as usize]
                .iter()
                .any(|pixel| pixel.abs_diff(PAGE) > 60);
            if !inked {
                return Ok(Vec::new());
            }
            let count = EMAIL.chars().count();
            let step = self.email.width() / count as f32;
            Ok(vec![ReadLine {
                text: EMAIL.into(),
                boxes: (0..count)
                    .map(|index| {
                        Rect::new(
                            self.email.x0 + step * index as f32,
                            self.email.y0,
                            self.email.x0 + step * (index + 1) as f32,
                            self.email.y1,
                        )
                    })
                    .collect(),
            }])
        }
    }

    fn still_page_then_small_email() -> (LumaFrame, LumaFrame, Rect) {
        let font = sans();
        let mut canvas = Canvas::new(1924, 1084, PAGE);
        for line in 0..12 {
            canvas.text(
                &font,
                26.0,
                80.0,
                60.0 + line as f32 * 36.0,
                PROSE[line % PROSE.len()],
                40,
            );
        }
        let before = canvas.view(0.0, 0.0, 1920, 1080, 1.0, PAGE);
        let email = canvas.text(&font, 14.0, 1030.0, 804.0, EMAIL, 40);
        let after = canvas.view(0.0, 0.0, 1920, 1080, 1.0, PAGE);
        (before, after, email)
    }

    fn scan_small_email(appears: usize, frames: usize) -> (Vec<SensitiveTrack>, usize) {
        let (before, after, email) = still_page_then_small_email();
        let settings = ScanSettings::default();
        assert!(!changed(
            &before.downscaled(settings.tracking_width),
            &after.downscaled(settings.tracking_width)
        ));
        let reader = PageReader {
            email,
            reads: Cell::new(0),
        };
        let fps = settings.sample_fps;
        let mut scanner = Scanner::new(&reader, settings);
        for index in 0..frames {
            let frame = if index < appears { &before } else { &after };
            scanner.push_frame(index as f64 / fps, frame).unwrap();
        }
        (scanner.finish().unwrap(), reader.reads.get())
    }

    #[test]
    fn a_small_text_change_on_a_still_screen_is_read_within_the_maximum_interval() {
        let (tracks, reads) = scan_small_email(5, 45);
        assert_eq!(reads, 2);
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        assert_eq!(tracks[0].kind, SensitiveKind::Email);
        assert!(tracks[0].start < 5.0 / 15.0, "{}", tracks[0].start);
        assert!(tracks[0].end >= 44.0 / 15.0, "{}", tracks[0].end);
    }

    #[test]
    fn a_small_text_change_just_before_the_end_is_read_when_the_scan_finishes() {
        let (tracks, reads) = scan_small_email(5, 10);
        assert_eq!(reads, 2);
        assert_eq!(tracks.len(), 1, "{tracks:?}");
        assert!(tracks[0].start < 5.0 / 15.0, "{}", tracks[0].start);
        assert!(tracks[0].end >= 9.0 / 15.0, "{}", tracks[0].end);
    }

    #[test]
    fn scrolling_is_motion_and_a_still_page_is_not() {
        let font = sans();
        let mut canvas = Canvas::new(640, 1200, 245);
        for line in 0..50 {
            canvas.text(
                &font,
                13.0,
                24.0,
                20.0 + line as f32 * 22.0,
                PROSE[line % PROSE.len()],
                40,
            );
        }
        let first = canvas.view(0.0, 100.0, 640, 360, 1.0, 245);
        assert!(!in_motion(
            &first,
            &canvas.view(0.0, 100.0, 640, 360, 1.0, 245)
        ));
        assert!(in_motion(
            &first,
            &canvas.view(0.0, 112.0, 640, 360, 1.0, 245)
        ));
    }
}
