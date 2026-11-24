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
    frames::{self, FrameSource},
    image::Rect,
    model::OcrModel,
    scan::Scan,
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
    /// Frames identical to the one before (only the change map ran).
    pub duplicates: u64,
    pub cache_entries: u64,
    pub decode: Duration,
    pub gray: Duration,
    pub rgb: Duration,
    pub detect: Duration,
    pub recognize: Duration,
    pub track: Duration,
    pub classify: Duration,
    pub compile: Duration,
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

/// Frames prepared ahead of the one being finished, so their detection runs
/// on the GPU while the CPU works.
const LOOKAHEAD: usize = 3;

pub struct Analyzer<'a> {
    pub model: &'a mut OcrModel,
    pub cancel: Arc<AtomicBool>,
    pub progress_interval: Duration,
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
        let mut scan = Scan::new(source.index, width, height, frames.track_width);
        scan.end_time = frames.duration;
        let mut last_progress = Instant::now();
        let mut decode_mark = Instant::now();
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
        let mut in_flight = VecDeque::new();
        frames.for_each(|frames, frame| {
            stats.decode += decode_mark.elapsed();
            if cancel.load(Ordering::Relaxed) {
                anyhow::bail!("cancelled");
            }
            let gray_started = Instant::now();
            let gray = Arc::new(frames.gray(&frame.video)?);
            stats.gray += gray_started.elapsed();
            let time = frame.time;
            let prepared = scan.prepare(model, frames, frame, gray, stats)?;
            in_flight.push_back(prepared);
            while in_flight.len() > LOOKAHEAD {
                if let Some(oldest) = in_flight.pop_front() {
                    scan.finish(model, frames, oldest, stats)?;
                }
            }
            stats.frames += 1;
            if last_progress.elapsed() >= Duration::from_millis(500) {
                last_progress = Instant::now();
                segment_info.source_frames = scan.frame_count;
                segment_info.fps = scan.fps_estimate;
                let compile_started = Instant::now();
                let partial = scan.regions();
                stats.compile += compile_started.elapsed();
                progress(time, &partial, &segment_info);
            }
            decode_mark = Instant::now();
            Ok(true)
        })?;
        while let Some(oldest) = in_flight.pop_front() {
            scan.finish(model, &mut frames, oldest, stats)?;
        }
        stats.hardware_decode |= frames.is_hardware_accelerated();
        let fps = scan.fps_estimate;
        stats.source_seconds += scan.last_time - scan.first_time.unwrap_or(0.0) + 1.0 / fps;
        let compile_started = Instant::now();
        let regions = scan.regions();
        stats.compile += compile_started.elapsed();
        stats.cache_entries += scan.cache_entries() as u64;
        stats.total += started.elapsed();
        segment_info.source_frames = scan.frame_count;
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

pub(crate) fn merge_overlapping(mut rects: Vec<Rect>) -> Vec<Rect> {
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let union = rects[i].union(&rects[j]);
                if union.area() < (rects[i].area() + rects[j].area()) * 1.3 {
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

pub(crate) fn region_id(
    segment: u32,
    category: RedactCategory,
    start: f64,
    first: &RedactionKey,
) -> String {
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
