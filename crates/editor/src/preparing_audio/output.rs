use super::mixer::{PreparingAudioMixer, PreparingAudioRead, PreparingAudioSources};
use crate::audio::{AudioResampler, preparing_audio_output_policy};
use cap_audio::{AudioData, FromSampleBytes};
use cap_media_info::AudioInfo;
use futures::{FutureExt, future::Shared};
use ringbuf::{
    HeapCons, HeapProd, HeapRb,
    traits::{Consumer, Observer, Producer, Split},
};
use std::{
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread::{self, Thread},
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const MIX_FRAMES: usize = 1_024;
const HISTORY_SPANS: usize = 1_024;
const MAX_RING_BYTES: usize = 64 * 1024 * 1024;
type ProducerJoin = Shared<futures::future::BoxFuture<'static, Result<(), String>>>;

#[derive(Clone, Debug)]
pub(crate) struct PreparingAudioOutputSnapshot {
    pub(crate) playhead_seconds: f64,
    pub(crate) buffering: bool,
    pub(crate) ended: bool,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Copy, Default)]
struct ConsumptionSpan {
    wall_start: u64,
    wall_end: u64,
    media_start: u64,
    media_end: u64,
}

#[derive(Default)]
struct AtomicSpan {
    version: AtomicU64,
    wall_start: AtomicU64,
    wall_end: AtomicU64,
    media_start: AtomicU64,
    media_end: AtomicU64,
}

impl AtomicSpan {
    fn store(&self, span: ConsumptionSpan) {
        self.version.fetch_add(1, Ordering::SeqCst);
        self.wall_start.store(span.wall_start, Ordering::SeqCst);
        self.wall_end.store(span.wall_end, Ordering::SeqCst);
        self.media_start.store(span.media_start, Ordering::SeqCst);
        self.media_end.store(span.media_end, Ordering::SeqCst);
        self.version.fetch_add(1, Ordering::SeqCst);
    }

    fn load(&self) -> Option<ConsumptionSpan> {
        let version = self.version.load(Ordering::SeqCst);
        if version == 0 || version % 2 != 0 {
            return None;
        }
        let span = ConsumptionSpan {
            wall_start: self.wall_start.load(Ordering::SeqCst),
            wall_end: self.wall_end.load(Ordering::SeqCst),
            media_start: self.media_start.load(Ordering::SeqCst),
            media_end: self.media_end.load(Ordering::SeqCst),
        };
        (version == self.version.load(Ordering::SeqCst)).then_some(span)
    }
}

struct OutputControl {
    cancelled: AtomicBool,
    cancellation: CancellationToken,
    removed: AtomicBool,
    removal: Notify,
    worker: OnceLock<Thread>,
    error: Mutex<Option<String>>,
    failed: AtomicBool,
    invalid_clock: AtomicBool,
    eof: AtomicBool,
    produced: AtomicU64,
    consumed: AtomicU64,
    permitted: AtomicU64,
    total_output_frames: u64,
    buffering: AtomicBool,
    retired: AtomicU64,
    reported: AtomicU64,
    spans: Box<[AtomicSpan]>,
    epoch: Instant,
    start_seconds: f64,
    total_seconds: f64,
    sample_rate: u32,
}

impl OutputControl {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.cancellation.cancel();
        self.wake();
    }

    fn wake(&self) {
        if let Some(worker) = self.worker.get() {
            worker.unpark();
        }
    }

    fn stopped(&self) -> bool {
        self.cancelled.load(Ordering::Acquire) || self.invalid_clock.load(Ordering::Acquire)
    }

    fn fail(&self, error: String) {
        self.error
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_or_insert(error);
        self.failed.store(true, Ordering::Release);
    }

    fn nanos(&self, now: Instant) -> u64 {
        u64::try_from(now.saturating_duration_since(self.epoch).as_nanos()).unwrap_or(u64::MAX)
    }
}

#[derive(Clone)]
pub(crate) struct PreparingAudioOutputHandle {
    control: Arc<OutputControl>,
    joined: ProducerJoin,
}

impl PreparingAudioOutputHandle {
    pub(crate) fn cancel(&self) {
        self.control.cancel();
    }

    pub(crate) fn set_playable_until(&self, prefix: f64) -> Result<(), String> {
        let control = &self.control;
        if !prefix.is_finite() || prefix < 0.0 || prefix > control.total_seconds {
            return Err("Preparing audio playable prefix is invalid".into());
        }
        let frames = if prefix == control.total_seconds {
            control.total_output_frames
        } else {
            ((prefix - control.start_seconds).max(0.0) * f64::from(control.sample_rate)) as u64
        };
        control.permitted.fetch_max(frames, Ordering::Release);
        Ok(())
    }

    pub(crate) fn status(&self, now: Instant) -> PreparingAudioOutputSnapshot {
        let control = &self.control;
        let now = control.nanos(now);
        let consumed = control.consumed.load(Ordering::Acquire);
        let mut audible = control.retired.load(Ordering::Acquire).min(consumed);
        for slot in &control.spans {
            if let Some(span) = slot.load()
                && now >= span.wall_start
            {
                let elapsed = now.saturating_sub(span.wall_start);
                let length = span.wall_end.saturating_sub(span.wall_start);
                let count = span.media_end.saturating_sub(span.media_start);
                let frames = if length == 0 || elapsed >= length {
                    count
                } else {
                    ((u128::from(elapsed) * u128::from(control.sample_rate)) / 1_000_000_000)
                        .min(u128::from(count)) as u64
                };
                audible = audible.max(span.media_start.saturating_add(frames).min(consumed));
            }
        }
        audible = control
            .reported
            .fetch_max(audible, Ordering::AcqRel)
            .max(audible);
        let error = if control.invalid_clock.load(Ordering::Acquire) {
            Some("Preparing audio callback timing is invalid".into())
        } else {
            control
                .error
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone()
        };
        let ended = error.is_none()
            && !control.cancelled.load(Ordering::Acquire)
            && control.eof.load(Ordering::Acquire)
            && audible == control.produced.load(Ordering::Acquire);
        PreparingAudioOutputSnapshot {
            playhead_seconds: (control.start_seconds
                + audible as f64 / f64::from(control.sample_rate))
            .min(control.total_seconds),
            buffering: !ended && control.buffering.load(Ordering::Acquire),
            ended,
            error,
        }
    }

    pub(crate) async fn stop_and_wait(&self) -> Result<(), String> {
        self.cancel();
        let joined = self.joined.clone().await;
        loop {
            let removed = self.control.removal.notified();
            tokio::pin!(removed);
            removed.as_mut().enable();
            if self.control.removed.load(Ordering::Acquire) {
                break;
            }
            removed.await;
        }
        joined
    }
}

fn spawn_producer(
    control: Arc<OutputControl>,
    runtime: tokio::runtime::Handle,
    run: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<ProducerJoin, String> {
    let worker = thread::Builder::new()
        .name("cap-preparing-audio".into())
        .spawn(move || {
            let _ = control.worker.set(thread::current());
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => control.fail(error),
                Err(_) => control.fail("Preparing audio producer panicked".into()),
            }
        })
        .map_err(|error| error.to_string())?;
    let joined = runtime.spawn_blocking(move || {
        worker
            .join()
            .map_err(|_| "Preparing audio producer join panicked".to_string())
    });
    Ok(
        async move { joined.await.map_err(|error| error.to_string())? }
            .boxed()
            .shared(),
    )
}

pub(crate) struct PreparingAudioBuffer<T: FromSampleBytes> {
    samples: Option<HeapCons<T>>,
    control: Arc<OutputControl>,
    channels: usize,
    next_slot: usize,
    previous: Option<(usize, ConsumptionSpan)>,
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> PreparingAudioBuffer<T> {
    pub(crate) fn spawn(
        sources: PreparingAudioSources,
        output_info: AudioInfo,
        start_seconds: f64,
        runtime: tokio::runtime::Handle,
    ) -> Result<(Self, PreparingAudioOutputHandle), String> {
        sources.validate()?;
        let total_seconds = sources.total_duration();
        if output_info.sample_rate == 0
            || !(1..=8).contains(&output_info.channels)
            || cap_media_info::ffmpeg_sample_format_for(T::FORMAT)
                != Some(output_info.sample_format)
        {
            return Err("Preparing audio output format is invalid".into());
        }
        let capacity = (output_info.sample_rate as usize)
            .checked_mul(output_info.channels)
            .and_then(|samples| samples.checked_mul(2))
            .filter(|samples| {
                samples
                    .checked_mul(T::BYTE_SIZE)
                    .is_some_and(|bytes| bytes <= MAX_RING_BYTES)
            })
            .ok_or_else(|| "Preparing audio output queue exceeds its bound".to_string())?;
        let policy = preparing_audio_output_policy(total_seconds, output_info, start_seconds)?;
        let ring = Arc::new(HeapRb::<T>::new(capacity));
        let (producer, samples) = ring.clone().split();
        let control = Arc::new(OutputControl {
            cancelled: AtomicBool::new(false),
            cancellation: CancellationToken::new(),
            removed: AtomicBool::new(false),
            removal: Notify::new(),
            worker: OnceLock::new(),
            error: Mutex::new(None),
            failed: AtomicBool::new(false),
            invalid_clock: AtomicBool::new(false),
            eof: AtomicBool::new(false),
            produced: AtomicU64::new(0),
            consumed: AtomicU64::new(0),
            permitted: AtomicU64::new(0),
            total_output_frames: ((total_seconds * f64::from(output_info.sample_rate)) as u64)
                .saturating_sub((start_seconds * f64::from(output_info.sample_rate)) as u64),
            buffering: AtomicBool::new(true),
            retired: AtomicU64::new(0),
            reported: AtomicU64::new(0),
            spans: (0..HISTORY_SPANS).map(|_| AtomicSpan::default()).collect(),
            epoch: Instant::now(),
            start_seconds,
            total_seconds,
            sample_rate: output_info.sample_rate,
        });
        let worker_control = control.clone();
        let producer_runtime = runtime.clone();
        let joined = spawn_producer(control.clone(), runtime, move || {
            let mixer = PreparingAudioMixer::new(sources, policy.render_start_seconds)?;
            let resampler =
                AudioResampler::new(policy.render_info).map_err(|error| error.to_string())?;
            let result = OutputProducer {
                samples: producer,
                control: worker_control,
                runtime: producer_runtime,
                mixer,
                resampler,
                input_frame: (policy.render_start_seconds * f64::from(AudioData::SAMPLE_RATE))
                    .round() as usize,
                skip_frames: policy.skip_output_frames,
                convert_from_f32: policy.convert_from_f32,
                channels: output_info.channels,
                scratch_bytes: (capacity / 2).saturating_mul(8).min(8 * 1024 * 1024),
                emitted: 0,
                limit: ((total_seconds * f64::from(output_info.sample_rate)) as u64)
                    .saturating_sub((start_seconds * f64::from(output_info.sample_rate)) as u64),
            }
            .run();
            drop(ring);
            result
        })?;
        Ok((
            Self {
                samples: Some(samples),
                control: control.clone(),
                channels: output_info.channels,
                next_slot: 0,
                previous: None,
            },
            PreparingAudioOutputHandle { control, joined },
        ))
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.control.stopped()
            || self.control.failed.load(Ordering::Acquire)
            || (self.control.eof.load(Ordering::Acquire)
                && self
                    .samples
                    .as_ref()
                    .is_none_or(|samples| samples.occupied_len() == 0))
    }

    pub(crate) fn fill(&mut self, output: &mut [T], latency_secs: f64) -> usize {
        self.fill_at(output, latency_secs, Instant::now())
    }

    fn fill_at(&mut self, output: &mut [T], latency_secs: f64, now: Instant) -> usize {
        output.fill(T::EQUILIBRIUM);
        if self.control.stopped() || self.control.failed.load(Ordering::Acquire) {
            return 0;
        }
        let Some(samples) = self.samples.as_mut() else {
            return 0;
        };
        let consumed = self.control.consumed.load(Ordering::Relaxed);
        let permitted = self
            .control
            .permitted
            .load(Ordering::Acquire)
            .saturating_sub(consumed);
        let frames = (samples.occupied_len() / self.channels)
            .min(output.len() / self.channels)
            .min(usize::try_from(permitted).unwrap_or(usize::MAX));
        if frames == 0 {
            self.control.buffering.store(
                !self.control.eof.load(Ordering::Acquire) || samples.occupied_len() != 0,
                Ordering::Release,
            );
            return 0;
        }
        let now = self.control.nanos(now);
        let latency = Duration::try_from_secs_f64(latency_secs)
            .ok()
            .and_then(|value| u64::try_from(value.as_nanos()).ok());
        let Some(wall_start) = latency.and_then(|latency| now.checked_add(latency)) else {
            self.control.invalid_clock.store(true, Ordering::Release);
            self.control.wake();
            return 0;
        };
        let wall_start = wall_start.max(self.previous.map_or(0, |(_, span)| span.wall_end));
        let duration =
            (frames as u128 * 1_000_000_000).div_ceil(u128::from(self.control.sample_rate)) as u64;
        let Some(wall_end) = wall_start.checked_add(duration) else {
            self.control.invalid_clock.store(true, Ordering::Release);
            self.control.wake();
            return 0;
        };
        let start = self.control.consumed.load(Ordering::Relaxed);
        let span = ConsumptionSpan {
            wall_start,
            wall_end,
            media_start: start,
            media_end: start + frames as u64,
        };
        let merge = self
            .previous
            .filter(|(_, previous)| previous.wall_end == wall_start);
        let slot = merge.map_or(self.next_slot, |(index, _)| index);
        if merge.is_none() {
            if let Some(previous) = self.control.spans[slot].load() {
                if previous.wall_end > now {
                    self.control.buffering.store(true, Ordering::Release);
                    return 0;
                }
                self.control
                    .retired
                    .fetch_max(previous.media_end, Ordering::Release);
            }
            self.next_slot = (self.next_slot + 1) % HISTORY_SPANS;
        }
        let copied = samples.pop_slice(&mut output[..frames * self.channels]);
        assert_eq!(copied, frames * self.channels);
        let span = merge.map_or(span, |(_, previous)| ConsumptionSpan {
            wall_start: previous.wall_start,
            media_start: previous.media_start,
            ..span
        });
        self.control.spans[slot].store(span);
        self.previous = Some((slot, span));
        self.control
            .consumed
            .store(start + frames as u64, Ordering::Release);
        self.control.buffering.store(
            frames < output.len() / self.channels
                && (!self.control.eof.load(Ordering::Acquire) || samples.occupied_len() != 0),
            Ordering::Release,
        );
        self.control.wake();
        frames
    }
}

impl<T: FromSampleBytes> Drop for PreparingAudioBuffer<T> {
    fn drop(&mut self) {
        drop(self.samples.take());
        self.control.cancel();
        self.control.removed.store(true, Ordering::Release);
        self.control.removal.notify_waiters();
    }
}

struct OutputProducer<T: FromSampleBytes> {
    samples: HeapProd<T>,
    control: Arc<OutputControl>,
    runtime: tokio::runtime::Handle,
    mixer: PreparingAudioMixer,
    resampler: AudioResampler,
    input_frame: usize,
    skip_frames: usize,
    convert_from_f32: bool,
    channels: usize,
    scratch_bytes: usize,
    emitted: u64,
    limit: u64,
}

impl<T: FromSampleBytes + cpal::FromSample<f32>> OutputProducer<T> {
    fn run(mut self) -> Result<(), String> {
        loop {
            if self.control.stopped() {
                return Ok(());
            }
            match self.mixer.next(MIX_FRAMES)? {
                PreparingAudioRead::Samples {
                    start_frame,
                    frames,
                    samples,
                } => {
                    if start_frame != self.input_frame
                        || frames == 0
                        || frames > MIX_FRAMES
                        || samples.len() != frames * 2
                    {
                        return Err("Preparing audio mixer returned invalid frames".into());
                    }
                    self.input_frame = self
                        .input_frame
                        .checked_add(frames)
                        .ok_or("Preparing audio mixer frame index overflow")?;
                    let info =
                        AudioInfo::new_raw(AudioData::SAMPLE_FORMAT, AudioData::SAMPLE_RATE, 2);
                    let frame =
                        info.wrap_frame(unsafe { cap_audio::cast_f32_slice_to_bytes(&samples) });
                    let bytes = self.resampler.queue_and_process_frame(&frame);
                    if bytes.len() > self.scratch_bytes {
                        return Err("Preparing audio resampler exceeded its scratch bound".into());
                    }
                    let bytes = bytes.to_vec();
                    self.enqueue(&bytes)?;
                }
                PreparingAudioRead::Pending { loader, range } => {
                    let control = &self.control;
                    self.runtime.block_on(async {
                        match loader {
                            Some(loader) => tokio::select! {
                                biased;
                                _ = control.cancellation.cancelled() => Ok(()),
                                result = loader.window(range) => result.map(|_| ()),
                            },
                            None => {
                                control.cancellation.cancelled().await;
                                Ok(())
                            }
                        }
                    })?;
                }
                PreparingAudioRead::Eof => {
                    while let Some(bytes) = self.resampler.flush_frame() {
                        if bytes.len() > self.scratch_bytes {
                            return Err(
                                "Preparing audio resampler exceeded its scratch bound".into()
                            );
                        }
                        let bytes = bytes.to_vec();
                        if bytes.is_empty() {
                            break;
                        }
                        self.enqueue(&bytes)?;
                        if self.control.stopped() {
                            return Ok(());
                        }
                    }
                    self.control.eof.store(true, Ordering::Release);
                    return Ok(());
                }
            }
        }
    }

    fn enqueue(&mut self, bytes: &[u8]) -> Result<(), String> {
        let width = if self.convert_from_f32 {
            f32::BYTE_SIZE
        } else {
            T::BYTE_SIZE
        };
        if bytes.len() % (width * self.channels) != 0 {
            return Err("Preparing audio resampler returned partial frames".into());
        }
        let frames = bytes.len() / (width * self.channels);
        let skip = self.skip_frames.min(frames);
        self.skip_frames -= skip;
        let frames = (frames - skip).min(self.limit.saturating_sub(self.emitted) as usize);
        let mut converted = Vec::with_capacity(frames * self.channels);
        for chunk in bytes[skip * width * self.channels..][..frames * width * self.channels]
            .chunks_exact(width)
        {
            converted.push(if self.convert_from_f32 {
                T::from_sample(f32::from_bytes(chunk))
            } else {
                T::from_bytes(chunk)
            });
        }
        let mut offset = 0;
        while offset < converted.len() {
            if self.control.stopped() {
                return Ok(());
            }
            let available = self.samples.vacant_len() / self.channels * self.channels;
            if available == 0 {
                thread::park_timeout(Duration::from_millis(20));
                continue;
            }
            let end = converted.len().min(offset + available);
            let written = self.samples.push_slice(&converted[offset..end]);
            if written != end - offset {
                return Err("Preparing audio queue publication failed".into());
            }
            offset = end;
            self.emitted += (written / self.channels) as u64;
            self.control.produced.store(self.emitted, Ordering::Release);
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;
