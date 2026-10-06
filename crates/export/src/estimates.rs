use std::{
    collections::{VecDeque, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_editor::{EditorInstance, SegmentMedia};
use cap_enc_ffmpeg::{EncodedPacket, EncodedPacketStats};
use cap_project::ProjectConfiguration;
use cap_rendering::FrameWindows;
use serde::Serialize;
use specta::Type;

use crate::{
    ExporterBase, make_cursor_only_project, prepare_project_for_export, settings::ExportSettings,
    synthesize_default_timeline,
};

#[derive(Clone, Debug, Serialize, Type)]
pub struct ExportEstimates {
    pub duration_seconds: f64,
    pub estimated_time_seconds: f64,
    pub estimated_size_mb: f64,
    pub time_range_seconds: [f64; 2],
    pub size_range_mb: [f64; 2],
}

pub(crate) struct SampleTiming {
    frames: Mutex<Vec<(u32, Instant)>>,
    cancelled: AtomicBool,
    packets: Arc<EncodedPacketStats>,
    _temporary_files: Arc<tempfile::TempDir>,
}

impl SampleTiming {
    pub(crate) fn record_frame(&self, frame_number: u32) {
        if let Ok(mut frames) = self.frames.lock() {
            frames.push((frame_number, Instant::now()));
        }
    }

    pub(crate) fn packet_stats(&self) -> Arc<EncodedPacketStats> {
        self.packets.clone()
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

struct SampleGuard(Arc<SampleTiming>);

impl Drop for SampleGuard {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

async fn wait_for_stop(editor: &EditorInstance, cancel: &AtomicBool, deadline: Instant) {
    while !cancel.load(Ordering::Acquire)
        && !editor.export_active.load(Ordering::Acquire)
        && Instant::now() < deadline
    {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

struct CachedEstimate {
    key: u64,
    created: Instant,
    estimate: ExportEstimates,
}

static CACHE: LazyLock<Mutex<VecDeque<CachedEstimate>>> = LazyLock::new(Mutex::default);
static SAMPLING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

struct PreviewGuard<'a>(&'a AtomicBool);

impl Drop for PreviewGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameTiming {
    Steady,
    GopAmortized,
    Amortized,
}

#[derive(Clone, Copy, Debug)]
struct SamplePlan {
    windows: u32,
    window_frames: u32,
    leading_window: bool,
    timing: FrameTiming,
    keyframe_interval: Option<u32>,
}

struct PassMeasurement<'a> {
    windows: &'a FrameWindows,
    frames: &'a [(u32, Instant)],
    packets: &'a [EncodedPacket],
    started: Instant,
    elapsed_seconds: Option<f64>,
    bytes: Option<f64>,
    plan: SamplePlan,
    total_frames: u32,
    duration_seconds: f64,
}

const WARMUP_FRAMES: usize = 8;
// libx264 accepts ~20 frames (lookahead plus one per frame thread) before
// its input cadence reflects throughput, and the expensive frame after a
// jump between windows surfaces that late as well.
const X264_WARMUP_FRAMES: usize = 30;
const MIN_STEADY_INTERVALS: usize = 6;

pub async fn estimate_export(
    editor: Arc<EditorInstance>,
    project: ProjectConfiguration,
    settings: ExportSettings,
    cancel: Arc<AtomicBool>,
    mut on_estimate: impl FnMut(ExportEstimates) + Send,
) -> Result<ExportEstimates, String> {
    if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
        return Err("Export estimate cancelled".into());
    }
    if settings.fps() == 0 || settings.fps() > 120 {
        return Err("Invalid export frame rate".into());
    }
    let resolution = match settings {
        ExportSettings::Mp4(settings) => settings.resolution_base,
        ExportSettings::Gif(settings) => settings.resolution_base,
        ExportSettings::Mov(settings) => settings.resolution_base,
    };
    if resolution.x == 0 || resolution.y == 0 {
        return Err("Invalid export resolution".into());
    }
    let mut project = prepare_project_for_export(project);
    if settings.cursor_only() {
        project = make_cursor_only_project(project);
    }
    synthesize_default_timeline(&mut project, &editor.recordings);
    cap_project::synchronize_legacy_keyboard(editor.meta(), &mut project);
    cap_project::synchronize_captions(
        &mut project,
        &editor
            .recordings
            .segments
            .iter()
            .map(|segment| segment.display.duration)
            .collect::<Vec<_>>(),
    );
    let duration = project
        .timeline
        .as_ref()
        .map_or(0.0, |timeline| timeline.duration());
    if !duration.is_finite() || duration <= 0.0 {
        return Err("No frames to estimate".into());
    }
    if project.timeline.as_ref().is_some_and(|timeline| {
        timeline
            .segments
            .iter()
            .any(|segment| segment.recording_clip as usize >= editor.segment_medias.len())
    }) {
        return Err("An export clip is still preparing".into());
    }
    let total_frames = (duration * f64::from(settings.fps())).ceil() as u32;
    let mut hasher = DefaultHasher::new();
    editor.project_path.hash(&mut hasher);
    serde_json::to_vec(&(&project, settings))
        .map_err(|error| error.to_string())?
        .hash(&mut hasher);
    let key = hasher.finish();
    if let Ok(cache) = CACHE.lock()
        && let Some(cached) = cache
            .iter()
            .find(|cached| cached.key == key && cached.created.elapsed() < Duration::from_secs(300))
    {
        return Ok(cached.estimate.clone());
    }
    let _sampling = loop {
        if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
            return Err("Export estimate cancelled".into());
        }
        tokio::select! {
            permit = SAMPLING.acquire() => break permit.map_err(|error| error.to_string())?,
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    };
    if editor.export_active.load(Ordering::Acquire) || cancel.load(Ordering::Acquire) {
        return Err("Export estimate cancelled".into());
    }
    editor
        .export_preview_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Export preview is busy")?;
    let _guard = PreviewGuard(&editor.export_preview_active);
    let deadline = Instant::now() + Duration::from_secs(20);
    while editor.segment_medias.iter().any(|segment| {
        !segment.audio.progress().complete || !segment.system_audio.progress().complete
    }) {
        if editor.segment_medias.iter().any(|segment| {
            segment.audio.progress().error.is_some()
                || segment.system_audio.progress().error.is_some()
        }) {
            return Err("Audio is unavailable for export estimation".into());
        }
        tokio::select! {
            _ = wait_for_stop(&editor, &cancel, deadline) => return Err("Export estimate cancelled or timed out".into()),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }

    let temp = Arc::new(
        tempfile::Builder::new()
            .prefix("cap-export-estimate-")
            .tempdir()
            .map_err(|error| error.to_string())?,
    );
    let setup_started = Instant::now();
    let render_constants = tokio::select! {
        _ = wait_for_stop(&editor, &cancel, deadline) => return Err("Export estimate cancelled or timed out".into()),
        result = cap_rendering::RenderVideoConstants::new(
            &editor.recordings.segments,
            editor.meta().clone(),
            editor.meta().studio_meta().ok_or("Cannot estimate this recording")?.clone(),
        ) => Arc::new(result.map_err(|error| error.to_string())?),
    };
    let sample_medias = tokio::select! {
        _ = wait_for_stop(&editor, &cancel, deadline) => return Err("Export estimate cancelled or timed out".into()),
        result = cap_editor::create_segments_without_audio(
        editor.meta(),
        editor.meta().studio_meta().ok_or("Cannot estimate this recording")?,
        settings.force_ffmpeg_decoder(),
    ) => result?,
    };
    if sample_medias.len() != editor.segment_medias.len() {
        return Err("Recording sources changed during export estimation".into());
    }
    let setup_seconds = setup_started.elapsed().as_secs_f64();
    let plan = sample_plan(settings);
    let windows = sample_windows(
        total_frames,
        plan.window_frames,
        plan.windows,
        plan.leading_window,
    );
    let timing = Arc::new(SampleTiming {
        frames: Mutex::default(),
        cancelled: AtomicBool::new(false),
        packets: Arc::default(),
        _temporary_files: temp.clone(),
    });
    let _sample_guard = SampleGuard(timing.clone());
    let base = ExporterBase {
        project_path: editor.project_path.clone(),
        recording_meta: editor.meta().clone(),
        project_config: project.clone(),
        studio_meta: editor
            .meta()
            .studio_meta()
            .ok_or("Cannot estimate this recording")?
            .clone(),
        recordings: editor.recordings.clone(),
        render_constants: render_constants.clone(),
        segments: editor
            .segment_medias
            .iter()
            .zip(&sample_medias)
            .map(|(segment, sample)| SegmentMedia {
                audio: segment.audio.clone(),
                system_audio: segment.system_audio.clone(),
                audio_timing_repair: segment.audio_timing_repair,
                cursor: segment.cursor.clone(),
                keyboard: segment.keyboard.clone(),
                decoders: sample.decoders.clone(),
            })
            .collect(),
        output_path: temp.path().join("sample.mp4"),
        streaming_audio: None,
        streaming_output: None,
        audio_cancellation: None,
        sample_windows: Some(windows.clone()),
        sample_timing: Some(timing.clone()),
    };
    let progress_editor = editor.clone();
    let progress_cancel = cancel.clone();
    let on_progress = move |_| {
        !progress_cancel.load(Ordering::Acquire)
            && !progress_editor.export_active.load(Ordering::Acquire)
            && Instant::now() < deadline
    };
    let started = Instant::now();
    let export = async {
        match settings {
            ExportSettings::Mp4(settings) => settings.export(base, on_progress).await,
            ExportSettings::Gif(settings) => settings.export(base, on_progress).await,
            ExportSettings::Mov(settings) => settings.export(base, on_progress).await,
        }
    };
    tokio::pin!(export);
    let summarize = |measurement: &PassMeasurement| -> Result<ExportEstimates, String> {
        let mut estimate = summarize_pass(measurement)?;
        estimate.estimated_time_seconds += setup_seconds;
        for seconds in &mut estimate.time_range_seconds {
            *seconds += setup_seconds;
        }
        Ok(estimate)
    };
    let mut interim: Option<(usize, ExportEstimates)> = None;
    let mut ticker = tokio::time::interval(Duration::from_millis(150));
    let path = loop {
        tokio::select! {
            _ = wait_for_stop(&editor, &cancel, deadline) => {
                if let Some((_, estimate)) = interim
                    && !cancel.load(Ordering::Acquire)
                    && !editor.export_active.load(Ordering::Acquire)
                {
                    return Ok(estimate);
                }
                return Err("Export estimate cancelled or timed out".into());
            }
            result = &mut export => break result?,
            _ = ticker.tick() => {
                if plan.timing == FrameTiming::Amortized {
                    continue;
                }
                let frames = timing.frames.lock().map_err(|error| error.to_string())?.clone();
                let completed = completed_windows(&windows, &frames);
                if completed > 0 && interim.as_ref().is_none_or(|(reported, _)| completed > *reported) {
                    let packets = timing.packets.snapshot();
                    let estimate = summarize(&PassMeasurement {
                        windows: &windows,
                        frames: &frames,
                        packets: &packets,
                        started,
                        elapsed_seconds: None,
                        bytes: None,
                        plan,
                        total_frames,
                        duration_seconds: duration,
                    })?;
                    on_estimate(estimate.clone());
                    interim = Some((completed, estimate));
                }
            }
        }
    };
    let elapsed = started.elapsed().as_secs_f64();
    let frames = timing
        .frames
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if frames.len() != windows.len() as usize {
        return Err("Export sample did not render every frame".into());
    }
    let bytes = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len() as f64;
    let packets = timing.packets.snapshot();
    tracing::debug!(
        windows = ?windows.windows(),
        elapsed_seconds = elapsed,
        bytes,
        video_packets = packets.len(),
        key_packets = packets.iter().filter(|packet| packet.key).count(),
        packet_bytes = ?packets
            .iter()
            .map(|packet| if packet.key { -(packet.bytes as i64) } else { packet.bytes as i64 })
            .collect::<Vec<_>>(),
        intervals_ms = ?frames
            .windows(2)
            .map(|pair| pair[1].1.saturating_duration_since(pair[0].1).as_millis())
            .collect::<Vec<_>>(),
        "Measured export sample"
    );
    if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
        return Err("Export estimate cancelled".into());
    }
    let estimate = summarize(&PassMeasurement {
        windows: &windows,
        frames: &frames,
        packets: &packets,
        started,
        elapsed_seconds: Some(elapsed),
        bytes: Some(bytes),
        plan,
        total_frames,
        duration_seconds: duration,
    })?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.retain(|cached| cached.key != key);
        cache.push_back(CachedEstimate {
            key,
            created: Instant::now(),
            estimate: estimate.clone(),
        });
        while cache.len() > 8 {
            let _ = cache.pop_front();
        }
    }
    Ok(estimate)
}

// Hardware H.264 sessions reach a steady cadence after a handful of frames,
// so several short windows spread over the timeline capture zoom, camera and
// scene variation cheaply. libx264 (optimize_filesize) stalls once per GOP
// on its keyframe decision, so each window spans a whole GOP after the
// warm-up and is timed by amortising over that span. gifski buffers ~30
// frames before its input cadence reflects throughput and finishes the
// remainder on `finish`, so only one long window timed end-to-end is honest.
fn sample_plan(settings: ExportSettings) -> SamplePlan {
    let fps = settings.fps();
    let keyframe_interval = keyframe_interval_frames(settings);
    match settings {
        ExportSettings::Gif(_) => SamplePlan {
            windows: 1,
            window_frames: 60,
            leading_window: false,
            timing: FrameTiming::Amortized,
            keyframe_interval,
        },
        ExportSettings::Mp4(settings) if settings.optimize_filesize => SamplePlan {
            windows: 3,
            window_frames: keyframe_interval.unwrap_or(fps * 2) + X264_WARMUP_FRAMES as u32,
            leading_window: false,
            timing: FrameTiming::GopAmortized,
            keyframe_interval,
        },
        ExportSettings::Mp4(_) | ExportSettings::Mov(_) => SamplePlan {
            windows: 4,
            window_frames: (fps / 2).max(32),
            leading_window: true,
            timing: FrameTiming::Steady,
            keyframe_interval,
        },
    }
}

fn keyframe_interval_frames(settings: ExportSettings) -> Option<u32> {
    match settings {
        ExportSettings::Mp4(settings) => Some(
            (f64::from(cap_enc_ffmpeg::h264::DEFAULT_KEYFRAME_INTERVAL_SECS)
                * f64::from(settings.fps))
            .round()
            .max(1.0) as u32,
        ),
        ExportSettings::Gif(_) | ExportSettings::Mov(_) => None,
    }
}

// Windows are centred in equal strata of the timeline. A leading window at
// frame 0 opens the pass without a decoder seek and absorbs the hardware
// encoder's warm-up GOP; libx264 windows stay spread because CRF sizes
// depend on content and recordings often open on a static screen.
fn sample_windows(
    total_frames: u32,
    window_frames: u32,
    window_count: u32,
    leading_window: bool,
) -> FrameWindows {
    let count = window_frames.max(2);
    let windows = window_count.max(1);
    if total_frames <= count.saturating_mul(windows) {
        return FrameWindows::all(total_frames);
    }
    let leading = (leading_window && windows > 1).then_some(0..count);
    let spread = if leading.is_some() {
        windows - 1
    } else {
        windows
    };
    FrameWindows::new(
        leading
            .into_iter()
            .chain((0..spread).map(|index| {
                let stratum = total_frames / spread;
                let start = index * stratum + (stratum - count) / 2;
                start..start + count
            }))
            .collect(),
    )
}

// Frames are recorded in encode order, so window k's frames are the run that
// follows the runs of windows 0..k. A window counts as complete once every
// one of its frames has been encoded.
fn window_runs<'a>(
    windows: &FrameWindows,
    frames: &'a [(u32, Instant)],
) -> Vec<&'a [(u32, Instant)]> {
    let mut runs = Vec::new();
    let mut offset = 0usize;
    for window in windows.windows() {
        let len = (window.end - window.start) as usize;
        let Some(run) = frames.get(offset..offset + len) else {
            break;
        };
        runs.push(run);
        offset += len;
    }
    runs
}

fn completed_windows(windows: &FrameWindows, frames: &[(u32, Instant)]) -> usize {
    window_runs(windows, frames).len()
}

// The renderer runs ahead by the channel depth before the encoder opens and
// a jump between windows re-seeks the decoders, so the first intervals of a
// window are not representative, and the final frames of the pass flush
// faster than steady state. Spikes inside the span stay in: decoding a
// source keyframe stalls the pipeline every source GOP, and a real export
// pays that just as often.
fn steady_frame_time(run: &[(u32, Instant)]) -> Option<f64> {
    span_frame_time(run, WARMUP_FRAMES, 2)
}

fn span_frame_time(run: &[(u32, Instant)], skip_first: usize, skip_last: usize) -> Option<f64> {
    let span = run.get(skip_first..run.len().saturating_sub(skip_last))?;
    (span.len() > MIN_STEADY_INTERVALS).then(|| {
        span[span.len() - 1]
            .1
            .saturating_duration_since(span[0].1)
            .as_secs_f64()
            / (span.len() - 1) as f64
    })
}

fn gop_frame_time(run: &[(u32, Instant)]) -> Option<f64> {
    span_frame_time(run, X264_WARMUP_FRAMES, 0)
}

fn window_frame_time(run: &[(u32, Instant)], timing: FrameTiming) -> Option<f64> {
    match timing {
        FrameTiming::Steady => steady_frame_time(run),
        FrameTiming::GopAmortized => gop_frame_time(run),
        FrameTiming::Amortized => None,
    }
}

fn pass_end(frames: &[(u32, Instant)], started: Instant, elapsed_seconds: Option<f64>) -> Instant {
    elapsed_seconds.map_or_else(
        || frames.last().map_or(started, |(_, at)| *at),
        |elapsed| started + Duration::from_secs_f64(elapsed),
    )
}

fn amortized_frame_time(
    frames: &[(u32, Instant)],
    started: Instant,
    elapsed_seconds: Option<f64>,
) -> f64 {
    let first = frames.first().map_or(started, |(_, at)| *at);
    pass_end(frames, started, elapsed_seconds)
        .saturating_duration_since(first)
        .as_secs_f64()
        / frames.len().saturating_sub(1).max(1) as f64
}

// A real export pays the pipeline start-up and the final flush once; the
// seeks between sample windows are not part of it, so the fixed cost is
// measured around the sampled frames rather than as the whole pass.
fn fixed_seconds(frames: &[(u32, Instant)], started: Instant, elapsed_seconds: Option<f64>) -> f64 {
    let (Some((_, first)), Some((_, last))) = (frames.first(), frames.last()) else {
        return elapsed_seconds.unwrap_or(0.0);
    };
    first.saturating_duration_since(started).as_secs_f64()
        + pass_end(frames, started, elapsed_seconds)
            .saturating_duration_since(*last)
            .as_secs_f64()
}

struct VideoSizeModel {
    key_spacing: f64,
    key_bytes: f64,
    delta_bytes: f64,
}

impl VideoSizeModel {
    // Encoders given an explicit GOP (libx264, NVENC, QSV, AMF, MF) follow it,
    // and a second keyframe inside a short window there is a one-off scene cut
    // that must not be extrapolated across the timeline. VideoToolbox is not
    // given a GOP and emits keyframes on FFmpeg's default 12-frame cadence,
    // which shows as a measured spacing far below the configured interval;
    // its rate control also over-spends on the first GOP of a fresh session
    // (a real export shows the same fat first GOP), so only packets from the
    // second keyframe onward describe the rest of the file. The first packet
    // after a jump between windows carries a whole new picture and is skipped.
    fn fit(
        packets: &[EncodedPacket],
        window_starts: &[usize],
        keyframe_interval: Option<u32>,
    ) -> Option<Self> {
        let keys: Vec<usize> = packets
            .iter()
            .enumerate()
            .filter_map(|(index, packet)| packet.key.then_some(index))
            .collect();
        let measured = (keys.len() >= 2)
            .then(|| (keys[keys.len() - 1] - keys[0]) as f64 / (keys.len() - 1) as f64);
        let configured = keyframe_interval
            .filter(|interval| *interval > 1)
            .map(f64::from);
        let (key_spacing, skip_first_gop) = match (measured, configured) {
            (Some(measured), Some(configured)) if measured * 2.0 <= configured => (measured, true),
            (_, Some(configured)) => (configured, false),
            (Some(measured), None) => (measured, false),
            (None, None) => return None,
        };
        let first_considered = if skip_first_gop { keys[1] } else { 0 };
        let (key_count, key_bytes, delta_count, delta_bytes) = packets
            .iter()
            .enumerate()
            .filter(|(index, _)| {
                *index >= first_considered && (*index == 0 || !window_starts.contains(index))
            })
            .fold(
                (0u64, 0u64, 0u64, 0u64),
                |(keys, key_bytes, deltas, delta_bytes), (_, packet)| {
                    if packet.key {
                        (keys + 1, key_bytes + packet.bytes, deltas, delta_bytes)
                    } else {
                        (keys, key_bytes, deltas + 1, delta_bytes + packet.bytes)
                    }
                },
            );
        if key_count == 0 {
            return None;
        }
        Some(Self {
            key_spacing,
            key_bytes: key_bytes as f64 / key_count as f64,
            delta_bytes: if delta_count > 0 {
                delta_bytes as f64 / delta_count as f64
            } else {
                0.0
            },
        })
    }

    fn bytes_for(&self, total_frames: f64) -> f64 {
        let keys = (total_frames / self.key_spacing.max(1.0))
            .ceil()
            .min(total_frames);
        self.key_bytes * keys + self.delta_bytes * (total_frames - keys)
    }
}

fn summarize_pass(measurement: &PassMeasurement) -> Result<ExportEstimates, String> {
    let PassMeasurement {
        windows,
        frames,
        packets,
        started,
        elapsed_seconds,
        bytes,
        plan,
        total_frames,
        duration_seconds,
    } = *measurement;
    let runs = window_runs(windows, frames);
    if runs.is_empty() || total_frames == 0 {
        return Err("Export estimate unavailable".into());
    }
    let sampled_frames = windows.len();
    let total = f64::from(total_frames);
    if sampled_frames == total_frames
        && let (Some(elapsed), Some(bytes)) = (elapsed_seconds, bytes)
    {
        let size = bytes / (1024.0 * 1024.0);
        return Ok(ExportEstimates {
            duration_seconds,
            estimated_time_seconds: elapsed,
            estimated_size_mb: size,
            time_range_seconds: [elapsed, elapsed],
            size_range_mb: [size, size],
        });
    }
    let measured_frames: usize = runs.iter().map(|run| run.len()).sum();
    let measured_run = &frames[..measured_frames];
    let fixed = fixed_seconds(measured_run, started, elapsed_seconds);
    let frame_times: Vec<f64> = runs
        .iter()
        .filter_map(|run| window_frame_time(run, plan.timing))
        .collect();
    let times: Vec<f64> = if frame_times.is_empty() {
        vec![fixed + amortized_frame_time(measured_run, started, elapsed_seconds) * total]
    } else {
        frame_times
            .iter()
            .map(|seconds_per_frame| fixed + seconds_per_frame * total)
            .collect()
    };
    let window_starts: Vec<usize> = runs
        .iter()
        .scan(0usize, |offset, run| {
            let start = *offset;
            *offset += run.len();
            Some(start)
        })
        .collect();
    let considered_packets = &packets[..packets.len().min(measured_frames)];
    let video_bytes: f64 = considered_packets
        .iter()
        .map(|packet| packet.bytes as f64)
        .sum();
    let measured = measured_frames as f64;
    let other_per_frame = bytes.map_or(0.0, |bytes| (bytes - video_bytes).max(0.0) / measured);
    let pooled = VideoSizeModel::fit(considered_packets, &window_starts, plan.keyframe_interval);
    let linear = || video_bytes / measured * total;
    let size = pooled
        .as_ref()
        .map_or_else(linear, |model| model.bytes_for(total))
        + other_per_frame * total;
    let sizes: Vec<f64> = if pooled.is_some() {
        window_starts
            .iter()
            .zip(&runs)
            .filter_map(|(start, run)| {
                let window_packets = considered_packets
                    .get(*start..(start + run.len()).min(considered_packets.len()))?;
                VideoSizeModel::fit(window_packets, &[], plan.keyframe_interval).map(|model| {
                    (model.bytes_for(total) + other_per_frame * total) / (1024.0 * 1024.0)
                })
            })
            .collect()
    } else {
        vec![size / (1024.0 * 1024.0)]
    };
    let size_mb = size / (1024.0 * 1024.0);
    let spread = |values: &[f64], center: f64| {
        let mean = values.iter().sum::<f64>() / values.len().max(1) as f64;
        let deviation = (values
            .iter()
            .map(|value| (value - mean).powi(2))
            .sum::<f64>()
            / values.len().saturating_sub(1).max(1) as f64)
            .sqrt();
        [
            values
                .iter()
                .copied()
                .fold(center - deviation, f64::min)
                .max(0.0),
            values.iter().copied().fold(center + deviation, f64::max),
        ]
    };
    let time = times.iter().sum::<f64>() / times.len() as f64;
    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds: time,
        estimated_size_mb: size_mb,
        time_range_seconds: spread(&times, time),
        size_range_mb: if sizes.is_empty() {
            [size_mb, size_mb]
        } else {
            spread(&sizes, size_mb)
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(bytes: u64, key: bool) -> EncodedPacket {
        EncodedPacket { bytes, key }
    }

    fn run(start: u32, intervals_ms: &[u64]) -> Vec<(u32, Instant)> {
        let started = Instant::now();
        let mut at = started;
        std::iter::once((start, started))
            .chain(intervals_ms.iter().enumerate().map(|(index, interval)| {
                at += Duration::from_millis(*interval);
                (start + index as u32 + 1, at)
            }))
            .collect()
    }

    #[test]
    fn steady_timing_skips_the_channel_burst_and_the_flush_but_keeps_stalls() {
        let mut intervals = vec![1u64; WARMUP_FRAMES - 1];
        intervals.extend([7, 7, 7, 31, 7, 7, 7, 7, 7, 7, 7, 7, 1, 1]);
        let frames = run(0, &intervals);
        let steady = window_frame_time(&frames, FrameTiming::Steady).unwrap();
        assert!((steady - 0.101 / 11.0).abs() < 0.0001, "{steady}");
        assert!(window_frame_time(&frames, FrameTiming::GopAmortized).is_none());
        let mut intervals = vec![1u64; X264_WARMUP_FRAMES - 1];
        intervals.extend([7, 7, 7, 31, 7, 7, 7, 7, 7, 7, 7, 7, 1, 1]);
        let gop = window_frame_time(&run(0, &intervals), FrameTiming::GopAmortized).unwrap();
        assert!((gop - 0.11 / 14.0).abs() < 0.0001, "{gop}");
        assert!(window_frame_time(&frames, FrameTiming::Amortized).is_none());
        assert!(window_frame_time(&run(0, &[5, 5, 5, 5]), FrameTiming::Steady).is_none());
        let started = frames[0].1.checked_sub(Duration::from_millis(100)).unwrap();
        let amortized = amortized_frame_time(&frames, started, Some(0.9));
        assert!((amortized - 0.8 / 21.0).abs() < 0.0001, "{amortized}");
    }

    #[test]
    fn window_runs_follow_encode_order_and_stop_at_an_incomplete_window() {
        let windows = FrameWindows::new(vec![0..3, 10..13, 20..23]);
        let mut frames = run(0, &[1, 1]);
        frames.extend(run(11, &[1, 1]));
        frames.extend(run(20, &[1]));
        let runs = window_runs(&windows, &frames);
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[1][0].0, 11);
        assert_eq!(completed_windows(&windows, &frames[..4]), 1);
        assert_eq!(completed_windows(&windows, &[]), 0);
    }

    #[test]
    fn size_model_uses_the_measured_short_cadence_and_skips_the_fat_first_gop() {
        let mut packets = vec![packet(60_000, true)];
        packets.extend(std::iter::repeat_n(packet(12_000, false), 11));
        packets.push(packet(110_000, true));
        packets.extend(std::iter::repeat_n(packet(3_000, false), 11));
        packets.push(packet(900_000, true));
        packets.extend(std::iter::repeat_n(packet(3_000, false), 11));
        packets.push(packet(110_000, true));
        let model = VideoSizeModel::fit(&packets, &[0, 24], Some(60)).unwrap();
        assert_eq!(model.key_spacing, 12.0);
        assert_eq!(model.key_bytes, 110_000.0);
        assert_eq!(model.delta_bytes, 3_000.0);
        let expected = 110_000.0 * 100.0 + 3_000.0 * 1100.0;
        assert!((model.bytes_for(1200.0) - expected).abs() < 1.0);
    }

    #[test]
    fn size_model_treats_a_lone_scene_cut_as_the_configured_gop() {
        let mut packets = vec![packet(20_000, true)];
        packets.extend(std::iter::repeat_n(packet(2_000, false), 34));
        packets.push(packet(20_000, true));
        packets.extend(std::iter::repeat_n(packet(2_000, false), 30));
        let model = VideoSizeModel::fit(&packets, &[0], Some(60)).unwrap();
        assert_eq!(model.key_spacing, 60.0);
        assert_eq!(model.key_bytes, 20_000.0);
        assert_eq!(model.delta_bytes, 2_000.0);
        assert!(VideoSizeModel::fit(&[], &[], Some(60)).is_none());
        assert!(VideoSizeModel::fit(&[packet(5, false)], &[], None).is_none());
    }

    #[test]
    fn cancellation_keeps_temporary_files_alive_until_the_encoder_stops() {
        let directory = Arc::new(tempfile::tempdir().unwrap());
        let path = directory.path().to_path_buf();
        let timing = Arc::new(SampleTiming {
            frames: Mutex::default(),
            cancelled: AtomicBool::new(false),
            packets: Arc::default(),
            _temporary_files: directory.clone(),
        });
        let guard = SampleGuard(timing.clone());
        drop(directory);
        drop(guard);
        assert!(timing.is_cancelled());
        assert!(path.exists());
        drop(timing);
        assert!(!path.exists());
    }

    #[test]
    fn samples_cover_the_timeline_without_overlapping_or_crossing_the_end() {
        for fps in [10, 15, 30, 60, 120] {
            for total in [1, 15, 59, 60, 181, 10_000, 10_000_000] {
                for (count, window, leading) in [
                    (1, 60, false),
                    (3, fps * 2 + 30, false),
                    (4, (fps / 2).max(32), true),
                ] {
                    let windows = sample_windows(total, window, count, leading);
                    assert!(
                        windows
                            .windows()
                            .iter()
                            .all(|range| range.start < range.end && range.end <= total)
                    );
                    assert!(
                        windows
                            .windows()
                            .windows(2)
                            .all(|pair| pair[0].end <= pair[1].start)
                    );
                    assert!(windows.len() <= (window * count).max(total));
                    if total > window * count {
                        if leading {
                            assert_eq!(windows.first(), Some(0));
                        }
                        assert!(windows.windows().len() as u32 <= count);
                    }
                }
            }
        }
    }

    #[test]
    fn sample_plans_span_a_gop_for_x264_and_stay_short_for_hardware_encoders() {
        let hardware = sample_plan(ExportSettings::Mp4(crate::mp4::Mp4ExportSettings {
            fps: 60,
            resolution_base: cap_project::XY { x: 1920, y: 1080 },
            compression: crate::mp4::ExportCompression::Social,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            optimize_filesize: false,
        }));
        assert_eq!((hardware.windows, hardware.window_frames), (4, 32));
        assert_eq!(hardware.timing, FrameTiming::Steady);
        assert_eq!(hardware.keyframe_interval, Some(120));
        let x264 = sample_plan(ExportSettings::Mp4(crate::mp4::Mp4ExportSettings {
            fps: 30,
            resolution_base: cap_project::XY { x: 1920, y: 1080 },
            compression: crate::mp4::ExportCompression::Social,
            custom_bpp: None,
            force_ffmpeg_decoder: false,
            optimize_filesize: true,
        }));
        assert_eq!((x264.windows, x264.window_frames), (3, 90));
        assert!(!x264.leading_window && hardware.leading_window);
        assert_eq!(x264.timing, FrameTiming::GopAmortized);
    }

    fn plan(timing: FrameTiming) -> SamplePlan {
        SamplePlan {
            windows: 2,
            window_frames: 20,
            leading_window: false,
            timing,
            keyframe_interval: Some(60),
        }
    }

    #[test]
    fn a_pass_that_covers_the_whole_export_reports_measured_totals() {
        let windows = FrameWindows::all(20);
        let frames = run(0, &[10; 19]);
        let estimate = summarize_pass(&PassMeasurement {
            windows: &windows,
            frames: &frames,
            packets: &[],
            started: frames[0].1,
            elapsed_seconds: Some(2.0),
            bytes: Some(1_048_576.0),
            plan: plan(FrameTiming::Steady),
            total_frames: 20,
            duration_seconds: 2.0,
        })
        .unwrap();
        assert_eq!(estimate.estimated_time_seconds, 2.0);
        assert_eq!(estimate.estimated_size_mb, 1.0);
    }

    #[test]
    fn a_sampled_pass_extrapolates_time_per_window_and_size_from_packets() {
        let windows = FrameWindows::new(vec![100..124, 500..524]);
        let mut intervals = vec![1u64; WARMUP_FRAMES - 1];
        intervals.extend([10; 16]);
        let mut frames = run(100, &intervals);
        let mut second = run(500, &intervals);
        let gap = frames[frames.len() - 1].1 + Duration::from_millis(50) - second[0].1;
        for frame in &mut second {
            frame.1 += gap;
        }
        frames.extend(second);
        let mut packets: Vec<EncodedPacket> = Vec::new();
        for window in 0..2 {
            packets.push(packet(if window == 0 { 50_000 } else { 400_000 }, true));
            packets.extend(std::iter::repeat_n(
                packet(if window == 0 { 9_000 } else { 1_000 }, false),
                11,
            ));
            packets.push(packet(100_000, true));
            packets.extend(std::iter::repeat_n(packet(1_000, false), 11));
        }
        let started = frames[0].1.checked_sub(Duration::from_millis(200)).unwrap();
        let estimate = summarize_pass(&PassMeasurement {
            windows: &windows,
            frames: &frames,
            packets: &packets,
            started,
            elapsed_seconds: Some(1.0),
            bytes: Some(
                packets
                    .iter()
                    .map(|packet| packet.bytes as f64)
                    .sum::<f64>()
                    + 48.0 * 100.0,
            ),
            plan: plan(FrameTiming::Steady),
            total_frames: 1240,
            duration_seconds: 41.3,
        })
        .unwrap();
        let fixed = fixed_seconds(&frames, started, Some(1.0));
        assert!(
            (fixed
                - (0.2 + 1.0
                    - frames[frames.len() - 1]
                        .1
                        .saturating_duration_since(started)
                        .as_secs_f64()))
            .abs()
                < 0.001
        );
        assert!(
            (estimate.estimated_time_seconds - (fixed + 0.01 * 1240.0)).abs() < 0.05,
            "{}",
            estimate.estimated_time_seconds
        );
        let keys = (1240.0f64 / 12.0).ceil();
        let expected =
            (100_000.0 * keys + 1_000.0 * (1240.0 - keys) + 100.0 * 1240.0) / (1024.0 * 1024.0);
        assert!(
            (estimate.estimated_size_mb - expected).abs() < 0.01,
            "{} != {expected}",
            estimate.estimated_size_mb
        );
        assert!(estimate.size_range_mb[0] <= estimate.estimated_size_mb);
        assert!(estimate.size_range_mb[1] >= estimate.estimated_size_mb);
    }
}
