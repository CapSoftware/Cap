use crate::{AudioRenderer, SegmentMedia};
use cap_audio::{
    AudioRendererTrack, AudioSampleSource, AudioStream, AudioStreamError, ChunkRead, StereoMode,
};
use cap_project::{ClipOffsets, ProjectConfiguration, RecordingMeta, StudioRecordingMeta};
use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub(crate) const EXPORT_AUDIO_BLOCK_SAMPLES: usize = 4_096;
const MAX_PARALLEL_AUDIO_SOURCES: usize = 4;

#[derive(Clone, Debug)]
pub enum ExportAudioError {
    Cancelled,
    Source {
        source_index: usize,
        path: PathBuf,
        source: AudioStreamError,
    },
    InvalidWindow,
    Sink(String),
    Worker {
        source_index: usize,
        message: String,
    },
}

impl fmt::Display for ExportAudioError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Cancelled => f.write_str("Export cancelled"),
            Self::Source { path, source, .. } => write!(f, "Audio at {}: {source}", path.display()),
            Self::InvalidWindow => f.write_str("Invalid sequential export audio window"),
            Self::Sink(error) => f.write_str(error),
            Self::Worker { message, .. } => write!(f, "Audio source worker failed: {message}"),
        }
    }
}

impl std::error::Error for ExportAudioError {}

impl ExportAudioError {
    pub fn source_index(&self) -> Option<usize> {
        match self {
            Self::Source { source_index, .. } | Self::Worker { source_index, .. } => {
                Some(*source_index)
            }
            _ => None,
        }
    }

    fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled)
            || matches!(self, Self::Source { source, .. } if source.is_cancelled())
    }
}

fn source_worker_panic(
    source_index: usize,
    panic: Box<dyn std::any::Any + Send>,
) -> ExportAudioError {
    ExportAudioError::Worker {
        source_index,
        message: panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| {
                panic
                    .downcast_ref::<&str>()
                    .map(|message| (*message).into())
            })
            .unwrap_or_else(|| "worker panicked".into()),
    }
}

fn run_source_job<T, R>(
    source_index: usize,
    input: &mut T,
    operation: &impl Fn(usize, &mut T) -> Result<R, ExportAudioError>,
) -> Result<R, ExportAudioError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        operation(source_index, input)
    }))
    .unwrap_or_else(|panic| Err(source_worker_panic(source_index, panic)))
}

fn run_source_jobs<T: Send, R: Send>(
    inputs: &mut [(usize, T)],
    abort: &AtomicBool,
    operation: impl Fn(usize, &mut T) -> Result<R, ExportAudioError> + Sync,
) -> Result<Vec<R>, ExportAudioError> {
    if inputs.len() <= 1 {
        let result = inputs
            .iter_mut()
            .map(|(index, input)| run_source_job(*index, input, &operation))
            .collect::<Result<_, _>>();
        if result.as_ref().is_err_and(|error| !error.is_cancelled()) {
            abort.store(true, Ordering::Relaxed);
        }
        return result;
    }

    let mut results = Vec::with_capacity(inputs.len());
    for batch in inputs.chunks_mut(MAX_PARALLEL_AUDIO_SOURCES) {
        let joined = std::thread::scope(|scope| {
            let operation = &operation;
            let handles = batch
                .iter_mut()
                .map(|(index, input)| {
                    let index = *index;
                    std::thread::Builder::new()
                        .spawn_scoped(scope, move || run_source_job(index, input, operation))
                        .ok()
                })
                .collect::<Vec<_>>();
            let mut earlier_source_not_started = false;
            handles
                .into_iter()
                .map(|handle| {
                    let Some(handle) = handle else {
                        earlier_source_not_started = true;
                        return None;
                    };
                    let result = handle.join();
                    if !earlier_source_not_started
                        && match &result {
                            Ok(Err(error)) => !error.is_cancelled(),
                            Err(_) => true,
                            _ => false,
                        }
                    {
                        abort.store(true, Ordering::Relaxed);
                    }
                    Some(result)
                })
                .collect::<Vec<_>>()
        });
        for ((index, input), result) in batch.iter_mut().zip(joined) {
            let result = match result {
                Some(Ok(result)) => result,
                Some(Err(panic)) => Err(source_worker_panic(*index, panic)),
                None => run_source_job(*index, input, &operation),
            };
            if result.as_ref().is_err_and(|error| !error.is_cancelled()) {
                abort.store(true, Ordering::Relaxed);
            }
            results.push(result);
        }
    }

    let mut values = Vec::with_capacity(results.len());
    let mut first_error: Option<ExportAudioError> = None;
    for result in results {
        match result {
            Ok(value) => values.push(value),
            Err(error) => {
                if first_error
                    .as_ref()
                    .is_none_or(|previous| previous.is_cancelled() && !error.is_cancelled())
                {
                    first_error = Some(error);
                }
            }
        }
    }
    match first_error {
        Some(error) => Err(error),
        None => Ok(values),
    }
}

pub struct ExportAudioRenderer {
    renderer: AudioRenderer,
    sources: ExportAudioSources,
    failure: Option<ExportAudioError>,
}

pub struct ExportAudioPreparation {
    sources: ExportAudioSources,
}

impl ExportAudioPreparation {
    fn segment_count(meta: &StudioRecordingMeta) -> usize {
        match meta {
            StudioRecordingMeta::SingleSegment { .. } => 1,
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner.segments.len(),
        }
    }

    pub fn open(
        recording: &RecordingMeta,
        meta: &StudioRecordingMeta,
        cancellation: Arc<AtomicBool>,
        abort: Arc<AtomicBool>,
    ) -> Result<Self, ExportAudioError> {
        let mut inputs = Vec::new();
        match meta {
            StudioRecordingMeta::SingleSegment { segment } => {
                if let Some(audio) = &segment.audio {
                    inputs.push((0, recording.path(&audio.path), true));
                }
            }
            StudioRecordingMeta::MultipleSegments { inner, .. } => {
                for (index, segment) in inner.segments.iter().enumerate() {
                    if let Some(audio) = &segment.mic {
                        inputs.push((index, recording.path(&audio.path), true));
                    }
                    if let Some(audio) = &segment.system_audio {
                        inputs.push((index, recording.path(&audio.path), false));
                    }
                }
            }
        }
        let mut inputs = inputs.into_iter().enumerate().collect::<Vec<_>>();
        let opened = run_source_jobs(&mut inputs, &abort, |source_index, (index, path, mic)| {
            ExportAudioTrack::open(path, source_index, *mic, 0.0, &cancellation, &abort)
                .map(|track| (*index, track))
        })?;
        let mut tracks = (0..Self::segment_count(meta))
            .map(|_| Vec::new())
            .collect::<Vec<_>>();
        for (index, track) in opened {
            tracks[index].push(track);
        }
        Ok(Self {
            sources: ExportAudioSources {
                tracks,
                cancellation,
                abort,
            },
        })
    }

    pub fn finish(
        self,
        segments: &[SegmentMedia],
    ) -> Result<ExportAudioRenderer, ExportAudioError> {
        self.finish_with_timing_repair(segments.iter().map(|segment| segment.audio_timing_repair))
    }

    fn finish_with_timing_repair(
        mut self,
        timing_repair: impl ExactSizeIterator<Item = crate::editor_instance::SegmentAudioTimingRepair>,
    ) -> Result<ExportAudioRenderer, ExportAudioError> {
        if timing_repair.len() != self.sources.tracks.len() {
            return Err(ExportAudioError::InvalidWindow);
        }
        for (tracks, repair) in self.sources.tracks.iter_mut().zip(timing_repair) {
            for track in tracks {
                track.timing_offset_secs = if track.mic {
                    repair.mic_offset_secs
                } else {
                    repair.system_audio_offset_secs
                };
            }
        }
        Ok(ExportAudioRenderer {
            renderer: AudioRenderer::new(Vec::new()),
            sources: self.sources,
            failure: None,
        })
    }
}

pub struct ExportAudioValidation {
    sources: ExportAudioSources,
}

impl ExportAudioValidation {
    pub fn validate_to_end(mut self) -> Result<(), ExportAudioError> {
        self.sources.validate_to_end()
    }
}

impl ExportAudioRenderer {
    pub fn eligible(project: &ProjectConfiguration, meta: &StudioRecordingMeta) -> bool {
        let source_count = match meta {
            StudioRecordingMeta::SingleSegment { segment } => usize::from(segment.audio.is_some()),
            StudioRecordingMeta::MultipleSegments { inner, .. } => inner
                .segments
                .iter()
                .map(|segment| {
                    usize::from(segment.mic.is_some()) + usize::from(segment.system_audio.is_some())
                })
                .sum(),
        };
        Self::eligible_sources(project, source_count)
    }

    fn eligible_sources(project: &ProjectConfiguration, source_count: usize) -> bool {
        if !(1..=MAX_PARALLEL_AUDIO_SOURCES).contains(&source_count)
            || project.clips.iter().any(|clip| {
                [clip.offsets.mic, clip.offsets.system_audio]
                    .iter()
                    .any(|offset| {
                        !offset.is_finite() || (offset * 48_000.0).abs() >= isize::MAX as f32 / 2.0
                    })
            })
        {
            return false;
        }
        let Some(timeline) = &project.timeline else {
            return true;
        };
        if !timeline.audio_segments.is_empty() || !timeline.hold_windows().is_empty() {
            return false;
        }
        let mut ends = HashMap::new();
        let mut duration = 0.0;
        for segment in &timeline.segments {
            if segment.timescale != 1.0
                || !segment.start.is_finite()
                || !segment.end.is_finite()
                || segment.start < 0.0
                || segment.end <= segment.start
                || segment.end * 48_000.0 >= isize::MAX as f64 / 2.0
            {
                return false;
            }
            duration += segment.duration();
            if !duration.is_finite() || duration * 48_000.0 >= isize::MAX as f64 / 2.0 {
                return false;
            }
            if let Some(previous_end) = ends.insert(segment.recording_clip, segment.end)
                && (!timeline.transitions.is_empty() || segment.start < previous_end)
            {
                return false;
            }
        }
        true
    }

    pub fn open(
        recording: &RecordingMeta,
        meta: &StudioRecordingMeta,
        segments: &[SegmentMedia],
        cancellation: Arc<AtomicBool>,
        abort: Arc<AtomicBool>,
    ) -> Result<Self, ExportAudioError> {
        if segments.len() != ExportAudioPreparation::segment_count(meta) {
            return Err(ExportAudioError::InvalidWindow);
        }
        ExportAudioPreparation::open(recording, meta, cancellation, abort)?.finish(segments)
    }

    pub fn take_unused_sources(
        &mut self,
        project: &ProjectConfiguration,
    ) -> Option<ExportAudioValidation> {
        let timeline = project.timeline.as_ref()?;
        if self.sources.tracks.iter().flatten().count() > MAX_PARALLEL_AUDIO_SOURCES {
            return None;
        }
        let mut unused = Vec::new();
        for (clip_index, tracks) in self.sources.tracks.iter_mut().enumerate() {
            if !tracks.is_empty()
                && !timeline
                    .segments
                    .iter()
                    .any(|segment| segment.recording_clip as usize == clip_index)
            {
                unused.push(std::mem::take(tracks));
            }
        }
        (!unused.is_empty()).then(|| ExportAudioValidation {
            sources: ExportAudioSources {
                tracks: unused,
                cancellation: self.sources.cancellation.clone(),
                abort: self.sources.abort.clone(),
            },
        })
    }

    pub fn render_chunks(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
        emit: impl FnMut(usize, &[f32]) -> Result<(), ExportAudioError>,
    ) -> Result<Option<usize>, ExportAudioError> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = self
            .renderer
            .render_export_chunks(&mut self.sources, samples, project, emit);
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }

    pub fn validate_to_end(&mut self) -> Result<(), ExportAudioError> {
        if let Some(error) = &self.failure {
            return Err(error.clone());
        }
        let result = self.sources.validate_to_end();
        if let Err(error) = &result {
            self.failure = Some(error.clone());
        }
        result
    }
}

pub(crate) struct ExportAudioSources {
    tracks: Vec<Vec<ExportAudioTrack>>,
    cancellation: Arc<AtomicBool>,
    abort: Arc<AtomicBool>,
}

impl ExportAudioSources {
    pub(crate) fn check_cancelled(&self) -> Result<(), ExportAudioError> {
        if self.cancellation.load(Ordering::Relaxed) || self.abort.load(Ordering::Relaxed) {
            Err(ExportAudioError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn validate_to_end(&mut self) -> Result<(), ExportAudioError> {
        self.check_cancelled()?;
        let mut tracks = self
            .tracks
            .iter_mut()
            .flatten()
            .map(|track| (track.source_index, track))
            .collect::<Vec<_>>();
        run_source_jobs(&mut tracks, &self.abort, |_, track| {
            track
                .source
                .validate_to_end()
                .map_err(|source| ExportAudioError::Source {
                    source_index: track.source_index,
                    path: track.path.clone(),
                    source,
                })?;
            track.samples.clear();
            Ok(())
        })?;
        self.check_cancelled()
    }

    pub(crate) fn render(
        &mut self,
        project: &ProjectConfiguration,
        clip_index: u32,
        cursor: usize,
        samples: usize,
        output: &mut [f32],
    ) -> Result<usize, ExportAudioError> {
        self.check_cancelled()?;
        let Some(tracks) = self.tracks.get_mut(clip_index as usize) else {
            return Ok(0);
        };
        let offsets = project
            .clips
            .iter()
            .find(|clip| clip.index == clip_index)
            .map(|clip| clip.offsets)
            .unwrap_or_default();
        for track in tracks.iter_mut() {
            let start = cursor as i128 + track.offset(&offsets) as i128;
            track.prepare(start, start + samples as i128)?;
        }
        let views = tracks.iter().map(|track| track.view()).collect::<Vec<_>>();
        let max_samples = tracks
            .iter()
            .map(|track| (track.available_end as isize - track.offset(&offsets)).max(0) as usize)
            .max()
            .unwrap_or(0);
        if cursor >= max_samples {
            return Ok(0);
        }
        let tracks = tracks
            .iter()
            .zip(&views)
            .map(|(track, view)| {
                let gain = if track.mic {
                    project.audio.mic_volume_db
                } else {
                    project.audio.system_volume_db
                };
                AudioRendererTrack {
                    data: view,
                    gain: if project.audio.mute || gain < -30.0 {
                        f32::NEG_INFINITY
                    } else {
                        gain
                    },
                    stereo_mode: if !track.mic {
                        StereoMode::Stereo
                    } else {
                        match project.audio.mic_stereo_mode {
                            cap_project::StereoMode::Stereo => StereoMode::Stereo,
                            cap_project::StereoMode::MonoL => StereoMode::MonoL,
                            cap_project::StereoMode::MonoR => StereoMode::MonoR,
                        }
                    },
                    offset: track.offset(&offsets),
                }
            })
            .collect::<Vec<_>>();
        Ok(cap_audio::render_audio(
            &tracks,
            cursor,
            samples.min(max_samples - cursor),
            0,
            output,
        ))
    }
}

struct ExportAudioTrack {
    source: AudioStream,
    source_index: usize,
    path: PathBuf,
    mic: bool,
    timing_offset_secs: f32,
    samples: Vec<f32>,
    source_start: usize,
    available_end: usize,
    eof: Option<usize>,
}

impl ExportAudioTrack {
    fn open(
        path: &Path,
        source_index: usize,
        mic: bool,
        timing_offset_secs: f32,
        cancellation: &Arc<AtomicBool>,
        abort: &Arc<AtomicBool>,
    ) -> Result<Self, ExportAudioError> {
        let source = AudioStream::open_with_abort(path, cancellation.clone(), abort.clone())
            .map_err(|source| ExportAudioError::Source {
                source_index,
                path: path.to_path_buf(),
                source,
            })?;
        Ok(Self {
            source,
            source_index,
            path: path.to_path_buf(),
            mic,
            timing_offset_secs,
            samples: Vec::new(),
            source_start: 0,
            available_end: 0,
            eof: None,
        })
    }

    fn offset(&self, offsets: &ClipOffsets) -> isize {
        let offset = if self.mic {
            offsets.mic
        } else {
            offsets.system_audio
        };
        ((offset + self.timing_offset_secs) * AudioRenderer::SAMPLE_RATE as f32).round() as isize
    }

    fn prepare(&mut self, start: i128, end: i128) -> Result<(), ExportAudioError> {
        let start = usize::try_from(start.max(0)).map_err(|_| ExportAudioError::InvalidWindow)?;
        let end = usize::try_from(end.max(0)).map_err(|_| ExportAudioError::InvalidWindow)?;
        if end < start || end - start > EXPORT_AUDIO_BLOCK_SAMPLES || start < self.source_start {
            return Err(ExportAudioError::InvalidWindow);
        }
        let channels = self.source.channels() as usize;
        let discard = start
            .saturating_sub(self.source_start)
            .min(self.samples.len() / channels)
            * channels;
        self.samples.copy_within(discard.., 0);
        self.samples.truncate(self.samples.len() - discard);
        self.source_start = start;
        while self.eof.is_none() && self.source.position() < end as u64 {
            let wanted = (end as u64 - self.source.position()).min(12_000) as usize;
            match self
                .source
                .read_chunk(wanted)
                .map_err(|source| ExportAudioError::Source {
                    source_index: self.source_index,
                    path: self.path.clone(),
                    source,
                })? {
                ChunkRead::Chunk(chunk) => {
                    let chunk_start = usize::try_from(chunk.source_start_sample)
                        .map_err(|_| ExportAudioError::InvalidWindow)?;
                    let discard = start
                        .saturating_sub(chunk_start)
                        .min(chunk.samples.len() / channels)
                        * channels;
                    self.samples.extend_from_slice(&chunk.samples[discard..]);
                }
                ChunkRead::Eof { next_sample } => {
                    self.eof = Some(
                        usize::try_from(next_sample)
                            .map_err(|_| ExportAudioError::InvalidWindow)?,
                    );
                }
            }
        }
        self.available_end = self.eof.unwrap_or(end.max(self.source.position() as usize));
        Ok(())
    }

    fn view(&self) -> ExportAudioView<'_> {
        ExportAudioView {
            samples: &self.samples,
            channels: self.source.channels(),
            source_start: self.source_start,
            available_end: self.available_end,
        }
    }
}

struct ExportAudioView<'a> {
    samples: &'a [f32],
    channels: u16,
    source_start: usize,
    available_end: usize,
}

impl AudioSampleSource for ExportAudioView<'_> {
    fn channels(&self) -> u16 {
        self.channels
    }
    fn sample_count(&self) -> usize {
        self.available_end
    }
    fn sample(&self, index: usize) -> Option<&f32> {
        index
            .checked_sub(self.source_start * self.channels as usize)
            .and_then(|index| self.samples.get(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::{AudioSegment, AudioSegmentTrack};
    use cap_audio::AudioData;
    use cap_project::{
        ClipConfiguration, ClipSpeedAudioMode, ClipTransition, ClipTransitionType,
        TimelineConfiguration, TimelineSegment,
    };

    #[test]
    fn source_jobs_are_bounded_joined_and_ordered() {
        use std::{
            sync::{Condvar, Mutex, atomic::AtomicUsize},
            time::Duration,
        };

        let active = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let completed = AtomicUsize::new(0);
        let arrived = Mutex::new(0);
        let changed = Condvar::new();
        let abort = AtomicBool::new(false);
        let mut inputs = (0..9).map(|value| (value, value)).collect::<Vec<_>>();
        let results = run_source_jobs(&mut inputs, &abort, |_, input| {
            let count = active.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(count, Ordering::SeqCst);
            if *input < 8 {
                let mut count = arrived.lock().unwrap();
                *count += 1;
                changed.notify_all();
                let (_guard, timed_out) = changed
                    .wait_timeout_while(count, Duration::from_secs(2), |count| {
                        *count
                            < (*input / MAX_PARALLEL_AUDIO_SOURCES + 1) * MAX_PARALLEL_AUDIO_SOURCES
                    })
                    .unwrap();
                assert!(!timed_out.timed_out());
            }
            active.fetch_sub(1, Ordering::SeqCst);
            completed.fetch_add(1, Ordering::SeqCst);
            Ok(*input)
        })
        .unwrap();

        assert_eq!(results, (0..9).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), MAX_PARALLEL_AUDIO_SOURCES);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(completed.load(Ordering::SeqCst), inputs.len());
        assert!(!abort.load(Ordering::Relaxed));
    }

    #[test]
    fn source_jobs_preserve_first_real_error_and_join_later_sources() {
        use std::sync::atomic::AtomicUsize;

        let completed = AtomicUsize::new(0);
        let abort = AtomicBool::new(false);
        let mut inputs = [(0, 0), (1, 1), (2, 2), (3, 3)];
        let error = run_source_jobs(&mut inputs, &abort, |_, input| {
            completed.fetch_add(1, Ordering::SeqCst);
            match input {
                0 => Err(ExportAudioError::Cancelled),
                1 => Err(ExportAudioError::Sink("first source error".into())),
                2 => Err(ExportAudioError::Sink("later source error".into())),
                _ => Ok(()),
            }
        })
        .unwrap_err();

        assert_eq!(error.to_string(), "first source error");
        assert_eq!(completed.load(Ordering::SeqCst), inputs.len());
        assert!(abort.load(Ordering::Relaxed));
    }

    #[test]
    fn source_worker_panic_becomes_error_after_other_sources_join() {
        use std::sync::atomic::AtomicUsize;

        let completed = AtomicUsize::new(0);
        let abort = AtomicBool::new(false);
        let mut inputs = [(0, 0), (1, 1), (2, 2), (3, 3)];
        let error = run_source_jobs(&mut inputs, &abort, |_, input| {
            if *input == 1 {
                panic!("source worker test");
            }
            completed.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Audio source worker failed: source worker test"
        );
        assert_eq!(completed.load(Ordering::SeqCst), inputs.len() - 1);
        assert_eq!(error.source_index(), Some(1));
        assert!(abort.load(Ordering::Relaxed));
    }

    #[test]
    fn failed_source_aborts_and_joins_waiting_peer_without_user_cancellation() {
        use std::time::{Duration, Instant};

        let user_cancellation = AtomicBool::new(false);
        let abort = AtomicBool::new(false);
        let peer_started = AtomicBool::new(false);
        let peer_observed_abort = AtomicBool::new(false);
        let peer_finished = AtomicBool::new(false);
        let error = run_source_jobs(&mut [(0, 0), (1, 1)], &abort, |_, input| {
            let started = Instant::now();
            if *input == 0 {
                while !peer_started.load(Ordering::Acquire)
                    && started.elapsed() < Duration::from_secs(2)
                {
                    std::thread::yield_now();
                }
                assert!(peer_started.load(Ordering::Acquire));
                return Err(ExportAudioError::Sink("first source failed".into()));
            }
            peer_started.store(true, Ordering::Release);
            while !abort.load(Ordering::Relaxed)
                && !user_cancellation.load(Ordering::Relaxed)
                && started.elapsed() < Duration::from_secs(2)
            {
                std::thread::yield_now();
            }
            peer_observed_abort.store(abort.load(Ordering::Relaxed), Ordering::Relaxed);
            peer_finished.store(true, Ordering::Release);
            Err::<(), _>(ExportAudioError::Cancelled)
        })
        .unwrap_err();

        assert_eq!(error.to_string(), "first source failed");
        assert!(peer_observed_abort.load(Ordering::Relaxed));
        assert!(peer_finished.load(Ordering::Acquire));
        assert!(!user_cancellation.load(Ordering::Relaxed));
    }

    #[test]
    fn single_source_job_stays_on_current_thread() {
        let current = std::thread::current().id();
        let results = run_source_jobs(&mut [(7, 0)], &AtomicBool::new(false), |index, value| {
            assert_eq!(std::thread::current().id(), current);
            assert_eq!(index, 7);
            *value += 1;
            Ok(*value)
        })
        .unwrap();
        assert_eq!(results, [1]);
    }

    #[test]
    fn inline_source_panic_preserves_original_source_index() {
        let abort = AtomicBool::new(false);
        let error = run_source_jobs::<_, ()>(&mut [(7, ())], &abort, |_, _| {
            panic!("inline source panic");
        })
        .unwrap_err();
        assert_eq!(error.source_index(), Some(7));
        assert_eq!(
            error.to_string(),
            "Audio source worker failed: inline source panic"
        );
        assert!(abort.load(Ordering::Relaxed));
    }

    fn write_wav(path: &Path, frames: usize, channels: u16) {
        let data_size = frames as u32 * u32::from(channels) * 2;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data_size).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&channels.to_le_bytes());
        bytes.extend_from_slice(&48_000u32.to_le_bytes());
        bytes.extend_from_slice(&(48_000u32 * u32::from(channels) * 2).to_le_bytes());
        bytes.extend_from_slice(&(channels * 2).to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        for index in 0..frames * channels as usize {
            bytes.extend_from_slice(&(((index * 73) % 60_001) as i32 - 30_000).to_le_bytes()[..2]);
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn preparation_recording(directory: &Path) -> RecordingMeta {
        std::fs::write(
            directory.join("recording-meta.json"),
            r#"{
                "pretty_name": "Audio preparation test",
                "segments": [
                    {
                        "display": { "path": "unused.mp4" },
                        "mic": { "path": "mic.wav" },
                        "system_audio": { "path": "system.wav" }
                    },
                    { "display": { "path": "unused.mp4" } },
                    {
                        "display": { "path": "unused.mp4" },
                        "mic": { "path": "incoming.wav" }
                    }
                ]
            }"#,
        )
        .unwrap();
        RecordingMeta::load_for_project(directory).unwrap()
    }

    #[test]
    fn preparation_preserves_readers_positions_and_timing_repair_bits() {
        use crate::editor_instance::SegmentAudioTimingRepair;

        let directory = tempfile::tempdir().unwrap();
        let recording = preparation_recording(directory.path());
        for (name, channels) in [("mic.wav", 1), ("system.wav", 2), ("incoming.wav", 2)] {
            write_wav(&directory.path().join(name), 17_003, channels);
        }
        let user = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        let prepared = ExportAudioPreparation::open(
            &recording,
            recording.studio_meta().unwrap(),
            user.clone(),
            abort.clone(),
        )
        .unwrap();
        let identity = |track: &ExportAudioTrack| {
            (
                std::ptr::from_ref(&track.source) as usize,
                track.source_index,
                track.path.clone(),
                track.mic,
                track.source.position(),
            )
        };
        let before = prepared
            .sources
            .tracks
            .iter()
            .flatten()
            .map(identity)
            .collect::<Vec<_>>();
        assert!(before.iter().all(|track| track.4 == 0));
        assert_eq!(
            prepared
                .sources
                .tracks
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            [2, 0, 1]
        );
        let repairs = [
            SegmentAudioTimingRepair {
                mic_offset_secs: -0.0,
                system_audio_offset_secs: f32::from_bits(0x7fc0_1234),
            },
            SegmentAudioTimingRepair::default(),
            SegmentAudioTimingRepair {
                mic_offset_secs: -0.137_125,
                system_audio_offset_secs: 0.0,
            },
        ];
        let mut renderer = prepared
            .finish_with_timing_repair(repairs.into_iter())
            .unwrap();
        let after = renderer
            .sources
            .tracks
            .iter()
            .flatten()
            .map(identity)
            .collect::<Vec<_>>();
        assert_eq!(before, after);
        assert_eq!(
            renderer
                .sources
                .tracks
                .iter()
                .flatten()
                .map(|track| track.timing_offset_secs.to_bits())
                .collect::<Vec<_>>(),
            [
                repairs[0].mic_offset_secs.to_bits(),
                repairs[0].system_audio_offset_secs.to_bits(),
                repairs[2].mic_offset_secs.to_bits()
            ],
        );
        for track in renderer.sources.tracks.iter_mut().flatten() {
            let reference = AudioData::from_file(&track.path).unwrap();
            let ChunkRead::Chunk(chunk) = track.source.read_chunk(257).unwrap() else {
                panic!("prepared source unexpectedly empty");
            };
            assert_eq!(chunk.source_start_sample, 0);
            assert_eq!(
                chunk
                    .samples
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
                reference.samples()[..chunk.samples.len()]
                    .iter()
                    .map(|value| value.to_bits())
                    .collect::<Vec<_>>(),
            );
        }
        assert!(!user.load(Ordering::Relaxed));
        assert!(!abort.load(Ordering::Relaxed));
    }

    #[test]
    fn invalid_finish_drops_all_prepared_readers() {
        let directory = tempfile::tempdir().unwrap();
        let recording = preparation_recording(directory.path());
        for name in ["mic.wav", "system.wav", "incoming.wav"] {
            write_wav(&directory.path().join(name), 17_003, 1);
        }
        let user = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        let prepared = ExportAudioPreparation::open(
            &recording,
            recording.studio_meta().unwrap(),
            user.clone(),
            abort.clone(),
        )
        .unwrap();
        assert!(Arc::strong_count(&user) > 1);
        assert!(matches!(
            prepared.finish(&[]),
            Err(ExportAudioError::InvalidWindow)
        ));
        assert_eq!(Arc::strong_count(&user), 1);
        assert_eq!(Arc::strong_count(&abort), 1);
        assert!(!user.load(Ordering::Relaxed));
        assert!(!abort.load(Ordering::Relaxed));
    }

    #[test]
    fn open_rejects_segment_mismatch_before_missing_source_io() {
        let directory = tempfile::tempdir().unwrap();
        let recording = preparation_recording(directory.path());
        let user = Arc::new(AtomicBool::new(false));
        let abort = Arc::new(AtomicBool::new(false));
        assert!(matches!(
            ExportAudioRenderer::open(
                &recording,
                recording.studio_meta().unwrap(),
                &[],
                user.clone(),
                abort.clone(),
            ),
            Err(ExportAudioError::InvalidWindow),
        ));
        assert_eq!(Arc::strong_count(&user), 1);
        assert_eq!(Arc::strong_count(&abort), 1);
        assert!(!abort.load(Ordering::Relaxed));
        assert!(!directory.path().join("mic.wav").exists());
    }

    fn segment(index: u32, start: f64, end: f64) -> TimelineSegment {
        TimelineSegment {
            recording_clip: index,
            start,
            end,
            timescale: 1.0,
            name: None,
            speed_audio_mode: None,
        }
    }

    fn project() -> ProjectConfiguration {
        ProjectConfiguration {
            timeline: Some(TimelineConfiguration {
                segments: vec![segment(0, 0.001_01, 0.33), segment(1, 0.002_01, 0.29)],
                transitions: Vec::new(),
                zoom_segments: Vec::new(),
                scene_segments: Vec::new(),
                style_segments: Vec::new(),
                image_segments: Vec::new(),
                mask_segments: Vec::new(),
                text_segments: Vec::new(),
                caption_segments: Vec::new(),
                keyboard_segments: Vec::new(),
                audio_segments: Vec::new(),
                camera3d_segments: Vec::new(),
            }),
            clips: vec![
                ClipConfiguration {
                    index: 0,
                    offsets: ClipOffsets {
                        mic: -0.003_13,
                        system_audio: 0.001_33,
                        ..Default::default()
                    },
                    ..Default::default()
                },
                ClipConfiguration {
                    index: 1,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn fixture(paths: &[PathBuf], data: &[Arc<AudioData>]) -> (AudioRenderer, ExportAudioRenderer) {
        let cancellation = Arc::new(AtomicBool::new(false));
        let full = vec![
            AudioSegment {
                tracks: vec![
                    AudioSegmentTrack::new(
                        data[0].clone(),
                        |config| config.mic_volume_db,
                        |config| match config.mic_stereo_mode {
                            cap_project::StereoMode::Stereo => StereoMode::Stereo,
                            cap_project::StereoMode::MonoL => StereoMode::MonoL,
                            cap_project::StereoMode::MonoR => StereoMode::MonoR,
                        },
                        |offset| offset.mic,
                    ),
                    AudioSegmentTrack::new(
                        data[1].clone(),
                        |config| config.system_volume_db,
                        |_| StereoMode::Stereo,
                        |offset| offset.system_audio,
                    ),
                ],
            },
            AudioSegment {
                tracks: vec![AudioSegmentTrack::new(
                    data[2].clone(),
                    |config| config.mic_volume_db,
                    |config| match config.mic_stereo_mode {
                        cap_project::StereoMode::Stereo => StereoMode::Stereo,
                        cap_project::StereoMode::MonoL => StereoMode::MonoL,
                        cap_project::StereoMode::MonoR => StereoMode::MonoR,
                    },
                    |offset| offset.mic,
                )],
            },
        ];
        let tracks = vec![
            vec![
                ExportAudioTrack::open(&paths[0], 0, true, 0.0, &cancellation, &cancellation)
                    .unwrap(),
                ExportAudioTrack::open(&paths[1], 1, false, 0.0, &cancellation, &cancellation)
                    .unwrap(),
            ],
            vec![
                ExportAudioTrack::open(&paths[2], 2, true, 0.0, &cancellation, &cancellation)
                    .unwrap(),
            ],
        ];
        (
            AudioRenderer::new(full),
            ExportAudioRenderer {
                renderer: AudioRenderer::new(Vec::new()),
                sources: ExportAudioSources {
                    tracks,
                    abort: cancellation.clone(),
                    cancellation,
                },
                failure: None,
            },
        )
    }

    #[test]
    fn unused_source_detachment_preserves_slots_identity_and_project() {
        let directory = tempfile::tempdir().unwrap();
        let paths =
            ["mic.wav", "system.wav", "incoming.wav"].map(|name| directory.path().join(name));
        for (path, channels) in paths.iter().zip([1, 2, 2]) {
            write_wav(path, 17_003, channels);
        }
        let data = paths
            .iter()
            .map(|path| Arc::new(AudioData::from_file(path).unwrap()))
            .collect::<Vec<_>>();
        for variant in 0..9 {
            let (_, mut candidate) = fixture(&paths, &data);
            candidate.sources.tracks[1].push(
                ExportAudioTrack::open(
                    &paths[2],
                    3,
                    false,
                    0.0,
                    &candidate.sources.cancellation,
                    &candidate.sources.abort,
                )
                .unwrap(),
            );
            for track in candidate.sources.tracks.iter_mut().flatten() {
                track.prepare(10, 100).unwrap();
            }
            let identity = |track: &ExportAudioTrack| {
                (
                    track.source_index,
                    track.path.clone(),
                    track.source.position(),
                    track.samples.as_ptr() as usize,
                    track.samples.len(),
                )
            };
            let before = candidate
                .sources
                .tracks
                .iter()
                .flatten()
                .map(identity)
                .collect::<Vec<_>>();
            let mut project = project();
            let expected_unused = match variant {
                0 => {
                    project.timeline = None;
                    vec![]
                }
                1 => vec![],
                2 => {
                    project.audio.mute = true;
                    for segment in &mut project.timeline.as_mut().unwrap().segments {
                        segment.speed_audio_mode = Some(ClipSpeedAudioMode::Mute);
                    }
                    vec![]
                }
                3 => {
                    project
                        .timeline
                        .as_mut()
                        .unwrap()
                        .transitions
                        .push(ClipTransition {
                            segment_index: 1,
                            kind: ClipTransitionType::CrossFade,
                            duration: 0.13,
                        });
                    vec![]
                }
                4 => {
                    project.timeline.as_mut().unwrap().segments = vec![segment(0, 0.0, 0.1)];
                    vec![2, 3]
                }
                5 => {
                    project.timeline.as_mut().unwrap().segments = vec![segment(1, 0.0, 0.1)];
                    vec![0, 1]
                }
                6 => {
                    project.timeline.as_mut().unwrap().segments = vec![segment(9, 0.0, 0.1)];
                    vec![0, 1, 2, 3]
                }
                7 => {
                    project.timeline.as_mut().unwrap().segments.clear();
                    vec![0, 1, 2, 3]
                }
                8 => {
                    project.timeline.as_mut().unwrap().segments =
                        vec![segment(0, 0.0, 0.1), segment(0, 0.2, 0.3)];
                    vec![2, 3]
                }
                _ => unreachable!(),
            };
            let project_before = format!("{project:?}");
            let detached = candidate.take_unused_sources(&project);
            let unused_indices = detached
                .iter()
                .flat_map(|validation| validation.sources.tracks.iter().flatten())
                .map(|track| track.source_index)
                .collect::<Vec<_>>();
            assert_eq!(unused_indices, expected_unused, "variant {variant}");
            assert_eq!(candidate.sources.tracks.len(), 2);
            for (clip_index, tracks) in candidate.sources.tracks.iter().enumerate() {
                for track in tracks {
                    assert_eq!(track.source_index / 2, clip_index);
                }
            }
            let mut after = candidate
                .sources
                .tracks
                .iter()
                .flatten()
                .chain(
                    detached
                        .iter()
                        .flat_map(|validation| validation.sources.tracks.iter().flatten()),
                )
                .map(identity)
                .collect::<Vec<_>>();
            after.sort_by_key(|track| track.0);
            assert_eq!(after, before, "variant {variant}");
            assert_eq!(format!("{project:?}"), project_before);
            assert!(candidate.take_unused_sources(&project).is_none());
            if let Some(detached) = detached {
                detached.validate_to_end().unwrap();
            }
            candidate.validate_to_end().unwrap();
        }
    }

    #[test]
    fn detachment_does_not_split_more_than_four_readers() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");
        write_wav(&path, 17_003, 2);
        let paths = vec![path.clone(); 3];
        let data = paths
            .iter()
            .map(|path| Arc::new(AudioData::from_file(path).unwrap()))
            .collect::<Vec<_>>();
        let (_, mut candidate) = fixture(&paths, &data);
        for index in 3..5 {
            candidate.sources.tracks[1].push(
                ExportAudioTrack::open(
                    &path,
                    index,
                    false,
                    0.0,
                    &candidate.sources.cancellation,
                    &candidate.sources.abort,
                )
                .unwrap(),
            );
        }
        let mut project = project();
        project.timeline.as_mut().unwrap().segments.truncate(1);
        assert!(candidate.take_unused_sources(&project).is_none());
        assert_eq!(candidate.sources.tracks.iter().flatten().count(), 5);
    }

    #[test]
    fn bounded_sink_matches_full_renderer_at_original_request_boundaries() {
        ffmpeg::init().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let paths =
            ["mic.wav", "system.wav", "incoming.wav"].map(|name| directory.path().join(name));
        for ((path, frames), channels) in paths.iter().zip([17_003, 9_007, 23_013]).zip([1, 2, 2]) {
            write_wav(path, frames, channels);
        }
        let data = paths
            .iter()
            .map(|path| Arc::new(AudioData::from_file(path).unwrap()))
            .collect::<Vec<_>>();
        for variant in 0..16 {
            let mut project = project();
            match variant {
                0 => project.timeline = None,
                1 => {}
                2 | 3 => project
                    .timeline
                    .as_mut()
                    .unwrap()
                    .transitions
                    .push(ClipTransition {
                        segment_index: 1,
                        kind: if variant == 2 {
                            ClipTransitionType::CrossFade
                        } else {
                            ClipTransitionType::FadeThroughBlack
                        },
                        duration: 0.131_234_567,
                    }),
                4 => {
                    project.timeline.as_mut().unwrap().segments[0].speed_audio_mode =
                        Some(ClipSpeedAudioMode::Mute)
                }
                5 => project.audio.mute = true,
                6 => project.audio.mic_stereo_mode = cap_project::StereoMode::MonoL,
                7 => project.audio.mic_stereo_mode = cap_project::StereoMode::MonoR,
                8 => project.audio.mic_volume_db = f32::NAN,
                9 => project.audio.mic_volume_db = f32::INFINITY,
                10 => project.audio.system_volume_db = f32::NEG_INFINITY,
                11 => project.clips[0].offsets.mic = 0.9,
                12 => project.clips[0].offsets.system_audio = -0.9,
                13 => project
                    .timeline
                    .as_mut()
                    .unwrap()
                    .segments
                    .push(segment(0, 0.34, 0.36)),
                14 => project.timeline.as_mut().unwrap().segments[1].recording_clip = 9,
                15 => {
                    project.audio.mic_volume_db = 4.0;
                    project.audio.system_volume_db = -29.9;
                }
                _ => unreachable!(),
            }
            for request in [1, 7, 997, 4_096, 4_800, 48_001, 96_000, 384_000] {
                let (mut reference, mut candidate) = fixture(&paths, &data);
                reference.set_playhead(0.0, &project);
                loop {
                    let expected = reference.render_frame_raw(request, &project);
                    let mut actual = Vec::new();
                    let written = candidate
                        .render_chunks(request, &project, |offset, samples| {
                            assert!(samples.len() <= EXPORT_AUDIO_BLOCK_SAMPLES * 2);
                            assert_eq!(offset * 2, actual.len());
                            actual.extend_from_slice(samples);
                            Ok(())
                        })
                        .unwrap_or_else(|error| {
                            panic!("variant {variant}, request {request}: {error}")
                        });
                    assert_eq!(
                        written,
                        expected.as_ref().map(|(count, _)| *count),
                        "variant {variant}, request {request}"
                    );
                    assert_eq!(
                        actual
                            .iter()
                            .map(|value| value.to_bits())
                            .collect::<Vec<_>>(),
                        expected
                            .as_ref()
                            .map(|(_, values)| values
                                .iter()
                                .map(|value| value.to_bits())
                                .collect::<Vec<_>>())
                            .unwrap_or_default(),
                        "variant {variant}, request {request}"
                    );
                    assert_eq!(
                        reference.elapsed_samples_to_playhead().to_bits(),
                        candidate.renderer.elapsed_samples_to_playhead().to_bits()
                    );
                    for track in candidate.sources.tracks.iter().flatten() {
                        assert!(
                            track.samples.len()
                                <= EXPORT_AUDIO_BLOCK_SAMPLES * track.source.channels() as usize
                        );
                    }
                    if expected.is_none() {
                        break;
                    }
                }
                candidate.validate_to_end().unwrap();
                assert_eq!(
                    candidate
                        .sources
                        .tracks
                        .iter()
                        .flatten()
                        .map(|track| track.source.position())
                        .collect::<Vec<_>>(),
                    data.iter()
                        .map(|data| data.sample_count() as u64)
                        .collect::<Vec<_>>()
                );
            }
        }
    }

    #[test]
    fn eligibility_rejects_unbounded_or_nonsequential_shapes() {
        let original = project();
        assert!(ExportAudioRenderer::eligible_sources(&original, 3));
        assert!(!ExportAudioRenderer::eligible_sources(&original, 0));
        assert!(!ExportAudioRenderer::eligible_sources(&original, 5));
        for offset in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, f32::MAX] {
            let mut project = original.clone();
            project.clips[0].offsets.mic = offset;
            assert!(!ExportAudioRenderer::eligible_sources(&project, 3));
        }
        for (start, end, speed) in [
            (f64::NAN, 1.0, 1.0),
            (-0.1, 1.0, 1.0),
            (0.0, f64::INFINITY, 1.0),
            (0.0, 0.0, 1.0),
            (0.0, 1.0, 2.0),
        ] {
            let mut project = original.clone();
            let segment = &mut project.timeline.as_mut().unwrap().segments[0];
            segment.start = start;
            segment.end = end;
            segment.timescale = speed;
            assert!(!ExportAudioRenderer::eligible_sources(&project, 3));
        }
        let mut project = original.clone();
        project
            .timeline
            .as_mut()
            .unwrap()
            .segments
            .push(segment(0, 0.34, 0.4));
        assert!(ExportAudioRenderer::eligible_sources(&project, 3));
        project
            .timeline
            .as_mut()
            .unwrap()
            .transitions
            .push(ClipTransition {
                segment_index: 1,
                kind: ClipTransitionType::CrossFade,
                duration: 0.01,
            });
        assert!(!ExportAudioRenderer::eligible_sources(&project, 3));
        let mut project = original;
        project
            .timeline
            .as_mut()
            .unwrap()
            .segments
            .push(segment(0, 0.01, 0.1));
        assert!(!ExportAudioRenderer::eligible_sources(&project, 3));
    }

    #[test]
    fn source_windows_reject_backward_reads_and_keep_failures_sticky() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");
        write_wav(&path, 17_003, 2);
        let cancellation = Arc::new(AtomicBool::new(false));
        let mut track =
            ExportAudioTrack::open(&path, 0, true, 0.0, &cancellation, &cancellation).unwrap();
        track.prepare(8_000, 9_000).unwrap();
        track.prepare(8_500, 9_501).unwrap();
        let full = AudioData::from_file(&path).unwrap();
        assert_eq!(track.samples, full.samples()[8_500 * 2..9_501 * 2]);
        assert!(matches!(
            track.prepare(0, 1),
            Err(ExportAudioError::InvalidWindow)
        ));
        let mut candidate = ExportAudioRenderer {
            renderer: AudioRenderer::new(Vec::new()),
            sources: ExportAudioSources {
                tracks: vec![vec![track]],
                cancellation: cancellation.clone(),
                abort: cancellation.clone(),
            },
            failure: None,
        };
        let error = candidate
            .render_chunks(1, &ProjectConfiguration::default(), |_, _| Ok(()))
            .unwrap_err()
            .to_string();
        assert_eq!(candidate.validate_to_end().unwrap_err().to_string(), error);
        cancellation.store(true, Ordering::Relaxed);
        assert_eq!(
            candidate
                .render_chunks(1, &ProjectConfiguration::default(), |_, _| Ok(()))
                .unwrap_err()
                .to_string(),
            error
        );
    }

    #[test]
    fn sink_failure_stops_before_later_source_reads() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.wav");
        write_wav(&path, 17_003, 2);
        let paths = vec![path; 3];
        let data = paths
            .iter()
            .map(|path| Arc::new(AudioData::from_file(path).unwrap()))
            .collect::<Vec<_>>();
        let (_, mut candidate) = fixture(&paths, &data);
        let error = candidate
            .render_chunks(96_000, &project(), |_, _| {
                Err(ExportAudioError::Sink("sink stopped".into()))
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "sink stopped");
        assert_eq!(candidate.sources.tracks[1][0].source.position(), 0);
        assert_eq!(
            candidate.validate_to_end().unwrap_err().to_string(),
            "sink stopped"
        );
    }
}
