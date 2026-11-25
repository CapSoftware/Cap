use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
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
    scan::{LOOKAHEAD, Prepared, Scan},
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
    /// Time finishing waited for prepared frames, and preparing waited for
    /// decoded ones.
    pub frame_wait: Duration,
    pub decode_wait: Duration,
    /// Analysis time per frame (preparing it and finishing the frames it
    /// lets through), for the spread of frame costs.
    pub frame_costs: Vec<Duration>,
    /// Time in the per-frame preparation (change map, regions, detection
    /// start) and in finishing frames (lines, reading, classifying).
    pub prepare: Duration,
    pub finish: Duration,
    pub total: Duration,
    pub source_seconds: f64,
    pub hardware_decode: bool,
}

impl Stats {
    /// Adds what another thread measured for the same segment.
    fn absorb(&mut self, other: &Stats) {
        self.duplicates += other.duplicates;
        self.det_pixels += other.det_pixels;
        self.decode += other.decode;
        self.gray += other.gray;
        self.rgb += other.rgb;
        self.detect += other.detect;
        self.track += other.track;
        self.prepare += other.prepare;
        self.decode_wait += other.frame_wait;
    }
}

pub struct Progress<'a> {
    pub segment: u32,
    pub source_time: f64,
    /// Every region found so far, including ones still being tracked.
    pub snapshot: &'a Redactions,
}

/// Decoded frames queued ahead of the analysis.
const DECODE_AHEAD: usize = 1;

/// A frame from the decoding thread, with its tracking-size luma and what
/// producing them took.
struct Decoded {
    frame: frames::Frame,
    gray: crate::image::GrayImage,
    decode: Duration,
    gray_time: Duration,
}

fn join_decoder(
    decoder: std::thread::ScopedJoinHandle<'_, anyhow::Result<bool>>,
) -> anyhow::Result<bool> {
    decoder
        .join()
        .unwrap_or_else(|_| Err(anyhow::anyhow!("decoder thread panicked")))
}

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
            scanner: crate::SCAN_REVISION,
            segments: Vec::new(),
            regions: Vec::new(),
        };
        for source in sources {
            if self.cancel.load(Ordering::Relaxed) {
                anyhow::bail!("cancelled");
            }
            let fingerprint = first_frame_fingerprint(&source.path)?;
            if let Some(previous) = previous
                && same_scanner(previous, &result)
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
            result.regions.extend(regions.into_iter().map(round_region));
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
        let cancel = self.cancel.clone();
        let model = &mut *self.model;
        let (opened_tx, opened_rx) = mpsc::sync_channel(1);
        let (frame_tx, frame_rx) = mpsc::sync_channel::<Decoded>(DECODE_AHEAD);
        let path = source.path.clone();
        let decode_cancel = cancel.clone();
        let (scan, segment_info) = std::thread::scope(|scope| -> anyhow::Result<_> {
            // Decoding and the tracking-size luma run here while the frames
            // before are analysed; the channel keeps their order.
            let decoder = scope.spawn(move || -> anyhow::Result<bool> {
                let mut frames = match FrameSource::open(&path) {
                    Ok(frames) => frames,
                    Err(error) => {
                        let _ = opened_tx.send(None);
                        return Err(error);
                    }
                };
                let _ = opened_tx.send(Some((
                    SegmentShape {
                        width: frames.width,
                        height: frames.height,
                        track_width: frames.track_width,
                        duration: frames.duration,
                    },
                    frames.is_hardware_accelerated(),
                )));
                let mut decode_mark = Instant::now();
                frames.for_each(|frames, frame| {
                    let decode = decode_mark.elapsed();
                    if decode_cancel.load(Ordering::Relaxed) {
                        return Ok(false);
                    }
                    let gray_started = Instant::now();
                    let gray = frames.gray(&frame.video)?;
                    let sent = frame_tx
                        .send(Decoded {
                            frame,
                            gray,
                            decode,
                            gray_time: gray_started.elapsed(),
                        })
                        .is_ok();
                    decode_mark = Instant::now();
                    Ok(sent)
                })?;
                Ok(frames.is_hardware_accelerated())
            });
            let Ok(Some((shape, hardware))) = opened_rx.recv() else {
                return Err(join_decoder(decoder)
                    .err()
                    .unwrap_or_else(|| anyhow::anyhow!("decoder stopped")));
            };
            stats.hardware_decode = hardware;
            let analysed = analyze_decoded(
                model,
                &cancel,
                source.index,
                shape,
                fingerprint,
                frame_rx,
                stats,
                &mut progress,
            );
            let hardware = join_decoder(decoder);
            let analysed = analysed?;
            stats.hardware_decode |= hardware?;
            Ok(analysed)
        })?;
        Ok(close_segment(scan, segment_info, stats, started))
    }
}

/// What the analysis of a segment needs before its frames arrive.
#[derive(Debug, Clone, Copy)]
struct SegmentShape {
    width: u32,
    height: u32,
    track_width: u32,
    duration: Option<f64>,
}

/// Analyses the frames arriving on `frame_rx` in order, until it closes: the
/// same work for decoded files and for frames pushed while recording.
#[allow(clippy::too_many_arguments)]
fn analyze_decoded(
    model: &mut OcrModel,
    cancel: &Arc<AtomicBool>,
    index: u32,
    shape: SegmentShape,
    fingerprint: String,
    frame_rx: mpsc::Receiver<Decoded>,
    stats: &mut Stats,
    progress: &mut dyn FnMut(f64, &[RedactionRegion], &RedactionSegment),
) -> anyhow::Result<(Scan, RedactionSegment)> {
    let mut convert = frames::Convert::default();
    std::thread::scope(|scope| -> anyhow::Result<_> {
        let mut scan = Scan::new(index, shape.width, shape.height, shape.track_width);
        scan.end_time = shape.duration;
        let mut last_progress = Instant::now();
        let mut segment_info = RedactionSegment {
            index,
            source_frames: 0,
            fps: 0.0,
            width: shape.width,
            height: shape.height,
            fingerprint,
            complete: false,
        };
        // Frames are prepared on their own thread (change map, regions,
        // detection start) while this one finishes the frames before.
        // Preparing a frame needs the detector scale the line heights
        // gave after the frame LOOKAHEAD + 1 earlier was finished; this
        // thread sends one scale per finished frame, in order.
        let (prepared_tx, prepared_rx) = mpsc::sync_channel::<Prepared>(LOOKAHEAD);
        let (scale_tx, scale_rx) = mpsc::channel::<f32>();
        let mut prep = scan.prep();
        let mut starter = model.starter()?;
        let first_scale = scan.detect_scale();
        let prep_cancel = cancel.clone();
        let preparer = scope.spawn(move || -> anyhow::Result<Stats> {
            let mut stats = Stats::default();
            let mut convert = frames::Convert::default();
            let mut wait_mark = Instant::now();
            for (index, decoded) in frame_rx.iter().enumerate() {
                stats.frame_wait += wait_mark.elapsed();
                stats.decode += decoded.decode;
                stats.gray += decoded.gray_time;
                if prep_cancel.load(Ordering::Relaxed) {
                    break;
                }
                let scale = if index > LOOKAHEAD {
                    match scale_rx.recv() {
                        Ok(scale) => scale,
                        Err(_) => break,
                    }
                } else {
                    first_scale
                };
                let started = Instant::now();
                let prepared = prep.prepare(
                    &mut starter,
                    &mut convert,
                    decoded.frame,
                    Arc::new(decoded.gray),
                    scale,
                    &mut stats,
                )?;
                stats.prepare += started.elapsed();
                if prepared_tx.send(prepared).is_err() {
                    break;
                }
                wait_mark = Instant::now();
            }
            Ok(stats)
        });
        let mut wait_mark = Instant::now();
        for prepared in prepared_rx.iter() {
            stats.frame_wait += wait_mark.elapsed();
            if cancel.load(Ordering::Relaxed) {
                anyhow::bail!("cancelled");
            }
            let time = prepared.time();
            scan.receive(time);
            let finish_started = Instant::now();
            scan.finish(model, &mut convert, prepared, stats)?;
            let _ = scale_tx.send(scan.detect_scale());
            stats.finish += finish_started.elapsed();
            stats.frames += 1;
            stats.frame_costs.push(finish_started.elapsed());
            if last_progress.elapsed() >= Duration::from_millis(500) {
                last_progress = Instant::now();
                segment_info.source_frames = scan.frame_count;
                segment_info.fps = scan.fps_estimate;
                let compile_started = Instant::now();
                let partial = scan.regions();
                stats.compile += compile_started.elapsed();
                progress(time, &partial, &segment_info);
            }
            wait_mark = Instant::now();
        }
        drop(scale_tx);
        let prepared_stats = preparer
            .join()
            .unwrap_or_else(|_| Err(anyhow::anyhow!("preparing thread panicked")))?;
        stats.absorb(&prepared_stats);
        Ok((scan, segment_info))
    })
}

/// The segment's regions once every frame was analysed.
fn close_segment(
    mut scan: Scan,
    mut segment_info: RedactionSegment,
    stats: &mut Stats,
    started: Instant,
) -> (RedactionSegment, Vec<RedactionRegion>) {
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
    (segment_info, regions)
}

/// Frames a live segment queues ahead of its analysis; a push beyond this is
/// dropped and counted rather than waited for.
pub const LIVE_QUEUE: usize = 60;

/// One segment analysed while it records: frames are pushed as they are
/// written, in order, and the result is the same as analysing the finished
/// video, as long as no frame was dropped.
pub struct LiveSegment {
    frames: Option<mpsc::SyncSender<Decoded>>,
    gray: frames::GrayScale,
    last_time: f64,
    dropped: u64,
    cancel: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<LiveOutcome>>,
}

struct LiveOutcome {
    model: OcrModel,
    analysed: anyhow::Result<(Scan, RedactionSegment)>,
    stats: Stats,
}

/// A finished live segment: the model back, and its regions unless the
/// analysis failed.
pub struct LiveResult {
    pub model: OcrModel,
    pub segment: anyhow::Result<(RedactionSegment, Vec<RedactionRegion>)>,
    /// Pushed frames that were dropped because the queue was full; the
    /// result is complete only when this is zero.
    pub dropped: u64,
    pub stats: Stats,
}

impl LiveSegment {
    /// Starts analysing segment `index` of `width` x `height` frames on a
    /// thread of its own; `worker` runs first on that thread (to lower its
    /// priority, for one).
    pub fn start(
        mut model: OcrModel,
        index: u32,
        width: u32,
        height: u32,
        worker: impl FnOnce() + Send + 'static,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(width > 0 && height > 0, "frames have no size");
        let gray = frames::GrayScale::new(width, height);
        let shape = SegmentShape {
            width,
            height,
            track_width: gray.track_width(),
            duration: None,
        };
        let (frame_tx, frame_rx) = mpsc::sync_channel::<Decoded>(LIVE_QUEUE);
        let cancel = Arc::new(AtomicBool::new(false));
        let worker_cancel = cancel.clone();
        let handle = std::thread::Builder::new()
            .name("cap-redact-live".into())
            .spawn(move || {
                worker();
                let mut stats = Stats::default();
                let analysed = analyze_decoded(
                    &mut model,
                    &worker_cancel,
                    index,
                    shape,
                    String::new(),
                    frame_rx,
                    &mut stats,
                    &mut |_, _, _| {},
                );
                LiveOutcome {
                    model,
                    analysed,
                    stats,
                }
            })
            .context("start live analysis thread")?;
        Ok(Self {
            frames: Some(frame_tx),
            gray,
            last_time: -1.0,
            dropped: 0,
            cancel,
            worker: Some(handle),
        })
    }

    /// Queues one frame, `time` seconds after the segment's first frame.
    /// Returns false when the frame was dropped (the queue was full or the
    /// analysis stopped); the caller keeps writing either way.
    pub fn push(&mut self, time: f64, video: ffmpeg::frame::Video) -> anyhow::Result<bool> {
        self.queue(time, video, false)
    }

    fn queue(
        &mut self,
        time: f64,
        video: ffmpeg::frame::Video,
        wait: bool,
    ) -> anyhow::Result<bool> {
        let Some(frames) = &self.frames else {
            self.dropped += 1;
            return Ok(false);
        };
        // The same order rule as decoding a file: times only go forward.
        let time = if time <= self.last_time {
            self.last_time + 1e-4
        } else {
            time
        };
        let gray_started = Instant::now();
        let gray = self.gray.gray(&video)?;
        let decoded = Decoded {
            frame: frames::Frame { time, video },
            gray,
            decode: Duration::ZERO,
            gray_time: gray_started.elapsed(),
        };
        let sent = if wait {
            frames.send(decoded).is_ok()
        } else {
            frames.try_send(decoded).is_ok()
        };
        if sent {
            self.last_time = time;
        } else {
            self.dropped += 1;
        }
        Ok(sent)
    }

    /// Frames dropped so far.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Ends the segment: analyses what is queued, then compiles its regions
    /// with `duration` as the segment's length (the finished video's, as a
    /// decode of it would report) and `fingerprint` as its identity.
    pub fn finish(
        mut self,
        fingerprint: String,
        duration: Option<f64>,
    ) -> anyhow::Result<LiveResult> {
        let started = Instant::now();
        self.frames = None;
        self.wait(|outcome| {
            let LiveOutcome {
                model,
                analysed,
                mut stats,
            } = outcome;
            let segment = analysed.map(|(mut scan, mut segment_info)| {
                scan.end_time = duration;
                segment_info.fingerprint = fingerprint;
                let (segment, regions) = close_segment(scan, segment_info, &mut stats, started);
                (segment, regions.into_iter().map(round_region).collect())
            });
            (model, segment, stats)
        })
    }

    /// Stops without a result (the recording was discarded, or live analysis
    /// fell too far behind), handing the model back.
    pub fn cancel(mut self) -> anyhow::Result<LiveResult> {
        self.cancel.store(true, Ordering::Relaxed);
        self.frames = None;
        self.wait(|outcome| {
            (
                outcome.model,
                Err(anyhow::anyhow!("cancelled")),
                outcome.stats,
            )
        })
    }

    fn wait(
        &mut self,
        close: impl FnOnce(
            LiveOutcome,
        ) -> (
            OcrModel,
            anyhow::Result<(RedactionSegment, Vec<RedactionRegion>)>,
            Stats,
        ),
    ) -> anyhow::Result<LiveResult> {
        let handle = self
            .worker
            .take()
            .context("live segment already finished")?;
        let outcome = handle
            .join()
            .map_err(|_| anyhow::anyhow!("live analysis thread panicked"))?;
        let (model, segment, stats) = close(outcome);
        Ok(LiveResult {
            model,
            segment,
            dropped: self.dropped,
            stats,
        })
    }
}

impl Drop for LiveSegment {
    fn drop(&mut self) {
        if let Some(handle) = self.worker.take() {
            self.cancel.store(true, Ordering::Relaxed);
            self.frames = None;
            let _ = handle.join();
        }
    }
}

/// Whether `previous` was written by the same model and scanner revision as
/// `result`, so its complete segments can be reused.
fn same_scanner(previous: &Redactions, result: &Redactions) -> bool {
    previous.model == result.model && previous.scanner == result.scanner
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

/// Steps the saved rects and times are rounded to: a 1e-5 of the frame is
/// 0.02 px at 1920 wide, a microsecond keeps every key distinct.
const RECT_STEP: f64 = 1e5;
const TIME_STEP: f64 = 1e6;

/// A region with fewer digits, rounded outward: its keys and its time span
/// only ever grow, by at most one step.
fn round_region(mut region: RedactionRegion) -> RedactionRegion {
    region.start = (region.start * TIME_STEP).floor() / TIME_STEP;
    region.end = (region.end * TIME_STEP).ceil() / TIME_STEP;
    for key in &mut region.keys {
        key.t = (key.t * TIME_STEP).round() / TIME_STEP;
        let (x, w) = round_span(key.x, key.w);
        let (y, h) = round_span(key.y, key.h);
        (key.x, key.y, key.w, key.h) = (x, y, w, h);
    }
    region
}

/// `start` rounded down and `start + len` up, as a start and a length whose
/// f32 sum still reaches the original end.
fn round_span(start: f32, len: f32) -> (f32, f32) {
    let end = f64::from(start) + f64::from(len);
    let low = ((f64::from(start) * RECT_STEP).floor() / RECT_STEP) as f32;
    let low = if f64::from(low) > f64::from(start) {
        low.next_down()
    } else {
        low
    };
    let high = (end * RECT_STEP).ceil() / RECT_STEP;
    let mut len = (high - f64::from(low)) as f32;
    while f64::from(low) + f64::from(len) < end {
        len = len.next_up();
    }
    (low, len)
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

/// Two regions of one category are one mask when they are alive together for
/// at least this share of the shorter one's life ...
const SAME_MASK_LIFE: f64 = 0.8;
/// ... and their boxes share at least this share of the smaller box at every
/// key of that time.
const SAME_MASK_AREA: f32 = 0.5;

/// Joins regions that mask the same spot with the same category for most of
/// their lives (two reads of one line, such as the whole line and its tail)
/// into one region. The joined box is the bounds of both at every key, which
/// covers at least what either covered.
pub(crate) fn join_same_masks(regions: Vec<RedactionRegion>) -> Vec<RedactionRegion> {
    let mut regions = regions.into_iter().map(Some).collect::<Vec<_>>();
    for i in 0..regions.len() {
        let Some(mut joined) = regions[i].take() else {
            continue;
        };
        for slot in regions.iter_mut().skip(i + 1) {
            if let Some(other) = slot
                && same_mask(&joined, other)
            {
                joined = join(&joined, other);
                *slot = None;
            }
        }
        regions[i] = Some(joined);
    }
    regions.into_iter().flatten().collect()
}

fn same_mask(a: &RedactionRegion, b: &RedactionRegion) -> bool {
    if a.category != b.category || a.segment != b.segment {
        return false;
    }
    let (t0, t1) = (a.start.max(b.start), a.end.min(b.end));
    let shorter = (a.end - a.start).min(b.end - b.start);
    if t1 < t0 || t1 - t0 < shorter * SAME_MASK_LIFE {
        return false;
    }
    [t0, t1]
        .into_iter()
        .chain(a.keys.iter().chain(&b.keys).map(|k| k.t))
        .filter(|t| (t0..=t1).contains(t))
        .all(|t| {
            let (Some(p), Some(q)) = (a.rect_at(t), b.rect_at(t)) else {
                return false;
            };
            let w = (p.x + p.w).min(q.x + q.w) - p.x.max(q.x);
            let h = (p.y + p.h).min(q.y + q.h) - p.y.max(q.y);
            let smaller = (p.w * p.h).min(q.w * q.h);
            w > 0.0 && h > 0.0 && smaller > 0.0 && w * h >= smaller * SAME_MASK_AREA
        })
}

fn join(a: &RedactionRegion, b: &RedactionRegion) -> RedactionRegion {
    let mut times = [a.start, a.end, b.start, b.end]
        .into_iter()
        .chain(a.keys.iter().chain(&b.keys).map(|k| k.t))
        .collect::<Vec<_>>();
    times.sort_by(f64::total_cmp);
    times.dedup();
    let keys = times
        .into_iter()
        .filter_map(|t| {
            let rects = [a.rect_at(t), b.rect_at(t)];
            let mut rects = rects.iter().flatten();
            let first = *rects.next()?;
            let (mut x0, mut y0) = (first.x, first.y);
            let (mut x1, mut y1) = (first.x + first.w, first.y + first.h);
            for r in rects {
                x0 = x0.min(r.x);
                y0 = y0.min(r.y);
                x1 = x1.max(r.x + r.w);
                y1 = y1.max(r.y + r.h);
            }
            Some(RedactionKey {
                t,
                x: x0,
                y: y0,
                w: x1 - x0,
                h: y1 - y0,
            })
        })
        .collect();
    RedactionRegion {
        id: a.id.clone(),
        segment: a.segment,
        category: a.category,
        start: a.start.min(b.start),
        end: a.end.max(b.end),
        keys,
    }
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

    /// A recording's display video analysed live, frame by frame as a decode
    /// of it delivers them, gives the same segment and byte-identical regions
    /// as analysing the file. Set `CAP_REDACT_TEST_MODEL` to a model folder
    /// and `CAP_REDACT_TEST_VIDEO` to a display video; skipped without them.
    #[test]
    fn live_segment_matches_the_decoded_file() {
        let (Some(model_dir), Some(video)) = (
            std::env::var_os("CAP_REDACT_TEST_MODEL"),
            std::env::var_os("CAP_REDACT_TEST_VIDEO"),
        ) else {
            return;
        };
        let video = PathBuf::from(video);
        let mut model = OcrModel::load(Path::new(&model_dir)).unwrap();
        let offline = Analyzer::new(&mut model)
            .analyze(
                &[SegmentSource {
                    index: 0,
                    path: video.clone(),
                }],
                None,
                |_| {},
                &mut Stats::default(),
            )
            .unwrap();

        let mut frames = FrameSource::open(&video).unwrap();
        let duration = frames.duration;
        let mut live = LiveSegment::start(model, 0, frames.width, frames.height, || {}).unwrap();
        frames
            .for_each(|_, frame| {
                assert!(live.queue(frame.time, frame.video, true)?);
                Ok(true)
            })
            .unwrap();
        let result = live
            .finish(offline.segments[0].fingerprint.clone(), duration)
            .unwrap();
        assert_eq!(result.dropped, 0);
        let (segment, regions) = result.segment.unwrap();
        assert_eq!(segment, offline.segments[0]);
        assert!(!regions.is_empty());
        assert_eq!(
            serde_json::to_vec(&regions).unwrap(),
            serde_json::to_vec(&offline.regions).unwrap()
        );
    }

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

    fn region(
        id: &str,
        category: RedactCategory,
        start: f64,
        end: f64,
        x: f32,
        y: f32,
        w: f32,
    ) -> RedactionRegion {
        let at = |t| RedactionKey {
            t,
            x,
            y,
            w,
            h: 0.03,
        };
        RedactionRegion {
            id: id.into(),
            segment: 0,
            category,
            start,
            end,
            keys: vec![at(start), at(end)],
        }
    }

    #[test]
    fn a_line_and_its_tail_are_one_mask() {
        let line = region("line", RedactCategory::Secret, 1.0, 5.0, 0.1, 0.5, 0.4);
        let tail = region("tail", RedactCategory::Secret, 1.2, 5.0, 0.35, 0.505, 0.17);
        let joined = join_same_masks(vec![line.clone(), tail.clone()]);
        assert_eq!(joined.len(), 1, "{joined:?}");
        let one = &joined[0];
        assert_eq!(one.id, "line");
        assert_eq!((one.start, one.end), (1.0, 5.0));
        for t in [1.0, 1.2, 3.0, 5.0] {
            let r = one.rect_at(t).unwrap();
            for part in [&line, &tail] {
                if let Some(p) = part.rect_at(t) {
                    assert!(r.x <= p.x && r.y <= p.y, "{r:?} {p:?}");
                    assert!(r.x + r.w >= p.x + p.w - 1e-6 && r.y + r.h >= p.y + p.h - 1e-6);
                }
            }
        }
    }

    #[test]
    fn other_lines_categories_and_handoffs_stay_apart() {
        let line = region("line", RedactCategory::Secret, 1.0, 5.0, 0.1, 0.5, 0.4);
        let below = region("below", RedactCategory::Secret, 1.0, 5.0, 0.1, 0.525, 0.4);
        let other = region("other", RedactCategory::Email, 1.0, 5.0, 0.1, 0.5, 0.4);
        let next = region("next", RedactCategory::Secret, 4.9, 9.0, 0.1, 0.5, 0.4);
        assert_eq!(join_same_masks(vec![line.clone(), below]).len(), 2);
        assert_eq!(join_same_masks(vec![line.clone(), other]).len(), 2);
        assert_eq!(join_same_masks(vec![line, next]).len(), 2);
    }

    #[test]
    fn rounded_regions_only_grow_by_a_step() {
        let mut seed = 17u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            (seed >> 8) as f32 / (1u32 << 24) as f32
        };
        for _ in 0..20_000 {
            let original = RedactionKey {
                t: f64::from(next()) * 600.0,
                x: next() * 0.9,
                y: next() * 0.9,
                w: next() * 0.1,
                h: next() * 0.1,
            };
            let region = RedactionRegion {
                id: "r".into(),
                segment: 0,
                category: RedactCategory::Email,
                start: original.t,
                end: original.t + 0.5,
                keys: vec![original],
            };
            let rounded = round_region(region.clone());
            let key = rounded.keys[0];
            let right = |k: &RedactionKey| f64::from(k.x) + f64::from(k.w);
            let bottom = |k: &RedactionKey| f64::from(k.y) + f64::from(k.h);
            assert!(key.x <= original.x && key.y <= original.y);
            assert!(right(&key) >= right(&original) && bottom(&key) >= bottom(&original));
            assert!(f64::from(original.x - key.x) <= 1.01e-5);
            assert!(right(&key) - right(&original) <= 1.01e-5);
            assert!(rounded.start <= region.start && rounded.end >= region.end);
            assert!((key.t - original.t).abs() <= 0.51e-6);
            assert!(region.end - region.start <= rounded.end - rounded.start);
            let text = serde_json::to_string(&rounded).unwrap();
            let back: RedactionRegion = serde_json::from_str(&text).unwrap();
            assert_eq!(back.keys[0], key);
        }
    }

    #[test]
    fn a_scan_by_another_scanner_revision_is_not_reused() {
        let current = Redactions {
            model: "m".into(),
            scanner: crate::SCAN_REVISION,
            ..Default::default()
        };
        assert!(same_scanner(&current.clone(), &current));
        for previous in [
            Redactions {
                scanner: 0,
                ..current.clone()
            },
            Redactions {
                scanner: crate::SCAN_REVISION + 1,
                ..current.clone()
            },
            Redactions {
                model: "other".into(),
                ..current.clone()
            },
        ] {
            assert!(!same_scanner(&previous, &current));
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
