use std::{
    collections::{VecDeque, hash_map::DefaultHasher},
    hash::{Hash, Hasher},
    ops::Range,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use cap_editor::{EditorInstance, SegmentMedia};
use cap_project::ProjectConfiguration;
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
    frames: Mutex<Vec<Instant>>,
    cancelled: AtomicBool,
    _temporary_files: Arc<tempfile::TempDir>,
}

impl SampleTiming {
    pub(crate) fn record_frame(&self) {
        if let Ok(mut frames) = self.frames.lock() {
            frames.push(Instant::now());
        }
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

struct Sample {
    frames: u32,
    bytes: f64,
    elapsed_seconds: f64,
    seconds_per_frame: f64,
}

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
    let window_frames = match settings {
        ExportSettings::Gif(_) => settings.fps().min(20),
        ExportSettings::Mp4(settings) if settings.optimize_filesize => settings.fps * 4,
        _ => settings.fps() * 2,
    };
    let ranges = sample_ranges(total_frames, window_frames);
    let mut samples = Vec::new();
    let summarize = |samples: &[Sample]| -> Result<ExportEstimates, String> {
        let mut estimate = summarize_samples(samples, total_frames, duration)?;
        estimate.estimated_time_seconds += setup_seconds;
        for seconds in &mut estimate.time_range_seconds {
            *seconds += setup_seconds;
        }
        Ok(estimate)
    };
    for (index, range) in ranges.iter().enumerate() {
        if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
            return Err("Export estimate cancelled".into());
        }
        if Instant::now() >= deadline {
            break;
        }
        let timing = Arc::new(SampleTiming {
            frames: Mutex::default(),
            cancelled: AtomicBool::new(false),
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
            output_path: temp.path().join(format!("sample-{index}.mp4")),
            streaming_audio: None,
            streaming_output: None,
            audio_cancellation: None,
            sample_range: Some(range.clone()),
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
        let path = tokio::select! {
            _ = wait_for_stop(&editor, &cancel, deadline) => {
                if !samples.is_empty() && !cancel.load(Ordering::Acquire) && !editor.export_active.load(Ordering::Acquire) {
                    break;
                }
                return Err("Export estimate cancelled or timed out".into());
            }
            result = export => result?,
        };
        let elapsed = started.elapsed().as_secs_f64();
        let frames = timing.frames.lock().map_err(|error| error.to_string())?;
        let expected = range.end.saturating_sub(range.start);
        if frames.len() != expected as usize {
            return Err("Export sample did not render every frame".into());
        }
        let startup = frames.first().map_or(0.0, |first| {
            first.saturating_duration_since(started).as_secs_f64()
        });
        let seconds_per_frame = if matches!(settings, ExportSettings::Gif(_)) {
            (elapsed - startup).max(0.0) / f64::from(expected.saturating_sub(1).max(1))
        } else {
            steady_frame_time(&frames, elapsed)
        };
        tracing::debug!(
            sample = index,
            frames = expected,
            elapsed_seconds = elapsed,
            startup_seconds = startup,
            seconds_per_frame,
            "Measured export sample"
        );
        samples.push(Sample {
            frames: expected,
            bytes: std::fs::metadata(&path)
                .map_err(|error| error.to_string())?
                .len() as f64,
            elapsed_seconds: elapsed,
            seconds_per_frame,
        });
        drop(frames);
        if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
            return Err("Export estimate cancelled".into());
        }
        on_estimate(summarize(&samples)?);
    }
    if cancel.load(Ordering::Acquire) || editor.export_active.load(Ordering::Acquire) {
        return Err("Export estimate cancelled".into());
    }
    let estimate = summarize(&samples)?;
    if samples.len() == ranges.len()
        && let Ok(mut cache) = CACHE.lock()
    {
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

fn steady_frame_time(frames: &[Instant], elapsed_seconds: f64) -> f64 {
    let tail_start = frames.len().saturating_sub((frames.len() / 4).max(2));
    match (frames.get(tail_start), frames.last()) {
        (Some(first), Some(last)) if frames.len() > 1 => {
            last.saturating_duration_since(*first).as_secs_f64()
                / frames.len().saturating_sub(tail_start + 1).max(1) as f64
        }
        _ => elapsed_seconds / frames.len().max(1) as f64,
    }
}

fn sample_ranges(total_frames: u32, window_frames: u32) -> Vec<Range<u32>> {
    let count = window_frames.max(2);
    if total_frames <= count.saturating_mul(3) {
        return std::iter::once(0..total_frames).collect();
    }
    (0..3)
        .map(|index| {
            let stratum = total_frames / 3;
            let start = index * stratum + (stratum - count) / 2;
            start..start + count
        })
        .collect()
}

fn summarize_samples(
    samples: &[Sample],
    total_frames: u32,
    duration_seconds: f64,
) -> Result<ExportEstimates, String> {
    if samples.is_empty() || total_frames == 0 {
        return Err("Export estimate unavailable".into());
    }
    let sampled_frames: u32 = samples.iter().map(|sample| sample.frames).sum();
    if sampled_frames == total_frames && samples.len() == 1 {
        let time = samples[0].elapsed_seconds;
        let size = samples[0].bytes / (1024.0 * 1024.0);
        return Ok(ExportEstimates {
            duration_seconds,
            estimated_time_seconds: time,
            estimated_size_mb: size,
            time_range_seconds: [time, time],
            size_range_mb: [size, size],
        });
    }
    let times: Vec<f64> = samples
        .iter()
        .map(|sample| {
            sample.elapsed_seconds
                + sample.seconds_per_frame * f64::from(total_frames.saturating_sub(sample.frames))
        })
        .collect();
    let sizes: Vec<f64> = samples
        .iter()
        .map(|sample| {
            sample.bytes / f64::from(sample.frames) * f64::from(total_frames) / (1024.0 * 1024.0)
        })
        .collect();
    let range = |values: &[f64]| {
        let mean = values.iter().sum::<f64>() / values.len() as f64;
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
                .fold(mean - deviation, f64::min)
                .max(0.0),
            values.iter().copied().fold(mean + deviation, f64::max),
        ]
    };
    Ok(ExportEstimates {
        duration_seconds,
        estimated_time_seconds: times.iter().sum::<f64>() / times.len() as f64,
        estimated_size_mb: sizes.iter().sum::<f64>() / sizes.len() as f64,
        time_range_seconds: range(&times),
        size_range_mb: range(&sizes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_throughput_excludes_encoder_warmup_and_flush() {
        let started = Instant::now();
        let frames: Vec<_> = (0..120)
            .map(|frame| {
                started
                    + Duration::from_millis(if frame < 60 {
                        frame
                    } else {
                        60 + (frame - 60) * 20
                    })
            })
            .collect();
        assert!((steady_frame_time(&frames, 5.0) - 0.02).abs() < 0.00001);
        let estimate = summarize_samples(
            &[Sample {
                frames: 120,
                bytes: 1_000_000.0,
                elapsed_seconds: 5.0,
                seconds_per_frame: 0.02,
            }],
            1200,
            40.0,
        )
        .unwrap();
        assert!((estimate.estimated_time_seconds - 26.6).abs() < 0.00001);
    }

    #[test]
    fn cancellation_keeps_temporary_files_alive_until_the_encoder_stops() {
        let directory = Arc::new(tempfile::tempdir().unwrap());
        let path = directory.path().to_path_buf();
        let timing = Arc::new(SampleTiming {
            frames: Mutex::default(),
            cancelled: AtomicBool::new(false),
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
                for window in [fps.min(20), fps * 2, fps * 4] {
                    let ranges = sample_ranges(total, window);
                    assert!(
                        ranges
                            .iter()
                            .all(|range| range.start < range.end && range.end <= total)
                    );
                    assert!(ranges.windows(2).all(|pair| pair[0].end <= pair[1].start));
                    assert!(
                        ranges
                            .iter()
                            .map(|range| range.end - range.start)
                            .sum::<u32>()
                            <= window * 3
                    );
                }
            }
        }
    }

    #[test]
    fn short_exports_use_measured_totals_without_extrapolating_startup() {
        let result = summarize_samples(
            &[Sample {
                frames: 60,
                bytes: 1_048_576.0,
                elapsed_seconds: 2.0,
                seconds_per_frame: 0.01,
            }],
            60,
            2.0,
        )
        .unwrap();
        assert_eq!(result.estimated_time_seconds, 2.0);
        assert_eq!(result.estimated_size_mb, 1.0);
    }

    #[test]
    fn startup_is_paid_once_and_sample_variation_is_preserved() {
        let result = summarize_samples(
            &[
                Sample {
                    frames: 61,
                    bytes: 1_048_576.0,
                    elapsed_seconds: 1.6,
                    seconds_per_frame: 0.01,
                },
                Sample {
                    frames: 61,
                    bytes: 2_097_152.0,
                    elapsed_seconds: 2.2,
                    seconds_per_frame: 0.02,
                },
            ],
            601,
            20.0,
        )
        .unwrap();
        assert!((result.estimated_time_seconds - 10.0).abs() < 0.0001);
        assert!(result.time_range_seconds[0] <= 7.0);
        assert!(result.time_range_seconds[1] >= 13.0);
        assert!(result.size_range_mb[0] < result.estimated_size_mb);
        assert!(result.size_range_mb[1] > result.estimated_size_mb);
    }
}
