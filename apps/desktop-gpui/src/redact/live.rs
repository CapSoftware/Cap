//! Auto redact while a Studio recording runs: every frame written to a
//! segment's display video is copied out of its capture buffer and analysed
//! as it is recorded, so the editor has masks to show as soon as the
//! recording stops.
//!
//! The live result is a head start, never the recording's scan: the scan of
//! the finished files still runs, replaces it when done, and is what export
//! renders from. Live analysis never holds the recording up. Frames reach it
//! through a short hand-off from the muxer; when it falls behind (a full
//! queue, the model still loading after two seconds of frames, a frame it
//! could not copy), the recording has no head start and everything happens
//! as without live analysis.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, LazyLock, Mutex, PoisonError,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use cap_project::redaction::{REDACTIONS_VERSION, Redactions};
use cap_recording::segment_observer::{
    ScreenFrame, ScreenFrames, SegmentObservation, SegmentObserver, SegmentStart,
    screen_frame_video,
};
use cap_redact::analyze::{Drained, DrainedSegment, LiveSegment};

/// Frames between the muxer and the copy; each holds a capture buffer. The
/// muxer hands over the frames that queued while its encoder started in one
/// burst, so this holds a few.
const COPY_QUEUE: usize = 8;
/// Copied frames waiting for the analysis: about two seconds at 30 fps.
const BACKLOG: usize = 60;
/// Recording kept in memory while the model loads, before live analysis of
/// the segment gives up.
const PENDING_SECONDS: f64 = 2.0;
/// How long the end of a recording waits for its live results.
const FINISH_WAIT: Duration = Duration::from_secs(10);

static LIVE: LazyLock<Mutex<HashMap<PathBuf, Arc<LiveScan>>>> = LazyLock::new(Default::default);

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Live analysis for the Studio recording at `project`, when new recordings
/// are auto redacted and the model is installed (it is never downloaded
/// while recording). Returns the observer to give the recording.
pub(crate) fn start(project: &Path) -> Option<Arc<dyn SegmentObserver>> {
    if !crate::store::GeneralSettings::load().auto_redact_new_recordings {
        return None;
    }
    let model_dir = super::installed_model_dir()?;
    let scan = Arc::new(LiveScan {
        model_dir: model_dir.clone(),
        model: Mutex::new(ModelSlot::Loading),
        segments: Mutex::new(Segments::default()),
        segments_changed: Condvar::new(),
        attempts: AtomicU64::new(0),
    });
    let earlier = {
        let mut live = lock(&LIVE);
        // A new recording means earlier ones are over: one whose scan has not
        // taken its result by now (discarded, or stopped without a scan)
        // never will.
        let earlier = std::mem::take(&mut *live);
        live.insert(super::scan_key(project), scan.clone());
        earlier
    };
    for earlier in earlier.into_values() {
        earlier.release_model();
    }
    let loader = scan.clone();
    let spawned = std::thread::Builder::new()
        .name("cap-redact-live-model".into())
        // Normal priority: a one-off load that has to finish before the
        // recording's first two seconds of frames run out.
        .spawn(move || {
            let slot = match super::take_model(&model_dir) {
                Ok(model) => ModelSlot::Ready(Box::new(model)),
                Err(error) => {
                    tracing::warn!(%error, "Live auto redact could not load the model");
                    ModelSlot::Failed
                }
            };
            let mut current = lock(&loader.model);
            if matches!(*current, ModelSlot::Loading) {
                *current = slot;
            } else if let ModelSlot::Ready(model) = slot {
                super::keep_model(loader.model_dir.clone(), *model);
            }
        });
    if let Err(error) = spawned {
        tracing::warn!(%error, "Live auto redact could not start");
        lock(&LIVE).remove(&super::scan_key(project));
        return None;
    }
    Some(Arc::new(Observer(scan)))
}

/// Drops the live analysis of the recording at `project` (discarded, or
/// stopped without a scan).
pub(crate) fn discard(project: &Path) {
    if let Some(scan) = lock(&LIVE).remove(&super::scan_key(project)) {
        scan.release_model();
    }
}

/// Ends live analysis of the recording at `project` once its files are
/// final: waits a little for the segments still finishing and returns the
/// live result when every segment of the recording was analysed live without
/// losing a frame. It is never saved; the scan of the files replaces it.
pub(crate) fn take(project: &Path) -> Option<Redactions> {
    let scan = lock(&LIVE).remove(&super::scan_key(project))?;
    let result = scan.result(project);
    scan.release_model();
    result
}

enum ModelSlot {
    /// Loading ahead of the first frame.
    Loading,
    Ready(Box<cap_redact::OcrModel>),
    /// Taken by a segment, or handed back to the warm cache.
    Empty,
    Failed,
}

#[derive(Default)]
struct Segments {
    running: usize,
    /// Each segment attempt's analysis (segment, attempt), waiting for its
    /// finished video's length. A segment whose pipeline failed to build is
    /// tried again under the same index; its latest attempt is the one
    /// recorded.
    outcomes: Vec<(u32, u64, Option<DrainedSegment>)>,
}

struct LiveScan {
    model_dir: PathBuf,
    model: Mutex<ModelSlot>,
    segments: Mutex<Segments>,
    segments_changed: Condvar,
    attempts: AtomicU64,
}

impl LiveScan {
    /// The model for a segment: `None` while it is still loading,
    /// `Some(None)` when it cannot be had.
    fn try_take_model(&self) -> Option<Option<cap_redact::OcrModel>> {
        let mut slot = lock(&self.model);
        match std::mem::replace(&mut *slot, ModelSlot::Empty) {
            ModelSlot::Ready(model) => Some(Some(*model)),
            ModelSlot::Loading => {
                *slot = ModelSlot::Loading;
                None
            }
            ModelSlot::Failed => {
                *slot = ModelSlot::Failed;
                Some(None)
            }
            ModelSlot::Empty => {
                drop(slot);
                Some(super::take_model(&self.model_dir).ok())
            }
        }
    }

    /// A segment is done with the model: it goes to the warm cache, where the
    /// next segment or the scan at stop picks it up.
    fn give_back(&self, model: cap_redact::OcrModel) {
        super::keep_model(self.model_dir.clone(), model);
    }

    /// Hands a model loaded ahead but never used to the warm cache.
    fn release_model(&self) {
        let mut slot = lock(&self.model);
        if let ModelSlot::Ready(model) = std::mem::replace(&mut *slot, ModelSlot::Empty) {
            super::keep_model(self.model_dir.clone(), *model);
        }
    }

    fn record(&self, index: u32, attempt: u64, outcome: Option<DrainedSegment>) {
        let mut segments = lock(&self.segments);
        segments.running -= 1;
        segments.outcomes.push((index, attempt, outcome));
        self.segments_changed.notify_all();
    }

    fn result(&self, project: &Path) -> Option<Redactions> {
        let sources = cap_redact::segment_sources(project).ok()?;
        let deadline = Instant::now() + FINISH_WAIT;
        let mut segments = lock(&self.segments);
        while segments.running > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                tracing::info!("Live auto redact did not finish in time");
                return None;
            }
            segments = self
                .segments_changed
                .wait_timeout(segments, left)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        let mut outcomes = std::mem::take(&mut segments.outcomes);
        drop(segments);
        let mut redactions = Redactions {
            version: REDACTIONS_VERSION,
            model: super::model_version(Some(&self.model_dir)),
            scanner: cap_redact::SCAN_REVISION,
            segments: Vec::new(),
            regions: Vec::new(),
        };
        for source in &sources {
            let latest = outcomes
                .iter()
                .enumerate()
                .filter(|(_, (index, _, _))| *index == source.index)
                .max_by_key(|(_, (_, attempt, _))| *attempt)
                .map(|(at, _)| at);
            let drained = latest.and_then(|at| outcomes.swap_remove(at).2);
            let Some(drained) = drained else {
                tracing::info!(
                    segment = source.index,
                    "Live auto redact has no complete result for a segment"
                );
                return None;
            };
            // Closed with the finished video's length, as a scan of the file
            // would, so the last frame's masks end with the video.
            let duration = cap_redact::frames::video_duration(&source.path);
            match drained.close(String::new(), duration).0 {
                // The muxer can still drop a frame after handing it over (its
                // encoder queue full): the result only stands when it saw the
                // frames the video holds.
                Ok((segment, _))
                    if cap_redact::frames::video_frame_count(&source.path)
                        != Some(segment.source_frames) =>
                {
                    tracing::info!(
                        segment = source.index,
                        "Live auto redact saw frames the video does not hold"
                    );
                    return None;
                }
                Ok((segment, regions)) => {
                    redactions.segments.push(segment);
                    redactions.regions.extend(regions);
                }
                Err(error) => {
                    tracing::warn!(%error, "Live auto redact failed on a segment");
                    return None;
                }
            }
        }
        tracing::info!(
            segments = redactions.segments.len(),
            regions = redactions.regions.len(),
            "Live auto redact has a head start for the scan"
        );
        Some(redactions)
    }
}

struct Observer(Arc<LiveScan>);

impl SegmentObserver for Observer {
    fn segment_started(&self, start: SegmentStart) -> Box<dyn SegmentObservation> {
        let (frame_tx, frame_rx) = mpsc::sync_channel(COPY_QUEUE);
        let frames = Arc::new(Frames {
            tx: Mutex::new(Some(frame_tx)),
            dropped: AtomicU64::new(0),
            missed: AtomicU64::new(0),
            started: Instant::now(),
            first_drop_ms: AtomicU64::new(u64::MAX),
        });
        lock(&self.0.segments).running += 1;
        let index = start.index;
        let attempt = self.0.attempts.fetch_add(1, Ordering::Relaxed);
        // Started here, at the recording thread's priority: a thread inherits
        // the priority of the thread that creates it, and the analysis thread
        // lowers its own.
        let copy = match Copier::start(frame_rx) {
            Ok(copy) => copy,
            Err(error) => {
                tracing::warn!(%error, "Live auto redact could not start its copy");
                self.0.record(index, attempt, None);
                *lock(&frames.tx) = None;
                return Box::new(Observation(frames));
            }
        };
        let scan = self.0.clone();
        let worker_frames = frames.clone();
        let spawned = std::thread::Builder::new()
            .name("cap-redact-live".into())
            .spawn(move || {
                crate::transcription::refine::lower_thread_priority();
                let outcome = analyse_segment(&scan, index, copy, &worker_frames);
                scan.record(index, attempt, outcome);
            });
        if let Err(error) = spawned {
            tracing::warn!(%error, "Live auto redact could not start a segment");
            self.0.record(index, attempt, None);
            *lock(&frames.tx) = None;
        }
        Box::new(Observation(frames))
    }
}

/// Between the muxer and a segment's analysis thread.
struct Frames {
    tx: Mutex<Option<mpsc::SyncSender<(ScreenFrame, Duration)>>>,
    dropped: AtomicU64,
    missed: AtomicU64,
    started: Instant,
    /// Milliseconds into the segment of the first frame the copy missed.
    first_drop_ms: AtomicU64,
}

impl ScreenFrames for Frames {
    fn frame(&self, frame: &ScreenFrame, timestamp: Duration) {
        use cap_recording::VideoFrame;
        let tx = lock(&self.tx);
        let Some(tx) = tx.as_ref() else {
            return;
        };
        let sent = frame
            .duplicate()
            .is_some_and(|frame| tx.try_send((frame, timestamp)).is_ok());
        if !sent {
            self.dropped.fetch_add(1, Ordering::Relaxed);
            let at = self.started.elapsed().as_millis() as u64;
            self.first_drop_ms.fetch_min(at, Ordering::Relaxed);
        }
    }

    fn missed(&self, frames: u64) {
        self.missed.fetch_add(frames, Ordering::Relaxed);
    }
}

struct Observation(Arc<Frames>);

impl SegmentObservation for Observation {
    /// Closes the hand-off and returns at once, so stopping is never held up;
    /// the analysis thread finishes on its own and `take` waits for it once
    /// the recording's files are final.
    fn stop(self: Box<Self>) {
        *lock(&self.0.tx) = None;
    }

    fn screen_frames(&self) -> Option<Arc<dyn ScreenFrames>> {
        Some(self.0.clone())
    }
}

/// The copy runs on its own thread so a capture buffer goes back as soon as
/// its pixels are out, whatever the analysis is doing; copied frames wait in
/// a backlog of about two seconds.
struct Copier {
    rx: mpsc::Receiver<(f64, ffmpeg::frame::Video)>,
    give_up: Arc<AtomicBool>,
    backlog_drops: Arc<AtomicU64>,
    read_failed: Arc<AtomicBool>,
    thread: std::thread::JoinHandle<()>,
}

impl Copier {
    fn start(frame_rx: mpsc::Receiver<(ScreenFrame, Duration)>) -> std::io::Result<Self> {
        let (copied_tx, rx) = mpsc::sync_channel::<(f64, ffmpeg::frame::Video)>(BACKLOG);
        let give_up = Arc::new(AtomicBool::new(false));
        let backlog_drops = Arc::new(AtomicU64::new(0));
        let read_failed = Arc::new(AtomicBool::new(false));
        let thread = {
            let give_up = give_up.clone();
            let backlog_drops = backlog_drops.clone();
            let read_failed = read_failed.clone();
            std::thread::Builder::new()
                .name("cap-redact-live-copy".into())
                .spawn(move || {
                    let mut first = None;
                    for (frame, timestamp) in frame_rx.iter() {
                        if give_up.load(Ordering::Relaxed) {
                            continue;
                        }
                        let video = match screen_frame_video(&frame) {
                            Ok(video) => video,
                            Err(error) => {
                                tracing::warn!(%error, "Live auto redact could not read a frame");
                                read_failed.store(true, Ordering::Relaxed);
                                give_up.store(true, Ordering::Relaxed);
                                continue;
                            }
                        };
                        drop(frame);
                        let first = *first.get_or_insert(timestamp);
                        let time = timestamp.saturating_sub(first).as_secs_f64();
                        if copied_tx.try_send((time, video)).is_err() {
                            backlog_drops.fetch_add(1, Ordering::Relaxed);
                            give_up.store(true, Ordering::Relaxed);
                        }
                    }
                })?
        };
        Ok(Self {
            rx,
            give_up,
            backlog_drops,
            read_failed,
            thread,
        })
    }
}

/// Analyses one segment's frames as they arrive; `None` when the recording
/// gets no head start because of this segment.
fn analyse_segment(
    scan: &LiveScan,
    index: u32,
    copy: Copier,
    frames: &Frames,
) -> Option<DrainedSegment> {
    let Copier {
        rx: copied_rx,
        give_up,
        backlog_drops,
        read_failed,
        thread: copier,
    } = copy;

    let mut pending = VecDeque::new();
    let mut live: Option<LiveSegment> = None;
    let mut model_failed = false;
    let mut model_wait = false;
    for (time, video) in copied_rx.iter() {
        if give_up.load(Ordering::Relaxed) {
            continue;
        }
        if live.is_none() && !model_failed {
            match scan.try_take_model() {
                Some(Some(model)) => {
                    match LiveSegment::start(model, index, video.width(), video.height(), || {
                        crate::transcription::refine::lower_thread_priority();
                    }) {
                        Ok(segment) => live = Some(segment),
                        Err(error) => {
                            tracing::warn!(%error, "Live auto redact could not start");
                            model_failed = true;
                        }
                    }
                }
                Some(None) => model_failed = true,
                None => {}
            }
        }
        match &mut live {
            Some(segment) => {
                pending.push_back((time, video));
                while let Some((time, video)) = pending.pop_front() {
                    if !segment.push(time, video).unwrap_or(false) {
                        give_up.store(true, Ordering::Relaxed);
                        break;
                    }
                }
            }
            None if model_failed => give_up.store(true, Ordering::Relaxed),
            None => {
                pending.push_back((time, video));
                if pending
                    .front()
                    .is_some_and(|(start, _)| time - start > PENDING_SECONDS)
                {
                    model_wait = true;
                    give_up.store(true, Ordering::Relaxed);
                }
            }
        }
        if give_up.load(Ordering::Relaxed) {
            pending.clear();
        }
    }
    let _ = copier.join();
    let copy_drops = frames.dropped.load(Ordering::Relaxed);
    let first_drop_ms =
        Some(frames.first_drop_ms.load(Ordering::Relaxed)).filter(|ms| *ms != u64::MAX);
    let missed = frames.missed.load(Ordering::Relaxed);
    let backlog_drops = backlog_drops.load(Ordering::Relaxed);
    let read_failed = read_failed.load(Ordering::Relaxed);
    let lost = give_up.load(Ordering::Relaxed) || copy_drops > 0 || missed > 0;
    let Some(live) = live else {
        tracing::info!(
            segment = index,
            copy_drops,
            first_drop_ms = ?first_drop_ms,
            backlog_drops,
            missed,
            model_wait,
            model_failed,
            read_failed,
            "Live auto redact did not start on the segment; no head start for the recording"
        );
        return None;
    };
    let drained = if lost {
        live.cancel()
            .map(|result| (result.model, None, result.dropped))
    } else {
        live.drain().map(
            |Drained {
                 model,
                 segment,
                 dropped,
             }| (model, Some(segment), dropped),
        )
    };
    let (model, segment, dropped) = match drained {
        Ok(drained) => drained,
        Err(error) => {
            tracing::warn!(%error, "Live auto redact stopped unexpectedly");
            return None;
        }
    };
    scan.give_back(model);
    let segment = segment.filter(|_| dropped == 0);
    let Some(segment) = segment else {
        tracing::info!(
            segment = index,
            copy_drops,
            first_drop_ms = ?first_drop_ms,
            backlog_drops,
            missed,
            analysis_drops = dropped,
            model_wait,
            model_failed,
            read_failed,
            "Live auto redact fell behind; no head start for the recording"
        );
        return None;
    };
    tracing::info!(
        segment = index,
        frames = segment.stats().frames,
        "Live auto redact analysed the segment as it was recorded"
    );
    Some(segment)
}
